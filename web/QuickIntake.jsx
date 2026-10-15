import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUp, Check, LoaderCircle, Sparkles, Square, X } from 'lucide-react';
import { api, typeLabels } from './api.js';
import { ScopeTree } from './ScopeTree.jsx';
import { Select } from './Select.jsx';
import './Composer.css';
import './IntakeReview.css';
import { availableScopeSelection } from '../src/curriculum/availability.mjs';
import { assemblyPurposes, purposeFor } from '../src/assembly/purposes.mjs';
import { Explanation } from './Explanation.jsx';

const storageKey = 'tutor-intake-session';
const purposeOptions = assemblyPurposes;
const countFields = [['singleChoiceCount', '单选'], ['fillBlankCount', '填空'], ['freeResponseCount', '解答']];
function remember(id) { try { localStorage.setItem(storageKey, id); } catch { /* Server persistence remains available. */ } }
function remembered() { try { return localStorage.getItem(storageKey); } catch { return null; } }
function freshAnswers(config) {
  return { mainScope: availableScopeSelection(config.chapters, config.defaultRequirements.mainScope),
    purpose: 'consolidation', scoringMode: 'none', targetScore: 0 };
}
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
  const [answers, setAnswers] = useState(() => freshAnswers(config));
  const [message, setMessage] = useState('');
  const [proposalEdits, setProposalEdits] = useState({});
  const [resumeId, setResumeId] = useState(() => remembered());
  const [restoreId, setRestoreId] = useState(() => editSession?.sessionId || null);
  const [busy, setBusy] = useState(() => editSession?.sessionId ? 'loading' : '');
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
  const pendingScopeEdit = useRef(editSession?.stage === 'scope');
  const startRequest = useRef(null);
  const callbacks = useRef({ onRequirements, onConfirm, onSession }); callbacks.current = { onRequirements, onConfirm, onSession };
  useEffect(() => () => controller.current?.abort(), []);
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
    setError('');
    if (['blueprint', 'draft', 'paper'].includes(workflowStage)) {
      setAnswers({ mainScope: workflowRequirements?.mainScope || [], purpose: workflowRequirements?.purpose || 'consolidation', scoringMode: workflowRequirements?.scoringMode || 'points' });
      setStarted(true); setBusy(''); return;
    }
    const edit = initialEdit.current;
    // A new composer must not silently reopen or revise a previously confirmed request.
    // Explicit workflow edits still restore immediately; home offers a resume action.
    const id = restoreId;
    if (!id) {
      setAnswers(freshAnswers(config)); setBusy(''); return;
    }
    setBusy('loading');
    const activeController = new AbortController(); controller.current = activeController;
    let active = true;
    (async () => {
      let result;
      if (id) {
        try { result = await api(`/api/intake/${encodeURIComponent(id)}`, undefined, activeController.signal); }
        catch (failure) { if (failure.status !== 404) throw failure; }
      }
      if (!active) return;
      if (!result || result.session.mode !== 'quick') {
        try { localStorage.removeItem(storageKey); } catch { /* The next send can still create a session. */ }
        setResumeId(null);
        setAnswers(result ? { ...result.session.answers, learnedScopeMode: 'custom' } : freshAnswers(config));
        return;
      } else if (result.session.status === 'confirmed') {
        result = await api('/api/intake', { action: 'revise', sessionId: result.session.sessionId, revision: result.session.revision,
          stage: edit?.stage || 'review', operationId: edit?.operationId || crypto.randomUUID() }, activeController.signal);
      }
      if (active) {
        adopt(result.session);
        if (edit?.message) setMessage(edit.message);
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
  }, [resetKey, retryKey, restoreId]);
  useEffect(() => {
    if (pendingScopeEdit.current && !busy && !disabled && workflowStage === 'requirements') {
      pendingScopeEdit.current = false;
      setScopeOpen(true);
    }
  }, [busy, disabled, workflowStage]);
  useEffect(() => {
    if (busy !== 'prepare') { setElapsed(0); return; }
    const started = Date.now(); const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  const locked = Boolean(busy || disabled);
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
    inFlight.current = true; controller.current = new AbortController(); setBusy(action); setError('');
    let submittedInput = null;
    try {
      if (!sessionRef.current) {
        startRequest.current ??= { action: 'start', flow: 'quick', operationId: crypto.randomUUID(), answers };
        const result = await api('/api/intake', startRequest.current, controller.current.signal);
        adopt(result.session, true);
      }
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
  const selectedPurpose = purposeFor(answers.purpose) || purposeOptions[0];
  const legacyPurpose = answers.purpose && !purposeOptions.some(item => item.id === answers.purpose) ? purposeFor(answers.purpose) : null;
  const scored = (proposed.scoringMode || answers.scoringMode || 'points') === 'points';
  const working = busy === 'prepare' || workflowStage === 'planning' || disabled;
  const suggestedScope = proposed.mainScope || answers.mainScope || [];
  const suggestedPurpose = purposeFor(proposed.purpose || answers.purpose);
  const hasSuggestedTypes = countFields.every(([field]) => Number.isInteger(proposed[field])) || answers.size === 'custom';
  const constraints = proposed.typeConstraints || answers.typeConstraints;
  const constraintLabels = constraints ? [
    ...(constraints.excludedTypes || []).map(type => `不含${typeLabels[type]}题`),
    ...Object.entries(constraints.exactCounts || {}).map(([type, count]) => `${typeLabels[type]} ${count} 题`),
  ] : [];
  const scaleSummary = `规模：${proposed.questionCount ?? count} 题${scored ? ` · ${proposed.targetScore ?? answers.targetScore} 分` : ' · 不计分'} · ${proposed.durationMinutes ?? answers.durationMinutes} 分钟。`;
  function focusComposer() { document.getElementById('quick-goal')?.focus({ preventScroll: true }); }
  return <section className={`quick-intake composer-intake ${inWorkflow ? 'intake-in-workflow' : 'intake-empty'}`} aria-label={inWorkflow ? "组卷调整" : "新建组卷"}>
    {!inWorkflow ? <div className="quick-heading"><h1>新建组卷</h1><span>选择范围和用途，补充题量或考查重点。</span></div> : null}
    {!inWorkflow && resumeId && !restoreId ? <div className="intake-resume"><button type="button" className="link-button" disabled={locked} onClick={() => setRestoreId(resumeId)}>继续上次需求</button></div> : null}
    {error ? <p className="notice error" role="alert">{error}{!session ? <button type="button" disabled={Boolean(busy)} onClick={() => setRetryKey(value => value + 1)}>重新连接</button> : null}</p> : null}
    {busy === 'loading' ? <p role="status"><LoaderCircle size={18} className="spinning"/>正在恢复需求…</p> : null}
    {inWorkflow && (!hideEmptyConversation || turns.length > 0 || workflowContent) ? <div className="intake-conversation" aria-label="本次组卷需求">
      {turns.length > 1 ? <details className="intake-request-history"><summary>查看之前的要求</summary>{turns.slice(0, -1).map((turn, index) => <div className={turn.role === 'teacher' ? 'intake-teacher-turn' : 'chat-assistant-history'} key={index}><p>{turn.text}</p></div>)}</details> : null}
      {turns.length ? <div className="intake-teacher-turn intake-latest-request"><p>{turns.at(-1).text}</p></div> : null}
      {proposal && workflowStage === 'requirements' ? <div className="chat-assistant-turn">
        <section id="quick-suggestion" className="quick-proposal" aria-label="确认组卷需求"><div className="suggestion-heading"><h2>本次考查重点</h2><span>待确认</span></div><Explanation className="suggestion-objectives" text={proposedGoal || proposal.summary}/>
          <div className="quick-proposal-meta"><span>{session.proposalPlanning?.questionCount ?? proposed.questionCount ?? count} 题</span><span>{proposed.durationMinutes ?? answers.durationMinutes} 分钟</span><span>{scored ? `${proposed.targetScore ?? answers.targetScore} 分` : '不计分'}</span>{proposed.priority === 'required' ? <span>必须考查</span> : null}</div>
          <section className="suggestion-conditions" aria-label="组卷条件"><dl>
            <div><dt>考查范围</dt><dd><ul className="suggestion-scope-list">{suggestedScope.map(id => <li key={id}>{chapterNames([id])}</li>)}</ul></dd></div>
            <div><dt>组卷用途</dt><dd>{suggestedPurpose?.label || selectedPurpose.label}</dd></div>
            {constraintLabels.length ? <div><dt>题型要求</dt><dd>{constraintLabels.join(' · ')}</dd></div> : null}
            {hasSuggestedTypes ? <div><dt>{constraintLabels.length && answers.size !== 'custom' ? '建议配比' : '题型安排'}</dt><dd>{countFields.map(([field, label]) => `${label} ${proposed[field] ?? answers[field] ?? 0} 题`).join(' · ')}</dd></div> : null}
          </dl></section>
          {proposal.summary.trim() !== scaleSummary ? <details className="suggestion-explanation"><summary>查看安排说明</summary><Explanation text={proposal.summary} omitLine={scaleSummary}/></details> : null}
          {(proposal.blocks || []).map(block => <Clarification key={block.id} block={block} value={proposalEdits[block.field]} onChange={value => setProposalEdits(current => ({...current,[block.field]:value}))} disabled={locked}/>)}
          {dirty ? <p className="quick-stale">有新的补充或条件变更，发送后会更新这份建议。</p> : null}
          <div className="quick-actions"><button className="primary" type="button" disabled={locked || dirty} onClick={() => act('accept')}>确认需求，安排练习<ArrowRight size={16}/></button><button type="button" className="link-button" disabled={locked} onClick={focusComposer}>补充或修改</button></div>
        </section></div> : null}
      {busy === 'prepare' ? <div className="chat-working" role="status"><LoaderCircle size={19} className="spinning"/><div><strong>正在整理需求</strong><p>结合范围和用途，形成考查重点 · {elapsed} 秒</p></div><button type="button" onClick={() => controller.current?.abort()}><Square size={14}/>停止</button></div> : null}
      {!proposal && !busy && !workflowContent && !error && workflowStage === 'requirements' ? <div className="chat-assistant-turn"><p>已恢复上次需求。可以直接重新整理，也可以在下方补充要求。</p><button type="button" disabled={locked || !configured} onClick={() => act('prepare')}><Sparkles size={16}/>重新整理需求</button></div> : null}
      {workflowContent ? <div className="chat-assistant-turn chat-workflow-turn">{workflowContent}</div> : null}
    </div> : null}
    <div className={`chat-composer-dock ${inWorkflow ? 'is-docked' : ''}`}><div className="chat-composer-inner"><div className="chat-composer-card">
      {workflowStage === 'requirements' ? <div className="chat-context-controls"><ScopeTree chapters={config.chapters} selected={answers.mainScope} disabled={locked || workflowStage !== 'requirements'} onChange={value => change('mainScope', value)} open={scopeOpen} onToggle={setScopeOpen}/>
        <label className="composer-purpose"><span className="sr-only">组卷用途</span><Select aria-label="组卷用途" triggerLabel="组卷用途" value={answers.purpose || 'consolidation'} disabled={locked || workflowStage !== 'requirements'} onChange={event => change('purpose',event.target.value)}>{[...purposeOptions, ...(legacyPurpose ? [legacyPurpose] : [])].map(item => <option key={item.id} value={item.id} data-description={item.description}>{item.label}</option>)}</Select></label>
        <button className="composer-scoring" type="button" role="switch" aria-label="试卷计分" disabled={locked || workflowStage !== 'requirements'} aria-checked={answers.scoringMode === 'points'} onClick={() => change('scoringMode',answers.scoringMode === 'points' ? 'none' : 'points')}><span>计分</span><span className="scoring-switch-track" aria-hidden="true"><span/></span><span className="scoring-switch-value" aria-hidden="true">{answers.scoringMode === 'points' ? '开' : '关'}</span></button>

      </div> : <div className="composer-stage-context"><span>{workflowStage === 'blueprint' ? '调整题位' : workflowStage === 'draft' ? '调整题目' : workflowStage === 'paper' ? '已确认试卷' : '正在组卷'}</span></div>}
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
        {workflowStage === 'requirements' ? <p id="quick-purpose-description" className="sr-only">{selectedPurpose.label}：{selectedPurpose.description}</p> : null}
        <label htmlFor="quick-goal" className="sr-only">组卷需求</label><textarea id="quick-goal" className="intake-request-text" aria-describedby={workflowStage === 'requirements' ? 'quick-purpose-description' : undefined} rows="4" maxLength={2000} disabled={locked} value={message} onChange={event => setMessage(event.target.value)} onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
        }} placeholder={workflowStage !== 'requirements' ? '继续调整，例如：第 2 题换一题；增加 2 道填空题…' : selectedPurpose.placeholder}/>
        </div>
        <div className="intake-request-footer"><span className="composer-keyboard-hint">{working ? '正在处理…' : 'Enter 发送 · Shift+Enter 换行'}</span><div className="composer-send-tools"><button className="primary intake-send" type="submit" disabled={locked || !configured || !answers.mainScope?.length}><span>{inWorkflow ? '发送调整' : '开始组卷'}</span><ArrowUp size={17} aria-hidden="true"/></button></div></div>
      </form>
      </div>
    </div></div>
    {workflowStage === 'requirements' && (!configured || error) ? <div className="quick-actions"><button type="button" className="link-button" disabled={locked || !answers.mainScope?.length} onClick={() => act('plain')}>{existingGoal ? '沿用已有目标预览' : '仅按点选条件继续'}</button></div> : null}
  </section>;
}
