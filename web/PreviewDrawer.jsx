import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import './conversation.css';

export function PreviewDrawer({ open, title, onClose, children }) {
  const panel = useRef(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    panel.current?.querySelector('button')?.focus({ preventScroll: true });
    const key = event => { if (event.key === 'Escape' && !document.querySelector('dialog[open]')) { event.preventDefault(); onClose(); } };
    document.addEventListener('keydown', key);
    const composer = document.querySelector('.chat-composer-dock');
    const resize = new ResizeObserver(entries => document.documentElement.style.setProperty('--chat-composer-height', `${entries[0].target.getBoundingClientRect().height}px`));
    if (composer) resize.observe(composer);
    return () => { document.removeEventListener('keydown', key); resize.disconnect(); previous?.isConnected && previous.focus({ preventScroll: true }); };
  }, [open]);
  if (!open) return null;
  return createPortal(<aside ref={panel} className="paper-preview" role="dialog" aria-label="试卷预览" aria-modal="false"><header className="paper-preview-header"><div><strong>试卷预览</strong><span>{title}</span></div><button type="button" aria-label="关闭试卷预览" onClick={onClose}><X size={19}/></button></header><div className="paper-preview-body">{children}</div></aside>, document.body);
}
