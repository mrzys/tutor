//! Isolated simulated snapshots; no OCR, model calls, or actual user data.
use super::*;

fn fixture() -> (tempfile::TempDir, Store, ModelClient, Value) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path(), &crate::bank::tests::seed()).unwrap();
    let model = ModelClient::test_client(dir.path(), "http://127.0.0.1:1/v1");
    let record = json!({"importId":"simulated-snapshot","filename":"模拟进度回归.txt",
        "revision":7,"updatedAt":"2026-11-01T01:00:00Z","status":"pending_review",
        "recognitionStage":"structuring","source":{"extension":"txt"},
        "backgroundJob":{"jobId":"simulated-job","status":"completed"},
        "questions":[],"sourceIssues":[],"operations":[],"error":null});
    store.put_document("imports", s(&record,"importId"), &record).unwrap();
    (dir, store, model, record)
}

fn read(store: &mut Store, model: &ModelClient, action: &str, payload: Value) -> Value {
    crate::imports::dispatch(store, model, action, &payload, &AtomicBool::new(false))
        .unwrap().unwrap()
}

#[test]
fn unchanged_snapshot_omits_large_details_and_all_projections_without_mutating_record() {
    let (_dir, mut store, model, mut record) = fixture();
    record["extractedPages"] = json!(["simulated-private-ocr-checkpoint ".repeat(16_000)]);
    store.put_document("imports", s(&record,"importId"), &record).unwrap();
    let input = json!({"importId":record["importId"]});
    let opened = read(&mut store, &model, "import_get", input.clone());
    let full = read(&mut store, &model, "import_job_get", input.clone());
    assert_eq!(full["import"], record);
    assert_eq!(opened["detailVersion"],full["detailVersion"]);
    for key in ["teachingControls", "teachingActions", "sourceCorrectionDisplays", "reviewEligibility"] {
        assert!(full[key].is_object(), "missing full projection {key}");
    }
    let small = read(&mut store, &model, "import_job_get",
        json!({"importId":record["importId"],"knownDetailVersion":opened["detailVersion"]}));
    assert_eq!(small, json!({"importId":record["importId"],"detailVersion":full["detailVersion"],"notModified":true}));
    assert!(full.to_string().len() > 400_000);
    assert!(small.to_string().len() < 200);
    assert_eq!(store.document("imports",s(&record,"importId")).unwrap(), record);
    assert_eq!(read(&mut store,&model,"import_job_get",input)["import"], record);
}

#[test]
fn checkpoint_error_stage_and_question_changes_are_visible_without_review_revision_or_time_changes() {
    let (_dir, mut store, model, record) = fixture();
    let full = read(&mut store,&model,"import_job_get",json!({"importId":record["importId"]}));
    let changes = [
        ("sourceStructuring", json!({"batches":[{"status":"succeeded","questions":[{"stem":"模拟成功断点"}]}]})),
        ("recognitionStage", json!("teaching_generating")),
        ("error", json!({"code":"model_http_error","message":"模拟具体错误"})),
        ("backgroundJob", json!({"jobId":"simulated-job","status":"failed","error":{"code":"model_http_error","message":"模拟失败"}})),
        ("questions", json!([{"questionId":"simulated-q","stem":"模拟新增题目","questionType":"fill_blank"}])),
    ];
    for (key, value) in changes {
        let mut next = record.clone(); next[key] = value;
        store.put_document("imports",s(&record,"importId"),&next).unwrap();
        let result = read(&mut store,&model,"import_job_get",
            json!({"importId":record["importId"],"knownDetailVersion":full["detailVersion"]}));
        assert_ne!(result["notModified"],true,"missed {key}");
        assert_ne!(result["detailVersion"],full["detailVersion"],"missed {key}");
        assert_eq!(result["import"],next);
        assert_eq!(result["import"]["revision"],record["revision"]);
        assert_eq!(result["import"]["updatedAt"],record["updatedAt"]);
    }
}

#[test]
fn conditional_reads_preserve_exact_legacy_json_snapshot_and_explicit_open_contract() {
    let (_dir, mut store, model, record) = fixture();
    let pretty = serde_json::to_string_pretty(&record).unwrap();
    store.user.execute("UPDATE documents SET payload=?1 WHERE kind='imports' AND id=?2",
        rusqlite::params![pretty,s(&record,"importId")]).unwrap();
    let first = read(&mut store,&model,"import_job_get",
        json!({"importId":record["importId"],"knownDetailVersion":"unknown-old-format"}));
    assert_eq!(first["detailVersion"],sha(pretty.as_bytes()));
    let input = json!({"importId":record["importId"],"knownDetailVersion":first["detailVersion"]});
    assert_eq!(read(&mut store,&model,"import_job_get",input.clone())["notModified"],true);
    let opened = read(&mut store,&model,"import_get",input);
    assert_eq!(opened["import"],record);
    assert!(opened["teachingControls"].is_object());
    assert_ne!(opened["notModified"],true);
}

#[test]
fn orphan_recovery_precedes_snapshot_comparison_and_preserves_successful_checkpoints() {
    let (_dir, mut store, model, mut record) = fixture();
    record["backgroundJob"]["status"] = json!("running");
    record["status"] = json!("processing");
    record["extractedPages"] = json!(["模拟已保存的OCR，不重新识别"]);
    store.put_document("imports",s(&record,"importId"),&record).unwrap();
    let result = read(&mut store,&model,"import_job_get",
        json!({"importId":record["importId"],"knownDetailVersion":sha(record.to_string().as_bytes())}));
    assert_ne!(result["notModified"],true);
    assert_eq!(result["job"]["status"],"interrupted");
    assert_eq!(result["import"]["error"]["code"],"import_interrupted");
    assert_eq!(result["import"]["extractedPages"],record["extractedPages"]);
    assert_eq!(result["import"]["revision"],8);
}

#[test]
fn known_snapshot_never_bypasses_document_identity_or_missing_records() {
    let (_dir, mut store, model, record) = fixture();
    let full = read(&mut store,&model,"import_job_get",json!({"importId":record["importId"]}));
    for (id, code) in [("", "invalid_document"),("bad\nidentity", "invalid_document"),("simulated-missing", "not_found")] {
        let error = crate::imports::dispatch(&mut store,&model,"import_job_get",
            &json!({"importId":id,"knownDetailVersion":full["detailVersion"]}),&AtomicBool::new(false)).unwrap_err();
        assert_eq!(error.code,code);
    }
    let mut other = record.clone();other["importId"]=json!("simulated-other");
    store.put_document("imports",s(&other,"importId"),&other).unwrap();
    let result = read(&mut store,&model,"import_job_get",
        json!({"importId":other["importId"],"knownDetailVersion":full["detailVersion"]}));
    assert_eq!(result["import"],other);
    assert_ne!(result["notModified"],true);
}
