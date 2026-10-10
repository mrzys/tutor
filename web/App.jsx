import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api, blueprintError } from './api.js';
import { Requirements } from './Requirements.jsx';
import { Blueprint } from './Blueprint.jsx';

const Draft = lazy(() => import('./Draft.jsx').then(module => ({ default: module.Draft })));
const DraftRail = lazy(() => import('./Draft.jsx').then(module => ({ default: module.DraftRail })));
const Paper = lazy(() => import('./Paper.jsx').then(module => ({ default: module.Paper })));
const Confirmation = lazy(() => import('./Paper.jsx').then(module => ({ default: module.Confirmation })));
const SavedPapers = lazy(() => import('./Paper.jsx').then(module => ({ default: module.SavedPapers })));

function PaperRail({ paper, onNew }) {
  return <><h2>已确认成卷</h2><div className="stats-pair"><div><span>完整可作答</span><strong>{paper.summary.student.questionCount} <small>题</small></strong></div><div><span>有效分值</span><strong>{paper.summary.student.points} <small>分</small></strong></div></div><div className="paper-rail-summary"><p>确认后的内容与资料版本固定；需要修改时，从此成卷派生新草稿。</p><p>学生版：{paper.summary.student.complete ? '题面完整' : '未完整，保留缺题占位'}<br/>教师版：{paper.summary.teacher.complete ? '资料完整' : '存在待核对事项'}</p><details><summary>成卷身份</summary><code>{paper.paperId}</code></details></div><div className="rail-actions"><a href="#frozen-paper">查看确认题面</a><button className="link-button" onClick={onNew}>新建组卷</button></div></>;
}

function RequirementRail({ config, value, onBack, showBack }) {
  const chapterNames = ids => ids.map(id => config.chapters.find(item => item.id === id)?.label || id).join('、') || '未选择';
  return <><h2>本次需求</h2><dl className="requirement-summary"><dt>主考范围</dt><dd>{chapterNames(value.mainScope)}</dd><dt>已学边界</dt><dd>{chapterNames(value.learnedScope)}</dd><dt>允许前提</dt><dd>{value.premises.map(id => config.premises.find(item => item.id === id)?.label || id).join('、') || '无新增前提'}</dd><dt>可用材料</dt><dd><strong className="ready-number">{config.supply?.ready ?? 18} 题就绪</strong><small>{config.supply?.sourceUnits ?? 50} 个来源单元 · {config.supply?.pending ?? 32} 题待整理</small></dd></dl>{showBack ? <button className="link-button" onClick={onBack}>返回修改需求</button> : <p className="rail-note">主考范围说明考什么，已学边界说明解题允许用什么。</p>}</>;
}

function SavedDrafts({ drafts, warnings, onOpen, onNew, busy }) {
  return <div className="saved-drafts"><div className="section-heading"><h2>已保存草稿</h2><button className="link-button" onClick={onNew}>新建组卷</button></div>{warnings?.map((warning, index) => <p className="warning-text" key={index}>{typeof warning === 'string' ? warning : warning.message}</p>)}{!drafts.length ? <p className="empty-message">还没有已保存草稿。确认蓝图并选题后会自动保存。</p> : <ul>{drafts.map(draft => <li key={draft.draftId}><div><strong>{draft.title}</strong><small>{new Date(draft.createdAt).toLocaleString('zh-CN')} · {draft.stats?.selectedQuestions ?? '—'} 题 / {draft.stats?.availablePoints ?? '—'} 分</small></div><button disabled={busy} onClick={() => onOpen(draft.draftId)}>打开草稿</button></li>)}</ul>}</div>;
}

export function App() {
  const [config, setConfig] = useState(null);
  const [requirements, setRequirements] = useState(null);
  const [blueprint, setBlueprint] = useState(null);
  const [draft, setDraft] = useState(null);
  const [paperResult, setPaperResult] = useState(null);
  const [papers, setPapers] = useState([]);
  const [confirming, setConfirming] = useState(false);
  const [screen, setScreen] = useState('requirements');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState('');
  const [revision, setRevision] = useState(0);
  const blueprintRef = useRef(blueprint);
  blueprintRef.current = blueprint;
  const actionRef = useRef(false);
  const checkSeq = useRef(0);

  function cancelCheck() { checkSeq.current++; setRevision(0); setChecking(false); setCheckError(''); }

  function setLocation(id, kind = 'draft', replace = false) { const url = new URL(window.location.href); url.hash = ''; url.searchParams.delete('draft'); url.searchParams.delete('paper'); if (id) url.searchParams.set(kind, id); window.history[replace ? 'replaceState' : 'pushState']({}, '', url); }
  async function openDraft(id, location = true) {
    if (actionRef.current) return;
    actionRef.current = true; setBusy(true); setError('');
    try { const result = await api(`/api/drafts/${encodeURIComponent(id)}`); if (result.draft.confirmedPaperId) { const paper = await api(`/api/papers/${encodeURIComponent(result.draft.confirmedPaperId)}`); setPaperResult(paper); setScreen('paper'); setLocation(result.draft.confirmedPaperId, 'paper', true); } else { setDraft(result.draft); setScreen('draft'); if (location) setLocation(id); } window.scrollTo(0, 0); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); actionRef.current = false; }
  }
  async function openPaper(id, location = true) {
    if (actionRef.current) return;
    actionRef.current = true; setBusy(true); setError(''); setConfirming(false);
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
        setConfig(result.config); setRequirements(structuredClone(result.config.defaultRequirements)); setDrafts(result.config.drafts || []); setWarnings(result.config.draftWarnings || []);
        const params = new URL(window.location.href).searchParams;
        const id = params.get('draft'); const paperId = params.get('paper');
        if (paperId) { const saved = await api(`/api/papers/${encodeURIComponent(paperId)}`, undefined, controller.signal); setPaperResult(saved); setScreen('paper'); }
        else if (id) { const saved = await api(`/api/drafts/${encodeURIComponent(id)}`, undefined, controller.signal); if (saved.draft.confirmedPaperId) { const paper = await api(`/api/papers/${encodeURIComponent(saved.draft.confirmedPaperId)}`, undefined, controller.signal); setPaperResult(paper); setScreen('paper'); setLocation(saved.draft.confirmedPaperId, 'paper', true); } else { setDraft(saved.draft); setScreen('draft'); } }
      } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
      finally { if (!controller.signal.aborted) setBusy(false); }
    }
    load();
    return () => controller.abort();
  }, []);

  useEffect(() => { if (screen === 'draft' && draft?.confirmedPaperId) openPaper(draft.confirmedPaperId); }, [screen, draft?.confirmedPaperId]);

  useEffect(() => {
    const pop = () => { setConfirming(false); const params = new URL(window.location.href).searchParams; const id = params.get('draft'); const paperId = params.get('paper'); if (paperId) openPaper(paperId, false); else if (id) openDraft(id, false); else { setScreen('requirements'); setError(''); } };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);

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

  function editBlueprint(update) { checkSeq.current++; setBlueprint(update); setRevision(current => current + 1); setChecking(true); setCheckError(''); }
  async function generate() {
    if (actionRef.current) return;
    actionRef.current = true; setBusy(true); setError(''); cancelCheck();
    try { const result = await api('/api/blueprint', { requirements }); setBlueprint(result.blueprint); setScreen('blueprint'); setCheckError(''); setChecking(false); window.scrollTo(0, 0); }
    catch (failure) { setError(failure.message); }
    finally { actionRef.current = false; setBusy(false); }
  }
  async function confirm() {
    if (actionRef.current || checking || blueprintError(blueprint)) return;
    actionRef.current = true; setBusy(true); setError('');
    try { const result = await api('/api/drafts', { blueprint }); setDraft(result.draft); setScreen('draft'); setLocation(result.draft.draftId); window.scrollTo(0, 0); }
    catch (failure) { setError(failure.message); }
    finally { actionRef.current = false; setBusy(false); }
  }
  function newTask() { if (busy) return; cancelCheck(); setRequirements(structuredClone(config.defaultRequirements)); setBlueprint(null); setDraft(null); setPaperResult(null); setConfirming(false); setScreen('requirements'); setError(''); setLocation(null); window.scrollTo(0, 0); }
  async function savedList() {
    if (actionRef.current) return;
    actionRef.current = true; setBusy(true); setError('');
    try { const result = await api('/api/drafts'); setDrafts(result.drafts); setWarnings(result.warnings || []); setScreen('saved'); }
    catch (failure) { setError(failure.message); }
    finally { actionRef.current = false; setBusy(false); }
  }
  async function savedPaperList() {
    if (actionRef.current) return;
    actionRef.current = true; setBusy(true); setError(''); setConfirming(false);
    try { const result = await api('/api/papers'); setPapers(result.papers); setWarnings(result.warnings || []); setScreen('papers'); }
    catch (failure) { setError(failure.message); }
    finally { actionRef.current = false; setBusy(false); }
  }
  const step = screen === 'blueprint' ? 2 : screen === 'draft' ? 3 : screen === 'paper' ? 4 : 1;
  const currentRequirements = screen === 'paper' ? paperResult.paper.draft.baseline.requirements : screen === 'draft' ? draft.baseline.requirements : screen === 'blueprint' ? blueprint.requirements : requirements;
  const listScreen = ['saved', 'papers'].includes(screen);
  return <><header className="app-header"><div className="header-inner"><a className="brand" href="/" onClick={event => { event.preventDefault(); if (config) newTask(); }}>Tutor</a><span className="product-name">集合专项组卷</span><nav className="steps" aria-label="组卷步骤">{['需求', '蓝图', '草稿', '成卷'].map((label, index) => <span key={label} className={step === index + 1 && !listScreen ? 'active' : ''} aria-current={step === index + 1 && !listScreen ? 'step' : undefined}><b>{index + 1}</b>{label}</span>)}</nav><div className="saved-link paper-navigation"><button className="link-button" onClick={savedList} disabled={!config || busy}>已保存草稿</button><button className="link-button" onClick={savedPaperList} disabled={!config || busy}>已保存成卷</button></div></div></header>
    <main className="workspace" aria-busy={busy}>
      {error ? <div className="notice error" role="alert">{error}{!config ? <button onClick={() => window.location.reload()}>重新加载</button> : null}</div> : null}
      {!config || !requirements ? <p className="loading" role="status">{busy ? '正在读取组卷材料…' : '暂时无法读取组卷材料。'}</p> : <>
        <div className="page-heading"><h1>{screen === 'paper' ? paperResult.paper.title : screen === 'draft' ? draft.title : screen === 'blueprint' ? '确认选题蓝图' : screen === 'saved' ? '已保存草稿' : screen === 'papers' ? '已保存成卷' : '确认本次组卷需求'}</h1><p>{screen === 'paper' ? `已确认成卷 · ${paperResult.paper.summary.student.questionCount} 题 / ${paperResult.paper.summary.student.points} 分 / ${currentRequirements.durationMinutes} 分钟` : screen === 'draft' ? `草稿已保存 · ${draft.stats.selectedQuestions} 题 / ${draft.stats.availablePoints} 分 / ${currentRequirements.durationMinutes} 分钟` : listScreen ? '打开已保存的内容，继续核查与使用。' : `${currentRequirements.grade}数学 · 集合专项 / ${currentRequirements.durationMinutes} 分钟 / ${currentRequirements.targetScore} 分`}</p></div>
        {screen === 'saved' ? <SavedDrafts drafts={drafts} warnings={warnings} onOpen={openDraft} onNew={newTask} busy={busy}/> : screen === 'papers' ? <Suspense fallback={<p role="status">正在加载成卷列表…</p>}><SavedPapers papers={papers} warnings={warnings} onOpen={openPaper} busy={busy}/></Suspense> : <div className={`workbench ${screen === 'draft' || screen === 'paper' ? 'draft-workbench' : ''}`}><aside className="side-rail">{screen === 'paper' ? <PaperRail paper={paperResult.paper} onNew={newTask}/> : screen === 'draft' ? <Suspense fallback={<p role="status">正在加载草稿…</p>}><DraftRail draft={draft} onNew={newTask}/></Suspense> : <RequirementRail config={config} value={currentRequirements} showBack={screen === 'blueprint'} onBack={() => { if (busy) return; cancelCheck(); setRequirements(structuredClone(blueprint.requirements)); setScreen('requirements'); setError(''); }}/>}</aside><div className="main-content">{screen === 'requirements' ? <Requirements config={config} value={requirements} onChange={setRequirements} onSubmit={generate} busy={busy}/> : screen === 'blueprint' ? <Blueprint config={config} value={blueprint} onChange={editBlueprint} onConfirm={confirm} busy={busy} checking={checking} checkError={checkError}/> : screen === 'paper' ? <Suspense fallback={<p role="status">正在加载成卷…</p>}><Paper key={paperResult.paper.paperId} paper={paperResult.paper} initialOutputs={paperResult.outputs || {}} initialFeedback={paperResult.feedback || null} initialWarnings={paperResult.warnings || []} onDerived={derived}/></Suspense> : <Suspense fallback={<p role="status">正在加载试卷公式…</p>}><Draft key={draft.draftId} draft={draft} config={config} onChange={setDraft} onConfirm={() => setConfirming(true)}/></Suspense>}</div></div>}
      </>}
      <div className="sr-only" role="status" aria-live="polite">{busy ? '正在处理，请稍候。' : ''}</div>
      {confirming && draft ? <Suspense fallback={<p role="status">正在加载确认摘要…</p>}><Confirmation draft={draft} onClose={() => setConfirming(false)} onConfirmed={confirmed} onReload={() => { setConfirming(false); openDraft(draft.draftId); }}/></Suspense> : null}
    </main></>;
}
