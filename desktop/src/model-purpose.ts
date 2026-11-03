import { modelReasoningOptions, providerPreset, reasoningLabel, type ReasoningOption } from "./model-presets.ts";

export const importRoleDefinitions = [
  { id: "sourceParsing", label: "拆题", description: "将识别材料整理为题干、选项、小问及原卷参考。", recommendation: "推荐：DeepSeek Flash · 低思考", reason: "以保真转录为主，不要求解，优先兼顾速度与原页图片支持。" },
  { id: "teachingGeneration", label: "解析生成", description: "生成答案解析与教学信息；新任务对应上方处理模型。", recommendation: "优先保证完整推导与教学说明质量", reason: "旧六步策略分别调用解答与教学字段生成，新两模型策略在一次处理响应中返回两者。" },
  { id: "teachingReview", label: "解析复核", description: "旧任务保留原复核或修订用途；新任务对应上方复核模型。", recommendation: "旧任务继续使用其原有配置", reason: "旧六步策略只在显式修订时使用，早期任务保留问题命中后一次复核；新两模型策略用于统一复核及明确发起的修订。" },
  { id: "sourceVerification", label: "来源核验", description: "对照原页检查题干、选项、小问、公式图表与原参考。", recommendation: "需要已确认的图片理解能力", reason: "以真实原页为依据单独核对保真，不以OCR与转录相互一致冒充对照原卷。" },
  { id: "independentSolve", label: "独立求解", description: "只看学生材料求解，先封存结果再参与比较。", recommendation: "使用独立上下文，不接收参考答案", reason: "与生成解答分开执行；可以复用配置，但不会带入其他角色的对话或解答。模型一致不代表数学正确。" },
  { id: "mathVerification", label: "数学核验", description: "核对答案、完整证明、原参考与具体分歧。", recommendation: "需要检查推导及条件适用性", reason: "核验只报告结论和依据，不直接修稿，不按两个模型是否一致决定正确性。" },
  { id: "teachingVerification", label: "教学核验", description: "核对主考知识、解法依赖、难度依据和学生要求。", recommendation: "依据固定题面、解答与真实目录", reason: "教学估计须有具体依据；核对结果不代表实测难度、预测得分率或学生实际掌握。" },
] as const;
export type ImportRole = typeof importRoleDefinitions[number]["id"];
export const importModelDefinitions = [
  { id: "teachingGeneration", label: "处理模型", description: "拆题后，一次生成答案解析、知识点和难度等教学信息。", recommendation: "DeepSeek Flash", reason: "拆题和内容处理共用这套模型；拆题思考设置可单独保留。" },
  { id: "teachingReview", label: "复核模型", description: "一次核对原卷来源、答案证明和教学信息，分别给出具体依据。", recommendation: "Qwen · 阿里云百炼", reason: "复核发现问题时保留待处理；修订由你显式发起，不自动循环。" },
] as const;
export type ImportModel = typeof importModelDefinitions[number]["id"];
export type ImportConfigurationContext = { from: "import"; materialKind?: "document" | "text" };
const legacyImportRoles = ["sourceParsing", "teachingGeneration", "teachingReview"] as const;
type LegacyImportRole = typeof legacyImportRoles[number];
type RoleValues<T> = Record<LegacyImportRole, T | null> & Partial<Record<Exclude<ImportRole, LegacyImportRole>, T | null>>;
export type ImportRoles = RoleValues<string> | null;
export type ImportRoleThinkingEntry = { profileId: string; provider: string; model: string; reasoningEffort: string };
export type ImportRoleThinking = RoleValues<ImportRoleThinkingEntry> | null;
export type PurposeProfile = { id: string; name: string; provider: string | null; model: string; reasoningEffort?: string };

function validRoleShape(value: object): boolean {
  return legacyImportRoles.every(role => Object.hasOwn(value, role)) && Object.keys(value).every(key => isRole(key));
}

/** Null is one explicit legacy mode, never a per-role fallback. */
export function readImportRoles(value: unknown, profiles: readonly { id: string }[]): ImportRoles {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("模型用途设置读取不完整，请重新读取后再保存。");
  if (!validRoleShape(value)) throw new Error("模型用途设置读取不完整，请重新读取后再保存。");
  const roles = value as Record<string, unknown>;
  const result: NonNullable<ImportRoles> = { sourceParsing: null, teachingGeneration: null, teachingReview: null };
  for (const role of importRoleDefinitions) {
    if (!Object.hasOwn(roles, role.id)) continue;
    const id = roles[role.id];
    if (id !== null && (typeof id !== "string" || !profiles.some(profile => profile.id === id))) throw new Error("模型用途引用的配置不存在，请重新读取后再保存。");
    result[role.id] = id as string | null;
  }
  return result;
}
export function emptyImportRoles(): NonNullable<ImportRoles> {
  return { sourceParsing: null, teachingGeneration: null, teachingReview: null, sourceVerification: null, independentSolve: null, mathVerification: null, teachingVerification: null };
}
export function assignImportRole(current: ImportRoles, role: ImportRole, profileId: string | null, profiles: readonly { id: string }[]): NonNullable<ImportRoles> {
  if (!current || !importRoleDefinitions.some(item => item.id === role)) throw new Error("请先选择按用途指定模型。");
  return readImportRoles({ ...current, [role]: profileId }, profiles)!;
}
/** One explicit draft selection; historical verification bindings remain intact. */
export function assignImportModel(current: ImportRoles, model: ImportModel, profileId: string | null, profiles: readonly PurposeProfile[]): NonNullable<ImportRoles> {
  if (!importModelDefinitions.some(item => item.id === model)) throw new Error("导入模型用途无效。");
  const result = { ...(current || emptyImportRoles()) };
  result[model] = profileId;
  if (model === "teachingGeneration") result.sourceParsing = profileId;
  return readImportRoles(result, profiles)!;
}
export function importModelProfileId(roles: ImportRoles, model: ImportModel): string {
  const id = roles?.[model];
  return id && (model !== "teachingGeneration" || roles?.sourceParsing === id) ? id : "";
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
  return { sourceParsing: null, teachingGeneration: null, teachingReview: null, sourceVerification: null, independentSolve: null, mathVerification: null, teachingVerification: null };
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
  if (typeof value !== "object" || Array.isArray(value) || !validRoleShape(value)) throw new Error("用途思考设置读取不完整，请重新读取后再保存。");
  const input = value as Record<string, unknown>, result: NonNullable<ImportRoleThinking> = { sourceParsing: null, teachingGeneration: null, teachingReview: null };
  for (const role of importRoleDefinitions) {
    if (!Object.hasOwn(input, role.id)) continue;
    const entry = input[role.id];
    if (entry !== null && !validThinkingEntry(entry, role.id, roles, profiles)) throw new Error(`${role.label}的思考设置与所选模型不匹配，请重新读取或选择。`);
    result[role.id] = entry === null ? null : { ...entry };
  }
  if (!roles && importRoleDefinitions.some(role => result[role.id] != null)) throw new Error("沿用原策略时不能单独指定用途思考设置。");
  return result;
}
/** Explicit profile/model/purpose edits clear only the overrides whose binding became invalid. */
export function pruneImportRoleThinking(thinking: ImportRoleThinking, roles: ImportRoles, profiles: readonly PurposeProfile[]): ImportRoleThinking {
  if (!thinking || !roles) return null;
  const result: NonNullable<ImportRoleThinking> = { sourceParsing: null, teachingGeneration: null, teachingReview: null };
  for (const role of importRoleDefinitions) {
    if (!Object.hasOwn(thinking, role.id)) continue;
    result[role.id] = null;
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
