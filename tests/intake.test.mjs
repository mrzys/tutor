import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntakeService } from '../src/intake/service.mjs';
import { createMemoryIntakeStorage } from '../src/intake/storage.mjs';
import { createLlmGateway } from '../src/llm/gateway.mjs';
import { previewBlueprint } from '../src/assembly/engine.mjs';

// This gateway is a deterministic test fixture, never a simulated production model.
const fixtureGateway = proposal => ({ configured: true, async propose() { return { ok: true, proposal,
  run: { provider: 'fixture', model: 'fixture-only', status: 'succeeded', usage: null } }; } });
let sequence = 0;
async function start(service, patch = {}) {
  const result = await service.handle({ action: 'start', operationId: `start-${++sequence}`, ...patch });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.session;
}
async function answer(service, session, patch = {}) {
  return service.handle({ action: 'answer', sessionId: session.sessionId, revision: session.revision, operationId: `answer-${++sequence}`, ...patch });
}
async function advance(service, session, patch = {}) {
  const result = await answer(service, session, { next: true, ...patch });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.session;
}
async function complete(service, session) {
  for (let i = 0; i < 5; i++) session = await advance(service, session);
  const confirmed = await service.handle({ action: 'confirm', sessionId: session.sessionId, revision: session.revision, operationId: `confirm-${++sequence}` });
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
  return confirmed.session;
}

test('click-only intake confirms a normalized assembly contract and can be restored', async () => {
  const storage = createMemoryIntakeStorage();
  const service = createIntakeService({ storage, gateway: createLlmGateway({ env: {} }) });
  let session = await start(service);
  assert.equal(session.stage, 'purpose');
  assert.equal(session.blocks[0].kind, 'single_choice');
  assert.equal(session.answers.priority, 'preferred');
  assert.deepEqual(session.answers.premises, []);
  assert.equal(session.answers.size, 'recommend');
  assert.deepEqual(session.planning, { countPolicy: 'suggested' });
  session = await complete(service, session);
  assert.equal(session.status, 'confirmed');
  assert.deepEqual(session.requirements.counts, { single_choice: 6, fill_blank: 2, free_response: 2 });
  assert.equal(session.summary.questionCount, 10);
  assert.deepEqual(session.requirements.teachingGoals, []);
  const restored = await createIntakeService({ storage }).get(session.sessionId);
  assert.deepEqual(restored.session, session);
  const blueprint = await previewBlueprint(session.requirements);
  assert.equal(blueprint.ok, true);
  assert.equal(blueprint.blueprint.plannedStats.questionCount, 10);
  assert.equal(blueprint.blueprint.plannedStats.points, 100);
  assert.equal((await answer(service, session, { answers: { targetScore: 90 } })).error.code, 'already_confirmed');
});

test('editing one confirmed goal preserves unrelated confirmations and the original session', async () => {
  const service = createIntakeService();
  const original = await complete(service, await start(service, { answers: { cognition: 'apply' } }));
  const input = { action: 'revise', sessionId: original.sessionId, revision: original.revision, stage: 'goal', operationId: `revise-${++sequence}` };
  let edited = (await service.handle(input)).session;
  assert.notEqual(edited.sessionId, original.sessionId);
  assert.deepEqual((await service.handle(input)).session, edited, 'Retry returns the same derived edit');
  edited = (await answer(service, edited, { answers: { observable: '判断交集为空并说明理由' } })).session;
  assert.deepEqual(edited.confirmedStages, ['purpose', 'scope', 'boundary', 'size']);
  const blocked = await service.handle({ action: 'confirm', sessionId: edited.sessionId, revision: edited.revision, operationId: `confirm-${++sequence}` });
  assert.equal(blocked.error.code, 'incomplete_intake');
  edited = await advance(service, edited);
  assert.equal(edited.stage, 'review');
  const saved = await service.handle({ action: 'confirm', sessionId: edited.sessionId, revision: edited.revision, operationId: `confirm-${++sequence}` });
  assert.equal(saved.ok, true);
  assert.equal(saved.session.requirements.teachingGoals[0].observable, '判断交集为空并说明理由');
  assert.deepEqual(saved.session.requirements.counts, original.requirements.counts);
  assert.deepEqual((await service.get(original.sessionId)).session, original, 'Original confirmed requirements remain immutable');
});

test('scope edits only recheck affected boundaries and goals; size edits return to review', async () => {
  const service = createIntakeService();
  const original = await complete(service, await start(service));
  let edited = (await service.handle({ action: 'revise', sessionId: original.sessionId, revision: original.revision, stage: 'scope', operationId: `revise-${++sequence}` })).session;
  edited = await advance(service, edited, { answers: { mainScope: [original.answers.mainScope[0]] } });
  assert.equal(edited.stage, 'boundary');
  assert.ok(edited.confirmedStages.includes('size'));
  edited = await advance(service, edited);
  assert.equal(edited.stage, 'goal');
  edited = await advance(service, edited);
  assert.equal(edited.stage, 'review');
  let sized = (await service.handle({ action: 'revise', sessionId: original.sessionId, revision: original.revision, stage: 'size', operationId: `revise-${++sequence}` })).session;
  sized = await advance(service, sized, { answers: { durationMinutes: 35 } });
  assert.equal(sized.stage, 'review');
  assert.ok(sized.confirmedStages.includes('goal'));
  const stale = await service.handle({ action: 'revise', sessionId: original.sessionId, revision: 0, operationId: `revise-${++sequence}` });
  assert.equal(stale.error.code, 'revision_conflict');
});

test('recommended ratios are explicit, while prescribed counts remain fixed', async () => {
  const service = createIntakeService({ gateway: createLlmGateway({ env: {} }) });
  let session = await start(service);
  session = (await answer(service, session, { answers: { size: 'custom', singleChoiceCount: 8, fillBlankCount: 2, freeResponseCount: 0 } })).session;
  assert.equal(session.planning.countPolicy, 'fixed');
  assert.deepEqual(session.requirements.counts, { single_choice: 8, fill_blank: 2, free_response: 0 });
  const rejected = await answer(service, session, { answers: { size: 'recommend', singleChoiceCount: 8 } });
  assert.equal(rejected.ok, false, 'Do not silently overwrite explicit counts');
  session = (await answer(service, session, { answers: { size: 'recommend' } })).session;
  assert.equal(session.planning.countPolicy, 'suggested');
  assert.equal(session.summary.questionCount, 10);
  session = (await answer(service, session, { answers: { size: 'preset' } })).session;
  assert.equal(session.planning.countPolicy, 'fixed');
});

test('must goals retain strength and still block candidates with no reviewed support', async () => {
  const service = createIntakeService();
  const session = await complete(service, await start(service, { answers: { cognition: 'apply', priority: 'required', observable: '运用集合交并运算解决有限集问题' } }));
  assert.equal(session.requirements.teachingGoals[0].priority, 'required');
  assert.equal(session.summary.goalEvidenceStatus, 'unknown');
  const result = await previewBlueprint(session.requirements);
  assert.equal(result.ok, true);
  assert.ok(result.blueprint.supply.slotSupply.every(slot => slot.eligibleCount === 0));
});

test('stage navigation cannot bypass explicit confirmation; changed boundaries invalidate confirmation', async () => {
  const service = createIntakeService();
  let session = await start(service);
  session = (await answer(service, session, { stage: 'review' })).session;
  const rejected = await service.handle({ action: 'confirm', sessionId: session.sessionId, revision: session.revision, operationId: 'skip-confirm' });
  assert.equal(rejected.error.code, 'incomplete_intake');
  const invalid = await answer(service, session, { stage: 'scope', answers: { mainScope: [] }, next: true });
  assert.equal(invalid.ok, false);
  assert.deepEqual((await service.get(session.sessionId)).session, session);
  session = (await answer(service, session, { stage: 'purpose' })).session;
  for (let i = 0; i < 5; i++) session = await advance(service, session);
  assert.equal(session.confirmedStages.length, 5);
  session = (await answer(service, session, { answers: { mainScope: ['1.1'] }, stage: 'scope' })).session;
  assert.deepEqual(session.confirmedStages, ['purpose']);
  assert.equal((await service.handle({ action: 'confirm', sessionId: session.sessionId, revision: session.revision, operationId: 'changed-confirm' })).error.code, 'incomplete_intake');
});

test('invalid catalog IDs and impossible sizes never persist', async () => {
  const service = createIntakeService();
  const session = await start(service);
  for (const answers of [{ mainScope: ['invented'] }, { premises: ['invented'] }, { singleChoiceCount: 30, fillBlankCount: 30, freeResponseCount: 30 }, { singleChoiceCount: 0, fillBlankCount: 0, freeResponseCount: 0 }, { cognition: 'high' }, { html: '<script/>' }]) {
    const result = await answer(service, session, { answers });
    assert.equal(result.ok, false, JSON.stringify(answers));
    assert.equal((await service.get(session.sessionId)).session.revision, session.revision);
  }
  const result = await answer(service, session, { stage: 'boundary', next: true, answers: { mainScope: ['1.3'], learnedScope: ['1.1'] } });
  assert.equal(result.ok, false);
});

test('idempotent retries return the same revision and concurrent writes detect conflicts', async () => {
  const service = createIntakeService();
  const input = { action: 'start', operationId: 'same-start' };
  const first = await service.handle(input);
  assert.deepEqual(await service.handle(input), first);
  const session = first.session;
  const change = { action: 'answer', sessionId: session.sessionId, revision: 0, operationId: 'same-answer', answers: { purpose: 'diagnostic' } };
  const results = await Promise.all([service.handle(change), service.handle(change)]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].session.revision, 1);
  assert.equal((await service.handle({ ...change, answers: { purpose: 'assessment' } })).error.code, 'operation_conflict');
  assert.equal((await answer(service, session)).error.code, 'revision_conflict');
});

test('AI components and changes are proposals until explicitly accepted', async () => {
  const proposal = { summary: '建议诊断集合关系，保留教师指定的必须要求。', changes: { purpose: 'diagnostic', cognition: 'understand', mainScope: ['1.2'] }, blocks: [{ kind: 'multi_choice', id: 'scope-proposal', title: '确认主考内容', field: 'mainScope', options: [{ id: '1.2', label: '集合间的基本关系' }], value: ['1.2'] }] };
  const service = createIntakeService({ gateway: fixtureGateway(proposal) });
  let session = await start(service, { answers: { priority: 'required' } });
  const assisted = await service.handle({ action: 'assist', sessionId: session.sessionId, revision: session.revision, operationId: 'assist-fixture', message: '测一下集合关系' });
  assert.equal(assisted.ok, true);
  session = assisted.session;
  assert.equal(session.answers.purpose, 'consolidation');
  assert.equal(session.answers.priority, 'required');
  assert.deepEqual(session.proposal, proposal);
  assert.equal(session.llmRun.model, 'fixture-only');
  session = (await answer(service, session, { acceptProposal: true })).session;
  assert.equal(session.answers.purpose, 'diagnostic');
  assert.equal(session.answers.priority, 'required');
  assert.equal(session.proposal, null);
});

test('unsafe or unknown generated components are rejected without changing answers', async () => {
  for (const blocks of [
    [{ kind: 'html', id: 'unsafe', title: 'unsafe', html: '<script/>' }],
    [{ kind: 'multi_choice', id: 'invented', title: '未知章节', field: 'mainScope', options: [{ id: '9.9', label: '未知' }] }],
    [{ kind: 'text', id: 'bad-kind', title: '目标', field: 'priority', value: 'preferred' }],
    [{ kind: 'single_choice', id: 'conflict', title: '用途', field: 'purpose', value: 'assessment', options: [{ id: 'assessment', label: '检测' }] }],
  ]) {
    const service = createIntakeService({ gateway: fixtureGateway({ summary: 'fixture rejection', changes: { purpose: 'diagnostic' }, blocks }) });
    const session = await start(service);
    const result = await service.handle({ action: 'assist', sessionId: session.sessionId, revision: session.revision, operationId: 'invalid-fixture', message: 'fixture' });
    assert.equal(result.ok, true);
    assert.equal(result.session.proposal, null);
    assert.equal(result.session.assistantError.code, 'invalid_model_output');
    assert.equal(result.session.answers.purpose, 'consolidation');
  }
});

test('unconfigured LLM is explicit and click-only workflow remains available', async () => {
  const service = createIntakeService({ gateway: createLlmGateway({ env: {} }) });
  let session = await start(service);
  const result = await service.handle({ action: 'assist', sessionId: session.sessionId, revision: 0, operationId: 'not-configured', message: '请帮我规划' });
  assert.equal(result.session.assistantError.code, 'not_configured');
  assert.equal(result.session.llmRun.status, 'not_configured');
  session = await complete(service, result.session);
  assert.equal(session.status, 'confirmed');
});

const methodsProposal = { summary: '集合交并补可能涉及绝对值不等式，请确认是否允许使用；保留已允许的方法。',
  changes: { premises: ['vieta', 'absolute_root'] }, blocks: [{ kind: 'multi_choice', id: 'methods-proposal',
    title: '额外允许使用的知识与方法', field: 'premises', value: ['vieta', 'absolute_root'], options: [
      { id: 'vieta', label: '韦达定理' }, { id: 'absolute_root', label: '绝对值不等式工具' },
    ] }] };
async function boundary(service, answers = {}) {
  let session = await start(service, { answers: { mainScope: ['1.3'], premises: ['vieta'], ...answers } });
  session = await advance(service, session);
  session = await advance(service, session);
  assert.equal(session.stage, 'boundary');
  return session;
}
async function suggestMethods(service, session, options = {}) {
  return service.handle({ action: 'suggest_methods', sessionId: session.sessionId, revision: session.revision,
    operationId: `methods-${++sequence}` }, options);
}

test('method suggestions read scope-specific version-bound solution dependencies and stay pending until adopted', async () => {
  let context; let validations = 0;
  const service = createIntakeService({ gateway: { configured: true, async propose(input, { validate }) {
    context = input; validations++; validate(methodsProposal);
    return { ok: true, proposal: methodsProposal, run: { status: 'succeeded', provider: 'fixture', model: 'fixture-only' } };
  } } });
  let session = await boundary(service);
  assert.deepEqual(session.blocks.map(block => block.field), ['learnedScope', 'premises']);
  assert.equal(session.blocks[1].title, '额外允许使用的知识与方法');
  assert.deepEqual(session.blocks[1].options.map(option => option.id), ['vieta']);
  const before = structuredClone(session);
  const suggested = await suggestMethods(service, session);
  assert.equal(suggested.ok, true, JSON.stringify(suggested));
  session = suggested.session;
  assert.equal(validations, 1);
  assert.equal(context.task, 'suggest_methods');
  assert.deepEqual(context.supportedFields, ['premises']);
  assert.ok(context.foundation.length > 0);
  assert.ok(!context.premises.some(method => method.id === 'basic_geometry'), 'Methods used only outside the chosen main scope are not offered');
  const absolute = context.methodDependencies.methods.find(method => method.id === 'absolute_root');
  assert.ok(absolute.candidateEvidenceCount > 0);
  assert.ok(absolute.solutionPathEvidenceCount >= absolute.candidateEvidenceCount);
  assert.ok(absolute.evidenceRefs.every(ref => ref.questionId && ref.contentVersion && ref.teacherVersion && ref.solutionPathId && ref.basis));
  assert.ok(absolute.evidenceRefs.every(ref => ref.requiredPremises.includes('absolute_root') && ref.requiredSections.every(id => before.answers.learnedScope.includes(id))));
  assert.equal(session.proposalKind, 'methods');
  assert.deepEqual(session.answers, before.answers);
  assert.deepEqual(session.requirements, before.requirements);
  assert.deepEqual(session.confirmedStages, before.confirmedStages);
  session = (await answer(service, session, { acceptProposal: true })).session;
  assert.deepEqual(session.answers.premises, ['vieta', 'absolute_root']);
  assert.deepEqual(session.answers.mainScope, before.answers.mainScope);
  assert.deepEqual(session.answers.learnedScope, before.answers.learnedScope);
  assert.equal(session.proposal, null);
  assert.equal(session.proposalKind, null);
});

test('boundary without already allowed methods has no static complete registry block', async () => {
  const service = createIntakeService();
  let session = await boundary(service, { premises: [] });
  assert.deepEqual(session.blocks.map(block => block.field), ['learnedScope']);
  session = (await answer(service, session, { answers: { premises: ['absolute_root'] } })).session;
  assert.deepEqual(session.blocks[1].options.map(option => option.id), ['absolute_root']);
  session = (await answer(service, session, { answers: { premises: [] } })).session;
  assert.deepEqual(session.blocks.map(block => block.field), ['learnedScope']);
});

test('method-specific validation rejects unknown or irrelevant IDs, other field changes and removal of allowed methods', async () => {
  const invalid = [
    { summary: '未知方法', changes: { premises: ['vieta', 'invented'] }, blocks: [] },
    { summary: '范围无关', changes: { premises: ['vieta', 'basic_geometry'] }, blocks: [] },
    { ...methodsProposal, changes: { ...methodsProposal.changes, learnedScope: ['1.3'] } },
    { ...methodsProposal, changes: { ...methodsProposal.changes, mainScope: ['1.1'] } },
    { ...methodsProposal, changes: { ...methodsProposal.changes, priority: 'preferred' } },
    { summary: '取消旧许可', changes: { premises: ['absolute_root'] }, blocks: [] },
    { summary: '越权组件', changes: {}, blocks: [{ kind: 'single_choice', id: 'change-goal', title: '修改认知要求',
      field: 'cognition', value: 'understand', options: [{ id: 'understand', label: '理解' }] }] },
  ];
  for (const proposal of invalid) {
    const service = createIntakeService({ gateway: fixtureGateway(proposal) });
    const original = await boundary(service);
    const result = await suggestMethods(service, original);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.session.proposal, null);
    assert.equal(result.session.assistantError.code, 'invalid_model_output');
    assert.deepEqual(result.session.answers, original.answers);
    assert.deepEqual(result.session.requirements, original.requirements);
    assert.deepEqual(result.session.confirmedStages, original.confirmedStages);
  }
});

test('method business validation shares bounded repair and does not affect general assist', async () => {
  const env = { LLM_BASE_URL: 'https://fixture.invalid/v1', LLM_API_KEY: 'fixture-only', LLM_MODEL: 'fixture' };
  let calls = 0; let feedback;
  const service = createIntakeService({ gateway: createLlmGateway({ env, generate: async options => {
    calls++;
    if (calls === 2) feedback = JSON.parse(options.prompt).schemaCorrection;
    return { output: calls === 1 ? { ...methodsProposal, changes: { ...methodsProposal.changes, learnedScope: ['1.3'] } } : methodsProposal,
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } };
  } }) });
  const original = await boundary(service);
  const result = await suggestMethods(service, original);
  assert.equal(result.ok, true);
  assert.equal(result.session.proposalKind, 'methods');
  assert.equal(calls, 2);
  assert.equal(result.session.llmRun.usage.totalTokens, 10);
  assert.ok(feedback.issues[0].message.includes('只能提出额外允许项'));
  assert.deepEqual(result.session.answers, original.answers);
  const general = createIntakeService({ gateway: fixtureGateway({ summary: '一般需求建议仍可修改用途。', changes: { purpose: 'diagnostic' }, blocks: [] }) });
  const session = await boundary(general);
  const assisted = await general.handle({ action: 'assist', sessionId: session.sessionId, revision: session.revision,
    operationId: `assist-general-${++sequence}`, message: '改为诊断用途' });
  assert.equal(assisted.session.proposalKind, 'intake');
  assert.equal(assisted.session.proposal.changes.purpose, 'diagnostic');
});

test('method suggestions are invalidated after scope or learned-boundary edits, while direct method edits remain allowed', async () => {
  for (const answers of [{ mainScope: ['1.1'] }, { learnedScope: ['1.3'] }, { premises: [] }]) {
    const service = createIntakeService({ gateway: fixtureGateway(methodsProposal) });
    let session = await boundary(service);
    session = (await suggestMethods(service, session)).session;
    assert.ok(session.proposal);
    session = (await answer(service, session, { answers })).session;
    assert.equal(session.proposal, null);
    assert.equal(session.proposalKind, null);
    const rejected = await answer(service, session, { acceptProposal: true });
    assert.equal(rejected.ok, false);
    assert.ok(rejected.error.message.includes('没有待采纳'));
  }
});

test('method actions require boundary and never alter confirmed requirements; cancellation uses the assist path', async () => {
  let calls = 0;
  const service = createIntakeService({ gateway: { ...fixtureGateway(methodsProposal), async propose() { calls++; return fixtureGateway(methodsProposal).propose(); } } });
  let session = await start(service);
  assert.equal((await suggestMethods(service, session)).error.code, 'invalid_intake');
  assert.equal(calls, 0);
  session = await complete(service, session);
  const confirmed = structuredClone(session);
  assert.equal((await suggestMethods(service, session)).error.code, 'already_confirmed');
  assert.deepEqual((await service.get(session.sessionId)).session, confirmed);
  assert.equal(calls, 0);
  const controller = new AbortController();
  const cancelledService = createIntakeService({ gateway: createLlmGateway({ env: { LLM_BASE_URL: 'https://fixture.invalid/v1', LLM_API_KEY: 'fixture-only', LLM_MODEL: 'fixture' },
    generate: async () => { controller.abort(); return new Promise(() => {}); } }) });
  const original = await boundary(cancelledService);
  const cancelled = await suggestMethods(cancelledService, original, { signal: controller.signal });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.session.assistantError.code, 'cancelled');
  assert.deepEqual(cancelled.session.answers, original.answers);
});

test('method adoption atomically rejects simultaneous changes to other requirements without saving or invalidating the proposal', async () => {
  const service = createIntakeService({ gateway: fixtureGateway(methodsProposal) });
  let session = await boundary(service);
  session = (await suggestMethods(service, session)).session;
  const before = structuredClone(session);
  for (const answers of [
    { mainScope: ['1.1'], learnedScope: ['1.1'] },
    { title: '替换标题' }, { priority: 'required' }, { targetScore: 90 },
    { premises: ['absolute_root'], learnedScope: ['1.1'] },
  ]) {
    const rejected = await answer(service, session, { acceptProposal: true, answers });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'invalid_intake');
    assert.ok(rejected.error.message.includes('只能调整允许的方法'));
    assert.deepEqual((await service.get(session.sessionId)).session, before);
  }
  // Explicit teacher edits to the methods themselves remain allowed, including
  // registered methods beyond the model's scope-specific suggestion subset.
  const unknown = await answer(service, session, { acceptProposal: true, answers: { premises: ['invented'] } });
  assert.equal(unknown.ok, false);
  assert.deepEqual((await service.get(session.sessionId)).session, before);
  const adopted = await answer(service, session, { acceptProposal: true, answers: { premises: ['basic_geometry'] } });
  assert.equal(adopted.ok, true, JSON.stringify(adopted));
  assert.deepEqual(adopted.session.answers.premises, ['basic_geometry']);
  assert.deepEqual(adopted.session.answers.mainScope, before.answers.mainScope);
  assert.equal(adopted.session.proposal, null);
  assert.equal(adopted.session.proposalKind, null);
});
