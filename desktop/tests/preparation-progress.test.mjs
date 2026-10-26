import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreparationPresenter, minimumStepDuration } from '../src/preparation-progress.ts';

function setup(mode = 'llm') {
  let now = 0, id = 0;
  const timers = new Map();
  const snapshots = [];
  const clock = { now: () => now, schedule: (callback, delay) => { timers.set(++id, { at: now + delay, callback }); return id; }, clear: id => timers.delete(id) };
  const presenter = createPreparationPresenter('current', mode, steps => snapshots.push(structuredClone(steps)), clock);
  const event = (step, status = 'completed', runId = 'current') => presenter.receive({ runId, step, status });
  const advance = amount => {
    const target = now + amount;
    while (true) {
      const next = [...timers].sort((a,b) => a[1].at-b[1].at)[0];
      if (!next || next[1].at > target) break;
      now = next[1].at; timers.delete(next[0]); next[1].callback();
    }
    now = target;
  };
  return { presenter, event, advance, snapshots, timers, active: () => snapshots.at(-1).find(step => step.active)?.id };
}

test('模拟回归：快速真实步骤依次停留，全部展示后才完成跳转条件', async () => {
  const h = setup();
  h.event('scope'); h.event('supply'); h.event('requirements');
  let finished = false;
  const result = h.presenter.finish(['scope','supply','requirements']).then(value => { finished = value; });
  assert.equal(h.active(), 'scope');
  h.advance(minimumStepDuration - 1); assert.equal(h.active(), 'scope');
  h.advance(1); assert.equal(h.active(), 'supply');
  h.advance(minimumStepDuration); assert.equal(h.active(), 'requirements');
  assert.equal(finished, false);
  h.advance(minimumStepDuration); await result; assert.equal(finished, true);
});

test('模拟回归：慢步骤完成后不重复等待，过期事件及取消不能触发晚跳转', async () => {
  const h = setup('rule');
  h.event('requirements', 'running'); h.advance(2000);
  h.event('requirements', 'completed', 'stale');
  assert.equal(h.snapshots.at(-1)[0].status, 'running');
  h.event('requirements');
  assert.equal(await h.presenter.finish(['requirements']), true);
  const cancelled = setup();
  cancelled.event('scope');
  const result = cancelled.presenter.finish(['scope','supply','requirements']);
  cancelled.presenter.dispose(); cancelled.advance(10000);
  assert.equal(await result, false);
  assert.equal(cancelled.timers.size, 0);
});

test('模拟回归：仅计时不会伪造后续执行，成功响应可补齐实际完成事件', async () => {
  const h = setup(); h.event('scope'); h.advance(5000);
  assert.equal(h.active(), 'scope');
  assert.deepEqual(h.snapshots.at(-1).slice(1).map(step => step.status), ['pending', 'pending']);
  const result = h.presenter.finish(['scope','supply','requirements']);
  assert.equal(h.active(), 'supply');
  h.advance(2 * minimumStepDuration);
  assert.equal(await result, true);
});
