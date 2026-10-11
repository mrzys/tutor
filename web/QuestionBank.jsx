import React, { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { BookOpen, Check, LoaderCircle, Search, X } from 'lucide-react';
import { api, typeLabels } from './api.js';
import { MathText } from './MathText.jsx';

function QuestionCard({ question, selected, onToggle }) {
  return <article className={`bank-question ${selected ? 'is-selected' : ''}`}>
    <label className="bank-question-select">
      <input type="checkbox" checked={selected} onChange={() => onToggle(question.questionId)}/>
      <span className="bank-question-id">{question.questionId}</span>
      <span className="bank-question-type">{typeLabels[question.questionType] ?? question.questionType}</span>
      {selected ? <span className="bank-selected-label"><Check size={14}/>已选</span> : null}
    </label>
    <div className="bank-question-body">
      <p className="bank-question-stem"><MathText text={question.student.stem}/></p>
      {question.student.options.length ? <div className="bank-question-options">{question.student.options.map(option =>
        <p key={option.label}><span>{option.label}.</span><MathText text={option.text}/></p>)}</div> : null}
      {question.student.parts.length ? <div className="bank-question-parts">{question.student.parts.map((part, index) =>
        <p key={part.partId}><span>（{index + 1}）</span><MathText text={part.prompt}/></p>)}</div> : null}
      <div className="bank-question-meta">
        <span>{question.topics.join('、') || question.taskSummary}</span>
        <span>{question.sourceRefs[0]?.locator || '已核验题包'}</span>
      </div>
      <details className="bank-question-evidence"><summary>查看知识与来源信息</summary>
        <dl><dt>考查摘要</dt><dd>{question.taskSummary}</dd><dt>相关知识</dt><dd>{question.requiredKnowledge.join('、') || '未单独标注'}</dd><dt>来源定位</dt><dd>{question.sourceRefs.map(ref => `${ref.locator}（${ref.pages.join('、')} 页）`).join('；')}</dd></dl>
      </details>
    </div>
  </article>;
}

export function QuestionBank({ onCreated }) {
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [chapter, setChapter] = useState('all');
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase('zh-CN'));
  const [selected, setSelected] = useState(() => new Set());
  const [title, setTitle] = useState('题库手动组卷');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    api('/api/question-bank', undefined, controller.signal)
      .then(setCatalog)
      .catch(failure => { if (failure.name !== 'AbortError') setError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  const questions = useMemo(() => {
    if (!catalog) return [];
    return catalog.questions.filter(question => {
      if (chapter !== 'all' && !question.chapters.includes(chapter)) return false;
      if (!deferredQuery) return true;
      return [question.questionId, question.taskSummary, question.student.stem, ...question.topics, ...question.requiredKnowledge]
        .join(' ').toLocaleLowerCase('zh-CN').includes(deferredQuery);
    });
  }, [catalog, chapter, deferredQuery]);

  function toggle(questionId) {
    setSelected(current => {
      const next = new Set(current);
      if (next.has(questionId)) next.delete(questionId); else next.add(questionId);
      return next;
    });
  }

  async function createDraft(event) {
    event.preventDefault();
    if (!selected.size || creating) return;
    setCreating(true); setError('');
    try {
      const byId = new Map(catalog.questions.map(question => [question.questionId, question]));
      const selections = [...selected].map(questionId => {
        const question = byId.get(questionId);
        return { questionId, contentVersion: question.contentVersion, teacherVersion: question.teacherVersion };
      });
      const result = await api('/api/question-bank/manual-draft', { title: title.trim(), selections });
      onCreated(result.draft);
    } catch (failure) { setError(failure.message); }
    finally { setCreating(false); }
  }

  if (loading) return <section className="question-bank-page"><p className="bank-status" role="status"><LoaderCircle className="spinning" size={18}/>正在读取题库…</p></section>;
  if (!catalog) return <section className="question-bank-page"><div className="notice error" role="alert">{error || '题库暂时无法读取。'}</div></section>;
  return <section className="question-bank-page">
    <div className="question-bank-heading"><div><span className="bank-eyebrow"><BookOpen size={16}/>题库</span><h1>按章节挑选题目</h1><p>勾选题目后直接组成草稿，不经过 AI 或规则自动换题。</p></div>
      <div className="bank-total"><strong>{catalog.totals.ready}</strong><span>道可用题</span></div>
    </div>
    {error ? <div className="notice error" role="alert">{error}</div> : null}
    <div className="bank-layout">
      <aside className="bank-chapters" aria-label="题库章节"><button className={chapter === 'all' ? 'active' : ''} aria-pressed={chapter === 'all'} onClick={() => setChapter('all')}><span>全部章节</span><b>{catalog.questions.length}</b></button>
        {catalog.chapters.map(item => <button key={item.id} className={chapter === item.id ? 'active' : ''} aria-pressed={chapter === item.id} onClick={() => setChapter(item.id)}><span>{item.label}</span><b>{item.questionCount}</b></button>)}
      </aside>
      <div className="bank-results">
        <label className="bank-search"><Search size={17}/><span className="sr-only">搜索题目</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索题干、知识点或题号"/></label>
        <div className="bank-result-summary"><span>当前显示 {questions.length} 道题</span>{selected.size ? <button className="link-button" onClick={() => setSelected(new Set())}>清空已选</button> : null}</div>
        {questions.length ? <div className="bank-question-list">{questions.map(question => <QuestionCard key={question.questionId} question={question} selected={selected.has(question.questionId)} onToggle={toggle}/>)}</div>
          : <p className="bank-empty">当前章节没有匹配的题目，请调整搜索条件。</p>}
      </div>
    </div>
    <form className={`bank-selection-bar ${selected.size ? 'has-selection' : ''}`} onSubmit={createDraft}>
      <div><strong>已选 {selected.size} 道题</strong><span>{selected.size ? '按勾选顺序写入试卷草稿' : '请先从题库中勾选题目'}</span></div>
      <label><span className="sr-only">试卷标题</span><input value={title} onChange={event => setTitle(event.target.value)} maxLength={120} required placeholder="试卷标题"/></label>
      {selected.size ? <button type="button" className="bank-clear-selection" aria-label="清空已选题目" title="清空已选题目" onClick={() => setSelected(new Set())}><X size={17}/></button> : null}
      <button className="primary" type="submit" disabled={!selected.size || creating || !title.trim()}>{creating ? <><LoaderCircle className="spinning" size={16}/>正在创建…</> : '生成试卷草稿'}</button>
    </form>
  </section>;
}
