import { accuracyCanReviewDomain, accuracyDomainLabel, accuracyFieldLabel, accuracyFindings, accuracyPendingDomains, accuracyStatus, type AccuracyDomain } from "./import-accuracy.ts";

export type AccuracyGuidanceIssue = { id: string; domain: string; message: string; fieldPath: string; code: string };
export type AccuracyGuidance = {
  kind: "technical" | "content" | "confirmation" | "budget" | "processing" | "ready" | "published";
  label: string; summary: string; nextStep: string; issues: AccuracyGuidanceIssue[];
  reviewDomain?: AccuracyDomain; canRepair: boolean;
};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const object = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const errorCode = (value: unknown): string => /^[a-z][a-z0-9_]*$/.test(text(value)) ? text(value) : "";
const processIssue = (issue: { id: string; domain: string }): boolean => issue.domain === "process" || issue.id === "technical_failure";
function domain(value: string): AccuracyDomain | undefined {
  if (["math", "mathematics", "generated_solution", "original_reference"].includes(value)) return "math";
  return value === "source" || value === "teaching" ? value : undefined;
}

/** Reading guidance only: publication eligibility and action permissions remain Rust decisions. */
export function accuracyGuidance(question: any, eligible = false): AccuracyGuidance | null {
  const overall = accuracyStatus(question);
  if (!overall) return null;
  const current = question.accuracy;
  const raw: Record<string, any>[] = Array.isArray(current.findings) ? current.findings.filter(object) : [];
  // Lightweight projections may retain an error code without a message. Keep the
  // existing findings parser while giving that technical entry a readable fallback.
  const normalized: Record<string, any>[] = raw.map((item, index) => ({ ...item, id: text(item.id) || `finding-${index}`, message: text(item.message).trim() || (processIssue({ id: text(item.id), domain: text(item.domain) }) ? "本次处理未完成，已有成果已保留。" : "") }));
  const issues = accuracyFindings({ ...question, accuracy: { ...current, findings: normalized } }).map(item => {
    const entry = normalized.find(value => value.id === item.id) || {};
    return { id: item.id, domain: item.domain, message: item.message, fieldPath: item.fieldPath, code: errorCode(entry.code) || (processIssue(item) ? errorCode(item.basis) : "") };
  });
  const technical = issues.filter(processIssue), content = issues.filter(item => !processIssue(item));
  const pending = accuracyPendingDomains(question);
  const issueDomains = content.map(item => domain(item.domain)).filter((value): value is AccuracyDomain => Boolean(value));
  const reviewDomain = [...new Set([...issueDomains, ...pending])].find(value => pending.includes(value) && accuracyCanReviewDomain(question, value));
  const sourceGood = ["ready", "reviewed"].includes(accuracyStatus(question, "source")?.kind || "");
  const canRepair = current.canRepair === true && sourceGood && content.length > 0;
  const result = (kind: AccuracyGuidance["kind"], label: string, summary: string, nextStep: string, actions = false): AccuracyGuidance => ({
    kind, label, summary, nextStep, issues, canRepair: actions && canRepair, ...(actions && reviewDomain ? { reviewDomain } : {}),
  });
  if (current.status === "published") return result("published", "已入库", "本题已入库。", "可查看已保存的内容。");
  if (eligible || current.status === "ready") return result("ready", "可入库", "本题已具备本次发布的确认条件。", "确认本次发布内容后入库。");
  if (overall.kind === "budget_paused") return result("budget", "额度暂停", overall.reason || "本次处理已因额度限制暂停，已有成果保留。", "查看已用额度与暂停原因，再显式继续；沿用本次已用额度并复用成功结果。");
  if (overall.kind === "processing") return result("processing", "处理中", overall.stageLabel, "等待本次处理完成；已有成果保留。");
  if (technical.length || overall.kind === "failed" || overall.kind === "interrupted") {
    const contract = technical.some(item => item.code === "accuracy_contract_invalid");
    const model = technical.some(item => ["model_error", "model_timeout", "model_unavailable", "provider_error"].includes(item.code));
    const label = contract ? "复核报告异常" : model ? "模型调用未完成" : "处理异常";
    const summary = technical[0]?.message || overall.reason || "本次处理尚未完成，已有成果保留。";
    return result("technical", label, summary + (content.length ? ` 另有 ${content.length} 项内容核对意见。` : ""), "点击整卷“继续未完成处理”，复用成功结果并沿用本次已用额度；完成处理后再查看核对意见。");
  }
  if (content.length) {
    const first = content[0], field = accuracyFieldLabel(first.fieldPath);
    const summary = `${accuracyDomainLabel(first.domain)}${field ? ` · ${field}` : ""}：${first.message}`;
    const nextStep = reviewDomain ? `对照原题与实际候选核对${accuracyDomainLabel(reviewDomain)}，记录具体依据；未判不等同题目错误，原卷缺少参考答案无需补造。`
      : "尚无可核对的完整候选时，先显式继续未完成处理；已有内容与已用额度保留。";
    return result("content", "有待核对内容", summary, nextStep, true);
  }
  const summary = pending.length ? `${pending.map(accuracyDomainLabel).join("、")}尚未完成核对；未判不等同题目错误。` : "各域已有核对记录，仍须查看本次发布条件。";
  const nextStep = reviewDomain ? `检查${accuracyDomainLabel(reviewDomain)}的实际材料与候选，再记录具体核对依据；原卷缺少参考答案无需补造。`
    : pending.length ? "先显式继续未完成处理，取得完整候选；复用成功结果并沿用本次已用额度。" : "查看核对与发布条件，按实际缺项处理。";
  return result("confirmation", "待完成核对", summary, nextStep, true);
}

export function accuracyGuidanceSummary(questions: any[], eligibilityMap: Record<string, any> = {}): { technical: number; content: number; confirmation: number; budget: number; processing: number } {
  const summary = { technical: 0, content: 0, confirmation: 0, budget: 0, processing: 0 };
  for (const question of questions) {
    const guidance = accuracyGuidance(question, eligibilityMap[question?.questionId]?.eligible === true);
    if (guidance && guidance.kind !== "ready" && guidance.kind !== "published") summary[guidance.kind]++;
  }
  return summary;
}
