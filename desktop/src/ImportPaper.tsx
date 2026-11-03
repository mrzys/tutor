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
  ChevronDown,
  CircleHelp,
  AlertCircle,
  AlertTriangle,
  RotateCcw,
  Link as LinkIcon,
  MoreHorizontal,
  Columns2,
  PanelLeftClose,
  Image as ImageIcon,
  ListPlus,
  LoaderCircle,
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
import { requiredReviewChecks, sourceReviewLabel, sourceReviewDescription, briefReviewReasons, hasUnstartedTeaching,
  teachingAcknowledgementPayload, teachingPatchPayload, type TeachingIssueRow, type TeachingReviewControls } from "./import-review";
import { MathSnippetBar } from "./MathSnippetBar";
import { TeachingReviewActions } from "./TeachingAnalysis";
import { ImportQuestionReading } from "./ImportQuestionReading";
import { ImportReadingTabs, type ImportReadingTab } from "./ImportReadingTabs";
import { ImportConfirmationContext } from "./ImportConfirmationContext";
import { importConfirmationContext } from "./import-confirmation-context";
import { beginAccuracyStatusAction, createAccuracyStatusSession, ImportAccuracyStatus } from "./ImportAccuracyStatus";
import { accuracyCanReviewDomain, accuracyDomainLabel, accuracyFieldLabel, accuracyFindings, accuracyImportAction, accuracyKnowledgeNames, accuracyModelReadiness, accuracyPendingDomains, accuracyPremiseNames, accuracyPreviewCandidate, accuracyStatus, accuracySuggestedDomain, type AccuracyDomain } from "./import-accuracy";
import { uploadModelDestinations, uploadOcrDestination } from "./import-upload";
import { ImportReviewHeader, type ImportReviewPrimaryFilter } from "./ImportReviewHeader";
import { ImportSourceFieldEditor } from "./ImportSourceFieldEditor";
import { ImportEditableSourceField } from "./ImportEditableSourceField";
import { readImportSourceField, replaceImportSourceField, type ImportSourceFieldRequest } from "./import-source-edit";
import { teachingFieldPanel, teachingIssuePresentation, teachingStatusTitle } from "./teaching-field-presentation";
import { importModelReadiness, importModelReady } from "./import-model-readiness";
import { importTriage, type TriageIssue } from "./import-triage";
import { groupReviewIssues, isReviewOutcomeGroup, sourceCorrectionForGroup, reviewDisplayMessage, reviewFieldLabel, type ReviewIssueGroup, type SourceCorrectionDisplay } from "./import-review-presentation";
import { importTeachingStatus } from "./import-teaching-status";
import { importFailure, importStage } from "./import-process";
import { sourceConfirmationUpdate, sourceConfirmationScopeLabel, sourceConfirmationContentIssues } from "./import-source-confirmation";
import { teachingDisplayText } from "./teaching-text";
import { ReviewMessage } from "./ReviewMessage";
import { reviewMessageText } from "./review-message";
import { importReviewSummary, isTeachingPending, sourceReviewState, reviewRowsForFilter, nextReviewQuestion, reviewStatusLabel } from "./import-review-flow";
import { hasImportQuestionDetail, mergeImportView, mergeImportQuestionDetail, createImportQuestionRequests, createImportRefreshQueue } from "./import-detail-sync";
import { createImportAnnotationPlan, importAnnotationPlanCurrent, type ImportAnnotationPlan } from "./import-annotation";
import "./ImportPaper.css";
import "./ImportReviewWorkspace.css";
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
  budget_paused: "额度暂停",
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

export function ImportPaper(props: {
  config: any;
  onGuide?: () => void;
  modelRevision: number;
  onConfigure: (section?: "models" | "ocr", context?: { from: "import"; materialKind?: "document" | "text" }) => void;
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
  // Reading details are replaced after real backend version changes. Keep each
  // question's pending action outside that transient detail subtree.
  const accuracySessions = new Map<string, ReturnType<typeof createAccuracyStatusSession>>();
  function accuracySession(importId: string, questionId: string) {
    const key = JSON.stringify([importId, questionId]);
    let session = accuracySessions.get(key);
    if (!session) { session = createAccuracyStatusSession(); accuracySessions.set(key, session); }
    return session;
  }
  const [checking, setChecking] = createSignal(true);
  const [importConfigured, setImportConfigured] = createSignal(false);
  const [accuracyConfigured, setAccuracyConfigured] = createSignal(false);
  const [missingAccuracyRoles, setMissingAccuracyRoles] = createSignal<string[]>([]);
  const [uploadDestinations, setUploadDestinations] = createSignal<ReturnType<typeof uploadModelDestinations>>([]);
  const [ocrDestination, setOcrDestination] = createSignal("尚未配置");
  const [sourceConfigured, setSourceConfigured] = createSignal(false);
  const [teachingConfigured, setTeachingConfigured] = createSignal(false);
  const [activeConfigured, setActiveConfigured] = createSignal(false);
  const accuracyRecord = () => Boolean(record()?.accuracyRunId);
  const configured = () => !record() || accuracyRecord() ? accuracyConfigured() : record()?.questions?.length ? teachingConfigured() : importConfigured();
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
  const [openingImportId, setOpeningImportId] = createSignal<string | null>(null);
  const [historyError, setHistoryError] = createSignal("");
  const HISTORY_PAGE_SIZE = 10;
  const [record, setRecord] = createSignal<any>(null);
  const [diagnostic, setDiagnostic] = createSignal<ImportDiagnostic | null>(null);
  const [questions, setQuestions] = createSignal<any[]>([]);
  const [selected, setSelected] = createSignal(0);
  const [file, setFile] = createSignal<File | null>(null);
  const chosenFileKind = () => /\.(pdf|docx)$/i.test(file()?.name || "") ? "document" : "text";
  const [busy, setBusy] = createSignal("");
  const [error, setError] = createSignal("");
  const [dirty, setDirty] = createSignal(false);
  const [editBaseRevision, setEditBaseRevision] = createSignal<number>();
  const editBuffers = new Map<string, any>();
  const [reviewEligibility, setReviewEligibility] = createSignal<Record<string, any>>({});
  const [teachingControls, setTeachingControls] = createSignal<Record<string, TeachingReviewControls>>({});
  const [teachingActions, setTeachingActions] = createSignal<Record<string, any>>({});
  const [sourceCorrectionDisplays, setSourceCorrectionDisplays] = createSignal<Record<string, SourceCorrectionDisplay[]>>({});
  const [triageFilter, setTriageFilter] = createSignal<ImportReviewPrimaryFilter>("source_pending");
  const [focusedIssue, setFocusedIssue] = createSignal("");
  const [locationNotice, setLocationNotice] = createSignal("");
  const [teachingDirty, setTeachingDirty] = createSignal(false);
  const [sourceFieldDirty, setSourceFieldDirty] = createSignal(false);
  const [sourceEditorOpen, setSourceEditorOpen] = createSignal(false);
  const [discardFieldRequest, setDiscardFieldRequest] = createSignal(0);
  const [sourceFieldEdit, setSourceFieldEdit] = createSignal<{ request: ImportSourceFieldRequest; importId: string; revision: number; question: any; presentation: any }>();
  const editingDirty = () => teachingDirty() || sourceFieldDirty();
  const [teachingEditorOpen, setTeachingEditorOpen] = createSignal(false);
  const [editTeachingRequest, setEditTeachingRequest] = createSignal(0);
  const [leaveAction, setLeaveAction] = createSignal<null | (() => void)>(null);
  const [questionAction, setQuestionAction] = createSignal<null | { kind: "retry" | "publish"; questionId: string; revision: number; binding: any }>(null);
  const [annotationAction, setAnnotationAction] = createSignal<ImportAnnotationPlan | null>(null);
  const [annotationError, setAnnotationError] = createSignal("");
  const [preview, setPreview] = createSignal(true);
  const [originalPreview, setOriginalPreview] = createSignal(false);
  const [sourceConfirmed, setSourceConfirmed] = createSignal(false);
  const [reviewView, setReviewView] = createSignal<"split" | "image" | "text">("split");
  const [splitRatio, setSplitRatio] = createSignal<"equal" | "image" | "text">("equal");
  let lastFocusedTextarea: HTMLTextAreaElement | null = null;
  const [sourceFocusRequest, setSourceFocusRequest] = createSignal(0);
  const [detailTab, setDetailTab] = createSignal<"solution" | "assessment">("solution");
  const [queueVisible, setQueueVisible] = createSignal(true);
  const [issuesVisible, setIssuesVisible] = createSignal(false);
  const [reviewDomain, setReviewDomain] = createSignal<"source" | "teaching">("source");
  const [accuracyFocus, setAccuracyFocus] = createSignal<{ questionId: string; domain: AccuracyDomain } | null>(null);
  const accuracyDomain = () => {
    const focus = accuracyFocus(), question = current();
    return focus && question && focus.questionId === question.questionId ? focus.domain : accuracySuggestedDomain(question);
  };
  const pendingAccuracyDomains = () => accuracyPendingDomains(current());
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
  const [questionLoadingVisible, setQuestionLoadingVisible] = createSignal(false);
  const [questionError, setQuestionError] = createSignal("");
  const [questionRetry, setQuestionRetry] = createSignal(0);
  let questionReadVersion = 0;
  const questionRequests = createImportQuestionRequests(payload => request("import_question_get", payload));
  let prefetchTimer: ReturnType<typeof setTimeout> | undefined;
  let prefetchRead: Promise<void> | undefined;
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
  const annotationCount = () => accuracyRecord() ? 0 : record()?.annotationQuestionIds?.length || 0;
  const annotationBlocked = () => Boolean(busy()) || dirty() || editingDirty() || publishFrozen() || Boolean(activeJob());
  const annotationCurrent = () => Boolean(annotationAction()
    && importAnnotationPlanCurrent(annotationAction()!, record(), recordDetailVersion));
  const triage = createMemo(() => importTriage({ ...record(), questions: questions() }, reviewEligibility(), teachingControls(), activeJob()?.mode === "teaching_retry" ? activeJob().targetQuestionIds || [] : [], teachingActions(), dirty()));
  const currentTriage = createMemo(() => triage().rows.find(row => row.questionId === selectedQuestionId()));
  const reviewGroups = createMemo(() => groupReviewIssues(currentTriage()?.issues || []));
  const teachingStatus = createMemo(() => importTeachingStatus(current(), { triage: currentTriage() }));
  const teachingPanels = createMemo(() => teachingIssuePresentation(currentTriage()?.issues || []));
  const teachingStatusLabel = () => teachingStatusTitle(current(), teachingStatus(), teachingPanels());
  const teachingCanEdit = (path: string) => Boolean(!current()?.accuracy && teachingControls()[current()?.questionId]?.canPatch
    && teachingControls()[current()?.questionId]?.editableFields?.some(field => field.path === path)
    && !busy() && !activeJob() && !publishFrozen() && !dirty());
  const reviewProblemGroups = createMemo(() => reviewGroups().filter(group => !group.members.every(issue => issue.id === "source:not-reviewed") && !isReviewOutcomeGroup(group)));
  const reviewSummary = createMemo(() => importReviewSummary(triage().rows, reviewEligibility()));
  let reviewQuestionIdentity = "";
  createEffect(() => {
    const identity = `${record()?.importId}|${current()?.questionId}|${triageFilter()}`;
    if (identity === reviewQuestionIdentity) return;
    reviewQuestionIdentity = identity;
    const row = currentTriage();
    const domain = ["source_pending", "source_ready"].includes(triageFilter()) ? "source" : row && sourceReviewState(row) === "pending" ? "source" : row && isTeachingPending(row) ? "teaching" : "source";
    setReviewDomain(domain);
    const target = reviewProblemGroups().flatMap(group => group.locatableIssues).find(issue => issue.domain === domain);
    setDetailTab(domain === "teaching" && teachingFieldPanel(target?.target?.fieldPath) === "assessment" ? "assessment" : "solution");
    setIssuesVisible(!accuracyRecord() && reviewProblemGroups().some(group => !group.locatableIssues.length));
    if (target) requestAnimationFrame(() => {
      if (`${record()?.importId}|${current()?.questionId}|${triageFilter()}` === identity && preview() && !teachingEditorOpen() && !sourceEditorOpen()) locateIssue(target);
    });
  });
  const currentCorrection = (group: ReviewIssueGroup) => sourceCorrectionForGroup(group, sourceCorrectionDisplays()[current()?.questionId] || [], dirty());
  const sourceCorrectionLabel = createMemo(() => reviewProblemGroups().filter(group => group.domain === "source")
    .some(group => currentCorrection(group)?.kind === "transcription_adjustment") ? "转录已调整，待确认" : "已修正，待确认");
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
    const state = sourceReviewState(row);
    if (state === "published") return isTeachingPending(row) ? "已入库 · AI待办" : "已入库";
    if (state === "duplicate") return "重复题";
    if (state === "rejected") return "未采用";
    const accuracy = accuracyStatus(row.question);
    if (accuracy) {
      if (["ready", "reviewed"].includes(accuracy.kind)) return "";
      const text = accuracy.reason || accuracy.label || "";
      return text.length > 8 ? text.slice(0, 8) : text;
    }
    const substantive = row.issues.filter(issue => issue.id !== "source:not-reviewed");
    if (!substantive.length) return "";
    const first = groupReviewIssues([substantive.find(issue => issue.domain === "source") || substantive[0]])[0];
    const correction = sourceCorrectionForGroup(first, sourceCorrectionDisplays()[row.questionId] || [], dirty());
    if (correction) return correction.kind === "ocr_transcription" ? "已修正" : "转录已调整";
    if (first.domain === "teaching") {
      const panels = teachingIssuePresentation(row.issues);
      const state = importTeachingStatus(row.question, { triage: row });
      const title = teachingStatusTitle(row.question, state, panels);
      if (["generation_failed", "review_failed"].includes(state.kind)) return title;
      if (title === "考查信息待核对") return title;
    }
    const title = first.title;
    if (title) {
      if (title.startsWith("检查术语“")) return "术语提示";
      if (title.length > 8) return title.slice(0, 8);
      return title;
    }
    return "待核对";
  }
  function TeachingStatusActions() {
    return <Show when={!current()?.accuracy}><div class="import-teaching-state-actions">
      <Show when={teachingStatus().actionHint === "retry_generation" && teachingActions()[current()?.questionId]?.canRetryGeneration}>
        <button class="secondary" disabled={Boolean(busy()) || Boolean(activeJob()) || dirty() || editingDirty() || publishFrozen()} onClick={() => askQuestionAction("retry")}><RotateCcw size={15} />重试本题解析</button>
      </Show>
      <Show when={teachingStatus().actionHint === "continue_workflow" && canContinueTeaching()}>
        <button class="secondary" title="继续本卷尚未执行的生成或复核；已经完成的题目不会重新处理。" disabled={Boolean(busy()) || Boolean(activeJob()) || dirty() || editingDirty() || publishFrozen() || !configured()} onClick={() => { if (!prepareAttempt) prepareId = operationId(); void parse(true); }}><RotateCcw size={15} />继续本卷未完成处理</button>
      </Show>
    </div></Show>;
  }
  const groupLocations = (group: ReviewIssueGroup) => group.locatableIssues.filter((issue, index, issues) =>
    issues.findIndex(other => other.target?.fieldPath === issue.target?.fieldPath) === index);
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
  const visibleTriage = createMemo(() => reviewRowsForFilter(triage().rows, triageFilter(), reviewEligibility()));
  const canShowOriginal = () => Boolean(record()?.ocrSource || record()?.renderedPdf || record()?.source?.extension === "pdf");
  const otherQuestionEdits = createMemo(() => dirty() && questions().some(item => item.questionId !== current()?.questionId
    && JSON.stringify(item) !== JSON.stringify((record()?.questions || []).find((old: any) => old.questionId === item.questionId))));
  function changeFilter(value: ImportReviewPrimaryFilter) {
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
    if (editingDirty()) setLeaveAction(() => action);
    else action();
  }
  function selectQuestion(id: string) {
    guardNavigation(() => { document.querySelectorAll(".import-field-highlight").forEach(el => el.classList.remove("import-field-highlight")); setSelected(questions().findIndex(q => q.questionId === id)); setPreview(true); setDetailTab("solution"); setEditTeachingField(""); setEditTeachingRequest(0); setFocusedIssue(""); setLocationNotice(""); requestAnimationFrame(() => { const pane = document.querySelector<HTMLElement>(".import-reading-pane"); if (pane) pane.scrollTop = 0; const decision = document.querySelector<HTMLElement>(".import-review-body"); if (decision) decision.scrollTop = 0; }); });
  }
  function nextTodo() {
    const task = accuracyRecord() ? "source_pending" : reviewDomain() === "teaching" ? "teaching" : "source_pending";
    const next = nextReviewQuestion(triage().rows, current()?.questionId, task);
    if (next) guardNavigation(() => { if (!visibleTriage().some(row=>row.questionId === next)) setTriageFilter(task === "teaching" ? "all" : "source_pending"); selectQuestion(next); });
    else setNotice(accuracyRecord() ? "没有其他待处理题；本题尚未解决的事项仍保留，可查看可入库题。" : task === "teaching" ? "没有其他AI内容待办；本题未解决的问题仍保留。" : "没有其他原题待核对；可查看可入库题，AI内容待办另行保留。");
  }
  function scrollReadingTarget(target: HTMLElement, includeTabs = true) {
    const pane = target.closest<HTMLElement>(".import-reading-pane");
    if (!pane) return;
    const headingHeight = pane.querySelector<HTMLElement>(".import-question-heading")?.getBoundingClientRect().height || 0;
    const tabsHeight = includeTabs ? pane.querySelector<HTMLElement>(".import-reading-tabs")?.getBoundingClientRect().height || 0 : 0;
    pane.scrollTo({ top: pane.scrollTop + target.getBoundingClientRect().top - pane.getBoundingClientRect().top - headingHeight - tabsHeight - 12, behavior: "instant" });
  }
  function focusAccuracyDomain(domain: AccuracyDomain, reveal = true) {
    if (!current()?.accuracy) return;
    setAccuracyFocus({ questionId: current().questionId, domain });
    if (reviewView() === "image") setReviewView("split");
    if (reveal) requestAnimationFrame(() => {
      const selector = domain === "source" ? ".import-source-reading" : `[data-reading-section="${domain === "math" ? "solution" : "assessment"}"]`;
      const target = document.querySelector<HTMLElement>(selector);
      if (target) scrollReadingTarget(target, domain !== "source");
    });
  }
  function selectReadingTab(tab: ImportReadingTab) {
    if (reviewView() === "image") setReviewView("split");
    if (current()?.accuracy) focusAccuracyDomain(tab === "solution" ? "math" : "teaching", false);
    else setDetailTab(tab);
  }
  function showPublicationConditions() {
    if (reviewView() === "image") setReviewView("split");
    requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(".import-accuracy-status");
      if (target) scrollReadingTarget(target);
    });
  }
  function observeQuestionHeading(element: HTMLElement) {
    const update = () => element.parentElement?.style.setProperty("--import-question-heading-height", `${element.getBoundingClientRect().height}px`);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  }
  function beginAccuracyAction(kind: "review" | "repair") {
    if (!current()?.accuracy || busy() || activeJob() || publishFrozen() || dirty() || editingDirty()) return;
    const domain = accuracyDomain();
    focusAccuracyDomain(domain);
    beginAccuracyStatusAction(accuracySession(record().importId, current().questionId), current(), record().importId, record().revision, kind, domain);
  }
  function locateIssue(issue: TriageIssue) {
    setReviewDomain(issue.domain);
    if (reviewView() === "image") setReviewView("split");
    if (issue.domain === "teaching") setDetailTab(teachingFieldPanel(issue.target?.fieldPath) === "assessment" ? "assessment" : "solution");
    setFocusedIssue(issue.id);
    const questionId = current()?.questionId;
    requestAnimationFrame(() => {
      if (current()?.questionId !== questionId) return;
      const target = issue.target;
      if (!target || issue.location === "unavailable") { setIssuesVisible(true); setLocationNotice("请按完整字段核对。"); return; }
      const fields = Array.from(document.querySelectorAll<HTMLElement>("[data-import-field]"));
      const element = fields.find(el => el.dataset.importField === `${issue.domain}:${target.fieldPath}`);
      if (!element) { setLocationNotice("当前内容无法定位到原句段，请查看完整字段。"); return; }
      for (let parent = element.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
      document.querySelectorAll(".import-field-highlight").forEach(el => el.classList.remove("import-field-highlight"));
      element.classList.add("import-field-highlight");
      const mark = Array.from(element.querySelectorAll<HTMLElement>("[data-review-issue-ids]"))
        .find(item => item.dataset.reviewIssueIds?.split(" ").includes(issue.id));
      const anchor = mark || element;
      scrollReadingTarget(anchor, issue.domain === "teaching");
      anchor.focus({ preventScroll: true });
      // Rich text contains math nodes. Highlight the exact, version-bound field,
      // never a guessed DOM substring which could split an equation.
      setLocationNotice("");
    });
  }
  function openTeachingEditor(fieldPath = "") {
    if (sourceEditorOpen() || sourceFieldEdit()) return;
    setReviewDomain("teaching");
    setPreview(true);
    if (fieldPath) setDetailTab(teachingFieldPanel(fieldPath) || "solution");
    setEditTeachingField(fieldPath);
    setEditTeachingRequest(value => value + 1);
  }
  const sourceFieldIdentity = () => JSON.stringify([record()?.importId, current()?.questionId, recordDetailVersion]);
  const sourceCanEdit = (path: string) => Boolean(current() && readImportSourceField(current(), path) !== null
    && !published(current()) && !busy() && !activeJob() && !publishFrozen() && !dirty() && !teachingDirty() && !sourceEditorOpen());
  let sourceEditRequest = 0;
  function openSourceFieldEditor(fieldPath: string) {
    if (sourceFieldEdit() || sourceEditorOpen()) return;
    if (!sourceCanEdit(fieldPath)) {
      if (dirty() || teachingDirty()) setError("请先保存或撤销当前编辑，再修改其他字段。");
      return;
    }
    const question = clone(current());
    const oldText = readImportSourceField(question, fieldPath);
    if (oldText === null) return;
    setReviewDomain("source");
    setSourceFieldEdit({ importId: record().importId, revision: editBaseRevision() ?? record().revision, question, presentation: clone(previewQuestion(question)),
      request: { id: ++sourceEditRequest, identity: sourceFieldIdentity(), fieldPath,
        label: reviewFieldLabel(fieldPath, "source"), oldText } });
  }
  async function saveSourceField(newText: string) {
    const snapshot = sourceFieldEdit();
    if (!snapshot || snapshot.request.identity !== sourceFieldIdentity()) throw new Error("本题版本已变化，输入已保留，请重新读取后核对。");
    if (busy() || activeJob() || publishFrozen() || dirty() || teachingDirty() || published(current())) throw new Error("请先完成当前操作，再保存原文字段。");
    const question = replaceImportSourceField(snapshot.question, snapshot.request.fieldPath, snapshot.request.oldText, newText);
    question.reviewDecision = "pending";
    working("保存原文修改…");
    try {
      const result = await request("import_question_review_save", stable("save-source-field", {
        importId: snapshot.importId, expectedRevision: snapshot.revision, questionId: question.questionId,
        question, responseScope: "question",
      }));
      if (!alive) return;
      applyResponse(result);
      setNotice("原题修改已保存，尚未确认或入库。");
      await loadHistory();
    } finally { if (alive) working(""); }
  }
  function openSourceAdvancedEditor(fieldPath = "stem") {
    if (current()?.accuracy) return;
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
  async function confirmCurrentSource() {
    if (busy() || activeJob() || editingDirty() || publishFrozen() || !current()) return;
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
      const nextId = nextReviewQuestion(nextRows, selectedId, "source_pending");
      if (nextId) {
        const nextIndex = questions().findIndex(q => q.questionId === nextId);
        if (nextIndex >= 0) { if (!visibleTriage().some(row=>row.questionId === nextId)) setTriageFilter("source_pending"); selectQuestion(nextId); }
        setNotice("原题已确认，已进入下一道原题待核对题；尚未入库。");
      } else setNotice(nextRows.find(row => row.questionId === selectedId)?.needsAction
        ? "原题已核对保存；本题解析仍有待处理项，尚未采用。" : "原题已核对保存，暂无其他待处理题；可从页头批量入库。");
      void loadHistory();
    } catch (failure: any) { if (alive) setError(failure.message || "本题确认未保存，请重试。"); }
    finally { if (alive) working(""); }
  }
  async function quickConfirmCurrentSource() {
    if (busy() || activeJob() || editingDirty() || publishFrozen() || !current() || current().accuracy
      || !currentTriage() || sourceReviewState(currentTriage()!) !== "pending" || activeIssues().length || otherQuestionEdits()) return;
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
    setAnnotationAction(null);
    setOpeningImportId(null);
    setEditTeachingRequest(0); setEditTeachingField("");
    const id = record()?.importId;
    ++openVersion;
    resetQuestionReads();
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
  const pendingApprove = () => triage().rows.filter(row => sourceReviewState(row) === "eligible").map(row => row.question);
  const needsOpinion = (item: any) => !published(item) && reviewEligibility()[item.questionId]?.eligible !== true;
  const reviewStateLabel = (item: any) => published(item) ? "已入库" : reviewEligibility()[item.questionId]?.eligible ? "可入库" : (item.teachingWorkflow && item.teachingWorkflow.status !== "ready_candidate") || item.modelReview?.status === "needs_review" || item.modelReview?.status === "blocked" ? "需处理" : item.modelReview?.status === "stale" ? "需重新检查" : item.modelReview?.status === "failed" ? "检查未完成" : item.reviewDecision === "approve" ? "已人工核对" : "待检查";
  const canRecheck = () => !accuracyRecord() && !activeJob() && questions().some(item => !published(item) && (dirty() || !item.modelReview || ["stale", "failed"].includes(item.modelReview.status)));
  const canContinueTeaching = () => !accuracyRecord() && record()?.status === "pending_review" && !record()?.publishedQuestionIds?.length && questions().some(hasUnstartedTeaching);
  const canContinueAccuracy = () => accuracyRecord() && record()?.status === "pending_review" && questions().some(item => !published(item)
    && (["source", "math", "teaching"] as const).some(domain => !["ready", "reviewed"].includes(accuracyStatus(item, domain)?.kind || "pending")));
  const confidenceLabel = (value: string) => ({high:"高",medium:"中",low:"低"}[value] || "未给出");
  const published = (question: any) =>
    question?.status === "published" ||
    (record()?.publishedQuestionIds || []).includes(question?.questionId);
  const reviewComplete = (question: any) =>
    requiredReviewChecks(question).every(
      (key) => question.reviewChecks?.[key] === true,
    ) && Boolean(question.reviewBasis?.trim());
  const activeIssues = () => [...new Set(
    [...sourceConfirmationContentIssues(current()), ...(record()?.sourceIssues || []).filter((issue: any) =>
      issue?.blocking !== false && (!Number(issue?.page) || (current()?.pages || []).includes(Number(issue.page)))),
      ...(current()?.reviewIssues || []).filter((issue: any) => issue?.blocking !== false),
      ...(reviewEligibility()[current()?.questionId]?.sourceMaterialFindings || [])]
      .map(message).filter(Boolean),
  )];
  onCleanup(() => {
    importRefresh.dispose();
    importUnlisten?.();
    clearTimeout(prefetchTimer);
    questionRequests.clear();
    ++questionReadVersion;
    ++jobPollVersion;
    alive = false;
    ++configVersion;
    ++openVersion;
    ++historyVersion;
  });
  onMount(() => {
    const warnUnsaved = (event: BeforeUnloadEvent) => {
      if (dirty() || editingDirty()) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warnUnsaved);
    onCleanup(() => window.removeEventListener("beforeunload", warnUnsaved));
    const closeTools = (event: PointerEvent) => { if (!recordToolsElement?.contains(event.target as Node)) setRecordToolsOpen(false); };
    const escapeTools = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (recordToolsOpen()) { setRecordToolsOpen(false); recordToolsButton?.focus({ preventScroll: true }); return; }
        if (issuesVisible()) { setIssuesVisible(false); return; }
      }
    };
    document.addEventListener("pointerdown", closeTools);
    document.addEventListener("keydown", escapeTools);
    onCleanup(() => { document.removeEventListener("pointerdown", closeTools); document.removeEventListener("keydown", escapeTools); });
    const handleShortcuts = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || props.visible === false || document.querySelector(".import-accuracy-dialog") || annotationAction() || teachingEditorOpen() || sourceEditorOpen()
        || confirmPublish() || questionAction() || originalPreview() || leaveAction()) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input,textarea,select,[contenteditable=true]")) return;
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        if (!current()?.accuracy && preview() && currentTriage() && sourceReviewState(currentTriage()!) === "pending"
          && !dirty() && !activeIssues().length && !otherQuestionEdits() && !busy() && !activeJob() && !publishFrozen() && !editingDirty()) {
          event.preventDefault(); void quickConfirmCurrentSource();
        }
        return;
      }
      if (event.altKey && (event.key === "e" || event.key === "E")) {
        event.preventDefault();
        if (preview()) openSourceAdvancedEditor(); else guardNavigation(() => setPreview(true));
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
    // Read the current strategy once, without subscribing configuration reads
    // to every question-detail merge or neighbour prefetch in this record.
    untrack(() => { void checkConfiguration(false); });
  });
  createEffect(() =>
    props.onBusy(Boolean(busy()) || publishFrozen()),
  );
  async function checkConfiguration(requireOcr: boolean, resumeTeaching = false, newPipeline = !record() || accuracyRecord()) {
    const own = ++configVersion;
    setChecking(true);
    try {
      const [modelResult, ocrResult] = await Promise.allSettled([request("model_get"), request("ocr_get")]);
      const model = modelResult.status === "fulfilled" ? modelResult.value : null;
      const ocr = ocrResult.status === "fulfilled" ? ocrResult.value : null;
      const accuracyReady = accuracyModelReadiness(model);
      const modelReady = newPipeline ? accuracyReady.configured : importModelReady(model, resumeTeaching);
      if (alive && own === configVersion) {
        const ready = importModelReadiness(model);
        setImportConfigured(ready.configured);
        setAccuracyConfigured(accuracyReady.configured);
        setMissingAccuracyRoles(accuracyReady.missing);
        setUploadDestinations(uploadModelDestinations(model));
        setOcrDestination(uploadOcrDestination(ocr));
        setSourceConfigured(ready.sourceConfigured);
        setTeachingConfigured(ready.teachingConfigured);
        setActiveConfigured(ready.activeConfigured);
        setModelWarning(model?.warning || "");
        setOcrConfigured(ocr?.configured === true);
        setOcrWarning(ocr?.warning || "");
        setConfigurationTarget(!modelReady ? "models" : requireOcr && ocr?.configured !== true ? "ocr" : null);
        if (modelResult.status === "rejected") setError(modelResult.reason?.message || "模型设置读取失败，请重试。");
        else if (requireOcr && ocrResult.status === "rejected") setError(ocrResult.reason?.message || "试卷识别设置读取失败，请重试。");
      }
      return modelReady && (!requireOcr || ocr?.configured === true);
    } catch (failure: any) {
      if (alive && own === configVersion) {
        setImportConfigured(false);
        setAccuracyConfigured(false);
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
  async function loadHistory(page = requestedHistoryPage) {
    if (page !== historyPage()) cancelOpeningImport();
    requestedHistoryPage = page;
    const own = ++historyVersion;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const result = await request("imports_list", { page, pageSize: HISTORY_PAGE_SIZE });
      if (alive && own === historyVersion) {
        requestedHistoryPage = result.page;
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
    if (props.visible !== false && pendingDetailRefresh() && !dirty() && !editingDirty() && !busy() && !publishFrozen()) {
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
      if (id && props.visible !== false && !dirty() && !editingDirty() && !busy() && !publishFrozen()) {
        const baseline = record(), knownDetailVersion = recordDetailVersion, opening = openVersion;
        const detail = await request("import_summary_get", { importId: id, ...(knownDetailVersion ? { knownDetailVersion } : {}) });
        if (alive && own === jobPollVersion && opening === openVersion && record()?.importId === baseline.importId && recordDetailVersion === knownDetailVersion && !dirty() && !editingDirty() && !busy() && !publishFrozen() &&
          !detail.notModified && detail.summary) applyResponse(detail);
        else if (alive && !detail.notModified && (dirty() || editingDirty() || busy() || publishFrozen())) setPendingDetailRefresh(true);
      } else if (id) setPendingDetailRefresh(true);
    } catch (failure: any) {
      if (alive && own === jobPollVersion) setJobError(failure.message || "导入进度暂未读取，原任务仍在后台处理。");
    }
  }
  function working(text: string) {
    if (text) cancelOpeningImport();
    setBusy(text);
  }
  function cancelOpeningImport() {
    if (!openingImportId()) return;
    ++openVersion;
    setOpeningImportId(null);
  }
  createEffect(() => { if (props.visible === false || editingDirty()) cancelOpeningImport(); });
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
    if (props.visible !== false && selectedEntry && !hasImportQuestionDetail(selectedEntry) && !busy() && !editingDirty()) {
      void untrack(() => loadQuestionDetail(selectedEntry.questionId));
    } else if (hasImportQuestionDetail(selectedEntry)) {
      setQuestionLoading(false); setQuestionError("");
    }
  });
  createEffect(() => {
    setQuestionLoadingVisible(false);
    if (!questionLoading()) return;
    const timer = setTimeout(() => setQuestionLoadingVisible(true), 180);
    onCleanup(() => clearTimeout(timer));
  });
  function cacheQuestionDetail(result: any, version: string, questionId: string) {
    if (recordDetailVersion !== version) return;
    const merged = mergeImportQuestionDetail(record(), questions(), version, result, questionId);
    if (!merged) return;
    batch(() => {
      setRecord(merged.record); setQuestions(merged.questions);
      setTeachingControls(values => ({ ...values, [questionId]: result.teachingControls?.[questionId] }));
      setTeachingActions(values => ({ ...values, [questionId]: result.teachingActions?.[questionId] }));
      setSourceCorrectionDisplays(values => ({ ...values, [questionId]: result.sourceCorrectionDisplays?.[questionId] || [] }));
    });
  }
  function resetQuestionReads() {
    ++questionReadVersion;
    clearTimeout(prefetchTimer);
    questionRequests.clear();
    prefetchRead = undefined;
    setQuestionLoading(false); setQuestionError("");
  }
  async function loadQuestionDetail(questionId: string) {
    const importId = record()?.importId, version = recordDetailVersion, opening = openVersion, own = ++questionReadVersion;
    if (!importId || !version) return;
    setQuestionLoading(true); setQuestionError("");
    try {
      const result = await questionRequests.get(importId, version, questionId);
      if (!alive || opening !== openVersion || record()?.importId !== importId || recordDetailVersion !== version) return;
      // Cache a late response as well: it must not change the currently selected
      // question or touch that question's source/teaching draft.
      cacheQuestionDetail(result, version, questionId);
    } catch (failure: any) {
      if (alive && own === questionReadVersion && opening === openVersion && record()?.importId === importId
        && recordDetailVersion === version && selectedQuestionId() === questionId) {
        if (failure.code === "revision_conflict" && !dirty() && !editingDirty()) setPendingDetailRefresh(true);
        else setQuestionError(failure.message || "本题详情未读取，已保存进度和未保存编辑均保留。");
      }
    } finally { if (alive && own === questionReadVersion) setQuestionLoading(false); }
  }
  function scheduleQuestionPrefetch(questionId?: string, delay = 120) {
    if (questionId && hasImportQuestionDetail(record()?.questions.find((question: any) => question.questionId === questionId))) return;
    clearTimeout(prefetchTimer);
    if (!questionId) return;
    const opening = openVersion, importId = record()?.importId, version = recordDetailVersion;
    prefetchTimer = setTimeout(() => {
      if (!alive || opening !== openVersion || record()?.importId !== importId || recordDetailVersion !== version
        || !version || props.visible === false || busy() || activeJob() || publishFrozen() || editingDirty() || !preview() || !current()) return;
      const entry = record()?.questions.find((question: any) => question.questionId === questionId);
      if (!entry || hasImportQuestionDetail(entry) || prefetchRead) return;
      const read = (async () => {
        try {
          const result = await questionRequests.get(importId, version, questionId);
          if (alive && opening === openVersion && record()?.importId === importId && recordDetailVersion === version)
            cacheQuestionDetail(result, version, questionId);
        } catch (failure: any) {
          // Prefetch is optional and never retries a failed read in a loop.
          if (alive && opening === openVersion && recordDetailVersion === version && failure.code === "revision_conflict") setPendingDetailRefresh(true);
        }
      })();
      prefetchRead = read;
      void read.finally(() => { if (prefetchRead === read) prefetchRead = undefined; });
    }, delay);
  }
  createEffect(() => {
    const rows = visibleTriage(), id = selectedQuestionId(), baseline = record();
    const index = rows.findIndex(row => row.questionId === id);
    const next = [rows[index + 1]?.questionId, rows[index - 1]?.questionId]
      .find(questionId => questionId && !hasImportQuestionDetail(baseline?.questions.find((q: any) => q.questionId === questionId)));
    if (props.visible !== false && current() && preview() && !busy() && !activeJob() && !editingDirty() && !publishFrozen())
      untrack(() => scheduleQuestionPrefetch(next));
    else clearTimeout(prefetchTimer);
  });
  function apply(value: any, detail?: ImportDiagnostic, eligibility?: Record<string, any>, controls?: Record<string, TeachingReviewControls>, actions?: Record<string, any>, sourceDisplays?: Record<string, SourceCorrectionDisplay[]>, detailVersion?: string) {
    const opening = record()?.importId !== value.importId;
    if (opening) {
      const rows = importTriage(value, eligibility, controls, [], actions).rows;
      const sourceFirst = rows.findIndex(row => sourceReviewState(row) === "pending");
      const teachingFirst = rows.findIndex(isTeachingPending);
      const first = sourceFirst >= 0 ? sourceFirst : teachingFirst;
      setTriageFilter(sourceFirst >= 0 ? "source_pending" : "all");
      setFocusedIssue(""); setLocationNotice("");
      props.onFocusReview?.();
      setOriginalPreview(false);
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
    if (editingDirty()) { guardNavigation(() => { void open(importId); }); return; }
    if (openingImportId() === importId) return;
    if (publishFrozen()) {
      setError("请先完成待确认的入库操作。");
      return;
    }
    rememberEdits();
    setAnnotationAction(null);
    setEditTeachingRequest(0); setEditTeachingField("");
    const own = ++openVersion;
    resetQuestionReads(); // Reopen must re-read independently changing bank bindings.
    setError("");
    setOpeningImportId(importId);
    try {
      const result = await request("import_summary_get", { importId });
      if (alive && own === openVersion && props.visible !== false && !busy() && !editingDirty() && !publishFrozen()) {
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
      if (alive && own === openVersion) {
        setError(failure.message || "导入记录未打开，请重试；当前内容已保留。");
        if (record() && !current()) setQuestionRetry(value => value + 1);
      }
    } finally {
      if (alive && own === openVersion) setOpeningImportId(null);
    }
  }
  async function pick(kind: "document" | "text") {
    if (busy() || checking()) return;
    cancelOpeningImport();
    if (dirty() || publishFrozen()) {
      setError("请先保存当前审核，或完成待确认的入库操作。");
      return;
    }
    setError("");
    if (!(await checkConfiguration(kind === "document", false, true))) return;
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
    if (!accuracyConfigured() || !chosen) return;
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
    ++openVersion;
    resetQuestionReads();
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
    // File selection is local. Only the explicit start button may send it to configured services.
  }
  async function parse(retry = false) {
    if (dirty() || publishFrozen()) {
      setError("请先保存当前审核，或完成待确认的入库操作。");
      return;
    }
    const extension = retry ? record()?.source?.extension || record()?.filename?.split(".").pop() : file()?.name.split(".").pop();
    const resumeTeaching = retry && Boolean(record()?.questions?.length);
    const startAction = accuracyImportAction(record(), retry);
    const newPipeline = startAction === "import_accuracy_start";
    const needsOcr = /^(pdf|docx)$/i.test(extension || "") && !(retry && record()?.ocrSource);
    if (busy() || !(await checkConfiguration(needsOcr, resumeTeaching, newPipeline))) return;
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
      const result = await request(startAction, { ...prepareAttempt, responseScope: "summary" });
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
      if (result.summary?.error) {
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
    cancelOpeningImport();
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
    if (busy() || !record() || editingDirty()) return false;
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
    if (busy() || editingDirty()) return;
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
  function confirmAnnotation() {
    if (annotationBlocked() || !activeConfigured() || !annotationCount()) return;
    try {
      setAnnotationError("");
      setAnnotationAction(createImportAnnotationPlan(record(), recordDetailVersion));
    } catch (failure: any) { setError(failure.message); }
  }
  async function annotateStructured() {
    const plan = annotationAction();
    if (annotationBlocked() || !activeConfigured() || !plan) return;
    if (!annotationCurrent()) { setAnnotationError("本卷状态已变化，请关闭后重新确认待补范围。"); return; }
    setAnnotationError("");
    working("正在提交考查信息任务…");
    try {
      const result = await request("import_annotation_start", stable("annotation-start", {
        importId: plan.importId,
        expectedRevision: plan.revision,
        responseScope: "summary",
      }));
      if (!alive) return;
      applyResponse(result);
      setAnnotationAction(null);
      if (result.job) {
        jobStates.set(result.job.jobId, result.job.status);
        setJobs(items => [result.job, ...items.filter(job => job.importId !== result.job.importId)]);
        props.onJobsChange?.(jobs());
        void refreshJobs();
      }
      setNotice(["queued", "running"].includes(result.job?.status) ? "正在后台补充考查信息，题面、答案、解析和已有审核不变；可继续其它操作。" : "当前考查信息已处理，已有结果保留。");
      await loadHistory();
    } catch (failure: any) { if (alive) setAnnotationError(failure.message); }
    finally { if (alive) working(""); }
  }
  async function recheckQuestions() {
    if (busy() || editingDirty() || activeJob() || publishFrozen() || !record()) return;
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
    if (dirty() || editingDirty() || activeJob() || busy() || publishFrozen()) { setError("请先保存或撤销当前编辑，并等待后台任务完成。"); return; }
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
    const candidate = accuracyPreviewCandidate(question);
    return {
      // The reading view uses a getter-only Proxy. Retain its complete asset
      // context; an explicit frozen question overrides it for field previews.
      ...current(),
      ...question,
      ...(candidate ? { accuracyCandidate: candidate } : {}),
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
  function CurrentQuestionActions() {
    return <div class="import-current-task">
      <Show when={current()}>
        <Show when={!preview() || dirty()} fallback={<>
          <Show when={!current()?.accuracy && currentTriage() && sourceReviewState(currentTriage()!) === "pending"}>
            <Show when={activeIssues().length}><button type="button" class="text-button" onClick={() => {
              const issue = currentTriage()?.issues.find(issue => issue.domain === "source" && issue.target);
              if (issue) { setIssuesVisible(true); locateIssue(issue); }
              else if (sourceConfirmationContentIssues(current()).length) openSourceAdvancedEditor("stem");
              else setIssuesVisible(true);
            }}>先修正原题问题</button></Show>
            <button type="button" class="primary import-confirm-source" disabled={Boolean(busy()) || Boolean(activeJob()) || editingDirty() || publishFrozen() || otherQuestionEdits() || Boolean(activeIssues().length)}
              onClick={quickConfirmCurrentSource} aria-keyshortcuts="Control+Enter" title={`已对照原卷，确认${sourceConfirmationScopeLabel(current())}；Ctrl+Enter`}><Check size={15} />确认原题并继续</button>
            <details class="import-task-note"><summary>核对备注</summary><div><textarea rows={2} maxLength={3000} value={sourceConfirmationNote()} aria-label="本题核对备注" placeholder="核对备注（选填）" onInput={event => setSourceConfirmationNote(event.currentTarget.value)} /></div></details>
          </Show>
          <Show when={currentTriage() && ["eligible", "published"].includes(sourceReviewState(currentTriage()!))}><span class="import-source-eligibility"><Check size={14} />{published(current()) ? "原题已入库" : current()?.accuracy ? "本次成果具备确认条件" : "原题可入库"}</span></Show>
          <Show when={current()?.accuracy && !published(current()) && !reviewEligibility()[current()?.questionId]?.eligible}>
              <Show when={pendingAccuracyDomains().length && accuracyCanReviewDomain(current(), accuracyDomain())} fallback={<button type="button" class="secondary" onClick={showPublicationConditions}>查看核对与发布条件</button>}>
              <button type="button" class="primary" disabled={Boolean(busy()) || Boolean(activeJob()) || editingDirty() || publishFrozen()}
                onClick={() => beginAccuracyAction("review")}>核对{accuracyDomainLabel(accuracyDomain())}</button>
            </Show>
            <Show when={current()?.accuracy?.canRepair === true && pendingAccuracyDomains().length}><button type="button" class="text-button" disabled={Boolean(busy()) || Boolean(activeJob()) || editingDirty() || publishFrozen()} onClick={() => beginAccuracyAction("repair")}>按问题修订一次</button></Show>
          </Show>
        </>}>
          <button type="button" class="primary" disabled={Boolean(busy()) || !dirty() || publishFrozen()} onClick={save}><Save size={15} />保存修改</button>
          <Show when={!preview()}><button type="button" class="secondary" disabled={Boolean(busy())} onClick={() => setPreview(true)}>预览排版</button></Show>
        </Show>
        <Show when={dirty()}><button type="button" class="text-button" disabled={Boolean(busy()) || publishFrozen()} onClick={() => {
          editBuffers.delete(record().importId); setQuestions(clone(record().questions || [])); setEditBaseRevision(record().revision);
          setDirty(false); setError(""); setPreview(true); setNotice("已撤销未保存修改。"); void open(record().importId);
        }}>撤销修改</button></Show>
      </Show>
    </div>;
  }
  const confirmationContext = createMemo(() => importConfirmationContext({
    record: record(), question: current(), row: currentTriage(), controls: teachingControls()[current()?.questionId],
    eligibility: reviewEligibility()[current()?.questionId], domain: current()?.accuracy ? reviewDomain() : "source", accuracyDomain: accuracyDomain(),
    preview: preview(), dirty: dirty(), otherQuestionEdits: otherQuestionEdits(), busy: busy(),
    activeJob: Boolean(activeJob()), editingDirty: editingDirty(), publicationPending: publishFrozen(),
    sourceBlockers: activeIssues(),
  }));
  function AccuracyQuestionReading(props: { question: any }) {
    const presentation = createMemo(() => previewQuestion(props.question));
    const candidate = () => presentation().accuracyCandidate;
    const difficulty = () => candidate()?.difficultyAssessment || props.question.difficultyAssessment;
    const focus = () => candidate()?.teachingFocus;
    return <article class="import-preview import-question-reading">
      <p class="import-accuracy-remaining" role="status">{reviewEligibility()[props.question.questionId]?.eligible
        ? "本次发布范围已具备确认条件；未采用内容中的疑点继续保留。"
        : pendingAccuracyDomains().length ? `有 ${pendingAccuracyDomains().length} 个域仍有未决事项，请结合本次发布范围处理；无需逐域重复人工确认。` : "各域已完成核对；请查看仍未满足的发布条件。"}</p>
      <section class="import-source-reading" aria-label="原卷题目与参考">
        <p class="import-source-review-status muted">原题 · {accuracyStatus(props.question, "source")?.label}</p>
        <QuestionBody question={presentation()} hideMissingTeacherMaterials number={props.question.sourceLabel} teacher hideSource reviewFieldPrefix="source:"
          renderReviewField={(path, content) => <ImportEditableSourceField path={path} label={reviewFieldLabel(path, "source")} editable={sourceCanEdit(path)}
            issues={currentTriage()?.issues || []} onEdit={openSourceFieldEditor}>{content}</ImportEditableSourceField>} />
      </section>
      <ImportReadingTabs questionKey={props.question.questionId} value={accuracyDomain() === "teaching" ? "assessment" : "solution"}
        onChange={selectReadingTab} statuses={{ solution: accuracyStatus(props.question, "math")?.label,
          assessment: accuracyStatus(props.question, "teaching")?.label }} solution={
      <Show when={candidate()} fallback={<p class="muted">本题尚无AI教学稿，已有原卷参考保留在“原题”中。</p>}>{value => <section class="import-reading-section" data-reading-section="solution">
        <div class="import-reading-section-content" aria-label="AI答案与解析">
          <Show when={value().answer}><p><strong>生成答案：</strong><RichText text={value().answer} question={presentation()} teacher /></p></Show>
          <Show when={value().teachingSolution}><RichText text={value().teachingSolution} question={presentation()} teacher /></Show>
        </div>
      </section>}</Show>} assessment={
      <section class="import-reading-section" data-reading-section="assessment">
        <div class="import-reading-section-content" aria-label="考查信息">
          <dl class="import-reading-facts"><div><dt>难度</dt><dd>{difficultyLevels.find(item => item.id === difficulty()?.level)?.label || "未评估"}<small>内容估计</small></dd></div>
            <div><dt>主考知识点</dt><dd>{accuracyKnowledgeNames(props.question, props.question.primaryKnowledgeUids)}</dd></div>
          </dl>
          <Show when={difficulty()?.basis}><section class="import-assessment-detail"><h4>难度依据</h4><RichText text={difficulty().basis} question={presentation()} teacher /></section></Show>
          <Show when={focus()?.examFocus}><section class="import-assessment-detail"><h4>考查任务</h4><RichText text={focus().examFocus} question={presentation()} teacher /></section></Show>
          <Show when={focus()?.studentRequirements?.length}><section class="import-assessment-detail"><h4>对学生的要求</h4><ul><For each={focus().studentRequirements}>{item => <li><RichText text={item} question={presentation()} teacher /></li>}</For></ul></section></Show>
          <For each={props.question.solutionPaths || []}>{(path, index) => <section class="import-path-reading"><h4>解法 {index() + 1} 所需知识</h4><p>{accuracyKnowledgeNames(props.question, path.requiredKnowledgeUids)}</p>
            <Show when={path.requiredPremises?.length}><p>额外工具或条件：{accuracyPremiseNames(props.question, path.requiredPremises)}</p></Show><RichText text={path.basis} question={presentation()} teacher />
          </section>}</For>
        </div>
      </section>} />
    </article>;
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
        <p class="import-opening-notice" role="status"><LoaderCircle size={15} class="spin" />正在准备导入设置…</p>
      </Show>
      <Show when={!record() && !checking() && (!configured() || configurationTarget() === "models")}>
        <section class="import-gate">
          <FileText size={26} />
          <div>
            <h2>{missingAccuracyRoles().length ? "完成导入配置" : "检查导入模型配置"}</h2>
            <p class="muted">必需模型用途已完成 {6 - missingAccuracyRoles().length}/6。{missingAccuracyRoles().length ? "解析复核仅在按问题修订时使用。" : "请检查上方错误对应的配置；用途齐全不代替服务与材料能力检查。"}</p>
            <Show when={missingAccuracyRoles().length}><p class="muted">还需配置：{missingAccuracyRoles().join("、")}</p></Show>
          </div>
          <button class="primary" onClick={() => props.onConfigure("models", { from: "import", materialKind: fileKind() })}>
            配置模型
          </button>
        </section>
      </Show>
      <Show when={!record() && !checking() && configured() && (!ocrConfigured() || configurationTarget() === "ocr")}>
        <section class="import-gate">
          <FileText size={26} />
          <div><h2>先配置试卷识别</h2><p class="muted">PDF、Word 需配置 PaddleOCR，识别文字、公式和图表。纯文本可直接导入。</p></div>
          <button class="primary" onClick={() => props.onConfigure("ocr", { from: "import", materialKind: fileKind() })}>配置识别服务</button>
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
        </section>
        <Show when={file()}>{chosen => <section class="import-upload-confirmation" aria-label="确认发送试卷">
          <div><h2>{chosen().name}</h2><p class="muted">{chosen().size < 1024 ? `${chosen().size} B` : `${(chosen().size / 1024).toFixed(1)} KB`} · {chosen().name.split(".").pop()?.toUpperCase()}</p></div>
          <p>{chosenFileKind() === "document" ? "开始后，原文件将发送至下方识别服务，识别材料将按用途发送至对应模型服务。" : "开始后，文本内容将按用途发送至下方模型服务；不使用试卷识别服务。"}处理可能产生服务费用，原件和进度会保存在本机。</p>
          <Show when={chosenFileKind() === "document"}><p><strong>试卷识别：</strong>{ocrDestination()}</p></Show>
          <p><strong>模型服务：</strong>{[...new Set(uploadDestinations().map(destination => destination.service))].join("；")}</p>
          <details><summary>查看本次模型配置（6项用途）</summary><dl><For each={uploadDestinations()}>{destination => <div><dt>{destination.role}</dt><dd>{destination.configuration} · {destination.service}</dd></div>}</For></dl></details>
          <div class="import-upload-confirmation-actions"><button type="button" class="secondary" disabled={Boolean(busy())} onClick={() => setFile(null)}>取消选择</button>
            <button type="button" class="primary" disabled={Boolean(busy()) || checking() || !accuracyConfigured() || chosenFileKind() === "document" && !ocrConfigured()} onClick={() => parse()}>开始识别与整理</button></div>
        </section>}</Show>
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
      <Show when={openingImportId() && record()}><p class="import-opening-notice" role="status"><LoaderCircle size={15} class="spin" />正在打开所选试卷…<button class="text-button" onClick={cancelOpeningImport}>取消打开</button></p></Show>
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
        <section class="import-review import-review-modern">
          <ImportReviewHeader title={record().structuredSource?.exam?.title || record().filename} summary={reviewSummary()} filter={triageFilter()} accuracy={accuracyRecord()}
            disabled={Boolean(busy()) || publishFrozen()} onBack={() => guardNavigation(backToHistory)} onFilter={changeFilter}
            headingRef={element => { detailHeading = element; }}
            annotationCount={annotationCount()} annotationDisabled={annotationBlocked() || !activeConfigured()}
            annotationReason={!activeConfigured() ? "请先配置通用模型，再补全本卷考查信息。" : dirty() || editingDirty() ? "请先保存当前编辑，再补全本卷考查信息。" : "调用当前通用模型，仅补全本卷未入库题目缺失的考查信息。"}
            onAnnotation={confirmAnnotation}
            publishDisabled={Boolean(busy()) || dirty() || editingDirty() || !pendingApprove().length || publishFrozen() || Boolean(activeJob())}
            publishPrimary={triageFilter() === "source_ready" || reviewSummary().sourcePending === 0}
            onPublish={() => { setPublishError(""); setConfirmPublish(true); }} tools={<div class="import-record-tools" ref={recordToolsElement}>
                <button class="icon-button secondary" ref={recordToolsButton} aria-label="更多试卷操作" title="更多试卷操作" aria-expanded={recordToolsOpen()} onClick={() => setRecordToolsOpen(value => !value)}><MoreHorizontal size={18} /></button>
                <Show when={recordToolsOpen()}><div class="import-record-tools-menu" role="group" aria-label="更多试卷操作">
                  <Show when={!activeJob() && (canContinueAccuracy() || canContinueTeaching() || ["failed", "cancelled", "processing", "interrupted", "budget_paused"].includes(record().status))}><button disabled={Boolean(busy()) || dirty() || publishFrozen() || !configured()} onClick={() => { setRecordToolsOpen(false); if (!prepareAttempt) prepareId = operationId(); void parse(true); }}>{accuracyRecord() ? "继续未完成处理" : canContinueTeaching() ? "继续处理教学稿" : "重新解析"}</button></Show>
                  <Show when={props.onAssembly}><button disabled={Boolean(busy()) || publishFrozen()} onClick={() => {setRecordToolsOpen(false);guardNavigation(() => props.onAssembly?.());}}><ArrowLeft size={16} />返回组卷</button></Show>
                  <Show when={props.onGuide}><button onClick={() => {setRecordToolsOpen(false);props.onGuide?.();}}><CircleHelp size={16} />导入说明</button></Show>
                  <button disabled={Boolean(busy()) || publishFrozen()} onClick={() => {setRecordToolsOpen(false);guardNavigation(() => {void props.onBank().catch((failure:any)=>setError(failure.message));});}}>题库</button>
                  <Show when={canRecheck()}><button disabled={Boolean(busy()) || publishFrozen() || !sourceConfigured() || editingDirty()} onClick={() => { setRecordToolsOpen(false); recheckQuestions(); }}>重新检查未完成题</button></Show>
                </div></Show>
              </div>} />
          <Show when={activeJob() || (!failureDiagnostic() && !questions().length)}><div class="import-process-strip" role="status" aria-live="polite" aria-label="试卷处理阶段">
            <span class="import-process-stage">{processStage().stateLabel}：<strong>{processStage().label}</strong></span>
            <Show when={activeJob()?.sourceBatchCount > 0}><span class="muted">已保存 {activeJob()?.completedSourceBatches} / {activeJob()?.sourceBatchCount} 批</span></Show>
            <Show when={failureDiagnostic()}><span class="import-failure-category" data-category={failureView().category}>{failureView().categoryLabel}</span></Show>
          </div></Show>
          <Show when={["annotation", "review"].includes(selectedJob()?.mode) && ["interrupted", "cancelled"].includes(selectedJob()?.status)}>
            <p class="warning-text" role="status">{selectedJob()?.message || "考查信息未全部完成，原题和已有结果已保留，可点击补充考查信息重试。"}</p>
          </Show>
          <Show when={failureDiagnostic()}>
            {(detail) => <section class="import-failure import-failure-compact" role="alert" aria-label="导入失败原因">
              <details class="import-failure-disclosure">
                <summary class="import-failure-summary">
                  <div class="import-failure-summary-main">
                    <span class="import-failure-summary-title">
                      <AlertCircle size={17} aria-hidden="true" />
                      <strong>{["annotation", "review", "teaching_retry", "accuracy_repair"].includes(selectedJob()?.mode) ? "本次处理未完成" : "导入未完成"}</strong>
                    </span>
                    <span class="import-failure-summary-reason"><ReviewMessage text={detail().summary} /></span>
                    <Show when={detail().ocrCompleted}>
                      <span class="import-failure-preserved-inline"><Check size={14} aria-hidden="true" />原件与识别材料已保留</span>
                    </Show>
                  </div>
                  <div class="import-failure-summary-actions">
                    <Show when={!activeJob() && (canContinueAccuracy() || canContinueTeaching() || ["failed", "cancelled", "processing", "interrupted", "budget_paused"].includes(record().status))}>
                      <button type="button" class="import-failure-resume-button"
                        disabled={Boolean(busy()) || dirty() || publishFrozen() || !configured()}
                        onClick={(e) => { e.stopPropagation(); if (!prepareAttempt) prepareId = operationId(); void parse(true); }}>
                        {accuracyRecord() ? "继续处理" : canContinueTeaching() ? "继续处理教学稿" : "重新解析"}
                      </button>
                    </Show>
                    <span class="import-failure-toggle">
                      <span class="when-closed">详情</span>
                      <span class="when-open">收起</span>
                      <ChevronDown size={15} aria-hidden="true" />
                    </span>
                  </div>
                </summary>
                <div class="import-failure-body">
                  <div class="import-failure-key-points">
                    <p class="import-failure-next-action">
                      <strong>下一步建议：</strong>{failureView().nextAction}
                    </p>
                    <Show when={(detail().sourceBatchCount || 0) > 0}>
                      <p class="muted">已保存 {detail().completedSourceBatches} / {detail().sourceBatchCount} 批来源转录草稿<Show when={(detail().expectedSourceQuestions || 0) > 0}>（{detail().savedSourceQuestions} / {detail().expectedSourceQuestions} 题）</Show>。整卷尚未完成核验，暂不能作为完整试卷审核入库。</p>
                    </Show>
                    <Show when={detail().failedSourceLabels?.length}>
                      <p class="muted">未完成题目：第 {detail().failedSourceLabels?.join("、")} 题需继续转录。</p>
                    </Show>
                  </div>
                  <details class="import-failure-tech-details">
                    <summary class="muted">技术诊断与排查信息</summary>
                    <dl class="import-failure-tech-grid">
                      <div><dt>失败阶段</dt><dd>{failureView().stage}</dd></div>
                      <div><dt>问题分类</dt><dd><span class="import-failure-category" data-category={failureView().category}>{failureView().categoryLabel}</span><Show when={detail().subcategoryLabel}> · {detail().subcategoryLabel}</Show></dd></div>
                      <Show when={failureView().serviceLabel || failureView().operationLabel}><div><dt>涉及环节</dt><dd>{[failureView().serviceLabel, failureView().operationLabel].filter(Boolean).join(" · ")}</dd></div></Show>
                      <Show when={failureView().causeNote}><div><dt>判断依据</dt><dd>{failureView().causeNote}</dd></div></Show>
                      <Show when={detail().location}><div><dt>错误位置</dt><dd>{detail().location}</dd></div></Show>
                      <Show when={processingError()?.code || detail().attempts > 0}>
                        <div><dt>错误代码</dt><dd>{processingError()?.code || "无"}{detail().attempts > 0 ? (detail().sourceRequestBreakdown ? ` · 模型请求 ${detail().attempts} 次（索引 ${detail().indexCalls} 次，转录 ${detail().transcriptionCalls} 次）` : ` · 模型尝试 ${detail().attempts} 次`) : ""}</dd></div>
                      </Show>
                    </dl>
                  </details>
                </div>
              </details>
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
            <div class="import-review-layout" classList={{"is-queue-collapsed": !queueVisible()}}>
              <nav class="import-question-list" hidden={!queueVisible()} aria-label="待审核题目">
                <header class="import-queue-heading"><strong>题目</strong><span class="muted">{visibleTriage().length} 题</span></header>
                <For each={visibleTriage()}>
                  {(row) => (
                    <button
                      class={selectedQuestionId() === row.questionId ? "current" : ""}
                      aria-current={selectedQuestionId() === row.questionId ? "true" : undefined}
                      data-tone={row.issues.some(issue => issue.id !== "source:not-reviewed") ? row.tone : "neutral"}
                      disabled={Boolean(busy()) || publishFrozen()}
                      onClick={() => selectQuestion(row.questionId)}
                      onPointerEnter={() => scheduleQuestionPrefetch(row.questionId, 50)}
                      onFocus={() => scheduleQuestionPrefetch(row.questionId, 50)}
                    >
                      <span class="import-queue-title">{row.question.sourceLabel || questions().findIndex(q => q.questionId === row.questionId) + 1}. {typeLabels[row.question.questionType] || "题目"}</span>
                      <Show when={queueReason(row)}><span class="import-queue-badge" data-tone={row.tone} title={queueReason(row)}>{queueReason(row)}</span></Show>
                    </button>
                  )}
                </For>
                <Show when={!visibleTriage().length}><p class="muted import-queue-empty">此分类暂无题目。<button class="text-button" onClick={() => setTriageFilter("all")}>查看全部</button></p></Show>
              </nav>
              <div class="import-question-editor">
                <Show when={current()} fallback={<div role="status" aria-busy={questionLoading()} class="import-question-loading"><Show when={questionLoading()} fallback={<><ErrorBanner message={questionError()} /><button class="secondary" onClick={() => setQuestionRetry(n => n + 1)}>重新读取本题</button></>}><Show when={questionLoadingVisible()} fallback={<div class="import-question-skeleton" aria-label="正在读取所选题目"><span /><span /><span /></div>}><Busy label="读取本题详情…" /></Show></Show></div>}>
                  {(_question) => {
                    const question: any = new Proxy(
                      {},
                      { get: (_target, key) => current()?.[key as string] },
                    );
                    return (
                      <>
                        <div class="import-audit-workspace" classList={{"is-issues-open": issuesVisible()}}>
                        <div class="import-reading-workspace" data-review-view={canShowOriginal() ? reviewView() : "text"} data-split-ratio={splitRatio()}>
                          <div class="import-compare-toolbar" role="group" aria-label="题目阅读工具">
                            <div class="import-reading-controls">
                            <button type="button" class="text-button" aria-pressed={queueVisible()} onClick={() => setQueueVisible(value => !value)}><Columns2 size={16} />题目清单</button>
                            <Show when={canShowOriginal()}><div class="import-reading-view-controls">
                              <select aria-label="阅读方式" value={reviewView()} onChange={event => setReviewView(event.currentTarget.value as "image" | "split" | "text")}>
                                <option value="split">并排对照</option><option value="image">原卷</option><option value="text">识别结果</option>
                              </select>
                              <Show when={reviewView() === "split"}><select aria-label="并排分栏比例" value={splitRatio()} onChange={event => setSplitRatio(event.currentTarget.value as "image" | "equal" | "text")}>
                                <option value="image">原图加宽</option><option value="equal">1:1 对等</option><option value="text">排版加宽</option>
                              </select></Show>
                            </div></Show>
                            <button type="button" class="text-button import-problems-toggle" aria-expanded={issuesVisible()} aria-controls="import-question-problems" onClick={() => setIssuesVisible(value => !value)}>
                              <AlertCircle size={16} />本题待办<Show when={reviewProblemGroups().length}><span>{reviewProblemGroups().length}</span></Show>
                            </button>
                            </div>
                            <div class="import-question-actions" role="group" aria-label="本题操作">
                              <CurrentQuestionActions />
                            </div>
                          </div>
                          <ImportConfirmationContext context={confirmationContext()} />
                          <div class="import-comparison-panes">
                            <Show when={canShowOriginal()}>
                              <section class="import-inline-original" hidden={reviewView() === "text"} aria-label="当前题原卷">
                                <Suspense fallback={<Busy label="读取已保存原卷…" />}><SourcePageViewer importId={record().importId} pages={question.pages} question={question} focusRequest={sourceFocusRequest()} onOpenPdf={() => setOriginalPreview(true)} /></Suspense>
                              </section>
                            </Show>
                        <div class="import-reading-pane">
                        <div class="bank-results-heading import-question-heading" ref={observeQuestionHeading}>
                          <div><strong>第 {question.sourceLabel || selected() + 1} 题</strong><small class="muted">{typeTitles[question.questionType] || "题目"}</small></div>
                          <Show when={!question.accuracy}><button type="button" class="text-button" disabled={Boolean(busy()) || published(question) || editingDirty()}
                            onClick={() => preview() ? openSourceAdvancedEditor() : setPreview(true)}>
                            {preview() ? <Pencil size={14} /> : <Eye size={14} />}{preview() ? "高级编辑" : "预览排版"}
                          </button></Show>
                        </div>
                        <Show when={question.annotationError?.message}>
                          <p class="warning-text">考查信息未完成：<ReviewMessage text={question.annotationError.message} />。原题已保留，可重试。</p>
                        </Show>
                        <Show when={question.duplicateCandidates?.length}>
                          <aside class="import-duplicate-notice">
                            <strong>{question.duplicateCandidates.some((item: any) => item.exact) ? "题库中已存在此题" : "可能与已有题目重复"}</strong>
                            <p class="muted">{question.duplicateCandidates.some((item: any) => item.exact) ? "本卷条目仍保留，请继续使用已有题目，避免重复入库。" : "请核对原卷版本及题面；不会自动合并或删除。"}</p>
                            <details><summary>重复记录</summary><For each={question.duplicateCandidates}>{(item: any) => <small>{item.questionId}{item.exact ? " · 已存在" : " · 待核对"}</small>}</For></details>
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
                                published(question) || editingDirty() ||
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
                            </fieldset>
                          }
                        >
                          <Show when={!question.accuracy} fallback={<>
                            <AccuracyQuestionReading question={question} />
                            <ImportAccuracyStatus question={question} importId={record().importId} revision={record().revision}
                              session={accuracySession(record().importId, question.questionId)}
                              disabled={Boolean(busy()) || Boolean(activeJob()) || publishFrozen() || dirty() || editingDirty()}
                              onChange={result => { if ((result.summary?.importId || result.import?.importId) !== record()?.importId) return; applyResponse(result); setAccuracyFocus(null); setNotice("核对进度已保存，尚未解决的事项仍保留。"); void refreshJobs(); void loadHistory(); }} />
                          </>}>
                          <ImportQuestionReading question={question} presentation={previewQuestion(question)} controls={teachingControls()[question.questionId]}
                            issues={(currentTriage()?.issues || []).filter(issue => !reviewProblemGroups().some(group => group.members.includes(issue) && currentCorrection(group)))}
                            tab={detailTab()} onTabChange={selectReadingTab}
                            sourceCanEdit={sourceCanEdit} teachingCanEdit={teachingCanEdit} onEditSource={openSourceFieldEditor} onEditTeaching={openTeachingEditor}
                            onSelectIssue={id => { setIssuesVisible(true); selectMarkedIssue(id); }} knowledgeNames={knowledgeNames} premiseNames={premiseNames} />
                        <TeachingReviewActions question={question} controls={teachingControls()[question.questionId]} hideTrigger
                          disabled={Boolean(busy()) || Boolean(activeJob()) || publishFrozen() || dirty()}
                          disabledReason={dirty() ? "请先保存或撤销当前未保存编辑，再核对教学稿。" : undefined}
                          renderText={text => <RichText text={reviewMessageText(text)} question={previewQuestion(question)} teacher />}
                          onAcknowledge={acknowledgeTeachingIssue} onPatch={patchTeachingField}
                          editRequest={editTeachingRequest()} editFieldPath={editTeachingField()} discardRequest={discardFieldRequest()}
                          onEditRequestHandled={handled => { if (handled === editTeachingRequest()) batch(() => { setEditTeachingRequest(0); setEditTeachingField(""); }); }}
                          onDirtyChange={setTeachingDirty} onOpenChange={setTeachingEditorOpen} />
                          </Show>
                        </Show>
                        </div>
                          </div>
                        </div>
                        <Show when={issuesVisible()}><div class="import-problems-backdrop" aria-hidden="true" onClick={() => setIssuesVisible(false)} /></Show>
                        <aside class="import-question-problems" id="import-question-problems" hidden={!issuesVisible()} aria-label="本题待办">
                          <header><h3>本题待办</h3><button type="button" class="text-button" onClick={() => setIssuesVisible(false)}>收起</button></header>
                          <div class="import-review-body" tabIndex={-1}>
                            <Show when={!question.accuracy} fallback={<Show when={accuracyFindings(question).length} fallback={<p class="muted">当前没有具体疑点；仍须按各域的实际状态完成核对。</p>}>
                              <For each={accuracyFindings(question)}>{finding => <section class="import-review-context"><p><strong>{accuracyDomainLabel(finding.domain)}<Show when={accuracyFieldLabel(finding.fieldPath)}> · {accuracyFieldLabel(finding.fieldPath)}</Show></strong></p>
                                <RichText text={reviewMessageText(finding.message)} question={previewQuestion(question)} teacher /><Show when={finding.basis}><p>核对依据：</p><RichText text={reviewMessageText(finding.basis)} question={previewQuestion(question)} teacher /></Show>
                              </section>}</For>
                            </Show>}>
                            <Show when={activeJob()}><p class="muted" role="status">后台处理中，完成后可保存。</p></Show>
                            <Show when={reviewProblemGroups().length} fallback={<p class="muted">本题没有额外疑点。原题确认与入库分别进行。</p>}>
                              <ol class="import-review-problems" aria-label="需要核对的事项" tabIndex={-1}>
                                <For each={reviewProblemGroups()}>{group => <li class="import-review-problem" data-review-member-ids={group.members.map(issue => issue.id).join(" ")} data-tone={group.tone} data-active={group.members.some(issue => issue.id === focusedIssue())}>
                                  <small class="muted">{group.domain === "source" ? "原题" : "AI内容"}</small>
                                  <strong><ReviewMessage text={currentCorrection(group) ? sourceCorrectionLabel() : group.title} /></strong>
                                  <Show when={currentCorrection(group)}>{correction => <><RichText text={correction().basis} /><button type="button" class="text-button" onClick={() => viewCorrection(group)}><LinkIcon size={14} />查看修正处</button></>}</Show>
                                  <Show when={!currentCorrection(group) && !group.locatableIssues.length}><RichText text={reviewMessageText(teachingDisplayText(reviewDisplayMessage(group.message)))} /></Show>
                                  <For each={groupLocations(group)}>{issue => <div class="import-problem-field-actions">
                                    <button type="button" class="text-button" onClick={() => locateIssue(issue)}><LinkIcon size={14} />{reviewFieldLabel(issue.target?.fieldPath, issue.domain)}</button>
                                    <Show when={issue.domain === "source" && sourceCanEdit(issue.target?.fieldPath || "")}><button type="button" class="text-button" onClick={() => openSourceFieldEditor(issue.target!.fieldPath)}><Pencil size={14} />修改</button></Show>
                                    <Show when={issue.domain === "teaching" && teachingCanEdit(issue.target?.fieldPath || "")}><button type="button" class="text-button" onClick={() => openTeachingEditor(issue.target?.fieldPath)}><Pencil size={14} />修改</button></Show>
                                  </div>}</For>
                                </li>}</For>
                              </ol>
                            </Show>
                            <Show when={locationNotice()}><p class="muted" role="status">{locationNotice()}</p></Show>
                            <Show when={!question.accuracy && (teachingControls()[question.questionId]?.canPatch || teachingActions()[question.questionId]?.canRetryGeneration
                              || canContinueTeaching() || teachingActions()[question.questionId]?.canPublishTeaching || teachingActions()[question.questionId]?.canResumeTeachingPublication)}>
                              <details class="import-opinion-details import-teaching-operation-details"><summary>教学内容处理</summary>
                                <TeachingStatusActions />
                                <Show when={teachingControls()[question.questionId]?.canPatch}><button type="button" class="secondary" disabled={Boolean(busy()) || Boolean(activeJob()) || publishFrozen() || dirty() || editingDirty()}
                                  onClick={() => openTeachingEditor(reviewProblemGroups().flatMap(group=>group.locatableIssues).find(issue=>issue.domain === "teaching" && teachingCanEdit(issue.target?.fieldPath || ""))?.target?.fieldPath)}><Pencil size={15} />修改AI内容</button></Show>
                                <Show when={teachingActions()[question.questionId]?.canPublishTeaching || teachingActions()[question.questionId]?.canResumeTeachingPublication}>
                                  <button type="button" class="primary" disabled={Boolean(busy()) || Boolean(activeJob()) || dirty() || editingDirty() || publishFrozen()} onClick={() => askQuestionAction("publish")}>{teachingActions()[question.questionId]?.canResumeTeachingPublication ? "继续上次解析更新" : "更新题库解析"}</button>
                                </Show>
                              </details>
                            </Show>
                            <details class="import-opinion-details import-operation-details"><summary>操作说明</summary>
                              <p><strong><ReviewMessage text={confirmationContext().scope} /></strong></p>
                              <p><ReviewMessage text={confirmationContext().note} /></p>
                            </details>
                            <details class="import-opinion-details"><summary>处理记录与核对依据</summary>
                              <For each={currentTriage()?.issues || []}>{issue => <section class="import-review-context"><p><strong>{issue.domain === "source" ? "原题" : "AI内容"} · {issue.provenanceLabel}</strong></p><RichText text={reviewMessageText(issue.message)} /><p><ReviewMessage text={issue.process.nextAction} /></p></section>}</For>
                              <For each={!dirty() ? sourceCorrectionDisplays()[question.questionId] || [] : []}>{correction => <section class="import-review-context"><p><strong>原题转录比对记录</strong> · 第 {correction.evidencePage} 页；{correction.checkedBy}；{correction.checkedAt}</p><RichText text={correction.basis} /><p>此记录不替代原题确认或入库审核。</p></section>}</For>
                              <Show when={!question.accuracy && question.modelReview}><RichText text={reviewMessageText(question.modelReview.summary || "")} /><p class="muted">模型自评：{confidenceLabel(question.modelReview.confidence)}；不等于独立核验。</p></Show>
                              <Show when={question.teachingWorkflow}><p class="muted">生成 {Number(question.teachingWorkflow.generationCalls || 0)} 次 · 复核 {Number(question.teachingWorkflow.reviewCalls || 0)} 次</p></Show>
                              <Show when={question.reviewBasis}><p>核对记录：<ReviewMessage text={question.reviewBasis} /></p></Show>
                              <For each={currentTriage()?.notices || []}>{issue => <RichText text={reviewMessageText(issue.message)} />}</For>
                            </details>
                            </Show>
                          </div>
                        </aside>
                        </div>
                      </>
                    );
                  }}
                </Show>
              </div>
            </div>
            <footer class="import-review-footer">
              <span class="import-save-status muted" role="status">{busy() || notice() || (editingDirty() ? "有未保存的字段修改" : dirty() ? "有未保存修改" : "进度已保存")}</span>
              <nav class="import-question-navigation" aria-label="单题审核导航">
                <button type="button" class="text-button" disabled={Boolean(busy()) || selected() <= 0} onClick={() => moveQuestion("previous")}><ChevronLeft size={15} />上一题</button>
                <button type="button" class="text-button" disabled={Boolean(busy())} onClick={nextTodo}>{accuracyRecord() ? "下一待处理题" : reviewDomain() === "teaching" ? "下一项AI待办" : "下一原题待办"}<ChevronRight size={15} /></button>
              </nav>
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
              <thead><tr><th scope="col">试卷名称</th><th scope="col">状态</th><th scope="col">题目</th><th scope="col">导入时间</th><th scope="col" class="import-record-operation">操作</th></tr></thead>
              <tbody><For each={history()}>{(item) => (
                <tr>
                  <td><button class="import-record-open" data-import-id={item.importId}
                    aria-label={`查看 ${item.displayTitle || item.filename}`} title={item.filename}
                    disabled={Boolean(busy()) || openingImportId() === item.importId}
                    classList={{"is-opening":openingImportId() === item.importId}} aria-busy={openingImportId() === item.importId}
                    onClick={() => open(item.importId)}>
                    <FileText size={18} aria-hidden="true" />
                    <span class="import-record-name"><strong>{item.displayTitle || item.filename}</strong>
                      <Show when={item.status === "failed"}><small class="import-record-failure-meta">{importStage(item, item).label} · {importFailure(item.error, { record: item, job: item }).categoryLabel}</small></Show>
                      <Show when={item.actionSummary?.label}><small class="import-record-action-summary">{item.actionSummary.label}</small></Show>
                      <small class="import-record-mobile-meta">{item.questionCount} 题 · {importDate(item.createdAt)}</small>
                    </span>
                  </button></td>
                  <td class="import-record-status"><span data-status={item.status} title={message(item.error) || statusLabels[item.status]}>{statusLabels[item.status] || "待审核"}</span></td>
                  <td class="import-record-count">{item.questionCount} 题</td>
                  <td class="import-record-date"><time dateTime={item.createdAt}>{importDate(item.createdAt)}</time></td>
                  <td class="import-record-operation"><button type="button" class="text-button import-record-action"
                    aria-label={`${item.actionSummary?.nextActionLabel || "打开记录"}：${item.displayTitle || item.filename}`}
                    disabled={Boolean(busy()) || openingImportId() === item.importId} aria-busy={openingImportId() === item.importId}
                    onClick={() => open(item.importId)}>
                    <Show when={openingImportId() === item.importId} fallback={<>{item.actionSummary?.nextActionLabel || "打开记录"}<ChevronRight size={16} aria-hidden="true" /></>}>
                      <span class="import-opening-label" role="status"><LoaderCircle size={15} class="spin" />正在打开</span>
                    </Show>
                  </button></td>
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
          <p class="import-publication-scope"><strong>原题＋AI内容 {pendingApprove().filter(q=>reviewEligibility()[q.questionId]?.publicationScope === "source_and_teaching").length} 题</strong><span>原题及组卷信息 {pendingApprove().filter(q=>reviewEligibility()[q.questionId]?.publicationScope === "source_only").length} 题；对应AI答案解析不包含在本次入库中。</span></p>
          <Show when={questions().some(q=>!published(q) && !pendingApprove().some(ready=>ready.questionId===q.questionId))}>
            <p class="muted">不会入库：第 {questions().filter(q=>!published(q) && !pendingApprove().some(ready=>ready.questionId===q.questionId)).map(q=>q.sourceLabel || questions().indexOf(q)+1).join("、")} 题。未通过的原题及AI解析继续保留待处理。</p>
          </Show>
          <ul class="import-publication-list"><For each={pendingApprove()}>{question => <li><span>第 {question.sourceLabel || questions().findIndex(q => q.questionId === question.questionId) + 1} 题</span><strong>{reviewEligibility()[question.questionId]?.publicationScope === "source_and_teaching" ? "原题＋AI内容" : reviewEligibility()[question.questionId]?.publicationScope === "source_only" ? "原题及组卷信息（保留原卷参考）" : "内容范围待重新读取"}</strong></li>}</For></ul>
          <p class="muted">AI内容包括答案解析和考查信息；原题保留实际原卷参考。原题及组卷信息仍可能包含主考知识、解法依赖和难度，不发布AI答案解析。未采用的AI内容继续保留待处理。</p>
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
      <Show when={annotationAction()}>{plan =>
        <Modal title="补全本卷考查信息" busy={Boolean(busy())} onClose={() => { if (!busy()) setAnnotationAction(null); }}
          footer={<><button class="secondary" disabled={Boolean(busy())} onClick={() => setAnnotationAction(null)}>取消</button><button class="primary" disabled={annotationBlocked() || !activeConfigured() || !annotationCurrent()} onClick={annotateStructured}>{busy() ? "正在提交…" : "确认调用并补全"}</button></>}>
          <p>本次补全《{plan().title}》中尚未入库、考查信息不完整的 <strong>{plan().questions.length} 道题</strong>，范围为全卷缺失项。</p>
          <p class="import-annotation-scope">题目范围：第 {plan().questions.map(q => q.label).join("、")} 题。</p>
          <p>使用当前通用模型，向所配置的服务商发送相关题目及可用解析，可能产生费用；仅补缺失的难度、主考知识点和解法所需知识。</p>
          <p class="muted">已有标注、题面、答案解析和审核记录保留。依据不足的内容仍可待补，不自动入库；原题核对和手动选题可继续进行。</p>
          <Show when={!annotationCurrent()}><p class="warning-text" role="status">本卷状态已变化，请关闭后重新确认待补范围。</p></Show>
          <ErrorBanner message={annotationError()} />
        </Modal>
      }</Show>
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
        <Modal title="有未保存的字段修改" onClose={() => setLeaveAction(null)} footer={<><button class="secondary" onClick={() => setLeaveAction(null)}>继续编辑</button><button class="primary" onClick={() => { const action = leaveAction(); setLeaveAction(null); setTeachingDirty(false); setSourceFieldDirty(false); setSourceFieldEdit(undefined); setDiscardFieldRequest(value => value + 1); setEditTeachingRequest(0); setEditTeachingField(""); action?.(); }}>放弃本次编辑并继续</button></>}>
          <p>当前字段的修改尚未保存。放弃后保留进入本次编辑时的内容，已保存的修订保持不变。</p>
        </Modal>
      </Show>
      <ImportSourceFieldEditor request={sourceFieldEdit()?.request} currentIdentity={sourceFieldIdentity()}
        disabled={Boolean(busy()) || Boolean(activeJob()) || publishFrozen() || dirty() || teachingDirty()}
        disabledReason="请先完成当前操作，再保存原文字段。"
        renderText={text => <RichText text={text} question={sourceFieldEdit()?.presentation} teacher />}
        onSave={saveSourceField} onClose={() => setSourceFieldEdit(undefined)} onDirtyChange={setSourceFieldDirty} onOpenChange={setSourceEditorOpen} />
      <Show when={originalPreview() && record()}>
        <Modal title="原卷 PDF 对照" wide stable onClose={() => setOriginalPreview(false)}>
          <Suspense fallback={<Busy label="读取原卷…" />}><PdfPreview importId={record().importId} /></Suspense>
        </Modal>
      </Show>
    </>
  );
}
