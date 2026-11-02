export type ImportSourceFieldRequest = {
  id: number;
  identity: string;
  fieldPath: string;
  label: string;
  oldText: string;
};

type SourceField = { owner: Record<string, unknown>; key: string };

/** Only existing source text is editable here. Array structure, source assets,
 * metadata and AI work remain the responsibility of their explicit editors. */
function sourceField(question: unknown, path: string): SourceField | null {
  if (!question || typeof question !== "object" || Array.isArray(question)) return null;
  let owner = question as Record<string, unknown>;
  let key = path;
  if (!["stem", "answer", "solution"].includes(path)) {
    const match = /^(options|parts)\[(0|[1-9]\d*)\]\.(text|stem|prompt|answer|solution)$/.exec(path);
    if (!match || (match[1] === "options" ? match[3] !== "text" : match[3] === "text")) return null;
    const index = Number(match[2]);
    const rows = owner[match[1]];
    if (!Object.hasOwn(owner, match[1]) || !Number.isSafeInteger(index) || !Array.isArray(rows)
      || !Object.hasOwn(rows, index) || !rows[index] || typeof rows[index] !== "object" || Array.isArray(rows[index])) return null;
    owner = rows[index];
    key = match[3];
  }
  return Object.hasOwn(owner, key) && typeof owner[key] === "string" ? { owner, key } : null;
}

export function readImportSourceField(question: unknown, path: string): string | null {
  const field = sourceField(question, path);
  return field ? field.owner[field.key] as string : null;
}

/** Recheck the exact opened text before making a detached copy. Do not trim,
 * normalize, fill missing fields or reconstruct any unrelated source data. */
export function replaceImportSourceField<T>(question: T, path: string, oldText: string, newText: string): T {
  if (typeof oldText !== "string" || typeof newText !== "string") throw new Error("原文字段必须是文本。");
  const field = sourceField(question, path);
  if (!field) throw new Error("该原文字段不可编辑，请重新读取本题。");
  if (field.owner[field.key] !== oldText) throw new Error("原文字段已变化，输入已保留，请重新读取本题后再修改。");
  const next = structuredClone(question);
  const target = sourceField(next, path)!;
  target.owner[target.key] = newText;
  return next;
}

export type ImportSourceEditDraft = ImportSourceFieldRequest & { replacement: string };
export const importSourceEditDirty = (draft: ImportSourceEditDraft | null): boolean => Boolean(draft && draft.replacement !== draft.oldText);
export const importSourceEditCurrent = (draft: ImportSourceEditDraft | null, identity: string): boolean => Boolean(draft && draft.identity && draft.identity === identity);
