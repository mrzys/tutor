import { canonicalSectionId } from '../curriculum/section-identity.mjs';
import { purposeFor } from './purposes.mjs';

const sectionTopics = Object.freeze({
  '1.1': '集合的概念', '1.2': '集合间的基本关系', '1.3': '集合的基本运算',
  '1.4': '充分条件与必要条件', '1.5': '全称量词与存在量词',
  '2.1': '等式与不等式性质', '2.2': '基本不等式', '2.3': '二次函数与不等式',
});
const limit = (text, length = 20) => Array.from(text).length <= length ? text : `${Array.from(text).slice(0, length - 1).join('')}…`;

function scopeEntries(scope = [], config = {}) {
  const chapters = config.chapters ?? [];
  const ids = [...new Set(scope.map(canonicalSectionId))];
  return ids.map(id => ({ id, label: chapters.find(item => canonicalSectionId(item.id) === id)?.label ?? '' }));
}

function topicFor(entries) {
  if (!entries.length) return '数学练习';
  // These abbreviations only describe the supported 人教 A 版必修第一册;
  // matching section numbers from another book must not inherit its topic.
  const sections = entries.map(({ id }) => id.match(/^rja-compulsory-1:([12]\.\d+)$/)?.[1]);
  if (sections.every(Boolean)) {
    if (sections.length === 1 && sectionTopics[sections[0]]) return sectionTopics[sections[0]];
    if (sections.every(id => /^1\.[1-3]$/.test(id))) return '集合';
    if (sections.every(id => /^1\.[45]$/.test(id))) return '常用逻辑用语';
    if (sections.every(id => /^1\./.test(id))) return '集合与逻辑';
    if (sections.every(id => /^2\./.test(id))) return '不等式';
    return '集合与不等式';
  }
  if (entries.length === 1 && entries[0].label) return limit(entries[0].label.replace(/^\d+(?:\.\d+)*\s*/, ''));
  return '跨章节练习';
}

export function automaticTitle(scope, purpose, config = {}) {
  return `${topicFor(scopeEntries(scope, config))} · ${purposeFor(purpose)?.label ?? '练习'}`;
}

// Recognize the previous generated form without truncating arbitrary teacher
// names. Consumers still need titleSource/rename provenance before replacing it.
export function legacyAutomaticTitle(scope, purpose, config = {}) {
  const labels = scopeEntries(scope, config).map(item => item.label).filter(Boolean);
  const scopeLabel = labels.length ? labels.join('、') : config.defaultRequirements?.title ?? '高中数学 · 跨章节练习';
  const suffix = ` · ${purposeFor(purpose)?.label ?? '练习'}`;
  const available = 120 - suffix.length;
  return `${scopeLabel.length > available ? `${scopeLabel.slice(0, available - 1)}…` : scopeLabel}${suffix}`;
}
