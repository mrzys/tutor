import { scanTeachingTerms } from './teaching-term-scan.mjs';

const resultKeys = ['questionId', 'answer', 'difficultyAssessment', 'teachingSolution', 'teachingFocusSchemaVersion', 'teachingFocus', 'issues'];
const levels = ['easy', 'easy_medium', 'medium', 'medium_hard', 'hard', null];
const exactKeys = (v, keys) => v && !Array.isArray(v) && typeof v === 'object' && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const strings = v => Array.isArray(v) && v.every(s => typeof s === 'string' && s.trim());
function invalid(code) { const e = new Error(code); e.code = code; return e; }

/** Structural validation only. Empty/partial work stays incomplete, never a pass. */
export function validateTeachingResult(result, questionId) {
  if (!exactKeys(result, resultKeys) || result.questionId !== questionId || result.teachingFocusSchemaVersion !== 2) throw invalid('invalid_result_identity_or_schema');
  if (typeof result.answer !== 'string' || typeof result.teachingSolution !== 'string' || !strings(result.issues)) throw invalid('invalid_result_text');
  const d = result.difficultyAssessment, f = result.teachingFocus;
  if (!exactKeys(d, ['level', 'basis']) || !levels.includes(d.level) || typeof d.basis !== 'string') throw invalid('invalid_difficulty_schema');
  if (!exactKeys(f, ['examFocus', 'studentRequirements']) || typeof f.examFocus !== 'string' || [...f.examFocus].length > 600 || !strings(f.studentRequirements) || f.studentRequirements.length > 3 || f.studentRequirements.some(t => [...t].length > 400)) throw invalid('invalid_teaching_focus');
  const textComplete = Boolean(result.answer.trim() && result.teachingSolution.trim() && f.examFocus.trim() && f.studentRequirements.length);
  if (!textComplete && !result.issues.length) throw invalid('incomplete_result_without_explanation');
  return { textComplete };
}

/**
 * Explicit maintenance only. The callbacks own transport/audit; this function
 * does no I/O, replaces no words and makes no mathematical/curriculum decision.
 * At most one REVIEW call, including when that review introduces new terms.
 */
export async function runTeachingTermPipeline({ originalMaterial, generate, review, onEvent = async () => {} }) {
  const original = structuredClone(originalMaterial);
  if (!original || typeof original.questionId !== 'string' || !original.questionId.trim()) throw invalid('missing_question_identity');
  if (typeof generate !== 'function' || typeof review !== 'function') throw invalid('missing_model_callbacks');
  const output = { pipelineVersion: 'teaching-term-pipeline-v1', questionId: original.questionId, reviewTriggered: false, reviewCalls: 0, initialResult: null, reviewedResult: null, finalResult: null, initialScan: null, finalScan: null, textComplete: false, error: null };
  let phase = 'generation';
  try {
    const first = structuredClone(await generate(structuredClone(original)));
    const validation = validateTeachingResult(first, original.questionId);
    output.initialResult = structuredClone(first);
    output.initialScan = scanTeachingTerms(first);
    output.textComplete = validation.textComplete;
    await onEvent({ phase: 'initial_scan', scan: structuredClone(output.initialScan), textComplete: validation.textComplete });
    if (!output.initialScan.findings.length) {
      return { ...output, status: 'no_term_hits', finalResult: structuredClone(first), finalScan: structuredClone(output.initialScan) };
    }
    phase = 'review';
    output.reviewTriggered = true;
    output.reviewCalls = 1;
    const rewritten = structuredClone(await review({ originalMaterial: structuredClone(original), candidateDraft: structuredClone(first), termFindings: structuredClone(output.initialScan.findings) }));
    const checked = validateTeachingResult(rewritten, original.questionId);
    output.reviewedResult = structuredClone(rewritten);
    output.finalScan = scanTeachingTerms(rewritten);
    output.finalResult = structuredClone(rewritten);
    output.textComplete = checked.textComplete;
    await onEvent({ phase: 'final_scan', scan: structuredClone(output.finalScan), textComplete: checked.textComplete });
    return { ...output, status: output.finalScan.findings.length ? 'remaining_term_hits' : 'rewritten_no_term_hits' };
  } catch (e) {
    // Do not promote an initial draft after a failed or malformed review.
    // Preserve it explicitly; transport response details belong to the caller.
    const code = typeof e?.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(e.code) ? e.code : 'model_or_validation_failed';
    return { ...output, status: phase === 'generation' ? 'generation_failed' : 'review_failed', finalResult: null, error: { phase, code } };
  }
}
