//! Transport-only import summaries and exact, single-question detail views.
//! Publication and mutation always validate the complete persisted record.
use super::*;

fn pick(value: &Value, keys: &[&str]) -> Value {
    Value::Object(keys.iter().filter_map(|key| value.get(*key).map(|v| ((*key).to_owned(), v.clone()))).collect())
}

fn findings(value: &Value) -> Value {
    json!(rows(value).iter().map(|finding| {
        if finding.is_string() { return finding.clone(); }
        let mut result = pick(finding, &["id","type","dimension","origin","field","fieldPath","reason","message","description","issue","code","term","ruleId","category","blocking","severity","page","pages"]);
        if finding["target"].is_object() {
            result["target"] = pick(&finding["target"], &["domain","fieldPath","sourceContentSha256","candidateSha256"]);
        }
        result
    }).collect::<Vec<_>>())
}

fn text_shape(value: &Value, keys: &[&str]) -> Value {
    let mut result = json!({});
    for key in keys {
        if value[*key].is_string() { result[*key] = json!(""); }
    }
    result
}

fn question_summary(q: &Value) -> Value {
    let mut result = pick(q, &["questionId","sourceLabel","questionType","pages","reviewDecision","status","primaryKnowledgeUids","knowledgeUids","knowledgeSchemaVersion","annotationStatus","knowledgeMappingSource"]);
    if q["annotationError"].is_object() { result["annotationError"] = error_summary(&q["annotationError"]); }
    result["_detailLoaded"] = json!(false);
    // Structural presence only. The frontend still requires its existing ready
    // state before offering annotation; no generated proof text leaves here.
    result["_needsSolutionPathSupplement"] = json!(
        !s(&q["teachingWorkflow"]["finalResult"],"teachingSolution").trim().is_empty()
            && q["solutionPaths"].as_array().is_none_or(|paths|paths.is_empty())
    );
    for key in ["stem","answer","solution"] {
        if q[key].is_string() { result[key] = json!(""); }
    }
    for key in ["sourceIssues","reviewIssues"] {
        if q.get(key).is_some() { result[key] = findings(&q[key]); }
    }
    if q["task"].is_object() { result["task"] = pick(&q["task"], &["id","label"]); }
    if q["difficultyAssessment"].is_object() { result["difficultyAssessment"] = pick(&q["difficultyAssessment"], &["level","rubricVersion"]); }
    if q["duplicateCandidates"].is_array() {
        result["duplicateCandidates"] = json!(rows(&q["duplicateCandidates"]).iter().map(|v|pick(v,&["questionId","contentVersion","teacherVersion","reason","exact"])).collect::<Vec<_>>());
    }
    if q["options"].is_array() {
        result["options"] = json!(rows(&q["options"]).iter().map(|v| {
            let mut option = pick(v,&["label"]);
            if v["text"].is_string() { option["text"] = json!(""); }
            option
        }).collect::<Vec<_>>());
    }
    if q["parts"].is_array() {
        result["parts"] = json!(rows(&q["parts"]).iter().map(|v| {
            let mut part = pick(v,&["partId","parentPartId","label"]);
            for (key,value) in text_shape(v,&["stem","prompt","answer","solution"]).as_object().unwrap() { part[key] = value.clone(); }
            part
        }).collect::<Vec<_>>());
    }
    if q["modelReview"].is_object() {
        result["modelReview"] = pick(&q["modelReview"], &["status","summary","confidence"]);
        result["modelReview"]["issues"] = findings(&q["modelReview"]["issues"]);
    }
    if q["teachingWorkflow"].is_object() {
        let wf = &q["teachingWorkflow"];
        let mut workflow = pick(wf,&["status","sourceContentSha256","reviewCalls","generationCalls","reviewEligible","reviewFailurePending","retainedInitialReason","retainedInitialMessage"]);
        workflow["_hasCandidate"] = json!(["candidateResult","reviewedCandidate","initialCandidate","retainedInitialCandidate","finalResult"].iter().any(|key| {
            wf[*key].is_object() && (!s(&wf[*key],"answer").trim().is_empty() || !s(&wf[*key],"teachingSolution").trim().is_empty())
        }));
        for key in ["findings","effectiveFindings"] {
            if wf[key].is_array() { workflow[key] = findings(&wf[key]); }
        }
        for key in ["initialCandidate","reviewedCandidate","candidateResult","finalResult"] {
            if wf[key].is_object() { workflow[key] = pick(&wf[key],&["questionId","issues"]); }
        }
        result["teachingWorkflow"] = workflow;
    }
    if q["teachingPublication"].is_object() { result["teachingPublication"] = pick(&q["teachingPublication"],&["status","candidateSha256","sourceContentSha256"]); }
    result
}

fn error_summary(value: &Value) -> Value {
    pick(value,&["code","message","stage","stageKey","phase","httpStatus"])
}

fn pending(value: &Value, record: &Value, source_publication: bool) -> Value {
    let mut result = pick(value,&["operationId","payloadHash"]);
    if value["manifest"].is_object() { result["manifest"] = pick(&value["manifest"],&["operationId","questionId"]); }
    if value["payload"].is_object() {
        let payload = pick(&value["payload"],&["importId","questionId","expectedRevision","operationId","acknowledgeReview","acknowledgeTeachingUpdate","sourceContentSha256","candidateSha256","contentVersion","teacherVersion","expectedQuestionSha256","expectedAnnotationSha256","responseScope"]);
        if payload == value["payload"] { result["payload"] = payload; }
    } else if source_publication {
        let legacy = json!({"importId":record["importId"],"expectedRevision":record["revision"],"operationId":value["operationId"],"acknowledgeReview":true});
        if hash_json(&legacy) == value["payloadHash"] { result["payload"] = legacy; }
    }
    result["recoveryPayloadAvailable"] = json!(result["payload"].is_object());
    result
}

fn summary(record: &Value) -> Value {
    let mut result = pick(record,&["importId","filename","revision","status","createdAt","updatedAt","recognitionStage","publishedQuestionIds"]);
    if record["error"].is_object() { result["error"] = error_summary(&record["error"]); }
    result["_detailLoaded"] = json!(false);
    result["questions"] = json!(rows(&record["questions"]).iter().map(question_summary).collect::<Vec<_>>());
    result["sourceIssues"] = findings(&record["sourceIssues"]);
    for key in ["source","renderedPdf"] {
        if record[key].is_object() { result[key] = pick(&record[key],&["extension","sha256","byteLength","physicalPages"]); }
    }
    if record["ocrSource"].is_object() { result["ocrSource"] = pick(&record["ocrSource"],&["provider","model","manifestSha256","physicalPages","pageCount"]); }
    if record["structuredSource"].is_object() {
        result["structuredSource"] = pick(&record["structuredSource"],&["expectedQuestionCount"]);
        result["structuredSource"]["exam"] = pick(&record["structuredSource"]["exam"],&["title","expectedQuestionCount"]);
    }
    if record["backgroundJob"].is_object() {
        result["backgroundJob"] = pick(&record["backgroundJob"],&["jobId","mode","status","createdAt","startedAt","finishedAt","targetQuestionIds","totalQuestions","completedQuestions","failedQuestions"]);
        if record["backgroundJob"]["error"].is_object() { result["backgroundJob"]["error"] = error_summary(&record["backgroundJob"]["error"]); }
    }
    for key in ["pendingPublication","pendingTeachingPublication"] {
        if record[key].is_object() { result[key] = pending(&record[key],record,key=="pendingPublication"); }
    }
    result
}

fn question<'a>(record: &'a Value, id: &str) -> AppResult<&'a Value> {
    let questions = record["questions"].as_array().ok_or_else(||err("invalid_import","导入记录没有可读取的题目。"))?;
    let mut matching = questions.iter().filter(|q| q["questionId"] == id);
    let q = matching.next().filter(|_| !id.is_empty()).ok_or_else(||err("invalid_import","题目不属于本次导入。"))?;
    if matching.next().is_some() { return Err(err("invalid_import","导入题目身份重复。")); }
    Ok(q)
}

pub(super) fn validate_scope(store: &Store, payload: &Value) -> AppResult<()> {
    match payload.get("responseScope") {
        None | Some(Value::Null) => Ok(()),
        Some(Value::String(scope)) if scope == "summary" => Ok(()),
        Some(Value::String(scope)) if scope == "question" => {
            let record = store.document("imports",s(payload,"importId"))?;
            question(&record,s(payload,"questionId"))?;
            Ok(())
        }
        _ => Err(err("invalid_import","导入响应范围无效。")),
    }
}

fn compact(store: &Store, record: &Value, id: Option<&str>, version: Value, existing: Option<&Value>) -> AppResult<Value> {
    let selected = id.map(|id| question(record,id)).transpose()?;
    let controls = id.map_or_else(||teaching::controls::summary_projection(record),|id|teaching::controls::question_projection(record,id));
    let actions = id.map_or_else(||teaching_actions::summary_projection(store,record),|id|teaching_actions::question_projection(store,record,id));
    let eligibility = existing.and_then(|v|v.get("reviewEligibility")).filter(|v|v.is_object()).cloned().unwrap_or_else(||review::eligibility(record));
    let requirements = existing.and_then(|v|v.get("reviewRequirements")).filter(|v|v.is_object()).cloned().unwrap_or_else(||review_requirement_map(record));
    let mut result = json!({"summary":summary(record),"detailVersion":version,
        "reviewEligibility":eligibility,"reviewRequirements":requirements,
        "teachingControls":controls,"teachingActions":actions,"sourceCorrectionDisplays":{}});
    if let Some(id) = id {
        result["question"] = selected.unwrap().clone();
        result["sourceCorrectionDisplays"] = source_display::projection_for_question(store,record,id);
    }
    result["diagnostic"] = existing.and_then(|v|v.get("diagnostic")).cloned().unwrap_or_else(||diagnostics::for_record(store,record));
    Ok(result)
}

pub(super) fn read(store: &Store, payload: &Value, one_question: bool) -> AppResult<Value> {
    background::recover(store)?;
    let persisted = store.document_json("imports",s(payload,"importId"))?;
    let version = sha(persisted.as_bytes());
    if !one_question && payload["knownDetailVersion"].as_str() == Some(version.as_str()) {
        return Ok(json!({"importId":payload["importId"],"detailVersion":version,"notModified":true}));
    }
    if one_question && payload.get("expectedDetailVersion").is_some()
        && payload["expectedDetailVersion"].as_str() != Some(version.as_str()) {
        return Err(err("revision_conflict","导入记录已更新，请保留当前修改并重新读取题目。"));
    }
    let record: Value = serde_json::from_str(&persisted)?;
    compact(store,&record,one_question.then(||s(payload,"questionId")),json!(version),None)
}

pub(super) fn finish(store: &Store, mut result: Value, payload: &Value) -> AppResult<Value> {
    if !matches!(payload["responseScope"].as_str(),Some("summary"|"question")) || !result["import"].is_object() {
        return Ok(with_teaching_controls(store,result));
    }
    let record = result.as_object_mut().unwrap().remove("import").unwrap();
    let version = if result["detailVersion"].is_string() { result["detailVersion"].clone() } else {
        // Replays may read an older JSON representation. Keep its exact-byte
        // token when it is still this snapshot; a newer worker checkpoint must
        // never lend its token to the earlier action response.
        let persisted = store.document_json("imports",s(&record,"importId"))?;
        let saved: Value = serde_json::from_str(&persisted)?;
        json!(if saved==record { sha(persisted.as_bytes()) } else { sha(record.to_string().as_bytes()) })
    };
    let view = compact(store,&record,(payload["responseScope"]=="question").then(||s(payload,"questionId")),version,Some(&result))?;
    for key in ["teachingControls","teachingActions","sourceCorrectionDisplays","reviewEligibility","reviewRequirements","diagnostic"] { result.as_object_mut().unwrap().remove(key); }
    result.as_object_mut().unwrap().extend(view.as_object().unwrap().clone());
    Ok(result)
}

#[cfg(test)]
#[path = "views_tests.rs"]
mod tests;
