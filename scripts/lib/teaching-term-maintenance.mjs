import { createMaintenanceReviewRouting, plannedReviewProfile, maintenanceProviderSummary } from './teaching-review-routing.mjs';
import { openQwenMaintenanceClient } from './qwen-maintenance-client.mjs';
import { loadTeachingMethodReferences, appendTeachingMethodReferences } from './teaching-method-reference.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runTeachingTermPipeline, validateTeachingResult } from './teaching-term-pipeline.mjs';
import { teachingTermDictionarySnapshot } from './teaching-term-scan.mjs';
import { openDeepSeekMaintenanceClient } from './deepseek-maintenance-client.mjs';
import { runTeachingFormatRecovery } from './teaching-format-recovery.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const hash = v => createHash('sha256').update(v).digest('hex');
const error = code => Object.assign(new Error(code), { code });
const safeCode = e => typeof e?.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(e.code) ? e.code : 'maintenance_failed';
const recoverableFormatCodes = new Set(['model_content_invalid_json', 'invalid_result_identity_or_schema', 'invalid_result_text', 'invalid_difficulty_schema', 'invalid_teaching_focus', 'incomplete_result_without_explanation']);
export function extractTeachingPrompt(document, marker) {
  if (!['teaching-prompt', 'teaching-review'].includes(marker)) throw error('invalid_prompt_marker');
  const expression = new RegExp(`<!-- ${marker}-start -->\\s*\x60\x60\x60text\\s*([\\s\\S]*?)\\s*\x60\x60\x60\\s*<!-- ${marker}-end -->`, 'g');
  const matches = [...document.matchAll(expression)];
  if (matches.length !== 1) throw error('prompt_marker_not_unique');
  return matches[0][1];
}
export function normalizeTeachingInputs(value) {
  if (!Array.isArray(value) || !value.length || value.length > 10_000) throw error('invalid_input_batch');
  const ids = new Set();
  const fileNames = new Set();
  return value.map((item, index) => {
    const material = item?.originalMaterial ?? item?.payload;
    const id = item?.questionId;
    if (typeof id !== 'string' || !id.trim() || ids.has(id) || !material || typeof material !== 'object' || Array.isArray(material) || material.questionId !== id) throw error('invalid_input_identity');
    ids.add(id);
    const safeName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}$/.test(id) && !id.endsWith('.') && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id) ? id : `question-${hash(id)}`;
    if (fileNames.has(safeName.toLowerCase())) throw error('input_filename_collision');
    fileNames.add(safeName.toLowerCase());
    return { questionId: id, sampleNumber: item.sampleNumber ?? index + 1, fileStem: safeName, originalMaterial: structuredClone(material) };
  });
}

/** Offline only: reads explicit input/settings files; never opens any database. */
export async function runTeachingTermMaintenance({ inputFile, outputDirectory, settingsFile, concurrency = 3, methodReferences = [],
  recoverFormat = false, clientFactory = openDeepSeekMaintenanceClient, reviewClientFactory = openQwenMaintenanceClient, agentEnvFile, onProgress = () => {} }) {
  if (![inputFile, outputDirectory, settingsFile].every(s => typeof s === 'string' && s) || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4 || typeof recoverFormat !== 'boolean' || typeof clientFactory !== 'function' || typeof reviewClientFactory !== 'function') throw error('invalid_maintenance_options');
  const references = await loadTeachingMethodReferences(methodReferences);
  const rows = normalizeTeachingInputs(JSON.parse(await readFile(inputFile, 'utf8')));
  const document = await readFile(path.join(repoRoot, 'docs/design/math-teaching-analysis-prompt.md'), 'utf8');
  const mainPrompt = appendTeachingMethodReferences(extractTeachingPrompt(document, 'teaching-prompt'), references);
  const genericReview = extractTeachingPrompt(document, 'teaching-review');
  const termInstruction = (await readFile(path.join(repoRoot, 'scripts/resources/teaching-term-review-instruction.txt'), 'utf8')).trim();
  const reviewPrompt = appendTeachingMethodReferences(`${genericReview}\n\n${termInstruction}`, references);
  const formatReviewPrompt = recoverFormat ? appendTeachingMethodReferences(`${genericReview}\n\n${(await readFile(path.join(repoRoot, 'scripts/resources/teaching-format-review-instruction.txt'), 'utf8')).trim()}`, references) : null;
  const dictionary = teachingTermDictionarySnapshot();
  const out = path.resolve(outputDirectory);
  try { await mkdir(out); } catch { throw error('output_directory_must_be_new'); }
  const save = (name, data) => writeFile(path.join(out, name), JSON.stringify(data, null, 2), { flag: 'wx' });
  for (const folder of ['requests', 'responses', 'review-requests', 'review-responses', 'pipelines', 'scans']) await mkdir(path.join(out, folder));
  if (recoverFormat) for (const folder of ['format-review-requests', 'format-review-responses']) await mkdir(path.join(out, folder));
  await save('inputs.json', rows);
  await save('method-references.json', references);
  await writeFile(path.join(out, 'prompt.txt'), mainPrompt, { flag: 'wx' });
  await writeFile(path.join(out, 'review-prompt.txt'), reviewPrompt, { flag: 'wx' });
  if (recoverFormat) await writeFile(path.join(out, 'format-review-prompt.txt'), formatReviewPrompt, { flag: 'wx' });
  await save('term-dictionary.json', dictionary);
  const modules = ['teaching-method-reference.mjs', 'teaching-term-maintenance.mjs', 'teaching-term-pipeline.mjs', 'teaching-term-scan.mjs', 'deepseek-maintenance-client.mjs', 'qwen-maintenance-client.mjs', 'teaching-review-routing.mjs'];
  if (recoverFormat) modules.push('teaching-format-recovery.mjs');
  await save('source-hashes.json', await Promise.all(modules.map(async name => ({ file: `scripts/lib/${name}`, sha256: hash(await readFile(new URL(name, import.meta.url))) }))));
  const started = performance.now(), startedAt = new Date().toISOString();
  const records = [], results = [];
  try {
    const client = await clientFactory({ settingsFile });
    const generationProfile = { provider: 'deepseek', ...client.publicProfile };
    const reviewRouting = createMaintenanceReviewRouting({ settingsFile, agentEnvFile, reviewClientFactory, save });
    await save('protocol.json', { pipelineVersion: 'teaching-term-pipeline-v1', startedAt, profile: generationProfile, generationProfile, reviewProfile: plannedReviewProfile,
      modelListFetched: false, modelSelectionSource: 'configured_model',
      reviewProfileSelection: 'Lazy: matching saved thinking-on Qwen profile first; otherwise explicit offline agent env. Actual profile saved separately on trigger.',
      dictionaryVersion: dictionary.version, dictionarySha256: hash(JSON.stringify(dictionary)),
      methodReferenceIds: references.map(ref => ref.id), methodReferencesSha256: hash(JSON.stringify(references)),
      promptSha256: hash(mainPrompt), reviewPromptSha256: hash(reviewPrompt), concurrency,
      recoverFormat, formatReviewPromptSha256: formatReviewPrompt ? hash(formatReviewPrompt) : null,
      maxReviewCallsPerQuestion: 1, technicalRetries: 0, feedback: recoverFormat ? 'Lexical findings, or original malformed generation content plus format error codes; no per-question mathematical correction.' : 'Only lexical findings with field/excerpt/guidance; no per-question mathematical correction.',
      reviewTrigger: recoverFormat ? 'Term hits, or a generation JSON/schema failure with complete raw provider content; one review, no technical retry.' : 'Configured term hits only; not difficulty, method length, correctness or curriculum approval.',
      optionalEightBlockHintsIncluded: references.length > 0, bankWritten: false, settingsWritten: false, personalDatabaseOpened: false });

    let cursor = 0, completed = 0;
    const worker = async () => {
      while (cursor < rows.length) {
        const item = rows[cursor++];
        let generationFormatFailure = null;
        const call = async (stage, data) => {
          const prefix = stage === 'generation' ? '' : stage === 'format-review' ? 'format-review-' : 'review-';
          const messages = [{ role: 'system', content: stage === 'generation' ? mainPrompt : stage === 'format-review' ? formatReviewPrompt : reviewPrompt }, { role: 'user', content: JSON.stringify(data) }];
          const record = { sampleNumber: item.sampleNumber, questionId: item.questionId, stage,
            provider: stage === 'generation' ? 'deepseek' : 'qianwenai',
            model: stage === 'generation' ? generationProfile.model : plannedReviewProfile.model,
            profile: stage === 'generation' ? generationProfile : plannedReviewProfile,
            messageSha256: hash(JSON.stringify(messages)), promptSha256: hash(messages[0].content),
            requestWritten: false, ok: false, startedAt: new Date().toISOString() };
          try {
            const stageClient = stage === 'generation' ? client : await reviewRouting.getClient();
            record.profile = stage === 'generation' ? generationProfile : reviewRouting.profile;
            record.provider = record.profile.provider;
            record.model = record.profile.model;
            const response = await stageClient.complete(messages, { onRequest: async request => {
              await save(`${prefix}requests/${item.fileStem}.json`, request);
              record.requestWritten = true;
            } });
            // The transport returns the exact body that was sent; verify audit parity.
            const written = JSON.parse(await readFile(path.join(out, `${prefix}requests/${item.fileStem}.json`), 'utf8'));
            if (JSON.stringify(written) !== JSON.stringify(response.request)) throw error('request_audit_mismatch');
            Object.assign(record, { providerResponse: response.providerResponse, requestSha256: response.requestSha256,
              elapsedSeconds: response.elapsedSeconds, startedAt: response.startedAt });
            if (recoverFormat) record.rawContent = response.content;
            if (record.providerResponse.choices?.[0]?.finish_reason !== 'stop') throw error('response_incomplete');
            let parsed;
            try { parsed = JSON.parse(response.content); } catch { throw error('model_content_invalid_json'); }
            validateTeachingResult(parsed, item.questionId);
            record.result = parsed; record.ok = true;
          } catch (e) {
            record.error = { code: safeCode(e), ...(e?.safeRecord ? { metadata: e.safeRecord } : {}) };
          }
          await save(`${prefix}responses/${item.fileStem}.json`, record);
          records.push(record);
          if (!record.ok) {
            if (recoverFormat && stage === 'generation' && recoverableFormatCodes.has(record.error.code)
              && record.providerResponse?.choices?.[0]?.finish_reason === 'stop' && typeof record.rawContent === 'string') {
              generationFormatFailure = { rawCandidate: record.rawContent, formatFindings: [{ code: record.error.code }] };
            }
            throw error(record.error.code);
          }
          return structuredClone(record.result);
        };
        const pipeline = await runTeachingTermPipeline({ originalMaterial: item.originalMaterial,
          generate: data => call('generation', data), review: data => call('review', data),
          onEvent: event => save(`scans/${item.fileStem}-${event.phase}.json`, event) });
        let entry = { sampleNumber: item.sampleNumber, fileStem: item.fileStem, ...pipeline };
        if (generationFormatFailure && pipeline.status === 'generation_failed') {
          const recovery = await runTeachingFormatRecovery({ originalMaterial: item.originalMaterial, ...generationFormatFailure, review: data => call('format-review', data) });
          entry = { ...entry, generationStatus: pipeline.status, generationError: pipeline.error, formatRecovery: recovery,
            status: recovery.status, error: recovery.error, finalResult: recovery.finalResult, recoveredResult: recovery.recoveredResult,
            finalScan: recovery.termScan, textComplete: recovery.textComplete, needsReviewReasons: recovery.needsReviewReasons };
        }
        await save(`pipelines/${item.fileStem}.json`, entry);
        results.push(entry);
        completed++;
        onProgress({ completed, total: rows.length, sampleNumber: item.sampleNumber, status: entry.status, formatRecoveryTriggered: Boolean(entry.formatRecovery), initialHits: entry.initialScan?.findings.length ?? 0, remainingHits: entry.finalScan?.findings.length ?? null });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
    results.sort((a, b) => rows.findIndex(r => r.questionId === a.questionId) - rows.findIndex(r => r.questionId === b.questionId));
    const usage = stage => records.filter(r => !stage || r.stage === stage).reduce((sum, r) => {
      for (const k of Object.keys(sum)) sum[k] += r.providerResponse?.usage?.[k] ?? 0;
      return sum;
    }, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    const summary = { pipelineVersion: 'teaching-term-pipeline-v1', questions: rows.length,
      generated: records.filter(r => r.stage === 'generation' && r.ok).length,
      reviewsTriggered: results.filter(r => r.reviewTriggered).length,
      reviewsCompleted: records.filter(r => r.stage === 'review' && r.ok).length,
      recoverFormat,
      formatReviewsTriggered: results.filter(r => r.formatRecovery).length,
      formatReviewsCompleted: records.filter(r => r.stage === 'format-review' && r.ok).length,
      formatRecoveredNoKnownFlagsQuestions: results.filter(r => r.status === 'reviewed_no_known_flags').map(r => r.sampleNumber),
      needsReviewQuestions: results.filter(r => r.status === 'needs_review').map(r => ({ sampleNumber: r.sampleNumber, reasons: r.needsReviewReasons })),
      chatRequests: records.filter(r => r.requestWritten).length, modelListRequests: reviewRouting.modelListRequests,
      providers: maintenanceProviderSummary(records, generationProfile, reviewRouting),
      noTermHitQuestions: results.filter(r => r.status === 'no_term_hits').map(r => r.sampleNumber),
      rewrittenNoTermHitQuestions: results.filter(r => r.status === 'rewritten_no_term_hits').map(r => r.sampleNumber),
      remainingTermHitQuestions: results.filter(r => r.status === 'remaining_term_hits' || r.formatRecovery?.termScan?.findings.length).map(r => r.sampleNumber),
      failedQuestions: results.filter(r => r.error).map(r => ({ sampleNumber: r.sampleNumber, status: r.status, error: r.error })),
      initialFindingCount: results.reduce((n, r) => n + (r.initialScan?.findings.length ?? 0), 0),
      remainingFindingCount: results.reduce((n, r) => n + (r.finalScan?.findings.length ?? 0), 0),
      reportedUsage: usage(), generationUsage: usage('generation'), reviewUsage: usage('review'), formatReviewUsage: usage('format-review'),
      usageUnknownRequests: records.filter(r => r.requestWritten && !r.providerResponse?.usage).length,
      wallSeconds: (performance.now() - started) / 1000,
      semanticApprovalInferred: false, bankWritten: false, settingsWritten: false, personalDatabaseOpened: false };
    await save('results.json', results);
    await save('summary.json', summary);
    return { outputDirectory: out, summary };
  } catch (e) {
    await save('failure.json', { code: safeCode(e), outputDirectory: out, bankWritten: false, settingsWritten: false });
    throw error(safeCode(e));
  }
}
