/** An explicit-operation safety net, not a complete prerequisite classifier.
 * Pass solution text only: question stems, distractors and syllabus labels are not evidence.
 */
const rules = [
  { kind: 'derivative_application', title: '导数在研究函数中的应用', pattern: /(?:利用|根据|由|通过|结合)[^。；\n]{0,24}(?:导数|求导)[^。；\n]{0,60}(?:单调|极值|最值|恒成立|零点)|(?:求导|导数|[fy]\s*['′])[^。；\n]{0,100}(?:单调|极值|最值|恒成立)/u },
  { kind: 'derivative_calculation', title: '导数的运算', pattern: /求导|导数(?:为|等于|公式|运算)|[fy]\s*['′]\s*\([^)]*\)\s*=|\\(?:prime|mathrm\{d\})/u },
  { kind: 'exponential_function', title: '指数函数', pattern: /(?:利用|根据|由|结合)[^。；\n]{0,20}指数函数|指数函数[^。；\n]{0,35}(?:单调|增函数|减函数|值域|图象)|(?:解|求解|化简)[^。；\n]{0,16}指数(?:不等式|方程)/u },
  { kind: 'exponent_operation', title: '指数', pattern: /(?:利用|根据|运用|按)[^。；\n]{0,15}指数(?:运算|法则|性质)|(?:指数|分数指数幂|有理数指数幂)[^。；\n]{0,12}(?:运算|化简|计算|互化)|根式[^。；\n]{0,15}分数指数幂[^。；\n]{0,12}互化/u },
  { kind: 'logarithmic_function', title: '对数函数', pattern: /(?:利用|根据|由|结合)[^。；\n]{0,20}对数函数|对数函数[^。；\n]{0,35}(?:单调|增函数|减函数|值域|图象)|(?:解|求解)[^。；\n]{0,16}对数(?:不等式|方程)/u },
  { kind: 'logarithm_operation', title: '对数', pattern: /(?:利用|根据|运用|按)[^。；\n]{0,15}对数(?:运算|法则|性质|定义)|(?:对数|换底公式)[^。；\n]{0,12}(?:运算|化简|计算|换底)/u },
  { kind: 'function_domain_range', title: '函数的概念及其表示', pattern: /(?:求|确定|计算|利用|根据|由|结合)[^。；\n]{0,35}函数[^。；\n]{0,35}(?:值域|定义域)|(?:求|确定|计算)[^。；\n]{0,25}(?:函数的值域|函数的定义域)|(?:值域|定义域)(?:为|是|等于|可得|得)/u },
  { kind: 'function_properties', title: '函数的基本性质', pattern: /(?:利用|根据|运用|结合)[^。；\n]{0,25}(?:奇偶性|函数的单调性)|(?:判断|证明|求出|确定)[^。；\n]{0,30}(?:奇偶性|单调区间)/u },
  { kind: 'trig_identity', title: '三角恒等变换', pattern: /(?:利用|根据|运用|结合)[^。；\n]{0,20}(?:二倍角|半角|和差角|两角和|两角差|三角恒等)/u },
  { kind: 'trig_reduction', title: '诱导公式', pattern: /(?:利用|根据|运用|结合)[^。；\n]{0,15}诱导公式/u },
  { kind: 'trig_properties', title: '三角函数的图象与性质', pattern: /(?:利用|根据|运用|结合)[^。；\n]{0,20}(?:正弦|余弦|正切|三角函数)[^。；\n]{0,30}(?:单调|周期|图象|值域)/u },
];

function flatten(catalog) {
  const roots = Array.isArray(catalog) ? catalog : catalog?.books ?? catalog?.textbooks ?? [];
  return roots.flatMap(value => value.chapters ? value.chapters.flatMap(chapter => chapter.sections ?? []) : value.sections ?? [value]);
}

export function extractSolutionDependencies(text, catalog) {
  const sections = flatten(catalog);
  // Negated/avoided methods are not used methods. Preserve other sentences.
  const solution = String(text ?? '').replace(/(?:不需要|无需|不用|不使用|不采用|避免使用)[^，。；\n]{0,25}(?:导数|求导|指数函数|对数函数|三角函数)/gu, '');
  const findings = [], unmapped = [];
  for (const rule of rules) {
    const match = rule.pattern.exec(solution);
    if (!match) continue;
    const section = sections.find(value => (value.title ?? value.label?.replace(/^\d+\.\d+\s*/, '')) === rule.title);
    const finding = { kind: rule.kind, title: rule.title, sectionIds: section ? [section.id] : [], evidence: match[0] };
    findings.push(finding);
    if (!section) unmapped.push({ kind: rule.kind, title: rule.title, evidence: match[0] });
  }
  // Application of a derivative already entails derivative operations at a later section.
  // Require that application section rather than redundantly requiring both sections.
  const filtered = findings.some(value => value.kind === 'derivative_application')
    ? findings.filter(value => value.kind !== 'derivative_calculation') : findings;
  return { requiredSectionIds: [...new Set(filtered.flatMap(value => value.sectionIds))],
    findings: filtered, unmapped, coverage: 'explicit_solution_operations_only' };
}

export function validateSolutionDependencies(text, catalog, requiredSectionIds = []) {
  const extracted = extractSolutionDependencies(text, catalog);
  const missingSectionIds = extracted.requiredSectionIds.filter(id => !requiredSectionIds.includes(id));
  return { ...extracted, ok: missingSectionIds.length === 0 && extracted.unmapped.length === 0, missingSectionIds };
}
