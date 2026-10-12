import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractSolutionDependencies, validateSolutionDependencies } from '../src/question-bank/dependencies.mjs';

const catalog = JSON.parse(await readFile(new URL('../data/curriculum/textbooks.json', import.meta.url), 'utf8'));
test('explicit solution dependency guard resolves real stable textbook identities', () => {
  const cases = [
    ['求导得 f\'(x)=2x，利用导数判断最值。', 'rja-selective-2:5.3'],
    ['求导得 f\'(x)=2x。', 'rja-selective-2:5.2'],
    ['利用指数函数的单调性解指数不等式。', 'rja-compulsory-1:4.2'],
    ['利用指数运算法则化简。', 'rja-compulsory-1:4.1'],
    ['根据对数函数的单调性解方程。', 'rja-compulsory-1:4.4'],
    ['利用对数运算法则计算。', 'rja-compulsory-1:4.3'],
    ['求函数 f(x) 的值域，配方得到最小值。', 'rja-compulsory-1:3.1'],
    ['利用二倍角公式计算。', 'rja-compulsory-1:5.5'],
  ];
  for (const [text, id] of cases) {
    const result = validateSolutionDependencies(text, catalog, []);
    assert.ok(result.missingSectionIds.includes(id), text);
    assert.equal(result.ok, false);
    assert.equal(validateSolutionDependencies(text, catalog, result.requiredSectionIds).ok, true);
    assert.ok(result.findings[0].evidence.length > 0);
  }
});

test('logical predicate rewriting, elementary squares and expressly avoided methods do not create advanced dependencies', () => {
  for (const text of ['将全称量词换为存在量词，将 2^x>0 否定为 2^x≤0。',
    '原命题 ∀x∈R, 2^x>0 的否定为 ∃x∈R, 2^x≤0。',
    '无需使用导数，直接由不等式性质得 a+1>3。',
    '不用指数函数，按量词否定规则改变谓词。',
    '根式不等式化简集合A、B，再计算交集。',
    '根式有意义得分式不等式分别化简。',
    '移项分解 x²−4=(x−2)(x+2)，按两因式同号解不等式。']) {
    assert.deepEqual(extractSolutionDependencies(text, catalog).requiredSectionIds, [], text);
  }
  const unmapped = validateSolutionDependencies('求导得 f\'(x)=2x。', [], []);
  assert.equal(unmapped.ok, false);
  assert.equal(unmapped.unmapped[0].title, '导数的运算');
});
