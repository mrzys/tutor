import test from 'node:test';
import assert from 'node:assert/strict';
import { canRemoveGoalLink, goalAssignmentSummary, retainedGoalIds } from '../web/blueprint-review.js';

const required = { id: 'diagnosis', priority: 'required', knowledgeScope: ['1.2'], conditions: { response: 'answer' } };
const preferred = { ...required, id: 'practice', priority: 'preferred' };
const task = { sectionIds: ['1.2'], questionType: 'single_choice' };

test('changing a foundation task does not silently assign the required diagnosis to it', () => {
  assert.deepEqual(retainedGoalIds({ goalIds: [] }, task, [required]), []);
  assert.deepEqual(retainedGoalIds({ goalIds: [required.id] }, task, [required]), [required.id]);
  assert.deepEqual(retainedGoalIds({ goalIds: [required.id] }, { ...task, sectionIds: ['1.1'] }, [required]), []);
  assert.deepEqual(retainedGoalIds({ goalIds: [required.id] }, task, [{ ...required, conditions: { response: 'written_reasoning' } }]), []);
});

test('teachers can redistribute a required goal while preserving its final assigned slot', () => {
  const first = { slotId: 'first', goalIds: [required.id] };
  const second = { slotId: 'second', goalIds: [] };
  assert.equal(canRemoveGoalLink([first, second], first, required), false);
  assert.equal(canRemoveGoalLink([first, { ...second, goalIds: [required.id] }], first, required), true);
  assert.equal(canRemoveGoalLink([first], first, preferred), true);
});

test('two goal links on one slot count as one target-bearing question and preserve foundation space', () => {
  assert.deepEqual(goalAssignmentSummary([
    { goalIds: [required.id, preferred.id] }, { goalIds: [] }, { goalIds: ['stale-id'] },
  ], [required, preferred]), { linkedCount: 1, practiceCount: 2 });
});


test('switching to an imported task preserves the same physical section goal without crossing textbooks', () => {
  const slot = { goalIds: [required.id] };
  assert.deepEqual(retainedGoalIds(slot, { ...task, sectionIds: ['rja-compulsory-1:1.2'] }, [required]), [required.id]);
  assert.deepEqual(retainedGoalIds(slot, { ...task, sectionIds: ['another-textbook:1.2'] }, [required]), []);
});
