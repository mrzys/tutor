import React, { useRef } from 'react';
import { allocateParts, blueprintError, typeLabels } from './api.js';

export function Blueprint({ config, value, onChange, onConfirm, busy, checking, checkError }) {
  const customParts = useRef(new Set());
  const points = value.slots.reduce((sum, slot) => sum + slot.points, 0);
  const invalid = blueprintError(value);
  const supply = new Map((value.supply?.slotSupply || []).map(item => [item.slotId, item]));
  function changeSlot(id, patch) { onChange(current => ({ ...current, slots: current.slots.map(slot => slot.slotId === id ? { ...slot, ...patch } : slot) })); }
  function changeTask(slot, taskId) {
    const task = config.tasks.find(item => item.id === taskId);
    const sameParts = slot.partPoints.length === task.partIds.length && slot.partPoints.every(part => task.partIds.includes(part.partId));
    changeSlot(slot.slotId, { taskId, taskLabel: task.label, partPoints: customParts.current.has(slot.slotId) && sameParts ? slot.partPoints : allocateParts(task, slot.points) });
  }
  function changePoints(slot, next) {
    const task = config.tasks.find(item => item.id === slot.taskId);
    changeSlot(slot.slotId, { points: next, partPoints: customParts.current.has(slot.slotId) ? slot.partPoints : allocateParts(task, next) });
  }
  function changePart(slot, partId, points) {
    customParts.current.add(slot.slotId);
    changeSlot(slot.slotId, { partPoints: slot.partPoints.map(part => part.partId === partId ? { ...part, points } : part) });
  }
  return <>
    <div className="section-heading"><h2>题位与考查任务</h2><span className="muted">集合专项预设 · 可调整</span></div>
    <div className="table-scroll"><table className="blueprint-table"><caption className="sr-only">选题蓝图及当前真实供给</caption><thead><tr><th>题位</th><th>题型</th><th>考查任务</th><th>分值</th><th>可选题</th></tr></thead><tbody>{value.slots.map(slot => {
      const item = supply.get(slot.slotId);
      return <React.Fragment key={slot.slotId}><tr><td>{slot.number}</td><td>{typeLabels[slot.questionType]}</td><td><select aria-label={`第 ${slot.number} 题考查任务`} value={slot.taskId} disabled={busy} onChange={event => changeTask(slot, event.target.value)}>{config.tasks.filter(task => task.questionType === slot.questionType).map(task => <option key={task.id} value={task.id}>{task.label}</option>)}</select></td><td><input aria-label={`第 ${slot.number} 题分值`} className="point-input" type="number" min="0" max="1000" value={slot.points} disabled={busy} onChange={event => changePoints(slot, Number(event.target.value))}/></td><td><span className={checking || checkError || invalid ? 'muted' : ''}>{checking || checkError || invalid ? '待核查' : `${item?.eligibleCount ?? 0} 题`}</span>{!checking && !checkError && !invalid && item?.unknownCount ? <small className="supply-note">{item.unknownCount} 题证据不足</small> : null}{!checking && item?.readFailures?.length ? <small className="error-text">{item.readFailures.length} 题读取失败</small> : null}</td></tr>{slot.partPoints.length ? <tr className="part-row"><td></td><td colSpan="4"><div className="part-controls"><span>小问分值</span>{slot.partPoints.map((part, index) => <label key={part.partId}>第 {index + 1} 问<input type="number" aria-label={`第 ${slot.number} 题第 ${index + 1} 问分值`} min="0" max="1000" className="point-input" value={part.points} disabled={busy} onChange={event => changePart(slot, part.partId, Number(event.target.value))}/></label>)}</div></td></tr> : null}</React.Fragment>;
    })}</tbody></table></div>
    {!value.slots.length ? <p className="empty-message">当前题量为 0，请返回需求设置题量。</p> : null}
    <div className="blueprint-total"><strong>计划 {value.slots.length} 题 · {points} 分</strong><p>难度目标 {value.requirements.targetDifficulty.toFixed(2)}；候选实际难度未知</p>{points !== value.requirements.targetScore ? <p className="warning-text">与需求目标 {value.requirements.targetScore} 分相差 {points - value.requirements.targetScore} 分，将保留当前题位赋分。</p> : null}</div>
    <div aria-live="polite">{invalid ? <p className="error-text">{invalid}</p> : null}{checkError ? <p className="error-text">供给核查失败：{checkError}。重新编辑题位可重试。</p> : null}{checking ? <p className="muted">正在按最新蓝图核查真实供给…</p> : null}</div>
    <div className="action-row"><button className="primary" onClick={onConfirm} disabled={busy || checking || Boolean(invalid) || Boolean(checkError) || !value.slots.length}>{busy ? '正在选题并保存…' : '确认蓝图并选题'}</button><span className="muted">确认后按当前条件检索真实题目并保存草稿。</span></div>
    <details className="supply-details"><summary>查看材料与供给说明</summary><p>每行可选数独立核算；同卷重复限制可能使后续题位留空。差异或未知题目不会自动选入。</p><p>{value.supply?.pendingCount ?? 0} 个源单元尚待整理，不计入可选题。</p>{value.supply?.failures?.length ? <ul>{value.supply.failures.map(item => <li key={item.questionId}>{item.questionId}：{item.message}</li>)}</ul> : null}</details>
  </>;
}
