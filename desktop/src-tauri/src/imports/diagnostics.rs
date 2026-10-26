//! Read-only explanations for failed imports, including older generic errors.
//! Never retries a provider or rewrites the original import/audit record.
use super::*;

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
    if record["status"] != "failed" {
        return Value::Null;
    }
    let code = s(&record["error"], "code");
    let mut summary = s(&record["error"], "message").to_owned();
    let mut location = String::new();
    let mut attempts = rows(&record["modelAttempts"]);
    let checkpoint = &record["sourceStructuring"];
    for mut attempt in rows(&checkpoint["planAttempts"]).into_iter().chain(
        rows(&checkpoint["batches"]).into_iter().flat_map(|batch| rows(&batch["attempts"]))
    ) {
        attempt["at"] = attempt["startedAt"].clone();
        attempt["providerResponseRelativePath"] = attempt["audit"]["responseRelativePath"].clone();
        attempt["providerResponseSha256"] = attempt["audit"]["responseSha256"].clone();
        attempts.push(attempt);
    }
    attempts.sort_by(|a, b| s(a, "at").cmp(s(b, "at")));
    let latest = attempts.last().cloned().unwrap_or(Value::Null);
    let calls = attempts
        .iter()
        .filter(|a| a["operationId"] == latest["operationId"])
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
    if matches!(
        code,
        "model_error"
            | "model_output_invalid_json"
            | "model_output_truncated"
            | "model_output_empty"
    ) {
        if let Some(response) = verified_response(store, &latest) {
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
    }
    if summary.is_empty() {
        summary = "导入未完成，当前记录没有保存更详细的失败原因。".into();
    }
    let ocr_completed = record["ocrSource"].is_object();
    let next_action = if checkpoint.is_object() && ocr_completed {
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
    json!({"stage":stage,"summary":summary,"location":location,"nextAction":next_action,"attempts":calls,"ocrCompleted":ocr_completed,"sourceBatchCount":batches.len(),"completedSourceBatches":batches.iter().filter(|batch|batch["status"]=="succeeded").count()})
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
}
