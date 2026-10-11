import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronRight, Database, FileText, GraduationCap, Info, LoaderCircle, SlidersHorizontal, Sparkles, Square } from 'lucide-react';
import { api } from './api.js';

const stages = ['purpose', 'scope', 'boundary', 'size', 'goal', 'review'];
const stageLabels = ['用途', '范围', '已学边界', '题量分值', '教学目标', '确认'];
const headings = { purpose: '这次想考查什么？', scope: '这次考哪些内容？', boundary: '学生已经学到哪里？', size: '这份试卷需要多大？', goal: '希望学生做到什么？', review: '确认本次教学需求' };
const nextLabels = { purpose: '继续选择考查范围', scope: '继续确认已学边界', boundary: '继续设置题量分值', size: '继续明确教学目标', goal: '查看本次需求', review: '确认需求，生成蓝图' };
const storageKey = 'tutor-intake-session';
const safeKinds = new Set(['single_choice', 'multi_choice', 'number', 'text', 'notice']);
const fieldLabels = { mainScope: '主考范围', learnedScope: '已学边界', premises: '额外允许的知识与方法', purpose: '用途', cognition: '认知要求', observable: '学生表现', priority: '目标强度', title: '试卷标题', durationMinutes: '时长', targetScore: '总分', scoringMode: '计分方式', singleChoiceCount: '单选题数', fillBlankCount: '填空题数', freeResponseCount: '解答题数', response: '作答要求', prompt: '提示条件' };
const valueLabels = { consolidation: '课后巩固', diagnostic: '学情诊断', assessment: '阶段检测', mock_exam: '模拟考试', none: '不计分', points: '计分', understand: '理解概念', apply: '常规运用', reason: '推理说明', unspecified: '先按范围组卷', preferred: '尽量满足', required: '必须满足', answer: '给出答案', written_reasoning: '写出推导与理由', independent: '独立完成', provided: '提供必要提示' };
function changesOnly(next, previous) { return Object.fromEntries(Object.entries(next).filter(([field, value]) => JSON.stringify(value) !== JSON.stringify(previous[field]))); }
function remember(id) { try { id ? localStorage.setItem(storageKey, id) : localStorage.removeItem(storageKey); } catch { /* Storage can be unavailable; the server session still works. */ } }
function remembered() { try { return localStorage.getItem(storageKey); } catch { return null; } }
export function clearIntakeSession() { remember(null); }

function ChoiceBlock({ block, value, set, disabled, index }) {
  if (!safeKinds.has(block.kind)) return null;
  if (block.kind === 'notice') return <div className="intake-notice"><Info size={20}/><div>{block.title ? <strong>{block.title}</strong> : null}<p>{block.description || block.text}</p></div></div>;
  const options = Array.isArray(block.options) ? block.options : [];
  const multi = block.kind === 'multi_choice';
  const choice = multi || block.kind === 'single_choice';
  return <fieldset className={`intake-block ${block.kind}`} disabled={disabled}>
    <legend><span className="block-number">{index + 1}</span><span>{block.title || fieldLabels[block.field] || '补充条件'}</span></legend>
    {block.description ? <p className="block-description">{block.description}</p> : null}
    {choice ? <div className={multi ? 'intake-options option-list' : 'intake-options option-pills'}>{options.map(option => {
      const active = multi ? Array.isArray(value) && value.includes(option.id) : value === option.id;
      return <button className={`intake-option ${active ? 'selected' : ''}`} type="button" key={option.id} aria-pressed={active} onClick={() => set(multi ? active ? value.filter(id => id !== option.id) : [...(Array.isArray(value) ? value : []), option.id] : option.id)}>
        {multi ? <span className="choice-box">{active ? <Check size={16}/> : null}</span> : active ? <Check size={16}/> : null}
        <span>{option.label}{option.description ? <small>{option.description}</small> : null}</span>{multi ? <ChevronRight size={16} className="choice-chevron"/> : null}
      </button>;
    })}</div> : <label className="intake-input"><span className="sr-only">{block.title || fieldLabels[block.field]}</span>{block.kind === 'number' ? <input type="number" min={block.min ?? (['targetScore', 'durationMinutes'].includes(block.field) ? 1 : 0)} max={block.max ?? (['singleChoiceCount', 'fillBlankCount', 'freeResponseCount'].includes(block.field) ? 30 : block.field === 'durationMinutes' ? 300 : 1000)} value={value ?? ''} onChange={event => set(event.target.value === '' ? '' : Number(event.target.value))}/> : block.multiline || block.field === 'observable' ? <textarea rows="3" value={value ?? ''} maxLength={1000} placeholder={block.placeholder || ''} onChange={event => set(event.target.value)}/> : <input value={value ?? ''} maxLength={120} placeholder={block.placeholder || ''} onChange={event => set(event.target.value)}/>}</label>}
  </fieldset>;
}

export function Intake({ config, onRequirements, onConfirm, onAdvanced, onBusyChange, onSession, editSession = null, resetKey = 0, disabled = false }) {
  const [session, setSession] = useState(null);
  const [answers, setAnswers] = useState({});
  const [proposalAnswers, setProposalAnswers] = useState({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('loading');
  useEffect(() => { onBusyChange?.(Boolean(busy)); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const controllerRef = useRef(null);
  const inFlight = useRef(false);
  const sessionRef = useRef(null);
  const callbacks = useRef({ onRequirements, onConfirm, onSession }); callbacks.current = { onRequirements, onConfirm, onSession };
  function adopt(next) {
    sessionRef.current = next; setSession(next); setAnswers(next.answers || {}); setProposalAnswers(next.proposal?.changes || {}); remember(next.sessionId);
    if (next.requirements) callbacks.current.onRequirements(next.requirements);
    callbacks.current.onSession?.(next);
  }
  useEffect(() => {
    const controller = new AbortController(); controllerRef.current = controller;
    let active = true;
    setBusy('loading'); setError('');
    (async () => {
      const id = editSession ? null : remembered();
      let result;
      if (editSession) result = await api('/api/intake', { action: 'revise', sessionId: editSession.sessionId,
        revision: editSession.revision, stage: editSession.stage, operationId: editSession.operationId }, controller.signal);
      if (id) { try { result = await api(`/api/intake/${encodeURIComponent(id)}`, undefined, controller.signal); } catch (failure) { if (failure.name === 'AbortError') throw failure; if (failure.status !== 404) throw failure; remember(null); } }
      if (!result) result = await api('/api/intake', { action: 'start', operationId: crypto.randomUUID() }, controller.signal);
      else if (result.session.status === 'confirmed') result = await api('/api/intake', { action: 'revise', operationId: crypto.randomUUID(),
        sessionId: result.session.sessionId, revision: result.session.revision, stage: 'review' }, controller.signal);
      if (active) { adopt(result.session); setMessage(result.session.assistantMessage || ''); }
    })().catch(failure => { if (active && failure.name !== 'AbortError') setError(failure.message); }).finally(() => { if (active) setBusy(''); });
    return () => { active = false; controller.abort(); };
  }, [resetKey]);
  useEffect(() => {
    if (!['assist', 'suggest_methods'].includes(busy)) { setElapsed(0); return; }
    const started = Date.now(); const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  async function request(action, payload = {}) {
    const current = sessionRef.current;
    const result = await api('/api/intake', { action, sessionId: current.sessionId, revision: current.revision, operationId: crypto.randomUUID(), ...payload }, controllerRef.current.signal);
    adopt(result.session); return result.session;
  }
  async function act(action, payload = {}) {
    if (inFlight.current || !session || disabled) return;
    inFlight.current = true; controllerRef.current = new AbortController(); setBusy(action); setError(''); setStatus('');
    try {
      if (action === 'confirm' && sessionRef.current.status === 'confirmed') { await callbacks.current.onConfirm(sessionRef.current.requirements, { countPolicy: sessionRef.current.answers?.size === 'recommend' ? 'suggested' : 'fixed' }); return; }
      if (sessionRef.current.status === 'confirmed') {
        const current = sessionRef.current;
        const reopened = await api('/api/intake', { action: 'revise', operationId: crypto.randomUUID(), sessionId: current.sessionId,
          revision: current.revision, stage: payload.stage || current.stage }, controllerRef.current.signal);
        adopt(reopened.session);
      }
      await request('answer', { answers: changesOnly(payload.localAnswers || answers, sessionRef.current.answers), next: false });
      if (action === 'save') return;
      if (action === 'assist' || action === 'suggest_methods') { const result = await request(action, action === 'assist' ? { message: message.trim() } : {}); if (result.assistantError) setError(`${result.assistantError.message} 已保留点选条件与补充要求，可以重试或继续点选。`); else setStatus('AI 建议已生成，采纳后才会更新需求。'); }
      else if (action === 'confirm') { const confirmed = await request('confirm'); await callbacks.current.onConfirm(confirmed.requirements, { countPolicy: confirmed.answers?.size === 'recommend' ? 'suggested' : 'fixed' }); }
      else if (payload.acceptProposal) { await request('answer', { acceptProposal: true, answers: proposalAnswers }); setStatus('已采纳建议，请继续核对教学条件。'); }
      else { await request('answer', payload); }
    } catch (failure) {
      if (failure.name === 'AbortError') { setStatus('已停止整理。补充要求已保留，可再次尝试。'); try { const latest = await api(`/api/intake/${encodeURIComponent(sessionRef.current.sessionId)}`); adopt(latest.session); } catch { /* Keep the previous state when reconnecting fails. */ } }
      else { setError(`${failure.message} 请检查条件后重试，已输入内容仍保留。`); if (failure.status === 409) { try { const latest = await api(`/api/intake/${encodeURIComponent(sessionRef.current.sessionId)}`); sessionRef.current = latest.session; setSession(latest.session); } catch { /* Preserve local answers for a retry. */ } } }
    } finally { inFlight.current = false; setBusy(''); }
  }
  const stage = session?.stage || 'purpose';
  const index = stages.indexOf(stage);
  const req = session?.requirements || config.defaultRequirements;
  const labels = ids => (ids || []).map(id => config.chapters.find(chapter => chapter.id === id)?.label || id).join('、') || '待选择';
  const count = ['singleChoiceCount', 'fillBlankCount', 'freeResponseCount'].reduce((sum, field) => sum + Number(answers[field] ?? req.counts?.[{singleChoiceCount:'single_choice', fillBlankCount:'fill_blank',freeResponseCount:'free_response'}[field]] ?? 0), 0);
  const locked = Boolean(busy || disabled);
  const visibleError = error || (session?.assistantError ? `${session.assistantError.message} 可以重试，或继续点选完成需求。` : '');
  const configured = Boolean(config.intake?.configured ?? config.intake?.llmConfigured);
  const methodsStale = session?.proposalKind === 'methods' && ['mainScope', 'learnedScope', 'premises'].some(field => JSON.stringify(answers[field]) !== JSON.stringify(session?.answers?.[field]));
  const proposal = methodsStale ? null : session?.proposal;
  const proposalRequirements = proposal?.requirements || proposal?.proposedRequirements;
  const proposalEntries = Object.entries(proposal?.answers || proposal?.changes || {}).filter(([field]) => fieldLabels[field]);
  const displayValue = value => Array.isArray(value) ? value.map(item => config.chapters.find(chapter => chapter.id === item)?.label || config.premises.find(premise => premise.id === item)?.label || valueLabels[item] || item).join('、') || '无新增项' : valueLabels[value] || String(value);
  function changeAnswer(field, value) {
    const next = { ...answers, [field]: value };
    if (['singleChoiceCount', 'fillBlankCount', 'freeResponseCount', 'targetScore', 'durationMinutes'].includes(field)) next.size = 'custom';
    setAnswers(next);
    if (field === 'size' || field === 'cognition') act('save', { localAnswers: next });
  }
  const proposalPanel = proposal ? <section className="intake-proposal" aria-label="待采纳的 AI 建议"><h2><Sparkles size={20}/>{session?.proposalKind === 'methods' ? '知识与方法建议 · 待你确认' : 'AI 建议 · 待你确认'}</h2><p>{proposal.summary || proposal.rationale || '请核对以下建议，当前教学条件尚未改变。'}</p>{session?.proposalKind === 'methods' ? null : proposalEntries.length ? <dl>{proposalEntries.map(([field, value]) => <React.Fragment key={field}><dt>{fieldLabels[field]}</dt><dd>{displayValue(value)}</dd></React.Fragment>)}</dl> : proposalRequirements ? <dl><dt>主考范围</dt><dd>{labels(proposalRequirements.mainScope)}</dd><dt>题量与分值</dt><dd>{Object.values(proposalRequirements.counts || {}).reduce((sum, value) => sum + Number(value), 0)} 题{proposalRequirements.scoringMode !== 'none' ? ` · ${proposalRequirements.targetScore} 分` : ''}</dd><dt>教学目的</dt><dd>{proposalRequirements.goal}</dd></dl> : null}<div className="proposal-controls">{(proposal.blocks || []).map((block, blockIndex) => <ChoiceBlock key={block.id || blockIndex} block={block} value={proposalAnswers[block.field] ?? block.value} set={value => setProposalAnswers(current => ({ ...current, [block.field]: value }))} disabled={locked} index={blockIndex}/>)}</div><div className="action-row"><button type="button" disabled={locked} onClick={() => act('answer', { acceptProposal: true })}><Check size={16}/>采纳这份建议</button><span className="help">也可直接继续点选，保留当前条件。</span></div></section> : null;
  return <div className="intake-layout">
    <div className="intake-main">
      <div className="intake-heading"><h1>{headings[stage] || headings.purpose}</h1><p>{session?.editing ? '保留已确认条件，只需核对本次修改及相关影响。' : '点选教学条件，也可以请 AI 帮你补充。'}</p></div>
      <nav className="intake-progress" aria-label="需求确认步骤">{stages.map((item, itemIndex) => <button type="button" key={item} className={item === stage ? 'current' : ''} aria-current={item === stage ? 'step' : undefined} disabled={locked || (!session?.editing && itemIndex > index)} onClick={() => act('answer', { stage: item, next: false })}><span>{itemIndex + 1}</span>{stageLabels[itemIndex]}</button>)}</nav>
      {visibleError ? <div className="notice error" role="alert">{visibleError}{!session ? <button onClick={() => window.location.reload()}>重新加载</button> : null}</div> : null}
      {busy === 'loading' ? <p role="status" className="intake-loading"><LoaderCircle size={20} className="spinning"/>正在恢复教学需求…</p> : null}
      <div className="intake-blocks">{(session?.blocks || []).map((block, blockIndex) => <ChoiceBlock key={block.id || block.field || blockIndex} block={block} value={answers[block.field] ?? block.value} set={value => changeAnswer(block.field, value)} disabled={locked} index={blockIndex}/>)}</div>
      {stage === 'boundary' ? <>
        <section className="intake-methods" aria-labelledby="intake-methods-title">
          <h2 id="intake-methods-title">本次可使用的知识与方法</h2>
          <p>默认使用上方确认的已学内容与初中基础运算。如本次训练可以使用其他知识或方法，请 AI 结合考查内容和题库中的解法帮你核对。</p>
          <p className="help">AI 会解释需要确认的额外项；只有你采纳后才允许使用。可以保持当前条件直接继续。</p>
          <details><summary>查看自动包含的基础运算</summary><ul>{(config.courseContext?.foundation || config.foundation || []).map(item => <li key={item}>{item}</li>)}</ul></details>
          <div className="method-actions">{busy === 'suggest_methods' ? <><span role="status"><LoaderCircle size={16} className="spinning"/>正在核对知识与方法 · {elapsed} 秒</span><button type="button" onClick={() => controllerRef.current?.abort()}><Square size={16}/>停止核对</button></> : <button type="button" disabled={locked || !configured} onClick={() => act('suggest_methods')}><Sparkles size={16}/>{session?.proposalKind === 'methods' ? '重新核对知识与方法' : 'AI 建议需要确认的知识与方法'}</button>}</div>
          {!configured ? <p className="help">模型服务尚未配置。可以继续使用已学内容，也可在完整条件表单中手动确认。</p> : null}
        </section>
        {methodsStale ? <p className="help" role="status">已学内容或允许的方法已修改，请重新核对知识与方法。</p> : null}
        {proposalPanel}
        {status ? <p className="help" role="status">{status}</p> : null}
      </> : null}
      {stage === 'review' ? <div className="intake-review"><h2>确认需求后，由 AI 规划蓝图</h2><p>{answers.size === 'recommend' ? '题型配比由 AI 建议，题目总数、总分与时长保持当前要求。' : '题型与题量按已确认设置保留，由 AI 安排考查任务。'}蓝图仍需你确认后才会选题保存。</p><p>{req.goal}</p><div className="intake-review-edits"><button className="link-button" disabled={locked} onClick={() => act('answer', { stage: 'purpose' })}>修改用途</button><button className="link-button" disabled={locked} onClick={() => act('answer', { stage: 'size' })}>修改题量分值</button><button className="link-button" disabled={locked} onClick={() => act('answer', { stage: 'goal' })}>修改教学目标</button></div><dl><dt>主考范围 <button className="requirement-edit link-button" disabled={locked} onClick={() => act('answer', { stage: 'scope' })}>修改</button></dt><dd>{labels(req.mainScope)}</dd><dt>已学边界 <button className="requirement-edit link-button" disabled={locked} onClick={() => act('answer', { stage: 'boundary' })}>修改</button></dt><dd>{labels(req.learnedScope)}</dd><dt>额外允许的知识与方法</dt><dd>{(req.premises || []).map(id => config.premises.find(item => item.id === id)?.label || id).join('、') || '仅使用已学内容与基础运算'}</dd></dl>{(req.teachingGoals || []).map(goal => <div key={goal.id} className="review-goal"><strong>{goal.observable}</strong><p>{goal.priority === 'required' ? '必须满足：缺少支持证据的题目会被排除，可能出现缺题。' : '尽量满足：目标支持尚待核验，不作为已证实覆盖。'}</p></div>)}</div> : null}
      {session ? <div className="intake-next"><button type="button" className="primary" disabled={locked} onClick={() => act(stage === 'review' ? 'confirm' : 'answer', { next: true })}>{busy === 'confirm' ? '正在生成蓝图…' : session?.editing && stage !== 'review' ? (['goal', 'size'].includes(stage) ? '保存修改，返回确认' : '保存并核对相关条件') : nextLabels[stage]}<ArrowRight size={20}/></button>{index > 0 ? <button type="button" className="link-button" disabled={locked} onClick={() => act('answer', { stage: stages[index - 1], next: false })}><ArrowLeft size={16}/>上一步</button> : null}</div> : null}
      <section className="intake-composer" aria-labelledby="intake-composer-label"><label id="intake-composer-label" htmlFor="intake-message">还有其他要求？</label><textarea id="intake-message" rows="3" placeholder="例如：少一些计算，多考概念辨析" maxLength={2000} value={message} onChange={event => setMessage(event.target.value)} disabled={locked}/><div className="composer-meta"><span>{message.length}/2000</span></div><div className="composer-actions"><span className="ai-caption"><Sparkles size={16}/>AI 辅助整理</span>{busy === 'assist' ? <button type="button" onClick={() => controllerRef.current?.abort()}><Square size={16}/>停止整理</button> : <button type="button" disabled={locked || !configured || !message.trim()} onClick={() => act('assist')}><Sparkles size={16}/>整理需求</button>}</div>{!configured ? <p className="help">模型服务尚未配置，可以继续点选完成组卷。</p> : null}{busy === 'assist' ? <p className="help" role="status"><LoaderCircle size={16} className="spinning"/>正在整理补充要求 · {elapsed} 秒</p> : null}{stage !== 'boundary' && status ? <p className="help" role="status">{status}</p> : null}</section>
      {stage !== 'boundary' ? proposalPanel : null}
      <button className="intake-advanced link-button" type="button" disabled={locked} onClick={async () => { if (!session) return; if (inFlight.current) return; if (sessionRef.current.status === 'confirmed') { onAdvanced(); return; } inFlight.current = true; controllerRef.current = new AbortController(); setBusy('answer'); try { await request('answer', { answers: changesOnly(answers, sessionRef.current.answers), next: false }); onAdvanced(); } catch (failure) { setError(failure.message); } finally { inFlight.current = false; setBusy(''); } }}><SlidersHorizontal size={16}/>打开完整条件表单</button>
    </div>
    <aside className="intake-summary"><h2>本次需求</h2><ul><li><GraduationCap size={24}/><span>{req.grade}数学</span></li><li><BookOpen size={24}/><span>{labels(answers.mainScope ?? req.mainScope)}</span></li><li><FileText size={24}/><span>{count} 题{(answers.scoringMode ?? req.scoringMode) !== 'none' ? ` · ${answers.targetScore ?? req.targetScore} 分` : ''} · {answers.durationMinutes ?? req.durationMinutes} 分钟</span></li><li><Database size={24}/><span>{config.supply?.ready ?? '—'} 道就绪题</span></li></ul><div className="summary-hint"><Info size={20}/><p>题位安排将在蓝图中统一确认。主考范围与已学边界分别设置。</p></div>{session ? <p className="intake-save-state">每次继续都会保存条件，可刷新恢复。</p> : null}</aside>
  </div>;
}
