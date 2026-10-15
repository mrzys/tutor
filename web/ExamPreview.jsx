import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CloseButton } from './CloseButton.jsx';
import { PaperSheet } from './PaperSheet.jsx';
import { api } from './api.js';
import './ExamPreview.css';

const versions = [['student', '学生卷'], ['teacher', '教师卷']];

export function ExamPreview({ draft, title, assets: frozenAssets, onClose, initialKind = 'student' }) {
  const dialog = useRef(null); const scroll = useRef(null); const tabs = useRef({});
  const id = useId();
  const [kind, setKind] = useState(initialKind);
  const [attempt, setAttempt] = useState(0);
  const [assetState, setAssetState] = useState({ assets: [], loading: false, error: '' });
  const hasAssets = draft.slots.some(slot => slot.question?.student?.assets?.length);
  useEffect(() => {
    const element = dialog.current; const trigger = document.activeElement;
    element.showModal();
    return () => { element.close(); if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    if (frozenAssets !== undefined || !hasAssets) return;
    const controller = new AbortController();
    setAssetState({ assets: [], loading: true, error: '' });
    api(`/api/drafts/${encodeURIComponent(draft.draftId)}/preview`, undefined, controller.signal).then(response => {
      if (controller.signal.aborted) return;
      if (response.draftId !== draft.draftId || response.revision !== (draft.revision ?? 0)) throw new Error('草稿已更新，请关闭预览并读取最新草稿。');
      setAssetState({ assets: response.assets, loading: false, error: '' });
    }).catch(error => { if (!controller.signal.aborted) setAssetState({ assets: [], loading: false, error: error.message }); });
    return () => controller.abort();
  }, [draft.draftId, draft.revision, hasAssets, frozenAssets, attempt]);
  function switchKind(next) { setKind(next); scroll.current?.scrollTo({ top: 0 }); }
  function keys(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'student' : event.key === 'End' ? 'teacher' : kind === 'student' ? 'teacher' : 'student';
    switchKind(next); tabs.current[next]?.focus();
  }
  return createPortal(<dialog ref={dialog} className="exam-preview-dialog" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="exam-preview-toolbar">
      <h2 id={`${id}-title`}>整卷预览</h2>
      <div className="exam-preview-versions" role="tablist" aria-label="预览版本">{versions.map(([value, label]) => <button key={value} ref={element => { tabs.current[value] = element; }} id={`${id}-${value}`} type="button" role="tab" aria-selected={kind === value} aria-controls={`${id}-document`} tabIndex={kind === value ? 0 : -1} onClick={() => switchKind(value)} onKeyDown={keys}>{label}</button>)}</div>
      <CloseButton label="关闭试卷预览" onClick={onClose}/>
    </header>
    <div ref={scroll} className="exam-preview-scroll" id={`${id}-document`} role="tabpanel" aria-labelledby={`${id}-${kind}`} tabIndex={0}>
      {assetState.loading ? <p className="exam-preview-notice" role="status">正在加载题目图片…</p> : null}
      {assetState.error ? <div className="exam-preview-notice warning-text" role="alert">图片加载失败：{assetState.error}<button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button></div> : null}
      <div className="paper-workspace exam-preview-sheet"><PaperSheet draft={draft} title={title} kind={kind} assets={frozenAssets ?? assetState.assets} idPrefix={`${id}-preview`}/></div>
    </div>
  </dialog>, document.body);
}
