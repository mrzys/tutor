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
} from "lucide-solid";
import {
  typeIds,
  operationId,
  request,
  typeLabels,
  typeTitles,
} from "./bridge";
import { Busy, ErrorBanner, Modal } from "./ui";
import { QuestionBody, RichText } from "./Paper";
import { difficultyLevels } from "./assembly-details";
import { assetKey, assetReferences } from "./rich-content";
import { requiredReviewChecks, sourceReviewLabel, sourceReviewDescription, briefReviewReasons } from "./import-review";
import "./ImportPaper.css";
const SourceCompare = lazy(() => import("./SourceCompare").then(module => ({ default: module.SourceCompare })));
const PdfPreview = lazy(() => import("./PdfPreview").then(module => ({ default: module.PdfPreview })));

const statusLabels: Record<string, string> = {
  prepared: "待处理",
  review: "待处理",
  pending_review: "待处理",
  parsed: "待处理",
  failed: "解析失败",
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
  stage: string;
  summary: string;
  location?: string;
  nextAction: string;
  attempts: number;
  ocrCompleted: boolean;
};
function message(value: any): string {
  return typeof value === "string"
    ? value
    : value?.message || value?.description || "";
}
function modelReady(model: any) {
  return model?.configured === true;
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

export function ImportPaper(props: {
  config: any;
  onGuide?: () => void;
  modelRevision: number;
  onConfigure: (section?: "models" | "ocr") => void;
  onBank: () => Promise<void>;
  onAssembly?: () => void;
  onPublished: () => Promise<void>;
  onBusy: (busy: boolean) => void;
  onJobsChange?: (jobs: any[]) => void;
  onNotice?: (message: string) => void;
}) {
  const [checking, setChecking] = createSignal(true);
  const [configured, setConfigured] = createSignal(false);
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
  const [preview, setPreview] = createSignal(true);
  const [originalPreview, setOriginalPreview] = createSignal(false);
  const [sourceCompare, setSourceCompare] = createSignal(false);
  const [jobs, setJobs] = createSignal<any[]>([]);
  const [jobError, setJobError] = createSignal("");
  const selectedJob = () => jobs().find(job => job.importId === record()?.importId);
  const activeJob = () => { const job = selectedJob(); return job && ["queued", "running"].includes(job.status) ? job : null; };
  let jobTimer: ReturnType<typeof setTimeout>;
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
  let prepareId = operationId();
  let prepareAttempt: any = null;
  const operationIds = new Map<string, string>();
  const current = createMemo(() => questions()[selected()]);
  const failureDiagnostic = createMemo<ImportDiagnostic | null>(() => {
    if (record()?.status !== "failed" || busy()) return null;
    return diagnostic() || {
      stage: "试卷解析",
      summary: message(record().error) || "解析未完成，原文件已保留。",
      nextAction: "请查看原卷并重新解析；如再次失败，请保留这条导入记录。",
      attempts: record().modelAttempts?.length || 0,
      ocrCompleted: Boolean(record().ocrSource),
    };
  });
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
    if (record() && dirty()) editBuffers.set(record().importId, {revision: editBaseRevision(), questions:clone(questions()), selected:selected(), preview:preview()});
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
  const reviewStateLabel = (item: any) => published(item) ? "已入库" : reviewEligibility()[item.questionId]?.eligible ? "可入库" : item.modelReview?.status === "needs_review" || item.modelReview?.status === "blocked" ? "需处理" : item.modelReview?.status === "stale" ? "需重新检查" : item.modelReview?.status === "failed" ? "检查未完成" : item.reviewDecision === "approve" ? "已人工核对" : "待检查";
  const canRecheck = () => !activeJob() && questions().some(item => !published(item) && (dirty() || !item.modelReview || ["stale", "failed"].includes(item.modelReview.status)));
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
      ...(current()?.reviewIssues || []).filter((issue: any) => issue?.blocking !== false)]
      .map(message).filter(Boolean),
  )];
  onCleanup(() => {
    clearTimeout(jobTimer);
    ++jobPollVersion;
    alive = false;
    ++configVersion;
    ++openVersion;
    ++historyVersion;
  });
  createEffect(() => {
    props.modelRevision;
    void checkConfiguration(false);
  });
  createEffect(() =>
    props.onBusy(Boolean(busy()) || publishFrozen()),
  );
  async function checkConfiguration(requireOcr: boolean) {
    const own = ++configVersion;
    setChecking(true);
    try {
      const [modelResult, ocrResult] = await Promise.allSettled([request("model_get"), request("ocr_get")]);
      const model = modelResult.status === "fulfilled" ? modelResult.value : null;
      const ocr = ocrResult.status === "fulfilled" ? ocrResult.value : null;
      if (alive && own === configVersion) {
        setConfigured(modelReady(model));
        setModelWarning(model?.warning || "");
        setOcrConfigured(ocr?.configured === true);
        setOcrWarning(ocr?.warning || "");
        setConfigurationTarget(!modelReady(model) ? "models" : requireOcr && ocr?.configured !== true ? "ocr" : null);
        if (modelResult.status === "rejected") setError(modelResult.reason?.message || "模型设置读取失败，请重试。");
        else if (requireOcr && ocrResult.status === "rejected") setError(ocrResult.reason?.message || "试卷识别设置读取失败，请重试。");
      }
      return modelReady(model) && (!requireOcr || ocr?.configured === true);
    } catch (failure: any) {
      if (alive && own === configVersion) {
        setConfigured(false);
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
    void pollJobs();
    loadHistory();
    request("bank_catalog")
      .then((result) => {
        if (alive) setCatalog(result);
      })
      .catch((failure: any) => {
        if (alive) setError(failure.message);
      });
  });
  async function pollJobs() {
    clearTimeout(jobTimer);
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
      const relevant = next.find((job: any) => job.importId === id);
      if (id && relevant && (changed || ["queued", "running"].includes(relevant.status) || ["processing", "parsing"].includes(record()?.status)) && !dirty() && !busy() && !publishFrozen()) {
        const detail = await request("import_job_get", { importId: id });
        if (alive && own === jobPollVersion && record()?.importId === id && !dirty() && !busy() && !publishFrozen() &&
          (detail.import.revision !== record().revision || detail.import.status !== record().status || JSON.stringify(detail.import.error) !== JSON.stringify(record().error)))
          apply(detail.import, detail.diagnostic, detail.reviewEligibility);
      }
    } catch (failure: any) {
      if (alive && own === jobPollVersion) setJobError(failure.message || "导入进度暂未读取，原任务仍在后台处理。");
    } finally {
      if (alive && own === jobPollVersion) jobTimer = setTimeout(pollJobs, 1800);
    }
  }
  function working(text: string) {
    setBusy(text);
  }
  function apply(value: any, detail?: ImportDiagnostic, eligibility?: Record<string, any>) {
    if (record()?.importId !== value.importId) {
      setOriginalPreview(false);
      setSourceCompare(false);
      setSelected(0);
    }
    setRecord(value);
    setEditBaseRevision(value.revision);
    setReviewEligibility(eligibility || {});
    setDiagnostic(value.status === "failed" && detail ? detail : null);
    setError("");
    setQuestions(clone(value.questions || []));
    setSelected((index) =>
      Math.min(index, Math.max(0, (value.questions || []).length - 1)),
    );
    setDirty(false);
    setPreview(true);
    if (value.pendingPublication?.operationId) {
      publishAttempt = {
        importId: value.importId,
        expectedRevision: value.revision,
        operationId: value.pendingPublication.operationId,
        acknowledgeReview: true,
      };
      setPublishFrozen(true);
      setConfirmPublish(true);
      setPublishError("上次入库尚待确认，请重试同一次操作以核查结果。");
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
      const result = await request("import_get", { importId });
      if (alive && own === openVersion) {
        apply(result.import, result.diagnostic, result.reviewEligibility);
        setFile(null);
        setNotice("");
        const buffer = editBuffers.get(importId);
        if (buffer) {
          setQuestions(clone(buffer.questions));
          setSelected(buffer.selected);
          setPreview(buffer.preview);
          setEditBaseRevision(buffer.revision);
          setReviewEligibility({});
          setDirty(true);
          setNotice(buffer.revision === result.import.revision ? "已恢复本窗口未保存的编辑，可以继续处理或返回组卷。" : "已恢复本窗口编辑，但保存版本已更新；请先核对差异，保存不会覆盖较新版本。");
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
    if (busy() || !(await checkConfiguration(/^(pdf|docx)$/i.test(extension || "")))) return;
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
      const result = await request("import_start", prepareAttempt);
      if (!alive) return;
      apply(result.import, result.diagnostic, result.reviewEligibility);
      setFile(null);
      setNotice(["queued", "running"].includes(result.job?.status) ? "已加入后台解析，可继续组卷或浏览题库。完成后会通知你。" : "此试卷已处理，请查看题目与需要核对的事项。");
      if (result.job) {
        jobStates.set(result.job.jobId, result.job.status);
        setJobs(items => [result.job, ...items.filter(job => job.importId !== result.job.importId)]);
        props.onJobsChange?.(jobs());
        void pollJobs();
      }
      prepareAttempt = null;
      prepareId = operationId();
      if (result.import.error) {
        if (result.import.error.code === "ocr_not_configured") setConfigurationTarget("ocr");
        else if (["not_configured", "model_not_configured"].includes(result.import.error.code)) setConfigurationTarget("models");
      }
      await loadHistory(retry ? historyPage() : 1);
    } catch (failure: any) {
      if (alive) {
        setError(failure.message);
        if (failure.code === "ocr_not_configured") setConfigurationTarget("ocr");
        else if (["not_configured", "model_not_configured"].includes(failure.code)) setConfigurationTarget("models");
      }
    } finally {
      if (alive) working("");
    }
  }
  async function stop() {
    if (!activeJob()) return;
    setCancelled(true);
    try {
      await request("import_job_cancel", { importId: record().importId, jobId: activeJob().jobId });
      void pollJobs();
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
    if (busy() || !record()) return false;
    setError("");
    working("保存修改…");
    try {
      const result = await request(
        "import_review_save",
        stable("save", {
          importId: record().importId,
          expectedRevision: editBaseRevision() ?? record().revision,
          questions: clone(questions()),
        }),
      );
      if (alive) {
        editBuffers.delete(record().importId);
        const index = selected();
        apply(result.import, result.diagnostic, result.reviewEligibility);
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
    if (busy()) return;
    setPublishError("");
    if (!publishAttempt) {
      publishAttempt = {
        importId: record().importId,
        expectedRevision: record().revision,
        operationId: operationId(),
        acknowledgeReview: true,
      };
      setPublishFrozen(true);
    }
    working("正在加入本地题库…");
    try {
      const count = pendingApprove().length;
      const result = await request("import_publish", publishAttempt);
      if (!alive) return;
      apply(result.import, result.diagnostic, result.reviewEligibility);
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
    if (busy() || dirty() || publishFrozen() || activeJob() || !record()) return;
    setError("");
    working("正在提交考查信息任务…");
    try {
      const result = await request("import_annotation_start", stable("annotation-start", {
        importId: record().importId,
        expectedRevision: record().revision,
      }));
      if (!alive) return;
      apply(result.import, result.diagnostic, result.reviewEligibility);
      if (result.job) {
        jobStates.set(result.job.jobId, result.job.status);
        setJobs(items => [result.job, ...items.filter(job => job.importId !== result.job.importId)]);
        props.onJobsChange?.(jobs());
        void pollJobs();
      }
      setNotice(["queued", "running"].includes(result.job?.status) ? "正在后台补充考查信息，题面、答案、解析和已有审核不变；可继续其它操作。" : "当前考查信息已处理，已有结果保留。");
      await loadHistory();
    } catch (failure: any) { if (alive) setError(failure.message); }
    finally { if (alive) working(""); }
  }
  async function recheckQuestions() {
    if (busy() || activeJob() || publishFrozen() || !record()) return;
    if (dirty() && !(await save())) return;
    setError("");
    working("正在提交重新检查…");
    try {
      const result = await request("import_review_start", stable("model-review", {importId:record().importId,expectedRevision:record().revision}));
      if (!alive) return;
      apply(result.import,result.diagnostic,result.reviewEligibility);
      if (result.job && ["queued","running"].includes(result.job.status)) {
        jobStates.set(result.job.jobId,result.job.status);
        setJobs(items => [result.job,...items.filter(job => job.importId !== result.job.importId)]);
        props.onJobsChange?.(jobs());
        void pollJobs();
      }
      setNotice(["queued", "running"].includes(result.job?.status) ? "正在后台重新检查，可返回组卷；完成后直接查看检查意见。" : "当前检查意见仍然有效，无需重复检查。");
    } catch (failure:any) { if (alive) setError(failure.message); }
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
        stem: question.stem,
        options: question.options || [],
        parts: question.parts || [],
      },
      teacher: {
        ...(question.teacher || {}),
        answers: [
          { text: question.answer || "" },
          ...(question.parts || []).map((part: any, index: number) => ({
            text: part.answer ? `（${index + 1}）${part.answer}` : "",
          })),
        ].filter((entry) => entry.text),
        solutions: [
          { text: question.solution || "" },
          ...(question.parts || []).map((part: any, index: number) => ({
            text: part.solution ? `（${index + 1}）${part.solution}` : "",
          })),
        ].filter((entry) => entry.text),
      },
    };
  }
  return (
    <>
      <header class={`page-heading ${record() ? "import-review-page-heading" : ""}`}>
        <div>
          <h1>导入试卷</h1>
          <Show when={!record()}><p class="muted">上传原卷，识别并整理题目，核对后加入本地题库。</p></Show>
        </div>
        <div class="guide-heading-actions">
        <Show when={props.onAssembly}><button class="text-button" disabled={Boolean(busy()) || publishFrozen()} onClick={() => props.onAssembly?.()}><ArrowLeft size={16} />返回组卷</button></Show>
        <Show when={props.onGuide}><button class="text-button guide-entry" onClick={() => props.onGuide?.()}><CircleHelp size={16} />导入说明</button></Show>
        <button
          class="text-button"
          disabled={Boolean(busy()) || publishFrozen()}
          onClick={() =>
            props.onBank().catch((failure: any) => setError(failure.message))
          }
        >
          <ArrowLeft size={16} />
          题库
        </button>
        </div>
      </header>
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
            <p class="muted">试卷解析需要模型接口。配置后即可选择文件。</p>
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
      <Show when={busy()}>
        <Busy
          label={cancelled() ? "正在停止，请稍候…" : busy()}
          cancel={
            busy().startsWith("正在解析") && !cancelled() ? stop : undefined
          }
        />
      </Show>
      <Show when={notice()}>
        <p class="import-notice" role="status">
          <Check size={16} />
          {notice()}
        </p>
      </Show>
      <Show when={jobError()}><p class="warning-text" role="status">{jobError()}<button class="text-button" onClick={pollJobs}>重新读取进度</button></p></Show>
      <Show when={jobs().some(job => ["queued", "running"].includes(job.status))}>
        <section class="import-background-jobs" aria-label="后台导入任务" aria-live="polite">
          <For each={jobs().filter(job => ["queued", "running"].includes(job.status))}>{job => <div>
            <span><strong>{job.filename}</strong><small>{job.message || "后台解析中，可继续其它操作。"}</small></span>
            <button class="text-button" disabled={Boolean(busy()) || dirty() || publishFrozen()} onClick={() => open(job.importId)}>查看进度</button>
            <button class="text-button" onClick={async () => { try { await request("import_job_cancel", {importId:job.importId, jobId:job.jobId}); void pollJobs(); } catch(failure:any) {setJobError(failure.message);} }}>停止</button>
          </div>}</For>
        </section>
      </Show>
      <Show when={record()}>
        <section class="import-review">
          <button class="text-button import-back" disabled={Boolean(busy()) || publishFrozen()}
            title={dirty() ? "未保存编辑将保留在本窗口" : publishFrozen() ? "请先完成待确认的入库操作" : "返回当前页导入记录"}
            onClick={backToHistory}><ArrowLeft size={16} />导入记录</button>
          <div class="section-heading import-review-heading">
            <div>
              <h2 ref={detailHeading} tabIndex={-1} title={record().filename}>{record().structuredSource?.exam?.title || record().filename}</h2>
              <p class="muted">
                {statusLabels[record().status] || "待审核"} ·{" "}
                {questions().length} 题
              </p>
            </div>
            <div class="import-record-actions">
            <Show when={canRecheck()}><button class="secondary" disabled={Boolean(busy()) || publishFrozen() || !configured()} onClick={recheckQuestions} title="仅重新检查未完成检查、尚无意见或内容已修改的题目；先保存当前编辑">重新检查</button></Show>
            <Show when={questions().some(item => !published(item) && (item.annotationStatus === "failed" || !item.difficultyAssessment?.level || !item.primaryKnowledgeUids?.length))}>
              <button class="secondary" disabled={Boolean(busy()) || dirty() || publishFrozen() || Boolean(activeJob()) || !configured()} onClick={annotateStructured} title="仅补充未评估难度或未标注知识点的题目，不补编答案解析">补充考查信息</button>
            </Show>
            <Show when={questions().length}>
                <button
                  class="primary"
                  disabled={
                    Boolean(busy()) ||
                    dirty() ||
                    !pendingApprove().length ||
                    publishFrozen() || Boolean(activeJob())
                  }
                  onClick={() => {
                    setPublishError("");
                    setConfirmPublish(true);
                  }}
                >
                  加入题库
                </button>
            </Show>
            <Show when={record().source?.extension === "pdf" || record().renderedPdf}>
              <button class="secondary" disabled={Boolean(busy())} onClick={() => setOriginalPreview(true)}><FileText size={16} />{record().source?.extension === "docx" ? "查看转换 PDF" : "查看原卷 PDF"}</button>
            </Show>
            <Show
              when={!activeJob() && ["failed", "cancelled", "processing"].includes(
                record().status,
              )}
            >
              <button
                class="secondary"
                disabled={Boolean(busy()) || !configured()}
                onClick={() => {
                  if (!prepareAttempt) prepareId = operationId();
                  parse(true);
                }}
              >
                重新解析
              </button>
            </Show>
            </div>
          </div>
          <Show when={["annotation", "review"].includes(selectedJob()?.mode) && ["failed", "interrupted", "cancelled"].includes(selectedJob()?.status)}>
            <p class="warning-text" role="status">{selectedJob()?.message || "考查信息未全部完成，原题和已有结果已保留，可点击补充考查信息重试。"}</p>
          </Show>
          <Show when={failureDiagnostic()}>
            {(detail) => <section class="import-failure" role="alert" aria-label="导入失败原因">
              <div class="import-failure-title"><AlertCircle size={20} aria-hidden="true" /><h3>导入未完成</h3></div>
              <dl>
                <div><dt>失败阶段</dt><dd>{detail().stage}</dd></div>
                <div><dt>具体原因</dt><dd>{detail().summary}</dd></div>
                <Show when={detail().location}><div><dt>错误位置</dt><dd>{detail().location}</dd></div></Show>
                <div><dt>下一步</dt><dd>{detail().nextAction}</dd></div>
              </dl>
              <Show when={detail().ocrCompleted}><p class="import-failure-preserved"><Check size={16} aria-hidden="true" />试卷识别已完成，原文件和识别材料已保留。</p></Show>
              <Show when={record().error?.code || detail().attempts > 0}>
                <details><summary>错误详情</summary><p class="muted">{record().error?.code ? `错误代码：${record().error.code}` : ""}{record().error?.code && detail().attempts > 0 ? " · " : ""}{detail().attempts > 0 ? `模型尝试 ${detail().attempts} 次` : ""}</p></details>
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
            <p class="import-review-progress">共 {questions().length} 题 · 可入库 {pendingApprove().length} 题 · 已入库 {questions().filter(item => published(item)).length} 题</p>
            <div class="import-review-layout">
              <nav class="import-question-list" aria-label="待审核题目">
                <For each={questions()}>
                  {(question, index) => (
                    <button
                      class={selected() === index() ? "current" : ""}
                      aria-current={selected() === index() ? "true" : undefined}
                      disabled={Boolean(busy()) || publishFrozen()}
                      onClick={() => {
                        setSelected(index());
                        setPreview(true);
                      }}
                    >
                      <span>
                        {index() + 1}.{" "}
                        {typeLabels[question.questionType] || "题目"}
                      </span>
                      <Show when={needsOpinion(question) || published(question)}><small>{reviewStateLabel(question)}</small></Show>
                    </button>
                  )}
                </For>
              </nav>
              <div class="import-question-editor">
                <Show when={current()}>
                  {(_question) => {
                    const question: any = new Proxy(
                      {},
                      { get: (_target, key) => current()?.[key as string] },
                    );
                    return (
                      <>
                        <div class="bank-results-heading import-question-heading">
                          <div><strong>第 {question.sourceLabel || selected() + 1} 题</strong><small class="muted">{typeTitles[question.questionType] || "题目"}</small></div>
                          <div class="inline-actions">
                            <button
                              class="text-button"
                              disabled={Boolean(busy())}
                              onClick={() => setPreview(!preview())}
                            >
                              {preview() ? (
                                <Pencil size={15} />
                              ) : (
                                <Eye size={15} />
                              )}
                              {preview() ? "编辑内容" : "查看排版"}
                            </button>
                          </div>
                        </div>
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
                        <div class="import-audit-workspace" classList={{"import-audit-workspace-plain":!needsOpinion(question)}}>
                        <div class="import-reading-pane">
                        <Show
                          when={preview()}
                          fallback={
                            <fieldset
                              disabled={
                                Boolean(busy()) || Boolean(activeJob()) ||
                                published(question) ||
                                publishFrozen()
                              }
                              class="import-fields"
                            >
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
                              <label class="field-label">
                                题型
                                <select
                                  aria-label="导入题型"
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
                                <textarea
                                  rows={6}
                                  value={question.stem || ""}
                                  onInput={(event) =>
                                    update({ stem: event.currentTarget.value })
                                  }
                                />
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
                                            value={option.text || ""}
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
                              <label class="field-label">
                                答案
                                <textarea
                                  rows={3}
                                  value={question.answer || ""}
                                  onInput={(event) =>
                                    update({
                                      answer: event.currentTarget.value,
                                    })
                                  }
                                />
                              </label>
                              <label class="field-label">
                                解析
                                <textarea
                                  rows={5}
                                  value={question.solution || ""}
                                  onInput={(event) =>
                                    update({
                                      solution: event.currentTarget.value,
                                    })
                                  }
                                />
                              </label>
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

                            </fieldset>
                          }
                        >
                          <Show when={(!previewQuestion(question).teacher.answers.length || !previewQuestion(question).teacher.solutions.length)}>
                            <p class="import-answer-absence">原卷缺少的{!previewQuestion(question).teacher.answers.length ? "答案" : ""}{!previewQuestion(question).teacher.answers.length && !previewQuestion(question).teacher.solutions.length ? "、" : ""}{!previewQuestion(question).teacher.solutions.length ? "解析" : ""}保持空缺，不需要核对这些缺项。</p>
                          </Show>
                          <article class="import-preview">
                            <QuestionBody
                              question={previewQuestion(question)}
                              teacher
                              hideMissingTeacherMaterials
                              hideSource
                              number={selected() + 1}
                            />
                          </article>
                          <section class="import-reading-meta" aria-label="考查信息">
                            <h3>考查信息 <small class="muted">内容估计，供核对</small></h3>
                            <p class="muted">难度与主考知识点可按题面估计，不要求生成答案；缺少完整解法依据时，所需知识仍显示未知。</p>
                            <dl class="import-reading-facts">
                              <div><dt>难度</dt><dd>{difficultyLevels.find(level => level.id === question.difficultyAssessment?.level)?.label || "未评估"}</dd></div>
                              <div><dt>考查点</dt><dd>{question.task?.label || "未标注"}</dd></div>
                              <div><dt>{hasKnowledgePlan(question) ? "主考知识点" : "相关知识点"}</dt><dd>{knowledgeNames(hasKnowledgePlan(question) ? question.primaryKnowledgeUids : question.knowledgeUids)}</dd></div>
                            </dl>
                            <Show when={question.difficultyAssessment?.basis}>
                              <details><summary>难度依据</summary><RichText text={question.difficultyAssessment.basis} question={previewQuestion(question)} teacher /></details>
                            </Show>
                            <details><summary>没有解析时怎么办？</summary><p>难度和主考知识点可从题面分别估计，未知维度可点击“补充考查信息”处理。没有可靠的完整解法依据时，不补编答案解析，也不猜测全部解法依赖。题面完整的题目仍可审核入库、手动组卷；自动选题需具备满足已学范围的完整路径。</p></details>
                            <details><summary>解法与所需知识</summary>
                              <Show when={hasKnowledgePlan(question)} fallback={<p><RichText text={question.allowedSolution || "尚未标注完整解法，自动适配未知。"} question={previewQuestion(question)} teacher /></p>}>
                                <For each={question.solutionPaths || []}>{(path, index) => <section class="import-path-reading">
                                  <h4>解法 {index() + 1}</h4>
                                  <p>所需知识：{knowledgeNames(path.requiredKnowledgeUids)}</p>
                                  <Show when={path.requiredPremises?.length}><p>额外工具或条件：{premiseNames(path.requiredPremises)}</p></Show>
                                  <RichText text={path.basis || "缺少完整解法依据，自动适配未知。"} question={previewQuestion(question)} teacher />
                                </section>}</For>
                                <Show when={!question.solutionPaths?.length}><p class="muted">尚未标注完整解法，自动适配未知。</p></Show>
                              </Show>
                            </details>
                          </section>
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
                        </Show>
                        </div>
                        <Show when={needsOpinion(question)}>
                        <aside class="import-review-checks import-opinion" aria-label="本题检查意见">
                          <div class="import-opinion-heading"><h3>{reviewStateLabel(question)}</h3><Show when={question.modelReview}><small title="模型自评，不是实测正确率">置信：{confidenceLabel(question.modelReview?.confidence)}</small></Show></div>
                          <Show when={!activeJob()} fallback={<p class="muted" role="status">正在检查，可继续其它操作。</p>}>
                            <For each={briefReviewReasons(question, reviewEligibility()[question.questionId]?.reason)}>{reason => <p class="import-opinion-brief">{reason}</p>}</For>
                          </Show>
                          <details class="import-opinion-details"><summary>详细说明</summary>
                            <Show when={question.modelReview} fallback={<p class="muted">尚无检查意见，可点击“重新检查”补充。</p>}>
                              <RichText text={question.modelReview?.summary || "请对照原卷查看具体疑点。"} question={previewQuestion(question)} teacher />
                              <Show when={question.modelReview?.issues?.length}><ul class="import-opinion-issues"><For each={question.modelReview.issues}>{(issue:any) => <li><RichText text={message(issue)} question={previewQuestion(question)} teacher /></li>}</For></ul></Show>
                              <Show when={reviewEligibility()[question.questionId]?.reason && reviewEligibility()[question.questionId].reason !== question.modelReview?.summary && !question.modelReview?.issues?.some((issue:any) => message(issue) === reviewEligibility()[question.questionId].reason)}><p class="warning-text">{reviewEligibility()[question.questionId].reason}</p></Show>
                              <p class="muted">原卷第 {(question.modelReview?.evidence?.pages || question.pages || []).join("、") || "未知"} 页 · {question.modelReview?.model?.name || "当前模型"} · {question.modelReview?.reviewedAt ? new Date(question.modelReview.reviewedAt).toLocaleString("zh-CN") : "时间未记录"}</p>
                            </Show>
                            <Show when={question.modelReview?.status === "needs_review" && !activeJob()}><button class="text-button" disabled={Boolean(busy()) || publishFrozen() || !configured()} onClick={recheckQuestions}>重新检查疑点题</button></Show>
                          </details>
                          <details class="import-manual-review"><summary>人工复核 / 处理疑点</summary>
                              <fieldset class="import-manual-fields" disabled={Boolean(busy()) || Boolean(activeJob()) || published(question) || publishFrozen()}>
                                <h3>人工复核</h3>
                                <p class="muted">
                                  对照原卷完成以下 {requiredReviewChecks(question).length} 项。只核对本题实际包含的内容。
                                </p>
                                <div class="import-check-grid">
                                  <For each={requiredReviewChecks(question).map(key => [key, key === "sourceMatched" ? sourceReviewLabel(question) : checkLabels[key]])}>
                                    {([key, label]) => (
                                      <label class="check-row">
                                        <input
                                          type="checkbox"
                                          checked={
                                            question.reviewChecks?.[key] ===
                                            true
                                          }
                                          onChange={(event) =>
                                            update({
                                              reviewChecks: {
                                                ...question.reviewChecks,
                                                [key]:
                                                  event.currentTarget.checked,
                                              },
                                            })
                                          }
                                        />
                                        <span><strong>{label}</strong><small>{key === "sourceMatched" ? sourceReviewDescription(question) : checkDescriptions[key]}</small></span>
                                      </label>
                                    )}
                                  </For>
                                </div>
                                <label class="field-label">
                                  复核依据
                                  <textarea
                                    rows={2}
                                    aria-label="复核依据"
                                    placeholder="如：对照原卷逐项检查并验算；原卷无解析，已保留空缺。"
                                    value={question.reviewBasis || ""}
                                    onInput={(event) =>
                                      update({
                                        reviewBasis: event.currentTarget.value,
                                      })
                                    }
                                  />
                                </label>
                                <label class="check-row">
                                  <input
                                    type="checkbox"
                                    checked={
                                      question.reviewDecision === "approve"
                                    }
                                    disabled={!reviewComplete(question) || Boolean(activeIssues().length)}
                                    onChange={(event) =>
                                      update({
                                        reviewDecision: event.currentTarget
                                          .checked
                                          ? "approve"
                                          : "pending",
                                      })
                                    }
                                  />
                                  此题已核对，可加入题库
                                </label>
                              <p class="muted import-check-hint">{activeIssues().length ? `本题有 ${activeIssues().length} 项内容问题，见上方“需要核对”；修正并保存后才能标为已核对。` : reviewComplete(question) ? "保存修改后，可将已核对题目加入题库。" : "人工复核需完成本题核对项并填写复核依据。"} 内容缺失或配图损坏须先修正。</p>
                              </fieldset>
                          </details>
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
              <span class="muted">
                {dirty() ? "有未保存修改 · 可保留在本窗口稍后继续" : "进度已保存"} · 可入库 {pendingApprove().length} 题
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
          <p>
            将 {pendingApprove().length} 道满足入库条件的题加入本地题库（导入检查建议可用或已人工复核）。有疑点、缺图和未完成检查的题继续保留，不需要现在全部处理。
          </p>
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
                  const result = await request("import_get", {
                    importId: record().importId,
                  });
                  apply(result.import, result.diagnostic, result.reviewEligibility);
                  if (result.import.pendingPublication?.operationId) return;
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
      <Show when={sourceCompare() && record()}><Suspense fallback={<Busy label="读取对照资料…" />}><SourceCompare importId={record().importId} pages={current()?.pages} extractedPages={record().extractedPages} question={originalAssets()} onClose={() => setSourceCompare(false)} /></Suspense></Show>
      <Show when={originalPreview() && record()}>
        <Modal title="原卷 PDF 对照" wide stable onClose={() => setOriginalPreview(false)}>
          <Suspense fallback={<Busy label="读取原卷…" />}><PdfPreview importId={record().importId} /></Suspense>
        </Modal>
      </Show>
    </>
  );
}
