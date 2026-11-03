import { For, Show, batch, createEffect, createSignal, createUniqueId, onCleanup, type JSX } from "solid-js";

export type ImportReadingTab = "solution" | "assessment";
const readingTabs = [
  { id: "solution", label: "AI教学稿" },
  { id: "assessment", label: "考查信息" },
] as const;

/** Switching reading material is local; only the selected panel is rendered. */
export function ImportReadingTabs(props: {
  value: ImportReadingTab; onChange: (value: ImportReadingTab) => void;
  questionKey: string;
  statuses?: Partial<Record<ImportReadingTab, string>>;
  solution: JSX.Element; assessment: JSX.Element;
}) {
  const id = createUniqueId();
  const [panelMinHeight, setPanelMinHeight] = createSignal(0);
  let origin: HTMLDivElement | undefined;
  let tabs: HTMLElement | undefined;
  let pendingFrame = 0;
  const cancelFrame = () => { cancelAnimationFrame(pendingFrame); pendingFrame = 0; };
  createEffect(() => { props.questionKey; cancelFrame(); setPanelMinHeight(0); });
  onCleanup(cancelFrame);

  function select(value: ImportReadingTab) {
    if (value === props.value) return;
    cancelFrame();
    const pane = tabs?.closest<HTMLElement>(".import-reading-pane");
    const questionKey = props.questionKey;
    if (!pane || !origin || !tabs) { props.onChange(value); return; }
    const paneTop = pane.getBoundingClientRect().top + pane.clientTop;
    const headingHeight = pane.querySelector<HTMLElement>(".import-question-heading")?.getBoundingClientRect().height || 0;
    const originTop = pane.scrollTop + origin.getBoundingClientRect().top - paneTop;
    const tabHeight = tabs.getBoundingClientRect().height;
    const tabGap = Number.parseFloat(getComputedStyle(tabs).marginBottom) || 0;
    const paneBottom = Number.parseFloat(getComputedStyle(pane).paddingBottom) || 0;
    const stuck = tabs.getBoundingClientRect().top <= paneTop + headingHeight + 1;
    // A sticky tab stays in place while the new material opens at its beginning.
    // Otherwise retain the current question and tab position. Reserve only the
    // space needed for this viewport, so a shorter panel cannot clamp it away.
    const target = stuck ? Math.max(0, originTop - headingHeight) : pane.scrollTop;
    const minimum = Math.max(0, target + pane.clientHeight - originTop - tabHeight - tabGap - paneBottom);
    batch(() => { setPanelMinHeight(minimum); props.onChange(value); });
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = 0;
      if (pane.isConnected && props.questionKey === questionKey && props.value === value) pane.scrollTop = target;
    });
  }
  return <>
    <div class="import-reading-tab-origin" ref={origin} aria-hidden="true" />
    <nav class="import-reading-tabs" ref={tabs} role="tablist" aria-label="本题内容" onKeyDown={event => {
      const index = readingTabs.findIndex(tab => tab.id === props.value);
      const next = event.key === "ArrowRight" ? (index + 1) % readingTabs.length
        : event.key === "ArrowLeft" ? (index + readingTabs.length - 1) % readingTabs.length
        : event.key === "Home" ? 0 : event.key === "End" ? readingTabs.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      select(readingTabs[next].id);
      document.getElementById(`${id}-tab-${readingTabs[next].id}`)?.focus({ preventScroll: true });
    }}>
      <For each={readingTabs}>{tab => <button type="button" role="tab" id={`${id}-tab-${tab.id}`}
        aria-selected={props.value === tab.id} aria-controls={`${id}-panel-${tab.id}`}
        tabIndex={props.value === tab.id ? 0 : -1} onClick={() => select(tab.id)}>
        {tab.label}<Show when={props.statuses?.[tab.id]}>{status => <small>{status()}</small>}</Show>
      </button>}</For>
    </nav>
    <For each={readingTabs}>{tab => <section class="import-reading-tab-panel" role="tabpanel"
      id={`${id}-panel-${tab.id}`} aria-labelledby={`${id}-tab-${tab.id}`} hidden={props.value !== tab.id} tabIndex={0}
      style={{ "min-height": `${panelMinHeight()}px` }}>
      <Show when={props.value === tab.id}>{props[tab.id]}</Show>
    </section>}</For>
  </>;
}
