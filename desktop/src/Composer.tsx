import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import { Portal } from "solid-js/web";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ListTree,
  Plus,
  Search,
  UserRound,
  X,
} from "lucide-solid";
import { operationId, purposeLabel, purposes, request } from "./bridge";
import { ErrorBanner, Modal, Popover } from "./ui";
import { ScopeTree } from "./ScopeTree";

type Mention = { start: number; end: number; query: string };
const CARET_ANCHOR = "\u200b";
function mentionAt(text: string, caret: number): Mention | null {
  const match = /(?:^|[\s，。；：、（(])@([^@\s]{0,40})$/u.exec(
    text.slice(0, caret),
  );
  return match
    ? { start: caret - match[1].length - 1, end: caret, query: match[1] }
    : null;
}
function plain(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
  if (node instanceof HTMLElement && node.dataset.studentId) return "";
  if (node.nodeName === "BR") return "\n";
  const anchor = node instanceof HTMLElement && node.hasAttribute("data-composer-caret");
  const editor = node instanceof HTMLElement && node.classList.contains("composer-editor");
  if ((anchor || editor) && node.childNodes.length === 1 && node.firstChild?.nodeName === "BR") return "";
  const value = Array.from(node.childNodes)
    .map((child) => plain(child))
    .join("");
  return anchor ? value.replaceAll(CARET_ANCHOR, "") : value;
}
export function Composer(props: {
  config: any;
  busy: boolean;
  configured: boolean;
  initial?: any;
  initialStudentOffset?: number;
  onSubmit: (requirements: any, text: string, mode: string, studentOffset?: number) => void;
}) {
  const defaults = () => props.config?.defaultRequirements || {};
  const [scope, setScope] = createSignal<string[]>(
    props.initial?.mainScope || defaults().mainScope || [],
  );
  const [purpose, setPurpose] = createSignal(
    props.initial?.purpose || "consolidation",
  );
  const [scored, setScored] = createSignal(
    props.initial?.scoringMode === "points",
  );
  const [text, setText] = createSignal(props.initial?.teacherRequest || "");
  const [student, setStudent] = createSignal<any>(
    props.initial?.student || null,
  );
  const [menu, setMenu] = createSignal("");
  const [mention, setMention] = createSignal<Mention | null>(null);
  const [students, setStudents] = createSignal<any[]>([]);
  const [studentError, setStudentError] = createSignal("");
  const [loadingStudents, setLoadingStudents] = createSignal(false);
  const [active, setActive] = createSignal(0);
  const [anchor, setAnchor] = createSignal({ left: 20, top: 20, maxHeight: 320 });
  const [manualQuery, setManualQuery] = createSignal("");
  const [adding, setAdding] = createSignal(false);
  const [newName, setNewName] = createSignal("");
  const [newGrade, setNewGrade] = createSignal("");
  const [savingStudent, setSavingStudent] = createSignal(false);
  let studentOperationId = operationId();
  const [mode, setMode] = createSignal(props.configured ? "llm" : "rule");
  let editor!: HTMLDivElement;
  let studentTrigger!: HTMLButtonElement;
  let studentPopup!: HTMLDivElement;
  let savedRange: Range | null = null;
  let clearingSelection = false;
  let deletingInput = false;
  const references = new Map<string, any>();
  if (student()) references.set(student().studentId, student());
  const query = () => mention()?.query ?? manualQuery();
  const pickerOpen = () => Boolean(mention()) || menu() === "student";
  let searchVersion = 0;
  async function loadStudents(value: string) {
    const version = ++searchVersion;
    setLoadingStudents(true);
    setStudentError("");
    try {
      const result = await request("students_list", { query: value });
      if (version === searchVersion) {
        setStudents(result.students || []);
        setActive(0);
      }
    } catch (error: any) {
      if (version === searchVersion) setStudentError(error.message);
    } finally {
      if (version === searchVersion) setLoadingStudents(false);
    }
  }
  createEffect(() => {
    if (!pickerOpen()) return;
    const value = query();
    ++searchVersion;
    setLoadingStudents(true);
    setStudents([]);
    const timer = setTimeout(() => loadStudents(value), 160);
    onCleanup(() => clearTimeout(timer));
  });
  const selectedLabels = () =>
    (props.config.chapters || []).filter((chapter: any) =>
      scope().includes(chapter.id),
    );
  const scopeLabel = () =>
    selectedLabels().length
      ? `${selectedLabels()[0].label.replace(/^\d+(?:\.\d+)*\s*/u, "")}${selectedLabels().length > 1 ? ` 等 ${selectedLabels().length} 节` : ""}`
      : "选择范围";
  function capture() {
    const selection = window.getSelection();
    if (selection?.rangeCount && editor.contains(selection.anchorNode))
      savedRange = selection.getRangeAt(0).cloneRange();
  }
  function emptyCaretPoint(): [Node, number] | null {
    if (plain(editor)) return null;
    let anchor = editor.querySelector<HTMLElement>("[data-composer-caret]");
    if (!anchor) {
      anchor = document.createElement("span");
      anchor.dataset.composerCaret = "";
      // Unlike generated CSS content, this gives the native caret a real text
      // position. `plain` and `locate` exclude the marker from all user data.
      anchor.textContent = CARET_ANCHOR;
      if (!editor.querySelector("[data-student-id]")) editor.replaceChildren(anchor);
      else editor.append(anchor);
    }
    const node = anchor.firstChild;
    if (node?.nodeType === Node.TEXT_NODE && node.textContent?.startsWith(CARET_ANCHOR)) return [node, 1];
    anchor.replaceChildren(document.createTextNode(CARET_ANCHOR));
    return [anchor.firstChild!, 1];
  }
  function placeEmptyCaret() {
    const point = emptyCaretPoint();
    if (!point) return;
    const range = document.createRange();
    range.setStart(point[0], point[1]);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    capture();
  }
  function caretOffset() {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !editor.contains(selection.anchorNode))
      return text().length;
    const range = selection.getRangeAt(0).cloneRange();
    range.selectNodeContents(editor);
    range.setEnd(selection.anchorNode!, selection.anchorOffset);
    return plain(range.cloneContents()).length;
  }
  function locate(offset: number): [Node, number] {
    const walker = document.createTreeWalker(
      editor,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          if (node instanceof HTMLElement && node.dataset.studentId)
            return NodeFilter.FILTER_REJECT;
          return node.nodeType === Node.TEXT_NODE || node.nodeName === "BR"
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_SKIP;
        },
      },
    );
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const content = node.textContent || "";
      const anchored = node.nodeType === Node.TEXT_NODE && Boolean(node.parentElement?.closest("[data-composer-caret]"));
      const length =
        node.nodeName === "BR" ? 1 : (anchored ? content.replaceAll(CARET_ANCHOR, "") : content).length;
      if (offset <= length && node.nodeType === Node.TEXT_NODE) {
        let actual = 0, count = 0;
        while (actual < content.length) {
          if (anchored && content[actual] === CARET_ANCHOR) actual++;
          else if (count < offset) { count++; actual++; }
          else break;
        }
        return [node, actual];
      }
      offset -= length;
    }
    return [editor, editor.childNodes.length];
  }
  function positionPopup() {
    const selection = window.getSelection();
    let rect = mention() && selection?.rangeCount && editor.contains(selection.anchorNode)
      ? selection.getRangeAt(0).getBoundingClientRect()
      : studentTrigger?.getBoundingClientRect();
    if (!rect?.height) rect = editor.getBoundingClientRect();
    const viewport = window.visualViewport;
    const leftEdge = (viewport?.offsetLeft || 0) + 12;
    const topEdge = (viewport?.offsetTop || 0) + 12;
    const rightEdge = leftEdge + (viewport?.width || innerWidth) - 24;
    const bottomEdge = topEdge + (viewport?.height || innerHeight) - 24;
    const width = Math.min(310, rightEdge - leftEdge);
    const height = Math.min(studentPopup?.scrollHeight || 260, 320);
    const below = bottomEdge - rect.bottom - 6;
    const above = rect.top - topEdge - 6;
    const downward = below >= height || below >= above;
    const maxHeight = Math.max(1, Math.min(320, downward ? below : above, bottomEdge - topEdge));
    setAnchor({
      left: Math.min(Math.max(rect.left, leftEdge), rightEdge - width),
      top: Math.max(topEdge, Math.min(downward ? rect.bottom + 6 : rect.top - 6 - Math.min(height, maxHeight), bottomEdge - Math.min(height, maxHeight))),
      maxHeight,
    });
  }
  function dismissStudentPicker(restoreFocus = false) {
    const target = mention() ? editor : studentTrigger;
    setMention(null);
    setMenu("");
    if (restoreFocus) target?.focus({ preventScroll: true });
  }
  function entireSelection() {
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed || !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) return false;
    const fragment = selection.getRangeAt(0).cloneContents();
    return plain(fragment).replaceAll(CARET_ANCHOR, "") === plain(editor) && (!editor.querySelector("[data-student-id]") || Boolean(fragment.querySelector("[data-student-id]")));
  }
  function changed(event?: InputEvent) {
    // Chromium may leave an LF/BR filler when deleting all editable content.
    // Use the actual delete intent, rather than trimming legitimate newlines.
    const leftover = editor.firstChild;
    const deletionFiller = deletingInput && editor.childNodes.length === 1 && leftover instanceof HTMLElement && leftover.hasAttribute("data-composer-caret") && leftover.childNodes.length === 1 && leftover.firstChild?.nodeType === Node.TEXT_NODE && leftover.firstChild.textContent === "\n";
    if ((clearingSelection || deletionFiller) && !event?.isComposing) {
      editor.replaceChildren();
    }
    clearingSelection = false;
    deletingInput = false;
    setText(plain(editor));
    const chip = editor.querySelector<HTMLElement>("[data-student-id]");
    if (chip) setStudent(references.get(chip.dataset.studentId!) || student());
    else setStudent(null);
    if (!event?.isComposing && !text() && !chip && document.activeElement === editor) placeEmptyCaret();
    capture();
    const next = mentionAt(text(), caretOffset());
    setMention(next);
    setActive(0);
    if (next) {
      setMenu("");
      positionPopup();
    }
  }
  function selectStudent(value: any) {
    references.set(value.studentId, value);
    const existing = editor.querySelector("[data-student-id]");
    existing?.remove();
    editor.focus();
    const selection = window.getSelection()!;
    const range = document.createRange();
    const current = mention();
    if (current) {
      const start = locate(current.start),
        end = locate(current.end);
      range.setStart(start[0], start[1]);
      range.setEnd(end[0], end[1]);
    } else if (savedRange && editor.contains(savedRange.startContainer))
      range.setStart(savedRange.startContainer, savedRange.startOffset);
    else {
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    selection.removeAllRanges();
    selection.addRange(range);
    const chip = document.createElement("span");
    chip.contentEditable = "false";
    chip.className = "inline-chip student-chip";
    chip.dataset.studentId = value.studentId;
    chip.textContent = `@${value.name}`;
    chip.title = `${value.name}${value.grade ? ` · ${value.grade}` : ""}`;
    // Only locally-created text nodes/attributes are serialized here, never bank HTML.
    document.execCommand("insertHTML", false, chip.outerHTML + " ");
    setStudent(value);
    setMention(null);
    setMenu("");
    changed();
  }
  function removeStudent() {
    editor.querySelector("[data-student-id]")?.remove();
    setStudent(null);
    setMention(null);
    changed();
  }
  function copySelection(event: ClipboardEvent, cut = false) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) return;
    event.clipboardData?.setData("text/plain", plain(selection.getRangeAt(0).cloneContents()).replaceAll(CARET_ANCHOR, ""));
    event.preventDefault();
    if (cut && !props.busy && !selection.isCollapsed) {
      clearingSelection = entireSelection();
      deletingInput = true;
      document.execCommand("delete");
      changed();
    }
  }
  function key(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (pickerOpen()) {
      if (
        ["Tab", "ArrowDown", "ArrowUp"].includes(event.key) &&
        students().length &&
        !loadingStudents()
      ) {
        event.preventDefault();
        const delta = event.key === "ArrowUp" || event.shiftKey ? -1 : 1;
        setActive(
          (index) => (index + delta + students().length) % students().length,
        );
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        if (!loadingStudents() && students()[active()])
          selectStudent(students()[active()]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismissStudentPicker(true);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }
  function submit() {
    if (props.busy || !scope().length) return;
    const { title: defaultTitle, ...preset } = defaults();
    props.onSubmit(
      {
        ...preset,
        ...props.initial,
        subject: "math",
        mainScope: scope(),
        learnedScope: scope(),
        purpose: purpose(),
        scoringMode: scored() ? "points" : "none",
        targetScore: scored() ? defaults().targetScore || 100 : 0,
        ...(student() ? { student: student() } : { student: undefined }),
        teacherRequest: text(),
      },
      text(),
      mode(),
      student() ? studentOffset() : undefined,
    );
  }
  async function createStudent() {
    if (!newName().trim() || savingStudent()) return;
    setSavingStudent(true);
    setStudentError("");
    try {
      const result = await request("students_create", {
        name: newName().trim(),
        grade: newGrade().trim(),
        operationId: studentOperationId,
      });
      setAdding(false);
      selectStudent(result.student);
      setNewName("");
      setNewGrade("");
      studentOperationId = operationId();
    } catch (error: any) {
      setStudentError(error.message);
    } finally {
      setSavingStudent(false);
    }
  }
  function manualPicker() {
    if (menu() === "student") {
      dismissStudentPicker();
      return;
    }
    capture();
    setMention(null);
    setManualQuery("");
    setMenu("student");
    positionPopup();
    queueMicrotask(() => studentPopup?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true }));
  }
  createEffect(() => {
    if (!pickerOpen()) return;
    // Reposition after the list, loading state or current association changes.
    students().length;
    loadingStudents();
    studentError();
    student();
    let frame = 0;
    const outside = (event: PointerEvent) => {
      if (
        !(event.target as HTMLElement).closest(".student-popover") &&
        (!editor.contains(event.target as Node) || !mention()) &&
        !studentTrigger.contains(event.target as Node)
      ) {
        dismissStudentPicker();
      }
    };
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(positionPopup);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        dismissStudentPicker(true);
      }
    };
    update();
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    document.addEventListener("selectionchange", update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    onCleanup(() => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    });
  });
  function studentOffset() {
    const chip = editor.querySelector("[data-student-id]");
    if (!chip) return undefined;
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.setEndBefore(chip);
    return plain(range.cloneContents()).length;
  }
  function focusWritingArea(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (props.busy) return;
    const selection = window.getSelection();
    if (editor.contains(target)) {
      // An empty inline editor's placeholder can leave the browser selection on
      // an adjacent condition button, even though the editor itself has focus.
      if (selection?.anchorNode && editor.contains(selection.anchorNode) && selection.rangeCount && selection.getRangeAt(0).getBoundingClientRect().height) return;
    } else if (target !== event.currentTarget && !target.classList.contains("composer-text")) return;
    editor.focus({ preventScroll: true });
    if (!plain(editor)) {
      placeEmptyCaret();
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
    capture();
  }
  queueMicrotask(() => {
    // Restore plain text and the local reference without browser editing commands:
    // those commands focus the field and append the reference at the current caret.
    editor.textContent = text();
    if (!student()) {
      emptyCaretPoint();
      return;
    }
    const offset = Math.max(0, Math.min(text().length, props.initialStudentOffset ?? text().length));
    const chip = document.createElement("span");
    chip.contentEditable = "false";
    chip.className = "inline-chip student-chip";
    chip.dataset.studentId = student().studentId;
    chip.textContent = `@${student().name}`;
    chip.title = `${student().name}${student().grade ? ` · ${student().grade}` : ""}`;
    editor.replaceChildren(document.createTextNode(text().slice(0, offset)), chip, document.createTextNode(text().slice(offset)));
    emptyCaretPoint();
  });
  return (
    <>
      <form
        class="composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div class="composer-toolbar">
          <div class="relative">
            <button
              type="button"
              onClick={() => setMenu(menu() === "subject" ? "" : "subject")}
            >
              数学 <ChevronDown size={15} />
            </button>
            <Show when={menu() === "subject"}>
              <Popover close={() => setMenu("")}>
                <strong>学科</strong>
                <button type="button" onClick={() => setMenu("")}>
                  数学 <Check size={15} />
                </button>
                <For each={["语文", "英语", "物理", "化学", "生物"]}>
                  {(label) => (
                    <button type="button" disabled>
                      {label}
                      <small>暂未开放</small>
                    </button>
                  )}
                </For>
              </Popover>
            </Show>
          </div>
          <button type="button" onClick={() => setMenu("scope")}>
            <ListTree size={18} />
            考查范围 <span class="muted">已选 {scope().length} 节</span>
            <ChevronDown size={15} />
          </button>
          <div class="relative">
            <button
              type="button"
              onClick={() => setMenu(menu() === "purpose" ? "" : "purpose")}
            >
              组卷用途 <span class="muted">{purposeLabel(purpose())}</span>
              <ChevronDown size={15} />
            </button>
            <Show when={menu() === "purpose"}>
              <Popover close={() => setMenu("")} class="purpose-popover">
                <For each={purposes}>
                  {(item) => (
                    <button
                      type="button"
                      onClick={() => {
                        setPurpose(item.id);
                        setMenu("");
                      }}
                    >
                      <span>
                        <strong>{item.label}</strong>
                        <small>{item.description}</small>
                      </span>
                      <Show when={purpose() === item.id}>
                        <Check size={16} />
                      </Show>
                    </button>
                  )}
                </For>
              </Popover>
            </Show>
          </div>
          <button ref={studentTrigger} type="button" aria-expanded={menu() === "student"} aria-controls={menu() === "student" ? "student-suggestions" : undefined} onClick={manualPicker}>
            <UserRound size={18} />
            {student()?.name || "关联学生"}
            <ChevronDown size={15} />
          </button>
          <label class="score-control">
            计分{" "}
            <input
              type="checkbox"
              checked={scored()}
              onChange={(event) => setScored(event.currentTarget.checked)}
            />
            <span>{scored() ? "开" : "关"}</span>
          </label>
        </div>
        <div
          class="composer-field"
          onClick={focusWritingArea}
        >
          <div class="composer-text">
            <button
              type="button"
              class="inline-chip"
              onClick={() => setMenu("subject")}
            >
              数学
            </button>
            <button
              type="button"
              class="inline-chip"
              title={selectedLabels()
                .map((item: any) => item.label)
                .join("、")}
              onClick={() => setMenu("scope")}
            >
              {scopeLabel()}
            </button>
            <button
              type="button"
              class="inline-chip"
              onClick={() => setMenu("purpose")}
            >
              {purposeLabel(purpose())}
            </button>
            <Show when={scored()}>
              <button
                type="button"
                class="inline-chip"
                onClick={() => setScored(false)}
              >
                计分
              </button>
            </Show>
            <div
              ref={editor}
              class="composer-editor"
              role="textbox"
              aria-label="组卷要求"
              aria-multiline="true"
              aria-expanded={pickerOpen()}
              aria-controls={pickerOpen() ? "student-suggestions" : undefined}
              aria-activedescendant={
                pickerOpen() && students()[active()]
                  ? `student-${students()[active()].studentId}`
                  : undefined
              }
              contentEditable={!props.busy}
              data-empty={!text() && !student() ? "true" : "false"}
              data-placeholder="例如：今天讲了集合的交、并、补，出 8 道基础练习。输入 @ 关联学生。"
              onBeforeInput={(event) => {
                deletingInput = !event.isComposing && event.inputType.startsWith("delete");
                clearingSelection = deletingInput && entireSelection();
              }}
              onInput={changed}
              onFocus={placeEmptyCaret}
              onKeyDown={key}
              onCopy={(event) => copySelection(event)}
              onCut={(event) => copySelection(event, true)}
              onClick={() => {
                capture();
                changed();
              }}
              onPaste={(event) => {
                event.preventDefault();
                document.execCommand(
                  "insertText",
                  false,
                  event.clipboardData?.getData("text/plain") || "",
                );
                changed();
              }}
            />
          </div>
          <div class="composer-bottom">
            <span class="muted">Enter 发送 · Shift+Enter 换行</span>
            <div class="composer-submit">
              <select
                aria-label="组卷方式"
                value={mode()}
                onChange={(event) => setMode(event.currentTarget.value)}
                disabled={props.busy}
              >
                <option value="llm" disabled={!props.configured}>
                  AI 辅助{props.configured ? "" : "（需设置）"}
                </option>
                <option value="rule">规则预设</option>
              </select>
              <button class="primary" disabled={props.busy || !scope().length}>
                开始组卷 <ArrowUp size={18} />
              </button>
            </div>
          </div>
        </div>
      </form>
      <Show when={menu() === "scope"}>
        <Modal
          title="考查范围"
          stable
          onClose={() => setMenu("")}
          footer={
            <button class="primary" onClick={() => setMenu("")}>
              完成
            </button>
          }
        >
          <ScopeTree config={props.config} selected={scope()} disabled={props.busy} onChange={setScope} />
        </Modal>
      </Show>
      <Show when={pickerOpen()}>
        <Portal>
          <div
            ref={studentPopup}
            class="student-popover popover"
            style={{
              left: `${anchor().left}px`,
              top: `${anchor().top}px`,
              position: "fixed",
              "max-height": `${anchor().maxHeight}px`,
            }}
          >
            <div class="student-search">
              <Show when={!mention()} fallback={<UserRound size={16} />}><Search size={16} /></Show>
              <Show
                when={!mention()}
                fallback={<span>关联学生{query() ? ` · ${query()}` : ""}</span>}
              >
                <input
                  aria-label="搜索学生"
                  placeholder="搜索姓名或年级"
                  value={manualQuery()}
                  role="combobox"
                  aria-expanded={pickerOpen()}
                  aria-controls="student-suggestions"
                  aria-activedescendant={students()[active()] ? `student-${students()[active()].studentId}` : undefined}
                  onInput={(event) => setManualQuery(event.currentTarget.value)}
                  onKeyDown={key}
                />
              </Show>
            </div>
            <ErrorBanner
              message={studentError()}
              retry={() => loadStudents(query())}
            />
            <Show when={loadingStudents()}>
              <p class="muted">正在查找…</p>
            </Show>
            <Show
              when={!loadingStudents() && !studentError() && !students().length}
            >
              <p class="muted">没有匹配的学生</p>
            </Show>
            <div id="student-suggestions" role="listbox" aria-label="学生">
              <For each={students()}>
                {(item, index) => (
                  <button
                    type="button"
                    id={`student-${item.studentId}`}
                    role="option"
                    aria-selected={active() === index()}
                    class={active() === index() ? "active" : ""}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => selectStudent(item)}
                  >
                    <span>{item.name}</span>
                    <small>{item.grade}</small>
                  </button>
                )}
              </For>
            </div>
            <Show when={student()}>
              <button type="button" onClick={removeStudent}>
                <X size={15} />
                取消关联
              </button>
            </Show>
            <button
              type="button"
              onClick={() => {
                setAdding(true);
                setNewName(query());
                setMention(null);
                setMenu("");
              }}
            >
              <Plus size={16} />
              新增学生
            </button>
            <small class="muted">Tab 切换 · Enter 确认</small>
          </div>
        </Portal>
      </Show>
      <Show when={adding()}>
        <Modal
          title="新增学生"
          onClose={() => setAdding(false)}
          busy={savingStudent()}
          footer={
            <>
              <button
                class="secondary"
                onClick={() => setAdding(false)}
                disabled={savingStudent()}
              >
                取消
              </button>
              <button
                class="primary"
                onClick={createStudent}
                disabled={savingStudent() || !newName().trim()}
              >
                {savingStudent() ? "保存中…" : "添加并关联"}
              </button>
            </>
          }
        >
          <label class="field-label">
            姓名或昵称
            <input
              maxLength={60}
              value={newName()}
              onInput={(event) => setNewName(event.currentTarget.value)}
              placeholder="例如：小林"
            />
          </label>
          <label class="field-label">
            <span>年级 <small class="muted">选填</small></span>
            <select
              aria-label="学生年级"
              value={newGrade()}
              disabled={savingStudent()}
              onChange={(event) => setNewGrade(event.currentTarget.value)}
            >
              <option value="">暂不设置</option>
              <optgroup label="小学">
                <For each={["一年级", "二年级", "三年级", "四年级", "五年级", "六年级"]}>
                  {(grade) => <option value={grade}>{grade}</option>}
                </For>
              </optgroup>
              <optgroup label="初中">
                <For each={["初一", "初二", "初三"]}>
                  {(grade) => <option value={grade}>{grade}</option>}
                </For>
              </optgroup>
              <optgroup label="高中">
                <For each={["高一", "高二", "高三"]}>
                  {(grade) => <option value={grade}>{grade}</option>}
                </For>
              </optgroup>
            </select>
          </label>
          <ErrorBanner message={studentError()} />
          <p class="muted">仅保存在本机，用于试卷归档。</p>
        </Modal>
      </Show>
    </>
  );
}
