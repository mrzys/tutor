import test from 'node:test';
import assert from 'node:assert/strict';
import { coverageContext, validateCoverage, reviewDraftCoverage, attachCoverageReview } from '../src/assembly/coverage.mjs';
import { coverageFingerprint, currentCoverageReview } from '../src/assembly/coverage-state.mjs';

const draft = () => ({ revision: 2, baseline: { requirements: { teacherRequest: '求交集和求补集', teachingGoals: [] } },
  slots: [{ slotId: 's1', number: 1, taskId: 'intersection', status: 'selected', questionType: 'single_choice', goalIds: [],
    question: { questionId: 'q1', contentVersion: 'v1', teacherVersion: 't1', student: { stem: '求 A∩B', options: [], parts: [], assets: [] },
      teacher: { solutions: [{ text: 'A∩B={1}' }] } } }] });
const proposal = () => ({ summary: '交集有依据；补集未涉及。', checks: [
  { requirement: '求交集', status: 'covered', rationale: '题面明确求交集。', evidence: [{ slotId: 's1', ref: 'student.stem' }], suggestion: '' },
  { requirement: '求补集', status: 'missing', rationale: '无补集任务。', evidence: [], suggestion: '补充一道补集题。' },
] });

test('coverage records real student evidence, retains gaps without promoting manual goal support', async () => {
  const value = draft();
  const review = await reviewDraftCoverage(value, { gateway: { async propose(context, options) {
    assert.equal(context.questions[0].evidence['student.stem'], '求 A∩B');
    options.validate(proposal()); return { ok: true, proposal: proposal(), run: { status: 'succeeded' } };
  } } });
  assert.equal(review.status, 'complete'); assert.equal(review.empirical, false);
  assert.equal(review.checks[1].status, 'missing');
  assert.equal(value.slots[0].selection, undefined);
  const result = attachCoverageReview(value, review, 2);
  assert.equal(result.draft.revision, 3);
  assert.equal(currentCoverageReview(result.draft).status, 'complete');
});

test('forged references, teacher-only coverage and invented requirements cannot pass validation', () => {
  const context = coverageContext(draft());
  for (const reference of [{ slotId: 'unknown', ref: 'student.stem' }, { slotId: 's1', ref: 'question.student.stem' },
    { slotId: 's1', ref: 'teacher.solutions[0].text' }]) {
    const output = proposal(); output.checks[0].evidence = [reference];
    assert.throws(() => validateCoverage(output, context));
  }
  const output = proposal(); output.checks[1].evidence = [{ slotId: 's1', ref: 'student.stem' }];
  assert.equal(validateCoverage(output, context).checks[1].status, 'missing');
  const invented = proposal(); invented.checks[1].requirement = '书面说明含参综合推理';
  assert.throws(() => validateCoverage(invented, context), /不是 confirmedTargets 的原文片段/);
});

test('question versions, task and confirmed requirements invalidate prior reviews; lock-only changes do not', () => {
  const value = draft(); value.coverageReview = { fingerprint: coverageFingerprint(value), status: 'complete' };
  assert.ok(currentCoverageReview({ ...value, slots: value.slots.map(slot => ({ ...slot, locked: true })) }));
  for (const mutate of [item => item.slots[0].question.contentVersion = 'v2', item => item.slots[0].taskId = 'union',
    item => item.baseline.requirements.teacherRequest = '其他要求']) {
    const changed = structuredClone(value); mutate(changed); assert.equal(currentCoverageReview(changed), null);
    assert.equal(attachCoverageReview(changed, value.coverageReview, 2).error.code, 'revision_conflict');
  }
  assert.equal(attachCoverageReview({ ...value, revision: 3 }, value.coverageReview, 2).error.code, 'revision_conflict');
  assert.equal(attachCoverageReview({ ...value, confirmedPaperId: 'paper' }, value.coverageReview, 2).error.code, 'finalized_draft');
});

test('review failure retains the assembled paper; cancellation promptly stops an uncooperative gateway', async () => {
  const unavailable = await reviewDraftCoverage(draft(), { gateway: { async propose() { throw new Error('service unavailable'); } } });
  assert.equal(unavailable.status, 'unavailable');
  const controller = new AbortController();
  const pending = reviewDraftCoverage(draft(), { signal: controller.signal, gateway: { propose() { return new Promise(() => {}); } } });
  controller.abort();
  await assert.rejects(pending, { code: 'cancelled' });
});
