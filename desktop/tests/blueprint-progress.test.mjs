import test from 'node:test';
import assert from 'node:assert/strict';
import { blueprintStepIds, createBlueprintPresenter } from '../src/blueprint-progress.ts';
import { minimumStepDuration } from '../src/workflow-progress.ts';

function setup(runId = 'simulated-plan') {
  let now = 0, id = 0;
  const timers = new Map();
  const snapshots = [];
  const presenter = createBlueprintPresenter(runId, steps => snapshots.push(structuredClone(steps)), {
    now: () => now,
    schedule: (callback, delay) => { timers.set(++id, { at: now + delay, callback }); return id; },
    clear: id => timers.delete(id),
  });
  const advance = amount => {
    const target = now + amount;
    while (true) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      now = next[1].at; timers.delete(next[0]); next[1].callback();
    }
    now = target;
  };
  return { presenter, snapshots, timers, advance, event: (step, status = 'completed', id = runId) => presenter.receive({ runId: id, step, status }), active: () => snapshots.at(-1).find(step => step.active)?.id };
}

test('模拟规划回归：实际阶段快速返回也逐步展示后才允许进入确认', async () => {
  const h = setup();
  let completed = false;
  const finished = h.presenter.finish([...blueprintStepIds]).then(result => { completed = result; });
  for (const step of blueprintStepIds) {
    assert.equal(h.active(), step);
    h.advance(minimumStepDuration - 1);
    assert.equal(completed, false);
    assert.equal(h.active(), step);
    h.advance(1);
  }
  await finished;
  assert.equal(completed, true);
  assert.equal(h.timers.size, 0);
});

test('模拟规划回归：无事件不伪造进度，跨请求及需求整理事件不影响当前规划', () => {
  const h = setup();
  h.event('plan_supply', 'running');
  h.advance(10000);
  h.event('plan_slots', 'completed', 'simulated-old-plan');
  h.event('scope');
  assert.equal(h.active(), 'plan_supply');
  assert.deepEqual(h.snapshots.at(-1).map(step => step.status), ['running', 'pending', 'pending']);
  h.presenter.dispose();
});

test('模拟规划回归：停止清理延迟，晚到响应不跳转，重试使用新请求独立推进', async () => {
  const old = setup();
  old.event('plan_supply');
  const cancelled = old.presenter.finish([...blueprintStepIds]);
  old.presenter.dispose();
  old.advance(10000);
  assert.equal(await cancelled, false);
  assert.equal(old.timers.size, 0);
  const retry = setup('simulated-retry');
  for (const step of blueprintStepIds) retry.event(step, 'completed', 'simulated-plan');
  assert.equal(retry.active(), undefined);
  const finished = retry.presenter.finish([...blueprintStepIds]);
  retry.advance(3 * minimumStepDuration);
  assert.equal(await finished, true);
});

test('模拟目录缺项：未执行模型规划时只呈现真实读取和校验，不等待或伪造模型阶段', async () => {
  const h = setup();
  h.event('plan_supply'); h.event('plan_check');
  const finished = h.presenter.finish(['plan_supply', 'plan_check']);
  assert.deepEqual(h.snapshots.at(-1).map(step => step.id), ['plan_supply', 'plan_check']);
  h.advance(2 * minimumStepDuration);
  assert.equal(await finished, true);
  assert.equal(h.snapshots.some(steps => steps.some(step => step.id === 'plan_slots' && step.status !== 'pending')), false);
  assert.equal(h.timers.size, 0);
});
