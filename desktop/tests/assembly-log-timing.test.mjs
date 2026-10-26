import test from 'node:test';
import assert from 'node:assert/strict';
import { assemblyLogTimings } from '../src/shared/assembly-log-timing.mjs';

const event = (sequence, category, phase, status, ms, extra = {}) => ({ sequence, category, phase, status, at: new Date(1700000000000 + ms).toISOString(), action: 'blueprint_plan', ...extra });

test('模拟耗时：优先使用单调实测，阶段与模型重叠时分别展示且原文不变', () => {
  const input = [
    event(1, 'request', 'request', 'running', 0, { requestId: 'r1' }),
    event(2, 'stage', 'plan_slots', 'running', 100, { requestId: 'r1' }),
    event(3, 'model', 'call', 'running', 200, { requestId: 'r1', details: { task: 'blueprint' } }),
    event(4, 'model', 'call', 'completed', 900, { requestId: 'r1', elapsedMs: 693, durationSource: 'monotonic', details: { task: 'blueprint' } }),
    event(5, 'stage', 'plan_slots', 'completed', 1000, { requestId: 'r1', elapsedMs: 887, durationSource: 'monotonic' }),
    event(6, 'request', 'request', 'completed', 1100, { requestId: 'r1', elapsedMs: 1088, durationSource: 'monotonic' }),
  ];
  const before = structuredClone(input);
  const result = assemblyLogTimings(input);
  assert.deepEqual(result.rows.map(row => row.elapsedMs), [1088, 887, 693]);
  assert.ok(result.rows.every(row => row.durationSource === 'monotonic'));
  assert.equal(result.eventDurations.get(5).elapsedMs, 887);
  assert.deepEqual(input, before);
});

test('模拟旧日志：按请求边界推算阶段，失败末段标失败且明确由时间戳推算', () => {
  const result = assemblyLogTimings([
    event(1, 'request', 'request', 'running', 0),
    event(2, 'stage', 'plan_supply', 'running', 20),
    event(3, 'stage', 'plan_supply', 'completed', 141),
    event(4, 'stage', 'plan_check', 'running', 43400),
    event(5, 'request', 'request', 'failed', 43459, { elapsedMs: 43459 }),
  ]);
  assert.equal(result.rows[1].elapsedMs, 121);
  assert.equal(result.rows[1].durationSource, 'timestamps');
  assert.equal(result.rows[2].elapsedMs, 59);
  assert.equal(result.rows[2].status, 'failed');
  assert.equal(result.rows[2].durationSource, 'timestamps');
  assert.equal(result.rows[2].inferredEnd, true);
  assert.equal(result.rows[0].durationSource, 'recorded');
});

test('模拟并发：同流程同动作的独立requestId不串阶段，取消不伪装完成', () => {
  const result = assemblyLogTimings([
    event(1, 'request', 'request', 'running', 0, { requestId: 'a' }),
    event(2, 'stage', 'scope', 'running', 10, { requestId: 'a' }),
    event(3, 'request', 'request', 'running', 20, { requestId: 'b' }),
    event(4, 'stage', 'scope', 'running', 30, { requestId: 'b' }),
    event(5, 'stage', 'scope', 'completed', 60, { requestId: 'b', elapsedMs: 30, durationSource: 'monotonic' }),
    event(6, 'request', 'request', 'completed', 70, { requestId: 'b', elapsedMs: 50 }),
    event(7, 'stage', 'scope', 'cancelled', 90, { requestId: 'a', elapsedMs: 80, durationSource: 'monotonic' }),
    event(8, 'request', 'request', 'cancelled', 100, { requestId: 'a', elapsedMs: 100 }),
  ]);
  const stages = result.rows.filter(row => row.category === 'stage');
  assert.deepEqual(stages.map(row => [row.requestId, row.status, row.elapsedMs]), [['a', 'cancelled', 80], ['b', 'completed', 30]]);
});

test('模拟旧日志：缺起点、无效时间、倒退时钟、并发配对歧义保持未知', () => {
  for (const input of [
    [event(1, 'stage', 'scope', 'completed', 30)],
    [event(1, 'request', 'request', 'running', 0), event(2, 'stage', 'scope', 'running', 20, { at: 'invalid' }), event(3, 'stage', 'scope', 'completed', 30)],
    [event(1, 'request', 'request', 'running', 0), event(2, 'stage', 'scope', 'running', 40), event(3, 'stage', 'scope', 'completed', 30)],
    [event(1, 'request', 'request', 'running', 0), event(2, 'request', 'request', 'running', 10), event(3, 'stage', 'scope', 'running', 20), event(4, 'stage', 'scope', 'completed', 30)],
  ]) {
    const rows = assemblyLogTimings(input).rows.filter(row => row.category === 'stage');
    assert.ok(rows.every(row => row.elapsedMs === null && row.durationSource === 'unknown'));
  }
  const successful = assemblyLogTimings([event(1, 'request', 'request', 'running', 0), event(2, 'stage', 'scope', 'running', 5), event(3, 'request', 'request', 'completed', 10)]);
  assert.equal(successful.rows[1].status, 'unfinished');
  assert.equal(successful.rows[1].elapsedMs, null);
});
