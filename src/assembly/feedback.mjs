import path from 'node:path';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { sqliteStorage } from '../storage/sqlite.mjs';

const queues = new Map();
export async function readFeedback(feedbackRoot, paperId) {
  try {
    const repository = sqliteStorage(feedbackRoot, 'feedback');
    const value = repository ? repository.get('feedback', paperId) : JSON.parse(await readFile(path.join(feedbackRoot, `${paperId}.json`), 'utf8'));
    if (!value) return null;
    if (value.schemaVersion !== 1 || value.paperId !== paperId || !Array.isArray(value.records)) throw new Error('Invalid feedback');
    return value.records.at(-1) ?? null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw Object.assign(new Error('使用反馈无法读取，成卷和输出仍保留。'), { code: 'read_error' });
  }
}

export async function saveFeedback(feedbackRoot, paper, input) {
  if (!input || !['yes', 'after_changes', 'no'].includes(input.willingToUse)
      || typeof input.reason !== 'string' || input.reason.length > 2000
      || typeof input.manualCorrections !== 'string' || input.manualCorrections.length > 2000) {
    throw Object.assign(new Error('请填写使用意愿、原因及手工修正情况（各不超过 2000 字）。'), { code: 'invalid_request' });
  }
  const target = path.join(feedbackRoot, `${paper.paperId}.json`);
  const previous = queues.get(target) ?? Promise.resolve();
  const transaction = previous.then(async () => {
    const repository = sqliteStorage(feedbackRoot, 'feedback');
    let records = [];
    try { records = repository ? (repository.get('feedback', paper.paperId)?.records ?? []) : JSON.parse(await readFile(target, 'utf8')).records; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const operations = paper.draft.operations ?? [];
    const entries = operations.flatMap(operation => operation.result?.entries ?? []);
    const feedback = { feedbackId: randomUUID(), paperId: paper.paperId, source: 'user_reported',
      willingToUse: input.willingToUse, reason: input.reason.trim(), manualCorrections: input.manualCorrections.trim(),
      createdAt: new Date().toISOString(), metrics: {
        replacementRequests: operations.filter(item => item.operation?.type === 'replace').length,
        replacementCount: entries.filter(item => item.status === 'replaced').length,
        addedSlots: entries.filter(item => item.status === 'added').length,
        deletedSlots: entries.filter(item => item.status === 'deleted').length,
        pointEdits: operations.filter(item => item.operation?.type === 'points').length,
        baselineCorrections: operations.filter(item => item.operation?.type === 'baseline').length,
        missingQuestions: paper.summary.student.missing.length,
      } };
    if (repository) { repository.appendFeedback(paper.paperId, feedback); return feedback; }
    const temporary = `${target}.${randomUUID()}.tmp`; let file;
    try {
      await mkdir(feedbackRoot, { recursive: true });
      file = await open(temporary, 'wx');
      await file.writeFile(`${JSON.stringify({ schemaVersion: 1, paperId: paper.paperId, records: [...records, feedback] }, null, 2)}\n`, 'utf8');
      await file.sync(); await file.close(); file = undefined; await rename(temporary, target);
    } catch (error) {
      await file?.close().catch(() => {}); await unlink(temporary).catch(() => {});
      throw Object.assign(new Error(`使用反馈保存失败：${error.message}`), { code: 'save_error' });
    }
    return feedback;
  });
  const tail = transaction.catch(() => {}); queues.set(target, tail);
  try { return await transaction; }
  finally { if (queues.get(target) === tail) queues.delete(target); }
}
