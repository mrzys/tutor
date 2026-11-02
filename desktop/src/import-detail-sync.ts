/** Navigation placeholders are never editable questions or publication evidence. */
export const hasImportQuestionDetail = (question: any) => Boolean(question && question._detailLoaded !== false);

export function mergeImportView(previous: any, edited: any[], previousVersion: string | undefined,
  result: any, preserveEdits = false) {
  const incoming = result.summary || result.import;
  if (!incoming?.importId || !Array.isArray(incoming.questions)) throw new Error("导入摘要不完整，请重新读取。");
  const same = previous?.importId === incoming.importId && Boolean(previousVersion)
    && previousVersion === result.detailVersion;
  if (preserveEdits && !same) throw new Error("导入记录已变化，当前未保存编辑已保留，请先核对版本差异。");
  const old = new Map<string, any>((previous?.questions || []).map((question: any) => [question.questionId, question]));
  const baselines = incoming.questions.map((question: any) => {
    if (result.question?.questionId === question.questionId) return result.question;
    const cached = old.get(question.questionId);
    return same && hasImportQuestionDetail(cached) ? cached : question;
  });
  const local = new Map<string, any>(edited.map(question => [question.questionId, question]));
  return {
    record: { ...incoming, questions: baselines },
    questions: baselines.map((question: any) => preserveEdits && hasImportQuestionDetail(local.get(question.questionId))
      ? local.get(question.questionId) : structuredClone(question)),
    reusedIds: same ? baselines.filter((question: any) => old.get(question.questionId) === question
      && hasImportQuestionDetail(question)).map((question: any) => question.questionId) : [],
  };
}

/** Enrich this exact snapshot without applying another summary, changing the
 * selection, or replacing local edits. Late reads are useful even after the
 * user moves on, but never belong to a newer snapshot or a reopened import. */
export function mergeImportQuestionDetail(previous: any, edited: any[], version: string | undefined,
  result: any, questionId: string) {
  if (!version || previous?.importId !== result.summary?.importId || version !== result.detailVersion) return null;
  if (result.question?.questionId !== questionId || !hasImportQuestionDetail(result.question)) {
    throw new Error("本题详情与请求不一致，请重新读取。");
  }
  const baseline = previous.questions?.find((question: any) => question.questionId === questionId);
  if (!baseline || hasImportQuestionDetail(baseline)) return null;
  return {
    record: { ...previous, questions: previous.questions.map((question: any) =>
      question.questionId === questionId ? result.question : question) },
    questions: edited.map(question => question.questionId === questionId && !hasImportQuestionDetail(question)
      ? structuredClone(result.question) : question),
  };
}

/** Foreground navigation and prefetch share one read for the same persisted
 * snapshot. Failed reads are removed so an explicit retry can really retry. */
export function createImportQuestionRequests(read: (payload: any) => Promise<any>) {
  const pending = new Map<string, Promise<any>>();
  return {
    get(importId: string, version: string, questionId: string) {
      const key = JSON.stringify([importId, version, questionId]);
      const existing = pending.get(key);
      if (existing) return existing;
      const task = Promise.resolve().then(() => read({ importId, questionId, expectedDetailVersion: version }));
      pending.set(key, task);
      const done = () => { if (pending.get(key) === task) pending.delete(key); };
      void task.then(done, done);
      return task;
    },
    clear() { pending.clear(); },
  };
}

/** Coalesce bursts, serialize reads, and remember invalidations received during
 * a read. No periodic timer: every run follows an event or explicit resync. */
export function createImportRefreshQueue(read: () => Promise<void>, delay = 40) {
  let disposed = false, running = false, queued = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (disposed) return;
    queued = true;
    if (running || timer !== undefined) return;
    timer = setTimeout(async () => {
      timer = undefined;
      if (disposed) return;
      queued = false; running = true;
      try { await read(); }
      finally { running = false; if (queued) schedule(); }
    }, delay);
  };
  return { schedule, dispose: () => { disposed = true; queued = false; clearTimeout(timer); } };
}
