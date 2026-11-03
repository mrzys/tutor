import { For, Show, createEffect, createSignal, createUniqueId, onCleanup, onMount } from "solid-js";
import { ArrowLeft, Check, ChevronDown, Database, ExternalLink, Plus, ScanText, SlidersHorizontal, Trash2, UserRound } from "lucide-solid";
import { request } from "./bridge";
import { Busy, ErrorBanner, Modal } from "./ui";
import { BankAnnotation } from "./BankAnnotation";
import { blankModelProfile, changeModelProvider, changeProfileModel, createModelCatalogGuard, llmProviders, modelProfileError, modelProfilePayload, modelProvider, modelReasoningOptions, modelTitle, parseModelCatalog, providerPreset, reasoningLabel, type ModelCatalog } from "./model-presets";
import { assignImportModel, assignImportRole, emptyImportRoles, importModelDefinitions, importModelProfileId, importRoleChoices, importRoleDefinitions, profileImportRoles, readImportRoles, assignImportRoleThinking, importRoleThinkingChoices, pruneImportRoleThinking, readImportRoleThinking, type ImportConfigurationContext, type ImportModel, type ImportRole, type ImportRoles, type ImportRoleThinking } from "./model-purpose";
import { accuracyModelReadiness } from "./import-accuracy";
import deepseekIcon from "@lobehub/icons-static-svg/icons/deepseek-color.svg";
import bailianIcon from "@lobehub/icons-static-svg/icons/alibabacloud-color.svg";
import xiaomiIcon from "@lobehub/icons-static-svg/icons/xiaomimimo.svg";
import qwenIcon from "@lobehub/icons-static-svg/icons/qwen-color.svg";
import "./Settings.css";

const providerIcons: Record<string, string> = { deepseek: deepseekIcon, bailian: bailianIcon, xiaomi: xiaomiIcon, qianwenai: qwenIcon };
const developerSources: Record<string, string> = { environment_off: "环境变量已强制关闭", environment_on: "环境变量已开启", command_line: "启动参数已开启" };
function ProviderIcon(props: { provider: string | null }) {
  return <Show when={props.provider && providerIcons[props.provider]}>{source => <img class="model-provider-icon" src={source()} alt="" aria-hidden="true" width="24" height="24" />}</Show>;
}
function ModelIcon(props: { provider: string | null }) {
  return <Show when={props.provider === "bailian"} fallback={<ProviderIcon provider={props.provider} />}><img class="model-provider-icon" src={qwenIcon} alt="" aria-hidden="true" width="24" height="24" /></Show>;
}

type SettingChoice = { id: string; label: string; detail?: string; provider?: string; disabled?: boolean };
function SettingsSelect(props: { label: string; choices: SettingChoice[]; value: string; ownerId: string; placeholder?: string; disabled?: boolean; showDetail?: boolean; onChange: (value: string) => void }) {
  const id = createUniqueId();
  const [open, setOpen] = createSignal(false);
  const [focused, setFocused] = createSignal(0);
  const [position, setPosition] = createSignal({ above: false, offset: 0, available: 256 });
  let root!: HTMLDivElement;
  let trigger!: HTMLButtonElement;
  const choices = () => props.choices;
  const selected = () => choices().find(model => model.id === props.value);
  createEffect(() => { props.ownerId; setOpen(false); });
  function reposition() {
    if (!root || !trigger) return;
    const bounds = trigger.getBoundingClientRect();
    const container = root.getBoundingClientRect();
    const viewport = window.visualViewport;
    let top = viewport?.offsetTop || 0;
    let bottom = top + (viewport?.height || window.innerHeight);
    for (let ancestor = root.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (!/(auto|scroll|hidden|clip)/.test(getComputedStyle(ancestor).overflowY)) continue;
      const clip = ancestor.getBoundingClientRect();
      top = Math.max(top, clip.top + ancestor.clientTop);
      bottom = Math.min(bottom, clip.top + ancestor.clientTop + ancestor.clientHeight);
    }
    const below = Math.max(0, bottom - bounds.bottom - 14);
    const aboveSpace = Math.max(0, bounds.top - top - 14);
    const above = below < Math.min(256, choices().length * 64 + 14) && aboveSpace > below;
    setPosition({ above, offset: above ? container.bottom - bounds.top + 6 : bounds.bottom - container.top + 6, available: Math.min(256, above ? aboveSpace : below) });
  }
  const show = () => { if (props.disabled || !choices().length) return; const index = choices().findIndex(model => model.id === props.value && !model.disabled); setFocused(index >= 0 ? index : Math.max(0, choices().findIndex(model => !model.disabled))); reposition(); setOpen(true); };
  const choose = (value: string) => { if (choices().find(choice => choice.id === value)?.disabled) return; props.onChange(value); setOpen(false); root.querySelector<HTMLButtonElement>('[role="combobox"]')?.focus({ preventScroll: true }); };
  onMount(() => {
    const outside = (event: PointerEvent) => { if (!root.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    onCleanup(() => document.removeEventListener("pointerdown", outside));
  });
  createEffect(() => {
    if (!open()) return;
    reposition();
    const update = () => reposition();
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    onCleanup(() => {
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    });
  });
  createEffect(() => {
    if (!open()) return;
    const index = focused();
    queueMicrotask(() => {
      const option = root.querySelector<HTMLElement>(`[id="${id}-option-${index}"]`);
      const list = option?.parentElement;
      if (!option || !list) return;
      const bounds = option.getBoundingClientRect();
      const visible = list.getBoundingClientRect();
      if (bounds.top < visible.top) list.scrollTop -= visible.top - bounds.top;
      else if (bounds.bottom > visible.bottom) list.scrollTop += bounds.bottom - visible.bottom;
    });
  });
  return <div class="settings-model-select" classList={{ "has-detail": props.showDetail }} ref={root} onFocusOut={event => { if (!root.contains(event.relatedTarget as Node)) setOpen(false); }}>
    <span id={`${id}-label`} class="settings-field-title">{props.label}</span>
    <button ref={trigger} type="button" role="combobox" disabled={props.disabled} aria-labelledby={`${id}-label`} aria-describedby={`${id}-value`} aria-expanded={open()} aria-controls={`${id}-options`} aria-haspopup="listbox"
      aria-activedescendant={open() ? `${id}-option-${focused()}` : undefined}
      class="settings-select-trigger" onClick={() => open() ? setOpen(false) : show()} onKeyDown={event => {
        if (event.key === "Escape" && open()) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
        else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          if (!open()) show();
          else setFocused(index => {
            const available = choices().map((choice, index) => ({ ...choice, index })).filter(choice => !choice.disabled).map(choice => choice.index);
            if (!available.length) return index;
            if (event.key === "Home") return available[0];
            if (event.key === "End") return available.at(-1)!;
            const current = Math.max(0, available.indexOf(index));
            return available[(current + (event.key === "ArrowDown" ? 1 : -1) + available.length) % available.length];
          });
        } else if ((event.key === "Enter" || event.key === " ") && open()) { event.preventDefault(); choose(choices()[focused()].id); }
      }}><span id={`${id}-value`} class="settings-select-value" classList={{ "is-placeholder": !selected() && !props.value }}><ProviderIcon provider={selected()?.provider || null} /><span class="settings-select-copy" title={[selected()?.label || props.value || props.placeholder || "请选择", props.showDetail ? selected()?.detail : ""].filter(Boolean).join(" · ")}><span>{selected()?.label || props.value || props.placeholder || "请选择"}</span><Show when={props.showDetail && selected()?.detail}><small>{selected()?.detail}</small></Show></span></span><ChevronDown size={16} classList={{ "is-open": open() }} /></button>
    <Show when={open()}><div id={`${id}-options`} role="listbox" aria-label={props.label} class="settings-select-options"
      style={{ top: position().above ? "auto" : `${position().offset}px`, bottom: position().above ? `${position().offset}px` : "auto", "max-height": `${position().available}px` }}>
      <For each={choices()}>{(model, index) => <button type="button" role="option" tabIndex={-1} id={`${id}-option-${index()}`} aria-selected={props.value === model.id} disabled={model.disabled}
        classList={{ "is-focused": focused() === index() }} onPointerMove={() => { if (!model.disabled) setFocused(index()); }} onMouseDown={event => event.preventDefault()} onClick={() => choose(model.id)}>
        <span class="settings-select-option-content"><ProviderIcon provider={model.provider || null} /><span><strong>{model.label}</strong><Show when={model.detail}><small>{model.detail}</small></Show></span></span><Show when={props.value === model.id}><Check size={16} /></Show>
      </button>}</For>
    </div></Show>
  </div>;
}

type ModelDraft = {
  id: string;
  name: string;
  provider: string | null;
  baseUrl: string;
  model: string;
  reasoningEffort?: string;
  apiKey: string;
  hasApiKey: boolean;
  configured: boolean;
  requiresApiKey?: boolean;
  warning?: string;
  catalogToken?: string;
};

export function Settings(props: {
  profile: any;
  dataDirectory: string;
  showModel?: boolean;
  showOcr?: boolean;
  importContext?: ImportConfigurationContext | null;
  onSaved: (profile: any) => void | Promise<void>;
  onBankChanged?: () => void | Promise<void>;
  onDeveloperModeChange?: (enabled: boolean) => void;
  onClose: () => void;
}) {
  type Section = "personal" | "models" | "ocr" | "data";
  const [section, setSection] = createSignal<Section>(props.showOcr ? "ocr" : props.showModel ? "models" : "personal");
  const [annotating, setAnnotating] = createSignal(false);
  const [discarding, setDiscarding] = createSignal(false);
  const [personalBaseline, setPersonalBaseline] = createSignal(props.profile?.nickname || "");
  const [modelBaseline, setModelBaseline] = createSignal("");
  const [personalError, setPersonalError] = createSignal("");
  const [savedMessage, setSavedMessage] = createSignal("");
  const [nickname, setNickname] = createSignal(props.profile?.nickname || "");
  const [profiles, setProfiles] = createSignal<ModelDraft[]>([]);
  const [savedProfiles, setSavedProfiles] = createSignal<ModelDraft[]>([]);
  const [savedActiveId, setSavedActiveId] = createSignal<string | null>(null);
  const [activeId, setActiveId] = createSignal<string | null>(null);
  const [importRoles, setImportRoles] = createSignal<ImportRoles>(null);
  const [savedImportRoles, setSavedImportRoles] = createSignal<ImportRoles>(null);
  const [importThinking, setImportThinking] = createSignal<ImportRoleThinking>(null);
  const [savedImportThinking, setSavedImportThinking] = createSignal<ImportRoleThinking>(null);
  const [modelPane, setModelPane] = createSignal<"purposes" | "profiles">("purposes");
  let assignedRoleDraft: ImportRoles = null;
  let assignedThinkingDraft: ImportRoleThinking = null;
  const [effectiveImportRoles, setEffectiveImportRoles] = createSignal<any>(null);
  const [editorDraft, setEditorDraft] = createSignal<ModelDraft | null>(null);
  const [editorBaseline, setEditorBaseline] = createSignal("");
  const [editorError, setEditorError] = createSignal("");
  const [modelCatalog, setModelCatalog] = createSignal<ModelCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = createSignal(false);
  const [catalogError, setCatalogError] = createSignal("");
  const [modelSearch, setModelSearch] = createSignal("");
  const catalogGuard = createModelCatalogGuard();
  onCleanup(() => catalogGuard.invalidate());
  const [revision, setRevision] = createSignal(0);
  const [loaded, setLoaded] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [modelWarning, setModelWarning] = createSignal("");
  const [conflict, setConflict] = createSignal(false);
  const [deletingId, setDeletingId] = createSignal<string | null>(null);
  const [ocr, setOcr] = createSignal({ baseUrl: "", model: "PaddleOCR-VL-1.6", apiKey: "", clearApiKey: false });
  const [ocrRevision, setOcrRevision] = createSignal(0);
  const [ocrLoaded, setOcrLoaded] = createSignal(false);
  const [ocrLoading, setOcrLoading] = createSignal(false);
  const [ocrBaseline, setOcrBaseline] = createSignal("");
  const [ocrHasKey, setOcrHasKey] = createSignal(false);
  const [ocrConfigured, setOcrConfigured] = createSignal(false);
  const [ocrWarning, setOcrWarning] = createSignal("");
  const [ocrError, setOcrError] = createSignal("");
  const [ocrConflict, setOcrConflict] = createSignal(false);
  const [developerMode, setDeveloperMode] = createSignal<{ enabled: boolean; configurable: boolean; source: string } | null>(null);
  const [developerLoading, setDeveloperLoading] = createSignal(false);
  const [developerSaving, setDeveloperSaving] = createSignal(false);
  const [developerError, setDeveloperError] = createSignal("");
  const developerSource = () => developerSources[developerMode()?.source || ""] || "";
  const editing = editorDraft;
  const deleting = () => profiles().find((item) => item.id === deletingId());
  const deletionRoles = () => profileImportRoles(importRoles(), deletingId());
  const rolesDirty = () => JSON.stringify([importRoles(), importThinking()]) !== JSON.stringify([savedImportRoles(), savedImportThinking()]);
  const roleProfile = (role: ImportRole) => profiles().find(profile => profile.id === importRoles()?.[role]);
  const generalProfile = () => profiles().find(profile => profile.id === activeId());
  const isNew = (id: string) => !savedProfiles().some(item => item.id === id);
  const profileDirty = (item: ModelDraft) => item.requiresApiKey === true || JSON.stringify(modelProfilePayload(item, false)) !== JSON.stringify(modelProfilePayload(savedProfiles().find(saved => saved.id === item.id) || item, false)) || isNew(item.id);
  const savedImportReadiness = () => accuracyModelReadiness({ importRoles: savedImportRoles(), profiles: savedProfiles(), effectiveImportRoles: effectiveImportRoles() });
  const selectedModelCount = () => importModelDefinitions.filter(model => profiles().some(profile => profile.id === importModelProfileId(importRoles(), model.id))).length;
  const label = (item: ModelDraft) => item.name.trim() || "未命名配置";
  const providerGroups = () => [
    ...llmProviders.map(provider => ({ id: provider.id, label: provider.label, profiles: profiles().filter(item => item.provider === provider.id) })),
    { id: "legacy", label: "原有服务商", profiles: profiles().filter(item => !providerPreset(item.provider)) },
  ].filter(group => group.profiles.length);

  function modelState() {
    return JSON.stringify({ activeProfileId: activeId(), importRoles: importRoles(), importRoleThinking: importThinking(), profiles: profiles().map((item) => ({
      ...modelProfilePayload(item, false),
      requiresApiKey: item.requiresApiKey === true,
    })) });
  }
  const personalDirty = () => nickname().trim() !== personalBaseline();
  const modelDirty = () => loaded() && modelState() !== modelBaseline();
  const editorState = (item: ModelDraft) => JSON.stringify({ ...modelProfilePayload(item, false), requiresApiKey: item.requiresApiKey === true });
  const editorDirty = () => editing() && editorState(editing()!) !== editorBaseline();
  const ocrState = () => JSON.stringify({ ...ocr(), baseUrl: ocr().baseUrl.trim(), model: ocr().model.trim() });
  const ocrDirty = () => ocrLoaded() && ocrState() !== ocrBaseline();
  function back() {
    if (busy()) return;
    if (personalDirty() || modelDirty() || editorDirty() || ocrDirty()) setDiscarding(true);
    else props.onClose();
  }
  function navigate(next: Section) {
    if (!busy()) { setSection(next); setSavedMessage(""); }
  }
  function changeRoleMode(mode: string) {
    if ((mode === "assigned") === (importRoles() !== null)) return;
    if (mode === "assigned") {
      const roles = assignedRoleDraft ? Object.fromEntries(importRoleDefinitions.map(role => [role.id, profiles().some(p => p.id === assignedRoleDraft?.[role.id]) ? assignedRoleDraft![role.id] : null])) as NonNullable<ImportRoles> : emptyImportRoles();
      setImportRoles(roles);
      setImportThinking(pruneImportRoleThinking(assignedThinkingDraft, roles, profiles()));
    } else {
      assignedRoleDraft = importRoles();
      assignedThinkingDraft = importThinking();
      setImportRoles(null);
      setImportThinking(null);
    }
    setSavedMessage("");
    setError("");
  }
  function changeRole(role: ImportRole, profileId: string) {
    if (importRoles()?.[role] === (profileId || null)) return;
    const roles = assignImportRole(importRoles(), role, profileId || null, profiles());
    setImportRoles(roles);
    setImportThinking(current => pruneImportRoleThinking(current, roles, profiles()));
    setSavedMessage("");
    setError("");
  }
  function changeRoleThinking(role: ImportRole, effort: string) {
    if ((importThinking()?.[role]?.reasoningEffort || "") === effort) return;
    setImportThinking(current => assignImportRoleThinking(current, role, effort, importRoles(), profiles()));
    setSavedMessage("");
    setError("");
  }
  function changeImportModel(model: ImportModel, profileId: string) {
    try {
      const prior = importRoles() || (assignedRoleDraft ? Object.fromEntries(importRoleDefinitions.map(role => [role.id, profiles().some(profile => profile.id === assignedRoleDraft?.[role.id]) ? assignedRoleDraft![role.id] : null])) as NonNullable<ImportRoles> : null);
      const roles = assignImportModel(prior, model, profileId || null, profiles());
      const thinking = importRoles() !== null ? importThinking() : assignedThinkingDraft;
      setImportRoles(roles);
      setImportThinking(pruneImportRoleThinking(thinking, roles, profiles()));
      setSavedMessage("");
      setError("");
    } catch (failure: any) { setError(failure.message); }
  }
  function applySettings(result: any) {
    if (!Array.isArray(result.profiles) || !Number.isSafeInteger(result.revision)) {
      throw new Error("模型设置读取不完整，请重试后再保存。");
    }
    const items: ModelDraft[] = result.profiles.map((item: any) => {
      if (typeof item.id !== "string" || !item.id) {
        throw new Error("模型设置读取不完整，请重试后再保存。");
      }
      return {
        id: item.id,
        name: item.name || "",
        provider: item.provider || modelProvider(item.baseUrl || ""),
        baseUrl: item.baseUrl || "",
        model: item.model || "",
        ...(typeof item.reasoningEffort === "string" ? { reasoningEffort: item.reasoningEffort } : {}),
        apiKey: "",
        hasApiKey: Boolean(item.hasApiKey),
        configured: Boolean(item.configured),
        warning: typeof item.warning === "string" ? item.warning : "",
      };
    });
    if (result.activeProfileId != null && !items.some((item) => item.id === result.activeProfileId)) {
      throw new Error("当前模型配置读取不完整，请重试后再保存。");
    }
    const roles = readImportRoles(result.importRoles, items);
    const thinking = readImportRoleThinking(result.importRoleThinking, roles, items);
    setProfiles(items);
    setSavedProfiles(items.map(item => ({ ...item })));
    setSavedActiveId(result.activeProfileId || null);
    setActiveId(result.activeProfileId || null);
    setImportRoles(roles);
    setSavedImportRoles(roles ? { ...roles } : null);
    setImportThinking(thinking);
    setSavedImportThinking(thinking ? structuredClone(thinking) : null);
    assignedRoleDraft = roles;
    assignedThinkingDraft = thinking;
    setEffectiveImportRoles(result.effectiveImportRoles || null);
    setRevision(result.revision);
    setModelWarning(typeof result.warning === "string" ? result.warning : "");
    clearCatalog();
    setEditorDraft(null);
    setEditorBaseline("");
    setEditorError("");
    setLoaded(true);
    setModelBaseline(modelState());
  }

  async function load(force = false) {
    if ((loaded() && !force) || busy()) return;
    setLoading(true);
    setError("");
    try {
      applySettings(await request("model_get"));
      setConflict(false);
    } catch (error: any) {
      setError(error.message);
    } finally {
      setLoading(false);
    }
  }
  function applyOcr(result: any) {
    if (!Number.isSafeInteger(result.revision) || typeof result.baseUrl !== "string" || typeof result.model !== "string") {
      throw new Error("试卷识别设置读取不完整，请重试后再保存。");
    }
    setOcr({ baseUrl: result.baseUrl, model: result.model, apiKey: "", clearApiKey: false });
    setOcrRevision(result.revision);
    setOcrHasKey(result.apiKeyConfigured === true);
    setOcrConfigured(result.configured === true);
    setOcrWarning(typeof result.warning === "string" ? result.warning : "");
    setOcrLoaded(true);
    setOcrBaseline(ocrState());
  }
  async function loadOcr(force = false) {
    if ((ocrLoaded() && !force) || ocrLoading() || busy()) return;
    setOcrLoading(true);
    setOcrError("");
    try {
      applyOcr(await request("ocr_get"));
      setOcrConflict(false);
    } catch (failure: any) { setOcrError(failure.message); }
    finally { setOcrLoading(false); }
  }
  function updateOcr(field: "baseUrl" | "model" | "apiKey", value: string) {
    setSavedMessage("");
    setOcr((draft) => ({ ...draft, [field]: value, ...(field === "apiKey" && value ? { clearApiKey: false } : {}) }));
  }
  async function saveOcr() {
    if (busy() || ocrLoading() || !ocrLoaded() || ocrConflict()) return;
    setBusy(true);
    setOcrError("");
    setSavedMessage("");
    try {
      const result = await request("ocr_save", { expectedRevision: ocrRevision(), ...ocr(), baseUrl: ocr().baseUrl.trim(), model: ocr().model.trim() });
      applyOcr(result);
      await props.onSaved(props.profile);
      setSavedMessage("试卷识别配置已保存");
    } catch (failure: any) {
      setOcrError(failure.message);
      if (failure.code === "revision_conflict") setOcrConflict(true);
    } finally { setBusy(false); }
  }
  function applyDeveloperMode(result: any) {
    if (typeof result.enabled !== "boolean" || typeof result.configurable !== "boolean" || typeof result.source !== "string") throw new Error("开发者设置读取不完整，请重试。");
    setDeveloperMode({ enabled: result.enabled, configurable: result.configurable, source: result.source });
  }
  async function loadDeveloperMode() {
    if (developerLoading() || developerSaving()) return;
    setDeveloperLoading(true);
    setDeveloperError("");
    try { applyDeveloperMode(await request("developer_log_capabilities")); }
    catch (failure: any) { setDeveloperError(failure.message); }
    finally { setDeveloperLoading(false); }
  }
  async function toggleDeveloperMode() {
    if (!developerMode()?.configurable || developerSaving() || developerLoading()) return;
    setDeveloperSaving(true);
    setDeveloperError("");
    try {
      const result = await request("developer_mode_set", { enabled: !developerMode()!.enabled });
      applyDeveloperMode(result);
      props.onDeveloperModeChange?.(result.enabled);
    } catch (failure: any) { setDeveloperError(failure.message); }
    finally { setDeveloperSaving(false); }
  }
  onMount(() => { void load(); void loadOcr(); void loadDeveloperMode(); });

  function update(field: "name" | "baseUrl" | "model" | "apiKey", value: string) {
    setSavedMessage("");
    setEditorError("");
    if (field === "apiKey") clearCatalog();
    setEditorDraft(item => {
      if (!item) return item;
      if (field === "model") {
        if (!modelCatalog()?.models.some(model => model.id === value)) return item;
        return changeProfileModel(item, value, modelCatalog()?.models);
      }
      return { ...item, [field]: value, ...(field === "apiKey" ? { catalogToken: undefined } : {}) };
    });
  }
  function updateReasoning(value: string) {
    setSavedMessage("");
    setEditorError("");
    setEditorDraft(item => item ? { ...item, reasoningEffort: value || undefined } : item);
  }
  function reasoningChoices(item: ModelDraft): SettingChoice[] {
    const options = reasoningOptions(item).map(option => ({ id: option.id, label: option.label, detail: option.description, disabled: option.disabled }));
    const original = savedProfiles().find(profile => profile.id === item.id);
    if (original?.reasoningEffort === undefined && original?.provider === item.provider && original?.model === item.model) {
      return [{ id: "", label: "保持原设置", detail: "沿用此配置现有的请求策略，选择后保存才生效。" }, ...options];
    }
    return options;
  }
  function changeProvider(providerId: string) {
    if (editing()?.provider === providerId) return;
    clearCatalog();
    setSavedMessage("");
    setEditorError("");
    setEditorDraft(item => item ? { ...changeModelProvider(item, providerId), catalogToken: undefined } : item);
  }
  function clearCatalog() {
    catalogGuard.invalidate();
    setModelCatalog(null);
    setCatalogLoading(false);
    setCatalogError("");
    setModelSearch("");
  }
  async function fetchModelCatalog() {
    const item = editing();
    if (!item?.provider || catalogLoading()) return;
    if (!item.apiKey.trim() && (!item.hasApiKey || item.requiresApiKey)) { setCatalogError("请先填写此服务商的 API Key。"); return; }
    const requestRevision = catalogGuard.begin();
    setCatalogLoading(true);
    setCatalogError("");
    setModelCatalog(null);
    setModelSearch("");
    setEditorDraft(draft => draft ? { ...draft, catalogToken: undefined } : draft);
    try {
      const result = await request("model_list", { provider: item.provider, profileId: item.id, ...(item.apiKey ? { apiKey: item.apiKey } : {}) });
      if (!catalogGuard.isCurrent(requestRevision)) return;
      const catalog = parseModelCatalog(result, item.provider);
      setModelCatalog(catalog);
      setEditorDraft(draft => draft ? { ...draft, catalogToken: catalog.catalogToken } : draft);
    } catch (failure: any) {
      if (catalogGuard.isCurrent(requestRevision)) setCatalogError(failure.message || "获取模型列表失败，请重试。");
    } finally { if (catalogGuard.isCurrent(requestRevision)) setCatalogLoading(false); }
  }
  function reasoningOptions(item: ModelDraft) {
    return modelCatalog()?.models.find(model => model.id === item.model)?.reasoningOptions || modelReasoningOptions(item.provider, item.model);
  }
  function modelChoices(item: ModelDraft): SettingChoice[] {
    const search = modelSearch().trim().toLocaleLowerCase();
    const models = modelCatalog()?.models || [];
    const choices: SettingChoice[] = models.filter(model => !search || `${model.id} ${model.label}`.toLocaleLowerCase().includes(search)).map(model => ({ id: model.id, label: model.label, detail: model.label === model.id ? undefined : model.id }));
    return !item.model || choices.some(model => model.id === item.model) ? choices : [{ id: item.model, label: `当前配置：${item.model}`, disabled: true }, ...choices];
  }
  let editorReturnTarget: HTMLElement | null = null;
  let editorReturnId: string | null = null;
  function openEditor(item: ModelDraft) {
    clearCatalog();
    editorReturnTarget = document.activeElement as HTMLElement | null;
    editorReturnId = item.id;
    setSavedMessage("");
    setEditorError("");
    setEditorBaseline(editorState(item));
    setEditorDraft({ ...item });
    queueMicrotask(() => {
      const panel = document.querySelector<HTMLElement>(".model-config-editor");
      panel?.scrollIntoView({ block: "start", behavior: "instant" });
      panel?.focus({ preventScroll: true });
    });
  }
  function add() {
    openEditor(blankModelProfile(crypto.randomUUID()));
  }
  function closeEditor() {
    clearCatalog();
    setEditorDraft(null);
    setEditorBaseline("");
    setEditorError("");
    queueMicrotask(() => {
      const target = editorReturnTarget?.isConnected ? editorReturnTarget : document.querySelector<HTMLElement>(`[data-model-profile="${CSS.escape(editorReturnId || "")}"] .model-config-edit`) || document.querySelector<HTMLElement>(".model-config-add");
      target?.focus();
    });
  }
  function finishEditor() {
    const item = editing();
    if (!item) return;
    const original = profiles().find(profile => profile.id === item.id);
    const preservedModel = original?.provider === item.provider && original?.model === item.model;
    const validation = modelProfileError(item, preservedModel, modelCatalog());
    if (validation) { setEditorError(validation); return; }
    const completed = { ...item, name: item.name.trim() || modelTitle(item.provider, item.model) };
    setProfiles(items => original ? items.map(profile => profile.id === item.id ? completed : profile) : [...items, completed]);
    const retainedThinking = pruneImportRoleThinking(importThinking(), importRoles(), profiles());
    const thinkingCleared = JSON.stringify(retainedThinking) !== JSON.stringify(importThinking());
    setImportThinking(retainedThinking);
    closeEditor();
    setSavedMessage(thinkingCleared ? "模型已更换，相关用途的思考设置已恢复为跟随配置；保存后生效" : "编辑已完成，点击保存后生效");
  }
  function remove() {
    setSavedMessage("");
    const id = deletingId();
    if (profileImportRoles(importRoles(), id).length) { setError("此配置仍用于导入流程，请先调整模型用途，再删除并保存。"); return; }
    setProfiles((items) => items.filter((item) => item.id !== id));
    if (activeId() === id) setActiveId(null);
    setDeletingId(null);
  }
  async function savePersonal() {
    if (busy() || !nickname().trim()) return;
    setBusy(true);
    setPersonalError("");
    setSavedMessage("");
    try {
      const saved = await request("profile_save", { nickname: nickname().trim(), defaultSubject: "math" });
      setNickname(saved.profile.nickname);
      setPersonalBaseline(saved.profile.nickname);
      await props.onSaved(saved.profile);
      setSavedMessage("个人设置已保存");
    } catch (error: any) {
      setPersonalError(error.message);
    } finally { setBusy(false); }
  }
  async function saveModels() {
    if (busy() || loading() || !loaded() || conflict()) return;
    if (editing()) { finishEditor(); return; }
    if (profiles().some(item => item.requiresApiKey && !item.apiKey)) {
      setError("已更换服务商的配置需要重新输入密钥，再保存。");
      return;
    }
    setBusy(true);
    setError("");
    setSavedMessage("");
    try {
      const roles = readImportRoles(importRoles(), profiles());
      const thinking = readImportRoleThinking(importThinking(), roles, profiles());
      const result = await request("model_save", {
        expectedRevision: revision(),
        activeProfileId: activeId(),
        importRoles: roles,
        importRoleThinking: thinking,
        profiles: profiles().map(item => modelProfilePayload(item)),
      });
      applySettings(result);
      await props.onSaved(props.profile);
      setSavedMessage("模型配置已保存");
    } catch (error: any) {
      setError(error.message);
      if (error.code === "revision_conflict") setConflict(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="settings-page" classList={{ "is-model-settings": section() === "models" }}>
      <aside class="settings-sidebar" aria-label="设置导航">
        <button type="button" class="settings-back" onClick={back} disabled={busy()}><ArrowLeft size={18} />{props.importContext ? "返回导入试卷" : "返回组卷"}</button>
        <nav class="settings-nav" aria-label="配置项">
          <button type="button" aria-current={section() === "personal" ? "page" : undefined} onClick={() => navigate("personal")} disabled={busy()}><UserRound size={18} />个人设置</button>
          <button type="button" aria-current={section() === "models" ? "page" : undefined} onClick={() => navigate("models")} disabled={busy()}><SlidersHorizontal size={18} />模型配置</button>
          <button type="button" aria-current={section() === "ocr" ? "page" : undefined} onClick={() => navigate("ocr")} disabled={busy()}><ScanText size={18} />试卷识别</button>
          <button type="button" aria-current={section() === "data" ? "page" : undefined} onClick={() => navigate("data")} disabled={busy()}><Database size={18} />本地数据</button>
        </nav>
      </aside>
      <main class="settings-main">
        <div class="settings-content">
          <header class="settings-heading"><h1>{section() === "personal" ? "个人设置" : section() === "models" ? "模型配置" : section() === "ocr" ? "试卷识别" : "本地数据"}</h1></header>
          <Show when={props.importContext}><section class="settings-import-context" aria-label="本次导入配置">
            <p>{props.importContext?.materialKind === "text" ? "本次为文本导入，配置处理与复核两个模型即可，不需要 PaddleOCR。" : props.importContext?.materialKind === "document" ? "本次 PDF / DOCX 导入需要处理与复核两个模型，以及独立的 PaddleOCR 配置。" : "新试卷导入配置处理与复核两个模型；PDF / DOCX 还需独立配置 PaddleOCR。"}修改须分别保存，返回后继续导入。</p>
            <Show when={section() !== "models"}><button type="button" class="text-button" disabled={busy()} onClick={() => { navigate("models"); setModelPane("purposes"); }}>检查必需模型用途</button></Show>
          </section></Show>
          <Show when={section() === "personal"}>
            <form onSubmit={(event) => { event.preventDefault(); void savePersonal(); }}>
              <fieldset class="settings-fields" disabled={busy()}>
                <label class="field-label">昵称
                  <input maxLength={40} value={nickname()} onInput={(event) => { setNickname(event.currentTarget.value); setSavedMessage(""); }} />
                </label>
                <label class="field-label">默认学科
                  <select value="math">
                    <option value="math">数学</option>
                    <option disabled>语文（暂未开放）</option><option disabled>英语（暂未开放）</option>
                    <option disabled>物理（暂未开放）</option><option disabled>化学（暂未开放）</option>
                  </select>
                </label>
              </fieldset>
              <ErrorBanner message={personalError()} />
              <footer class="settings-footer"><span role="status" class="muted">{savedMessage()}</span><button type="submit" class="primary" disabled={busy() || !nickname().trim() || !personalDirty()}>{busy() ? "保存中…" : "保存"}</button></footer>
            </form>
          </Show>
          <Show when={section() === "models"}>
            <form onSubmit={(event) => { event.preventDefault(); void saveModels(); }}>
              <fieldset class="settings-fields" disabled={busy() || loading()}>
        <section class="settings-model">
          <Show when={!loading()} fallback={<Busy label="读取设置…" />}>
            <Show when={loaded()} fallback={
              <button type="button" class="secondary" onClick={() => load()} disabled={loading()}>重新读取模型设置</button>
            }>
              <Show when={!editing()} fallback={
                <Show when={editing()}>{item => <section class="model-config-editor" role="region" aria-label={profiles().some(profile => profile.id === item().id) ? "编辑模型配置" : "新增模型配置"} tabIndex={-1}>
                  <header class="model-editor-heading"><h2>{profiles().some(profile => profile.id === item().id) ? "编辑配置" : "新增配置"}</h2></header>
                  <label class="field-label">配置名称（可选）<input aria-label="配置名称" maxLength={60} value={item().name} onInput={event => update("name", event.currentTarget.value)} placeholder="例如：课堂解析；留空使用模型名称" /></label>
                  <Show when={providerPreset(item().provider) || !item().baseUrl} fallback={
                    <div class="model-provider-field"><span class="settings-field-title">服务商</span><span>原有服务商配置</span><small class="muted">{item().baseUrl}</small><span class="settings-field-title">模型</span><span>{item().model}</span></div>
                  }>
                    <SettingsSelect label="服务商" choices={llmProviders.map(provider => ({ id: provider.id, label: provider.label, provider: provider.id }))} value={item().provider || ""} placeholder="请选择服务商" ownerId={item().id} onChange={changeProvider} />
                    <Show when={item().provider === "bailian"}><p class="muted settings-provider-help">北京地域 · 按量付费 API Key</p></Show>
                    <Show when={item().provider === "xiaomi"}><p class="muted settings-provider-help">MiMo 按量付费 API Key</p></Show>
                    <Show when={item().provider === "qianwenai"}><p class="muted settings-provider-help">千问 AI 平台 API Key</p></Show>
                  </Show>
                  <label class="field-label">API Key
                    <input type="password" autocomplete="new-password" value={item().apiKey} onInput={event => update("apiKey", event.currentTarget.value)} placeholder={item().hasApiKey ? "留空保留此配置的密钥" : "输入此配置的密钥"} spellcheck={false} />
                  </label>
                  <Show when={item().requiresApiKey && savedProfiles().some(profile => profile.id === item().id)}><p class="muted settings-provider-help">服务商已更换，请重新填写对应服务商的密钥。</p></Show>
                  <Show when={providerPreset(item().provider)}>
                    <div class="model-dependent-settings" aria-label="所选服务商的模型设置">
                      <div class="model-catalog-actions"><button type="button" class="secondary" onClick={fetchModelCatalog} disabled={catalogLoading() || (!item().apiKey.trim() && (!item().hasApiKey || item().requiresApiKey))}>{catalogLoading() ? "正在获取模型列表…" : modelCatalog() ? "刷新模型列表" : "获取模型列表"}</button><Show when={modelCatalog()}>{catalog => <span class="muted" role="status">已获取 {catalog().models.length} 个模型</span>}</Show></div>
                      <ErrorBanner message={catalogError()} />
                      <Show when={modelCatalog()}><label class="field-label model-catalog-search">搜索模型<input type="search" value={modelSearch()} onInput={event => setModelSearch(event.currentTarget.value)} placeholder="输入模型名称或 ID" /></label></Show>
                      <SettingsSelect label="模型" choices={modelChoices(item())} value={item().model} disabled={!modelCatalog() || catalogLoading()} placeholder="请先获取模型列表" ownerId={`${item().id}:${item().provider}:${modelCatalog()?.catalogToken || ""}`} onChange={value => update("model", value)} />
                      <Show when={modelCatalog()} fallback={<p class="muted model-catalog-help">填写密钥后获取此服务商的模型列表；原配置的模型可以保留。</p>}><p class="muted model-catalog-help">列表由服务商返回，请选择支持对话的模型用于组卷。</p><Show when={!modelChoices(item()).some(model => !model.disabled)}><p class="muted" role="status">没有匹配的模型，请调整搜索内容。</p></Show></Show>
                      <Show when={reasoningOptions(item()).length} fallback={<Show when={item().model}><p class="muted settings-reasoning-help" role="status">尚未确认此型号的思考设置能力，沿用原请求设置。</p></Show>}>
                        <SettingsSelect label="默认思考设置" choices={reasoningChoices(item())} value={item().reasoningEffort || ""} ownerId={`${item().id}:${item().provider}:${item().model}`} onChange={updateReasoning} />
                        <Show when={reasoningOptions(item()).find(option => option.id === item().reasoningEffort)?.description}>{description => <p class="muted settings-reasoning-help">{description()}</p>}</Show>
                        <p class="muted settings-reasoning-help">用途页可以单独设置思考；选择“跟随配置”的用途才会使用此默认值。</p>
                      </Show>
                    </div>
                  </Show>
                  <Show when={item().warning}><p class="warning-text" role="alert">{item().warning}</p></Show>
                  <ErrorBanner message={editorError()} />
                  <p class="muted model-editor-save-note">完成编辑后，点击保存生效。</p>
                  <footer class="model-editor-actions"><button type="button" class="secondary" onClick={closeEditor}>取消</button><button type="submit" class="primary">完成编辑</button></footer>
                </section>}</Show>
              }>
                <div class="model-workspace-toolbar">
                  <div class="model-workspace-tabs" role="tablist" aria-label="模型配置内容" onKeyDown={event => {
                    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                    event.preventDefault();
                    const pane = event.key === "Home" ? "purposes" : event.key === "End" ? "profiles" : modelPane() === "purposes" ? "profiles" : "purposes";
                    setModelPane(pane);
                    document.getElementById(pane === "purposes" ? "model-purpose-tab" : "model-profiles-tab")?.focus();
                  }}>
                    <button type="button" role="tab" id="model-purpose-tab" tabIndex={modelPane() === "purposes" ? 0 : -1} aria-selected={modelPane() === "purposes"} aria-controls="model-purpose-panel" onClick={() => setModelPane("purposes")}>用途分配</button>
                    <button type="button" role="tab" id="model-profiles-tab" tabIndex={modelPane() === "profiles" ? 0 : -1} aria-selected={modelPane() === "profiles"} aria-controls="model-profiles-panel" onClick={() => setModelPane("profiles")}>模型与密钥<span>{profiles().length}</span></button>
                  </div>
                  <button type="button" class="secondary model-config-add" onClick={add} disabled={profiles().length >= 20}><Plus size={16} />添加模型</button>
                </div>
                <Show when={modelPane() === "purposes"}>
                <div id="model-purpose-panel" role="tabpanel" aria-labelledby="model-purpose-tab">
                <section class="model-purpose-settings" aria-labelledby="model-purpose-heading">
                  <section class="model-import-readiness" aria-labelledby="model-import-readiness-heading">
                    <div><strong id="model-import-readiness-heading">试卷导入</strong><span role="status">已保存模型 {2 - savedImportReadiness().missing.length}/2</span></div>
                    <Show when={savedImportReadiness().missing.length} fallback={<p>处理模型和复核模型已配置。</p>}><p>待配置：{savedImportReadiness().missing.join("、")}。</p></Show>
                    <Show when={modelDirty()}><p role="status">当前已选择 {selectedModelCount()}/2 个模型，保存后生效。</p></Show>
                    <Show when={props.importContext?.materialKind === "text"} fallback={<p>PaddleOCR：{!ocrLoaded() ? "配置尚未读取" : ocrConfigured() ? "已保存配置" : "尚未配置"}，PDF / DOCX 必需。<Show when={ocrDirty()}>有未保存的识别设置。</Show><button type="button" class="text-button" disabled={busy()} onClick={() => navigate("ocr")}>配置试卷识别</button></p>}><p>PaddleOCR：本次文本导入不适用。</p></Show>
                    <p class="muted">拆题后，每题由处理模型生成内容，再由复核模型统一核对。PDF / DOCX 对照原页还需模型支持图片。</p>
                  </section>
                  <div class="model-purpose-heading"><div><h2 id="model-purpose-heading">处理与复核</h2><p class="muted">分别选择已保存的模型配置。</p></div><Show when={rolesDirty()}><span class="model-state-label">未保存</span></Show></div>
                  <div class="model-purpose-grid model-import-models"><For each={importModelDefinitions}>{model => <section class="model-purpose-item" aria-label={model.label}>
                    <header class="model-purpose-card-heading"><h3>{model.label}</h3><p class="muted">{model.description}</p></header>
                    <div class="model-purpose-controls">
                      <SettingsSelect label={model.label} ownerId={`import-model-${model.id}`} value={importModelProfileId(importRoles(), model.id)} choices={importRoleChoices(profiles())} showDetail onChange={value => changeImportModel(model.id, value)} />
                      <SettingsSelect label={model.id === "teachingGeneration" ? "内容处理思考" : "复核思考"} ownerId={`import-model-thinking-${model.id}-${roleProfile(model.id)?.id}-${roleProfile(model.id)?.model}`} value={importThinking()?.[model.id]?.reasoningEffort || ""} choices={roleProfile(model.id) ? importRoleThinkingChoices(roleProfile(model.id)) : [{ id: "", label: "先选择模型" }]} disabled={!importModelProfileId(importRoles(), model.id) || importRoleThinkingChoices(roleProfile(model.id)).length < 2} onChange={value => changeRoleThinking(model.id, value)} />
                    </div>
                    <div class="model-purpose-card-note"><span>{model.recommendation}</span></div>
                    <Show when={model.id === "teachingGeneration" && importRoles()?.sourceParsing && importRoles()?.teachingGeneration && importRoles()?.sourceParsing !== importRoles()?.teachingGeneration}><p class="warning-text">旧拆题与生成使用不同配置，请选择一个处理模型统一使用，保存后生效。</p></Show>
                  </section>}</For></div>
                  <details class="model-purpose-help model-legacy-purposes"><summary>高级设置与旧任务用途</summary>
                  <p>旧任务继续使用原有用途和思考设置。新任务只需上方两个模型；选择处理模型会同时设置拆题和生成，原有拆题思考设置仍保留。</p>
                  <div class="model-mode-switch" role="group" aria-label="用途设置方式">
                    <button type="button" aria-pressed={importRoles() !== null} onClick={() => changeRoleMode("assigned")}>按用途指定</button>
                    <button type="button" aria-pressed={importRoles() === null} onClick={() => changeRoleMode("legacy")}>沿用原策略</button>
                  </div>
                  <Show when={importRoles() !== null} fallback={<div class="model-purpose-legacy">
                    <p class="muted">沿用原策略：DeepSeek Flash低思考拆题；DeepSeek Flash高思考生成解析；千问AI平台Qwen3.8 Flash开启思考复核。</p>
                    <Show when={savedImportRoles() === null}><For each={importRoleDefinitions.filter(role => effectiveImportRoles()?.[role.id]?.strategy === "legacy" && effectiveImportRoles()?.[role.id]?.configured === false)}>{role => <p class="warning-text" role="status">{role.label}：{effectiveImportRoles()?.[role.id]?.error?.message || "缺少所需配置，请补充对应模型配置或按用途指定。"}</p>}</For></Show>
                    <p class="muted model-purpose-note">原策略只用于旧导入任务。新上传请在上方选择处理模型和复核模型，再保存。</p>
                  </div>}>
                    <div class="model-purpose-grid"><For each={importRoleDefinitions}>{role => <section class="model-purpose-item" aria-label={role.label}>
                      <header class="model-purpose-card-heading"><h3>{role.label}<span class="model-purpose-required">旧用途设置</span></h3><p class="muted">{role.description}</p></header>
                      <div class="model-purpose-controls">
                        <SettingsSelect label="模型配置" ownerId={`purpose-${role.id}`} value={importRoles()?.[role.id] || ""} choices={importRoleChoices(profiles())} showDetail onChange={value => changeRole(role.id, value)} />
                        <SettingsSelect label="思考设置" ownerId={`thinking-${role.id}-${roleProfile(role.id)?.id}-${roleProfile(role.id)?.model}`} value={importThinking()?.[role.id]?.reasoningEffort || ""} choices={roleProfile(role.id) ? importRoleThinkingChoices(roleProfile(role.id)) : [{id:"",label:"先选择模型"}]} disabled={!roleProfile(role.id) || importRoleThinkingChoices(roleProfile(role.id)).length < 2} placeholder="先选择模型" onChange={value => changeRoleThinking(role.id, value)} />
                      </div>
                      <div class="model-purpose-card-note"><span>{role.recommendation}</span><Show when={roleProfile(role.id) && importRoleThinkingChoices(roleProfile(role.id)).length < 2}><span>暂未确认思考能力，保持原设置</span></Show></div>
                    </section>}</For></div>
                    <p class="muted model-purpose-note">思考设置仅对当前用途生效。同一个模型配置，可以在拆题时用低思考、生成解析时用高思考。</p>
                  </Show>
                  </details>
                </section>
                <section class="model-general-settings" aria-labelledby="model-general-heading"><div><h2 id="model-general-heading">组卷与其他功能</h2><p class="muted">使用所选配置的默认思考设置。</p><Show when={generalProfile()}>{profile => <p class="model-general-thinking">默认思考：{reasoningLabel(profile())}<button type="button" onClick={() => openEditor(profile())}>编辑默认设置</button></p>}</Show></div><SettingsSelect label="通用模型" ownerId="general-model" value={activeId() || ""} choices={[{id:"",label:"暂不使用通用模型"},...importRoleChoices(profiles()).filter(choice => choice.id)]} showDetail onChange={value => {setActiveId(value || null);setSavedMessage("");}} /></section>
                </div>
                </Show>
                <Show when={modelPane() === "profiles"}>
                <div id="model-profiles-panel" role="tabpanel" aria-labelledby="model-profiles-tab">
                <div class="model-list-heading"><div><h2>我的模型</h2><p class="muted">管理服务商、密钥和默认思考设置，再到用途页分配。</p></div></div>
                <Show when={modelWarning()}><p class="warning-text" role="alert">{modelWarning()}</p></Show>
                <div class="model-config-list" aria-label="模型配置列表">
                  <Show when={profiles().length} fallback={<p class="muted model-list-empty">还没有模型配置</p>}>
                    <For each={providerGroups()}>{group => <section class="model-provider-group" aria-labelledby={`model-provider-group-${group.id}`}>
                      <h3 id={`model-provider-group-${group.id}`}><ProviderIcon provider={group.id} />{group.label}</h3>
                      <div class="model-provider-children"><For each={group.profiles}>{item => <div class="model-config-row" data-model-profile={item.id} classList={{ "is-new": isNew(item.id) }}>
                        <div class="model-config-info"><ModelIcon provider={item.provider} /><span class="model-config-description"><strong>{label(item)}</strong><small>{modelTitle(item.provider, item.model)} · 默认{reasoningLabel(item)}</small><Show when={profileImportRoles(importRoles(), item.id).length}><small class="model-purpose-badges">{rolesDirty() ? "保存后用途：" : "用途："}{profileImportRoles(importRoles(), item.id).join("、")}</small></Show></span>
                          <Show when={isNew(item.id)}><span class="model-state-label">新增 · 未保存</span></Show>
                          <Show when={!isNew(item.id) && profileDirty(item)}><span class="model-state-label">已修改 · 未保存</span></Show>
                          <Show when={savedActiveId() === item.id && !profileDirty(item)}><span class="model-state-label"><Check size={14} />通用模型</span></Show>
                        </div>
                        <div class="model-row-actions">
                          <button type="button" class="model-use-button" disabled={activeId() === item.id} aria-label={`使用配置 ${label(item)} 作为通用模型`} onClick={() => { setActiveId(item.id); setSavedMessage(""); }}>{activeId() === item.id ? savedActiveId() === item.id ? "已选通用" : "保存后通用" : "设为通用"}</button>
                          <button type="button" class="model-config-edit" aria-label={`编辑配置 ${label(item)}`} onClick={() => openEditor(item)}>编辑</button>
                          <button type="button" class="model-config-delete" aria-label={`删除配置 ${label(item)}`} onClick={() => setDeletingId(item.id)}><Trash2 size={16} />删除</button>
                        </div>
                      </div>}</For></div>
                    </section>}</For>
                  </Show>
                </div>
                <p class="muted model-credentials-note">密钥独立加密保存在本机，不会回显。添加、编辑、删除和用途调整统一保存后生效。</p>
                </div>
                </Show>
              </Show>
            </Show>
          </Show>
        </section>
      </fieldset>
      <ErrorBanner message={error()} />
      <Show when={conflict()}>
        <p class="muted">修改仍保留在此处。重新读取将放弃本次模型配置修改。</p>
        <button type="button" class="secondary" disabled={busy() || loading()} onClick={() => load(true)}>重新读取（放弃本次修改）</button>
      </Show>
              <Show when={!editing()}><footer class="settings-footer model-settings-footer"><span role="status" class="muted">{savedMessage() || (modelDirty() ? "有未保存的修改，保存后生效" : "设置已保存")}</span><div><Show when={props.importContext}><button type="button" class="secondary" disabled={busy()} onClick={back}>返回导入试卷</button></Show><Show when={modelDirty()}><button type="button" class="secondary" disabled={busy() || loading()} onClick={() => void load(true)}>放弃修改</button></Show><button type="submit" class="primary" disabled={busy() || loading() || !loaded() || conflict() || !modelDirty()}>{busy() ? "保存中…" : "保存配置"}</button></div></footer></Show>
            </form>
          </Show>
          <Show when={section() === "ocr"}>
            <form onSubmit={(event) => { event.preventDefault(); void saveOcr(); }}>
              <p class="muted">PaddleOCR 用于识别 PDF、Word 中的文字、公式、表格和图片，再由拆题用途配置的模型整理为题目。开始解析后，试卷内容会发送至配置的识别服务；Word 先在本机转为 PDF。</p>
              <Show when={!ocrLoading()} fallback={<Busy label="读取识别设置…" />}>
                <Show when={ocrLoaded()} fallback={<button type="button" class="secondary" onClick={() => loadOcr()}>重新读取识别设置</button>}>
                  <fieldset class="settings-fields" disabled={busy()}>
                    <p class="settings-current muted">{ocrConfigured() ? "已配置 PaddleOCR" : "尚未配置 PaddleOCR"}</p>
                    <label class="field-label">接口地址
                      <input type="url" aria-label="PaddleOCR 接口地址" value={ocr().baseUrl} spellcheck={false} onInput={(event) => updateOcr("baseUrl", event.currentTarget.value)} />
                    </label>
                    <label class="field-label">识别模型
                      <input aria-label="PaddleOCR 识别模型" value={ocr().model} spellcheck={false} onInput={(event) => updateOcr("model", event.currentTarget.value)} />
                    </label>
                    <label class="field-label">API Key
                      <input type="password" aria-label="PaddleOCR API Key" autocomplete="new-password" value={ocr().apiKey} spellcheck={false}
                        placeholder={ocrHasKey() && !ocr().clearApiKey ? "留空保留已保存的密钥" : "输入 PaddleOCR 密钥"}
                        onInput={(event) => updateOcr("apiKey", event.currentTarget.value)} />
                    </label>
                    <p class="muted">识别密钥与模型密钥独立，在本机加密保存，不会回显。</p>
                    <a class="settings-key-link" href="https://aistudio.baidu.com/paddleocr" target="_blank" rel="noopener noreferrer">前往 PaddleOCR 获取 API Key<ExternalLink size={14} /></a>
                    <Show when={ocrHasKey()}>
                      <label class="check-row"><input type="checkbox" checked={ocr().clearApiKey} onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        setOcr((draft) => ({ ...draft, clearApiKey: checked, ...(checked ? { apiKey: "" } : {}) }));
                        setSavedMessage("");
                      }} />清除已保存的识别密钥（保存后生效）</label>
                    </Show>
                  </fieldset>
                  <Show when={ocrWarning()}><p class="warning-text" role="alert">{ocrWarning()}</p></Show>
                </Show>
              </Show>
              <ErrorBanner message={ocrError()} />
              <Show when={ocrConflict()}>
                <p class="muted">设置已在其他窗口更新，当前输入仍保留。重新读取将放弃本次识别配置修改。</p>
                <button type="button" class="secondary" disabled={busy() || ocrLoading()} onClick={() => loadOcr(true)}>重新读取（放弃本次修改）</button>
              </Show>
              <footer class="settings-footer"><span role="status" class="muted">{savedMessage()}</span><div><Show when={props.importContext}><button type="button" class="secondary" disabled={busy()} onClick={back}>返回导入试卷</button></Show><button type="submit" class="primary" disabled={busy() || ocrLoading() || !ocrLoaded() || ocrConflict() || !ocrDirty()}>{busy() ? "保存中…" : "保存"}</button></div></footer>
            </form>
          </Show>
          <Show when={section() === "data"}>
            <section class="settings-data"><h2>存储位置</h2><p class="data-directory">{props.dataDirectory}</p><p class="muted">试卷、学生记录和题库保存在此设备。</p><h2>题库维护</h2><p class="muted">使用当前模型重新评估现有题目，支持暂停、恢复和失败重试。</p><button class="secondary" onClick={()=>setAnnotating(true)}>重新标注题库</button>
              <section class="settings-developer" aria-labelledby="developer-mode-title">
                <div class="settings-developer-heading"><h2 id="developer-mode-title">开发者模式</h2><button type="button" class="settings-developer-switch" role="switch" aria-label="开发者模式" aria-checked={developerMode()?.enabled === true} disabled={!developerMode()?.configurable || developerLoading() || developerSaving()} onClick={toggleDeveloperMode}><span aria-hidden="true" /><span>{developerSaving() ? "保存中…" : developerMode()?.enabled ? "已开启" : "已关闭"}</span></button></div>
                <p class="muted">开启后，后续组卷请求的详细正文记录在本机，右下角可查看；关闭即停止正文采集。</p>
                <Show when={developerSource()}><p class="muted settings-developer-source">{developerSource()}，请调整启动方式后更改。</p></Show>
                <Show when={developerLoading()}><p class="muted" role="status">正在读取开发者设置…</p></Show>
                <Show when={developerError()}><ErrorBanner message={developerError()} /><button type="button" class="secondary" disabled={developerLoading() || developerSaving()} onClick={loadDeveloperMode}>重试读取</button></Show>
              </section>
            </section>
          </Show>
        </div>
      </main>
      <Show when={deleting()}>{item => <Modal title="删除模型配置" onClose={() => setDeletingId(null)} footer={<><button type="button" class="secondary" onClick={() => setDeletingId(null)}>保留配置</button><Show when={!deletionRoles().length} fallback={<button type="button" class="primary" onClick={() => { setDeletingId(null); queueMicrotask(() => document.querySelector<HTMLElement>(".model-purpose-settings")?.scrollIntoView({ block: "center" })); }}>调整模型用途</button>}><button type="button" class="primary" onClick={remove}>确认删除</button></Show></>}>
        <Show when={deletionRoles().length} fallback={<p>保存后将删除“{label(item())}”{activeId() === item().id ? "并停用此通用配置" : ""}。</p>}><p>“{label(item())}”仍用于{deletionRoles().join("、")}。请先调整这些用途，再删除配置；所有修改点击保存后才生效。</p></Show>
      </Modal>}</Show>
      <Show when={discarding()}>
        <Modal title="有未保存的修改" onClose={() => setDiscarding(false)} footer={<><button type="button" class="secondary" onClick={() => setDiscarding(false)}>继续编辑</button><button type="button" class="primary" onClick={props.onClose}>放弃并返回</button></>}>
          <p>返回组卷将放弃尚未保存的设置。已保存的配置不受影响。</p>
        </Modal>
      </Show>
      <Show when={annotating()}><BankAnnotation onClose={()=>setAnnotating(false)} onChanged={()=>props.onBankChanged?.()} onConfigure={()=>{setAnnotating(false);setSection("models");}} /></Show>
    </div>
  );
}
