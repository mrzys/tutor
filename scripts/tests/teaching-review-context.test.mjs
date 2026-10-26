import test from 'node:test';
import assert from 'node:assert/strict';
import { compactTeachingReviewContext } from '../lib/teaching-review-context.mjs';

test('transport deduplicates equivalent drafts and guidance without changing archived data or match locations', () => {
  const text = '😀'.repeat(60) + '下界' + '甲'.repeat(80);
  const candidate = { questionId: 'simulated', teachingSolution: text, issues: ['保留疑点'] };
  const finding = { type: 'term', ruleId: 'optimization-language', term: '下界', fieldPath: 'teachingSolution', start: 120, end: 122, excerpt: text, guidance: '核对具体不等式与取等条件' };
  const original = { originalMaterial: { stem: '原题不能截断' }, candidate, rawCandidate: structuredClone(candidate), reviewFindings: [finding, { ...finding, fieldPath: 'unknown' }] };
  const snapshot = structuredClone(original);
  const compact = compactTeachingReviewContext(original);
  assert.deepEqual(original, snapshot);
  assert.equal(compact.rawCandidate, null);
  assert.equal(compact.rawCandidateSameAsCandidate, true);
  assert.deepEqual(compact.candidate, candidate);
  assert.deepEqual(compact.originalMaterial, original.originalMaterial);
  assert.equal(compact.reviewFindings.length, 2);
  assert.equal(compact.reviewRules.length, 1);
  assert.equal(compact.reviewFindings[0].reviewGuidanceIndex, 0);
  assert.equal(compact.reviewFindings[0].excerpt, '😀'.repeat(40) + '下界' + '甲'.repeat(40));
  assert.equal(compact.reviewFindings[1].excerpt, text);
  assert.equal(compact.reviewFindings[0].start, 120);
  assert.deepEqual(compact.candidate.issues, ['保留疑点']);
});

test('malformed or distinct raw responses are retained verbatim for format review', () => {
  for (const rawCandidate of ['{bad json', { answer: 'different' }, '{"answer":"1"}']) {
    const original = { candidate: { answer: '1' }, rawCandidate, reviewFindings: [{ type: 'format', code: 'invalid_json' }] };
    const compact = compactTeachingReviewContext(original);
    assert.deepEqual(compact.rawCandidate, rawCandidate);
    assert.equal(compact.rawCandidateSameAsCandidate, undefined);
  }
});
