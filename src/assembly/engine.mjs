import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { listQuestions, getQuestion } from '../question-bank/reader.mjs';
import { normalizeTeachingGoals, compatibleGoal, suggestedGoalIds, goalReview, goalDifferences, unknownGoalSupport } from './teaching-goals.mjs';
import { selectWithLlm, combineRankings } from './selector.mjs';
import { questionBankStorage } from '../storage/registry.mjs';
import { groupSlotsByType } from './slot-order.mjs';

const defaultRoot = fileURLToPath(new URL('../../', import.meta.url));
const types = ['single_choice', 'fill_blank', 'free_response'];
const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
class AssemblyError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const reject = message => { throw new AssemblyError('invalid_plan', message); };
const failure = error => ({ ok: false, error: {
  code: error instanceof AssemblyError || ['invalid_plan', 'cancelled'].includes(error.code) ? error.code : 'read_error', message: error.message,
} });

async function readData(root, name) {
  return JSON.parse(await readFile(path.join(root, 'data', 'assembly', name), 'utf8'));
}

async function loadConfig(root) {
  const repository = questionBankStorage(root);
  const fileConfig = repository ? repository.getQuestionBankConfig('task_catalog') : await readData(root, 'task-catalog.json');
  if (!fileConfig) throw new AssemblyError('config_error', 'SQLite 组卷配置缺失。');
  const config = repository ? { ...fileConfig, chapters: repository.getQuestionBankChapters() } : fileConfig;
  if (config.schemaVersion !== 1 || !Array.isArray(config.chapters) || !Array.isArray(config.premises)
      || !Array.isArray(config.tasks) || !object(config.defaultTasks) || !object(config.defaultRequirements)) {
    throw new AssemblyError('config_error', '组卷预设数据不完整。');
  }
  for (const [name, values] of [['chapters', config.chapters], ['premises', config.premises], ['tasks', config.tasks]]) {
    if (values.some(item => !object(item) || typeof item.id !== 'string' || !item.id || typeof item.label !== 'string')
        || new Set(values.map(item => item.id)).size !== values.length) {
      throw new AssemblyError('config_error', `${name} 存在无效或重复身份。`);
    }
  }
  if (config.tasks.some(task => !types.includes(task.questionType))) throw new AssemblyError('config_error', '预设题型无效。');
  for (const type of types) {
    if (!Array.isArray(config.defaultTasks[type]) || !config.defaultTasks[type].length
        || config.defaultTasks[type].some(id => !config.tasks.some(task => task.id === id && task.questionType === type))) {
      throw new AssemblyError('config_error', `${type} 缺少有效题位预设。`);
    }
  }
  return config;
}

export async function getAssemblyConfig({ root = defaultRoot } = {}) {
  try {
    const config = await loadConfig(root);
    const repository = questionBankStorage(root);
    const [sourceManifest, courseContext] = repository
      ? [repository.getQuestionBankConfig('source_manifest'), repository.getQuestionBankConfig('course_context')]
      : await Promise.all(['sources.json', 'course-context.json'].map(async name =>
        JSON.parse(await readFile(path.join(root, 'data', 'question-bank', name), 'utf8'))));
    if (!sourceManifest || !courseContext) throw new AssemblyError('config_error', 'SQLite 材料与课程上下文缺失。');
    if (sourceManifest.schemaVersion !== 1 || !Array.isArray(sourceManifest.sources)
        || sourceManifest.sources.some(source => !object(source) || typeof source.sourceId !== 'string' || !source.sourceId
          || typeof source.path !== 'string' || path.isAbsolute(source.path) || source.path.includes('\\')
          || source.path.includes(':') || source.path.split('/').some(part => !part || part === '..' || part === '.')
          || !/^[a-f0-9]{64}$/.test(source.sha256) || !Number.isInteger(source.physicalPages) || source.physicalPages < 1)
        || new Set(sourceManifest.sources.map(source => source.sourceId)).size !== sourceManifest.sources.length) {
      throw new AssemblyError('config_error', '材料身份、相对路径或版本依据无效。');
    }
    if (courseContext.schemaVersion !== 1 || typeof courseContext.contextId !== 'string' || !courseContext.contextId
        || ['foundation', 'dependencies', 'explicitPremises', 'basis'].some(field => !Array.isArray(courseContext[field]))) {
      throw new AssemblyError('config_error', '允许知识及依据上下文无效。');
    }
    return { ok: true, config: { ...config, courseContext, sourceManifest,
      sources: sourceManifest.sources.map(({ sourceId, role, path: sourcePath }) => ({ sourceId, role, path: sourcePath })) } };
  } catch (error) { return failure(error); }
}

function boundedText(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) reject(`${label}需为 1～${max} 字符的文本。`);
  return value.trim();
}

function number(value, label, min, max, integer = false) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    reject(`${label}需为 ${min}～${max} 的${integer ? '整数' : '数字'}。`);
  }
  return value;
}

function knownIds(value, allowed, label) {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !allowed.includes(id))
      || new Set(value).size !== value.length) reject(`${label}包含未知或重复项目。`);
  return [...value];
}

export function normalizeRequirements(input, config, sourceIds) {
  if (!object(input)) reject('需求需为结构化对象。');
  const values = { ...config.defaultRequirements, ...input };
  if (!object(values.counts)) reject('题量设置无效。');
  const counts = Object.fromEntries(types.map(type => [type, number(values.counts[type], `${type} 题量`, 0, 30, true)]));
  if (Object.values(counts).reduce((sum, value) => sum + value, 0) > 60) reject('总题量不能超过 60。');
  if (values.teacherRequest !== undefined && (typeof values.teacherRequest !== 'string' || values.teacherRequest.length > 2000)) {
    reject('教师原话需为不超过 2000 字符的文本。');
  }
  if (values.automaticFoundation !== undefined && typeof values.automaticFoundation !== 'boolean') reject('基础依赖策略无效。');
  if (values.purpose !== undefined && !['consolidation', 'diagnostic', 'assessment', 'mock_exam'].includes(values.purpose)) reject('组卷用途无效。');
  if (values.scoringMode !== undefined && !['none', 'points'].includes(values.scoringMode)) reject('计分方式无效。');
  return {
    ...(values.scoringMode !== undefined ? { scoringMode: values.scoringMode } : {}),
    ...(values.automaticFoundation !== undefined ? { automaticFoundation: values.automaticFoundation,
      foundationPremises: values.automaticFoundation ? ['quadratic_basics', 'absolute_root', 'basic_geometry'].filter(id => config.premises.some(item => item.id === id)) : [] } : {}),
    ...(values.purpose !== undefined ? { purpose: values.purpose } : {}),
    title: boundedText(values.title, '标题', 120), grade: boundedText(values.grade, '年级', 60),
    goal: boundedText(values.goal, '教学目的', 1000),
    ...(values.teacherRequest !== undefined ? { teacherRequest: values.teacherRequest } : {}),
    durationMinutes: number(values.durationMinutes, '时长', 1, 300, true),
    targetScore: values.scoringMode === 'none' ? 0 : number(values.targetScore, '目标总分', 1, 1000, true),
    targetDifficulty: values.targetDifficulty === null ? null : number(values.targetDifficulty, '目标难度', 0, 1),
    teachingGoals: normalizeTeachingGoals(values.teachingGoals, config.chapters.map(item => item.id)),
    mainScope: knownIds(values.mainScope, config.chapters.map(item => item.id), '主考范围'),
    learnedScope: knownIds(values.learnedScope, config.chapters.map(item => item.id), '已学边界'),
    premises: knownIds(values.premises, config.premises.map(item => item.id), '显式前提'),
    sourceIds: knownIds(values.sourceIds, sourceIds, '来源范围'), counts,
  };
}

function distribute(total, weights) {
  if (!weights.length) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map(weight => total * weight / sum);
  const result = exact.map(Math.floor);
  const remainder = total - result.reduce((a, b) => a + b, 0);
  const order = exact.map((value, index) => ({ index, fraction: value - result[index] }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let i = 0; i < remainder; i++) result[order[i].index]++;
  return result;
}

export function partAllocation(task, points) {
  if (task.questionType !== 'free_response') return [];
  const partIds = task.partIds ?? ['p1', 'p2'];
  const weights = task.partWeights ?? partIds.map(() => 1);
  if (!Array.isArray(partIds) || !partIds.length || new Set(partIds).size !== partIds.length
      || partIds.some(id => typeof id !== 'string' || !id) || !Array.isArray(weights)
      || weights.length !== partIds.length || weights.some(weight => !Number.isFinite(weight) || weight <= 0)) {
    throw new AssemblyError('config_error', '解答题小问预设无效。');
  }
  return distribute(points, weights).map((value, i) => ({ partId: partIds[i], points: value }));
}

export async function loadPool(root) {
  const listed = await listQuestions({ root });
  if (!listed.ok) throw new AssemblyError(listed.error.code, listed.error.message);
  const repository = questionBankStorage(root);
  const index = repository ? repository.getQuestionBankIndex() : await readData(root, 'question-index.json');
  if (repository && !index) throw new AssemblyError('integrity_error', 'SQLite 选题依据清单缺失。');
  if (index.schemaVersion !== 1 || !Array.isArray(index.entries)) throw new AssemblyError('config_error', '选题依据清单无效。');
  const annotations = new Map();
  for (const item of index.entries) {
    if (!object(item) || typeof item.questionId !== 'string' || annotations.has(item.questionId)) {
      throw new AssemblyError('config_error', '选题依据包含无效或重复身份。');
    }
    annotations.set(item.questionId, item);
  }
  const ready = listed.entries.filter(item => item.status === 'ready');
  const records = await Promise.all(ready.map(async entry => ({ entry, annotation: annotations.get(entry.questionId), result: await getQuestion(entry.questionId, { root, contentVersion: entry.contentVersion }) })));
  return { totals: listed.totals, records, questionIndexSnapshot: index,
    pending: listed.entries.filter(item => item.status !== 'ready').map(({ questionId, pendingReasons }) => ({ questionId, reasons: pendingReasons })),
    failures: records.filter(item => !item.result.ok).map(({ entry, result }) => ({ questionId: entry.questionId, ...result.error })),
  };
}

function assess(item, slot, requirements, usedIds = new Set(), usedGroups = new Set()) {
  const { entry, result, annotation } = item;
  const base = { questionId: entry.questionId, contentVersion: entry.contentVersion,
    notes: Array.isArray(annotation?.notes) ? clone(annotation.notes) : [] };
  if (!result.ok) return { ...base, status: 'read_failed', reasons: [result.error.message], errorCode: result.error.code };
  const question = result.question;
  const goalSupport = unknownGoalSupport(requirements, slot);
  const reasons = [];
  if (!question.sourceRefs.some(ref => requirements.sourceIds.includes(ref.sourceId))) reasons.push('不在本次来源范围');
  if (!annotation || annotation.contentVersion !== question.contentVersion || annotation.teacherVersion !== question.teacherVersion
      || !Array.isArray(annotation.tasks) || !Array.isArray(annotation.primarySections)
      || !annotation.primarySections.length || !Array.isArray(annotation.solutionPaths)
      || !annotation.solutionPaths.length || typeof annotation.duplicateGroup !== 'string' || !annotation.duplicateGroup) {
    return { ...base, status: 'unknown', reasons: [...reasons, '缺少与题面版本绑定的完整适配依据'] };
  }
  if (!annotation.tasks.includes(slot.taskId)) reasons.push('具体考查任务不同');
  if (!annotation.primarySections.every(section => requirements.mainScope.includes(section))) reasons.push('主要考查内容不在主考范围');
  const completePaths = annotation.solutionPaths.filter(solution => object(solution) && typeof solution.id === 'string'
    && Array.isArray(solution.requiredSections) && Array.isArray(solution.requiredPremises)
    && typeof solution.basis === 'string' && solution.basis.trim());
  const allowedPaths = completePaths.filter(solution => solution.requiredSections.every(section => requirements.learnedScope.includes(section))
    && solution.requiredPremises.every(premise => (requirements.premises.includes(premise) || requirements.foundationPremises?.includes(premise))));
  if (!allowedPaths.length) return { ...base, status: 'unknown', reasons: [...reasons, '尚无覆盖全部必要小问且符合本次已学边界的已证实解法'],
    solutionPaths: completePaths.map(({ id, requiredSections, requiredPremises }) => ({ id, requiredSections, requiredPremises })) };
  if (usedIds.has(question.questionId) || usedGroups.has(annotation.duplicateGroup)) reasons.push('本卷已使用同题或重复组');
  if (goalSupport.some(goal => goal.priority === 'required')) return { ...base, status: 'unknown',
    reasons: [...reasons, '必须教学目标尚无已复核的题目支持证据'], goalSupport,
    duplicateGroup: annotation.duplicateGroup, allowedSolutionPath: allowedPaths[0] };
  return { ...base, status: reasons.length ? 'related' : 'eligible', reasons, goalSupport,
    duplicateGroup: annotation.duplicateGroup, allowedSolutionPath: allowedPaths[0],
  };
}

export function slotCandidates(pool, slot, requirements, usedIds, usedGroups) {
  return pool.records.filter(item => item.entry.questionType === slot.questionType)
    .map(item => assess(item, slot, requirements, usedIds, usedGroups))
    .sort((a, b) => a.questionId.localeCompare(b.questionId));
}

function supplyFor(pool, slots, requirements) {
  return { ...pool.totals, pendingCount: pool.pending.length, pending: clone(pool.pending), failures: clone(pool.failures), slotSupply: slots.map(slot => {
    const candidates = slotCandidates(pool, slot, requirements);
    return { slotId: slot.slotId, eligibleCount: candidates.filter(item => item.status === 'eligible').length,
      relatedCount: candidates.filter(item => item.status === 'related').length,
      unknownCount: candidates.filter(item => item.status === 'unknown').length,
      readFailures: candidates.filter(item => item.status === 'read_failed') };
  }) };
}

export async function previewBlueprint(requirements = {}, { root = defaultRoot } = {}) {
  try {
    const loaded = await getAssemblyConfig({ root });
    if (!loaded.ok) return loaded;
    const config = loaded.config;
    const normalized = normalizeRequirements(requirements, config, config.sources.map(item => item.sourceId));
    const slots = [];
    for (const type of types) {
      const goals = normalized.teachingGoals;
      const targeted = config.tasks.filter(task => task.questionType === type
        && task.sectionIds.some(id => normalized.mainScope.includes(id))
        && goals.some(goal => compatibleGoal(goal, task)));
      const taskIds = targeted.length ? targeted.map(task => task.id) : config.defaultTasks[type];
      for (let i = 0; i < normalized.counts[type]; i++) {
        const taskId = taskIds[i % taskIds.length];
        const task = config.tasks.find(item => item.id === taskId);
        const number = slots.length + 1;
        slots.push({ slotId: `slot-${number}`, number, questionType: type, taskId, taskLabel: task.label,
          goalIds: suggestedGoalIds(goals, task),
          points: type === 'single_choice' ? 8 : type === 'fill_blank' ? 10 : (i % 2 ? 18 : 14), partPoints: [] });
      }
    }
    const points = distribute(normalized.targetScore, slots.map(slot => slot.points));
    slots.forEach((slot, index) => { slot.points = points[index]; slot.partPoints = partAllocation(config.tasks.find(task => task.id === slot.taskId), slot.points); });
    const pool = await loadPool(root);
    return { ok: true, blueprint: { schemaVersion: 1, requirements: normalized, slots,
      plannedStats: { questionCount: slots.length, points: points.reduce((a, b) => a + b, 0) },
      generation: { mode: normalized.teachingGoals.length ? 'goal_guided_preset' : 'visible_preset',
        label: normalized.teachingGoals.length ? '按目标章节与作答形式建议题位（需核查，不代表题目支持）' : '集合专项预设（可编辑）' },
      goalReview: goalReview(normalized, slots, config.tasks), supply: supplyFor(pool, slots, normalized) } };
  } catch (error) { return failure(error); }
}

function validateBlueprint(blueprint, config) {
  if (!object(blueprint) || blueprint.schemaVersion !== 1 || !Array.isArray(blueprint.slots)) reject('蓝图结构无效。');
  const requirements = normalizeRequirements(blueprint.requirements, config, config.sources.map(item => item.sourceId));
  const ids = new Set();
  const counts = Object.fromEntries(types.map(type => [type, 0]));
  const slots = blueprint.slots.map((slot, index) => {
    if (!object(slot) || typeof slot.slotId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(slot.slotId) || ids.has(slot.slotId)) reject('题位身份无效或重复。');
    ids.add(slot.slotId);
    if (slot.number !== index + 1 || !types.includes(slot.questionType)) reject('题号或题型无效。');
    const task = config.tasks.find(item => item.id === slot.taskId && item.questionType === slot.questionType);
    if (!task) reject('题位考查任务与题型不匹配。');
    const goalIds = knownIds(slot.goalIds ?? [], requirements.teachingGoals.map(goal => goal.id), '题位教学目标');
    const points = requirements.scoringMode === 'none' ? 0 : number(slot.points, '题位分值', 0, 1000, true);
    if (!Array.isArray(slot.partPoints)) reject('小问分值需为数组。');
    const partPoints = slot.partPoints.map(item => ({ partId: item?.partId, points: requirements.scoringMode === 'none' ? 0 : number(item?.points, '小问分值', 0, 1000, true) }));
    if (slot.questionType === 'free_response') {
      const expected = (task.partIds ?? ['p1', 'p2']);
      if (partPoints.length !== expected.length || new Set(partPoints.map(item => item.partId)).size !== expected.length
          || partPoints.some(item => !expected.includes(item.partId)) || partPoints.reduce((sum, item) => sum + item.points, 0) !== points) {
        reject('解答题小问身份或小问分值合计与题位不一致。');
      }
    } else if (partPoints.length) reject('非解答题不能设置小问分值。');
    counts[slot.questionType]++;
    return { slotId: slot.slotId, number: slot.number, questionType: slot.questionType, taskId: task.id, taskLabel: task.label, points, partPoints, goalIds,
      ...(slot.targetDifficulty !== undefined ? { targetDifficulty: slot.targetDifficulty === null ? null : number(slot.targetDifficulty, '题位目标难度', 0, 1) } : {}),
      ...(slot.planningReason !== undefined ? { planningReason: boundedText(slot.planningReason, '原规划理由', 1000) } : {}) };
  });
  if (types.some(type => counts[type] !== requirements.counts[type])) reject('实际题位数量与需求题量不一致。');
  if (blueprint.generation?.mode === 'llm') {
    const requiredGoals = requirements.teachingGoals.filter(goal => goal.priority === 'required');
    for (const slot of slots) {
      const task = config.tasks.find(task => task.id === slot.taskId);
      if (slot.goalIds.some(id => !compatibleGoal(requirements.teachingGoals.find(goal => goal.id === id), task))) {
        reject('AI 蓝图的教学目标与所关联题位不兼容。');
      }
    }
    if (requiredGoals.some(goal => !slots.some(slot => slot.goalIds.includes(goal.id)))) {
      reject('AI 蓝图的必须教学目标需保留关联题位，不能通过编辑静默省略。');
    }
  }
  return { requirements, slots: groupSlotsByType(slots) };
}

export async function recheckBlueprint(blueprint, { root = defaultRoot } = {}) {
  try {
    const loaded = await getAssemblyConfig({ root });
    if (!loaded.ok) return loaded;
    const { requirements, slots } = validateBlueprint(blueprint, loaded.config);
    const pool = await loadPool(root);
    return { ok: true, blueprint: { schemaVersion: 1, requirements, slots,
      plannedStats: { questionCount: slots.length, points: slots.reduce((sum, slot) => sum + slot.points, 0) },
      generation: blueprint.generation?.mode === 'llm' ? { ...clone(blueprint.generation), edited: true,
        label: 'AI 蓝图（已按当前题位重新核查供给，理由为原规划说明）' }
        : { mode: 'visible_preset', label: '集合专项预设（已按编辑后的题位重新核查供给）' },
      goalReview: goalReview(requirements, slots, loaded.config.tasks),
      supply: supplyFor(pool, slots, requirements) } };
  } catch (error) { return failure(error); }
}

export async function createDraft(blueprint, { root = defaultRoot, selectionMode = 'rule', gateway, signal, onProgress } = {}) {
  try {
    const loaded = await getAssemblyConfig({ root });
    if (!loaded.ok) return loaded;
    const { requirements, slots } = validateBlueprint(blueprint, loaded.config);
    onProgress?.({ stage: 'retrieving', totalQuestions: slots.length });
    const pool = await loadPool(root);
    if (!['rule', 'llm'].includes(selectionMode)) reject('选题方式无效。');
    let rankedSelection = null;
    const initialCandidates = new Map(slots.map(slot => [slot.slotId, slotCandidates(pool, slot, requirements)]));
    let ruleCombination = null;
    if (selectionMode === 'llm') {
      rankedSelection = await selectWithLlm({ slots, requirements, pool, candidatesBySlot: initialCandidates, gateway, signal, onProgress });
      if (!rankedSelection.ok) return rankedSelection;
    } else {
      onProgress?.({ stage: 'combining', totalQuestions: slots.length });
      const eligible = new Map([...initialCandidates.values()].flat().filter(candidate => candidate.status === 'eligible').map(candidate => [candidate.questionId, candidate]));
      ruleCombination = combineRankings(slots, slots.map(slot => ({ slotId: slot.slotId,
        candidates: initialCandidates.get(slot.slotId).filter(candidate => candidate.status === 'eligible') })), eligible);
    }
    const usedIds = new Set(); const usedGroups = new Set();
    const selectedSlots = slots.map(slot => {
      const candidates = selectionMode === 'llm' ? initialCandidates.get(slot.slotId) : slotCandidates(pool, slot, requirements, usedIds, usedGroups);
      const match = rankedSelection?.assignments.get(slot.slotId);
      const identity = match?.questionId ?? ruleCombination?.assignments.get(slot.slotId)?.questionId;
      const selected = candidates.find(candidate => candidate.questionId === identity);
      const failures = candidates.filter(candidate => candidate.status === 'read_failed');
      if (!selected) return { ...slot, status: failures.length ? 'search_failed' : 'empty', question: null,
        selection: { candidates, selectedReason: null, failures,
          reasons: [failures.length ? '存在读取失败，不能将本次结果判断为题库无题。' : selectionMode === 'llm' && candidates.some(candidate => candidate.status === 'eligible')
            ? '合格短名单与其他题位存在重复组竞争，全局去重后本题位留空。' : '没有已证实符合本题位全部条件且未重复使用的候选。'],
          suggestions: candidates.filter(candidate => candidate.status === 'related' || candidate.status === 'unknown') } };
      usedIds.add(selected.questionId); usedGroups.add(selected.duplicateGroup);
      const question = clone(pool.records.find(item => item.entry.questionId === selected.questionId).result.question);
      const modelEvidence = match ? rankedSelection.selectionGeneration.candidateEvidenceSnapshot.find(item => item.questionId === match.questionId).evidence : null;
      return { ...slot, status: 'selected', question, selection: { candidates, failures,
        selectedReason: { method: match ? 'llm_candidate_ranking_global_assignment' : 'deterministic_eligible_identity_order',
          text: match?.rationale ?? '来源、题型、具体任务及完整允许解法均符合；按稳定身份偏好进行全局去重组合，先尽可能填满题位，再选择靠前的合格候选。',
          ...(match ? { rank: match.rank, evidenceRefs: clone(match.evidenceRefs),
            evidence: match.evidenceRefs.map(ref => ({ ref, text: modelEvidence[ref] })),
            supportStatus: 'AI 匹配建议，不等于已复核教学目标支持。' } : {}),
          allowedSolutionPath: selected.allowedSolutionPath, goalSupport: clone(selected.goalSupport), notes: clone(selected.notes) }, reasons: [], suggestions: [] } };
    });
    const selected = selectedSlots.filter(slot => slot.status === 'selected');
    const plannedPoints = slots.reduce((sum, slot) => sum + slot.points, 0);
    const availablePoints = selected.reduce((sum, slot) => sum + slot.points, 0);
    const differences = [];
    differences.push(...goalDifferences(requirements, selectedSlots, loaded.config.tasks));
    if (plannedPoints !== requirements.targetScore) differences.push({ code: 'planned_score_differs', message: `题位合计 ${plannedPoints} 分，与需求 ${requirements.targetScore} 分不同。`, expected: requirements.targetScore, actual: plannedPoints });
    for (const slot of selectedSlots.filter(item => item.status !== 'selected')) differences.push({ code: slot.status === 'search_failed' ? 'retrieval_failed' : 'missing_question', slotId: slot.slotId, message: `第 ${slot.number} 题未选入题目，保留题位。` });
    differences.push({ code: 'difficulty_unknown', message: '题目分档可参考 LLM 内容估计；未经学生作答标定，整卷精确难度系数保持未知。' });
    const now = new Date().toISOString();
    const draft = { schemaVersion: 1, draftId: randomUUID(), createdAt: now, title: requirements.title,
      baseline: { requirements: clone(requirements), slots: clone(slots), confirmedAt: now, version: 1,
        ...(blueprint.generation ? { generation: clone(blueprint.generation) } : {}),
        courseContext: clone(loaded.config.courseContext), sourceManifest: clone(loaded.config.sourceManifest),
        taskCatalogSnapshot: clone({ catalogId: loaded.config.catalogId, chapters: loaded.config.chapters,
          premises: loaded.config.premises, tasks: loaded.config.tasks }),
        questionIndexSnapshot: clone(pool.questionIndexSnapshot) },
      slots: selectedSlots, stats: { plannedQuestions: slots.length, selectedQuestions: selected.length, plannedPoints, availablePoints,
        missingQuestions: slots.length - selected.length, difficultyEstimate: null }, differences,
      ...(rankedSelection ? { selectionGeneration: clone(rankedSelection.selectionGeneration) } : {}),
      retrieval: { ...pool.totals, pendingCount: pool.pending.length, pending: clone(pool.pending), failures: clone(pool.failures), mode: 'real_local_bank',
        conditions: clone(requirements), candidateOrder: selectionMode === 'llm' ? 'AI rank; maximum-cardinality global duplicate-group assignment' : 'questionId ascending; maximum-cardinality global duplicate-group assignment',
        ...(ruleCombination ? { combination: clone(ruleCombination.summary) } : {}), noAutomaticRelaxation: true } };
    // Goal coverage is an explicit teacher action, separate from assembling a draft.
    if (signal?.aborted) return { ok: false, error: { code: 'cancelled', message: '已取消组卷，未保存草稿。' } };
    return { ok: true, draft };
  } catch (error) { return failure(error); }
}
