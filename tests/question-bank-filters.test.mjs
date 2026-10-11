import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listQuestionBankCatalog } from '../src/question-bank/catalog.mjs';
import { normalizePedagogyAnalysis } from '../src/question-bank/pedagogy.mjs';
import { hashContent } from '../src/question-bank/integrity.mjs';
import { registerSqliteStorage } from '../src/storage/sqlite.mjs';

test('pedagogy search labels require producer evidence, merge parts and preserve pending review', () => {
  const base = { questionId: 'tutor-set-001', sourceContext: { contentVersion: 'content-1', teacherVersion: 'teacher-1' } };
  const snapshot = normalizePedagogyAnalysis({ schemaVersion: 1, questions: [
    { ...base, observableAbilities: [{ activity: '分类讨论', evidence: 'p1' }, { activity: '未证实能力', evidence: '' }],
      coreLiteracy: { primary: '数学抽象、逻辑推理', evidence: 'p1' }, review: { status: 'approved' } },
    { ...base, observableAbilities: [{ activity: '数学运算', evidence: 'p2' }], review: { status: 'pending_review' } },
    { ...base, observableAbilities: [{ activity: '已驳回', evidence: 'error' }], review: { status: 'rejected' } },
  ] });
  assert.equal(snapshot.entries.length, 1);
  assert.deepEqual(snapshot.entries[0].abilities, ['分类讨论', '数学运算']);
  assert.deepEqual(snapshot.entries[0].literacies, ['数学抽象', '逻辑推理']);
  assert.equal(snapshot.entries[0].status, 'pending_review');
});

test('SQLite combined filters respect versions, retain unknowns and never derive difficulty from estimates', async t => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const baseRoot = await mkdtemp(path.join(os.tmpdir(), 'tutor-filter-'));
  const storage = await registerSqliteStorage(baseRoot, undefined, { questionBankRoot: root });
  t.after(async () => { storage.close(); await rm(baseRoot, { recursive: true, force: true }); });
  const repository = storage.repository;
  const initial = await listQuestionBankCatalog({ root, query: 'tutor-set-001', literacy: '数学抽象', ability: '对象确定性标准检验' });
  assert.equal(initial.ok, true, JSON.stringify(initial));
  assert.equal(initial.pagination.total, 1);
  assert.equal(initial.questions[0].questionId, 'tutor-set-001');
  assert.equal(initial.questions[0].pedagogyStatus, 'pending_review');

  const index = repository.getQuestionBankIndex();
  index.entries.find(item => item.questionId === 'tutor-set-001').difficultyEstimate = 0.95;
  index.entries.find(item => item.questionId === 'tutor-set-002').difficultyLevel = 'easy';
  repository.database.prepare("UPDATE question_bank_state SET payload=?,sha256=? WHERE kind='question_index'")
    .run(JSON.stringify(index), hashContent(index));
  const unknown = await listQuestionBankCatalog({ root, query: 'tutor-set-001', difficulty: 'unknown' });
  assert.equal(unknown.pagination.total, 1);
  assert.equal(unknown.questions[0].difficulty.estimate, 0.95);
  const easy = await listQuestionBankCatalog({ root, difficulty: 'easy' });
  assert.deepEqual(easy.questions.map(question => question.questionId), ['tutor-set-002']);

  const snapshot = repository.getQuestionBankPedagogy();
  snapshot.entries.find(item => item.questionId === 'tutor-set-001').teacherVersion = 'teacher-stale';
  repository.database.prepare("UPDATE question_bank_pedagogy SET payload=?,sha256=? WHERE kind='analysis'")
    .run(JSON.stringify(snapshot), hashContent(snapshot));
  const stale = await listQuestionBankCatalog({ root, query: 'tutor-set-001', ability: '对象确定性标准检验' });
  assert.equal(stale.pagination.total, 0);
  const retained = await listQuestionBankCatalog({ root, query: 'tutor-set-001', ability: 'unknown' });
  assert.equal(retained.pagination.total, 1);
  assert.equal(retained.questions[0].pedagogyStatus, 'unknown');

  repository.database.prepare("UPDATE question_bank_pedagogy SET payload='{}' WHERE kind='analysis'").run();
  assert.equal((await listQuestionBankCatalog({ root, ability: 'unknown' })).error.code, 'integrity_error');
});
