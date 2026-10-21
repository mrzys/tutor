import test from 'node:test';
import assert from 'node:assert/strict';
import { composerRequirements } from '../src/composer-requirements.ts';

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
