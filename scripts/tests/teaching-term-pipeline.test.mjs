import test from 'node:test';
import assert from 'node:assert/strict';
import { runTeachingTermPipeline, validateTeachingResult } from '../lib/teaching-term-pipeline.mjs';

const result = (solution = '由已知条件，所求式子等于2。') => ({ questionId: 'simulated-q', answer: '2', difficultyAssessment: { level: 'easy', basis: '模拟回归：直接代入。' }, teachingSolution: solution, teachingFocusSchemaVersion: 2, teachingFocus: { examFocus: '模拟回归：代入求值。', studentRequirements: ['能代入已知数值。'] }, issues: [] });
const material = { questionId: 'simulated-q', student: { stem: '模拟题干含范数，但不属于生成字段。' }, referenceSolution: '原参考含目标式。' };

test('no lexical hit skips review without declaring mathematical correctness', async () => {
  let reviews = 0;
  const draft = result(), before = structuredClone(draft), input = structuredClone(material);
  const out = await runTeachingTermPipeline({ originalMaterial: input, generate: async () => draft, review: async () => { reviews++; } });
  assert.equal(reviews, 0); assert.equal(out.status, 'no_term_hits');
  assert.deepEqual(out.finalResult, draft); assert.deepEqual(draft, before); assert.deepEqual(input, material);
  assert.equal(Object.hasOwn(out, 'mathematicallyCorrect'), false);
});

test('all detected fields reach the single review; original input/draft remain unchanged', async () => {
  const draft = result('用目标式求下界。'); draft.teachingFocus.examFocus = '讨论范数。';
  const before = structuredClone(draft); let count = 0;
  const out = await runTeachingTermPipeline({ originalMaterial: material, generate: async () => draft, review: async payload => {
    count++; assert.deepEqual(payload.originalMaterial, material); assert.deepEqual(payload.candidateDraft, before);
    assert(payload.termFindings.some(f => f.fieldPath === 'teachingSolution'));
    assert(payload.termFindings.some(f => f.fieldPath === 'teachingFocus.examFocus'));
    payload.candidateDraft.answer = 'caller mutation'; payload.originalMaterial.questionId = 'changed';
    return result();
  } });
  assert.equal(count, 1); assert.equal(out.status, 'rewritten_no_term_hits'); assert.deepEqual(out.initialResult, before); assert.deepEqual(draft, before);
});

test('persistent or newly introduced terms remain findings without a second rewrite or replacements', async () => {
  let count = 0;
  const second = result('这里用范数。');
  const out = await runTeachingTermPipeline({ originalMaterial: material, generate: async () => result('这里是目标式。'), review: async () => { count++; return second; } });
  assert.equal(count, 1); assert.equal(out.status, 'remaining_term_hits'); assert(out.finalScan.findings.some(f => f.term === '范数'));
  assert.deepEqual(out.finalResult, second);
});

test('review identity/schema failure does not silently release initial work', async () => {
  const draft = result('目标式。');
  const out = await runTeachingTermPipeline({ originalMaterial: material, generate: async () => draft, review: async () => ({ ...result(), questionId: 'another-q' }) });
  assert.equal(out.status, 'review_failed'); assert.equal(out.finalResult, null); assert.deepEqual(out.initialResult, draft);
  assert.equal(out.error.code, 'invalid_result_identity_or_schema');
});

test('technical review failure preserves initial material and contains no arbitrary error details', async () => {
  const out = await runTeachingTermPipeline({ originalMaterial: material, generate: async () => result('范数。'), review: async () => { throw Error('sensitive fake credential'); } });
  assert.equal(out.status, 'review_failed'); assert(out.initialResult); assert(!JSON.stringify(out).includes('sensitive fake credential'));
});

test('generation failure has no fabricated result; partial results with issues stay incomplete', async () => {
  const failed = await runTeachingTermPipeline({ originalMaterial: material, generate: async () => { throw Error('failure'); }, review: async () => assert.fail() });
  assert.equal(failed.status, 'generation_failed'); assert.equal(failed.finalResult, null); assert.equal(failed.reviewCalls, 0);
  const partial = result('只能确认已知关系，材料不足。'); partial.answer = ''; partial.teachingFocus = { examFocus: '', studentRequirements: [] }; partial.issues = ['题面：缺少必要条件。'];
  const out = await runTeachingTermPipeline({ originalMaterial: material, generate: async () => partial, review: async () => assert.fail() });
  assert.equal(out.status, 'no_term_hits'); assert.equal(out.textComplete, false); assert.deepEqual(out.finalResult.issues, partial.issues);
});

test('v2 focus rejects legacy names, invalid limits and unreported incompleteness', () => {
  const legacy = result(); legacy.teachingFocus.knowledgePoints = ['旧名称']; assert.throws(() => validateTeachingResult(legacy, 'simulated-q'));
  const long = result(); long.teachingFocus.examFocus = '字'.repeat(601); assert.throws(() => validateTeachingResult(long, 'simulated-q'));
  const partial = result(); partial.answer = ''; assert.throws(() => validateTeachingResult(partial, 'simulated-q'));
});
