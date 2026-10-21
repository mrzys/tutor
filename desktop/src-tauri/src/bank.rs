use crate::error::{AppError, AppResult};
use base64::Engine;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    path::Path,
    time::Duration,
};

/// This boundary deliberately contains no desktop UI or account concepts. A future
/// service-backed repository can supply the same verified question snapshots.
pub trait BankRepository {
    fn config(&self) -> AppResult<Value>;
    fn questions(&self) -> AppResult<Vec<Value>>;
    fn question(&self, id: &str) -> AppResult<Value>;
}

pub struct LocalQuestionBank {
    connection: Connection,
    shared_tables: Value,
}

enum PublicationAuthority {
    Teacher,
    ModelReview,
    #[cfg(debug_assertions)]
    AgentReview {
        report_sha256: String,
        expected_bank_sha256: String,
    },
}

#[cfg(debug_assertions)]
fn publication_snapshot(connection: &Connection) -> AppResult<String> {
    let config: String = connection.query_row(
        "SELECT value FROM bank_metadata WHERE key='config'",
        [],
        |row| row.get(0),
    )?;
    let mut statement = connection.prepare("SELECT id,payload FROM bank_questions ORDER BY id")?;
    let values = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let values = values
        .into_iter()
        .map(|(id, payload)| {
            Ok(json!({"id":id,"payload":serde_json::from_str::<Value>(&payload)?}))
        })
        .collect::<AppResult<Vec<_>>>()?;
    Ok(hash_json(
        &json!({"config":serde_json::from_str::<Value>(&config)?,"questions":values}),
    ))
}

pub(crate) fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(object) => {
            let mut keys: Vec<_> = object.keys().collect();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| {
                        format!(
                            "{}:{}",
                            serde_json::to_string(key).expect("JSON key"),
                            canonical_json(&object[key])
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Array(array) => format!(
            "[{}]",
            array
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        _ => value.to_string(),
    }
}

pub(crate) fn hash_json(value: &Value) -> String {
    format!("{:x}", Sha256::digest(canonical_json(value).as_bytes()))
}

fn integrity(message: &str) -> AppError {
    AppError::new("integrity_error", message)
}

fn conflict(message: &str) -> AppError {
    AppError::new("bank_migration_conflict", message)
}

fn active_knowledge_mapping(row: &Value) -> bool {
    // Knowledge labels are usable without a separate teacher confirmation.
    // Legacy suggestions already carry exact UIDs; retain their archived status
    // and provenance rather than rewriting them as teacher-reviewed evidence.
    matches!(
        row["status"].as_str(),
        Some(
            "reviewed_import_mapping"
                | "teacher_confirmed"
                | "teacher_reviewed"
                | "teacher_assigned"
                | "model_mapped"
                | "pending_uid_mapping"
        )
    )
}

fn add_catalogue(local: &Value, patch: &Value) -> AppResult<Value> {
    if local == patch {
        return Ok(local.clone());
    }
    if let (Some(local), Some(patch)) = (local.as_object(), patch.as_object()) {
        let mut merged = local.clone();
        for (key, next) in patch {
            let value = if let Some(current) = local.get(key) {
                add_catalogue(current, next)?
            } else {
                next.clone()
            };
            merged.insert(key.clone(), value);
        }
        return Ok(Value::Object(merged));
    }
    if let (Some(local), Some(patch)) = (local.as_array(), patch.as_array()) {
        let mut merged = local.clone();
        let key = ["id", "questionId", "sourceId"].into_iter().find(|key| {
            local
                .iter()
                .chain(patch)
                .all(|row| row[*key].as_str().is_some())
        });
        for next in patch {
            if let Some(key) = key {
                if let Some(current) = merged.iter().find(|row| row[key] == next[key]) {
                    if current != next {
                        return Err(conflict("导入目录身份与已有内容冲突，未覆盖原目录。"));
                    }
                } else {
                    merged.push(next.clone());
                }
            } else if next.is_string() {
                if !merged.contains(next) {
                    merged.push(next.clone());
                }
            } else {
                return Err(integrity("导入目录需使用明确的记录身份。"));
            }
        }
        return Ok(Value::Array(merged));
    }
    Err(conflict("导入不得覆盖已有题库配置。"))
}

pub(crate) fn verify_embedded_assets(question: &Value) -> AppResult<()> {
    let payloads = match question.get("assetPayloads") {
        None => &[][..],
        Some(value) => value
            .as_array()
            .map(Vec::as_slice)
            .ok_or_else(|| integrity("题目内嵌素材需为数组。"))?,
    };
    let mut matched = HashSet::new();
    let mut identities = HashSet::new();
    for role in ["student", "teacher"] {
        let references = match question[role].get("assets") {
            None => &[][..],
            Some(value) => value
                .as_array()
                .map(Vec::as_slice)
                .ok_or_else(|| integrity("题目素材引用需为数组。"))?,
        };
        for reference in references {
            let id = reference["assetId"].as_str().unwrap_or_default();
            let path = reference["path"].as_str().unwrap_or_default();
            let sha = reference["sha256"].as_str().unwrap_or_default();
            let mime = reference["mimeType"].as_str().unwrap_or_default();
            if id.is_empty()
                || id.chars().any(char::is_control)
                || path.is_empty()
                || path.starts_with('/')
                || path.contains('\\')
                || path.contains(':')
                || path.chars().any(char::is_control)
                || path
                    .split('/')
                    .any(|part| part.is_empty() || part == "." || part == "..")
                || sha.len() != 64
                || !sha
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                || !matches!(
                    mime,
                    "image/png" | "image/jpeg" | "image/gif" | "image/webp"
                )
                || !identities.insert((role, id))
            {
                return Err(integrity("内嵌素材身份、路径、类型、哈希或重复引用无效。"));
            }
            let found: Vec<_> = payloads
                .iter()
                .enumerate()
                .filter(|(_, payload)| payload["role"] == role && payload["assetId"] == id)
                .collect();
            if found.len() != 1 {
                return Err(integrity("题目配图缺失或存在重复内嵌素材。"));
            }
            let (index, payload) = found[0];
            let mut original_fields = payload.clone();
            let fields = original_fields
                .as_object_mut()
                .ok_or_else(|| integrity("内嵌素材内容格式无效。"))?;
            fields.remove("role");
            fields.remove("dataBase64");
            if &original_fields != reference {
                return Err(integrity("内嵌素材不能改变原始引用或增加未知字段。"));
            }
            let encoded = payload["dataBase64"]
                .as_str()
                .ok_or_else(|| integrity("内嵌素材缺少 Base64 数据。"))?;
            if encoded.len() > 28 * 1024 * 1024 {
                return Err(integrity("内嵌素材超过允许大小。"));
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| integrity("内嵌素材 Base64 损坏。"))?;
            let header_matches = match mime {
                "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
                "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
                "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
                "image/webp" => {
                    bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP"
                }
                _ => false,
            };
            if bytes.is_empty()
                || bytes.len() > 20 * 1024 * 1024
                || format!("{:x}", Sha256::digest(&bytes)) != sha
                || !header_matches
            {
                return Err(integrity("内嵌素材字节、哈希或类型不一致。"));
            }
            matched.insert(index);
        }
    }
    if matched.len() != payloads.len() {
        return Err(integrity("内嵌素材包含未关联或重复的附件。"));
    }
    Ok(())
}

// Three-way merge the known original seed, the local catalogue, and the new
// catalogue. Local additions survive; competing edits to the same fact fail
// rather than silently choosing either side. Lists of identifiable records are
// merged by identity, never by their changing display positions.
pub(crate) fn merge_config(base: &Value, local: &Value, incoming: &Value) -> AppResult<Value> {
    if local == incoming || incoming == base {
        return Ok(local.clone());
    }
    if local == base {
        return Ok(incoming.clone());
    }
    if let (Some(base), Some(local), Some(incoming)) =
        (base.as_object(), local.as_object(), incoming.as_object())
    {
        let mut merged = local.clone();
        for (key, next) in incoming {
            match local.get(key) {
                None => {
                    merged.insert(key.clone(), next.clone());
                }
                Some(current) => {
                    let previous = base.get(key).unwrap_or(&Value::Null);
                    merged.insert(key.clone(), merge_config(previous, current, next)?);
                }
            }
        }
        return Ok(Value::Object(merged));
    }
    if let (Some(base), Some(local), Some(incoming)) =
        (base.as_array(), local.as_array(), incoming.as_array())
    {
        let key = [
            "id",
            "questionId",
            "sourceId",
            "sectionId",
            "knowledgeUid",
            "taskId",
        ]
        .into_iter()
        .find(|key| {
            local
                .iter()
                .chain(incoming)
                .chain(base)
                .all(|entry| entry[*key].as_str().is_some())
        });
        if let Some(key) = key {
            for rows in [base, local, incoming] {
                let mut ids = HashSet::new();
                if rows
                    .iter()
                    .any(|row| !ids.insert(row[key].as_str().unwrap()))
                {
                    return Err(integrity("题库配置包含重复身份，无法安全合并。"));
                }
            }
            let mut merged = local.clone();
            for next in incoming {
                let id = next[key].as_str().unwrap();
                if let Some(position) = merged.iter().position(|row| row[key].as_str() == Some(id))
                {
                    let previous = base
                        .iter()
                        .find(|row| row[key].as_str() == Some(id))
                        .unwrap_or(&Value::Null);
                    merged[position] = merge_config(previous, &merged[position], next)?;
                } else {
                    merged.push(next.clone());
                }
            }
            return Ok(Value::Array(merged));
        }
        // Independent additions to scalar evidence lists (basis/limits/task IDs)
        // can be combined; edits or removals of prior evidence need review.
        if base
            .iter()
            .chain(local)
            .chain(incoming)
            .all(Value::is_string)
            && base
                .iter()
                .all(|entry| local.contains(entry) && incoming.contains(entry))
        {
            let mut merged = local.clone();
            for entry in incoming {
                if !merged.contains(entry) {
                    merged.push(entry.clone());
                }
            }
            return Ok(Value::Array(merged));
        }
    }
    Err(conflict(
        "新题库配置与本地修改冲突，已有题库已保留，请先备份并检查差异。",
    ))
}

fn validate_snapshot(seed: &Value) -> AppResult<()> {
    let snapshot = &seed["bankSnapshot"];
    if snapshot["schemaVersion"] != 1 {
        return Err(integrity("共享题库快照版本不受支持。"));
    }
    let entries = snapshot["ledger"]["entries"]
        .as_array()
        .ok_or_else(|| integrity("共享题库快照缺少就绪状态清单。"))?;
    let raw_questions = snapshot["questions"]
        .as_array()
        .ok_or_else(|| integrity("共享题库快照缺少原始题目记录。"))?;
    let active = seed["questions"]
        .as_array()
        .ok_or_else(|| integrity("共享题库缺少可用题目。"))?;
    let tables = snapshot["tables"]
        .as_object()
        .ok_or_else(|| integrity("共享题库快照缺少共享目录。"))?;
    const SHARED_TABLES: &[&str] = &[
        "question_bank_state",
        "question_bank_config",
        "question_bank_pedagogy",
        "question_bank_promotions",
        "question_bank_questions",
        "question_bank_chapters",
        "curriculum_textbooks",
        "curriculum_chapters",
        "curriculum_sections",
        "knowledge_points",
        "section_knowledge_mappings",
        "knowledge_relations",
        "question_section_mappings",
        "question_knowledge_mappings",
        "curriculum_mapping_evidence",
    ];
    if tables
        .iter()
        .any(|(name, rows)| !SHARED_TABLES.contains(&name.as_str()) || !rows.is_array())
    {
        return Err(integrity("迁移快照仅允许共享题库目录，不能包含个人记录。"));
    }
    let mut ledger_ids = HashSet::new();
    let mut ready = HashSet::new();
    for entry in entries {
        let id = entry["questionId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| integrity("清单题目身份无效。"))?;
        if !ledger_ids.insert(id) {
            return Err(integrity("清单包含重复题目身份。"));
        }
        match entry["status"].as_str() {
            Some("ready") => {
                ready.insert(id);
            }
            Some("pending") => {}
            _ => return Err(integrity("未知题目就绪状态，不能自动开放选题。")),
        }
    }
    let mut originals = std::collections::HashMap::new();
    for row in raw_questions {
        let id = row["question_id"]
            .as_str()
            .ok_or_else(|| integrity("原始题库记录身份无效。"))?;
        let payload = row["payload"]
            .as_str()
            .ok_or_else(|| integrity("原始题库记录缺少 JSON 文本。"))?;
        let question: Value = serde_json::from_str(payload)?;
        if !ledger_ids.contains(id)
            || question["questionId"] != id
            || row["sha256"].as_str() != Some(hash_json(&question).as_str())
            || row["content_version"] != question["contentVersion"]
            || row["teacher_version"] != question["teacherVersion"]
            || originals.insert(id, question).is_some()
        {
            return Err(integrity("原始题库记录哈希、版本或清单身份不一致。"));
        }
    }
    let mut active_ids = HashSet::new();
    for question in active {
        verify_question(question)?;
        let id = question["questionId"].as_str().unwrap();
        // Packaging may append verified bytes without rewriting the source DB
        // snapshot. Every other field must remain exactly the original record.
        let mut original_fields = question.clone();
        original_fields
            .as_object_mut()
            .unwrap()
            .remove("assetPayloads");
        if !ready.contains(id)
            || originals.get(id) != Some(&original_fields)
            || !active_ids.insert(id)
        {
            return Err(integrity("可用题目必须与原始记录及 ready 清单完全一致。"));
        }
    }
    if active_ids != ready {
        return Err(integrity("共享题库遗漏了已就绪题目。"));
    }
    if snapshot["counts"]["ready"].as_u64() != Some(ready.len() as u64)
        || snapshot["counts"]["pending"].as_u64() != Some((entries.len() - ready.len()) as u64)
        || snapshot["counts"]["questionRows"].as_u64() != Some(raw_questions.len() as u64)
        || snapshot["counts"]["sourceUnits"].as_u64() != Some(entries.len() as u64)
    {
        return Err(integrity("共享题库快照计数不一致。"));
    }
    if let Some(rows) = tables.get("question_bank_questions") {
        if rows != &snapshot["questions"] {
            return Err(integrity("共享题库快照包含互相矛盾的原始题目表。"));
        }
    }
    // Every hashed source table is checked before saving the opaque archive.
    for rows in tables.values() {
        for row in rows.as_array().unwrap() {
            if let Some(expected) = row.get("sha256") {
                let payload: Value = serde_json::from_str(
                    row["payload"]
                        .as_str()
                        .ok_or_else(|| integrity("共享目录缺少原始 JSON 文本。"))?,
                )?;
                if expected.as_str() != Some(hash_json(&payload).as_str()) {
                    return Err(integrity("共享题库目录哈希校验失败。"));
                }
            }
        }
    }
    Ok(())
}

fn apply_migration(transaction: &rusqlite::Transaction<'_>, seed: &Value) -> AppResult<()> {
    if seed.get("bankSnapshot").is_none() && seed.get("migration").is_none() {
        return Ok(());
    }
    let migration = &seed["migration"];
    let id = migration["id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 100 && !id.chars().any(char::is_control))
        .ok_or_else(|| integrity("缺少有效的题库迁移身份。"))?;
    if seed["schemaVersion"] != 1
        || !seed["config"].is_object()
        || !migration["baselineConfig"].is_object()
        || migration["baselineConfigSha256"].as_str()
            != Some(hash_json(&migration["baselineConfig"]).as_str())
    {
        return Err(integrity("题库迁移缺少可信的原配置基线。"));
    }
    let manifest_hash = hash_json(
        &json!({"config":seed["config"],"questions":seed["questions"],"bankSnapshot":seed["bankSnapshot"]}),
    );
    if migration["manifestSha256"].as_str() != Some(manifest_hash.as_str()) {
        return Err(integrity("题库迁移清单哈希校验失败。"));
    }
    validate_snapshot(seed)?;
    transaction.execute_batch("CREATE TABLE IF NOT EXISTS bank_migrations(id TEXT PRIMARY KEY,manifest_sha256 TEXT NOT NULL,applied_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS bank_snapshots(migration_id TEXT PRIMARY KEY REFERENCES bank_migrations(id),payload TEXT NOT NULL,sha256 TEXT NOT NULL);")?;
    let previous: Option<String> = transaction
        .query_row(
            "SELECT manifest_sha256 FROM bank_migrations WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(previous) = previous {
        if previous != manifest_hash {
            return Err(conflict("同一题库迁移身份对应不同内容，现有数据已保留。"));
        }
        let (payload, hash): (String, String) = transaction.query_row(
            "SELECT payload,sha256 FROM bank_snapshots WHERE migration_id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if hash_json(&serde_json::from_str(&payload)?) != hash
            || hash != hash_json(&seed["bankSnapshot"])
        {
            return Err(integrity("已保存的共享题库快照损坏，已有内容已保留。"));
        }
        // An already applied migration must not reseed, revert local changes, or
        // resurrect records that were intentionally removed later.
        return Ok(());
    }
    let local_config: String = transaction.query_row(
        "SELECT value FROM bank_metadata WHERE key='config'",
        [],
        |row| row.get(0),
    )?;
    let local_config: Value = serde_json::from_str(&local_config)?;
    let merged = merge_config(&migration["baselineConfig"], &local_config, &seed["config"])?;
    for question in seed["questions"].as_array().unwrap() {
        let id = question["questionId"].as_str().unwrap();
        let existing: Option<String> = transaction
            .query_row(
                "SELECT payload FROM bank_questions WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(existing) = existing {
            let existing: Value = serde_json::from_str(&existing)?;
            verify_question(&existing)?;
            if [
                "contentVersion",
                "teacherVersion",
                "contentSha256",
                "teacherSha256",
            ]
            .iter()
            .any(|field| existing[*field] != question[*field])
            {
                return Err(conflict(
                    "迁移题目与本地版本冲突，现有题库已保留，请检查后重试。",
                ));
            }
            // Local annotations and same-version snapshots are retained verbatim.
        } else {
            transaction.execute(
                "INSERT INTO bank_questions(id,payload) VALUES(?1,?2)",
                params![id, serde_json::to_string(question)?],
            )?;
        }
    }
    // Pending originals are archived, not inserted into the selectable table.
    // A matching pre-existing local active row would be a status conflict.
    for entry in seed["bankSnapshot"]["ledger"]["entries"]
        .as_array()
        .unwrap()
    {
        if entry["status"] == "pending" {
            let exists: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM bank_questions WHERE id=?1)",
                [entry["questionId"].as_str().unwrap()],
                |row| row.get(0),
            )?;
            if exists {
                return Err(conflict(
                    "待复核题目与本地可用记录状态冲突，不能自动改变就绪状态。",
                ));
            }
        }
    }
    transaction.execute(
        "UPDATE bank_metadata SET value=?1 WHERE key='config'",
        [serde_json::to_string(&merged)?],
    )?;
    transaction.execute(
        "INSERT INTO bank_migrations(id,manifest_sha256,applied_at) VALUES(?1,?2,?3)",
        params![id, manifest_hash, chrono::Utc::now().to_rfc3339()],
    )?;
    transaction.execute(
        "INSERT INTO bank_snapshots(migration_id,payload,sha256) VALUES(?1,?2,?3)",
        params![
            id,
            serde_json::to_string(&seed["bankSnapshot"])?,
            hash_json(&seed["bankSnapshot"])
        ],
    )?;
    Ok(())
}

pub(crate) fn verify_question(question: &Value) -> AppResult<()> {
    let id = question["questionId"].as_str().unwrap_or_default();
    if !question.is_object()
        || question["schemaVersion"] != 1
        || id.is_empty()
        || question["verification"]["result"] != "pass"
        || !matches!(
            question["questionType"].as_str(),
            Some("single_choice" | "multiple_choice" | "fill_blank" | "free_response")
        )
    {
        return Err(integrity("题库题目身份或审核信息无效。"));
    }
    for (payload, hash_field, version_field, prefix) in [
        ("student", "contentSha256", "contentVersion", "content"),
        ("teacher", "teacherSha256", "teacherVersion", "teacher"),
    ] {
        if !question[payload].is_object() {
            return Err(integrity("题目内容不完整。"));
        }
        let hash = hash_json(&question[payload]);
        let version = format!("{}-{}", prefix, &hash[..16]);
        if question[hash_field].as_str() != Some(hash.as_str())
            || question[version_field].as_str() != Some(version.as_str())
            || question["verification"][version_field].as_str() != Some(version.as_str())
        {
            return Err(integrity("题目内容与核实的版本或哈希不一致。"));
        }
    }
    let student = &question["student"];
    if student["stem"]
        .as_str()
        .is_none_or(|text| text.trim().is_empty())
    {
        return Err(integrity("题干不能为空。"));
    }
    for field in ["options", "parts", "assets"] {
        if !student[field].is_array() {
            return Err(integrity("题目选项、小问或素材格式无效。"));
        }
    }
    if student.as_object().is_some_and(|object| {
        object.keys().any(|key| {
            matches!(
                key.as_str(),
                "answer" | "answers" | "solution" | "solutions" | "teacher"
            )
        })
    }) {
        return Err(integrity("学生题面不能包含教师答案或解析。"));
    }
    verify_embedded_assets(question)?;
    Ok(())
}

impl LocalQuestionBank {
    #[cfg(debug_assertions)]
    pub fn agent_manual_only_snapshot(&self, question_ids: &Value) -> AppResult<Value> {
        let ids = question_ids
            .as_array()
            .filter(|rows| !rows.is_empty() && rows.len() <= 20)
            .ok_or_else(|| {
                AppError::new(
                    "invalid_review",
                    "请指定本次代理核验入库的 1 至 20 道题目。",
                )
            })?;
        let transaction = rusqlite::Transaction::new_unchecked(
            &self.connection,
            rusqlite::TransactionBehavior::Deferred,
        )?;
        let config = self.config()?;
        let mut output = vec![];
        let mut seen = HashSet::new();
        for id in ids {
            let id = id
                .as_str()
                .filter(|id| seen.insert((*id).to_owned()))
                .ok_or_else(|| integrity("题目身份无效或重复。"))?;
            let question = self.question(id)?;
            if question["verification"]["method"] != "user_authorized_agent_review"
                || question["verification"]["checkedBy"] != "codex"
            {
                return Err(AppError::new(
                    "review_required",
                    "仅能收紧本次用户授权代理逐题核验入库的题目，不能改变旧题。",
                ));
            }
            let entries = config["assemblyIndex"]["entries"]
                .as_array()
                .ok_or_else(|| integrity("题目索引无效。"))?
                .iter()
                .filter(|e| e["questionId"] == id)
                .collect::<Vec<_>>();
            if entries.len() != 1
                || ["contentVersion", "teacherVersion"]
                    .iter()
                    .any(|key| entries[0][*key] != question[*key])
            {
                return Err(integrity("题目标注身份或版本不唯一、不匹配。"));
            }
            output.push(json!({"questionId":id,"expectedAnnotationSha256":hash_json(entries[0]),"annotation":entries[0],"contentVersion":question["contentVersion"],"teacherVersion":question["teacherVersion"]}));
        }
        let snapshot = publication_snapshot(&transaction)?;
        transaction.commit()?;
        Ok(json!({"schemaVersion":1,"bankSnapshotSha256":snapshot,"questions":output}))
    }

    /// Restrict verified content to manual selection without deleting questions
    /// or discarding any model annotation. No model or personal storage is used.
    #[cfg(debug_assertions)]
    pub fn restrict_agent_to_manual(&self, operation_id: &str, report: &Value) -> AppResult<Value> {
        if operation_id.is_empty()
            || operation_id.len() > 100
            || !operation_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(AppError::new(
                "invalid_operation",
                "缺少有效的收口操作标识。",
            ));
        }
        if report["kind"] != "user_authorized_agent_manual_only_v1"
            || report["reviewer"] != "codex"
            || report["authorization"]["request"]
                .as_str()
                .is_none_or(|s| s.trim().is_empty() || s.len() > 10000)
        {
            return Err(AppError::new(
                "review_required",
                "缺少用户明确授权的代理适配收口报告。",
            ));
        }
        let request_hash = hash_json(report);
        let transaction = rusqlite::Transaction::new_unchecked(
            &self.connection,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let previous:Option<(String,String)>=transaction.query_row("SELECT payload,sha256 FROM bank_local_rows WHERE kind='agent_manual_only_audit' AND id=?1",[operation_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        if let Some((raw, sha)) = previous {
            let audit: Value = serde_json::from_str(&raw)?;
            if hash_json(&audit) != sha
                || audit["reportSha256"] != request_hash
                || audit["report"] != *report
            {
                return Err(AppError::new(
                    "operation_conflict",
                    "此收口操作标识已用于不同报告，或审计记录损坏。",
                ));
            }
            let mut receipt = audit["receipt"].clone();
            receipt["replayed"] = json!(true);
            transaction.commit()?;
            return Ok(receipt);
        }
        if report["bankSnapshotSha256"] != publication_snapshot(&transaction)? {
            return Err(AppError::new(
                "bank_snapshot_conflict",
                "题库已变化，收口未执行；请重新绑定当前题库快照。",
            ));
        }
        let raw: String = transaction.query_row(
            "SELECT value FROM bank_metadata WHERE key='config'",
            [],
            |r| r.get(0),
        )?;
        let mut config: Value = serde_json::from_str(&raw)?;
        let selected = report["questions"]
            .as_array()
            .filter(|rows| !rows.is_empty() && rows.len() <= 20)
            .ok_or_else(|| {
                AppError::new("invalid_review", "本次仅可收紧 1 至 20 道实际代理核验题。")
            })?;
        let validation = self.config()?;
        let mut seen = HashSet::new();
        let mut changes = vec![];
        let mut ids = vec![];
        for item in selected {
            let id = item["questionId"]
                .as_str()
                .filter(|id| !id.is_empty() && seen.insert((*id).to_owned()))
                .ok_or_else(|| integrity("题目身份无效或重复。"))?;
            if item["basis"]
                .as_str()
                .is_none_or(|s| s.trim().is_empty() || s.chars().count() > 5000)
            {
                return Err(AppError::new(
                    "review_required",
                    "每题须保留收紧完整解法依赖的具体原因。",
                ));
            }
            let question = self.question(id)?;
            let verification = &question["verification"];
            if verification["method"] != "user_authorized_agent_review"
                || verification["checkedBy"] != "codex"
                || verification["agentReview"]["question"]["review"]["result"] != "pass"
                || verification["agentReview"]["question"]["method"]
                    != "user_authorized_agent_review"
            {
                return Err(AppError::new(
                    "review_required",
                    "不能收紧旧题或未经本次代理实际核验的题目。",
                ));
            }
            let indices = config["assemblyIndex"]["entries"]
                .as_array()
                .ok_or_else(|| integrity("现有题目索引损坏。"))?
                .iter()
                .enumerate()
                .filter(|(_, e)| e["questionId"] == id)
                .map(|(i, _)| i)
                .collect::<Vec<_>>();
            if indices.len() != 1 {
                return Err(integrity("现有题目标注身份不唯一。"));
            }
            let index = indices[0];
            let old = config["assemblyIndex"]["entries"][index].clone();
            if item["expectedAnnotationSha256"] != hash_json(&old)
                || ["contentVersion", "teacherVersion"]
                    .iter()
                    .any(|key| old[*key] != question[*key])
            {
                return Err(AppError::new(
                    "annotation_conflict",
                    "题目版本或标注已变化，整批收口已回滚。",
                ));
            }
            let mut next = old.clone();
            next["tasks"] = json!([]);
            next["solutionPaths"] = json!([]);
            next["notes"] = json!(
                "题面经用户授权代理逐题核验通过；完整解法依赖仍待复核，仅手动可用。难度与主考仍为内容估计。"
            );
            crate::knowledge::validate_annotation(&next, &validation)?;
            changes.push(json!({"questionId":id,"questionSha256":hash_json(&question),"basis":item["basis"],"beforeAnnotation":old,"beforeAnnotationSha256":hash_json(&old),"afterAnnotation":next,"afterAnnotationSha256":hash_json(&next)}));
            config["assemblyIndex"]["entries"][index] = next;
            ids.push(id.to_owned());
        }
        let receipt = json!({"operationId":operation_id,"kind":"user_authorized_agent_manual_only_v1","questionIds":ids,"restrictedQuestions":changes.len(),"reportSha256":request_hash,"replayed":false});
        let audit = json!({"schemaVersion":1,"kind":"user_authorized_agent_manual_only_v1","operationId":operation_id,"reviewer":"codex","createdAt":chrono::Utc::now().to_rfc3339(),"reportSha256":request_hash,"report":report,"changes":changes,"receipt":receipt});
        let updated = transaction.execute(
            "UPDATE bank_metadata SET value=?1 WHERE key='config' AND value=?2",
            params![config.to_string(), raw],
        )?;
        if updated != 1 {
            return Err(AppError::new(
                "annotation_conflict",
                "题库配置已变化，整批收口未执行。",
            ));
        }
        transaction.execute("INSERT INTO bank_local_rows(kind,id,payload,sha256) VALUES('agent_manual_only_audit',?1,?2,?3)",params![operation_id,audit.to_string(),hash_json(&audit)])?;
        transaction.commit()?;
        Ok(receipt)
    }

    pub(crate) fn annotation_connection(&self) -> &Connection {
        &self.connection
    }

    pub fn open(path: &Path, seed: &Value) -> AppResult<Self> {
        let mut connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS bank_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS bank_questions(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS bank_publications(operation_id TEXT PRIMARY KEY,manifest_sha256 TEXT NOT NULL,receipt TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS bank_local_rows(kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(kind,id));",
        )?;
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let initialized: Option<String> = transaction
            .query_row(
                "SELECT value FROM bank_metadata WHERE key='schema_version'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        match initialized.as_deref() {
            Some("1") => {}
            Some(_) => return Err(integrity("本地题库版本不受支持，请保留数据后升级应用。")),
            None => {
                let count: i64 =
                    transaction
                        .query_row("SELECT count(*) FROM bank_questions", [], |row| row.get(0))?;
                if count != 0 {
                    return Err(integrity("本地题库缺少初始化记录，已保留现有内容。"));
                }
                if seed["schemaVersion"] != 1 || !seed["config"].is_object() {
                    return Err(integrity("题库种子配置无效。"));
                }
                let questions = seed["questions"]
                    .as_array()
                    .ok_or_else(|| integrity("题库种子缺少题目。"))?;
                if questions.is_empty() {
                    return Err(integrity("初始题库不能为空。"));
                }
                let mut identities = HashSet::new();
                for question in questions {
                    verify_question(question)?;
                    let id = question["questionId"].as_str().unwrap();
                    if !identities.insert(id) {
                        return Err(integrity("题库种子包含重复题目身份。"));
                    }
                    transaction.execute(
                        "INSERT INTO bank_questions(id,payload) VALUES(?1,?2)",
                        params![id, serde_json::to_string(question)?],
                    )?;
                }
                transaction.execute(
                    "INSERT INTO bank_metadata(key,value) VALUES('config',?1)",
                    [serde_json::to_string(&seed["config"])?],
                )?;
                transaction.execute(
                    "INSERT INTO bank_metadata(key,value) VALUES('schema_version','1')",
                    [],
                )?;
            }
        }
        apply_migration(&transaction, seed)?;
        transaction.commit()?;
        let snapshots_exist: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='bank_snapshots')",
            [],
            |row| row.get(0),
        )?;
        let shared_tables = if snapshots_exist {
            let latest:Option<(String,String)>=connection.query_row("SELECT s.payload,s.sha256 FROM bank_snapshots s JOIN bank_migrations m ON m.id=s.migration_id ORDER BY m.applied_at DESC,m.rowid DESC LIMIT 1",[],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
            if let Some((payload, expected)) = latest {
                let snapshot: Value = serde_json::from_str(&payload)?;
                if hash_json(&snapshot) != expected {
                    return Err(integrity("共享题库目录快照哈希不一致。"));
                }
                snapshot["tables"].clone()
            } else {
                json!({})
            }
        } else {
            json!({})
        };
        Ok(Self {
            connection,
            shared_tables,
        })
    }

    fn decode(&self, id: &str, payload: &str) -> AppResult<Value> {
        let question: Value = serde_json::from_str(payload)?;
        verify_question(&question)?;
        if question["questionId"] != id {
            return Err(integrity("题库索引与题目身份不一致。"));
        }
        Ok(question)
    }

    /// Original shared data stays available for a future bank-service split;
    /// pending entries are deliberately absent from BankRepository::questions.
    pub fn snapshot(&self, migration_id: &str) -> AppResult<Value> {
        let (payload, expected): (String, String) = self.connection.query_row(
            "SELECT payload,sha256 FROM bank_snapshots WHERE migration_id=?1",
            [migration_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let snapshot: Value = serde_json::from_str(&payload)?;
        if hash_json(&snapshot) != expected {
            return Err(integrity("共享题库快照哈希不一致。"));
        }
        Ok(snapshot)
    }

    /// Read archived search annotations without promoting them to reviewed
    /// automatic-selection evidence. Callers must still bind both versions.
    pub(crate) fn catalog_search_metadata(&self) -> AppResult<Value> {
        let mut result = json!({"ledger":[],"pedagogy":[]});
        for (table, kind, field) in [
            ("question_bank_state", "ledger", "ledger"),
            ("question_bank_pedagogy", "analysis", "pedagogy"),
        ] {
            for row in self.rows(table)?.iter().filter(|row| row["kind"] == kind) {
                let payload = row["payload"]
                    .as_str()
                    .ok_or_else(|| integrity("题库检索标注缺少原始内容。"))?;
                let value: Value = serde_json::from_str(payload)?;
                if row["sha256"].as_str() != Some(hash_json(&value).as_str()) {
                    return Err(integrity("题库检索标注哈希不一致。"));
                }
                let entries = value["entries"]
                    .as_array()
                    .ok_or_else(|| integrity("题库检索标注格式无效。"))?;
                result[field]
                    .as_array_mut()
                    .unwrap()
                    .extend(entries.iter().cloned());
            }
        }
        Ok(result)
    }

    fn rows(&self, kind: &str) -> AppResult<Vec<Value>> {
        let mut rows = self.shared_tables[kind]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let mut query = self
            .connection
            .prepare("SELECT payload,sha256 FROM bank_local_rows WHERE kind=?1 ORDER BY id")?;
        for row in query.query_map([kind], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })? {
            let (payload, expected) = row?;
            let value: Value = serde_json::from_str(&payload)?;
            if hash_json(&value) != expected {
                return Err(integrity("本地题库映射哈希不一致。"));
            }
            rows.push(value);
        }
        Ok(rows)
    }

    fn knowledge_ids(&self, uid: &str, descendants: bool) -> AppResult<HashSet<String>> {
        let points = self.rows("knowledge_points")?;
        if !points.iter().any(|row| row["knowledge_uid"] == uid) {
            return Err(AppError::new("not_found", "没有找到该知识点。"));
        }
        let mut ids = HashSet::from([uid.to_owned()]);
        if descendants {
            loop {
                let previous = ids.len();
                for row in &points {
                    if row["parent_uid"]
                        .as_str()
                        .is_some_and(|parent| ids.contains(parent))
                    {
                        if let Some(id) = row["knowledge_uid"].as_str() {
                            ids.insert(id.to_owned());
                        }
                    }
                }
                if previous == ids.len() {
                    break;
                }
            }
        }
        Ok(ids)
    }

    pub fn question_ids_for_knowledge(
        &self,
        uid: &str,
        descendants: bool,
    ) -> AppResult<Vec<String>> {
        let knowledge = self.knowledge_ids(uid, descendants)?;
        let direct = self.direct_knowledge(&self.config()?, &self.questions()?)?;
        let ids: BTreeSet<String> = knowledge
            .iter()
            .filter_map(|uid| direct.get(uid))
            .flatten()
            .cloned()
            .collect();
        Ok(ids.into_iter().collect())
    }

    fn direct_knowledge(
        &self,
        config: &Value,
        questions: &[Value],
    ) -> AppResult<HashMap<String, HashSet<String>>> {
        let active: HashMap<&str, &Value> = questions
            .iter()
            .filter_map(|q| q["questionId"].as_str().map(|id| (id, q)))
            .collect();
        let entries = config["assemblyIndex"]["entries"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default();
        // New role annotations are authoritative, including explicit unknowns.
        // Generic old labels must not reintroduce support-only knowledge as a target.
        let modern: HashSet<&str> = entries
            .iter()
            .filter(|e| crate::knowledge::uses_knowledge(e))
            .filter_map(|e| e["questionId"].as_str())
            .collect();
        let mut direct: HashMap<String, HashSet<String>> = HashMap::new();
        for row in self.rows("question_knowledge_mappings")? {
            if let (Some(uid), Some(id)) =
                (row["knowledge_uid"].as_str(), row["question_id"].as_str())
            {
                if active_knowledge_mapping(&row)
                    && active.contains_key(id)
                    && !modern.contains(id)
                    && row["role"] != "supporting"
                {
                    direct
                        .entry(uid.to_owned())
                        .or_default()
                        .insert(id.to_owned());
                }
            }
        }
        for entry in entries
            .iter()
            .filter(|e| crate::knowledge::uses_knowledge(e))
        {
            let Some(id) = entry["questionId"].as_str() else {
                continue;
            };
            let Some(question) = active.get(id) else {
                continue;
            };
            if ["contentVersion", "teacherVersion"]
                .iter()
                .any(|key| entry[*key] != question[*key])
                || crate::knowledge::validate_annotation(entry, config).is_err()
            {
                continue;
            }
            for uid in entry["primaryKnowledgeUids"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                direct
                    .entry(uid.to_owned())
                    .or_default()
                    .insert(id.to_owned());
            }
        }
        Ok(direct)
    }

    pub fn catalog(&self) -> AppResult<Value> {
        fn original(row: &Value) -> AppResult<Value> {
            let value: Value = serde_json::from_str(
                row["payload"]
                    .as_str()
                    .ok_or_else(|| integrity("教材或知识点缺少原始内容。"))?,
            )?;
            if !value.is_object() {
                return Err(integrity("教材或知识点内容格式无效。"));
            }
            Ok(value)
        }
        fn ordered(mut rows: Vec<Value>) -> Vec<Value> {
            rows.sort_by_key(|row| row["position"].as_i64().unwrap_or(0));
            rows
        }
        let questions = self.questions()?;
        let active: HashSet<String> = questions
            .iter()
            .filter_map(|q| q["questionId"].as_str().map(str::to_owned))
            .collect();
        let points = self.rows("knowledge_points")?;
        let config = self.config()?;
        let direct = self.direct_knowledge(&config, &questions)?;
        let mut by_section: HashMap<String, HashSet<String>> = HashMap::new();
        // Match bank_search's primarySections filter. The archived section map
        // also includes prerequisite/supporting sections and must not inflate
        // the number displayed for a main-scope navigation item.
        for entry in config["assemblyIndex"]["entries"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if let Some(id) = entry["questionId"]
                .as_str()
                .filter(|id| active.contains(*id))
            {
                let Some(question) = questions.iter().find(|q| q["questionId"] == id) else {
                    continue;
                };
                if ["contentVersion", "teacherVersion"]
                    .iter()
                    .any(|key| entry[*key] != question[*key])
                {
                    continue;
                }
                for section in crate::knowledge::primary_sections(entry, &config) {
                    let section = section.as_str();
                    let canonical = if matches!(section, "1.1" | "1.2" | "1.3") {
                        format!("rja-compulsory-1:{section}")
                    } else {
                        section.to_owned()
                    };
                    by_section
                        .entry(canonical)
                        .or_default()
                        .insert(id.to_owned());
                }
            }
        }
        fn point_node(
            uid: &str,
            points: &[Value],
            direct: &HashMap<String, HashSet<String>>,
            path: &mut HashSet<String>,
        ) -> AppResult<(Value, HashSet<String>)> {
            if !path.insert(uid.to_owned()) {
                return Err(integrity("知识点层级包含循环引用。"));
            }
            let row = points
                .iter()
                .find(|row| row["knowledge_uid"] == uid)
                .ok_or_else(|| integrity("知识点身份缺失。"))?;
            let mut value = original(row)?;
            value["uid"] = json!(uid);
            value["id"] = json!(uid);
            value["name"] = row["name"].clone();
            value["label"] = row["name"].clone();
            value["parentUid"] = row["parent_uid"].clone();
            value["isLeaf"] = json!(row["is_leaf"].as_i64() == Some(1));
            let mut ids = direct.get(uid).cloned().unwrap_or_default();
            let mut children = Vec::new();
            for child in points.iter().filter(|row| row["parent_uid"] == uid) {
                let child_id = child["knowledge_uid"]
                    .as_str()
                    .ok_or_else(|| integrity("知识点身份缺失。"))?;
                let (node, child_ids) = point_node(child_id, points, direct, path)?;
                children.push(node);
                ids.extend(child_ids);
            }
            value["directReadyCount"] = json!(direct.get(uid).map_or(0, HashSet::len));
            value["readyCount"] = json!(ids.len());
            value["children"] = json!(children);
            path.remove(uid);
            Ok((value, ids))
        }
        let all_uids: HashSet<&str> = points
            .iter()
            .filter_map(|row| row["knowledge_uid"].as_str())
            .collect();
        let mut knowledge_roots = Vec::new();
        let mut point_lookup = HashMap::new();
        let mut point_ids = HashMap::new();
        for row in &points {
            let uid = row["knowledge_uid"]
                .as_str()
                .ok_or_else(|| integrity("知识点身份无效。"))?;
            let (node, ids) = point_node(uid, &points, &direct, &mut HashSet::new())?;
            point_lookup.insert(uid.to_owned(), node.clone());
            point_ids.insert(uid.to_owned(), ids);
            if row["parent_uid"]
                .as_str()
                .is_none_or(|parent| !all_uids.contains(parent))
            {
                knowledge_roots.push(node);
            }
        }
        let section_knowledge = self.rows("section_knowledge_mappings")?;
        let sections = ordered(self.rows("curriculum_sections")?);
        let chapters = ordered(self.rows("curriculum_chapters")?);
        let books = ordered(self.rows("curriculum_textbooks")?);
        let mut textbooks = Vec::new();
        fn scoped_counts(
            node: &mut Value,
            scope: &HashSet<String>,
            point_ids: &HashMap<String, HashSet<String>>,
            direct: &HashMap<String, HashSet<String>>,
        ) {
            if let Some(uid) = node["uid"].as_str().map(str::to_owned) {
                node["readyCount"] = json!(
                    point_ids
                        .get(&uid)
                        .map_or(0, |ids| ids.intersection(scope).count())
                );
                node["directReadyCount"] = json!(
                    direct
                        .get(&uid)
                        .map_or(0, |ids| ids.intersection(scope).count())
                );
            }
            if let Some(children) = node["children"].as_array_mut() {
                for child in children {
                    scoped_counts(child, scope, point_ids, direct);
                }
            }
        }
        for book in books {
            let book_id = book["textbook_id"]
                .as_str()
                .ok_or_else(|| integrity("教材身份缺失。"))?;
            let mut book_value = original(&book)?;
            book_value["id"] = json!(book_id);
            book_value["label"] = book["title"].clone();
            let mut book_ids = HashSet::new();
            let mut chapter_values = Vec::new();
            for chapter in chapters.iter().filter(|row| row["textbook_id"] == book_id) {
                let chapter_id = chapter["chapter_id"]
                    .as_str()
                    .ok_or_else(|| integrity("教材章节身份缺失。"))?;
                let mut chapter_value = original(chapter)?;
                chapter_value["id"] = json!(chapter_id);
                chapter_value["label"] = chapter["title"].clone();
                let mut chapter_ids = HashSet::new();
                let mut section_values = Vec::new();
                for section in sections
                    .iter()
                    .filter(|row| row["chapter_id"] == chapter_id)
                {
                    let section_id = section["section_id"]
                        .as_str()
                        .ok_or_else(|| integrity("教材小节身份缺失。"))?;
                    let mut section_value = original(section)?;
                    section_value["id"] = json!(section_id);
                    section_value["label"] = section["title"].clone();
                    let ids = by_section.get(section_id).cloned().unwrap_or_default();
                    chapter_ids.extend(ids.iter().cloned());
                    let mut mapped = Vec::new();
                    for mapping in section_knowledge
                        .iter()
                        .filter(|row| row["section_id"] == section_id)
                    {
                        if let Some(uid) = mapping["knowledge_uid"].as_str() {
                            if let Some(node) = point_lookup.get(uid) {
                                let mut node = node.clone();
                                scoped_counts(&mut node, &ids, &point_ids, &direct);
                                node["mappingStatus"] = mapping["status"].clone();
                                node["reviewStatus"] = mapping["review_status"].clone();
                                node["relation"] = mapping["relation"].clone();
                                node["mapping"] = original(mapping)?;
                                mapped.push(node);
                            }
                        }
                    }
                    section_value["readyCount"] = json!(ids.len());
                    section_value["knowledge"] = json!(mapped);
                    section_value["children"] = section_value["knowledge"].clone();
                    section_values.push(section_value);
                }
                book_ids.extend(chapter_ids.iter().cloned());
                chapter_value["readyCount"] = json!(chapter_ids.len());
                chapter_value["sections"] = json!(section_values);
                chapter_value["children"] = chapter_value["sections"].clone();
                chapter_values.push(chapter_value);
            }
            book_value["readyCount"] = json!(book_ids.len());
            book_value["chapters"] = json!(chapter_values);
            book_value["children"] = book_value["chapters"].clone();
            textbooks.push(book_value);
        }
        Ok(
            json!({"textbooks":textbooks,"knowledgePoints":knowledge_roots,"readyCount":active.len()}),
        )
    }

    pub fn publish_import(&self, operation_id: &str, manifest: &Value) -> AppResult<Value> {
        self.publish_import_authorized(operation_id, manifest, PublicationAuthority::Teacher)
    }
    /// Only the source-bound import gate may choose this authority. It keeps
    /// model opinions distinct from teacher checks in the stored question.
    pub(crate) fn publish_model_review_import(
        &self,
        operation_id: &str,
        manifest: &Value,
    ) -> AppResult<Value> {
        self.publish_import_authorized(operation_id, manifest, PublicationAuthority::ModelReview)
    }
    #[cfg(debug_assertions)]
    pub(crate) fn publication_snapshot_sha256(&self) -> AppResult<String> {
        publication_snapshot(&self.connection)
    }
    /// This is deliberately absent from release builds and from normal IPC.
    /// Its only caller has validated every selected question's real audit.
    #[cfg(debug_assertions)]
    pub(crate) fn publish_agent_review(
        &self,
        operation_id: &str,
        manifest: &Value,
        report_sha256: &str,
        expected_bank_sha256: &str,
    ) -> AppResult<Value> {
        self.publish_import_authorized(
            operation_id,
            manifest,
            PublicationAuthority::AgentReview {
                report_sha256: report_sha256.to_owned(),
                expected_bank_sha256: expected_bank_sha256.to_owned(),
            },
        )
    }
    fn publish_import_authorized(
        &self,
        operation_id: &str,
        manifest: &Value,
        authority: PublicationAuthority,
    ) -> AppResult<Value> {
        if operation_id.is_empty()
            || operation_id.len() > 100
            || !operation_id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        {
            return Err(AppError::new(
                "invalid_operation",
                "缺少有效的发布操作标识。",
            ));
        }
        let manifest_hash = hash_json(manifest);
        let transaction = rusqlite::Transaction::new_unchecked(
            &self.connection,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let previous: Option<(String, String)> = transaction
            .query_row(
                "SELECT manifest_sha256,receipt FROM bank_publications WHERE operation_id=?1",
                [operation_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((hash, receipt)) = previous {
            if hash != manifest_hash {
                return Err(AppError::new(
                    "operation_conflict",
                    "此操作标识已用于其他发布内容。",
                ));
            }
            let mut receipt: Value = serde_json::from_str(&receipt)?;
            receipt["replayed"] = json!(true);
            transaction.commit()?;
            return Ok(receipt);
        }
        let model_authority = matches!(authority, PublicationAuthority::ModelReview);
        let agent_authority = match &authority {
            PublicationAuthority::Teacher => false,
            PublicationAuthority::ModelReview => {
                if manifest["userConfirmedPublication"] != true
                    || manifest["teacherConfirmed"] != false
                {
                    return Err(AppError::new(
                        "review_required",
                        "请显式确认模型初审可入库的题目。",
                    ));
                }
                false
            }
            #[cfg(debug_assertions)]
            PublicationAuthority::AgentReview {
                report_sha256,
                expected_bank_sha256,
            } => {
                if manifest["teacherConfirmed"] != false
                    || manifest["agentReview"]["kind"] != "user_authorized_agent_review_v1"
                    || hash_json(&manifest["agentReview"]) != *report_sha256
                {
                    return Err(AppError::new(
                        "review_required",
                        "代理发布缺少绑定的逐题核验报告。",
                    ));
                }
                if publication_snapshot(&transaction)? != *expected_bank_sha256 {
                    return Err(AppError::new(
                        "bank_snapshot_conflict",
                        "题库在核验后已变化，请重新检查重复题并绑定最新快照。",
                    ));
                }
                true
            }
        };
        if !agent_authority && !model_authority && manifest["teacherConfirmed"] != true {
            return Err(AppError::new(
                "review_required",
                "请先审核并确认要发布的题目。",
            ));
        }
        let questions = manifest["questions"]
            .as_array()
            .filter(|rows| !rows.is_empty())
            .ok_or_else(|| integrity("没有已审核的待发布题目。"))?;
        let patch = manifest["configPatch"]
            .as_object()
            .ok_or_else(|| integrity("导入缺少题库目录信息。"))?;
        if patch.keys().any(|key| {
            !matches!(
                key.as_str(),
                "tasks" | "sources" | "chapters" | "assemblyIndex"
            )
        }) {
            return Err(integrity("导入仅能追加任务、来源、章节和题目索引。"));
        }
        let config_payload: String = transaction.query_row(
            "SELECT value FROM bank_metadata WHERE key='config'",
            [],
            |row| row.get(0),
        )?;
        let config: Value = serde_json::from_str(&config_payload)?;
        let mut next_config = add_catalogue(&config, &manifest["configPatch"])?;
        if let Some(sources) = patch.get("sources") {
            let current = next_config
                .get("sourceManifest")
                .cloned()
                .unwrap_or_else(|| json!({"schemaVersion":1,"sources":[]}));
            next_config["sourceManifest"] = add_catalogue(&current, &json!({"sources":sources}))?;
        }
        let knowledge: HashSet<String> = self
            .rows("knowledge_points")?
            .iter()
            .filter_map(|row| row["knowledge_uid"].as_str().map(str::to_owned))
            .collect();
        let sections: HashSet<String> = self
            .rows("curriculum_sections")?
            .iter()
            .filter_map(|row| row["section_id"].as_str().map(str::to_owned))
            .collect();
        let mut ids = HashSet::new();
        let mut ordered = Vec::new();
        let mut added = 0;
        let entries = manifest["configPatch"]["assemblyIndex"]["entries"]
            .as_array()
            .ok_or_else(|| integrity("导入缺少真实题目索引。"))?;
        let mut annotation_config = next_config.clone();
        annotation_config["knowledgeCatalogue"] = crate::knowledge::catalogue(
            &self.rows("knowledge_points")?,
            &self.rows("section_knowledge_mappings")?,
        );
        for question in questions {
            verify_question(question)?;
            let id = question["questionId"].as_str().unwrap();
            if !ids.insert(id.to_owned()) {
                return Err(integrity("导入包含重复题目身份。"));
            }
            ordered.push(id.to_owned());
            if !agent_authority
                && !model_authority
                && (question["verification"]["checkedBy"]
                    .as_str()
                    .is_none_or(str::is_empty)
                    || question["verification"]["method"].as_str() != Some("teacher_review"))
            {
                return Err(AppError::new(
                    "review_required",
                    "每道发布题目需要保留教师审核记录。",
                ));
            }
            if model_authority {
                let verification = &question["verification"];
                let method = verification["method"].as_str().unwrap_or("");
                if method == "model_review" {
                    let opinion = &verification["modelReview"];
                    if opinion["status"] != "ready"
                        || opinion["confidence"] != "high"
                        || opinion["issues"].as_array().is_none_or(|v| !v.is_empty())
                        || verification["userConfirmedPublication"] != true
                        || opinion["audit"]["sha256"]
                            .as_str()
                            .is_none_or(|s| s.len() != 64)
                    {
                        return Err(AppError::new(
                            "review_required",
                            "模型初审意见未通过，不可发布。",
                        ));
                    }
                } else if method != "teacher_review"
                    || verification["checkedBy"].as_str().is_none_or(str::is_empty)
                {
                    return Err(AppError::new("review_required", "缺少有效初审或人工复核。"));
                }
            }
            #[cfg(debug_assertions)]
            if agent_authority {
                let audit = &question["verification"]["agentReview"];
                let selected = manifest["agentReview"]["questions"]
                    .as_array()
                    .ok_or_else(|| integrity("缺少逐题核验项。"))?;
                let matched = selected
                    .iter()
                    .filter(|review| review["questionId"] == id)
                    .collect::<Vec<_>>();
                if question["verification"]["method"] != "user_authorized_agent_review"
                    || question["verification"]["checkedBy"] != "codex"
                    || matched.len() != 1
                    || matched[0]["result"] != "pass"
                    || audit["question"]["review"] != *matched[0]
                    || audit["reportSha256"] != hash_json(&manifest["agentReview"])
                {
                    return Err(AppError::new(
                        "review_required",
                        "发布题目未绑定代理实际通过的逐题核验。",
                    ));
                }
            }
            let index = entries
                .iter()
                .find(|entry| entry["questionId"] == id)
                .ok_or_else(|| integrity("发布题目缺少对应索引。"))?;
            if index["contentVersion"] != question["contentVersion"]
                || index["teacherVersion"] != question["teacherVersion"]
            {
                return Err(integrity("发布索引与题目版本不一致。"));
            }
            crate::knowledge::validate_annotation(index, &annotation_config)?;
            if crate::knowledge::uses_knowledge(index) {
                for path in index["solutionPaths"].as_array().into_iter().flatten() {
                    for premise in path["requiredPremises"].as_array().into_iter().flatten() {
                        if !annotation_config["premises"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .any(|row| row["id"] == *premise)
                        {
                            return Err(integrity("解法使用了未登记的工具或前提。"));
                        }
                    }
                }
            }
            let refs = question["sourceRefs"]
                .as_array()
                .filter(|rows| !rows.is_empty())
                .ok_or_else(|| integrity("发布题目必须保留真实来源。"))?;
            let sources = next_config["sourceManifest"]["sources"]
                .as_array()
                .ok_or_else(|| integrity("来源清单格式无效。"))?;
            if refs.iter().any(|reference| {
                !sources
                    .iter()
                    .any(|source| source["sourceId"] == reference["sourceId"])
            }) {
                return Err(integrity("发布题目引用了未知来源。"));
            }
            let existing: Option<String> = transaction
                .query_row(
                    "SELECT payload FROM bank_questions WHERE id=?1",
                    [id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(existing) = existing {
                let existing: Value = serde_json::from_str(&existing)?;
                if existing != *question {
                    return Err(conflict("题目身份已存在且内容不同，未覆盖原题。"));
                }
            } else {
                transaction.execute(
                    "INSERT INTO bank_questions(id,payload) VALUES(?1,?2)",
                    params![id, question.to_string()],
                )?;
                added += 1;
            }
        }
        #[cfg(debug_assertions)]
        if agent_authority
            && manifest["agentReview"]["questions"]
                .as_array()
                .map_or(0, Vec::len)
                != questions.len()
        {
            return Err(integrity("逐题核验范围与发布范围不同。"));
        }
        // Model-assigned knowledge mappings take effect with exact catalogue UIDs.
        // Publishing question content still requires the teacher review above.
        for (field, kind) in [
            ("knowledgeMappings", "question_knowledge_mappings"),
            ("sectionMappings", "question_section_mappings"),
        ] {
            let mappings = match manifest.get(field) {
                None => &[][..],
                Some(value) => value
                    .as_array()
                    .map(Vec::as_slice)
                    .ok_or_else(|| integrity("导入映射格式无效。"))?,
            };
            for mapping in mappings {
                let qid = mapping["questionId"].as_str().unwrap_or_default();
                if !ids.contains(qid) {
                    return Err(integrity("导入映射只能关联本次已审核题目。"));
                }
                let (key, row) = if field == "knowledgeMappings" {
                    let uid = mapping["knowledgeUid"].as_str().unwrap_or_default();
                    if !knowledge.contains(uid)
                        || !matches!(
                            mapping["status"].as_str(),
                            Some(
                                "model_mapped"
                                    | "teacher_assigned"
                                    | "teacher_confirmed"
                                    | "teacher_reviewed"
                            )
                        )
                        || mapping["basis"].as_str().is_none_or(str::is_empty)
                    {
                        return Err(integrity("知识点需使用真实 UID 并保留关联来源依据。"));
                    }
                    let topic = mapping["topic"].as_str().unwrap_or("");
                    let mut content = json!({"uid":uid,"status":mapping["status"],"basis":mapping["basis"],"publicationId":operation_id});
                    let mut row = json!({"question_id":qid,"knowledge_uid":uid,"topic":topic,"status":mapping["status"],"basis":mapping["basis"]});
                    let mut key = format!("{qid}\u{1f}{uid}\u{1f}{topic}");
                    if let Some(role) = mapping.get("role") {
                        let role = role
                            .as_str()
                            .filter(|role| matches!(*role, "primary" | "supporting" | "related"))
                            .ok_or_else(|| integrity("知识点关联角色无效。"))?;
                        let index = entries
                            .iter()
                            .find(|entry| entry["questionId"] == qid)
                            .unwrap();
                        let path_id = mapping["solutionPathId"].as_str().unwrap_or_default();
                        let primary = index["primaryKnowledgeUids"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .any(|value| value == uid);
                        if role == "primary" && (!primary || !path_id.is_empty())
                            || role == "supporting"
                                && (primary
                                    || path_id.is_empty()
                                    || !index["solutionPaths"]
                                        .as_array()
                                        .into_iter()
                                        .flatten()
                                        .any(|path| {
                                            path["id"] == path_id
                                                && path["requiredKnowledgeUids"]
                                                    .as_array()
                                                    .into_iter()
                                                    .flatten()
                                                    .any(|value| value == uid)
                                        }))
                            || role == "related" && crate::knowledge::uses_knowledge(index)
                        {
                            return Err(integrity("知识点角色或解法身份与题目标注不一致。"));
                        }
                        content["role"] = json!(role);
                        row["role"] = json!(role);
                        if role == "supporting" {
                            content["solutionPathId"] = json!(path_id);
                            row["solution_path_id"] = json!(path_id);
                        }
                        key = format!("{key}\u{1f}{role}\u{1f}{path_id}");
                    }
                    row["payload"] = json!(content.to_string());
                    row["sha256"] = json!(hash_json(&content));
                    (key, row)
                } else {
                    let sid = mapping["sectionId"].as_str().unwrap_or_default();
                    if !sections.contains(sid) {
                        return Err(integrity("教材小节需使用现有目录的真实 ID。"));
                    }
                    (
                        format!("{qid}\u{1f}{sid}"),
                        json!({"question_id":qid,"section_id":sid,"raw_section_id":mapping.get("rawSectionId").and_then(Value::as_str).unwrap_or(sid),"position":mapping["position"].as_u64().unwrap_or(0)}),
                    )
                };
                let existing: Option<(String, String)> = transaction
                    .query_row(
                        "SELECT payload,sha256 FROM bank_local_rows WHERE kind=?1 AND id=?2",
                        params![kind, key],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                if let Some((payload, hash)) = existing {
                    let prior: Value = serde_json::from_str(&payload)?;
                    if prior != row || hash_json(&prior) != hash {
                        return Err(conflict("导入映射身份已存在且内容不同。"));
                    }
                } else {
                    transaction.execute(
                        "INSERT INTO bank_local_rows(kind,id,payload,sha256) VALUES(?1,?2,?3,?4)",
                        params![kind, key, row.to_string(), hash_json(&row)],
                    )?;
                }
            }
        }
        transaction.execute(
            "UPDATE bank_metadata SET value=?1 WHERE key='config'",
            [next_config.to_string()],
        )?;
        let receipt = json!({"publicationId":operation_id,"questionIds":ordered,"addedQuestions":added,"replayed":false});
        transaction.execute(
            "INSERT INTO bank_publications(operation_id,manifest_sha256,receipt) VALUES(?1,?2,?3)",
            params![operation_id, manifest_hash, receipt.to_string()],
        )?;
        transaction.commit()?;
        Ok(receipt)
    }
}

impl BankRepository for LocalQuestionBank {
    fn config(&self) -> AppResult<Value> {
        let payload: String = self.connection.query_row(
            "SELECT value FROM bank_metadata WHERE key='config'",
            [],
            |row| row.get(0),
        )?;
        let mut config: Value = serde_json::from_str(&payload)?;
        if !config.is_object() {
            return Err(integrity("本地题库配置损坏。"));
        }
        let points = self.rows("knowledge_points")?;
        if !points.is_empty() {
            config["knowledgeCatalogue"] =
                crate::knowledge::catalogue(&points, &self.rows("section_knowledge_mappings")?);
        }
        Ok(config)
    }

    fn questions(&self) -> AppResult<Vec<Value>> {
        let mut statement = self
            .connection
            .prepare("SELECT id,payload FROM bank_questions ORDER BY id")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.map(|row| {
            let (id, payload) = row?;
            self.decode(&id, &payload)
        })
        .collect()
    }

    fn question(&self, id: &str) -> AppResult<Value> {
        let payload: Option<String> = self
            .connection
            .query_row(
                "SELECT payload FROM bank_questions WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        self.decode(
            id,
            &payload.ok_or_else(|| AppError::new("not_found", "没有找到该题目。"))?,
        )
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    pub(crate) fn seed() -> Value {
        let student = json!({"stem":"模拟回归题 $1+1=$","options":[],"parts":[],"assets":[]});
        let teacher = json!({"answers":[{"text":"2"}],"solutions":[],"scoringSuggestions":[]});
        let content_hash = hash_json(&student);
        let teacher_hash = hash_json(&teacher);
        let content_version = format!("content-{}", &content_hash[..16]);
        let teacher_version = format!("teacher-{}", &teacher_hash[..16]);
        json!({"schemaVersion":1,"config":{"subject":"math"},"questions":[{
            "schemaVersion":1,"questionId":"simulated-question","questionType":"fill_blank",
            "student":student,"teacher":teacher,"contentSha256":content_hash,"teacherSha256":teacher_hash,
            "contentVersion":content_version,"teacherVersion":teacher_version,
            "verification":{"result":"pass","contentVersion":content_version,"teacherVersion":teacher_version}
        }]})
    }

    #[cfg(debug_assertions)]
    fn manual_only_fixture() -> (tempfile::TempDir, LocalQuestionBank, Value) {
        let dir = tempfile::tempdir().unwrap();
        let mut seed = seed();
        let old = seed["questions"][0].clone();
        let mut entries = vec![];
        for i in 0..2 {
            let mut q = old.clone();
            q["questionId"] = json!(format!("simulated-agent-manual-{i}"));
            q["verification"]["method"] = json!("user_authorized_agent_review");
            q["verification"]["checkedBy"] = json!("codex");
            q["verification"]["agentReview"] = json!({"question":{"method":"user_authorized_agent_review","review":{"result":"pass"}}});
            entries.push(json!({"questionId":q["questionId"],"contentVersion":q["contentVersion"],"teacherVersion":q["teacherVersion"],"knowledgeSchemaVersion":2,"primaryKnowledgeUids":["simulated-leaf"],"primarySections":["simulated-section"],"tasks":["simulated-task"],"solutionPaths":[{"id":"simulated-original-path","requiredKnowledgeUids":["simulated-leaf"],"requiredPremises":[],"basis":"模拟原模型路径：需保留完整审计，不能直接丢弃。"}],"difficultyLevel":"medium","difficultyBasis":"模拟原难度依据","difficultyRubricVersion":"content-demand-v1","annotationSource":"model","notes":"模拟原模型索引"}));
            seed["questions"].as_array_mut().unwrap().push(q);
        }
        seed["config"] = json!({"subject":"math","knowledgeCatalogue":{"points":[{"uid":"simulated-leaf","isLeaf":true}]},"assemblyIndex":{"entries":entries}});
        let bank = LocalQuestionBank::open(&dir.path().join("bank.sqlite"), &seed).unwrap();
        (dir, bank, seed)
    }
    #[cfg(debug_assertions)]
    fn manual_only_report(bank: &LocalQuestionBank) -> Value {
        let snap = bank
            .agent_manual_only_snapshot(&json!([
                "simulated-agent-manual-0",
                "simulated-agent-manual-1"
            ]))
            .unwrap();
        json!({"kind":"user_authorized_agent_manual_only_v1","reviewer":"codex","authorization":{"request":"模拟用户明确授权：内容合格题入库，未核实完整解法者保守限定手动。"},"bankSnapshotSha256":snap["bankSnapshotSha256"],"questions":snap["questions"].as_array().unwrap().iter().map(|q|json!({"questionId":q["questionId"],"expectedAnnotationSha256":q["expectedAnnotationSha256"],"basis":"模拟核验发现模型路径漏标；仅手动可用，原标注完整保留。"})).collect::<Vec<_>>()})
    }
    #[test]
    #[cfg(debug_assertions)]
    fn manual_only_restricts_agent_metadata_atomically_and_preserves_all_content_and_original_audit()
     {
        let (_dir, bank, _seed) = manual_only_fixture();
        let before = bank.questions().unwrap();
        let old_config = bank.config().unwrap();
        let report = manual_only_report(&bank);
        let result = bank
            .restrict_agent_to_manual("simulated-manual-only", &report)
            .unwrap();
        assert_eq!(result["restrictedQuestions"], 2);
        assert_eq!(bank.questions().unwrap(), before);
        let config = bank.config().unwrap();
        for (i, next) in config["assemblyIndex"]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
        {
            assert_eq!(next["tasks"], json!([]));
            assert_eq!(next["solutionPaths"], json!([]));
            let mut old = old_config["assemblyIndex"]["entries"][i].clone();
            old["tasks"] = json!([]);
            old["solutionPaths"] = json!([]);
            old["notes"] = next["notes"].clone();
            assert_eq!(*next, old);
        }
        let audit = bank.rows("agent_manual_only_audit").unwrap();
        assert_eq!(audit.len(), 1);
        assert_eq!(audit[0]["report"], report);
        for (i, change) in audit[0]["changes"].as_array().unwrap().iter().enumerate() {
            assert_eq!(
                change["beforeAnnotation"],
                old_config["assemblyIndex"]["entries"][i]
            );
            assert_eq!(
                change["afterAnnotation"],
                config["assemblyIndex"]["entries"][i]
            );
        }
        assert_eq!(
            bank.restrict_agent_to_manual("simulated-manual-only", &report)
                .unwrap()["replayed"],
            true
        );
        assert_eq!(bank.rows("agent_manual_only_audit").unwrap().len(), 1);
        let mut other = report;
        other["questions"][0]["basis"] = json!("不同原因不能复用原操作。");
        assert_eq!(
            bank.restrict_agent_to_manual("simulated-manual-only", &other)
                .unwrap_err()
                .code,
            "operation_conflict"
        );
    }
    #[test]
    #[cfg(debug_assertions)]
    fn manual_only_rejects_old_questions_stale_snapshots_or_one_bad_entry_without_partial_changes()
    {
        let (_dir, bank, _seed) = manual_only_fixture();
        let before = bank.config().unwrap();
        let questions = bank.questions().unwrap();
        let report = manual_only_report(&bank);
        assert_eq!(
            bank.agent_manual_only_snapshot(&json!(["simulated-question"]))
                .unwrap_err()
                .code,
            "review_required"
        );
        for i in 0..6 {
            let mut bad = report.clone();
            match i {
                0 => bad["bankSnapshotSha256"] = json!("stale"),
                1 => bad["questions"][1]["expectedAnnotationSha256"] = json!("wrong"),
                2 => bad["questions"][1]["questionId"] = json!("simulated-question"),
                3 => bad["questions"][1]["basis"] = json!(""),
                4 => bad["authorization"]["request"] = json!(""),
                _ => bad["reviewer"] = json!("local_teacher"),
            };
            assert!(
                bank.restrict_agent_to_manual(&format!("simulated-manual-bad-{i}"), &bad)
                    .is_err()
            );
            assert_eq!(bank.config().unwrap(), before);
            assert_eq!(bank.questions().unwrap(), questions);
            assert!(bank.rows("agent_manual_only_audit").unwrap().is_empty());
        }
    }
    #[test]
    #[cfg(debug_assertions)]
    fn manual_only_audit_write_failure_rolls_back_the_config_and_allows_safe_retry() {
        let (_dir, bank, _seed) = manual_only_fixture();
        let before = bank.config().unwrap();
        let report = manual_only_report(&bank);
        bank.connection.execute_batch("CREATE TRIGGER simulated_fail_manual_audit BEFORE INSERT ON bank_local_rows WHEN NEW.kind='agent_manual_only_audit' BEGIN SELECT RAISE(ABORT,'simulated audit failure'); END;").unwrap();
        assert!(
            bank.restrict_agent_to_manual("simulated-manual-failure", &report)
                .is_err()
        );
        assert_eq!(bank.config().unwrap(), before);
        assert!(bank.rows("agent_manual_only_audit").unwrap().is_empty());
        bank.connection
            .execute_batch("DROP TRIGGER simulated_fail_manual_audit;")
            .unwrap();
        assert_eq!(
            bank.restrict_agent_to_manual("simulated-manual-failure", &report)
                .unwrap()["restrictedQuestions"],
            2
        );
    }

    fn migration_seed() -> Value {
        let previous = seed();
        let mut next = previous.clone();
        let mut added = next["questions"][0].clone();
        added["questionId"] = json!("simulated-added");
        next["questions"].as_array_mut().unwrap().push(added);
        let mut pending = previous["questions"][0].clone();
        pending["questionId"] = json!("simulated-pending");
        pending["verification"]["result"] = json!("pending");
        let mut raw = next["questions"].as_array().unwrap().clone();
        raw.push(pending);
        let raw_rows: Vec<Value> = raw
            .iter()
            .map(|question| {
                json!({
                    "question_id":question["questionId"],"payload":question.to_string(),
                    "sha256":hash_json(question),"content_version":question["contentVersion"],
                    "teacher_version":question["teacherVersion"]
                })
            })
            .collect();
        next["config"]["chapters"] = json!([{"id":"simulation","label":"模拟回归目录"}]);
        next["bankSnapshot"] = json!({"schemaVersion":1,"questions":raw_rows,
            "ledger":{"entries":[{"questionId":"simulated-question","status":"ready"},{"questionId":"simulated-added","status":"ready"},{"questionId":"simulated-pending","status":"pending"}]},
            "tables":{"question_bank_questions":raw_rows},
            "counts":{"ready":2,"pending":1,"questionRows":3,"sourceUnits":3}
        });
        next["migration"] = json!({"id":"simulated-migration-v1","baselineConfig":previous["config"],"baselineConfigSha256":hash_json(&previous["config"])});
        refresh_manifest(&mut next);
        next
    }

    fn refresh_manifest(seed: &mut Value) {
        seed["migration"]["manifestSha256"] = json!(hash_json(
            &json!({"config":seed["config"],"questions":seed["questions"],"bankSnapshot":seed["bankSnapshot"]})
        ));
    }

    fn migration_with_assets() -> Value {
        let mut incoming = migration_seed();
        let encoded = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWWkAAAAASUVORK5CYII=";
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        let sha = format!("{:x}", Sha256::digest(&bytes));
        let mut original = incoming["questions"][0].clone();
        let mut payloads = Vec::new();
        for role in ["student", "teacher"] {
            let reference = json!({"assetId":format!("simulated-{role}"),"path":format!("simulated/{role}.png"),"sha256":sha,"mimeType":"image/png","alt":"模拟回归配图"});
            original[role]["assets"] = json!([reference]);
            let hash = hash_json(&original[role]);
            let prefix = if role == "student" {
                "content"
            } else {
                "teacher"
            };
            original[format!("{prefix}Sha256")] = json!(hash);
            original[format!("{prefix}Version")] = json!(format!("{prefix}-{}", &hash[..16]));
            original["verification"][format!("{prefix}Version")] =
                original[format!("{prefix}Version")].clone();
            let mut payload = reference;
            payload["role"] = json!(role);
            payload["dataBase64"] = json!(encoded);
            payloads.push(payload);
        }
        let row = incoming["bankSnapshot"]["questions"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|row| row["question_id"] == original["questionId"])
            .unwrap();
        row["payload"] = json!(original.to_string());
        row["sha256"] = json!(hash_json(&original));
        row["content_version"] = original["contentVersion"].clone();
        row["teacher_version"] = original["teacherVersion"].clone();
        incoming["bankSnapshot"]["tables"]["question_bank_questions"] =
            incoming["bankSnapshot"]["questions"].clone();
        original["assetPayloads"] = json!(payloads);
        incoming["questions"][0] = original;
        refresh_manifest(&mut incoming);
        incoming
    }

    #[test]
    fn simulated_snapshot_packaging_appends_only_verified_asset_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let incoming = migration_with_assets();
        let bank = LocalQuestionBank::open(&dir.path().join("bank.sqlite"), &incoming).unwrap();
        let id = incoming["questions"][0]["questionId"].as_str().unwrap();
        let question = bank.question(id).unwrap();
        assert_eq!(question["assetPayloads"].as_array().unwrap().len(), 2);
        let snapshot = bank.snapshot("simulated-migration-v1").unwrap();
        let original: Value =
            serde_json::from_str(snapshot["questions"][0]["payload"].as_str().unwrap()).unwrap();
        assert!(original.get("assetPayloads").is_none());
        assert_eq!(original["student"], question["student"]);
    }

    #[test]
    fn simulated_snapshot_rejects_extra_fields_changed_originals_and_bad_assets() {
        for change in [
            "unknown_question_field",
            "changed_student",
            "missing",
            "base64",
            "hash",
            "mime",
            "role",
            "path",
            "extra_payload_field",
            "unreferenced",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let mut incoming = migration_with_assets();
            let question = &mut incoming["questions"][0];
            match change {
                "unknown_question_field" => question["unverified"] = json!("extra"),
                "changed_student" => {
                    question["student"]["stem"] = json!("模拟回归：更改原题干");
                    let hash = hash_json(&question["student"]);
                    let version = format!("content-{}", &hash[..16]);
                    question["contentSha256"] = json!(hash);
                    question["contentVersion"] = json!(version);
                    question["verification"]["contentVersion"] = json!(version);
                }
                "missing" => {
                    question["assetPayloads"].as_array_mut().unwrap().remove(0);
                }
                "base64" => question["assetPayloads"][0]["dataBase64"] = json!("not base64"),
                "hash" => question["assetPayloads"][0]["sha256"] = json!("0".repeat(64)),
                "mime" => question["assetPayloads"][0]["mimeType"] = json!("image/jpeg"),
                "role" => question["assetPayloads"][0]["role"] = json!("teacher"),
                "path" => question["assetPayloads"][0]["path"] = json!("../image.png"),
                "extra_payload_field" => question["assetPayloads"][0]["unexpected"] = json!(true),
                _ => {
                    let extra = question["assetPayloads"][0].clone();
                    question["assetPayloads"]
                        .as_array_mut()
                        .unwrap()
                        .push(extra);
                }
            }
            refresh_manifest(&mut incoming);
            assert!(
                LocalQuestionBank::open(&dir.path().join("bank.sqlite"), &incoming).is_err(),
                "{change}"
            );
        }
    }

    #[test]
    fn bundled_verified_seed_and_stored_versions_are_checked() {
        let dir = tempfile::tempdir().unwrap();
        let seed: Value = serde_json::from_str(include_str!("../../resources/seed.json")).unwrap();
        let bank = LocalQuestionBank::open(&dir.path().join("bank.sqlite"), &seed).unwrap();
        assert_eq!(
            bank.questions().unwrap().len(),
            seed["questions"].as_array().unwrap().len()
        );
        let mut question = bank.questions().unwrap().remove(0);
        question["student"]["stem"] = json!("changed");
        bank.connection
            .execute(
                "UPDATE bank_questions SET payload=?1 WHERE id=?2",
                params![
                    question.to_string(),
                    question["questionId"].as_str().unwrap()
                ],
            )
            .unwrap();
        assert!(
            bank.question(question["questionId"].as_str().unwrap())
                .is_err()
        );
    }

    #[test]
    fn seed_is_atomic_and_never_replaces_existing_bank() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bank.sqlite");
        let mut invalid = seed();
        invalid["questions"][0]["contentSha256"] = json!("bad");
        assert!(LocalQuestionBank::open(&path, &invalid).is_err());
        let bank = LocalQuestionBank::open(&path, &seed()).unwrap();
        assert_eq!(bank.questions().unwrap().len(), 1);
        bank.connection
            .execute("DELETE FROM bank_questions", [])
            .unwrap();
        drop(bank);
        // An intentionally emptied existing bank is not silently reseeded.
        let bank = LocalQuestionBank::open(&path, &json!(null)).unwrap();
        assert!(bank.questions().unwrap().is_empty());
    }

    #[test]
    fn snapshot_upgrade_retains_local_records_pending_status_and_replays() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bank.sqlite");
        let bank = LocalQuestionBank::open(&path, &seed()).unwrap();
        let mut local = seed()["questions"][0].clone();
        local["questionId"] = json!("local-only");
        bank.connection
            .execute(
                "INSERT INTO bank_questions(id,payload) VALUES('local-only',?1)",
                [local.to_string()],
            )
            .unwrap();
        let mut same_version = seed()["questions"][0].clone();
        same_version["localNote"] = json!("本地人工备注");
        bank.connection
            .execute(
                "UPDATE bank_questions SET payload=?1 WHERE id='simulated-question'",
                [same_version.to_string()],
            )
            .unwrap();
        drop(bank);
        let upgraded = migration_seed();
        let bank = LocalQuestionBank::open(&path, &upgraded).unwrap();
        assert_eq!(bank.questions().unwrap().len(), 3);
        assert_eq!(
            bank.question("simulated-question").unwrap()["localNote"],
            "本地人工备注"
        );
        assert!(bank.question("simulated-pending").is_err());
        assert_eq!(
            bank.snapshot("simulated-migration-v1").unwrap(),
            upgraded["bankSnapshot"]
        );
        bank.connection
            .execute("DELETE FROM bank_questions WHERE id='simulated-added'", [])
            .unwrap();
        drop(bank);
        let bank = LocalQuestionBank::open(&path, &upgraded).unwrap();
        assert_eq!(bank.questions().unwrap().len(), 2);
        assert_eq!(
            bank.connection
                .query_row("SELECT count(*) FROM bank_migrations", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn conflicting_question_version_rolls_back_every_insert_and_catalogue_change() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bank.sqlite");
        let bank = LocalQuestionBank::open(&path, &seed()).unwrap();
        let mut changed = seed()["questions"][0].clone();
        changed["student"]["stem"] = json!("本地已编辑的模拟回归题");
        let hash = hash_json(&changed["student"]);
        let version = format!("content-{}", &hash[..16]);
        changed["contentSha256"] = json!(hash);
        changed["contentVersion"] = json!(version);
        changed["verification"]["contentVersion"] = json!(version);
        bank.connection
            .execute(
                "UPDATE bank_questions SET payload=?1 WHERE id='simulated-question'",
                [changed.to_string()],
            )
            .unwrap();
        drop(bank);
        let mut incoming = migration_seed();
        incoming["questions"].as_array_mut().unwrap().reverse();
        refresh_manifest(&mut incoming);
        assert_eq!(
            LocalQuestionBank::open(&path, &incoming)
                .err()
                .unwrap()
                .code,
            "bank_migration_conflict"
        );
        let bank = LocalQuestionBank::open(&path, &json!(null)).unwrap();
        assert_eq!(bank.questions().unwrap().len(), 1);
        assert_eq!(bank.config().unwrap(), seed()["config"]);
        assert_eq!(bank.question("simulated-question").unwrap(), changed);
    }

    #[test]
    fn migration_rejects_pending_promotion_and_manifest_reuse_or_private_tables() {
        for mode in ["pending", "private", "bad_hash"] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("bank.sqlite");
            let mut incoming = migration_seed();
            match mode {
                "pending" => {
                    incoming["bankSnapshot"]["ledger"]["entries"][0]["status"] = json!("pending")
                }
                "private" => incoming["bankSnapshot"]["tables"]["users"] = json!([]),
                _ => incoming["bankSnapshot"]["questions"][0]["sha256"] = json!("incorrect"),
            }
            refresh_manifest(&mut incoming);
            assert!(LocalQuestionBank::open(&path, &incoming).is_err());
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bank.sqlite");
        let mut incoming = migration_seed();
        drop(LocalQuestionBank::open(&path, &incoming).unwrap());
        incoming["config"]["description"] = json!("different migration content");
        refresh_manifest(&mut incoming);
        assert_eq!(
            LocalQuestionBank::open(&path, &incoming)
                .err()
                .unwrap()
                .code,
            "bank_migration_conflict"
        );
    }

    #[test]
    fn catalogue_merge_preserves_local_additions_and_rejects_competing_edits() {
        let base = json!({"tasks":[{"id":"a","label":"原任务"}],"sources":[]});
        let local = json!({"tasks":[{"id":"a","label":"原任务"},{"id":"local","label":"本地任务"}],"sources":[]});
        let incoming = json!({"tasks":[{"id":"a","label":"原任务"},{"id":"new","label":"迁移任务"}],"sources":[]});
        assert_eq!(
            merge_config(&base, &local, &incoming).unwrap()["tasks"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
        let local = json!({"tasks":[{"id":"a","label":"本地名称"}],"sources":[]});
        let incoming = json!({"tasks":[{"id":"a","label":"迁移名称"}],"sources":[]});
        assert_eq!(
            merge_config(&base, &local, &incoming).unwrap_err().code,
            "bank_migration_conflict"
        );
    }

    #[test]
    fn real_catalogue_preserves_hierarchy_and_uses_assigned_knowledge_without_extra_review() {
        let directory = tempfile::tempdir().unwrap();
        let seed: Value = serde_json::from_str(include_str!("../../resources/seed.json")).unwrap();
        let bank = LocalQuestionBank::open(&directory.path().join("bank.sqlite"), &seed).unwrap();
        let catalogue = bank.catalog().unwrap();
        assert_eq!(catalogue["textbooks"].as_array().unwrap().len(), 5);
        assert_eq!(catalogue["readyCount"], 358);
        let mut chapter_count = 0;
        let mut section_count = 0;
        let mut pending_count = 0;
        for book in catalogue["textbooks"].as_array().unwrap() {
            for chapter in book["chapters"].as_array().unwrap() {
                chapter_count += 1;
                for section in chapter["sections"].as_array().unwrap() {
                    section_count += 1;
                    for mapping in section["knowledge"].as_array().unwrap() {
                        assert!(mapping["uid"].as_str().unwrap().starts_with("M-K-"));
                        if mapping["reviewStatus"] == "pending_review" {
                            pending_count += 1;
                        }
                    }
                }
            }
        }
        assert_eq!(chapter_count, 18);
        assert_eq!(section_count, 73);
        assert_eq!(pending_count, 438);
        fn count_nodes(nodes: &Value) -> usize {
            nodes
                .as_array()
                .unwrap()
                .iter()
                .map(|node| 1 + count_nodes(&node["children"]))
                .sum()
        }
        assert_eq!(count_nodes(&catalogue["knowledgePoints"]), 509);
        let ready: HashSet<String> = seed["questions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|question| question["questionId"].as_str().unwrap().to_owned())
            .collect();
        let rows = seed["bankSnapshot"]["tables"]["question_knowledge_mappings"]
            .as_array()
            .unwrap();
        let uid = "M-K-01-1211";
        let expected: BTreeSet<String> = rows
            .iter()
            .filter(|row| row["knowledge_uid"] == uid)
            .filter_map(|row| {
                row["question_id"]
                    .as_str()
                    .filter(|qid| ready.contains(*qid))
                    .map(str::to_owned)
            })
            .collect();
        assert!(!expected.is_empty());
        assert_eq!(
            bank.question_ids_for_knowledge(uid, false).unwrap(),
            expected.into_iter().collect::<Vec<_>>()
        );
        let parent = "M-K-01-000";
        let parent_ids = bank.question_ids_for_knowledge(parent, true).unwrap();
        for qid in bank.question_ids_for_knowledge(uid, false).unwrap() {
            assert!(parent_ids.contains(&qid));
        }
        assert!(bank.question_ids_for_knowledge("集合", true).is_err());

        // Independently calculate the same main-scope AND assigned-knowledge
        // predicate used by bank_search. Every navigation badge must equal the
        // unpaginated result count, including nested knowledge children.
        let mut primary: HashMap<String, HashSet<String>> = HashMap::new();
        for entry in seed["config"]["assemblyIndex"]["entries"]
            .as_array()
            .unwrap()
        {
            let qid = entry["questionId"].as_str().unwrap();
            if !ready.contains(qid) {
                continue;
            }
            for value in entry["primarySections"].as_array().unwrap() {
                let section = value.as_str().unwrap();
                let section = match section {
                    "1.1" => "rja-compulsory-1:1.1",
                    "1.2" => "rja-compulsory-1:1.2",
                    "1.3" => "rja-compulsory-1:1.3",
                    other => other,
                };
                primary
                    .entry(section.to_owned())
                    .or_default()
                    .insert(qid.to_owned());
            }
        }
        let point_rows = seed["bankSnapshot"]["tables"]["knowledge_points"]
            .as_array()
            .unwrap();
        let parents: HashMap<String, Option<String>> = point_rows
            .iter()
            .map(|row| {
                (
                    row["knowledge_uid"].as_str().unwrap().to_owned(),
                    row["parent_uid"].as_str().map(str::to_owned),
                )
            })
            .collect();
        let mut descendants: HashMap<String, HashSet<String>> = HashMap::new();
        let mut direct: HashMap<String, HashSet<String>> = HashMap::new();
        for row in rows {
            let qid = row["question_id"].as_str().unwrap();
            if !ready.contains(qid) {
                continue;
            }
            let mut uid = Some(row["knowledge_uid"].as_str().unwrap().to_owned());
            direct
                .entry(uid.as_ref().unwrap().clone())
                .or_default()
                .insert(qid.to_owned());
            let mut visited = HashSet::new();
            while let Some(id) = uid {
                assert!(visited.insert(id.clone()));
                descendants
                    .entry(id.clone())
                    .or_default()
                    .insert(qid.to_owned());
                uid = parents.get(&id).cloned().flatten();
            }
        }
        fn verify_badges(
            nodes: &Value,
            scope: Option<&HashSet<String>>,
            full: &HashMap<String, HashSet<String>>,
            direct: &HashMap<String, HashSet<String>>,
        ) {
            for node in nodes.as_array().unwrap() {
                let uid = node["uid"].as_str().unwrap();
                let count = |lookup: &HashMap<String, HashSet<String>>| {
                    lookup.get(uid).map_or(0, |ids| {
                        scope.map_or(ids.len(), |scope| ids.intersection(scope).count())
                    })
                };
                assert_eq!(
                    node["readyCount"].as_u64().unwrap(),
                    count(full) as u64,
                    "{uid}"
                );
                assert_eq!(
                    node["directReadyCount"].as_u64().unwrap(),
                    count(direct) as u64,
                    "{uid}"
                );
                verify_badges(&node["children"], scope, full, direct);
            }
        }
        verify_badges(&catalogue["knowledgePoints"], None, &descendants, &direct);
        for book in catalogue["textbooks"].as_array().unwrap() {
            let mut book_ids = HashSet::new();
            for chapter in book["chapters"].as_array().unwrap() {
                let mut chapter_ids = HashSet::new();
                for section in chapter["sections"].as_array().unwrap() {
                    let section_id = section["id"].as_str().unwrap();
                    let ids = primary.get(section_id).cloned().unwrap_or_default();
                    assert_eq!(
                        section["readyCount"].as_u64().unwrap(),
                        ids.len() as u64,
                        "{section_id}"
                    );
                    verify_badges(&section["knowledge"], Some(&ids), &descendants, &direct);
                    chapter_ids.extend(ids);
                }
                assert_eq!(
                    chapter["readyCount"].as_u64().unwrap(),
                    chapter_ids.len() as u64
                );
                book_ids.extend(chapter_ids);
            }
            assert_eq!(book["readyCount"].as_u64().unwrap(), book_ids.len() as u64);
        }
    }

    #[test]
    fn legacy_belongs_and_enumeration_assignments_work_on_existing_databases_without_rewriting_archive()
     {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("bank.sqlite");
        let seed: Value = serde_json::from_str(include_str!("../../resources/seed.json")).unwrap();
        let bank = LocalQuestionBank::open(&path, &seed).unwrap();
        let archive: (String, String) = bank
            .connection
            .query_row("SELECT payload,sha256 FROM bank_snapshots", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        drop(bank);
        let bank = LocalQuestionBank::open(&path, &seed).unwrap();
        for (uid, suffixes) in [
            (
                "M-K-01-113",
                vec!["007", "008", "009", "010", "011", "012", "018"],
            ),
            ("M-K-01-114", vec!["020", "022", "024", "026", "027"]),
        ] {
            let expected: Vec<String> = suffixes.iter().map(|s| format!("tutor-set-{s}")).collect();
            assert_eq!(
                bank.question_ids_for_knowledge(uid, false).unwrap(),
                expected
            );
            let catalogue = bank.catalog().unwrap();
            let section = catalogue["textbooks"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|book| book["chapters"].as_array().unwrap())
                .flat_map(|chapter| chapter["sections"].as_array().unwrap())
                .find(|section| section["id"] == "rja-compulsory-1:1.1")
                .unwrap();
            let point = section["knowledge"]
                .as_array()
                .unwrap()
                .iter()
                .find(|point| point["uid"] == uid)
                .unwrap();
            assert_eq!(point["readyCount"], json!(expected.len()));
        }
        let after: (String, String) = bank
            .connection
            .query_row("SELECT payload,sha256 FROM bank_snapshots", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(archive, after);
        assert_eq!(bank.questions().unwrap().len(), 358);
        assert!(!active_knowledge_mapping(&json!({"status":"rejected"})));
        assert!(!active_knowledge_mapping(&json!({"status":"unknown"})));
    }

    fn publication(seed: &Value) -> Value {
        let mut question = seed["questions"][0].clone();
        question["questionId"] = json!("simulated-published-question");
        question["verification"]["method"] = json!("teacher_review");
        question["verification"]["checkedBy"] = json!("模拟教师");
        question["sourceRefs"] = json!([{"sourceId":"simulated-import-source","pages":[1]}]);
        let entry = json!({"questionId":question["questionId"],"contentVersion":question["contentVersion"],"teacherVersion":question["teacherVersion"],"tasks":[],"primarySections":["rja-compulsory-1:1.1"],"solutionPaths":[],"duplicateGroup":"simulated-published-question"});
        json!({"teacherConfirmed":true,"questions":[question],"configPatch":{"sources":[{"sourceId":"simulated-import-source","role":"student","path":"local-imports/simulation.pdf","sha256":"0".repeat(64),"physicalPages":[1]}],"tasks":[],"assemblyIndex":{"entries":[entry]}},"knowledgeMappings":[{"questionId":"simulated-published-question","knowledgeUid":"M-K-01-111","topic":"模拟集合","status":"teacher_confirmed","basis":"模拟回归：教师明确确认归属"}],"sectionMappings":[{"questionId":"simulated-published-question","sectionId":"rja-compulsory-1:1.1","position":0}]})
    }

    #[test]
    fn model_knowledge_assignments_are_active_without_claiming_teacher_confirmation() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("bank.sqlite");
        let seed: Value = serde_json::from_str(include_str!("../../resources/seed.json")).unwrap();
        let bank = LocalQuestionBank::open(&path, &seed).unwrap();
        let mut manifest = publication(&seed);
        manifest["knowledgeMappings"][0]["status"] = json!("model_mapped");
        manifest["knowledgeMappings"][0]["basis"] = json!("模拟回归：模型按题目内容关联目录 UID");
        let mut unknown = manifest.clone();
        unknown["knowledgeMappings"][0]["knowledgeUid"] = json!("M-K-NOT-IN-CATALOGUE");
        assert!(
            bank.publish_import("simulated-model-unknown-uid", &unknown)
                .is_err()
        );
        let mut unreviewed = manifest.clone();
        unreviewed["teacherConfirmed"] = json!(false);
        assert_eq!(
            bank.publish_import("simulated-model-unreviewed-content", &unreviewed)
                .unwrap_err()
                .code,
            "review_required"
        );
        bank.publish_import("simulated-model-mapping", &manifest)
            .unwrap();
        drop(bank);
        let bank = LocalQuestionBank::open(&path, &seed).unwrap();
        assert!(
            bank.question_ids_for_knowledge("M-K-01-111", false)
                .unwrap()
                .contains(&"simulated-published-question".to_owned())
        );
        let mapping = bank
            .rows("question_knowledge_mappings")
            .unwrap()
            .into_iter()
            .find(|row| row["question_id"] == "simulated-published-question")
            .unwrap();
        assert_eq!(mapping["status"], "model_mapped");
        assert_eq!(
            serde_json::from_str::<Value>(mapping["payload"].as_str().unwrap()).unwrap()["status"],
            "model_mapped"
        );
    }

    #[test]
    fn knowledge_roles_and_distinct_solution_paths_persist_without_inflating_support_counts() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("bank.sqlite");
        let seed: Value = serde_json::from_str(include_str!("../../resources/seed.json")).unwrap();
        let bank = LocalQuestionBank::open(&path, &seed).unwrap();
        let mut manifest = publication(&seed);
        let entry = &mut manifest["configPatch"]["assemblyIndex"]["entries"][0];
        entry["knowledgeSchemaVersion"] = json!(2);
        entry["primaryKnowledgeUids"] = json!(["M-K-01-113"]);
        entry["primarySections"] = json!(["1.3"]); // Deliberately stale compatibility projection.
        entry["solutionPaths"] = json!([
            {"id":"simulated-path-a","requiredKnowledgeUids":["M-K-01-113","M-K-01-114"],"requiredPremises":[],"basis":"模拟回归解法甲"},
            {"id":"simulated-path-b","requiredKnowledgeUids":["M-K-01-113","M-K-01-114","M-K-01-115"],"requiredPremises":[],"basis":"模拟回归解法乙"}
        ]);
        manifest["knowledgeMappings"] = json!([
            {"questionId":"simulated-published-question","knowledgeUid":"M-K-01-113","role":"primary","topic":"模拟主考","status":"model_mapped","basis":"模拟回归：主考依据"},
            {"questionId":"simulated-published-question","knowledgeUid":"M-K-01-114","role":"supporting","solutionPathId":"simulated-path-a","topic":"模拟支撑","status":"model_mapped","basis":"模拟回归：解法甲依赖"},
            {"questionId":"simulated-published-question","knowledgeUid":"M-K-01-114","role":"supporting","solutionPathId":"simulated-path-b","topic":"模拟支撑","status":"model_mapped","basis":"模拟回归：解法乙依赖"}
        ]);
        for (i, change) in ["uid", "premise", "path_role", "primary_role"]
            .iter()
            .enumerate()
        {
            let mut invalid = manifest.clone();
            match *change {
                "uid" => {
                    invalid["configPatch"]["assemblyIndex"]["entries"][0]["solutionPaths"][0]["requiredKnowledgeUids"] =
                        json!(["not-a-knowledge-uid"])
                }
                "premise" => {
                    invalid["configPatch"]["assemblyIndex"]["entries"][0]["solutionPaths"][0]["requiredPremises"] =
                        json!(["unregistered-tool"])
                }
                "path_role" => {
                    invalid["knowledgeMappings"][1]["solutionPathId"] = json!("nonexistent-path")
                }
                _ => invalid["knowledgeMappings"][0]["knowledgeUid"] = json!("M-K-01-114"),
            }
            assert!(
                bank.publish_import(&format!("simulated-invalid-knowledge-{i}"), &invalid)
                    .is_err()
            );
            assert_eq!(bank.questions().unwrap().len(), 358);
        }
        bank.publish_import("simulated-versioned-knowledge", &manifest)
            .unwrap();
        drop(bank);
        let bank = LocalQuestionBank::open(&path, &seed).unwrap();
        let qid = "simulated-published-question".to_owned();
        assert!(
            bank.question_ids_for_knowledge("M-K-01-113", false)
                .unwrap()
                .contains(&qid)
        );
        assert!(
            !bank
                .question_ids_for_knowledge("M-K-01-114", false)
                .unwrap()
                .contains(&qid)
        );
        let support: Vec<_> = bank
            .rows("question_knowledge_mappings")
            .unwrap()
            .into_iter()
            .filter(|row| row["question_id"] == qid && row["role"] == "supporting")
            .collect();
        assert_eq!(support.len(), 2);
        assert_ne!(
            support[0]["solution_path_id"],
            support[1]["solution_path_id"]
        );
        let config = bank.config().unwrap();
        let entry = config["assemblyIndex"]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["questionId"] == qid)
            .unwrap();
        assert_eq!(
            crate::knowledge::primary_sections(entry, &config),
            vec!["rja-compulsory-1:1.1"]
        );
    }

    #[test]
    fn simulated_publication_is_atomic_idempotent_and_keeps_snapshots_immutable() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("bank.sqlite");
        let seed: Value = serde_json::from_str(include_str!("../../resources/seed.json")).unwrap();
        let bank = LocalQuestionBank::open(&path, &seed).unwrap();
        let manifest = publication(&seed);
        let id = seed["migration"]["id"].as_str().unwrap();
        let snapshot = bank.snapshot(id).unwrap();
        let before = bank
            .question_ids_for_knowledge("M-K-01-111", false)
            .unwrap()
            .len();
        let first = bank
            .publish_import("simulated-publish-1", &manifest)
            .unwrap();
        assert_eq!(first["addedQuestions"], 1);
        assert_eq!(first["replayed"], false);
        assert_eq!(bank.questions().unwrap().len(), 359);
        assert_eq!(
            bank.question_ids_for_knowledge("M-K-01-111", false)
                .unwrap()
                .len(),
            before + 1
        );
        assert_eq!(bank.snapshot(id).unwrap(), snapshot);
        let second = bank
            .publish_import("simulated-publish-1", &manifest)
            .unwrap();
        assert_eq!(second["replayed"], true);
        assert_eq!(first["publicationId"], second["publicationId"]);
        assert!(
            bank.config().unwrap()["sourceManifest"]["sources"]
                .as_array()
                .unwrap()
                .iter()
                .any(|source| source["sourceId"] == "simulated-import-source")
        );
        assert!(
            bank.config().unwrap()["assemblyIndex"]["entries"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["questionId"] == "simulated-published-question")
                .unwrap()["solutionPaths"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let mut conflicting = manifest.clone();
        conflicting["teacherConfirmed"] = json!(false);
        assert_eq!(
            bank.publish_import("simulated-publish-1", &conflicting)
                .unwrap_err()
                .code,
            "operation_conflict"
        );
        drop(bank);
        let bank = LocalQuestionBank::open(&path, &seed).unwrap();
        assert_eq!(bank.questions().unwrap().len(), 359);
        assert!(
            bank.question_ids_for_knowledge("M-K-01-111", false)
                .unwrap()
                .contains(&"simulated-published-question".to_owned())
        );
    }

    #[test]
    fn simulated_publication_rejects_unreviewed_unknown_uids_and_conflicting_content() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("bank.sqlite");
        let seed: Value = serde_json::from_str(include_str!("../../resources/seed.json")).unwrap();
        let bank = LocalQuestionBank::open(&path, &seed).unwrap();
        let original_config = bank.config().unwrap();
        for (index, change) in [
            "unreviewed",
            "unknown_uid",
            "pending_mapping",
            "unknown_section",
            "wrong_version",
            "model_review",
        ]
        .iter()
        .enumerate()
        {
            let mut manifest = publication(&seed);
            match *change {
                "unreviewed" => manifest["teacherConfirmed"] = json!(false),
                "unknown_uid" => manifest["knowledgeMappings"][0]["knowledgeUid"] = json!("集合"),
                "pending_mapping" => {
                    manifest["knowledgeMappings"][0]["status"] = json!("pending_uid_mapping")
                }
                "unknown_section" => manifest["sectionMappings"][0]["sectionId"] = json!("集合"),
                "wrong_version" => {
                    manifest["configPatch"]["assemblyIndex"]["entries"][0]["contentVersion"] =
                        json!("wrong")
                }
                _ => manifest["questions"][0]["verification"]["method"] = json!("llm_estimate"),
            }
            assert!(
                bank.publish_import(&format!("simulated-reject-{index}"), &manifest)
                    .is_err(),
                "{change}"
            );
            assert_eq!(bank.questions().unwrap().len(), 358);
            assert_eq!(bank.config().unwrap(), original_config);
        }
        bank.publish_import("simulated-publish-1", &publication(&seed))
            .unwrap();
        let mut changed = publication(&seed);
        changed["questions"][0]["localNote"] = json!("different");
        assert!(
            bank.publish_import("simulated-publish-2", &changed)
                .is_err()
        );
        assert_eq!(bank.questions().unwrap().len(), 359);
    }

    #[test]
    fn full_shared_bank_upgrades_original_45_and_preserves_local_additions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bank.sqlite");
        let baseline: Value =
            serde_json::from_str(include_str!("../../resources/seed-v1-baseline.json")).unwrap();
        let incoming: Value =
            serde_json::from_str(include_str!("../../resources/seed.json")).unwrap();
        assert_eq!(baseline["questions"].as_array().unwrap().len(), 45);
        assert_eq!(incoming["questions"].as_array().unwrap().len(), 358);
        let bank = LocalQuestionBank::open(&path, &baseline).unwrap();
        assert_eq!(bank.questions().unwrap().len(), 45);
        let mut local = baseline["questions"][0].clone();
        local["questionId"] = json!("simulated-local-only");
        bank.connection
            .execute(
                "INSERT INTO bank_questions(id,payload) VALUES('simulated-local-only',?1)",
                [local.to_string()],
            )
            .unwrap();
        let mut config = bank.config().unwrap();
        config["tasks"].as_array_mut().unwrap().push(json!({"id":"simulated-local-task","label":"模拟本地任务","questionType":"single_choice","sectionIds":["1.1"]}));
        bank.connection
            .execute(
                "UPDATE bank_metadata SET value=?1 WHERE key='config'",
                [config.to_string()],
            )
            .unwrap();
        drop(bank);
        let bank = LocalQuestionBank::open(&path, &incoming).unwrap();
        assert_eq!(bank.questions().unwrap().len(), 359);
        assert_eq!(bank.question("simulated-local-only").unwrap(), local);
        assert!(
            bank.config().unwrap()["tasks"]
                .as_array()
                .unwrap()
                .iter()
                .any(|task| task["id"] == "simulated-local-task")
        );
        assert_eq!(
            bank.config().unwrap()["chapters"].as_array().unwrap().len(),
            48
        );
        let snapshot = bank
            .snapshot(incoming["migration"]["id"].as_str().unwrap())
            .unwrap();
        assert_eq!(snapshot["questions"].as_array().unwrap().len(), 367);
        assert_eq!(snapshot["ledger"]["entries"].as_array().unwrap().len(), 372);
        for pending in snapshot["ledger"]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| entry["status"] == "pending")
        {
            assert!(
                bank.question(pending["questionId"].as_str().unwrap())
                    .is_err()
            );
        }
        assert_eq!(snapshot["counts"]["pending"], 14);
        drop(bank);
        let bank = LocalQuestionBank::open(&path, &incoming).unwrap();
        assert_eq!(bank.questions().unwrap().len(), 359);
        assert_eq!(
            bank.connection
                .query_row("SELECT count(*) FROM bank_migrations", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn full_shared_bank_conflict_keeps_original_45_without_partial_import() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bank.sqlite");
        let baseline: Value =
            serde_json::from_str(include_str!("../../resources/seed-v1-baseline.json")).unwrap();
        let incoming: Value =
            serde_json::from_str(include_str!("../../resources/seed.json")).unwrap();
        let bank = LocalQuestionBank::open(&path, &baseline).unwrap();
        let mut local = baseline["questions"][0].clone();
        local["student"]["stem"] = json!("模拟回归：本地不同题面版本");
        let hash = hash_json(&local["student"]);
        let version = format!("content-{}", &hash[..16]);
        local["contentSha256"] = json!(hash);
        local["contentVersion"] = json!(version);
        local["verification"]["contentVersion"] = json!(version);
        let id = local["questionId"].as_str().unwrap();
        bank.connection
            .execute(
                "UPDATE bank_questions SET payload=?1 WHERE id=?2",
                params![local.to_string(), id],
            )
            .unwrap();
        drop(bank);
        assert_eq!(
            LocalQuestionBank::open(&path, &incoming)
                .err()
                .unwrap()
                .code,
            "bank_migration_conflict"
        );
        let bank = LocalQuestionBank::open(&path, &json!(null)).unwrap();
        assert_eq!(bank.questions().unwrap().len(), 45);
        assert_eq!(bank.config().unwrap(), baseline["config"]);
        assert_eq!(bank.question(id).unwrap(), local);
        assert_eq!(
            bank.connection
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE name='bank_migrations'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }
}
