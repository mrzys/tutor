import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAppServer } from '../src/server.mjs';

async function app(t, gateway) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tutor-intake-http-'));
  const server = createAppServer({ storeRoot: path.join(directory, 'drafts'), intakeGateway: gateway });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, value) => {
    const response = await fetch(url + route, value === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
    });
    return { status: response.status, ...await response.json() };
  };
  return { request, url };
}

test('HTTP click intake confirms real requirements and preserves model proposal until accepted', async t => {
  let calls = 0;
  const gateway = { configured: true,
    publicStatus: () => ({ configured: true, provider: 'test-fixture', model: 'fixture-model' }),
    async propose() { calls++; return { ok: true,
      proposal: { summary: '练习集合概念辨析', changes: { cognition: 'understand', priority: 'preferred' },
        blocks: [{ kind: 'single_choice', id: 'cognition-check', field: 'cognition', title: '确认认知要求',
          options: [{ id: 'understand', label: '理解与解释' }], value: 'understand' }] },
      run: { status: 'succeeded', provider: 'test-fixture', model: 'fixture-model', durationMs: 1, usage: null } }; },
  };
  const { request } = await app(t, gateway);
  const config = await request('/api/config');
  assert.deepEqual(config.config.intake, gateway.publicStatus());
  let result = await request('/api/intake', { action: 'start', operationId: randomUUID() });
  let session = result.session;
  const original = structuredClone(session.requirements);
  result = await request('/api/intake', { action: 'assist', sessionId: session.sessionId,
    revision: session.revision, operationId: randomUUID(), message: '少计算，多考概念辨析' });
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  const { teacherRequest, ...unchangedRequirements } = result.session.requirements;
  assert.equal(teacherRequest, '少计算，多考概念辨析', 'Explicit teacher words are preserved independently of pending model changes');
  assert.deepEqual(unchangedRequirements, original, 'Model proposal alone must not change structured requirements');
  assert.equal(result.session.proposal.blocks[0].kind, 'single_choice');
  session = result.session;
  result = await request('/api/intake', { action: 'answer', sessionId: session.sessionId,
    revision: session.revision, operationId: randomUUID(), acceptProposal: true });
  assert.equal(result.session.answers.cognition, 'understand');
  session = result.session;
  for (const stage of ['purpose', 'scope', 'boundary', 'size', 'goal']) {
    result = await request('/api/intake', { action: 'answer', sessionId: session.sessionId,
      revision: session.revision, operationId: randomUUID(), stage, next: true });
    assert.equal(result.ok, true, JSON.stringify(result));
    session = result.session;
  }
  result = await request('/api/intake', { action: 'confirm', sessionId: session.sessionId,
    revision: session.revision, operationId: randomUUID() });
  assert.equal(result.session.status, 'confirmed');
  const reopened = await request(`/api/intake/${session.sessionId}`);
  assert.deepEqual(reopened.session.requirements, result.session.requirements);
  assert.equal(reopened.session.assistantMessage, '少计算，多考概念辨析');
  const blueprint = await request('/api/blueprint', { requirements: result.session.requirements });
  assert.equal(blueprint.ok, true);
  assert.ok(blueprint.blueprint.supply.slotSupply.some(slot => slot.eligibleCount > 0));
});

test('HTTP intake rejects stale edits and preserves click flow when model is unavailable', async t => {
  const gateway = { configured: false, async propose() { return { ok: false,
    error: { code: 'not_configured', message: '尚未配置模型服务。' }, run: { status: 'not_configured' } }; } };
  const { request } = await app(t, gateway);
  const started = await request('/api/intake', { action: 'start' });
  const session = started.session;
  const assisted = await request('/api/intake', { action: 'assist', sessionId: session.sessionId,
    revision: session.revision, operationId: randomUUID(), message: '概念题' });
  assert.equal(assisted.session.assistantError.code, 'not_configured');
  assert.deepEqual(assisted.session.answers, session.answers);
  assert.equal((await request(`/api/intake/${session.sessionId}`)).session.assistantMessage, '概念题');
  const stale = await request('/api/intake', { action: 'answer', sessionId: session.sessionId,
    revision: session.revision, operationId: randomUUID(), next: true });
  assert.equal(stale.status, 409);
  const invalid = await request('/api/intake', { action: 'start', html: '<script></script>' });
  assert.equal(invalid.status, 400);
});

test('HTTP method suggestions have dynamic dependency context and require explicit adoption', async t => {
  let context;
  const gateway = { configured: true, async propose(input) {
    context = input;
    return { ok: true, proposal: { summary: '请确认是否允许绝对值不等式方法。', changes: { premises: ['absolute_root'] }, blocks: [
      { kind: 'multi_choice', id: 'method-http', field: 'premises', title: '额外允许使用的知识与方法',
        value: ['absolute_root'], options: [{ id: 'absolute_root', label: '绝对值不等式工具' }] },
    ] }, run: { status: 'succeeded', provider: 'fixture', model: 'fixture-only' } };
  } };
  const { request } = await app(t, gateway);
  let session = (await request('/api/intake', { action: 'start', operationId: randomUUID(), answers: { mainScope: ['1.3'] } })).session;
  for (const stage of ['purpose', 'scope']) session = (await request('/api/intake', { action: 'answer', sessionId: session.sessionId,
    revision: session.revision, operationId: randomUUID(), stage, next: true })).session;
  assert.equal(session.stage, 'boundary');
  assert.deepEqual(session.blocks.map(block => block.field), ['learnedScope']);
  const before = structuredClone(session.requirements);
  const suggested = await request('/api/intake', { action: 'suggest_methods', sessionId: session.sessionId,
    revision: session.revision, operationId: randomUUID() });
  assert.equal(suggested.status, 200);
  assert.equal(suggested.session.proposalKind, 'methods');
  assert.deepEqual(suggested.session.requirements, before);
  assert.equal(context.task, 'suggest_methods');
  assert.ok(context.methodDependencies.methods.find(method => method.id === 'absolute_root').evidenceRefs.length > 0);
  session = suggested.session;
  const adopted = await request('/api/intake', { action: 'answer', sessionId: session.sessionId,
    revision: session.revision, operationId: randomUUID(), acceptProposal: true });
  assert.equal(adopted.status, 200);
  assert.deepEqual(adopted.session.answers.premises, ['absolute_root']);
  assert.deepEqual(adopted.session.answers.learnedScope, session.answers.learnedScope);
  assert.equal(adopted.session.proposalKind, null);
});
