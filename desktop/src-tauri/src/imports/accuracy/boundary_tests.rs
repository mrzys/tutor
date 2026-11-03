//! Regression boundaries use isolated SQLite files and scripted localhost HTTP.
//! They establish process integrity, never measured mathematical accuracy.
use super::tests::{Provider, Scenario, fixture};
use super::*;
use base64::Engine;

fn completed(provider: &Provider) -> (tempfile::TempDir, Store, ModelClient, Value, Value) {
    let (directory, mut store, model, mut record) = fixture(provider);
    process(&mut store, &model, &mut record, &AtomicBool::new(false)).unwrap();
    let manifest = super::super::build_manifest(&store, &record).unwrap();
    verify_manifest(&store, &record, &manifest).unwrap();
    (directory, store, model, record, manifest)
}

#[test]
fn source_no_issue_report_cannot_claim_preserved_references_that_are_missing() {
    let empty = json!({"questionId":"simulated-omitted-reference","answer":"","solution":"","parts":[],"student":{"assets":[]},"teacher":{"assets":[]}});
    for (answer, solution) in [
        ("present", "absent"),
        ("absent", "present"),
        ("present", "present"),
    ] {
        let report = json!({"status":"no_issue_found","referencePresence":{"answer":answer,"solution":solution},"assetDisclosures":[]});
        assert_eq!(
            runner::validate_source_report(&empty, &report)
                .unwrap_err()
                .code,
            "invalid_accuracy_report"
        );
    }
    let absent = json!({"status":"no_issue_found","referencePresence":{"answer":"absent","solution":"absent"},"assetDisclosures":[]});
    runner::validate_source_report(&empty, &absent).unwrap();
    let mut present = empty.clone();
    present["parts"] = json!([{"partId":"p1","answer":"42","solution":"17+25=42"}]);
    assert!(runner::validate_source_report(&present, &absent).is_err());
}

#[test]
fn frozen_manifest_cannot_change_teacher_teaching_difficulty_or_knowledge_fields() {
    let provider = Provider::start(Scenario::Clean);
    let (_directory, store, _model, record, manifest) = completed(&provider);
    let bank_before = hash_json(&json!(store.bank.questions().unwrap()));
    let cases = [
        (
            "teacher answer",
            "/questions/0/teacher/answers/0/text",
            json!("SIMULATED_UNVERIFIED_REFERENCE"),
        ),
        (
            "teaching answer",
            "/configPatch/assemblyIndex/entries/0/teachingAnalysis/answer",
            json!("SIMULATED_UNVERIFIED_ANSWER"),
        ),
        (
            "teaching solution",
            "/configPatch/assemblyIndex/entries/0/teachingAnalysis/solution",
            json!("SIMULATED_UNVERIFIED_PROOF"),
        ),
        (
            "difficulty level",
            "/configPatch/assemblyIndex/entries/0/difficultyLevel",
            json!("hard"),
        ),
        (
            "difficulty basis",
            "/configPatch/assemblyIndex/entries/0/difficultyBasis",
            json!("模拟篡改后的难度说明。"),
        ),
        (
            "difficulty rubric",
            "/configPatch/assemblyIndex/entries/0/difficultyRubricVersion",
            json!("simulated-other-rubric"),
        ),
        (
            "primary knowledge",
            "/configPatch/assemblyIndex/entries/0/primaryKnowledgeUids",
            json!(["simulated-unverified-knowledge"]),
        ),
        (
            "primary sections",
            "/configPatch/assemblyIndex/entries/0/primarySections",
            json!(["simulated-unverified-section"]),
        ),
        (
            "solution paths",
            "/configPatch/assemblyIndex/entries/0/solutionPaths",
            json!([{"id":"simulated-injected-path","requiredKnowledgeUids":["simulated-unverified-knowledge"],"requiredPremises":[],"basis":"模拟未经核对的解法路径。"}]),
        ),
    ];
    let mut escaped = vec![];
    for (label, pointer, replacement) in cases {
        let mut changed = manifest.clone();
        *changed
            .pointer_mut(pointer)
            .unwrap_or_else(|| panic!("missing baseline field: {pointer}")) = replacement;
        if verify_manifest(&store, &record, &changed).is_ok() {
            escaped.push(label);
        }
    }
    assert!(
        escaped.is_empty(),
        "unverified frozen fields were accepted: {escaped:?}"
    );
    assert_eq!(
        hash_json(&json!(store.bank.questions().unwrap())),
        bank_before
    );
    assert_eq!(
        provider.sent().len(),
        6,
        "manifest reads must not call the provider"
    );
}

#[test]
fn frozen_manifest_cannot_smuggle_task_and_mapping_side_vectors() {
    let provider = Provider::start(Scenario::Clean);
    let (_directory, store, _model, record, manifest) = completed(&provider);
    let qid = record["questions"][0]["questionId"].clone();
    let task = json!({"id":"simulated-injected-task","label":"模拟未核对任务","questionType":"fill_blank","sectionIds":[],"partIds":[],"partWeights":[]});
    let cases = [
        (
            "entry task ids",
            "/configPatch/assemblyIndex/entries/0/tasks",
            json!(["simulated-injected-task"]),
        ),
        ("config tasks", "/configPatch/tasks", json!([task])),
        (
            "section mappings",
            "/sectionMappings",
            json!([{"questionId":qid,"sectionId":"simulated-injected-section","position":0}]),
        ),
        (
            "knowledge mappings",
            "/knowledgeMappings",
            json!([{"questionId":qid,"knowledgeUid":"simulated-injected-knowledge","topic":"模拟未知知识","status":"model_mapped","basis":"模拟未经核对的旁路映射。","role":"primary","solutionPathId":null}]),
        ),
    ];
    let mut escaped = vec![];
    for (label, pointer, replacement) in cases {
        let mut changed = manifest.clone();
        *changed.pointer_mut(pointer).unwrap() = replacement;
        if verify_manifest(&store, &record, &changed).is_ok() {
            escaped.push(label);
        }
    }
    assert!(
        escaped.is_empty(),
        "unverified frozen side vectors were accepted: {escaped:?}"
    );
    assert_eq!(provider.sent().len(), 6);
}

#[test]
fn frozen_manifest_cannot_change_source_identity_or_other_final_envelope_fields() {
    let provider = Provider::start(Scenario::Clean);
    let (_directory, store, _model, record, manifest) = completed(&provider);
    let cases = [
        (
            "question type",
            "/questions/0/questionType",
            json!("free_response"),
        ),
        (
            "source label",
            "/questions/0/sourceRefs/0/label",
            json!("SIMULATED_WRONG_SOURCE_LABEL"),
        ),
        (
            "source page",
            "/questions/0/sourceRefs/0/pages",
            json!([99]),
        ),
        (
            "source identity",
            "/questions/0/sourceIdentity",
            json!({"system":"simulated-unverified-source","questionId":"different-source"}),
        ),
        (
            "content hash",
            "/questions/0/contentSha256",
            json!("0".repeat(64)),
        ),
        (
            "teacher hash",
            "/questions/0/teacherSha256",
            json!("0".repeat(64)),
        ),
        (
            "source filename",
            "/configPatch/sources/0/filename",
            json!("模拟错原卷.txt"),
        ),
        (
            "source hash",
            "/configPatch/sources/0/sha256",
            json!("0".repeat(64)),
        ),
        (
            "source path",
            "/configPatch/sources/0/path",
            json!("imports/simulated-other-import/source.txt"),
        ),
        ("teacher authority flag", "/teacherConfirmed", json!(true)),
        (
            "publication acknowledgement",
            "/userConfirmedPublication",
            json!(false),
        ),
        (
            "verification reviewer",
            "/questions/0/verification/checkedBy",
            json!("local_teacher"),
        ),
    ];
    let mut escaped = vec![];
    for (label, pointer, replacement) in cases {
        let mut changed = manifest.clone();
        let (parent, key) = pointer.rsplit_once('/').unwrap();
        let object = changed
            .pointer_mut(parent)
            .unwrap()
            .as_object_mut()
            .unwrap();
        object.insert(key.to_owned(), replacement);
        if verify_manifest(&store, &record, &changed).is_ok() {
            escaped.push(label);
        }
    }
    assert!(
        escaped.is_empty(),
        "unbound final envelope fields were accepted: {escaped:?}"
    );
}

#[test]
fn concrete_teacher_domain_evidence_replaces_missing_model_reports_without_new_calls() {
    let provider = Provider::start(Scenario::Clean);
    let (_directory, mut store, model, mut record, _manifest) = completed(&provider);
    let q = record["questions"][0].clone();
    for domain in ["source", "math", "teaching"] {
        let mut value = state(&store, &record, &q).unwrap();
        value[domain] = Value::Null;
        if domain == "math" {
            value["independent"] = Value::Null;
        }
        save_state(&store, &record, &q, &value).unwrap();
        assert!(
            !eligible(&store, &record, &q).unwrap(),
            "{domain} model report is deliberately unavailable"
        );
        let payload = json!({"importId":record["importId"],"questionId":q["questionId"],"operationId":format!("simulated-manual-replaces-{domain}"),
            "expectedRevision":record["revision"],"sourceSha256":source_sha(&q),"candidateSha256":projection::candidate_sha(&store,&value).unwrap(),
            "domain":domain,"acknowledge":true,"basis":format!("模拟教师实质核对 {domain}：逐项对照原卷17+25、保留参考42及当前候选，核算17+20+5=42并确认教学字段对应本题。")});
        let result = dispatch(
            &mut store,
            &model,
            "import_accuracy_review",
            &payload,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
        record = store.document("imports", s(&record, "importId")).unwrap();
        assert_eq!(
            result["import"]["questions"][0]["accuracy"]["status"], "ready",
            "{domain}"
        );
        let current = state(&store, &record, &q).unwrap();
        assert!(current[domain].is_null());
        let report = artifact(&store, &current[format!("{domain}Manual")]).unwrap();
        assert_eq!(report["status"], "teacher_reviewed");
        assert_eq!(report["checkedBy"], "teacher");
        verify_question(&store, &record, &q).unwrap();
        let manifest = super::super::build_manifest(&store, &record).unwrap();
        verify_manifest(&store, &record, &manifest).unwrap();
        assert_eq!(
            manifest["questions"][0]["verification"]["method"],
            "teacher_review"
        );
        assert_eq!(
            manifest["questions"][0]["verification"]["checkedBy"],
            "local_teacher"
        );
        assert!(
            s(&manifest["questions"][0]["verification"], "basis")
                .contains("模拟教师实质核对 source")
        );
        assert_eq!(
            manifest["questions"][0]["teacher"]["answers"][0]["provenance"],
            "teacher_review"
        );
        assert_eq!(manifest["teacherConfirmed"], true);
    }
    let payload = json!({"importId":record["importId"],"expectedRevision":record["revision"],"operationId":"simulated-publish-concrete-teacher-evidence","acknowledgeReview":true});
    let published = super::super::publish(&store, &payload, &AtomicBool::new(false)).unwrap();
    assert_eq!(published["publication"]["addedQuestions"], 1);
    assert_eq!(
        store.bank.question(s(&q, "questionId")).unwrap()["verification"]["method"],
        "teacher_review"
    );
    assert_eq!(
        provider.sent().len(),
        6,
        "teacher evidence must not trigger hidden model calls"
    );
}

fn fresh_source_with_known_thinking() -> (tempfile::TempDir, Store, ModelClient, Value) {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path(), &crate::bank::tests::seed()).unwrap();
    let roles = json!({"sourceParsing":"simulated-ds","teachingGeneration":"simulated-ds","teachingReview":"simulated-ds","sourceVerification":"simulated-ds","independentSolve":"simulated-ds","mathVerification":"simulated-ds","teachingVerification":"simulated-ds"});
    let protected = base64::engine::general_purpose::STANDARD
        .encode(crate::model::secret_bytes(b"simulated-never-used-key", false).unwrap());
    let settings = json!({"schemaVersion":2,"revision":1,"activeProfileId":"simulated-ds","profiles":[{"id":"simulated-ds","name":"模拟只读配置","baseUrl":"https://api.deepseek.com","model":"deepseek-flash","reasoningEffort":"low","protectedKey":protected}],"importRoles":roles});
    std::fs::write(
        directory.path().join("model-settings.json"),
        serde_json::to_vec(&settings).unwrap(),
    )
    .unwrap();
    let model = ModelClient::open(directory.path()).unwrap();
    let source = save_source(
        &store,
        "simulated-fresh-source-retry",
        "txt",
        b"simulated original source checkpoint",
    )
    .unwrap();
    let mut record = json!({"importId":"simulated-fresh-source-retry","filename":"模拟来源继续.txt","revision":1,"status":"failed","source":source,"sourceIssues":[],"questions":[],"publishedQuestionIds":[],"operations":[],"updatedAt":now(),"sourceStructuring":{"status":"partial","batches":[{"id":"simulated-complete-batch","status":"succeeded","rawAudit":"simulated-success-checkpoint"}]}});
    initialize_run(&store, &model, &mut record).unwrap();
    store
        .put_document("imports", s(&record, "importId"), &record)
        .unwrap();
    (directory, store, model, record)
}

#[test]
fn fresh_source_retry_rejects_changed_thinking_and_preserves_every_checkpoint_without_calls() {
    for effort in ["high", "low"] {
        let (_directory, mut store, mut model, record) = fresh_source_with_known_thinking();
        let original_identity = model
            .import_source_model()
            .unwrap()
            .import_execution_identity()
            .unwrap();
        let original_run = store::load_run(&store, s(&record, "accuracyRunId")).unwrap();
        let mut overrides =
            json!({"sourceParsing":null,"teachingGeneration":null,"teachingReview":null});
        overrides["sourceParsing"] = json!({"profileId":"simulated-ds","provider":"deepseek","model":"deepseek-flash","reasoningEffort":effort});
        model.save(&json!({"expectedRevision":model.public_settings()["revision"],"importRoleThinking":overrides})).unwrap();
        assert_eq!(
            original_identity,
            model
                .import_source_model()
                .unwrap()
                .import_execution_identity()
                .unwrap(),
            "provider/model identity alone misses thinking changes"
        );
        let payload = json!({"importId":record["importId"],"expectedRevision":record["revision"],"operationId":format!("simulated-source-thinking-{effort}")});
        match super::super::stage_import(&mut store, &model, &payload, &AtomicBool::new(false)) {
            Err(error) => assert_eq!(error.code, "accuracy_configuration_changed"),
            Ok(_) => panic!("fresh source retry accepted changed reasoning {effort}"),
        }
        assert_eq!(
            store.document("imports", s(&record, "importId")).unwrap(),
            record
        );
        assert_eq!(
            store::load_run(&store, s(&record, "accuracyRunId")).unwrap(),
            original_run
        );
        assert!(
            store::list_executions(&store, s(&record, "accuracyRunId"))
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            std::fs::read(store.data_dir.join(s(&record["source"], "relativePath"))).unwrap(),
            b"simulated original source checkpoint"
        );
    }
}

fn rich_knowledge_seed() -> Value {
    let mut seed = crate::bank::tests::seed();
    let baseline = seed["config"].clone();
    seed["config"]["chapters"] = json!([{"id":"simulated-section","label":"模拟加法小节"}]);
    let question = seed["questions"][0].clone();
    let raw = json!([{"question_id":question["questionId"],"payload":question.to_string(),"sha256":hash_json(&question),"content_version":question["contentVersion"],"teacher_version":question["teacherVersion"]}]);
    let point = json!({"uid":"M-SIM-ADD","name":"模拟加法","parentUid":null,"isLeaf":true});
    seed["bankSnapshot"] = json!({"schemaVersion":1,"questions":raw,"ledger":{"entries":[{"questionId":question["questionId"],"status":"ready"}]},
        "tables":{"question_bank_questions":raw,"knowledge_points":[{"knowledge_uid":"M-SIM-ADD","name":"模拟加法","parent_uid":null,"is_leaf":1,"payload":point.to_string(),"sha256":hash_json(&point)}],
        "curriculum_sections":[{"section_id":"simulated-section","chapter_id":"simulated-chapter","payload":"{\"id\":\"simulated-section\",\"title\":\"模拟加法小节\"}"}],
        "section_knowledge_mappings":[{"section_id":"simulated-section","knowledge_uid":"M-SIM-ADD","relation":"introduces"}]},
        "counts":{"ready":1,"pending":0,"questionRows":1,"sourceUnits":1}});
    seed["migration"] = json!({"id":"simulated-accuracy-boundary-knowledge-v1","baselineConfig":baseline,"baselineConfigSha256":hash_json(&baseline)});
    seed["migration"]["manifestSha256"] = json!(hash_json(
        &json!({"config":seed["config"],"questions":seed["questions"],"bankSnapshot":seed["bankSnapshot"]})
    ));
    seed
}

#[test]
fn committed_publication_replays_only_its_exact_pending_manifest_with_new_task_and_nonempty_primary()
 {
    let provider = Provider::start(Scenario::RichKnowledge);
    let (directory, initial_store, model, mut record) = fixture(&provider);
    drop(initial_store);
    let mut store = Store::open(directory.path(), &rich_knowledge_seed()).unwrap();
    process(&mut store, &model, &mut record, &AtomicBool::new(false)).unwrap();
    let manifest = super::super::build_manifest(&store, &record).unwrap();
    assert_eq!(
        manifest["configPatch"]["assemblyIndex"]["entries"][0]["primaryKnowledgeUids"],
        json!(["M-SIM-ADD"])
    );
    assert_eq!(rows(&manifest["configPatch"]["tasks"]).len(), 1);
    assert_eq!(rows(&manifest["knowledgeMappings"]).len(), 1);
    verify_manifest(&store, &record, &manifest).unwrap();
    let payload = json!({"operationId":"simulated-committed-exact-replay","importId":record["importId"],"expectedRevision":record["revision"],"acknowledgeReview":true});
    record["pendingPublication"] = json!({"operationId":payload["operationId"],"payloadHash":hash_json(&payload),"payload":payload,"manifest":manifest});
    store
        .put_document("imports", s(&record, "importId"), &record)
        .unwrap();
    let receipt = store
        .bank
        .publish_accuracy_import(s(&payload, "operationId"), &manifest)
        .unwrap();
    assert_eq!(receipt["addedQuestions"], 1);
    assert_eq!(
        store.bank.config().unwrap()["tasks"][0]["id"],
        manifest["configPatch"]["tasks"][0]["id"]
    );
    let replayed =
        super::super::build_accuracy_manifest_for_replay(&store, &record, &manifest).unwrap();
    assert_eq!(
        replayed, manifest,
        "own newly published task and self duplicate do not invalidate the same operation"
    );
    verify_manifest(&store, &record, &manifest).unwrap();
    let final_receipt = super::super::publish(&store, &payload, &AtomicBool::new(false)).unwrap();
    assert_eq!(final_receipt["publication"]["replayed"], true);
    assert_eq!(store.bank.questions().unwrap().len(), 2);
    assert_eq!(provider.sent().len(), 6);
    let mut wrong_pending = record.clone();
    wrong_pending["pendingPublication"]["operationId"] = json!("simulated-different-op");
    assert!(
        super::super::build_accuracy_manifest_for_replay(&store, &wrong_pending, &manifest)
            .is_err(),
        "an unrelated pending operation cannot hide duplicates"
    );
}

fn set_scope(
    store: &mut Store,
    model: &ModelClient,
    record: &mut Value,
    selected: &str,
    operation: &str,
) -> Value {
    let q = record["questions"][0].clone();
    let value = state(store, record, &q).unwrap();
    let payload = json!({"importId":record["importId"],"questionId":q["questionId"],"operationId":operation,
        "expectedRevision":record["revision"],"sourceSha256":source_sha(&q),"candidateSha256":projection::candidate_sha(store,&value).unwrap(),
        "publicationScope":selected,"acknowledge":true,"basis":"模拟显式选择实际交付范围，并保留每个仍交付字段的具体核对依据。"});
    let result = dispatch(
        store,
        model,
        "import_accuracy_scope_save",
        &payload,
        &AtomicBool::new(false),
    )
    .unwrap()
    .unwrap();
    *record = store.document("imports", s(record, "importId")).unwrap();
    result
}

#[test]
fn saved_scope_matches_question_summary_full_eligibility_and_actual_publication_without_model_calls() {
    let provider = Provider::start(Scenario::TeachingIssue);
    let (_directory, mut store, model, mut record) = fixture(&provider);
    process(&mut store,&model,&mut record,&AtomicBool::new(false)).unwrap();
    let q = record["questions"][0].clone();
    let qid = s(&q,"questionId");
    assert_eq!(provider.sent().len(),6);
    for (index, selected) in ["source_only","source_and_teaching","source_only"].into_iter().enumerate() {
        let value = state(&store,&record,&q).unwrap();
        let payload = json!({"importId":record["importId"],"questionId":qid,"expectedRevision":record["revision"],
            "operationId":format!("simulated-scope-eligibility-{index}"),"sourceSha256":source_sha(&q),
            "candidateSha256":projection::candidate_sha(&store,&value).unwrap(),"publicationScope":selected,"acknowledge":true,"responseScope":"question"});
        let changed = super::super::dispatch(&mut store,&model,"import_accuracy_scope_save",&payload,&AtomicBool::new(false)).unwrap().unwrap();
        assert_eq!(changed["question"]["accuracy"]["publicationScope"],selected);
        assert_eq!(changed["reviewEligibility"][qid]["publicationScope"],selected);
        record = store.document("imports",s(&record,"importId")).unwrap();
        for action in ["import_summary_get","import_get"] {
            let read = super::super::dispatch(&mut store,&model,action,&json!({"importId":record["importId"]}),&AtomicBool::new(false)).unwrap().unwrap();
            assert_eq!(read["reviewEligibility"][qid]["publicationScope"],selected,"{action}");
            assert_eq!(read["reviewEligibility"][qid]["eligible"],selected=="source_only","{action}");
        }
        let mut untrusted_display = record.clone();
        untrusted_display["questions"][0]["accuracy"] = json!({"status":"ready","publicationScope":if selected=="source_only"{"source_and_teaching"}else{"source_only"}});
        let trusted = super::super::review_eligibility(&store,&untrusted_display).unwrap();
        assert_eq!(trusted[qid]["publicationScope"],selected,"scope comes from persisted process state");
        assert_eq!(trusted[qid]["eligible"],selected=="source_only");
        if selected=="source_only" {
            let manifest = super::super::build_manifest(&store,&record).unwrap();
            assert!(manifest["configPatch"]["assemblyIndex"]["entries"][0].get("teachingAnalysis").is_none());
            verify_manifest(&store,&record,&manifest).unwrap();
        } else {
            assert!(super::super::build_manifest(&store,&record).is_err(),"the excluded focus error blocks full scope again");
        }
    }
    let published = super::super::publish(&store,&json!({"importId":record["importId"],"expectedRevision":record["revision"],
        "operationId":"simulated-scope-eligibility-publish","acknowledgeReview":true}),&AtomicBool::new(false)).unwrap();
    assert_eq!(published["publication"]["addedQuestions"],1);
    let config = store.bank.config().unwrap();
    let entry = rows(&config["assemblyIndex"]["entries"]).into_iter().find(|entry|entry["questionId"]==qid).unwrap();
    assert!(entry.get("teachingAnalysis").is_none());
    assert_eq!(provider.sent().len(),6,"scope saves, reads and publication never make additional model calls");
}

#[test]
fn explicit_source_only_publishes_verified_original_and_keeps_actual_difficulty_knowledge_and_task()
{
    let provider = Provider::start(Scenario::RichKnowledge);
    let (directory, initial_store, model, mut record) = fixture(&provider);
    drop(initial_store);
    let mut store = Store::open(directory.path(), &rich_knowledge_seed()).unwrap();
    process(&mut store, &model, &mut record, &AtomicBool::new(false)).unwrap();
    let before = super::super::build_manifest(&store, &record).unwrap();
    assert!(before["configPatch"]["assemblyIndex"]["entries"][0]["teachingAnalysis"].is_object());
    let changed = set_scope(
        &mut store,
        &model,
        &mut record,
        "source_only",
        "simulated-select-source-only",
    );
    assert_eq!(
        changed["import"]["questions"][0]["accuracy"]["publicationScope"],
        "source_only"
    );
    let source_only = super::super::build_manifest(&store, &record).unwrap();
    let entry = &source_only["configPatch"]["assemblyIndex"]["entries"][0];
    assert!(entry.get("teachingAnalysis").is_none());
    for key in [
        "primaryKnowledgeUids",
        "primarySections",
        "solutionPaths",
        "tasks",
        "difficultyLevel",
        "difficultyBasis",
        "difficultyRubricVersion",
    ] {
        assert_eq!(
            entry[key], before["configPatch"]["assemblyIndex"]["entries"][0][key],
            "source_only still delivers {key}"
        );
    }
    for key in [
        "questionType",
        "student",
        "teacher",
        "sourceRefs",
        "contentVersion",
        "teacherVersion",
        "contentSha256",
        "teacherSha256",
    ] {
        assert_eq!(
            source_only["questions"][0][key], before["questions"][0][key],
            "selected scope preserves original {key}"
        );
    }
    verify_manifest(&store, &record, &source_only).unwrap();
    set_scope(
        &mut store,
        &model,
        &mut record,
        "source_and_teaching",
        "simulated-restore-full-scope",
    );
    let full = super::super::build_manifest(&store, &record).unwrap();
    assert_eq!(
        full["configPatch"]["assemblyIndex"]["entries"][0]["teachingAnalysis"],
        before["configPatch"]["assemblyIndex"]["entries"][0]["teachingAnalysis"]
    );
    set_scope(
        &mut store,
        &model,
        &mut record,
        "source_only",
        "simulated-final-source-only",
    );
    let payload = json!({"importId":record["importId"],"expectedRevision":record["revision"],"operationId":"simulated-publish-source-only","acknowledgeReview":true});
    let result = super::super::publish(&store, &payload, &AtomicBool::new(false)).unwrap();
    assert_eq!(result["publication"]["addedQuestions"], 1);
    let config = store.bank.config().unwrap();
    let published = rows(&config["assemblyIndex"]["entries"])
        .into_iter()
        .find(|entry| entry["questionId"] == record["questions"][0]["questionId"])
        .unwrap();
    assert!(published.get("teachingAnalysis").is_none());
    assert_eq!(published["primaryKnowledgeUids"], json!(["M-SIM-ADD"]));
    assert_eq!(published["difficultyLevel"], "easy");
    assert_eq!(
        provider.sent().len(),
        6,
        "scope changes and publication do not call models"
    );
}

#[test]
fn source_only_cannot_bypass_source_problem_math_validity_or_still_delivered_metadata() {
    for scenario in [
        Scenario::SourceIssue,
        Scenario::MathIssue,
        Scenario::TeachingMetadataIssue,
    ] {
        let provider = Provider::start(scenario);
        let (_directory, mut store, model, mut record) = fixture(&provider);
        process(&mut store, &model, &mut record, &AtomicBool::new(false)).unwrap();
        let sent = provider.sent().len();
        set_scope(
            &mut store,
            &model,
            &mut record,
            "source_only",
            "simulated-block-scope-bypass",
        );
        assert!(!eligible(&store, &record, &record["questions"][0]).unwrap());
        assert_eq!(
            super::super::build_manifest(&store, &record)
                .unwrap_err()
                .code,
            "review_required"
        );
        assert_eq!(provider.sent().len(), sent);
        assert_eq!(store.bank.questions().unwrap().len(), 1);
    }
}

#[test]
fn source_only_withholds_actual_focus_error_preserves_findings_and_publishes_remaining_checked_fields()
 {
    let provider = Provider::start(Scenario::TeachingIssue);
    let (_directory, mut store, model, mut record) = fixture(&provider);
    process(&mut store, &model, &mut record, &AtomicBool::new(false)).unwrap();
    let q = record["questions"][0].clone();
    let value = state(&store, &record, &q).unwrap();
    let report = artifact(&store, &value["teaching"]).unwrap();
    assert_eq!(report["result"]["status"], "issues_found");
    for target in [
        "primaryKnowledgeUids",
        "solutionPaths",
        "task",
        "difficultyAssessment",
    ] {
        assert!(
            rows(&report["result"]["checks"])
                .iter()
                .any(|check| check["target"] == target && check["status"] == "checked"),
            "still-delivered field {target} must actually be checked"
        );
    }
    assert_eq!(
        report["result"]["findings"][0]["fieldPath"],
        "teachingFocus.examFocus"
    );
    assert!(!eligible(&store, &record, &q).unwrap());
    assert!(super::super::build_manifest(&store, &record).is_err());
    let response = set_scope(
        &mut store,
        &model,
        &mut record,
        "source_only",
        "simulated-withhold-focus-only-error",
    );
    let shown = &response["import"]["questions"][0];
    assert_eq!(shown["accuracy"]["status"], "ready");
    assert!(
        !rows(&shown["accuracy"]["findings"]).is_empty(),
        "withheld error remains visible in process evidence"
    );
    assert!(
        rows(&shown["modelReview"]["issues"]).is_empty(),
        "compatibility opinion describes only actual delivered fields"
    );
    assert_eq!(
        artifact(&store, &value["teaching"]).unwrap(),
        report,
        "selecting a scope never rewrites the model report"
    );
    let manifest = super::super::build_manifest(&store, &record).unwrap();
    assert!(
        manifest["configPatch"]["assemblyIndex"]["entries"][0]
            .get("teachingAnalysis")
            .is_none()
    );
    assert_eq!(
        manifest["configPatch"]["assemblyIndex"]["entries"][0]["difficultyLevel"],
        "easy"
    );
    verify_manifest(&store, &record, &manifest).unwrap();
    let payload = json!({"importId":record["importId"],"expectedRevision":record["revision"],"operationId":"simulated-publish-withheld-focus-error","acknowledgeReview":true});
    let published = super::super::publish(&store, &payload, &AtomicBool::new(false)).unwrap();
    assert_eq!(published["publication"]["addedQuestions"], 1);
    assert_eq!(store.bank.questions().unwrap().len(), 2);
    let retained = state(&store, &record, &q).unwrap();
    assert_eq!(artifact(&store, &retained["teaching"]).unwrap(), report);
    assert_eq!(provider.sent().len(), 6);
}

#[test]
fn actual_txt_background_entry_omits_production_catalogue_from_source_and_runs_two_later_requests()
 {
    let provider = Provider::start(Scenario::Clean);
    let (directory, initial_store, model, _unused_original) = fixture(&provider);
    drop(initial_store);
    let seed: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../resources/seed.json"
    )))
    .unwrap();
    let mut store = Store::open(directory.path(), &seed).unwrap();
    let catalogue = trusted_catalog(&store).unwrap();
    assert!(rows(&catalogue["knowledgePoints"]).len() >= 509);
    assert!(rows(&catalogue["tasks"]).len() >= 340);
    let bank_before = store.bank.questions().unwrap().len();
    let original = "1. 隔离回归题：计算17+25。\n原答案：42（reference-answer-canary）\n原解析：17+25=42（reference-proof-canary）。";
    let input = json!({"operationId":"simulated-real-production-txt-entry","filename":"模拟生产目录TXT入口.txt","contentBase64":base64::engine::general_purpose::STANDARD.encode(original)});
    let accepted = super::super::dispatch(
        &mut store,
        &model,
        "import_accuracy_start",
        &input,
        &AtomicBool::new(false),
    )
    .unwrap()
    .unwrap();
    let id = s(&accepted["import"], "importId").to_owned();
    assert!(!id.is_empty());
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    let record = loop {
        let current = store.document("imports", &id).unwrap();
        if !matches!(s(&current["backgroundJob"], "status"), "queued" | "running") {
            break current;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "actual background TXT regression timed out: {current}"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
    assert_eq!(record["backgroundJob"]["status"], "completed", "{record}");
    assert_eq!(record["status"], "pending_review");
    let projected = project_record(&store, &record).unwrap();
    assert_eq!(
        projected["questions"][0]["accuracy"]["status"], "ready",
        "{projected}"
    );
    let sent = provider.sent();
    assert_eq!(
        sent.len(),
        3,
        "one actual transcription request and two real combined later requests"
    );
    let first = &sent[0].1;
    let context: Value =
        serde_json::from_str(first["messages"][1]["content"].as_str().unwrap()).unwrap();
    assert_eq!(context["accuracySourceOnly"], true);
    assert!(context.get("trustedCatalogue").is_none());
    assert_eq!(context["document"]["pages"][0]["text"], original);
    let prompt = first["messages"][0]["content"].as_str().unwrap();
    assert!(prompt.contains("只保真整理"));
    assert!(!prompt.contains("每题按同一内容难度标准重新估计"));
    let run = store::load_run(&store, s(&record, "accuracyRunId")).unwrap();
    assert_eq!(run["budgetState"]["usedCalls"], 3);
    assert_eq!(run["budgetState"]["roleCalls"]["sourceParsing"], 1);
    assert_eq!(read_source(&store, &record).unwrap(), original.as_bytes());
    let manifest = super::super::build_manifest(&store, &record).unwrap();
    verify_manifest(&store, &record, &manifest).unwrap();
    assert_eq!(
        store.bank.questions().unwrap().len(),
        bank_before,
        "teacher publication still requires its explicit step"
    );
    assert_eq!(provider.sent().len(), 3);
}

#[test]
fn manual_and_scope_action_detail_tokens_equal_the_next_unchanged_persisted_summary() {
    let provider = Provider::start(Scenario::Clean);
    let (_directory, mut store, model, mut record, _manifest) = completed(&provider);
    let q = record["questions"][0].clone();
    let value = state(&store, &record, &q).unwrap();
    let manual = json!({"importId":record["importId"],"questionId":q["questionId"],"operationId":"simulated-manual-response-token",
        "expectedRevision":record["revision"],"sourceSha256":source_sha(&q),"candidateSha256":projection::candidate_sha(&store,&value).unwrap(),
        "domain":"source","acknowledge":true,"basis":"模拟教师逐项对照实际原文，确认17+25题干、原参考42和解析17+25=42均完整保留。"});
    let first = super::super::dispatch(
        &mut store,
        &model,
        "import_accuracy_review",
        &manual,
        &AtomicBool::new(false),
    )
    .unwrap()
    .unwrap();
    let first_summary = super::super::dispatch(
        &mut store,
        &model,
        "import_summary_get",
        &json!({"importId":record["importId"]}),
        &AtomicBool::new(false),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        first["detailVersion"], first_summary["detailVersion"],
        "manual response hashes persisted source bytes, not its projected import JSON"
    );
    assert_eq!(
        first["import"]["revision"],
        first_summary["summary"]["revision"]
    );
    record = store.document("imports", s(&record, "importId")).unwrap();
    let value = state(&store, &record, &q).unwrap();
    let scope = json!({"importId":record["importId"],"questionId":q["questionId"],"operationId":"simulated-scope-response-token",
        "expectedRevision":record["revision"],"sourceSha256":source_sha(&q),"candidateSha256":projection::candidate_sha(&store,&value).unwrap(),
        "publicationScope":"source_only","acknowledge":true,"responseScope":"question"});
    let second = super::super::dispatch(
        &mut store,
        &model,
        "import_accuracy_scope_save",
        &scope,
        &AtomicBool::new(false),
    )
    .unwrap()
    .unwrap();
    let second_summary = super::super::dispatch(
        &mut store,
        &model,
        "import_summary_get",
        &json!({"importId":record["importId"]}),
        &AtomicBool::new(false),
    )
    .unwrap()
    .unwrap();
    assert_eq!(second["detailVersion"], second_summary["detailVersion"]);
    assert_eq!(
        second["question"]["accuracy"]["publicationScope"],
        "source_only"
    );
    assert_eq!(
        second["summary"]["revision"],
        second_summary["summary"]["revision"]
    );
    let unchanged = super::super::dispatch(
        &mut store,
        &model,
        "import_summary_get",
        &json!({"importId":record["importId"],"knownDetailVersion":second["detailVersion"]}),
        &AtomicBool::new(false),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        unchanged["notModified"], true,
        "no source or process changes require no detail refetch"
    );
    let delayed =
        super::super::views::finish(&store, first, &json!({"responseScope":"summary"})).unwrap();
    assert_eq!(delayed["detailVersion"], second_summary["detailVersion"]);
    assert_eq!(
        delayed["summary"], second_summary["summary"],
        "a delayed action projects current persisted content alongside its current token"
    );
    assert_eq!(provider.sent().len(), 6);
}

#[test]
fn strategy_continue_is_revision_bound_idempotent_and_keeps_twelve_prior_calls_without_source_replay()
 {
    let provider = Provider::start(Scenario::Clean);
    let (_directory, mut store, model, mut record) = fixture(&provider);
    let initial = store::load_run(&store, s(&record, "accuracyRunId")).unwrap();
    let mut prior_strategy = initial["strategy"].clone();
    prior_strategy["strategyVersion"] = json!("simulated-prior-source-full-layout-v1");
    prior_strategy["sourceProjection"] = json!("simulated-prior-full-ocr-layout");
    let mut budget = initial["operationBudget"].clone();
    budget["parentBudgetId"] = initial["id"].clone();
    let mut prior = store::create_run(
        &store,
        s(&record, "importId"),
        &prior_strategy,
        &initial["source"],
        &budget,
    )
    .unwrap();
    let qid = s(&record["questions"][0], "questionId").to_owned();
    prior["progress"]["questions"] = json!({});
    prior["progress"]["questions"][&qid] = json!({"repairCalls":1});
    let prior = store::save_run(&store, prior["revision"].as_u64().unwrap(), &prior).unwrap();
    record["accuracyRunId"] = prior["id"].clone();
    record["accuracyStrategy"] = prior_strategy["strategyVersion"].clone();
    // These twelve synthetic budget receipts represent source quota in this
    // fixture, not actual prior HTTP execution or mathematical verification.
    for index in 0..12 {
        let receipt=store::reserve_execution(&store,s(&prior,"id"),"sourceParsing","",&json!({"model":"simulated-source-quota-fixture","messages":[],"max_tokens":8,"fixtureIndex":index}),5,8,1).unwrap();
        store::finish_execution(
            &store,
            s(&receipt, "id"),
            "completed",
            &json!({"prompt_tokens":3,"completion_tokens":4}),
            &Value::Null,
        )
        .unwrap();
    }
    store::interrupt_run(&store, s(&prior, "id")).unwrap();
    record["status"] = json!("failed");
    record["error"] =
        json!({"code":"accuracy_input_budget","message":"模拟旧策略整页OCR文本超过来源核对上限。"});
    store
        .put_document("imports", s(&record, "importId"), &record)
        .unwrap();
    let saved = record.clone();
    let old_run = store::load_run(&store, s(&prior, "id")).unwrap();
    assert_eq!(old_run["budgetState"]["usedCalls"], 12);
    let before_count = store::list_runs_for_import(&store, s(&record, "importId"))
        .unwrap()
        .len();
    let payload = json!({"importId":record["importId"],"expectedRevision":record["revision"],"operationId":"simulated-strategy-continue-operation","acknowledge":true});
    let mut stale = payload.clone();
    stale["expectedRevision"] = json!(999);
    assert_eq!(
        super::super::background::stage_strategy_continue(&store, &model, &stale)
            .unwrap_err()
            .code,
        "revision_conflict"
    );
    let mut unconfirmed = payload.clone();
    unconfirmed["acknowledge"] = json!(false);
    assert_eq!(
        super::super::background::stage_strategy_continue(&store, &model, &unconfirmed)
            .unwrap_err()
            .code,
        "review_required"
    );
    assert_eq!(
        store.document("imports", s(&record, "importId")).unwrap(),
        saved
    );
    assert_eq!(
        store::list_runs_for_import(&store, s(&record, "importId"))
            .unwrap()
            .len(),
        before_count
    );
    for (code, field, value) in [
        (
            "import_running",
            "backgroundJob",
            json!({"mode":"import","status":"running"}),
        ),
        (
            "publication_pending",
            "pendingPublication",
            json!({"operationId":"simulated-other-pending"}),
        ),
        (
            "publication_pending",
            "pendingTeachingPublication",
            json!({"operationId":"simulated-other-teaching"}),
        ),
        (
            "immutable_question",
            "publishedQuestionIds",
            json!([qid.clone()]),
        ),
        ("accuracy_source_required", "questions", json!([])),
    ] {
        let mut blocked = saved.clone();
        blocked[field] = value;
        store
            .put_document("imports", s(&record, "importId"), &blocked)
            .unwrap();
        assert_eq!(
            super::super::background::stage_strategy_continue(&store, &model, &payload)
                .unwrap_err()
                .code,
            code
        );
        assert_eq!(
            store.document("imports", s(&record, "importId")).unwrap(),
            blocked
        );
    }
    let mut legacy = saved.clone();
    legacy.as_object_mut().unwrap().remove("accuracyRunId");
    store
        .put_document("imports", s(&record, "importId"), &legacy)
        .unwrap();
    assert_eq!(
        super::super::background::stage_strategy_continue(&store, &model, &payload)
            .unwrap_err()
            .code,
        "invalid_operation"
    );
    let mut changed_source = saved.clone();
    changed_source["source"]["sha256"] = json!("0".repeat(64));
    store
        .put_document("imports", s(&record, "importId"), &changed_source)
        .unwrap();
    assert!(super::super::background::stage_strategy_continue(&store, &model, &payload).is_err());
    store
        .put_document("imports", s(&record, "importId"), &saved)
        .unwrap();
    assert_eq!(
        store::list_runs_for_import(&store, s(&record, "importId"))
            .unwrap()
            .len(),
        before_count
    );
    let (queued, is_new) =
        super::super::background::stage_strategy_continue(&store, &model, &payload).unwrap();
    assert!(is_new);
    assert_eq!(queued["backgroundJob"]["mode"], "import");
    assert_eq!(queued["backgroundJob"]["status"], "queued");
    for key in [
        "source",
        "questions",
        "extractedPages",
        "ocrSource",
        "sourceStructuring",
    ] {
        assert_eq!(
            queued[key], saved[key],
            "saved source field {key} is reused unchanged"
        );
    }
    let next = store::load_run(&store, s(&queued, "accuracyRunId")).unwrap();
    assert_ne!(next["id"], old_run["id"]);
    assert_eq!(next["operationBudget"]["parentBudgetId"], old_run["id"]);
    assert_eq!(next["budgetState"]["usedCalls"], 0);
    assert_eq!(next["progress"]["questions"][&qid]["repairCalls"], 1);
    assert_eq!(store::load_run(&store, s(&prior, "id")).unwrap(), old_run);
    assert_eq!(
        queued["accuracyStrategyHistory"][0]["priorRunId"],
        old_run["id"]
    );
    assert_eq!(queued["accuracyStrategyHistory"][0]["newRunId"], next["id"]);
    let (replayed, is_new) =
        super::super::background::stage_strategy_continue(&store, &model, &payload).unwrap();
    assert!(!is_new);
    assert_eq!(replayed, queued);
    assert_eq!(
        store::list_runs_for_import(&store, s(&record, "importId"))
            .unwrap()
            .len(),
        before_count + 1
    );
    assert!(
        provider.sent().is_empty(),
        "accepting a strategy revision does not call a model"
    );
    let mut changed = payload.clone();
    changed["acknowledge"] = json!(false);
    assert_eq!(
        super::super::background::stage_strategy_continue(&store, &model, &changed)
            .unwrap_err()
            .code,
        "operation_conflict"
    );
    let bytes = read_source(&store, &queued).unwrap();
    super::super::process_import(
        &mut store,
        &model,
        s(&payload, "operationId"),
        &hash_json(&payload),
        &AtomicBool::new(false),
        queued.clone(),
        bytes,
    )
    .unwrap();
    let completed = store.document("imports", s(&queued, "importId")).unwrap();
    assert_eq!(
        completed["backgroundJob"]["status"], "completed",
        "{completed}"
    );
    assert_eq!(completed["questions"], saved["questions"]);
    assert_eq!(
        provider.sent().len(),
        6,
        "the cached source is followed only by the six accuracy stages"
    );
    for (_, request, _) in provider.sent() {
        let context: Value =
            serde_json::from_str(request["messages"][1]["content"].as_str().unwrap()).unwrap();
        assert!(
            context.get("document").is_none(),
            "no source transcription request is repeated"
        );
    }
    let parent_after = store::load_run(&store, s(&prior, "id")).unwrap();
    let child_after = store::load_run(&store, s(&next, "id")).unwrap();
    assert_eq!(parent_after["budgetState"]["usedCalls"], 18);
    assert_eq!(
        parent_after["budgetState"]["roleCalls"]["sourceParsing"],
        12
    );
    assert_eq!(child_after["budgetState"]["usedCalls"], 6);
    assert!(parent_after["budgetState"]["activeSinceMs"].is_null());
    assert!(child_after["budgetState"]["activeSinceMs"].is_null());
    assert!(
        store::load_run(&store, s(&initial, "id")).unwrap()["budgetState"]["activeSinceMs"]
            .is_null()
    );
    let (replayed, is_new) =
        super::super::background::stage_strategy_continue(&store, &model, &payload).unwrap();
    assert!(!is_new);
    assert_eq!(replayed, completed);
    assert_eq!(provider.sent().len(), 6);
}

#[test]
fn successful_background_metadata_repair_stops_inherited_clocks_and_keeps_quota_and_math_evidence()
{
    let provider = Provider::start(Scenario::Clean);
    let (directory, initial_store, model, mut record) = fixture(&provider);
    drop(initial_store);
    // Workers open this same real bundled seed, so the fixture's catalogue is
    // stable before and after it obtains its independent background connection.
    let seed: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../resources/seed.json"
    )))
    .unwrap();
    let mut store = Store::open(directory.path(), &seed).unwrap();
    process(&mut store, &model, &mut record, &AtomicBool::new(false)).unwrap();
    let parent = store::load_run(&store, s(&record, "accuracyRunId")).unwrap();
    let q = record["questions"][0].clone();
    let before = state(&store, &record, &q).unwrap();
    assert_eq!(provider.sent().len(), 6);
    // This synthetic prior receipt exercises a conservative hold; it is not
    // claimed as an actual prior HTTP request or a mathematical verification.
    let held = store::reserve_execution(
        &store,
        s(&parent, "id"),
        "sourceParsing",
        "simulated-other-held-question",
        &json!({"model":"simulated-held-budget-fixture","messages":[],"max_tokens":20}),
        5,
        20,
        1,
    )
    .unwrap();
    store::finish_execution(
        &store,
        s(&held, "id"),
        "failed",
        &Value::Null,
        &json!({"code":"simulated-prior-unknown-usage"}),
    )
    .unwrap();
    store::pause_parent_clocks(&store, s(&parent, "id")).unwrap();
    let parent_before = store::load_run(&store, s(&parent, "id")).unwrap();
    let mut budget = parent["operationBudget"].clone();
    budget["parentBudgetId"] = parent["id"].clone();
    let mut child = store::create_run(
        &store,
        s(&record, "importId"),
        &parent["strategy"],
        &parent["source"],
        &budget,
    )
    .unwrap();
    child["progress"] = parent["progress"].clone();
    // A completed child has its own catalogue snapshot even when the content
    // and inherited mathematics are unchanged. Do not simulate an unfinished
    // strategy migration that would legitimately trigger metadata generation.
    let catalogue = artifact(&store, &before["catalogue"]).unwrap();
    let catalogue_ref = store::put_artifact(
        &store,
        s(&child, "id"),
        "catalogue_snapshot",
        s(&q, "questionId"),
        &json!({"sha256":hash_json(&catalogue)}),
        &catalogue,
    )
    .unwrap();
    child["progress"]["questions"][s(&q, "questionId")]["catalogue"] = catalogue_ref;
    let child = store::save_run(&store, child["revision"].as_u64().unwrap(), &child).unwrap();
    record["accuracyRunId"] = child["id"].clone();
    store
        .put_document("imports", s(&record, "importId"), &record)
        .unwrap();
    let payload = json!({"importId":record["importId"],"questionId":q["questionId"],"expectedRevision":record["revision"],
        "operationId":"simulated-background-metadata-repair-clock","sourceSha256":source_sha(&q),"candidateSha256":projection::candidate_sha(&store,&before).unwrap(),
        "basis":"模拟显式核对：只复核并修订本题教学元数据，保留已核对原题、完整数学解答和证明依据。","responseScope":"summary"});
    super::super::dispatch(
        &mut store,
        &model,
        "import_accuracy_repair_start",
        &payload,
        &AtomicBool::new(false),
    )
    .unwrap()
    .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    let completed = loop {
        let current = store.document("imports", s(&record, "importId")).unwrap();
        if !matches!(s(&current["backgroundJob"], "status"), "queued" | "running") {
            break current;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "isolated background repair timed out: {current}"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
    assert_eq!(
        completed["backgroundJob"]["status"], "completed",
        "{completed}"
    );
    assert_eq!(completed["backgroundJob"]["mode"], "accuracy_repair");
    let after = state(&store, &completed, &q).unwrap();
    for key in [
        "sourceCandidate",
        "source",
        "solution",
        "independent",
        "math",
    ] {
        assert_eq!(
            after[key], before[key],
            "metadata repair must retain {key} evidence"
        );
    }
    assert_eq!(after["repairCalls"], 1);
    assert_eq!(after["metadataOrigin"], "repair");
    let parent_after = store::load_run(&store, s(&parent, "id")).unwrap();
    let child_after = store::load_run(&store, s(&child, "id")).unwrap();
    for run in [&parent_after, &child_after] {
        assert!(
            run["budgetState"]["activeSinceMs"].is_null(),
            "terminal repair leaves no active budget clock"
        );
        assert_ne!(run["status"], "running");
        assert_eq!(run["budgetState"]["inFlight"], 0);
    }
    assert_eq!(
        parent_after["budgetState"]["usedCalls"].as_u64().unwrap(),
        parent_before["budgetState"]["usedCalls"].as_u64().unwrap() + 2
    );
    assert_eq!(child_after["budgetState"]["usedCalls"], 2);
    assert_eq!(child_after["budgetState"]["roleCalls"]["teachingReview"], 1);
    assert_eq!(
        child_after["budgetState"]["roleCalls"]["teachingVerification"],
        1
    );
    for key in [
        "reservedInputTokens",
        "reservedOutputTokens",
        "unknownUsageExecutions",
    ] {
        assert_eq!(
            parent_after["budgetState"][key], parent_before["budgetState"][key],
            "stopping clocks keeps prior {key}"
        );
        assert_eq!(child_after["budgetState"][key], child["budgetState"][key]);
    }
    let sent = provider.sent();
    assert_eq!(
        sent.len(),
        8,
        "exactly one metadata repair and one teaching verification follow the original six calls"
    );
    let repair_context: Value =
        serde_json::from_str(sent[6].1["messages"][1]["content"].as_str().unwrap()).unwrap();
    assert_eq!(repair_context["scope"], "metadata");
    let verify_context: Value =
        serde_json::from_str(sent[7].1["messages"][1]["content"].as_str().unwrap()).unwrap();
    assert!(verify_context["metadata"].is_object());
}
