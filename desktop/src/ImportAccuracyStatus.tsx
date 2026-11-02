import { For, Show, createMemo, createSignal } from "solid-js";
import { Portal } from "solid-js/web";
import { operationId, request } from "./bridge";
import { ErrorBanner, Modal } from "./ui";
import "./ImportAccuracyStatus.css";
import { accuracyActionCanSubmit, accuracyActionCurrent, accuracyActionPayload, accuracyBudget, accuracyCanReviewDomain, accuracyDomainLabel, accuracyDomains,
  accuracyEvidence, accuracyFieldLabel, accuracyFindings, accuracyScopeCurrent, accuracyScopePayload, accuracyStatus, createAccuracyActionDraft, createAccuracyScopeDraft,
  type AccuracyAction, type AccuracyActionDraft, type AccuracyDomain, type AccuracyScopeDraft } from "./import-accuracy";

export function createAccuracyStatusSession() {
  const [draft, setDraft] = createSignal<AccuracyActionDraft | null>(null);
  const [open, setOpen] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [failure, setFailure] = createSignal("");
  const [scopeDraft, setScopeDraft] = createSignal<AccuracyScopeDraft | null>(null);
  const [rejectedIdentity, setRejectedIdentity] = createSignal<string | null>(null);
  return { draft, setDraft, open, setOpen, saving, setSaving, failure, setFailure, scopeDraft, setScopeDraft, rejectedIdentity, setRejectedIdentity, activeOperationId: null as string | null };
}

export function beginAccuracyStatusAction(session: ReturnType<typeof createAccuracyStatusSession>, question: any, importId: string, revision: number, kind: AccuracyAction, domain: AccuracyDomain = "source") {
  if (session.saving()) return;
  const draft = session.draft();
  if (draft?.kind !== kind || draft?.domain !== domain || !accuracyActionCurrent(draft, question, importId, revision) || draft.identity === session.rejectedIdentity()) {
    const next = createAccuracyActionDraft(question, importId, revision, kind, domain, operationId());
    if (!next) return;
    session.setDraft(next);
    session.setFailure("");
  }
  session.setOpen(true);
}

export function ImportAccuracyStatus(props: { question: any; importId: string; revision: number; disabled?: boolean; onChange: (result: any) => void; session?: ReturnType<typeof createAccuracyStatusSession> }) {
  const status = createMemo(() => accuracyStatus(props.question));
  const findings = createMemo(() => accuracyFindings(props.question));
  const budget = createMemo(() => accuracyBudget(props.question));
  const evidence = createMemo(() => accuracyEvidence(props.question));
  const session = props.session || createAccuracyStatusSession();
  const { draft, setDraft, open, setOpen, saving, setSaving, failure, setFailure, scopeDraft, setScopeDraft, rejectedIdentity, setRejectedIdentity } = session;
  const current = () => Boolean(draft() && draft()!.identity !== rejectedIdentity() && accuracyActionCurrent(draft()!, props.question, props.importId, props.revision));
  const canSubmit = () => !props.disabled && !saving() && current() && accuracyActionCanSubmit(draft(), props.question, props.importId, props.revision);
  const savedScope = () => props.question?.accuracy?.publicationScope === "source_only" ? "source_only" : "source_and_teaching";
  const canSaveScope = () => !props.disabled && !saving() && scopeDraft()?.identity !== rejectedIdentity() && scopeDraft()?.publicationScope !== savedScope() && accuracyScopeCurrent(scopeDraft(), props.question, props.importId, props.revision);
  async function saveScope() {
    if (!canSaveScope()) return;
    const selected = scopeDraft()!;
    session.activeOperationId = selected.operationId;
    setFailure(""); setSaving(true);
    try {
      const result = await request("import_accuracy_scope_save", accuracyScopePayload(selected, props.question, props.importId, props.revision));
      if (session.activeOperationId === selected.operationId) { props.onChange(result); setScopeDraft(null); }
    } catch (error: any) { if (session.activeOperationId === selected.operationId) { if (error?.code === "revision_conflict") setRejectedIdentity(selected.identity); setFailure(error?.message || "发布范围未保存，选择已保留。"); } }
    finally { if (session.activeOperationId === selected.operationId) { session.activeOperationId = null; setSaving(false); } }
  }
  function begin(kind: AccuracyAction, domain: AccuracyDomain = "source") {
    if (props.disabled || saving()) return;
    beginAccuracyStatusAction(session, props.question, props.importId, props.revision, kind, domain);
  }
  function edit(values: Partial<Pick<AccuracyActionDraft, "basis" | "acknowledge">>) {
    if (saving()) return;
    setDraft(value => value ? { ...value, ...values, operationId: operationId() } : value);
  }
  async function submit(event?: SubmitEvent) {
    event?.preventDefault();
    if (!canSubmit()) return;
    const selected = draft()!;
    session.activeOperationId = selected.operationId;
    setFailure(""); setSaving(true);
    try {
      const payload = accuracyActionPayload(selected, props.question, props.importId, props.revision);
      const result = await request(selected.kind === "review" ? "import_accuracy_review" : "import_accuracy_repair_start", payload);
      if (session.activeOperationId === selected.operationId) { props.onChange(result); setOpen(false); setDraft(null); }
    } catch (error: any) {
      if (session.activeOperationId === selected.operationId) { if (error?.code === "revision_conflict") setRejectedIdentity(selected.identity); setFailure(error?.message || "操作未完成，填写内容已保留。"); }
    } finally { if (session.activeOperationId === selected.operationId) { session.activeOperationId = null; setSaving(false); } }
  }
  return <Show when={status()}>{overall => <section class="import-accuracy-status" aria-label="分域核对">
    <p role="status"><strong>{overall().stageLabel}</strong> · {overall().label}<Show when={overall().reason}>：{overall().reason}</Show></p>
    <For each={accuracyDomains}>{domain => <div class="import-teaching-actions">
      <strong>{domain.label}</strong><span>{accuracyStatus(props.question, domain.id)?.label || "尚未完成核对"}</span>
      <Show when={accuracyStatus(props.question, domain.id)?.reason && accuracyStatus(props.question, domain.id)?.reason !== accuracyStatus(props.question, domain.id)?.label}><span class="muted">{accuracyStatus(props.question, domain.id)?.reason}</span></Show>
      <Show when={accuracyCanReviewDomain(props.question, domain.id)}><button type="button" class="text-button" disabled={props.disabled || saving()} onClick={() => begin("review", domain.id)}>人工核对{domain.label}</button></Show>
    </div>}</For>
    <Show when={findings().length}><details><summary>具体问题（{findings().length}）</summary>
      <For each={findings()}>{finding => <div><p><strong>{accuracyDomainLabel(finding.domain)}<Show when={accuracyFieldLabel(finding.fieldPath)}> · {accuracyFieldLabel(finding.fieldPath)}</Show>：</strong>{finding.message}</p>
        <Show when={finding.basis}><p class="muted">核对依据：{finding.basis}</p></Show>
      </div>}</For>
    </details></Show>
    <Show when={evidence().length}><details><summary>核对依据与分歧</summary><For each={evidence()}>{domain => <section><h4>{domain.label}</h4>
      <Show when={domain.basis}><p>{domain.basis}</p></Show><For each={domain.checks}>{check => <p><strong>{check.label} · {check.status}：</strong>{check.basis}</p>}</For>
      <For each={domain.disagreements}>{item => <section><p><strong>{item.label}</strong></p><Show when={item.claimA}><p>候选结论：{item.claimA}</p></Show><Show when={item.claimB}><p>独立解结论：{item.claimB}</p></Show>
        <Show when={item.stepA}><p>候选步骤：{item.stepA}</p></Show><Show when={item.stepB}><p>独立解步骤：{item.stepB}</p></Show><Show when={item.basis}><p>核对依据：{item.basis}</p></Show>
      </section>}</For>
    </section>}</For></details></Show>
    <details><summary>本次发布范围 · {savedScope() === "source_only" ? "原题及组卷信息" : "原题及AI答案解析、考查信息"}</summary>
      <label class="field-label">本次发布范围<select aria-label="本次发布范围" disabled={props.disabled || saving() || props.question?.accuracy?.canReview !== true}
        value={scopeDraft()?.publicationScope || savedScope()} onChange={event => { setScopeDraft(createAccuracyScopeDraft(props.question, props.importId, props.revision, event.currentTarget.value, operationId())); setFailure(""); }}>
        <option value="source_and_teaching">原题及AI答案解析、考查信息</option><option value="source_only">原题及组卷信息（不含AI答案解析）</option>
      </select></label>
      <p class="muted">原题始终保留实际原卷参考；不采用AI答案解析时，仍可能包含主考知识、解法依赖和难度，须完成相应核对，不能绕过已知问题。</p>
      <Show when={scopeDraft() && !accuracyScopeCurrent(scopeDraft(), props.question, props.importId, props.revision)}><p class="warning-text">题目或允许操作已变化，请重新读取后选择本次范围。</p></Show>
      <button type="button" class="secondary" disabled={!canSaveScope()} onClick={saveScope}>{saving() ? "保存中…" : "保存发布范围"}</button>
    </details>
    <Show when={!open() && failure()}><ErrorBanner message={failure()} /></Show>
    <Show when={budget()}>{value => <details><summary>额度与处理记录 · {value().calls}</summary>
      <p class="muted">当前阶段：{overall().stageLabel}</p><p class="muted">{value().input}</p><p class="muted">{value().output}</p><p class="muted">{value().unknown}</p><p class="muted">{value().time}</p>
    </details>}</Show>
    <Show when={props.question?.accuracy?.canRepair === true}><div class="import-teaching-actions"><button type="button" class="secondary" disabled={props.disabled || saving()} onClick={() => begin("repair")}>按具体问题修订一次</button></div></Show>
    <Show when={open() && draft()}>{value => <Portal><div class="import-accuracy-dialog"><Modal title={draft()!.kind === "review" ? `人工核对${accuracyDomainLabel(draft()!.domain)}` : "按具体问题修订一次"} busy={saving()} onClose={() => { if (!saving()) setOpen(false); }}
      footer={<><button type="button" class="secondary" disabled={saving()} onClick={() => setOpen(false)}>返回阅读</button><button type="button" class="primary" disabled={!canSubmit()} onClick={() => submit()}>{saving() ? "保存中…" : draft()!.kind === "review" ? "保存实际核对" : "发起一次修订"}</button></>}>
      <form onSubmit={submit}>
        <p>{draft()!.kind === "review" ? "请实际对照原页或核算推导，说明本次核对的内容、依据及结论。教师核对不要求模型先同意；只点确认不能清除实质问题。" : "说明要修订的具体字段、问题及依据。本次只发起一次有界修订及必要复验，失败或仍有疑点时保留待处理。"}</p>
        <ErrorBanner message={failure()} />
        <Show when={!current()}><p class="warning-text" role="alert">题目或允许操作已变化，填写内容仍保留；请返回阅读后重新核对当前版本。</p></Show>
        <fieldset class="import-manual-fields" disabled={props.disabled || saving()}>
          <label class="field-label">具体依据（8–4000字）<textarea rows={5} maxLength={4000} aria-label={draft()!.kind === "review" ? "本域实际核对依据" : "本次具体修订依据"} value={draft()!.basis}
            placeholder={draft()!.kind === "review" ? "写明对照的原页位置、具体计算或证明步骤，以及核对结论。" : "写明需要改动的位置、当前问题及修订要求。"} onInput={event => edit({ basis: event.currentTarget.value })} /></label>
          <label class="check-row"><input type="checkbox" checked={draft()!.acknowledge} onChange={event => edit({ acknowledge: event.currentTarget.checked })} /><span>{draft()!.kind === "review" ? "我已实际核对本域材料与结论，以上是本次具体依据" : "我已明确本次问题，发起一次修订并核验新版本"}</span></label>
        </fieldset>
      </form>
    </Modal></div></Portal>}</Show>
  </section>}</Show>;
}
