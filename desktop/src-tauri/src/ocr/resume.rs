//! Explicit continuation of an accepted OCR job. No upload/POST fallback.
//! Cached pixels are checked before reuse; signed URLs are refreshed by GET.
use super::*;
use std::path::PathBuf;

pub(super) struct CachedImage { pub path: PathBuf, hash: String, bytes: usize }
impl CachedImage {
    pub fn load(&self) -> AppResult<DynamicImage> {
        let data = checked_bytes(&self.path, MAX_IMAGE)?;
        if data.len() != self.bytes || sha(&data) != self.hash {
            return Err(error("ocr_resume_image_changed", "已保存图片的哈希不一致，未复用或覆盖，请核对原材料。"));
        }
        let mut reader=ImageReader::new(Cursor::new(&data)).with_guessed_format().map_err(|_|error("ocr_invalid_image","已保存识别图片格式无效。"))?;
        let mut limits=image::Limits::default();limits.max_image_width=Some(12000);limits.max_image_height=Some(12000);limits.max_alloc=Some(160*1024*1024);reader.limits(limits);
        reader.decode().map_err(|_| error("ocr_invalid_image", "已保存识别图片无法解码。"))
    }
}
fn changed() -> AppError { error("ocr_resume_evidence_changed", "旧识别任务或材料与恢复依据不一致，未重新上传。") }
fn digest(value:&str)->bool {value.len()==64&&value.bytes().all(|b|b.is_ascii_hexdigit())}
fn checked_bytes(path: &Path, cap: usize) -> AppResult<Vec<u8>> {
    let m = std::fs::symlink_metadata(path)?;
    if !m.is_file() || m.file_type().is_symlink() || m.len() > cap as u64 { return Err(changed()); }
    Ok(std::fs::read(path)?)
}
fn write_new(path: &Path, value: &Value) -> AppResult<()> {
    let mut f=std::fs::OpenOptions::new().create_new(true).write(true).open(path)?;
    f.write_all(&serde_json::to_vec_pretty(value)?)?; f.sync_all()?; Ok(())
}
fn binding(settings: &OcrSettings, bytes: &[u8], filename: &str) -> Value {
    json!({"schemaVersion":1,"kind":"ocr_source_binding","sourceSha256":sha(bytes),
        "filename":filename,"endpoint":settings.endpoint(),"model":settings.model()})
}
pub(super) fn save_binding(settings: &OcrSettings, bytes: &[u8], filename: &str, dir: &Path) -> AppResult<()> {
    write_new(&dir.join("ocr-binding.json"), &binding(settings, bytes, filename))
}
fn valid_job(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned).or_else(||value.as_u64().map(|n|n.to_string()))
        .filter(|id|!id.is_empty()&&id.len()<=150&&id.bytes().all(|b|b.is_ascii_alphanumeric()||matches!(b,b'-'|b'_')))
}
pub(super) fn save_job(run: &Run<'_>, id: &str) -> AppResult<()> {
    if valid_job(&json!(id)).is_none(){return Err(error("ocr_invalid_job","识别任务编号无效，原记录保留。"));}
    let source:Value=serde_json::from_slice(&checked_bytes(&run.audit.join("ocr-binding.json"),65536)?)?;
    write_new(&run.audit.join("accepted-job.json"),&json!({"schemaVersion":1,"kind":"accepted_ocr_job",
        "jobId":id,"sourceBindingSha256":sha(&serde_json::to_vec(&source)?),"endpoint":run.endpoint.as_str()}))
}
fn accepted_job(dir: &Path) -> AppResult<Option<String>> {
    if dir.join("accepted-job.json").is_file() {
        let v:Value=serde_json::from_slice(&checked_bytes(&dir.join("accepted-job.json"),65536)?)?;
        let b:Value=serde_json::from_slice(&checked_bytes(&dir.join("ocr-binding.json"),65536)?)?;
        if v["kind"]!="accepted_ocr_job" || v["sourceBindingSha256"]!=sha(&serde_json::to_vec(&b)?) || v["endpoint"]!=b["endpoint"] {return Err(changed());}
        return valid_job(&v["jobId"]).map(Some).ok_or_else(changed);
    }
    if !dir.join("001-submit.json").is_file(){return Ok(None);}
    let v:Value=serde_json::from_slice(&checked_bytes(&dir.join("001-submit.json"),MAX_JSON)?)?;
    if v["httpStatus"]!=200 || v["response"]["code"]!=0 {return Ok(None);}
    valid_job(&v["response"]["data"]["jobId"]).map(Some).ok_or_else(changed)
}
/// Pure local check. An accepted job with invalid evidence is an error, never a
/// reason to submit the same document again.
pub(crate) fn has_accepted_job(dir: &Path) -> AppResult<bool> { Ok(accepted_job(dir)?.is_some()) }

fn inventory(dir: &Path) -> AppResult<Vec<Value>> {
    let root=std::fs::canonicalize(dir)?;let mut files=vec![];
    for entry in std::fs::read_dir(dir)? {
        let entry=entry?;let path=entry.path();
        if std::fs::canonicalize(&path)?.parent()!=Some(root.as_path()){return Err(changed());}
        let bytes=checked_bytes(&path,MAX_JSON.max(MAX_IMAGE))?;
        files.push(json!({"name":entry.file_name().to_string_lossy(),"sha256":sha(&bytes),"bytes":bytes.len()}));
    }
    files.sort_by(|a,b|s(a,"name").cmp(s(b,"name")));Ok(files)
}
fn expected_inventory(v:&Value)->AppResult<Vec<Value>> {
    let mut files=v.as_array().filter(|x|x.len()<=1000).ok_or_else(changed)?.clone();let mut names=HashSet::new();
    for f in &files {let name=s(f,"name");if name.is_empty()||name.contains(['/', '\\'])||!names.insert(name.to_owned())||!digest(s(f,"sha256"))||f["bytes"].as_u64().is_none(){return Err(changed());}}
    files.sort_by(|a,b|s(a,"name").cmp(s(b,"name")));Ok(files)
}
fn authorize(settings:&OcrSettings,bytes:&[u8],filename:&str,old:&Path,legacy:Option<&Value>)->AppResult<(String,Vec<Value>)> {
    let job=accepted_job(old)?.ok_or_else(||error("ocr_resume_missing_job","旧识别记录没有已受理任务，未重新上传。"))?;
    let files=inventory(old)?;
    if old.join("ocr-binding.json").is_file() {
        let old_binding:Value=serde_json::from_slice(&checked_bytes(&old.join("ocr-binding.json"),65536)?)?;
        if old_binding!=binding(settings,bytes,filename){return Err(changed());}
    } else {
        let auth=legacy.ok_or_else(||error("ocr_resume_confirmation_required","旧识别任务缺少原件绑定，请先核对原件和识别记录再恢复；未重新上传。"))?;
        if auth["sourceSha256"]!=sha(bytes)
            || auth["submitSha256"]!=sha(&checked_bytes(&old.join("001-submit.json"),MAX_JSON)?)
            || std::fs::canonicalize(s(auth,"oldAuditPath"))?!=std::fs::canonicalize(old)?
            || expected_inventory(&auth["files"])?!=files {return Err(changed());}
    }
    Ok((job,files))
}
pub(super) fn resource_key(url:&Url)->String {
    let mut u=url.clone();let retained=url.query_pairs().filter(|(key,_)| {
        let k=key.to_ascii_lowercase();
        !matches!(k.as_str(),"authorization"|"signature"|"token"|"access_token"|"expires"|"security-token"|"redacted")
            && !k.starts_with("x-amz-") && !k.starts_with("x-bce-")
    }).map(|(k,v)|(k.into_owned(),v.into_owned())).collect::<Vec<_>>();
    u.set_query(None);u.set_fragment(None);if !retained.is_empty(){u.query_pairs_mut().extend_pairs(retained);}
    sha(u.as_str().as_bytes())
}
pub(super) fn save_image_receipt(dir:&Path,key:&str,image:&DynamicImage,reused:Option<&Path>)->AppResult<()> {
    let mut data=Cursor::new(Vec::new());image.write_to(&mut data,ImageFormat::Png).map_err(|_|error("ocr_invalid_image","无法保存识别下载图片。"))?;
    let data=data.into_inner();if data.len()>MAX_IMAGE{return Err(error("ocr_asset_limit","识别图片超过安全上限。"));}
    let name=format!("download-{key}.png");let path=dir.join(&name);
    let receipt=dir.join(format!("download-{key}.json"));
    if path.exists()||receipt.exists(){
        let saved:Value=serde_json::from_slice(&checked_bytes(&receipt,65536)?)?;
        if saved["sha256"]!=sha(&data)||sha(&checked_bytes(&path,MAX_IMAGE)?)!=sha(&data){return Err(changed());}
        return Ok(());
    }
    let mut f=std::fs::OpenOptions::new().write(true).create_new(true).open(&path)?;f.write_all(&data)?;f.sync_all()?;
    write_new(&receipt,&json!({"schemaVersion":1,"kind":"ocr_downloaded_image","resourceSha256":key,
        "name":name,"sha256":sha(&data),"bytes":data.len(),"reusedSavedImage":reused.is_some()}))
}
fn last_result(dir:&Path)->AppResult<Option<Value>> {
    let mut paths=std::fs::read_dir(dir)?.map(|e|e.map(|x|x.path())).collect::<Result<Vec<_>,_>>()?;
    paths.sort();
    for p in paths.iter().rev().filter(|p|p.file_name().and_then(|s|s.to_str()).is_some_and(|s|s.ends_with("-result.json"))) {
        let v:Value=serde_json::from_slice(&checked_bytes(p,MAX_JSON)?)?;
        if v["httpStatus"]==200 {return Ok(Some(v["response"].clone()));}
    }
    Ok(None)
}
fn result_rows(value:&Value)->AppResult<Vec<Value>> {
    if let Some(raw)=value["rawText"].as_str(){return decode_result(raw.as_bytes());}
    if let Some(rows)=value.as_array(){return Ok(rows.clone());}
    Ok(vec![value.clone()])
}
fn decode_result(bytes:&[u8])->AppResult<Vec<Value>> {
    let text=std::str::from_utf8(bytes).map_err(|_|error("ocr_invalid_response","识别结果编码无效。"))?;
    if let Ok(v)=serde_json::from_str::<Value>(text){return result_rows(&v);}
    text.lines().filter(|l|!l.trim().is_empty()).map(|l|serde_json::from_str(l).map_err(|_|error("ocr_invalid_jsonl","识别恢复结果不完整。"))).collect()
}
fn result_identity(value:&Value)->AppResult<Value> {
    // Signed download addresses may change. Retain the complete layout/text and
    // the stable URL origin/path, rather than treating redacted signatures as URLs.
    let mut v=json!(result_rows(value)?);redact(&mut v,"");Ok(v)
}
fn caches(dir:&Path,old_result:Option<&Value>)->AppResult<HashMap<String,CachedImage>> {
    let mut out=HashMap::new();
    for entry in std::fs::read_dir(dir)? {
        let entry=entry?;let name=entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("download-")||!name.ends_with(".json"){continue;}
        let v:Value=serde_json::from_slice(&checked_bytes(&entry.path(),65536)?)?;let key=s(&v,"resourceSha256");
        let image_name=format!("download-{key}.png");
        if v["kind"]!="ocr_downloaded_image"||!digest(key)||!digest(s(&v,"sha256"))||s(&v,"name")!=image_name||name!=format!("download-{key}.json"){return Err(changed());}
        let cached=CachedImage{path:dir.join(image_name),hash:s(&v,"sha256").to_owned(),bytes:v["bytes"].as_u64().ok_or_else(changed)? as usize};cached.load()?;
        if out.insert(key.to_owned(),cached).is_some(){return Err(changed());}
    }
    // Legacy source pages were already saved as PNG assets before the failed
    // download. Their unique page/role and hash are bound by the approval above.
    if let Some(result)=old_result {
        let layouts=result_rows(result)?.into_iter().flat_map(|r|r["result"]["layoutParsingResults"].as_array().cloned().unwrap_or_default()).collect::<Vec<_>>();
        let mut seen_resources=HashSet::new();
        for (i,layout) in layouts.iter().enumerate() {
            let raw=s(layout,"inputImage");let Ok(url)=Url::parse(raw) else {continue;};let key=resource_key(&url);
            if !seen_resources.insert(key.clone()){return Err(changed());}
            if out.contains_key(&key){continue;}
            let prefix=format!("ocr-p{}-source_page-",i+1);
            let files=std::fs::read_dir(dir)?.filter_map(Result::ok).filter(|e|e.file_name().to_str().is_some_and(|s|s.starts_with(&prefix)&&s.ends_with(".png"))).collect::<Vec<_>>();
            if files.len()>1{return Err(changed());}
            if let Some(file)=files.first(){let bytes=checked_bytes(&file.path(),MAX_IMAGE)?;let hash=sha(&bytes);
                if file.file_name().to_str()!=Some(&format!("{prefix}{}.png",&hash[..20])){return Err(changed());}
                let cached=CachedImage{path:file.path(),hash,bytes:bytes.len()};cached.load()?;out.insert(key,cached);
            }
        }
    }
    Ok(out)
}

/// New audit directory must not exist. `legacy_binding` is explicit caller
/// authorization, never manufactured by reading the current old directory.
pub(crate) fn resume_existing(settings:&OcrSettings,bytes:&[u8],filename:&str,old_audit:&Path,new_audit:&Path,
    legacy_binding:Option<&Value>,cancel:&AtomicBool)->AppResult<OcrDocument> {
    let started=Instant::now();
    if !settings.configured(){return Err(error("ocr_not_configured","请先配置独立 PaddleOCR 设置。"));}
    if bytes.is_empty()||bytes.len()>15*1024*1024{return Err(error("file_too_large","试卷文件需为1字节至15MB。"));}
    check(cancel,Instant::now())?;
    let (job,files)=authorize(settings,bytes,filename,old_audit,legacy_binding)?;
    let old_result=last_result(old_audit)?;let cached=caches(old_audit,old_result.as_ref())?;
    let endpoint=Url::parse(settings.endpoint()).map_err(|_|error("ocr_not_configured","PaddleOCR 接口无效。"))?;validate_url(endpoint.as_str(),&endpoint)?;
    std::fs::create_dir(new_audit)?;save_binding(settings,bytes,filename,new_audit)?;
    write_new(&new_audit.join("resume-evidence.json"),&json!({"schemaVersion":1,"mode":"existing_provider_job_get_only",
        "newOcrSubmission":false,"sourceSha256":sha(bytes),"oldAuditFiles":files,"cachedImageCount":cached.len(),"legacyBindingUsed":legacy_binding.is_some()}))?;
    // Carry every validated cache forward, including images a later page has
    // not used yet, so an interrupted continuation can itself be resumed.
    for (key,image) in &cached {check(cancel,started)?;save_image_receipt(new_audit,key,&image.load()?,Some(&image.path))?;}
    let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|_|error("ocr_runtime","无法启动识别恢复。"))?;
    std::thread::scope(|scope|scope.spawn(||runtime.block_on(async {
        let mut run=Run{endpoint:endpoint.clone(),key:settings.api_key(),audit:new_audit,cancel,start:started,sequence:0,total:0,docx:filename.to_ascii_lowercase().ends_with(".docx"),cached_images:cached};
        save_job(&run,&job)?;
        let result=async {
            let client=safe_client(&endpoint,&endpoint)?;let mut poll=endpoint.clone();poll.path_segments_mut().map_err(|_|changed())?.pop_if_empty().push(&job);
            loop {check(cancel,run.start)?;let status=run.json("poll",client.get(poll.clone()).bearer_auth(settings.api_key())).await?;
                match s(&status["data"],"state") {
                    "done"=>{let url=validate_url(s(&status["data"]["resultUrl"],"jsonUrl"),&endpoint)?;let client=safe_client(&url,&endpoint)?;let data=run.response("result",client.get(url),MAX_JSON).await?;
                        if let Some(old)=&old_result {let fresh=json!(decode_result(&data)?);if result_identity(old)?!=result_identity(&fresh)?{return Err(changed());}}
                        return normalize(&mut run,&data,status["data"]["extractProgress"]["totalPages"].as_u64().map(|n|n as usize)).await;},
                    "pending"|"running"=>{for _ in 0..50{check(cancel,run.start)?;tokio::time::sleep(Duration::from_millis(100)).await;}},
                    "failed"=>return Err(error("ocr_job_failed","原识别任务失败，未重新上传。")),
                    _=>return Err(error("ocr_invalid_state","原识别任务状态不明，未重新上传。")),
                }
            }
        }.await;
        if let Err(e)=&result {let _=run.save("failure",0,&serde_json::to_vec(&json!({"code":e.code,"message":e.message})).unwrap_or_default());}
        if inventory(old_audit)?!=files {return Err(changed());}result
    })).join().unwrap_or_else(|_|Err(error("ocr_failed","识别恢复未完成，原证据已保留。"))))
}

/// Pure derived links for legacy manifests. No automatic document/student
/// classification, no bytes/hash changes and no mutation of the old manifest.
pub(crate) fn derive_layout_links(document:&OcrDocument)->AppResult<(OcrDocument,Vec<Value>)> {
    let mut out=OcrDocument{pages:document.pages.clone(),assets:document.assets.clone(),issues:document.issues.clone()};let mut changes=vec![];
    let coordinates=regex::Regex::new(r"_box_(\d+)_(\d+)_(\d+)_(\d+)\.").unwrap();
    for asset in &mut out.assets {
        if asset["role"]=="source_page"||!asset["bbox"].is_null(){continue;}
        let Some(c)=coordinates.captures(s(asset,"sourcePath")) else {continue;};
        let Some(rect)=c.iter().skip(1).flatten().map(|m|m.as_str().parse::<u32>().ok()).collect::<Option<Vec<_>>>() else {continue;};
        let Some(page)=out.pages.iter_mut().find(|p|p["page"]==asset["page"]) else {return Err(changed());};
        let Some(blocks)=page["blocks"].as_array_mut() else {return Err(changed());};
        let indices=blocks.iter().enumerate().filter(|(_,b)|b["bbox"]==json!(rect)&&matches!(s(b,"type"),"image"|"chart"|"table"|"header_image"|"footer_image")).map(|(i,_)|i).collect::<Vec<_>>();
        if indices.len()!=1 {continue;}
        let b=&mut blocks[indices[0]];if !s(b,"assetId").is_empty()&&b["assetId"]!=asset["id"]{return Err(changed());}
        let audit=json!({"assetId":asset["id"],"assetSha256":asset["sha256"],"page":asset["page"],"blockId":b["id"],"bbox":rect,"layoutType":b["type"],"basis":"exact_provider_path_bbox_and_unique_original_layout_block"});
        b["assetId"]=asset["id"].clone();asset["bbox"]=json!(rect);asset["layoutType"]=b["type"].clone();changes.push(audit);
    }
    for page in &mut out.pages {let blocks=page["blocks"].as_array().cloned().unwrap_or_default();if let Some(omitted)=page["omittedBlocks"].as_array_mut(){for b in omitted {if let Some(found)=blocks.iter().find(|x|x["id"]==b["id"]){*b=found.clone();}}}}
    Ok((out,changes))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_resume_requires_external_frozen_binding_and_rejects_changed_images_before_network() {
        let dir=tempfile::tempdir().unwrap();let old=dir.path().join("old");std::fs::create_dir(&old).unwrap();
        write_new(&old.join("001-submit.json"),&json!({"httpStatus":200,"response":{"code":0,"data":{"jobId":"kept"}}})).unwrap();
        let mut config=OcrSettings::open(dir.path()).unwrap();config.save(&json!({"expectedRevision":config.public_settings()["revision"],"baseUrl":"http://127.0.0.1:9/jobs","model":"PaddleOCR-VL-1.6","apiKey":"simulated-key"})).unwrap();
        let bytes=b"%PDF-legacy";
        assert_eq!(authorize(&config,bytes,"sim.pdf",&old,None).err().unwrap().code,"ocr_resume_confirmation_required");
        let approval=json!({"sourceSha256":sha(bytes),"submitSha256":sha(&std::fs::read(old.join("001-submit.json")).unwrap()),"oldAuditPath":old.to_string_lossy(),"files":inventory(&old).unwrap()});
        assert!(authorize(&config,bytes,"sim.pdf",&old,Some(&approval)).is_ok());
        assert_eq!(authorize(&config,b"different","sim.pdf",&old,Some(&approval)).err().unwrap().code,"ocr_resume_evidence_changed");
        std::fs::write(old.join("unexpected.png"),b"changed").unwrap();
        let fresh=dir.path().join("fresh");
        assert_eq!(resume_existing(&config,bytes,"sim.pdf",&old,&fresh,Some(&approval),&AtomicBool::new(false)).err().unwrap().code,"ocr_resume_evidence_changed");
        assert!(!fresh.exists());
    }
    #[test]
    fn download_receipt_rejects_modified_pixels_and_distinguishes_resource_query_parameters() {
        let dir=tempfile::tempdir().unwrap();let key=resource_key(&Url::parse("https://example.test/image?signature=one&id=1").unwrap());
        assert_eq!(key,resource_key(&Url::parse("https://example.test/image?signature=two&id=1").unwrap()));
        assert_ne!(key,resource_key(&Url::parse("https://example.test/image?signature=two&id=2").unwrap()));
        save_image_receipt(dir.path(),&key,&DynamicImage::new_rgb8(12,16),None).unwrap();
        assert_eq!(caches(dir.path(),None).unwrap().len(),1);
        std::fs::write(dir.path().join(format!("download-{key}.png")),b"changed").unwrap();
        assert_eq!(caches(dir.path(),None).err().unwrap().code,"ocr_resume_image_changed");
    }
    #[test]
    fn derived_legacy_layout_links_are_exact_and_do_not_mutate_or_classify_material() {
        let d=OcrDocument{pages:vec![json!({"page":1,"blocks":[{"id":9,"type":"footer_image","bbox":[1,2,3,4]}],"omittedBlocks":[{"id":9,"type":"footer_image","bbox":[1,2,3,4]}]})],assets:vec![json!({"id":"original","sha256":"bound-pixel-hash","page":1,"role":"figure","bbox":null,"sourcePath":"imgs/scan_box_1_2_3_4.png"})],issues:vec![]};
        let (out,changes)=derive_layout_links(&d).unwrap();assert_eq!(changes.len(),1);assert_eq!(out.assets[0]["role"],"figure");assert_eq!(out.assets[0]["sha256"],d.assets[0]["sha256"]);
        assert_eq!(out.pages[0]["blocks"][0]["assetId"],"original");assert!(d.assets[0]["bbox"].is_null());assert!(d.pages[0]["blocks"][0]["assetId"].is_null());
        let mut ambiguous=OcrDocument{pages:d.pages.clone(),assets:d.assets.clone(),issues:vec![]};ambiguous.pages[0]["blocks"].as_array_mut().unwrap().push(json!({"id":10,"type":"image","bbox":[1,2,3,4]}));
        assert!(derive_layout_links(&ambiguous).unwrap().1.is_empty());
    }
}
