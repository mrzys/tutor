import { teachingIssueRows, type TeachingReviewControls } from "./import-review.ts";
import { teachingFindingMessage } from "./teaching-finding-display.ts";
import { importFailure, teachingFailureStage, type ImportFailureView } from "./import-process.ts";

/** Read-only navigation projection. Colours are not publication permission or a
 * mathematical verdict. Eligibility and adoption remain backend decisions. */
export type TriageTone = "red" | "amber" | "neutral";
export type SourceState = "pending" | "eligible" | "blocked" | "published";
export type TeachingState = "not_started" | "generating" | "failed" | "needs_review" | "ready" | "adopted" | "not_adopted";
export type TriageTarget = {
  domain: "source" | "teaching";
  fieldPath: string;
  candidateSha256?: string;
  sourceContentSha256?: string;
  segmentId?: string;
  start?: number;
  end?: number;
};
export type TriageIssue = {
  id: string;
  domain: "source" | "teaching";
  tone: TriageTone;
  message: string;
  provenanceLabel: "模型提示" | "人工核对" | "程序校验" | "术语检查";
  code?: string;
  type?: string;
  target?: TriageTarget;
  location: "range" | "field" | "unavailable";
  process: ImportFailureView;
};
export type TriageOptions = {
  record?: any;
  eligibility?: { eligible?: boolean; reason?: string; method?: string; sourceMaterialFindings?: unknown };
  controls?: TeachingReviewControls;
  teachingActions?: { adopted?: boolean; [key: string]: unknown };
  activeQuestionIds?: string[];
  dirty?: boolean;
};
export type ImportTriageRow = {
  questionId: string;
  question: any;
  sourceState: SourceState;
  teachingState: TeachingState;
  duplicateState: "none" | "exact";
  tone: TriageTone;
  issues: TriageIssue[];
  notices: TriageIssue[];
  needsAction: boolean;
  eligible: boolean;
  published: boolean;
  sourceLabel: string;
  teachingLabel: string;
};

const rows = (value: unknown): any[] => Array.isArray(value) ? value : [];
const text = (value: unknown) => typeof value === "string" ? value : "";
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const activeStatus = (value: unknown) => ["generating", "reviewing"].includes(text(value));
const sourceField = (path: string) => ["stem", "answer", "solution"].includes(path)
  || /^options\[\d+\]\.text$/.test(path) || /^parts\[\d+\]\.(stem|prompt|answer|solution)$/.test(path);
// Only canonical paths which cannot denote a generated answer/explanation.
// Material wording or an ambiguous path never determines the affected domain.
const sourceMaterialField = (path: string, question: any) => (path === "stem"
  || /^options\[\d+\]\.text$/.test(path) || /^parts\[\d+\]\.(stem|prompt)$/.test(path))
  && typeof fieldValue(question, path) === "string";
const teachingField = (path: string) => ["answer", "teachingSolution", "difficultyAssessment.basis", "teachingFocus.examFocus"].includes(path)
  || /^teachingFocus\.studentRequirements\[\d+\]$/.test(path);
const fieldValue = (root: any, path: string): unknown => path.replace(/\[(\d+)\]/g, ".$1").split(".")
  .reduce((value: any, key) => value != null ? value[key] : undefined, root);

function candidate(question: any) {
  const wf = question?.teachingWorkflow;
  if (!wf) return null;
  return wf.status === "ready_candidate" ? wf.finalResult || wf.candidateResult
    : wf.candidateResult || wf.reviewedCandidate || wf.initialCandidate;
}

/** Exact offsets are UTF-16, matching JS slice and the persisted Rust findings.
 * No first-match/fuzzy quote search or guessed segment identity is performed. */
function targetFor(finding: any, domain: "source" | "teaching", question: any, options: TriageOptions): TriageTarget | undefined {
  if (options.dirty) return;
  const explicit = finding?.target;
  const path = text(explicit?.fieldPath || finding?.fieldPath || finding?.field);
  if (domain === "source") {
    if (!sourceField(path) || typeof fieldValue(question, path) !== "string") return;
    const materialQuality = finding?.type === "quality" || finding?.dimension === "material";
    if (materialQuality && (!digest(options.controls?.sourceContentSha256)
      || question?.teachingWorkflow?.sourceContentSha256 !== options.controls.sourceContentSha256)) return;
    // Legacy source opinions have field-level locations only. A sentence/range
    // needs an explicit source binding; never infer one from an issue message.
    const sourceHash = options.controls?.sourceContentSha256;
    if (!explicit) return materialQuality ? { domain, fieldPath: path, sourceContentSha256: sourceHash,
      ...(digest(options.controls?.candidateSha256) ? { candidateSha256: options.controls.candidateSha256 } : {}) }
      : { domain, fieldPath: path };
    if (!digest(sourceHash) || explicit.sourceContentSha256 !== sourceHash || explicit.domain && explicit.domain !== domain) return;
    return { domain, fieldPath: path, sourceContentSha256: sourceHash };
  }
  const controls = options.controls;
  const current = candidate(question);
  if (!teachingField(path) || !digest(controls?.candidateSha256) || !digest(controls?.sourceContentSha256)
    || question?.teachingWorkflow?.sourceContentSha256 !== controls.sourceContentSha256) return;
  const editable = controls.editableFields?.find(item => item.path === path);
  if (!editable || editable.value !== fieldValue(current, path)) return;
  // Explicit target bindings must all match. Otherwise do not silently reuse
  // the old target as a field-level location on a newer draft.
  if (explicit && (explicit.domain && explicit.domain !== domain
    || explicit.candidateSha256 !== controls.candidateSha256
    || explicit.sourceContentSha256 !== controls.sourceContentSha256)) return;
  const target: TriageTarget = { domain, fieldPath: path,
    candidateSha256: controls.candidateSha256, sourceContentSha256: controls.sourceContentSha256 };
  const start = explicit?.start ?? finding?.start;
  const end = explicit?.end ?? finding?.end;
  const expected = text(finding?.term || finding?.quote || explicit?.text);
  if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end <= editable.value.length
    && expected && editable.value.slice(start, end) === expected) {
    target.start = start;
    target.end = end;
    if (explicit && typeof explicit.segmentId === "string") target.segmentId = explicit.segmentId;
  }
  return target;
}

function findingProvenance(finding: any): TriageIssue["provenanceLabel"] {
  if (["external_review", "external_quality", "operator", "operator_review", "teacher_review", "user_authorized_agent_review"].includes(text(finding?.origin))) return "人工核对";
  if (finding?.type === "term") return "术语检查";
  if (["model_issue", "quality"].includes(text(finding?.type)) || finding?.origin === "generation_self_check") return "模型提示";
  return "程序校验";
}

function issue(message: string, domain: "source" | "teaching", tone: TriageTone, key: string, finding?: any,
  question?: any, options: TriageOptions = {}, provenanceLabel = findingProvenance(finding)): TriageIssue {
  const target = finding ? targetFor(finding, domain, question, options) : undefined;
  return { id: `${domain}:${key}`, domain, tone, message, provenanceLabel, code: text(finding?.code) || undefined,
    type: text(finding?.type) || undefined, target,
    process: importFailure({ ...finding, message }, { domain, type: finding?.type, dimension: finding?.dimension,
      stageKey: teachingFailureStage(question?.teachingWorkflow, domain), workflow: question?.teachingWorkflow }),
    location: target?.start !== undefined ? "range" : target ? "field" : "unavailable" };
}

const findingMessage = (finding: any) => teachingFindingMessage({ ...finding, message: finding?.message || finding?.reason })
  || "解析仍有未完成的核对项";
const substantive = new Set(["mathematics", "proof", "method", "material"]);
function findingTone(finding: any): TriageTone {
  if (finding?.type === "quality") return substantive.has(text(finding.dimension)) ? "red" : "amber";
  // A term flag is a request to check its context, not evidence of a faulty
  // method. Model-reported material defects remain concerns, not facts.
  if (finding?.type === "model_issue") return "red";
  return "amber";
}

export function importQuestionTriage(question: any, options: TriageOptions = {}): ImportTriageRow {
  const record = options.record || {};
  const wf = question?.teachingWorkflow;
  const review = question?.modelReview;
  const questionId = text(question?.questionId);
  const published = question?.status === "published" || rows(record.publishedQuestionIds).includes(questionId);
  const duplicate = rows(question?.duplicateCandidates).some(item => item?.exact === true);
  const eligible = !published && !duplicate && options.eligibility?.eligible === true;
  const issues: TriageIssue[] = [];
  const notices: TriageIssue[] = [];
  const add = (item: TriageIssue, notice = false) => {
    const same = (other: TriageIssue) => other.domain === item.domain && other.message === item.message
      && other.target?.fieldPath === item.target?.fieldPath
      && other.target?.start === item.target?.start && other.target?.end === item.target?.end;
    // Equal issue text can occur at several original indices. Acknowledging
    // one occurrence must never hide another still-blocking occurrence.
    if (issues.some(same) || notice && notices.some(same)) return;
    if (!notice) {
      const index = notices.findIndex(same);
      if (index !== -1) notices.splice(index, 1);
    }
    (notice ? notices : issues).push(item);
  };
  const pages = rows(question?.pages);
  const sourceFindings = [...rows(record.sourceIssues).filter(f => !Number(f?.page) || pages.includes(Number(f.page))),
    ...rows(question?.sourceIssues), ...rows(question?.reviewIssues)].map(finding => ({ finding, provenanceLabel: findingProvenance(finding) }));
  sourceFindings.push(...rows(options.eligibility?.sourceMaterialFindings)
    .filter(f => f?.dimension === "material" && sourceMaterialField(text(f?.fieldPath), question))
    .map(finding => ({ finding, provenanceLabel: "人工核对" as const })));
  for (const [index, { finding, provenanceLabel }] of sourceFindings.entries()) {
    const message = typeof finding === "string" ? finding : text(finding?.message || finding?.description || finding?.reason);
    if (!message) continue;
    add(issue(message, "source", "red", `material-${index}`, finding, question, options, provenanceLabel), finding?.blocking === false);
  }
  const humanReviewed = options.eligibility?.method === "teacher_review";
  if (!published && !humanReviewed) {
    if (["failed", "stale"].includes(review?.status)) {
      add(issue(review.status === "failed" ? "原题检查未完成，可重试或对照原卷人工核对" : "原题已修改，请重新检查或人工核对",
        "source", "amber", "review-state"));
    } else {
      const reviewIssues = rows(review?.issues);
      for (const [index, finding] of reviewIssues.entries()) {
        const message = typeof finding === "string" ? finding : text(finding?.message || finding?.description);
        if (message) add(issue(message, "source", "red", `review-${index}`, finding, question, options, "模型提示"), finding?.blocking === false || finding?.severity === "informative");
      }
      if (reviewIssues.length === 0 && ["needs_review", "blocked"].includes(review?.status)) {
        add(issue(text(review.summary) || "模型提示原题可能存在疑点，请对照原卷核对", "source", "red", "review-state", undefined, question, options, "模型提示"));
      }
    }
  }

  const issueRows = teachingIssueRows(question, options.controls);
  const acknowledged = new Set(issueRows.filter(row => issueRows.filter(other => other.issue === row.issue)
    .every(other => other.acknowledged && other.disposition === "informative")).map(row => row.issue));
  for (const row of issueRows) {
    add(issue(row.issue, "teaching", "red", `material-${row.issueIndex}`, undefined, question, options, "模型提示"), row.acknowledged && row.disposition === "informative");
  }
  const findings = Array.isArray(wf?.effectiveFindings) ? wf.effectiveFindings : rows(wf?.findings);
  for (const [index, finding] of findings.entries()) {
    const notice = finding?.type === "model_issue" && acknowledged.has(text(finding.issue));
    const domain = finding?.type === "quality" && finding?.dimension === "material"
      && sourceMaterialField(text(finding.fieldPath), question) ? "source" : "teaching";
    add(issue(findingMessage(finding), domain, findingTone(finding), `finding-${index}`, finding, question, options), notice);
  }
  if (wf?.reviewFailurePending === true) {
    add(issue("复核未完成，初稿已保留，仍需核对", "teaching", "amber", "review-failed"));
  }
  const adopted = options.teachingActions?.adopted === true
    || (options.teachingActions?.adopted !== false && question?.teachingPublication?.status === "adopted"
      && (!options.controls?.candidateSha256 || question.teachingPublication.candidateSha256 === options.controls.candidateSha256));
  const publicationPending = options.teachingActions?.canResumeTeachingPublication === true;
  if (publicationPending) {
    add(issue(adopted ? "题库解析已采用，本地更新回执待完成，请继续上次解析更新"
      : "上次解析更新尚未完成，请继续原操作", "teaching", "amber", "publication-receipt", {
        type: "technical", code: "teaching_publication_receipt_pending",
      }));
  }
  let teachingState: TeachingState;
  if (adopted) teachingState = "adopted";
  else if (options.activeQuestionIds?.includes(questionId) || activeStatus(wf?.status)) teachingState = "generating";
  else if (["generation_failed", "review_failed"].includes(wf?.status)) teachingState = "failed";
  else if (!wf || wf.status === "generation_pending") teachingState = "not_started";
  else if (wf.status === "ready_candidate" && wf.reviewFailurePending !== true
    && !issues.some(item => item.domain === "teaching" && item.code !== "teaching_publication_receipt_pending")) teachingState = "ready";
  else teachingState = "needs_review";
  if (published && !wf && !adopted) teachingState = "not_adopted";

  if (wf && ["not_started", "failed", "needs_review"].includes(teachingState) && !issues.some(item => item.domain === "teaching")
    && (teachingState !== "needs_review" || !issues.some(item => item.domain === "source"))) {
    add(issue(teachingState === "not_started" ? "AI解析尚未生成" : teachingState === "failed" ? "解析处理未完成，已有材料已保留" : "AI解析仍待核对",
      "teaching", "amber", "workflow-state"));
  }
  if ((teachingState === "generating" || published && teachingState === "ready") && !issues.some(item => item.domain === "teaching")) {
    add(issue(teachingState === "generating" ? "正在处理本题解析，其他题仍可阅读" : "AI解析候选已就绪，确认后可更新题库解析",
      "teaching", "amber", "adoption-state"));
  }
  if (!published && !duplicate && !eligible && !humanReviewed && !review?.status && !issues.some(item => item.domain === "source")) {
    add(issue("原题尚未完成检查或人工核对", "source", "amber", "not-reviewed"));
  }
  // Publishing freezes the original, not the separate AI draft. Old source
  // notices remain available, but do not create a mutable-source task.
  const pending = issues.filter(item => item.domain === "teaching"
    ? !adopted || item.code === "teaching_publication_receipt_pending" : !published && !duplicate);
  const rejected = question?.reviewDecision === "reject" && !published;
  // Exact duplicates remain readable with their historical concerns, but are
  // not executable recovery tasks. Do not relabel those concerns as resolved.
  const needsAction = !duplicate && !rejected && (pending.length > 0 || published && teachingState === "ready");
  const tone: TriageTone = duplicate ? "neutral" : !needsAction ? "neutral"
    : pending.some(item => item.tone === "red") ? "red" : "amber";
  const sourceState: SourceState = published ? "published" : eligible ? "eligible"
    : issues.some(item => item.domain === "source" && item.tone === "red") || duplicate || rejected ? "blocked" : "pending";
  const sourceLabel = duplicate ? "重复题" : ({ published: "原题已入库", eligible: "原题待确认入库", blocked: "原题需核对", pending: "原题待核对" }[sourceState]);
  const teachingLabel = ({ not_started: "解析未开始", generating: "解析处理中", failed: "解析处理未完成", needs_review: "解析待核对", ready: published ? "解析待采用" : "解析候选已就绪", adopted: publicationPending ? "解析已采用，更新回执待完成" : "解析已采用", not_adopted: "未采用AI解析" }[teachingState]);
  return { questionId, question, sourceState, teachingState, duplicateState: duplicate ? "exact" : "none", tone,
    issues, notices, needsAction, eligible, published, sourceLabel, teachingLabel };
}

export function importTriage(record: any, eligibility: Record<string, any> = {}, controls: Record<string, TeachingReviewControls> = {},
  activeQuestionIds: string[] = [], teachingActions: Record<string, any> = {}, dirty = false) {
  const projected = rows(record?.questions).map(question => importQuestionTriage(question, {
    record, eligibility: eligibility[question.questionId], controls: controls[question.questionId],
    teachingActions: teachingActions[question.questionId], activeQuestionIds, dirty,
  }));
  return { rows: projected, counts: {
    total: projected.length,
    todo: projected.filter(row => row.needsAction).length,
    amber: projected.filter(row => row.tone === "amber").length,
    red: projected.filter(row => row.tone === "red").length,
    published: projected.filter(row => row.published).length,
    eligible: projected.filter(row => row.eligible).length,
    duplicates: projected.filter(row => row.duplicateState === "exact").length,
    teachingPending: projected.filter(row => row.needsAction
      && row.issues.some(item => item.domain === "teaching" && (row.teachingState !== "adopted"
        || item.code === "teaching_publication_receipt_pending"))).length,
    sourcePending: projected.filter(row => row.needsAction && !row.published && row.duplicateState !== "exact"
      && row.issues.some(item => item.domain === "source")).length,
  } };
}
