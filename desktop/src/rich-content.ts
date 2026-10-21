import { paperTextBlocks } from "./shared/rich-text.mjs";

export type ImageReference = { source: string; alt: string };
export type InlineContent =
  | { type: "text"; text: string }
  | { type: "image"; reference: ImageReference }
  | { type: "missing-image"; reference: ImageReference };
const marker = /\uE000TUTOR_IMAGE_(\d+)\uE001/g;
const math = /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)/g;

function entities(value: string) {
  return value.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|nbsp|quot|apos);/gi,
    (all, name: string) => {
      const named: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        nbsp: " ",
        quot: '"',
        apos: "'",
      };
      if (!name.startsWith("#")) return named[name.toLowerCase()] ?? all;
      const code =
        name[1].toLowerCase() === "x"
          ? parseInt(name.slice(2), 16)
          : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    },
  );
}
function attribute(tag: string, name: string) {
  const found = tag.match(
    new RegExp(
      `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
      "i",
    ),
  );
  return entities(found?.[1] ?? found?.[2] ?? found?.[3] ?? "");
}
function plainHtml(text: string) {
  return text
    .split(math)
    .map((part, index) =>
      index % 2
        ? part
        : entities(
            part
              .replace(/<br\s*\/?>/gi, "\n")
              .replace(/<\/(?:p|div|li|h[1-6])\s*>/gi, "\n")
              .replace(
                /<!--[\s\S]*?-->|<\/?[a-z][\w:-]*(?:\s[^<>]*|\/)?>/gi,
                "",
              ),
          ),
    )
    .join("");
}

/** HTML is never inserted into DOM. Preserve image positions with opaque text
 * markers while the shared parser handles Markdown/HTML tables and spans. */
export function richContent(text: unknown) {
  const references: ImageReference[] = [];
  const input = String(text || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  const consumed = new Set<number>();
  const protectedText = input
    .split(math)
    .map((part, index) => {
      if (index % 2) return part;
      return part.replace(
        /!\[([^\]\n]*)\]\(\s*(?:<([^>\n]*)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\s*\)|<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi,
        (whole, alt, angleSource, source) => {
          const reference = whole.startsWith("<")
            ? { source: attribute(whole, "src"), alt: attribute(whole, "alt") }
            : {
                source: entities(angleSource ?? source ?? ""),
                alt: entities(alt || ""),
              };
          const id = references.push(reference) - 1;
          return `\uE000TUTOR_IMAGE_${id}\uE001`;
        },
      );
    })
    .join("");
  function inline(value: string): InlineContent[] {
    const clean = plainHtml(value);
    const result: InlineContent[] = [];
    let start = 0;
    for (const match of clean.matchAll(marker)) {
      if (match.index! > start)
        result.push({ type: "text", text: clean.slice(start, match.index) });
      const reference = references[Number(match[1])];
      if (reference) {
        result.push({ type: "image", reference });
        consumed.add(Number(match[1]));
      } else result.push({ type: "text", text: match[0] });
      start = match.index! + match[0].length;
    }
    if (start < clean.length)
      result.push({ type: "text", text: clean.slice(start) });
    return result;
  }
  const blocks = paperTextBlocks(protectedText).map((block: any) =>
    block.type === "table"
      ? {
          ...block,
          rows: block.rows.map((row: any[]) =>
            row.map((cell) => ({ ...cell, content: inline(cell.text) })),
          ),
        }
      : { ...block, content: inline(block.text) },
  );
  // Unsupported table markup must never make a registered real image disappear.
  // Keep a visible blocking error instead of guessing where that image belongs.
  for (const [index, reference] of references.entries()) {
    if (!consumed.has(index))
      blocks.push({
        type: "text",
        content: [{ type: "missing-image", reference }],
      });
  }
  return { references, blocks };
}

export function assetReferences(question: any, teacher = false): any[] {
  const student = (
    Array.isArray(question?.student?.assets) ? question.student.assets : []
  ).map((asset: any) => ({ ...asset, role: "student" }));
  const extra = (
    teacher && Array.isArray(question?.teacher?.assets)
      ? question.teacher.assets
      : []
  ).map((asset: any) => ({ ...asset, role: "teacher" }));
  return [...student, ...extra].filter(
    (item, index, array) =>
      item &&
      array.findIndex((other) => assetKey(other) === assetKey(item)) === index,
  );
}
export const assetKey = (asset: any) =>
  [asset?.role, asset?.assetId, asset?.path, asset?.sha256].join(":");
function normalized(value: unknown) {
  let result = entities(String(value || "").trim())
    .replace(/^<|>$/g, "")
    .replace(/\\/g, "/");
  try {
    result = decodeURIComponent(result);
  } catch {
    /* Non-URI local identifiers remain exact. */
  }
  return result.replace(/^asset:(?:\/\/)?/i, "").replace(/^\.\//, "");
}
export function resolveAsset(
  question: any,
  reference: ImageReference,
  teacher = false,
) {
  const source = normalized(reference.source);
  const allowed = assetReferences(question, teacher);
  let matches = allowed.filter((item) =>
    [item.assetId, item.path].some(
      (key) => normalized(key) === source && source,
    ),
  );
  if (!matches.length && source && !/^[a-z][\w+.-]*:/i.test(source)) {
    const filename = source.split("/").at(-1);
    matches = allowed.filter(
      (item) => normalized(item.path).split("/").at(-1) === filename,
    );
  }
  // A teacher image cannot be resolved from a student's text, even if payloads
  // contain both versions. Ambiguous names fail instead of guessing a picture.
  if (matches.length !== 1) return null;
  return matches[0];
}
export function inlineAssetIds(
  question: any,
  teacher = false,
  displayedStem?: string,
) {
  const texts = [
    displayedStem ?? question?.student?.stem,
    ...(question?.student?.options || []).map((item: any) => item.text),
    ...(question?.student?.parts || []).map((item: any) => item.prompt),
  ];
  if (teacher)
    for (const field of ["answers", "solutions", "scoringSuggestions"])
      texts.push(
        ...(question?.teacher?.[field] || []).map((item: any) => item.text),
      );
  return new Set(
    texts
      .flatMap((text) =>
        richContent(text)
          .blocks.flatMap((block: any) =>
            block.type === "table"
              ? block.rows.flatMap((row: any[]) =>
                  row.flatMap((cell) => cell.content),
                )
              : block.content,
          )
          .filter((item: InlineContent) => item.type === "image")
          .map((item: { reference: ImageReference }) => {
            const reference = item.reference;
            const asset = resolveAsset(question, reference, teacher);
            return asset ? assetKey(asset) : "";
          }),
      )
      .filter(Boolean),
  );
}

export async function waitForPaperAssets(
  root: ParentNode = document,
  timeout = 15000,
) {
  const started = performance.now();
  while (root.querySelector("[data-asset-pending]")) {
    if (performance.now() - started > timeout)
      throw new Error("配图加载超时，未生成 PDF。请重试。");
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  }
  if (root.querySelector("[data-missing-asset]"))
    throw new Error("试卷配图未完整加载，未生成 PDF。");
  const images = Array.from(root.querySelectorAll("img"));
  await Promise.all(images.map((image) => image.decode()));
  if (images.some((image) => !image.complete || !image.naturalWidth))
    throw new Error("试卷配图未完整加载，未生成 PDF。");
}
