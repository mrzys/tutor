import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadTeachingMethodReferences } from '../lib/teaching-method-reference.mjs';
import { extractTeachingPrompt } from '../lib/teaching-term-maintenance.mjs';
import { runTeachingQualityMaintenance, createTeachingMathDisplayValidator } from '../lib/teaching-quality-maintenance.mjs';
import { teachingReviewModelContract } from '../lib/teaching-sentence-patch.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const draft = (questionId, teachingSolution = '模拟回归：由 $1+1=2$ 得答案。') => ({ questionId, answer: '2',
  difficultyAssessment: { level: 'easy', basis: '模拟回归：直接进行整数加法。' }, teachingSolution,
  teachingFocusSchemaVersion: 2, teachingFocus: { examFocus: '模拟加法。', studentRequirements: ['能计算1+1。'] }, issues: [] });

async function setup(t, ids = ['sim-quality']) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tutor-quality-maintenance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputFile = path.join(root, 'inputs.json'), settingsFile = path.join(root, 'unused-settings.json');
  await writeFile(inputFile, JSON.stringify(ids.map((id, i) => ({ questionId: id, sampleNumber: i + 1,
    originalMaterial: { questionId: id, student: { stem: '模拟回归：1+1是多少？原材料可以出现范数。' } } }))));
  await writeFile(settingsFile, 'Simulated settings: never decrypted or changed.');
  return { root, inputFile, settingsFile, outputDirectory: path.join(root, 'out') };
}

function fakeClient(handler, { models = ['deepseek-flash'], finishReason = 'stop', alterResponse = value => value,
  beforeNetwork = async () => {}, transportFailure = null, omitOnRequest = false } = {}) {
  const calls = [], events = [];
  return { calls, events,
    publicProfile: { id: 'sim-quality-profile', model: 'deepseek-flash', reasoningEffort: 'high', baseUrl: 'https://api.deepseek.com' },
    async getModels() { events.push('models'); return { models, endpoint: 'simulated-models', fetchedAt: 'simulated' }; },
    async complete(messages, { onRequest }) {
      const request = { model: 'deepseek-flash', messages: structuredClone(messages), max_tokens: 16384 };
      if (!omitOnRequest) { await onRequest(structuredClone(request)); events.push('request-written'); }
      await beforeNetwork(request, calls.length);
      events.push('model'); calls.push(structuredClone(messages));
      if (transportFailure) throw transportFailure;
      const value = await handler(JSON.parse(messages[1].content), calls.length);
      const content = typeof value === 'string' ? value : JSON.stringify(value);
      return alterResponse({ request, content, requestSha256: sha(JSON.stringify(request)), elapsedSeconds: 0.001,
        startedAt: 'simulated', providerResponse: { model: 'deepseek-flash',
          choices: [{ finish_reason: finishReason, message: { content } }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } } });
    } };
}
const json = async (options, name) => JSON.parse(await readFile(path.join(options.outputDirectory, name), 'utf8'));
const boundedReply = (data, desired) => {const c=teachingReviewModelContract(data.patchContract),compact=c.segmentPatchVersion===2;return {
  ...(compact?{requestId:c.requestId}:{questionId:c.questionId,candidateSha256:c.candidateSha256,sourceContentSha256:c.sourceContentSha256}),
  patches: c.allowedSegments ? c.allowedSegments.map(segment => ({ segmentId: segment.segmentId,
    ...(!compact?{oldTextSha256:segment.expectedTextSha256}:{}), newText: segment.fieldPath === 'teachingSolution' ? desired.teachingSolution : segment.expectedText })) : c.allowedFields.map(field => ({ fieldPath: field.fieldPath, oldText: field.expectedText,
    newText: field.fieldPath === 'teachingSolution' ? desired.teachingSolution : field.expectedText })), unresolvedIssues: [],
  ...(c.termFindings ? { termResolutions: c.termFindings.map(f => ({ findingId: f.findingId,
    status: 'repaired', basis: '模拟：已修改该字段对应句段，并保留相邻计算依据。' })) } : {}) };};

test('simulated combined review audits exact requests before model access and does not write input/settings', async t => {
  const options = await setup(t);
  const input = await readFile(options.inputFile, 'utf8'), settings = await readFile(options.settingsFile, 'utf8');
  const initial = draft('sim-quality', '模拟：用范数求 $\\notACommand$。\u0008');
  initial.difficultyAssessment.basis = ''; initial.issues = ['模拟材料有具体疑点。'];
  const progress = [];
  const fake = fakeClient(data => {
    if (!Object.hasOwn(data, 'rawCandidate')) return initial;
    assert.deepEqual(new Set(data.reviewFindings.map(item => item.type)), new Set(['incomplete', 'term', 'display', 'model_issue']));
    assert(data.reviewFindings.some(item => item.code === 'latex_render_failed'));
    assert.equal(data.rawCandidate, JSON.stringify(initial));
    return draft(data.originalMaterial.questionId);
  }, { beforeNetwork: async (request, index) => {
    const prefix = index ? 'review-' : '';
    const written = await json(options, `${prefix}requests/sim-quality.json`);
    assert.equal(JSON.stringify(written), JSON.stringify(request));
    assert.equal(fake.events[0], 'request-written');
    assert(!fake.events.includes('models'));
  } });
  const { summary } = await runTeachingQualityMaintenance({ ...options, clientFactory: async () => fake, reviewClientFactory: async () => fake, onProgress: value => progress.push(value) });
  assert.equal(fake.calls.length, 2); assert.equal(summary.firstDraftStructureSucceeded, 1);
  assert.equal(summary.firstDraftsNeedingReview, 1); assert.equal(summary.reviewsCompleted, 1);
  assert.equal(summary.reviewTransportCompleted, 1); assert.equal(summary.reportedUsage.total_tokens, 60);
  assert.equal(summary.generationUsage.total_tokens, 30); assert.equal(summary.reviewUsage.total_tokens, 30);
  assert.deepEqual(summary.readyCandidateQuestions, [1]); assert.deepEqual(summary.technicalFailures, []);
  assert.equal(summary.semanticApprovalInferred, false); assert.equal(summary.bankWritten, false);
  assert.equal(summary.settingsWritten, false); assert.equal(summary.personalDatabaseOpened, false);
  assert.equal(progress.length, 1); assert.equal(progress[0].completed, 1);
  assert.equal(await readFile(options.inputFile, 'utf8'), input); assert.equal(await readFile(options.settingsFile, 'utf8'), settings);
  const result = await json(options, 'results/sim-quality.json');
  assert.deepEqual(result.initialResult, initial); assert.equal(result.reviewCalls, 1); assert(result.finalResult);
  for (const prefix of ['', 'review-']) {
    const request = await json(options, `${prefix}requests/sim-quality.json`);
    const record = await json(options, `${prefix}responses/sim-quality.json`);
    assert.equal(record.requestSha256, sha(JSON.stringify(request)));
    assert.equal(record.reportedRequestSha256, record.requestSha256);
    assert.equal(typeof record.rawContent, 'string'); assert(record.ok);
  }
  for (const name of ['inputs.json', 'prompt.txt', 'review-prompt.txt', 'term-dictionary.json', 'protocol.json', 'source-hashes.json', 'summary.json']) {
    assert((await readFile(path.join(options.outputDirectory, name), 'utf8')).length);
  }
  const reviewRequest = await json(options, 'review-requests/sim-quality.json');
  assert.match(reviewRequest.messages[0].content, /一次综合定向复核/u);
  const scopedInstruction = (await readFile(new URL('../resources/teaching-quality-review-instruction.txt', import.meta.url), 'utf8')).trim();
  // Verify the shared scoped instruction reaches the actual audited transport,
  // rather than only a saved prompt or a new, unused review path. This simulated
  // test checks request wiring and preservation, not LLM compliance or math.
  assert(reviewRequest.messages[0].content.endsWith(scopedInstruction));
  for (const scope of ['表达或显示：', '方法改写：', '证明补全：', '材料核对：']) {
    assert(reviewRequest.messages[0].content.includes(scope));
  }
  assert.match(reviewRequest.messages[0].content, /若发现具体的答案或推理错误，扩大到受影响的推导/u);
  assert.match(reviewRequest.messages[0].content, /完整输出不意味着全部重写/u);
  assert.match(reviewRequest.messages[0].content, /不能为了清空 issues 隐瞒疑点/u);
  assert(!reviewRequest.messages[0].content.includes('请独立核算完整原题'));
  assert(!reviewRequest.messages[0].content.includes('再整理全部字段'));
  const transportedContext = JSON.parse(reviewRequest.messages[1].content);
  assert.deepEqual(transportedContext.originalMaterial, JSON.parse(input)[0].originalMaterial);
  assert.deepEqual(transportedContext.candidate, initial);
  assert.deepEqual(transportedContext.candidate.issues, initial.issues);
  assert(transportedContext.reviewFindings.some(finding => finding.reviewGuidanceIndex !== undefined));
  assert(transportedContext.reviewRules.some(rule => rule.guidance));
  assert(!reviewRequest.messages[0].content.includes('【材料与边界】'));
});

test('complete malformed raw JSON reaches the single review without a transport parse or retry', async t => {
  const options = await setup(t);
  const fake = fakeClient(data => {
    if (!Object.hasOwn(data, 'rawCandidate')) return '{malformed raw';
    assert.equal(data.rawCandidate, '{malformed raw'); assert.equal(data.candidate, null);
    assert(data.reviewFindings.some(item => item.code === 'invalid_candidate_json'));
    return JSON.stringify(draft(data.originalMaterial.questionId));
  });
  const { summary } = await runTeachingQualityMaintenance({ ...options, clientFactory: async () => fake, reviewClientFactory: async () => fake });
  assert.equal(fake.calls.length, 2); assert.equal(summary.firstDraftStructureSucceeded, 0);
  assert.equal(summary.reviewsCompleted, 1); assert.deepEqual(summary.technicalFailures, []);
  assert.equal(summary.initialFlags.format, 1);
  assert.equal((await json(options, 'responses/sim-quality.json')).rawContent, '{malformed raw');
  assert.equal((await json(options, 'results/sim-quality.json')).status, 'ready_candidate');
});

test('network failures and truncated output are never retried or sent for semantic review', async t => {
  for (const mode of ['network', 'truncated']) await t.test(mode, async subtest => {
    const options = await setup(subtest);
    const fake = fakeClient(data => draft(data.questionId), mode === 'network'
      ? { transportFailure: Object.assign(Error('private transport detail'), { code: 'request_timeout' }) }
      : { finishReason: 'length' });
    const { summary } = await runTeachingQualityMaintenance({ ...options, clientFactory: async () => fake, reviewClientFactory: async () => fake });
    assert.equal(fake.calls.length, 1); assert.equal(summary.reviewsTriggered, 0);
    assert.equal(summary.firstDraftStructureSucceeded, 0); assert.equal(summary.technicalFailures.length, 1);
    assert.equal(summary.failedQuestions.length, 1);
    assert.equal(summary.usageUnknownRequests, mode === 'network' ? 1 : 0);
    const result = await json(options, 'results/sim-quality.json');
    assert.equal(result.status, 'generation_failed'); assert.equal(result.initialCandidate, null); assert.equal(result.finalResult, null);
    assert.equal(result.error.code, mode === 'network' ? 'request_timeout' : 'response_incomplete');
    assert.deepEqual(await readdir(path.join(options.outputDirectory, 'review-requests')), []);
    assert(!(await readFile(path.join(options.outputDirectory, 'responses/sim-quality.json'), 'utf8')).includes('private transport detail'));
  });
});

test('remaining material and text flags are retained with one review and no adoption fallback', async t => {
  const options = await setup(t);
  const partial = draft('sim-quality', ''); partial.answer = ''; partial.issues = ['模拟缺图，无法可靠判断。'];
  const fake = fakeClient(() => partial);
  const { summary } = await runTeachingQualityMaintenance({ ...options, clientFactory: async () => fake, reviewClientFactory: async () => fake });
  assert.equal(fake.calls.length, 2); assert.equal(summary.reviewsCompleted, 1);
  assert.equal(summary.needsReviewQuestions.length, 1); assert(summary.remainingFlags.incomplete);
  assert(summary.remainingFlags.model_issue); assert.deepEqual(summary.readyCandidateQuestions, []);
  const result = await json(options, 'results/sim-quality.json');
  assert.equal(result.status, 'needs_review'); assert.equal(result.textComplete, false);
  assert.equal(result.finalResult, null); assert.deepEqual(result.candidateResult, partial);
});

test('invalid review remains a separate schema failure, not a repeated call or successful review', async t => {
  const options = await setup(t);
  const fake = fakeClient(data => (Object.hasOwn(data, 'rawCandidate')||data.patchContract) ? '{still bad' : draft(data.questionId, '模拟目标式。'));
  const { summary } = await runTeachingQualityMaintenance({ ...options, clientFactory: async () => fake, reviewClientFactory: async () => fake });
  assert.equal(fake.calls.length, 2); assert.equal(summary.reviewTransportCompleted, 1);
  assert.equal(summary.reviewsCompleted, 0); assert.equal(summary.failedQuestions.length, 1);
  assert.deepEqual(summary.technicalFailures, []);
  const result = await json(options, 'results/sim-quality.json');
  assert.equal(result.status, 'review_failed'); assert(result.initialResult); assert.equal(result.finalResult, null);
});

test('existing output is refused before client or settings access and preserves directory contents', async t => {
  const options = await setup(t);
  await assert.rejects(runTeachingQualityMaintenance({ ...options, outputDirectory: options.root,
    clientFactory: async () => assert.fail('must not open client') }), { code: 'output_directory_must_be_new' });
  assert.deepEqual((await readdir(options.root)).sort(), ['inputs.json', 'unused-settings.json']);
});

test('configured model executes directly without fetching or fabricating a catalogue', async t => {
  const options = await setup(t);
  const fake = fakeClient(data => draft(data.questionId), { models: ['different-model'] });
  fake.getModels = () => assert.fail('execution must not fetch a model list');
  const { summary } = await runTeachingQualityMaintenance({ ...options, clientFactory: async () => fake, reviewClientFactory: async () => fake });
  assert.deepEqual(fake.events, ['request-written', 'model']);
  assert.equal(fake.calls.length, 1); assert.equal(summary.modelListRequests, 0);
  assert.equal(summary.providers.generation.modelListFetched, false);
  assert.equal((await json(options, 'protocol.json')).modelSelectionSource, 'configured_model');
  assert(!(await readdir(options.outputDirectory)).includes('models-public.json'));
});

test('request body, reported exact hash and mandatory pre-network callback cannot disagree', async t => {
  for (const mode of ['hash', 'body', 'callback']) await t.test(mode, async subtest => {
    const options = await setup(subtest);
    const fake = fakeClient(data => draft(data.questionId), {
      omitOnRequest: mode === 'callback', alterResponse: response => mode === 'hash'
        ? { ...response, requestSha256: '0'.repeat(64) }
        : mode === 'body' ? { ...response, request: { ...response.request, max_tokens: 999 } } : response,
    });
    const { summary } = await runTeachingQualityMaintenance({ ...options, clientFactory: async () => fake, reviewClientFactory: async () => fake });
    assert.equal(fake.calls.length, 1); assert.equal(summary.reviewsTriggered, 0);
    assert.equal(summary.technicalFailures[0].error.code, 'request_audit_mismatch');
    assert.equal((await json(options, 'results/sim-quality.json')).finalResult, null);
  });
});

test('KaTeX validates balanced inline/display/alternate math, and missing dependency fails explicitly', () => {
  const validate = createTeachingMathDisplayValidator();
  assert.deepEqual(validate(draft('sim', String.raw`模拟 $\frac{1}{2}$ 与 $$x^2$$，\(x+1\) 和 \[y^2\]。`)).findings, []);
  const result = draft('sim', String.raw`模拟 $\notACommand$，$$\frac{1}$$。`);
  const found = validate(result).findings;
  assert.equal(found.length, 2); assert(found.every(item => item.code === 'latex_render_failed' && item.fieldPath === 'teachingSolution'));
  assert.throws(() => createTeachingMathDisplayValidator(() => { throw Error('missing module'); }), { code: 'katex_initialization_failed' });
  assert.throws(() => createTeachingMathDisplayValidator(() => ({})), { code: 'katex_initialization_failed' });
});

test('invalid concurrency is rejected before creating an output or opening a client', async t => {
  const options = await setup(t);
  for (const concurrency of [0, 5, 1.5]) await assert.rejects(runTeachingQualityMaintenance({ ...options, concurrency,
    clientFactory: async () => assert.fail() }), { code: 'invalid_maintenance_options' });
  assert.deepEqual((await readdir(options.root)).sort(), ['inputs.json', 'unused-settings.json']);
});


test('explicit methods reach both final transport system messages and audit artifacts', async t => {
  const options = await setup(t);
  const refs = await loadTeachingMethodReferences(['algebra']);
  const fake = fakeClient(data => (Object.hasOwn(data, 'rawCandidate')||data.patchContract)
    ? boundedReply(data, draft(data.originalMaterial.questionId)) : draft(data.questionId, '模拟目标式。'), {
    beforeNetwork: async request => {
      assert(request.messages[0].content.includes(refs[0].text));
      assert.match(request.messages[0].content, /【本次附加的方法参考】/u);
    },
  });
  const { summary } = await runTeachingQualityMaintenance({ ...options, methodReferences: ['algebra'], clientFactory: async () => fake, reviewClientFactory: async () => fake });
  assert.deepEqual(summary.readyCandidateQuestions, [1]);
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(await json(options, 'method-references.json'), refs);
  const protocol = await json(options, 'protocol.json');
  assert.deepEqual(protocol.methodReferenceIds, ['algebra']);
  assert.equal(protocol.methodReferencesSha256, sha(JSON.stringify(refs)));
  assert((await json(options, 'source-hashes.json')).some(entry => entry.file.endsWith('/teaching-method-reference.mjs')));
  for (const prefix of ['', 'review-']) {
    assert((await json(options, `${prefix}requests/sim-quality.json`)).messages[0].content.includes(refs[0].text));
  }
});

test('empty methods retain only base plus same-generation quality contract; invalid ids fail before client access', async t => {
  const options = await setup(t);
  const fake = fakeClient(data => (Object.hasOwn(data, 'rawCandidate')||data.patchContract)
    ? boundedReply(data, draft(data.originalMaterial.questionId)) : draft(data.questionId, '模拟目标式。'));
  await runTeachingQualityMaintenance({ ...options, clientFactory: async () => fake, reviewClientFactory: async () => fake });
  const doc = await readFile(new URL('../../docs/design/math-teaching-analysis-prompt.md', import.meta.url), 'utf8');
  const qualityInstruction = await readFile(new URL('../resources/teaching-quality-signals-instruction.txt', import.meta.url), 'utf8');
  assert.equal(fake.calls[0][0].content, `${extractTeachingPrompt(doc, 'teaching-prompt')}\n\n${qualityInstruction}`);
  assert(!fake.calls[0][0].content.includes('【本次附加的方法参考】'));
  const reviewInstruction = (await readFile(new URL('../resources/teaching-sentence-review-instruction.txt', import.meta.url), 'utf8')).trim();
  assert.equal(fake.calls[1][0].content, reviewInstruction);
  const actualContext = JSON.parse(fake.calls[1][1].content);
  assert.deepEqual(actualContext.patchContract.allowedSegments.map(field => field.fieldPath), ['teachingSolution']);
  assert.equal((await json(options, 'results/sim-quality.json')).reviewMode, 'bounded_patch');
  assert.deepEqual(await json(options, 'method-references.json'), []);
  assert.deepEqual((await json(options, 'protocol.json')).methodReferenceIds, []);
  const invalid = await setup(t);
  await assert.rejects(runTeachingQualityMaintenance({ ...invalid, methodReferences: ['unknown'],
    clientFactory: async () => assert.fail('no catalogue or model access') }), { code: 'invalid_method_reference_ids' });
  assert.deepEqual((await readdir(invalid.root)).sort(), ['inputs.json', 'unused-settings.json']);
});
