export type ImportAnnotationPlan = {
  importId: string;
  revision: number;
  detailVersion: string;
  title: string;
  questions: { questionId: string; label: string }[];
};

/** The backend owns this whole-import scope. Never derive it from the current
 * question, loaded detail, review filter, or AI display text. */
export function createImportAnnotationPlan(record: any, detailVersion?: string): ImportAnnotationPlan {
  const ids = record?.annotationQuestionIds;
  const questions = Array.isArray(record?.questions) ? record.questions : [];
  if (!record?.importId || !Number.isSafeInteger(record.revision) || !detailVersion
    || !Array.isArray(ids) || ids.some(id => typeof id !== "string" || !id)
    || new Set(ids).size !== ids.length || ids.some(id => questions.filter((q: any) => q.questionId === id).length !== 1)) {
    throw new Error("本卷待补范围读取不完整，请重新打开试卷后再试。");
  }
  return {
    importId: record.importId, revision: record.revision, detailVersion,
    title: record.structuredSource?.exam?.title || record.filename || "当前试卷",
    questions: ids.map(id => {
      const index = questions.findIndex((q: any) => q.questionId === id);
      return { questionId: id, label: String(questions[index].sourceLabel || index + 1) };
    }),
  };
}

export function importAnnotationPlanCurrent(plan: ImportAnnotationPlan, record: any, detailVersion?: string) {
  return plan.importId === record?.importId && plan.revision === record?.revision
    && plan.detailVersion === detailVersion
    && JSON.stringify(plan.questions.map(q => q.questionId)) === JSON.stringify(record?.annotationQuestionIds);
}
