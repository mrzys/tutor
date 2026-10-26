import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyTeachingTextPatches, createTeachingPatchContract, mergeTeachingBoundedPatch, teachingPatchHash } from '../lib/teaching-bounded-patch.mjs';

const fixture = JSON.parse(await readFile(new URL('../resources/teaching-bounded-patch-fixtures.json', import.meta.url), 'utf8'));
const candidate = () => structuredClone(fixture.cases[0].candidate);
const context = () => ({ originalMaterial: { questionId: candidate().questionId, stem: '模拟原题：1+1？' }, candidate: candidate(),
  reviewFindings: [{ type: 'term', fieldPath: 'teachingSolution', term: '模拟需核对词' }] });
const response = ctx => ({ questionId: ctx.patchContract.questionId, candidateSha256: ctx.patchContract.candidateSha256,
  sourceContentSha256: ctx.patchContract.sourceContentSha256, patches: [{ fieldPath: 'teachingSolution', oldText: ctx.candidate.teachingSolution, newText: '模拟局部补充说明：1+1=2。' }], unresolvedIssues: [] });

test('shared simulated Rust/JS patch boundary fixtures preserve caller objects and reject atomically', () => {
  assert.equal(fixture.version, 1); assert.equal(fixture.cases.length, 18);
  for (const entry of fixture.cases) {
    const before = structuredClone(entry);
    if (entry.accepted) {
      const revised = applyTeachingTextPatches(entry.candidate, entry.candidate.questionId, entry.patches, entry.allowedFieldPaths);
      assert.equal(revised.questionId, entry.candidate.questionId, entry.name);
      assert.deepEqual(revised.issues, entry.candidate.issues, entry.name);
    } else assert.throws(() => applyTeachingTextPatches(entry.candidate, entry.candidate.questionId, entry.patches, entry.allowedFieldPaths), undefined, entry.name);
    assert.deepEqual(entry, before, entry.name);
  }
});

test('a complete located finding yields a deduplicated exact text contract; ambiguous cases keep full review', () => {
  const ctx = context(); ctx.reviewFindings.push({ ...ctx.reviewFindings[0] });
  const contract = createTeachingPatchContract(ctx);
  assert.deepEqual(contract.allowedFields, [{ fieldPath: 'teachingSolution', expectedText: ctx.candidate.teachingSolution }]);
  assert.equal(contract.candidateSha256, teachingPatchHash(ctx.candidate));
  assert.equal(contract.sourceContentSha256, teachingPatchHash(ctx.originalMaterial));
  for (const change of [c => { c.candidate.issues = ['模拟材料疑点']; }, c => { c.candidate = null; },
    c => { c.reviewFindings = []; }, c => { c.reviewFindings[0].type = 'model_issue'; },
    c => { delete c.reviewFindings[0].fieldPath; }, c => { c.reviewFindings[0].fieldPath = 'issues[0]'; },
    c => { c.candidate.answer = ''; }]) {
    const changed = context(); change(changed); assert.equal(createTeachingPatchContract(changed), null);
  }
});

test('response must match current question, source, candidate and allowed scope; no fallback to full objects', () => {
  const ctx = context(); ctx.patchContract = createTeachingPatchContract(ctx);
  const before = structuredClone(ctx), patch = response(ctx);
  const revised = mergeTeachingBoundedPatch(ctx, patch);
  assert.equal(revised.teachingSolution, patch.patches[0].newText);
  assert.equal(revised.answer, ctx.candidate.answer);
  assert.deepEqual(ctx, before);
  for (const mutate of [p => { p.questionId = 'other'; }, p => { p.sourceContentSha256 = '0'.repeat(64); },
    p => { p.candidateSha256 = '0'.repeat(64); }, p => { p.extra = true; },
    p => { p.patches[0].fieldPath = 'answer'; p.patches[0].oldText = '2'; },
    p => { p.patches[0].oldText = '过期原文'; }]) {
    const altered = structuredClone(patch); mutate(altered); assert.throws(() => mergeTeachingBoundedPatch(ctx, altered));
  }
  assert.throws(() => mergeTeachingBoundedPatch(ctx, ctx.candidate));
  const changedSource = structuredClone(ctx); changedSource.originalMaterial.stem = '模拟原题已变';
  assert.throws(() => mergeTeachingBoundedPatch(changedSource, patch));
  const changedCandidate = structuredClone(ctx); changedCandidate.candidate.answer = '3';
  assert.throws(() => mergeTeachingBoundedPatch(changedCandidate, patch));
  const widened = structuredClone(ctx); widened.patchContract.allowedFields.push({ fieldPath: 'answer', expectedText: '2' });
  assert.throws(() => mergeTeachingBoundedPatch(widened, patch));
});

test('unresolved issues do not apply any patch or claim completion; no-op only preserves existing draft', () => {
  const ctx = context(); ctx.patchContract = createTeachingPatchContract(ctx);
  const patch = response(ctx); patch.unresolvedIssues = ['模拟：发现答案也需核对，超出本次字段范围。'];
  assert.throws(() => mergeTeachingBoundedPatch(ctx, patch), { code: 'teaching_patch_unresolved' });
  assert.equal(ctx.candidate.teachingSolution, candidate().teachingSolution);
  const noop = { ...response(ctx), patches: [] };
  assert.deepEqual(mergeTeachingBoundedPatch(ctx, noop), ctx.candidate);
});
