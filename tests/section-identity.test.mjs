import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalSectionId, includesSection, scopesOverlap } from '../src/curriculum/section-identity.mjs';
import { compatibleGoal, normalizeTeachingGoals, goalReview } from '../src/assembly/teaching-goals.mjs';
import { createIntakeService } from '../src/intake/service.mjs';

test('only the three explicitly known legacy textbook identities are aliases', () => {
  for (const id of ['1.1', '1.2', '1.3']) {
    assert.equal(canonicalSectionId(id), `rja-compulsory-1:${id}`);
    assert.equal(includesSection([id], `rja-compulsory-1:${id}`), true);
    assert.equal(includesSection([`rja-compulsory-1:${id}`], id), true);
    assert.equal(includesSection([id], `other-book:${id}`), false);
  }
  assert.equal(canonicalSectionId('2.3'), '2.3');
  assert.equal(scopesOverlap(['2.3'], ['rja-compulsory-1:2.3']), false);
  assert.equal(scopesOverlap(['1.3'], ['rja-compulsory-1:1.3']), true);
  assert.equal(scopesOverlap(['1.3'], ['rja-compulsory-1:1.2']), false);
});

test('teaching goal compatibility and review accept aliases without changing frozen scopes', () => {
  const input = { id: 'g', version: 1, knowledgeScope: ['rja-compulsory-1:1.3'], cognition: 'apply', observable: '求集合交集。',
    conditions: { prompt: 'unspecified', response: 'answer' }, priority: 'preferred', source: { kind: 'teacher', text: '检查交集。' } };
  const [goal] = normalizeTeachingGoals([input], ['1.3']);
  assert.deepEqual(goal.knowledgeScope, input.knowledgeScope);
  const task = { id: 't', sectionIds: ['1.3'], questionType: 'single_choice' };
  assert.equal(compatibleGoal(goal, task), true);
  assert.equal(compatibleGoal(goal, { ...task, sectionIds: ['other-book:1.3'] }), false);
  const requirements = { mainScope: ['1.3'], learnedScope: ['1.3'], teachingGoals: [goal] };
  const review = goalReview(requirements, [{ slotId: 's', taskId: 't', goalIds: ['g'] }], [task]);
  assert.deepEqual(review.issues, []);
  assert.deepEqual(requirements.mainScope, ['1.3']);
});

test('canonical scope intake progresses through verified legacy sections and preserves custom aliases', async () => {
  const service = createIntakeService();
  const start = await service.handle({ action: 'start', flow: 'quick', operationId: 'identity-progress',
    answers: { mainScope: ['rja-compulsory-1:1.3'] } });
  assert.equal(start.ok, true, JSON.stringify(start));
  assert.deepEqual(start.session.answers.mainScope, ['rja-compulsory-1:1.3']);
  assert.deepEqual(start.session.answers.learnedScope, ['1.1', '1.2', '1.3']);
  const custom = await service.handle({ action: 'start', flow: 'quick', operationId: 'identity-custom',
    answers: { mainScope: ['1.3'], learnedScope: ['rja-compulsory-1:1.3'], learnedScopeMode: 'custom' } });
  assert.equal(custom.ok, true, JSON.stringify(custom));
  assert.deepEqual(custom.session.requirements.mainScope, ['1.3']);
  assert.deepEqual(custom.session.requirements.learnedScope, ['rja-compulsory-1:1.3']);
});
