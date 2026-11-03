import { For, Show, type JSX } from "solid-js";
import { Pencil } from "lucide-solid";
import type { TriageIssue } from "./import-triage";
import { ReviewMessage } from "./ReviewMessage";

/** Rich text remains selectable/readable; a click opens the exact AI field.
 * Existing links, images and marked-issue controls retain their own actions. */
export function TeachingEditableField(props: {
  path: string; label: string; editable: boolean; issues: readonly TriageIssue[];
  onEdit: (path: string) => void; children: JSX.Element; class?: string;
}) {
  return <div class={`import-teaching-field ${props.class || ""}`} classList={{ "is-editable": props.editable }}
    data-import-field={`teaching:${props.path}`} tabIndex={-1}
    onClick={event => {
      if (!props.editable || (event.target as HTMLElement).closest("button,a,input,select,textarea,img,[role=button]")) return;
      if (window.getSelection()?.toString()) return;
      props.onEdit(props.path);
    }}>
    {props.children}
    <For each={props.issues.filter(issue => issue.target?.fieldPath === props.path)}>{issue => <p class="import-teaching-field-issue"><ReviewMessage text={issue.message} /></p>}</For>
    <Show when={props.editable}><button type="button" class="text-button import-teaching-field-edit"
      aria-label={`修改${props.label}`} title={`修改${props.label}`} onClick={() => props.onEdit(props.path)}><Pencil size={15} /></button></Show>
  </div>;
}
