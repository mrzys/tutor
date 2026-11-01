//! Explicit, question-scoped recovery and post-publication teaching adoption.
//! Publication never changes the immutable source question or original reference.
use super::*;

fn published(record: &Value, id: &str) -> bool {
    ids(&record["publishedQuestionIds"]).iter().any(|v| v == id)
}
fn busy(record: &Value) -> bool {
    matches!(s(&record["backgroundJob"], "status"), "queued" | "running")
        || record["pendingPublication"].is_object()
        || record["pendingTeachingPublication"].is_object()
}
pub(super) fn retry_eligible(q: &Value) -> bool {
    let wf = &q["teachingWorkflow"];
    let findings = rows(&wf["findings"]);
    // Historical generation JSON failures were stored as needs_review after
    // their one review attempt. No valid draft exists to edit; offer an
    // explicit generation retry without refunding or repeating that review.
    let malformed_generation = wf["status"] == "needs_review"
        && findings.iter().all(|f| f["type"] == "technical")
        && findings.iter().any(|f| f["code"] == "model_output_invalid_json");
    wf["sourceContentSha256"] == teaching::source_hash(q)
        && !teaching::ready(q)
        && (wf["status"] == "generation_failed"
            && rows(&wf["findings"])
                .iter()
                .any(|f| f["type"] == "technical")
            || matches!(s(wf, "status"), "generating" | "needs_review")
                && rows(&wf["findings"])
                    .iter()
                    .any(|f| f["code"] == "generation_interrupted")
            || malformed_generation)
        && teaching::controls::active_candidate(q).is_null()
}

fn bank_binding(store: &Store, record: &Value, q: &Value) -> AppResult<(Value, Value)> {
    bank_binding_with_config(&store.bank, record, q, &mut None)
}

fn bank_binding_with_config(
    bank: &dyn BankRepository,
    record: &Value,
    q: &Value,
    config: &mut Option<AppResult<Value>>,
) -> AppResult<(Value, Value)> {
    let id = s(q, "questionId");
    if !published(record, id) {
        return Err(err("teaching_not_published", "请先核对并入库原题。"));
    }
    let raw = bank.question(id)?;
    let config = config.get_or_insert_with(|| bank.config()).as_ref().map_err(Clone::clone)?;
    let matches = rows(&config["assemblyIndex"]["entries"])
        .into_iter()
        .filter(|e| e["questionId"] == id)
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err(err(
            "teaching_analysis_conflict",
            "题库标注身份已变化，请重新核对。",
        ));
    }
    let annotation = matches[0].clone();
    // The bank marker was built from this exact import question at publication.
    // It remains source-bound even when no generated teaching draft was adopted.
    if annotation["importTeachingReview"]["sourceContentSha256"] != teaching::source_hash(q)
        || ["contentVersion", "teacherVersion"]
            .iter()
            .any(|key| annotation[*key] != raw[*key])
    {
        return Err(err(
            "teaching_analysis_conflict",
            "已入库原题或参考版本与本地教学草稿不一致，请重新核对。",
        ));
    }
    Ok((raw, annotation))
}

pub(super) fn projection(store: &Store, record: &Value) -> Value {
    projection_with_bank(&store.bank, record)
}

fn projection_with_bank(bank: &dyn BankRepository, record: &Value) -> Value {
    project(bank, record, true, None)
}

pub(super) fn summary_projection(store: &Store, record: &Value) -> Value {
    project(&store.bank, record, false, None)
}

pub(super) fn question_projection(store: &Store, record: &Value, id: &str) -> Value {
    project(&store.bank, record, false, Some(id))
}

fn project(bank: &dyn BankRepository, record: &Value, all_detail: bool, only_question: Option<&str>) -> Value {
    let mut result = serde_json::Map::new();
    // Reuse one configuration read only within this projection. Publication
    // still reloads and verifies the live bank, and failed reads remain blocked.
    let mut config = None;
    for q in rows(&record["questions"]) {
        let detail = all_detail || only_question == Some(s(&q,"questionId"));
        let candidate = teaching::controls::active_candidate(&q);
        let bound = bank_binding_with_config(bank, record, &q, &mut config);
        let adopted = bound.as_ref().is_ok_and(|(_, annotation)| {
            annotation["teachingAnalysis"]["status"] == "ready"
                && annotation["teachingAnalysis"]["sourceContentSha256"]
                    == teaching::source_hash(&q)
                && annotation["teachingAnalysis"]["sourceCandidate"] == candidate
        });
        let source_ok = question_issues(&q, &record["sourceIssues"]).is_empty()
            && !rows(&q["duplicateCandidates"])
                .iter()
                .any(|v| v["exact"] == true && !published(record, s(&q, "questionId")));
        let mut item = json!({"canRetryGeneration":!busy(record)&&source_ok&&retry_eligible(&q),
            "retryReason":"仅重新生成本题，不自动追加复核；原尝试与已用复核次数保留。",
            "canPublishTeaching":!busy(record)&&source_ok&&teaching::ready(&q)&&bound.is_ok()&&!adopted,
            "publicationReason":if adopted{"当前解析已采用。"}else if !teaching::ready(&q){"解析仍有待处理问题。"}else if bound.is_err(){"须先入库原题，并保持题库原题与参考版本一致。"}else{"独立确认后，仅更新此题的题库教学解析。"},
            "sourceContentSha256":teaching::source_hash(&q),"candidateSha256":if candidate.is_object(){json!(hash_json(&candidate))}else{Value::Null},"adopted":adopted});
        if detail && let Ok((raw, annotation)) = bound {
            for key in ["contentVersion", "teacherVersion"] {
                item[key] = raw[key].clone();
            }
            item["expectedQuestionSha256"] = json!(hash_json(&raw));
            item["expectedAnnotationSha256"] = json!(hash_json(&annotation));
        }
        if record["pendingTeachingPublication"]["manifest"]["questionId"] == q["questionId"] {
            if detail {
                item["pendingTeachingPublicationPayload"] =
                    record["pendingTeachingPublication"]["payload"].clone();
            }
            item["canResumeTeachingPublication"] = json!(
                record["pendingTeachingPublication"]["payload"].is_object()
                    && !matches!(s(&record["backgroundJob"], "status"), "queued" | "running")
            );
        }
        result.insert(s(&q, "questionId").into(), item);
    }
    Value::Object(result)
}

pub(super) fn publish(store: &Store, payload: &Value, cancel: &AtomicBool) -> AppResult<Value> {
    let op = operation(payload)?;
    let hash = hash_json(payload);
    let mut record = store.document("imports", s(payload, "importId"))?;
    if replay(&record, op, &hash)? {
        return Ok(
            json!({"import":record,"replayed":true,"reviewEligibility":review::eligibility(&record)}),
        );
    }
    revision(&record, payload)?;
    cancelled(cancel)?;
    if payload["acknowledgeTeachingUpdate"] != true {
        return Err(err("review_required", "请确认仅更新本题的题库解析。"));
    }
    if matches!(s(&record["backgroundJob"], "status"), "queued" | "running")
        || record["pendingPublication"].is_object()
    {
        return Err(err("import_running", "请先完成当前后台任务或发布操作。"));
    }
    let id = s(payload, "questionId");
    let index = rows(&record["questions"])
        .iter()
        .position(|q| q["questionId"] == id)
        .ok_or_else(|| err("invalid_import", "题目不属于本次导入。"))?;
    let q = &record["questions"][index];
    if !teaching::ready(q)
        || payload["sourceContentSha256"] != teaching::source_hash(q)
        || payload["candidateSha256"] != hash_json(&teaching::controls::active_candidate(q))
        || !question_issues(q, &record["sourceIssues"]).is_empty()
    {
        return Err(err(
            "review_required",
            "解析尚未就绪或版本变化，请重新核对。",
        ));
    }
    read_source(store, &record)?;
    paddle::verify_audit(store, &record)?;
    teaching::verify_audit(store, q)?;
    let manifest = if record["pendingTeachingPublication"].is_object() {
        if record["pendingTeachingPublication"]["operationId"] != op
            || record["pendingTeachingPublication"]["payloadHash"] != hash
        {
            return Err(err(
                "publication_pending",
                "请使用原操作重试完成上次解析更新。",
            ));
        }
        record["pendingTeachingPublication"]["manifest"].clone()
    } else {
        let (raw, annotation) = bank_binding(store, &record, q)?;
        if ["contentVersion", "teacherVersion"]
            .iter()
            .any(|k| payload[*k] != raw[*k])
            || payload["expectedQuestionSha256"] != hash_json(&raw)
            || payload["expectedAnnotationSha256"] != hash_json(&annotation)
        {
            return Err(err(
                "teaching_analysis_conflict",
                "题库版本或标注已变化，请重新查看后确认。",
            ));
        }
        let mut next = annotation.clone();
        teaching::apply_to_entry(q, &raw, &mut next, op)?;
        // Teaching adoption updates only the separate analysis and its review marker.
        let manifest = json!({"operationId":op,"questionId":id,"contentVersion":raw["contentVersion"],"teacherVersion":raw["teacherVersion"],"expectedQuestionSha256":hash_json(&raw),"expectedAnnotationSha256":hash_json(&annotation),"teachingAnalysis":next["teachingAnalysis"],"importTeachingReview":next["importTeachingReview"]});
        let saved = record.clone();
        record["pendingTeachingPublication"] =
            json!({"operationId":op,"payloadHash":hash,"manifest":manifest,"payload":payload});
        save_cas(store, Some(&saved), &record)?;
        manifest
    };
    let receipt = match crate::bank_teaching::apply_import_analysis(&store.bank, &manifest) {
        Ok(receipt) => receipt,
        Err(error) => {
            if error.code != "storage_error" {
                let saved = record.clone();
                record["pendingTeachingPublication"] = Value::Null;
                save_cas(store, Some(&saved), &record)?;
            }
            return Err(error);
        }
    };
    let saved = record.clone();
    record["questions"][index]["teachingPublication"] = json!({"status":"adopted","candidateSha256":payload["candidateSha256"],"sourceContentSha256":payload["sourceContentSha256"],"bankTeachingVersion":manifest["teachingAnalysis"]["teachingVersion"],"operationId":op,"adoptedAt":now()});
    record["pendingTeachingPublication"] = Value::Null;
    let mut history = rows(&record["teachingPublicationHistory"]);
    history.push(receipt.clone());
    record["teachingPublicationHistory"] = json!(history);
    finish(&mut record, op, &hash, "teaching_publish");
    save_cas(store, Some(&saved), &record)?;
    Ok(
        json!({"import":record,"teachingPublication":receipt,"reviewEligibility":review::eligibility(&record)}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        net::TcpListener,
        sync::mpsc,
        time::{Duration, Instant},
    };

    fn fixture() -> (tempfile::TempDir, Store, Value) {
        fixture_with_seed(&crate::bank::tests::seed())
    }
    fn fixture_with_seed(seed: &Value) -> (tempfile::TempDir, Store, Value) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), seed).unwrap();
        let source = save_source(
            &store,
            "sim-triage-actions",
            "txt",
            b"simulated original: 1+1",
        )
        .unwrap();
        let mut q=normalize_question(&json!({"questionType":"fill_blank","sourceLabel":"1","pages":[1],"stem":"模拟回归：1+1=____。","options":[],"parts":[],"answer":"原卷答案2","solution":"原卷参考：1+1=2。","sectionIds":[],"task":{"label":"模拟加法"},"knowledgeUids":[],"knowledgeTopics":[]}),"sim-triage-q1",1).unwrap();
        q["reviewDecision"] = json!("approve");
        q["reviewBasis"] = json!("模拟回归：已核对原卷，不代表真实教师采用。");
        q["reviewChecks"] = json!({"sourceMatched":true,"formulaChecked":true,"answerChecked":true,"solutionChecked":true});
        teaching::initialize_pending(&mut q);
        q["teachingWorkflow"]["status"] = json!("generation_failed");
        q["teachingWorkflow"]["generationCalls"] = json!(1);
        q["teachingWorkflow"]["reviewCalls"] = json!(1);
        q["teachingWorkflow"]["findings"] =
            json!([{"type":"technical","code":"model_request_error","message":"模拟连接失败"}]);
        let mut second = q.clone();
        second["questionId"] = json!("sim-triage-q2");
        second["sourceLabel"] = json!("2");
        second["reviewDecision"] = json!("pending");
        second.as_object_mut().unwrap().remove("teachingWorkflow");
        let record = json!({"importId":"sim-triage-actions","filename":"模拟试卷.txt","revision":1,"createdAt":now(),"updatedAt":now(),"source":source,"questions":[q,second],"sourceIssues":[],"operations":[],"publishedQuestionIds":[],"status":"pending_review"});
        store
            .put_document("imports", "sim-triage-actions", &record)
            .unwrap();
        (dir, store, record)
    }
    struct CountingBank<'a> {
        inner: &'a dyn BankRepository,
        config_reads: std::cell::Cell<usize>,
        question_reads: std::cell::Cell<usize>,
        config_fails: std::cell::Cell<bool>,
    }
    impl<'a> CountingBank<'a> {
        fn new(inner: &'a dyn BankRepository) -> Self {
            Self { inner, config_reads: std::cell::Cell::new(0), question_reads: std::cell::Cell::new(0), config_fails: std::cell::Cell::new(false) }
        }
    }
    impl BankRepository for CountingBank<'_> {
        fn config(&self) -> AppResult<Value> {
            self.config_reads.set(self.config_reads.get() + 1);
            if self.config_fails.get() { return Err(err("storage_error", "模拟题库配置读取失败。")); }
            self.inner.config()
        }
        fn questions(&self) -> AppResult<Vec<Value>> { self.inner.questions() }
        fn question(&self, id: &str) -> AppResult<Value> {
            self.question_reads.set(self.question_reads.get() + 1);
            self.inner.question(id)
        }
    }
    fn published_projection_fixture() -> (tempfile::TempDir, Store, Value) {
        let (dir, store, mut record) = fixture();
        let q = &mut record["questions"][1];
        q["stem"] = json!("模拟回归：2+2=____。");
        q["answer"] = json!("原卷答案4");
        q["solution"] = json!("原卷参考：2+2=4。");
        q["reviewDecision"] = json!("approve");
        teaching::initialize_pending(q);
        store.put_document("imports", "sim-triage-actions", &record).unwrap();
        let mut published = super::super::publish(&store, &json!({"importId":record["importId"],"expectedRevision":record["revision"],"operationId":"sim-projection-publish-two","acknowledgeReview":true}), &AtomicBool::new(false)).unwrap()["import"].clone();
        assert_eq!(rows(&published["publishedQuestionIds"]).len(), 2);
        for q in published["questions"].as_array_mut().unwrap() {
            let candidate = json!({"questionId":q["questionId"],"answer":"模拟答案","difficultyAssessment":{"level":"easy","basis":"模拟投影：直接计算。"},"teachingSolution":"模拟投影：按原题条件计算。","teachingFocusSchemaVersion":2,"teachingFocus":{"examFocus":"模拟加法。","studentRequirements":["能完成计算。"]},"issues":[]});
            q["teachingWorkflow"]["status"] = json!("ready_candidate");
            q["teachingWorkflow"]["findings"] = json!([]);
            q["teachingWorkflow"]["candidateResult"] = candidate.clone();
            q["teachingWorkflow"]["finalResult"] = candidate;
            assert!(teaching::ready(q), "simulated projection candidate must be ready: {q}");
        }
        (dir, store, published)
    }
    #[test]
    fn simulated_projection_defers_config_until_a_published_bank_question_exists() {
        let (_dir, store, mut record) = fixture();
        let bank = CountingBank::new(&store.bank);
        let result = projection_with_bank(&bank, &record);
        assert_eq!(result["sim-triage-q1"]["canRetryGeneration"], true);
        assert_eq!(bank.config_reads.get(), 0);
        assert_eq!(bank.question_reads.get(), 0);
        record["publishedQuestionIds"] = json!(["sim-triage-q1", "sim-triage-q2"]);
        let result = projection_with_bank(&bank, &record);
        assert_eq!(bank.question_reads.get(), 2);
        assert_eq!(bank.config_reads.get(), 0);
        for id in ["sim-triage-q1", "sim-triage-q2"] {
            assert_eq!(result[id]["canPublishTeaching"], false);
            assert!(result[id].get("expectedQuestionSha256").is_none());
        }
    }
    #[test]
    fn simulated_projection_shares_one_config_read_without_caching_between_requests() {
        let (_dir, store, mut record) = published_projection_fixture();
        let bank = CountingBank::new(&store.bank);
        let result = projection_with_bank(&bank, &record);
        assert_eq!(bank.config_reads.get(), 1);
        assert_eq!(bank.question_reads.get(), 2);
        for id in ["sim-triage-q1", "sim-triage-q2"] {
            assert_eq!(result[id]["canPublishTeaching"], true);
            assert_eq!(result[id]["expectedQuestionSha256"], hash_json(&store.bank.question(id).unwrap()));
        }
        record["questions"][1]["stem"] = json!("模拟已改动的原题。");
        let changed = projection_with_bank(&bank, &record);
        assert_eq!(bank.config_reads.get(), 2);
        assert_eq!(bank.question_reads.get(), 4);
        assert_eq!(changed["sim-triage-q1"], result["sim-triage-q1"]);
        assert_eq!(changed["sim-triage-q2"]["canPublishTeaching"], false);
        assert!(changed["sim-triage-q2"].get("expectedAnnotationSha256").is_none());
    }
    #[test]
    fn simulated_projection_config_failure_stays_blocked_and_next_request_can_recover() {
        let (_dir, store, record) = published_projection_fixture();
        let bank = CountingBank::new(&store.bank);
        bank.config_fails.set(true);
        let failed = projection_with_bank(&bank, &record);
        assert_eq!(bank.config_reads.get(), 1, "one failed read must not be retried per question");
        for id in ["sim-triage-q1", "sim-triage-q2"] {
            assert_eq!(failed[id]["canPublishTeaching"], false);
            assert_eq!(failed[id]["adopted"], false);
            assert!(failed[id].get("expectedQuestionSha256").is_none());
            assert!(failed[id].get("expectedAnnotationSha256").is_none());
        }
        bank.config_fails.set(false);
        let recovered = projection_with_bank(&bank, &record);
        assert_eq!(bank.config_reads.get(), 2);
        assert_eq!(recovered["sim-triage-q1"]["canPublishTeaching"], true);
        assert_eq!(recovered["sim-triage-q2"]["canPublishTeaching"], true);
    }
    #[test]
    fn simulated_projection_and_publication_binding_reload_changed_bank_versions() {
        let (_dir, store, record) = published_projection_fixture();
        let bank = CountingBank::new(&store.bank);
        assert_eq!(projection_with_bank(&bank, &record)["sim-triage-q1"]["canPublishTeaching"], true);
        let mut config = store.bank.config().unwrap();
        let annotation = config["assemblyIndex"]["entries"].as_array_mut().unwrap().iter_mut()
            .find(|entry| entry["questionId"] == "sim-triage-q1").unwrap();
        annotation["teacherVersion"] = json!("sim-changed-bank-version");
        store.bank.annotation_connection().execute(
            "UPDATE bank_metadata SET value=?1 WHERE key='config'", [config.to_string()]
        ).unwrap();
        assert_eq!(bank_binding(&store, &record, &record["questions"][0]).unwrap_err().code, "teaching_analysis_conflict");
        let changed = projection_with_bank(&bank, &record);
        assert_eq!(bank.config_reads.get(), 2);
        assert_eq!(changed["sim-triage-q1"]["canPublishTeaching"], false);
        assert!(changed["sim-triage-q1"].get("expectedAnnotationSha256").is_none());
        assert_eq!(changed["sim-triage-q2"]["canPublishTeaching"], true);
    }
    fn request(stream: &mut std::net::TcpStream) -> Value {
        let mut data = vec![];
        loop {
            let mut buf = [0; 8192];
            let n = stream.read(&mut buf).unwrap();
            assert!(n > 0);
            data.extend_from_slice(&buf[..n]);
            if let Some(header) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                let len = String::from_utf8_lossy(&data[..header])
                    .to_lowercase()
                    .lines()
                    .find_map(|l| {
                        l.strip_prefix("content-length:")
                            .and_then(|n| n.trim().parse::<usize>().ok())
                    })
                    .unwrap();
                if data.len() >= header + 4 + len {
                    return serde_json::from_slice(&data[header + 4..header + 4 + len]).unwrap();
                }
            }
        }
    }
    #[test]
    #[ignore = "Explicit UI QA fixture export; requires a new directory under system Temp"]
    fn simulated_export_triage_ui_fixture() {
        let output = std::path::PathBuf::from(
            std::env::var_os("TUTOR_TRIAGE_UI_FIXTURE_DIR")
                .expect("explicit isolated output required"),
        );
        assert!(!output.exists(), "UI fixture output must be new");
        assert!(
            output
                .parent()
                .unwrap()
                .canonicalize()
                .unwrap()
                .starts_with(std::env::temp_dir().canonicalize().unwrap()),
            "only system Temp output is allowed"
        );
        let seed: Value =
            serde_json::from_str(include_str!("../../../resources/seed.json")).unwrap();
        let (dir, store, mut record) = fixture_with_seed(&seed);
        store.save_profile("模拟导入问题验收", "math").unwrap();
        record["questions"][0]["reviewDecision"] = json!("pending");
        record["questions"][0]["reviewChecks"] = json!({"sourceMatched":false,"formulaChecked":false,"answerChecked":false,"solutionChecked":false});
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let model = ModelClient::test_client(
            &store.data_dir,
            &format!("http://{}/v1", listener.local_addr().unwrap()),
        );
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = request(&mut stream);
            let c = json!({"questionId":"sim-triage-q1","answer":"2","difficultyAssessment":{"level":"easy","basis":"模拟：直接相加即可。"},"teachingSolution":"模拟课堂稿：由1+1=2，所求式子的下界为2。","teachingFocusSchemaVersion":2,"teachingFocus":{"examFocus":"模拟整数相加。","studentRequirements":["计算正确的和。"]},"issues":[]});
            let body=json!({"choices":[{"finish_reason":"stop","message":{"content":json!({"questions":[c]}).to_string()}}]}).to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
        });
        store
            .put_document("imports", "sim-triage-actions", &record)
            .unwrap();
        let mut saved = record.clone();
        teaching::generate(
            &store,
            &model,
            &mut record,
            &mut saved,
            &[],
            &AtomicBool::new(false),
            Some(&[0]),
            Some("sim-ui-audit-generation"),
        )
        .unwrap();
        server.join().unwrap();
        let mut failed = record["questions"][1].clone();
        failed["stem"] = json!("模拟技术失败题：计算2+3。");
        teaching::initialize_pending(&mut failed);
        failed["teachingWorkflow"]["status"] = json!("generation_failed");
        failed["teachingWorkflow"]["generationCalls"] = json!(1);
        failed["teachingWorkflow"]["reviewCalls"] = json!(1);
        failed["teachingWorkflow"]["findings"] = json!([{"type":"technical","code":"model_request_error","message":"模拟网络故障；此QA材料不连接真实模型。"}]);
        record["questions"][1] = failed;
        let mut red = record["questions"][1].clone();
        red["questionId"] = json!("sim-triage-q3");
        red["sourceLabel"] = json!("3");
        red["stem"] = json!("模拟材料核对题：条件a=1与a=2同时成立。");
        red.as_object_mut().unwrap().remove("teachingWorkflow");
        red["sourceIssues"] = json!([{"blocking":true,"field":"stem","message":"模拟：模型提示原题条件可能冲突，请对照原卷。"}]);
        record["questions"].as_array_mut().unwrap().push(red);
        let mut eligible = record["questions"][1].clone();
        eligible["questionId"] = json!("sim-triage-q4");
        eligible["sourceLabel"] = json!("4");
        eligible["stem"] = json!("模拟已核对原题：计算3+4。");
        eligible.as_object_mut().unwrap().remove("teachingWorkflow");
        eligible["reviewDecision"] = json!("approve");
        eligible["reviewChecks"] = json!({"sourceMatched":true,"formulaChecked":true,"answerChecked":true,"solutionChecked":true});
        record["questions"].as_array_mut().unwrap().push(eligible);
        record["filename"] = json!("模拟导入问题工作区验收.txt");
        store
            .put_document("imports", "sim-triage-actions", &record)
            .unwrap();
        // A second explicitly simulated document exercises real rich-text and
        // owned student-image rendering without changing the lifecycle fixture.
        let stem = r#"【模拟UI阅读回归材料，不是真实试题】

某矩形示意图的四个顶点，按左下、右下、右上、左上的顺序依次记作 $A,B,C,D$。已知 $AB=8$，$BC=6$。在边 $AB$ 上取点 $P$，设 $AP=x$，其中 $0<x<8$。图中虚线仅表示一条内部分割线，点的位置以题干给出的条件为准。

![模拟矩形与内部分割线示意图](asset:sim-ui-rectangle)

考察代数式

$$f(x)=\frac1x+\frac1{8-x}=\frac8{x(8-x)},\qquad x(8-x)=16-(x-4)^2.$$

下表记录本题已给出的条件，表格仅用于阅读布局回归，不代表学生的真实作答数据。

| 记录项 | 第一次记录 | 第二次记录 | 备注 |
| --- | --- | --- | --- |
| 矩形底边 $AB$ | $8$ | $8$ | 长度条件保持不变 |
| 矩形高 $BC$ | $6$ | $6$ | 垂直于底边 |
| 点 $P$ 的位置 | $AP=x$ | $PB=8-x$ | $0<x<8$ |

<table><thead><tr><th rowspan="2">图形条件</th><th colspan="2">对应关系</th><th rowspan="2">核对说明</th></tr><tr><th>文字</th><th>数学表示</th></tr></thead><tbody><tr><td rowspan="2">矩形</td><td>相邻两边垂直</td><td>$AB\perp BC$</td><td>合并单元格阅读回归</td></tr><tr><td>两组对边分别相等</td><td>$AB=CD,\ BC=AD$</td><td>公式不能被按钮遮挡</td></tr><tr><td>点的位置</td><td colspan="2">点 $P$ 位于线段 $AB$ 内部，且 $AP+PB=8$</td><td>长中文与公式应自然换行</td></tr></tbody></table>

请结合上面的条件完成小问，写出必要的变形与理由。以下较长的恒等式用于检查窄屏下的公式横向滚动：

$$\left(\frac1x+\frac1{8-x}\right)\bigl(x+(8-x)\bigr)=2+\frac{x}{8-x}+\frac{8-x}{x}\ge 2+2\sqrt{\frac{x}{8-x}\cdot\frac{8-x}{x}}=4.$$

本材料会保留完整图片、Markdown 表格、含 rowspan 与 colspan 的 HTML 表格以及展示公式。它用于检查阅读、滚动和操作面板的遮挡情况，不用于评价模型解题质量或真实教学效果。"#;
        let mut image = image::RgbImage::from_pixel(960, 560, image::Rgb([255, 255, 255]));
        let black = image::Rgb([38, 38, 38]);
        let gray = image::Rgb([120, 120, 120]);
        for offset in 0..3 {
            for x in 120..841 {
                image.put_pixel(x, 80 + offset, black);
                image.put_pixel(x, 480 + offset, black);
            }
            for y in 80..483 {
                image.put_pixel(120 + offset, y, black);
                image.put_pixel(840 + offset, y, black);
            }
        }
        for y in 83..480 {
            if (y / 12) % 2 == 0 {
                for offset in 0..2 {
                    image.put_pixel(420 + offset, y, gray);
                }
            }
        }
        for x in 412..430 {
            for y in 473..491 {
                if (x as i32 - 421).pow(2) + (y as i32 - 482).pow(2) <= 70 {
                    image.put_pixel(x, y, black);
                }
            }
        }
        let mut image_bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut image_bytes, image::ImageFormat::Png)
            .unwrap();
        let image_bytes = image_bytes.into_inner();
        let reference = json!({"assetId":"sim-ui-rectangle","path":"assets/sim-ui-rectangle.png","mimeType":"image/png","sha256":sha(&image_bytes)});
        let mut payload = reference.clone();
        payload["role"] = json!("student");
        payload["dataBase64"] =
            json!(base64::engine::general_purpose::STANDARD.encode(&image_bytes));
        let mut rich=normalize_question(&json!({"questionType":"free_response","sourceLabel":"5","pages":[1],"stem":stem,"options":[],"parts":[{"partId":"sim-rich-p1","label":"(1)","prompt":r"证明对任意 $0<x<8$，均有 $f(x)\ge\frac12$，并写出等号成立时 $x$ 的值。","answer":"","solution":""},{"partId":"sim-rich-p2","label":"(2)","prompt":"求矩形 $ABCD$ 的面积，并说明该结果为何与点 $P$ 的位置无关。","answer":"","solution":""}],"answer":"","solution":"","sectionIds":[],"task":{"label":"模拟公式图表阅读"},"knowledgeUids":[],"knowledgeTopics":[]}),"sim-triage-rich-q5",1).unwrap();
        rich["student"] = json!({"assets":[reference]});
        rich["teacher"] = json!({"assets":[]});
        rich["assetPayloads"] = json!([payload]);
        structured::verify_assets(&rich).unwrap();
        let source_body = format!(
            "5. {stem}\n\n(1) 证明 f(x)≥1/2 并写出取等条件。\n(2) 求矩形面积并说明与P的位置无关。\n"
        );
        let rich_source = save_source(
            &store,
            "sim-triage-rich-reading",
            "md",
            source_body.as_bytes(),
        )
        .unwrap();
        let asset_dir = store
            .data_dir
            .join("imports/sim-triage-rich-reading/assets");
        std::fs::create_dir_all(&asset_dir).unwrap();
        std::fs::write(asset_dir.join("sim-ui-rectangle.png"), &image_bytes).unwrap();
        let rich_record = json!({"importId":"sim-triage-rich-reading","filename":"模拟长题公式表格与题图.md","revision":1,"createdAt":now(),"updatedAt":now(),"source":rich_source,"questions":[rich],"sourceIssues":[],"operations":[],"publishedQuestionIds":[],"status":"pending_review"});
        store
            .put_document("imports", "sim-triage-rich-reading", &rich_record)
            .unwrap();
        read_source(&store, &rich_record).unwrap();
        std::fs::write(dir.path().join("SIMULATED-UI-QA.txt"),"模拟UI验收材料，仅HTTP本机mock；不是实测模型质量或教师使用证据。原卷题号1可人工编辑教学术语，并完成仅原题入库→独立解析补发布。其余题仅测试状态展示，不调用真实模型。").unwrap();
        store
            .user
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .unwrap();
        store
            .bank
            .annotation_connection()
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .unwrap();
        drop(store);
        fn copy_dir(from: &std::path::Path, to: &std::path::Path) {
            std::fs::create_dir(to).unwrap();
            for entry in std::fs::read_dir(from).unwrap() {
                let entry = entry.unwrap();
                if entry.file_type().unwrap().is_dir() {
                    copy_dir(&entry.path(), &to.join(entry.file_name()));
                } else {
                    std::fs::copy(entry.path(), to.join(entry.file_name())).unwrap();
                }
            }
        }
        copy_dir(dir.path(), &output);
        println!("UI_FIXTURE={}", output.display());
    }
    #[test]
    fn simulated_retry_projection_does_not_reclassify_math_or_spent_review_as_generation_failure() {
        let (_dir, store, record) = fixture();
        let mut q = record["questions"][0].clone();
        assert!(retry_eligible(&q));
        q["teachingWorkflow"]["status"] = json!("needs_review");
        q["teachingWorkflow"]["findings"] =
            json!([{"type":"quality","dimension":"proof","reason":"模拟证明需补全。"}]);
        assert!(!retry_eligible(&q));
        q["teachingWorkflow"]["findings"] =
            json!([{"type":"technical","code":"model_request_timeout","message":"模拟复核超时。"}]);
        assert!(!retry_eligible(&q));
        q["teachingWorkflow"]["findings"] =
            json!([{"type":"technical","code":"generation_interrupted"}]);
        assert!(retry_eligible(&q));
        q["teachingWorkflow"]["reviewCalls"] = json!(1);
        q["teachingWorkflow"]["findings"] = json!([
            {"type":"technical","code":"model_output_invalid_json"},
            {"type":"technical","code":"invalid_teaching_candidate"}
        ]);
        let before = q.clone();
        assert!(retry_eligible(&q));
        assert_eq!(q,before,"projection must retain the spent review quota");
        q["teachingWorkflow"]["initialCandidate"] = json!({"questionId":"sim-triage-q1","answer":"2","difficultyAssessment":{"level":"easy","basis":"模拟：直接相加。"},"teachingSolution":"模拟：1+1=2。","teachingFocusSchemaVersion":2,"teachingFocus":{"examFocus":"模拟加法。","studentRequirements":["能计算和。"]},"issues":[]});
        assert!(!retry_eligible(&q),"a valid existing draft must not be regenerated");
        q["teachingWorkflow"]["initialCandidate"] = Value::Null;
        q["teachingWorkflow"]["findings"].as_array_mut().unwrap().push(json!({"type":"quality","dimension":"mathematics","reason":"模拟：不能借格式恢复绕过数学问题。"}));
        assert!(!retry_eligible(&q));
        q["teachingWorkflow"]["findings"] = json!([{"type":"technical","code":"model_output_invalid_json"}]);
        q["stem"] = json!("原题已变化");
        assert!(!retry_eligible(&q));
        let mut blocked = record.clone();
        blocked["questions"][0]["sourceIssues"] =
            json!([{"blocking":true,"message":"模拟题图缺失"}]);
        assert_eq!(
            projection(&store, &blocked)["sim-triage-q1"]["canRetryGeneration"],
            false
        );
        assert_eq!(
            store.document("imports", "sim-triage-actions").unwrap(),
            record
        );
    }
    #[test]
    fn simulated_single_retry_then_published_source_teaching_adoption_preserves_references_quota_and_other_question()
     {
        let (_dir, mut store, record) = fixture();
        let second = record["questions"][1].clone();
        assert_eq!(review::eligibility(&record)["sim-triage-q1"]["eligible"],true);
        assert_eq!(review::eligibility(&record)["sim-triage-q1"]["publicationScope"],"source_only");
        let result=super::super::publish(&store,&json!({"importId":record["importId"],"expectedRevision":1,"operationId":"sim-original-only-publish","acknowledgeReview":true}),&AtomicBool::new(false)).unwrap();
        let record = result["import"].clone();
        let raw = store.bank.question("sim-triage-q1").unwrap();
        assert!(
            store.bank.config().unwrap()["assemblyIndex"]["entries"]
                .as_array()
                .unwrap()
                .iter()
                .find(|e| e["questionId"] == "sim-triage-q1")
                .unwrap()["teachingAnalysis"]
                .is_null()
        );
        assert_eq!(
            projection(&store, &record)["sim-triage-q1"]["canRetryGeneration"],
            true
        );
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let model = ModelClient::test_client(
            &store.data_dir,
            &format!("http://{}/v1", listener.local_addr().unwrap()),
        );
        let (seen_tx, seen_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let input = request(&mut stream);
            let context: Value = serde_json::from_str(s(&input["messages"][1], "content")).unwrap();
            assert_eq!(rows(&context["questions"]).len(), 1);
            assert_eq!(context["questions"][0]["questionId"], "sim-triage-q1");
            let c = json!({"questionId":"sim-triage-q1","answer":"2","difficultyAssessment":{"level":"easy","basis":"模拟：直接相加即可。"},"teachingSolution":"模拟：由1+1=2，得到答案。","teachingFocusSchemaVersion":2,"teachingFocus":{"examFocus":"模拟整数相加。","studentRequirements":["计算正确的和。"]},"issues":[]});
            seen_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            let body=json!({"choices":[{"finish_reason":"stop","message":{"content":json!({"questions":[c]}).to_string()}}]}).to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
        });
        let input = json!({"importId":record["importId"],"expectedRevision":record["revision"],"operationId":"sim-explicit-single-generation","questionId":"sim-triage-q1","acknowledgeModelCall":true});
        let accepted = super::super::dispatch(
            &mut store,
            &model,
            "import_teaching_retry_start",
            &input,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
        seen_rx.recv_timeout(Duration::from_secs(15)).unwrap();
        // Replaying an accepted operation never creates a second request.
        let replay = super::super::dispatch(
            &mut store,
            &model,
            "import_teaching_retry_start",
            &input,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
        assert_eq!(accepted["job"]["jobId"], replay["job"]["jobId"]);
        let during = super::super::dispatch(
            &mut store,
            &model,
            "import_job_get",
            &json!({"importId":record["importId"]}),
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
        assert_eq!(during["import"]["questions"][1], second);
        release_tx.send(()).unwrap();
        server.join().unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        let complete = loop {
            let value = super::super::dispatch(
                &mut store,
                &model,
                "import_job_get",
                &json!({"importId":record["importId"]}),
                &AtomicBool::new(false),
            )
            .unwrap()
            .unwrap();
            if !matches!(s(&value["job"], "status"), "queued" | "running") {
                break value;
            }
            assert!(Instant::now() < deadline, "{value}");
            std::thread::sleep(Duration::from_millis(20));
        };
        let record = &complete["import"];
        let q = &record["questions"][0];
        assert!(teaching::ready(q), "{q}");
        assert_eq!(review::eligibility(record)["sim-triage-q1"]["publicationScope"],"source_and_teaching");
        assert_eq!(q["teachingWorkflow"]["reviewCalls"], 1);
        assert_eq!(q["teachingWorkflow"]["generationCalls"], 2);
        assert_eq!(record["questions"][1], second);
        assert_eq!(
            q["teachingRecoveryHistory"][0]["previousWorkflow"]["status"],
            "generation_failed"
        );
        assert_eq!(
            projection(&store, record)["sim-triage-q1"]["canRetryGeneration"],
            false
        );
        let actions = projection(&store, record);
        assert_eq!(actions["sim-triage-q1"]["canPublishTeaching"], true);
        let mut adoption = actions["sim-triage-q1"].clone();
        adoption["importId"] = record["importId"].clone();
        adoption["questionId"] = json!("sim-triage-q1");
        adoption["expectedRevision"] = record["revision"].clone();
        adoption["operationId"] = json!("sim-teaching-later-publish");
        adoption["acknowledgeTeachingUpdate"] = json!(true);
        let adopted = publish(&store, &adoption, &AtomicBool::new(false)).unwrap();
        assert_eq!(
            projection(&store, &adopted["import"])["sim-triage-q1"]["adopted"],
            true
        );
        assert_eq!(store.bank.question("sim-triage-q1").unwrap(), raw);
        assert_eq!(adopted["import"]["questions"][0]["answer"], "原卷答案2");
        assert_eq!(adopted["import"]["questions"][1], second);
        assert_eq!(
            publish(&store, &adoption, &AtomicBool::new(false)).unwrap()["replayed"],
            true
        );
        assert_eq!(
            super::super::dispatch(
                &mut store,
                &model,
                "import_teaching_retry_start",
                &input,
                &AtomicBool::new(false)
            )
            .unwrap()
            .unwrap()["import"]["questions"][0]["teachingWorkflow"]["generationCalls"],
            2
        );
    }
}
