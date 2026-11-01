import { importFailure, type ImportStageKey } from "./import-process.ts";
import { teachingFindingMessage } from "./teaching-finding-display.ts";
import type { ImportTriageRow, TriageIssue } from "./import-triage.ts";

export type ImportTeachingStatusKind = "not_started" | "not_adopted" | "generating" | "checking" | "reviewing" | "processing"
  | "generation_failed" | "review_failed" | "review_pending" | "content_issues" | "source_changed"
  | "ready" | "adopted" | "publication_pending" | "unknown";
export type ImportTeachingActionHint = "retry_generation" | "continue_workflow" | "edit_content" | "view_details" | "none";
export type ImportTeachingStatus = {
  kind: ImportTeachingStatusKind;
  title: string;
  reasons: string[];
  actionHint: ImportTeachingActionHint;
};
export type ImportTeachingStatusOptions = {
  triage?: Pick<ImportTriageRow, "questionId" | "teachingState" | "issues">;
  activeStage?: "teaching_generation" | "teaching_check" | "teaching_review";
};

const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const rows = (value: unknown): any[] => Array.isArray(value) ? value : [];
const unique = (values: string[]): string[] => [...new Set(values.filter(Boolean))];
const enumCode = (value: string) => /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+$/i.test(value);
const failureMessages = new Map<string, string>([
  ["model_request_timeout", "连接模型服务超时，已有材料已保留"],
  ["model_response_timeout", "读取模型响应超时，已有内容已保留"],
  ["model_output_invalid_json", "模型返回的解析数据格式有误"],
  ["model_output_truncated", "模型返回的解析内容被截断"],
  ["model_output_empty", "模型未返回有效的解析内容"],
  ["invalid_teaching_batch", "模型返回的解析结构或题目身份不符合要求"],
  ["invalid_teaching_result", "模型返回的解析字段不完整或格式有误"],
  ["invalid_teaching_candidate", "模型返回的解析候选不符合要求"],
  ["invalid_annotation", "考查信息不完整或格式不符合要求"],
  ["invalid_teaching_patch", "复核修改不符合句段或数据格式要求，未采用该修改"],
  ["teaching_patch_unresolved", "受限复核仍有未解决的问题，需人工核对或修改"],
  ["revision_conflict", "待修改内容的版本已变化，复核修改未合并"],
  ["review_findings_remaining", "复核后仍有具体疑点，需继续人工核对"],
  ["generation_interrupted", "解析生成已中断，已有内容已保留"],
  ["review_interrupted", "解析复核已中断，初稿已保留"],
]);
const generationFailureCodes = new Set([
  "model_request_timeout", "model_response_timeout", "model_output_invalid_json", "model_output_truncated",
  "model_output_empty", "invalid_teaching_batch", "invalid_teaching_result", "generation_interrupted",
]);
const reviewFailureCodes = new Set([...generationFailureCodes].filter(code => code !== "generation_interrupted").concat([
  "invalid_teaching_patch", "invalid_annotation", "teaching_patch_unresolved", "revision_conflict", "review_interrupted",
]));
const stateProjectionIds = new Set(["teaching:review-failed", "teaching:workflow-state", "teaching:adoption-state"]);

function reasonFor(finding: any, workflow: any, stageKey: ImportStageKey): string {
  const code = text(finding?.code);
  const detail = text(finding?.message || finding?.issue || finding?.reason);
  // Preserve the stored explanation, but an internal code alone is not useful
  // user copy. Known codes have a local label; unknown ones retain a safe label.
  const readableDetail = detail && detail !== code && !enumCode(detail) ? detail : "";
  const message = readableDetail || failureMessages.get(code || detail)
    || teachingFindingMessage({ ...finding, message: detail });
  return importFailure({ ...finding, message }, {
    stageKey, type: text(finding?.type), dimension: text(finding?.dimension), domain: "teaching", workflow,
  }).summary;
}

function hasCandidate(workflow: any): boolean {
  return [workflow?.candidateResult, workflow?.reviewedCandidate, workflow?.initialCandidate,
    workflow?.retainedInitialCandidate, workflow?.finalResult]
    .some(candidate => candidate && typeof candidate === "object" && !Array.isArray(candidate)
      && (text(candidate.answer) || text(candidate.teachingSolution)));
}

/** Reading-only status copy. A hint does not authorise a model call, reset its
 * quota, acknowledge a finding or grant publication permission. Callers must
 * continue using the backend-projected actions and eligibility for controls. */
export function importTeachingStatus(question: any, options: ImportTeachingStatusOptions = {}): ImportTeachingStatus {
  const workflow = question?.teachingWorkflow;
  const candidatePresent = question?._detailLoaded === false && typeof workflow?._hasCandidate === "boolean"
    ? workflow._hasCandidate : hasCandidate(workflow);
  const status = text(workflow?.status);
  const reviewCalls = Number(workflow?.reviewCalls || 0);
  const triage = options.triage?.questionId === question?.questionId ? options.triage : undefined;
  const rawFindings = rows(workflow?.findings);
  const findings = Array.isArray(workflow?.effectiveFindings) ? workflow.effectiveFindings : rawFindings;
  const currentIssues: TriageIssue[] | undefined = triage?.issues.filter(issue => issue.domain === "teaching"
    && !stateProjectionIds.has(issue.id) && issue.code !== "teaching_publication_receipt_pending");
  const stageKey: ImportStageKey = options.activeStage || (["generating", "generation_failed", "generation_interrupted"].includes(status)
    ? "teaching_generation" : status === "reviewing" || workflow?.reviewFailurePending === true
      || status === "review_failed" || reviewCalls > 0 ? "teaching_review" : "teaching_check");
  const contentReasons = unique(currentIssues ? currentIssues.map(issue => reasonFor(issue, workflow, stageKey))
    : findings.map((finding: any) => reasonFor(finding, workflow, stageKey)));
  const rawReasons = unique(findings.map((finding: any) => reasonFor(finding, workflow, stageKey)));
  const view = (kind: ImportTeachingStatusKind, title: string, reasons: string[], actionHint: ImportTeachingActionHint): ImportTeachingStatus =>
    ({ kind, title, reasons: unique(reasons), actionHint });

  // An explicit current operation takes precedence over old retained failure
  // metadata. The operation remains under the existing server action contract.
  if (options.activeStage === "teaching_generation" || status === "generating")
    return view("generating", "正在生成解析", [], "none");
  if (options.activeStage === "teaching_review" || status === "reviewing")
    return view("reviewing", "正在复核解析", [], "none");
  if (options.activeStage === "teaching_check")
    return view("checking", "正在检查解析", [], "none");
  if (triage?.teachingState === "generating")
    return view("processing", "正在处理本题解析", [], "none");

  const changed = findings.some((finding: any) => finding?.code === "source_changed")
    || currentIssues?.some(issue => issue.code === "source_changed") || status === "source_changed";
  if (changed) {
    const changedReasons = unique([...findings.filter((finding: any) => finding?.code === "source_changed")
      .map((finding: any) => reasonFor(finding, workflow, stageKey)), ...contentReasons]);
    return view("source_changed", "原题已修改，旧解析需重新核对", changedReasons.length ? changedReasons
      : ["原题版本已变化，旧解析或旧确认不能直接沿用。"], "view_details");
  }

  const receipt = triage?.issues.find(issue => issue.domain === "teaching" && issue.code === "teaching_publication_receipt_pending");
  if (receipt) return view("publication_pending", triage?.teachingState === "adopted" ? "解析已采用，更新回执待完成" : "上次解析更新尚未完成",
    [reasonFor(receipt, workflow, "user_review")], "continue_workflow");
  if (triage?.teachingState === "adopted") return view("adopted", "解析已采用", [], "none");

  // This exact legacy shape is also recognised by the server's generation
  // retry projection after an unsuccessful format-recovery review. There is
  // no parsed draft to edit. Showing retry does not refund that spent review.
  const malformedGeneration = status === "needs_review" && !candidatePresent
    && rawFindings.every((finding: any) => finding?.type === "technical")
    && rawFindings.some((finding: any) => finding?.code === "model_output_invalid_json");
  if (status === "generation_failed" || status === "generation_interrupted" || malformedGeneration) {
    const generationReasons = unique(rawFindings.map((finding: any) => reasonFor(finding, workflow, "teaching_generation")));
    return view("generation_failed", "解析生成失败", generationReasons.length ? generationReasons : ["解析生成未完成，原题和已有材料已保留。"],
      !malformedGeneration && workflow?.reviewEligible === true && reviewCalls === 0 ? "continue_workflow" : "retry_generation");
  }
  const legacyReviewFailure = status === "needs_review" && reviewCalls > 0
    && findings.some((finding: any) => finding?.type === "technical" && reviewFailureCodes.has(text(finding.code)));
  if (workflow?.reviewFailurePending === true || status === "review_failed" || status === "review_interrupted" || legacyReviewFailure) {
    const retained = text(workflow?.retainedInitialReason) || text(workflow?.retainedInitialMessage)
      ? reasonFor({ type: "technical", code: workflow?.retainedInitialReason, message: workflow?.retainedInitialMessage }, workflow, "teaching_review") : "";
    const failureReasons = unique([retained, ...contentReasons,
      ...(!retained && !contentReasons.length ? findings.filter((finding: any) => finding?.type === "technical")
        .map((finding: any) => reasonFor(finding, workflow, "teaching_review")) : [])]);
    return view("review_failed", "解析复核未完成", failureReasons.length ? failureReasons
      : ["复核未完成，记录中尚无更具体的失败原因；已有内容继续保留。"], "edit_content");
  }

  // Some older generation-format failures were saved as needs_review to allow
  // one explicit recovery. Only a missing parsed candidate plus exact technical
  // failure codes identifies that case; prose or term flags never do.
  const legacyGenerationFailure = status === "needs_review" && !candidatePresent && reviewCalls === 0
    && findings.some((finding: any) => finding?.type === "technical" && generationFailureCodes.has(text(finding.code)));
  if (legacyGenerationFailure)
    return view("generation_failed", "解析生成失败", rawReasons.length ? rawReasons : ["解析生成未完成，原题和已有材料已保留。"],
      workflow?.reviewEligible === true && reviewCalls === 0 ? "continue_workflow" : "retry_generation");

  if (triage?.teachingState === "ready" || !triage && status === "ready_candidate" && !contentReasons.length)
    return view("ready", "解析候选已就绪", [], "none");
  if (triage?.teachingState === "not_adopted") return view("not_adopted", "未采用AI解析", [], "none");
  if (!workflow || status === "generation_pending")
    return view("not_started", workflow ? "解析尚未生成" : "暂无AI解析", [], workflow ? "continue_workflow" : "none");

  if (contentReasons.length) {
    if (reviewCalls === 0 && candidatePresent) return view("review_pending", "解析有疑点，尚未执行复核", contentReasons, "continue_workflow");
    return view("content_issues", reviewCalls > 0 ? "复核后仍有内容疑点" : "解析有内容疑点", contentReasons, "edit_content");
  }
  return view("unknown", "解析处理状态需核对", ["当前记录没有足够信息说明未完成原因，请查看处理记录。"], "view_details");
}
