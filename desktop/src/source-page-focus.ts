export type SourceFocusBox = { left: number; top: number; width: number; height: number };

/** Geometry is only accepted from the source-bound Rust page response. Unknown
 * transforms, changed assets and malformed boxes fall back to the whole page. */
export function sourcePageFocus(source: any, questionId: string): { boxes: SourceFocusBox[]; bounds: SourceFocusBox } | null {
  const layout = source?.pageLayout, image = source?.image, transform = layout?.coordinateTransform;
  if (!questionId || source?.questionId !== questionId || source?.page !== layout?.page
    || !image?.assetId || layout?.sourceImageAssetId !== image.assetId) return null;
  const [width, height, iw, ih] = [layout.width, layout.height, image.width, image.height];
  if (![width, height, iw, ih].every(n => Number.isSafeInteger(n) && n > 0 && n <= 12000)
    || transform?.layoutWidth !== width || transform?.layoutHeight !== height
    || transform?.imageWidth !== iw || transform?.imageHeight !== ih
    || !["identity", "uniform_scale"].includes(transform?.kind)
    || transform.rounding !== "floor_min_ceil_max"
    || Math.abs(width * ih - height * iw) > Math.max(width, height)
    || (transform.kind === "identity" && (width !== iw || height !== ih))) return null;
  if (!Array.isArray(layout.blocks) || !layout.blocks.length || layout.blocks.length > 4096) return null;
  const ids = new Set<number>(), boxes: SourceFocusBox[] = [];
  for (const block of layout.blocks) {
    const box = block?.bbox;
    if (!Number.isSafeInteger(block?.id) || block.id < 0 || ids.has(block.id)
      || !Array.isArray(box) || box.length !== 4 || !box.every(n => Number.isFinite(n))
      || box[0] < 0 || box[1] < 0 || box[2] > width || box[3] > height
      || box[0] >= box[2] || box[1] >= box[3]) return null;
    ids.add(block.id);
    // Match OCR's conservative floor/ceil transform, rather than fitting boxes
    // to a page whose aspect ratio merely looks plausible.
    const [x1, y1, x2, y2] = [Math.floor(box[0] * iw / width), Math.floor(box[1] * ih / height), Math.ceil(box[2] * iw / width), Math.ceil(box[3] * ih / height)];
    boxes.push({ left: x1 / iw * 100, top: y1 / ih * 100, width: (x2 - x1) / iw * 100, height: (y2 - y1) / ih * 100 });
  }
  const left = Math.min(...boxes.map(b=>b.left)), top = Math.min(...boxes.map(b=>b.top));
  return { boxes, bounds: { left, top, width: Math.max(...boxes.map(b=>b.left+b.width))-left, height: Math.max(...boxes.map(b=>b.top+b.height))-top } };
}
