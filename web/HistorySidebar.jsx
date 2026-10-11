import React from 'react';
import { BookOpen, FileText, MessageSquare, PanelLeft, Plus, RefreshCw } from 'lucide-react';

function HistoryGroup({ title, items, kind, activeId, busy, onOpen }) {
  return <section className="history-group" aria-label={title}>
    <h2>{title}<span>{items.length}</span></h2>
    {items.length ? <ul>{items.map(item => {
      const id = kind === 'paper' ? item.paperId : item.draftId;
      const count = kind === 'paper' ? item.summary?.student?.questionCount : item.stats?.selectedQuestions;
      const scored = (item.scoringMode ?? item.summary?.scoringMode) !== 'none';
      const points = kind === 'paper' ? item.summary?.student?.points : item.stats?.availablePoints;
      const Icon = kind === 'paper' ? FileText : MessageSquare;
      return <li key={id}><button className={`history-item ${activeId === id ? 'active' : ''}`} disabled={busy}
        aria-current={activeId === id ? 'page' : undefined} onClick={() => onOpen(id)}
        title={`${item.title} · ${count ?? '—'} 题${scored ? ` / ${points ?? '—'} 分` : ''} · ${new Date(item.createdAt).toLocaleString('zh-CN')}`}>
        <Icon size={18}/><span><strong>{item.title}</strong><small>{count ?? '—'} 题 · <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</time></small></span>
      </button></li>;
    })}</ul> : <p className="history-empty">{kind === 'paper' ? '还没有已确认的试卷' : '还没有进行中的草稿'}</p>}
  </section>;
}

export function HistorySidebar({ drafts, papers, activeDraftId, activePaperId, activeView, busy, loading, error, onRetry, onNew, onQuestionBank, onOpenDraft, onOpenPaper, onClose }) {
  const confirmedSources = new Set(papers.map(paper => paper.sourceDraftId));
  const ongoing = drafts.filter(draft => !confirmedSources.has(draft.draftId));
  return <aside className="history-sidebar" id="assembly-history" aria-label="组卷历史">
    <div className="history-brand-row"><span className="brand">Tutor</span><button className="sidebar-icon sidebar-toggle" data-state="expanded" onClick={onClose} aria-label="收起组卷历史" title="收起组卷历史" aria-expanded="true" aria-controls="assembly-history"><PanelLeft size={22} aria-hidden="true"/></button></div>
    <div className="history-sidebar-top"><button className="new-assembly" onClick={onNew} disabled={busy}><Plus size={20}/>新建组卷</button>
      <nav className="sidebar-primary-nav" aria-label="题库功能">
        <button className={activeView === 'question-bank' ? 'active' : ''} aria-current={activeView === 'question-bank' ? 'page' : undefined} onClick={onQuestionBank} disabled={busy}><BookOpen size={18}/><span>题库</span></button>
      </nav>
    </div>
    <div className="history-scroll">
      {loading ? <p className="history-loading" role="status">正在更新历史…</p> : null}
      {error ? <div className="history-error" role="alert"><p>{error}</p><button onClick={onRetry} disabled={loading}><RefreshCw size={14}/>重新加载历史</button></div> : null}
      <HistoryGroup title="进行中" items={ongoing} kind="draft" activeId={activeDraftId} busy={busy} onOpen={onOpenDraft}/>
      <HistoryGroup title="历史归档" items={papers} kind="paper" activeId={activePaperId} busy={busy} onOpen={onOpenPaper}/>
    </div>
    <div className="history-sidebar-footer"><span>教学组卷工作台</span></div>
  </aside>;
}
