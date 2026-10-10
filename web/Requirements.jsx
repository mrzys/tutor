import React from 'react';
import { sourceLabel, typeLabels } from './api.js';

function CheckGroup({ title, hint, items, selected, onChange, prefix }) {
  function toggle(id, checked) { onChange(checked ? [...selected, id] : selected.filter(value => value !== id)); }
  return <fieldset className="field-section"><legend>{title}</legend>{hint ? <p className="help">{hint}</p> : null}<div className="check-list">{items.map(item => <label className="check-item" key={item.id} htmlFor={`${prefix}-${item.id}`}><input id={`${prefix}-${item.id}`} type="checkbox" checked={selected.includes(item.id)} onChange={event => toggle(item.id, event.target.checked)}/><span>{item.label}{item.description ? <small>{item.description}</small> : null}</span></label>)}</div></fieldset>;
}

export function Requirements({ config, value, onChange, onSubmit, busy }) {
  const set = (key, next) => onChange(current => ({ ...current, [key]: next }));
  return <form onSubmit={event => { event.preventDefault(); onSubmit(); }}>
    <div className="section-heading"><h2>教学条件与组卷要求</h2><span className="muted">集合专项预设，本次需确认</span></div>
    <div className="form-grid">
      <label className="field wide">试卷标题<input value={value.title} maxLength={120} required onChange={event => set('title', event.target.value)}/></label>
      <label className="field">年级<input value={value.grade} maxLength={60} required onChange={event => set('grade', event.target.value)}/></label>
      <label className="field">时长（分钟）<input type="number" value={value.durationMinutes} min="1" max="300" required onChange={event => set('durationMinutes', Number(event.target.value))}/></label>
      <label className="field">目标总分<input type="number" value={value.targetScore} min="1" max="1000" required onChange={event => set('targetScore', Number(event.target.value))}/></label>
      <label className="field">目标难度<input type="number" value={value.targetDifficulty} min="0" max="1" step="0.01" required onChange={event => set('targetDifficulty', Number(event.target.value))}/><small>0～1 的偏好，现有题目实际难度未知。</small></label>
      <label className="field wide">教学目的<textarea value={value.goal} maxLength={1000} required rows="3" onChange={event => set('goal', event.target.value)}/></label>
    </div>
    <CheckGroup title="主考范围" hint="本卷主要考查什么。" items={config.chapters} selected={value.mainScope} onChange={next => set('mainScope', next)} prefix="main"/>
    <CheckGroup title="已学边界" hint="解题允许使用的高中章节，与主考范围分别确认。" items={config.chapters} selected={value.learnedScope} onChange={next => set('learnedScope', next)} prefix="learned"/>
    <CheckGroup title="本次允许的显式前提" hint="至少有一条完整解法符合已学边界和这些前提，题目才可自动选入。" items={config.premises} selected={value.premises} onChange={next => set('premises', next)} prefix="premise"/>
    <details className="foundation"><summary>初中基础依赖 · 自动注入</summary><ul>{(config.foundation || config.context?.foundation || []).map(item => <li key={item}>{item}</li>)}</ul></details>
    <CheckGroup title="允许使用的材料" items={config.sources.map(item => ({ id: item.sourceId, label: sourceLabel(item.sourceId, config) }))} selected={value.sourceIds} onChange={next => set('sourceIds', next)} prefix="source"/>
    <fieldset className="field-section"><legend>题型与题量</legend><div className="count-grid">{Object.entries(typeLabels).map(([type, label]) => <label className="field" key={type}>{label}题数<input type="number" min="0" max="30" required value={value.counts[type]} onChange={event => set('counts', { ...value.counts, [type]: Number(event.target.value) })}/></label>)}</div><p className="help">蓝图将按当前题量生成题位，随后可调整考查任务及分值。</p></fieldset>
    <div className="action-row"><button className="primary" type="submit" disabled={busy}>{busy ? '正在生成蓝图…' : '生成蓝图'}</button><span className="muted">使用可见预设生成，可在下一步核查与编辑。</span></div>
  </form>;
}
