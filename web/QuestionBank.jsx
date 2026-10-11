import React, { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import { BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight, LoaderCircle, Plus, Search, ShoppingBasket, Upload, X } from 'lucide-react';
import { api, typeLabels } from './api.js';
import { MathText } from './MathText.jsx';

const PAGE_SIZE = 4;

function usableSourceRefs(question) {
  return (question.sourceRefs || []).filter(ref => !/^tutor-set(?:-|$)/i.test(ref.locator || ''));
}

function QuestionCard({ question, selected, onToggle }) {
  const sourceRefs = usableSourceRefs(question);
  const evidenceId = useId();
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const evidenceTriggerRef = useRef(null);

  function toggleEvidence() {
    const list = evidenceTriggerRef.current?.closest('.bank-question-list');
    const listScrollTop = list?.scrollTop;
    const pageScroll = { x: window.scrollX, y: window.scrollY };
    setEvidenceOpen(open => !open);
    requestAnimationFrame(() => {
      const restoreScroll = () => {
        if (list && listScrollTop !== undefined) list.scrollTop = listScrollTop;
        window.scrollTo(pageScroll.x, pageScroll.y);
      };
      restoreScroll();
      requestAnimationFrame(restoreScroll);
    });
  }

  return <article className={`bank-question ${selected ? 'is-selected' : ''}`}>
    <button type="button" className="bank-question-add" aria-pressed={selected} aria-label={selected ? '从组卷篮移出此题' : '将此题加入组卷篮'} onClick={() => onToggle(question.questionId)}>
      {selected ? <><Check size={14}/>已加入</> : <><Plus size={14}/>加入组卷篮</>}
    </button>
    <div className="bank-question-body">
      <p className="bank-question-stem"><MathText text={question.student.stem}/></p>
      {question.student.options.length ? <div className="bank-question-options">{question.student.options.map(option =>
        <p key={option.label}><span>{option.label}.</span><MathText text={option.text}/></p>)}</div> : null}
      {question.student.parts.length ? <div className="bank-question-parts">{question.student.parts.map((part, index) =>
        <p key={part.partId}><span>（{index + 1}）</span><MathText text={part.prompt}/></p>)}</div> : null}
      <div className="bank-question-information">
        <div className="bank-question-information-line">
          <span className="bank-question-type">{typeLabels[question.questionType] ?? question.questionType}</span>
          <span>{question.topics.join('、') || question.taskSummary}</span>
          <span>{sourceRefs[0]?.locator || '题库收录'}</span>
          <button ref={evidenceTriggerRef} type="button" className="bank-question-evidence-trigger" aria-expanded={evidenceOpen} aria-controls={evidenceId} onPointerDown={event => event.preventDefault()} onClick={toggleEvidence}>
            <ChevronRight size={13}/><span>知识与来源信息</span>
          </button>
        </div>
        {evidenceOpen ? <dl id={evidenceId} className="bank-question-evidence-panel"><dt>考查摘要</dt><dd>{question.taskSummary}</dd><dt>相关知识</dt><dd>{question.requiredKnowledge.join('、') || '未单独标注'}</dd><dt>来源定位</dt><dd>{sourceRefs.length ? sourceRefs.map(ref => `${ref.locator}${ref.pages?.length ? `（${ref.pages.join('、')} 页）` : ''}`).join('；') : '题库收录'}</dd></dl> : null}
      </div>
    </div>
  </article>;
}

function catalogueStats(textbooks) {
  return textbooks.reduce((totals, textbook) => {
    totals.chapters += textbook.chapters.length;
    totals.sections += textbook.chapters.reduce((sum, chapter) => sum + chapter.sections.length, 0);
    return totals;
  }, { textbooks: textbooks.length, chapters: 0, sections: 0 });
}

function firstSectionId(textbooks) {
  const sections = textbooks.flatMap(textbook => textbook.chapters.flatMap(chapter => chapter.sections));
  return (sections.find(section => section.questionCount > 0) || sections[0])?.id || null;
}

function initialCollapsedBranches(textbooks, selectedSectionId) {
  const collapsed = new Set();
  textbooks.forEach((textbook, textbookIndex) => {
    if (textbookIndex > 0) collapsed.add(treeKey('textbook', textbook.id));
    textbook.chapters.forEach(chapter => {
      if (!chapter.sections.some(section => section.id === selectedSectionId)) collapsed.add(treeKey('chapter', chapter.id));
    });
  });
  return collapsed;
}

function findSection(textbooks, sectionId) {
  for (const textbook of textbooks) {
    for (const chapter of textbook.chapters) {
      const section = chapter.sections.find(item => item.id === sectionId);
      if (section) return { textbook, chapter, section };
    }
  }
  return null;
}

function treeKey(kind, id) {
  return `${kind}:${id}`;
}

function sectionLocations(textbooks) {
  const locations = new Map();
  textbooks.forEach(textbook => textbook.chapters.forEach(chapter => chapter.sections.forEach(section => {
    locations.set(section.id, { textbook: textbook.label, chapter: chapter.label, section: section.label });
  })));
  return locations;
}

function SelectionBasket({ questions, locations, selectedOrigins, title, creating, open, onTitleChange, onRemove, onClear, onClose, onSubmit }) {
  const closeButtonRef = useRef(null);
  const basketRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const root = document.documentElement;
    const body = document.body;
    const previousRootOverflow = root.style.overflow;
    const previousBodyOverflow = body.style.overflow;
    const previousBodyPaddingRight = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - root.clientWidth;
    const bodyPaddingRight = Number.parseFloat(window.getComputedStyle(body).paddingRight) || 0;

    root.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) body.style.paddingRight = `${bodyPaddingRight + scrollbarWidth}px`;

    const focusFrame = requestAnimationFrame(() => closeButtonRef.current?.focus());
    const keepFocusInside = event => {
      if (event.key !== 'Tab') return;
      const focusable = [...basketRef.current.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', keepFocusInside);
    return () => {
      cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', keepFocusInside);
      root.style.overflow = previousRootOverflow;
      body.style.overflow = previousBodyOverflow;
      body.style.paddingRight = previousBodyPaddingRight;
    };
  }, [open]);

  return <>
    {open ? <button type="button" className="bank-basket-backdrop" aria-label="关闭组卷篮" onClick={onClose}/> : null}
    <aside ref={basketRef} className={`bank-basket ${open ? 'is-open' : ''}`} aria-label="组卷篮">
      <div className="bank-basket-heading">
        <div><span className="bank-basket-icon"><ShoppingBasket size={18}/>{questions.length ? <b>{questions.length}</b> : null}</span><div><strong>组卷篮</strong><span aria-live="polite">已选 {questions.length} 道题</span></div></div>
        <button ref={closeButtonRef} type="button" className="bank-basket-close" aria-label="关闭组卷篮" onClick={onClose}><X size={18}/></button>
      </div>
      <div className="bank-basket-list">
        {questions.length ? questions.map((question, index) => {
          const location = locations.get(selectedOrigins.get(question.questionId) || (question.sectionIds ?? question.chapters)[0]);
          const sourceRefs = usableSourceRefs(question);
          return <article className="bank-basket-item" key={question.questionId}>
            <div className="bank-basket-item-heading"><span>{index + 1}</span><strong>{typeLabels[question.questionType] ?? question.questionType}</strong><button type="button" aria-label={`移除第 ${index + 1} 题`} title="移出组卷篮" onClick={() => onRemove(question.questionId)}><X size={15}/></button></div>
            <div className="bank-basket-question">
              <p className="bank-basket-stem"><MathText text={question.student.stem}/></p>
              {question.student.options.length ? <div className="bank-basket-options">{question.student.options.map(option => <p key={option.label}><span>{option.label}.</span><MathText text={option.text}/></p>)}</div> : null}
              {question.student.parts.length ? <div className="bank-basket-parts">{question.student.parts.map((part, partIndex) => <p key={part.partId}><span>（{partIndex + 1}）</span><MathText text={part.prompt}/></p>)}</div> : null}
            </div>
            <dl className="bank-basket-detail">
              <dt>章节</dt><dd>{location ? `${location.textbook} / ${location.chapter} / ${location.section}` : '题库题目'}</dd>
              <dt>考查</dt><dd>{question.taskSummary}</dd>
              <dt>知识</dt><dd>{question.requiredKnowledge.join('、') || question.topics.join('、') || '未单独标注'}</dd>
              <dt>来源</dt><dd>{sourceRefs.length ? [...new Set(sourceRefs.map(ref => ref.locator))].join('；') : '题库收录'}</dd>
            </dl>
          </article>;
        }) : <div className="bank-basket-empty"><ShoppingBasket size={22}/><strong>还没有选择题目</strong><span>从题目卡片加入组卷篮，题目会保留在这里。</span></div>}
      </div>
      <form className="bank-basket-actions" onSubmit={onSubmit}>
        <label><span>试卷标题</span><input value={title} onChange={event => onTitleChange(event.target.value)} maxLength={120} required placeholder="例如：集合单元练习"/></label>
        {questions.length ? <button type="button" className="bank-basket-clear" onClick={onClear}>清空组卷篮</button> : null}
        <button className="primary" type="submit" disabled={!questions.length || creating || !title.trim()}>{creating ? <><LoaderCircle className="spinning" size={16}/>正在创建…</> : `生成试卷草稿${questions.length ? `（${questions.length}）` : ''}`}</button>
      </form>
    </aside>
  </>;
}

function ChapterTree({ textbooks, activeId, collapsed, onToggleBranch, onSelect }) {
  const treeRef = useRef(null);
  const defaultFocusKey = activeId ? treeKey('section', activeId) : treeKey('textbook', textbooks[0]?.id || '');
  const [focusKey, setFocusKey] = useState(defaultFocusKey);
  const stats = catalogueStats(textbooks);

  useEffect(() => {
    if (activeId) setFocusKey(treeKey('section', activeId));
  }, [activeId]);

  function focusItem(key) {
    if (!key) return;
    setFocusKey(key);
    requestAnimationFrame(() => treeRef.current?.querySelector(`[data-tree-key="${CSS.escape(key)}"]`)?.focus());
  }

  function handleKeyDown(event) {
    const item = event.target.closest('[role="treeitem"]');
    if (!item || !treeRef.current?.contains(item)) return;
    const visible = [...treeRef.current.querySelectorAll('[role="treeitem"]')];
    const index = visible.indexOf(item);
    const key = item.dataset.treeKey;
    if (event.key === 'ArrowDown') { event.preventDefault(); focusItem(visible[index + 1]?.dataset.treeKey || key); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); focusItem(visible[index - 1]?.dataset.treeKey || key); }
    else if (event.key === 'Home') { event.preventDefault(); focusItem(visible[0]?.dataset.treeKey); }
    else if (event.key === 'End') { event.preventDefault(); focusItem(visible.at(-1)?.dataset.treeKey); }
    else if (event.key === 'ArrowRight' && item.hasAttribute('aria-expanded')) {
      event.preventDefault();
      if (item.getAttribute('aria-expanded') === 'false') onToggleBranch(item.dataset.branchKey);
      else focusItem(visible[index + 1]?.dataset.treeKey || key);
    } else if (event.key === 'ArrowLeft') {
      const parentKey = item.dataset.parentKey;
      if (item.getAttribute('aria-expanded') === 'true') { event.preventDefault(); onToggleBranch(item.dataset.branchKey); }
      else if (parentKey) { event.preventDefault(); focusItem(parentKey); }
    }
  }

  return <aside className="bank-tree-panel" aria-label="教材章节目录">
    <div className="bank-tree-heading"><div><strong>教材目录</strong><span>{stats.textbooks} 册 · {stats.chapters} 章 · {stats.sections} 节</span></div></div>
    <div className="bank-tree" role="tree" aria-label="教材章节树" ref={treeRef} onKeyDown={handleKeyDown}>
      {textbooks.map(textbook => {
        const textbookKey = treeKey('textbook', textbook.id);
        const textbookExpanded = !collapsed.has(textbookKey);
        return <div className="bank-tree-book" key={textbook.id} role="none">
          <button type="button" className="bank-tree-parent bank-tree-book-button" role="treeitem" aria-level="1" aria-expanded={textbookExpanded}
            data-tree-key={textbookKey} data-branch-key={textbookKey} tabIndex={focusKey === textbookKey ? 0 : -1}
            onFocus={() => setFocusKey(textbookKey)} onClick={() => onToggleBranch(textbookKey)}>
            {textbookExpanded ? <ChevronDown size={16}/> : <ChevronRight size={16}/>}<span><strong>{textbook.label}</strong>{textbook.title && textbook.title !== textbook.label ? <small>{textbook.title.replace(textbook.label, '').trim()}</small> : null}</span><b>{textbook.chapters.length} 章</b>
          </button>
          {textbookExpanded ? <div className="bank-tree-chapters" role="group">
            {textbook.chapters.map(chapter => {
              const chapterKey = treeKey('chapter', chapter.id);
              const chapterExpanded = !collapsed.has(chapterKey);
              return <div className="bank-tree-group" key={chapter.id} role="none">
                <button type="button" className="bank-tree-parent bank-tree-chapter-button" role="treeitem" aria-level="2" aria-expanded={chapterExpanded}
                  data-tree-key={chapterKey} data-parent-key={textbookKey} data-branch-key={chapterKey} tabIndex={focusKey === chapterKey ? 0 : -1}
                  onFocus={() => setFocusKey(chapterKey)} onClick={() => onToggleBranch(chapterKey)}>
                  {chapterExpanded ? <ChevronDown size={15}/> : <ChevronRight size={15}/>}<span>{chapter.label}</span><b>{chapter.sections.length} 节</b>
                </button>
                {chapterExpanded ? <div className="bank-tree-children" role="group">
                  {chapter.sections.map(section => {
                    const sectionKey = treeKey('section', section.id);
                    return <button type="button" key={section.id} role="treeitem" aria-level="3" aria-selected={section.id === activeId}
                      data-tree-key={sectionKey} data-parent-key={chapterKey} tabIndex={focusKey === sectionKey ? 0 : -1}
                      className={section.id === activeId ? 'active' : ''} onFocus={() => setFocusKey(sectionKey)} onClick={() => onSelect(section.id)}>
                      <span>{section.label}</span><b aria-label={`${section.questionCount} 道题`}>{section.questionCount}</b>
                    </button>
                  })}
                </div> : null}
              </div>
            })}
          </div> : null}
        </div>;
      })}
    </div>
  </aside>;
}

export function QuestionBank({ onCreated, onImport }) {
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sectionId, setSectionId] = useState(null);
  const [collapsedBranches, setCollapsedBranches] = useState(() => new Set());
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase('zh-CN'));
  const [selected, setSelected] = useState(() => new Set());
  const [selectedOrigins, setSelectedOrigins] = useState(() => new Map());
  const [title, setTitle] = useState('题库手动组卷');
  const [creating, setCreating] = useState(false);
  const [page, setPage] = useState(1);
  const [basketOpen, setBasketOpen] = useState(false);
  const basketTriggerRef = useRef(null);
  const questionListRef = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    api('/api/question-bank', undefined, controller.signal)
      .then(result => {
        const nextTextbooks = result.textbooks || [];
        const initialSection = firstSectionId(nextTextbooks);
        setCatalog(result);
        setSectionId(current => current || initialSection);
        setCollapsedBranches(initialCollapsedBranches(nextTextbooks, initialSection));
      })
      .catch(failure => { if (failure.name !== 'AbortError') setError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  const textbooks = catalog?.textbooks || [];
  const locations = useMemo(() => sectionLocations(textbooks), [textbooks]);
  const active = useMemo(() => findSection(textbooks, sectionId), [textbooks, sectionId]);
  const questions = useMemo(() => {
    if (!catalog || !sectionId) return [];
    return catalog.questions.filter(question => {
      if (!(question.sectionIds ?? question.chapters).includes(sectionId)) return false;
      if (!deferredQuery) return true;
      return [question.taskSummary, question.student.stem, ...question.topics, ...question.requiredKnowledge]
        .join(' ').toLocaleLowerCase('zh-CN').includes(deferredQuery);
    });
  }, [catalog, sectionId, deferredQuery]);
  const pageCount = Math.max(1, Math.ceil(questions.length / PAGE_SIZE));
  const visibleQuestions = questions.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const selectedQuestions = useMemo(() => {
    if (!catalog) return [];
    const byId = new Map(catalog.questions.map(question => [question.questionId, question]));
    return [...selected].map(questionId => byId.get(questionId)).filter(Boolean);
  }, [catalog, selected]);

  useEffect(() => { setPage(1); }, [sectionId, deferredQuery]);
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);
  useEffect(() => {
    const scrollFrame = requestAnimationFrame(() => {
      if (questionListRef.current) questionListRef.current.scrollTop = 0;
    });
    return () => cancelAnimationFrame(scrollFrame);
  }, [page, sectionId, deferredQuery]);
  useEffect(() => {
    if (!basketOpen) return undefined;
    const closeOnEscape = event => { if (event.key === 'Escape') closeBasket(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [basketOpen]);

  function toggle(questionId) {
    const removing = selected.has(questionId);
    setSelected(current => {
      const next = new Set(current);
      if (removing) next.delete(questionId); else next.add(questionId);
      return next;
    });
    setSelectedOrigins(origins => {
      const nextOrigins = new Map(origins);
      if (removing) nextOrigins.delete(questionId); else nextOrigins.set(questionId, sectionId);
      return nextOrigins;
    });
  }

  function closeBasket() {
    setBasketOpen(false);
    requestAnimationFrame(() => basketTriggerRef.current?.focus());
  }

  function clearSelection() {
    if (selected.size && !window.confirm(`确定清空组卷篮中的 ${selected.size} 道题吗？`)) return;
    setSelected(new Set());
    setSelectedOrigins(new Map());
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
  const stats = catalogueStats(textbooks);
  return <section className="question-bank-page">
    <div className="question-bank-heading"><div><h1>题库</h1><p>按教材章节浏览题目，加入组卷篮后生成试卷草稿。</p></div>
      <div className="bank-heading-actions">
        <span className="bank-catalog-total">{stats.textbooks} 册教材 · {stats.chapters} 章 · {stats.sections} 节 · {catalog.totals.ready} 道可用题</span>
        <button ref={basketTriggerRef} type="button" className="bank-basket-trigger" aria-label={`打开组卷篮，已选 ${selected.size} 道题`} aria-expanded={basketOpen} onClick={() => setBasketOpen(true)}><ShoppingBasket size={17}/><span>组卷篮</span><b>{selected.size}</b></button>
        <button type="button" className="bank-import-link" onClick={onImport}><Upload size={16}/>上传试卷</button>
      </div>
    </div>
    {error ? <div className="notice error" role="alert">{error}</div> : null}
    <div className="bank-browser">
      <ChapterTree textbooks={textbooks} activeId={sectionId} collapsed={collapsedBranches}
        onToggleBranch={branchId => setCollapsedBranches(current => {
          const next = new Set(current);
          if (next.has(branchId)) next.delete(branchId); else next.add(branchId);
          return next;
        })}
        onSelect={nextSectionId => { setSectionId(nextSectionId); setQuery(''); }}/>
      <main className="bank-results-panel">
        {active ? <>
          <div className="bank-results-heading"><div><p>{active.textbook.title || active.textbook.label} / {active.chapter.label}</p><h2>{active.section.label}</h2></div><strong>{active.section.questionCount} 道题</strong></div>
          <div className="bank-results">
            <label className="bank-search"><Search size={17}/><span>搜索本小节</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="题干或知识点"/></label>
            <div className="bank-result-summary"><span>{deferredQuery ? `找到 ${questions.length} 道题` : `共 ${questions.length} 道题`}</span><span>{selected.size ? `组卷篮已有 ${selected.size} 道` : '悬浮题目即可加入组卷篮'}</span></div>
            {visibleQuestions.length ? <div ref={questionListRef} className="bank-question-list" aria-label="题目列表">{visibleQuestions.map(question => <QuestionCard key={question.questionId} question={question} selected={selected.has(question.questionId)} onToggle={toggle}/>)}</div>
              : <div className="bank-empty"><strong>{deferredQuery ? '没有找到匹配题目' : '本小节暂无题目'}</strong><span>{deferredQuery ? '可尝试更换关键词。' : '目录已收录，后续导入的题目会显示在这里。'}</span></div>}
            {pageCount > 1 ? <nav className="bank-pagination" aria-label="题目分页"><button type="button" disabled={page === 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={16}/>上一页</button><span>第 {page} / {pageCount} 页</span><button type="button" disabled={page === pageCount} onClick={() => setPage(value => value + 1)}>下一页<ChevronRight size={16}/></button></nav> : null}
          </div>
        </> : <div className="bank-results-empty"><BookOpen size={24}/><h2>选择一个小节</h2><p>题目将显示在这里。</p></div>}
      </main>
      <SelectionBasket questions={selectedQuestions} locations={locations} selectedOrigins={selectedOrigins} title={title} creating={creating} open={basketOpen}
        onTitleChange={setTitle} onRemove={toggle} onClear={clearSelection} onClose={closeBasket} onSubmit={createDraft}/>
    </div>
  </section>;
}
