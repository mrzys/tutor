import { availableTasks, blueprintPartPoints, changeBlueprintTask, clearBlueprintReview, missingRequiredGoals } from "./blueprint-goals.ts";

export const blueprintTypes = ["single_choice", "multiple_choice", "fill_blank", "free_response"] as const;
export function blueprintQuantityReview(blueprint: any) {
  const expectedCounts = Object.fromEntries(blueprintTypes.map(type => [type, blueprint.requirements?.counts?.[type] || 0]));
  const actualCounts = Object.fromEntries(blueprintTypes.map(type => [type, (blueprint.slots || []).filter((slot: any) => slot.questionType === type).length]));
  const expectedTotal = Object.values(expectedCounts).reduce((sum: number, count: any) => sum + count, 0);
  const actualTotal = (blueprint.slots || []).length;
  return { expectedCounts, actualCounts, expectedTotal, actualTotal,
    matches: expectedTotal === actualTotal && blueprintTypes.every(type => expectedCounts[type] === actualCounts[type]) };
}
export function editableBlueprintTypes(blueprint: any) {
  return blueprintTypes.filter(type => blueprint.requirements?.counts?.[type] > 0 || blueprint.slots?.some((slot: any) => slot.questionType === type));
}
export function blueprintCatalogGaps(blueprint: any, tasks: any[]) {
  return blueprintTypes.filter(type => (blueprint.requirements?.counts?.[type] || 0) > 0
    && !availableTasks(blueprint, { questionType: type }, tasks).length);
}
function checkTask(blueprint: any, task: any) {
  if (!task || !editableBlueprintTypes(blueprint).includes(task.questionType)
    || !availableTasks(blueprint, { questionType: task.questionType }, [task]).length)
    throw new Error("请选择本次题型与范围内的真实考查任务。");
}
function checkPoints(points: number) {
  if (!Number.isInteger(points) || points < 0 || points > 1000) throw new Error("题位分值需为 0～1000 的整数。");
}
export function updateBlueprintPoints(blueprint: any, slotId: string, points: number, tasks: any[]) {
  const next = structuredClone(blueprint), target = next.slots.find((slot: any) => slot.slotId === slotId);
  if (!target) throw new Error("题位不存在，请重新选择。");
  const task = tasks.find(task => task.id === target.taskId);
  if (target.points === points) return blueprint;
  target.points = points;
  target.partPoints = task && Number.isInteger(points) && points >= 0 && points <= 1000 ? blueprintPartPoints(task, points) : [];
  delete target.planningReason;
  return clearBlueprintReview(next);
}
export function updateBlueprintSlot(blueprint: any, slotId: string, task: any, points: number) {
  checkTask(blueprint, task); checkPoints(points);
  const original = blueprint.slots.find((slot: any) => slot.slotId === slotId);
  if (!original) throw new Error("题位不存在，请重新选择。");
  let next = structuredClone(blueprint);
  next.slots.find((slot: any) => slot.slotId === slotId).questionType = task.questionType;
  next = changeBlueprintTask(next, slotId, task);
  next = updateBlueprintPoints(next, slotId, blueprint.requirements?.scoringMode === "none" ? 0 : points, [task]);
  return clearBlueprintReview(next);
}
export function addBlueprintSlot(blueprint: any, task: any, points = 0, makeId = () => crypto.randomUUID()) {
  checkTask(blueprint, task); checkPoints(points);
  const slotId = makeId();
  if (!slotId || blueprint.slots?.some((slot: any) => slot.slotId === slotId)) throw new Error("新增题位身份无效，请重试。");
  const next = structuredClone(blueprint), score = blueprint.requirements?.scoringMode === "none" ? 0 : points;
  next.slots.push({ slotId, number: next.slots.length + 1, questionType: task.questionType, taskId: task.id,
    taskLabel: task.label, goalIds: [], points: score, partPoints: blueprintPartPoints(task, score) });
  return clearBlueprintReview(next);
}
export function removeBlueprintSlot(blueprint: any, slotId: string) {
  if (!blueprint.slots.some((slot: any) => slot.slotId === slotId)) throw new Error("题位不存在，请重新选择。");
  const next = structuredClone(blueprint);
  next.slots = next.slots.filter((slot: any) => slot.slotId !== slotId).map((slot: any, index: number) => ({ ...slot, number: index + 1 }));
  return clearBlueprintReview(next);
}
export function blueprintReview(blueprint: any, tasks: any[]) {
  const quantity = blueprintQuantityReview(blueprint), slots = blueprint.slots || [], scored = blueprint.requirements?.scoringMode !== "none";
  const invalidTasks = slots.filter((slot: any) => {
    const task = tasks.find(task => task.id === slot.taskId);
    return !task || task.questionType !== slot.questionType;
  });
  const invalidPoints = slots.filter((slot: any) => {
    if (!Number.isInteger(slot.points) || slot.points < 0 || slot.points > 1000 || (!scored && slot.points !== 0)) return true;
    const task = tasks.find(task => task.id === slot.taskId), parts = slot.partPoints;
    if (!Array.isArray(parts)) return true;
    if (slot.questionType !== "free_response") return parts.length > 0;
    const expected = task?.partIds || [], ids = parts.map((part: any) => part.partId);
    return ids.length !== expected.length || new Set(ids).size !== ids.length || ids.some((id: string) => !expected.includes(id))
      || parts.some((part: any) => !Number.isInteger(part.points) || part.points < 0 || part.points > 1000)
      || parts.reduce((sum: number, part: any) => sum + part.points, 0) !== slot.points;
  });
  const points = slots.reduce((sum: number, slot: any) => sum + (Number.isFinite(slot.points) ? slot.points : 0), 0);
  const expectedPoints = scored ? blueprint.requirements?.targetScore || 0 : 0;
  const missingGoals = missingRequiredGoals(blueprint, tasks);
  const hasExcess = slots.length > 60 || blueprintTypes.some(type => quantity.actualCounts[type] > quantity.expectedCounts[type]);
  return { quantity, invalidTasks, invalidPoints, points, expectedPoints, missingGoals, hasExcess,
    canSelect: !hasExcess && !invalidTasks.length && !invalidPoints.length };
}
