import { For, Show, createSignal, onMount } from "solid-js";
import { ArrowLeft, Check, Database, Plus, ScanText, SlidersHorizontal, Trash2, UserRound } from "lucide-solid";
import { request } from "./bridge";
import { Busy, ErrorBanner, Modal } from "./ui";
import { BankAnnotation } from "./BankAnnotation";
import { deepseekPreset, llmProviders, modelProfilePayload, modelProvider, newModelProfile } from "./model-presets";

type ModelDraft = {
  id: string;
  name: string;
  provider: string | null;
  baseUrl: string;
  model: string;
  apiKey: string;
  hasApiKey: boolean;
  configured: boolean;
  warning?: string;
};

export function Settings(props: {
  profile: any;
  dataDirectory: string;
  showModel?: boolean;
  showOcr?: boolean;
  onSaved: (profile: any) => void | Promise<void>;
  onBankChanged?: () => void | Promise<void>;
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
  const [activeId, setActiveId] = createSignal<string | null>(null);
  const [editingId, setEditingId] = createSignal<string | null>(null);
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
  const editing = () => profiles().find((item) => item.id === editingId());
  const deleting = () => profiles().find((item) => item.id === deletingId());
  const active = () => profiles().find((item) => item.id === activeId());
  const label = (item: ModelDraft) => item.name.trim() || "未命名配置";

  function modelState() {
    return JSON.stringify({ activeProfileId: activeId(), profiles: profiles().map((item) => ({
      ...modelProfilePayload(item),
    })) });
  }
  const personalDirty = () => nickname().trim() !== personalBaseline();
  const modelDirty = () => loaded() && modelState() !== modelBaseline();
  const ocrState = () => JSON.stringify({ ...ocr(), baseUrl: ocr().baseUrl.trim(), model: ocr().model.trim() });
  const ocrDirty = () => ocrLoaded() && ocrState() !== ocrBaseline();
  function back() {
    if (busy()) return;
    if (personalDirty() || modelDirty() || ocrDirty()) setDiscarding(true);
    else props.onClose();
  }
  function navigate(next: Section) {
    if (!busy()) { setSection(next); setSavedMessage(""); }
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
        apiKey: "",
        hasApiKey: Boolean(item.hasApiKey),
        configured: Boolean(item.configured),
        warning: typeof item.warning === "string" ? item.warning : "",
      };
    });
    if (result.activeProfileId != null && !items.some((item) => item.id === result.activeProfileId)) {
      throw new Error("当前模型配置读取不完整，请重试后再保存。");
    }
    setProfiles(items);
    setActiveId(result.activeProfileId || null);
    setRevision(result.revision);
    setModelWarning(typeof result.warning === "string" ? result.warning : "");
    if (!items.some((item) => item.id === editingId())) {
      setEditingId(result.activeProfileId || items[0]?.id || null);
    }
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
  onMount(() => { void load(); void loadOcr(); });

  function update(field: "name" | "baseUrl" | "model" | "apiKey", value: string) {
    setSavedMessage("");
    setProfiles((items) => items.map((item) => {
      if (item.id !== editingId()) return item;
      const automaticName = !item.name || deepseekPreset.models.some(model => model.label === item.name);
      return { ...item, [field]: value,
        ...(field === "model" && automaticName ? { name: deepseekPreset.models.find(model => model.id === value)?.label || item.name } : {}) };
    }));
  }
  function add() {
    setSavedMessage("");
    const id = crypto.randomUUID();
    setProfiles((items) => [...items, newModelProfile(id)]);
    setEditingId(id);
    setDeletingId(null);
    if (!activeId()) setActiveId(id);
  }
  function remove() {
    setSavedMessage("");
    const id = deletingId();
    setProfiles((items) => items.filter((item) => item.id !== id));
    if (activeId() === id) setActiveId(null);
    if (editingId() === id) setEditingId(profiles()[0]?.id || null);
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
    setBusy(true);
    setError("");
    setSavedMessage("");
    try {
      const result = await request("model_save", {
        expectedRevision: revision(),
        activeProfileId: activeId(),
        profiles: profiles().map(modelProfilePayload),
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
    <div class="settings-page">
      <aside class="settings-sidebar" aria-label="设置导航">
        <button type="button" class="settings-back" onClick={back} disabled={busy()}><ArrowLeft size={18} />返回组卷</button>
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
          <p class="settings-current muted">当前使用：{loaded() ? active() ? label(active()!) : "未启用" : "读取中…"}</p>
          <Show when={!loading()} fallback={<Busy label="读取设置…" />}>
            <Show when={loaded()} fallback={
              <button type="button" class="secondary" onClick={() => load()} disabled={loading()}>重新读取模型设置</button>
            }>
              <p class="muted">选择 DeepSeek 模型并填写 API Key，保存后使用所选配置。</p>
              <Show when={modelWarning()}><p class="warning-text" role="alert">{modelWarning()}</p></Show>
              <div class="model-config-list" aria-label="模型配置列表">
                <For each={profiles()}>{(item) => (
                  <button type="button" class="model-config-row" classList={{ "is-editing": editingId() === item.id }}
                    aria-pressed={editingId() === item.id} aria-label={`编辑配置 ${label(item)}`}
                    onClick={() => { setEditingId(item.id); setDeletingId(null); }}>
                    <span class="model-config-description"><strong>{label(item)}</strong><small>{item.model || "待填写模型"}</small></span>
                    <Show when={activeId() === item.id}><span class="model-config-current"><Check size={14} />当前使用</span></Show>
                  </button>
                )}</For>
                <button type="button" class="model-config-add" onClick={add} disabled={profiles().length >= 20} title={profiles().length >= 20 ? "最多保存 20 套配置" : undefined}><Plus size={16} />添加配置</button>
              </div>
              <label class="field-label">当前使用
                <select aria-label="当前使用模型配置" value={activeId() || ""} onChange={(event) => { setActiveId(event.currentTarget.value || null); setSavedMessage(""); }}>
                  <option value="" selected={!activeId()}>暂不使用模型</option>
                  <For each={profiles()}>{(item) => <option value={item.id} selected={activeId() === item.id}>{label(item)}</option>}</For>
                </select>
              </label>
              <Show when={!activeId()}><p class="muted">当前未启用模型，可使用规则预设；导入试卷前需选择完整配置。</p></Show>
              <Show when={editing()}>{(item) => (
                <section class="model-config-editor" aria-label="编辑模型配置">
                  <label class="field-label">LLM 服务商
                    <select aria-label="LLM 服务商" value={item().provider || "legacy"} disabled={item().provider !== "deepseek"}>
                      <Show when={item().provider !== "deepseek"}><option value="legacy">原有服务商配置</option></Show>
                      <For each={llmProviders}>{provider => <option value={provider.id}>{provider.label}</option>}</For>
                    </select>
                  </label>
                  <Show when={item().provider === "deepseek"} fallback={<p class="muted">原配置已保留。当前新增配置支持 DeepSeek，可添加后切换使用。</p>}>
                  <label class="field-label">模型
                    <select aria-label="DeepSeek 模型" value={item().model} onChange={event => update("model", event.currentTarget.value)}>
                      <Show when={!deepseekPreset.models.some(model => model.id === item().model)}><option value={item().model}>原配置：{item().model}</option></Show>
                      <For each={deepseekPreset.models}>{model => <option value={model.id}>{model.label}</option>}</For>
                    </select>
                  </label>
                  <label class="field-label">API Key
                    <input type="password" autocomplete="new-password" value={item().apiKey} onInput={(event) => update("apiKey", event.currentTarget.value)} placeholder={item().hasApiKey ? "留空保留此配置的密钥" : "输入此配置的密钥"} spellcheck={false} />
                  </label>
                  </Show>
                  <Show when={item().warning}><p class="warning-text" role="alert">{item().warning}</p></Show>
                  <div class="model-config-editor-footer">
                    <span class="muted">{item().hasApiKey ? "此配置已有密钥，本机加密保存。" : "密钥仅保存在本机，不会回显。"}</span>
                    <button type="button" class="model-config-delete" onClick={() => setDeletingId(item().id)}><Trash2 size={16} />删除配置</button>
                  </div>
                </section>
              )}</Show>
              <Show when={deleting()}>{(item) => (
                <div class="model-config-confirm" role="group" aria-label="确认删除模型配置">
                  <p>删除“{label(item())}”？{activeId() === item().id ? "删除后暂不使用模型，可重新选择其它配置。" : ""}保存后生效。</p>
                  <div><button type="button" class="secondary" onClick={() => setDeletingId(null)}>保留配置</button><button type="button" class="secondary" onClick={remove}>确认删除</button></div>
                </div>
              )}</Show>
            </Show>
          </Show>
        </section>
      </fieldset>
      <ErrorBanner message={error()} />
      <Show when={conflict()}>
        <p class="muted">修改仍保留在此处。重新读取将放弃本次模型配置修改。</p>
        <button type="button" class="secondary" disabled={busy() || loading()} onClick={() => load(true)}>重新读取（放弃本次修改）</button>
      </Show>
              <footer class="settings-footer"><span role="status" class="muted">{savedMessage()}</span><button type="submit" class="primary" disabled={busy() || loading() || !loaded() || conflict() || !modelDirty()}>{busy() ? "保存中…" : "保存"}</button></footer>
            </form>
          </Show>
          <Show when={section() === "ocr"}>
            <form onSubmit={(event) => { event.preventDefault(); void saveOcr(); }}>
              <p class="muted">PaddleOCR 用于识别 PDF、Word 中的文字、公式、表格和图片，再由当前模型整理为题目。开始解析后，试卷内容会发送至配置的识别服务；Word 先在本机转为 PDF。</p>
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
              <footer class="settings-footer"><span role="status" class="muted">{savedMessage()}</span><button type="submit" class="primary" disabled={busy() || ocrLoading() || !ocrLoaded() || ocrConflict() || !ocrDirty()}>{busy() ? "保存中…" : "保存"}</button></footer>
            </form>
          </Show>
          <Show when={section() === "data"}>
            <section class="settings-data"><h2>存储位置</h2><p class="data-directory">{props.dataDirectory}</p><p class="muted">试卷、学生记录和题库保存在此设备。</p><h2>题库维护</h2><p class="muted">使用当前模型重新评估现有题目，支持暂停、恢复和失败重试。</p><button class="secondary" onClick={()=>setAnnotating(true)}>重新标注题库</button></section>
          </Show>
        </div>
      </main>
      <Show when={discarding()}>
        <Modal title="有未保存的修改" onClose={() => setDiscarding(false)} footer={<><button type="button" class="secondary" onClick={() => setDiscarding(false)}>继续编辑</button><button type="button" class="primary" onClick={props.onClose}>放弃并返回</button></>}>
          <p>返回组卷将放弃尚未保存的设置。已保存的配置不受影响。</p>
        </Modal>
      </Show>
      <Show when={annotating()}><BankAnnotation onClose={()=>setAnnotating(false)} onChanged={()=>props.onBankChanged?.()} onConfigure={()=>{setAnnotating(false);setSection("models");}} /></Show>
    </div>
  );
}
