import { fileURLToPath } from 'node:url';
import { getAssemblyConfig, normalizeRequirements, loadPool, slotCandidates, partAllocation, recheckBlueprint } from './engine.mjs';
import { compatibleGoal } from './teaching-goals.mjs';
import { blueprintProposalSchema, createBlueprintGateway } from '../llm/blueprint-gateway.mjs';

const defaultRoot = fileURLToPath(new URL('../../', import.meta.url));
const types = ['single_choice', 'fill_blank', 'free_response'];
const total = counts => Object.values(counts).reduce((sum, count) => sum + count, 0);
const invalid = message => { throw Object.assign(new Error(message), { code: 'invalid_plan' }); };
const cancelled = () => ({ ok: false, error: { code: 'cancelled', message: '已取消本次 AI 蓝图规划。' } });

// Maximum distinct duplicate groups that can cover slots. This is a supply upper
// bound, not a selection, goal-support assertion or promise that first-fit succeeds.
function distinctCapacity(slots, tasks, assessment) {
  const candidateGroups = slots.map(slot => assessment
    ? slotCandidates(assessment.pool, { ...slot,
      questionType: tasks.find(task => task.taskId === slot.taskId).questionType }, assessment.requirements)
      .filter(candidate => candidate.status === 'eligible').map(candidate => candidate.duplicateGroup)
    : tasks.find(task => task.taskId === slot.taskId).eligibleCandidates.map(candidate => candidate.duplicateGroup));
  const owners = new Map();
  function match(index, visited) {
    for (const group of candidateGroups[index]) {
      if (visited.has(group)) continue;
      visited.add(group);
      if (!owners.has(group) || match(owners.get(group), visited)) { owners.set(group, index); return true; }
    }
    return false;
  }
  let count = 0;
  slots.forEach((_, index) => { if (match(index, new Set())) count++; });
  return count;
}

// Ask the model to reconsider a demonstrably avoidable supply gap; never rewrite
// its proposal in code. Required goals bypass this check because unknown support
// is an honest gap, not a reason to weaken or avoid the teacher's requirement.
function improvingReplacement(slots, tasks, countPolicy, capacity) {
  const counts = Object.fromEntries(types.map(type => [type, slots.filter(slot => tasks.find(task => task.taskId === slot.taskId).questionType === type).length]));
  for (let index = 0; index < slots.length; index++) {
    const original = tasks.find(task => task.taskId === slots[index].taskId);
    const alternatives = tasks.filter(task => task.taskId !== original.taskId && task.eligibleCount > 0
      && (countPolicy === 'suggested' || task.questionType === original.questionType)
      && (task.questionType === original.questionType || counts[task.questionType] < 30))
      .sort((a, b) => {
        const alignment = task => slots[index].goalIds.filter(id => task.compatibleGoalIds.includes(id)).length * 10
          + original.sectionIds.filter(id => task.sectionIds.includes(id)).length;
        return alignment(b) - alignment(a) || b.eligibleCount - a.eligibleCount || a.taskId.localeCompare(b.taskId);
      }).filter(task => distinctCapacity(slots.map((slot, at) => at === index ? { ...slot, taskId: task.taskId } : slot), tasks) > capacity);
    if (alternatives.length) return { number: index + 1, taskId: original.taskId, alternatives: alternatives.slice(0, 8).map(task => task.taskId) };
  }
  return null;
}

export async function planBlueprint(requirements = {}, { root = defaultRoot, gateway = createBlueprintGateway(), signal, countPolicy = 'fixed' } = {}) {
  let llmRun;
  try {
    if (signal?.aborted) return cancelled();
    if (!['fixed', 'suggested'].includes(countPolicy)) invalid('题量策略只能是固定题型题量或 AI 建议题型配比。');
    const loaded = await getAssemblyConfig({ root });
    if (!loaded.ok) return loaded;
    const config = loaded.config;
    const normalized = normalizeRequirements(requirements, config, config.sources.map(item => item.sourceId));
    if (!total(normalized.counts)) invalid('AI 蓝图规划至少需要一个题位。');
    if (normalized.scoringMode !== 'none' && normalized.targetScore < total(normalized.counts)) invalid('目标总分应不小于总题量，每题至少一分。');
    const pool = await loadPool(root);
    if (signal?.aborted) return cancelled();
    const tasks = config.tasks.filter(task => task.sectionIds.length && task.sectionIds.every(id => normalized.mainScope.includes(id))).map(task => {
      const goalIds = normalized.teachingGoals.filter(goal => compatibleGoal(goal, task)).map(goal => goal.id);
      const candidates = slotCandidates(pool, { questionType: task.questionType, taskId: task.id, goalIds }, normalized);
      const eligible = candidates.filter(candidate => candidate.status === 'eligible');
      const foundation = slotCandidates(pool, { questionType: task.questionType, taskId: task.id, goalIds: [] }, normalized)
        .filter(candidate => candidate.status === 'eligible');
      return { taskId: task.id, label: task.label, questionType: task.questionType, sectionIds: task.sectionIds,
        compatibleGoalIds: goalIds, eligibleCount: eligible.length,
        eligibleCandidates: eligible.map(({ questionId, contentVersion, duplicateGroup }) => ({ questionId, contentVersion, duplicateGroup })),
        foundationEligibleCount: foundation.length,
        foundationEligibleCandidates: foundation.map(({ questionId, contentVersion, duplicateGroup }) => ({ questionId, contentVersion, duplicateGroup })),
        unknownCount: candidates.filter(candidate => candidate.status === 'unknown').length,
        relatedCount: candidates.filter(candidate => candidate.status === 'related').length,
        goalSupportStatus: goalIds.length ? 'unknown' : 'not_requested' };
    });
    const questionCount = total(normalized.counts);
    const equalPoints = Math.floor(normalized.targetScore / questionCount);
    const pointRemainder = normalized.targetScore % questionCount;
    const context = { requirements: normalized, countPolicy, totalQuestions: questionCount,
      scoreReference: { note: '可直接使用的整数均分参考，仅供模型规划，不自动修改模型输出；也可自行分配但必须核对合计。',
        slotPoints: Array.from({ length: questionCount }, (_, index) => equalPoints + (index < pointRemainder ? 1 : 0)),
        verifiedTotal: normalized.targetScore },
      chapters: config.chapters, premises: config.premises, tasks,
      supply: { ...pool.totals, pendingCount: pool.pending.length, readFailureCount: pool.failures.length },
      constraints: { noAutomaticRelaxation: true, candidateIdentityKey: 'questionId', duplicateIdentityKey: 'duplicateGroup',
        goalLinksArePlanningOnly: true, actualDifficulty: 'unknown' } };
    const validate = output => {
      const proposal = blueprintProposalSchema.parse(output);
      if (proposal.slots.length !== questionCount) invalid(`实际总题量 ${proposal.slots.length} 题，目标 ${questionCount} 题，相差 ${proposal.slots.length - questionCount} 题；必须保持教师确认数量。`);
      if (normalized.scoringMode === 'none' && proposal.slots.some(slot => slot.points !== 0)) invalid('本次不计分，所有题位分值必须为 0。');
      if (normalized.scoringMode !== 'none' && proposal.slots.some(slot => slot.points < 1)) invalid('计分蓝图的题位分值需为正整数。');
      const plannedScore = proposal.slots.reduce((sum, slot) => sum + slot.points, 0);
      if (plannedScore !== normalized.targetScore) invalid(`实际题位分值合计 ${plannedScore} 分，目标 ${normalized.targetScore} 分，相差 ${plannedScore - normalized.targetScore} 分。请重新分配分值并逐题加总；可直接使用 scoreReference.slotPoints，其合计已核验为 ${normalized.targetScore} 分。不能更改目标总分或题量。`);
      const counts = Object.fromEntries(types.map(type => [type, 0]));
      for (const slot of proposal.slots) {
        const task = tasks.find(item => item.taskId === slot.taskId);
        if (!task) invalid('蓝图包含未知任务或超出主考范围的任务。');
        counts[task.questionType]++;
        if (new Set(slot.goalIds).size !== slot.goalIds.length || slot.goalIds.some(id => !task.compatibleGoalIds.includes(id))) invalid('题位目标包含未知、重复或不兼容的关联。');
      }
      if (types.some(type => counts[type] > 30)) invalid('每种题型最多 30 题。');
      if (countPolicy === 'fixed' && types.some(type => counts[type] !== normalized.counts[type])) invalid(`固定题量策略不能改变各题型数量。实际 ${JSON.stringify(counts)}，目标 ${JSON.stringify(normalized.counts)}。`);
      for (const goal of normalized.teachingGoals.filter(goal => goal.priority === 'required')) {
        if (!proposal.slots.some(slot => slot.goalIds.includes(goal.id))) invalid('必须教学目标需保留至少一个关联题位，不能静默省略。');
      }
      if (!normalized.teachingGoals.some(goal => goal.priority === 'required')) {
        const capacity = distinctCapacity(proposal.slots, tasks);
        if (capacity < proposal.slots.length) {
          const improvement = improvingReplacement(proposal.slots, tasks, countPolicy, capacity);
          if (improvement) invalid(`当前同卷去重后最多可填 ${capacity}/${proposal.slots.length} 题，存在可改善的缺口。第 ${improvement.number} 题原任务 ${improvement.taskId} 可改为以下任务之一提升实际容量：${improvement.alternatives.join('、')}。请结合教学偏好与范围重新规划，不改变其他约束${countPolicy === 'suggested' ? '；本次允许改变各题型配比，无须保留原解答题数量' : '；各题型题量保持不变'}。`);
        }
      }
      return proposal;
    };
    const proposed = await gateway.propose(context, { signal, validate });
    llmRun = proposed.run;
    if (!proposed.ok) return { ok: false, error: proposed.error, ...(llmRun ? { llmRun } : {}) };
    if (signal?.aborted) return { ...cancelled(), ...(llmRun ? { llmRun } : {}) };
    // Validate locally even for injected gateways that do not invoke callbacks.
    const proposal = validate(proposed.proposal);
    const counts = Object.fromEntries(types.map(type => [type, 0]));
    const slots = proposal.slots.map((slot, index) => {
      const task = config.tasks.find(item => item.id === slot.taskId);
      counts[task.questionType]++;
      return { slotId: `slot-${index + 1}`, number: index + 1, questionType: task.questionType, taskId: task.id,
        taskLabel: task.label, points: slot.points, partPoints: partAllocation(task, slot.points), goalIds: slot.goalIds,
        planningReason: slot.rationale };
    });
    const checked = await recheckBlueprint({ schemaVersion: 1, requirements: { ...normalized, counts }, slots }, { root });
    if (!checked.ok) return { ...checked, ...(llmRun ? { llmRun } : {}) };
    if (signal?.aborted) return { ...cancelled(), ...(llmRun ? { llmRun } : {}) };
    const proposalChanges = types.filter(type => counts[type] !== normalized.counts[type])
      .map(questionType => ({ field: 'counts', questionType, before: normalized.counts[questionType], after: counts[questionType] }));
    checked.blueprint.slots.forEach((slot, index) => { slot.planningReason = slots[index].planningReason; });
    checked.blueprint.supply.distinctCandidateCapacity = distinctCapacity(slots, tasks, { pool, requirements: normalized });
    checked.blueprint.supply.capacityNote = '按合格候选重复组计算的最大可填题位数，仅为供给上界；实际选题会再次去重核查，教学目标支持和难度仍需证据。';
    checked.blueprint.generation = { mode: 'llm', label: 'AI 根据教学需求与真实供给规划（待教师确认）',
      countPolicy, originalCounts: structuredClone(normalized.counts), summary: proposal.summary, proposalChanges,
      llmRun: llmRun ?? null, edited: false };
    return checked;
  } catch (error) {
    if (signal?.aborted) return { ...cancelled(), ...(llmRun ? { llmRun } : {}) };
    return { ok: false, error: { code: error.code === 'invalid_plan' || error.name === 'ZodError' ? 'invalid_plan' : 'planner_error',
      message: error.code === 'invalid_plan' ? error.message : error.name === 'ZodError' ? 'AI 蓝图未通过严格结构校验。' : 'AI 蓝图规划失败，未生成蓝图，请重试。' }, ...(llmRun ? { llmRun } : {}) };
  }
}
