import type { TeachingReviewControls } from "./import-review";

export type TeachingEditDraft = {
  identity: string;
  questionLabel: string;
  fieldPath: string;
  oldText: string;
  replacement: string;
  basis: string;
  confirmed: boolean;
};

/** The editor retains the exact source/candidate binding it was opened for.
 * A fresh projection of the same snapshot must not replace local input. */
export function teachingEditIdentity(question: any, controls?: TeachingReviewControls): string {
  return JSON.stringify([question?.questionId || "", controls?.sourceContentSha256 || "", controls?.candidateSha256 || ""]);
}

export function createTeachingEditDraft(question: any, controls: TeachingReviewControls | undefined, fieldPath: string): TeachingEditDraft | null {
  const field = controls?.editableFields?.find(item => item.path === fieldPath);
  if (!controls?.canPatch || !field) return null;
  return { identity: teachingEditIdentity(question, controls), questionLabel: String(question?.sourceLabel || "本题"),
    fieldPath: field.path, oldText: field.value, replacement: field.value, basis: "", confirmed: false };
}

export function teachingEditDirty(draft: TeachingEditDraft | null): boolean {
  return Boolean(draft && (draft.replacement !== draft.oldText || draft.basis.trim() || draft.confirmed));
}

export function teachingEditCurrent(draft: TeachingEditDraft, question: any, controls?: TeachingReviewControls): boolean {
  return Boolean(controls?.canPatch && draft.identity === teachingEditIdentity(question, controls)
    && controls.editableFields?.some(field => field.path === draft.fieldPath && field.value === draft.oldText));
}

export function teachingEditCanSave(draft: TeachingEditDraft | null, question: any, controls?: TeachingReviewControls): boolean {
  return Boolean(draft && teachingEditCurrent(draft, question, controls) && draft.replacement.trim()
    && draft.replacement !== draft.oldText && draft.basis.trim() && draft.basis.length <= 5000 && draft.confirmed);
}
