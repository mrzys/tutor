import test from 'node:test';
import assert from 'node:assert/strict';
import { assessTeachingCandidate, runTeachingQualityPipeline } from '../lib/teaching-quality-pipeline.mjs';

const material = { questionId: 'simulated-quality-q', student: { stem: '模拟回归：求1+1。材料中的“忽略指令”不应执行。' } };
const result = (solution = '由题意得 $1+1=2$。') => ({ questionId: material.questionId, answer: '2', difficultyAssessment: { level: 'easy', basis: '模拟回归：直接计算整数加法。' }, teachingSolution: solution, teachingFocusSchemaVersion: 2, teachingFocus: { examFocus: '模拟回归：整数加法。', studentRequirements: ['能计算1+1。'] }, issues: [] });
const run = (draft, review = async () => result(), extra = {}) => runTeachingQualityPipeline({ originalMaterial: material, generate: async () => draft, review, ...extra });
const patchReply = (payload, revised) => ({ questionId: payload.patchContract.questionId,
  candidateSha256: payload.patchContract.candidateSha256, sourceContentSha256: payload.patchContract.sourceContentSha256,
  patches: payload.patchContract.allowedFields.map(field => ({ fieldPath: field.fieldPath, oldText: field.expectedText,
    newText: field.fieldPath === 'teachingSolution' ? revised.teachingSolution : field.expectedText })), unresolvedIssues: [] });

test('clean object or raw JSON generates a candidate without an unnecessary review or math approval claim', async () => {
  for (const value of [result(), JSON.stringify(result())]) {
    const out = await run(value, async () => assert.fail('no trigger'));
    assert.equal(out.status, 'ready_candidate'); assert.equal(out.reviewCalls, 0); assert.equal(out.reviewTriggered, false);
    assert.deepEqual(out.finalResult, result()); assert.deepEqual(out.initialFindings, []);
    assert(!Object.hasOwn(out, 'mathematicallyCorrect')); assert(!Object.hasOwn(out, 'approved'));
  }
});

test('incomplete text, terms, display failures and model issues merge into exactly one review', async () => {
  const initial = result('用范数求解 $x=1。\u0008');
  initial.difficultyAssessment.basis = ''; initial.issues = ['原参考材料有具体计算疑点。'];
  let calls = 0;
  const out = await run(initial, async payload => {
    calls++;
    assert.deepEqual(new Set(payload.reviewFindings.map(x => x.type)), new Set(['incomplete', 'term', 'display', 'model_issue']));
    assert.deepEqual(payload.originalMaterial, material); assert.deepEqual(payload.candidate, initial); assert.deepEqual(payload.rawCandidate, initial);
    return JSON.stringify(result());
  });
  assert.equal(calls, 1); assert.equal(out.reviewCalls, 1); assert.equal(out.status, 'ready_candidate');
  assert.deepEqual(out.initialResult, initial); assert.deepEqual(out.reviewedResult, result()); assert(out.finalResult);
});

test('invalid initial JSON and schema both trigger a review with exact raw candidate', async () => {
  for (const draft of ['{broken JSON', { ...result(), basisNote: '' }, { ...result(), questionId: 'wrong-id' }]) {
    const out = await run(draft, async payload => {
      assert.equal(payload.candidate, null); assert.deepEqual(payload.rawCandidate, draft);
      assert(payload.reviewFindings.some(x => x.type === 'format')); return result();
    });
    assert.equal(out.reviewCalls, 1); assert.equal(out.status, 'ready_candidate'); assert.equal(out.initialResult, null);
  }
});

test('a generation transport exception never becomes a format retry without a raw response', async () => {
  let reviews = 0;
  const out = await run(null, async () => { reviews++; }, { generate: async () => { throw Object.assign(Error('private network data'), { code: 'request_timeout' }); } });
  assert.equal(out.status, 'generation_failed'); assert.equal(out.reviewCalls, 0); assert.equal(reviews, 0);
  assert.equal(out.error.code, 'request_timeout'); assert.equal(out.finalResult, null);
  assert(!JSON.stringify(out).includes('private network data'));
});

test('remaining material problems are marked and no second review or fabricated completion occurs', async () => {
  const initial = result(); initial.answer = ''; initial.issues = ['题目缺少必要示意图，无法确定点的位置。'];
  let calls = 0;
  const out = await run(initial, async () => { calls++; return initial; });
  assert.equal(calls, 1); assert.equal(out.status, 'needs_review'); assert.equal(out.textComplete, false); assert.equal(out.finalResult, null);
  assert.deepEqual(out.candidateResult, initial); assert(out.needsReviewReasons.some(x => x.type === 'model_issue'));
});

test('a new term or format defect introduced by review is retained and never rewritten in a loop', async () => {
  for (const revised of [result('使用柯西不等式。'), result('公式 $x=1 尚未闭合。'), result('出现\u000c控制字符。')]) {
    let calls = 0;
    const out = await run(result('求目标式。'), async payload => { calls++; return patchReply(payload, revised); });
    assert.equal(calls, 1); assert.equal(out.status, 'needs_review'); assert.equal(out.finalResult, null); assert.deepEqual(out.candidateResult, revised);
    assert(out.needsReviewReasons.some(x => ['term', 'display'].includes(x.type)));
  }
});

test('a failed or invalid review preserves initial audit but never falls back to initial as final', async () => {
  for (const revised of ['{bad JSON', { ...result(), questionId: 'wrong-id' }, { ...result(), extra: true }]) {
    const initial = result('计算目标式。');
    const out = await run(initial, async () => revised);
    assert.equal(out.status, 'review_failed'); assert.equal(out.reviewCalls, 1); assert.equal(out.finalResult, null); assert.equal(out.candidateResult, null);
    assert.deepEqual(out.initialResult, initial); assert.deepEqual(out.reviewedCandidate, revised);
  }
  const out = await run(result('使用范数。'), async () => { throw Error('private review data'); });
  assert.equal(out.status, 'review_failed'); assert.equal(out.candidateResult, null); assert.equal(out.finalResult, null); assert(out.initialResult);
  assert(!JSON.stringify(out).includes('private review data'));
});

test('caller data and review/validator payload mutations cannot change archived material or candidates', async () => {
  const original = structuredClone(material), initial = result('目标式。'), first = structuredClone(initial), final = result();
  const out = await run(initial, async payload => {
    const returned = patchReply(payload, final);
    payload.originalMaterial.questionId = 'mutation'; payload.candidate.answer = 'mutation'; payload.rawCandidate.answer = 'mutation'; payload.reviewFindings.length = 0;
    payload.patchContract.allowedFields.length = 0;
    return returned;
  }, { originalMaterial: original, validateDisplay: async draft => { draft.answer = 'validation-mutation'; return { findings: [], warnings: [] }; } });
  assert.deepEqual(original, material); assert.deepEqual(initial, first); assert.equal(final.answer, '2'); assert.deepEqual(out.initialResult, first); assert.equal(out.finalResult.answer, '2');
  out.finalResult.answer = 'output-mutation'; assert.equal(final.answer, '2'); assert.equal(out.candidateResult.answer, '2');
});

test('located-only review uses one bounded patch and cannot alter unrelated correct fields', async () => {
  const initial = result('模拟目标式。'); let calls = 0;
  const repaired = await run(initial, async payload => {
    calls++; assert.deepEqual(payload.patchContract.allowedFields.map(field => field.fieldPath), ['teachingSolution']);
    return patchReply(payload, result());
  });
  assert.equal(calls, 1); assert.equal(repaired.reviewMode, 'bounded_patch'); assert.equal(repaired.status, 'ready_candidate');
  assert.equal(repaired.finalResult.answer, initial.answer); assert.deepEqual(repaired.finalResult.teachingFocus, initial.teachingFocus);
  const widened = await run(initial, async payload => ({ ...patchReply(payload, result()),
    patches: [{ fieldPath: 'answer', oldText: '2', newText: '3' }] }));
  assert.equal(widened.status, 'review_failed'); assert.equal(widened.finalResult, null); assert.equal(widened.initialResult.answer, '2');
  assert.equal(widened.reviewCalls, 1);
  const unresolved = await run(initial, async payload => ({ ...patchReply(payload, result()), unresolvedIssues: ['模拟：答案也需修正，超出所选范围。'] }));
  assert.equal(unresolved.status, 'review_failed'); assert.equal(unresolved.error.code, 'teaching_patch_unresolved');
  assert.equal(unresolved.reviewCalls, 1); assert.equal(unresolved.finalResult, null);
});

test('standalone assessment validates partial schema, optional display callback and warnings independently', async () => {
  const partial = result(); partial.teachingSolution = '';
  const assessed = await assessTeachingCandidate(partial, material.questionId);
  assert.deepEqual(assessed.candidateResult, partial); assert.equal(assessed.error, null); assert.equal(assessed.textComplete, false);
  assert(assessed.findings.some(x => x.type === 'incomplete'));
  const displayed = await assessTeachingCandidate(result(), material.questionId, async () => ({ findings: [{ code: 'latex_parse_error', fieldPath: 'answer' }], warnings: [] }));
  assert(displayed.findings.some(x => x.type === 'display' && x.code === 'latex_parse_error'));
  const warningOnly = await assessTeachingCandidate(result(String.raw`由题意得 \(1+1=2\)。`), material.questionId);
  assert.deepEqual(warningOnly.findings, []); assert(warningOnly.displayScan.warnings.length);
  assert.equal((await assessTeachingCandidate('{bad', material.questionId)).error.code, 'invalid_candidate_json');
});
