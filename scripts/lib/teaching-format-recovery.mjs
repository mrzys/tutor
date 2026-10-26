import { validateTeachingResult } from './teaching-term-pipeline.mjs';
import { scanTeachingTerms } from './teaching-term-scan.mjs';

function invalid(code) { const error = new Error(code); error.code = code; return error; }

function classroomFields(result) {
  const fields = [
    ['answer', result?.answer],
    ['difficultyAssessment.basis', result?.difficultyAssessment?.basis],
    ['teachingSolution', result?.teachingSolution],
    ['teachingFocus.examFocus', result?.teachingFocus?.examFocus],
    ...(result?.teachingFocus?.studentRequirements ?? []).map((value, i) => [`teachingFocus.studentRequirements[${i}]`, value]),
    ...(result?.issues ?? []).map((value, i) => [`issues[${i}]`, value]),
  ];
  return fields.filter(([, value]) => typeof value === 'string');
}

function isEscaped(value, position) {
  let slashes = 0;
  while (position > 0 && value[--position] === '\\') slashes++;
  return slashes % 2 === 1;
}

/** Static display checks only; no algebra, LaTeX evaluation or text repair. */
export function scanTeachingDisplay(result) {
  const findings = [], warnings = [];
  for (const [fieldPath, value] of classroomFields(result)) {
    for (const match of value.matchAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu)) {
      findings.push({ code: 'control_character', fieldPath, start: match.index, end: match.index + 1, unicode: `U+${match[0].charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}` });
    }
    // A serialized newline can survive as two visible characters. Require a
    // display boundary so LaTeX commands such as \nabla, \nu and \not stay intact.
    for (const match of value.matchAll(/\\n(?=$|[\s\p{Script=Han}\p{P}$])/gu)) {
      if (!isEscaped(value, match.index)) {
        findings.push({ code: 'literal_newline_escape', fieldPath, start: match.index, end: match.index + 2 });
      }
    }
    let opening = null;
    for (let i = 0; i < value.length; i++) {
      let token;
      if (value[i] === '$' && !isEscaped(value, i)) {
        token = value[i + 1] === '$' ? '$$' : '$';
      } else if (value[i] === '\\' && !isEscaped(value, i) && /[()[\]]/u.test(value[i + 1] ?? '')) {
        token = value.slice(i, i + 2);
      } else continue;
      const closing = { '\\)': '\\(', '\\]': '\\[' }[token];
      const pairedDollar = token === '$' || token === '$$';
      if (closing) {
        if (opening?.token === closing) opening = null;
        else findings.push({ code: 'unpaired_math_delimiter', fieldPath, start: i, end: i + token.length, delimiter: token });
      } else if (pairedDollar && opening?.token === token) {
        opening = null;
      } else if (!opening) {
        opening = { token, start: i };
      } else {
        findings.push({ code: 'mixed_math_delimiter', fieldPath, start: i, end: i + token.length, delimiter: token });
      }
      if (token.startsWith('\\')) warnings.push({ code: 'alternate_math_delimiter', fieldPath, start: i, end: i + token.length, delimiter: token });
      i += token.length - 1;
    }
    if (opening) findings.push({ code: 'unpaired_math_delimiter', fieldPath, start: opening.start, end: opening.start + opening.token.length, delimiter: opening.token });
  }
  return { findings, warnings };
}

/**
 * Explicit offline maintenance. One fresh semantic review is required even
 * when the failed candidate has no lexical hits. Transport and exact request/
 * response audit belong to the caller. No JSON repair or fallback is applied.
 * A no-known-flags status is not independent mathematical verification.
 */
export async function runTeachingFormatRecovery({ originalMaterial, rawCandidate, formatFindings, review, validateDisplay }) {
  const original = structuredClone(originalMaterial);
  if (!original || typeof original.questionId !== 'string' || !original.questionId.trim()) throw invalid('missing_question_identity');
  if (typeof review !== 'function' || (validateDisplay !== undefined && typeof validateDisplay !== 'function')) throw invalid('missing_model_callbacks');
  if (typeof rawCandidate !== 'string' && (!rawCandidate || typeof rawCandidate !== 'object')) throw invalid('missing_raw_candidate');
  if (!Array.isArray(formatFindings)) throw invalid('missing_format_findings');
  const output = {
    recoveryVersion: 'teaching-format-recovery-v1', questionId: original.questionId,
    originalCandidate: structuredClone(rawCandidate), originalFormatFindings: structuredClone(formatFindings),
    reviewedCandidate: null, recoveredResult: null, finalResult: null,
    reviewCalls: 0, textComplete: false, termScan: null, displayScan: null,
    needsReviewReasons: [], error: null,
  };
  let phase = 'review';
  try {
    output.reviewCalls = 1;
    const returned = await review({ originalMaterial: structuredClone(original), rawCandidate: structuredClone(rawCandidate), formatFindings: structuredClone(formatFindings) });
    output.reviewedCandidate = structuredClone(returned);
    phase = 'validation';
    let parsed = returned;
    if (typeof returned === 'string') {
      try { parsed = JSON.parse(returned); } catch { throw invalid('invalid_review_json'); }
    }
    const checked = validateTeachingResult(parsed, original.questionId);
    output.recoveredResult = structuredClone(parsed);
    output.textComplete = checked.textComplete;
    output.termScan = scanTeachingTerms(parsed);
    output.displayScan = scanTeachingDisplay(parsed);
    if (validateDisplay) {
      phase = 'display_validation';
      const extra = await validateDisplay(structuredClone(parsed));
      if (!extra || !Array.isArray(extra.findings) || !Array.isArray(extra.warnings)) throw invalid('invalid_display_validation');
      output.displayScan.findings.push(...structuredClone(extra.findings));
      output.displayScan.warnings.push(...structuredClone(extra.warnings));
    }
    if (!checked.textComplete) output.needsReviewReasons.push({ code: 'incomplete_result' });
    if (parsed.issues.length) output.needsReviewReasons.push({ code: 'model_reported_issues', issues: structuredClone(parsed.issues) });
    if (output.termScan.findings.length) output.needsReviewReasons.push({ code: 'remaining_term_hits', count: output.termScan.findings.length });
    if (output.displayScan.findings.length) output.needsReviewReasons.push({ code: 'remaining_format_findings', count: output.displayScan.findings.length });
    const status = output.needsReviewReasons.length ? 'needs_review' : 'reviewed_no_known_flags';
    return { ...output, status, finalResult: status === 'reviewed_no_known_flags' ? structuredClone(parsed) : null };
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/u.test(error.code) ? error.code : 'model_or_validation_failed';
    return { ...output, finalResult: null, status: 'recovery_failed', error: { phase, code }, needsReviewReasons: [...output.needsReviewReasons, { code: 'format_recovery_failed' }] };
  }
}
