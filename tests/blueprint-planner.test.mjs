import test from 'node:test';
import assert from 'node:assert/strict';
import { planBlueprint } from '../src/assembly/planner.mjs';
import { createBlueprintGateway } from '../src/llm/blueprint-gateway.mjs';
import { getAssemblyConfig, recheckBlueprint, createDraft } from '../src/assembly/engine.mjs';

const env = { LLM_BASE_URL: 'https://fixture.invalid/v1', LLM_API_KEY: 'secret-never-public', LLM_MODEL: 'fixture', LLM_PROVIDER_NAME: 'fixture-provider' };
const config = (await getAssemblyConfig()).config;
const requirements = { ...config.defaultRequirements, counts: { single_choice: 2, fill_blank: 0, free_response: 0 }, targetScore: 20, premises: [] };
const proposal = { summary: '根据概念巩固需求安排两个有真实供给的任务；难度保持未知。', slots: [
  { taskId: 'set_determinacy', points: 10, goalIds: [], rationale: '识别集合确定性，候选来自真实供给。' },
  { taskId: 'number_membership', points: 10, goalIds: [], rationale: '区分数集和元素关系。' },
] };
const gateway = output => createBlueprintGateway({ env, generate: async () => ({ output, usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } }) });
const clone = value => structuredClone(value);

test('LLM planning uses real supply identities, preserves demands, and rechecks provenance', async () => {
  let context;
  const mocked = createBlueprintGateway({ env, generate: async options => {
    context = JSON.parse(options.prompt);
    return { output: proposal, usage: { inputTokens: 4, outputTokens: 8, totalTokens: 12 } };
  } });
  const result = await planBlueprint(requirements, { gateway: mocked });
  assert.equal(result.ok, true, JSON.stringify(result));
  const { blueprint } = result;
  assert.deepEqual(blueprint.requirements, { ...requirements, teachingGoals: [] });
  assert.deepEqual(blueprint.plannedStats, { questionCount: 2, points: 20 });
  assert.equal(blueprint.generation.mode, 'llm');
  assert.equal(blueprint.generation.llmRun.usage.totalTokens, 12);
  assert.deepEqual(blueprint.generation.originalCounts, requirements.counts);
  assert.deepEqual(blueprint.generation.proposalChanges, []);
  assert.equal(blueprint.slots[0].planningReason, proposal.slots[0].rationale);
  const task = context.tasks.find(task => task.taskId === 'set_determinacy');
  assert.ok(task.eligibleCandidates.length > 0);
  assert.ok(task.eligibleCandidates.every(candidate => candidate.questionId && candidate.contentVersion && candidate.duplicateGroup));
  assert.equal(task.eligibleCount, task.eligibleCandidates.length);
  assert.equal(blueprint.supply.distinctCandidateCapacity, 2);
  assert.ok(context.tasks.some(task => task.unknownCount > 0));
  assert.equal(context.requirements.premises.length, 0);
  assert.ok(!JSON.stringify(context).includes(env.LLM_API_KEY));
  const checked = await recheckBlueprint(blueprint);
  assert.equal(checked.ok, true);
  assert.equal(checked.blueprint.generation.mode, 'llm');
  assert.equal(checked.blueprint.generation.edited, true);
  assert.equal(checked.blueprint.slots[0].planningReason, proposal.slots[0].rationale);
  const draft = await createDraft(checked.blueprint);
  assert.equal(draft.ok, true);
  assert.equal(draft.draft.baseline.generation.llmRun.usage.totalTokens, 12);
  assert.equal(new Set(draft.draft.slots.map(slot => slot.question.questionId)).size, 2);
});

test('strict output rejects unknown fields, invented tasks, and scope changes', async () => {
  const cases = [
    { ...clone(proposal), learnedScope: ['invented'] },
    { ...clone(proposal), requirements: { ...requirements, premises: ['vieta'] } },
    { ...clone(proposal), targetDifficulty: 0.4 },
    { ...clone(proposal), slots: [{ ...proposal.slots[0], taskId: 'invented' }, proposal.slots[1]] },
    { ...clone(proposal), slots: [{ ...proposal.slots[0], goalIds: ['invented'] }, proposal.slots[1]] },
  ];
  for (const output of cases) {
    const result = await planBlueprint(requirements, { gateway: gateway(output) });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'invalid_model_output');
    assert.equal(result.llmRun.attempts.length, 2);
  }
  const outside = clone(proposal); outside.slots[1].taskId = 'proper_subset';
  const result = await planBlueprint({ ...requirements, mainScope: ['1.1'] }, { gateway: gateway(outside) });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid_model_output');
});

test('fixed counts reject redistribution while suggested only changes counts and keeps total/points', async () => {
  const output = clone(proposal);
  output.slots[1].taskId = 'element_parameter_distinct';
  const fixed = await planBlueprint(requirements, { gateway: gateway(output) });
  assert.equal(fixed.ok, false);
  const suggested = await planBlueprint(requirements, { gateway: gateway(output), countPolicy: 'suggested' });
  assert.equal(suggested.ok, true, JSON.stringify(suggested));
  assert.deepEqual(suggested.blueprint.requirements.counts, { single_choice: 1, fill_blank: 1, free_response: 0 });
  assert.deepEqual(suggested.blueprint.requirements, { ...requirements, teachingGoals: [], counts: { single_choice: 1, fill_blank: 1, free_response: 0 } });
  assert.equal(suggested.blueprint.generation.proposalChanges.length, 2);
  for (const invalid of [ { ...output, slots: output.slots.slice(1) }, { ...output, slots: [{ ...output.slots[0], points: 11 }, output.slots[1]] } ]) {
    assert.equal((await planBlueprint(requirements, { gateway: gateway(invalid), countPolicy: 'suggested' })).ok, false);
  }
});

test('bounded correction repairs business/schema errors and records all real attempts', async () => {
  let calls = 0; let feedback;
  const mocked = createBlueprintGateway({ env, generate: async options => {
    calls++;
    if (calls === 2) feedback = JSON.parse(options.prompt).schemaCorrection;
    return { output: calls === 1 ? { ...proposal, slots: [{ ...proposal.slots[0], taskId: 'bad' }, proposal.slots[1]] } : proposal,
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } };
  } });
  const result = await planBlueprint(requirements, { gateway: mocked });
  assert.equal(result.ok, true);
  assert.equal(result.blueprint.generation.llmRun.attempts.length, 2);
  assert.equal(result.blueprint.generation.llmRun.usage.totalTokens, 14);
  assert.ok(feedback.issues[0].message.includes('未知任务'));
  let schemaCalls = 0;
  const repaired = await planBlueprint(requirements, { gateway: createBlueprintGateway({ env, generate: async () => ({ output: ++schemaCalls === 1 ? { html: 'wrong' } : proposal }) }) });
  assert.equal(repaired.ok, true);
  assert.equal(schemaCalls, 2);
});

test('required goals cannot be omitted, weakened or claimed covered', async () => {
  const goal = { id: 'goal-1', version: 1, knowledgeScope: ['1.1'], cognition: 'understand', observable: '判断给定对象能否构成集合并解释确定性。',
    conditions: { prompt: 'independent', response: 'answer' }, priority: 'required', abilities: [], literacies: [], source: { kind: 'teacher', text: '必须理解集合概念' } };
  const input = { ...requirements, teachingGoals: [goal] };
  const omitted = await planBlueprint(input, { gateway: gateway(proposal) });
  assert.equal(omitted.ok, false);
  const output = clone(proposal); output.slots.forEach(slot => { slot.goalIds = ['goal-1']; });
  let context;
  const result = await planBlueprint(input, { gateway: createBlueprintGateway({ env, generate: async options => { context = JSON.parse(options.prompt); return { output }; } }) });
  assert.equal(result.ok, true);
  assert.equal(result.blueprint.requirements.teachingGoals[0].priority, 'required');
  assert.equal(result.blueprint.generation.llmRun.attempts.length, 1);
  assert.equal(result.blueprint.supply.slotSupply[0].eligibleCount, 0);
  assert.equal(result.blueprint.supply.distinctCandidateCapacity, 0);
  assert.equal(context.tasks.find(task => task.taskId === 'set_determinacy').goalSupportStatus, 'unknown');
  assert.ok(result.blueprint.goalReview.items.every(goal => goal.status !== 'covered'));
  const edited = clone(result.blueprint);
  edited.slots[0].goalIds = [];
  for (const action of [recheckBlueprint, createDraft]) {
    const accepted = await action(edited);
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    const slots = accepted.blueprint?.slots ?? accepted.draft.slots;
    assert.deepEqual(slots[0].goalIds, []);
    assert.deepEqual(slots[1].goalIds, ['goal-1']);
    if (accepted.draft) {
      assert.ok(slots[0].question, 'The ordinary foundation slot remains selectable');
      assert.equal(slots[1].question, null, 'The linked required goal retains its honest evidence gap');
    }
  }
  // The model can explicitly allocate a required goal to one key slot while
  // retaining ordinary foundation practice in the other compatible slot.
  output.slots[0].goalIds = [];
  let localizedContext;
  const localized = await planBlueprint(input, { gateway: createBlueprintGateway({ env, generate: async options => {
    localizedContext = JSON.parse(options.prompt); return { output };
  } }) });
  assert.equal(localized.ok, true, JSON.stringify(localized));
  assert.equal(localized.blueprint.supply.distinctCandidateCapacity, 1);
  assert.ok(localized.blueprint.supply.slotSupply[0].eligibleCount > 0);
  assert.equal(localized.blueprint.supply.slotSupply[1].eligibleCount, 0);
  assert.equal(localizedContext.tasks.find(task => task.taskId === 'set_determinacy').eligibleCount, 0);
  assert.ok(localizedContext.tasks.find(task => task.taskId === 'set_determinacy').foundationEligibleCount > 0);
  const unassigned = clone(result.blueprint);
  unassigned.slots.forEach(slot => { slot.taskId = 'proper_subset'; slot.goalIds = []; });
  assert.equal((await recheckBlueprint(unassigned)).ok, false);
  assert.equal((await createDraft(unassigned)).ok, false);
  const incompatible = clone(edited);
  incompatible.slots[1].taskId = 'proper_subset';
  for (const action of [recheckBlueprint, createDraft]) {
    const rejected = await action(incompatible);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'invalid_plan');
    assert.match(rejected.error.message, /不兼容/);
  }
});

test('missing config, provider failure, timeout and cancellation remain explicit with no preset fallback', async () => {
  const missing = await planBlueprint(requirements, { gateway: createBlueprintGateway({ env: {} }) });
  assert.equal(missing.error.code, 'not_configured');
  assert.equal(missing.blueprint, undefined);
  const failed = await planBlueprint(requirements, { gateway: createBlueprintGateway({ env, generate: async () => { throw new Error(`Bearer ${env.LLM_API_KEY}`); } }) });
  assert.equal(failed.error.code, 'model_error');
  assert.ok(!JSON.stringify(failed).includes(env.LLM_API_KEY));
  const timeout = await planBlueprint(requirements, { gateway: createBlueprintGateway({ env, timeoutMs: 5, generate: async () => new Promise(() => {}) }) });
  assert.equal(timeout.error.code, 'timeout');
  assert.equal(timeout.llmRun.status, 'timeout');
  let called = false;
  const cancelled = await planBlueprint(requirements, { signal: AbortSignal.abort(), gateway: { propose: async () => { called = true; } } });
  assert.equal(cancelled.error.code, 'cancelled'); assert.equal(called, false);
  const controller = new AbortController();
  const inFlight = await planBlueprint(requirements, { signal: controller.signal, gateway: createBlueprintGateway({ env, generate: async () => { controller.abort(); return new Promise(() => {}); } }) });
  assert.equal(inFlight.error.code, 'cancelled');
});

test('overlapping candidate sets report duplicate-group capacity rather than summed supply', async () => {
  const output = { summary: '重复任务用于验证供给边界。', slots: Array.from({ length: 4 }, () => ({ ...proposal.slots[0], points: 10 })) };
  const result = await planBlueprint({ ...requirements, targetScore: 40, counts: { single_choice: 4, fill_blank: 0, free_response: 0 } }, { gateway: gateway(output) });
  assert.equal(result.ok, true);
  assert.equal(result.blueprint.supply.distinctCandidateCapacity, 4);
  assert.ok(result.blueprint.supply.distinctCandidateCapacity > 0);
  assert.ok(result.blueprint.supply.slotSupply.reduce((sum, supply) => sum + supply.eligibleCount, 0) > result.blueprint.supply.distinctCandidateCapacity);
});


test('an avoidable empty task triggers one explicit model repair instead of silently replacing a slot', async () => {
  const first = clone(proposal);
  first.slots[1].taskId = 'root_set_subset_count';
  first.slots[1].rationale = '原解答题任务缺少允许工具，暂无合格候选。';
  let calls = 0; let correction;
  const result = await planBlueprint(requirements, { countPolicy: 'suggested', gateway: createBlueprintGateway({ env, generate: async options => {
    calls++;
    const context = JSON.parse(options.prompt);
    if (calls === 2) {
      correction = context.schemaCorrection;
      assert.equal(correction.previousOutput.slots[1].taskId, 'root_set_subset_count');
      assert.equal(context.countPolicy, 'suggested');
    }
    return { output: calls === 1 ? first : proposal, usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } };
  } }) });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls, 2);
  assert.ok(correction.issues[0].message.includes('存在可改善的缺口'));
  assert.ok(correction.issues[0].message.includes('第 2 题原任务 root_set_subset_count'));
  assert.ok(correction.issues[0].message.includes('proper_subset'));
  assert.equal(result.blueprint.slots[1].taskId, proposal.slots[1].taskId);
  assert.equal(first.slots[1].taskId, 'root_set_subset_count');
  assert.equal(result.blueprint.supply.distinctCandidateCapacity, 2);
  assert.equal(result.blueprint.generation.llmRun.usage.totalTokens, 10);
  assert.equal(result.blueprint.generation.llmRun.attempts[0].errorName, 'BusinessValidationError');
  const neverRepaired = await planBlueprint(requirements, { countPolicy: 'suggested', gateway: gateway(first) });
  assert.equal(neverRepaired.ok, false);
  assert.equal(neverRepaired.error.code, 'invalid_model_output');
  assert.equal(neverRepaired.llmRun.attempts.length, 2);
});

test('fixed plans repair within their question type, and genuinely unavoidable gaps remain visible', async () => {
  const first = clone(proposal);
  first.slots[1].taskId = 'union_complement_parameter';
  let calls = 0; let feedback;
  const fixed = await planBlueprint(requirements, { gateway: createBlueprintGateway({ env, generate: async options => {
    calls++;
    if (calls === 2) feedback = JSON.parse(options.prompt).schemaCorrection.issues[0].message;
    return { output: calls === 1 ? first : proposal };
  } }) });
  assert.equal(fixed.ok, true);
  assert.equal(calls, 2);
  assert.ok(feedback.includes('各题型题量保持不变'));
  assert.deepEqual(fixed.blueprint.requirements.counts, requirements.counts);
  const unfillable = { summary: '保持固定解答题题量，允许范围内没有合格候选，保留缺口。', slots: [
    { taskId: 'root_set_subset_count', points: 10, goalIds: [], rationale: '保持集合关系的固定解答题要求，解法证据不足。' },
  ] };
  let impossibleCalls = 0;
  const impossible = await planBlueprint({ ...requirements, mainScope: ['1.2'], targetScore: 10, counts: { single_choice: 0, fill_blank: 0, free_response: 1 } },
    { gateway: createBlueprintGateway({ env, generate: async () => { impossibleCalls++; return { output: unfillable }; } }) });
  assert.equal(impossible.ok, true, JSON.stringify(impossible));
  assert.equal(impossibleCalls, 1);
  assert.equal(impossible.blueprint.supply.distinctCandidateCapacity, 0);
  assert.equal(impossible.blueprint.slots[0].taskId, 'root_set_subset_count');
  assert.equal(impossible.blueprint.supply.slotSupply[0].eligibleCount, 0);
});
