import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { BookOpen, ChevronDown, ChevronRight, Search } from "lucide-solid";
import { request } from "./bridge";
import { Busy, ErrorBanner } from "./ui";
import { canonicalScope, filterScopeNodes, scopeCheckState, scopeNodes, toggleScopes, type ScopeNode } from "./scope-tree";

export function ScopeTree(props: { config: any; selected: string[]; disabled?: boolean; onChange: (ids: string[]) => void }) {
  const [catalog, setCatalog] = createSignal<any>();
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  const [query, setQuery] = createSignal("");
  const [opened, setOpened] = createSignal(new Set<string>());
  let alive = true;
  onCleanup(() => { alive = false; });
  const nodes = createMemo(() => scopeNodes(catalog(), props.config.chapters, props.config.tasks));
  const visible = createMemo(() => filterScopeNodes(nodes(), query()));
  async function load() {
    setLoading(true); setError("");
    try {
      const result = await request("bank_catalog");
      if (!alive) return;
      setCatalog(result);
      const selected = new Set(props.selected.map(canonicalScope));
      const branches = new Set<string>();
      for (const book of scopeNodes(result, props.config.chapters, props.config.tasks)) {
        for (const chapter of book.children) {
          if (chapter.selectableIds.some(id => selected.has(canonicalScope(id)))) { branches.add(book.key); branches.add(chapter.key); }
        }
      }
      if (!branches.size) {
        const book = scopeNodes(result, props.config.chapters, props.config.tasks).find(node => node.selectableIds.length);
        if (book) { branches.add(book.key); const chapter = book.children.find(node => node.selectableIds.length); if (chapter) branches.add(chapter.key); }
      }
      setOpened(branches);
    } catch (failure: any) { if (alive) setError(failure.message); }
    finally { if (alive) setLoading(false); }
  }
  onMount(load);
  function toggle(key: string) {
    setOpened(previous => { const next = new Set(previous); next.has(key) ? next.delete(key) : next.add(key); return next; });
  }
  function Branch(branch: { node: ScopeNode; level: number }) {
    const node = branch.node;
    const expandable = () => node.children.length > 0;
    const expanded = () => Boolean(query().trim()) || opened().has(node.key);
    const state = () => scopeCheckState(node.selectableIds, props.selected);
    let checkbox!: HTMLInputElement;
    createEffect(() => { if (checkbox) checkbox.indeterminate = state().mixed; });
    return <div class="scope-tree-branch">
      <div class={`scope-tree-row ${node.kind} ${state().checked ? "is-selected" : ""}`} style={{ "--scope-depth": branch.level }}>
        <Show when={expandable()} fallback={<span class="scope-tree-spacer" />}>
          <button type="button" class="scope-tree-toggle" aria-label={`${expanded() ? "收起" : "展开"}${node.label}`} aria-expanded={expanded()} onClick={() => toggle(node.key)} disabled={Boolean(query().trim())}>
            {expanded() ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
          </button>
        </Show>
        <label class="scope-tree-choice">
          <input ref={checkbox} type="checkbox" aria-label={`选择${node.label}`} aria-checked={state().mixed ? "mixed" : state().checked} checked={state().checked} disabled={props.disabled || !node.selectableIds.length} onChange={event => props.onChange(toggleScopes(props.selected, node.selectableIds, event.currentTarget.checked))} />
          <Show when={node.kind === "book"}><BookOpen size={17} /></Show>
          <span>{node.label}</span>
          <Show when={node.kind !== "section" && node.selectableIds.length}><small>{state().count}/{node.selectableIds.length}</small></Show>
          <Show when={node.kind === "section" && !node.scopeId}><small>暂无任务</small></Show>
        </label>
      </div>
      <Show when={expandable() && expanded()}><div class="scope-tree-children"><For each={node.children}>{child => <Branch node={child} level={branch.level + 1} />}</For></div></Show>
    </div>;
  }
  return <div class="scope-tree-picker">
    <div class="scope-tree-search"><Search size={17} /><input type="search" aria-label="搜索教材章节" placeholder="搜索教材、章节或小节" value={query()} onInput={event => setQuery(event.currentTarget.value)} /></div>
    <p class="scope-tree-hint">已选 {props.selected.length} 节。{query().trim() ? "章节勾选仅作用于当前匹配的小节。" : "选择章节或小节，可多选。"}</p>
    <div class="scope-tree-scroll" aria-label="教材章节范围">
      <ErrorBanner message={error()} retry={load} />
      <Show when={loading()}><Busy label="读取教材目录…" /></Show>
      <Show when={!loading() && !error()}><For each={visible()}>{node => <Branch node={node} level={0} />}</For><Show when={!visible().length}><p class="muted scope-tree-empty">没有匹配的教材章节</p></Show></Show>
    </div>
  </div>;
}
