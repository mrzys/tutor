import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight, LoaderCircle, Plus, Search, ShoppingBasket, Upload, X } from 'lucide-react';
import { api, typeLabels } from './api.js';
import { MathText } from './MathText.jsx';
import { Select } from './Select.jsx';
import { QuestionOptions } from './QuestionOptions.jsx';
import { questionSource, sourceCaption } from '../src/question-bank/source-label.mjs';
import { availableTextbooks } from '../src/curriculum/availability.mjs';
import './QuestionBank.css';

const PAGE_SIZE = 12;
const SESSION_KEY = 'tutor-question-bank:v1';
const EMPTY_TEXTBOOKS = [];
function readSession() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    if (saved?.version !== 1 || !Array.isArray(saved.questions) || !Array.isArray(saved.origins)) return {};
    if (typeof saved.query !== 'string' || typeof saved.title !== 'string') return {};
    if (!saved.origins.every(entry => Array.isArray(entry) && entry.length === 2)) return {};
    return saved;
  } catch { return {}; }
}

function usableSourceRefs(question) {
  return (question.sourceRefs || []).filter(ref => !/^tutor-set(?:-|$)/i.test(ref.locator || ''));
}

function QuestionCard({ question, selected, disabled, onToggle }) {
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
    <div className="bank-question-body">
      <p className="bank-question-stem"><MathText text={question.student.stem}/></p>
      {question.student.options.length ? <div className="bank-question-options"><QuestionOptions options={question.student.options}/></div> : null}
      {question.student.parts.length ? <div className="bank-question-parts">{question.student.parts.map((part, index) =>
        <p key={part.partId}><span>（{index + 1}）</span><span className="bank-part-prompt"><MathText text={part.prompt}/></span></p>)}</div> : null}
      <div className="bank-question-information">
        <div className="bank-question-information-line">
          <span className="bank-question-type">{typeLabels[question.questionType] ?? question.questionType}</span>
          <span><MathText text={question.topics.join('、') || question.taskSummary}/></span>
          <span>{sourceCaption(questionSource(question))}</span>
          <button ref={evidenceTriggerRef} type="button" className="bank-question-evidence-trigger" aria-expanded={evidenceOpen} aria-controls={evidenceId} onPointerDown={event => event.preventDefault()} onClick={toggleEvidence}>
            <ChevronRight size={13}/><span>知识与来源信息</span>
          </button>
          <button type="button" className="bank-question-add" disabled={disabled} aria-pressed={selected} aria-label={selected ? '从组卷篮移出此题' : '将此题加入组卷篮'} onClick={() => onToggle(question.questionId)}>
            {selected ? <><Check size={14}/>已加入 · 移出</> : <><Plus size={14}/>加入组卷篮</>}
          </button>
        </div>
        {evidenceOpen ? <dl id={evidenceId} className="bank-question-evidence-panel"><dt>考查摘要</dt><dd><MathText text={question.taskSummary}/></dd><dt>相关知识</dt><dd>{question.requiredKnowledge.join('、') || '未单独标注'}</dd><dt>来源定位</dt><dd>{sourceRefs.length ? sourceRefs.map(ref => `${ref.locator}${ref.pages?.length ? `（${ref.pages.join('、')} 页）` : ''}`).join('；') : '题库收录'}</dd></dl> : null}
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
  return sections[0]?.id || null;
}

function initialCollapsedBranches(textbooks, selectedSectionId) {
  const collapsed = new Set();
  textbooks.forEach((textbook, textbookIndex) => {
    if (textbookIndex > 0 && !textbook.chapters.some(chapter => chapter.sections.some(section => section.id === selectedSectionId))) collapsed.add(treeKey('textbook', textbook.id));
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

function SelectionBasket({ questions, locations, selectedOrigins, title, creating, error, open, onTitleChange, onRemove, onClear, onClose, onSubmit }) {
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
    <aside ref={basketRef} className={`bank-basket ${open ? 'is-open' : ''}`} role="dialog" aria-modal={open || undefined} aria-hidden={!open} aria-label="组卷篮">
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
              {question.student.options.length ? <div className="bank-basket-options"><QuestionOptions options={question.student.options}/></div> : null}
              {question.student.parts.length ? <div className="bank-basket-parts">{question.student.parts.map((part, partIndex) => <p key={part.partId}><span>（{partIndex + 1}）</span><MathText text={part.prompt}/></p>)}</div> : null}
            </div>
            <dl className="bank-basket-detail">
              <dt>章节</dt><dd>{location ? `${location.textbook} / ${location.chapter} / ${location.section}` : '题库题目'}</dd>
              <dt>考查</dt><dd><MathText text={question.taskSummary}/></dd>
              <dt>知识</dt><dd>{question.requiredKnowledge.join('、') || question.topics.join('、') || '未单独标注'}</dd>
              <dt>来源</dt><dd>{sourceCaption(questionSource(question))}</dd>
            </dl>
          </article>;
        }) : <div className="bank-basket-empty"><ShoppingBasket size={22}/><strong>还没有选择题目</strong><span>从题目卡片加入组卷篮，题目会保留在这里。</span></div>}
      </div>
      <form className="bank-basket-actions" onSubmit={onSubmit}>
        {error ? <p className="bank-create-error" role="alert">{error}</p> : null}
        <label><span>试卷标题</span><input value={title} onChange={event => onTitleChange(event.target.value)} maxLength={120} required placeholder="例如：集合单元练习"/></label>
        {questions.length ? <button type="button" className="bank-basket-clear" onClick={onClear}>清空组卷篮</button> : null}
        <button className="primary" type="submit" disabled={!questions.length || creating || !title.trim()}>{creating ? <><LoaderCircle className="spinning" size={16}/>正在创建…</> : `生成试卷草稿${questions.length ? `（${questions.length}）` : ''}`}</button>
      </form>
    </aside>
  </>;
}

function ChapterTree({ textbooks, activeId, collapsed, onToggleBranch, onSelect }) {
  const treeRef = useRef(null);
  const treeId = useId();
  const mobileToggleRef = useRef(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const activeLabel = findSection(textbooks, activeId)?.section.label || '选择教材小节';
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
    <button type="button" ref={mobileToggleRef} className="bank-tree-mobile-toggle" aria-expanded={mobileOpen} aria-controls={treeId} onClick={() => setMobileOpen(open => !open)}><BookOpen size={17}/><span>{activeLabel}</span><ChevronDown size={16}/></button>
    <div className="bank-tree-heading"><div><strong>教材目录</strong><span>{stats.textbooks} 册 · {stats.chapters} 章 · {stats.sections} 节</span></div></div>
    <div className="bank-tree" id={treeId} data-mobile-open={mobileOpen} role="tree" aria-label="教材章节树" ref={treeRef} onKeyDown={handleKeyDown}>
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
                      className={section.id === activeId ? 'active' : ''} onFocus={() => setFocusKey(sectionKey)} onClick={() => { onSelect(section.id); setMobileOpen(false); if (window.matchMedia('(max-width: 760px)').matches) requestAnimationFrame(() => mobileToggleRef.current?.focus({ preventScroll: true })); }}>
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
  const [saved] = useState(readSession);
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [createError, setCreateError] = useState('');
  // Resolve saved navigation against the currently open curriculum before querying it.
  const [sectionId, setSectionId] = useState(null);
  const [collapsedBranches, setCollapsedBranches] = useState(() => new Set());
  const [query, setQuery] = useState(saved.query || '');
  const [debouncedQuery, setDebouncedQuery] = useState((saved.query || '').trim());
  const [questionType, setQuestionType] = useState(saved.questionType || 'all');
  const [difficulty, setDifficulty] = useState(saved.difficulty || '');
  const [ability, setAbility] = useState(saved.ability || '');
  const [literacy, setLiteracy] = useState(saved.literacy || '');
  const [selected, setSelected] = useState(() => new Map((saved.questions || []).filter(question => question?.questionId && question.student).map(question => [question.questionId, question])));
  const [selectedOrigins, setSelectedOrigins] = useState(() => new Map(saved.origins || []));
  const [title, setTitle] = useState(saved.title || '题库手动组卷');
  const [creating, setCreating] = useState(false);
  const [page, setPage] = useState(Math.max(1, Number(saved.page) || 1));
  const [retry, setRetry] = useState(0);
  const [basketOpen, setBasketOpen] = useState(false);
  const basketTriggerRef = useRef(null);
  const questionListRef = useRef(null);
  const initialized = useRef(false);
  const requestSequence = useRef(0);
  const created = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      const next = query.trim();
      if (next !== debouncedQuery) { setPage(1); setDebouncedQuery(next); }
    }, 250);
    return () => clearTimeout(timer);
  }, [query, debouncedQuery]);

  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++requestSequence.current;
    let needsSectionQuery = false;
    setLoading(true); setError('');
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    for (const [key, value] of Object.entries({ difficulty, ability, literacy })) if (value) params.set(key, value);
    if (sectionId) params.set('sectionId', sectionId);
    if (debouncedQuery) params.set('query', debouncedQuery);
    if (questionType !== 'all') params.set('questionType', questionType);
    api(`/api/question-bank?${params}`, undefined, controller.signal)
      .then(result => {
        if (controller.signal.aborted || requestSequence.current !== sequence) return;
        const nextTextbooks = availableTextbooks(result.textbooks || []);
        const requestedSection = sectionId || (!initialized.current ? saved.sectionId : null);
        const nextSection = findSection(nextTextbooks, requestedSection) ? requestedSection : firstSectionId(nextTextbooks);
        needsSectionQuery = nextSection !== sectionId;
        setCatalog({ ...result, textbooks: nextTextbooks,
          // The initial catalogue response is unscoped; never display those results under a section heading.
          ...(needsSectionQuery ? { questions: [], pagination: { page: 1, total: 0, totalPages: 1 } } : {}) });
        if (!initialized.current) {
          initialized.current = true;
          setCollapsedBranches(initialCollapsedBranches(nextTextbooks, nextSection));
        }
        if (nextSection !== sectionId) { setLoading(true); setSectionId(nextSection); setPage(1); }
        else if (result.pagination?.page && result.pagination.page !== page) setPage(result.pagination.page);
      })
      .catch(failure => { if (!controller.signal.aborted && requestSequence.current === sequence) setError(failure.message); })
      .finally(() => { if (!controller.signal.aborted && requestSequence.current === sequence && !needsSectionQuery) setLoading(false); });
    return () => controller.abort();
  }, [sectionId, debouncedQuery, questionType, difficulty, ability, literacy, page, retry]);

  useEffect(() => {
    if (created.current) return;
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ version: 1, sectionId, query, questionType, difficulty, ability, literacy, page, title, questions: [...selected.values()], origins: [...selectedOrigins] })); } catch { /* Session storage may be unavailable or full; keep this session usable. */ }
  }, [sectionId, query, questionType, difficulty, ability, literacy, page, title, selected, selectedOrigins]);

  const textbooks = catalog?.textbooks || EMPTY_TEXTBOOKS;
  const locations = useMemo(() => sectionLocations(textbooks), [textbooks]);
  const active = useMemo(() => findSection(textbooks, sectionId), [textbooks, sectionId]);
  const visibleQuestions = catalog?.questions || [];
  const pagination = catalog?.pagination || { page, total: visibleQuestions.length, totalPages: 1 };
  const pageCount = Math.max(1, pagination.totalPages);
  const hasFilters = !!(debouncedQuery || questionType !== 'all' || difficulty || ability || literacy);
  const filterOptions = catalog?.filterOptions || { difficulty: [], abilities: [], literacies: [] };
  const selectedQuestions = useMemo(() => [...selected.values()], [selected]);
  const selectedDimensions = [
    { key: 'difficulty', value: difficulty, label: '难度', options: filterOptions.difficulty, clear: () => setDifficulty('') },
    { key: 'ability', value: ability, label: '能力', options: filterOptions.abilities, clear: () => setAbility('') },
    { key: 'literacy', value: literacy, label: '素养', options: filterOptions.literacies, clear: () => setLiteracy('') },
  ].filter(dimension => dimension.value);

  useEffect(() => {
    const frame = requestAnimationFrame(() => { if (questionListRef.current) questionListRef.current.scrollTop = 0; });
    return () => cancelAnimationFrame(frame);
  }, [page, sectionId, debouncedQuery, questionType, difficulty, ability, literacy]);
  useEffect(() => {
    if (!basketOpen) return undefined;
    const closeOnEscape = event => { if (event.key === 'Escape' && !document.querySelector('.tutor-select-popup')) closeBasket(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [basketOpen]);

  function toggle(questionId) {
    if (creating) return;
    const removing = selected.has(questionId);
    const question = visibleQuestions.find(item => item.questionId === questionId);
    if (!removing && !question) return;
    setSelected(current => {
      const next = new Map(current);
      if (removing) next.delete(questionId); else next.set(questionId, question);
      return next;
    });
    setSelectedOrigins(origins => {
      const next = new Map(origins);
      if (removing) next.delete(questionId); else next.set(questionId, sectionId);
      return next;
    });
    setCreateError('');
  }

  function closeBasket() { setBasketOpen(false); requestAnimationFrame(() => basketTriggerRef.current?.focus()); }
  function clearSelection() {
    if (creating || (selected.size && !window.confirm(`确定清空组卷篮中的 ${selected.size} 道题吗？`))) return;
    setSelected(new Map()); setSelectedOrigins(new Map()); setCreateError('');
  }
  function clearFilters() { setQuery(''); setDebouncedQuery(''); setQuestionType('all'); setDifficulty(''); setAbility(''); setLiteracy(''); setPage(1); }

  async function createDraft(event) {
    event.preventDefault();
    if (!selected.size || creating) return;
    setCreating(true); setCreateError('');
    try {
      const selections = [...selected.values()].map(question => ({ questionId: question.questionId, contentVersion: question.contentVersion, teacherVersion: question.teacherVersion }));
      const result = await api('/api/question-bank/manual-draft', { title: title.trim(), selections });
      created.current = true;
      try { sessionStorage.removeItem(SESSION_KEY); } catch { /* The saved draft is already in the database. */ }
      onCreated(result.draft);
    } catch (failure) { setCreateError(failure.message); }
    finally { setCreating(false); }
  }

  if (!catalog && loading) return <section className="question-bank-page"><p className="bank-status" role="status"><LoaderCircle className="spinning" size={18}/>正在读取题库…</p></section>;
  if (!catalog) return <section className="question-bank-page"><div className="notice error" role="alert"><p>{error || '题库暂时无法读取。'}</p><button onClick={() => setRetry(value => value + 1)}>重新加载题库</button></div></section>;
  const stats = catalogueStats(textbooks);
  return <section className="question-bank-page">
    <div className="question-bank-heading"><div><h1>题库</h1><p>按教材章节浏览，选好题目后直接生成草稿。</p></div>
      <div className="bank-heading-actions">
        <span className="bank-catalog-total">已开放 {stats.chapters} 章 · {catalog.totals.ready} 道可用题</span>
        <button ref={basketTriggerRef} type="button" className="bank-basket-trigger" aria-label={`打开组卷篮，已选 ${selected.size} 道题`} aria-expanded={basketOpen} onClick={() => setBasketOpen(true)}><ShoppingBasket size={17}/><span>组卷篮</span><b>{selected.size}</b></button>
        <button type="button" className="bank-import-link" onClick={onImport}><Upload size={16}/>上传试卷</button>
      </div>
    </div>
    {error ? <div className="notice error" role="alert">{error}<button onClick={() => setRetry(value => value + 1)}>重试</button></div> : null}
    <div className="bank-browser">
      <ChapterTree textbooks={textbooks} activeId={sectionId} collapsed={collapsedBranches}
        onToggleBranch={branchId => setCollapsedBranches(current => { const next = new Set(current); if (next.has(branchId)) next.delete(branchId); else next.add(branchId); return next; })}
        onSelect={nextSectionId => { setSectionId(nextSectionId); setPage(1); }}/>
      <div className="bank-results-panel">
        {active ? <>
          <div className="bank-results-heading"><div><p>{active.textbook.title || active.textbook.label} / {active.chapter.label}</p><h2>{active.section.label}</h2></div><strong>{active.section.questionCount} 道题</strong></div>
          <div className="bank-results">
            <div className="bank-filter-row"><label className="bank-search"><Search size={17}/><span className="sr-only">搜索本小节</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索本小节题干、知识点或题号"/></label>
              <Select value={questionType} aria-label="筛选题型" onChange={event => { setQuestionType(event.target.value); setPage(1); }}><option value="all">全部题型</option>{Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select>
              <Select value={difficulty} aria-label="筛选难度" onChange={event => { setDifficulty(event.target.value); setPage(1); }}><option value="">全部难度</option>{filterOptions.difficulty.map(item => <option key={item.value} value={item.value}>{item.label} · {item.count}</option>)}</Select>
            </div>
            <details className="bank-more-filters">
              <summary>更多筛选{ability || literacy ? <span>已选 {[ability, literacy].filter(Boolean).length} 项</span> : null}<ChevronDown size={14}/></summary>
              <div className="bank-dimension-filters" aria-label="教学维度筛选">
              <Select value={ability} aria-label="筛选能力" onChange={event => { setAbility(event.target.value); setPage(1); }}><option value="">全部能力</option>{filterOptions.abilities.map(item => <option key={item.value} value={item.value}>{item.label} · {item.count}</option>)}</Select>
              <Select value={literacy} aria-label="筛选核心素养" onChange={event => { setLiteracy(event.target.value); setPage(1); }}><option value="">全部核心素养</option>{filterOptions.literacies.map(item => <option key={item.value} value={item.value}>{item.label} · {item.count}</option>)}</Select>
              </div>
            </details>
            {hasFilters ? <div className="bank-active-filters" aria-label="已选筛选条件">
              {selectedDimensions.map(dimension => <button key={dimension.key} type="button" className="bank-active-filter" onClick={() => { dimension.clear(); setPage(1); }} aria-label={`清除${dimension.label}筛选：${dimension.options.find(option => option.value === dimension.value)?.label || dimension.value}`}>
                <span>{dimension.label}：{dimension.options.find(option => option.value === dimension.value)?.label || dimension.value}</span><X size={13}/>
              </button>)}
              <button type="button" className="bank-reset-filters" onClick={clearFilters}>清除全部筛选</button>
            </div> : null}
            {(ability || literacy) ? <p className="bank-annotation-note">能力与素养按已有教研标注筛选，待复核标注仅供检索参考。</p> : difficulty === 'unknown' ? <p className="bank-annotation-note">这些题目尚无独立难度评估。</p> : null}
            <div className="bank-result-summary"><span role="status" aria-live="polite">{loading ? '正在查询…' : `共 ${pagination.total} 道匹配题`}</span><span>已选 {selected.size} 道 · 切换章节保留</span></div>
            {visibleQuestions.length ? <div ref={questionListRef} className="bank-question-list" aria-label="题目列表" aria-busy={loading}>{visibleQuestions.map(question => <QuestionCard key={question.questionId} question={question} selected={selected.has(question.questionId)} disabled={loading || creating} onToggle={toggle}/>)}</div>
              : <div className="bank-empty"><strong>{loading ? '正在查询题目…' : hasFilters ? '没有找到匹配题目' : '本小节暂无题目'}</strong><span>{hasFilters ? '可清除筛选条件，或切换其他小节。' : '可切换其他小节，或上传试卷补充题目。'}</span>{hasFilters ? <button onClick={clearFilters}>清除筛选</button> : onImport ? <button onClick={onImport}>上传试卷</button> : null}</div>}
            <nav className="bank-pagination" aria-label="题目分页"><button type="button" disabled={page === 1 || loading} onClick={() => setPage(value => value - 1)}><ChevronLeft size={16}/>上一页</button><span>第 {pagination.page || page} / {pageCount} 页</span><button type="button" disabled={page >= pageCount || loading} onClick={() => setPage(value => value + 1)}>下一页<ChevronRight size={16}/></button></nav>
          </div>
        </> : <div className="bank-results-empty"><BookOpen size={24}/><h2>选择一个小节</h2><p>题目将显示在这里。</p></div>}
      </div>
      <SelectionBasket questions={selectedQuestions} locations={locations} selectedOrigins={selectedOrigins} title={title} creating={creating} error={createError} open={basketOpen}
        onTitleChange={setTitle} onRemove={toggle} onClear={clearSelection} onClose={closeBasket} onSubmit={createDraft}/>
    </div>
  </section>;
}
