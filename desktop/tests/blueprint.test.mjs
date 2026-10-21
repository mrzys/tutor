import test from 'node:test';
import assert from 'node:assert/strict';
import { availableTasks, bindBlueprintGoal, changeBlueprintTask, goalFitsTask, linkedGoalSlots, missingRequiredGoals } from '../src/blueprint-goals.ts';

const tasks = [
  { id: 'a', label: '模拟集合判定', questionType: 'single_choice', sectionIds: ['1.1'], partIds: [] },
  { id: 'b', label: '模拟数集关系', questionType: 'single_choice', sectionIds: ['rja-compulsory-1:1.1'], partIds: [] },
  { id: 'c', label: '模拟集合运算', questionType: 'single_choice', sectionIds: ['1.3'], partIds: [] },
  { id: 'r', label: '模拟书面推理', questionType: 'free_response', sectionIds: ['1.1'], partIds: ['p1', 'p2'] },
  { id: 'outside', label: '模拟范围外任务', questionType: 'single_choice', sectionIds: ['2.1'], partIds: [] },
];
const goals = [
  { id: 'g', observable: '模拟必须目标', priority: 'required', knowledgeScope: ['1.1'], conditions: { response: 'answer' } },
  { id: 'p', observable: '模拟偏好目标', priority: 'preferred', knowledgeScope: ['1.1'], conditions: { response: 'answer' } },
  { id: 'w', observable: '模拟推理目标', priority: 'preferred', knowledgeScope: ['1.1'], conditions: { response: 'written_reasoning' } },
];
function fixture() { return { requirements: { mainScope: ['1.1', '1.3'], teachingGoals: structuredClone(goals) }, supply: { old: true },
  slots: [
    { slotId: 's1', number: 1, taskId: 'a', taskLabel: tasks[0].label, questionType: 'single_choice', goalIds: ['g', 'p'], points: 10, partPoints: [], planningReason: '模拟旧任务的规划理由' },
    { slotId: 's2', number: 2, taskId: 'b', questionType: 'single_choice', goalIds: ['p'], points: 10, partPoints: [], planningReason: '模拟其它题位理由' },
    { slotId: 's3', number: 3, taskId: 'r', questionType: 'free_response', goalIds: ['w'], points: 11, partPoints: [{ partId: 'p1', points: 6 }, { partId: 'p2', points: 5 }] },
  ] }; }

test('模拟回归：更换兼容任务保留目标、总题量及其它题位，移除旧理由与供给缓存', () => {
  const plan = fixture(), before = structuredClone(plan), next = changeBlueprintTask(plan, 's1', tasks[1]);
  assert.deepEqual(next.slots[0].goalIds, ['g', 'p']); assert.equal(missingRequiredGoals(next, tasks).length, 0);
  assert.equal(Object.hasOwn(next.slots[0], 'planningReason'), false); assert.equal(Object.hasOwn(next, 'supply'), false);
  assert.deepEqual(next.slots[1], before.slots[1]); assert.deepEqual(next.requirements, before.requirements); assert.equal(next.slots.length, 3); assert.deepEqual(plan, before);
  assert.equal(changeBlueprintTask(plan, 's1', tasks[0]), plan);
});
test('模拟回归：不兼容关联不保留，必须目标显示缺口，可显式重绑后继续', () => {
  const changed = changeBlueprintTask(fixture(), 's1', tasks[2]); assert.deepEqual(changed.slots[0].goalIds, []);
  assert.deepEqual(missingRequiredGoals(changed, tasks).map(goal => goal.id), ['g']);
  const bound = bindBlueprintGoal(changed, 'g', ['s2'], tasks);
  assert.deepEqual(bound.slots[1].goalIds, ['p', 'g']); assert.equal(missingRequiredGoals(bound, tasks).length, 0);
  assert.equal(Object.hasOwn(bound.slots[1], 'planningReason'), false); assert.deepEqual(changed.slots[1].goalIds, ['p']);
});
test('模拟回归：拒绝范围、作答形式、身份错误及必须目标空绑定', () => {
  const plan = fixture(); assert.equal(goalFitsTask(goals[2], tasks[0]), false); assert.equal(goalFitsTask(goals[2], tasks[3]), true);
  assert.throws(() => bindBlueprintGoal(plan, 'g', [], tasks)); assert.throws(() => bindBlueprintGoal(plan, 'w', ['s1'], tasks));
  assert.throws(() => bindBlueprintGoal(plan, 'g', ['missing'], tasks)); assert.throws(() => bindBlueprintGoal(plan, 'unknown', ['s1'], tasks));
  assert.throws(() => changeBlueprintTask(plan, 's1', tasks[3])); assert.throws(() => changeBlueprintTask(plan, 's1', tasks[4]));
  assert.deepEqual(availableTasks(plan, plan.slots[0], tasks).map(task => task.id), ['a', 'b', 'c']);
  const bound = bindBlueprintGoal(plan, 'w', ['s3'], tasks); assert.equal(bound.slots[1].planningReason, plan.slots[1].planningReason);
});
test('模拟回归：偏好目标可取消，重绑只修改指定目标并拒绝失效任务作为承担者', () => {
  const plan = fixture(), next = bindBlueprintGoal(plan, 'p', [], tasks);
  assert.deepEqual(next.slots[0].goalIds, ['g']); assert.deepEqual(next.slots[1].goalIds, []); assert.deepEqual(next.slots[2].goalIds, ['w']);
  plan.slots[0].taskId = 'missing'; assert.equal(linkedGoalSlots(plan, goals[0], tasks).length, 0);
});
