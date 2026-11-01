import { validateTeachingResult } from './teaching-term-pipeline.mjs';
import { scanTeachingTerms } from './teaching-term-scan.mjs';
import { scanTeachingDisplay } from './teaching-format-recovery.mjs';
import { mergeTeachingBoundedPatch } from './teaching-bounded-patch.mjs';
import { createTeachingSentencePatchContract, teachingReviewResponseContract, filterReviewedTermFindings } from './teaching-sentence-patch.mjs';
import { teachingMethodScopePreferences } from './teaching-review-context.mjs';
import { readQualitySignals, externalQualityFindings, validateQualityResolutions, qualityHash } from './teaching-quality-signals.mjs';

const invalid = code => Object.assign(new Error(code), { code });
const safeCode = error => typeof error?.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/u.test(error.code) ? error.code : 'model_or_validation_failed';

/** Recheck shape, completeness and known text/display flags; never grade math. */
export async function assessTeachingCandidate(value, questionId, validateDisplay) {
  const out = { candidateResult: null, textComplete: false, termScan: null, displayScan: null, findings: [], needsReviewReasons: [], error: null };
  let parsed;
  try {
    if (typeof questionId !== 'string' || !questionId.trim()) throw invalid('missing_question_identity');
    if (validateDisplay !== undefined && typeof validateDisplay !== 'function') throw invalid('invalid_display_validator');
    if (typeof value === 'string') {
      try { parsed = JSON.parse(value); } catch { throw invalid('invalid_candidate_json'); }
    } else parsed = structuredClone(value);
    let checked;
    try { checked = validateTeachingResult(parsed, questionId); } catch (error) {
      // This one code denotes valid field types but an unreported partial draft.
      // Preserve it for an explicit incomplete marker, never a ready result.
      if (error?.code !== 'incomplete_result_without_explanation') throw error;
      checked = { textComplete: false };
    }
    out.candidateResult = structuredClone(parsed);
    out.textComplete = checked.textComplete && Boolean(parsed.difficultyAssessment.basis.trim());
    out.termScan = scanTeachingTerms(parsed);
    out.displayScan = scanTeachingDisplay(parsed);
    if (validateDisplay) {
      const extra = await validateDisplay(structuredClone(parsed));
      if (!extra || !Array.isArray(extra.findings) || !Array.isArray(extra.warnings)) throw invalid('invalid_display_validation');
      out.displayScan.findings.push(...structuredClone(extra.findings));
      out.displayScan.warnings.push(...structuredClone(extra.warnings));
    }
    if (!out.textComplete) out.findings.push({ type: 'incomplete', code: 'incomplete_result' });
    for (const finding of out.termScan.findings) out.findings.push({ type: 'term', ...structuredClone(finding) });
    for (const finding of out.displayScan.findings) out.findings.push({ ...structuredClone(finding), type: 'display' });
    for (const issue of parsed.issues) out.findings.push({ type: 'model_issue', issue });
  } catch (error) {
    const code = safeCode(error);
    out.error = { code };
    out.findings.push({ type: 'format', code });
  }
  out.needsReviewReasons = structuredClone(out.findings);
  return out;
}

/**
 * One generation and at most one combined review. Raw model outputs and all
 * inputs are data. Callers own transport/audit and any bank-write policy.
 * ready_candidate means no known flags, not independent proof of correctness.
 */
export async function runTeachingQualityPipeline({ originalMaterial, generate, review, validateDisplay, externalQualityReview, previousWorkflow }) {
  const original = structuredClone(originalMaterial);
  if (!original || typeof original.questionId !== 'string' || !original.questionId.trim()) throw invalid('missing_question_identity');
  if (typeof generate !== 'function' || typeof review !== 'function' || (validateDisplay !== undefined && typeof validateDisplay !== 'function')) throw invalid('missing_model_callbacks');
  // Explicit continuation reuses the saved draft and lifetime quota; no model
  // callback runs for a complete already-clean workflow or a spent review.
  if (previousWorkflow && previousWorkflow.sourceContentSha256 !== qualityHash(original)) throw invalid('source_changed');
  if (previousWorkflow?.status === 'ready_candidate' && !externalQualityReview) return structuredClone(previousWorkflow);
  if ((previousWorkflow?.reviewCalls ?? 0) >= 1 && !externalQualityReview) return structuredClone(previousWorkflow);
  const out = {
    pipelineVersion: 'teaching-quality-pipeline-v1', questionId: original.questionId,
    initialCandidate: null, initialResult: null, initialFindings: [],
    reviewedCandidate: null, reviewedResult: null, candidateResult: null, finalResult: null,
    retainedInitialCandidate: null, retainedInitialReason: null,
    reviewTriggered: false, reviewCalls: 0, termScan: null, displayScan: null,
    needsReviewReasons: [], error: null, textComplete: false,
  };
  let phase = 'generation';
  try {
    out.initialCandidate = structuredClone(previousWorkflow ? previousWorkflow.candidateResult ?? previousWorkflow.initialResult : await generate(structuredClone(original)));
    let generated = out.initialCandidate;
    if (typeof generated === 'string') { try { generated = JSON.parse(generated); } catch {} }
    const envelope = generated && typeof generated === 'object' && Object.keys(generated).length === 2 && Object.hasOwn(generated, 'candidate') && Object.hasOwn(generated, 'qualitySignals');
    const draft = envelope ? generated.candidate : generated;
    const signalValue = envelope ? generated.qualitySignals : previousWorkflow?.qualitySignals ?? null;
    const signals = readQualitySignals(signalValue, original.questionId);
    out.qualitySignals = structuredClone(signalValue);
    out.semanticAssessment = signals.semanticAssessment;
    out.sourceContentSha256 = qualityHash(original);
    const initial = await assessTeachingCandidate(draft, original.questionId, validateDisplay);
    initial.findings.push(...signals.findings, ...externalQualityFindings(externalQualityReview, original, draft));
    out.initialResult = structuredClone(initial.candidateResult);
    out.initialFindings = structuredClone(initial.findings);
    Object.assign(out, { candidateResult: structuredClone(initial.candidateResult), termScan: initial.termScan, displayScan: initial.displayScan,
      textComplete: initial.textComplete, needsReviewReasons: structuredClone(initial.findings) });
    if (!initial.findings.length) return { ...out, status: 'ready_candidate', finalResult: structuredClone(initial.candidateResult) };

    if ((previousWorkflow?.reviewCalls ?? 0) >= 1) return { ...out, reviewCalls: previousWorkflow.reviewCalls, status: 'needs_review', finalResult: null, reviewSkipped: 'allowance_spent' };

    phase = 'review';
    out.reviewTriggered = true;
    out.reviewCalls = 1;
    out.retainedInitialCandidate = structuredClone(initial.candidateResult);
    out.retainedInitialReason = 'review_pending';
    // Clear adoption fields before the external call. A failed review never
    // silently falls back to the initial draft, even if that draft was valid.
    out.candidateResult = null;
    out.termScan = null;
    out.displayScan = null;
    out.textComplete = false;
    const reviewContext = {
      originalMaterial: structuredClone(original), candidate: structuredClone(initial.candidateResult),
      rawCandidate: structuredClone(out.initialCandidate), reviewFindings: structuredClone(initial.findings),
      verifiedInputFacts: { questionId: original.questionId, questionType: original.questionType ?? null },
      scopePolicy: 'sentence_only',
      reviewResolutionVersion: 2,
    };
    out.reviewResolutionVersion = reviewContext.reviewResolutionVersion;
    Object.assign(reviewContext,teachingMethodScopePreferences(reviewContext));
    const contract = createTeachingSentencePatchContract(reviewContext);
    if (contract) reviewContext.patchContract = contract;
    if (contract) reviewContext.reviewResponseContract = teachingReviewResponseContract(contract);
    out.reviewMode = contract ? 'bounded_patch' : 'full_review';
    out.reviewScope = contract ? (contract.segmentPatchVersion===2?'explicit_segments_or_method_parts_v2':'sentence_segments_v1') : 'structural_recovery';
    out.reviewPatchContract = structuredClone(contract);
    out.reviewedCandidate = structuredClone(await review(structuredClone(reviewContext)));
    phase = 'review_validation';
    let revised = out.reviewedCandidate;
    let validatedReviewResponse = null;
    if (contract) {
      if (typeof revised === 'string') { try { revised = JSON.parse(revised); } catch { throw invalid('invalid_candidate_json'); } }
      validatedReviewResponse = revised;
      revised = mergeTeachingBoundedPatch(reviewContext, revised);
    } else if (initial.findings.some(f => f.type === 'quality')) {
      if (typeof revised === 'string') { try { revised = JSON.parse(revised); } catch { throw invalid('invalid_candidate_json'); } }
      if (!revised || Object.keys(revised).length !== 2 || !Object.hasOwn(revised, 'candidate') || !Object.hasOwn(revised, 'qualityResolutions')) throw invalid('teaching_quality_unresolved');
      validateQualityResolutions(reviewContext, revised, revised.candidate);
      revised = revised.candidate;
    }
    const checked = await assessTeachingCandidate(revised, original.questionId, validateDisplay);
    if (contract?.resolutionVersion === 2) {
      checked.findings = filterReviewedTermFindings(checked.findings, reviewContext, validatedReviewResponse, revised);
      if (checked.termScan) checked.termScan.findings = filterReviewedTermFindings(checked.termScan.findings, reviewContext, validatedReviewResponse, revised);
    }
    Object.assign(out, { reviewedResult: structuredClone(checked.candidateResult), candidateResult: structuredClone(checked.candidateResult),
      termScan: checked.termScan, displayScan: checked.displayScan, textComplete: checked.textComplete,
      needsReviewReasons: structuredClone(checked.findings) });
    if (checked.error) return { ...out, retainedInitialReason: checked.error.code, status: 'review_failed', error: { phase, code: checked.error.code } };
    if (checked.findings.length) return { ...out, retainedInitialReason: 'review_findings_remain', status: 'needs_review' };
    return { ...out, retainedInitialReason: 'review_candidate_available', status: 'ready_candidate', finalResult: structuredClone(checked.candidateResult) };
  } catch (error) {
    const code = safeCode(error);
    return { ...out, candidateResult: null, finalResult: null, status: phase === 'generation' ? 'generation_failed' : 'review_failed',
      retainedInitialReason: phase === 'generation' ? null : code,
      error: { phase, code }, needsReviewReasons: [...out.needsReviewReasons, { type: 'technical', code }] };
  }
}
