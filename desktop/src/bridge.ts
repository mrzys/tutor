import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { PreparationProgressEvent } from "./preparation-progress";
import type { BlueprintProgressEvent } from "./blueprint-progress";
import type { SelectionProgressEvent } from "./selection-progress";
import { createAssemblyTraceTracker } from "./shared/assembly-log-trace.mjs";

const assemblyTrace = createAssemblyTraceTracker();
export const currentAssemblyTraceId = assemblyTrace.current;
export const beginAssemblyTrace = assemblyTrace.begin;
export function subscribeAssemblyTrace(listener: (id: string) => void) { return assemblyTrace.subscribe(listener); }

declare global {
  interface Window {
    __TUTOR_DESKTOP_REQUEST__?: (
      action: string,
      payload: unknown,
    ) => Promise<any>;
    __TUTOR_DESKTOP_CANCEL__?: () => Promise<void>;
    __TUTOR_DESKTOP_LISTEN_PROGRESS__?: (handler: (event: PreparationProgressEvent) => void) => Promise<() => void>;
    __TUTOR_DESKTOP_LISTEN_BLUEPRINT_PROGRESS__?: (handler: (event: BlueprintProgressEvent) => void) => Promise<() => void>;
    __TUTOR_DESKTOP_LISTEN_SELECTION_PROGRESS__?: (handler: (event: SelectionProgressEvent) => void) => Promise<() => void>;
  }
}

export async function listenPreparationProgress(handler: (event: PreparationProgressEvent) => void) {
  if (import.meta.env.DEV && window.__TUTOR_DESKTOP_LISTEN_PROGRESS__) return window.__TUTOR_DESKTOP_LISTEN_PROGRESS__(handler);
  return listen<PreparationProgressEvent>("intake-progress", event => handler(event.payload));
}

export async function listenBlueprintProgress(handler: (event: BlueprintProgressEvent) => void) {
  if (import.meta.env.DEV && window.__TUTOR_DESKTOP_LISTEN_BLUEPRINT_PROGRESS__) return window.__TUTOR_DESKTOP_LISTEN_BLUEPRINT_PROGRESS__(handler);
  return listen<BlueprintProgressEvent>("blueprint-progress", event => handler(event.payload));
}

export async function listenSelectionProgress(handler: (event: SelectionProgressEvent) => void) {
  if (import.meta.env.DEV && window.__TUTOR_DESKTOP_LISTEN_SELECTION_PROGRESS__) return window.__TUTOR_DESKTOP_LISTEN_SELECTION_PROGRESS__(handler);
  return listen<SelectionProgressEvent>("selection-progress", event => handler(event.payload));
}

export async function request(action: string, payload: any = {}): Promise<any> {
  try {
    const tracedPayload = assemblyTrace.payload(action, payload);
    const result =
      import.meta.env.DEV && window.__TUTOR_DESKTOP_REQUEST__
        ? await window.__TUTOR_DESKTOP_REQUEST__(action, tracedPayload)
        : await invoke("desktop_request", { action, payload: tracedPayload });
    if (result?.ok === false) throw result.error;
    return result;
  } catch (error: any) {
    let failure = error;
    if (typeof error === "string") {
      try {
        failure = JSON.parse(error);
      } catch {
        failure = { message: error };
      }
    }
    const normalized = new Error(
      failure?.message || "操作未完成，请重试。",
    ) as Error & { code?: string };
    normalized.code = failure?.code;
    throw normalized;
  }
}

export async function cancel() {
  if (import.meta.env.DEV && window.__TUTOR_DESKTOP_CANCEL__)
    return window.__TUTOR_DESKTOP_CANCEL__();
  await invoke("desktop_cancel");
}
export const operationId = () => crypto.randomUUID();
export const typeIds = [
  "single_choice",
  "multiple_choice",
  "fill_blank",
  "free_response",
];
export const displayTypeIds = typeIds;
export const typeLabels: Record<string, string> = {
  single_choice: "单选",
  multiple_choice: "多选",
  fill_blank: "填空",
  free_response: "解答",
};
export const typeTitles: Record<string, string> = {
  single_choice: "单项选择题",
  multiple_choice: "多项选择题",
  fill_blank: "填空题",
  free_response: "解答题",
};
export const purposes = [
  {
    id: "consolidation",
    label: "课后巩固",
    description:
      "围绕近期授课内容安排练习，巩固理解与运用，发现需要补充讲解的问题。",
  },
  {
    id: "targeted_practice",
    label: "专项训练",
    description: "针对教师已发现的薄弱知识或方法，安排有重点、逐步递进的练习。",
  },
  {
    id: "diagnostic",
    label: "学情诊断",
    description:
      "用有代表性的题目检查指定知识点，供教师结合学生作答判断掌握情况。",
  },
];
export const purposeLabel = (id: string) =>
  purposes.find((item) => item.id === id)?.label || "练习";
export function studentsOf(value: any): any[] {
  const candidates = [
    ...(Array.isArray(value?.students) ? value.students : []),
    ...(value?.student ? [value.student] : []),
    ...(value?.requirements?.student ? [value.requirements.student] : []),
    ...(value?.baseline?.requirements?.student
      ? [value.baseline.requirements.student]
      : []),
    ...(value?.draft?.baseline?.requirements?.student
      ? [value.draft.baseline.requirements.student]
      : []),
  ];
  return candidates.filter(
    (item, index) =>
      item?.name &&
      candidates.findIndex(
        (other) =>
          (other.studentId || other.name) === (item.studentId || item.name),
      ) === index,
  );
}
