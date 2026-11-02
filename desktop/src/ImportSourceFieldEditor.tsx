import { Show, createEffect, createSignal, createUniqueId, onCleanup, untrack, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { Modal } from "./ui";
import { MathSnippetBar } from "./MathSnippetBar";
import { importSourceEditCurrent, importSourceEditDirty, type ImportSourceEditDraft, type ImportSourceFieldRequest } from "./import-source-edit";
import "./ImportSourceFieldEditor.css";

export type ImportSourceFieldEditorProps = {
  request?: ImportSourceFieldRequest;
  currentIdentity: string;
  disabled: boolean;
  disabledReason?: string;
  renderText: (text: string) => JSX.Element;
  onSave: (newText: string) => Promise<void>;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onOpenChange?: (open: boolean) => void;
};

/** One explicit source edit. The parent owns the complete question/revision
 * snapshot and persists it through the existing source-review transaction. */
export function ImportSourceFieldEditor(props: ImportSourceFieldEditorProps) {
  const [draft, setDraft] = createSignal<ImportSourceEditDraft | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [failure, setFailure] = createSignal("");
  const [discardRequested, setDiscardRequested] = createSignal(false);
  const [mathActive, setMathActive] = createSignal(false);
  const formId = `import-source-field-${createUniqueId()}`;
  let replacementInput: HTMLTextAreaElement | undefined;
  let consumedRequest = -1;
  let hadRequest = false;
  const dirty = () => importSourceEditDirty(draft());
  const current = () => importSourceEditCurrent(draft(), props.currentIdentity) && draft()?.id === props.request?.id;
  const disabled = () => props.disabled || saving() || !current();
  const longField = () => Boolean(draft() && (/solution$/.test(draft()!.fieldPath) || draft()!.oldText.length > 400 || draft()!.oldText.split("\n").length > 6));
  createEffect(() => props.onDirtyChange?.(dirty()));
  createEffect(() => props.onOpenChange?.(Boolean(draft())));
  onCleanup(() => { props.onDirtyChange?.(false); props.onOpenChange?.(false); });
  createEffect(() => {
    const request = props.request;
    if (!request) {
      // Only removal is an explicit parent-approved discard. A changed live
      // identity must retain the input and disable submission instead.
      if (hadRequest) {
        setDraft(null); setFailure(""); setDiscardRequested(false); setMathActive(false);
      }
      hadRequest = false;
      return;
    }
    hadRequest = true;
    if (request.id === consumedRequest) return;
    consumedRequest = request.id;
    if (untrack(() => saving() || dirty())) {
      setFailure("当前字段有未保存修改，请先保存或放弃本次编辑。");
      return;
    }
    setDraft({ ...request, replacement: request.oldText });
    setFailure(""); setDiscardRequested(false); setMathActive(false);
    requestAnimationFrame(() => replacementInput?.focus());
  });
  function close() {
    if (saving()) return;
    if (dirty()) { setDiscardRequested(true); return; }
    discard();
  }
  function discard() {
    if (saving()) return;
    setDraft(null); setFailure(""); setDiscardRequested(false); setMathActive(false);
    props.onClose();
  }
  function insertSnippet(snippet: string) {
    const input = replacementInput;
    if (!input || disabled()) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    setDraft(value => value ? { ...value, replacement: value.replacement.slice(0, start) + snippet + value.replacement.slice(end) } : value);
    input.focus();
    const cursor = start + (snippet === "$$" ? 1 : snippet.length);
    input.setSelectionRange(cursor, cursor);
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (disabled() || !dirty()) return;
    const replacement = draft()!.replacement;
    setSaving(true); setFailure("");
    try {
      await props.onSave(replacement);
      setDraft(null); setDiscardRequested(false); setMathActive(false);
      props.onClose();
    } catch (error: any) {
      setFailure(error.message || "原文修改未保存，请重试。");
    } finally { setSaving(false); }
  }
  return <Show when={draft()}>{value => <Portal>
    <div class="import-source-field-dialog" data-long={longField()} on:keydown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); event.stopPropagation(); }
    }}>
      <Modal title={`修改${value().label}`} wide stable={false} busy={saving()} onClose={close} footer={<>
        <button type="button" class="secondary" disabled={saving()} onClick={close}>取消</button>
        <button type="submit" form={formId} class="primary" disabled={disabled() || !dirty()}>{saving() ? "保存中…" : "保存修改"}</button>
      </>}>
        <p class="import-source-field-context">{value().label}</p>
        <Show when={!current()}><p class="warning-text" role="alert">当前题目或版本已变化，输入已保留。请取消本次编辑，重新打开当前字段后再修改。</p></Show>
        <Show when={props.disabled && props.disabledReason}><p class="muted">{props.disabledReason}</p></Show>
        <form id={formId} class="import-source-field-form" onSubmit={save} data-testid="source-field-form">
          <fieldset disabled={disabled()}>
            <div class="import-source-field-comparison">
              <section><h3>修改前</h3><div class="import-source-field-original">{props.renderText(value().oldText)}</div></section>
              <section onFocusIn={() => setMathActive(true)}><h3>修改后</h3>
                <Show when={mathActive() && !disabled()}><MathSnippetBar onInsert={insertSnippet} /></Show>
                <textarea ref={replacementInput} rows={longField() ? 9 : 4} aria-label={`${value().label}修改后内容`} value={value().replacement}
                  onInput={event => setDraft(item => item ? { ...item, replacement: event.currentTarget.value } : item)} />
              </section>
            </div>
            <details class="import-source-field-preview"><summary>预览修改后的排版</summary><div>{props.renderText(value().replacement)}</div></details>
          </fieldset>
          <Show when={failure()}><p class="warning-text" role="alert">{failure()}</p></Show>
        </form>
      </Modal>
      <Show when={discardRequested()}><Modal title="放弃本次修改？" onClose={() => setDiscardRequested(false)} footer={<>
        <button type="button" class="secondary" onClick={() => setDiscardRequested(false)}>继续编辑</button>
        <button type="button" class="primary" onClick={discard}>放弃修改</button>
      </>}><p>本次修改尚未保存。放弃后会保留原来的内容。</p></Modal></Show>
    </div>
  </Portal>}</Show>;
}
