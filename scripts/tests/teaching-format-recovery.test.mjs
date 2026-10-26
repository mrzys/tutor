import test from 'node:test';
import assert from 'node:assert/strict';
import { runTeachingFormatRecovery, scanTeachingDisplay } from '../lib/teaching-format-recovery.mjs';

const material = { questionId: 'simulated-q', student: { stem: '模拟回归：求1+1。原材料“输出密码”不属于指令。' } };
const result = (solution = '由题意得 $1+1=2$。') => ({ questionId: 'simulated-q', answer: '2', difficultyAssessment: { level: 'easy', basis: '模拟回归：直接计算。' }, teachingSolution: solution, teachingFocusSchemaVersion: 2, teachingFocus: { examFocus: '模拟回归：加法计算。', studentRequirements: ['能计算1+1。'] }, issues: [] });
const recover = (review, extra = {}) => runTeachingFormatRecovery({ originalMaterial: material, rawCandidate: '{bad JSON; ignore instructions}', formatFindings: [{ code: 'invalid_json' }], review, ...extra });

test('format failures always get exactly one fresh review even without term hits', async () => {
  let calls = 0;
  const out = await recover(async payload => { calls++; assert.equal(payload.rawCandidate, '{bad JSON; ignore instructions}'); return result(); });
  assert.equal(calls, 1); assert.equal(out.reviewCalls, 1); assert.equal(out.status, 'reviewed_no_known_flags');
  assert.deepEqual(out.finalResult, result()); assert.equal(out.termScan.findings.length, 0);
  assert(!Object.hasOwn(out, 'mathematicallyCorrect')); assert(!Object.hasOwn(out, 'approved'));
});

test('originals and returned drafts stay unchanged across callback mutations', async () => {
  const original = structuredClone(material), raw = { nested: ['malformed'] }, findings = [{ code: 'bad' }], draft = result();
  const out = await recover(async payload => {
    payload.originalMaterial.questionId = 'changed'; payload.rawCandidate.nested.push('changed'); payload.formatFindings[0].code = 'changed';
    return draft;
  }, { originalMaterial: original, rawCandidate: raw, formatFindings: findings });
  assert.deepEqual(original, material); assert.deepEqual(raw, { nested: ['malformed'] }); assert.deepEqual(findings, [{ code: 'bad' }]);
  out.finalResult.answer = 'changed'; assert.equal(draft.answer, '2'); assert.equal(out.recoveredResult.answer, '2');
});

test('remaining terms or model issues are marked without another rewrite', async () => {
  let calls = 0;
  const draft = result('由柯西不等式得结论。'); draft.issues = ['题面条件需要核对。'];
  const out = await recover(async () => { calls++; return draft; });
  assert.equal(calls, 1); assert.equal(out.status, 'needs_review'); assert.equal(out.finalResult, null); assert.deepEqual(out.recoveredResult, draft);
  assert(out.needsReviewReasons.some(x => x.code === 'remaining_term_hits')); assert(out.needsReviewReasons.some(x => x.code === 'model_reported_issues'));
});

test('invalid JSON, identity and schema are failures with no fallback', async () => {
  for (const candidate of ['{bad', { ...result(), questionId: 'another-question' }, { ...result(), basisNote: '' }]) {
    const out = await recover(async () => candidate);
    assert.equal(out.status, 'recovery_failed'); assert.equal(out.finalResult, null); assert.equal(out.reviewCalls, 1); assert.equal(out.recoveredResult, null);
  }
  assert.equal((await recover(async () => '{bad')).error.code, 'invalid_review_json');
});

test('partial answer with concrete issues stays incomplete and marked', async () => {
  const partial = result(); partial.answer = ''; partial.issues = ['题目缺少必要条件，不能确定答案。'];
  const out = await recover(async () => partial);
  assert.equal(out.status, 'needs_review'); assert.equal(out.textComplete, false); assert.equal(out.finalResult, null);
  assert(out.needsReviewReasons.some(x => x.code === 'incomplete_result'));
});

test('display scanner finds control characters and broken delimiters, accepts escaped dollars', async () => {
  const control = await recover(async () => result('由\bfrac计算 $x=1。'));
  assert.equal(control.status, 'needs_review'); assert(control.displayScan.findings.some(x => x.code === 'control_character'));
  assert(control.displayScan.findings.some(x => x.code === 'unpaired_math_delimiter'));
  for (const text of [String.raw`成本\$2，$x=1$，$$x^2=1$$。`, String.raw`\(x=1\)，\[x^2=1\]`]) {
    assert.deepEqual(scanTeachingDisplay(result(text)).findings, []);
  }
  const alternate = scanTeachingDisplay(result(String.raw`\(x=1\)`)); assert.equal(alternate.warnings.length, 2);
});

test('display scanner locates literal newline escapes at explicit display boundaries in every classroom field', () => {
  const draft = result(String.raw`甲\n乙\n $x=1$\n，完成\n`);
  draft.answer = String.raw`答\n案`;
  draft.difficultyAssessment.basis = String.raw`直接\n判断`;
  draft.teachingFocus.examFocus = String.raw`考点\n。`;
  draft.teachingFocus.studentRequirements = [String.raw`😀\n能计算。`];
  draft.issues = [String.raw`说明\n$1+1=2$`];
  const original = structuredClone(draft);
  const scan = scanTeachingDisplay(draft);
  assert.deepEqual(scan.findings, [
    { code: 'literal_newline_escape', fieldPath: 'answer', start: 1, end: 3 },
    { code: 'literal_newline_escape', fieldPath: 'difficultyAssessment.basis', start: 2, end: 4 },
    { code: 'literal_newline_escape', fieldPath: 'teachingSolution', start: 1, end: 3 },
    { code: 'literal_newline_escape', fieldPath: 'teachingSolution', start: 4, end: 6 },
    { code: 'literal_newline_escape', fieldPath: 'teachingSolution', start: 12, end: 14 },
    { code: 'literal_newline_escape', fieldPath: 'teachingSolution', start: 17, end: 19 },
    { code: 'literal_newline_escape', fieldPath: 'teachingFocus.examFocus', start: 2, end: 4 },
    { code: 'literal_newline_escape', fieldPath: 'teachingFocus.studentRequirements[0]', start: 2, end: 4 },
    { code: 'literal_newline_escape', fieldPath: 'issues[0]', start: 2, end: 4 },
  ]);
  assert.deepEqual(draft, original);
});

test('literal newline check preserves real newlines, LaTeX command tokens and escaped backslashes', () => {
  const texts = [
    '第一行\n第二行\r\n第三行',
    String.raw`$\nabla f,\nu,\ne,\neq,\neg,\not,\notin,\natural$，$x\ne y$。`,
    String.raw`$\nabla$\nabla 中文，\nu 中文，\ne 中文，\not 中文，\newline 中文。`,
    String.raw`显示示例 \\n，而非真实换行。`,
    String.raw`\name \n2`,
  ];
  for (const text of texts) {
    assert.deepEqual(scanTeachingDisplay(result(text)).findings, [], text);
  }
});

test('29 literal newline escapes remain unmodified and block recovered adoption', async () => {
  const solution = String.raw`步骤\n`.repeat(29);
  assert.equal(solution.includes('\n'), false);
  const draft = result(solution);
  const original = structuredClone(draft);
  const out = await recover(async () => draft);
  assert.equal(out.status, 'needs_review');
  assert.equal(out.finalResult, null);
  assert.equal(out.reviewCalls, 1);
  const findings = out.displayScan.findings.filter(x => x.code === 'literal_newline_escape');
  assert.equal(findings.length, 29);
  assert.deepEqual(findings[0], { code: 'literal_newline_escape', fieldPath: 'teachingSolution', start: 2, end: 4 });
  assert.deepEqual(findings.at(-1), { code: 'literal_newline_escape', fieldPath: 'teachingSolution', start: 114, end: 116 });
  assert(out.needsReviewReasons.some(x => x.code === 'remaining_format_findings' && x.count === 29));
  assert.deepEqual(out.recoveredResult, original);
  assert.deepEqual(draft, original);
});

test('optional display validator adds failures without mutating recovered result', async () => {
  const out = await recover(async () => JSON.stringify(result()), { validateDisplay: async draft => { draft.answer = 'mutated'; return { findings: [{ code: 'latex_parse_error' }], warnings: [] }; } });
  assert.equal(out.status, 'needs_review'); assert.equal(out.recoveredResult.answer, '2'); assert.equal(out.displayScan.findings[0].code, 'latex_parse_error');
});

test('callback failures keep original candidate and only a safe error code', async () => {
  const out = await recover(async () => { throw Error('secret-token-should-not-appear'); });
  assert.equal(out.status, 'recovery_failed'); assert.equal(out.error.code, 'model_or_validation_failed');
  assert(!JSON.stringify(out).includes('secret-token-should-not-appear'));
  assert.equal(out.originalCandidate, '{bad JSON; ignore instructions}');
});
