// Explicit, user-authorized offline experiment. Never opens a database or writes settings.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { openQwenMaintenanceClient } from './lib/qwen-maintenance-client.mjs';
import { openDeepSeekMaintenanceClient } from './lib/deepseek-maintenance-client.mjs';
import { compactTeachingReviewContext } from './lib/teaching-review-context.mjs';
import { assessTeachingCandidate } from './lib/teaching-quality-pipeline.mjs';
import { createTeachingMathDisplayValidator } from './lib/teaching-quality-maintenance.mjs';
import { extractTeachingPrompt } from './lib/teaching-term-maintenance.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const sha = text => createHash('sha256').update(text).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const safeCode = error => /^[a-z][a-z0-9_]{0,79}$/u.test(error?.code ?? '') ? error.code : 'scoped_maintenance_failed';
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;

/** Sorted object keys; arrays retain order; compact UTF-8 JSON. Not a source-file hash. */
export const canonicalSha256 = value => sha(JSON.stringify(sorted(value)));

/** Rejects the entire manifest before credential discovery or model HTTP. */
export function validateScopedManifest(manifest) {
  if (!manifest || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/u.test(manifest.operationId ?? '')
    || typeof manifest.settingsFile !== 'string' || !path.isAbsolute(manifest.settingsFile)
    || !Array.isArray(manifest.entries) || !manifest.entries.length || manifest.entries.length > 100
    || !Array.isArray(manifest.protectedQuestionIds) || manifest.protectedQuestionIds.some(id => typeof id !== 'string' || !id)
    || new Set(manifest.protectedQuestionIds).size !== manifest.protectedQuestionIds.length) throw fail('invalid_scoped_manifest');
  const ids = new Set(), protectedIds = new Set(manifest.protectedQuestionIds);
  for (const entry of manifest.entries) {
    const id = entry?.questionId;
    if (typeof id !== 'string' || !id || ids.has(id) || protectedIds.has(id)) throw fail('duplicate_or_protected_question');
    ids.add(id);
    if (!['review', 'generation'].includes(entry.kind) || !Number.isInteger(entry.paperIndex) || entry.paperIndex < 1
      || !Number.isInteger(entry.questionNumber) || entry.questionNumber < 1
      || !Number.isInteger(entry.priorReviewCalls) || entry.priorReviewCalls < 0
      || !entry.originalMaterial || entry.originalMaterial.questionId !== id
      || !Array.isArray(entry.reviewFindings)
      || (entry.explicitAuditFindings !== undefined && !Array.isArray(entry.explicitAuditFindings))) throw fail('invalid_scoped_entry');
    if (entry.sourceQuestionSha256 !== canonicalSha256(entry.originalMaterial)) throw fail('source_question_hash_mismatch');
    if (entry.kind === 'review') {
      if (!entry.candidate || entry.candidate.questionId !== id || entry.candidateSha256 !== canonicalSha256(entry.candidate)) throw fail('candidate_identity_or_hash_mismatch');
      if (!entry.reviewFindings.length && !entry.explicitAuditFindings?.length) throw fail('review_requires_explicit_issue');
    } else if (entry.candidate !== null || entry.candidateSha256 !== null) throw fail('generation_requires_no_candidate');
  }
  return structuredClone(manifest);
}

function redactReasoning(value) {
  if (Array.isArray(value)) return value.map(redactReasoning);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['reasoning_content', 'reasoning', 'apiKey', 'protectedKey', 'Authorization', 'authorization'].includes(key))
    .map(([key, item]) => [key, redactReasoning(item)]));
}

export async function runScopedTeachingReview({ manifestFile, outputDirectory, concurrency = 3,
  reviewClientFactory = openQwenMaintenanceClient, generationClientFactory = openDeepSeekMaintenanceClient,
  validateDisplay = createTeachingMathDisplayValidator(), onProgress = () => {} } = {}) {
  if (typeof manifestFile !== 'string' || typeof outputDirectory !== 'string' || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw fail('invalid_scoped_options');
  const inputText = await readFile(manifestFile, 'utf8');
  const manifest = validateScopedManifest(JSON.parse(inputText));
  const out = path.resolve(outputDirectory);
  try { await mkdir(out); } catch { throw fail('output_directory_must_be_new'); }
  const save = (name, value) => writeFile(path.join(out, name), JSON.stringify(value, null, 2), { flag: 'wx' });
  const reviewPrompt = (await readFile(path.join(repoRoot, 'scripts/resources/teaching-quality-review-instruction.txt'), 'utf8')).trim();
  const mainDocument = await readFile(path.join(repoRoot, 'docs/design/math-teaching-analysis-prompt.md'), 'utf8');
  const generationPrompt = extractTeachingPrompt(mainDocument, 'teaching-prompt');
  await save('manifest.json', manifest);
  await writeFile(path.join(out, 'review-prompt.txt'), reviewPrompt, { flag: 'wx' });
  await writeFile(path.join(out, 'generation-prompt.txt'), generationPrompt, { flag: 'wx' });
  await save('protocol.json', { operationId: manifest.operationId, startedAt: new Date().toISOString(),
    manifestFileSha256: sha(inputText), manifestCanonicalSha256: canonicalSha256(manifest), concurrency,
    reviewPromptSha256: sha(reviewPrompt), generationPromptSha256: sha(generationPrompt),
    maxTokens: 16384, timeoutMs: 300000, stream: false, enableThinking: true,
    maxAdditionalReviewCallsPerQuestion: 1, automaticRetries: 0, methodReferences: [],
    sourceHashDefinition: 'canonicalSha256(originalMaterial); sorted object keys, unchanged array order, compact UTF-8 JSON',
    priorReviewCallsReset: false, candidatePublication: false, databaseOpened: false, settingsWritten: false,
    independentAuditScopeIsNotRuleFinding: true });
  let pendingReviewer, pendingGenerator;
  const getClient = kind => {
    const open = async () => {
      const client = kind === 'review'
        ? await reviewClientFactory({ settingsFile: manifest.settingsFile, agentEnvFile: path.join(out, '__disabled_agent_env_fallback__'), timeoutMs: 300000 })
        : await generationClientFactory({ settingsFile: manifest.settingsFile, timeoutMs: 300000 });
      if (kind === 'review' && client.publicProfile.credentialSource === 'explicit_offline_agent_env') throw fail('saved_profile_required');
      await save(`${kind}-profile-public.json`, client.publicProfile);
      const catalogue = await client.getModels();
      await save(`${kind}-models-public.json`, catalogue);
      if (!Array.isArray(catalogue.models) || !catalogue.models.includes(client.publicProfile.model)) throw fail('requested_model_not_in_provider_catalogue');
      return client;
    };
    if (kind === 'review') return pendingReviewer ??= open();
    return pendingGenerator ??= open();
  };
  let cursor = 0, completed = 0;
  const results = [];
  const worker = async () => {
    while (cursor < manifest.entries.length) {
      const entry = manifest.entries[cursor++];
      const stem = sha(entry.questionId).slice(0, 24);
      await mkdir(path.join(out, stem));
      const write = (name, value) => save(`${stem}/${name}`, value);
      await write('input.json', entry);
      const result = { operationId: manifest.operationId, questionId: entry.questionId, paperIndex: entry.paperIndex,
        questionNumber: entry.questionNumber, kind: entry.kind, sourceQuestionSha256: entry.sourceQuestionSha256,
        beforeCandidateSha256: entry.candidateSha256, previousReviewCalls: entry.priorReviewCalls,
        additionalReviewCalls: 0, totalReviewCallsObserved: entry.priorReviewCalls,
        generationCalls: 0, startedAt: new Date().toISOString(), calls: [], candidate: null,
        findings: [], textComplete: false, status: 'review_failed', error: null, databaseOpened: false };
      const started = performance.now();
      const invoke = async (kind, data) => {
        const client = await getClient(kind);
        const record = { kind, startedAt: new Date().toISOString(), requestWritten: false, elapsedSeconds: null, error: null };
        result.calls.push(record);
        const callStart = performance.now();
        try {
          const response = await client.complete([{ role: 'system', content: kind === 'review' ? reviewPrompt : generationPrompt },
            { role: 'user', content: JSON.stringify(kind === 'review' ? compactTeachingReviewContext(data) : data) }],
          { maxTokens: 16384, onRequest: async request => {
            if (record.requestWritten) throw fail('request_audit_repeated');
            await write(`${kind}.request.json`, request);
            record.requestWritten = true;
            record.requestSha256 = sha(JSON.stringify(request));
            record.requestBytes = Buffer.byteLength(JSON.stringify(request));
          } });
          if (!record.requestWritten || response.requestSha256 !== record.requestSha256
            || sha(JSON.stringify(response.request)) !== record.requestSha256) throw fail('request_audit_mismatch');
          record.elapsedSeconds = response.elapsedSeconds;
          record.usage = response.providerResponse?.usage ?? null;
          record.finishReason = response.providerResponse?.choices?.[0]?.finish_reason ?? null;
          await write(`${kind}.provider-response.json`, redactReasoning(response.providerResponse));
          if (record.finishReason !== 'stop') throw fail('response_incomplete');
          if (typeof response.content !== 'string') throw fail('content_missing');
          return response.content;
        } catch (error) {
          record.error = { code: safeCode(error) };
          throw error;
        } finally {
          record.elapsedSeconds ??= (performance.now() - callStart) / 1000;
          await write(`${kind}.call.json`, record);
        }
      };
      try {
        let candidate = entry.candidate;
        let findings = structuredClone(entry.reviewFindings);
        if (entry.kind === 'generation') {
          result.generationCalls = 1;
          const generated = await invoke('generation', entry.originalMaterial);
          await write('generation.raw-content.json', generated);
          const checked = await assessTeachingCandidate(generated, entry.questionId, validateDisplay);
          result.generationAssessment = checked;
          candidate = checked.candidateResult;
          findings = checked.findings;
          if (!findings.length) {
            Object.assign(result, { candidate, textComplete: checked.textComplete, status: 'ready_candidate' });
          } else {
            result.additionalReviewCalls = 1; result.totalReviewCallsObserved++;
            const revised = await invoke('review', { originalMaterial: entry.originalMaterial, candidate, rawCandidate: generated,
              reviewFindings: findings, explicitAuditFindings: entry.explicitAuditFindings ?? [], imageReviewAvailable: false });
            const reviewed = await assessTeachingCandidate(revised, entry.questionId, validateDisplay);
            Object.assign(result, { candidate: reviewed.candidateResult, findings: reviewed.findings, textComplete: reviewed.textComplete,
              status: reviewed.error ? 'review_failed' : reviewed.findings.length ? 'needs_review' : 'ready_candidate', error: reviewed.error });
          }
        } else {
          result.additionalReviewCalls = 1; result.totalReviewCallsObserved++;
          const revised = await invoke('review', { originalMaterial: entry.originalMaterial, candidate,
            rawCandidate: candidate, reviewFindings: findings, explicitAuditFindings: entry.explicitAuditFindings ?? [], imageReviewAvailable: false });
          const reviewed = await assessTeachingCandidate(revised, entry.questionId, validateDisplay);
          Object.assign(result, { candidate: reviewed.candidateResult, findings: reviewed.findings, textComplete: reviewed.textComplete,
            status: reviewed.error ? 'review_failed' : reviewed.findings.length ? 'needs_review' : 'ready_candidate', error: reviewed.error });
        }
      } catch (error) {
        result.status = entry.kind === 'generation' && result.additionalReviewCalls === 0 ? 'generation_failed' : 'review_failed';
        result.error = { code: safeCode(error) };
        result.candidate = null;
      }
      result.elapsedSeconds = (performance.now() - started) / 1000;
      result.finishedAt = new Date().toISOString();
      result.candidateSha256 = result.candidate === null ? null : canonicalSha256(result.candidate);
      await write('result.json', result);
      results.push(result); completed++;
      await onProgress({ completed, targetCount: manifest.entries.length, questionId: entry.questionId,
        paperIndex: entry.paperIndex, questionNumber: entry.questionNumber, status: result.status,
        seconds: Math.round(result.elapsedSeconds * 1000) / 1000, directory: stem });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, manifest.entries.length) }, worker));
  results.sort((a, b) => a.paperIndex - b.paperIndex || a.questionNumber - b.questionNumber);
  const summary = { operationId: manifest.operationId, completed: results.length, targetCount: manifest.entries.length,
    totalAdditionalReviewCalls: results.reduce((n, r) => n + r.additionalReviewCalls, 0),
    totalGenerationCalls: results.reduce((n, r) => n + r.generationCalls, 0),
    statuses: Object.fromEntries([...new Set(results.map(r => r.status))].map(status => [status, results.filter(r => r.status === status).length])),
    protectedQuestionIds: manifest.protectedQuestionIds, candidatePublication: false, databaseOpened: false, settingsWritten: false,
    finishedAt: new Date().toISOString() };
  await save('current-results.json', { results, summary });
  await save('summary.json', summary);
  return { results, summary };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--manifest' || args[2] !== '--output-dir') throw fail('usage_manifest_output_dir');
    const { summary } = await runScopedTeachingReview({ manifestFile: args[1], outputDirectory: args[3],
      onProgress: progress => process.stdout.write(JSON.stringify(progress) + '\n') });
    process.stdout.write(JSON.stringify(summary) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ code: safeCode(error) }) + '\n');
    process.exitCode = 1;
  }
}
