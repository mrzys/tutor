//! Bounded local assembly diagnostics: safe metadata by default; explicit
//! developer mode additionally captures redacted request/response bodies.
//! This independent database never takes the assembly runtime mutex.
use crate::error::{AppError, AppResult};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const MAX_TRACES: usize = 40;
const MAX_PER_TRACE: usize = 500;
const MAX_EVENTS: usize = 5000;
const MAX_BODY: usize = 4 * 1024 * 1024;
const MAX_TRACE_BODIES: usize = 32 * 1024 * 1024;
const MAX_BODIES: usize = 128 * 1024 * 1024;
const ACTIONS: &[&str] = &[
    "intake_prepare",
    "blueprint_plan",
    "blueprint_check",
    "draft_create",
    "manual_draft_create",
    "draft_get",
    "draft_operation",
    "draft_candidates",
    "paper_confirmation",
    "paper_confirm",
    "paper_get",
    "paper_derive",
    "pdf_export",
    "pdf_read",
    "feedback_save",
    "history_delete",
];
const STEPS: &[&str] = &[
    "scope",
    "supply",
    "requirements",
    "plan_supply",
    "plan_slots",
    "plan_check",
    "select_pool",
    "select_evaluate",
    "select_save",
];
const UI_EVENTS: &[&str] = &[
    "preview_open",
    "preview_close",
    "preview_kind_change",
    "pdf_preview_open",
    "new_assembly",
    "history_open",
    "retry",
    "cancel",
];

pub fn developer_enabled_from(debug: bool, flag: bool, environment: Option<&str>) -> bool {
    environment != Some("0") && (debug || flag || environment == Some("1"))
}
const DEVELOPER_SETTINGS: &str = "developer-settings.json";
// Only serializes short diagnostic writes and the local switch, never model
// execution or the assembly mutex. A completed disable cannot race a body write.
static DEVELOPER_MODE_WRITE: Mutex<()> = Mutex::new(());
fn local_developer_mode(directory: &Path) -> AppResult<Option<bool>> {
    let path = directory.join(DEVELOPER_SETTINGS);
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file() || metadata.len() > 4096 {
        return Err(AppError::new("invalid_data", "开发者设置文件无效，请修复后重试。"));
    }
    let setting: Value = serde_json::from_slice(&std::fs::read(path)?)?;
    if setting["schemaVersion"] != 1 || !setting["enabled"].is_boolean()
        || setting.as_object().is_none_or(|object| object.len() != 2)
    {
        return Err(AppError::new("invalid_data", "开发者设置文件无效，请修复后重试。"));
    }
    Ok(setting["enabled"].as_bool())
}
fn mode_capabilities(directory: &Path, debug: bool, flag: bool, environment: Option<&str>) -> AppResult<Value> {
    let forced = matches!(environment, Some("0" | "1")) || flag;
    let persisted = if forced { local_developer_mode(directory).unwrap_or(None) } else { local_developer_mode(directory)? };
    let (enabled, source, configurable) = if environment == Some("0") {
        (false, "environment_off", false)
    } else if environment == Some("1") {
        (true, "environment_on", false)
    } else if flag {
        (true, "command_line", false)
    } else if let Some(enabled) = persisted {
        (enabled, "local", true)
    } else {
        (debug, if debug { "debug" } else { "default" }, true)
    };
    Ok(json!({"enabled":enabled,"recording":true,"captureDetails":enabled,"configurable":configurable,"source":source,"persistedEnabled":persisted}))
}
fn current_mode(directory: &Path) -> AppResult<Value> {
    mode_capabilities(directory, cfg!(debug_assertions), std::env::args_os().any(|arg| arg == "--developer"), std::env::var("TUTOR_DEVELOPER_MODE").ok().as_deref())
}
pub fn developer_enabled(directory: &Path) -> bool {
    current_mode(directory).is_ok_and(|mode| mode["enabled"] == true)
}
fn save_developer_mode(directory: &Path, enabled: bool) -> AppResult<()> {
    use std::io::Write;
    std::fs::create_dir_all(directory)?;
    let temporary = directory.join(format!(".developer-settings-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> AppResult<()> {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        file.write_all(json!({"schemaVersion":1,"enabled":enabled}).to_string().as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&temporary, directory.join(DEVELOPER_SETTINGS))?;
        Ok(())
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temporary); }
    result
}
pub fn is_developer_action(action: &str) -> bool {
    matches!(
        action,
        "developer_log_capabilities"
            | "developer_mode_set"
            | "developer_assembly_logs"
            | "developer_assembly_log_detail"
            | "developer_assembly_event"
    )
}
pub fn is_assembly_action(action: &str) -> bool {
    ACTIONS.contains(&action)
}
pub fn trace_id(payload: &Value) -> Option<String> {
    payload["assemblyTraceId"].as_str().and_then(valid_trace)
}
fn valid_trace(value: &str) -> Option<String> {
    uuid::Uuid::parse_str(value).ok().map(|id| id.to_string())
}
fn valid_entity_id(value: &str) -> Option<&str> {
    uuid::Uuid::parse_str(value).is_ok().then_some(value)
}
fn error_code(code: &str) -> &str {
    match code {
        "cancelled"
        | "invalid_request"
        | "invalid_input"
        | "invalid_plan"
        | "invalid_data"
        | "nickname_required"
        | "not_configured"
        | "rule_retired"
        | "model_error"
        | "model_catalog_error"
        | "model_request_timeout"
        | "model_response_timeout"
        | "model_output_truncated"
        | "model_output_empty"
        | "source_image_format"
        | "source_image_limit"
        | "storage_error"
        | "storage_busy"
        | "integrity_error"
        | "not_found"
        | "revision_conflict"
        | "operation_conflict"
        | "version_conflict"
        | "confirmation_required"
        | "finalized_draft"
        | "unknown_action"
        | "busy"
        | "pdf_failed"
        | "unsupported_platform"
        | "invalid_path"
        | "internal_error" => code,
        _ => "other",
    }
}
// Never copy a free-form string, object, array or unknown numeric key.
fn safe_details(value: &Value) -> Value {
    let mut output = json!({});
    for key in [
        "questionCount",
        "selectedCount",
        "missingCount",
        "slotCount",
        "scopeCount",
        "candidateCount",
        "requestBytes",
        "batchIndex",
        "batchCount",
        "roundIndex",
        "poolCount",
        "presentedCount",
        "assessedCount",
        "points",
        "promptTokens",
        "completionTokens",
        "reasoningTokens",
        "totalTokens",
        "maxBudget",
        "httpStatus",
    ] {
        if let Some(number) = value[key].as_u64().filter(|n| *n <= 1_000_000_000) {
            output[key] = json!(number);
        }
    }
    for (key, allowed) in [
        ("kind", &["student", "teacher"][..]),
        ("mode", &["rule", "llm", "manual"][..]),
        (
            "operation",
            &[
                "replace",
                "criteria",
                "lock",
                "unlock",
                "points",
                "delete",
                "add",
                "reorder",
                "title",
                    "rename",
                "score",
                "difficulty",
                "goals",
                "edit",
                "batch_replace",
                "batch_lock",
                "move",
            ][..],
        ),
        ("provider", &["deepseek", "bailian", "xiaomi", "qianwenai", "custom"][..]),
        (
            "task",
            &[
                "intake",
                "intake_scope",
                "blueprint",
                "selection",
                "coverage",
            ][..],
        ),
        (
            "finishReason",
            &[
                "stop",
                "length",
                "content_filter",
                "tool_calls",
                "function_call",
                "unknown",
            ][..],
        ),
    ] {
        if let Some(text) = value[key].as_str().filter(|text| allowed.contains(text)) {
            output[key] = json!(text);
        }
    }
    if let Some(model) = value["model"].as_str() {
        let presets: Value =
            serde_json::from_str(include_str!("../../resources/llm-providers.json"))
                .unwrap_or_default();
        let known = presets["providers"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|p| p["models"].as_array().into_iter().flatten())
            .any(|m| m["id"] == model);
        output["model"] = json!(if known { model } else { "custom" });
    }
    if let Some(code) = value["errorCode"].as_str() {
        output["errorCode"] = json!(error_code(code));
    }
    for key in ["retry", "cancelled", "searchIncomplete"] {
        if let Some(flag) = value[key].as_bool() {
            output[key] = json!(flag);
        }
    }
    for key in ["documentId", "draftId", "paperId"] {
        if let Some(id) = value[key].as_str().and_then(valid_entity_id) {
            output[key] = json!(id);
        }
    }
    output
}

fn redact(value: &Value, secrets: &[String]) -> Value {
    match value {
        Value::Object(object) => {
            let question = object.contains_key("questionId")
                || (object.contains_key("questionType") && object.contains_key("student"));
            let mut safe = serde_json::Map::new();
            for (key, value) in object {
                let lower = key.to_ascii_lowercase().replace(['_', '-'], "");
                if matches!(
                    lower.as_str(),
                    "apikey"
                        | "protectedkey"
                        | "authorization"
                        | "headers"
                        | "token"
                        | "accesstoken"
                        | "refreshtoken"
                        | "password"
                        | "secret"
                        | "secretkey"
                        | "clientsecret"
                        | "privatekey"
                        | "studentid"
                        | "studentids"
                        | "students"
                        | "nickname"
                        | "studentname"
                ) || (lower == "student" && !question)
                {
                    continue;
                }
                safe.insert(key.clone(), redact(value, secrets));
            }
            Value::Object(safe)
        }
        Value::Array(values) => {
            Value::Array(values.iter().map(|value| redact(value, secrets)).collect())
        }
        Value::String(text) => {
            let mut text = text.clone();
            if let Ok(nested) = serde_json::from_str::<Value>(&text)
                && (nested.is_object() || nested.is_array())
            {
                let safe = redact(&nested, secrets);
                if safe != nested {
                    text = safe.to_string();
                }
            }
            for secret in secrets.iter().filter(|key| !key.is_empty()) {
                text = text.replace(secret, "[REDACTED]");
            }
            Value::String(text)
        }
        _ => value.clone(),
    }
}
fn artifact(value: &Value, secrets: &[String]) -> Value {
    let original = match value {
        Value::String(text) => text.len(),
        _ => value.to_string().len(),
    };
    let safe = redact(value, secrets);
    let text = match &safe {
        Value::String(text) => text.clone(),
        _ => safe.to_string(),
    };
    let redacted = safe != *value;
    if text.len() <= MAX_BODY {
        return json!({"value":safe,"redacted":redacted,"truncated":false,"originalBytes":original,"storedBytes":text.len()});
    }
    let mut end = MAX_BODY;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    json!({"text":&text[..end],"redacted":redacted,"truncated":true,"originalBytes":original,"storedBytes":end,"reason":"body_limit"})
}

fn connection(directory: &Path) -> AppResult<Connection> {
    let folder = directory.join("diagnostics");
    std::fs::create_dir_all(&folder)?;
    let db = Connection::open(folder.join("assembly-log.sqlite"))?;
    db.busy_timeout(Duration::from_millis(100))?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA journal_size_limit=1048576; PRAGMA auto_vacuum=INCREMENTAL;
        CREATE TABLE IF NOT EXISTS traces(id TEXT PRIMARY KEY,started_at TEXT NOT NULL,last_at TEXT NOT NULL,next_sequence INTEGER NOT NULL,status TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events(trace_id TEXT NOT NULL,sequence INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(trace_id,sequence));
        CREATE TABLE IF NOT EXISTS bodies(trace_id TEXT NOT NULL,sequence INTEGER NOT NULL,payload TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(trace_id,sequence));")?;
    Ok(db)
}
#[derive(Clone)]
pub struct Trace {
    directory: PathBuf,
    id: String,
    request_id: String,
    action: String,
    start: Instant,
    detailed: bool,
    capture_gate: Option<fn(&Path) -> bool>,
    secrets: Vec<String>,
    stages: Arc<Mutex<StageState>>,
}
#[derive(Default)]
struct StageState {
    active: Vec<(String, Instant)>,
    finished: bool,
}
impl Trace {
    fn stage(&self, phase: &str, status: &str) {
        let elapsed = {
            let Ok(mut stages) = self.stages.lock() else { return; };
            if stages.finished { return; }
            let position = stages.active.iter().position(|(name, _)| name == phase);
            if status == "running" {
                if position.is_some() { return; }
                stages.active.push((phase.to_owned(), Instant::now()));
                None
            } else {
                position.map(|index| stages.active.remove(index).1.elapsed().as_millis() as u64)
            }
        };
        self.append("stage", phase, status, json!({}), elapsed);
    }
    fn finish_stages(&self, status: &str) -> bool {
        let unfinished = {
            let Ok(mut stages) = self.stages.lock() else { return true; };
            if stages.finished { return false; }
            stages.finished = true;
            std::mem::take(&mut stages.active)
        };
        if matches!(status, "failed" | "cancelled") {
            for (phase, start) in unfinished {
                self.append("stage", &phase, status, json!({}), Some(start.elapsed().as_millis() as u64));
            }
        }
        true
    }
    fn append(
        &self,
        category: &str,
        phase: &str,
        status: &str,
        details: Value,
        elapsed: Option<u64>,
    ) {
        let _ = self.append_bounded(
            category,
            phase,
            status,
            details,
            elapsed,
            None,
            MAX_TRACES,
            MAX_PER_TRACE,
            MAX_EVENTS,
        );
    }
    fn append_data(
        &self,
        category: &str,
        phase: &str,
        status: &str,
        details: Value,
        elapsed: Option<u64>,
        data: Value,
    ) {
        let _ = self.append_bounded(
            category,
            phase,
            status,
            details,
            elapsed,
            Some(data),
            MAX_TRACES,
            MAX_PER_TRACE,
            MAX_EVENTS,
        );
    }
    fn append_bounded(
        &self,
        category: &str,
        phase: &str,
        status: &str,
        details: Value,
        elapsed: Option<u64>,
        data: Option<Value>,
        traces: usize,
        per_trace: usize,
        events: usize,
    ) -> AppResult<()> {
        let _mode_write = DEVELOPER_MODE_WRITE.lock().map_err(|_| AppError::new("storage_busy", "开发者日志设置正忙，请重试。"))?;
        let mut db = connection(&self.directory)?;
        let transaction = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let at = chrono::Utc::now().to_rfc3339();
        transaction.execute(
            "INSERT OR IGNORE INTO traces VALUES(?1,?2,?2,0,'running')",
            params![self.id, at],
        )?;
        let sequence: i64 = transaction.query_row(
            "SELECT next_sequence+1 FROM traces WHERE id=?1",
            [&self.id],
            |row| row.get(0),
        )?;
        // A running request retains its original capture choice, but turning
        // developer mode off also prevents its later responses being captured.
        let detailed = self.detailed && self.capture_gate.is_none_or(|gate| gate(&self.directory));
        let mut event = json!({"sequence":sequence,"at":at,"requestId":self.request_id,"category":category,"action":self.action,"phase":phase,"status":status,"details":safe_details(&redact(&details,&self.secrets))});
        event["dataCaptured"] = json!(detailed && data.is_some());
        if let Some(ms) = elapsed {
            event["elapsedMs"] = json!(ms);
            event["durationSource"] = json!("monotonic");
        }
        transaction.execute(
            "INSERT INTO events VALUES(?1,?2,?3)",
            params![self.id, sequence, event.to_string()],
        )?;
        if detailed
            && let Some(data) = data
        {
            let data: serde_json::Map<String, Value> = data
                .as_object()
                .into_iter()
                .flatten()
                .filter(|(key, _)| {
                    matches!(
                        key.as_str(),
                        "input"
                            | "output"
                            | "request"
                            | "rawResponse"
                            | "parsedResponse"
                            | "validation"
                    )
                })
                .map(|(key, value)| (key.clone(), artifact(value, &self.secrets)))
                .collect();
            let text = Value::Object(data).to_string();
            transaction.execute(
                "INSERT INTO bodies VALUES(?1,?2,?3,?4)",
                params![self.id, sequence, text, text.len() as i64],
            )?;
        }
        transaction.execute("UPDATE traces SET last_at=?2,next_sequence=?3,status=CASE WHEN ?4='request' THEN ?5 ELSE status END WHERE id=?1", params![self.id, at, sequence, category, status])?;
        transaction.execute("DELETE FROM events WHERE trace_id=?1 AND sequence NOT IN (SELECT sequence FROM events WHERE trace_id=?1 ORDER BY sequence DESC LIMIT ?2)", params![self.id, per_trace as i64])?;
        transaction.execute("DELETE FROM traces WHERE id NOT IN (SELECT id FROM traces ORDER BY last_at DESC LIMIT ?1)", [traces as i64])?;
        transaction.execute(
            "DELETE FROM events WHERE trace_id NOT IN (SELECT id FROM traces)",
            [],
        )?;
        transaction.execute("DELETE FROM events WHERE rowid NOT IN (SELECT rowid FROM events ORDER BY rowid DESC LIMIT ?1)", [events as i64])?;
        transaction.execute(
            "DELETE FROM traces WHERE id NOT IN (SELECT DISTINCT trace_id FROM events)",
            [],
        )?;
        transaction.execute("DELETE FROM bodies WHERE NOT EXISTS(SELECT 1 FROM events WHERE events.trace_id=bodies.trace_id AND events.sequence=bodies.sequence)", [])?;
        trim_bodies(&transaction, &self.id, MAX_TRACE_BODIES, MAX_BODIES)?;
        transaction.commit()?;
        let _ = db.execute_batch("PRAGMA incremental_vacuum(16); PRAGMA wal_checkpoint(PASSIVE);");
        Ok(())
    }
}
fn trim_bodies(db: &Connection, id: &str, trace_bytes: usize, total_bytes: usize) -> AppResult<()> {
    db.execute("DELETE FROM bodies WHERE trace_id=?1 AND rowid NOT IN (SELECT rowid FROM (SELECT rowid,SUM(bytes) OVER(ORDER BY sequence DESC) AS total FROM bodies WHERE trace_id=?1) WHERE total<=?2)", params![id, trace_bytes as i64])?;
    db.execute("DELETE FROM bodies WHERE rowid NOT IN (SELECT rowid FROM (SELECT rowid,SUM(bytes) OVER(ORDER BY rowid DESC) AS total FROM bodies) WHERE total<=?1)", [total_bytes as i64])?;
    Ok(())
}
thread_local! { static CURRENT: RefCell<Option<Trace>> = const { RefCell::new(None) }; }
pub struct RequestLog {
    trace: Option<Trace>,
}
impl RequestLog {
    pub fn start(directory: &Path, action: &str, payload: &Value) -> Self {
        Self::start_with_secrets(directory, action, payload, vec![])
    }
    pub fn start_with_secrets(
        directory: &Path,
        action: &str,
        payload: &Value,
        secrets: Vec<String>,
    ) -> Self {
        let explicit = trace_id(payload);
        let reading = matches!(
            action,
            "draft_get" | "draft_candidates" | "paper_confirmation" | "paper_get" | "pdf_read"
        );
        let trace =
            (ACTIONS.contains(&action) && (!reading || explicit.is_some())).then(|| Trace {
                directory: directory.to_path_buf(),
                id: explicit.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                request_id: uuid::Uuid::new_v4().to_string(),
                action: action.to_owned(),
                start: Instant::now(),
                detailed: developer_enabled(directory),
                capture_gate: Some(developer_enabled),
                secrets,
                stages: Arc::new(Mutex::new(StageState::default())),
            });
        if let Some(trace) = &trace {
            if trace.detailed {
                trace.append_data(
                    "request",
                    "request",
                    "running",
                    request_details(payload),
                    None,
                    json!({"input":payload}),
                );
            } else {
                trace.append(
                    "request",
                    "request",
                    "running",
                    request_details(payload),
                    None,
                );
            }
        }
        Self { trace }
    }
    pub fn finish(&self, result: &AppResult<Value>, details: Value) {
        if let Some(trace) = &self.trace {
            let mut details = safe_details(&details);
            let status = match result {
                Ok(_) => "completed",
                Err(error) if error.code == "cancelled" => "cancelled",
                Err(_) => "failed",
            };
            if !trace.finish_stages(status) { return; }
            if let Err(error) = result {
                details["errorCode"] = json!(error_code(&error.code));
            }
            if trace.detailed {
                let output = match result {
                    Ok(value) => value.clone(),
                    Err(error) => json!({"code":error.code,"message":error.message}),
                };
                trace.append_data(
                    "request",
                    "request",
                    status,
                    details,
                    Some(trace.start.elapsed().as_millis() as u64),
                    json!({"output":output}),
                );
            } else {
                trace.append(
                    "request",
                    "request",
                    status,
                    details,
                    Some(trace.start.elapsed().as_millis() as u64),
                );
            }
        }
    }
    pub fn enter<T>(&self, work: impl FnOnce() -> T) -> T {
        struct Restore(Option<Trace>);
        impl Drop for Restore {
            fn drop(&mut self) {
                CURRENT.with(|slot| {
                    slot.replace(self.0.take());
                });
            }
        }
        let _restore = Restore(CURRENT.with(|slot| slot.replace(self.trace.clone())));
        work()
    }
}
fn request_details(payload: &Value) -> Value {
    let mut details = safe_details(payload);
    if let Some(operation) = payload["operation"]["type"].as_str() {
        details["operation"] = json!(operation);
    }
    if let Some(operation) = payload["type"].as_str() {
        details["operation"] = json!(operation);
    }
    safe_details(&details)
}
pub fn result_details(value: &Value) -> Value {
    let body = if value["draft"].is_object() {
        &value["draft"]
    } else if value["blueprint"].is_object() {
        &value["blueprint"]
    } else if value["paper"].is_object() {
        &value["paper"]
    } else {
        value
    };
    let mut details = safe_details(&body["stats"]);
    for source in [&body["summary"], &body["requirements"]] {
        if let Some(object) = safe_details(source).as_object() {
            details.as_object_mut().unwrap().extend(object.clone());
        }
    }
    if let Some(scope) = body["requirements"]["mainScope"].as_array() {
        details["scopeCount"] = json!(scope.len());
    }
    for key in ["questionCount", "selectedCount", "missingCount"] {
        if let Some(number) = body["plannedStats"][key].as_u64() {
            details[key] = json!(number);
        }
    }
    if let Some(slots) = body["slots"].as_array() {
        details["slotCount"] = json!(slots.len());
    }
    if let Some(items) = value["candidates"].as_array() {
        details["candidateCount"] = json!(items.len());
    }
    for key in ["draftId", "paperId"] {
        if let Some(id) = body[key].as_str().and_then(valid_entity_id) {
            details[key] = json!(id);
        }
    }
    safe_details(&details)
}
fn current_record(category: &str, phase: &str, status: &str, details: Value, elapsed: Option<u64>) {
    CURRENT.with(|slot| {
        if let Some(trace) = slot.borrow().as_ref() {
            trace.append(category, phase, status, details, elapsed);
        }
    });
}
pub fn data(phase: &str, status: &str, data: Value) {
    data_for_task("", phase, status, data);
}
pub fn data_for_task(task: &str, phase: &str, status: &str, data: Value) {
    if !matches!(
        phase,
        "request_body" | "response_body" | "parsed_output" | "validation" | "candidate_window"
    ) {
        return;
    }
    if !matches!(status, "recorded" | "completed" | "failed") {
        return;
    }
    CURRENT.with(|slot| {
        if let Some(trace) = slot.borrow().as_ref().filter(|trace| trace.detailed) {
            trace.append_data("data", phase, status, json!({"task":task}), None, data);
        }
    });
}
pub fn stage(step: &str, status: &str) {
    if STEPS.contains(&step) && matches!(status, "running" | "completed" | "failed" | "cancelled") {
        CURRENT.with(|slot| {
            if let Some(trace) = slot.borrow().as_ref() { trace.stage(step, status); }
        });
    }
}
pub struct ModelLog {
    start: Instant,
    task: String,
    trace: Option<Trace>,
}
impl ModelLog {
    pub fn start(task: &str, provider: &str, model: &str) -> Self {
        current_record(
            "model",
            "call",
            "running",
            json!({"task":task,"provider":provider,"model":model}),
            None,
        );
        Self {
            start: Instant::now(),
            task: task.to_owned(),
            trace: CURRENT.with(|slot| slot.borrow().clone()),
        }
    }
    pub fn finish<T>(&self, result: &AppResult<T>) {
        let (status, details) = match result {
            Ok(_) => ("completed", json!({"task":self.task})),
            Err(e) => (
                if e.code == "cancelled" {
                    "cancelled"
                } else {
                    "failed"
                },
                json!({"task":self.task,"errorCode":error_code(&e.code)}),
            ),
        };
        if let Some(trace) = &self.trace { trace.append(
            "model",
            "call",
            status,
            details,
            Some(self.start.elapsed().as_millis() as u64),
        ); }
    }
}
pub fn model_budget(task: &str, body: &Value) {
    current_record(
        "model",
        "budget",
        "recorded",
        json!({"task":task,"maxBudget":body.get("max_tokens").or_else(|| body.get("max_completion_tokens"))}),
        None,
    );
}
/// Count the actual serialized HTTP JSON, including image payloads, without
/// retaining its content in ordinary diagnostics.
pub fn model_request_summary(task: &str, context: &Value, body: &Value) {
    let mut details = json!({"task":task});
    if let Ok(bytes) = serde_json::to_vec(body) {
        details["requestBytes"] = json!(bytes.len());
    }
    if let Some(slots) = context["slots"].as_array() {
        details["slotCount"] = json!(slots.len());
    }
    if let Some(questions) = context["questions"].as_array() {
        details["candidateCount"] = json!(questions.len());
    }
    details["questionCount"] = context.get("questionCount")
        .or_else(|| context["requirements"].get("questionCount")).cloned().unwrap_or(Value::Null);
    for (key, batch_key) in [("batchIndex", "index"), ("batchCount", "total"), ("roundIndex", "round")] {
        details[key] = context.get(key).or_else(|| context["batch"].get(batch_key)).cloned().unwrap_or(Value::Null);
    }
    for key in ["poolCount", "presentedCount", "assessedCount", "searchIncomplete"] {
        details[key] = context[key].clone();
    }
    current_record("model", "request_summary", "recorded", details, None);
}
/// Numeric candidate-window progress is safe even when body capture is off.
pub fn selection_window(mut details: Value) {
    if !details.is_object() { return; }
    details["task"] = json!("selection");
    current_record("model", "candidate_window", "recorded", details, None);
}
/// Transport phases are independent durations, never cumulative call totals.
pub fn model_transport(task: &str, phase: &str, elapsed_ms: u64, http_status: Option<u16>, status: &str) {
    if !matches!(phase, "response_headers" | "response_body") || !matches!(status, "completed" | "failed" | "timeout") {
        return;
    }
    current_record("model", phase, status, json!({"task":task,"httpStatus":http_status}), Some(elapsed_ms));
}
pub fn model_response(task: &str, status: u16, response: Option<&Value>) {
    let empty = json!({});
    let response = response.unwrap_or(&empty);
    let usage = &response["usage"];
    current_record(
        "model",
        "response",
        "received",
        json!({"task":task,"httpStatus":status,"finishReason":response["choices"][0]["finish_reason"],"promptTokens":usage["prompt_tokens"],"completionTokens":usage["completion_tokens"],"totalTokens":usage["total_tokens"],"reasoningTokens":usage["completion_tokens_details"]["reasoning_tokens"]}),
        None,
    );
}

pub fn developer_request(
    directory: &Path,
    action: &str,
    payload: &Value,
) -> Option<AppResult<Value>> {
    developer_request_with_options(directory, action, payload, cfg!(debug_assertions), std::env::args_os().any(|arg| arg == "--developer"), std::env::var("TUTOR_DEVELOPER_MODE").ok().as_deref())
}
fn developer_request_with_options(directory: &Path, action: &str, payload: &Value, debug: bool, flag: bool, environment: Option<&str>) -> Option<AppResult<Value>> {
    if !is_developer_action(action) { return None; }
    if matches!(action, "developer_log_capabilities" | "developer_mode_set") {
        return Some((|| {
            let mode = mode_capabilities(directory, debug, flag, environment)?;
            if action == "developer_mode_set" {
                let enabled = payload["enabled"].as_bool().ok_or_else(|| AppError::new("invalid_input", "请明确设置开发者模式的开启或关闭。"))?;
                if mode["configurable"] != true {
                    return Err(AppError::new("developer_mode_forced", "开发者模式由启动参数或环境变量控制，请调整启动方式后重试。"));
                }
                let _mode_write = DEVELOPER_MODE_WRITE.lock().map_err(|_| AppError::new("storage_busy", "开发者日志设置正忙，请重试。"))?;
                save_developer_mode(directory, enabled)?;
                return mode_capabilities(directory, debug, flag, environment);
            }
            Ok(mode)
        })());
    }
    let enabled = mode_capabilities(directory, debug, flag, environment).is_ok_and(|mode| mode["enabled"] == true);
    developer_request_with_gate(directory, action, payload, enabled)
}
fn developer_request_with_gate(
    directory: &Path,
    action: &str,
    payload: &Value,
    enabled: bool,
) -> Option<AppResult<Value>> {
    if !is_developer_action(action) {
        return None;
    }
    if action == "developer_log_capabilities" {
        return Some(Ok(
            json!({"enabled":enabled,"recording":true,"captureDetails":enabled}),
        ));
    }
    if !enabled {
        return Some(Err(AppError::new(
            "developer_disabled",
            "开发者模式未开启。",
        )));
    }
    Some((|| {
        if action == "developer_assembly_event" {
            let id = payload["traceId"]
                .as_str()
                .and_then(valid_trace)
                .ok_or_else(|| AppError::new("invalid_input", "流程标识无效。"))?;
            let event = payload["event"]
                .as_str()
                .filter(|event| UI_EVENTS.contains(event))
                .ok_or_else(|| AppError::new("invalid_input", "日志事件无效。"))?;
            Trace {
                directory: directory.to_path_buf(),
                id,
                request_id: uuid::Uuid::new_v4().to_string(),
                action: "ui".into(),
                start: Instant::now(),
                detailed: false,
                capture_gate: Some(developer_enabled),
                secrets: vec![],
                stages: Arc::new(Mutex::new(StageState::default())),
            }
            .append("ui", event, "recorded", payload["details"].clone(), None);
            return Ok(json!({}));
        }
        if action == "developer_assembly_log_detail" {
            let id = payload["traceId"]
                .as_str()
                .and_then(valid_trace)
                .ok_or_else(|| AppError::new("invalid_input", "流程标识无效。"))?;
            let sequence = payload["sequence"]
                .as_i64()
                .filter(|n| *n > 0)
                .ok_or_else(|| AppError::new("invalid_input", "日志序号无效。"))?;
            let db = connection(directory)?;
            let text = db
                .query_row(
                    "SELECT payload FROM bodies WHERE trace_id=?1 AND sequence=?2",
                    params![id, sequence],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            return Ok(
                json!({"traceId":id,"sequence":sequence,"data":text.as_deref().and_then(|text| serde_json::from_str::<Value>(text).ok()),"available":text.is_some(),"reason":if text.is_none(){Some("not_recorded_or_retained")}else{None}}),
            );
        }
        let wanted = match payload.get("traceId") {
            Some(value) if !value.is_null() => Some(
                value
                    .as_str()
                    .and_then(valid_trace)
                    .ok_or_else(|| AppError::new("invalid_input", "流程标识无效。"))?,
            ),
            _ => None,
        };
        read(directory, wanted)
    })())
}
fn read(directory: &Path, wanted: Option<String>) -> AppResult<Value> {
    let db = connection(directory)?;
    let traces = db.prepare("SELECT id,started_at,last_at,status,(SELECT count(*) FROM events WHERE trace_id=traces.id) FROM traces ORDER BY last_at DESC LIMIT 40")?.query_map([], |row| Ok(json!({"traceId":row.get::<_,String>(0)?,"startedAt":row.get::<_,String>(1)?,"lastAt":row.get::<_,String>(2)?,"status":row.get::<_,String>(3)?,"eventCount":row.get::<_,i64>(4)?})))?.collect::<Result<Vec<_>,_>>()?;
    let id = wanted.or_else(|| {
        traces
            .first()
            .and_then(|trace| trace["traceId"].as_str().map(str::to_owned))
    });
    let events = if let Some(id) = &id {
        db.prepare("SELECT payload,EXISTS(SELECT 1 FROM bodies WHERE bodies.trace_id=events.trace_id AND bodies.sequence=events.sequence) FROM events WHERE trace_id=?1 ORDER BY sequence LIMIT 500")?.query_map([id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,bool>(1)?)))?.collect::<Result<Vec<_>,_>>()?.into_iter().filter_map(|(text, available)| { let mut value = serde_json::from_str::<Value>(&text).ok()?; value["dataAvailable"] = json!(available); value["dataStatus"] = json!(if available { "available" } else if value["dataCaptured"] == true { "expired" } else { "not_captured" }); Some(value) }).collect::<Vec<_>>()
    } else {
        vec![]
    };
    Ok(json!({"traces":traces,"traceId":id,"events":events}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bank::BankRepository;
    #[test]
    fn simulated_assembly_log_entity_ids_preserve_business_format_and_reject_invalid_values() {
        let compact = "01427d2937e9b7796b58b81d1fd29182";
        for id in [compact, "01427D29-37E9-B779-6B58-B81D1FD29182"] {
            let details = safe_details(&json!({"documentId":id,"draftId":id,"paperId":id}));
            for key in ["documentId", "draftId", "paperId"] { assert_eq!(details[key], id); }
            assert_eq!(result_details(&json!({"draft":{"draftId":id}}))["draftId"], id);
            assert_eq!(result_details(&json!({"paper":{"paperId":id}}))["paperId"], id);
        }
        for id in ["", "not-an-entity", "../private.sqlite", "01427d2937e9b7796b58b81d1fd29182-extra"] {
            assert_eq!(safe_details(&json!({"documentId":id,"draftId":id,"paperId":id})), json!({}));
            assert!(result_details(&json!({"paper":{"paperId":id}})).get("paperId").is_none());
        }
        assert_eq!(trace_id(&json!({"assemblyTraceId":compact})).as_deref(), Some("01427d29-37e9-b779-6b58-b81d1fd29182"));
        let dir = tempfile::tempdir().unwrap();
        let mut trace = trace(dir.path(), false);
        trace.secrets.push(compact.to_owned());
        let legitimate = "01427d2937e9b7796b58b81d1fd29183";
        trace.append("request", "request", "failed", json!({"draftId":compact,"paperId":legitimate}), None);
        let listing = read(dir.path(), Some(trace.id)).unwrap();
        assert!(listing["events"][0]["details"].get("draftId").is_none());
        assert_eq!(listing["events"][0]["details"]["paperId"], legitimate);
        assert!(!listing.to_string().contains(compact));
    }
    fn trace(directory: &Path, detailed: bool) -> Trace {
        Trace {
            directory: directory.to_path_buf(),
            id: uuid::Uuid::new_v4().to_string(),
            request_id: uuid::Uuid::new_v4().to_string(),
            action: "blueprint_plan".into(),
            start: Instant::now(),
            detailed,
            capture_gate: None,
            secrets: vec!["simulated-api-secret-canary".into()],
            stages: Arc::new(Mutex::new(StageState::default())),
        }
    }
    #[test]
    fn simulated_stage_durations_are_monotonic_and_cancelled_stage_is_not_completed() {
        let dir = tempfile::tempdir().unwrap();
        let trace = trace(dir.path(), false);
        let id = trace.id.clone();
        let request_id = trace.request_id.clone();
        let log = RequestLog { trace: Some(trace) };
        log.enter(|| {
            stage("plan_supply", "running");
            std::thread::sleep(Duration::from_millis(6));
            stage("plan_supply", "completed");
            stage("plan_check", "running");
            std::thread::sleep(Duration::from_millis(4));
        });
        let cancelled = Err(AppError::new("cancelled", "simulated cancellation"));
        log.finish(&cancelled, json!({}));
        log.finish(&cancelled, json!({}));
        let listing = read(dir.path(), Some(id)).unwrap();
        let events = listing["events"].as_array().unwrap();
        assert_eq!(events.len(), 5, "request completion is idempotent");
        assert!(events.iter().all(|event| event["requestId"] == request_id));
        let completed = events.iter().find(|event| event["category"] == "stage" && event["status"] == "completed").unwrap();
        assert_eq!(completed["phase"], "plan_supply");
        assert!(completed["elapsedMs"].as_u64().unwrap() >= 6);
        assert_eq!(completed["durationSource"], "monotonic");
        let cancelled = events.iter().find(|event| event["category"] == "stage" && event["status"] == "cancelled").unwrap();
        assert_eq!(cancelled["phase"], "plan_check");
        assert!(cancelled["elapsedMs"].as_u64().unwrap() >= 4);
        assert_eq!(cancelled["durationSource"], "monotonic");
    }
    #[test]
    fn simulated_concurrent_requests_keep_stage_and_model_timers_in_their_origin_context() {
        let dir = tempfile::tempdir().unwrap();
        let common_id = uuid::Uuid::new_v4().to_string();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let mut workers = vec![];
        for failed in [false, true] {
            let mut trace = trace(dir.path(), false);
            trace.id = common_id.clone();
            let barrier = barrier.clone();
            workers.push(std::thread::spawn(move || {
                let origin = trace.request_id.clone();
                let log = RequestLog { trace: Some(trace) };
                log.enter(|| {
                    stage("plan_slots", "running");
                    let call = ModelLog::start("blueprint", "deepseek", "deepseek-flash");
                    barrier.wait();
                    std::thread::sleep(Duration::from_millis(5));
                    // A model call retains its origin even if completion occurs
                    // while a different nested request context is entered.
                    let nested = RequestLog { trace: None };
                    nested.enter(|| call.finish(&Ok::<_, AppError>(())));
                    if !failed { stage("plan_slots", "completed"); }
                });
                let result = if failed { Err(AppError::new("invalid_plan", "simulated failure")) } else { Ok(json!({})) };
                log.finish(&result, json!({}));
                (origin, if failed { "failed" } else { "completed" })
            }));
        }
        let expected: Vec<_> = workers.into_iter().map(|worker| worker.join().unwrap()).collect();
        let listing = read(dir.path(), Some(common_id)).unwrap();
        for (request_id, status) in expected {
            let rows: Vec<_> = listing["events"].as_array().unwrap().iter().filter(|event| event["requestId"] == request_id).collect();
            assert_eq!(rows.len(), 5);
            let stage = rows.iter().find(|event| event["category"] == "stage" && event["status"] != "running").unwrap();
            assert_eq!(stage["status"], status);
            assert!(stage["elapsedMs"].as_u64().unwrap() >= 5);
            assert!(rows.iter().any(|event| event["category"] == "model" && event["status"] == "completed" && event["durationSource"] == "monotonic"));
        }
    }
    #[test]
    fn simulated_release_developer_setting_persists_and_explicit_environment_wins() {
        let dir = tempfile::tempdir().unwrap();
        let request = |action, payload: Value| developer_request_with_options(dir.path(), action, &payload, false, false, None).unwrap();
        let initial = request("developer_log_capabilities", json!({})).unwrap();
        assert_eq!(initial["enabled"], false);
        assert_eq!(initial["configurable"], true);
        assert_eq!(initial["source"], "default");
        assert!(!dir.path().join("diagnostics").exists());
        assert!(is_developer_action("developer_mode_set"));
        for enabled in [true, false, true] {
            let saved = request("developer_mode_set", json!({"enabled":enabled})).unwrap();
            assert_eq!(saved["enabled"], enabled);
            assert_eq!(saved["persistedEnabled"], enabled);
            assert_eq!(saved["source"], "local");
            assert_eq!(mode_capabilities(dir.path(), false, false, None).unwrap(), saved);
        }
        assert_eq!(request("developer_mode_set", json!({"enabled":"true"})).unwrap_err().code, "invalid_input");
        for (environment, flag, enabled, source) in [
            (Some("0"), true, false, "environment_off"),
            (Some("1"), false, true, "environment_on"),
            (None, true, true, "command_line"),
        ] {
            let forced = developer_request_with_options(dir.path(), "developer_log_capabilities", &json!({}), false, flag, environment).unwrap().unwrap();
            assert_eq!(forced["enabled"], enabled);
            assert_eq!(forced["source"], source);
            assert_eq!(forced["configurable"], false);
            assert_eq!(developer_request_with_options(dir.path(), "developer_mode_set", &json!({"enabled":!enabled}), false, flag, environment).unwrap().unwrap_err().code, "developer_mode_forced");
            assert_eq!(local_developer_mode(dir.path()).unwrap(), Some(true));
        }
        request("developer_mode_set", json!({"enabled":false})).unwrap();
        assert_eq!(mode_capabilities(dir.path(), true, false, None).unwrap()["enabled"], false, "an explicit local off also overrides the debug default");
        assert_eq!(request("developer_assembly_logs", json!({})).unwrap_err().code, "developer_disabled");
        assert!(!dir.path().join("diagnostics").exists());
    }
    #[test]
    fn simulated_developer_settings_invalid_or_failed_write_never_enables_and_can_retry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DEVELOPER_SETTINGS);
        for invalid in ["{", "{}", r#"{"schemaVersion":1,"enabled":"true"}"#, r#"{"schemaVersion":1,"enabled":true,"unknown":1}"#] {
            std::fs::write(&path, invalid).unwrap();
            assert!(mode_capabilities(dir.path(), false, false, None).is_err());
            assert_eq!(mode_capabilities(dir.path(), false, true, Some("0")).unwrap()["enabled"], false);
            assert_eq!(mode_capabilities(dir.path(), false, false, Some("1")).unwrap()["enabled"], true);
        }
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(save_developer_mode(dir.path(), true).is_err());
        assert!(path.is_dir());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1, "failed atomic writes clean up their temporary file");
        std::fs::remove_dir(&path).unwrap();
        developer_request_with_options(dir.path(), "developer_mode_set", &json!({"enabled":true}), false, false, None).unwrap().unwrap();
        assert_eq!(mode_capabilities(dir.path(), false, false, None).unwrap()["enabled"], true);
    }
    #[test]
    fn simulated_developer_disable_stops_in_flight_body_capture_without_deleting_logs() {
        fn local_gate(directory: &Path) -> bool {
            mode_capabilities(directory, false, false, None).is_ok_and(|mode| mode["enabled"] == true)
        }
        let dir = tempfile::tempdir().unwrap();
        save_developer_mode(dir.path(), true).unwrap();
        let mut trace = trace(dir.path(), true);
        trace.capture_gate = Some(local_gate);
        trace.append_data("request", "request", "running", json!({}), None, json!({"input":"simulated-before-off"}));
        developer_request_with_options(dir.path(), "developer_mode_set", &json!({"enabled":false}), false, false, None).unwrap().unwrap();
        trace.append_data("model", "model", "completed", json!({"totalTokens":12}), None, json!({"rawResponse":"simulated-after-off"}));
        let db = connection(dir.path()).unwrap();
        let bodies: Vec<String> = db.prepare("SELECT payload FROM bodies ORDER BY sequence").unwrap().query_map([], |row| row.get(0)).unwrap().collect::<Result<_,_>>().unwrap();
        assert_eq!(bodies.len(), 1);
        assert!(bodies[0].contains("simulated-before-off"));
        let listing = read(dir.path(), Some(trace.id)).unwrap();
        assert_eq!(listing["events"].as_array().unwrap().len(), 2);
        assert_eq!(listing["events"][1]["dataCaptured"], false);
        assert_eq!(listing["events"][1]["details"]["totalTokens"], 12);
        assert_eq!(developer_request_with_options(dir.path(), "developer_assembly_logs", &json!({}), false, false, None).unwrap().unwrap_err().code, "developer_disabled");
        assert!(STEPS.contains(&"select_pool") && STEPS.contains(&"select_evaluate") && STEPS.contains(&"select_save"));
    }
    #[test]
    fn simulated_assembly_log_gating_is_rust_controlled_and_explicit_off_wins() {
        assert!(!developer_enabled_from(false, false, None));
        assert!(developer_enabled_from(false, true, None));
        assert!(developer_enabled_from(false, false, Some("1")));
        assert!(developer_enabled_from(true, false, None));
        assert!(!developer_enabled_from(true, true, Some("0")));
        let dir = tempfile::tempdir().unwrap();
        let capabilities = developer_request_with_gate(
            dir.path(),
            "developer_log_capabilities",
            &json!({}),
            false,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            capabilities,
            json!({"enabled":false,"recording":true,"captureDetails":false})
        );
        for action in [
            "developer_assembly_logs",
            "developer_assembly_log_detail",
            "developer_assembly_event",
        ] {
            assert_eq!(
                developer_request_with_gate(dir.path(), action, &json!({}), false)
                    .unwrap()
                    .unwrap_err()
                    .code,
                "developer_disabled"
            );
        }
        assert!(!dir.path().join("diagnostics").exists());
    }
    #[test]
    fn simulated_assembly_log_metadata_never_contains_body_key_url_identity_or_untrusted_enum() {
        let dir = tempfile::tempdir().unwrap();
        let trace = trace(dir.path(), false);
        let canary = "simulated-api-secret-canary";
        trace.append_data("request", "request", "running", json!({"mode":"llm","questionCount":20,"model":canary,"provider":"https://private.example/key","errorCode":canary,"message":canary,"apiKey":canary,"title":canary,"student":{"name":canary},"kind":"teacher"}), None, json!({"input":{"message":canary}}));
        let result = read(dir.path(), Some(trace.id.clone())).unwrap();
        let text = result.to_string();
        assert!(!text.contains(canary));
        assert!(!text.contains("private.example"));
        assert_eq!(result["events"][0]["details"]["model"], "custom");
        assert_eq!(result["events"][0]["details"]["errorCode"], "other");
        assert_eq!(result["events"][0]["details"]["questionCount"], 20);
        assert_eq!(result["events"][0]["dataAvailable"], false);
        assert_eq!(
            connection(dir.path())
                .unwrap()
                .query_row("SELECT count(*) FROM bodies", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn simulated_assembly_log_details_retain_actual_question_data_but_scrub_keys_and_student_associations()
     {
        let dir = tempfile::tempdir().unwrap();
        let trace = trace(dir.path(), true);
        let input = json!({"requirements":{"teacherRequest":"模拟需要核对的教师原话","student":{"studentId":"simulated-person-id","name":"simulated-private-name","grade":"simulated-private-grade","notes":"simulated-private-notes"},"students":[{"name":"simulated-other-name"}]},"question":{"questionId":"simulated-q","questionType":"single_choice","student":{"stem":"模拟题目正文 $x>0$","options":[{"label":"A","text":"1"}]},"teacher":{"solutions":[{"text":"模拟参考解析"}]}},"knowledgeCatalogue":{"points":[{"name":"模拟知识点名称需要保留"}]},"apiKey":"simulated-api-secret-canary","protected_key":"simulated-protected-secret","nested":{"Authorization":"simulated-auth","password":"simulated-password","token":"simulated-token"}});
        trace.append_data("request", "request", "running", json!({}), None, json!({"input":input,"request":{"messages":[{"role":"user","content":input.to_string()}]},"rawResponse":"{\"error\":\"simulated-api-secret-canary rejected\",\"apiKey\":\"simulated-hidden-key\"}"}));
        let result = developer_request_with_gate(
            dir.path(),
            "developer_assembly_log_detail",
            &json!({"traceId":trace.id,"sequence":1}),
            true,
        )
        .unwrap()
        .unwrap();
        let text = result.to_string();
        for secret in [
            "simulated-api-secret-canary",
            "simulated-private-name",
            "simulated-private-grade",
            "simulated-private-notes",
            "simulated-other-name",
            "simulated-person-id",
            "simulated-protected-secret",
            "simulated-auth",
            "simulated-password",
            "simulated-token",
            "simulated-hidden-key",
        ] {
            assert!(!text.contains(secret), "leaked {secret}");
        }
        assert_eq!(
            result["data"]["input"]["value"]["question"]["student"]["stem"],
            "模拟题目正文 $x>0$"
        );
        assert!(text.contains("模拟需要核对的教师原话"));
        assert!(text.contains("模拟参考解析"));
        assert!(text.contains("模拟知识点名称需要保留"));
        assert_eq!(result["data"]["input"]["truncated"], false);
        assert_eq!(result["data"]["input"]["redacted"], true);
        assert_eq!(
            read(dir.path(), Some(trace.id.clone())).unwrap()["events"][0]["dataAvailable"],
            true
        );
        let raw = "{ \n \"choices\" : [ { \"message\" : { \"content\" : \"{  \\\"slots\\\" : [] }\" } } ]\n }";
        let artifact = artifact(&json!(raw), &trace.secrets);
        assert_eq!(artifact["value"], raw);
        assert_eq!(artifact["redacted"], false);
        assert_eq!(artifact["storedBytes"], raw.len());
    }
    #[test]
    fn simulated_assembly_log_body_truncation_is_explicit_utf8_safe_and_retention_is_bounded() {
        let text = "模拟".repeat(MAX_BODY / 2);
        let value = artifact(&json!(text), &[]);
        assert_eq!(value["truncated"], true);
        assert_eq!(value["reason"], "body_limit");
        assert_eq!(value["originalBytes"], text.len());
        assert!(value["text"].as_str().unwrap().len() <= MAX_BODY);
        assert_eq!(value["storedBytes"], value["text"].as_str().unwrap().len());
        let dir = tempfile::tempdir().unwrap();
        for _ in 0..4 {
            let trace = trace(dir.path(), true);
            for _ in 0..6 {
                trace
                    .append_bounded(
                        "request",
                        "request",
                        "completed",
                        json!({}),
                        None,
                        Some(json!({"input":"模拟有界正文"})),
                        2,
                        3,
                        4,
                    )
                    .unwrap();
            }
            let db = connection(dir.path()).unwrap();
            trim_bodies(&db, &trace.id, 120, 200).unwrap();
            assert!(
                db.query_row("SELECT count(*) FROM traces", [], |row| row
                    .get::<_, i64>(0))
                    .unwrap()
                    <= 2
            );
            assert!(
                db.query_row("SELECT count(*) FROM events", [], |row| row
                    .get::<_, i64>(0))
                    .unwrap()
                    <= 4
            );
            assert!(
                db.query_row(
                    "SELECT count(*) FROM events WHERE trace_id=?1",
                    [&trace.id],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap()
                    <= 3
            );
            assert!(
                db.query_row("SELECT coalesce(sum(bytes),0) FROM bodies", [], |row| row
                    .get::<_, i64>(
                    0
                ))
                .unwrap()
                    <= 200
            );
            assert!(
                db.query_row(
                    "SELECT coalesce(sum(bytes),0) FROM bodies WHERE trace_id=?1",
                    [&trace.id],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap()
                    <= 120
            );
            assert_eq!(db.query_row("SELECT count(*) FROM bodies WHERE NOT EXISTS(SELECT 1 FROM events WHERE events.trace_id=bodies.trace_id AND events.sequence=bodies.sequence)", [], |row| row.get::<_,i64>(0)).unwrap(), 0);
            let rows = read(dir.path(), Some(trace.id)).unwrap();
            let seq: Vec<_> = rows["events"]
                .as_array()
                .unwrap()
                .iter()
                .map(|event| event["sequence"].as_i64().unwrap())
                .collect();
            assert_eq!(seq, vec![4, 5, 6]);
            assert!(
                rows["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|event| event["dataStatus"] == "expired")
            );
        }
    }
    #[test]
    fn simulated_assembly_log_model_usage_and_bodies_identify_each_intake_task_without_body_in_list()
     {
        let dir = tempfile::tempdir().unwrap();
        let trace = trace(dir.path(), true);
        let id = trace.id.clone();
        let log = RequestLog { trace: Some(trace) };
        log.enter(|| {
            for task in ["intake_scope", "intake"] {
                let call = ModelLog::start(task, "deepseek", "deepseek-flash");
                model_budget(task, &json!({"max_completion_tokens":16384}));
                data_for_task(task, "request_body", "recorded", json!({"request":{"messages":[{"role":"user","content":"模拟实际请求正文canary"}]}}));
                model_response(task, 200, Some(&json!({"choices":[{"finish_reason":"stop","message":{"content":"simulated-raw-private-canary"}}],"usage":{"prompt_tokens":11,"completion_tokens":22,"total_tokens":33,"completion_tokens_details":{"reasoning_tokens":9},"apiKey":"simulated-api-secret-canary"}})));
                call.finish(&Ok::<_,AppError>(json!({})));
            }
            stage("invented-private-phase", "completed");
            std::thread::spawn(|| stage("scope", "completed")).join().unwrap();
        });
        let listing = read(dir.path(), Some(id.clone())).unwrap();
        assert_eq!(listing["events"].as_array().unwrap().len(), 10);
        assert!(!listing.to_string().contains("private-canary"));
        assert!(!listing.to_string().contains("实际请求正文canary"));
        for task in ["intake_scope", "intake"] {
            let events: Vec<_> = listing["events"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|event| event["details"]["task"] == task)
                .collect();
            assert_eq!(events.len(), 5);
            assert!(
                events
                    .iter()
                    .any(|event| event["details"]["maxBudget"] == 16384)
            );
            let response = events
                .iter()
                .find(|event| event["phase"] == "response")
                .unwrap();
            assert_eq!(response["details"]["promptTokens"], 11);
            assert_eq!(response["details"]["completionTokens"], 22);
            assert_eq!(response["details"]["reasoningTokens"], 9);
            assert_eq!(response["details"]["finishReason"], "stop");
        }
    }
    #[test]
    fn simulated_model_request_and_candidate_window_metrics_count_actual_payload_without_leaking_body() {
        for detailed in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let trace = trace(dir.path(), detailed);
            let id = trace.id.clone();
            let log = RequestLog { trace: Some(trace) };
            let body = json!({"apiKey":"simulated-api-secret-canary","messages":[{"role":"user","content":[{"text":"模拟教师私密正文"},{"image_url":{"url":format!("data:image/png;base64,{}", "A".repeat(4096))}}]}]});
            let context = json!({"slots":[{},{}],"questions":[{},{},{}],"requirements":{"questionCount":10},"batch":{"index":2,"total":4,"round":3},"poolCount":19,"presentedCount":12,"assessedCount":8,"searchIncomplete":true,"candidateCount":999,"private":"simulated-private-canary"});
            log.enter(|| {
                model_request_summary("selection", &context, &body);
                selection_window(json!({"batchIndex":2,"batchCount":4,"roundIndex":3,"poolCount":19,"presentedCount":12,"assessedCount":8,"searchIncomplete":true,"teacherRequest":"simulated-private-canary","url":"https://private.example/key"}));
                data_for_task("selection", "candidate_window", "recorded", json!({"input":{"candidateIds":["simulated-q1"]}}));
            });
            let listing = read(dir.path(), Some(id.clone())).unwrap();
            let events = listing["events"].as_array().unwrap();
            assert_eq!(events.len(), if detailed { 3 } else { 2 });
            let summary = &events[0]["details"];
            assert_eq!(summary["candidateCount"], 3);
            assert_eq!(summary["slotCount"], 2);
            assert_eq!(summary["questionCount"], 10);
            assert_eq!(summary["batchIndex"], 2);
            assert_eq!(summary["batchCount"], 4);
            assert_eq!(summary["roundIndex"], 3);
            assert_eq!(summary["requestBytes"], serde_json::to_vec(&body).unwrap().len());
            assert!(summary["requestBytes"].as_u64().unwrap() > 4096);
            assert_eq!(events[1]["phase"], "candidate_window");
            assert_eq!(events[1]["details"]["poolCount"], 19);
            assert_eq!(events[1]["details"]["assessedCount"], 8);
            assert_eq!(events[1]["details"]["searchIncomplete"], true);
            for private in ["simulated-private-canary", "private.example", "模拟教师私密正文", "data:image", "simulated-api-secret-canary", "simulated-q1"] {
                assert!(!listing.to_string().contains(private), "metadata leaked {private}");
            }
            if detailed {
                let detail = developer_request_with_gate(dir.path(), "developer_assembly_log_detail", &json!({"traceId":id,"sequence":3}), true).unwrap().unwrap();
                assert_eq!(detail["data"]["input"]["value"]["candidateIds"][0], "simulated-q1");
            } else {
                assert_eq!(connection(dir.path()).unwrap().query_row("SELECT count(*) FROM bodies", [], |row|row.get::<_,i64>(0)).unwrap(), 0);
            }
        }
    }
    #[test]
    fn simulated_model_transport_records_independent_phases_and_distinct_timeout_codes() {
        let dir = tempfile::tempdir().unwrap();
        let trace = trace(dir.path(), false);
        let id = trace.id.clone();
        let log = RequestLog { trace: Some(trace) };
        log.enter(|| {
            model_transport("selection", "response_headers", 13, Some(200), "completed");
            model_transport("selection", "response_body", 71, Some(200), "timeout");
            model_transport("selection", "simulated-private-phase", 500, None, "completed");
            model_transport("selection", "response_body", 500, None, "simulated-private-status");
            let call = ModelLog::start("selection", "deepseek", "deepseek-flash");
            call.finish(&Err::<Value,_>(AppError::new("model_response_timeout", "simulated-private-message")));
        });
        let listing = read(dir.path(), Some(id)).unwrap();
        let events = listing["events"].as_array().unwrap();
        assert_eq!(events.len(), 4);
        assert_eq!(events[0]["phase"], "response_headers");
        assert_eq!(events[0]["elapsedMs"], 13);
        assert_eq!(events[0]["durationSource"], "monotonic");
        assert_eq!(events[1]["phase"], "response_body");
        assert_eq!(events[1]["elapsedMs"], 71);
        assert_eq!(events[1]["status"], "timeout");
        assert_eq!(events[1]["details"]["httpStatus"], 200);
        assert_eq!(events[3]["details"]["errorCode"], "model_response_timeout");
        assert_eq!(error_code("model_request_timeout"), "model_request_timeout");
        assert!(!listing.to_string().contains("simulated-private"));
    }
    #[test]
    fn simulated_assembly_log_live_read_bypasses_held_runtime_and_recording_failure_keeps_business_result()
     {
        use std::sync::{Arc, Mutex};
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("model-settings.json"),
            json!({"schemaVersion":2,"revision":0,"profiles":[],"activeProfileId":null})
                .to_string(),
        )
        .unwrap();
        let mut runtime = crate::Runtime::open(dir.path()).unwrap();
        runtime
            .request(
                "profile_save",
                &json!({"nickname":"模拟日志隔离"}),
                &std::sync::atomic::AtomicBool::new(false),
            )
            .unwrap();
        let config = runtime.store.bank.config().unwrap();
        let task = config["tasks"].as_array().unwrap().iter().find(|task| task["questionType"] == "single_choice" && task["sectionIds"].as_array().unwrap().iter().any(|section| section == "1.1")).unwrap();
        let requirements = json!({"mainScope":["1.1"],"learnedScope":["1.1"],"scoringMode":"none","counts":{"single_choice":1,"multiple_choice":0,"fill_blank":0,"free_response":0}});
        let payload = json!({"assemblyTraceId":uuid::Uuid::new_v4().to_string(),"mode":"llm","requirements":requirements,"blueprint":{"requirements":requirements,"slots":[{"slotId":"simulated-log-slot","number":1,"questionType":"single_choice","taskId":task["id"],"goalIds":[],"points":0,"partPoints":[]}]}});
        let planned = runtime
            .request(
                "blueprint_check",
                &payload,
                &std::sync::atomic::AtomicBool::new(false),
            )
            .unwrap();
        assert!(
            !planned
                .to_string()
                .contains(payload["assemblyTraceId"].as_str().unwrap())
        );
        let mutex = Arc::new(Mutex::new(runtime));
        let mut held = mutex.lock().unwrap();
        let path = dir.path().to_path_buf();
        let (send, receive) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            send.send(
                developer_request_with_gate(&path, "developer_assembly_logs", &json!({}), true)
                    .unwrap(),
            )
            .unwrap()
        });
        let snapshot = receive
            .recv_timeout(Duration::from_secs(1))
            .expect("log read cannot wait for runtime mutex")
            .unwrap();
        assert!(!snapshot["events"].as_array().unwrap().is_empty());
        reader.join().unwrap();
        let cancelled = held
            .request(
                "blueprint_plan",
                &payload,
                &std::sync::atomic::AtomicBool::new(true),
            )
            .unwrap_err();
        assert_eq!(cancelled.code, "cancelled");
        assert_eq!(
            read(
                dir.path(),
                Some(payload["assemblyTraceId"].as_str().unwrap().to_owned())
            )
            .unwrap()["traces"][0]["status"],
            "cancelled"
        );
        // An unavailable independent log directory cannot alter validation results.
        let bad = tempfile::tempdir().unwrap();
        std::fs::write(
            bad.path().join("diagnostics"),
            "simulated blocked diagnostic directory",
        )
        .unwrap();
        let log = RequestLog::start(bad.path(), "blueprint_check", &payload);
        let result = log.enter(|| {
            held.request(
                "blueprint_check",
                &payload,
                &std::sync::atomic::AtomicBool::new(false),
            )
        });
        log.finish(&result, json!({}));
        assert_eq!(result.unwrap(), planned);
        assert!(held.store.list_documents("drafts").unwrap().is_empty());
        let question = held
            .store
            .bank
            .questions()
            .unwrap()
            .into_iter()
            .next()
            .unwrap();
        let mut manual = json!({"operationId":"simulated-log-idempotency","assemblyTraceId":uuid::Uuid::new_v4().to_string(),"title":"模拟手动日志","purpose":"consolidation","durationMinutes":45,"selections":[{"questionId":question["questionId"],"contentVersion":question["contentVersion"],"teacherVersion":question["teacherVersion"]}]});
        let created = held
            .request(
                "manual_draft_create",
                &manual,
                &std::sync::atomic::AtomicBool::new(false),
            )
            .unwrap();
        manual["assemblyTraceId"] = json!(uuid::Uuid::new_v4().to_string());
        let replayed = held
            .request(
                "manual_draft_create",
                &manual,
                &std::sync::atomic::AtomicBool::new(false),
            )
            .unwrap();
        assert_eq!(replayed["replayed"], true);
        assert_eq!(
            crate::bank::hash_json(&replayed["draft"]),
            crate::bank::hash_json(&created["draft"])
        );
        assert!(!created.to_string().contains("assemblyTraceId"));
        assert_eq!(held.store.list_documents("drafts").unwrap().len(), 1);
        let mut invalid = planned["blueprint"].clone();
        invalid["slots"] = json!([]);
        let trace = trace(dir.path(), true);
        let id = trace.id.clone();
        let log = RequestLog { trace: Some(trace) };
        let model = held.model.clone();
        let error = log
            .enter(|| {
                crate::assembly::dispatch(
                    &mut held.store,
                    "blueprint_check",
                    &json!({"blueprint":invalid}),
                    &model,
                    &std::sync::atomic::AtomicBool::new(false),
                )
            })
            .unwrap_err();
        let validation = read(dir.path(), Some(id.clone())).unwrap()["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|event| event["phase"] == "validation" && event["status"] == "failed")
            .unwrap()
            .clone();
        let detail = developer_request_with_gate(
            dir.path(),
            "developer_assembly_log_detail",
            &json!({"traceId":id,"sequence":validation["sequence"]}),
            true,
        )
        .unwrap()
        .unwrap();
        assert_eq!(detail["data"]["validation"]["value"]["valid"], false);
        assert_eq!(
            detail["data"]["validation"]["value"]["errorCode"],
            error.code
        );
        assert_eq!(
            detail["data"]["validation"]["value"]["message"],
            error.message
        );
        assert!(error.message.contains("题量不一致"));
    }
}
