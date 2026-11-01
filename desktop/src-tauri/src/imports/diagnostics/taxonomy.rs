//! A read-only display projection, not an error recovery or release decision.
//! Keep stage (where work stopped) separate from failure family (what failed).
use super::*;

fn source_validation_code(code: &str) -> bool {
    matches!(
        code,
        "ocr_material_unassigned"
            | "ocr_material_role"
            | "ocr_question_coverage"
            | "ocr_asset_unresolved"
            | "ocr_answer_asset"
            | "ocr_teacher_asset_unverified"
            | "source_batch_incomplete"
            | "source_content_unresolved"
            | "invalid_import"
            | "source_material_changed"
            | "source_asset_binding_invalid"
    )
}

pub(super) fn stage_key(record: &Value, latest: Option<&Value>) -> &'static str {
    let error = if record["backgroundJob"]["status"] == "failed"
        && record["backgroundJob"]["error"].is_object()
    {
        &record["backgroundJob"]["error"]
    } else {
        &record["error"]
    };
    let code = s(error, "code");
    if record["backgroundJob"]["status"] == "failed" {
        match s(&record["backgroundJob"], "mode") {
            "annotation" => return "annotation",
            "review" => return "source_validation",
            "teaching_retry" => return "teaching_generation",
            _ => {}
        }
    }
    if code == "source_plan_invalid" {
        return "source_index";
    }
    if source_validation_code(code) {
        return "source_validation";
    }
    if code.starts_with("docx_") || code == "document_converter_missing" {
        return "preparing";
    }
    if code.starts_with("ocr_") {
        return "ocr";
    }
    match s(record, "recognitionStage") {
        "queued" | "preparing" | "converting" | "reading" => "preparing",
        "recognizing" | "ocr_ready" => "ocr",
        "source_indexing" => "source_index",
        "source_validating" | "reviewing" => "source_validation",
        "teaching_generating" => "teaching_generation",
        "teaching_checking" => "teaching_check",
        "teaching_review" => "teaching_review",
        "annotating" => "annotation",
        "structuring" => {
            if record["sourceStructuring"].is_object()
                && record["sourceStructuring"]["plan"].is_null()
            {
                "source_index"
            } else {
                "source_transcription"
            }
        }
        "complete" if !matches!(s(record, "status"), "failed" | "processing") => "user_review",
        _ => match latest.map(|v| s(v, "diagnosticSourceKind")) {
            Some("index") => "source_index",
            Some("transcription") => "source_transcription",
            _ => match s(&record["backgroundJob"], "mode") {
                "annotation" => "annotation",
                "review" => "source_validation",
                "teaching_retry" => "teaching_generation",
                _ => "unknown",
            },
        },
    }
}

pub(super) fn stage_label(key: &str) -> &'static str {
    match key {
        "preparing" => "接收与准备文件",
        "ocr" => "OCR识别与材料保存",
        "source_index" => "建立整卷索引",
        "source_transcription" => "分批转录原题",
        "source_validation" => "来源完整性校验",
        "teaching_generation" => "生成课堂教学稿",
        "teaching_check" => "教学稿检查",
        "teaching_review" => "按问题复核教学稿",
        "user_review" => "用户核对与入库",
        "annotation" => "补充考查信息",
        _ => "阶段待定位",
    }
}

fn http_status(response: Option<&Value>, message: &str) -> Option<u64> {
    if let Some(status) = response.and_then(|v| v["httpStatus"].as_u64()) {
        return Some(status);
    }
    // These are the application's exact HTTP error templates, not arbitrary
    // number extraction from source content or a teacher's problem description.
    for marker in ["HTTP ", "返回HTTP ", "模型服务返回 ", "模型列表服务返回 "] {
        if let Some(tail) = message.split_once(marker).map(|(_, tail)| tail) {
            let digits = tail
                .chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>();
            if digits.len() == 3 {
                if let Ok(status) = digits.parse::<u64>() {
                    return Some(status);
                }
            }
        }
    }
    None
}

pub(super) fn project(record: &Value, latest: Option<&Value>, response: Option<&Value>) -> Value {
    let error = if record["backgroundJob"]["status"] == "failed"
        && record["backgroundJob"]["error"].is_object()
    {
        &record["backgroundJob"]["error"]
    } else {
        &record["error"]
    };
    let code = s(error, "code");
    let message = s(error, "message");
    let stage = stage_key(record, latest);
    let service = if code.starts_with("ocr_") || stage == "ocr" {
        "试卷识别服务"
    } else if code.starts_with("docx_")
        || matches!(
            code,
            "storage_error" | "storage_busy" | "document_converter_missing"
        )
    {
        "本机文件与运行环境"
    } else if code.starts_with("model_")
        || code.starts_with("import_model_")
        || matches!(
            stage,
            "source_index"
                | "source_transcription"
                | "teaching_generation"
                | "teaching_review"
                | "annotation"
        )
    {
        "当前用途的模型服务"
    } else {
        "本地导入校验"
    };
    let operation = if message.contains("模型列表") || code == "model_catalog_error" {
        "获取服务商模型列表"
    } else if message.contains("连接") {
        "连接服务"
    } else if message.contains("读取") && code.starts_with("model_") {
        "读取模型响应"
    } else if code.starts_with("model_output_") || code == "invalid_teaching_patch" {
        "解析与校验模型输出"
    } else {
        stage_label(stage)
    };
    let status = http_status(response, message);
    let verified_output = response.is_some_and(|v| {
        let choice = &v["choices"][0];
        status.is_none_or(|s| (200..300).contains(&s))
            && (choice["finish_reason"] == "length"
                || choice["message"]["content"].as_str().is_some_and(|text| {
                    text.trim().is_empty()
                        || serde_json::from_str::<Value>(text).is_err()
                        || serde_json::from_str::<Value>(text).is_ok_and(|v| !v.is_object())
                }))
    });
    let output_code = matches!(
        code,
        "model_output_invalid_json"
            | "model_output_truncated"
            | "model_output_empty"
            | "invalid_teaching_patch"
            | "invalid_teaching_output"
            | "invalid_quality_signals"
            | "teaching_quality_unchanged"
            | "teaching_quality_unresolved"
    );
    let config_code = matches!(
        code,
        "not_configured"
            | "import_model_not_configured"
            | "import_model_unavailable"
            | "ocr_not_configured"
            | "ocr_authentication"
            | "credential_error"
            | "unsupported_effort"
            | "source_image_unsupported"
            | "model_image_unsupported"
            | "document_converter_missing"
            | "docx_renderer_unavailable"
    );
    let network_code = matches!(
        code,
        "model_request_timeout"
            | "model_response_timeout"
            | "model_stream_incomplete"
            | "ocr_network"
            | "ocr_timeout"
    );
    let known_transport_message = (code == "model_error"
        && [
            "模型连接失败",
            "模型响应读取中断",
            "无法初始化模型连接",
            "无法初始化来源模型目录连接",
            "无法启动模型请求",
            "无法启动试验请求",
            "无法初始化试验请求",
        ]
        .iter()
        .any(|v| message.starts_with(v)))
        || (code == "model_catalog_error"
            && [
                "获取模型列表超时",
                "获取模型列表失败，请检查网络",
                "模型列表读取中断",
                "无法初始化模型列表连接",
            ]
            .iter()
            .any(|v| message.starts_with(v)));
    let service_code = matches!(
        code,
        "model_catalog_error"
            | "model_stream_invalid"
            | "ocr_http_error"
            | "ocr_provider_error"
            | "ocr_queue_full"
            | "ocr_failed"
            | "ocr_job_failed"
            | "ocr_invalid_response"
            | "ocr_invalid_jsonl"
    );
    let local_code = matches!(
        code,
        "storage_error"
            | "storage_busy"
            | "internal_error"
            | "ocr_runtime"
            | "docx_conversion_failed"
            | "docx_conversion_timeout"
    );
    let integrity_code = matches!(
        code,
        "source_changed"
            | "revision_conflict"
            | "job_changed"
            | "integrity_error"
            | "teaching_audit_changed"
            | "source_audit_changed"
            | "ocr_resume_evidence_changed"
            | "ocr_resume_image_changed"
            | "ocr_source_binding"
    );
    let business_code = source_validation_code(code)
        || matches!(
            code,
            "source_plan_invalid"
                | "invalid_source"
                | "invalid_annotation"
                | "invalid_knowledge_annotation"
                | "source_content_unresolved"
        )
        || code.starts_with("ocr_missing_")
        || matches!(
            code,
            "ocr_reading_order_uncertain" | "ocr_page_count_conflict" | "ocr_page_order_conflict"
        );
    let (category, kind, note) = if config_code || matches!(status, Some(401 | 403)) {
        (
            "infrastructure",
            "configuration",
            "配置、凭据或模型能力未满足要求；不是题目解答错误。",
        )
    } else if status.is_some_and(|s| !(200..300).contains(&s)) {
        (
            "infrastructure",
            "service",
            "服务已返回非成功HTTP状态；须检查额度、限流或服务可用性，不能认定为数学能力问题。",
        )
    } else if matches!(code, "whole_trial_deadline" | "source_budget_exhausted") {
        (
            "infrastructure",
            "budget",
            "已达到本轮来源处理时限；这不是输出格式错误，也不能据此判断题目难或模型不会解。",
        )
    } else if network_code || known_transport_message {
        (
            "infrastructure",
            "network",
            "服务通信未完成；仅凭超时无法确定是网络、服务排队还是模型处理耗时，不据此判定题目难或模型不会解。",
        )
    } else if verified_output
        || output_code
        || (code == "model_error"
            && [
                "模型建议必须是 JSON 对象。",
                "可见输出过长。",
                "模型流超过试验字节预算。",
            ]
            .contains(&message))
    {
        (
            "model_output",
            "format",
            "模型输出未满足格式或补丁合同；这不证明题目答案或数学推导错误。",
        )
    } else if service_code {
        (
            "infrastructure",
            "service",
            "服务接口或返回协议未满足要求；具体服务原因须按实际回执核对。",
        )
    } else if local_code {
        (
            "infrastructure",
            "local",
            "本机运行或存储环节失败；已有原件和成功结果继续保留。",
        )
    } else if integrity_code {
        (
            "business",
            "integrity",
            "来源、版本或内容一致性校验未通过；先核对实际变更，不能靠重试或忽略告警放行。",
        )
    } else if business_code {
        (
            "business",
            "material",
            "题目材料或业务完整性校验未通过；仍须对照原卷确定是原件、OCR还是转录问题，不能直接断言原题有错。",
        )
    } else {
        (
            "unknown",
            "unknown",
            "当前记录不足以确定错误归属；保留原始原因，不把未知错误归咎于模型或原卷。",
        )
    };
    let category_label = match category {
        "infrastructure" => "网络、配置与基础服务",
        "model_output" => "模型输出问题",
        "business" => "材料与业务校验",
        _ => "原因待定位",
    };
    let kind_label = match kind {
        "configuration" => "配置或能力",
        "network" => "网络与通信",
        "service" => "服务接口",
        "local" => "本机环境",
        "budget" => "本轮处理时限",
        "format" => "输出格式或补丁合同",
        "integrity" => "版本与完整性",
        "material" => "来源材料与内容",
        _ => "尚无明确分类",
    };
    let evidence = if response.is_some() {
        "verified_response"
    } else if category != "unknown" {
        "error_code"
    } else {
        "unknown"
    };
    let service = if category == "business" {
        if kind == "integrity" {
            "本地来源与版本校验"
        } else {
            "本地来源与内容校验"
        }
    } else {
        service
    };
    json!({"schemaVersion":1,"stageKey":stage,"stageLabel":stage_label(stage),"category":category,"categoryLabel":category_label,
        "subcategory":kind,"subcategoryLabel":kind_label,"serviceLabel":service,"operationLabel":operation,
        "evidenceBasis":evidence,"causeNote":note})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn project(code: &str, message: &str, stage: &str) -> Value {
        super::project(
            &json!({"status":"failed","recognitionStage":stage,"error":{"code":code,"message":message}}),
            None,
            None,
        )
    }
    #[test]
    fn taxonomy_distinguishes_stage_from_network_model_and_material_failures() {
        for (code, message, category, kind, stage, expected) in [
            (
                "model_request_timeout",
                "连接模型服务超时",
                "infrastructure",
                "network",
                "source_indexing",
                "source_index",
            ),
            (
                "model_response_timeout",
                "读取响应超时",
                "infrastructure",
                "network",
                "teaching_review",
                "teaching_review",
            ),
            (
                "model_output_invalid_json",
                "格式错误",
                "model_output",
                "format",
                "structuring",
                "source_transcription",
            ),
            (
                "ocr_question_coverage",
                "原题号冲突",
                "business",
                "material",
                "structuring",
                "source_validation",
            ),
            (
                "ocr_network",
                "下载连接失败",
                "infrastructure",
                "network",
                "recognizing",
                "ocr",
            ),
            (
                "import_model_not_configured",
                "用途未配置",
                "infrastructure",
                "configuration",
                "source_indexing",
                "source_index",
            ),
            (
                "source_changed",
                "版本改变",
                "business",
                "integrity",
                "structuring",
                "source_transcription",
            ),
            (
                "unknown_future_error",
                "模拟未知失败",
                "unknown",
                "unknown",
                "unknown_future_stage",
                "unknown",
            ),
        ] {
            let actual = project(code, message, stage);
            assert_eq!(actual["category"], category, "{code}");
            assert_eq!(actual["subcategory"], kind, "{code}");
            assert_eq!(actual["stageKey"], expected, "{code}");
        }
    }
    #[test]
    fn generic_model_error_is_not_a_model_defect_without_evidence() {
        assert_eq!(
            project("model_error", "原始通用失败", "unknown")["category"],
            "unknown"
        );
        assert_eq!(
            project(
                "model_error",
                "模型连接失败，请检查网络后重试；已有内容保留。",
                "structuring"
            )["category"],
            "infrastructure"
        );
        let record =
            json!({"status":"failed","error":{"code":"model_error","message":"模拟通用错误"}});
        let response = json!({"httpStatus":200,"choices":[{"finish_reason":"stop","message":{"content":"{bad"}}]});
        let actual = super::project(&record, None, Some(&response));
        assert_eq!(actual["category"], "model_output");
        assert_eq!(actual["evidenceBasis"], "verified_response");
        assert_eq!(actual["stageKey"], "unknown");
        assert_eq!(
            project(
                "model_error",
                "模型服务返回 429，请检查设置或稍后重试。",
                "source_indexing"
            )["subcategory"],
            "service"
        );
        assert_eq!(
            project("model_error", "模型返回HTTP 401。", "source_indexing")["subcategory"],
            "configuration"
        );
        assert_eq!(
            project(
                "model_catalog_error",
                "模型列表服务返回 403，请检查此配置的密钥或稍后重试。",
                "source_indexing"
            )["subcategory"],
            "configuration"
        );
        assert_eq!(
            project(
                "model_catalog_error",
                "获取模型列表超时，请重试。",
                "source_indexing"
            )["subcategory"],
            "network"
        );
        assert_eq!(
            project(
                "whole_trial_deadline",
                "来源本轮120秒已截止。",
                "structuring"
            )["subcategory"],
            "budget"
        );
    }
    #[test]
    fn stages_preserve_explicit_work_and_legacy_unknowns_without_claiming_completion() {
        let record = json!({"status":"failed","recognitionStage":"structuring","sourceStructuring":{"plan":null},"error":{"code":"model_request_timeout"}});
        assert_eq!(
            super::project(&record, None, None)["stageKey"],
            "source_index"
        );
        assert_eq!(
            super::project(
                &json!({"status":"failed","error":{"code":"model_output_empty"}}),
                None,
                None
            )["stageKey"],
            "unknown"
        );
        assert_eq!(
            super::project(
                &json!({"status":"pending_review","recognitionStage":"complete"}),
                None,
                None
            )["stageKey"],
            "user_review"
        );
        let latest = json!({"diagnosticSourceKind":"transcription"});
        assert_eq!(
            super::project(&json!({"status":"failed"}), Some(&latest), None)["stageKey"],
            "source_transcription"
        );
    }
}
