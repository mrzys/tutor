import { For, Show, createMemo, onCleanup, onMount } from "solid-js";
import { Check, Plus } from "lucide-solid";
import { typeLabels } from "./bridge";
import { Asset, RichText } from "./Paper";
import { assetKey, assetReferences, inlineAssetIds, resolveAsset } from "./rich-content";
import { questionSourcePresentation } from "./shared/source-label.mjs";
import { AdaptiveOptions } from "./AdaptiveOptions";
import { choicePresentation } from "./choice-presentation";
import { difficultyLevels } from "./assembly-details";

export function bankMetadata(row: any) {
  const question = row.question || row;
  const metadata = row.catalogMetadata || row.metadata || {};
  return {
    taskSummary: metadata.taskSummary || row.taskSummary || question.taskSummary || "未单独标注",
    topics: metadata.topics || row.topics || question.topics || [],
    requiredKnowledge: metadata.requiredKnowledge || row.requiredKnowledge || question.requiredKnowledge || [],
    sectionIds: metadata.sectionIds || row.sectionIds || question.sectionIds || [],
    sectionLabels: metadata.sectionLabels || [],
    sourceRefs: metadata.sourceRefs || row.sourceRefs || question.sourceRefs || [],
    difficulty: metadata.difficulty || {},
    taskLabels: metadata.taskLabels || [],
    knowledgeLabel: metadata.knowledgeLabel || "相关知识",
    solutionPaths: metadata.solutionPaths || [],
    abilities: metadata.abilities || [],
    literacies: metadata.literacies || [],
    pedagogyStatus: metadata.pedagogyStatus || "unknown",
  };
}

// The established Paper rich-text and asset boundary is reused, while the
// surrounding structure follows the Web bank's reading list and compact basket.
export function BankQuestionPreview(props: { question: any; manifest?: any; basket?: boolean; hideSource?: boolean }) {
  const presentation = createMemo(() => questionSourcePresentation(props.question, props.manifest));
  const choices = createMemo(() => choicePresentation(presentation().stem, props.question?.student?.options || [], props.question?.questionType,
    source => !!resolveAsset(props.question, { source, alt: "" }, false)));
  const inline = createMemo(() => inlineAssetIds(props.question, false, presentation().stem));
  const prefix = () => props.basket ? "bank-basket" : "bank-question";
  let content!: HTMLDivElement;
  onMount(() => {
    let frame = 0, alive = true;
    function measure() {
      frame = 0;
      if (!alive || !content.clientWidth) return;
      const maths = [...content.querySelectorAll<HTMLElement>(".math-inline,.math-display")]
        .filter(node => !node.closest(".adaptive-options-probes,.paper-table-scroll"));
      const positions = new Map(maths.map(node => [node, node.scrollLeft]));
      // Ordinary formulas remain real inline content, without a per-formula
      // scroll box. Only a formula wider than the full line needs a viewport.
      for (const node of maths) node.classList.remove("bank-math-scroll");
      for (const node of maths) {
        const host = node.closest<HTMLElement>(".adaptive-choice-text,.bank-part-prompt,.bank-question-stem,.bank-basket-stem") || content;
        const style = getComputedStyle(host);
        const available = Math.min(content.clientWidth, host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
        const html = node.querySelector(".katex-html");
        const range = document.createRange();
        if (html) range.selectNodeContents(html);
        const width = Math.max(node.getBoundingClientRect().width, html ? range.getBoundingClientRect().width : 0);
        if (available > 0 && width > available + 2) {
          node.classList.add("bank-math-scroll");
          node.scrollLeft = positions.get(node) || 0;
        }
      }
    }
    const schedule = () => { if (alive && !frame) frame = requestAnimationFrame(measure); };
    const sizes = new ResizeObserver(schedule);
    sizes.observe(content);
    const changes = new MutationObserver(schedule);
    changes.observe(content, { childList: true, subtree: true, characterData: true });
    content.addEventListener("load", schedule, true);
    document.fonts?.ready.then(schedule);
    document.fonts?.addEventListener("loadingdone", schedule);
    schedule();
    onCleanup(() => {
      alive = false;
      cancelAnimationFrame(frame);
      sizes.disconnect(); changes.disconnect();
      content.removeEventListener("load", schedule, true);
      document.fonts?.removeEventListener("loadingdone", schedule);
    });
  });
  return <div class="bank-rich-content" ref={content}>
    <div class={`${prefix()}-stem`}><Show when={!props.hideSource}><span class="question-source" title={presentation().caption}>（{presentation().label}）</span></Show><RichText text={choices().stem} question={props.question} /></div>
    <For each={assetReferences(props.question).filter(asset => !inline().has(assetKey(asset)))}>{asset => <Asset asset={asset} question={props.question} />}</For>
    <Show when={choices().options.length}><div class={`${prefix()}-options`}><AdaptiveOptions options={choices().options} render={option => <RichText text={option.text} question={props.question} />} /></div></Show>
    <Show when={choices().ambiguous}><p class="option-layout-notice">图选项结构尚不明确，已保留原文顺序；可对照原图检查选项归属。</p></Show>
    <Show when={props.question?.student?.parts?.length}><div class={`${prefix()}-parts`}><For each={props.question.student.parts}>{(part: any, index) => <p classList={{"question-part-child":Boolean(part.parentPartId)}}><span>{part.label || `（${index() + 1}）`}</span><span class="bank-part-prompt"><RichText text={part.prompt} question={props.question} /></span></p>}</For></div></Show>
  </div>;
}

export function BankQuestionCard(props: { row: any; manifest?: any; selected: boolean; disabled: boolean; onToggle: () => void; onDetails: () => void }) {
  const question = () => props.row.question || props.row;
  const metadata = () => bankMetadata(props.row);
  const difficulty = () => difficultyLevels.find(level => level.id === metadata().difficulty.level)?.label || "未评估";
  let detailTrigger!: HTMLButtonElement;
  let detailTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelOpening = () => clearTimeout(detailTimer);
  onCleanup(cancelOpening);
  function openDetails() {
    cancelOpening();
    detailTrigger.focus({ preventScroll: true });
    props.onDetails();
  }
  function readingClick(event: MouseEvent) {
    cancelOpening();
    const target = event.target instanceof Element ? event.target : null;
    if (event.defaultPrevented || event.detail > 1 || target?.closest('a,button,input,select,textarea,summary,[contenteditable="true"],[role="button"]')) return;
    const reading = event.currentTarget as HTMLElement;
    // Let dragging or a double click select the original rich text normally.
    detailTimer = setTimeout(() => {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && (reading.contains(selection.anchorNode) || reading.contains(selection.focusNode))) return;
      openDetails();
    }, 220);
  }
  return <article class={`bank-question ${props.selected ? "is-selected" : ""}`}>
    <div class="bank-question-body"><div class="bank-question-reading" onClick={readingClick} onDblClick={cancelOpening}>
      <div class="bank-question-tags" aria-label="题型与难度">
        <span class="bank-question-type">{typeLabels[question().questionType] || question().questionType}</span>
        <span class="bank-question-difficulty" data-difficulty={difficultyLevels.some(level => level.id === metadata().difficulty.level) ? metadata().difficulty.level : "unknown"} title="题目难度（内容估计）">{difficulty()}</span>
        <button ref={detailTrigger} type="button" class="bank-question-detail-keyboard" aria-label="查看题目详情" aria-haspopup="dialog" onClick={openDetails}>查看题目详情</button>
        <button type="button" class="bank-question-add" disabled={props.disabled} aria-pressed={props.selected} aria-label={props.selected ? "从组卷篮移出此题" : "将此题加入组卷篮"} onClick={() => { cancelOpening(); props.onToggle(); }}>{props.selected ? <><Check size={14} />已加入 · 移出</> : <><Plus size={14} />加入组卷篮</>}</button>
      </div>
      <BankQuestionPreview question={question()} manifest={props.manifest} /></div>
    </div>
  </article>;
}
