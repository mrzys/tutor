import { accuracyDomainLabel, accuracyStatus, type AccuracyDomain } from "./import-accuracy.ts";
import { importAssessmentPresentation, importTeachingPresentation, type TeachingReviewControls } from "./import-review.ts";
import { sourceConfirmationContentIssues, sourceConfirmationScopeLabel } from "./import-source-confirmation.ts";
import { sourceReviewState } from "./import-review-flow.ts";
import { importQuestionTriage, type ImportTriageRow } from "./import-triage.ts";
import { teachingIssuePresentation } from "./teaching-field-presentation.ts";
import { importTeachingStatus } from "./import-teaching-status.ts";

export type ImportConfirmationInput = {
  record: any; question: any; row?: ImportTriageRow; controls?: TeachingReviewControls; eligibility?: any;
  domain: "source" | "teaching"; accuracyDomain: AccuracyDomain;
  preview: boolean; dirty: boolean; otherQuestionEdits: boolean;
  busy: string; activeJob: boolean; editingDirty: boolean; publicationPending: boolean;
  /** Actual source/material blockers, separately projected from AI findings. */
  sourceBlockers: readonly string[];
};
export type ImportConfirmationStatus = {
  id: "source" | "solution" | "assessment"; label: string; status: string;
  tone: "complete" | "pending" | "blocked" | "neutral";
};
export type ImportConfirmationContext = {
  statuses: ImportConfirmationStatus[]; scope: string; note: string;
  /** Only an actual confirmation/save scope belongs beside the main action. */
  inlineScope: boolean;
  barriers: { kind: "action" | "publication"; message: string }[];
  sourceConfirmBlocked: boolean;
};

const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const unique = (values: readonly string[]) => [...new Set(values.map(text).filter(Boolean))];

/** Display only. Never grants a review/publication permission, mutates input or
 * treats AI findings as source-material blockers. Rust owns the actual action. */
export function importConfirmationContext(input: ImportConfirmationInput): ImportConfirmationContext {
  const { question, record } = input;
  if (!question?.questionId || question?._detailLoaded === false) return {
    statuses: ([ ["source", "原题"], ["solution", "AI教学稿"], ["assessment", "考查信息"] ] as const)
      .map(([id, label]) => ({ id, label, status: "详情待读取", tone: "neutral" })),
    scope: "读取本题详情后显示本次确认范围", note: "已有进度和未保存编辑保留。", inlineScope: false,
    barriers: [{ kind: "action", message: "本题详情尚未读取，请先读取完整题目。" }], sourceConfirmBlocked: true,
  };
  const row = input.row && input.row.questionId === question.questionId ? input.row
    : importQuestionTriage(question, { record, eligibility: input.eligibility, controls: input.controls, dirty: input.dirty });
  const isAccuracy = Boolean(accuracyStatus(question));
  const saving = !input.preview || input.dirty;
  const blockers = unique([...sourceConfirmationContentIssues(question), ...input.sourceBlockers]);
  const jobActive = input.activeJob || ["queued", "running"].includes(record?.backgroundJob?.status);
  const publicationPending = input.publicationPending || Boolean(record?.pendingPublication || record?.pendingTeachingPublication);
  const sourceState = sourceReviewState(row);
  const published = sourceState === "published";
  const viewingSource = !saving && !isAccuracy && input.domain === "source" && sourceState !== "pending";
  const common = [
    ...(input.busy ? [`当前操作进行中：${input.busy}`] : []),
    ...(input.editingDirty ? ["有未保存的字段修改，请先保存或放弃本次字段编辑。"] : []),
    ...(publicationPending ? ["上一次入库或解析更新尚未完成，请先继续该操作。"] : []),
  ];
  const sourceConfirmationBarriers = unique([...common,
    ...(jobActive ? ["本卷正在后台处理，完成或停止后再确认原题。"] : []),
    ...(input.otherQuestionEdits ? ["其他题有未保存修改，请先保存或撤销，再确认本题。"] : []),
    ...(published ? ["本题已入库，不能再次修改或确认已发布原题。"] : []),
    ...blockers,
  ]);
  // Saving supports explicitly edited review fields and more than one changed
  // question. Source-confirmation-only restrictions must not relabel that save.
  const actionMessages = viewingSource ? [] : saving ? [...common, ...(!input.dirty ? ["当前没有待保存的修改。"] : [])]
    : !isAccuracy && input.domain === "source" ? sourceConfirmationBarriers
    : [...common, ...(jobActive ? ["本卷正在后台处理，完成或停止后再执行当前操作。"] : [])];
  const barriers: ImportConfirmationContext["barriers"] = unique(actionMessages).map(message => ({ kind: "action", message }));
  // Final/unused original records have no new original-publication action in
  // this reading context. Their stored reason is not a failed reading action.
  const publicationMessages = viewingSource && ["published", "duplicate", "rejected"].includes(sourceState) ? [] : unique([
    ...(input.eligibility?.eligible === false && text(input.eligibility?.reason) ? [text(input.eligibility.reason)] : []),
    ...((isAccuracy || input.domain === "teaching" || saving || viewingSource) ? blockers : []),
  ]);
  barriers.push(...publicationMessages.map(message => ({ kind: "publication" as const, message })));

  const statuses: ImportConfirmationStatus[] = isAccuracy
    ? ([ ["source", "原题", "source"], ["solution", "AI教学稿", "math"], ["assessment", "考查信息", "teaching"] ] as const)
      .map(([id, label, domain]) => {
        const state = accuracyStatus(question, domain)!;
        return { id, label, status: state.label, tone: ["ready", "reviewed"].includes(state.kind) ? "complete"
          : ["failed", "needs_review", "budget_paused", "interrupted"].includes(state.kind) ? "blocked" : "pending" };
      })
    : legacyStatuses(input, row, blockers);

  let scope: string, note: string;
  if (saving) {
    scope = "保存当前编辑及显式填写的核对项";
    note = "保存会保留本次修改和明确填写的审核决定、核对项及依据；不自动采用AI内容，也不直接入库。";
  } else if (isAccuracy) {
    const storedScope = input.eligibility?.publicationScope ?? question.accuracy.publicationScope;
    const publicationScope = storedScope === "source_only" ? "原题、实际原卷参考及组卷信息"
      : storedScope === "source_and_teaching" ? "原题、实际原卷参考、AI答案解析及考查信息" : "待后端确认";
    scope = `当前核对：${accuracyDomainLabel(input.accuracyDomain)}；入库范围：${publicationScope}`;
    note = storedScope === "source_only"
      ? "本次人工核对只保存当前域的具体依据；不采用AI答案解析，实际交付的主考知识、解法依赖和难度仍须核对，入库按后端条件另行确认。"
      : "本次人工核对只保存当前域的具体依据；其他域的状态分别保留，是否可入库由后端按本次发布范围判断。";
  } else if (input.domain === "source") {
    scope = viewingSource ? ({ eligible: "查看可入库原题", published: "查看已入库原题", duplicate: "查看题库已有的原题", rejected: "查看未采用原题" } as const)[sourceState as "eligible" | "published" | "duplicate" | "rejected"]
      : `仅确认原题：${sourceConfirmationScopeLabel(question)}`;
    note = viewingSource ? "原题、AI教学稿和考查信息的状态分别保留；入库由单独操作显式发起，阅读不会再次确认或入库。"
      : "本次不确认或采用AI教学稿、考查信息，不直接入库。";
  } else {
    scope = "AI教学稿与考查信息（按所选操作处理）";
    note = "查看、修订或采用按对应操作显式发起，不替代原题核对；具体范围以当前操作及确认内容为准。";
  }
  const inlineScope = saving || isAccuracy || input.domain === "source" && !viewingSource;
  return { statuses, scope, note, inlineScope, barriers, sourceConfirmBlocked: sourceConfirmationBarriers.length > 0 };
}

function legacyStatuses(input: ImportConfirmationInput, row: ImportTriageRow, blockers: readonly string[]): ImportConfirmationStatus[] {
  const question = input.question;
  const state = sourceReviewState(row);
  const source: ImportConfirmationStatus = { id: "source", label: "原题",
    status: state === "published" ? "已入库" : state === "duplicate" ? "题库已有此题" : state === "rejected" ? "未采用"
      : blockers.length ? "有材料问题" : state === "eligible" ? "可入库" : "待核对",
    tone: state === "published" || state === "eligible" && !blockers.length ? "complete"
      : state === "duplicate" || state === "rejected" ? "neutral" : blockers.length ? "blocked" : "pending" };
  const draft = importTeachingPresentation(question, input.controls);
  const assessment = importAssessmentPresentation(question, input.controls);
  const panels = teachingIssuePresentation(row.issues);
  const teaching = importTeachingStatus(question, { triage: row });
  const hasSolution = Boolean(draft?.answer || draft?.solution);
  const solutionIssue = panels.solution.length > 0 || panels.general.length > 0;
  const receiptPending = teaching.kind === "publication_pending";
  const solution: ImportConfirmationStatus = { id: "solution", label: "AI教学稿",
    status: receiptPending ? teaching.title : row.teachingState === "adopted" ? "已采用" : row.teachingState === "not_adopted" ? "未采用"
      : solutionIssue ? teaching.title : draft?.ready ? "候选已就绪" : hasSolution ? "已生成，待核对" : teaching.title,
    tone: receiptPending ? "pending" : row.teachingState === "adopted" || draft?.ready && !solutionIssue ? "complete" : solutionIssue ? "blocked"
      : row.teachingState === "not_adopted" || !question?.teachingWorkflow ? "neutral" : "pending" };
  const hasAssessment = Boolean(assessment.level || assessment.examFocus || assessment.basis || assessment.paths.length
    || question?.primaryKnowledgeUids?.length);
  const hasCandidateAssessment = Boolean(draft?.level || draft?.basis || draft?.examFocus || draft?.studentRequirements.length);
  const assessmentIssue = panels.assessment.length > 0;
  const metadata: ImportConfirmationStatus = { id: "assessment", label: "考查信息",
    status: assessmentIssue ? assessment.needsSupplement ? "待核对、待补全" : "有疑点，待核对" : !assessment.needsSupplement ? "已有标注"
      : hasAssessment ? "已有部分标注，待补全" : hasCandidateAssessment ? "候选待核对" : "待补全",
    tone: assessmentIssue ? "blocked" : !assessment.needsSupplement ? "complete" : "pending" };
  return [source, solution, metadata];
}
