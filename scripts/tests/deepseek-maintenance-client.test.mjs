import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openDeepSeekMaintenanceClient } from '../lib/deepseek-maintenance-client.mjs';

const SECRET = 'simulated-private-key-never-log';
const profile = (id = 'ds', patch = {}) => ({ id, name: 'private profile name', baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash', reasoningEffort: 'high', protectedKey: 'simulated-ciphertext', ...patch });
async function fixture(t, profiles = [profile()], activeProfileId = 'ds') {
  const dir = await mkdtemp(path.join(tmpdir(), 'tutor-simulated-ds-maintenance-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const settingsFile = path.join(dir, 'model-settings.json');
  const original = JSON.stringify({ schemaVersion: 2, revision: 13, profiles, activeProfileId });
  await writeFile(settingsFile, original);
  return { settingsFile, original, decryptImpl: async encrypted => {
    assert.equal(encrypted, 'simulated-ciphertext'); return SECRET;
  } };
}
const ok = data => ({ ok: true, status: 200, json: async () => data });
const completion = (patch = {}) => ({ id: 'simulated-response', choices: [{ finish_reason: 'stop',
  message: { role: 'assistant', content: '{"answer":"16"}', reasoning_content: 'private simulated thinking' } }], ...patch });
const safeError = (code, forbidden = SECRET) => error => {
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assert.ok(!JSON.stringify(error).includes(forbidden));
  assert.ok(!String(error.stack).includes(forbidden));
  return true;
};

test('simulated provider discovery fetches the actual fixed endpoint without a static fallback', async t => {
  const f = await fixture(t);
  let calls = 0;
  const client = await openDeepSeekMaintenanceClient({ ...f, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.deepseek.com/models');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer ' + SECRET);
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.body, undefined);
    return ok({ data: [{ id: 'actual-model-a' }, { id: 'actual-model-b' }] });
  } });
  assert.equal(calls, 0, 'opening settings must not call the network');
  const result = await client.getModels();
  assert.deepEqual(result.models, ['actual-model-a', 'actual-model-b']);
  assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
  assert.deepEqual(client.publicProfile, { id: 'ds', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash',
    reasoningEffort: 'high', selectedProfileWasActive: true });
  assert.equal(await readFile(f.settingsFile, 'utf8'), f.original);
  assert.equal(calls, 1);
});

test('simulated completion preserves content, finish reason and request evidence while stripping private reasoning', async t => {
  const f = await fixture(t);
  const messages = [{ role: 'system', content: 'Simulated math task' }, { role: 'user', content: 'x+y' }];
  let body;
  const client = await openDeepSeekMaintenanceClient({ ...f, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    body = JSON.parse(options.body);
    assert.deepEqual(body, { model: 'deepseek-flash', messages, thinking: { type: 'enabled' }, reasoning_effort: 'high',
      response_format: { type: 'json_object' }, max_tokens: 800, stream: false });
    return ok(completion({ choices: [{ finish_reason: 'length', message: {
      content: '  {"answer":', reasoning_content: '隐私推理🙂', nested: { reasoning_content: 'abc' },
    } }], usage: { completion_tokens_details: { reasoning_tokens: 100 } } }));
  } });
  const result = await client.complete(messages, { maxTokens: 800 });
  assert.equal(result.content, '  {"answer":');
  assert.equal(result.providerResponse.choices[0].finish_reason, 'length');
  assert.equal(result.providerResponse.reasoningReported, true);
  assert.equal(result.providerResponse.reasoningCharacters, 8);
  assert.ok(!JSON.stringify(result).includes('reasoning_content'));
  assert.ok(!JSON.stringify(result).includes('隐私推理'));
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.equal(result.providerResponse.usage.completion_tokens_details.reasoning_tokens, 100);
  assert.equal(result.requestSha256, createHash('sha256').update(JSON.stringify(body)).digest('hex'));
  assert.ok(result.elapsedSeconds >= 0);
  assert.ok(Number.isFinite(Date.parse(result.startedAt)));
  assert.equal(await readFile(f.settingsFile, 'utf8'), f.original);
});

test('simulated profile selection prefers active matching profile, then unique matching profile', async t => {
  const f = await fixture(t, [profile('first'), profile('second')], 'second');
  const active = await openDeepSeekMaintenanceClient(f);
  assert.equal(active.publicProfile.id, 'second');
  const g = await fixture(t, [profile('other', { model: 'another-model' }), profile('unique')], 'other');
  const unique = await openDeepSeekMaintenanceClient(g);
  assert.equal(unique.publicProfile.id, 'unique');
  assert.equal(unique.publicProfile.selectedProfileWasActive, false);
  const h = await fixture(t, [profile('one'), profile('two')], null);
  await assert.rejects(openDeepSeekMaintenanceClient(h), safeError('profile_ambiguous'));
});

test('simulated selection rejects wrong model, effort, endpoint and malformed identity before decryption', async t => {
  for (const patch of [{ model: 'deepseek-reasoner' }, { reasoningEffort: null }, { reasoningEffort: 'off' },
    { baseUrl: 'https://api.deepseek.com/v1' }, { baseUrl: 'https://api.deepseek.com.evil.example' },
    { baseUrl: 123 }, { baseUrl: 'https://api.deepseek.com/?key=private' }]) {
    const f = await fixture(t, [profile('wrong', patch)], 'wrong');
    await assert.rejects(openDeepSeekMaintenanceClient({ ...f, decryptImpl: () => assert.fail('must not decrypt') }), safeError('profile_not_found'));
  }
  const f = await fixture(t, [profile('dup'), profile('dup')], 'dup');
  await assert.rejects(openDeepSeekMaintenanceClient(f), safeError('settings_invalid'));
});

test('simulated errors never expose provider error bodies, exception text or credentials and never retry', async t => {
  const f = await fixture(t);
  let calls = 0;
  const client = await openDeepSeekMaintenanceClient({ ...f, fetchImpl: async () => {
    calls++;
    return { ok: false, status: 401, json() { assert.fail('must not read provider error body'); }, text() { return SECRET; } };
  } });
  await assert.rejects(client.getModels(), error => {
    safeError('http_error')(error);
    assert.equal(error.safeRecord.status, 401);
    return true;
  });
  assert.equal(calls, 1);
  const spoofed = await openDeepSeekMaintenanceClient({ ...f, fetchImpl: async () => {
    const error = new Error(SECRET); error.code = 'http_error'; throw error;
  } });
  await assert.rejects(spoofed.complete([{ role: 'user', content: 'simulated' }]), safeError('request_failed'));
  await assert.rejects(openDeepSeekMaintenanceClient({ ...f, decryptImpl: async () => { throw new Error(SECRET); } }), safeError('credential_decryption_failed'));
});

test('simulated timeout aborts fetch, reports safe metadata, and does not retry', async t => {
  const f = await fixture(t);
  let calls = 0;
  let signal;
  const client = await openDeepSeekMaintenanceClient({ ...f, timeoutMs: 15, fetchImpl: async (_url, options) => {
    calls++; signal = options.signal; return new Promise(() => {});
  } });
  await assert.rejects(client.getModels(), safeError('request_timeout'));
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
});

test('simulated malformed model discovery and malformed responses fail without guessed data', async t => {
  const f = await fixture(t);
  for (const data of [{}, { data: [{ name: 'not-id' }] }]) {
    const client = await openDeepSeekMaintenanceClient({ ...f, fetchImpl: async () => ok(data) });
    await assert.rejects(client.getModels(), safeError('model_list_invalid'));
  }
  const invalid = await openDeepSeekMaintenanceClient({ ...f, fetchImpl: async () => ({ ok: true, json: async () => { throw new Error(SECRET); } }) });
  await assert.rejects(invalid.getModels(), safeError('response_invalid_json'));
  const missing = await openDeepSeekMaintenanceClient({ ...f, fetchImpl: async () => ok({ choices: [] }) });
  await assert.rejects(missing.complete([{ role: 'user', content: 'simulated' }]), safeError('content_missing'));
});

test('simulated audit callback completes before network, cannot mutate request, and failure prevents network', async t => {
  const f = await fixture(t);
  const events = [];
  let calls = 0;
  const messages = [{ role: 'user', content: 'original simulated task' }];
  const client = await openDeepSeekMaintenanceClient({ ...f, fetchImpl: async (_url, options) => {
    events.push('fetch');
    calls++;
    const request = JSON.parse(options.body);
    assert.equal(request.model, 'deepseek-flash');
    assert.deepEqual(request.messages, messages);
    return ok(completion());
  } });
  const result = await client.complete(messages, { onRequest: async request => {
    events.push('audit-start');
    assert.equal(request.model, 'deepseek-flash');
    assert.deepEqual(request.messages, messages);
    request.model = 'callback-mutated-model';
    request.messages[0].content = 'callback-mutated-content';
    await Promise.resolve();
    events.push('audit-finished');
  } });
  assert.deepEqual(events, ['audit-start', 'audit-finished', 'fetch']);
  assert.equal(result.request.model, 'deepseek-flash');
  assert.deepEqual(result.request.messages, messages);
  await assert.rejects(client.complete(messages, { onRequest: async () => {
    throw new Error(SECRET);
  } }), safeError('audit_write_failed'));
  assert.equal(calls, 1, 'failed request audit must prevent the second network call');
});
