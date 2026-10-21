import { For, Show, createMemo, createSignal } from "solid-js";
import { BookOpen, ChevronDown, ChevronRight, Search } from "lucide-solid";
import "./BankNavigation.css";

type Node = {
  key: string;
  label: string;
  count: number;
  scope?: string;
  uid?: string;
  children: Node[];
};
export function BankNavigation(props: {
  catalog: any;
  scope: string;
  knowledge: string;
  onSelect: (scope: string, uid: string, label: string) => void;
}) {
  const [mode, setMode] = createSignal(
    props.knowledge && !props.scope ? "knowledge" : "textbooks",
  );
  const [query, setQuery] = createSignal("");
  const initialBranches = new Set<string>();
  for (const book of props.catalog?.textbooks || []) {
    const chapter = (book.chapters || []).find((item: any) =>
      (item.sections || []).some((section: any) => section.id === props.scope),
    );
    if (chapter) {
      initialBranches.add(`book:${book.id}`);
      initialBranches.add(`chapter:${chapter.id}`);
    }
  }
  if (!initialBranches.size) {
    const book = props.catalog?.textbooks?.[0];
    if (book) {
      initialBranches.add(`book:${book.id}`);
      if (book.chapters?.[0])
        initialBranches.add(`chapter:${book.chapters[0].id}`);
    }
  }
  const [opened, setOpened] = createSignal(initialBranches);
  const [mobile, setMobile] = createSignal(false);
  const [focus, setFocus] = createSignal("all");
  let tree!: HTMLDivElement;
  const knowledgeNode = (item: any, scope = ""): Node => ({
    key: `knowledge:${scope}:${item.uid}`,
    label: item.name,
    count: item.readyCount || 0,
    uid: item.uid,
    scope,
    children: (item.children || []).map((child: any) =>
      knowledgeNode(child, scope),
    ),
  });
  const nodes = createMemo<Node[]>(() =>
    mode() === "knowledge"
      ? (props.catalog?.knowledgePoints || []).map((item: any) =>
          knowledgeNode(item),
        )
      : (props.catalog?.textbooks || []).map((book: any) => ({
          key: `book:${book.id}`,
          label: book.title || book.volume || book.id,
          count: book.readyCount || 0,
          children: (book.chapters || []).map((chapter: any) => ({
            key: `chapter:${chapter.id}`,
            label: chapter.title || chapter.id,
            count: chapter.readyCount || 0,
            children: (chapter.sections || []).map((section: any) => ({
              key: `section:${section.id}`,
              label: section.title || section.id,
              count: section.readyCount || 0,
              scope: section.id,
              children: (section.knowledge || []).map((item: any) =>
                knowledgeNode(item, section.id),
              ),
            })),
          })),
        })),
  );
  const matches = (node: Node): boolean =>
    !query().trim() ||
    node.label.toLowerCase().includes(query().trim().toLowerCase()) ||
    node.children.some(matches);
  const visible = createMemo(() => nodes().filter(matches));
  function toggle(key: string) {
    setOpened((current) => {
      const next = new Set(current);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }
  function focusItem(key?: string) {
    if (!key) return;
    setFocus(key);
    tree
      .querySelector<HTMLElement>(`[data-tree-key="${CSS.escape(key)}"]`)
      ?.focus();
  }
  function keyboard(event: KeyboardEvent) {
    const item = (event.target as HTMLElement).closest<HTMLElement>(
      '[role="treeitem"]',
    );
    if (!item || !tree.contains(item)) return;
    const items = [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    const index = items.indexOf(item);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      focusItem(
        items[
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : event.key === "ArrowDown"
                ? Math.min(index + 1, items.length - 1)
                : Math.max(index - 1, 0)
        ]?.dataset.treeKey,
      );
    } else if (
      event.key === "ArrowRight" &&
      item.hasAttribute("aria-expanded")
    ) {
      event.preventDefault();
      item.getAttribute("aria-expanded") === "false"
        ? toggle(item.dataset.treeKey!)
        : focusItem(items[index + 1]?.dataset.treeKey);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      item.getAttribute("aria-expanded") === "true"
        ? toggle(item.dataset.treeKey!)
        : focusItem(item.dataset.parentKey);
    }
  }
  function select(node: Node) {
    if (node.scope || node.uid) {
      props.onSelect(node.scope || "", node.uid || "", node.label);
      setMobile(false);
    }
    if (node.children.length) toggle(node.key);
  }
  function Branch(branch: {
    node: Node;
    level: number;
    parent?: string;
    ancestorMatch?: boolean;
  }) {
    const expanded = () =>
      Boolean(query().trim()) || opened().has(branch.node.key);
    const showAll = () =>
      branch.ancestorMatch ||
      Boolean(
        query().trim() &&
          branch.node.label
            .toLowerCase()
            .includes(query().trim().toLowerCase()),
      );
    const active = () =>
      branch.node.uid
        ? props.knowledge === branch.node.uid &&
          props.scope === (branch.node.scope || "")
        : Boolean(branch.node.scope) &&
          !props.knowledge &&
          props.scope === branch.node.scope;
    return (
      <div role="none">
        <button
          type="button"
          role="treeitem"
          aria-level={branch.level}
          aria-selected={active()}
          aria-expanded={branch.node.children.length ? expanded() : undefined}
          class={`catalog-node ${active() ? "active" : ""}`}
          style={{ "--tree-level": branch.level - 1 }}
          data-tree-key={branch.node.key}
          data-parent-key={branch.parent}
          tabIndex={focus() === branch.node.key ? 0 : -1}
          onFocus={() => setFocus(branch.node.key)}
          onClick={() => select(branch.node)}
          title={branch.node.label}
        >
          <span class="catalog-arrow">
            {branch.node.children.length ? (
              expanded() ? (
                <ChevronDown size={16} />
              ) : (
                <ChevronRight size={16} />
              )
            ) : null}
          </span>
          <span class="catalog-label">{branch.node.label}</span>
          <small>{branch.node.count}</small>
        </button>
        <Show when={expanded() && branch.node.children.length}>
          <div role="group">
            <For
              each={
                showAll()
                  ? branch.node.children
                  : branch.node.children.filter(matches)
              }
            >
              {(child) => (
                <Branch
                  node={child}
                  parent={branch.node.key}
                  level={branch.level + 1}
                  ancestorMatch={showAll()}
                />
              )}
            </For>
          </div>
        </Show>
      </div>
    );
  }
  return (
    <aside
      class={`catalog-panel ${mobile() ? "catalog-mobile-open" : ""}`}
      aria-label="教材与知识点导航"
    >
      <button
        class="catalog-mobile-toggle secondary"
        aria-expanded={mobile()}
        onClick={() => setMobile(!mobile())}
      >
        <BookOpen size={17} />
        教材与知识点
        <ChevronDown size={16} />
      </button>
      <div class="catalog-content">
        <div
          class="type-tabs catalog-tabs"
          role="tablist"
          aria-label="题库导航方式"
        >
          <button
            role="tab"
            aria-selected={mode() === "textbooks"}
            class={mode() === "textbooks" ? "active" : ""}
            onClick={() => {
              setMode("textbooks");
              setFocus("all");
            }}
          >
            教材
          </button>
          <button
            role="tab"
            aria-selected={mode() === "knowledge"}
            class={mode() === "knowledge" ? "active" : ""}
            onClick={() => {
              setMode("knowledge");
              setFocus("all");
            }}
          >
            知识点
          </button>
        </div>
        <label class="search-field catalog-search">
          <Search size={17} />
          <input
            type="search"
            aria-label="搜索教材或知识点"
            placeholder="搜索章节、知识点"
            value={query()}
            onInput={(event) => {
              setQuery(event.currentTarget.value);
              setFocus("all");
            }}
          />
        </label>
        <Show
          when={(props.catalog?.textbooks || []).some((book: any) =>
            (book.chapters || []).some((chapter: any) =>
              (chapter.sections || []).some((section: any) =>
                (section.knowledge || []).some(
                  (item: any) => item.reviewStatus === "pending_review",
                ),
              ),
            ),
          )}
        >
          <details class="catalog-note">
            <summary>目录说明</summary>
            <p>教材与知识点的对应关系待复核。</p>
          </details>
        </Show>
        <div
          class="catalog-tree"
          role="tree"
          aria-label={mode() === "textbooks" ? "教材章节树" : "知识点树"}
          ref={tree}
          onKeyDown={keyboard}
        >
          <button
            role="treeitem"
            aria-level={1}
            aria-selected={!props.scope && !props.knowledge}
            data-tree-key="all"
            tabIndex={focus() === "all" ? 0 : -1}
            onFocus={() => setFocus("all")}
            class={`catalog-node ${!props.scope && !props.knowledge ? "active" : ""}`}
            onClick={() => {
              props.onSelect("", "", "全部题目");
              setMobile(false);
            }}
          >
            <span class="catalog-label">全部题目</span>
            <small>{props.catalog?.readyCount || 0}</small>
          </button>
          <For each={visible()}>
            {(node) => <Branch node={node} level={1} />}
          </For>
          <Show when={!visible().length}>
            <p class="history-empty">没有匹配的目录。</p>
          </Show>
        </div>
      </div>
    </aside>
  );
}
