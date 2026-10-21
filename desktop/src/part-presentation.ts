const romanOrdinals = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX"];
const ordinalToken = "([0-9０-９]{1,2}|[IVXLCDMivxlcdmⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫⅰⅱⅲⅳⅴⅵⅶⅷⅸⅹⅺⅻ]{1,7})";
const promptHeading = new RegExp(`^\\s*[（(]\\s*${ordinalToken}\\s*[）)](?=\\s|[\\u3400-\\u9fff$\\\\])`, "u");
const standaloneLabel = new RegExp(`^\\s*(?:[（(]\\s*${ordinalToken}\\s*[）)]|${ordinalToken}[.、]?)\\s*$`, "u");

function ordinal(token: string | undefined): number | undefined {
  if (!token) return undefined;
  const normalized = token.normalize("NFKC").toUpperCase();
  if (/^\d{1,2}$/.test(normalized)) return Number(normalized);
  const index = romanOrdinals.indexOf(normalized);
  return index < 0 ? undefined : index + 1;
}

/** Suppress a duplicate UI prefix; the original prompt is never modified. */
export function partDisplayLabel(label: unknown, prompt: unknown, index: number): string {
  const originalLabel = typeof label === "string" ? label : "";
  const prefix = String(prompt || "").normalize("NFKC").match(promptHeading);
  const sourceOrdinal = ordinal(prefix?.[1]);
  if (sourceOrdinal !== undefined) {
    // Without an explicit source label, the prompt's own heading wins over an
    // invented sequential number, even when the source starts with (II).
    if (!originalLabel.trim()) return "";
    const explicit = originalLabel.normalize("NFKC").match(standaloneLabel);
    const explicitOrdinal = ordinal(explicit?.[1] || explicit?.[2]);
    if (explicitOrdinal === sourceOrdinal) return "";
  }
  return originalLabel || `（${index + 1}）`;
}
