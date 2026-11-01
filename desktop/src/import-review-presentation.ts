import type { TriageIssue, TriageTone } from "./import-triage.ts";

/** A reading-only grouping, never a replacement for the original gate findings.
 * Members retain their original identities, bindings and individual locations. */
export type ReviewIssueGroup = {
  id: string;
  domain: TriageIssue["domain"];
  tone: TriageTone;
  title: string;
  message: string;
  members: readonly TriageIssue[];
  locatableIssues: readonly TriageIssue[];
  fieldLabels: readonly string[];
};

/** Rust-validated, version-bound display notes; never publication approval. */
export type SourceCorrectionDisplay = {
  schemaVersion: 1;
  status: "corrected_pending_confirmation";
  kind: "ocr_transcription" | "transcription_adjustment";
  fieldPath: string;
  issueIndex: number;
  issueField: string;
  issueMessage: string;
  sourceContentSha256: string;
  fieldValueSha256: string;
  evidencePage: number;
  method: "user_authorized_agent_review" | "model_review";
  checkedBy: string;
  checkedAt: string;
  basis: string;
};

export function sourceCorrectionForGroup(group: ReviewIssueGroup,
  notes: readonly SourceCorrectionDisplay[] = [], dirty = false): SourceCorrectionDisplay | undefined {
  if (dirty || group.domain !== "source" || !group.members.length) return;
  const matches = group.members.map(issue => notes.filter(note => note.schemaVersion === 1
    && note.status === "corrected_pending_confirmation"
    && issue.id === `source:review-${note.issueIndex}` && issue.message === note.issueMessage));
  if (matches.some(items => items.length !== 1)) return;
  // A grouped card cannot hide an unrelated unresolved concern or conflate
  // a literal OCR repair with an editorial change to the original paper.
  if (matches.some(items => items[0].kind !== matches[0][0].kind)) return;
  return matches[0][0];
}

export function reviewTermLabel(term: string): string {
  return new Map([
    ["\\int", "积分记号"], ["\\lim", "极限记号"], ["\\pmod", "同余记号"],
    ["\\bmod", "同余记号"], ["\\det", "行列式记号"],
  ]).get(term) || term;
}

export function reviewDisplayMessage(message: string): string {
  const prefix = "仍含需复核术语“";
  return message.startsWith(prefix) && message.endsWith("”")
    ? `需核对：${reviewTermLabel(message.slice(prefix.length, -1))}` : message;
}

const processCodes = new Set(["model_request_timeout", "model_response_timeout", "model_output_invalid_json",
  "model_output_truncated", "model_output_empty", "invalid_teaching_patch", "teaching_patch_unresolved",
  "revision_conflict", "generation_interrupted", "review_interrupted"]);

/** Exact protocol/transport failures appear in the current-state explanation,
 * rather than masquerading as a second mathematical editing task. */
export function isReviewProcessGroup(group: ReviewIssueGroup, retainedFailureCode = ""): boolean {
  return group.domain === "teaching" && group.members.length > 0 && group.members.every(issue =>
    issue.type === "technical" && (processCodes.has(issue.code || "") || Boolean(retainedFailureCode) && issue.code === retainedFailureCode)
    || ["teaching:review-failed", "teaching:workflow-state", "teaching:adoption-state"].includes(issue.id));
}

const fieldNames = new Map<string, string>([
  ["stem", "题干"],
  ["questionType", "题型"],
  ["teachingSolution", "教学解析"],
  ["difficultyAssessment.level", "难度"],
  ["difficultyAssessment.basis", "难度依据"],
  ["teachingFocus.examFocus", "考查点"],
  ["teachingFocus.studentRequirements", "对学生的要求"],
  ["primaryKnowledgeUids", "主考知识点"],
]);

/** Labels describe canonical fields only. Unknown paths are not guessed from
 * an issue's wording and internal identifiers are not shown as user copy. */
export function reviewFieldLabel(path: string | undefined, domain: TriageIssue["domain"] = "teaching"): string {
  if (path === "answer") return domain === "source" ? "原卷答案" : "生成答案";
  if (path === "solution") return "原卷解析";
  const known = fieldNames.get(path || "");
  if (known) return known;
  if (/^options\[\d+\]\.text$/.test(path || "")) return "选项";
  if (/^parts\[\d+\]\.(prompt|stem)$/.test(path || "")) return "小问题干";
  if (/^parts\[\d+\]\.answer$/.test(path || "")) return "小问答案";
  if (/^parts\[\d+\]\.solution$/.test(path || "")) return "小问解析";
  if (/^teachingFocus\.studentRequirements\[\d+\]$/.test(path || "")) return "对学生的要求";
  if (/^solutionPaths\[\d+\]\.requiredKnowledgeUids$/.test(path || "")) return "解法所需知识";
  if (/^solutionPaths\[\d+\]\.requiredPremises$/.test(path || "")) return "解法所需前提";
  return domain === "source" ? "原题内容" : "解析内容";
}

const codeTitles = new Map<string, string>([
  ["literal_newline_escape", "修复换行排版"],
  ["control_character", "修复异常字符"],
  ["unpaired_math_delimiter", "修复公式排版"],
  ["mixed_math_delimiter", "修复公式排版"],
  ["incomplete_teaching_draft", "补充解析内容"],
  ["invalid_annotation", "检查考查信息"],
  ["teaching_generation_pending", "生成课堂解析"],
  ["source_changed", "重新核对解析"],
  ["generation_interrupted", "解析生成未完成"],
  ["review_interrupted", "解析复核未完成"],
  ["model_request_timeout", "模型连接超时"],
  ["model_response_timeout", "模型响应超时"],
  ["teaching_review_failed_retained_initial", "解析复核未完成"],
  ["teaching_classroom_rewrite_required", "调整为高中课堂解法"],
]);

function titleFor(members: readonly TriageIssue[], fields: readonly string[]): string {
  const term = members.find(item => item.type === "term");
  if (term) {
    // This is display copy emitted by teachingFindingMessage, not a semantic
    // classification based on arbitrary model prose. Preserve the full message.
    const prefix = "仍含需复核术语“";
    if (term.message.startsWith(prefix) && term.message.endsWith("”")) {
      return `检查术语“${reviewTermLabel(term.message.slice(prefix.length, -1))}”`;
    }
    return "检查课堂术语";
  }
  for (const member of members) {
    const title = codeTitles.get(member.code || "");
    if (title) return title;
  }
  if (fields.length === 1) return fields[0] === "对学生的要求" ? "核对学生要求" : `核对${fields[0]}`;
  if (members.some(item => item.type === "display")) return "修复公式与排版";
  if (members.some(item => item.type === "format")) return "检查内容结构";
  if (members.some(item => item.type === "technical")) return "处理过程未完成";
  return members[0]?.domain === "source" ? "核对原题疑点" : "核对解析疑点";
}

const toneRank: Record<TriageTone, number> = { neutral: 0, amber: 1, red: 2 };

/** Combine only exact repeated display messages within the same domain.
 * Different fields and occurrences remain in members and locatableIssues;
 * presentation grouping grants no acknowledgement or publication permission. */
export function groupReviewIssues(issues: readonly TriageIssue[]): ReviewIssueGroup[] {
  const byMessage = new Map<string, TriageIssue[]>();
  for (const issue of issues) {
    const key = JSON.stringify([issue.domain, issue.message]);
    const members = byMessage.get(key);
    if (members) members.push(issue);
    else byMessage.set(key, [issue]);
  }
  return [...byMessage.values()].map(members => {
    const first = members[0];
    const locatableIssues = members.filter(item => item.target && item.location !== "unavailable");
    const fieldLabels = [...new Set(locatableIssues.map(item => reviewFieldLabel(item.target!.fieldPath, item.domain)))];
    const tone = members.reduce<TriageTone>((value, item) => toneRank[item.tone] > toneRank[value] ? item.tone : value, first.tone);
    return {
      id: first.id,
      domain: first.domain,
      tone,
      title: titleFor(members, fieldLabels),
      message: first.message,
      members,
      locatableIssues,
      fieldLabels,
    };
  });
}

/** This exact local projection identity denotes a review outcome, not an
 * additional content-repair task. Do not classify model prose as an outcome. */
export function isReviewOutcomeGroup(group: ReviewIssueGroup): boolean {
  return group.members.length > 0 && group.members.every(issue => issue.id === "teaching:review-failed");
}
