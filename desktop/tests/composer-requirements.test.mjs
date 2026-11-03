import test from 'node:test';
import assert from 'node:assert/strict';
import { composerRequirements, composerSubmitState } from '../src/composer-requirements.ts';

test('模拟入口：缺模型可先配置，已配但空要求说明禁用原因，忙时不重复提交', () => {
  const missing = composerSubmitState(false, false, false);
  assert.equal(missing.disabled, false);
  assert.equal(missing.label, '配置模型后开始');
  assert.match(missing.hint, /先配置/);
  const empty = composerSubmitState(true, false, false);
  assert.equal(empty.disabled, true);
  assert.match(empty.hint, /请输入组卷要求/);
  assert.equal(composerSubmitState(true, false, true).disabled, false);
  assert.equal(composerSubmitState(true, false, true).hint, '');
  for (const configured of [true, false]) assert.equal(composerSubmitState(configured, true, true).disabled, true);
});

test('模拟回归：新范围不继承模板教学说明，返回同一范围保留已确认目标', () => {
  const defaults = { title: '模板名称', goal: '集合模板目标', teachingGoals: [{ id: 'template' }], counts: { single_choice: 6, fill_blank: 2, free_response: 2 } };
  const initial = { title: '教师命名', mainScope: ['1.1'], goal: '教师本次目标', teachingGoals: [{ id: 'current' }], typeConstraints: { excludedTypes: ['free_response'] } };
  const snapshot = structuredClone({ defaults, initial });
  const fresh = composerRequirements(defaults, undefined, ['2.1']);
  assert.equal(fresh.goal, '');
  assert.deepEqual(fresh.teachingGoals, []);
  assert.equal(fresh.title, undefined);
  assert.deepEqual(fresh.counts, defaults.counts);
  const changed = composerRequirements(defaults, initial, ['2.1']);
  assert.equal(changed.goal, '');
  assert.deepEqual(changed.teachingGoals, []);
  assert.equal(changed.title, '教师命名');
  assert.deepEqual(changed.typeConstraints, initial.typeConstraints);
  const unchanged = composerRequirements(defaults, initial, ['rja-compulsory-1:1.1']);
  assert.equal(unchanged.goal, initial.goal);
  assert.deepEqual(unchanged.teachingGoals, initial.teachingGoals);
  assert.deepEqual({ defaults, initial }, snapshot);
});

test('模拟回归：模板配比不是手动确认，修改原话作为新需求而重新整理保留已确认设置', () => {
  const initial = { mainScope: ['2.1'], teacherRequest: '只要选择和填空题', quantityAuthority: { questionCount: true, counts: true, typeConstraints: true }, quantityPlan: { source: 'model_suggestion', rationale: '先辨析再独立计算', counts: { single_choice: 6, multiple_choice: 0, fill_blank: 4, free_response: 0 } } };
  assert.deepEqual(composerRequirements({}, undefined, ['2.1']).quantityAuthority, {});
  assert.deepEqual(composerRequirements({}, initial, ['2.1']).quantityAuthority, initial.quantityAuthority);
  assert.deepEqual(composerRequirements({}, initial, ['2.1'], '改成八道解答题').quantityAuthority, {});
  assert.deepEqual(composerRequirements({}, initial, ['2.1']).quantityPlan, initial.quantityPlan);
  assert.equal(composerRequirements({}, initial, ['2.1'], '改成八道解答题').quantityPlan, undefined);
  assert.equal(composerRequirements({}, initial, ['2.2']).quantityPlan, undefined);
  assert.deepEqual(initial.quantityAuthority, { questionCount: true, counts: true, typeConstraints: true });
});

test('模拟回归：新组卷不继承未经标定的0.70，教师原话与已有显式旧目标保持原样', () => {
  const defaults = { targetDifficulty: 0.7, targetDifficultyLevel: null };
  const fresh = composerRequirements(defaults, undefined, ['2.2'], '希望学生得分率约70%');
  assert.equal(fresh.targetDifficulty, null);
  assert.equal(fresh.targetDifficultyLevel, null);
  const existing = { mainScope: ['2.2'], teacherRequest: '教师原话', targetDifficulty: 0.7 };
  assert.equal(composerRequirements(defaults, existing, ['2.2']).targetDifficulty, 0.7);
  assert.equal(existing.targetDifficulty, 0.7);
  assert.equal(defaults.targetDifficulty, 0.7);
});

test('模拟回归：新组卷不携带隐藏模板来源限制，已确认来源保持原样', () => {
  const defaults = { sourceIds: ['old-template-source'] };
  assert.equal(composerRequirements(defaults, undefined, ['2.2']).sourceIds, undefined);
  const confirmed = { mainScope: ['2.2'], sourceIds: ['teacher-confirmed-source'] };
  assert.deepEqual(composerRequirements(defaults, confirmed, ['2.2']).sourceIds, confirmed.sourceIds);
  assert.deepEqual(defaults.sourceIds, ['old-template-source']);
});
