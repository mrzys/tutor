import type { TriageIssue } from "./import-triage.ts";
import type { ImportTeachingStatus } from "./import-teaching-status.ts";

export type TeachingPanel = "solution" | "assessment";
export function teachingFieldPanel(path: string | undefined): TeachingPanel | null {
  if (/^(difficultyAssessment|teachingFocus)\./.test(path || "")) return "assessment";
  if (path === "answer" || path === "teachingSolution") return "solution";
  return null;
}

/** Placement only. Keep every original finding and the server's review state.
 * A transport failure has no field; never guess one from arbitrary prose. */
export function teachingIssuePresentation(issues: readonly TriageIssue[]) {
  const teaching = issues.filter(issue => issue.domain === "teaching"
    && !["teaching:review-failed", "teaching:workflow-state", "teaching:adoption-state"].includes(issue.id));
  const panelFor = (issue: TriageIssue) => teachingFieldPanel(issue.target?.fieldPath)
    || (issue.code === "invalid_annotation" ? "assessment" : null);
  const solution = teaching.filter(issue => panelFor(issue) === "solution");
  const assessment = teaching.filter(issue => panelFor(issue) === "assessment");
  const general = teaching.filter(issue => panelFor(issue) === null);
  return { solution, assessment, general, assessmentOnly: assessment.length > 0 && !solution.length && !general.length };
}

/** A content-specific label must never hide a simultaneous transport failure,
 * source invalidation, publication receipt or current operation. */
export function teachingStatusTitle(question: any, status: ImportTeachingStatus, presentation: ReturnType<typeof teachingIssuePresentation>): string {
  if (!presentation.assessmentOnly) return status.title;
  const workflow = question?.teachingWorkflow;
  const contentCodes = new Set(["invalid_annotation", "teaching_patch_unresolved", "review_findings_remaining"]);
  const findings = Array.isArray(workflow?.effectiveFindings) ? workflow.effectiveFindings : workflow?.findings || [];
  const retainedContentFailure = status.kind === "review_failed" && contentCodes.has(workflow?.retainedInitialReason)
    && Array.isArray(findings) && !findings.some((finding: any) => finding?.type === "technical"
      && !contentCodes.has(finding.code) && finding.code !== "teaching_review_failed_retained_initial");
  return ["content_issues", "review_pending"].includes(status.kind) || retainedContentFailure ? "考查信息待核对" : status.title;
}
