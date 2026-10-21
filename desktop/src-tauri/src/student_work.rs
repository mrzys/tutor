//! Personal student work, independent of question-bank import and assembly jobs.
use crate::{
    assembly,
    bank::hash_json,
    error::{AppError, AppResult},
    model::ModelClient,
    ocr,
    ocr_settings::OcrSettings,
    storage::Store,
};
use base64::Engine;
use rusqlite::{OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::{Cursor, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
const MAX_FILE: usize = 15 * 1024 * 1024;
const MAX_TOTAL: usize = 45 * 1024 * 1024;
const KIND: &str = "student_work";
fn err(code: &str, message: &str) -> AppError {
    AppError::new(code, message)
}
fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn rows(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn text(v: &Value, key: &str, max: usize) -> AppResult<String> {
    match v.get(key) {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(value))
            if value.chars().count() <= max
                && !value
                    .chars()
                    .any(|c| c.is_control() && !matches!(c, '\n' | '\t')) =>
        {
            Ok(value.trim().to_owned())
        }
        _ => Err(err("invalid_input", "文字过长或包含无效字符。")),
    }
}
fn op(payload: &Value) -> AppResult<&str> {
    let op = s(payload, "operationId");
    if op.is_empty()
        || op.len() > 100
        || !op
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        Err(err("invalid_operation", "缺少有效操作标识。"))
    } else {
        Ok(op)
    }
}
fn cancelled(cancel: &AtomicBool) -> AppResult<()> {
    if cancel.load(Ordering::Relaxed) {
        Err(err("cancelled", "已停止批改，答卷原件和已有结果保留。"))
    } else {
        Ok(())
    }
}
fn cas(store: &Store, before: Option<&Value>, after: &Value) -> AppResult<()> {
    let transaction = Transaction::new_unchecked(&store.user, TransactionBehavior::Immediate)?;
    let old: Option<String> = transaction
        .query_row(
            "SELECT payload FROM documents WHERE kind=?1 AND id=?2",
            [KIND, s(after, "workId")],
            |row| row.get(0),
        )
        .optional()?;
    let old = old.map(|v| serde_json::from_str::<Value>(&v)).transpose()?;
    if old.as_ref() != before {
        return Err(err(
            "revision_conflict",
            "答卷记录已更新，请重新打开后操作。",
        ));
    }
    store.put_document(KIND, s(after, "workId"), after)?;
    transaction.commit()?;
    Ok(())
}
fn revision(record: &Value, payload: &Value) -> AppResult<()> {
    if record["revision"].as_u64() != payload["expectedRevision"].as_u64() {
        Err(err("revision_conflict", "答卷记录已更新，请刷新后操作。"))
    } else {
        Ok(())
    }
}
fn replay(record: &Value, operation: &str, hash: &str) -> AppResult<bool> {
    if let Some(previous) = rows(&record["operations"])
        .iter()
        .find(|v| v["operationId"] == operation)
    {
        if previous["payloadHash"] != hash {
            return Err(err("operation_conflict", "此操作已用于其他答卷内容。"));
        }
        Ok(true)
    } else {
        Ok(false)
    }
}
fn finish(record: &mut Value, operation: &str, hash: &str, kind: &str) {
    record["revision"] = json!(record["revision"].as_u64().unwrap_or(0) + 1);
    record["updatedAt"] = json!(now());
    let mut operations = rows(&record["operations"]);
    operations.push(json!({"operationId":operation,"payloadHash":hash,"type":kind,"revision":record["revision"]}));
    record["operations"] = json!(operations)
}
fn all_files(record: &Value) -> Vec<Value> {
    rows(&record["source"]["files"])
        .into_iter()
        .chain(rows(&record["answerFiles"]))
        .collect()
}
fn binding(record: &Value) -> Value {
    json!({"source":record["source"],"answerFiles":record["answerFiles"]})
}
fn verify(record: &Value) -> AppResult<()> {
    if s(record, "workId").is_empty() || record["bindingSha256"] != hash_json(&binding(record)) {
        return Err(err(
            "integrity_error",
            "答卷与原题绑定校验失败，已有资料保留。",
        ));
    }
    if record["source"]["kind"] == "paper" {
        assembly::verify_frozen_paper(&record["source"]["paperSnapshot"])?;
        if record["source"]["paperId"] != record["source"]["paperSnapshot"]["paperId"]
            || record["source"]["snapshotSha256"]
                != record["source"]["paperSnapshot"]["snapshotSha256"]
        {
            return Err(err("integrity_error", "成卷快照身份不一致。"));
        }
    }
    Ok(())
}
fn write_new(path: &Path, bytes: &[u8]) -> AppResult<()> {
    std::fs::create_dir_all(
        path.parent()
            .ok_or_else(|| err("invalid_file", "附件目录无效。"))?,
    )?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}
fn validate_file(filename: &str, bytes: &[u8]) -> AppResult<(&'static str, &'static str)> {
    if filename.is_empty()
        || filename.len() > 240
        || filename
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
    {
        return Err(err("invalid_file", "附件名称无效。"));
    }
    if bytes.is_empty() || bytes.len() > MAX_FILE {
        return Err(err("file_too_large", "每份附件需为1字节至15 MB。"));
    }
    let extension = Path::new(filename)
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "pdf" => {
            if !bytes.starts_with(b"%PDF-") {
                return Err(err("invalid_file", "PDF 签名无效。"));
            }
            let doc = lopdf::Document::load_mem(bytes)
                .map_err(|_| err("invalid_file", "PDF 无法读取，原件可能损坏。"))?;
            if doc.is_encrypted() || doc.get_pages().is_empty() || doc.get_pages().len() > 50 {
                return Err(err("invalid_file", "PDF 需为未加密的1至50页文件。"));
            }
            Ok(("pdf", "application/pdf"))
        }
        "png" | "jpg" | "jpeg" => {
            let format = if extension == "png" {
                image::ImageFormat::Png
            } else {
                image::ImageFormat::Jpeg
            };
            if (format == image::ImageFormat::Png && !bytes.starts_with(b"\x89PNG\r\n\x1a\n"))
                || (format == image::ImageFormat::Jpeg && !bytes.starts_with(b"\xff\xd8\xff"))
            {
                return Err(err("invalid_file", "图片签名与类型不一致。"));
            }
            let reader = image::ImageReader::with_format(Cursor::new(bytes), format);
            let (width, height) = reader
                .into_dimensions()
                .map_err(|_| err("invalid_file", "图片无法读取。"))?;
            if width == 0
                || height == 0
                || width > 16000
                || height > 16000
                || (width as u64 * height as u64) > 40_000_000
            {
                return Err(err("invalid_file", "图片尺寸过大，请压缩后上传。"));
            }
            image::load_from_memory_with_format(bytes, format)
                .map_err(|_| err("invalid_file", "图片内容损坏。"))?;
            Ok(if format == image::ImageFormat::Png {
                ("png", "image/png")
            } else {
                ("jpg", "image/jpeg")
            })
        }
        _ => Err(err("unsupported_file", "答卷和原题支持 PDF、PNG、JPEG。")),
    }
}
fn read_file(store: &Store, record: &Value, file_id: &str) -> AppResult<(Value, Vec<u8>)> {
    verify(record)?;
    let descriptor = all_files(record)
        .into_iter()
        .find(|f| f["fileId"] == file_id)
        .ok_or_else(|| err("not_found", "此答卷没有该附件。"))?;
    let root = store
        .data_dir
        .join("student-work")
        .join(s(record, "workId"))
        .join("originals")
        .canonicalize()?;
    let path = store
        .data_dir
        .join(s(&descriptor, "relativePath"))
        .canonicalize()?;
    if !path.starts_with(&root)
        || !path.is_file()
        || std::fs::metadata(&path)?.len() > MAX_FILE as u64
    {
        return Err(err("integrity_error", "附件路径或大小校验失败。"));
    }
    let bytes = std::fs::read(path)?;
    let (_, mime) = validate_file(s(&descriptor, "filename"), &bytes)?;
    if sha(&bytes) != descriptor["sha256"]
        || bytes.len() as u64 != descriptor["byteLength"].as_u64().unwrap_or(0)
        || mime != s(&descriptor, "mimeType")
    {
        return Err(err(
            "integrity_error",
            "附件内容校验失败，未使用改变的原件。",
        ));
    }
    Ok((descriptor, bytes))
}
fn create(store: &Store, payload: &Value) -> AppResult<Value> {
    let operation = op(payload)?;
    let hash = hash_json(payload);
    let id = format!("work-{}", &hash_json(&json!(operation))[..24]);
    if let Ok(record) = store.document(KIND, &id) {
        if record["creationHash"] != hash {
            return Err(err("operation_conflict", "此保存操作已用于其他答卷。"));
        }
        verify(&record)?;
        return Ok(json!({"work":record}));
    }
    let student = store.student(s(payload, "studentId"))?;
    let mut title = text(payload, "title", 120)?;
    let notes = text(payload, "notes", 2000)?;
    let completed = text(payload, "completedOn", 10)?;
    if !completed.is_empty() && chrono::NaiveDate::parse_from_str(&completed, "%Y-%m-%d").is_err() {
        return Err(err(
            "invalid_input",
            "作答日期请使用YYYY-MM-DD；未知可留空。",
        ));
    }
    let mut source = payload["source"].clone();
    let source_files = rows(&source["files"]);
    let answer_files = rows(&payload["answers"]);
    if answer_files.is_empty() || source_files.len() + answer_files.len() > 8 {
        return Err(err(
            "invalid_file",
            "请上传答卷，原题与答卷合计最多8份文件。",
        ));
    }
    if source["kind"] == "paper" {
        let paper = store.document("papers", s(&source, "paperId"))?;
        assembly::verify_frozen_paper(&paper)?;
        if !source_files.is_empty() {
            return Err(err("invalid_input", "本机成卷无需重复上传原题。"));
        }
        if title.is_empty() {
            title = s(&paper, "title").to_owned()
        }
        source = json!({"kind":"paper","paperId":paper["paperId"],"snapshotSha256":paper["snapshotSha256"],"paperSnapshot":paper,"files":[]});
    } else if source["kind"] == "external" {
        if title.is_empty() {
            return Err(err("invalid_input", "请填写外部练习名称。"));
        }
        let mode = match s(&source, "externalSourceMode") {
            "" if source_files.is_empty() => "answer_only",
            "" => "uploaded_questions",
            mode => mode,
        };
        if !matches!(
            mode,
            "answer_only"
                | "separate_materials"
                | "uploaded_questions"
                | "answer_contains_questions"
        ) {
            return Err(err("invalid_input", "练习来源类型无效。"));
        }
        if matches!(mode, "separate_materials" | "uploaded_questions") && source_files.is_empty() {
            return Err(err(
                "source_required",
                "未收到已选择的原题附件；可补选附件，或仅上传答卷继续。",
            ));
        }
        source = json!({"kind":"external","externalSourceMode":mode,"files":[]});
    } else {
        return Err(err("invalid_input", "请选择本机成卷或其他练习。"));
    }
    if title.is_empty() {
        title = "练习答卷".into()
    }
    let mut decoded = vec![];
    let mut total = 0usize;
    for (role, files) in [("source", source_files), ("answer", answer_files)] {
        for (i, file) in files.iter().enumerate() {
            let encoded = s(file, "contentBase64");
            if encoded.len() > MAX_FILE.div_ceil(3) * 4 + 4 {
                return Err(err("file_too_large", "每份附件最大15 MB。"));
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| err("invalid_file", "附件编码无效。"))?;
            let (extension, mime) = validate_file(s(file, "filename"), &bytes)?;
            total += bytes.len();
            if total > MAX_TOTAL {
                return Err(err("file_too_large", "原题与答卷总大小不能超过45 MB。"));
            }
            decoded.push((
                role,
                format!("{role}-{}", i + 1),
                s(file, "filename").to_owned(),
                extension,
                mime,
                bytes,
            ));
        }
    }
    let mut files = vec![];
    for (role, file_id, name, extension, mime, bytes) in decoded {
        let relative = format!("student-work/{id}/originals/{file_id}.{extension}");
        let path = store.data_dir.join(&relative);
        if path.exists() {
            if std::fs::read(&path)? != bytes {
                return Err(err(
                    "operation_conflict",
                    "已保存附件与本次内容不同，未覆盖。",
                ));
            }
        } else {
            write_new(&path, &bytes)?
        }
        files.push(json!({"fileId":file_id,"role":role,"filename":name,"extension":extension,"mimeType":mime,"byteLength":bytes.len(),"sha256":sha(&bytes),"relativePath":relative}));
    }
    source["files"] = json!(
        files
            .iter()
            .filter(|f| f["role"] == "source")
            .cloned()
            .collect::<Vec<_>>()
    );
    let timestamp = now();
    let mut record = json!({"schemaVersion":1,"workId":id,"creationHash":hash,"title":title,"student":{"studentId":student["studentId"],"name":student["name"],"grade":student["grade"]},"completedOn":if completed.is_empty(){Value::Null}else{json!(completed)},"notes":notes,"source":source,"answerFiles":files.iter().filter(|f|f["role"]=="answer").cloned().collect::<Vec<_>>(),"revision":0,"createdAt":timestamp,"updatedAt":timestamp,"status":"saved","job":null,"aiResult":null,"teacherOverrides":[],"attempts":[],"operations":[]});
    record["bindingSha256"] = json!(hash_json(&binding(&record)));
    finish(&mut record, operation, &hash, "create");
    cas(store, None, &record)?;
    Ok(json!({"work":record}))
}

#[derive(Default)]
struct Registry {
    jobs: HashMap<(PathBuf, String), Arc<AtomicBool>>,
    running: HashMap<PathBuf, usize>,
}
fn registry() -> &'static (Mutex<Registry>, Condvar) {
    static REGISTRY: OnceLock<(Mutex<Registry>, Condvar)> = OnceLock::new();
    REGISTRY.get_or_init(|| (Mutex::new(Registry::default()), Condvar::new()))
}
fn root(store: &Store) -> AppResult<PathBuf> {
    Ok(store.data_dir.canonicalize()?)
}
fn lease_path(store: &Store, id: &str, job: &str) -> PathBuf {
    store
        .data_dir
        .join("student-work")
        .join(id)
        .join("attempts")
        .join(job)
        .join("worker.lease")
}
fn lease(path: &Path) -> AppResult<File> {
    std::fs::create_dir_all(path.parent().unwrap())?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    options
        .open(path)
        .map_err(|_| err("work_running", "此批改任务仍由另一窗口处理。"))
}
fn job_response(record: Value) -> Value {
    json!({"job":record["job"],"work":record})
}
fn owned(record: &Value, job: &str) -> bool {
    record["job"]["jobId"] == job && matches!(s(&record["job"], "status"), "queued" | "running")
}
fn set_stage(store: &Store, id: &str, job: &str, stage: &str) -> AppResult<Value> {
    let old = store.document(KIND, id)?;
    if !owned(&old, job) {
        return Err(err("cancelled", "此批改任务已停止或已被新任务替代。"));
    }
    let mut next = old.clone();
    next["status"] = json!("running");
    next["job"]["status"] = json!("running");
    next["job"]["stage"] = json!(stage);
    next["updatedAt"] = json!(now());
    cas(store, Some(&old), &next)?;
    Ok(next)
}
fn terminal(store: &Store, id: &str, job: &str, result: AppResult<Value>) -> AppResult<()> {
    let old = store.document(KIND, id)?;
    if !owned(&old, job) {
        return Ok(());
    }
    let mut next = old.clone();
    let (status, error, result) = match result {
        Ok(result) => ("completed", Value::Null, Some(result)),
        Err(error) => {
            let status = if error.code == "cancelled" {
                "cancelled"
            } else if error.code == "work_interrupted" {
                "interrupted"
            } else {
                "failed"
            };
            (status, serde_json::to_value(error)?, None)
        }
    };
    next["status"] = json!(status);
    next["job"]["status"] = json!(status);
    next["job"]["error"] = error;
    next["job"]["finishedAt"] = json!(now());
    let mut attempts = rows(&next["attempts"]);
    let mut attempt = attempts
        .iter()
        .position(|a| a["jobId"] == job)
        .map(|i| attempts.remove(i))
        .unwrap_or(json!({"jobId":job}));
    attempt["status"] = json!(status);
    attempt["finishedAt"] = next["job"]["finishedAt"].clone();
    attempt["error"] = next["job"]["error"].clone();
    if let Some(result) = result {
        next["aiResult"] = result.clone();
        attempt["inputSha256"] = result["inputSha256"].clone();
        attempt["model"] = result["model"].clone();
        attempt["result"] = result;
    }
    attempts.push(attempt);
    next["attempts"] = json!(attempts);
    let operation = s(&next["job"], "operationId").to_owned();
    let hash = s(&next["job"], "payloadHash").to_owned();
    finish(&mut next, &operation, &hash, "grade_finished");
    cas(store, Some(&old), &next)
}
pub fn recover_background_jobs(store: &Store) -> AppResult<()> {
    let root = root(store)?;
    let active = registry()
        .0
        .lock()
        .map_err(|_| err("internal_error", "批改任务暂不可用。"))?;
    for record in store.list_documents(KIND)? {
        if !matches!(s(&record["job"], "status"), "queued" | "running") {
            continue;
        }
        let id = s(&record, "workId");
        if active.jobs.contains_key(&(root.clone(), id.to_owned())) {
            continue;
        }
        if let Ok(_lease) = lease(&lease_path(store, id, s(&record["job"], "jobId"))) {
            terminal(
                store,
                id,
                s(&record["job"], "jobId"),
                Err(err(
                    "work_interrupted",
                    "上次批改因应用退出而中断，原件和结果已保留，可显式重试。",
                )),
            )?;
        }
    }
    Ok(())
}
fn start(
    store: &Store,
    model: &ModelClient,
    ocr: &OcrSettings,
    payload: &Value,
) -> AppResult<Value> {
    let operation = op(payload)?;
    let hash = hash_json(payload);
    let id = s(payload, "workId");
    let old = store.document(KIND, id)?;
    verify(&old)?;
    if replay(&old, operation, &hash)? {
        return Ok(job_response(old));
    }
    if old["job"]["operationId"] == operation {
        if old["job"]["payloadHash"] != hash {
            return Err(err("operation_conflict", "此批改操作已用于其他内容。"));
        }
        return Ok(job_response(old));
    }
    revision(&old, payload)?;
    if matches!(s(&old["job"], "status"), "queued" | "running") {
        return Err(err("work_running", "此答卷仍在批改，请等待或先停止。"));
    }
    if !model.configured() {
        return Err(err(
            "not_configured",
            "答卷已保存，请配置当前模型后开始批改。",
        ));
    }
    if !ocr.configured() {
        return Err(err(
            "ocr_not_configured",
            "答卷已保存，请配置试卷识别后开始批改。",
        ));
    }
    for file in all_files(&old) {
        read_file(store, &old, s(&file, "fileId"))?;
    }
    let job = format!("work-job-{}", uuid::Uuid::new_v4());
    let worker_lease = lease(&lease_path(store, id, &job))?;
    let cancel = Arc::new(AtomicBool::new(false));
    let directory = root(store)?;
    let mut registry = registry()
        .0
        .lock()
        .map_err(|_| err("internal_error", "无法启动批改任务。"))?;
    let mut next = old.clone();
    next["status"] = json!("queued");
    next["job"] = json!({"jobId":job,"status":"queued","stage":"queued","createdAt":now(),"operationId":operation,"payloadHash":hash,"error":null});
    let mut attempts = rows(&next["attempts"]);
    attempts.push(json!({"jobId":job,"status":"queued","createdAt":next["job"]["createdAt"],"model":{"activeProfileId":model.public_settings()["activeProfileId"],"model":model.public_settings()["model"],"baseUrl":model.public_settings()["baseUrl"]}}));
    next["attempts"] = json!(attempts);
    finish(&mut next, operation, &hash, "grade_start");
    cas(store, Some(&old), &next)?;
    registry
        .jobs
        .insert((directory.clone(), id.to_owned()), cancel.clone());
    drop(registry);
    let model = model.clone();
    let ocr = ocr.clone();
    let id = id.to_owned();
    let response = next.clone();
    std::thread::spawn(move || worker(directory, id, job, model, ocr, cancel, worker_lease));
    Ok(job_response(response))
}
fn worker(
    directory: PathBuf,
    id: String,
    job: String,
    model: ModelClient,
    settings: OcrSettings,
    cancel: Arc<AtomicBool>,
    _lease: File,
) {
    let run = (|| -> AppResult<()> {
        let mut guard = registry()
            .0
            .lock()
            .map_err(|_| err("internal_error", "后台批改队列不可用。"))?;
        while guard.running.get(&directory).copied().unwrap_or(0) >= 2 {
            cancelled(&cancel)?;
            guard = registry()
                .1
                .wait_timeout(guard, Duration::from_millis(100))
                .map_err(|_| err("internal_error", "后台批改队列不可用。"))?
                .0;
        }
        *guard.running.entry(directory.clone()).or_default() += 1;
        drop(guard);
        Ok(())
    })();
    let acquired = run.is_ok();
    let result = run.and_then(|_| {
        let seed: Value = serde_json::from_str(include_str!("../../resources/seed.json"))?;
        let store = Store::open(&directory, &seed)?;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            grade(&store, &id, &job, &model, &settings, &cancel)
        }))
        .unwrap_or_else(|_| {
            Err(err(
                "grading_failed",
                "答卷处理未完成，原件和已有结果已保留。",
            ))
        });
        terminal(&store, &id, &job, result)
    });
    if let Err(error) = result {
        if let Ok(seed) = serde_json::from_str::<Value>(include_str!("../../resources/seed.json")) {
            if let Ok(store) = Store::open(&directory, &seed) {
                let _ = terminal(&store, &id, &job, Err(error));
            }
        }
    }
    if let Ok(mut guard) = registry().0.lock() {
        let key = (directory.clone(), id);
        if guard
            .jobs
            .get(&key)
            .is_some_and(|owner| Arc::ptr_eq(owner, &cancel))
        {
            guard.jobs.remove(&key);
        }
        if acquired {
            if let Some(count) = guard.running.get_mut(&directory) {
                *count = count.saturating_sub(1)
            }
        }
        registry().1.notify_all();
    }
}
fn cancel(store: &Store, payload: &Value) -> AppResult<Value> {
    let id = s(payload, "workId");
    let old = store.document(KIND, id)?;
    if old["job"]["jobId"] != payload["jobId"] {
        return Err(err("revision_conflict", "批改任务已更新，未停止新任务。"));
    }
    if !matches!(s(&old["job"], "status"), "queued" | "running") {
        return Ok(job_response(old));
    }
    if let Some(cancel) = registry()
        .0
        .lock()
        .map_err(|_| err("internal_error", "批改队列不可用。"))?
        .jobs
        .get(&(root(store)?, id.to_owned()))
    {
        cancel.store(true, Ordering::Relaxed)
    }
    let mut next = old.clone();
    next["status"] = json!("cancelled");
    next["job"]["status"] = json!("cancelled");
    next["job"]["finishedAt"] = json!(now());
    next["job"]["error"] = json!({"code":"cancelled","message":"已停止批改，原件和已有结果保留。"});
    let mut attempts = rows(&next["attempts"]);
    if let Some(attempt) = attempts.iter_mut().find(|a| a["jobId"] == payload["jobId"]) {
        attempt["status"] = json!("cancelled");
        attempt["finishedAt"] = next["job"]["finishedAt"].clone();
        attempt["error"] = next["job"]["error"].clone();
    }
    next["attempts"] = json!(attempts);
    next["revision"] = json!(old["revision"].as_u64().unwrap_or(0) + 1);
    next["updatedAt"] = json!(now());
    cas(store, Some(&old), &next)?;
    Ok(job_response(next))
}

mod grading;
use grading::grade;
fn judgement(value: &str) -> bool {
    matches!(
        value,
        "correct" | "incorrect" | "partial" | "unanswered" | "unable"
    )
}
fn override_result(store: &Store, payload: &Value) -> AppResult<Value> {
    let operation = op(payload)?;
    let hash = hash_json(payload);
    let old = store.document(KIND, s(payload, "workId"))?;
    verify(&old)?;
    if replay(&old, operation, &hash)? {
        return Ok(json!({"work":old}));
    }
    revision(&old, payload)?;
    if matches!(s(&old["job"], "status"), "queued" | "running") {
        return Err(err("work_running", "批改完成或停止后再修正结果。"));
    }
    let item = rows(&old["aiResult"]["items"])
        .into_iter()
        .find(|item| item["itemId"] == payload["itemId"])
        .ok_or_else(|| err("not_found", "没有找到本次批改题目。"))?;
    let choice = s(payload, "judgement");
    if !judgement(choice) {
        return Err(err("invalid_input", "请选择有效的判定。"));
    }
    let comment = text(payload, "comment", 4000)?;
    let earned = match payload.get("earnedPoints") {
        None | Some(Value::Null) => Value::Null,
        Some(value) => {
            let cap = item["maxPoints"]
                .as_f64()
                .ok_or_else(|| err("invalid_score", "这道题没有明确计分上限。"))?;
            let score = value
                .as_f64()
                .filter(|n| n.is_finite() && *n >= 0.0 && *n <= cap)
                .ok_or_else(|| err("invalid_score", "得分需在真实计分范围内。"))?;
            if choice == "unable" {
                return Err(err("invalid_score", "无法判断的题目不填写得分。"));
            }
            json!(score)
        }
    };
    let mut next = old.clone();
    let mut overrides = rows(&old["teacherOverrides"]);
    overrides.push(json!({"overrideId":uuid::Uuid::new_v4().to_string(),"itemId":item["itemId"],"jobId":old["aiResult"]["jobId"],"judgement":choice,"comment":comment,"earnedPoints":earned,"updatedAt":now(),"operationId":operation}));
    next["teacherOverrides"] = json!(overrides);
    finish(&mut next, operation, &hash, "teacher_override");
    cas(store, Some(&old), &next)?;
    Ok(json!({"work":next}))
}
pub fn dispatch(
    store: &Store,
    model: &ModelClient,
    settings: &OcrSettings,
    action: &str,
    payload: &Value,
) -> AppResult<Option<Value>> {
    let result = match action {
        "student_work_create" => create(store, payload)?,
        "student_work_start" | "student_work_retry" => start(store, model, settings, payload)?,
        "student_work_cancel" => cancel(store, payload)?,
        "student_work_override" => override_result(store, payload)?,
        "student_work_get" => {
            let work = store.document(KIND, s(payload, "workId"))?;
            verify(&work)?;
            json!({"work":work})
        }
        "student_work_list" => {
            let mut works = vec![];
            for work in store.list_documents(KIND)? {
                verify(&work)?;
                if !s(payload, "studentId").is_empty()
                    && work["student"]["studentId"] != payload["studentId"]
                {
                    continue;
                }
                works.push(json!({"workId":work["workId"],"title":work["title"],"source":{"kind":work["source"]["kind"],"paperId":work["source"]["paperId"],"externalSourceMode":work["source"]["externalSourceMode"]},"student":work["student"],"completedOn":work["completedOn"],"revision":work["revision"],"status":work["status"],"createdAt":work["createdAt"],"updatedAt":work["updatedAt"],"job":work["job"],"itemCount":rows(&work["aiResult"]["items"]).len()}));
            }
            json!({"works":works})
        }
        "student_work_file_read" => {
            let work = store.document(KIND, s(payload, "workId"))?;
            let (file, bytes) = read_file(store, &work, s(payload, "fileId"))?;
            json!({"filename":file["filename"],"mimeType":file["mimeType"],"sha256":file["sha256"],"contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes)})
        }
        _ => return Ok(None),
    };
    Ok(Some(result))
}

#[cfg(test)]
mod tests;
