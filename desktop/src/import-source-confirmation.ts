import { requiredReviewChecks, sourceReviewLabel } from "./import-review.ts";

export type SourceConfirmationOptions = {
  confirmed: boolean;
  /** Current backend/content blockers, not model observations or AI-draft issues. */
  hardIssues: readonly unknown[];
  note?: string;
  persistedQuestions?: readonly any[];
};

/** Describe only the original fields the user is explicitly confirming. */
export function sourceConfirmationScopeLabel(question: any): string {
  const required = requiredReviewChecks(question);
  return [sourceReviewLabel(question), "公式、图片与表格",
    ...(required.includes("answerChecked") ? ["原卷答案"] : []),
    ...(required.includes("solutionChecked") ? ["原卷解析"] : []),
  ].join("、");
}

/** Prepare one explicit user confirmation for the existing import_review_save
 * contract. This neither publishes the source nor acknowledges an AI draft.
 * Rust still owns CAS, source/material completeness and publication checks. */
export function sourceConfirmationUpdate(record: any, questionId: string, options: SourceConfirmationOptions) {
  if (options?.confirmed !== true) throw new Error("请先对照原卷，明确确认当前题面。");
  if (!Array.isArray(options.hardIssues)) throw new Error("缺少本题内容检查结果，请重新读取后再确认。");
  if (typeof record?.importId !== "string" || !record.importId.trim()
    || !Number.isSafeInteger(record?.revision) || record.revision < 0
    || !Array.isArray(record.questions) || typeof questionId !== "string" || !questionId.trim()) {
    throw new Error("题目版本信息不完整，请重新读取后再确认。");
  }
  const matches = record.questions.filter((question: any) => question?.questionId === questionId);
  if (matches.length !== 1) throw new Error("当前题目身份不唯一或已变化，请重新读取。");
  const question = matches[0];
  if (options.persistedQuestions && record.questions.some((item: any) => item.questionId !== questionId
    && JSON.stringify(item) !== JSON.stringify(options.persistedQuestions?.find(old => old.questionId === item.questionId)))) {
    throw new Error("其他题有未保存修改，请先保存或撤销，再确认本题。");
  }
  if ((record.publishedQuestionIds || []).includes(questionId)) throw new Error("本题已入库，不能通过原题确认修改已发布内容。");
  if (["queued", "running"].includes(record.backgroundJob?.status)) throw new Error("本卷正在处理，完成或停止后再确认原题。");
  if (record.pendingPublication || record.pendingTeachingPublication) throw new Error("请先完成上一次入库操作，再确认原题。");
  if (options.hardIssues.length || (Array.isArray(question.reviewIssues) && question.reviewIssues.length)) {
    throw new Error("本题仍有内容缺失或材料问题，请先修正，不能直接确认。");
  }
  if (options.note !== undefined && typeof options.note !== "string") throw new Error("核对备注格式无效。");
  const confirmation = `用户明确确认已对照原卷核对本题的${sourceConfirmationScopeLabel(question)}，确认当前原题内容完整且修正正确。`;
  const existing = typeof question.reviewBasis === "string" ? question.reviewBasis.trim() : "";
  const note = options.note?.trim() || "";
  const basis = [existing, ...(!existing.includes(confirmation) ? [confirmation] : []),
    ...(note && !existing.includes(`补充备注：${note}`) ? [`补充备注：${note}`] : [])].filter(Boolean).join("\n");
  if (Array.from(basis).length > 5000) throw new Error("核对依据超过5000字，请精简补充备注后再确认。");
  const checks = { ...(question.reviewChecks || {}) };
  for (const key of requiredReviewChecks(question)) checks[key] = true;
  const updated = { ...question, reviewDecision: "approve", reviewChecks: checks, reviewBasis: basis };
  return {
    importId: record.importId,
    expectedRevision: record.revision,
    questions: record.questions.map((item: any) => item === question ? updated : item),
  };
}
