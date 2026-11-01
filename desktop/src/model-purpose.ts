import { modelReasoningOptions, providerPreset, reasoningLabel, type ReasoningOption } from "./model-presets.ts";

export const importRoleDefinitions = [
  { id: "sourceParsing", label: "拆题", description: "将识别材料整理为题干、选项、小问及原卷参考。", recommendation: "推荐：DeepSeek Flash · 低思考", reason: "以保真转录为主，不要求解，优先兼顾速度与原页图片支持。" },
  { id: "teachingGeneration", label: "解析生成", description: "生成高中课堂可参考的答案、解析和难度依据。", recommendation: "推荐：DeepSeek Flash · 高思考", reason: "需要独立核算、选择高中解法并补齐关键论证，优先保证内容质量。" },
  { id: "teachingReview", label: "解析复核", description: "已有问题命中后，按问题复核一次。", recommendation: "推荐：千问AI平台 Qwen3.8 Flash · 开启思考", reason: "由另一模型针对具体问题检查和修正；此配置提供思考开关，不分高低档。" },
] as const;
export type ImportRole = typeof importRoleDefinitions[number]["id"];
export type ImportRoles = Record<ImportRole, string | null> | null;
export type ImportRoleThinkingEntry = { profileId: string; provider: string; model: string; reasoningEffort: string };
export type ImportRoleThinking = Record<ImportRole, ImportRoleThinkingEntry | null> | null;
export type PurposeProfile = { id: string; name: string; provider: string | null; model: string; reasoningEffort?: string };

/** Null is one explicit legacy mode, never a per-role fallback. */
export function readImportRoles(value: unknown, profiles: readonly { id: string }[]): ImportRoles {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("模型用途设置读取不完整，请重新读取后再保存。");
  const keys = Object.keys(value);
  if (keys.length !== importRoleDefinitions.length || importRoleDefinitions.some(role => !Object.hasOwn(value, role.id))) throw new Error("模型用途设置读取不完整，请重新读取后再保存。");
  const roles = value as Record<string, unknown>;
  const result = emptyImportRoles();
  for (const role of importRoleDefinitions) {
    const id = roles[role.id];
    if (id !== null && (typeof id !== "string" || !profiles.some(profile => profile.id === id))) throw new Error("模型用途引用的配置不存在，请重新读取后再保存。");
    result[role.id] = id as string | null;
  }
  return result;
}
export function emptyImportRoles(): NonNullable<ImportRoles> {
  return { sourceParsing: null, teachingGeneration: null, teachingReview: null };
}
export function assignImportRole(current: ImportRoles, role: ImportRole, profileId: string | null, profiles: readonly { id: string }[]): NonNullable<ImportRoles> {
  if (!current || !importRoleDefinitions.some(item => item.id === role)) throw new Error("请先选择按用途指定模型。");
  return readImportRoles({ ...current, [role]: profileId }, profiles)!;
}
export function profileImportRoles(roles: ImportRoles, profileId: string | null | undefined): string[] {
  return !roles || !profileId ? [] : importRoleDefinitions.filter(role => roles[role.id] === profileId).map(role => role.label);
}
export function importRoleChoices(profiles: readonly PurposeProfile[]) {
  return [{ id: "", label: "未配置", detail: "此用途执行时会提示先配置，不会自动使用其他模型。", provider: undefined as string | undefined },
    ...profiles.map(profile => ({ id: profile.id, label: profile.name.trim() || profile.model || "未命名配置",
      detail: `${providerPreset(profile.provider)?.label || "原有服务商"} · ${profile.model || "待选择模型"}`,
      provider: profile.provider || undefined }))];
}

export function emptyImportRoleThinking(): NonNullable<ImportRoleThinking> {
  return { sourceParsing: null, teachingGeneration: null, teachingReview: null };
}
function isRole(value: string): value is ImportRole {
  return importRoleDefinitions.some(role => role.id === value);
}
function validThinkingEntry(value: unknown, role: ImportRole, roles: ImportRoles, profiles: readonly PurposeProfile[]): value is ImportRoleThinkingEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = ["profileId", "provider", "model", "reasoningEffort"];
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).length !== keys.length || keys.some(key => !Object.hasOwn(entry, key) || typeof entry[key] !== "string" || !entry[key] || entry[key] !== entry[key].trim() || /[\u0000-\u001f\u007f]/.test(entry[key]))) return false;
  const profile = profiles.find(item => item.id === roles?.[role]);
  return Boolean(profile && entry.profileId === profile.id && entry.provider === profile.provider && entry.model === profile.model
    && modelReasoningOptions(profile.provider, profile.model).some(option => option.id === entry.reasoningEffort && option.disabled !== true));
}
/** Overrides are bound to one exact purpose/profile/provider/model, not shared profile preferences. */
export function readImportRoleThinking(value: unknown, roles: ImportRoles, profiles: readonly PurposeProfile[]): ImportRoleThinking {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== importRoleDefinitions.length || importRoleDefinitions.some(role => !Object.hasOwn(value, role.id))) throw new Error("用途思考设置读取不完整，请重新读取后再保存。");
  const input = value as Record<string, unknown>, result = emptyImportRoleThinking();
  for (const role of importRoleDefinitions) {
    const entry = input[role.id];
    if (entry !== null && !validThinkingEntry(entry, role.id, roles, profiles)) throw new Error(`${role.label}的思考设置与所选模型不匹配，请重新读取或选择。`);
    result[role.id] = entry === null ? null : { ...entry };
  }
  if (!roles && importRoleDefinitions.some(role => result[role.id] !== null)) throw new Error("沿用原策略时不能单独指定用途思考设置。");
  return result;
}
/** Explicit profile/model/purpose edits clear only the overrides whose binding became invalid. */
export function pruneImportRoleThinking(thinking: ImportRoleThinking, roles: ImportRoles, profiles: readonly PurposeProfile[]): ImportRoleThinking {
  if (!thinking || !roles) return null;
  const result = emptyImportRoleThinking();
  for (const role of importRoleDefinitions) {
    const entry = thinking[role.id];
    if (validThinkingEntry(entry, role.id, roles, profiles)) result[role.id] = { ...entry };
  }
  return result;
}
export function assignImportRoleThinking(thinking: ImportRoleThinking, role: ImportRole, effort: string, roles: ImportRoles, profiles: readonly PurposeProfile[]): ImportRoleThinking {
  if (!isRole(role)) throw new Error("模型用途无效。");
  if (!roles) {
    if (!effort) return null;
    throw new Error("请先选择按用途指定模型。");
  }
  const result = pruneImportRoleThinking(thinking, roles, profiles) || emptyImportRoleThinking();
  if (!effort) result[role] = null;
  else {
    const profile = profiles.find(item => item.id === roles[role]);
    if (!profile?.provider) throw new Error("请先为此用途选择模型配置。");
    result[role] = { profileId: profile.id, provider: profile.provider, model: profile.model, reasoningEffort: effort };
  }
  return readImportRoleThinking(result, roles, profiles);
}
export function importRoleThinkingChoices(profile?: PurposeProfile | null): ReasoningOption[] {
  return [{ id: "", label: profile ? `跟随配置（${reasoningLabel(profile)}）` : "跟随配置", description: profile ? "使用该配置保存的默认思考设置。" : "请先为此用途选择模型配置。" },
    ...(profile ? modelReasoningOptions(profile.provider, profile.model).map(option => ({ ...option })) : [])];
}
