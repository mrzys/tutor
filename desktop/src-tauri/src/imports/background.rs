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
    let teaching_retry = job["mode"] == "teaching_retry";
    let accuracy_repair = job["mode"] == "accuracy_repair";
    let stage = if status == "queued" {
        "queued"
    } else {
        s(record, "recognitionStage")
    };
    let mut message = match status.as_str() {
        "queued" => {
            if accuracy_repair {
                "排队等待本题修订及核验，可继续其它操作。"
            } else if teaching_retry {
                "排队等待重新生成本题解析，可继续查看其它题目。"
            } else if review {
                "排队等待模型检查，可继续其它操作。"
            } else if annotation {
                "排队等待补充考查信息，可继续其它操作。"
            } else {
                "排队等待识别，可继续其它操作。"
            }
        }
        "running" => match stage {
            "recognizing" => "正在识别原卷，可继续其它操作。",
            "structuring" => "正在分批转录原题，可继续其它操作。",
            "source_indexing" => "正在关联跨页题目与原卷答案，识别材料已保存。",
            "source_validating" => "正在校验整卷题号、图表与来源完整性。",
            "annotating" => "正在补充考查信息，可继续其它操作。",
            "reviewing" => "正在对照原卷逐题检查，可继续其它操作。",
            "teaching_review" => "正在复核命中问题的教学稿，可继续其它操作。",
            "teaching_generating" => "正在分批生成课堂教学稿，可继续其它操作。",
            "teaching_checking" => "正在检查教学稿结构、显示及已知问题。",
            "accuracy_processing" => "正在核对来源、解答和教学信息，已有结果持续保存。",
            _ => "正在准备原卷，可继续其它操作。",
        },
        "completed" => {
            if accuracy_repair {
                "本题修订与核验已结束，请查看具体结果后确认入库。"
            } else if teaching_retry {
                "本题解析生成已结束，请查看结果；不会自动追加复核。"
            } else if review {
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
    if status == "running" && stage == "structuring" && (record["sourceStructuring"].is_object() || record["sourceBatchProgress"].is_object()) {
        let batches = rows(&record["sourceStructuring"]["batches"]);
        let total = record["sourceBatchProgress"]["total"].as_u64().map(|n| n as usize).unwrap_or(batches.len());
        let completed = record["sourceBatchProgress"]["completed"].as_u64().map(|n| n as usize).unwrap_or_else(|| batches.iter().filter(|batch| batch["status"] == "succeeded").count());
        message = if total == 0 {
            "正在关联跨页题目与原卷答案，识别材料已保存。".into()
        } else {
            format!("正在分批整理原题，已保存 {completed}/{total} 批；已完成批次会在继续时保留。")
        };
        job["sourceBatchCount"] = json!(total);
        job["completedSourceBatches"] = json!(completed);
    }
    job["stage"] = json!(stage);
    // Stage and error family are independent display metadata. This function
    // is also called on the lightweight SQL projection: no provider/audit IO.
    let process = diagnostics::process_metadata(record);
    job["stageKey"] = process["stageKey"].clone();
    job["stageLabel"] = process["stageLabel"].clone();
    if status == "failed" {
        for (target, source) in [
            ("errorCategory", "category"), ("errorCategoryLabel", "categoryLabel"),
            ("errorSubcategory", "subcategory"), ("errorSubcategoryLabel", "subcategoryLabel"),
            ("errorServiceLabel", "serviceLabel"), ("errorOperationLabel", "operationLabel"),
            ("errorCauseNote", "causeNote"), ("errorEvidenceBasis", "evidenceBasis"),
        ] { job[target] = process[source].clone(); }
    }
    job["message"] = json!(message);
    job["importId"] = record["importId"].clone();
    job["filename"] = record["filename"].clone();
    job["updatedAt"] = record["updatedAt"].clone();
    // Internal payload hashes/operation identity are not needed by the UI.
    job.as_object_mut().unwrap().remove("payloadHash");
    job.as_object_mut().unwrap().remove("operationId");
    job.as_object_mut().unwrap().remove("targetQuestionIds");
    job.as_object_mut().unwrap().remove("payload");
    job.as_object_mut().unwrap().remove("basis");
    job
}
fn response(store: &Store, record: &Value) -> Value {
    json!({"job":descriptor(record),"import":record,"diagnostic":diagnostics::for_record(store,record),"reviewRequirements":review_requirement_map(record),"reviewEligibility":review::eligibility(record)})
}

fn job_get(store: &Store, payload: &Value) -> AppResult<Value> {
    // Recovery must run before comparing snapshots, including after a restart.
    recover(store)?;
    let id = s(payload, "importId");
    let persisted = store.document_json("imports", id)?;
    // Checkpoints can change without advancing the review revision or clock.
    // This token only suppresses unchanged reads; it grants no review authority.
    let record: Value = serde_json::from_str(&persisted)?;
    let version = accuracy::detail_version(store,&record,&sha(persisted.as_bytes()))?;
    if payload["knownDetailVersion"].as_str() == Some(version.as_str()) {
        return Ok(json!({"importId":id,"detailVersion":version,"notModified":true}));
    }
    let projected=accuracy::project_record(store,&record)?;
    let mut result = response(store, &projected);
    result["reviewEligibility"]=review_eligibility(store,&projected)?;
    result["detailVersion"] = json!(version);
    Ok(result)
}

#[cfg(test)]
#[path = "background_snapshot_tests.rs"]
mod snapshot_tests;

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
    if !s(&saved,"accuracyRunId").is_empty() {accuracy::pause(store,&saved)?;}
    let mut record = saved.clone();
    let annotation = record["backgroundJob"]["mode"] == "annotation";
    let review = record["backgroundJob"]["mode"] == "review";
    if record["backgroundJob"]["mode"] == "teaching_retry" {
        let targets=ids(&record["backgroundJob"]["targetQuestionIds"]);
        for q in record["questions"].as_array_mut().into_iter().flatten() {
            if targets.contains(&s(q,"questionId").to_owned()) && q["teachingWorkflow"]["status"]=="generating" {
                q["teachingWorkflow"]["status"]=json!("needs_review");
                q["teachingWorkflow"]["findings"]=json!([{"type":"technical","code":"generation_interrupted","message":"本题生成中断，原尝试已保留；可显式重试。"}]);
            }
        }
    }
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
        || s(&question["task"], "label").trim().is_empty()
        || (rows(&question["solutionPaths"]).is_empty()
            && structured::ready_teaching_reference(question).is_some())
}
/// Stage a new strategy against saved source material. No model is called here.
/// The bool distinguishes a newly queued operation from an exact replay.
pub(super) fn stage_strategy_continue(store:&Store,model:&ModelClient,payload:&Value)->AppResult<(Value,bool)>{
    let operation=operation(payload)?;let hash=hash_json(payload);
    let mut record=store.document("imports",s(payload,"importId"))?;
    let history=rows(&record["accuracyStrategyHistory"]);
    if let Some(previous)=history.iter().find(|entry|entry["operationId"]==operation) {
        if previous["payloadHash"]!=hash {return Err(err("operation_conflict","此策略修订操作身份已用于不同请求。"));}
        return Ok((record,false));
    }
    if replay(&record,operation,&hash)? {return Err(err("operation_conflict","此操作身份已用于其它导入操作，未再次切换策略。"));}
    revision(&record,payload)?;
    if s(&record,"accuracyRunId").is_empty(){return Err(err("invalid_operation","旧导入保留原策略，不能通过策略继续入口自动升级。"));}
    if matches!(s(&record["backgroundJob"],"status"),"queued"|"running") {return Err(err("import_running","此试卷仍在后台处理，请完成或停止后再切换策略。"));}
    if payload["acknowledge"]!=true {return Err(err("review_required","请明确确认使用新版处理策略，并沿用原预算继续核验。"));}
    if record["pendingPublication"].is_object()||record["pendingTeachingPublication"].is_object(){return Err(err("publication_pending","请先完成待确认的发布操作，再切换处理策略。"));}
    let questions=rows(&record["questions"]);
    if questions.is_empty(){return Err(err("accuracy_source_required","请先完成原卷来源整理；策略继续仅处理已保存原题，不重新发起来源请求。"));}
    let published=ids(&record["publishedQuestionIds"]);
    if questions.iter().all(|question|published.iter().any(|id|id==s(question,"questionId"))) {return Err(err("immutable_question","本卷题目已全部入库，不能通过策略继续重跑已发布题目。"));}
    accuracy::validate_configuration(model)?;
    read_source(store,&record)?;paddle::verify_audit(store,&record)?;
    verify_recovered_source_for_publication(store,&record)?;
    let prior=s(&record,"accuracyRunId").to_owned();
    let old_run=accuracy::store::load_run(store,&prior)?;
    let identity=json!({"sha256":record["source"]["sha256"],"relativePath":record["source"]["relativePath"],"extension":record["source"]["extension"],"byteLength":record["source"]["byteLength"]});
    if old_run["importId"]!=record["importId"]||old_run["source"]!=identity {return Err(err("accuracy_integrity","原件身份与冻结策略不一致，未切换策略。"));}
    accuracy::store::check_strategy_continuation_budget(store,&prior)?;
    let saved=record.clone();
    accuracy::revise_run(store,model,&mut record)?;
    let next=accuracy::store::load_run(store,s(&record,"accuracyRunId"))?;
    if next["id"]==old_run["id"]||next["operationBudget"]["parentBudgetId"]!=old_run["id"]||next["source"]!=old_run["source"] {return Err(err("accuracy_integrity","策略修订没有继承原件和原预算，未启动任务。"));}
    let mut history=history;
    history.push(json!({"priorRunId":prior,"newRunId":record["accuracyRunId"],"operationId":operation,"payloadHash":hash,"createdAt":now()}));
    record["accuracyStrategyHistory"]=json!(history);
    record["status"]=json!("processing");record["error"]=Value::Null;record["recognitionStage"]=json!("queued");
    record["backgroundJob"]=json!({"jobId":format!("import-job-{}",uuid::Uuid::new_v4()),"mode":"import","status":"queued","createdAt":now(),"operationId":operation,"payloadHash":hash,"payload":payload,"strategyContinuation":true});
    save_cas(store,Some(&saved),&record)?;
    if next["strategy"]["unknownUsagePolicy"]=="retain-reservation-continue-other-questions-v1" {
        accuracy::store::resume_unknown_strategy_chain(store,s(&next,"id"),&record)?;
    }
    Ok((record,true))
}
fn strategy_continue(store:&Store,model:&ModelClient,payload:&Value)->AppResult<Value>{
    let root=directory(store)?;let key=(root,s(payload,"importId").to_owned());
    let mut active=registry().0.lock().map_err(|_|lock_error())?;
    let (record,queued)=stage_strategy_continue(store,model,payload)?;
    if !queued {return Ok(response(store,&record));}
    let cancel=Arc::new(AtomicBool::new(false));active.jobs.insert(key,cancel.clone());drop(active);
    launch(store,model,record,operation(payload)?.to_owned(),hash_json(payload),cancel)
}
fn accuracy_repair_start(store:&Store,model:&ModelClient,payload:&Value)->AppResult<Value>{
    let operation=operation(payload)?;let hash=hash_json(payload);
    let root=directory(store)?;let id=s(payload,"importId");let key=(root,id.to_owned());
    let mut active=registry().0.lock().map_err(|_|lock_error())?;
    let mut record=store.document("imports",id)?;
    if matches!(s(&record["backgroundJob"],"status"),"queued"|"running") {
        if record["backgroundJob"]["payloadHash"]==hash {return Ok(response(store,&record));}
        return Err(err("import_running","此试卷正在后台处理，请等待完成或先停止。"));
    }
    if replay(&record,operation,&hash)? {return Ok(response(store,&record));}
    revision(&record,payload)?;
    if record["pendingPublication"].is_object()||record["pendingTeachingPublication"].is_object(){return Err(err("publication_pending","请先完成待确认的发布操作。"));}
    accuracy::validate_action(store,&record,payload)?;
    model.import_teaching_reviewer()?;
    read_source(store,&record)?;paddle::verify_audit(store,&record)?;
    let saved=record.clone();
    record["recognitionStage"]=json!("queued");
    record["backgroundJob"]=json!({"jobId":format!("import-job-{}",uuid::Uuid::new_v4()),"mode":"accuracy_repair","status":"queued","createdAt":now(),"operationId":operation,"payloadHash":hash,"targetQuestionIds":[payload["questionId"]],"totalQuestions":1,"completedQuestions":0,"failedQuestions":0,"payload":payload,"basis":payload["basis"]});
    save_cas(store,Some(&saved),&record)?;
    let cancel=Arc::new(AtomicBool::new(false));active.jobs.insert(key,cancel.clone());drop(active);
    launch(store,model,record,operation.to_owned(),hash,cancel)
}
pub(super) fn annotation_target_ids(record: &Value) -> Vec<Value> {
    let published = ids(&record["publishedQuestionIds"]);
    rows(&record["questions"])
        .iter()
        .filter(|question| {
            !published.contains(&s(question, "questionId").to_owned()) && needs_annotation(question)
        })
        .map(|q| q["questionId"].clone())
        .collect()
}
fn teaching_retry_start(store: &Store, model: &ModelClient, payload: &Value) -> AppResult<Value> {
    let operation=operation(payload)?;let hash=hash_json(payload);
    let root=directory(store)?;let id=s(payload,"importId");let key=(root,id.to_owned());
    let mut active=registry().0.lock().map_err(|_|lock_error())?;
    let mut record=store.document("imports",id)?;
    if record["backgroundJob"]["payloadHash"]==hash && matches!(s(&record["backgroundJob"],"status"),"queued"|"running") { return Ok(response(store,&record)); }
    if replay(&record,operation,&hash)? {return Ok(response(store,&record));}
    revision(&record,payload)?;
    if payload["acknowledgeModelCall"]!=true {return Err(err("review_required","请确认本次只重新生成当前题，可能产生模型费用。"));}
    if matches!(s(&record["backgroundJob"],"status"),"queued"|"running")||record["pendingPublication"].is_object()||record["pendingTeachingPublication"].is_object(){return Err(err("import_running","请先完成当前后台任务或发布操作。"));}
    let qid=s(payload,"questionId");
    let q=rows(&record["questions"]).into_iter().find(|q|q["questionId"]==qid).ok_or_else(||err("invalid_teaching_retry_targets","请指定本次导入中的一道题。"))?;
    if !teaching_actions::retry_eligible(&q)||!question_issues(&q,&record["sourceIssues"]).is_empty(){return Err(err("teaching_retry_ineligible","仅允许重新生成来源未变化、无有效候选稿的技术失败题。"));}
    // Resolve configured role before accepting work, without provider discovery.
    model.import_generator()?;
    read_source(store,&record)?;paddle::verify_audit(store,&record)?;
    let previous=record.clone();
    record["backgroundJob"]=json!({"jobId":format!("import-job-{}",uuid::Uuid::new_v4()),"mode":"teaching_retry","status":"queued","createdAt":now(),"operationId":operation,"payloadHash":hash,"targetQuestionIds":[qid],"totalQuestions":1,"completedQuestions":0,"failedQuestions":0});
    save_cas(store,Some(&previous),&record)?;
    let cancel=Arc::new(AtomicBool::new(false));active.jobs.insert(key,cancel.clone());drop(active);
    launch(store,model,record,operation.to_owned(),hash,cancel)
}
fn process_teaching_retry(store:&Store,model:&ModelClient,operation:&str,hash:&str,cancel:&AtomicBool,mut record:Value)->AppResult<()> {
    let targets=ids(&record["backgroundJob"]["targetQuestionIds"]);
    if targets.len()!=1{return Err(err("invalid_teaching_retry_targets","单题重试目标不完整。"));}
    let index=rows(&record["questions"]).iter().position(|q|q["questionId"]==targets[0]).ok_or_else(||err("invalid_teaching_retry_targets","单题重试目标失效。"))?;
    if !teaching_actions::retry_eligible(&record["questions"][index]){return Err(err("teaching_retry_ineligible","单题重试条件已变化。"));}
    let before_questions=rows(&record["questions"]);let mut saved=record.clone();
    let prior=record["questions"][index]["teachingWorkflow"].clone();
    let mut history=rows(&record["questions"][index]["teachingRecoveryHistory"]);
    history.push(json!({"operationId":operation,"recordedAt":now(),"previousWorkflow":prior,"task":"generation_only"}));
    record["questions"][index]["teachingRecoveryHistory"]=json!(history);
    let assets=if record["ocrSource"].is_object(){paddle::load_document(store,&record)?.assets}else{vec![]};
    save_cas(store,Some(&saved),&record)?;saved=record.clone();
    // One explicit generation, with no implicit review or reset of spent quota.
    let outcome=teaching::generate(store,model,&mut record,&mut saved,&assets,cancel,Some(&[index]),Some(operation));
    record["recognitionStage"]=json!("complete");
    record["backgroundJob"]["status"]=json!(if outcome.is_ok(){"completed"}else{"failed"});
    record["backgroundJob"]["finishedAt"]=json!(now());
    let failed=outcome.is_err()||record["questions"][index]["teachingWorkflow"]["status"]=="generation_failed";
    record["backgroundJob"]["completedQuestions"]=json!(1);
    record["backgroundJob"]["failedQuestions"]=json!(usize::from(failed));
    if let Err(error)=outcome {
        if record["questions"][index]["teachingWorkflow"]["status"]=="generating" {
            record["questions"][index]["teachingWorkflow"]["status"]=json!("needs_review");
            record["questions"][index]["teachingWorkflow"]["findings"]=json!([{"type":"technical","code":"generation_interrupted","message":"本题生成中断，原尝试已保留；可显式重试。"}]);
        }
        record["backgroundJob"]["error"]=serde_json::to_value(error)?;
    }
    finish(&mut record,operation,hash,"teaching_retry_generation_only");
    debug_assert!(before_questions.iter().enumerate().all(|(i,q)|i==index||q==&record["questions"][i]));
    save_cas(store,Some(&saved),&record)
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
    if record["pendingPublication"].is_object() || record["pendingTeachingPublication"].is_object() {
        return Err(err("publication_pending", "请先完成待确认的入库操作。"));
    }
    read_source(store, &record)?;
    paddle::verify_audit(store, &record)?;
    let targets = annotation_target_ids(&record);
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
    if !import_role_configured(model, "importSourceConfigured") {
        return Err(err("not_configured", "请先配置拆题模型，再对照原卷检查。"));
    }
    let source_model = model.import_source_model()?;
    let model = &source_model;
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
    if record["pendingPublication"].is_object() || record["pendingTeachingPublication"].is_object() {
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
                        let teaching_retry = record["backgroundJob"]["mode"] == "teaching_retry";
                        let accuracy_repair = record["backgroundJob"]["mode"] == "accuracy_repair";
                        record["recognitionStage"] = json!(if accuracy_repair {
                            "accuracy_processing"
                        } else if review_job {
                            "reviewing"
                        } else if annotation {
                            "annotating"
                        } else {
                            "extracting"
                        });
                        save_cas(&worker, Some(&saved), &record)?;
                        cancelled(&cancel)?;
                        if accuracy_repair {
                            accuracy::repair_job(&mut worker,&model,record,&cancel)?;
                        } else if teaching_retry {
                            process_teaching_retry(&worker,&model,&operation,&hash,&cancel,record)?;
                        } else if review_job {
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
        "import_accuracy_start" => {
            if !s(payload,"importId").is_empty() {
                let record=store.document("imports",s(payload,"importId"))?;
                if s(&record,"accuracyRunId").is_empty() {
                    return Err(err("accuracy_new_import_required","既有导入保留原处理策略；请新建导入使用准确性核验流程。"));
                }
            }
            let mut input=payload.clone();
            input["accuracyStrategy"]=json!(accuracy::current_strategy_version());
            start(store,model,&input)?
        }
        "import_accuracy_strategy_continue"=>strategy_continue(store,model,payload)?,
        "import_start" => start(store, model, payload)?,
        "import_accuracy_repair_start" => accuracy_repair_start(store,model,payload)?,
        "import_teaching_retry_start"|"import_annotation_start"|"import_review_start" => {
            let record=store.document("imports",s(payload,"importId"))?;
            if !s(&record,"accuracyRunId").is_empty() {
                return Err(err("accuracy_action_required","本次导入使用准确性核验流程，请继续该流程或显式修订；旧检查与教学稿入口不适用。"));
            }
            match action {
                "import_teaching_retry_start"=>teaching_retry_start(store,model,payload)?,
                "import_annotation_start"=>annotation_start(store,model,payload)?,
                _=>review_start(store,model,payload)?,
            }
        }
        "import_job_get" => {
            job_get(store, payload)?
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
            let mut statement=store.user.prepare("SELECT json_object('importId',id,'filename',json_extract(payload,'$.filename'),'status',json_extract(payload,'$.status'),'recognitionStage',json_extract(payload,'$.recognitionStage'),'updatedAt',json_extract(payload,'$.updatedAt'),'error',json_extract(payload,'$.error'),'backgroundJob',json_extract(payload,'$.backgroundJob'),'sourceBatchProgress',CASE WHEN json_type(payload,'$.sourceStructuring')='object' THEN json_object('total',json_array_length(payload,'$.sourceStructuring.batches'),'completed',(SELECT count(*) FROM json_each(json_extract(payload,'$.sourceStructuring.batches')) WHERE json_extract(value,'$.status')='succeeded')) ELSE NULL END) FROM documents WHERE kind='imports' AND json_type(payload,'$.backgroundJob')='object' ORDER BY COALESCE(CAST(json_extract(payload,'$.backgroundJob.createdAt') AS TEXT),'') DESC,id DESC LIMIT 100")?;
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

#[cfg(test)]
mod accuracy_entry_tests {
    use super::*;

    #[test]
    fn new_entry_requires_explicit_roles_before_decoding_or_preserving_upload(){
        let dir=tempfile::tempdir().unwrap();
        let mut store=Store::open(dir.path(),&crate::bank::tests::seed()).unwrap();
        let model=ModelClient::test_client(dir.path(),"http://127.0.0.1:1/v1");
        let error=dispatch(&mut store,&model,"import_accuracy_start",&json!({"operationId":"simulated-missing-accuracy-role","filename":"模拟新导入.txt","contentBase64":"invalid-base64"})).unwrap_err();
        assert!(matches!(error.code.as_str(),"import_model_not_configured"|"not_configured"),"{error:?}");
        let count:i64=store.user.query_row("SELECT COUNT(*) FROM documents WHERE kind='imports'",[],|row|row.get(0)).unwrap();
        assert_eq!(count,0);
        assert!(!dir.path().join("imports").exists());
    }

    #[test]
    fn new_entry_does_not_upgrade_legacy_records_or_call_old_review_roles(){
        let dir=tempfile::tempdir().unwrap();
        let mut store=Store::open(dir.path(),&crate::bank::tests::seed()).unwrap();
        let model=ModelClient::test_client(dir.path(),"http://127.0.0.1:1/v1");
        let legacy=json!({"importId":"simulated-legacy-entry","revision":0,"questions":[],"status":"failed"});
        store.put_document("imports","simulated-legacy-entry",&legacy).unwrap();
        let input=json!({"importId":"simulated-legacy-entry","expectedRevision":0,"operationId":"simulated-illegal-upgrade"});
        assert_eq!(dispatch(&mut store,&model,"import_accuracy_start",&input).unwrap_err().code,"accuracy_new_import_required");
        assert_eq!(store.document("imports","simulated-legacy-entry").unwrap(),legacy);
        let new=json!({"importId":"simulated-new-entry","revision":0,"accuracyRunId":"simulated-run-id","questions":[],"status":"failed"});
        store.put_document("imports","simulated-new-entry",&new).unwrap();
        for action in ["import_teaching_retry_start","import_annotation_start","import_review_start"]{
            assert_eq!(dispatch(&mut store,&model,action,&json!({"importId":"simulated-new-entry","operationId":"simulated-block-old-role"})).unwrap_err().code,"accuracy_action_required");
        }
        assert_eq!(store.document("imports","simulated-new-entry").unwrap(),new);
    }
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

    #[test]
    fn global_jobs_project_source_progress_without_checkpoint_question_content() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path(), &crate::bank::tests::seed()).unwrap();
        let model = ModelClient::test_client(dir.path(), "http://127.0.0.1:1/v1");
        let id = "simulated-source-progress";
        let record = json!({"importId":id,"filename":"模拟分批.pdf","status":"processing","recognitionStage":"structuring","backgroundJob":{"status":"running","createdAt":"2026-10-24T01:00:00Z"},"sourceStructuring":{"batches":[{"status":"succeeded","questions":[{"private":"checkpoint_question_must_stay_local"}]},{"status":"failed"}]}});
        store.put_document("imports", id, &record).unwrap();
        let root = directory(&store).unwrap();
        let owner = Arc::new(AtomicBool::new(false));
        registry().0.lock().unwrap().jobs.insert((root.clone(), id.into()), owner.clone());
        let result = dispatch(&mut store, &model, "import_jobs_list", &json!({}));
        remove_owned_job(&mut registry().0.lock().unwrap(), &(root, id.into()), &owner);
        let result = result.unwrap().unwrap();
        assert_eq!(result["jobs"][0]["sourceBatchCount"], 2);
        assert_eq!(result["jobs"][0]["completedSourceBatches"], 1);
        assert_eq!(result["jobs"][0]["stageKey"], "source_transcription");
        assert_eq!(result["jobs"][0]["stageLabel"], "分批转录原题");
        assert!(s(&result["jobs"][0], "message").contains("1/2"));
        assert!(!result.to_string().contains("checkpoint_question_must_stay_local"));
        assert_eq!(store.document("imports", id).unwrap(), record);
    }

    #[test]
    fn failed_job_reports_actual_subtask_and_failure_family_without_mutation() {
        let record=json!({"status":"pending_review","recognitionStage":"annotating","filename":"模拟.pdf",
            "error":{"code":"model_output_invalid_json","message":"模拟旧失败"},
            "backgroundJob":{"status":"failed","mode":"annotation","error":{"code":"model_catalog_error","message":"获取模型列表超时，请重试。"}}});
        let before=record.clone();let job=descriptor(&record);
        assert_eq!(job["stageKey"],"annotation");assert_eq!(job["errorCategory"],"infrastructure");
        assert_eq!(job["errorSubcategory"],"network");assert_eq!(job["errorOperationLabel"],"获取服务商模型列表");
        assert_eq!(record,before);
    }

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
        let content=teaching::simulated_complete_response(content);
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
    fn simulated_worker_progress_is_observable_after_commit_without_detail_polling() {
        let (directory, mut runtime) = runtime();
        let (seen, release, server) = mock(&mut runtime, json!({"questions":[question()]}));
        let database = directory.path().join("personal.sqlite");
        let (send, receive) = mpsc::channel();
        let _subscription = crate::import_events::subscribe(directory.path(), move |event| {
            let connection = rusqlite::Connection::open(&database).unwrap();
            let persisted: String = connection.query_row("SELECT payload FROM documents WHERE kind='imports' AND id=?1",
                [s(&event,"importId")], |row|row.get(0)).unwrap();
            let snapshot: Value = serde_json::from_str(&persisted).unwrap();
            assert_eq!(snapshot["revision"],event["revision"]);
            assert_eq!(snapshot["status"],event["status"]);
            assert!(event.to_string().len()<350);
            assert!(event.get("questions").is_none());
            send.send((event,snapshot["backgroundJob"]["status"].clone())).unwrap();
        }).unwrap();
        let mut input = upload("simulated-progress-no-poll");
        input["responseScope"] = json!("summary");
        let accepted = call(&mut runtime,"import_start",input);
        assert!(accepted["summary"].is_object());
        assert!(accepted.get("import").is_none());
        seen.recv_timeout(Duration::from_secs(15)).unwrap();
        release.send(()).unwrap();
        let mut events = vec![];
        loop {
            let (event,status) = receive.recv_timeout(Duration::from_secs(20)).unwrap();
            events.push(event);
            if status=="completed" { break; }
            assert_ne!(status,"failed");
        }
        server.join().unwrap();
        assert!(events.len()>=3);
        assert!(events.iter().any(|event|event["stage"]=="structuring"));
        let persisted = call(&mut runtime,"import_summary_get",json!({"importId":accepted["summary"]["importId"]}));
        assert_eq!(persisted["summary"]["backgroundJob"]["status"],"completed");
        assert_eq!(rows(&persisted["summary"]["questions"]).len(),1);
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
    fn simulated_annotation_target_ids_use_the_existing_task_scope_without_published_or_complete_questions() {
        let mut complete = question();
        complete["questionId"] = json!("sim-complete");
        complete["difficultyAssessment"] = json!({"level":"easy","basis":"模拟已有难度。"});
        complete["primaryKnowledgeUids"] = json!(["sim-point"]);
        complete["task"] = json!({"label":"模拟完整考点"});
        complete["solutionPaths"] = json!([]);
        complete["annotationStatus"] = json!("succeeded");
        let mut questions = vec![complete.clone()];
        for (id,field,value) in [
            ("sim-failed","annotationStatus",json!("failed")),
            ("sim-missing-uid","primaryKnowledgeUids",json!([])),
            ("sim-missing-difficulty","difficultyAssessment",json!({"level":null})),
            ("sim-missing-task","task",json!({"label":" "})),
            ("sim-published","primaryKnowledgeUids",json!([])),
        ] {
            let mut q = complete.clone();q["questionId"] = json!(id);q[field] = value;questions.push(q);
        }
        let mut teaching = complete.clone();teaching["questionId"] = json!("sim-ready-missing-paths");
        teaching::initialize(&mut teaching,&json!({"generatedTeaching":{"answer":"2",
            "difficultyAssessment":{"level":"easy","basis":"模拟：已知运算，直接相加。"},"teachingSolution":"模拟：$1+1=2$。",
            "teachingFocusSchemaVersion":2,"teachingFocus":{"examFocus":"模拟整数加法。","studentRequirements":["计算正确的和。"]},"issues":[]}}));
        assert!(teaching::ready(&teaching));
        questions.push(teaching.clone());
        teaching["questionId"] = json!("sim-stale-teaching");
        teaching["stem"] = json!("模拟原题已变化。");
        questions.push(teaching);
        let record = json!({"questions":questions,"publishedQuestionIds":["sim-published"]});
        let before = record.clone();
        assert_eq!(annotation_target_ids(&record),json!(["sim-failed","sim-missing-uid","sim-missing-difficulty","sim-missing-task","sim-ready-missing-paths"]).as_array().unwrap().clone());
        assert_eq!(record,before);
        assert!(annotation_target_ids(&json!({"questions":[],"publishedQuestionIds":[]})).is_empty());
    }
    #[test]
    fn simulated_missing_paths_are_supplementable_only_with_current_ready_teaching_reference() {
        let mut q = question();
        q["questionId"] = json!("simulated-path-supplement-q1");
        q["difficultyAssessment"] = json!({"level":"easy","basis":"模拟已有难度。"});
        q["primaryKnowledgeUids"] = json!(["simulated-uid"]);
        q["solutionPaths"] = json!([]);
        q["annotationStatus"] = json!("succeeded");
        q["task"] = json!({"id":"simulated-task","label":"整数加法"});
        assert!(!needs_annotation(&q));
        teaching::initialize(&mut q, &json!({"generatedTeaching":{"answer":"2",
            "difficultyAssessment":{"level":"easy","basis":"已知明确运算，直接相加。"},
            "teachingSolution":"由题意，$1+1=2$。","teachingFocusSchemaVersion":2,
            "teachingFocus":{"examFocus":"整数加法。","studentRequirements":["写出正确的和。"]},"issues":[]}}));
        assert!(needs_annotation(&q));
        q["solutionPaths"] = json!([{"id":"existing-path"}]);
        assert!(!needs_annotation(&q));
        q["solutionPaths"] = json!([]);
        q["stem"] = json!("模拟内容变化");
        assert!(!needs_annotation(&q));
        q["task"]["label"] = json!("");
        assert!(needs_annotation(&q));
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
