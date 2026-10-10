import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAppServer } from '../src/server.mjs';
import { readDraft, listDrafts } from '../src/assembly/store.mjs';

async function app(t, blockedStore = false) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'tutor-s302-http-'));
  const storeRoot = path.join(temp, 'drafts');
  if (blockedStore) await writeFile(storeRoot, 'This is a file, not a writable draft directory.');
  const server = createAppServer({ storeRoot });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, input) => {
    const response = await fetch(`${url}${route}`, input === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    });
    return { status: response.status, ...await response.json() };
  };
  return { request, url, storeRoot };
}

test('HTTP confirmation saves real selected contents and reopening preserves exact draft', async t => {
  const { request, storeRoot } = await app(t);
  const config = await request('/api/config');
  assert.equal(config.ok, true);
  assert.deepEqual(config.config.supply, { sourceUnits: 50, ready: 18, pending: 32 });
  const preview = await request('/api/blueprint', { requirements: config.config.defaultRequirements });
  assert.equal(preview.ok, true);
  assert.equal((await listDrafts(storeRoot)).drafts.length, 0, 'Preview must not save a draft');
  const result = await request('/api/drafts', { blueprint: preview.blueprint });
  assert.equal(result.status, 201);
  assert.equal(result.draft.stats.selectedQuestions, 10);
  assert.equal(result.draft.stats.availablePoints, 100);
  assert.deepEqual(await readDraft(storeRoot, result.draft.draftId), result.draft);
  const reopened = await request(`/api/drafts/${result.draft.draftId}`);
  assert.deepEqual(reopened.draft, result.draft);
  assert.equal((await request('/api/drafts')).drafts.length, 1);
});

test('HTTP reports missing supply without lowering scope, and edited blueprint can recheck', async t => {
  const { request } = await app(t);
  const config = await request('/api/config');
  const requirements = { ...config.config.defaultRequirements,
    premises: config.config.defaultRequirements.premises.filter(id => id !== 'vieta') };
  const preview = await request('/api/blueprint', { requirements });
  preview.blueprint.slots[0].points = 12;
  const rechecked = await request('/api/blueprint/recheck', { blueprint: preview.blueprint });
  assert.equal(rechecked.blueprint.slots[0].points, 12);
  const result = await request('/api/drafts', { blueprint: rechecked.blueprint });
  assert.equal(result.ok, true);
  assert.equal(result.draft.stats.selectedQuestions, 9);
  assert.equal(result.draft.stats.plannedPoints, 104);
  assert.equal(result.draft.stats.availablePoints, 94);
  assert.equal(result.draft.slots[7].status, 'empty');
  assert.equal(result.draft.slots[7].number, 8);
  assert.equal(result.draft.slots[7].question, null);
  assert.ok(result.draft.differences.some(item => item.code === 'planned_score_differs'));
});

test('API rejects malformed plans and unrelated origins; no success on save failure', async t => {
  const { request, url, storeRoot } = await app(t, true);
  assert.equal((await request('/api/drafts', { blueprint: 'bad' })).status, 400);
  assert.equal((await request('/api/drafts/not-a-uuid')).status, 404);
  const response = await fetch(`${url}/api/blueprint`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://unrelated.example' },
    body: '{}',
  });
  assert.equal(response.status, 403);
  // Bootstrap includes stored drafts and correctly fails for an unreadable store.
  assert.equal((await request('/api/config')).status, 500);
  const preview = await request('/api/blueprint', { requirements: {} });
  const saved = await request('/api/drafts', { blueprint: preview.blueprint });
  assert.equal(saved.ok, false);
  assert.equal(saved.status, 500);
  assert.equal(saved.error.code, 'save_error');
  assert.equal(await readFile(storeRoot, 'utf8'), 'This is a file, not a writable draft directory.');
});

test('damaged saved draft never silently reselects current bank contents', async t => {
  const { request, storeRoot } = await app(t);
  const preview = await request('/api/blueprint', { requirements: {} });
  const saved = await request('/api/drafts', { blueprint: preview.blueprint });
  const filename = path.join(storeRoot, `${saved.draft.draftId}.json`);
  const data = JSON.parse(await readFile(filename, 'utf8'));
  data.draft.slots[0].points = 99;
  await writeFile(filename, JSON.stringify(data));
  const reopened = await request(`/api/drafts/${saved.draft.draftId}`);
  assert.equal(reopened.ok, false);
  assert.equal(reopened.error.code, 'integrity_error');
  const listed = await request('/api/drafts');
  assert.equal(listed.drafts.length, 0);
  assert.equal(listed.warnings[0].code, 'integrity_error');
});
