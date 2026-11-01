//! Read-only explanations for failed imports, including older generic errors.
//! Never retries a provider or rewrites the original import/audit record.
use super::*;
mod taxonomy;

/// Cheap, pure projection used by background list notifications. It neither
/// opens audit files nor changes job state; full detail may add verified output
/// evidence in `for_record` below.
pub(super) fn process_metadata(record: &Value) -> Value {
    taxonomy::project(record, None, None)
}

fn verified_response(store: &Store, attempt: &Value) -> Option<Value> {
    let relative = s(attempt, "providerResponseRelativePath");
    let expected = s(attempt, "providerResponseSha256");
    if relative.is_empty() || expected.len() != 64 {
        return None;
    }
    let root = store.data_dir.join("imports").canonicalize().ok()?;
    let path = store.data_dir.join(relative).canonicalize().ok()?;
    if !path.starts_with(root) || std::fs::metadata(&path).ok()?.len() > 2 * 1024 * 1024 {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if sha(&bytes) != expected {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

pub(super) fn for_record(store: &Store, record: &Value) -> Value {
    if record["status"] != "failed" && record["backgroundJob"]["status"] != "failed" {
        return Value::Null;
    }
    let error = if record["backgroundJob"]["status"] == "failed" && record["backgroundJob"]["error"].is_object() {
        &record["backgroundJob"]["error"]
    } else { &record["error"] };
    let code = s(error, "code");
    let mut summary = s(error, "message").to_owned();
    let mut location = String::new();
    let mut attempts = rows(&record["modelAttempts"]);
    let checkpoint = &record["sourceStructuring"];
    let source_attempts = rows(&checkpoint["planAttempts"]).into_iter().map(|mut attempt| {
        attempt["diagnosticSourceKind"] = json!("index");
        attempt
    }).chain(rows(&checkpoint["batches"]).into_iter().flat_map(|batch| rows(&batch["attempts"])).map(|mut attempt| {
        attempt["diagnosticSourceKind"] = json!("transcription");
        attempt
    }));
    for mut attempt in source_attempts {
        attempt["at"] = attempt["startedAt"].clone();
        attempt["providerResponseRelativePath"] = attempt["audit"]["responseRelativePath"].clone();
        attempt["providerResponseSha256"] = attempt["audit"]["responseSha256"].clone();
        attempts.push(attempt);
    }
    // An annotation/check job can fail while the original import remains
    // pending review. Never explain that new failure using an old source
    // attempt, even if the old response happens to contain bad JSON.
    if record["backgroundJob"]["status"] == "failed" {
        let operation=s(&record["backgroundJob"],"operationId");
        attempts.retain(|attempt|!operation.is_empty() && (s(attempt,"operationId")==operation
            || s(&attempt["localReplay"],"operationId")==operation));
    }
    attempts.sort_by(|a, b| s(a, "at").cmp(s(b, "at")));
    let last_operation = attempts.last().map(|a|a["operationId"].clone()).unwrap_or(Value::Null);
    let latest = attempts.iter().rev().find(|a| a["operationId"] == last_operation && a["status"] == "failed"
        && (a["error"]["code"] == code || a["errorCode"] == code))
        .or_else(||attempts.last()).cloned().unwrap_or(Value::Null);
    // A local validation replay consumes no provider call. Keep the selected
    // response above for read-only diagnostics, but count actual requests in
    // the latest explicit provider operation rather than accumulated history.
    let provider_attempts = attempts.iter().filter(|a| a["localReplay"]["providerCalled"] != false).collect::<Vec<_>>();
    let latest_provider = provider_attempts.last().copied().unwrap_or(&Value::Null);
    let operation_attempts = provider_attempts.iter().copied()
        .filter(|a| a["operationId"] == latest_provider["operationId"])
        .collect::<Vec<_>>();
    let calls = operation_attempts.len();
    let index_calls = operation_attempts
        .iter()
        .filter(|a| a["diagnosticSourceKind"] == "index")
        .count();
    let transcription_calls = operation_attempts
        .iter()
        .filter(|a| a["diagnosticSourceKind"] == "transcription")
        .count();
    let stage = if code.starts_with("model_") {
        "模型整理"
    } else if matches!(
        code,
        "ocr_material_unassigned"
            | "ocr_question_coverage"
            | "ocr_asset_unresolved"
            | "ocr_answer_asset"
            | "ocr_teacher_asset_unverified"
            | "invalid_import"
            | "invalid_annotation"
            | "invalid_knowledge_annotation"
    ) {
        "题目内容核验"
    } else if code.starts_with("ocr_") {
        "试卷识别"
    } else if code.starts_with("docx_") || code == "document_converter_missing" {
        "文件转换"
    } else if matches!(code, "source_changed" | "invalid_source" | "storage_error") {
        "本地文件校验"
    } else if !attempts.is_empty() {
        "题目整理与核验"
    } else {
        "文件读取"
    };
    let response = if matches!(
        code,
        "model_error"
            | "model_output_invalid_json"
            | "model_output_truncated"
            | "model_output_empty"
    ) { verified_response(store, &latest) } else { None };
    if let Some(response) = response.as_ref() {
            let choice = &response["choices"][0];
            let content = choice["message"]["content"].as_str();
            if response["httpStatus"]
                .as_u64()
                .is_some_and(|status| !(200..300).contains(&status))
            {
                summary = format!(
                    "模型服务返回 HTTP {}，本次题目整理未完成。",
                    response["httpStatus"]
                );
            } else if choice["finish_reason"] == "length" {
                summary = "模型输出达到长度上限，返回结果不完整，未保存为题目。".into();
            } else if let Some(content) = content {
                if content.trim().is_empty() {
                    summary = "模型没有返回可读取的内容，未生成可审核题目。".into();
                } else {
                    match serde_json::from_str::<Value>(content) {
                        Err(error) => {
                            summary = "模型返回的 JSON 格式不合法，未生成可审核题目。".into();
                            location =
                                format!("模型响应第 {} 行，第 {} 列", error.line(), error.column());
                        }
                        Ok(value) if !value.is_object() => {
                            summary = "模型返回的 JSON 顶层不是题目对象，未生成可审核题目。".into()
                        }
                        _ => {}
                    }
                }
            }
    }
    if summary.is_empty() {
        summary = "导入未完成，当前记录没有保存更详细的失败原因。".into();
    }
    let ocr_completed = record["ocrSource"].is_object();
    let metadata = taxonomy::project(record, Some(&latest), response.as_ref());
    let next_action = if metadata["category"] == "business" {
        if metadata["subcategory"] == "integrity" {
            "核对来源或版本变更，重新读取当前记录后再处理；保留原件与成功结果，不忽略完整性阻断。"
        } else {
            "对照原卷核对所列题号、文字与图表；确认材料后再显式继续，不能只靠重试或高置信度放行。"
        }
    } else if metadata["subcategory"] == "configuration" {
        if metadata["serviceLabel"] == "本机文件与运行环境" {
            "检查本机Word或LibreOffice，也可以先导出PDF再导入；原件和成功结果保留。"
        } else {
            "检查对应用途的服务商、模型、密钥及能力设置，保存后显式继续；已有OCR和成功批次会保留。"
        }
    } else if checkpoint.is_object() && ocr_completed {
        "点击“重新解析”继续未完成批次；已保存的OCR及成功批次会保留，不重复调用。"
    } else if stage == "模型整理" || stage == "题目内容核验" || stage == "题目整理与核验"
    {
        if ocr_completed {
            "点击“重新解析”，使用已保存的识别材料重新整理；若仍失败，请查看原卷核对对应页和题目。"
        } else {
            "查看原卷并核对提示位置，再点击“重新解析”；必要时检查当前模型配置。"
        }
    } else if stage == "试卷识别" {
        "检查设置中的试卷识别服务、密钥及网络，然后点击“重新解析”；原文件保留。"
    } else if stage == "文件转换" {
        "检查本机 Word 或 LibreOffice，也可以先将原文件导出为 PDF 再导入。"
    } else {
        "检查原文件是否完整且可读取；保留当前记录，处理提示问题后再重试。"
    };
    let batches = rows(&checkpoint["batches"]);
    let plan = rows(&checkpoint["plan"]["questions"]);
    let saved_questions = batches.iter().filter(|batch|batch["status"] == "succeeded")
        .flat_map(|batch|rows(&batch["questions"]))
        .filter_map(|q| q["questionId"].as_str().filter(|id|!id.is_empty()).map(str::to_owned))
        .collect::<HashSet<_>>().len();
    let mut failed_labels = vec![];
    for batch in batches.iter().filter(|batch|batch["status"] == "failed") {
        let bounds = batch["start"].as_u64().zip(batch["end"].as_u64());
        if let Some((start,end)) = bounds.filter(|(start,end)|start < end && *end <= plan.len() as u64) {
            for q in &plan[start as usize..end as usize] {
                let label = s(q,"sourceLabel");
                if !label.is_empty() && !failed_labels.iter().any(|v|v == label) { failed_labels.push(label.to_owned()); }
            }
        }
    }
    let mut result = json!({"stage":stage,"summary":summary,"location":location,"nextAction":next_action,"attempts":calls,
        "indexCalls":index_calls,"transcriptionCalls":transcription_calls,"sourceRequestBreakdown":calls>0 && index_calls+transcription_calls==calls,
        "ocrCompleted":ocr_completed,"sourceBatchCount":batches.len(),"completedSourceBatches":batches.iter().filter(|batch|batch["status"]=="succeeded").count(),
        "savedSourceQuestions":saved_questions,"expectedSourceQuestions":plan.len(),"failedSourceLabels":failed_labels});
    result.as_object_mut().unwrap().extend(metadata.as_object().unwrap().clone());
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn saved_batches_explain_continuation_without_reissuing_or_mutating() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), &crate::bank::tests::seed()).unwrap();
        let record = json!({"status":"failed","error":{"code":"model_response_timeout","message":"模拟超时"},"ocrSource":{},"modelAttempts":[{"at":"2026-10-24T01:00:00Z","operationId":"old"}],"sourceStructuring":{"batches":[{"status":"succeeded","attempts":[{"startedAt":"2026-10-24T02:00:00Z","operationId":"new"}]},{"status":"failed","attempts":[{"startedAt":"2026-10-24T02:01:00Z","operationId":"new"}]}]}});
        let before = record.clone();
        let result = for_record(&store, &record);
        assert_eq!(result["sourceBatchCount"], 2);
        assert_eq!(result["completedSourceBatches"], 1);
        assert_eq!(result["attempts"], 2);
        assert!(s(&result, "nextAction").contains("成功批次会保留"));
        assert_eq!(record, before);
    }
    #[test]
    fn failed_source_progress_distinguishes_saved_drafts_from_delivery_and_provider_requests() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), &crate::bank::tests::seed()).unwrap();
        let ranges = [(0,3),(3,6),(6,9),(9,12),(12,14),(14,15),(15,16),(16,17),(17,18),(18,19)];
        let batches = ranges.iter().enumerate().map(|(index,(start,end))| {
            let failed = matches!(index,4|8);
            json!({"start":start,"end":end,"status":if failed{"failed"}else{"succeeded"},
                "questions":if failed{vec![]}else{(*start..*end).map(|n|json!({"questionId":format!("sim-q{}",n+1)})).collect::<Vec<_>>()},
                "attempts":[{"startedAt":format!("2026-10-27T02:{:02}:00Z",index+1),"operationId":"new"}]})
        }).collect::<Vec<_>>();
        let record = json!({"status":"failed","error":{"code":"model_output_invalid_json","message":"模拟格式错误"},"ocrSource":{},
            "questions":[],"sourceStructuring":{"plan":{"questions":(1..=19).map(|n|json!({"sourceLabel":n.to_string()})).collect::<Vec<_>>()},
                "planAttempts":[{"startedAt":"2026-10-27T02:00:00Z","operationId":"new"}],"batches":batches}});
        store.put_document("imports","sim-source-progress",&record).unwrap();
        let before = record.clone();
        let result = for_record(&store,&record);
        assert_eq!(result["attempts"],11);
        assert_eq!(result["indexCalls"],1);
        assert_eq!(result["transcriptionCalls"],10);
        assert_eq!(result["sourceRequestBreakdown"],true);
        assert_eq!(result["sourceBatchCount"],10);
        assert_eq!(result["completedSourceBatches"],8);
        assert_eq!(result["savedSourceQuestions"],16);
        assert_eq!(result["expectedSourceQuestions"],19);
        assert_eq!(result["failedSourceLabels"],json!(["13","14","18"]));
        assert!(record["questions"].as_array().unwrap().is_empty(),"drafts are not delivered questions");
        assert_eq!(record,before);
        assert_eq!(store.document("imports","sim-source-progress").unwrap(),record);

        let mut retry = record.clone();
        retry["sourceStructuring"]["batches"][4]["attempts"].as_array_mut().unwrap().push(json!({"startedAt":"2026-10-27T03:00:00Z","operationId":"retry"}));
        retry["sourceStructuring"]["batches"][0]["attempts"].as_array_mut().unwrap().push(json!({"startedAt":"2026-10-27T03:01:00Z","operationId":"new","localReplay":{"operationId":"retry","providerCalled":false}}));
        let result = for_record(&store,&retry);
        assert_eq!(result["attempts"],1,"a new operation excludes old calls and local replay");
        assert_eq!(result["indexCalls"],0);
        assert_eq!(result["transcriptionCalls"],1);
        assert_eq!(result["savedSourceQuestions"],16,"old successful checkpoints remain visible");
        retry["modelAttempts"] = json!([{"at":"2026-10-27T04:00:00Z","operationId":"other-task"}]);
        let result = for_record(&store,&retry);
        assert_eq!(result["attempts"],1);
        assert_eq!(result["sourceRequestBreakdown"],false,"non-source requests retain generic diagnostics");
        assert_eq!(result["indexCalls"],0);
        assert_eq!(result["transcriptionCalls"],0);
    }
    #[test]
    fn diagnostic_question_labels_require_a_real_valid_plan_interval() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), &crate::bank::tests::seed()).unwrap();
        let record=json!({"status":"failed","error":{"code":"source_batch_incomplete","message":"模拟未完成"},"sourceStructuring":{
            "plan":{"questions":[{"sourceLabel":"1"},{"sourceLabel":""},{"sourceLabel":"3"}]},
            "batches":[
                {"status":"failed","start":-1,"end":1},{"status":"failed","start":0,"end":4},
                {"status":"failed","start":2,"end":1},{"status":"failed","start":1,"end":1},
                {"status":"failed","start":"0","end":1},{"status":"failed","start":1,"end":3},
                {"status":"failed","start":2,"end":3},{"status":"pending","start":0,"end":1},
                {"status":"succeeded","questions":[{"questionId":"saved"},{"questionId":"saved"},{"questionId":""}]},
                {"status":"failed","questions":[{"questionId":"not-delivered"}]}
            ]}});
        let before=record.clone();
        let result=for_record(&store,&record);
        assert_eq!(result["failedSourceLabels"],json!(["3"]));
        assert_eq!(result["savedSourceQuestions"],1,"count only unique nonempty identities in saved batches");
        assert_eq!(result["expectedSourceQuestions"],3);
        assert_eq!(result["attempts"],0);
        assert_eq!(record,before);
    }
    #[test]
    fn historic_generic_failure_is_explained_from_verified_audit_without_mutation() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), &crate::bank::tests::seed()).unwrap();
        let audit_dir = dir.path().join("imports/simulated");
        std::fs::create_dir_all(&audit_dir).unwrap();
        let path = audit_dir.join("response.json");
        let bad = r#"{"questions":[{"solutionPaths":[{"basis":"private source text",\"}]}]}"#;
        let response = json!({"httpStatus":200,"choices":[{"finish_reason":"stop","message":{"content":bad}}]});
        let bytes = serde_json::to_vec(&response).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        let record = json!({"status":"failed","error":{"code":"model_error","message":"模型建议未通过结构校验，请重试。"},"ocrSource":{},"modelAttempts":[{"operationId":"simulated","providerResponseRelativePath":"imports/simulated/response.json","providerResponseSha256":sha(&bytes)}]});
        let explanation = for_record(&store, &record);
        assert_eq!(explanation["stage"], "模型整理");
        assert!(s(&explanation, "summary").contains("JSON 格式不合法"));
        assert!(s(&explanation, "location").contains("第 1 行"));
        assert!(!explanation.to_string().contains("private source text"));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        let mut altered = record.clone();
        altered["modelAttempts"][0]["providerResponseSha256"] = json!("0".repeat(64));
        assert_eq!(
            for_record(&store, &altered)["summary"],
            record["error"]["message"]
        );
        let outside = dir.path().join("outside.json");
        std::fs::write(&outside, &bytes).unwrap();
        altered["modelAttempts"][0]["providerResponseRelativePath"] = json!("outside.json");
        altered["modelAttempts"][0]["providerResponseSha256"] = json!(sha(&bytes));
        assert_eq!(
            for_record(&store, &altered)["summary"],
            record["error"]["message"]
        );
        altered["status"] = json!("pending_review");
        assert!(for_record(&store, &altered).is_null());
    }
    #[test]
    fn failed_metadata_job_never_borrows_a_prior_source_response() {
        let dir=tempfile::tempdir().unwrap();
        let store=Store::open(dir.path(),&crate::bank::tests::seed()).unwrap();
        let audit=dir.path().join("imports/simulated-old");std::fs::create_dir_all(&audit).unwrap();
        let bytes=serde_json::to_vec(&json!({"httpStatus":200,"choices":[{"finish_reason":"stop","message":{"content":"{bad old source"}}]})).unwrap();
        std::fs::write(audit.join("response.json"),&bytes).unwrap();
        let record=json!({"status":"pending_review","recognitionStage":"complete","error":null,
            "backgroundJob":{"status":"failed","mode":"annotation","operationId":"new-annotation","error":{"code":"model_error","message":"模拟新任务原因未定位"}},
            "modelAttempts":[{"operationId":"old-source","at":"2026-10-01T00:00:00Z","providerResponseRelativePath":"imports/simulated-old/response.json","providerResponseSha256":sha(&bytes)}]});
        let before=record.clone();let result=for_record(&store,&record);
        assert_eq!(result["stageKey"],"annotation");assert_eq!(result["category"],"unknown");assert_eq!(result["summary"],"模拟新任务原因未定位");
        assert_eq!(result["attempts"],0);assert_eq!(result["evidenceBasis"],"unknown");assert_eq!(record,before);
        let mut missing_operation=record.clone();missing_operation["backgroundJob"].as_object_mut().unwrap().remove("operationId");
        assert_eq!(for_record(&store,&missing_operation)["category"],"unknown");
    }
    #[test]
    fn verified_http_error_is_service_or_config_not_model_math_failure() {
        let dir=tempfile::tempdir().unwrap();let store=Store::open(dir.path(),&crate::bank::tests::seed()).unwrap();
        let audit=dir.path().join("imports/simulated-http");std::fs::create_dir_all(&audit).unwrap();
        for (status,kind) in [(401,"configuration"),(429,"service"),(503,"service")] {
            let bytes=serde_json::to_vec(&json!({"httpStatus":status})).unwrap();std::fs::write(audit.join("response.json"),&bytes).unwrap();
            let record=json!({"status":"failed","recognitionStage":"source_indexing","error":{"code":"model_error","message":"模拟服务失败"},"modelAttempts":[{"providerResponseRelativePath":"imports/simulated-http/response.json","providerResponseSha256":sha(&bytes)}]});
            let result=for_record(&store,&record);assert_eq!(result["category"],"infrastructure");assert_eq!(result["subcategory"],kind);assert_eq!(result["stageKey"],"source_index");
        }
        let result=process_metadata(&json!({"status":"failed","recognitionStage":"structuring","error":{"code":"ocr_question_coverage","message":"需核对题号"}}));
        assert_eq!(result["serviceLabel"],"本地来源与内容校验");assert_eq!(result["category"],"business");
    }
}
