import test from 'node:test';
import assert from 'node:assert/strict';
import { compactTeachingReviewContext } from '../lib/teaching-review-context.mjs';
import { teachingMethodScopePreferences } from '../lib/teaching-review-context.mjs';
import { createTeachingSentencePatchContract } from '../lib/teaching-sentence-patch.mjs';

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

test('compact v2 transport carries text and short aliases while local hash binding stays untouched',()=>{
  const candidate={questionId:'sim-compact',answer:'2',difficultyAssessment:{level:'medium',basis:'模拟：依据明确结构判断难度。'},teachingSolution:'故 $\\lim_{x\\to0}h(x)=1$。',teachingFocusSchemaVersion:2,teachingFocus:{examFocus:'模拟核对具体证明。',studentRequirements:['能写出具体不等式。']},issues:[]};
  const original={originalMaterial:{questionId:candidate.questionId,stem:'原题中的 hash 文字完整保留。',sourceIdentity:{sourceSha256:'a'.repeat(64)}},candidate,rawCandidate:structuredClone(candidate),reviewFindings:[{type:'term',ruleId:'limit-notation',category:'context',fieldPath:'teachingSolution',term:'\\lim',start:3,end:7}]};
  original.patchContract=createTeachingSentencePatchContract(original);const before=structuredClone(original);const sent=compactTeachingReviewContext(original);
  assert.equal(sent.originalMaterial.stem,original.originalMaterial.stem);assert.equal(sent.candidate.teachingSolution,candidate.teachingSolution);
  assert.equal(sent.patchContract.termFindings[0].findingId,'t0');assert.equal(sent.patchContract.candidateSha256,undefined);assert.equal(sent.patchContract.allowedSegments[0].expectedTextSha256,undefined);assert.equal(sent.rawCandidate,undefined);
  assert.ok(original.patchContract.candidateSha256);assert.deepEqual(original,before);
});

test('only reliably numbered method subquestions receive wider scope; expressions and ambiguous numbering do not',()=>{
  const text='（1）模拟前问。\n（2）故 $\\lim_{x\\to0}h(x)=1$。\n（3）模拟末问。';const at=text.indexOf('\\lim');
  const context={candidate:{teachingSolution:text},originalMaterial:{parts:[{label:'（1）'},{label:'（2）'},{label:'（3）'}]},reviewFindings:[{type:'term',ruleId:'limit-notation',fieldPath:'teachingSolution',term:'\\lim',start:at,end:at+4}]};
  const preference=teachingMethodScopePreferences(context);assert.equal(preference.reviewMethodScopes.length,1);assert.equal(preference.reviewMethodScopes[0].expectedText,'（2）故 $\\lim_{x\\to0}h(x)=1$。\n');
  assert.deepEqual(teachingMethodScopePreferences({...context,originalMaterial:{parts:[{},{}]}}),{});
  assert.deepEqual(teachingMethodScopePreferences({...context,reviewFindings:[{...context.reviewFindings[0],ruleId:'optimization-language'}]}),{});
  for(const labels of [['（Ⅰ）','（Ⅱ）','（Ⅲ）'],['（2）','（3）','（4）'],['（1）','（1）','（3）'],['第一问','第二问','第三问'],['（01）','（2）','（3）'],['','（2）','（3）']]){
    assert.deepEqual(teachingMethodScopePreferences({...context,originalMaterial:{parts:labels.map(label=>({label}))}}),{},labels.join(','));
  }
  for(const parts of [{},'three-parts',3])assert.deepEqual(teachingMethodScopePreferences({...context,originalMaterial:{parts}}),{});
  for(const labels of [['1','2','3'],['(1)','(2)','(3)'],['1.','2.','3.'],['1．','2．','3．'],['1、','2、','3、']]){
    assert.equal(teachingMethodScopePreferences({...context,originalMaterial:{parts:labels.map(label=>({label}))}}).reviewMethodScopes[0].expectedText,'（2）故 $\\lim_{x\\to0}h(x)=1$。\n');
  }
});
