import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAppServer } from '../src/server.mjs';
import { previewBlueprint } from '../src/assembly/engine.mjs';
import { listDrafts } from '../src/assembly/store.mjs';

async function app(t, gateway) {
  const storeRoot = path.join(await mkdtemp(path.join(os.tmpdir(), 'tutor-ai-blueprint-http-')), 'drafts');
  const server = createAppServer({ storeRoot, blueprintGateway: gateway });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, input, options = {}) => {
    const response = await fetch(`${url}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input), ...options });
    return { status: response.status, ...await response.json() };
  };
  return { url, post, storeRoot };
}

const status = () => ({ configured: true, provider: 'fixture', model: 'fixture-blueprint' });

test('AI blueprint HTTP proposal does not save until teacher confirms selection', async t => {
  let calls = 0;
  const gateway = { publicStatus: status, async propose(context) {
    calls++;
    const result = await previewBlueprint(context.requirements);
    return { ok: true, proposal: { summary: '测试夹具：固定需求规划', slots: result.blueprint.slots.map(slot => ({
      taskId: slot.taskId, points: slot.points, goalIds: slot.goalIds, rationale: '测试夹具的考查理由',
    })) }, run: { status: 'succeeded', model: 'fixture-blueprint', durationMs: 1 } };
  } };
  const { post, url, storeRoot } = await app(t, gateway);
  const { config } = await (await fetch(`${url}/api/config`)).json();
  assert.deepEqual(config.blueprintPlanner, status());
  const result = await post('/api/blueprint/plan', { requirements: config.defaultRequirements, countPolicy: 'fixed' });
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.blueprint.generation.mode, 'llm');
  assert.equal(calls, 1);
  assert.equal((await listDrafts(storeRoot)).drafts.length, 0);
  const draft = await post('/api/drafts', { blueprint: result.blueprint, selectionMode: 'rule' });
  assert.equal(draft.status, 201);
  assert.equal(draft.draft.baseline.generation.llmRun.model, 'fixture-blueprint');
});

test('AI blueprint failures remain explicit; preset requires a separate request', async t => {
  let calls = 0;
  const { post, storeRoot } = await app(t, { publicStatus: status, async propose() {
    calls++; return { ok: false, error: { code: 'timeout', message: '测试超时' }, run: { status: 'timeout' } };
  } });
  const rejected = await post('/api/blueprint/plan', { countPolicy: 'invented' });
  assert.equal(rejected.status, 400);
  assert.equal(calls, 0);
  const failed = await post('/api/blueprint/plan', {});
  assert.equal(failed.status, 503);
  assert.equal(failed.error.code, 'timeout');
  assert.equal(failed.blueprint, undefined);
  assert.equal((await listDrafts(storeRoot)).drafts.length, 0);
  const preset = await post('/api/blueprint', {});
  assert.equal(preset.status, 200);
  assert.equal(preset.blueprint.generation.mode, 'visible_preset');
  assert.equal(calls, 1, 'Preset never calls the model');
});

test('disconnecting AI planning cancels its gateway without saving a draft', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let aborted;
  const stopped = new Promise(resolve => { aborted = resolve; });
  const { post, storeRoot } = await app(t, { publicStatus: status, async propose(context, { signal }) {
    started();
    await new Promise(resolve => signal.addEventListener('abort', () => { aborted(); resolve(); }, { once: true }));
    return { ok: false, error: { code: 'cancelled', message: '已取消' } };
  } });
  const controller = new AbortController();
  const pending = post('/api/blueprint/plan', {}, { signal: controller.signal });
  await ready;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await stopped;
  assert.equal((await listDrafts(storeRoot)).drafts.length, 0);
});
