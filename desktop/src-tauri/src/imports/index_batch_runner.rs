//! Explicit debug-only index/batch source experiment. Store is read on the
//! caller thread only. All request artifacts live in a fresh isolated directory.
use super::*;
use crate::ocr::OcrDocument;
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const EXPERIMENT: &str = "index-batch-120s-v1";
const EFFORT: &str = "low";
const DEADLINE: u64 = 120;
pub(super) enum PoolEvent<T> {
    Started(usize),
    Finished(usize, AppResult<T>),
    Stopped(AppError),
}
/// Three persistent workers take the next original-order item as soon as free.
/// Only the caller invokes observe, so controller state and Store never cross
/// threads. Each job still checks the common action deadline before dispatch.
pub(super) fn dispatch_pool<T: Send>(
    count: usize,
    may_start: impl Fn() -> AppResult<()> + Sync,
    work: impl Fn(usize) -> AppResult<T> + Sync,
    mut observe: impl FnMut(PoolEvent<T>) -> AppResult<()>,
) -> AppResult<()> {
    let queue = std::sync::Mutex::new((0..count).collect::<std::collections::VecDeque<_>>());
    let halted = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let (sender, receiver) = std::sync::mpsc::channel();
        let mut handles = vec![];
        for _ in 0..count.min(3) {
            let (queue, halted, may_start, work, sender) =
                (&queue, &halted, &may_start, &work, sender.clone());
            handles.push(scope.spawn(move || {
                loop {
                    let index = {
                        let mut queue = queue.lock().unwrap_or_else(|p| p.into_inner());
                        if halted.load(Ordering::SeqCst) || queue.is_empty() {
                            break;
                        }
                        if let Err(error) = may_start() {
                            let _ = sender.send(PoolEvent::Stopped(error));
                            break;
                        }
                        queue.pop_front().unwrap()
                    };
                    if sender.send(PoolEvent::Started(index)).is_err() {
                        break;
                    }
                    let result =
                        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| work(index)))
                            .unwrap_or_else(|_| {
                                Err(err(
                                    "index_batch_worker_failed",
                                    "独立批次执行中断，已保存成果保留。",
                                ))
                            });
                    if sender.send(PoolEvent::Finished(index, result)).is_err() {
                        break;
                    }
                }
            }));
        }
        drop(sender);
        let mut failure = None;
        for event in receiver {
            if let Err(error) = observe(event) {
                halted.store(true, Ordering::SeqCst);
                if failure.is_none() {
                    failure = Some(error);
                }
            }
        }
        for handle in handles {
            if handle.join().is_err() && failure.is_none() {
                failure = Some(err("index_batch_worker_failed", "批次调度线程中断。"));
            }
        }
        if let Some(error) = failure {
            Err(error)
        } else {
            Ok(())
        }
    })
}
fn marker_valid(v: &Value) -> bool {
    v == &json!({"experiment":EXPERIMENT,"noPublish":true})
}
fn guard(store: &Store) -> AppResult<()> {
    let bytes = std::fs::read(store.data_dir.join("index-batch-trial.json")).map_err(|_| {
        err(
            "source_trial_isolation_required",
            "索引分批试验仅允许明确隔离目录。",
        )
    })?;
    if !marker_valid(&serde_json::from_slice::<Value>(&bytes)?) {
        return Err(err(
            "source_trial_isolation_required",
            "索引分批隔离标记无效。",
        ));
    }
    Ok(())
}
fn input(payload: &Value) -> AppResult<Vec<u64>> {
    let keys = [
        "importId",
        "expectedRevision",
        "operationId",
        "studentOnlyPages",
        "deadlineSeconds",
        "maxParallel",
    ];
    if !payload
        .as_object()
        .is_some_and(|o| o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k)))
        || payload["deadlineSeconds"] != DEADLINE
        || payload["maxParallel"] != 3
        || payload["expectedRevision"].as_u64().is_none()
    {
        return Err(err(
            "invalid_input",
            "索引分批试验固定120秒共享截止、最多3并发及明确学生页。",
        ));
    }
    operation(payload)?;
    let id = s(payload, "importId");
    if !id.starts_with("import-")
        || id.len() > 80
        || !id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(err("invalid_input", "来源身份无效。"));
    }
    let pages = payload["studentOnlyPages"]
        .as_array()
        .and_then(|a| a.iter().map(Value::as_u64).collect::<Option<Vec<_>>>())
        .filter(|p| {
            !p.is_empty()
                && p.iter().all(|n| *n > 0)
                && p.iter().collect::<std::collections::BTreeSet<_>>().len() == p.len()
        })
        .ok_or_else(|| err("invalid_input", "学生页须为非空、不重复的真实原页码数组。"))?;
    Ok(pages)
}
fn save(path: &Path, value: &Value) -> AppResult<()> {
    std::fs::write(path, serde_json::to_vec_pretty(value)?)?;
    Ok(())
}
fn check(started: Instant, cancel: &AtomicBool) -> AppResult<()> {
    if cancel.load(Ordering::SeqCst) {
        return Err(err("cancelled", "本次来源试验已停止，已完成批次保留。"));
    }
    if started.elapsed() >= Duration::from_secs(DEADLINE) {
        return Err(err(
            "whole_trial_deadline",
            "索引与分批共用的120秒已达截止，未派发剩余请求。",
        ));
    }
    Ok(())
}
pub(super) fn student_validation(raw: &Value, document: &OcrDocument) -> AppResult<Value> {
    let mut v = whole_transcription_trial::validate(raw, document)?;
    let empty = rows(&raw["questions"]).iter().all(|q| {
        s(q, "answer").is_empty()
            && s(q, "solution").is_empty()
            && rows(&q["parts"])
                .iter()
                .all(|p| p[2].as_str() == Some("") && p[3].as_str() == Some(""))
    });
    let no_teacher = rows(&raw["materialRoles"])
        .iter()
        .all(|r| r["role"] != "teacher");
    v["checks"].as_array_mut().unwrap().push(json!({"code":"student_only_no_reference_output","passed":empty&&no_teacher,
        "details":if empty&&no_teacher{vec![]}else{vec!["学生来源批次含答案解析或teacher素材，未静默擦除。"]}}));
    if !empty || !no_teacher {
        v["valid"] = json!(false);
    }
    Ok(v)
}
pub(super) fn batch_identity(raw: &Value, spec: &Value) -> AppResult<()> {
    fn identity_ids(v: &Value) -> Option<std::collections::BTreeSet<String>> {
        let rows = v.as_array()?;
        let strings = rows
            .iter()
            .map(|v| v.as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()?;
        let ids: std::collections::BTreeSet<_> = strings.into_iter().collect();
        (ids.len() == rows.len()).then_some(ids)
    }
    let given = raw["questions"].as_array();
    let expected = spec["expectedQuestions"].as_array();
    let matches = given.zip(expected).is_some_and(|(a, b)| {
        a.len() == b.len()
            && a.iter().zip(b).all(|(q, e)| {
                q["sourceLabel"] == e["sourceLabel"]
                    && q["questionType"] == e["questionType"]
                    && identity_ids(&q["sourceBlockIds"])
                        .is_some_and(|ids| Some(ids) == identity_ids(&e["sourceBlockIds"]))
            })
    });
    if !matches
        || !["documentBlockIds", "sharedBlockIds"]
            .iter()
            .all(|k| identity_ids(&raw[*k]).is_some_and(|ids| Some(ids) == identity_ids(&spec[*k])))
    {
        return Err(err(
            "index_batch_identity",
            "批次题序、身份或document/shared来源与索引不一致。",
        ));
    }
    let expected = expected.unwrap();
    let document_assets = identity_ids(&spec["documentAssetIds"])
        .ok_or_else(|| err("index_batch_identity", "批次缺非题素材身份。"))?;
    for role in raw["materialRoles"]
        .as_array()
        .ok_or_else(|| err("index_batch_identity", "批次缺素材归属。"))?
    {
        let id = role["assetId"].as_str().unwrap_or("");
        let owners: std::collections::BTreeSet<u64> = expected
            .iter()
            .filter(|q| identity_ids(&q["assetIds"]).is_some_and(|ids| ids.contains(id)))
            .filter_map(|q| q["globalQuestionIndex"].as_u64())
            .collect();
        let local = role["questionIndices"]
            .as_array()
            .and_then(|r| r.iter().map(Value::as_u64).collect::<Option<Vec<_>>>())
            .ok_or_else(|| err("index_batch_identity", "批次素材局部题索引无效。"))?;
        let mut global = std::collections::BTreeSet::new();
        for index in &local {
            let owner = expected
                .get(*index as usize)
                .and_then(|q| q["globalQuestionIndex"].as_u64())
                .ok_or_else(|| err("index_batch_identity", "素材局部题索引超出本批。"))?;
            global.insert(owner);
        }
        let matches = match role["role"].as_str() {
            Some("student" | "teacher") => {
                !owners.is_empty()
                    && !document_assets.contains(id)
                    && global == owners
                    && global.len() == local.len()
            }
            Some("document") => {
                owners.is_empty() && document_assets.contains(id) && local.is_empty()
            }
            Some("unresolved") => {
                (!owners.is_empty() || document_assets.contains(id)) && local.is_empty()
            }
            _ => false,
        };
        if !matches {
            return Err(err(
                "index_batch_identity",
                "批次素材归属与索引assetIds不一致。",
            ));
        }
    }
    Ok(())
}
fn worker(
    model: &ModelClient,
    document: OcrDocument,
    spec: Value,
    directory: PathBuf,
    source_sha: String,
    manifest_sha: String,
    started: Instant,
    cancel: &AtomicBool,
) -> AppResult<Value> {
    let run = (|| -> AppResult<Value> {
        check(started, cancel)?;
        let built = whole_transcription_trial::build(&document, &source_sha, &manifest_sha)?;
        let mut context = built["context"].clone();
        context["sourceScope"] = json!("student_only_batch");
        context["sourceBatch"] = spec.clone();
        save(&directory.join("compact-input.json"), &context)?;
        save(&directory.join("input-evidence.json"), &built["evidence"])?;
        let prompt = format!(
            "{}\n本次仅转录sourceBatch.expectedQuestions，严格同序且原样保持sourceLabel、questionType、全部sourceBlockIds。不增减题、不拆小问为新题；原页可见邻题不属于本批。documentBlockIds和sharedBlockIds严格用sourceBatch给定值，document原块不抄入题干。materialRoles.questionIndices仅用本批questions的0起始局部索引，不能填globalQuestionIndex；所有实际投递非原页资产均须按真实图像归属。只处理学生题面，answer/solution及parts原答案/解析字段必须空，不能自主求解；题干给定公式、附录、表格和数据仍须完整转录。",
            whole_transcription_trial::system_prompt()
        );
        let raw = model.index_batch_source_request(
            &context,
            &prompt,
            &document.assets,
            EFFORT,
            &directory,
            started,
            cancel,
            DEADLINE,
            "question_import_batch_trial",
        )?;
        save(&directory.join("candidate.json"), &raw)?;
        let mut validation = student_validation(&raw, &document)?;
        let identity = batch_identity(&raw, &spec);
        validation["checks"].as_array_mut().unwrap().push(
            json!({"code":"index_batch_identity","passed":identity.is_ok(),
            "details":identity.as_ref().err().map(|e|vec![e.message.clone()]).unwrap_or_default()}),
        );
        if identity.is_err() {
            validation["valid"] = json!(false);
        }
        save(&directory.join("validation.json"), &validation)?;
        check(started, cancel)?;
        if validation["valid"] != true {
            return Err(err(
                "index_batch_contract",
                "批次转录未通过严格来源合同，原响应及其他成功结果保留。",
            ));
        }
        Ok(raw)
    })();
    let state = match &run {
        Ok(_) => json!({"status":"succeeded","elapsedMs":started.elapsed().as_millis() as u64}),
        Err(e) => {
            json!({"status":"failed","elapsedMs":started.elapsed().as_millis() as u64,"error":{"code":e.code,"message":e.message}})
        }
    };
    save(&directory.join("status.json"), &state)?;
    run
}
pub(super) fn run(
    store: &Store,
    model: &ModelClient,
    payload: &Value,
    cancel: &AtomicBool,
) -> AppResult<Value> {
    let started = Instant::now();
    guard(store)?;
    let pages = input(payload)?;
    let record = store.document("imports", s(payload, "importId"))?;
    if payload["expectedRevision"] != record["revision"]
        || !rows(&record["questions"]).is_empty()
        || record["sourceStructuring"].is_object()
        || !rows(&record["publishedQuestionIds"]).is_empty()
    {
        return Err(err(
            "source_trial_completed",
            "仅允许未处理的隔离OCR；已有题目、索引或发布结果未覆盖。",
        ));
    }
    let directory = store.data_dir.join("index-batch-trial");
    std::fs::create_dir(&directory).map_err(|_| {
        err(
            "source_trial_exists",
            "该隔离试验已发起，未重跑或覆盖已保存批次。",
        )
    })?;
    save(
        &directory.join("outcome.json"),
        &json!({"experiment":EXPERIMENT,"status":"running","published":false,"importRecordChanged":false}),
    )?;
    let mut states = Vec::<Value>::new();
    let mut plan_count = 0usize;
    let execution = (|| -> AppResult<Value> {
        check(started, cancel)?;
        read_source(store, &record)?;
        let original = paddle::load_document(store, &record)?;
        let document = whole_transcription_trial::select_student_pages(&original, &pages)?;
        save(
            &directory.join("student-page-selection.json"),
            &json!({
            "originalPages":original.pages.iter().map(|p|p["page"].clone()).collect::<Vec<_>>(),
            "studentOnlyPages":document.pages.iter().map(|p|p["page"].clone()).collect::<Vec<_>>(),
            "includedAssetIds":document.assets.iter().map(|a|a["id"].clone()).collect::<Vec<_>>(),
            "excludedPages":original.pages.iter().filter(|p|!document.pages.iter().any(|q|q["page"]==p["page"])).map(|p|p["page"].clone()).collect::<Vec<_>>(),
            "excludedAssetIds":original.assets.iter().filter(|a|!document.assets.iter().any(|b|a["id"]==b["id"])).map(|a|a["id"].clone()).collect::<Vec<_>>(),
            "originalOcrUnchanged":true}),
        )?;
        let source_sha = s(&record["source"], "sha256").to_owned();
        let manifest_sha = s(&record["ocrSource"], "manifestSha256").to_owned();
        let index_directory = directory.join("index");
        std::fs::create_dir(&index_directory)?;
        let context = index_batch_trial::index_context(&document, &source_sha, &manifest_sha)?;
        save(&index_directory.join("compact-input.json"), &context)?;
        check(started, cancel)?;
        let plan = model.index_batch_source_request(
            &context,
            index_batch_trial::INDEX_PROMPT,
            &document.assets,
            EFFORT,
            &index_directory,
            started,
            cancel,
            DEADLINE,
            "question_import_index_trial",
        )?;
        save(&index_directory.join("candidate.json"), &plan)?;
        let validation = index_batch_trial::validate_plan(&plan, &document)?;
        save(&index_directory.join("validation.json"), &validation)?;
        if validation["valid"] != true {
            return Err(err(
                "index_batch_plan_invalid",
                "整卷索引未通过原块/素材完整性校验，未开始批次。",
            ));
        }
        check(started, cancel)?;
        plan_count = rows(&plan["questions"]).len();
        let specs = index_batch_trial::batch_spec(&plan, &document)?;
        save(&directory.join("batch-specs.json"), &json!(specs))?;
        let batch_root = directory.join("batches");
        std::fs::create_dir(&batch_root)?;
        states = specs
            .iter()
            .map(|spec| json!({"index":spec["index"],"status":"pending"}))
            .collect();
        save(&directory.join("batch-status.json"), &json!(states))?;
        let mut results: Vec<Option<Value>> = vec![None; specs.len()];
        let mut first_failure = None;
        dispatch_pool(
            specs.len(),
            || check(started, cancel),
            |index| {
                check(started, cancel)?;
                let sub = index_batch_trial::subset_document(&document, &specs[index])?;
                let batch_directory = batch_root.join(format!("batch-{index:03}"));
                std::fs::create_dir(&batch_directory)?;
                save(&batch_directory.join("spec.json"), &specs[index])?;
                worker(
                    model,
                    sub,
                    specs[index].clone(),
                    batch_directory,
                    source_sha.clone(),
                    manifest_sha.clone(),
                    started,
                    cancel,
                )
            },
            |event| {
                match event {
                    PoolEvent::Started(index) => {
                        states[index] = json!({"index":index,"status":"running"})
                    }
                    PoolEvent::Finished(index, result) => match result {
                        Ok(raw) => {
                            results[index] = Some(raw);
                            states[index] = json!({"index":index,"status":"succeeded"});
                        }
                        Err(error) => {
                            states[index] = json!({"index":index,"status":"failed","error":{"code":error.code,"message":error.message}});
                            if first_failure.is_none() {
                                first_failure = Some(error);
                            }
                        }
                    },
                    PoolEvent::Stopped(error) => {
                        if first_failure.is_none() {
                            first_failure = Some(error);
                        }
                    }
                }
                save(&directory.join("batch-status.json"), &json!(states))
            },
        )?;
        check(started, cancel)?;
        if let Some(error) = first_failure {
            return Err(error);
        }
        let candidates = results
            .into_iter()
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| err("index_batch_incomplete", "仍有未完成批次，未采纳半卷。"))?;
        let merged = index_batch_trial::merge_batches(&plan, &candidates, &document)?;
        save(&directory.join("candidate.json"), &merged["candidate"])?;
        let validation = student_validation(&merged["candidate"], &document)?;
        save(&directory.join("validation.json"), &validation)?;
        check(started, cancel)?;
        Ok(
            json!({"strictJsonComplete":true,"contractPassed":validation["valid"],"requiresReview":validation["requiresReview"],
            "questionCount":rows(&merged["candidate"]["questions"]).len(),"candidate":merged["candidate"],"validation":validation}),
        )
    })();
    let completed = states.iter().filter(|s| s["status"] == "succeeded").count();
    let mut outcome = match execution {
        Ok(v) => v,
        Err(e) => {
            json!({"strictJsonComplete":false,"contractPassed":false,"error":{"code":e.code,"message":e.message}})
        }
    };
    outcome["schemaVersion"] = json!(1);
    outcome["experiment"] = json!(EXPERIMENT);
    outcome["indexEffort"] = json!(EFFORT);
    outcome["batchEffort"] = json!(EFFORT);
    outcome["deadlineSeconds"] = json!(DEADLINE);
    outcome["maxParallel"] = json!(3);
    outcome["studentOnlyPages"] = json!(pages);
    outcome["elapsedMs"] = json!(started.elapsed().as_millis() as u64);
    outcome["planQuestionCount"] = json!(plan_count);
    outcome["completedBatchCount"] = json!(completed);
    outcome["completeRawBatchCount"] = json!(
        states
            .iter()
            .filter(|s| s["index"].as_u64().is_some_and(|i| directory
                .join("batches")
                .join(format!("batch-{i:03}"))
                .join("candidate.json")
                .is_file()))
            .count()
    );
    outcome["totalBatchCount"] = json!(states.len());
    outcome["batchStates"] = json!(states);
    outcome["published"] = json!(false);
    outcome["importRecordChanged"] = json!(false);
    outcome["teachingCalls"] = json!(0);
    outcome["qwenCalls"] = json!(0);
    outcome["ocrCalls"] = json!(0);
    save(&directory.join("outcome.json"), &outcome)?;
    Ok(outcome)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn payload() -> Value {
        json!({"importId":"import-simulated-index","expectedRevision":0,"operationId":"simulated-index-batch","studentOnlyPages":[1,2],"deadlineSeconds":120,"maxParallel":3})
    }
    #[test]
    fn input_is_fixed_scope_not_arbitrary_parallelism_or_extra_material() {
        assert_eq!(input(&payload()).unwrap(), vec![1, 2]);
        for (key, value) in [
            ("deadlineSeconds", json!(240)),
            ("maxParallel", json!(4)),
            ("studentOnlyPages", json!([1, 1])),
            ("expectedRevision", json!(-1)),
        ] {
            let mut p = payload();
            p[key] = value;
            assert!(input(&p).is_err());
        }
        let mut p = payload();
        p["teacherMaterial"] = json!("not authorized");
        assert!(input(&p).is_err());
    }
    #[test]
    fn isolation_marker_is_exact_and_deadline_is_shared() {
        assert!(marker_valid(
            &json!({"experiment":EXPERIMENT,"noPublish":true})
        ));
        assert!(!marker_valid(
            &json!({"experiment":EXPERIMENT,"noPublish":false})
        ));
        assert!(!marker_valid(
            &json!({"experiment":"whole-paper-thinking-60s-v1","noPublish":true})
        ));
        let cancel = AtomicBool::new(false);
        let start = Instant::now() - Duration::from_secs(DEADLINE);
        assert_eq!(
            check(start, &cancel).unwrap_err().code,
            "whole_trial_deadline"
        );
        cancel.store(true, Ordering::SeqCst);
        assert_eq!(
            check(Instant::now(), &cancel).unwrap_err().code,
            "cancelled"
        );
    }
    #[test]
    fn batch_identity_is_checked_before_a_worker_is_successful() {
        let spec = json!({"expectedQuestions":[{"globalQuestionIndex":5,"sourceLabel":"18","questionType":"free_response","sourceBlockIds":["p2-b0","p5-b0"],"assetIds":[]}],
            "documentBlockIds":["p2-b1"],"sharedBlockIds":[],"documentAssetIds":[]});
        let raw = json!({"questions":[{"sourceLabel":"18","questionType":"free_response","sourceBlockIds":["p5-b0","p2-b0"]}],
            "documentBlockIds":["p2-b1"],"sharedBlockIds":[],"materialRoles":[]});
        assert!(batch_identity(&raw, &spec).is_ok());
        let mut bad = raw.clone();
        bad["questions"][0]["sourceLabel"] = json!("19");
        assert!(batch_identity(&bad, &spec).is_err());
        let mut bad = raw.clone();
        bad["questions"][0]["sourceBlockIds"] = json!(["p2-b0"]);
        assert!(batch_identity(&bad, &spec).is_err());
        let mut bad = raw.clone();
        bad["documentBlockIds"] = json!([]);
        assert!(batch_identity(&bad, &spec).is_err());
        let mut bad = raw.clone();
        bad["sharedBlockIds"] = json!(["p2-b0"]);
        assert!(batch_identity(&bad, &spec).is_err());
        let mut with_figure = spec;
        with_figure["expectedQuestions"][0]["assetIds"] = json!(["real-figure"]);
        let mut candidate = raw;
        candidate["materialRoles"] =
            json!([{"assetId":"real-figure","role":"student","questionIndices":[0]}]);
        assert!(batch_identity(&candidate, &with_figure).is_ok());
        candidate["materialRoles"][0]["questionIndices"] = json!([5]);
        assert!(batch_identity(&candidate, &with_figure).is_err());
        candidate["materialRoles"][0]["questionIndices"] = json!([]);
        candidate["materialRoles"][0]["role"] = json!("document");
        assert!(batch_identity(&candidate, &with_figure).is_err());
    }
    #[test]
    fn free_worker_dispatches_next_before_slow_job_finishes_with_three_worker_cap() {
        use std::sync::{Barrier, Condvar, Mutex, atomic::AtomicUsize};
        let barrier = Barrier::new(3);
        let release = (Mutex::new(false), Condvar::new());
        let slow_done = AtomicBool::new(false);
        let overlapped = AtomicBool::new(false);
        let active = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let called = Mutex::new(vec![]);
        let mut completed = vec![];
        dispatch_pool(
            6,
            || Ok(()),
            |index| {
                let running = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(running, Ordering::SeqCst);
                called.lock().unwrap().push(index);
                if index < 3 {
                    barrier.wait();
                }
                if index == 0 {
                    let (lock, cv) = &release;
                    let (released, _) = cv
                        .wait_timeout_while(lock.lock().unwrap(), Duration::from_secs(2), |done| {
                            !*done
                        })
                        .unwrap();
                    assert!(
                        *released,
                        "later work was blocked behind the slow first job"
                    );
                    slow_done.store(true, Ordering::SeqCst);
                }
                if index == 3 {
                    overlapped.store(!slow_done.load(Ordering::SeqCst), Ordering::SeqCst);
                    *release.0.lock().unwrap() = true;
                    release.1.notify_all();
                }
                active.fetch_sub(1, Ordering::SeqCst);
                Ok(index)
            },
            |event| {
                if let PoolEvent::Finished(_, result) = event {
                    completed.push(result?);
                }
                Ok(())
            },
        )
        .unwrap();
        assert!(overlapped.load(Ordering::SeqCst));
        assert!(peak.load(Ordering::SeqCst) <= 3);
        let mut calls = called.into_inner().unwrap();
        calls.sort_unstable();
        completed.sort_unstable();
        assert_eq!(calls, (0..6).collect::<Vec<_>>());
        assert_eq!(completed, calls);
    }
}
