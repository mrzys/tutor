const text = value => typeof value === 'string' ? value.trim() : '';

// Import preview already prints the preserved original number separately.
// Remove only an exact repeated decimal question heading from the view copy;
// never remove bracketed subparts, decimal values, scores, or stored source text.
export function importPreviewStem(stem, sourceLabel) {
  if (typeof stem !== 'string') return '';
  const label = String(sourceLabel ?? '').trim().match(/^(?:\d+|[（(]\d+[）)])$/u);
  if (!label) return stem;
  const number = label[0].replace(/[（）()]/gu, '');
  const prefix = stem.match(/^\s*(\d+)[.．、](?!\d)\s*/u);
  return prefix?.[1] === number ? stem.slice(prefix[0].length) : stem;
}

// A subquestion number or a mathematical condition is never a source citation.
export function embeddedExamSource(stem) {
  const match = text(stem).match(/^(?:[（(]\d+[）)]\s*)?[（(]([^（）()\n]{3,160})[）)]/u);
  const label = match?.[1] || '';
  const exam = /期[中末]|月考|联考|模拟|高考|校级|一模|二模|开学考/u.test(label);
  const datedSource = /(?:19|20)\d{2}/u.test(label) && /\p{Script=Han}/u.test(label);
  return exam || datedSource ? label.trim() : '';
}

export function questionSource(question, manifest) {
  const supplied = question?.source;
  if (supplied && ['exam', 'material', 'unknown'].includes(supplied.kind) && typeof supplied.label === 'string') return supplied;
  const origin = question?.verification?.origin;
  const embedded = embeddedExamSource(question?.student?.stem);
  const title = text(origin?.sourceTitle);
  const sourceNumber = origin?.sourceQuestionNumber;
  const number = typeof sourceNumber === 'number' || typeof sourceNumber === 'string' ? String(sourceNumber).trim() : '';
  if (title || embedded) return { kind: 'exam', label: title || embedded, number, embedded: Boolean(embedded) };
  const sources = Array.isArray(manifest) ? manifest : manifest?.sources ?? [];
  for (const ref of question?.sourceRefs ?? []) {
    const source = sources.find(item => item.sourceId === ref.sourceId);
    const filename = text(source?.path).split(/[\\/]/u).at(-1)?.replace(/\.[^.]+$/u, '').replace(/_/gu, ' ');
    const material = text(source?.label) || filename;
    if (!material) continue;
    const original = text(ref.locator).match(/原卷题号[：:]\s*([^）);；,，]+)/u)?.[1]?.trim();
    return { kind: 'material', label: material, number: original && !/未提供|未知/u.test(original) ? original : '', embedded: false };
  }
  return { kind: 'unknown', label: '来源未标注', number: '', embedded: false };
}

export function sourceCaption(source) {
  if (source.kind === 'unknown') return source.label;
  return `${source.kind === 'exam' ? '来源' : '收录材料'}：${source.label}${source.number ? ` · 原卷第 ${source.number} 题` : ''}`;
}

// Display-only wording. The full source and original question number stay intact.
export function compactSourceLabel(source) {
  if (source.kind === 'unknown') return source.label;
  if (source.kind !== 'exam') return source.label;
  let label = text(source.label).replace(/[“”"《》]/gu, '');
  // An enrolment cohort (2023级) must not become an asserted examination year.
  const year = label.match(/(?:19|20)\d{2}(?:[-—–至](?:19|20)\d{2})?(?!\d|级)/u)?.[0] || '';
  if (year) label = label.replace(year, '').replace(/^[年届学期秋春·\s-]+|^[学年]+/u, '');
  label = label
    .replace(/(?:第?[一二三四五六七八九十\d]+次|第[一二三四五六七八九十\d]+轮)模拟(?:考试|测试)?/gu, match => /[二2]/u.test(match) ? '二模' : /[三3]/u.test(match) ? '三模' : /[一1]/u.test(match) ? '一模' : match)
    .replace(/第一次诊断(?:性)?(?:考试|测试)|一诊(?:断)?(?:性)?(?:考试|测试)/gu, '一诊')
    .replace(/第二次诊断(?:性)?(?:考试|测试)/gu, '二诊')
    .replace(/第三次诊断(?:性)?(?:考试|测试)/gu, '三诊')
    .replace(/高[一二三]|[一二三]年级|校级|数学(?:试卷|试题)?|试题及答案|试题|试卷/gu, '')
    .replace(/学年度?|年度|届/gu, '')
    .replace(/^[\s·:：,，;；—–-]+|[\s·:：,，;；—–-]+$/gu, '')
    .replace(/\s+/gu, '');
  return [year, label].filter(Boolean).join('·') || source.label;
}

export function questionSourcePresentation(question, manifest) {
  const source = questionSource(question, manifest);
  let stem = text(question?.student?.stem);
  const embedded = embeddedExamSource(stem);
  if (embedded) {
    // Preserve any leading subquestion number; remove only the detected citation.
    const start = stem.indexOf(embedded);
    stem = `${stem.slice(0, start - 1)}${stem.slice(start + embedded.length + 1)}`.trim();
  }
  return { source, label: compactSourceLabel(source), caption: sourceCaption(source), stem };
}
