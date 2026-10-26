import { For, Show, createEffect, createMemo, createSignal, type JSX } from "solid-js";
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
            <label class="field-label">本条核对依据
              <textarea rows={3} maxLength={5000} aria-label="教学稿告警核对依据" placeholder="说明对照了哪些原文、图片或计算，为什么这条意见不影响教学稿使用。" value={basis()} onInput={event => setBasis(event.currentTarget.value)} />
            </label>
            <Show when={failure()}><p class="warning-text" role="alert">{failure()}</p></Show>
            <div class="import-teaching-actions"><button type="submit" class="secondary" disabled={!canSubmit()}>保存本条核对</button></div>
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
  let identity = "";
  createEffect(() => {
    const next = `${props.question?.questionId}|${props.controls?.candidateSha256 || ""}|${props.controls?.sourceContentSha256 || ""}`;
    if (next !== identity) {
      identity = next;
      setPath(""); setOldText(""); setReplacement(""); setBasis(""); setConfirmed(false); setFailure("");
    }
  });
  function selectField(fieldPath: string) {
    const value = props.controls?.editableFields?.find(field => field.path === fieldPath)?.value || "";
    setPath(fieldPath); setOldText(value); setReplacement(value); setConfirmed(false); setFailure("");
  }
  const changed = () => Boolean(path() && replacement().trim() && replacement() !== oldText());
  async function patch(event: SubmitEvent) {
    event.preventDefault();
    if (props.disabled || !changed() || !basis().trim() || !confirmed()) return;
    setFailure("");
    try { await props.onPatch(path(), oldText(), replacement(), basis()); }
    catch (error: any) { setFailure(error.message || "局部修订未保存，请重试。"); }
  }
  return <Show when={props.controls}>
    <section class="import-teaching-controls" aria-label="教学稿核对与局部修订">
      <Show when={issues().length}>
        <details open={issues().some(issue => !issue.acknowledged)}><summary>教学稿意见与已核对提醒（{issues().length}）</summary>
          <For each={issues()}>{issue => <TeachingIssueAction {...props} issue={issue} />}</For>
        </details>
      </Show>
      <Show when={props.controls?.canPatch}>
        <details><summary>局部修订教学稿</summary>
          <p class="muted">仅保存所选教学字段的修改，原题和原卷参考保持不变。请核对修改涉及的推导与结论。</p>
          <Show when={props.disabledReason}><p class="muted">{props.disabledReason}</p></Show>
          <form onSubmit={patch} data-testid="teaching-patch-form">
            <fieldset class="import-manual-fields" disabled={props.disabled}>
              <label class="field-label">需要修订的内容
                <select aria-label="教学稿修订字段" value={path()} onChange={event => selectField(event.currentTarget.value)}>
                  <option value="">请选择一个字段</option>
                  <For each={props.controls?.editableFields || []}>{field => <option value={field.path}>{teachingPatchFieldLabel(field.path)}</option>}</For>
                </select>
              </label>
              <Show when={path()}>
                <label class="field-label">修改前<textarea rows={path() === "teachingSolution" ? 4 : 2} readOnly aria-label="教学稿修改前内容" value={oldText()} /></label>
                <label class="field-label">修改后<textarea rows={path() === "teachingSolution" ? 6 : 3} aria-label="教学稿修改后内容" value={replacement()} onInput={event => { setReplacement(event.currentTarget.value); setConfirmed(false); }} /></label>
                <Show when={changed()}><details open><summary>核对修改前后</summary><p><strong>修改前</strong></p>{props.renderText(oldText())}<p><strong>修改后</strong></p>{props.renderText(replacement())}</details></Show>
                <label class="field-label">修订依据<textarea rows={2} maxLength={5000} aria-label="教学稿局部修订依据" value={basis()} placeholder="说明改了什么，以及核对了哪些相关推导或结论。" onInput={event => setBasis(event.currentTarget.value)} /></label>
                <label class="check-row"><input type="checkbox" checked={confirmed()} onChange={event => setConfirmed(event.currentTarget.checked)} />已核对修改前后内容及受影响的结论</label>
                <Show when={failure()}><p class="warning-text" role="alert">{failure()}</p></Show>
                <div class="import-teaching-actions"><button type="submit" class="secondary" disabled={!changed() || !basis().trim() || !confirmed()}>保存此处修订</button></div>
              </Show>
            </fieldset>
          </form>
        </details>
      </Show>
    </section>
  </Show>;
}
