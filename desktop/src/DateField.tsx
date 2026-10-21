import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  onCleanup,
  onMount,
} from "solid-js";
import { Portal } from "solid-js/web";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-solid";
import "./DateField.css";

type CivilDate = { year: number; month: number; day: number };
const weekdays = ["一", "二", "三", "四", "五", "六", "日"];
const minimumMonth = 12;
const maximumMonth = 9999 * 12 + 11;
const monthIndex = (date: CivilDate) => date.year * 12 + date.month - 1;
const iso = (date: CivilDate) =>
  `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
const dateLabel = (date: CivilDate) =>
  `${date.year}年${date.month}月${date.day}日`;
function utcDate(date: CivilDate) {
  // UTC is used only for civil-date arithmetic; it never interprets a stored
  // YYYY-MM-DD string as an instant or shifts the user's local calendar day.
  const value = new Date(0);
  value.setUTCHours(12, 0, 0, 0);
  value.setUTCFullYear(date.year, date.month - 1, date.day);
  return value;
}
function fromUtc(value: Date): CivilDate {
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  };
}
function monthDays(year: number, month: number) {
  return utcDate({ year, month: month + 1, day: 0 }).getUTCDate();
}
function parse(value: string): CivilDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  return date.year >= 1 &&
    date.year <= 9999 &&
    date.month >= 1 &&
    date.month <= 12 &&
    date.day >= 1 &&
    date.day <= monthDays(date.year, date.month)
    ? date
    : null;
}
function localToday(): CivilDate {
  const value = new Date();
  return {
    year: value.getFullYear(),
    month: value.getMonth() + 1,
    day: value.getDate(),
  };
}
function addDays(date: CivilDate, days: number) {
  const value = utcDate(date);
  value.setUTCDate(value.getUTCDate() + days);
  return fromUtc(value);
}
function inMonth(date: CivilDate, index: number): CivilDate {
  const bounded = Math.max(minimumMonth, Math.min(maximumMonth, index));
  const year = Math.floor(bounded / 12),
    month = (bounded % 12) + 1;
  return { year, month, day: Math.min(date.day, monthDays(year, month)) };
}

/** Controlled local calendar date. `label` names the trigger for assistive tech;
 * the caller may keep its existing visible field label. No date is saved until
 * a day/Today/Clear is explicitly chosen. */
export function DateField(props: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const id = `date-field-${createUniqueId()}`;
  const [open, setOpen] = createSignal(false);
  const [host, setHost] = createSignal<HTMLElement>();
  const [today, setToday] = createSignal(localToday());
  const [focused, setFocused] = createSignal<CivilDate>(localToday());
  const [view, setView] = createSignal<CivilDate>(localToday());
  const [position, setPosition] = createSignal({
    left: 0,
    top: 0,
    width: 336,
    maxHeight: 600,
    direction: "down",
  });
  const selected = createMemo(() => parse(props.value));
  const years = createMemo(() =>
    Array.from(
      {
        length:
          Math.min(9999, view().year + 100) -
          Math.max(1, view().year - 100) +
          1,
      },
      (_, index) => Math.max(1, view().year - 100) + index,
    ),
  );
  const cells = createMemo(() => {
    const first = { ...view(), day: 1 };
    const mondayOffset = (utcDate(first).getUTCDay() + 6) % 7;
    return Array.from({ length: 6 }, (_, week) =>
      Array.from({ length: 7 }, (_, day) =>
        addDays(first, week * 7 + day - mondayOffset),
      ),
    );
  });
  let trigger!: HTMLButtonElement;
  let panel!: HTMLDivElement;
  let frame = 0;
  function disabled() {
    return Boolean(props.disabled || trigger?.matches(":disabled"));
  }
  function close(restore = true) {
    setOpen(false);
    if (restore)
      requestAnimationFrame(() => {
        if (trigger.isConnected && !disabled())
          trigger.focus({ preventScroll: true });
      });
  }
  function show() {
    if (disabled()) return;
    const now = localToday(),
      date = selected() || now;
    setToday(now);
    setFocused(date);
    setView(date);
    // Keep portal descendants inside the owning modal's focus boundary, while
    // escaping the modal-content scrolling/clipping container.
    setHost(trigger.closest<HTMLElement>('[role="dialog"]') || document.body);
    setOpen(true);
  }
  function choose(date: CivilDate | null) {
    if (disabled()) return;
    props.onChange(date ? iso(date) : "");
    close();
  }
  function focusDay() {
    requestAnimationFrame(() => {
      if (!open()) return;
      const button = panel?.querySelector<HTMLButtonElement>(
        `[data-date="${iso(focused())}"]`,
      );
      button?.focus({ preventScroll: true });
      if (button && panel.scrollHeight > panel.clientHeight) {
        const bounds = button.getBoundingClientRect(),
          popup = panel.getBoundingClientRect();
        if (bounds.bottom > popup.bottom)
          panel.scrollTop += bounds.bottom - popup.bottom + 8;
        if (bounds.top < popup.top)
          panel.scrollTop -= popup.top - bounds.top + 8;
      }
    });
  }
  function moveFocus(next: CivilDate) {
    if (next.year < 1 || next.year > 9999) return;
    setFocused(next);
    if (monthIndex(next) !== monthIndex(view())) setView(next);
    focusDay();
  }
  function changeMonth(index: number) {
    const next = inMonth(focused(), index);
    setView(next);
    setFocused(next);
  }
  function dayKeyboard(event: KeyboardEvent) {
    const date = focused();
    let next: CivilDate | null = null;
    if (event.key === "ArrowLeft") next = addDays(date, -1);
    else if (event.key === "ArrowRight") next = addDays(date, 1);
    else if (event.key === "ArrowUp") next = addDays(date, -7);
    else if (event.key === "ArrowDown") next = addDays(date, 7);
    else if (event.key === "Home")
      next = addDays(date, -((utcDate(date).getUTCDay() + 6) % 7));
    else if (event.key === "End")
      next = addDays(date, 6 - ((utcDate(date).getUTCDay() + 6) % 7));
    else if (event.key === "PageUp" || event.key === "PageDown")
      next = inMonth(
        date,
        monthIndex(date) +
          (event.key === "PageUp" ? -1 : 1) * (event.shiftKey ? 12 : 1),
      );
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      choose(date);
      return;
    }
    if (next) {
      event.preventDefault();
      event.stopPropagation();
      moveFocus(next);
    }
  }
  function panelKeyboard(event: KeyboardEvent) {
    if (event.key === "Escape" && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const nodes = [
      ...panel.querySelectorAll<HTMLElement>(
        "button:not([disabled]),select:not([disabled])",
      ),
    ].filter((node) => node.tabIndex >= 0);
    const index = nodes.indexOf(document.activeElement as HTMLElement);
    if (event.shiftKey && index === 0) {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (!event.shiftKey && index === nodes.length - 1) {
      event.preventDefault();
      event.stopPropagation();
      const boundary =
        trigger.closest<HTMLElement>('[role="dialog"]') || document.body;
      const targets = [
        ...boundary.querySelectorAll<HTMLElement>(
          'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]',
        ),
      ].filter(
        (node) =>
          node.tabIndex >= 0 &&
          !panel.contains(node) &&
          node.getClientRects().length &&
          !node.closest('[hidden],[inert],[aria-hidden="true"]'),
      );
      const target = targets[targets.indexOf(trigger) + 1] || trigger;
      close(false);
      target.focus({ preventScroll: true });
    }
  }
  function locate() {
    if (!open() || !panel || !trigger.isConnected) return;
    const rect = trigger.getBoundingClientRect(),
      viewport = window.visualViewport;
    const viewportLeft = viewport?.offsetLeft || 0,
      viewportTop = viewport?.offsetTop || 0;
    const viewportWidth = viewport?.width || innerWidth,
      viewportHeight = viewport?.height || innerHeight;
    if (rect.bottom < viewportTop || rect.top > viewportTop + viewportHeight) {
      close(false);
      return;
    }
    const width = Math.min(336, viewportWidth - 16),
      maxHeight = Math.max(120, viewportHeight - 16);
    const height = Math.min(panel.scrollHeight, maxHeight);
    const above = rect.top - viewportTop - 8,
      below = viewportTop + viewportHeight - rect.bottom - 8;
    const up = below < height && above > below;
    const left = Math.max(
      viewportLeft + 8,
      Math.min(rect.left, viewportLeft + viewportWidth - width - 8),
    );
    const top = Math.max(
      viewportTop + 8,
      Math.min(
        up ? rect.top - height - 8 : rect.bottom + 8,
        viewportTop + viewportHeight - height - 8,
      ),
    );
    setPosition({ left, top, width, maxHeight, direction: up ? "up" : "down" });
  }
  function queuePosition() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(locate);
  }
  createEffect(() => {
    if (props.disabled && open()) close(false);
  });
  onCleanup(() => cancelAnimationFrame(frame));
  function Calendar() {
    onMount(() => {
      // Top-layer popovers escape clipping while retaining the modal's DOM
      // focus boundary. On older engines, temporarily release only that frame's
      // clipping/transform; its separate scrolling content remains unchanged.
      let restoreFrame = () => {};
      if (typeof panel.showPopover === "function") {
        panel.setAttribute("popover", "manual");
        panel.showPopover();
      } else {
        const frame = host();
        if (frame && frame !== document.body) {
          const names = ["overflow", "transform"];
          const previous = names.map((name) => ({
            name,
            value: frame.style.getPropertyValue(name),
            priority: frame.style.getPropertyPriority(name),
          }));
          frame.style.setProperty("overflow", "visible", "important");
          frame.style.setProperty("transform", "none", "important");
          restoreFrame = () => {
            for (const item of previous) {
              if (item.value)
                frame.style.setProperty(item.name, item.value, item.priority);
              else frame.style.removeProperty(item.name);
            }
          };
        }
      }
      locate();
      focusDay();
      const pointer = (event: PointerEvent) => {
        const target = event.target as HTMLElement;
        if (panel.contains(target) || trigger.contains(target)) return;
        close(
          !target.closest(
            'button,input,textarea,select,a[href],[tabindex],[contenteditable="true"]',
          ),
        );
      };
      const focus = (event: FocusEvent) => {
        if (
          !panel.contains(event.target as Node) &&
          !trigger.contains(event.target as Node)
        )
          close(false);
      };
      const observer = new ResizeObserver(queuePosition);
      observer.observe(panel);
      observer.observe(trigger);
      document.addEventListener("pointerdown", pointer, true);
      document.addEventListener("focusin", focus);
      window.addEventListener("scroll", queuePosition, true);
      window.addEventListener("resize", queuePosition);
      window.visualViewport?.addEventListener("resize", queuePosition);
      window.visualViewport?.addEventListener("scroll", queuePosition);
      onCleanup(() => {
        restoreFrame();
        observer.disconnect();
        cancelAnimationFrame(frame);
        document.removeEventListener("pointerdown", pointer, true);
        document.removeEventListener("focusin", focus);
        window.removeEventListener("scroll", queuePosition, true);
        window.removeEventListener("resize", queuePosition);
        window.visualViewport?.removeEventListener("resize", queuePosition);
        window.visualViewport?.removeEventListener("scroll", queuePosition);
        if (
          typeof panel.hidePopover === "function" &&
          panel.matches(":popover-open")
        )
          panel.hidePopover();
      });
    });
    return (
      <div
        ref={panel}
        id={id}
        role="dialog"
        aria-modal="false"
        aria-label={props.label || "选择日期"}
        class="date-field-popup"
        data-placement={position().direction}
        onKeyDown={panelKeyboard}
        style={{
          left: `${position().left}px`,
          top: `${position().top}px`,
          width: `${position().width}px`,
          "max-height": `${position().maxHeight}px`,
        }}
      >
        <header class="date-field-calendar-header">
          <button
            type="button"
            aria-label="上个月"
            title="上个月"
            disabled={monthIndex(view()) <= minimumMonth}
            onClick={() => changeMonth(monthIndex(view()) - 1)}
          >
            <ChevronLeft size={18} />
          </button>
          <div class="date-field-period">
            <select
              aria-label="年份"
              value={view().year}
              onChange={(event) =>
                changeMonth(
                  Number(event.currentTarget.value) * 12 + view().month - 1,
                )
              }
            >
              <For each={years()}>
                {(year) => <option value={year}>{year}年</option>}
              </For>
            </select>
            <select
              aria-label="月份"
              value={view().month}
              onChange={(event) =>
                changeMonth(
                  view().year * 12 + Number(event.currentTarget.value) - 1,
                )
              }
            >
              <For each={Array.from({ length: 12 }, (_, index) => index + 1)}>
                {(month) => <option value={month}>{month}月</option>}
              </For>
            </select>
          </div>
          <button
            type="button"
            aria-label="下个月"
            title="下个月"
            disabled={monthIndex(view()) >= maximumMonth}
            onClick={() => changeMonth(monthIndex(view()) + 1)}
          >
            <ChevronRight size={18} />
          </button>
        </header>
        <p class="date-field-month-announcement" aria-live="polite">
          {view().year}年{view().month}月
        </p>
        <div class="date-field-calendar-scroll">
          <table
            role="grid"
            aria-label={`${view().year}年${view().month}月`}
            class="date-field-calendar"
          >
            <thead>
              <tr>
                <For each={weekdays}>
                  {(day) => (
                    <th scope="col" abbr={`星期${day}`}>
                      {day}
                    </th>
                  )}
                </For>
              </tr>
            </thead>
            <tbody>
              <For each={cells()}>
                {(week) => (
                  <tr>
                    <For each={week}>
                      {(day) => (
                        <td
                          role="gridcell"
                          aria-selected={props.value === iso(day)}
                        >
                          <button
                            type="button"
                            data-date={iso(day)}
                            disabled={day.year < 1 || day.year > 9999}
                            tabIndex={iso(focused()) === iso(day) ? 0 : -1}
                            class={`${day.month !== view().month ? "date-field-outside-month" : ""} ${props.value === iso(day) ? "date-field-selected" : ""} ${iso(today()) === iso(day) ? "date-field-today" : ""}`}
                            aria-label={`${dateLabel(day)}${iso(today()) === iso(day) ? "，今天" : ""}`}
                            aria-current={
                              iso(today()) === iso(day) ? "date" : undefined
                            }
                            onFocus={() => setFocused(day)}
                            onKeyDown={dayKeyboard}
                            onClick={() => choose(day)}
                          >
                            {day.day}
                          </button>
                        </td>
                      )}
                    </For>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
        <footer class="date-field-calendar-footer">
          <button type="button" onClick={() => choose(localToday())}>
            今天
          </button>
          <button
            type="button"
            disabled={!props.value}
            onClick={() => choose(null)}
          >
            清除日期
          </button>
        </footer>
      </div>
    );
  }
  return (
    <span class="date-field">
      <button
        ref={trigger}
        type="button"
        class={`date-field-trigger ${props.value ? "" : "date-field-empty"}`}
        disabled={props.disabled}
        aria-label={props.label || "选择日期"}
        aria-haspopup="dialog"
        aria-controls={open() ? id : undefined}
        aria-expanded={open()}
        onClick={() => (open() ? close() : show())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            show();
          } else if (event.key === "Escape" && open()) {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
      >
        <span>{selected() ? dateLabel(selected()!) : "未设置日期"}</span>
        <CalendarDays size={18} />
      </button>
      <Show when={open()}>
        <Portal mount={host()}>
          <Calendar />
        </Portal>
      </Show>
    </span>
  );
}
