import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api, blueprintError } from './api.js';
import { Blueprint } from './Blueprint.jsx';
import { clearIntakeSession } from './Intake.jsx';
import { QuickIntake } from './QuickIntake.jsx';
import { LoaderCircle, PanelLeft, Sparkles, Square } from 'lucide-react';
import { HistorySidebar } from './HistorySidebar.jsx';
import { AssemblyWorkbench } from './AssemblyWorkbench.jsx';
import { AuthGate } from './AuthGate.jsx';
import './conversation.css';
import { applyBlueprintActions, draftOperationsFor } from './assistant-actions.js';

const Draft = lazy(() => import('./Draft.jsx').then(module => ({ default: module.Draft })));
const Paper = lazy(() => import('./Paper.jsx').then(module => ({ default: module.Paper })));
const Confirmation = lazy(() => import('./Paper.jsx').then(module => ({ default: module.Confirmation })));
const SavedPapers = lazy(() => import('./Paper.jsx').then(module => ({ default: module.SavedPapers })));
const QuestionBank = lazy(() => import('./QuestionBank.jsx').then(module => ({ default: module.QuestionBank })));
const QuestionImport = lazy(() => import('./QuestionImport.jsx').then(module => ({ default: module.QuestionImport })));

function PlanningNotice({ planning, configured, onCancel, onRetry, onPreset }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    if (planning?.status !== 'loading') return;
    const update = () => setElapsed(Math.floor((Date.now() - planning.startedAt) / 1000));
    update(); const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [planning?.status, planning?.startedAt]);
  if (!planning) return null;
  const loading = planning.status === 'loading';
  return <section className="blueprint-planning-notice" aria-label="蓝图规划状态">
    <div className="planning-status" role={planning.status === 'error' ? 'alert' : 'status'}>
      {loading ? <LoaderCircle size={18} className="spinning" aria-hidden="true"/> : <Sparkles size={18} aria-hidden="true"/>}
      <div><strong>{loading ? (planning.mode === 'preset' ? '正在核查规则预设…' : 'AI 正在规划选题蓝图…') : planning.status === 'cancelled' ? '已停止蓝图规划' : '蓝图规划未完成'}</strong>
        <p>{loading ? `结合教学目标与题库供给安排题位 · ${elapsed} 秒。完成后由你确认。` : planning.error || '本次需求已保留，可以再次规划。'}</p></div>
    </div>
    <div className="planning-controls">{loading ? <button type="button" onClick={onCancel}><Square size={14}/>停止规划</button> : <><button type="button" onClick={onRetry} disabled={!configured}><Sparkles size={14}/>再次 AI 规划</button><button type="button" onClick={onPreset}>使用规则预设</button></>}</div>
  </section>;
}

function SelectionNotice({ selection, onCancel, onRetry, onRule }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (selection?.status !== 'loading') return;
    const update = () => setElapsed(Math.floor((Date.now() - selection.startedAt) / 1000));
    update(); const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [selection?.status, selection?.startedAt]);
  if (!selection) return null;
  const loading = selection.status === 'loading';
  return <section className="blueprint-planning-notice" aria-label="候选题比较状态">
    <div className="planning-status" role={selection.status === 'error' ? 'alert' : 'status'}>
      {loading ? <LoaderCircle size={18} className="spinning" aria-hidden="true"/> : <Sparkles size={18} aria-hidden="true"/>}
      <div><strong>{loading ? (selection.mode === 'llm' ? 'AI 正在比较候选题…' : '正在按规则选题…') : selection.status === 'cancelled' ? '已停止选题' : '选题未完成'}</strong>
        <p>{loading ? `核对题面与教学目标，组合整卷并去重 · ${elapsed} 秒。` : selection.error || '蓝图已保留，尚未创建草稿。'}</p></div>
    </div>
    <div className="planning-controls">{loading ? <button type="button" onClick={onCancel}><Square size={14}/>停止选题</button> : <><button type="button" onClick={onRetry}><Sparkles size={14}/>重试 AI 选题</button><button type="button" onClick={onRule}>改用规则选题</button></>}</div>
    {!loading ? <p className="help">规则选题按已核实条件组合候选，不包含 AI 对题面的教学比较；必须目标的证据要求仍保留。</p> : null}
  </section>;
}

function SavedDrafts({ drafts, warnings, onOpen, onNew, busy }) {
  return <div className="saved-drafts"><div className="section-heading"><h2>已保存草稿</h2><button className="link-button" onClick={onNew}>新建组卷</button></div>{warnings?.map((warning, index) => <p className="warning-text" key={index}>{typeof warning === 'string' ? warning : warning.message}</p>)}{!drafts.length ? <p className="empty-message">还没有已保存草稿。确认蓝图并选题后会自动保存。</p> : <ul>{drafts.map(draft => <li key={draft.draftId}><div><strong>{draft.title}</strong><small>{new Date(draft.createdAt).toLocaleString('zh-CN')} · {draft.stats?.selectedQuestions ?? '—'} 题{draft.scoringMode === 'none' ? ' · 不计分' : ` / ${draft.stats?.availablePoints ?? '—'} 分`}</small></div><button disabled={busy} onClick={() => onOpen(draft.draftId)}>打开草稿</button></li>)}</ul>}</div>;
}

export function App() {
  return <AuthGate>{auth => <WorkspaceApp {...auth}/>}</AuthGate>;
}

export default App;

function WorkspaceApp({ user, onLogout, logoutPending, logoutError }) {
  const [config, setConfig] = useState(null);
  const [requirements, setRequirements] = useState(null);
  const [blueprint, setBlueprint] = useState(null);
  const [draft, setDraft] = useState(null);
  const [paperResult, setPaperResult] = useState(null);
  const [papers, setPapers] = useState([]);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 760);
  const [intakeBusy, setIntakeBusy] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState('');
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [screen, setScreen] = useState('requirements');
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantAnchor, setAssistantAnchor] = useState(null);
  const [assistantTargets, setAssistantTargets] = useState([]);
  const [chatProposal, setChatProposal] = useState(null);
  const [assistantReply, setAssistantReply] = useState('');
  const [chatWorking, setChatWorking] = useState(false);
  const chatRequest = useRef(null);
  const chatConfirming = useRef(false);
  const [intakeKey, setIntakeKey] = useState(0);
  const [intakeEdit, setIntakeEdit] = useState(null);
  const intakeSession = useRef(null);
  const [busy, setBusy] = useState(true);
  const [planning, setPlanning] = useState(null);
  const [selection, setSelection] = useState(null);
  const selectionRequest = useRef(null);
  const planningRequest = useRef(null);
  const lastPlanning = useRef(null);
  useEffect(() => () => { planningRequest.current?.abort(); selectionRequest.current?.abort(); chatRequest.current?.abort(); }, []);
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState('');
  const [revision, setRevision] = useState(0);
  const blueprintRef = useRef(blueprint);
  blueprintRef.current = blueprint;
  const actionRef = useRef(false);
  const sidebarToggle = useRef(null);
  const checkSeq = useRef(0);

  useEffect(() => {
    if (!sidebarOpen) return;
    const sidebar = document.getElementById('assembly-history');
    const main = document.querySelector('.app-main');
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    const mobile = window.matchMedia('(max-width: 760px)');
    const sync = () => {
      main.inert = mobile.matches;
      document.body.style.overflow = mobile.matches ? 'hidden' : previousOverflow;
      if (mobile.matches) sidebar.querySelector('button:not(:disabled)')?.focus();
    };
    const onKey = event => {
      if (event.key === 'Escape' && mobile.matches) setSidebarOpen(false);
      if (event.key !== 'Tab' || !mobile.matches) return;
      const buttons = [...sidebar.querySelectorAll('button:not(:disabled)')];
      const target = event.shiftKey ? buttons.at(-1) : buttons[0];
      if (document.activeElement === (event.shiftKey ? buttons[0] : buttons.at(-1))) {
        event.preventDefault(); target?.focus();
      }
    };
    sync(); mobile.addEventListener('change', sync); document.addEventListener('keydown', onKey);
    return () => {
      main.inert = false; document.body.style.overflow = previousOverflow;
      mobile.removeEventListener('change', sync); document.removeEventListener('keydown', onKey);
      if (sidebarToggle.current) sidebarToggle.current.focus({ preventScroll: true });
      else if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [sidebarOpen]);

  function cancelCheck() { checkSeq.current++; setRevision(0); setChecking(false); setCheckError(''); }
  function closeMobileSidebar() { if (window.innerWidth <= 760) setSidebarOpen(false); }

  useEffect(() => {
    const controller = new AbortController();
    setHistoryLoading(true); setHistoryError('');
    Promise.allSettled([api('/api/drafts', undefined, controller.signal), api('/api/papers', undefined, controller.signal)]).then(results => {
      if (controller.signal.aborted) return;
      const [savedDrafts, savedPapers] = results;
      if (savedDrafts.status === 'fulfilled') setDrafts(savedDrafts.value.drafts);
      if (savedPapers.status === 'fulfilled') setPapers(savedPapers.value.papers);
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason.message] : (result.value.warnings || []).map(item => typeof item === 'string' ? item : item.message));
      setHistoryError(failures.join('；')); setHistoryLoading(false);
    });
    return () => controller.abort();
  }, [draft?.draftId, draft?.revision, paperResult?.paper?.paperId, historyRefresh]);

  function setLocation(id, kind = 'draft', replace = false) { const url = new URL(window.location.href); url.hash = ''; url.searchParams.delete('draft'); url.searchParams.delete('paper'); url.searchParams.delete('view'); if (id) url.searchParams.set(kind, id); window.history[replace ? 'replaceState' : 'pushState']({}, '', url); }
  function setUtilityLocation(view, replace = false) { const url = new URL(window.location.href); url.hash = ''; url.searchParams.delete('draft'); url.searchParams.delete('paper'); url.searchParams.set('view', view); window.history[replace ? 'replaceState' : 'pushState']({}, '', url); }
  async function openDraft(id, location = true) {
    if (actionRef.current) return;
    actionRef.current = true; setBusy(true); setError(''); setChatProposal(null); setAssistantReply(''); setAssistantOpen(false); setAssistantTargets([]); setIntakeKey(current => current + 1);
    try { const result = await api(`/api/drafts/${encodeURIComponent(id)}`); if (result.draft.confirmedPaperId) { const paper = await api(`/api/papers/${encodeURIComponent(result.draft.confirmedPaperId)}`); setPaperResult(paper); setScreen('paper'); setLocation(result.draft.confirmedPaperId, 'paper', true); } else { setDraft(result.draft); setScreen('draft'); if (location) setLocation(id); } window.scrollTo(0, 0); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); actionRef.current = false; }
  }
  async function openPaper(id, location = true) {
    if (actionRef.current) return;
    actionRef.current = true; setBusy(true); setError(''); setConfirming(false); setChatProposal(null); setAssistantReply(''); setAssistantOpen(false); setAssistantTargets([]); setIntakeKey(current => current + 1);
    try { const result = await api(`/api/papers/${encodeURIComponent(id)}`); setPaperResult(result); setScreen('paper'); if (location) setLocation(id, 'paper'); window.scrollTo(0, 0); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); actionRef.current = false; }
  }
  function confirmed(paper) { setPaperResult({ paper, outputs: {} }); setConfirming(false); setScreen('paper'); setLocation(paper.paperId, 'paper'); window.scrollTo(0, 0); }
  function derived(draft) { setDraft(draft); setScreen('draft'); setLocation(draft.draftId); window.scrollTo(0, 0); }

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const result = await api('/api/config', undefined, controller.signal);
        const params = new URL(window.location.href).searchParams;
        const id = params.get('draft'); const paperId = params.get('paper'); const view = params.get('view');
        if (paperId) { const saved = await api(`/api/papers/${encodeURIComponent(paperId)}`, undefined, controller.signal); setPaperResult(saved); setScreen('paper'); }
        else if (id) { const saved = await api(`/api/drafts/${encodeURIComponent(id)}`, undefined, controller.signal); if (saved.draft.confirmedPaperId) { const paper = await api(`/api/papers/${encodeURIComponent(saved.draft.confirmedPaperId)}`, undefined, controller.signal); setPaperResult(paper); setScreen('paper'); setLocation(saved.draft.confirmedPaperId, 'paper', true); } else { setDraft(saved.draft); setScreen('draft'); } }
        else if (['question-bank', 'question-import'].includes(view)) setScreen(view);
        setConfig(result.config); setRequirements(structuredClone(result.config.defaultRequirements)); setDrafts(result.config.drafts || []); setWarnings(result.config.draftWarnings || []);
      } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
      finally { if (!controller.signal.aborted) setBusy(false); }
    }
    load();
    return () => controller.abort();
  }, []);

  useEffect(() => { if (screen === 'draft' && draft?.confirmedPaperId) openPaper(draft.confirmedPaperId); }, [screen, draft?.confirmedPaperId]);

  useEffect(() => {
    const pop = () => {
      const params = new URL(window.location.href).searchParams;
      const id = params.get('draft'); const paperId = params.get('paper'); const view = params.get('view');
      // Question anchors share the current document; preserve native scrolling.
      if (paperId && screen === 'paper' && paperResult?.paper?.paperId === paperId) return;
      if (!paperId && id && screen === 'draft' && draft?.draftId === id) return;
      if (planningRequest.current) cancelPlanning();
      if (selectionRequest.current) cancelSelection();
      setSelection(null);
      setPlanning(null); setConfirming(false);
      if (paperId) openPaper(paperId, false);
      else if (id) openDraft(id, false);
      else if (['question-bank', 'question-import'].includes(view)) { setScreen(view); setError(''); setAssistantOpen(false); setAssistantTargets([]); }
      else { setScreen('requirements'); setError(''); }
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, [screen, draft?.draftId, paperResult?.paper?.paperId]);

  useEffect(() => {
    if (!revision || !blueprintRef.current) return;
    const current = blueprintRef.current;
    const seq = ++checkSeq.current;
    setCheckError('');
    if (blueprintError(current)) { setChecking(false); return; }
    const controller = new AbortController();
    setChecking(true);
    const timer = setTimeout(async () => {
      try { const result = await api('/api/blueprint/recheck', { blueprint: current }, controller.signal); if (checkSeq.current === seq) setBlueprint(result.blueprint); }
      catch (failure) { if (failure.name !== 'AbortError' && checkSeq.current === seq) setCheckError(failure.message); }
      finally { if (!controller.signal.aborted && checkSeq.current === seq) setChecking(false); }
    }, 220);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [revision]);

  function editBlueprint(update) { setChatProposal(null); setAssistantReply(''); setPlanning(null); setSelection(null); checkSeq.current++; setBlueprint(update); setRevision(current => current + 1); setChecking(true); setCheckError(''); }
  function cancelPlanning() {
    const controller = planningRequest.current;
    if (!controller) return;
    controller.abort(); planningRequest.current = null; actionRef.current = false; setBusy(false);
    setPlanning({ status: 'cancelled' });
  }
  async function generate(confirmedRequirements, planningOptions = {}, mode = 'llm') {
    if (actionRef.current) return;
    const nextRequirements = structuredClone(confirmedRequirements || requirements);
    const countPolicy = planningOptions.countPolicy || 'fixed';
    const controller = new AbortController(); planningRequest.current = controller;
    lastPlanning.current = { requirements: nextRequirements, countPolicy };
    actionRef.current = true; setBusy(true); setError(''); setSelection(null); cancelCheck();
    setPlanning({ status: 'loading', mode, startedAt: Date.now() }); setRequirements(nextRequirements); window.scrollTo(0, 0);
    try {
      const result = await api(mode === 'preset' ? '/api/blueprint' : '/api/blueprint/plan', { requirements: nextRequirements, ...(mode === 'llm' ? { countPolicy } : {}) }, controller.signal);
      if (controller.signal.aborted || planningRequest.current !== controller) return;
      setBlueprint(result.blueprint); setScreen('blueprint'); setPlanning(null); setCheckError(''); setChecking(false);
      setAssistantOpen(false); setAssistantTargets([]); setChatProposal(null); setAssistantReply('');
      window.scrollTo(0, 0);
    } catch (failure) {
      if (controller.signal.aborted || planningRequest.current !== controller) return;
      setPlanning({ status: 'error', error: `${failure.message} 本次需求已保留，未创建或改动草稿。` });
    } finally {
      if (planningRequest.current === controller) { planningRequest.current = null; actionRef.current = false; setBusy(false); }
    }
  }
  function retryPlanning(mode = 'llm') {
    const previous = lastPlanning.current;
    if (previous) return generate(previous.requirements, { countPolicy: previous.countPolicy }, mode);
  }
  function cancelSelection() {
    const controller = selectionRequest.current;
    if (!controller) return;
    controller.abort(); selectionRequest.current = null; actionRef.current = false; setBusy(false);
    setSelection({ status: 'cancelled' });
  }
  async function confirm(requestedMode) {
    if (actionRef.current || checking || checkError || !blueprint?.slots.length || blueprintError(blueprint)) return;
    if ((blueprint.requirements.teachingGoals || []).some(goal => goal.priority === 'required'
      && !blueprint.slots.some(slot => (slot.goalIds || []).includes(goal.id)))) return;
    const mode = requestedMode || (blueprint.generation?.mode === 'llm' ? 'llm' : 'rule');
    const controller = new AbortController(); selectionRequest.current = controller;
    actionRef.current = true; setBusy(true); setError('');
    setSelection({ status: 'loading', mode, startedAt: Date.now() }); window.scrollTo(0, 0);
    try {
      const result = await api('/api/drafts', { blueprint, selectionMode: mode }, controller.signal);
      if (controller.signal.aborted || selectionRequest.current !== controller) return;
      setSelection(null); setDraft(result.draft); setChatProposal(null); setAssistantReply(''); setAssistantOpen(false); setAssistantTargets([]); setScreen('draft'); setLocation(result.draft.draftId); window.scrollTo(0, 0);
    } catch (failure) {
      if (controller.signal.aborted || selectionRequest.current !== controller) return;
      setSelection({ status: 'error', error: `${failure.message} 蓝图已保留，未创建草稿。${mode === 'llm' ? '系统未自动切换为规则选题。' : ''}` });
    } finally {
      if (selectionRequest.current === controller) { selectionRequest.current = null; actionRef.current = false; setBusy(false); }
    }
  }
  function newTask() { if (busy || intakeBusy || !config) return; closeMobileSidebar(); setAssistantOpen(false); setAssistantTargets([]); setChatProposal(null); setAssistantReply(''); clearIntakeSession(); intakeSession.current = null; setIntakeEdit(null); setIntakeKey(current => current + 1); cancelCheck(); setRequirements(structuredClone(config.defaultRequirements)); setBlueprint(null); setDraft(null); setPaperResult(null); setConfirming(false); setScreen('requirements'); setError(''); setPlanning(null); setSelection(null); setLocation(null); window.scrollTo(0, 0); }
  function openUtility(view) { if (busy || intakeBusy || chatWorking) return; closeMobileSidebar(); setAssistantOpen(false); setAssistantTargets([]); setChatProposal(null); setAssistantReply(''); setConfirming(false); setError(''); setScreen(view); setUtilityLocation(view); window.scrollTo(0, 0); }
  function manualDraftCreated(nextDraft) { setDraft(nextDraft); setPaperResult(null); setScreen('draft'); setLocation(nextDraft.draftId); window.scrollTo(0, 0); }
  async function savedList() {
    if (actionRef.current) return;
    actionRef.current = true; setBusy(true); setError('');
    try { const result = await api('/api/drafts'); setDrafts(result.drafts); setWarnings(result.warnings || []); setScreen('saved'); }
    catch (failure) { setError(failure.message); }
    finally { actionRef.current = false; setBusy(false); }
  }
  async function savedPaperList() {
    if (actionRef.current) return;
    actionRef.current = true; setBusy(true); setError(''); setConfirming(false); setChatProposal(null); setAssistantReply(''); setAssistantOpen(false); setAssistantTargets([]);
    try { const result = await api('/api/papers'); setPapers(result.papers); setWarnings(result.warnings || []); setScreen('papers'); }
    catch (failure) { setError(failure.message); }
    finally { actionRef.current = false; setBusy(false); }
  }
  const step = screen === 'blueprint' ? 2 : ['draft', 'paper'].includes(screen) ? 3 : 1;
  const currentRequirements = screen === 'paper' ? paperResult.paper.draft.baseline.requirements : screen === 'draft' ? draft.baseline.requirements : screen === 'blueprint' ? blueprint.requirements : requirements;
  const listScreen = ['saved', 'papers', 'question-bank', 'question-import'].includes(screen);
  const quickFlow = ['requirements', 'blueprint', 'draft', 'paper'].includes(screen);
  function reviseWorkflow() {
    setChatProposal(null); setAssistantReply('');
    cancelCheck(); setScreen('requirements'); setBlueprint(null); setPlanning(null); setSelection(null); setError('');
  }
  function reviseIntake(stage = 'review') {
    if (busy || chatWorking) return;
    setAssistantOpen(false); setAssistantTargets([]); setChatProposal(null); setAssistantReply('');
    cancelCheck(); setRequirements(structuredClone(blueprint.requirements));
    const source = intakeSession.current;
    if (source?.status === 'confirmed') {
      setIntakeEdit({ sessionId: source.sessionId, revision: source.revision, stage, operationId: crypto.randomUUID() });
      setIntakeKey(current => current + 1);
    } else { setIntakeEdit(null); }
    setScreen('requirements'); setError(''); setSelection(null);
  }
  function updateDraft(next) { setDraft(next); setChatProposal(null); setAssistantReply('试卷已更新并保存。'); }
  useEffect(() => {
    if (!chatProposal && !chatWorking && !assistantReply) return;
    const frame = requestAnimationFrame(() => document.querySelector(chatProposal ? '.chat-adjustment' : chatWorking ? '.chat-working' : '.assembly-reply-summary')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    return () => cancelAnimationFrame(frame);
  }, [chatProposal, chatWorking, assistantReply]);
  function stopChat() { chatRequest.current?.abort(); }
  async function proposeAdjustment(message) {
    if (chatWorking || chatConfirming.current) return;
    if (screen === 'paper') { setAssistantReply('这份试卷已确认保存。请从成卷派生新草稿后继续调整。'); return; }
    const controller = new AbortController(); chatRequest.current = controller;
    const stage = screen === 'draft' ? 'draft' : 'blueprint';
    const snapshot = stage === 'draft' ? { draftId: draft.draftId, revision: draft.revision ?? 0 } : { blueprint: JSON.stringify(blueprint) };
    setChatProposal(null); setAssistantReply(''); setChatWorking(true);
    try {
      const response = await api('/api/assistant/propose', { stage, message, ...(stage === 'draft' ? { draftId: draft.draftId, expectedRevision: draft.revision ?? 0 } : { blueprint }) }, controller.signal);
      setChatProposal({ ...response, snapshot, stage });
    } catch (failure) {
      if (failure.name === 'AbortError') setAssistantReply('已停止整理修改建议，当前内容保持不变。');
      else throw failure;
    } finally { if (chatRequest.current === controller) { chatRequest.current = null; setChatWorking(false); } }
  }
  async function acceptAdjustment() {
    if (!chatProposal || chatConfirming.current || busy || checking) return;
    const pending = chatProposal;
    chatConfirming.current = true; setChatWorking(true); setError('');
    try {
      if (pending.stage === 'blueprint') {
        if (pending.snapshot.blueprint !== JSON.stringify(blueprint)) throw new Error('蓝图已变化，请重新发送调整要求。');
        const next = applyBlueprintActions(blueprint, pending.proposal.actions, config.tasks);
        const response = await api('/api/blueprint/recheck', { blueprint: next });
        cancelCheck(); setBlueprint(response.blueprint); setChatProposal(null); setAssistantReply('蓝图已按确认的建议更新。请检查题位与可选题，再确认选题。');
      } else {
        if (pending.snapshot.draftId !== draft.draftId || pending.snapshot.revision !== (draft.revision ?? 0)) throw new Error('试卷已更新，请重新发送调整要求。');
        const operations = draftOperationsFor(pending.proposal.actions, draft, config.tasks);
        let current = draft;
        const outcomes = [];
        for (const operation of operations) {
          const response = await api(`/api/drafts/${encodeURIComponent(current.draftId)}/operations`, { ...operation, operationId: crypto.randomUUID(), expectedRevision: current.revision ?? 0 });
          current = response.draft; setDraft(current);
          outcomes.push(...(response.result?.entries || []).map(entry => entry.message).filter(Boolean));
        }
        setChatProposal(null); setAssistantReply(outcomes.join(' ') || '已完成调整并保存试卷。');
      }
    } catch (failure) {
      setChatProposal(null); setError(`${failure.message} 已保存的修改会保留，可重新读取试卷后继续。`);
      if (pending.stage === 'draft') { try { const response = await api(`/api/drafts/${encodeURIComponent(pending.snapshot.draftId)}`); setDraft(response.draft); } catch { /* Retain the last acknowledged version. */ } }
    } finally { chatConfirming.current = false; setChatWorking(false); }
  }
  const adjustmentView = <>{chatWorking ? <div className="chat-working" role="status"><LoaderCircle className="spinning" size={18}/><strong>{chatConfirming.current ? '正在应用修改…' : '正在整理修改建议…'}</strong>{!chatConfirming.current ? <button onClick={stopChat}><Square size={14}/>停止</button> : null}</div> : null}{chatProposal ? <section className="chat-adjustment" aria-label="待确认的修改建议"><strong>{chatProposal.proposal.status === 'ready' ? '准备这样调整' : '需要补充一点信息'}</strong><p>{chatProposal.proposal.summary}</p>{chatProposal.proposal.clarification ? <p className="chat-clarification">{chatProposal.proposal.clarification}</p> : <div className="action-row"><button className="primary" disabled={chatWorking || busy || checking} onClick={acceptAdjustment}>确认修改</button><button disabled={chatWorking} onClick={() => setChatProposal(null)}>保留当前版本</button></div>}</section> : null}</>;
  const artifactDraft = screen === 'paper' ? paperResult?.paper?.draft : draft;
  const displaySlots = screen === 'blueprint' ? blueprint?.slots : ['draft', 'paper'].includes(screen) ? artifactDraft?.slots : null;
  const contextTargets = (displaySlots || []).filter(slot => assistantTargets.some(target => target.slotId === slot.slotId))
    .map(slot => ({ slotId: slot.slotId, number: slot.number, questionType: slot.questionType,
      taskLabel: slot.taskLabel || config.tasks.find(task => task.id === slot.taskId)?.label }));
  function openAiAdjustment(target) {
    if (busy || chatWorking) return;
    setChatProposal(null); setAssistantReply('');
    setAssistantTargets((Array.isArray(target) ? target : [target]).map(slot => ({ slotId: slot.slotId, number: slot.number })));
    setAssistantAnchor({ element: document.activeElement });
    setAssistantOpen(true);
  }
  const displayRequirements = displaySlots ? { ...currentRequirements,
    title: screen === 'blueprint' ? currentRequirements.title : artifactDraft.title,
    counts: Object.fromEntries(['single_choice', 'fill_blank', 'free_response'].map(type => [type, displaySlots.filter(slot => slot.questionType === type).length])),
    targetScore: screen === 'blueprint' ? displaySlots.reduce((sum, slot) => sum + slot.points, 0) : artifactDraft.stats.availablePoints } : currentRequirements;
  const inWorkbench = ['blueprint', 'draft', 'paper'].includes(screen);
  const planningNotice = <PlanningNotice planning={planning} configured={config?.blueprintPlanner?.configured !== false} onCancel={cancelPlanning} onRetry={() => retryPlanning()} onPreset={() => retryPlanning('preset')}/>;
  const blueprintView = screen === 'blueprint' ? <><SelectionNotice selection={selection} onCancel={cancelSelection} onRetry={() => confirm('llm')} onRule={() => confirm('rule')}/>{planningNotice}<Blueprint onBack={reviseIntake} config={config} value={blueprint} onAiAdjust={openAiAdjustment} onChange={editBlueprint} onConfirm={() => confirm()} busy={busy || chatWorking} checking={checking} checkError={checkError}/></> : planning ? planningNotice : null;
  // The document is the primary surface. The assistant only proposes confirmed changes.
  const assistantContent = assistantReply || chatProposal || chatWorking ? <>{assistantReply ? <p className="assembly-reply-summary" role="status">{assistantReply}</p> : null}{adjustmentView}</> : null;
  const intake = config && requirements ? <QuickIntake key={intakeKey} resetKey={intakeKey} config={config} editSession={intakeEdit} onSession={next => { intakeSession.current = next; setIntakeEdit(null); }} onRequirements={next => { setRequirements(next); if (planning?.status !== 'loading') setPlanning(null); }} onBusyChange={setIntakeBusy} onConfirm={generate} onReviseWorkflow={reviseWorkflow} workflowRequirements={currentRequirements} workflowSummary={assistantReply} onWorkflowMessage={proposeAdjustment} workflowStage={inWorkbench ? screen : planning?.status === 'loading' ? 'planning' : planning ? 'planning-stopped' : 'requirements'} hideEmptyConversation={inWorkbench} workflowContent={inWorkbench ? assistantContent : blueprintView} selectionContext={contextTargets} onClearSelectionContext={() => setAssistantTargets([])} disabled={busy || chatWorking}/> : null;
  const product = screen === 'blueprint' ? blueprintView : <div inert={chatWorking || undefined}><Suspense fallback={<p role="status">正在加载试卷…</p>}>{screen === 'paper' && paperResult ? <Paper key={paperResult.paper.paperId} paper={paperResult.paper} initialOutputs={paperResult.outputs || {}} initialFeedback={paperResult.feedback || null} initialWarnings={paperResult.warnings || []} onDerived={derived}/> : draft ? <Draft key={draft.draftId} draft={draft} config={config} onChange={updateDraft} onSelectionChange={setAssistantTargets} onAiAdjust={openAiAdjustment} onConfirm={() => setConfirming(true)}/> : null}</Suspense></div>;
  return <div className={`app-shell ${screen === 'question-bank' ? 'question-bank-shell' : ''} ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}>
    {sidebarOpen ? <><button className="sidebar-backdrop" aria-label="关闭组卷历史" onClick={() => setSidebarOpen(false)}/><HistorySidebar drafts={drafts} papers={papers} activeDraftId={screen === 'draft' ? draft?.draftId : null} activePaperId={screen === 'paper' ? paperResult?.paper?.paperId : null} activeView={['question-bank', 'question-import'].includes(screen) ? screen : null} busy={busy || intakeBusy || chatWorking || !config} loading={historyLoading} error={historyError} onRetry={() => setHistoryRefresh(value => value + 1)} onNew={newTask} onQuestionBank={() => openUtility('question-bank')} onQuestionImport={() => openUtility('question-import')} onOpenDraft={async id => { await openDraft(id); closeMobileSidebar(); }} onOpenPaper={async id => { await openPaper(id); closeMobileSidebar(); }} onClose={() => setSidebarOpen(false)} user={user} onLogout={onLogout} logoutPending={logoutPending} logoutError={logoutError}/></> : null}
    <div className="app-main">{screen === 'question-bank' ? (!sidebarOpen ? <button ref={sidebarToggle} className="sidebar-icon sidebar-toggle bank-sidebar-toggle" data-state="collapsed" title="展开组卷历史" aria-label="展开组卷历史" aria-expanded="false" aria-controls="assembly-history" onClick={() => setSidebarOpen(true)}><PanelLeft size={22} aria-hidden="true"/></button> : null) : <header className="app-header"><div className="header-inner"><div className="workspace-brand">{!sidebarOpen ? <button ref={sidebarToggle} className="sidebar-icon sidebar-toggle" data-state="collapsed" title="展开组卷历史" aria-label="展开组卷历史" aria-expanded={sidebarOpen} aria-controls="assembly-history" onClick={() => setSidebarOpen(true)}><PanelLeft size={22}/></button> : null}{!sidebarOpen ? <span className="brand">Tutor</span> : null}</div><nav className="steps" aria-label="组卷步骤">{['需求', '蓝图', '试卷'].map((label,index) => <span key={label} className={step === index + 1 && !listScreen ? 'active' : ''} aria-current={step === index + 1 && !listScreen ? 'step' : undefined}><b>{index + 1}</b>{label}</span>)}</nav></div></header>}
    <main className={`workspace ${inWorkbench ? 'product-workspace' : quickFlow ? 'chat-workspace' : ''}`} aria-busy={busy || chatWorking}>
      {error ? <div className="notice error" role="alert">{error}{!config ? <button onClick={() => window.location.reload()}>重新加载</button> : null}</div> : null}
      {!config || !requirements ? <p role="status">正在读取组卷材料…</p> : inWorkbench ? <AssemblyWorkbench config={config} requirements={displayRequirements} stage={screen} assistantOpen={assistantOpen} onToggleAssistant={() => setAssistantOpen(open => !open)} onEditRequirements={screen === 'blueprint' ? () => reviseIntake() : undefined} busy={busy || chatWorking} assistantAnchor={assistantAnchor} assistant={intake}>{product}</AssemblyWorkbench> : quickFlow ? intake : screen === 'saved' ? <SavedDrafts drafts={drafts} warnings={warnings} onOpen={openDraft} onNew={newTask} busy={busy}/> : screen === 'question-bank' ? <Suspense fallback={<p role="status">正在加载题库…</p>}><QuestionBank onCreated={manualDraftCreated} onImport={() => openUtility('question-import')}/></Suspense> : screen === 'question-import' ? <Suspense fallback={<p role="status">正在加载上传工具…</p>}><QuestionImport/></Suspense> : <Suspense fallback={<p role="status">正在加载成卷列表…</p>}><SavedPapers papers={papers} warnings={warnings} onOpen={openPaper} busy={busy}/></Suspense>}
      <div className="sr-only" role="status" aria-live="polite">{busy ? '正在处理，请稍候。' : ''}</div>
      {confirming && draft ? <Suspense fallback={<p role="status">正在加载确认摘要…</p>}><Confirmation draft={draft} onClose={() => setConfirming(false)} onConfirmed={confirmed} onReload={() => { setConfirming(false); openDraft(draft.draftId); }}/></Suspense> : null}
    </main></div>

  </div>;
}
