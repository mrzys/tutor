import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { registerSqliteStorage } from '../src/storage/sqlite.mjs';
import { installUserAccess } from '../src/auth/access.mjs';
import { createQuestionImportService } from '../src/question-bank/imports.mjs';
import { getQuestion } from '../src/question-bank/reader.mjs';
import { promoteReviewedBank } from '../scripts/promote-reviewed-bank.mjs';
import { hashContent } from '../src/question-bank/integrity.mjs';

test('reviewed bank promotion defaults to dry-run, backs up and copies audited bank without copying accounts or touching teaching history', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'tutor-promote-'));
  const targetFile = path.join(base, 'target.sqlite'), sourceFile = path.join(base, 'source.sqlite');
  let active;
  t.after(async () => { active?.close(); await rm(base, { recursive: true, force: true }); });
  active = await registerSqliteStorage(path.join(base, 'target-runtime'), targetFile, { questionBankRoot: path.resolve('.') });
  installUserAccess(active.repository);
  const target = active.repository.database;
  target.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run('actual-admin', 'actual@example.test', 'target-hash', 'target-salt', 'admin', '2026-01-01');
  target.prepare('INSERT INTO documents(kind,id,payload,sha256,updated_at) VALUES(?,?,?,?,?)').run('drafts', 'teacher-work', '{"keep":true}', 'existing-hash', '2026-01-01');
  target.prepare('INSERT INTO auth_sessions VALUES(?,?,?,?)').run('actual-session', 'actual-admin', 1, 9999999999999);
  await target.backup(sourceFile);
  active.close(); active = undefined;
  active = await registerSqliteStorage(path.join(base, 'source-runtime'), sourceFile, { questionBankRoot: path.resolve('.') });
  const access = installUserAccess(active.repository);
  active.repository.database.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run('qa-admin', 'qa@example.test', 'qa-hash', 'qa-salt', 'admin', '2026-02-01');
  active.repository.database.prepare('INSERT INTO auth_sessions VALUES(?,?,?,?)').run('qa-session', 'qa-admin', 1, 9999999999999);
  active.repository.database.prepare('INSERT INTO documents(kind,id,payload,sha256,updated_at) VALUES(?,?,?,?,?)').run('drafts', 'source-test-work', '{"test":true}', 'test-hash', '2026-02-01');
  const service = createQuestionImportService({ root: path.resolve('.'), storeRoot: path.join(base, 'source-runtime/question-imports'), gateway: {
    publicStatus: () => ({ configured: true }), propose: async () => ({ ok: true, run: { model: 'fixture' }, proposal: { title: '第二章复核题', questions: [{
      sourceLabel: '1', pages: [1], questionType: 'fill_blank', student: { stem: '迁移隔离测试：若 $a>2$，则 $a+1$ 的取值范围为____。', options: [], parts: [] },
      teacher: { answers: [{ partId: 'main', text: '$(3,+\\infty)$', sourceBasis: 'explicit' }], solutions: [{ partId: 'main', text: '不等式两边加1得 a+1>3。', sourceBasis: 'explicit' }] },
      dimensions: { chapterCandidates: [], taskCandidates: [], primaryTopics: ['不等式性质'], requiredKnowledge: ['不等式同加'], knowledgePoints: [], allowedSolution: '两边同时加1得到a+1>3。', cognition: 'apply', abilities: [], literacies: [], difficultySuggestion: { level: 'foundation', rationale: '一次常规同加运算。' } },
    }] } }),
  } });
  const stream = Readable.from([Buffer.from(JSON.stringify({ filename: 'source.txt', text: 'a>2，求a+1，答案大于3，解析同加1。' }))]);
  stream.headers = { 'content-type': 'application/json' };
  const actor = { userId: 'qa-admin', role: 'admin' };
  const imported = await access.run(actor, () => service.create(stream));
  const published = access.run(actor, () => service.publish(imported.import.importId, {
    sourceSha256: imported.import.source.sha256, review: { method: 'individual', sampleQuestionIds: ['staged-001'], samplePassed: true, basis: 'Fixture individually solved.' },
    questions: [{ stagingQuestionId: 'staged-001', sectionIds: ['rja-compulsory-1:2.1'], taskLabel: '使用不等式同加性质', checks: { sourceMatched: true, answerChecked: true, solutionChecked: true, formulaChecked: true }, basis: 'Fixture source matches and result checked.' }],
  }));
  assert.equal(published.publication.accepted.length, 1);
  const id = published.publication.accepted[0].questionId;
  active.close(); active = undefined;
  const before = new Database(targetFile, { readonly: true });
  const previousDocuments = before.prepare('SELECT * FROM documents').all(), previousUsers = before.prepare('SELECT * FROM users').all(), previousSessions = before.prepare('SELECT * FROM auth_sessions').all();
  before.close();
  const dry = await promoteReviewedBank({ source: sourceFile, target: targetFile });
  assert.equal(dry.applied, false); assert.equal(dry.addedQuestions, 1); assert.equal(dry.backup, null);
  assert.equal((await readdir(base)).some(name => name.includes('before-reviewed-bank')), false);
  const divergent = new Database(targetFile);
  const original = divergent.prepare("SELECT payload,sha256 FROM question_bank_questions WHERE question_id='tutor-set-001'").get();
  const altered = { ...JSON.parse(original.payload), unrelatedTargetNote: 'Keep target changes.' };
  divergent.prepare("UPDATE question_bank_questions SET payload=?,sha256=? WHERE question_id='tutor-set-001'").run(JSON.stringify(altered), hashContent(altered));
  divergent.close();
  await assert.rejects(promoteReviewedBank({ source: sourceFile, target: targetFile, apply: true }), error => error.code === 'target_diverged');
  const restore = new Database(targetFile);
  restore.prepare("UPDATE question_bank_questions SET payload=?,sha256=? WHERE question_id='tutor-set-001'").run(original.payload, original.sha256);
  restore.close();
  const result = await promoteReviewedBank({ source: sourceFile, target: targetFile, apply: true });
  assert.equal(result.applied, true); assert.ok(result.backup);
  const after = new Database(targetFile, { readonly: true });
  assert.deepEqual(after.prepare('SELECT * FROM documents').all(), previousDocuments);
  assert.deepEqual(after.prepare('SELECT * FROM users').all(), previousUsers);
  assert.deepEqual(after.prepare('SELECT * FROM auth_sessions').all(), previousSessions);
  assert.equal(after.prepare('SELECT user_id FROM resource_owners WHERE kind=? AND id=?').get('imports', imported.import.importId).user_id, 'actual-admin');
  const audit = JSON.parse(after.prepare('SELECT payload FROM question_import_publications').get().payload);
  assert.equal(audit.reviewer.userId, 'qa-admin');
  assert.match(result.migrationActor.meaning, /does not claim/);
  assert.equal(after.prepare('SELECT count(*) AS n FROM question_bank_promotions').get().n, 1);
  assert.deepEqual(after.pragma('foreign_key_check'), []);
  after.close();
  active = await registerSqliteStorage(path.join(base, 'target-runtime'), targetFile, { questionBankRoot: path.resolve('.') });
  assert.equal((await getQuestion(id)).ok, true);
  active.close(); active = undefined;
  const backup = new Database(result.backup, { readonly: true });
  assert.equal(backup.prepare('SELECT 1 FROM question_bank_questions WHERE question_id=?').get(id), undefined);
  backup.close();
  const corrupt = new Database(sourceFile);
  corrupt.prepare("UPDATE question_bank_questions SET payload='{}' WHERE question_id=?").run(id);
  corrupt.close();
  await assert.rejects(promoteReviewedBank({ source: sourceFile, target: targetFile, apply: true }), error => error.code === 'integrity_error');
});
