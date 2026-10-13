import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntakeService } from '../src/intake/service.mjs';
import { planBlueprint } from '../src/assembly/planner.mjs';
import { planningCapacity } from '../src/assembly/supply-capacity.mjs';
import { createAppServer } from '../src/server.mjs';

let n = 0;
const op = () => `partial-${++n}`;
async function act(service, session, action, extra = {}) {
  const result = await service.handle({ action, sessionId: session.sessionId, revision: session.revision, operationId: op(), ...extra });
  assert.equal(result.ok, true, JSON.stringify(result)); return result.session;
}
const fixtureGateway = changes => ({ async propose(_context, { validate }) {
  return { ok: true, run: { status: 'succeeded' }, proposal: { summary: '只提取教师明确条件。', changes, blocks: [] } };
} });

test('excluding one type remains a pending partial constraint, never a guessed fixed 6/4 ratio', async () => {
  let context;
  const service = createIntakeService({ gateway: { async propose(input, { validate }) {
    context = input; return { ok: true, proposal: validate({ summary: '不含解答题，其他题型由蓝图建议。',
      changes: { typeConstraints: { excludedTypes: ['free_response'], exactCounts: {} } }, blocks: [] }) };
  } } });
  let session = (await service.handle({ action: 'start', flow: 'quick', operationId: op(), answers: { questionCount: 10 } })).session;
  session = await act(service, session, 'prepare', { message: '10题，不要解答题' });
  assert.equal(context.typeCountsEditable, false);
  assert.equal(context.partialTypeConstraintsEditable, true);
  assert.ok(!context.supportedFields.includes('singleChoiceCount'));
  assert.equal(session.answers.typeConstraints, undefined);
  session = await act(service, session, 'answer', { acceptProposal: true });
  assert.equal(session.planning.countPolicy, 'suggested');
  assert.equal(session.requirements.counts.free_response, 0);
  assert.equal(Object.values(session.requirements.counts).reduce((a, b) => a + b, 0), 10);
  assert.deepEqual(session.requirements.typeConstraints, { excludedTypes: ['free_response'], exactCounts: {} });
  session = await act(service, session, 'confirm');
  assert.equal(session.planning.countPolicy, 'suggested');
});

test('a model cannot freeze invented positive counts from a merely negative type request', async () => {
  const service = createIntakeService({ gateway: fixtureGateway({ singleChoiceCount: 6, fillBlankCount: 4, freeResponseCount: 0 }) });
  let session = (await service.handle({ action: 'start', flow: 'quick', operationId: op() })).session;
  session = await act(service, session, 'prepare', { message: '10题，不要解答题' });
  assert.equal(session.proposal, null);
  assert.equal(session.planning.countPolicy, 'suggested');
  assert.equal(session.assistantError.code, 'invalid_model_output');
});

test('explicit local count and exclusion survive quantity revisions while manual full counts remain fixed', async () => {
  const service = createIntakeService({ gateway: fixtureGateway({ typeConstraints: { excludedTypes: ['free_response'], exactCounts: { fill_blank: 3 } } }) });
  let session = (await service.handle({ action: 'start', flow: 'quick', operationId: op() })).session;
  session = await act(service, session, 'prepare', { message: '10题，其中3道填空，不要解答题' });
  session = await act(service, session, 'answer', { acceptProposal: true });
  assert.equal(session.planning.countPolicy, 'suggested');
  assert.equal(session.requirements.counts.fill_blank, 3);
  session = await act(service, session, 'answer', { answers: { questionCount: 8 } });
  assert.equal(session.answers.questionCount, 8);
  assert.equal(session.requirements.counts.fill_blank, 3);
  assert.equal(session.requirements.counts.free_response, 0);
  session = await act(service, session, 'answer', { answers: { size: 'custom', singleChoiceCount: 4, fillBlankCount: 2, freeResponseCount: 0 } });
  assert.equal(session.planning.countPolicy, 'fixed');
  assert.equal(session.requirements.typeConstraints, undefined);
});

const tasksFor = counts => Object.entries(counts).map(([questionType, count]) => ({ questionType,
  foundationEligibleCandidates: Array.from({ length: count }, (_, index) => ({ questionId: `${questionType}-${index}`, duplicateGroup: `${questionType}-${index}` })) }));

test('preflight respects exclusion, exact local counts and shared duplicate groups', () => {
  const tasks = tasksFor({ single_choice: 5, fill_blank: 1, free_response: 8 });
  const requirements = { counts: { single_choice: 6, fill_blank: 4, free_response: 0 },
    typeConstraints: { excludedTypes: ['free_response'], exactCounts: {} } };
  const capacity = planningCapacity(tasks, requirements, 'suggested');
  assert.deepEqual(capacity, { requested: 10, available: 6, missing: 4, byType: { single_choice: 5, fill_blank: 1, free_response: 0 },
    countPolicy: 'suggested', typeShortages: [], suggestedQuestionCount: 6, suggestedCounts: { single_choice: 5, fill_blank: 1, free_response: 0 } });
  const fixed = planningCapacity(tasks, { counts: { single_choice: 1, fill_blank: 2, free_response: 0 } }, 'fixed');
  assert.equal(fixed.available, 2); assert.equal(fixed.missing, 1);
  assert.deepEqual(fixed.typeShortages, [{ questionType: 'fill_blank', requested: 2, available: 1, missing: 1 }]);
  assert.equal(fixed.suggestedQuestionCount, undefined, 'Lowering total cannot preserve exact per-type counts');
  const exact = planningCapacity(tasks, { ...requirements, typeConstraints: { excludedTypes: ['free_response'], exactCounts: { fill_blank: 3 } } }, 'suggested');
  assert.ok(exact.missing > 0); assert.equal(exact.suggestedQuestionCount, undefined);
  const duplicates = tasksFor({ single_choice: 1, fill_blank: 1 });
  duplicates[1].foundationEligibleCandidates[0].duplicateGroup = duplicates[0].foundationEligibleCandidates[0].duplicateGroup;
  assert.equal(planningCapacity(duplicates, { counts: { single_choice: 1, fill_blank: 1, free_response: 0 } }, 'fixed').available, 1);
});

test('known zero fixed-type supply returns safe capacity before any model call; required goals keep their unknown flow', async () => {
  let calls = 0;
  const input = { mainScope: ['1.2'], learnedScope: ['1.1', '1.2'], counts: { single_choice: 0, fill_blank: 0, free_response: 1 }, scoringMode: 'none' };
  const gateway = { async propose() { calls++; return { ok: false, error: { code: 'fixture_stop', message: 'test' } }; } };
  const result = await planBlueprint(input, { gateway });
  assert.equal(result.error.code, 'insufficient_supply'); assert.equal(calls, 0);
  assert.equal(result.error.details.requested, 1); assert.equal(result.error.details.available, 0);
  assert.doesNotMatch(JSON.stringify(result.error.details), /taskId|questionId|secret/);
  const required = await planBlueprint({ ...input, teachingGoals: [{ id: 'required-g', version: 1,
    knowledgeScope: ['1.2'], cognition: 'reason', observable: '解释集合关系。', conditions: { prompt: 'unspecified', response: 'written_reasoning' },
    priority: 'required', source: { kind: 'teacher', text: '必须说明理由。' } }] }, { gateway });
  assert.equal(required.error.code, 'fixture_stop'); assert.equal(calls, 1);
});

test('HTTP shortage uses 400 and preserves the exact requested counts', async t => {
  let calls = 0;
  const server = createAppServer({ blueprintGateway: { async propose() { calls++; throw new Error('must not call'); } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const input = { mainScope: ['1.2'], learnedScope: ['1.1', '1.2'], counts: { single_choice: 0, fill_blank: 0, free_response: 1 }, scoringMode: 'none' };
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/blueprint/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requirements: input, countPolicy: 'fixed' }) });
  assert.equal(response.status, 400);
  const result = await response.json();
  assert.equal(result.error.code, 'insufficient_supply'); assert.equal(result.error.details.missing, 1);
  assert.equal(calls, 0); assert.deepEqual(input.counts, { single_choice: 0, fill_blank: 0, free_response: 1 });
});

test('suggested planner honors excluded types and exact partial counts while allowing other ratios to change', async () => {
  const requirements = { counts: { single_choice: 3, fill_blank: 1, free_response: 0 }, scoringMode: 'none',
    typeConstraints: { excludedTypes: ['free_response'], exactCounts: { fill_blank: 2 } } };
  const slots = ['set_determinacy', 'number_membership', 'set_determinacy_fill', 'number_membership_fill']
    .map(taskId => ({ taskId, points: 0, goalIds: [], rationale: '测试明确局部数量。' }));
  let context;
  const output = await planBlueprint(requirements, { countPolicy: 'suggested', gateway: { async propose(value) {
    context = value; return { ok: true, proposal: { summary: '两道单选、两道填空。', slots } };
  } } });
  assert.equal(output.ok, true, JSON.stringify(output));
  assert.deepEqual(output.blueprint.requirements.counts, { single_choice: 2, fill_blank: 2, free_response: 0 });
  assert.deepEqual(context.requirements.typeConstraints, requirements.typeConstraints);
  const rejected = await planBlueprint(requirements, { countPolicy: 'suggested', gateway: { async propose() {
    return { ok: true, proposal: { summary: '违规增加其他题型。', slots: slots.map((slot, index) => index === 3 ? { ...slot, taskId: 'number_membership' } : slot) } };
  } } });
  assert.equal(rejected.ok, false); assert.equal(rejected.error.code, 'invalid_plan');
});

test('partial constraints can be revised after confirmation without changing the original', async () => {
  let allowResponse = false;
  const service = createIntakeService({ gateway: { async propose(_context, { validate }) {
    return { ok: true, proposal: validate({ summary: '采纳最新题型条件。', changes: { typeConstraints: {
      excludedTypes: allowResponse ? [] : ['free_response'], exactCounts: allowResponse ? { free_response: 1 } : {},
    } }, blocks: [] }) };
  } } });
  let original = (await service.handle({ action: 'start', flow: 'quick', operationId: op() })).session;
  original = await act(service, original, 'prepare', { message: '10题，不要解答题' });
  original = await act(service, original, 'answer', { acceptProposal: true });
  original = await act(service, original, 'confirm');
  let edited = await act(service, original, 'revise', { stage: 'review' });
  allowResponse = true;
  edited = await act(service, edited, 'prepare', { message: '补充需求：现在允许解答题，加1道解答，仍10题' });
  edited = await act(service, edited, 'answer', { acceptProposal: true });
  assert.equal(edited.planning.countPolicy, 'suggested');
  assert.deepEqual(edited.requirements.typeConstraints, { excludedTypes: [], exactCounts: { free_response: 1 } });
  assert.deepEqual((await service.get(original.sessionId)).session.requirements.typeConstraints, { excludedTypes: ['free_response'], exactCounts: {} });
});
