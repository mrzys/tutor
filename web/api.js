export async function api(url, body, signal) {
  const response = await fetch(url, { ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal });
  let result;
  try { result = await response.json(); } catch { throw new Error('服务返回了无法读取的内容，请检查本地服务。'); }
  if (!response.ok || !result.ok) {
    if (response.status === 401 && !url.startsWith('/api/auth/')) window.dispatchEvent(new Event('tutor:unauthorized'));
    const failure = new Error(result.error?.message || `请求失败（${response.status}）`);
    failure.status = response.status;
    failure.code = result.error?.code;
    throw failure;
  }
  return result;
}

// POST keeps authentication and cancellation on the same request as generation.
export async function streamApi(url, body, signal, onProgress) {
  const response = await fetch(url, { method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify(body) });
  const checked = (result, status = response.status) => {
    if (!response.ok || !result?.ok) {
      if (status === 401) window.dispatchEvent(new Event('tutor:unauthorized'));
      const error = new Error(result?.error?.message || `请求失败（${status}）`);
      error.status = status; error.code = result?.error?.code; throw error;
    }
    return result;
  };
  // Authentication failures and older servers still return ordinary JSON.
  if (!response.headers.get('content-type')?.startsWith('application/x-ndjson')) return checked(await response.json());
  if (!response.body) throw new Error('服务未返回生成进度，请重试。');
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let pending = ''; let result; let status;
  const consume = line => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'progress') onProgress?.(event.progress);
    else if (event.type === 'result') { result = event.result; status = event.status; }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        consume(pending.slice(0, end)); pending = pending.slice(end + 1);
        if (result !== undefined) return checked(result, status);
      }
      if (done) break;
    }
    if (pending.trim()) consume(pending);
    if (result === undefined) throw new Error('生成连接已中断，请先查看历史组卷确认是否已保存。');
    return checked(result, status);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function uploadApi(url, formData, signal) {
  const response = await fetch(url, { method: 'POST', body: formData, signal });
  let result;
  try { result = await response.json(); } catch { throw new Error('服务返回了无法读取的内容，请检查本地服务。'); }
  if (!response.ok || !result.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('tutor:unauthorized'));
    const failure = new Error(result.error?.message || `上传失败（${response.status}）`);
    failure.status = response.status;
    failure.code = result.error?.code;
    throw failure;
  }
  return result;
}

export const typeLabels = { single_choice: '单选', fill_blank: '填空', free_response: '解答' };
export const typeTitles = { single_choice: '单项选择题', fill_blank: '填空题', free_response: '解答题' };
export const statusLabels = { eligible: '符合条件', related: '存在差异', unknown: '证据不足', pending: '待整理', read_failed: '读取失败' };
export const sourceLabel = (source, config) => config.sources.find(item => item.sourceId === source)?.label || (source === 'set-teacher' ? '解析版' : source === 'set-student' ? '原卷版' : source);

export function allocateParts(task, points) {
  if (task.questionType !== 'free_response') return [];
  const ids = task.partIds || ['p1', 'p2'];
  const weights = task.partWeights?.length ? task.partWeights : ids.map(() => 1);
  const total = weights.reduce((sum, value) => sum + value, 0);
  const exact = weights.map(value => value * points / total);
  const result = exact.map(Math.floor);
  const order = exact.map((value, index) => ({ index, remainder: value - result[index] })).sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  const remainder = points - result.reduce((sum, value) => sum + value, 0);
  for (let i = 0; i < remainder; i++) result[order[i].index]++;
  return ids.map((partId, index) => ({ partId, points: result[index] }));
}

export function blueprintError(blueprint) {
  for (const slot of blueprint.slots) {
    if (!Number.isInteger(slot.points) || slot.points < 0 || slot.points > 1000) return `第 ${slot.number} 题分值需为 0～1000 的整数。`;
    if (slot.questionType === 'free_response' && (slot.partPoints.some(part => !Number.isInteger(part.points) || part.points < 0) || slot.partPoints.reduce((sum, part) => sum + part.points, 0) !== slot.points)) return `第 ${slot.number} 题的小问分值合计须等于题位分值 ${slot.points} 分。`;
  }
  return '';
}
