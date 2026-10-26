//! Explicit failed-network-only continuation in a copied source trial runtime.
//! Complete stop responses, including contract failures, are never regenerated.
use super::*;
use crate::ocr::OcrDocument;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const VERSION: &str = "index-batch-retry-v1";
fn invalid(message: &str) -> AppError {
    err("index_batch_retry_invalid", message)
}
fn read(path: &Path) -> AppResult<Value> {
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}
fn save(path: &Path, value: &Value) -> AppResult<()> {
    std::fs::write(path, serde_json::to_vec_pretty(value)?)?;
    Ok(())
}
fn marker(v: &Value) -> bool {
    v == &json!({"experiment":VERSION,"noPublish":true})
}
fn check(start: Instant, cancel: &AtomicBool) -> AppResult<()> {
    if cancel.load(Ordering::SeqCst) {
        return Err(err("cancelled", "已停止来源定向恢复。"));
    }
    if start.elapsed() >= Duration::from_secs(120) {
        return Err(err(
            "whole_trial_deadline",
            "本次恢复共用120秒截止，已保存原成果。",
        ));
    }
    Ok(())
}
fn complete_stop(response: &Value) -> bool {
    response["httpStatus"] == 200
        && response["choices"][0]["finish_reason"] == "stop"
        && response["choices"][0]["message"]["content"].is_string()
}
fn network_only(failure: &Value) -> bool {
    failure["isConnect"] == true || failure["isTimeout"] == true
}
/// Stop wins over network evidence: a valid but semantically unsuitable answer
/// must stay visible for review and can never become a retry request.
fn retry_allowed(response: Option<&Value>, failure: Option<&Value>, pending: bool) -> bool {
    !response.is_some_and(complete_stop) && (failure.is_some_and(network_only) || pending)
}
fn cached(directory: &Path, expected_context: &Value, task: &str) -> AppResult<Option<Value>> {
    let rp = directory.join("response.json");
    if !rp.is_file() {
        return Ok(None);
    }
    let response = read(&rp)?;
    if !complete_stop(&response) {
        return Ok(None);
    }
    let raw: Value = serde_json::from_str(s(&response["choices"][0]["message"], "content"))
        .map_err(|_| invalid("原完整stop正文格式失败；保留原稿，禁止重发。"))?;
    if read(&directory.join("candidate.json"))? != raw
        || read(&directory.join("compact-input.json"))? != *expected_context
        || read(&directory.join("transport.json"))?["task"] != task
    {
        return Err(invalid("原完整来源响应与候选或当前OCR不一致，未重发。"));
    }
    Ok(Some(raw))
}
fn allowed_directory(directory: &Path, pending: bool) -> AppResult<bool> {
    let response = directory.join("response.json");
    let failure = directory.join("network-failure.json");
    let response = if response.is_file() {
        Some(read(&response)?)
    } else {
        None
    };
    let failure = if failure.is_file() {
        Some(read(&failure)?)
    } else {
        None
    };
    // Pending is only genuine if no provider request/response was constructed.
    let pending = pending && !directory.join("request.json").exists() && response.is_none();
    Ok(retry_allowed(response.as_ref(), failure.as_ref(), pending))
}
fn archive(directory: &Path, history: &Path, name: &str) -> AppResult<()> {
    let intended=history.parent().and_then(Path::parent).ok_or_else(||invalid("恢复目录无父边界。"))?.canonicalize()?;
    let history_root=history.canonicalize()?;
    let parent=directory.parent().ok_or_else(||invalid("批次目录无父边界。"))?.canonicalize()?;
    if !history_root.starts_with(&intended) || !parent.starts_with(&intended)
        || Path::new(name).components().count()!=1 || !matches!(Path::new(name).components().next(),Some(std::path::Component::Normal(_)))
        || (directory.exists() && !directory.canonicalize()?.starts_with(&intended)) {
        return Err(invalid("已解析恢复移动路径超出明确的隔离来源目录。"));
    }
    if directory.exists() {
        std::fs::rename(directory, history.join(name))?;
    }
    std::fs::create_dir(directory)?;
    Ok(())
}
fn fingerprints(directory: &Path, out: &mut BTreeMap<PathBuf, String>) -> AppResult<()> {
    for e in std::fs::read_dir(directory)? {
        let p = e?.path();
        if p.is_dir() {
            fingerprints(&p, out)?;
        } else {
            out.insert(p.clone(), sha(&std::fs::read(p)?));
        }
    }
    Ok(())
}
fn batch_context(d: &OcrDocument, spec: &Value, source: &str, manifest: &str) -> AppResult<Value> {
    let mut c = whole_transcription_trial::build(d, source, manifest)?["context"].clone();
    c["sourceScope"] = json!("student_only_batch");
    c["sourceBatch"] = spec.clone();
    Ok(c)
}
fn request_batch(
    model: &ModelClient,
    d: OcrDocument,
    spec: &Value,
    directory: &Path,
    source: &str,
    manifest: &str,
    proof: Option<&Value>,
    start: Instant,
    cancel: &AtomicBool,
) -> AppResult<Value> {
    check(start, cancel)?;
    let built = whole_transcription_trial::build(&d, source, manifest)?;
    let context = batch_context(&d, spec, source, manifest)?;
    save(&directory.join("compact-input.json"), &context)?;
    save(&directory.join("input-evidence.json"), &built["evidence"])?;
    let prompt=format!("{}\n本次仅转录sourceBatch.expectedQuestions，严格同序且原样保持sourceLabel、questionType、全部sourceBlockIds。不增减题、不拆小问为新题；原页可见邻题不属于本批。documentBlockIds和sharedBlockIds严格用sourceBatch给定值，document原块不抄入题干。materialRoles.questionIndices仅用本批questions的0起始局部索引，不能填globalQuestionIndex；所有实际投递非原页资产均须按真实图像归属。只处理学生题面，answer/solution及parts原答案/解析字段必须空，不能自主求解；题干给定公式、附录、表格和数据仍须完整转录。",whole_transcription_trial::system_prompt());
    let raw = model.index_batch_source_request(
        &context,
        &prompt,
        &d.assets,
        "low",
        directory,
        start,
        cancel,
        120,
        "question_import_batch_trial",
        proof,
    )?;
    save(&directory.join("candidate.json"), &raw)?;
    let mut validation = index_batch_runner::student_validation(&raw, &d)?;
    let identity = index_batch_runner::batch_identity(&raw, spec);
    validation["checks"].as_array_mut().unwrap().push(json!({"code":"index_batch_identity","passed":identity.is_ok(),"details":identity.as_ref().err().map(|e|vec![e.message.clone()]).unwrap_or_default()}));
    if identity.is_err() {
        validation["valid"] = json!(false);
    }
    save(&directory.join("validation.json"), &validation)?;
    // Complete invalid results are preserved too and cannot be requested again.
    if validation["valid"] != true {
        return Err(err(
            "index_batch_contract",
            "恢复响应已完整保存但合同失败，未追加重试。",
        ));
    }
    check(start, cancel)?;
    Ok(raw)
}
pub(super) fn run(
    store: &Store,
    model: &ModelClient,
    payload: &Value,
    cancel: &AtomicBool,
) -> AppResult<Value> {
    let start = Instant::now();
    if !marker(&read(&store.data_dir.join("index-batch-retry.json"))?) {
        return Err(invalid("仅允许明确标记的复制恢复目录。"));
    }
    let keys = [
        "importId",
        "expectedRevision",
        "operationId",
        "deadlineSeconds",
    ];
    if !payload
        .as_object()
        .is_some_and(|o| o.len() == 4 && keys.iter().all(|k| o.contains_key(*k)))
        || payload["deadlineSeconds"] != 120
    {
        return Err(invalid("恢复须精确导入身份、修订、操作及120秒总截止。"));
    }
    let op = operation(payload)?;
    let record = store.document("imports", s(payload, "importId"))?;
    revision(&record, payload)?;
    if !rows(&record["questions"]).is_empty() || !rows(&record["publishedQuestionIds"]).is_empty() {
        return Err(invalid("不能覆盖已有采纳或发布题目。"));
    }
    let root = store.data_dir.join("index-batch-trial");
    if !root.canonicalize()?.starts_with(store.data_dir.canonicalize()?) {return Err(invalid("隔离来源目录越界。"));}
    let history = root
        .join("retry-history")
        .join(&hash_json(&json!(op))[..24]);
    std::fs::create_dir_all(history.parent().unwrap())?;
    std::fs::create_dir(&history)?;
    let mut unchanged = BTreeMap::new();
    let mut dispatched = vec![];
    let mut states = vec![];
    let execution = (|| -> AppResult<Value> {
        check(start, cancel)?;
        read_source(store, &record)?;
        let original = paddle::load_document(store, &record)?;
        let pages = read(&root.join("student-page-selection.json"))?["studentOnlyPages"]
            .as_array()
            .and_then(|v| v.iter().map(Value::as_u64).collect::<Option<Vec<_>>>())
            .ok_or_else(|| invalid("原学生页冻结证据缺失。"))?;
        let d = whole_transcription_trial::select_student_pages(&original, &pages)?;
        let source = s(&record["source"], "sha256");
        let manifest = s(&record["ocrSource"], "manifestSha256");
        let index = root.join("index");
        let context = index_batch_trial::index_context(&d, source, manifest)?;
        let mut proof = None;
        let plan = if let Some(plan) = cached(&index, &context, "question_import_index_trial")? {
            fingerprints(&index, &mut unchanged)?;
            plan
        } else {
            if !allowed_directory(&index, false)? {
                return Err(invalid("索引没有明确连接/超时证据，禁止重发。"));
            }
            archive(&index, &history, "index")?;
            save(&index.join("compact-input.json"), &context)?;
            dispatched.push(json!({"kind":"index"}));
            let plan = model.index_batch_source_request(
                &context,
                index_batch_trial::INDEX_PROMPT,
                &d.assets,
                "low",
                &index,
                start,
                cancel,
                120,
                "question_import_index_trial",
                None,
            )?;
            save(&index.join("candidate.json"), &plan)?;
            proof = Some(read(&index.join("catalog.json"))?);
            plan
        };
        let validation = index_batch_trial::validate_plan(&plan, &d)?;
        if validation["valid"] != true {
            return Err(invalid("原完整索引或新索引合同失败，禁止重发语义稿。"));
        }
        if !index.join("validation.json").exists() {
            save(&index.join("validation.json"), &validation)?;
        }
        let specs = index_batch_trial::batch_spec(&plan, &d)?;
        let specpath = root.join("batch-specs.json");
        if specpath.exists() {
            if read(&specpath)? != json!(specs) {
                return Err(invalid("批次计划与原索引不一致。"));
            }
        } else {
            save(&specpath, &json!(specs))?;
        }
        std::fs::create_dir_all(root.join("batches"))?;
        let mut results = vec![None; specs.len()];
        let mut pending = vec![];
        for (i, spec) in specs.iter().enumerate() {
            let dir = root.join("batches").join(format!("batch-{i:03}"));
            let sub = index_batch_trial::subset_document(&d, spec)?;
            let context = batch_context(&sub, spec, source, manifest)?;
            if let Some(raw) = cached(&dir, &context, "question_import_batch_trial")? {
                fingerprints(&dir, &mut unchanged)?;
                results[i] = Some(raw);
                states.push(json!({"index":i,"status":"cached_complete_stop"}));
            } else {
                if !allowed_directory(&dir, !dir.exists())? {
                    return Err(invalid("未完成批次不是明确网络失败或未派发，禁止重做。"));
                }
                pending.push(i);
                states.push(json!({"index":i,"status":"pending_retry"}));
            }
        }
        let mut first_failure = None;
        // A cached old catalog is never called a new provider check. The first
        // retry batch performs a real GET unless a fresh index just did so.
        if proof.is_none() && !pending.is_empty() {
            let i = pending.remove(0);
            let dir = root.join("batches").join(format!("batch-{i:03}"));
            archive(&dir, &history, &format!("batch-{i:03}"))?;
            save(&dir.join("spec.json"), &specs[i])?;
            dispatched.push(json!({"kind":"batch","index":i}));
            let sub = index_batch_trial::subset_document(&d, &specs[i])?;
            match request_batch(
                model, sub, &specs[i], &dir, source, manifest, None, start, cancel,
            ) {
                Ok(raw) => {
                    results[i] = Some(raw);
                    states[i] = json!({"index":i,"status":"succeeded_retry"});
                }
                Err(e) => {
                    states[i] = json!({"index":i,"status":"failed_retry","error":{"code":e.code,"message":e.message}});
                    first_failure = Some(e);
                }
            }
            if dir.join("catalog.json").exists() {
                proof = Some(read(&dir.join("catalog.json"))?);
            }
        }
        if !pending.is_empty() {
            let proof = proof
                .as_ref()
                .ok_or_else(|| invalid("本次没有新的有效provider列表，不派发后续批次。"))?;
            let mut directories = vec![];
            for i in &pending {
                let dir = root.join("batches").join(format!("batch-{i:03}"));
                archive(&dir, &history, &format!("batch-{i:03}"))?;
                save(&dir.join("spec.json"), &specs[*i])?;
                directories.push(dir);
            }
            index_batch_runner::dispatch_pool(
                pending.len(),
                || check(start, cancel),
                |j| {
                    let i = pending[j];
                    let sub = index_batch_trial::subset_document(&d, &specs[i])?;
                    request_batch(
                        model,
                        sub,
                        &specs[i],
                        &directories[j],
                        source,
                        manifest,
                        Some(proof),
                        start,
                        cancel,
                    )
                },
                |event| {
                    match event {
                        index_batch_runner::PoolEvent::Started(j) => {
                            let i = pending[j];
                            dispatched.push(json!({"kind":"batch","index":i}));
                            states[i] = json!({"index":i,"status":"running_retry"});
                        }
                        index_batch_runner::PoolEvent::Finished(j, r) => {
                            let i = pending[j];
                            match r {
                                Ok(raw) => {
                                    results[i] = Some(raw);
                                    states[i] = json!({"index":i,"status":"succeeded_retry"});
                                }
                                Err(e) => {
                                    states[i] = json!({"index":i,"status":"failed_retry","error":{"code":e.code,"message":e.message}});
                                    if first_failure.is_none() {
                                        first_failure = Some(e);
                                    }
                                }
                            }
                        }
                        index_batch_runner::PoolEvent::Stopped(e) => {
                            if first_failure.is_none() {
                                first_failure = Some(e);
                            }
                        }
                    }
                    save(&root.join("source-retry-batch-status.json"), &json!(states))
                },
            )?;
        }
        if let Some(e) = first_failure {
            return Err(e);
        }
        check(start, cancel)?;
        let raw = results
            .into_iter()
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| invalid("仍有未产出批次。"))?;
        let merged = index_batch_trial::merge_batches(&plan, &raw, &d)?;
        save(
            &root.join("source-retry-candidate.json"),
            &merged["candidate"],
        )?;
        let validation = index_batch_runner::student_validation(&merged["candidate"], &d)?;
        Ok(
            json!({"strictJsonComplete":true,"contractPassed":validation["valid"],"requiresReview":validation["requiresReview"],"questionCount":rows(&merged["candidate"]["questions"]).len(),"candidate":merged["candidate"],"validation":validation}),
        )
    })();
    let mut outcome = match execution {
        Ok(v) => v,
        Err(e) => {
            json!({"strictJsonComplete":false,"contractPassed":false,"error":{"code":e.code,"message":e.message}})
        }
    };
    let preserved = unchanged
        .iter()
        .all(|(p, h)| std::fs::read(p).is_ok_and(|b| sha(&b) == *h));
    outcome["experiment"] = json!(VERSION);
    outcome["operationId"] = json!(op);
    outcome["elapsedMs"] = json!(start.elapsed().as_millis() as u64);
    outcome["deadlineSeconds"] = json!(120);
    outcome["maxParallel"] = json!(3);
    outcome["newDispatches"] = json!(dispatched);
    outcome["batchStates"] = json!(states);
    outcome["cachedFilesUnchanged"] = json!(preserved);
    outcome["cachedFileCount"] = json!(unchanged.len());
    outcome["published"] = json!(false);
    outcome["importRecordChanged"] = json!(false);
    outcome["firstPassTimingClaimed"] = json!(false);
    outcome["ocrCalls"] = json!(0);
    outcome["teachingCalls"] = json!(0);
    if !preserved {
        return Err(invalid("已完成原响应文件发生变化，恢复未被采纳。"));
    }
    save(&root.join("source-retry-outcome.json"), &outcome)?;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requires_exact_isolation_marker() {
        assert!(marker(&json!({"experiment":VERSION,"noPublish":true})));
        assert!(!marker(&json!({"experiment":VERSION,"noPublish":false})));
    }
    #[test]
    fn never_retry_complete_semantic_or_format_failure() {
        let r = json!({"httpStatus":200,"choices":[{"finish_reason":"stop","message":{"content":"malformed JSON or mathematically wrong"}}]});
        assert!(!retry_allowed(
            Some(&r),
            Some(&json!({"isTimeout":true})),
            true
        ));
    }
    #[test]
    fn requires_network_or_genuinely_pending() {
        assert!(retry_allowed(None, Some(&json!({"isConnect":true})), false));
        assert!(!retry_allowed(None, Some(&json!({"isBody":true})), false));
        assert!(retry_allowed(None, None, true));
        assert!(!retry_allowed(None, None, false));
    }
    #[test]
    fn original_complete_cache_is_read_only() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path();
        let raw = json!({"questions":[],"check":{"status":"needs_review"}});
        let c = json!({"original":"context"});
        save(&p.join("response.json"),&json!({"httpStatus":200,"choices":[{"finish_reason":"stop","message":{"content":raw.to_string()}}]})).unwrap();
        save(&p.join("candidate.json"), &raw).unwrap();
        save(&p.join("compact-input.json"), &c).unwrap();
        save(
            &p.join("transport.json"),
            &json!({"task":"question_import_batch_trial"}),
        )
        .unwrap();
        let before = std::fs::read(p.join("response.json")).unwrap();
        assert_eq!(
            cached(p, &c, "question_import_batch_trial").unwrap(),
            Some(raw)
        );
        assert_eq!(before, std::fs::read(p.join("response.json")).unwrap());
    }
    #[test]
    fn archive_checks_resolved_target_before_moving_directory() {
        let temp=tempfile::tempdir().unwrap();let root=temp.path().join("index-batch-trial");
        let history=root.join("retry-history/op");let batch=root.join("batches/batch-000");
        std::fs::create_dir_all(&history).unwrap();std::fs::create_dir_all(&batch).unwrap();
        std::fs::write(batch.join("old.json"),b"{}").unwrap();
        assert!(archive(&batch,&history,"../outside").is_err());
        assert!(batch.join("old.json").exists());
        archive(&batch,&history,"batch-000").unwrap();
        assert!(history.join("batch-000/old.json").exists());
        assert!(batch.is_dir());assert!(!batch.join("old.json").exists());
    }

}
