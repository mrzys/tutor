import React, { useEffect, useRef, useState } from 'react';
import { MathText } from './MathText.jsx';
import { api, sourceLabel, statusLabels, typeLabels, typeTitles } from './api.js';
import { AddEditor, BaselineEditor, Candidates, DifficultyEditor, DraftOperationContext, Modal, OperationResult, PointsEditor, useDraftOperations } from './DraftEditor.jsx';

function Evidence({ slot, config }) {
  const reason = slot.selection?.selectedReason;
  const applicability = slot.applicability;
  const path = applicability ? applicability.allowedSolutionPath : reason?.allowedSolutionPath;
  const status = applicability?.status || (slot.status === 'selected' ? 'eligible' : slot.status === 'search_failed' ? 'read_failed' : 'empty');
  return <details className="evidence"><summary><strong>选题依据</strong><span>{slot.taskLabel} · {statusLabels[status] || '题位留空'}</span></summary><div className="evidence-body">
    {reason ? <><p>原选入记录：{reason.text}</p>{path ? <p>当前已证实的完整允许解法依赖：章节 {path.requiredSections?.join('、') || '无新增章节'}；显式前提 {path.requiredPremises?.map(id => config.premises.find(item => item.id === id)?.label || id).join('、') || '无新增前提'}。</p> : null}{reason.notes?.map((text, index) => <p key={index}><MathText text={text}/></p>)}</> : (slot.selection?.reasons || []).map(text => <p key={text}>{text}</p>)}
    {applicability?.reasons?.map((text, index) => <p className={status === 'eligible' ? '' : 'warning-text'} key={index}>{text}</p>)}
    {slot.question ? <><p>题目身份：<code>{slot.question.questionId}</code><br/>题面版本：<code>{slot.question.contentVersion}</code><br/>教师资料版本：<code>{slot.question.teacherVersion}</code></p><ul>{slot.question.sourceRefs.map((ref, index) => <li key={index}>{sourceLabel(ref.sourceId, config)} · 物理页 {ref.pages.join('、')} · {ref.locator}</li>)}</ul></> : null}
    {slot.scoringStatus ? <p className="warning-text">{slot.scoringStatus.message}</p> : null}
    <p>题位目标难度：{Number.isFinite(slot.targetDifficulty) ? slot.targetDifficulty.toFixed(2) : '沿用基线目标'}；实际题目难度未知。</p>
    <details className="candidate-details"><summary>此前检索候选（{slot.selection?.candidates?.length || 0} 题）</summary><ul>{(slot.selection?.candidates || []).map(candidate => <li key={candidate.questionId}><code>{candidate.questionId}</code> · {statusLabels[candidate.status] || candidate.status}{candidate.reasons?.length ? `：${candidate.reasons.join('；')}` : ''}{candidate.notes?.map((note, index) => <small key={index}><MathText text={note}/></small>)}</li>)}</ul><p className="help">最新候选请使用本题的「查看候选 / 换题」。</p></details>
  </div></details>;
}

export function DraftRail({ draft, onNew }) {
  return <><h2>本次草稿</h2><div className="stats-pair"><div><span>实际可用</span><strong>{draft.stats.selectedQuestions} <small>题</small></strong></div><div><span>有效分值</span><strong>{draft.stats.availablePoints} <small>分</small></strong></div></div><div className="rail-status"><span>{draft.stats.missingQuestions ? `缺 ${draft.stats.missingQuestions} 题` : '题面完整'}</span><span>难度估计未知</span></div><p className="help revision-note">已保存 · 修订 {draft.revision ?? 0} · {draft.slots.filter(slot => slot.locked).length} 题锁定</p><div className="rail-separator"/><h2>题目目录</h2><nav className="question-directory" aria-label="题目目录">{draft.slots.map(slot => <a key={slot.slotId} href={`#question-${slot.number}`}><span>{slot.number}</span><span>{typeLabels[slot.questionType]}{slot.status !== 'selected' ? ' · 缺题' : slot.locked ? ' · 锁定' : ''}</span><span>{slot.points} 分</span></a>)}</nav><div className="rail-actions"><a href="#selection-summary">查看操作与依据</a><button className="link-button" onClick={onNew}>新建组卷</button></div></>;
}

function Question({ slot, config, checked, onSelect, onCandidates, onPoints, onDelete, onLock, busy }) {
  const warning = slot.applicability && slot.applicability.status !== 'eligible';
  return <article className="question editable-question" id={`question-${slot.number}`}><div className="question-controls"><label className="check-item"><input type="checkbox" checked={checked} onChange={event => onSelect(event.target.checked)} aria-label={`选择第 ${slot.number} 题`}/><span>选择第 {slot.number} 题</span></label><button className="link-button lock-control" onClick={onLock} disabled={busy} aria-pressed={!!slot.locked} aria-label={`${slot.locked ? '解锁' : '锁定'}第 ${slot.number} 题`}>{slot.locked ? '已锁定 · 解锁' : '锁定'}</button><button className="link-button" onClick={onCandidates} disabled={busy}>查看候选 / 换题</button><button className="link-button" onClick={onPoints} disabled={busy}>改分</button><button className="link-button delete-control" onClick={onDelete} disabled={busy}>删除</button></div>{warning ? <p className="applicability-warning">当前基线：{statusLabels[slot.applicability.status] || slot.applicability.status}。{slot.applicability.reasons?.join('；')}</p> : null}<div className="question-top"><strong className="question-number">{slot.number}.</strong><div className="question-stem">{slot.question ? <MathText text={slot.question.student.stem}/> : <span className="missing-stem">【第 {slot.number} 题缺题面 · {slot.status === 'search_failed' ? '读取失败，尚不能判断无题' : '暂无符合条件的候选'}】</span>}</div><span className="question-points">（{slot.points} 分）</span></div>{slot.question ? <div className="question-content">{slot.question.student.options.length ? <div className="options">{slot.question.student.options.map(option => <div className="option" key={option.label}><span>{option.label}.</span><MathText text={option.text}/></div>)}</div> : null}{slot.question.student.parts.map((part, partIndex) => <p className="question-part" key={part.partId}>（{partIndex + 1}）<MathText text={part.prompt}/><span className="part-points">（{slot.partPoints.find(item => item.partId === part.partId)?.points ?? '—'} 分）</span></p>)}</div> : null}<Evidence slot={slot} config={config}/></article>;
}

export function Draft({ draft, config, onChange, onConfirm }) {
  config = { ...config, ...draft.baseline.taskCatalogSnapshot };
  const [selected, setSelected] = useState([]);
  const [editor, setEditor] = useState(null);
  const [candidateState, setCandidateState] = useState({ loading: false, data: null, error: '' });
  const candidateRequest = useRef(0);
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const operations = useDraftOperations(draft, onChange);
  useEffect(() => { candidateRequest.current++; setCandidateState({ loading: false, data: null, error: '' }); setEditor(null); setSelected(ids => ids.filter(id => draft.slots.some(slot => slot.slotId === id))); }, [draft.revision]);
  useEffect(() => () => { candidateRequest.current++; }, []);
  const selectedIds = selected.filter(id => draft.slots.some(slot => slot.slotId === id));
  const groups = [];
  for (const slot of draft.slots) {
    const last = groups.at(-1);
    if (last?.type === slot.questionType) last.slots.push(slot);
    else groups.push({ type: slot.questionType, title: typeTitles[slot.questionType], slots: [slot] });
  }
  function close() { if (operations.busy) return; candidateRequest.current++; setEditor(null); }
  async function apply(operation) { candidateRequest.current++; const success = await operations.apply(operation); if (success) setEditor(null); }
  async function candidates(slot) {
    const token = ++candidateRequest.current;
    const revision = draft.revision ?? 0;
    setEditor({ type: 'candidates', slot }); setCandidateState({ loading: true, data: null, error: '' });
    try {
      const response = await api(`/api/drafts/${encodeURIComponent(draft.draftId)}/candidates`, { slotId: slot.slotId, expectedRevision: revision });
      if (candidateRequest.current === token && (latestDraft.current.revision ?? 0) === revision) setCandidateState({ loading: false, data: response, error: '' });
    } catch (error) { if (candidateRequest.current === token) setCandidateState({ loading: false, data: null, error: `${error.message}${error.status === 409 ? ' 请关闭候选并重新读取草稿。' : ''}` }); }
  }
  const currentSlot = editor?.slot ? draft.slots.find(slot => slot.slotId === editor.slot.slotId) : null;
  return <DraftOperationContext.Provider value={operations}><div className="paper">
    <div className="draft-toolbar"><div className="toolbar-intro"><h2>调整当前草稿</h2><span>每次操作保存；锁定题跳过自动换题。</span></div><div className="toolbar-actions"><button disabled={operations.busy} onClick={() => setEditor({ type: 'add' })}>添加题位</button><button disabled={operations.busy} onClick={() => setEditor({ type: 'baseline' })}>更正基线</button><button className="primary" disabled={operations.busy} onClick={onConfirm}>确认成卷与输出</button></div><div className="batch-toolbar"><label className="check-item"><input type="checkbox" checked={draft.slots.length > 0 && selectedIds.length === draft.slots.length} onChange={event => setSelected(event.target.checked ? draft.slots.map(slot => slot.slotId) : [])}/><span>全选</span></label><span className="help">已选 {selectedIds.length} 题</span><button disabled={operations.busy || !selectedIds.length} onClick={() => apply({ type: 'replace', slotIds: selectedIds, mode: 'automatic' })}>批量自动换题</button><button disabled={operations.busy || !selectedIds.length} onClick={() => setEditor({ type: 'difficulty' })}>修改所选难度目标</button><button className="link-button" disabled={operations.busy} onClick={operations.reload}>重新读取草稿</button></div></div>
    {operations.failure ? <div className="notice error" role="alert"><span>{operations.failure.message}{operations.failure.code === 'finalized_draft' ? ' 请读取成卷，再派生新草稿进行调整。' : operations.failure.status === 409 ? ' 草稿已变化，请读取最新草稿后重新操作。' : ''}</span>{operations.failure.retry ? <button disabled={operations.busy} onClick={operations.retry}>重试同一操作</button> : null}<button disabled={operations.busy} onClick={operations.reload}>{operations.failure.code === 'finalized_draft' ? '读取已确认成卷' : '读取最新草稿'}</button></div> : null}
    <OperationResult result={operations.result}/>
    {operations.busy ? <p className="help" role="status">正在处理并保存草稿…</p> : null}
    {draft.stats.missingQuestions ? <div className="notice warning" role="status">未完整卷：实际可用 {draft.stats.selectedQuestions} 题，有效分值 {draft.stats.availablePoints} 分。缺题保留原题号及明确占位。</div> : null}
    {groups.map((group, index) => <section className="paper-section" key={`${group.type}-${index}`}><h2>{index + 1}、{group.title}</h2><p className="group-subtitle">当前 {group.slots.length} 题 / {group.slots.reduce((sum, slot) => sum + slot.points, 0)} 分；实际可用 {group.slots.filter(slot => slot.status === 'selected').length} 题 / {group.slots.filter(slot => slot.status === 'selected').reduce((sum, slot) => sum + slot.points, 0)} 分</p>{group.slots.map(slot => <Question key={slot.slotId} slot={slot} config={config} busy={operations.busy} checked={selectedIds.includes(slot.slotId)} onSelect={checked => setSelected(ids => checked ? [...new Set([...ids, slot.slotId])] : ids.filter(id => id !== slot.slotId))} onCandidates={() => candidates(slot)} onPoints={() => setEditor({ type: 'points', slot })} onDelete={() => setEditor({ type: 'delete', slot })} onLock={() => apply({ type: 'lock', slotId: slot.slotId, locked: !slot.locked })}/>)}</section>)}
    {!draft.slots.length ? <p className="empty-message">当前草稿没有题位，可添加题位继续组卷。</p> : null}
    <section id="selection-summary" className="selection-summary"><h2>计划差异与操作记录</h2><p>原计划 {draft.baseline.slots?.length ?? '—'} 题；当前 {draft.slots.length} 个题位、实际可用 {draft.stats.selectedQuestions} 题 / {draft.stats.availablePoints} 分。</p><ul>{draft.differences.map((difference, index) => <li key={index}>{difference.message}</li>)}</ul><p>来源单元 {draft.retrieval.sourceUnits ?? 50} 个，{draft.retrieval.pendingCount} 个待整理；{draft.retrieval.failures.length} 个读取失败。</p><details><summary>查看当前基线及更正历史（{draft.baselineHistory?.length || 0} 次更正）</summary><p>主考章节：{draft.baseline.requirements.mainScope.join('、') || '未选择'}<br/>已学章节：{draft.baseline.requirements.learnedScope.join('、') || '未选择'}<br/>允许前提：{draft.baseline.requirements.premises.map(id => config.premises.find(item => item.id === id)?.label || id).join('、') || '无'}<br/>来源：{draft.baseline.requirements.sourceIds.map(id => sourceLabel(id, config)).join('、') || '未选择'}<br/>基线目标难度：{draft.baseline.requirements.targetDifficulty.toFixed(2)}<br/>教学目的：{draft.baseline.requirements.goal}</p>{draft.baselineHistory?.map((baseline, index) => { const old = baseline.requirements || baseline.baseline?.requirements; return <p key={index}>历史基线 {index + 1}：{old ? `已学 ${old.learnedScope.join('、') || '无'}；前提 ${old.premises.join('、') || '无'}；来源 ${old.sourceIds.join('、') || '无'}` : '已保留更正记录'}</p>; })}</details><details><summary>操作记录（{draft.operations?.length || 0}）</summary>{draft.operations?.length ? <ol className="operation-history">{draft.operations.map((operation, index) => <li key={operation.operationId || index}><strong>修订 {operation.revision} · {new Date(operation.appliedAt).toLocaleString('zh-CN')}</strong><ul>{operation.result?.entries?.map((entry, entryIndex) => <li key={entryIndex}>{outcomeLabels(entry.status)}：{entry.message}{entry.toQuestionId ? `（${entry.toQuestionId}）` : ''}</li>)}</ul></li>)}</ol> : <p>暂无局部调整，当前为首次选题结果。</p>}</details></section>
    {editor?.type === 'points' && currentSlot ? <PointsEditor slot={currentSlot} config={config} busy={operations.busy} onClose={close} onApply={apply}/> : null}
    {editor?.type === 'candidates' && currentSlot ? <Candidates slot={currentSlot} {...candidateState} busy={operations.busy} onClose={close} onApply={apply}/> : null}
    {editor?.type === 'add' ? <AddEditor draft={draft} config={config} busy={operations.busy} onClose={close} onApply={apply}/> : null}
    {editor?.type === 'baseline' ? <BaselineEditor draft={draft} config={config} busy={operations.busy} onClose={close} onApply={apply}/> : null}
    {editor?.type === 'difficulty' ? <DifficultyEditor draft={draft} slotIds={selectedIds} busy={operations.busy} onClose={close} onApply={apply}/> : null}
    {editor?.type === 'delete' && currentSlot ? <Modal title={`删除第 ${currentSlot.number} 题位`} onClose={close} busy={operations.busy}><p>删除该题位后重新编号与计分，其他题目和锁定保留。</p><div className="action-row"><button className="primary" disabled={operations.busy} onClick={() => apply({ type: 'delete', slotId: currentSlot.slotId })}>删除此题位</button><button disabled={operations.busy} onClick={close}>保留</button></div></Modal> : null}
  </div></DraftOperationContext.Provider>;
}

function outcomeLabels(status) { return { replaced: '已换题', unchanged: '保留现题', skipped_locked: '跳过锁定题', deleted: '已删除', added: '已添加', updated: '已更新', unknown: '证据不足', read_failed: '读取失败' }[status] || status; }
