import {
  For,
  Index,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  lazy,
  Suspense,
  batch,
  untrack,
} from "solid-js";
import {
  Check,
  FileText,
  Upload,
  Save,
  Eye,
  Pencil,
  ArrowLeft,
  Plus,
  Trash2,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  AlertCircle,
  AlertTriangle,
  RotateCcw,
  Link as LinkIcon,
  MoreHorizontal,
  Columns2,
  PanelLeftClose,
  Image as ImageIcon,
} from "lucide-solid";
import {
  typeIds,
  operationId,
  request,
  typeLabels,
  typeTitles,
  listenImportProgress,
} from "./bridge";
import { Busy, ErrorBanner, Modal } from "./ui";
import { QuestionBody, RichText } from "./Paper";
import { difficultyLevels } from "./assembly-details";
import { assetKey, assetReferences } from "./rich-content";
import { importPreviewStem } from "./shared/source-label.mjs";
import { requiredReviewChecks, sourceReviewLabel, sourceReviewDescription, briefReviewReasons, importTeachingPresentation, importAssessmentPresentation, hasUnstartedTeaching,
  teachingAcknowledgementPayload, teachingPatchPayload, type TeachingIssueRow, type TeachingReviewControls } from "./import-review";
import { TeachingReviewActions } from "./TeachingAnalysis";
import { importModelReadiness, importModelReady } from "./import-model-readiness";
import { importTriage, type TriageIssue } from "./import-triage";
import { groupReviewIssues, isReviewOutcomeGroup, isReviewProcessGroup, sourceCorrectionForGroup, reviewDisplayMessage, reviewFieldLabel, type ReviewIssueGroup, type SourceCorrectionDisplay } from "./import-review-presentation";
import { importTeachingStatus } from "./import-teaching-status";
import { ReviewMarkedText } from "./ReviewMarkedText";
import { importFailure, importStage } from "./import-process";
import { sourceConfirmationUpdate, sourceConfirmationScopeLabel } from "./import-source-confirmation";
import { compactTeachingText, teachingDisplayText } from "./teaching-text";
import { isReviewReady, reviewRowsForFilter, nextReviewQuestion, reviewStatusLabel } from "./import-review-flow";
import { hasImportQuestionDetail, mergeImportView, createImportRefreshQueue } from "./import-detail-sync";
import "./ImportPaper.css";
const SourceCompare = lazy(() => import("./SourceCompare").then(module => ({ default: module.SourceCompare })));
const SourcePageViewer = lazy(() => import("./SourceCompare").then(module => ({ default: module.SourcePageViewer })));
const PdfPreview = lazy(() => import("./PdfPreview").then(module => ({ default: module.PdfPreview })));

const statusLabels: Record<string, string> = {
  prepared: "待处理",
  review: "待处理",
  pending_review: "待处理",
  parsed: "待处理",
  failed: "处理未完成",
  cancelled: "已停止",
  parsing: "解析中",
  processing: "待继续解析",
  partially_published: "部分已入库",
  published: "已入库",
};
const checkLabels: Record<string, string> = {
  sourceMatched: "题干与选项",
  answerChecked: "答案",
  solutionChecked: "解析与步骤",
  formulaChecked: "公式、图片与表格",
};
const checkDescriptions: Record<string, string> = {
  sourceMatched: "对照原卷，检查题号、条件、选项及小问，确认没有遗漏或串题。",
  answerChecked: "有原卷答案时核对结果与选项；原卷无答案时，确认仍为空缺，未混入旧库参考。",
  solutionChecked: "核对推导、计算与小问对应关系；原卷无解析时，确认仍为空缺，未补编步骤。",
  formulaChecked: "核对正负号、上下标、分式与根号，以及配图、表格和合并单元格是否完整。",
};
type ImportDiagnostic = {
  stageKey?: string;
  stageLabel?: string;
  category?: string;
  categoryLabel?: string;
  subcategoryLabel?: string;
  serviceLabel?: string;
  operationLabel?: string;
  causeNote?: string;
  stage: string;
  summary: string;
  location?: string;
  nextAction: string;
  attempts: number;
  ocrCompleted: boolean;
  sourceBatchCount?: number;
  completedSourceBatches?: number;
  savedSourceQuestions?: number;
  expectedSourceQuestions?: number;
  failedSourceLabels?: string[];
  indexCalls?: number;
  transcriptionCalls?: number;
  sourceRequestBreakdown?: boolean;
};
function message(value: any): string {
  return typeof value === "string"
    ? value
    : value?.message || value?.description || "";
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function MathSnippetBar(props: { onInsert: (snippet: string) => void }) {
  const snippets = [
    { label: "$...$", snippet: "$$", title: "行内数学公式" },
    { label: "a/b", snippet: "\\frac{a}{b}", title: "分式" },
    { label: "√x", snippet: "\\sqrt{x}", title: "根号" },
    { label: "x²", snippet: "^{2}", title: "上标/平方" },
    { label: "x₁", snippet: "_{1}", title: "下标" },
    { label: "≤", snippet: "\\le ", title: "小于等于" },
    { label: "≥", snippet: "\\ge ", title: "大于等于" },
    { label: "≠", snippet: "\\neq ", title: "不等于" },
    { label: "∈", snippet: "\\in ", title: "属于" },
    { label: "⊂", snippet: "\\subset ", title: "真子集" },
    { label: "±", snippet: "\\pm ", title: "正负号" },
    { label: "π", snippet: "\\pi ", title: "圆周率" },
    { label: "△", snippet: "\\triangle ", title: "三角形" },
    { label: "∠", snippet: "\\angle ", title: "角" },
    { label: "a⃗", snippet: "\\vec{a}", title: "向量" },
  ];
  return (
    <div class="import-math-toolbar" role="toolbar" aria-label="常用数学符号快捷插入">
      <span class="import-math-toolbar-label">常用符号:</span>
      <For each={snippets}>
        {(item) => (
          <button
            type="button"
            class="import-math-token"
            title={item.title}
            onClick={() => props.onInsert(item.snippet)}
          >
            {item.label}
          </button>
        )}
      </For>
    </div>
  );
}

export function ImportPaper(props: {
  config: any;
  onGuide?: () => void;
  modelRevision: number;
  onConfigure: (section?: "models" | "ocr") => void;
  onBank: () => Promise<void>;
  onAssembly?: () => void;
  sidebarExpanded?: boolean;
  visible?: boolean;
  onFocusReview?: () => void;
  onPublished: () => Promise<void>;
  onBusy: (busy: boolean) => void;
  onJobsChange?: (jobs: any[]) => void;
  onNotice?: (message: string) => void;
}) {
  const [checking, setChecking] = createSignal(true);
  const [importConfigured, setImportConfigured] = createSignal(false);
  const [sourceConfigured, setSourceConfigured] = createSignal(false);
  const [teachingConfigured, setTeachingConfigured] = createSignal(false);
  const [activeConfigured, setActiveConfigured] = createSignal(false);
  const configured = () => record()?.questions?.length ? teachingConfigured() : importConfigured();
  const [ocrConfigured, setOcrConfigured] = createSignal(false);
  const [ocrWarning, setOcrWarning] = createSignal("");
  const [configurationTarget, setConfigurationTarget] = createSignal<"models" | "ocr" | null>(null);
  const [fileKind, setFileKind] = createSignal<"document" | "text">("document");
  const [modelWarning, setModelWarning] = createSignal("");
  const [history, setHistory] = createSignal<any[]>([]);
  const [historyPage, setHistoryPage] = createSignal(1);
  const [historyTotal, setHistoryTotal] = createSignal(0);
  const [historyPages, setHistoryPages] = createSignal(1);
  const [historyLoading, setHistoryLoading] = createSignal(true);
  const [historyError, setHistoryError] = createSignal("");
  const HISTORY_PAGE_SIZE = 10;
  const [record, setRecord] = createSignal<any>(null);
  const [diagnostic, setDiagnostic] = createSignal<ImportDiagnostic | null>(null);
  const [questions, setQuestions] = createSignal<any[]>([]);
  const [selected, setSelected] = createSignal(0);
  const [file, setFile] = createSignal<File | null>(null);
  const [busy, setBusy] = createSignal("");
  const [error, setError] = createSignal("");
  const [dirty, setDirty] = createSignal(false);
  const [editBaseRevision, setEditBaseRevision] = createSignal<number>();
  const editBuffers = new Map<string, any>();
  const [reviewEligibility, setReviewEligibility] = createSignal<Record<string, any>>({});
  const [teachingControls, setTeachingControls] = createSignal<Record<string, TeachingReviewControls>>({});
  const [teachingActions, setTeachingActions] = createSignal<Record<string, any>>({});
  const [sourceCorrectionDisplays, setSourceCorrectionDisplays] = createSignal<Record<string, SourceCorrectionDisplay[]>>({});
  const [triageFilter, setTriageFilter] = createSignal("todo");
  const [focusedIssue, setFocusedIssue] = createSignal("");
  const [locationNotice, setLocationNotice] = createSignal("");
  const [teachingDirty, setTeachingDirty] = createSignal(false);
  const [editTeachingRequest, setEditTeachingRequest] = createSignal(0);
  const [leaveAction, setLeaveAction] = createSignal<null | (() => void)>(null);
  const [questionAction, setQuestionAction] = createSignal<null | { kind: "retry" | "publish"; questionId: string; revision: number; binding: any }>(null);
  const [preview, setPreview] = createSignal(true);
  const [originalPreview, setOriginalPreview] = createSignal(false);
  const [sourceCompare, setSourceCompare] = createSignal(false);
  const [sourceConfirmed, setSourceConfirmed] = createSignal(false);
  const [reviewView, setReviewView] = createSignal<"split" | "image" | "text">("split");
  const [splitRatio, setSplitRatio] = createSignal<"equal" | "image" | "text">("equal");
  let lastFocusedTextarea: HTMLTextAreaElement | null = null;
  const [sourceFocusRequest, setSourceFocusRequest] = createSignal(0);
  const [detailTab, setDetailTab] = createSignal<"solution" | "assessment">("solution");
  const [reviewDomain, setReviewDomain] = createSignal<"source" | "teaching">("source");
  const [editTeachingField, setEditTeachingField] = createSignal("");
  const [sourceConfirmationNote, setSourceConfirmationNote] = createSignal("");
  const [recordToolsOpen, setRecordToolsOpen] = createSignal(false);
  const [jobs, setJobs] = createSignal<any[]>([]);
  const [jobError, setJobError] = createSignal("");
  const selectedJob = () => jobs().find(job => job.importId === record()?.importId);
  const activeJob = () => { const job = selectedJob(); return job && ["queued", "running"].includes(job.status) ? job : null; };
  let recordDetailVersion: string | undefined;
  let importUnlisten: (() => void) | undefined;
  let connectingImportEvents: Promise<void> | undefined;
  const [importEventError, setImportEventError] = createSignal("");
  const [importEventsReady, setImportEventsReady] = createSignal(false);
  const [pendingDetailRefresh, setPendingDetailRefresh] = createSignal(false);
  const [questionLoading, setQuestionLoading] = createSignal(false);
  const [questionError, setQuestionError] = createSignal("");
  const [questionRetry, setQuestionRetry] = createSignal(0);
  let questionReadVersion = 0;
  let jobSignature = "";
  let jobPollVersion = 0;
  const jobStates = new Map<string, string>();
  const [catalog, setCatalog] = createSignal<any>(null);
  const [confirmPublish, setConfirmPublish] = createSignal(false);
  const [publishError, setPublishError] = createSignal("");
  const [notice, setNotice] = createSignal("");
  const [cancelled, setCancelled] = createSignal(false);
  const [publishFrozen, setPublishFrozen] = createSignal(false);
  let publishAttempt: any = null;
  let fileInput!: HTMLInputElement;
  let alive = true;
  let configVersion = 0;
  let openVersion = 0;
  let historyVersion = 0;
  let requestedHistoryPage = 1;
  let historyRegion: HTMLElement | undefined;
  let detailHeading: HTMLHeadingElement | undefined;
  let recordToolsElement: HTMLDivElement | undefined;
  let recordToolsButton: HTMLButtonElement | undefined;
  let prepareId = operationId();
  let prepareAttempt: any = null;
  const operationIds = new Map<string, string>();
  const selectedQuestionId = () => questions()[selected()]?.questionId;
  const current = createMemo(() => hasImportQuestionDetail(questions()[selected()]) ? questions()[selected()] : undefined);
  const triage = createMemo(() => importTriage({ ...record(), questions: questions() }, reviewEligibility(), teachingControls(), activeJob()?.mode === "teaching_retry" ? activeJob().targetQuestionIds || [] : [], teachingActions(), dirty()));
  const currentTriage = createMemo(() => triage().rows.find(row => row.questionId === selectedQuestionId()));
  const reviewGroups = createMemo(() => groupReviewIssues(currentTriage()?.issues || []));
  const teachingStatus = createMemo(() => importTeachingStatus(current(), { triage: currentTriage() }));
  const reviewProblemGroups = createMemo(() => reviewGroups().filter(group => !isReviewOutcomeGroup(group)
    && !(["generation_failed", "review_failed"].includes(teachingStatus().kind) && isReviewProcessGroup(group,
      teachingStatus().kind === "review_failed" ? current()?.teachingWorkflow?.retainedInitialReason || "" : ""))));
  const reviewOutcomeGroups = createMemo(() => reviewGroups().filter(isReviewOutcomeGroup));
  const sourceProblemCount = createMemo(() => reviewProblemGroups().filter(group => group.domain === "source").length);
  const teachingProblemCount = createMemo(() => reviewProblemGroups().filter(group => group.domain === "teaching").length);
  const visibleReviewProblems = createMemo(() => reviewProblemGroups().filter(group => group.domain === reviewDomain()));
  let reviewQuestionIdentity = "";
  createEffect(() => {
    const identity = `${record()?.importId}|${current()?.questionId}`;
    if (identity === reviewQuestionIdentity) return;
    reviewQuestionIdentity = identity;
    setReviewDomain(sourceProblemCount() || currentTriage()?.sourceState === "blocked" ? "source"
      : currentTriage()?.issues.some(issue => issue.domain === "teaching") ? "teaching" : "source");
  });
  const currentCorrection = (group: ReviewIssueGroup) => sourceCorrectionForGroup(group, sourceCorrectionDisplays()[current()?.questionId] || [], dirty());
  const correctedSource = createMemo(() => {
    if (currentTriage()?.published || currentTriage()?.duplicateState === "exact" || current()?.reviewDecision === "reject") return false;
    const sourceGroups = reviewProblemGroups().filter(group => group.domain === "source");
    return sourceGroups.length > 0 && sourceGroups.every(group => currentCorrection(group));
  });
  const sourceCorrectionLabel = createMemo(() => reviewProblemGroups().filter(group => group.domain === "source")
    .some(group => currentCorrection(group)?.kind === "transcription_adjustment") ? "转录已调整，待确认" : "已修正，待确认");
  // ReviewMarkedText preserves raw, hash-bound ranges while validating the
  // display projection, so marked prose can use the same compact typography.
  const teachingFieldProject = (_fieldPath: string) => (value: string) => compactTeachingText(teachingDisplayText(value));
  function selectMarkedIssue(issueId: string) {
    setReviewDomain(currentTriage()?.issues.find(issue => issue.id === issueId)?.domain || "teaching");
    setFocusedIssue(issueId);
    requestAnimationFrame(() => {
      const row = Array.from(document.querySelectorAll<HTMLElement>("[data-review-member-ids]"))
        .find(element => element.dataset.reviewMemberIds?.split(" ").includes(issueId));
      row?.scrollIntoView({ block: "nearest" });
      document.querySelector<HTMLElement>(".import-review-problems")?.focus({ preventScroll: true });
    });
  }
  function viewCorrection(group: ReviewIssueGroup) {
    const note = currentCorrection(group);
    if (!note) return;
    locateIssue({ ...group.members[0], location: "field", target: {
      domain: "source", fieldPath: note.fieldPath, sourceContentSha256: note.sourceContentSha256,
    } });
  }
  function queueReason(row: ReturnType<typeof importTriage>["rows"][number]) {
    if (!row.needsAction || !row.issues[0]) return reviewStatusLabel(row);
    const first = groupReviewIssues([row.issues[0]])[0];
    const correction = sourceCorrectionForGroup(first, sourceCorrectionDisplays()[row.questionId] || [], dirty());
    if (correction) return correction.kind === "ocr_transcription" ? "原题 · 已修正，待确认" : "原题 · 转录已调整，待确认";
    if (first.domain === "teaching") {
      const state = importTeachingStatus(row.question, { triage: row });
      if (["generation_failed", "review_failed"].includes(state.kind)) return `${state.title} · ${state.reasons[0] || "查看具体原因"}`;
    }
    return `${first.domain === "source" ? "原题" : "解析"} · ${first.members.some(issue => issue.type === "term") ? first.title : first.message}`;
  }
  function TeachingStatusActions() {
    return <div class="import-teaching-state-actions">
      <Show when={teachingStatus().actionHint === "retry_generation" && teachingActions()[current()?.questionId]?.canRetryGeneration}>
        <button class="secondary" disabled={Boolean(busy()) || Boolean(activeJob()) || dirty() || teachingDirty() || publishFrozen()} onClick={() => askQuestionAction("retry")}><RotateCcw size={15} />重试本题解析</button>
      </Show>
      <Show when={teachingStatus().actionHint === "continue_workflow" && canContinueTeaching()}>
        <button class="secondary" title="继续本卷尚未执行的生成或复核；已经完成的题目不会重新处理。" disabled={Boolean(busy()) || Boolean(activeJob()) || dirty() || teachingDirty() || publishFrozen() || !configured()} onClick={() => { if (!prepareAttempt) prepareId = operationId(); void parse(true); }}><RotateCcw size={15} />继续本卷未完成处理</button>
      </Show>
    </div>;
  }
  const groupLocations = (group: ReviewIssueGroup) => group.locatableIssues.filter((issue, index, issues) =>
    issues.findIndex(other => other.target?.fieldPath === issue.target?.fieldPath) === index);
  function focusReviewProblems() {
    setReviewDomain("teaching");
    requestAnimationFrame(() => {
      const list = document.querySelector<HTMLElement>(".import-review-problems") || document.querySelector<HTMLElement>(".import-review-body");
      list?.scrollIntoView({ block: "nearest" });
      list?.focus({ preventScroll: true });
    });
  }
  function reviewDomainKey(event: KeyboardEvent) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? "source" : event.key === "End" ? "teaching" : reviewDomain() === "source" ? "teaching" : "source";
    setReviewDomain(next);
    (event.currentTarget as HTMLElement).parentElement?.querySelector<HTMLButtonElement>(`[data-domain="${next}"]`)?.focus({ preventScroll: true });
  }
  let sourceConfirmationIdentity = "";
  createEffect(() => {
    const q = current();
    const identity = JSON.stringify([record()?.importId, record()?.revision, q?.questionId, q?.stem, q?.options, q?.parts, q?.answer, q?.solution]);
    if (identity !== sourceConfirmationIdentity) {
      sourceConfirmationIdentity = identity;
      setSourceConfirmed(false);
      setSourceConfirmationNote("");
    }
  });
  const visibleTriage = createMemo(() => reviewRowsForFilter(triage().rows, triageFilter()));
  const readyCount = createMemo(() => triage().rows.filter(isReviewReady).length);
  const canShowOriginal = () => Boolean(record()?.ocrSource || record()?.renderedPdf || record()?.source?.extension === "pdf");
  const otherQuestionEdits = createMemo(() => dirty() && questions().some(item => item.questionId !== current()?.questionId
    && JSON.stringify(item) !== JSON.stringify((record()?.questions || []).find((old: any) => old.questionId === item.questionId))));
  function changeFilter(value: string) {
    guardNavigation(() => {
      setTriageFilter(value);
      if (!visibleTriage().some(row => row.questionId === current()?.questionId) && visibleTriage()[0]) selectQuestion(visibleTriage()[0].questionId);
    });
  }
  function moveQuestion(mode: "previous" | "next") {
    const next = nextReviewQuestion(triage().rows, current()?.questionId, mode);
    if (next) guardNavigation(() => { if (!visibleTriage().some(row => row.questionId === next)) setTriageFilter("all"); selectQuestion(next); });
  }
  function guardNavigation(action: () => void) {
    if (teachingDirty()) setLeaveAction(() => action);
    else action();
  }
  function selectQuestion(id: string) {
    guardNavigation(() => { document.querySelectorAll(".import-field-highlight").forEach(el => el.classList.remove("import-field-highlight")); setSelected(questions().findIndex(q => q.questionId === id)); setPreview(true); setDetailTab("solution"); setEditTeachingField(""); setEditTeachingRequest(0); setFocusedIssue(""); setLocationNotice(""); requestAnimationFrame(() => { const pane = document.querySelector<HTMLElement>(".import-reading-pane"); if (pane) pane.scrollTop = 0; const decision = document.querySelector<HTMLElement>(".import-review-body"); if (decision) decision.scrollTop = 0; }); });
  }
  function nextTodo() {
    const next = nextReviewQuestion(triage().rows, current()?.questionId);
    if (next) guardNavigation(() => { if (!visibleTriage().some(row=>row.questionId === next)) setTriageFilter("todo"); selectQuestion(next); });
    else setNotice("当前没有其他待办；本题未解决的问题仍然保留。");
  }
  function locateIssue(issue: TriageIssue) {
    setReviewDomain(issue.domain);
    if (reviewView() === "image") setReviewView("split");
    if (issue.domain === "teaching") setDetailTab(/^(difficultyAssessment|teachingFocus)\./.test(issue.target?.fieldPath || "") ? "assessment" : "solution");
    setFocusedIssue(issue.id);
    const target = issue.target;
    if (!target || issue.location === "unavailable") { setLocationNotice("此问题没有可验证的位置，请对照完整原题或解析核对。"); return; }
    const fields = Array.from(document.querySelectorAll<HTMLElement>("[data-import-field]"));
    const element = fields.find(el => el.dataset.importField === `${issue.domain}:${target.fieldPath}`);
    if (!element) { setLocationNotice("当前内容无法定位到原句段，请查看完整字段。"); return; }
    for (let parent = element.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
    document.querySelectorAll(".import-field-highlight").forEach(el => el.classList.remove("import-field-highlight"));
    element.classList.add("import-field-highlight");
    const mark = Array.from(element.querySelectorAll<HTMLElement>("[data-review-issue-ids]"))
      .find(item => item.dataset.reviewIssueIds?.split(" ").includes(issue.id));
    const anchor = mark || element;
    const pane = element.closest<HTMLElement>(".import-reading-pane");
    if (pane) pane.scrollTo({ top: pane.scrollTop + anchor.getBoundingClientRect().top - pane.getBoundingClientRect().top - 48, behavior: "instant" });
    anchor.focus({ preventScroll: true });
    // Rich text contains math nodes. Highlight the exact, version-bound field,
    // never a guessed DOM substring which could split an equation.
    setLocationNotice(mark ? "已定位到标注的待核对内容，请结合前后推导核对。" : "已定位相关字段；此疑点暂无准确句段位置，请结合上下文核对。");
  }
  function openTeachingEditor(fieldPath = "") {
    setReviewDomain("teaching");
    setPreview(true);
    setDetailTab("solution");
    setEditTeachingField(fieldPath);
    setEditTeachingRequest(value => value + 1);
    requestAnimationFrame(() => {
      const editor = document.querySelector<HTMLElement>(".import-teaching-controls");
      const pane = document.querySelector<HTMLElement>(".import-reading-pane");
      if (pane && editor) pane.scrollTop += editor.getBoundingClientRect().top - pane.getBoundingClientRect().top - 16;
      editor?.querySelector<HTMLElement>("textarea:not([readonly]),input:not([readonly])")?.focus({ preventScroll: true });
    });
  }
  function openSourceEditor(fieldPath = "stem") {
    guardNavigation(() => {
      setReviewDomain("source");
      setPreview(false);
      requestAnimationFrame(() => {
        const input = Array.from(document.querySelectorAll<HTMLElement>("[data-source-edit]"))
          .find(element => element.dataset.sourceEdit === fieldPath);
        if (!input) return;
        for (let parent = input.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
        input.scrollIntoView({ block: "nearest" });
        input.focus({ preventScroll: true });
      });
    });
  }
  function detailTabKey(event: KeyboardEvent, value: "solution" | "assessment") {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? "solution" : event.key === "End" ? "assessment" : value === "solution" ? "assessment" : "solution";
    setDetailTab(next);
    (event.currentTarget as HTMLElement).parentElement?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus({preventScroll:true});
  }
  async function confirmCurrentSource() {
    if (busy() || activeJob() || teachingDirty() || publishFrozen() || !current()) return;
    setError("");
    try {
      const payload = sourceConfirmationUpdate({ ...record(), questions: questions() }, current().questionId, {
        confirmed: sourceConfirmed(), hardIssues: activeIssues(), note: sourceConfirmationNote(), persistedQuestions:record().questions,
      });
      payload.expectedRevision = editBaseRevision() ?? record().revision;
      const selectedId = current().questionId;
      working("正在确认本题…");
      const result = await request("import_question_review_save", stable("save-source-confirmation", {
        importId: payload.importId, expectedRevision: payload.expectedRevision,
        questionId: selectedId, question: payload.questions.find((q: any) => q.questionId === selectedId), responseScope: "question",
      }));
      if (!alive) return;
      editBuffers.delete(record().importId);
      applyResponse(result);
      const index = questions().findIndex((q: any) => q.questionId === selectedId);
      if (index >= 0) setSelected(index);
      const nextRows = triage().rows;
      const nextId = nextReviewQuestion(nextRows, selectedId);
      if (nextId) {
        const nextIndex = questions().findIndex(q => q.questionId === nextId);
        if (nextIndex >= 0) { if (!visibleTriage().some(row=>row.questionId === nextId)) setTriageFilter("todo"); selectQuestion(nextId); }
        setNotice("原题已核对保存，已进入下一待处理题；尚未入库。");
      } else setNotice(nextRows.find(row => row.questionId === selectedId)?.needsAction
        ? "原题已核对保存；本题解析仍有待处理项，尚未采用。" : "原题已核对保存，暂无其他待处理题；可从页头批量入库。");
      void loadHistory();
    } catch (failure: any) { if (alive) setError(failure.message || "本题确认未保存，请重试。"); }
    finally { if (alive) working(""); }
  }
  async function quickConfirmCurrentSource() {
    if (busy() || activeJob() || teachingDirty() || publishFrozen() || !current() || activeIssues().length || otherQuestionEdits()) return;
    setSourceConfirmed(true);
    await confirmCurrentSource();
  }
  function insertSnippetIntoActive(snippet: string) {
    const textarea = lastFocusedTextarea || document.querySelector<HTMLTextAreaElement>("[data-source-edit='stem']");
    if (!textarea) return;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    const selectedText = textarea.value.slice(start, end);
    let replacement = snippet;
    let cursorOffset = snippet.length;

    if (snippet === "$$") {
      replacement = `$${selectedText}$`;
      cursorOffset = selectedText ? replacement.length : 1;
    } else if (snippet.includes("{a}") && selectedText) {
      replacement = snippet.replace("{a}", `{${selectedText}}`);
      cursorOffset = replacement.length;
    } else if (snippet.includes("{x}") && selectedText) {
      replacement = snippet.replace("{x}", `{${selectedText}}`);
      cursorOffset = replacement.length;
    }

    const newValue = textarea.value.slice(0, start) + replacement + textarea.value.slice(end);
    textarea.value = newValue;
    textarea.setSelectionRange(start + cursorOffset, start + cursorOffset);
    textarea.focus();
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const auditMetrics = createMemo(() => {
    const all = questions();
    const total = all.length;
    if (!total) return { total: 0, ready: 0, bothReady: 0, sourceReady: 0, todo: 0, published: 0, percent: 0 };
    const elig = reviewEligibility();
    const pub = all.filter(published).length;
    const both = all.filter(q => !published(q) && elig[q.questionId]?.publicationScope === "source_and_teaching").length;
    const sourceOnly = all.filter(q => !published(q) && elig[q.questionId]?.eligible === true && elig[q.questionId]?.publicationScope !== "source_and_teaching").length;
    const ready = both + sourceOnly;
    const todo = triage().counts.todo;
    const percent = Math.round(((pub + ready) / total) * 100);
    return { total, ready, bothReady: both, sourceReady: sourceOnly, todo, published: pub, percent };
  });
  const processingError = createMemo(() => selectedJob()?.status === "failed" && selectedJob()?.error
    ? selectedJob().error : record()?.error);
  const failureDiagnostic = createMemo<ImportDiagnostic | null>(() => {
    if (!record() || record().status !== "failed" && selectedJob()?.status !== "failed" || busy()) return null;
    return diagnostic() || {
      ...importFailure(processingError(), { record: record(), job: selectedJob() }),
      attempts: record().modelAttempts?.length || 0,
      ocrCompleted: Boolean(record().ocrSource),
    };
  });
  const failureView = createMemo(() => importFailure(processingError(), {
    record: record(), job: selectedJob(), diagnostic: failureDiagnostic(),
  }));
  const processStage = createMemo(() => importStage(record(), selectedJob(), failureDiagnostic()));
  const historyPageNumbers = createMemo(() => {
    const pages = new Set([1, historyPages()]);
    for (let page = historyPage() - 1; page <= historyPage() + 1; page++) {
      if (page >= 1 && page <= historyPages()) pages.add(page);
    }
    return [...pages].sort((a, b) => a - b);
  });
  function importDate(value: string) {
    if (!value) return "时间未知";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    });
  }
  function rememberEdits() {
    if (record() && dirty()) editBuffers.set(record().importId, {revision: editBaseRevision(), baseline:clone(record()), detailVersion:recordDetailVersion, controls:clone(teachingControls()), actions:clone(teachingActions()), displays:clone(sourceCorrectionDisplays()), questions:clone(questions()), selected:selected(), preview:preview()});
  }
  function backToHistory() {
    if (busy() || publishFrozen()) return;
    rememberEdits();
    const id = record()?.importId;
    ++openVersion;
    setRecord(null);
    setDirty(false);
    setDiagnostic(null);
    setQuestions([]);
    setTeachingControls({});
    setFile(null);
    setError("");
    setNotice("");
    setOriginalPreview(false);
    requestAnimationFrame(() => {
      const entry = Array.from(historyRegion?.querySelectorAll<HTMLButtonElement>("button[data-import-id]") || [])
        .find((button) => button.dataset.importId === id);
      (entry || historyRegion)?.focus();
    });
  }
  // The source-page panel is teacher-only evidence and may contain images from
  // several questions. Keep one unambiguous identity/payload per source image;
  // this context is never supplied to the student question preview.
  const originalAssets = createMemo(() => {
    const references = new Map<string, any>();
    const conflicts = new Set<string>();
    const payloads: any[] = [];
    for (const question of record()?.questions || []) {
      payloads.push(...(question.assetPayloads || []));
      for (const asset of assetReferences(question, true)) {
        if (!asset.assetId) continue;
        const prior = references.get(asset.assetId);
        if (prior && (prior.path !== asset.path || prior.sha256 !== asset.sha256 || prior.mimeType !== asset.mimeType)) {
          conflicts.add(asset.assetId);
        } else if (!prior) references.set(asset.assetId, asset);
      }
    }
    const source: any = { student: { assets: [] }, teacher: { assets: [] }, assetPayloads: [] };
    for (const asset of references.values()) {
      if (conflicts.has(asset.assetId)) continue;
      const matching = payloads.filter((payload) => assetKey(payload) === assetKey(asset));
      const distinct = new Map(matching.map((payload) => [JSON.stringify([payload.mimeType, payload.dataBase64]), payload]));
      // Conflicting bytes stay visibly unresolved instead of selecting a copy.
      if (distinct.size !== 1) continue;
      source[asset.role].assets.push(asset);
      source.assetPayloads.push(distinct.values().next().value);
    }
    return source;
  });
  const sections = createMemo<any[]>(() =>
    (catalog()?.textbooks || []).flatMap((book: any) =>
      (book.chapters || []).flatMap((chapter: any) =>
        (chapter.sections || []).map((section: any) => ({
          ...section,
          label: `${book.title} · ${section.title}`,
        })),
      ),
    ),
  );
  const knowledge = createMemo<any[]>(() => {
    const values: any[] = [];
    const visit = (items: any[]) =>
      items.forEach((item) => {
        values.push(item);
        visit(item.children || []);
      });
    visit(catalog()?.knowledgePoints || []);
    return values;
  });
  const hasKnowledgePlan = (question: any) =>
    question.primaryKnowledgeUids !== undefined ||
    question.solutionPaths !== undefined ||
    question.knowledgeSchemaVersion !== undefined;
  const knowledgeNames = (uids: string[] | undefined) =>
    (uids || []).map(uid => knowledge().find(item => item.uid === uid)?.name || "知识点名称未记录").join("、") || "未标注";
  const isKnowledgeGroup = (item: any) => item.isLeaf === false || Boolean(item.children?.length);
  const premiseNames = (premises: string[]) =>
    premises.map((id) => {
      const premise = (props.config.premises || []).find(
        (item: any) => item.id === id,
      );
      return premise?.label || "未识别的额外条件";
    }).join("、");
  const pendingApprove = () => questions().filter(item => reviewEligibility()[item.questionId]?.eligible === true && !published(item));
  const needsOpinion = (item: any) => !published(item) && reviewEligibility()[item.questionId]?.eligible !== true;
  const reviewStateLabel = (item: any) => published(item) ? "已入库" : reviewEligibility()[item.questionId]?.eligible ? "可入库" : (item.teachingWorkflow && item.teachingWorkflow.status !== "ready_candidate") || item.modelReview?.status === "needs_review" || item.modelReview?.status === "blocked" ? "需处理" : item.modelReview?.status === "stale" ? "需重新检查" : item.modelReview?.status === "failed" ? "检查未完成" : item.reviewDecision === "approve" ? "已人工核对" : "待检查";
  const canRecheck = () => !activeJob() && questions().some(item => !published(item) && (dirty() || !item.modelReview || ["stale", "failed"].includes(item.modelReview.status)));
  const canContinueTeaching = () => record()?.status === "pending_review" && !record()?.publishedQuestionIds?.length && questions().some(hasUnstartedTeaching);
  const confidenceLabel = (value: string) => ({high:"高",medium:"中",low:"低"}[value] || "未给出");
  const published = (question: any) =>
    question?.status === "published" ||
    (record()?.publishedQuestionIds || []).includes(question?.questionId);
  const reviewComplete = (question: any) =>
    requiredReviewChecks(question).every(
      (key) => question.reviewChecks?.[key] === true,
    ) && Boolean(question.reviewBasis?.trim());
  const activeIssues = () => [...new Set(
    [...(record()?.sourceIssues || []).filter((issue: any) =>
      issue?.blocking !== false && (!Number(issue?.page) || (current()?.pages || []).includes(Number(issue.page)))),
      ...(current()?.reviewIssues || []).filter((issue: any) => issue?.blocking !== false),
      ...(reviewEligibility()[current()?.questionId]?.sourceMaterialFindings || [])]
      .map(message).filter(Boolean),
  )];
  onCleanup(() => {
    importRefresh.dispose();
    importUnlisten?.();
    ++questionReadVersion;
    ++jobPollVersion;
    alive = false;
    ++configVersion;
    ++openVersion;
    ++historyVersion;
  });
  onMount(() => {
    const warnUnsaved = (event: BeforeUnloadEvent) => {
      if (dirty() || teachingDirty()) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warnUnsaved);
    onCleanup(() => window.removeEventListener("beforeunload", warnUnsaved));
    const closeTools = (event: PointerEvent) => { if (!recordToolsElement?.contains(event.target as Node)) setRecordToolsOpen(false); };
    const escapeTools = (event: KeyboardEvent) => { if (event.key === "Escape" && recordToolsOpen()) { setRecordToolsOpen(false); recordToolsButton?.focus({ preventScroll: true }); } };
    document.addEventListener("pointerdown", closeTools);
    document.addEventListener("keydown", escapeTools);
    onCleanup(() => { document.removeEventListener("pointerdown", closeTools); document.removeEventListener("keydown", escapeTools); });
    const handleShortcuts = (event: KeyboardEvent) => {
      if (props.visible === false) return;
      const target = event.target as HTMLElement | null;
      const isInput = target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        if (!preview()) guardNavigation(() => setPreview(true));
        else if (reviewDomain() === "source" && !published(current()) && !activeIssues().length && !otherQuestionEdits() && !busy() && !activeJob()) void quickConfirmCurrentSource();
        else nextTodo();
        return;
      }
      if (isInput) return;
      if (event.altKey && (event.key === "e" || event.key === "E")) {
        event.preventDefault();
        if (preview()) openSourceEditor();
        else guardNavigation(() => setPreview(true));
        return;
      }
      if (event.key === "[" || (event.altKey && event.key === "ArrowLeft")) {
        event.preventDefault();
        moveQuestion("previous");
        return;
      }
      if (event.key === "]" || (event.altKey && event.key === "ArrowRight")) {
        event.preventDefault();
        moveQuestion("next");
        return;
      }
    };
    document.addEventListener("keydown", handleShortcuts);
    onCleanup(() => document.removeEventListener("keydown", handleShortcuts));
  });
  createEffect(() => {
    props.modelRevision;
    void checkConfiguration(false);
  });
  createEffect(() =>
    props.onBusy(Boolean(busy()) || publishFrozen()),
  );
  async function checkConfiguration(requireOcr: boolean, resumeTeaching = false) {
    const own = ++configVersion;
    setChecking(true);
    try {
      const [modelResult, ocrResult] = await Promise.allSettled([request("model_get"), request("ocr_get")]);
      const model = modelResult.status === "fulfilled" ? modelResult.value : null;
      const ocr = ocrResult.status === "fulfilled" ? ocrResult.value : null;
      if (alive && own === configVersion) {
        const ready = importModelReadiness(model);
        setImportConfigured(ready.configured);
        setSourceConfigured(ready.sourceConfigured);
        setTeachingConfigured(ready.teachingConfigured);
        setActiveConfigured(ready.activeConfigured);
        setModelWarning(model?.warning || "");
        setOcrConfigured(ocr?.configured === true);
        setOcrWarning(ocr?.warning || "");
        setConfigurationTarget(!importModelReady(model, resumeTeaching) ? "models" : requireOcr && ocr?.configured !== true ? "ocr" : null);
        if (modelResult.status === "rejected") setError(modelResult.reason?.message || "模型设置读取失败，请重试。");
        else if (requireOcr && ocrResult.status === "rejected") setError(ocrResult.reason?.message || "试卷识别设置读取失败，请重试。");
      }
      return importModelReady(model, resumeTeaching) && (!requireOcr || ocr?.configured === true);
    } catch (failure: any) {
      if (alive && own === configVersion) {
        setImportConfigured(false);
        setSourceConfigured(false);
        setTeachingConfigured(false);
        setActiveConfigured(false);
        setError(failure.message);
      }
      return false;
    } finally {
      if (alive && own === configVersion) setChecking(false);
    }
  }
  async function loadHistory(page = historyPage()) {
    requestedHistoryPage = page;
    const own = ++historyVersion;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const result = await request("imports_list", { page, pageSize: HISTORY_PAGE_SIZE });
      if (alive && own === historyVersion) {
        setHistory(result.imports || []);
        setHistoryTotal(result.total);
        setHistoryPage(result.page);
        setHistoryPages(result.totalPages);
      }
    } catch (failure: any) {
      if (alive && own === historyVersion) setHistoryError(failure.message || "导入记录读取失败，请重试。");
    } finally {
      if (alive && own === historyVersion) setHistoryLoading(false);
    }
  }
  onMount(() => {
    void connectImportEvents();
    const resume = () => {
      if (document.visibilityState !== "hidden") void connectImportEvents().then(() => importRefresh.schedule());
    };
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    onCleanup(() => {
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    });
    loadHistory();
    request("bank_catalog")
      .then((result) => {
        if (alive) setCatalog(result);
      })
      .catch((failure: any) => {
        if (alive) setError(failure.message);
      });
  });
  const importRefresh = createImportRefreshQueue(readJobs);
  function refreshJobs() { importRefresh.schedule(); }
  async function connectImportEvents() {
    if (importUnlisten) return;
    if (connectingImportEvents) return connectingImportEvents;
    connectingImportEvents = (async () => {
      try {
        const stop = await listenImportProgress(() => importRefresh.schedule());
        if (!alive) { stop(); return; }
        importUnlisten = stop;
        setImportEventsReady(true);
        setImportEventError("");
      } catch (failure: any) {
        if (alive) setImportEventError(failure.message || "进度通知暂未连接，可手动读取；返回窗口时将重新连接。");
      } finally {
        if (alive) importRefresh.schedule(); // Subscribe before the persisted snapshot.
      }
    })();
    try { await connectingImportEvents; } finally { connectingImportEvents = undefined; }
  }
  createEffect(() => {
    if (props.visible !== false && pendingDetailRefresh() && !dirty() && !teachingDirty() && !busy() && !publishFrozen()) {
      setPendingDetailRefresh(false);
      importRefresh.schedule();
    }
  });
  createEffect(() => { if (props.visible !== false && importEventsReady()) importRefresh.schedule(); });
  async function readJobs() {
    const own = ++jobPollVersion;
    try {
      const result = await request("import_jobs_list");
      if (!alive || own !== jobPollVersion) return;
      const next = result.jobs || [];
      setJobs(next);
      props.onJobsChange?.(next);
      setJobError("");
      for (const job of next) {
        const previous = jobStates.get(job.jobId);
        if (["queued", "running"].includes(previous || "") && !["queued", "running"].includes(job.status)) {
          props.onNotice?.(`${job.filename}：${job.status === "completed" ? (job.mode === "annotation" ? "考查信息已处理，可前往导入记录查看" : job.mode === "review" ? "重新检查完成，可查看意见" : "导入处理完成，可查看题目与检查意见") : job.message || "导入未完成，原件已保留"}`);
          if (record()?.importId === job.importId)
            setNotice(job.status === "completed" ? (job.mode === "annotation" ? "考查信息处理完成，缺少可靠依据的维度仍保留未知。" : "处理完成，请查看检查意见；有疑点的题目再处理，其余可统一确认入库。") : "");
        }
        jobStates.set(job.jobId, job.status);
      }
      const signature = JSON.stringify(next.map((job: any) => [job.jobId, job.status, job.stage]));
      const changed = signature !== jobSignature;
      if (changed) {
        jobSignature = signature;
        void loadHistory();
      }
      const id = record()?.importId;
      if (id && props.visible !== false && !dirty() && !teachingDirty() && !busy() && !publishFrozen()) {
        const baseline = record(), knownDetailVersion = recordDetailVersion;
        const detail = await request("import_summary_get", { importId: id, ...(knownDetailVersion ? { knownDetailVersion } : {}) });
        if (alive && own === jobPollVersion && record() === baseline && !dirty() && !teachingDirty() && !busy() && !publishFrozen() &&
          !detail.notModified && detail.summary) applyResponse(detail);
        else if (alive && !detail.notModified && (dirty() || teachingDirty() || busy() || publishFrozen())) setPendingDetailRefresh(true);
      } else if (id) setPendingDetailRefresh(true);
    } catch (failure: any) {
      if (alive && own === jobPollVersion) setJobError(failure.message || "导入进度暂未读取，原任务仍在后台处理。");
    }
  }
  function working(text: string) {
    setBusy(text);
  }
  function applyResponse(result: any, preserveEdits = false, reuseDetails = true) {
    const previous = record(), selectedId = selectedQuestionId();
    const merged = mergeImportView(previous, questions(), reuseDetails ? recordDetailVersion : undefined, result, preserveEdits);
    const controls = { ...(result.teachingControls || {}) };
    const actions = { ...(result.teachingActions || {}) };
    const displays = { ...(result.sourceCorrectionDisplays || {}) };
    for (const id of merged.reusedIds) {
      if (teachingControls()[id]) controls[id] = teachingControls()[id];
      if (teachingActions()[id]) actions[id] = { ...teachingActions()[id], ...actions[id] };
      if (sourceCorrectionDisplays()[id]) displays[id] = sourceCorrectionDisplays()[id];
    }
    batch(() => {
      if (preserveEdits) {
        setRecord(merged.record);
        setQuestions(merged.questions);
        setTeachingControls(controls); setTeachingActions(actions); setSourceCorrectionDisplays(displays);
        // Keep the original write revision and every unsaved source edit.
      } else {
        apply(merged.record, result.diagnostic, result.reviewEligibility, controls, actions, displays, result.detailVersion);
      }
      if (previous?.importId === merged.record.importId && selectedId) {
        const index = merged.record.questions.findIndex((q: any) => q.questionId === selectedId);
        if (index >= 0) setSelected(index);
      }
    });
  }
  createEffect(() => {
    const selectedEntry = questions()[selected()];
    record(); questionRetry();
    if (props.visible !== false && selectedEntry && !hasImportQuestionDetail(selectedEntry) && !busy() && !teachingDirty()) {
      void untrack(() => loadQuestionDetail(selectedEntry.questionId));
    }
  });
  async function loadQuestionDetail(questionId: string) {
    const baseline = record(), opening = openVersion, own = ++questionReadVersion;
    if (!baseline) return;
    setQuestionLoading(true); setQuestionError("");
    try {
      const result = await request("import_question_get", { importId: baseline.importId, questionId,
        ...(dirty() && recordDetailVersion ? { expectedDetailVersion: recordDetailVersion } : {}) });
      if (!alive || own !== questionReadVersion || opening !== openVersion || record() !== baseline
        || selectedQuestionId() !== questionId || busy() || teachingDirty()) return;
      applyResponse(result, dirty());
    } catch (failure: any) {
      if (alive && own === questionReadVersion && opening === openVersion) setQuestionError(failure.message || "本题详情未读取，已保存进度和未保存编辑均保留。");
    } finally { if (alive && own === questionReadVersion) setQuestionLoading(false); }
  }
  function apply(value: any, detail?: ImportDiagnostic, eligibility?: Record<string, any>, controls?: Record<string, TeachingReviewControls>, actions?: Record<string, any>, sourceDisplays?: Record<string, SourceCorrectionDisplay[]>, detailVersion?: string) {
    const opening = record()?.importId !== value.importId;
    if (opening) {
      const first = importTriage(value, eligibility, controls, [], actions).rows.findIndex(row => row.needsAction);
      setTriageFilter(first >= 0 ? "todo" : "all"); setFocusedIssue(""); setLocationNotice("");
      setOriginalPreview(false);
      setSourceCompare(false);
      setSelected(Math.max(first, 0));
    }
    setRecord(value);
    recordDetailVersion = detailVersion;
    setEditBaseRevision(value.revision);
    setReviewEligibility(eligibility || {});
    setTeachingControls(controls || {});
    setTeachingActions(actions || {});
    setSourceCorrectionDisplays(sourceDisplays || {});
    setDiagnostic(value.status === "failed" && detail ? detail : null);
    setError("");
    setQuestions(clone(value.questions || []));
    setSelected((index) =>
      Math.min(index, Math.max(0, (value.questions || []).length - 1)),
    );
    setDirty(false);
    setPreview(true);
    if (value.pendingPublication?.operationId) {
      publishAttempt = value.pendingPublication.payload ? clone(value.pendingPublication.payload) : null;
      setPublishFrozen(true);
      setConfirmPublish(true);
      setPublishError(publishAttempt ? "上次入库尚待确认，请重试同一次操作以核查结果。" : "上次入库的原请求信息不完整，已保留原题与发布断点；无法安全重建同一次请求，请查看处理记录。");
    }
  }
  async function open(importId: string) {
    if (busy()) return;
    if (publishFrozen()) {
      setError("请先完成待确认的入库操作。");
      return;
    }
    rememberEdits();
    const own = ++openVersion;
    setError("");
    working("读取导入记录…");
    try {
      const result = await request("import_summary_get", { importId });
      if (alive && own === openVersion) {
        // Explicit reopen also refreshes derived bank bindings, even if the
        // import JSON itself has not changed in another window.
        applyResponse(result, false, false);
        setFile(null);
        setNotice("");
        const buffer = editBuffers.get(importId);
        if (buffer) {
          batch(() => {
            if (buffer.baseline) setRecord(clone(buffer.baseline));
            recordDetailVersion = buffer.detailVersion;
            setQuestions(clone(buffer.questions));
            setSelected(buffer.selected);
            setPreview(buffer.preview);
            setEditBaseRevision(buffer.revision);
            if (buffer.controls) setTeachingControls(clone(buffer.controls));
            if (buffer.actions) setTeachingActions(clone(buffer.actions));
            if (buffer.displays) setSourceCorrectionDisplays(clone(buffer.displays));
            setReviewEligibility({});
            setDirty(true);
            if (buffer.detailVersion !== result.detailVersion) setPendingDetailRefresh(true);
          });
          setNotice(buffer.revision === result.summary.revision ? "已恢复本窗口未保存的编辑，可以继续处理或返回组卷。" : "已恢复本窗口编辑，但保存版本已更新；请先核对差异，保存不会覆盖较新版本。");
        }
        requestAnimationFrame(() => detailHeading?.focus());
      }
    } catch (failure: any) {
      if (alive) setError(failure.message);
    } finally {
      if (alive && own === openVersion) working("");
    }
  }
  async function pick(kind: "document" | "text") {
    if (busy() || checking()) return;
    if (dirty() || publishFrozen()) {
      setError("请先保存当前审核，或完成待确认的入库操作。");
      return;
    }
    setError("");
    if (!(await checkConfiguration(kind === "document"))) return;
    setFileKind(kind);
    fileInput.accept = kind === "document" ? ".pdf,.docx" : ".txt,.md";
    fileInput.click();
  }
  function choose(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const chosen = input.files?.[0];
    input.value = "";
    if (dirty() || publishFrozen()) {
      setError("请先保存当前审核，或完成待确认的入库操作。");
      return;
    }
    if (!configured() || !chosen) return;
    if (/\.(pdf|docx)$/i.test(chosen.name) && !ocrConfigured()) {
      setConfigurationTarget("ocr");
      return;
    }
    if (!/\.(txt|md|pdf|docx)$/i.test(chosen.name)) {
      setError("请选择 TXT、Markdown、PDF 或 DOCX 文件。");
      return;
    }
    if (chosen.size > 15 * 1024 * 1024 || !chosen.size) {
      setError("文件须为 1 字节至 15 MB。");
      return;
    }
    setFile(chosen);
    setSelected(0);
    setPreview(true);
    setRecord(null);
    setDiagnostic(null);
    setQuestions([]);
    setDirty(false);
    setError("");
    setNotice("");
    prepareId = operationId();
    prepareAttempt = null;
    void parse();
  }
  async function parse(retry = false) {
    if (dirty() || publishFrozen()) {
      setError("请先保存当前审核，或完成待确认的入库操作。");
      return;
    }
    const extension = retry ? record()?.source?.extension || record()?.filename?.split(".").pop() : file()?.name.split(".").pop();
    const resumeTeaching = retry && Boolean(record()?.questions?.length);
    const needsOcr = /^(pdf|docx)$/i.test(extension || "") && !(retry && record()?.ocrSource);
    if (busy() || !(await checkConfiguration(needsOcr, resumeTeaching))) return;
    setError("");
    setCancelled(false);
    working("正在保存上传文件…");
    try {
      if (!prepareAttempt) {
        if (retry && record())
          prepareAttempt = {
            importId: record().importId,
            expectedRevision: record().revision,
            operationId: prepareId,
          };
        else {
          const selectedFile = file();
          if (!selectedFile) throw new Error("请先选择试卷文件。");
          const bytes = new Uint8Array(await selectedFile.arrayBuffer());
          let binary = "";
          for (let start = 0; start < bytes.length; start += 32768)
            binary += String.fromCharCode(
              ...bytes.subarray(start, start + 32768),
            );
          prepareAttempt = {
            filename: selectedFile.name,
            contentBase64: btoa(binary),
            operationId: prepareId,
          };
        }
      }
      const result = await request("import_start", { ...prepareAttempt, responseScope: "summary" });
      if (!alive) return;
      applyResponse(result);
      setFile(null);
      setNotice(["queued", "running"].includes(result.job?.status) ? "已加入后台解析，可继续组卷或浏览题库。完成后会通知你。" : "此试卷已处理，请查看题目与需要核对的事项。");
      if (result.job) {
        jobStates.set(result.job.jobId, result.job.status);
        setJobs(items => [result.job, ...items.filter(job => job.importId !== result.job.importId)]);
        props.onJobsChange?.(jobs());
        void refreshJobs();
      }
      prepareAttempt = null;
      prepareId = operationId();
      if (result.summary.error) {
        if (result.summary.error.code === "ocr_not_configured") setConfigurationTarget("ocr");
        else if (["not_configured", "model_not_configured", "import_model_not_configured", "import_role_not_configured"].includes(result.summary.error.code)) setConfigurationTarget("models");
      }
      await loadHistory(retry ? historyPage() : 1);
    } catch (failure: any) {
      if (alive) {
        setError(failure.message);
        if (failure.code === "ocr_not_configured") setConfigurationTarget("ocr");
        else if (["not_configured", "model_not_configured", "import_model_not_configured", "import_role_not_configured"].includes(failure.code)) setConfigurationTarget("models");
      }
    } finally {
      if (alive) working("");
    }
  }
  async function stop() {
    if (!activeJob()) return;
    setCancelled(true);
    try {
      await request("import_job_cancel", { importId: record().importId, jobId: activeJob().jobId, responseScope: "summary" });
      void refreshJobs();
    } catch (failure: any) {
      setError(failure.message);
      setCancelled(false);
    }
  }
  function update(fields: any) {
    if (!current() || published(current()) || busy() || activeJob() || publishFrozen()) return;
    setQuestions((items) =>
      items.map((item, index) =>
        index === selected()
          ? {
              ...item,
              ...fields,
              reviewDecision: fields.reviewDecision || "pending",
            }
          : item,
      ),
    );
    setReviewEligibility(values => ({...values,[current().questionId]:{eligible:false,reason:"有未保存修改"}}));
    setDirty(true);
    setNotice("");
  }
  function stable(action: string, payload: any) {
    const key = JSON.stringify({ action, ...payload });
    if (!operationIds.has(key)) operationIds.set(key, operationId());
    return { ...payload, operationId: operationIds.get(key) };
  }
  async function save() {
    if (busy() || !record() || teachingDirty()) return false;
    setError("");
    working("保存修改…");
    try {
      const changed = questions().filter(q => JSON.stringify(q) !== JSON.stringify(record().questions.find((old: any) => old.questionId === q.questionId)));
      if (!changed.length) { setDirty(false); return true; }
      const questionId = selectedQuestionId();
      let result: any;
      if (changed.length === 1) {
        result = await request("import_question_review_save", stable("save-question", {
          importId: record().importId, expectedRevision: editBaseRevision() ?? record().revision,
          questionId: changed[0].questionId, question: clone(changed[0]), responseScope: "question",
        }));
      } else {
        // Several source edits keep their existing all-or-nothing save. Fetch
        // unread baselines from this exact snapshot before constructing it.
        const complete = [];
        for (const q of questions()) {
          if (hasImportQuestionDetail(q)) { complete.push(clone(q)); continue; }
          const detail = await request("import_question_get", { importId: record().importId,
            questionId: q.questionId, expectedDetailVersion: recordDetailVersion });
          complete.push(detail.question);
        }
        result = await request("import_review_save", stable("save", {
          importId: record().importId, expectedRevision: editBaseRevision() ?? record().revision,
          questions: complete, questionId, responseScope: "question",
        }));
      }
      if (alive) {
        editBuffers.delete(record().importId);
        const index = selected();
        applyResponse(result);
        setSelected(index);
        setNotice("修改已保存，尚未入库。");
        await loadHistory();
      }
      return true;
    } catch (failure: any) {
      if (alive) setError(failure.message);
      return false;
    } finally {
      if (alive) working("");
    }
  }
  async function publish() {
    if (busy() || teachingDirty()) return;
    if (publishFrozen() && !publishAttempt) { setPublishError("缺少上次入库的完整原请求，当前断点已保留，请重新读取记录核对。"); return; }
    setPublishError("");
    if (!publishAttempt) {
      publishAttempt = {
        importId: record().importId,
        expectedRevision: record().revision,
        operationId: operationId(),
        acknowledgeReview: true,
        responseScope: "summary",
      };
      setPublishFrozen(true);
    }
    working("正在加入本地题库…");
    try {
      const count = pendingApprove().length;
      const result = await request("import_publish", publishAttempt);
      if (!alive) return;
      applyResponse(result);
      setConfirmPublish(false);
      setPublishFrozen(false);
      publishAttempt = null;
      setNotice(
        `已入库 ${result.publication?.accepted ?? result.publication?.publishedCount ?? count} 题。`,
      );
      await loadHistory();
      try {
        await props.onPublished();
        const latestCatalog = await request("bank_catalog");
        if (alive) setCatalog(latestCatalog);
      } catch (failure: any) {
        if (alive)
          setError(
            `题目已入库，目录刷新未完成：${failure.message}。可返回题库重新读取。`,
          );
      }
    } catch (failure: any) {
      if (alive) setPublishError(failure.message);
    } finally {
      if (alive) working("");
    }
  }
  async function annotateStructured() {
    if (busy() || dirty() || teachingDirty() || publishFrozen() || activeJob() || !record()) return;
    setError("");
    working("正在提交考查信息任务…");
    try {
      const result = await request("import_annotation_start", stable("annotation-start", {
        importId: record().importId,
        expectedRevision: record().revision,
          responseScope: "summary",
      }));
      if (!alive) return;
      applyResponse(result);
      if (result.job) {
        jobStates.set(result.job.jobId, result.job.status);
        setJobs(items => [result.job, ...items.filter(job => job.importId !== result.job.importId)]);
        props.onJobsChange?.(jobs());
        void refreshJobs();
      }
      setNotice(["queued", "running"].includes(result.job?.status) ? "正在后台补充考查信息，题面、答案、解析和已有审核不变；可继续其它操作。" : "当前考查信息已处理，已有结果保留。");
      await loadHistory();
    } catch (failure: any) { if (alive) setError(failure.message); }
    finally { if (alive) working(""); }
  }
  async function recheckQuestions() {
    if (busy() || teachingDirty() || activeJob() || publishFrozen() || !record()) return;
    if (dirty() && !(await save())) return;
    setError("");
    working("正在提交重新检查…");
    try {
      const result = await request("import_review_start", stable("model-review", {importId:record().importId,expectedRevision:record().revision,responseScope:"summary"}));
      if (!alive) return;
      applyResponse(result);
      if (result.job && ["queued","running"].includes(result.job.status)) {
        jobStates.set(result.job.jobId,result.job.status);
        setJobs(items => [result.job,...items.filter(job => job.importId !== result.job.importId)]);
        props.onJobsChange?.(jobs());
        void refreshJobs();
      }
      setNotice(["queued", "running"].includes(result.job?.status) ? "正在后台重新检查，可返回组卷；完成后直接查看检查意见。" : "当前检查意见仍然有效，无需重复检查。");
    } catch (failure:any) { if (alive) setError(failure.message); }
    finally { if (alive) working(""); }
  }
  async function saveTeachingControl(action: "import_teaching_acknowledge" | "import_teaching_patch", payload: any, savedNotice: string) {
    if (busy() || activeJob() || publishFrozen() || dirty() || !record()) throw new Error("请先保存当前编辑并等待本题处理完成，再核对教学稿。");
    setError("");
    working(action === "import_teaching_acknowledge" ? "正在保存本条核对…" : "正在保存局部修订…");
    try {
      const result = await request(action, stable(action, { ...payload, responseScope: "question" }));
      if (!alive) return;
      applyResponse(result);
      setNotice(savedNotice);
      await loadHistory();
    } finally { if (alive) working(""); }
  }
  async function acknowledgeTeachingIssue(issue: TeachingIssueRow, kind: string, basis: string, checks: Record<string, boolean>) {
    const question = current(), controls = teachingControls()[question?.questionId];
    if (!controls) throw new Error("当前教学稿核对信息未取得，请重新打开记录。");
    const payload = teachingAcknowledgementPayload(record(), question, controls, issue, kind, basis, checks);
    await saveTeachingControl("import_teaching_acknowledge", payload, "本条意见已保留为已核对提醒；其它待处理问题保持原状。");
  }
  async function patchTeachingField(fieldPath: string, oldText: string, newText: string, basis: string) {
    const question = current(), controls = teachingControls()[question?.questionId];
    if (!controls) throw new Error("当前教学稿版本信息未取得，请重新打开记录。");
    const payload = teachingPatchPayload(record(), question, controls, fieldPath, oldText, newText, basis);
    await saveTeachingControl("import_teaching_patch", payload, "局部修订已保存并重新检查；原题、原卷参考和其它教学字段保持不变。");
  }
  function askQuestionAction(kind: "retry" | "publish") {
    if (dirty() || teachingDirty() || activeJob() || busy() || publishFrozen()) { setError("请先保存或撤销当前编辑，并等待后台任务完成。"); return; }
    const id = current()?.questionId;
    const action = teachingActions()[id];
    if (!action || !(kind === "retry" ? action.canRetryGeneration : action.canPublishTeaching || action.canResumeTeachingPublication)) return;
    setQuestionAction({ kind, questionId: id, revision: record().revision, binding: clone(action) });
  }
  async function runQuestionAction() {
    const action = questionAction();
    if (!action || busy()) return;
    if (record()?.revision !== action.revision || current()?.questionId !== action.questionId) { setError("题目版本已变化，请重新打开本题操作。"); setQuestionAction(null); return; }
    setError("");
    working(action.kind === "retry" ? "正在提交本题重试…" : "正在更新题库解析…");
    try {
      const binding = action.binding;
      const payload = action.kind === "retry"
        ? { importId: record().importId, expectedRevision: action.revision, questionId: action.questionId, acknowledgeModelCall: true }
        : { importId: record().importId, expectedRevision: action.revision, questionId: action.questionId,
          sourceContentSha256: binding.sourceContentSha256, candidateSha256: binding.candidateSha256,
          contentVersion: binding.contentVersion, teacherVersion: binding.teacherVersion,
          expectedQuestionSha256: binding.expectedQuestionSha256, expectedAnnotationSha256: binding.expectedAnnotationSha256,
          acknowledgeTeachingUpdate: true };
      const name = action.kind === "retry" ? "import_teaching_retry_start" : "import_teaching_publish";
      const result = await request(name, action.kind === "publish" && binding.pendingTeachingPublicationPayload
        ? binding.pendingTeachingPublicationPayload : stable(name, { ...payload, responseScope: "question" }));
      if (!alive) return;
      applyResponse(result);
      if (result.job) {
        jobStates.set(result.job.jobId, result.job.status);
        setJobs(items => [result.job, ...items.filter(job => job.importId !== result.job.importId)]);
        props.onJobsChange?.(jobs());
        void refreshJobs();
      }
      setQuestionAction(null);
      setNotice(action.kind === "retry" ? "已提交本题解析生成。原题与其他题保留，本次不追加模型复核；可继续阅读其他题。" : "题库解析已更新。原题、原卷参考和已冻结的试卷保持原版本。");
      await loadHistory();
      if (action.kind === "publish") await props.onPublished();
    } catch (failure: any) { if (alive) setError(failure.message); }
    finally { if (alive) working(""); }
  }
  function previewQuestion(question: any) {
    return {
      ...current(),
      source: {
        kind: "material",
        label: record()?.filename || "导入试卷",
        number: question.sourceLabel || "",
      },
      student: {
        ...(question.student || {}),
        stem: importPreviewStem(question.stem, question.sourceLabel),
        options: question.options || [],
        parts: question.parts || [],
      },
      teacher: {
        ...(question.teacher || {}),
        answers: [
          { text: question.answer || "", importField:"answer" },
          ...(question.parts || []).map((part: any, index: number) => ({
            text: part.answer ? `（${index + 1}）${part.answer}` : "", importField:`parts[${index}].answer`,
          })),
        ].filter((entry) => entry.text),
        solutions: [
          { text: question.solution || "", importField:"solution" },
          ...(question.parts || []).map((part: any, index: number) => ({
            text: part.solution ? `（${index + 1}）${part.solution}` : "", importField:`parts[${index}].solution`,
          })),
        ].filter((entry) => entry.text),
      },
    };
  }
  return (
    <>
      <Show when={!record()}><header class="page-heading">
        <div>
          <h1>导入试卷</h1>
          <Show when={!record()}><p class="muted">上传原卷，识别并整理题目，核对后加入本地题库。</p></Show>
        </div>
        <div class="guide-heading-actions">
        <Show when={props.onAssembly}><button class="text-button" disabled={Boolean(busy()) || publishFrozen()} onClick={() => guardNavigation(() => props.onAssembly?.())}><ArrowLeft size={16} />返回组卷</button></Show>
        <Show when={props.onGuide}><button class="text-button guide-entry" onClick={() => props.onGuide?.()}><CircleHelp size={16} />导入说明</button></Show>
        <button
          class="text-button"
          disabled={Boolean(busy()) || publishFrozen()}
          onClick={() =>
            guardNavigation(() => { void props.onBank().catch((failure: any) => setError(failure.message)); })
          }
        >
          <ArrowLeft size={16} />
          题库
        </button>
        </div>
      </header></Show>
      <ErrorBanner message={error()} />
      <Show when={modelWarning()}>
        <p class="warning-text" role="alert">
          {modelWarning()}
        </p>
      </Show>
      <Show when={ocrWarning()}><p class="warning-text" role="alert">{ocrWarning()}</p></Show>
      <Show when={checking()}>
        <Busy label="读取导入设置…" />
      </Show>
      <Show when={!record() && !checking() && (!configured() || configurationTarget() === "models")}>
        <section class="import-gate">
          <FileText size={26} />
          <div>
            <h2>先配置模型</h2>
            <p class="muted">请先配置拆题和解析生成用途的模型。解析复核仅在问题命中时按需使用。</p>
          </div>
          <button class="primary" onClick={() => props.onConfigure("models")}>
            配置模型
          </button>
        </section>
      </Show>
      <Show when={!record() && !checking() && configured() && (!ocrConfigured() || configurationTarget() === "ocr")}>
        <section class="import-gate">
          <FileText size={26} />
          <div><h2>先配置试卷识别</h2><p class="muted">PDF、Word 需配置 PaddleOCR，识别文字、公式和图表。纯文本可直接导入。</p></div>
          <button class="primary" onClick={() => props.onConfigure("ocr")}>配置识别服务</button>
        </section>
      </Show>
      <Show when={configured() && !record()}>
        <section class="import-upload">
          <input
            ref={fileInput}
            type="file"
            accept={fileKind() === "document" ? ".pdf,.docx" : ".txt,.md"}
            aria-label="选择试卷文件"
            hidden
            disabled={!configured() || Boolean(busy())}
            onChange={choose}
          />
          <button
            class="secondary"
            disabled={
              Boolean(busy()) || checking() || dirty() || publishFrozen()
            }
            onClick={() => pick("document")}
          >
            <Upload size={16} />
            选择试卷
          </button>
          <button class="text-button" disabled={Boolean(busy()) || checking() || dirty() || publishFrozen()} onClick={() => pick("text")}><FileText size={16} />导入文本</button>
          <span class="muted">
            {file()?.name || "PDF / DOCX · 最大 15 MB"}
          </span>
          <Show when={file()}>
            <button
              class="primary"
              disabled={Boolean(busy())}
              onClick={() => parse()}
            >
              开始解析
            </button>
          </Show>
        </section>
      </Show>
      <Show when={busy() && !questions().length}>
        <Busy
          label={cancelled() ? "正在停止，请稍候…" : busy()}
          cancel={
            busy().startsWith("正在解析") && !cancelled() ? stop : undefined
          }
        />
      </Show>
      <Show when={notice() && !questions().length}>
        <p class="import-notice" role="status">
          <Check size={16} />
          {notice()}
        </p>
      </Show>
      <Show when={jobError() || importEventError()}><p class="warning-text" role="status">{jobError() || importEventError()}<button class="text-button" onClick={() => { void connectImportEvents(); refreshJobs(); }}>重新连接并读取进度</button></p></Show>
      <Show when={jobs().some(job => ["queued", "running"].includes(job.status))}>
        <section class="import-background-jobs" aria-label="后台导入任务" aria-live="polite">
          <For each={jobs().filter(job => ["queued", "running"].includes(job.status))}>{job => <div>
            <span><strong>{job.filename}</strong><small><b>{importStage(undefined, job).label}</b> · {job.message || "后台处理中，可继续其它操作。"}</small></span>
            <button class="text-button" disabled={Boolean(busy()) || dirty() || publishFrozen()} onClick={() => open(job.importId)}>查看进度</button>
            <button class="text-button" onClick={async () => { try { await request("import_job_cancel", {importId:job.importId, jobId:job.jobId,responseScope:"summary"}); void refreshJobs(); } catch(failure:any) {setJobError(failure.message);} }}>停止</button>
          </div>}</For>
        </section>
      </Show>
      <Show when={record()}>
        <section class="import-review">
          <button class="text-button import-back" disabled={Boolean(busy()) || publishFrozen()}
            title={dirty() ? "未保存编辑将保留在本窗口" : publishFrozen() ? "请先完成待确认的入库操作" : "返回当前页导入记录"}
            onClick={() => guardNavigation(backToHistory)}><ArrowLeft size={16} />导入记录</button>
          <div class="section-heading import-review-heading">
            <div class="import-document-title">
              <h1 ref={detailHeading} tabIndex={-1} title={record().filename}>{record().structuredSource?.exam?.title || record().filename}</h1>
              <p class="muted">{statusLabels[record().status] || "待审核"} · {questions().length} 题</p>
            </div>
            <div class="import-record-actions">
              <Show when={questions().length}><button class="primary" disabled={Boolean(busy()) || dirty() || teachingDirty() || !pendingApprove().length || publishFrozen() || Boolean(activeJob())} onClick={() => { setPublishError(""); setConfirmPublish(true); }}>将 {pendingApprove().length} 道原题入库</button></Show>
              <Show when={!activeJob() && (canContinueTeaching() || ["failed", "cancelled", "processing"].includes(record().status))}><button class="secondary" disabled={Boolean(busy()) || dirty() || publishFrozen() || !configured()} onClick={() => { if (!prepareAttempt) prepareId = operationId(); parse(true); }}>{canContinueTeaching() ? "继续处理教学稿" : "重新解析"}</button></Show>
              <div class="import-record-tools" ref={recordToolsElement}>
                <button class="icon-button secondary" ref={recordToolsButton} aria-label="更多试卷操作" title="更多试卷操作" aria-expanded={recordToolsOpen()} onClick={() => setRecordToolsOpen(value => !value)}><MoreHorizontal size={18} /></button>
                <Show when={recordToolsOpen()}><div class="import-record-tools-menu" role="group" aria-label="更多试卷操作">
                  <Show when={!activeJob() && (canContinueTeaching() || ["failed", "cancelled", "processing"].includes(record().status))}><button class="import-mobile-retry" disabled={Boolean(busy()) || dirty() || publishFrozen() || !configured()} onClick={() => { setRecordToolsOpen(false); if (!prepareAttempt) prepareId = operationId(); void parse(true); }}>{canContinueTeaching() ? "继续处理教学稿" : "重新解析"}</button></Show>
                  <Show when={props.onAssembly}><button disabled={Boolean(busy()) || publishFrozen()} onClick={() => {setRecordToolsOpen(false);guardNavigation(() => props.onAssembly?.());}}><ArrowLeft size={16} />返回组卷</button></Show>
                  <Show when={props.onGuide}><button onClick={() => {setRecordToolsOpen(false);props.onGuide?.();}}><CircleHelp size={16} />导入说明</button></Show>
                  <button disabled={Boolean(busy()) || publishFrozen()} onClick={() => {setRecordToolsOpen(false);guardNavigation(() => {void props.onBank().catch((failure:any)=>setError(failure.message));});}}>题库</button>
                  <Show when={record().source?.extension === "pdf" || record().renderedPdf}><button disabled={Boolean(busy())} onClick={() => { setRecordToolsOpen(false); setOriginalPreview(true); }}><FileText size={16} />查看原卷 PDF</button></Show>
                  <Show when={canRecheck()}><button disabled={Boolean(busy()) || publishFrozen() || !sourceConfigured() || teachingDirty()} onClick={() => { setRecordToolsOpen(false); recheckQuestions(); }}>重新检查未完成题</button></Show>
                  <Show when={questions().some(item => !published(item) && importAssessmentPresentation(item, teachingControls()[item.questionId]).needsSupplement)}><button disabled={Boolean(busy()) || dirty() || publishFrozen() || Boolean(activeJob()) || teachingDirty() || !activeConfigured()} onClick={() => { setRecordToolsOpen(false); annotateStructured(); }}>补充缺失标注</button></Show>
                </div></Show>
              </div>
            </div>
          </div>
          <Show when={activeJob() || failureDiagnostic() || !questions().length}><div class="import-process-strip" role="status" aria-live="polite" aria-label="试卷处理阶段">
            <span class="import-process-stage">{processStage().stateLabel}：<strong>{processStage().label}</strong></span>
            <Show when={activeJob()?.sourceBatchCount > 0}><span class="muted">已保存 {activeJob()?.completedSourceBatches} / {activeJob()?.sourceBatchCount} 批</span></Show>
            <Show when={failureDiagnostic()}><span class="import-failure-category" data-category={failureView().category}>{failureView().categoryLabel}</span></Show>
          </div></Show>
          <Show when={["annotation", "review"].includes(selectedJob()?.mode) && ["interrupted", "cancelled"].includes(selectedJob()?.status)}>
            <p class="warning-text" role="status">{selectedJob()?.message || "考查信息未全部完成，原题和已有结果已保留，可点击补充考查信息重试。"}</p>
          </Show>
          <Show when={failureDiagnostic()}>
            {(detail) => <section class="import-failure" role="alert" aria-label="导入失败原因">
              <div class="import-failure-title"><AlertCircle size={20} aria-hidden="true" /><h3>{["annotation", "review", "teaching_retry"].includes(selectedJob()?.mode) ? "本次处理未完成" : "导入未完成"}</h3></div>
              <dl>
                <div><dt>失败阶段</dt><dd>{failureView().stage}</dd></div>
                <div><dt>问题分类</dt><dd><span class="import-failure-category" data-category={failureView().category}>{failureView().categoryLabel}</span><Show when={detail().subcategoryLabel}> · {detail().subcategoryLabel}</Show></dd></div>
                <Show when={failureView().serviceLabel || failureView().operationLabel}><div><dt>涉及环节</dt><dd>{[failureView().serviceLabel, failureView().operationLabel].filter(Boolean).join(" · ")}</dd></div></Show>
                <div><dt>具体原因</dt><dd>{detail().summary}</dd></div>
                <Show when={failureView().causeNote}><div><dt>判断范围</dt><dd>{failureView().causeNote}</dd></div></Show>
                <Show when={detail().location}><div><dt>错误位置</dt><dd>{detail().location}</dd></div></Show>
                <Show when={(detail().sourceBatchCount || 0) > 0}>
                  <div><dt>已保存进度</dt><dd>已保存 {detail().completedSourceBatches} / {detail().sourceBatchCount} 批来源转录草稿<Show when={(detail().expectedSourceQuestions || 0) > 0}>，{detail().savedSourceQuestions} / {detail().expectedSourceQuestions} 题</Show>。整卷尚未完成核验，暂不能作为完整试卷审核入库。</dd></div>
                </Show>
                <Show when={detail().failedSourceLabels?.length}><div><dt>未完成题目</dt><dd>第 {detail().failedSourceLabels?.join("、")} 题需继续转录。</dd></div></Show>
                <div><dt>下一步</dt><dd>{failureView().nextAction}</dd></div>
              </dl>
              <Show when={detail().ocrCompleted}><p class="import-failure-preserved"><Check size={16} aria-hidden="true" />试卷识别已完成，原文件和识别材料已保留。</p></Show>
              <Show when={processingError()?.code || detail().attempts > 0}>
                <details><summary>错误详情</summary><p class="muted">{processingError()?.code ? `错误代码：${processingError().code}` : ""}{processingError()?.code && detail().attempts > 0 ? " · " : ""}{detail().attempts > 0 ? detail().sourceRequestBreakdown ? `本轮模型请求 ${detail().attempts} 次（索引 ${detail().indexCalls} 次，转录 ${detail().transcriptionCalls} 次）` : `模型尝试 ${detail().attempts} 次` : ""}</p></details>
              </Show>
            </section>}
          </Show>
          <Show
            when={(record().sourceIssues || []).length && !questions().length}
          >
            <For each={record().sourceIssues}>
              {(issue) => <p class="warning-text">{message(issue)}</p>}
            </For>
          </Show>
          <Show when={questions().length}>
            <Show when={record().structuredSource}>
              <div class="import-structured-summary">
                <p class="muted">原卷 {record().structuredSource.expectedQuestionCount} 题，当前保留 {questions().length} 题。原题直接迁入，模型仅补充考查信息；逐题核对后才入库。</p>

              </div>
            </Show>
            <div class="import-triage-toolbar">
              <div class="import-triage-tabs" role="group" aria-label="题目筛选">
                <For each={[["all", "全部", triage().counts.total], ["todo", "待处理", triage().counts.todo], ["ready", "已就绪", readyCount()], ["published", "已入库", triage().counts.published], ["duplicate", "重复", triage().counts.duplicates]]}>{([id, label, count]) =>
                  <button classList={{ current: triageFilter() === id }} aria-pressed={triageFilter() === id} disabled={Boolean(busy()) || publishFrozen()} onClick={() => changeFilter(String(id))}>{label}<span>{count}</span></button>
                }</For>
              </div>
              <span class="muted">原题可入库 {pendingApprove().length} 题</span>
            </div>
            <span class="import-triage-count-hint" title="待办也可包含已入库但解析未采用的题；重复题单列。" aria-label="待办包括原题或解析未完成的题" />
            <div class="import-audit-progress-strip" aria-label="全卷核验就绪进度">
              <div class="import-audit-progress-bar">
                <div class="import-progress-segment is-published" style={{ width: `${(auditMetrics().published / (auditMetrics().total || 1)) * 100}%` }} title={`已入库 ${auditMetrics().published} 题`} />
                <div class="import-progress-segment is-both" style={{ width: `${(auditMetrics().bothReady / (auditMetrics().total || 1)) * 100}%` }} title={`原题+解析均就绪 ${auditMetrics().bothReady} 题`} />
                <div class="import-progress-segment is-source" style={{ width: `${(auditMetrics().sourceReady / (auditMetrics().total || 1)) * 100}%` }} title={`仅原题就绪 ${auditMetrics().sourceReady} 题`} />
                <div class="import-progress-segment is-todo" style={{ width: `${(auditMetrics().todo / (auditMetrics().total || 1)) * 100}%` }} title={`待处理 ${auditMetrics().todo} 题`} />
              </div>
              <div class="import-audit-progress-meta">
                <span>全卷 <strong>{auditMetrics().total}</strong> 题 · <strong>{auditMetrics().published + auditMetrics().ready}</strong> 题已就绪（含解析 <strong>{auditMetrics().bothReady}</strong> 题）<Show when={auditMetrics().todo > 0}> · <strong>{auditMetrics().todo}</strong> 题待处理</Show></span>
                <span class="import-progress-percent">就绪度 {auditMetrics().percent}%</span>
              </div>
            </div>
            <div class="import-review-layout">
              <nav class="import-question-list" aria-label="待审核题目">
                <header class="import-queue-heading"><strong>题目清单</strong><div><span data-tone="amber"><AlertTriangle size={15} />{triage().counts.amber} 待处理</span><span data-tone="red"><AlertCircle size={15} />{triage().counts.red} 需核对</span></div></header>
                <For each={visibleTriage()}>
                  {(row) => (
                    <button
                      class={current()?.questionId === row.questionId ? "current" : ""}
                      aria-current={current()?.questionId === row.questionId ? "true" : undefined}
                      data-tone={row.tone}
                      disabled={Boolean(busy()) || publishFrozen()}
                      onClick={() => selectQuestion(row.questionId)}
                    >
                      <span class="import-queue-title">{row.question.sourceLabel || questions().findIndex(q => q.questionId === row.questionId) + 1}. {row.question.task?.label || typeLabels[row.question.questionType] || "题目"}</span>
                      <small title={queueReason(row)}><Show when={row.tone === "red"} fallback={<Show when={row.tone === "amber"} fallback={<Check size={14} />}><AlertTriangle size={14} /></Show>}><AlertCircle size={14} /></Show><span class="import-queue-reason">{queueReason(row)}</span></small>
                    </button>
                  )}
                </For>
                <Show when={!visibleTriage().length}><p class="muted import-queue-empty">此分类暂无题目。<button class="text-button" onClick={() => setTriageFilter("all")}>查看全部</button></p></Show>
              </nav>
              <div class="import-question-editor">
                <Show when={current()} fallback={<div role="status"><Show when={questionLoading()} fallback={<><ErrorBanner message={questionError()} /><button class="secondary" onClick={() => setQuestionRetry(n => n + 1)}>重新读取本题</button></>}><Busy label="读取本题详情…" /></Show></div>}>
                  {(_question) => {
                    const question: any = new Proxy(
                      {},
                      { get: (_target, key) => current()?.[key as string] },
                    );
                    return (
                      <>
                        <div class="import-audit-workspace">
                        <div class="import-reading-workspace" data-review-view={canShowOriginal() ? reviewView() : "text"} data-split-ratio={splitRatio()}>
                          <div class="import-compare-toolbar" role="group" aria-label="题目对照视图">
                            <div class="import-view-tabs" role="group" aria-label="阅读方式">
                              <button aria-pressed={reviewView() === "image"} disabled={!canShowOriginal()} onClick={() => setReviewView("image")}><ImageIcon size={16} />原卷</button>
                              <button aria-pressed={reviewView() === "split" && canShowOriginal()} disabled={!canShowOriginal()} onClick={() => setReviewView("split")}><Columns2 size={16} />并排对照</button>
                              <button aria-pressed={reviewView() === "text" || !canShowOriginal()} onClick={() => setReviewView("text")}><FileText size={16} />识别结果</button>
                            </div>
                            <Show when={reviewView() === "split" && canShowOriginal()}>
                              <div class="import-ratio-selector" role="group" aria-label="并排分栏比例">
                                <button type="button" classList={{ current: splitRatio() === "image" }} onClick={() => setSplitRatio("image")} title="原图 60% : 排版 40%（放大原卷）">原图加宽</button>
                                <button type="button" classList={{ current: splitRatio() === "equal" }} onClick={() => setSplitRatio("equal")} title="原图 50% : 排版 50%">1:1 对等</button>
                                <button type="button" classList={{ current: splitRatio() === "text" }} onClick={() => setSplitRatio("text")} title="原图 40% : 排版 60%（适合长推导步骤）">排版加宽</button>
                              </div>
                            </Show>
                            <Show when={props.sidebarExpanded && props.onFocusReview}><button class="text-button import-focus-mode" onClick={() => props.onFocusReview?.()} title="收起全局导航，给原卷和题目更多空间"><PanelLeftClose size={16} />专注审核</button></Show>
                          </div>
                          <div class="import-comparison-panes">
                            <Show when={canShowOriginal()}>
                              <section class="import-inline-original" hidden={reviewView() === "text"} aria-label="当前题原卷">
                                <Suspense fallback={<Busy label="读取已保存原卷…" />}><SourcePageViewer importId={record().importId} pages={question.pages} question={question} focusRequest={sourceFocusRequest()} /></Suspense>
                              </section>
                            </Show>
                        <div class="import-reading-pane">
                        <div class="bank-results-heading import-question-heading">
                          <div><strong>第 {question.sourceLabel || selected() + 1} 题</strong><small class="muted">{typeTitles[question.questionType] || "题目"}</small></div>
                          <div class="inline-actions">
                            <button
                              class="text-button"
                              disabled={Boolean(busy()) || published(question)}
                              onClick={() => preview() ? openSourceEditor() : guardNavigation(() => setPreview(true))}
                            >
                              {preview() ? (
                                <Pencil size={15} />
                              ) : (
                                <Eye size={15} />
                              )}
                              {preview() ? "编辑原题" : "查看排版"}
                            </button>
                          </div>
                        </div>
                        <div class="import-status-row"><div class="import-dual-status" aria-label="原题与解析状态">
                          <span><FileText size={15} />原题 · {correctedSource() ? sourceCorrectionLabel() : currentTriage()?.sourceLabel.replace(/^原题/, "")}</span>
                          <Show when={question.teachingWorkflow}><span data-tone={currentTriage()?.issues.find(issue => issue.domain === "teaching")?.tone || "neutral"}>AI解析 · {teachingStatus().title.replace(/^解析/, "")}</span></Show>
                        </div>
                        </div>
                        <Show when={currentTriage()?.needsAction}><button class="text-button import-issue-jump" onClick={() => document.querySelector<HTMLElement>(".import-triage-panel")?.scrollIntoView({ block:"start" })}><AlertCircle size={15} />查看问题与处理操作<ChevronRight size={15} /></button></Show>
                        <button class="text-button import-compare-entry" onClick={() => setSourceCompare(true)}>
                          <FileText size={16} />原文 / 原图对照
                          <Show when={question.pages?.length}><small class="muted">第 {question.pages.join("、")} 页</small></Show>
                        </button>
                        <Show when={activeIssues().length}>
                          <details class="import-issues" open>
                            <summary>需要核对</summary>
                            <ul>
                              <For each={activeIssues()}>
                                {(issue) => <li>{issue}</li>}
                              </For>
                            </ul>
                          </details>
                        </Show>
                        <Show when={question.annotationError?.message}>
                          <p class="warning-text">考查信息未完成：{question.annotationError.message}。原题已保留，可重试。</p>
                        </Show>
                        <Show when={question.duplicateCandidates?.length}>
                          <aside class="import-duplicate-notice">
                            <strong>{question.duplicateCandidates.some((item: any) => item.exact) ? "题库中已存在此题" : "可能与已有题目重复"}</strong>
                            <p class="muted">{question.duplicateCandidates.some((item: any) => item.exact) ? "本卷条目仍保留，请继续使用已有题目，避免重复入库。" : "请核对原卷版本及题面；不会自动合并或删除。"}</p>
                            <For each={question.duplicateCandidates}>{(item: any) => <small>{item.questionId}{item.exact ? " · 已存在" : " · 待核对"}</small>}</For>
                          </aside>
                        </Show>

                        <Show when={published(question)}>
                          <p class="muted">此题已入库，保留已发布版本。</p>
                        </Show>
                        <Show
                          when={preview()}
                          fallback={
                            <fieldset
                              disabled={
                                Boolean(busy()) || Boolean(activeJob()) ||
                                published(question) || teachingDirty() ||
                                publishFrozen()
                              }
                              class="import-fields"
                            >
                              <label class="field-label">
                                题型
                                <select
                                  aria-label="导入题型" data-source-edit="questionType"
                                  value={question.questionType}
                                  onChange={(event) =>
                                    update({
                                      questionType: event.currentTarget.value,
                                      options:
                                        ["single_choice", "multiple_choice"].includes(event.currentTarget.value)
                                          ? question.options || []
                                          : [],
                                    })
                                  }
                                >
                                  <For each={typeIds}>
                                    {(type) => (
                                      <option value={type}>
                                        {typeTitles[type]}
                                      </option>
                                    )}
                                  </For>
                                </select>
                              </label>
                              <label class="field-label">
                                题干
                                <MathSnippetBar onInsert={insertSnippetIntoActive} />
                                <textarea
                                  rows={6}
                                  aria-label="原题题干" data-source-edit="stem"
                                  onFocus={(e) => { lastFocusedTextarea = e.currentTarget; }}
                                  value={question.stem || ""}
                                  onInput={(event) =>
                                    update({ stem: event.currentTarget.value })
                                  }
                                />
                                <div class="import-field-live-preview">
                                  <div class="import-live-preview-header"><Eye size={13} /><span>题干排版实时预览（公式自动渲染）</span></div>
                                  <div class="import-live-preview-body"><RichText text={question.stem || "（输入题干内容以实时预览数学公式）"} teacher /></div>
                                </div>
                              </label>
                              <Show
                                when={[
                                  "single_choice",
                                  "multiple_choice",
                                ].includes(question.questionType)}
                              >
                                <div class="import-option-fields">
                                  <Index each={question.options || []}>
                                    {(optionValue, index) => {
                                      const option: any = new Proxy(
                                        {},
                                        {
                                          get: (_target, key) =>
                                            optionValue()[key as string],
                                        },
                                      );
                                      return (
                                        <label class="field-label">
                                          选项 {option.label}
                                          <textarea
                                            rows={2}
                                            aria-label={`选项 ${option.label}`} data-source-edit={`options[${index}].text`}
                                            value={option.text || ""}
                                            onFocus={(e) => { lastFocusedTextarea = e.currentTarget; }}
                                            onInput={(event) =>
                                              update({
                                                options: (
                                                  question.options || []
                                                ).map(
                                                  (
                                                    item: any,
                                                    target: number,
                                                  ) =>
                                                    target === index
                                                      ? {
                                                          ...item,
                                                          text: event
                                                            .currentTarget
                                                            .value,
                                                        }
                                                      : item,
                                                ),
                                              })
                                            }
                                          />
                                          <Show when={option.text}>
                                            <div class="import-option-live-preview">
                                              <span class="import-option-preview-tag">{option.label}.</span>
                                              <RichText text={option.text} teacher />
                                            </div>
                                          </Show>
                                        </label>
                                      );
                                    }}
                                  </Index>
                                  <button
                                    type="button"
                                    class="text-button"
                                    onClick={() =>
                                      update({
                                        options: [
                                          ...(question.options || []),
                                          {
                                            label: String.fromCharCode(
                                              65 +
                                                (question.options || []).length,
                                            ),
                                            text: "",
                                          },
                                        ],
                                      })
                                    }
                                  >
                                    添加选项
                                  </button>
                                </div>
                              </Show>
                              <Index each={question.parts || []}>
                                {(partValue, index) => {
                                  const part: any = new Proxy(
                                    {},
                                    {
                                      get: (_target, key) =>
                                        partValue()[key as string],
                                    },
                                  );
                                  return (
                                    <div class="import-part">
                                      <h3>第 {index + 1} 问</h3>
                                      <For
                                        each={[
                                          ["prompt", "题目"],
                                          ["answer", "答案"],
                                          ["solution", "解析"],
                                        ]}
                                      >
                                        {([field, label]) => (
                                          <label class="field-label">
                                            {label}
                                            <textarea
                                              rows={3}
                                              aria-label={`第${index + 1}问${label}`} data-source-edit={`parts[${index}].${field}`}
                                              value={part[field] || ""}
                                              onInput={(event) =>
                                                update({
                                                  parts: (
                                                    question.parts || []
                                                  ).map(
                                                    (
                                                      item: any,
                                                      target: number,
                                                    ) =>
                                                      target === index
                                                        ? {
                                                            ...item,
                                                            [field]:
                                                              event
                                                                .currentTarget
                                                                .value,
                                                          }
                                                        : item,
                                                  ),
                                                })
                                              }
                                            />
                                          </label>
                                        )}
                                      </For>
                                    </div>
                                  );
                                }}
                              </Index>
                              <details class="import-source-references"><summary>原卷答案与解析</summary>
                              <label class="field-label">
                                原卷答案
                                <textarea
                                  rows={3}
                                  aria-label="原卷答案" data-source-edit="answer"
                                  value={question.answer || ""}
                                  onInput={(event) =>
                                    update({
                                      answer: event.currentTarget.value,
                                    })
                                  }
                                />
                              </label>
                              <label class="field-label">
                                原卷解析
                                <textarea
                                  rows={5}
                                  aria-label="原卷解析" data-source-edit="solution"
                                  value={question.solution || ""}
                                  onInput={(event) =>
                                    update({
                                      solution: event.currentTarget.value,
                                    })
                                  }
                                />
                              </label>
                              </details>
                              <details class="import-source-metadata"><summary>考查标注</summary>
                              <section class="import-difficulty">
                                <label class="field-label">
                                  难度 · 内容估计
                                  <select
                                    aria-label="导入题目难度"
                                    value={question.difficultyAssessment?.level || ""}
                                    onChange={(event) => update({ difficultyAssessment: {
                                      level: event.currentTarget.value || null,
                                      basis: event.currentTarget.value ? question.difficultyAssessment?.basis || "" : "",
                                      rubricVersion: "content-demand-v1",
                                    } })}
                                  >
                                    <option value="">未评估</option>
                                    <For each={difficultyLevels}>{level => <option value={level.id}>{level.label}</option>}</For>
                                  </select>
                                </label>
                                <Show when={question.difficultyAssessment?.level}>
                                  <label class="field-label">
                                    难度依据
                                    <textarea rows={3} aria-label="导入难度依据"
                                      value={question.difficultyAssessment?.basis || ""}
                                      placeholder="说明完整解法中决定难度的关键关口。"
                                      onInput={(event) => update({ difficultyAssessment: {
                                        ...question.difficultyAssessment,
                                        basis: event.currentTarget.value,
                                        rubricVersion: "content-demand-v1",
                                      } })}
                                    />
                                  </label>
                                </Show>
                                <p class="muted">按已学所需知识、独立作答估计。不是学生实测；依据不足请选择“未评估”。</p>
                                <details><summary>五档标准</summary><For each={difficultyLevels}>{level => <p><strong>{level.label}：</strong>{level.summary}</p>}</For></details>
                              </section>
                              <Show when={!hasKnowledgePlan(question)}>
                              <label class="field-label">
                                所属章节
                                <select aria-label="所属章节"
                                  multiple
                                  size={4}
                                  onChange={(event) =>
                                    update({
                                      sectionIds: [
                                        ...event.currentTarget.selectedOptions,
                                      ].map((option) => option.value),
                                    })
                                  }
                                >
                                  <For each={sections()}>
                                    {(section) => (
                                      <option value={section.id} selected={(question.sectionIds || []).includes(section.id)}>
                                        {section.label}
                                      </option>
                                    )}
                                  </For>
                                </select>
                              </label>
                              </Show>
                              <label class="field-label">
                                考查任务
                                <select
                                  value={question.task?.id || ""}
                                  onChange={(event) => {
                                    const task = props.config.tasks.find(
                                      (item: any) =>
                                        item.id === event.currentTarget.value,
                                    );
                                    update({
                                      task: task
                                        ? { id: task.id, label: task.label }
                                        : { label: question.task?.label || "" },
                                    });
                                  }}
                                >
                                  <option value="">其他考查任务</option>
                                  <For each={props.config.tasks || []}>
                                    {(task) => (
                                      <option value={task.id}>
                                        {task.label}
                                      </option>
                                    )}
                                  </For>
                                </select>
                              </label>
                              <Show when={!question.task?.id}>
                                <label class="field-label">
                                  考查任务说明
                                  <input
                                    value={question.task?.label || ""}
                                    onInput={(event) =>
                                      update({
                                        task: {
                                          label: event.currentTarget.value,
                                        },
                                      })
                                    }
                                  />
                                </label>
                              </Show>
                              <details>
                                <summary>知识点与适用范围</summary>
                                <Show when={hasKnowledgePlan(question)} fallback={
                                  <>
                                <label class="field-label">
                                  知识点
                                  <select aria-label="知识点"
                                    multiple
                                    size={4}
                                    onChange={(event) =>
                                      update({
                                        knowledgeUids: [
                                          ...event.currentTarget
                                            .selectedOptions,
                                        ].map((option) => option.value),
                                      })
                                    }
                                  >
                                    <For each={knowledge()}>
                                      {(item) => (
                                        <option value={item.uid} selected={(question.knowledgeUids || []).includes(item.uid)}>
                                          {item.name}
                                        </option>
                                      )}
                                    </For>
                                  </select>
                                </label>
                                <label class="field-label">
                                  补充知识点
                                  <input
                                    value={(
                                      question.knowledgeTopics || []
                                    ).join("、")}
                                    onInput={(event) =>
                                      update({
                                        knowledgeTopics:
                                          event.currentTarget.value
                                            .split(/[、,，]/)
                                            .map((item) => item.trim())
                                            .filter(Boolean),
                                      })
                                    }
                                  />
                                </label>
                                <label class="check-row">
                                  <input
                                    type="checkbox"
                                    checked={question.mappingConfirmed === true}
                                    onChange={(event) =>
                                      update({
                                        mappingConfirmed:
                                          event.currentTarget.checked,
                                        requiredSectionIds: event.currentTarget
                                          .checked
                                          ? question.sectionIds || []
                                          : [],
                                      })
                                    }
                                  />
                                  确认所选章节覆盖全部解法依赖
                                </label>
                                <Show when={question.mappingConfirmed}>
                                  <label class="field-label">
                                    允许的完整解法
                                    <textarea
                                      rows={3}
                                      value={question.allowedSolution || ""}
                                      onInput={(event) =>
                                        update({
                                          allowedSolution:
                                            event.currentTarget.value,
                                        })
                                      }
                                    />
                                  </label>
                                  <p class="muted">
                                    只有明确核对适用范围后，才用于自动选题。
                                  </p>
                                </Show>
                                  </>
                                }>
                                  <label class="field-label">
                                    主考知识点
                                    <select aria-label="主考知识点"
                                      multiple
                                      size={5}
                                      onChange={(event) => update({
                                        primaryKnowledgeUids: [...event.currentTarget.selectedOptions].map((option) => option.value),
                                      })}
                                    >
                                      <For each={knowledge()}>
                                        {(item) => <option value={item.uid} disabled={isKnowledgeGroup(item)} selected={(question.primaryKnowledgeUids || []).includes(item.uid)}>{item.name}{isKnowledgeGroup(item) ? "（分类）" : ""}</option>}
                                      </For>
                                    </select>
                                  </label>
                                  <p class="muted">分类节点仅用于导航，请选择具体知识点。</p>
                                  <Show when={!question.primaryKnowledgeUids?.length}>
                                    <p class="muted">尚未标注主考知识点。</p>
                                  </Show>
                                  <Index each={question.solutionPaths || []}>
                                    {(path, index) => {
                                      const updatePath = (fields: any) => update({
                                        solutionPaths: (question.solutionPaths || []).map((item: any, target: number) =>
                                          target === index ? { ...item, ...fields } : item,
                                        ),
                                      });
                                      return (
                                        <section class="import-solution-path">
                                          <div class="import-solution-heading">
                                            <h3>解法 {index + 1}</h3>
                                            <button
                                              type="button"
                                              class="text-button"
                                              aria-label={`删除解法 ${index + 1}`}
                                              onClick={() => update({
                                                solutionPaths: (question.solutionPaths || []).filter((_: any, target: number) => target !== index),
                                              })}
                                            >
                                              <Trash2 size={16} />删除
                                            </button>
                                          </div>
                                          <label class="field-label">
                                            解法 {index + 1} 所需知识点
                                            <select aria-label={`解法 ${index + 1} 所需知识点`}
                                              multiple
                                              size={5}
                                              onChange={(event) => updatePath({
                                                requiredKnowledgeUids: [...event.currentTarget.selectedOptions].map((option) => option.value),
                                              })}
                                            >
                                              <For each={knowledge()}>
                                                {(item) => <option value={item.uid} disabled={isKnowledgeGroup(item)} selected={(path().requiredKnowledgeUids || []).includes(item.uid)}>{item.name}{isKnowledgeGroup(item) ? "（分类）" : ""}</option>}
                                              </For>
                                            </select>
                                          </label>
                                          <Show when={!path().requiredKnowledgeUids?.length}>
                                            <p class="muted">尚未标注此解法所需的知识点。</p>
                                          </Show>
                                          <label class="field-label">
                                            解法 {index + 1} 说明
                                            <textarea
                                              rows={3}
                                              value={path().basis || ""}
                                              onInput={(event) => updatePath({ basis: event.currentTarget.value })}
                                            />
                                          </label>
                                          <Show when={path().requiredPremises?.length}>
                                            <p class="muted">额外工具或条件：{premiseNames(path().requiredPremises)}</p>
                                          </Show>
                                        </section>
                                      );
                                    }}
                                  </Index>
                                  <Show when={!question.solutionPaths?.length}>
                                    <p class="muted">尚未标注解法依赖。</p>
                                  </Show>
                                  <button
                                    type="button"
                                    class="text-button"
                                    disabled={(question.solutionPaths || []).length >= 20}
                                    onClick={() => update({
                                      solutionPaths: [...(question.solutionPaths || []), {
                                        id: `path-${operationId()}`,
                                        requiredKnowledgeUids: [],
                                        requiredPremises: [],
                                        basis: "",
                                      }],
                                    })}
                                  >
                                    <Plus size={16} />添加解法
                                  </button>
                                </Show>
                              </details>

                              </details>
                              <div class="import-edit-mode-actions">
                                <button
                                  type="button"
                                  class="primary"
                                  onClick={() => guardNavigation(() => setPreview(true))}
                                >
                                  <Check size={16} /> 完成编辑，查看排版
                                </button>
                                <button
                                  type="button"
                                  class="secondary"
                                  disabled={Boolean(busy()) || !dirty() || publishFrozen()}
                                  onClick={save}
                                >
                                  <Save size={16} /> 保存修改
                                </button>
                              </div>
                            </fieldset>
                          }
                        >
                          <Show when={(!previewQuestion(question).teacher.answers.length || !previewQuestion(question).teacher.solutions.length)}>
                            <span class="import-reference-absence" title="原卷未提供的答案或解析保持空白，不需额外核对。" />
                          </Show>
                          <article class="import-preview">
                            <QuestionBody
                              question={previewQuestion(question)}
                              teacher
                              hideMissingTeacherMaterials
                              hideSource
                              reviewFieldPrefix="source:"
                              number={/^\(?\d+\)?[.．、]?$/.test(String(question.sourceLabel || "")) ? Number(String(question.sourceLabel).replace(/\D/g, "")) : undefined}
                            />
                          </article>
                        <div class="import-detail-tabs" role="tablist" aria-label="题目详情">
                          <button type="button" role="tab" data-tab="solution" id={`detail-solution-tab-${question.questionId}`} aria-controls={`detail-solution-${question.questionId}`} aria-selected={detailTab() === "solution"} tabIndex={detailTab() === "solution" ? 0 : -1} onClick={() => setDetailTab("solution")} onKeyDown={event => detailTabKey(event,"solution")}>答案解析</button>
                          <button type="button" role="tab" data-tab="assessment" id={`detail-assessment-tab-${question.questionId}`} aria-controls={`detail-assessment-${question.questionId}`} aria-selected={detailTab() === "assessment"} tabIndex={detailTab() === "assessment" ? 0 : -1} onClick={() => setDetailTab("assessment")} onKeyDown={event => detailTabKey(event,"assessment")}>考查信息</button>
                        </div>
                        <section class="import-detail-panel" role="tabpanel" id={`detail-solution-${question.questionId}`} aria-labelledby={`detail-solution-tab-${question.questionId}`} hidden={detailTab() !== "solution"}>
                        <Show when={importTeachingPresentation(question, teachingControls()[question.questionId])}>{draft =>
                          <section class="import-reading-meta import-teaching-draft" aria-label="AI答案与解析">
                            <div class="import-ai-caption"><span>AI解析</span><Show when={!draft().ready}><button class="text-button" data-teaching-state={teachingStatus().kind} onClick={focusReviewProblems}>{teachingStatus().title}<ChevronRight size={14} /></button></Show></div>
                            <Show when={draft().answer}><p data-import-field="teaching:answer" tabIndex={-1}><strong>答案：</strong><ReviewMarkedText text={draft().answer} fieldPath="answer" issues={currentTriage()?.issues || []} binding={teachingControls()[question.questionId]} projectText={teachingFieldProject("answer")} question={previewQuestion(question)} onSelectIssue={selectMarkedIssue} /></p></Show>
                            <Show when={draft().solution}><div class="import-teaching-prose" data-import-field="teaching:teachingSolution" tabIndex={-1}><ReviewMarkedText text={draft().solution} fieldPath="teachingSolution" issues={currentTriage()?.issues || []} binding={teachingControls()[question.questionId]} projectText={teachingFieldProject("teachingSolution")} question={previewQuestion(question)} onSelectIssue={selectMarkedIssue} /></div></Show>
                            <Show when={!draft().answer && !draft().solution}><p class="muted">尚未生成解析。</p></Show>
                            <TeachingReviewActions question={question} controls={teachingControls()[question.questionId]}
                              disabled={Boolean(busy()) || Boolean(activeJob()) || publishFrozen() || dirty()}
                              disabledReason={dirty() ? "请先保存或撤销当前未保存编辑，再核对教学稿。" : undefined}
                              renderText={text => <RichText text={text} question={previewQuestion(question)} teacher />}
                              onAcknowledge={acknowledgeTeachingIssue} onPatch={patchTeachingField}
                              editRequest={editTeachingRequest()} editFieldPath={editTeachingField()} onDirtyChange={setTeachingDirty} />
                          </section>
                        }</Show>
                        <Show when={!importTeachingPresentation(question, teachingControls()[question.questionId])}><p class="muted">尚未生成AI解析。</p></Show>
                        <Show when={(question.legacyReferences?.answers?.length || question.legacyReferences?.solutions?.length)}>
                          <details class="import-legacy-references">
                            <summary>旧库参考（非原卷答案）</summary>
                            <p class="muted">保留旧库记录供对照，未自动填入答案或解析，也不代表已经核验。</p>
                            <For each={[["answers", "参考答案"], ["solutions", "参考解析"]]}>{([field, label]) => <For each={question.legacyReferences?.[field] || []}>{(reference: any) => <section>
                              <strong>{label} · {reference.provenance === "generated" ? "旧模型生成" : reference.provenance === "manual" ? "旧库人工记录" : "来源未知"}</strong>
                              <RichText text={reference.text} />
                            </section>}</For>}</For>
                          </details>
                        </Show>
                        </section>
                        <Show when={importAssessmentPresentation(question, teachingControls()[question.questionId])}>{assessment =>
                          <section class="import-assessment import-detail-panel" role="tabpanel" aria-label="考查信息" id={`detail-assessment-${question.questionId}`} aria-labelledby={`detail-assessment-tab-${question.questionId}`} hidden={detailTab() !== "assessment"}>
                              <Show when={!published(question) && assessment().needsSupplement}><div class="import-assessment-actions">
                                <button type="button" class="text-button" disabled={Boolean(busy()) || dirty() || publishFrozen() || Boolean(activeJob()) || teachingDirty() || !activeConfigured()}
                                  title="调用模型补充本卷尚未完整的标注，保留已有解析与已完成的标注。"
                                  onClick={annotateStructured}>补充本卷缺失标注</button>
                              </div></Show>
                            <dl class="import-reading-facts">
                              <div><dt>难度</dt><dd>{difficultyLevels.find(level => level.id === assessment().level)?.label || "待补充"}<Show when={assessment().difficultyOrigin}><small class="import-assessment-origin">{assessment().difficultyOrigin}</small></Show></dd></div>
                              <div><dt>考查点</dt><dd><RichText text={teachingDisplayText(assessment().examFocus || "待补充")} teacher /></dd></div>
                              <div><dt>{hasKnowledgePlan(question) ? "主考知识点" : "相关知识点"}</dt><dd>{knowledgeNames(hasKnowledgePlan(question) ? question.primaryKnowledgeUids : question.knowledgeUids) === "未标注" ? "待补充正式关联" : knowledgeNames(hasKnowledgePlan(question) ? question.primaryKnowledgeUids : question.knowledgeUids)}</dd></div>
                            </dl>
                            <Show when={importTeachingPresentation(question, teachingControls()[question.questionId])}>{draft => <>
                              <Show when={!draft().ready && draft().basis}><p data-import-field="teaching:difficultyAssessment.basis" tabIndex={-1}><strong>候选难度依据（待核对）：</strong><ReviewMarkedText text={draft().basis} fieldPath="difficultyAssessment.basis" issues={currentTriage()?.issues || []} binding={teachingControls()[question.questionId]} projectText={teachingFieldProject("difficultyAssessment.basis")} question={previewQuestion(question)} onSelectIssue={selectMarkedIssue} /></p></Show>
                              <Show when={!draft().ready && draft().examFocus}><p data-import-field="teaching:teachingFocus.examFocus" tabIndex={-1}><strong>候选考点（待核对）：</strong><ReviewMarkedText text={draft().examFocus} fieldPath="teachingFocus.examFocus" issues={currentTriage()?.issues || []} binding={teachingControls()[question.questionId]} projectText={teachingFieldProject("teachingFocus.examFocus")} question={previewQuestion(question)} onSelectIssue={selectMarkedIssue} /></p></Show>
                              <Show when={draft().studentRequirements.length}><p><strong>{draft().ready ? "对学生的要求：" : "候选对学生的要求（待核对）："}</strong></p><ul><For each={draft().studentRequirements}>{(item,index) => <li data-import-field={`teaching:teachingFocus.studentRequirements[${index()}]`} tabIndex={-1}><ReviewMarkedText text={item} fieldPath={`teachingFocus.studentRequirements[${index()}]`} issues={currentTriage()?.issues || []} binding={teachingControls()[question.questionId]} projectText={teachingFieldProject(`teachingFocus.studentRequirements[${index()}]`)} question={previewQuestion(question)} onSelectIssue={selectMarkedIssue} /></li>}</For></ul></Show>
                            </>}</Show>
                            <Show when={assessment().basis}><section class="import-assessment-detail" aria-label="难度依据"><h3>难度依据</h3><RichText text={teachingDisplayText(assessment().basis)} question={previewQuestion(question)} teacher /></section></Show>
                            <section class="import-assessment-detail" aria-label="解法所需知识"><h3>解法所需知识<small>{assessment().paths.length ? `已标注 ${assessment().paths.length} 条解法` : "待补充"}</small></h3>
                              <For each={assessment().paths}>{(path, index) => <section class="import-path-reading">
                                <h4>解法 {index() + 1}</h4>
                                <p>所需知识：{knowledgeNames(path.requiredKnowledgeUids)}</p>
                                <Show when={path.requiredPremises?.length}><p>额外工具或条件：{premiseNames(path.requiredPremises)}</p></Show>
                                <RichText text={teachingDisplayText(path.basis || "本条解法说明待补充。") } question={previewQuestion(question)} teacher />
                              </section>}</For>
                              <Show when={!assessment().paths.length}>
                                <p class="muted">{assessment().hasTeachingSolution ? "已有解析，尚未整理这条解法所需的知识点。" : assessment().teachingSolutionPending ? "AI解析仍待复核，暂不能据此标注完整解法所需知识。" : "尚未整理各解法所需的知识点。"}补充后可用于按已学范围自动选题；不影响核对原题和手动选题。</p>
                                <Show when={!hasKnowledgePlan(question) && question.allowedSolution}><RichText text={question.allowedSolution} question={previewQuestion(question)} teacher /></Show>
                              </Show>
                            </section>
                          </section>
                        }</Show>
                        </Show>
                        </div>
                          </div>
                        </div>
                        <Show when={true}>
                        <aside class="import-review-checks import-opinion import-triage-panel" data-tone={currentTriage()?.tone} aria-label="本题检查意见">
                          <div class="import-triage-panel-heading"><h3>本题处理</h3></div>
                          <div class="import-review-domains" role="tablist" aria-label="处理内容">
                            <button type="button" role="tab" id="review-source-tab" aria-controls="review-domain-panel" data-domain="source" aria-selected={reviewDomain() === "source"} tabIndex={reviewDomain() === "source" ? 0 : -1} onClick={() => setReviewDomain("source")} onKeyDown={reviewDomainKey}>原题<Show when={sourceProblemCount()}><span>{sourceProblemCount()}</span></Show></button>
                            <button type="button" role="tab" id="review-teaching-tab" aria-controls="review-domain-panel" data-domain="teaching" aria-selected={reviewDomain() === "teaching"} tabIndex={reviewDomain() === "teaching" ? 0 : -1} onClick={() => setReviewDomain("teaching")} onKeyDown={reviewDomainKey}>AI解析<Show when={teachingProblemCount()}><span>{teachingProblemCount()}</span></Show><Show when={!teachingProblemCount() && ["generation_failed", "review_failed", "review_pending"].includes(teachingStatus().kind)}><span aria-label="处理未完成">!</span></Show></button>
                          </div>
                          <div class="import-review-body" tabIndex={-1} role="tabpanel" id="review-domain-panel" aria-labelledby={reviewDomain() === "source" ? "review-source-tab" : "review-teaching-tab"}>
                          <Show when={activeJob()}><p class="muted" role="status">后台处理中，可继续阅读；完成后可保存。</p></Show>
                          <Show when={reviewDomain() === "teaching" && ["generation_failed", "review_failed", "review_pending"].includes(teachingStatus().kind)}><section class="import-review-process-status" aria-label="解析处理情况"><h4>{teachingStatus().title}</h4><Show when={teachingStatus().kind !== "review_pending"}><For each={teachingStatus().reasons}>{reason => <p><RichText text={teachingDisplayText(reviewDisplayMessage(reason))} /></p>}</For></Show></section></Show>
                          <Show when={reviewDomain() === "teaching" && !["generation_failed", "review_failed", "review_pending"].includes(teachingStatus().kind)}><For each={reviewOutcomeGroups()}>{group => <p class="import-review-outcome">{group.message}</p>}</For></Show>
                          <Show when={visibleReviewProblems().length} fallback={<><Show when={reviewDomain() === "source" && !published(question) && question.reviewDecision !== "approve" && currentTriage()?.duplicateState !== "exact"}><p class="muted import-review-empty">请对照原卷确认本题。</p></Show><Show when={reviewDomain() === "teaching" && !reviewOutcomeGroups().length && !["generation_failed", "review_failed", "review_pending"].includes(teachingStatus().kind)}><p class="muted import-review-empty">{teachingStatus().title}</p></Show></>}>
                            <ol class="import-review-problems" aria-label="需要核对的事项" tabIndex={-1}>
                              <For each={visibleReviewProblems()}>{group =>
                                <li class="import-review-problem" data-review-member-ids={group.members.map(issue => issue.id).join(" ")} data-tone={currentCorrection(group) ? "amber" : group.tone} data-active={group.members.some(issue => issue.id === focusedIssue())}>
                                  <div class="import-review-problem-title"><strong>{currentCorrection(group) ? currentCorrection(group)?.kind === "ocr_transcription" ? "已修正，待确认" : "转录已调整，待确认" : group.title}</strong></div>
                                  <Show when={currentCorrection(group)}>{correction => <><div class="import-review-problem-message"><RichText text={correction().basis} /></div><div class="import-review-problem-locations"><button class="text-button" onClick={() => viewCorrection(group)}><LinkIcon size={15} />查看修正处</button><button class="text-button" disabled={Boolean(busy()) || Boolean(activeJob()) || publishFrozen() || teachingDirty()} onClick={() => openSourceEditor(correction().fieldPath)}><Pencil size={15} />修改原题</button></div></>}</Show>
                                  <Show when={!currentCorrection(group) && (!group.members.some(issue => issue.type === "term") || group.title === "检查课堂术语") && group.message !== group.title}><div class="import-review-problem-message"><RichText text={teachingDisplayText(reviewDisplayMessage(group.message))} /></div></Show>
                                  <Show when={group.locatableIssues.length}>
                                    <div class="import-review-problem-locations"><For each={groupLocations(group)}>{issue => <div class="import-review-location">
                                      <span>{reviewFieldLabel(issue.target?.fieldPath, issue.domain)}</span>
                                      <button class="text-button import-locate" aria-label={`查看${reviewFieldLabel(issue.target?.fieldPath, issue.domain)}`} title={`查看${reviewFieldLabel(issue.target?.fieldPath, issue.domain)}`} onClick={() => locateIssue(issue)}><LinkIcon size={15} />查看</button>
                                      <Show when={issue.domain === "source" && !published(question)}><button class="text-button" aria-label={`修改${reviewFieldLabel(issue.target?.fieldPath, "source")}`} disabled={Boolean(busy()) || Boolean(activeJob()) || publishFrozen() || teachingDirty()} onClick={() => openSourceEditor(issue.target?.fieldPath)}><Pencil size={15} />修改</button></Show>
                                      <Show when={issue.domain === "teaching" && teachingControls()[question.questionId]?.canPatch && teachingControls()[question.questionId]?.editableFields?.some((field: { path: string }) => field.path === issue.target?.fieldPath)}><button class="text-button" aria-label={`修改${reviewFieldLabel(issue.target?.fieldPath, issue.domain)}`} title={`修改${reviewFieldLabel(issue.target?.fieldPath, issue.domain)}`} disabled={Boolean(busy()) || Boolean(activeJob()) || publishFrozen() || dirty() || teachingDirty()} onClick={() => openTeachingEditor(issue.target?.fieldPath)}><Pencil size={15} />修改</button></Show>
                                    </div>}</For></div>
                                  </Show>
                                </li>
                              }</For>
                            </ol>
                          </Show>
                          <Show when={locationNotice()}><p class="muted" role="status">{locationNotice()}</p></Show>
                          <section class="import-triage-next" aria-label="本题下一步">
                            <Show when={reviewDomain() === "teaching"}>
                              <section class="import-review-teaching-actions" aria-label="处理AI解析">
                                <TeachingStatusActions />
                                <Show when={teachingActions()[question.questionId]?.canRetryGeneration && teachingStatus().actionHint !== "retry_generation"}>
                                  <button class="secondary" disabled={Boolean(busy()) || Boolean(activeJob()) || dirty() || teachingDirty() || publishFrozen()} onClick={() => askQuestionAction("retry")}><RotateCcw size={16} />重试本题解析</button>
                                </Show>
                                <Show when={teachingControls()[question.questionId]?.canPatch}>
                                  <button class="secondary" disabled={Boolean(busy()) || Boolean(activeJob()) || publishFrozen() || dirty()} onClick={() => openTeachingEditor()}><Pencil size={16} />修改AI解析</button>
                                </Show>
                                <Show when={teachingActions()[question.questionId]?.canPublishTeaching || teachingActions()[question.questionId]?.canResumeTeachingPublication}>
                                  <button class="primary" disabled={Boolean(busy()) || Boolean(activeJob()) || dirty() || teachingDirty() || publishFrozen()} onClick={() => askQuestionAction("publish")}>{teachingActions()[question.questionId]?.canResumeTeachingPublication ? "继续上次解析更新" : "更新题库解析"}</button>
                                </Show>
                              </section>
                            </Show>
                            <Show when={reviewDomain() === "source" && !published(question) && currentTriage()?.duplicateState !== "exact" && question.reviewDecision !== "approve" && question.reviewDecision !== "reject"}>
                              <div class="import-source-confirmation">

                                <Show when={activeIssues().length}><p class="warning-text">存在内容缺失或材料问题，请先编辑修正。</p></Show>
                                <Show when={!activeIssues().length && !otherQuestionEdits()}>
                                  <button
                                    class="primary import-quick-confirm-btn"
                                    disabled={Boolean(busy()) || Boolean(activeJob()) || teachingDirty() || publishFrozen()}
                                    onClick={quickConfirmCurrentSource}
                                    title="确认本题原题无误并自动前往下一待处理题（快捷键：Ctrl+Enter）"
                                  >
                                    <Check size={16} />
                                    <span>确认原题无误并继续</span>
                                    <kbd class="import-key-badge">Ctrl+Enter</kbd>
                                  </button>
                                </Show>
                                <details class="import-manual-confirm-toggle" open={Boolean(activeIssues().length)}>
                                  <summary>{activeIssues().length ? "核对检查项与手动确认" : "高级 / 补充核对备注"}</summary>
                                  <label class="check-row" title={`核对范围：${sourceConfirmationScopeLabel(question)}`}>
                                    <input type="checkbox" checked={sourceConfirmed()} disabled={Boolean(busy()) || Boolean(activeJob()) || teachingDirty() || publishFrozen() || Boolean(activeIssues().length)} onChange={event => setSourceConfirmed(event.currentTarget.checked)} />
                                    <span>已对照原卷，内容完整正确</span>
                                  </label>
                                  <div class="import-confirmation-note"><textarea rows={2} aria-label="本题核对备注" maxLength={3000} value={sourceConfirmationNote()} onInput={event => setSourceConfirmationNote(event.currentTarget.value)} placeholder="补充备注（选填）：可记录核对依据或补充说明" /></div>
                                  <Show when={otherQuestionEdits()}><p class="warning-text">其他题有未保存修改，请先保存或撤销。</p></Show>
                                  <button class="secondary" disabled={!sourceConfirmed() || Boolean(activeIssues().length) || Boolean(busy()) || Boolean(activeJob()) || teachingDirty() || publishFrozen() || otherQuestionEdits()} onClick={confirmCurrentSource}><Check size={16} />确认原题并继续</button>
                                </details>

                              </div>
                            </Show>
                            <Show when={reviewDomain() === "source" && (published(question) || reviewEligibility()[question.questionId]?.eligible === true)}>
                              <p class="import-source-confirmed"><Check size={16} />{published(question) ? "原题已入库" : question.reviewDecision === "approve" ? "原题已确认" : "原题可入库"}</p>
                            </Show>
                            <Show when={reviewDomain() === "source"}><div class="import-source-tools">
                              <button class="text-button" onClick={() => {setReviewView("split");setSourceFocusRequest(value=>value+1);}} disabled={!canShowOriginal()}><ImageIcon size={15} />定位原卷</button>
                              <button class="text-button" disabled={Boolean(busy()) || published(question)} onClick={() => openSourceEditor()}><Pencil size={15} />编辑原题</button>
                            </div></Show>
                          </section>
                          <details class="import-opinion-details import-review-remaining"><summary>处理记录</summary>
                            <For each={(currentTriage()?.issues || []).filter(issue => issue.domain === reviewDomain())}>{issue => <section class="import-review-context">
                              <p><strong>{issue.domain === "source" ? "原题" : "AI解析"} · {issue.provenanceLabel}</strong><br />{issue.process.categoryLabel} · {issue.process.stage}</p>
                              <RichText text={issue.message} />
                              <p>{issue.process.nextAction}</p>
                              <Show when={issue.process.causeNote}><p>{issue.process.causeNote}</p></Show>
                            </section>}</For>
                            <For each={!dirty() ? sourceCorrectionDisplays()[question.questionId] || [] : []}>{correction => <section class="import-review-context"><p><strong>原题转录比对记录 · {correction.method === "model_review" ? "模型修正说明" : "授权代理核对"}</strong></p><p>第 {correction.evidencePage} 页；{correction.checkedBy}；{correction.checkedAt}。此记录只说明转录调整，不替代本题确认或入库审核。</p><RichText text={correction.basis} /></section>}</For>
                            <Show when={question.modelReview}><RichText text={question.modelReview.summary || ""} /><p class="muted">模型自评：{confidenceLabel(question.modelReview.confidence)}；不等于独立核验。</p></Show>
                            <Show when={question.teachingWorkflow}><p class="muted">生成 {Number(question.teachingWorkflow.generationCalls || 0)} 次 · 复核 {Number(question.teachingWorkflow.reviewCalls || 0)} 次</p></Show>
                            <Show when={question.reviewBasis}><p class="muted">核对记录：{question.reviewBasis}</p></Show>
                            <Show when={currentTriage()?.notices.length}><For each={currentTriage()?.notices}>{issue => <RichText text={issue.message} />}</For></Show>
                            <Show when={question.modelReview?.status === "needs_review" && !activeJob()}><button class="text-button" disabled={Boolean(busy()) || publishFrozen() || !sourceConfigured() || teachingDirty()} onClick={recheckQuestions}>重新检查疑点题</button></Show>

                          </details>
                          </div>
                          <nav class="import-question-navigation" aria-label="单题审核导航">
                            <button class="secondary" disabled={Boolean(busy()) || selected() <= 0} onClick={() => moveQuestion("previous")}><ChevronLeft size={15} />上一题</button>
                            <button class="secondary" disabled={Boolean(busy())} onClick={nextTodo}>下一待处理<ChevronRight size={15} /></button>
                          </nav>
                        </aside>
                        </Show>
                        </div>
                      </>
                    );
                  }}
                </Show>
              </div>
            </div>
            <footer class="import-review-footer">
              <span class="muted" role="status">
                {busy() || notice() || (teachingDirty() ? "解析有未保存修改 · 请在修订区保存" : dirty() ? "有未保存修改 · 可保留在本窗口稍后继续" : "进度已保存")}
              </span>
              <div class="inline-actions">
                <Show when={dirty()}>
                  <button
                    class="text-button"
                    disabled={Boolean(busy()) || publishFrozen()}
                    onClick={() => {
                      editBuffers.delete(record().importId);
                      setQuestions(clone(record().questions || []));
                      setEditBaseRevision(record().revision);
                      setDirty(false);
                      setError("");
                      setPreview(true);
                      setNotice("已撤销未保存修改。");
                      // A buffered edit may predate updates observed while in
                      // history. Undo also reloads persisted state and bindings.
                      void open(record().importId);
                    }}
                  >
                    撤销修改
                  </button>
                </Show>
                <button
                  class="secondary"
                  disabled={Boolean(busy()) || !dirty() || publishFrozen()}
                  onClick={save}
                >
                  <Save size={16} />
                  保存修改
                </button>

              </div>
            </footer>
          </Show>
        </section>
      </Show>
      <Show when={!record()}>
        <section class="import-records" aria-label="试卷导入记录" aria-busy={historyLoading()} ref={historyRegion} tabIndex={-1}>
          <header class="import-records-heading">
            <h2>导入记录 <span class="muted">共 {historyTotal()} 份</span></h2>
            <Show when={historyLoading()}><span class="muted" role="status">正在读取…</span></Show>
          </header>
          <Show when={historyError()}>
            <div class="import-records-error" role="alert"><span>{historyError()}</span>
              <button class="text-button" disabled={historyLoading()} onClick={() => loadHistory(requestedHistoryPage)}>重试</button>
            </div>
          </Show>
          <Show when={history().length} fallback={
            <Show when={!historyLoading() && !historyError()}><div class="empty-state">暂无导入记录，选择试卷开始导入。</div></Show>
          }>
            <table class="import-records-table">
              <thead><tr><th scope="col">试卷名称</th><th scope="col">状态</th><th scope="col">题目</th><th scope="col">导入时间</th></tr></thead>
              <tbody><For each={history()}>{(item) => (
                <tr>
                  <td><button class="import-record-open" data-import-id={item.importId}
                    aria-label={`查看 ${item.displayTitle || item.filename}`} title={item.filename}
                    disabled={Boolean(busy()) || historyLoading()} onClick={() => open(item.importId)}>
                    <FileText size={18} aria-hidden="true" />
                    <span class="import-record-name"><strong>{item.displayTitle || item.filename}</strong>
                      <Show when={item.status === "failed"}><small class="import-record-failure-meta">{importStage(item, item).label} · {importFailure(item.error, { record: item, job: item }).categoryLabel}</small></Show>
                      <small class="import-record-mobile-meta">{item.questionCount} 题 · {importDate(item.createdAt)}</small>
                    </span><ChevronRight size={16} aria-hidden="true" />
                  </button></td>
                  <td class="import-record-status"><span data-status={item.status} title={message(item.error) || statusLabels[item.status]}>{statusLabels[item.status] || "待审核"}</span></td>
                  <td class="import-record-count">{item.questionCount} 题</td>
                  <td class="import-record-date"><time dateTime={item.createdAt}>{importDate(item.createdAt)}</time></td>
                </tr>
              )}</For></tbody>
            </table>
          </Show>
          <Show when={historyTotal() > 0}>
            <nav class="import-records-pagination" aria-label="导入记录分页">
              <span class="muted import-page-size">每页 {HISTORY_PAGE_SIZE} 份</span>
              <div class="import-page-controls">
                <button class="text-button" disabled={historyLoading() || Boolean(busy()) || historyPage() <= 1} onClick={() => loadHistory(historyPage() - 1)}><ChevronLeft size={16} />上一页</button>
                <span class="import-page-numbers"><For each={historyPageNumbers()}>{(page, index) => (<>
                  <Show when={index() > 0 && page - historyPageNumbers()[index() - 1] > 1}><span class="muted" aria-hidden="true">…</span></Show>
                  <button class="text-button" aria-label={`第 ${page} 页`} aria-current={historyPage() === page ? "page" : undefined}
                    disabled={historyLoading() || Boolean(busy())} onClick={() => loadHistory(page)}>{page}</button>
                </>)}</For></span>
                <span class="muted import-page-position">第 {historyPage()} / {historyPages()} 页</span>
                <button class="text-button" disabled={historyLoading() || Boolean(busy()) || historyPage() >= historyPages()} onClick={() => loadHistory(historyPage() + 1)}>下一页<ChevronRight size={16} /></button>
              </div>
            </nav>
          </Show>
        </section>
      </Show>
      <Show when={confirmPublish()}>
        <Modal
          title="加入本地题库"
          stable
          busy={Boolean(busy())}
          onClose={() => {
            if (!publishFrozen()) setConfirmPublish(false);
          }}
          footer={
            <>
              <button
                class="secondary"
                disabled={Boolean(busy()) || publishFrozen()}
                onClick={() => setConfirmPublish(false)}
              >
                取消
              </button>
              <button
                class="primary"
                disabled={Boolean(busy())}
                onClick={publish}
              >
                {busy() ? "入库中…" : publishFrozen() ? "重试入库" : "确认入库"}
              </button>
            </>
          }
        >
          <p>本次将以下 {pendingApprove().length} 道原题加入本地题库，范围按每题检查结果确定。</p>
          <p class="import-publication-scope"><strong>原题＋AI解析 {pendingApprove().filter(q=>reviewEligibility()[q.questionId]?.publicationScope === "source_and_teaching").length} 题</strong><span>仅原题 {pendingApprove().filter(q=>reviewEligibility()[q.questionId]?.publicationScope === "source_only").length} 题；对应AI解析不包含在本次入库中。</span></p>
          <Show when={questions().some(q=>!published(q) && !pendingApprove().some(ready=>ready.questionId===q.questionId))}>
            <p class="muted">不会入库：第 {questions().filter(q=>!published(q) && !pendingApprove().some(ready=>ready.questionId===q.questionId)).map(q=>q.sourceLabel || questions().indexOf(q)+1).join("、")} 题。未通过的原题及AI解析继续保留待处理。</p>
          </Show>
          <ul class="import-publication-list"><For each={pendingApprove()}>{question => <li><span>第 {question.sourceLabel || questions().findIndex(q => q.questionId === question.questionId) + 1} 题</span><strong>{reviewEligibility()[question.questionId]?.publicationScope === "source_and_teaching" ? "原题＋AI教学稿" : reviewEligibility()[question.questionId]?.publicationScope === "source_only" ? "仅原题（保留原卷参考）" : "内容范围待重新读取"}</strong></li>}</For></ul>
          <p class="muted">这里列出本次全部可入库题。原题入库后，未采用的AI解析仍可在待办中处理，通过后再单独确认更新。</p>
          <ErrorBanner message={publishError()} />
          <Show when={publishError() && publishFrozen()}>
            <p class="muted">
              本次操作已固定。重试将核查同一次入库结果，不会重复创建题目。
            </p>
            <button
              class="text-button"
              disabled={Boolean(busy())}
              onClick={async () => {
                setPublishError("");
                try {
                  const result = await request("import_summary_get", {
                    importId: record().importId,
                  });
                  applyResponse(result);
                  if (result.summary.pendingPublication?.operationId) return;
                  setPublishFrozen(false);
                  publishAttempt = null;
                  setConfirmPublish(false);
                  await loadHistory();
                } catch (failure: any) {
                  setPublishError(failure.message);
                }
              }}
            >
              重新读取记录
            </button>
          </Show>
        </Modal>
      </Show>
      <Show when={questionAction()}>{action =>
        <Modal title={action().kind === "retry" ? "重试本题解析" : "更新题库解析"} busy={Boolean(busy())} onClose={() => setQuestionAction(null)} footer={<><button class="secondary" disabled={Boolean(busy())} onClick={() => setQuestionAction(null)}>取消</button><button class="primary" disabled={Boolean(busy())} onClick={runQuestionAction}>{action().kind === "retry" ? "确认调用并重试" : "确认更新解析"}</button></>}>
          <p>本次仅处理第 {current()?.sourceLabel || selected() + 1} 题。</p>
          <Show when={action().kind === "retry"} fallback={<p>将当前已通过的教学稿更新到题库中对应的题目。原题、原卷参考以及已冻结成卷保持原版本。题库版本有变化时停止更新，不覆盖新内容。</p>}>
            <p>向当前“解析生成”配置的服务商发送本题所需材料，可能产生费用。本次仅生成，不追加Qwen复核，不处理其他题。</p>
            <p class="muted">旧尝试保留。网络超时只代表本机未收到有效回复，不代表服务商未执行。</p>
          </Show>
          <ErrorBanner message={error()} />
        </Modal>
      }</Show>
      <Show when={leaveAction()}>
        <Modal title="解析有未保存修改" onClose={() => setLeaveAction(null)} footer={<><button class="secondary" onClick={() => setLeaveAction(null)}>继续编辑</button><button class="primary" onClick={() => { const action = leaveAction(); setLeaveAction(null); setTeachingDirty(false); action?.(); }}>放弃本次编辑并继续</button></>}>
          <p>当前教学稿的修改尚未保存。放弃后保留进入本次编辑时的内容，已保存的人工修订保持不变。</p>
        </Modal>
      </Show>
      <Show when={sourceCompare() && record()}><Suspense fallback={<Busy label="读取对照资料…" />}><SourceCompare importId={record().importId} pages={current()?.pages} extractedPages={record().extractedPages} question={originalAssets()} onClose={() => setSourceCompare(false)} /></Suspense></Show>
      <Show when={originalPreview() && record()}>
        <Modal title="原卷 PDF 对照" wide stable onClose={() => setOriginalPreview(false)}>
          <Suspense fallback={<Busy label="读取原卷…" />}><PdfPreview importId={record().importId} /></Suspense>
        </Modal>
      </Show>
    </>
  );
}
