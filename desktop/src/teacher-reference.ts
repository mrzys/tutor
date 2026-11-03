import { teachingAnalysisPresentation } from "./shared/teaching-analysis.mjs";

const items = (value: unknown): any[] => Array.isArray(value) ? value : [];
const present = (value: unknown): boolean => typeof value === "string"
  && Boolean(value.replace(/<\/?(?:p|div|span|br)\b[^>]*>/gi, "").replace(/&nbsp;|&#160;|[\u200b\ufeff]/gi, " ").trim());
export function teacherReferenceEntries(question: any, field: "answers" | "solutions") {
  return items(question?.teacher?.[field]).filter(entry => present(entry?.text));
}

/** Workspace-only availability, never an eligibility or mathematics check.
 * Whole-question references cover the question; part references must cover each
 * actual leaf part, including references attached to its parent part.
 */
export function teacherReferenceAvailability(question: any, teacher = false) {
  if (teacher !== true || !question || typeof question !== "object") return null;
  const parts = items(question.student?.parts);
  const leaves = parts.filter(part => !parts.some(other => other.parentPartId === part.partId));
  const material = (field: "answers" | "solutions") => {
    const entries = teacherReferenceEntries(question, field);
    // Historical bank questions use "main" for a whole-question reference.
    // Accept that established identity only when there are no actual subparts.
    const whole = entries.some(entry => entry.partId == null || entry.partId === ""
      || parts.length === 0 && entry.partId === "main");
    const covered = (part: any) => {
      const seen = new Set<string>();
      let current = part;
      while (typeof current?.partId === "string" && current.partId && !seen.has(current.partId)) {
        if (entries.some(entry => entry.partId === current.partId)) return true;
        seen.add(current.partId);
        current = parts.find(parent => parent.partId === current.parentPartId);
      }
      return false;
    };
    const missing = whole ? [] : leaves.filter(part => !covered(part));
    const complete = whole || leaves.length > 0 && missing.length === 0;
    return { complete, partial: !complete && leaves.some(part => covered(part)),
      missingParts: missing.map(part => part.partId).filter((id): id is string => typeof id === "string") };
  };
  const answers = material("answers"), solutions = material("solutions");
  const ai = teachingAnalysisPresentation(question, true);
  const readyAi = ai && !ai.needsReview ? ai : null;
  const missingAnswer = !answers.complete && !present(readyAi?.answer);
  const missingSolution = !solutions.complete && !present(readyAi?.solution);
  const messages = [missingAnswer ? answers.partial ? "部分小问未附参考答案" : "未附参考答案" : "",
    missingSolution ? solutions.partial ? "部分小问未附解析" : "未附解析" : ""].filter(Boolean);
  return { missingAnswer, missingSolution, partialAnswer: answers.partial, partialSolution: solutions.partial,
    missingAnswerParts: missingAnswer ? answers.missingParts : [], missingSolutionParts: missingSolution ? solutions.missingParts : [],
    pendingAi: Boolean(ai?.needsReview), message: messages.join("；") };
}
