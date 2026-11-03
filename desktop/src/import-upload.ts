import { importModelDefinitions, importModelProfileId } from "./model-purpose.ts";
import { providerPreset } from "./model-presets.ts";

function host(value: unknown): string {
  try { return typeof value === "string" ? new URL(value).host : ""; } catch { return ""; }
}
/** Public, saved configuration only. Never copy credentials or URL query strings into the sending notice. */
export function uploadModelDestinations(model: any): { role: string; configuration: string; service: string }[] {
  return importModelDefinitions.map(({ id, label }) => {
    const profile = model?.profiles?.find((item: any) => item.id === importModelProfileId(model?.importRoles, id));
    return { role: label, configuration: profile?.name || "未配置", service: profile
      ? [providerPreset(profile.provider)?.label || host(profile.baseUrl) || "自定义模型服务", profile.model].filter(Boolean).join(" · ") : "待配置" };
  });
}
export function uploadOcrDestination(ocr: any): string {
  return ocr?.configured === true ? ["PaddleOCR", ocr.model, host(ocr.baseUrl)].filter(Boolean).join(" · ") : "尚未配置";
}
