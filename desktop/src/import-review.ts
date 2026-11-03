import { teachingFindingMessage } from "./teaching-finding-display.ts";

// Imported source fields stay distinct from model annotation and old references.
// A missing answer/solution is not a review task and must never be filled in here.
export function requiredReviewChecks(question: any): string[] {
  const has = (field: string) => [question?.[field], ...(question?.parts || []).map((part: any) => part[field])]
    .some(value => typeof value === "string" && value.trim().length > 0);
  return ["sourceMatched", "formulaChecked",
    ...(has("answer") ? ["answerChecked"] : []),
    ...(has("solution") ? ["solutionChecked"] : []),
  ];
}

export const isChoiceQuestion = (question: any) => ["single_choice", "multiple_choice"].includes(question?.questionType);
export function sourceReviewLabel(question: any) {
  return isChoiceQuestion(question) ? "题干与选项" : "题干与小问";
}
export function sourceReviewDescription(question: any) {
  return isChoiceQuestion(question)
    ? "核对题号、条件、选项及小问，确认没有遗漏或串题。"
    : "核对题号、条件、小问及填空位置，确认没有遗漏或串题。";
}

// A short navigation aid, never a replacement for the stored opinion or the
// server's publication decision. The complete source-bound record stays intact.
export function briefReviewReasons(question: any, eligibilityReason = ""): string[] {
  const review = question?.modelReview;
  if (review?.status === "stale") return ["题目已修改，请重新检查"];
  if (review?.status === "failed") return ["检查未完成，请重试"];
  const short = (value: string) => {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    const chars = Array.from(text);
    return chars.length > 32 ? chars.slice(0, 31).join("") + "…" : text;
  };
  if (question?.teachingWorkflow && question.teachingWorkflow.status !== "ready_candidate" && eligibilityReason.startsWith("教学稿")) {
    return [short(eligibilityReason)];
  }
  const issues = Array.isArray(review?.issues) ? review.issues : [];
  const ordered = [...issues].sort((a: any, b: any) => Number(/answer|solution|analysis/.test(String(a?.field))) - Number(/answer|solution|analysis/.test(String(b?.field))));
  const labels = ordered.map((issue: any) => {
    const field = String(issue?.field || "").toLowerCase();
    const text = String(issue?.message || "");
    if (/image|figure|diagram/.test(field)) return "配图需核对";
    if (/table/.test(field)) return "表格需核对";
    if (/formula|math/.test(field)) return "公式需核对";
    if (/stem|prompt|part/.test(field)) return "题干或小问需核对";
    if (/option|choice/.test(field)) return isChoiceQuestion(question) ? "选项需核对" : "检查意见需复核";
    if (/answer/.test(field)) return "答案提取情况需核对";
    if (/solution|analysis/.test(field)) return "解析提取情况需核对";
    return short(text);
  }).filter(Boolean);
  const unique = [...new Set<string>(labels)];
  if (unique.length) return unique.slice(0, 1);
  return [short(eligibilityReason || review?.summary || "暂无检查意见")];
}

// Display only the separately persisted draft. Never fill source answer/solution.
export function importTeachingPresentation(question: any, controls?: TeachingReviewControls) {
  const workflow = question?.teachingWorkflow;
  if (!workflow || typeof workflow !== "object") return null;
  const ready = workflow.status === "ready_candidate" && workflow.reviewFailurePending !== true
    && (!controls || (/^[a-f0-9]{64}$/.test(controls.candidateSha256 || "")
      && workflow.sourceContentSha256 === controls.sourceContentSha256));
  const candidate = ready ? workflow.finalResult : workflow.candidateResult || workflow.reviewedCandidate || workflow.initialCandidate;
  const text = (value: unknown) => typeof value === "string" ? value : "";
  const findings = Array.isArray(workflow.findings) ? workflow.findings : [];
  const issueRows = teachingIssueRows(question, controls);
  const rawIssues = Array.isArray(candidate?.issues) ? candidate.issues : [];
  const acknowledgedIndices = new Set(issueRows.filter(item => item.acknowledged && item.disposition === "informative").map(item => item.issueIndex));
  const acknowledged = new Set<string>(rawIssues.filter((issue: unknown) => typeof issue === "string" && rawIssues.every((other: unknown, index: number) => other !== issue || acknowledgedIndices.has(index))));
  const activeIssues = [...new Set<string>([...findings.filter((finding: any) => finding?.type !== "model_issue" || !acknowledged.has(finding.issue)).map(teachingFindingMessage), ...rawIssues.filter((issue: unknown, index: number) => typeof issue === "string" && !acknowledgedIndices.has(index))].filter(Boolean))];
  return {
    ready: ready && activeIssues.length === 0,
    answer: text(candidate?.answer),
    solution: text(candidate?.teachingSolution),
    level: text(candidate?.difficultyAssessment?.level),
    basis: text(candidate?.difficultyAssessment?.basis),
    examFocus: text(candidate?.teachingFocus?.examFocus),
    studentRequirements: (Array.isArray(candidate?.teachingFocus?.studentRequirements) ? candidate.teachingFocus.studentRequirements : []).filter((value: unknown) => typeof value === "string"),
    issues: activeIssues,
    notices: issueRows.filter(item => item.acknowledged && item.disposition === "informative"),
  };
}

/** Display the available assessment without promoting AI prose to formal
 * knowledge IDs or solution paths. Persisted/manual annotation takes priority. */
export function importAssessmentPresentation(question: any, controls?: TeachingReviewControls) {
  const draft = importTeachingPresentation(question, controls);
  const ready = draft?.ready === true;
  const levels = ["easy", "easy_medium", "medium", "medium_hard", "hard"];
  const annotated = levels.includes(question?.difficultyAssessment?.level);
  const generated = ready && levels.includes(draft.level);
  const paths = Array.isArray(question?.solutionPaths) ? question.solutionPaths : [];
  return {
    level: annotated ? question.difficultyAssessment.level : generated ? draft.level : null,
    // A pending content estimate stays readable without becoming the effective
    // annotation. Ready estimates already use the existing level projection.
    candidateLevel: !ready && draft && levels.includes(draft.level) ? draft.level : null,
    basis: annotated ? question.difficultyAssessment.basis || "" : generated ? draft.basis : "",
    difficultyOrigin: annotated ? "已存标注" : generated ? "AI内容估计" : "",
    examFocus: question?.knowledgeMappingSource === "teacher_edit" && question?.task?.label?.trim()
      ? question.task.label : ready && draft.examFocus.trim() ? draft.examFocus : question?.task?.label || "",
    hasTeachingSolution: Boolean((ready && draft?.solution.trim()) || question?.solution?.trim()
      || question?.parts?.some((part: any) => part.solution?.trim())),
    teachingSolutionPending: Boolean(draft && !ready && draft.solution.trim()),
    paths,
    needsSupplement: question?.annotationStatus === "failed" || !annotated
      || !question?.primaryKnowledgeUids?.length || !question?.task?.label?.trim()
      || (ready && (question?._detailLoaded === false ? question._needsSolutionPathSupplement === true
        : Boolean(draft.solution.trim()) && !paths.length)),
  };
}

export type TeachingIssueRow = {
  issueIndex: number;
  issue: string;
  issueSha256: string;
  disposition: "blocking" | "informative";
  acknowledged: boolean;
  acknowledgeable: boolean;
  basis?: string;
};
export type TeachingReviewControls = {
  sourceContentSha256: string;
  candidateSha256: string;
  issues: TeachingIssueRow[];
  editableFields: { path: string; value: string }[];
  canPatch: boolean;
  canAcknowledge: boolean;
};
export const teachingPatchFieldLabel = (path: string) => ({
  answer: "生成答案",
  teachingSolution: "教学解析",
  "difficultyAssessment.basis": "难度依据",
  "teachingFocus.examFocus": "考点",
}[path] || (/^teachingFocus\.studentRequirements\[(\d+)\]$/.exec(path)
  ? `对学生的要求 ${Number(/^teachingFocus\.studentRequirements\[(\d+)\]$/.exec(path)![1]) + 1}` : "未支持的教学字段"));

const supportedTeachingTextPath = (path: string) => ["answer", "teachingSolution", "difficultyAssessment.basis", "teachingFocus.examFocus"].includes(path)
  || /^teachingFocus\.studentRequirements\[\d+\]$/.test(path);

/** Backend-projected dispositions only. Source issues and non-issue findings
 * never become informative here, and the original candidate is not mutated. */
export function teachingIssueRows(question: any, controls?: TeachingReviewControls): TeachingIssueRow[] {
  const workflow = question?.teachingWorkflow;
  const candidate = workflow?.status === "ready_candidate" ? workflow?.finalResult
    : workflow?.candidateResult || workflow?.reviewedCandidate || workflow?.initialCandidate;
  const raw = Array.isArray(candidate?.issues) ? candidate.issues : [];
  return raw.filter((issue: unknown) => typeof issue === "string").map((issue: string, issueIndex: number) => {
    const projected = controls?.issues?.find(item => item.issueIndex === issueIndex && item.issue === issue);
    return projected || { issueIndex, issue, issueSha256: "", disposition: "blocking", acknowledged: false, acknowledgeable: false };
  });
}

function teachingBinding(record: any, question: any, controls: TeachingReviewControls) {
  if (typeof record?.importId !== "string" || !Number.isSafeInteger(record?.revision) || !question?.questionId
    || !/^[a-f0-9]{64}$/.test(controls?.sourceContentSha256 || "")
    || !/^[a-f0-9]{64}$/.test(controls?.candidateSha256 || "")) throw new Error("教学稿版本信息不完整，请重新读取后再处理。");
  return { importId: record.importId, expectedRevision: record.revision, questionId: question.questionId,
    sourceContentSha256: controls.sourceContentSha256, candidateSha256: controls.candidateSha256 };
}

/** Construct one explicit acknowledgement. Rust rechecks all evidence and
 * bindings; this is neither local approval nor source-review bypass. */
export function teachingAcknowledgementPayload(record: any, question: any, controls: TeachingReviewControls,
  issue: TeachingIssueRow, kind: string, basis: string, checks: Record<string, boolean>) {
  const bound = teachingBinding(record, question, controls);
  const current = teachingIssueRows(question, controls).find(row => row.issueIndex === issue.issueIndex && row.issueSha256 === issue.issueSha256 && row.issue === issue.issue);
  if (!controls.canAcknowledge || !current?.acknowledgeable || current.acknowledged || !["reference_notice", "nonblocking_observation"].includes(kind)
    || !basis.trim() || !["sourceMatched", "answerChecked", "solutionChecked", "formulaChecked"].every(key => checks[key] === true)) {
    throw new Error("请核对当前这条意见，完成核对项并填写具体依据。");
  }
  return { ...bound, issueIndex: current.issueIndex, issueSha256: current.issueSha256, kind, basis: basis.trim(),
    checks: { sourceMatched: true, answerChecked: true, solutionChecked: true, formulaChecked: true } };
}

/** Exact current field replacement only. No source fields, issue erasure,
 * whole-object edits, path widening or inference about mathematical validity. */
export function teachingPatchPayload(record: any, question: any, controls: TeachingReviewControls,
  fieldPath: string, oldText: string, newText: string, basis: string) {
  const bound = teachingBinding(record, question, controls);
  const field = controls.editableFields?.find(item => item.path === fieldPath);
  if (!controls.canPatch || !supportedTeachingTextPath(fieldPath) || !field || field.value !== oldText
    || newText === oldText || !newText.trim() || !basis.trim()) throw new Error("请仅修订当前所选教学字段，并核对修改内容及依据。");
  return { ...bound, patches: [{ fieldPath, oldText, newText }], basis: basis.trim() };
}

export function hasUnstartedTeaching(question: any): boolean {
  const workflow=question?.teachingWorkflow;
  if (!workflow || workflow.status === "ready_candidate" || Number(workflow.reviewCalls) > 0) return false;
  if ((workflow.findings || []).some((finding: any) => ["source_changed","generation_interrupted","review_interrupted"].includes(finding?.code))) return false;
  if (workflow.status === "generation_pending") return Number(workflow.generationCalls || 0) === 0;
  if (workflow.status === "generation_failed") return workflow.reviewEligible === true;
  return workflow.status === "needs_review";
}
