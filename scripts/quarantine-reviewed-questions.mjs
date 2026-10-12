import Database from 'better-sqlite3';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hashContent } from '../src/question-bank/integrity.mjs';

const directory = path.resolve('.tutor/chapter12-expansion');
const review = JSON.parse(await readFile(path.join(directory, 'post-assembly-math-review.json'), 'utf8'));
const entries = review.items ?? review.reviews;
if (!Array.isArray(entries)) throw new Error('Independent review must provide individual items');
const databasePath = path.resolve(process.argv[2] ?? path.join(directory, 'import-storage', 'tutor.sqlite'));
const db = new Database(databasePath);
try {
  const ledger = JSON.parse(db.prepare("SELECT payload FROM question_bank_state WHERE kind='ledger'").get().payload);
  const index = JSON.parse(db.prepare("SELECT payload FROM question_bank_state WHERE kind='question_index'").get().payload);
  const now = new Date().toISOString();
  const held = [];
  for (const item of entries.filter(value => value.status === 'hold')) {
    const id = item.questionId;
    const entry = ledger.entries.find(value => value.questionId === id);
    if (!entry || !id.startsWith('tutor-import-')) throw new Error(`Missing reviewed imported question: ${id}`);
    const question = JSON.parse(db.prepare('SELECT payload FROM question_bank_questions WHERE question_id=?').get(id)?.payload ?? 'null');
    if (!question || hashContent(item.importEvidence?.student) !== question.contentSha256
        || hashContent(item.importEvidence?.teacher) !== question.teacherSha256
        || (item.importEvidence?.contentVersion !== undefined && item.importEvidence.contentVersion !== question.contentVersion)
        || (item.importEvidence?.teacherVersion !== undefined && item.importEvidence.teacherVersion !== question.teacherVersion)
        || Number(item.sourceQuestionId) !== Number(question.verification?.origin?.sourceQuestionId)) {
      throw new Error(`Review does not bind the current imported content: ${id}`);
    }
    entry.status = 'pending';
    entry.pendingReasons = ['真实组卷独立复核发现题面、答案或解析问题，需核对原卷及教师解答。'];
    entry.postPublicationReview = { status: 'hold', reviewedAt: now, reviewSha256: hashContent(review), evidence: item };
    held.push(id);
  }
  const unresolvedDependencies = [];
  for (const annotation of index.entries.filter(item => item.questionId.startsWith('tutor-import-') && item.dependencyReview?.status !== 'complete')) {
    const entry = ledger.entries.find(value => value.questionId === annotation.questionId);
    if (!entry) throw new Error('Missing ledger identity for dependency review');
    entry.status = 'pending';
    entry.pendingReasons = [...new Set([...entry.pendingReasons, '完整解法知识依赖尚未明确，保持待审，不自动选入。'])];
    entry.dependencyHold = { reviewedAt: now, evidenceSha256: hashContent(annotation.dependencyReview), explanation: annotation.dependencyReview.explanation };
    unresolvedDependencies.push(entry.questionId);
  }
  db.prepare("UPDATE question_bank_state SET payload=?,sha256=?,synced_at=? WHERE kind='ledger'").run(JSON.stringify(ledger), hashContent(ledger), now);
  const result = { database: databasePath, held, unresolvedDependencies, ready: ledger.entries.filter(item => item.status === 'ready').length, reviewSha256: hashContent(review) };
  await writeFile(path.resolve(process.argv[3] ?? path.join(directory, 'post-publication-quarantine.json')), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { db.close(); }
