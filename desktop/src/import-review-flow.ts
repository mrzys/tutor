import type { ImportTriageRow } from "./import-triage.ts";

// Navigation/display only. Bank eligibility continues to come from Rust.
export const isReviewReady = (row: ImportTriageRow) => row.eligible && !row.published
  && !row.needsAction && row.duplicateState !== "exact";
export function reviewStatusLabel(row?: ImportTriageRow) {
  if (!row) return "请选择题目";
  if (row.duplicateState === "exact") return "题库已有此题";
  if (row.question?.reviewDecision === "reject" && !row.published) return "本题未采用";
  if (row.published) return row.needsAction ? "原题已入库，解析待处理" : "本题已入库";
  if (row.eligible) return row.needsAction ? "原题可入库，解析待处理" : "本题已就绪";
  return row.sourceState === "blocked" ? "暂无法入库" : "本题待核对";
}
export function reviewRowsForFilter(rows: ImportTriageRow[], filter: string) {
  return rows.filter(row => filter === "all" || (filter === "todo" && row.needsAction)
    || (filter === "ready" && isReviewReady(row)) || (filter === "published" && row.published)
    || (filter === "duplicate" && row.duplicateState === "exact"));
}
export function nextReviewQuestion(rows: ImportTriageRow[], currentId: string, mode: "todo" | "next" | "previous" = "todo") {
  const index = rows.findIndex(row => row.questionId === currentId);
  if (index < 0) return null;
  if (mode !== "todo") return rows[index + (mode === "previous" ? -1 : 1)]?.questionId || null;
  return [...rows.slice(index + 1), ...rows.slice(0, index)].find(row => row.needsAction)?.questionId || null;
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
