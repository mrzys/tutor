import { For, Show, type JSX } from "solid-js";
import { ArrowLeft, ListPlus } from "lucide-solid";
import type { importReviewSummary } from "./import-review-flow";

export function ImportReviewHeader(props: {
  title: string; summary: ReturnType<typeof importReviewSummary>; filter: string;
  disabled: boolean; onBack: () => void; onFilter: (filter: string) => void;
  headingRef: (element: HTMLHeadingElement) => void; tools: JSX.Element;
  annotationCount: number; annotationDisabled: boolean; annotationReason: string; onAnnotation: () => void;
  publishDisabled: boolean; publishPrimary: boolean; onPublish: () => void;
  accuracy?: boolean;
}) {
  const extra = () => ["published", "duplicate", "rejected", "both_ready"].includes(props.filter) ? props.filter : "";
  return <header class="import-review-header">
    <div class="import-review-title-row">
      <button type="button" class="text-button import-history-back" aria-label="导入记录" title="返回导入记录"
        disabled={props.disabled} onClick={props.onBack}><ArrowLeft size={18} /></button>
      <h1 ref={props.headingRef} tabIndex={-1} title={props.title}>{props.title}</h1>
      <div class="import-review-paper-actions">
        <Show when={props.annotationCount > 0}><button type="button" class="text-button import-annotation-start"
          disabled={props.annotationDisabled} title={props.annotationReason} onClick={props.onAnnotation}>
          <ListPlus size={16} /><span>考查信息</span><span class="import-annotation-count">{props.annotationCount} 题待补</span>
        </button></Show>
        <button type="button" class={props.publishPrimary ? "primary" : "secondary"} disabled={props.publishDisabled}
          onClick={props.onPublish}>将 {props.summary.sourceReady} 道{props.accuracy ? "题" : "原题"}入库</button>
        {props.tools}
      </div>
    </div>
    <div class="import-review-filter-row">
      <nav class="import-review-filters" aria-label="题目筛选">
        <For each={[["all", "全部", props.summary.total], ["source_pending", props.accuracy ? "待处理" : "待核对原题", props.summary.sourcePending], ["source_ready", "可入库", props.summary.sourceReady]]}>{([id, label, count]) =>
          <button type="button" classList={{current:props.filter === id}} aria-pressed={props.filter === id}
            disabled={props.disabled} onClick={() => props.onFilter(String(id))}>{label}<span>{count}</span></button>
        }</For>
      </nav>
      <div class="import-review-other-tasks">
        <Show when={!props.accuracy && (props.summary.teachingPending > 0 || props.filter === "teaching")}>
          <button type="button" class="text-button" classList={{current:props.filter === "teaching"}} aria-pressed={props.filter === "teaching"}
            disabled={props.disabled} onClick={() => props.onFilter("teaching")}>AI内容待办 <span>{props.summary.teachingPending}</span></button>
        </Show>
        <select aria-label="更多题目筛选" value={extra()} disabled={props.disabled} onChange={event => { if (event.currentTarget.value) props.onFilter(event.currentTarget.value); }}>
          <option value="" disabled>更多筛选</option>
          <option value="published">已入库 {props.summary.published}</option>
          <option value="duplicate">重复题 {props.summary.duplicate}</option>
          <option value="rejected">未采用 {props.summary.rejected}</option>
          <Show when={!props.accuracy}><option value="both_ready">原题与AI稿可入库 {props.summary.bothReady}</option></Show>
        </select>
      </div>
    </div>
  </header>;
}
