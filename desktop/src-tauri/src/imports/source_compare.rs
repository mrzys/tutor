//! Read-only source comparison. Full-page OCR images are never question crops.
use super::*;

pub(super) fn read(store: &Store, payload: &Value) -> AppResult<Value> {
    let record = store.document("imports", s(payload, "importId"))?;
    // Checks the original, OCR manifest and every referenced asset before exposing
    // any material. Opening this view never performs OCR or a model request.
    let original = read_source(store, &record)?;
    let source_path = store
        .data_dir
        .join(s(&record["source"], "relativePath"))
        .canonicalize()?;
    let import_root = source_path
        .parent()
        .ok_or_else(|| err("invalid_source", "原卷目录无效。"))?;
    if record["ocrSource"].is_object() {
        let manifest_path = store
            .data_dir
            .join(s(&record["ocrSource"], "manifestRelativePath"))
            .canonicalize()?;
        if !manifest_path.starts_with(import_root) {
            return Err(err("source_changed", "识别原文不属于当前导入记录。"));
        }
    }
    let page = payload["page"]
        .as_u64()
        .filter(|p| *p > 0)
        .ok_or_else(|| err("invalid_page", "请选择有效的原卷页码。"))?;
    let pages = rows(&record["ocrSource"]["pages"]);
    let extracted = rows(&record["extractedPages"]);
    let mut page_count = pages
        .iter()
        .filter_map(|p| p["page"].as_u64())
        .max()
        .unwrap_or(extracted.len() as u64);
    if page_count == 0 {
        let pdf = if record["source"]["extension"] == "pdf" {
            Some(original)
        } else if record["renderedPdf"].is_object() {
            Some(paddle::read_rendered_pdf(store, &record)?)
        } else {
            None
        };
        if let Some(bytes) = pdf {
            page_count = lopdf::Document::load_mem(&bytes)
                .map(|pdf| pdf.get_pages().len() as u64)
                .map_err(|_| err("invalid_source", "已保存的原卷 PDF 无法读取页码。"))?;
        }
    }
    if page > page_count || page_count == 0 {
        return Err(err("invalid_page", "此页不在已保存的原卷范围内。"));
    }
    let text = pages
        .iter()
        .find(|p| p["page"].as_u64() == Some(page))
        .and_then(|p| p["text"].as_str())
        .or_else(|| extracted.get(page as usize - 1).and_then(Value::as_str))
        .unwrap_or("");
    let assets = rows(&record["ocrSource"]["assets"]);
    let images: Vec<_> = assets
        .iter()
        .filter(|a| a["role"] == "source_page" && a["page"].as_u64() == Some(page))
        .collect();
    if images.len() > 1 {
        return Err(err(
            "source_changed",
            "原页图像身份不唯一，未选择任意副本。",
        ));
    }
    let image = if let Some(asset) = images.first() {
        let path = store
            .data_dir
            .join(s(asset, "relativePath"))
            .canonicalize()?;
        if !path.starts_with(import_root) || !path.is_file() {
            return Err(err("source_changed", "原页图像不属于当前导入记录。"));
        }
        let bytes = std::fs::read(path)?;
        if bytes.is_empty()
            || bytes.len() > 20 * 1024 * 1024
            || sha(&bytes) != s(asset, "sha256")
            || !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        {
            return Err(err(
                "source_changed",
                "原页图像校验失败，请保留原件重新导入。",
            ));
        }
        json!({"mimeType":"image/png","dataBase64":base64::engine::general_purpose::STANDARD.encode(&bytes),"sha256":sha(&bytes)})
    } else {
        Value::Null
    };
    Ok(
        json!({"importId":record["importId"],"page":page,"pageCount":page_count,"text":text,"image":image,
        "hasPdf":record["source"]["extension"]=="pdf" || record["renderedPdf"].is_object(),
        "sourceKind":if image.is_null(){"original_pdf"}else{"paddle_original_page"}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, Store, Value) {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path(), &crate::bank::tests::seed()).unwrap();
        let source = save_source(
            &store,
            "simulated-source-compare",
            "pdf",
            b"%PDF-simulated-read-only",
        )
        .unwrap();
        let mut record = json!({"importId":"simulated-source-compare","source":source,"extractedPages":["模拟原文 $x^2$"],"questions":[]});
        let png = b"\x89PNG\r\n\x1a\nsimulated-hash-protected-page";
        let image = json!({"id":"p1-source","role":"source_page","page":1,"mimeType":"image/png","sha256":sha(png),"contentBase64":base64::engine::general_purpose::STANDARD.encode(png)});
        let audit_dir = store
            .data_dir
            .join("imports/simulated-source-compare/attempts/attempt-1");
        std::fs::create_dir_all(&audit_dir).unwrap();
        let audit_dir = audit_dir.canonicalize().unwrap();
        paddle::save_document(
            &store,
            &mut record,
            &crate::ocr::OcrDocument {
                pages: vec![json!({"page":1,"text":"模拟识别原文 $x^2$"})],
                assets: vec![image],
                issues: vec![],
            },
            &audit_dir,
            json!({"provider":"simulated"}),
        )
        .unwrap();
        save_cas(&store, None, &record).unwrap();
        (directory, store, record)
    }

    #[test]
    fn source_page_read_keeps_full_page_and_text_without_writes() {
        let (_dir, store, before) = fixture();
        let value = read(&store, &json!({"importId":before["importId"],"page":1})).unwrap();
        assert_eq!(value["sourceKind"], "paddle_original_page");
        assert_eq!(value["text"], "模拟识别原文 $x^2$");
        assert_eq!(value["image"]["mimeType"], "image/png");
        assert_eq!(
            store.document("imports", s(&before, "importId")).unwrap(),
            before
        );
        assert!(read(&store, &json!({"importId":before["importId"],"page":2})).is_err());
    }

    #[test]
    fn changed_page_bytes_are_rejected() {
        let (_dir, store, record) = fixture();
        let path = store
            .data_dir
            .join(s(&record["ocrSource"]["assets"][0], "relativePath"));
        std::fs::write(path, b"tampered").unwrap();
        let failure = read(&store, &json!({"importId":record["importId"],"page":1})).unwrap_err();
        assert_eq!(failure.code, "source_changed");
    }

    #[test]
    fn original_source_change_is_not_hidden_by_valid_page_image() {
        let (_dir, store, record) = fixture();
        std::fs::write(
            store.data_dir.join(s(&record["source"], "relativePath")),
            b"changed original",
        )
        .unwrap();
        assert_eq!(
            read(&store, &json!({"importId":record["importId"],"page":1}))
                .unwrap_err()
                .code,
            "source_changed"
        );
    }

    #[test]
    fn another_import_page_is_rejected_even_with_matching_hash() {
        let (_dir, store, before) = fixture();
        let mut record = before.clone();
        let original = store
            .data_dir
            .join(s(&record["ocrSource"]["assets"][0], "relativePath"));
        let foreign = store
            .data_dir
            .join("imports/another-simulated-import/page.png");
        std::fs::create_dir_all(foreign.parent().unwrap()).unwrap();
        std::fs::copy(original, &foreign).unwrap();
        record["ocrSource"]["assets"][0]["relativePath"] =
            json!("imports/another-simulated-import/page.png");
        let manifest_path = store
            .data_dir
            .join(s(&record["ocrSource"], "manifestRelativePath"));
        let mut manifest: Value =
            serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        manifest["assets"] = record["ocrSource"]["assets"].clone();
        let bytes = serde_json::to_vec(&manifest).unwrap();
        std::fs::write(manifest_path, &bytes).unwrap();
        record["ocrSource"]["manifestSha256"] = json!(sha(&bytes));
        save_cas(&store, Some(&before), &record).unwrap();
        assert_eq!(
            read(&store, &json!({"importId":record["importId"],"page":1}))
                .unwrap_err()
                .message,
            "原页图像不属于当前导入记录。"
        );
    }
}
