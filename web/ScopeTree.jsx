import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, FolderOpen, ListTree, X } from 'lucide-react';
import { availableScopeGroups, availableScopeSelection } from '../src/curriculum/availability.mjs';

function BranchCheck({ label, selected, total, disabled, onChange }) {
  const input = useRef(null);
  useEffect(() => { if (input.current) input.current.indeterminate = selected > 0 && selected < total; }, [selected, total]);
  return <label className="scope-tree-branch"><input ref={input} type="checkbox" checked={selected === total && total > 0} disabled={disabled} onChange={event => onChange(event.target.checked)}/><span>{label}</span></label>;
}

export function ScopeTree({ chapters, selected = [], disabled, onChange, open = false, onToggle }) {
  const trigger = useRef(null);
  const dialog = useRef(null);
  const closeButton = useRef(null);
  const onToggleRef = useRef(onToggle);
  onToggleRef.current = onToggle;
  const dialogId = useId();
  const titleId = useId();
  const descriptionId = useId();
  const visible = open && !disabled;
  useEffect(() => {
    const panel = dialog.current;
    if (visible && !panel.open) {
      panel.showModal();
      closeButton.current?.focus({ preventScroll: true });
    } else if (!visible && panel.open) panel.close();
  }, [visible]);
  useEffect(() => {
    if (open && disabled) onToggleRef.current?.(false);
  }, [open, disabled]);
  const close = () => {
    dialog.current?.close();
    onToggleRef.current?.(false);
  };
  const groups = availableScopeGroups(chapters);
  const available = groups.flatMap(group => group.children);
  const current = availableScopeSelection(chapters, selected);
  const summary = current.length === available.length ? `全部 ${current.length} 节` : current.length === 1 ? available.find(item => item.id === current[0])?.label : `已选 ${current.length} 节`;
  return <div id="quick-scope" className="scope-tree">
    <button ref={trigger} type="button" className="scope-tree-trigger" disabled={disabled} aria-haspopup="dialog" aria-expanded={visible} aria-controls={dialogId} onClick={() => onToggleRef.current?.(!visible)}><ListTree size={16} aria-hidden="true"/><span>考查范围</span><span className="scope-tree-value">{selected.length ? summary : '请选择'}</span><ChevronDown size={14} aria-hidden="true"/></button>
    {createPortal(<dialog ref={dialog} id={dialogId} className="scope-tree-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}
      onCancel={event => { event.preventDefault(); close(); }}
      onClose={() => { onToggleRef.current?.(false); trigger.current?.focus({ preventScroll: true }); }}
      onClick={event => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
      }}>
      <header className="scope-tree-dialog-header"><div><h2 id={titleId}>选择考查范围</h2><p id={descriptionId}>选择章节或小节，可多选。</p></div><button ref={closeButton} type="button" className="scope-tree-close" aria-label="关闭考查范围" onClick={close}><X size={18} aria-hidden="true"/></button></header>
    <fieldset disabled={disabled} className="scope-tree-panel"><legend className="sr-only">选择考查范围</legend><div className="scope-tree-scroll"><div className="scope-tree-root"><FolderOpen size={15} aria-hidden="true"/>人教 A 版 · 必修第一册<span>已开放前两章</span></div>
      {groups.map(group => {
        const ids = group.children.map(item => item.id);
        const count = ids.filter(id => current.includes(id)).length;
        return <section key={group.id} className="scope-chapter"><div className="scope-chapter-heading"><BranchCheck label={group.label} selected={count} total={ids.length} disabled={disabled} onChange={checked => onChange(checked ? [...new Set([...current, ...ids])] : current.filter(id => !ids.includes(id)))}/><span>{count}/{ids.length}</span></div><div className="scope-chapter-sections">{group.children.map(chapter => <label key={chapter.id} className={current.includes(chapter.id) ? 'is-selected' : ''}><input type="checkbox" checked={current.includes(chapter.id)} onChange={event => onChange(event.target.checked ? [...current, chapter.id] : current.filter(id => id !== chapter.id))}/><span>{chapter.label}</span></label>)}</div></section>;
      })}</div>
    </fieldset>
      <footer className="scope-tree-dialog-footer"><div><strong aria-live="polite">已选 {current.length} 节</strong><p>默认已学过所选内容及此前内容</p></div><button type="button" className="primary" disabled={disabled || !current.length} onClick={close}>完成选择</button></footer>
    </dialog>, document.body)}
  </div>;
}
