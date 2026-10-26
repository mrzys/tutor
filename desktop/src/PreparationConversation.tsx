import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { Check, LoaderCircle, MessageSquare, RotateCcw, Square, TriangleAlert } from "lucide-solid";
import { purposeLabel, typeIds, typeLabels } from "./bridge";
import "./PreparationConversation.css";
import type { PresentedStep } from "./preparation-progress";
import { WorkflowTimeline } from "./WorkflowTimeline";
import { RichText } from "./Paper";
import { teachingDisplayText } from "./teaching-text";

export type PreparationRun = {
  runId: string;
  requirements: any;
  message: string;
  mode: string;
  studentOffset?: number;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "succeeded" | "failed" | "cancelled";
  stopping?: boolean;
  error?: string;
  result?: any;
  steps?: PresentedStep[];
  backendFinished?: boolean;
  requestStarted?: boolean;
};

export function PreparationConversation(props: {
  run: PreparationRun;
  config: any;
  compact?: boolean;
  onStop?: () => void;
  onRetry?: () => void;
  onEdit?: () => void;
  onReview?: () => void;
}) {
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (props.run.status !== "running") return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  const duration = () => Math.max(0, Math.floor(((props.run.finishedAt || now()) - props.run.startedAt) / 1000));
  const scopeNames = (requirements: any) => (requirements?.mainScope || []).map((id: string) =>
    props.config?.chapters?.find((chapter: any) => chapter.id === id)?.label || id,
  ).join("、");
  const result = () => props.run.result?.requirements;
  const quantity = () => typeIds.filter(type => result()?.counts?.[type]).map(type => `${typeLabels[type]} ${result().counts[type]} 题`).join("、");
  const stepInfo = {
    scope: { title: "识别考查范围", description: "理解你的原话，匹配真实教材目录。" },
    supply: { title: "读取题库库存", description: "读取真实题型库存，教学相关性与已学适配由模型判断。" },
    requirements: { title: "整理题量与要求", description: "核对题量、题型与考查重点，形成待你确认的需求。" },
  };
  const activeStep = () => props.run.steps?.find(step => step.active);
  const label = () => props.run.status === "running"
    ? props.run.stopping ? "正在停止…" : activeStep() ? `${stepInfo[activeStep()!.id].title}${activeStep()!.status === "completed" ? "已完成" : "中"}` : "正在准备工作区"
    : props.run.status === "succeeded" ? "已整理，等待你确认需求"
    : props.run.status === "cancelled" ? "已停止整理" : "需求整理未完成";

  const messages = () => <>
    <Show when={props.compact}>
    <article class="preparation-user">
      <span class="preparation-role">你</span>
      <p><RichText text={props.run.message.trim() || "按所选条件组卷"} /></p>
      <div class="preparation-context">{purposeLabel(props.run.requirements.purpose)}<Show when={scopeNames(props.run.requirements)}> · 已选 {scopeNames(props.run.requirements)}</Show></div>
    </article>
    </Show>
    <article class="preparation-assistant">
      <Show when={props.compact}>
      <div class="preparation-assistant-heading"><MessageSquare size={18} /><strong>组卷助手</strong><span class="muted">AI 辅助</span></div>
      </Show>
      <Show when={props.compact || props.run.status !== "running"}>
      <div class="preparation-status" role="status" aria-live="polite">
        <Show when={props.run.status === "running"} fallback={props.run.status === "succeeded" ? <Check size={18} /> : props.run.status === "cancelled" ? <Square size={16} /> : <TriangleAlert size={18} />}>
          <LoaderCircle size={18} class="spin" />
        </Show>
        <strong>{label()}</strong>
        <time class="muted" aria-label={`耗时 ${duration()} 秒`} aria-live="off">{duration()} 秒</time>
      </div>
      </Show>
      <Show when={props.run.status === "running"}>
        <WorkflowTimeline steps={props.run.steps} info={stepInfo} />
        <Show when={props.run.backendFinished}><p class="muted">已整理，即将进入需求确认。</p></Show>
      </Show>
      <Show when={props.run.status === "succeeded" && !props.compact}><div class="preparation-actions"><button type="button" class="primary" onClick={props.onReview}>查看并确认需求</button></div></Show>
      <Show when={props.run.status === "succeeded" && result()}>
        <ol class="preparation-results">
          <li><Check size={16} /><div><strong>考查范围</strong><p><RichText text={scopeNames(result())} /></p><Show when={result().scopeResolution?.rationale}><p class="muted"><RichText text={teachingDisplayText(result().scopeResolution.rationale)} /></p></Show></div></li>
          <li><Check size={16} /><div><strong>题量与题型</strong><p>{quantity()}</p></div></li>
          <li><Check size={16} /><div><strong>需求摘要</strong><p><RichText text={teachingDisplayText(result().goal || "已保留所选条件，请在下方核对。")} /></p></div></li>
        </ol>
        <Show when={props.run.result?.warnings?.length}>
          <ul class="preparation-warnings"><For each={props.run.result.warnings}>{warning => <li><RichText text={typeof warning === "string" ? warning : warning.message} /></li>}</For></ul>
        </Show>
      </Show>
      <Show when={props.run.status === "failed"}><p class="preparation-failure" role="alert">{props.run.error}</p></Show>
      <Show when={props.run.status === "failed" || props.run.status === "cancelled"}>
        <p class="muted">原始输入已保留，可以修改后重试。</p>
        <div class="preparation-actions"><button type="button" class="secondary" onClick={props.onEdit}>修改要求</button><button type="button" class="primary" onClick={props.onRetry}><RotateCcw size={16} />重新整理</button></div>
      </Show>
    </article>
  </>;

  return <section class="preparation-conversation" classList={{ "is-compact": props.compact }} aria-label="组卷对话">
    <Show when={!props.compact}><header class="preparation-page-heading"><h1>整理组卷要求</h1><Show when={props.run.status === "running"}><time class="preparation-duration muted" aria-label={`耗时 ${duration()} 秒`} aria-live="off">{duration()} 秒</time></Show></header></Show>
    <Show when={props.compact} fallback={<div class="preparation-messages">{messages()}</div>}>
      <details><summary><span><Check size={17} />{label()}</span><span class="muted">查看整理过程</span></summary><div class="preparation-messages">{messages()}</div></details>
    </Show>
    <Show when={props.run.status === "running"}>
      <footer class="preparation-controls"><button class="secondary" type="button" disabled={props.run.stopping} onClick={props.onStop}><Square size={14} />{props.run.stopping ? "正在停止…" : "停止"}</button></footer>
    </Show>
  </section>;
}
