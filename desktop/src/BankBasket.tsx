import { For, Show, onCleanup, onMount } from "solid-js";
import { LoaderCircle, ShoppingBasket, X } from "lucide-solid";
import { typeLabels } from "./bridge";
import { RichText } from "./Paper";
import { CloseButton } from "./ui";
import { BankQuestionPreview, bankMetadata } from "./BankQuestionCard";
import { questionSourcePresentation } from "./shared/source-label.mjs";

export function BankBasket(props: {
  selections: any[]; manifest: any; catalog: any; title: string;
  busy: boolean; error: string;
  onTitle: (value: string) => void; onRemove: (questionId: string) => void;
  onClear: () => void; onCreate: () => void; onClose: () => void;
}) {
  let basket!: HTMLElement;
  const previous = document.activeElement as HTMLElement | null;
  onMount(() => {
    const root = document.documentElement;
    const body = document.body;
    const previousRootOverflow = root.style.overflow;
    const previousBodyOverflow = body.style.overflow;
    const previousBodyPaddingRight = body.style.paddingRight;
    const width = innerWidth - root.clientWidth;
    root.style.overflow = "hidden";
    body.style.overflow = "hidden";
    if (width > 0) body.style.paddingRight = `${(parseFloat(getComputedStyle(body).paddingRight) || 0) + width}px`;
    const frame = requestAnimationFrame(() => basket.querySelector<HTMLButtonElement>(".close-button")?.focus());
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector(".bank-select-popup")) {
        event.preventDefault(); if (!props.busy) props.onClose();
      }
      if (event.key !== "Tab") return;
      const items = [...basket.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]')];
      const first = items[0], last = items.at(-1);
      if (!first) event.preventDefault();
      else if (!basket.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", keys);
    onCleanup(() => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", keys);
      root.style.overflow = previousRootOverflow;
      body.style.overflow = previousBodyOverflow;
      body.style.paddingRight = previousBodyPaddingRight;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    });
  });
  function location(question: any) {
    const sectionIds = [question.selectedOrigin, ...bankMetadata(question).sectionIds].filter(Boolean).map(id => ["1.1", "1.2", "1.3"].includes(id) ? `rja-compulsory-1:${id}` : id);
    for (const book of props.catalog?.textbooks || []) for (const chapter of book.chapters || []) for (const section of chapter.sections || []) {
      if (sectionIds.includes(section.id)) return `${book.title || book.volume || book.id} / ${chapter.title || chapter.id} / ${section.title || section.id}`;
    }
    return "题库题目";
  }
  return <>
    <button type="button" class="bank-basket-backdrop" aria-label="关闭组卷篮" disabled={props.busy} onClick={props.onClose} />
    <aside ref={basket} class="bank-basket is-open" role="dialog" aria-modal="true" aria-label="组卷篮">
      <div class="bank-basket-heading"><div><span class="bank-basket-icon"><ShoppingBasket size={18} /><Show when={props.selections.length}><b>{props.selections.length}</b></Show></span><div><strong>组卷篮</strong><span aria-live="polite">已选 {props.selections.length} 道题</span></div></div><CloseButton label="关闭组卷篮" disabled={props.busy} onClick={props.onClose} /></div>
      <form class="bank-basket-actions" onSubmit={event => { event.preventDefault(); props.onCreate(); }}>
        <Show when={props.error}><p class="bank-create-error" role="alert">{props.error}</p></Show>
        <label><span>试卷标题</span><input aria-label="试卷标题" value={props.title} disabled={props.busy} maxlength={120} required placeholder="例如：集合单元练习" onInput={event => props.onTitle(event.currentTarget.value)} /></label>
        <button class="primary" type="submit" title="按题型整理，同题型保留选题顺序" disabled={!props.selections.length || props.busy || !props.title.trim()}>{props.busy ? <><LoaderCircle class="spin" size={16} />正在创建…</> : `生成试卷草稿${props.selections.length ? `（${props.selections.length}）` : ""}`}</button>
        <Show when={props.selections.length}><div class="bank-basket-tools"><button type="button" class="bank-basket-clear" aria-label="清空组卷篮" disabled={props.busy} onClick={() => { if (window.confirm(`确定清空组卷篮中的 ${props.selections.length} 道题吗？`)) props.onClear(); }}>清空</button></div></Show>
      </form>
      <div class="bank-basket-list">
        <For each={props.selections}>{(question, index) => <article class="bank-basket-item">
          <div class="bank-basket-item-heading"><span>{index() + 1}</span><strong>{typeLabels[question.questionType] || question.questionType}</strong><button type="button" disabled={props.busy} aria-label={`移除第 ${index() + 1} 题`} title="移出组卷篮" onClick={() => props.onRemove(question.questionId)}><X size={15} /></button></div>
          <div class="bank-basket-question"><BankQuestionPreview question={question} manifest={props.manifest} basket /></div>
          <dl class="bank-basket-detail"><dt>章节</dt><dd>{location(question)}</dd><dt>考查</dt><dd><RichText text={bankMetadata(question).taskSummary} question={question} /></dd><dt>知识</dt><dd><RichText text={bankMetadata(question).requiredKnowledge.join("、") || bankMetadata(question).topics.join("、") || "未单独标注"} question={question} /></dd><dt>来源</dt><dd>{questionSourcePresentation(question, props.manifest).caption}</dd></dl>
        </article>}</For>
        <Show when={!props.selections.length}><div class="bank-basket-empty"><ShoppingBasket size={22} /><strong>还没有选择题目</strong></div></Show>
      </div>
    </aside>
  </>;
}
