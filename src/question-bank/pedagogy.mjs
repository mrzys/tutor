import { readFile } from 'node:fs/promises';
import path from 'node:path';

const text = value => typeof value === 'string' ? value.trim() : '';

// Search annotations remain separate from reviewed support for automatic selection.
// Only explicit, version-bound labels with producer evidence are imported.
export function normalizePedagogyAnalysis(analysis) {
  if (analysis?.schemaVersion !== 1 || !Array.isArray(analysis.questions)) {
    throw Object.assign(new Error('教研标注文件格式无效。'), { code: 'integrity_error' });
  }
  const entries = new Map();
  for (const question of analysis.questions) {
    const context = question?.sourceContext;
    if (!text(question?.questionId) || !text(context?.contentVersion) || !text(context?.teacherVersion)) continue;
    if (['rejected', 'needs_revision'].includes(question.review?.status)) continue;
    const key = `${question.questionId}:${context.contentVersion}:${context.teacherVersion}`;
    const current = entries.get(key) ?? { questionId: question.questionId,
      contentVersion: context.contentVersion, teacherVersion: context.teacherVersion,
      abilities: [], literacies: [], status: 'reviewed' };
    const abilities = (question.observableAbilities ?? []).filter(item => text(item?.evidence)).map(item => text(item.activity)).filter(Boolean);
    const literacies = text(question.coreLiteracy?.evidence)
      ? text(question.coreLiteracy.primary).split(/[、,，;；]/).map(text).filter(Boolean) : [];
    current.abilities = [...new Set([...current.abilities, ...abilities])];
    current.literacies = [...new Set([...current.literacies, ...literacies])];
    if (!['reviewed', 'approved', 'accepted'].includes(question.review?.status)) current.status = 'pending_review';
    entries.set(key, current);
  }
  return { schemaVersion: 1, sourceAnalysisId: analysis.analysisSetId ?? null, entries: [...entries.values()] };
}

export async function readPedagogySeed(root) {
  let source;
  try { source = await readFile(path.join(root, 'data', 'pedagogy', 'set-questions-analysis.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 1, sourceAnalysisId: null, entries: [] }; throw error; }
  return normalizePedagogyAnalysis(JSON.parse(source));
}

export function pedagogyForQuestion(snapshot, question) {
  return snapshot.entries.find(item => item.questionId === question.questionId
    && item.contentVersion === question.contentVersion && item.teacherVersion === question.teacherVersion);
}
