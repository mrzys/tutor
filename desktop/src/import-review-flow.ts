import type { ImportTriageRow } from "./import-triage.ts";

export type SourceReviewState = "published" | "duplicate" | "rejected" | "eligible" | "pending";
export type ImportReviewFilter = "all" | "source_pending" | "source_ready" | "teaching" | "published" | "duplicate" | "rejected" | "both_ready";
export type ImportReviewNextMode = "todo" | "source_pending" | "teaching" | "next" | "previous";
type ReviewEligibility = Record<string, { eligible?: boolean; publicationScope?: string }>;

/** Mutually exclusive original states. Only Rust's projected eligible flag
 * grants source readiness; an AI scope, colour or local check never does. */
export function sourceReviewState(row: ImportTriageRow): SourceReviewState {
  if (row.published) return "published";
  if (row.duplicateState === "exact") return "duplicate";
  if (row.question?.reviewDecision === "reject") return "rejected";
  return row.eligible === true ? "eligible" : "pending";
}

export const isReviewReady = (row: ImportTriageRow) => sourceReviewState(row) === "eligible";

/** AI work is independent of original publication. Historical findings on an
 * adopted draft are not new work; an unfinished publication receipt still is. */
export function isTeachingPending(row: ImportTriageRow): boolean {
  const source = sourceReviewState(row);
  if (source === "duplicate" || source === "rejected") return false;
  const issues = Array.isArray(row.issues) ? row.issues : [];
  const receipt = issues.some(issue => issue.domain === "teaching" && issue.code === "teaching_publication_receipt_pending");
  if (row.teachingState === "adopted") return receipt;
  return receipt || issues.some(issue => issue.domain === "teaching")
    || source === "published" && row.teachingState === "ready"
    || Boolean(row.question?.teachingWorkflow && ["not_started", "generating", "failed", "needs_review"].includes(row.teachingState));
}

export function isBothReviewReady(row: ImportTriageRow, eligibility: ReviewEligibility): boolean {
  return isReviewReady(row) && eligibility[row.questionId]?.eligible === true
    && eligibility[row.questionId].publicationScope === "source_and_teaching";
}

export function importReviewSummary(rows: ImportTriageRow[], eligibility: ReviewEligibility = {}) {
  const result = { total: rows.length, sourcePending: 0, sourceReady: 0, published: 0, duplicate: 0, rejected: 0,
    teachingPending: 0, bothReady: 0, sourceOnlyReady: 0 };
  for (const row of rows) {
    const source = sourceReviewState(row);
    if (source === "pending") result.sourcePending += 1;
    else if (source === "eligible") result.sourceReady += 1;
    else result[source] += 1;
    if (isTeachingPending(row)) result.teachingPending += 1;
    if (isBothReviewReady(row, eligibility)) result.bothReady += 1;
    if (source === "eligible" && eligibility[row.questionId]?.eligible === true
      && eligibility[row.questionId].publicationScope === "source_only") result.sourceOnlyReady += 1;
  }
  return result;
}

export function reviewStatusLabel(row?: ImportTriageRow) {
  if (!row) return "请选择题目";
  const source = sourceReviewState(row);
  if (source === "published") return "原题已入库";
  if (source === "duplicate") return "题库已有此题";
  if (source === "rejected") return "本题未采用";
  if (source === "eligible") return "原题可入库";
  return row.sourceState === "blocked" ? "暂无法入库" : "本题待核对";
}

export function reviewRowsForFilter(rows: ImportTriageRow[], filter: string, eligibility: ReviewEligibility = {}) {
  return rows.filter(row => {
    const source = sourceReviewState(row);
    return filter === "all" || filter === "source_pending" && source === "pending"
      || filter === "source_ready" && source === "eligible"
      || filter === "teaching" && isTeachingPending(row)
      || filter === "published" && source === "published"
      || filter === "duplicate" && source === "duplicate"
      || filter === "rejected" && source === "rejected"
      || filter === "both_ready" && isBothReviewReady(row, eligibility);
  });
}

/** next/previous follow the actual paper order. Task navigation wraps around
 * that same exact question ID, excluding itself and preserving source labels. */
export function nextReviewQuestion(rows: ImportTriageRow[], currentId: string, mode: ImportReviewNextMode = "todo") {
  const index = rows.findIndex(row => row.questionId === currentId);
  if (index < 0) return null;
  if (mode === "next" || mode === "previous") return rows[index + (mode === "previous" ? -1 : 1)]?.questionId || null;
  return [...rows.slice(index + 1), ...rows.slice(0, index)].find(row =>
    mode === "source_pending" ? sourceReviewState(row) === "pending"
      : mode === "teaching" ? isTeachingPending(row) : sourceReviewState(row) === "pending" || isTeachingPending(row))?.questionId || null;
}

export function sourceFieldStatuses(question: any, sourceIssues: { message: string; target?: { fieldPath: string } }[] = [], dirty = false) {
  const has = (key: string) => [question?.[key], ...(question?.parts || []).map((part: any) => part[key])]
    .some(value => typeof value === "string" && value.trim());
  const definitions = [
    { id:"stem", label:"题干与小问", check:"sourceMatched", paths:/^(stem|parts\[\d+\]\.(stem|prompt))$/ },
    ...(["single_choice", "multiple_choice"].includes(question?.questionType)
      ? [{id:"options",label:"选项",check:"sourceMatched",paths:/^options(?:\[\d+\]\.text)?$/}] : []),
    {id:"materials",label:"公式与配图",check:"formulaChecked",paths:/image|figure|diagram|table|formula|math|asset/},
    ...(has("answer") ? [{id:"answer",label:"原卷答案",check:"answerChecked",paths:/^(answer|parts\[\d+\]\.answer)$/}] : []),
    ...(has("solution") ? [{id:"solution",label:"原卷解析",check:"solutionChecked",paths:/^(solution|parts\[\d+\]\.solution)$/}] : []),
  ];
  return definitions.map(item => {
    const finding = sourceIssues.find(issue => item.paths.test(issue.target?.fieldPath || ""));
    return {...item,status: finding ? "issue" : !dirty && question?.reviewChecks?.[item.check] === true ? "checked" : "pending",
      statusLabel:finding ? "有疑点" : !dirty && question?.reviewChecks?.[item.check] === true ? "已核对" : "需核对",finding};
  });
}
