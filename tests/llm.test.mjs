import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createLlmGateway } from '../src/llm/gateway.mjs';
import { proposalSchema } from '../src/intake/schema.mjs';

const env = { LLM_BASE_URL: 'https://fixture.invalid/v1', LLM_API_KEY: 'fixture-secret-never-public', LLM_MODEL: 'fixture-model', LLM_PROVIDER_NAME: 'fixture-provider' };
const proposal = { summary: 'fixture only', changes: { cognition: 'apply', priority: 'preferred' }, blocks: [] };

test('component schemas reject wrong field kinds and interactive notice attributes', () => {
  for (const block of [
    { kind: 'notice', id: 'bad-notice', title: 'fixture', field: 'premises', value: [] },
    { kind: 'number', id: 'bad-number', title: 'fixture', field: 'purpose', value: 1 },
    { kind: 'single_choice', id: 'bad-choice', title: 'fixture', field: 'cognition', options: [] },
    { kind: 'multi_choice', id: 'bad-array', title: 'fixture', field: 'mainScope', options: [{ id: '1.1', label: 'fixture' }], value: '1.1' },
  ]) assert.equal(proposalSchema.safeParse({ ...proposal, blocks: [block] }).success, false);
});

test('gateway does not call a model when missing configuration or already cancelled', async () => {
  let calls = 0;
  const generate = async () => { calls++; return { output: proposal }; };
  assert.equal((await createLlmGateway({ env: {}, generate }).propose({})).error.code, 'not_configured');
  const signal = AbortSignal.abort();
  assert.equal((await createLlmGateway({ env, generate }).propose({}, { signal })).error.code, 'cancelled');
  assert.equal(calls, 0);
  assert.deepEqual(createLlmGateway({ env }).publicStatus(), { configured: true, provider: 'fixture-provider', model: 'fixture-model' });
  assert.ok(!JSON.stringify(createLlmGateway({ env }).publicStatus()).includes(env.LLM_API_KEY));
});

test('timeout and cancellation abort calls even when a provider stalls', async () => {
  let providerSignal;
  const generate = async options => { providerSignal = options.abortSignal; return new Promise(() => {}); };
  const result = await createLlmGateway({ env, timeoutMs: 15, generate }).propose({});
  assert.equal(result.error.code, 'timeout');
  assert.equal(providerSignal.aborted, true);
  const controller = new AbortController();
  const pending = createLlmGateway({ env, timeoutMs: 500, generate }).propose({}, { signal: controller.signal });
  controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.error.code, 'cancelled');
});

test('model errors are redacted and successful usage is recorded', async () => {
  const failure = await createLlmGateway({ env, generate: async () => { throw new Error(`Bearer ${env.LLM_API_KEY} https://provider.test?secret=x`); } }).propose({});
  assert.equal(failure.error.code, 'model_error');
  assert.equal(failure.run.attempts.length, 1);
  assert.ok(!JSON.stringify(failure).includes(env.LLM_API_KEY));
  assert.ok(!JSON.stringify(failure).includes('provider.test'));
  const success = await createLlmGateway({ env, generate: async () => ({ output: proposal, usage: { inputTokens: 12, outputTokens: 25, totalTokens: 37 } }) }).propose({});
  assert.equal(success.ok, true);
  assert.deepEqual(success.run.usage, { inputTokens: 12, outputTokens: 25, totalTokens: 37 });
  assert.equal(success.run.structuredOutput, 'json_object_local_validation');
  const invalid = await createLlmGateway({ env, generate: async () => ({ output: { html: '<script/>' }, usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } }) }).propose({});
  assert.equal(invalid.error.code, 'invalid_model_output');
  assert.equal(invalid.run.usage.totalTokens, 14);
  assert.equal(invalid.run.attempts.length, 2);
});

test('one bounded schema correction preserves strict validation and accounts for both calls', async () => {
  const invalid = { ...proposal, blocks: Array.from({ length: 9 }, (_, index) => ({ kind: 'notice', id: `extra-${index}`, title: 'fixture' })) };
  const received = [];
  const gateway = createLlmGateway({ env, generate: async options => {
    received.push(options);
    return { output: received.length === 1 ? invalid : proposal, usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 } };
  } });
  const result = await gateway.propose({ message: 'fixture correction' });
  assert.equal(result.ok, true);
  assert.equal(received.length, 2);
  assert.deepEqual(result.proposal, proposal);
  assert.equal(result.run.attempts[0].status, 'invalid_model_output');
  assert.equal(result.run.attempts[1].status, 'succeeded');
  assert.equal(result.run.usage.totalTokens, 20);
  assert.ok(JSON.parse(received[1].prompt).schemaCorrection.issues.some(issue => issue.path[0] === 'blocks'));
  assert.equal(received[0].abortSignal, received[1].abortSignal);
  assert.equal(invalid.blocks.length, 9); // Input was not truncated or silently accepted.
});

test('business validation shares the same two-attempt budget and precedes success status', async () => {
  const received = [];
  const firstOutput = { ...proposal, changes: { mainScope: ['unknown-section'] } };
  const gateway = createLlmGateway({ env, generate: async options => {
    received.push(options);
    return { output: received.length === 1 ? firstOutput : proposal, usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 } };
  } });
  let checks = 0;
  const result = await gateway.propose({}, { validate(candidate) {
    checks++;
    if (candidate.changes.mainScope?.includes('unknown-section')) throw Object.assign(new Error('主考范围包含未知项目。'), { code: 'invalid_intake' });
    return candidate;
  } });
  assert.equal(result.ok, true);
  assert.equal(checks, 2);
  assert.equal(result.run.attempts.length, 2);
  assert.equal(result.run.attempts[0].errorName, 'BusinessValidationError');
  assert.equal(result.run.attempts[0].businessIssue, '主考范围包含未知项目。');
  assert.equal(result.run.attempts[0].status, 'invalid_model_output');
  assert.equal(result.run.usage.totalTokens, 20);
  const feedback = JSON.parse(received[1].prompt).schemaCorrection;
  assert.equal(feedback.issues[0].code, 'business_validation');
  assert.equal(feedback.issues[0].message, '主考范围包含未知项目。');

  let calls = 0;
  const rejected = await createLlmGateway({ env, generate: async () => { calls++; return { output: proposal }; } }).propose({}, { validate() { throw new Error('模型组件默认值与建议变更冲突。'); } });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'invalid_model_output');
  assert.equal(calls, 2);
  assert.ok(rejected.run.attempts.every(attempt => attempt.status === 'invalid_model_output'));
});

test('actual AI SDK wire uses JSON object by default and native schema only by explicit configuration', async t => {
  const bodies = [];
  // Local deterministic HTTP fixture validates the SDK transport, not model quality.
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    bodies.push(JSON.parse(body));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ id: 'fixture-response', object: 'chat.completion', created: 1, model: 'fixture-model', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(proposal) }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 8, total_tokens: 17 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const fixtureEnv = { ...env, LLM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` };
  const first = await createLlmGateway({ env: fixtureEnv }).propose({ message: 'fixture request' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(bodies[0].response_format.type, 'json_object');
  assert.ok(bodies[0].messages[0].content.includes('"additionalProperties":false'));
  assert.ok(bodies[0].messages[0].content.includes('"priority"'));
  assert.equal(first.run.usage.totalTokens, 17);
  const native = await createLlmGateway({ env: { ...fixtureEnv, LLM_STRUCTURED_OUTPUTS: 'json_schema' } }).propose({});
  assert.equal(native.ok, true, JSON.stringify(native));
  assert.equal(bodies[1].response_format.type, 'json_schema');
  assert.equal(native.run.structuredOutput, 'json_schema');
  const deepseek = await createLlmGateway({ env: { ...fixtureEnv, LLM_PROVIDER_NAME: 'deepseek-official' } }).propose({});
  assert.equal(deepseek.ok, true, JSON.stringify(deepseek));
  assert.deepEqual(bodies[2].thinking, { type: 'disabled' });
});
