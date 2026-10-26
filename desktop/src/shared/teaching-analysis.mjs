import { frozenAnnotation } from "./assembly-evidence.mjs";

// Publication validation belongs to Rust. This projection only recognizes its
// source/candidate-bound acknowledgement record; a severity word or an issues
// array supplied by a client is never sufficient to hide a warning here.
function acknowledgedTeachingNotices(analysis, issues) {
  const dispositions = analysis.reviewDispositions;
  const candidate = analysis.sourceCandidate;
  if (analysis.status !== "ready" || dispositions?.version !== 1 || !candidate || typeof candidate !== "object"
    || !/^[a-f0-9]{64}$/.test(dispositions.sourceContentSha256 || "")
    || !/^[a-f0-9]{64}$/.test(dispositions.candidateSha256 || "")
    || JSON.stringify(candidate.issues) !== JSON.stringify(issues)
    || candidate.teachingSolution !== analysis.solution || candidate.answer !== analysis.answer
    || JSON.stringify(candidate.teachingFocus) !== JSON.stringify(analysis.teachingFocus)
    || !Array.isArray(dispositions.acknowledgements)) return [];
  return issues.flatMap((message, issueIndex) => {
    const matches = dispositions.acknowledgements.filter(item => item?.issueIndex === issueIndex);
    if (matches.length !== 1) return [];
    const item = matches[0];
    if (item.message !== message || !/^[a-f0-9]{64}$/.test(item.issueSha256 || "")
      || !["reference_notice", "nonblocking_observation"].includes(item.classification)
      || typeof item.basis !== "string" || !item.basis.trim()
      || !["teacher_review", "user_authorized_agent_review"].includes(item.method)
      || typeof item.checkedBy !== "string" || !item.checkedBy
      || !["sourceMatched", "answerChecked", "solutionChecked", "formulaChecked"].every(key => item.checks?.[key] === true)) return [];
    return [{ issueIndex, message, basis: item.basis, classification: item.classification,
      reviewerLabel: item.method === "user_authorized_agent_review" ? "授权代理核对" : "人工核对" }];
  });
}

/** Teacher-only projection of a backend-validated, version-bound AI draft.
 * Keep the original text intact for the same rich-text renderer as reference
 * solutions. The persisted sha256 is verified by Rust, not reinterpreted here.
 */
export function teachingAnalysisPresentation(question, teacher = false) {
  if (teacher !== true || !question || typeof question !== "object") return null;
  const analysis = question.teachingAnalysis;
  if (!analysis || analysis.provenance !== "llm_generated" ||
      !["ready", "needs_review"].includes(analysis.status) ||
      typeof question.contentVersion !== "string" || !question.contentVersion ||
      typeof question.teacherVersion !== "string" || !question.teacherVersion ||
      analysis.baseContentVersion !== question.contentVersion ||
      analysis.baseTeacherVersion !== question.teacherVersion ||
      typeof analysis.solution !== "string" || !analysis.solution.trim()) return null;
  const issues = Array.isArray(analysis.issues)
    ? analysis.issues.filter(issue => typeof issue === "string" && issue.trim())
    : [];
  const notices = acknowledgedTeachingNotices(analysis, issues);
  const acknowledgedIndices = new Set(notices.map(item => item.issueIndex));
  const blockingIssues = issues.filter((_, index) => !acknowledgedIndices.has(index));
  const needsReview = analysis.status === "needs_review" || blockingIssues.length > 0;
  return {
    label: "AI教学解析",
    originLabel: "AI 生成",
    model: typeof analysis.model === "string" ? analysis.model : "",
    answer: typeof analysis.answer === "string" ? analysis.answer : "",
    solution: analysis.solution,
    status: needsReview ? "needs_review" : "ready",
    statusLabel: needsReview ? "待复核" : "",
    needsReview,
    issues: blockingIssues,
    notices,
  };
}

/** Resolve formal knowledge from the paper's own version-bound snapshots.
 * Never read a newer bank annotation or use AI prose as a catalogue mapping. */
export function frozenTeachingKnowledge(question, snapshot, catalogue) {
  const annotation = frozenAnnotation(question, snapshot);
  if (!Array.isArray(annotation?.primaryKnowledgeUids)) return [];
  const points = catalogue?.knowledgeCatalogue?.points;
  return annotation.primaryKnowledgeUids.map(uid => {
    const name = Array.isArray(points) ? points.find(point => point.uid === uid)?.name : undefined;
    return typeof name === "string" && name.trim() ? name : "知识点名称未记录";
  });
}

/** New focus stores only the task and requirements. Formal knowledge is a
 * display projection; old frozen drafts retain their original AI focus. */
export function teachingFocusPresentation(question, teacher = false, formalKnowledge = []) {
  const analysis = teachingAnalysisPresentation(question, teacher);
  if (!analysis) return null;
  if (Object.hasOwn(question.teachingAnalysis, "teachingFocusSchemaVersion") &&
      question.teachingAnalysis.teachingFocusSchemaVersion !== 2) return null;
  const focus = question.teachingAnalysis.teachingFocus;
  if (!focus || typeof focus !== "object" || Array.isArray(focus)) return null;
  const textItems = value => Array.isArray(value)
    ? value.filter(item => typeof item === "string" && item.trim())
    : [];
  return {
    knowledgePoints: textItems(question.teachingAnalysis.teachingFocusSchemaVersion === 2
      ? formalKnowledge : focus.knowledgePoints),
    knowledgeLabel: question.teachingAnalysis.teachingFocusSchemaVersion === 2 ? "主考知识" : "考查知识点",
    examFocusLabel: question.teachingAnalysis.teachingFocusSchemaVersion === 2 ? "考查任务" : "考点",
    examFocus: typeof focus.examFocus === "string" ? focus.examFocus : "",
    studentRequirements: textItems(focus.studentRequirements),
    model: analysis.model,
    originLabel: analysis.originLabel,
    needsReview: analysis.needsReview,
    statusLabel: analysis.statusLabel,
  };
}
