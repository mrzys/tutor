import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNestApp } from '../src/api/app.ts';

test('database search filters before pagination, keeps versions, saves manual drafts and survives deployment without seed files', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'tutor-db-query-'));
  const emptyRoot = path.join(base, 'empty-project');
  await mkdir(emptyRoot);
  let application;
  t.after(async () => { await application?.close(); await rm(base, { recursive: true, force: true }); });
  const options = { storeRoot: path.join(base, 'drafts'), logger: false };
  application = await createNestApp(options);
  await application.app.listen(0, '127.0.0.1');
  let url = await application.app.getUrl();
  const first = await (await fetch(`${url}/api/question-bank?page=1&pageSize=2`)).json();
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.storage, 'sqlite');
  assert.equal(first.questions.length, 2);
  assert.equal(first.pagination.total, 45);
  const second = await (await fetch(`${url}/api/question-bank?page=2&pageSize=2`)).json();
  assert.equal(second.questions.some(q => first.questions.some(a => a.questionId === q.questionId)), false);
  const sectionId = first.textbooks[0].chapters[0].sections[0].id;
  const scoped = await (await fetch(`${url}/api/question-bank?${new URLSearchParams({ sectionId, questionType: 'single_choice', pageSize: '3', query: '集合' })}`)).json();
  assert.equal(scoped.questions.length, 3);
  assert.ok(scoped.questions.every(q => q.sectionIds.includes(sectionId) && q.questionType === 'single_choice'));
  assert.doesNotMatch(JSON.stringify(scoped.questions), /"answers"|"solutions"/);
  for (const invalid of ['page=0', 'pageSize=10000', 'questionType=sql']) {
    assert.equal((await fetch(`${url}/api/question-bank?${invalid}`)).status, 400);
  }
  const literal = await (await fetch(`${url}/api/question-bank?${new URLSearchParams({ query: "%' OR 1=1 --" })}`)).json();
  assert.equal(literal.pagination.total, 0);
  const selections = [first.questions[0], second.questions[0]].map(({ questionId, contentVersion, teacherVersion }) => ({ questionId, contentVersion, teacherVersion }));
  const response = await fetch(`${url}/api/question-bank/manual-draft`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selections, title: '跨页数据库组卷' }) });
  assert.equal(response.status, 201);
  const saved = await response.json();
  assert.deepEqual(saved.draft.slots.map(s => s.question.questionId), selections.map(s => s.questionId));
  assert.equal(application.repository.list('drafts').length, 1);
  await application.close(); application = undefined;
  application = await createNestApp({ ...options, root: emptyRoot });
  await application.app.listen(0, '127.0.0.1');
  url = await application.app.getUrl();
  assert.equal((await fetch(`${url}/api/config`)).status, 200);
  const recovered = await (await fetch(`${url}/api/drafts/${saved.draft.draftId}`)).json();
  assert.deepEqual(recovered.draft, saved.draft);
  const search = await (await fetch(`${url}/api/question-bank?query=tutor-set-001&pageSize=1`)).json();
  assert.equal(search.questions[0].questionId, 'tutor-set-001');
  const history = await (await fetch(`${url}/api/drafts`)).json();
  assert.equal(history.drafts[0].title, '跨页数据库组卷');
});
