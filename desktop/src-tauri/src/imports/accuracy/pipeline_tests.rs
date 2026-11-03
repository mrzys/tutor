//! Isolated transport/storage regressions. Scripted provider opinions are not
//! evidence of mathematical accuracy or of actual teacher use.
use super::*;
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{Arc, Mutex},
    thread::{self, JoinHandle},
    time::Duration,
};

#[derive(Clone, Copy)]
pub(super) enum Scenario {
    Clean,
    SourceIssue,
    MathIssue,
    TeachingIssue,
    TeachingMetadataIssue,
    MetadataOverwrite,
    RichKnowledge,
    CombinedReportInvalid,
    CombinedMetadataRepairOverwrite,
    MathCandidateIssue,
    CombinedIndependentClaim,
}

pub(super) struct Provider {
    pub(super) endpoint: String,
    requests: Arc<Mutex<Vec<(String, Value, Value)>>>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}
impl Provider {
    pub(super) fn start(scenario: Scenario) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let requests = Arc::new(Mutex::new(vec![]));
        let captured = requests.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let worker = thread::spawn(move || {
            while !stopped.load(std::sync::atomic::Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        // Windows inherits the listener's nonblocking mode.
                        stream.set_nonblocking(false).unwrap();
                        let (headers, body) = read_request(&mut stream);
                        let content = &body["messages"][1]["content"];
                        let context: Value = serde_json::from_str(
                            content
                                .as_str()
                                .or_else(|| content[0]["text"].as_str())
                                .unwrap(),
                        )
                        .unwrap();
                        let stage = stage_name(&context);
                        let result = provider_result(stage, &context, scenario);
                        let mut saved = captured.lock().unwrap();
                        let index = saved.len() + 1;
                        saved.push((headers, body, result.clone()));
                        drop(saved);
                        let response = json!({"id":format!("simulated-actual-http-{index}"),"model":"simulated-accuracy-http","choices":[{"index":0,"finish_reason":"stop","message":{"content":result.to_string()}}],"usage":{"prompt_tokens":100+index,"completion_tokens":20+index},"providerSpecific":{"stage":stage,"retained":true}}).to_string();
                        stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", response.len()).as_bytes()).unwrap();
                        stream.write_all(response.as_bytes()).unwrap();
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(error) => panic!("isolated provider accept failed: {error}"),
                }
            }
        });
        Self {
            endpoint,
            requests,
            stop,
            worker: Some(worker),
        }
    }
    pub(super) fn sent(&self) -> Vec<(String, Value, Value)> {
        self.requests.lock().unwrap().clone()
    }
}
impl Drop for Provider {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            let result = worker.join();
            if !thread::panicking() {
                result.unwrap();
            }
        }
    }
}
fn read_request(stream: &mut TcpStream) -> (String, Value) {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut bytes = vec![];
    let mut buffer = [0; 8192];
    let end = loop {
        let count = stream.read(&mut buffer).unwrap();
        assert!(count > 0);
        bytes.extend_from_slice(&buffer[..count]);
        if let Some(index) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let headers = std::str::from_utf8(&bytes[..end]).unwrap().to_owned();
    let length: usize = headers
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .map(|value| value.trim().parse().unwrap())
        })
        .unwrap();
    while bytes.len() < end + length {
        let count = stream.read(&mut buffer).unwrap();
        assert!(count > 0);
        bytes.extend_from_slice(&buffer[..count]);
    }
    (
        headers,
        serde_json::from_slice(&bytes[end..end + length]).unwrap(),
    )
}
fn stage_name(context: &Value) -> &'static str {
    if context.get("document").is_some() {
        "source_transcription"
    } else if context.get("generationSha256").is_some() {
        "combined_verification"
    } else if context["responseContract"]["properties"]["solution"]["type"] == "object" {
        "combined_generation"
    } else if context.get("originalPages").is_some() {
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
}
fn provider_result(stage: &str, context: &Value, scenario: Scenario) -> Value {
    let id = &context["questionId"];
    if stage == "combined_generation" {
        let mut result=json!({"questionId":id,"solution":provider_result("solution",context,scenario),"metadata":provider_result("metadata",context,scenario)});
        if matches!(scenario,Scenario::CombinedMetadataRepairOverwrite) && context.get("concreteProblem").is_some() { result["solution"]["answer"]=json!("unauthorized changed answer"); }
        return result;
    }
    if stage == "combined_verification" {
        let mut reports=json!({"questionId":id});
        for domain in ["source","math","teaching"] {
            let mut input=context.clone();
            input["requiredTargets"]=context["requiredTargets"][domain].clone();
            if domain == "source" {input["candidate"]=context["sourceCandidate"].clone();input["originalReference"]=context["sourceCandidate"]["originalReference"].clone();}
            reports[domain]=provider_result(domain,&input,scenario);
        }
        if matches!(scenario,Scenario::CombinedReportInvalid) {reports["teaching"]["checks"]=json!([]);}
        if matches!(scenario,Scenario::CombinedIndependentClaim) {reports["math"]["disagreements"]=json!([{"claimA":"模拟候选42","claimB":"声称不存在的盲解0","classification":"independent_defect","basis":"模拟错误身份声明：实际没有执行盲解。","affectedFields":["candidate.solution"],"partId":null,"stepA":null,"stepB":null}]);}
        return reports;
    }
    if stage == "source_transcription" {
        return json!({"title":"隔离HTTP模拟原卷","questions":[{"questionType":"fill_blank","sourceLabel":"1","pages":[1],"stem":"隔离回归题：计算 $17+25=$____。","options":[],"parts":[],"answer":"42（reference-answer-canary）","solution":"17+25=42（reference-proof-canary）","review":{"status":"ready","confidence":"low","summary":"模拟HTTP：原题及原参考按本次17+25输入保留。","issues":[],"evidencePages":[1]}}]});
    }
    if matches!(stage, "solution" | "independent") {
        let parts = rows(&context["student"]["parts"]);
        let coverage = if parts.is_empty() {
            vec![Value::Null]
        } else {
            parts.iter().map(|p| p["partId"].clone()).collect()
        };
        return json!({"questionId":id,"answer":"$42$","solution":"模拟完整推导：$17+25=17+20+5=42$；交换两个加数仍为42。","partCoverage":coverage,"limitations":[]});
    }
    if stage == "metadata" {
        let mut metadata = json!({"questionId":id,"difficultyAssessment":{"level":"easy","basis":"模拟：直接运算，无需另选解题策略。"},"teachingFocusSchemaVersion":2,"teachingFocus":{"examFocus":"模拟整数加法计算","studentRequirements":["写出加法计算及结果"]},"primaryKnowledgeUids":[],"solutionPaths":[],"task":{"id":"","label":"模拟加法计算"},"issues":[]});
        if matches!(scenario, Scenario::RichKnowledge) {
            metadata["primaryKnowledgeUids"] = json!(["M-SIM-ADD"]);
            metadata["solutionPaths"] = json!([{"id":"simulated-verified-add-path","requiredKnowledgeUids":["M-SIM-ADD"],"requiredPremises":[],"basis":"模拟固定加法解法17+20+5=42。"}]);
        }
        if matches!(scenario, Scenario::MetadataOverwrite) {
            metadata["answer"] = json!("unauthorized-model-overwrite");
        }
        return metadata;
    }
    let broken = stage == "source" && matches!(scenario, Scenario::SourceIssue)
        || stage == "math" && matches!(scenario, Scenario::MathIssue | Scenario::MathCandidateIssue)
        || stage == "teaching"
            && matches!(
                scenario,
                Scenario::TeachingIssue | Scenario::TeachingMetadataIssue
            );
    let mut checks = rows(&context["requiredTargets"]).iter().map(|target| json!({"target":target,"status":"checked","basis":"模拟HTTP服务已逐项检查本次明确目标。"})).collect::<Vec<_>>();
    if broken {
        let index = if stage == "math" && matches!(scenario,Scenario::MathCandidateIssue) {
            checks.iter().position(|check| check["target"]=="candidate.solution").unwrap()
        } else if stage == "teaching" && matches!(scenario, Scenario::TeachingIssue) {
            checks
                .iter()
                .position(|check| check["target"] == "teachingFocus.examFocus")
                .unwrap()
        } else {
            0
        };
        checks[index]["status"] = json!("issue");
    }
    let findings = if broken {
        json!([{"id":"simulated-specific-issue","domain":stage,"message":"模拟具体问题仍待实际处理。","fieldPath":if stage=="source"{"stem"}else if stage=="math"{"solution"}else if matches!(scenario,Scenario::TeachingMetadataIssue){"primaryKnowledgeUids"}else{"teachingFocus.examFocus"},"partId":null,"basis":"模拟原页/候选与预期要求存在指定差异。"}])
    } else {
        json!([])
    };
    let mut report = json!({"questionId":id,"status":if broken{"issues_found"}else{"no_issue_found"},"confidence":"low","checks":checks,"findings":findings});
    if stage == "source" {
        report["referencePresence"] = json!({"answer":"present","solution":"present"});
        let disclosures = [("student", "student_original"), ("originalReference", "reference_only")]
            .into_iter().flat_map(|(group, role)| rows(&context["candidate"][group]["assets"])
                .into_iter().map(move |asset| json!({"assetId":asset["assetId"],"role":role,"basis":"模拟：依据本次原页逐素材核对。"})))
            .collect::<Vec<_>>();
        report["assetDisclosures"] = json!(disclosures);
    }
    report
}
pub(super) fn fixture(provider: &Provider) -> (tempfile::TempDir, Store, ModelClient, Value) {
    fixture_with_parts(provider, false)
}
fn fixture_with_parts(
    provider: &Provider,
    with_parts: bool,
) -> (tempfile::TempDir, Store, ModelClient, Value) {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path(), &crate::bank::tests::seed()).unwrap();
    let mut model = ModelClient::test_client(directory.path(), &provider.endpoint);
    let roles = json!({"sourceParsing":"local","teachingGeneration":"local","teachingReview":"local","sourceVerification":"local","independentSolve":"local","mathVerification":"local","teachingVerification":"local"});
    model.save(&json!({"expectedRevision":0,"activeProfileId":"local","profiles":[{"id":"local","name":"隔离HTTP模拟配置","baseUrl":provider.endpoint,"model":"simulated-accuracy-http","apiKey":"simulated-pipeline-secret"}],"importRoles":roles})).unwrap();
    let original = if with_parts {
        "1. 隔离回归题：(1)计算17+25；(2)交换两个加数并检查结果。\n原答案：两问均42（reference-answer-canary）\n原解析：17+25=42，25+17=42（reference-proof-canary）。"
    } else {
        "1. 隔离回归题：计算17+25。\n原答案：42（reference-answer-canary）\n原解析：17+25=42（reference-proof-canary）。"
    };
    let source = save_source(
        &store,
        "simulated-accuracy-pipeline",
        "txt",
        original.as_bytes(),
    )
    .unwrap();
    let parts = if with_parts {
        json!([{"partId":"p1","prompt":"计算17+25。","answer":"","solution":""},{"partId":"p2","prompt":"交换两个加数并检查结果。","answer":"","solution":""}])
    } else {
        json!([])
    };
    let q = normalize_question(&json!({"questionType":if with_parts{"free_response"}else{"fill_blank"},"stem":if with_parts{"隔离回归题：根据各小问完成计算。"}else{"隔离回归题：计算 $17+25=$____。"},"options":[],"parts":parts,"answer":"42（reference-answer-canary）","solution":"17+25=42（reference-proof-canary）","sourceLabel":"1","pages":[1],"knowledgeSchemaVersion":2,"primaryKnowledgeUids":[],"solutionPaths":[],"difficultyAssessment":{"level":null,"basis":"","rubricVersion":"content-demand-v1"}}), "simulated-accuracy-unique-q", 1).unwrap();
    let mut record = json!({"importId":"simulated-accuracy-pipeline","filename":"隔离HTTP回归.txt","revision":1,"status":"pending_review","source":source,"sourceIssues":[],"extractedPages":[{"page":1,"text":original}],"questions":[q],"publishedQuestionIds":[],"publicationHistory":[],"operations":[],"updatedAt":"2026-11-02T00:00:00Z"});
    // This fixture represents a persisted six-stage run. New-flow tests use an
    // explicit new initialization rather than reinterpreting old evidence.
    initialize_run_with_strategy(&store, &mut record, &legacy_strategy_snapshot(&model).unwrap()).unwrap();
    store
        .put_document("imports", s(&record, "importId"), &record)
        .unwrap();
    (directory, store, model, record)
}
fn process_all(store: &mut Store, model: &ModelClient, record: &mut Value) {
    process(store, model, record, &AtomicBool::new(false)).unwrap();
}

#[test]
fn projected_review_domains_require_actual_candidates_and_survive_compact_summary_without_calling_models() {
    let provider = Provider::start(Scenario::Clean);
    let (_directory, mut store, model, record) = fixture(&provider);
    let projected = project_record(&store, &record).unwrap();
    let view = &projected["questions"][0]["accuracy"];
    assert_eq!(view["canReview"], true);
    assert_eq!(view["reviewableDomains"], json!(["source"]));
    assert_eq!(view["candidate"], Value::Null);
    for domain in ["math", "teaching"] {
        let payload = json!({"importId":record["importId"],"expectedRevision":record["revision"],"questionId":record["questions"][0]["questionId"],
            "operationId":format!("simulated-no-candidate-{domain}"),"domain":domain,"basis":"模拟：没有完整候选时不能确认未展示的材料。","acknowledge":true,
            "sourceSha256":view["sourceSha256"],"candidateSha256":view["candidateSha256"]});
        assert_eq!(dispatch(&mut store,&model,"import_accuracy_review",&payload,&AtomicBool::new(false)).unwrap().unwrap_err().code,"review_required");
    }
    let summary = super::super::dispatch(&mut store,&model,"import_summary_get",&json!({"importId":record["importId"]}),&AtomicBool::new(false)).unwrap().unwrap();
    assert_eq!(summary["summary"]["questions"][0]["accuracy"]["reviewableDomains"], json!(["source"]));
    assert!(summary["summary"]["questions"][0]["accuracy"].get("candidate").is_none());
    let mut published = record.clone();
    published["publishedQuestionIds"] = json!([record["questions"][0]["questionId"]]);
    assert_eq!(project_record(&store,&published).unwrap()["questions"][0]["accuracy"]["reviewableDomains"],json!([]));
    let mut blank = record.clone();
    blank["questions"][0]["stem"] = json!(" ");
    assert_eq!(project_record(&store,&blank).unwrap()["questions"][0]["accuracy"]["reviewableDomains"],json!([]));
    assert_eq!(store.document("imports",s(&record,"importId")).unwrap(),record);
    assert!(provider.sent().is_empty());
}

#[test]
fn explicit_strategy_revision_reuses_accepted_mathematics_and_regenerates_metadata_with_frozen_rubric() {
    let provider = Provider::start(Scenario::Clean);
    let (_directory, mut store, model, mut record) = fixture(&provider);
    let current = run_for(&store, &record).unwrap();
    let mut old_strategy = current["strategy"].clone();
    old_strategy["strategyVersion"] = json!("simulated-prior-v2");
    old_strategy.as_object_mut().unwrap().remove("difficultyRubric");
    let mut inherited_budget = current["operationBudget"].clone();
    inherited_budget["parentBudgetId"] = current["id"].clone();
    let old = store::create_run(&store, s(&record, "importId"), &old_strategy,
        &source_identity(&record), &inherited_budget).unwrap();
    attach_run(&store, &mut record, &old).unwrap();
    store.put_document("imports", s(&record, "importId"), &record).unwrap();
    process_all(&mut store, &model, &mut record);
    let q = record["questions"][0].clone();
    let before = state(&store, &record, &q).unwrap();
    verify_question(&store, &record, &q).unwrap();
    assert!(artifact(&store, &before["catalogue"]).unwrap().get("difficultyRubric").is_none());
    assert_eq!(provider.sent().len(), 6);
    revise_run(&store, &model, &mut record).unwrap();
    store.put_document("imports", s(&record, "importId"), &record).unwrap();
    process_all(&mut store, &model, &mut record);
    let after = state(&store, &record, &q).unwrap();
    for stage in ["source", "solution", "independent", "math"] {
        assert_eq!(after[stage], before[stage], "valid {stage} evidence keeps its original identity");
    }
    assert_ne!(after["metadata"], before["metadata"]);
    let sent = provider.sent();
    assert_eq!(sent.len(), 8, "only rubric-dependent metadata and teaching are requested again");
    let rubric: Value = serde_json::from_str(include_str!("../../../../resources/difficulty-rubric.json")).unwrap();
    for index in [6, 7] {
        let context: Value = serde_json::from_str(sent[index].1["messages"][1]["content"].as_str().unwrap()).unwrap();
        assert_eq!(context["catalogue"]["difficultyRubric"], rubric);
    }
    assert_eq!(aggregate_budget(&store, &run_for(&store, &record).unwrap()).unwrap()["usage"]["usedCalls"], 8);
    verify_question(&store, &record, &q).unwrap();
}

#[test]
fn strategy_revision_does_not_reuse_stages_after_source_or_source_projection_changes() {
    let q = json!({"questionId":"simulated-q","stem":"模拟原题","parts":[],"options":[]});
    let old = json!({"sourceSha256":source_sha(&q),"source":{"id":"old-source"},"solution":{"id":"old-solution"},"repairCalls":1,"publicationScope":"source_only"});
    let previous = json!({"sourceProjection":"old","responseContracts":{}});
    let next = json!({"sourceProjection":"new","evidenceReuse":"exact-inputs-accepted-artifacts-v1","responseContracts":{}});
    let revised = reusable_question_state(&previous, &next, &q, &old);
    assert!(revised["source"].is_null() && revised["solution"].is_null());
    assert_eq!(revised["repairCalls"], 1);
    assert_eq!(revised["publicationScope"], "source_only", "strategy changes cannot expand a teacher's chosen deliverable");
    let mut changed = q.clone();
    changed["stem"] = json!("模拟修改后的题干");
    assert!(reusable_question_state(&next, &next, &changed, &old)["source"].is_null());
}
fn final_manifest(store: &Store, record: &Value) -> Value {
    super::super::build_manifest(store, record).unwrap()
}
fn publish_payload(record: &Value, operation: &str) -> Value {
    json!({"importId":record["importId"],"expectedRevision":record["revision"],"operationId":operation,"acknowledgeReview":true})
}

#[test]
fn http_pipeline_keeps_actual_audits_blind_inputs_exact_composition_and_original_final_contracts() {
    let provider = Provider::start(Scenario::Clean);
    let (_directory, mut store, model, mut record) = fixture(&provider);
    let original_q = record["questions"][0].clone();
    process_all(&mut store, &model, &mut record);
    let sent = provider.sent();
    assert_eq!(sent.len(), 6);
    let stages = sent
        .iter()
        .map(|(_, body, _)| {
            stage_name(
                &serde_json::from_str::<Value>(body["messages"][1]["content"].as_str().unwrap())
                    .unwrap(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        stages,
        [
            "source",
            "solution",
            "independent",
            "math",
            "metadata",
            "teaching"
        ]
    );
    let blind: Value =
        serde_json::from_str(sent[2].1["messages"][1]["content"].as_str().unwrap()).unwrap();
    assert!(blind.get("originalReference").is_none());
    assert!(blind.get("candidate").is_none());
    assert!(blind.get("answer").is_none());
    for canary in [
        "reference-answer-canary",
        "reference-proof-canary",
        "隔离HTTP回归.txt",
    ] {
        assert!(!sent[2].1.to_string().contains(canary));
    }
    let executions = store::list_executions(&store, s(&record, "accuracyRunId")).unwrap();
    assert_eq!(executions.len(), 6);
    assert!(executions.iter().all(|item| item["status"] == "completed"
        && item["usage"]["prompt_tokens"].as_u64().unwrap() > 100));
    let value = state(&store, &record, &original_q).unwrap();
    let solution = artifact(&store, &value["solution"]).unwrap();
    let saved_response = read_json_if(
        &store
            .data_dir
            .join(s(&solution["audit"], "responseRelativePath")),
    );
    assert_eq!(saved_response["completeHttpBody"], true);
    assert_eq!(
        saved_response["response"]["providerSpecific"]["retained"],
        true
    );
    assert_eq!(
        serde_json::from_str::<Value>(saved_response["rawBody"].as_str().unwrap()).unwrap(),
        saved_response["response"]
    );
    let composition = artifact(&store, &value["composition"]).unwrap();
    assert_eq!(composition["candidate"].as_object().unwrap().len(), 7);
    assert_eq!(
        composition["candidate"]["answer"],
        solution["result"]["answer"]
    );
    assert_eq!(
        composition["candidate"]["teachingSolution"],
        solution["result"]["solution"]
    );
    assert!(sent[4].2.get("answer").is_none());
    assert!(sent[4].2.get("teachingSolution").is_none());
    verify_question(&store, &record, &original_q).unwrap();
    let manifest = final_manifest(&store, &record);
    let raw = &manifest["questions"][0];
    let annotation = &manifest["configPatch"]["assemblyIndex"]["entries"][0];
    assert_eq!(raw["student"]["stem"], original_q["stem"]);
    assert_eq!(raw["teacher"]["answers"][0]["text"], original_q["answer"]);
    assert_eq!(annotation["teachingAnalysis"]["answer"], "$42$");
    assert_eq!(
        annotation["teachingAnalysis"]["sourceCandidate"],
        composition["candidate"]
    );
    for key in [
        "accuracy",
        "accuracyRunId",
        "compositionRef",
        "executionRef",
        "strategyVersion",
    ] {
        assert!(raw.get(key).is_none());
        assert!(annotation.get(key).is_none());
    }
    assert!(record["questions"][0].get("teachingWorkflow").is_none());
    super::super::publish(
        &store,
        &publish_payload(&record, "simulated-publish-clean"),
        &AtomicBool::new(false),
    )
    .unwrap();
    let stored = store.bank.question(s(raw, "questionId")).unwrap();
    assert_eq!(stored["student"], raw["student"]);
    assert_eq!(
        provider.sent().len(),
        6,
        "reading and publication must not call a model"
    );
}

#[test]
fn upstream_source_issue_stops_later_http_and_cannot_be_published() {
    let provider = Provider::start(Scenario::SourceIssue);
    let (_directory, mut store, model, mut record) = fixture(&provider);
    let bank_before = store.bank.questions().unwrap();
    let source_before = read_source(&store, &record).unwrap();
    process_all(&mut store, &model, &mut record);
    assert_eq!(provider.sent().len(), 1);
    assert!(!eligible(&store, &record, &record["questions"][0]).unwrap());
    let projected = project_record(&store, &record).unwrap();
    assert_eq!(
        projected["questions"][0]["accuracy"]["source"]["status"],
        "issues_found"
    );
    assert!(
        super::super::publish(
            &store,
            &publish_payload(&record, "simulated-publish-blocked"),
            &AtomicBool::new(false)
        )
        .is_err()
    );
    assert_eq!(store.bank.questions().unwrap(), bank_before);
    assert_eq!(read_source(&store, &record).unwrap(), source_before);
    let artifacts = store::list_artifacts(&store, s(&record, "accuracyRunId"), None, None).unwrap();
    assert!(
        !artifacts
            .iter()
            .any(|item| item["kind"] == "solution" || item["kind"] == "metadata")
    );
}

#[test]
fn publication_replays_actual_raw_response_and_blocks_attachment_tampering_before_bank_write() {
    let provider = Provider::start(Scenario::Clean);
    let (_directory, mut store, model, mut record) = fixture(&provider);
    process_all(&mut store, &model, &mut record);
    let value = state(&store, &record, &record["questions"][0]).unwrap();
    let solution = artifact(&store, &value["solution"]).unwrap();
    let path = store
        .data_dir
        .join(s(&solution["audit"], "responseRelativePath"));
    let original = std::fs::read(&path).unwrap();
    let mut changed = original.clone();
    changed.push(b' ');
    std::fs::write(&path, &changed).unwrap();
    let bank_before = store.bank.questions().unwrap();
    assert_eq!(
        verify_question(&store, &record, &record["questions"][0])
            .unwrap_err()
            .code,
        "accuracy_integrity"
    );
    assert!(
        super::super::publish(
            &store,
            &publish_payload(&record, "simulated-tampered-publication"),
            &AtomicBool::new(false)
        )
        .is_err()
    );
    assert_eq!(store.bank.questions().unwrap(), bank_before);
    std::fs::write(&path, &original).unwrap();
    verify_question(&store, &record, &record["questions"][0]).unwrap();
    assert_eq!(
        provider.sent().len(),
        6,
        "audit recovery must not regenerate provider responses"
    );
}

#[test]
fn metadata_http_cannot_overwrite_verified_math_even_when_provider_returns_a_complete_extra_field()
{
    let provider = Provider::start(Scenario::MetadataOverwrite);
    let (_directory, mut store, model, mut record) = fixture(&provider);
    let before = record["questions"][0].clone();
    process_all(&mut store, &model, &mut record);
    assert_eq!(provider.sent().len(), 5);
    assert_eq!(
        provider.sent()[4].2["answer"],
        "unauthorized-model-overwrite"
    );
    let value = state(&store, &record, &before).unwrap();
    assert_eq!(value["lastError"]["code"], "accuracy_contract_invalid");
    assert!(value["composition"].is_null());
    assert_eq!(record["questions"][0]["answer"], before["answer"]);
    assert!(!eligible(&store, &record, &record["questions"][0]).unwrap());
    let executions = store::list_executions(&store, s(&record, "accuracyRunId")).unwrap();
    assert_eq!(
        executions.len(),
        5,
        "the attempted invalid response still consumes a real execution"
    );
}

#[test]
fn actual_teacher_report_is_version_bound_and_source_change_invalidates_all_prior_domains_without_rewriting_legacy()
 {
    let provider = Provider::start(Scenario::TeachingIssue);
    let (_directory, mut store, model, mut record) = fixture(&provider);
    process_all(&mut store, &model, &mut record);
    let q = record["questions"][0].clone();
    let projected = project_record(&store, &record).unwrap();
    let view = &projected["questions"][0]["accuracy"];
    assert_eq!(view["reviewableDomains"],json!(["source","math","teaching"]));
    assert!(!eligible(&store, &record, &q).unwrap());
    let payload = json!({"importId":record["importId"],"expectedRevision":record["revision"],"operationId":"simulated-teacher-evidence","questionId":q["questionId"],"domain":"teaching","basis":"模拟教师已核对主考、难度和作答要求，具体观察不影响此版本实际教学字段。","acknowledge":true,"sourceSha256":view["sourceSha256"],"candidateSha256":view["candidateSha256"]});
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
    assert_eq!(
        project_record(&store, &record).unwrap()["questions"][0]["accuracy"]["teaching"]["status"],
        "teacher_reviewed"
    );
    verify_question(&store, &record, &q).unwrap();
    let previous_run = store::load_run(&store, s(&record, "accuracyRunId")).unwrap();
    let mut changed = record.clone();
    changed["questions"][0]["stem"] = json!("明确修改后的隔离原题：计算17+26。");
    assert!(!eligible(&store, &changed, &changed["questions"][0]).unwrap());
    let changed_view = project_record(&store, &changed).unwrap();
    for domain in ["source", "mathematics", "teaching"] {
        assert_eq!(
            changed_view["questions"][0]["accuracy"][domain]["status"],
            "pending"
        );
    }
    assert_eq!(
        store::load_run(&store, s(&record, "accuracyRunId")).unwrap(),
        previous_run,
        "reads cannot rewrite old domain evidence"
    );
    let mut old = record.clone();
    old.as_object_mut().unwrap().remove("accuracyRunId");
    let legacy_before = old.to_string();
    assert_eq!(
        project_record(&store, &old).unwrap().to_string(),
        legacy_before
    );
    assert_eq!(provider.sent().len(), 6);
}

#[test]
fn actual_math_teacher_evidence_remains_bound_to_solution_when_later_metadata_is_composed() {
    let provider = Provider::start(Scenario::MathIssue);
    let (_directory, mut store, model, mut record) = fixture(&provider);
    process_all(&mut store, &model, &mut record);
    assert_eq!(provider.sent().len(), 4);
    let projected = project_record(&store, &record).unwrap();
    let view = &projected["questions"][0]["accuracy"];
    assert_eq!(view["reviewableDomains"],json!(["source","math"]));
    let payload = json!({"importId":record["importId"],"expectedRevision":record["revision"],"operationId":"simulated-actual-math-teacher","questionId":record["questions"][0]["questionId"],"domain":"math","basis":"模拟教师逐项计算17+25=42并检查所有条件，当前推导完整且本条疑点已有具体反证。","acknowledge":true,"sourceSha256":view["sourceSha256"],"candidateSha256":view["candidateSha256"]});
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
    process_all(&mut store, &model, &mut record);
    assert_eq!(
        provider.sent().len(),
        6,
        "valid upstream stages and blind solve must be reused"
    );
    assert_eq!(
        project_record(&store, &record).unwrap()["questions"][0]["accuracy"]["mathematics"]["status"],
        "teacher_reviewed"
    );
    verify_question(&store, &record, &record["questions"][0]).unwrap();
}

#[test]
fn optional_part_fields_remain_absent_in_the_final_student_contract_after_real_pipeline_checks() {
    let provider = Provider::start(Scenario::Clean);
    let (_directory, mut store, model, mut record) = fixture_with_parts(&provider, true);
    assert!(record["questions"][0]["parts"][0].get("label").is_none());
    process_all(&mut store, &model, &mut record);
    let manifest = final_manifest(&store, &record);
    let parts = &manifest["questions"][0]["student"]["parts"];
    assert_eq!(parts.as_array().unwrap().len(), 2);
    for part in parts.as_array().unwrap() {
        assert!(part.get("label").is_none());
        assert!(part.get("parentPartId").is_none());
    }
    verify_manifest(&store, &record, &manifest).unwrap();
    assert_eq!(provider.sent().len(), 6);
}

#[test]
#[ignore = "explicit browser QA export; preserves only isolated, actual loopback HTTP regression artifacts"]
fn export_real_http_browser_fixture() {
    let output = std::env::var_os("TUTOR_ACCURACY_QA_EXPORT")
        .expect("set an absolute path outside the repository");
    let output = PathBuf::from(output);
    assert!(output.is_absolute());
    let provider = Provider::start(Scenario::TeachingIssue);
    let (directory, mut store, model, mut record) = fixture(&provider);
    process_all(&mut store, &model, &mut record);
    assert_eq!(provider.sent().len(), 6);
    let import_id = record["importId"].clone();
    let question_id = record["questions"][0]["questionId"].clone();
    drop(store);
    let data_dir = directory.keep();
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(&output,serde_json::to_vec_pretty(&json!({"dataDir":data_dir,"importId":import_id,"questionId":question_id,"scenario":"scripted loopback HTTP regression, not mathematical correctness evidence"})).unwrap()).unwrap();
}
