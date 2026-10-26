// Only the question versions captured by this draft/paper may supply evidence.
// Missing identities in an older record do not establish a version match.
export function frozenAnnotation(question, snapshot) {
  if (!question?.questionId || !question.contentVersion || !question.teacherVersion) return undefined;
  return snapshot?.entries?.find(entry =>
    entry.questionId === question.questionId && entry.contentVersion === question.contentVersion && entry.teacherVersion === question.teacherVersion);
}

export function frozenDifficultyBasis(question, snapshot) {
  const value = frozenAnnotation(question, snapshot)?.difficultyBasis;
  return typeof value === "string" ? value : typeof value?.rationale === "string" ? value.rationale : "";
}

// A missing slot still has its confirmed task. Never infer one from its reason,
// a neighbouring slot, or the current live task catalogue.
export function confirmedSlotTaskLabel(slot, frozenCatalog) {
  const saved = typeof slot?.taskLabel === "string" ? slot.taskLabel : "";
  if (saved.trim()) return saved;
  const label = frozenCatalog?.tasks?.find(task => task.id === slot?.taskId)?.label;
  return typeof label === "string" && label.trim() ? label : "考查点未记录";
}
