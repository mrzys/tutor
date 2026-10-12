import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUp, Check, LoaderCircle, Sparkles, Square, X } from 'lucide-react';
import { api, typeLabels } from './api.js';
import { ScopeTree } from './ScopeTree.jsx';
import { Select } from './Select.jsx';
import './Composer.css';
import { availableScopeSelection } from '../src/curriculum/availability.mjs';

const storageKey = 'tutor-intake-session';
const purposeOptions = [
  { id: 'consolidation', label: '课后巩固', description: '围绕所学内容练习，巩固概念和常规方法。' },
  { id: 'diagnostic', label: '学情诊断', description: '了解学生的掌握情况，关注易错点和薄弱环节。' },
  { id: 'assessment', label: '单元测验', description: '围绕单元内容，检查知识理解与综合运用。' },
  { id: 'mock_exam', label: '模拟考试', description: '按考试要求安排练习，可补充题型、分值和时长。' }
];
const countFields = [['singleChoiceCount', '单选'], ['fillBlankCount', '填空'], ['freeResponseCount', '解答']];
const cognitionLabels = { understand: '理解概念', apply: '常规运用', reason: '推理与论证' };
function remember(id) { try { localStorage.setItem(storageKey, id); } catch { /* Server persistence remains available. */ } }
function remembered() { try { return localStorage.getItem(storageKey); } catch { return null; } }
function changesOnly(next, previous) { return Object.fromEntries(Object.entries(next).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(previous[key]))); }
function toggle(ids, id) { return ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id]; }

function ChoicePills({ label, options, value, onChange, multiple = false, disabled }) {
  return <fieldset className="quick-choices" disabled={disabled}><legend>{label}</legend><div>{options.map(option => {
    const selected = multiple ? (value || []).includes(option.id) : value === option.id;
    return <button type="button" key={option.id} aria-pressed={selected} onClick={() => onChange(multiple ? toggle(value || [], option.id) : option.id)}>
      {selected ? <Check size={14} aria-hidden="true"/> : null}{option.label}
    </button>;
  })}</div></fieldset>;
}

function Clarification({ block, value, onChange, disabled }) {
  // Only genuine missing input belongs in the quick flow. Internal goal knobs stay in the summary.
  if (!['purpose', 'mainScope', 'title', 'observable'].includes(block.field)) return null;
  if (['single_choice', 'multi_choice'].includes(block.kind)) return <ChoicePills label={block.title} options={block.options || []}
    value={value ?? block.value} onChange={onChange} multiple={block.kind === 'multi_choice'} disabled={disabled}/>;
  if (block.kind === 'text') return <label className="quick-clarification">{block.title}<input value={value ?? block.value ?? ''} maxLength={block.field === 'title' ? 120 : 1000} disabled={disabled} onChange={event => onChange(event.target.value)}/></label>;
  return null;
}

export function QuickIntake({ config, onRequirements, onConfirm, onAdvanced, onBusyChange, onSession, onReviseWorkflow, workflowContent, hideEmptyConversation = false, workflowStage = 'requirements', workflowRequirements, workflowSummary, onWorkflowMessage, selectionContext = [], onClearSelectionContext, editSession = null, resetKey = 0, disabled = false }) {
  const [session, setSession] = useState(null);
  const [answers, setAnswers] = useState({});
  const [message, setMessage] = useState('');
  const [proposalEdits, setProposalEdits] = useState({});
  const [busy, setBusy] = useState('loading');
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [retryKey, setRetryKey] = useState(0);
  const [exceptionsOpen, setExceptionsOpen] = useState(['boundary', 'size'].includes(editSession?.stage));
  const [scopeOpen, setScopeOpen] = useState(editSession?.stage === 'scope');
  const [turns, setTurns] = useState([]);
  const [started, setStarted] = useState(false);
  const [lockedFields, setLockedFields] = useState([]);
  const sessionRef = useRef(null);
  const inFlight = useRef(false);
  const controller = useRef(null);
  const initialEdit = useRef(editSession);
  const callbacks = useRef({ onRequirements, onConfirm, onSession }); callbacks.current = { onRequirements, onConfirm, onSession };
  useEffect(() => {
    if (!started) return;
    requestAnimationFrame(() => document.querySelector(workflowStage !== 'requirements' ? '.chat-workflow-turn' : busy === 'prepare' ? '.chat-working' : '#quick-suggestion')?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }, [started, workflowStage, session?.proposal, busy === 'prepare']);
  useEffect(() => { onBusyChange?.(Boolean(busy)); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  function adopt(next, preserveLocal = false) {
    sessionRef.current = next; setSession(next); remember(next.sessionId);
    if (!preserveLocal) {
      const nextAnswers = next.answers || {};
      setAnswers({ ...nextAnswers, mainScope: availableScopeSelection(config.chapters, nextAnswers.mainScope) });
      setLockedFields(next.lockedFields || []); setProposalEdits({});
    }
    callbacks.current.onSession?.(next);
    if (next.requirements) callbacks.current.onRequirements(next.requirements);
  }
  useEffect(() => {
    setBusy('loading'); setError('');
    if (['blueprint', 'draft', 'paper'].includes(workflowStage)) {
      setAnswers({ mainScope: workflowRequirements?.mainScope || [], purpose: 'consolidation', scoringMode: workflowRequirements?.scoringMode || 'points' });
      setStarted(true); setBusy(''); return;
    }
    const activeController = new AbortController(); controller.current = activeController;
    let active = true;
    (async () => {
      let result;
      const edit = initialEdit.current;
      const id = edit?.sessionId || remembered();
      if (id) {
        try { result = await api(`/api/intake/${encodeURIComponent(id)}`, undefined, activeController.signal); }
        catch (failure) { if (failure.status !== 404) throw failure; }
      }
      if (!result || result.session.mode !== 'quick') {
        result = await api('/api/intake', { action: 'start', flow: 'quick', operationId: crypto.randomUUID(),
          ...(result ? { answers: { ...result.session.answers, learnedScopeMode: 'custom' } } : {}) }, activeController.signal);
      } else if (result.session.status === 'confirmed') {
        result = await api('/api/intake', { action: 'revise', sessionId: result.session.sessionId, revision: result.session.revision,
          stage: edit?.stage || 'review', operationId: edit?.operationId || crypto.randomUUID() }, activeController.signal);
      }
      if (active) {
        adopt(result.session);
        const original = result.session.teacherRequest || result.session.assistantMessage;
        if (original || result.session.proposal) {
          setStarted(true);
          setTurns([{ role: 'teacher', text: original || '请按选择的范围与用途安排练习。', scope: result.session.answers.mainScope, purpose: result.session.answers.purpose }]);
        }
        if (edit?.stage) requestAnimationFrame(() => {
          const target = document.getElementById(edit.stage === 'goal' ? 'quick-goal' : edit.stage === 'size' ? 'quick-count' : edit.stage === 'boundary' ? 'quick-exceptions' : 'quick-scope');
          target?.scrollIntoView({ block: 'nearest' });
          if (edit.stage === 'goal') target?.focus();
        });
      }
    })().catch(failure => { if (active && failure.name !== 'AbortError') setError(failure.message); }).finally(() => { if (active) setBusy(''); });
    return () => { active = false; activeController.abort(); controller.current?.abort(); };
  }, [resetKey, retryKey]);
  useEffect(() => {
    if (busy !== 'prepare') { setElapsed(0); return; }
    const started = Date.now(); const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  const locked = Boolean(busy || disabled || (!session && !['blueprint', 'draft', 'paper'].includes(workflowStage)));
  const configured = Boolean(config.intake?.configured);
  const localChanges = changesOnly(answers, session?.answers || {});
  const dirty = Object.keys(localChanges).length > 0 || Boolean(message.trim());
  const proposal = session?.proposal;
  const proposed = { ...(proposal?.changes || {}), ...proposalEdits };
  const requirement = workflowRequirements || session?.requirements || config.defaultRequirements;
  const count = answers.questionCount ?? countFields.reduce((sum, [field]) => sum + Number(answers[field] || 0), 0);
  const chapterNames = ids => config.chapters.filter(item => (ids || []).includes(item.id)).map(item => item.label).join('、');
  const proposedGoal = proposed.observable || requirement.teachingGoals?.[0]?.observable;
  const existingGoal = Boolean(session?.answers.observable?.trim());
  function change(field, value) {
    setAnswers(current => ({ ...current, [field]: value,
      ...(field === 'purpose' ? { scoringMode: ['assessment', 'mock_exam'].includes(value) ? 'points' : 'none', targetScore: ['assessment', 'mock_exam'].includes(value) ? current.targetScore || 100 : 0 } : {}),
      ...(field === 'scoringMode' ? { targetScore: value === 'points' ? current.targetScore || 100 : 0 } : {}) }));
    if (['questionCount', 'targetScore', 'durationMinutes', 'scoringMode'].includes(field)) setLockedFields(current => [...new Set([...current, field])]);
  }
  async function request(action, payload = {}) {
    const current = sessionRef.current;
    const result = await api('/api/intake', { action, sessionId: current.sessionId, revision: current.revision,
      operationId: crypto.randomUUID(), ...payload }, controller.current.signal);
    adopt(result.session); return result.session;
  }
  async function act(action) {
    if (inFlight.current || disabled) return;
    if (action === 'prepare' && onWorkflowMessage && ['blueprint', 'draft', 'paper'].includes(workflowStage)) {
      const typed = message.trim();
      if (!typed) { setError('请写下希望调整的内容，例如：第 2 题换一题。'); return; }
      setError(''); setMessage(''); setStarted(true);
      const targetNumbers = selectionContext.map(slot => slot.number);
      const instruction = targetNumbers.length ? `针对当前第 ${targetNumbers.join('、')} ${workflowStage === 'blueprint' ? '题位' : '题'}：${typed}` : typed;
      setTurns(current => [...current, ...(workflowSummary ? [{ role: 'assistant', text: workflowSummary }] : []), { role: 'teacher', text: instruction }]);
      inFlight.current = true;
      try { await onWorkflowMessage(instruction); } catch (failure) { setMessage(typed); setError(failure.message); }
      finally { inFlight.current = false; }
      return;
    }
    if (!sessionRef.current) return;
    inFlight.current = true; controller.current = new AbortController(); setBusy(action); setError('');
    let submittedInput = null;
    try {
      if (sessionRef.current.status === 'confirmed') await request('revise', { stage: 'review' });
      const patch = changesOnly(answers, sessionRef.current.answers);
      if (action === 'prepare') {
        const typed = message.trim();
        const earlier = sessionRef.current.teacherRequest || '';
        const text = typed && earlier ? `${earlier}\n补充需求：${typed}` : typed || earlier;
        if (text.length > 2000) throw new Error('累计需求超过 2000 字，请精简后发送。');
        onReviseWorkflow?.();
        setStarted(true); setScopeOpen(false); setExceptionsOpen(false);
        setTurns(current => [...current, ...(proposal || workflowStage !== 'requirements' ? [{ role: 'assistant', text: proposedGoal || proposal?.summary || requirement.goal }] : []), { role: 'teacher', text: typed || '请按当前范围与用途安排练习。', scope: answers.mainScope, purpose: answers.purpose }]);
        submittedInput = message;
        setMessage('');
        const result = await request('prepare', { answers: patch, message: text, lockedFields });
        if (result.assistantError) { setMessage(submittedInput); setError(`${result.assistantError.message} 点选条件已保存，可重试。`); }
        else requestAnimationFrame(() => document.getElementById('quick-suggestion')?.scrollIntoView({ block: 'nearest' }));
      } else {
        if (action === 'accept') {
          if (dirty || !proposal) throw new Error('条件已修改，请先重新整理建议。');
          await request('answer', { acceptProposal: true, answers: proposalEdits, stage: 'review' });
        } else await request('answer', { answers: patch, stage: 'review', ...(action === 'advanced' ? { message: message.trim() } : {}) });
        if (action === 'advanced') { onAdvanced(); return; }
        const confirmed = await request('confirm');
        await callbacks.current.onConfirm(confirmed.requirements, { countPolicy: confirmed.planning?.countPolicy || 'suggested' });
      }
    } catch (failure) {
      if (submittedInput !== null) setMessage(submittedInput);
      if (failure.name === 'AbortError') setError('已停止整理，输入仍保留，可以重试。');
      else setError(failure.message);
      if (failure.name === 'AbortError' || failure.status === 409) {
        // A cancelled in-flight transaction may briefly expose its previous proposal.
        // Reopen the composer so that suggestion cannot be accepted after stopping.
        try { const latest = await api(`/api/intake/${encodeURIComponent(sessionRef.current.sessionId)}`); adopt(latest.session, true); }
        catch { /* Keep the local input if reconnecting fails. */ }
      }
    } finally { inFlight.current = false; setBusy(''); }
  }
  const inWorkflow = started || workflowStage !== 'requirements';
  const selectedPurpose = purposeOptions.find(item => item.id === answers.purpose) || purposeOptions[0];
  const scored = (proposed.scoringMode || answers.scoringMode || 'points') === 'points';
  const working = busy === 'prepare' || workflowStage === 'planning' || disabled;
  function focusComposer() { document.getElementById('quick-goal')?.focus({ preventScroll: true }); }
  return <section className={`quick-intake composer-intake ${inWorkflow ? 'intake-in-workflow' : 'intake-empty'}`} aria-label="组卷助手对话">
    {!inWorkflow ? <div className="quick-heading"><h1>今天想组一份什么练习？</h1><span>选好范围和用途，其他要求直接告诉组卷助手。</span></div> : null}
    {error ? <p className="notice error" role="alert">{error}{!session ? <button type="button" disabled={Boolean(busy)} onClick={() => setRetryKey(value => value + 1)}>重新连接</button> : null}</p> : null}
    {busy === 'loading' ? <p role="status"><LoaderCircle size={18} className="spinning"/>正在恢复需求…</p> : null}
    {inWorkflow && (!hideEmptyConversation || turns.length > 0 || workflowContent) ? <div className="intake-conversation" aria-label="本次组卷对话">
      {turns.map((turn,index) => turn.role === 'teacher' ? <div className="intake-teacher-turn" key={index}><p>{turn.text}</p>{turn.scope ? <span>{chapterNames(turn.scope)} · {purposeOptions.find(item => item.id === turn.purpose)?.label}</span> : null}</div> : <div className="chat-assistant-history" key={index}><p>{turn.text}</p></div>)}
      {proposal && workflowStage === 'requirements' ? <div className="chat-assistant-turn">
        <section id="quick-suggestion" className="quick-proposal" aria-label="AI 整理的需求建议"><div className="suggestion-heading"><h2>本次考查重点</h2><span>待你确认</span></div><p className="suggestion-objective">{proposedGoal || proposal.summary}</p>
          <div className="quick-proposal-meta"><span>{proposed.questionCount ?? count} 题</span><span>{proposed.durationMinutes ?? answers.durationMinutes} 分钟</span><span>{scored ? `${proposed.targetScore ?? answers.targetScore} 分` : '不计分练习'}</span>{cognitionLabels[proposed.cognition] ? <span>{cognitionLabels[proposed.cognition]}</span> : null}{proposed.priority === 'required' ? <span>必须考查</span> : null}</div>
          {countFields.every(([field]) => Number.isInteger(proposed[field])) || answers.size === 'custom' ? <p className="help">题型安排：{countFields.map(([field, label]) => `${label} ${proposed[field] ?? answers[field] ?? 0} 题`).join(' · ')}</p> : null}
          <div className="suggestion-explanation"><strong>安排说明</strong><p>{proposal.summary}</p></div>
          {(proposal.blocks || []).map(block => <Clarification key={block.id} block={block} value={proposalEdits[block.field]} onChange={value => setProposalEdits(current => ({...current,[block.field]:value}))} disabled={locked}/>)}
          {dirty ? <p className="quick-stale">有新的补充或条件变更，发送后会更新这份建议。</p> : null}
          <div className="quick-actions"><button className="primary" type="button" disabled={locked || dirty} onClick={() => act('accept')}>确认需求，规划蓝图<ArrowRight size={16}/></button><button type="button" className="link-button" disabled={locked} onClick={focusComposer}>补充或修改</button></div>
        </section></div> : null}
      {busy === 'prepare' ? <div className="chat-working" role="status"><LoaderCircle size={19} className="spinning"/><div><strong>正在整理需求</strong><p>结合范围和用途，形成考查重点 · {elapsed} 秒</p></div><button type="button" onClick={() => controller.current?.abort()}><Square size={14}/>停止</button></div> : null}
      {!proposal && !busy && !workflowContent && !error && workflowStage === 'requirements' ? <div className="chat-assistant-turn"><p>已恢复上次需求。可以直接重新整理，也可以在下方补充要求。</p><button type="button" disabled={locked || !configured} onClick={() => act('prepare')}><Sparkles size={16}/>重新整理需求</button></div> : null}
      {workflowStage !== 'requirements' ? <div className="chat-confirmed-requirement"><Check size={16}/><span>已确认需求</span><p>{requirement.teachingGoals?.[0]?.observable || requirement.goal}</p></div> : null}
      {workflowContent ? <div className="chat-assistant-turn chat-workflow-turn">{workflowContent}</div> : null}
    </div> : null}
    <div className={`chat-composer-dock ${inWorkflow ? 'is-docked' : ''}`}><div className="chat-composer-inner"><div className="chat-composer-card">
      {workflowStage === 'requirements' ? <div className="chat-context-controls"><ScopeTree chapters={config.chapters} selected={answers.mainScope} disabled={locked || workflowStage !== 'requirements'} onChange={value => change('mainScope', value)} open={scopeOpen} onToggle={setScopeOpen}/>
        <label className="composer-purpose"><span className="sr-only">组卷用途</span><Select aria-label="组卷用途" triggerLabel="组卷用途" value={answers.purpose || 'consolidation'} disabled={locked || workflowStage !== 'requirements'} onChange={event => change('purpose',event.target.value)}>{purposeOptions.map(item => <option key={item.id} value={item.id} data-description={item.description}>{item.label}</option>)}</Select></label>
        <button className="composer-scoring" type="button" disabled={locked || workflowStage !== 'requirements'} aria-pressed={answers.scoringMode === 'points'} onClick={() => change('scoringMode',answers.scoringMode === 'points' ? 'none' : 'points')}>{answers.scoringMode === 'points' ? '计分' : '不计分'}</button>

      </div> : <div className="composer-stage-context"><Sparkles size={14} aria-hidden="true"/><span>{workflowStage === 'blueprint' ? '选题蓝图' : workflowStage === 'draft' ? '试卷草稿' : workflowStage === 'paper' ? '已确认试卷' : '正在组卷'}</span><span className="composer-stage-hint">继续对话，随时调整</span></div>}
      <form className="intake-request" onSubmit={event => { event.preventDefault(); if (!locked && configured && answers.mainScope?.length) act('prepare'); }}>
        {selectionContext.length ? <div className="composer-selection-context" aria-label="本次调整引用">
          <div className="composer-context-chips" role="list">{selectionContext.map(slot => {
            const targetLabel = `第 ${slot.number} ${workflowStage === 'blueprint' ? '题位' : '题'}`;
            const taskLabel = [typeLabels[slot.questionType], slot.taskLabel].filter(Boolean).join(' · ');
            return <span className="composer-context-chip" key={slot.slotId} role="listitem" title={[targetLabel, taskLabel].filter(Boolean).join(' · ')}>
              <span className="composer-context-target">{targetLabel}</span>
              {taskLabel ? <span className="composer-context-task">{taskLabel}</span> : null}
            </span>;
          })}</div>
          <button type="button" className="composer-context-clear" aria-label="清除题目上下文" title="清除引用" disabled={locked} onClick={onClearSelectionContext}><X size={13} aria-hidden="true"/></button>
        </div> : null}
        <div className="composer-writing-area">
        {workflowStage === 'requirements' ? <p id="quick-purpose-description" className="composer-purpose-description" aria-live="polite"><span>{selectedPurpose.label}</span>{selectedPurpose.description}</p> : null}
        <label htmlFor="quick-goal" className="sr-only">组卷需求</label><textarea id="quick-goal" className="intake-request-text" aria-describedby={workflowStage === 'requirements' ? 'quick-purpose-description' : undefined} rows="4" maxLength={2000} disabled={locked} value={message} onChange={event => setMessage(event.target.value)} onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
        }} placeholder={inWorkflow ? '继续调整，例如：第 2 题换一题；增加 2 道填空题…' : '例如：10 道集合基础题，检测概念和包含关系的掌握情况。也可以只选范围和用途，直接发送。'}/>
        </div>
        <div className="intake-request-footer"><span className="composer-keyboard-hint">{working ? '正在处理…' : 'Enter 发送 · Shift+Enter 换行'}</span><div className="composer-send-tools"><span className="composer-ai-status"><Sparkles size={14} aria-hidden="true"/>AI 组卷</span><button className="primary intake-send" type="submit" disabled={locked || !configured || !answers.mainScope?.length} aria-label="发送组卷需求" title="发送组卷需求"><ArrowUp size={19}/><span className="sr-only">发送</span></button></div></div>
      </form>
      </div>
      <p className="composer-footnote">{inWorkflow ? '随时补充要求，确认修改建议后更新蓝图或试卷。' : `题库当前可用 ${config.supply?.ready ?? '—'} 道题 · 计分可按需开启`}</p>
    </div></div>
    {workflowStage === 'requirements' && (!configured || error) ? <div className="quick-actions"><button type="button" className="link-button" disabled={locked || !answers.mainScope?.length} onClick={() => act('plain')}>{existingGoal ? '沿用已有目标预览' : '仅按点选条件继续'}</button></div> : null}
  </section>;
}
