import test from 'node:test';
import assert from 'node:assert/strict';
import { streamApi } from '../web/api.js';

test('progress client decodes split UTF-8 frames, forwards cancellation, ignores heartbeat and returns the final result', async t => {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(JSON.stringify({ type: 'progress', progress: { stage: 'comparing', label: '单选' } }) + '\n'
    + '{"type":"heartbeat"}\n' + JSON.stringify({ type: 'result', status: 201, result: { ok: true, draft: { title: '试卷' } } }));
  const controller = new AbortController(); let captured;
  t.mock.method(globalThis, 'fetch', async (url, input) => {
    captured = input;
    return new Response(new ReadableStream({ start(stream) {
      for (let i = 0; i < bytes.length; i += 5) stream.enqueue(bytes.slice(i, i + 5)); stream.close();
    } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
  });
  const progress = [];
  const result = await streamApi('/api/drafts', { blueprint: {} }, controller.signal, event => progress.push(event));
  assert.equal(captured.signal, controller.signal);
  assert.equal(captured.headers.Accept, 'application/x-ndjson');
  assert.deepEqual(progress, [{ stage: 'comparing', label: '单选' }]);
  assert.equal(result.draft.title, '试卷');
});

test('progress client surfaces streamed errors and interrupted streams without fabricating a draft', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ type: 'result', status: 503,
    result: { ok: false, error: { code: 'model_error', message: '比较失败' } } }) + '\n',
    { headers: { 'Content-Type': 'application/x-ndjson' } }));
  await assert.rejects(streamApi('/api/drafts', {}), { message: '比较失败', code: 'model_error', status: 503 });
  globalThis.fetch = async () => new Response('{"type":"heartbeat"}\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
  await assert.rejects(streamApi('/api/drafts', {}), /连接已中断/);
});
