import difficultyRubric from "../resources/difficulty-rubric.json" with { type: "json" };

const labels: Record<string, string> = Object.fromEntries(difficultyRubric.levels.map(level => [level.id, level.label]));

// Product-facing model explanations use Chinese difficulty names. The original
// response, persisted text and developer logs stay intact; math stays verbatim.
export function teachingDisplayText(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  return text.split(/(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\])/g)
    .map((part, index) => index % 2 ? part : part.replace(/\b(easy_medium|medium_hard|easy|medium|hard)\b/g, id => labels[id] || id))
    .join("");
}
