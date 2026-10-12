import Database from 'better-sqlite3';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateSolutionDependencies } from '../src/question-bank/dependencies.mjs';
import { hashContent } from '../src/question-bank/integrity.mjs';

const directory = path.resolve('.tutor/chapter12-expansion');
const db = new Database(path.join(directory, 'import-storage', 'tutor.sqlite'));
try {
  const catalog = db.prepare('SELECT section_id AS id,title FROM curriculum_sections').all();
  const chapters = db.prepare('SELECT payload FROM question_bank_chapters').all().map(row => JSON.parse(row.payload));
  const index = JSON.parse(db.prepare("SELECT payload FROM question_bank_state WHERE kind='question_index'").get().payload);
  const ledger = JSON.parse(db.prepare("SELECT payload FROM question_bank_state WHERE kind='ledger'").get().payload);
  const canonical = id => {
    const section = catalog.find(item => item.id === id);
    return (id.startsWith('rja-compulsory-1:') && chapters.find(item => item.id === id.split(':')[1] && item.label === section?.title)?.id) || id;
  };
  const fullId = id => catalog.some(item => item.id === id) ? id : catalog.find(item => canonical(item.id) === id)?.id ?? id;
  const results = [];
  for (const row of db.prepare("SELECT payload FROM question_bank_questions WHERE question_id LIKE 'tutor-import-%'").all()) {
    const q = JSON.parse(row.payload), annotation = index.entries.find(item => item.questionId === q.questionId);
    const solution = [...q.teacher.solutions.map(item => item.text), q.scopeEvidence.allowedSolution ?? ''].join('\n');
    const check = validateSolutionDependencies(solution, catalog, annotation.solutionPaths.flatMap(item => item.requiredSections.map(fullId)));
    if (check.missingSectionIds.length) annotation.solutionPaths.forEach(item => {
      item.requiredSections = [...new Set([...item.requiredSections, ...check.missingSectionIds.map(canonical)])];
    });
    if (check.unmapped.length) {
      annotation.solutionPaths = [];
      annotation.dependencyReview.status = 'unknown';
      const entry = ledger.entries.find(item => item.questionId === q.questionId);
      entry.status = 'pending'; entry.pendingReasons = [...new Set([...entry.pendingReasons, '完整解法存在无法映射到教材的显式依赖。'])];
    }
    annotation.dependencyReview.explicitOperationGuard = { ...check, appliedAt: new Date().toISOString(), contentVersion: q.contentVersion, teacherVersion: q.teacherVersion,
      meaning: '检查已有完整解法的显式操作，保守补充漏项；不证明全部数学依赖完备或答案正确。' };
    results.push({ questionId: q.questionId, sourceQuestionId: q.verification.origin.sourceQuestionId, ...check });
  }
  const now = new Date().toISOString();
  db.transaction(() => {
    let n = db.prepare('SELECT coalesce(max(position),-1)+1 AS n FROM question_bank_chapters').get().n;
    for (const id of new Set(index.entries.flatMap(item => item.solutionPaths.flatMap(value => value.requiredSections)))) {
      if (chapters.some(item => item.id === id)) continue;
      const section = catalog.find(item => item.id === id);
      if (!section) throw new Error(`Unknown section ${id}`);
      const payload = { id, label: section.title, textbookSectionId: id };
      db.prepare('INSERT INTO question_bank_chapters VALUES(?,?,?,?,?)').run(id, n++, JSON.stringify(payload), hashContent(payload), now);
    }
    for (const [kind, payload] of [['question_index', index], ['ledger', ledger]]) db.prepare('UPDATE question_bank_state SET payload=?,sha256=?,synced_at=? WHERE kind=?').run(JSON.stringify(payload), hashContent(payload), now, kind);
  }).immediate();
  const summary = { checked: results.length, expanded: results.filter(item => item.missingSectionIds.length).length, unmapped: results.filter(item => item.unmapped.length).length, results };
  await writeFile(path.join(directory, 'explicit-dependency-guard.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, results: results.filter(item => item.missingSectionIds.length || item.unmapped.length) }));
} finally { db.close(); }
