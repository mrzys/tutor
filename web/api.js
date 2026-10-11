export async function api(url, body, signal) {
  const response = await fetch(url, { ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal });
  let result;
  try { result = await response.json(); } catch { throw new Error('服务返回了无法读取的内容，请检查本地服务。'); }
  if (!response.ok || !result.ok) {
    const failure = new Error(result.error?.message || `请求失败（${response.status}）`);
    failure.status = response.status;
    failure.code = result.error?.code;
    throw failure;
  }
  return result;
}

export async function uploadApi(url, formData, signal) {
  const response = await fetch(url, { method: 'POST', body: formData, signal });
  let result;
  try { result = await response.json(); } catch { throw new Error('服务返回了无法读取的内容，请检查本地服务。'); }
  if (!response.ok || !result.ok) {
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
