import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTeachingSentencePatchContract, mergeTeachingSentencePatch, teachingSentenceRanges, teachingReviewResponseContract, filterReviewedTermFindings,
  teachingReviewModelContract, expandTeachingReviewResponse } from '../lib/teaching-sentence-patch.mjs';
import { qualityHash } from '../lib/teaching-quality-signals.mjs';

const candidate = () => ({ questionId: 'simulated-sentence-patch', answer: '2', difficultyAssessment: { level: 'easy', basis: '模拟：直接计算。' },
  teachingSolution: '先由条件得 $x=1$。再计算目标式 $x+1=2$。最后取等号。', teachingFocusSchemaVersion: 2,
  teachingFocus: { examFocus: '模拟整数运算。', studentRequirements: ['能完成模拟计算。'] }, issues: [] });
function context(text = candidate().teachingSolution, finding = { type: 'term', fieldPath: 'teachingSolution', term: '目标式' }) {
  const ctx = { originalMaterial: { questionId: candidate().questionId, questionType: 'fill_blank', stem: '模拟原题：1+1？' }, candidate: { ...candidate(), teachingSolution: text }, reviewFindings: [finding] };
  ctx.patchContract = createTeachingSentencePatchContract(ctx); return ctx;
}
const response = ctx => {
  const full = ctx.patchContract, compact = full.segmentPatchVersion === 2, c = teachingReviewModelContract(full);
  return { ...(compact ? { requestId: c.requestId } : { questionId: c.questionId, candidateSha256: c.candidateSha256, sourceContentSha256: c.sourceContentSha256 }),
    patches: c.allowedSegments.map(s => ({ segmentId: s.segmentId, ...(!compact ? { oldTextSha256: s.expectedTextSha256 } : {}), newText: s.expectedText.replace('目标式', '所求式子') })), unresolvedIssues: [],
    ...(c.qualityFindings ? { qualityResolutions: c.qualityFindings.map(f => ({ id: f.id, status: 'repaired', basis: '模拟：核对相关文字与推导。' })) } : {}),
    ...(c.allowedIssues ? { issueResolutions: c.allowedIssues.map(i => ({ issueIndex: i.issueIndex, ...(!compact ? { oldTextSha256: i.expectedTextSha256 } : {}), status: 'false_positive', basis: '模拟：已提供题型，与当前文字一致，不缺失。' })) } : {}),
    ...(c.termFindings ? { termResolutions: c.termFindings.map(f => ({ findingId: f.findingId, status: 'false_positive', basis: '模拟：核对原字段及原题，当前词语用于已给条件的普通数量说明。' })) } : {}) };
};
function savedV1(ctx) {
  const c = ctx.patchContract; c.segmentPatchVersion = 1; delete c.requestId; delete c.falsePositiveScopeVersion; return ctx;
}

test('new classroom limit contract requires actual rewrite, preserving legacy replay and unrelated term exemptions', () => {
  const text=String.raw`已知 $0<x<1$。故 $\lim_{x\to0}h(x)=1$。后文保持。`;
  const term=String.raw`\lim`, start=text.indexOf(term);
  const ctx=context(text,{type:'term',ruleId:'limit-notation',fieldPath:'teachingSolution',term,start,end:start+term.length});
  const before=structuredClone(ctx), reply=response(ctx);reply.patches=[];
  assert.equal(ctx.patchContract.classroomPolicyVersion,1);
  assert.equal(ctx.patchContract.termFindings[0].requiredAction,'rewrite_without_limits');
  assert.throws(()=>mergeTeachingSentencePatch(ctx,reply),{code:'teaching_classroom_rewrite_required'});
  reply.termResolutions[0].status='repaired';
  assert.throws(()=>mergeTeachingSentencePatch(ctx,reply),{code:'teaching_quality_unchanged'});
  const segment=ctx.patchContract.allowedSegments[0];
  reply.patches=[{segmentId:segment.segmentId,newText:'由已知不等式可直接选取满足条件的正数，再代入验证。'}];
  const next=mergeTeachingSentencePatch(ctx,reply);
  assert.equal(next.teachingSolution,'已知 $0<x<1$。由已知不等式可直接选取满足条件的正数，再代入验证。后文保持。');
  // This verifies scope and actual text changes, not mathematical adequacy.
  const legacy=savedV1(structuredClone(ctx));delete legacy.patchContract.classroomPolicyVersion;delete legacy.patchContract.termFindings[0].requiredAction;
  legacy.classroomPolicyVersion=1;
  const oldReply={...response(legacy),patches:[]};
  assert.deepEqual(mergeTeachingSentencePatch(legacy,oldReply),legacy.candidate);
  assert.deepEqual(ctx,before);
});

test('issue-only review can retract a model false alert without any text mutation, but unresolved never releases', () => {
  const ctx=context();ctx.candidate.issues=['模拟：题干未写单选或多选。'];ctx.originalMaterial.questionType='multiple_choice';
  ctx.reviewFindings=[{type:'model_issue',issue:ctx.candidate.issues[0]}, {type:'quality',id:'material-type',dimension:'material',fieldPath:'issues',reason:'模拟题型核对'}];
  ctx.patchContract=createTeachingSentencePatchContract(ctx);
  const schema=teachingReviewResponseContract(ctx.patchContract);
  assert.deepEqual(ctx.patchContract.allowedSegments,[]);assert.equal(schema.textMutationAllowed,false);
  assert.equal(schema.issueResolutionAllowed,true);assert.equal(schema.issueResolutionNeedsTextPatch,false);
  assert.deepEqual(schema.requiredKeys,['requestId','patches','unresolvedIssues','qualityResolutions','issueResolutions']);
  const reply=response(ctx);reply.qualityResolutions[0].status='false_positive';
  const revised=mergeTeachingSentencePatch(ctx,reply);
  assert.deepEqual(revised,{...ctx.candidate,issues:[]});assert.equal(ctx.candidate.issues.length,1);
  const unresolved=response(ctx);unresolved.issueResolutions[0].status='unresolved';assert.throws(()=>mergeTeachingSentencePatch(ctx,unresolved),{code:'teaching_patch_unresolved'});
  const termOnly=teachingReviewResponseContract(context().patchContract);assert(!termOnly.requiredKeys.includes('qualityResolutions'));
});

test('simulated q06-style review grants one complete sentence and keeps neighboring equalities byte-identical', () => {
  const text = "先得 $F'(x)=e^x+1-m-1/x$。则 $F''(x)=e^x+1/x^2>0$，故导函数递增。最后由 $F'(1)=0$ 得最小值。";
  const ctx = context(text, { type: 'term', fieldPath: 'teachingSolution', term: "F''" }), before = structuredClone(ctx);
  assert.equal(ctx.patchContract.allowedSegments.length, 1);
  assert.equal(ctx.patchContract.allowedSegments[0].expectedText, "则 $F''(x)=e^x+1/x^2>0$，故导函数递增。");
  const patch = response(ctx); patch.patches[0].newText = '因为指数函数和负倒数函数均递增，所以导函数递增。';
  const next = mergeTeachingSentencePatch(ctx, patch);
  assert.equal(next.teachingSolution, "先得 $F'(x)=e^x+1-m-1/x$。因为指数函数和负倒数函数均递增，所以导函数递增。最后由 $F'(1)=0$ 得最小值。");
  assert.deepEqual(ctx, before);
});

test('Unicode scalar contracts convert UTF16 findings exactly, including repeated text and stale offsets', () => {
  const text = '😀先计算目标式。再计算目标式。', at = text.lastIndexOf('目标式');
  const ctx = context(text, { type: 'term', fieldPath: 'teachingSolution', term: '目标式', start: at, end: at + 3 });
  assert.equal(ctx.patchContract.allowedSegments[0].expectedText, '再计算目标式。');
  assert.equal(ctx.patchContract.allowedSegments[0].start, [...'😀先计算目标式。'].length);
  assert.equal(context(text).patchContract.allowedSegments.length, 0);
  assert.equal(context(text, { type: 'term', fieldPath: 'teachingSolution', term: '目标式', start: 1, end: 4 }).patchContract.allowedSegments.length, 0);
  const unique = context('😀先计算。目标式为2。', { type: 'term', fieldPath: 'teachingSolution', term: '目标式', start: 1, end: 2 });
  assert.equal(unique.patchContract.allowedSegments[0].expectedText, '目标式为2。');
});

test('math punctuation and newlines stay atomic for all four delimiters; unclosed math is not widened', () => {
  for (const [open, close] of [['$', '$'], ['$$', '$$'], ['\\(', '\\)'], ['\\[', '\\]']]) {
    const text = `前句。计算${open}a。\nb=目标式${close}，再整理。后句。`, ctx = context(text);
    assert.equal(ctx.patchContract.allowedSegments[0].expectedText, `计算${open}a。\nb=目标式${close}，再整理。`);
  }
  assert.equal(context('前句。计算 $a=目标式。\n后句。').patchContract.allowedSegments.length, 0);
  assert.deepEqual(teachingSentenceRanges('取3.14。下一句. 再下一句！').map(r => [...'取3.14。下一句. 再下一句！'].slice(r.start, r.end).join('')), ['取3.14。', '下一句.', ' 再下一句！']);
});

test('overlapping actual findings deduplicate while independent sentences merge atomically descending', () => {
  const ctx = context('目标式需调整。中间保持原样。目标函数需调整。');
  ctx.reviewFindings = [{ type: 'term', fieldPath: 'teachingSolution', term: '目标式' }, { type: 'term', fieldPath: 'teachingSolution', term: '目标' }, { type: 'term', fieldPath: 'teachingSolution', term: '目标函数' }];
  ctx.patchContract = createTeachingSentencePatchContract(ctx);
  assert.equal(ctx.patchContract.allowedSegments.length, 2);
  const patch = response(ctx); patch.patches[1].newText = '另一所求式子需调整。';
  const next = mergeTeachingSentencePatch(ctx, patch);
  assert.equal(next.teachingSolution, '所求式子需调整。中间保持原样。另一所求式子需调整。');
});

test('no semantic reason grants a whole field; exact quote can grant only its own sentence', () => {
  const finding = { type: 'quality', id: 'proof-1', dimension: 'proof', fieldPath: 'teachingSolution', reason: '模拟：中间理由需要核对。' };
  const ctx = context(undefined, finding);
  assert.deepEqual(ctx.patchContract.allowedSegments, []);
  assert.throws(() => mergeTeachingSentencePatch(ctx, response(ctx)), { code: 'teaching_quality_unchanged' });
  const located = context(undefined, { ...finding, quote: '再计算目标式 $x+1=2$。' });
  assert.equal(located.patchContract.allowedSegments[0].expectedText, '再计算目标式 $x+1=2$。');
  assert.equal(mergeTeachingSentencePatch(located, response(located)).answer, '2');
});

test('source/candidate/scope CAS, IDs, duplicates and response schema are enforced without fallback', () => {
  const ctx = context(), patch = response(ctx), before = structuredClone(ctx);
  for (const mutate of [p => { p.questionId = 'other'; }, p => { p.candidateSha256 = '0'.repeat(64); }, p => { p.sourceContentSha256 = '0'.repeat(64); },
    p => { p.patches[0].oldTextSha256 = '0'.repeat(64); }, p => { p.patches[0].segmentId = 's99'; }, p => { p.patches.push(p.patches[0]); },
    p => { p.patches[0].fieldPath = 'answer'; }, p => { p.extra = true; }, p => { p.patches[0].newText = 'a'.repeat(1001); }]) {
    const bad = structuredClone(patch); mutate(bad); assert.throws(() => mergeTeachingSentencePatch(ctx, bad));
  }
  for (const mutate of [c => { c.originalMaterial.stem = '已变更'; }, c => { c.candidate.answer = '3'; },
    c => { c.patchContract.allowedSegments[0].start = 0; }, c => { c.patchContract.allowedSegments[0].fieldPath = 'answer'; },
    c => { c.patchContract.allowedSegments.push(c.patchContract.allowedSegments[0]); }]) {
    const bad = structuredClone(ctx); mutate(bad); assert.throws(() => mergeTeachingSentencePatch(bad, patch));
  }
  assert.deepEqual(ctx, before);
  assert.throws(() => mergeTeachingSentencePatch(ctx, { ...patch, patches: [{ fieldPath: 'teachingSolution', oldText: ctx.candidate.teachingSolution, newText: '重写整题' }] }));
});

test('all issues require exact model resolutions; unresolved/error never clears even valid text patches', () => {
  const ctx = context(); ctx.candidate.issues = ['模拟：题型未给出。'];
  ctx.originalMaterial.questionType = 'multiple_choice';
  ctx.reviewFindings.push({ type: 'model_issue', issue: ctx.candidate.issues[0] }, { type: 'quality', id: 'material-1', dimension: 'material', fieldPath: 'issues[0]', reason: '模拟：核对材料题型。' });
  ctx.patchContract = createTeachingSentencePatchContract(ctx); const before = structuredClone(ctx), patch = response(ctx);
  patch.qualityResolutions[0].status = 'false_positive';
  const next = mergeTeachingSentencePatch(ctx, patch);
  assert.deepEqual(next.issues, []); assert.equal(next.answer, ctx.candidate.answer);
  for (const mutate of [p => { delete p.issueResolutions; }, p => { p.issueResolutions[0].status = 'unresolved'; }, p => { p.issueResolutions[0].basis = ''; },
    p => { p.issueResolutions[0].oldTextSha256 = '0'.repeat(64); }, p => { p.issueResolutions[0].issueIndex = 1; }, p => { p.unresolvedIssues = ['模拟：仍需查原卷。']; },
    p => { p.qualityResolutions[0].status = 'unresolved'; }]) {
    const bad = structuredClone(patch); mutate(bad); assert.throws(() => mergeTeachingSentencePatch(ctx, bad));
  }
  assert.deepEqual(ctx, before);
});

test('noop preserves complete candidate and data-like instructions are never evaluated', () => {
  const ctx = context(), patch = { ...response(ctx), patches: [] };
  assert.deepEqual(mergeTeachingSentencePatch(ctx, patch), ctx.candidate);
  const nextPatch = response(ctx); nextPatch.patches[0].newText = '模拟数据：<script>throw new Error("not executable")</script>。';
  assert.match(mergeTeachingSentencePatch(ctx, nextPatch).teachingSolution, /not executable/u);
  const long = context('目标式' + 'a'.repeat(1601)); assert.deepEqual(long.patchContract.allowedSegments, []);
  assert.equal(createTeachingSentencePatchContract({ originalMaterial: ctx.originalMaterial, candidate: null, reviewFindings: ctx.reviewFindings }), null);
  const incomplete = structuredClone(ctx); incomplete.candidate.difficultyAssessment.basis = ' ';
  assert.equal(createTeachingSentencePatchContract(incomplete), null);
  assert.equal(qualityHash(ctx.candidate), ctx.patchContract.candidateSha256);
});

test('simulated JS/Rust sentence fixtures specify exact ranges, hashes, atomic failures and untouched fields', async () => {
  const fixture = JSON.parse(await readFile(new URL('../resources/teaching-sentence-patch-fixtures.json', import.meta.url), 'utf8'));
  assert.equal(fixture.version, 1);
  for (const entry of fixture.cases) {
    const ctx = structuredClone(entry.context), before = structuredClone(ctx), contract = createTeachingSentencePatchContract(ctx);
    delete contract.resolutionVersion; delete contract.termFindings; delete contract.classroomPolicyVersion; delete contract.requestId; delete contract.falsePositiveScopeVersion; contract.segmentPatchVersion=1;
    assert.deepEqual(contract, entry.contract, entry.name); ctx.patchContract = structuredClone(entry.contract);
    if (entry.accepted) assert.deepEqual(mergeTeachingSentencePatch(ctx, entry.response), entry.expectedCandidate, entry.name);
    else assert.throws(() => mergeTeachingSentencePatch(ctx, entry.response), { code: entry.errorCode }, entry.name);
    delete ctx.patchContract; assert.deepEqual(ctx, before, entry.name);
  }
});


test('new resolution v2 never upgrades a saved legacy contract or accepts unsupported versions', () => {
  const ctx = context(undefined, { type: 'quality', id: 'proof-v2', dimension: 'proof', fieldPath: 'teachingSolution', quote: '再计算目标式 $x+1=2$。', reason: '模拟：需核对该步。' });
  assert.equal(ctx.patchContract.segmentPatchVersion, 2); assert.equal(ctx.patchContract.resolutionVersion, 2);
  assert.deepEqual(teachingReviewResponseContract(ctx.patchContract).resolutionStatuses, ['repaired','false_positive','confirmed_defect','unresolved']);
  const old = savedV1(structuredClone(ctx)); delete old.patchContract.resolutionVersion; old.reviewResolutionVersion = 2;
  const reply = response(old); reply.qualityResolutions[0].status = 'resolved';
  const before = structuredClone(old);
  assert.equal(mergeTeachingSentencePatch(old, reply).answer, '2'); assert.deepEqual(old, before);
  assert.throws(() => mergeTeachingSentencePatch(ctx, reply), { code: 'invalid_teaching_patch' });
  for (const version of [1,3,null,'2']) { const bad=structuredClone(ctx); bad.patchContract.resolutionVersion=version; assert.throws(()=>mergeTeachingSentencePatch(bad,response(ctx)), {code:'invalid_teaching_patch'}); }
});

test('v2 separates actual related repair, false alert, confirmed defect and unresolved without changing caller state', () => {
  const finding={type:'quality',id:'answer-repair',dimension:'mathematics',fieldPath:'answer',quote:'2',reason:'模拟：核对答案。'};
  const ctx=context(undefined,finding), before=structuredClone(ctx);
  const repaired=response(ctx); repaired.patches[0].newText='3';
  assert.equal(mergeTeachingSentencePatch(ctx,repaired).answer,'3');
  const noop=response(ctx); noop.patches=[];
  assert.throws(()=>mergeTeachingSentencePatch(ctx,noop),{code:'teaching_quality_unchanged'});
  noop.qualityResolutions[0].status='false_positive'; noop.qualityResolutions[0].basis='模拟：原题明确1+1，原答案2与直接相加一致，所指错误不成立。';
  assert.deepEqual(mergeTeachingSentencePatch(ctx,noop),ctx.candidate);
  for(const status of ['confirmed_defect','unresolved','resolved']) {
    const bad=structuredClone(repaired);bad.qualityResolutions[0].status=status;
    assert.throws(()=>mergeTeachingSentencePatch(ctx,bad),{code:'teaching_quality_unresolved'});
  }
  const unrelated=context(undefined,{...finding,quote:undefined});
  unrelated.reviewFindings.push({type:'term',fieldPath:'teachingSolution',term:'目标式'});unrelated.patchContract=createTeachingSentencePatchContract(unrelated);
  const wrong=response(unrelated);assert.throws(()=>mergeTeachingSentencePatch(unrelated,wrong),{code:'teaching_quality_unchanged'});
  assert.deepEqual(ctx,before);
});

test('issue repaired needs an authorized non-difficulty actual text change; confirmation cannot erase it', () => {
  const ctx=context();ctx.candidate.issues=['模拟：当前解析遗漏明确条件。'];
  ctx.reviewFindings=[{type:'term',fieldPath:'difficultyAssessment.basis',term:'直接计算'}];ctx.patchContract=createTeachingSentencePatchContract(ctx);
  const wrong=response(ctx);wrong.issueResolutions[0].status='repaired';wrong.patches[0].newText='模拟：需代入条件。';
  assert.throws(()=>mergeTeachingSentencePatch(ctx,wrong),{code:'teaching_quality_unchanged'});
  for(const status of ['confirmed_defect','unresolved','resolved']) {const bad=structuredClone(wrong);bad.issueResolutions[0].status=status;assert.throws(()=>mergeTeachingSentencePatch(ctx,bad));}
  ctx.reviewFindings.push({type:'term',fieldPath:'teachingSolution',term:'目标式'});ctx.patchContract=createTeachingSentencePatchContract(ctx);
  const repaired=response(ctx);repaired.issueResolutions[0].status='repaired';
  assert.deepEqual(mergeTeachingSentencePatch(ctx,repaired).issues,[]);
});

test('exact contextual term false positives allow zero patches and never become a word-wide exemption', () => {
  const text='先证明数量有上界。再作向量的线性表示。';
  const fs=[{type:'term',ruleId:'optimization-language',fieldPath:'teachingSolution',term:'上界',start:6,end:8},
    {type:'term',ruleId:'linear-representation',fieldPath:'teachingSolution',term:'线性表示',start:text.indexOf('线性表示'),end:text.indexOf('线性表示')+4}];
  const ctx=context(text);ctx.reviewFindings=[...fs,fs[0]];ctx.patchContract=createTeachingSentencePatchContract(ctx);
  assert.equal(ctx.patchContract.termFindings.length,2);
  for(const [i,f] of fs.entries())assert.equal(ctx.patchContract.termFindings[i].findingId,qualityHash([f.ruleId,f.fieldPath,f.term,f.start,f.end]));
  const reply=response(ctx);reply.patches=[];const next=mergeTeachingSentencePatch(ctx,reply);
  assert.deepEqual(filterReviewedTermFindings(fs,ctx,reply,next),[]);
  const newFindings=[{...fs[0],ruleId:'changed-dictionary-rule'}, {...fs[0],start:7}, {...fs[0],fieldPath:'answer'}, {type:'display',...fs[0],type:'display'}];
  assert.deepEqual(filterReviewedTermFindings(newFindings,ctx,reply,next),newFindings);
  const changedReply=response(ctx);changedReply.patches[0].newText='先证明数量有上界，再用范数。';
  const changed=mergeTeachingSentencePatch(ctx,changedReply);
  const newTerm={type:'term',ruleId:'norm',fieldPath:'teachingSolution',term:'范数',start:12,end:14};
  assert.deepEqual(filterReviewedTermFindings([fs[0],newTerm],ctx,changedReply,changed),[fs[0],newTerm]);
  const wrongNext=structuredClone(next);wrongNext.answer='3';assert.deepEqual(filterReviewedTermFindings(fs,ctx,reply,wrongNext),fs);
  const stale=structuredClone(ctx);stale.originalMaterial.stem+='变化';assert.throws(()=>filterReviewedTermFindings(fs,stale,reply,next));
  for(const mutate of [p=>{delete p.termResolutions;},p=>p.termResolutions.push(p.termResolutions[0]),p=>{p.termResolutions[0].status='resolved';},p=>{p.termResolutions[0].basis=' ';},p=>{p.termResolutions[0].status='confirmed_defect';},p=>{p.termResolutions[0].status='repaired';}]) {
    const bad=structuredClone(reply);mutate(bad);assert.throws(()=>mergeTeachingSentencePatch(ctx,bad));
  }
});

test('actual saved Yuxi15 resolved response replays only under its immutable legacy contract, never v2', async () => {
  const fixture=JSON.parse(await readFile(new URL('./fixtures/teaching-yuxi15-actual-legacy-review.json',import.meta.url),'utf8'));
  const ctx={...structuredClone(fixture.context),originalMaterial:structuredClone(fixture.sourceContent)}, before=structuredClone(fixture);
  assert.equal(qualityHash(ctx.originalMaterial),ctx.patchContract.sourceContentSha256);
  assert.equal(qualityHash(ctx.candidate),ctx.patchContract.candidateSha256);
  assert.equal(fixture.evidence.responseSha256,'e23c3a171924d8d92edcac24a945da52e591b02a7024d90d9086d848b8b2d213');
  assert.match(fixture.response.issueResolutions[0].basis,/缺陷|错误/u);
  // Reproduces historical mechanical acceptance; this is not a source/math approval.
  assert.deepEqual(mergeTeachingSentencePatch(ctx,fixture.response).issues,[]);
  const v2={...structuredClone(ctx),reviewResolutionVersion:2};v2.patchContract=createTeachingSentencePatchContract(v2);
  assert.throws(()=>mergeTeachingSentencePatch(v2,fixture.response),{code:'invalid_teaching_patch'});
  const current=response(v2);current.patches=[];
  current.issueResolutions[0].status='resolved';current.qualityResolutions[0].status='resolved';
  assert.throws(()=>mergeTeachingSentencePatch(v2,current),{code:'invalid_teaching_patch'});
  current.issueResolutions[0].status='confirmed_defect';current.qualityResolutions[0].status='confirmed_defect';
  assert.throws(()=>mergeTeachingSentencePatch(v2,current),{code:'teaching_patch_unresolved'});
  current.issueResolutions[0].status='repaired';current.qualityResolutions[0].status='repaired';
  assert.throws(()=>mergeTeachingSentencePatch(v2,current),{code:'teaching_quality_unchanged'});
  assert.deepEqual(fixture,before);
});

test('compact request exposes short aliases while the local contract and CAS retain full hashes', () => {
  const ctx=context();ctx.candidate.issues=['模拟：条件需核对。'];
  ctx.reviewFindings.push({type:'quality',id:'original-quality-id',dimension:'proof',fieldPath:'teachingSolution',quote:'目标式',reason:'模拟：核对推导。',nested:{candidateSha256:'e'.repeat(64)}});
  ctx.patchContract=createTeachingSentencePatchContract(ctx);
  const full=structuredClone(ctx.patchContract), model=teachingReviewModelContract(full), reply=response(ctx);
  const {requestId,...hashInput}=full;
  assert.equal(requestId,`r-${qualityHash(hashInput).slice(0,16)}`);
  assert.deepEqual(createTeachingSentencePatchContract(structuredClone(ctx)),full);
  assert.equal(model.termFindings[0].findingId,'t0');assert.equal(model.qualityFindings[0].id,'q0');
  assert(!Object.hasOwn(model,'questionId'));
  const assertNoHashKeys=value=>{if(value&&typeof value==='object')for(const [key,item] of Object.entries(value)){assert.doesNotMatch(key,/hash|sha256/iu);assertNoHashKeys(item);}};
  assertNoHashKeys(model);assert.equal(full.candidateSha256.length,64);assert.equal(full.allowedSegments[0].expectedTextSha256.length,64);
  assert.deepEqual(teachingReviewResponseContract(full).patchKeys,['segmentId','newText']);
  assert.deepEqual(teachingReviewResponseContract(full).issueResolutionKeys,['issueIndex','status','basis']);
  const expanded=expandTeachingReviewResponse(full,reply);
  assert.equal(expanded.qualityResolutions[0].id,'original-quality-id');
  assert.equal(expanded.termResolutions[0].findingId,full.termFindings[0].findingId);
  assert.equal(reply.qualityResolutions[0].id,'q0');assert.deepEqual(ctx.patchContract,full);
  assert.deepEqual(mergeTeachingSentencePatch(ctx,reply).issues,[]);
  for(const mutate of [p=>{p.requestId='r-0000000000000000';},p=>{p.termResolutions[0].findingId=full.termFindings[0].findingId;},
    p=>{p.qualityResolutions[0].id='original-quality-id';},p=>{p.qualityResolutions[0].id='q01';},p=>{p.patches[0].oldTextSha256=full.allowedSegments[0].expectedTextSha256;},
    p=>{p.issueResolutions[0].oldTextSha256=full.allowedIssues[0].expectedTextSha256;}]){
    const bad=structuredClone(reply);mutate(bad);assert.throws(()=>mergeTeachingSentencePatch(ctx,bad),{code:'invalid_teaching_patch'});
  }
  const changed=structuredClone(ctx);changed.reviewFindings[1].reason+='新意见';assert.throws(()=>mergeTeachingSentencePatch(changed,reply),{code:'invalid_teaching_patch'});
  const other=context();assert.throws(()=>mergeTeachingSentencePatch(other,reply),{code:'invalid_teaching_patch'});
});

function methodContext(body='第一步用目标工具得结论。第二步补足条件和端点。') {
  const text=`前问保持。${body}后问保持。`, ctx=context(text,{type:'term',ruleId:'simulated-tool',category:'special_tool',fieldPath:'teachingSolution',term:'目标工具'});
  ctx.reviewMethodScopes=[{fieldPath:'teachingSolution',start:[...'前问保持。'].length,end:[...`前问保持。${body}`].length,expectedText:body,scopeBasis:'模拟：仅对第二问的完整方法论证授权改写。'}];
  ctx.patchContract=createTeachingSentencePatchContract(ctx);return ctx;
}

test('an explicitly bound method block can replace several proof sentences without changing neighboring questions', () => {
  const ctx=methodContext(),before=structuredClone(ctx),segment=ctx.patchContract.allowedSegments[0];
  assert.equal(segment.scope,'method');assert.equal(segment.scopeBasis,ctx.reviewMethodScopes[0].scopeBasis);
  assert.deepEqual(ctx.patchContract.methodScopes,ctx.reviewMethodScopes);
  assert(!Object.hasOwn(teachingReviewModelContract(ctx.patchContract),'methodScopes'));
  assert.equal(segment.expectedText,'第一步用目标工具得结论。第二步补足条件和端点。');
  assert.equal(ctx.patchContract.termFindings[0].category,'special_tool');
  const reply=response(ctx);reply.patches[0].newText='先列出参数范围。逐种讨论端点、存在性和取等条件，再合并结论。';reply.termResolutions[0].status='repaired';
  assert.equal(mergeTeachingSentencePatch(ctx,reply).teachingSolution,'前问保持。先列出参数范围。逐种讨论端点、存在性和取等条件，再合并结论。后问保持。');
  const replay=structuredClone(ctx);delete replay.reviewMethodScopes;
  assert.deepEqual(mergeTeachingSentencePatch(replay,reply),mergeTeachingSentencePatch(ctx,reply));
  assert.deepEqual(ctx,before);
  const stale=structuredClone(ctx);stale.reviewMethodScopes[0].scopeBasis+='扩大至其他问';assert.throws(()=>mergeTeachingSentencePatch(stale,reply),{code:'invalid_teaching_patch'});
  const staleSource=structuredClone(ctx);staleSource.originalMaterial.stem+='变化';assert.throws(()=>mergeTeachingSentencePatch(staleSource,reply),{code:'invalid_teaching_patch'});
});

test('method authorization is explicit, exact, bounded and linked to a located method finding', () => {
  const valid=methodContext();
  for(const mutate of [c=>{c.reviewMethodScopes[0].expectedText+='变化';},c=>{c.reviewMethodScopes[0].start++;},c=>{c.reviewMethodScopes[0].end--;},
    c=>{c.reviewMethodScopes[0].scopeBasis=' ';},c=>{c.reviewMethodScopes[0].fieldPath='answer';},c=>{c.reviewMethodScopes.push(c.reviewMethodScopes[0]);},
    c=>{delete c.reviewFindings[0].category;},c=>{c.reviewFindings[0].term='不存在的工具';},c=>{c.reviewMethodScopes={};},c=>{c.reviewMethodScopes[0].start=-1;}]){
    const bad=structuredClone(valid);mutate(bad);assert.equal(createTeachingSentencePatchContract(bad),null);
  }
  const noScope=structuredClone(valid);delete noScope.reviewMethodScopes;delete noScope.patchContract;const sentence=createTeachingSentencePatchContract(noScope);
  assert.equal(sentence.allowedSegments[0].expectedText,'第一步用目标工具得结论。');assert(!Object.hasOwn(sentence.allowedSegments[0],'scope'));
  assert.deepEqual(createTeachingSentencePatchContract({...noScope,reviewMethodScopes:[]}),sentence);
  const methodFlag=structuredClone(valid);methodFlag.reviewFindings=[{type:'quality',id:'actual-method',dimension:'method',fieldPath:'teachingSolution',quote:'目标工具',reason:'模拟：需要调整本问方法。'}];
  assert.equal(createTeachingSentencePatchContract(methodFlag).allowedSegments[0].scope,'method');
  for(const dimension of ['proof','explanation','assessment']){const bad=structuredClone(methodFlag);bad.reviewFindings[0].dimension=dimension;assert.equal(createTeachingSentencePatchContract(bad),null);}
  const broadFinding=structuredClone(methodFlag);delete broadFinding.reviewFindings[0].quote;assert.equal(createTeachingSentencePatchContract(broadFinding),null);
  const crossingFinding=structuredClone(methodFlag);crossingFinding.candidate.teachingSolution+='额外论证'.repeat(500)+'。';
  crossingFinding.reviewFindings[0].quote=crossingFinding.candidate.teachingSolution.slice('前问保持。'.length);
  assert.equal(createTeachingSentencePatchContract(crossingFinding),null);
  const limit=structuredClone(valid);delete limit.reviewFindings[0].category;limit.reviewFindings[0].ruleId='limit-notation';assert.equal(createTeachingSentencePatchContract(limit).allowedSegments[0].scope,'method');
});

test('method block permits a larger bounded paragraph while huge or split-formula scopes remain rejected', () => {
  const ctx=methodContext('第一步用目标工具。'+'说明。'.repeat(600)),reply=response(ctx);
  assert(ctx.patchContract.allowedSegments[0].expectedText.length>1600);
  reply.patches[0].newText='新'.repeat(12000);assert(mergeTeachingSentencePatch(ctx,reply));
  reply.patches[0].newText+='新';assert.throws(()=>mergeTeachingSentencePatch(ctx,reply),{code:'teaching_patch_scope_exceeded'});
  assert.equal(methodContext('第一步用目标工具。'+'说明。'.repeat(2100)).patchContract,null);
  const math=methodContext('第一步用 $a。目标工具。b$ 得结论。第二步保持。');
  const bad=structuredClone(math);bad.reviewMethodScopes[0].end=[...'前问保持。第一步用 $a。目标工具。'].length;
  bad.reviewMethodScopes[0].expectedText=[...bad.candidate.teachingSolution].slice(bad.reviewMethodScopes[0].start,bad.reviewMethodScopes[0].end).join('');
  assert.equal(createTeachingSentencePatchContract(bad),null);
});

test('v2 repair must actually change the finding’s authorized segment, not another sentence in the same field',()=>{
  const ctx=context('此处缺少完整证明。目标式为2。',{type:'quality',id:'missing-proof',dimension:'proof',fieldPath:'teachingSolution',quote:'此处缺少完整证明。',reason:'模拟：第一句尚缺明确推导。'});
  ctx.reviewFindings.push({type:'term',ruleId:'simulated-word',fieldPath:'teachingSolution',term:'目标式'});ctx.patchContract=createTeachingSentencePatchContract(ctx);
  const before=structuredClone(ctx),bad=response(ctx);bad.patches=bad.patches.filter(p=>p.segmentId==='s1');bad.termResolutions[0].status='repaired';
  assert.throws(()=>mergeTeachingSentencePatch(ctx,bad),{code:'teaching_quality_unchanged'});assert.deepEqual(ctx,before);
  const noop=structuredClone(bad);noop.patches.unshift({segmentId:'s0',newText:'此处缺少完整证明。'});
  assert.throws(()=>mergeTeachingSentencePatch(ctx,noop),{code:'teaching_quality_unchanged'});
  const good=structuredClone(bad);good.patches.unshift({segmentId:'s0',newText:'模拟：由两个加数均为1，逐项相加得到2。'});
  assert.equal(mergeTeachingSentencePatch(ctx,good).teachingSolution,'模拟：由两个加数均为1，逐项相加得到2。所求式子为2。');
  const old=savedV1(structuredClone(ctx)),historical=response(old);historical.patches=historical.patches.filter(p=>p.segmentId==='s1');historical.termResolutions[0].status='repaired';
  // Preserve exact historical mechanical semantics; this does not approve its proof.
  assert.equal(mergeTeachingSentencePatch(old,historical).teachingSolution,'此处缺少完整证明。所求式子为2。');
});

test('unlocated quality repairs and a different term occurrence cannot borrow another segment’s text change',()=>{
  const ctx=context('缺少证明的陈述。目标式为2。',{type:'quality',id:'unlocated-proof',dimension:'proof',fieldPath:'teachingSolution',reason:'模拟：没有给出可靠原句定位。'});
  ctx.reviewFindings.push({type:'term',ruleId:'simulated-word',fieldPath:'teachingSolution',term:'目标式'});ctx.patchContract=createTeachingSentencePatchContract(ctx);
  const reply=response(ctx);reply.termResolutions[0].status='repaired';
  assert.throws(()=>mergeTeachingSentencePatch(ctx,reply),{code:'teaching_quality_unchanged'});
  reply.qualityResolutions[0].status='false_positive';assert(mergeTeachingSentencePatch(ctx,reply));
  const terms=context('第一目标式需核对。第二目标函数需核对。');
  terms.reviewFindings.push({type:'term',ruleId:'simulated-function',fieldPath:'teachingSolution',term:'目标函数'});terms.patchContract=createTeachingSentencePatchContract(terms);
  const unrelated=response(terms);unrelated.patches=[{segmentId:'s1',newText:'第二所求函数已给出明确计算。'}];unrelated.termResolutions.forEach(r=>{r.status='repaired';});
  assert.throws(()=>mergeTeachingSentencePatch(terms,unrelated),{code:'teaching_quality_unchanged'});
});


test('occurrence false-positive scope preserves one exact sentence through Unicode shifts, not new matches or changed wording', () => {
  const text='😀目标式先计算。关键关系共同构成结论。后句保持。';
  const scan=text=>['目标式','同构'].flatMap(term=>[...text.matchAll(new RegExp(term,'gu'))].map(m=>({type:'term',ruleId:term==='同构'?'isomorphism-language':'optimization-language',fieldPath:'teachingSolution',term,start:m.index,end:m.index+term.length})));
  const ctx=context(text);ctx.reviewFindings=scan(text);ctx.patchContract=createTeachingSentencePatchContract(ctx);
  assert.equal(ctx.patchContract.falsePositiveScopeVersion,1);
  assert(teachingReviewModelContract(ctx.patchContract).allowedSegments.every(s=>s.maxNewTextChars===1000));
  const patch=response(ctx), target=ctx.patchContract.allowedSegments.find(s=>s.expectedText==='😀目标式先计算。');
  patch.patches=[{segmentId:target.segmentId,newText:'😀😀先算出所求式子，再考虑同构方法。'}];
  patch.termResolutions[0].status='repaired';
  const next=mergeTeachingSentencePatch(ctx,patch), flags=scan(next.teachingSolution);
  const remaining=filterReviewedTermFindings(flags,ctx,patch,next);
  assert.equal(remaining.length,1);assert.equal(remaining[0].term,'同构');
  assert(remaining[0].start<next.teachingSolution.indexOf('关键关系'));

  const old=structuredClone(ctx);delete old.patchContract.falsePositiveScopeVersion;delete old.patchContract.requestId;
  old.patchContract.requestId=`r-${qualityHash(old.patchContract).slice(0,16)}`;
  const oldReply={...patch,requestId:old.patchContract.requestId};
  const oldNext=mergeTeachingSentencePatch(old,oldReply);
  assert.equal(filterReviewedTermFindings(scan(oldNext.teachingSolution),old,oldReply,oldNext).length,2);

  const fp=ctx.patchContract.allowedSegments.find(s=>s.expectedText==='关键关系共同构成结论。');
  patch.patches.push({segmentId:fp.segmentId,newText:'另一同构方法得到结论。'});
  const changed=mergeTeachingSentencePatch(ctx,patch);
  assert.equal(filterReviewedTermFindings(scan(changed.teachingSolution),ctx,patch,changed).length,2);
  const stale=structuredClone(ctx);stale.patchContract.falsePositiveScopeVersion=2;
  assert.throws(()=>mergeTeachingSentencePatch(stale,patch),{code:'invalid_teaching_patch'});
});
