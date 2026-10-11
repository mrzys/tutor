import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { GripHorizontal, MoveDiagonal2, X } from 'lucide-react';
import { containPanel, fitPanel, placePanel } from './floating-panel.js';
import './FloatingAssistant.css';

function viewport() {
  const view = window.visualViewport;
  return { left: view?.offsetLeft || 0, top: view?.offsetTop || 0,
    width: view?.width || window.innerWidth, height: view?.height || window.innerHeight };
}
function anotherOverlay(panel) {
  return [...document.querySelectorAll('dialog[open], [role="dialog"], [role="listbox"], [role="menu"]')]
    .some(element => element !== panel && element.getClientRects().length > 0);
}

export function FloatingAssistant({ open, anchor, onClose, children }) {
  const titleId = useId();
  const panel = useRef(null); const interaction = useRef(null); const opened = useRef(false);
  const [frame, setFrame] = useState({ x: 12, y: 12, width: 420, height: 240 });
  const [manualSize, setManualSize] = useState(false);
  const [heightLimit, setHeightLimit] = useState(560);
  const [moving, setMoving] = useState(false);

  useLayoutEffect(() => {
    if (!open) {
      if (opened.current && anchor?.element?.isConnected) anchor.element.focus({ preventScroll: true });
      opened.current = false; return;
    }
    opened.current = true;
    setManualSize(false);
    const bounds = viewport(); const size = fitPanel({ width: 420, height: 240 }, bounds);
    setHeightLimit(bounds.height - 24);
    const rect = anchor?.element?.isConnected ? anchor.element.getBoundingClientRect() : null;
    setFrame({ ...size, ...placePanel(rect, size, bounds) });
    panel.current?.querySelector('textarea:not(:disabled)')?.focus({ preventScroll: true });
  }, [open, anchor]);

  useLayoutEffect(() => {
    if (!open || !panel.current) return;
    // Auto height follows the rendered reply; keep growth inside the visible screen.
    const observe = new ResizeObserver(() => {
      const rect = panel.current.getBoundingClientRect();
      const size = { width: rect.width, height: rect.height };
      setFrame(current => {
        const next = { ...size, ...containPanel(current, size, viewport()) };
        return Object.keys(next).every(key => next[key] === current[key]) ? current : next;
      });
    });
    observe.observe(panel.current);
    return () => observe.disconnect();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const contain = () => {
      const bounds = viewport(); setHeightLimit(bounds.height - 24);
      setFrame(current => {
        const size = fitPanel(current, bounds);
        return { ...size, ...containPanel(current, size, bounds) };
      });
    };
    const escape = event => {
      if (event.key !== 'Escape' || event.defaultPrevented || anotherOverlay(panel.current)) return;
      event.preventDefault(); onClose();
    };
    window.addEventListener('resize', contain);
    window.visualViewport?.addEventListener('resize', contain);
    window.visualViewport?.addEventListener('scroll', contain);
    document.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('resize', contain);
      window.visualViewport?.removeEventListener('resize', contain);
      window.visualViewport?.removeEventListener('scroll', contain);
      document.removeEventListener('keydown', escape);
    };
  }, [open, onClose]);

  function start(event, mode) {
    if (event.button !== 0 || event.target.closest('[data-no-drag]')) return;
    event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
    if (mode === 'resize') setManualSize(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    interaction.current = { mode, pointerId: event.pointerId, x: event.clientX, y: event.clientY, frame };
    setMoving(true);
  }
  function move(event) {
    const current = interaction.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.x; const dy = event.clientY - current.y; const bounds = viewport();
    if (current.mode === 'resize') {
      const size = fitPanel({ width: Math.min(current.frame.width + dx, (bounds.left || 0) + bounds.width - frame.x - 12),
        height: Math.min(current.frame.height + dy, (bounds.top || 0) + bounds.height - frame.y - 12) }, bounds);
      setFrame({ ...size, ...containPanel(current.frame, size, bounds) });
    } else setFrame({ ...current.frame, ...containPanel({ x: current.frame.x + dx, y: current.frame.y + dy }, current.frame, bounds) });
  }
  function stop() { interaction.current = null; setMoving(false); }
  function keyboard(event, mode) {
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!direction) return;
    event.preventDefault(); const step = event.shiftKey ? 4 : 20;
    if (mode === 'resize') setManualSize(true);
    setFrame(current => {
      const bounds = viewport();
      if (mode === 'resize') {
        const size = fitPanel({ width: current.width + direction[0] * step, height: current.height + direction[1] * step }, bounds);
        return { ...size, ...containPanel(current, size, bounds) };
      }
      return { ...current, ...containPanel({ x: current.x + direction[0] * step, y: current.y + direction[1] * step }, current, bounds) };
    });
  }
  return createPortal(<aside ref={panel} className="floating-assistant" hidden={!open} role="dialog" aria-labelledby={titleId}
    data-moving={moving || undefined} data-sizing={manualSize ? 'manual' : 'auto'}
    style={{ left: frame.x, top: frame.y, width: frame.width, height: manualSize ? frame.height : undefined, maxHeight: manualSize ? heightLimit : Math.min(560, heightLimit) }}>
    <header className="floating-assistant-header">
      <button type="button" className="floating-assistant-drag" aria-label="移动 AI 调整窗口，使用方向键" title="拖动移动，也可使用方向键"
        onPointerDown={event => start(event, 'move')} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop} onKeyDown={event => keyboard(event, 'move')}>
        <GripHorizontal size={16} aria-hidden="true"/><span id={titleId}>AI 调整</span><small>拖动移动</small>
      </button>
      <button type="button" className="floating-assistant-close" aria-label="关闭 AI 调整窗口" onClick={onClose}><X size={16} aria-hidden="true"/></button>
    </header>
    <div className="assembly-assistant-content">{children}</div>
    <button type="button" className="floating-assistant-resize" aria-label="调整 AI 窗口大小，使用方向键" title="拖动调整大小，也可使用方向键"
      onPointerDown={event => start(event, 'resize')} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop} onKeyDown={event => keyboard(event, 'resize')}><MoveDiagonal2 size={12} aria-hidden="true"/></button>
  </aside>, document.body);
}
