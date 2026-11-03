//! Real localhost HTTP and isolated SQLite regressions; scripted opinions do
//! not establish model accuracy or teacher acceptance.
use super::tests::{Provider, Scenario, fixture};
use super::*;

pub(super) fn combined_fixture(
    provider: &Provider,
) -> (tempfile::TempDir, Store, ModelClient, Value) {
    let (directory, store, mut model, mut record) = fixture(provider);
    model.save(&json!({"expectedRevision":model.public_settings()["revision"],"activeProfileId":"processor","profiles":[
        {"id":"processor","name":"模拟DS处理","baseUrl":provider.endpoint,"model":"simulated-processor","apiKey":"simulated-processing-key"},
        {"id":"reviewer","name":"模拟Qwen复核","baseUrl":provider.endpoint,"model":"simulated-reviewer","apiKey":"simulated-review-key"}],
        "importRoles":{"sourceParsing":"processor","teachingGeneration":"processor","teachingReview":"reviewer","sourceVerification":null,"independentSolve":null,"mathVerification":null,"teachingVerification":null}})).unwrap();
    // A distinct simulated upload starts a new root budget; the legacy fixture
    // remains untouched instead of pretending its prior run never existed.
    let bytes = read_source(&store, &record).unwrap();
    record["importId"] = json!("simulated-combined-pipeline");
    record["source"] = save_source(&store, "simulated-combined-pipeline", "txt", &bytes).unwrap();
    record.as_object_mut().unwrap().remove("accuracyRunId");
    initialize_run(&store, &model, &mut record).unwrap();
    store
        .put_document("imports", s(&record, "importId"), &record)
        .unwrap();
    (directory, store, model, record)
}

#[test]
fn two_real_requests_use_only_processing_and_review_models_and_replay_without_blind_claims() {
    let provider = Provider::start(Scenario::Clean);
    let (_dir, mut store, model, mut record) = combined_fixture(&provider);
    process(&mut store, &model, &mut record, &AtomicBool::new(false)).unwrap();
    let q = record["questions"][0].clone();
    let run = run_for(&store, &record).unwrap();
    assert_eq!(run["strategyVersion"], VERSION);
    assert_eq!(
        run["strategy"]["stages"],
        json!(["generation", "verification"])
    );
    assert_eq!(run["strategy"]["independentBlindSolve"], false);
    let sent = provider.sent();
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0].1["model"], "simulated-processor");
    assert!(sent[0].0.contains("simulated-processing-key"));
    assert_eq!(sent[1].1["model"], "simulated-reviewer");
    assert!(sent[1].0.contains("simulated-review-key"));
    let value = state(&store, &record, &q).unwrap();
    assert!(value["independent"].is_null());
    assert_eq!(
        value["solution"]["combinedResponse"],
        value["metadata"]["combinedResponse"]
    );
    assert_eq!(
        value["source"]["combinedResponse"],
        value["math"]["combinedResponse"]
    );
    assert_eq!(
        value["math"]["combinedResponse"],
        value["teaching"]["combinedResponse"]
    );
    assert_eq!(run["budgetState"]["usedCalls"], 2);
    verify_question(&store, &record, &q).unwrap();
    let manifest = super::super::build_manifest(&store, &record).unwrap();
    verify_manifest(&store, &record, &manifest).unwrap();
    process(&mut store, &model, &mut record, &AtomicBool::new(false)).unwrap();
    assert_eq!(
        provider.sent().len(),
        2,
        "accepted exact-input evidence is reused"
    );
    assert_eq!(
        read_source(&store, &record).unwrap(),
        read_source(&store, &record).unwrap()
    );
}

#[test]
fn each_report_domain_still_blocks_publication_after_one_combined_review() {
    for scenario in [
        Scenario::SourceIssue,
        Scenario::MathIssue,
        Scenario::TeachingIssue,
        Scenario::TeachingMetadataIssue,
    ] {
        let provider = Provider::start(scenario);
        let (_dir, mut store, model, mut record) = combined_fixture(&provider);
        process(&mut store, &model, &mut record, &AtomicBool::new(false)).unwrap();
        assert_eq!(provider.sent().len(), 2);
        let q = &record["questions"][0];
        assert!(!eligible(&store, &record, q).unwrap());
        assert_eq!(
            verify_question(&store, &record, q).unwrap_err().code,
            "review_required"
        );
        let view = project_record(&store, &record).unwrap();
        assert!(!rows(&view["questions"][0]["accuracy"]["findings"]).is_empty());
    }
}

#[test]
fn merged_generation_rejects_extra_math_fields_in_metadata_without_partial_adoption() {
    let provider = Provider::start(Scenario::MetadataOverwrite);
    let (_dir, mut store, model, mut record) = combined_fixture(&provider);
    process(&mut store, &model, &mut record, &AtomicBool::new(false)).unwrap();
    assert_eq!(
        provider.sent().len(),
        1,
        "invalid candidate cannot reach review"
    );
    let value = state(&store, &record, &record["questions"][0]).unwrap();
    assert!(value["generation"].is_null() && value["composition"].is_null());
    assert_eq!(value["lastError"]["code"], "accuracy_contract_invalid");
    assert_eq!(
        run_for(&store, &record).unwrap()["budgetState"]["usedCalls"],
        1
    );
}

#[test]
fn raw_combined_response_tampering_blocks_manifest_before_any_bank_write() {
    let provider = Provider::start(Scenario::Clean);
    let (_dir, mut store, model, mut record) = combined_fixture(&provider);
    process(&mut store, &model, &mut record, &AtomicBool::new(false)).unwrap();
    let q = record["questions"][0].clone();
    let value = state(&store, &record, &q).unwrap();
    let payload = artifact(&store, &value["verification"]).unwrap();
    let path = store
        .data_dir
        .join(s(&payload["audit"], "responseRelativePath"));
    let mut response: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    response["response"]["choices"][0]["message"]["content"] = json!("tampered");
    std::fs::write(path, serde_json::to_vec(&response).unwrap()).unwrap();
    let before = store.bank.questions().unwrap().len();
    assert_eq!(
        verify_question(&store, &record, &q).unwrap_err().code,
        "accuracy_integrity"
    );
    assert_eq!(store.bank.questions().unwrap().len(), before);
    assert_eq!(provider.sent().len(), 2);
}

#[test]
fn explicit_repair_is_bounded_and_runs_one_new_combined_review_without_regeneration() {
    let provider = Provider::start(Scenario::MathIssue);
    let (_dir, mut store, model, mut record) = combined_fixture(&provider);
    process(&mut store, &model, &mut record, &AtomicBool::new(false)).unwrap();
    let q = record["questions"][0].clone();
    let mut value = state(&store, &record, &q).unwrap();
    let initial = value["generation"].clone();
    runner::repair(
        &store,
        &model,
        &record,
        &q,
        &mut value,
        "模拟：修正加法证明中明确指定的步骤缺口。",
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(
        provider.sent().len(),
        4,
        "candidate+review, explicit repair+review only"
    );
    assert_eq!(value["repairOriginal"], initial);
    assert_eq!(value["repairCalls"], 1);
    assert_eq!(value["generationOrigin"], "repair");
    assert_eq!(
        runner::repair(
            &store,
            &model,
            &record,
            &q,
            &mut value,
            "模拟：不能重复使用本题已消耗修订额度。",
            &AtomicBool::new(false)
        )
        .unwrap_err()
        .code,
        "accuracy_repair_exhausted"
    );
    assert_eq!(provider.sent().len(), 4);
    let sent = provider.sent();
    assert_eq!(sent[2].1["model"], "simulated-reviewer");
    assert_eq!(sent[3].1["model"], "simulated-reviewer");
}

#[test]
fn new_pipeline_requires_explicit_two_entry_bindings_and_freezes_review_model() {
    let provider = Provider::start(Scenario::Clean);
    let (_dir, mut store, mut model, mut record) = combined_fixture(&provider);
    let settings = model.public_settings();
    model.save(&json!({"expectedRevision":settings["revision"],"importRoles":{"sourceParsing":"reviewer","teachingGeneration":"processor","teachingReview":"reviewer"}})).unwrap();
    assert_eq!(
        validate_configuration(&model).unwrap_err().code,
        "import_processing_model_mismatch"
    );
    model.save(&json!({"expectedRevision":model.public_settings()["revision"],"importRoles":{"sourceParsing":"processor","teachingGeneration":"processor","teachingReview":"processor"}})).unwrap();
    assert_eq!(
        process(&mut store, &model, &mut record, &AtomicBool::new(false))
            .unwrap_err()
            .code,
        "accuracy_configuration_changed"
    );
    assert_eq!(
        provider.sent().len(),
        1,
        "generation checkpoint survives a changed reviewer without contacting it"
    );
    model.save(&json!({"expectedRevision":model.public_settings()["revision"],"importRoles":{"sourceParsing":"processor","teachingGeneration":"processor","teachingReview":"reviewer"}})).unwrap();
    process(&mut store, &model, &mut record, &AtomicBool::new(false)).unwrap();
    assert_eq!(provider.sent().len(), 2);
}

fn action_payload(store: &Store, record: &Value, operation: &str) -> Value {
    let projected = project_record(store, record).unwrap();
    let view = &projected["questions"][0]["accuracy"];
    json!({"importId":record["importId"],"expectedRevision":record["revision"],"questionId":record["questions"][0]["questionId"],"operationId":operation,"acknowledge":true,"sourceSha256":view["sourceSha256"],"candidateSha256":view["candidateSha256"]})
}

#[test]
fn failed_combined_report_can_be_replaced_by_all_actual_teacher_domains_for_both_scopes() {
    for scope in ["source_and_teaching", "source_only"] {
        let provider = Provider::start(Scenario::CombinedReportInvalid);
        let (_dir, mut store, model, mut record) = combined_fixture(&provider);
        process(&mut store, &model, &mut record, &AtomicBool::new(false)).unwrap();
        assert_eq!(provider.sent().len(), 2);
        let value = state(&store, &record, &record["questions"][0]).unwrap();
        assert!(value["verification"].is_null());
        assert!(value["lastError"].is_object());
        let mut payload = action_payload(&store, &record, "simulated-choose-publication-scope");
        payload["publicationScope"] = json!(scope);
        dispatch(
            &mut store,
            &model,
            "import_accuracy_scope_save",
            &payload,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
        for domain in ["source", "math", "teaching"] {
            record = store.document("imports", s(&record, "importId")).unwrap();
            let mut payload = action_payload(
                &store,
                &record,
                &format!("simulated-concrete-teacher-{domain}"),
            );
            payload["domain"] = json!(domain);
            payload["basis"] = json!(format!(
                "模拟教师实质核对{domain}：逐项对照原卷、17+25实际计算及真实目录确认本次字段。"
            ));
            dispatch(
                &mut store,
                &model,
                "import_accuracy_review",
                &payload,
                &AtomicBool::new(false),
            )
            .unwrap()
            .unwrap();
            record = store.document("imports", s(&record, "importId")).unwrap();
            if domain != "teaching" {
                assert!(!eligible(&store, &record, &record["questions"][0]).unwrap());
            }
        }
        let q = record["questions"][0].clone();
        assert!(eligible(&store, &record, &q).unwrap());
        verify_question(&store, &record, &q).unwrap();
        let manifest = super::super::build_manifest(&store, &record).unwrap();
        verify_manifest(&store, &record, &manifest).unwrap();
        let payload = json!({"importId":record["importId"],"expectedRevision":record["revision"],"operationId":"simulated-teacher-publication","acknowledgeReview":true});
        let published = super::super::publish(&store, &payload, &AtomicBool::new(false)).unwrap();
        assert_eq!(published["publication"]["addedQuestions"], 1);
        assert_eq!(provider.sent().len(), 2);
    }
}

#[test]
fn source_only_cannot_publish_merged_metadata_based_on_a_known_bad_candidate_solution() {
    let provider = Provider::start(Scenario::MathCandidateIssue);
    let (_dir, mut store, model, mut record) = combined_fixture(&provider);
    process(&mut store, &model, &mut record, &AtomicBool::new(false)).unwrap();
    let mut payload = action_payload(&store, &record, "simulated-withhold-bad-math-body");
    payload["publicationScope"] = json!("source_only");
    dispatch(
        &mut store,
        &model,
        "import_accuracy_scope_save",
        &payload,
        &AtomicBool::new(false),
    )
    .unwrap()
    .unwrap();
    record = store.document("imports", s(&record, "importId")).unwrap();
    let q = record["questions"][0].clone();
    let value = state(&store, &record, &q).unwrap();
    assert_eq!(
        checked_report(&store, &value, "source").unwrap()["status"],
        "no_issue_found"
    );
    assert_eq!(
        checked_report(&store, &value, "teaching").unwrap()["status"],
        "no_issue_found"
    );
    assert!(
        review_targets(&q, &value, "math").contains(&"candidate.solution".to_owned()),
        "teacher must actually check the solution underlying delivered metadata"
    );
    assert!(!eligible(&store, &record, &q).unwrap());
    assert_eq!(
        verify_question(&store, &record, &q).unwrap_err().code,
        "review_required"
    );
    assert_eq!(provider.sent().len(), 2);
}

#[test]
fn teaching_only_repair_cannot_change_verified_answer_and_keeps_original_candidate() {
    let provider = Provider::start(Scenario::CombinedMetadataRepairOverwrite);
    let (_dir, mut store, model, mut record) = combined_fixture(&provider);
    process(&mut store, &model, &mut record, &AtomicBool::new(false)).unwrap();
    let q = record["questions"][0].clone();
    let mut value = state(&store, &record, &q).unwrap();
    let generation = value["generation"].clone();
    let composition = value["composition"].clone();
    let error = runner::repair(
        &store,
        &model,
        &record,
        &q,
        &mut value,
        "模拟：仅修正难度依据文字，保持已核对的答案解析。",
        &AtomicBool::new(false),
    )
    .unwrap_err();
    assert_eq!(error.code, "accuracy_repair_scope_violation");
    assert_eq!(value["generation"], generation);
    assert_eq!(value["composition"], composition);
    assert_eq!(value["repairCalls"], 1);
    assert_eq!(provider.sent().len(), 3);
    verify_question(&store, &record, &q).unwrap();
}

#[test]
fn combined_review_cannot_claim_unperformed_independent_solution_evidence() {
    let provider = Provider::start(Scenario::CombinedIndependentClaim);
    let (_dir, mut store, model, mut record) = combined_fixture(&provider);
    process(&mut store, &model, &mut record, &AtomicBool::new(false)).unwrap();
    let value = state(&store, &record, &record["questions"][0]).unwrap();
    assert_eq!(provider.sent().len(), 2);
    assert!(value["verification"].is_null());
    assert_eq!(value["lastError"]["code"], "accuracy_contract_invalid");
    assert!(s(&value["lastError"], "message").contains("未执行独立盲解"));
}
