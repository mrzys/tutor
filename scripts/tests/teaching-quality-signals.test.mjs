import test from 'node:test';
import assert from 'node:assert/strict';
import { runTeachingQualityPipeline } from '../lib/teaching-quality-pipeline.mjs';
import { validateQualityResolutions, qualityHash, validateQualityFindings } from '../lib/teaching-quality-signals.mjs';
import { createTeachingPatchContract, mergeTeachingBoundedPatch } from '../lib/teaching-bounded-patch.mjs';
import { teachingReviewModelContract } from '../lib/teaching-sentence-patch.mjs';
const original = { questionId: 'sim-quality-signal', stem: '模拟回归：求1+1' };
const candidate = () => ({ questionId: original.questionId, answer: '2', teachingSolution: '由题意得2。', difficultyAssessment: { level: 'easy', basis: '直接进行加法。' }, teachingFocusSchemaVersion: 2, teachingFocus: { examFocus: '整数加法。', studentRequirements: ['能完成加法。'] }, issues: [] });
const flag = dimension => ({ id: `audit-${dimension}`, dimension, fieldPath: dimension === 'assessment' ? 'difficultyAssessment.level' : 'teachingSolution', reason: '模拟核验：本段缺少1+1计算等式。' });
const audit = (draft, dimension) => ({ questionId: original.questionId, sourceContentSha256: qualityHash(original), candidateSha256: qualityHash(draft), method: 'user_authorized_agent_review', checkedBy: 'codex', evidence: '模拟独立核验原题和计算。', findings: [flag(dimension)] });
function reply(ctx, solution = '计算 $1+1=2$，得2。') {
  const c=teachingReviewModelContract(ctx.patchContract),compact=c.segmentPatchVersion===2;
  return { ...(compact?{requestId:c.requestId}:{questionId:c.questionId,candidateSha256:c.candidateSha256,sourceContentSha256:c.sourceContentSha256}),
    patches: c.allowedSegments ? c.allowedSegments.map(s => ({ segmentId: s.segmentId, ...(!compact?{oldTextSha256:s.expectedTextSha256}:{}), newText: solution }))
      : [{ fieldPath: 'teachingSolution', ...(c.fieldHashMode ? { oldTextSha256: qualityHash(ctx.candidate.teachingSolution) } : { oldText: ctx.candidate.teachingSolution }), newText: solution }], unresolvedIssues: [],
    qualityResolutions: (c.qualityFindings??ctx.reviewFindings.filter(f => f.type === 'quality')).map(f => ({ id: f.id, status: c.resolutionVersion === 2 ? 'repaired' : 'resolved', basis: '已补写整数加法等式。' })),
    ...(c.termFindings ? { termResolutions: c.termFindings.map(f => ({ findingId: f.findingId, status: 'repaired', basis: '模拟：相关原字段已实际改写为具体计算。' })) } : {}) };
}
test('no forbidden word but explicit semantic finding routes once and holds unlocated repair rather than widening fields', async () => {
  for (const dimension of ['mathematics', 'proof', 'method']) {
    const draft = candidate(); let calls = 0;
    const out = await runTeachingQualityPipeline({ originalMaterial: original, generate: async () => draft, review: async ctx => { calls++; assert.deepEqual(ctx.patchContract.allowedSegments, []); return reply(ctx); }, externalQualityReview: audit(draft, dimension) });
    assert.equal(calls, 1); assert.equal(out.reviewCalls, 1); assert.equal(out.status, 'review_failed'); assert.equal(out.error.code, 'teaching_quality_unchanged');
    assert.deepEqual(out.initialResult, draft); assert.equal(out.finalResult, null);
    assert(!Object.hasOwn(out, 'mathematicallyCorrect')); assert.deepEqual(draft, candidate());
  }
});
test('same generation emits non-display quality signals; all-pass is only self-check', async () => {
  for (const concern of [false, true]) {
    let calls = 0; const checks = Object.fromEntries(['mathematics', 'proof', 'method', 'explanation', 'assessment'].map(d => [d, 'pass']));
    if (concern) checks.proof = 'concern';
    const out = await runTeachingQualityPipeline({ originalMaterial: original, generate: async () => ({ candidate: candidate(), qualitySignals: { questionId: original.questionId, checks, findings: concern ? [flag('proof')] : [] } }), review: async ctx => { calls++; return reply(ctx); } });
    assert.equal(calls, concern ? 1 : 0); assert.equal(out.semanticAssessment, 'model_self_check_only'); assert.equal(out.status, concern ? 'review_failed' : 'ready_candidate');
  }
});
test('continuation never regenerates clean drafts or spends Qwen allowance twice; new findings remain visible', async () => {
  const prior = { status: 'ready_candidate', candidateResult: candidate(), sourceContentSha256: qualityHash(original), reviewCalls: 1 };
  const options = { originalMaterial: original, previousWorkflow: prior, generate: async () => assert.fail('regenerate'), review: async () => assert.fail('repeat review') };
  assert.deepEqual(await runTeachingQualityPipeline(options), prior);
  const out = await runTeachingQualityPipeline({ ...options, externalQualityReview: audit(candidate(), 'proof') });
  assert.equal(out.status, 'needs_review'); assert.equal(out.reviewSkipped, 'allowance_spent'); assert.equal(out.reviewCalls, 1); assert.equal(out.finalResult, null); assert(out.needsReviewReasons.some(f => f.type === 'quality'));
});
test('cannot clear semantic finding with unchanged proof, missing resolution, source mutation or unsafe patch', async () => {
  for (const alter of [p => { p.patches = []; }, p => { delete p.qualityResolutions; }, p => { p.patches[0].oldTextSha256 = 'wrong'; }, p => { p.patches[0].fieldPath = 'stem'; }, p => { p.sourceContentSha256 = 'forged'; }, p => { p.qualityResolutions[0].status = 'unresolved'; }]) {
    const draft = candidate(); draft.teachingSolution = '目标式由题意得2。';
    const out = await runTeachingQualityPipeline({ originalMaterial: original, generate: async () => draft, externalQualityReview: audit(draft, 'proof'), review: async ctx => { const p = reply(ctx); alter(p); return p; } });
    assert.equal(out.status, 'review_failed'); assert.equal(out.reviewCalls, 1); assert.equal(out.finalResult, null);
  }
  const wrong = audit(candidate(), 'mathematics'); wrong.candidateSha256 = 'old';
  const out = await runTeachingQualityPipeline({ originalMaterial: original, generate: async () => candidate(), externalQualityReview: wrong, review: async () => assert.fail('unbound audit') });
  assert.equal(out.status, 'generation_failed'); assert.equal(out.reviewCalls, 0);
});
test('assessment without a precise text location cannot rewrite difficulty level or requirement arrays', async () => {
  let calls = 0;
  const out = await runTeachingQualityPipeline({ originalMaterial: original, generate: async () => candidate(), externalQualityReview: audit(candidate(), 'assessment'), review: async ctx => {
    calls++; assert.deepEqual(ctx.patchContract.allowedSegments, []); const next = candidate(); next.difficultyAssessment.level = 'easy_medium'; next.teachingFocus.studentRequirements.push('能解释计算。');
    return { candidate: next, qualityResolutions: [{ id: 'audit-assessment', status: 'resolved', basis: '模拟核验：另需简单表示转换。' }] };
  } });
  assert.equal(calls, 1); assert.equal(out.reviewMode, 'bounded_patch'); assert.equal(out.status, 'review_failed'); assert.equal(out.finalResult, null); assert.deepEqual(out.initialResult, candidate());
});

test('located clause plus explicit semantic concern repairs only that sentence and preserves adjacent proof', async () => {
  const draft = candidate(); draft.teachingSolution = '先确认两项均为1。目标式由题意得2。结果为2。';
  const evidence=audit(draft,'proof');evidence.findings[0].quote='目标式由题意得2。';
  const out = await runTeachingQualityPipeline({ originalMaterial: original, generate: async () => draft, externalQualityReview: evidence, review: async ctx => {
    assert.equal(ctx.patchContract.allowedSegments.length, 1); assert.equal(ctx.patchContract.allowedSegments[0].expectedText, '目标式由题意得2。'); return reply(ctx);
  } });
  assert.equal(out.status, 'ready_candidate'); assert.equal(out.finalResult.teachingSolution, '先确认两项均为1。计算 $1+1=2$，得2。结果为2。');
});
test('v2 semantic patch hashes current text; historical v1 quality contracts replay byte-exactly', () => {
  const ctx = { originalMaterial: original, candidate: candidate(), reviewFindings: [{ type: 'quality', ...flag('proof') }] };
  ctx.patchContract = createTeachingPatchContract(ctx);
  assert.equal(ctx.patchContract.fieldHashMode, true);
  assert.equal(ctx.patchContract.allowedFields.find(f => f.fieldPath === 'teachingSolution').expectedTextSha256, qualityHash(candidate().teachingSolution));
  const response = reply(ctx);
  assert(!Object.hasOwn(response.patches[0], 'oldText'));
  assert.equal(mergeTeachingBoundedPatch(ctx, response).teachingSolution, '计算 $1+1=2$，得2。');
  const mutated = structuredClone(ctx); mutated.candidate.teachingSolution += ' ';
  assert.throws(() => mergeTeachingBoundedPatch(mutated, response));
  const old = structuredClone(ctx); delete old.patchContract.fieldHashMode;
  for (const field of old.patchContract.allowedFields) delete field.expectedTextSha256;
  const before = structuredClone(old);
  assert.deepEqual(createTeachingPatchContract(old), old.patchContract);
  assert.equal(mergeTeachingBoundedPatch(old, reply(old)).teachingSolution, '计算 $1+1=2$，得2。');
  assert.deepEqual(old, before);
  const mixed = reply(ctx); mixed.patches[0].oldText = candidate().teachingSolution;
  assert.throws(() => mergeTeachingBoundedPatch(ctx, mixed), { code: 'invalid_teaching_patch' });
});

test('an explicitly quoted independent proof finding grants only its own exact sentence', async () => {
  const draft=candidate();draft.teachingSolution='先确定 $x>0$。由导数得结论。最后取等号。';
  const evidence=audit(draft,'proof');evidence.findings[0].quote='由导数得结论。';
  const out=await runTeachingQualityPipeline({originalMaterial:original,generate:async()=>draft,externalQualityReview:evidence,review:async ctx=>{
    assert.equal(ctx.patchContract.allowedSegments.length,1);assert.equal(ctx.patchContract.allowedSegments[0].expectedText,'由导数得结论。');
    assert.equal(ctx.reviewResponseContract.requiredKeys.includes('qualityResolutions'),true);
    return reply(ctx,'由已知 $1+1=2$ 得结论。');
  }});
  assert.equal(out.status,'ready_candidate');assert.equal(out.finalResult.teachingSolution,'先确定 $x>0$。由已知 $1+1=2$ 得结论。最后取等号。');
  for(const quote of ['', ' ', 2, '字'.repeat(1601)])assert.throws(()=>validateQualityFindings([{...flag('proof'),quote}]),{code:'invalid_quality_signals'});
  assert.throws(()=>validateQualityFindings([{...flag('proof'),quote:'原句',extra:true}]),{code:'invalid_quality_signals'});
});


test('full candidate recovery uses context resolution v2 while saved legacy contract keeps prior meaning', () => {
  const ctx={originalMaterial:original,candidate:candidate(),reviewFindings:[{type:'quality',...flag('proof')}],reviewResolutionVersion:2};
  const reply={qualityResolutions:[{id:'audit-proof',status:'false_positive',basis:'模拟：原文的1+1=2完整说明了本题加法，所指缺口不成立。'}]};
  assert.doesNotThrow(()=>validateQualityResolutions(ctx,reply,candidate()));
  for(const status of ['resolved','confirmed_defect','unresolved']){reply.qualityResolutions[0].status=status;assert.throws(()=>validateQualityResolutions(ctx,reply,candidate()),{code:'teaching_quality_unresolved'});}
  reply.qualityResolutions[0].status='repaired';assert.throws(()=>validateQualityResolutions(ctx,reply,candidate()),{code:'teaching_quality_unchanged'});
  const next=candidate();next.teachingSolution+='计算完毕。';assert.doesNotThrow(()=>validateQualityResolutions(ctx,reply,next));
  const unrelated=candidate();unrelated.difficultyAssessment.basis='模拟：难度依据改变。';assert.throws(()=>validateQualityResolutions(ctx,reply,unrelated),{code:'teaching_quality_unchanged'});
  const legacy={...ctx,patchContract:{}};reply.qualityResolutions[0].status='resolved';assert.doesNotThrow(()=>validateQualityResolutions(legacy,reply,next));
});
