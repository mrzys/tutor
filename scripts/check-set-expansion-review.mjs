import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

// Checks review provenance and stale inputs, not mathematical correctness.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => JSON.parse(fs.readFileSync(path.resolve(root, p), 'utf8'));
const hash = p => createHash('sha256').update(fs.readFileSync(path.resolve(root, p))).digest('hex');
const base = 'docs/validation/set-expansion-50';
const report = read(`${base}/review-r1-results.json`);
for (const input of report.inputs) {
  assert.equal(hash(input.path), input.sha256, `复核输入已变更，须重新检查: ${input.path}`);
}
const collected = read('data/question-bank/staging/set-expansion-50.json').items;
const items = ['a', 'b', 'c'].flatMap(batch => read(`${base}/review-r1-${batch}.json`).items);
assert.equal(items.length, 50);
assert.equal(new Set(items.map(x => x.id)).size, 50);
assert.equal(report.items.length, 50);
for (const question of collected) {
  const review = items.find(x => x.id === question.id);
  const result = report.items.find(x => x.id === question.id);
  assert(review && result, `缺少复核: ${question.id}`);
  assert.equal(review.sourceVisualChecked, true);
  assert(review.derivation.trim() && review.dependencies.length);
  const answer = Array.isArray(review.derivedAnswer)
    ? [...review.derivedAnswer].sort().join('') : review.derivedAnswer;
  assert.equal(result.derivedAnswer, answer);
  assert.equal(result.storedAnswer, question.teacher.answers[0].text);
  assert.equal(result.answerMatches, answer === result.storedAnswer);
  assert.equal(question.reviewStatus, 'pending_review');
}
const excluded = read(`${base}/review-r1-excluded.json`).items;
assert.equal(excluded.length, 6);
assert(excluded.every(x => x.sourceVisualChecked && x.decision === 'remain_excluded'));
assert.equal(report.summary.answerMatches, report.items.filter(x => x.answerMatches).length);
assert.equal(report.summary.contentReviewPassed, report.items.filter(x => x.decision === 'content_review_passed').length);
assert.equal(report.summary.needsSourceConfirmation, report.items.filter(x => x.decision === 'needs_source_confirmation').length);
assert.equal(report.summary.publishedByThisReview, 0);
assert.equal(report.summary.teacherApprovedByThisReview, 0);
console.log(JSON.stringify(report.summary, null, 2));
