import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAppServer } from '../src/server.mjs';
import { readDraft } from '../src/assembly/store.mjs';

test('HTTP question bank creates and saves only the exact manual selection', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'tutor-question-bank-http-'));
  const storeRoot = path.join(temp, 'drafts');
  const server = createAppServer({ storeRoot });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(temp, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const catalogResponse = await fetch(`${base}/api/question-bank`);
  const catalog = await catalogResponse.json();
  assert.equal(catalogResponse.status, 200);
  const chosen = [catalog.questions[2], catalog.questions[0]].map(question => ({
    questionId: question.questionId, contentVersion: question.contentVersion, teacherVersion: question.teacherVersion,
  }));
  const createdResponse = await fetch(`${base}/api/question-bank/manual-draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'HTTP 手动卷', selections: chosen }) });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 201, JSON.stringify(created));
  assert.deepEqual(created.draft.slots.map(slot => slot.question.questionId), chosen.map(item => item.questionId));
  assert.deepEqual(await readDraft(storeRoot, created.draft.draftId), created.draft);
  const staleResponse = await fetch(`${base}/api/question-bank/manual-draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selections: [{ ...chosen[0], teacherVersion: 'teacher-stale' }] }) });
  assert.equal(staleResponse.status, 409);
  assert.equal((await staleResponse.json()).error.code, 'version_conflict');
});
