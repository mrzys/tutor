import React, { useEffect, useId, useRef, useState } from 'react';
import { Brand } from './Brand.jsx';
import { UserManagement } from './UserManagement.jsx';
import { BookOpen, Ellipsis, FileCheck, FileText, LoaderCircle, LogOut, PanelLeft, Pencil, Plus, RefreshCw, Users } from 'lucide-react';
import { ActionMenu } from './ActionMenu.jsx';
import { Modal } from './DraftEditor.jsx';
import { api } from './api.js';
import './HistorySidebar.css';

function DraftRename({ draft, onClose, onRenamed }) {
  const [title, setTitle] = useState(draft.title);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [revision, setRevision] = useState(draft.revision ?? 0);
  const fieldId = useId();
  const formId = useId();
  const helpId = useId();
  const request = useRef(null);
  const operation = useRef(null);
  const submitting = useRef(false);
  useEffect(() => () => request.current?.abort(), []);
  async function save(event) {
    event.preventDefault();
    const nextTitle = title.trim();
    if (submitting.current || !nextTitle || nextTitle.length > 120 || conflict) return;
    if (nextTitle === draft.title) { onClose(); return; }
    const key = `${revision}:${nextTitle}`;
    if (operation.current?.key !== key) operation.current = { key, id: crypto.randomUUID() };
    const controller = new AbortController(); request.current = controller;
    submitting.current = true; setPending(true); setError('');
    try {
      const result = await api(`/api/drafts/${encodeURIComponent(draft.draftId)}/operations`, {
        type: 'rename', title: nextTitle, operationId: operation.current.id, expectedRevision: revision,
      }, controller.signal);
      if (!controller.signal.aborted) { onRenamed?.(result.draft); onClose(); }
    } catch (failure) {
      if (!controller.signal.aborted) { setError(failure.message); setConflict(failure.status === 409); }
    } finally { submitting.current = false; if (!controller.signal.aborted) setPending(false); }
  }
  async function reload() {
    if (submitting.current) return;
    const controller = new AbortController(); request.current = controller;
    submitting.current = true; setPending(true); setError('');
    try {
      const result = await api(`/api/drafts/${encodeURIComponent(draft.draftId)}`, undefined, controller.signal);
      if (controller.signal.aborted) return;
      if (result.draft.confirmedPaperId) { onRenamed?.(result.draft); onClose(); return; }
      setRevision(result.draft.revision ?? 0); operation.current = null;
      onRenamed?.(result.draft); setConflict(false);
    } catch (failure) { if (!controller.signal.aborted) setError(failure.message); }
    finally { submitting.current = false; if (!controller.signal.aborted) setPending(false); }
  }
  return <Modal title="重命名试卷" onClose={onClose} busy={pending} className="history-rename-dialog" footer={<>
    <button type="button" onClick={onClose} disabled={pending}>取消</button>
    <button type="submit" form={formId} className="primary" disabled={pending || conflict || !title.trim() || title.trim().length > 120}>{pending ? <LoaderCircle size={16} className="spinning" aria-hidden="true"/> : null}{pending ? '正在保存…' : '保存名称'}</button>
  </>}><form id={formId} onSubmit={save} className="history-rename-form" aria-busy={pending}>
    <label htmlFor={fieldId}>试卷名称</label>
    <input id={fieldId} autoFocus required maxLength={120} value={title} disabled={pending} aria-describedby={helpId} onChange={event => { setTitle(event.target.value); if (!conflict) setError(''); }}/>
    <p id={helpId} className="help">最多 120 个字符，题目和组卷安排保持不变。</p>
    {error ? <p role="alert" className="error-text">{error}</p> : null}
    {conflict ? <div className="history-rename-conflict"><p>草稿已更新，读取最新版本后可继续保存名称。</p><button type="button" disabled={pending} onClick={reload}>读取最新草稿</button></div> : null}
  </form></Modal>;
}

function HistoryGroup({ title, items, kind, activeId, busy, onOpen, onRename }) {
  const groupId = useId();
  return <section className="history-group" aria-label={title}>
    <h2>{title}<span>{items.length}</span></h2>
    {items.length ? <ul>{items.map((item, index) => {
      const id = kind === 'paper' ? item.paperId : item.draftId;
      const count = kind === 'paper' ? item.summary?.student?.questionCount : item.stats?.selectedQuestions;
      const scored = (item.scoringMode ?? item.summary?.scoringMode) !== 'none';
      const points = kind === 'paper' ? item.summary?.student?.points : item.stats?.availablePoints;
      const Icon = kind === 'paper' ? FileCheck : FileText;
      const summaryId = `${groupId}-${index}`;
      const summary = [item.scopeSummary, item.purposeLabel, new Date(item.createdAt).toLocaleString('zh-CN')].filter(Boolean).join(' · ');
      return <li key={id} className={`history-entry ${kind === 'draft' ? 'history-entry-editable' : ''}`}><button className={`history-item ${activeId === id ? 'active' : ''}`} aria-disabled={busy || undefined}
        aria-current={activeId === id ? 'page' : undefined} onClick={() => { if (!busy && activeId !== id) onOpen(id); }}
        aria-describedby={summaryId} title={`${item.title} · ${count ?? '—'} 题${scored ? ` / ${points ?? '—'} 分` : ''} · ${summary}`}>
        <Icon size={17} aria-hidden="true"/><span><strong>{item.title}</strong><small>{count ?? '—'} 题 · <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</time></small></span>
      </button>{kind === 'draft' ? <ActionMenu label={`“${item.title}”的更多操作`} className="history-entry-menu" triggerClassName="history-entry-more" menuClassName="history-entry-actions" disabled={busy} triggerContent={<Ellipsis size={18} aria-hidden="true"/>}>
        <button type="button" role="menuitem" onClick={() => onRename(item)}><Pencil size={15} aria-hidden="true"/>重命名</button>
      </ActionMenu> : null}<span id={summaryId} role="tooltip" className="history-item-details">{item.title}<br/>{summary}</span></li>;
    })}</ul> : <p className="history-empty">{kind === 'paper' ? '还没有已确认的试卷' : '还没有进行中的草稿'}</p>}
  </section>;
}

export function HistorySidebar({ drafts, papers, activeDraftId, activePaperId, activeView, busy, loading, error, onRetry, onNew, onQuestionBank, onOpenDraft, onOpenPaper, onRenamed, onClose, user, onLogout, logoutPending, logoutError }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [managementOpen, setManagementOpen] = useState(false);
  const [renaming, setRenaming] = useState(null);
  const accountMenu = useRef(null);
  const moreButton = useRef(null);
  const menuId = useId();
  useEffect(() => {
    if (!menuOpen) return;
    accountMenu.current?.querySelector('[role="menuitem"]')?.focus();
    const outside = event => { if (!accountMenu.current?.contains(event.target)) setMenuOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [menuOpen]);
  function menuKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); setMenuOpen(false); moreButton.current?.focus(); }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const items = [...accountMenu.current.querySelectorAll('[role="menuitem"]')];
      const index = items.indexOf(document.activeElement);
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length]?.focus();
    }
    if (event.key === 'Tab') setMenuOpen(false);
  }
  const accountName = user?.email?.split('@')[0] || '教师';
  const confirmedSources = new Set(papers.map(paper => paper.sourceDraftId));
  const ongoing = drafts.filter(draft => !draft.confirmedPaperId && !confirmedSources.has(draft.draftId));
  return <aside className="history-sidebar" id="assembly-history" aria-label="组卷历史">
    <div className="history-brand-row"><Brand/><button className="sidebar-icon sidebar-toggle" data-state="expanded" onClick={onClose} aria-label="收起组卷历史" title="收起组卷历史" aria-expanded="true" aria-controls="assembly-history"><PanelLeft size={22} aria-hidden="true"/></button></div>
    <div className="history-sidebar-top"><button className="new-assembly sidebar-primary-action" onClick={onNew} disabled={busy}><Plus size={18} aria-hidden="true"/>新建组卷</button>
      <nav className="sidebar-primary-nav" aria-label="题库功能">
        <button className={`sidebar-primary-action ${activeView === 'question-bank' ? 'active' : ''}`} aria-current={activeView === 'question-bank' ? 'page' : undefined} onClick={onQuestionBank} disabled={busy}><BookOpen size={18} aria-hidden="true"/><span>题库</span></button>
      </nav>
    </div>
    <div className="history-scroll">
      {loading && !drafts.length && !papers.length ? <p className="history-loading" role="status">正在读取历史…</p> : null}
      {error ? <div className="history-error" role="alert"><p>{error}</p><button onClick={onRetry} disabled={loading}><RefreshCw size={14}/>重新加载历史</button></div> : null}
      <HistoryGroup title="进行中" items={ongoing} kind="draft" activeId={activeDraftId} busy={busy} onOpen={onOpenDraft} onRename={setRenaming}/>
      <HistoryGroup title="历史归档" items={papers} kind="paper" activeId={activePaperId} busy={busy} onOpen={onOpenPaper}/>
    </div>
    <div className="history-sidebar-footer history-account">
      <div className="history-account-row">
        <span className="account-avatar" aria-hidden="true">{(user?.email?.split('@')[0].match(/[a-z]/i)?.[0] || user?.email?.[0] || 'T').toUpperCase()}</span>
        <div className="account-identity"><strong title={accountName}>{accountName}</strong><span>{user?.role === 'admin' ? '管理员' : '教师'}</span></div>
        <div className="account-menu-anchor" ref={accountMenu} onKeyDown={menuKey}>
          <button ref={moreButton} type="button" className="sidebar-icon account-logout" title="更多" aria-label="账号更多选项" aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuOpen ? menuId : undefined} disabled={logoutPending} onClick={() => setMenuOpen(value => !value)}>{logoutPending ? <LoaderCircle className="spinning" size={18} aria-hidden="true"/> : <Ellipsis size={20} aria-hidden="true"/>}</button>
          {menuOpen ? <div className="account-menu" id={menuId} role="menu" aria-label="账号选项">
            {user?.role === 'admin' ? <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setManagementOpen(true); }}><Users size={17} aria-hidden="true"/>用户管理</button> : null}
            <button type="button" role="menuitem" disabled={logoutPending} onClick={() => { setMenuOpen(false); onLogout(); }}><LogOut size={17} aria-hidden="true"/>退出登录</button>
          </div> : null}
        </div>
      </div>
      {logoutError ? <p className="account-error" role="alert">{logoutError}</p> : null}
    </div>
    {managementOpen && user?.role === 'admin' ? <UserManagement currentUser={user} onClose={() => { setManagementOpen(false); moreButton.current?.focus(); }}/> : null}
    {renaming ? <DraftRename draft={renaming} onClose={() => setRenaming(null)} onRenamed={onRenamed}/> : null}
  </aside>;
}
