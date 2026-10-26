import test from 'node:test';
import assert from 'node:assert/strict';
import { assemblyLogCalls } from '../src/shared/assembly-log-calls.mjs';

const event = (sequence, phase, status, details = {}, requestId = 'r1') => ({ sequence, requestId, category: 'model', action: 'draft_create', phase, status, details, at: new Date(1700000000000 + sequence * 100).toISOString() });

test('模拟逐次调用：多轮请求独立显示真实候选、图片请求字节、用量和失败耗时', () => {
  const input = [
    event(1, 'call', 'running', { task: 'selection' }),
    event(2, 'request_summary', 'recorded', { task: 'selection', batchIndex: 1, batchCount: 2, roundIndex: 1, candidateCount: 12, requestBytes: 120000 }),
    event(3, 'response', 'received', { task: 'selection', promptTokens: 1500, completionTokens: 280, reasoningTokens: 90 }),
    { ...event(4, 'call', 'completed', { task: 'selection' }), elapsedMs: 4300, durationSource: 'monotonic' },
    event(5, 'call', 'running', { task: 'selection' }),
    event(6, 'request_summary', 'recorded', { task: 'selection', batchIndex: 1, batchCount: 2, roundIndex: 2, candidateCount: 7, requestBytes: 45000 }),
    { ...event(7, 'call', 'failed', { task: 'selection', errorCode: 'model_response_read' }), elapsedMs: 90000, durationSource: 'monotonic' },
  ];
  const before = structuredClone(input);
  const rows = assemblyLogCalls(input);
  assert.deepEqual(rows.map(row => [row.sequence, row.metrics.candidateCount, row.metrics.requestBytes, row.metrics.roundIndex, row.elapsedMs, row.status]), [[1, 12, 120000, 1, 4300, 'completed'], [5, 7, 45000, 2, 90000, 'failed']]);
  assert.equal(rows[0].metrics.promptTokens, 1500);
  assert.equal(rows[1].metrics.promptTokens, undefined);
  assert.equal(rows[1].metrics.errorCode, 'model_response_read');
  assert.deepEqual(input, before);
});

test('模拟逐次调用：并发请求按身份隔离，运行中也显示已知指标', () => {
  const rows = assemblyLogCalls([
    event(1, 'call', 'running', { task: 'selection' }, 'a'),
    event(2, 'call', 'running', { task: 'selection' }, 'b'),
    event(3, 'request_summary', 'recorded', { task: 'selection', candidateCount: 3 }, 'b'),
    event(4, 'request_summary', 'recorded', { task: 'selection', candidateCount: 7 }, 'a'),
    { ...event(5, 'call', 'completed', { task: 'selection' }, 'b'), elapsedMs: 200 },
  ]);
  assert.deepEqual(rows.map(row => [row.requestId, row.metrics.candidateCount, row.status]), [['a', 7, 'running'], ['b', 3, 'completed']]);
});

test('模拟旧日志与保留截断：不把相邻请求指标或未配对正文统计冒充本次调用', () => {
  const rows = assemblyLogCalls([
    event(1, 'request_summary', 'recorded', { task: 'selection', candidateCount: 999 }),
    event(2, 'call', 'completed', { task: 'selection' }),
    event(3, 'call', 'running', { task: 'selection' }, null),
    event(4, 'request_summary', 'recorded', { task: 'selection', candidateCount: 777 }, null),
    event(5, 'call', 'completed', { task: 'selection' }, null),
  ]);
  assert.ok(rows.every(row => row.metrics.candidateCount === undefined));
  assert.ok(rows.every(row => row.elapsedMs === null));
});

test('模拟传输耗时：响应头和正文分别记录，不累加到调用总耗时', () => {
  const rows = assemblyLogCalls([
    event(1, 'call', 'running', { task: 'selection' }),
    { ...event(2, 'response_headers', 'completed', { task: 'selection', httpStatus: 200 }), elapsedMs: 12000 },
    { ...event(3, 'response_body', 'timeout', { task: 'selection', httpStatus: 200 }), elapsedMs: 78000 },
    { ...event(4, 'call', 'failed', { task: 'selection', errorCode: 'model_response_timeout' }), elapsedMs: 90040 },
  ]);
  assert.equal(rows[0].elapsedMs, 90040);
  assert.equal(rows[0].metrics.responseHeadersMs, 12000);
  assert.equal(rows[0].metrics.responseBodyMs, 78000);
  assert.equal(rows[0].metrics.responseBodyMsStatus, 'timeout');
  assert.equal(rows[0].metrics.errorCode, 'model_response_timeout');
});

test('模拟窗口校验：调用结束后只按同请求和唯一批次轮次补充计数', () => {
  const call = (start, requestId, batchIndex, roundIndex) => [
    event(start, 'call', 'running', { task: 'selection' }, requestId),
    event(start + 1, 'request_summary', 'recorded', { task: 'selection', batchIndex, roundIndex, candidateCount: 6 }, requestId),
    event(start + 2, 'call', 'completed', { task: 'selection' }, requestId),
  ];
  const rows = assemblyLogCalls([
    ...call(1, 'a', 1, 1),
    ...call(4, 'a', 2, 1),
    event(7, 'candidate_window', 'recorded', { task: 'selection', batchIndex: 1, roundIndex: 1, assessedCount: 5, poolCount: 19, searchIncomplete: true }, 'a'),
    event(8, 'candidate_window', 'recorded', { task: 'selection', batchIndex: 2, roundIndex: 1, assessedCount: 999 }, 'b'),
    event(9, 'candidate_window', 'recorded', { task: 'selection', assessedCount: 888 }, 'a'),
    ...call(10, 'a', 2, 1),
    event(13, 'candidate_window', 'recorded', { task: 'selection', batchIndex: 2, roundIndex: 1, assessedCount: 777 }, 'a'),
  ]);
  assert.equal(rows[0].metrics.assessedCount, 5);
  assert.equal(rows[0].metrics.poolCount, 19);
  assert.equal(rows[0].metrics.searchIncomplete, true);
  assert.equal(rows[1].metrics.assessedCount, undefined);
  assert.equal(rows[2].metrics.assessedCount, undefined);
});
