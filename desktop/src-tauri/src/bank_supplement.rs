//! Append published, source-verified desktop questions without rewriting the old seed archive.
use crate::{
    bank::{LocalQuestionBank, hash_json, merge_config, verify_question},
    error::{AppError, AppResult},
};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use std::collections::HashSet;

fn invalid(message: &str) -> AppError {
    AppError::new("bank_supplement_conflict", message)
}
fn rows(value: &Value) -> AppResult<&Vec<Value>> {
    value
        .as_array()
        .ok_or_else(|| invalid("内置补充题库的列表格式无效。"))
}
fn identity(value: &Value) -> AppResult<&str> {
    value
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 250 && !s.chars().any(char::is_control))
        .ok_or_else(|| invalid("内置补充题库缺少有效身份。"))
}
fn sha(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
// The export may append catalogue facts, but cannot alter or remove an original fact.
fn retains(base: &Value, incoming: &Value) -> bool {
    match (base, incoming) {
        (Value::Object(base), Value::Object(next)) => base
            .iter()
            .all(|(key, old)| next.get(key).is_some_and(|new| retains(old, new))),
        (Value::Array(base), Value::Array(next)) => base.iter().all(|old| next.contains(old)),
        _ => base == incoming,
    }
}
pub(crate) fn apply_bundled(bank: &LocalQuestionBank, seed: &Value) -> AppResult<Option<Value>> {
    let manifest: Value =
        serde_json::from_str(include_str!("../../resources/bank-supplement-v1.json"))?;
    if manifest["sourceMigrationId"] != seed["migration"]["id"]
        || !seed["migration"]["id"].is_string()
    {
        return Ok(None);
    }
    apply(bank, &manifest).map(Some)
}
pub(crate) fn apply(bank: &LocalQuestionBank, manifest: &Value) -> AppResult<Value> {
    let id = identity(&manifest["id"])?;
    let mut body = manifest.clone();
    body.as_object_mut()
        .ok_or_else(|| invalid("内置补充题库格式无效。"))?
        .remove("manifestSha256");
    if manifest["schemaVersion"] != 1
        || !sha(&manifest["manifestSha256"])
        || manifest["manifestSha256"] != hash_json(&body)
        || !manifest["baselineConfig"].is_object()
        || !manifest["config"].is_object()
        || manifest["baselineConfigSha256"] != hash_json(&manifest["baselineConfig"])
    {
        return Err(invalid("内置补充题库哈希或配置基线无效，已有题库已保留。"));
    }
    identity(&manifest["sourceMigrationId"])?;
    let base = &manifest["baselineConfig"];
    let incoming = &manifest["config"];
    if !retains(base, incoming)
        || incoming.as_object().unwrap().iter().any(|(key, value)| {
            !matches!(
                key.as_str(),
                "tasks" | "sources" | "sourceManifest" | "chapters" | "assemblyIndex"
            ) && base.get(key) != Some(value)
        })
    {
        return Err(invalid(
            "补充题库只能追加目录与标注，不能修改原有题库规则。",
        ));
    }
    let questions = rows(&manifest["questions"])?;
    if questions.is_empty() || questions.len() > 20000 {
        return Err(invalid("内置补充题库数量无效。"));
    }
    let mut ids = HashSet::new();
    for question in questions {
        verify_question(question)?;
        let qid = identity(&question["questionId"])?;
        if !ids.insert(qid)
            || rows(&base["assemblyIndex"]["entries"])?
                .iter()
                .any(|e| e["questionId"] == qid)
        {
            return Err(invalid("补充题库含重复身份或试图覆盖原题。"));
        }
        let entries: Vec<_> = rows(&incoming["assemblyIndex"]["entries"])?
            .iter()
            .filter(|e| e["questionId"] == qid)
            .collect();
        if entries.len() != 1
            || ["contentVersion", "teacherVersion"]
                .iter()
                .any(|field| entries[0][*field] != question[*field])
        {
            return Err(invalid("补充题库题目与考查信息版本不一致。"));
        }
    }
    // No unpublished annotation may hitch a ride with the released questions.
    for entry in rows(&incoming["assemblyIndex"]["entries"])? {
        if !rows(&base["assemblyIndex"]["entries"])?.contains(entry)
            && !ids.contains(identity(&entry["questionId"])?)
        {
            return Err(invalid("补充题库包含未发布题目的标注。"));
        }
    }
    let local_rows = rows(&manifest["localRows"])?;
    let mut row_ids = HashSet::new();
    for row in local_rows {
        let kind = identity(&row["kind"])?;
        let row_id = row["id"]
            .as_str()
            .filter(|v| !v.is_empty() && v.len() <= 2000)
            .ok_or_else(|| invalid("补充目录记录身份无效。"))?;
        let payload: Value = serde_json::from_str(
            row["payload"]
                .as_str()
                .ok_or_else(|| invalid("补充目录缺少原始记录。"))?,
        )?;
        if !row_ids.insert((kind, row_id)) || row["sha256"] != hash_json(&payload) {
            return Err(invalid("补充目录记录重复或哈希不一致。"));
        }
        match kind {
            "question_knowledge_mappings" | "question_section_mappings"
                if ids.contains(identity(&payload["question_id"])?) => {}
            "agent_manual_only_audit"
                if rows(&payload["changes"])?.iter().all(|change| {
                    change["questionId"]
                        .as_str()
                        .is_some_and(|qid| ids.contains(qid))
                }) => {}
            _ => return Err(invalid("补充题库目录只能包含本批题目的映射与审核台账。")),
        }
    }
    let publications = rows(&manifest["publications"])?;
    let mut released = HashSet::new();
    let mut publication_ids = HashSet::new();
    for row in publications {
        let operation = identity(&row["operationId"])?;
        if !publication_ids.insert(operation)
            || !sha(&row["manifestSha256"])
            || row["receipt"]["publicationId"] != operation
        {
            return Err(invalid("补充题库发布来源身份无效。"));
        }
        for qid in rows(&row["receipt"]["questionIds"])? {
            let qid = identity(qid)?;
            if !ids.contains(qid) {
                return Err(invalid("补充题库发布来源引用了本批之外的题目。"));
            }
            released.insert(qid);
        }
    }
    if released != ids {
        return Err(invalid("补充题库题目缺少完整的原始发布来源。"));
    }
    let transaction = rusqlite::Transaction::new_unchecked(
        bank.annotation_connection(),
        TransactionBehavior::Immediate,
    )?;
    transaction.execute_batch("CREATE TABLE IF NOT EXISTS bank_supplement_migrations(id TEXT PRIMARY KEY,manifest_sha256 TEXT NOT NULL,payload TEXT NOT NULL,applied_at TEXT NOT NULL);")?;
    let prior: Option<(String, String)> = transaction
        .query_row(
            "SELECT manifest_sha256,payload FROM bank_supplement_migrations WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((hash, payload)) = prior {
        if manifest["manifestSha256"] != hash
            || serde_json::from_str::<Value>(&payload)? != *manifest
        {
            return Err(invalid(
                "补充题库升级身份已被其它内容使用，未修改现有题库。",
            ));
        }
        transaction.commit()?;
        return Ok(json!({"id":id,"addedQuestions":0,"replayed":true}));
    }
    let current: String = transaction.query_row(
        "SELECT value FROM bank_metadata WHERE key='config'",
        [],
        |r| r.get(0),
    )?;
    let merged = merge_config(base, &serde_json::from_str(&current)?, incoming)?;
    let mut added = 0;
    for question in questions {
        let qid = question["questionId"].as_str().unwrap();
        let existing: Option<String> = transaction
            .query_row(
                "SELECT payload FROM bank_questions WHERE id=?1",
                [qid],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(existing) = existing {
            let existing: Value = serde_json::from_str(&existing)?;
            verify_question(&existing)?;
            if existing != *question {
                return Err(invalid("补充题目与本地记录冲突，整批升级已回滚。"));
            }
        } else {
            transaction.execute(
                "INSERT INTO bank_questions(id,payload) VALUES(?1,?2)",
                params![qid, question.to_string()],
            )?;
            added += 1;
        }
    }
    for row in local_rows {
        let kind = row["kind"].as_str().unwrap();
        let rid = row["id"].as_str().unwrap();
        let current: Option<(String, String)> = transaction
            .query_row(
                "SELECT payload,sha256 FROM bank_local_rows WHERE kind=?1 AND id=?2",
                params![kind, rid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((payload, hash)) = current {
            if row["sha256"] != hash
                || serde_json::from_str::<Value>(&payload)?
                    != serde_json::from_str::<Value>(row["payload"].as_str().unwrap())?
            {
                return Err(invalid("补充题库目录与本地记录冲突，整批升级已回滚。"));
            }
        } else {
            transaction.execute(
                "INSERT INTO bank_local_rows(kind,id,payload,sha256) VALUES(?1,?2,?3,?4)",
                params![
                    kind,
                    rid,
                    row["payload"].as_str().unwrap(),
                    row["sha256"].as_str().unwrap()
                ],
            )?;
        }
    }
    for row in publications {
        let operation = row["operationId"].as_str().unwrap();
        let current: Option<(String, String)> = transaction
            .query_row(
                "SELECT manifest_sha256,receipt FROM bank_publications WHERE operation_id=?1",
                [operation],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((hash, receipt)) = current {
            if row["manifestSha256"] != hash
                || serde_json::from_str::<Value>(&receipt)? != row["receipt"]
            {
                return Err(invalid("补充题库原始发布凭据冲突，整批升级已回滚。"));
            }
        } else {
            transaction.execute("INSERT INTO bank_publications(operation_id,manifest_sha256,receipt) VALUES(?1,?2,?3)",params![operation,row["manifestSha256"].as_str().unwrap(),row["receipt"].to_string()])?;
        }
    }
    transaction.execute(
        "UPDATE bank_metadata SET value=?1 WHERE key='config'",
        [merged.to_string()],
    )?;
    transaction.execute("INSERT INTO bank_supplement_migrations(id,manifest_sha256,payload,applied_at) VALUES(?1,?2,?3,?4)",params![id,manifest["manifestSha256"].as_str().unwrap(),manifest.to_string(),chrono::Utc::now().to_rfc3339()])?;
    transaction.commit()?;
    Ok(json!({"id":id,"addedQuestions":added,"replayed":false}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bank::BankRepository;

    fn fixture() -> (tempfile::TempDir, LocalQuestionBank, Value, Value) {
        let directory = tempfile::tempdir().unwrap();
        let seed: Value = serde_json::from_str(include_str!("../../resources/seed.json")).unwrap();
        let manifest: Value =
            serde_json::from_str(include_str!("../../resources/bank-supplement-v1.json")).unwrap();
        let bank =
            LocalQuestionBank::open(&directory.path().join("question-bank.sqlite"), &seed).unwrap();
        let annotation = crate::bank_annotations::bundled_for_seed(&seed)
            .unwrap()
            .unwrap();
        crate::bank_annotations::apply(&bank, &annotation).unwrap();
        assert_eq!(bank.questions().unwrap().len(), 358);
        (directory, bank, seed, manifest)
    }
    fn rehash(manifest: &mut Value) {
        manifest.as_object_mut().unwrap().remove("manifestSha256");
        manifest["manifestSha256"] = json!(hash_json(manifest));
    }
    #[test]
    fn packaged_supplement_fresh_has_all_378_exact_questions_assets_and_original_archive() {
        let (_directory, bank, seed, manifest) = fixture();
        let archive = bank
            .snapshot(seed["migration"]["id"].as_str().unwrap())
            .unwrap();
        assert_eq!(manifest["questions"].as_array().unwrap().len(), 20);
        let assets: usize = manifest["questions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|q| q["assetPayloads"].as_array().map_or(0, Vec::len))
            .sum();
        assert_eq!(assets, 6);
        let result = apply_bundled(&bank, &seed).unwrap().unwrap();
        assert_eq!(result["addedQuestions"], 20);
        assert_eq!(bank.questions().unwrap().len(), 378);
        for question in manifest["questions"].as_array().unwrap() {
            assert_eq!(
                bank.question(question["questionId"].as_str().unwrap())
                    .unwrap(),
                *question
            );
        }
        assert_eq!(
            archive,
            bank.snapshot(seed["migration"]["id"].as_str().unwrap())
                .unwrap()
        );
        assert_eq!(
            bank.annotation_connection()
                .query_row("SELECT count(*) FROM bank_local_rows", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            94
        );
        assert_eq!(
            bank.annotation_connection()
                .query_row("SELECT count(*) FROM bank_publications", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            18
        );
        assert_eq!(apply(&bank, &manifest).unwrap()["replayed"], true);
        assert_eq!(bank.questions().unwrap().len(), 378);
    }
    #[test]
    fn simulated_existing_378_and_personal_sqlite_survive_supplement_without_rewrites() {
        let (directory, bank, _seed, manifest) = fixture();
        let personal = directory.path().join("personal.sqlite");
        {
            let connection = rusqlite::Connection::open(&personal).unwrap();
            connection.execute_batch("CREATE TABLE simulated_personal_records(id TEXT PRIMARY KEY,payload TEXT NOT NULL);INSERT INTO simulated_personal_records VALUES('simulated-private','simulated keep unchanged');").unwrap();
        }
        let original_personal = std::fs::read(&personal).unwrap();
        apply(&bank, &manifest).unwrap();
        bank.annotation_connection()
            .execute("DELETE FROM bank_supplement_migrations", [])
            .unwrap();
        let rows_before: Vec<(String, String)> = bank
            .annotation_connection()
            .prepare("SELECT id,payload FROM bank_questions ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(apply(&bank, &manifest).unwrap()["addedQuestions"], 0);
        let rows_after: Vec<(String, String)> = bank
            .annotation_connection()
            .prepare("SELECT id,payload FROM bank_questions ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(rows_before, rows_after);
        assert_eq!(original_personal, std::fs::read(personal).unwrap());
    }
    #[test]
    fn simulated_late_content_conflict_rolls_back_earlier_questions_and_preserves_local() {
        let (_directory, bank, _seed, manifest) = fixture();
        let mut changed = manifest["questions"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()
            .clone();
        changed["verification"]["basis"] = json!("模拟本地修改：不能被安装包覆盖");
        let qid = changed["questionId"].as_str().unwrap();
        bank.annotation_connection()
            .execute(
                "INSERT INTO bank_questions(id,payload) VALUES(?1,?2)",
                params![qid, changed.to_string()],
            )
            .unwrap();
        let config = bank.config().unwrap();
        assert!(apply(&bank, &manifest).is_err());
        assert_eq!(bank.questions().unwrap().len(), 359);
        assert_eq!(bank.question(qid).unwrap(), changed);
        assert_eq!(bank.config().unwrap(), config);
        assert_eq!(
            bank.annotation_connection()
                .query_row("SELECT count(*) FROM bank_local_rows", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn simulated_damaged_asset_and_manifest_hash_never_write_or_promote_a_question() {
        let (_directory, bank, _seed, manifest) = fixture();
        let mut bad = manifest.clone();
        let question = bad["questions"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|q| q["assetPayloads"].as_array().is_some_and(|a| !a.is_empty()))
            .unwrap();
        question["assetPayloads"][0]["dataBase64"] = json!("damaged");
        rehash(&mut bad);
        assert!(apply(&bank, &bad).is_err());
        let mut bad = manifest.clone();
        bad["manifestSha256"] = json!("0".repeat(64));
        assert!(apply(&bank, &bad).is_err());
        assert_eq!(bank.questions().unwrap().len(), 358);
    }
    #[test]
    fn simulated_unpublished_rows_missing_receipt_and_reused_identity_are_rejected() {
        let (_directory, bank, seed, manifest) = fixture();
        let mut bad = manifest.clone();
        bad["publications"].as_array_mut().unwrap().pop();
        rehash(&mut bad);
        assert!(apply(&bank, &bad).is_err());
        let mut bad = manifest.clone();
        bad["localRows"][0]["kind"] = json!("personal_records");
        rehash(&mut bad);
        assert!(apply(&bank, &bad).is_err());
        assert_eq!(bank.questions().unwrap().len(), 358);
        assert!(
            apply_bundled(
                &bank,
                &json!({"migration":{"id":"simulated-different-seed"}})
            )
            .unwrap()
            .is_none()
        );
        apply_bundled(&bank, &seed).unwrap();
        let mut reused = manifest.clone();
        reused["packagingNote"] = json!("模拟同一升级身份对应另一份内容");
        rehash(&mut reused);
        assert!(apply(&bank, &reused).is_err());
        let mut changed = manifest.clone();
        changed["config"]["description"] = json!("forbidden overwrite");
        rehash(&mut changed);
        assert!(apply(&bank, &changed).is_err());
        assert_eq!(bank.questions().unwrap().len(), 378);
    }
}
