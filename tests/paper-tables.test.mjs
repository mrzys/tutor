import test from 'node:test';
import assert from 'node:assert/strict';
import { paperTextBlocks } from '../web/paper-tables.js';

test('paper tables preserve surrounding text and math containing vertical bars', () => {
  const blocks = paperTextBlocks('请填表\n| 数值 | 结论 |\n| --- | --- |\n| $|x|$ | $x>0$ |\n\n求解。');
  const table = blocks.find(block => block.type === 'table');
  assert.deepEqual(table.rows[1].map(cell => cell.text), ['$|x|$', '$x>0$']);
  assert.equal(table.rows[0][0].header, true);
  assert.ok(blocks.some(block => block.text?.includes('请填表')));
  assert.ok(blocks.some(block => block.text?.includes('求解。')));
});

test('imported HTML tables retain spans and decode text without executable markup', () => {
  const table = paperTextBlocks('<table onclick="bad()"><tr><th colspan="2">$x$ &gt; 0</th></tr><tr><td><script>bad()</script>A</td><td rowspan="2">B<br>C</td></tr></table>')[0];
  assert.equal(table.rows[0][0].text, '$x$ > 0');
  assert.equal(table.rows[0][0].colSpan, 2);
  assert.equal(table.rows[1][0].text, 'A');
  assert.equal(table.rows[1][1].rowSpan, 2);
  assert.equal(table.rows[1][1].text, 'B\nC');
});

test('HTML table cleanup preserves inequality formulas that resemble markup', () => {
  const table = paperTextBlocks('<table><tr><td><strong>条件</strong> $x<0$ 或 $x>1$</td><td>$a<b>c$</td><td>$$a<b>c$$</td><td>$x&lt;0$</td></tr></table>')[0];
  assert.deepEqual(table.rows[0].map(cell => cell.text), ['条件 $x<0$ 或 $x>1$', '$a<b>c$', '$$a<b>c$$', '$x<0$']);
});
