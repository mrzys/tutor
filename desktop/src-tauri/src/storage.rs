use crate::{
    bank::{LocalQuestionBank, hash_json},
    error::{AppError, AppResult},
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

pub struct Store {
    pub user: Connection,
    pub bank: LocalQuestionBank,
    pub data_dir: PathBuf,
    pub bank_warning: Option<String>,
}

fn text(value: &str, max: usize, required: bool, label: &str) -> AppResult<String> {
    if value.chars().any(char::is_control) {
        return Err(AppError::new(
            "invalid_input",
            format!("{}不能包含控制字符。", label),
        ));
    }
    let value = value.trim();
    if (required && value.is_empty()) || value.chars().count() > max {
        return Err(AppError::new(
            "invalid_input",
            format!("{}需为 1–{} 个字符。", label, max),
        ));
    }
    Ok(value.to_owned())
}

fn identity(kind: &str, id: &str) -> AppResult<()> {
    if kind.is_empty()
        || kind.len() > 40
        || !kind
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        || id.is_empty()
        || id.len() > 250
        || id.chars().any(char::is_control)
    {
        return Err(AppError::new("invalid_document", "记录标识无效。"));
    }
    Ok(())
}
fn student_notes(input: &Value) -> AppResult<String> {
    match input.get("notes") {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(value))
            if value.chars().count() <= 2000
                && !value
                    .chars()
                    .any(|c| c.is_control() && !matches!(c, '\n' | '\t')) =>
        {
            Ok(value.trim().to_owned())
        }
        _ => Err(AppError::new(
            "invalid_student",
            "基础备注最多2000字，不支持无效控制字符。",
        )),
    }
}

impl Store {
    pub fn open(data_dir: &Path, seed: &Value) -> AppResult<Self> {
        let manifest = crate::bank_annotations::bundled_for_seed(seed)?;
        let mut store = Self::open_with_annotation_manifest(data_dir, seed, manifest.as_ref())?;
        if store.bank_warning.is_none()
            && let Err(cause) = crate::bank_supplement::apply_bundled(&store.bank, seed)
        {
            let warning = format!(
                "内置题目补充未完成：{} 当前题库、个人记录与原试卷均已保留。",
                cause.message
            );
            store.bank_warning = Some(match store.bank_warning {
                Some(previous) => format!("{previous} {warning}"),
                None => warning,
            });
        }
        if store.bank_warning.is_none()
            && let Err(cause) = crate::bank_teaching::normalize_focus(&store.bank)
        {
            store.bank_warning = Some(format!(
                "教学信息字段升级未完成：{} 当前题库、个人记录与原试卷均已保留。",
                cause.message
            ));
        }
        Ok(store)
    }
    pub fn open_with_annotation_manifest(
        data_dir: &Path,
        seed: &Value,
        manifest: Option<&Value>,
    ) -> AppResult<Self> {
        std::fs::create_dir_all(data_dir)?;
        let user = Connection::open(data_dir.join("personal.sqlite"))?;
        user.busy_timeout(Duration::from_secs(5))?;
        user.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS local_profile(singleton INTEGER PRIMARY KEY CHECK(singleton=1),nickname TEXT NOT NULL,default_subject TEXT NOT NULL CHECK(default_subject='math'));
            CREATE TABLE IF NOT EXISTS students(student_id TEXT PRIMARY KEY,name TEXT NOT NULL,grade TEXT,operation_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,created_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS documents(kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),PRIMARY KEY(kind,id));
            CREATE TABLE IF NOT EXISTS history_deletions(kind TEXT NOT NULL CHECK(kind IN ('drafts','papers')),id TEXT NOT NULL,operation_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,deleted_at TEXT NOT NULL,PRIMARY KEY(kind,id),FOREIGN KEY(kind,id) REFERENCES documents(kind,id));
            CREATE UNIQUE INDEX IF NOT EXISTS one_paper_per_draft ON documents(json_extract(payload,'$.sourceDraftId')) WHERE kind='papers';
            CREATE INDEX IF NOT EXISTS imports_created_history ON documents(kind,COALESCE(CAST(json_extract(payload,'$.createdAt') AS TEXT), '') DESC,id DESC) WHERE kind='imports';
            CREATE TRIGGER IF NOT EXISTS frozen_paper_update BEFORE UPDATE ON documents WHEN OLD.kind='papers' BEGIN SELECT RAISE(ABORT,'immutable_paper'); END;
            CREATE TRIGGER IF NOT EXISTS frozen_paper_delete BEFORE DELETE ON documents WHEN OLD.kind='papers' BEGIN SELECT RAISE(ABORT,'immutable_paper'); END;")?;
        let student_migration =
            rusqlite::Transaction::new_unchecked(&user, TransactionBehavior::Immediate)?;
        let columns = {
            let mut statement = user.prepare("PRAGMA table_info(students)")?;
            statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()?
        };
        for (name, definition) in [
            ("notes", "TEXT"),
            ("revision", "INTEGER NOT NULL DEFAULT 0"),
            ("updated_at", "TEXT"),
        ] {
            if !columns.iter().any(|column| column == name) {
                user.execute_batch(&format!(
                    "ALTER TABLE students ADD COLUMN {name} {definition}"
                ))?;
            }
        }
        user.execute_batch("CREATE TABLE IF NOT EXISTS student_mutations(operation_id TEXT PRIMARY KEY,student_id TEXT NOT NULL,request_hash TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)))")?;
        student_migration.commit()?;
        let bank_path = data_dir.join("question-bank.sqlite");
        let (bank, mut bank_warning) = match LocalQuestionBank::open(&bank_path, seed) {
            Ok(bank) => (bank, None),
            Err(cause) if cause.code == "bank_migration_conflict" => {
                // Migration already rolled back. Keep the last working local bank
                // available so a conflict cannot lock the teacher out of papers.
                let mut previous = seed.clone();
                previous.as_object_mut().unwrap().remove("migration");
                previous.as_object_mut().unwrap().remove("bankSnapshot");
                (
                    LocalQuestionBank::open(&bank_path, &previous)?,
                    Some(format!(
                        "题库升级未完成：{} 当前继续使用已有题库，个人记录和试卷已保留。",
                        cause.message
                    )),
                )
            }
            Err(cause) => return Err(cause),
        };
        if let Some(manifest) = manifest {
            if let Err(cause) = crate::bank_annotations::apply(&bank, manifest) {
                let warning = format!(
                    "题目标注升级未完成：{} 当前题库、个人记录与原试卷均已保留。",
                    cause.message
                );
                bank_warning = Some(match bank_warning {
                    Some(previous) => format!("{previous} {warning}"),
                    None => warning,
                });
            }
        }
        Ok(Self {
            user,
            bank,
            data_dir: data_dir.to_path_buf(),
            bank_warning,
        })
    }

    pub fn profile(&self) -> AppResult<Option<Value>> {
        let row: Option<(String, String)> = self
            .user
            .query_row(
                "SELECT nickname,default_subject FROM local_profile WHERE singleton=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        row.map(|(nickname, subject)| {
            let nickname = text(&nickname, 40, true, "昵称")?;
            if subject != "math" {
                return Err(AppError::new("integrity_error", "本地学科设置无效。"));
            }
            Ok(json!({"nickname":nickname,"defaultSubject":subject}))
        })
        .transpose()
    }

    pub fn save_profile(&self, nickname: &str, subject: &str) -> AppResult<Value> {
        let nickname = text(nickname, 40, true, "昵称")?;
        if subject != "math" {
            return Err(AppError::new("unsupported_subject", "目前仅支持数学。"));
        }
        self.user.execute("INSERT INTO local_profile(singleton,nickname,default_subject) VALUES(1,?1,?2) ON CONFLICT(singleton) DO UPDATE SET nickname=excluded.nickname,default_subject=excluded.default_subject", params![nickname, subject])?;
        Ok(json!({"nickname":nickname,"defaultSubject":subject}))
    }

    pub fn students(&self, query: &str) -> AppResult<Vec<Value>> {
        let query = text(query, 40, false, "搜索内容")?.to_lowercase();
        let mut statement = self.user.prepare("SELECT student_id,name,grade,notes,revision,updated_at FROM students WHERE instr(lower(name),?1)>0 OR instr(lower(coalesce(grade,'')),?1)>0 ORDER BY created_at,student_id LIMIT 200")?;
        let rows = statement.query_map([query], |row| Ok(json!({"studentId":row.get::<_,String>(0)?,"name":row.get::<_,String>(1)?,"grade":row.get::<_,Option<String>>(2)?,"notes":row.get::<_,Option<String>>(3)?.unwrap_or_default(),"revision":row.get::<_,i64>(4)?,"updatedAt":row.get::<_,Option<String>>(5)?})))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn student(&self, id: &str) -> AppResult<Value> {
        self.user.query_row("SELECT student_id,name,grade,notes,revision,updated_at FROM students WHERE student_id=?1", [id], |row| Ok(json!({"studentId":row.get::<_,String>(0)?,"name":row.get::<_,String>(1)?,"grade":row.get::<_,Option<String>>(2)?,"notes":row.get::<_,Option<String>>(3)?.unwrap_or_default(),"revision":row.get::<_,i64>(4)?,"updatedAt":row.get::<_,Option<String>>(5)?}))).optional()?
            .ok_or_else(|| AppError::new("not_found", "没有找到该学生。"))
    }

    pub fn create_student(&self, input: &Value) -> AppResult<Value> {
        let object = input
            .as_object()
            .ok_or_else(|| AppError::new("invalid_student", "学生信息格式无效。"))?;
        if object
            .keys()
            .any(|key| !matches!(key.as_str(), "name" | "grade" | "notes" | "operationId"))
        {
            return Err(AppError::new(
                "invalid_student",
                "仅支持姓名、年级和操作标识。",
            ));
        }
        let name = text(
            input["name"]
                .as_str()
                .ok_or_else(|| AppError::new("invalid_student", "请输入姓名或昵称。"))?,
            40,
            true,
            "姓名或昵称",
        )?;
        let grade = match input.get("grade") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) => {
                let grade = text(value, 20, false, "年级")?;
                if grade.is_empty() { None } else { Some(grade) }
            }
            _ => return Err(AppError::new("invalid_student", "年级格式无效。")),
        };
        let operation = input["operationId"].as_str().unwrap_or_default();
        if operation.is_empty()
            || operation.len() > 100
            || !operation
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err(AppError::new(
                "invalid_operation",
                "缺少有效的操作标识，请重试。",
            ));
        }
        let request_hash = hash_json(&json!({"name":name,"grade":grade}));
        let notes = student_notes(input)?;
        let request_hash = if input.get("notes").is_some() {
            hash_json(&json!({"name":name,"grade":grade,"notes":notes}))
        } else {
            request_hash
        };
        let transaction = self.user.unchecked_transaction()?;
        let previous: Option<(String, String)> = transaction
            .query_row(
                "SELECT student_id,request_hash FROM students WHERE operation_id=?1",
                [operation],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((id, hash)) = previous {
            if hash != request_hash {
                return Err(AppError::new(
                    "operation_conflict",
                    "该操作已用于其他学生信息，请重新提交。",
                ));
            }
            transaction.commit()?;
            return self.student(&id);
        }
        let id = uuid::Uuid::new_v4().to_string();
        transaction.execute("INSERT INTO students(student_id,name,grade,operation_id,request_hash,created_at,notes) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![id, name, grade, operation, request_hash, chrono::Utc::now().to_rfc3339(),notes])?;
        transaction.commit()?;
        self.student(&id)
    }

    pub fn update_student(&self, input: &Value) -> AppResult<Value> {
        let id = input["studentId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| AppError::new("invalid_student", "请选择学生。"))?;
        let name = text(
            input["name"].as_str().unwrap_or_default(),
            40,
            true,
            "姓名或昵称",
        )?;
        let grade = match input.get("grade") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) => {
                let value = text(value, 20, false, "年级")?;
                if value.is_empty() { None } else { Some(value) }
            }
            _ => return Err(AppError::new("invalid_student", "年级格式无效。")),
        };
        let notes = student_notes(input)?;
        let operation = input["operationId"].as_str().unwrap_or_default();
        if operation.is_empty()
            || operation.len() > 100
            || !operation
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        {
            return Err(AppError::new("invalid_operation", "缺少有效操作标识。"));
        }
        let hash = hash_json(input);
        let transaction =
            rusqlite::Transaction::new_unchecked(&self.user, TransactionBehavior::Immediate)?;
        let previous: Option<(String, String)> = transaction
            .query_row(
                "SELECT request_hash,payload FROM student_mutations WHERE operation_id=?1",
                [operation],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((previous_hash, payload)) = previous {
            if previous_hash != hash {
                return Err(AppError::new(
                    "operation_conflict",
                    "此操作已用于其他学生修改。",
                ));
            }
            let value = serde_json::from_str(&payload)?;
            transaction.commit()?;
            return Ok(value);
        }
        let current = self.student(id)?;
        if current["revision"].as_u64() != input["expectedRevision"].as_u64() {
            return Err(AppError::new(
                "revision_conflict",
                "学生信息已更新，请重新打开后修改。",
            ));
        }
        let next = current["revision"]
            .as_i64()
            .and_then(|v| v.checked_add(1))
            .ok_or_else(|| AppError::new("invalid_student", "学生修订号无效。"))?;
        let updated = chrono::Utc::now().to_rfc3339();
        transaction.execute("UPDATE students SET name=?1,grade=?2,notes=?3,revision=?4,updated_at=?5 WHERE student_id=?6",params![name,grade,notes,next,updated,id])?;
        let result = self.student(id)?;
        transaction.execute("INSERT INTO student_mutations(operation_id,student_id,request_hash,payload) VALUES(?1,?2,?3,?4)",params![operation,id,hash,result.to_string()])?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn list_documents(&self, kind: &str) -> AppResult<Vec<Value>> {
        identity(kind, "list")?;
        // Updating a draft never moves it in the history list.
        let mut statement = self.user.prepare("SELECT d.payload FROM documents d WHERE d.kind=?1 AND NOT EXISTS(SELECT 1 FROM history_deletions h WHERE h.kind=d.kind AND h.id=d.id) ORDER BY coalesce(json_extract(d.payload,'$.createdAt'),'') DESC,d.rowid DESC")?;
        let rows = statement.query_map([kind], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }

    pub fn document(&self, kind: &str, id: &str) -> AppResult<Value> {
        identity(kind, id)?;
        let payload: Option<String> = self
            .user
            .query_row(
                "SELECT d.payload FROM documents d WHERE d.kind=?1 AND d.id=?2 AND NOT EXISTS(SELECT 1 FROM history_deletions h WHERE h.kind=d.kind AND h.id=d.id)",
                params![kind, id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(serde_json::from_str(&payload.ok_or_else(|| {
            AppError::new("not_found", "没有找到该记录。")
        })?)?)
    }

    pub fn put_document(&self, kind: &str, id: &str, value: &Value) -> AppResult<()> {
        identity(kind, id)?;
        let deleted: bool = self.user.query_row(
            "SELECT EXISTS(SELECT 1 FROM history_deletions WHERE kind=?1 AND id=?2)",
            params![kind, id],
            |row| row.get(0),
        )?;
        if deleted {
            return Err(AppError::new(
                "not_found",
                "该记录已删除，不能继续修改或恢复。",
            ));
        }
        if !value.is_object() {
            return Err(AppError::new("invalid_document", "记录内容格式无效。"));
        }
        if kind == "papers" {
            if value["paperId"] != id || value["sourceDraftId"].as_str().is_none_or(str::is_empty) {
                return Err(AppError::new(
                    "invalid_document",
                    "成卷身份或来源草稿无效。",
                ));
            }
            let existing: Option<String> = self
                .user
                .query_row(
                    "SELECT payload FROM documents WHERE kind='papers' AND id=?1",
                    [id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(existing) = existing {
                if serde_json::from_str::<Value>(&existing)? == *value {
                    return Ok(());
                }
                return Err(AppError::new(
                    "immutable_paper",
                    "已确认试卷不可修改，请继续编辑为新草稿。",
                ));
            }
            let source = value["sourceDraftId"].as_str().unwrap();
            let previous: Option<String> = self.user.query_row("SELECT id FROM documents WHERE kind='papers' AND json_extract(payload,'$.sourceDraftId')=?1", [source], |row| row.get(0)).optional()?;
            if previous.is_some() {
                return Err(AppError::new("paper_exists", "该草稿已经确认成卷。"));
            }
        }
        self.user.execute("INSERT INTO documents(kind,id,payload) VALUES(?1,?2,?3) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload", params![kind,id,serde_json::to_string(value)?])?;
        Ok(())
    }

    /// Hide a history item without changing its frozen content or output files.
    /// The tombstone also prevents stable creation/confirmation retries from
    /// recreating a deleted document under its original identity.
    pub fn delete_history(&mut self, input: &Value) -> AppResult<Value> {
        let object = input
            .as_object()
            .ok_or_else(|| AppError::new("invalid_input", "删除参数格式无效。"))?;
        if object.keys().any(|key| {
            !matches!(
                key.as_str(),
                "kind" | "id" | "operationId" | "expectedRevision"
            )
        }) {
            return Err(AppError::new("invalid_input", "删除参数包含不支持的字段。"));
        }
        let public_kind = input["kind"].as_str().unwrap_or_default();
        let kind = match public_kind {
            "draft" => "drafts",
            "paper" => "papers",
            _ => return Err(AppError::new("invalid_input", "只能删除草稿或试卷。")),
        };
        let id = input["id"].as_str().unwrap_or_default();
        identity(kind, id)?;
        let operation = input["operationId"].as_str().unwrap_or_default();
        if operation.is_empty()
            || operation.len() > 100
            || !operation
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(AppError::new(
                "invalid_operation",
                "缺少有效的删除操作标识，请重试。",
            ));
        }
        let expected_revision = if kind == "drafts" {
            Some(
                input["expectedRevision"]
                    .as_u64()
                    .ok_or_else(|| AppError::new("invalid_input", "删除草稿需要提供当前修订。"))?,
            )
        } else {
            if input.get("expectedRevision").is_some() {
                return Err(AppError::new(
                    "invalid_input",
                    "已确认试卷不接受草稿修订参数。",
                ));
            }
            None
        };
        let request_hash = hash_json(input);
        let transaction = self
            .user
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous: Option<(String, String)> = transaction
            .query_row(
                "SELECT request_hash,deleted_at FROM history_deletions WHERE operation_id=?1",
                [operation],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((previous_hash, deleted_at)) = previous {
            if previous_hash != request_hash {
                return Err(AppError::new(
                    "operation_conflict",
                    "同一删除操作已用于其他记录或修订。",
                ));
            }
            transaction.commit()?;
            return Ok(
                json!({"deleted":true,"kind":public_kind,"id":id,"deletedAt":deleted_at,"replayed":true}),
            );
        }
        let serialized: Option<String> = transaction.query_row(
            "SELECT d.payload FROM documents d WHERE d.kind=?1 AND d.id=?2 AND NOT EXISTS(SELECT 1 FROM history_deletions h WHERE h.kind=d.kind AND h.id=d.id)",
            params![kind, id],
            |row| row.get(0),
        ).optional()?;
        let document: Value =
            serde_json::from_str(&serialized.ok_or_else(|| {
                AppError::new("not_found", "没有找到该记录，或该记录已经删除。")
            })?)?;
        if kind == "drafts" && document["revision"].as_u64() != expected_revision {
            return Err(AppError::new(
                "revision_conflict",
                "草稿已更新，请重新读取后再删除。",
            ));
        }
        let deleted_at = chrono::Utc::now().to_rfc3339();
        transaction.execute(
            "INSERT INTO history_deletions(kind,id,operation_id,request_hash,deleted_at) VALUES(?1,?2,?3,?4,?5)",
            params![kind, id, operation, request_hash, deleted_at],
        )?;
        transaction.commit()?;
        Ok(
            json!({"deleted":true,"kind":public_kind,"id":id,"deletedAt":deleted_at,"replayed":false}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bank::BankRepository;
    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), &crate::bank::tests::seed()).unwrap();
        (dir, store)
    }
    #[test]
    fn starts_blank_and_profile_validation_persists_without_auth_tables() {
        let (dir, store) = store();
        assert!(store.profile().unwrap().is_none());
        assert!(store.save_profile(" \n", "math").is_err());
        assert!(store.save_profile(&"好".repeat(41), "math").is_err());
        assert!(store.save_profile("昵称", "english").is_err());
        assert_eq!(
            store.save_profile("  教师  ", "math").unwrap()["nickname"],
            "教师"
        );
        assert_eq!(
            store
                .user
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE name IN ('users','auth_sessions')",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        drop(store);
        let store = Store::open(dir.path(), &json!(null)).unwrap();
        assert_eq!(store.profile().unwrap().unwrap()["nickname"], "教师");
        assert!(dir.path().join("personal.sqlite").exists());
        assert!(dir.path().join("question-bank.sqlite").exists());
    }
    #[test]
    fn create_student_replay_conflict_and_search() {
        let (_dir, store) = store();
        let input = json!({"name":" 张同学 ","grade":" 高一 ","operationId":"simulation-1"});
        let first = store.create_student(&input).unwrap();
        assert_eq!(first, store.create_student(&input).unwrap());
        assert!(
            store
                .create_student(&json!({"name":"另一位","operationId":"simulation-1"}))
                .is_err()
        );
        assert_eq!(store.students("高一").unwrap(), vec![first]);
        assert!(store.students("不存在").unwrap().is_empty());
        assert!(
            store
                .create_student(&json!({"name":"","operationId":"simulation-2"}))
                .is_err()
        );
    }
    #[test]
    fn frozen_documents_unique_source_and_transaction_rollback() {
        let (_dir, store) = store();
        let paper = json!({"paperId":"paper-1","sourceDraftId":"draft-1","createdAt":"2026-01-01"});
        store.put_document("papers", "paper-1", &paper).unwrap();
        store.put_document("papers", "paper-1", &paper).unwrap();
        assert!(
            store
                .put_document(
                    "papers",
                    "paper-1",
                    &json!({"paperId":"paper-1","sourceDraftId":"draft-1","title":"changed"})
                )
                .is_err()
        );
        assert!(
            store
                .put_document(
                    "papers",
                    "paper-2",
                    &json!({"paperId":"paper-2","sourceDraftId":"draft-1"})
                )
                .is_err()
        );
        assert!(
            store
                .user
                .execute("DELETE FROM documents WHERE kind='papers'", [])
                .is_err()
        );
        store.user.execute_batch("BEGIN IMMEDIATE").unwrap();
        store
            .put_document("drafts", "draft-2", &json!({"draftId":"draft-2"}))
            .unwrap();
        store.user.execute_batch("ROLLBACK").unwrap();
        assert!(store.document("drafts", "draft-2").is_err());
    }
    #[test]
    fn history_order_tracks_creation_not_last_edit() {
        let (_dir, store) = store();
        store
            .put_document(
                "drafts",
                "first",
                &json!({"createdAt":"2026-01-01","title":"a"}),
            )
            .unwrap();
        store
            .put_document(
                "drafts",
                "second",
                &json!({"createdAt":"2026-01-02","title":"b"}),
            )
            .unwrap();
        store
            .put_document(
                "drafts",
                "first",
                &json!({"createdAt":"2026-01-01","title":"changed"}),
            )
            .unwrap();
        assert_eq!(store.list_documents("drafts").unwrap()[0]["title"], "b");
    }

    #[test]
    fn simulated_history_deletion_persists_without_changing_documents_or_pdf_files() {
        let (dir, mut store) = store();
        let student = store
            .create_student(&json!({"name":"模拟学生","operationId":"deletion-student"}))
            .unwrap();
        let draft =
            json!({"draftId":"source-draft","revision":4,"title":"模拟源草稿","student":student});
        let unrelated = json!({"draftId":"unrelated","revision":0,"title":"模拟保留草稿"});
        let paper = json!({"paperId":"frozen-paper","sourceDraftId":"source-draft","draft":draft});
        store
            .put_document("drafts", "source-draft", &draft)
            .unwrap();
        store
            .put_document("drafts", "unrelated", &unrelated)
            .unwrap();
        store
            .put_document("papers", "frozen-paper", &paper)
            .unwrap();
        let output_path = dir.path().join("simulated-existing.pdf");
        std::fs::write(&output_path, b"simulated-existing-pdf-bytes").unwrap();
        let output = json!({"paperId":"frozen-paper","archivedPath":output_path,"kind":"student"});
        store
            .put_document("outputs", "existing-output", &output)
            .unwrap();
        let bank_count = store.bank.questions().unwrap().len();
        let input = json!({"kind":"draft","id":"source-draft","operationId":"delete-source","expectedRevision":4});
        let deleted = store.delete_history(&input).unwrap();
        assert_eq!(deleted["deleted"], true);
        assert_eq!(deleted["replayed"], false);
        assert_eq!(
            store.document("drafts", "source-draft").unwrap_err().code,
            "not_found"
        );
        assert_eq!(
            store
                .put_document("drafts", "source-draft", &draft)
                .unwrap_err()
                .code,
            "not_found"
        );
        assert_eq!(
            store.list_documents("drafts").unwrap(),
            vec![unrelated.clone()]
        );
        assert_eq!(store.document("papers", "frozen-paper").unwrap(), paper);
        drop(store);
        let mut store = Store::open(dir.path(), &json!(null)).unwrap();
        let replay = store.delete_history(&input).unwrap();
        assert_eq!(replay["replayed"], true);
        assert_eq!(replay["deletedAt"], deleted["deletedAt"]);
        store
            .delete_history(
                &json!({"kind":"paper","id":"frozen-paper","operationId":"delete-paper"}),
            )
            .unwrap();
        assert!(store.list_documents("papers").unwrap().is_empty());
        assert_eq!(
            store.document("papers", "frozen-paper").unwrap_err().code,
            "not_found"
        );
        assert_eq!(
            store
                .put_document("papers", "frozen-paper", &paper)
                .unwrap_err()
                .code,
            "not_found"
        );
        for (kind, id, expected) in [
            ("drafts", "source-draft", &draft),
            ("papers", "frozen-paper", &paper),
        ] {
            let serialized: String = store
                .user
                .query_row(
                    "SELECT payload FROM documents WHERE kind=?1 AND id=?2",
                    params![kind, id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&serialized).unwrap(),
                *expected
            );
        }
        assert!(
            store
                .user
                .execute("DELETE FROM documents WHERE kind='papers'", [])
                .is_err()
        );
        assert!(
            store
                .user
                .execute("UPDATE documents SET payload='{}' WHERE kind='papers'", [])
                .is_err()
        );
        assert_eq!(
            std::fs::read(output_path).unwrap(),
            b"simulated-existing-pdf-bytes"
        );
        assert_eq!(
            store.document("outputs", "existing-output").unwrap(),
            output
        );
        assert_eq!(store.document("drafts", "unrelated").unwrap(), unrelated);
        assert_eq!(
            store
                .student(student["studentId"].as_str().unwrap())
                .unwrap(),
            student
        );
        assert_eq!(store.bank.questions().unwrap().len(), bank_count);
    }

    #[test]
    fn simulated_history_deletion_validates_kind_identity_revision_and_retry_conflicts() {
        let (_dir, mut store) = store();
        store
            .put_document(
                "drafts",
                "draft-1",
                &json!({"draftId":"draft-1","revision":2}),
            )
            .unwrap();
        store
            .put_document(
                "drafts",
                "draft-2",
                &json!({"draftId":"draft-2","revision":0}),
            )
            .unwrap();
        let input =
            json!({"kind":"draft","id":"draft-1","operationId":"delete-case","expectedRevision":2});
        for bad in [
            json!({"kind":"students","id":"draft-1","operationId":"bad-kind"}),
            json!({"kind":"draft","id":"","operationId":"bad-id","expectedRevision":2}),
            json!({"kind":"draft","id":"draft-1","expectedRevision":2}),
            json!({"kind":"draft","id":"draft-1","operationId":"bad operation","expectedRevision":2}),
            json!({"kind":"draft","id":"draft-1","operationId":"no-revision"}),
            json!({"kind":"draft","id":"draft-1","operationId":"negative","expectedRevision":-1}),
            json!({"kind":"draft","id":"draft-1","operationId":"string","expectedRevision":"2"}),
            json!({"kind":"draft","id":"draft-1","operationId":"extra","expectedRevision":2,"deleteAll":true}),
            json!({"kind":"paper","id":"paper-1","operationId":"paper-revision","expectedRevision":0}),
        ] {
            assert!(store.delete_history(&bad).is_err(), "accepted {bad}");
        }
        let mut stale = input.clone();
        stale["expectedRevision"] = json!(1);
        assert_eq!(
            store.delete_history(&stale).unwrap_err().code,
            "revision_conflict"
        );
        let mut missing = input.clone();
        missing["id"] = json!("missing");
        assert_eq!(
            store.delete_history(&missing).unwrap_err().code,
            "not_found"
        );
        assert_eq!(store.list_documents("drafts").unwrap().len(), 2);
        store.delete_history(&input).unwrap();
        assert_eq!(
            store.delete_history(&stale).unwrap_err().code,
            "operation_conflict"
        );
        let mut conflicting = input.clone();
        conflicting["id"] = json!("draft-2");
        conflicting["expectedRevision"] = json!(0);
        assert_eq!(
            store.delete_history(&conflicting).unwrap_err().code,
            "operation_conflict"
        );
        let mut different_operation = input.clone();
        different_operation["operationId"] = json!("already-deleted");
        assert_eq!(
            store.delete_history(&different_operation).unwrap_err().code,
            "not_found"
        );
        assert!(store.document("drafts", "draft-2").is_ok());
    }

    #[test]
    fn simulated_history_deletion_write_failure_rolls_back_and_allows_same_operation_retry() {
        let (_dir, mut store) = store();
        store
            .put_document("drafts", "draft", &json!({"draftId":"draft","revision":0}))
            .unwrap();
        let input = json!({"kind":"draft","id":"draft","operationId":"retry-after-failure","expectedRevision":0});
        store.user.execute_batch("CREATE TRIGGER simulated_delete_failure BEFORE INSERT ON history_deletions BEGIN SELECT RAISE(ABORT,'simulated_full_disk'); END;").unwrap();
        assert_eq!(
            store.delete_history(&input).unwrap_err().code,
            "storage_error"
        );
        assert_eq!(store.list_documents("drafts").unwrap().len(), 1);
        assert!(store.document("drafts", "draft").is_ok());
        assert!(store.user.is_autocommit());
        store
            .user
            .execute_batch("DROP TRIGGER simulated_delete_failure;")
            .unwrap();
        assert_eq!(store.delete_history(&input).unwrap()["replayed"], false);
        assert_eq!(store.delete_history(&input).unwrap()["replayed"], true);
    }
}
