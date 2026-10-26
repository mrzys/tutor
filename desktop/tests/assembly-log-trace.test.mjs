import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssemblyTraceTracker } from '../src/shared/assembly-log-trace.mjs';

function setup() {
  let sequence = 0;
  return createAssemblyTraceTracker(() => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`);
}

test('模拟日志关联：同次组卷串联各请求，新流程不改已发请求身份或业务数据', () => {
  const tracker = setup();
  const original = { requirements: { goal: '模拟正文' }, runId: 'simulated-run' };
  const before = structuredClone(original);
  const first = tracker.payload('intake_prepare', original);
  assert.equal(tracker.payload('blueprint_plan', {}).assemblyTraceId, first.assemblyTraceId);
  assert.equal(tracker.payload('paper_confirm', {}).assemblyTraceId, first.assemblyTraceId);
  const next = tracker.begin();
  assert.notEqual(next, first.assemblyTraceId);
  assert.equal(tracker.payload('pdf_export', {}).assemblyTraceId, next);
  assert.deepEqual(original, before);
  assert.equal(first.requirements, original.requirements);
  assert.equal(first.runId, 'simulated-run');
});

test('模拟日志关联：手动组卷按幂等操作关联，重试不会混入其它流程', () => {
  const tracker = setup();
  const operationId = '10000000-0000-4000-8000-000000000001';
  const first = tracker.payload('manual_draft_create', { operationId });
  tracker.begin();
  assert.equal(tracker.payload('manual_draft_create', { operationId }).assemblyTraceId, first.assemblyTraceId);
  assert.equal(tracker.payload('draft_operation', {}).assemblyTraceId, first.assemblyTraceId);
  assert.notEqual(tracker.payload('manual_draft_create', { operationId: '10000000-0000-4000-8000-000000000002' }).assemblyTraceId, first.assemblyTraceId);
});

test('模拟日志关联：诊断读取、学生和配置请求不添加组卷身份，订阅关闭后不再更新', () => {
  const tracker = setup();
  const input = { studentId: 'simulated-person', query: '模拟正文' };
  for (const action of ['developer_assembly_logs', 'developer_assembly_log_detail', 'developer_assembly_event', 'students_get', 'model_save', 'paper_get']) {
    assert.equal(tracker.payload(action, input), input);
  }
  const updates = [];
  const unsubscribe = tracker.subscribe(id => updates.push(id));
  tracker.begin();
  unsubscribe();
  tracker.begin();
  assert.equal(updates.length, 1);
});
