import { For, Show } from "solid-js";
import { AlertCircle, CheckCircle2, Circle } from "lucide-solid";
import type { importConfirmationContext } from "./import-confirmation-context";
import { ReviewMessage } from "./ReviewMessage";

export function ImportConfirmationContext(props: { context: ReturnType<typeof importConfirmationContext> }) {
  return <div class="import-confirmation-context" aria-label="本题状态、确认范围与阻断原因">
    <ul class="import-confirmation-states" aria-label="本题核对状态">
      <For each={props.context.statuses}>{item => <li data-state={item.id} data-tone={item.tone}>
        <Show when={item.tone === "complete"} fallback={<Show when={item.tone === "blocked"} fallback={<Circle size={13} aria-hidden="true" />}><AlertCircle size={14} aria-hidden="true" /></Show>}>
          <CheckCircle2 size={14} aria-hidden="true" />
        </Show>
        <strong>{item.label}</strong><ReviewMessage text={item.status} />
      </li>}</For>
    </ul>
    <Show when={props.context.inlineScope}>
      <p class="import-confirmation-scope"><strong>本次操作</strong><ReviewMessage text={props.context.scope} /></p>
    </Show>
    <Show when={props.context.barriers.length}>
      <ul class="import-confirmation-barriers" aria-label="当前操作与入库的阻断原因" role="status" aria-live="polite">
        <For each={props.context.barriers}>{item => <li data-kind={item.kind}>
          <strong>{item.kind === "publication" ? "入库待处理" : "当前操作受阻"}</strong><ReviewMessage text={item.message} />
        </li>}</For>
      </ul>
    </Show>
  </div>;
}
