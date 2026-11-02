import test from 'node:test';
import assert from 'node:assert/strict';
import { accuracyCanReviewDomain, accuracyPendingDomains, accuracyReadingExpanded, accuracySuggestedDomain, createAccuracyActionDraft } from '../src/import-accuracy.ts';
import { nextReviewQuestion } from '../src/import-review-flow.ts';

const question = () => ({ accuracy: { strategyVersion: 'simulated-v1', source: { status: 'ready' }, mathematics: { status: 'unresolved' }, teaching: { status: 'pending' }, findings: [] } });
test('simulated valid model checks require no extra teacher confirmation and navigation advances after a real domain check', () => {
  const q = question();
  assert.deepEqual(accuracyPendingDomains(q), ['math', 'teaching']);
  assert.equal(accuracySuggestedDomain(q), 'math');
  q.accuracy.mathematics.status = 'teacher_reviewed';
  assert.deepEqual(accuracyPendingDomains(q), ['teaching']);
  assert.equal(accuracySuggestedDomain(q), 'teaching');
  q.accuracy.teaching.status = 'model_checked';
  assert.deepEqual(accuracyPendingDomains(q), []);
  assert.deepEqual(accuracyPendingDomains({ modelReview: { status: 'ready' } }), []);
});
test('simulated current reading and actual findings open relevant material without forcing unrelated sections open', () => {
  const q = question();
  assert.equal(accuracyReadingExpanded(q, 'math', 'math'), true);
  assert.equal(accuracyReadingExpanded(q, 'teaching', 'math'), false);
  q.accuracy.findings.push({ domain: 'teaching', message: '模拟：难度依据缺失' });
  assert.equal(accuracyReadingExpanded(q, 'teaching', 'math'), true);
});
test('simulated accuracy pending navigation includes teaching-only unresolved questions and skips published or duplicate items', () => {
  const rows = [
    { questionId: 'current', eligible: false }, { questionId: 'duplicate', duplicateState: 'exact' },
    { questionId: 'published', published: true }, { questionId: 'teaching-only', eligible: false, question: question() },
  ].map(row => ({ published: false, duplicateState: 'none', ...row }));
  assert.equal(nextReviewQuestion(rows, 'current', 'source_pending'), 'teaching-only');
});
test('simulated global review permission cannot authorize a domain with no complete candidate', () => {
  const q = { ...question(), questionId: 'simulated', accuracy: { ...question().accuracy, canReview: true, reviewableDomains: ['source'], sourceSha256: 'a'.repeat(64), candidateSha256: null } };
  assert.equal(accuracyCanReviewDomain(q, 'source'), true);
  assert.equal(accuracyCanReviewDomain(q, 'math'), false);
  assert.equal(createAccuracyActionDraft(q, 'import', 1, 'review', 'math', 'operation'), null);
  assert.equal(createAccuracyActionDraft(q, 'import', 1, 'review', 'source', 'operation')?.domain, 'source');
  delete q.accuracy.reviewableDomains;
  assert.equal(accuracyCanReviewDomain(q, 'source'), false);
});
