//! Isolated state/HTTP regressions for real teacher evidence replacing a
//! missing model opinion. These are simulated cases, not mathematical truth.
use super::tests::{Provider, Scenario, fixture};
use super::*;

fn teacher_report(store: &mut Store, model: &ModelClient, record: &Value, domain: &str) -> Value {
    let view = project_record(store, record).unwrap();
    let q = &view["questions"][0];
    let payload = json!({"importId":record["importId"],"expectedRevision":record["revision"],"operationId":format!("simulated-missing-{domain}-teacher-report"),"questionId":q["questionId"],"domain":domain,"basis":"模拟教师实际对照原页逐项核题干和原参考，并独立计算17+25=42，已核对必要条件与完整推导。","acknowledge":true,"sourceSha256":q["accuracy"]["sourceSha256"],"candidateSha256":q["accuracy"]["candidateSha256"]});
    dispatch(
        store,
        model,
        "import_accuracy_review",
        &payload,
        &AtomicBool::new(false),
    )
    .unwrap()
    .unwrap();
    store.document("imports", s(record, "importId")).unwrap()
}

fn stages(provider: &Provider) -> Vec<String> {
    provider
        .sent()
        .iter()
        .map(|(_, body, _)| {
            let context: Value =
                serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
            if context.get("originalPages").is_some() {
                "source"
            } else if context.get("independent").is_some() {
                "math"
            } else if context.get("metadata").is_some() {
                "teaching"
            } else if context.get("catalogue").is_some() {
                "metadata"
            } else if context.get("originalReference").is_some() {
                "solution"
            } else {
                "independent"
            }
            .to_owned()
        })
        .collect()
}

#[test]
fn source_presence_cannot_claim_original_content_present_when_the_candidate_has_lost_it() {
    let q = json!({"answer":"","solution":"","parts":[],"student":{"assets":[]},"teacher":{"assets":[]}});
    let report = json!({"status":"no_issue_found","referencePresence":{"answer":"present","solution":"absent"},"assetDisclosures":[]});
    assert!(runner::validate_source_report(&q, &report).is_err());
    let mut reported_issue = report;
    reported_issue["status"] = json!("issues_found");
    reported_issue["findings"] = json!([{"id":"lost-original-answer","fieldPath":"answer","message":"模拟原页有答案，当前候选未提取。","basis":"模拟原页答案区明确写42，而候选为空。"}]);
    runner::validate_source_report(&q, &reported_issue).unwrap();
}

#[test]
fn teacher_source_report_replaces_missing_model_artifact_and_continues_without_a_source_call() {
    let provider = Provider::start(Scenario::Clean);
    let (_directory, mut store, model, mut record) = fixture(&provider);
    let q = record["questions"][0].clone();
    // A transport/protocol failure has left no accepted source report. The
    // teacher supplies their own evidence; no fake model receipt is created.
    let value = json!({"sourceSha256":source_sha(&q),"repairCalls":0,"lastError":{"code":"model_error","message":"模拟：来源核对尚未取得模型意见。"}});
    save_state(&store, &record, &q, &value).unwrap();
    record = teacher_report(&mut store, &model, &record, "source");
    process(&mut store, &model, &mut record, &AtomicBool::new(false)).unwrap();
    let sent = stages(&provider);
    assert_eq!(
        sent,
        ["solution", "independent", "math", "metadata", "teaching"]
    );
    assert!(state(&store, &record, &q).unwrap()["source"].is_null());
    verify_question(&store, &record, &q).unwrap();
    assert_eq!(
        provider.sent().len(),
        5,
        "publication verification must not acquire a replacement model opinion"
    );
    super::super::publish(&store,&json!({"importId":record["importId"],"expectedRevision":record["revision"],"operationId":"simulated-manual-source-real-publish","acknowledgeReview":true}),&AtomicBool::new(false)).unwrap();
    let published = store.bank.question(s(&q, "questionId")).unwrap();
    assert_eq!(published["verification"]["method"], "teacher_review");
    assert_eq!(published["teacher"]["answers"][0]["text"], q["answer"]);
    assert_eq!(provider.sent().len(), 5);
}

#[test]
fn teacher_math_report_replaces_absent_model_result_and_metadata_does_not_invalidate_it() {
    let provider = Provider::start(Scenario::MathIssue);
    let (_directory, mut store, model, mut record) = fixture(&provider);
    let q = record["questions"][0].clone();
    process(&mut store, &model, &mut record, &AtomicBool::new(false)).unwrap();
    assert_eq!(provider.sent().len(), 4);
    let mut value = state(&store, &record, &q).unwrap();
    // The existing failed attempt remains in the execution/audit store; there
    // is no accepted model report to require as the teacher's prerequisite.
    value["math"] = Value::Null;
    value["lastError"] =
        json!({"code":"model_error","message":"模拟：数学核对没有可采纳模型意见。"});
    save_state(&store, &record, &q, &value).unwrap();
    record = teacher_report(&mut store, &model, &record, "math");
    process(&mut store, &model, &mut record, &AtomicBool::new(false)).unwrap();
    assert_eq!(
        stages(&provider),
        [
            "source",
            "solution",
            "independent",
            "math",
            "metadata",
            "teaching"
        ]
    );
    assert!(state(&store, &record, &q).unwrap()["math"].is_null());
    assert_eq!(
        checked_report(&store, &state(&store, &record, &q).unwrap(), "math").unwrap()["status"],
        "teacher_reviewed"
    );
    verify_question(&store, &record, &q).unwrap();
    assert_eq!(provider.sent().len(), 6);
}
