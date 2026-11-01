import { For, Show, createMemo } from "solid-js";
import { RichText } from "./Paper";
import type { TriageIssue } from "./import-triage";
import { reviewTextMarks, type ReviewTextBinding } from "./review-text-marks";

/** Import-review only. Call with raw candidate text and its bound findings;
 * source questions, editor values, persisted candidates and PDF are untouched. */
export function ReviewMarkedText(props: {
  text: string;
  fieldPath: string;
  issues: readonly TriageIssue[];
  question?: any;
  binding?: ReviewTextBinding;
  projectText?: (value: string) => string;
  onSelectIssue?: (issueId: string) => void;
}) {
  const presentation = createMemo(() => reviewTextMarks(props.text, props.fieldPath, props.issues, props.binding, props.projectText));
  return <>
    <Show when={presentation().unlocatedIssueIds.length}>
      <span class="import-review-field-note" data-review-field-note={props.fieldPath}>
        此字段有 {presentation().unlocatedIssueIds.length} 项疑点，具体位置暂无法可靠标注。
        <Show when={props.onSelectIssue}><button class="text-button" type="button" onClick={() => props.onSelectIssue?.(presentation().unlocatedIssueIds[0])}>查看疑点</button></Show>
      </span>
    </Show>
    <For each={presentation().runs}>{run => <Show when={run.issueIds.length} fallback={<RichText text={run.text} question={props.question} teacher />}>
      <mark class="import-review-mark" data-review-issue-ids={run.issueIds.join(" ")}
        role={props.onSelectIssue ? "button" : undefined} tabIndex={props.onSelectIssue ? 0 : undefined}
        title="此处有待核对疑点" aria-label={props.onSelectIssue ? `查看此处 ${run.issueIds.length} 项疑点` : undefined}
        onClick={() => props.onSelectIssue?.(run.issueIds[0])}
        onKeyDown={event => { if (props.onSelectIssue && ["Enter", " "].includes(event.key)) { event.preventDefault(); props.onSelectIssue(run.issueIds[0]); } }}>
        <RichText text={run.text} question={props.question} teacher />
      </mark>
    </Show>}</For>
  </>;
}
