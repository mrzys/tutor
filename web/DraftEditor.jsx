import React, { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { allocateParts, api, sourceLabel, statusLabels, typeLabels } from './api.js';
import { MathText } from './MathText.jsx';

export const DraftOperationContext = createContext(null);

export function Modal({ title, onClose, children, busy }) {
  const dialog = useRef(null);
  const titleId = useId();
  const operations = useContext(DraftOperationContext);
  useEffect(() => { dialog.current.showModal(); }, []);
  return <dialog ref={dialog} aria-labelledby={titleId} className="editor-dialog" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}><div className="dialog-heading"><h2 id={titleId}>{title}</h2><button aria-label="关闭" disabled={busy} onClick={onClose}>关闭</button></div>{operations?.failure ? <div className="notice error" role="alert"><span>{operations.failure.message}</span>{operations.failure.retry ? <button disabled={busy} onClick={operations.retry}>重试同一操作</button> : null}<button disabled={busy} onClick={operations.reload}>读取最新草稿</button></div> : null}{children}</dialog>;
}

export function PointFields({ value, onChange }) {
  const invalid = !Number.isInteger(value.points) || value.points < 0 || value.points > 1000 || value.partPoints.some(part => !Number.isInteger(part.points) || part.points < 0) || (value.partPoints.length && value.partPoints.reduce((sum, part) => sum + part.points, 0) !== value.points);
  return <><div className="edit-point-fields"><label className="field">题位分值<input type="number" min="0" max="1000" required value={value.points} onChange={event => onChange({ ...value, points: Number(event.target.value) })}/></label>{value.partPoints.map((part, index) => <label className="field" key={part.partId}>第 {index + 1} 小问分值<input type="number" min="0" max="1000" required value={part.points} onChange={event => onChange({ ...value, partPoints: value.partPoints.map(item => item.partId === part.partId ? { ...item, points: Number(event.target.value) } : item) })}/></label>)}</div>{invalid ? <p className="error-text" role="alert">分值须为非负整数，小问合计须等于题位分值。</p> : null}</>;
}

export function PointsEditor({ slot, config, onApply, onClose, busy }) {
  const [value, setValue] = useState({ points: slot.points, partPoints: structuredClone(slot.partPoints) });
  const task = config.tasks.find(item => item.id === slot.taskId);
  const invalid = !Number.isInteger(value.points) || value.points < 0 || value.points > 1000 || value.partPoints.some(part => !Number.isInteger(part.points) || part.points < 0) || (value.partPoints.length > 0 && value.partPoints.reduce((sum, part) => sum + part.points, 0) !== value.points);
  return <Modal title={`修改第 ${slot.number} 题分值`} onClose={onClose} busy={busy}><form onSubmit={event => { event.preventDefault(); if (!invalid) onApply({ type: 'points', slotId: slot.slotId, ...value }); }}><PointFields value={value} onChange={setValue}/>{value.partPoints.length ? <button type="button" className="link-button" onClick={() => setValue(current => ({ ...current, partPoints: allocateParts(task, current.points) }))}>按建议比例重新分配小问</button> : null}<p className="help">仅修改本题，不调整其他题凑回计划总分；建议评分细则仍需与当前赋分核对。</p><div className="action-row"><button className="primary" disabled={busy || invalid}>保存本题分值</button></div></form></Modal>;
}

export function AddEditor({ draft, config, onApply, onClose, busy }) {
  const [taskId, setTaskId] = useState(config.tasks[0].id);
  const [value, setValue] = useState({ points: 8, partPoints: [] });
  const [afterSlotId, setAfterSlotId] = useState('');
  const task = config.tasks.find(item => item.id === taskId);
  const invalid = !Number.isInteger(value.points) || value.points < 0 || value.points > 1000 || value.partPoints.some(part => !Number.isInteger(part.points) || part.points < 0) || (value.partPoints.length > 0 && value.partPoints.reduce((sum, part) => sum + part.points, 0) !== value.points);
  function changeTask(id) { const next = config.tasks.find(item => item.id === id); const points = next.questionType === 'free_response' ? 14 : next.questionType === 'fill_blank' ? 10 : 8; setTaskId(id); setValue({ points, partPoints: allocateParts(next, points) }); }
  return <Modal title="添加题位" onClose={onClose} busy={busy}><form onSubmit={event => { event.preventDefault(); if (!invalid) onApply({ type: 'add', taskId, ...value, ...(afterSlotId ? { afterSlotId } : {}) }); }}><label className="field">题型与考查任务<select value={taskId} onChange={event => changeTask(event.target.value)}>{config.tasks.map(item => <option key={item.id} value={item.id}>{typeLabels[item.questionType]} · {item.label}</option>)}</select></label><PointFields value={value} onChange={setValue}/>{value.partPoints.length ? <button type="button" className="link-button" onClick={() => setValue(current => ({ ...current, partPoints: allocateParts(task, current.points) }))}>按建议比例重新分配小问</button> : null}<label className="field">添加位置<select value={afterSlotId} onChange={event => setAfterSlotId(event.target.value)}><option value="">末尾</option>{draft.slots.map(slot => <option key={slot.slotId} value={slot.slotId}>第 {slot.number} 题之后</option>)}</select></label><p className="help">按当前基线检索真实候选；没有合格题时保留空题位，并重新编号与计分。</p><div className="action-row"><button className="primary" disabled={busy || invalid}>添加并检索</button></div></form></Modal>;
}

function BaselineChecks({ title, items, value, onChange }) {
  return <fieldset className="field-section"><legend>{title}</legend><div className="check-list">{items.map(item => <label className="check-item" key={item.id}><input type="checkbox" checked={value.includes(item.id)} onChange={event => onChange(event.target.checked ? [...value, item.id] : value.filter(id => id !== item.id))}/><span>{item.label}{item.description ? <small>{item.description}</small> : null}</span></label>)}</div></fieldset>;
}

export function BaselineEditor({ draft, config, onApply, onClose, busy }) {
  const [value, setValue] = useState(() => structuredClone(draft.baseline.requirements));
  const set = (key, next) => setValue(current => ({ ...current, [key]: next }));
  return <Modal title="更正教学条件与来源基线" onClose={onClose} busy={busy}><form onSubmit={event => { event.preventDefault(); onApply({ type: 'baseline', requirements: value }); }}><p className="help">保存新基线并重检现题适用性，保留已有题目、分值与锁定。证据不足的题会提示未知。</p><BaselineChecks title="主考范围" items={config.chapters} value={value.mainScope} onChange={next => set('mainScope', next)}/><BaselineChecks title="已学边界" items={config.chapters} value={value.learnedScope} onChange={next => set('learnedScope', next)}/><BaselineChecks title="本次显式前提" items={config.premises} value={value.premises} onChange={next => set('premises', next)}/><details className="foundation"><summary>初中基础依赖 · 自动注入</summary><ul>{(draft.baseline.courseContext?.foundation || config.foundation || []).map(item => <li key={item}>{item}</li>)}</ul></details><BaselineChecks title="已核查来源" items={config.sources.map(item => ({ id: item.sourceId, label: sourceLabel(item.sourceId, config) }))} value={value.sourceIds} onChange={next => set('sourceIds', next)}/><p className="help">这里只提供身份与依据已核查的来源；新增材料需先整理与核查。</p><div className="action-row"><button className="primary" disabled={busy}>保存新基线并重检</button></div></form></Modal>;
}

export function DifficultyEditor({ draft, slotIds, onApply, onClose, busy }) {
  const [target, setTarget] = useState(draft.baseline.requirements.targetDifficulty);
  const [mode, setMode] = useState('automatic');
  const slots = draft.slots.filter(slot => slotIds.includes(slot.slotId));
  return <Modal title="修改指定题位的难度目标" onClose={onClose} busy={busy}><form onSubmit={event => { event.preventDefault(); onApply({ type: 'difficulty', slotIds, targetDifficulty: target, mode }); }}><p>作用范围：第 {slots.map(slot => slot.number).join('、')} 题。</p><label className="field">目标难度<input type="number" min="0" max="1" step="0.01" value={target} required onChange={event => setTarget(Number(event.target.value))}/></label><label className="field">修改方式<select value={mode} onChange={event => setMode(event.target.value)}><option value="automatic">批量调整，跳过锁定题</option><option value="direct">直接修改所选题，包括锁定题</option></select></label><p className="help">现有题目没有可靠难度估计。保存的是选题目标；无法证实更符合新难度时保留现题，实际难度仍未知。</p><div className="action-row"><button className="primary" disabled={busy || !Number.isFinite(target) || target < 0 || target > 1}>应用到这些题位</button></div></form></Modal>;
}

export function Candidates({ slot, data, loading, error, onApply, onClose, busy }) {
  const [acknowledged, setAcknowledged] = useState({});
  const [replacementReason, setReplacementReason] = useState('');
  const candidates = data?.candidates || [];
  const suggestions = data?.suggestions || [];
  const pending = data?.pending || [];
  function item(candidate, index, allowDifference = false) {
    const ready = candidate.question?.student;
    const selectable = candidate.canSelect === true && ready && candidate.questionId !== slot.question?.questionId;
    return <li key={`${candidate.questionId}-${index}`}><div className="candidate-title"><strong>{candidate.questionId}</strong><span>{statusLabels[candidate.status] || candidate.status}</span></div>{ready ? <div className="candidate-stem"><MathText text={ready.stem}/>{ready.options?.map(option => <p key={option.label}>{option.label}. <MathText text={option.text}/></p>)}{ready.parts?.map((part, partIndex) => <p key={part.partId}>（{partIndex + 1}）<MathText text={part.prompt}/></p>)}</div> : null}{candidate.reasons?.map((reason, i) => <p className="help" key={i}>{typeof reason === 'string' ? reason : reason.message || JSON.stringify(reason)}</p>)}{candidate.notes?.map((note, i) => <p className="help" key={i}><MathText text={note}/></p>)}{allowDifference && selectable ? <label className="check-item difference-ack"><input type="checkbox" checked={!!acknowledged[candidate.questionId]} onChange={event => setAcknowledged(current => ({ ...current, [candidate.questionId]: event.target.checked }))}/><span>我了解以上差异或未知，仍选择此题；不会记作已证实符合。</span></label> : null}{selectable ? <button disabled={busy || (allowDifference && !acknowledged[candidate.questionId])} onClick={() => onApply({ type: 'replace', slotIds: [slot.slotId], mode: 'direct', candidateId: candidate.questionId, ...(allowDifference ? { allowDifference: true } : {}), ...(replacementReason.trim() ? { reason: replacementReason.trim() } : {}) })}>用此题替换第 {slot.number} 题</button> : null}</li>;
  }
  return <Modal title={`第 ${slot.number} 题的候选与差异`} onClose={onClose} busy={busy}><p className="help">{slot.taskLabel}。换题保留当前 {slot.points} 分；直接选择可修改锁定题。</p><label className="field">换题原因（可选）<input value={replacementReason} maxLength={1000} disabled={busy} onChange={event => setReplacementReason(event.target.value)} placeholder="例如：希望减少同类计算，增加概念辨析"/></label>{loading ? <p role="status">正在读取真实候选…</p> : error ? <p className="error-text" role="alert">{error}</p> : <><h3>符合条件的直接候选（{candidates.length}）</h3>{candidates.length ? <ul className="candidate-list">{candidates.map((candidate, index) => item(candidate, index))}</ul> : <p className="help">没有其他合格直接候选，现题保留。</p>}<details open={suggestions.length > 0}><summary>差异与未知建议（{suggestions.length}）</summary><p className="help">只有题面就绪、未被其他题位占用的题才可手动选择；先核查具体差异。</p><ul className="candidate-list">{suggestions.map((candidate, index) => item(candidate, index, true))}</ul></details><details><summary>待整理来源单元（{pending.length}）</summary><ul className="pending-list">{pending.map((candidate, index) => <li key={`${candidate.questionId}-${index}`}><code>{candidate.questionId}</code> · {(candidate.reasons || []).map(reason => typeof reason === 'string' ? reason : reason.message).join('；') || '尚未完成结构化与核查，不能选入。'}</li>)}</ul></details>{data?.failures?.length ? <div className="notice warning">读取失败与无候选分别记录：<ul>{data.failures.map((failure, i) => <li key={i}>{failure.questionId} · {failure.message || failure.error?.message || '读取失败'}</li>)}</ul></div> : null}</>}</Modal>;
}

const outcomeLabels = { replaced: '已换题', unchanged: '保留现题', skipped_locked: '已跳过锁定题', deleted: '已删除', added: '已添加', updated: '已更新', unknown: '证据不足', read_failed: '读取失败', failed: '未完成' };
export function OperationResult({ result }) {
  if (!result) return null;
  return <div className="notice operation-result" role="status"><strong>{result.replayed ? '已恢复同一操作的结果' : '操作结果已保存'}</strong>{result.entries?.length ? <ul>{result.entries.map((entry, index) => <li key={index}>{outcomeLabels[entry.status] || entry.status}：{entry.message || entry.reasons?.join('；') || entry.slotId}{entry.toQuestionId ? `（${entry.toQuestionId}）` : ''}</li>)}</ul> : <p>{result.message || '草稿已更新。'}</p>}</div>;
}

export function useDraftOperations(draft, onChange) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const [result, setResult] = useState(null);
  const request = useRef(null);
  const current = useRef(draft);
  current.current = draft;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function send(payload) {
    if (request.current?.inFlight) return false;
    const context = { payload, draftId: current.current.draftId, inFlight: true };
    request.current = context; setBusy(true); setFailure(null);
    try {
      const response = await api(`/api/drafts/${encodeURIComponent(context.draftId)}/operations`, payload);
      if (!mounted.current || request.current !== context || current.current.draftId !== context.draftId) return false;
      if ((response.draft.revision ?? 0) >= (current.current.revision ?? 0)) { onChange(response.draft); setResult(response.result); }
      request.current = null;
      return true;
    } catch (error) {
      if (mounted.current && request.current === context) { context.inFlight = false; setFailure({ message: error.message, code: error.code, status: error.status, retry: !error.status || error.status >= 500 }); }
      return false;
    } finally { if (mounted.current && (!request.current || request.current === context)) setBusy(false); }
  }
  const apply = operation => send({ operationId: crypto.randomUUID(), expectedRevision: current.current.revision ?? 0, ...operation });
  const retry = () => request.current ? send(request.current.payload) : Promise.resolve(false);
  async function reload() {
    if (busy) return;
    request.current = null; setBusy(true);
    try { const response = await api(`/api/drafts/${encodeURIComponent(current.current.draftId)}`); if (mounted.current) { onChange(response.draft); setFailure(null); setResult(null); } }
    catch (error) { if (mounted.current) setFailure({ message: error.message, retry: false }); }
    finally { if (mounted.current) setBusy(false); }
  }
  return { busy, failure, result, apply, retry, reload };
}
