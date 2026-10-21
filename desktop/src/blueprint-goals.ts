function canonical(id: string) {
  return ["1.1", "1.2", "1.3"].includes(id) ? `rja-compulsory-1:${id}` : id;
}
export function scopeOverlaps(a: string[] = [], b: string[] = []) {
  return a.some(id => b.some(other => canonical(id) === canonical(other)));
}
// Keep this compatibility rule aligned with Rust check_blueprint. Association
// expresses the teacher's plan; it never supplies independent coverage evidence.
export function goalFitsTask(goal: any, task: any) {
  return Boolean(goal && task && scopeOverlaps(goal.knowledgeScope, task.sectionIds)
    && (goal.conditions?.response !== "written_reasoning" || task.questionType === "free_response"));
}
export function availableTasks(blueprint: any, slot: any, tasks: any[]) {
  return tasks.filter(task => task.questionType === slot.questionType && scopeOverlaps(task.sectionIds, blueprint.requirements?.mainScope));
}
export function changeBlueprintTask(blueprint: any, slotId: string, task: any) {
  const slot = blueprint.slots.find((item: any) => item.slotId === slotId);
  if (!slot || !task || !availableTasks(blueprint, slot, [task]).length) throw new Error("请选择同题型且在本次范围内的考查任务。");
  if (slot.taskId === task.id) return blueprint;
  const next = structuredClone(blueprint);
  const target = next.slots.find((item: any) => item.slotId === slotId);
  target.taskId = task.id;
  target.taskLabel = task.label;
  target.goalIds = [...new Set<string>(target.goalIds || [])].filter(id =>
    goalFitsTask(next.requirements?.teachingGoals?.find((goal: any) => goal.id === id), task));
  delete target.planningReason;
  delete next.supply;
  const parts = task.partIds || [];
  target.partPoints = parts.map((partId: string, index: number) => ({partId,
    points: Math.floor(target.points / parts.length) + (index < target.points % parts.length ? 1 : 0)}));
  return next;
}
export function goalSlots(blueprint: any, goal: any, tasks: any[]) {
  return (blueprint.slots || []).filter((slot: any) => {
    const task = tasks.find(task => task.id === slot.taskId);
    return task && availableTasks(blueprint, slot, [task]).length > 0 && goalFitsTask(goal, task);
  });
}
export function linkedGoalSlots(blueprint: any, goal: any, tasks: any[]) {
  return goalSlots(blueprint, goal, tasks).filter((slot: any) => slot.goalIds?.includes(goal.id));
}
export function missingRequiredGoals(blueprint: any, tasks: any[]) {
  return (blueprint.requirements?.teachingGoals || []).filter((goal: any) => goal.priority === "required" && !linkedGoalSlots(blueprint, goal, tasks).length);
}
export function bindBlueprintGoal(blueprint: any, goalId: string, slotIds: string[], tasks: any[]) {
  const goal = blueprint.requirements?.teachingGoals?.find((item: any) => item.id === goalId);
  if (!goal) throw new Error("教学目标不存在，请重新打开关联窗口。");
  const compatible = goalSlots(blueprint, goal, tasks);
  const selected = [...new Set(slotIds)];
  if (selected.some(id => !compatible.some((slot: any) => slot.slotId === id))) throw new Error("所选题位与目标的范围或作答要求不兼容。");
  if (goal.priority === "required" && !selected.length) throw new Error("必须目标至少需要一个兼容题位。");
  const next = structuredClone(blueprint);
  for (const slot of next.slots) {
    const linked = (slot.goalIds || []).includes(goalId);
    const wanted = selected.includes(slot.slotId);
    if (linked === wanted) continue;
    slot.goalIds = (slot.goalIds || []).filter((id: string) => id !== goalId);
    if (wanted) slot.goalIds.push(goalId);
    delete slot.planningReason;
  }
  delete next.supply;
  return next;
}
