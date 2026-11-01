import { mathSegments } from "./shared/math-segments.mjs";
import type { TriageIssue } from "./import-triage.ts";

export type ReviewTextBinding = { candidateSha256: string; sourceContentSha256: string };
export type ReviewTextRun = { text: string; start: number; end: number; issueIds: string[] };
export type ReviewTextMarks = {
  runs: ReviewTextRun[];
  fieldIssueIds: string[];
  unlocatedIssueIds: string[];
  fallback: "rich_structure" | "display_projection" | null;
};

const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const unique = (values: string[]) => [...new Set(values)];
const splitSurrogate = (text: string, at: number) => at > 0 && at < text.length
  && /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at]);
type MarkRange = { start: number; end: number; issueIds: string[] };

function mergeRanges(ranges: MarkRange[]): MarkRange[] {
  const result: MarkRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = result.at(-1);
    if (previous && range.start < previous.end) {
      previous.end = Math.max(previous.end, range.end);
      previous.issueIds = unique([...previous.issueIds, ...range.issueIds]);
    } else result.push({ ...range, issueIds: [...range.issueIds] });
  }
  return result;
}

function sourceRuns(source: string, ranges: MarkRange[]): ReviewTextRun[] {
  const result: ReviewTextRun[] = [];
  let from = 0;
  for (const range of ranges) {
    if (from < range.start) result.push({ text: source.slice(from, range.start), start: from, end: range.start, issueIds: [] });
    result.push({ text: source.slice(range.start, range.end), ...range });
    from = range.end;
  }
  if (from < source.length || !result.length) result.push({ text: source.slice(from), start: from, end: source.length, issueIds: [] });
  return result;
}

/** These fields are ordinarily prose plus formulae. Rich structures continue
 * through the original renderer as one unit: guessing cell/image/code offsets
 * would be worse than an explicit field-level review note. */
function needsWholeRenderer(text: string): boolean {
  return mathSegments(text).some(part => part.type === "text" && (
    /<!--[\s\S]*?-->|<\/?[a-z][\w:-]*(?:\s[^<>]*|\/)?>/i.test(part.raw)
    || /!\[|\[[^\]\n]+\]\(|`|\||&(?:#x[\da-f]+|#\d+|[a-z]+);/i.test(part.raw)
    // Unpaired math delimiters cannot be split into safely renderable atoms.
    || /(?<!\\)\$|\\[()[\]]/.test(part.raw)
  ));
}

/** Input issues must already come from import-triage's version-bound targets.
 * Optional current binding narrows that contract again. This is a read-only
 * display projection, never an acknowledgement or a publication decision. */
export function reviewTextMarks(text: string, fieldPath: string, issues: readonly TriageIssue[],
  binding?: ReviewTextBinding, projectText: (value: string) => string = value => value): ReviewTextMarks {
  const source = typeof text === "string" ? text : "";
  const relevant = issues.filter(issue => issue.domain === "teaching" && issue.target?.domain === "teaching"
    && issue.target.fieldPath === fieldPath && digest(issue.target.candidateSha256) && digest(issue.target.sourceContentSha256)
    && (!binding || issue.target.candidateSha256 === binding.candidateSha256
      && issue.target.sourceContentSha256 === binding.sourceContentSha256));
  const fieldIssueIds = unique(relevant.map(issue => issue.id));
  const whole = (fallback: ReviewTextMarks["fallback"]): ReviewTextMarks => ({
    runs: [{ text: projectText(source), start: 0, end: source.length, issueIds: [] }],
    fieldIssueIds, unlocatedIssueIds: [...fieldIssueIds], fallback,
  });
  if (!relevant.length) return whole(null);
  if (needsWholeRenderer(source)) return whole("rich_structure");
  let offset = 0;
  const atoms = mathSegments(source).map(part => {
    const start = offset;
    offset += part.raw.length;
    return { start, end: offset, math: part.type === "math" };
  });
  const unlocatedIssueIds: string[] = [];
  const ranges: MarkRange[] = [];
  for (const issue of relevant) {
    const start = issue.target?.start, end = issue.target?.end;
    if (issue.location !== "range" || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start! < 0 || end! <= start! || end! > source.length || splitSurrogate(source, start!) || splitSurrogate(source, end!)) {
      unlocatedIssueIds.push(issue.id);
      continue;
    }
    // Mark the entire formula if even one command is flagged. KaTeX therefore
    // receives exactly the original complete formula, never fragments of it.
    const touched = atoms.filter(atom => atom.math && atom.start < end! && atom.end > start!);
    ranges.push({ start: Math.min(start!, ...touched.map(atom => atom.start)),
      end: Math.max(end!, ...touched.map(atom => atom.end)), issueIds: [issue.id] });
  }
  const merged = mergeRanges(ranges);
  const projectRuns = (items: MarkRange[]) => sourceRuns(source, items).map(run => ({ ...run, text: projectText(run.text) }));
  let projected = projectRuns(merged);
  // Readability projections may depend on neighbouring formulae/newlines.
  // The known layout-only case can keep its single adjacent newline inside
  // the formula's mark. Accept it only if the complete projected output is
  // exactly unchanged; arbitrary cross-word/structure changes still fall back.
  if (projected.map(run => run.text).join("") !== projectText(source)) {
    const layoutRanges = merged.map(range => {
      if (!atoms.some(atom => atom.math && atom.start >= range.start && atom.end <= range.end)) return range;
      const before = source.slice(0, range.start), after = source.slice(range.end);
      const left = !/\r?\n[ \t]*\r?\n[ \t]*$/.test(before) ? before.match(/[ \t]*\r?\n[ \t]*$/)?.[0].length || 0 : 0;
      const right = after.match(/^[ \t]*\r?\n(?![ \t]*\r?\n)[ \t]*/)?.[0].length || 0;
      return { ...range, start: range.start - left, end: range.end + right };
    });
    projected = projectRuns(mergeRanges(layoutRanges));
    if (projected.map(run => run.text).join("") !== projectText(source)) return whole("display_projection");
  }
  return { runs: projected, fieldIssueIds, unlocatedIssueIds: unique(unlocatedIssueIds), fallback: null };
}
