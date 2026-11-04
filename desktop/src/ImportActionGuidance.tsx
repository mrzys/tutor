import { For, Show } from "solid-js";
import { accuracyDomainLabel, accuracyFieldLabel, type AccuracyDomain } from "./import-accuracy";
import type { AccuracyGuidance } from "./import-accuracy-guidance";
import { ReviewMessage } from "./ReviewMessage";

export function ImportActionGuidance(props: {
  guidance: AccuracyGuidance; disabled: boolean; canContinue: boolean;
  onContinue: () => void; onReview: (domain: AccuracyDomain) => void;
  onRepair: () => void; onDetails: () => void;
}) {
  const pending = () => !["ready", "published"].includes(props.guidance.kind);
  return <section class="import-action-guidance" data-kind={props.guidance.kind} aria-label="本题处理事项">
    <div class="import-action-guidance-heading"><strong>{props.guidance.label}</strong>
      <Show when={props.guidance.kind === "technical"}><span class="muted">处理未完成，需继续模型处理</span></Show>
    </div>
    <Show when={props.guidance.kind !== "content" || !props.guidance.issues.length}><p><ReviewMessage text={props.guidance.summary} /></p></Show>
    <Show when={props.guidance.kind === "content"}><ul aria-label="具体核对事项"><For each={props.guidance.issues}>{issue => <li>
      <strong>{accuracyDomainLabel(issue.domain)}<Show when={accuracyFieldLabel(issue.fieldPath)}> · {accuracyFieldLabel(issue.fieldPath)}</Show>：</strong><ReviewMessage text={issue.message} />
    </li>}</For></ul></Show>
    <Show when={pending()}><p class="muted">下一步：{props.guidance.nextStep}</p></Show>
    <div class="import-action-guidance-actions">
      <Show when={pending() && props.guidance.kind !== "processing" && !props.guidance.reviewDomain && props.canContinue}>
        <button type="button" class="primary" disabled={props.disabled} onClick={props.onContinue}>整卷继续未完成处理</button>
      </Show>
      <Show when={props.guidance.reviewDomain}>{domain => <button type="button" class="primary" disabled={props.disabled} onClick={() => props.onReview(domain())}>核对{accuracyDomainLabel(domain())}</button>}</Show>
      <Show when={props.guidance.canRepair}><button type="button" class="secondary" disabled={props.disabled} onClick={props.onRepair}>按具体问题修订一次</button></Show>
      <button type="button" class="text-button" onClick={props.onDetails}>{props.guidance.kind === "technical" || props.guidance.kind === "budget" ? "查看处理记录" : "查看核对依据与发布条件"}</button>
    </div>
  </section>;
}
