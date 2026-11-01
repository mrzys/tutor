import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { scanTeachingTerms } from '../lib/teaching-term-scan.mjs';

const scan = teachingSolution => scanTeachingTerms({ teachingSolution });

test('scans exactly the generated classroom contract fields, not source or metadata', () => {
  const result = {
    questionId: '范数', answer: '目标式',
    difficultyAssessment: { level: '范数', basis: '下界' },
    teachingSolution: '约束',
    teachingFocus: {
      examFocus: '封闭性', studentRequirements: ['范数', '同余'],
      knowledgePoints: ['泰勒'], requiredKnowledgeUids: ['范数'],
    },
    issues: ['洛必达'], stem: '范数', referenceAnswer: '范数',
    referenceSolution: '范数', requiredKnowledgeUids: ['范数'],
  };
  const actual = scanTeachingTerms(result);
  assert.deepEqual(actual.scannedFields, [
    'answer', 'difficultyAssessment.basis', 'teachingSolution',
    'teachingFocus.examFocus', 'teachingFocus.studentRequirements[0]',
    'teachingFocus.studentRequirements[1]',
  ]);
  assert.equal(actual.findings.length, 6);
  assert.equal(actual.findings.filter(item => item.term === '范数').length, 1);
  assert.deepEqual(scanTeachingTerms(null).scannedFields, []);
  assert.deepEqual(scanTeachingTerms({ answer: 2, teachingFocus: { studentRequirements: [null, {}, '目标式'] } }).scannedFields,
    ['teachingFocus.studentRequirements[2]']);
});

test('longer aliases win within each rule and repeated occurrences are preserved', () => {
  const actual = scan('非平凡解与平凡解，整数线性表示与线性表示，约束条件及约束，非平凡解。');
  assert.deepEqual(actual.findings.map(item => item.term), [
    '非平凡解', '平凡解', '整数线性表示', '线性表示', '约束条件', '约束', '非平凡解',
  ]);
  assert.equal(new Set(actual.findings.map(item => `${item.ruleId}:${item.start}:${item.end}`)).size,
    actual.findings.length);
});

test('Unicode, LaTeX aliases, modular numbers and contextual ≡ retain original offsets', () => {
  const text = String.raw`🧑‍🏫先看模 3、模$5$和模 $7$。由同余得a≡b，写作a\equiv b\pmod{3}或\bmod 3及(mod m)。另有Φ、Phi与\Phi(z)，\lim 与lim。`;
  const actual = scan(text);
  for (const item of actual.findings) {
    assert.equal(text.slice(item.start, item.end), item.term);
    assert.ok(item.excerpt.includes(item.term));
  }
  assert.ok(actual.findings.some(item => item.start === text.indexOf('模 3') && item.term === '模 3'));
  for (const term of ['模$5$', '模 $7$', '≡', String.raw`\equiv`, String.raw`\pmod`, String.raw`\bmod`, '(mod m)', 'Φ', 'Phi', String.raw`\Phi`, String.raw`\lim`, 'lim']) {
    assert.ok(actual.findings.some(item => item.term === term), `missing ${term}`);
  }
  for (const item of actual.findings.filter(item => ['normal-cdf-notation', 'limit-notation'].includes(item.ruleId))) {
    assert.equal(item.category, 'context');
  }
});

test('identity symbols, vector moduli and prose do not trigger', () => {
  assert.deepEqual(scan(String.raw`以上解法如下解法。恒等式x²−1≡(x−1)(x+1)。向量的模为3。模型共有3种。philosophy，climate，subliminal。`).findings, []);
  assert.deepEqual(scan(String.raw`x\equiv x。上一句同余。下一句x≡x。`).findings.map(item => item.term), ['同余']);
});

test('operation closure and named differential theorems trigger without conflating Cauchy inequality', () => {
  const actual = scan('该集合对加法封闭，关于乘法运算封闭，对加法和乘法封闭。由罗尔定理、拉格朗日中值定理及柯西中值定理得；另用柯西不等式。');
  assert.deepEqual(actual.findings.map(item => item.term), [
    '对加法封闭', '关于乘法运算封闭', '对加法和乘法封闭',
    '罗尔定理', '拉格朗日中值定理', '柯西中值定理', '柯西不等式',
  ]);
  assert.equal(actual.findings.at(-2).ruleId, 'differential-mean-value');
  assert.equal(actual.findings.at(-1).ruleId, 'cauchy-schwarz-inequality');
  assert.equal(actual.findings.at(-1).category, 'special_tool');
});

test('dictionary families include spelling aliases and context-dependent terms', () => {
  const groups = [
    ['裴蜀定理、贝祖定理', 'bezout-theorem', 2],
    ['洛必达、洛必塔、L’Hôpital', 'lhopital-rule', 3],
    ['泰勒、麦克劳林、麦克劳伦', 'series-expansion', 3],
    ['柯西不等式、柯西—施瓦茨不等式、柯西-施瓦茨不等式、柯西施瓦茨不等式、柯西–施瓦茨不等式、Cauchy-Schwarz、Cauchy–Schwarz、Cauchy Schwarz、Cauchy inequality', 'cauchy-schwarz-inequality', 9],
    ['驻点、拐点', 'stationary-inflection', 2],
    ['凹凸、凸性、琴生、詹森', 'convexity-jensen', 4],
    ['单射、满射、双射', 'mapping-classification', 3],
    ['目标式、目标函数、目标泛函、约束、单位量、上界、下界', 'optimization-language', 7],
    ['同构', 'isomorphism-language', 1],
    ['极点极线、配极', 'polar-geometry', 2],
    ['阿波罗尼斯圆', 'apollonius-circle', 1],
    ['测度、支集', 'measure-support', 2],
    ['不动点', 'fixed-point-method', 1],
    ['标准化', 'standardization-context', 1],
  ];
  for (const [text, id, count] of groups) {
    const actual = scan(text).findings;
    assert.equal(actual.length, count, text);
    assert.ok(actual.every(item => item.ruleId === id), text);
  }
  assert.equal(scan('线性表示').findings[0].category, 'context');
  assert.equal(scan('标准化').findings[0].category, 'context');
});

test('scanner never mutates input or treats source text as executable dictionary instructions', () => {
  const value = Object.freeze({
    answer: 'globalThis.__termScanInjected = true; 范数',
    teachingSolution: '(?=a).* 目标式; import("node:fs")',
    teachingFocus: Object.freeze({ studentRequirements: Object.freeze(['下界']) }),
  });
  const before = JSON.stringify(value);
  const actual = scanTeachingTerms(value);
  assert.equal(JSON.stringify(value), before);
  assert.equal(globalThis.__termScanInjected, undefined);
  assert.equal(actual.findings.length, 3);
  assert.deepEqual(scanTeachingTerms(value), actual);
  // Changing a returned collection cannot change the private dictionary or
  // contaminate subsequent scans.
  actual.findings[0].guidance = 'changed';
  actual.scannedFields.push('stem');
  assert.notDeepEqual(scanTeachingTerms(value), actual);
});

test('dictionary uses literal terms and fixed matcher identifiers only', () => {
  const dictionary = JSON.parse(readFileSync(new URL('../resources/teaching-term-triggers.json', import.meta.url), 'utf8'));
  assert.equal(dictionary.version, scan('范数').dictionaryVersion);
  const known = new Set(['modulo-number', 'modulo-notation', 'contextual-congruence', 'operation-closure', 'phi-notation', 'limit-notation',
    'integral-notation', 'english-classroom-method', 'higher-derivative-primes', 'higher-derivative-order',
    'higher-derivative-fraction', 'infinite-sum-notation', 'endpoint-limit-shorthand', 'epsilon-delta-argument', 'vector-cross-product']);
  for (const rule of dictionary.rules) {
    assert.deepEqual(Object.keys(rule).filter(key => !['id', 'category', 'terms', 'matchers', 'guidance'].includes(key)), []);
    assert.ok(rule.terms.every(term => typeof term === 'string' && term.length > 0));
    assert.ok((rule.matchers ?? []).every(name => known.has(name)));
  }
  const guidelines = Object.fromEntries(dictionary.rules.map(rule => [rule.id, rule.guidance]));
  assert.match(guidelines['norm-language'], /不能统一改成向量的模/u);
  assert.match(guidelines['mapping-classification'], /单射不等于零点唯一/u);
  assert.match(guidelines['stationary-inflection'], /拐点不等于切线斜率变化/u);
  assert.match(guidelines['cauchy-schwarz-inequality'], /不能只删定理名/u);
});

test('new curriculum-context triggers share positive and negative notation fixtures with Rust', () => {
  const fixture = JSON.parse(readFileSync(new URL('../resources/teaching-term-context-fixtures.json', import.meta.url), 'utf8'));
  for (const example of fixture.cases) {
    const found = scan(example.text).findings;
    assert.deepEqual([...new Set(found.map(item => item.ruleId))].sort(), [...example.ruleIds].sort(), example.name);
    if (example.terms) assert.deepEqual(found.map(item => item.term).sort(), [...example.terms].sort(), example.name);
    for (const item of found) assert.equal(example.text.slice(item.start, item.end), item.term, example.name);
  }
});

test('mean-value and vector-product gaps only locate review and preserve source text', () => {
  const value = {
    teachingSolution: String.raw`由中值定理得到等式，再取 $\overrightarrow{AB}\times\overrightarrow{AP}$ 求法向量。`,
    stem: '源材料中的叉积与中值定理保持原样。',
    referenceSolution: String.raw`$\vec{a}\times\vec{b}$`,
  };
  const before = JSON.stringify(value);
  const actual = scanTeachingTerms(value);
  assert.equal(actual.dictionaryVersion, 'teaching-term-review-v7-method-gaps');
  assert.deepEqual(actual.findings.map(item => item.ruleId), ['differential-mean-value', 'vector-cross-product']);
  assert.ok(actual.findings.every(item => item.fieldPath === 'teachingSolution' && item.category === 'special_tool'));
  assert.equal(JSON.stringify(value), before);
  for (const finding of actual.findings) {
    assert.equal(Object.hasOwn(finding, 'correct'), false);
    assert.equal(Object.hasOwn(finding, 'autoReplace'), false);
    assert.equal(value.teachingSolution.slice(finding.start, finding.end), finding.term);
  }
  const guidance = actual.findings.find(item => item.ruleId === 'vector-cross-product').guidance;
  assert.match(guidance, /数量积分别为0/u);
  assert.match(guidance, /不能只删除叉积名称或公式/u);
  assert.deepEqual(scanTeachingTerms({ stem: value.stem, referenceSolution: value.referenceSolution }).findings, []);
});

test('context triggers inspect newly generated prose only and leave ordinary classroom notation alone', () => {
  const sourceOnly = {
    stem: String.raw`已知积分常数及 f''，按 telescoping 求无穷和。`,
    referenceSolution: String.raw`由\int 和\sum_{n=1}^{\infty}得到。`,
    issues: ['原卷出现积分。'],
    teachingSolution: String.raw`因为 $F'(x)=0$，所以 $F(x)$ 为常数，代入 $x=0$ 得常数为1。`,
  };
  assert.deepEqual(scanTeachingTerms(sourceOnly).findings, []);
  const result = scanTeachingTerms({
    answer: String.raw`$\int_0^1x\,dx$`,
    difficultyAssessment: { basis: '使用三阶导后仍需说明理由。' },
    teachingFocus: { examFocus: '无穷等比级数', studentRequirements: ['理解 telescoping 的实际相消过程。'] },
  });
  assert.deepEqual(new Set(result.findings.map(f => f.fieldPath)), new Set([
    'answer', 'difficultyAssessment.basis', 'teachingFocus.examFocus', 'teachingFocus.studentRequirements[0]',
  ]));
});

test('higher derivative fractions require the full numerator and differential denominator', () => {
  const source = String.raw`🧑‍🏫普通分式 $\frac{d^2}{e^d-1}$，再看 $\dfrac{\mathrm d^{3} f_1(x)}{\mathrm d x^{3}}$。`;
  const before = JSON.stringify({ teachingSolution: source });
  const found = scan(source).findings;
  assert.equal(found.length, 1);
  assert.equal(found[0].ruleId, 'higher-derivative');
  assert.equal(found[0].term, String.raw`\dfrac{\mathrm d^{3} f_1(x)}{\mathrm d x^{3}}`);
  assert.equal(source.slice(found[0].start, found[0].end), found[0].term);
  assert.equal(JSON.stringify({ teachingSolution: source }), before);
  assert.deepEqual(scan(String.raw`$\frac{d^2+1}{dx^2}$、$\frac{d^2f}{x^2}$、$\frac{d^2}{e^d-1}$`).findings, []);
});

test('contextual bounds and linear representation remain review triggers without a mathematical verdict', () => {
  const input = { teachingSolution: '由a²+b²>e²/2可知e²/2是参数平方和下界；向量的线性表示写为u=2v+w。' };
  const before = JSON.stringify(input);
  const actual = scanTeachingTerms(input);
  assert.deepEqual(actual.findings.map(item => item.ruleId), ['optimization-language', 'linear-representation']);
  assert.deepEqual(actual.findings.map(item => item.term), ['下界', '线性表示']);
  assert.equal(JSON.stringify(input), before);
  for (const finding of actual.findings) {
    assert.equal(Object.hasOwn(finding, 'mathematics'), false);
    assert.equal(Object.hasOwn(finding, 'correct'), false);
    assert.equal(Object.hasOwn(finding, 'autoReplace'), false);
  }
});

test('LaTeX command boundaries allow numeric arguments and subscripts without matching longer commands', () => {
  const found = scan(String.raw`$m^2\equiv1\pmod3$，$\lim_{x\to0}f(x)$，$\Phi_0$，$\Phi3$`).findings;
  for (const term of [String.raw`\equiv`, String.raw`\pmod`, String.raw`\lim`, String.raw`\Phi`]) assert(found.some(f => f.term === term), term);
  assert.equal(scan(String.raw`$\pmodulus$ $\limit$ $\PhiLong$`).findings.length, 0);
});

test('dictionary strings are literal data and unrecognized matcher programs are rejected', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tutor-term-dictionary-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'lib'));
  mkdirSync(join(directory, 'resources'));
  const modulePath = join(directory, 'lib', 'teaching-term-scan.mjs');
  const dictionaryPath = join(directory, 'resources', 'teaching-term-triggers.json');
  writeFileSync(modulePath, readFileSync(new URL('../lib/teaching-term-scan.mjs', import.meta.url)));
  const injected = 'globalThis.__dictionaryScanInjected = true';
  const fixture = {
    version: 'isolated-test-only',
    rules: [{ id: 'literal', category: 'context', terms: ['a.*', injected], guidance: 'review' }],
  };
  writeFileSync(dictionaryPath, JSON.stringify(fixture));
  const isolated = await import(pathToFileURL(modulePath).href);
  assert.deepEqual(isolated.scanTeachingTerms({ answer: `abc a.* ${injected}` }).findings.map(item => item.term), ['a.*', injected]);
  assert.equal(globalThis.__dictionaryScanInjected, undefined);
  fixture.rules[0].matchers = [injected];
  writeFileSync(dictionaryPath, JSON.stringify(fixture));
  await assert.rejects(import(`${pathToFileURL(modulePath).href}?invalid-matcher`), /Invalid teaching term dictionary rule/);
  assert.equal(globalThis.__dictionaryScanInjected, undefined);
});


test('second differentiation alone does not demand rewriting or a review call', () => {
  const value = { teachingSolution: String.raw`设 $f(x)=x^3$，$f'(x)=3x^2$。对导函数再次求导得 $f''(x)=6x$，先说明导函数的增减，再结合其正负研究原函数。`, difficultyAssessment: { basis: '本题需要二阶导数计算，即对导函数再次求导。' } };
  const before = JSON.stringify(value);
  assert.deepEqual(scanTeachingTerms(value).findings, []);
  assert.equal(JSON.stringify(value), before);
});

test('named second-derivative tests locate the theory without declaring the candidate wrong', () => {
  const value = { teachingSolution: '用二阶导数判别法判断极值，接着说明其理由。' };
  const before = JSON.stringify(value);
  const found = scanTeachingTerms(value).findings;
  assert.equal(found.length, 1);
  assert.equal(found[0].ruleId, 'second-derivative-test');
  assert.equal(found[0].category, 'context');
  assert.equal(found[0].term, '二阶导数判别法');
  assert.equal(value.teachingSolution.slice(found[0].start, found[0].end), found[0].term);
  assert.equal(Object.hasOwn(found[0], 'correct'), false);
  assert.equal(JSON.stringify(value), before);
});


test('prime-glyph runs distinguish second order from every higher-order combination without truncation', () => {
  const singles = ["'", '′'];
  const glyphs = ["'", '′', '″', '‴', '⁗'];
  const weight = { "'": 1, '′': 1, '″': 2, '‴': 3, '⁗': 4 };
  const runs = [...glyphs];
  for (const first of glyphs) for (const second of glyphs) runs.push(first + second);
  for (const first of singles) for (const second of singles) for (const third of glyphs) runs.push(first + second + third);
  for (const run of runs) {
    const source = `🧑‍🏫 $f${run}`;
    const before = JSON.stringify({ teachingSolution: source });
    const found = scan(source).findings;
    if ([...run].reduce((sum, glyph) => sum + weight[glyph], 0) < 3) {
      assert.deepEqual(found, [], run);
    } else {
      assert.equal(found.length, 1, run);
      assert.equal(found[0].term, `f${run}`, run);
      assert.equal(found[0].start, source.indexOf('f'), run);
      assert.equal(found[0].end, source.length, run);
      assert.equal(source.slice(found[0].start, found[0].end), `f${run}`, run);
    }
    assert.equal(JSON.stringify({ teachingSolution: source }), before, run);
  }
});
