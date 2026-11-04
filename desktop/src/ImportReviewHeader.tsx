import { For, Show, type JSX } from "solid-js";
import { ArrowLeft, ListPlus } from "lucide-solid";
import type { importReviewSummary } from "./import-review-flow";

export type ImportReviewPrimaryFilter = "all" | "source_pending" | "source_ready";

export function ImportReviewHeader(props: {
  title: string; summary: ReturnType<typeof importReviewSummary>; filter: ImportReviewPrimaryFilter;
  disabled: boolean; onBack: () => void; onFilter: (filter: ImportReviewPrimaryFilter) => void;
  headingRef: (element: HTMLHeadingElement) => void; tools: JSX.Element;
  annotationCount: number; annotationDisabled: boolean; annotationReason: string; onAnnotation: () => void;
  publishDisabled: boolean; publishPrimary: boolean; onPublish: () => void;
  publishReason?: string;
  accuracy?: boolean;
  pendingBreakdown?: { technical: number; content: number; confirmation: number; budget: number; processing: number };
}) {
  return <header class="import-review-header">
    <div class="import-review-title-row">
      <button type="button" class="text-button import-history-back" aria-label="导入记录" title="返回导入记录"
        disabled={props.disabled} onClick={props.onBack}><ArrowLeft size={18} /></button>
      <h1 ref={props.headingRef} tabIndex={-1} title={props.title}>{props.title}</h1>
      <div class="import-review-paper-actions">
        <Show when={props.summary.total > 0}>
        <Show when={props.annotationCount > 0}><button type="button" class="text-button import-annotation-start"
          disabled={props.annotationDisabled} title={props.annotationReason} onClick={props.onAnnotation}>
          <ListPlus size={16} /><span>考查信息</span><span class="import-annotation-count">{props.annotationCount} 题待补</span>
        </button></Show>
        <button type="button" class={props.publishPrimary ? "primary" : "secondary"} disabled={props.publishDisabled}
          title={props.publishReason || "确认本次题目与内容范围后入库"} aria-describedby={props.publishDisabled ? "import-publication-blocked-reason" : undefined}
          onClick={props.onPublish}>将 {props.summary.sourceReady} 道{props.accuracy ? "题" : "原题"}入库</button>
        </Show>
        {props.tools}
      </div>
    </div>
    <Show when={props.summary.total > 0}><div class="import-review-filter-row">
      <nav class="import-review-filters" aria-label="题目筛选">
        <For each={[["all", "全部", props.summary.total], ["source_pending", props.accuracy ? "待处理" : "待核对原题", props.summary.sourcePending], ["source_ready", "可入库", props.summary.sourceReady]] as const}>{([id, label, count]) =>
          <button type="button" classList={{current:props.filter === id}} aria-pressed={props.filter === id}
            disabled={props.disabled} onClick={() => props.onFilter(id)}>{label}<span>{count}</span></button>
        }</For>
      </nav>
      <Show when={props.publishDisabled && props.publishReason}><p class="import-publication-blocked-reason muted" id="import-publication-blocked-reason" role="status">{props.publishReason}</p></Show>
    </div></Show>
    <Show when={props.accuracy && props.summary.sourcePending > 0 && props.pendingBreakdown}>
      <p class="import-pending-breakdown" aria-label="待处理分类"><For each={[
        ["technical", "处理异常"], ["content", "内容待核对"], ["confirmation", "待完成核对"], ["budget", "额度暂停"], ["processing", "处理中"],
      ] as const}>{([kind, label]) => <Show when={props.pendingBreakdown?.[kind]}><span><strong>{props.pendingBreakdown?.[kind]}</strong> 题{label}</span></Show>}</For><span class="muted">选择题目可查看原因和下一步。</span></p>
    </Show>
  </header>;
}
