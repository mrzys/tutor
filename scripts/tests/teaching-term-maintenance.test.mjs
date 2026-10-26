import { loadTeachingMethodReferences } from '../lib/teaching-method-reference.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runTeachingTermMaintenance, normalizeTeachingInputs, extractTeachingPrompt } from '../lib/teaching-term-maintenance.mjs';

const draft = (id, text) => ({ questionId: id, answer: '2', difficultyAssessment: { level: 'easy', basis: '模拟回归：直接代入。' }, teachingSolution: text, teachingFocusSchemaVersion: 2, teachingFocus: { examFocus: '模拟代入。', studentRequirements: ['能代入。'] }, issues: [] });
async function setup(t, ids = ['sim-clean', 'sim-hit']) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tutor-term-maintenance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputFile = path.join(root, 'input.json');
  await writeFile(inputFile, JSON.stringify(ids.map((id, i) => ({ sampleNumber: i + 1, questionId: id, payload: { questionId: id, student: { stem: '模拟题，原材料可含范数。' } } }))));
  return { root, inputFile, outputDirectory: path.join(root, 'out'), settingsFile: path.join(root, 'unused.json') };
}
function client(handler, models = ['deepseek-flash'], finishReason = 'stop') {
  const calls = [];
  return { calls, publicProfile: { id: 'sim-profile', model: 'deepseek-flash', reasoningEffort: 'high', baseUrl: 'https://api.deepseek.com' },
    getModels: async () => ({ models, endpoint: 'simulated-models', fetchedAt: 'simulated' }),
    complete: async (messages, options) => {
      const request = { model: 'deepseek-flash', messages, max_tokens: 16384 };
      await options.onRequest(structuredClone(request));
      calls.push(structuredClone(messages));
      const data = JSON.parse(messages[1].content), result = handler(data);
      const content = typeof result === 'string' ? result : JSON.stringify(result);
      return { request, content, requestSha256: createHash('sha256').update(JSON.stringify(request)).digest('hex'), elapsedSeconds: 0.001, startedAt: 'simulated', providerResponse: { model: 'deepseek-flash', choices: [{ finish_reason: finishReason, message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } } };
    } };
}

test('real maintenance orchestrator performs N+H calls, audits requests/scans and leaves source intact (simulated transport)', async t => {
  const options = await setup(t), original = await readFile(options.inputFile, 'utf8');
  const fake = client(data => data.candidateDraft ? draft(data.originalMaterial.questionId, '所求式子为2。') : draft(data.questionId, data.questionId === 'sim-hit' ? '目标式为2。' : '所求式子为2。'));
  const { summary } = await runTeachingTermMaintenance({ ...options, clientFactory: async () => fake, reviewClientFactory: async () => fake });
  assert.equal(fake.calls.length, 3); assert.equal(summary.reviewsTriggered, 1); assert.equal(summary.chatRequests, 3);
  assert.deepEqual(summary.noTermHitQuestions, [1]); assert.deepEqual(summary.rewrittenNoTermHitQuestions, [2]);
  assert.equal(summary.reportedUsage.total_tokens, 90); assert.equal(summary.semanticApprovalInferred, false);
  assert.equal(await readFile(options.inputFile, 'utf8'), original);
  const results = JSON.parse(await readFile(path.join(options.outputDirectory, 'results.json'), 'utf8'));
  assert(results[1].initialScan.findings.some(f => f.term === '目标式'));
  assert.deepEqual(JSON.parse(fake.calls[2][1].content).termFindings, results[1].initialScan.findings);
  assert(!fake.calls[2][0].content.includes('【材料与边界】'), 'review must not repeat full generation prompt');
  assert((await readdir(path.join(options.outputDirectory, 'review-requests'))).length === 1);
});

test('real model catalogue omission blocks chat; no static available-model fallback', async t => {
  const options = await setup(t); const fake = client(() => assert.fail(), ['other']);
  await assert.rejects(runTeachingTermMaintenance({ ...options, clientFactory: async () => fake, reviewClientFactory: async () => fake }), { code: 'requested_model_not_in_provider_catalogue' });
  assert.equal(fake.calls.length, 0); assert.equal(JSON.parse(await readFile(path.join(options.outputDirectory, 'failure.json'), 'utf8')).code, 'requested_model_not_in_provider_catalogue');
});

test('existing destination is refused before credentials/client access', async t => {
  const options = await setup(t); options.outputDirectory = options.root;
  await assert.rejects(runTeachingTermMaintenance({ ...options, clientFactory: async () => assert.fail() }), { code: 'output_directory_must_be_new' });
});

test('bad review identity preserves original raw response without promoting it as final', async t => {
  const options = await setup(t, ['sim-hit']);
  const fake = client(data => data.candidateDraft ? draft('wrong-question', '所求式子为2。') : draft(data.questionId, '目标式为2。'));
  const { summary } = await runTeachingTermMaintenance({ ...options, clientFactory: async () => fake, reviewClientFactory: async () => fake });
  assert.equal(summary.failedQuestions.length, 1);
  const [result] = JSON.parse(await readFile(path.join(options.outputDirectory, 'results.json'), 'utf8'));
  assert.equal(result.status, 'review_failed'); assert(result.initialResult); assert.equal(result.finalResult, null);
  const raw = JSON.parse(await readFile(path.join(options.outputDirectory, 'review-responses/sim-hit.json'), 'utf8'));
  assert.equal(JSON.parse(raw.providerResponse.choices[0].message.content).questionId, 'wrong-question');
});

test('input identities cannot escape output folders or silently duplicate; prompt markers are unique', () => {
  const [item] = normalizeTeachingInputs([{ questionId: '../outside', payload: { questionId: '../outside' } }]);
  assert.match(item.fileStem, /^question-[a-f0-9]{64}$/);
  assert.throws(() => normalizeTeachingInputs([{ questionId: 'a', payload: { questionId: 'a' } }, { questionId: 'a', payload: { questionId: 'a' } }]));
  assert.throws(() => normalizeTeachingInputs([{ questionId: 'a', payload: { questionId: 'b' } }]));
  assert.throws(() => normalizeTeachingInputs([{ questionId: 'A', payload: { questionId: 'A' } }, { questionId: 'a', payload: { questionId: 'a' } }]), { code: 'input_filename_collision' });
  assert.match(normalizeTeachingInputs([{ questionId: 'q.', payload: { questionId: 'q.' } }])[0].fileStem, /^question-[a-f0-9]{64}$/);
  const block = '<!-- teaching-prompt-start -->\n```text\ntask\n```\n<!-- teaching-prompt-end -->';
  assert.equal(extractTeachingPrompt(block, 'teaching-prompt'), 'task');
  assert.throws(() => extractTeachingPrompt(block + block, 'teaching-prompt'));
});

test('explicit format recovery performs one semantic review, preserving malformed raw output and separate stage counts', async t => {
  const options = await setup(t, ['sim-bad-json']);
  const fake = client(data => Object.hasOwn(data, 'rawCandidate') ? draft(data.originalMaterial.questionId, '由题意得 $1+1=2$。') : '{broken JSON');
  const { summary } = await runTeachingTermMaintenance({ ...options, recoverFormat: true, clientFactory: async () => fake, reviewClientFactory: async () => fake });
  assert.equal(fake.calls.length, 2); assert.equal(summary.generated, 0); assert.equal(summary.formatReviewsTriggered, 1);
  assert.equal(summary.formatReviewsCompleted, 1); assert.equal(summary.reviewsTriggered, 0); assert.equal(summary.failedQuestions.length, 0);
  assert.deepEqual(summary.formatRecoveredNoKnownFlagsQuestions, [1]); assert.equal(summary.formatReviewUsage.total_tokens, 30);
  const [entry] = JSON.parse(await readFile(path.join(options.outputDirectory, 'results.json'), 'utf8'));
  assert.equal(entry.status, 'reviewed_no_known_flags'); assert.equal(entry.generationStatus, 'generation_failed');
  assert.equal(entry.formatRecovery.originalCandidate, '{broken JSON'); assert(entry.finalResult);
  const request = JSON.parse(await readFile(path.join(options.outputDirectory, 'format-review-requests/sim-bad-json.json'), 'utf8'));
  assert.equal(JSON.parse(request.messages[1].content).rawCandidate, '{broken JSON');
  assert.match(request.messages[0].content, /独立核算原题/u);
});

test('schema failure can recover but residual terms are marked with no third call', async t => {
  const options = await setup(t, ['sim-bad-schema']);
  const fake = client(data => Object.hasOwn(data, 'rawCandidate') ? draft(data.originalMaterial.questionId, '使用范数。') : { ...draft(data.questionId, '第一稿。'), basisNote: '' });
  const { summary } = await runTeachingTermMaintenance({ ...options, recoverFormat: true, clientFactory: async () => fake, reviewClientFactory: async () => fake });
  assert.equal(fake.calls.length, 2); assert.equal(summary.formatReviewsCompleted, 1); assert.equal(summary.reviewsTriggered, 0);
  assert.deepEqual(summary.remainingTermHitQuestions, [1]); assert.equal(summary.needsReviewQuestions.length, 1);
  const [entry] = JSON.parse(await readFile(path.join(options.outputDirectory, 'results.json'), 'utf8'));
  assert.equal(entry.status, 'needs_review'); assert.equal(entry.finalResult, null); assert(entry.recoveredResult);
  assert(entry.needsReviewReasons.some(x => x.code === 'remaining_term_hits'));
});

test('format review that remains malformed does not loop and keeps both raw responses', async t => {
  const options = await setup(t, ['sim-still-bad']); const fake = client(() => '{broken JSON');
  const { summary } = await runTeachingTermMaintenance({ ...options, recoverFormat: true, clientFactory: async () => fake, reviewClientFactory: async () => fake });
  assert.equal(fake.calls.length, 2); assert.equal(summary.formatReviewsCompleted, 0); assert.equal(summary.failedQuestions.length, 1);
  const [entry] = JSON.parse(await readFile(path.join(options.outputDirectory, 'results.json'), 'utf8'));
  assert.equal(entry.status, 'recovery_failed'); assert.equal(entry.finalResult, null);
  const raw = JSON.parse(await readFile(path.join(options.outputDirectory, 'format-review-responses/sim-still-bad.json'), 'utf8'));
  assert.equal(raw.rawContent, '{broken JSON');
});

test('recovery remains opt-in and never retries truncated generation or failed term review', async t => {
  for (const mode of ['disabled', 'truncated', 'term-review']) {
    await t.test(mode, async subtest => {
      const options = await setup(subtest, ['sim-failure']);
      const fake = client(data => mode === 'term-review' && !data.candidateDraft ? draft(data.questionId, '目标式为2。') : '{bad', ['deepseek-flash'], mode === 'truncated' ? 'length' : 'stop');
      const { summary } = await runTeachingTermMaintenance({ ...options, recoverFormat: mode !== 'disabled', clientFactory: async () => fake, reviewClientFactory: async () => fake });
      assert.equal(summary.formatReviewsTriggered, 0); assert.equal(fake.calls.length, mode === 'term-review' ? 2 : 1);
      assert.equal(summary.failedQuestions.length, 1);
    });
  }
});

test('network failure has no raw candidate and never triggers format review', async t => {
  const options = await setup(t, ['sim-network']); const fake = client(() => assert.fail()); let calls = 0;
  fake.complete = async () => { calls++; throw Object.assign(Error('never publish network detail'), { code: 'request_timeout' }); };
  const { summary } = await runTeachingTermMaintenance({ ...options, recoverFormat: true, clientFactory: async () => fake, reviewClientFactory: async () => fake });
  assert.equal(calls, 1); assert.equal(summary.formatReviewsTriggered, 0); assert.equal(summary.failedQuestions.length, 1);
});


test('explicit methods reach generation, term review and format review transport bodies', async t => {
  const refs = await loadTeachingMethodReferences(['algebra']);
  for (const mode of ['term', 'format']) await t.test(mode, async subtest => {
    const options = await setup(subtest, ['sim-method']);
    const fake = client(data => data.candidateDraft || Object.hasOwn(data, 'rawCandidate')
      ? draft(data.originalMaterial.questionId, '由题意计算。')
      : mode === 'format' ? '{broken' : draft(data.questionId, '模拟目标式。'));
    const originalComplete = fake.complete;
    fake.complete = async (messages, opts) => {
      assert(messages[0].content.includes(refs[0].text));
      return originalComplete(messages, opts);
    };
    await runTeachingTermMaintenance({ ...options, methodReferences: ['algebra'], recoverFormat: mode === 'format', clientFactory: async () => fake, reviewClientFactory: async () => fake });
    assert.equal(fake.calls.length, 2);
    const protocol = JSON.parse(await readFile(path.join(options.outputDirectory, 'protocol.json'), 'utf8'));
    assert.deepEqual(protocol.methodReferenceIds, ['algebra']);
    assert.equal(protocol.optionalEightBlockHintsIncluded, true);
    assert.deepEqual(JSON.parse(await readFile(path.join(options.outputDirectory, 'method-references.json'), 'utf8')), refs);
    assert.equal(protocol.methodReferencesSha256, createHash('sha256').update(JSON.stringify(refs)).digest('hex'));
    for (const prefix of ['', mode === 'format' ? 'format-review-' : 'review-']) {
      const body = JSON.parse(await readFile(path.join(options.outputDirectory, `${prefix}requests/sim-method.json`), 'utf8'));
      assert(body.messages[0].content.includes(refs[0].text));
    }
  });
});

test('empty method selection preserves all system prompts; unknown ids rejected before transport', async t => {
  const options = await setup(t, ['sim-default']);
  const fake = client(data => data.candidateDraft ? draft(data.originalMaterial.questionId, '由题意计算。') : draft(data.questionId, '模拟目标式。'));
  await runTeachingTermMaintenance({ ...options, recoverFormat: true, clientFactory: async () => fake, reviewClientFactory: async () => fake });
  const doc = await readFile(new URL('../../docs/design/math-teaching-analysis-prompt.md', import.meta.url), 'utf8');
  const generic = extractTeachingPrompt(doc, 'teaching-review');
  const term = (await readFile(new URL('../resources/teaching-term-review-instruction.txt', import.meta.url), 'utf8')).trim();
  const format = (await readFile(new URL('../resources/teaching-format-review-instruction.txt', import.meta.url), 'utf8')).trim();
  assert.equal(fake.calls[0][0].content, extractTeachingPrompt(doc, 'teaching-prompt'));
  assert.equal(fake.calls[1][0].content, `${generic}\n\n${term}`);
  assert.equal(await readFile(path.join(options.outputDirectory, 'format-review-prompt.txt'), 'utf8'), `${generic}\n\n${format}`);
  assert.deepEqual(JSON.parse(await readFile(path.join(options.outputDirectory, 'method-references.json'), 'utf8')), []);
  const invalid = await setup(t);
  await assert.rejects(runTeachingTermMaintenance({ ...invalid, methodReferences: ['unknown'],
    clientFactory: async () => assert.fail('must not access models') }), { code: 'invalid_method_reference_ids' });
  assert.deepEqual(await readdir(invalid.root), ['input.json']);
});
