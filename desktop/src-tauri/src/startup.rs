//! Read-only startup projections. Runtime migrations and every mutation retain
//! their existing complete-source, version, and ownership checks.
use crate::{Runtime, error::AppResult};
use serde_json::{Value, json};

pub(super) fn workspace_config(runtime: &Runtime) -> AppResult<Value> {
    let mut config = runtime.store.bank.workspace_config()?;
    let status = json!({"configured":runtime.model.configured()});
    for key in ["intake", "blueprintPlanner", "candidateSelector", "assemblyAssistant"] {
        config[key] = status.clone();
    }
    config["bankWarning"] = json!(runtime.store.bank_warning);
    Ok(json!({"config":config}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{bank::{BankRepository, hash_json}, model::ModelClient, storage::Store};
    use std::sync::atomic::AtomicBool;

    fn runtime() -> (tempfile::TempDir, Runtime) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), &crate::bank::tests::seed()).unwrap();
        let model = ModelClient::test_client(dir.path(), "http://127.0.0.1:1/v1");
        let ocr = crate::ocr_settings::OcrSettings::open(dir.path()).unwrap();
        (dir, Runtime { store, model, ocr })
    }

    #[test]
    fn simulated_workspace_projection_keeps_real_directory_and_defaults_without_question_annotations() {
        let (_dir, mut runtime) = runtime();
        let cancel = AtomicBool::new(false);
        assert_eq!(runtime.request("workspace_config_get", &json!({}), &cancel).unwrap_err().code, "nickname_required");
        runtime.store.save_profile("模拟启动回归", "math").unwrap();
        let mut config = runtime.store.bank.config().unwrap();
        config["assemblyIndex"]["entries"] = json!([{"teachingAnalysis":{"solution":"SIM_PRIVATE_TEACHING_BODY".repeat(10_000)}}]);
        runtime.store.bank.annotation_connection().execute("UPDATE bank_metadata SET value=?1 WHERE key='config'", [config.to_string()]).unwrap();
        let before = hash_json(&runtime.store.bank.config().unwrap());
        let result = runtime.request("workspace_config_get", &json!({}), &cancel).unwrap();
        let actual = &result["config"];
        for (key, value) in config.as_object().unwrap() {
            if !matches!(key.as_str(), "assemblyIndex" | "intake" | "blueprintPlanner" | "candidateSelector" | "assemblyAssistant" | "bankWarning") {
                assert_eq!(&actual[key], value, "lost directory/default field {key}");
            }
        }
        assert!(actual["assemblyIndex"].get("entries").is_none());
        assert!(!result.to_string().contains("SIM_PRIVATE_TEACHING_BODY"));
        assert_eq!(hash_json(&runtime.store.bank.config().unwrap()), before);
        let legacy = runtime.request("bootstrap", &json!({}), &cancel).unwrap();
        assert!(legacy["config"]["supply"]["ready"].as_u64().unwrap() > 0);
        assert!(result.to_string().len() * 10 < legacy.to_string().len());
    }

    #[test]
    fn simulated_history_sql_projection_matches_full_read_semantics_and_tombstones() {
        let (_dir, runtime) = runtime();
        let store = runtime.store;
        let huge = "SIM_PRIVATE_FROZEN_QUESTION_AND_ASSET".repeat(10_000);
        for (id, created) in [("sim-old", "2026-01-01"), ("sim-new", "2026-11-01"), ("sim-hidden", "2026-12-01")] {
            store.put_document("drafts", id, &json!({"draftId":id,"revision":4,"createdAt":created,
                "title":"模拟草稿","student":{"studentId":"sim-student","name":"模拟学生"},"students":[],
                "stats":{"selected":1},"baseline":{"requirements":{"scoringMode":"points"}},"questions":[{"stem":huge}]})).unwrap();
        }
        store.user.execute("INSERT INTO history_deletions(kind,id,operation_id,request_hash,deleted_at) VALUES('drafts','sim-hidden','sim-hide','hash','2026-11-01')", []).unwrap();
        store.put_document("papers", "sim-paper", &json!({"paperId":"sim-paper","sourceDraftId":"sim-new","title":"模拟成卷",
            "summary":{"selected":1},"draft":{"questions":[{"stem":huge}]}})).unwrap();
        let expected_drafts = store.list_documents("drafts").unwrap().iter().map(|d|json!({"draftId":d["draftId"],"title":d["title"],"revision":d["revision"],"createdAt":d["createdAt"],"confirmedPaperId":d["confirmedPaperId"],"student":d["student"],"students":d["students"],"stats":d["stats"],"scoringMode":d["baseline"]["requirements"]["scoringMode"]})).collect::<Vec<_>>();
        let expected_papers = store.list_documents("papers").unwrap().iter().map(|p|json!({"paperId":p["paperId"],"title":p["title"],"createdAt":p["createdAt"],"sourceDraftId":p["sourceDraftId"],"summary":p["summary"],"student":p["student"],"students":p["students"]})).collect::<Vec<_>>();
        let result = store.history_summaries().unwrap();
        assert_eq!(result, json!({"drafts":expected_drafts,"papers":expected_papers}));
        assert_eq!(result["drafts"][0]["draftId"], "sim-new");
        assert!(!result.to_string().contains("SIM_PRIVATE_FROZEN"));
        assert!(result.to_string().len() < 2_000);
    }

    #[test]
    fn simulated_background_recovery_uses_status_index_and_selects_only_active_jobs() {
        let (_dir, runtime) = runtime();
        let store = runtime.store;
        for (id, status) in [("sim-queued", "queued"), ("sim-running", "running"), ("sim-done", "completed")] {
            store.put_document("imports", id, &json!({"importId":id,"backgroundJob":{"status":status},"extractedPages":["SIM_OCR".repeat(10_000)]})).unwrap();
        }
        let query = "SELECT id FROM documents WHERE kind='imports' AND json_extract(payload,'$.backgroundJob.status') IN ('queued','running')";
        let details = store.user.prepare(&format!("EXPLAIN QUERY PLAN {query}")).unwrap()
            .query_map([], |row| row.get::<_, String>(3)).unwrap().collect::<Result<Vec<_>, _>>().unwrap();
        assert!(details.iter().any(|detail| detail.contains("imports_background_status")), "{details:?}");
        let mut ids = store.user.prepare(query).unwrap().query_map([], |row| row.get::<_, String>(0)).unwrap()
            .collect::<Result<Vec<_>, _>>().unwrap();
        ids.sort();
        assert_eq!(ids, ["sim-queued", "sim-running"]);
    }
}
