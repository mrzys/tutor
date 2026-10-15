// This is an authorization check, not a natural-language intake parser. It
// never changes a count or derives a total from incomplete type requirements.
const numeral = '[0-9零〇一二两三四五六七八九十百]+';
const typeName = '(?:单选(?:题)?|单项选择题|选择题|填空(?:题)?|解答(?:题)?|主观题|客观题)';

function number(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value.length === 1 && Object.hasOwn(digits, value)) return digits[value];
  if (/^[一二两三四五六七八九]?十[零〇一二三四五六七八九]?$/.test(value)) {
    const [tens, ones] = value.split('十'); return (digits[tens] ?? 1) * 10 + (digits[ones] ?? 0);
  }
  if (/^[一二两三四五六七八九]百(?:[零〇]?[一二三四五六七八九])?$/.test(value)) {
    return digits[value[0]] * 100 + (digits[value.at(-1)] ?? 0);
  }
  return null;
}

export function quantityDirective(message = '') {
  const text = String(message ?? '').replace(/[０-９]/g, value => String(value.charCodeAt(0) - 0xff10));
  const events = [];
  const totals = [...text.matchAll(new RegExp(`(${numeral})\\s*(?:道|个)?\\s*(?:练习题|基础题|题目|试题|题)(?![型位号])`, 'g'))];
  // A bare measure needs an explicit paper-size verb and a clause boundary;
  // “增加2道填空” and “出12道单选” remain relative/type requirements.
  for (const match of text.matchAll(new RegExp(`(?:出|组|要|安排|改成|改为|调整为)\\s*(${numeral})\\s*道(?=\\s*(?:$|[，,。；;\\n]))`, 'g'))) {
    totals.push({ 1: match[1], index: match.index + match[0].indexOf(match[1]) });
  }
  for (const match of totals) {
    const before = text.slice(0, match.index);
    const clause = before.split(/[。；;\n]/).at(-1);
    // Ordinal/range references, examples and relative additions/removals are
    // not a new absolute total. A type-qualified count is handled separately.
    if (/(?:第\s*|第[0-9零〇一二两三四五六七八九十、，,到至\-—～~\s]*|例如[:：]?\s*|比如\s*)$/.test(clause)
        || /(?:不要|不能|不是|不超过|至少|最多|不满|不足|只有|其中|最后|换|换成|替换|替换成)\s*$/.test(clause)
        || /(?:新增|增加|添加|补充|再加|加上|删掉|删除|去掉|减少|减去)\s*$/.test(clause)) continue;
    const value = number(match[1]);
    if (value !== null) events.push({ at: match.index, exactTotal: value });
  }
  // Explicit edits may authorize changing the total without defining its
  // absolute value. Never guess the size of “几道” or infer a new fixed ratio.
  const relative = new RegExp(`(?:新增|增加|添加|补充|再加|加上|删掉|删除|去掉|减少|减去)\\s*(?:(?:第\\s*)?${numeral}|几|一些|一部分)\\s*(?:道|个)?(?:[^。；;\\n]{0,18}?(?:题|单选|填空|解答))`, 'g');
  for (const match of text.matchAll(relative)) events.push({ at: match.index, exactTotal: null });
  for (const match of text.matchAll(/(?:删除|删掉|去掉)\s*(?:最后|这|那|所选|选中|全部|所有)(?:一(?:道)?)?题/g)) events.push({ at: match.index, exactTotal: null });
  const typeCounts = [...text.matchAll(new RegExp(`(${numeral})\\s*(?:道|题|个)?\\s*${typeName}`, 'g'))];
  const revisedTypeCounts = typeCounts.some(match => /(?:改成|改为|调整为|只出|只要|全部|全是|都出)\s*$/.test(text.slice(0, match.index)));
  if (typeCounts.length >= 2 || revisedTypeCounts) {
    // A ratio following an explicit total describes that total. Only an
    // explicit subsequent revision may supersede it, without guessing a sum.
    events.push({ at: typeCounts.at(-1).index, exactTotal: null, preserveTotal: true });
    for (const match of typeCounts) if (/(?:改成|改为|调整为)\s*$/.test(text.slice(0, match.index))) {
      events.push({ at: match.index, exactTotal: null });
    }
  }
  if (typeCounts.length === 1) {
    const match = typeCounts[0];
    const prefix = text.slice(0, match.index).split(/[，,。；;\n]/).at(-1).trim();
    const explicitRevision = /(?:改成|改为|调整为)\s*$/.test(prefix);
    const standaloneRequest = /^(?:(?:补充需求|补充要求|需求)\s*[:：]\s*)?(?:请\s*)?(?:出|组|安排|要|需要)?\s*$/.test(prefix);
    const precedingTotal = events.some(event => event.at < match.index && event.exactTotal !== null);
    // “4道单选” is a complete paper request in the quick composer. In a
    // previously stated total, “其中3道填空” remains only a local constraint.
    if (explicitRevision || (standaloneRequest && !precedingTotal)) {
      const value = number(match[1]);
      if (value !== null) events.push({ at: match.index, exactTotal: value });
    }
  }
  events.sort((a, b) => a.at - b.at);
  let exactTotal = null;
  for (const event of events) if (!event.preserveTotal) exactTotal = event.exactTotal;
  return { allowsChange: events.length > 0, exactTotal };
}
