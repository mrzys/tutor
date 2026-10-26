import { For, Show } from "solid-js";
import { Check, LoaderCircle } from "lucide-solid";
import type { WorkflowStep } from "./workflow-progress";

export function WorkflowTimeline(props: {
  steps?: WorkflowStep[];
  info: Record<string, { title: string; description: string }>;
}) {
  return <Show when={props.steps?.length} fallback={<p class="preparation-pending" role="status">正在准备工作区…</p>}>
    <ol class="preparation-timeline" aria-label="执行步骤" aria-live="polite"><For each={props.steps}>{step => <li classList={{ "is-active": step.active, "is-completed": step.status === "completed" }} data-step={step.id} data-status={step.status}>
      <span class="preparation-step-icon"><Show when={step.status === "completed"} fallback={step.status === "running" ? <LoaderCircle size={18} class="spin" /> : <span class="preparation-step-dot" />}><Check size={18} /></Show></span>
      <div><strong>{props.info[step.id].title}</strong><p>{props.info[step.id].description}</p></div>
      <span class="preparation-step-state">{step.status === "completed" ? "已完成" : step.status === "running" ? "进行中" : "后续步骤"}</span>
    </li>}</For></ol>
  </Show>;
}
