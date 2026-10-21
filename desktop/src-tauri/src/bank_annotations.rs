//! Versioned metadata-only bank upgrades, separate from the archived seed ledger.
use crate::{
    annotations::{RUBRIC_VERSION, normalize_difficulty},
    bank::{BankRepository, LocalQuestionBank, hash_json},
    error::{AppError, AppResult},
    knowledge,
};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use std::collections::HashSet;

fn conflict(message: &str) -> AppError {
    AppError::new("bank_annotation_migration_conflict", message)
}
fn rows(v: &Value) -> impl Iterator<Item = &Value> {
    v.as_array().into_iter().flatten()
}
const EDITABLE_FIELDS: [&str; 10] = [
    "difficultyLevel",
    "difficultyBasis",
    "difficultyRubricVersion",
    "difficultyEstimate",
    "knowledgeSchemaVersion",
    "primaryKnowledgeUids",
    "solutionPaths",
    "primarySections",
    "annotationSource",
    "annotationUpdatedAt",
];
fn protected(value: &Value) -> Value {
    let mut value = value.clone();
    if let Some(o) = value.as_object_mut() {
        for key in EDITABLE_FIELDS {
            o.remove(key);
        }
    }
    value
}
/// The source migration identity prevents a packaged production patch from being
/// silently applied to a different curriculum or an isolated test fixture.
pub(crate) fn bundled_for_seed(seed: &Value) -> AppResult<Option<Value>> {
    let manifest: Value =
        serde_json::from_str(include_str!("../../resources/bank-annotations-v1.json"))?;
    if manifest
        .get("sourceMigrationId")
        .is_some_and(|id| id != &seed["migration"]["id"])
    {
        return Ok(None);
    }
    Ok(Some(manifest))
}
pub fn apply(bank: &LocalQuestionBank, manifest: &Value) -> AppResult<Value> {
    let id = manifest["id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 160 && !id.chars().any(char::is_control))
        .ok_or_else(|| conflict("标注升级包缺少有效身份。"))?;
    let entries = manifest["entries"]
        .as_array()
        .filter(|entries| entries.len() <= 20000)
        .ok_or_else(|| conflict("标注升级包条目格式无效。"))?;
    let manifest_hash = hash_json(manifest);
    let transaction = rusqlite::Transaction::new_unchecked(
        bank.annotation_connection(),
        TransactionBehavior::Immediate,
    )?;
    transaction.execute_batch("CREATE TABLE IF NOT EXISTS bank_annotation_migrations(id TEXT PRIMARY KEY,manifest_sha256 TEXT NOT NULL,payload TEXT NOT NULL,applied_at TEXT NOT NULL);")?;
    let previous: Option<(String, String)> = transaction
        .query_row(
            "SELECT manifest_sha256,payload FROM bank_annotation_migrations WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((hash, payload)) = previous {
        let archived: Value = serde_json::from_str(&payload)?;
        if hash_json(&archived) != hash || hash != manifest_hash {
            return Err(conflict(
                "标注升级身份已被使用且内容不一致；未修改现有题库。",
            ));
        }
        transaction.commit()?;
        return Ok(json!({"id":id,"manifestSha256":manifest_hash,"applied":0,"replayed":true}));
    }
    // An empty build-time placeholder must not consume the final migration ID.
    if entries.is_empty() {
        transaction.commit()?;
        return Ok(json!({"id":id,"applied":0,"placeholder":true}));
    }
    let raw: String = transaction.query_row(
        "SELECT value FROM bank_metadata WHERE key='config'",
        [],
        |r| r.get(0),
    )?;
    let mut config: Value = serde_json::from_str(&raw)?;
    let validation_config = bank.config()?;
    if !config["assemblyIndex"]["entries"].is_array() {
        return Err(conflict("已有题库标注索引格式无效，未覆盖。"));
    }
    let mut seen = HashSet::new();
    let mut changed = 0;
    for patch in entries {
        let qid = patch["questionId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| conflict("升级条目缺少题目身份。"))?;
        if !seen.insert(qid) {
            return Err(conflict("升级包包含重复题目身份。"));
        }
        // question() validates content/teacher SHA-256, verification state,
        // versions and embedded assets rather than trusting version labels.
        let question = bank
            .question(qid)
            .map_err(|_| conflict("升级题目当前不可选，或内容、版本、素材哈希校验失败。"))?;
        let next = &patch["annotation"];
        if !next.is_object()
            || next["questionId"] != qid
            || ["contentVersion", "teacherVersion"].iter().any(|key| {
                !patch[*key].is_string()
                    || patch[*key] != question[*key]
                    || next[*key] != question[*key]
            })
        {
            return Err(conflict("升级条目与当前题目内容版本不一致。"));
        }
        knowledge::validate_annotation(next, &validation_config)
            .map_err(|_| conflict("升级标注含无效知识点或解法结构。"))?;
        if next.get("difficultyLevel").is_none()
            || next["knowledgeSchemaVersion"] != 2
            || next.get("difficultyEstimate").is_some()
            || next["difficultyRubricVersion"] != RUBRIC_VERSION
        {
            return Err(conflict("升级标注缺少新版知识点或难度标准；未覆盖旧值。"));
        }
        normalize_difficulty(&json!({"difficultyAssessment":{"level":next["difficultyLevel"],"basis":next["difficultyBasis"],"rubricVersion":next["difficultyRubricVersion"]}})).map_err(|_|conflict("升级包难度评估格式或依据无效。"))?;
        let indices = rows(&config["assemblyIndex"]["entries"])
            .enumerate()
            .filter(|(_, a)| a["questionId"] == qid)
            .map(|(i, _)| i)
            .collect::<Vec<_>>();
        if indices.len() > 1 {
            return Err(conflict("已有题目存在重复索引，未覆盖。"));
        }
        let current = indices
            .first()
            .map(|i| config["assemblyIndex"]["entries"][*i].clone())
            .unwrap_or(Value::Null);
        let expected = patch["previousAnnotationSha256"]
            .as_str()
            .filter(|s| {
                s.len() == 64
                    && s.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
            .ok_or_else(|| conflict("升级条目缺少原标注哈希。"))?;
        if hash_json(&current) == hash_json(next) {
            continue;
        }
        if hash_json(&current) != expected {
            return Err(conflict(
                "本地题目标注已修改，整批标注升级已回滚；保留当前题库和个人记录。",
            ));
        }
        if current.is_object() && protected(&current) != protected(next) {
            return Err(conflict("标注升级不得改变任务、来源、审核或教学覆盖证据。"));
        }
        if let Some(index) = indices.first() {
            config["assemblyIndex"]["entries"][*index] = next.clone();
        } else {
            config["assemblyIndex"]["entries"]
                .as_array_mut()
                .unwrap()
                .push(next.clone());
        }
        changed += 1;
    }
    transaction.execute(
        "UPDATE bank_metadata SET value=?1 WHERE key='config'",
        [config.to_string()],
    )?;
    transaction.execute("INSERT INTO bank_annotation_migrations(id,manifest_sha256,payload,applied_at) VALUES(?1,?2,?3,?4)",params![id,manifest_hash,manifest.to_string(),chrono::Utc::now().to_rfc3339()])?;
    transaction.commit()?;
    Ok(json!({"id":id,"manifestSha256":manifest_hash,"applied":changed,"replayed":false}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Store;
    fn seed() -> Value {
        let mut seed = crate::bank::tests::seed();
        let q = seed["questions"][0].clone();
        seed["config"] = json!({"subject":"math","assemblyIndex":{"entries":[{"questionId":q["questionId"],"contentVersion":q["contentVersion"],"teacherVersion":q["teacherVersion"],"tasks":["simulated-task"],"primarySections":["1.1"],"solutionPaths":[],"difficultyEstimate":0.4,"goalEvidence":{"status":"unknown"},"teacherProvenance":{"kind":"generated"}}]}});
        seed
    }
    fn patch(seed: &Value) -> Value {
        let old = seed["config"]["assemblyIndex"]["entries"][0].clone();
        let mut next = old.clone();
        next.as_object_mut().unwrap().remove("difficultyEstimate");
        next["difficultyLevel"] = json!("easy_medium");
        next["difficultyBasis"] =
            json!("模拟回归：在直接方法上增加一次转换。算法不代表已审核数学正确性。");
        next["difficultyRubricVersion"] = json!(RUBRIC_VERSION);
        next["knowledgeSchemaVersion"] = json!(2);
        next["primaryKnowledgeUids"] = json!([]);
        next["solutionPaths"] = json!([]);
        next["primarySections"] = json!([]);
        next["annotationSource"] = json!("model_reannotation");
        json!({"id":"simulated-metadata-upgrade-v1","entries":[{"questionId":old["questionId"],"contentVersion":old["contentVersion"],"teacherVersion":old["teacherVersion"],"previousAnnotationSha256":hash_json(&old),"annotation":next}]})
    }
    #[test]
    fn simulated_metadata_upgrade_fresh_existing_replay_and_personal_snapshot_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let seed = seed();
        let patch = patch(&seed);
        let store = Store::open_with_annotation_manifest(dir.path(), &seed, Some(&patch)).unwrap();
        assert!(store.bank_warning.is_none());
        assert_eq!(
            store.bank.config().unwrap()["assemblyIndex"]["entries"][0],
            patch["entries"][0]["annotation"]
        );
        let q = store.bank.question("simulated-question").unwrap();
        let paper = json!({"paperId":"simulated-frozen","sourceDraftId":"simulated-draft","question":q,"annotation":seed["config"]["assemblyIndex"]});
        store
            .put_document("papers", "simulated-frozen", &paper)
            .unwrap();
        store.save_profile("模拟升级回归", "math").unwrap();
        let mut local = q.clone();
        local["questionId"] = json!("simulated-local-new");
        store
            .bank
            .annotation_connection()
            .execute(
                "INSERT INTO bank_questions(id,payload) VALUES(?1,?2)",
                params!["simulated-local-new", local.to_string()],
            )
            .unwrap();
        drop(store);
        let reopened =
            Store::open_with_annotation_manifest(dir.path(), &seed, Some(&patch)).unwrap();
        assert_eq!(reopened.bank.questions().unwrap().len(), 2);
        assert_eq!(
            reopened.document("papers", "simulated-frozen").unwrap(),
            paper
        );
        assert_eq!(
            reopened.profile().unwrap().unwrap()["nickname"],
            "模拟升级回归"
        );
        assert!(reopened.bank_warning.is_none());
        let count: i64 = reopened
            .bank
            .annotation_connection()
            .query_row("SELECT count(*) FROM bank_annotation_migrations", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
    }
    #[test]
    fn simulated_metadata_conflict_rolls_back_entire_batch_and_runtime_remains_available() {
        let dir = tempfile::tempdir().unwrap();
        let mut seed = seed();
        let mut q = seed["questions"][0].clone();
        q["questionId"] = json!("simulated-second");
        seed["questions"].as_array_mut().unwrap().push(q);
        let mut old = seed["config"]["assemblyIndex"]["entries"][0].clone();
        old["questionId"] = json!("simulated-second");
        seed["config"]["assemblyIndex"]["entries"]
            .as_array_mut()
            .unwrap()
            .push(old.clone());
        let mut patch = patch(&seed);
        let mut second = patch["entries"][0].clone();
        second["questionId"] = json!("simulated-second");
        second["annotation"]["questionId"] = json!("simulated-second");
        second["previousAnnotationSha256"] = json!(hash_json(&old));
        patch["entries"].as_array_mut().unwrap().push(second);
        let store = Store::open_with_annotation_manifest(dir.path(), &seed, None).unwrap();
        let mut config = store.bank.config().unwrap();
        config["assemblyIndex"]["entries"][1]["teacherNote"] = json!("模拟本地教师修改必须保留");
        store
            .bank
            .annotation_connection()
            .execute(
                "UPDATE bank_metadata SET value=?1 WHERE key='config'",
                [config.to_string()],
            )
            .unwrap();
        drop(store);
        let reopened =
            Store::open_with_annotation_manifest(dir.path(), &seed, Some(&patch)).unwrap();
        assert!(reopened.bank_warning.as_deref().unwrap().contains("标注"));
        assert_eq!(reopened.bank.config().unwrap(), config);
        assert_eq!(reopened.bank.questions().unwrap().len(), 2);
        let count: i64 = reopened
            .bank
            .annotation_connection()
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name='bank_annotation_migrations'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }
    #[test]
    fn simulated_metadata_id_reuse_content_hash_and_protected_evidence_are_enforced() {
        let dir = tempfile::tempdir().unwrap();
        let seed = seed();
        let patch = patch(&seed);
        let bank = LocalQuestionBank::open(&dir.path().join("bank.sqlite"), &seed).unwrap();
        apply(&bank, &patch).unwrap();
        let after = bank.config().unwrap();
        let mut changed = patch.clone();
        changed["entries"][0]["annotation"]["difficultyBasis"] =
            json!("模拟不同内容不能重复使用原有升级身份。");
        assert!(apply(&bank, &changed).is_err());
        assert_eq!(bank.config().unwrap(), after);
        let dir = tempfile::tempdir().unwrap();
        let bank = LocalQuestionBank::open(&dir.path().join("bank.sqlite"), &seed).unwrap();
        let mut bad = patch.clone();
        bad["entries"][0]["annotation"]["goalEvidence"] = json!({"status":"verified"});
        assert!(apply(&bank, &bad).is_err());
        assert_eq!(bank.config().unwrap(), seed["config"]);
        let mut q = bank.question("simulated-question").unwrap();
        q["student"]["stem"] = json!("模拟被改题面但哈希未更新");
        bank.annotation_connection()
            .execute("UPDATE bank_questions SET payload=?1", [q.to_string()])
            .unwrap();
        assert!(apply(&bank, &patch).is_err());
        assert_eq!(bank.config().unwrap(), seed["config"]);
    }
    #[test]
    fn simulated_empty_manifest_does_not_consume_identity_and_already_equal_annotation_is_idempotent()
     {
        let dir = tempfile::tempdir().unwrap();
        let seed = seed();
        let patch = patch(&seed);
        let bank = LocalQuestionBank::open(&dir.path().join("bank.sqlite"), &seed).unwrap();
        let empty = json!({"id":patch["id"],"entries":[]});
        assert_eq!(apply(&bank, &empty).unwrap()["placeholder"], true);
        let mut config = seed["config"].clone();
        config["assemblyIndex"]["entries"][0] = patch["entries"][0]["annotation"].clone();
        bank.annotation_connection()
            .execute(
                "UPDATE bank_metadata SET value=?1 WHERE key='config'",
                [config.to_string()],
            )
            .unwrap();
        assert_eq!(apply(&bank, &patch).unwrap()["applied"], 0);
        assert_eq!(apply(&bank, &patch).unwrap()["replayed"], true);
    }
    #[test]
    fn packaged_annotation_manifest_covers_all_seed_questions_and_applies_isolated_idempotently() {
        let manifest: Value =
            serde_json::from_str(include_str!("../../resources/bank-annotations-v1.json")).unwrap();
        let entries = manifest["entries"].as_array().unwrap();
        if entries.is_empty() {
            // The build-time placeholder is deliberately allowed until the
            // explicit real reannotation run finishes; a populated package is
            // always verified against the actual bundled question snapshots.
            eprintln!("packaged annotation manifest is still the empty build-time placeholder");
            return;
        }
        let seed: Value = serde_json::from_str(include_str!("../../resources/seed.json")).unwrap();
        let questions = seed["questions"].as_array().unwrap();
        assert_eq!(questions.len(), 358);
        let expected_ids = questions
            .iter()
            .map(|q| q["questionId"].as_str().unwrap())
            .collect::<HashSet<_>>();
        let actual_ids = entries
            .iter()
            .map(|p| p["questionId"].as_str().unwrap())
            .collect::<HashSet<_>>();
        assert_eq!(
            entries.len(),
            questions.len(),
            "populated release annotation pack must include every bundled question exactly once"
        );
        assert_eq!(actual_ids, expected_ids);
        assert_eq!(manifest["sourceMigrationId"], seed["migration"]["id"]);
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open_with_annotation_manifest(dir.path(), &seed, Some(&manifest)).unwrap();
        assert!(store.bank_warning.is_none(), "{:?}", store.bank_warning);
        assert!(store.profile().unwrap().is_none());
        let actual_questions = store.bank.questions().unwrap();
        assert_eq!(actual_questions.len(), questions.len());
        for original in questions {
            let current = actual_questions
                .iter()
                .find(|q| q["questionId"] == original["questionId"])
                .unwrap();
            assert_eq!(
                hash_json(current),
                hash_json(original),
                "annotation-only release upgrade must preserve the entire question snapshot"
            );
            assert_eq!(current["contentVersion"], original["contentVersion"]);
            assert_eq!(current["teacherVersion"], original["teacherVersion"]);
        }
        let config = store.bank.config().unwrap();
        for patch in entries {
            let current = rows(&config["assemblyIndex"]["entries"])
                .find(|a| a["questionId"] == patch["questionId"])
                .unwrap();
            assert_eq!(hash_json(current), hash_json(&patch["annotation"]));
        }
        let migration_id = seed["migration"]["id"].as_str().unwrap();
        assert_eq!(
            hash_json(&store.bank.snapshot(migration_id).unwrap()),
            hash_json(&seed["bankSnapshot"])
        );
        let (count, manifest_hash): (i64, String) = store
            .bank
            .annotation_connection()
            .query_row(
                "SELECT count(*),manifest_sha256 FROM bank_annotation_migrations WHERE id=?1",
                [manifest["id"].as_str().unwrap()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(manifest_hash, hash_json(&manifest));
        drop(store);
        let reopened = Store::open_with_annotation_manifest(dir.path(), &seed, Some(&manifest)).unwrap();
        assert!(
            reopened.bank_warning.is_none(),
            "{:?}",
            reopened.bank_warning
        );
        assert_eq!(
            hash_json(&reopened.bank.config().unwrap()),
            hash_json(&config)
        );
        assert_eq!(
            hash_json(&json!(reopened.bank.questions().unwrap())),
            hash_json(&json!(actual_questions))
        );
        assert!(reopened.profile().unwrap().is_none());
        assert_eq!(apply(&reopened.bank, &manifest).unwrap()["replayed"], true);
    }
}
