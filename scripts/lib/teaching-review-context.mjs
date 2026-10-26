import { isDeepStrictEqual } from 'node:util';

// Transport projection only. The pipeline retains its full original candidates
// and findings; no source, proof, issue or match position is discarded here.
export function compactTeachingReviewContext(input) {
  const out = structuredClone(input);
  if (!out || typeof out !== 'object' || Array.isArray(out)) return out;
  if (out.candidate != null && isDeepStrictEqual(out.candidate, out.rawCandidate)) {
    out.rawCandidate = null;
    out.rawCandidateSameAsCandidate = true;
  }
  const rules = [];
  for (const finding of out.reviewFindings ?? []) {
    if (typeof finding?.guidance === 'string' && finding.guidance) {
      let index = rules.findIndex(rule => rule.ruleId === finding.ruleId && rule.guidance === finding.guidance);
      if (index < 0) {
        index = rules.length;
        rules.push({ ruleId: finding.ruleId, guidance: finding.guidance });
      }
      finding.reviewGuidanceIndex = index;
      delete finding.guidance;
    }
    // Older Rust scans stored the whole field in each excerpt. The full field
    // remains in candidate; send a Unicode-safe local context for each match.
    const text = generatedField(out.candidate, finding?.fieldPath);
    if (typeof text === 'string' && Number.isInteger(finding.start) && Number.isInteger(finding.end)
      && finding.start >= 0 && finding.end >= finding.start && finding.end <= text.length) {
      const before = Array.from(text.slice(0, finding.start)).slice(-40).join('');
      const after = Array.from(text.slice(finding.end)).slice(0, 40).join('');
      finding.excerpt = before + text.slice(finding.start, finding.end) + after;
    }
  }
  if (rules.length) out.reviewRules = rules;
  return out;
}

function generatedField(candidate, path) {
  if (['answer', 'teachingSolution'].includes(path)) return candidate?.[path];
  if (path === 'difficultyAssessment.basis') return candidate?.difficultyAssessment?.basis;
  if (path === 'teachingFocus.examFocus') return candidate?.teachingFocus?.examFocus;
  const match = /^teachingFocus\.studentRequirements\[(\d+)\]$/u.exec(path ?? '');
  return match ? candidate?.teachingFocus?.studentRequirements?.[Number(match[1])] : undefined;
}
