export type SourceFocusBox = { left: number; top: number; width: number; height: number };
export type SourceQuestionFocus = { boxes: SourceFocusBox[]; bounds: SourceFocusBox };
export type SourcePageFocusState = { focus: SourceQuestionFocus | null; reason: string };
const unavailable = (reason: string): SourcePageFocusState => ({ focus: null, reason });

/** Geometry is only accepted from the source-bound Rust page response. Unknown
 * transforms, changed assets and malformed boxes fall back to the whole page. */
export function sourcePageFocus(source: any, questionId: string): SourceQuestionFocus | null {
  return sourcePageFocusState(source, questionId).focus;
}

export function sourcePageFocusState(source: any, questionId: string): SourcePageFocusState {
  const layout = source?.pageLayout, image = source?.image, transform = layout?.coordinateTransform;
  if (!source) return unavailable("正在读取原卷定位信息。");
  if (!image?.assetId) return unavailable(source.hasPdf
    ? "此记录未保存带坐标的原页图像，请手动对照整页 PDF。"
    : "此记录未保存原页图像，无法自动定位本题。");
  if (!questionId || source.questionId !== questionId) return unavailable("当前原页尚未绑定本题，无法自动定位。");
  if (!layout || source.page !== layout.page) return unavailable("本页未保存本题的可靠坐标，请手动对照整页原图。");
  if (layout.sourceImageAssetId !== image.assetId) return unavailable("本题坐标与原页图像不一致，未自动定位。");
  const [width, height, iw, ih] = [layout.width, layout.height, image.width, image.height];
  if (![width, height, iw, ih].every(n => Number.isSafeInteger(n) && n > 0 && n <= 12000)
    || transform?.layoutWidth !== width || transform?.layoutHeight !== height
    || transform?.imageWidth !== iw || transform?.imageHeight !== ih
    || !["identity", "uniform_scale"].includes(transform?.kind)
    || transform.rounding !== "floor_min_ceil_max"
    || Math.abs(width * ih - height * iw) > Math.max(width, height)
    || (transform.kind === "identity" && (width !== iw || height !== ih))) return unavailable("本页坐标或缩放依据不完整，未自动定位。");
  if (!Array.isArray(layout.blocks) || !layout.blocks.length) return unavailable("本页没有已绑定本题的定位块，请手动对照整页原图。");
  if (layout.blocks.length > 4096) return unavailable("本题定位块数量异常，未自动定位。");
  const ids = new Set<number>(), boxes: SourceFocusBox[] = [];
  for (const block of layout.blocks) {
    const box = block?.bbox;
    if (!Number.isSafeInteger(block?.id) || block.id < 0 || ids.has(block.id)
      || !Array.isArray(box) || box.length !== 4 || !box.every(n => Number.isFinite(n))
      || box[0] < 0 || box[1] < 0 || box[2] > width || box[3] > height
      || box[0] >= box[2] || box[1] >= box[3]) return unavailable("本题定位块不完整或超出原页范围，未自动定位。");
    ids.add(block.id);
    // Match OCR's conservative floor/ceil transform, rather than fitting boxes
    // to a page whose aspect ratio merely looks plausible.
    const [x1, y1, x2, y2] = [Math.floor(box[0] * iw / width), Math.floor(box[1] * ih / height), Math.ceil(box[2] * iw / width), Math.ceil(box[3] * ih / height)];
    boxes.push({ left: x1 / iw * 100, top: y1 / ih * 100, width: (x2 - x1) / iw * 100, height: (y2 - y1) / ih * 100 });
  }
  const left = Math.min(...boxes.map(b=>b.left)), top = Math.min(...boxes.map(b=>b.top));
  return { focus: { boxes, bounds: { left, top, width: Math.max(...boxes.map(b=>b.left+b.width))-left, height: Math.max(...boxes.map(b=>b.top+b.height))-top } }, reason: "" };
}
