import test from 'node:test';
import assert from 'node:assert/strict';
import { quantityDirective } from '../src/intake/quantity-authority.mjs';
import { previewBlueprint } from '../src/assembly/engine.mjs';
import { proposeAssemblyAdjustment } from '../src/assembly/assistant.mjs';

test('quantity authority recognizes explicit absolute totals and the last teacher revision', () => {
  for (const message of ['12道题目', '12题', '十二题', '请安排１２道试题', '出12道', '出十二道，基础题即可', '12道练习题']) assert.deepEqual(quantityDirective(message), { allowsChange: true, exactTotal: 12 }, message);
  assert.deepEqual(quantityDirective('12题\n补充需求：改成14题'), { allowsChange: true, exactTotal: 14 });
  assert.deepEqual(quantityDirective('12题，其中3题检查概念'), { allowsChange: true, exactTotal: 12 });
  assert.deepEqual(quantityDirective('12题其中3题填空'), { allowsChange: true, exactTotal: 12 });
  assert.deepEqual(quantityDirective('12题，6道单选、4道填空、2道解答'), { allowsChange: true, exactTotal: 12 });
  assert.deepEqual(quantityDirective('改成6道单选；总共12题，4道填空、2道解答'), { allowsChange: true, exactTotal: 12 });
  assert.deepEqual(quantityDirective('12题，只出6道单选和6道填空'), { allowsChange: true, exactTotal: 12 });
  assert.deepEqual(quantityDirective('12题\n补充需求：改成4道单选、2道填空，不要解答题'), { allowsChange: true, exactTotal: null });
  for (const message of ['4道单选', '4道单选题，40分20分钟', '出4道单选，少复杂运算', '3道填空']) assert.deepEqual(quantityDirective(message), { allowsChange: true, exactTotal: message.startsWith('3') ? 3 : 4 }, message);
  assert.deepEqual(quantityDirective('12题，其中3道填空'), { allowsChange: true, exactTotal: 12 });
  assert.deepEqual(quantityDirective('12题，出3道填空'), { allowsChange: true, exactTotal: 12 });
  assert.deepEqual(quantityDirective('改成6道填空'), { allowsChange: true, exactTotal: 6 });
  assert.deepEqual(quantityDirective('先安排12题；再增加2道填空'), { allowsChange: true, exactTotal: null });
});

test('ordinals, time, source numbers, replacement and partial constraints do not authorize changing total', () => {
  for (const message of ['', '围绕集合的概念复习', '换第12题', '第5题换一道题', '将第十二题换成基础题', '第1到12题换题', '做12分钟', '来源2025年试卷第12题', '其中3道填空', '不要解答题', '题型安排优化一下', '例如：12题']) {
    assert.deepEqual(quantityDirective(message), { allowsChange: false, exactTotal: null }, message);
  }
});

test('explicit additions, deletions and complete type directions authorize a pending count change without guessed totals', () => {
  for (const message of ['增加2道填空', '删除第2题', '删除第十题', '删除第1到3题', '去掉最后一道题', '新增2道判断集合的单选题', '改成4道单选、2道填空，不要解答题']) {
    assert.deepEqual(quantityDirective(message), { allowsChange: true, exactTotal: null }, message);
  }
});

const ready = actions => ({ status: 'ready', summary: '建议调整，待教师确认。', clarification: null, actions });
const fixture = actions => ({ async propose(context, { validate }) { return { ok: true, proposal: validate(ready(actions)) }; } });

test('assistant cannot reduce blueprint total for an unrelated task or type request', async () => {
  const blueprint = (await previewBlueprint({ counts: { single_choice: 2, fill_blank: 0, free_response: 0 }, targetScore: 20 })).blueprint;
  const before = structuredClone(blueprint);
  for (const [message, actions] of [
    ['优化题型安排', [{ type: 'set_counts', counts: { single_choice: 1, fill_blank: 0, free_response: 0 } }]],
    ['换第2题', [{ type: 'delete', numbers: [2] }]],
    ['优化考查任务', [{ type: 'add', taskId: 'set_determinacy', count: 1, afterNumber: null }]],
  ]) {
    const result = await proposeAssemblyAdjustment({ stage: 'blueprint', message, blueprint }, { gateway: fixture(actions) });
    assert.equal(result.ok, false, message);
    assert.equal(result.error.code, 'invalid_model_output');
    assert.match(result.error.message, /没有明确修改题量/);
  }
  assert.deepEqual(blueprint, before);
});

test('assistant preserves requested absolute total and accepts explicit deletion without guessing a total', async () => {
  const blueprint = (await previewBlueprint({ counts: { single_choice: 2, fill_blank: 0, free_response: 0 }, targetScore: 20 })).blueprint;
  const action = [{ type: 'set_counts', counts: { single_choice: 1, fill_blank: 0, free_response: 0 } }];
  const wrong = await proposeAssemblyAdjustment({ stage: 'blueprint', message: '改成3题', blueprint }, { gateway: fixture(action) });
  assert.equal(wrong.ok, false);
  assert.match(wrong.error.message, /教师要求 3 题，提案为 1 题/);
  const removed = await proposeAssemblyAdjustment({ stage: 'blueprint', message: '删除第2题', blueprint }, { gateway: fixture([{ type: 'delete', numbers: [2] }]) });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  const correct = await proposeAssemblyAdjustment({ stage: 'blueprint', message: '改成1题', blueprint }, { gateway: fixture(action) });
  assert.equal(correct.ok, true, JSON.stringify(correct));
});
