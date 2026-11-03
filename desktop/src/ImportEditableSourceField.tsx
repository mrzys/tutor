import { For, Show, type JSX } from "solid-js";
import { Pencil } from "lucide-solid";
import type { TriageIssue } from "./import-triage";
import { ReviewMessage } from "./ReviewMessage";

export function ImportEditableSourceField(props: {
  path: string; label: string; editable: boolean; issues: readonly TriageIssue[];
  onEdit: (path: string) => void; children: JSX.Element;
}) {
  return <div class="import-source-readable-field" classList={{ "is-editable": props.editable }}
    onClick={event => {
      if (!props.editable || (event.target as Element).closest("button,a,input,select,textarea,img,[role=button]") || window.getSelection()?.toString()) return;
      props.onEdit(props.path);
    }}>
    {props.children}
    <For each={props.issues.filter(issue => issue.domain === "source" && issue.target?.fieldPath === props.path)}>{issue =>
      <p class="import-source-field-issue"><ReviewMessage text={issue.message} /></p>
    }</For>
    <Show when={props.editable}><button type="button" class="text-button import-source-field-edit"
      aria-label={`修改${props.label}`} title={`修改${props.label}`} onClick={() => props.onEdit(props.path)}><Pencil size={15} /></button></Show>
  </div>;
}
