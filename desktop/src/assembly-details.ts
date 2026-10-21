import { typeIds } from "./bridge";
import difficultyRubric from "../resources/difficulty-rubric.json";

export const difficultyLevels = difficultyRubric.levels;
const levels = Object.fromEntries(difficultyLevels.map(level => [level.id, level.label]));
const basisText = (value: any): string => typeof value === "string" ? value : typeof value?.rationale === "string" ? value.rationale : "";

export function frozenAnnotation(question: any, snapshot: any) {
  return question && snapshot?.entries?.find((entry: any) =>
    entry.questionId === question.questionId && entry.contentVersion === question.contentVersion && entry.teacherVersion === question.teacherVersion);
}

export function resizeQuestionCounts(requirements: any, amount: number) {
  if (!Number.isInteger(amount) || amount < 1 || amount > 60) return requirements;
  const counts = Object.fromEntries(typeIds.map(type => [type, requirements.counts?.[type] || 0]));
  const previous = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const preferred = typeIds.find(type => counts[type] > 0);
  if (!preferred || previous === amount) return requirements;
  if (amount > previous) counts[preferred] += amount - previous;
  else {
    let remove = previous - amount;
    for (const type of [preferred, ...typeIds.filter(type => type !== preferred)]) {
      const take = Math.min(remove, counts[type]);
      counts[type] -= take;
      remove -= take;
    }
  }
  const constraints = requirements.typeConstraints;
  const exact = constraints?.exactCounts;
  return { ...requirements, counts, questionCount: amount,
    ...(constraints ? { typeConstraints: { ...constraints,
      ...(exact ? { exactCounts: Object.fromEntries(Object.keys(exact).map(type => [type, counts[type] ?? 0])) } : {}) } } : {}) };
}

// Read the draft's frozen annotation, never a newer bank label or a model's
// planning rationale. A target is a teacher preference, not a measured result.
export function slotDifficulty(slot: any, requirements: any, snapshot: any) {
  const hasLevel = Object.prototype.hasOwnProperty.call(slot, "targetDifficultyLevel");
  const level = hasLevel ? slot.targetDifficultyLevel : typeof slot.targetDifficulty === "number" ? null : requirements?.targetDifficultyLevel;
  const target = hasLevel ? slot.targetDifficulty : slot.targetDifficulty ?? requirements?.targetDifficulty;
  const numericLabel = typeof target === "number" && Number.isFinite(target) && target >= 0 && target <= 1
    ? `目标 ${target.toFixed(2)}` : "";
  const targetLabel = levels[level] || numericLabel;
  const question = slot.question;
  const annotation = frozenAnnotation(question, snapshot);
  const estimate = levels[annotation?.difficultyLevel] || "";
  return {
    label: targetLabel || estimate || (question ? "未评估" : "未指定"),
    detail: targetLabel ? (estimate ? `题目：${estimate}` : question ? "题目未评估" : "尚未选题") : estimate ? "内容估计" : "",
    selectValue: levels[level] ? level : numericLabel ? "legacy" : "",
    legacyLabel: numericLabel ? `原目标 ${target.toFixed(2)}` : "",
    estimateLabel: estimate ? `题目：${estimate}` : question ? "题目未评估" : "尚未选题",
    targetLabel,
    estimate: estimate || (question ? "未评估" : "尚未选题"),
    basis: basisText(annotation?.difficultyBasis),
  };
}

export function questionInformation(slot: any, draft: any) {
  const question = slot.question;
  const config = draft?.baseline?.taskCatalogSnapshot || {};
  const annotation = frozenAnnotation(question, draft?.baseline?.questionIndexSnapshot);
  const names = (uids: any) => (Array.isArray(uids) ? uids : []).map(uid =>
    config.knowledgeCatalogue?.points?.find((point: any) => point.uid === uid)?.name || "知识点名称未记录");
  const sectionNames = (ids: any) => (Array.isArray(ids) ? ids : []).map(id =>
    config.chapters?.find((chapter: any) => chapter.id === id || chapter.id === (String(id).startsWith("rja-compulsory-1:") ? String(id).split(":")[1] : `rja-compulsory-1:${id}`))?.label || "小节名称未记录");
  const modern = annotation && (Object.hasOwn(annotation, "primaryKnowledgeUids") || Object.hasOwn(annotation, "knowledgeSchemaVersion") || annotation.solutionPaths?.some((path: any) => Object.hasOwn(path, "requiredKnowledgeUids")));
  const scope = question?.scopeEvidence;
  const scopeValid = question && scope?.contentVersion === question.contentVersion && scope?.teacherVersion === question.teacherVersion;
  return {
    tasks: (annotation?.tasks || []).map((id: string) => config.tasks?.find((task: any) => task.id === id)?.label).filter(Boolean),
    knowledgeLabel: modern ? "主考知识" : "相关知识",
    knowledge: modern ? names(annotation.primaryKnowledgeUids) : scopeValid && Array.isArray(scope.primaryTopics) ? scope.primaryTopics : [],
    sections: sectionNames(annotation?.primarySections),
    paths: (annotation?.solutionPaths || []).map((path: any, index: number) => ({
      label: `解法 ${index + 1}`,
      knowledgeLabel: modern ? "所需知识" : "所需小节",
      knowledge: modern ? names(path.requiredKnowledgeUids) : sectionNames(path.requiredSections),
      premises: (path.requiredPremises || []).map((id: string) => config.premises?.find((premise: any) => premise.id === id)?.label || "工具名称未记录"),
      basis: basisText(path.basis),
    })),
  };
}
