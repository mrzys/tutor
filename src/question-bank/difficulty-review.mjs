import { hashContent } from './integrity.mjs';
import { validateDifficultyReview } from '../llm/difficulty-review-gateway.mjs';

const known = new Set(['easy', 'medium', 'hard']);
function snapshot(db, kind) {
  const row = db.prepare('SELECT payload,sha256 FROM question_bank_state WHERE kind=?').get(kind);
  if (!row) throw new Error(`Missing bank snapshot: ${kind}`);
  const value = JSON.parse(row.payload);
  if (hashContent(value) !== row.sha256) throw new Error(`Invalid bank snapshot: ${kind}`);
  return value;
}

export function unknownDifficultyInputs(db) {
  const ledger = snapshot(db, 'ledger'), index = snapshot(db, 'question_index');
  const ready = new Set(ledger.entries.filter(q => q.status === 'ready').map(q => q.questionId));
  return index.entries.filter(q => ready.has(q.questionId) && !known.has(q.difficultyLevel)).sort((a,b) => a.questionId.localeCompare(b.questionId)).map(annotation => {
    const row = db.prepare('SELECT payload,sha256 FROM question_bank_questions WHERE question_id=?').get(annotation.questionId);
    const question = row && JSON.parse(row.payload);
    if (!question || hashContent(question) !== row.sha256 || annotation.contentVersion !== question.contentVersion || annotation.teacherVersion !== question.teacherVersion) throw new Error('Question version or integrity mismatch.');
    const texts = [{ ref: 'student.stem', text: question.student.stem },
      ...question.student.options.map((q,n) => ({ ref: `student.options.${n}`, text: q.text })),
      ...question.student.parts.map((q,n) => ({ ref: `student.parts.${n}`, text: q.prompt })),
      ...question.teacher.answers.map((q,n) => ({ ref: `teacher.answers.${n}`, text: q.text })),
      ...question.teacher.solutions.map((q,n) => ({ ref: `teacher.solutions.${n}`, text: q.text }))];
    return { questionId: question.questionId, questionType: question.questionType, contentVersion: question.contentVersion,
      teacherVersion: question.teacherVersion, texts, assetCount: question.student.assets.length };
  });
}

/** Version-bound metadata-only write; re-read under transaction to preserve concurrent bank changes. */
export function applyDifficultyReviews(db, records) {
  for (const record of records) {
    if (record.inputSha256 !== hashContent(record.input) || !record.result?.ok || record.result.run?.status !== 'succeeded') throw new Error('A successful validated LLM result is required.');
    validateDifficultyReview(record.result.proposal, record.input);
  }
  return db.transaction(() => {
    const current = new Map(unknownDifficultyInputs(db).map(q => [q.questionId, q]));
    const index = snapshot(db, 'question_index'), changes = [], skipped = [];
    const now = new Date().toISOString();
    for (const record of records) for (const result of record.result.proposal.questions) {
      const question = current.get(result.questionId), original = record.input.questions.find(q => q.questionId === result.questionId);
      if (!question) { skipped.push({ questionId: result.questionId, reason: 'already_reviewed_or_not_ready' }); continue; }
      if (hashContent(question) !== hashContent(original)) throw new Error('Question changed after model review; no annotations written.');
      if (result.level === 'unknown') { skipped.push({ questionId: result.questionId, reason: 'model_unknown' }); continue; }
      const annotation = index.entries.find(q => q.questionId === result.questionId);
      const level = { foundation: 'easy', standard: 'medium', challenge: 'hard' }[result.level];
      annotation.difficultyLevel = level;
      annotation.difficultyEstimate = null;
      annotation.difficultyBasis = { method: 'llm_estimate', empirical: false, level: result.level,
        rationale: result.rationale, evidence: result.evidence, llmRun: record.result.run,
        contentVersion: question.contentVersion, teacherVersion: question.teacherVersion,
        reviewedAt: now, inputSha256: record.inputSha256, workflow: 'difficulty_backfill_v1' };
      changes.push({ questionId: question.questionId, difficultyLevel: level });
      current.delete(question.questionId);
    }
    if (changes.length) db.prepare("UPDATE question_bank_state SET payload=?,sha256=?,synced_at=? WHERE kind='question_index'").run(JSON.stringify(index), hashContent(index), now);
    return { changes, skipped };
  }).immediate();
}
