//! Explicit debug-only recovery of an already submitted OCR job. Never POSTs.
use super::*;

fn existing_job(old_audit: &Path) -> AppResult<(String, Vec<Value>)> {
    let path = old_audit.join("001-submit.json");
    let bytes = std::fs::read(&path)
        .map_err(|_| error("ocr_resume_missing_job", "旧识别记录没有已受理任务，不能无上传恢复。"))?;
    if bytes.len() > MAX_JSON {
        return Err(error("ocr_resume_invalid_job", "旧识别任务证据过大。"));
    }
    let wrapper: Value = serde_json::from_slice(&bytes)?;
    let response = &wrapper["response"];
    if wrapper["httpStatus"] != 200 || response["code"] != 0 {
        return Err(error("ocr_resume_invalid_job", "旧识别任务未证实已受理。"));
    }
    let id = response["data"]["jobId"].as_str().map(str::to_owned)
        .or_else(|| response["data"]["jobId"].as_u64().map(|n| n.to_string()))
        .filter(|id| !id.is_empty() && id.len() <= 150
            && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
        .ok_or_else(|| error("ocr_resume_invalid_job", "旧识别任务编号无效，未发起恢复请求。"))?;
    let mut files = Vec::new();
    for entry in std::fs::read_dir(old_audit)? {
        let entry = entry?;
        let metadata = std::fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() {
            return Err(error("ocr_resume_invalid_evidence", "旧识别证据包含链接，未发起恢复请求。"));
        }
        if metadata.is_file() {
            if metadata.len() > MAX_IMAGE.max(MAX_JSON) as u64 {
                return Err(error("ocr_resume_invalid_evidence", "旧识别证据超过上限。"));
            }
            let bytes = std::fs::read(entry.path())?;
            files.push(json!({"name":entry.file_name().to_string_lossy(),"sha256":sha(&bytes),"bytes":bytes.len()}));
        }
    }
    files.sort_by(|a,b| s(a,"name").cmp(s(b,"name")));
    Ok((id, files))
}

pub(crate) fn recover_existing(
    settings: &OcrSettings,
    old_audit: &Path,
    new_audit: &Path,
    filename: &str,
    cancel: &AtomicBool,
) -> AppResult<OcrDocument> {
    if !settings.configured() {
        return Err(error("ocr_not_configured", "请先配置独立 PaddleOCR 设置。"));
    }
    check(cancel, Instant::now())?;
    let (job_id, old_files) = existing_job(old_audit)?;
    let endpoint = Url::parse(settings.endpoint())
        .map_err(|_| error("ocr_not_configured", "PaddleOCR 接口无效。"))?;
    validate_url(endpoint.as_str(), &endpoint)?;
    // A new directory is mandatory: no overwrite of previous audits or PNGs.
    std::fs::create_dir(new_audit)?;
    let evidence = json!({"schemaVersion":1,"mode":"existing_provider_job_get_only",
        "newOcrSubmission":false,"oldAuditFiles":old_files,
        "imagePolicy":"fresh_normalize_downloads_original_page_images_into_new_directory; old_images_preserved_not_reused",
        "createdAt":chrono::Utc::now().to_rfc3339()});
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true)
        .open(new_audit.join("resume-evidence.json"))?;
    file.write_all(&serde_json::to_vec_pretty(&evidence)?)?;
    file.sync_all()?;
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()
        .map_err(|_| error("ocr_runtime", "无法启动识别恢复。"))?;
    std::thread::scope(|scope| {
        scope.spawn(|| runtime.block_on(async {
            let mut run = Run { endpoint:endpoint.clone(),key:settings.api_key(),audit:new_audit,
                cancel,start:Instant::now(),sequence:0,total:0,
                docx:filename.to_ascii_lowercase().ends_with(".docx") };
            let result = async {
                let client = safe_client(&endpoint,&endpoint)?;
                let mut poll = endpoint.clone();
                poll.path_segments_mut().map_err(|_| error("ocr_invalid_url","PaddleOCR 接口地址无效。"))?
                    .pop_if_empty().push(&job_id);
                loop {
                    check(cancel,run.start)?;
                    // Refresh signatures from the provider; audit URLs are redacted.
                    let status = run.json("poll",client.get(poll.clone()).bearer_auth(settings.api_key())).await?;
                    match s(&status["data"],"state") {
                        "done" => {
                            let url = validate_url(s(&status["data"]["resultUrl"],"jsonUrl"),&endpoint)?;
                            let result_client = safe_client(&url,&endpoint)?;
                            let data = run.response("result",result_client.get(url),MAX_JSON).await?;
                            return normalize(&mut run,&data,status["data"]["extractProgress"]["totalPages"]
                                .as_u64().map(|n| n as usize)).await;
                        }
                        "pending" | "running" => {
                            for _ in 0..50 { check(cancel,run.start)?; tokio::time::sleep(Duration::from_millis(100)).await; }
                        }
                        "failed" => return Err(error("ocr_job_failed","原识别任务失败，未重新上传。")),
                        _ => return Err(error("ocr_invalid_state","原识别任务状态不明，未重新上传。")),
                    }
                }
            }.await;
            if let Err(err) = &result {
                let _ = run.save("failure",0,&serde_json::to_vec(&json!({"code":err.code,"message":err.message})).unwrap_or_default());
            }
            // Recheck all old evidence; successful recovery cannot alter it.
            let (_, after) = existing_job(old_audit)?;
            if evidence["oldAuditFiles"] != json!(after) {
                return Err(error("ocr_resume_evidence_changed","原识别证据发生变化，恢复未采纳。"));
            }
            result
        })).join().unwrap_or_else(|_| Err(error("ocr_failed","识别恢复未完成，原证据已保留。")))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Read,net::TcpListener,sync::{Arc,Mutex}};

    #[test]
    fn missing_or_path_like_job_id_rejected_without_creating_recovery() {
        let dir=tempfile::tempdir().unwrap();
        assert_eq!(existing_job(dir.path()).unwrap_err().code,"ocr_resume_missing_job");
        std::fs::write(dir.path().join("001-submit.json"),serde_json::to_vec(&json!({"httpStatus":200,"response":{"code":0,"data":{"jobId":"../other?token=bad"}}})).unwrap()).unwrap();
        assert_eq!(existing_job(dir.path()).unwrap_err().code,"ocr_resume_invalid_job");
    }

    #[test]
    fn existing_job_gets_real_original_image_without_post_or_old_mutation() {
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base=format!("http://{}",listener.local_addr().unwrap());
        let requests=Arc::new(Mutex::new(Vec::<String>::new()));
        let stop=Arc::new(AtomicBool::new(false));
        let (seen,done,server_base)=(requests.clone(),stop.clone(),base.clone());
        let server=std::thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                let (mut stream,_)=match listener.accept() {
                    Ok(v)=>v,Err(e) if e.kind()==std::io::ErrorKind::WouldBlock=>{std::thread::sleep(Duration::from_millis(5));continue},Err(e)=>panic!("{e}") };
                stream.set_nonblocking(false).unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                let mut bytes=Vec::new();let mut buf=[0;2048];
                while !bytes.windows(4).any(|s| s==b"\r\n\r\n") {let n=stream.read(&mut buf).unwrap();if n==0 {break}bytes.extend_from_slice(&buf[..n]);}
                let head=String::from_utf8_lossy(&bytes).to_string();
                let line=head.lines().next().unwrap_or("").to_owned();
                seen.lock().unwrap().push(line.clone());
                let route=line.split_whitespace().nth(1).unwrap_or("");
                let body=if route=="/jobs/kept-job" {
                    serde_json::to_vec(&json!({"code":0,"data":{"state":"done","resultUrl":{"jsonUrl":format!("{server_base}/result?signature=live")},"extractProgress":{"totalPages":1}}})).unwrap()
                } else if route.starts_with("/result?") {
                    assert!(!head.to_ascii_lowercase().contains("authorization:"));
                    serde_json::to_vec(&json!({"result":{"layoutParsingResults":[{"inputImage":format!("{server_base}/page?signature=live"),"prunedResult":{"width":12,"height":16,"page_index":0,"parsing_res_list":[{"block_id":1,"block_order":1,"block_label":"text","block_content":"1. 模拟原题","block_bbox":[0,0,12,3]}]},"markdown":{"text":"1. 模拟原题","images":{}},"outputImages":{}}]}})).unwrap()
                } else {
                    assert!(route.starts_with("/page?"));
                    assert!(!head.to_ascii_lowercase().contains("authorization:"));
                    let mut png=Cursor::new(Vec::new());DynamicImage::new_rgb8(12,16).write_to(&mut png,ImageFormat::Png).unwrap();png.into_inner()
                };
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).unwrap();stream.write_all(&body).unwrap();
            }
        });
        let dir=tempfile::tempdir().unwrap();let old=dir.path().join("old");std::fs::create_dir(&old).unwrap();
        let submit=serde_json::to_vec(&json!({"httpStatus":200,"response":{"code":0,"data":{"jobId":"kept-job"}}})).unwrap();
        std::fs::write(old.join("001-submit.json"),&submit).unwrap();
        let mut settings=OcrSettings::open(dir.path()).unwrap();
        settings.save(&json!({"expectedRevision":settings.public_settings()["revision"],"baseUrl":format!("{base}/jobs"),"model":"PaddleOCR-VL-1.6","apiKey":"simulated-secret"})).unwrap();
        let fresh=dir.path().join("fresh");
        let result=recover_existing(&settings,&old,&fresh,"simulated.pdf",&AtomicBool::new(false));
        stop.store(true,Ordering::SeqCst);server.join().unwrap();
        let out=result.unwrap();assert_eq!(out.pages.len(),1);
        assert!(out.assets.iter().any(|a| a["role"]=="source_page" && a["width"]==12 && a["height"]==16));
        assert_eq!(std::fs::read(old.join("001-submit.json")).unwrap(),submit);
        let requests=requests.lock().unwrap();assert_eq!(requests.len(),3);
        assert!(requests.iter().all(|line| line.starts_with("GET ")));
        assert!(fresh.join("resume-evidence.json").is_file());
        let saved=std::fs::read_to_string(fresh.join("001-poll.json")).unwrap();
        assert!(!saved.contains("signature=live"));assert!(!saved.contains("simulated-secret"));
    }
}
