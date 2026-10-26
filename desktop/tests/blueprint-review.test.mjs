import test from 'node:test';
import assert from 'node:assert/strict';
import { addBlueprintSlot, blueprintCatalogGaps, blueprintQuantityReview, blueprintReview, editableBlueprintTypes, removeBlueprintSlot, updateBlueprintPoints, updateBlueprintSlot } from '../src/blueprint-review.ts';

const tasks = [
  { id: 'single', questionType: 'single_choice', label: '模拟 $ab$ 单选', sectionIds: ['1.1'], partIds: [] },
  { id: 'fill', questionType: 'fill_blank', label: '模拟 $ab$ 填空', sectionIds: ['1.1'], partIds: [] },
  { id: 'written', questionType: 'free_response', label: '模拟书面推理', sectionIds: ['1.1'], partIds: ['p1', 'p2'] },
  { id: 'outside', questionType: 'single_choice', label: '模拟其它章节', sectionIds: ['2.1'], partIds: [] },
  { id: 'multiple', questionType: 'multiple_choice', label: '模拟多选', sectionIds: ['1.1'], partIds: [] },
];

test('模拟目录缺项：依据当前范围和题型判断，不信缓存、不把其它范围任务当作支持', () => {
  const plan = { requirements: { mainScope: ['rja-compulsory-1:1.1'], counts: {single_choice:1,multiple_choice:1,fill_blank:0,free_response:0} }, slots: [], taskCatalogGaps: [] };
  const before = structuredClone(plan);
  const catalog = tasks.filter(task => task.questionType !== 'multiple_choice').concat({id:'other-multiple',questionType:'multiple_choice',sectionIds:['2.1']});
  assert.deepEqual(blueprintCatalogGaps(plan, catalog), ['multiple_choice']);
  assert.deepEqual(blueprintCatalogGaps(plan, tasks), []);
  assert.deepEqual(plan, before);
});
function fixture() {
  return { requirements: { mainScope: ['1.1'], counts: { single_choice: 1, multiple_choice: 0, fill_blank: 1, free_response: 0 }, questionCount: 2, scoringMode: 'points', targetScore: 20,
    teachingGoals: [{ id: 'g', priority: 'required', knowledgeScope: ['1.1'], conditions: { response: 'answer' } }] },
    quantityReview: { matches: true }, supply: { cached: true }, plannedStats: { questionCount: 2, points: 20 },
    slots: [
      { slotId: 's1', number: 1, questionType: 'single_choice', taskId: 'single', taskLabel: tasks[0].label, goalIds: ['g'], points: 10, partPoints: [], targetDifficultyLevel: 'medium_hard', planningReason: '模拟原规划一' },
      { slotId: 's2', number: 2, questionType: 'single_choice', taskId: 'single', taskLabel: tasks[0].label, goalIds: [], points: 10, partPoints: [], planningReason: '模拟原规划二' },
    ] };
}
test('模拟回归：总量相等仍逐型提示差异，保留零题型且不信旧quantityReview缓存', () => {
  const plan = fixture(), before = structuredClone(plan), review = blueprintQuantityReview(plan);
  assert.equal(review.matches, false); assert.equal(review.expectedTotal, 2); assert.equal(review.actualTotal, 2);
  assert.deepEqual(review.expectedCounts, { single_choice: 1, multiple_choice: 0, fill_blank: 1, free_response: 0 });
  assert.deepEqual(review.actualCounts, { single_choice: 2, multiple_choice: 0, fill_blank: 0, free_response: 0 });
  assert.equal(blueprintReview(plan, tasks).canSelect, false); assert.deepEqual(plan, before);
});
test('模拟回归：显式更换题型与真实任务修复配比，不改需求、身份、难度或其它题位', () => {
  const plan = fixture(), before = structuredClone(plan), next = updateBlueprintSlot(plan, 's1', tasks[1], 10);
  assert.equal(blueprintReview(next, tasks).canSelect, true); assert.deepEqual(next.requirements, before.requirements);
  assert.equal(next.slots[0].slotId, 's1'); assert.equal(next.slots[0].number, 1); assert.equal(next.slots[0].questionType, 'fill_blank');
  assert.deepEqual(next.slots[0].goalIds, ['g']); assert.equal(next.slots[0].targetDifficultyLevel, 'medium_hard');
  assert.equal(Object.hasOwn(next.slots[0], 'planningReason'), false); assert.deepEqual(next.slots[1], before.slots[1]);
  for (const key of ['quantityReview', 'supply', 'plannedStats']) assert.equal(Object.hasOwn(next, key), false);
  assert.deepEqual(plan, before);
});
test('模拟回归：删除与新增只按教师操作增减，连续编号保留已有身份和分值，新题位不自动关联目标', () => {
  const plan = fixture(), before = structuredClone(plan), removed = removeBlueprintSlot(plan, 's1');
  assert.equal(removed.slots.length, 1); assert.equal(removed.slots[0].slotId, 's2'); assert.equal(removed.slots[0].number, 1);
  assert.equal(removed.slots[0].points, 10); assert.equal(removed.slots[0].planningReason, before.slots[1].planningReason);
  assert.deepEqual(blueprintReview(removed, tasks).missingGoals.map(goal => goal.id), ['g']);
  const added = addBlueprintSlot(removed, tasks[1], 0, () => '37d35327-4dce-4819-a6e2-25d190736936');
  assert.equal(added.slots[1].slotId, '37d35327-4dce-4819-a6e2-25d190736936'); assert.equal(added.slots[1].number, 2);
  assert.deepEqual(added.slots[1].goalIds, []); assert.equal(added.slots[1].points, 0); assert.deepEqual(added.slots[0], removed.slots[0]);
  assert.equal(blueprintQuantityReview(added).matches, true); assert.equal(blueprintReview(added, tasks).canSelect, true);
  assert.deepEqual(added.requirements, before.requirements); assert.deepEqual(plan, before);
  assert.throws(() => addBlueprintSlot(plan, tasks[1], 0, () => 's1'));
});
test('模拟回归：新增/修改只允许需求或现有题型与原范围任务，不把范围元数据变成全卷阻断', () => {
  const plan = fixture(); assert.deepEqual(editableBlueprintTypes(plan), ['single_choice', 'fill_blank']);
  assert.throws(() => addBlueprintSlot(plan, tasks[2])); assert.throws(() => addBlueprintSlot(plan, tasks[3]));
  assert.throws(() => updateBlueprintSlot(plan, 's1', tasks[4], 10)); assert.throws(() => removeBlueprintSlot(plan, 'absent'));
  const existing = updateBlueprintSlot(plan, 's1', tasks[1], 10); existing.slots[1].taskId = 'outside';
  assert.equal(blueprintReview(existing, tasks).canSelect, true, 'existing model task outside chapter metadata is still a valid real identity');
  existing.slots[1].taskId = 'absent'; assert.equal(blueprintReview(existing, tasks).invalidTasks.length, 1);
});
test('模拟回归：总分或目标缺口不阻塞选题，逐题无效分值仍拒绝', () => {
  const plan = fixture(); plan.requirements.counts = { single_choice: 1, multiple_choice: 0, fill_blank: 0, free_response: 1 };
  const changed = updateBlueprintSlot(plan, 's1', tasks[2], 11);
  assert.deepEqual(changed.slots[0].partPoints, [{ partId: 'p1', points: 6 }, { partId: 'p2', points: 5 }]);
  assert.equal(changed.slots[1].points, 10); assert.equal(blueprintReview(changed, tasks).canSelect, true);
  const repaired = updateBlueprintPoints(changed, 's2', 9, tasks); assert.equal(blueprintReview(repaired, tasks).canSelect, true);
  assert.equal(repaired.slots[0].points, 11); assert.deepEqual(repaired.requirements, plan.requirements);
  assert.equal(blueprintReview(updateBlueprintPoints(repaired, 's2', -1, tasks), tasks).invalidPoints.length, 1);
  repaired.slots[0].partPoints[1].points = 4; assert.equal(blueprintReview(repaired, tasks).invalidPoints.length, 1);
});
test('模拟回归：不计分新增保持零分，真实生成UUID，零题位仍能从需求补回', () => {
  const plan = fixture(); plan.requirements.scoringMode = 'none'; plan.requirements.targetScore = 0;
  const empty = removeBlueprintSlot(removeBlueprintSlot(plan, 's1'), 's2');
  assert.deepEqual(editableBlueprintTypes(empty), ['single_choice', 'fill_blank']);
  const next = addBlueprintSlot(empty, tasks[0], 25);
  assert.match(next.slots[0].slotId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/i); assert.equal(next.slots[0].points, 0);
  assert.equal(blueprintReview(next, tasks).canSelect, true); assert.throws(() => addBlueprintSlot(empty, tasks[0], 1.5));
});

test('模拟不足不阻塞：部分及空规划可继续，原定数量不变，超量与假任务仍拒绝', () => {
  const original = fixture(), plan = removeBlueprintSlot(original, 's2'), before = structuredClone(plan);
  assert.equal(blueprintReview(plan, tasks).quantity.matches, false);
  assert.equal(blueprintReview(plan, tasks).canSelect, true);
  const empty = removeBlueprintSlot(plan, 's1');
  assert.equal(blueprintReview(empty, tasks).canSelect, true);
  assert.equal(blueprintReview(empty, tasks).missingGoals.length, 1);
  assert.equal(blueprintReview(original, tasks).hasExcess, true);
  assert.equal(blueprintReview(original, tasks).canSelect, false);
  const invalid = structuredClone(plan); invalid.slots[0].taskId = 'fake';
  assert.equal(blueprintReview(invalid, tasks).canSelect, false);
  assert.deepEqual(plan, before); assert.deepEqual(empty.requirements, original.requirements);
});
