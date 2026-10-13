import React, { useEffect, useId, useRef, useState } from 'react';

export function ActionMenu({ label, children, disabled, className = '', triggerClassName = '', menuClassName = '', triggerContent }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const trigger = useRef(null);
  const menu = useRef(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
    const outside = event => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
    };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  function keys(event) {
    if (event.key === 'Escape' && open) {
      event.preventDefault(); event.stopPropagation(); setOpen(false);
      trigger.current?.focus({ preventScroll: true });
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!open) { setOpen(true); return; }
      const items = [...menu.current.querySelectorAll('button:not(:disabled)')];
      const current = items.indexOf(document.activeElement);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[index]?.focus();
    } else if (event.key === 'Tab' && open) {
      trigger.current?.focus({ preventScroll: true }); setOpen(false);
    }
  }
  return <div ref={root} className={className} data-open={open} onKeyDown={keys}>
    <button ref={trigger} type="button" className={triggerClassName} disabled={disabled} aria-label={label}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}>
      {triggerContent || label}
    </button>
    {open ? <div ref={menu} id={id} role="menu" aria-label={label} className={menuClassName} onClick={event => {
      const action = event.target.closest('button');
      if (action && !action.disabled) {
        // Dialogs opened by an action can restore focus to this persistent trigger.
        trigger.current?.focus({ preventScroll: true }); setOpen(false);
      }
    }}>{children}</div> : null}
  </div>;
}
