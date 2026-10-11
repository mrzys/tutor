import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAppServer } from '../src/server.mjs';
import { previewBlueprint } from '../src/assembly/engine.mjs';
import { listDrafts, readDraft } from '../src/assembly/store.mjs';

const publicStatus = () => ({ configured: true, model: 'fixture-selector', provider: 'fixture' });

async function app(t, gateway) {
  const storeRoot = path.join(await mkdtemp(path.join(os.tmpdir(), 'tutor-selection-http-')), 'drafts');
  const server = createAppServer({ storeRoot, selectionGateway: gateway });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = async (input, options = {}) => {
    const response = await fetch(`${url}/api/drafts`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input), ...options });
    return { status: response.status, ...await response.json() };
  };
  const result = await previewBlueprint({ counts: { single_choice: 2, fill_blank: 0, free_response: 0 }, targetScore: 20 });
  assert.equal(result.ok, true);
  const blueprint = { ...result.blueprint, generation: { mode: 'llm', summary: '测试蓝图' } };
  return { post, url, storeRoot, blueprint };
}

test('confirmed AI blueprint compares candidates before saving an auditable draft', async t => {
  let calls = 0;
  const { post, blueprint, storeRoot, url } = await app(t, { publicStatus, async propose(context) {
    calls++;
    return { ok: true, proposal: { summary: '按题面和教学目标比较候选后组合', rankings: context.slots.map(slot => ({
      slotId: slot.slotId,
      candidates: [...slot.candidates].reverse().map(id => {
        const candidate = context.candidates.find(item => item.questionId === id);
        assert.ok(candidate.evidence['student.stem']);
        return { questionId: id, contentVersion: candidate.contentVersion, teacherVersion: candidate.teacherVersion,
          rationale: '题面直接呈现本题位的概念辨析或运算活动。', evidenceRefs: ['student.stem'] };
      }),
    })) }, run: { status: 'succeeded', model: 'fixture-selector', durationMs: 1 } };
  } });
  const configuration = await (await fetch(`${url}/api/config`)).json();
  assert.deepEqual(configuration.config.candidateSelector, publicStatus());
  assert.equal((await listDrafts(storeRoot)).drafts.length, 0);
  const result = await post({ blueprint });
  assert.equal(result.status, 201, JSON.stringify(result));
  assert.equal(calls, 1);
  assert.equal(result.draft.selectionGeneration.mode, 'llm');
  assert.equal(result.draft.selectionGeneration.run.model, 'fixture-selector');
  assert.equal(result.draft.stats.selectedQuestions, 2);
  assert.ok(result.draft.slots.every(slot => slot.selection.selectedReason.method === 'llm_candidate_ranking_global_assignment'));
  assert.deepEqual(await readDraft(storeRoot, result.draft.draftId), result.draft);
});

test('AI draft failure is explicit and saves nothing; rule fallback requires a separate teacher request', async t => {
  let calls = 0;
  const { post, storeRoot, blueprint } = await app(t, { publicStatus, async propose() {
    calls++; return { ok: false, error: { code: 'timeout', message: '候选比较超时' }, run: { status: 'timeout' } };
  } });
  const failed = await post({ blueprint });
  assert.equal(failed.status, 503, JSON.stringify(failed));
  assert.equal(failed.error.code, 'timeout');
  assert.equal(failed.draft, undefined);
  assert.equal(calls, 1);
  assert.equal((await listDrafts(storeRoot)).drafts.length, 0);
  const fallback = await post({ blueprint, selectionMode: 'rule' });
  assert.equal(fallback.status, 201, JSON.stringify(fallback));
  assert.equal(fallback.draft.stats.selectedQuestions, 2);
  assert.equal(calls, 1, 'Explicit rule request must not call the model');
  assert.deepEqual(await readDraft(storeRoot, fallback.draft.draftId), fallback.draft);
});

test('preset selection stays rule-based and rejects invalid explicit selection mode', async t => {
  let calls = 0;
  const { post, blueprint } = await app(t, { publicStatus, async propose() { calls++; throw new Error('Model should not run'); } });
  const invalid = await post({ blueprint, selectionMode: 'silently_fallback' });
  assert.equal(invalid.status, 400);
  const preset = { ...blueprint, generation: { mode: 'visible_preset' } };
  const result = await post({ blueprint: preset });
  assert.equal(result.status, 201);
  assert.equal(calls, 0);
});

test('disconnecting candidate comparison propagates cancellation and never saves its late success', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let aborted;
  const stopped = new Promise(resolve => { aborted = resolve; });
  const { post, blueprint, storeRoot } = await app(t, { publicStatus, async propose(context, { signal }) {
    started();
    await new Promise(resolve => signal.addEventListener('abort', () => { aborted(); resolve(); }, { once: true }));
    // A provider may settle after cancellation; the HTTP boundary must still refuse to persist.
    return { ok: true, proposal: { summary: '迟到的结果', rankings: [] }, run: { status: 'succeeded' } };
  } });
  const controller = new AbortController();
  const pending = post({ blueprint }, { signal: controller.signal });
  await ready;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await stopped;
  assert.equal((await listDrafts(storeRoot)).drafts.length, 0);
});
