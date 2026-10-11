import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import katex from 'katex';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['001-025', '026-050', 'replacements'].map(n => `data/question-bank/staging/set-expansion-50-${n}.json`);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const read = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const exclusions = {
  'SET-EXP50-010': '原题四个选项均不等于实际交集 [-2,1)。',
  'SET-EXP50-019': '源答只给 a=0；a=-2 也使并集含四元素，依赖未明写的集合元素个数条件。',
  'SET-EXP50-028': '源 PDF 不等号乱码，无法可靠恢复题面。',
  'SET-EXP50-031': '源 PDF 的 C、D 选项关系符号缺失。',
  'SET-EXP50-046': '未明写元素个数条件；a=-1、1、2 均满足，源选项未给出完整答案。',
  'SET-EXP50-049': '源 B 选项含未定义的大写 I，不能擅自恢复为差集。',
};

export function buildExpansion() {
  const sourceBundles = files.map(file => ({ path: file, sha256: digest(fs.readFileSync(path.join(root, file))) }));
  const all = files.flatMap(file => read(file).items);
  const seen = new Set();
  const sources = new Map();
  let mathExpressions = 0;
  for (const item of all) {
    assert(!seen.has(item.id), `重复 ID: ${item.id}`);
    seen.add(item.id);
    assert.equal(item.reviewStatus, 'pending_review');
    assert.equal(item.verification.sourceVisualChecked, true);
    assert(['single_choice', 'multiple_choice'].includes(item.questionType));
    assert.equal(item.student.options.length, 4);
    assert.deepEqual(item.student.options.map(x => x.label), ['A', 'B', 'C', 'D']);
    assert(item.student.stem.trim());
    assert(Number.isInteger(item.source.pdfPage) && item.source.pdfPage > 0);
    if (!sources.has(item.source.path)) sources.set(item.source.path, digest(fs.readFileSync(item.source.path)));
    assert.equal(sources.get(item.source.path), item.source.sha256, `${item.id} 来源哈希变更`);
    for (const answer of item.teacher.answers) {
      assert(['source', 'generated'].includes(answer.provenance));
      if (answer.provenance === 'source') {
        assert(answer.sourceFile && answer.pages.length);
        assert(answer.pages.every(p => Number.isInteger(p) && p > 0));
        if (!sources.has(answer.sourceFile)) sources.set(answer.sourceFile, digest(fs.readFileSync(answer.sourceFile)));
      }
    }
    if (!exclusions[item.id]) {
      assert.equal(item.verification.blockingIssues?.length ?? 0, 0, `${item.id} 尚有阻断问题`);
      assert.equal(item.verification.sourceIssues?.length ?? 0, 0, `${item.id} 尚有来源问题`);
      assert(/^[ABCD]+$/.test(item.teacher.answers[0].text), `${item.id} 答案格式`);
      const answerLength = item.teacher.answers[0].text.length;
      assert(item.questionType === 'single_choice' ? answerLength === 1 : answerLength > 1);
    }
    // Defective source transcriptions remain in the audit bundles, not the accepted collection.
    if (!exclusions[item.id]) {
      const strings = [item.student.stem, ...item.student.options.map(o => o.text),
        ...item.teacher.solutions.map(s => s.text), ...item.teacher.answers.map(a => a.text)];
      for (const value of strings) {
        for (const match of value.matchAll(/\$([^$]+)\$/g)) {
          katex.renderToString(match[1], { throwOnError: true, strict: 'error', output: 'html' });
          mathExpressions++;
        }
      }
    }
  }
  assert.equal(all.length, 56);
  for (const id of Object.keys(exclusions)) assert(seen.has(id));
  const replacements = all.filter(i => i.replaces);
  assert.equal(replacements.length, 6);
  assert.deepEqual(replacements.map(i => i.replaces).sort(), Object.keys(exclusions).sort());
  const items = all.filter(i => !exclusions[i.id]);
  assert.equal(items.length, 50);
  const canonical = item => JSON.stringify([item.student.stem, item.student.options]).replace(/\s+/g, '');
  assert.equal(new Set(items.map(canonical)).size, 50, '题面完全重复');
  const published = fs.readdirSync(path.join(root, 'data/question-bank/questions')).filter(f => f.endsWith('.json'))
    .map(f => read(`data/question-bank/questions/${f}`));
  const publishedSignatures = new Set(published.filter(i => i.student).map(canonical));
  for (const item of items) assert(!publishedSignatures.has(canonical(item)), `${item.id} 与现有题面完全重复`);
  return {
    schemaVersion: 1,
    status: 'transcribed_pending_review',
    isSelectableCandidate: false,
    sourceBundles,
    policy: '保留跨章及拓展题；可见依赖不等于完整解法依赖。此集合未注册入可选题库，不能作为已覆盖教学目标或已标定难度的证据。',
    items,
    excluded: Object.entries(exclusions).map(([id, reason]) => ({ id, reason, replacementId: replacements.find(i => i.replaces === id).id })),
    sourceFiles: [...sources].map(([file, sha256]) => ({ path: file, sha256 })),
    summary: { inspected: 56, collected: 50, excluded: 6,
      singleChoice: items.filter(i => i.questionType === 'single_choice').length,
      multipleChoice: items.filter(i => i.questionType === 'multiple_choice').length,
      sourceAnswers: items.filter(i => i.verification.answerStatus === 'source_checked').length,
      independentlyProposedAnswers: items.filter(i => i.verification.answerStatus === 'independent_proposed').length,
      published: 0, mathExpressions },
  };
}

const output = 'data/question-bank/staging/set-expansion-50.json';
const result = buildExpansion();
if (process.argv.includes('--write')) fs.writeFileSync(path.join(root, output), JSON.stringify(result, null, 2) + '\n');
else assert.deepEqual(read(output), result, '汇总过期，请显式 --write 重建');
console.log(JSON.stringify(result.summary, null, 2));
