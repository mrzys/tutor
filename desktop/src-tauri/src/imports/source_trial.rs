//! Explicit developer-only source experiment. Never publishes or generates teaching drafts.
use super::*;

const EXPERIMENT: &str = "layout-stitch-source-ten-v1";

fn guard(store: &Store) -> AppResult<()> {
    let path=store.data_dir.join("source-trial.json");
    let bytes=std::fs::read(path).map_err(|_|err("source_trial_isolation_required","拆题试验仅允许在显式隔离目录执行。"))?;
    let marker:Value=serde_json::from_slice(&bytes)?;
    if marker["experiment"]!=EXPERIMENT || marker["noPublish"]!=true {
        return Err(err("source_trial_isolation_required","拆题试验隔离标记无效。"));
    }
    Ok(())
}

pub(super) fn seed(store:&Store,payload:&Value)->AppResult<Value> {
    guard(store)?;
    let input=payload["record"].as_object().ok_or_else(||err("invalid_input","缺少缓存来源记录。"))?;
    let allowed=["importId","filename","source","ocrSource","extractedPages","sourceIssues"];
    if input.len()!=allowed.len() || allowed.iter().any(|k|!input.contains_key(*k)) {
        return Err(err("invalid_input","只允许导入原件与已保存OCR，不接受旧题目、计划或模型结果。"));
    }
    let id=s(&payload["record"],"importId");
    if !id.starts_with("import-") || id.len()>80 || !id.bytes().all(|b|b.is_ascii_lowercase()||b.is_ascii_digit()||b==b'-') {
        return Err(err("invalid_input","来源身份无效。"));
    }
    let count:i64=store.user.query_row("SELECT count(*) FROM documents WHERE kind='imports' AND id=?1",[id],|row|row.get(0))?;
    if count!=0 {return Err(err("source_trial_exists","隔离试验来源已存在，未覆盖。"));}
    let mut record=payload["record"].clone();
    record["revision"]=json!(0);record["status"]=json!("failed");
    record["createdAt"]=json!(now());record["updatedAt"]=json!(now());
    record["questions"]=json!([]);record["operations"]=json!([]);
    record["publishedQuestionIds"]=json!([]);record["publicationHistory"]=json!([]);
    record["error"]=Value::Null;
    read_source(store,&record)?;
    let document=paddle::load_document(store,&record)?;
    if document.pages.is_empty() {return Err(err("source_trial_ocr_required","缺少已验证的OCR页面。"));}
    store.put_document("imports",id,&record)?;
    Ok(json!({"import":record,"sourceTrialSeeded":true,"modelCalls":0,"ocrCalls":0}))
}

pub(super) fn run(store:&mut Store,model:&ModelClient,payload:&Value,cancel:&AtomicBool,layout:bool)->AppResult<Value> {
    guard(store)?;
    if !payload.as_object().is_some_and(|o|o.len()==3 && ["importId","expectedRevision","operationId"].iter().all(|k|o.contains_key(*k))) {
        return Err(err("invalid_input","拆题试验仅接受明确来源、修订及操作身份。"));
    }
    let variant=if layout{"layout"}else{"baseline"};
    match stage_import(store,model,payload,cancel)? {
        StagedImport::Existing(record)=>Ok(json!({"import":record,"replayed":true})),
        StagedImport::Ready(mut record,bytes)=>{
            if !rows(&record["questions"]).is_empty() || !rows(&record["publishedQuestionIds"]).is_empty() {
                return Err(err("source_trial_completed","已有结果不作为新的拆题输入，未重跑。"));
            }
            if record["sourceTrial"].is_object() && record["sourceTrial"]["variant"]!=variant {
                return Err(err("source_trial_variant_changed","新旧方案须使用各自独立的隔离目录。"));
            }
            let before=record.clone();
            if record["sourceTrial"].is_null() {
                record["sourceTrial"]=json!({"experiment":EXPERIMENT,"variant":variant,"planOnly":!layout,"noPublish":true});
                save_cas(store,Some(&before),&record)?;
            }
            process_import_scoped(store,model,operation(payload)?,&hash_json(payload),cancel,record,bytes,ImportScope::SourceTrial{layout,plan_only:!layout})
        }
    }
}

pub(super) fn run_whole(store:&Store,model:&ModelClient,payload:&Value,cancel:&AtomicBool)->AppResult<Value> {
    let started=std::time::Instant::now();
    guard(store)?;
    let allowed=["importId","expectedRevision","operationId","thinkingEffort","deadlineSeconds"];
    let student_only=payload.get("studentOnlyPages").is_some();
    let deadline_seconds=if student_only{120}else{60};
    let experiment=if student_only{"student-only-low-120s-v1"}else{"whole-paper-thinking-60s-v1"};
    if !payload.as_object().is_some_and(|o|o.len()==allowed.len()+usize::from(student_only)&&allowed.iter().all(|k|o.contains_key(*k))) || payload["deadlineSeconds"]!=deadline_seconds {
        return Err(err("invalid_input","整卷试验仅支持原60秒合同，或显式学生页范围的120秒合同。"));
    }
    let effort=s(payload,"thinkingEffort");
    if !matches!(effort,"off"|"low"|"high"|"max") {return Err(err("invalid_input","思考档位无效。"));}
    if student_only && effort!="low" {return Err(err("invalid_input","本次学生卷试验固定使用低思考档。"));}
    let student_pages=if student_only{Some(payload["studentOnlyPages"].as_array().and_then(|p|p.iter().map(Value::as_u64).collect::<Option<Vec<_>>>()).filter(|p|!p.is_empty()).ok_or_else(||err("invalid_input","学生页范围必须为非空的真实页码数组。"))?)}else{None};
    operation(payload)?;
    let record=store.document("imports",s(payload,"importId"))?;
    if payload["expectedRevision"]!=record["revision"] || !rows(&record["questions"]).is_empty() || record["sourceStructuring"].is_object() || !rows(&record["publishedQuestionIds"]).is_empty() {
        return Err(err("source_trial_completed","整卷试验仅接受未处理的隔离OCR材料，未覆盖已有结果。"));
    }
    let directory=store.data_dir.join("whole-transcription-trial");
    std::fs::create_dir(&directory).map_err(|_|err("source_trial_exists","本次整卷试验已发起，未自动重试。"))?;
    let run=(||->AppResult<Value>{
        read_source(store,&record)?;
        let original=paddle::load_document(store,&record)?;
        let selected=if let Some(pages)=&student_pages{Some(whole_transcription_trial::select_student_pages(&original,pages)?)}else{None};
        let document=selected.as_ref().unwrap_or(&original);
        let mut built=whole_transcription_trial::build(&document,s(&record["source"],"sha256"),s(&record["ocrSource"],"manifestSha256"))?;
        let page_numbers:Vec<_>=document.pages.iter().map(|p|p["page"].clone()).collect();
        let mut prompt=whole_transcription_trial::system_prompt().to_owned();
        if student_only {
            let selection=json!({"originalPages":original.pages.iter().map(|p|p["page"].clone()).collect::<Vec<_>>(),"studentOnlyPages":page_numbers,"excludedPages":original.pages.iter().filter(|p|!document.pages.iter().any(|q|q["page"]==p["page"])).map(|p|p["page"].clone()).collect::<Vec<_>>(),"includedAssetIds":document.assets.iter().map(|a|a["id"].clone()).collect::<Vec<_>>(),"excludedAssetIds":original.assets.iter().filter(|a|!document.assets.iter().any(|b|b["id"]==a["id"])).map(|a|a["id"].clone()).collect::<Vec<_>>(),"originalOcrUnchanged":true});
            std::fs::write(directory.join("student-page-selection.json"),serde_json::to_vec_pretty(&selection)?)?;
            built["context"]["sourceScope"]=json!("student_only");built["context"]["studentOnlyPages"]=json!(page_numbers);
            built["evidence"]["pageSelection"]=selection;
            prompt.push_str("\n本次只转录明确提供的学生题面页，不处理答案版。answer、solution及parts中原答案/原解析字段必须为空字符串，不自主求解；题面给定的参考公式、数据、概率附录及图表必须完整留在stem或对应小问，不能当作答案资料省略。");
        }
        std::fs::write(directory.join("compact-input.json"),serde_json::to_vec(&built["context"])?)?;
        std::fs::write(directory.join("input-evidence.json"),serde_json::to_vec_pretty(&built["evidence"])?)?;
        let raw=model.whole_transcription_trial(&built["context"],&prompt,&document.assets,effort,&directory,started,cancel,deadline_seconds)?;
        let mut validation=whole_transcription_trial::validate(&raw,&document)?;
        if student_only {
            let references_empty=rows(&raw["questions"]).iter().all(|q|s(q,"answer").is_empty()&&s(q,"solution").is_empty()&&rows(&q["parts"]).iter().all(|p|p[2].as_str()==Some("")&&p[3].as_str()==Some("")));
            validation["checks"].as_array_mut().unwrap().push(json!({"code":"student_only_no_reference_output","passed":references_empty,"details":if references_empty{vec![]}else{vec!["学生题面试验返回了非空答案解析，未静默擦除或采纳。"]}}));
            if !references_empty{validation["valid"]=json!(false);}
        }
        std::fs::write(directory.join("candidate.json"),serde_json::to_vec_pretty(&raw)?)?;
        std::fs::write(directory.join("validation.json"),serde_json::to_vec_pretty(&validation)?)?;
        if started.elapsed()>=std::time::Duration::from_secs(deadline_seconds) {return Err(err("whole_trial_deadline","已达整卷硬截止，已强制停止；完整响应仅保留作证据。"));}
        Ok(json!({"schemaVersion":1,"experiment":experiment,"thinkingEffort":effort,"deadlineSeconds":deadline_seconds,"studentOnlyPages":student_pages,"elapsedMs":started.elapsed().as_millis() as u64,"strictJsonComplete":true,"contractPassed":validation["valid"],"requiresReview":validation["requiresReview"],"questionCount":raw["questions"].as_array().map_or(0,Vec::len),"candidate":raw,"validation":validation,"teachingCalls":0,"qwenCalls":0,"ocrCalls":0,"published":false,"importRecordChanged":false}))
    })();
    let outcome=match run {Ok(value)=>value,Err(error)=>json!({"schemaVersion":1,"experiment":experiment,"thinkingEffort":effort,"deadlineSeconds":deadline_seconds,"studentOnlyPages":student_pages,"elapsedMs":started.elapsed().as_millis() as u64,"strictJsonComplete":false,"contractPassed":false,"error":{"code":error.code,"message":error.message},"published":false,"importRecordChanged":false})};
    std::fs::write(directory.join("outcome.json"),serde_json::to_vec_pretty(&outcome)?)?;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resumed_ocr_audit_path_uses_canonical_parent_even_before_directory_creation() {
        let directory=tempfile::tempdir().unwrap();
        let parent=directory.path().join("imports/import-simulated-recovery");
        std::fs::create_dir_all(&parent).unwrap();
        let target=parent.canonicalize().unwrap().join("ocr-recovery-simulated");
        assert!(audit_relative_path_in(directory.path(),&target).is_err());
        assert_eq!(planned_audit_relative_path_in(directory.path(),&target).unwrap(),"imports/import-simulated-recovery/ocr-recovery-simulated");
        assert!(!target.exists());
    }
    #[test]
    fn ocr_trial_rejects_unmarked_runtime_before_upload_or_model_access() {
        let directory=tempfile::tempdir().unwrap();
        let mut store=Store::open(directory.path(),&crate::bank::tests::seed()).unwrap();
        let model=ModelClient::open(directory.path()).unwrap();
        let result=prepare_ocr(&mut store,&model,&json!({}),&AtomicBool::new(false));
        assert_eq!(result.unwrap_err().code,"source_trial_isolation_required");
        assert!(!directory.path().join("imports").exists());
    }
    #[test]
    fn source_trial_requires_isolation_and_refuses_historical_question_payloads() {
        let directory=tempfile::tempdir().unwrap();
        let store=Store::open(directory.path(),&crate::bank::tests::seed()).unwrap();
        assert_eq!(seed(&store,&json!({"record":{}})).unwrap_err().code,"source_trial_isolation_required");
        std::fs::write(directory.path().join("source-trial.json"),json!({"experiment":EXPERIMENT,"noPublish":true}).to_string()).unwrap();
        assert!(seed(&store,&json!({"record":{"questions":[{"stem":"must not be reused"}]}})).is_err());
        assert!(!ImportScope::Full.source_only());
        assert!(ImportScope::SourceTrial{layout:true,plan_only:false}.source_only());
        assert!(ImportScope::SourceTrial{layout:false,plan_only:true}.plan_only());
    }
}

/// Reuse the ordinary upload and OCR code, stopping before any model catalogue or source work.
pub(super) fn prepare_ocr(store:&mut Store,model:&ModelClient,payload:&Value,cancel:&AtomicBool)->AppResult<Value> {
    let marker:Value=serde_json::from_slice(&std::fs::read(store.data_dir.join("index-batch-trial.json")).map_err(|_|err("source_trial_isolation_required","OCR试验只允许显式隔离目录。"))?)?;
    if marker!=json!({"experiment":"index-batch-120s-v1","noPublish":true}) {return Err(err("source_trial_isolation_required","OCR隔离标记不匹配。"));}
    match stage_import(store,model,payload,cancel)? {
        StagedImport::Existing(record)=>Ok(json!({"import":record,"replayed":true,"modelCalls":0})),
        StagedImport::Ready(record,bytes)=>process_import_scoped(store,model,operation(payload)?,&hash_json(payload),cancel,record,bytes,ImportScope::OcrTrial),
    }
}

/// Explicit GET-only resumption into a new audit directory. Never accepts a URL or job ID from the caller.
pub(super) fn resume_existing_ocr(store:&Store,model:&ModelClient,payload:&Value,cancel:&AtomicBool)->AppResult<Value> {
    let marker:Value=serde_json::from_slice(&std::fs::read(store.data_dir.join("ocr-recovery-trial.json")).map_err(|_|err("source_trial_isolation_required","识别恢复只允许新复制的隔离目录。"))?)?;
    if marker!=json!({"experiment":"ocr-existing-job-recovery-v1","noPublish":true}) {return Err(err("source_trial_isolation_required","识别恢复隔离标记不匹配。"));}
    let fields=["importId","expectedRevision","operationId","sourceSha256","previousAttemptSha256"];
    if !payload.as_object().is_some_and(|o|o.len()==fields.len()&&fields.iter().all(|k|o.contains_key(*k))) {return Err(err("invalid_input","缺少受限识别恢复身份。"));}
    let _generator=model.import_generator()?;
    let settings=crate::ocr_settings::OcrSettings::open(&store.data_dir)?;
    if !settings.configured() {return Err(err("ocr_not_configured","请先配置独立试卷识别服务。"));}
    let op=operation(payload)?;let request_hash=hash_json(payload);
    let mut record=store.document("imports",s(payload,"importId"))?;
    revision(&record,payload)?;
    if record["status"]!="failed" || record["ocrSource"].is_object() || !rows(&record["questions"]).is_empty() || !rows(&record["publishedQuestionIds"]).is_empty() || payload["sourceSha256"]!=record["source"]["sha256"] {return Err(err("source_trial_completed","已有成功OCR或题目不会重复识别。"));}
    let bytes=read_source(store,&record)?;
    let pdf=lopdf::Document::load_mem(&bytes).map_err(|_|err("invalid_source","原PDF无法校验。"))?;let pages=pdf.get_pages().len();
    if pages==0||pages>50 {return Err(err("page_limit","原PDF页数不在识别范围。"));}
    let root=store.data_dir.join("imports").join(s(&record,"importId")).canonicalize()?;
    if !root.starts_with(store.data_dir.join("imports").canonicalize()?) {return Err(err("source_changed","来源目录越界。"));}
    let old_relative=s(&record["ocrAttempt"],"relativePath");let old=store.data_dir.join(old_relative).canonicalize()?;
    if !old.starts_with(&root) || record["ocrAttempt"]["provider"]!=settings.descriptor() {return Err(err("source_changed","原识别目录或服务商配置不匹配。"));}
    let mut files=vec![];
    for entry in std::fs::read_dir(&old)? {let entry=entry?;let metadata=std::fs::symlink_metadata(entry.path())?;if metadata.file_type().is_symlink(){return Err(err("source_changed","原识别证据不能包含链接。"));}if metadata.is_file(){let data=std::fs::read(entry.path())?;files.push(json!({"name":entry.file_name().to_string_lossy(),"sha256":sha(&data),"bytes":data.len()}));}}
    files.sort_by(|a,b|s(a,"name").cmp(s(b,"name")));
    if payload["previousAttemptSha256"]!=hash_json(&json!(files)) {return Err(err("source_changed","原识别证据已变化，未发起恢复。"));}
    // Derive from the canonical import parent (Windows may use a \\?\ prefix).
    let path=root.join(format!("ocr-recovery-{}",&hash_json(&json!(op))[..24]));
    let before=record.clone();
    let submit=files.iter().find(|f|f["name"]=="001-submit.json")
        .ok_or_else(||err("ocr_resume_missing_job","旧识别记录缺少已受理任务的原始凭据。"))?;
    let binding=json!({"sourceSha256":sha(&bytes),"submitSha256":submit["sha256"],
        "oldAuditPath":old.to_string_lossy(),"files":files});
    let result=crate::ocr::resume_existing(&settings,&bytes,s(&record,"filename"),&old,&path,Some(&binding),cancel);
    record["ocrRecovery"]=json!({"mode":"existing_job_get_only","newOcrSubmission":false,"previousAttemptSha256":payload["previousAttemptSha256"],"previousAttempt":record["ocrAttempt"],"recoveryRelativePath":planned_audit_relative_path(store,&path)?,"operationId":op});
    if path.join("accepted-job.json").is_file() {
        record["ocrAttempt"]=json!({"relativePath":planned_audit_relative_path(store,&path)?,"provider":settings.descriptor(),
            "sourceSha256":record["source"]["sha256"],"startedAt":now(),"newOcrSubmission":false,"resumeFrom":record["ocrRecovery"]["previousAttempt"]});
    }
    match result {
        Ok(document)=>{if document.pages.len()!=pages{return Err(err("ocr_page_mismatch","恢复页数与真实PDF不一致，未采纳。"));}paddle::save_document(store,&mut record,&document,&path,settings.descriptor())?;record["source"]["physicalPages"]=json!(pages);record["extractedPages"]=json!(document.pages.iter().map(|p|s(p,"text")).collect::<Vec<_>>());record["sourceIssues"]=json!(document.issues);record["status"]=json!("pending_review");record["recognitionStage"]=json!("ocr_ready");record["error"]=Value::Null;},
        Err(error)=>{record["status"]=json!("failed");record["error"]=serde_json::to_value(error)?;},
    }
    finish(&mut record,op,&request_hash,"ocr_existing_job_recovery");save_cas(store,Some(&before),&record)?;
    Ok(json!({"import":record,"newOcrSubmission":false,"modelCalls":0,"published":false}))
}
