import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { getAssemblyConfig, previewBlueprint, recheckBlueprint, createDraft } from '../src/assembly/engine.mjs';
import { receiveAnalysisSubmission } from '../src/assembly/teaching-goals.mjs';
import { applyDraftOperation } from '../src/assembly/editor.mjs';
import { saveDraft } from '../src/assembly/store.mjs';
import { confirmPaper, getPaper } from '../src/assembly/papers.mjs';
import { createAppServer } from '../src/server.mjs';

const goal = (patch = {}) => ({ id: 'teacher-goal-test', version: 1, knowledgeScope: ['1.2'],
  cognition: 'understand', observable: '判断有限集合之间的包含关系并说明依据',
  conditions: { prompt: 'independent', response: 'answer' }, priority: 'required',
  abilities: [], literacies: [], source: { kind: 'teacher', text: '请检查学生是否理解集合关系' }, ...patch });

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tutor-s305-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('tutor-s305-'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('goals steer task proposals by chapter and response form without claiming evidence', async () => {
  const g = goal();
  const result = await previewBlueprint({ teachingGoals: [g], targetDifficulty: null });
  assert.equal(result.ok, true, JSON.stringify(result));
  const plan = result.blueprint;
  assert.equal(plan.requirements.targetDifficulty, null);
  assert.deepEqual(plan.requirements.teachingGoals, [g]);
  assert.equal(plan.generation.mode, 'goal_guided_preset');
  const tasks = (await getAssemblyConfig()).config.tasks;
  assert.ok(plan.slots.filter(slot => slot.questionType === 'single_choice').every(slot => tasks.find(task => task.id === slot.taskId).sectionIds.includes('1.2')));
  assert.equal(plan.goalReview.items[0].status, 'planned');
  assert.ok(plan.slots.filter(slot => slot.goalIds.length).every(slot => plan.supply.slotSupply.find(item => item.slotId === slot.slotId).eligibleCount === 0));
  const proof = await previewBlueprint({ teachingGoals: [goal({ conditions: { prompt: 'independent', response: 'written_reasoning' }, cognition: 'reason' })] });
  assert.ok(proof.blueprint.slots.filter(slot => slot.goalIds.length).every(slot => slot.questionType === 'free_response'));
  assert.equal(proof.blueprint.requirements.teachingGoals[0].cognition, 'reason');
});

test('vague, incomplete and conflicting requirements stay visible and required', async () => {
  for (const observable of ['', '活题', '提高能力']) {
    const result = await previewBlueprint({ teachingGoals: [goal({ observable })] });
    assert.equal(result.ok, true);
    assert.equal(result.blueprint.goalReview.items[0].status, 'pending_clarification');
    assert.ok(result.blueprint.goalReview.items[0].issues.length > 0);
    assert.equal(result.blueprint.requirements.teachingGoals[0].priority, 'required');
  }
  const conflicting = await previewBlueprint({ mainScope: ['1.1'], learnedScope: ['1.1'], teachingGoals: [goal()] });
  assert.deepEqual(conflicting.blueprint.requirements.mainScope, ['1.1']);
  assert.match(conflicting.blueprint.goalReview.items[0].issues.join(';'), /超出本次主考范围/);
  assert.match(conflicting.blueprint.goalReview.items[0].issues.join(';'), /尚未确认已学/);
  assert.equal(conflicting.blueprint.requirements.teachingGoals[0].priority, 'required');
});

test('required support stays unknown; a preference may select but never counts as proven coverage', async () => {
  for (const priority of ['required', 'preferred']) {
    const { blueprint } = await previewBlueprint({ teachingGoals: [goal({ priority })] });
    // Explicitly unrelated slots stay usable after the bank gains tasks in
    // every question type for chapter 1.2.
    blueprint.slots[0].taskId = 'set_determinacy';
    blueprint.slots[0].goalIds = [];
    const result = await createDraft(blueprint);
    assert.equal(result.ok, true);
    const linked = result.draft.slots.filter(slot => slot.goalIds.length);
    if (priority === 'required') assert.ok(linked.every(slot => slot.question === null && slot.status === 'empty'));
    else {
      assert.ok(linked.some(slot => slot.question));
      for (const slot of linked.filter(item => item.question)) {
        assert.equal(slot.selection.selectedReason.goalSupport[0].status, 'unknown');
      }
    }
    assert.ok(result.draft.differences.some(item => item.code === 'goal_support_unknown' && /不计为已证实覆盖/.test(item.message)));
    assert.ok(result.draft.slots.some(slot => !slot.goalIds.length && slot.question), 'unaffected slots must still use real bank supply');
  }
});

test('direct linkage edits recheck without regenerating and keep unassigned must goals', async () => {
  const { blueprint } = await previewBlueprint({ teachingGoals: [goal({ conditions: { prompt: 'independent', response: 'written_reasoning' } })] });
  blueprint.slots.forEach(slot => { slot.goalIds = []; });
  blueprint.slots[0].points = 12;
  const result = await recheckBlueprint(blueprint);
  assert.equal(result.ok, true);
  assert.equal(result.blueprint.slots[0].points, 12);
  assert.ok(result.blueprint.slots.every(slot => slot.goalIds.length === 0));
  assert.equal(result.blueprint.goalReview.items[0].status, 'unassigned');
  const { draft } = await createDraft(result.blueprint);
  assert.equal(draft.baseline.requirements.teachingGoals[0].priority, 'required');
  assert.match(draft.differences.find(item => item.goalId).message, /尚无关联题位/);
  blueprint.slots[0].goalIds = ['teacher-goal-test'];
  const incompatible = await recheckBlueprint(blueprint);
  assert.match(incompatible.blueprint.goalReview.items[0].issues.join(';'), /作答形式.*不兼容/);
});

test('malformed goals and dangling goal identities fail as invalid plans', async () => {
  for (const teachingGoals of [[goal(), goal()], [goal({ version: 0 })], [goal({ knowledgeScope: ['official-code-invented'] })],
    [goal({ priority: 'optional' })], [goal({ source: { kind: 'official', text: 'invented' } })], [goal({ abilities: ['推理', ' 推理'] })]]) {
    const result = await previewBlueprint({ teachingGoals });
    assert.equal(result.error.code, 'invalid_plan');
  }
  const { blueprint } = await previewBlueprint();
  blueprint.slots[0].goalIds = ['dangling-goal'];
  assert.equal((await createDraft(blueprint)).error.code, 'invalid_plan');
});

test('baseline edits retain questions and locks, archive goal definitions and reject reused versions', async () => {
  const { blueprint } = await previewBlueprint({ teachingGoals: [goal({ priority: 'preferred' })] });
  const { draft } = await createDraft(blueprint);
  draft.slots[0].locked = true;
  const changed = goal({ priority: 'required', observable: '说明包含关系并给出反例' });
  const request = { operationId: 'change-goal', expectedRevision: 0, type: 'baseline', requirements: { teachingGoals: [changed] } };
  const invalid = await applyDraftOperation(draft, request);
  assert.equal(invalid.error.code, 'invalid_operation');
  changed.version = 2;
  const result = await applyDraftOperation(draft, request);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.draft.slots[0].locked, true);
  assert.deepEqual(result.draft.slots.map(slot => slot.question), draft.slots.map(slot => slot.question));
  assert.deepEqual(result.draft.baseline.slots[0].goalIds, draft.slots[0].goalIds);
  assert.equal(result.draft.baselineHistory[0].requirements.teachingGoals[0].version, 1);
  assert.equal(result.draft.baseline.requirements.teachingGoals[0].version, 2);
  assert.equal(result.draft.slots[0].applicability.status, 'unknown');
  assert.ok(result.draft.differences.some(item => item.code === 'goal_support_unknown'));
});

test('HTTP goal confirmation and frozen paper preserve exact definitions while legacy plans work', async t => {
  const temp = await temporary(t);
  const storeRoot = path.join(temp, 'drafts'); const papersRoot = path.join(temp, 'papers');
  const server = createAppServer({ storeRoot });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, body) => {
    const response = await fetch(`${url}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  };
  const preview = await post('/api/blueprint', { requirements: { teachingGoals: [goal({ priority: 'preferred' })], targetDifficulty: null } });
  assert.equal(preview.status, 200);
  const result = await post('/api/drafts', { blueprint: preview.blueprint });
  assert.equal(result.status, 201);
  const reopened = await (await fetch(`${url}/api/drafts/${result.draft.draftId}`)).json();
  assert.deepEqual(reopened.draft, result.draft);
  await saveDraft(storeRoot, result.draft);
  const frozen = await confirmPaper(storeRoot, result.draft.draftId, { operationId: 'freeze-goal', expectedRevision: 0, acknowledgeDifferences: true }, { papersRoot });
  assert.equal(frozen.ok, true, JSON.stringify(frozen));
  assert.deepEqual(frozen.paper.draft.baseline.requirements.teachingGoals, result.draft.baseline.requirements.teachingGoals);
  result.draft.baseline.requirements.teachingGoals[0].observable = 'a later change';
  const read = await getPaper(papersRoot, frozen.paper.paperId);
  assert.notEqual(read.paper.draft.baseline.requirements.teachingGoals[0].observable, 'a later change');
  const legacy = await previewBlueprint();
  delete legacy.blueprint.requirements.teachingGoals;
  legacy.blueprint.slots.forEach(slot => { delete slot.goalIds; });
  assert.equal((await createDraft(legacy.blueprint)).draft.stats.selectedQuestions, 10);
});

test('analysis reception preserves producer payload but refuses self-asserted publication', () => {
  const input = { schemaVersion: 1, questionId: 'tutor-set-001', contentVersion: 'unreviewed-content', producer: 'Gemini',
    reviewStatus: 'approved', matchingEligible: true, rawAnalysis: { supports: ['some-goal'], evidence: [], supported: true } };
  const received = receiveAnalysisSubmission(input);
  assert.deepEqual(received.rawAnalysis, input.rawAnalysis);
  assert.deepEqual(received.rawSubmission, input);
  assert.equal(received.reviewStatus, 'pending_review');
  assert.equal(received.matchingEligible, false);
  input.rawAnalysis.supported = false;
  assert.equal(received.rawAnalysis.supported, true);
  for (const bad of [{}, { ...input, contentVersion: null }, { ...input, rawAnalysis: [] }, { ...input, teacherVersion: 3 }]) {
    assert.throws(() => receiveAnalysisSubmission(bad), { code: 'invalid_analysis' });
  }
});
