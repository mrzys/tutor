import difficultyRubric from "../resources/difficulty-rubric.json" with { type: "json" };
import { mathSegments } from "./shared/math-segments.mjs";

const labels: Record<string, string> = Object.fromEntries(difficultyRubric.levels.map(level => [level.id, level.label]));

// Product-facing model explanations use Chinese difficulty names. The original
// response, persisted text and developer logs stay intact; math stays verbatim.
export function teachingDisplayText(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  return text.split(/(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\])/g)
    .map((part, index) => index % 2 ? part : part.replace(/\b(easy_medium|medium_hard|easy|medium|hard)\b/g, id => labels[id] || id))
    .join("");
}

/** Reading-only typography for generated explanations. Simple display formulas
 * flow with the sentence; long/multiline derivations retain display layout.
 * Never use this projection when saving, comparing patches or exporting PDF. */
export function compactTeachingText(value: unknown): string {
  const parts = mathSegments(typeof value === "string" ? value : "");
  const compact = parts.map(part => part.type === "math" && part.displayMode
    && part.source.trim().length <= 90 && !/[\r\n]|\\\\|\\(?:begin|end|tag|label|overset|underset)\b/.test(part.source.trim())
    && !part.source.includes("\\)"));
  return parts.map((part, index) => {
    if (compact[index] && part.type === "math") return `\\(${part.source.trim()}\\)`;
    if (part.type === "math") return part.raw;
    let text = part.raw;
    // Collapse a formula's single layout newline, keeping paragraph breaks.
    if (compact[index - 1]) text = text.replace(/^[ \t]*\r?\n(?![ \t]*\r?\n)[ \t]*/, " ");
    if (compact[index + 1] && !/\r?\n[ \t]*\r?\n[ \t]*$/.test(text)) text = text.replace(/[ \t]*\r?\n[ \t]*$/, " ");
    return text;
  }).join("");
}
