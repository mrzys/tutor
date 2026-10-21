export type DisplayChoice = { label: string; text: string; [key: string]: unknown };

/** A reading projection only. Never normalize or persist OCR text here. */
export function choicePresentation(
  stem: string,
  options: DisplayChoice[],
  questionType: string,
  validImage: (source: string) => boolean,
) {
  const unchanged = { stem, options, extracted: false, ambiguous: false };
  if (options.length || !["single_choice", "multiple_choice"].includes(questionType)) return unchanged;
  // Paddle can preserve graph choices as image + standalone caption after each
  // image. Accept ONLY the complete terminal A/B/C/D sequence. Other layouts
  // remain intact: captions inside prose, missing/duplicate labels, mixed text,
  // unknown assets and a partial sequence must never be guessed into choices.
  const image = "(!\\[[^\\]\\n]*\\]\\((?:asset:)[^\\s)]+\\))";
  const suffix = new RegExp("(?:^|\\n)" + ["A", "B", "C", "D"].map(label => `${image}\\s*\\(${label}\\)`).join("\\s*") + "\\s*$");
  const found = stem.match(suffix);
  if (found && found.index !== undefined && stem.slice(0, found.index).trim()) {
    const texts = found.slice(1);
    const sources = texts.map(text => text.match(/\]\((asset:[^\s)]+)\)$/)?.[1] || "");
    const prefix = stem.slice(0, found.index).trimEnd();
    if (sources.length === 4 && new Set(sources).size === 4 && sources.every(validImage)
      && !/^\s*\([A-D]\)\s*$/m.test(prefix)) {
      return { stem: prefix, options: texts.map((text, index) => ({ label: "ABCD"[index], text })), extracted: true, ambiguous: false };
    }
  }
  return { ...unchanged, ambiguous: /\([A-D]\)/.test(stem) && (stem.match(/!\[[^\]\n]*\]\(/g) || []).length >= 4 };
}
