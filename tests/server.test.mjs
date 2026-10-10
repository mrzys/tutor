import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAppServer } from '../src/server.mjs';
import { readDraft, listDrafts, saveDraft } from '../src/assembly/store.mjs';

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

async function initialDraft(request) {
  const preview = await request('/api/blueprint', { requirements: {} });
  const saved = await request('/api/drafts', { blueprint: preview.blueprint });
  assert.equal(saved.status, 201);
  return saved.draft;
}

test('concurrent duplicate HTTP operations execute once and replay returns the newest saved draft', async t => {
  const { request, storeRoot } = await app(t);
  const draft = await initialDraft(request);
  const route = `/api/drafts/${draft.draftId}/operations`;
  const lock = { operationId: 'http-lock-once', expectedRevision: 0, type: 'lock', slotId: 'slot-1', locked: true };
  const repeated = await Promise.all([request(route, lock), request(route, lock)]);
  repeated.forEach(result => { assert.equal(result.status, 200); assert.equal(result.draft.revision, 1); });
  assert.equal((await readDraft(storeRoot, draft.draftId)).operations.length, 1);
  const changed = await request(route, { operationId: 'http-score-next', expectedRevision: 1,
    type: 'points', slotId: 'slot-8', points: 12, partPoints: [] });
  assert.equal(changed.status, 200);
  assert.equal(changed.draft.stats.availablePoints, 102);
  const replay = await request(route, lock);
  assert.equal(replay.status, 200);
  assert.equal(replay.draft.revision, 2);
  assert.equal(replay.draft.slots[7].points, 12);
  const reused = await request(route, { ...lock, locked: false });
  assert.equal(reused.status, 409);
  assert.equal(reused.error.code, 'operation_conflict');
  assert.deepEqual((await request(`/api/drafts/${draft.draftId}`)).draft, changed.draft);
});

test('competing stale HTTP edits cannot overwrite each other', async t => {
  const { request } = await app(t);
  const draft = await initialDraft(request);
  const route = `/api/drafts/${draft.draftId}/operations`;
  const commands = [12, 14].map(points => ({ operationId: `http-competing-${points}`, expectedRevision: 0,
    type: 'points', slotId: 'slot-8', points, partPoints: [] }));
  const results = await Promise.all(commands.map(command => request(route, command)));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const success = results.find(result => result.ok);
  const stale = results.find(result => !result.ok);
  assert.equal(stale.error.code, 'revision_conflict');
  const reopened = await request(`/api/drafts/${draft.draftId}`);
  assert.equal(reopened.draft.revision, 1);
  assert.deepEqual(reopened.draft, success.draft);
});

test('candidate preview is read-only and batch HTTP replacement preserves successful items and failed originals', async t => {
  const { request } = await app(t);
  const draft = await initialDraft(request);
  const base = `/api/drafts/${draft.draftId}`;
  const preview = await request(`${base}/candidates`, { slotId: 'slot-2', expectedRevision: 0 });
  assert.equal(preview.status, 200);
  assert.deepEqual((await request(base)).draft, draft);
  const result = await request(`${base}/operations`, { operationId: 'http-partial-batch', expectedRevision: 0,
    type: 'replace', slotIds: ['slot-2', 'slot-8'], mode: 'automatic' });
  assert.equal(result.status, 200);
  assert.notEqual(result.draft.slots[1].question.questionId, draft.slots[1].question.questionId);
  assert.deepEqual(result.draft.slots[7].question, draft.slots[7].question);
  assert.deepEqual(result.draft.slots[0], draft.slots[0]);
  assert.equal(result.draft.stats.availablePoints, 100);
  assert.deepEqual((await request(base)).draft, result.draft);
  assert.equal((await request(`${base}/candidates`, { slotId: 'slot-2', expectedRevision: 0 })).status, 409);
});

test('HTTP paper confirmation freezes reviewed content, recovers absent source marker and derives an editable new draft', async t => {
  const { request, storeRoot } = await app(t);
  const draft = await initialDraft(request);
  const base = `/api/drafts/${draft.draftId}`;
  const confirmation = await request(`${base}/confirmation`);
  assert.equal(confirmation.summary.student.points, 100);
  assert.equal(confirmation.summary.teacher.issues.filter(item => item.code === 'rubric_missing').length, 3);
  const payload = { operationId: 'http-confirm', expectedRevision: 0, acknowledgeDifferences: true };
  assert.equal((await request(`${base}/confirm`, { ...payload, acknowledgeDifferences: false })).status, 400);
  const confirmed = await request(`${base}/confirm`, payload);
  assert.equal(confirmed.status, 200);
  const paperBase = `/api/papers/${confirmed.paper.paperId}`;
  assert.equal((await request(base)).draft.confirmedPaperId, confirmed.paper.paperId);
  // Simulate the published-paper/source-marker crash window with a valid old draft file.
  await saveDraft(storeRoot, draft);
  assert.equal((await request(base)).draft.confirmedPaperId, confirmed.paper.paperId);
  const rejected = await request(`${base}/operations`, { operationId: 'late-edit', expectedRevision: 0,
    type: 'points', slotId: 'slot-8', points: 12, partPoints: [] });
  assert.equal(rejected.error.code, 'finalized_draft');
  assert.equal(rejected.status, 409);
  assert.deepEqual((await request(`${base}/confirm`, payload)).paper, confirmed.paper);
  assert.equal((await readDraft(storeRoot, draft.draftId)).confirmedPaperId, confirmed.paper.paperId);
  const reopened = await request(paperBase);
  assert.deepEqual(reopened.paper, confirmed.paper);
  assert.equal(reopened.outputs.student.status, 'not_generated');
  assert.equal(reopened.feedback, null);
  const derived = await request(`${paperBase}/derive`, { operationId: 'derive-http' });
  assert.notEqual(derived.draft.draftId, draft.draftId);
  const edit = await request(`/api/drafts/${derived.draft.draftId}/operations`, { operationId: 'child-score', expectedRevision: 0,
    type: 'points', slotId: 'slot-8', points: 12, partPoints: [] });
  assert.equal(edit.draft.stats.availablePoints, 102);
  assert.deepEqual((await request(paperBase)).paper, confirmed.paper);
  assert.equal((await request(`${paperBase}/derive`, { operationId: 'derive-http' })).draft.revision, 1);
});

test('isolated HTTP feedback fixture records actual operation metrics without mutating the paper', async t => {
  const { request } = await app(t);
  const draft = await initialDraft(request);
  const base = `/api/drafts/${draft.draftId}`;
  const edit = await request(`${base}/operations`, { operationId: 'replace-for-metrics', expectedRevision: 0,
    type: 'replace', slotIds: ['slot-2'], mode: 'automatic', reason: 'isolated test fixture' });
  const confirmed = await request(`${base}/confirm`, { operationId: 'feedback-fixture-confirm', expectedRevision: edit.draft.revision, acknowledgeDifferences: true });
  const paperBase = `/api/papers/${confirmed.paper.paperId}`;
  assert.equal((await request(`${paperBase}/feedback`, { willingToUse: 'invalid', reason: '', manualCorrections: '' })).status, 400);
  const fixture = { willingToUse: 'after_changes', reason: 'Automated test fixture only; no human acceptance.', manualCorrections: '' };
  const response = await request(`${paperBase}/feedback`, fixture);
  assert.equal(response.feedback.metrics.replacementCount, 1);
  assert.equal(response.feedback.metrics.replacementRequests, 1);
  const reopened = await request(paperBase);
  assert.equal(reopened.feedback.reason, fixture.reason);
  assert.deepEqual(reopened.paper, confirmed.paper);
});

test('damaged feedback does not block reopening an intact paper or its output statuses', async t => {
  const { request, storeRoot } = await app(t);
  const draft = await initialDraft(request);
  const confirmed = await request(`/api/drafts/${draft.draftId}/confirm`, {
    operationId: 'feedback-damage-confirm', expectedRevision: 0, acknowledgeDifferences: true });
  const base = `/api/papers/${confirmed.paper.paperId}`;
  await request(`${base}/feedback`, { willingToUse: 'no', reason: 'Isolated fault fixture.', manualCorrections: '' });
  await writeFile(path.join(path.dirname(storeRoot), 'feedback', `${confirmed.paper.paperId}.json`), 'broken-json');
  const reopened = await request(base);
  assert.equal(reopened.status, 200);
  assert.deepEqual(reopened.paper, confirmed.paper);
  assert.equal(reopened.outputs.student.status, 'not_generated');
  assert.equal(reopened.feedback, null);
  assert.equal(reopened.warnings[0].code, 'read_error');
});
