import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js";
import { teachingAnalysisPresentation, teachingFocusPresentation } from "./shared/teaching-analysis.mjs";
import { teachingIssueRows, teachingPatchFieldLabel, type TeachingIssueRow, type TeachingReviewControls } from "./import-review";

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
  onDirtyChange?: (dirty: boolean) => void;
};

const teachingChecks = [
  ["sourceMatched", "已对照原题和实际材料"],
  ["answerChecked", "已核对生成答案"],
  ["solutionChecked", "已核对相关推导"],
  ["formulaChecked", "已核对公式、图片与表格"],
] as const;

function TeachingIssueAction(props: TeachingReviewActionsProps & { issue: TeachingIssueRow }) {
  const [kind, setKind] = createSignal("");
  const [basis, setBasis] = createSignal("");
  const [checks, setChecks] = createSignal<Record<string, boolean>>({});
  const [failure, setFailure] = createSignal("");
  createEffect(() => props.onDirtyChange?.(Boolean(kind() || basis().trim() || Object.values(checks()).some(Boolean))));
  onCleanup(() => props.onDirtyChange?.(false));
  const canSubmit = () => Boolean(kind() && basis().trim() && teachingChecks.every(([key]) => checks()[key] === true));
  async function acknowledge(event: SubmitEvent) {
    event.preventDefault();
    if (props.disabled || !canSubmit()) return;
    setFailure("");
    try { await props.onAcknowledge(props.issue, kind(), basis(), checks()); }
    catch (error: any) { setFailure(error.message || "核对结果未保存，请重试。"); }
  }
  return <section class="import-teaching-issue" data-testid="teaching-issue" data-disposition={props.issue.disposition}>
    <p><strong>{props.issue.acknowledged && props.issue.disposition === "informative" ? "已核对提醒" : "待核对意见"}：</strong>{props.renderText(props.issue.issue)}</p>
    <Show when={props.issue.acknowledged && props.issue.basis}><p class="muted">核对依据：{props.renderText(props.issue.basis || "")}</p></Show>
    <Show when={props.controls?.canAcknowledge && props.issue.acknowledgeable && !props.issue.acknowledged}>
      <details><summary>核对并保留为提醒</summary>
        <p class="muted">仅当本条不影响题目与教学稿使用时，才可保留为提醒。数学错误、条件矛盾或必要依据不足应继续待处理；不能以确认代替修正。</p>
        <form onSubmit={acknowledge}>
          <fieldset class="import-manual-fields" disabled={props.disabled}>
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
            <div class="import-teaching-actions"><button type="button" class="text-button" onClick={() => { setKind(""); setBasis(""); setChecks({}); setFailure(""); }}>撤销本条填写</button><button type="submit" class="secondary" disabled={!canSubmit()}>保存本条核对</button></div>
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
  const [path, setPath] = createSignal("");
  const [oldText, setOldText] = createSignal("");
  const [replacement, setReplacement] = createSignal("");
  const [basis, setBasis] = createSignal("");
  const [confirmed, setConfirmed] = createSignal(false);
  const [failure, setFailure] = createSignal("");
  const [issueDrafts, setIssueDrafts] = createSignal<Record<string, boolean>>({});
  let identity = "";
  let editorDetails: HTMLDetailsElement | undefined;
  let replacementInput: HTMLTextAreaElement | undefined;
  createEffect(() => {
    const next = `${props.question?.questionId}|${props.controls?.candidateSha256 || ""}|${props.controls?.sourceContentSha256 || ""}`;
    if (next !== identity) {
      identity = next;
      setPath(""); setOldText(""); setReplacement(""); setBasis(""); setConfirmed(false); setFailure("");
    }
  });
  let previousEditRequest = 0;
  createEffect(() => {
    const request = props.editRequest || 0;
    if (!request || request === previousEditRequest) { previousEditRequest = request; return; }
    previousEditRequest = request;
    const field = props.controls?.editableFields?.find(field => field.path === props.editFieldPath)
      || props.controls?.editableFields?.find(field => field.path === "teachingSolution") || props.controls?.editableFields?.[0];
    if (field && (!path() || Boolean(props.editFieldPath) && field.path !== path())) selectField(field.path);
    if (editorDetails) editorDetails.open = true;
    requestAnimationFrame(() => replacementInput?.focus());
  });
  createEffect(() => props.onDirtyChange?.(Boolean(replacement() !== oldText() || basis().trim() || Object.values(issueDrafts()).some(Boolean))));
  onCleanup(() => props.onDirtyChange?.(false));
  function selectField(fieldPath: string) {
    if (path() && fieldPath !== path() && (replacement() !== oldText() || basis().trim())) {
      setFailure("当前字段有未保存修改，请先保存或撤销本次编辑，再切换字段。");
      return;
    }
    const value = props.controls?.editableFields?.find(field => field.path === fieldPath)?.value || "";
    setPath(fieldPath); setOldText(value); setReplacement(value); setBasis(""); setConfirmed(false); setFailure("");
  }
  const changed = () => Boolean(path() && replacement().trim() && replacement() !== oldText());
  async function patch(event: SubmitEvent) {
    event.preventDefault();
    if (props.disabled || !changed() || !basis().trim() || !confirmed()) return;
    setFailure("");
    try {
      await props.onPatch(path(), oldText(), replacement(), basis());
      if (editorDetails) editorDetails.open = false;
    }
    catch (error: any) { setFailure(error.message || "局部修订未保存，请重试。"); }
  }
  return <Show when={props.controls}>
    <section class="import-teaching-controls" aria-label="教学稿核对与局部修订">
      <Show when={issues().length}>
        <details><summary>核对记录与提醒（{issues().length}）</summary>
          <For each={issues()}>{issue => {
            const id = `${issue.issueIndex}:${issue.issueSha256}`;
            return <TeachingIssueAction {...props} issue={issue}
              disabled={props.disabled || replacement() !== oldText() || Boolean(basis().trim()) || Object.entries(issueDrafts()).some(([key, dirty]) => key !== id && dirty)}
              onDirtyChange={value => setIssueDrafts(items => ({ ...items, [id]: value }))} />;
          }}</For>
        </details>
      </Show>
      <Show when={props.controls?.canPatch}>
        <details ref={editorDetails} class="import-teaching-editor"><summary>修改AI解析</summary>
          <Show when={props.disabledReason}><p class="muted">{props.disabledReason}</p></Show>
          <form onSubmit={patch} data-testid="teaching-patch-form">
            <fieldset class="import-manual-fields" disabled={props.disabled || Object.values(issueDrafts()).some(Boolean)}>
              <label class="field-label">修改内容
                <select aria-label="教学稿修订字段" value={path()} onChange={event => { selectField(event.currentTarget.value); event.currentTarget.value = path(); }}>
                  <option value="">请选择一个字段</option>
                  <For each={props.controls?.editableFields || []}>{field => <option value={field.path}>{teachingPatchFieldLabel(field.path)}</option>}</For>
                </select>
              </label>
              <Show when={path()}>
                <label class="field-label">内容<textarea ref={replacementInput} rows={path() === "teachingSolution" ? 9 : 3} aria-label="教学稿修改后内容" value={replacement()} onInput={event => { setReplacement(event.currentTarget.value); setConfirmed(false); }} /></label>
                <details class="import-edit-comparison"><summary>查看原文与排版对照</summary><p><strong>修改前</strong></p>{props.renderText(oldText())}<Show when={changed()}><p><strong>修改后</strong></p>{props.renderText(replacement())}</Show></details>
                <label class="field-label">修改依据<textarea rows={2} maxLength={5000} aria-label="教学稿局部修订依据" value={basis()} placeholder="简述修改及核对依据" onInput={event => setBasis(event.currentTarget.value)} /></label>
                <label class="check-row"><input type="checkbox" checked={confirmed()} onChange={event => setConfirmed(event.currentTarget.checked)} />已核对修改前后内容及受影响的结论</label>
                <Show when={failure()}><p class="warning-text" role="alert">{failure()}</p></Show>
                <div class="import-teaching-actions"><button type="button" class="text-button" onClick={() => { setReplacement(oldText()); setBasis(""); setConfirmed(false); setFailure(""); if (editorDetails) editorDetails.open = false; }}>取消</button><button type="submit" class="primary" disabled={!changed() || !basis().trim() || !confirmed()}>保存解析修改</button></div>
              </Show>
            </fieldset>
          </form>
        </details>
      </Show>
    </section>
  </Show>;
}
