import { createMaintenanceReviewRouting, plannedReviewProfile, maintenanceProviderSummary } from './teaching-review-routing.mjs';
import { openQwenMaintenanceClient } from './qwen-maintenance-client.mjs';
import { loadTeachingMethodReferences, appendTeachingMethodReferences } from './teaching-method-reference.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { normalizeTeachingInputs, extractTeachingPrompt } from './teaching-term-maintenance.mjs';
import { openDeepSeekMaintenanceClient } from './deepseek-maintenance-client.mjs';
import { runTeachingQualityPipeline } from './teaching-quality-pipeline.mjs';
import { teachingTermDictionarySnapshot } from './teaching-term-scan.mjs';
import { compactTeachingReviewContext } from './teaching-review-context.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const safeCode = error => typeof error?.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/u.test(error.code) ? error.code : 'maintenance_failed';
const escaped = (text, i) => {
  let slashes = 0;
  while (i > 0 && text[--i] === '\\') slashes++;
  return slashes % 2 === 1;
};

function* mathSpans(text) {
  for (let i = 0; i < text.length; i++) {
    if (escaped(text, i)) continue;
    let open, close;
    if (text[i] === '$') open = close = text[i + 1] === '$' ? '$$' : '$';
    else if (text.startsWith('\\(', i)) { open = '\\('; close = '\\)'; }
    else if (text.startsWith('\\[', i)) { open = '\\['; close = '\\]'; }
    else continue;
    const start = i;
    let end = text.indexOf(close, start + open.length);
    while (end !== -1 && (escaped(text, end) || (close === '$' && (text[end + 1] === '$' || text[end - 1] === '$')))) {
      end = text.indexOf(close, end + close.length);
    }
    // The shared scanner reports unpaired/mixed delimiters independently.
    if (end === -1) continue;
    yield { start, end: end + close.length, formula: text.slice(start + open.length, end), displayMode: open === '$$' || open === '\\[' };
    i = end + close.length - 1;
  }
}

/** Render checks only: never evaluate algebra or infer mathematical correctness. */
export function createTeachingMathDisplayValidator(loadKatex = () => createRequire(new URL('../../desktop/package.json', import.meta.url))('katex')) {
  let katex;
  try {
    katex = loadKatex();
    if (typeof katex?.renderToString !== 'function') throw fail('katex_initialization_failed');
    katex.renderToString('1+1=2', { throwOnError: true, trust: false, strict: 'ignore' });
  } catch { throw fail('katex_initialization_failed'); }
  return result => {
    const fields = [
      ['answer', result.answer], ['difficultyAssessment.basis', result.difficultyAssessment?.basis],
      ['teachingSolution', result.teachingSolution], ['teachingFocus.examFocus', result.teachingFocus?.examFocus],
      ...(result.teachingFocus?.studentRequirements ?? []).map((text, i) => [`teachingFocus.studentRequirements[${i}]`, text]),
      ...(result.issues ?? []).map((text, i) => [`issues[${i}]`, text]),
    ];
    const findings = [];
    for (const [fieldPath, text] of fields) {
      if (typeof text !== 'string') continue;
      for (const span of mathSpans(text)) {
        try {
          katex.renderToString(span.formula, { throwOnError: true, trust: false, strict: 'ignore',
            displayMode: span.displayMode, maxExpand: 1000, macros: {} });
        } catch {
          findings.push({ code: 'latex_render_failed', fieldPath, start: span.start, end: span.end });
        }
      }
    }
    return { findings, warnings: [] };
  };
}

const flagCounts = findings => {
  const counts = {};
  for (const finding of findings) counts[finding.type] = (counts[finding.type] ?? 0) + 1;
  return counts;
};

/** Explicit offline authoring only. Does not open databases or modify settings. */
export async function runTeachingQualityMaintenance({ inputFile, outputDirectory, settingsFile, concurrency = 3, methodReferences = [],
  clientFactory = openDeepSeekMaintenanceClient, reviewClientFactory = openQwenMaintenanceClient, agentEnvFile, onProgress = () => {} } = {}) {
  if (![inputFile, outputDirectory, settingsFile].every(value => typeof value === 'string' && value.trim())
    || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4
    || typeof clientFactory !== 'function' || typeof reviewClientFactory !== 'function' || typeof onProgress !== 'function') throw fail('invalid_maintenance_options');
  const references = await loadTeachingMethodReferences(methodReferences);
  const rows = normalizeTeachingInputs(JSON.parse(await readFile(inputFile, 'utf8')));
  const document = await readFile(path.join(repoRoot, 'docs/design/math-teaching-analysis-prompt.md'), 'utf8');
  const prompt = appendTeachingMethodReferences(`${extractTeachingPrompt(document, 'teaching-prompt')}\n\n${await readFile(path.join(repoRoot, 'scripts/resources/teaching-quality-signals-instruction.txt'), 'utf8')}`, references);
  const reviewPrompt = appendTeachingMethodReferences(`${extractTeachingPrompt(document, 'teaching-review')}\n\n${(await readFile(path.join(repoRoot, 'scripts/resources/teaching-quality-review-instruction.txt'), 'utf8')).trim()}`, references);
  const boundedReviewPrompt = appendTeachingMethodReferences((await readFile(path.join(repoRoot, 'scripts/resources/teaching-bounded-patch-instruction.txt'), 'utf8')).trim(), references);
  const dictionary = teachingTermDictionarySnapshot();
  const out = path.resolve(outputDirectory);
  try { await mkdir(out); } catch { throw fail('output_directory_must_be_new'); }
  const save = (name, value) => writeFile(path.join(out, name), JSON.stringify(value, null, 2), { flag: 'wx' });
  const started = performance.now(), startedAt = new Date().toISOString();
  try {
    const validateDisplay = createTeachingMathDisplayValidator();
    for (const folder of ['requests', 'responses', 'review-requests', 'review-responses', 'results']) await mkdir(path.join(out, folder));
    await save('inputs.json', rows);
    await save('method-references.json', references);
    await writeFile(path.join(out, 'prompt.txt'), prompt, { flag: 'wx' });
    await writeFile(path.join(out, 'review-prompt.txt'), reviewPrompt, { flag: 'wx' });
    await writeFile(path.join(out, 'bounded-review-prompt.txt'), boundedReviewPrompt, { flag: 'wx' });
    await save('term-dictionary.json', dictionary);
    const modules = ['teaching-method-reference.mjs', 'teaching-quality-maintenance.mjs', 'teaching-quality-pipeline.mjs', 'teaching-term-maintenance.mjs',
      'teaching-term-pipeline.mjs', 'teaching-term-scan.mjs', 'teaching-format-recovery.mjs', 'deepseek-maintenance-client.mjs', 'qwen-maintenance-client.mjs', 'teaching-review-routing.mjs', 'teaching-review-context.mjs', 'teaching-bounded-patch.mjs', 'teaching-quality-signals.mjs'];
    await save('source-hashes.json', await Promise.all(modules.map(async name => ({ file: `scripts/lib/${name}`, sha256: sha(await readFile(new URL(name, import.meta.url))) }))));
    const client = await clientFactory({ settingsFile });
    const generationProfile = { provider: 'deepseek', ...client.publicProfile };
    const reviewRouting = createMaintenanceReviewRouting({ settingsFile, agentEnvFile, reviewClientFactory, save });
    const catalogue = await client.getModels();
    await save('models-public.json', catalogue);
    if (!Array.isArray(catalogue?.models) || !catalogue.models.includes(client.publicProfile?.model)) throw fail('requested_model_not_in_provider_catalogue');
    await save('protocol.json', { pipelineVersion: 'teaching-quality-pipeline-v1', startedAt, profile: generationProfile, generationProfile, reviewProfile: plannedReviewProfile,
      reviewProfileSelection: 'Lazy: matching saved thinking-on Qwen profile first; otherwise explicit offline agent env. Actual profile saved separately on trigger.',
      methodReferenceIds: references.map(ref => ref.id), methodReferencesSha256: sha(JSON.stringify(references)),
      promptSha256: sha(prompt), reviewPromptSha256: sha(reviewPrompt), boundedReviewPromptSha256: sha(boundedReviewPrompt), dictionaryVersion: dictionary.version,
      dictionarySha256: sha(JSON.stringify(dictionary)), concurrency, maxReviewCallsPerQuestion: 1, technicalRetries: 0,
      displayValidation: 'Shared display scanner plus KaTeX rendering; never mathematical verification.',
      reviewTrigger: 'One combined review of complete raw content with schema, incomplete text, term, display or model-reported findings.',
      semanticApprovalInferred: false, bankWritten: false, settingsWritten: false, personalDatabaseOpened: false });
    const records = [], results = [];
    let cursor = 0, completed = 0;
    const worker = async () => {
      while (cursor < rows.length) {
        const item = rows[cursor++];
        const call = async (stage, data) => {
          const prefix = stage === 'generation' ? '' : 'review-';
          const reviewMode = data?.patchContract ? 'bounded_patch' : 'full_review';
          const messages = [{ role: 'system', content: stage === 'generation' ? prompt : reviewMode === 'bounded_patch' ? boundedReviewPrompt : reviewPrompt },
            { role: 'user', content: JSON.stringify(stage === 'generation' ? data : compactTeachingReviewContext(data)) }];
          const record = { sampleNumber: item.sampleNumber, questionId: item.questionId, stage, ...(stage === 'review' ? { reviewMode } : {}),
            provider: stage === 'generation' ? 'deepseek' : 'qianwenai',
            model: stage === 'generation' ? generationProfile.model : plannedReviewProfile.model,
            profile: stage === 'generation' ? generationProfile : plannedReviewProfile,
            promptSha256: sha(messages[0].content), messageSha256: sha(JSON.stringify(messages)),
            requestWritten: false, ok: false, startedAt: new Date().toISOString() };
          let auditedBody;
          try {
            const stageClient = stage === 'generation' ? client : await reviewRouting.getClient();
            record.profile = stage === 'generation' ? generationProfile : reviewRouting.profile;
            record.provider = record.profile.provider;
            record.model = record.profile.model;
            const response = await stageClient.complete(messages, { onRequest: async request => {
              if (auditedBody !== undefined) throw fail('request_audit_repeated');
              auditedBody = JSON.stringify(request);
              await save(`${prefix}requests/${item.fileStem}.json`, request);
              record.requestWritten = true;
              record.requestSha256 = sha(auditedBody);
              const persisted = JSON.parse(await readFile(path.join(out, `${prefix}requests/${item.fileStem}.json`), 'utf8'));
              if (JSON.stringify(persisted) !== auditedBody || sha(JSON.stringify(persisted)) !== record.requestSha256) throw fail('request_audit_mismatch');
            } });
            Object.assign(record, { request: response.request, providerResponse: response.providerResponse, rawContent: response.content,
              reportedRequestSha256: response.requestSha256, elapsedSeconds: response.elapsedSeconds, startedAt: response.startedAt });
            if (!record.requestWritten || auditedBody !== JSON.stringify(response.request)) throw fail('request_audit_mismatch');
            const written = JSON.parse(await readFile(path.join(out, `${prefix}requests/${item.fileStem}.json`), 'utf8'));
            if (JSON.stringify(written) !== auditedBody || response.requestSha256 !== sha(auditedBody)) throw fail('request_audit_mismatch');
            if (response.providerResponse?.choices?.[0]?.finish_reason !== 'stop') throw fail('response_incomplete');
            if (typeof response.content !== 'string') throw fail('content_missing');
            // JSON/schema assessment belongs to the pipeline, including malformed raw JSON recovery.
            record.ok = true;
          } catch (error) {
            record.error = { code: safeCode(error), ...(error?.safeRecord ? { metadata: error.safeRecord } : {}) };
          }
          await save(`${prefix}responses/${item.fileStem}.json`, record);
          records.push(record);
          if (!record.ok) throw fail(record.error.code);
          return record.rawContent;
        };
        const pipeline = await runTeachingQualityPipeline({ originalMaterial: item.originalMaterial,
          generate: data => call('generation', data), review: data => call('review', data), validateDisplay });
        const entry = { sampleNumber: item.sampleNumber, fileStem: item.fileStem, ...pipeline };
        await save(`results/${item.fileStem}.json`, entry);
        results.push(entry);
        await onProgress({ completed: ++completed, total: rows.length, sampleNumber: item.sampleNumber,
          status: entry.status, reviewTriggered: entry.reviewTriggered, initialFlags: entry.initialFindings.length,
          remainingFlags: entry.needsReviewReasons.length });
      }
    };
    const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
    const rejected = workers.find(value => value.status === 'rejected');
    if (rejected) throw rejected.reason;
    const order = new Map(rows.map((row, index) => [row.questionId, index]));
    results.sort((a, b) => order.get(a.questionId) - order.get(b.questionId));
    const usage = stage => records.filter(record => !stage || record.stage === stage).reduce((sum, record) => {
      for (const key of Object.keys(sum)) {
        const value = record.providerResponse?.usage?.[key];
        if (Number.isFinite(value) && value >= 0) sum[key] += value;
      }
      return sum;
    }, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    const summary = { pipelineVersion: 'teaching-quality-pipeline-v1', questions: rows.length,
      firstDraftStructureSucceeded: results.filter(result => result.initialResult !== null).length,
      firstDraftsNeedingReview: results.filter(result => result.reviewTriggered).length,
      reviewsTriggered: results.filter(result => result.reviewTriggered).length,
      reviewsCompleted: results.filter(result => result.reviewedResult !== null).length,
      reviewTransportCompleted: records.filter(record => record.stage === 'review' && record.ok).length,
      initialFlags: flagCounts(results.flatMap(result => result.initialFindings)),
      remainingFlags: flagCounts(results.flatMap(result => result.needsReviewReasons)),
      readyCandidateQuestions: results.filter(result => result.status === 'ready_candidate').map(result => result.sampleNumber),
      needsReviewQuestions: results.filter(result => result.status === 'needs_review').map(result => ({ sampleNumber: result.sampleNumber, reasons: result.needsReviewReasons })),
      failedQuestions: results.filter(result => result.error).map(result => ({ sampleNumber: result.sampleNumber, status: result.status, error: result.error })),
      technicalFailures: records.filter(record => !record.ok).map(record => ({ sampleNumber: record.sampleNumber, stage: record.stage, error: record.error })),
      chatRequests: records.filter(record => record.requestWritten).length, modelListRequests: 1 + reviewRouting.modelListRequests,
      providers: maintenanceProviderSummary(records, generationProfile, reviewRouting),
      reportedUsage: usage(), generationUsage: usage('generation'), reviewUsage: usage('review'),
      usageUnknownRequests: records.filter(record => record.requestWritten && !record.providerResponse?.usage).length,
      wallSeconds: (performance.now() - started) / 1000,
      semanticApprovalInferred: false, bankWritten: false, settingsWritten: false, personalDatabaseOpened: false };
    await save('results.json', results);
    await save('summary.json', summary);
    return { outputDirectory: out, summary };
  } catch (error) {
    await save('failure.json', { code: safeCode(error), outputDirectory: out, bankWritten: false, settingsWritten: false });
    throw fail(safeCode(error));
  }
}
