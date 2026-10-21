//! Explicit, per-question development maintenance. There is no unsampled release.
//! A report records an agent's actual source review, never a teacher review.
use super::*;

const KIND: &str = "user_authorized_agent_review_v1";
const CHECKS: [&str; 4] = [
    "sourceMatched",
    "answerChecked",
    "solutionChecked",
    "formulaChecked",
];

fn verify_source(store: &Store, record: &Value) -> AppResult<()> {
    let bytes = read_source(store, record)?;
    if record["source"]["extension"] != "pdf" || !bytes.starts_with(b"%PDF-") {
        return Err(err("invalid_source", "代理逐题核验须绑定真实原 PDF。"));
    }
    let pdf = lopdf::Document::load_mem(&bytes)
        .map_err(|_| err("invalid_source", "原 PDF 无法读取。"))?;
    if pdf.get_pages().len() as u64 != record["source"]["physicalPages"].as_u64().unwrap_or(0) {
        return Err(err("source_changed", "原 PDF 页数与核验记录不一致。"));
    }
    structured::verify_audit(store, record)
}

/// Read-only report bindings use the same canonical JSON hash as publication.
pub fn snapshot(store: &Store, import_id: &str) -> AppResult<Value> {
    let record = store.document("imports", import_id)?;
    verify_source(store, &record)?;
    let mut current = rows(&record["questions"]);
    duplicates::annotate(&store.bank, &mut current)?;
    Ok(
        json!({"schemaVersion":1,"importId":record["importId"],"revision":record["revision"],"sourceSha256":record["source"]["sha256"],"auditSha256":record["structuredSource"]["auditSha256"],"bankSnapshotSha256":store.bank.publication_snapshot_sha256()?,"questions":rows(&record["questions"]).iter().zip(current.iter()).map(|(q,checked)|json!({"questionId":q["questionId"],"questionSha256":hash_json(q),"sourceLabel":q["sourceLabel"],"pages":q["pages"],"sourceIssues":question_issues(q,&record["sourceIssues"]),"duplicateCandidates":checked["duplicateCandidates"]})).collect::<Vec<_>>()}),
    )
}

fn validate_report(store: &Store, record: &Value, report: &Value) -> AppResult<Vec<Value>> {
    if report["schemaVersion"] != 1
        || report["kind"] != KIND
        || report["reviewer"] != "codex"
        || s(&report["authorization"], "request").trim().is_empty()
        || s(&report["authorization"], "request").len() > 10_000
    {
        return Err(err(
            "review_required",
            "缺少用户明确授权与代理逐题核验报告；不能按抽样结果放行未核验题。",
        ));
    }
    if report["importId"] != record["importId"] || report["expectedRevision"] != record["revision"]
    {
        return Err(err(
            "revision_conflict",
            "核验报告与当前导入记录修订不一致。",
        ));
    }
    if !record["structuredSource"].is_object()
        || report["sourceSha256"] != record["source"]["sha256"]
        || report["auditSha256"] != record["structuredSource"]["auditSha256"]
        || !report["sourceSha256"].is_string()
        || !report["auditSha256"].is_string()
    {
        return Err(err(
            "source_changed",
            "核验报告未绑定实际原卷与结构化审计。",
        ));
    }
    let selected = report["questions"]
        .as_array()
        .filter(|q| !q.is_empty() && q.len() <= MAX_QUESTIONS)
        .ok_or_else(|| err("review_required", "至少需要一项实际通过的逐题核验。"))?;
    let questions = rows(&record["questions"]);
    let published = ids(&record["publishedQuestionIds"]);
    let mut seen = HashSet::new();
    let mut output = vec![];
    let mut selected_source = HashSet::new();
    for review in selected {
        let id = s(review, "questionId");
        if id.is_empty()
            || !seen.insert(id)
            || published.iter().any(|p| p == id)
            || review["result"] != "pass"
            || s(review, "basis").trim().is_empty()
            || s(review, "basis").chars().count() > 5000
        {
            return Err(err(
                "review_required",
                "每项必须是尚未入库且实际核验通过的唯一题目，并保存核验依据。",
            ));
        }
        let original = questions
            .iter()
            .find(|q| q["questionId"] == id)
            .ok_or_else(|| err("review_required", "核验题目不属于本次导入。"))?;
        if review["questionSha256"] != hash_json(original)
            || review["sourcePages"] != original["pages"]
            || rows(&original["pages"]).is_empty()
        {
            return Err(err(
                "revision_conflict",
                "题目内容或来源页已变化，不能沿用旧核验。",
            ));
        }
        if CHECKS.iter().any(|key| {
            review["checks"][*key]["result"] != "pass"
                || s(&review["checks"][*key], "basis").trim().is_empty()
                || s(&review["checks"][*key], "basis").chars().count() > 5000
        }) {
            return Err(err(
                "review_required",
                "须逐项记录原文、答案、解析和公式的实际核验结果；缺项不能用统一通过替代。",
            ));
        }
        if !structured::is_structured(original)
            || !new_knowledge_annotation(original)
            || original["annotationStatus"] != "succeeded"
        {
            return Err(err(
                "review_required",
                "此维护入口仅处理已完成元数据整理的结构化原卷题目。",
            ));
        }
        let mut q = normalize_question_inner(
            original,
            id,
            record["source"]["physicalPages"].as_u64().unwrap_or(0) as usize,
            true,
        )?;
        // Normalization must not invent a review state or modify source content.
        q["reviewDecision"] = json!("approve");
        q["reviewChecks"] = json!({"sourceMatched":true,"answerChecked":true,"solutionChecked":true,"formulaChecked":true});
        q["reviewBasis"] = review["basis"].clone();
        q["agentReview"] = json!({"method":"user_authorized_agent_review","checkedBy":"codex","reportSha256":hash_json(report),"sourceSha256":report["sourceSha256"],"auditSha256":report["auditSha256"],"review":review});
        check_approved(&q, record)?;
        structured::verify_assets(&q)?;
        let source_identity = hash_json(
            &json!({"system":q["sourceIdentity"]["system"],"questionId":q["sourceIdentity"]["questionId"],"contentVersionId":q["sourceIdentity"]["contentVersionId"]}),
        );
        if !selected_source.insert(source_identity) {
            return Err(err(
                "duplicate_question",
                "同一份逐题核验清单不能重复发布原题。",
            ));
        }
        output.push(q);
    }
    duplicates::annotate(&store.bank, &mut output)?;
    if output.iter().any(|q| {
        rows(&q["duplicateCandidates"])
            .iter()
            .any(|c| c["exact"] == true)
    }) {
        return Err(err(
            "duplicate_question",
            "已核验题目存在于本机题库，保留原题并拒绝重复发布。",
        ));
    }
    Ok(output)
}

/// Called only by the debug maintenance binary, not imports::dispatch or IPC.
pub fn publish(store: &Store, payload: &Value, cancel: &AtomicBool) -> AppResult<Value> {
    let op = operation(payload)?;
    let payload_hash = hash_json(payload);
    let report = &payload["reviewReport"];
    let report_hash = hash_json(report);
    let mut record = store.document("imports", s(report, "importId"))?;
    if replay(&record, op, &payload_hash)? {
        let receipt = rows(&record["publicationHistory"])
            .into_iter()
            .find(|r| r["publicationId"] == op)
            .unwrap_or(Value::Null);
        return Ok(json!({"import":record,"publication":receipt}));
    }
    cancelled(cancel)?;
    verify_source(store, &record)?;
    let pending = record["pendingPublication"].is_object();
    let (manifest, selected) = if pending {
        let checkpoint = &record["pendingPublication"];
        if checkpoint["operationId"] != op
            || checkpoint["payloadHash"] != payload_hash
            || checkpoint["authority"] != "user_authorized_agent_review"
            || checkpoint["reportSha256"] != report_hash
        {
            return Err(err(
                "publication_pending",
                "请使用原逐题核验报告与操作标识完成上次发布。",
            ));
        }
        // A bank commit may already have happened. Its immutable manifest and
        // receipt are replayed without treating our own question as a new duplicate.
        if checkpoint["manifest"]["agentReview"] != *report
            || checkpoint["expectedRevision"] != record["revision"]
        {
            return Err(err(
                "revision_conflict",
                "待恢复发布的核验报告或导入修订不一致。",
            ));
        }
        for review in rows(&report["questions"]) {
            let q = rows(&record["questions"])
                .into_iter()
                .find(|q| q["questionId"] == review["questionId"])
                .ok_or_else(|| err("revision_conflict", "待恢复发布题目已变化。"))?;
            if review["questionSha256"] != hash_json(&q) {
                return Err(err("revision_conflict", "待恢复题目内容已变化。"));
            }
        }
        (
            checkpoint["manifest"].clone(),
            rows(&checkpoint["reviewedQuestions"]),
        )
    } else {
        let selected = validate_report(store, &record, report)?;
        if report["bankSnapshotSha256"] != store.bank.publication_snapshot_sha256()? {
            return Err(err(
                "bank_snapshot_conflict",
                "题库已变化，请重新检查重复题并绑定最新快照。",
            ));
        }
        let mut reviewed = record.clone();
        reviewed["questions"] = json!(selected);
        reviewed["updatedAt"] = json!(now());
        let manifest = build_manifest_with_review(store, &reviewed, Some(report))?;
        let saved = record.clone();
        record["pendingPublication"] = json!({"authority":"user_authorized_agent_review","operationId":op,"payloadHash":payload_hash,"reportSha256":report_hash,"expectedRevision":record["revision"],"manifest":manifest,"reviewedQuestions":selected});
        save_cas(store, Some(&saved), &record)?;
        (manifest, selected)
    };
    cancelled(cancel)?;
    let receipt = match store.bank.publish_agent_review(
        op,
        &manifest,
        &report_hash,
        s(report, "bankSnapshotSha256"),
    ) {
        Ok(receipt) => receipt,
        Err(error) => {
            if error.code != "storage_error" {
                let saved = record.clone();
                record["pendingPublication"] = Value::Null;
                record["error"] = serde_json::to_value(&error)?;
                save_cas(store, Some(&saved), &record)?;
            }
            return Err(error);
        }
    };
    let saved = record.clone();
    let mut qs = rows(&record["questions"]);
    let mut published = ids(&record["publishedQuestionIds"]);
    for q in selected {
        let id = s(&q, "questionId").to_owned();
        let current = qs
            .iter_mut()
            .find(|old| old["questionId"] == id)
            .ok_or_else(|| err("revision_conflict", "发布题目身份已变化。"))?;
        for field in [
            "reviewDecision",
            "reviewChecks",
            "reviewBasis",
            "agentReview",
        ] {
            current[field] = q[field].clone();
        }
        if !published.contains(&id) {
            published.push(id);
        }
    }
    record["questions"] = json!(qs);
    record["publishedQuestionIds"] = json!(published);
    record["status"] = json!(if rows(&record["questions"])
        .iter()
        .all(|q| published.iter().any(|p| p == s(q, "questionId"))
            || q["reviewDecision"] == "reject")
    {
        "published"
    } else {
        "partially_published"
    });
    record["pendingPublication"] = Value::Null;
    record["error"] = Value::Null;
    let mut history = rows(&record["publicationHistory"]);
    history.push(receipt.clone());
    record["publicationHistory"] = json!(history);
    finish(
        &mut record,
        op,
        &payload_hash,
        "user_authorized_agent_review_publish",
    );
    save_cas(store, Some(&saved), &record)?;
    Ok(json!({"import":record,"publication":receipt}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Store, Value) {
        use lopdf::{Document, Stream, dictionary};
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), &crate::bank::tests::seed()).unwrap();
        let mut pdf = Document::with_version("1.5");
        let pages = pdf.new_object_id();
        let stream = pdf.add_object(Stream::new(dictionary! {}, b"".to_vec()));
        let page=pdf.add_object(dictionary!{"Type"=>"Page","Parent"=>pages,"Contents"=>stream,"MediaBox"=>vec![0.into(),0.into(),300.into(),300.into()]});
        pdf.objects.insert(
            pages,
            lopdf::Object::Dictionary(
                dictionary! {"Type"=>"Pages","Kids"=>vec![page.into()],"Count"=>1},
            ),
        );
        let root = pdf.add_object(dictionary! {"Type"=>"Catalog","Pages"=>pages});
        pdf.trailer.set("Root", root);
        let mut bytes = vec![];
        pdf.save_to(&mut bytes).unwrap();
        let mut source = save_source(&store, "simulated-agent", "pdf", &bytes).unwrap();
        source["physicalPages"] = json!(1);
        let audit = json!({"simulation":"This fixture proves engineering boundaries, not a real teacher review."});
        let relative = "imports/simulated-agent/source-audit.json";
        std::fs::write(
            dir.path().join(relative),
            serde_json::to_vec(&audit).unwrap(),
        )
        .unwrap();
        let questions=(0..2).map(|i|{
            let input=json!({"questionType":"fill_blank","stem":format!("模拟隔离回归：计算 $17+{}=$____。",i+1),"options":[],"parts":[],"answer":"","solution":"","pages":[1],"sourceLabel":(i+1).to_string(),"sourceIdentity":{"system":"legacy_tutor_kb","examId":"simulated-agent","occurrenceId":format!("occ-{i}"),"questionId":format!("old-q-{i}"),"contentVersionId":"old-cv-1","contentHash":"b".repeat(64)},"knowledgeSchemaVersion":2,"primaryKnowledgeUids":[],"solutionPaths":[],"task":{"label":"模拟加法"},"annotationStatus":"succeeded","legacyReferences":{"answers":[{"text":"模拟旧模型参考，不采纳","provenance":"generated"}],"solutions":[]}});
            normalize_question_inner(&input,&format!("simulated-agent-q{i}"),1,true).unwrap()
        }).collect::<Vec<_>>();
        let record = json!({"importId":"simulated-agent","filename":"模拟隔离原卷.pdf","revision":1,"status":"pending_review","source":source,"sourceIssues":[],"structuredSource":{"auditRelativePath":relative,"auditSha256":hash_json(&audit)},"questions":questions,"publishedQuestionIds":[],"operations":[],"publicationHistory":[],"updatedAt":"2026-10-20T00:00:00Z"});
        save_cas(&store, None, &record).unwrap();
        (dir, store, record)
    }
    fn report(store: &Store, record: &Value) -> Value {
        let bindings = snapshot(store, s(record, "importId")).unwrap();
        let q = &record["questions"][0];
        let mut checks = json!({});
        for key in CHECKS {
            checks[key] = json!({"result":"pass","basis":format!("模拟隔离回归的 {key} 分项核验；无原卷答案与解析，保留为空。")});
        }
        json!({"schemaVersion":1,"kind":KIND,"reviewer":"codex","importId":record["importId"],"expectedRevision":record["revision"],"sourceSha256":bindings["sourceSha256"],"auditSha256":bindings["auditSha256"],"bankSnapshotSha256":bindings["bankSnapshotSha256"],"authorization":{"request":"模拟用户明确授权：仅将实际逐题核验通过题入库。"},"questions":[{"questionId":q["questionId"],"questionSha256":hash_json(q),"result":"pass","sourcePages":q["pages"],"checks":checks,"basis":"模拟回归：对照原 PDF 逐项核验通过，明确保留答案与解析缺项；不表示真实教师审核。"}]})
    }
    fn request(report: Value, op: &str) -> Value {
        json!({"operationId":op,"reviewReport":report})
    }
    fn run(store: &Store, report: Value, op: &str) -> AppResult<Value> {
        publish(store, &request(report, op), &AtomicBool::new(false))
    }
    #[test]
    fn individually_reviewed_subset_publishes_without_teacher_claim_or_unsampled_changes() {
        let (_dir, store, record) = fixture();
        let report = report(&store, &record);
        let published = run(&store, report.clone(), "simulated-agent-publish").unwrap();
        assert_eq!(published["publication"]["addedQuestions"], 1);
        assert_eq!(published["import"]["status"], "partially_published");
        assert_eq!(published["import"]["questions"][1], record["questions"][1]);
        assert_eq!(
            published["import"]["questions"][0]["reviewChecks"]["sourceMatched"],
            true
        );
        assert_eq!(
            published["import"]["questions"][0]["agentReview"]["checkedBy"],
            "codex"
        );
        let bank_q = store.bank.question("simulated-agent-q0").unwrap();
        assert_eq!(
            bank_q["verification"]["method"],
            "user_authorized_agent_review"
        );
        assert_eq!(bank_q["verification"]["checkedBy"], "codex");
        assert_eq!(bank_q["teacher"]["answers"], json!([]));
        assert_eq!(bank_q["teacher"]["solutions"], json!([]));
        assert_eq!(
            bank_q["legacyReferences"]["answers"][0]["provenance"],
            "generated"
        );
        let config = store.bank.config().unwrap();
        let entry = rows(&config["assemblyIndex"]["entries"])
            .into_iter()
            .find(|e| e["questionId"] == "simulated-agent-q0")
            .unwrap();
        assert_eq!(entry["primaryKnowledgeUids"], json!([]));
        assert_eq!(entry["solutionPaths"], json!([]));
        assert!(s(&entry, "notes").contains("自动适配未知"));
        assert_eq!(
            run(&store, report, "simulated-agent-publish").unwrap()["import"],
            published["import"]
        );
        assert_eq!(store.bank.questions().unwrap().len(), 2);
        let mut changed = published["import"]["questions"].clone();
        changed[0]["reviewBasis"] = json!("不能覆写已发布代理核验来源");
        assert_eq!(review_save(&store,&json!({"importId":record["importId"],"operationId":"simulated-agent-no-relabel","expectedRevision":published["import"]["revision"],"questions":changed})).unwrap_err().code,"immutable_question");
    }
    #[test]
    fn reports_reject_nonpass_checks_scope_source_and_revision_without_writes() {
        let (_dir, store, record) = fixture();
        let report = report(&store, &record);
        for index in 0..12 {
            let mut bad = report.clone();
            match index {
                0 => bad["authorization"]["request"] = json!(""),
                1 => bad["reviewer"] = json!("local_teacher"),
                2 => bad["questions"][0]["result"] = json!("uncertain"),
                3 => bad["questions"][0]["checks"]["formulaChecked"]["result"] = json!("fail"),
                4 => bad["questions"][0]["checks"]["sourceMatched"]["basis"] = json!(""),
                5 => bad["questions"][0]["questionSha256"] = json!("wrong"),
                6 => bad["expectedRevision"] = json!(0),
                7 => bad["sourceSha256"] = json!("wrong"),
                8 => bad["auditSha256"] = json!("wrong"),
                9 => bad["questions"][0]["sourcePages"] = json!([2]),
                10 => bad["questions"][0]["questionId"] = json!("other-import-question"),
                _ => {
                    let duplicate = bad["questions"][0].clone();
                    bad["questions"].as_array_mut().unwrap().push(duplicate);
                }
            }
            assert!(run(&store, bad, &format!("simulated-agent-reject-{index}")).is_err());
            assert_eq!(
                store.document("imports", "simulated-agent").unwrap(),
                record
            );
            assert_eq!(store.bank.questions().unwrap().len(), 1);
        }
        // The default teacher publication gate cannot consume an agent manifest.
        let selected = validate_report(&store, &record, &report).unwrap();
        let mut clone = record.clone();
        clone["questions"] = json!(selected);
        let manifest = build_manifest_with_review(&store, &clone, Some(&report)).unwrap();
        assert_eq!(manifest["teacherConfirmed"], false);
        assert_eq!(
            store
                .bank
                .publish_import("simulated-agent-no-teacher-bypass", &manifest)
                .unwrap_err()
                .code,
            "review_required"
        );
        assert_eq!(
            build_manifest(&store, &record).unwrap_err().code,
            "review_required"
        );
    }
    #[test]
    fn damaged_source_assets_and_blocking_findings_still_reject() {
        for mode in 0..4 {
            let (dir, store, mut record) = fixture();
            match mode {
                0 => {
                    std::fs::write(
                        dir.path().join(s(&record["source"], "relativePath")),
                        b"broken PDF",
                    )
                    .unwrap();
                }
                1 => {
                    std::fs::write(
                        dir.path()
                            .join(s(&record["structuredSource"], "auditRelativePath")),
                        b"{}",
                    )
                    .unwrap();
                }
                2 => {
                    record["questions"][0]["sourceIssues"] =
                        json!([{"code":"simulated_loss","message":"模拟题面缺失","blocking":true}]);
                    store
                        .put_document("imports", "simulated-agent", &record)
                        .unwrap();
                }
                _ => {
                    record["questions"][0]["stem"] =
                        json!("模拟如图 ![缺图](asset:missing) 求值。");
                    store
                        .put_document("imports", "simulated-agent", &record)
                        .unwrap();
                }
            }
            if mode < 2 {
                assert!(snapshot(&store, "simulated-agent").is_err());
                continue;
            }
            let report = report(&store, &record);
            assert!(run(&store, report, "simulated-agent-damaged").is_err());
            assert_eq!(store.bank.questions().unwrap().len(), 1);
        }
    }
    #[test]
    fn stale_bank_snapshot_rejects_and_exact_duplicate_is_rechecked() {
        let (_dir, store, record) = fixture();
        let mut stale = report(&store, &record);
        stale["bankSnapshotSha256"] = json!("stale");
        assert_eq!(
            run(&store, stale, "simulated-agent-stale")
                .unwrap_err()
                .code,
            "bank_snapshot_conflict"
        );
        let first_report = report(&store, &record);
        run(&store, first_report, "simulated-agent-first").unwrap();
        let mut duplicate = record.clone();
        duplicate["importId"] = json!("simulated-agent-duplicate");
        duplicate["questions"][0]["questionId"] = json!("simulated-agent-another-id");
        store
            .put_document("imports", "simulated-agent-duplicate", &duplicate)
            .unwrap();
        let report = report(&store, &duplicate);
        assert_eq!(
            run(&store, report, "simulated-agent-duplicate")
                .unwrap_err()
                .code,
            "duplicate_question"
        );
        assert_eq!(store.bank.questions().unwrap().len(), 2);
    }
    #[test]
    fn bank_commit_before_personal_receipt_recovers_the_same_agent_publication() {
        let (_dir, store, record) = fixture();
        let report = report(&store, &record);
        let payload = request(report.clone(), "simulated-agent-crash");
        let selected = validate_report(&store, &record, &report).unwrap();
        let mut reviewed = record.clone();
        reviewed["questions"] = json!(selected);
        let manifest = build_manifest_with_review(&store, &reviewed, Some(&report)).unwrap();
        let mut checkpoint = record.clone();
        checkpoint["pendingPublication"] = json!({"authority":"user_authorized_agent_review","operationId":payload["operationId"],"payloadHash":hash_json(&payload),"reportSha256":hash_json(&report),"expectedRevision":record["revision"],"manifest":manifest,"reviewedQuestions":selected});
        save_cas(&store, Some(&record), &checkpoint).unwrap();
        store
            .bank
            .publish_agent_review(
                s(&payload, "operationId"),
                &manifest,
                &hash_json(&report),
                s(&report, "bankSnapshotSha256"),
            )
            .unwrap();
        let recovered = publish(&store, &payload, &AtomicBool::new(false)).unwrap();
        assert_eq!(recovered["publication"]["replayed"], true);
        assert_eq!(store.bank.questions().unwrap().len(), 2);
        assert_eq!(rows(&recovered["import"]["publicationHistory"]).len(), 1);
        assert_eq!(recovered["import"]["questions"][1], record["questions"][1]);
        assert_eq!(
            publish(&store, &payload, &AtomicBool::new(false)).unwrap()["import"],
            recovered["import"]
        );
    }
    #[test]
    fn cancellation_stale_import_and_operation_reuse_preserve_data() {
        let (_dir, store, record) = fixture();
        let review = report(&store, &record);
        let payload = request(review.clone(), "simulated-agent-cancel");
        assert_eq!(
            publish(&store, &payload, &AtomicBool::new(true))
                .unwrap_err()
                .code,
            "cancelled"
        );
        assert_eq!(
            store.document("imports", "simulated-agent").unwrap(),
            record
        );
        let mut changed = record.clone();
        changed["revision"] = json!(2);
        changed["questions"][1]["stem"] = json!("模拟另窗口保存了未选题修改，不能丢失。");
        save_cas(&store, Some(&record), &changed).unwrap();
        assert_eq!(
            run(&store, review, "simulated-agent-stale-import")
                .unwrap_err()
                .code,
            "revision_conflict"
        );
        assert_eq!(
            store.document("imports", "simulated-agent").unwrap(),
            changed
        );
        let review = report(&store, &changed);
        let result = run(&store, review.clone(), "simulated-agent-reuse").unwrap();
        let mut other = review;
        other["questions"][0]["basis"] = json!("不同审核依据不能复用原操作标识。");
        assert_eq!(
            run(&store, other, "simulated-agent-reuse")
                .unwrap_err()
                .code,
            "operation_conflict"
        );
        assert_eq!(
            store.document("imports", "simulated-agent").unwrap(),
            result["import"]
        );
        assert_eq!(result["import"]["questions"][1], changed["questions"][1]);
    }
}
