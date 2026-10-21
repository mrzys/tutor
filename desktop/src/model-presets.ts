import presets from "../resources/llm-providers.json" with { type: "json" };

export const llmProviders = presets.providers;
export const deepseekPreset = llmProviders[0];

export function modelProvider(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" && url.hostname === "api.deepseek.com" && (!url.port || url.port === "443")
      && !url.username && !url.password && !url.search && !url.hash && ["/", "/v1", "/v1/"].includes(url.pathname)
      ? "deepseek" : null;
  } catch { return null; }
}

export function newModelProfile(id: string) {
  const model = deepseekPreset.models[0];
  return { id, name: model.label, provider: deepseekPreset.id, baseUrl: deepseekPreset.baseUrl,
    model: model.id, apiKey: "", hasApiKey: false, configured: false };
}

export function modelProfilePayload(item: { id: string; name: string; provider: string | null; baseUrl: string; model: string; apiKey: string }) {
  return { id: item.id, name: item.name.trim(), model: item.model.trim(),
    ...(item.provider === "deepseek" ? { provider: "deepseek" } : { baseUrl: item.baseUrl.trim() }),
    ...(item.apiKey ? { apiKey: item.apiKey } : {}) };
}
