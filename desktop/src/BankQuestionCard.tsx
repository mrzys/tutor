import { For, Show, createMemo, createSignal, createUniqueId } from "solid-js";
import { Check, ChevronRight, Plus } from "lucide-solid";
import { typeLabels } from "./bridge";
import { Asset, RichText } from "./Paper";
import { assetKey, assetReferences, inlineAssetIds, resolveAsset } from "./rich-content";
import { questionSourcePresentation } from "./shared/source-label.mjs";
import { AdaptiveOptions } from "./AdaptiveOptions";
import { choicePresentation } from "./choice-presentation";

export function bankMetadata(row: any) {
  const question = row.question || row;
  const metadata = row.catalogMetadata || row.metadata || {};
  return {
    taskSummary: metadata.taskSummary || row.taskSummary || question.taskSummary || "未单独标注",
    topics: metadata.topics || row.topics || question.topics || [],
    requiredKnowledge: metadata.requiredKnowledge || row.requiredKnowledge || question.requiredKnowledge || [],
    sectionIds: metadata.sectionIds || row.sectionIds || question.sectionIds || [],
    sourceRefs: metadata.sourceRefs || row.sourceRefs || question.sourceRefs || [],
  };
}

// The established Paper rich-text and asset boundary is reused, while the
// surrounding structure follows the Web bank's reading list and compact basket.
export function BankQuestionPreview(props: { question: any; manifest?: any; basket?: boolean }) {
  const presentation = createMemo(() => questionSourcePresentation(props.question, props.manifest));
  const choices = createMemo(() => choicePresentation(presentation().stem, props.question?.student?.options || [], props.question?.questionType,
    source => !!resolveAsset(props.question, { source, alt: "" }, false)));
  const inline = createMemo(() => inlineAssetIds(props.question, false, presentation().stem));
  const prefix = () => props.basket ? "bank-basket" : "bank-question";
  return <>
    <div class={`${prefix()}-stem`}><span class="question-source" title={presentation().caption}>（{presentation().label}）</span><RichText text={choices().stem} question={props.question} /></div>
    <For each={assetReferences(props.question).filter(asset => !inline().has(assetKey(asset)))}>{asset => <Asset asset={asset} question={props.question} />}</For>
    <Show when={choices().options.length}><div class={`${prefix()}-options`}><AdaptiveOptions options={choices().options} render={option => <RichText text={option.text} question={props.question} />} /></div></Show>
    <Show when={choices().ambiguous}><p class="option-layout-notice">图选项结构尚不明确，已保留原文顺序；可对照原图检查选项归属。</p></Show>
    <Show when={props.question?.student?.parts?.length}><div class={`${prefix()}-parts`}><For each={props.question.student.parts}>{(part: any, index) => <p classList={{"question-part-child":Boolean(part.parentPartId)}}><span>{part.label || `（${index() + 1}）`}</span><span class="bank-part-prompt"><RichText text={part.prompt} question={props.question} /></span></p>}</For></div></Show>
  </>;
}

export function BankQuestionCard(props: { row: any; manifest?: any; selected: boolean; disabled: boolean; onToggle: () => void }) {
  const [open, setOpen] = createSignal(false);
  const evidenceId = createUniqueId();
  const question = () => props.row.question || props.row;
  const metadata = () => bankMetadata(props.row);
  const presentation = () => questionSourcePresentation(question(), props.manifest);
  let trigger!: HTMLButtonElement;
  function toggleEvidence() {
    const list = trigger.closest(".bank-question-list");
    const scroll = list?.scrollTop;
    setOpen(!open());
    // Expanding provenance should not move the list's reading position.
    requestAnimationFrame(() => { if (list && scroll !== undefined) list.scrollTop = scroll; });
  }
  const refs = () => metadata().sourceRefs.filter((ref: any) => !/^tutor-set(?:-|$)/i.test(ref.locator || ""));
  return <article class={`bank-question ${props.selected ? "is-selected" : ""}`}>
    <div class="bank-question-body"><BankQuestionPreview question={question()} manifest={props.manifest} />
      <div class="bank-question-information"><div class="bank-question-information-line">
        <span class="bank-question-type">{typeLabels[question().questionType] || question().questionType}</span>
        <span><RichText text={metadata().topics.join("、") || metadata().taskSummary} question={question()} /></span>
        <button ref={trigger} type="button" class="bank-question-evidence-trigger" aria-expanded={open()} aria-controls={evidenceId} onPointerDown={event => event.preventDefault()} onClick={toggleEvidence}><ChevronRight size={13} /><span>知识与来源信息</span></button>
        <button type="button" class="bank-question-add" disabled={props.disabled} aria-pressed={props.selected} aria-label={props.selected ? "从组卷篮移出此题" : "将此题加入组卷篮"} onClick={props.onToggle}>{props.selected ? <><Check size={14} />已加入 · 移出</> : <><Plus size={14} />加入组卷篮</>}</button>
      </div><Show when={open()}><dl id={evidenceId} class="bank-question-evidence-panel">
        <dt>考查摘要</dt><dd><RichText text={metadata().taskSummary} question={question()} /></dd>
        <dt>相关知识</dt><dd><RichText text={metadata().requiredKnowledge.join("、") || "未单独标注"} question={question()} /></dd>
        <dt>题目来源</dt><dd>{presentation().caption}</dd><dt>来源定位</dt><dd>{refs().length ? refs().map((ref: any) => `${ref.locator || "题库收录"}${ref.pages?.length ? `（${ref.pages.join("、")} 页）` : ""}`).join("；") : "题库收录"}</dd>
      </dl></Show></div>
    </div>
  </article>;
}
