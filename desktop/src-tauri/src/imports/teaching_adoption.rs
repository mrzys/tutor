//! Explicit adoption of already completed, independently reviewed model output.
//! No HTTP, source edits, quota reset or personal-data migration is performed.
use super::*;

fn external_file(spec: &Value) -> AppResult<(Vec<u8>, Value)> {
    let path = Path::new(s(spec, "path"));
    if !path.is_absolute() || std::fs::metadata(path)?.len() > 45 * 1024 * 1024 {
        return Err(err("invalid_teaching_adoption", "外部教学稿证据路径或大小无效。"));
    }
    let bytes = std::fs::read(path)?;
    if spec["sha256"] != sha(&bytes) {
        return Err(err("teaching_audit_changed", "外部教学稿证据已变化。"));
    }
    let value = serde_json::from_slice(&bytes)?;
    Ok((bytes, value))
}

fn unwrap_body(request: &Value) -> &Value {
    if request["body"].is_object() { &request["body"] } else { request }
}

fn same_material(question: &Value, body: &Value) -> AppResult<String> {
    let context: Value = serde_json::from_str(s(&body["messages"][1], "content"))?;
    let material = if context["originalMaterial"].is_object() {
        context["originalMaterial"].clone()
    } else if context["questions"].is_array() {
        rows(&context["questions"]).into_iter().find(|q| q["questionId"] == question["questionId"]).unwrap_or(Value::Null)
    } else { context };
    if material["questionId"] != question["questionId"] {
        return Err(err("teaching_source_changed", "外部模型请求未绑定此题。"));
    }
    for (input, source) in [("questionType","questionType"),("stem","stem"),("options","options"),("parts","parts"),
        ("referenceAnswer","answer"),("referenceSolution","solution"),("sourceIdentity","sourceIdentity")] {
        if material[input] != question[source] {
            return Err(err("teaching_source_changed", "候选请求中的题面或参考与当前原题不一致。"));
        }
    }
    if material["sourceIssues"] != question["sourceIssues"] {
        return Err(err("teaching_source_changed", "候选请求未保留当前来源疑点。"));
    }
    if material["visuals"] != question["student"]["assets"] {
        return Err(err("teaching_source_changed", "候选请求的配图身份与原题不一致。"));
    }
    Ok(if body["messages"][1]["content"].as_str().is_some_and(|_| material.is_object()) {
        // Actual response shape, not caller assertions, selects generation vs review below.
        hash_json(&material)
    } else { String::new() })
}

/// The report is explicit user-authorized agent evidence, not teacher approval.
pub fn adopt(store: &Store, payload: &Value) -> AppResult<Value> {
    let op = operation(payload)?;
    let request_hash = hash_json(payload);
    if s(&payload["authorization"], "request").trim().is_empty() {
        return Err(err("review_required", "缺少本次明确授权。"));
    }
    let mut record = store.document("imports", s(payload, "importId"))?;
    if replay(&record, op, &request_hash)? { return Ok(json!({"import":record,"replayed":true})); }
    revision(&record, payload)?;
    if record["pendingPublication"].is_object()
        || matches!(s(&record["backgroundJob"],"status"),"queued"|"running") {
        return Err(err("publication_pending", "请先完成原发布操作。"));
    }
    paddle::verify_audit(store, &record)?;
    let entries = payload["entries"].as_array().filter(|a| !a.is_empty() && a.len() <= MAX_QUESTIONS)
        .ok_or_else(||err("invalid_teaching_adoption", "缺少精确候选清单。"))?;
    let saved = record.clone();
    let mut questions = rows(&record["questions"]);
    let mut seen = HashSet::new();
    let mut prepared = vec![];
    for entry in entries {
        let id = s(entry, "questionId");
        if !seen.insert(id) || ids(&record["publishedQuestionIds"]).iter().any(|q|q==id) {
            return Err(err("invalid_teaching_adoption", "重复题或已发布题不能再次采纳。"));
        }
        let index = questions.iter().position(|q|q["questionId"]==id)
            .ok_or_else(||err("invalid_teaching_adoption", "题目不属于本次原卷。"))?;
        let q = &questions[index];
        chrono::DateTime::parse_from_rfc3339(s(entry,"completedAt"))
            .map_err(|_|err("invalid_teaching_adoption", "缺少原模型实际完成时间。"))?;
        if entry["expectedQuestionSha256"] != hash_json(q) {
            return Err(err("revision_conflict", "候选采纳的原题版本已变化。"));
        }
        let (_, request) = external_file(&entry["requestFile"])?;
        let (response_bytes, response) = external_file(&entry["responseFile"])?;
        let (_, evidence) = external_file(&entry["independentAuditFile"])?;
        let body = unwrap_body(&request);
        if request.get("body").is_some() && (request["redacted"] != false
            || request["bodySha256"] != hash_json(body)
            || request["promptSha256"] != hash_json(&body["messages"][0]["content"])) {
            return Err(err("teaching_audit_changed", "原请求封装缺失或哈希不一致。"));
        }
        let material_hash = same_material(q, body)?;
        // Historical Rust response audits intentionally omitted the provider's
        // model field. Preserve that absence; model identity still comes from
        // the exact actual request, never a fabricated response field.
        if response["choices"][0]["finish_reason"] != "stop"
            || body["model"].as_str().is_none_or(|m|m.is_empty()||m.len()>200)
            || response.get("model").is_some_and(|m|m!=&body["model"])
            || response.get("httpStatus").is_some_and(|s|s!=200)
        {
            return Err(err("invalid_teaching_adoption", "实际模型响应未完整完成或模型身份不符。"));
        }
        let parsed: Value = serde_json::from_str(s(&response["choices"][0]["message"], "content"))?;
        let context: Value=serde_json::from_str(s(&body["messages"][1],"content"))?;
        let (candidate, task) = if parsed["questions"].is_array() {
            (rows(&parsed["questions"]).into_iter().find(|c|c["questionId"]==id).unwrap_or(Value::Null), "question_import_teaching_generation")
        } else if context["patchContract"].is_object() {
            let declared=&context["patchContract"]["sourceContentSha256"];
            let expected_source=if *declared==review::content_hash(q) {review::content_hash(q)}
                else if context["originalMaterial"]==teaching::material(q) && *declared==material_hash {material_hash.clone()}
                else {return Err(err("teaching_source_changed","外部受限补丁的来源域不匹配。"));};
            (teaching::decode_review_candidate(id,&expected_source,&context,&parsed)?,"question_import_teaching_review")
        } else { (parsed, "question_import_teaching_review") };
        teaching::validate(&candidate, id)?;
        if entry["candidateSha256"] != hash_json(&candidate) {
            return Err(err("teaching_audit_changed", "候选稿与实际模型响应不一致。"));
        }
        let samples = if evidence["samples"].is_array() { rows(&evidence["samples"]) } else { rows(&evidence["entries"]) };
        let audit = samples.iter().find(|a| a["questionId"]==id && a["candidateSha256"]==entry["candidateSha256"])
            .ok_or_else(||err("review_required", "缺少绑定此实际候选的独立核查。"))?;
        if audit["correctAnswer"] != true || audit["proofComplete"] != true || audit["materialProblem"] != false {
            return Err(err("review_required", "数学或材料尚未核对通过，不能采纳此稿。"));
        }
        let stem = format!("teaching-adopt-{}", &hash_json(&json!([op,id]))[..24]);
        let directory = store.data_dir.join("imports").join(s(&record,"importId")).join(stem);
        let envelope = json!({"schemaVersion":1,"task":task,"body":body,"bodySha256":hash_json(body),
            "promptSha256":hash_json(&body["messages"][0]["content"]),"redacted":false,
            "externalEvidence":{"requestFile":entry["requestFile"],"responseFile":entry["responseFile"],
                "independentAuditFile":entry["independentAuditFile"],"materialSha256":material_hash,
                "providerModelReported":response.get("model").is_some(),
                "method":"user_authorized_agent_review","checkedBy":"codex"}});
        prepared.push((index,candidate,task,directory,envelope,response_bytes,audit.clone(),entry.clone()));
    }
    // All semantic input/hash checks finish before any import record mutation.
    for (index,candidate,task,directory,envelope,response_bytes,audit,entry) in prepared {
        std::fs::create_dir_all(&directory)?;
        let request_path = directory.join("request.json");
        let response_path = directory.join("response.json");
        let request_bytes = serde_json::to_vec_pretty(&envelope)?;
        // A crash before the record CAS can leave a partial audit directory.
        // Resume only byte-identical evidence; never overwrite either file.
        for (path,bytes) in [(&request_path,request_bytes.as_slice()),(&response_path,response_bytes.as_slice())] {
            if path.exists() {
                if std::fs::read(path)? != bytes { return Err(err("operation_conflict", "原采纳证据与重试不一致。")); }
            } else {
                let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(path)?;
                file.write_all(bytes)?;file.sync_all()?;
            }
        }
        let relative = |p:&Path| p.strip_prefix(&store.data_dir).unwrap().to_string_lossy().replace('\\',"/");
        let q = &mut questions[index];
        let source_hash = review::content_hash(q);
        let previous = q["teachingWorkflow"].clone();
        let wf = &mut q["teachingWorkflow"];
        // A new actual response cannot inherit acknowledgements or manual
        // patches bound to a different previous candidate. Archive them below.
        wf["manualPatchHistory"] = json!([]);
        wf["controlActionsHistory"] = json!([]);
        wf["reviewDispositions"] = Value::Null;
        if let Some(object)=wf.as_object_mut() {
            for key in ["reviewPatchContract","reviewPatchBaseCandidate","reviewPatchResponse","reviewPatchSourceHashDomain"] {object.remove(key);}
        }
        let context:Value=serde_json::from_str(s(&envelope["body"]["messages"][1],"content"))?;
        if context["patchContract"].is_object() {
            wf["reviewPatchContract"]=context["patchContract"].clone();
            wf["reviewPatchBaseCandidate"]=context["candidate"].clone();
            let actual_response:Value=serde_json::from_slice(&response_bytes)?;
            wf["reviewPatchResponse"]=serde_json::from_str(s(&actual_response["choices"][0]["message"],"content"))?;
            wf["reviewPatchSourceHashDomain"]=json!(if context["patchContract"]["sourceContentSha256"]==source_hash{"question_content"}else{"original_material"});
        }
        wf["candidateResult"] = candidate.clone();
        wf["reviewedCandidate"] = candidate.clone();
        let mut flags = teaching::findings(&candidate, s(&candidate,"questionId"));
        if audit["classroomUsable"] != true && flags.is_empty() {
            flags.push(json!({"type":"independent_review","code":"classroom_review_required",
                "message":"独立核查尚未确认课堂可用，需显式修订并重新核对。"}));
        }
        wf["findings"] = json!(flags);
        wf["finalResult"] = if flags.is_empty() {candidate.clone()} else {Value::Null};
        wf["status"] = json!(if flags.is_empty(){"ready_candidate"}else{"needs_review"});
        wf["sourceContentSha256"] = json!(source_hash);
        wf["model"] = envelope["body"]["model"].clone();
        wf["promptSha256"] = envelope["promptSha256"].clone();
        wf["requestSha256"] = envelope["bodySha256"].clone();
        wf["requestRelativePath"] = json!(relative(&request_path));
        wf["requestFileSha256"] = json!(sha(&request_bytes));
        wf["responseRelativePath"] = json!(relative(&response_path));
        wf["responseSha256"] = json!(sha(&response_bytes));
        wf["reviewFinishedAt"] = entry["completedAt"].clone();
        if task=="question_import_teaching_review" {
            wf["reviewCalls"] = json!(previous["reviewCalls"].as_u64().unwrap_or(0).max(1));
        }
        wf["lastResultOrigin"] = json!(if task=="question_import_teaching_review"{"review"}else{"generation"});
        if task=="question_import_teaching_generation" {
            wf["generationAudit"] = json!({"responseRelativePath":relative(&response_path),"responseSha256":sha(&response_bytes)});
            wf["generationFinishedAt"] = entry["completedAt"].clone();
        }
        let mut history = rows(&wf["explicitAdoptions"]);
        history.push(json!({"operationId":op,"adoptedAt":now(),"candidateSha256":hash_json(&candidate),
            "previousWorkflowSha256":hash_json(&previous),"previousWorkflow":previous,"previousReviewCalls":previous["reviewCalls"],
            "independentAudit":audit,"actualEvidence":entry,"method":"user_authorized_agent_review","checkedBy":"codex"}));
        wf["explicitAdoptions"] = json!(history);
        // verify_audit reads actual persisted request/response; no response is fabricated.
        if teaching::ready(q) { teaching::verify_audit(store,q)?; }
    }
    record["questions"] = json!(questions);
    finish(&mut record,op,&request_hash,"adopt_independently_reviewed_teaching");
    save_cas(store,Some(&saved),&record)?;
    Ok(json!({"import":record,"adopted":entries.len(),"replayed":false,"modelCalls":0}))
}

#[cfg(test)]
#[path="teaching_adoption_tests.rs"]
mod tests;
