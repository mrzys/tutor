//! Read-only import history. Pagination and projection stay inside SQLite so
//! OCR pages and embedded image payloads are never deserialized for the list.
use super::*;

fn positive(input: &Value, key: &str, default: u64) -> AppResult<u64> {
    match input.get(key) {
        None => Ok(default),
        Some(value) => value
            .as_u64()
            .filter(|n| *n > 0)
            .ok_or_else(|| err("invalid_input", "页码和每页条数必须为正整数。")),
    }
}

/// History deliberately does not replay source files or process evidence. A
/// saved question awaiting publication is a prompt to open the exact detail,
/// not proof that it needs another human check or is currently publishable.
fn action_summary(record: &Value, process: &Value) -> Value {
    let saved = &record["actionSummary"];
    let count = |key| saved[key].as_u64().unwrap_or(0);
    let failed = record["status"] == "failed" || record["backgroundJob"]["status"] == "failed";
    let (next_action, next_label) = if matches!(s(&record["backgroundJob"], "status"), "queued" | "running") {
        ("processing", "查看进度")
    } else if failed {
        ("view_error", "查看原因")
    } else if matches!(s(record, "status"), "prepared" | "processing" | "cancelled" | "interrupted" | "budget_paused")
        || matches!(s(&record["backgroundJob"], "status"), "cancelled" | "interrupted") {
        ("continue_processing", "继续处理")
    } else if count("pendingCount") > 0 {
        ("review", "打开核对")
    } else {
        ("open", "查看记录")
    };
    let mut labels = vec![];
    for (key, label) in [("pendingCount", "待打开核对"), ("duplicateCount", "已识别重复"),
        ("publishedCount", "已入库"), ("rejectedCount", "未采用")] {
        let n = count(key);
        if n > 0 { labels.push(format!("{n} 题{label}")); }
    }
    json!({"schemaVersion":1,"pipeline":saved["pipeline"],"qualification":"open_to_verify","readyCount":null,
        "pendingCount":count("pendingCount"),"duplicateCount":count("duplicateCount"),
        "publishedCount":count("publishedCount"),"rejectedCount":count("rejectedCount"),
        "hasFailure":failed,"technicalFailure":failed && matches!(s(process,"category"),"infrastructure"|"model_output"),
        "failureCategory":if failed {process["category"].clone()} else {Value::Null},
        "label":if labels.is_empty(){"尚未整理出题目".to_owned()}else{labels.join(" · ")},
        "nextAction":next_action,"nextActionLabel":next_label})
}
pub(super) fn list(store: &Store, payload: &Value) -> AppResult<Value> {
    if !payload.is_object() {
        return Err(err("invalid_input", "分页参数必须为对象。"));
    }
    let requested = positive(payload, "page", 1)?;
    let page_size = positive(payload, "pageSize", 10)?;
    if page_size > 100 {
        return Err(err("invalid_input", "每页条数最多为 100。"));
    }
    let transaction = Transaction::new_unchecked(&store.user, TransactionBehavior::Deferred)?;
    let total: u64 = transaction.query_row(
        "SELECT COUNT(*) FROM documents WHERE kind='imports'",
        [],
        |row| row.get::<_, i64>(0),
    )? as u64;
    let total_pages = total.div_ceil(page_size).max(1);
    let page = requested.min(total_pages);
    let offset = (page - 1) * page_size;
    // MATERIALIZED applies LIMIT before projecting fields/counting question
    // arrays. The expression index reads creation time without parsing every
    // historical OCR document, and the result contains only small summaries.
    let mut statement=transaction.prepare("WITH paged AS MATERIALIZED (
        SELECT id,payload FROM documents WHERE kind='imports'
        ORDER BY COALESCE(CAST(json_extract(payload,'$.createdAt') AS TEXT),'') DESC,id DESC
        LIMIT ?1 OFFSET ?2
    ), saved_states AS MATERIALIZED (
        SELECT paged.id,CASE
            WHEN json_extract(CASE WHEN question.type='object' THEN question.value ELSE '{}' END,'$.status')='published' OR EXISTS (
                SELECT 1 FROM json_each(CASE WHEN json_type(payload,'$.publishedQuestionIds')='array' THEN json_extract(payload,'$.publishedQuestionIds') ELSE '[]' END) published
                WHERE published.value=json_extract(CASE WHEN question.type='object' THEN question.value ELSE '{}' END,'$.questionId') AND trim(COALESCE(published.value,''))!=''
            ) THEN 'published'
            WHEN EXISTS (
                SELECT 1 FROM json_each(CASE WHEN json_type(CASE WHEN question.type='object' THEN question.value ELSE '{}' END,'$.duplicateCandidates')='array'
                    THEN json_extract(question.value,'$.duplicateCandidates') ELSE '[]' END) candidate
                WHERE json_type(CASE WHEN candidate.type='object' THEN candidate.value ELSE '{}' END,'$.exact')='true'
            ) THEN 'duplicate'
            WHEN json_extract(CASE WHEN question.type='object' THEN question.value ELSE '{}' END,'$.reviewDecision')='reject' THEN 'rejected'
            ELSE 'pending' END AS state
        FROM paged,json_each(CASE WHEN json_type(payload,'$.questions')='array' THEN json_extract(payload,'$.questions') ELSE '[]' END) question
    ) SELECT json_object(
        'importId',id,
        'filename',json_extract(payload,'$.filename'),
        'displayTitle',CASE WHEN trim(COALESCE(json_extract(payload,'$.structuredSource.exam.title'),''))!='' THEN json_extract(payload,'$.structuredSource.exam.title') ELSE json_extract(payload,'$.filename') END,
        'status',json_extract(payload,'$.status'),
        'revision',json_extract(payload,'$.revision'),
        'createdAt',json_extract(payload,'$.createdAt'),
        'updatedAt',json_extract(payload,'$.updatedAt'),
        'recognitionStage',json_extract(payload,'$.recognitionStage'),
        'backgroundJob',CASE WHEN json_type(payload,'$.backgroundJob')='object' THEN json_object(
            'mode',json_extract(payload,'$.backgroundJob.mode'),'status',json_extract(payload,'$.backgroundJob.status'),
            'error',CASE WHEN json_type(payload,'$.backgroundJob.error')='object' THEN json_object('code',substr(COALESCE(json_extract(payload,'$.backgroundJob.error.code'),''),1,120),'message',substr(COALESCE(json_extract(payload,'$.backgroundJob.error.message'),''),1,600)) ELSE NULL END
        ) ELSE NULL END,
        'error',CASE WHEN json_type(payload,'$.error')='object' THEN json_object('code',substr(COALESCE(json_extract(payload,'$.error.code'),''),1,120),'message',substr(COALESCE(json_extract(payload,'$.error.message'),''),1,600)) ELSE NULL END,
        'questionCount',CASE WHEN json_type(payload,'$.questions')='array' THEN json_array_length(payload,'$.questions') ELSE 0 END,
        'publishedCount',CASE WHEN json_type(payload,'$.publishedQuestionIds')='array' THEN json_array_length(payload,'$.publishedQuestionIds') ELSE 0 END,
        'actionSummary',json_object(
            'pipeline',CASE WHEN trim(COALESCE(json_extract(payload,'$.accuracyRunId'),''))!='' THEN 'accuracy' ELSE 'legacy' END,
            'pendingCount',(SELECT count(*) FROM saved_states WHERE saved_states.id=paged.id AND state='pending'),
            'duplicateCount',(SELECT count(*) FROM saved_states WHERE saved_states.id=paged.id AND state='duplicate'),
            'publishedCount',(SELECT count(*) FROM saved_states WHERE saved_states.id=paged.id AND state='published'),
            'rejectedCount',(SELECT count(*) FROM saved_states WHERE saved_states.id=paged.id AND state='rejected')
        )
    ) FROM paged")?;
    // COUNT is an SQLite i64; clamping bounds offset to that same range.
    let summaries = statement
        .query_map(rusqlite::params![page_size as i64, offset as i64], |row| {
            row.get::<_, String>(0)
        })?;
    let mut imports = summaries
        .map(|row| serde_json::from_str::<Value>(&row?).map_err(AppError::from))
        .collect::<AppResult<Vec<_>>>()?;
    for record in &mut imports {
        let process = diagnostics::process_metadata(record);
        record["actionSummary"] = action_summary(record, &process);
        record["stageKey"] = process["stageKey"].clone();
        record["stageLabel"] = process["stageLabel"].clone();
        if record["status"] == "failed" || record["backgroundJob"]["status"] == "failed" {
            for (target,source) in [("errorCategory","category"),("errorCategoryLabel","categoryLabel"),
                ("errorSubcategory","subcategory"),("errorSubcategoryLabel","subcategoryLabel"),
                ("errorServiceLabel","serviceLabel"),("errorOperationLabel","operationLabel"),("errorCauseNote","causeNote")] {
                record[target] = process[source].clone();
            }
        }
    }
    drop(statement);
    transaction.commit()?;
    Ok(
        json!({"imports":imports,"total":total,"page":page,"pageSize":page_size,"totalPages":total_pages}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Store, ModelClient) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), &crate::bank::tests::seed()).unwrap();
        std::fs::write(dir.path().join("model-settings.json"), b"{}").unwrap();
        let model = ModelClient::open(dir.path()).unwrap();
        assert!(!model.configured());
        (dir, store, model)
    }
    fn insert(store: &Store, count: usize) {
        let large = "simulated-private-ocr-and-base64-asset-".repeat(1000);
        for i in 0..count {
            let id = format!("simulated-import-{i:03}");
            let created = format!("2026-10-{:02}T00:00:00Z", i / 5 + 1);
            let record = json!({"importId":id,"filename":format!("模拟回归{i}.pdf"),"createdAt":created,"updatedAt":created,"status":"pending_review","revision":1,"structuredSource":{"exam":{"title":if i==74{"模拟原卷标题"}else{" "}}},"error":if i==74{json!({"code":"simulated_failed","message":"模拟失败说明","privatePayload":large})}else{Value::Null},"questions":[{"stem":large},{"stem":"模拟第二题"}],"publishedQuestionIds":["simulated-published"],"ocrSource":{"pages":[large]},"extractedPages":[large],"assets":[{"contentBase64":large}]});
            store
                .user
                .execute(
                    "INSERT INTO documents(kind,id,payload) VALUES('imports',?1,?2)",
                    rusqlite::params![id, record.to_string()],
                )
                .unwrap();
        }
    }
    fn call(store: &mut Store, model: &ModelClient, payload: Value) -> Value {
        dispatch(
            store,
            model,
            "imports_list",
            &payload,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap()
    }
    fn ids(result: &Value) -> Vec<String> {
        rows(&result["imports"])
            .iter()
            .map(|r| s(r, "importId").to_owned())
            .collect()
    }
    fn changes(store: &Store) -> i64 {
        store
            .user
            .query_row("SELECT total_changes()", [], |r| r.get(0))
            .unwrap()
    }
    #[test]
    fn simulated_history_counts_saved_dispositions_without_promoting_model_status_or_reading_evidence() {
        let (_dir, mut store, model) = fixture();
        let private = "SIMULATED_HISTORY_PRIVATE_BODY".repeat(1000);
        for (id, accuracy) in [("sim-legacy", false), ("sim-accuracy", true)] {
            let mut record = json!({"importId":id,"filename":"模拟列表.pdf","status":"pending_review",
                "createdAt":"2026-11-03T00:00:00Z","source":{"relativePath":"missing-original.pdf"},
                "publishedQuestionIds":["published"],"questions":[
                    {"questionId":"published","reviewDecision":"reject","duplicateCandidates":[{"exact":true}],"stem":private},
                    {"questionId":"duplicate","reviewDecision":"reject","duplicateCandidates":[{"exact":true}]},
                    {"questionId":"rejected","reviewDecision":"reject"},
                    {"questionId":"self-reviewed","modelReview":{"status":"ready","confidence":"high","issues":[]}},
                    {"questionId":"unverified-projection","accuracy":{"status":"ready"}},
                    {"questionId":"near-duplicate","duplicateCandidates":[{"exact":false}]}
                ],"ocrSource":{"pages":[private]},"assets":[{"contentBase64":private}]});
            if accuracy { record["accuracyRunId"] = json!("missing-process-evidence"); }
            store.put_document("imports", id, &record).unwrap();
        }
        let writes = changes(&store);
        let result = call(&mut store, &model, json!({}));
        for row in rows(&result["imports"]) {
            let summary = &row["actionSummary"];
            assert_eq!(summary["pipeline"], if row["importId"] == "sim-accuracy" { "accuracy" } else { "legacy" });
            assert_eq!(summary["qualification"], "open_to_verify");
            assert_eq!(summary["readyCount"], Value::Null);
            assert_eq!(summary["pendingCount"], 3);
            assert_eq!(summary["duplicateCount"], 1);
            assert_eq!(summary["publishedCount"], 1);
            assert_eq!(summary["rejectedCount"], 1);
            assert_eq!(summary["nextAction"], "review");
            assert_eq!(summary["label"], "3 题待打开核对 · 1 题已识别重复 · 1 题已入库 · 1 题未采用");
        }
        assert!(!result.to_string().contains("SIMULATED_HISTORY_PRIVATE_BODY"));
        assert!(!result.to_string().contains("missing-original.pdf"));
        assert!(!result.to_string().contains("missing-process-evidence"));
        assert_eq!(changes(&store), writes);
    }

    #[test]
    fn simulated_history_next_steps_distinguish_active_interrupted_failure_and_review_without_starting_work() {
        let (_dir, mut store, model) = fixture();
        for (id, status, background, expected) in [
            ("sim-active", "processing", json!({"status":"running"}), "processing"),
            ("sim-queued", "processing", json!({"status":"queued"}), "processing"),
            ("sim-prepared", "prepared", Value::Null, "continue_processing"),
            ("sim-interrupted", "interrupted", Value::Null, "continue_processing"),
            ("sim-paused", "budget_paused", Value::Null, "continue_processing"),
            ("sim-detached", "processing", Value::Null, "continue_processing"),
            ("sim-job-cancelled", "pending_review", json!({"status":"cancelled"}), "continue_processing"),
            ("sim-failed", "failed", Value::Null, "view_error"),
            ("sim-job-failed", "pending_review", json!({"status":"failed","error":{"code":"model_request_timeout"}}), "view_error"),
            ("sim-review", "pending_review", Value::Null, "review"),
        ] {
            let record = json!({"importId":id,"filename":"模拟状态.pdf","status":status,"createdAt":"2026-11-03T00:00:00Z",
                "backgroundJob":background,"error":if status=="failed"{json!({"code":"model_request_timeout"})}else{Value::Null},
                "questions":[{"questionId":"sim-q","stem":"模拟待核对题"}],"publishedQuestionIds":[],"expected":expected});
            store.put_document("imports", id, &record).unwrap();
        }
        store.put_document("imports", "sim-published", &json!({"importId":"sim-published","status":"published",
            "createdAt":"2026-11-03T00:00:00Z","questions":[{"questionId":"sim-published-q","status":"published"}]})).unwrap();
        let writes = changes(&store);
        let result = call(&mut store, &model, json!({"pageSize":20}));
        for row in rows(&result["imports"]) {
            let original = store.document("imports", s(&row,"importId")).unwrap();
            let summary = &row["actionSummary"];
            if row["importId"] == "sim-published" {
                assert_eq!(summary["nextAction"], "open");
                assert_eq!(summary["publishedCount"], 1);
                assert_eq!(summary["pendingCount"], 0);
            } else {
                assert_eq!(summary["nextAction"], original["expected"], "{}", row["importId"]);
            }
            let failed = original["expected"] == "view_error";
            assert_eq!(summary["hasFailure"], failed);
            assert_eq!(summary["technicalFailure"], failed);
            assert_eq!(summary["readyCount"], Value::Null);
        }
        assert_eq!(changes(&store), writes);
    }

    #[test]
    fn history_exposes_bounded_stage_and_current_failure_without_deserializing_material() {
        let (_dir,mut store,model)=fixture();
        let record=json!({"importId":"sim-classification","status":"pending_review","recognitionStage":"annotating",
            "filename":"模拟.pdf","createdAt":"2026-10-29T00:00:00Z","questions":[],
            "backgroundJob":{"mode":"annotation","status":"failed","error":{"code":"model_request_timeout","message":"连接模型服务超时","privatePayload":"must-not-leak"},"privateJob":"must-not-leak"},
            "ocrSource":{"private":"must-not-leak"}});
        store.put_document("imports","sim-classification",&record).unwrap();let writes=changes(&store);
        let result=call(&mut store,&model,json!({}));let row=&result["imports"][0];
        assert_eq!(row["stageKey"],"annotation");assert_eq!(row["errorCategory"],"infrastructure");assert_eq!(row["errorSubcategory"],"network");
        assert!(!result.to_string().contains("must-not-leak"));assert_eq!(changes(&store),writes);assert_eq!(store.document("imports","sim-classification").unwrap(),record);
    }
    #[test]
    fn simulated_seventy_five_imports_page_without_big_fields_or_model_configuration() {
        let (_dir, mut store, model) = fixture();
        insert(&store, 75);
        let writes = changes(&store);
        let first = call(&mut store, &model, json!({}));
        assert_eq!(first["total"], 75);
        assert_eq!(first["page"], 1);
        assert_eq!(first["pageSize"], 10);
        assert_eq!(first["totalPages"], 8);
        assert_eq!(
            ids(&first),
            (65..75)
                .rev()
                .map(|i| format!("simulated-import-{i:03}"))
                .collect::<Vec<_>>()
        );
        let summary = &first["imports"][0];
        assert_eq!(summary["displayTitle"], "模拟原卷标题");
        assert_eq!(summary["questionCount"], 2);
        assert_eq!(summary["publishedCount"], 1);
        assert_eq!(
            summary["error"],
            json!({"code":"simulated_failed","message":"模拟失败说明"})
        );
        assert_eq!(first["imports"][1]["displayTitle"], "模拟回归73.pdf");
        let text = first.to_string();
        for forbidden in [
            "simulated-private-ocr-and-base64-asset-",
            "ocrSource",
            "extractedPages",
            "contentBase64",
            "questions",
            "assets",
            "privatePayload",
        ] {
            assert!(!text.contains(forbidden), "{forbidden}");
        }
        assert!(text.len() < 15_000);
        let second = call(&mut store, &model, json!({"page":2,"pageSize":10}));
        assert_eq!(
            ids(&second),
            (55..65)
                .rev()
                .map(|i| format!("simulated-import-{i:03}"))
                .collect::<Vec<_>>()
        );
        let last = call(&mut store, &model, json!({"page":8,"pageSize":10}));
        assert_eq!(
            ids(&last),
            (0..5)
                .rev()
                .map(|i| format!("simulated-import-{i:03}"))
                .collect::<Vec<_>>()
        );
        assert_eq!(call(&mut store, &model, json!({"page":99999})), last);
        assert_eq!(call(&mut store, &model, json!({"page":u64::MAX})), last);
        assert_eq!(changes(&store), writes);
        let sized = call(&mut store, &model, json!({"page":4,"pageSize":20}));
        assert_eq!(sized["totalPages"], 4);
        assert_eq!(rows(&sized["imports"]).len(), 15);
    }
    #[test]
    fn simulated_empty_import_history_has_one_empty_page_and_rejects_invalid_paging() {
        let (_dir, mut store, model) = fixture();
        let writes = changes(&store);
        let empty = call(&mut store, &model, json!({"page":30}));
        assert_eq!(
            empty,
            json!({"imports":[],"total":0,"page":1,"pageSize":10,"totalPages":1})
        );
        for payload in [
            json!([]),
            json!(null),
            json!("invalid pagination"),
            json!({"page":0}),
            json!({"page":-1}),
            json!({"page":1.5}),
            json!({"page":"2"}),
            json!({"page":true}),
            json!({"page":null}),
            json!({"pageSize":0}),
            json!({"pageSize":101}),
            json!({"pageSize":1.1}),
            json!({"pageSize":"10"}),
            json!({"pageSize":null}),
        ] {
            assert_eq!(
                dispatch(
                    &mut store,
                    &model,
                    "imports_list",
                    &payload,
                    &AtomicBool::new(false)
                )
                .unwrap_err()
                .code,
                "invalid_input"
            );
        }
        assert_eq!(changes(&store), writes);
    }
    #[test]
    fn simulated_review_updates_never_reorder_creation_history_or_equal_timestamp_ties() {
        let (_dir, mut store, model) = fixture();
        insert(&store, 75);
        let original = call(&mut store, &model, json!({}));
        store.user.execute("UPDATE documents SET payload=json_set(payload,'$.updatedAt','2099-01-01T00:00:00Z','$.status','published') WHERE kind='imports' AND id='simulated-import-000'",[]).unwrap();
        let writes = changes(&store);
        assert_eq!(ids(&call(&mut store, &model, json!({}))), ids(&original));
        let last = call(&mut store, &model, json!({"page":8}));
        assert_eq!(
            ids(&last),
            (0..5)
                .rev()
                .map(|i| format!("simulated-import-{i:03}"))
                .collect::<Vec<_>>()
        );
        assert_eq!(last["imports"][4]["status"], "published");
        assert_eq!(changes(&store), writes);
        // The read-only expression index supports chronology directly; it
        // avoids moving every large OCR JSON into a temporary sort buffer.
        let mut stmt=store.user.prepare("EXPLAIN QUERY PLAN SELECT id FROM documents WHERE kind='imports' ORDER BY COALESCE(CAST(json_extract(payload,'$.createdAt') AS TEXT),'') DESC,id DESC LIMIT 10").unwrap();
        let plan = stmt
            .query_map([], |row| row.get::<_, String>(3))
            .unwrap()
            .map(Result::unwrap)
            .collect::<Vec<_>>()
            .join(" ");
        assert!(plan.contains("imports_created_history"), "{plan}");
        assert!(!plan.contains("TEMP B-TREE"), "{plan}");
    }
}
