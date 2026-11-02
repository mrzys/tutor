export type AccuracyDomain = "source" | "math" | "teaching";
export type AccuracyAction = "review" | "repair";
export type AccuracyStatus = { kind: "ready" | "reviewed" | "pending" | "processing" | "needs_review" | "failed" | "budget_paused" | "interrupted"; label: string; reason: string; stageLabel: string };
export const accuracyDomains: readonly { id: AccuracyDomain; label: string }[] = [
  { id: "source", label: "原题与原参考" }, { id: "math", label: "答案与证明" }, { id: "teaching", label: "教学信息" },
];
export const accuracyRequiredRoles = [
  ["sourceParsing", "拆题"], ["teachingGeneration", "解析生成"], ["sourceVerification", "来源核验"],
  ["independentSolve", "独立求解"], ["mathVerification", "数学核验"], ["teachingVerification", "教学核验"],
] as const;
const text = (value: unknown): string => typeof value === "string" ? value : "";
const object = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const stageLabels: Record<string, string> = {
  source: "来源核验", solution: "解答生成", independent: "独立求解", mathematics: "数学核验", metadata: "教学信息整理", teaching: "教学核验",
  source_fidelity: "来源核验", source_verification: "来源核验", solution_generation: "解答生成", independent_solve: "独立求解",
  math_and_reference: "数学核验", math_verification: "数学核验", teaching_generation: "教学信息整理", metadata_generation: "教学信息整理",
  teaching_information: "教学核验", teaching_verification: "教学核验", rendering: "呈现检查", finalizing: "定稿检查", review: "核对与确认", complete: "核对完成",
};
function accuracy(question: any): Record<string, any> | null {
  return object(question?.accuracy) && typeof question.accuracy.strategyVersion === "string" && question.accuracy.strategyVersion.trim() ? question.accuracy : null;
}
export function accuracyStageLabel(stage: unknown): string { return stageLabels[text(stage)] || "处理进度"; }
export function accuracyImportAction(record: any, retry = false): "import_accuracy_start" | "import_start" {
  return !retry || !record || record.accuracyRunId ? "import_accuracy_start" : "import_start";
}
export function accuracyModelReadiness(model: any, repair = false): { configured: boolean; missing: string[] } {
  const required: readonly (readonly [string, string])[] = repair ? [...accuracyRequiredRoles, ["teachingReview", "解析复核"]] : accuracyRequiredRoles;
  const missing = required.filter(([key]) => {
    const profileId = model?.importRoles?.[key], effective = model?.effectiveImportRoles?.[key];
    return typeof profileId !== "string" || !profileId || effective?.strategy !== "explicit" || effective?.configured !== true
      || effective?.profileId !== profileId || !Array.isArray(model?.profiles) || !model.profiles.some((profile: any) => profile?.id === profileId && profile?.configured === true);
  }).map(([, label]) => label);
  return { configured: missing.length === 0, missing };
}
export function accuracyDomainLabel(domain: unknown): string {
  if (domain === "mathematics" || domain === "generated_solution" || domain === "original_reference") return "答案与证明";
  return accuracyDomains.find(item => item.id === domain)?.label || "本题";
}
/** Read only the new projection. Old ready/self-review states do not acquire new verification meaning. */
export function accuracyStatus(question: any, domain?: AccuracyDomain): AccuracyStatus | null {
  const current = accuracy(question);
  if (!current) return null;
  const part = domain ? current[domain === "math" ? "mathematics" : domain] : current;
  const status = text(part?.status), stageLabel = accuracyStageLabel(current.stage);
  const reason = text(part?.reason) || (!domain && status === "budget_paused" ? text(current.budget?.reason) || text(current.budget?.pause?.message) : "");
  const result = (kind: AccuracyStatus["kind"], label: string): AccuracyStatus => ({ kind, label, reason, stageLabel });
  if (status === "budget_paused") return result("budget_paused", "额度暂停");
  if (["failed", "technical_failed", "error"].includes(status)) return result("failed", "处理失败，材料已保留");
  if (["cancelled", "interrupted", "paused"].includes(status)) return result("interrupted", "已暂停，材料已保留");
  if (["queued", "running", "processing", "generating", "reviewing"].includes(status)) return result("processing", "处理中");
  if (["teacher_reviewed", "teacher_checked", "human_reviewed"].includes(status)) return result("reviewed", "教师已核对");
  if (["ready", "no_issue_found", "model_checked"].includes(status)) return result("ready", "模型核对未发现问题");
  if (["needs_review", "issue_found", "issues_found", "unresolved", "blocked", "stale"].includes(status)) return result("needs_review", "待处理");
  return result("pending", "尚未完成核对");
}

/** Reading/navigation only. Publication is always decided by Rust's eligibility projection. */
export function accuracyPendingDomains(question: any): AccuracyDomain[] {
  if (!accuracy(question)) return [];
  return accuracyDomains.filter(domain => !["ready", "reviewed"].includes(accuracyStatus(question, domain.id)?.kind || "pending")).map(domain => domain.id);
}
export function accuracyCanReviewDomain(question: any, domain: AccuracyDomain): boolean {
  const current = accuracy(question);
  return current?.canReview === true && Array.isArray(current.reviewableDomains) && current.reviewableDomains.includes(domain);
}
export function accuracySuggestedDomain(question: any): AccuracyDomain {
  return accuracyPendingDomains(question)[0] || "source";
}
export function accuracyReadingExpanded(question: any, domain: AccuracyDomain, active: AccuracyDomain): boolean {
  return domain === active || accuracyFindings(question).some(finding =>
    (finding.domain === "mathematics" || finding.domain === "generated_solution" || finding.domain === "original_reference" ? "math" : finding.domain) === domain);
}

export function accuracyFindings(question: any): { id: string; domain: string; message: string; fieldPath: string; partId: string | null; basis: string }[] {
  const entries = accuracy(question)?.findings;
  return !Array.isArray(entries) ? [] : entries.flatMap((entry, index) => !object(entry) || !text(entry.message).trim() ? [] : [{
    id: text(entry.id) || `finding-${index}`, domain: text(entry.domain), message: text(entry.message), fieldPath: text(entry.fieldPath),
    partId: typeof entry.partId === "string" ? entry.partId : null, basis: text(entry.basis),
  }]);
}
export function accuracyFieldLabel(path: unknown): string {
  const value = text(path).replace(/^student\./, "").replace(/^candidate\./, "").replace(/^originalReference\./, "");
  if (value === "originalProblemValidity") return "题目有效性";
  if (value === "questionType") return "题型";
  if (value === "stem") return "题干";
  if (value.startsWith("options")) return "选项";
  if (value.startsWith("parts")) return "小问";
  if (["answer", "referenceAnswer"].includes(value)) return "答案";
  if (["solution", "teachingSolution", "referenceSolution"].includes(value)) return "解析";
  if (value.startsWith("difficulty")) return "难度与依据";
  if (value.startsWith("primaryKnowledge")) return "主考知识";
  if (value.startsWith("solutionPaths")) return "解法依赖";
  if (value.startsWith("teachingFocus")) return "教学说明";
  return "";
}
export function accuracyEvidence(question: any): { label: string; basis: string; checks: { label: string; status: string; basis: string }[]; disagreements: { label: string; claimA: string; claimB: string; stepA: string; stepB: string; basis: string }[] }[] {
  const current = accuracy(question);
  if (!current) return [];
  const classifications: Record<string, string> = { equivalent: "结论等价", candidate_defect: "候选存在问题", independent_defect: "独立解存在问题", both_defective: "双方存在问题", source_problem: "原题或原参考问题", unresolved: "尚无法判断" };
  return accuracyDomains.flatMap(domain => {
    const value = current[domain.id === "math" ? "mathematics" : domain.id];
    const checks = !Array.isArray(value?.checks) ? [] : value.checks.filter(object).map((check: any) => ({ label: accuracyFieldLabel(check.target) || "核对项目", status: check.status === "checked" ? "已检查" : check.status === "issue" ? "待处理" : "未判", basis: text(check.basis) }));
    const disagreements = !Array.isArray(value?.disagreements) ? [] : value.disagreements.filter(object).map((item: any) => ({ label: classifications[text(item.classification)] || "尚无法判断", claimA: text(item.claimA), claimB: text(item.claimB), stepA: text(item.stepA), stepB: text(item.stepB), basis: text(item.basis) }));
    const basis = text(value?.basis);
    return !basis && !checks.length && !disagreements.length ? [] : [{ label: domain.label, basis, checks, disagreements }];
  });
}

/** Separate generated material for the existing reading surface; never merge it into original references. */
export function accuracyPreviewCandidate(question: any): { answer: string; teachingSolution: string; difficultyAssessment: any; teachingFocus: any } | null {
  const candidate = accuracy(question)?.candidate;
  if (!object(candidate)) return null;
  return { answer: text(candidate.answer), teachingSolution: text(candidate.teachingSolution),
    difficultyAssessment: object(candidate.difficultyAssessment) ? structuredClone(candidate.difficultyAssessment) : null,
    teachingFocus: object(candidate.teachingFocus) ? structuredClone(candidate.teachingFocus) : null };
}
export function accuracyKnowledgeNames(question: any, uids: readonly string[] = []): string {
  const points = accuracy(question)?.catalogue?.knowledgePoints;
  return uids.map(uid => Array.isArray(points) ? text(points.find(point => point?.uid === uid)?.name) || "知识点名称未记录" : "知识点名称未记录").join("、") || "未标注";
}
export function accuracyPremiseNames(question: any, ids: readonly string[] = []): string {
  const premises = accuracy(question)?.catalogue?.premises;
  return ids.map(id => Array.isArray(premises) ? text(premises.find(item => item?.id === id)?.label) || "前提名称未记录" : "前提名称未记录").join("、");
}
export function accuracyBudget(question: any): { calls: string; input: string; output: string; unknown: string; time: string } | null {
  const budget = accuracy(question)?.budget;
  if (!object(budget)) return null;
  const usage = budget.usage, limits = budget.limits;
  const amount = (value: unknown): string => Number.isSafeInteger(value) && (value as number) >= 0 ? String(value) : "未记录";
  const unknown = Array.isArray(usage?.unknownUsageExecutions) ? usage.unknownUsageExecutions.length : null;
  return { calls: `调用 ${amount(usage?.usedCalls)} / ${amount(limits?.maxCalls)}`,
    input: `输入：实际 ${amount(usage?.usedInputTokens)}，预留 ${amount(usage?.reservedInputTokens)}，上限 ${amount(limits?.maxInputTokens)} token`,
    output: `输出：实际 ${amount(usage?.usedOutputTokens)}，预留 ${amount(usage?.reservedOutputTokens)}，上限 ${amount(limits?.maxOutputTokens)} token`,
    unknown: unknown === null ? "用量未知次数未记录" : unknown ? `${unknown} 次用量未知，对应预留仍保留` : "无用量未知的执行", time: "尚无实测预计时长" };
}

export type AccuracyActionDraft = {
  identity: string; kind: AccuracyAction; domain: AccuracyDomain; importId: string; revision: number; questionId: string;
  sourceSha256: string; candidateSha256: string | null; operationId: string; basis: string; acknowledge: boolean;
};
export type AccuracyPublicationScope = "source_and_teaching" | "source_only";
export type AccuracyScopeDraft = Pick<AccuracyActionDraft, "identity" | "importId" | "revision" | "questionId" | "sourceSha256" | "candidateSha256" | "operationId"> & { publicationScope: AccuracyPublicationScope };
export function createAccuracyScopeDraft(question: any, importId: string, revision: number, publicationScope: string, operationId: string): AccuracyScopeDraft | null {
  if (publicationScope !== "source_and_teaching" && publicationScope !== "source_only") return null;
  const base = createAccuracyActionDraft(question, importId, revision, "review", "source", operationId);
  return !base ? null : { identity: base.identity, importId, revision, questionId: base.questionId, sourceSha256: base.sourceSha256, candidateSha256: base.candidateSha256, operationId, publicationScope };
}
export function accuracyScopeCurrent(draft: AccuracyScopeDraft | null, question: any, importId: string, revision: number): boolean {
  return Boolean(draft && draft.identity === accuracyActionIdentity(question, importId, revision) && accuracy(question)?.canReview === true);
}
export function accuracyScopePayload(draft: AccuracyScopeDraft, question: any, importId: string, revision: number): Record<string, unknown> {
  if (!accuracyScopeCurrent(draft, question, importId, revision)) throw new Error("题目或候选已变化，请重新读取后再保存发布范围；选择已保留。");
  return { importId: draft.importId, expectedRevision: draft.revision, questionId: draft.questionId, sourceSha256: draft.sourceSha256, candidateSha256: draft.candidateSha256,
    publicationScope: draft.publicationScope, acknowledge: true, operationId: draft.operationId, responseScope: "question" };
}
export function accuracyActionIdentity(question: any, importId: string, revision: number): string {
  const current = accuracy(question);
  return JSON.stringify([importId, revision, question?.questionId, current?.strategyVersion, current?.sourceSha256, current?.candidateSha256]);
}
export function createAccuracyActionDraft(question: any, importId: string, revision: number, kind: AccuracyAction, domain: AccuracyDomain, operationId: string): AccuracyActionDraft | null {
  const current = accuracy(question);
  if (!current || !importId || !Number.isSafeInteger(revision) || revision < 0 || !text(question?.questionId)
    || !accuracyDomains.some(item => item.id === domain) || !operationId || current[kind === "review" ? "canReview" : "canRepair"] !== true
    || kind === "review" && !accuracyCanReviewDomain(question, domain)
    || !/^[a-f0-9]{64}$/.test(text(current.sourceSha256)) || !Object.hasOwn(current, "candidateSha256")
    || (current.candidateSha256 !== null && current.candidateSha256 !== "" && !/^[a-f0-9]{64}$/.test(text(current.candidateSha256)))) return null;
  return { identity: accuracyActionIdentity(question, importId, revision), kind, domain, importId, revision, questionId: question.questionId,
    sourceSha256: current.sourceSha256, candidateSha256: current.candidateSha256, operationId, basis: "", acknowledge: false };
}
export function accuracyActionCurrent(draft: AccuracyActionDraft, question: any, importId: string, revision: number): boolean {
  return draft.identity === accuracyActionIdentity(question, importId, revision)
    && accuracy(question)?.[draft.kind === "review" ? "canReview" : "canRepair"] === true
    && (draft.kind !== "review" || accuracyCanReviewDomain(question, draft.domain));
}
export function accuracyActionCanSubmit(draft: AccuracyActionDraft | null, question: any, importId: string, revision: number): boolean {
  const basisLength = [...(draft?.basis.trim() || "")].length;
  return Boolean(draft && accuracyActionCurrent(draft, question, importId, revision) && basisLength >= 8
    && basisLength <= 4000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(draft.basis) && draft.acknowledge);
}
export function accuracyActionPayload(draft: AccuracyActionDraft, question: any, importId: string, revision: number): Record<string, unknown> {
  if (!accuracyActionCanSubmit(draft, question, importId, revision)) throw new Error("请实际核对并填写具体依据；题目版本变化后请重新读取，填写内容已保留。");
  return { importId: draft.importId, expectedRevision: draft.revision, questionId: draft.questionId, basis: draft.basis,
    sourceSha256: draft.sourceSha256, candidateSha256: draft.candidateSha256, operationId: draft.operationId, responseScope: "question",
    ...(draft.kind === "review" ? { domain: draft.domain, acknowledge: true } : {}) };
}
