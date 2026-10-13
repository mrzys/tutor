import { hashContent } from './integrity.mjs';

const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

// Match the exact historical occurrence and version, never merely a similar stem.
export function planSourceBackfill(questions, legacy) {
  const byIdentity = new Map();
  for (const row of legacy.questions ?? []) {
    const key = [row.question_id, row.content_version_id, row.source_exam_id, row.source_occurrence_id].map(String).join(':');
    if (byIdentity.has(key)) throw new Error(`旧库来源身份重复：${key}`);
    byIdentity.set(key, row);
  }
  const changes = [], unmatched = [], unchanged = [], conflicts = [];
  for (const question of questions) {
    const origin = question.verification?.origin;
    if (!origin?.sourceQuestionId) continue;
    const identity = [origin.sourceQuestionId, origin.sourceContentVersionId, origin.sourceExamId, origin.sourceOccurrenceId].map(String).join(':');
    const row = byIdentity.get(identity);
    if (!row || !row.source_title?.trim()
        || ![origin.sourceEvidenceHash, origin.studentContentHash, row.source_evidence_hash, row.student_content_hash].every(validHash)
        || origin.sourceEvidenceHash !== row.source_evidence_hash
        || origin.studentContentHash !== row.student_content_hash) { unmatched.push(question.questionId); continue; }
    const sourceTitle = row.source_title.trim();
    const sourceQuestionNumber = row.question_number === null || row.question_number === undefined ? '' : String(row.question_number).trim();
    if (origin.sourceTitle && origin.sourceTitle !== sourceTitle || origin.sourceQuestionNumber !== undefined && String(origin.sourceQuestionNumber) !== sourceQuestionNumber) {
      conflicts.push(question.questionId); continue;
    }
    if (origin.sourceTitle === sourceTitle && String(origin.sourceQuestionNumber ?? '') === sourceQuestionNumber) { unchanged.push(question.questionId); continue; }
    const updated = structuredClone(question);
    Object.assign(updated.verification.origin, { sourceTitle, sourceQuestionNumber });
    changes.push({ questionId: question.questionId, beforeHash: hashContent(question), afterHash: hashContent(updated), question: updated,
      sourceTitle, sourceQuestionNumber });
  }
  return { changes, unmatched, unchanged, conflicts };
}
