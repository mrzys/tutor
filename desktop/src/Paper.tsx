import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import katex from "katex";
import { Dynamic } from "solid-js/web";
// Pure parsers shared with the established preview/PDF boundary. Imported HTML
// is parsed into text/table data; only KaTeX-generated, trust:false HTML renders.
import {
  richContent,
  resolveAsset,
  inlineAssetIds,
  assetReferences,
  assetKey,
  type InlineContent,
} from "./rich-content";
import { questionSourcePresentation } from "./shared/source-label.mjs";
import { purposeLabel, typeTitles } from "./bridge";
import { AdaptiveOptions } from "./AdaptiveOptions";
import { choicePresentation } from "./choice-presentation";
import { partDisplayLabel } from "./part-presentation";
import { slotDifficulty } from "./assembly-details";

export function MathText(props: { text: any }) {
  // The existing native PDF layout is versioned separately. These readability
  // improvements target the interactive workspaces, not archived print layout.
  const exportLayout = new URLSearchParams(window.location.search).has("exportTask");
  const pieces = createMemo(() =>
    String(props.text || "").split(/(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)/g),
  );
  return (
    <For each={pieces()}>
      {(part) => {
        if (!part.startsWith("$") || !part.endsWith("$") || part.length < 3)
          return <For each={exportLayout ? [part] : part.split(/([△▵](?=\s*[A-Z]{3}(?![A-Z])))/u)}>{text =>
            !exportLayout && /^[△▵]$/u.test(text) ? <span class="math-inline geometry-triangle" innerHTML={katex.renderToString("\\bigtriangleup", { trust: false, throwOnError: false })} /> : <>{text}</>
          }</For>;
        const displayMode = part.startsWith("$$");
        const source = part.slice(displayMode ? 2 : 1, displayMode ? -2 : -1);
        // Inline text-style fractions shrink numerators twice. Use readable
        // math layout without rewriting the stored source or explicit \tfrac.
        const readable = !exportLayout && !displayMode && /\\(?:frac|binom)\b/.test(source);
        const html = katex.renderToString(
          readable ? `\\displaystyle{${source}}` : source,
          { throwOnError: false, trust: false, strict: "warn", displayMode },
        );
        return (
          <span
            class={displayMode ? "math-display" : "math-inline"}
            innerHTML={html}
          />
        );
      }}
    </For>
  );
}
function Inline(props: {
  content: InlineContent[];
  question?: any;
  teacher?: boolean;
}) {
  return (
    <For each={props.content}>
      {(item) =>
        item.type === "image" ? (
          <Asset
            question={props.question}
            asset={resolveAsset(props.question, item.reference, props.teacher)}
            alt={item.reference.alt}
          />
        ) : item.type === "missing-image" ? (
          <span class="warning-text" data-missing-asset role="alert">
            【配图位置无法解析：{item.reference.alt || "题目配图"}
            ，请检查题库内容】
          </span>
        ) : (
          <MathText text={item.text} />
        )
      }
    </For>
  );
}
export function RichText(props: {
  text: any;
  question?: any;
  teacher?: boolean;
}) {
  const blocks = createMemo(() => richContent(props.text).blocks);
  return (
    <For each={blocks()}>
      {(block: any) =>
        block.type === "table" ? (
          <div class="paper-table-scroll">
            <table>
              <tbody>
                <For each={block.rows}>
                  {(row: any[]) => (
                    <tr>
                      <For each={row}>
                        {(cell) => (
                          <Dynamic
                            component={cell.header ? "th" : "td"}
                            colSpan={cell.colSpan}
                            rowSpan={cell.rowSpan}
                          >
                            <Inline
                              content={cell.content}
                              question={props.question}
                              teacher={props.teacher}
                            />
                          </Dynamic>
                        )}
                      </For>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        ) : (
          <span class="paper-rich-text">
            <Inline
              content={block.content}
              question={props.question}
              teacher={props.teacher}
            />
          </span>
        )
      }
    </For>
  );
}
export function Asset(props: { asset: any; question: any; alt?: string }) {
  const [failed, setFailed] = createSignal(false);
  const [pending, setPending] = createSignal(true);
  const [src, setSrc] = createSignal("");
  createEffect(() => {
    const asset = props.asset;
    const payloads = props.question?.assetPayloads || [];
    let current = true;
    setFailed(false);
    setSrc("");
    setPending(true);
    (async () => {
      if (
        !asset ||
        !asset.assetId ||
        typeof asset.path !== "string" ||
        !asset.path ||
        !/^[a-f0-9]{64}$/.test(asset.sha256 || "")
      )
        throw new Error("素材引用无效");
      const matching = payloads.filter(
        (item: any) =>
          item.role === asset.role &&
          item.assetId === asset.assetId &&
          item.path === asset.path &&
          item.sha256 === asset.sha256,
      );
      if (matching.length !== 1) throw new Error("素材缺失或不唯一");
      const payload = matching[0];
      if (
        !/^image\/(png|jpeg|webp|gif)$/.test(payload.mimeType || "") ||
        (asset.mimeType && asset.mimeType !== payload.mimeType) ||
        typeof payload.dataBase64 !== "string"
      )
        throw new Error("素材类型无效");
      const raw = atob(payload.dataBase64);
      if (!raw.length || raw.length > 50 * 1024 * 1024)
        throw new Error("素材大小无效");
      const bytes = Uint8Array.from(raw, (character) =>
        character.charCodeAt(0),
      );
      const prefix = Array.from(bytes.slice(0, 12));
      const validType =
        payload.mimeType === "image/png"
          ? prefix.slice(0, 8).join(",") === "137,80,78,71,13,10,26,10"
          : payload.mimeType === "image/jpeg"
            ? prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255
            : payload.mimeType === "image/gif"
              ? /^GIF8[79]a/.test(raw)
              : raw.startsWith("RIFF") && raw.slice(8, 12) === "WEBP";
      if (!validType) throw new Error("素材实际格式不匹配");
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const hash = Array.from(new Uint8Array(digest), (value) =>
        value.toString(16).padStart(2, "0"),
      ).join("");
      if (hash !== asset.sha256) throw new Error("素材内容校验失败");
      if (current)
        setSrc(`data:${payload.mimeType};base64,${payload.dataBase64}`);
    })()
      .catch(() => {
        if (current) setFailed(true);
      })
      .finally(() => {
        if (current) setPending(false);
      });
    onCleanup(() => {
      current = false;
    });
  });
  return (
    <Show
      when={!pending()}
      fallback={
        <span class="muted" data-asset-pending role="status">
          正在加载配图…
        </span>
      }
    >
      <Show
        when={src() && !failed()}
        fallback={
          <span class="warning-text" data-missing-asset role="alert">
            【配图无法显示：{props.alt || props.asset?.alt || "题目配图"}
            ，请检查本地题库附件】
          </span>
        }
      >
        <img
          class="paper-image"
          src={src()}
          alt={props.alt || props.asset?.alt || "题目配图"}
          onError={() => setFailed(true)}
        />
      </Show>
    </Show>
  );
}
export function QuestionBody(props: {
  question: any;
  manifest?: any;
  teacher?: boolean;
  number?: number;
  points?: number;
  showPoints?: boolean;
  hideMissingTeacherMaterials?: boolean;
  hideSource?: boolean;
  difficultyLabel?: string;
}) {
  const presentation = () =>
    questionSourcePresentation(props.question, props.manifest);
  const exportLayout = new URLSearchParams(window.location.search).has("exportTask");
  const choices = createMemo(() => exportLayout
    ? { stem: presentation().stem, options: props.question?.student?.options || [], ambiguous: false }
    : choicePresentation(presentation().stem, props.question?.student?.options || [], props.question?.questionType,
      source => !!resolveAsset(props.question, { source, alt: "" }, false)));
  const options = () => choices().options;
  const optionLayout = () => {
    const labels: string[] = options().map((item: any) => String(item.text || ""));
    const hasImages = labels.some(text => /<img\b|!\[[^\]]*\]\(/i.test(text));
    const visible = labels.map(text => text.replace(/!\[[^\]]*\]\([^)]+\)/g, "").replace(/<[^>]*>/g, "").trim());
    // Source asset URLs and HTML attributes are not the printed option width.
    // Four graph-only choices fit two columns instead of four full-width rows.
    if (hasImages && visible.every(text => !text)) return "two-columns";
    return visible.some(text => text.length > 55) ? "one-column" : visible.some(text => text.length > 20) ? "two-columns" : "";
  };
  const studentInline = createMemo(() =>
    inlineAssetIds(props.question, false, presentation().stem),
  );
  const teacherInline = createMemo(() =>
    inlineAssetIds(props.question, true, presentation().stem),
  );
  return (
    <>
      <div class="question-top">
        <Show when={props.number !== undefined}>
          <span class="question-number">{props.number}.</span>
        </Show>
        <div class="question-stem">
          <Show
            when={props.question}
            fallback={
              <span class="warning-text">【缺题，需调整条件或补充题库】</span>
            }
          >
            <Show when={!props.hideSource}>
              <span class="question-source" title={presentation().caption}>
                （{presentation().label}）
              </span>
            </Show>
            <Show when={props.difficultyLabel}>
              <span class="question-difficulty" title="题目内容估计，未经学生作答标定">
                （难度：{props.difficultyLabel}）
              </span>
            </Show>
            <RichText text={choices().stem} question={props.question} />
          </Show>
        </div>
        <Show when={props.showPoints}>
          <span class="question-points">（{props.points || 0} 分）</span>
        </Show>
      </div>
      <Show when={props.question}>
        <div class="question-content">
          <For
            each={assetReferences(props.question).filter(
              (asset) => !studentInline().has(assetKey(asset)),
            )}
          >
            {(asset) => <Asset asset={asset} question={props.question} />}
          </For>
          <Show when={options().length}>
            <Show when={!exportLayout} fallback={<div
              class={`question-options ${optionLayout()}`}
            >
              <For each={options()}>
                {(option) => (
                  <div class="question-option">
                    <span>{option.label}.</span>
                    <RichText text={option.text} question={props.question} />
                  </div>
                )}
              </For>
            </div>}>
              <AdaptiveOptions options={options()} render={option => <RichText text={option.text} question={props.question} />} />
            </Show>
          </Show>
          <Show when={choices().ambiguous}><p class="option-layout-notice">图选项结构尚不明确，已保留原文顺序；可对照原图检查选项归属。</p></Show>
          <For each={props.question?.student?.parts || []}>
            {(part: any, index) => (
              <div class="question-part" classList={{"question-part-child":Boolean(part.parentPartId)}}>
                {exportLayout ? part.label || `（${index() + 1}）` : partDisplayLabel(part.label, part.prompt, index())}
                <RichText text={part.prompt} question={props.question} />
              </div>
            )}
          </For>
          <Show when={props.teacher}>
            <div class="teacher-material">
              <For
                each={[
                  ["answers", "参考答案"],
                  ["solutions", "解析"],
                  ...(props.showPoints
                    ? [["scoringSuggestions", "评分参考"]]
                    : []),
                ].filter(([field]) => !props.hideMissingTeacherMaterials || props.question?.teacher?.[field]?.length)}
              >
                {([field, label]) => (
                  <section>
                    <h4>{label}</h4>
                    <Show
                      when={props.question?.teacher?.[field]?.length}
                      fallback={
                        <p class="warning-text">暂无{label}，需教师核对。</p>
                      }
                    >
                      <For each={props.question?.teacher?.[field] || []}>
                        {(entry: any) => (
                          <p>
                            <RichText
                              text={entry.text}
                              question={props.question}
                              teacher
                            />
                          </p>
                        )}
                      </For>
                    </Show>
                  </section>
                )}
              </For>
              <For
                each={assetReferences(props.question, true).filter(
                  (asset: any) =>
                    asset.role === "teacher" &&
                    !teacherInline().has(assetKey(asset)),
                )}
              >
                {(asset: any) => (
                  <Asset asset={asset} question={props.question} />
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </>
  );
}
export function PaperSheet(props: {
  draft: any;
  title?: string;
  kind: string;
}) {
  const req = () =>
    props.draft?.baseline?.requirements || props.draft?.requirements || {};
  const slots = () => props.draft?.slots || [];
  return (
    <section
      class="paper-sheet"
      aria-label={`${props.kind === "teacher" ? "教师卷" : "学生卷"}整卷预览`}
    >
      <h2>{props.title || props.draft?.title || "练习"}</h2>
      <p class="paper-sheet-meta">
        {props.kind === "teacher" ? "教师卷" : "学生卷"} ·{" "}
        {purposeLabel(req().purpose)} · {slots().length} 题 ·{" "}
        {req().durationMinutes || 45} 分钟
        <Show when={req().scoringMode !== "none"}>
          {" "}
          ·{" "}
          {slots().reduce(
            (sum: number, slot: any) => sum + (slot.points || 0),
            0,
          )}{" "}
          分
        </Show>
      </p>
      <For each={slots()}>
        {(slot: any, index) => (
          <article class="paper-question">
            <Show
              when={
                index() === 0 ||
                slots()[index() - 1].questionType !== slot.questionType
              }
            >
              <h3>
                {typeTitles[slot.questionType]}{" "}
                <span>
                  {
                    slots().filter(
                      (item: any) => item.questionType === slot.questionType,
                    ).length
                  }{" "}
                  题
                </span>
              </h3>
            </Show>
            <QuestionBody
              question={slot.question}
              manifest={props.draft?.baseline?.sourceManifest}
              number={slot.number || index() + 1}
              points={slot.points}
              showPoints={req().scoringMode !== "none"}
              teacher={props.kind === "teacher"}
              hideSource={props.kind !== "teacher"}
              difficultyLabel={props.kind === "teacher" ? slotDifficulty(
                slot, req(), props.draft?.baseline?.questionIndexSnapshot,
              ).estimate : undefined}
            />
          </article>
        )}
      </For>
    </section>
  );
}
