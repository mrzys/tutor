import test from 'node:test';
import assert from 'node:assert/strict';
import { previewBlueprint, createDraft } from '../src/assembly/engine.mjs';
import { combineRankings, validateSelectionProposal, selectWithLlm } from '../src/assembly/selector.mjs';
import { createSelectionGateway } from '../src/llm/selection-gateway.mjs';

const run = { provider: 'fixture', model: 'fixture-ranker', status: 'succeeded' };
function proposalFor(context, reverse = false) {
  return { summary: '比较实际题面活动；目标支持仍待复核。', rankings: context.slots.map(slot => ({
    slotId: slot.slotId,
    candidates: (reverse ? [...slot.candidates].reverse() : slot.candidates).map(id => {
      const candidate = context.candidates.find(item => item.questionId === id);
      return { questionId: id, contentVersion: candidate.contentVersion, teacherVersion: candidate.teacherVersion,
        rationale: '由题面所需的概念辨析活动与本次练习意图比较，支持状态仍待复核。', evidenceRefs: ['student.stem'] };
    }),
  })) };
}
const gateway = reverse => ({ async propose(context, options) {
  const proposal = proposalFor(context, reverse);
  options.validate(proposal);
  return { ok: true, proposal, run };
} });

test('AI candidate comparison changes first choice using real body evidence and preserves auditable model rankings', async () => {
  const { blueprint } = await previewBlueprint({ counts: { single_choice: 1, fill_blank: 0, free_response: 0 } });
  const rule = await createDraft(blueprint);
  let captured;
  const result = await createDraft(blueprint, { selectionMode: 'llm', gateway: { async propose(context, options) {
    captured = context;
    return gateway(true).propose(context, options);
  } } });
  assert.equal(result.ok, true, JSON.stringify(result));
  const slot = result.draft.slots[0];
  assert.notEqual(slot.question.questionId, rule.draft.slots[0].question.questionId);
  assert.equal(slot.question.questionId, captured.slots[0].candidates.at(-1));
  assert.ok(captured.candidates.every(candidate => candidate.evidence['student.stem'] && candidate.evidence['allowedSolutionPath.basis']));
  assert.ok(captured.candidates.every(candidate => candidate.imageAvailability.pixelsProvided === false));
  assert.equal(slot.selection.selectedReason.method, 'llm_candidate_ranking_global_assignment');
  assert.equal(slot.selection.selectedReason.evidence[0].text, slot.question.student.stem);
  assert.equal(result.draft.selectionGeneration.run.model, 'fixture-ranker');
  assert.equal(result.draft.selectionGeneration.rankings[0].candidates.length, captured.slots[0].candidates.length);
  assert.equal(result.draft.selectionGeneration.combination.selectedQuestions, 1);
  assert.equal(result.draft.stats.difficultyEstimate, null);
});

const context = {
  slots: [{ slotId: 'slot-1', candidates: ['q-1', 'q-2'] }],
  candidates: ['q-1', 'q-2'].map(questionId => ({ questionId, contentVersion: 'content-1', teacherVersion: 'teacher-1', evidence: { 'student.stem': '真实题面' } })),
};
test('candidate identity, version, full shortlist, duplicate and exact evidence validation reject fabricated model output', () => {
  const changes = [
    proposal => { proposal.rankings[0].slotId = 'unknown'; },
    proposal => { proposal.rankings[0].candidates[0].questionId = 'invented'; },
    proposal => { proposal.rankings[0].candidates[0].contentVersion = 'stale'; },
    proposal => { proposal.rankings[0].candidates[0].teacherVersion = 'stale'; },
    proposal => { proposal.rankings[0].candidates.pop(); },
    proposal => { proposal.rankings[0].candidates[1] = proposal.rankings[0].candidates[0]; },
    proposal => { proposal.rankings[0].candidates[0].evidenceRefs = ['teacher.solutions[999].text']; },
    proposal => { proposal.rankings[0].candidates[0].evidenceRefs = ['student.stem', 'student.stem']; },
  ];
  for (const change of changes) {
    const proposal = proposalFor(context);
    change(proposal);
    assert.throws(() => validateSelectionProposal(proposal, context));
  }
});

function rank(slotId, ids) { return { slotId, candidates: ids.map(questionId => ({ questionId, rationale: questionId })) }; }
const slotIds = (...ids) => ids.map(slotId => ({ slotId }));
const groupMap = groups => new Map(Object.entries(groups).map(([questionId, duplicateGroup]) => [questionId, { duplicateGroup }]));
test('global combination prevents greedy starvation and treats duplicateGroup as a capacity-one resource', () => {
  const result = combineRankings(slotIds('flexible', 'only-a'), [rank('flexible', ['a1', 'b']), rank('only-a', ['a2'])],
    groupMap({ a1: 'same-a', a2: 'same-a', b: 'group-b' }));
  assert.equal(result.summary.selectedQuestions, 2);
  assert.equal(result.assignments.get('flexible').questionId, 'b');
  assert.equal(result.assignments.get('only-a').questionId, 'a2');
  assert.equal(result.summary.preferenceCost, 1);
});
test('global combination minimizes total model rank cost after maximum fill and is stable for ties', () => {
  const rankings = [rank('s1', ['a', 'b']), rank('s2', ['b', 'a'])];
  const candidates = groupMap({ a: 'a', b: 'b' });
  const first = combineRankings(slotIds('s1', 's2'), rankings, candidates);
  assert.equal(first.assignments.get('s1').questionId, 'a');
  assert.equal(first.assignments.get('s2').questionId, 'b');
  assert.equal(first.summary.preferenceCost, 0);
  assert.deepEqual(first, combineRankings(slotIds('s1', 's2'), rankings, candidates));
  const missing = combineRankings(slotIds('s1', 's2'), [rank('s1', ['a']), rank('s2', ['b'])], groupMap({ a: 'same', b: 'same' }));
  assert.equal(missing.summary.missingQuestions, 1);
});

test('global solver matches an exhaustive independent optimum for every three-slot three-group supply graph', () => {
  const slots = slotIds('s0', 's1', 's2');
  const candidates = groupMap({ a: 'a', b: 'b', c: 'c' });
  for (let mask = 0; mask < 512; mask++) {
    const rankings = slots.map((slot, index) => rank(slot.slotId,
      ['a', 'b', 'c'].filter((id, group) => mask & (1 << (index * 3 + group))).reverse()));
    let optimum = { filled: -1, cost: Infinity };
    const enumerate = (index, used, filled, cost) => {
      if (index === slots.length) {
        if (filled > optimum.filled || (filled === optimum.filled && cost < optimum.cost)) optimum = { filled, cost };
        return;
      }
      enumerate(index + 1, used, filled, cost);
      rankings[index].candidates.forEach((candidate, rankIndex) => {
        if (used.has(candidate.questionId)) return;
        enumerate(index + 1, new Set([...used, candidate.questionId]), filled + 1, cost + rankIndex);
      });
    };
    enumerate(0, new Set(), 0, 0);
    const result = combineRankings(slots, rankings, candidates);
    assert.equal(result.summary.selectedQuestions, optimum.filled, `mask=${mask}`);
    assert.equal(result.summary.preferenceCost, optimum.cost, `mask=${mask}`);
  }
});

test('model error, invalid ranking and unconfigured model never silently fall back or return a draft', async () => {
  const { blueprint } = await previewBlueprint({ counts: { single_choice: 1, fill_blank: 0, free_response: 0 } });
  for (const candidateGateway of [
    { async propose() { return { ok: false, error: { code: 'model_error', message: '失败' }, run: { ...run, status: 'model_error' } }; } },
    { async propose(context) { const proposal = proposalFor(context); proposal.rankings[0].candidates[0].questionId = 'invented'; return { ok: true, proposal, run }; } },
    createSelectionGateway({ env: {} }),
  ]) {
    const result = await createDraft(blueprint, { selectionMode: 'llm', gateway: candidateGateway });
    assert.equal(result.ok, false);
    assert.equal(result.draft, undefined);
    assert.ok(['model_error', 'invalid_model_output', 'not_configured'].includes(result.error.code));
  }
});
test('pre-aborted and in-flight cancelled model requests cannot create a draft even when gateway ignores signal', async () => {
  const { blueprint } = await previewBlueprint({ counts: { single_choice: 1, fill_blank: 0, free_response: 0 } });
  const before = new AbortController(); before.abort();
  let called = false;
  const first = await createDraft(blueprint, { selectionMode: 'llm', signal: before.signal, gateway: { async propose() { called = true; } } });
  assert.equal(called, false); assert.equal(first.error.code, 'cancelled');
  const during = new AbortController();
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const work = createDraft(blueprint, { selectionMode: 'llm', signal: during.signal, gateway: { async propose() { entered(); return new Promise(() => {}); } } });
  await started; during.abort();
  const second = await work;
  assert.equal(second.error.code, 'cancelled'); assert.equal(second.draft, undefined);
});
test('required goals lacking reviewed support remain unknown and empty without a model call', async () => {
  const { blueprint } = await previewBlueprint({ counts: { single_choice: 1, fill_blank: 0, free_response: 0 },
    teachingGoals: [{ id: 'g1', version: 1, knowledgeScope: ['1.1'], cognition: 'understand', observable: '辨析集合定义并解释判断依据',
      priority: 'required', abilities: ['逻辑推理'], literacies: ['数学抽象'], conditions: { prompt: 'unspecified', response: 'unspecified' }, source: { kind: 'teacher', text: '必须能辨析集合定义' } }] });
  let called = false;
  const result = await createDraft(blueprint, { selectionMode: 'llm', gateway: { async propose() { called = true; throw new Error('不得调用'); } } });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(called, false);
  assert.equal(result.draft.stats.selectedQuestions, 0);
  assert.ok(result.draft.slots[0].selection.suggestions.some(candidate => candidate.goalSupport?.some(goal => goal.status === 'unknown')));
  assert.ok(result.draft.differences.some(item => item.code === 'goal_support_unknown'));
});

test('shortlist resource cap is explicit and large real candidate sets are batched without omitting ranked slots', async () => {
  const question = id => ({ questionId: id, contentVersion: 'content-1', teacherVersion: 'teacher-1', questionType: 'single_choice',
    student: { stem: `${id} 的实际题面`, options: [], parts: [], assets: [{ assetId: 'image', alt: '不可当作图像读取' }] }, teacher: { solutions: [] } });
  const candidates = Array.from({ length: 12 }, (_, index) => ({ questionId: `q-${index}`, contentVersion: 'content-1', status: 'eligible', duplicateGroup: `group-${index}`,
    goalSupport: [], allowedSolutionPath: { id: 'p1', basis: '已经复核的完整允许路径', requiredSections: [], requiredPremises: [] } }));
  const slots = Array.from({ length: 10 }, (_, index) => ({ slotId: `s-${index}`, taskLabel: '概念辨析', goalIds: [], points: 10 }));
  let calls = 0;
  const result = await selectWithLlm({ slots, requirements: {},
    pool: { records: candidates.map(candidate => ({ entry: { questionId: candidate.questionId }, result: { question: question(candidate.questionId) } })) },
    candidatesBySlot: new Map(slots.map(slot => [slot.slotId, candidates])),
    gateway: { async propose(context, options) { calls++; assert.ok(context.slots.length <= 8); return gateway(false).propose(context, options); } } });
  assert.equal(result.ok, true); assert.equal(calls, 2);
  assert.ok(result.selectionGeneration.shortlists.every(list => list.truncated && list.eligibleCount === 12 && list.shortlistedCount === 8));
  assert.equal(result.selectionGeneration.rankings.length, 10);
  assert.equal(result.selectionGeneration.combination.selectedQuestions, 10);
  assert.equal(result.selectionGeneration.combination.fullEligibleMaximumFill, 10);
  assert.equal(result.selectionGeneration.combination.shortlistPreservesMaximumFill, true);
  assert.equal(result.selectionGeneration.combination.scope, 'eligible_shortlists_only');
  assert.equal(result.selectionGeneration.candidateEvidenceSnapshot[0].imageAvailability.pixelsProvided, false);
});
