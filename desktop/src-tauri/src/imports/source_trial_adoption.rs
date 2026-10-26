//! Explicit source-only adoption of individually reviewed, complete trial output.
//! No model calls, publication, whole-paper completion claims, or real personal DB.
use super::*;
use crate::ocr::OcrDocument;
use std::collections::{BTreeMap, BTreeSet};

const VERSION: &str = "source-trial-adoption-v1";
fn invalid(message: &str) -> AppError { err("source_trial_adoption_invalid", message) }
fn guard(store: &Store) -> AppResult<()> {
    let p = store.data_dir.join("explicit-publication-runtime.json");
    let marker: Value = serde_json::from_slice(&std::fs::read(p)?)?;
    if marker["purpose"] != "user_authorized_teaching_publication"
        || marker["formalPersonalDatabaseOpened"] != false {
        return Err(invalid("仅允许明确标记的复制隔离发布目录。"));
    }
    Ok(())
}
fn read_bound(store: &Store, relative: &str, files: &mut BTreeMap<String,String>) -> AppResult<Value> {
    let rel = Path::new(relative);
    if rel.is_absolute() || rel.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
        return Err(invalid("来源证据路径不是受限相对路径。"));
    }
    let root = store.data_dir.canonicalize()?;
    let path = root.join(rel).canonicalize()?;
    if !path.starts_with(&root) || std::fs::metadata(&path)?.len() > 64*1024*1024 {
        return Err(invalid("来源证据越界或过大。"));
    }
    let bytes = std::fs::read(path)?;
    files.insert(relative.to_owned(), sha(&bytes));
    serde_json::from_slice(&bytes).map_err(|_| invalid("来源证据不是完整JSON。"))
}
fn ids_set(v: &Value) -> AppResult<BTreeSet<String>> {
    let a = v.as_array().ok_or_else(||invalid("缺少原块身份数组。"))?;
    let ids = a.iter().map(|x|x.as_str().map(str::to_owned)).collect::<Option<Vec<_>>>()
        .ok_or_else(||invalid("原块身份格式无效。"))?;
    let set:BTreeSet<_> = ids.into_iter().collect();
    if set.len()!=a.len() { return Err(invalid("原块身份重复。")); }
    Ok(set)
}
fn complete_raw(store:&Store, directory:&str, task:&str, document:&OcrDocument,
    context_extra:Option<&Value>, source_sha:&str, manifest_sha:&str,
    files:&mut BTreeMap<String,String>) -> AppResult<Value> {
    let candidate=read_bound(store,&format!("{directory}/candidate.json"),files)?;
    let response=read_bound(store,&format!("{directory}/response.json"),files)?;
    let transport=read_bound(store,&format!("{directory}/transport.json"),files)?;
    let request=read_bound(store,&format!("{directory}/request.json"),files)?;
    if response["httpStatus"]!=200 || response["choices"][0]["finish_reason"]!="stop"
        || transport["status"]!="completed" || transport["task"]!=task
        || request["task"]!=task || request["bodySha256"]!=hash_json(&request["body"])
        || request["body"]["model"]!="deepseek-flash"
        || request["body"]["thinking"]["type"]!="enabled"
        || request["body"]["reasoning_effort"]!="low" {
        return Err(invalid("只采纳实际完整stop的原始低思考来源响应。"));
    }
    let returned:Value=serde_json::from_str(s(&response["choices"][0]["message"],"content"))
        .map_err(|_|invalid("原响应正文不是完整JSON。"))?;
    if returned!=candidate { return Err(invalid("候选与真实原始响应不一致。")); }
    let content=request["body"]["messages"][1]["content"].as_array()
        .ok_or_else(||invalid("原请求缺少图文输入。"))?;
    let actual:Value=serde_json::from_str(s(content.first().unwrap_or(&Value::Null),"text"))
        .map_err(|_|invalid("原请求正文无法核对。"))?;
    let mut expected=whole_transcription_trial::build(document,source_sha,manifest_sha)?["context"].clone();
    expected["includeSourcePagesForReview"]=json!(true);
    if let Some(spec)=context_extra {
        expected["sourceScope"]=json!("student_only_batch");
        expected["sourceBatch"]=spec.clone();
    }
    if actual!=expected || content.len()!=1+2*document.assets.len() {
        return Err(invalid("原请求不是精确对应的原块和素材。"));
    }
    for (i,asset) in document.assets.iter().enumerate() {
        let label:Value=serde_json::from_str(s(&content[1+2*i],"text"))
            .map_err(|_|invalid("原请求素材标签无效。"))?;
        let url=s(&content[2+2*i]["image_url"],"url");
        let bytes=base64::engine::general_purpose::STANDARD.decode(
            url.strip_prefix("data:image/png;base64,").ok_or_else(||invalid("原请求图片不是实际PNG。"))?)
            .map_err(|_|invalid("原请求图片编码无效。"))?;
        if label["assetId"]!=asset["id"] || label["page"]!=asset["page"]
            || sha(&bytes)!=asset["sha256"] {
            return Err(invalid("原请求图片与已保存OCR身份/哈希不一致。"));
        }
    }
    Ok(candidate)
}
fn compact_question(raw:&Value, id:&str, page_count:usize)->AppResult<Value> {
    let mut q=raw.clone();
    if s(raw,"answer")!="" || s(raw,"solution")!="" { return Err(invalid("学生原稿不能含补造的答案解析。")); }
    let options=raw["options"].as_array().ok_or_else(||invalid("缺少选项数组。"))?;
    let mut converted=vec![];
    for row in options {
        let row=row.as_array().filter(|r|r.len()==2 && r.iter().all(Value::is_string))
            .ok_or_else(||invalid("选项必须为两列原文。"))?;
        converted.push(json!({"label":row[0],"text":row[1]}));
    }
    q["options"]=json!(converted);
    let mut parts=vec![];
    for (i,row) in raw["parts"].as_array().ok_or_else(||invalid("缺少小问数组。"))?.iter().enumerate() {
        let row=row.as_array().filter(|r|r.len()==4 && r.iter().all(Value::is_string))
            .ok_or_else(||invalid("小问必须为四列原文。"))?;
        if row[2]!="" || row[3]!="" { return Err(invalid("学生原稿小问不能含补造答案解析。")); }
        parts.push(json!({"partId":format!("p{}",i+1),"label":row[0],"prompt":row[1],"answer":"","solution":""}));
    }
    q["parts"]=json!(parts);q["knowledgeSchemaVersion"]=json!(2);
    q["primaryKnowledgeUids"]=json!([]);q["solutionPaths"]=json!([]);
    q["difficultyAssessment"]=json!({"level":null,"basis":""});
    normalize_question_inner(&q,id,page_count,false)
}
fn projection(q:&Value)->Value {
    let fields=["questionId","questionType","stem","options","parts","answer","solution","sourceLabel","pages",
        "sourceIdentity","sourceBlockIds","sourceMaterialRoles","sourceMaterialRequirements","student","teacher","assetPayloads",
        "knowledgeSchemaVersion","primaryKnowledgeUids","solutionPaths","difficultyAssessment"];
    let mut o=serde_json::Map::new();for field in fields {o.insert(field.to_owned(),q[field].clone());}Value::Object(o)
}
fn reconstruct(store:&Store,record:&Value,selections:&Value)->AppResult<(Vec<Value>,Value)> {
    read_source(store,record)?;
    let original=paddle::load_document(store,record)?;
    let mut files=BTreeMap::new();
    let selected=read_bound(store,"index-batch-trial/student-page-selection.json",&mut files)?;
    let pages=selected["studentOnlyPages"].as_array().and_then(|a|a.iter().map(Value::as_u64).collect::<Option<Vec<_>>>())
        .ok_or_else(||invalid("学生页证据无效。"))?;
    let document=whole_transcription_trial::select_student_pages(&original,&pages)?;
    let source_sha=s(&record["source"],"sha256");let manifest_sha=s(&record["ocrSource"],"manifestSha256");
    let plan=complete_raw(store,"index-batch-trial/index","question_import_index_trial",&document,None,source_sha,manifest_sha,&mut files)?;
    if index_batch_trial::validate_plan(&plan,&document)?["valid"]!=true {return Err(invalid("原始索引未通过来源身份核验。"));}
    let specs=index_batch_trial::batch_spec(&plan,&document)?;
    if read_bound(store,"index-batch-trial/batch-specs.json",&mut files)?!=json!(specs) {return Err(invalid("批次范围与原索引不一致。"));}
    let selections=selections.as_array().filter(|a|!a.is_empty()&&a.len()<=MAX_QUESTIONS).ok_or_else(||invalid("缺少逐题核验白名单。"))?;
    let mut seen=BTreeSet::new();let mut output=vec![];let mut canonical=vec![];
    let mut batches=BTreeMap::new();
    for selection in selections {
        let global=selection["globalIndex"].as_u64().ok_or_else(||invalid("缺少全卷题位。"))? as usize;
        let batch=selection["batchIndex"].as_u64().ok_or_else(||invalid("缺少原批次。"))? as usize;
        let local=selection["localIndex"].as_u64().ok_or_else(||invalid("缺少批次题位。"))? as usize;
        if !seen.insert(global) || s(selection,"reviewBasis").trim().is_empty() {return Err(invalid("题位重复或缺少实际核验依据。"));}
        let spec=specs.get(batch).ok_or_else(||invalid("批次越界。"))?;
        let expected=spec["expectedQuestions"].as_array().and_then(|a|a.get(local)).ok_or_else(||invalid("批次题位越界。"))?;
        if expected["globalQuestionIndex"]!=global {return Err(invalid("全卷与批次题位不匹配。"));}
        let evidence=&selection["sourceReviewEvidence"];
        let relative=s(evidence,"auditRelativePath");
        if !relative.starts_with(&format!("imports/{}/",s(record,"importId"))) {return Err(invalid("独立核对证据须在本来源受限目录。"));}
        read_bound(store,relative,&mut files)?;
        if files.get(relative).map(String::as_str)!=Some(s(evidence,"auditSha256")) {return Err(invalid("独立核对证据哈希不一致。"));}
        if !batches.contains_key(&batch) {
            let dir=format!("index-batch-trial/batches/batch-{batch:03}");
            if read_bound(store,&format!("{dir}/spec.json"),&mut files)?!=*spec {return Err(invalid("批次原始范围被修改。"));}
            let sub=index_batch_trial::subset_document(&document,spec)?;
            let raw=complete_raw(store,&dir,"question_import_batch_trial",&sub,Some(spec),source_sha,manifest_sha,&mut files)?;
            batches.insert(batch,raw);
        }
        let raw=&batches[&batch];
        let raw_q=raw["questions"].as_array().and_then(|a|a.get(local)).ok_or_else(||invalid("原响应没有此整题。"))?;
        let candidate_relative=format!("index-batch-trial/batches/batch-{batch:03}/candidate.json");
        if files.get(&candidate_relative).map(String::as_str)!=Some(s(selection,"candidateFileSha256"))
            || selection["rawQuestionSha256"]!=hash_json(raw_q)
            || raw_q["sourceLabel"]!=expected["sourceLabel"] || raw_q["questionType"]!=expected["questionType"]
            || ids_set(&raw_q["sourceBlockIds"])?!=ids_set(&expected["sourceBlockIds"])?
            || raw_q["pages"]!=evidence["sourcePages"] {return Err(invalid("逐题核验未精确绑定当前原响应和来源身份。"));}
        let expected_assets=ids_set(&expected["assetIds"])?;let mut represented=BTreeSet::new();let mut roles=vec![];
        for role in rows(&raw["materialRoles"]) {
            let aid=s(&role,"assetId");
            if !expected_assets.contains(aid) {continue;}
            if role["role"]!="student" || !rows(&role["questionIndices"]).iter().any(|n|*n==local) {
                return Err(invalid("必要素材归属仍未确定，未静默丢弃或改写。"));
            }
            represented.insert(aid.to_owned());roles.push(role);
        }
        if represented!=expected_assets {return Err(invalid("必要素材未完整保留。"));}
        let mut proposed=raw_q.clone();proposed["materialRoles"]=json!(roles);
        let id=format!("{}-q{}",s(record,"importId"),global+1);
        let display_spec=&evidence["displayNormalization"];
        let adapted=if display_spec.is_object(){Some(super::source_display_adapter::adapt(raw_q,display_spec)?)}else{None};
        let mut q=compact_question(adapted.as_ref().unwrap_or(raw_q),&id,record["source"]["physicalPages"].as_u64().unwrap_or(0) as usize)?;
        paddle::bind(&mut q,&proposed,&document,source_sha,manifest_sha)?;
        q["reviewDecision"]=json!("pending");q["mappingConfirmed"]=json!(false);
        let mut canonical_entry=json!({"globalIndex":global,"questionId":id,"sourceProjectionSha256":hash_json(&projection(&q))});
        if let Some(adapted)=adapted {canonical_entry["displayNormalization"]=json!({"spec":display_spec,"rawQuestionSha256":hash_json(raw_q),"adaptedQuestionSha256":hash_json(&adapted),"mathematicalContentChanged":false});}
        canonical.push(canonical_entry);output.push(q);
    }
    Ok((output,json!({"version":VERSION,"sourceSha256":source_sha,"manifestSha256":manifest_sha,"planQuestionCount":rows(&plan["questions"]).len(),"selectedQuestionCount":selections.len(),"files":files.iter().map(|(p,h)|json!({"relativePath":p,"sha256":h})).collect::<Vec<_>>(),"canonical":canonical,"wholePaperCompletedClaimed":false})))
}
pub(super) fn audit_hash(record:&Value)->Value {json!(hash_json(&record["sourceTrialAdoption"]))}
pub(super) fn verify(store:&Store,record:&Value)->AppResult<()> {
    guard(store)?;let adoption=&record["sourceTrialAdoption"];
    if adoption["version"]!=VERSION || adoption["sourceSha256"]!=record["source"]["sha256"]
        || adoption["manifestSha256"]!=record["ocrSource"]["manifestSha256"] || s(&adoption["authorization"],"request").trim().is_empty() {
        return Err(invalid("采纳证据未绑定当前授权与原卷。"));
    }
    let (replayed,proof)=reconstruct(store,record,&adoption["questions"])?;
    if adoption["proof"]!=proof {return Err(invalid("采纳来源或转换证据已变化。"));}
    let current=rows(&record["questions"]);let mut seen=BTreeSet::new();
    if current.is_empty() {return Err(invalid("没有可核对的已采纳整题。"));}
    for q in &current {
        if !seen.insert(s(q,"questionId")) || !replayed.iter().any(|r|r["questionId"]==q["questionId"] && projection(r)==projection(q)) {
            return Err(invalid("采纳题面不是原白名单的未修改子集。"));
        }
    }
    Ok(())
}
pub fn stage(store:&Store,payload:&Value)->AppResult<Value> {
    guard(store)?;
    let keys=["importId","expectedRevision","operationId","authorization","sourceSha256","manifestSha256","questions"];
    if !payload.as_object().is_some_and(|o|o.len()==keys.len()&&keys.iter().all(|k|o.contains_key(*k)))
        || s(&payload["authorization"],"request").trim().is_empty() {return Err(invalid("缺少明确授权和精确逐题采纳清单。"));}
    let op=operation(payload)?;let hash=hash_json(payload);let mut record=store.document("imports",s(payload,"importId"))?;
    if replay(&record,op,&hash)? {verify(store,&record)?;return Ok(json!({"import":record,"replayed":true,"modelCalls":0}));}
    revision(&record,payload)?;
    if !rows(&record["questions"]).is_empty() || !rows(&record["publishedQuestionIds"]).is_empty()
        || record["sourceTrialAdoption"].is_object() || payload["sourceSha256"]!=record["source"]["sha256"]
        || payload["manifestSha256"]!=record["ocrSource"]["manifestSha256"] {return Err(invalid("只允许未采纳的复制来源，未覆盖旧题或发布结果。"));}
    let (questions,proof)=reconstruct(store,&record,&payload["questions"])?;
    let before=record.clone();record["questions"]=json!(questions);
    record["sourceTrialAdoption"]=json!({"version":VERSION,"authorization":payload["authorization"],"sourceSha256":payload["sourceSha256"],"manifestSha256":payload["manifestSha256"],"questions":payload["questions"],"proof":proof});
    record["status"]=json!("pending_review");record["error"]=Value::Null;
    finish(&mut record,op,&hash,"source_trial_adoption");verify(store,&record)?;
    save_cas(store,Some(&before),&record)?;
    Ok(json!({"import":record,"auditSha256":audit_hash(&record),"modelCalls":0,"published":false}))
}

/// An actual, explicitly recorded source review can resolve an OCR layout
/// warning. Missing content, assets, and all other defects remain blocking.
/// Called only after the publication source proof and agent report are verified.
pub(super) fn acknowledged_layout_issues(q:&Value,record:&Value,issues:Vec<Value>)->Vec<Value> {
    let review=&q["agentReview"]["review"];
    let acknowledged=rows(&review["checks"]["sourceMatched"]["acknowledgedSourceIssueHashes"]);
    if record["sourceTrialAdoption"]["version"]!=VERSION
        || q["agentReview"]["method"]!="user_authorized_agent_review"
        || review["result"]!="pass" || review["checks"]["sourceMatched"]["result"]!="pass" {
        return issues;
    }
    let reviewed_pages=rows(&review["sourcePages"]);
    issues.into_iter().filter(|issue| {
        !(issue["code"]=="ocr_reading_order_uncertain"
            && reviewed_pages.contains(&issue["page"])
            && acknowledged.contains(&json!(hash_json(issue))))
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn raw()->Value {json!({"questionType":"single_choice","sourceLabel":"1","pages":[1],"stem":"模拟原题 $x+1$","options":[["A","1"],["B","2"]],"parts":[["(1)","原小问","",""]],"answer":"","solution":""})}
    #[test] fn compact_preserves_labels_but_uses_real_global_identity_and_empty_metadata() {
        let q=compact_question(&raw(),"import-simulated-q11",1).unwrap();
        assert_eq!(q["sourceLabel"],"1");assert_eq!(q["questionId"],"import-simulated-q11");
        assert_eq!(q["options"][0],json!({"label":"A","text":"1"}));
        assert_eq!(q["parts"][0]["label"],"(1)");assert_eq!(q["primaryKnowledgeUids"],json!([]));
        assert_eq!(q["difficultyAssessment"]["level"],Value::Null);
    }
    #[test] fn compact_rejects_answer_invention_and_truncated_rows() {
        let mut q=raw();q["answer"]=json!("A");assert!(compact_question(&q,"q1",1).is_err());
        let mut q=raw();q["parts"][0][2]=json!("新增解答");assert!(compact_question(&q,"q1",1).is_err());
        let mut q=raw();q["options"][0]=json!(["A"]);assert!(compact_question(&q,"q1",1).is_err());
    }
    #[test] fn source_projection_allows_review_state_but_never_changed_content() {
        let q=compact_question(&raw(),"q1",1).unwrap();let mut reviewed=q.clone();
        reviewed["reviewDecision"]=json!("approve");reviewed["agentReview"]=json!({"method":"codex"});
        assert_eq!(projection(&q),projection(&reviewed));reviewed["stem"]=json!("改题");
        assert_ne!(projection(&q),projection(&reviewed));
    }
    #[test] fn evidence_paths_are_confined_and_file_mutations_change_replay_proof() {
        let directory=tempfile::tempdir().unwrap();
        let store=Store::open(directory.path(),&crate::bank::tests::seed()).unwrap();
        std::fs::create_dir_all(directory.path().join("imports/simulated")).unwrap();
        let path=directory.path().join("imports/simulated/evidence.json");
        std::fs::write(&path,b"{\"review\":1}").unwrap();
        let mut before=BTreeMap::new();
        read_bound(&store,"imports/simulated/evidence.json",&mut before).unwrap();
        assert!(read_bound(&store,"../outside.json",&mut BTreeMap::new()).is_err());
        assert!(read_bound(&store,path.to_str().unwrap(),&mut BTreeMap::new()).is_err());
        std::fs::write(&path,b"{\"review\":2}").unwrap();
        let mut after=BTreeMap::new();
        read_bound(&store,"imports/simulated/evidence.json",&mut after).unwrap();
        assert_ne!(before,after);
    }
    #[test] fn explicit_layout_ack_is_exact_and_never_waives_missing_content() {
        let warning=json!({"code":"ocr_reading_order_uncertain","page":3,"blocking":true});
        let missing=json!({"code":"ocr_asset_missing","page":3,"blocking":true});
        let record=json!({"sourceTrialAdoption":{"version":VERSION}});
        let mut q=json!({"agentReview":{"method":"user_authorized_agent_review","review":{"result":"pass","sourcePages":[3],"checks":{"sourceMatched":{"result":"pass","acknowledgedSourceIssueHashes":[hash_json(&warning),hash_json(&missing)]}}}}});
        assert_eq!(acknowledged_layout_issues(&q,&record,vec![warning.clone(),missing.clone()]),vec![missing]);
        q["agentReview"]["review"]["sourcePages"]=json!([2]);
        assert_eq!(acknowledged_layout_issues(&q,&record,vec![warning.clone()]),vec![warning.clone()]);
        q["agentReview"]["method"]=json!("model_review");
        assert_eq!(acknowledged_layout_issues(&q,&record,vec![warning.clone()]),vec![warning]);
    }

}
