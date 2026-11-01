import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openQwenMaintenanceClient } from '../lib/qwen-maintenance-client.mjs';
import { openDeepSeekMaintenanceClient } from '../lib/deepseek-maintenance-client.mjs';
import { runTeachingQualityMaintenance } from '../lib/teaching-quality-maintenance.mjs';
import { runTeachingTermMaintenance } from '../lib/teaching-term-maintenance.mjs';

const QWEN_BASE = 'https://maas.qianwenaiapi.com/compatible-mode/v1';
const BAILIAN_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const BAILIAN_SECRET = 'simulated-bailian-only-secret';
const DS_BASE = 'https://api.deepseek.com';
const QWEN_SECRET = 'simulated-review-secret';
const DS_SECRET = 'simulated-generation-secret';
const qwen = (id = 'qwen', patch = {}) => ({ id, baseUrl: QWEN_BASE, model: 'qwen3.8-flash', reasoningEffort: 'on', protectedKey: 'qwen-cipher', ...patch });
const bailian = (id = 'bailian-review', patch = {}) => ({ id, baseUrl: BAILIAN_BASE, model: 'qwen3.7-flash', reasoningEffort: null, protectedKey: 'bailian-cipher', ...patch });
const ds = { id: 'ds', baseUrl: DS_BASE, model: 'deepseek-flash', reasoningEffort: 'high', protectedKey: 'ds-cipher' };
const ok = data => ({ ok: true, status: 200, json: async () => data });
const draft = (id, text = '模拟：由题意计算得2。') => ({ questionId: id, answer: '2',
  difficultyAssessment: { level: 'easy', basis: '模拟：直接加法。' }, teachingSolution: text,
  teachingFocusSchemaVersion: 2, teachingFocus: { examFocus: '模拟加法。', studentRequirements: ['能计算。'] }, issues: [] });
const decryptImpl = async ciphertext => {
  if (ciphertext === 'ds-cipher') return DS_SECRET;
  assert.equal(ciphertext, 'qwen-cipher'); return QWEN_SECRET;
};
async function fixture(t, profiles = [ds, qwen()], activeProfileId = 'ds') {
  const root = await mkdtemp(path.join(tmpdir(), 'tutor-simulated-qwen-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsFile = path.join(root, 'settings.json'), agentEnvFile = path.join(root, 'agent.env');
  await writeFile(settingsFile, JSON.stringify({ schemaVersion: 2, profiles, activeProfileId }));
  await writeFile(agentEnvFile, 'DEEPSEEK_API_KEY=never-use-this\nQWEN_API_KEY="simulated-env-secret" # offline\n');
  return { root, settingsFile, agentEnvFile, decryptImpl };
}
const json = async (root, name) => JSON.parse(await readFile(path.join(root, name), 'utf8'));
const safeError = code => error => {
  assert.equal(error.code, code); assert.equal(error.message, code);
  assert(!JSON.stringify(error).includes(QWEN_SECRET)); assert(!String(error.stack).includes(QWEN_SECRET));
  return true;
};

test('Qwen saved thinking-on profile wins over env, fixed provider discovery and exact thinking body are independently authenticated', async t => {
  const f = await fixture(t);
  const before = await readFile(f.settingsFile, 'utf8');
  const calls = [];
  const client = await openQwenMaintenanceClient({ ...f, fetchImpl: async (url, opts) => {
    calls.push({ url, opts });
    assert.equal(opts.headers.Authorization, `Bearer ${QWEN_SECRET}`);
    assert.equal(opts.redirect, 'error');
    if (url === QWEN_BASE + '/models') {
      assert.equal(opts.method, 'GET'); assert.equal(opts.body, undefined);
      return ok({ data: [{ id: 'qwen3.8-flash' }] });
    }
    assert.equal(url, QWEN_BASE + '/chat/completions');
    assert.equal(opts.method, 'POST');
    const body = JSON.parse(opts.body);
    assert.deepEqual(body, { model: 'qwen3.8-flash', messages: [{ role: 'user', content: 'simulated' }],
      enable_thinking: true, response_format: { type: 'json_object' }, max_tokens: 32768, stream: false });
    return ok({ model: 'qwen3.8-flash', choices: [{ finish_reason: 'stop', message: { content: '{}', reasoning_content: 'private thinking' } }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
  } });
  assert.equal(calls.length, 0);
  assert.deepEqual((await client.getModels()).models, ['qwen3.8-flash']);
  let audited;
  const result = await client.complete([{ role: 'user', content: 'simulated' }], { onRequest: async request => { audited = request; } });
  assert.equal(result.requestSha256, createHash('sha256').update(JSON.stringify(audited)).digest('hex'));
  assert.equal(result.providerResponse.reasoningReported, true);
  assert(!JSON.stringify(result).includes('private thinking'));
  assert(!JSON.stringify(result).includes(QWEN_SECRET));
  assert.equal(client.publicProfile.credentialSource, 'saved_matching_profile');
  assert.equal(await readFile(f.settingsFile, 'utf8'), before);
});

test('Qwen selection prefers active matching profile, otherwise unique, rejects ambiguity and does not fall back after decryption failure', async t => {
  const active = await fixture(t, [ds, qwen('one'), qwen('two')], 'two');
  assert.equal((await openQwenMaintenanceClient(active)).publicProfile.id, 'two');
  const ambiguous = await fixture(t, [ds, qwen('one'), qwen('two')]);
  await assert.rejects(openQwenMaintenanceClient(ambiguous), safeError('profile_ambiguous'));
  const broken = await fixture(t);
  await assert.rejects(openQwenMaintenanceClient({ ...broken, decryptImpl: async () => { throw Error(QWEN_SECRET); } }), safeError('credential_decryption_failed'));
});

test('offline env is used only without a matching saved profile and never takes DeepSeek credentials', async t => {
  const f = await fixture(t, [ds, qwen('off', { reasoningEffort: 'off' }), qwen('evil', { baseUrl: QWEN_BASE + '.evil' })]);
  let calls = 0;
  const opts = { ...f, decryptImpl: () => assert.fail('no profile decryption'), fetchImpl: async (url, options) => {
    calls++; assert.equal(url, QWEN_BASE + '/models');
    assert.equal(options.headers.Authorization, 'Bearer simulated-env-secret'); return ok({ data: [] });
  } };
  const client = await openQwenMaintenanceClient(opts);
  assert.equal(client.publicProfile.credentialSource, 'explicit_offline_agent_env');
  await client.getModels(); assert.equal(calls, 1);
  for (const text of ['DEEPSEEK_API_KEY=private', 'QWEN_API_KEY=one\nQWEN_API_KEY=two', 'QWEN_API_KEY="unterminated', 'QWEN_API_KEY="bad\u0001key"']) {
    await writeFile(f.agentEnvFile, text);
    await assert.rejects(openQwenMaintenanceClient(opts), error => ['qwen_credential_unavailable', 'credential_unavailable'].includes(error.code));
  }
  assert.equal(calls, 1);
});

test('Qwen transport redacts arbitrary failures and provider error bodies, bounds time and never retries', async t => {
  const f = await fixture(t);
  let calls = 0;
  const rejected = await openQwenMaintenanceClient({ ...f, fetchImpl: async () => {
    calls++; return { ok: false, status: 401, json() { assert.fail('no error body read'); } };
  } });
  await assert.rejects(rejected.getModels(), safeError('http_error')); assert.equal(calls, 1);
  const timeout = await openQwenMaintenanceClient({ ...f, timeoutMs: 10, fetchImpl: async () => { calls++; return new Promise(() => {}); } });
  await assert.rejects(timeout.getModels(), safeError('request_timeout')); assert.equal(calls, 2);
  const spoofed = await openQwenMaintenanceClient({ ...f, fetchImpl: async () => { throw Object.assign(Error(QWEN_SECRET), { code: 'http_error' }); } });
  await assert.rejects(spoofed.getModels(), safeError('request_failed'));
  const audit = await openQwenMaintenanceClient({ ...f, fetchImpl: () => assert.fail('no network before audit') });
  await assert.rejects(audit.complete([{ role: 'user', content: 'simulated' }], { onRequest: () => { throw Error(QWEN_SECRET); } }), safeError('audit_write_failed'));
});

test('explicit Bailian profile uses its independent credential, own catalogue and exact thinking request without changing saved defaults', async t => {
  const f = await fixture(t, [ds, qwen(), qwen('other-provider-same-model', { model: 'qwen3.7-flash' }), bailian(), bailian('unselected-bailian', { protectedKey: 'must-not-decrypt' })]);
  const before = await readFile(f.settingsFile, 'utf8'), calls = [];
  const client = await openQwenMaintenanceClient({ ...f, provider: 'bailian', model: 'qwen3.7-flash', profileId: 'bailian-review',
    decryptImpl: async cipher => { assert.equal(cipher, 'bailian-cipher'); return BAILIAN_SECRET; },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.headers.Authorization, `Bearer ${BAILIAN_SECRET}`);
      assert.equal(options.redirect, 'error');
      if (url === BAILIAN_BASE + '/models') return ok({ data: [{ id: 'qwen3.7-flash' }] });
      assert.equal(url, BAILIAN_BASE + '/chat/completions');
      const body = JSON.parse(options.body);
      assert.deepEqual(body, { model: 'qwen3.7-flash', messages: [{ role: 'user', content: 'simulated review only' }], enable_thinking: true,
        thinking_budget: 8192, response_format: { type: 'json_object' }, max_tokens: 16384, stream: false });
      assert(!Object.hasOwn(body, 'reasoning_effort')); assert(!Object.hasOwn(body, 'thinking'));
      return ok({ choices: [{ finish_reason: 'stop', message: { content: '{}', reasoning_content: 'private simulated reasoning' } }], usage: { total_tokens: 5 } });
    } });
  assert.equal(calls.length, 0);
  assert.equal(client.publicProfile.provider, 'bailian'); assert.equal(client.publicProfile.id, 'bailian-review');
  assert.equal(client.publicProfile.baseUrl, BAILIAN_BASE); assert.equal(client.publicProfile.model, 'qwen3.7-flash');
  assert.equal(client.publicProfile.reasoningEffort, 'on'); assert.equal(client.publicProfile.credentialSource, 'saved_matching_profile');
  assert.equal(client.publicProfile.selectedProfileWasActive, false);
  const list = await client.getModels(); assert.equal(list.endpoint, BAILIAN_BASE + '/models'); assert.deepEqual(list.models, ['qwen3.7-flash']);
  let audited;
  const result = await client.complete([{ role: 'user', content: 'simulated review only' }], { maxTokens: 16384, onRequest: request => { audited = request; } });
  assert.equal(result.requestSha256, createHash('sha256').update(JSON.stringify(audited)).digest('hex'));
  assert.equal(result.providerResponse.reasoningReported, true);
  assert(!JSON.stringify(result).includes('private simulated reasoning')); assert(!JSON.stringify(result).includes(BAILIAN_SECRET));
  assert.equal(calls.length, 2); assert.equal(await readFile(f.settingsFile, 'utf8'), before);
});

test('Bailian missing, mismatched or ambiguous profile cannot use Qwen env or another provider credential', async t => {
  const f = await fixture(t, [ds, qwen(), qwen('same-model', { model: 'qwen3.7-flash' }), bailian('wrong-origin', { baseUrl: BAILIAN_BASE + '.evil' })]);
  const options = { ...f, provider: 'bailian', model: 'qwen3.7-flash', decryptImpl: () => assert.fail('must not borrow another profile key'), fetchImpl: () => assert.fail('no external call') };
  await assert.rejects(openQwenMaintenanceClient(options), safeError('profile_not_found'));
  await assert.rejects(openQwenMaintenanceClient({ ...options, profileId: 'same-model' }), safeError('profile_not_found'));
  const ambiguous = await fixture(t, [ds, bailian('one'), bailian('two')]);
  await assert.rejects(openQwenMaintenanceClient({ ...ambiguous, provider: 'bailian' }), safeError('profile_ambiguous'));
  await assert.rejects(openQwenMaintenanceClient({ ...ambiguous, provider: 'bailian', profileId: 'missing' }), safeError('profile_not_found'));
  const broken = await fixture(t, [ds, bailian()]);
  await assert.rejects(openQwenMaintenanceClient({ ...broken, provider: 'bailian', decryptImpl: async () => { throw Error(BAILIAN_SECRET); } }), error => {
    assert.equal(error.code, 'credential_decryption_failed'); assert(!JSON.stringify(error).includes(BAILIAN_SECRET)); return true;
  });
});

test('Bailian calls the exact configured model directly and explicit list results never authorize or revoke completion', async t => {
  const f = await fixture(t, [ds, bailian()]); let catalogue = 'malformed', lists = 0, completions = 0, audits = 0;
  const client = await openQwenMaintenanceClient({ ...f, provider: 'bailian', decryptImpl: async () => BAILIAN_SECRET,
    fetchImpl: async (url, options) => {
      if (url === BAILIAN_BASE + '/models') {
        lists++;
        return ok(catalogue === 'malformed' ? { data: [{}] } : { data: [{ id: catalogue === 'valid' ? 'qwen3.7-flash' : 'another-model' }] });
      }
      assert.equal(url, BAILIAN_BASE + '/chat/completions');
      assert.equal(JSON.parse(options.body).model, 'qwen3.7-flash');
      completions++; return ok({ choices: [{ message: { content: '{}' } }] });
    } });
  const complete = () => client.complete([{ role: 'user', content: 'simulated' }], { onRequest: () => { audits++; } });
  await complete(); assert.equal(lists, 0); assert.equal(completions, 1);
  await assert.rejects(client.getModels(), safeError('model_list_invalid'));
  await complete();
  catalogue = 'missing'; assert.deepEqual((await client.getModels()).models, ['another-model']);
  await complete();
  catalogue = 'valid'; await client.getModels(); await complete();
  assert.equal(lists, 3); assert.equal(completions, 4); assert.equal(audits, 4);
});

test('Bailian direct model errors are safe and never fetch a list, retry, or fall back', async t => {
  const f = await fixture(t, [ds, bailian()]); const calls = [];
  const client = await openQwenMaintenanceClient({ ...f, provider: 'bailian', decryptImpl: async () => BAILIAN_SECRET,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: false, status: 404, json() { assert.fail('provider error body must not be read'); } };
    } });
  await assert.rejects(client.complete([{ role: 'user', content: 'simulated' }]), error => {
    assert.equal(error.code, 'http_error'); assert.equal(error.safeRecord.status, 404);
    assert(!JSON.stringify(error).includes(BAILIAN_SECRET)); return true;
  });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, BAILIAN_BASE + '/chat/completions');
  assert.equal(calls[0].body.model, 'qwen3.7-flash');
});

test('Bailian preserves known thinking capabilities and the exact selected snapshot alias without a model-list request', async t => {
  const alias = 'qwen3.7-flash-2026-07-15', f = await fixture(t, [bailian('snapshot', { model: alias })], 'snapshot');
  const requests = [];
  const client = await openQwenMaintenanceClient({ ...f, provider: 'bailian', model: alias, profileId: 'snapshot', decryptImpl: async () => BAILIAN_SECRET,
    fetchImpl: async (url, options) => {
      assert.equal(url, BAILIAN_BASE + '/chat/completions');
      requests.push(JSON.parse(options.body)); return ok({ choices: [{ message: { content: '{}' } }] });
    } });
  await client.complete([{ role: 'user', content: 'simulated' }]);
  assert.equal(requests[0].model, alias); assert.equal(requests[0].max_tokens, 32768);
  for (const options of [{ provider: 'unknown' }, { provider: 'bailian', profileId: '' }]) {
    await assert.rejects(openQwenMaintenanceClient({ ...f, ...options }), safeError('invalid_options'));
  }
  for (const options of [{ provider: 'bailian', model: 'qwen3.8-flash' }, { provider: 'qianwenai', model: alias }]) {
    await assert.rejects(openQwenMaintenanceClient({ ...f, ...options }), safeError('unsupported_model_capability'));
  }
});

for (const [name, run] of [['quality', runTeachingQualityMaintenance], ['term', runTeachingTermMaintenance]]) {
  test(`${name} workflow calls configured models with independent keys and one Qwen review without model lists (simulated fetch)`, async t => {
    const f = await fixture(t);
    const inputs = ['sim-hit-a', 'sim-hit-b', 'sim-clean'];
    const inputFile = path.join(f.root, 'input.json'), outputDirectory = path.join(f.root, 'out');
    await writeFile(inputFile, JSON.stringify(inputs.map(questionId => ({ questionId, originalMaterial: { questionId, student: { stem: '模拟：1+1？' } } }))));
    const calls = [];
    const fetchImpl = async (url, opts) => {
      const isQwen = url.startsWith(QWEN_BASE);
      assert.equal(opts.headers.Authorization, `Bearer ${isQwen ? QWEN_SECRET : DS_SECRET}`);
      const body = opts.body ? JSON.parse(opts.body) : null;
      calls.push({ url, body });
      assert(!url.endsWith('/models'), 'execution must not fetch model catalogues');
      assert.equal(body.model, isQwen ? 'qwen3.8-flash' : 'deepseek-flash');
      assert.equal(body.enable_thinking, isQwen ? true : undefined);
      assert.equal(body.reasoning_effort, isQwen ? undefined : 'high');
      assert.equal(body.max_tokens, isQwen ? 32768 : 16384);
      const data = JSON.parse(body.messages[1].content);
      if(isQwen && data.patchContract?.segmentPatchVersion===2){
        const response={requestId:data.patchContract.requestId,
          patches:data.patchContract.allowedSegments.map(segment=>({segmentId:segment.segmentId,newText:'模拟：由 $1+1=2$ 得答案。'})),unresolvedIssues:[],
          ...(data.patchContract.termFindings?{termResolutions:data.patchContract.termFindings.map(f=>({findingId:f.findingId,status:'repaired',basis:'模拟：对应句段改为明确计算。'}))}:{})};
        return ok({model:body.model,choices:[{finish_reason:'stop',message:{content:JSON.stringify(response)}}],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}});
      }
      const id = isQwen ? data.originalMaterial.questionId : data.questionId;
      const result = draft(id, id.includes('hit') ? '模拟：目标式为2。' : undefined);
      return ok({ model: body.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } });
    };
    const result = await run({ inputFile, outputDirectory, settingsFile: f.settingsFile,
      concurrency: 3, clientFactory: opts => openDeepSeekMaintenanceClient({ ...opts, decryptImpl, fetchImpl }),
      reviewClientFactory: opts => openQwenMaintenanceClient({ ...opts, decryptImpl, fetchImpl }) });
    assert.equal(calls.filter(call => call.url === DS_BASE + '/models').length, 0);
    assert.equal(calls.filter(call => call.url === QWEN_BASE + '/models').length, 0);
    assert.equal(calls.filter(call => call.url === DS_BASE + '/chat/completions').length, 3);
    assert.equal(calls.filter(call => call.url === QWEN_BASE + '/chat/completions').length, 2);
    assert.equal(result.summary.modelListRequests, 0);
    assert.equal(result.summary.providers.generation.chatRequests, 3);
    assert.equal(result.summary.providers.review.chatRequests, 2);
    assert.equal(result.summary.providers.review.reportedUsage.total_tokens, 10);
    assert.equal(result.summary.providers.review.profile.provider, 'qianwenai');
    const record = await json(outputDirectory, 'review-responses/sim-hit-a.json');
    assert.equal(record.profile.model, 'qwen3.8-flash');
    assert.equal(record.profile.reasoningEffort, 'on');
    const saved = await json(outputDirectory, 'review-requests/sim-hit-a.json');
    assert.equal(saved.enable_thinking, true);
    assert.equal(record.requestSha256, createHash('sha256').update(JSON.stringify(saved)).digest('hex'));
    assert(!(await readFile(path.join(outputDirectory, 'summary.json'), 'utf8')).includes(QWEN_SECRET));
    const results = await json(outputDirectory, 'results.json');
    assert(results.filter(entry => entry.questionId.includes('hit')).every(entry => entry.reviewCalls === 1));
    assert.equal(result.summary.bankWritten, false); assert.equal(result.summary.settingsWritten, false);
  });

  test(`${name} clean drafts never open Qwen credentials or discover its provider`, async t => {
    const f = await fixture(t, [ds]);
    const inputFile = path.join(f.root, 'input.json'), outputDirectory = path.join(f.root, 'out');
    await writeFile(inputFile, JSON.stringify([{ questionId: 'sim-clean', originalMaterial: { questionId: 'sim-clean' } }]));
    const fetchImpl = async (url, opts) => {
      assert(url.startsWith(DS_BASE));
      assert.equal(url, DS_BASE + '/chat/completions');
      return ok({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(draft('sim-clean')) } }] });
    };
    const { summary } = await run({ inputFile, outputDirectory, settingsFile: f.settingsFile,
      clientFactory: opts => openDeepSeekMaintenanceClient({ ...opts, decryptImpl, fetchImpl }),
      reviewClientFactory: () => assert.fail('no Qwen credentials or network for clean draft') });
    assert.equal(summary.providers.review.chatRequests, 0);
    assert.equal(summary.providers.review.modelListRequests, 0);
    assert(!(await readdir(outputDirectory)).includes('review-models-public.json'));
  });

  for (const mode of ['model_unavailable', 'transport', 'credentials']) test(`${name} Qwen ${mode} failure keeps pending state without retry or DeepSeek fallback`, async t => {
    const f = await fixture(t);
    const inputFile = path.join(f.root, 'input.json'), outputDirectory = path.join(f.root, 'out');
    await writeFile(inputFile, JSON.stringify(['one','two'].map(id => ({ questionId: id, originalMaterial: { questionId: id } }))));
    let dsChats = 0, qwenChats = 0, lists = 0, factories = 0;
    const fetchImpl = async (url, opts) => {
      if (url.endsWith('/models')) { lists++; assert.fail('execution must not fetch model lists'); }
      if (url.startsWith(QWEN_BASE)) {
        qwenChats++;
        if (mode === 'model_unavailable') return { ok: false, status: 404, json() { assert.fail('no provider error body'); } };
        throw Error(QWEN_SECRET);
      }
      dsChats++;
      const id = JSON.parse(JSON.parse(opts.body).messages[1].content).questionId;
      return ok({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(draft(id, '模拟目标式。')) } }] });
    };
    const { summary } = await run({ inputFile, outputDirectory, settingsFile: f.settingsFile,
      clientFactory: opts => openDeepSeekMaintenanceClient({ ...opts, decryptImpl, fetchImpl }),
      reviewClientFactory: opts => {
        factories++;
        if (mode === 'credentials') throw Object.assign(Error('no key'), { code: 'credential_unavailable' });
        return openQwenMaintenanceClient({ ...opts, decryptImpl, fetchImpl });
      } });
    assert.equal(factories, 1); assert.equal(dsChats, 2);
    assert.equal(lists, 0);
    assert.equal(qwenChats, mode === 'credentials' ? 0 : 2);
    assert.equal(summary.failedQuestions.length, 2);
    const results = await json(outputDirectory, 'results.json');
    assert(results.every(result => result.status === 'review_failed' && result.initialResult && result.finalResult === null && result.reviewCalls === 1));
  });
}
