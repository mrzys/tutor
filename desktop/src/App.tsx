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
  typeIds,
  typeLabels,
} from "./bridge";
import { Busy, ErrorBanner, Modal, Drawer, StudentLabels } from "./ui";
import { Composer } from "./Composer";
import { Settings } from "./Settings";
import { DraftView } from "./Draft";
import { BlueprintView } from "./Blueprint";
import { Bank } from "./Bank";
import { ImportPaper } from "./ImportPaper";
import { StudentWork } from "./StudentWork";
import { UsageGuide } from "./UsageGuide";
import "./GuideEntry.css";
import { PaperSheet, RichText } from "./Paper";
import { waitForPaperAssets } from "./rich-content";
import { resizeQuestionCounts, slotDifficulty } from "./assembly-details";
const PdfPreview = lazy(() =>
  import("./PdfPreview").then((module) => ({ default: module.PdfPreview })),
);

function ExportPage(props: { taskId: string; paperId: string; kind: string }) {
  const [paper, setPaper] = createSignal<any>(null);
  const [error, setError] = createSignal("");
  onMount(async () => {
    try {
      const result = await request("paper_get", { paperId: props.paperId });
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
  const [profile, setProfile] = createSignal<any>(null);
  const [directory, setDirectory] = createSignal("");
  const [config, setConfig] = createSignal<any>(null);
  const [configured, setConfigured] = createSignal(false);
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
  let toastTimer: ReturnType<typeof setTimeout>;
  let renameInput!: HTMLInputElement;
  function notify(text: string) {
    setToast(text);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToast(""), 3500);
  }
  onCleanup(() => clearTimeout(toastTimer));
  async function refreshHistory() {
    const result = await request("history_list");
    batch(() => {
      setHistoryState("drafts", reconcile((result.drafts || []).filter((item: any) => !item.confirmedPaperId), {key: "draftId"}));
      setHistoryState("papers", reconcile(result.papers || [], {key: "paperId"}));
    });
  }
  async function load() {
    setLoading(true);
    setFatal("");
    try {
      const user = await request("profile_get");
      setProfile(user.profile);
      setDirectory(user.dataDirectory || "");
      if (user.profile) {
        const [boot, model] = await Promise.all([
          request("bootstrap"),
          request("model_get"),
        ]);
        setConfig(boot.config);
        setConfigured(model.configured === true);
        await refreshHistory();
      }
    } catch (error: any) {
      setFatal(error.message);
    } finally {
      setLoading(false);
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
    setView("new");
    setStage("requirements");
    setReq(null);
    setComposerStudentOffset(undefined);
    setIntakeSummary(null);
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
    setOpeningHistory(`${kind}:${id}`);
    try {
      await perform("正在打开试卷…", async () => {
        const result = await request(kind === "draft" ? "draft_get" : "paper_get", kind === "draft" ? {draftId: id} : {paperId: id});
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
  function prepare(requirements: any, message: string, mode: string, studentOffset?: number) {
    setComposerStudentOffset(studentOffset);
    perform(
      mode === "llm" ? "正在整理组卷要求…" : "正在整理要求…",
      async () => {
        const result = await request("intake_prepare", {
          requirements,
          message,
          mode,
          quantityAuthority: requirements.quantityAuthority || {},
        });
        setDraft(null);
        setPaper(null);
        setBlueprint(null);
        setReq(result.requirements);
        setIntakeSummary(result.summary);
        setWarnings(
          (result.warnings || []).map((item: any) =>
            typeof item === "string" ? item : item.message,
          ),
        );
        setView("workbench");
        setStage("review");
      },
    );
  }
  function plan(mode: string) {
    perform("正在安排题位…", async () => {
      const result = await request("blueprint_plan", {
        requirements: { ...req(), quantityAuthority: { questionCount: true, counts: true, typeConstraints: true } },
        mode,
      });
      setBlueprint(result.blueprint);
      setReq(result.blueprint.requirements || req());
      setStage("blueprint");
    });
  }
  function select(mode: string) {
    perform(
      mode === "llm" ? "正在比较本地题目并生成草稿…" : "正在从本地题库选题…",
      async () => {
        const checked = await request("blueprint_check", {
          blueprint: blueprint(),
        });
        setBlueprint(checked.blueprint);
        const result = await request("draft_create", {
          blueprint: checked.blueprint,
          mode,
        });
        setDraft(result.draft);
        setReq(result.draft.baseline.requirements);
        setStage("draft");
        await refreshHistory();
      },
    );
  }
  async function operation(operation: any) {
    if (busy()) throw new Error("正在处理，请稍后重试。");
    setBusy("正在保存…");
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
      fallback={
        <div class="startup">
          <Busy label="正在打开智教…" />
        </div>
      }
    >
      <Show
        when={!fatal()}
        fallback={
          <div class="startup">
            <ErrorBanner message={fatal()} retry={load} />
          </div>
        }
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
              <div class="history-scroll">
                <section>
                  <div class="history-label">
                    草稿 <span>{history().drafts.length}</span>
                  </div>
                  <Show when={!history().drafts.length}>
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
                    试卷 <span>{history().papers.length}</span>
                  </div>
                  <Show when={!history().papers.length}>
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
                class={`main-content ${view() === "new" ? "new-content" : ""} ${view() === "students" ? "student-content" : ""} ${view() === "bank" ? "bank-content" : ""} ${view() === "import" ? "import-content" : ""} ${view() === "workbench" && stage() === "draft" ? "draft-content" : ""}`}
              >
                <Show when={config()?.bankWarning}>
                  <p class="warning-text" role="alert">
                    {config().bankWarning}
                  </p>
                </Show>
                <div hidden={view() !== "new"} class="composer-workspace">
                  <div class="new-heading">
                    <h1>新建组卷</h1>
                    <p class="muted">选择范围和用途，补充题量或考查重点。</p>
                    <button class="guide-entry guide-context-entry" onClick={() => setGuideTopic("assembly")}><CircleHelp size={16} />了解如何组卷</button>
                  </div>
                  <Show when={config()}>
                    <Show keyed when={composerKey() + 1}>
                      {(_key: number) => (
                        <Composer
                          config={config()}
                          initial={req()}
                          initialStudentOffset={composerStudentOffset()}
                          busy={Boolean(busy())}
                          configured={configured()}
                          onSubmit={prepare}
                        />
                      )}
                    </Show>
                  </Show>
                </div>
                <Show when={view() === "bank"}>
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
                <Show when={importMounted()}>
                  <div hidden={view() !== "import"}>
                  <ImportPaper
                    config={config()}
                    onGuide={() => setGuideTopic("import")}
                    onAssembly={() => setView("new")}
                    modelRevision={modelRevision()}
                    onConfigure={(section) => {
                      setSettingsModel(section !== "ocr");
                      setSettingsOcr(section === "ocr");
                      setSettings(true);
                    }}
                    onBank={async () => {
                      const boot = await request("bootstrap");
                      setConfig(boot.config);
                      setView("bank");
                    }}
                    onPublished={async () => {
                      const boot = await request("bootstrap");
                      setConfig(boot.config);
                    }}
                    onBusy={(value) => setBusy(value ? "import" : "")}
                    onJobsChange={setImportJobs}
                    onNotice={notify}
                  />
                  </div>
                </Show>
                <Show when={studentsMounted()}><div hidden={view() !== "students"}><StudentWork active={view() === "students"} onJobs={setStudentJobs} onConfigure={() => { setSettingsModel(true); setSettingsOcr(true); setSettings(true); }} /></div></Show>
                <Show when={view() === "workbench"}>
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
                                disabled={Boolean(busy())}
                              >
                                {currentTitle()}
                                <Pencil size={16} />
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
                        <RichText text={req()?.goal || "按选择范围安排练习"} />
                      </p>
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
                        <p class="quantity-plan-reason"><span>AI 配比建议</span>{req().quantityPlan.rationale}</p>
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
                              <dd>{req().teacherRequest}</dd>
                            </div>
                          </Show>
                          <Show when={typeof intakeSummary() === "string"}>
                            <div>
                              <dt>说明</dt>
                              <dd>{intakeSummary()}</dd>
                            </div>
                          </Show>
                          <For each={warnings()}>
                            {(warning) => (
                              <div>
                                <dt>提示</dt>
                                <dd class="warning-text">{warning}</dd>
                              </div>
                            )}
                          </For>
                        </dl>
                      </details>
                      <div class="review-confirm">
                        <button
                          class="primary"
                          disabled={Boolean(busy())}
                          onClick={() => plan(configured() ? "llm" : "rule")}
                        >
                          确认需求，安排练习 <ChevronRight size={17} />
                        </button>
                        <Show when={configured()}>
                          <button
                            disabled={Boolean(busy())}
                            onClick={() => plan("rule")}
                          >
                            使用规则预设
                          </button>
                        </Show>
                      </div>
                    </section>
                  </Show>
                  <Show when={stage() === "blueprint"}>
                    <BlueprintView
                      blueprint={blueprint()}
                      config={config()}
                      busy={Boolean(busy())}
                      configured={configured()}
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
                <Show when={busy() && view() !== "import" && view() !== "bank"}>
                  <Busy
                    label={busy()}
                    cancel={
                      busy().includes("比较") ||
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
                <Show when={error() && stage() === "review" && configured()}>
                  <button
                    class="secondary"
                    disabled={Boolean(busy())}
                    onClick={() => plan("rule")}
                  >
                    使用规则预设
                  </button>
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
              onBankChanged={async()=>setConfig((await request("bootstrap")).config)}
              onClose={() => {
                setSettings(false);
                if (innerWidth <= 760) setSidebar(false);
              }}
              onSaved={async (value) => {
                setProfile(value);
                try {
                  const model = await request("model_get");
                  setConfigured(model.configured === true);
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
                  <div><dt>要求</dt><dd>{currentRequirements()?.teacherRequest || currentRequirements()?.goal}</dd></div>
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
                        <td>{slot.taskLabel || config()?.tasks.find((task: any) => task.id === slot.taskId)?.label || "未指定考查点"}</td>
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
