import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, FolderOpen, ListTree, X } from 'lucide-react';

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
  const groups = new Map();
  for (const chapter of chapters) {
    const key = chapter.parentId || chapter.id.split('.')[0];
    if (!groups.has(key)) groups.set(key, { label: chapter.parentLabel || (key === '1' && chapters.every(item => item.id.startsWith('1.')) ? '第一章 集合' : `第 ${key} 章`), children: [] });
    groups.get(key).children.push(chapter);
  }
  const summary = selected.length === chapters.length ? `全部 ${selected.length} 节` : selected.length === 1 ? chapters.find(item => item.id === selected[0])?.label : `已选 ${selected.length} 节`;
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
      <header className="scope-tree-dialog-header"><div><h2 id={titleId}>选择考查范围</h2><p id={descriptionId}>按教材章节多选，本次已选 {selected.length} 节。</p></div><button ref={closeButton} type="button" className="scope-tree-close" aria-label="关闭考查范围" onClick={close}><X size={18} aria-hidden="true"/></button></header>
    <fieldset disabled={disabled} className="scope-tree-panel"><legend className="sr-only">选择考查范围</legend><div className="scope-tree-scroll"><div className="scope-tree-root"><FolderOpen size={15} aria-hidden="true"/>高中数学</div>
      {[...groups].map(([key, group]) => {
        const ids = group.children.map(item => item.id);
        return <details key={key} open className="scope-tree-group"><summary>{group.label}</summary><BranchCheck label={`全选${group.label}`} selected={ids.filter(id => selected.includes(id)).length} total={ids.length} disabled={disabled} onChange={checked => onChange(checked ? [...new Set([...selected, ...ids])] : selected.filter(id => !ids.includes(id)))}/><div className="scope-tree-leaves">{group.children.map(chapter => <label key={chapter.id}><input type="checkbox" checked={selected.includes(chapter.id)} onChange={event => onChange(event.target.checked ? [...selected, chapter.id] : selected.filter(id => id !== chapter.id))}/><span>{chapter.label}</span></label>)}</div></details>;
      })}</div>
    </fieldset>
      <footer className="scope-tree-dialog-footer"><p>默认已学过所选内容及教材中此前内容。</p><button type="button" disabled={disabled || !selected.length} onClick={close}>完成选择</button></footer>
    </dialog>, document.body)}
  </div>;
}
