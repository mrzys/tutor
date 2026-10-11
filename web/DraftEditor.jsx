import { Select } from './Select.jsx';
import React, { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { allocateParts, api, sourceLabel, statusLabels, typeLabels } from './api.js';
import { MathText } from './MathText.jsx';

export const DraftOperationContext = createContext(null);

export function Modal({ title, onClose, children, busy, className = '' }) {
  const dialog = useRef(null);
  const titleId = useId();
  const operations = useContext(DraftOperationContext);
  useEffect(() => {
    const element = dialog.current;
    const trigger = document.activeElement;
    element.showModal();
    return () => {
      element.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={dialog} aria-labelledby={titleId} className={`editor-dialog ${className}`} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}><div className="dialog-heading"><h2 id={titleId}>{title}</h2><button aria-label="关闭" disabled={busy} onClick={onClose}>关闭</button></div>{operations?.failure ? <div className="notice error" role="alert"><span>{operations.failure.message}</span>{operations.failure.retry ? <button disabled={busy} onClick={operations.retry}>重试同一操作</button> : null}<button disabled={busy} onClick={operations.reload}>读取最新草稿</button></div> : null}{children}</dialog>;
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
  const scored = draft.baseline.requirements.scoringMode !== 'none';
  const [taskId, setTaskId] = useState(config.tasks[0].id);
  const [value, setValue] = useState({ points: scored ? 8 : 0, partPoints: [] });
  const [afterSlotId, setAfterSlotId] = useState('');
  const task = config.tasks.find(item => item.id === taskId);
  const invalid = !Number.isInteger(value.points) || value.points < 0 || value.points > 1000 || value.partPoints.some(part => !Number.isInteger(part.points) || part.points < 0) || (value.partPoints.length > 0 && value.partPoints.reduce((sum, part) => sum + part.points, 0) !== value.points);
  function changeTask(id) { const next = config.tasks.find(item => item.id === id); const points = !scored ? 0 : next.questionType === 'free_response' ? 14 : next.questionType === 'fill_blank' ? 10 : 8; setTaskId(id); setValue({ points, partPoints: allocateParts(next, points) }); }
  return <Modal title="添加题位" onClose={onClose} busy={busy}><form onSubmit={event => { event.preventDefault(); if (!invalid) onApply({ type: 'add', taskId, ...value, ...(afterSlotId ? { afterSlotId } : {}) }); }}><label className="field">题型与考查任务<Select value={taskId} onChange={event => changeTask(event.target.value)}>{config.tasks.map(item => <option key={item.id} value={item.id}>{typeLabels[item.questionType]} · {item.label}</option>)}</Select></label>{scored ? <PointFields value={value} onChange={setValue}/> : null}{scored && value.partPoints.length ? <button type="button" className="link-button" onClick={() => setValue(current => ({ ...current, partPoints: allocateParts(task, current.points) }))}>按建议比例重新分配小问</button> : null}<label className="field">添加位置<Select value={afterSlotId} onChange={event => setAfterSlotId(event.target.value)}><option value="">末尾</option>{draft.slots.map(slot => <option key={slot.slotId} value={slot.slotId}>第 {slot.number} 题之后</option>)}</Select></label><p className="help">按当前基线检索真实候选；没有合格题时保留空题位，并重新编号{scored ? '与计分' : ''}。</p><div className="action-row"><button className="primary" disabled={busy || invalid}>添加并检索</button></div></form></Modal>;
}

function BaselineChecks({ title, items, value, onChange }) {
  return <fieldset className="field-section"><legend>{title}</legend><div className="check-list">{items.map(item => <label className="check-item" key={item.id}><input type="checkbox" checked={value.includes(item.id)} onChange={event => onChange(event.target.checked ? [...value, item.id] : value.filter(id => id !== item.id))}/><span>{item.label}{item.description ? <small>{item.description}</small> : null}</span></label>)}</div></fieldset>;
}

export function BaselineEditor({ draft, config, onApply, onClose, busy }) {
  const [value, setValue] = useState(() => structuredClone(draft.baseline.requirements));
  const set = (key, next) => setValue(current => ({ ...current, [key]: next }));
  return <Modal title="更正教学条件与来源基线" onClose={onClose} busy={busy}><form onSubmit={event => { event.preventDefault(); onApply({ type: 'baseline', requirements: value }); }}><p className="help">保存新基线并重检现题适用性，保留已有题目、分值与锁定。证据不足的题会提示未知。</p><BaselineChecks title="主考范围" items={config.chapters} value={value.mainScope} onChange={next => set('mainScope', next)}/><BaselineChecks title="已学边界" items={config.chapters} value={value.learnedScope} onChange={next => set('learnedScope', next)}/><details className="foundation"><summary>初中基础依赖 · 自动注入</summary><ul>{(draft.baseline.courseContext?.foundation || config.foundation || []).map(item => <li key={item}>{item}</li>)}</ul></details><BaselineChecks title="已核查来源" items={config.sources.map(item => ({ id: item.sourceId, label: sourceLabel(item.sourceId, config) }))} value={value.sourceIds} onChange={next => set('sourceIds', next)}/><p className="help">这里只提供身份与依据已核查的来源；新增材料需先整理与核查。</p><div className="action-row"><button className="primary" disabled={busy}>保存新基线并重检</button></div></form></Modal>;
}

export function DifficultyEditor({ draft, slotIds, onApply, onClose, busy }) {
  const slots = draft.slots.filter(slot => slotIds.includes(slot.slotId));
  const [target, setTarget] = useState((slots.length === 1 ? slots[0].targetDifficulty : null) ?? draft.baseline.requirements.targetDifficulty ?? '');
  const [mode, setMode] = useState(slots.length === 1 ? 'direct' : 'automatic');
  return <Modal title="修改指定题位的难度目标" onClose={onClose} busy={busy}><form onSubmit={event => { event.preventDefault(); onApply({ type: 'difficulty', slotIds, targetDifficulty: target, mode }); }}><p>作用范围：第 {slots.map(slot => slot.number).join('、')} 题。</p><label className="field">目标难度<input type="number" min="0" max="1" step="0.01" value={target} required onChange={event => setTarget(Number(event.target.value))}/></label><label className="field">修改方式<Select value={mode} onChange={event => setMode(event.target.value)}><option value="automatic">批量调整，跳过锁定题</option><option value="direct">直接修改所选题，包括锁定题</option></Select></label><p className="help">现有题目没有可靠难度估计。保存的是选题目标；无法证实更符合新难度时保留现题，实际难度仍未知。</p><div className="action-row"><button className="primary" disabled={busy || !Number.isFinite(target) || target < 0 || target > 1}>应用到这些题位</button></div></form></Modal>;
}

const abilityChoices = ['概念辨析', '运算求解', '表征转换', '分类讨论', '推理论证'];
const literacyChoices = ['数学抽象', '逻辑推理', '数学建模', '直观想象', '数学运算', '数据分析'];

function GoalTags({ title, choices, value, onChange }) {
  const tags = [...new Set(value.split(/[,，]/).map(item => item.trim()).filter(Boolean))];
  return <div className="criteria-tags"><label className="field">{title}<input value={value} maxLength={300} onChange={event => onChange(event.target.value)} placeholder="可选；多个用逗号分隔，也可点击下方选项"/></label><div className="criteria-tag-choices">{choices.map(choice => <button key={choice} type="button" aria-pressed={tags.includes(choice)} onClick={() => onChange((tags.includes(choice) ? tags.filter(item => item !== choice) : [...tags, choice]).join('，'))}>{choice}</button>)}</div></div>;
}

export function CriteriaEditor({ draft, slot, config, onApply, onClose, busy }) {
  const goals = draft.baseline.requirements.teachingGoals ?? [];
  const initialGoal = goals.find(goal => goal.id === `slot-goal-${slot.slotId}`) || goals.find(goal => (slot.goalIds ?? []).includes(goal.id));
  const [taskId, setTaskId] = useState(slot.taskId);
  const [enabled, setEnabled] = useState(Boolean(initialGoal));
  const [goal, setGoal] = useState(() => initialGoal ? structuredClone(initialGoal) : {
    observable: '', knowledgeScope: config.tasks.find(task => task.id === slot.taskId)?.sectionIds ?? [],
    cognition: 'unspecified', conditions: { prompt: 'unspecified', response: 'unspecified' }, priority: 'preferred',
  });
  const [abilities, setAbilities] = useState((initialGoal?.abilities ?? []).join('，'));
  const [literacies, setLiteracies] = useState((initialGoal?.literacies ?? []).join('，'));
  const set = (key, value) => setGoal(current => ({ ...current, [key]: value }));
  const split = value => [...new Set(value.split(/[,，]/).map(item => item.trim()).filter(Boolean))];
  const tasks = config.tasks.filter(task => task.questionType === slot.questionType && (slot.questionType !== 'free_response'
    || (task.partIds?.length === slot.partPoints.length && task.partIds.every(id => slot.partPoints.some(part => part.partId === id)))));
  const invalid = enabled && (!goal.observable.trim() || !goal.knowledgeScope.length || split(abilities).length > 20 || split(literacies).length > 20);
  return <Modal title={`调整第 ${slot.number} 题的考查要求`} onClose={onClose} busy={busy}>
    <form onSubmit={event => {
      event.preventDefault();
      if (!invalid) onApply({ type: 'criteria', slotId: slot.slotId, taskId,
        teachingGoal: enabled ? { ...goal, abilities: split(abilities), literacies: split(literacies) } : null,
        targetDifficulty: slot.targetDifficulty ?? null });
    }}>
      <p className="help">先保存本题要求并重检，再查看候选确认换题。现题、分值及其他题位保留。</p>
      <label className="field">考查任务<Select aria-label="考查任务" value={taskId} onChange={event => setTaskId(event.target.value)}>{tasks.map(task => <option key={task.id} value={task.id}>{task.label}</option>)}</Select></label>
      <label className="check-item criteria-enable"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)}/><span>为本题设置具体教学目标<small>可指定认知、能力与核心素养；这些是教师要求，需要题目证据支持。</small></span></label>
      <fieldset className="criteria-fields" hidden={!enabled} disabled={!enabled || busy}>
        <label className="field">学生要做到什么<textarea value={goal.observable} rows="2" maxLength={1000} required={enabled} onChange={event => set('observable', event.target.value)} placeholder="例如：独立说明对象能否构成集合，并指出判断依据"/></label>
        <BaselineChecks title="知识范围" items={config.chapters} value={goal.knowledgeScope} onChange={value => set('knowledgeScope', value)}/>
        <div className="goal-options">
          <label className="field">认知要求<Select aria-label="认知要求" value={goal.cognition} onChange={event => set('cognition', event.target.value)}><option value="unspecified">暂不指定</option><option value="understand">理解与解释</option><option value="apply">应用与操作</option><option value="reason">推理与论证</option></Select></label>
          <label className="field">要求强度<Select aria-label="要求强度" value={goal.priority} onChange={event => set('priority', event.target.value)}><option value="preferred">尽量满足</option><option value="required">必须满足</option></Select></label>
          <label className="field">提示条件<Select aria-label="提示条件" value={goal.conditions.prompt} onChange={event => set('conditions', { ...goal.conditions, prompt: event.target.value })}><option value="unspecified">暂不指定</option><option value="provided">允许提供提示</option><option value="independent">要求独立完成</option></Select></label>
          <label className="field">作答要求<Select aria-label="作答要求" value={goal.conditions.response} onChange={event => set('conditions', { ...goal.conditions, response: event.target.value })}><option value="unspecified">暂不指定</option><option value="answer">给出答案即可</option><option value="written_reasoning">写出完整推理过程</option></Select></label>
        </div>
        <GoalTags title="能力要求" choices={abilityChoices} value={abilities} onChange={setAbilities}/>
        <GoalTags title="核心素养" choices={literacyChoices} value={literacies} onChange={setLiteracies}/>
      </fieldset>
      <p className="help">四维支持证据尚未接入自动筛选。“必须满足”会使未证实的候选保持未知；“尽量满足”允许保留未知，但不会计作目标已覆盖。</p>
      {(slot.goalIds ?? []).length ? <p className="help">保存后本题将使用这里的专属目标，原共享目标及其他题位不变。取消勾选则解除本题的目标关联。</p> : null}
      {invalid ? <p className="error-text">请填写学生表现并选择知识范围；能力与素养各最多 20 项。</p> : null}
      <div className="action-row"><button className="primary" disabled={busy || invalid}>保存本题要求并重检</button><button type="button" disabled={busy} onClick={onClose}>取消</button></div>
    </form>
  </Modal>;
}

export function Candidates({ slot, scored = true, data, loading, error, onApply, onClose, onCriteria, busy }) {
  const [acknowledged, setAcknowledged] = useState({});
  const [replacementReason, setReplacementReason] = useState('');
  const candidates = (data?.candidates || []).filter(candidate => candidate.canSelect === true && candidate.question?.student && candidate.questionId !== slot.question?.questionId);
  const [showOtherTasks, setShowOtherTasks] = useState(false);
  const suggestions = (data?.suggestions || []).filter(candidate => candidate.canSelect === true && (showOtherTasks || !(candidate.reasons || []).includes('具体考查任务不同')));
  const pending = data?.pending || [];
  function item(candidate, index, allowDifference = false) {
    const ready = candidate.question?.student;
    const selectable = candidate.canSelect === true && ready && candidate.questionId !== slot.question?.questionId;
    return <li key={`${candidate.questionId}-${index}`}><div className="candidate-title"><strong>{candidate.questionId}</strong><span>{statusLabels[candidate.status] || candidate.status}</span></div>{ready ? <div className="candidate-stem"><MathText text={ready.stem}/>{ready.options?.map(option => <p key={option.label}>{option.label}. <MathText text={option.text}/></p>)}{ready.parts?.map((part, partIndex) => <p key={part.partId}>（{partIndex + 1}）<MathText text={part.prompt}/></p>)}</div> : null}{candidate.reasons?.map((reason, i) => <p className="help" key={i}>{typeof reason === 'string' ? reason : reason.message || JSON.stringify(reason)}</p>)}{candidate.notes?.map((note, i) => <p className="help" key={i}><MathText text={note}/></p>)}{allowDifference && selectable ? <label className="check-item difference-ack"><input type="checkbox" checked={!!acknowledged[candidate.questionId]} onChange={event => setAcknowledged(current => ({ ...current, [candidate.questionId]: event.target.checked }))}/><span>我了解以上差异或未知，仍选择此题；不会记作已证实符合。</span></label> : null}{selectable ? <button disabled={busy || (allowDifference && !acknowledged[candidate.questionId])} onClick={() => onApply({ type: 'replace', slotIds: [slot.slotId], mode: 'direct', candidateId: candidate.questionId, ...(allowDifference ? { allowDifference: true } : {}), ...(replacementReason.trim() ? { reason: replacementReason.trim() } : {}) })}>用此题替换第 {slot.number} 题</button> : null}</li>;
  }
  return <Modal title={`第 ${slot.number} 题的候选与差异`} onClose={onClose} busy={busy}><p className="help">{slot.taskLabel}。{scored ? `换题保留当前 ${slot.points} 分；` : '本次练习不计分；'}直接选择可修改锁定题。</p><label className="field">换题原因（可选）<input value={replacementReason} maxLength={1000} disabled={busy} onChange={event => setReplacementReason(event.target.value)} placeholder="例如：希望减少同类计算，增加概念辨析"/></label>{loading ? <p role="status">正在读取真实候选…</p> : error ? <p className="error-text" role="alert">{error}</p> : <><h3>{data?.failures?.length ? '已核实合格备选' : '合格备选'}（{candidates.length} 道）</h3><p className="help">已排除现题及本卷重复题组；差异建议单独列出，不计入合格备选。</p>{candidates.length ? <ul className="candidate-list">{candidates.map((candidate, index) => item(candidate, index))}</ul> : <p className="help">{data?.failures?.length ? '候选读取不完整，尚不能确认是否还有合格备选。可核对下方失败信息，或重新读取草稿。' : slot.question ? '本次检索未找到其他合格备选，现题保留。' : '该题位暂无合格候选，保持留空。可核对考查要求或允许使用的知识与方法。'}</p>}{!candidates.length && onCriteria ? <div className="action-row"><button disabled={busy} onClick={onCriteria}>调整本题要求</button><span className="help">也可继续查看下方差异建议；调整不会自动换题。</span></div> : null}<label className="check-item candidate-scope-toggle"><input type="checkbox" checked={showOtherTasks} onChange={event => setShowOtherTasks(event.target.checked)}/><span>同时查看其他考查任务的差异建议</span></label><details open={suggestions.length > 0}><summary>{showOtherTasks ? '全部' : '同任务'}差异与未知建议（{suggestions.length}）</summary><p className="help">只有题面就绪、未被其他题位占用的题才可手动选择；先核查具体差异。</p><ul className="candidate-list">{suggestions.map((candidate, index) => item(candidate, index, true))}</ul></details><details><summary>待整理来源单元（{pending.length}）</summary><ul className="pending-list">{pending.map((candidate, index) => <li key={`${candidate.questionId}-${index}`}><code>{candidate.questionId}</code> · {(candidate.reasons || []).map(reason => typeof reason === 'string' ? reason : reason.message).join('；') || '尚未完成结构化与核查，不能选入。'}</li>)}</ul></details>{data?.failures?.length ? <div className="notice warning">读取失败与无候选分别记录：<ul>{data.failures.map((failure, i) => <li key={i}>{failure.questionId} · {failure.message || failure.error?.message || '读取失败'}</li>)}</ul></div> : null}</>}</Modal>;
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
