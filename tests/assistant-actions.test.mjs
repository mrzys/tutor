import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBlueprintActions, draftOperationsFor } from '../web/assistant-actions.js';

const tasks = [
  { id: 'concept', label: '辨析集合概念', questionType: 'single_choice', sectionIds: ['1.1'], partIds: [] },
  { id: 'relation', label: '判断包含关系', questionType: 'single_choice', sectionIds: ['1.2'], partIds: [] },
  { id: 'blank', label: '求交集', questionType: 'fill_blank', sectionIds: ['1.2'], partIds: [] },
  { id: 'proof', label: '论证包含关系', questionType: 'free_response', sectionIds: ['1.2'], partIds: ['p1', 'p2'], partWeights: [1, 2] },
];

function blueprint() {
  return { schemaVersion: 1,
    requirements: { counts: { single_choice: 2, fill_blank: 1, free_response: 0 }, mainScope: ['1.1', '1.2'], premises: ['arithmetic'], teachingGoals: [], targetScore: 26 },
    generation: { mode: 'llm', countPolicy: 'suggested' },
    slots: [
      { slotId: 'original-one', number: 1, questionType: 'single_choice', taskId: 'concept', points: 8, partPoints: [], goalIds: [] },
      { slotId: 'original-two', number: 2, questionType: 'single_choice', taskId: 'concept', points: 8, partPoints: [], goalIds: [] },
      { slotId: 'original-three', number: 3, questionType: 'fill_blank', taskId: 'blank', points: 10, partPoints: [], goalIds: [] },
    ] };
}

function ids() { let count = 0; return () => `added-${++count}`; }

test('a deletion cannot retarget later original question numbers after renumbering', () => {
  const original = blueprint();
  const next = applyBlueprintActions(original, [
    { type: 'delete', numbers: [1] },
    { type: 'set_task', numbers: [2], taskId: 'relation' },
    { type: 'difficulty', numbers: [3], targetDifficulty: .6 },
  ], tasks);
  assert.deepEqual(next.slots.map(slot => [slot.slotId, slot.number, slot.taskId]), [['original-two', 1, 'relation'], ['original-three', 2, 'blank']]);
  assert.equal(next.slots[1].targetDifficulty, .6);
  assert.deepEqual(original, blueprint());
});

test('deleting the last required-goal slot fails atomically even after an earlier successful edit', () => {
  const original = blueprint();
  original.requirements.teachingGoals = [{ id: 'required', priority: 'required', observable: '说明集合关系', knowledgeScope: ['1.1'], conditions: { response: 'answer' } }];
  original.slots[0].goalIds = ['required'];
  const snapshot = structuredClone(original);
  assert.throws(() => applyBlueprintActions(original, [
    { type: 'add', taskId: 'concept', count: 1, afterNumber: null },
    { type: 'delete', numbers: [1] },
  ], tasks, ids()), /唯一关联题位/);
  assert.deepEqual(original, snapshot);
});

test('additions in unscored blueprints and drafts have no invented points', () => {
  const original = blueprint();
  original.requirements.scoringMode = 'none';
  const next = applyBlueprintActions(original, [{ type: 'add', taskId: 'proof', count: 1, afterNumber: null }], tasks, ids());
  const added = next.slots.at(-1);
  assert.equal(added.points, 0);
  assert.deepEqual(added.partPoints, [{ partId: 'p1', points: 0 }, { partId: 'p2', points: 0 }]);
  const operations = draftOperationsFor([{ type: 'add', taskId: 'concept', count: 1, afterNumber: 1 }], { slots: original.slots, baseline: { requirements: original.requirements } }, tasks);
  assert.deepEqual(operations, [{ type: 'add', taskId: 'concept', points: 0, afterSlotId: 'original-one' }]);
});

test('multiple premise approvals accumulate with independent snapshots and preserve draft input', () => {
  const original = blueprint();
  const draft = { slots: original.slots, baseline: { requirements: original.requirements } };
  const snapshot = structuredClone(draft);
  const actions = [
    { type: 'allow_premise', premiseId: 'vieta' },
    { type: 'allow_premise', premiseId: 'quadratic' },
    { type: 'allow_premise', premiseId: 'vieta' },
  ];
  const operations = draftOperationsFor(actions, draft, tasks);
  assert.deepEqual(operations.map(operation => operation.requirements.premises), [
    ['arithmetic', 'vieta'], ['arithmetic', 'vieta', 'quadratic'], ['arithmetic', 'vieta', 'quadratic'],
  ]);
  assert.deepEqual(applyBlueprintActions(original, actions, tasks).requirements.premises, ['arithmetic', 'vieta', 'quadratic']);
  assert.deepEqual(draft, snapshot);
});

test('same-type additions honor the original insertion anchor and preserve order across actions', () => {
  const next = applyBlueprintActions(blueprint(), [
    { type: 'add', taskId: 'relation', count: 2, afterNumber: 1 },
    { type: 'add', taskId: 'concept', count: 1, afterNumber: 1 },
  ], tasks, ids());
  assert.deepEqual(next.slots.map(slot => slot.slotId), ['original-one', 'added-1', 'added-2', 'added-3', 'original-two', 'original-three']);
  assert.deepEqual(next.slots.map(slot => slot.number), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(next.requirements.counts, { single_choice: 5, fill_blank: 1, free_response: 0 });
});

test('insertion anchors retain stable identities after earlier deletions', () => {
  const next = applyBlueprintActions(blueprint(), [
    { type: 'delete', numbers: [1] },
    { type: 'add', taskId: 'concept', count: 1, afterNumber: 2 },
  ], tasks, ids());
  assert.deepEqual(next.slots.map(slot => slot.slotId), ['original-two', 'added-1', 'original-three']);
});

test('cross-type or removed insertion anchors are rejected explicitly without changing input', () => {
  const original = blueprint();
  const snapshot = structuredClone(original);
  assert.throws(() => applyBlueprintActions(original, [{ type: 'add', taskId: 'blank', count: 1, afterNumber: 1 }], tasks, ids()), /按题型分组.*同题型/);
  assert.throws(() => applyBlueprintActions(original, [
    { type: 'delete', numbers: [1] }, { type: 'add', taskId: 'concept', count: 1, afterNumber: 1 },
  ], tasks, ids()), /新增位置第 1 题已不存在/);
  assert.throws(() => applyBlueprintActions(original, [
    { type: 'delete', numbers: [1] }, { type: 'difficulty', numbers: [1], targetDifficulty: .5 },
  ], tasks), /题位已删除/);
  assert.deepEqual(original, snapshot);
  const draft = { slots: original.slots, baseline: { requirements: original.requirements } };
  assert.throws(() => draftOperationsFor([{ type: 'add', taskId: 'blank', count: 1, afterNumber: 1 }], draft, tasks), /按题型分组.*同题型/);
  assert.throws(() => draftOperationsFor([{ type: 'add', taskId: 'concept', count: 1, afterNumber: 99 }], draft, tasks), /没有第 99 题/);
});

test('default insertion appends inside its type group and draft operations resolve original IDs upfront', () => {
  const original = blueprint();
  const next = applyBlueprintActions(original, [{ type: 'add', taskId: 'concept', count: 1, afterNumber: null }], tasks, ids());
  assert.deepEqual(next.slots.map(slot => slot.slotId), ['original-one', 'original-two', 'added-1', 'original-three']);
  const operations = draftOperationsFor([
    { type: 'delete', numbers: [1] }, { type: 'replace', numbers: [2] }, { type: 'difficulty', numbers: [3], targetDifficulty: .4 },
  ], { slots: original.slots, baseline: { requirements: original.requirements } }, tasks);
  assert.deepEqual(operations, [
    { type: 'delete', slotId: 'original-one' },
    { type: 'replace', slotIds: ['original-two'], mode: 'direct' },
    { type: 'difficulty', slotIds: ['original-three'], targetDifficulty: .4, mode: 'direct' },
  ]);
});


test('same-knowledge assistant replacement preserves explicit alternative task identity', () => {
  const draft = { slots: [{ number: 1, slotId: 'stable-id' }], baseline: { requirements: {} } };
  assert.deepEqual(draftOperationsFor([{ type: 'replace', numbers: [1], taskId: 'alternative-task' }], draft, []),
    [{ type: 'replace', slotIds: ['stable-id'], mode: 'direct', taskId: 'alternative-task' }]);
});
