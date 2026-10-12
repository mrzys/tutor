// Content-based model bands are useful planning evidence, never a calibrated
// student success probability or a numeric whole-paper difficulty estimate.
export function difficultyView(annotation) {
  const basis = annotation?.difficultyBasis;
  if (basis?.method !== 'llm_estimate' || basis.empirical !== false
      || !['easy', 'medium', 'hard'].includes(annotation?.difficultyLevel)
      || typeof basis.rationale !== 'string' || !basis.rationale.trim()) {
    return { level: 'unknown', method: 'unknown', empirical: false };
  }
  return { level: annotation.difficultyLevel, method: 'llm_estimate', empirical: false,
    rationale: basis.rationale.slice(0, 1200) };
}

export function difficultyDistribution(candidates) {
  return candidates.reduce((counts, candidate) => {
    counts[candidate.difficulty.level]++;
    return counts;
  }, { easy: 0, medium: 0, hard: 0, unknown: 0 });
}
