import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { previewBlueprint, recheckBlueprint, createDraft, loadPool, slotCandidates } from '../src/assembly/engine.mjs';
import { proposeAssemblyAdjustment } from '../src/assembly/assistant.mjs';
import { saveDraft, readDraft, listDrafts } from '../src/assembly/store.mjs';
import { createAssistantGateway } from '../src/llm/assistant-gateway.mjs';
import { createIntakeService } from '../src/intake/service.mjs';
import { createAppServer } from '../src/server.mjs';

const ready = actions => ({ status: 'ready', summary: '建议按本轮要求调整，等待确认。', clarification: null, actions });
const clarify = { status: 'clarify', summary: '当前题库实际难度未标定。', clarification: '请明确要调整的题号与目标；实际难度尚未标定，不能保证换题更难。', actions: [] };
const fixtureGateway = output => ({ publicStatus: () => ({ configured: true, model: 'fixture' }), async propose(context, { validate }) {
  return { ok: true, proposal: validate(typeof output === 'function' ? output(context) : output), run: { status: 'succeeded' } };
} });
const blueprintInput = async message => ({ stage: 'blueprint', message, blueprint: (await previewBlueprint({ premises: [] })).blueprint });
async function draftFixture() {
  const storeRoot = path.join(await mkdtemp(path.join(os.tmpdir(), 'tutor-assistant-')), 'drafts');
  const draft = (await createDraft((await previewBlueprint()).blueprint)).draft;
  await saveDraft(storeRoot, draft);
  return { storeRoot, draft, input: message => ({ stage: 'draft', message, draftId: draft.draftId, expectedRevision: draft.revision ?? 0 }) };
}

test('blueprint conversation proposes additions, removals, task changes and counts without changing the plan', async () => {
  const input = await blueprintInput('删除第2题，在第3题后新增2道判断集合的单选题，将第1题改成常用数集判断。');
  const before = JSON.stringify(input.blueprint);
  const actions = [{ type: 'delete', numbers: [2] }, { type: 'add', taskId: 'set_determinacy', count: 2, afterNumber: 3 },
    { type: 'set_task', numbers: [1], taskId: 'number_membership' }];
  const result = await proposeAssemblyAdjustment(input, { gateway: fixtureGateway(ready(actions)) });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.proposal.actions, actions);
  assert.match(result.base.blueprintHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(input.blueprint), before);
  const counts = { single_choice: 4, fill_blank: 2, free_response: 0 };
  const resized = await proposeAssemblyAdjustment(await blueprintInput('改成4道单选、2道填空，不要解答题。'), { gateway: fixtureGateway(ready([{ type: 'set_counts', counts }])) });
  assert.equal(resized.ok, true, JSON.stringify(resized));
  assert.deepEqual(resized.proposal.actions[0].counts, counts);
});

test('draft proposals retain exact persisted contents and revision until a separate confirmed edit', async () => {
  const f = await draftFixture();
  const before = await readFile(path.join(f.storeRoot, `${f.draft.draftId}.json`), 'utf8');
  for (const [message, action] of [
    ['换第1题', { type: 'replace', numbers: [1] }],
    ['第2题目标难度改为0.6', { type: 'difficulty', numbers: [2], targetDifficulty: 0.6 }],
    ['删除第十题', { type: 'delete', numbers: [10] }],
    ['最后新增2道判断集合的单选题', { type: 'add', taskId: 'set_determinacy', count: 2, afterNumber: null }],
  ]) {
    const result = await proposeAssemblyAdjustment(f.input(message), { storeRoot: f.storeRoot, gateway: fixtureGateway(ready([action])) });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.base.revision, f.draft.revision ?? 0);
    assert.deepEqual(result.proposal.actions, [action]);
    assert.equal(await readFile(path.join(f.storeRoot, `${f.draft.draftId}.json`), 'utf8'), before);
  }
  assert.equal((await listDrafts(f.storeRoot)).drafts.length, 1);
});

test('ambiguous references and uncalibrated harder requests clarify without any ready actions', async () => {
  const f = await draftFixture();
  const result = await proposeAssemblyAdjustment(f.input('换一道更难的题'), { storeRoot: f.storeRoot, gateway: fixtureGateway(clarify) });
  assert.equal(result.ok, true);
  assert.equal(result.proposal.status, 'clarify');
  assert.deepEqual(result.proposal.actions, []);
  assert.match(result.proposal.clarification, /未标定/);
  for (const message of ['换一题', '第1题换成更考查核心素养的', '第1题换成数学抽象题', '第1题换一道难一点的']) {
    const rejected = await proposeAssemblyAdjustment(f.input(message), { storeRoot: f.storeRoot, gateway: fixtureGateway(ready([{ type: 'replace', numbers: [1] }])) });
    assert.equal(rejected.ok, false, message);
    assert.equal(rejected.error.code, 'invalid_model_output');
  }
});

test('model identities, precise targets, stage and conflicting edits are enforced locally', async () => {
  const cases = [
    ['删除第1题', [{ type: 'delete', numbers: [60] }]],
    ['删除第1题', [{ type: 'delete', numbers: [1, 1] }]],
    ['删除第1到3题', [{ type: 'delete', numbers: [1, 2] }, { type: 'delete', numbers: [2, 3] }]],
    ['删除第1题', [{ type: 'delete', numbers: [1] }, { type: 'set_task', numbers: [1], taskId: 'number_membership' }]],
    ['第1题换题', [{ type: 'replace', numbers: [1] }]],
    ['第1题改为填空', [{ type: 'set_task', numbers: [1], taskId: 'complement_quadratic_coefficients' }]],
    ['第1题换任务', [{ type: 'set_task', numbers: [1], taskId: 'invented' }]],
    ['第1题难一点', [{ type: 'difficulty', numbers: [1], targetDifficulty: 0.6 }]],
    ['新增题位', [{ type: 'add', taskId: 'set_determinacy', count: 2, afterNumber: 1 }]],
    ['新增100题', [{ type: 'add', taskId: 'set_determinacy', count: 30, afterNumber: null }, { type: 'add', taskId: 'number_membership', count: 30, afterNumber: null }]],
    ['允许韦达定理', [{ type: 'allow_premise', premiseId: 'invented' }]],
    ['多出几道题', [{ type: 'allow_premise', premiseId: 'vieta' }]],
    ['是否允许韦达定理？', [{ type: 'allow_premise', premiseId: 'vieta' }]],
  ];
  for (const [message, actions] of cases) {
    const result = await proposeAssemblyAdjustment(await blueprintInput(message), { gateway: fixtureGateway(ready(actions)) });
    assert.equal(result.ok, false, `${message}: ${JSON.stringify(actions)}`);
    assert.equal(result.error.code, 'invalid_model_output');
  }
  const explicit = await proposeAssemblyAdjustment(await blueprintInput('允许使用韦达定理'), { gateway: fixtureGateway(ready([{ type: 'allow_premise', premiseId: 'vieta' }])) });
  assert.equal(explicit.ok, true, JSON.stringify(explicit));
  assert.deepEqual(explicit.proposal.actions, [{ type: 'allow_premise', premiseId: 'vieta' }]);
});

test('difficulty and current visible number ranges survive blueprint recheck', async () => {
  const input = await blueprintInput('第1到3题的目标难度设为0.6');
  const result = await proposeAssemblyAdjustment(input, { gateway: fixtureGateway(ready([{ type: 'difficulty', numbers: [1, 2, 3], targetDifficulty: 0.6 }])) });
  assert.equal(result.ok, true, JSON.stringify(result));
  input.blueprint.slots[0].targetDifficulty = 0.6;
  const checked = await recheckBlueprint(input.blueprint);
  assert.equal(checked.ok, true);
  assert.equal(checked.blueprint.slots[0].targetDifficulty, 0.6);
});

test('stale drafts and drafts changed during generation cannot present an applicable proposal', async () => {
  const f = await draftFixture(); let calls = 0;
  const stale = await proposeAssemblyAdjustment({ ...f.input('换第1题'), expectedRevision: 9 }, { storeRoot: f.storeRoot, gateway: { async propose() { calls++; } } });
  assert.equal(stale.error.code, 'revision_conflict'); assert.equal(calls, 0);
  const changed = await proposeAssemblyAdjustment(f.input('换第1题'), { storeRoot: f.storeRoot, gateway: { async propose() {
    const latest = await readDraft(f.storeRoot, f.draft.draftId); latest.revision = (latest.revision ?? 0) + 1;
    await saveDraft(f.storeRoot, latest);
    return { ok: true, proposal: ready([{ type: 'replace', numbers: [1] }]) };
  } } });
  assert.equal(changed.error.code, 'revision_conflict');
});

test('assistant model repairs an unsafe semantic replacement once, retaining unknown difficulty and proposal-only instructions', async () => {
  const f = await draftFixture(); let calls = 0;
  const gateway = createAssistantGateway({ env: { LLM_BASE_URL: 'https://fixture.invalid/v1', LLM_API_KEY: 'fixture-key', LLM_MODEL: 'fixture' }, generate: async input => {
    calls++;
    assert.match(input.system, /不执行、不保存/);
    assert.match(input.system, /实际难度未标定/);
    if (calls === 2) assert.match(input.prompt, /schemaCorrection/);
    return { output: calls === 1 ? ready([{ type: 'replace', numbers: [1] }]) : clarify };
  } });
  const result = await proposeAssemblyAdjustment(f.input('第1题换一道更难的'), { storeRoot: f.storeRoot, gateway });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.proposal.status, 'clarify'); assert.equal(calls, 2);
  assert.equal(result.llmRun.attempts[0].status, 'invalid_model_output');
  assert.equal((await readDraft(f.storeRoot, f.draft.draftId)).revision, f.draft.revision);
});

test('cancelled assistant requests cannot return applicable actions even if a gateway ignores cancellation', async () => {
  const f = await draftFixture();
  const controller = new AbortController(); let calls = 0;
  const gateway = { async propose() { calls++; controller.abort(); return { ok: true, proposal: ready([{ type: 'replace', numbers: [1] }]) }; } };
  const result = await proposeAssemblyAdjustment(f.input('换第1题'), { storeRoot: f.storeRoot, gateway, signal: controller.signal });
  assert.equal(result.error.code, 'cancelled'); assert.equal(calls, 1);
  const preAborted = await proposeAssemblyAdjustment(f.input('换第1题'), { storeRoot: f.storeRoot, gateway, signal: controller.signal });
  assert.equal(preAborted.error.code, 'cancelled'); assert.equal(calls, 1);
  assert.equal((await readDraft(f.storeRoot, f.draft.draftId)).revision, f.draft.revision);
});

test('quick flow automatically allows junior foundations while keeping Vieta explicit and legacy boundaries intact', async () => {
  const service = createIntakeService();
  const started = await service.handle({ action: 'start', flow: 'quick', operationId: 'foundation-start' });
  assert.equal(started.ok, true, JSON.stringify(started));
  const requirements = started.session.requirements;
  assert.deepEqual(requirements.premises, []);
  assert.equal(requirements.automaticFoundation, true);
  assert.deepEqual(requirements.foundationPremises, ['quadratic_basics', 'absolute_root', 'basic_geometry']);
  const pool = await loadPool(fileURLToPath(new URL('../', import.meta.url)));
  const candidates = taskId => slotCandidates(pool, { taskId, questionType: 'single_choice', goalIds: [] }, requirements);
  assert.ok(candidates('distinct_lengths_quadrilateral').some(item => item.status === 'eligible'));
  const fill = slotCandidates(pool, { taskId: 'complement_quadratic_coefficients', questionType: 'fill_blank', goalIds: [] }, requirements);
  assert.equal(fill.filter(item => item.status === 'eligible').length, 0);
  assert.ok(fill.some(item => item.status === 'unknown'));
  const old = (await previewBlueprint({ premises: [] })).blueprint.requirements;
  assert.equal(old.automaticFoundation, undefined);
  assert.equal(old.foundationPremises, undefined);
  const tampered = (await previewBlueprint({ ...requirements, foundationPremises: ['vieta'] })).blueprint.requirements;
  assert.equal(tampered.foundationPremises.includes('vieta'), false);
});

test('HTTP assistant route exposes model status and returns read-only proposals with revision conflicts', async t => {
  const f = await draftFixture();
  const server = createAppServer({ storeRoot: f.storeRoot, assistantGateway: fixtureGateway(ready([{ type: 'replace', numbers: [1] }])) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const config = await (await fetch(`${url}/api/config`)).json();
  assert.equal(config.config.assemblyAssistant.configured, true);
  const post = input => fetch(`${url}/api/assistant/propose`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const response = await post(f.input('换第1题'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.proposal.status, 'ready');
  assert.equal((await readDraft(f.storeRoot, f.draft.draftId)).revision, f.draft.revision);
  assert.equal((await post({ ...f.input('换第1题'), expectedRevision: 99 })).status, 409);
  assert.equal((await post({ ...f.input('换第1题'), arbitraryCode: 'not allowed' })).status, 400);
});
