import { assemblyLogTimings } from './assembly-log-timing.mjs';

// Metadata is joined only within an unambiguous request and model-call window.
// Retention gaps and concurrent legacy calls remain unknown instead of borrowing
// a neighbouring call's payload size, candidates, usage or failure.
export function assemblyLogCalls(events) {
  const rows = [], requests = new Map(), calls = new Map();
  const timings = new Map(assemblyLogTimings(events).rows.filter(row => row.category === 'model').map(row => [row.sequence, row]));
  const terminal = new Set(['completed', 'failed', 'cancelled']);
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const action = event.action || '', explicit = event.requestId || null;
    const active = requests.get(action) || new Set();
    if (event.category === 'request' && event.phase === 'request' && event.status === 'running') {
      active.add(explicit || `legacy:${event.sequence}`); requests.set(action, active); continue;
    }
    const requestId = explicit || (active.size === 1 ? [...active][0] : null);
    if (event.category === 'request' && event.phase === 'request' && terminal.has(event.status)) {
      if (requestId) active.delete(requestId); else active.clear();
      requests.set(action, active);
      for (const [key, pending] of calls) if (!requestId || pending.some(row => row.requestId === requestId)) {
        for (const row of pending) if (row.status === 'running') row.status = 'unfinished';
        calls.delete(key);
      }
      continue;
    }
    if (event.category !== 'model') continue;
    const task = event.details?.task || '';
    if (event.phase === 'candidate_window') {
      const { batchIndex, roundIndex } = event.details || {};
      // Window validation finishes after the model call. Join only by an exact,
      // unique batch and round identity; sequence proximity is not evidence.
      if (requestId && Number.isInteger(batchIndex) && Number.isInteger(roundIndex)) {
        const matches = rows.filter(row => row.requestId === requestId && row.task === task && row.metrics.batchIndex === batchIndex && row.metrics.roundIndex === roundIndex);
        if (matches.length === 1) for (const key of ['poolCount', 'presentedCount', 'assessedCount', 'searchIncomplete']) {
          if (event.details[key] !== undefined) matches[0].metrics[key] = event.details[key];
        }
      }
      continue;
    }
    const key = requestId ? `${requestId}:${task}` : null;
    const pending = key ? calls.get(key) || [] : [];
    if (event.phase === 'call' && event.status === 'running') {
      const timing = timings.get(event.sequence);
      const row = { sequence: event.sequence, requestId, task, status: 'running', elapsedMs: timing?.elapsedMs ?? null, durationSource: timing?.durationSource || 'unknown', metrics: { ...event.details } };
      rows.push(row);
      if (key) { pending.push(row); calls.set(key, pending); }
    } else if (event.phase === 'call' && terminal.has(event.status)) {
      const row = pending.length === 1 ? pending[0] : { sequence: event.sequence, requestId, task, metrics: {} };
      if (pending.length !== 1) rows.push(row);
      const timing = timings.get(row.sequence);
      Object.assign(row, { status: event.status, elapsedMs: timing?.elapsedMs ?? null, durationSource: timing?.durationSource || 'unknown' });
      Object.assign(row.metrics, event.details);
      if (key) calls.delete(key);
    } else if (['request_summary', 'response', 'budget'].includes(event.phase) && pending.length === 1) {
      Object.assign(pending[0].metrics, event.details);
    } else if (['response_headers', 'response_body'].includes(event.phase) && pending.length === 1 && typeof event.elapsedMs === 'number') {
      const name = event.phase === 'response_headers' ? 'responseHeadersMs' : 'responseBodyMs';
      pending[0].metrics[name] = event.elapsedMs;
      pending[0].metrics[`${name}Status`] = event.status;
    }
  }
  return rows;
}
