import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalSha256, validateScopedManifest, runScopedTeachingReview } from '../run-scoped-teaching-review.mjs';

const draft = id => ({ questionId: id, answer: '2', difficultyAssessment: { level: 'easy', basis: '模拟回归：整数加法。' },
  teachingSolution: '由 $1+1=2$ 得答案。', teachingFocusSchemaVersion: 2,
  teachingFocus: { examFocus: '模拟整数加法。', studentRequirements: ['能计算1+1。'] }, issues: [] });
const hash = text => createHash('sha256').update(text).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
async function setup(t, kind = 'review') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tutor-scoped-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalMaterial = { questionId: 'sim-scoped', student: { stem: '模拟回归：1+1？' } };
  const candidate = kind === 'review' ? draft(originalMaterial.questionId) : null;
  const entry = { questionId: originalMaterial.questionId, paperIndex: 1, questionNumber: 1, kind,
    originalMaterial, candidate, reviewFindings: kind === 'review' ? [{ type: 'term', ruleId: 'simulated', guidance: '模拟：仅改表达。' }] : [],
    explicitAuditFindings: kind === 'review' ? [{ type: 'independent_audit', issue: '模拟已知表达问题，非规则结论。' }] : [],
    sourceQuestionSha256: canonicalSha256(originalMaterial), candidateSha256: candidate && canonicalSha256(candidate), priorReviewCalls: 2 };
  const manifest = { operationId: 'sim-explicit-scoped-01', settingsFile: path.join(root, 'settings.json'), entries: [entry], protectedQuestionIds: ['sim-qualified'] };
  await writeFile(manifest.settingsFile, 'simulated settings unchanged');
  const manifestFile = path.join(root, 'manifest.json');
  await writeFile(manifestFile, JSON.stringify(manifest));
  return { root, manifest, manifestFile, outputDirectory: path.join(root, 'run') };
}
function fake(model, handler, fail = false) {
  const state = { listCalls: 0, calls: 0, requests: [], publicProfile: { model, credentialSource: 'saved_matching_profile' },
    async getModels() { state.listCalls++; return { models: [model] }; },
    async complete(messages, { onRequest, maxTokens }) {
      const request = { model, messages, enable_thinking: true, stream: false, max_tokens: maxTokens };
      await onRequest(request); state.calls++; state.requests.push(request);
      if (fail) throw Object.assign(new Error('simulated'), { code: 'request_timeout' });
      const result = handler(JSON.parse(messages[1].content));
      const content = JSON.stringify(result);
      return { request, requestSha256: hash(JSON.stringify(request)), content, elapsedSeconds: 0.001,
        providerResponse: { model, choices: [{ finish_reason: 'stop', message: { content, reasoning_content: 'MUST_NOT_SAVE' } }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } } };
    } };
  return state;
}
const noDisplayFindings = () => ({ findings: [], warnings: [] });

test('canonical hashes are sorted, identity and protected guards reject before clients', async t => {
  assert.equal(canonicalSha256({ b: 2, a: 1 }), canonicalSha256({ a: 1, b: 2 }));
  assert.notEqual(canonicalSha256([1, 2]), canonicalSha256([2, 1]));
  const options = await setup(t);
  for (const alter of [m => m.entries.push(m.entries[0]), m => m.protectedQuestionIds.push('sim-scoped'),
    m => m.entries[0].candidate.answer = 'wrong-hash', m => m.entries[0].originalMaterial.student.stem = 'changed']) {
    const changed = structuredClone(options.manifest); alter(changed);
    assert.throws(() => validateScopedManifest(changed));
    await writeFile(options.manifestFile, JSON.stringify(changed));
    let accessed = false;
    await assert.rejects(runScopedTeachingReview({ ...options, validateDisplay: noDisplayFindings,
      reviewClientFactory: async () => { accessed = true; throw new Error('must not access'); } }));
    assert.equal(accessed, false);
  }
  assert.deepEqual((await readdir(options.root)).sort(), ['manifest.json', 'settings.json']);
});

test('one explicit review uses shared prompt and distinct audit scope; saves exact requests without secret reasoning', async t => {
  const options = await setup(t);
  let factoryOptions;
  const client = fake('qwen3.8-flash', context => {
    assert.equal(context.originalMaterial.questionId, 'sim-scoped');
    assert.equal(context.rawCandidateSameAsCandidate, true);
    assert.equal(context.explicitAuditFindings[0].type, 'independent_audit');
    assert.equal(context.reviewRules[0].guidance, '模拟：仅改表达。');
    return draft('sim-scoped');
  });
  const before = await readFile(options.manifestFile, 'utf8');
  const { results, summary } = await runScopedTeachingReview({ ...options, validateDisplay: noDisplayFindings,
    reviewClientFactory: async opts => { factoryOptions = opts; return client; } });
  assert.equal(client.calls, 1); assert.equal(client.listCalls, 0);
  assert.equal(factoryOptions.timeoutMs, 300000);
  assert(factoryOptions.agentEnvFile.endsWith('__disabled_agent_env_fallback__'));
  assert.equal(summary.totalAdditionalReviewCalls, 1);
  assert.equal(results[0].previousReviewCalls, 2); assert.equal(results[0].totalReviewCallsObserved, 3);
  assert.equal(results[0].status, 'ready_candidate'); assert.equal(results[0].databaseOpened, false);
  assert.equal(client.requests[0].max_tokens, 16384);
  assert.equal(client.requests[0].messages[0].content, (await readFile(new URL('../resources/teaching-quality-review-instruction.txt', import.meta.url), 'utf8')).trim());
  const folder = hash('sim-scoped').slice(0, 24);
  const response = await readFile(path.join(options.outputDirectory, folder, 'review.provider-response.json'), 'utf8');
  assert(!response.includes('MUST_NOT_SAVE')); assert(!response.includes('reasoning_content'));
  assert.equal(await readFile(options.manifestFile, 'utf8'), before);
  assert.equal(await readFile(options.manifest.settingsFile, 'utf8'), 'simulated settings unchanged');
  await assert.rejects(runScopedTeachingReview({ ...options, validateDisplay: noDisplayFindings,
    reviewClientFactory: async () => client }), { code: 'output_directory_must_be_new' });
  assert.equal(client.calls, 1);
});

test('technical failure retains one attempt and never silently adopts old candidate or retries', async t => {
  const options = await setup(t);
  const client = fake('qwen3.8-flash', () => draft('sim-scoped'), true);
  const { results } = await runScopedTeachingReview({ ...options, validateDisplay: noDisplayFindings, reviewClientFactory: async () => client });
  assert.equal(client.calls, 1);
  assert.equal(results[0].status, 'review_failed'); assert.equal(results[0].candidate, null);
  assert.equal(results[0].error.code, 'request_timeout');
  assert.equal(results[0].additionalReviewCalls, 1); assert.equal(results[0].calls[0].requestWritten, true);
});

test('clean fresh generation never discovers reviewer; flagged generation gets exactly one review', async t => {
  const options = await setup(t, 'generation');
  let reviewerAccess = 0;
  const generator = fake('deepseek-flash', context => draft(context.questionId));
  const clean = await runScopedTeachingReview({ ...options, validateDisplay: noDisplayFindings,
    generationClientFactory: async () => generator,
    reviewClientFactory: async () => { reviewerAccess++; throw new Error('must not discover'); } });
  assert.equal(clean.results[0].status, 'ready_candidate'); assert.equal(generator.calls, 1); assert.equal(reviewerAccess, 0);
  const flaggedGenerator = fake('deepseek-flash', context => ({ ...draft(context.questionId), teachingSolution: '模拟：这里使用范数。' }));
  const reviewer = fake('qwen3.8-flash', context => draft(context.originalMaterial.questionId));
  const flagged = await runScopedTeachingReview({ ...options, outputDirectory: path.join(options.root, 'flagged'), validateDisplay: noDisplayFindings,
    generationClientFactory: async () => flaggedGenerator, reviewClientFactory: async () => reviewer });
  assert.equal(flaggedGenerator.calls, 1); assert.equal(reviewer.calls, 1); assert.equal(reviewer.listCalls, 0);
  assert.equal(flagged.results[0].generationCalls, 1); assert.equal(flagged.results[0].additionalReviewCalls, 1);
});

test('direct unavailable-model response retains the candidate without a list, retry or fallback', async t => {
  const options = await setup(t);
  const client = fake('qwen3.8-flash', () => draft('sim-scoped'));
  client.getModels = () => assert.fail('execution must not fetch a model list');
  client.complete = async (messages, { onRequest }) => {
    client.calls++;
    const request = { model: client.publicProfile.model, messages, max_tokens: 16384 };
    await onRequest(request);
    throw Object.assign(new Error('http_error'), { code: 'http_error', safeRecord: { status: 404 } });
  };
  const { results } = await runScopedTeachingReview({ ...options, validateDisplay: noDisplayFindings, reviewClientFactory: async () => client });
  assert.equal(client.calls, 1); assert.equal(results[0].candidate, null);
  assert.equal(results[0].error.code, 'http_error');
  assert.equal(results[0].additionalReviewCalls, 1);
  assert.equal((await json(path.join(options.outputDirectory, 'protocol.json'))).modelListFetched, false);
  assert(!(await readdir(options.outputDirectory)).some(name => name.endsWith('models-public.json')));
});
