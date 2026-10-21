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
    ) SELECT json_object(
        'importId',id,
        'filename',json_extract(payload,'$.filename'),
        'displayTitle',CASE WHEN trim(COALESCE(json_extract(payload,'$.structuredSource.exam.title'),''))!='' THEN json_extract(payload,'$.structuredSource.exam.title') ELSE json_extract(payload,'$.filename') END,
        'status',json_extract(payload,'$.status'),
        'revision',json_extract(payload,'$.revision'),
        'createdAt',json_extract(payload,'$.createdAt'),
        'updatedAt',json_extract(payload,'$.updatedAt'),
        'error',CASE WHEN json_type(payload,'$.error')='object' THEN json_object('code',substr(COALESCE(json_extract(payload,'$.error.code'),''),1,120),'message',substr(COALESCE(json_extract(payload,'$.error.message'),''),1,600)) ELSE NULL END,
        'questionCount',CASE WHEN json_type(payload,'$.questions')='array' THEN json_array_length(payload,'$.questions') ELSE 0 END,
        'publishedCount',CASE WHEN json_type(payload,'$.publishedQuestionIds')='array' THEN json_array_length(payload,'$.publishedQuestionIds') ELSE 0 END
    ) FROM paged")?;
    // COUNT is an SQLite i64; clamping bounds offset to that same range.
    let summaries = statement
        .query_map(rusqlite::params![page_size as i64, offset as i64], |row| {
            row.get::<_, String>(0)
        })?;
    let imports = summaries
        .map(|row| serde_json::from_str::<Value>(&row?).map_err(AppError::from))
        .collect::<AppResult<Vec<_>>>()?;
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
