import test from 'node:test';
import assert from 'node:assert/strict';
import { mathSegments } from '../src/shared/math-segments.mjs';
import { paperTextBlocks } from '../src/shared/rich-text.mjs';
import { richContent } from '../src/rich-content.ts';

test('all four paired delimiters render the same formula without changing source', () => {
  const input = String.raw`前 $a$，\(b\)，$$c$$，\[d\]。`;
  const parts = mathSegments(input);
  assert.deepEqual(parts.filter(p => p.type === 'math').map(p => [p.source,p.displayMode]), [['a',false],['b',false],['c',true],['d',true]]);
  assert.equal(parts.map(p => p.raw).join(''),input);
});

test('unpaired, escaped delimiters and inline dollar line breaks remain visible text', () => {
  for (const input of [String.raw`字面 \\(x\\) 与 \$5`, String.raw`未完成 \(x`, '$x\ny$']) {
    assert.equal(mathSegments(input).every(p => p.type === 'text'),true);
    assert.equal(mathSegments(input).map(p => p.raw).join(''),input);
  }
});

test('alternate math comparisons and absolute value pipes survive HTML and table parsing', () => {
  const html=String.raw`<table><tr><td>\(a<b>c\)</td><td>\[|x|\]</td></tr></table><script>bad()</script>`;
  const parsed=richContent(html);
  assert.equal(parsed.blocks[0].rows[0][0].content[0].text,String.raw`\(a<b>c\)`);
  assert.equal(parsed.blocks[0].rows[0][1].content[0].text,String.raw`\[|x|\]`);
  assert.equal(JSON.stringify(parsed).includes('bad()'),false);
  const table=paperTextBlocks(String.raw`| 项 | \(|x|\) |
| --- | --- |
| 值 | \(1\) |`)[0];
  assert.equal(table.rows[0].length,2);
  assert.equal(table.rows[0][1].text,String.raw`\(|x|\)`);
});
