import test from 'node:test';
import assert from 'node:assert/strict';
import { sourcePageFocus } from '../src/source-page-focus.ts';

function page(number, bbox) {
  return { questionId: 'cross-page-question', page: number, hasPdf: true,
    image: { assetId: `page-${number}`, width: 600, height: 800 },
    pageLayout: { page: number, width: 600, height: 800, sourceImageAssetId: `page-${number}`,
      coordinateTransform: { kind: 'identity', layoutWidth: 600, layoutHeight: 800,
        imageWidth: 600, imageHeight: 800, rounding: 'floor_min_ceil_max' },
      blocks: [{ id: number, bbox }] } };
}

test('模拟跨页原卷：同一道题按当前页的已验证块定位，不沿用上一页范围', () => {
  const first = page(1, [60, 650, 540, 750]);
  const second = page(2, [60, 40, 540, 160]);
  assert.deepEqual(sourcePageFocus(first, 'cross-page-question').bounds,
    { left: 10, top: 81.25, width: 80, height: 12.5 });
  assert.deepEqual(sourcePageFocus(second, 'cross-page-question').bounds,
    { left: 10, top: 5, width: 80, height: 15 });
  const mismatchedPage = { ...second, pageLayout: first.pageLayout };
  assert.equal(sourcePageFocus(mismatchedPage, 'cross-page-question'), null);
});

test('模拟仅PDF或未绑定题目的原卷：保留整页阅读，不从文本和页码猜测题目坐标', () => {
  const pdfOnly = { ...page(1, [60, 650, 540, 750]), image: null };
  assert.equal(sourcePageFocus(pdfOnly, 'cross-page-question'), null);
  const unowned = { ...page(1, [60, 650, 540, 750]), questionId: null };
  assert.equal(sourcePageFocus(unowned, 'cross-page-question'), null);
});
