//! Persisted import jobs with independent SQLite connections. The desktop
//! Runtime mutex is held only while accepting an upload, never during OCR/LLM.
use super::*;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Condvar, Mutex, OnceLock},
    time::Duration,
};

#[derive(Default)]
struct Registry {
    jobs: HashMap<(PathBuf, String), Arc<AtomicBool>>,
    running: HashMap<PathBuf, usize>,
}
fn registry() -> &'static (Mutex<Registry>, Condvar) {
    static REGISTRY: OnceLock<(Mutex<Registry>, Condvar)> = OnceLock::new();
    REGISTRY.get_or_init(|| (Mutex::new(Registry::default()), Condvar::new()))
}
fn directory(store: &Store) -> AppResult<PathBuf> {
    Ok(store.data_dir.canonicalize()?)
}
fn lock_error() -> AppError {
    err(
        "internal_error",
        "后台导入暂不可用，原件已保留，请重启后重试。",
    )
}
fn remove_owned_job(state: &mut Registry, key: &(PathBuf, String), owner: &Arc<AtomicBool>) {
    // A terminal result can already be visible while its worker is unwinding.
    // An immediate retry may have registered a replacement in that interval.
    if state
        .jobs
        .get(key)
        .is_some_and(|current| Arc::ptr_eq(current, owner))
    {
        state.jobs.remove(key);
    }
}
fn release_worker(root: &PathBuf, id: &str, owner: &Arc<AtomicBool>) {
    let (mutex, wake) = registry();
    if let Ok(mut state) = mutex.lock() {
        remove_owned_job(&mut state, &(root.clone(), id.to_owned()), owner);
        if let Some(count) = state.running.get_mut(root) {
            *count = count.saturating_sub(1);
        }
        wake.notify_all();
    }
}

fn descriptor(record: &Value) -> Value {
    let mut job = record["backgroundJob"].clone();
    if !job.is_object() {
        return Value::Null;
    }
    let status = s(&job, "status").to_owned();
    let annotation = job["mode"] == "annotation";
    let review = job["mode"] == "review";
    let stage = if status == "queued" {
        "queued"
    } else {
        s(record, "recognitionStage")
    };
    let message = match status.as_str() {
        "queued" => {
            if review {
                "排队等待模型检查，可继续其它操作。"
            } else if annotation {
                "排队等待补充考查信息，可继续其它操作。"
            } else {
                "排队等待识别，可继续其它操作。"
            }
        }
        "running" => match stage {
            "recognizing" => "正在识别原卷，可继续其它操作。",
            "structuring" => "正在整理题目与考查信息，可继续其它操作。",
            "annotating" => "正在补充考查信息，可继续其它操作。",
            "reviewing" => "正在对照原卷逐题检查，可继续其它操作。",
            _ => "正在准备原卷，可继续其它操作。",
        },
        "completed" => {
            if review {
                "模型检查完成，请查看意见后确认加入题库。"
            } else if annotation {
                "考查信息已补充；不确定的标注仍保留未知，题目内容和审核状态不变。"
            } else {
                "导入处理完成，可查看题目与检查意见。"
            }
        }
        "cancelled" => {
            if annotation {
                "已停止补充，原题和已完成标注已保留。"
            } else {
                "已停止，原件和已有材料已保留。"
            }
        }
        "interrupted" => {
            if annotation {
                "上次补充因应用退出而中断，原题和已完成标注已保留，可重试。"
            } else {
                "上次解析因应用退出而中断，原件已保留，可重试。"
            }
        }
        _ => {
            if job["error"].is_object() {
                s(&job["error"], "message")
            } else {
                s(&record["error"], "message")
            }
        }
    }
    .to_owned();
    job["stage"] = json!(stage);
    job["message"] = json!(message);
    job["importId"] = record["importId"].clone();
    job["filename"] = record["filename"].clone();
    job["updatedAt"] = record["updatedAt"].clone();
    // Internal payload hashes/operation identity are not needed by the UI.
    job.as_object_mut().unwrap().remove("payloadHash");
    job.as_object_mut().unwrap().remove("operationId");
    job.as_object_mut().unwrap().remove("targetQuestionIds");
    job
}
fn response(store: &Store, record: &Value) -> Value {
    json!({"job":descriptor(record),"import":record,"diagnostic":diagnostics::for_record(store,record),"reviewRequirements":review_requirement_map(record),"reviewEligibility":review::eligibility(record)})
}

fn terminal_failure(
    store: &Store,
    id: &str,
    error: AppError,
    expected_job: Option<&Value>,
) -> AppResult<()> {
    let saved = store.document("imports", id)?;
    if expected_job.is_some_and(|job| saved["backgroundJob"]["jobId"] != *job) {
        return Ok(());
    }
    if !matches!(s(&saved["backgroundJob"], "status"), "queued" | "running") {
        return Ok(());
    }
    let mut record = saved.clone();
    let annotation = record["backgroundJob"]["mode"] == "annotation";
    let review = record["backgroundJob"]["mode"] == "review";
    if !annotation && !review && rows(&record["questions"]).is_empty() {
        record["status"] = json!("failed");
        record["error"] = serde_json::to_value(&error)?;
    }
    record["backgroundJob"]["error"] = serde_json::to_value(&error)?;
    record["backgroundJob"]["status"] = json!(if error.code == "cancelled" {
        "cancelled"
    } else if error.code == "import_interrupted" {
        "interrupted"
    } else {
        "failed"
    });
    record["backgroundJob"]["finishedAt"] = json!(now());
    let operation = s(&record["backgroundJob"], "operationId").to_owned();
    let hash = s(&record["backgroundJob"], "payloadHash").to_owned();
    finish(
        &mut record,
        &operation,
        &hash,
        if review {
            "model_review"
        } else if annotation {
            "annotation_background"
        } else {
            "prepare"
        },
    );
    save_cas(store, Some(&saved), &record)
}

pub(super) fn recover(store: &Store) -> AppResult<()> {
    let root = directory(store)?;
    let ids = {
        let mut statement = store.user.prepare("SELECT id FROM documents WHERE kind='imports' AND json_extract(payload,'$.backgroundJob.status') IN ('queued','running')")?;
        statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    };
    for id in ids {
        // Serialize orphan detection and marking with accepting a replacement
        // job; a read must never interrupt a retry registered in between.
        let active = registry().0.lock().map_err(|_| lock_error())?;
        if !active.jobs.contains_key(&(root.clone(), id.clone())) {
            terminal_failure(
                store,
                &id,
                err(
                    "import_interrupted",
                    "上次解析因应用退出或异常中断；原文件和已完成的识别材料已保留，请点击重新解析继续。",
                ),
                None,
            )?;
        }
    }
    Ok(())
}

fn start(store: &mut Store, model: &ModelClient, payload: &Value) -> AppResult<Value> {
    // stage_import checks both model and OCR before file decoding/writing.
    let root = directory(store)?;
    let operation = operation(payload)?;
    let id = if s(payload, "importId").is_empty() {
        format!("import-{}", &hash_json(&json!(operation))[..24])
    } else {
        s(payload, "importId").to_owned()
    };
    let key = (root.clone(), id.clone());
    let mut active = registry().0.lock().map_err(|_| lock_error())?;
    if active.jobs.contains_key(&key) {
        let record = store.document("imports", &id)?;
        if matches!(s(&record["backgroundJob"], "status"), "queued" | "running") {
            if record["backgroundJob"]["payloadHash"] != hash_json(payload)
                && !replay(&record, operation, &hash_json(payload))?
            {
                return Err(err(
                    "import_running",
                    "此试卷正在后台解析，请等待完成或先停止当前任务。",
                ));
            }
            return Ok(response(store, &record));
        }
        active.jobs.remove(&key);
    }
    let (mut record, _bytes) = match stage_import(store, model, payload, &AtomicBool::new(false))? {
        StagedImport::Existing(record) => return Ok(response(store, &record)),
        StagedImport::Ready(record, bytes) => (record, bytes),
    };
    let previous = record.clone();
    record["recognitionStage"] = json!("queued");
    record["backgroundJob"] = json!({"jobId":format!("import-job-{}",uuid::Uuid::new_v4()),"status":"queued","mode":"import","createdAt":now(),"operationId":operation,"payloadHash":hash_json(payload)});
    save_cas(store, Some(&previous), &record)?;
    let cancel = Arc::new(AtomicBool::new(false));
    active.jobs.insert(key.clone(), cancel.clone());
    drop(active);
    launch(
        store,
        model,
        record,
        operation.to_owned(),
        hash_json(payload),
        cancel,
    )
}
fn needs_annotation(question: &Value) -> bool {
    s(question, "annotationStatus") == "failed"
        || !question["difficultyAssessment"]["level"].is_string()
        || rows(&question["primaryKnowledgeUids"]).is_empty()
}
fn annotation_start(store: &Store, model: &ModelClient, payload: &Value) -> AppResult<Value> {
    if !model.configured() {
        return Err(err("not_configured", "请先配置当前模型，再补充考查信息。"));
    }
    let operation = operation(payload)?;
    let hash = hash_json(payload);
    let root = directory(store)?;
    let id = s(payload, "importId");
    let key = (root, id.to_owned());
    let mut active = registry().0.lock().map_err(|_| lock_error())?;
    let mut record = store.document("imports", id)?;
    if active.jobs.contains_key(&key) {
        if matches!(s(&record["backgroundJob"], "status"), "queued" | "running") {
            if record["backgroundJob"]["payloadHash"] == hash {
                return Ok(response(store, &record));
            }
            return Err(err(
                "import_running",
                "此试卷正在后台处理，请等待完成或先停止当前任务。",
            ));
        }
        active.jobs.remove(&key);
    }
    if replay(&record, operation, &hash)? {
        return Ok(response(store, &record));
    }
    revision(&record, payload)?;
    if record["status"] == "processing" || rows(&record["questions"]).is_empty() {
        return Err(err("invalid_import", "请先完成原卷解析，再补充考查信息。"));
    }
    if record["pendingPublication"].is_object() {
        return Err(err("publication_pending", "请先完成待确认的入库操作。"));
    }
    read_source(store, &record)?;
    paddle::verify_audit(store, &record)?;
    let published = ids(&record["publishedQuestionIds"]);
    let targets = rows(&record["questions"])
        .iter()
        .filter(|question| {
            !published.contains(&s(question, "questionId").to_owned()) && needs_annotation(question)
        })
        .map(|q| q["questionId"].clone())
        .collect::<Vec<_>>();
    if targets.is_empty() {
        return Ok(response(store, &record));
    }
    let saved = record.clone();
    record["recognitionStage"] = json!("annotating");
    record["backgroundJob"] = json!({"jobId":format!("import-job-{}",uuid::Uuid::new_v4()),"mode":"annotation","status":"queued","createdAt":now(),"operationId":operation,"payloadHash":hash,"totalQuestions":targets.len(),"completedQuestions":0,"failedQuestions":0,"targetQuestionIds":targets,"error":null});
    save_cas(store, Some(&saved), &record)?;
    let cancel = Arc::new(AtomicBool::new(false));
    active.jobs.insert(key, cancel.clone());
    drop(active);
    launch(store, model, record, operation.to_owned(), hash, cancel)
}
fn review_start(store: &Store, model: &ModelClient, payload: &Value) -> AppResult<Value> {
    if !model.configured() {
        return Err(err("not_configured", "请先配置当前模型，再进行模型检查。"));
    }
    let operation = operation(payload)?;
    let hash = hash_json(payload);
    let id = s(payload, "importId");
    let key = (directory(store)?, id.to_owned());
    let mut active = registry().0.lock().map_err(|_| lock_error())?;
    let mut record = store.document("imports", id)?;
    if active.jobs.contains_key(&key)
        && matches!(s(&record["backgroundJob"], "status"), "queued" | "running")
    {
        if record["backgroundJob"]["payloadHash"] == hash {
            return Ok(response(store, &record));
        }
        return Err(err(
            "import_running",
            "此试卷正在后台处理，请等待或停止当前任务。",
        ));
    }
    if replay(&record, operation, &hash)? {
        return Ok(response(store, &record));
    }
    revision(&record, payload)?;
    if record["status"] == "processing" || rows(&record["questions"]).is_empty() {
        return Err(err("invalid_import", "请先完成原卷解析。"));
    }
    if record["pendingPublication"].is_object() {
        return Err(err("publication_pending", "请先完成待确认入库操作。"));
    }
    read_source(store, &record)?;
    paddle::verify_audit(store, &record)?;
    let published = ids(&record["publishedQuestionIds"]);
    let targets = rows(&record["questions"])
        .iter()
        .filter(|q| {
            !published.contains(&s(q, "questionId").to_owned())
                && s(q, "reviewDecision") != "reject"
                && !review::model_ready(q, &record)
                && !(s(q, "reviewDecision") == "approve" && check_approved(q, &record).is_ok())
        })
        .map(|q| q["questionId"].clone())
        .collect::<Vec<_>>();
    if targets.is_empty() {
        return Ok(response(store, &record));
    }
    let saved = record.clone();
    record["recognitionStage"] = json!("reviewing");
    record["backgroundJob"] = json!({"jobId":format!("import-job-{}",uuid::Uuid::new_v4()),"mode":"review","status":"queued","createdAt":now(),"operationId":operation,"payloadHash":hash,"totalQuestions":targets.len(),"completedQuestions":0,"failedQuestions":0,"targetQuestionIds":targets,"error":null});
    save_cas(store, Some(&saved), &record)?;
    let cancel = Arc::new(AtomicBool::new(false));
    active.jobs.insert(key, cancel.clone());
    drop(active);
    launch(store, model, record, operation.to_owned(), hash, cancel)
}
fn process_annotation(
    store: &Store,
    model: &ModelClient,
    operation: &str,
    hash: &str,
    cancel: &AtomicBool,
    mut record: Value,
) -> AppResult<()> {
    let id = s(&record, "importId").to_owned();
    let job_id = record["backgroundJob"]["jobId"].clone();
    let targets = rows(&record["backgroundJob"]["targetQuestionIds"]);
    let mut completed = 0usize;
    let mut failed = 0usize;
    let mut last_error = Value::Null;
    for (batch, question_ids) in targets.chunks(5).enumerate() {
        cancelled(cancel)?;
        record = store.document("imports", &id)?;
        if record["backgroundJob"]["jobId"] != job_id {
            return Err(err(
                "job_changed",
                "考查信息任务已变更，本次结果未覆盖当前记录。",
            ));
        }
        let request = json!({"importId":id,"operationId":format!("annotation-{}",&hash_json(&json!([operation,batch]))[..32]),"expectedRevision":record["revision"],"questionIds":question_ids,"backgroundJobId":job_id,"supplementOnly":true});
        let result = structured::step(store, model, &request, cancel)?;
        record = result["import"].clone();
        for question in rows(&record["questions"])
            .iter()
            .filter(|question| question_ids.contains(&question["questionId"]))
        {
            if question["annotationStatus"] == "failed" {
                failed += 1;
                last_error = question["annotationError"].clone();
            }
        }
        completed += question_ids.len();
        let saved = record.clone();
        record["backgroundJob"]["completedQuestions"] = json!(completed);
        record["backgroundJob"]["failedQuestions"] = json!(failed);
        save_cas(store, Some(&saved), &record)?;
    }
    cancelled(cancel)?;
    let saved = record.clone();
    record["backgroundJob"]["finishedAt"] = json!(now());
    record["backgroundJob"]["status"] = json!(if failed > 0 { "failed" } else { "completed" });
    record["backgroundJob"]["error"] = if failed > 0 {
        json!({"code":"annotation_incomplete","message":format!("{failed} 题考查信息未补充成功，已完成批次和原题均保留，可重试。{}",s(&last_error,"message"))})
    } else {
        Value::Null
    };
    finish(&mut record, operation, hash, "annotation_background");
    save_cas(store, Some(&saved), &record)
}
fn launch(
    store: &Store,
    model: &ModelClient,
    mut record: Value,
    operation: String,
    hash: String,
    cancel: Arc<AtomicBool>,
) -> AppResult<Value> {
    let accepted = response(store, &record);
    let model = model.clone();

    let root = directory(store)?;
    let id = s(&record, "importId").to_owned();
    let key = (root.clone(), id.clone());
    let worker_root = root.clone();
    let worker_id = id.clone();
    let cancel_identity = cancel.clone();
    let job_id = record["backgroundJob"]["jobId"].clone();
    let worker_job_id = job_id.clone();
    let spawned = std::thread::Builder::new()
        .name("tutor-paper-import".into())
        .spawn(move || {
            let (mutex, wake) = registry();
            // Two active import requests per workspace; additional uploads queue
            // without occupying the main Runtime or holding a SQLite transaction.
            let mut state = match mutex.lock() {
                Ok(state) => state,
                Err(_) => return,
            };
            while state.running.get(&worker_root).copied().unwrap_or(0) >= 2
                && !cancel.load(Ordering::Relaxed)
            {
                state = match wake.wait_timeout(state, Duration::from_millis(100)) {
                    Ok((state, _)) => state,
                    Err(_) => return,
                };
            }
            *state.running.entry(worker_root.clone()).or_default() += 1;
            drop(state);
            let seed: AppResult<Value> =
                serde_json::from_str(include_str!("../../../resources/seed.json"))
                    .map_err(AppError::from);
            let opened = seed.and_then(|seed| Store::open(&worker_root, &seed));
            if let Ok(mut worker) = opened {
                let outcome =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> AppResult<()> {
                        let saved = record.clone();
                        record["backgroundJob"]["status"] = json!("running");
                        record["backgroundJob"]["startedAt"] = json!(now());
                        let annotation = record["backgroundJob"]["mode"] == "annotation";
                        let review_job = record["backgroundJob"]["mode"] == "review";
                        record["recognitionStage"] = json!(if review_job {
                            "reviewing"
                        } else if annotation {
                            "annotating"
                        } else {
                            "extracting"
                        });
                        save_cas(&worker, Some(&saved), &record)?;
                        cancelled(&cancel)?;
                        if review_job {
                            review::process(&worker, &model, &operation, &hash, &cancel, record)?;
                        } else if annotation {
                            process_annotation(
                                &worker, &model, &operation, &hash, &cancel, record,
                            )?;
                        } else {
                            let bytes = read_source(&worker, &record)?;
                            process_import(
                                &mut worker,
                                &model,
                                &operation,
                                &hash,
                                &cancel,
                                record,
                                bytes,
                            )?;
                        }
                        Ok(())
                    }))
                    .unwrap_or_else(|_| {
                        Err(err(
                            "import_worker_failed",
                            "后台解析意外中断，原件与已识别材料已保留，可重新解析。",
                        ))
                    });
                if let Err(error) = outcome {
                    let _ = terminal_failure(&worker, &worker_id, error, Some(&worker_job_id));
                }
            }
            // If opening the worker storage failed, the persisted running job is
            // recovered as interrupted on the next read/startup, without data loss.
            release_worker(&worker_root, &worker_id, &cancel);
        });
    if spawned.is_err() {
        terminal_failure(
            store,
            &id,
            err(
                "import_worker_failed",
                "无法启动后台解析，原文件已保留，请重试。",
            ),
            Some(&job_id),
        )?;
        {
            let mut active = registry().0.lock().map_err(|_| lock_error())?;
            remove_owned_job(&mut active, &key, &cancel_identity);
        }
        return Ok(response(store, &store.document("imports", &id)?));
    }
    Ok(accepted)
}

pub(super) fn dispatch(
    store: &mut Store,
    model: &ModelClient,
    action: &str,
    payload: &Value,
) -> AppResult<Option<Value>> {
    let result = match action {
        "import_start" => start(store, model, payload)?,
        "import_annotation_start" => annotation_start(store, model, payload)?,
        "import_review_start" => review_start(store, model, payload)?,
        "import_job_get" => {
            recover(store)?;
            response(store, &store.document("imports", s(payload, "importId"))?)
        }
        "import_job_cancel" => {
            let id = s(payload, "importId");
            let record = store.document("imports", id)?;
            if payload.get("jobId").is_some()
                && payload["jobId"] != record["backgroundJob"]["jobId"]
            {
                return Err(err("job_changed", "解析任务已更新，请刷新后再停止。"));
            }
            if let Some(cancel) = registry()
                .0
                .lock()
                .map_err(|_| lock_error())?
                .jobs
                .get(&(directory(store)?, id.to_owned()))
            {
                cancel.store(true, Ordering::Relaxed);
                registry().1.notify_all();
            }
            let mut result = response(store, &record);
            result["cancelRequested"] = json!(true);
            result
        }
        "import_jobs_list" => {
            recover(store)?;
            // Small projected records only: never deserialize OCR pages/assets
            // for global background notifications.
            let mut statement=store.user.prepare("SELECT json_object('importId',id,'filename',json_extract(payload,'$.filename'),'status',json_extract(payload,'$.status'),'recognitionStage',json_extract(payload,'$.recognitionStage'),'updatedAt',json_extract(payload,'$.updatedAt'),'error',json_extract(payload,'$.error'),'backgroundJob',json_extract(payload,'$.backgroundJob')) FROM documents WHERE kind='imports' AND json_type(payload,'$.backgroundJob')='object' ORDER BY COALESCE(CAST(json_extract(payload,'$.backgroundJob.createdAt') AS TEXT),'') DESC,id DESC LIMIT 100")?;
            let records = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .map(|row| serde_json::from_str::<Value>(&row?).map_err(AppError::from))
                .collect::<AppResult<Vec<_>>>()?;
            json!({"jobs":records.iter().map(descriptor).collect::<Vec<_>>()})
        }
        _ => return Ok(None),
    };
    Ok(Some(result))
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::Runtime;
    use std::{
        net::TcpListener,
        sync::mpsc,
        time::{Duration, Instant},
    };

    fn runtime() -> (tempfile::TempDir, Runtime) {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("model-settings.json"), b"{}").unwrap();
        let mut runtime = Runtime::open(directory.path()).unwrap();
        runtime
            .request(
                "profile_save",
                &json!({"nickname":"模拟后台导入回归"}),
                &AtomicBool::new(false),
            )
            .unwrap();
        (directory, runtime)
    }
    fn upload(operation: &str) -> Value {
        json!({"operationId":operation,"filename":"模拟后台原卷.txt","contentBase64":base64::engine::general_purpose::STANDARD.encode("模拟后台回归：计算1+1。")})
    }
    fn mock(
        runtime: &mut Runtime,
        content: Value,
    ) -> (
        mpsc::Receiver<()>,
        mpsc::Sender<()>,
        std::thread::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        runtime.model.save(&json!({"baseUrl":format!("http://{}/v1",listener.local_addr().unwrap()),"model":"simulated-background","apiKey":"simulated-only"})).unwrap();
        let (seen_tx, seen_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(15)))
                .unwrap();
            let mut request = vec![];
            loop {
                let mut chunk = [0u8; 8192];
                let length = stream.read(&mut chunk).unwrap();
                if length == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..length]);
                if let Some(header) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..header]).to_ascii_lowercase();
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("content-length:")
                                .and_then(|length| length.trim().parse::<usize>().ok())
                        })
                        .unwrap();
                    if request.len() >= header + 4 + length {
                        break;
                    }
                }
            }
            seen_tx.send(()).unwrap();
            // The test owns this barrier. A busy parallel suite must not release
            // the provider early and accidentally start a supposedly queued job.
            // Dropping the sender on a failed test also releases this worker.
            if release_rx.recv().is_err() {
                return;
            }
            let response =
                json!({"choices":[{"message":{"content":content.to_string()}}]}).to_string();
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response.len(),
                response
            );
        });
        (seen_rx, release_tx, handle)
    }
    fn question() -> Value {
        json!({"questionType":"fill_blank","sourceLabel":"1","pages":[1],"stem":"模拟后台回归：计算 $1+1=$____。","options":[],"parts":[],"answer":"","solution":"","sectionIds":[],"task":{"label":"模拟加法"},"knowledgeUids":[],"knowledgeTopics":[]})
    }
    fn call(runtime: &mut Runtime, action: &str, payload: Value) -> Value {
        runtime
            .request(action, &payload, &AtomicBool::new(false))
            .unwrap()
    }
    fn done(runtime: &mut Runtime, id: &Value) -> Value {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let result = call(runtime, "import_job_get", json!({"importId":id}));
            if !matches!(s(&result["job"], "status"), "queued" | "running") {
                return result;
            }
            assert!(
                Instant::now() < deadline,
                "background job did not settle: {result}"
            );
            std::thread::sleep(Duration::from_millis(30));
        }
    }
    #[test]
    fn simulated_terminal_retry_replaces_stale_owner_and_late_cleanup_keeps_new_cancel_and_slot() {
        for annotation in [false, true] {
            let (_directory, mut runtime) = runtime();
            let mut record = staged_questions(&runtime, usize::from(annotation));
            record["backgroundJob"] = json!({"jobId":"simulated-old-terminal-job","status":"failed","mode":if annotation {"annotation"}else{"import"},"operationId":"simulated-old-operation","payloadHash":"simulated-old-hash"});
            if !annotation {
                record["status"] = json!("failed");
            }
            runtime
                .store
                .put_document("imports", s(&record, "importId"), &record)
                .unwrap();
            let root = directory(&runtime.store).unwrap();
            let key = (root.clone(), s(&record, "importId").to_owned());
            let old_cancel = Arc::new(AtomicBool::new(false));
            // Reproduce the precise scheduler boundary: terminal DB commit is
            // visible, but its old worker has not released its registry/slot.
            {
                let mut registry = registry().0.lock().unwrap();
                registry.jobs.insert(key.clone(), old_cancel.clone());
                registry.running.insert(root.clone(), 1);
            }
            let content = if annotation {
                metadata(&rows(&record["questions"]), &leaf_uid(&runtime))
            } else {
                json!({"questions":[question()]})
            };
            let (seen, release, server) = mock(&mut runtime, content);
            let action = if annotation {
                "import_annotation_start"
            } else {
                "import_start"
            };
            let accepted = call(
                &mut runtime,
                action,
                json!({"importId":record["importId"],"operationId":"simulated-terminal-immediate-retry","expectedRevision":record["revision"]}),
            );
            assert_ne!(accepted["job"]["jobId"], record["backgroundJob"]["jobId"]);
            seen.recv_timeout(Duration::from_secs(15)).unwrap();
            // The actual production cleanup must recognize the old Arc and
            // leave the replacement registered, counting only the new slot.
            release_worker(&root, s(&record, "importId"), &old_cancel);
            assert_eq!(
                registry().0.lock().unwrap().running.get(&root).copied(),
                Some(1)
            );
            let running = call(
                &mut runtime,
                "import_job_get",
                json!({"importId":record["importId"]}),
            );
            assert_eq!(running["job"]["status"], "running");
            call(
                &mut runtime,
                "import_job_cancel",
                json!({"importId":record["importId"],"jobId":accepted["job"]["jobId"]}),
            );
            assert!(!old_cancel.load(Ordering::Relaxed));
            let cancelled = done(&mut runtime, &record["importId"]);
            assert_eq!(cancelled["job"]["status"], "cancelled");
            assert_eq!(cancelled["job"]["jobId"], accepted["job"]["jobId"]);
            release.send(()).unwrap();
            server.join().unwrap();
        }
    }
    fn staged_questions(runtime: &Runtime, count: usize) -> Value {
        let id = format!("simulated-metadata-{}", uuid::Uuid::new_v4());
        let mut source = save_source(
            &runtime.store,
            &id,
            "txt",
            b"simulated original metadata fixture",
        )
        .unwrap();
        source["physicalPages"] = json!(1);
        let mut questions = vec![];
        for index in 0..count {
            let mut q = question();
            q["sourceLabel"] = json!((index + 1).to_string());
            let mut q = normalize_question(&q, &format!("{id}-q{index}"), 1).unwrap();
            q["reviewDecision"] = json!("approve");
            q["reviewBasis"] = json!("模拟教师已核对题面，测试不代表真实教师采用。");
            q["reviewChecks"] = json!({"sourceMatched":true,"formulaChecked":true,"answerChecked":false,"solutionChecked":false});
            questions.push(q);
        }
        let record = json!({"importId":id,"filename":"模拟元数据原卷.txt","status":"pending_review","revision":1,"createdAt":now(),"updatedAt":now(),"source":source,"questions":questions,"sourceIssues":[],"operations":[],"publishedQuestionIds":[],"publicationHistory":[],"error":null});
        runtime
            .store
            .put_document("imports", s(&record, "importId"), &record)
            .unwrap();
        record
    }
    fn metadata(questions: &[Value], uid: &str) -> Value {
        json!({"questions":questions.iter().map(|q|json!({"questionId":q["questionId"],"task":{"label":"模型新考查描述"},"difficultyAssessment":{"level":"easy","basis":"模拟常规定义单步求值。","rubricVersion":"content-demand-v1"},"knowledgeSchemaVersion":2,"primaryKnowledgeUids":[uid],"solutionPaths":[]})).collect::<Vec<_>>()})
    }
    fn leaf_uid(runtime: &Runtime) -> String {
        rows(&trusted_catalog(&runtime.store).unwrap()["knowledgePoints"])
            .iter()
            .find(|q| q["isLeaf"] == true)
            .unwrap()["uid"]
            .as_str()
            .unwrap()
            .to_owned()
    }
    #[test]
    fn simulated_annotation_batches_preserve_review_and_original_when_later_batch_fails_then_retry()
    {
        let (_directory, mut runtime) = runtime();
        let mut record = staged_questions(&runtime, 6);
        record["questions"][0]["difficultyAssessment"] = json!({"level":"medium","basis":"模拟教师已有难度依据。","rubricVersion":"content-demand-v1"});
        runtime
            .store
            .put_document("imports", s(&record, "importId"), &record)
            .unwrap();
        let original = rows(&record["questions"]);
        let uid = leaf_uid(&runtime);
        let (seen, release, server) = mock(&mut runtime, metadata(&original[..5], &uid));
        let accepted = call(
            &mut runtime,
            "import_annotation_start",
            json!({"importId":record["importId"],"operationId":"simulated-metadata-first","expectedRevision":record["revision"]}),
        );
        assert_eq!(accepted["job"]["mode"], "annotation");
        assert_eq!(accepted["job"]["totalQuestions"], 6);
        seen.recv_timeout(Duration::from_secs(15)).unwrap();
        for action in ["import_review_save", "import_publish"] {
            let error=runtime.request(action,&json!({"importId":record["importId"],"operationId":format!("simulated-blocked-{action}"),"expectedRevision":record["revision"],"questions":record["questions"],"acknowledgeReview":true}),&AtomicBool::new(false)).unwrap_err();
            assert_eq!(error.code, "import_running");
        }
        call(
            &mut runtime,
            "students_create",
            json!({"name":"模拟标注时新增学生","operationId":"simulated-metadata-write"}),
        );
        release.send(()).unwrap();
        server.join().unwrap();
        let failed = done(&mut runtime, &record["importId"]);
        assert_eq!(failed["job"]["status"], "failed", "{failed}");
        assert_eq!(failed["job"]["completedQuestions"], 6);
        assert_eq!(failed["job"]["failedQuestions"], 1);
        assert_eq!(failed["import"]["status"], "pending_review");
        assert!(failed["import"]["error"].is_null());
        assert_eq!(
            failed["import"]["questions"][5]["annotationStatus"],
            "failed"
        );
        assert_eq!(
            failed["import"]["questions"][0]["difficultyAssessment"],
            original[0]["difficultyAssessment"]
        );
        for (index, q) in rows(&failed["import"]["questions"]).iter().enumerate() {
            for field in [
                "stem",
                "questionType",
                "options",
                "parts",
                "answer",
                "solution",
                "sourceLabel",
                "pages",
                "reviewDecision",
                "reviewChecks",
                "reviewBasis",
                "sourceIdentity",
                "student",
                "teacher",
                "assetPayloads",
            ] {
                assert_eq!(
                    q[field], original[index][field],
                    "changed original field {field}"
                );
            }
        }
        let (seen, release, server) = mock(
            &mut runtime,
            metadata(&rows(&failed["import"]["questions"])[5..], &uid),
        );
        let retry = call(
            &mut runtime,
            "import_annotation_start",
            json!({"importId":record["importId"],"operationId":"simulated-metadata-retry","expectedRevision":failed["import"]["revision"]}),
        );
        assert_eq!(retry["job"]["totalQuestions"], 1);
        seen.recv_timeout(Duration::from_secs(15)).unwrap();
        release.send(()).unwrap();
        server.join().unwrap();
        let completed = done(&mut runtime, &record["importId"]);
        assert_eq!(completed["job"]["status"], "completed", "{completed}");
        assert_eq!(completed["import"]["status"], "pending_review");
        // Reviewed ordinary questions retain immutable metadata audit state
        // through a normal review-save round trip.
        let reviewed = call(
            &mut runtime,
            "import_review_save",
            json!({"importId":record["importId"],"operationId":"simulated-metadata-reviewed","expectedRevision":completed["import"]["revision"],"questions":completed["import"]["questions"]}),
        );
        assert_eq!(
            reviewed["import"]["questions"][0]["annotationStatus"],
            "succeeded"
        );
        assert_eq!(
            reviewed["import"]["questions"][0]["annotationAttempts"],
            completed["import"]["questions"][0]["annotationAttempts"]
        );
    }
    #[test]
    fn simulated_annotation_cancel_and_restart_keep_successful_parse_and_review() {
        let (directory, mut runtime) = runtime();
        let record = staged_questions(&runtime, 1);
        let uid = leaf_uid(&runtime);
        let (seen, release, server) =
            mock(&mut runtime, metadata(&rows(&record["questions"]), &uid));
        let accepted = call(
            &mut runtime,
            "import_annotation_start",
            json!({"importId":record["importId"],"operationId":"simulated-metadata-cancel","expectedRevision":record["revision"]}),
        );
        seen.recv_timeout(Duration::from_secs(15)).unwrap();
        call(
            &mut runtime,
            "import_job_cancel",
            json!({"importId":record["importId"]}),
        );
        let cancelled = done(&mut runtime, &record["importId"]);
        release.send(()).unwrap();
        server.join().unwrap();
        assert_eq!(cancelled["job"]["status"], "cancelled");
        assert_eq!(cancelled["import"]["status"], "pending_review");
        assert!(cancelled["import"]["error"].is_null());
        assert_eq!(
            cancelled["import"]["questions"][0]["stem"],
            record["questions"][0]["stem"]
        );
        assert_eq!(
            cancelled["import"]["questions"][0]["reviewChecks"],
            record["questions"][0]["reviewChecks"]
        );
        let mut orphan = cancelled["import"].clone();
        orphan["backgroundJob"]["status"] = json!("running");
        orphan["backgroundJob"]["operationId"] = json!("simulated-metadata-orphan");
        runtime
            .store
            .put_document("imports", s(&record, "importId"), &orphan)
            .unwrap();
        drop(runtime);
        let mut reopened = Runtime::open(directory.path()).unwrap();
        let interrupted = call(
            &mut reopened,
            "import_job_get",
            json!({"importId":record["importId"]}),
        );
        assert_eq!(interrupted["job"]["status"], "interrupted");
        assert_eq!(interrupted["import"]["status"], "pending_review");
        assert!(interrupted["import"]["error"].is_null());
        assert_eq!(accepted["job"]["mode"], "annotation");
    }
    #[test]
    fn simulated_annotation_rechecks_unknown_succeeded_only_and_skips_complete_teacher_or_published()
     {
        let (_directory, mut runtime) = runtime();
        let mut record = staged_questions(&runtime, 3);
        let uid = leaf_uid(&runtime);
        record["questions"][0]["annotationStatus"] = json!("succeeded");
        record["questions"][0]["knowledgeMappingSource"] = json!("teacher_edit");
        record["questions"][1]["difficultyAssessment"] = json!({"level":"medium_hard","basis":"模拟教师完整已有难度依据。","rubricVersion":"content-demand-v1"});
        record["questions"][1]["primaryKnowledgeUids"] = json!([uid]);
        record["questions"][1]["knowledgeSchemaVersion"] = json!(2);
        record["questions"][1]["knowledgeMappingSource"] = json!("teacher_edit");
        record["publishedQuestionIds"] = json!([record["questions"][2]["questionId"]]);
        record["status"] = json!("partially_published");
        runtime
            .store
            .put_document("imports", s(&record, "importId"), &record)
            .unwrap();
        let (seen, release, server) = mock(
            &mut runtime,
            metadata(&rows(&record["questions"])[..1], &uid),
        );
        let accepted = call(
            &mut runtime,
            "import_annotation_start",
            json!({"importId":record["importId"],"operationId":"simulated-metadata-unknown","expectedRevision":record["revision"]}),
        );
        assert_eq!(accepted["job"]["totalQuestions"], 1);
        seen.recv_timeout(Duration::from_secs(15)).unwrap();
        release.send(()).unwrap();
        server.join().unwrap();
        let completed = done(&mut runtime, &record["importId"]);
        assert_eq!(completed["job"]["status"], "completed", "{completed}");
        assert_eq!(completed["import"]["status"], "partially_published");
        assert_eq!(completed["import"]["questions"][1], record["questions"][1]);
        assert_eq!(completed["import"]["questions"][2], record["questions"][2]);
        assert_eq!(
            completed["import"]["questions"][0]["difficultyAssessment"]["level"],
            "easy"
        );
        assert_eq!(
            completed["import"]["questions"][0]["primaryKnowledgeUids"],
            json!([uid])
        );
        assert_eq!(
            completed["import"]["questions"][0]["knowledgeMappingSource"],
            "model"
        );
        for field in ["reviewDecision", "reviewChecks", "reviewBasis"] {
            assert_eq!(
                completed["import"]["questions"][0][field],
                record["questions"][0][field]
            );
        }
    }
    #[test]
    fn simulated_background_import_allows_real_workspace_writes_then_finishes_once() {
        let (directory, mut runtime) = runtime();
        let (seen, release, server) = mock(&mut runtime, json!({"questions":[question()]}));
        let payload = upload("simulated-background-complete");
        let started = Instant::now();
        let accepted = call(&mut runtime, "import_start", payload.clone());
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(accepted["job"]["status"], "queued");
        assert!(!s(&accepted["job"], "jobId").is_empty());
        let id = accepted["import"]["importId"].clone();
        seen.recv_timeout(Duration::from_secs(15)).unwrap();
        let started = Instant::now();
        let created = call(
            &mut runtime,
            "students_create",
            json!({"name":"模拟同时新增","grade":"高一","operationId":"simulated-concurrent-student"}),
        );
        assert_eq!(created["student"]["name"], "模拟同时新增");
        let _ = call(&mut runtime, "bank_search", json!({"pageSize":1}));
        assert!(started.elapsed() < Duration::from_secs(2));
        // Opening another connection during the HTTP request must not mistake
        // the active job for a previous application's interrupted job.
        let mut second = Runtime::open(directory.path()).unwrap();
        let observed = call(&mut second, "import_job_get", json!({"importId":id}));
        assert_eq!(observed["job"]["status"], "running");
        let replayed = call(&mut runtime, "import_start", payload.clone());
        assert_eq!(replayed["job"]["jobId"], accepted["job"]["jobId"]);
        release.send(()).unwrap();
        server.join().unwrap();
        let result = done(&mut runtime, &id);
        // An older provider may omit its opinion: parsing still completes,
        // but no automatic extra model request or publication is permitted.
        assert_eq!(result["job"]["status"], "completed", "{result}");
        assert_eq!(result["job"]["mode"], "import");
        assert_eq!(
            result["import"]["questions"][0]["modelReview"]["status"],
            "failed"
        );
        assert_eq!(result["import"]["status"], "pending_review");
        assert_eq!(result["import"]["questions"].as_array().unwrap().len(), 1);
        assert_eq!(
            result["reviewRequirements"][s(&result["import"]["questions"][0], "questionId")],
            json!(["sourceMatched", "formulaChecked"])
        );
        let replayed = call(&mut runtime, "import_start", payload);
        assert_eq!(replayed["import"], result["import"]);
        assert_eq!(
            rows(&call(&mut runtime, "import_jobs_list", json!({}))["jobs"]).len(),
            1
        );
        assert_eq!(runtime.store.students("").unwrap().len(), 1);
    }
    #[test]
    fn simulated_background_cancel_is_independent_and_retry_reuses_original() {
        let (directory, mut runtime) = runtime();
        let (seen, release, server) = mock(&mut runtime, json!({"questions":[question()]}));
        let accepted = call(
            &mut runtime,
            "import_start",
            upload("simulated-background-cancel"),
        );
        let id = accepted["import"]["importId"].clone();
        seen.recv_timeout(Duration::from_secs(15)).unwrap();
        let global_cancel = AtomicBool::new(false);
        runtime
            .request(
                "import_job_cancel",
                &json!({"importId":id,"jobId":accepted["job"]["jobId"]}),
                &global_cancel,
            )
            .unwrap();
        assert!(!global_cancel.load(Ordering::Relaxed));
        let cancelled = done(&mut runtime, &id);
        release.send(()).unwrap();
        server.join().unwrap();
        assert_eq!(cancelled["job"]["status"], "cancelled", "{cancelled}");
        assert_eq!(cancelled["import"]["error"]["code"], "cancelled");
        let original = directory
            .path()
            .join(s(&cancelled["import"]["source"], "relativePath"));
        assert!(original.exists());
        let (seen, release, server) = mock(&mut runtime, json!({"questions":[question()]}));
        let retry = call(
            &mut runtime,
            "import_start",
            json!({"importId":id,"operationId":"simulated-background-retry","expectedRevision":cancelled["import"]["revision"]}),
        );
        assert_ne!(retry["job"]["jobId"], accepted["job"]["jobId"]);
        seen.recv_timeout(Duration::from_secs(15)).unwrap();
        release.send(()).unwrap();
        server.join().unwrap();
        let complete = done(&mut runtime, &id);
        assert_eq!(complete["job"]["status"], "completed", "{complete}");
        assert_eq!(complete["job"]["mode"], "import");
        assert_eq!(complete["import"]["status"], "pending_review");
        assert_eq!(complete["import"]["source"], cancelled["import"]["source"]);
    }
    #[test]
    fn simulated_multiple_uploads_queue_and_queued_cancel_never_calls_provider() {
        let (_directory, mut runtime) = runtime();
        let (seen_a, release_a, server_a) = mock(&mut runtime, json!({"questions":[question()]}));
        let first = call(
            &mut runtime,
            "import_start",
            upload("simulated-background-queue-first"),
        );
        seen_a.recv_timeout(Duration::from_secs(15)).unwrap();
        let (seen_b, release_b, server_b) = mock(&mut runtime, json!({"questions":[question()]}));
        let second = call(
            &mut runtime,
            "import_start",
            upload("simulated-background-queue-second"),
        );
        seen_b.recv_timeout(Duration::from_secs(15)).unwrap();
        let third = call(
            &mut runtime,
            "import_start",
            upload("simulated-background-queue-third"),
        );
        std::thread::sleep(Duration::from_millis(120));
        let observed = call(
            &mut runtime,
            "import_job_get",
            json!({"importId":third["import"]["importId"]}),
        );
        assert_eq!(observed["job"]["status"], "queued");
        let jobs = call(&mut runtime, "import_jobs_list", json!({}));
        assert_eq!(
            rows(&jobs["jobs"])
                .iter()
                .filter(|job| job["status"] == "running")
                .count(),
            2
        );
        assert_eq!(
            rows(&jobs["jobs"])
                .iter()
                .filter(|job| job["status"] == "queued")
                .count(),
            1
        );
        call(
            &mut runtime,
            "import_job_cancel",
            json!({"importId":third["import"]["importId"]}),
        );
        let cancelled = done(&mut runtime, &third["import"]["importId"]);
        assert_eq!(cancelled["job"]["status"], "cancelled");
        assert!(rows(&cancelled["import"]["modelAttempts"]).is_empty());
        release_a.send(()).unwrap();
        release_b.send(()).unwrap();
        server_a.join().unwrap();
        server_b.join().unwrap();
        assert_eq!(
            done(&mut runtime, &first["import"]["importId"])["job"]["status"],
            "completed"
        );
        assert_eq!(
            done(&mut runtime, &second["import"]["importId"])["job"]["status"],
            "completed"
        );
    }
    #[test]
    fn simulated_restart_marks_only_orphan_jobs_interrupted_and_keeps_audits() {
        let (directory, runtime) = runtime();
        let record = json!({"importId":"simulated-orphan","filename":"模拟重启.txt","status":"processing","revision":4,"createdAt":now(),"updatedAt":now(),"backgroundJob":{"jobId":"simulated-job","status":"running","operationId":"simulated-orphan-operation","payloadHash":"simulated-request-hash","createdAt":now()},"recognitionStage":"structuring","extractedPages":["模拟已经识别原文"],"ocrSource":{"manifestSha256":"simulated-frozen-hash"},"questions":[],"operations":[],"modelAttempts":[{"status":"processing","attemptSha256":"simulated-audit"}]});
        runtime
            .store
            .put_document("imports", "simulated-orphan", &record)
            .unwrap();
        drop(runtime);
        let mut reopened = Runtime::open(directory.path()).unwrap();
        let result = call(
            &mut reopened,
            "import_job_get",
            json!({"importId":"simulated-orphan"}),
        );
        assert_eq!(result["job"]["status"], "interrupted");
        assert_eq!(result["import"]["error"]["code"], "import_interrupted");
        assert_eq!(result["import"]["revision"], 5);
        assert_eq!(result["import"]["extractedPages"], record["extractedPages"]);
        assert_eq!(result["import"]["ocrSource"], record["ocrSource"]);
        assert_eq!(result["import"]["modelAttempts"], record["modelAttempts"]);
        let second = call(
            &mut reopened,
            "import_job_get",
            json!({"importId":"simulated-orphan"}),
        );
        assert_eq!(second["import"], result["import"]);
    }
}
