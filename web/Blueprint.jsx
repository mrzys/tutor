import React, { useId, useRef, useState } from 'react';
import { ChevronDown, Plus, Sparkles, Trash2 } from 'lucide-react';
import { allocateParts, blueprintError, typeLabels, typeTitles } from './api.js';
import { addBlueprintSlot, canRemoveGoalLink, changeBlueprintTask, goalAssignmentSummary, goalTaskCompatible, removeBlueprintSlot } from './blueprint-review.js';
import { Select } from './Select.jsx';
import { MathText } from './MathText.jsx';
import { Explanation } from './Explanation.jsx';
import './Blueprint.css';
import './BlueprintSummary.css';
import { includesSection } from '../src/curriculum/section-identity.mjs';

const cognitionLabels = { unspecified: '暂不指定', understand: '理解与解释', apply: '应用与操作', reason: '推理与论证' };
const goalStatusLabels = { pending_clarification: '待澄清', planned: '已安排题位', unassigned: '未安排题位' };
const promptLabels = { provided: '允许提供提示', independent: '独立完成' };
const responseLabels = { answer: '给出答案即可', written_reasoning: '写出完整推理过程' };
const issueText = issue => typeof issue === 'string' ? issue : issue.message || issue.reason || '需要核查';
const questionTypes = ['single_choice', 'fill_blank', 'free_response'];
const renderTaskLabel = label => <MathText text={label}/>;

function TeachingGoalReview({ config, blueprint, checking, busy, onEdit, onShowSlots }) {
  const goals = blueprint.requirements.teachingGoals || [];
  const reviews = new Map((blueprint.goalReview?.items || []).map(item => [item.goalId, item]));
  const chapters = new Map(config.chapters.map(item => [item.id, item.label]));
  const chapterNames = ids => ids.map(id => chapters.get(id) || id).join('、') || '未指定';
  const assignment = goalAssignmentSummary(blueprint.slots, goals);
  const scored = blueprint.requirements.scoringMode !== 'none';
  const edit = (step, label) => <button type="button" className="link-button requirement-edit" disabled={busy} onClick={() => onEdit(step)}>{label}</button>;
  return <section className="blueprint-requirements">
    <section className="goal-review" aria-label="需求与教学目标核对">
    <dl className="blueprint-scope"><dt>教学用途 {edit('purpose', '修改用途')}</dt><dd>{blueprint.requirements.goal}</dd><dt>主考范围 {edit('scope', '修改范围')}</dt><dd>{chapterNames(blueprint.requirements.mainScope)}</dd><dt>{scored ? '题量与分值' : '题量'} {edit('size', scored ? '修改题量与分值' : '修改题量')}</dt><dd>{blueprint.slots.length} 题{scored ? ` · ${blueprint.requirements.targetScore} 分` : ''} · {blueprint.requirements.durationMinutes} 分钟</dd></dl>
    {goals.length ? <><div className="goal-review-title"><strong>考查目标</strong>{edit('goal', '修改教学目标')}</div>
    <p className="help">{assignment.linkedCount} 个题位承担目标 · {assignment.practiceCount} 个题位用于基础练习</p></> : null}
    {goals.length ? <ol className="goal-review-list">{goals.map((goal, index) => {
      const review = reviews.get(goal.id);
      const slotNumbers = blueprint.slots.filter(slot => (slot.goalIds || []).includes(goal.id)).map(slot => slot.number);
      return <li key={goal.id}>
        <div className="goal-review-title"><strong>目标 {index + 1}{goal.priority === 'required' ? ' · 必须考查' : ''}</strong><span className={review?.status === 'planned' ? 'muted' : 'warning-text'}>{checking ? '正在核查…' : goalStatusLabels[review?.status] || '待核查'}</span></div>
        <p><MathText text={goal.observable || '尚未描述学生要做到什么'}/></p>
        <div className="goal-slot-summary"><span>{slotNumbers.length ? `关联题位：${slotNumbers.join('、')}` : '暂未关联题位'}</span>{blueprint.slots.some(slot => (slot.goalIds || []).includes(goal.id) || goalTaskCompatible(goal, config.tasks.find(task => task.id === slot.taskId))) ? <button type="button" className="link-button" disabled={busy} onClick={() => onShowSlots(goal)}>调整关联题位</button> : <span className="warning-text">暂无兼容题位</span>}</div>
      </li>;
    })}</ol> : null}
    {goals.length ? <p className="help">目标关联是规划建议，题目支持证据仍待复核；必须考查的目标缺少证据时保留缺题。</p> : null}
    {goals.length ? <details className="goal-review-details"><summary>目标细节与依据</summary>
      {goals.map((goal, index) => {
        const conditions = [promptLabels[goal.conditions?.prompt], responseLabels[goal.conditions?.response]].filter(Boolean);
        const review = reviews.get(goal.id);
        return <div key={goal.id} className="goal-evidence-detail">
          <strong>目标 {index + 1}</strong>
          <p className="help">认知要求：{cognitionLabels[goal.cognition] || '待明确'}</p>
          <p className="help">知识范围：{chapterNames(goal.knowledgeScope || [])}</p>
          {conditions.length ? <p className="help">{conditions.join(' · ')}</p> : null}
          {goal.abilities?.length ? <p className="help">能力：{goal.abilities.join('、')}</p> : null}
          {goal.literacies?.length ? <p className="help">核心素养：{goal.literacies.join('、')}</p> : null}
          {goal.source?.text ? <p className="help">原始需求：{goal.source.text}</p> : null}
          {!checking && review?.issues?.length ? <ul className="goal-issues">{review.issues.map((issue, issueIndex) => <li key={issueIndex}>{issueText(issue)}</li>)}</ul> : null}
        </div>;
      })}
    </details> : null}
    </section>
  </section>;
}

function BlueprintOrigin({ generation }) {
  const ai = generation?.mode === 'llm';
  const summary = generation?.summary || (ai ? '按本次需求安排考查任务，并核查题库中的可选题。' : '按预设安排考查任务，可逐项修改。');
  return <section className="blueprint-origin" aria-label="蓝图规划来源">
    <strong className="blueprint-explanation-heading">安排说明</strong><Explanation className="blueprint-advice-summary" text={summary}/>
  </section>;
}

export function Blueprint({ config, value, onChange, onConfirm, onBack, onAiAdjust, busy, checking, checkError }) {
  const customParts = useRef(new Set());
  const tabPrefix = useId();
  const tabRefs = useRef({});
  const [activeType, setActiveType] = useState(() => questionTypes.find(type => value.slots.some(slot => slot.questionType === type)) || questionTypes[0]);
  const [expandedSlots, setExpandedSlots] = useState(() => new Set());
  const [adjustingLinks, setAdjustingLinks] = useState(false);
  const [assignmentError, setAssignmentError] = useState('');
  const points = value.slots.reduce((sum, slot) => sum + slot.points, 0);
  const scored = value.requirements.scoringMode !== 'none';
  const columnCount = scored ? 5 : 4;
  const invalid = blueprintError(value);
  const supply = new Map((value.supply?.slotSupply || []).map(item => [item.slotId, item]));
  const goals = value.requirements.teachingGoals || [];
  const groups = questionTypes.map(type => ({ type, slots: value.slots.filter(slot => slot.questionType === type) }));
  const activeGroup = groups.find(group => group.type === activeType);
  const missingSlots = value.slots.filter(slot => !(supply.get(slot.slotId)?.eligibleCount > 0));
  const unassignedRequired = goals.filter(goal => goal.priority === 'required' && !value.slots.some(slot => (slot.goalIds || []).includes(goal.id)));
  const requiredIssues = (value.goalReview?.items || []).filter(item => item.priority === 'required' && item.issues?.length && !unassignedRequired.some(goal => goal.id === item.goalId));
  function toggleSlot(id) { setExpandedSlots(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  function navigateTabs(event, type) {
    const index = questionTypes.indexOf(type);
    const target = event.key === 'ArrowRight' ? (index + 1) % questionTypes.length
      : event.key === 'ArrowLeft' ? (index + questionTypes.length - 1) % questionTypes.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? questionTypes.length - 1 : null;
    if (target === null) return;
    event.preventDefault();
    const next = questionTypes[target];
    setActiveType(next);
    tabRefs.current[next]?.focus();
  }
  function addSlot(type) {
    const compatibleTasks = config.tasks.filter(task => task.questionType === type);
    const task = compatibleTasks.find(task => task.sectionIds.every(id => includesSection(value.requirements.mainScope, id))) || compatibleTasks[0];
    try {
      const next = addBlueprintSlot(value, task, `slot-${crypto.randomUUID()}`);
      setAssignmentError('');
      onChange(() => next);
    } catch (error) { setAssignmentError(error.message); }
  }
  function removeSlot(slot) {
    try {
      const next = removeBlueprintSlot(value, slot.slotId);
      setAssignmentError('');
      setExpandedSlots(current => new Set([...current].filter(id => id !== slot.slotId)));
      customParts.current.delete(slot.slotId);
      onChange(() => next);
    } catch (error) {
      setAssignmentError(error.message);
      const goal = goals.find(goal => (slot.goalIds || []).includes(goal.id) && !canRemoveGoalLink(value.slots, slot, goal));
      if (goal) showGoalSlots(goal);
    }
  }
  function changeSlot(id, patch) { onChange(current => ({ ...current, slots: current.slots.map(slot => slot.slotId === id ? { ...slot, ...patch } : slot) })); }
  function changeTask(slot, taskId) {
    const task = config.tasks.find(item => item.id === taskId);
    try {
      const next = changeBlueprintTask(value, slot.slotId, task, { preservePartPoints: customParts.current.has(slot.slotId) });
      setAssignmentError('');
      onChange(() => next);
    } catch (error) { setAssignmentError(error.message); }
  }
  function changePoints(slot, next) {
    const task = config.tasks.find(item => item.id === slot.taskId);
    changeSlot(slot.slotId, { points: next, partPoints: customParts.current.has(slot.slotId) ? slot.partPoints : allocateParts(task, next) });
  }
  function changePart(slot, partId, points) {
    customParts.current.add(slot.slotId);
    changeSlot(slot.slotId, { partPoints: slot.partPoints.map(part => part.partId === partId ? { ...part, points } : part) });
  }
  function changeGoalLink(slot, goalId, checked) {
    const goal = goals.find(item => item.id === goalId);
    if (!checked && !canRemoveGoalLink(value.slots, slot, goal)) return;
    setAssignmentError('');
    const goalIds = slot.goalIds || [];
    changeSlot(slot.slotId, { goalIds: checked ? [...goalIds, goalId] : goalIds.filter(id => id !== goalId) });
  }
  function showGoalSlots(goal) {
    const matching = value.slots.filter(slot => (slot.goalIds || []).includes(goal.id) || goalTaskCompatible(goal, config.tasks.find(task => task.id === slot.taskId)));
    setExpandedSlots(current => new Set([...current, ...matching.map(slot => slot.slotId)]));
    setAdjustingLinks(true);
    const first = matching.find(slot => (slot.goalIds || []).includes(goal.id)) || matching[0];
    if (first) {
      setActiveType(first.questionType);
      requestAnimationFrame(() => document.getElementById(`blueprint-slot-${first.slotId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    }
  }
  return <section className="blueprint-editor" aria-label="蓝图编辑">
    <div className="blueprint-context">
    <details className="blueprint-summary-details">
      <summary><span>需求与安排说明</span><ChevronDown size={14} aria-hidden="true"/></summary>
      <div className="blueprint-summary-content">
        <BlueprintOrigin generation={value.generation}/>
        <TeachingGoalReview config={config} blueprint={value} checking={checking} busy={busy} onEdit={onBack} onShowSlots={showGoalSlots}/>
      </div>
    </details>
    {!checking && requiredIssues.length ? <div className="blueprint-goal-warning" role="status"><strong>必须考查的目标仍需核对</strong><ul>{requiredIssues.map(item => <li key={item.goalId}><MathText text={item.observable || '尚未明确考查目标'}/>：{item.issues.map(issueText).join('；')} <button type="button" className="link-button" disabled={busy} onClick={() => onBack('goal')}>修改目标</button></li>)}</ul></div> : null}
    {!checking && !checkError && !invalid && missingSlots.length ? <p className="blueprint-supply-warning" role="status">{missingSlots.length} 个题位暂无合格候选，确认后将保留缺题。可调整考查任务，或修改范围与教学目标。</p> : null}
    </div>
    <div className="blueprint-detailed-plan">
    <div className="section-heading"><h2>题位规划</h2><div className="blueprint-detail-actions"><span className="muted">{value.slots.length} 题{scored ? ` · ${points} 分` : ''}</span>{expandedSlots.size > 0 ? <button type="button" className="link-button" onClick={() => { setExpandedSlots(new Set()); setAdjustingLinks(false); }}>{adjustingLinks ? '完成关联调整' : '收起题位详情'}</button> : null}</div></div>
    <div className="blueprint-type-tabs" role="tablist" aria-label="题位类型">{groups.map(group => <button type="button" key={group.type} role="tab" id={`${tabPrefix}-tab-${group.type}`} aria-selected={group.type === activeType} aria-controls={`${tabPrefix}-panel-${group.type}`} tabIndex={group.type === activeType ? 0 : -1} ref={element => { tabRefs.current[group.type] = element; }} onClick={() => setActiveType(group.type)} onKeyDown={event => navigateTabs(event, group.type)}>{typeLabels[group.type]}<span className="blueprint-tab-count">{group.slots.length}</span></button>)}</div>
    <div className="blueprint-type-panel" role="tabpanel" id={`${tabPrefix}-panel-${activeType}`} aria-labelledby={`${tabPrefix}-tab-${activeType}`} tabIndex={0}>
    {activeGroup.slots.length ? <div className="table-scroll"><table className="blueprint-table blueprint-compact"><caption className="sr-only">{typeTitles[activeType]}题位及当前真实供给</caption><thead><tr><th>题位</th><th>考查任务 <span className="blueprint-edit-hint">点击修改</span></th>{scored ? <th>分值</th> : null}<th>可选题</th><th><span className="sr-only">题位操作</span></th></tr></thead>{[activeGroup].map(group => <tbody key={group.type}>
      {group.slots.map(slot => {
      const item = supply.get(slot.slotId);
      const expanded = expandedSlots.has(slot.slotId);
      return <React.Fragment key={slot.slotId}>
        <tr id={`blueprint-slot-${slot.slotId}`} className={expanded ? 'slot-expanded' : ''}>
          <td>{slot.number}</td>
          <td><Select className="blueprint-task-edit" title="点击修改考查任务" renderLabel={renderTaskLabel} aria-label={`第 ${slot.number} 题考查任务`} value={slot.taskId} disabled={busy} onChange={event => changeTask(slot, event.target.value)}>{config.tasks.filter(task => task.questionType === slot.questionType && (task.id === slot.taskId || task.sectionIds.every(id => includesSection(value.requirements.mainScope, id)))).map(task => <option key={task.id} value={task.id}>{task.label}</option>)}</Select></td>
          {scored ? <td><input aria-label={`第 ${slot.number} 题分值`} className="point-input" type="number" min="0" max="1000" value={slot.points} disabled={busy} onChange={event => changePoints(slot, Number(event.target.value))}/></td> : null}
          <td><span className={checking || checkError || invalid ? 'muted' : !item?.eligibleCount ? 'warning-text' : ''}>{checking || checkError || invalid ? '待核查' : `${item?.eligibleCount ?? 0} 题`}</span>{!checking && item?.readFailures?.length ? <small className="error-text">{item.readFailures.length} 题读取失败</small> : null}</td>
          <td><div className="blueprint-slot-actions"><button type="button" className="blueprint-slot-ai" aria-label={`AI 调整第 ${slot.number} 题位`} title="AI 调整本题位" disabled={busy} onClick={() => onAiAdjust?.(slot)}><Sparkles size={14} aria-hidden="true"/><span>AI 调整</span></button><button type="button" className="slot-details-toggle" aria-label={`第 ${slot.number} 题详情`} aria-expanded={expanded} aria-controls={`slot-detail-${slot.slotId}`} onClick={() => toggleSlot(slot.slotId)}>详情<ChevronDown size={14}/></button></div></td>
        </tr>
        {expanded ? <tr className="slot-detail-row"><td colSpan={columnCount}><div id={`slot-detail-${slot.slotId}`}>
          {slot.planningReason ? <p className="slot-planning-reason"><strong>规划理由：</strong><MathText text={slot.planningReason}/></p> : null}
          {goals.length ? <fieldset className="slot-goals" disabled={busy}><legend>本题承担的教学目标</legend><div className="check-list">{goals.map((goal, index) => { const linked = (slot.goalIds || []).includes(goal.id); const lastRequired = linked && !canRemoveGoalLink(value.slots, slot, goal); return <label className="check-item" key={goal.id}><input type="checkbox" checked={linked} disabled={lastRequired || !goalTaskCompatible(goal, config.tasks.find(task => task.id === slot.taskId))} onChange={event => changeGoalLink(slot, goal.id, event.target.checked)}/><span>目标 {index + 1}{goal.priority === 'required' ? ' · 必须考查' : ''}<small>{goal.observable || '待澄清目标'}{lastRequired ? '（唯一关联题位）' : ''}</small></span></label>; })}</div><p className="help">不关联目标时，本题按已确认范围安排基础练习。必须目标至少保留一个合适题位；先关联其他题位后，可解除此处关联。</p></fieldset> : null}
          {scored && slot.partPoints.length ? <div className="part-controls"><span>小问分值</span>{slot.partPoints.map((part, index) => <label key={part.partId}>第 {index + 1} 问<input type="number" aria-label={`第 ${slot.number} 题第 ${index + 1} 问分值`} min="0" max="1000" className="point-input" value={part.points} disabled={busy} onChange={event => changePart(slot, part.partId, Number(event.target.value))}/></label>)}</div> : null}
          {!checking && !checkError && !invalid ? <p className="help slot-evidence-note">{item?.eligibleCount ?? 0} 题符合条件{item?.unknownCount ? `，${item.unknownCount} 题证据不足` : ''}。可选数按题位独立核算，同卷去重后可能减少。</p> : null}
          <div className="slot-detail-footer"><button type="button" className="link-button blueprint-slot-remove" aria-label={`删除第 ${slot.number} 题位`} disabled={busy} onClick={() => removeSlot(slot)}><Trash2 size={14} aria-hidden="true"/>删除题位</button></div>
        </div></td></tr> : null}
      </React.Fragment>;
    })}</tbody>)}</table></div> : <p className="blueprint-type-empty">还没有安排{typeLabels[activeType]}题。</p>}
    <div className="blueprint-group-add"><button type="button" className="link-button" aria-label={`添加${typeLabels[activeType]}题位`} disabled={busy || value.slots.length >= 60 || activeGroup.slots.length >= 30 || !config.tasks.some(task => task.questionType === activeType)} onClick={() => addSlot(activeType)}><Plus size={14} aria-hidden="true"/>添加{typeLabels[activeType]}题</button></div>
    </div>
    {groups.filter(group => group.type !== activeType).map(group => <div key={group.type} role="tabpanel" id={`${tabPrefix}-panel-${group.type}`} aria-labelledby={`${tabPrefix}-tab-${group.type}`} hidden/>)}
    </div>
    <footer className="blueprint-confirm-footer">
    <div aria-live="polite">{assignmentError ? <p className="error-text">{assignmentError}</p> : null}{unassignedRequired.length ? <p className="error-text">仍有 {unassignedRequired.length} 个必须目标未关联题位，请展开详情安排，或直接修改教学目标。</p> : null}{invalid ? <p className="error-text">{invalid}</p> : null}{checkError ? <p className="error-text">供给核查失败：{checkError}。重新编辑题位可重试。</p> : null}{checking ? <p className="muted">正在按最新蓝图核查真实供给…</p> : null}</div>
    {scored && points !== value.requirements.targetScore ? <p className="warning-text">当前 {points} 分，与需求目标 {value.requirements.targetScore} 分不同。</p> : null}
    <div className="action-row"><span className="muted">{value.slots.length} 题{scored ? ` · ${points} 分` : ' · 不计分'}</span><button className="primary" onClick={onConfirm} disabled={busy || checking || Boolean(invalid) || Boolean(checkError) || unassignedRequired.length > 0 || !value.slots.length}>{busy ? '正在选题并保存…' : '采用安排，开始选题'}</button></div>
    </footer>
  </section>;
}
