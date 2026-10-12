import { allocateParts, typeLabels } from './api.js';
import { groupSlotsByType, questionTypeOrder } from '../src/assembly/slot-order.mjs';

const questionTypes = questionTypeOrder;

function withSlots(blueprint, slots) {
  const ordered = groupSlotsByType(slots);
  const counts = Object.fromEntries(questionTypes.map(type => [type, ordered.filter(slot => slot.questionType === type).length]));
  return { ...blueprint, slots: ordered,
    requirements: { ...blueprint.requirements, counts },
    generation: { ...blueprint.generation, countPolicy: 'fixed' } };
}

export function addBlueprintSlot(blueprint, task, slotId) {
  if (!task || !questionTypes.includes(task.questionType)) throw new Error('当前题型没有可用考查任务。');
  if (blueprint.slots.length >= 60) throw new Error('一份试卷最多安排 60 个题位。');
  const matching = blueprint.slots.filter(slot => slot.questionType === task.questionType);
  if (matching.length >= 30) throw new Error(`${typeLabels[task.questionType]}最多安排 30 个题位。`);
  if (blueprint.slots.some(slot => slot.slotId === slotId)) throw new Error('新增题位身份重复，请重试。');
  const points = blueprint.requirements.scoringMode === 'none' ? 0 : matching[0]?.points ?? ({ single_choice: 8, fill_blank: 10, free_response: 16 })[task.questionType];
  return withSlots(blueprint, [...blueprint.slots, { slotId, number: 0, questionType: task.questionType,
    taskId: task.id, taskLabel: task.label, points, partPoints: allocateParts(task, points), goalIds: [] }]);
}

export function removeBlueprintSlot(blueprint, slotId) {
  const slot = blueprint.slots.find(item => item.slotId === slotId);
  if (!slot) throw new Error('此题位已不存在。');
  const orphan = (blueprint.requirements.teachingGoals || []).find(goal => (slot.goalIds || []).includes(goal.id) && !canRemoveGoalLink(blueprint.slots, slot, goal));
  if (orphan) throw new Error(`第 ${slot.number} 题是必须目标「${orphan.observable}」的唯一关联题位。请先在其他合适题位的详情中关联此目标，再删除本题位。`);
  return withSlots(blueprint, blueprint.slots.filter(item => item.slotId !== slotId));
}

export function changeBlueprintTask(blueprint, slotId, task, { preservePartPoints = false } = {}) {
  const slot = blueprint.slots.find(item => item.slotId === slotId);
  if (!slot) throw new Error('此题位已不存在。');
  if (!task || task.questionType !== slot.questionType) throw new Error('考查任务与题位题型不一致，请先添加对应题型的题位。');
  const goals = blueprint.requirements.teachingGoals || [];
  const goalIds = retainedGoalIds(slot, task, goals);
  const orphan = goals.find(goal => (slot.goalIds || []).includes(goal.id) && !goalIds.includes(goal.id) && !canRemoveGoalLink(blueprint.slots, slot, goal));
  if (orphan) throw new Error(`第 ${slot.number} 题承担必须目标「${orphan.observable}」。请先将目标关联到另一个合适题位，再更换此题任务。`);
  const points = blueprint.requirements.scoringMode === 'none' ? 0 : slot.points;
  const partIds = task.partIds || [];
  const sameParts = slot.partPoints.length === partIds.length && slot.partPoints.every(part => partIds.includes(part.partId));
  const partPoints = preservePartPoints && sameParts && blueprint.requirements.scoringMode !== 'none' ? slot.partPoints : allocateParts(task, points);
  return { ...blueprint, slots: blueprint.slots.map(item => item.slotId === slotId ? { ...item,
    taskId: task.id, taskLabel: task.label, points, partPoints, goalIds, planningReason: undefined } : item) };
}

export function goalTaskCompatible(goal, task) {
  return Boolean(task) && goal.knowledgeScope?.some(id => task.sectionIds.includes(id))
    && (goal.conditions?.response !== 'written_reasoning' || task.questionType === 'free_response');
}

export function retainedGoalIds(slot, task, goals) {
  return goals.filter(goal => (slot.goalIds || []).includes(goal.id) && goalTaskCompatible(goal, task)).map(goal => goal.id);
}

export function canRemoveGoalLink(slots, slot, goal) {
  return goal.priority !== 'required' || slots.some(other => other.slotId !== slot.slotId && (other.goalIds || []).includes(goal.id));
}

export function goalAssignmentSummary(slots, goals) {
  const linked = slots.filter(slot => (slot.goalIds || []).some(id => goals.some(goal => goal.id === id)));
  return { linkedCount: linked.length, practiceCount: slots.length - linked.length };
}
