import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTeachingDisplay } from '../lib/teaching-display-normalize.mjs';
const draft = text => ({ questionId: 'simulated-display', answer: '2', difficultyAssessment: { level: 'easy', basis: '模拟显示适配' }, teachingSolution: text, teachingFocusSchemaVersion: 2, teachingFocus: { examFocus: '模拟加法', studentRequirements: ['能计算'] }, issues: [] });

test('paired rendering delimiters change without changing formula content or model input', () => {
  const source = draft(String.raw`由 \(a+b=2\)，得\[\frac1a+\frac1b\ge2\]。`);
  const original = structuredClone(source);
  const out = normalizeTeachingDisplay(source);
  assert.equal(out.result.teachingSolution, String.raw`由 $a+b=2$，得$$\frac1a+\frac1b\ge2$$。`);
  assert.equal(out.changes[0].delimitersReplaced, 4);
  assert.deepEqual(out.blockedBy, []); assert.deepEqual(source, original);
});

test('existing dollar formulas, escaped dollars, newlines and commands stay unchanged', () => {
  const source = draft(String.raw`\$5，$\nu+\nabla f$，$$\frac12$$` + '\n' + String.raw`\\(文字)`);
  const out = normalizeTeachingDisplay(source);
  assert.deepEqual(out.result, source); assert.deepEqual(out.changes, []);
});

test('incomplete delimiters, literal newline escapes and control characters are blocked, never repaired', () => {
  for (const text of [String.raw`\(x=1`, String.raw`由题意\n可得`, '计算\u000c出错']) {
    const source = draft(text), out = normalizeTeachingDisplay(source);
    assert.deepEqual(out.result, source); assert.deepEqual(out.changes, []); assert(out.blockedBy.length > 0);
  }
});

test('all teaching fields are adapted while identities and unrelated data are preserved', () => {
  const source = draft('原讲解');
  source.answer = String.raw`\(2\)`; source.difficultyAssessment.basis = String.raw`计算\(1+1\)`;
  source.teachingFocus.examFocus = String.raw`求\(2\)`; source.teachingFocus.studentRequirements = [String.raw`能求\(2\)`];
  source.issues = [String.raw`参考\(2\)`]; source.auditOnly = String.raw`\(不改\)`;
  const out = normalizeTeachingDisplay(source);
  assert.equal(out.changes.length, 5); assert.equal(out.result.auditOnly, source.auditOnly);
  assert.equal(out.result.questionId, source.questionId); assert.equal(out.result.answer, '$2$');
});
