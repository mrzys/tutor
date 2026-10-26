// Simulated persistence/provider regressions, not grading-quality evidence.
use super::*;
use std::{io::Read, net::TcpListener, sync::atomic::AtomicUsize, time::Instant};
fn seed() -> Value {
    crate::bank::tests::seed()
}
fn store() -> (tempfile::TempDir, Store, ModelClient, OcrSettings) {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path(), &seed()).unwrap();
    store
        .save_profile("PRIVATE_LOCAL_NICKNAME", "math")
        .unwrap();
    std::fs::write(directory.path().join("model-settings.json"), b"{}").unwrap();
    let model = ModelClient::open(directory.path()).unwrap();
    let settings = OcrSettings::open(directory.path()).unwrap();
    (directory, store, model, settings)
}
fn png() -> Vec<u8> {
    let mut bytes = Cursor::new(vec![]);
    image::DynamicImage::new_rgb8(12, 16)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}
fn upload(name: &str) -> Value {
    json!({"filename":name,"contentBase64":base64::engine::general_purpose::STANDARD.encode(png())})
}
fn student(store: &Store) -> Value {
    store.create_student(&json!({"operationId":"simulated-student","name":"PRIVATE_STUDENT_NAME","grade":"PRIVATE_GRADE","notes":"PRIVATE_STUDENT_NOTES"})).unwrap()
}
fn external(store: &Store) -> Value {
    let student = student(store);
    create(store,&json!({"operationId":"simulated-work","studentId":student["studentId"],"title":"PRIVATE_WORK_TITLE","completedOn":"2026-10-21","notes":"PRIVATE_WORK_NOTES","source":{"kind":"external","externalSourceMode":"answer_contains_questions","files":[]},"answers":[upload("PRIVATE_UPLOADED_NAME.png")]})).unwrap()["work"].clone()
}
fn answer_only(store: &Store) -> Value {
    let student = student(store);
    create(store,&json!({"operationId":"simulated-answer-only-work","studentId":student["studentId"],"title":"PRIVATE_WORK_TITLE","completedOn":"2026-10-21","notes":"PRIVATE_WORK_NOTES","source":{"kind":"external","files":[]},"answers":[upload("PRIVATE_UPLOADED_NAME.png")]})).unwrap()["work"].clone()
}
fn frozen_paper(store: &Store, parts: bool) -> Value {
    let mut q = seed()["questions"][0].clone();
    q["teacher"]["answers"] = json!([{"partId":"main","text":"2","provenance":"generated"}]);
    q["teacher"]["solutions"] =
        json!([{"partId":"main","text":"模拟参考：一加一等于二","provenance":"generated"}]);
    if parts {
        q["student"]["parts"] =
            json!([{"partId":"p1","prompt":"模拟小问一"},{"partId":"p2","prompt":"模拟小问二"}]);
        q["teacher"]["answers"] = json!([{"partId":"p1","text":"2"},{"partId":"p2","text":"4"}]);
    }
    for (body, prefix, hash_field, version) in [
        ("student", "content", "contentSha256", "contentVersion"),
        ("teacher", "teacher", "teacherSha256", "teacherVersion"),
    ] {
        let hash = hash_json(&q[body]);
        q[hash_field] = json!(hash);
        q[version] = json!(format!("{prefix}-{}", &hash[..16]));
    }
    let draft = json!({"schemaVersion":1,"draftId":"simulated-frozen-draft","revision":1,"title":"PRIVATE_PAPER_TITLE","baseline":{"requirements":{"scoringMode":"none"}},"slots":[{"slotId":"slot-1","number":1,"points":0,"partPoints":[{"partId":"p1","points":0},{"partId":"p2","points":0}],"question":q}]});
    let paper = json!({"schemaVersion":1,"paperId":"simulated-frozen-paper","title":draft["title"],"sourceDraftId":draft["draftId"],"sourceRevision":draft["revision"],"draft":draft,"snapshotSha256":hash_json(&draft),"assets":[]});
    assembly::verify_frozen_paper(&paper).unwrap();
    store
        .put_document("papers", "simulated-frozen-paper", &paper)
        .unwrap();
    paper
}
fn material() -> Vec<Value> {
    vec![
        json!({"fileId":"answer-1","role":"answer","pages":[{"page":1,"text":"1. 计算1+1。学生作答：2"}],"issues":[],"assets":[]}),
    ]
}
fn model_result(id: &str, slot: Value, part: Value) -> Value {
    json!({"items":[{"itemId":id,"slotId":slot,"partId":part,"questionLabel":"1","questionText":"计算1+1","questionStatus":"complete","questionEvidence":[{"fileId":"answer-1","page":1,"quote":"计算1+1"}],"studentAnswer":"2","answerStatus":"recognized","judgement":"correct","reason":"模拟模型逐题建议","confidence":"high","evidence":[{"fileId":"answer-1","page":1,"quote":"学生作答：2"}],"referenceAnswer":"FAKE_GENERATED_REFERENCE","earnedPoints":100}],"summary":"模拟回归建议"})
}

#[test]
fn simulated_question_quote_whitespace_variants_locate_and_preserve_actual_ocr() {
    let question = "4. 求正方形面积和 $S_{11}$。";
    let options = r"A. $2-\frac{1}{2^{12}}$ B. $2(1-\frac{1}{2^{11}})$";
    let mut raw = model_result("external-4", Value::Null, Value::Null);
    raw["items"][0]["questionText"] = json!(question);
    raw["items"][0]["studentAnswer"] = json!("D");
    raw["items"][0]["evidence"][0]["quote"] = json!("学生作答：D");
    raw["items"][0]["questionEvidence"][0]["quote"] = json!(format!("{question}\n{options}"));
    let original_raw = raw.clone();
    for gap in ["\n\n", "\r\n\t", "\u{00a0}\u{3000}\u{0085}"] {
        let actual = format!("{question}{gap}{options}");
        let materials = vec![
            json!({"fileId":"answer-1","role":"answer","pages":[{"page":1,"text":format!("{actual}\n学生作答：D")}],"issues":[],"assets":[]}),
        ];
        let normalized =
            grading::normalize_for_source(&raw, &[], &materials, true, None, "answer_only")
                .unwrap();
        assert_eq!(normalized["items"][0]["judgement"], "correct");
        assert_eq!(
            normalized["items"][0]["questionEvidence"][0]["quote"],
            actual
        );
        assert_eq!(raw, original_raw, "raw AI evidence remains immutable");
    }
}

#[test]
fn simulated_question_quote_changes_wrong_location_empty_and_limit_remain_blocked() {
    let question = "4. 求正方形面积和 $S_{11}$。";
    let quote =
        format!("{question}\nA. $2-\\frac{{1}}{{2^{{12}}}}$ B. $2(1-\\frac{{1}}{{2^{{11}}}})$");
    let actual = quote.replace('\n', "\n\n");
    let materials = vec![
        json!({"fileId":"answer-1","role":"answer","pages":[{"page":1,"text":format!("{actual}\n学生作答：D")}],"issues":[],"assets":[]}),
    ];
    let mut raw = model_result("external-4", Value::Null, Value::Null);
    raw["items"][0]["questionText"] = json!(question);
    raw["items"][0]["studentAnswer"] = json!("D");
    raw["items"][0]["evidence"][0]["quote"] = json!("学生作答：D");
    for changed in [
        quote.replace('-', "+"),
        quote.replace("{12}", "{10}"),
        quote.replace('$', ""),
        quote.replace('。', "，"),
        " \n\u{3000}".into(),
    ] {
        raw["items"][0]["questionEvidence"] =
            json!([{"fileId":"answer-1","page":1,"quote":changed}]);
        let result =
            grading::normalize_for_source(&raw, &[], &materials, true, None, "answer_only")
                .unwrap();
        assert_eq!(result["items"][0]["judgement"], "unable");
        assert!(rows(&result["items"][0]["questionEvidence"]).is_empty());
    }
    for (file, page) in [("source-1", 1), ("answer-1", 2)] {
        raw["items"][0]["questionEvidence"] = json!([{"fileId":file,"page":page,"quote":quote}]);
        assert_eq!(
            grading::normalize_for_source(&raw, &[], &materials, true, None, "answer_only")
                .unwrap()["items"][0]["judgement"],
            "unable"
        );
    }
    let over_limit = format!("{quote}{}", "x".repeat(3001));
    let long_material = vec![
        json!({"fileId":"answer-1","role":"answer","pages":[{"page":1,"text":format!("{over_limit}\n学生作答：D")}],"issues":[],"assets":[]}),
    ];
    raw["items"][0]["questionEvidence"] =
        json!([{"fileId":"answer-1","page":1,"quote":over_limit}]);
    assert_eq!(
        grading::normalize_for_source(&raw, &[], &long_material, true, None, "answer_only")
            .unwrap()["items"][0]["judgement"],
        "unable"
    );
}

#[test]
fn simulated_question_quote_repair_never_relaxes_answer_evidence() {
    let mut raw = model_result("external-1", Value::Null, Value::Null);
    raw["items"][0]["questionEvidence"][0]["quote"] = json!("计算1+1");
    raw["items"][0]["evidence"][0]["quote"] = json!("学生作答：\n2");
    let normalized =
        grading::normalize_for_source(&raw, &[], &material(), true, None, "answer_only").unwrap();
    assert_eq!(normalized["items"][0]["judgement"], "unable");
    assert!(s(&normalized["items"][0], "reason").contains("答卷原文证据"));
}

#[test]
fn answer_only_save_defaults_without_original_and_preserves_explicit_source_modes() {
    let (_dir, store, model, settings) = store();
    let work = answer_only(&store);
    assert_eq!(work["source"]["externalSourceMode"], "answer_only");
    assert!(rows(&work["source"]["files"]).is_empty());
    assert_eq!(read_file(&store, &work, "answer-1").unwrap().1, png());
    assert_eq!(answer_only(&store), work, "same local upload replays");
    assert_eq!(start(&store,&model,&settings,&json!({"workId":work["workId"],"expectedRevision":work["revision"],"operationId":"simulated-unconfigured-answer-only"})).unwrap_err().code,"not_configured");
    let student_id = &work["student"]["studentId"];
    for (i, mode) in [
        "answer_only",
        "answer_contains_questions",
        "separate_materials",
        "uploaded_questions",
        "",
    ]
    .iter()
    .enumerate()
    {
        let requires_source = matches!(*mode, "separate_materials" | "uploaded_questions" | "");
        let payload = json!({"operationId":format!("simulated-mode-{i}"),"studentId":student_id,"title":"模拟其他练习","source":{"kind":"external","externalSourceMode":mode,"files":if requires_source{vec![upload("模拟原题.png")]}else{vec![]}},"answers":[upload("模拟答卷.png")]});
        let saved = create(&store, &payload).unwrap()["work"].clone();
        assert_eq!(
            saved["source"]["externalSourceMode"],
            if mode.is_empty() {
                "uploaded_questions"
            } else {
                *mode
            }
        );
        verify(&saved).unwrap();
        if matches!(*mode, "separate_materials" | "uploaded_questions") {
            let mut missing = payload;
            missing["operationId"] = json!(format!("simulated-missing-mode-{i}"));
            missing["source"]["files"] = json!([]);
            assert_eq!(
                create(&store, &missing).unwrap_err().code,
                "source_required"
            );
        }
    }
}

#[test]
fn answer_only_requires_actual_complete_question_and_answer_evidence() {
    let base = model_result("external-1", Value::Null, Value::Null);
    let normalize = |raw: &Value, materials: &[Value]| {
        grading::normalize_for_source(raw, &[], materials, false, None, "answer_only").unwrap()
    };
    let accepted = normalize(&base, &material());
    assert_eq!(accepted["items"][0]["judgement"], "correct");
    assert_eq!(accepted["coverage"], "answer_materials_only");
    assert_eq!(accepted["completePaperVerified"], false);
    assert_eq!(accepted["items"][0]["referenceAnswer"], Value::Null);
    assert_eq!(accepted["items"][0]["earnedPoints"], Value::Null);
    assert_eq!(accepted["totalScore"], Value::Null);
    for status in ["", "missing", "incomplete", "unreadable", "invented"] {
        let mut raw = base.clone();
        raw["items"][0]["questionStatus"] = json!(status);
        let result = normalize(&raw, &material());
        assert_eq!(result["items"][0]["judgement"], "unable", "{status}");
        assert!(!s(&result["items"][0], "reason").contains("模拟模型逐题建议"));
    }
    for question in ["解：x=2", "答：A", "42", "1.A", "学生作答：2", "计算"] {
        let mut raw = base.clone();
        // The model determines whether the located fragment is a complete
        // question. The runtime verifies its real source, not a word list.
        raw["items"][0]["questionStatus"] = json!("incomplete");
        raw["items"][0]["questionText"] = json!(question);
        raw["items"][0]["questionEvidence"][0]["quote"] = json!(question);
        let materials = vec![
            json!({"fileId":"answer-1","role":"answer","pages":[{"page":1,"text":format!("{question}。学生作答：2")}],"issues":[],"assets":[]}),
        ];
        assert_eq!(
            normalize(&raw, &materials)["items"][0]["judgement"],
            "unable",
            "answer-only content {question}"
        );
    }
    for (question, quote) in [
        ("计算2+2", "计算2+2"),
        ("计算1+1", "编造的题干引用"),
        ("计算1+1", ""),
    ] {
        let mut raw = base.clone();
        raw["items"][0]["questionText"] = json!(question);
        raw["items"][0]["questionEvidence"][0]["quote"] = json!(quote);
        assert_eq!(
            normalize(&raw, &material())["items"][0]["judgement"],
            "unable"
        );
    }
    let mut short = base.clone();
    short["items"][0]["questionText"] = json!("1+1=?");
    short["items"][0]["questionEvidence"][0]["quote"] = json!("1+1=?");
    let short_materials = vec![
        json!({"fileId":"answer-1","role":"answer","pages":[{"page":1,"text":"1+1=? 学生作答：2"}],"issues":[],"assets":[]}),
    ];
    assert_eq!(
        normalize(&short, &short_materials)["items"][0]["judgement"],
        "correct"
    );
    short["items"][0]["evidence"] = json!([]);
    assert_eq!(
        normalize(&short, &short_materials)["items"][0]["judgement"],
        "unable"
    );
    // Old externally supplied-question responses remain readable without the
    // new answer-only completeness fields; local frozen expectations are separate.
    let mut legacy = base;
    legacy["items"][0]
        .as_object_mut()
        .unwrap()
        .remove("questionStatus");
    legacy["items"][0]
        .as_object_mut()
        .unwrap()
        .remove("questionEvidence");
    assert_eq!(
        grading::normalize(&legacy, &[], &material(), false, None).unwrap()["items"][0]["judgement"],
        "correct"
    );
    assert_eq!(
        normalize(&legacy, &material())["items"][0]["judgement"],
        "unable"
    );
}

#[test]
fn simulated_model_question_semantics_and_confidence_are_not_replaced_by_keyword_rules() {
    let mut raw = model_result("external-1", Value::Null, Value::Null);
    raw["items"][0]["questionText"] = json!("Count the circles");
    raw["items"][0]["questionEvidence"] = json!([{"fileId":"answer-1","page":1,"quote":"Count the circles"}]);
    raw["items"][0]["confidence"] = json!("low");
    let materials = vec![json!({"fileId":"answer-1","role":"answer","pages":[{"page":1,"text":"Count the circles。学生作答：2"}],"issues":[],"assets":[]})];
    let result = grading::normalize_for_source(&raw, &[], &materials, true, None, "answer_only").unwrap();
    assert_eq!(result["items"][0]["judgement"], "correct");
    assert_eq!(result["items"][0]["confidence"], "low");
    raw["items"][0]["questionStatus"] = json!("incomplete");
    assert_eq!(grading::normalize_for_source(&raw, &[], &materials, true, None, "answer_only").unwrap()["items"][0]["judgement"], "unable");
    raw["items"][0]["questionStatus"] = json!("complete");
    raw["items"][0]["questionEvidence"][0]["quote"] = json!("model invented a question");
    assert_eq!(grading::normalize_for_source(&raw, &[], &materials, true, None, "answer_only").unwrap()["items"][0]["judgement"], "unable");
}

#[test]
fn answer_only_no_detectable_questions_is_unable_not_failed_or_counted_as_wrong() {
    let result = grading::normalize_for_source(
        &json!({"items":[],"summary":"虚构全卷已完成"}),
        &[],
        &material(),
        false,
        None,
        "answer_only",
    )
    .unwrap();
    assert_eq!(result["items"].as_array().unwrap().len(), 1);
    assert_eq!(result["items"][0]["questionLabel"], "无法定位题目");
    assert_eq!(result["items"][0]["judgement"], "unable");
    assert_eq!(result["items"][0]["maxPoints"], Value::Null);
    assert_eq!(result["completePaperVerified"], false);
    assert_eq!(result["totalScore"], Value::Null);
    assert_ne!(result["summary"], "虚构全卷已完成");
}

#[test]
fn simulated_unsaved_upload_rejects_mixed_files_before_writes_and_allows_correction() {
    let (directory, store, _, _) = store();
    let student = student(&store);
    let mut payload = json!({
        "operationId":"simulated-mixed-upload",
        "studentId":student["studentId"],
        "title":"模拟附件校验恢复",
        "notes":"保留本机输入",
        "source":{"kind":"external","externalSourceMode":"separate_materials","files":[upload("原题.png")]},
        "answers":[upload("答卷第二页.png"),{"filename":"损坏.png","contentBase64":base64::engine::general_purpose::STANDARD.encode(b"not a PNG")},upload("答卷第一页.png")]
    });
    let error = create(&store, &payload).unwrap_err();
    assert_eq!(error.code, "invalid_upload");
    assert_eq!(error.message, "图片签名与类型不一致。");
    assert!(store.list_documents(KIND).unwrap().is_empty());
    assert!(!directory.path().join("student-work").exists(), "even the valid earlier attachments must not be written");

    // The UI retains the inputs, removes the bad file, reorders the good files,
    // and submits a fresh operation only after this explicit unsaved result.
    payload["operationId"] = json!("simulated-corrected-upload");
    payload["answers"] = json!([upload("答卷第一页.png"), upload("答卷第二页.png")]);
    let saved = create(&store, &payload).unwrap()["work"].clone();
    assert_eq!(saved["notes"], "保留本机输入");
    assert_eq!(saved["answerFiles"][0]["filename"], "答卷第一页.png");
    assert_eq!(saved["answerFiles"][1]["filename"], "答卷第二页.png");
    assert_eq!(read_file(&store, &saved, "source-1").unwrap().1, png());
    assert_eq!(read_file(&store, &saved, "answer-1").unwrap().1, png());
    assert_eq!(read_file(&store, &saved, "answer-2").unwrap().1, png());
    assert_eq!(create(&store, &payload).unwrap()["work"], saved);
    assert_eq!(store.list_documents(KIND).unwrap().len(), 1);
}

#[test]
fn simulated_unsaved_upload_file_errors_all_precede_original_or_document_writes() {
    let (directory, store, _, _) = store();
    let student = student(&store);
    let cases = [
        (json!([]), "请上传答卷"),
        (json!([upload("不支持.txt")]), "支持 PDF、PNG、JPEG"),
        (json!([{"filename":"空白.png","contentBase64":""}]), "1字节至15 MB"),
        (json!([{"filename":"编码.png","contentBase64":"not base64!"}]), "附件编码无效"),
        (json!(vec![upload("过量.png"); 9]), "最多8份文件"),
    ];
    for (index, (answers, message)) in cases.into_iter().enumerate() {
        let payload = json!({"operationId":format!("simulated-invalid-upload-{index}"),"studentId":student["studentId"],"title":"模拟附件错误","source":{"kind":"external","files":[]},"answers":answers});
        let error = create(&store, &payload).unwrap_err();
        assert_eq!(error.code, "invalid_upload");
        assert!(error.message.contains(message));
        assert!(store.list_documents(KIND).unwrap().is_empty());
        assert!(!directory.path().join("student-work").exists());
    }
}

#[test]
fn simulated_unsaved_upload_permission_never_masks_replay_or_lookup_failures() {
    let (_directory, store, _, _) = store();
    let student = student(&store);
    let payload = json!({"operationId":"simulated-upload-replay","studentId":student["studentId"],"title":"模拟重放边界","source":{"kind":"external","files":[]},"answers":[upload("答卷.png")]});
    let saved = create(&store, &payload).unwrap()["work"].clone();
    let mut changed_payload = payload.clone();
    changed_payload["answers"][0]["contentBase64"] = json!("not base64!");
    assert_eq!(create(&store, &changed_payload).unwrap_err().code, "operation_conflict");

    let mut corrupted = saved.clone();
    corrupted["answerFiles"][0]["relativePath"] = json!("elsewhere.png");
    store.put_document(KIND, s(&saved, "workId"), &corrupted).unwrap();
    assert_eq!(create(&store, &payload).unwrap_err().code, "integrity_error");
    assert_eq!(store.document(KIND, s(&saved, "workId")).unwrap(), corrupted);

    store.user.execute_batch("ALTER TABLE documents RENAME TO unavailable_documents").unwrap();
    assert_eq!(create(&store, &changed_payload).unwrap_err().code, "storage_error", "a failed lookup must not be treated as an absent operation");
}

#[test]
fn simulated_unsaved_upload_permission_does_not_cover_original_write_failures() {
    let (directory, store, _, _) = store();
    let student = student(&store);
    let occupied = directory.path().join("student-work");
    std::fs::write(&occupied, b"existing path must remain untouched").unwrap();
    let payload = json!({"operationId":"simulated-upload-write-error","studentId":student["studentId"],"title":"模拟写入失败","source":{"kind":"external","files":[]},"answers":[upload("答卷.png")]});
    assert_eq!(create(&store, &payload).unwrap_err().code, "storage_error");
    assert!(store.list_documents(KIND).unwrap().is_empty());
    assert_eq!(std::fs::read(occupied).unwrap(), b"existing path must remain untouched");
}

#[test]
fn local_save_without_provider_replay_and_file_ownership() {
    let (_dir, store, model, settings) = store();
    assert!(!model.configured());
    let work = external(&store);
    assert_eq!(work["status"], "saved");
    let response = dispatch(
        &store,
        &model,
        &settings,
        "student_work_get",
        &json!({"workId":work["workId"]}),
    )
    .unwrap()
    .unwrap();
    assert_eq!(response["work"], work);
    let file = read_file(&store, &work, "answer-1").unwrap();
    assert_eq!(file.1, png());
    assert_eq!(
        read_file(&store, &work, "source-1").unwrap_err().code,
        "not_found"
    );
    assert_eq!(start(&store,&model,&settings,&json!({"workId":work["workId"],"expectedRevision":work["revision"],"operationId":"simulated-start"})).unwrap_err().code,"not_configured");
    let mut altered = work.clone();
    altered["answerFiles"][0]["relativePath"] = json!("elsewhere.png");
    assert_eq!(verify(&altered).unwrap_err().code, "integrity_error");
    let original = store
        .data_dir
        .join(s(&work["answerFiles"][0], "relativePath"));
    std::fs::write(original, b"changed").unwrap();
    assert!(read_file(&store, &work, "answer-1").is_err());
}
#[test]
fn student_update_is_revisioned_idempotent_and_does_not_change_saved_work() {
    let (_dir, store, _, _) = store();
    let work = external(&store);
    let before = store.student(s(&work["student"], "studentId")).unwrap();
    let payload = json!({"studentId":before["studentId"],"operationId":"simulated-update","expectedRevision":before["revision"],"name":"模拟修改后昵称","grade":"高一","notes":"模拟基础备注"});
    let updated = store.update_student(&payload).unwrap();
    assert_eq!(updated["revision"], 1);
    assert_eq!(store.update_student(&payload).unwrap(), updated);
    let mut stale = payload.clone();
    stale["operationId"] = json!("simulated-stale");
    assert_eq!(
        store.update_student(&stale).unwrap_err().code,
        "revision_conflict"
    );
    assert_eq!(
        store.document(KIND, s(&work, "workId")).unwrap()["student"],
        work["student"]
    );
}
#[test]
fn frozen_snapshot_survives_hidden_paper_and_retains_main_answers_without_fake_zero_cap() {
    let (_dir, store, _, _) = store();
    let student = student(&store);
    let paper = frozen_paper(&store, false);
    let work=create(&store,&json!({"operationId":"simulated-paper-work","studentId":student["studentId"],"source":{"kind":"paper","paperId":paper["paperId"]},"answers":[upload("模拟答卷.png")]})).unwrap()["work"].clone();
    let expected = grading::expected_items(&work).unwrap();
    assert_eq!(expected[0]["referenceAnswer"], "2");
    assert_eq!(expected[0]["maxPoints"], Value::Null);
    assert_eq!(
        expected[0]["referenceOrigin"],
        "frozen_reference_not_official_guarantee"
    );
    store.user.execute("INSERT INTO history_deletions(kind,id,operation_id,request_hash,deleted_at) VALUES('papers',?1,'simulated-hide','simulated','2026-10-21')",[s(&paper,"paperId")]).unwrap();
    assert!(store.document("papers", s(&paper, "paperId")).is_err());
    let current = store.document(KIND, s(&work, "workId")).unwrap();
    verify(&current).unwrap();
    assert_eq!(current["source"]["paperSnapshot"], paper);
    let result = grading::normalize(
        &model_result("slot-1", json!("slot-1"), Value::Null),
        &expected,
        &material(),
        false,
        None,
    )
    .unwrap();
    assert_eq!(result["items"][0]["referenceAnswer"], "2");
    assert_eq!(result["items"][0]["earnedPoints"], Value::Null);
    assert_eq!(result["totalScore"], Value::Null);
}
#[test]
fn simulated_printed_numbers_skip_missing_slots_and_keep_frozen_identity_aliases() {
    let (_dir, store, _, _) = store();
    let mut paper = frozen_paper(&store, true);
    let part_slot = paper["draft"]["slots"][0].clone();
    let (_main_dir, main_store, _, _) = self::store();
    let main_paper = frozen_paper(&main_store, false);
    let main_slot = main_paper["draft"]["slots"][0].clone();
    let mut slots = vec![];
    for number in 1..=6 {
        let mut slot = if number == 2 { part_slot.clone() } else { main_slot.clone() };
        slot["slotId"] = json!(format!("slot-{number}"));
        slot["number"] = json!(number);
        if number % 2 == 1 { slot["question"] = Value::Null; }
        slots.push(slot);
    }
    paper["draft"]["slots"] = json!(slots);
    paper["snapshotSha256"] = json!(hash_json(&paper["draft"]));
    assembly::verify_frozen_paper(&paper).unwrap();
    let work = json!({"source":{"kind":"paper","paperSnapshot":paper}});
    let original_work = work.clone();
    let expected = grading::expected_items(&work).unwrap();
    assert_eq!(expected.len(), 4);
    for (index, (identity, label, original, printed)) in [
        ("slot-2::p1", "1（1）", "2（1）", 1),
        ("slot-2::p2", "1（2）", "2（2）", 1),
        ("slot-4", "2", "4", 2),
        ("slot-6", "3", "6", 3),
    ].into_iter().enumerate() {
        assert_eq!(expected[index]["itemId"], identity);
        assert_eq!(expected[index]["questionLabel"], label);
        assert_eq!(expected[index]["printedNumber"], printed);
        assert_eq!(expected[index]["originalQuestionLabel"], original);
        assert_eq!(expected[index]["questionLabelAliases"], json!([label, original]));
        assert_eq!(expected[index]["missingQuestion"], false);
    }
    assert_eq!(expected[0]["slotId"], "slot-2");
    assert_eq!(expected[0]["partId"], "p1");
    assert_eq!(expected[2]["originalSlotNumber"], 4);
    assert_eq!(expected[2]["numberingAmbiguous"], true);
    // Old numbering may identify a different current question: aliases must not
    // replace stable identities or silently remap the model's returned item.
    let mut raw = model_result("slot-4", json!("slot-4"), Value::Null);
    raw["items"][0]["questionLabel"] = json!("4");
    let result = grading::normalize(&raw, &expected, &material(), false, None).unwrap();
    assert_eq!(result["items"].as_array().unwrap().len(), 4);
    assert_eq!(result["items"][0]["itemId"], "slot-4");
    assert_eq!(result["items"][0]["questionLabel"], "2");
    assert_eq!(result["items"][0]["questionLabelAliases"], json!(["2", "4"]));
    assert_eq!(result["items"][0]["judgement"], "correct");
    assert_eq!(result["items"][1]["itemId"], "slot-2::p1");
    assert_eq!(result["items"][1]["questionLabel"], "1（1）");
    assert_eq!(result["items"][1]["originalSlotNumber"], 2);
    assert_eq!(result["items"][1]["judgement"], "unable");
    assert!(rows(&result["items"]).iter().all(|item| !["slot-1", "slot-3", "slot-5"].contains(&s(item, "slotId"))));
    raw["items"][0]["questionEvidence"] = json!([]);
    let ambiguous = grading::normalize(&raw, &expected, &material(), false, None).unwrap();
    assert_eq!(ambiguous["items"][0]["judgement"], "unable");
    assert!(s(&ambiguous["items"][0], "reason").contains("题号存在歧义"));
    assert_eq!(work, original_work, "grading must not rewrite the frozen snapshot");
    assert_eq!(main_store.document("papers", s(&main_paper, "paperId")).unwrap(), main_paper);
}

#[test]
fn parts_are_independent_expected_identities_and_model_cannot_invent_or_duplicate() {
    let (_dir, store, _, _) = store();
    let paper = frozen_paper(&store, true);
    let work = json!({"source":{"kind":"paper","paperSnapshot":paper}});
    let expected = grading::expected_items(&work).unwrap();
    assert_eq!(expected.len(), 2);
    assert_eq!(expected[0]["itemId"], "slot-1::p1");
    let missing =
        grading::normalize(&json!({"items":[]}), &expected, &material(), false, None).unwrap();
    assert_eq!(missing["items"].as_array().unwrap().len(), 2);
    assert!(
        missing["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i["judgement"] == "unable")
    );
    assert_eq!(
        grading::normalize(
            &model_result("slot-2", json!("slot-2"), Value::Null),
            &expected,
            &material(),
            false,
            None
        )
        .unwrap_err()
        .code,
        "invalid_grading"
    );
    let mut duplicate = model_result("slot-1::p1", json!("slot-1"), json!("p1"));
    let item = duplicate["items"][0].clone();
    duplicate["items"].as_array_mut().unwrap().push(item);
    assert_eq!(
        grading::normalize(&duplicate, &expected, &material(), false, None)
            .unwrap_err()
            .code,
        "invalid_grading"
    );
}
#[test]
fn missing_answer_visuals_source_only_fabricated_quotes_and_unknown_status_never_become_wrong() {
    let base = model_result("external-1", Value::Null, Value::Null);
    for mode in ["unreadable", "missing", "bogus", ""] {
        let mut result = base.clone();
        result["items"][0]["answerStatus"] = json!(mode);
        result["items"][0]["judgement"] = json!("incorrect");
        assert_eq!(
            grading::normalize(&result, &[], &material(), false, None).unwrap()["items"][0]["judgement"],
            "unable"
        );
    }
    let mut materials = material();
    materials[0]["role"] = json!("source");
    assert_eq!(
        grading::normalize(&base, &[], &materials, false, None).unwrap()["items"][0]["judgement"],
        "unable"
    );
    let mut fabricated = base.clone();
    fabricated["items"][0]["studentAnswer"] = json!("9999");
    assert_eq!(
        grading::normalize(&fabricated, &[], &material(), false, None).unwrap()["items"][0]["judgement"],
        "unable"
    );
    let mut quoted = base.clone();
    quoted["items"][0]["evidence"]
        .as_array_mut()
        .unwrap()
        .push(json!({"fileId":"answer-1","page":1,"quote":"模型编造的引用"}));
    let result = grading::normalize(&quoted, &[], &material(), false, None).unwrap();
    assert_eq!(result["items"][0]["evidence"].as_array().unwrap().len(), 1);
    assert_eq!(result["items"][0]["referenceAnswer"], Value::Null);
    assert_eq!(result["completePaperVerified"], false);
    assert_eq!(
        grading::normalize(&base, &[], &material(), false, Some("必要配图不可见")).unwrap()["items"]
            [0]["judgement"],
        "unable"
    );
}
#[test]
fn external_original_location_and_blank_status_cannot_be_fabricated() {
    let base = model_result("external-1", Value::Null, Value::Null);
    for choice in ["correct", "unanswered"] {
        let mut contradictory = base.clone();
        contradictory["items"][0]["answerStatus"] = json!("blank_confirmed");
        contradictory["items"][0]["judgement"] = json!(choice);
        assert_eq!(
            grading::normalize(&contradictory, &[], &material(), true, None).unwrap()["items"][0]["judgement"],
            "unable"
        );
    }
    let mut separate = material();
    separate.push(json!({"fileId":"source-1","role":"source","pages":[{"page":1,"text":"原题：计算1+1。"}],"assets":[],"issues":[]}));
    assert_eq!(
        grading::normalize(&base, &[], &separate, false, None).unwrap()["items"][0]["judgement"],
        "correct"
    );
    separate[1]["pages"][0]["text"] = json!("不相关的模拟原题");
    assert_eq!(
        grading::normalize(&base, &[], &separate, false, None).unwrap()["items"][0]["judgement"],
        "unable"
    );
}
#[test]
fn simulated_missing_frozen_visual_only_blocks_its_own_item_not_complete_text_questions() {
    let expected = vec![
        json!({"itemId":"slot-1","slotId":"slot-1","partId":null,"questionLabel":"1","questionText":"计算1+1","missingQuestion":false,"visualRequired":false,"maxPoints":null}),
        json!({"itemId":"slot-2","slotId":"slot-2","partId":null,"questionLabel":"2","questionText":"冻结图形题","missingQuestion":false,"visualRequired":true,"visualReviewAvailable":false,"maxPoints":null}),
    ];
    let mut raw = model_result("slot-1",json!("slot-1"),Value::Null);
    raw["items"].as_array_mut().unwrap().push(model_result("slot-2",json!("slot-2"),Value::Null)["items"][0].clone());
    for image_review in [false,true] {
        let result = grading::normalize(&raw,&expected,&material(),image_review,None).unwrap();
        assert_eq!(result["items"][0]["judgement"],"correct");
        assert_eq!(result["items"][1]["judgement"],"unable");
        assert!(s(&result["items"][1],"reason").contains("此题位"));
        assert_eq!(result["completePaperVerified"],false);
    }
}
#[test]
fn teacher_override_preserves_ai_and_conflicts_and_unscored_score_rejected() {
    let (_dir, store, _, _) = store();
    let original = external(&store);
    let mut completed = original.clone();
    let mut result = grading::normalize(
        &model_result("external-1", Value::Null, Value::Null),
        &[],
        &material(),
        false,
        None,
    )
    .unwrap();
    result["jobId"] = json!("simulated-job");
    completed["aiResult"] = result;
    completed["status"] = json!("completed");
    cas(&store, Some(&original), &completed).unwrap();
    let payload = json!({"workId":completed["workId"],"expectedRevision":completed["revision"],"operationId":"simulated-override","itemId":"external-1","judgement":"partial","comment":"模拟教师指出缺少步骤"});
    let changed = override_result(&store, &payload).unwrap()["work"].clone();
    assert_eq!(changed["aiResult"], completed["aiResult"]);
    assert_eq!(changed["teacherOverrides"][0]["judgement"], "partial");
    assert_eq!(override_result(&store, &payload).unwrap()["work"], changed);
    let mut score = payload.clone();
    score["operationId"] = json!("simulated-invalid-score");
    score["expectedRevision"] = changed["revision"].clone();
    score["earnedPoints"] = json!(1);
    assert_eq!(
        override_result(&store, &score).unwrap_err().code,
        "invalid_score"
    );
}
#[test]
fn independent_recovery_marks_orphan_interrupted_and_old_worker_cannot_overwrite_retry() {
    let (_dir, store, _, _) = store();
    let original = external(&store);
    let mut active = original.clone();
    active["status"] = json!("running");
    active["job"] = json!({"jobId":"simulated-old-job","status":"running","operationId":"simulated-run","payloadHash":"simulated"});
    cas(&store, Some(&original), &active).unwrap();
    recover_background_jobs(&store).unwrap();
    let interrupted = store.document(KIND, s(&active, "workId")).unwrap();
    assert_eq!(interrupted["status"], "interrupted");
    let mut retried = interrupted.clone();
    retried["status"] = json!("running");
    retried["job"] = json!({"jobId":"simulated-new-job","status":"running"});
    cas(&store, Some(&interrupted), &retried).unwrap();
    terminal(
        &store,
        s(&active, "workId"),
        "simulated-old-job",
        Ok(json!({"items":[]})),
    )
    .unwrap();
    assert_eq!(store.document(KIND, s(&active, "workId")).unwrap(), retried);
}

struct Mock {
    base: String,
    requests: Arc<Mutex<Vec<String>>>,
    delay: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Drop for Mock {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
    }
}
fn mock() -> Mock { mock_case(false) }
fn mock_case(visual_gap: bool) -> Mock {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(vec![]));
    let delay = Arc::new(AtomicUsize::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let (b, r, d, st) = (base.clone(), requests.clone(), delay.clone(), stop.clone());
    let thread = std::thread::spawn(move || {
        while !st.load(Ordering::Relaxed) {
            let Ok((mut stream, _)) = listener.accept() else {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut data = vec![];
            let mut buf = [0; 8192];
            loop {
                let n = stream.read(&mut buf).unwrap_or(0);
                if n == 0 {
                    break;
                }
                data.extend_from_slice(&buf[..n]);
                if let Some(end) = data.windows(4).position(|v| v == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&data[..end]).to_ascii_lowercase();
                    let len = headers
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("content-length:")
                                .and_then(|n| n.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if data.len() >= end + 4 + len {
                        break;
                    }
                }
            }
            let request = String::from_utf8_lossy(&data).into_owned();
            let path = request
                .lines()
                .next()
                .unwrap_or("")
                .split_whitespace()
                .nth(1)
                .unwrap_or("")
                .to_owned();
            r.lock().unwrap().push(request);
            let (mime, body) = match path.as_str() {
                "/ocr" => ("application/json",json!({"data":{"jobId":"simulated-ocr"}}).to_string().into_bytes()),
                "/ocr/simulated-ocr" => ("application/json",json!({"data":{"state":"done","resultUrl":{"jsonUrl":format!("{b}/result")},"extractProgress":{"totalPages":1}}}).to_string().into_bytes()),
                "/result" => {
                    let mut blocks = vec![json!({"block_id":1,"block_order":1,"block_label":"text","block_content":"1. 计算1+1。学生作答：2","block_bbox":[1,1,11,5]})];
                    let mut text = "1. 计算1+1。学生作答：2".to_owned();
                    if visual_gap {
                        blocks.push(json!({"block_id":2,"block_order":2,"block_label":"text","block_content":"2. 看图判断。学生作答：A","block_bbox":[1,6,11,9]}));
                        blocks.push(json!({"block_id":3,"block_order":3,"block_label":"image","block_content":"","block_bbox":[1,10,11,15]}));
                        text.push_str("\n2. 看图判断。学生作答：A\n![原图](imgs/img_in_image_box_1_10_11_15.jpg)");
                    }
                    ("application/json",json!({"result":{"layoutParsingResults":[{"inputImage":format!("{b}/page.png"),"prunedResult":{"width":12,"height":16,"page_index":0,"parsing_res_list":blocks},"markdown":{"text":text,"images":{}},"outputImages":{}}]}}).to_string().into_bytes())
                }
                "/page.png" => ("image/png",png()),
                "/v1/chat/completions" => {
                    std::thread::sleep(Duration::from_millis(d.load(Ordering::Relaxed) as u64));
                    let mut result = model_result("external-1",Value::Null,Value::Null);
                    if visual_gap {
                        let mut item = model_result("external-2",Value::Null,Value::Null)["items"][0].clone();
                        item["questionText"] = json!("看图判断");
                        item["questionStatus"] = json!("incomplete");
                        item["questionEvidence"] = json!([{"fileId":"answer-1","page":1,"quote":"看图判断"}]);
                        item["studentAnswer"] = json!("A");
                        item["judgement"] = json!("unable");
                        item["reason"] = json!("模拟模型判断本题缺少实际图像依据，不能判断；其它完整文字题独立批改。");
                        item["evidence"] = json!([{"fileId":"answer-1","page":1,"quote":"学生作答：A"}]);
                        result["items"].as_array_mut().unwrap().push(item);
                    }
                    ("application/json",json!({"choices":[{"finish_reason":"stop","message":{"content":result.to_string()}}]}).to_string().into_bytes())
                }
                _ => panic!("unexpected simulated path {path}"),
            };
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(&body);
        }
    });
    Mock {
        base,
        requests,
        delay,
        stop,
        thread: Some(thread),
    }
}
fn wait(store: &Store, id: &str, status: &str) -> Value {
    let begin = Instant::now();
    loop {
        let record = store.document(KIND, id).unwrap();
        if s(&record, "status") == status {
            return record;
        }
        assert!(
            begin.elapsed() < Duration::from_secs(25),
            "wanted {status}, got {record}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}
#[test]
#[cfg(windows)]
fn simulated_background_mixed_text_and_unseen_visual_are_judged_independently_with_localized_limitations() {
    let (_dir,store,mut model,mut settings)=store();
    let work=answer_only(&store);
    let mock=mock_case(true);
    model.save(&json!({"baseUrl":format!("{}/v1",mock.base),"model":"simulated-work-model","apiKey":"simulated-model-key"})).unwrap();
    settings.save(&json!({"baseUrl":format!("{}/ocr",mock.base),"model":"simulated-ocr","apiKey":"simulated-ocr-key","expectedRevision":0})).unwrap();
    start(&store,&model,&settings,&json!({"workId":work["workId"],"expectedRevision":work["revision"],"operationId":"simulated-mixed-material-limits"})).unwrap();
    let completed=wait(&store,s(&work,"workId"),"completed");
    assert_eq!(completed["aiResult"]["items"][0]["judgement"],"correct");
    assert_eq!(completed["aiResult"]["items"][1]["judgement"],"unable");
    assert_eq!(completed["aiResult"]["completePaperVerified"],false);
    let requests=mock.requests.lock().unwrap();
    let http=requests.iter().find(|request|request.starts_with("POST /v1/chat/completions")).unwrap();
    let body:Value=serde_json::from_str(http.split_once("\r\n\r\n").unwrap().1).unwrap();
    let context:Value=serde_json::from_str(s(&body["messages"][1],"content")).unwrap();
    assert_eq!(context["imageReviewAvailable"],false);
    assert!(rows(&context["contentLimitations"]).iter().any(|limitation|limitation["fileId"]=="answer-1" && limitation["page"]==1 && limitation["code"]=="visual_not_delivered"));
    assert_eq!(completed["aiResult"]["contentLimitations"],context["contentLimitations"]);
    assert!(s(&context,"limitationInstructions").contains("逐项"));
}
#[test]
#[cfg(windows)]
fn background_real_ocr_and_model_are_independent_private_and_history_is_read_only() {
    let (_dir, store, mut model, mut settings) = store();
    let work = answer_only(&store);
    let mock = mock();
    model.save(&json!({"baseUrl":format!("{}/v1",mock.base),"model":"simulated-work-model","apiKey":"simulated-model-key"})).unwrap();
    settings.save(&json!({"baseUrl":format!("{}/ocr",mock.base),"model":"simulated-ocr","apiKey":"simulated-ocr-key","expectedRevision":0})).unwrap();
    let begin = Instant::now();
    let response=start(&store,&model,&settings,&json!({"workId":work["workId"],"expectedRevision":work["revision"],"operationId":"simulated-background"})).unwrap();
    assert!(begin.elapsed() < Duration::from_secs(2));
    assert_eq!(response["job"]["status"], "queued");
    let completed = wait(&store, s(&work, "workId"), "completed");
    assert_eq!(completed["aiResult"]["items"][0]["judgement"], "correct");
    assert_eq!(completed["source"]["externalSourceMode"], "answer_only");
    assert_eq!(completed["aiResult"]["completePaperVerified"], false);
    assert_eq!(completed["aiResult"]["totalScore"], Value::Null);
    let count = mock.requests.lock().unwrap().len();
    for _ in 0..3 {
        dispatch(
            &store,
            &model,
            &settings,
            "student_work_get",
            &json!({"workId":work["workId"]}),
        )
        .unwrap();
        dispatch(&store, &model, &settings, "student_work_list", &json!({})).unwrap();
    }
    assert_eq!(mock.requests.lock().unwrap().len(), count);
    let trace = mock.requests.lock().unwrap().join("\n");
    for private in [
        "PRIVATE_LOCAL_NICKNAME",
        "PRIVATE_STUDENT_NAME",
        "PRIVATE_GRADE",
        "PRIVATE_STUDENT_NOTES",
        "PRIVATE_WORK_TITLE",
        "PRIVATE_WORK_NOTES",
        "PRIVATE_UPLOADED_NAME",
    ] {
        assert!(
            !trace.contains(private),
            "structured private metadata leaked: {private}"
        );
    }
    assert!(trace.contains("answer-1.png"));
    // An actual in-flight request is cancelled independently. A subsequent
    // explicit retry reuses verified OCR, keeps the first result, and cannot be
    // overwritten by the old worker when its HTTP request eventually returns.
    mock.delay.store(800, Ordering::Relaxed);
    let second=start(&store,&model,&settings,&json!({"workId":work["workId"],"expectedRevision":completed["revision"],"operationId":"simulated-delayed-grade"})).unwrap();
    let began = Instant::now();
    loop {
        let current = store.document(KIND, s(&work, "workId")).unwrap();
        if current["job"]["stage"] == "grading" {
            break;
        }
        assert!(began.elapsed() < Duration::from_secs(20));
        std::thread::sleep(Duration::from_millis(20));
    }
    let stopped = cancel(
        &store,
        &json!({"workId":work["workId"],"jobId":second["job"]["jobId"]}),
    )
    .unwrap()["work"]
        .clone();
    assert_eq!(stopped["status"], "cancelled");
    assert_eq!(stopped["aiResult"], completed["aiResult"]);
    mock.delay.store(0, Ordering::Relaxed);
    let retried=start(&store,&model,&settings,&json!({"workId":work["workId"],"expectedRevision":stopped["revision"],"operationId":"simulated-retry-grade"})).unwrap();
    let completed_again = wait(&store, s(&work, "workId"), "completed");
    assert_eq!(
        completed_again["aiResult"]["jobId"],
        retried["job"]["jobId"]
    );
    assert_eq!(rows(&completed_again["attempts"]).len(), 3);
    assert!(
        rows(&completed_again["attempts"])
            .iter()
            .any(|a| a["status"] == "cancelled")
    );
    assert_eq!(
        mock.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.starts_with("POST /ocr "))
            .count(),
        1,
        "retry must reuse completed recognition"
    );
}
