import test from 'node:test';
import assert from 'node:assert/strict';
import { compactSourceLabel, embeddedExamSource, questionSource, questionSourcePresentation, sourceCaption } from '../src/shared/source-label.mjs';

const question = () => ({ questionId: 'q1', student: { stem: '判断充分必要条件', options: [] }, teacher: { answers: ['C'] },
  contentVersion: 'c1', teacherVersion: 't1', sourceRefs: [{ sourceId: 'import1', pages: [1], locator: '第2题（旧题 ID 6447；原卷题号：3）' }],
  verification: { origin: { sourceQuestionId: '6447', sourceContentVersionId: 5393, sourceExamId: 256, sourceOccurrenceId: 6445,
    studentContentHash: 'a'.repeat(64), sourceEvidenceHash: 'b'.repeat(64) } } });

test('visible source retains exam title and original number without exposing internal identifiers', () => {
  const q = question();
  q.verification.origin.sourceTitle = '2025-2026学年五校十月联考数学';
  q.verification.origin.sourceQuestionNumber = '3';
  assert.equal(sourceCaption(questionSource(q)), '来源：2025-2026学年五校十月联考数学 · 原卷第 3 题');
  assert.doesNotMatch(sourceCaption(questionSource(q)), /6447|5393|import1/);
});

test('missing exam title honestly falls back to material and unknown citation', () => {
  const q = question();
  const source = questionSource(q, { sources: [{ sourceId: 'import1', label: '第一章教学材料' }] });
  assert.equal(sourceCaption(source), '收录材料：第一章教学材料 · 原卷第 3 题');
  assert.equal(sourceCaption(questionSource(q)), '来源未标注');
});

test('inline exam citation is retained without duplicated caption, math and part numbers are not sources', () => {
  const q = question(); q.student.stem = '（2025秋·南充校级期中）能构成集合的是';
  assert.equal(questionSource(q).embedded, true);
  assert.equal(questionSource(q).label, '2025秋·南充校级期中');
  for (const stem of ['(2) $(x-1)^2=0$ 是什么条件', '（x>0）时求解', '（本题共三小问）回答', '(2025) 是一个正整数', '(2025+x) 的值']) assert.equal(embeddedExamSource(stem), '');
});

test('compact citation puts the exam year first and shortens standard exam names', () => {
  assert.equal(compactSourceLabel({ kind: 'exam', label: '上海市崇明区2025届高三第二次模拟考试数学' }), '2025·上海市崇明区二模');
  assert.equal(compactSourceLabel({ kind: 'exam', label: '2025秋·南充校级期中' }), '2025·南充期中');
  assert.equal(compactSourceLabel({ kind: 'exam', label: '2025-2026学年五校十月联考数学' }), '2025-2026·五校十月联考');
  assert.equal(compactSourceLabel({ kind: 'exam', label: '“元三维大联考”2023级高三第一次诊断考试数学' }), '元三维大联考2023级一诊');
  assert.equal(compactSourceLabel({ kind: 'exam', label: '2025年四川省南充高中高三第二次模拟考试数学' }), '2025·四川省南充高中二模');
  assert.equal(compactSourceLabel({ kind: 'exam', label: '2025年某某高级中学高一期中数学试卷' }), '2025·某某高级中学期中');
  assert.equal(compactSourceLabel({ kind: 'material', label: '第一章教学材料' }), '第一章教学材料');
  assert.equal(compactSourceLabel({ kind: 'unknown', label: '来源未标注' }), '来源未标注');
});

test('display projection replaces an embedded citation once without changing stored stem or subquestion numbers', () => {
  const q = question();
  q.student.stem = '(2) （2025秋·南充校级期中）判断 $a>0$，并说明原因。';
  const snapshot = structuredClone(q);
  const display = questionSourcePresentation(q);
  assert.equal(display.label, '2025·南充期中');
  assert.equal(display.stem, '(2) 判断 $a>0$，并说明原因。');
  assert.equal(display.caption, '来源：2025秋·南充校级期中');
  assert.deepEqual(q, snapshot);
  q.student.stem = '(2) $(x-1)^2=0$ 是什么条件';
  assert.equal(questionSourcePresentation(q).stem, q.student.stem);
});
