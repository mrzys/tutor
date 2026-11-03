import { For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { ArrowRight, Pencil } from "lucide-solid";
import { teachingAnalysisPresentation, teachingFocusPresentation } from "./shared/teaching-analysis.mjs";
import { teachingIssueRows, teachingPatchFieldLabel, type TeachingIssueRow, type TeachingReviewControls } from "./import-review";
import { Modal } from "./ui";
import { MathSnippetBar } from "./MathSnippetBar";
import { createTeachingEditDraft, teachingEditCanSave, teachingEditCurrent, teachingEditDirty, teachingEditIdentity, type TeachingEditDraft } from "./teaching-edit";
import "./TeachingAnalysis.css";

type TeachingMaterialProps = {
  question: any;
  teacher?: boolean;
  formalKnowledge?: string[];
  renderText: (text: string) => JSX.Element;
};

/** Kept separate from the solution so hosts can place the teaching focus
 * before the answer without repeating it beneath the AI explanation. */
export function TeachingFocus(props: TeachingMaterialProps) {
  const focus = createMemo(() => teachingFocusPresentation(props.question, props.teacher === true, props.formalKnowledge));
  return <Show when={focus()}>{item =>
    <section class="teaching-focus" aria-label="教学考查信息">
      <h4>教学考查信息</h4>
      <p class="question-detail-note">
        {item().originLabel}的题目分析<Show when={item().model}> · {item().model}</Show>
        <Show when={item().needsReview}> · <span class="warning-text">{item().statusLabel}</span></Show>
      </p>
      <p><strong>{item().knowledgeLabel}：</strong>{props.renderText(item().knowledgePoints.join("；") || "未单独标注")}</p>
      <p><strong>{item().examFocusLabel}：</strong>{props.renderText(item().examFocus.trim() ? item().examFocus : "未单独标注")}</p>
      <p><strong>对学生的要求：</strong></p>
      <Show when={item().studentRequirements.length} fallback={<p>未单独标注</p>}>
        <ul><For each={item().studentRequirements}>{requirement => <li>{props.renderText(requirement)}</li>}</For></ul>
      </Show>
    </section>
  }</Show>;
}

/** Accept the host's rich-text renderer so question details and Paper can use
 * the same teacher-only presentation without importing Paper in a cycle. */
export function TeachingAnalysis(props: TeachingMaterialProps) {
  const analysis = createMemo(() => teachingAnalysisPresentation(props.question, props.teacher === true));
  return <Show when={analysis()}>{item =>
    <section class="teaching-analysis" aria-label="AI教学解析">
      <h4>{item().label}</h4>
      <p class="question-detail-note">{item().originLabel}<Show when={item().model}> · {item().model}</Show></p>
      <Show when={item().needsReview}>
        <p class="warning-text" role="status">待复核：本次教学解析仍有待核对的问题。</p>
        <Show when={item().issues.length}>
          <ul class="teaching-analysis-issues"><For each={item().issues}>{issue => <li>{props.renderText(issue)}</li>}</For></ul>
        </Show>
      </Show>
      <Show when={item().notices?.length}>
        <details class="teaching-analysis-notices"><summary>已核对提醒（{item().notices.length}）</summary>
          <p class="question-detail-note">原始意见保留，已核对为不影响本教学稿使用的提醒。</p>
          <ul><For each={item().notices}>{notice => <li>{props.renderText(notice.message)}<Show when={notice.basis}><p class="question-detail-note">{notice.reviewerLabel}依据：{props.renderText(notice.basis)}</p></Show></li>}</For></ul>
        </details>
      </Show>
      <Show when={item().answer}><p><strong>生成答案：</strong>{props.renderText(item().answer)}</p></Show>
      <div class="teaching-analysis-solution">{props.renderText(item().solution)}</div>
    </section>
  }</Show>;
}

type TeachingReviewActionsProps = {
  question: any;
  controls?: TeachingReviewControls;
  disabled: boolean;
  disabledReason?: string;
  renderText: (text: string) => JSX.Element;
  onAcknowledge: (issue: TeachingIssueRow, kind: string, basis: string, checks: Record<string, boolean>) => Promise<void>;
  onPatch: (fieldPath: string, oldText: string, newText: string, basis: string) => Promise<void>;
  editRequest?: number;
  editFieldPath?: string;
  /** Increment only after the parent has confirmed discarding local input. */
  discardRequest?: number;
  onEditRequestHandled?: (request: number) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
};

const teachingChecks = [
  ["sourceMatched", "已对照原题和实际材料"],
  ["answerChecked", "已核对生成答案"],
  ["solutionChecked", "已核对相关推导"],
  ["formulaChecked", "已核对公式、图片与表格"],
] as const;

function TeachingIssueAction(props: TeachingReviewActionsProps & { issue: TeachingIssueRow; onSavingChange?: (saving: boolean) => void }) {
  const [kind, setKind] = createSignal("");
  const [basis, setBasis] = createSignal("");
  const [checks, setChecks] = createSignal<Record<string, boolean>>({});
  const [failure, setFailure] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  let previousDiscardRequest = props.discardRequest || 0;
  createEffect(() => {
    const request = props.discardRequest || 0;
    if (request === previousDiscardRequest) return;
    previousDiscardRequest = request;
    setKind(""); setBasis(""); setChecks({}); setFailure("");
  });
  createEffect(() => props.onDirtyChange?.(Boolean(kind() || basis().trim() || Object.values(checks()).some(Boolean))));
  createEffect(() => props.onSavingChange?.(saving()));
  onCleanup(() => { props.onDirtyChange?.(false); props.onSavingChange?.(false); });
  const canSubmit = () => Boolean(kind() && basis().trim() && teachingChecks.every(([key]) => checks()[key] === true));
  async function acknowledge(event: SubmitEvent) {
    event.preventDefault();
    if (props.disabled || saving() || !canSubmit()) return;
    setFailure("");
    setSaving(true);
    try {
      await props.onAcknowledge(props.issue, kind(), basis(), checks());
      setKind(""); setBasis(""); setChecks({});
    }
    catch (error: any) { setFailure(error.message || "核对结果未保存，请重试。"); }
    finally { setSaving(false); }
  }
  return <section class="import-teaching-issue" data-testid="teaching-issue" data-disposition={props.issue.disposition}>
    <p><strong>{props.issue.acknowledged && props.issue.disposition === "informative" ? "已核对提醒" : "待核对意见"}：</strong>{props.renderText(props.issue.issue)}</p>
    <Show when={props.issue.acknowledged && props.issue.basis}><p class="muted">核对依据：{props.renderText(props.issue.basis || "")}</p></Show>
    <Show when={props.controls?.canAcknowledge && props.issue.acknowledgeable && !props.issue.acknowledged}>
      <details><summary>核对并保留为提醒</summary>
        <p class="muted">仅当本条不影响题目与教学稿使用时，才可保留为提醒。数学错误、条件矛盾或必要依据不足应继续待处理；不能以确认代替修正。</p>
        <form onSubmit={acknowledge}>
          <fieldset class="import-manual-fields" disabled={props.disabled || saving()}>
            <label class="field-label">意见性质
              <select aria-label="教学稿意见性质" value={kind()} onChange={event => setKind(event.currentTarget.value)}>
                <option value="">请选择已核实的性质</option>
                <option value="reference_notice">原参考笔误，不影响本教学稿</option>
                <option value="nonblocking_observation">背景说明或过度提醒，不影响本教学稿</option>
              </select>
            </label>
            <div class="import-check-grid"><For each={teachingChecks}>{([key, label]) =>
              <label class="check-row"><input type="checkbox" checked={checks()[key] === true} onChange={event => setChecks({ ...checks(), [key]: event.currentTarget.checked })} /><span>{label}</span></label>
            }</For></div>
            <div class="import-check-helpers">
              <button type="button" class="text-button" onClick={() => setChecks({ sourceMatched: true, answerChecked: true, solutionChecked: true, formulaChecked: true })}>一键勾选4项</button>
              <button type="button" class="text-button" onClick={() => {
                if (!kind()) setKind("nonblocking_observation");
                setChecks({ sourceMatched: true, answerChecked: true, solutionChecked: true, formulaChecked: true });
                setBasis("已对照原题与推导步骤，本条意见属于参考说明/非阻断提示，不影响教学稿使用。");
              }}>填入常规核查依据</button>
            </div>
            <label class="field-label">本条核对依据
              <textarea rows={3} maxLength={5000} aria-label="教学稿告警核对依据" placeholder="说明对照了哪些原文、图片或计算，为什么这条意见不影响教学稿使用。" value={basis()} onInput={event => setBasis(event.currentTarget.value)} />
            </label>
            <Show when={failure()}><p class="warning-text" role="alert">{failure()}</p></Show>
            <div class="import-teaching-actions"><button type="button" class="text-button" onClick={() => { setKind(""); setBasis(""); setChecks({}); setFailure(""); }}>撤销本条填写</button><button type="submit" class="secondary" disabled={!canSubmit() || saving()}>{saving() ? "保存中…" : "保存本条核对"}</button></div>
          </fieldset>
        </form>
      </details>
    </Show>
  </section>;
}

/** Explicit, source-bound actions in the import review. Opening or editing
 * this form performs no model call and never writes source transcription. */
export function TeachingReviewActions(props: TeachingReviewActionsProps) {
  const issues = createMemo(() => teachingIssueRows(props.question, props.controls));
  const currentIdentity = createMemo(() => teachingEditIdentity(props.question, props.controls));
  const [open, setOpen] = createSignal(false);
  const [reviewOpen, setReviewOpen] = createSignal(false);
  const [draft, setDraft] = createSignal<TeachingEditDraft | null>(null);
  const [failure, setFailure] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [discardRequested, setDiscardRequested] = createSignal(false);
  const [mathActive, setMathActive] = createSignal(false);
  const [issueDrafts, setIssueDrafts] = createSignal<Record<string, boolean>>({});
  const [issueSaving, setIssueSaving] = createSignal<Record<string, boolean>>({});
  const [issueReset, setIssueReset] = createSignal(0);
  const [reviewDiscardRequested, setReviewDiscardRequested] = createSignal(false);
  const formId = `teaching-edit-${createUniqueId()}`;
  let replacementInput: HTMLTextAreaElement | undefined;
  const issueDirty = () => Object.values(issueDrafts()).some(Boolean);
  const reviewSaving = () => Object.values(issueSaving()).some(Boolean);
  const draftCurrent = () => !draft() || teachingEditCurrent(draft()!, props.question, props.controls);
  const editorDisabled = () => props.disabled || saving() || issueDirty() || !draftCurrent();
  const canSave = () => !editorDisabled() && teachingEditCanSave(draft(), props.question, props.controls);
  const longField = () => Boolean(draft() && (draft()!.fieldPath === "teachingSolution" || draft()!.oldText.length > 400 || draft()!.oldText.split("\n").length > 6));
  createEffect(() => props.onDirtyChange?.(teachingEditDirty(draft()) || issueDirty()));
  createEffect(() => props.onOpenChange?.(open() || reviewOpen()));
  onCleanup(() => { props.onDirtyChange?.(false); props.onOpenChange?.(false); });
  let previousEditRequest = 0;
  let previousDiscardRequest = props.discardRequest || 0;
  createEffect(() => {
    const request = props.discardRequest || 0;
    if (request === previousDiscardRequest) return;
    previousDiscardRequest = request;
    discardEditor();
    discardReview();
  });
  createEffect(() => {
    const request = props.editRequest || 0;
    if (!request || request === previousEditRequest) { previousEditRequest = request; return; }
    previousEditRequest = request;
    openEditor(props.editFieldPath);
    props.onEditRequestHandled?.(request);
  });
  function openEditor(fieldPath = "") {
    if (saving()) return;
    setOpen(true);
    if (draft() && teachingEditDirty(draft())) {
      if (fieldPath && fieldPath !== draft()!.fieldPath) setFailure("当前字段有未保存修改，请先保存或取消本次编辑，再修改其他字段。");
      return;
    }
    setFailure("");
    if (fieldPath) selectField(fieldPath);
    else setDraft(null);
  }
  function selectField(fieldPath: string) {
    if (saving()) return;
    if (draft() && teachingEditDirty(draft())) {
      setFailure("当前字段有未保存修改，请先保存或撤销本次编辑，再切换字段。");
      return;
    }
    const next = createTeachingEditDraft(props.question, props.controls, fieldPath);
    if (!next) { setFailure("该字段当前不可修改，请重新读取本题后再试。"); return; }
    setDraft(next); setFailure(""); setMathActive(false);
    requestAnimationFrame(() => replacementInput?.focus());
  }
  function updateDraft(changes: Partial<TeachingEditDraft>) {
    setDraft(value => value ? { ...value, ...changes } : value);
  }
  function closeEditor() {
    if (saving()) return;
    if (teachingEditDirty(draft())) { setDiscardRequested(true); return; }
    discardEditor();
  }
  function discardEditor() {
    if (saving()) return;
    setDiscardRequested(false); setDraft(null); setFailure(""); setOpen(false); setMathActive(false);
  }
  function closeReview() {
    if (reviewSaving()) return;
    if (issueDirty()) { setReviewDiscardRequested(true); return; }
    discardReview();
  }
  function discardReview() {
    if (reviewSaving()) return;
    setReviewOpen(false); setReviewDiscardRequested(false);
    setIssueDrafts({}); setIssueReset(value => value + 1);
  }
  function chooseAnotherField() {
    if (teachingEditDirty(draft())) {
      setFailure("当前字段有未保存修改，请先保存或取消本次编辑，再修改其他字段。");
      return;
    }
    setDraft(null); setFailure(""); setMathActive(false);
  }
  function insertSnippet(snippet: string) {
    const input = replacementInput;
    if (!input || editorDisabled()) return;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    updateDraft({ replacement: draft()!.replacement.slice(0, start) + snippet + draft()!.replacement.slice(end), confirmed: false });
    input.focus();
    const cursor = start + (snippet === "$$" ? 1 : snippet.length);
    input.setSelectionRange(cursor, cursor);
  }
  async function patch(event: SubmitEvent) {
    event.preventDefault();
    if (!canSave()) return;
    const submitted = draft()!;
    setFailure(""); setSaving(true);
    try {
      await props.onPatch(submitted.fieldPath, submitted.oldText, submitted.replacement, submitted.basis);
      setDraft(null); setDiscardRequested(false); setOpen(false);
    }
    catch (error: any) { setFailure(error.message || "局部修订未保存，请重试。"); }
    finally { setSaving(false); }
  }
  const issueActions = () => <For each={issues().map(issue => `${currentIdentity()}:${issue.issueIndex}:${issue.issueSha256}`)}>{id => {
    const initialIssue = issues().find(item => `${currentIdentity()}:${item.issueIndex}:${item.issueSha256}` === id)!;
    const issue = () => issues().find(item => `${currentIdentity()}:${item.issueIndex}:${item.issueSha256}` === id) || initialIssue;
    return <TeachingIssueAction {...props} issue={issue()} discardRequest={issueReset()}
      disabled={props.disabled || open() || teachingEditDirty(draft()) || Object.entries(issueDrafts()).some(([key, dirty]) => key !== id && dirty)}
      onDirtyChange={value => setIssueDrafts(items => ({ ...items, [id]: value }))}
      onSavingChange={value => setIssueSaving(items => ({ ...items, [id]: value }))} />;
  }}</For>;
  return <>
    <Show when={props.controls && (!props.hideTrigger || issues().length)}>
    <section class="import-teaching-controls" aria-label="教学稿核对与局部修订">
      <Show when={issues().length}>
        <Show when={props.hideTrigger} fallback={<details><summary>核对记录与提醒（{issues().length}）</summary>{issueActions()}</details>}>
          <button type="button" class="text-button teaching-review-options" disabled={saving() || open()} onClick={() => setReviewOpen(true)}>查看本题复核选项</button>
        </Show>
      </Show>
      <Show when={props.controls?.canPatch && !props.hideTrigger}>
        <button type="button" class="text-button" disabled={props.disabled || issueDirty()} onClick={() => openEditor()}><Pencil size={15} />修改AI解析</button>
      </Show>
    </section>
    </Show>
    <Show when={open() || reviewOpen()}><Portal>
      <div class="teaching-edit-dialog" data-long={longField()} on:keydown={event => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); event.stopPropagation(); }
      }}>
        <Show when={open()}><Modal title={draft() ? `修改${teachingPatchFieldLabel(draft()!.fieldPath)}` : "修改AI解析"} wide={Boolean(draft())} stable={false} busy={saving()} onClose={closeEditor}
          footer={<>
            <button type="button" class="secondary" disabled={saving()} onClick={closeEditor}>取消</button>
            <Show when={draft()}><button type="submit" form={formId} class="primary" disabled={!canSave()}>{saving() ? "保存中…" : "保存修改"}</button></Show>
          </>}>
          <Show when={draft()} fallback={<>
            <p class="teaching-edit-context">选择要修改的内容。</p>
            <Show when={props.disabledReason}><p class="muted">{props.disabledReason}</p></Show>
            <Show when={issueDirty()}><p class="warning-text">请先保存或撤销尚未完成的意见核对，再修改解析。</p></Show>
            <div class="teaching-edit-fields"><For each={props.controls?.editableFields || []}>{field =>
              <button type="button" class="teaching-edit-field" disabled={props.disabled || issueDirty()} onClick={() => selectField(field.path)}>
                <span><strong>{teachingPatchFieldLabel(field.path)}</strong><small>{field.value.replace(/\s+/g, " ").slice(0, 90) || "暂无内容"}</small></span><ArrowRight size={18} aria-hidden="true" />
              </button>
            }</For></div>
            <Show when={failure()}><p class="warning-text" role="alert">{failure()}</p></Show>
          </>}>{value => <>
            <p class="teaching-edit-context">原题号 {value().questionLabel} · {teachingPatchFieldLabel(value().fieldPath)} <button type="button" class="text-button" disabled={saving()} onClick={chooseAnotherField}>选择其他字段</button></p>
            <Show when={!draftCurrent()}><p class="warning-text" role="alert">本题或教学稿版本已变化，输入已保留。请取消本次编辑并重新打开当前字段后再修改。</p></Show>
            <Show when={props.disabledReason}><p class="muted">{props.disabledReason}</p></Show>
            <form id={formId} class="teaching-edit-form" onSubmit={patch} data-testid="teaching-patch-form">
              <fieldset class="import-manual-fields" disabled={editorDisabled()}>
                <div class="teaching-edit-comparison">
                  <section class="teaching-edit-original"><h3>修改前</h3><div class="teaching-edit-original-content">{props.renderText(value().oldText)}</div></section>
                  <section class="teaching-edit-replacement" onFocusIn={() => setMathActive(true)}><h3>修改后</h3>
                    <Show when={mathActive() && !editorDisabled()}><MathSnippetBar onInsert={insertSnippet} /></Show>
                    <textarea ref={replacementInput} rows={longField() ? 8 : 3} aria-label="教学稿修改后内容" value={value().replacement} onInput={event => updateDraft({ replacement: event.currentTarget.value, confirmed: false })} />
                  </section>
                </div>
                <details class="teaching-edit-preview"><summary>预览修改后的排版</summary><div>{props.renderText(value().replacement)}</div></details>
                <div class="teaching-edit-audit-card">
                  <label class="field-label teaching-edit-basis">修改依据（必填）<textarea rows={2} maxLength={5000} aria-label="教学稿局部修订依据" value={value().basis} placeholder="简述修改及核对依据" onInput={event => updateDraft({ basis: event.currentTarget.value })} /></label>
                  <label class="check-row"><input type="checkbox" checked={value().confirmed} onChange={event => updateDraft({ confirmed: event.currentTarget.checked })} /><span>已核对修改前后内容及受影响的结论</span></label>
                </div>

              </fieldset>
              <Show when={failure()}><p class="warning-text" role="alert">{failure()}</p></Show>
            </form>
          </>}</Show>
        </Modal></Show>
        <Show when={reviewOpen()}><Modal title="本题复核选项" wide stable={false} busy={reviewSaving()} onClose={closeReview}
          footer={<button type="button" class="secondary" disabled={reviewSaving()} onClick={closeReview}>关闭</button>}>
          <div class="teaching-review-options-content">{issueActions()}</div>
        </Modal></Show>
        <Show when={discardRequested()}>
          <Modal title="放弃本次修改？" onClose={() => setDiscardRequested(false)} footer={<>
            <button type="button" class="secondary" onClick={() => setDiscardRequested(false)}>继续编辑</button>
            <button type="button" class="primary" onClick={discardEditor}>放弃修改</button>
          </>}><p>本次修改尚未保存。放弃后会保留原来的内容。</p></Modal>
        </Show>
        <Show when={reviewDiscardRequested()}>
          <Modal title="放弃本次核对填写？" onClose={() => setReviewDiscardRequested(false)} footer={<>
            <button type="button" class="secondary" onClick={() => setReviewDiscardRequested(false)}>继续填写</button>
            <button type="button" class="primary" onClick={discardReview}>放弃填写</button>
          </>}><p>本次核对尚未保存。已保存的意见与记录保持不变。</p></Modal>
        </Show>
      </div>
    </Portal></Show>
  </>;
}
