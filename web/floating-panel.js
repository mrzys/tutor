const margin = 12;
export function fitPanel(size, viewport) {
  return { width: Math.min(Math.max(300, size.width), viewport.width - margin * 2),
    height: Math.min(Math.max(250, size.height), viewport.height - margin * 2) };
}
export function containPanel(position, size, viewport) {
  const left = viewport.left || 0; const top = viewport.top || 0;
  return { x: Math.max(left + margin, Math.min(position.x, left + viewport.width - size.width - margin)),
    y: Math.max(top + margin, Math.min(position.y, top + viewport.height - size.height - margin)) };
}
export function placePanel(anchor, size, viewport) {
  if (!anchor) return containPanel({ x: (viewport.left || 0) + (viewport.width - size.width) / 2,
    y: (viewport.top || 0) + (viewport.height - size.height) / 2 }, size, viewport);
  const right = (viewport.left || 0) + viewport.width;
  const bottom = (viewport.top || 0) + viewport.height;
  let x = anchor.right + margin; let y = anchor.top;
  if (x + size.width > right - margin) {
    x = anchor.right - size.width;
    if (anchor.bottom + margin + size.height <= bottom - margin) y = anchor.bottom + margin;
    else if (anchor.top - size.height - margin >= (viewport.top || 0) + margin) y = anchor.top - size.height - margin;
    else x = anchor.left - size.width - margin;
  }
  return containPanel({ x, y }, size, viewport);
}
