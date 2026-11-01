/** Read-only presentation. Categories describe the observed failure boundary,
 * not mathematical correctness, publication permission, or automatic retries. */
export type ImportFailureCategory = "infrastructure" | "model_output" | "business" | "unknown";
export type ImportStageKey = keyof typeof stageLabels;
export const stageLabels = {
  preparing: "接收与准备文件", ocr: "OCR识别与材料保存", source_index: "建立整卷索引",
  source_transcription: "分批转录原题", source_validation: "来源完整性校验",
  teaching_generation: "生成课堂教学稿", teaching_check: "教学稿检查",
  teaching_review: "按问题复核教学稿", user_review: "用户核对与入库", annotation: "补充考查信息",
  unknown: "阶段待定位",
} as const;
const categories: Record<ImportFailureCategory, string> = {
  infrastructure: "网络与基础服务", model_output: "模型输出与内容", business: "业务与原卷材料", unknown: "原因待定位",
};
const text = (value: unknown) => typeof value === "string" ? value : "";
const has = (object: object, key: string) => Object.hasOwn(object, key);
const stages: Record<string, ImportStageKey> = {
  queued: "preparing", preparing: "preparing", recognizing: "ocr", source_indexing: "source_index",
  structuring: "source_transcription", source_validating: "source_validation", teaching_generating: "teaching_generation",
  teaching_check: "teaching_check", teaching_checking: "teaching_check", teaching_review: "teaching_review", reviewing: "source_validation", annotating: "annotation",
};
export function importStage(record: any, job?: any, diagnostic?: any) {
  const explicit = [diagnostic?.stageKey, job?.stageKey, job?.processStage?.key].map(text)
    .find(key => key !== "unknown" && has(stageLabels, key)) || "";
  const raw = text(job?.stage || record?.recognitionStage);
  const key: ImportStageKey = has(stageLabels, explicit) ? explicit as ImportStageKey
    : has(stages, raw) ? stages[raw] : ["pending_review", "partially_published", "published", "parsed", "review"].includes(record?.status) ? "user_review" : "unknown";
  const state = text(job?.status || record?.status);
  const stateLabel = state === "queued" ? "等待处理" : ["failed", "interrupted", "cancelled"].includes(state) ? "停在此阶段"
    : state === "running" || state === "parsing" ? "正在处理" : state === "published" ? "已入库" : key === "user_review" ? "等待确认" : "当前阶段";
  return { key, label: stageLabels[key], stateLabel };
}
export type ImportFailureView = {
  category: ImportFailureCategory; categoryLabel: string; stageKey: ImportStageKey; stage: string;
  summary: string; nextAction: string; causeNote: string; serviceLabel: string; operationLabel: string;
};
const network = new Set(["model_request_timeout", "model_response_timeout", "ocr_network", "ocr_timeout", "ocr_request_timeout", "model_catalog_timeout"]);
const configuration = new Set(["model_not_configured", "import_model_not_configured", "import_model_unavailable", "model_capability_unknown", "model_vision_unsupported", "ocr_not_configured", "ocr_config_invalid", "credential_error", "document_converter_missing"]);
const service = new Set(["model_catalog_error", "model_rate_limited", "model_http_error", "ocr_service_error", "ocr_http_error"]);
const local = new Set(["storage_error", "storage_busy", "docx_conversion_failed"]);
const output = new Set(["model_output_invalid_json", "model_output_truncated", "model_output_empty", "invalid_teaching_patch", "invalid_teaching_result", "literal_newline_escape", "control_character", "unpaired_math_delimiter", "mixed_math_delimiter", "incomplete_teaching_draft"]);
const business = new Set(["source_plan_invalid", "source_batch_incomplete", "source_changed", "revision_conflict", "integrity_error", "invalid_source", "ocr_question_coverage", "ocr_material_unassigned", "ocr_asset_unresolved", "ocr_material_role", "ocr_table_mismatch", "ocr_answer_asset", "ocr_teacher_asset_unverified", "teaching_publication_receipt_pending"]);

export function importFailure(error: any, options: { record?: any; job?: any; diagnostic?: any; stageKey?: ImportStageKey; type?: string; dimension?: string; domain?: string; workflow?: any } = {}): ImportFailureView {
  const code = text(error?.code), detail = text(error?.message || error?.issue || error?.reason);
  const d = options.diagnostic || (options.job?.errorCategory ? {
    category: options.job.errorCategory, stageKey: options.job.stageKey, stageLabel: options.job.stageLabel,
    causeNote: options.job.errorCauseNote, serviceLabel: options.job.errorServiceLabel, operationLabel: options.job.errorOperationLabel,
  } : undefined);
  let category: ImportFailureCategory = "unknown";
  if (network.has(code) || configuration.has(code) || service.has(code) || local.has(code)) category = "infrastructure";
  else if (output.has(code) || ["display", "format", "incomplete", "term"].includes(options.type || "")) category = "model_output";
  else if (business.has(code) || options.domain === "source" || options.dimension === "material") category = "business";
  else if (options.type === "quality" || options.type === "model_issue") category = "model_output";
  if (has(categories, text(d?.category))) category = d.category;
  const stageKey = options.stageKey || importStage(options.record, options.job, d).key;
  let nextAction = category === "infrastructure" ? configuration.has(code) ? "检查对应用途的模型、密钥或本机转换工具，再显式继续。"
    : local.has(code) ? "检查本机文件、存储空间和占用情况，保留已有结果后继续。"
    : "检查网络及对应服务状态后显式继续；保留已有结果，不重跑成功部分。"
    : category === "model_output" ? "核对具体输出问题；按现有额度复核或人工修改，未解决继续待处理。"
    : category === "business" ? "对照原卷核对题号、条件和素材；确认前保留待处理，不猜补放行。"
    : "查看详细记录定位原因；保留原件和已有结果，不自动重试或放行。";
  if (category === "model_output" && ["source_index", "source_transcription"].includes(stageKey)) nextAction = "显式继续未完成的索引或转录批次；复用OCR和成功断点，不接受残缺输出。";
  if (code === "revision_conflict") nextAction = "保留当前未保存编辑，重新读取最新版本并核对后再提交。";
  if (code === "source_changed") nextAction = "原题版本已变化，旧解析或旧确认不能沿用；重新核对当前原题。";
  if (code === "teaching_publication_receipt_pending") nextAction = "继续上次解析更新以核对保存回执，不重复入库或重新生成。";
  if (stageKey === "teaching_review" && Number(options.workflow?.reviewCalls) > 0) nextAction = "本题复核次数已使用，初稿已保留；请人工核对或修改，不会自动追加模型调用。";
  return {
    category, categoryLabel: categories[category], stageKey,
    stage: text(d?.stageLabel) || (stageKey === "unknown" ? text(d?.stage) || stageLabels.unknown : stageLabels[stageKey]),
    summary: text(d?.summary) || detail || "当前记录没有足够信息说明具体失败原因。",
    nextAction: text(d?.nextAction) || nextAction,
    causeNote: text(d?.causeNote) || (network.has(code) ? "这是请求或响应通信失败；现有信息不足以断定是本机网络、服务端排队还是模型耗时。" : category === "unknown" ? "不能仅凭错误码推断责任方。" : ""),
    serviceLabel: text(d?.serviceLabel) || (code.startsWith("ocr_") && category === "infrastructure" ? "试卷识别服务" : ""),
    operationLabel: text(d?.operationLabel),
  };
}

export function teachingFailureStage(workflow: any, domain: string): ImportStageKey {
  if (domain === "source") return "source_validation";
  if (["generation_failed", "generation_interrupted", "generation_pending", "generating"].includes(workflow?.status)) return "teaching_generation";
  if (workflow?.reviewFailurePending === true || ["review_failed", "reviewing"].includes(workflow?.status) || Number(workflow?.reviewCalls) > 0) return "teaching_review";
  return "teaching_check";
}
