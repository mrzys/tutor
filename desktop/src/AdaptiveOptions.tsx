import { For, createEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import type { DisplayChoice } from "./choice-presentation";
import "./AdaptiveOptions.css";

/** Measure the rendered math/images, rather than source length or asset URLs. */
export function AdaptiveOptions(props: { options: DisplayChoice[]; render: (option: DisplayChoice) => JSX.Element; reviewField?: (option: DisplayChoice) => string | undefined }) {
  const [columns, setColumns] = createSignal(1);
  let host!: HTMLDivElement;
  let probes!: HTMLDivElement;
  let schedule = () => {};
  createEffect(() => { props.options; schedule(); });
  onMount(() => {
    let frame = 0;
    let alive = true;
    const measure = () => {
      frame = 0;
      if (!alive || !host.clientWidth) return;
      const width = host.clientWidth;
      const widest = Math.ceil(Math.max(0, ...Array.from(probes.children, child => child.getBoundingClientRect().width))) + 2;
      const images = !!probes.querySelector("img,[data-asset-pending],[data-missing-asset]");
      const choices = images ? [2, 1] : [4, 2, 1];
      setColumns(choices.find(count => count <= props.options.length && widest * count + 24 * (count - 1) <= width) || 1);
    };
    schedule = () => { if (alive && !frame) frame = requestAnimationFrame(measure); };
    const sizes = new ResizeObserver(schedule);
    sizes.observe(host);
    sizes.observe(probes);
    const content = new MutationObserver(schedule);
    content.observe(probes, { childList: true, subtree: true, characterData: true, attributes: true });
    host.addEventListener("load", schedule, true);
    document.fonts?.ready.then(schedule);
    document.fonts?.addEventListener("loadingdone", schedule);
    schedule();
    onCleanup(() => {
      alive = false;
      cancelAnimationFrame(frame);
      sizes.disconnect(); content.disconnect();
      host.removeEventListener("load", schedule, true);
      document.fonts?.removeEventListener("loadingdone", schedule);
    });
  });
  const Choice = (item: { option: DisplayChoice; probe?: boolean }) => <div class="adaptive-choice" data-import-field={item.probe ? undefined : props.reviewField?.(item.option)} tabIndex={!item.probe && props.reviewField?.(item.option) ? -1 : undefined}><span class="adaptive-choice-label">{item.option.label}.</span><div class="adaptive-choice-text">{props.render(item.option)}</div></div>;
  return <div class="adaptive-options-host" ref={host}>
    <div class="adaptive-options-grid" role="group" aria-label="选项" data-columns={columns()} style={{ "grid-template-columns": `repeat(${columns()}, minmax(0, 1fr))` }}><For each={props.options}>{option => <Choice option={option} />}</For></div>
    <div class="adaptive-options-probes" ref={probes} aria-hidden="true" inert><For each={props.options}>{option => <Choice option={option} probe />}</For></div>
  </div>;
}
