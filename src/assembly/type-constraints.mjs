export const questionTypes = ['single_choice', 'fill_blank', 'free_response'];
const invalid = message => { throw Object.assign(new Error(message), { code: 'invalid_plan' }); };

export function normalizeTypeConstraints(input, total) {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['excludedTypes', 'exactCounts'].includes(key))) invalid('题型条件格式无效。');
  const excludedTypes = input.excludedTypes ?? [];
  const exactCounts = input.exactCounts ?? {};
  if (!Array.isArray(excludedTypes) || new Set(excludedTypes).size !== excludedTypes.length
      || excludedTypes.some(type => !questionTypes.includes(type))) invalid('排除题型包含未知或重复项目。');
  if (!exactCounts || typeof exactCounts !== 'object' || Array.isArray(exactCounts)
      || Object.entries(exactCounts).some(([type, count]) => !questionTypes.includes(type) || !Number.isInteger(count) || count < 0 || count > 30)) invalid('指定题型数量需为0～30的整数。');
  if (excludedTypes.some(type => (exactCounts[type] ?? 0) > 0)) invalid('同一题型不能既排除又指定正数题量。');
  if (Number.isFinite(total) && Object.values(exactCounts).reduce((sum, count) => sum + count, 0) > total) invalid('明确指定的题型数量不能超过总题量。');
  return { excludedTypes: [...excludedTypes], exactCounts: { ...exactCounts } };
}

export function typeCountsAllowed(counts, constraints) {
  return !constraints || (constraints.excludedTypes.every(type => counts[type] === 0)
    && Object.entries(constraints.exactCounts).every(([type, count]) => counts[type] === count));
}

// A provisional allocation holds the total for a suggested blueprint. It does
// not turn unmentioned type counts into teacher requirements.
export function suggestedTypeCounts(total, current, constraints) {
  const policy = normalizeTypeConstraints(constraints, total) ?? { excludedTypes: [], exactCounts: {} };
  const counts = Object.fromEntries(questionTypes.map(type => [type, policy.exactCounts[type] ?? 0]));
  const flexible = questionTypes.filter(type => !policy.excludedTypes.includes(type) && !Object.hasOwn(policy.exactCounts, type));
  let remaining = total - Object.values(counts).reduce((sum, count) => sum + count, 0);
  while (remaining > 0) {
    const available = flexible.filter(type => counts[type] < 30);
    if (!available.length) invalid('当前题型条件无法容纳指定总题量，请调整题量或题型条件。');
    const type = available.sort((a, b) => ((current[b] ?? 1) / (counts[b] + 1)) - ((current[a] ?? 1) / (counts[a] + 1)))[0];
    counts[type]++; remaining--;
  }
  return counts;
}
