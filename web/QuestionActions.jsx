import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, MoreHorizontal, Sparkles } from 'lucide-react';
import { supplyPresentation } from './question-supply.js';

export function QuestionActions({ slot, supply, busy, onDetails, onCandidates, onCriteria, onDifficulty, onPoints, onDelete, onLock, onAiAdjust }) {
  const [menu, setMenu] = useState(null);
  const root = useRef(null);
  const trigger = useRef(null);
  const menuId = useId();
  const availability = supplyPresentation(supply);
  useEffect(() => {
    if (!menu) return;
    const dismiss = event => { if (!root.current?.contains(event.target)) setMenu(null); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [menu]);
  const run = action => { setMenu(null); action(); };
  const toggle = (name, event) => {
    trigger.current = event.currentTarget;
    setMenu(current => current === name ? null : name);
  };
  return <div className="question-actions" ref={root} data-open={!!menu}
    onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setMenu(null); }}
    onKeyDown={event => {
      if (event.key === 'Escape' && menu) { event.stopPropagation(); setMenu(null); trigger.current?.focus(); }
    }}>
    {onAiAdjust ? <button className="question-ai-adjust" disabled={busy} onClick={() => run(onAiAdjust)} aria-label={`AI 调整第 ${slot.number} 题`}><Sparkles size={13} aria-hidden="true"/>AI 调整</button> : null}
    <button disabled={busy} onClick={onDetails} aria-label={`第 ${slot.number} 题详情`}>详情</button>
    {availability.exhausted ? <>
      <button className="question-supply-empty" disabled={busy} onClick={onCriteria} aria-label={`第 ${slot.number} 题暂无合格备选，调整要求`} title={availability.detail}>调整要求 · 暂无备选</button>
      <button disabled={busy} onClick={onCandidates} aria-label={`查看第 ${slot.number} 题差异建议`}>查看差异</button>
    </> : <button disabled={busy} onClick={onCandidates} aria-label={`更换第 ${slot.number} 题，${availability.label}`} title={availability.detail}>换题<span className="question-supply-label"> · {availability.label}</span></button>}
    <button disabled={busy} onClick={event => toggle('adjust', event)} aria-expanded={menu === 'adjust'}
      aria-controls={menu === 'adjust' ? menuId : undefined} aria-label={`调整第 ${slot.number} 题`}>调整<ChevronDown size={12} aria-hidden="true"/></button>
    <button className="question-more" disabled={busy} onClick={event => toggle('more', event)} aria-expanded={menu === 'more'}
      aria-controls={menu === 'more' ? menuId : undefined} aria-label={`第 ${slot.number} 题更多操作`}><MoreHorizontal size={18} aria-hidden="true"/></button>
    {menu ? <div id={menuId} className="question-action-menu" aria-label={menu === 'adjust' ? '调整题目' : '更多操作'}>
      {menu === 'adjust' ? <>
        <button disabled={busy} onClick={() => run(onCriteria)}>考查要求<small>知识、认知、能力与素养</small></button>
        <button disabled={busy} onClick={() => run(onDifficulty)}>难度目标</button>
      </> : <>
        {onPoints ? <button disabled={busy} onClick={() => run(onPoints)}>修改分值</button> : null}
        <button disabled={busy} onClick={() => run(onLock)}>{slot.locked ? '解锁本题' : '锁定本题'}</button>
        <button className="delete-control" disabled={busy} onClick={() => run(onDelete)}>删除题位</button>
      </>}
    </div> : null}
  </div>;
}
