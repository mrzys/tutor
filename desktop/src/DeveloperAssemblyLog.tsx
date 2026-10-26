import { For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup, onMount, untrack } from "solid-js";
import { Copy, Maximize2, Minimize2, Minus, Pause, Play, RefreshCw } from "lucide-solid";
import { Portal } from "solid-js/web";
import { request } from "./bridge";
import { CloseButton, registerDeveloperToolRegion } from "./ui";
import { assemblyLogTimings } from "./shared/assembly-log-timing.mjs";
import { assemblyLogCalls } from "./shared/assembly-log-calls.mjs";
import "./DeveloperAssemblyLog.css";

type Trace = { traceId: string; startedAt: string | number; lastAt: string | number; eventCount: number; status: string };
type LogEvent = { sequence: number; at: string | number; requestId?: string; category: string; action: string; phase: string; status: string; elapsedMs?: number; durationSource?: string; details?: Record<string, unknown>; dataAvailable?: boolean; dataStatus?: string };
type Timing = { elapsedMs: number | null; durationSource: string };
type TimingRow = Timing & { key: string; sequence: number; requestId: string | null; category: string; action: string; phase: string; task: string; status: string; inferredEnd: boolean };
type LogResponse = { traces: Trace[]; traceId?: string | null; events: LogEvent[] };
type Artifact = { value?: unknown; text?: string; truncated: boolean; redacted?: boolean; originalBytes: number; storedBytes: number; reason?: string };
type EventData = Record<string, Artifact>;
type DetailResponse = { traceId: string; sequence: number; data: EventData | null; available?: boolean; reason?: string };
const dataLabels: Record<string, string> = { input: "输入", output: "输出", request: "模型请求", rawResponse: "原始响应", parsedResponse: "解析结果", validation: "校验" };
const metricLabels: Record<string, string> = { batchIndex: "批次", batchCount: "总批次", roundIndex: "轮次", poolCount: "候选池（去重）", presentedCount: "题位候选发送数", assessedCount: "题位候选判断数", candidateCount: "本次候选（去重）", slotCount: "题位", questionCount: "题量", requestBytes: "请求字节", httpStatus: "HTTP 状态" };

function ArtifactBody(props: { artifact: Artifact }) {
  const textFields = createMemo(() => {
    const value = props.artifact.value;
    if (props.artifact.text !== undefined) return [{ name: "正文", text: props.artifact.text }];
    if (typeof value === "string") return [{ name: "正文", text: value }];
    if (!value || typeof value !== "object") return [];
    const fields = Object.entries(value).filter(([key, text]) => /prompt|message|content|teacherRequest|instructions/i.test(key) && typeof text === "string").map(([name, text]) => ({ name, text: text as string }));
    const messages = (value as any).messages;
    if (Array.isArray(messages)) messages.forEach((message, index) => fields.push({ name: `消息 ${index + 1} · ${message.role || "未记录角色"}`, text: typeof message.content === "string" ? message.content : JSON.stringify(message.content, null, 2) || "" }));
    return fields;
  });
  return <div class="developer-log-artifact">
    <Show when={props.artifact.redacted}><p class="developer-log-note">此项数据中的密钥或学生关联信息已移除。</p></Show>
    <Show when={props.artifact.truncated}><p class="developer-log-truncation" role="status">内容已截断：原始 {props.artifact.originalBytes} 字节，已记录 {props.artifact.storedBytes} 字节。{props.artifact.reason}</p></Show>
    <Show when={!props.artifact.truncated && props.artifact.reason}><p class="developer-log-truncation">{props.artifact.reason}</p></Show>
    <For each={textFields()}>{field => <details class="developer-log-readable" open={field.text.length <= 600}><summary>{field.name}<span>{field.text.length} 字符</span></summary><pre tabIndex={0}>{field.text}</pre></details>}</For>
    <Show when={props.artifact.value !== undefined || props.artifact.text !== undefined} fallback={<p class="muted">此项数据已过期或未记录。</p>}>
      <details class="developer-log-raw"><summary>查看原始数据</summary><pre tabIndex={0}>{JSON.stringify(props.artifact.value ?? props.artifact.text, null, 2)}</pre></details>
    </Show>
  </div>;
}

const labels: Record<string, string> = {
  intake_prepare: "整理组卷要求", blueprint_plan: "安排题位", blueprint_check: "校验题位", draft_create: "选题并创建草稿",
  manual_draft_create: "手动创建草稿", draft_get: "读取草稿", draft_operation: "编辑草稿", draft_candidates: "读取候选题",
  paper_confirmation: "检查成卷条件", paper_confirm: "确认成卷", paper_get: "读取成卷", paper_derive: "继续编辑成卷",
  pdf_export: "导出 PDF", pdf_read: "读取 PDF", feedback_save: "保存反馈", history_delete: "删除历史", ui: "界面交互",
  preview_open: "打开预览", preview_close: "关闭预览", preview_kind_change: "切换预览版本", pdf_preview_open: "打开 PDF 预览",
  new_assembly: "新建组卷", history_open: "打开历史", retry: "重试", cancel: "取消",
  scope: "识别考查范围", supply: "核对题库供给", requirements: "整理题量与要求",
  intake_scope: "识别考查范围", intake: "整理需求", blueprint: "规划题位", selection: "比较候选题", coverage: "检查覆盖",
  plan_supply: "核对规划供给", plan_slots: "安排考查点与题位", plan_check: "校验题位规划",
  select_pool: "读取选题条件与题库", select_evaluate: "比较候选题目", select_save: "生成并保存草稿",
  request: "请求", response: "响应", workflow: "工作流", model: "模型调用", llm: "模型调用", validation: "校验",
  request_body: "模型请求正文", response_body: "模型响应正文", parsed_output: "解析模型结果", call: "模型调用", budget: "模型输出预算",
  request_summary: "模型请求统计", candidate_window: "候选检索窗口",
  response_headers: "等待响应头", timeout: "超时",
  start: "开始", started: "已开始", running: "进行中", active: "进行中", in_progress: "进行中", pending: "等待中", recorded: "已记录", received: "已接收",
  completed: "已完成", complete: "已完成", succeeded: "已完成", success: "成功", finished: "已结束",
  failed: "失败", error: "错误", cancelled: "已取消", canceled: "已取消", stopped: "已停止",
  unfinished: "未记录结束",
};
const label = (value: string) => labels[value] || value || "未记录";
function date(value: string | number) {
  const parsed = new Date(typeof value === "number" && value < 1e12 ? value * 1000 : value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString("zh-CN", { hour12: false });
}
const elapsed = (value: number) => value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(2)} 秒`;
const durationSource = (source: string) => ({ monotonic: "实测", recorded: "原记录", timestamps: "时间戳推算", unknown: "未记录" } as Record<string, string>)[source] || "未记录";

export function DeveloperAssemblyLog(props: { traceId: string; onClose: () => void }) {
  const [selected, setSelected] = createSignal(props.traceId);
  const [traces, setTraces] = createSignal<Trace[]>([]);
  const [events, setEvents] = createSignal<LogEvent[]>([]);
  const [statusFilter, setStatusFilter] = createSignal("");
  const [phaseFilter, setPhaseFilter] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [paused, setPaused] = createSignal(false);
  const [hidden, setHidden] = createSignal(document.hidden);
  const [minimized, setMinimized] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  const [error, setError] = createSignal("");
  const [copyMessage, setCopyMessage] = createSignal("");
  const [copyError, setCopyError] = createSignal("");
  const [copying, setCopying] = createSignal(false);
  const [selectedEvent, setSelectedEvent] = createSignal<number | null>(null);
  const [eventData, setEventData] = createSignal<EventData | null>(null);
  const [dataLoading, setDataLoading] = createSignal(false);
  const [dataError, setDataError] = createSignal("");
  const [dataTab, setDataTab] = createSignal("");
  const dataKeys = createMemo(() => Object.keys(eventData() || {}));
  const panelId = createUniqueId();
  let alive = true, inFlight = false, queued = false, revision = 0;
  let detailInFlight = false, detailQueued = false, detailRevision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let panel!: HTMLElement;
  let previousFocus: HTMLElement | null = null;
  let focusFrame = 0;
  const clearTimer = () => { clearTimeout(timer); timer = undefined; };
  const current = createMemo(() => traces().find(trace => trace.traceId === selected()));
  const choices = createMemo(() => {
    const ids = new Set([props.traceId, selected(), ...traces().map(trace => trace.traceId)]);
    return [...ids].filter(Boolean);
  });
  const choiceText = (traceId: string) => {
    const trace = traces().find(trace => trace.traceId === traceId);
    return `${traceId === props.traceId ? "当前流程" : "历史流程"} · ${trace ? `${date(trace.startedAt)} · ${label(trace.status)} · ${trace.eventCount} 条` : "暂无日志"} · ${traceId.slice(0, 8)}`;
  };
  const statuses = createMemo(() => [...new Set(events().map(event => event.status))]);
  const phases = createMemo(() => [...new Set(events().map(event => event.phase))]);
  const filtered = createMemo(() => events().filter(event => (!statusFilter() || event.status === statusFilter()) && (!phaseFilter() || event.phase === phaseFilter())));
  const timings = createMemo(() => assemblyLogTimings(events()) as { rows: TimingRow[]; eventDurations: Map<number, Timing> });
  const modelCalls = createMemo(() => assemblyLogCalls(events()));
  const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("zh-CN") : "未记录";
  const batchText = (metrics: Record<string, unknown>) => typeof metrics.batchIndex === "number" ? `${metrics.batchIndex}${typeof metrics.batchCount === "number" ? ` / ${metrics.batchCount}` : ""}` : "未记录";
  const eventTiming = (event: LogEvent): Timing | undefined => timings().eventDurations.get(event.sequence) || (typeof event.elapsedMs === "number" ? { elapsedMs: event.elapsedMs, durationSource: event.durationSource || "recorded" } : undefined);
  // A completed request may be followed by planning or selection in this same
  // assembly. Keep observing while the developer window is open between steps.
  const autoRefresh = () => !paused() && !hidden() && !minimized();

  async function refresh() {
    clearTimer();
    if (!alive) return;
    if (inFlight) { queued = true; return; }
    inFlight = true;
    setLoading(true);
    const target = selected(), version = revision;
    try {
      const result: LogResponse = await request("developer_assembly_logs", target ? { traceId: target } : {});
      if (!alive || version !== revision || target !== selected()) return;
      setTraces(result.traces || []);
      const incoming = result.traceId === target ? result.events || [] : [];
      setEvents(previous => {
        const existing = new Map(previous.map(event => [event.sequence, event]));
        return incoming.map(event => {
          const old = existing.get(event.sequence);
          return old && JSON.stringify(old) === JSON.stringify(event) ? old : event;
        });
      });
      setError("");
    } catch (failure: any) {
      if (alive && version === revision && target === selected()) setError(failure?.message || "日志读取失败，请重试。");
    } finally {
      inFlight = false;
      if (alive) {
        setLoading(false);
        if (queued) { queued = false; void refresh(); }
      }
    }
  }
  createEffect(() => {
    selected();
    untrack(() => {
      revision++;
      setEvents([]); setError(""); setStatusFilter(""); setPhaseFilter(""); setCopyMessage(""); setCopyError("");
      detailRevision++; setSelectedEvent(null); setEventData(null); setDataError("");
      void refresh();
    });
  });
  createEffect(() => {
    const poll = autoRefresh(), pending = loading();
    clearTimer();
    if (poll && !pending) timer = setTimeout(() => void refresh(), 1000);
  });
  onMount(() => {
    const unregister = registerDeveloperToolRegion(panel);
    onCleanup(unregister);
    previousFocus = document.activeElement as HTMLElement | null;
    focusFrame = requestAnimationFrame(() => {
      if (!document.querySelector('[role="dialog"][aria-modal="true"]')) panel.focus({ preventScroll: true });
    });
    const visibility = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", visibility);
    onCleanup(() => document.removeEventListener("visibilitychange", visibility));
  });
  onCleanup(() => {
    alive = false; revision++; detailRevision++; queued = false; detailQueued = false; clearTimer(); cancelAnimationFrame(focusFrame);
  });
  function closeWindow() {
    // Portal removal can already have moved focus to body by the time cleanup
    // runs, so capture ownership while the close control is still mounted.
    const restore = panel.contains(document.activeElement);
    const target = previousFocus?.isConnected ? previousFocus : document.querySelector<HTMLElement>('[aria-controls="developer-assembly-log-window"]');
    props.onClose();
    if (restore && target) {
      requestAnimationFrame(() => {
        const modal = document.querySelector('[role="dialog"][aria-modal="true"]');
        if (target.isConnected && (!modal || modal.contains(target) || target.matches('[aria-controls="developer-assembly-log-window"]'))) target.focus({ preventScroll: true });
      });
    }
  }
  function windowKey(event: KeyboardEvent) {
    if (event.key !== "Escape" || event.isComposing || event.defaultPrevented || event.target instanceof HTMLSelectElement || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
    event.preventDefault(); event.stopPropagation(); closeWindow();
  }

  async function loadData(sequence: number) {
    if (detailInFlight) { detailQueued = true; return; }
    detailInFlight = true; setDataLoading(true); setDataError("");
    const target = selected(), version = detailRevision;
    try {
      const result: DetailResponse = await request("developer_assembly_log_detail", { traceId: target, sequence });
      if (!alive || version !== detailRevision || selected() !== target || selectedEvent() !== sequence) return;
      if (result.traceId !== target || result.sequence !== sequence) throw new Error("日志数据与所选事件不一致，请重试。");
      if (!result.data) throw new Error(`该事件的数据未记录或已过期${result.reason ? `（${result.reason}）` : ""}。`);
      setEventData(result.data || {}); setDataTab(Object.keys(result.data || {})[0] || "");
    } catch (failure: any) {
      if (alive && version === detailRevision && selectedEvent() === sequence) setDataError(failure?.message || "事件数据读取失败，请重试。");
    } finally {
      detailInFlight = false;
      if (alive) {
        setDataLoading(false);
        if (detailQueued) { detailQueued = false; const latest = selectedEvent(); if (latest !== null) void loadData(latest); }
      }
    }
  }
  function chooseEvent(sequence: number) {
    detailRevision++; setCopyMessage(""); setCopyError(""); setEventData(null); setDataError("");
    if (selectedEvent() === sequence) { setSelectedEvent(null); return; }
    setSelectedEvent(sequence); void loadData(sequence);
  }
  function tabKey(event: KeyboardEvent, key: string) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const keys = dataKeys(), index = keys.indexOf(key);
    const next = event.key === "Home" ? 0 : event.key === "End" ? keys.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + keys.length) % keys.length;
    event.preventDefault();
    setDataTab(keys[next]);
    (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }

  async function copy(value: unknown, message: string) {
    if (copying()) return;
    setCopyMessage(""); setCopyError("");
    if (!navigator.clipboard?.writeText) { setCopyError("当前环境无法访问剪贴板。"); return; }
    const version = revision, eventVersion = detailRevision;
    setCopying(true);
    try {
      await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
      if (alive && version === revision && eventVersion === detailRevision) setCopyMessage(message);
    } catch {
      if (alive && version === revision && eventVersion === detailRevision) setCopyError("复制失败，请检查剪贴板权限后重试。");
    } finally { if (alive) setCopying(false); }
  }

  return <Portal>
    <section ref={panel} id="developer-assembly-log-window" class="developer-log-window" classList={{ "is-minimized": minimized(), "is-expanded": expanded() && !minimized() }} role="region" aria-label="开发者组卷日志" tabIndex={-1} onKeyDown={windowKey}>
      <header class="developer-log-window-header">
        <h2>开发者组卷日志</h2>
        <div class="developer-log-window-controls">
          <button type="button" class="icon-button" aria-label={minimized() ? "展开日志" : "收起日志"} title={minimized() ? "展开日志" : "收起日志"} aria-expanded={!minimized()} onClick={() => setMinimized(value => !value)}>{minimized() ? <Maximize2 size={18} /> : <Minus size={18} />}</button>
          <Show when={!minimized()}><button type="button" class="icon-button" aria-label={expanded() ? "还原日志窗口" : "放大日志窗口"} title={expanded() ? "还原日志窗口" : "放大日志窗口"} aria-pressed={expanded()} onClick={() => setExpanded(value => !value)}>{expanded() ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button></Show>
          <CloseButton onClick={closeWindow} label="关闭开发者日志" />
        </div>
      </header>
    <div class="developer-assembly-log developer-log-window-body" hidden={minimized()}>
      <p class="developer-log-note">开发模式记录每步输入、输出与模型交互；密钥不记录，正文按需读取。</p>
      <div class="developer-log-toolbar">
        <label class="developer-log-trace">流程<select aria-label="日志流程" value={selected()} onChange={event => setSelected(event.currentTarget.value)}><For each={choices()}>{traceId => <option value={traceId} selected={selected() === traceId}>{choiceText(traceId)}</option>}</For></select></label>
        <label>状态<select aria-label="日志状态" value={statusFilter()} onChange={event => setStatusFilter(event.currentTarget.value)}><option value="">全部状态</option><For each={statuses()}>{status => <option value={status}>{label(status)} · {status}</option>}</For></select></label>
        <label>阶段<select aria-label="日志阶段" value={phaseFilter()} onChange={event => setPhaseFilter(event.currentTarget.value)}><option value="">全部阶段</option><For each={phases()}>{phase => <option value={phase}>{label(phase)} · {phase}</option>}</For></select></label>
      </div>
      <div class="developer-log-actions">
        <button type="button" class="secondary" disabled={loading()} onClick={() => void refresh()}><RefreshCw size={16} />{loading() ? "刷新中…" : "刷新"}</button>
        <button type="button" class="secondary" aria-pressed={paused()} onClick={() => setPaused(value => !value)}>{paused() ? <Play size={16} /> : <Pause size={16} />}{paused() ? "继续刷新" : "暂停刷新"}</button>
        <button type="button" class="secondary" disabled={!events().length || copying()} onClick={() => void copy({ traceId: selected(), trace: current() || null, events: events() }, "已复制当前流程元数据")}><Copy size={16} />复制元数据</button>
      </div>
      <div class="developer-log-meta"><code>{selected()}</code><span>{current() ? label(current()!.status) : "暂无记录"} · {filtered().length} / {events().length} 条<Show when={paused()}> · 已暂停</Show><Show when={hidden()}> · 后台暂停</Show></span></div>
      <Show when={modelCalls().length}><section class="developer-log-calls" aria-label="逐次模型调用">
        <h3>逐次模型调用</h3>
        <div class="developer-log-call-scroll" tabIndex={0} aria-label="模型调用指标表，可横向滚动"><table>
          <thead><tr><th>调用</th><th>批次 / 轮次</th><th>候选</th><th>请求</th><th>耗时</th><th>用量</th><th>状态</th></tr></thead>
          <tbody><For each={modelCalls()}>{call => <tr data-sequence={call.sequence} data-status={call.status}>
            <td>{label(call.task)}<small>#{call.sequence}</small></td>
            <td>{batchText(call.metrics)}<small>轮次 {count(call.metrics.roundIndex)}</small></td>
            <td>{count(call.metrics.candidateCount)}<small>题位 {count(call.metrics.slotCount)}</small><Show when={typeof call.metrics.poolCount === "number"}><small>候选池（去重） {count(call.metrics.poolCount)}</small></Show><Show when={typeof call.metrics.assessedCount === "number"}><small>题位候选判断 {count(call.metrics.assessedCount)}</small></Show></td>
            <td>{typeof call.metrics.requestBytes === "number" ? `${(call.metrics.requestBytes / 1024).toFixed(1)} KB` : "未记录"}</td>
            <td>{call.elapsedMs === null ? call.status === "running" ? "进行中" : "未记录" : elapsed(call.elapsedMs!)}<small>{durationSource(call.durationSource || "unknown")}</small><Show when={typeof call.metrics.responseHeadersMs === "number"}><small>响应头 {elapsed(Number(call.metrics.responseHeadersMs))} · {label(String(call.metrics.responseHeadersMsStatus))}</small></Show><Show when={typeof call.metrics.responseBodyMs === "number"}><small>正文 {elapsed(Number(call.metrics.responseBodyMs))} · {label(String(call.metrics.responseBodyMsStatus))}</small></Show></td>
            <td>输入 {count(call.metrics.promptTokens)}<small>输出 {count(call.metrics.completionTokens)} · 思考 {count(call.metrics.reasoningTokens)}</small></td>
            <td>{label(call.status)}<Show when={call.metrics.errorCode}><small class="developer-log-error">{String(call.metrics.errorCode)}</small></Show></td>
          </tr>}</For></tbody>
        </table></div>
      </section></Show>
      <Show when={timings().rows.length}><details class="developer-log-timings" open><summary>执行耗时</summary><p class="developer-log-note">请求总耗时包含内部阶段，模型调用与阶段可能重叠，不相加。</p><ol aria-label="请求与阶段耗时"><For each={timings().rows}>{row => <li data-category={row.category} data-status={row.status}>
        <div><strong>{row.category === "request" ? `${label(row.action)} · 请求总耗时` : row.category === "model" ? `${label(row.task || row.phase)} · 模型调用` : label(row.phase)}</strong><span>{label(row.status)}<Show when={row.inferredEnd}> · 按请求结束时间推算</Show></span></div>
        <span class="developer-log-duration"><strong>{row.elapsedMs === null ? "未知" : elapsed(row.elapsedMs)}</strong><small>{durationSource(row.durationSource)}</small></span>
      </li>}</For></ol></details></Show>
      <Show when={events()[0]?.sequence > 1}><p class="developer-log-truncation" role="status">较早的日志已按保留上限清理，当前从第 {events()[0].sequence} 条开始。</p></Show>
      <Show when={error()}><p class="developer-log-error" role="alert">{error()}</p></Show>
      <Show when={copyError()}><p class="developer-log-error" role="alert">{copyError()}</p></Show>
      <Show when={copyMessage()}><p class="developer-log-feedback" role="status">{copyMessage()}</p></Show>
      <Show when={filtered().length} fallback={<p class="developer-log-empty" role="status">{loading() ? "正在读取日志…" : events().length ? "没有符合筛选的日志。" : "所选流程暂无日志。"}</p>}>
        <ol class="developer-log-events" aria-label="组卷执行日志"><For each={filtered()}>{event => <li data-sequence={event.sequence} data-status={event.status}>
          <div class="developer-log-event-heading"><strong>{label(event.action)}</strong><span><Show when={typeof event.details?.task === "string"}>{label(String(event.details?.task))} · </Show>{event.category === "model" && event.phase === "response_body" ? "读取响应正文" : label(event.phase)} · {label(event.status)}</span></div>
          <div class="developer-log-event-meta"><time>{date(event.at)}</time><span>#{event.sequence}</span><Show when={eventTiming(event)?.elapsedMs != null}><span>{elapsed(eventTiming(event)!.elapsedMs!)} · {durationSource(eventTiming(event)!.durationSource)}</span></Show></div>
          <dl class="developer-log-metrics"><For each={Object.entries(metricLabels).filter(([key]) => typeof event.details?.[key] === "number")}>{([key, name]) => <div><dt>{name}</dt><dd>{count(event.details?.[key])}</dd></div>}</For><Show when={typeof event.details?.searchIncomplete === "boolean"}><div><dt>判断范围</dt><dd>{event.details?.searchIncomplete ? "仍有未判断候选" : "已完成本轮判断"}</dd></div></Show></dl>
          <Show when={event.details?.errorCode}><p class="developer-log-error">错误码：{String(event.details?.errorCode)}</p></Show>
          <details><summary>执行详情</summary><dl><div><dt>category</dt><dd>{event.category}</dd></div><div><dt>action</dt><dd>{event.action}</dd></div><div><dt>phase</dt><dd>{event.phase}</dd></div><div><dt>status</dt><dd>{event.status}</dd></div></dl><Show when={event.details && Object.keys(event.details).length}><pre>{JSON.stringify(event.details, null, 2)}</pre></Show></details>
          <Show when={event.dataStatus === "expired"}><p class="developer-log-truncation">此事件的详细数据已按保留上限清理。</p></Show>
          <Show when={event.dataStatus === "not_captured" && (event.category === "request" || event.category === "data")}><p class="muted">记录此事件时未采集正文，历史正文无法补回。</p></Show>
          <Show when={event.dataAvailable || event.dataStatus === "expired"}><button type="button" class="secondary developer-log-data-toggle" aria-expanded={selectedEvent() === event.sequence} onClick={() => chooseEvent(event.sequence)}>{selectedEvent() === event.sequence ? "收起数据" : "查看数据"}</button></Show>
          <Show when={selectedEvent() === event.sequence}>
            <section class="developer-log-data" aria-label={`事件 ${event.sequence} 数据`}>
              <Show when={dataLoading()}><p role="status">正在读取事件数据…</p></Show>
              <Show when={dataError()}><p class="developer-log-error" role="alert">{dataError()}</p><button type="button" class="secondary" disabled={dataLoading()} onClick={() => void loadData(event.sequence)}>重试读取数据</button></Show>
              <Show when={eventData()}>
                <Show when={dataKeys().length} fallback={<p class="muted">该事件的数据已过期或未记录。</p>}>
                  <div class="developer-log-data-tabs" role="tablist" aria-label="事件数据类型"><For each={dataKeys()}>{key => <button type="button" role="tab" tabIndex={dataTab() === key ? 0 : -1} id={`${panelId}-${key}`} aria-controls={`${panelId}-content`} aria-selected={dataTab() === key} onKeyDown={event => tabKey(event, key)} onClick={() => setDataTab(key)}>{dataLabels[key] || key}</button>}</For></div>
                  <div class="developer-log-data-panel" role="tabpanel" id={`${panelId}-content`} aria-labelledby={`${panelId}-${dataTab()}`}><Show when={eventData()?.[dataTab()]}>{artifact => <ArtifactBody artifact={artifact()} />}</Show></div>
                  <button type="button" class="secondary developer-log-copy-data" disabled={copying()} onClick={() => void copy({ traceId: selected(), sequence: event.sequence, data: eventData() }, "已复制此事件已记录的数据")}><Copy size={16} />复制事件数据</button>
                </Show>
              </Show>
            </section>
          </Show>
        </li>}</For></ol>
      </Show>
    </div>
    </section>
  </Portal>;
}
