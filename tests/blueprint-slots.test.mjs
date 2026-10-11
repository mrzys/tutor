import test from 'node:test';
import assert from 'node:assert/strict';
import { getAssemblyConfig, previewBlueprint, recheckBlueprint } from '../src/assembly/engine.mjs';
import { addBlueprintSlot, changeBlueprintTask, removeBlueprintSlot } from '../web/blueprint-review.js';

async function fixture() {
  const { config } = await getAssemblyConfig();
  const { blueprint } = await previewBlueprint({ ...config.defaultRequirements, counts: { single_choice: 2, fill_blank: 1, free_response: 0 } });
  return { config, blueprint };
}

test('adding and removing blueprint slots synchronizes counts and consecutive group numbering accepted by recheck', async () => {
  const { config, blueprint } = await fixture();
  const task = config.tasks.find(task => task.questionType === 'single_choice');
  const added = addBlueprintSlot(blueprint, task, 'manual-choice');
  assert.deepEqual(added.requirements.counts, { single_choice: 3, fill_blank: 1, free_response: 0 });
  assert.deepEqual(added.slots.map(slot => [slot.number, slot.questionType]), [[1, 'single_choice'], [2, 'single_choice'], [3, 'single_choice'], [4, 'fill_blank']]);
  assert.equal(added.slots[2].slotId, 'manual-choice');
  assert.equal((await recheckBlueprint(added)).ok, true);
  const removed = removeBlueprintSlot(added, added.slots[0].slotId);
  assert.deepEqual(removed.requirements.counts, blueprint.requirements.counts);
  assert.deepEqual(removed.slots.map(slot => slot.number), [1, 2, 3]);
  assert.equal(removed.slots[1].slotId, 'manual-choice', 'slot identities remain stable after renumbering');
  assert.equal((await recheckBlueprint(removed)).ok, true);
  assert.equal(blueprint.slots.length, 3, 'editing never mutates the earlier proposal');
});

test('a required goal cannot lose its final slot and is never silently assigned to a new slot', async () => {
  const { config, blueprint } = await fixture();
  const required = { id: 'required-goal', observable: '判断集合包含关系', priority: 'required' };
  blueprint.requirements.teachingGoals = [required];
  blueprint.slots[0].goalIds = [required.id];
  assert.throws(() => removeBlueprintSlot(blueprint, blueprint.slots[0].slotId), /唯一关联题位.*先在其他合适题位/);
  const added = addBlueprintSlot(blueprint, config.tasks.find(task => task.questionType === 'single_choice'), 'practice');
  assert.deepEqual(added.slots.find(slot => slot.slotId === 'practice').goalIds, []);
  added.slots[1].goalIds = [required.id];
  const removed = removeBlueprintSlot(added, added.slots[0].slotId);
  assert.equal(removed.slots.some(slot => slot.goalIds.includes(required.id)), true);
});

test('unscored free response additions carry valid zero-valued parts and legacy additions retain points', async () => {
  const { config, blueprint } = await fixture();
  const task = config.tasks.find(task => task.questionType === 'free_response');
  const unscored = addBlueprintSlot({ ...blueprint, requirements: { ...blueprint.requirements, scoringMode: 'none' } }, task, 'unscored');
  const slot = unscored.slots.find(slot => slot.slotId === 'unscored');
  assert.equal(slot.points, 0);
  assert.deepEqual(slot.partPoints.map(part => part.points), task.partIds.map(() => 0));
  const legacy = addBlueprintSlot(blueprint, task, 'legacy');
  assert.equal(legacy.slots.find(slot => slot.slotId === 'legacy').points, 16);
});

test('blueprint editing respects per-type and overall limits without dropping slots', async () => {
  const { config, blueprint } = await fixture();
  const task = config.tasks.find(task => task.questionType === 'single_choice');
  const choice = blueprint.slots[0];
  const thirty = { ...blueprint, slots: Array.from({ length: 30 }, (_, index) => ({ ...choice, slotId: `slot-${index}` })) };
  assert.throws(() => addBlueprintSlot(thirty, task, 'extra'), /单选最多安排 30/);
  const sixty = { ...blueprint, slots: Array.from({ length: 60 }, (_, index) => ({ ...choice, slotId: `slot-${index}` })) };
  assert.throws(() => addBlueprintSlot(sixty, task, 'extra'), /最多安排 60/);
  assert.throws(() => addBlueprintSlot(blueprint, task, choice.slotId), /身份重复/);
});

test('task changes keep required associations and reject incompatible changes atomically', async () => {
  const { config, blueprint } = await fixture();
  const slot = blueprint.slots[0];
  const originalTask = config.tasks.find(task => task.id === slot.taskId);
  const required = { id: 'required-goal', version: 1, observable: '辨析概念', priority: 'required', knowledgeScope: originalTask.sectionIds,
    cognition: 'understand', conditions: { prompt: 'independent', response: 'answer' }, source: { kind: 'teacher', text: '辨析概念' } };
  blueprint.requirements.teachingGoals = [required];
  slot.goalIds = [required.id];
  const changed = changeBlueprintTask(blueprint, slot.slotId, originalTask);
  assert.deepEqual(changed.slots[0].goalIds, [required.id]);
  assert.throws(() => changeBlueprintTask(blueprint, slot.slotId, { ...originalTask, sectionIds: ['non-matching'] }), /请先将目标关联/);
  assert.deepEqual(slot.goalIds, [required.id]);
  assert.throws(() => changeBlueprintTask(blueprint, slot.slotId, config.tasks.find(task => task.questionType === 'free_response')), /题型不一致/);
  assert.equal((await recheckBlueprint(changed)).ok, true);
});
