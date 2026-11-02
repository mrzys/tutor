import {
  For,
  batch,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  lazy,
  onCleanup,
  onMount,
} from "solid-js";
import {
  BookOpen,
  CircleHelp,
  Check,
  ChevronRight,
  Download,
  FileCode2,
  FileText,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Upload,
  UsersRound,
  Trash2,
  Settings as SettingsIcon,
} from "lucide-solid";
import { invoke } from "@tauri-apps/api/core";
import { createStore, reconcile } from "solid-js/store";
import {
  cancel,
  operationId,
  purposeLabel,
  request,
  listenPreparationProgress,
  listenBlueprintProgress,
  listenSelectionProgress,
  currentAssemblyTraceId,
  beginAssemblyTrace,
  subscribeAssemblyTrace,
  typeIds,
  typeLabels,
} from "./bridge";
import { Busy, ErrorBanner, Modal, Drawer, StudentLabels } from "./ui";
import { Composer } from "./Composer";
import { PreparationConversation, type PreparationRun } from "./PreparationConversation";
import { createPreparationPresenter, type PreparationStepId } from "./preparation-progress";
import { BlueprintProgress, type BlueprintRun } from "./BlueprintProgress";
import { createBlueprintPresenter, type BlueprintStepId } from "./blueprint-progress";
import { SelectionProgress, type SelectionRun } from "./SelectionProgress";
import { createSelectionPresenter, type SelectionStepId } from "./selection-progress";
import { DeveloperAssemblyLog } from "./DeveloperAssemblyLog";
import "./DeveloperLogEntry.css";
import { Settings } from "./Settings";
import type { ImportConfigurationContext } from "./model-purpose";
import { DraftView } from "./Draft";
import { BlueprintView } from "./Blueprint";
import { Bank } from "./Bank";
import { ImportPaper } from "./ImportPaper";
import { StudentWork } from "./StudentWork";
import { UsageGuide } from "./UsageGuide";
import "./GuideEntry.css";
import "./AppStartup.css";
import { PaperSheet, RichText } from "./Paper";
import { waitForPaperAssets } from "./rich-content";
import { resizeQuestionCounts, slotDifficulty } from "./assembly-details";
import { teachingDisplayText } from "./teaching-text";
const PdfPreview = lazy(() =>
  import("./PdfPreview").then((module) => ({ default: module.PdfPreview })),
);

function ExportPage(props: { taskId: string; paperId: string; kind: string }) {
  const [paper, setPaper] = createSignal<any>(null);
  const [error, setError] = createSignal("");
  onMount(async () => {
    try {
      const assemblyTraceId = new URLSearchParams(location.search).get("assemblyTraceId");
      const result = await request("paper_get", { paperId: props.paperId, ...(assemblyTraceId ? { assemblyTraceId } : {}) });
      setPaper(result.paper);
      await document.fonts.ready;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      await waitForPaperAssets();
      await invoke("desktop_pdf_ready", { taskId: props.taskId });
    } catch (error: any) {
      setError(error.message);
      await invoke("desktop_pdf_failed", {
        taskId: props.taskId,
        message: error.message,
      }).catch(() => {});
    }
  });
  return (
    <main class="export-page">
      <Show when={paper()}>
        <PaperSheet
          draft={paper().draft}
          title={paper().title}
          kind={props.kind}
        />
      </Show>
      <ErrorBanner message={error()} />
    </main>
  );
}
function FirstRun(props: { onDone: (profile: any) => void }) {
  const [nickname, setNickname] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!nickname().trim() || busy()) return;
    setBusy(true);
    setError("");
    try {
      const result = await request("profile_save", {
        nickname: nickname().trim(),
        defaultSubject: "math",
      });
      props.onDone(result.profile);
    } catch (error: any) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main class="welcome">
      <div class="welcome-brand">
        <BookOpen size={32} />
        <strong>智教</strong>
      </div>
      <h1>怎么称呼你？</h1>
      <p class="muted">设置一个昵称，开始准备练习。</p>
      <form onSubmit={submit}>
        <label class="field-label">
          昵称
          <input
            autofocus
            autocomplete="nickname"
            maxlength={40}
            value={nickname()}
            onInput={(event) => setNickname(event.currentTarget.value)}
            placeholder="输入你的昵称"
            disabled={busy()}
          />
        </label>
        <ErrorBanner message={error()} />
        <button class="primary" disabled={busy() || !nickname().trim()}>
          {busy() ? "保存中…" : "开始使用"}
          <ChevronRight size={18} />
        </button>
      </form>
      <p class="welcome-note">学生和试卷记录保存在本机，无须注册。</p>
    </main>
  );
}
function counts(requirements: any) {
  return Object.values(requirements?.counts || {}).reduce(
    (sum: number, value: any) => sum + Number(value || 0),
    0,
  );
}
function summaryMessages(summary: any): string[] {
  if (typeof summary === "string") return [summary];
  const values = summary?.differences || summary?.warnings || [];
  return values
    .map((item: any) =>
      typeof item === "string" ? item : item.message || item.description || "",
    )
    .filter(Boolean);
}
function StartupFrame(props: { error?: string; onRetry: () => void }) {
  return <div class="desktop-app startup-shell" aria-busy={!props.error}>
    <aside class="sidebar" aria-label="试卷导航">
      <div class="sidebar-brand"><BookOpen size={26} /><strong>智教</strong></div>
      <nav class="sidebar-nav" aria-label="正在准备工作区">
        <button class="current" disabled><Plus size={20} />新建组卷</button>
        <button disabled><BookOpen size={19} />题库</button>
        <button disabled><Upload size={19} />导入试卷</button>
        <button disabled><UsersRound size={19} />学生管理</button>
      </nav>
      <p class="startup-sidebar-note">正在读取本机资料</p>
    </aside>
    <main class="main-panel"><div class="main-content new-content">
      <div class="new-heading"><h1>新建组卷</h1></div>
      <section class="startup-reader" aria-label="读取本机资料">
        <Show when={props.error} fallback={<Busy label="正在读取本机资料…" />}>
          <ErrorBanner message={props.error || ""} retry={props.onRetry} />
        </Show>
      </section>
    </div></main>
  </div>;
}
export default function App() {
  const query = new URLSearchParams(location.search);
  if (query.has("exportTask"))
    return (
      <ExportPage
        taskId={query.get("exportTask")!}
        paperId={query.get("paperId")!}
        kind={query.get("kind") === "teacher" ? "teacher" : "student"}
      />
    );
  const [loading, setLoading] = createSignal(true);
  const [fatal, setFatal] = createSignal("");
  const [developerEnabled, setDeveloperEnabled] = createSignal(false);
  const [developerLogOpen, setDeveloperLogOpen] = createSignal(false);
  let developerRefreshInFlight = false, developerRefreshQueued = false, developerAlive = true;
  async function refreshDeveloperCapabilities() {
    if (!developerAlive) return;
    if (developerRefreshInFlight) { developerRefreshQueued = true; return; }
    developerRefreshInFlight = true;
    try {
      const result = await request("developer_log_capabilities");
      if (developerAlive) setDeveloperEnabled(result.enabled === true);
    } catch { /* A transient read error must not close an already open log. */ }
    finally {
      developerRefreshInFlight = false;
      if (developerRefreshQueued && developerAlive) { developerRefreshQueued = false; void refreshDeveloperCapabilities(); }
    }
  }
  onMount(() => {
    const visible = () => { if (!document.hidden) void refreshDeveloperCapabilities(); };
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    onCleanup(() => {
      developerAlive = false;
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    });
  });
  const [assemblyLogTrace, setAssemblyLogTrace] = createSignal(currentAssemblyTraceId());
  onCleanup(subscribeAssemblyTrace(setAssemblyLogTrace));
  const [profile, setProfile] = createSignal<any>(null);
  const [directory, setDirectory] = createSignal("");
  const [config, setConfig] = createSignal<any>(null);
  const [configured, setConfigured] = createSignal(false);
  const [configurationLoading, setConfigurationLoading] = createSignal(false);
  const [configurationError, setConfigurationError] = createSignal("");
  const [modelLoading, setModelLoading] = createSignal(false);
  const [modelError, setModelError] = createSignal("");
  const [historyLoading, setHistoryLoading] = createSignal(false);
  const [historyError, setHistoryError] = createSignal("");
  let appAlive = true, startupReadVersion = 0, configurationReadVersion = 0, modelReadVersion = 0, historyReadVersion = 0;
  onCleanup(() => { appAlive = false; ++startupReadVersion; ++configurationReadVersion; ++modelReadVersion; ++historyReadVersion; });
  const assemblyStartupPending = () => configurationLoading() || modelLoading() || Boolean(configurationError() || modelError()) || !config();
  const [historyState, setHistoryState] = createStore<{drafts: any[]; papers: any[]}>({ drafts: [], papers: [] });
  const history = () => historyState;
  const [openingHistory, setOpeningHistory] = createSignal("");
  const [deleteTarget, setDeleteTarget] = createSignal<any>(null);
  const [deleteError, setDeleteError] = createSignal("");
  const [view, setView] = createSignal("new");
  const [studentsMounted, setStudentsMounted] = createSignal(false);
  const [studentJobs, setStudentJobs] = createSignal(0);
  createEffect(() => { if (view() === "students") setStudentsMounted(true); });
  const [importMounted, setImportMounted] = createSignal(false);
  const [importJobs, setImportJobs] = createSignal<any[]>([]);
  createEffect(() => { if (view() === "import") setImportMounted(true); });
  createEffect(() => {
    view();
    queueMicrotask(() =>
      document
        .querySelector(".main-panel")
        ?.scrollTo({ top: 0, behavior: "instant" }),
    );
  });
  const [stage, setStage] = createSignal("requirements");
  const [req, setReq] = createSignal<any>(null);
  const [intakeSummary, setIntakeSummary] = createSignal<any>(null);
  const [preparation, setPreparation] = createSignal<PreparationRun | null>(null);
  let preparationPresenter: ReturnType<typeof createPreparationPresenter> | undefined;
  onCleanup(() => preparationPresenter?.dispose());
  const [planning, setPlanning] = createSignal<BlueprintRun | null>(null);
  let planningPresenter: ReturnType<typeof createBlueprintPresenter> | undefined;
  onCleanup(() => planningPresenter?.dispose());
  const [selection, setSelection] = createSignal<SelectionRun | null>(null);
  let selectionPresenter: ReturnType<typeof createSelectionPresenter> | undefined;
  onCleanup(() => selectionPresenter?.dispose());
  const [warnings, setWarnings] = createSignal<string[]>([]);
  const [blueprint, setBlueprint] = createSignal<any>(null);
  const [draft, setDraft] = createSignal<any>(null);
  const [paper, setPaper] = createSignal<any>(null);
  const [busy, setBusy] = createSignal("");
  const [error, setError] = createSignal("");
  const [errorCode, setErrorCode] = createSignal("");
  const [settings, setSettings] = createSignal(false);
  const [guideTopic, setGuideTopic] = createSignal<"assembly" | "import" | null>(null);
  const [settingsModel, setSettingsModel] = createSignal(false);
  const [settingsOcr, setSettingsOcr] = createSignal(false);
  const [settingsImportContext, setSettingsImportContext] = createSignal<ImportConfigurationContext | null>(null);
  const [modelRevision, setModelRevision] = createSignal(0);
  const [bankState, setBankState] = createSignal<any>(null);
  const [sidebar, setSidebar] = createSignal(innerWidth > 760);
  const [composerKey, setComposerKey] = createSignal(0);
  const [composerStudentOffset, setComposerStudentOffset] = createSignal<number>();
  const [preview, setPreview] = createSignal(false);
  const [kind, setKind] = createSignal("student");
  const [rename, setRename] = createSignal(false);
  const [title, setTitle] = createSignal("");
  const [titleBusy, setTitleBusy] = createSignal(false);
  const [confirmation, setConfirmation] = createSignal<any>(null);
  let confirmationOperationId = operationId();
  let confirmationAttempt: any = null;
  const [confirmationFrozen, setConfirmationFrozen] = createSignal(false);
  const operationIds = new Map<string, string>();
  const [confirmName, setConfirmName] = createSignal("");
  const [acknowledged, setAcknowledged] = createSignal(false);
  const [derive, setDerive] = createSignal(false);
  const [feedback, setFeedback] = createSignal(false);
  const [willing, setWilling] = createSignal("yes");
  const [reason, setReason] = createSignal("");
  const [corrections, setCorrections] = createSignal("");
  const [review, setReview] = createSignal("");
  const [toast, setToast] = createSignal("");
  const [pdfResult, setPdfResult] = createSignal<any>(null);
  const [pdfPreview, setPdfPreview] = createSignal(false);
  function developerEvent(event: string, details: any = {}, traceId: string = currentAssemblyTraceId()) {
    if (developerEnabled()) void request("developer_assembly_event", { traceId, event, details }).catch(() => {});
  }
  let lastPreview: { traceId: string; kind: string; draftId?: string; paperId?: string } | undefined;
  createEffect(() => {
    const enabled = developerEnabled();
    const visible = !settings() && !openingHistory() && view() === "workbench" && (preview() || (stage() === "paper" && Boolean(paper())));
    const next = visible ? { traceId: assemblyLogTrace(), kind: kind(), draftId: draft()?.draftId, paperId: paper()?.paperId } : undefined;
    const changed = lastPreview && next && (lastPreview.traceId !== next.traceId || lastPreview.draftId !== next.draftId || lastPreview.paperId !== next.paperId);
    if (enabled) {
      if (lastPreview && (!next || changed)) developerEvent("preview_close", lastPreview, lastPreview.traceId);
      if (next && (!lastPreview || changed)) developerEvent("preview_open", next, next.traceId);
      else if (next && lastPreview?.kind !== next.kind) developerEvent("preview_kind_change", next, next.traceId);
    }
    lastPreview = next;
  });
  let lastPdfPreview = false;
  createEffect(() => {
    const visible = pdfPreview();
    if (visible && !lastPdfPreview) developerEvent("pdf_preview_open", { kind: kind(), paperId: paper()?.paperId });
    lastPdfPreview = visible;
  });
  let toastTimer: ReturnType<typeof setTimeout>;
  let renameInput!: HTMLInputElement;
  function notify(text: string) {
    setToast(text);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToast(""), 3500);
  }
  onCleanup(() => clearTimeout(toastTimer));
  async function refreshHistory() {
    const own = ++historyReadVersion;
    setHistoryLoading(true); setHistoryError("");
    try {
      const result = await request("history_list");
      if (appAlive && own === historyReadVersion) batch(() => {
        setHistoryState("drafts", reconcile((result.drafts || []).filter((item: any) => !item.confirmedPaperId), {key: "draftId"}));
        setHistoryState("papers", reconcile(result.papers || [], {key: "paperId"}));
      });
    } catch (failure: any) {
      if (appAlive && own === historyReadVersion) setHistoryError(failure.message || "试卷记录读取失败，请重试。");
      throw failure;
    } finally { if (appAlive && own === historyReadVersion) setHistoryLoading(false); }
  }
  async function refreshWorkspaceConfiguration() {
    const own = ++configurationReadVersion;
    setConfigurationLoading(true); setConfigurationError("");
    try {
      const result = await request("workspace_config_get");
      if (appAlive && own === configurationReadVersion) setConfig(result.config);
    } catch (failure: any) {
      if (appAlive && own === configurationReadVersion) setConfigurationError(failure.message || "题库目录读取失败，请重试。");
      throw failure;
    } finally { if (appAlive && own === configurationReadVersion) setConfigurationLoading(false); }
  }
  async function refreshAssemblyModel() {
    const own = ++modelReadVersion;
    setModelLoading(true); setModelError("");
    try {
      const model = await request("model_get");
      if (appAlive && own === modelReadVersion) setConfigured(model.configured === true);
    } catch (failure: any) {
      if (appAlive && own === modelReadVersion) { setConfigured(false); setModelError(failure.message || "模型设置读取失败，请重试。"); }
      throw failure;
    } finally { if (appAlive && own === modelReadVersion) setModelLoading(false); }
  }
  async function load() {
    const own = ++startupReadVersion;
    setLoading(true);
    setFatal("");
    try {
      const user = await request("profile_get");
      if (!appAlive || own !== startupReadVersion) return;
      batch(() => { setProfile(user.profile); setDirectory(user.dataDirectory || ""); setLoading(false); });
      if (user.profile) {
        // The shell and independent sections are usable once the real local
        // profile is known. Directory/model/history failures retry separately.
        void refreshWorkspaceConfiguration().catch(() => {});
        void refreshAssemblyModel().catch(() => {});
        void refreshHistory().catch(() => {});
        void refreshDeveloperCapabilities();
      }
    } catch (error: any) {
      if (appAlive && own === startupReadVersion) setFatal(error.message);
    } finally {
      if (appAlive && own === startupReadVersion) setLoading(false);
    }
  }
  onMount(load);
  async function perform(label: string, action: () => Promise<void>) {
    if (busy()) return;
    setBusy(label);
    setError("");
    setErrorCode("");
    try {
      await action();
    } catch (error: any) {
      setError(error.message);
      setErrorCode(error.code || "");
    } finally {
      setBusy("");
    }
  }
  function newPaper() {
    if (busy()) return;
    batch(() => { setView("new"); beginAssemblyTrace(); });
    developerEvent("new_assembly");
    setStage("requirements");
    setReq(null);
    setComposerStudentOffset(undefined);
    setIntakeSummary(null);
    setPreparation(null);
    setPlanning(null);
    setSelection(null);
    setBlueprint(null);
    setDraft(null);
    setPaper(null);
    setWarnings([]);
    setError("");
    setComposerKey((key) => key + 1);
    setSidebar(innerWidth > 760);
  }
  async function open(kind: string, id: string) {
    if (busy() || (view() === "workbench" && ((kind === "draft" && stage() === "draft" && activeDraft() === id) || (kind === "paper" && stage() === "paper" && activePaper() === id)))) return;
    batch(() => { setOpeningHistory(`${kind}:${id}`); beginAssemblyTrace(); });
    developerEvent("history_open", kind === "draft" ? { draftId: id } : { paperId: id });
    try {
      await perform("正在打开试卷…", async () => {
        const result = await request(kind === "draft" ? "draft_get" : "paper_get", { ...(kind === "draft" ? {draftId: id} : {paperId: id}), assemblyTraceId: currentAssemblyTraceId() });
        batch(() => {
          if (kind === "draft") {
            setDraft(result.draft);
            setPaper(null);
            setReq(result.draft.baseline.requirements);
            setStage("draft");
          } else {
            setPaper(result.paper);
            setDraft(null);
            setReq(result.paper.draft.baseline.requirements);
            setStage("paper");
          }
          setBlueprint(null);
          setView("workbench");
          setSidebar(innerWidth > 760);
          setRename(false);
          setPdfResult(null);
        });
      });
    } finally {
      setOpeningHistory("");
    }
  }
  function askDelete(kind: string, item: any) {
    if (busy()) return;
    setDeleteError("");
    setDeleteTarget({kind, id: kind === "draft" ? item.draftId : item.paperId, title: item.title || "未命名练习", revision: item.revision, operationId: operationId()});
  }
  async function deleteHistoryItem() {
    const target = deleteTarget();
    if (!target || busy()) return;
    const current = view() === "workbench" && ((target.kind === "draft" && stage() === "draft" && activeDraft() === target.id) || (target.kind === "paper" && stage() === "paper" && activePaper() === target.id));
    let deleted = false;
    setBusy("正在删除记录…");
    setDeleteError("");
    try {
      await request("history_delete", {kind: target.kind, id: target.id, operationId: target.operationId, ...(target.kind === "draft" ? {expectedRevision: target.revision} : {})});
      deleted = true;
      await refreshHistory().catch(() => {
        if (target.kind === "draft") setHistoryState("drafts", (rows) => rows.filter((item) => item.draftId !== target.id));
        else setHistoryState("papers", (rows) => rows.filter((item) => item.paperId !== target.id));
      });
      setDeleteTarget(null);
      notify("已删除");
    } catch (error: any) {
      setDeleteError(error.message);
    } finally {
      setBusy("");
    }
    if (deleted && current) newPaper();
  }
  function configureAssemblyModel() {
    setSettingsImportContext(null);
    setSettingsModel(true);
    setSettingsOcr(false);
    setSettings(true);
  }
  async function prepare(requirements: any, message: string, _mode: string, studentOffset?: number) {
    if (busy() || assemblyStartupPending()) return;
    if (!configured()) { configureAssemblyModel(); return; }
    const mode = "llm";
    const runId = operationId();
    setComposerStudentOffset(studentOffset);
    setPreparation({ runId, requirements, message, mode, studentOffset, startedAt: Date.now(), status: "running" });
    setView("preparing");
    setBusy("正在整理组卷要求…");
    setError("");
    setErrorCode("");
    const presenter = createPreparationPresenter(runId, mode, steps => setPreparation(run => run?.runId === runId ? { ...run, steps } : run));
    preparationPresenter = presenter;
    let unlisten: (() => void) | undefined;
    try {
        unlisten = await listenPreparationProgress(presenter.receive);
        if (preparation()?.stopping) {
          setPreparation(run => run && ({ ...run, status: "cancelled", finishedAt: Date.now() }));
          return;
        }
        setPreparation(run => run && ({ ...run, requestStarted: true }));
        const result = await request("intake_prepare", {
          runId,
          requirements,
          message,
          mode,
          quantityAuthority: requirements.quantityAuthority || {},
        });
        setPreparation(run => run && ({ ...run, result, backendFinished: true, finishedAt: Date.now() }));
        const shown = await presenter.finish(result.workflowSteps as PreparationStepId[]);
        if (!shown || preparation()?.stopping) {
          setPreparation(run => run && ({ ...run, status: "succeeded", stopping: false }));
          return;
        }
        setPreparation(run => run && ({ ...run, result, status: "succeeded", finishedAt: run.finishedAt || Date.now() }));
        acceptPreparedResult(result);
    } catch (failure: any) {
      setPreparation(run => run && ({ ...run, status: run.stopping || failure.code === "cancelled" ? "cancelled" : "failed", error: failure.message, finishedAt: Date.now() }));
    } finally {
      presenter.dispose();
      unlisten?.();
      if (preparationPresenter === presenter) preparationPresenter = undefined;
      setBusy("");
    }
  }
  function acceptPreparedResult(result: any) {
    setDraft(null);
    setPaper(null);
    setBlueprint(null);
    setReq(result.requirements);
    setIntakeSummary(result.summary);
    setWarnings((result.warnings || []).map((item: any) => typeof item === "string" ? item : item.message));
    setView("workbench");
    setStage("review");
  }
  async function stopPreparation() {
    if (preparation()?.status !== "running" || preparation()?.stopping) return;
    developerEvent("cancel", { mode: preparation()?.mode, runId: preparation()?.runId });
    setPreparation(run => run && ({ ...run, stopping: true }));
    preparationPresenter?.dispose();
    if (preparation()?.backendFinished || !preparation()?.requestStarted) return;
    try { await cancel(); }
    catch (failure: any) {
      setError(failure.message);
      setPreparation(run => run && ({ ...run, stopping: false }));
    }
  }
  function retryPreparation() {
    const run = preparation();
    developerEvent("retry", { mode: run?.mode, runId: run?.runId });
    if (run) void prepare(run.requirements, run.message, run.mode, run.studentOffset);
  }
  async function plan(_mode: string, requirements = req()) {
    if (busy()) return;
    if (!configured()) { configureAssemblyModel(); return; }
    const mode = "llm";
    const runId = operationId();
    const confirmed = structuredClone({ ...requirements, quantityAuthority: { questionCount: true, counts: true, typeConstraints: true } });
    setPlanning({ runId, requirements: confirmed, mode, startedAt: Date.now(), status: "running" });
    setView("planning");
    setBusy("正在安排题位…");
    setError("");
    setErrorCode("");
    const presenter = createBlueprintPresenter(runId, steps => setPlanning(run => run?.runId === runId ? { ...run, steps } : run));
    planningPresenter = presenter;
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listenBlueprintProgress(presenter.receive);
      if (planning()?.stopping) {
        setPlanning(run => run && ({ ...run, status: "cancelled", stopping: false, finishedAt: Date.now() }));
        return;
      }
      setPlanning(run => run && ({ ...run, requestStarted: true }));
      const result = await request("blueprint_plan", {
        runId,
        requirements: confirmed,
        mode,
      });
      setPlanning(run => run && ({ ...run, result, backendFinished: true, finishedAt: Date.now() }));
      const shown = await presenter.finish(result.workflowSteps as BlueprintStepId[]);
      const advance = shown && !planning()?.stopping;
      setPlanning(run => run && ({ ...run, status: "succeeded", stopping: false }));
      if (advance) acceptPlannedResult(result);
    } catch (failure: any) {
      setPlanning(run => run && ({ ...run, status: run.stopping || failure.code === "cancelled" ? "cancelled" : "failed", stopping: false, error: failure.message, finishedAt: Date.now() }));
    } finally {
      presenter.dispose();
      unlisten?.();
      if (planningPresenter === presenter) planningPresenter = undefined;
      setBusy("");
    }
  }
  function acceptPlannedResult(result: any) {
    setBlueprint(result.blueprint);
    setReq(result.blueprint.requirements || req());
    setStage("blueprint");
    setView("workbench");
  }
  async function stopPlanning() {
    const run = planning();
    if (run?.status !== "running" || run.stopping) return;
    developerEvent("cancel", { mode: run.mode, runId: run.runId });
    const presenter = planningPresenter;
    setPlanning(run => run && ({ ...run, stopping: true, error: undefined }));
    if (run.backendFinished || !run.requestStarted) { presenter?.dispose(); return; }
    try {
      await cancel();
      presenter?.dispose();
    }
    catch (failure: any) {
      setPlanning(current => current?.runId === run.runId && current.status === "running" ? { ...current, stopping: false, error: failure.message } : current);
    }
  }
  function retryPlanning() {
    const run = planning();
    developerEvent("retry", { mode: run?.mode, runId: run?.runId });
    if (run) void plan(run.mode, run.requirements);
  }
  async function select(_mode: string, confirmed = blueprint()) {
    if (busy()) return;
    if (!configured()) { configureAssemblyModel(); return; }
    const runId = operationId();
    const selectedBlueprint = structuredClone(confirmed);
    setSelection({ runId, blueprint: selectedBlueprint, startedAt: Date.now(), status: "running" });
    setView("selecting");
    setBusy("正在选题并生成草稿…");
    setError("");
    setErrorCode("");
    const presenter = createSelectionPresenter(runId, steps => setSelection(run => run?.runId === runId ? { ...run, steps } : run));
    selectionPresenter = presenter;
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listenSelectionProgress(presenter.receive);
      if (selection()?.stopping) {
        setSelection(run => run && ({ ...run, status: "cancelled", stopping: false, finishedAt: Date.now() }));
        return;
      }
      setSelection(run => run && ({ ...run, requestStarted: true }));
      const result = await request("draft_create", { runId, blueprint: selectedBlueprint, mode: "llm" });
      setSelection(run => run && ({ ...run, result, backendFinished: true, finishedAt: Date.now() }));
      await refreshHistory().catch(() => notify("草稿已保存，列表暂时无法刷新"));
      const shown = await presenter.finish(result.workflowSteps as SelectionStepId[]);
      const advance = shown && !selection()?.stopping;
      setSelection(run => run && ({ ...run, status: "succeeded", stopping: false }));
      if (advance) acceptSelectedResult(result);
    } catch (failure: any) {
      setSelection(run => run && ({ ...run, status: run.stopping || failure.code === "cancelled" ? "cancelled" : "failed", stopping: false, error: failure.message, finishedAt: Date.now() }));
    } finally {
      presenter.dispose();
      unlisten?.();
      if (selectionPresenter === presenter) selectionPresenter = undefined;
      setBusy("");
    }
  }
  function acceptSelectedResult(result: any) {
    setDraft(result.draft);
    setPaper(null);
    setReq(result.draft.baseline.requirements);
    setStage("draft");
    setView("workbench");
  }
  async function stopSelection() {
    const run = selection();
    if (run?.status !== "running" || run.stopping) return;
    developerEvent("cancel", { mode: "llm", runId: run.runId });
    const presenter = selectionPresenter;
    setSelection(current => current && ({ ...current, stopping: true, error: undefined }));
    if (run.backendFinished || !run.requestStarted) { presenter?.dispose(); return; }
    try { await cancel(); presenter?.dispose(); }
    catch (failure: any) {
      setSelection(current => current?.runId === run.runId && current.status === "running" ? { ...current, stopping: false, error: failure.message } : current);
    }
  }
  function retrySelection() {
    const run = selection();
    developerEvent("retry", { mode: "llm", runId: run?.runId });
    if (run) void select("llm", run.blueprint);
  }
  async function operation(operation: any) {
    if (busy()) throw new Error("正在处理，请稍后重试。");
    setBusy(operation.type === "replace" && !operation.candidateId && draft()?.selectionGeneration?.mode !== "manual" ? "正在由模型评估题目…" : "正在保存…");
    setError("");
    setErrorCode("");
    try {
      const signature = JSON.stringify({
        draftId: draft().draftId,
        revision: draft().revision,
        operation,
      });
      if (!operationIds.has(signature))
        operationIds.set(signature, operationId());
      const result = await request("draft_operation", {
        draftId: draft().draftId,
        operation: {
          ...operation,
          operationId: operationIds.get(signature),
          expectedRevision: draft().revision,
        },
      });
      setDraft(result.draft);
      await refreshHistory().catch(() => notify("已保存，列表暂时无法刷新"));
    } catch (error: any) {
      setError(error.message);
      setErrorCode(error.code || "");
      throw error;
    } finally {
      setBusy("");
    }
  }
  function revise() {
    setPreparation(null);
    setStage("requirements");
    setView("new");
    setComposerKey((key) => key + 1);
  }
  const currentRequirements = () =>
    stage() === "paper"
      ? paper()?.draft?.baseline?.requirements || req()
      : draft()?.baseline?.requirements || req();
  const currentTitle = () =>
    stage() === "paper"
      ? paper()?.title
      : stage() === "draft"
        ? draft()?.title
        : blueprint()?.title || req()?.title || "本次练习";
  const scopeNames = () =>
    (currentRequirements()?.mainScope || [])
      .map(
        (id: string) =>
          config()?.chapters?.find((chapter: any) => chapter.id === id)
            ?.label || id,
      )
      .join("、");
  async function saveTitle() {
    if (!rename() || titleBusy()) return;
    const next = title().trim();
    if (!next || next.length > 120 || /[\u0000-\u001f\u007f]/.test(next)) {
      setError("名称需为 1～120 个字符，不能包含换行。");
      return;
    }
    if (next === draft().title) {
      setRename(false);
      return;
    }
    setTitleBusy(true);
    try {
      await operation({ type: "rename", title: next });
      setRename(false);
      notify("名称已保存");
    } catch {
      queueMicrotask(() => renameInput?.focus());
    } finally {
      setTitleBusy(false);
    }
  }
  async function beginConfirm() {
    await perform("正在检查试卷…", async () => {
      const result = await request("paper_confirmation", {
        draftId: draft().draftId,
      });
      confirmationOperationId = operationId();
      confirmationAttempt = null;
      setConfirmationFrozen(false);
      setConfirmation(result.summary);
      setConfirmName(draft().title);
      setAcknowledged(false);
    });
  }
  async function confirm() {
    if (!confirmName().trim()) return;
    if (!confirmationAttempt && confirmName().trim() !== draft().title) {
      try {
        await operation({ type: "rename", title: confirmName().trim() });
      } catch {
        return;
      }
    }
    if (!confirmationAttempt) {
      confirmationAttempt = {
        draftId: draft().draftId,
        operationId: confirmationOperationId,
        expectedRevision: draft().revision,
        acknowledgeDifferences: acknowledged(),
      };
      setConfirmationFrozen(true);
    }
    await perform("正在保存成卷…", async () => {
      const result = await request("paper_confirm", confirmationAttempt);
      setPaper(result.paper);
      setDraft(null);
      setStage("paper");
      setConfirmation(null);
      setKind("student");
      setPdfResult(null);
      await refreshHistory();
      notify("试卷已保存");
    });
  }
  async function reloadConfirmation() {
    await perform("正在重新读取…", async () => {
      const result = await request("draft_get", { draftId: draft().draftId });
      if (result.draft.confirmedPaperId) {
        const frozen = await request("paper_get", {
          paperId: result.draft.confirmedPaperId,
        });
        setPaper(frozen.paper);
        setDraft(null);
        setStage("paper");
        setConfirmation(null);
        await refreshHistory();
        return;
      }
      setDraft(result.draft);
      const review = await request("paper_confirmation", {
        draftId: result.draft.draftId,
      });
      confirmationAttempt = null;
      confirmationOperationId = operationId();
      setConfirmationFrozen(false);
      setConfirmation(review.summary);
      setConfirmName(result.draft.title);
      setAcknowledged(false);
    });
  }
  async function exportPdf() {
    await perform(
      `正在生成${kind() === "teacher" ? "教师" : "学生"}卷 PDF…`,
      async () => {
        const result = await request("pdf_export", {
          paperId: paper().paperId,
          kind: kind(),
        });
        setPdfResult(result);
        notify("PDF 已生成");
      },
    );
  }
  function saveFeedback() {
    perform("正在保存反馈…", async () => {
      await request("feedback_save", {
        paperId: paper().paperId,
        willingToUse: willing(),
        reason: reason(),
        manualCorrections: corrections(),
      });
      setFeedback(false);
      notify("反馈已保存");
    });
  }
  const activeDraft = () => draft()?.draftId;
  const activePaper = () => paper()?.paperId;
  return (
    <Show
      when={!loading()}
      fallback={<StartupFrame onRetry={load} />}
    >
      <Show
        when={!fatal()}
        fallback={<StartupFrame error={fatal()} onRetry={load} />}
      >
        <Show when={profile()} fallback={<FirstRun onDone={() => load()} />}>
          <div class={`desktop-app ${sidebar() ? "" : "sidebar-collapsed"}`} style={{ display: settings() ? "none" : undefined }}>
            <aside class={`sidebar ${openingHistory() ? "opening-history" : ""}`} aria-label="试卷导航">
              <div class="sidebar-brand">
                <BookOpen size={26} />
                <strong>智教</strong>
                <button
                  class="icon-button"
                  aria-label="收起侧栏"
                  title="收起侧栏"
                  onClick={() => setSidebar(false)}
                >
                  <PanelLeftClose size={19} />
                </button>
              </div>
              <nav class="sidebar-nav">
                <button
                  class={view() === "new" ? "current" : ""}
                  disabled={Boolean(busy())}
                  onClick={newPaper}
                >
                  <Plus size={20} />
                  新建组卷
                </button>
                <button
                  class={view() === "bank" ? "current" : ""}
                  disabled={Boolean(busy())}
                  onClick={() => {
                    setView("bank");
                    setSidebar(innerWidth > 760);
                  }}
                >
                  <BookOpen size={19} />
                  题库
                </button>
                <button
                  class={view() === "import" ? "current" : ""}
                  disabled={Boolean(busy())}
                  onClick={() => {
                    setView("import");
                    setSidebar(innerWidth > 760);
                  }}
                >
                  <Upload size={19} />
                  导入试卷
                  <Show when={importJobs().some(job => ["queued", "running"].includes(job.status))}><small class="import-nav-count" aria-label="后台导入中">{importJobs().filter(job => ["queued", "running"].includes(job.status)).length}</small></Show>
                </button>
                <button aria-label="学生管理" class={view() === "students" ? "current" : ""} disabled={Boolean(busy())} onClick={() => { setView("students"); setSidebar(innerWidth > 760); }}><UsersRound size={19} />学生管理<Show when={studentJobs()}><small class="import-nav-count" aria-label="后台批改中">{studentJobs()}</small></Show></button>
              </nav>
              <div class="history-scroll" aria-busy={historyLoading()}>
                <Show when={historyLoading()}><p class="history-loading" role="status">正在读取试卷记录…</p></Show>
                <Show when={historyError()}><div class="history-read-error"><ErrorBanner message={historyError()} retry={() => void refreshHistory().catch(() => {})} /></div></Show>
                <section>
                  <div class="history-label">
                    草稿 <span>{historyLoading() ? "…" : historyError() && !history().drafts.length ? "—" : history().drafts.length}</span>
                  </div>
                  <Show when={!historyLoading() && !historyError() && !history().drafts.length}>
                    <p class="history-empty">还没有草稿</p>
                  </Show>
                  <For each={history().drafts}>
                    {(item) => (
                      <div class="history-row" data-history-id={item.draftId}>
                      <button
                        class={`history-item ${view() === "workbench" && stage() === "draft" && activeDraft() === item.draftId ? "current" : ""}`}
                        disabled={Boolean(busy())}
                        onClick={() => open("draft", item.draftId)}
                        title={item.title}
                      >
                        <FileText size={16} />
                        <span class="history-item-body">
                          <strong>{item.title || "未命名练习"}</strong>
                          <span class="history-item-meta"><StudentLabels value={item} />
                          <small>
                            {item.questionCount ??
                              item.stats?.questionCount ??
                              item.slots?.length ??
                              ""}{" "}
                            题 ·{" "}
                            {new Date(
                              item.createdAt || item.updatedAt,
                            ).toLocaleDateString("zh-CN", {
                              month: "numeric",
                              day: "numeric",
                            })}
                          </small></span>
                        </span>
                      </button>
                      <button type="button" class="history-delete" title="删除" aria-label={`删除草稿：${item.title || "未命名练习"}`} disabled={Boolean(busy())} onClick={() => askDelete("draft", item)}><Trash2 size={15} /></button>
                      </div>
                    )}
                  </For>
                </section>
                <section>
                  <div class="history-label">
                    试卷 <span>{historyLoading() ? "…" : historyError() && !history().papers.length ? "—" : history().papers.length}</span>
                  </div>
                  <Show when={!historyLoading() && !historyError() && !history().papers.length}>
                    <p class="history-empty">还没有确认的试卷</p>
                  </Show>
                  <For each={history().papers}>
                    {(item) => (
                      <div class="history-row" data-history-id={item.paperId}>
                      <button
                        class={`history-item ${view() === "workbench" && stage() === "paper" && activePaper() === item.paperId ? "current" : ""}`}
                        disabled={Boolean(busy())}
                        onClick={() => open("paper", item.paperId)}
                        title={item.title}
                      >
                        <FileText size={16} />
                        <span class="history-item-body">
                          <strong>{item.title || "练习"}</strong>
                          <span class="history-item-meta"><StudentLabels value={item} />
                          <small>
                            {item.questionCount ??
                              item.summary?.stats?.questionCount ??
                              item.stats?.questionCount ??
                              item.draft?.slots?.length ??
                              ""}{" "}
                            题 ·{" "}
                            {new Date(
                              item.createdAt || item.confirmedAt,
                            ).toLocaleDateString("zh-CN", {
                              month: "numeric",
                              day: "numeric",
                            })}
                          </small></span>
                        </span>
                      </button>
                      <button type="button" class="history-delete" title="删除" aria-label={`删除试卷：${item.title || "未命名练习"}`} disabled={Boolean(busy())} onClick={() => askDelete("paper", item)}><Trash2 size={15} /></button>
                      </div>
                    )}
                  </For>
                </section>
              </div>
              <button class="guide-entry guide-sidebar-entry" onClick={() => setGuideTopic(view() === "import" ? "import" : "assembly")}>
                <CircleHelp size={18} />使用指南
              </button>
              <button
                class="profile-button"
                disabled={Boolean(busy())}
                onClick={() => {
                  setSettingsImportContext(view() === "import" ? { from: "import" } : null);
                  setSettingsModel(false);
                      setSettingsOcr(false);
                  setSettings(true);
                }}
              >
                <span class="avatar">{profile()?.nickname?.slice(0, 1)}</span>
                <span>{profile()?.nickname}</span>
                <SettingsIcon size={17} />
              </button>
            </aside>
            <main class={`main-panel ${view() === "bank" ? "bank-main-panel" : ""}`}>
              <Show when={!sidebar()}>
                <button
                  class="icon-button sidebar-toggle"
                  title="展开侧栏"
                  aria-label="展开侧栏"
                  onClick={() => setSidebar(true)}
                >
                  <PanelLeftOpen size={20} />
                </button>
              </Show>
              <div
                class={`main-content ${["new", "preparing", "planning", "selecting"].includes(view()) ? "new-content" : ""} ${["preparing", "planning", "selecting"].includes(view()) ? "preparation-workspace" : ""} ${view() === "students" ? "student-content" : ""} ${view() === "bank" ? "bank-content" : ""} ${view() === "import" ? "import-content" : ""} ${view() === "workbench" && stage() === "draft" ? "draft-content" : ""}`}
              >
                <Show when={config()?.bankWarning}>
                  <p class="warning-text" role="alert">
                    {config().bankWarning}
                  </p>
                </Show>
                <Show when={!config() && ["bank", "import", "workbench"].includes(view())}>
                  <section class="workspace-loading" aria-label="读取题库目录">
                    <Show when={configurationError()} fallback={<Busy label="正在读取题库目录…" />}>
                      <ErrorBanner message={configurationError()} retry={() => void refreshWorkspaceConfiguration().catch(() => {})} />
                    </Show>
                  </section>
                </Show>
                <Show when={config() && configurationError()}><ErrorBanner message={configurationError()} retry={() => void refreshWorkspaceConfiguration().catch(() => {})} /></Show>
                <Show when={view() === "preparing" && preparation()}>{run => <PreparationConversation run={run()} config={config()} onStop={() => void stopPreparation()} onRetry={retryPreparation} onEdit={() => { setPreparation(null); setView("new"); }} onReview={() => { if (!busy() && run().result) acceptPreparedResult(run().result); }} />}</Show>
                <Show when={view() === "planning" && planning()}>{run => <BlueprintProgress run={run()} onStop={() => void stopPlanning()} onRetry={retryPlanning} onBack={() => { if (!busy()) { setView("workbench"); setStage("review"); } }} onReview={() => { if (!busy() && run().result) acceptPlannedResult(run().result); }} />}</Show>
                <Show when={view() === "selecting" && selection()}>{run => <SelectionProgress run={run()} onStop={() => void stopSelection()} onRetry={retrySelection} onBack={() => { if (!busy()) { setView("workbench"); setStage("blueprint"); } }} onReview={() => { if (!busy() && run().result) acceptSelectedResult(run().result); }} />}</Show>
                <div hidden={view() !== "new" || Boolean(preparation())} class="composer-workspace">
                  <div class="new-heading">
                    <h1>新建组卷</h1>
                    <button class="guide-entry guide-context-entry" onClick={() => setGuideTopic("assembly")}><CircleHelp size={16} />了解如何组卷</button>
                  </div>
                  <Show when={!config()}>
                    <section class="workspace-loading" aria-label="读取题库目录">
                      <Show when={configurationError()} fallback={<Busy label="正在读取题库目录…" />}>
                        <ErrorBanner message={configurationError()} retry={() => void refreshWorkspaceConfiguration().catch(() => {})} />
                      </Show>
                    </section>
                  </Show>
                  <Show when={modelLoading()}><p class="assembly-model-loading" role="status">正在读取模型设置…</p></Show>
                  <Show when={modelError()}><ErrorBanner message={modelError()} retry={() => void refreshAssemblyModel().catch(() => {})} /></Show>
                  <Show when={config()}>
                    <Show keyed when={composerKey() + 1}>
                      {(_key: number) => (
                        <Composer
                          config={config()}
                          initial={req()}
                          initialStudentOffset={composerStudentOffset()}
                          busy={Boolean(busy()) || assemblyStartupPending()}
                          configured={configured()}
                          onSubmit={prepare}
                          onConfigure={configureAssemblyModel}
                        />
                      )}
                    </Show>
                  </Show>
                </div>
                <Show when={view() === "bank" && config()}>
                  <Bank
                    config={config()}
                    initial={bankState()}
                    onState={setBankState}
                    onImport={() => setView("import")}
                    onBusy={(value) => setBusy(value ? "正在创建草稿…" : "")}
                    onCreated={async (created) => {
                      setDraft(created);
                      setReq(created.baseline.requirements);
                      setPaper(null);
                      setBlueprint(null);
                      setIntakeSummary(null);
                      setWarnings([]);
                      setError("");
                      setErrorCode("");
                      setRename(false);
                      setPdfResult(null);
                      setStage("draft");
                      setView("workbench");
                      setSidebar(innerWidth > 760);
                      notify("草稿已创建");
                      try {
                        await refreshHistory();
                      } catch {
                        notify("草稿已创建，历史列表暂未刷新；可稍后重新打开。");
                      }
                    }}
                  />
                </Show>
                <Show when={importMounted() && config()}>
                  <div hidden={view() !== "import"}>
                  <ImportPaper
                    visible={view() === "import"}
                    config={config()}
                    sidebarExpanded={sidebar()}
                    onFocusReview={() => setSidebar(false)}
                    onGuide={() => setGuideTopic("import")}
                    onAssembly={() => setView("new")}
                    modelRevision={modelRevision()}
                    onConfigure={(section?: "models" | "ocr", context?: ImportConfigurationContext) => {
                      setSettingsImportContext(context || { from: "import" });
                      setSettingsModel(section !== "ocr");
                      setSettingsOcr(section === "ocr");
                      setSettings(true);
                    }}
                    onBank={async () => {
                      await refreshWorkspaceConfiguration();
                      setView("bank");
                    }}
                    onPublished={refreshWorkspaceConfiguration}
                    onBusy={(value) => setBusy(value ? "import" : "")}
                    onJobsChange={setImportJobs}
                    onNotice={notify}
                  />
                  </div>
                </Show>
                <Show when={studentsMounted()}><div hidden={view() !== "students"}><StudentWork active={view() === "students"} onJobs={setStudentJobs} onConfigure={() => { setSettingsImportContext(null); setSettingsModel(true); setSettingsOcr(true); setSettings(true); }} /></div></Show>
                <Show when={view() === "workbench" && config()}>
                  <Show when={stage() === "review" && preparation()?.status === "succeeded"}><PreparationConversation run={preparation()!} config={config()} compact /></Show>
                  <header class="page-heading">
                    <div class="heading-main">
                      <Show
                        when={rename()}
                        fallback={
                          <h1
                            class={stage() === "draft" ? "editable-title" : ""}
                            title={currentTitle()}
                          >
                            <Show
                              when={stage() === "draft"}
                              fallback={currentTitle()}
                            >
                              <button
                                onClick={() => {
                                  setTitle(draft().title);
                                  setRename(true);
                                  queueMicrotask(() => {
                                    renameInput.focus();
                                    renameInput.select();
                                  });
                                }}
                                title="修改试卷名称"
                                aria-label={`修改试卷名称：${currentTitle()}`}
                                disabled={Boolean(busy())}
                              >
                                {currentTitle()}
                                <Pencil size={16} aria-hidden="true" />
                              </button>
                            </Show>
                          </h1>
                        }
                      >
                        <input
                          ref={renameInput}
                          class="title-input"
                          aria-label="试卷名称"
                          maxlength={120}
                          value={title()}
                          disabled={titleBusy()}
                          onInput={(event) =>
                            setTitle(event.currentTarget.value)
                          }
                          onBlur={saveTitle}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              saveTitle();
                            }
                            if (event.key === "Escape") {
                              event.preventDefault();
                              setRename(false);
                            }
                          }}
                        />
                      </Show>
                      <p class="workbench-subtitle">
                        {purposeLabel(currentRequirements()?.purpose)}
                        <Show when={scopeNames()}> · {scopeNames()}</Show>
                      </p>
                      <StudentLabels value={currentRequirements()} />
                    </div>
                    <Show
                      when={stage() === "paper"}
                      fallback={
                        <Show when={stage() !== "draft"}>
                          <button
                            class="secondary"
                            disabled={Boolean(busy())}
                            onClick={revise}
                          >
                            <Pencil size={16} />
                            修改需求
                          </button>
                        </Show>
                      }
                    >
                      <div class="header-actions">
                        <button
                          class="secondary"
                          disabled={Boolean(busy())}
                          onClick={() => setDerive(true)}
                        >
                          <Pencil size={16} />
                          继续编辑
                        </button>
                        <button
                          class="secondary"
                          onClick={() => setFeedback(true)}
                        >
                          <MessageSquare size={16} />
                          反馈
                        </button>
                      </div>
                    </Show>
                  </header>
                  <Show when={stage() === "review"}>
                    <section class="requirements-review">
                      <h2>本次练习</h2>
                      <p class="review-goal">
                        <RichText text={teachingDisplayText(req()?.goal || "按选择范围安排练习")} />
                      </p>
                      <Show when={req()?.scopeResolution?.source === "model_suggestion"}>
                        <div class="quantity-plan-reason"><span>AI 范围建议</span><RichText text={teachingDisplayText(req().scopeResolution.rationale)} /><Show when={req().scopeResolution.changed}>（已依据你的输入重新确定范围，请核对后确认。）</Show></div>
                      </Show>
                      <div class="review-fields">
                        <label>
                          题量
                          <input
                            type="number"
                            min="1"
                            max="60"
                            aria-label="总题量"
                            value={counts(req())}
                            onInput={(event) => {
                              const amount = Number(event.currentTarget.value);
                              const previous = req();
                              const next = resizeQuestionCounts(previous, amount);
                              if (next !== previous) setReq({ ...next, quantityAuthority: { ...previous.quantityAuthority, questionCount: true } });
                            }}
                          />
                        </label>
                        <label>
                          时长
                          <input
                            type="number"
                            min="1"
                            max="300"
                            value={req()?.durationMinutes || 45}
                            onInput={(event) =>
                              setReq({
                                ...req(),
                                durationMinutes: Number(
                                  event.currentTarget.value,
                                ),
                              })
                            }
                          />
                          <span>分钟</span>
                        </label>
                        <span>
                          {req()?.scoringMode === "none"
                            ? "不计分"
                            : `${req()?.targetScore} 分`}
                        </span>
                        <div class="assembly-type-summary" aria-label="题型安排">
                          <For each={typeIds.filter(type => req()?.counts?.[type] > 0)}>
                            {type => <span>{typeLabels[type]} {req().counts[type]} 题</span>}
                          </For>
                        </div>
                      </div>
                      <Show when={req()?.quantityPlan?.source === "model_suggestion" && typeIds.every(type => req().quantityPlan.counts?.[type] === req().counts?.[type])}>
                        <div class="quantity-plan-reason"><span>AI 配比建议</span><RichText text={teachingDisplayText(req().quantityPlan.rationale)} /></div>
                      </Show>
                      <details>
                        <summary>安排说明</summary>
                        <dl class="explanation-list">
                          <div>
                            <dt>范围</dt>
                            <dd>{scopeNames()}</dd>
                          </div>
                          <div>
                            <dt>题型</dt>
                            <dd>
                              <For each={typeIds}>
                                {(type) => (
                                  <span class="type-summary">
                                    {typeLabels[type]}{" "}
                                    {req()?.counts?.[type] || 0} 题
                                  </span>
                                )}
                              </For>
                            </dd>
                          </div>
                          <Show when={req()?.teacherRequest}>
                            <div>
                              <dt>补充</dt>
                              <dd><RichText text={req().teacherRequest} /></dd>
                            </div>
                          </Show>
                          <Show when={typeof intakeSummary() === "string"}>
                            <div>
                              <dt>说明</dt>
                              <dd><RichText text={teachingDisplayText(intakeSummary())} /></dd>
                            </div>
                          </Show>
                          <For each={warnings()}>
                            {(warning) => (
                              <div>
                                <dt>提示</dt>
                                <dd class="warning-text"><RichText text={teachingDisplayText(warning)} /></dd>
                              </div>
                            )}
                          </For>
                        </dl>
                      </details>
                      <div class="review-confirm">
                        <button
                          class="primary"
                          disabled={Boolean(busy())}
                          onClick={() => plan("llm")}
                        >
                          确认需求，安排练习 <ChevronRight size={17} />
                        </button>
                      </div>
                    </section>
                  </Show>
                  <Show when={stage() === "blueprint"}>
                    <BlueprintView
                      blueprint={blueprint()}
                      config={config()}
                      busy={Boolean(busy())}
                      configured={configured()}
                      onConfigure={configureAssemblyModel}
                      onChange={setBlueprint}
                      onSelect={select}
                    />
                  </Show>
                  <Show when={stage() === "draft" && draft()}>
                    <DraftView
                      draft={draft()}
                      config={config()}
                      busy={Boolean(busy())}
                      operation={operation}
                      onRefreshDraft={next => setDraft(current => current?.draftId === next?.draftId && next.revision >= current.revision ? next : current)}
                      preview={() => {
                        setPreview(true);
                        setKind("student");
                      }}
                      confirm={beginConfirm}
                      details={() => setReview("requirements")}
                    />
                  </Show>
                  <Show when={stage() === "paper" && paper()}>
                    <div class="paper-output-toolbar">
                      <div
                        class="type-tabs"
                        role="tablist"
                        aria-label="试卷版本"
                      >
                        <button
                          role="tab"
                          disabled={Boolean(busy())}
                          aria-selected={kind() === "student"}
                          onClick={() => {
                            setKind("student");
                            setPdfResult(null);
                          }}
                        >
                          学生卷
                        </button>
                        <button
                          role="tab"
                          disabled={Boolean(busy())}
                          aria-selected={kind() === "teacher"}
                          onClick={() => {
                            setKind("teacher");
                            setPdfResult(null);
                          }}
                        >
                          教师卷
                        </button>
                      </div>
                      <button
                        class="primary"
                        disabled={Boolean(busy())}
                        onClick={exportPdf}
                      >
                        <Download size={16} />
                        生成{kind() === "teacher" ? "教师" : "学生"}卷 PDF
                      </button>
                    </div>
                    <Show when={pdfResult()}>
                      <div class="pdf-result" role="status">
                        <Check size={16} />
                        <span>PDF 已保存：{pdfResult().path}</span>
                        <button
                          class="secondary"
                          onClick={() => setPdfPreview(true)}
                        >
                          预览 PDF
                        </button>
                      </div>
                      <Show when={pdfResult().warning}>
                        <p class="warning-text" role="alert">
                          {pdfResult().warning}
                        </p>
                      </Show>
                    </Show>
                    <div class="paper-preview-surface">
                      <PaperSheet
                        draft={paper().draft}
                        title={paper().title}
                        kind={kind()}
                      />
                    </div>
                  </Show>
                </Show>
                <ErrorBanner message={error()} />
                <Show when={errorCode() === "revision_conflict" && draft()}>
                  <button
                    class="secondary"
                    disabled={Boolean(busy())}
                    onClick={() =>
                      perform("正在重新读取…", async () => {
                        const result = await request("draft_get", {
                          draftId: draft().draftId,
                        });
                        setDraft(result.draft);
                        await refreshHistory();
                      })
                    }
                  >
                    重新读取草稿
                  </button>
                </Show>
                <Show when={busy() && !["import", "bank", "preparing", "planning", "selecting"].includes(view())}>
                  <Busy
                    label={busy()}
                    cancel={
                      busy().includes("比较") ||
                      busy().includes("评估") ||
                      busy().includes("安排") ||
                      busy().includes("整理")
                        ? () =>
                            cancel().catch((error: any) =>
                              setError(error.message),
                            )
                        : undefined
                    }
                  />
                </Show>
              </div>
            </main>
          </div>
          <Show when={guideTopic()}>
            {(topic) => <Modal title="使用指南" onClose={() => setGuideTopic(null)} wide><UsageGuide initialTopic={topic()} /></Modal>}
          </Show>
          <Show when={settings()}>
            <Settings
              profile={profile()}
              dataDirectory={directory()}
              showModel={settingsModel()}
              showOcr={settingsOcr()}
              importContext={settingsImportContext()}
              onBankChanged={refreshWorkspaceConfiguration}
              onDeveloperModeChange={enabled => { setDeveloperEnabled(enabled); if (!enabled) setDeveloperLogOpen(false); }}
              onClose={() => {
                setSettings(false);
                setSettingsImportContext(null);
                if (innerWidth <= 760) setSidebar(false);
              }}
              onSaved={async (value) => {
                setProfile(value);
                try {
                  await refreshAssemblyModel();
                } catch {
                  setConfigured(false);
                }
                setModelRevision((value) => value + 1);
                notify("设置已保存");
              }}
            />
          </Show>
          <Show when={preview()}>
            <Modal title="试卷预览" onClose={() => setPreview(false)} wide>
              <div class="type-tabs" role="tablist" aria-label="预览版本">
                <button
                  role="tab"
                  aria-selected={kind() === "student"}
                  onClick={() => setKind("student")}
                >
                  学生卷
                </button>
                <button
                  role="tab"
                  aria-selected={kind() === "teacher"}
                  onClick={() => setKind("teacher")}
                >
                  教师卷
                </button>
              </div>
              <PaperSheet
                draft={draft()}
                title={draft()?.title}
                kind={kind()}
              />
            </Modal>
          </Show>
          <Show when={confirmation()}>
            <Modal
              title="确认成卷"
              stable
              onClose={() => setConfirmation(null)}
              busy={Boolean(busy())}
              footer={
                <>
                  <button
                    class="secondary"
                    disabled={Boolean(busy())}
                    onClick={() => setConfirmation(null)}
                  >
                    返回编辑
                  </button>
                  <button
                    class="primary"
                    disabled={
                      Boolean(busy()) ||
                      !confirmName().trim() ||
                      confirmation()?.canConfirm === false ||
                      (confirmation()?.requiresAcknowledgement &&
                        !acknowledged())
                    }
                    onClick={confirm}
                  >
                    确认保存
                  </button>
                </>
              }
            >
              <label class="field-label">
                试卷名称
                <input
                  maxLength={120}
                  disabled={confirmationFrozen() || Boolean(busy())}
                  value={confirmName()}
                  onInput={(event) => setConfirmName(event.currentTarget.value)}
                />
              </label>
              <ErrorBanner message={error()} />
              <Show when={error()}>
                <button
                  class="secondary"
                  disabled={Boolean(busy())}
                  onClick={reloadConfirmation}
                >
                  重新读取
                </button>
              </Show>
              <Show when={confirmationFrozen() && error()}>
                <p class="muted">本次保存信息已保留，重试会核对同一次操作。</p>
              </Show>
              <p class="muted">
                保存后内容固定。继续调整会创建新草稿，保留原卷。
              </p>
              <Show when={summaryMessages(confirmation()).length}>
                <ul class="confirmation-differences">
                  <For each={summaryMessages(confirmation())}>
                    {(message) => <li>{message}</li>}
                  </For>
                </ul>
              </Show>
              <Show when={confirmation()?.requiresAcknowledgement}>
                <label class="acknowledgement">
                  <input
                    type="checkbox"
                    checked={acknowledged()}
                    disabled={confirmationFrozen() || Boolean(busy())}
                    onChange={(event) =>
                      setAcknowledged(event.currentTarget.checked)
                    }
                  />
                  我已了解以上差异，确认保留当前试卷
                </label>
              </Show>
            </Modal>
          </Show>
          <Show when={deleteTarget()}>
            <Modal title={deleteTarget()?.kind === "draft" ? "删除草稿" : "删除试卷"} onClose={() => setDeleteTarget(null)} busy={Boolean(busy())}
              footer={<><button class="secondary" disabled={Boolean(busy())} onClick={() => setDeleteTarget(null)}>取消</button><button class="primary" disabled={Boolean(busy())} onClick={deleteHistoryItem}>删除</button></>}>
              <p>删除“{deleteTarget()?.title}”？</p>
              <p class="muted">删除后从列表移除，题库和已生成的 PDF 保留。</p>
              <ErrorBanner message={deleteError()} />
              <Show when={deleteError()}><button class="secondary" disabled={Boolean(busy())} onClick={async () => {
                const target = deleteTarget();
                if (!target || busy()) return;
                let resetCurrent = false;
                setBusy("正在重新读取记录…");
                try {
                  await refreshHistory();
                  const latest = (target.kind === "draft" ? history().drafts : history().papers).find((item: any) => (target.kind === "draft" ? item.draftId : item.paperId) === target.id);
                  if (!latest) {
                    setDeleteTarget(null);
                    resetCurrent = view() === "workbench" && ((target.kind === "draft" && stage() === "draft" && activeDraft() === target.id) || (target.kind === "paper" && stage() === "paper" && activePaper() === target.id));
                  } else {
                    setDeleteTarget({...target, revision: latest.revision, operationId: operationId()});
                    setDeleteError("");
                  }
                } catch (error: any) { setDeleteError(error.message); }
                finally { setBusy(""); }
                if (resetCurrent) newPaper();
              }}>重新读取</button></Show>
            </Modal>
          </Show>
          <Show when={derive()}>
            <Modal
              title="继续编辑"
              onClose={() => setDerive(false)}
              busy={Boolean(busy())}
              footer={
                <>
                  <button
                    class="secondary"
                    onClick={() => setDerive(false)}
                    disabled={Boolean(busy())}
                  >
                    取消
                  </button>
                  <button
                    class="primary"
                    disabled={Boolean(busy())}
                    onClick={() =>
                      perform("正在创建草稿…", async () => {
                        const result = await request("paper_derive", {
                          paperId: paper().paperId,
                          operationId: operationId(),
                        });
                        setDraft(result.draft);
                        setStage("draft");
                        setDerive(false);
                        await refreshHistory();
                        notify("已创建可编辑草稿");
                      })
                    }
                  >
                    确认
                  </button>
                </>
              }
            >
              <p>创建一份可编辑的草稿，原试卷和 PDF 保留。</p>
            </Modal>
          </Show>
          <Show when={feedback()}>
            <Modal
              title="反馈"
              stable
              onClose={() => setFeedback(false)}
              busy={Boolean(busy())}
              footer={
                <button
                  class="primary"
                  disabled={Boolean(busy())}
                  onClick={saveFeedback}
                >
                  保存反馈
                </button>
              }
            >
              <label class="field-label">
                愿意使用这份试卷吗？
                <select
                  value={willing()}
                  onChange={(event) => setWilling(event.currentTarget.value)}
                >
                  <option value="yes">愿意</option>
                  <option value="no">暂不愿意</option>
                </select>
              </label>
              <label class="field-label">
                原因
                <textarea
                  value={reason()}
                  maxLength={2000}
                  onInput={(event) => setReason(event.currentTarget.value)}
                  placeholder="哪些地方有帮助，哪些需要改进？"
                />
              </label>
              <label class="field-label">
                手工修改 <span class="muted">选填</span>
                <textarea
                  value={corrections()}
                  maxLength={2000}
                  onInput={(event) => setCorrections(event.currentTarget.value)}
                />
              </label>
              <ErrorBanner message={error()} />
            </Modal>
          </Show>
          <Show when={review()}>
            <Drawer title="组卷说明" onClose={() => setReview("")}>
              <section class="assembly-details-section">
                <h3>本次要求</h3>
                <dl class="explanation-list">
                  <div><dt>用途</dt><dd>{purposeLabel(currentRequirements()?.purpose)}</dd></div>
                  <div><dt>范围</dt><dd>{scopeNames()}</dd></div>
                  <div><dt>原定题量</dt><dd>{counts(currentRequirements())} 题 · {currentRequirements()?.durationMinutes} 分钟</dd></div>
                  <div><dt>要求</dt><dd><RichText text={currentRequirements()?.teacherRequest || currentRequirements()?.goal || ""} /></dd></div>
                </dl>
              </section>
              <section class="assembly-details-section">
                <h3>当前题位安排</h3>
                <p class="muted assembly-type-summary">
                  <For each={typeIds.filter((type) => (draft()?.slots || blueprint()?.slots || []).some((slot: any) => slot.questionType === type))}>
                    {(type) => <span>{typeLabels[type]} {(draft()?.slots || blueprint()?.slots || []).filter((slot: any) => slot.questionType === type).length} 题</span>}
                  </For>
                </p>
                <table class="assembly-slot-table">
                  <thead><tr><th>题位</th><th>题型</th><th>考查点</th><th>难度</th></tr></thead>
                  <tbody>
                    <For each={draft()?.slots || blueprint()?.slots || []}>
                      {(slot: any) => <tr>
                        <td>{slot.number}</td>
                        <td>{typeLabels[slot.questionType] || slot.questionType}</td>
                        <td><RichText text={teachingDisplayText(slot.taskLabel || config()?.tasks.find((task: any) => task.id === slot.taskId)?.label || "未指定考查点")} /></td>
                        <td class="assembly-slot-difficulty">
                          {slotDifficulty(slot, currentRequirements(), draft()?.baseline?.questionIndexSnapshot).label}
                          <Show when={slotDifficulty(slot, currentRequirements(), draft()?.baseline?.questionIndexSnapshot).detail}>
                            <small>{slotDifficulty(slot, currentRequirements(), draft()?.baseline?.questionIndexSnapshot).detail}</small>
                          </Show>
                        </td>
                      </tr>}
                    </For>
                  </tbody>
                </table>
                <p class="muted assembly-difficulty-note">难度要求是选题偏好，题目难度为内容估计。可在题目“调整”中修改要求，现题保留。</p>
              </section>
            </Drawer>
          </Show>
          <Show when={toast()}>
            <div class="toast" role="status">
              <Check size={17} />
              {toast()}
            </div>
          </Show>
          <Show when={developerEnabled() && !settings() && ["new", "preparing", "planning", "selecting", "workbench", "bank"].includes(view())}>
            <button type="button" class="developer-log-entry" aria-controls="developer-assembly-log-window" aria-expanded={developerLogOpen()} onClick={() => setDeveloperLogOpen(value => !value)} title="查看组卷开发日志"><FileCode2 size={16} />开发日志</button>
          </Show>
          <Show when={developerEnabled() && developerLogOpen()}><DeveloperAssemblyLog traceId={assemblyLogTrace()} onClose={() => setDeveloperLogOpen(false)} /></Show>
        </Show>
      </Show>
      <Show when={pdfPreview() && paper()}>
        <Modal title="PDF 预览" onClose={() => setPdfPreview(false)} wide>
          <div class="type-tabs" role="tablist" aria-label="PDF 版本">
            <button
              role="tab"
              aria-selected={kind() === "student"}
              onClick={() => setKind("student")}
            >
              学生卷
            </button>
            <button
              role="tab"
              aria-selected={kind() === "teacher"}
              onClick={() => setKind("teacher")}
            >
              教师卷
            </button>
          </div>
          <PdfPreview paperId={paper().paperId} kind={kind()} />
        </Modal>
      </Show>
    </Show>
  );
}
