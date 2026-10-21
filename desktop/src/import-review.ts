// Imported source fields stay distinct from model annotation and old references.
// A missing answer/solution is not a review task and must never be filled in here.
export function requiredReviewChecks(question: any): string[] {
  const has = (field: string) => [question?.[field], ...(question?.parts || []).map((part: any) => part[field])]
    .some(value => typeof value === "string" && value.trim().length > 0);
  return ["sourceMatched", "formulaChecked",
    ...(has("answer") ? ["answerChecked"] : []),
    ...(has("solution") ? ["solutionChecked"] : []),
  ];
}

export const isChoiceQuestion = (question: any) => ["single_choice", "multiple_choice"].includes(question?.questionType);
export function sourceReviewLabel(question: any) {
  return isChoiceQuestion(question) ? "题干与选项" : "题干与小问";
}
export function sourceReviewDescription(question: any) {
  return isChoiceQuestion(question)
    ? "核对题号、条件、选项及小问，确认没有遗漏或串题。"
    : "核对题号、条件、小问及填空位置，确认没有遗漏或串题。";
}

// A short navigation aid, never a replacement for the stored opinion or the
// server's publication decision. The complete source-bound record stays intact.
export function briefReviewReasons(question: any, eligibilityReason = ""): string[] {
  const review = question?.modelReview;
  if (review?.status === "stale") return ["题目已修改，请重新检查"];
  if (review?.status === "failed") return ["检查未完成，请重试"];
  const short = (value: string) => {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    const chars = Array.from(text);
    return chars.length > 32 ? chars.slice(0, 31).join("") + "…" : text;
  };
  const issues = Array.isArray(review?.issues) ? review.issues : [];
  const ordered = [...issues].sort((a: any, b: any) => Number(/answer|solution|analysis/.test(String(a?.field))) - Number(/answer|solution|analysis/.test(String(b?.field))));
  const labels = ordered.map((issue: any) => {
    const field = String(issue?.field || "").toLowerCase();
    const text = String(issue?.message || "");
    if (/image|figure|diagram/.test(field)) return "配图需核对";
    if (/table/.test(field)) return "表格需核对";
    if (/formula|math/.test(field)) return "公式需核对";
    if (/stem|prompt|part/.test(field)) return "题干或小问需核对";
    if (/option|choice/.test(field)) return isChoiceQuestion(question) ? "选项需核对" : "检查意见需复核";
    if (/answer/.test(field)) return "答案提取情况需核对";
    if (/solution|analysis/.test(field)) return "解析提取情况需核对";
    return short(text);
  }).filter(Boolean);
  const unique = [...new Set<string>(labels)];
  if (unique.length) return unique.slice(0, 1);
  return [short(eligibilityReason || review?.summary || "暂无检查意见")];
}
