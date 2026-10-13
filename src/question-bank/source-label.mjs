const text = value => typeof value === 'string' ? value.trim() : '';

// A subquestion number or a mathematical condition is never a source citation.
export function embeddedExamSource(stem) {
  const match = text(stem).match(/^(?:[（(]\d+[）)]\s*)?[（(]([^（）()\n]{3,160})[）)]/u);
  return match && /(?:19|20)\d{2}|期[中末]|月考|联考|模拟|高考|校级|一模|二模|开学考/u.test(match[1]) ? match[1].trim() : '';
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
