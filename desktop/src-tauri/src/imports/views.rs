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
    if q["accuracy"].is_object() {
        result["accuracy"]=q["accuracy"].clone();
        result["accuracy"].as_object_mut().unwrap().remove("candidate");
        if q["accuracy"]["findings"].is_array() {result["accuracy"]["findings"]=findings(&q["accuracy"]["findings"]);}
    }
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
    let mut result = pick(record,&["importId","filename","revision","status","createdAt","updatedAt","recognitionStage","publishedQuestionIds","accuracyRunId","accuracyStrategy"]);
    if record["error"].is_object() { result["error"] = error_summary(&record["error"]); }
    result["_detailLoaded"] = json!(false);
    result["questions"] = json!(rows(&record["questions"]).iter().map(question_summary).collect::<Vec<_>>());
    result["annotationQuestionIds"] = json!(background::annotation_target_ids(record));
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
    let eligibility = if !s(record,"accuracyRunId").is_empty() {review_eligibility(store,record)?} else {
        existing.and_then(|v|v.get("reviewEligibility")).filter(|v|v.is_object()).cloned().unwrap_or_else(||review::eligibility(record))
    };
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
    let record: Value = serde_json::from_str(&persisted)?;
    let version = accuracy::detail_version(store,&record,&sha(persisted.as_bytes()))?;
    if !one_question && payload["knownDetailVersion"].as_str() == Some(version.as_str()) {
        return Ok(json!({"importId":payload["importId"],"detailVersion":version,"notModified":true}));
    }
    if one_question && payload.get("expectedDetailVersion").is_some()
        && payload["expectedDetailVersion"].as_str() != Some(version.as_str()) {
        return Err(err("revision_conflict","导入记录已更新，请保留当前修改并重新读取题目。"));
    }
    let record=accuracy::project_record(store,&record)?;
    compact(store,&record,one_question.then(||s(payload,"questionId")),json!(version),None)
}

pub(super) fn finish(store: &Store, mut result: Value, payload: &Value) -> AppResult<Value> {
    if result["import"].is_object() {
        let original=result["import"].clone();
        if !s(&original,"accuracyRunId").is_empty() {
            // Action handlers may already return a projected question. Tokens
            // must use the same persisted bytes and run revision as read().
            // Reproject that saved record so a delayed action cannot attach a
            // current token to an earlier projected body.
            let persisted=store.document_json("imports",s(&original,"importId"))?;
            let current:Value=serde_json::from_str(&persisted)?;
            result["detailVersion"]=json!(accuracy::detail_version(store,&current,&sha(persisted.as_bytes()))?);
            result["import"]=accuracy::project_record(store,&current)?;
            result["reviewEligibility"]=review_eligibility(store,&result["import"])?;
            result["reviewRequirements"]=review_requirement_map(&result["import"]);
            result["diagnostic"]=diagnostics::for_record(store,&current);
        } else {
            result["import"]=accuracy::project_record(store,&original)?;
        }
    }
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

#[cfg(test)]
mod accuracy_tests {
    use super::*;

    fn fixture()->(tempfile::TempDir,Store,Value){
        let dir=tempfile::tempdir().unwrap();
        let store=Store::open(dir.path(),&crate::bank::tests::seed()).unwrap();
        let source=save_source(&store,"simulated-accuracy-views","txt",b"simulated accuracy source").unwrap();
        let q=normalize_question(&json!({"questionType":"fill_blank","sourceLabel":"1","pages":[1],
            "stem":"SIMULATED_ACCURACY_BODY: compute 921+72.","answer":"","solution":"","options":[],"parts":[],
            "sectionIds":[],"knowledgeUids":[],"knowledgeTopics":[],"task":{"label":"模拟计算"}}),"simulated-accuracy-q1",1).unwrap();
        let mut record=json!({"importId":"simulated-accuracy-views","filename":"模拟准确性读取.txt","revision":0,
            "status":"pending_review","source":source,"sourceIssues":[],"questions":[q],"publishedQuestionIds":[],"operations":[],"createdAt":now(),"updatedAt":now()});
        let identity=json!({"sha256":record["source"]["sha256"],"relativePath":record["source"]["relativePath"],"extension":record["source"]["extension"],"byteLength":record["source"]["byteLength"]});
        let run=accuracy::store::create_run(&store,s(&record,"importId"),&json!({"strategyVersion":"simulated-view-strategy"}),&identity,&json!({})).unwrap();
        record["accuracyRunId"]=run["id"].clone();record["accuracyStrategy"]=json!("simulated-view-strategy");
        store.put_document("imports",s(&record,"importId"),&record).unwrap();
        (dir,store,record)
    }

    #[test]
    fn process_only_revision_refreshes_summary_without_exposing_body_or_legacy_workflow(){
        let (_dir,store,record)=fixture();
        let payload=json!({"importId":record["importId"]});
        let first=read(&store,&payload,false).unwrap();
        assert_eq!(first["summary"]["accuracyRunId"],record["accuracyRunId"]);
        assert_eq!(first["summary"]["questions"][0]["accuracy"]["status"],"needs_review");
        assert!(first["summary"]["questions"][0]["accuracy"].get("candidate").is_none());
        assert!(!first.to_string().contains("SIMULATED_ACCURACY_BODY"));
        let mut run=accuracy::store::load_run(&store,s(&record,"accuracyRunId")).unwrap();
        run["progress"]["stage"]=json!("source");
        accuracy::store::save_run(&store,run["revision"].as_u64().unwrap(),&run).unwrap();
        let second=read(&store,&json!({"importId":record["importId"],"knownDetailVersion":first["detailVersion"]}),false).unwrap();
        assert_ne!(first["detailVersion"],second["detailVersion"]);
        assert_ne!(second["notModified"],true);
        assert_eq!(store.document("imports",s(&record,"importId")).unwrap(),record);
        assert_eq!(read(&store,&json!({"importId":record["importId"],"questionId":"simulated-accuracy-q1","expectedDetailVersion":first["detailVersion"]}),true).unwrap_err().code,"revision_conflict");
        let question=read(&store,&json!({"importId":record["importId"],"questionId":"simulated-accuracy-q1"}),true).unwrap();
        assert!(question["question"].get("teachingWorkflow").is_none());
    }

    #[test]
    fn old_editor_keeps_source_edits_but_rejects_new_teaching_metadata_changes(){
        let (_dir,store,record)=fixture();
        let projected=accuracy::project_record(&store,&record).unwrap();
        let mut q=projected["questions"][0].clone();
        q["difficultyAssessment"]=json!({"level":"hard","basis":"模拟教师修改的难度依据。"});
        let mut payload=json!({"importId":record["importId"],"questionId":q["questionId"],"question":q,"expectedRevision":record["revision"],"operationId":"simulated-meta-edit"});
        assert_eq!(review_save_with_scope(&store,&payload,true).unwrap_err().code,"accuracy_action_required");
        assert_eq!(store.document("imports",s(&record,"importId")).unwrap(),record);
        payload["question"]=projected["questions"][0].clone();
        payload["question"]["stem"]=json!("模拟核对原题后的题干更正：921+73。");
        payload["operationId"]=json!("simulated-source-edit");
        let result=review_save_with_scope(&store,&payload,true).unwrap();
        assert_eq!(result["import"]["questions"][0]["stem"],payload["question"]["stem"]);
        assert_eq!(result["import"]["questions"][0]["difficultyAssessment"],record["questions"][0]["difficultyAssessment"]);
    }

    #[test]
    fn old_approve_flag_does_not_grant_new_pipeline_publication(){
        let (_dir,store,mut record)=fixture();
        record["questions"][0]["reviewDecision"]=json!("approve");
        record["questions"][0]["reviewBasis"]=json!("模拟旧按钮核对记录，未完成新增数学与教学核验。");
        record["questions"][0]["reviewChecks"]=json!({"stem":true,"options":true,"formulasAndAssets":true,"answer":true,"solution":true});
        assert_eq!(build_manifest(&store,&record).unwrap_err().code,"review_required");
    }
}
