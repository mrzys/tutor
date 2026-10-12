import Database from 'better-sqlite3';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { hashContent } from '../src/question-bank/integrity.mjs';

const directory = path.resolve('.tutor/chapter12-expansion');
const filename = path.resolve(process.argv[2] ?? path.join(directory, 'import-storage', 'tutor.sqlite'));
const db = new Database(filename, { readonly: true });
try {
  const questions = db.prepare('SELECT * FROM question_bank_questions').all().map(row => {
    const value = JSON.parse(row.payload);
    if (hashContent(value) !== row.sha256) throw new Error(`Question integrity failure: ${row.question_id}`);
    return value;
  });
  const imported = questions.filter(question => question.questionId.startsWith('tutor-import-'));
  const excluded = new Set([6840, 8208, 6132, 6274, 6364, 6151, 5682]);
  for (const question of imported) {
    if (excluded.has(Number(question.verification.origin.sourceQuestionId))) throw new Error('Quarantined source entered live bank');
  }
  for (const row of db.prepare('SELECT * FROM question_imports').all()) {
    if (createHash('sha256').update(row.source_blob).digest('hex') !== row.source_sha256) throw new Error('Import source integrity failure');
  }
  const index = JSON.parse(db.prepare("SELECT payload FROM question_bank_state WHERE kind='question_index'").get().payload);
  const ledger = JSON.parse(db.prepare("SELECT payload FROM question_bank_state WHERE kind='ledger'").get().payload);
  const by = (values, key) => Object.fromEntries([...new Set(values.map(key))].map(value => [value, values.filter(item => key(item) === value).length]));
  const importedIds = new Set(imported.map(question => question.questionId));
  const annotations = index.entries.filter(item => importedIds.has(item.questionId));
  const readyIds = new Set(ledger.entries.filter(item => item.status === 'ready').map(item => item.questionId));
  const readyImported = imported.filter(item => readyIds.has(item.questionId));
  const readyAnnotations = annotations.filter(item => readyIds.has(item.questionId));
  const review = JSON.parse(await readFile(path.join(directory, 'post-assembly-math-review.json'), 'utf8'));
  const heldAfterPublication = (review.items ?? review.reviews).filter(item => item.status === 'hold').map(item => Number(item.sourceQuestionId));
  if (ledger.entries.some(entry => entry.status === 'ready' && heldAfterPublication.includes(Number(questions.find(q => q.questionId === entry.questionId)?.verification?.origin?.sourceQuestionId)))) throw new Error('Post-publication held question is still selectable');
  if (annotations.some(item => !item.dependencyReview || item.dependencyReview.contentVersion !== item.contentVersion || item.dependencyReview.teacherVersion !== item.teacherVersion
      || (item.dependencyReview.status !== 'complete' && item.solutionPaths.length))) throw new Error('Missing or unsafe version-bound dependency review');
  if (annotations.some(item => item.difficultyBasis?.method !== 'llm_estimate' || item.difficultyBasis?.empirical !== false)) throw new Error('Missing model difficulty provenance');
  if (db.pragma('foreign_key_check').length) throw new Error('Foreign key validation failed');
  const summary = { observedAt: new Date().toISOString(), database: filename, totalQuestionPayloads: questions.length,
    ready: ledger.entries.filter(item => item.status === 'ready').length, imported: imported.length,
    readyImported: readyImported.length, readyImportedTypes: by(readyImported, item => item.questionType), readyImportedDifficulty: by(readyAnnotations, item => item.difficultyLevel),
    types: by(imported, item => item.questionType), difficulty: by(annotations, item => item.difficultyLevel),
    sections: db.prepare(`SELECT s.section_id,s.title,count(q.question_id) AS questions FROM curriculum_sections s
      LEFT JOIN question_section_mappings q ON q.section_id=s.section_id AND q.question_id IN (
        SELECT json_extract(value,'$.questionId') FROM json_each((SELECT payload FROM question_bank_state WHERE kind='ledger'),'$.entries') WHERE json_extract(value,'$.status')='ready')
      WHERE s.chapter_id IN ('rja-compulsory-1:1','rja-compulsory-1:2') GROUP BY s.section_id ORDER BY s.section_id`).all(),
    modelRuns: by(annotations, item => item.difficultyBasis.llmRun.model),
    dependencyReviews: by(annotations, item => item.dependencyReview.status), heldAfterPublication,
    questionIntegrity: 'pass', sourceBlobIntegrity: 'pass', foreignKeys: 'pass', excludedSourcesNotPublished: [...excluded] };
  await writeFile(path.join(directory, 'bank-audit.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally { db.close(); }
