import test from 'node:test';
import assert from 'node:assert/strict';
import { assetKey, assetReferences, inlineAssetIds, resolveAsset, richContent, waitForPaperAssets } from '../src/rich-content.ts';

// Synthetic content exercises rendering boundaries; it is not a teacher case.
const studentImage = { assetId: 'figure', path: 'assets/figure.png', sha256: 'a'.repeat(64) };
const teacherImage = { assetId: 'answer', path: 'assets/answer.png', sha256: 'b'.repeat(64) };
const question = () => ({
  student: { stem: '观察 ![图形](assets/figure.png)，计算 $|x|$。', options: [], parts: [], assets: [studentImage] },
  teacher: { answers: [{ text: '<img src="assets/answer.png" alt="解答图">' }], assets: [teacherImage] },
});

test('synthetic images retain their exact position in text and merged table cells', () => {
  const content = richContent('前文 ![示意图](assets/figure.png) 后文<table><tr><td rowspan="2">$a<b>c$<img src="assets/answer.png"></td></tr><tr><td>末尾</td></tr></table>');
  assert.deepEqual(content.blocks[0].content.map(item => item.type), ['text', 'image', 'text']);
  assert.equal(content.blocks[0].content[1].reference.source, 'assets/figure.png');
  const cell = content.blocks[1].rows[0][0];
  assert.equal(cell.rowSpan, 2);
  assert.equal(cell.content[0].text, '$a<b>c$');
  assert.equal(cell.content[1].reference.source, 'assets/answer.png');
});

test('synthetic image discarded by unsupported table structure becomes a visible blocking marker', () => {
  const content = richContent('<table><img src="assets/figure.png"><tr><td>文本</td></tr></table>');
  assert.equal(content.blocks.at(-1).content[0].type, 'missing-image');
  assert.equal(content.blocks.at(-1).content[0].reference.source, 'assets/figure.png');
  assert.deepEqual(richContent('<!-- <img src="private.png"> --><script>bad()</script>正文').references, []);
});

test('student view cannot resolve teacher-only images and visible references avoid duplicate append', () => {
  const q = question();
  assert.equal(assetReferences(q).length, 1);
  assert.equal(assetReferences(q, true).length, 2);
  assert.equal(resolveAsset(q, { source: 'assets/answer.png', alt: '' }), null);
  assert.equal(resolveAsset(q, { source: 'assets/answer.png', alt: '' }, true)?.role, 'teacher');
  assert.deepEqual([...inlineAssetIds(q)], [assetKey({ ...studentImage, role: 'student' })]);
  assert.equal(inlineAssetIds(q, true).size, 2);
  assert.equal(inlineAssetIds(q, false, '最终展示内容无图片').size, 0);
});

test('ambiguous synthetic image filenames fail instead of choosing a different asset', () => {
  const q = question();
  q.student.assets.push({ ...studentImage, assetId: 'other', path: 'other/figure.png' });
  assert.equal(resolveAsset(q, { source: 'figure.png', alt: '' }), null);
  assert.equal(resolveAsset(q, { source: 'assets/figure.png', alt: '' })?.assetId, 'figure');
});

test('PDF readiness rejects a missing required image explicitly', async () => {
  const root = { querySelector: selector => selector === '[data-missing-asset]' ? {} : null };
  await assert.rejects(waitForPaperAssets(root), /配图未完整加载/);
});
