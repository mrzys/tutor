import { Show, createMemo } from "solid-js";
import { FileText } from "lucide-solid";
import { teacherReferenceAvailability } from "./teacher-reference";
import "./Paper.css";

/** Teacher workspaces opt in explicitly; never render this inside PaperSheet. */
export function ReferenceAvailability(props: { question: any; teacher?: boolean; compact?: boolean }) {
  const status = createMemo(() => teacherReferenceAvailability(props.question, props.teacher === true));
  return <Show when={status()?.message}><p class="teacher-reference-status" classList={{ "is-compact": props.compact }} aria-label="教师参考材料状态">
    <FileText size={14} aria-hidden="true" />
    <span>{status()!.message}<Show when={status()!.pendingAi}>；另有 AI 稿待复核</Show>。<Show when={!props.compact}>原卷可无参考材料，</Show>可继续组卷。</span>
  </p></Show>;
}
