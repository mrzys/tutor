import test from 'node:test';
import assert from 'node:assert/strict';
import { runTeachingQualityPipeline } from '../lib/teaching-quality-pipeline.mjs';
import { qualityHash } from '../lib/teaching-quality-signals.mjs';
import { createTeachingPatchContract, mergeTeachingBoundedPatch } from '../lib/teaching-bounded-patch.mjs';
const original = { questionId: 'sim-quality-signal', stem: '模拟回归：求1+1' };
const candidate = () => ({ questionId: original.questionId, answer: '2', teachingSolution: '由题意得2。', difficultyAssessment: { level: 'easy', basis: '直接进行加法。' }, teachingFocusSchemaVersion: 2, teachingFocus: { examFocus: '整数加法。', studentRequirements: ['能完成加法。'] }, issues: [] });
const flag = dimension => ({ id: `audit-${dimension}`, dimension, fieldPath: dimension === 'assessment' ? 'difficultyAssessment.level' : 'teachingSolution', reason: '模拟核验：本段缺少1+1计算等式。' });
const audit = (draft, dimension) => ({ questionId: original.questionId, sourceContentSha256: qualityHash(original), candidateSha256: qualityHash(draft), method: 'user_authorized_agent_review', checkedBy: 'codex', evidence: '模拟独立核验原题和计算。', findings: [flag(dimension)] });
function reply(ctx, solution = '计算 $1+1=2$，得2。') {
  return { questionId: ctx.patchContract.questionId, candidateSha256: ctx.patchContract.candidateSha256, sourceContentSha256: ctx.patchContract.sourceContentSha256,
    patches: [{ fieldPath: 'teachingSolution', ...(ctx.patchContract.fieldHashMode ? { oldTextSha256: qualityHash(ctx.candidate.teachingSolution) } : { oldText: ctx.candidate.teachingSolution }), newText: solution }], unresolvedIssues: [],
    qualityResolutions: ctx.reviewFindings.filter(f => f.type === 'quality').map(f => ({ id: f.id, status: 'resolved', basis: '已补写整数加法等式。' })) };
}
test('no forbidden word but explicit math/proof/method findings each route one semantic repair', async () => {
  for (const dimension of ['mathematics', 'proof', 'method']) {
    const draft = candidate(); let calls = 0;
    const out = await runTeachingQualityPipeline({ originalMaterial: original, generate: async () => draft, review: async ctx => { calls++; assert(ctx.patchContract.allowedFields.some(f => f.fieldPath === 'answer')); return reply(ctx); }, externalQualityReview: audit(draft, dimension) });
    assert.equal(calls, 1); assert.equal(out.reviewCalls, 1); assert.equal(out.status, 'ready_candidate');
    assert(!Object.hasOwn(out, 'mathematicallyCorrect')); assert.deepEqual(draft, candidate());
  }
});
test('same generation emits non-display quality signals; all-pass is only self-check', async () => {
  for (const concern of [false, true]) {
    let calls = 0; const checks = Object.fromEntries(['mathematics', 'proof', 'method', 'explanation', 'assessment'].map(d => [d, 'pass']));
    if (concern) checks.proof = 'concern';
    const out = await runTeachingQualityPipeline({ originalMaterial: original, generate: async () => ({ candidate: candidate(), qualitySignals: { questionId: original.questionId, checks, findings: concern ? [flag('proof')] : [] } }), review: async ctx => { calls++; return reply(ctx); } });
    assert.equal(calls, concern ? 1 : 0); assert.equal(out.semanticAssessment, 'model_self_check_only'); assert.equal(out.status, 'ready_candidate');
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
    const out = await runTeachingQualityPipeline({ originalMaterial: original, generate: async () => candidate(), externalQualityReview: audit(candidate(), 'proof'), review: async ctx => { const p = reply(ctx); alter(p); return p; } });
    assert.equal(out.status, 'review_failed'); assert.equal(out.reviewCalls, 1); assert.equal(out.finalResult, null);
  }
  const wrong = audit(candidate(), 'mathematics'); wrong.candidateSha256 = 'old';
  const out = await runTeachingQualityPipeline({ originalMaterial: original, generate: async () => candidate(), externalQualityReview: wrong, review: async () => assert.fail('unbound audit') });
  assert.equal(out.status, 'generation_failed'); assert.equal(out.reviewCalls, 0);
});
test('assessment selects full contract initially so level and requirement lists can change in same review', async () => {
  let calls = 0;
  const out = await runTeachingQualityPipeline({ originalMaterial: original, generate: async () => candidate(), externalQualityReview: audit(candidate(), 'assessment'), review: async ctx => {
    calls++; assert(!ctx.patchContract); const next = candidate(); next.difficultyAssessment.level = 'easy_medium'; next.teachingFocus.studentRequirements.push('能解释计算。');
    return { candidate: next, qualityResolutions: [{ id: 'audit-assessment', status: 'resolved', basis: '模拟核验：另需简单表示转换。' }] };
  } });
  assert.equal(calls, 1); assert.equal(out.reviewMode, 'full_review'); assert.equal(out.status, 'ready_candidate'); assert.equal(out.finalResult.difficultyAssessment.level, 'easy_medium');
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
