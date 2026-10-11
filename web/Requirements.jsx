import { Select } from './Select.jsx';
import React, { useState } from 'react';
import { sourceLabel, typeLabels } from './api.js';

function CheckGroup({ title, hint, items, selected, onChange, prefix }) {
  function toggle(id, checked) { onChange(checked ? [...selected, id] : selected.filter(value => value !== id)); }
  return <fieldset className="field-section"><legend>{title}</legend>{hint ? <p className="help">{hint}</p> : null}<div className="check-list">{items.map(item => <label className="check-item" key={item.id} htmlFor={`${prefix}-${item.id}`}><input id={`${prefix}-${item.id}`} type="checkbox" checked={selected.includes(item.id)} onChange={event => toggle(item.id, event.target.checked)}/><span>{item.label}{item.description ? <small>{item.description}</small> : null}</span></label>)}</div></fieldset>;
}

function OptionalTags({ label, initialValue, onChange }) {
  const [text, setText] = useState(() => (initialValue || []).join('，'));
  return <label className="field">{label}<input value={text} maxLength={300} placeholder="可留空；多个用逗号分隔" onChange={event => {
    const next = event.target.value;
    setText(next);
    onChange(next.split(/[,，]/).map(item => item.trim()).filter(Boolean));
  }}/><small>教师自定义描述，当前不映射为官方编码。</small></label>;
}

function TeachingGoal({ goal, index, chapters, onChange, onRemove, busy }) {
  const scope = goal.knowledgeScope || [];
  const conditions = goal.conditions || { prompt: 'unspecified', response: 'unspecified' };
  return <fieldset className="teaching-goal" disabled={busy}>
    <legend>目标 {index + 1}</legend>
    <div className="goal-heading"><span className={goal.observable?.trim() && scope.length ? 'muted' : 'warning-text'}>{goal.observable?.trim() && scope.length ? '教师填写 · 待在蓝图中安排' : '待补充：明确知识范围与学生表现'}</span><button type="button" onClick={onRemove} aria-label={`删除目标 ${index + 1}`}>删除目标</button></div>
    <label className="field">学生要做到什么<textarea value={goal.observable || ''} rows="2" maxLength={1000} placeholder="例如：能解释空集为何是任意集合的子集，并写出依据" onChange={event => onChange({ observable: event.target.value })}/><small>描述可以观察的表现。仅填写“提高能力”还需要进一步说明。</small></label>
    <div className="goal-options">
      <label className="field">认知要求<Select value={goal.cognition || 'unspecified'} onChange={event => onChange({ cognition: event.target.value })}><option value="unspecified">暂不指定</option><option value="understand">理解与解释</option><option value="apply">应用与操作</option><option value="reason">推理与论证</option></Select></label>
      <label className="field">要求强度<Select value={goal.priority} onChange={event => onChange({ priority: event.target.value })}><option value="required">必须满足</option><option value="preferred">尽量满足</option></Select></label>
      <label className="field">提示条件<Select value={conditions.prompt} onChange={event => onChange({ conditions: { ...conditions, prompt: event.target.value } })}><option value="unspecified">暂不指定</option><option value="provided">允许提供提示</option><option value="independent">要求独立完成</option></Select></label>
      <label className="field">作答要求<Select value={conditions.response} onChange={event => onChange({ conditions: { ...conditions, response: event.target.value } })}><option value="unspecified">暂不指定</option><option value="answer">给出答案即可</option><option value="written_reasoning">写出完整推理过程</option></Select></label>
    </div>
    <fieldset className="goal-scope"><legend>目标知识范围</legend><div className="check-list">{chapters.map(chapter => <label className="check-item" key={chapter.id}><input type="checkbox" checked={scope.includes(chapter.id)} onChange={event => onChange({ knowledgeScope: event.target.checked ? [...scope, chapter.id] : scope.filter(id => id !== chapter.id) })}/><span>{chapter.label}</span></label>)}</div></fieldset>
    <details className="goal-dimensions"><summary>补充能力与核心素养（可选）</summary><div className="goal-options"><OptionalTags label="能力要求" initialValue={goal.abilities} onChange={abilities => onChange({ abilities })}/><OptionalTags label="核心素养" initialValue={goal.literacies} onChange={literacies => onChange({ literacies })}/></div></details>
    <p className="goal-provenance">来源：教师填写 · 目标版本 {goal.version}</p>
  </fieldset>;
}

export function Requirements({ config, value, onChange, onSubmit, busy }) {
  const set = (key, next) => onChange(current => ({ ...current, [key]: next }));
  const goals = value.teachingGoals || [];
  function changeGoal(id, patch) {
    onChange(current => ({ ...current, teachingGoals: (current.teachingGoals || []).map(goal => goal.id === id ? { ...goal, ...patch, version: goal.version + 1 } : goal) }));
  }
  function addGoal() {
    const id = `teacher-goal-${crypto.randomUUID()}`;
    onChange(current => ({ ...current, teachingGoals: [...(current.teachingGoals || []), { id, version: 1, knowledgeScope: [], cognition: 'unspecified', observable: '', conditions: { prompt: 'unspecified', response: 'unspecified' }, priority: 'required', abilities: [], literacies: [], source: { kind: 'teacher', text: current.goal } }] }));
  }
  return <form onSubmit={event => { event.preventDefault(); onSubmit(); }}><fieldset className="requirements-fields" disabled={busy}>
    <div className="section-heading"><h2>教学条件与组卷要求</h2><span className="muted">确认条件后由 AI 规划蓝图</span></div>
    <div className="form-grid">
      <label className="field wide">试卷标题<input value={value.title} maxLength={120} required onChange={event => set('title', event.target.value)}/></label>
      <label className="field">年级<input value={value.grade} maxLength={60} required onChange={event => set('grade', event.target.value)}/></label>
      <label className="field">时长（分钟）<input type="number" value={value.durationMinutes} min="1" max="300" required onChange={event => set('durationMinutes', Number(event.target.value))}/></label>
      <label className="field">计分方式<Select value={value.scoringMode ?? 'points'} onChange={event => onChange(current => ({ ...current, scoringMode: event.target.value, targetScore: event.target.value === 'none' ? 0 : current.targetScore || 100 }))}><option value="none">不计分</option><option value="points">计分</option></Select></label>
      {value.scoringMode !== 'none' ? <label className="field">目标总分<input type="number" value={value.targetScore} min="1" max="1000" required onChange={event => set('targetScore', Number(event.target.value))}/></label> : null}
      <label className="field">目标难度<input type="number" value={value.targetDifficulty ?? ''} min="0" max="1" step="0.01" placeholder="暂不指定" onChange={event => set('targetDifficulty', event.target.value === '' ? null : Number(event.target.value))}/><small>可留空；0～1 表示难度偏好，与认知要求分别设置。</small></label>
      <label className="field wide">教学目的<textarea value={value.goal} maxLength={1000} required rows="3" onChange={event => set('goal', event.target.value)}/></label>
    </div>
    <section className="teaching-goals" aria-labelledby="teaching-goals-heading">
      <h3 id="teaching-goals-heading">具体教学目标</h3>
      <p className="help">将教学目的补充为学生可以展示的表现，再安排到题位。当前由教师填写，系统不会从上方文字中自动推断目标。四个维度不必全部填写。</p>
      {!goals.length ? <p className="help">尚未添加具体目标，AI 将依据教学目的与已确认范围提出考查任务；不会自动证明目标覆盖。</p> : null}
      {goals.map((goal, index) => <TeachingGoal key={goal.id} goal={goal} index={index} chapters={config.chapters} busy={busy} onChange={patch => changeGoal(goal.id, patch)} onRemove={() => onChange(current => ({ ...current, teachingGoals: (current.teachingGoals || []).filter(item => item.id !== goal.id) }))}/>)}
      <button type="button" onClick={addGoal} disabled={busy}>添加教学目标</button>
      {goals.length ? <p className="help">未明确的目标保留待澄清状态；“必须满足”不会自动改成“尽量满足”。</p> : null}
    </section>
    <CheckGroup title="主考范围" hint="本卷主要考查什么。" items={config.chapters} selected={value.mainScope} onChange={next => set('mainScope', next)} prefix="main"/>
    <CheckGroup title="已学边界" hint="解题允许使用的高中章节，与主考范围分别确认。" items={config.chapters} selected={value.learnedScope} onChange={next => set('learnedScope', next)} prefix="learned"/>
    <CheckGroup title="额外允许的知识与方法" hint="至少有一条完整解法符合已学边界和这些前提，题目才可自动选入。" items={config.premises} selected={value.premises} onChange={next => set('premises', next)} prefix="premise"/>
    <details className="foundation"><summary>初中基础依赖 · 自动注入</summary><ul>{(config.foundation || config.context?.foundation || []).map(item => <li key={item}>{item}</li>)}</ul></details>
    <CheckGroup title="允许使用的材料" items={config.sources.map(item => ({ id: item.sourceId, label: sourceLabel(item.sourceId, config) }))} selected={value.sourceIds} onChange={next => set('sourceIds', next)} prefix="source"/>
    <fieldset className="field-section"><legend>题型与题量</legend><div className="count-grid">{Object.entries(typeLabels).map(([type, label]) => <label className="field" key={type}>{label}题数<input type="number" min="0" max="30" required value={value.counts[type]} onChange={event => set('counts', { ...value.counts, [type]: Number(event.target.value) })}/></label>)}</div><p className="help">蓝图将按当前题量生成题位，随后可调整考查任务及分值。</p></fieldset>
    <div className="action-row"><button className="primary" type="submit" disabled={busy}>{busy ? '正在生成蓝图…' : '生成蓝图'}</button><span className="muted">由 AI 规划蓝图，可在下一步核查与编辑。</span></div>
  </fieldset></form>;
}
