import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSlotsByType, slotsAreGroupedByType } from '../src/assembly/slot-order.mjs';
import { previewBlueprint, recheckBlueprint, createDraft } from '../src/assembly/engine.mjs';
import { applyDraftOperation } from '../src/assembly/editor.mjs';
import { projectPaper } from '../src/output/pdf.mjs';

function interleave(slots) {
  const choices = slots.filter(slot => slot.questionType === 'single_choice');
  const blanks = slots.filter(slot => slot.questionType === 'fill_blank');
  const responses = slots.filter(slot => slot.questionType === 'free_response');
  return [choices[0], blanks[0], ...choices.slice(1), ...responses, ...blanks.slice(1)]
    .filter(Boolean).map((slot, index) => ({ ...slot, number: index + 1 }));
}

test('stable type grouping preserves identities and content without mutating the input', () => {
  const slots = [
    { slotId: 'a', number: 1, questionType: 'single_choice', locked: true, question: { id: 'a' } },
    { slotId: 'b', number: 2, questionType: 'fill_blank', goalIds: ['goal'] },
    { slotId: 'c', number: 3, questionType: 'single_choice' },
    { slotId: 'd', number: 4, questionType: 'free_response', partPoints: [{ partId: 'p1', points: 5 }] },
  ];
  const before = structuredClone(slots);
  const grouped = groupSlotsByType(slots);
  assert.deepEqual(grouped.map(slot => [slot.slotId, slot.number]), [['a', 1], ['c', 2], ['b', 3], ['d', 4]]);
  assert.deepEqual(slots, before);
  for (const slot of grouped) assert.deepEqual({ ...slot, number: before.find(item => item.slotId === slot.slotId).number }, before.find(item => item.slotId === slot.slotId));
  assert.equal(slotsAreGroupedByType(slots), false);
  assert.equal(slotsAreGroupedByType(grouped), true);
});

test('blueprint recheck and draft creation agree on grouped order and sequential numbers', async () => {
  const preview = await previewBlueprint({});
  assert.equal(preview.ok, true);
  const mixed = { ...preview.blueprint, slots: interleave(preview.blueprint.slots) };
  assert.equal(slotsAreGroupedByType(mixed.slots), false);
  const checked = await recheckBlueprint(mixed);
  const created = await createDraft(mixed);
  assert.equal(checked.ok, true, JSON.stringify(checked.error));
  assert.equal(created.ok, true, JSON.stringify(created.error));
  const expected = groupSlotsByType(mixed.slots).map(slot => [slot.slotId, slot.number]);
  assert.deepEqual(checked.blueprint.slots.map(slot => [slot.slotId, slot.number]), expected);
  assert.deepEqual(created.draft.slots.map(slot => [slot.slotId, slot.number]), expected);
  assert.deepEqual(created.draft.baseline.slots.map(slot => [slot.slotId, slot.number]), expected);
});

test('legacy grouping is revisioned, replayable and preserves baseline, locks and questions', async () => {
  const preview = await previewBlueprint({});
  const { draft } = await createDraft(preview.blueprint);
  draft.slots = interleave(draft.slots);
  draft.slots[0].locked = true;
  const before = structuredClone(draft);
  const operation = { type: 'group_by_type', operationId: 'group-legacy', expectedRevision: draft.revision ?? 0 };
  const result = await applyDraftOperation(draft, operation);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.draft.revision, (draft.revision ?? 0) + 1);
  assert.equal(slotsAreGroupedByType(result.draft.slots), true);
  assert.deepEqual(result.draft.baseline, before.baseline);
  assert.deepEqual(draft, before);
  for (const slot of result.draft.slots) {
    const original = before.slots.find(item => item.slotId === slot.slotId);
    assert.deepEqual(slot.question, original.question);
    assert.equal(slot.locked, original.locked);
    assert.deepEqual(slot.goalIds, original.goalIds);
  }
  const replay = await applyDraftOperation(result.draft, operation);
  assert.equal(replay.ok, true);
  assert.equal(replay.result.replayed, true);
  assert.equal(replay.draft.revision, result.draft.revision);
  const stale = await applyDraftOperation(result.draft, { ...operation, operationId: 'group-stale' });
  assert.equal(stale.error.code, 'revision_conflict');
  const frozen = { ...draft, confirmedPaperId: 'frozen-paper' };
  const rejected = await applyDraftOperation(frozen, operation);
  assert.equal(rejected.error.code, 'finalized_draft');
  // Frozen output honors its original order; grouping editable drafts cannot rewrite old papers.
  const projected = projectPaper({ paperId: 'frozen-paper', draft: frozen }, 'student');
  assert.deepEqual(projected.slots.map(slot => slot.slotId), frozen.slots.map(slot => slot.slotId));
});

test('adding rejects cross-type anchors and default placement is the end of its own group', async () => {
  const preview = await previewBlueprint({});
  const { draft } = await createDraft(preview.blueprint);
  const choice = draft.slots.find(slot => slot.questionType === 'single_choice');
  const blank = draft.slots.find(slot => slot.questionType === 'fill_blank');
  const operation = { type: 'add', operationId: 'add-grouped', expectedRevision: draft.revision ?? 0, taskId: choice.taskId, points: choice.points, partPoints: [] };
  const invalid = await applyDraftOperation(draft, { ...operation, afterSlotId: blank.slotId });
  assert.equal(invalid.error.code, 'invalid_operation');
  assert.match(invalid.error.message, /同题型/);
  const valid = await applyDraftOperation(draft, operation);
  assert.equal(valid.ok, true, JSON.stringify(valid.error));
  const added = valid.draft.slots.find(slot => !draft.slots.some(original => original.slotId === slot.slotId));
  assert.equal(valid.draft.slots.filter(slot => slot.questionType === 'single_choice').at(-1).slotId, added.slotId);
  assert.equal(slotsAreGroupedByType(valid.draft.slots), true);
  const anchored = await applyDraftOperation(draft, { ...operation, operationId: 'add-anchor', afterSlotId: choice.slotId });
  assert.equal(anchored.ok, true, JSON.stringify(anchored.error));
  assert.equal(anchored.draft.slots[1].slotId, anchored.result.entries[0].slotId);
});
