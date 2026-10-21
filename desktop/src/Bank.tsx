import { For, Show, batch, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Search, ShoppingBasket, Upload, X } from "lucide-solid";
import { request, typeIds, typeLabels, operationId } from "./bridge";
import { Busy, ErrorBanner } from "./ui";
import { BankNavigation } from "./BankNavigation";
import { BankBasket } from "./BankBasket";
import { BankQuestionCard } from "./BankQuestionCard";
import "./BankReading.css";

type FilterOption = { value: string; label: string; count?: number };
// Solid counterpart of the Web Select: same trigger, popup, search and keyboard
// behavior, scoped to the bank so other desktop forms keep their own controls.
function BankSelect(props: { value: string; label: string; options: FilterOption[]; onChange: (value: string) => void }) {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  const [position, setPosition] = createSignal<Record<string, string>>({});
  const id = createUniqueId();
  let trigger!: HTMLButtonElement;
  let popup!: HTMLDivElement;
  let searchInput!: HTMLInputElement;
  let list!: HTMLDivElement;
  const filtered = createMemo(() => props.options.filter(option => !query().trim() || option.label.toLocaleLowerCase().includes(query().trim().toLocaleLowerCase())));
  const label = () => {
    const option = props.options.find(option => option.value === props.value) || props.options[0];
    return option ? `${option.label}${option.count !== undefined ? ` · ${option.count}` : ""}` : "请选择";
  };
  function close(focus = true) { setOpen(false); if (focus) trigger.focus({ preventScroll: true }); }
  function show() {
    setQuery(""); setActive(Math.max(0, props.options.findIndex(option => option.value === props.value))); setOpen(true);
  }
  function choose(option?: FilterOption) { if (option) { props.onChange(option.value); close(); } }
  function keys(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === "Tab") close(false);
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const length = filtered().length;
      setActive(event.key === "Home" ? 0 : event.key === "End" ? length - 1 : length ? (active() + (event.key === "ArrowUp" ? -1 : 1) + length) % length : 0);
    } else if (event.key === "Enter" || (event.key === " " && event.target !== searchInput)) { event.preventDefault(); choose(filtered()[active()]); }
  }
  createEffect(() => {
    if (!open()) return;
    const update = () => {
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, 240), innerWidth - 24);
      const below = innerHeight - rect.bottom - 12, above = rect.top - 12;
      const upwards = below < 240 && above > below;
      setPosition({ left: `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`, width: `${width}px`, "max-height": `${Math.max(100, Math.min(380, upwards ? above - 6 : below - 6))}px`, ...(upwards ? { bottom: `${innerHeight - rect.top + 6}px` } : { top: `${rect.bottom + 6}px` }) });
    };
    const outside = (event: PointerEvent) => { if (!trigger.contains(event.target as Node) && !popup?.contains(event.target as Node)) close(false); };
    update();
    queueMicrotask(() => (props.options.length >= 8 ? searchInput : list)?.focus({ preventScroll: true }));
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    onCleanup(() => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); });
  });
  createEffect(() => { if (open()) popup?.querySelector(`[data-option-index="${active()}"]`)?.scrollIntoView({ block: "nearest" }); });
  return <span class="tutor-select">
    <button ref={trigger} type="button" class="tutor-select-trigger" role="combobox" aria-label={props.label} aria-haspopup="listbox" aria-expanded={open()} aria-controls={open() ? id : undefined} aria-activedescendant={open() ? `${id}-${active()}` : undefined} onClick={() => open() ? close() : show()} onKeyDown={event => { if (open()) keys(event); else if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) { event.preventDefault(); show(); } }}><span>{label()}</span><ChevronDown size={15} /></button>
    <Show when={open()}><Portal><div class="desktop-bank bank-popup-host"><div ref={popup} class="tutor-select-popup bank-select-popup" style={position()} onKeyDown={keys}>
      <Show when={props.options.length >= 8}><div class="tutor-select-search"><Search size={15} /><input ref={searchInput} type="search" aria-label={`搜索${props.label}`} aria-controls={id} placeholder="搜索选项…" value={query()} onInput={event => { setQuery(event.currentTarget.value); setActive(0); }} /></div></Show>
      <div ref={list} id={id} class="tutor-select-options" role="listbox" tabindex={-1} aria-label={props.label} aria-activedescendant={`${id}-${active()}`}><For each={filtered()}>{(option, index) => <div id={`${id}-${index()}`} role="option" aria-selected={props.value === option.value} class={`tutor-select-option ${index() === active() ? "is-active" : ""}`} data-option-index={index()} onPointerMove={() => setActive(index())} onMouseDown={event => event.preventDefault()} onClick={() => choose(option)}><span>{option.label}{option.count !== undefined ? ` · ${option.count}` : ""}</span><Show when={props.value === option.value}><Check size={15} /></Show></div>}</For><Show when={!filtered().length}><p class="tutor-select-empty">没有匹配的选项</p></Show></div>
    </div></div></Portal></Show>
  </span>;
}

const PAGE_SIZE = 12;
export function Bank(props: { config: any; initial?: any; onState?: (state: any) => void; onImport: () => void; onCreated: (draft: any) => void | Promise<void>; onBusy?: (busy: boolean) => void }) {
  const [query, setQuery] = createSignal(props.initial?.query || "");
  const [type, setType] = createSignal(props.initial?.type || "");
  const [difficulty, setDifficulty] = createSignal(props.initial?.difficulty || "");
  const [ability, setAbility] = createSignal(props.initial?.ability || "");
  const [literacy, setLiteracy] = createSignal(props.initial?.literacy || "");
  const [scope, setScope] = createSignal(props.initial?.scope || "");
  const [knowledge, setKnowledge] = createSignal(props.initial?.knowledge || "");
  const [label, setLabel] = createSignal(props.initial?.label || "全部题目");
  const [catalog, setCatalog] = createSignal<any>(null);
  const [catalogError, setCatalogError] = createSignal("");
  const [page, setPage] = createSignal(props.initial?.page || 1);
  const [rows, setRows] = createSignal<any[]>([]);
  const [total, setTotal] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [filterOptions, setFilterOptions] = createSignal<{ difficulty: FilterOption[]; abilities: FilterOption[]; literacies: FilterOption[] }>({ difficulty: [], abilities: [], literacies: [] });
  const [selections, setSelections] = createSignal<any[]>(props.initial?.selections || []);
  const [title, setTitle] = createSignal(props.initial?.title || "题库手动组卷");
  const [basketOpen, setBasketOpen] = createSignal(false);
  const [creating, setCreating] = createSignal(false);
  const [selectionError, setSelectionError] = createSignal("");
  const [createError, setCreateError] = createSignal("");
  const [submission, setSubmission] = createSignal<{ key: string; operationId: string } | null>(props.initial?.submission || null);
  const [createdDraft, setCreatedDraft] = createSignal<any>(props.initial?.createdDraft || null);
  let version = 0, alive = true;
  let queryTimer: ReturnType<typeof setTimeout> | undefined;
  let list!: HTMLDivElement;
  let basketTrigger!: HTMLButtonElement;
  onCleanup(() => { alive = false; ++version; clearTimeout(queryTimer); });
  createEffect(() => props.onState?.({ query: query(), type: type(), difficulty: difficulty(), ability: ability(), literacy: literacy(), scope: scope(), knowledge: knowledge(), label: label(), page: page(), selections: selections(), title: title(), submission: submission(), createdDraft: createdDraft() }));
  const active = createMemo(() => {
    for (const book of catalog()?.textbooks || []) for (const chapter of book.chapters || []) for (const section of chapter.sections || []) if (section.id === scope()) return { book, chapter, section };
    return null;
  });
  const chapters = createMemo(() => (catalog()?.textbooks || []).reduce((count: number, book: any) => count + (book.chapters || []).length, 0));
  const hasFilters = () => Boolean(query().trim() || type() || difficulty() || ability() || literacy());
  const dimensions = () => [
    { value: difficulty(), label: "难度", options: filterOptions().difficulty, clear: () => setDifficulty("") },
    { value: ability(), label: "能力", options: filterOptions().abilities, clear: () => setAbility("") },
    { value: literacy(), label: "素养", options: filterOptions().literacies, clear: () => setLiteracy("") },
  ].filter(item => item.value);
  function closeBasket() { if (!creating()) { setBasketOpen(false); requestAnimationFrame(() => basketTrigger?.focus({ preventScroll: true })); } }
  function toggle(row: any) {
    if (creating()) return;
    setSelectionError(""); setCreateError("");
    const question = row.question || row;
    if (selections().some(item => item.questionId === question.questionId)) setSelections(previous => previous.filter(item => item.questionId !== question.questionId));
    else if (selections().length >= 60) setSelectionError("最多选择 60 题，请先移出部分题目。");
    else if (typeIds.includes(question.questionType)) setSelections(previous => [...previous, { ...structuredClone(question), ...(row.catalogMetadata ? { catalogMetadata: structuredClone(row.catalogMetadata) } : {}), selectedOrigin: scope() }]);
  }
  async function openCreated() {
    const draft = createdDraft(); if (!draft) return;
    setCreatedDraft(null);
    try { await props.onCreated(draft); } catch { setCreatedDraft(draft); setSelectionError("草稿已创建，暂时未能打开。请点击‘打开草稿’重试。"); }
  }
  async function createDraft() {
    if (creating()) return;
    setCreateError("");
    if (!title().trim() || title().trim().length > 120) { setCreateError("请输入 1～120 字的试卷名称。"); return; }
    if (!selections().length || selections().length > 60) { setCreateError("请选择 1～60 道题目。"); return; }
    const payload = { title: title().trim(), purpose: "consolidation", durationMinutes: 45, student: null, selections: typeIds.flatMap(type => selections().filter(question => question.questionType === type).map(question => ({ questionId: question.questionId, contentVersion: question.contentVersion, teacherVersion: question.teacherVersion }))) };
    const key = JSON.stringify(payload);
    const operation = submission()?.key === key ? submission()!.operationId : operationId();
    setSubmission({ key, operationId: operation }); setCreating(true); props.onBusy?.(true);
    let result: any;
    try { result = await request("manual_draft_create", { ...payload, operationId: operation }); }
    catch (failure: any) { setCreateError(failure.message); setCreating(false); props.onBusy?.(false); return; }
    batch(() => { setCreatedDraft(result.draft); setSelections([]); setSubmission(null); setBasketOpen(false); setSelectionError(""); });
    await openCreated(); setCreating(false); props.onBusy?.(false);
  }
  async function loadCatalog() {
    setCatalogError("");
    try { const result = await request("bank_catalog"); if (alive) setCatalog(result); }
    catch (failure: any) { if (alive) setCatalogError(failure.message); }
  }
  async function search(nextPage = 1) {
    clearTimeout(queryTimer);
    const own = ++version; setBusy(true); setError("");
    try {
      const result = await request("bank_search", { query: query().trim(), ...(type() ? { questionType: type() } : {}), ...(difficulty() ? { difficulty: difficulty() } : {}), ...(ability() ? { ability: ability() } : {}), ...(literacy() ? { literacy: literacy() } : {}), ...(scope() ? { mainScope: [scope()] } : {}), ...(knowledge() ? { knowledgeUid: knowledge(), includeDescendants: true } : {}), page: nextPage, pageSize: PAGE_SIZE });
      if (own === version) { setRows(result.questions || []); setTotal(result.total || 0); setPage(result.page || nextPage); if (result.filterOptions) setFilterOptions(result.filterOptions); if (list) list.scrollTop = 0; }
    } catch (failure: any) { if (own === version) setError(failure.message); }
    finally { if (own === version) setBusy(false); }
  }
  function clearFilters() { batch(() => { setQuery(""); setType(""); setDifficulty(""); setAbility(""); setLiteracy(""); }); search(); }
  function changeFilter(setter: (value: string) => void, value: string) { setter(value); search(); }
  onMount(() => { loadCatalog(); search(page()); });
  createEffect(on(()=>props.config,()=>{void loadCatalog();void search(page());},{defer:true}));
  return <section class="question-bank-page desktop-bank">
    <header class="question-bank-heading"><div><h1>题库</h1><p>按教材章节浏览，选好题目后直接生成草稿。</p></div><div class="bank-heading-actions"><span class="bank-catalog-total">已开放 {chapters()} 章 · {catalog()?.readyCount ?? total()} 道可用题</span><button ref={basketTrigger} type="button" class="bank-basket-trigger" aria-label={`打开组卷篮，已选 ${selections().length} 道题`} aria-expanded={basketOpen()} onClick={() => setBasketOpen(true)}><ShoppingBasket size={17} /><span>组卷篮</span><b>{selections().length}</b></button><button type="button" class="bank-import-link" disabled={creating()} onClick={props.onImport}><Upload size={16} />上传试卷</button></div></header>
    <ErrorBanner message={selectionError()} /><Show when={createdDraft()}><div class="manual-bank-created" role="status"><span>草稿已创建</span><button class="secondary" disabled={creating()} onClick={openCreated}>打开草稿</button></div></Show>
    <div class="bank-browser"><div class="bank-navigation-slot"><ErrorBanner message={catalogError()} retry={loadCatalog} /><Show when={catalog()} fallback={<Busy label="读取目录…" />}><BankNavigation catalog={catalog()} scope={scope()} knowledge={knowledge()} onSelect={(scopeId, uid, text) => { setScope(scopeId); setKnowledge(uid); setLabel(text); search(); }} /></Show></div>
      <section class="bank-results-panel" aria-label="题库检索结果"><div class="bank-results-heading"><div><Show when={active()}>{value => <p>{value().book.title || value().book.volume} / {value().chapter.title}</p>}</Show><h2>{label()}</h2></div><strong>{knowledge() ? total() : active()?.section.readyCount ?? catalog()?.readyCount ?? total()} 道题</strong></div>
        <div class="bank-results"><div class="bank-filter-row"><label class="bank-search"><Search size={17} /><input type="search" aria-label="搜索本小节" value={query()} placeholder="搜索本小节题干、知识点或题号" onInput={event => { setQuery(event.currentTarget.value); clearTimeout(queryTimer); queryTimer = setTimeout(() => search(), 250); }} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); search(); } }} /></label><BankSelect value={type()} label="筛选题型" options={[{ value: "", label: "全部题型" }, ...typeIds.map(value => ({ value, label: typeLabels[value] }))]} onChange={value => changeFilter(setType, value)} /><BankSelect value={difficulty()} label="筛选难度" options={[{ value: "", label: "全部难度" }, ...filterOptions().difficulty]} onChange={value => changeFilter(setDifficulty, value)} /><BankSelect value={ability()} label="筛选能力" options={[{ value: "", label: "全部能力" }, ...filterOptions().abilities]} onChange={value => changeFilter(setAbility, value)} /><BankSelect value={literacy()} label="筛选核心素养" options={[{ value: "", label: "全部核心素养" }, ...filterOptions().literacies]} onChange={value => changeFilter(setLiteracy, value)} /></div>
          <Show when={hasFilters()}><div class="bank-active-filters" aria-label="已选筛选条件"><For each={dimensions()}>{dimension => <button type="button" class="bank-active-filter" onClick={() => { dimension.clear(); search(); }} aria-label={`清除${dimension.label}筛选：${dimension.options.find(option => option.value === dimension.value)?.label || dimension.value}`}><span>{dimension.label}：{dimension.options.find(option => option.value === dimension.value)?.label || dimension.value}</span><X size={13} /></button>}</For><button type="button" class="bank-reset-filters" onClick={clearFilters}>清除全部筛选</button></div></Show>
          <Show when={ability() || literacy()} fallback={<Show when={difficulty() === "unknown"}><p class="bank-annotation-note">这些题目尚无独立难度评估。</p></Show>}><p class="bank-annotation-note">能力与素养按已有教研标注筛选，待复核标注仅供检索参考。</p></Show>
          <ErrorBanner message={error()} retry={() => search(page())} />
          <div class="bank-result-summary"><span role="status" aria-live="polite">{busy() ? "正在查询…" : `共 ${total()} 道匹配题`}</span><span>已选 {selections().length} 道 · 切换章节保留</span></div>
          <Show when={rows().length} fallback={<div class="bank-empty"><strong>{busy() ? "正在查询题目…" : hasFilters() ? "没有找到匹配题目" : "本小节暂无题目"}</strong><span>{hasFilters() ? "可清除筛选条件，或切换其他小节。" : "可切换其他小节，或上传试卷补充题目。"}</span><Show when={hasFilters()} fallback={<button onClick={props.onImport}>上传试卷</button>}><button onClick={clearFilters}>清除筛选</button></Show></div>}><div ref={list} class="bank-question-list" aria-label="题目列表" aria-busy={busy()}><For each={rows()}>{row => <BankQuestionCard row={row} manifest={props.config.sourceManifest} selected={selections().some(item => item.questionId === (row.question || row).questionId)} disabled={busy() || creating() || !typeIds.includes((row.question || row).questionType)} onToggle={() => toggle(row)} />}</For></div></Show>
          <nav class="bank-pagination" aria-label="题目分页"><button type="button" disabled={busy() || page() <= 1} onClick={() => search(page() - 1)}><ChevronLeft size={16} />上一页</button><span>第 {page()} / {Math.max(1, Math.ceil(total() / PAGE_SIZE))} 页</span><button type="button" disabled={busy() || page() * PAGE_SIZE >= total()} onClick={() => search(page() + 1)}>下一页<ChevronRight size={16} /></button></nav>
        </div>
      </section>
      <Show when={basketOpen()}><BankBasket selections={selections()} manifest={props.config.sourceManifest} catalog={catalog()} title={title()} busy={creating()} error={createError()} onTitle={setTitle} onRemove={id => { if (!creating()) { setSelections(previous => previous.filter(question => question.questionId !== id)); setCreateError(""); } }} onClear={() => { if (!creating()) { setSelections([]); setCreateError(""); } }} onCreate={createDraft} onClose={closeBasket} /></Show>
    </div>
  </section>;
}
