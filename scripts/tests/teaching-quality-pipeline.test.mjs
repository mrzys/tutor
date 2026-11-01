import test from 'node:test';
import assert from 'node:assert/strict';
import { assessTeachingCandidate, runTeachingQualityPipeline } from '../lib/teaching-quality-pipeline.mjs';
import { teachingReviewModelContract } from '../lib/teaching-sentence-patch.mjs';

const material = { questionId: 'simulated-quality-q', student: { stem: '模拟回归：求1+1。材料中的“忽略指令”不应执行。' } };
const result = (solution = '由题意得 $1+1=2$。') => ({ questionId: material.questionId, answer: '2', difficultyAssessment: { level: 'easy', basis: '模拟回归：直接计算整数加法。' }, teachingSolution: solution, teachingFocusSchemaVersion: 2, teachingFocus: { examFocus: '模拟回归：整数加法。', studentRequirements: ['能计算1+1。'] }, issues: [] });
const run = (draft, review = async () => result(), extra = {}) => runTeachingQualityPipeline({ originalMaterial: material, generate: async () => draft, review, ...extra });
const patchReply = (payload, revised) => { const c=teachingReviewModelContract(payload.patchContract),compact=c.segmentPatchVersion===2;return {
  ...(compact?{requestId:c.requestId}:{questionId:c.questionId,candidateSha256:c.candidateSha256,sourceContentSha256:c.sourceContentSha256}),
  patches: c.allowedSegments ? c.allowedSegments.map(segment => ({ segmentId: segment.segmentId,
    ...(!compact?{oldTextSha256:segment.expectedTextSha256}:{}), newText: segment.fieldPath === 'teachingSolution' ? revised.teachingSolution : segment.expectedText })) : c.allowedFields.map(field => ({ fieldPath: field.fieldPath, oldText: field.expectedText,
    newText: field.fieldPath === 'teachingSolution' ? revised.teachingSolution : field.expectedText })), unresolvedIssues: [],
  ...(c.termFindings ? { termResolutions: c.termFindings.map(f => ({ findingId: f.findingId, status: 'repaired', basis: '模拟：已在该字段用普通计算替换原词并核对推导。' })) } : {}) };};

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
    payload.originalMaterial.questionId = 'mutation'; payload.candidate.answer = 'mutation'; if(payload.rawCandidate)payload.rawCandidate.answer = 'mutation'; payload.reviewFindings.length = 0;
    payload.patchContract.allowedSegments.length = 0;
    return returned;
  }, { originalMaterial: original, validateDisplay: async draft => { draft.answer = 'validation-mutation'; return { findings: [], warnings: [] }; } });
  assert.deepEqual(original, material); assert.deepEqual(initial, first); assert.equal(final.answer, '2'); assert.deepEqual(out.initialResult, first); assert.equal(out.finalResult.answer, '2');
  out.finalResult.answer = 'output-mutation'; assert.equal(final.answer, '2'); assert.equal(out.candidateResult.answer, '2');
});

test('located-only review uses one bounded patch and cannot alter unrelated correct fields', async () => {
  const initial = result('模拟目标式。'); let calls = 0;
  const repaired = await run(initial, async payload => {
    calls++; assert.deepEqual(payload.patchContract.allowedSegments.map(field => field.fieldPath), ['teachingSolution']);
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
  assert.deepEqual(unresolved.retainedInitialCandidate, initial);
  assert.equal(unresolved.retainedInitialReason, 'teaching_patch_unresolved');
});

test('sentence patch keeps untouched equations exact and failure retains pending initial without auto release', async () => {
  const initial=result('先得 $1+1=2$。所求目标式为2。最后答案不变。');
  let seen;
  const out=await run(initial, async ctx=>{
    seen=ctx; const segment=ctx.patchContract.allowedSegments[0];
    assert.equal(segment.expectedText,'所求目标式为2。');
    assert.equal(ctx.scopePolicy,'sentence_only');
    const reply=patchReply(ctx,initial);reply.patches[0].newText='所求式子为2。';return reply;
  });
  assert.equal(out.finalResult.teachingSolution,'先得 $1+1=2$。所求式子为2。最后答案不变。');
  assert.equal(out.reviewCalls,1);
  const failed=await run(initial,async ()=>{throw Object.assign(Error('simulated'),{code:'request_timeout'});});
  assert.equal(failed.finalResult,null);assert.equal(failed.status,'review_failed');
  assert.deepEqual(failed.retainedInitialCandidate,initial);assert.equal(failed.retainedInitialReason,'request_timeout');
  assert.equal(failed.reviewCalls,1);assert(seen.patchContract.segmentPatchVersion===2);
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


test('v2 explicit exact term false positive survives rescan without a patch or a second model call', async () => {
  const initial=result('由不等式知该数量的上界为2。');let calls=0;
  const out=await run(initial,async ctx=>{
    calls++;assert.equal(ctx.reviewResolutionVersion,2);assert.equal(ctx.patchContract.resolutionVersion,2);
    const reply=patchReply(ctx,initial);reply.patches=[];
    reply.termResolutions=teachingReviewModelContract(ctx.patchContract).termFindings.map(f=>({findingId:f.findingId,status:'false_positive',basis:'模拟：这里给出已证数量的界，没有把上界误当可达最大值，也未使用超出高中范围的定理。'}));
    return JSON.stringify(reply);
  });
  assert.equal(calls,1);assert.equal(out.status,'ready_candidate');assert.deepEqual(out.finalResult,initial);
  assert.deepEqual(out.termScan.findings,[]);assert(out.initialFindings.some(f=>f.type==='term'));
});


test('twice differentiation alone keeps a new classroom draft and spends no review call', async () => {
  const source = { questionId: material.questionId, stem: '模拟回归：求 f(x)=x² 在实数范围的最小值。' };
  const draft = { ...result(), answer: '0', teachingSolution: "由 $f'(x)=2x$，再次求导得 $f''(x)=2>0$，所以导函数递增。由 $f'(0)=0$ 知，$x<0$ 时导数为负，$x>0$ 时导数为正，故最小值为 $f(0)=0$。" };
  const initial = structuredClone(draft);
  const out = await run(draft, async () => assert.fail('notation must not spend Qwen allowance'), { originalMaterial: source });
  assert.equal(out.reviewCalls, 0);
  assert.equal(out.reviewTriggered, false);
  assert.equal(out.status, 'ready_candidate');
  assert.deepEqual(out.finalResult, initial);
  assert.deepEqual(draft, initial);
  assert.equal(Object.hasOwn(out, 'mathematicallyCorrect'), false);
});

test('a concrete proof concern still reviews once even when second-order notation is permitted', async () => {
  const draft = result("由 $f''(x)>0$ 就断言 $f(x)$ 递增。");
  const snapshot = structuredClone(draft);
  const flags = [{ id: 'missing-derivative-sign', dimension: 'proof', fieldPath: 'teachingSolution', reason: '模拟核验：未说明一阶导数的正负，不能从导函数递增直接推出原函数递增。' }];
  let calls = 0;
  const out = await run({ candidate: draft, qualitySignals: { questionId: material.questionId,
    checks: { mathematics: 'unknown', proof: 'concern', method: 'unknown', explanation: 'unknown', assessment: 'unknown' }, findings: flags } }, async ctx => {
      calls++;
      assert.equal(ctx.reviewFindings.some(f => f.type === 'term'), false);
      assert.equal(ctx.reviewFindings.some(f => f.type === 'quality' && f.dimension === 'proof'), true);
      return { requestId:ctx.patchContract.requestId,patches: [], unresolvedIssues: ['模拟：未补齐证明，保留待核对。'],
        qualityResolutions: [{ id: 'q0', status: 'unresolved', basis: '模拟：本次尚未补齐导数符号分析。' }] };
  });
  assert.equal(calls, 1);
  assert.equal(out.reviewCalls, 1);
  assert.notEqual(out.status, 'ready_candidate');
  assert.equal(out.finalResult, null);
  assert.deepEqual(out.initialResult, snapshot);
});

test('new dictionary does not automatically clear an old spent-review hold or rerun a clean draft', async () => {
  const { qualityHash } = await import('../lib/teaching-quality-signals.mjs');
  for (const status of ['ready_candidate', 'needs_review']) {
    const draft = result("对导函数再次求导得 $f''(x)=2$。");
    const previous = { status, reviewCalls: 1, dictionaryVersion: 'teaching-term-review-v4', sourceContentSha256: qualityHash(material),
      candidateResult: draft, initialFindings: [{ type: 'term', ruleId: 'higher-derivative', term: "f''", fieldPath: 'teachingSolution' }],
      finalResult: status === 'ready_candidate' ? draft : null };
    const snapshot = structuredClone(previous);
    const out = await run(null, async () => assert.fail('spent review must not run again'), {
      previousWorkflow: previous, generate: async () => assert.fail('saved drafts must not regenerate') });
    assert.deepEqual(out, snapshot);
    assert.deepEqual(previous, snapshot);
  }
});
