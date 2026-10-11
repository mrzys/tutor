import test from 'node:test';
import assert from 'node:assert/strict';
import { fitPanel, containPanel, placePanel } from '../web/floating-panel.js';

test('a floating adjustment opens beside its anchor without overflowing', () => {
  const viewport = { width: 1280, height: 800 }; const size = { width: 420, height: 380 };
  assert.deepEqual(placePanel({ left: 400, right: 450, top: 200, bottom: 230 }, size, viewport), { x: 462, y: 200 });
  assert.deepEqual(placePanel({ left: 1150, right: 1200, top: 200, bottom: 230 }, size, viewport), { x: 780, y: 242 });
  assert.deepEqual(placePanel({ left: 1150, right: 1200, top: 650, bottom: 680 }, size, viewport), { x: 780, y: 258 });
});
test('dragging and resizing remain inside a small or keyboard-reduced viewport', () => {
  const viewport = { left: 0, top: 80, width: 390, height: 260 };
  const size = fitPanel({ width: 420, height: 380 }, viewport);
  assert.deepEqual(size, { width: 366, height: 236 });
  assert.deepEqual(containPanel({ x: -100, y: 1000 }, size, viewport), { x: 12, y: 92 });
  assert.deepEqual(placePanel(null, size, viewport), { x: 12, y: 92 });
});
