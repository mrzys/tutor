//! Narrow, in-memory compatibility for a terminal empty classic xref section.
//! Original upload bytes, object offsets, streams and the latest trailer stay intact.
use super::*;

pub(super) fn inspect(bytes: &[u8]) -> AppResult<(lopdf::Document, Option<Value>)> {
    if let Ok(document) = lopdf::Document::load_mem(bytes) {
        return Ok((document, None));
    }
    let invalid = || err("invalid_pdf", "原 PDF 无法完整读取，原文件已保留；请检查文件或重新导出 PDF。");
    if !bytes.starts_with(b"%PDF-") || bytes.len() > MAX_BYTES {
        return Err(invalid());
    }
    let suffix = bytes.len().saturating_sub(65_536);
    let ending = regex::bytes::Regex::new(r"startxref[\x00\t\n\x0C\r ]+([0-9]{1,20})[\x00\t\n\x0C\r ]+%%EOF[\x00\t\n\x0C\r ]*\z").unwrap();
    let captures = ending.captures(&bytes[suffix..]).ok_or_else(invalid)?;
    let offset: usize = std::str::from_utf8(&captures[1]).ok().and_then(|v| v.parse().ok()).ok_or_else(invalid)?;
    let tail = bytes.get(offset..).ok_or_else(invalid)?;
    // Only an empty section at the exact final startxref target is eligible.
    // Do not scan backwards for an older root or truncate a failed update.
    let empty = regex::bytes::Regex::new(r"\Axref([\x00\t\n\x0C\r ]+)trailer[\x00\t\n\x0C\r ]*<<").unwrap();
    let prefix = empty.captures(tail).ok_or_else(invalid)?;
    let insert_at = offset + 4 + prefix[1].len();
    let previous = regex::bytes::Regex::new(r"/Prev[\x00\t\n\x0C\r ]+([0-9]{1,20})(?:[\x00\t\n\x0C\r />])").unwrap();
    let prev = previous.captures(tail).ok_or_else(invalid)?;
    let prev_offset: usize = std::str::from_utf8(&prev[1]).ok().and_then(|v| v.parse().ok()).ok_or_else(invalid)?;
    if prev_offset >= offset || !bytes.get(prev_offset..).is_some_and(|v| v.starts_with(b"xref")) {
        return Err(invalid());
    }
    // A zero-entry subsection expresses the same absence of object updates.
    // Insertion follows all objects; original object and xref offsets stay valid.
    let mut inspection = Vec::with_capacity(bytes.len() + 4);
    inspection.extend_from_slice(&bytes[..insert_at]);
    inspection.extend_from_slice(b"0 0\n");
    inspection.extend_from_slice(&bytes[insert_at..]);
    let document = lopdf::Document::load_mem(&inspection).map_err(|_| invalid())?;
    let audit = json!({"version":1,"method":"terminal_empty_xref_zero_subsection","sourceSha256":sha(bytes),"inspectionSha256":sha(&inspection),"finalXrefOffset":offset,"previousXrefOffset":prev_offset,"insertionOffset":insert_at,"insertedAscii":"0 0\n","originalUploadBytesPreserved":true});
    Ok((document, Some(audit)))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pdf() -> Vec<u8> {
        let mut doc = lopdf::Document::with_version("1.7");
        doc.reference_table.cross_reference_type = lopdf::xref::XrefType::CrossReferenceTable;
        let pages = doc.new_object_id();
        let content = doc.add_object(lopdf::Stream::new(lopdf::dictionary! {}, b"q Q".to_vec()));
        let page = doc.add_object(lopdf::dictionary! {"Type"=>"Page","Parent"=>pages,"MediaBox"=>vec![0.into(),0.into(),100.into(),100.into()],"Contents"=>content});
        doc.objects.insert(pages, lopdf::dictionary! {"Type"=>"Pages","Count"=>1,"Kids"=>vec![page.into()]}.into());
        let root=doc.add_object(lopdf::dictionary! {"Type"=>"Catalog","Pages"=>pages});
        doc.trailer.set("Root", root);
        let mut bytes=Vec::new();doc.save_to(&mut bytes).unwrap();bytes
    }
    fn empty_update(base: &[u8], trailer_extra: &str) -> Vec<u8> {
        let old = lopdf::Document::load_mem(base).unwrap();
        let root=old.trailer.get(b"Root").unwrap().as_reference().unwrap();
        let re=regex::bytes::Regex::new(r"startxref\s+(\d+)\s+%%EOF\s*\z").unwrap();
        let c=re.captures(base).unwrap();let previous=std::str::from_utf8(&c[1]).unwrap();
        let mut bytes=base.to_vec();bytes.push(b'\n');let offset=bytes.len();
        bytes.extend_from_slice(format!("xref\ntrailer\n<</Root {} {} R /Size {} /Prev {previous} {trailer_extra}>>\nstartxref\n{offset}\n%%EOF\n",root.0,root.1,old.max_id+1).as_bytes());bytes
    }
    #[test]
    fn terminal_empty_xref_preserves_every_object_and_latest_trailer() {
        let base=pdf();let bytes=empty_update(&base,"/CompatibilityProbe (latest trailer)");
        assert!(lopdf::Document::load_mem(&bytes).is_err());
        let original=bytes.clone();let (parsed,audit)=inspect(&bytes).unwrap();
        let normal=lopdf::Document::load_mem(&base).unwrap();
        assert_eq!(parsed.objects,normal.objects);assert_eq!(parsed.get_pages(),normal.get_pages());
        assert_eq!(parsed.trailer.get(b"CompatibilityProbe").unwrap().as_str().unwrap(),b"latest trailer");
        assert_eq!(bytes,original);assert_eq!(audit.unwrap()["sourceSha256"],sha(&original));
    }
    #[test]
    fn ordinary_pdf_is_not_rewritten_and_malformed_updates_stay_blocked() {
        let base=pdf();assert!(inspect(&base).unwrap().1.is_none());
        for replacement in ["badxref", "xref\n2 1\ninvalid entry\ntrailer", "xref\ntrailerBroken"] {
            let b=empty_update(&base,"");let target=b.windows(12).rposition(|v|v==b"xref\ntrailer").unwrap();
            let mut broken=b[..target].to_vec();broken.extend_from_slice(replacement.as_bytes());broken.extend_from_slice(&b[target+12..]);
            assert!(inspect(&broken).is_err());
        }
        let b=empty_update(&base,"");let changed=String::from_utf8_lossy(&b).replace("/Prev ","/Invalid ");
        assert!(inspect(changed.as_bytes()).is_err());
        assert!(inspect(b"%PDF-1.7\nxref\ntrailer\n<</Prev 0>>\nstartxref\n9\n%%EOF").is_err());
    }
    #[test]
    #[ignore = "explicit local source PDF; no fixture or user material bundled"]
    fn real_pdf_empty_xref_preflight_keeps_original_bytes() {
        let path=std::env::var_os("TUTOR_PDF_INSPECTION_FIXTURE").expect("explicit PDF path");
        let bytes=std::fs::read(path).unwrap();let before=sha(&bytes);
        let (doc,audit)=inspect(&bytes).unwrap();
        assert_eq!(doc.get_pages().len(),4);assert!(!doc.is_encrypted());
        assert_eq!(sha(&bytes),before);assert_eq!(audit.unwrap()["sourceSha256"],before);
    }
}
