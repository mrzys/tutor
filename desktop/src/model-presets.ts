import presets from "../resources/llm-providers.json" with { type: "json" };

export type ReasoningOption = { id: string; label: string; description?: string; disabled?: boolean };
export type ProviderModel = { id: string; label: string; reasoningOptions?: ReasoningOption[] };
type ProviderPreset = { id: string; label: string; baseUrl: string; modelsPath?: string; models: ProviderModel[] };
export type ModelCatalog = { provider: string; baseUrl: string; models: ProviderModel[]; catalogToken: string };
export const llmProviders: ProviderPreset[] = presets.providers;
export const deepseekPreset = llmProviders[0];
export const providerPreset = (providerId: string | null) => llmProviders.find(provider => provider.id === providerId);
export function modelReasoningOptions(providerId: string | null, modelId: string): ReasoningOption[] {
  const model = providerPreset(providerId)?.models.find(model => model.id === modelId);
  return (model as { reasoningOptions?: ReasoningOption[] } | undefined)?.reasoningOptions || [];
}
export function modelTitle(providerId: string | null, modelId: string) {
  return providerPreset(providerId)?.models.find(model => model.id === modelId)?.label || modelId || "待选择模型";
}
export function reasoningLabel(item: { provider: string | null; model: string; reasoningEffort?: string }) {
  if (item.reasoningEffort === undefined) return "沿用原设置";
  return modelReasoningOptions(item.provider, item.model).find(option => option.id === item.reasoningEffort)?.label || `原设置：${item.reasoningEffort}`;
}

export function modelProvider(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || url.search || url.hash) return null;
    return llmProviders.find(provider => {
      const preset = new URL(provider.baseUrl);
      const paths = provider.id === "deepseek" ? ["/", "/v1", "/v1/"] : [preset.pathname.replace(/\/$/, ""), `${preset.pathname.replace(/\/$/, "")}/`];
      return url.hostname === preset.hostname && paths.includes(url.pathname);
    })?.id || null;
  } catch { return null; }
}

export function newModelProfile(id: string, providerId = deepseekPreset.id) {
  const provider = providerPreset(providerId);
  if (!provider) throw new Error("请选择支持的模型服务商。");
  const model = provider.models[0];
  const reasoningEffort = model && modelReasoningOptions(provider.id, model.id).some(option => option.id === "off") ? "off" : undefined;
  return { id, name: model?.label || "", provider: provider.id, baseUrl: provider.baseUrl,
    model: model?.id || "", reasoningEffort, apiKey: "", hasApiKey: false, configured: false };
}

export function blankModelProfile(id: string) {
  return { id, name: "", provider: null as string | null, baseUrl: "", model: "", reasoningEffort: undefined as string | undefined,
    apiKey: "", hasApiKey: false, configured: false, requiresApiKey: true };
}

export function changeModelProvider<T extends { id: string; name: string; provider: string | null; baseUrl: string; model: string; apiKey: string; hasApiKey: boolean; configured: boolean; requiresApiKey?: boolean }>(item: T, providerId: string): T {
  if (item.provider === providerId) return item;
  const provider = providerPreset(providerId);
  if (!provider) throw new Error("请选择支持的模型服务商。");
  const next = { ...blankModelProfile(item.id), provider: provider.id, baseUrl: provider.baseUrl };
  const automaticName = !item.name || llmProviders.some(provider => provider.models.some(model => model.label === item.name));
  return { ...item, ...next, name: automaticName ? "" : item.name,
    requiresApiKey: item.hasApiKey || item.requiresApiKey === true || Boolean(item.apiKey), warning: "" };
}

export function modelProfileError(item: { provider: string | null; baseUrl: string; model: string; requiresApiKey?: boolean; apiKey: string; catalogToken?: string }, preservedModel = false, catalog?: ModelCatalog | null) {
  if (!item.provider && !item.baseUrl) return "请选择服务商。";
  const provider = providerPreset(item.provider);
  if (!item.model) return "请选择模型。";
  if (!preservedModel && provider && (!catalog || catalog.provider !== item.provider || catalog.catalogToken !== item.catalogToken || !catalog.models.some(model => model.id === item.model))) return "请获取此服务商的模型列表后选择模型。";
  if (item.requiresApiKey && !item.apiKey.trim()) return "请填写此服务商的 API Key。";
  return "";
}

export function changeProfileModel<T extends { provider: string | null; model: string; name: string; reasoningEffort?: string }>(item: T, modelId: string, models?: ProviderModel[]): T {
  if (item.model === modelId) return item;
  const preset = providerPreset(item.provider);
  const automaticName = !item.name || preset?.models.some(model => model.label === item.name) || models?.some(model => model.label === item.name);
  const selected = models?.find(model => model.id === modelId);
  const options = selected?.reasoningOptions || modelReasoningOptions(item.provider, modelId);
  const reasoningEffort = item.reasoningEffort !== undefined && options.some(option => option.id === item.reasoningEffort && !option.disabled)
    ? item.reasoningEffort : options.some(option => option.id === "off") ? "off" : undefined;
  return { ...item, model: modelId, reasoningEffort,
    ...(automaticName ? { name: selected?.label || modelTitle(item.provider, modelId) } : {}) };
}

export function modelProfilePayload(item: { id: string; name: string; provider: string | null; baseUrl: string; model: string; apiKey: string; reasoningEffort?: string; catalogToken?: string }, includeCatalog = true) {
  return { id: item.id, name: item.name.trim(), model: item.model.trim(),
    ...(providerPreset(item.provider) ? { provider: item.provider } : { baseUrl: item.baseUrl.trim() }),
    ...(item.reasoningEffort !== undefined ? { reasoningEffort: item.reasoningEffort } : {}),
    ...(includeCatalog && item.catalogToken ? { catalogToken: item.catalogToken } : {}),
    ...(item.apiKey ? { apiKey: item.apiKey } : {}) };
}

export function parseModelCatalog(result: unknown, providerId: string): ModelCatalog {
  const provider = providerPreset(providerId);
  const value = result as ModelCatalog | null;
  if (!provider || !value || value.provider !== providerId || value.baseUrl !== provider.baseUrl || typeof value.catalogToken !== "string" || !value.catalogToken || !Array.isArray(value.models) || !value.models.length) throw new Error("模型列表返回不完整，请重新获取。");
  const seen = new Set<string>();
  const models = value.models.map(model => {
    if (!model || typeof model.id !== "string" || !model.id.trim() || seen.has(model.id) || typeof model.label !== "string" || !model.label.trim()) throw new Error("模型列表返回不完整，请重新获取。");
    seen.add(model.id);
    if (model.reasoningOptions !== undefined && (!Array.isArray(model.reasoningOptions) || model.reasoningOptions.some(option => !option || typeof option.id !== "string" || !option.id || typeof option.label !== "string" || !option.label || (option.disabled !== undefined && typeof option.disabled !== "boolean")))) throw new Error("模型能力信息返回不完整，请重新获取。");
    return { id: model.id, label: model.label, ...(model.reasoningOptions !== undefined ? { reasoningOptions: model.reasoningOptions } : {}) };
  });
  return { provider: providerId, baseUrl: provider.baseUrl, catalogToken: value.catalogToken, models };
}

// A cancelled editor must also reject a response after reopening the same profile.
export function createModelCatalogGuard() {
  let revision = 0;
  return { invalidate: () => { revision += 1; }, begin: () => ++revision, isCurrent: (requestRevision: number) => requestRevision === revision };
}
