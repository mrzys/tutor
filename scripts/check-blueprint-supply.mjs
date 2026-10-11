import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { getAssemblyConfig, previewBlueprint, recheckBlueprint, createDraft, partAllocation } from '../src/assembly/engine.mjs';

// Real bank scenarios: these read current packages, never invent question IDs.
export async function checkBlueprintSupply() {
  const loaded = await getAssemblyConfig();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  const config = loaded.config;
  const types = ['single_choice', 'fill_blank', 'free_response'];
  const groups = Object.fromEntries(types.map(type => [type, config.tasks.filter(task => task.questionType === type)]));
  const counts = Object.fromEntries(types.map(type => [type, groups[type].length]));
  const allPremises = config.premises.map(premise => premise.id);
  const proposed = await previewBlueprint({ counts, targetScore: config.tasks.length * 10, premises: allPremises });
  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  const positions = Object.fromEntries(types.map(type => [type, 0]));
  for (const slot of proposed.blueprint.slots) {
    const task = groups[slot.questionType][positions[slot.questionType]++];
    slot.taskId = task.id;
    slot.partPoints = partAllocation(task, slot.points);
  }
  const checked = await recheckBlueprint(proposed.blueprint);
  assert.equal(checked.ok, true, JSON.stringify(checked));
  assert.ok(checked.blueprint.supply.slotSupply.every(slot => slot.eligibleCount > 0), 'Every visible task needs actual eligible supply');
  const result = await createDraft(checked.blueprint);
  assert.equal(result.ok, true, JSON.stringify(result));
  const selected = result.draft.slots.filter(slot => slot.question);
  assert.equal(selected.length, config.tasks.length, 'Task coverage must result in actual complete selected parents');
  assert.equal(new Set(selected.map(slot => slot.question.questionId)).size, selected.length);
  assert.equal(result.draft.retrieval.failures.length, 0);

  const repeated = await previewBlueprint({ counts: { single_choice: 4, fill_blank: 0, free_response: 0 } });
  repeated.blueprint.slots.forEach(slot => { slot.taskId = 'set_object_equality'; });
  const equality = await createDraft(repeated.blueprint);
  assert.equal(equality.ok, true, JSON.stringify(equality));
  assert.equal(equality.draft.stats.selectedQuestions, 3);
  assert.equal(equality.draft.slots[3].question, null, 'Exhausted supply stays empty');
  assert.equal(new Set(equality.draft.slots.filter(slot => slot.question).map(slot => slot.question.questionId)).size, 3);

  const restricted = structuredClone(checked.blueprint);
  restricted.requirements.learnedScope = ['1.1'];
  restricted.requirements.premises = [];
  const narrow = await createDraft(restricted);
  assert.equal(narrow.ok, true, JSON.stringify(narrow));
  assert.ok(narrow.draft.stats.missingQuestions > 0);
  for (const slot of narrow.draft.slots.filter(slot => slot.question)) {
    const solution = slot.selection.selectedReason.allowedSolutionPath;
    assert.ok(solution.requiredSections.every(id => id === '1.1'));
    assert.deepEqual(solution.requiredPremises, []);
  }
  const legacy = await previewBlueprint();
  const legacyDraft = await createDraft(legacy.blueprint);
  assert.equal(legacyDraft.draft.stats.selectedQuestions, 10);
  assert.equal(legacyDraft.draft.stats.availablePoints, 100);
  return { sourceUnits: checked.blueprint.supply.sourceUnits, ready: checked.blueprint.supply.ready,
    pending: checked.blueprint.supply.pendingCount, taskCount: config.tasks.length, counts,
    allTasks: { premises: allPremises, selected: selected.length, uniqueParents: selected.length,
      slotSupply: checked.blueprint.slots.map(slot => ({ taskId: slot.taskId,
        eligible: checked.blueprint.supply.slotSupply.find(item => item.slotId === slot.slotId).eligibleCount,
        selectedId: selected.find(item => item.slotId === slot.slotId)?.question.questionId })) },
    repeatedEquality: { requested: 4, selected: 3, missing: 1 },
    narrowedBoundary: narrow.draft.stats,
    defaultPaper: legacyDraft.draft.stats,
    limitation: '具体任务供给核验，不等于四维教学目标支持复核、难度标定或教师采用。' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await checkBlueprintSupply(), null, 2));
}
