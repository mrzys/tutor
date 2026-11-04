//! Versioned intermediate processing. OCR and bank question contracts stay owned
//! by their existing modules; this module owns only evidence and composition.
use super::*;
#[path = "accuracy/budget.rs"]
pub(crate) mod budget;
#[path = "accuracy/catalogue.rs"]
mod catalogue;
#[path = "accuracy/contracts.rs"]
mod contracts;
#[path = "accuracy/scope.rs"]
mod scope;
#[path = "accuracy/store.rs"]
pub(crate) mod store;

const VERSION: &str = "import-two-model-v1";
const LEGACY_VERSION: &str = "import-accuracy-first-v3";
const ENGINE: &str = "import-accuracy-first-v1";
pub(crate) fn current_strategy_version() -> &'static str {
    VERSION
}
const ROLES: [&str; 4] = [
    "sourceVerification",
    "independentSolve",
    "mathVerification",
    "teachingVerification",
];

pub(crate) fn validate_configuration(model: &ModelClient) -> AppResult<()> {
    two_model::validate_configuration(model)
}
pub(crate) fn validate_configuration_for_record(store: &Store, model: &ModelClient, record: &Value) -> AppResult<()> {
    if two_model::is_run(store, record)? { validate_configuration(model) } else { validate_legacy_configuration(model) }
}
fn validate_legacy_configuration(model: &ModelClient) -> AppResult<()> {
    model.import_source_model()?;
    model.import_generator()?;
    for role in ROLES {
        model.import_accuracy_model(role)?;
    }
    Ok(())
}
pub(crate) fn initialize_run(
    store: &Store,
    model: &ModelClient,
    record: &mut Value,
) -> AppResult<()> {
    if !s(record, "accuracyRunId").is_empty() {
        store::load_run(store, s(record, "accuracyRunId"))?;
        return Ok(());
    }
    let strategy = strategy_snapshot(model)?;
    initialize_run_with_strategy(store, record, &strategy)
}
fn initialize_run_with_strategy(store: &Store, record: &mut Value, strategy: &Value) -> AppResult<()> {
    let run = store::create_run(
        store,
        s(record, "importId"),
        strategy,
        &source_identity(record),
        &json!({"maxCalls":324,"maxInputTokens":10_000_000,"maxOutputTokens":16_000_000,"maxActiveWallSeconds":7200,"maxInFlight":3,"maxRoleInFlight":2,"roleInFlightCaps":{"sourceParsing":3},"roleCallCaps":{"sourceParsing":81,"sourceVerification":40,"teachingGeneration":if strategy["strategyVersion"] == VERSION {40}else{80},"independentSolve":40,"mathVerification":80,"teachingVerification":80,"teachingReview":if strategy["strategyVersion"] == VERSION {120}else{40}}}),
    )?;
    attach_run(store, record, &run)?;
    Ok(())
}
fn strategy_snapshot(model: &ModelClient) -> AppResult<Value> {
    two_model::strategy_snapshot(model)
}
fn legacy_strategy_snapshot(model: &ModelClient) -> AppResult<Value> {
    validate_legacy_configuration(model)?;
    let mut bindings = json!({"sourceParsing":model.import_source_model()?.import_execution_identity()?,"teachingGeneration":model.import_generator()?.import_execution_identity()?});
    for role in ROLES {
        bindings[role] = model
            .import_accuracy_model(role)?
            .import_execution_identity()?;
    }
    let contracts = json!({"accuracy_source_verification":[contracts::response_contract("source")],"accuracy_solution_generation":[contracts::response_contract("solution")],"accuracy_independent_solve":[contracts::response_contract("independent")],"accuracy_math_verification":[contracts::response_contract("math")],"accuracy_teaching_generation":[contracts::response_contract("metadata")],"accuracy_teaching_verification":[contracts::response_contract("teaching")],"accuracy_repair":[contracts::response_contract("repair"),contracts::response_contract("metadata")]});
    let input_limits = json!({"accuracy_source_verification":24_000,"accuracy_solution_generation":16_000,"accuracy_independent_solve":16_000,"accuracy_math_verification":40_000,"accuracy_teaching_generation":160_000,"accuracy_teaching_verification":160_000,"accuracy_repair":160_000});
    let rubric: Value = serde_json::from_str(include_str!("../../../resources/difficulty-rubric.json"))?;
    Ok(
        json!({"strategyVersion":LEGACY_VERSION,"pipelineVersion":ENGINE,"processSchemaVersion":1,"bindings":bindings,"roleSettings":model.public_settings()["effectiveImportRoles"],"policy":ModelClient::accuracy_policy_snapshot(),"responseContracts":contracts,"inputLimits":input_limits,"sourceProjection":"source-page-locations-v1","catalogueProjection":"accuracy-catalogue-columns-rows-v1","difficultyRubric":rubric,"evidenceReuse":"exact-inputs-accepted-artifacts-v1","unknownUsagePolicy":"retain-reservation-continue-other-questions-v1","stages":["source","solution","independent","math","metadata","teaching"],"composition":"locked-mathematics-metadata-only-v1","maxRepairsPerQuestion":1,"selfConfidenceGrantsEligibility":false}),
    )
}
fn attach_run(store: &Store, record: &mut Value, run: &Value) -> AppResult<()> {
    record["accuracyRunId"] = run["id"].clone();
    record["accuracyStrategy"] = run["strategyVersion"].clone();
    record["accuracyDataDir"] = json!(store.data_dir.canonicalize()?);
    Ok(())
}
/// An explicit strategy revision keeps the original source and ancestor quota.
/// It never edits a frozen run or adopts a rejected response as a successful one.
pub(crate) fn revise_run(store: &Store, model: &ModelClient, record: &mut Value) -> AppResult<()> {
    // Existing six-stage runs keep their strategy family even on an explicit
    // policy refresh. The two-model flow is selected by a new upload only.
    let strategy = if two_model::is_run(store, record)? { strategy_snapshot(model)? } else { legacy_strategy_snapshot(model)? };
    revise_run_with_strategy(store, record, strategy)
}
fn revise_run_with_strategy(store: &Store, record: &mut Value, strategy: Value) -> AppResult<()> {
    let previous = run_for(store, record)?;
    if previous["budgetState"]["inFlight"] != 0 || previous["status"] == "running" {
        return Err(err("import_busy", "当前处理仍在运行，未切换策略。"));
    }
    if strategy == previous["strategy"] {
        return Err(err(
            "accuracy_strategy_unchanged",
            "本次运行已经使用当前策略，请继续原任务。",
        ));
    }
    for key in ["bindings", "roleSettings"] {
        if strategy[key] != previous["strategy"][key] {
            return Err(err(
                "accuracy_configuration_changed",
                "策略修订须保持原用途配置，不能顺便更换模型或思考设置。",
            ));
        }
    }
    let mut budget = previous["operationBudget"].clone();
    budget["parentBudgetId"] = previous["id"].clone();
    let run = store::create_run(
        store,
        s(record, "importId"),
        &strategy,
        &source_identity(record),
        &budget,
    )?;
    // Preserve per-question repair consumption across source/strategy revisions.
    let mut next = run.clone();
    next["progress"]["questions"] = json!({});
    for q in rows(&record["questions"]) {
        let old = &previous["progress"]["questions"][s(&q, "questionId")];
        next["progress"]["questions"][s(&q, "questionId")] = reusable_question_state(&previous["strategy"], &strategy, &q, old);
    }
    let next = store::save_run(store, run["revision"].as_u64().unwrap_or(0), &next)?;
    attach_run(store, record, &next)
}
fn reusable_question_state(previous: &Value, next: &Value, q: &Value, old: &Value) -> Value {
    let mut state = json!({"sourceSha256":source_sha(q),"repairCalls":old["repairCalls"].as_u64().unwrap_or(0)});
    if let Some(scope) = old.get("publicationScope") {
        state["publicationScope"] = scope.clone();
    }
    if old["sourceSha256"] != state["sourceSha256"]
        || previous["sourceProjection"] != next["sourceProjection"]
        || next["evidenceReuse"] != "exact-inputs-accepted-artifacts-v1"
    {
        return state;
    }
    // Accepted artifacts retain their original run, request, prompt and raw
    // response identities. stage() still compares exact context and assets;
    // publication replays the original evidence. Rejected responses have no
    // artifact reference and can never become successes through this path.
    for (key, task) in [
        ("source", "accuracy_source_verification"),
        ("solution", "accuracy_solution_generation"),
        ("independent", "accuracy_independent_solve"),
        ("math", "accuracy_math_verification"),
    ] {
        if previous["responseContracts"][task] == next["responseContracts"][task] {
            if let Some(reference) = old.get(key) {
                state[key] = reference.clone();
            }
        }
    }
    for key in ["sourceCandidate", "sourceManual", "mathManual", "solutionOrigin", "lastError"] {
        if let Some(value) = old.get(key) {
            state[key] = value.clone();
        }
    }
    state
}
fn aggregate_budget(store: &Store, run: &Value) -> AppResult<Value> {
    let mut current = run.clone();
    let mut seen = HashSet::new();
    while !s(&current["operationBudget"], "parentBudgetId").is_empty() {
        if !seen.insert(s(&current, "id").to_owned()) {
            return Err(err("accuracy_integrity", "父预算引用形成循环。"));
        }
        current = store::load_run(store, s(&current["operationBudget"], "parentBudgetId"))?;
    }
    Ok(
        json!({"limits":current["operationBudget"],"usage":current["budgetState"],"pause":current["pause"],"budgetRunId":current["id"],"currentRunUsage":run["budgetState"]}),
    )
}
pub(crate) fn bind_model(store: &Store, model: &ModelClient, record: &Value) -> AppResult<ModelClient> {
    if s(record, "accuracyRunId").is_empty() {
        Ok(model.clone())
    } else {
        let run = store::load_run(store, s(record, "accuracyRunId"))?;
        Ok(model.with_accuracy_binding(
            json!({"runId":record["accuracyRunId"],"dataDir":record["accuracyDataDir"],"importId":record["importId"],"sourceIndexingEnabled":run["strategy"]["bindings"]["sourceIndexing"].is_object()}),
        ))
    }
}
pub(crate) fn reserve_source_call(
    binding: &Value,
    _task: &str,
    body: &Value,
    timeout_seconds: u64,
) -> AppResult<Value> {
    budget::check_storage(
        Path::new(s(binding, "dataDir")),
        s(binding, "importId"),
        body.to_string().len() as u64 * 3 + 16 * 1024 * 1024,
    )?;
    let input = binding["reservedInputTokens"]
        .as_u64()
        .filter(|n| *n > 0)
        .ok_or_else(|| {
            err(
                "accuracy_input_budget",
                "来源模型缺少最终请求的可信预算预留。",
            )
        })?;
    let output = body["max_tokens"]
        .as_u64()
        .or(body["max_completion_tokens"].as_u64())
        .unwrap_or(65_536);
    store::reserve_execution_at(
        Path::new(s(binding, "dataDir")),
        s(binding, "runId"),
        "sourceParsing",
        "",
        body,
        input.max(1),
        output,
        timeout_seconds,
    )
}
pub(crate) fn finish_source_call(
    binding: &Value,
    receipt: &Value,
    result: &AppResult<Value>,
    audit_path: &Path,
) -> AppResult<()> {
    let response = read_json_if(audit_path);
    let usage = if response["usage"].is_object() {
        response["usage"].clone()
    } else {
        response["response"]["usage"].clone()
    };
    store::finish_execution_at(
        Path::new(s(binding, "dataDir")),
        s(receipt, "id"),
        if result.is_ok() {
            "completed"
        } else if result.as_ref().err().is_some_and(|e| e.code == "cancelled") {
            "cancelled"
        } else {
            "failed"
        },
        &usage,
        &result
            .as_ref()
            .err()
            .map(|e| json!({"code":e.code,"message":e.message}))
            .unwrap_or(Value::Null),
    )
}
fn read_json_if(path: &Path) -> Value {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null)
}
fn run_for(store: &Store, record: &Value) -> AppResult<Value> {
    let run = store::load_run(store, s(record, "accuracyRunId"))?;
    if run["importId"] != record["importId"] || run["source"] != source_identity(record) {
        return Err(err("accuracy_integrity", "处理来源与当前原件不一致。"));
    }
    Ok(run)
}
fn applicable_catalogue(store: &Store, record: &Value) -> AppResult<Value> {
    let mut current = trusted_catalog(store)?;
    let run = run_for(store, record)?;
    if run["strategy"]["difficultyRubric"].is_object() {
        current["difficultyRubric"] = run["strategy"]["difficultyRubric"].clone();
    }
    let pending = &record["pendingPublication"];
    if pending["manifest"].is_object()
        && !s(pending, "operationId").is_empty()
        && store
            .bank
            .publication_matches(s(pending, "operationId"), &pending["manifest"])?
    {
        let own: Vec<_> = rows(&pending["manifest"]["configPatch"]["tasks"])
            .iter()
            .map(import_task_identity)
            .collect();
        current["tasks"] = json!(
            rows(&current["tasks"])
                .into_iter()
                .filter(|task| !own.iter().any(|v| v == task))
                .collect::<Vec<_>>()
        );
    }
    Ok(current)
}
fn source_identity(record: &Value) -> Value {
    json!({"sha256":record["source"]["sha256"],"relativePath":record["source"]["relativePath"],"extension":record["source"]["extension"],"byteLength":record["source"]["byteLength"]})
}
fn mutate_run(store: &Store, record: &Value, change: impl FnOnce(&mut Value)) -> AppResult<Value> {
    let mut run = run_for(store, record)?;
    let revision = run["revision"].as_u64().unwrap_or(0);
    change(&mut run);
    store::save_run(store, revision, &run)
}
fn source_input(q: &Value) -> Value {
    json!({"questionId":q["questionId"],"questionType":q["questionType"],"student":student(q),"originalReference":{"answer":q["answer"],"solution":q["solution"],"parts":rows(&q["parts"]).iter().map(|p|json!({"partId":p["partId"],"answer":p["answer"],"solution":p["solution"]})).collect::<Vec<_>>(),"assets":q["teacher"]["assets"]},"sourcePages":q["sourcePages"],"sourceBlockIds":q["sourceBlockIds"],"sourceIdentity":q["sourceIdentity"]})
}
fn student(q: &Value) -> Value {
    let parts: Vec<_> = rows(&q["parts"])
        .iter()
        .map(|p| {
            let mut v = json!({"partId":p["partId"],"prompt":p["prompt"]});
            for key in ["label", "parentPartId"] {
                if let Some(item) = p.get(key) {
                    v[key] = item.clone();
                }
            }
            v
        })
        .collect();
    json!({"stem":q["stem"],"options":q["options"],"parts":parts,"assets":q["student"].get("assets").cloned().unwrap_or(json!([]))})
}
fn source_sha(q: &Value) -> String {
    hash_json(
        &json!({"candidate":source_input(q),"pages":q["pages"],"sourceIssues":q["sourceIssues"],"sourceMaterialRoles":q["sourceMaterialRoles"],"assetPayloads":q["assetPayloads"]}),
    )
}
fn targets(q: &Value, domain: &str) -> Vec<String> {
    let mut values: Vec<String> = match domain {
        "source" => vec![
            "questionType",
            "student.stem",
            "student.options",
            "originalReference.answer",
            "originalReference.solution",
        ],
        "math" => vec![
            "originalProblemValidity",
            "candidate.answer",
            "candidate.solution",
            "originalReference.answer",
            "originalReference.solution",
        ],
        _ => vec![
            "primaryKnowledgeUids",
            "solutionPaths",
            "task",
            "difficultyAssessment",
            "teachingFocus.examFocus",
            "teachingFocus.studentRequirements",
        ],
    }
    .into_iter()
    .map(str::to_owned)
    .collect();
    if domain != "teaching" {
        for part in rows(&q["parts"]) {
            let id = s(&part, "partId");
            for field in if domain == "source" {
                vec!["prompt", "answer", "solution"]
            } else {
                vec!["answer", "proof", "originalReference"]
            } {
                values.push(format!("parts.{id}.{field}"));
            }
        }
    }
    if domain == "source" {
        for group in ["student", "teacher"] {
            for a in rows(&q[group]["assets"]) {
                values.push(format!("{group}.assets.{}", s(&a, "assetId")));
            }
        }
    }
    values
}
fn good(report: &Value) -> bool {
    matches!(s(report, "status"), "no_issue_found" | "teacher_reviewed")
}
fn artifact(store: &Store, reference: &Value) -> AppResult<Value> {
    if reference.is_null() {
        Ok(Value::Null)
    } else if reference.get("combinedResponse").is_some() {
        two_model::component_payload(store, reference)
    } else {
        store::artifact_payload(store, reference)
    }
}
fn state(store: &Store, record: &Value, q: &Value) -> AppResult<Value> {
    let run = run_for(store, record)?;
    let value = run["progress"]["questions"][s(q, "questionId")].clone();
    if value["sourceSha256"] != source_sha(q) {
        Ok(
            json!({"sourceSha256":source_sha(q),"repairCalls":value["repairCalls"].as_u64().unwrap_or(0),"previousSourceSha256":value["sourceSha256"]}),
        )
    } else {
        Ok(value)
    }
}
/// Read the selected scope from the current, source-bound process state. A
/// display projection supplied by a caller never grants or changes that scope.
pub(crate) fn publication_scope_for_question(store: &Store, record: &Value, q: &Value) -> AppResult<&'static str> {
    let value = state(store, record, q)?;
    Ok(if scope::publication_scope(&value) == "source_only" { "source_only" } else { "source_and_teaching" })
}
fn save_state(store: &Store, record: &Value, q: &Value, value: &Value) -> AppResult<()> {
    mutate_run(store, record, |run| {
        if !run["progress"]["questions"].is_object() {
            run["progress"]["questions"] = json!({});
        }
        run["progress"]["questions"][s(q, "questionId")] = value.clone();
    })?;
    Ok(())
}
fn checked_report(store: &Store, value: &Value, domain: &str) -> AppResult<Value> {
    let manual = artifact(store, &value[format!("{domain}Manual")])?;
    if !manual.is_null()
        && (domain == "source"
            || scope::publication_scope(&manual) == scope::publication_scope(value))
        && manual["domainCandidateSha256"] == domain_candidate_sha(store, value, domain)?
    {
        return Ok(manual);
    }
    let result = artifact(store, &value[domain])?;
    Ok(result.get("result").cloned().unwrap_or(result))
}
fn review_targets(q: &Value, value: &Value, domain: &str) -> Vec<String> {
    let all = targets(q, domain);
    if scope::publication_scope(value) != "source_only" || domain == "source"
        // In the merged flow metadata is proposed before math is checked.
        // Its delivered knowledge/path/difficulty depend on that same solution.
        || domain == "math" && !value["generation"].is_null() {
        return all;
    }
    all.into_iter()
        .filter(|target| {
            if domain == "math" {
                target == "originalProblemValidity"
                    || target.starts_with("originalReference.")
                    || target.ends_with(".originalReference")
            } else {
                matches!(
                    target.as_str(),
                    "primaryKnowledgeUids" | "solutionPaths" | "task" | "difficultyAssessment"
                )
            }
        })
        .collect()
}
fn domain_candidate_sha(store: &Store, value: &Value, domain: &str) -> AppResult<Value> {
    if domain == "source" {
        Ok(Value::Null)
    } else if domain == "math" {
        let solution = artifact(store, &value["solution"])?;
        Ok(if solution.is_null() {
            Value::Null
        } else {
            json!(hash_json(&solution["result"]))
        })
    } else {
        projection::candidate_sha(store, value)
    }
}
pub(crate) fn pause(store: &Store, record: &Value) -> AppResult<()> {
    if !s(record, "accuracyRunId").is_empty() {
        store::interrupt_run(store, s(record, "accuracyRunId"))?;
        store::pause_parent_clocks(store, s(record, "accuracyRunId"))?;
    }
    Ok(())
}
fn model_call(
    store: &Store,
    record: &Value,
    client: &ModelClient,
    task: &str,
    role: &str,
    qid: &str,
    context: &Value,
    assets: &[Value],
    cancel: &AtomicBool,
) -> AppResult<Value> {
    budget::check_storage(
        &store.data_dir,
        s(record, "importId"),
        context.to_string().len() as u64 * 3
            + assets
                .iter()
                .map(|a| s(a, "contentBase64").len() as u64 * 3)
                .sum::<u64>()
            + 16 * 1024 * 1024,
    )?;
    let root = store
        .data_dir
        .join("imports")
        .join(s(record, "importId"))
        .join("accuracy");
    std::fs::create_dir_all(&root)?;
    let path = root.join(format!("{}.response.json", uuid::Uuid::new_v4()));
    let mut receipt = Value::Null;
    let cap = run_for(store, record)?["strategy"]["inputLimits"][task]
        .as_u64()
        .ok_or_else(|| {
            err(
                "accuracy_strategy_unavailable",
                "本次冻结策略缺少任务输入预算，未隐式套用新版策略。",
            )
        })?;
    let mut reserve = |body: &Value, timeout: u64| {
        let strategy = run_for(store, record)?["strategy"].clone();
        if strategy["policy"]["tasks"][task]["instruction"] != body["messages"][0]["content"]
            || strategy["policy"]["tasks"][task]["timeoutSeconds"] != timeout
            || !rows(&strategy["responseContracts"][task])
                .iter()
                .any(|schema| schema == &context["responseContract"])
        {
            return Err(err(
                "accuracy_strategy_unavailable",
                "当前程序的任务合同已改变，未将新策略混入旧运行；已有材料与额度保留。",
            ));
        }
        // UTF-8 bytes provide a conservative bound for text token count. Image
        // inputs reserve the role cap because provider image tokenizers differ.
        let input = client.accuracy_input_reservation(body, cap)?;
        let output = body["max_tokens"]
            .as_u64()
            .or(body["max_completion_tokens"].as_u64())
            .unwrap_or(65_536);
        let output_cap = if matches!(
            task,
            "accuracy_solution_generation" | "accuracy_teaching_generation" | "accuracy_repair" | "accuracy_combined_generation" | "accuracy_combined_repair"
        ) {
            65_536
        } else {
            32_768
        };
        if output > output_cap {
            return Err(err(
                "accuracy_output_budget",
                "实际模型输出上限超出冻结策略，未发出请求。",
            ));
        }
        receipt = store::reserve_execution(
            store,
            s(record, "accuracyRunId"),
            role,
            qid,
            body,
            input.max(1),
            output,
            timeout,
        )?;
        Ok(())
    };
    let result =
        client.propose_accuracy_with_audit(task, context, cancel, &path, assets, &mut reserve);
    let response = read_json_if(&path);
    if !receipt.is_null() {
        store::finish_execution(
            store,
            s(&receipt, "id"),
            if result.is_ok() {
                "completed"
            } else if result.as_ref().err().is_some_and(|e| e.code == "cancelled") {
                "cancelled"
            } else {
                "failed"
            },
            &response["usage"],
            &result
                .as_ref()
                .err()
                .map(|e| json!({"code":e.code,"message":e.message}))
                .unwrap_or(Value::Null),
        )?;
    }
    let value = result?;
    let request_path = path.with_extension("request.json");
    let request = read_json_if(&request_path);
    let audit = json!({"responseRelativePath":audit_relative_path(store,&path)?,"responseSha256":sha(&std::fs::read(&path)?),"requestRelativePath":audit_relative_path(store,&request_path)?,"requestFileSha256":sha(&std::fs::read(&request_path)?),"requestSha256":request["bodySha256"],"promptSha256":request["promptSha256"],"executionId":receipt["id"]});
    Ok(
        json!({"result":value,"model":client.import_execution_identity()?,"audit":audit,"inputAssets":assets.iter().map(|a|json!({"assetId":a["id"],"sha256":a["sha256"],"role":a["role"]})).collect::<Vec<_>>(),"createdAt":now()}),
    )
}

pub(crate) fn process(
    store: &mut Store,
    model: &ModelClient,
    record: &mut Value,
    cancel: &AtomicBool,
) -> AppResult<()> {
    runner::process(store, model, record, cancel)
}
#[path = "accuracy/projection.rs"]
mod projection;
#[path = "accuracy/runner.rs"]
mod runner;
#[path = "accuracy/two_model.rs"]
mod two_model;
pub(crate) use projection::{
    apply_to_entry, detail_version, dispatch, eligible, project_record, repair_job,
    validate_action, verify_manifest, verify_question,
};
#[cfg(test)]
#[path = "accuracy/boundary_tests.rs"]
mod boundary_tests;
#[cfg(test)]
#[path = "accuracy/replay_tests.rs"]
mod replay_tests;
#[cfg(test)]
#[path = "accuracy/pipeline_tests.rs"]
mod tests;
#[cfg(test)]
#[path = "accuracy/two_model_tests.rs"]
mod two_model_tests;
#[cfg(test)]
#[path = "accuracy/vision_pipeline_tests.rs"]
mod vision_pipeline_tests;

#[cfg(test)]
#[test]
fn source_edits_invalidate_evidence_without_resetting_the_used_repair_allowance() {
    let provider = tests::Provider::start(tests::Scenario::Clean);
    let (_dir, store, _model, record) = tests::fixture(&provider);
    let mut q = record["questions"][0].clone();
    let mut before = state(&store, &record, &q).unwrap();
    before["repairCalls"] = json!(1);
    before["source"] = json!({"id":"obsolete-source-evidence"});
    save_state(&store, &record, &q, &before).unwrap();
    q["stem"] = json!("教师明确修正了原题中的一个条件。");
    let after = state(&store, &record, &q).unwrap();
    assert_eq!(after["repairCalls"], 1);
    assert!(after["source"].is_null());
    assert_ne!(after["sourceSha256"], before["sourceSha256"]);
}
#[cfg(test)]
#[test]
fn a_changed_task_contract_cannot_silently_enter_a_frozen_run() {
    let provider = tests::Provider::start(tests::Scenario::Clean);
    let (_dir, store, model, record) = tests::fixture(&provider);
    let q = record["questions"][0].clone();
    let client = model.import_generator().unwrap();
    let error=model_call(&store,&record,&client,"accuracy_teaching_generation","teachingGeneration",s(&q,"questionId"),&json!({"questionId":q["questionId"],"student":student(&q),"responseContract":{"type":"object","extraNewPolicy":true}}),&[],&AtomicBool::new(false)).unwrap_err();
    assert_eq!(error.code, "accuracy_strategy_unavailable");
    assert!(provider.sent().is_empty());
    assert_eq!(
        run_for(&store, &record).unwrap()["budgetState"]["usedCalls"],
        0
    );
}
