import React, { Children, Fragment, isValidElement, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';
import './Select.css';

function plainText(children) {
  return Children.toArray(children).map(child => isValidElement(child) ? plainText(child.props.children) : String(child)).join('');
}

function optionsFrom(children, inheritedDisabled = false) {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement(child)) return [];
    if (child.type === Fragment || child.type === 'optgroup') return optionsFrom(child.props.children, inheritedDisabled || child.props.disabled);
    if (child.type !== 'option') return [];
    const label = plainText(child.props.children);
    return [{ value: String(child.props.value ?? label), label, description: child.props['data-description'], disabled: inheritedDisabled || Boolean(child.props.disabled) }];
  });
}

// A controlled, single-value select. onChange keeps the existing event.target.value contract.
export function Select({ value, onChange, children, disabled = false, required = false, searchable, renderLabel, triggerLabel, className = '', name, id,
  onKeyDown, onClick, 'aria-label': ariaLabel, 'aria-labelledby': labelledBy, ...props }) {
  const generatedId = useId();
  const listId = `${generatedId}-options`;
  const trigger = useRef(null);
  const popup = useRef(null);
  const search = useRef(null);
  const list = useRef(null);
  const portalRoot = useRef(null);
  const typeahead = useRef({ text: '', time: 0 });
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState(null);
  const options = useMemo(() => optionsFrom(children), [children]);
  const canSearch = searchable ?? options.length >= 8;
  const filtered = useMemo(() => options.filter(option => !query || option.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [options, query]);
  const selected = options.find(option => option.value === String(value ?? ''));
  const activeId = open && active >= 0 ? `${listId}-${active}` : undefined;
  const activeDescription = filtered[active]?.description;
  const activeLabel = filtered[active]?.label;
  const hasDescriptions = options.some(option => option.description);

  function close(restoreFocus = true) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }
  function show(direction = 1) {
    if (disabled || trigger.current?.matches(':disabled')) return;
    portalRoot.current = trigger.current?.closest('dialog[open]') || document.body;
    setQuery(''); setPosition(null);
    const current = options.findIndex(option => option.value === String(value ?? '') && !option.disabled);
    setActive(current >= 0 ? current : direction > 0 ? options.findIndex(option => !option.disabled) : options.findLastIndex(option => !option.disabled));
    setOpen(true);
  }
  function choose(option) {
    if (!option || option.disabled || disabled || trigger.current?.matches(':disabled')) return;
    if (option.value !== String(value ?? '')) {
      const target = { value: option.value, name, id };
      onChange?.({ target, currentTarget: target, type: 'change' });
    }
    close();
  }
  function move(direction) {
    if (!filtered.length) return;
    let next = active;
    for (let count = 0; count < filtered.length; count++) {
      next = (next + direction + filtered.length) % filtered.length;
      if (!filtered[next].disabled) { setActive(next); return; }
    }
  }
  function keys(event) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'Tab') { close(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); move(event.key === 'ArrowDown' ? 1 : -1); }
    else if (event.key === 'Enter' || (event.key === ' ' && event.target !== search.current)) { event.preventDefault(); choose(filtered[active]); }
    else if (event.target !== search.current && ['Home', 'End'].includes(event.key)) {
      event.preventDefault(); setActive(event.key === 'Home' ? filtered.findIndex(option => !option.disabled) : filtered.findLastIndex(option => !option.disabled));
    } else if (event.target !== search.current && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now();
      typeahead.current = { text: `${now - typeahead.current.time < 700 ? typeahead.current.text : ''}${event.key.toLocaleLowerCase()}`, time: now };
      const next = filtered.findIndex(option => !option.disabled && option.label.toLocaleLowerCase().startsWith(typeahead.current.text));
      if (next >= 0) setActive(next);
    }
  }
  useEffect(() => { if (disabled) close(false); }, [disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(hasDescriptions && window.innerWidth >= 680 ? 480 : Math.max(rect.width, 240), window.innerWidth - 24);
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const upwards = below < 240 && above > below;
      const maxHeight = Math.max(100, Math.min(380, upwards ? above - 6 : below - 6));
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), width, maxHeight,
        ...(upwards ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }) });
    };
    update();
    (canSearch ? search.current : list.current)?.focus({ preventScroll: true });
    const outside = event => { if (!trigger.current?.contains(event.target) && !popup.current?.contains(event.target)) close(false); };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [open, canSearch, hasDescriptions]);
  useEffect(() => {
    if (!open) return;
    popup.current?.querySelector(`[data-option-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);
  useEffect(() => {
    if (open && (active >= filtered.length || !filtered[active] || filtered[active].disabled)) setActive(filtered.findIndex(option => !option.disabled));
  }, [filtered, active, open]);

  return <span className="tutor-select">
    {name ? <input type="hidden" name={name} value={value ?? ''} disabled={disabled}/> : null}
    <button {...props} ref={trigger} id={id} type="button" className={`tutor-select-trigger ${className}`} role="combobox"
      disabled={disabled} aria-label={ariaLabel} aria-labelledby={labelledBy} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
      aria-activedescendant={activeId} aria-required={required || undefined} onClick={event => { onClick?.(event); if (!event.defaultPrevented) open ? close() : show(); }}
      onKeyDown={event => { onKeyDown?.(event); if (event.defaultPrevented) return; if (open) keys(event); else if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); show(event.key === 'ArrowUp' ? -1 : 1); } }}>
      {triggerLabel ? <span className="tutor-select-prefix">{triggerLabel}</span> : null}<span>{selected ? (renderLabel ? renderLabel(selected.label) : selected.label) : '请选择'}</span><ChevronDown size={15} aria-hidden="true"/>
    </button>
    {open ? createPortal(<div ref={popup} className={`tutor-select-popup${hasDescriptions ? ' has-descriptions' : ''}`} style={{ ...position, visibility: position ? 'visible' : 'hidden' }} onKeyDown={keys}>
      {canSearch ? <div className="tutor-select-search"><Search size={15} aria-hidden="true"/><input ref={search} type="search" aria-label={`搜索${ariaLabel || '选项'}`} aria-controls={listId} aria-activedescendant={activeId} autoComplete="off" placeholder="搜索选项…" value={query} onChange={event => { setQuery(event.target.value); setActive(-1); }}/></div> : null}
      <div ref={list} id={listId} className="tutor-select-options" role="listbox" tabIndex={-1} aria-label={ariaLabel || '可选项'} aria-activedescendant={activeId}>
        {filtered.map((option, index) => <div key={`${option.value}-${index}`} id={`${listId}-${index}`} role="option" aria-selected={option.value === String(value ?? '')} aria-disabled={option.disabled || undefined} aria-describedby={index === active && activeDescription ? `${listId}-description` : undefined}
          className={`tutor-select-option ${index === active ? 'is-active' : ''}`} data-option-index={index} onPointerMove={() => { if (!option.disabled) setActive(index); }}
          onMouseDown={event => event.preventDefault()} onClick={() => choose(option)}><span>{renderLabel ? renderLabel(option.label) : option.label}</span>{option.value === String(value ?? '') ? <Check size={15} aria-hidden="true"/> : null}</div>)}
        {!filtered.length ? <p className="tutor-select-empty">没有匹配的选项</p> : null}
      </div>
      {hasDescriptions ? <div id={`${listId}-description`} className="tutor-select-description" role="status" aria-live="polite"><strong>{activeLabel || '用途说明'}</strong><p>{activeDescription || '选择左侧用途，查看适用场景。'}</p></div> : null}
    </div>, portalRoot.current || document.body) : null}
  </span>;
}
