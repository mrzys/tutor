//! Optional, read-only evidence that a particular source transcription was
//! adjusted. This is display context only: it never acknowledges an issue,
//! edits the imported question, changes its hash, or grants publication.
use super::*;
use std::collections::BTreeMap;

const MAX_NOTES_BYTES: u64 = 256 * 1024;
const MAX_NOTES: usize = 120;

fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 120
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

fn digest(value: &Value) -> bool {
    value.as_str().is_some_and(|text| text.len() == 64
        && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

fn field_value<'a>(question: &'a Value, path: &str) -> Option<&'a str> {
    if matches!(path, "stem" | "answer" | "solution") { return question[path].as_str(); }
    if let Some(tail) = path.strip_prefix("options[") {
        let index = tail.strip_suffix("].text")?.parse::<usize>().ok()?;
        if path != format!("options[{index}].text") { return None; }
        return question["options"].get(index)?.get("text")?.as_str();
    }
    let tail = path.strip_prefix("parts[")?;
    let (index, field) = tail.split_once("].")?;
    let index = index.parse::<usize>().ok()?;
    if !matches!(field, "stem" | "prompt" | "answer" | "solution")
        || path != format!("parts[{index}].{field}") { return None; }
    question["parts"].get(index)?.get(field)?.as_str()
}

/// Same-response source adjustment metadata is optional. Invalid metadata is
/// ignored while the original issue remains needs-review; no second request,
/// source mutation, or implied independent verification is introduced.
pub(super) fn normalize_model_correction(raw: &Value, question: &Value, record: &Value, images: bool) -> Option<Value> {
    if !images || !paddle::uses(question) || raw["status"] != "corrected_pending_confirmation"
        || !matches!(s(raw,"kind"),"ocr_transcription"|"transcription_adjustment")
        || question["sourceIdentity"]["sourceSha256"] != record["source"]["sha256"]
        || question["sourceIdentity"]["manifestSha256"] != record["ocrSource"]["manifestSha256"]
        || !digest(&record["source"]["sha256"]) || !digest(&record["ocrSource"]["manifestSha256"]) { return None; }
    let path=s(raw,"fieldPath");
    if path.len()>80 { return None; }
    let current=field_value(question,path)?;
    let before=s(raw,"ocrText");let after=s(raw,"transcribedText");
    if before.trim().is_empty() || after.trim().is_empty() || before==after
        || before.len()>3000 || after.len()>3000 || !current.contains(after) { return None; }
    let page=raw["evidencePage"].as_u64().filter(|p|*p>0)?;
    if !rows(&question["pages"]).iter().any(|p|p.as_u64()==Some(page)) { return None; }
    let block_id=s(raw,"sourceBlockId");
    let block=block_id.strip_prefix(&format!("p{page}-b"))?.parse::<u64>().ok()?;
    if block_id!=format!("p{page}-b{block}") || !ids(&question["sourceBlockIds"]).iter().any(|id|id==block_id) { return None; }
    let layouts=rows(&record["ocrSource"]["pages"]);
    let layouts:Vec<_>=layouts.iter().filter(|p|p["page"].as_u64()==Some(page)).collect();
    if layouts.len()!=1 { return None; }
    let layout=layouts[0];let blocks=rows(&layout["blocks"]);
    let blocks:Vec<_>=blocks.iter().filter(|b|b["id"].as_u64()==Some(block)).collect();
    if blocks.len()!=1 || !s(blocks[0],"text").contains(before) { return None; }
    let assets=rows(&record["ocrSource"]["assets"]);
    let assets:Vec<_>=assets.iter().filter(|a|a["role"]=="source_page" && a["page"].as_u64()==Some(page)).collect();
    if assets.len()!=1 || assets[0]["id"]!=layout["sourceImageAssetId"]
        || assets[0]["mimeType"]!="image/png" || !digest(&assets[0]["sha256"]) { return None; }
    Some(json!({"schemaVersion":1,"status":"corrected_pending_confirmation","kind":raw["kind"],
        "fieldPath":path,"sourceBlockId":block_id,"evidencePage":page,"ocrText":before,"transcribedText":after,
        "sourceContentSha256":review::content_hash(question),"sourceSha256":record["source"]["sha256"],
        "ocrManifestSha256":record["ocrSource"]["manifestSha256"],"fieldValueSha256":sha(current.as_bytes()),
        "sourceBlockTextSha256":sha(s(blocks[0],"text").as_bytes()),"sourcePageAssetSha256":assets[0]["sha256"]}))
}

fn validated_note(store: &Store, record: &Value, note: &Value, import_root: &Path) -> Option<Value> {
    if note["status"] != "corrected_pending_confirmation"
        || !matches!(s(note, "kind"), "ocr_transcription" | "transcription_adjustment")
        || note["method"] != "user_authorized_agent_review" || note["checkedBy"] != "codex"
        || chrono::DateTime::parse_from_rfc3339(s(note, "checkedAt")).is_err()
        || s(note, "basis").trim().is_empty() || s(note, "basis").len() > 3000
        || !["sourceContentSha256", "sourceSha256", "ocrManifestSha256", "fieldValueSha256",
            "sourceBlockTextSha256", "sourcePageAssetSha256", "issueSha256"].iter().all(|key| digest(&note[*key]))
        || note["sourceSha256"] != record["source"]["sha256"]
        || note["ocrManifestSha256"] != record["ocrSource"]["manifestSha256"] { return None; }
    let questions = rows(&record["questions"]);
    let matching: Vec<_> = questions.iter().filter(|q| q["questionId"] == note["questionId"]).collect();
    if matching.len() != 1 { return None; }
    let question = matching[0];
    if !paddle::uses(question) || question["sourceIdentity"]["sourceSha256"] != note["sourceSha256"]
        || question["sourceIdentity"]["manifestSha256"] != note["ocrManifestSha256"]
        || note["sourceContentSha256"] != review::content_hash(question)
        || question["modelReview"]["contentSha256"] != note["sourceContentSha256"]
        || question["modelReview"]["status"] != "needs_review"
        || question["modelReview"]["evidence"]["imageReviewAvailable"] != true
        || question["modelReview"]["evidence"]["sourceSha256"] != note["sourceSha256"]
        || question["modelReview"]["evidence"]["ocrManifestSha256"] != note["ocrManifestSha256"] { return None; }
    let index = usize::try_from(note["issueIndex"].as_u64()?).ok()?;
    let issue = question["modelReview"]["issues"].get(index)?;
    if !issue.is_object() || s(issue, "message").is_empty()
        || note["issueField"] != issue["field"] || note["issueMessage"] != issue["message"]
        || note["issueSha256"] != hash_json(issue) { return None; }
    let path = s(note, "fieldPath");
    if path.len() > 80 || sha(field_value(question, path)?.as_bytes()) != s(note, "fieldValueSha256") { return None; }
    let page = note["evidencePage"].as_u64().filter(|page| *page > 0)?;
    if !rows(&question["pages"]).iter().any(|p| p.as_u64() == Some(page))
        || !rows(&question["modelReview"]["evidence"]["pages"]).iter().any(|p| p.as_u64() == Some(page)) { return None; }
    let block_id = s(note, "sourceBlockId");
    let block = block_id.strip_prefix(&format!("p{page}-b"))?.parse::<u64>().ok()?;
    if block_id != format!("p{page}-b{block}") || !ids(&question["sourceBlockIds"]).iter().any(|id| id == block_id) { return None; }
    let layouts = rows(&record["ocrSource"]["pages"]);
    let layouts: Vec<_> = layouts.iter().filter(|p| p["page"].as_u64() == Some(page)).collect();
    if layouts.len() != 1 { return None; }
    let layout = layouts[0];
    let blocks = rows(&layout["blocks"]);
    let blocks: Vec<_> = blocks.iter().filter(|b| b["id"].as_u64() == Some(block)).collect();
    if blocks.len() != 1 || s(blocks[0], "text").is_empty()
        || sha(s(blocks[0], "text").as_bytes()) != s(note, "sourceBlockTextSha256") { return None; }
    let assets = rows(&record["ocrSource"]["assets"]);
    let pages: Vec<_> = assets.iter().filter(|a| a["role"] == "source_page" && a["page"].as_u64() == Some(page)).collect();
    if pages.len() != 1 { return None; }
    let image = pages[0];
    if image["sha256"] != note["sourcePageAssetSha256"] || image["id"] != layout["sourceImageAssetId"]
        || image["mimeType"] != "image/png" { return None; }
    let image_path = store.data_dir.join(s(image, "relativePath")).canonicalize().ok()?;
    if !image_path.starts_with(import_root) || !image_path.is_file() { return None; }
    // read_source verified the original, manifest bytes and every asset hash.
    // Only allowlisted display fields leave this module; no caller-supplied
    // approval, labels, HTML, paths or arbitrary status can be projected.
    Some(json!({"schemaVersion":1,"status":"corrected_pending_confirmation","kind":note["kind"],
        "fieldPath":path,"issueIndex":index,"issueField":note["issueField"],"issueMessage":note["issueMessage"],
        "sourceContentSha256":note["sourceContentSha256"],"fieldValueSha256":note["fieldValueSha256"],
        "evidencePage":page,"method":"user_authorized_agent_review","checkedBy":"codex",
        "checkedAt":note["checkedAt"],"basis":note["basis"]}))
}

fn load_projection(store: &Store, record: &Value, only_question: Option<&str>) -> Option<Value> {
    let id = s(record, "importId");
    if !safe_id(id) { return None; }
    let root = store.data_dir.canonicalize().ok()?;
    let expected_notes_root = root.join("imports-display-notes");
    let notes_root = expected_notes_root.canonicalize().ok()?;
    if notes_root != expected_notes_root { return None; }
    let expected_path = notes_root.join(format!("{id}.json"));
    let path = expected_path.canonicalize().ok()?;
    if path != expected_path || !path.is_file() { return None; }
    let mut file = std::fs::File::open(path).ok()?;
    if file.metadata().ok()?.len() > MAX_NOTES_BYTES { return None; }
    let mut bytes = vec![];
    Read::by_ref(&mut file).take(MAX_NOTES_BYTES + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_NOTES_BYTES { return None; }
    let bundle: Value = serde_json::from_slice(&bytes).ok()?;
    let notes = bundle["notes"].as_array().filter(|notes| !notes.is_empty() && notes.len() <= MAX_NOTES)?;
    if bundle["schemaVersion"] != 1 || bundle["importId"] != id || !record["ocrSource"].is_object() { return None; }
    // Do not expose optional display evidence when any preserved source audit
    // is stale, missing or outside this exact import's owned directory.
    read_source(store, record).ok()?;
    let import_root = root.join("imports").join(id).canonicalize().ok()?;
    if import_root != root.join("imports").join(id)
        || store.data_dir.join(s(&record["source"], "relativePath")).canonicalize().ok()?.parent()? != import_root
        || !store.data_dir.join(s(&record["ocrSource"], "manifestRelativePath")).canonicalize().ok()?.starts_with(&import_root) { return None; }
    let mut unique = BTreeMap::<(String, u64), Vec<Value>>::new();
    for note in notes {
        if only_question.is_some_and(|id| note["questionId"] != id) { continue; }
        if let Some(display) = validated_note(store, record, note, &import_root) {
            unique.entry((s(note, "questionId").to_owned(), note["issueIndex"].as_u64()?)).or_default().push(display);
        }
    }
    let mut result = serde_json::Map::new();
    for ((question, _), displays) in unique {
        // Ambiguous duplicate authorizations never pick an arbitrary note.
        if displays.len() == 1 {
            result.entry(question).or_insert_with(|| json!([])).as_array_mut()?.push(displays[0].clone());
        }
    }
    Some(Value::Object(result))
}

fn model_projection(store: &Store, record: &Value, only_question: Option<&str>) -> Option<Value> {
    let questions=rows(&record["questions"]);
    if !questions.iter().any(|q|rows(&q["modelReview"]["issues"]).iter().any(|i|i["correction"].is_object())) { return None; }
    let id=s(record,"importId");if !safe_id(id) { return None; }
    read_source(store,record).ok()?;
    let root=store.data_dir.canonicalize().ok()?;
    let import_root=root.join("imports").join(id).canonicalize().ok()?;
    if import_root!=root.join("imports").join(id)
        || store.data_dir.join(s(&record["source"],"relativePath")).canonicalize().ok()?.parent()?!=import_root
        || !store.data_dir.join(s(&record["ocrSource"],"manifestRelativePath")).canonicalize().ok()?.starts_with(&import_root) { return None; }
    let mut result=serde_json::Map::new();
    for question in questions {
        if only_question.is_some_and(|id| question["questionId"] != id) { continue; }
        let issues=rows(&question["modelReview"]["issues"]);
        if !issues.iter().any(|i|i["correction"].is_object())
            || review::verify_display_opinion(store,&question,record).is_err() { continue; }
        let checked_at=s(&question["modelReview"],"reviewedAt");
        if chrono::DateTime::parse_from_rfc3339(checked_at).is_err() { continue; }
        let identity=&question["modelReview"]["model"];
        let actual=s(identity,"model");
        let checked_by=if identity["identityEvidence"]["kind"]=="provider_request_receipt"
            && !actual.is_empty() && actual.len()<=200 && !actual.chars().any(char::is_control) {actual}else{"模型"};
        let mut displays=vec![];
        for (index,issue) in issues.iter().enumerate() {
            let correction=&issue["correction"];
            let Some(normalized)=normalize_model_correction(correction,&question,record,true) else {continue;};
            if &normalized!=correction { continue; }
            let page=correction["evidencePage"].as_u64()?;
            let page_assets=rows(&record["ocrSource"]["assets"]);
            let Some(asset)=page_assets.iter().find(|a|a["role"]=="source_page" && a["page"].as_u64()==Some(page)) else {continue;};
            let Some(asset_path)=store.data_dir.join(s(asset,"relativePath")).canonicalize().ok() else {continue;};
            if !asset_path.starts_with(&import_root) {continue;}
            displays.push(json!({"schemaVersion":1,"status":"corrected_pending_confirmation","kind":correction["kind"],
                "fieldPath":correction["fieldPath"],"issueIndex":index,"issueField":issue["field"],"issueMessage":issue["message"],
                "sourceContentSha256":correction["sourceContentSha256"],"fieldValueSha256":correction["fieldValueSha256"],
                "evidencePage":page,"method":"model_review","checkedBy":checked_by,"checkedAt":checked_at,
                "basis":format!("模型按原页调整本字段，待用户确认。OCR原文：“{}”；当前转录：“{}”。",s(correction,"ocrText"),s(correction,"transcribedText"))}));
        }
        if !displays.is_empty() { result.insert(s(&question,"questionId").to_owned(),json!(displays)); }
    }
    Some(Value::Object(result))
}

/// Missing or invalid optional evidence leaves all existing review messages and
/// gates intact. There is deliberately no public write action for these notes.
pub(super) fn projection(store: &Store, record: &Value) -> Value {
    project(store,record,None)
}
pub(super) fn projection_for_question(store: &Store, record: &Value, id: &str) -> Value {
    project(store,record,Some(id))
}
fn project(store: &Store, record: &Value, only_question: Option<&str>) -> Value {
    let mut result=load_projection(store,record,only_question).unwrap_or_else(||json!({}));
    if let Some(Value::Object(model))=model_projection(store,record,only_question) {
        for (id,displays) in model {
            let target=result.as_object_mut().unwrap().entry(id).or_insert_with(||json!([])).as_array_mut().unwrap();
            for display in rows(&displays) {
                if !target.iter().any(|existing|existing["issueIndex"]==display["issueIndex"]) {target.push(display);}
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, Store, Value, Value) {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path(), &crate::bank::tests::seed()).unwrap();
        let id = "sim-source-display";
        let source = save_source(&store, id, "pdf", b"%PDF-simulated-display-original").unwrap();
        let mut record = json!({"importId":id,"revision":2,"source":source,"extractedPages":["OCR original"],"questions":[],"sourceIssues":[]});
        let png = b"\x89PNG\r\n\x1a\nsimulated-source-display-page";
        let image = json!({"id":"sim-page-1","role":"source_page","page":1,"mimeType":"image/png","sha256":sha(png),"contentBase64":base64::engine::general_purpose::STANDARD.encode(png)});
        let audit = store.data_dir.join(format!("imports/{id}/ocr"));
        std::fs::create_dir_all(&audit).unwrap();
        paddle::save_document(&store,&mut record,&crate::ocr::OcrDocument {
            pages:vec![json!({"page":1,"sourceImageAssetId":"sim-page-1","text":"OCR truncated", "blocks":[{"id":1,"text":"原OCR条件在等号后截断 x="}]})],
            assets:vec![image],issues:vec![],
        },&audit.canonicalize().unwrap(),json!({"provider":"simulated"})).unwrap();
        let mut question = json!({"questionId":"sim-display-q1","sourceLabel":"1","questionType":"single_choice", "stem":"模拟原题", "options":[{"label":"A","text":"x=2"},{"label":"B","text":"x=3"}], "parts":[],"answer":"","solution":"","pages":[1], "sourceBlockIds":["p1-b1"],"sourceIdentity":{"system":"paddleocr_upload","sourceSha256":record["source"]["sha256"],"manifestSha256":record["ocrSource"]["manifestSha256"]},"reviewDecision":"pending"});
        let content = review::content_hash(&question);
        question["modelReview"] = json!({"status":"needs_review","contentSha256":content,
            "issues":[{"field":"options.A.text","message":"模拟OCR识别差异需核对"}],
            "evidence":{"imageReviewAvailable":true,"sourceSha256":record["source"]["sha256"],"ocrManifestSha256":record["ocrSource"]["manifestSha256"],"pages":[1]}});
        record["questions"] = json!([question]);
        store.put_document("imports",id,&record).unwrap();
        let note = json!({"questionId":"sim-display-q1","sourceContentSha256":content,"sourceSha256":record["source"]["sha256"],
            "ocrManifestSha256":record["ocrSource"]["manifestSha256"],"fieldPath":"options[0].text","fieldValueSha256":sha(b"x=2"),
            "sourceBlockId":"p1-b1","sourceBlockTextSha256":sha("原OCR条件在等号后截断 x=".as_bytes()),"sourcePageAssetSha256":sha(png),"evidencePage":1,
            "issueIndex":0,"issueField":"options.A.text","issueMessage":"模拟OCR识别差异需核对","issueSha256":hash_json(&record["questions"][0]["modelReview"]["issues"][0]),
            "method":"user_authorized_agent_review","checkedBy":"codex","checkedAt":"2026-10-29T12:00:00Z","status":"corrected_pending_confirmation","kind":"ocr_transcription","basis":"模拟原页对照，只确认此处转录已补全，仍待用户确认。"});
        let bundle = json!({"schemaVersion":1,"importId":id,"notes":[note]});
        (directory,store,record,bundle)
    }

    fn write_notes(store: &Store, bundle: &Value) -> std::path::PathBuf {
        let directory=store.data_dir.join("imports-display-notes");
        std::fs::create_dir_all(&directory).unwrap();
        let path=directory.join(format!("{}.json",s(bundle,"importId")));
        std::fs::write(&path,serde_json::to_vec(bundle).unwrap()).unwrap();
        path
    }

    #[test]
    fn simulated_single_question_projection_retains_full_source_context_and_filters_other_questions() {
        let (_dir,store,mut record,bundle)=fixture();
        write_notes(&store,&bundle);
        let mut second=record["questions"][0].clone();
        second["questionId"]=json!("sim-display-q2");
        record["questions"].as_array_mut().unwrap().push(second);
        let all=projection(&store,&record);
        assert!(!rows(&all["sim-display-q1"]).is_empty());
        let one=projection_for_question(&store,&record,"sim-display-q1");
        assert_eq!(one,json!({"sim-display-q1":all["sim-display-q1"]}));
        assert_eq!(projection_for_question(&store,&record,"sim-display-q2"),json!({}));
        record["ocrSource"]["manifestSha256"]=json!("0".repeat(64));
        assert_eq!(projection_for_question(&store,&record,"sim-display-q1"),json!({}));
    }

    #[test]
    fn simulated_evidence_is_optional_read_only_and_never_approves_or_changes_raw_issues() {
        let (_dir,store,record,bundle)=fixture();
        assert_eq!(projection(&store,&record),json!({}));
        let mut supplied=record.clone();
        supplied["sourceCorrectionDisplays"]=bundle["notes"].clone();
        supplied["questions"][0]["sourceCorrectionDisplays"]=bundle["notes"].clone();
        assert_eq!(projection(&store,&supplied),json!({}));
        let path=write_notes(&store,&bundle);let bytes=std::fs::read(&path).unwrap();
        let before=record.clone();let eligibility=review::eligibility(&record);
        let result=projection(&store,&record);
        assert_eq!(result["sim-display-q1"].as_array().unwrap().len(),1);
        assert_eq!(result["sim-display-q1"][0]["status"],"corrected_pending_confirmation");
        assert_eq!(result["sim-display-q1"][0]["fieldPath"],"options[0].text");
        assert_eq!(result["sim-display-q1"][0]["issueMessage"],record["questions"][0]["modelReview"]["issues"][0]["message"]);
        assert!(result["sim-display-q1"][0].get("approved").is_none());
        assert_eq!(record,before);assert_eq!(store.document("imports",s(&record,"importId")).unwrap(),before);
        assert_eq!(review::eligibility(&record),eligibility);assert_eq!(eligibility["sim-display-q1"]["eligible"],false);
        assert_eq!(std::fs::read(path).unwrap(),bytes);
        let response=with_teaching_controls(&store,json!({"import":record.clone()}));
        assert_eq!(response["sourceCorrectionDisplays"],result);
        assert_eq!(response["import"],record);
        assert_eq!(with_teaching_controls(&store,json!({"imports":[]})),json!({"imports":[]}));
    }

    #[test]
    fn simulated_wrong_source_field_issue_or_authorization_binding_is_never_projected() {
        let (_dir,store,record,bundle)=fixture();
        for (key,value) in [
            ("sourceContentSha256",json!("a".repeat(64))),("sourceSha256",json!("a".repeat(64))),
            ("ocrManifestSha256",json!("a".repeat(64))),("fieldValueSha256",json!("a".repeat(64))),
            ("sourceBlockTextSha256",json!("a".repeat(64))),("sourcePageAssetSha256",json!("a".repeat(64))),
            ("issueSha256",json!("a".repeat(64))),("issueIndex",json!(1)),("issueField",json!("stem")),
            ("issueMessage",json!("任意模型说明不能充当绑定")),("questionId",json!("other-q")),
            ("fieldPath",json!("options.A.text")),("sourceBlockId",json!("p1-b2")),("evidencePage",json!(2)),
            ("method",json!("model_self_check")),("checkedBy",json!("teacher")),("status",json!("ready")),
            ("kind",json!("future_kind")),("checkedAt",json!("yesterday")),
        ] {
            let mut bad=bundle.clone();bad["notes"][0][key]=value;write_notes(&store,&bad);
            assert_eq!(projection(&store,&record),json!({}),"{key}");
        }
        let mut conflict=bundle.clone();conflict["notes"].as_array_mut().unwrap().push(bundle["notes"][0].clone());
        write_notes(&store,&conflict);assert_eq!(projection(&store,&record),json!({}));
    }

    #[test]
    fn simulated_new_source_version_or_review_issue_keeps_original_uncorrected_display() {
        let (_dir,store,record,bundle)=fixture();write_notes(&store,&bundle);
        for field in ["stem","answer"] {let mut changed=record.clone();changed["questions"][0][field]=json!("new value");assert_eq!(projection(&store,&changed),json!({}));}
        let mut changed=record.clone();changed["questions"][0]["modelReview"]["issues"][0]["message"]=json!("同字段上的另一个真实疑点");
        assert_eq!(projection(&store,&changed),json!({}));
        let mut changed=record.clone();changed["questions"][0]["modelReview"]["evidence"]["imageReviewAvailable"]=json!(false);
        assert_eq!(projection(&store,&changed),json!({}));
        // A changed record revision alone does not invalidate the same immutable
        // question: other questions may finish generation independently.
        let mut unrelated=record.clone();unrelated["revision"]=json!(3);assert!(projection(&store,&unrelated)["sim-display-q1"].is_array());
    }

    #[test]
    fn simulated_original_manifest_and_page_tampering_fail_closed() {
        for material in ["original","manifest","page"] {
            let (_dir,store,record,bundle)=fixture();write_notes(&store,&bundle);
            let relative=match material {"original"=>s(&record["source"],"relativePath"),"manifest"=>s(&record["ocrSource"],"manifestRelativePath"),_=>s(&record["ocrSource"]["assets"][0],"relativePath")};
            std::fs::write(store.data_dir.join(relative),b"tampered local bytes").unwrap();
            assert_eq!(projection(&store,&record),json!({}),"{material}");
        }
    }

    #[test]
    fn simulated_note_file_size_identity_and_path_escape_are_rejected() {
        let (_dir,store,record,bundle)=fixture();let path=write_notes(&store,&bundle);
        std::fs::write(&path,vec![b' ';MAX_NOTES_BYTES as usize+1]).unwrap();assert_eq!(projection(&store,&record),json!({}));
        std::fs::write(&path,b"{invalid json").unwrap();assert_eq!(projection(&store,&record),json!({}));
        let mut wrong=bundle.clone();wrong["importId"]=json!("sim-other-import");std::fs::write(&path,serde_json::to_vec(&wrong).unwrap()).unwrap();assert_eq!(projection(&store,&record),json!({}));
        let mut escaped=record.clone();escaped["importId"]=json!("../sim-source-display");assert_eq!(projection(&store,&escaped),json!({}));
    }

    fn raw_correction() -> Value {
        json!({"kind":"ocr_transcription","status":"corrected_pending_confirmation","fieldPath":"options[0].text",
            "sourceBlockId":"p1-b1","evidencePage":1,"ocrText":"x=","transcribedText":"x=2"})
    }

    fn opinion(correction: Option<Value>) -> Value {
        let mut issue=json!({"field":"options.A.text","message":"模拟OCR识别差异需核对"});
        if let Some(correction)=correction {issue["correction"]=correction;}
        json!({"questions":[{"questionId":"sim-display-q1","status":"ready","confidence":"medium","summary":"模拟同次来源转录，保留具体修正待确认。","issues":[issue],"evidencePages":[1]}]})
    }

    fn audited_model_fixture() -> (tempfile::TempDir,Store,Value,Value) {
        let (dir,store,mut record,mut bundle)=fixture();
        let mut question=record["questions"][0].clone();
        let raw=opinion(Some(raw_correction()));
        let mut normalized=review::normalize_opinion(&raw,&question,&record,true).unwrap();
        let raw_question=json!({"sourceLabel":question["sourceLabel"],"pages":question["pages"],"review":raw["questions"][0]});
        let provider=json!({"choices":[{"message":{"content":json!({"questions":[raw_question]}).to_string()}}]});
        let response=store.data_dir.join("imports/sim-source-display/model.response.json");
        let response_bytes=serde_json::to_vec(&provider).unwrap();std::fs::write(&response,&response_bytes).unwrap();
        let identity=json!({"profileId":null,"name":null,"model":null,"baseUrl":null,"reasoningEffort":null,"identityEvidence":{"kind":"unavailable"}});
        let request=json!({"task":"question_import","origin":"import","context":{"sourceSha256":record["source"]["sha256"]},
            "contentSha256":normalized["contentSha256"],"evidence":normalized["evidence"],"model":identity,
            "responseQuestionIndex":0,"responseQuestionSha256":hash_json(&raw_question)});
        let request_path=response.with_extension("request.json");let request_bytes=serde_json::to_vec(&request).unwrap();
        std::fs::write(&request_path,&request_bytes).unwrap();
        normalized["origin"]=json!("import");normalized["model"]=identity;
        normalized["audit"]=json!({"task":"question_import","origin":"import","relativePath":audit_relative_path(&store,&response).unwrap(),
            "sha256":sha(&response_bytes),"requestRelativePath":audit_relative_path(&store,&request_path).unwrap(),"requestSha256":sha(&request_bytes),
            "responseQuestionIndex":0,"responseQuestionSha256":hash_json(&raw_question)});
        question["modelReview"]=normalized;record["questions"][0]=question;
        store.put_document("imports",s(&record,"importId"),&record).unwrap();
        bundle["notes"][0]["issueSha256"]=json!(hash_json(&record["questions"][0]["modelReview"]["issues"][0]));
        (dir,store,record,bundle)
    }

    #[test]
    fn simulated_optional_correction_keeps_legacy_json_and_never_changes_ready_gate() {
        let (_dir,store,record,_bundle)=fixture();let question=&record["questions"][0];
        let mut legacy=review::normalize_opinion(&opinion(None),question,&record,true).unwrap();
        assert_eq!(legacy["issues"][0],json!({"field":"options.A.text","message":"模拟OCR识别差异需核对"}));
        assert_eq!(legacy["issues"][1]["field"],"source","existing hard source findings remain visible");
        assert!(legacy["issues"].as_array().unwrap().iter().all(|issue|issue.get("correction").is_none()));
        assert_eq!(legacy["status"],"needs_review");
        legacy.as_object_mut().unwrap().remove("reviewedAt");
        for correction in [Value::Null,json!({}),json!({"status":"ready","kind":"ocr_transcription"})] {
            let mut normalized=review::normalize_opinion(&opinion(Some(correction)),question,&record,true).unwrap();
            normalized.as_object_mut().unwrap().remove("reviewedAt");assert_eq!(normalized,legacy);
        }
        let normalized=review::normalize_opinion(&opinion(Some(raw_correction())),question,&record,true).unwrap();
        assert_eq!(normalized["status"],"needs_review");assert!(normalized["issues"][0]["correction"].is_object());
        assert_eq!(normalized["issues"][0]["correction"]["sourceContentSha256"],review::content_hash(question));
        let mut changed=record.clone();changed["questions"][0]["modelReview"]=normalized;
        assert!(!review::model_ready(&changed["questions"][0],&changed));
        assert_eq!(review::eligibility(&changed)["sim-display-q1"]["eligible"],false);
        assert_eq!(store.document("imports",s(&record,"importId")).unwrap(),record);
    }

    #[test]
    fn simulated_forged_model_correction_fragments_pages_blocks_or_paths_do_not_get_display() {
        let (_dir,_store,record,_bundle)=fixture();let question=&record["questions"][0];
        for (field,value) in [
            ("ocrText",json!("missing OCR fragment")),("transcribedText",json!("x=200")),
            ("ocrText",json!("")),("transcribedText",json!("x=")),("sourceBlockId",json!("p1-b99")),
            ("evidencePage",json!(2)),("fieldPath",json!("options.A.text")),("fieldPath",json!("../../stem")),
        ] {
            let mut bad=raw_correction();bad[field]=value;
            let normalized=review::normalize_opinion(&opinion(Some(bad)),question,&record,true).unwrap();
            assert!(normalized["issues"][0].get("correction").is_none(),"{field}");
            assert_eq!(normalized["status"],"needs_review");assert_eq!(normalized["issues"].as_array().unwrap().len(),2);
            assert_eq!(normalized["issues"][1]["field"],"source","invalid optional metadata never removes a hard source issue");
        }
        assert!(normalize_model_correction(&raw_correction(),question,&record,false).is_none());
        // Mere OCR/model prose and supplied program hashes are not evidence.
        let mut bad=raw_correction();bad["sourceContentSha256"]=json!("f".repeat(64));
        let normalized=normalize_model_correction(&bad,question,&record,true).unwrap();
        assert_eq!(normalized["sourceContentSha256"],review::content_hash(question));
        let mut only_record=record.clone();only_record["questions"][0]["modelReview"]["issues"][0]["correction"]=normalized;
        assert_eq!(projection(&_store,&only_record),json!({}),"unaudited client metadata cannot create a model correction display");
    }

    #[test]
    fn simulated_same_response_correction_requires_preserved_audit_and_agent_note_takes_priority() {
        let (_dir,store,record,bundle)=audited_model_fixture();
        let before=record.clone();let result=projection(&store,&record);
        assert_eq!(result["sim-display-q1"][0]["method"],"model_review");
        assert_eq!(result["sim-display-q1"][0]["checkedBy"],"模型");
        assert_eq!(result["sim-display-q1"][0]["status"],"corrected_pending_confirmation");
        assert!(s(&result["sim-display-q1"][0],"basis").contains("待用户确认"));
        assert!(review::verify_opinion(&store,&record["questions"][0],&record).is_err(),"display validation is never publication approval");
        write_notes(&store,&bundle);
        let preferred=projection(&store,&record);assert_eq!(preferred["sim-display-q1"].as_array().unwrap().len(),1);
        assert_eq!(preferred["sim-display-q1"][0]["method"],"user_authorized_agent_review");
        assert_eq!(store.document("imports",s(&record,"importId")).unwrap(),before);
    }

    #[test]
    fn simulated_tampered_model_correction_and_request_or_response_are_never_displayed() {
        for changed in ["stored_correction","request","response"] {
            let (_dir,store,mut record,_bundle)=audited_model_fixture();
            if changed=="stored_correction" { record["questions"][0]["modelReview"]["issues"][0]["correction"]["kind"]=json!("transcription_adjustment"); }
            else {
                let key=if changed=="request" {"requestRelativePath"} else {"relativePath"};
                std::fs::write(store.data_dir.join(s(&record["questions"][0]["modelReview"]["audit"],key)),b"tampered model audit").unwrap();
            }
            assert_eq!(projection(&store,&record),json!({}),"{changed}");
        }
    }
}
