const terminal = new Set(["completed", "failed", "cancelled"]);
const numericDuration = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
function timestamp(value) {
  if (!(typeof value === "number" && Number.isFinite(value) || typeof value === "string" && value.trim())) return null;
  const parsed = new Date(typeof value === "number" && value < 1e12 ? value * 1000 : value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}
function duration(event, start) {
  if (numericDuration(event.elapsedMs)) return { elapsedMs: event.elapsedMs, durationSource: event.durationSource === "monotonic" ? "monotonic" : "recorded" };
  const from = start && timestamp(start.at), to = timestamp(event.at);
  return from !== null && from !== undefined && to !== null && to >= from
    ? { elapsedMs: to - from, durationSource: "timestamps" }
    : { elapsedMs: null, durationSource: "unknown" };
}

// Preserve raw events. Legacy wall-clock inference is only allowed inside an
// unambiguous request boundary; new request IDs also survive retention cuts.
/** @param {Array<any>} events */
export function assemblyLogTimings(events) {
  const rows = [], eventDurations = new Map(), active = new Map(), pending = new Map();
  const requestRows = new Map();
  const sorted = [...events].sort((left, right) => left.sequence - right.sequence);
  function create(event, context) {
    const row = { key: `${event.category}:${event.sequence}`, sequence: event.sequence, requestId: context || null, category: event.category, action: event.action, phase: event.phase, task: event.details?.task || "", status: event.status, elapsedMs: null, durationSource: "unknown", inferredEnd: false, start: event.status === "running" ? event : null };
    rows.push(row);
    return row;
  }
  function complete(row, event) {
    Object.assign(row, duration(event, row.start), { status: event.status });
    eventDurations.set(event.sequence, { elapsedMs: row.elapsedMs, durationSource: row.durationSource });
  }
  function pendingKey(category, context, event) {
    return context ? `${category}:${context}:${event.phase}:${event.details?.task || ""}` : null;
  }
  for (const event of sorted) {
    const action = event.action || "", contexts = active.get(action) || new Set();
    const explicit = typeof event.requestId === "string" && event.requestId ? event.requestId : null;
    const isRequest = event.category === "request" && event.phase === "request";
    if (isRequest && event.status === "running") {
      const context = explicit || `legacy:${event.sequence}`;
      contexts.add(context); active.set(action, contexts);
      const row = create(event, context);
      const list = requestRows.get(context) || [];
      list.push(row); requestRows.set(context, list);
      continue;
    }
    const context = explicit || (contexts.size === 1 ? [...contexts][0] : null);
    if (isRequest && terminal.has(event.status)) {
      const candidates = context ? requestRows.get(context) || [] : [];
      const row = candidates.length === 1 ? candidates[0] : create(event, context);
      complete(row, event);
      // An old failed request did not emit a terminal stage. Its real terminal
      // timestamp bounds that stage, without calling it successfully completed.
      if (context) {
        for (const [key, list] of pending) {
          if (!key.startsWith(`stage:${context}:`)) continue;
          for (const stage of list) {
            if (list.length === 1 && ["failed", "cancelled"].includes(event.status)) {
              Object.assign(stage, duration({ at: event.at }, stage.start), { status: event.status, inferredEnd: true });
            } else {
              stage.status = "unfinished";
            }
          }
          pending.delete(key);
        }
        contexts.delete(context); requestRows.delete(context);
      } else {
        // Multiple old requests with the same action cannot be matched safely.
        for (const candidate of contexts) {
          for (const list of pending.values()) for (const row of list) if (row.requestId === candidate) row.status = "unfinished";
        }
        contexts.clear();
      }
      active.set(action, contexts);
      continue;
    }
    if (!(event.category === "stage" || event.category === "model" && event.phase === "call")) continue;
    const key = pendingKey(event.category, context, event);
    if (event.status === "running") {
      const row = create(event, context);
      if (key) { const list = pending.get(key) || []; list.push(row); pending.set(key, list); }
    } else if (terminal.has(event.status)) {
      const candidates = key ? pending.get(key) || [] : [];
      const row = candidates.length === 1 ? candidates[0] : create(event, context);
      complete(row, event);
      if (key) pending.delete(key);
    }
  }
  return { rows: rows.map(({ start, ...row }) => row), eventDurations };
}
