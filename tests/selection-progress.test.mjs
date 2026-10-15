import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelectionProgress } from '../web/selection-progress.js';

test('burst progress visibly holds combination and saving before entering the draft', async () => {
  let time = 0;
  const events = [];
  const progress = createSelectionProgress({ signal: new AbortController().signal,
    now: () => time, wait: async ms => { time += ms; },
    onProgress: event => events.push([event.stage, time]) });
  progress.push({ stage: 'comparing' });
  progress.push({ stage: 'combining' });
  progress.push({ stage: 'saving' });
  await progress.finish();
  assert.deepEqual(events.filter(([stage]) => stage === 'combining'), [['combining', 0]]);
  assert.equal(events.find(([stage]) => stage === 'saving')[1], 500);
  assert.equal(time, 1000);
  progress.dispose();
});

test('already slow stages add no further wait and late batch messages do not regress progress', async () => {
  let time = 0;
  const stages = [];
  const waits = [];
  const progress = createSelectionProgress({ signal: new AbortController().signal, now: () => time,
    wait: async ms => { waits.push(ms); time += ms; }, onProgress: event => stages.push(event.stage) });
  await progress.show({ stage: 'combining' });
  time = 800;
  await progress.show({ stage: 'saving' });
  progress.push({ stage: 'comparing', completedBatches: 1 });
  time = 1400;
  await progress.finish();
  assert.deepEqual(waits, []);
  assert.ok(!stages.includes('comparing'));
  progress.dispose();
});

test('a response without progress still presents combination then saving; stop cancels the delay', async () => {
  const controller = new AbortController();
  const stages = [];
  const progress = createSelectionProgress({ signal: controller.signal, onProgress: event => stages.push(event.stage) });
  const finished = progress.finish();
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(finished, { name: 'AbortError' });
  assert.deepEqual(stages, ['combining']);
  progress.dispose();
});
