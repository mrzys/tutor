use super::*;

fn fixture() -> (tempfile::TempDir, Store, Value) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path(),&crate::bank::tests::seed()).unwrap();
    let source = save_source(&store,"sim-views","txt",b"simulated source preserved on disk").unwrap();
    let questions = (1..=2).map(|n| {
        let id = format!("sim-view-q{n}");
        let mut q = normalize_question(&json!({"questionType":"fill_blank","sourceLabel":n.to_string(),"pages":[1],
            "stem":format!("模拟第{n}题 SIM_Q{n}_SOURCE_BODY"),"answer":"","solution":"","options":[],"parts":[],
            "sectionIds":[],"knowledgeUids":[],"knowledgeTopics":[],"task":{"label":"模拟计算"}}),&id,1).unwrap();
        let c = json!({"questionId":id,"answer":format!("SIM_Q{n}_TEACHING_ANSWER"),"difficultyAssessment":{"level":"easy","basis":"模拟：直接计算。"},
            "teachingSolution":format!("SIM_Q{n}_TEACHING_BODY"),"teachingFocusSchemaVersion":2,"teachingFocus":{"examFocus":"模拟计算。","studentRequirements":["完成计算。"]},"issues":[]});
        teaching::initialize(&mut q,&json!({"generatedTeaching":c}));
        q
    }).collect::<Vec<_>>();
    let record = json!({"importId":"sim-views","filename":"模拟局部读取.txt","revision":1,"createdAt":now(),"updatedAt":now(),
        "status":"pending_review","source":source,"sourceIssues":[],"questions":questions,"publishedQuestionIds":[],"operations":[],
        "extractedPages":["SIM_OCR_FULL_TEXT"],"modelAttempts":[{"request":"SIM_REQUEST_BODY","response":"SIM_RAW_MODEL_RESPONSE"}]});
    store.put_document("imports","sim-views",&record).unwrap();
    (dir,store,record)
}

fn call(store: &mut Store, action: &str, payload: &Value) -> AppResult<Value> {
    let model = ModelClient::test_client(&store.data_dir,"http://127.0.0.1:9/v1");
    dispatch(store,&model,action,payload,&AtomicBool::new(false)).map(|v|v.unwrap())
}

fn single_payload(record: &Value, operation: &str) -> Value {
    json!({"importId":record["importId"],"questionId":"sim-view-q1","expectedRevision":record["revision"],
        "operationId":operation,"question":record["questions"][0],"responseScope":"question"})
}

#[test]
fn simulated_single_save_notifies_only_after_commit_and_not_for_conflict_or_idempotent_replay() {
    let (dir,mut store,record) = fixture();
    let (send,receive) = std::sync::mpsc::channel();
    let database = dir.path().join("personal.sqlite");
    let _subscription = crate::import_events::subscribe(dir.path(),move |event| {
        let connection = rusqlite::Connection::open(&database).unwrap();
        let raw: String = connection.query_row("SELECT payload FROM documents WHERE kind='imports' AND id=?1",
            [s(&event,"importId")],|row|row.get(0)).unwrap();
        let persisted:Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(persisted["revision"],event["revision"]);
        send.send(event).unwrap();
    }).unwrap();
    let mut input = single_payload(&record,"sim-notify-single");
    input["question"]["stem"] = json!("模拟提交后的原题修改");
    let mut stale = input.clone();stale["expectedRevision"] = json!(999);
    assert_eq!(call(&mut store,"import_question_review_save",&stale).unwrap_err().code,"revision_conflict");
    assert!(receive.try_recv().is_err());
    let saved = call(&mut store,"import_question_review_save",&input).unwrap();
    let event = receive.try_recv().unwrap();
    assert_eq!(event["revision"],saved["summary"]["revision"]);
    assert!(receive.try_recv().is_err());
    assert_eq!(call(&mut store,"import_question_review_save",&input).unwrap(),saved);
    assert!(receive.try_recv().is_err());
}

fn assert_no_shared_body(value: &Value) {
    let body = value.to_string();
    for marker in ["SIM_OCR_FULL_TEXT","SIM_REQUEST_BODY","SIM_RAW_MODEL_RESPONSE","SIM_Q2_SOURCE_BODY","SIM_Q2_TEACHING_BODY","SIM_Q2_TEACHING_ANSWER"] {
        assert!(!body.contains(marker),"compact response leaked {marker}");
    }
    assert!(value.get("import").is_none());
}

#[test]
fn simulated_summary_omits_bodies_and_preserves_navigation_structure_and_eligibility() {
    let (_dir,mut store,mut record) = fixture();
    record["questions"][1]["parts"] = json!([{"partId":"sim-part","prompt":"SIM_Q2_PART_BODY","answer":"SIM_Q2_PART_ANSWER","solution":"SIM_Q2_PART_SOLUTION"}]);
    record["questions"][1]["options"] = json!([{"label":"A","text":"SIM_Q2_OPTION_BODY"}]);
    record["questions"][1]["sourceIssues"] = json!([{"dimension":"material","fieldPath":"parts[0].prompt","message":"模拟缺少小问依据","blocking":true}]);
    record["questions"][1]["teachingWorkflow"]["effectiveFindings"] = json!([{"type":"quality","dimension":"material","fieldPath":"parts[0].prompt","reason":"模拟材料疑点"}]);
    record["ocrSource"] = json!({"manifestSha256":"simulated","pages":[{"blocks":[{"text":"SIM_OCR_BLOCK_BODY"}]}],"assets":[{"dataBase64":"SIM_OCR_ASSET_BYTES"}]});
    record["structuredSource"] = json!({"expectedQuestionCount":2,"exam":{"title":"模拟标题","questions":[{"stem":"SIM_EMBEDDED_SOURCE_BODY"}]}});
    record["pendingTeachingPublication"] = json!({"operationId":"sim-recovery","payloadHash":"sim-hash","manifest":{"questionId":"sim-view-q1","teachingAnalysis":{"solution":"SIM_PENDING_TEACHING_BODY"}},"payload":{"importId":"sim-views","questionId":"sim-view-q1","operationId":"sim-recovery","expectedRevision":1}});
    store.put_document("imports","sim-views",&record).unwrap();
    let result = call(&mut store,"import_summary_get",&json!({"importId":"sim-views"})).unwrap();
    assert_no_shared_body(&result);
    let body = result.to_string();
    for marker in ["SIM_Q1_SOURCE_BODY","SIM_Q1_TEACHING_BODY","SIM_Q2_PART_BODY","SIM_Q2_OPTION_BODY","SIM_OCR_BLOCK_BODY","SIM_OCR_ASSET_BYTES","SIM_EMBEDDED_SOURCE_BODY","SIM_PENDING_TEACHING_BODY"] { assert!(!body.contains(marker),"summary leaked {marker}"); }
    assert_eq!(result["reviewEligibility"],review::eligibility(&record));
    assert_eq!(result["summary"]["questions"][1]["parts"][0]["prompt"],"");
    assert_eq!(result["summary"]["questions"][1]["options"][0]["text"],"");
    assert_eq!(result["summary"]["questions"][1]["teachingWorkflow"]["effectiveFindings"][0]["fieldPath"],"parts[0].prompt");
    assert_eq!(result["summary"]["questions"][1]["_detailLoaded"],false);
    assert_eq!(result["summary"]["structuredSource"]["exam"]["title"],"模拟标题");
    assert_eq!(result["summary"]["pendingTeachingPublication"]["payload"]["operationId"],"sim-recovery");
    assert!(result["teachingControls"]["sim-view-q1"]["editableFields"].as_array().unwrap().is_empty());
    assert_eq!(store.document("imports","sim-views").unwrap(),record);
}

#[test]
fn simulated_unread_ready_teaching_retains_missing_path_supplement_hint_without_proof_text() {
    let (_dir,mut store,mut record) = fixture();
    assert!(!s(&record["questions"][0]["teachingWorkflow"]["finalResult"],"teachingSolution").is_empty());
    record["questions"][1]["solutionPaths"] = json!([{"id":"simulated-existing-path","basis":"SIM_PRIVATE_PATH_BODY"}]);
    store.put_document("imports","sim-views",&record).unwrap();
    let result = call(&mut store,"import_summary_get",&json!({"importId":"sim-views"})).unwrap();
    assert_eq!(result["summary"]["questions"][0]["_needsSolutionPathSupplement"],true);
    assert_eq!(result["summary"]["questions"][1]["_needsSolutionPathSupplement"],false);
    assert!(!result.to_string().contains("SIM_PRIVATE_PATH_BODY"));
    assert_no_shared_body(&result);
}

#[test]
fn simulated_question_detail_is_exact_scoped_and_legacy_remains_complete() {
    let (_dir,mut store,record) = fixture();
    let result = call(&mut store,"import_question_get",&json!({"importId":"sim-views","questionId":"sim-view-q1"})).unwrap();
    assert_eq!(result["question"],record["questions"][0]);
    assert_no_shared_body(&result);
    assert!(!result["teachingControls"]["sim-view-q1"]["editableFields"].as_array().unwrap().is_empty());
    assert!(result["teachingControls"]["sim-view-q2"]["editableFields"].as_array().unwrap().is_empty());
    let legacy = call(&mut store,"import_get",&json!({"importId":"sim-views"})).unwrap();
    assert_eq!(legacy["import"],record);
    assert_eq!(legacy["detailVersion"],result["detailVersion"]);
    assert!(legacy.get("summary").is_none());
    for payload in [json!({"importId":"sim-views","questionId":"different-question"}),json!({"importId":"other-import","questionId":"sim-view-q1"})] {
        assert!(call(&mut store,"import_question_get",&payload).is_err());
    }
}

#[test]
fn simulated_detail_version_uses_persisted_bytes_and_guards_same_revision_checkpoints() {
    let (_dir,mut store,mut record) = fixture();
    let pretty = serde_json::to_string_pretty(&record).unwrap();
    store.user.execute("UPDATE documents SET payload=?1 WHERE kind='imports' AND id='sim-views'",[&pretty]).unwrap();
    let first = call(&mut store,"import_summary_get",&json!({"importId":"sim-views"})).unwrap();
    assert_eq!(first["detailVersion"],sha(pretty.as_bytes()));
    let unchanged = call(&mut store,"import_summary_get",&json!({"importId":"sim-views","knownDetailVersion":first["detailVersion"]})).unwrap();
    assert_eq!(unchanged,json!({"importId":"sim-views","detailVersion":first["detailVersion"],"notModified":true}));
    assert_eq!(call(&mut store,"import_question_get",&json!({"importId":"sim-views","questionId":"sim-view-q1","expectedDetailVersion":first["detailVersion"]})).unwrap()["question"],record["questions"][0]);
    record["checkpoint"] = json!({"saved":true});
    store.put_document("imports","sim-views",&record).unwrap();
    let error = call(&mut store,"import_question_get",&json!({"importId":"sim-views","questionId":"sim-view-q1","expectedDetailVersion":first["detailVersion"]})).unwrap_err();
    assert_eq!(error.code,"revision_conflict");
    let latest = call(&mut store,"import_question_get",&json!({"importId":"sim-views","questionId":"sim-view-q1"})).unwrap();
    assert_ne!(latest["detailVersion"],first["detailVersion"]);
    assert_eq!(latest["summary"]["revision"],first["summary"]["revision"]);
}

#[test]
fn simulated_summary_preserves_page_scoped_issues_and_limits_error_metadata() {
    let (_dir,mut store,mut record) = fixture();
    record["questions"][1]["pages"] = json!([2]);
    record["sourceIssues"] = json!([{"page":1,"message":"模拟仅第一页材料缺失","blocking":true}]);
    record["error"] = json!({"code":"simulated","message":"模拟错误","privatePayload":"SIM_ERROR_RAW_PAYLOAD"});
    record["backgroundJob"] = json!({"status":"completed","error":{"code":"simulated","message":"模拟任务错误","response":{"content":"SIM_JOB_RAW_RESPONSE"}}});
    record["questions"][1]["annotationError"] = json!({"code":"simulated","message":"模拟标注错误","request":"SIM_ANNOTATION_REQUEST"});
    store.put_document("imports","sim-views",&record).unwrap();
    let result = call(&mut store,"import_summary_get",&json!({"importId":"sim-views"})).unwrap();
    assert_eq!(result["summary"]["sourceIssues"][0]["page"],1);
    for n in 0..2 {
        assert_eq!(question_issues(&result["summary"]["questions"][n],&result["summary"]["sourceIssues"]),question_issues(&record["questions"][n],&record["sourceIssues"]));
    }
    let body = result.to_string();
    for marker in ["SIM_ERROR_RAW_PAYLOAD","SIM_JOB_RAW_RESPONSE","SIM_ANNOTATION_REQUEST"] { assert!(!body.contains(marker)); }
    assert_eq!(result["summary"]["error"]["message"],"模拟错误");
}

#[test]
fn simulated_pending_recovery_keeps_exact_scopes_and_only_reconstructs_verified_legacy_requests() {
    let (_dir,_store,mut record) = fixture();
    let legacy = json!({"importId":"sim-views","expectedRevision":1,"operationId":"sim-pending-legacy","acknowledgeReview":true});
    record["pendingPublication"] = json!({"operationId":"sim-pending-legacy","payloadHash":hash_json(&legacy),"manifest":{"questions":[{"stem":"SIM_PENDING_SOURCE_BODY"}]}});
    assert_eq!(summary(&record)["pendingPublication"]["payload"],legacy);
    assert!(summary(&record)["pendingPublication"]["payload"].get("responseScope").is_none());
    let mut scoped = legacy.clone();scoped["responseScope"] = json!("summary");
    record["pendingPublication"] = json!({"operationId":"sim-pending-legacy","payloadHash":hash_json(&scoped),"payload":scoped,"manifest":{}});
    assert_eq!(summary(&record)["pendingPublication"]["payload"],scoped);
    record["pendingTeachingPublication"] = json!({"operationId":"sim-teaching-pending","payload":{"importId":"sim-views","questionId":"sim-view-q1","expectedRevision":1,"operationId":"sim-teaching-pending","sourceContentSha256":"source","candidateSha256":"candidate","contentVersion":"content","teacherVersion":"teacher","expectedQuestionSha256":"question","expectedAnnotationSha256":"annotation","acknowledgeTeachingUpdate":true,"responseScope":"question"}});
    assert_eq!(summary(&record)["pendingTeachingPublication"]["payload"],record["pendingTeachingPublication"]["payload"]);
    record["pendingPublication"]["payload"]["unexpectedPrivatePayload"] = json!("SIM_PENDING_PRIVATE_PAYLOAD");
    let result = summary(&record);
    assert_eq!(result["pendingPublication"]["recoveryPayloadAvailable"],false);
    assert!(result["pendingPublication"].get("payload").is_none());
    assert!(!result.to_string().contains("SIM_PENDING_PRIVATE_PAYLOAD"));
}

#[test]
fn simulated_single_save_is_partial_atomic_idempotent_and_does_not_normalize_other_questions() {
    let (_dir,mut store,mut record) = fixture();
    record["questions"][1]["sourceAssetBindingAudit"] = json!({"opaqueFutureEvidence":"SIM_UNCHANGED_BINDING"});
    record["questions"][1]["futureServerField"] = json!({"opaque":"SIM_UNCHANGED_FUTURE_FIELD"});
    record["questions"][1]["reviewDecision"] = json!("approve");
    // This legacy incomplete approval must not be normalized or re-approved by editing q1.
    store.put_document("imports","sim-views",&record).unwrap();
    let mut payload = single_payload(&record,"sim-partial-save");
    payload["question"]["stem"] = json!("模拟修正后的第一题。");
    let result = call(&mut store,"import_question_review_save",&payload).unwrap();
    assert_no_shared_body(&result);
    assert_eq!(result["question"]["stem"],"模拟修正后的第一题。");
    assert_eq!(result["question"]["teachingWorkflow"]["status"],"needs_review");
    let saved = store.document("imports","sim-views").unwrap();
    assert_eq!(saved["questions"][1],record["questions"][1]);
    assert_eq!(saved["revision"],2);
    assert_eq!(saved["operations"][0]["payloadHash"],hash_json(&payload));
    let replayed = call(&mut store,"import_question_review_save",&payload).unwrap();
    assert_eq!(replayed,result);
    let stale = single_payload(&record,"sim-stale-revision");
    assert_eq!(call(&mut store,"import_question_review_save",&stale).unwrap_err().code,"revision_conflict");
    let mut changed = payload.clone();changed["question"]["stem"] = json!("相同操作身份的另一份修改。");
    assert_eq!(call(&mut store,"import_question_review_save",&changed).unwrap_err().code,"operation_conflict");
    assert_eq!(store.document("imports","sim-views").unwrap(),saved);
}

#[test]
fn simulated_single_save_rejects_missing_assets_summary_data_published_edits_and_scope_errors() {
    let (_dir,mut store,record) = fixture();
    let mut payload = single_payload(&record,"sim-missing-asset");
    payload["question"]["stem"] = json!("模拟缺失图片 ![missing](asset:missing-image)");
    payload["question"]["reviewDecision"] = json!("approve");
    payload["question"]["reviewChecks"] = json!({"sourceMatched":true,"formulaChecked":true});
    payload["question"]["reviewBasis"] = json!("模拟回归：不得靠确认绕过缺图。");
    assert_eq!(call(&mut store,"import_question_review_save",&payload).unwrap_err().code,"source_content_unresolved");
    assert_eq!(store.document("imports","sim-views").unwrap(),record);
    let mut payload = single_payload(&record,"sim-summary-input");
    payload["question"] = question_summary(&record["questions"][0]);
    assert_eq!(call(&mut store,"import_question_review_save",&payload).unwrap_err().code,"invalid_import");
    for (key,value) in [("questionId",json!("other-question")),("responseScope",json!("all-private-data"))] {
        let mut payload = single_payload(&record,&format!("sim-invalid-{key}"));payload[key]=value;
        assert!(call(&mut store,"import_question_review_save",&payload).is_err());
    }
    let mut published = record.clone();published["publishedQuestionIds"] = json!(["sim-view-q1"]);
    store.put_document("imports","sim-views",&published).unwrap();
    let mut payload = single_payload(&published,"sim-published-edit");payload["question"]["stem"] = json!("不得修改已发布原题。");
    assert_eq!(call(&mut store,"import_question_review_save",&payload).unwrap_err().code,"immutable_question");
    assert_eq!(store.document("imports","sim-views").unwrap(),published);
}

#[test]
fn simulated_legacy_full_save_can_opt_into_summary_without_returning_question_bodies() {
    let (_dir,mut store,record) = fixture();
    let payload = json!({"importId":"sim-views","expectedRevision":1,"operationId":"sim-legacy-summary","questions":record["questions"],"responseScope":"summary"});
    let result = call(&mut store,"import_review_save",&payload).unwrap();
    assert_no_shared_body(&result);
    assert!(result.get("question").is_none());
    assert_eq!(result["summary"]["revision"],2);
    let saved = store.document("imports","sim-views").unwrap();
    let legacy_payload = json!({"importId":"sim-views","expectedRevision":2,"operationId":"sim-legacy-complete","questions":saved["questions"]});
    let legacy = call(&mut store,"import_review_save",&legacy_payload).unwrap();
    assert_eq!(legacy["import"]["questions"],saved["questions"]);
    assert!(legacy.get("summary").is_none());
}
