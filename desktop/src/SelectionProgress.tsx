import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import { Check, RotateCcw, Square, TriangleAlert } from "lucide-solid";
import type { SelectionStep } from "./selection-progress";
import { WorkflowTimeline } from "./WorkflowTimeline";
import { RichText } from "./Paper";
import "./PreparationConversation.css";

export type SelectionRun = {
  runId: string;
  blueprint: any;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "succeeded" | "failed" | "cancelled";
  stopping?: boolean;
  requestStarted?: boolean;
  backendFinished?: boolean;
  error?: string;
  result?: any;
  steps?: SelectionStep[];
};

export function SelectionProgress(props: {
  run: SelectionRun;
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
  const stepInfo = {
    select_pool: { title: "读取选题条件与题库", description: "核对已确认的题位，读取真实题目与当前版本。" },
    select_evaluate: { title: "比较候选题目", description: "由模型比较考查点、难度和已学边界，记录实际可用候选。" },
    select_save: { title: "生成并保存草稿", description: "核对题目版本与重复情况，保留真实缺题位，保存草稿。" },
  };
  return <section class="preparation-conversation selection-progress" aria-label="选题进度">
    <header class="preparation-page-heading"><h1>选题并生成草稿</h1><time class="preparation-duration muted" aria-label={`耗时 ${duration()} 秒`} aria-live="off">{duration()} 秒</time></header>
    <Show when={props.run.status === "running"} fallback={
      <div class="preparation-assistant">
        <p class="preparation-status" role="status"><Show when={props.run.status === "succeeded"} fallback={props.run.status === "cancelled" ? <Square size={16} /> : <TriangleAlert size={18} />}><Check size={18} /></Show><strong>{props.run.status === "succeeded" ? "草稿已保存" : props.run.status === "cancelled" ? "已停止选题" : "选题未完成"}</strong></p>
        <Show when={props.run.status === "failed"}><div class="preparation-failure" role="alert"><RichText text={props.run.error || "选题未完成，请重试。"} /></div></Show>
        <Show when={props.run.status !== "succeeded"}><p class="muted">已确认的题位规划已保留。</p></Show>
        <div class="preparation-actions">
          <button type="button" class="secondary" onClick={props.onBack}>返回题位规划</button>
          <Show when={props.run.status === "succeeded"} fallback={<button type="button" class="primary" onClick={props.onRetry}><RotateCcw size={16} />重新选题</button>}><button type="button" class="primary" onClick={props.onReview}>查看草稿</button></Show>
        </div>
      </div>
    }>
      <WorkflowTimeline steps={props.run.steps} info={stepInfo} />
      <Show when={props.run.error}><div class="preparation-failure" role="alert"><RichText text={props.run.error || ""} /></div></Show>
      <footer class="preparation-controls"><button type="button" class="secondary" disabled={props.run.stopping} onClick={props.onStop}><Square size={14} />{props.run.stopping ? "正在停止…" : "停止"}</button></footer>
    </Show>
  </section>;
}
