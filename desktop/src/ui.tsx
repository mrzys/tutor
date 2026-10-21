import { For, Show, createEffect, onCleanup, onMount, JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { X, AlertCircle, LoaderCircle, UserRound } from "lucide-solid";
import { studentsOf, displayTypeIds, typeLabels } from "./bridge";
import "./Overlays.css";

const overlayStack: HTMLElement[] = [];
let previousBodyOverflow = "";
let overlayRevision = 0;

function useOverlay(
  element: () => HTMLElement,
  close: () => void,
  busy: () => boolean | undefined,
) {
  let previousFocus: HTMLElement | null = null;
  const focusable = () =>
    Array.from(
      element().querySelectorAll<HTMLElement>(
        'button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href],[contenteditable="true"],[tabindex]:not([tabindex="-1"])',
      ),
    ).filter((node) => node.tabIndex >= 0 && node.getClientRects().length > 0 && !node.closest('[inert],[aria-hidden="true"]'));
  const active = () => overlayStack.at(-1) === element();
  const focusInside = () => (focusable()[0] || element()).focus();
  const key = (event: KeyboardEvent) => {
    if (!active() || event.defaultPrevented) return;
    if (event.key === "Escape" && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      if (!busy()) close();
    }
    if (event.key !== "Tab") return;
    const nodes = focusable();
    const index = nodes.indexOf(document.activeElement as HTMLElement);
    if (!nodes.length || index < 0 || (event.shiftKey ? index === 0 : index === nodes.length - 1)) {
      event.preventDefault();
      (event.shiftKey ? nodes.at(-1) : nodes[0])?.focus();
      if (!nodes.length) element().focus();
    }
  };
  const containFocus = (event: FocusEvent) => {
    if (active() && !element().contains(event.target as Node)) focusInside();
  };
  onMount(() => {
    previousFocus = document.activeElement as HTMLElement | null;
    if (!overlayStack.length) {
      previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    overlayStack.push(element());
    overlayRevision += 1;
    document.addEventListener("keydown", key);
    document.addEventListener("focusin", containFocus);
    const initial = element().querySelector<HTMLElement>(
      '[autofocus],input:not([disabled]),textarea:not([disabled]),select:not([disabled])',
    );
    (initial || focusable()[0] || element()).focus();
  });
  onCleanup(() => {
    document.removeEventListener("keydown", key);
    document.removeEventListener("focusin", containFocus);
    const wasActive = active();
    const index = overlayStack.indexOf(element());
    if (index >= 0) {
      overlayStack.splice(index, 1);
      overlayRevision += 1;
    }
    if (!overlayStack.length) document.body.style.overflow = previousBodyOverflow;
    if (wasActive && previousFocus) {
      const target = previousFocus;
      const revision = overlayRevision;
      const remainingOverlay = overlayStack.at(-1);
      // Pointer dismissal moves focus after mousedown; restore once that default
      // action completes, unless another overlay has taken ownership meanwhile.
      requestAnimationFrame(() => {
        if (overlayRevision !== revision || !target.isConnected) return;
        if (remainingOverlay && !remainingOverlay.contains(target)) return;
        target.focus({ preventScroll: true });
      });
    }
  });
}

export function CloseButton(props: {
  onClick: () => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      class="icon-button close-button"
      title={props.label || "关闭"}
      aria-label={props.label || "关闭"}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <X size={20} />
    </button>
  );
}
export function ErrorBanner(props: { message: string; retry?: () => void }) {
  return (
    <Show when={props.message}>
      <div class="error-banner" role="alert">
        <AlertCircle size={18} />
        <span>{props.message}</span>
        <Show when={props.retry}>
          <button onClick={props.retry}>重试</button>
        </Show>
      </div>
    </Show>
  );
}
export function Busy(props: { label: string; cancel?: () => void }) {
  return (
    <div class="busy-panel" role="status">
      <LoaderCircle size={20} class="spin" />
      <strong>{props.label}</strong>
      <Show when={props.cancel}>
        <button class="secondary" onClick={props.cancel}>
          停止
        </button>
      </Show>
    </div>
  );
}
export function StudentLabels(props: { value: any }) {
  const names = () => studentsOf(props.value);
  const description = () => names()
    .map((item) => `${item.name}${item.grade ? `（${item.grade}）` : ""}`)
    .join("、");
  return (
    <Show when={names().length}>
      <span
        class="student-labels"
        role="img"
        aria-label={`关联学生：${description()}`}
        title={description()}
      >
        <span class="student-label">
          <UserRound size={12} />
          <span class="student-label-name">{names()[0]?.name}</span>
        </span>
        <Show when={names().length > 1}>
          <span class="student-label student-label-count">+{names().length - 1}</span>
        </Show>
      </span>
    </Show>
  );
}
export function TypeTabs(props: {
  slots: any[];
  value: string;
  onChange: (value: string) => void;
  all?: boolean;
}) {
  let tabs!: HTMLDivElement;
  function revealActiveTab() {
    const activeTab = tabs?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!activeTab) return;
    const container = tabs.getBoundingClientRect();
    const active = activeTab.getBoundingClientRect();
    if (active.left < container.left) tabs.scrollLeft -= container.left - active.left;
    else if (active.right > container.right) tabs.scrollLeft += active.right - container.right;
  }
  createEffect(() => {
    props.value;
    props.slots.length;
    queueMicrotask(revealActiveTab);
  });
  onMount(() => {
    const observer = new ResizeObserver(revealActiveTab);
    observer.observe(tabs);
    onCleanup(() => observer.disconnect());
  });
  return (
    <div ref={tabs} class="type-tabs" role="tablist" aria-label="题型">
      <Show when={props.all}>
        <button
          role="tab"
          aria-selected={props.value === "all"}
          onClick={() => props.onChange("all")}
        >
          全部 <span>{props.slots.length} 题</span>
        </button>
      </Show>
      <For
        each={displayTypeIds.filter((type) =>
          props.slots.some((slot) => slot.questionType === type),
        )}
      >
        {(type) => (
          <button
            role="tab"
            aria-selected={props.value === type}
            onClick={() => props.onChange(type)}
          >
            {typeLabels[type]}{" "}
            <span>
              {props.slots.filter((slot) => slot.questionType === type).length}{" "}
              题
            </span>
          </button>
        )}
      </For>
    </div>
  );
}
export function Modal(props: {
  title: string;
  onClose: () => void;
  children: JSX.Element;
  wide?: boolean;
  expanded?: boolean;
  stable?: boolean;
  busy?: boolean;
  footer?: JSX.Element;
}) {
  let dialog!: HTMLDivElement;
  useOverlay(() => dialog, () => props.onClose(), () => props.busy);
  return (
    <div
      class="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !props.busy)
          props.onClose();
      }}
    >
      <div
        ref={dialog}
        class={`modal ${props.wide ? "modal-wide" : ""} ${props.expanded ? "modal-expanded" : ""} ${(props.stable ?? props.wide) ? "modal-stable" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        tabIndex={-1}
      >
        <header class="modal-header">
          <h2>{props.title}</h2>
          <CloseButton onClick={props.onClose} disabled={props.busy} />
        </header>
        <div class="modal-content">{props.children}</div>
        <Show when={props.footer}>
          <footer class="modal-footer">{props.footer}</footer>
        </Show>
      </div>
    </div>
  );
}
export function Drawer(props: {
  title: string;
  onClose: () => void;
  children: JSX.Element;
  busy?: boolean;
  footer?: JSX.Element;
}) {
  let dialog!: HTMLDivElement;
  useOverlay(() => dialog, () => props.onClose(), () => props.busy);
  return (
    <Portal>
      <div
        class="drawer-backdrop"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !props.busy) props.onClose();
        }}
      >
        <div ref={dialog} class="drawer" role="dialog" aria-modal="true" aria-label={props.title} tabIndex={-1}>
          <header class="drawer-header">
            <h2>{props.title}</h2>
            <CloseButton onClick={props.onClose} disabled={props.busy} />
          </header>
          <div class="drawer-content">{props.children}</div>
          <Show when={props.footer}>
            <footer class="drawer-footer">{props.footer}</footer>
          </Show>
        </div>
      </div>
    </Portal>
  );
}
export function Popover(props: {
  close: () => void;
  children: JSX.Element;
  class?: string;
}) {
  let root!: HTMLDivElement;
  onMount(() => {
    const click = (event: PointerEvent) => {
      if (!root.contains(event.target as Node)) props.close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.close();
      }
    };
    // Register after the opening click has completed.
    queueMicrotask(() => document.addEventListener("pointerdown", click));
    document.addEventListener("keydown", key);
    onCleanup(() => {
      document.removeEventListener("pointerdown", click);
      document.removeEventListener("keydown", key);
    });
  });
  return (
    <div ref={root} class={`popover ${props.class || ""}`}>
      {props.children}
    </div>
  );
}
