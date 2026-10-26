//! Explicit retry can revalidate a complete, source-bound provider response.
//! It never fabricates an HTTP attempt or changes the historical failed attempt.
use super::*;

fn changed() -> AppError { err("source_replay_changed", "已保存来源响应或原文依据已变化，未重放、未重新请求；请核对材料。") }
fn read(store:&Store,record:&Value,path:&Value,expected:&Value)->AppResult<Value> {
    let root=store.data_dir.join("imports").join(s(record,"importId")).canonicalize()?;
    let candidate=store.data_dir.join(path.as_str().ok_or_else(changed)?).canonicalize().map_err(|_|changed())?;
    if !candidate.starts_with(root)||std::fs::metadata(&candidate)?.len()>45*1024*1024{return Err(changed());}
    let bytes=std::fs::read(candidate)?;
    if expected.as_str()!=Some(&sha(&bytes)){return Err(changed());}
    serde_json::from_slice(&bytes).map_err(|_|changed())
}
pub(super) fn completed_attempt(record:&Value)->AppResult<Value> {
    let attempts=rows(&record["modelAttempts"]);
    if let Some(a)=attempts.iter().rev().find(|a|a["status"]=="succeeded"){return Ok(a.clone());}
    let replay=rows(&record["sourceResponseReplays"]).into_iter().rev().find(|a|a["status"]=="succeeded").ok_or_else(changed)?;
    let index=replay["originalAttemptIndex"].as_u64().ok_or_else(changed)? as usize;
    let attempt=attempts.get(index).ok_or_else(changed)?;
    if replay["sourceSha256"]!=record["source"]["sha256"]||replay["manifestSha256"]!=record["ocrSource"]["manifestSha256"]
        ||replay["originalAttemptHash"]!=hash_json(attempt)||attempt["status"]!="failed"||attempt["error"]["code"]!="ocr_question_coverage" {return Err(changed());}
    Ok(attempt.clone())
}
struct Cached { attempt:Value, index:usize, context:Value, raw:Value, response:std::path::PathBuf }
fn cached(store:&Store,record:&Value,document:&crate::ocr::OcrDocument)->AppResult<Option<Cached>> {
    let Some((index,attempt))=rows(&record["modelAttempts"]).into_iter().enumerate().rev().find(|(_,a)|a["status"]=="failed"&&a["task"]=="question_import"&&a["error"]["code"]=="ocr_question_coverage"&&a["providerResponseRelativePath"].is_string()) else{return Ok(None);};
    if attempt["importId"]!=record["importId"]||attempt["sourceSha256"]!=record["source"]["sha256"]{return Err(changed());}
    let original=read(store,record,&attempt["attemptRelativePath"],&attempt["attemptSha256"])?;
    for key in ["importId","sourceSha256","operationId","contextSha256","requestSha256","task"] {
        if original[key]!=attempt[key]{return Err(changed());}
    }
    let request=read(store,record,&attempt["requestRelativePath"],&attempt["requestFileSha256"])?;
    if request["redacted"]!=false||request["task"]!="question_import"||request["bodySha256"]!=hash_json(&request["body"])
        ||request["promptSha256"]!=hash_json(&request["body"]["messages"][0]["content"])
        ||request["bodySha256"]!=attempt["requestBodySha256"]||request["promptSha256"]!=attempt["promptSha256"]{return Err(changed());}
    let content=&request["body"]["messages"][1]["content"];
    let text=content.as_str().or_else(||content.as_array().and_then(|a|a.iter().find(|b|b["type"]=="text")).and_then(|b|b["text"].as_str())).ok_or_else(changed)?;
    let context:Value=serde_json::from_str(text).map_err(|_|changed())?;
    let mut original_context=context.clone();
    if let Some(checklist)=original_context.as_object_mut().ok_or_else(changed)?.remove("sourceMaterialChecklist") {
        if checklist!=context["document"]["requiredMaterialAssets"] {return Err(changed());}
    }
    if hash_json(&original_context)!=attempt["contextSha256"] {return Err(changed());}
    let expected=paddle::context(document);
    if context["sourceSha256"]!=record["source"]["sha256"]||context["document"]["provider"]!="paddleocr"||context["document"]["pages"]!=expected["pages"]{return Err(changed());}
    let given=context["document"]["assets"].as_array().ok_or_else(changed)?;
    let assets=expected["assets"].as_array().ok_or_else(changed)?;
    if given.len()!=assets.len()||!given.iter().zip(assets).all(|(a,b)|{let mut b=b.clone();if a.get("relativePath").is_none(){b.as_object_mut().unwrap().remove("relativePath");}*a==b}){return Err(changed());}
    let response=read(store,record,&attempt["providerResponseRelativePath"],&attempt["providerResponseSha256"])?;
    if response["httpStatus"]!=200||response["choices"][0]["finish_reason"]!="stop"{return Err(changed());}
    let raw:Value=serde_json::from_str(s(&response["choices"][0]["message"],"content")).map_err(|_|changed())?;
    if !raw["questions"].as_array().is_some_and(|q|!q.is_empty()&&q.len()<=MAX_QUESTIONS){return Err(changed());}
    Ok(Some(Cached{response:store.data_dir.join(s(&attempt,"providerResponseRelativePath")),attempt,index,context,raw}))
}
pub(super) fn replay(store:&Store,model:&ModelClient,record:&mut Value,saved:&mut Value,document:&crate::ocr::OcrDocument,op:&str)->AppResult<Option<Vec<Value>>> {
    let Some(cache)=cached(store,record,document)? else{return Ok(None);};
    if rows(&record["sourceResponseReplays"]).iter().any(|r|r["operationId"]==op){return Err(err("operation_conflict","本次来源重放已执行，未重复处理或外呼。"));}
    let entry=json!({"version":1,"operationId":op,"status":"running","startedAt":now(),"sourceSha256":record["source"]["sha256"],"manifestSha256":record["ocrSource"]["manifestSha256"],"originalAttemptIndex":cache.index,"originalAttemptHash":hash_json(&cache.attempt),"requestFileSha256":cache.attempt["requestFileSha256"],"providerResponseSha256":cache.attempt["providerResponseSha256"],"httpRequests":0});
    let mut history=rows(&record["sourceResponseReplays"]);history.push(entry);record["sourceResponseReplays"]=json!(history);
    save_cas(store,Some(saved),record)?;*saved=record.clone();
    let result=prepare_questions(store,&cache.raw,record,document.pages.len(),Some(document)).and_then(|mut questions|{
        review::attach_import_opinions(store,model,record,&cache.raw,&cache.context,&cache.response,&mut questions)?;
        Ok(questions)
    });
    let entry=record["sourceResponseReplays"].as_array_mut().unwrap().last_mut().unwrap();
    entry["finishedAt"]=json!(now());entry["status"]=json!(if result.is_ok(){"succeeded"}else{"failed"});
    entry["error"]=result.as_ref().err().map(|e|serde_json::to_value(e).unwrap()).unwrap_or(Value::Null);
    if let Ok(questions)=&result {entry["questionCount"]=json!(questions.len());}
    save_cas(store,Some(saved),record)?;*saved=record.clone();
    result.map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn write_json(store: &Store, relative: &str, value: &Value) -> String {
        let path = store.data_dir.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let bytes = serde_json::to_vec_pretty(value).unwrap();
        std::fs::write(path, &bytes).unwrap();
        sha(&bytes)
    }

    fn fixture() -> (tempfile::TempDir, Store, Value, crate::ocr::OcrDocument) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), &crate::bank::tests::seed()).unwrap();
        let id = "simulated-source-replay";
        let original_bytes = b"simulated immutable original";
        let source_sha = sha(original_bytes);
        let document = crate::ocr::OcrDocument {
            pages: vec![json!({"page":1,"text":"1. 模拟来源回归题","blocks":[{"id":1,"text":"1. 模拟来源回归题","type":"text"}]})],
            assets: vec![], issues: vec![],
        };
        let context = json!({"sourceSha256":source_sha,"document":paddle::context(&document),"trustedCatalogue":{"simulated":true},"imageReviewAvailable":false});
        let mut wire_context = context.clone();
        wire_context["sourceMaterialChecklist"] = wire_context["document"]["requiredMaterialAssets"].clone();
        let body = json!({"model":"simulated-source","messages":[{"role":"system","content":"模拟来源整理合同"},{"role":"user","content":wire_context.to_string()}]});
        let request = json!({"task":"question_import","redacted":false,"bodySha256":hash_json(&body),"promptSha256":hash_json(&body["messages"][0]["content"]),"body":body});
        let response = json!({"httpStatus":200,"choices":[{"finish_reason":"stop","message":{"content":json!({"questions":[{"sourceLabel":"1"}]}).to_string()}}]});
        let original = json!({"importId":id,"sourceSha256":source_sha,"operationId":"simulated-failed-op","contextSha256":hash_json(&context),"requestSha256":"simulated-upload-payload","task":"question_import"});
        let prefix = format!("imports/{id}");
        std::fs::create_dir_all(store.data_dir.join(&prefix)).unwrap();
        std::fs::write(store.data_dir.join(format!("{prefix}/source.pdf")), original_bytes).unwrap();
        let attempt = json!({"importId":id,"sourceSha256":source_sha,"operationId":original["operationId"],"contextSha256":original["contextSha256"],"requestSha256":original["requestSha256"],"task":"question_import","status":"failed","error":{"code":"ocr_question_coverage"},"attemptRelativePath":format!("{prefix}/attempt.json"),"attemptSha256":write_json(&store,&format!("{prefix}/attempt.json"),&original),"requestRelativePath":format!("{prefix}/request.json"),"requestFileSha256":write_json(&store,&format!("{prefix}/request.json"),&request),"requestBodySha256":request["bodySha256"],"promptSha256":request["promptSha256"],"providerResponseRelativePath":format!("{prefix}/response.json"),"providerResponseSha256":write_json(&store,&format!("{prefix}/response.json"),&response)});
        let record = json!({"importId":id,"source":{"sha256":source_sha,"relativePath":format!("{prefix}/source.pdf"),"byteLength":original_bytes.len()},"ocrSource":{"manifestSha256":"simulated-manifest"},"modelAttempts":[attempt]});
        (dir, store, record, document)
    }

    fn request_context(request: &Value) -> Value {
        serde_json::from_str(s(&request["body"]["messages"][1], "content")).unwrap()
    }

    fn rebind_request(store: &Store, record: &mut Value, edit: impl FnOnce(&mut Value)) {
        let path = s(&record["modelAttempts"][0], "requestRelativePath").to_owned();
        let mut request: Value = serde_json::from_slice(&std::fs::read(store.data_dir.join(&path)).unwrap()).unwrap();
        let mut context = request_context(&request);
        edit(&mut context);
        request["body"]["messages"][1]["content"] = json!(context.to_string());
        request["bodySha256"] = json!(hash_json(&request["body"]));
        record["modelAttempts"][0]["requestBodySha256"] = request["bodySha256"].clone();
        record["modelAttempts"][0]["requestFileSha256"] = json!(write_json(store, &path, &request));
    }

    #[test]
    fn simulated_cached_source_reads_without_changing_failed_attempt() {
        let (_dir, store, record, document) = fixture();
        let before = record.clone();
        let cache = cached(&store, &record, &document).unwrap().unwrap();
        assert_eq!(cache.index, 0);
        assert_eq!(cache.raw["questions"][0]["sourceLabel"], "1");
        assert!(cache.response.starts_with(&store.data_dir));
        assert_eq!(record, before);
        assert_eq!(record["modelAttempts"][0]["status"], "failed");
        // No ModelClient is constructed and no HTTP path is called.
    }

    #[test]
    fn simulated_cached_source_rejects_byte_or_expected_hash_tampering() {
        for field in ["attemptRelativePath", "requestRelativePath", "providerResponseRelativePath"] {
            let (_dir, store, record, document) = fixture();
            std::fs::write(store.data_dir.join(s(&record["modelAttempts"][0], field)), b"{}").unwrap();
            assert!(cached(&store, &record, &document).is_err(), "{field}");
        }
        for field in ["attemptSha256", "requestFileSha256", "providerResponseSha256", "requestBodySha256", "promptSha256"] {
            let (_dir, store, mut record, document) = fixture();
            record["modelAttempts"][0][field] = json!("forged");
            assert!(cached(&store, &record, &document).is_err(), "{field}");
        }
    }

    #[test]
    fn simulated_cached_source_rejects_rebound_context_source_and_paths() {
        for mutation in ["catalogue", "pages", "checklist", "source"] {
            let (_dir, store, mut record, document) = fixture();
            rebind_request(&store, &mut record, |context| match mutation {
                "catalogue" => context["trustedCatalogue"]["simulated"] = json!(false),
                "pages" => context["document"]["pages"][0]["text"] = json!("changed source"),
                "checklist" => context["sourceMaterialChecklist"] = json!([{"assetId":"forged"}]),
                _ => context["sourceSha256"] = json!("changed source identity"),
            });
            assert!(cached(&store, &record, &document).is_err(), "rebound {mutation}");
        }
        let (dir, store, mut record, document) = fixture();
        record["source"]["sha256"] = json!("different");
        assert!(cached(&store, &record, &document).is_err());
        let (_other, store, mut record, document) = fixture();
        let outside = dir.path().join("outside.json");
        let bytes = serde_json::to_vec(&json!({})).unwrap();
        std::fs::write(&outside, &bytes).unwrap();
        record["modelAttempts"][0]["providerResponseRelativePath"] = json!(outside.to_str().unwrap());
        record["modelAttempts"][0]["providerResponseSha256"] = json!(sha(&bytes));
        assert!(cached(&store, &record, &document).is_err());
    }

    #[test]
    fn simulated_cached_source_rejects_hashed_truncated_or_invalid_response() {
        for replacement in [
            json!({"httpStatus":200,"choices":[{"finish_reason":"length","message":{"content":"{\"questions\":[{\"sourceLabel\":\"1\"}]}"}}]}),
            json!({"httpStatus":500,"choices":[{"finish_reason":"stop","message":{"content":"{\"questions\":[{}]}"}}]}),
            json!({"httpStatus":200,"choices":[{"finish_reason":"stop","message":{"content":"{\"questions\":["}}]}),
            json!({"httpStatus":200,"choices":[{"finish_reason":"stop","message":{"content":"{\"questions\":[]}"}}]}),
        ] {
            let (_dir, store, mut record, document) = fixture();
            let path = s(&record["modelAttempts"][0], "providerResponseRelativePath").to_owned();
            record["modelAttempts"][0]["providerResponseSha256"] = json!(write_json(&store, &path, &replacement));
            assert!(cached(&store, &record, &document).is_err());
        }
    }

    fn mark_replayed(record: &mut Value) {
        record["sourceResponseReplays"] = json!([{"status":"succeeded","originalAttemptIndex":0,"originalAttemptHash":hash_json(&record["modelAttempts"][0]),"sourceSha256":record["source"]["sha256"],"manifestSha256":record["ocrSource"]["manifestSha256"],"httpRequests":0}]);
    }

    #[test]
    fn simulated_publication_selector_requires_bound_successful_replay_metadata() {
        let (_dir, _store, mut record, _document) = fixture();
        assert!(completed_attempt(&record).is_err());
        let failed_attempt = record["modelAttempts"][0].clone();
        mark_replayed(&mut record);
        assert_eq!(completed_attempt(&record).unwrap(), failed_attempt);
        assert_eq!(record["modelAttempts"][0]["status"], "failed");
        for field in ["originalAttemptHash", "sourceSha256", "manifestSha256"] {
            let mut bad = record.clone();
            bad["sourceResponseReplays"][0][field] = json!("changed");
            assert!(completed_attempt(&bad).is_err(), "{field}");
        }
        let mut bad = record.clone();
        bad["sourceResponseReplays"][0]["originalAttemptIndex"] = json!(9);
        assert!(completed_attempt(&bad).is_err());
        let mut bad = record.clone();
        bad["modelAttempts"][0]["error"]["code"] = json!("different");
        assert!(completed_attempt(&bad).is_err());
    }

    #[test]
    #[ignore = "explicit read-only saved-source fixture; provide record and runtime paths"]
    fn saved_p9_cached_source_prepares_all19_in_isolated_store_without_http() {
        let record_path = PathBuf::from(std::env::var_os("TUTOR_SOURCE_REPLAY_RECORD").expect("record path"));
        let old_root = PathBuf::from(std::env::var_os("TUTOR_SOURCE_REPLAY_RUNTIME").expect("old runtime path")).canonicalize().unwrap();
        let old_record_bytes = std::fs::read(&record_path).unwrap();
        let record: Value = serde_json::from_slice(&old_record_bytes).unwrap();
        let old_attempts = record["modelAttempts"].clone();
        let dir = tempfile::tempdir().unwrap();
        let seed: Value = serde_json::from_str(include_str!("../../../resources/seed.json")).unwrap();
        let store = Store::open(dir.path(), &seed).unwrap();
        assert_ne!(store.data_dir.canonicalize().unwrap(), old_root);
        let mut relative_paths = vec![s(&record["source"], "relativePath").to_owned(), s(&record["ocrSource"], "manifestRelativePath").to_owned()];
        relative_paths.extend(rows(&record["ocrSource"]["assets"]).iter().map(|a| s(a, "relativePath").to_owned()));
        for attempt in rows(&record["modelAttempts"]) {
            for field in ["attemptRelativePath", "requestRelativePath", "providerResponseRelativePath"] {
                if let Some(path) = attempt[field].as_str() { relative_paths.push(path.to_owned()); }
            }
        }
        relative_paths.sort(); relative_paths.dedup();
        let mut original_hashes = vec![];
        for relative in relative_paths {
            let source = old_root.join(&relative).canonicalize().unwrap();
            assert!(source.starts_with(old_root.join("imports").canonicalize().unwrap()));
            let destination = store.data_dir.join(Path::new(&relative));
            assert!(destination.starts_with(&store.data_dir));
            let bytes = std::fs::read(&source).unwrap();
            original_hashes.push((source, sha(&bytes)));
            std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
            std::fs::write(destination, bytes).unwrap();
        }
        let document = paddle::load_document(&store, &record).unwrap();
        let cache = cached(&store, &record, &document).unwrap().expect("saved source response");
        let prepared = prepare_questions(&store, &cache.raw, &record, document.pages.len(), Some(&document)).unwrap();
        assert_eq!(prepared.len(), 19);
        assert_eq!(prepared.iter().map(|q| s(q,"sourceLabel")).collect::<Vec<_>>(), (1..=19).map(|n| n.to_string()).collect::<Vec<_>>().iter().map(String::as_str).collect::<Vec<_>>());
        assert!(prepared.iter().all(|q| q["teachingWorkflow"]["generationCalls"] == 0));
        let mut replay_record = record.clone();
        mark_replayed(&mut replay_record);
        assert_eq!(completed_attempt(&replay_record).unwrap(), cache.attempt);
        assert_eq!(replay_record["modelAttempts"], old_attempts);
        assert_eq!(record["modelAttempts"], old_attempts);
        for (path, expected) in original_hashes { assert_eq!(sha(&std::fs::read(path).unwrap()), expected); }
        assert_eq!(std::fs::read(record_path).unwrap(), old_record_bytes);
        // Only the temporary Store opens SQLite. No old personal/bank database,
        // ModelClient, replay() or HTTP transport is used by this test.
    }
}
