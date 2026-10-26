import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import { Check, RotateCcw, Square, TriangleAlert } from "lucide-solid";
import type { BlueprintStep } from "./blueprint-progress";
import { WorkflowTimeline } from "./WorkflowTimeline";
import "./PreparationConversation.css";

export type BlueprintRun = {
  runId: string;
  requirements: any;
  mode: string;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "succeeded" | "failed" | "cancelled";
  stopping?: boolean;
  requestStarted?: boolean;
  backendFinished?: boolean;
  error?: string;
  result?: any;
  steps?: BlueprintStep[];
};

export function BlueprintProgress(props: {
  run: BlueprintRun;
  onStop: () => void;
  onRetry: () => void;
  onBack: () => void;
  onReview: () => void;
}) {
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (props.run.status !== "running") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  const duration = () => Math.max(0, Math.floor(((props.run.finishedAt || now()) - props.run.startedAt) / 1000));
  const stepInfo = () => ({
    plan_supply: { title: "读取规划上下文", description: "读取已确认条件与真实题库库存，交给模型安排题位。" },
    plan_slots: { title: "安排考查点与题位", description: "根据已确认的要求，安排各题位的考查点与顺序。" },
    plan_check: { title: "校验题位规划", description: "检查题量、分值与考查范围，保留供给缺口，等待你确认。" },
  });
  return <section class="preparation-conversation blueprint-progress" aria-label="题位规划进度">
    <header class="preparation-page-heading"><h1>安排题位</h1><time class="preparation-duration muted" aria-label={`耗时 ${duration()} 秒`} aria-live="off">{duration()} 秒</time></header>
    <Show when={props.run.status === "running"} fallback={
      <div class="preparation-assistant">
        <p class="preparation-status" role="status"><Show when={props.run.status === "succeeded"} fallback={props.run.status === "cancelled" ? <Square size={16} /> : <TriangleAlert size={18} />}><Check size={18} /></Show><strong>{props.run.status === "succeeded" ? "题位已安排，等待你确认" : props.run.status === "cancelled" ? "已停止安排题位" : "题位安排未完成"}</strong></p>
        <Show when={props.run.status === "failed"}><p class="preparation-failure" role="alert">{props.run.error}</p></Show>
        <Show when={props.run.status !== "succeeded"}><p class="muted">已确认的需求已保留。</p></Show>
        <div class="preparation-actions">
          <button type="button" class="secondary" onClick={props.onBack}>返回需求确认</button>
          <Show when={props.run.status === "succeeded"} fallback={<button type="button" class="primary" onClick={props.onRetry}><RotateCcw size={16} />重新安排</button>}><button type="button" class="primary" onClick={props.onReview}>查看并确认题位</button></Show>
        </div>
      </div>
    }>
      <WorkflowTimeline steps={props.run.steps} info={stepInfo()} />
      <Show when={props.run.error}><p class="preparation-failure" role="alert">{props.run.error}</p></Show>
      <footer class="preparation-controls"><button type="button" class="secondary" disabled={props.run.stopping} onClick={props.onStop}><Square size={14} />{props.run.stopping ? "正在停止…" : "停止"}</button></footer>
    </Show>
  </section>;
}
