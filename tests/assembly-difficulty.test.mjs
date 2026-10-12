import test from 'node:test';
import assert from 'node:assert/strict';
import { difficultyView, difficultyDistribution } from '../src/assembly/difficulty.mjs';

test('planning preserves model difficulty bands with evidence and keeps numerical difficulty unknown', () => {
  const view = difficultyView({ difficultyLevel: 'hard', difficultyEstimate: null,
    difficultyBasis: { method: 'llm_estimate', empirical: false, rationale: '需协调参数退化与空/非空分支。', llmRun: { secret: 'not_part_of_planning' } } });
  assert.deepEqual(view, { level: 'hard', method: 'llm_estimate', empirical: false, rationale: '需协调参数退化与空/非空分支。' });
  assert.equal(Object.hasOwn(view, 'difficultyEstimate'), false);
  assert.equal(Object.hasOwn(view, 'llmRun'), false);
  assert.deepEqual(difficultyDistribution([{ difficulty: view }, { difficulty: difficultyView() }]),
    { easy: 0, medium: 0, hard: 1, unknown: 1 });
});

test('missing basis or empirical measurements cannot be relabelled as model bands', () => {
  for (const annotation of [undefined, { difficultyLevel: 'easy' },
    { difficultyLevel: 'hard', difficultyBasis: { method: 'llm_estimate', empirical: false, rationale: '' } },
    { difficultyLevel: 'medium', difficultyBasis: { method: 'empirical', empirical: true, rationale: '历史正确率' } }]) {
    assert.deepEqual(difficultyView(annotation), { level: 'unknown', method: 'unknown', empirical: false });
  }
});
