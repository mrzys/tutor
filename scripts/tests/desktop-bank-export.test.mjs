import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportDesktopBank } from '../export-desktop-bank.mjs';
import { hashContent } from '../lib/integrity.mjs';

async function simulatedFixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tutor-desktop-export-simulated-'));
  const filename = path.join(root, 'legacy.sqlite');
  const database = new DatabaseSync(filename);
  for (const table of ['question_bank_state', 'question_bank_config', 'question_bank_questions', 'question_bank_chapters'])
    database.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,kind TEXT,question_id TEXT,chapter_id TEXT,position INTEGER,payload TEXT,sha256 TEXT)`);
  database.exec('CREATE TABLE users(email TEXT,password_hash TEXT); CREATE TABLE papers(payload TEXT);');
  database.prepare('INSERT INTO users VALUES(?,?)').run('PRIVATE-ACCOUNT@example.invalid', 'PRIVATE-PASSWORD-HASH');
  database.prepare('INSERT INTO papers VALUES(?)').run('PRIVATE-PAPER');
  const put = (table, key, value, extra = {}) => database.prepare(`INSERT INTO ${table}(id,kind,question_id,chapter_id,position,payload,sha256) VALUES(?,?,?,?,?,?,?)`)
    .run(key, extra.kind ?? null, extra.question_id ?? null, extra.chapter_id ?? null, extra.position ?? null, JSON.stringify(value), hashContent(value));
  const student = { stem: '模拟题 $1+1=$', options: [], parts: [], assets: [] };
  const teacher = { answers: [{ text: '2' }], solutions: [], scoringSuggestions: [] };
  const contentSha256 = hashContent(student), teacherSha256 = hashContent(teacher);
  const ready = { schemaVersion: 1, questionId: 'sim-ready', questionType: 'fill_blank', student, teacher,
    contentSha256, teacherSha256, contentVersion: `content-${contentSha256.slice(0, 16)}`, teacherVersion: `teacher-${teacherSha256.slice(0, 16)}` };
  ready.verification = { result: 'pass', contentVersion: ready.contentVersion, teacherVersion: ready.teacherVersion };
  const pending = { ...ready, questionId: 'sim-pending', verification: { ...ready.verification, result: 'pending' } };
  put('question_bank_questions', ready.questionId, ready, { question_id: ready.questionId });
  put('question_bank_questions', pending.questionId, pending, { question_id: pending.questionId });
  const ledger = { schemaVersion: 1, entries: [
    { questionId: ready.questionId, status: 'ready', pendingReasons: [] },
    { questionId: pending.questionId, status: 'pending', pendingReasons: ['模拟待审核'] },
    { questionId: 'sim-no-content', status: 'pending', pendingReasons: ['模拟内容缺失'] },
  ] };
  put('question_bank_state', 'ledger', ledger, { kind: 'ledger' });
  put('question_bank_state', 'question_index', { entries: [] }, { kind: 'question_index' });
  put('question_bank_config', 'task_catalog', { schemaVersion: 1, tasks: [], chapters: [] }, { kind: 'task_catalog' });
  put('question_bank_config', 'course_context', { schemaVersion: 1 }, { kind: 'course_context' });
  put('question_bank_config', 'source_manifest', { schemaVersion: 1, sources: [{ sourceId: 'sim-source', path: 'sim.pdf' }] }, { kind: 'source_manifest' });
  put('question_bank_chapters', 'sim-section', { id: '1.1', label: '模拟范围' }, { chapter_id: 'sim-section', position: 1 });
  const options = { database: filename, root, baseline: { config: { schemaVersion: 1 } }, migrationId: 'sim-migration' };
  try { await run({ database, filename, options, put, ready, ledger }); }
  finally { database.close(); await rm(root, { recursive: true, force: true }); }
}

test('simulated export preserves every shared row and pending state, excludes all private data, leaves source bytes unchanged', async () => {
  await simulatedFixture(async ({ filename, options }) => {
    const before = await readFile(filename);
    const seed = await exportDesktopBank(options);
    assert.deepEqual(seed.bankSnapshot.counts, { ready: 1, pending: 2, questionRows: 2, sourceUnits: 3 });
    assert.deepEqual(seed.questions.map(q => q.questionId), ['sim-ready']);
    assert.equal(seed.bankSnapshot.questions.length, 2);
    assert.equal(seed.bankSnapshot.ledger.entries[1].status, 'pending');
    assert.equal(seed.migration.manifestSha256, hashContent({ config: seed.config, questions: seed.questions, bankSnapshot: seed.bankSnapshot }));
    assert.equal(JSON.stringify(seed).includes('PRIVATE-'), false);
    assert.deepEqual(await readFile(filename), before);
  });
});

test('simulated export rejects source row corruption instead of packaging it', async () => {
  await simulatedFixture(async ({ database, options }) => {
    database.prepare("UPDATE question_bank_questions SET payload='{}' WHERE question_id='sim-ready'").run();
    await assert.rejects(exportDesktopBank(options), /hash mismatch/);
  });
});

test('simulated export refuses to promote pending content through a ready ledger entry', async () => {
  await simulatedFixture(async ({ options, ledger, put }) => {
    const database = new DatabaseSync(options.database);
    ledger.entries[1].status = 'ready';
    database.prepare("UPDATE question_bank_state SET payload=?,sha256=? WHERE kind='ledger'").run(JSON.stringify(ledger), hashContent(ledger));
    database.close();
    await assert.rejects(exportDesktopBank(options), /not verified/);
  });
});

test('simulated export rejects missing ready content and never invents a question', async () => {
  await simulatedFixture(async ({ options, ledger }) => {
    const database = new DatabaseSync(options.database);
    ledger.entries[2].status = 'ready';
    database.prepare("UPDATE question_bank_state SET payload=?,sha256=? WHERE kind='ledger'").run(JSON.stringify(ledger), hashContent(ledger));
    database.close();
    await assert.rejects(exportDesktopBank(options), /missing ready content/);
  });
});
