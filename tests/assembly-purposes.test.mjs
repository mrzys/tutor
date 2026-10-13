import test from 'node:test';
import assert from 'node:assert/strict';
import { assemblyPurposes, purposeFor, purposeStrategy } from '../src/assembly/purposes.mjs';
import { answerSchema } from '../src/intake/schema.mjs';
import { createIntakeService } from '../src/intake/service.mjs';
import { previewBlueprint, createDraft, getAssemblyConfig, normalizeRequirements } from '../src/assembly/engine.mjs';
import { planBlueprint } from '../src/assembly/planner.mjs';
import { selectWithLlm } from '../src/assembly/selector.mjs';

let operation = 0;
const op = () => `purposes-${++operation}`;
const run = { provider: 'fixture', model: 'purpose-context-test', status: 'succeeded' };
const rankingsFor = context => ({ summary: '仅为结构测试的固定排名，不表示真实模型教学质量。',
  rankings: context.slots.map(slot => ({ slotId: slot.slotId, candidates: slot.candidates.map(id => {
    const candidate = context.candidates.find(item => item.questionId === id);
    return { questionId: id, contentVersion: candidate.contentVersion, teacherVersion: candidate.teacherVersion,
      rationale: '按题面检查教师指定任务。', evidenceRefs: ['student.stem'] };
  }) })) });

test('only three MVP choices are offered; legacy IDs remain readable and unknown IDs are rejected', async () => {
  assert.deepEqual(assemblyPurposes.map(item => item.id), ['consolidation', 'targeted_practice', 'diagnostic']);
  for (const item of assemblyPurposes) {
    assert.ok(item.description.length > 20 && item.placeholder.startsWith('例如'));
    assert.equal(answerSchema.parse({ purpose: item.id }).purpose, item.id);
  }
  for (const id of ['assessment', 'mock_exam']) {
    assert.equal(answerSchema.parse({ purpose: id }).purpose, id);
    assert.equal(purposeFor(id).id, id);
  }
  assert.equal(purposeFor('invented'), null);
  assert.throws(() => answerSchema.parse({ purpose: 'invented' }));
  const service = createIntakeService();
  const result = await service.handle({ action: 'start', operationId: op() });
  assert.equal(result.ok, true);
  assert.deepEqual(result.session.blocks[0].options.map(item => item.id), assemblyPurposes.map(item => item.id));
});

test('all three purposes default to unscored practice, explicit totals and old contracts keep their semantics', async () => {
  const config = (await getAssemblyConfig()).config;
  const normalize = input => normalizeRequirements(input, config, config.sources.map(item => item.sourceId));
  for (const { id } of assemblyPurposes) {
    assert.equal(normalize({ purpose: id }).scoringMode, 'none');
    assert.equal(normalize({ purpose: id }).targetScore, 0);
    assert.equal(normalize({ purpose: id, targetScore: 80 }).scoringMode, 'points');
    assert.equal(normalize({ purpose: id, targetScore: 80 }).targetScore, 80);
    assert.equal(normalize({ purpose: id, scoringMode: 'none', targetScore: 80 }).targetScore, 0);
  }
  assert.equal(normalize({}).scoringMode, undefined, 'Old records without a mode preserve their point allocations');
  assert.equal(normalize({ purpose: 'mock_exam', targetScore: 150 }).targetScore, 150);
  assert.equal((await previewBlueprint({ purpose: 'targeted_practice' })).ok, true);
  assert.throws(() => normalize({ purpose: 'invented' }), /组卷用途无效/);
});

for (const { id, label } of assemblyPurposes) {
  test(`${label}: accepted intake strategy reaches real supply planning and candidate comparison unchanged`, async () => {
    let intakeContext; let planContext; const selectionContexts = [];
    const request = '两道集合练习，题干简洁，保持教师已选范围。';
    const service = createIntakeService({ gateway: { async propose(context, { validate }) {
      intakeContext = context;
      return { ok: true, run, proposal: validate({ summary: '按已选用途整理简洁目标。',
        changes: { cognition: 'apply', observable: '判断集合的确定性和常用数集的元素关系。' }, blocks: [] }) };
    } } });
    let result = await service.handle({ action: 'start', flow: 'quick', operationId: op(),
      answers: { purpose: id, questionCount: 2, singleChoiceCount: 2, fillBlankCount: 0, freeResponseCount: 0, size: 'custom' } });
    assert.equal(result.ok, true, JSON.stringify(result));
    let session = result.session;
    result = await service.handle({ action: 'prepare', sessionId: session.sessionId, revision: session.revision,
      operationId: op(), message: request, lockedFields: ['scoringMode'] });
    assert.equal(result.ok, true, JSON.stringify(result)); session = result.session;
    result = await service.handle({ action: 'answer', sessionId: session.sessionId, revision: session.revision,
      operationId: op(), acceptProposal: true });
    assert.equal(result.ok, true, JSON.stringify(result)); session = result.session;
    const requirements = session.requirements;
    assert.equal(requirements.purpose, id);
    assert.equal(requirements.teacherRequest, request);
    assert.equal(requirements.scoringMode, 'none');
    assert.deepEqual(intakeContext.purposeStrategy, purposeStrategy(id));
    assert.ok(intakeContext.lockedFields.includes('scoringMode'));
    const planned = await planBlueprint(requirements, { gateway: { async propose(context) {
      planContext = context;
      return { ok: true, run, proposal: { summary: '固定测试任务，不代表模型教学效果。', slots: [
        { taskId: 'set_determinacy', points: 0, goalIds: [], rationale: '检查集合确定性。' },
        { taskId: 'number_membership', points: 0, goalIds: [], rationale: '检查元素关系。' },
      ] } };
    } } });
    assert.equal(planned.ok, true, JSON.stringify(planned));
    const selected = await createDraft(planned.blueprint, { selectionMode: 'llm', gateway: { async propose(context, { validate }) {
      selectionContexts.push(context);
      return { ok: true, run, proposal: validate(rankingsFor(context)) };
    } } });
    assert.equal(selected.ok, true, JSON.stringify(selected));
    assert.equal(selected.draft.stats.selectedQuestions, 2);
    assert.deepEqual(planContext.purposeStrategy, intakeContext.purposeStrategy);
    assert.ok(selectionContexts.length);
    for (const context of selectionContexts) {
      assert.deepEqual(context.purposeStrategy, intakeContext.purposeStrategy);
      assert.deepEqual(context.requirements.learnedScope, requirements.learnedScope);
      assert.deepEqual(context.requirements.mainScope, requirements.mainScope);
      assert.deepEqual(context.requirements.premises, requirements.premises);
      assert.equal(context.requirements.teacherRequest, request);
      assert.equal(context.purposeStrategy.constraints.noAdditionalHardConstraints, true);
    }
  });
}

test('parallel question-type batches each receive the selected teaching strategy', async () => {
  const types = ['single_choice', 'fill_blank', 'free_response'];
  const slots = types.map((questionType, index) => ({ slotId: `slot-${index}`, questionType, points: 0,
    taskLabel: '检查指定专项', goalIds: [] }));
  const candidates = slots.map((slot, index) => ({ questionId: `question-${index}`, contentVersion: 'v1',
    duplicateGroup: `duplicate-${index}`, status: 'eligible', goalSupport: [],
    allowedSolutionPath: { id: 'path', basis: '已学方法', requiredSections: [], requiredPremises: [] } }));
  const contexts = [];
  const result = await selectWithLlm({ slots, requirements: { purpose: 'targeted_practice', scoringMode: 'none' },
    candidatesBySlot: new Map(slots.map((slot, index) => [slot.slotId, [candidates[index]]])),
    pool: { records: candidates.map((candidate, index) => ({ entry: { questionId: candidate.questionId }, result: { question: {
      ...candidate, teacherVersion: 'teacher-v1', questionType: types[index],
      student: { stem: '专项实际题面', options: [], parts: [], assets: [] }, teacher: { solutions: [] },
    } } })) }, gateway: { async propose(context, { validate }) {
      contexts.push(context); return { ok: true, run, proposal: validate(rankingsFor(context)) };
    } } });
  assert.equal(result.ok, true);
  assert.equal(contexts.length, 3);
  for (const context of contexts) assert.deepEqual(context.purposeStrategy, purposeStrategy('targeted_practice'));
  assert.match(purposeStrategy('targeted_practice').objective, /提升/);
  assert.match(purposeStrategy('diagnostic').selection.join(''), /教师查看答卷判断/);
  assert.equal(new Set(assemblyPurposes.map(item => purposeStrategy(item.id).objective)).size, 3);
});

test('focused practice may repeat one task with distinct real questions instead of broadening to other tasks', async () => {
  const { config } = await getAssemblyConfig();
  const requirements = { purpose: 'targeted_practice', teacherRequest: '只练集合确定性，两道不同题即可，不扩展数集或子集关系。',
    mainScope: config.defaultRequirements.mainScope, counts: { single_choice: 2, fill_blank: 0, free_response: 0 } };
  let context;
  const planned = await planBlueprint(requirements, { gateway: { async propose(input) {
    context = input;
    return { ok: true, run, proposal: { summary: '同一专项安排两道不同题。', slots: [0, 1].map(() => ({
      taskId: 'set_determinacy', points: 0, goalIds: [], rationale: '在集合确定性专项中练习不同对象。',
    })) } };
  } } });
  assert.equal(planned.ok, true, JSON.stringify(planned));
  assert.deepEqual(planned.blueprint.slots.map(slot => slot.taskId), ['set_determinacy', 'set_determinacy']);
  assert.deepEqual(planned.blueprint.requirements.mainScope, requirements.mainScope, 'Narrow focus is not a rewrite of the selected boundary');
  assert.equal(context.purposeStrategy.scopePolicy.requireAllSections, false);
  assert.equal(context.purposeStrategy.scopePolicy.broadenToFillSupplyGap, false);
  assert.equal(context.purposeStrategy.repetitionPolicy.repeatedTaskIdsAllowed, true);
  const selected = await createDraft(planned.blueprint, { selectionMode: 'llm', gateway: { async propose(input, { validate }) {
    return { ok: true, run, proposal: validate(rankingsFor(input)) };
  } } });
  assert.equal(selected.ok, true, JSON.stringify(selected));
  assert.equal(selected.draft.stats.selectedQuestions, 2);
  const identities = selected.draft.slots.map(slot => slot.question.questionId);
  assert.equal(new Set(identities).size, 2, 'Repeating a teaching task must not repeat a question');
});
