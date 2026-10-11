import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hashContent, getQuestion } from '../question-bank/reader.mjs';
import { getAssemblyConfig, loadPool, slotCandidates, normalizeRequirements, partAllocation } from './engine.mjs';
import { goalDifferences, suggestedGoalIds } from './teaching-goals.mjs';

const defaultRoot = fileURLToPath(new URL('../../', import.meta.url));
const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
class EditError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const reject = message => { throw new EditError('invalid_operation', message); };
const failure = error => ({ ok: false, error: { code: error.code ?? 'read_error', message: error.message } });
const sum = values => values.reduce((a, b) => a + b, 0);
const revisionOf = draft => draft.revision ?? 0;
const requirementsOf = draft => draft.baseline.requirements;

function validateDraft(draft) {
  if (!object(draft) || draft.schemaVersion !== 1 || !Array.isArray(draft.slots) || !object(draft.baseline)
      || !object(draft.baseline.requirements) || !Array.isArray(draft.baseline.slots)
      || !Number.isInteger(revisionOf(draft)) || revisionOf(draft) < 0
      || (draft.operations !== undefined && !Array.isArray(draft.operations))) reject('草稿或修订版本无效。');
  if (new Set(draft.slots.map(slot => slot.slotId)).size !== draft.slots.length) reject('草稿题位身份重复。');
}

function checkRevision(draft, expectedRevision) {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) reject('需要提供当前草稿修订版本。');
  if (expectedRevision !== revisionOf(draft)) throw new EditError('revision_conflict', '草稿已更新，请重新加载后再应用修改。');
}

function slotById(draft, slotId) {
  if (typeof slotId !== 'string') reject('题位身份无效。');
  const slot = draft.slots.find(item => item.slotId === slotId);
  if (!slot) reject('指定题位已不存在。');
  return slot;
}

function scopedSlots(draft, operation) {
  if (!Array.isArray(operation.slotIds) || !operation.slotIds.length
      || operation.slotIds.length > 60 || new Set(operation.slotIds).size !== operation.slotIds.length) reject('请选择不重复的操作题位。');
  return operation.slotIds.map(id => slotById(draft, id));
}

function modeOf(operation) {
  if (!['direct', 'automatic'].includes(operation.mode)) reject('需明确直接操作或自动调整。');
  return operation.mode;
}

function pointsFor(slot, points, partPoints) {
  if (!Number.isInteger(points) || points < 0 || points > 1000) reject('题分需为 0～1000 的整数。');
  if (!Array.isArray(partPoints)) reject('需提供小问分值数组。');
  const expected = slot.question?.student.parts?.length
    ? slot.question.student.parts.map(part => part.partId)
    : (slot.partPoints ?? []).map(part => part.partId);
  if (slot.questionType !== 'free_response') {
    if (partPoints.length) reject('非解答题不设置小问分值。');
  } else if (!expected.length || partPoints.length !== expected.length
      || new Set(partPoints.map(part => part?.partId)).size !== expected.length
      || partPoints.some(part => !object(part) || !expected.includes(part.partId)
        || !Number.isInteger(part.points) || part.points < 0 || part.points > 1000)
      || sum(partPoints.map(part => part.points)) !== points) {
    reject('小问身份或小问分值合计与当前题分不一致。');
  }
  return { points, partPoints: clone(partPoints) };
}

async function configFor(root) {
  const loaded = await getAssemblyConfig({ root });
  if (!loaded.ok) throw new EditError(loaded.error.code, loaded.error.message);
  return loaded.config;
}

function occupied(draft, excludedSlotId, pool) {
  const ids = new Set(); const groups = new Set();
  for (const slot of draft.slots) {
    if (slot.slotId === excludedSlotId || !slot.question) continue;
    ids.add(slot.question.questionId);
    const annotation = pool.records.find(item => item.entry.questionId === slot.question.questionId)?.annotation
      ?? draft.baseline.questionIndexSnapshot?.entries?.find(item => item.questionId === slot.question.questionId);
    if (annotation?.duplicateGroup) groups.add(annotation.duplicateGroup);
  }
  return { ids, groups };
}

function candidatesFor(draft, slot, pool) {
  const used = occupied(draft, slot.slotId, pool);
  return slotCandidates(pool, slot, requirementsOf(draft), used.ids, used.groups).map(candidate => {
    const record = pool.records.find(item => item.entry.questionId === candidate.questionId);
    const annotation = record?.annotation;
    const duplicate = used.ids.has(candidate.questionId) || (annotation?.duplicateGroup && used.groups.has(annotation.duplicateGroup));
    const current = slot.question?.questionId === candidate.questionId;
    // Unknown solution evidence must never bypass the independent same-paper duplicate check.
    const reasons = [...candidate.reasons];
    if (duplicate && !reasons.includes('本卷已使用同题或重复组')) reasons.push('本卷已使用同题或重复组');
    if (current) reasons.push('当前题目，不作为换题备选');
    let allocationCompatible = true;
    if (record?.result.ok) {
      try { pointsFor({ ...slot, question: record.result.question }, slot.points, slot.partPoints); }
      catch { allocationCompatible = false; reasons.push('候选小问与当前赋分不兼容，需先调整题位'); }
    }
    return { ...candidate, duplicate: Boolean(duplicate), current,
      canSelect: !duplicate && !current && allocationCompatible && ['eligible', 'related', 'unknown'].includes(candidate.status),
      status: candidate.status === 'eligible' && (duplicate || current || !allocationCompatible) ? 'related' : candidate.status,
      reasons };
  });
}

function partialSuggestions(slot, config, pool) {
  const links = config.tasks.find(task => task.id === slot.taskId)?.partialAlternatives ?? [];
  return links.flatMap(link => {
    const pending = pool.pending.find(item => item.questionId === link.questionId);
    return pending ? [{ questionId: pending.questionId, status: 'pending', reasons: [link.reason, ...pending.reasons],
      notes: ['仅为部分相关材料；尚未核查完整题包，不能选入。'] }] : [];
  });
}

export async function previewDraftCandidates(draft, { slotId, expectedRevision } = {}, { root = defaultRoot } = {}) {
  try {
    validateDraft(draft); checkRevision(draft, expectedRevision);
    const slot = slotById(draft, slotId);
    const config = await configFor(root); const pool = await loadPool(root);
    const assessed = candidatesFor(draft, slot, pool);
    const attach = candidate => ({ ...candidate,
      question: clone(pool.records.find(item => item.entry.questionId === candidate.questionId)?.result.question ?? null) });
    return { ok: true, revision: revisionOf(draft), slotId,
      candidates: assessed.filter(item => item.status === 'eligible').map(attach),
      suggestions: [...assessed.filter(item => ['unknown', 'related'].includes(item.status)).map(attach), ...partialSuggestions(slot, config, pool)],
      failures: assessed.filter(item => item.status === 'read_failed'), pending: clone(pool.pending),
      supply: { ...pool.totals, pendingCount: pool.pending.length } };
  } catch (error) { return failure(error); }
}

// One pool read supplies every slot in this exact draft revision. Reuse the
// replacement assessment so current questions, occupied IDs and duplicate
// groups never inflate the availability shown before opening the dialog.
export async function previewDraftCandidateSupply(draft, { expectedRevision } = {}, { root = defaultRoot } = {}) {
  try {
    validateDraft(draft); checkRevision(draft, expectedRevision);
    const pool = await loadPool(root);
    return { ok: true, revision: revisionOf(draft), slots: draft.slots.map(slot => {
      const assessed = candidatesFor(draft, slot, pool);
      return { slotId: slot.slotId,
        eligibleCount: assessed.filter(item => item.canSelect && item.status === 'eligible').length,
        suggestionCount: assessed.filter(item => item.canSelect && ['unknown', 'related'].includes(item.status)).length,
        readFailureCount: assessed.filter(item => item.status === 'read_failed').length };
    }) };
  } catch (error) { return failure(error); }
}

function scoringStatus(slot) {
  return { status: 'unconfirmed', message: '当前题分及小问分值为本草稿赋分；教师建议仅属该题的引用资料，未自动转换为当前评分细则。',
    questionId: slot.question?.questionId ?? null, points: slot.points, partPoints: clone(slot.partPoints) };
}

function planSlot(slot) {
  return Object.fromEntries(['slotId', 'number', 'questionType', 'taskId', 'taskLabel', 'points', 'partPoints', 'targetDifficulty', 'goalIds']
    .filter(key => slot[key] !== undefined).map(key => [key, clone(slot[key])]));
}

function refreshStats(draft) {
  if (requirementsOf(draft).scoringMode === 'none') {
    draft.slots.forEach(slot => { slot.points = 0; slot.partPoints = (slot.partPoints ?? []).map(part => ({ ...part, points: 0 })); delete slot.scoringStatus; });
  }
  draft.slots.forEach((slot, index) => { slot.number = index + 1; });
  const selected = draft.slots.filter(slot => slot.question);
  draft.stats = { plannedQuestions: draft.slots.length, selectedQuestions: selected.length,
    plannedPoints: sum(draft.slots.map(slot => slot.points)), availablePoints: sum(selected.map(slot => slot.points)),
    missingQuestions: draft.slots.length - selected.length, difficultyEstimate: null };
  const baselineSlots = draft.baseline.slots;
  const differences = [];
  differences.push(...goalDifferences(draft.baseline.requirements, draft.slots, draft.baseline.taskCatalogSnapshot?.tasks ?? []));
  if (requirementsOf(draft).scoringMode !== 'none' && draft.stats.plannedPoints !== draft.baseline.requirements.targetScore) differences.push({ code: 'planned_score_differs',
    message: `当前题位合计 ${draft.stats.plannedPoints} 分，与需求 ${draft.baseline.requirements.targetScore} 分不同。`,
    expected: draft.baseline.requirements.targetScore, actual: draft.stats.plannedPoints });
  for (const original of baselineSlots) {
    const current = draft.slots.find(slot => slot.slotId === original.slotId);
    if (!current) differences.push({ code: 'slot_deleted', slotId: original.slotId, message: `基线第 ${original.number} 题已删除。` });
    else if (requirementsOf(draft).scoringMode !== 'none' && (current.points !== original.points || hashContent(current.partPoints) !== hashContent(original.partPoints))) differences.push({
      code: 'points_changed', slotId: current.slotId, message: `第 ${current.number} 题赋分与基线不同：${original.points} → ${current.points} 分。` });
  }
  for (const slot of draft.slots) {
    if (!baselineSlots.some(original => original.slotId === slot.slotId)) differences.push({ code: 'slot_added', slotId: slot.slotId, message: `第 ${slot.number} 题为新增题位。` });
    if (!slot.question) differences.push({ code: slot.status === 'search_failed' ? 'retrieval_failed' : 'missing_question', slotId: slot.slotId,
      message: `第 ${slot.number} 题未选入题目，保留题位。` });
    if (slot.applicability && slot.applicability.status !== 'eligible') differences.push({ code: 'applicability_unconfirmed', slotId: slot.slotId,
      message: `第 ${slot.number} 题当前适配状态：${slot.applicability.status}；${slot.applicability.reasons.join('；')}` });
    if (slot.targetDifficulty !== undefined && slot.targetDifficulty !== draft.baseline.requirements.targetDifficulty) differences.push({ code: 'difficulty_target_changed',
      slotId: slot.slotId, message: `第 ${slot.number} 题目标难度 ${slot.targetDifficulty}；实际估计仍未知。` });
  }
  const countDifferences = Object.entries(draft.baseline.requirements.counts).filter(([type, count]) => draft.slots.filter(slot => slot.questionType === type).length !== count);
  if (countDifferences.length) differences.push({ code: 'question_counts_changed', message: '当前题型数量与基线需求不同。',
    expected: clone(draft.baseline.requirements.counts), actual: Object.fromEntries(Object.keys(draft.baseline.requirements.counts)
      .map(type => [type, draft.slots.filter(slot => slot.questionType === type).length])) });
  differences.push({ code: 'difficulty_unknown', message: '现有题包没有独立难度估计，实际整卷难度保持未知。' });
  draft.differences = differences;
}

async function replaceOne(draft, slot, operation, pool) {
  if (operation.mode === 'automatic' && slot.locked) return { slotId: slot.slotId, status: 'skipped_locked', message: '自动调整跳过锁定题。' };
  const candidates = candidatesFor(draft, slot, pool);
  const candidate = operation.candidateId ? candidates.find(item => item.questionId === operation.candidateId)
    : candidates.find(item => item.status === 'eligible');
  const explicitDifference = operation.mode === 'direct' && operation.allowDifference === true && typeof operation.candidateId === 'string';
  const canSelect = candidate && !candidate.duplicate && !candidate.current && (candidate.status === 'eligible'
    || (explicitDifference && ['related', 'unknown'].includes(candidate.status)));
  if (!canSelect) {
    const failures = candidates.filter(item => item.status === 'read_failed');
    const readFailed = candidate?.status === 'read_failed' || (!candidate && failures.length > 0);
    return { slotId: slot.slotId, status: readFailed ? 'read_failed' : 'unchanged',
      message: readFailed ? '候选读取失败，保留现题。' : '没有可应用的未重复候选，保留现题。',
      reasons: candidate?.reasons ?? [], failures, suggestions: candidates.filter(item => ['related', 'unknown'].includes(item.status)) };
  }
  const record = pool.records.find(item => item.entry.questionId === candidate.questionId);
  const newQuestion = clone(record.result.question);
  try { pointsFor({ ...slot, question: newQuestion }, slot.points, slot.partPoints); }
  catch (error) { return { slotId: slot.slotId, status: 'unchanged', message: `新题小问与当前赋分不兼容，保留现题。${error.message}` }; }
  const previousId = slot.question?.questionId ?? null;
  slot.question = newQuestion; slot.status = 'selected';
  slot.applicability = clone(candidate);
  slot.selection = { candidates, failures: candidates.filter(item => item.status === 'read_failed'),
    selectedReason: { method: explicitDifference && candidate.status !== 'eligible' ? 'explicit_difference_selection' : 'draft_eligible_replacement',
      text: candidate.status === 'eligible' ? '按当前题位与已确认条件检索，候选满足完整允许解法且未重复；保留当前分值。'
        : '用户明确选择差异/未知候选，保留全部提示，不记为已证实符合。',
      allowedSolutionPath: candidate.allowedSolutionPath ?? null, goalSupport: clone(candidate.goalSupport ?? []), notes: clone(candidate.notes) },
    reasons: clone(candidate.reasons), suggestions: [] };
  if (requirementsOf(draft).scoringMode !== 'none') slot.scoringStatus = scoringStatus(slot);
  return { slotId: slot.slotId, status: 'replaced', message: requirementsOf(draft).scoringMode === 'none' ? '已换题，本次练习不计分。' : `已换题，保留 ${slot.points} 分；新题评分细则需核对。`,
    fromQuestionId: previousId, toQuestionId: newQuestion.questionId, notes: clone(candidate.notes), reasons: clone(candidate.reasons) };
}

async function correctBaseline(draft, operation, root, recheckSlotIds = null) {
  if (!object(operation.requirements) || !Object.keys(operation.requirements).length) reject('请提供更正后的需求。');
  const config = await configFor(root);
  const requirements = normalizeRequirements({ ...requirementsOf(draft), ...operation.requirements }, config, config.sources.map(source => source.sourceId));
  for (const goal of requirements.teachingGoals) {
    const prior = requirementsOf(draft).teachingGoals?.find(item => item.id === goal.id);
    if (prior && hashContent(prior) !== hashContent(goal) && goal.version <= prior.version) reject('更改已有教学目标需递增其版本。');
  }
  const pool = await loadPool(root);
  draft.baselineHistory = [...(draft.baselineHistory ?? []), clone(draft.baseline)];
  for (const slot of draft.slots) {
    if (recheckSlotIds && !recheckSlotIds.includes(slot.slotId)) continue;
    slot.goalIds = (slot.goalIds ?? []).filter(id => requirements.teachingGoals.some(goal => goal.id === id));
  }
  if (requirements.scoringMode === 'none') draft.slots.forEach(slot => { slot.points = 0; slot.partPoints = (slot.partPoints ?? []).map(part => ({ ...part, points: 0 })); delete slot.scoringStatus; });
  draft.baseline = { requirements, slots: draft.slots.map(planSlot), confirmedAt: new Date().toISOString(), version: (draft.baseline.version ?? 1) + 1,
    courseContext: clone(config.courseContext), sourceManifest: clone(config.sourceManifest), questionIndexSnapshot: clone(pool.questionIndexSnapshot),
    taskCatalogSnapshot: clone({ catalogId: config.catalogId, chapters: config.chapters, premises: config.premises, tasks: config.tasks }) };
  draft.title = requirements.title;
  draft.retrieval = { ...draft.retrieval, conditions: clone(requirements), sourceUnits: pool.totals.sourceUnits, ready: pool.totals.ready,
    pendingCount: pool.pending.length, pending: clone(pool.pending), failures: clone(pool.failures) };
  const entries = [];
  for (const slot of draft.slots) {
    if (recheckSlotIds && !recheckSlotIds.includes(slot.slotId)) continue;
    if (!slot.question) { entries.push({ slotId: slot.slotId, status: 'unchanged', message: '保留未选题位，未自动补题。' }); continue; }
    const read = await getQuestion(slot.question.questionId, { root, contentVersion: slot.question.contentVersion, teacherVersion: slot.question.teacherVersion });
    const candidate = read.ok ? candidatesFor(draft, { ...slot, question: null }, pool).find(item => item.questionId === slot.question.questionId) : null;
    slot.applicability = read.ok && candidate ? { ...candidate, current: false } : { status: 'read_failed', reasons: [read.ok ? '当前题目不在可核查供给中。' : read.error.message], notes: [] };
    entries.push({ slotId: slot.slotId, status: slot.applicability.status === 'eligible' ? 'updated' : slot.applicability.status === 'read_failed' ? 'read_failed' : 'unknown',
      message: slot.applicability.status === 'eligible' ? '新基线下已证实符合；保留现题和锁定。' : '新基线下适配尚未证实；保留现题和锁定。', reasons: clone(slot.applicability.reasons) });
  }
  return entries;
}

async function changeSlotCriteria(draft, operation, root) {
  const slot = slotById(draft, operation.slotId);
  const config = await configFor(root);
  const task = config.tasks.find(item => item.id === operation.taskId);
  if (!task || task.questionType !== slot.questionType) reject('调整考查任务需保持当前题型。');
  // A task change must fit the existing allocation, including the exact part identities.
  pointsFor({ ...slot, question: null, partPoints: partAllocation(task, slot.points) }, slot.points, slot.partPoints);
  if (operation.teachingGoal !== null && !object(operation.teachingGoal)) reject('教学目标需为对象或明确清除的 null。');
  const goalId = `slot-goal-${slot.slotId}`;
  if (draft.slots.some(other => other.slotId !== slot.slotId && (other.goalIds ?? []).includes(goalId))) {
    reject('本题专属教学目标被其他题位引用，需先解除共享关联。');
  }
  const currentGoals = requirementsOf(draft).teachingGoals ?? [];
  const previousVersions = [draft.baseline, ...(draft.baselineHistory ?? [])]
    .flatMap(basis => basis.requirements.teachingGoals ?? []).filter(goal => goal.id === goalId).map(goal => goal.version);
  const teachingGoals = currentGoals.filter(goal => goal.id !== goalId);
  if (operation.teachingGoal !== null) {
    const input = operation.teachingGoal;
    teachingGoals.push({ observable: input.observable, knowledgeScope: input.knowledgeScope, cognition: input.cognition,
      conditions: input.conditions, priority: input.priority, abilities: input.abilities, literacies: input.literacies,
      id: goalId, version: Math.max(0, ...previousVersions) + 1, source: { kind: 'teacher', text: input.observable } });
  }
  // Validate the per-slot difficulty with the shared requirements contract; the paper-wide target stays unchanged.
  const validated = normalizeRequirements({ ...requirementsOf(draft), teachingGoals, targetDifficulty: operation.targetDifficulty },
    config, config.sources.map(source => source.sourceId));
  slot.taskId = task.id; slot.taskLabel = task.label;
  slot.goalIds = operation.teachingGoal === null ? [] : [goalId];
  slot.targetDifficulty = validated.targetDifficulty;
  const entries = await correctBaseline(draft, { requirements: { teachingGoals: validated.teachingGoals } }, root, [slot.slotId]);
  return entries.map(entry => ({ ...entry,
    message: `已保存本题考查要求，保留现题、分值和锁定；请下一步查看候选并确认换题。${entry.message}` }));
}

export async function applyDraftOperation(input, operation, { root = defaultRoot } = {}) {
  try {
    validateDraft(input);
    if (!object(operation) || typeof operation.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(operation.operationId)) reject('操作需有稳定且有效的身份。');
    const payloadHash = hashContent(operation);
    const prior = (input.operations ?? []).find(item => item.operationId === operation.operationId);
    if (prior) {
      if (prior.payloadHash !== payloadHash) throw new EditError('operation_conflict', '同一操作身份已用于不同内容。');
      return { ok: true, draft: clone(input), result: { ...clone(prior.result), replayed: true } };
    }
    if (input.confirmedPaperId) throw new EditError('finalized_draft', '此草稿已确认成卷；请从成卷派生新草稿后继续调整。');
    checkRevision(input, operation.expectedRevision);
    const draft = clone(input); let entries;
    switch (operation.type) {
      case 'lock': {
        if (typeof operation.locked !== 'boolean') reject('锁定值需为布尔值。');
        const slot = slotById(draft, operation.slotId); slot.locked = operation.locked;
        entries = [{ slotId: slot.slotId, status: 'updated', message: operation.locked ? '已锁定；自动调整将跳过此题。' : '已解除锁定。' }]; break;
      }
      case 'replace': {
        modeOf(operation); const slots = scopedSlots(draft, operation);
        if (operation.candidateId !== undefined && (typeof operation.candidateId !== 'string' || slots.length !== 1)) reject('指定候选只适用于一个题位。');
        if (operation.allowDifference !== undefined && typeof operation.allowDifference !== 'boolean') reject('差异选择确认值无效。');
        const pool = await loadPool(root); entries = [];
        for (const slot of slots) entries.push(await replaceOne(draft, slot, operation, pool));
        break;
      }
      case 'delete': {
        const slot = slotById(draft, operation.slotId);
        draft.slots.splice(draft.slots.indexOf(slot), 1);
        entries = [{ slotId: slot.slotId, status: 'deleted', message: `已删除原第 ${slot.number} 题并重排题号。` }]; break;
      }
      case 'add': {
        if (draft.slots.length >= 60) reject('草稿题位不能超过 60。');
        const config = await configFor(root); const task = config.tasks.find(item => item.id === operation.taskId);
        if (!task) reject('新增题的考查任务无效。');
        const after = operation.afterSlotId === undefined ? null : slotById(draft, operation.afterSlotId);
        const slot = { slotId: `slot-${randomUUID()}`, number: 0, questionType: task.questionType, taskId: task.id, taskLabel: task.label,
          goalIds: suggestedGoalIds(requirementsOf(draft).teachingGoals ?? [], task),
          partPoints: partAllocation(task, Number.isInteger(operation.points) && operation.points >= 0 ? operation.points : 0),
          status: 'empty', question: null, locked: false, selection: { candidates: [], failures: [], selectedReason: null, reasons: [], suggestions: [] } };
        const points = requirementsOf(draft).scoringMode === 'none' ? 0 : operation.points;
        Object.assign(slot, pointsFor(slot, points, requirementsOf(draft).scoringMode === 'none' ? partAllocation(task, 0) : operation.partPoints ?? slot.partPoints));
        draft.slots.splice(after ? draft.slots.indexOf(after) + 1 : draft.slots.length, 0, slot);
        const pool = await loadPool(root); const outcome = await replaceOne(draft, slot, { mode: 'direct' }, pool);
        if (!slot.question) {
          slot.status = outcome.status === 'read_failed' ? 'search_failed' : 'empty';
          slot.selection.reasons = [outcome.message]; slot.selection.failures = outcome.failures ?? []; slot.selection.suggestions = outcome.suggestions ?? [];
        }
        entries = [{ ...outcome, status: 'added', message: slot.question ? '已新增并选入合格未重复题目。' : `已新增空题位。${outcome.message}`, selected: Boolean(slot.question) }]; break;
      }
      case 'points': {
        if (requirementsOf(draft).scoringMode === 'none') reject('本次练习不计分，不能单独修改分值。');
        const slot = slotById(draft, operation.slotId);
        Object.assign(slot, pointsFor(slot, operation.points, operation.partPoints ?? (slot.questionType === 'free_response' ? undefined : [])));
        slot.scoringStatus = scoringStatus(slot);
        entries = [{ slotId: slot.slotId, status: 'updated', message: `题分已改为 ${slot.points} 分，未调整其他题；评分细则需核对。` }]; break;
      }
      case 'difficulty': {
        modeOf(operation); const slots = scopedSlots(draft, operation);
        if (!Number.isFinite(operation.targetDifficulty) || operation.targetDifficulty < 0 || operation.targetDifficulty > 1) reject('目标难度需在 0～1 之间。');
        entries = slots.map(slot => {
          if (operation.mode === 'automatic' && slot.locked) return { slotId: slot.slotId, status: 'skipped_locked', message: '自动难度调整跳过锁定题。' };
          slot.targetDifficulty = operation.targetDifficulty;
          return { slotId: slot.slotId, status: 'unknown', message: '已记录本题目标难度；当前供给没有独立估计，保留现题，未伪造估计或据此换题。' };
        }); break;
      }
      case 'baseline': entries = await correctBaseline(draft, operation, root); break;
      case 'criteria': entries = await changeSlotCriteria(draft, operation, root); break;
      default: reject('不支持的草稿操作。');
    }
    refreshStats(draft);
    draft.revision = revisionOf(input) + 1;
    draft.updatedAt = new Date().toISOString();
    const result = { type: operation.type, entries };
    draft.operations = [...(draft.operations ?? []), { operationId: operation.operationId, payloadHash, operation: clone(operation), result: clone(result),
      revision: draft.revision, appliedAt: draft.updatedAt }];
    return { ok: true, draft, result };
  } catch (error) { return failure(error); }
}
