import { addBlueprintSlot, removeBlueprintSlot, changeBlueprintTask } from './blueprint-review.js';

// Resolve visible numbers to stable identities before any deletion can renumber them.
export function applyBlueprintActions(blueprint, actions, tasks, newId = () => crypto.randomUUID()) {
  const source = new Map(blueprint.slots.map(slot => [slot.number, slot.slotId]));
  const insertionTails = new Map();
  let next = structuredClone(blueprint);
  const taskFor = id => { const task = tasks.find(item => item.id === id); if (!task) throw new Error('考查任务已变化，请重新提出调整。'); return task; };
  for (const action of actions) {
    const ids = (action.numbers || []).map(number => { const id = source.get(number); if (!id) throw new Error(`没有第 ${number} 题，请重新指定。`); return id; });
    if (action.type === 'delete') for (const id of ids) next = removeBlueprintSlot(next, id);
    else if (action.type === 'add') {
      const task = taskFor(action.taskId);
      let anchorId;
      if (action.afterNumber != null) {
        anchorId = source.get(action.afterNumber);
        const anchor = next.slots.find(slot => slot.slotId === anchorId);
        if (!anchor) throw new Error(`新增位置第 ${action.afterNumber} 题已不存在，请重新指定。`);
        if (anchor.questionType !== task.questionType) throw new Error('蓝图按题型分组，只能指定同题型题目之后的位置；新增其他题型请使用默认位置。');
      }
      let afterId = insertionTails.get(anchorId) || anchorId;
      for (let i = 0; i < action.count; i++) {
        const addedId = newId();
        next = addBlueprintSlot(next, task, addedId);
        if (anchorId) {
          const added = next.slots.find(slot => slot.slotId === addedId);
          const remaining = next.slots.filter(slot => slot.slotId !== addedId);
          const position = remaining.findIndex(slot => slot.slotId === afterId);
          if (position < 0) throw new Error('新增位置已变化，请重新指定。');
          remaining.splice(position + 1, 0, added);
          next.slots = remaining.map((slot, index) => ({ ...slot, number: index + 1 }));
          afterId = addedId;
        }
      }
      if (anchorId) insertionTails.set(anchorId, afterId);
    }
    else if (action.type === 'set_task') for (const id of ids) next = changeBlueprintTask(next, id, taskFor(action.taskId));
    else if (action.type === 'difficulty') {
      if (ids.some(id => !next.slots.some(slot => slot.slotId === id))) throw new Error('要调整难度的题位已删除，请重新指定。');
      next.slots = next.slots.map(slot => ids.includes(slot.slotId) ? { ...slot, targetDifficulty: action.targetDifficulty } : slot);
    }
    else if (action.type === 'allow_premise') next.requirements.premises = [...new Set([...next.requirements.premises, action.premiseId])];
    else if (action.type === 'set_counts') {
      for (const type of ['single_choice', 'fill_blank', 'free_response']) {
        const existing = next.slots.filter(slot => slot.questionType === type);
        const wanted = action.counts[type];
        for (const slot of existing.slice(wanted).reverse()) next = removeBlueprintSlot(next, slot.slotId);
        const task = tasks.find(item => item.questionType === type && item.sectionIds.some(id => next.requirements.mainScope.includes(id)));
        for (let i = existing.length; i < wanted; i++) next = addBlueprintSlot(next, task, newId());
      }
    } else throw new Error('暂不支持这项调整，请补充希望修改的题目或要求。');
  }
  if (!next.slots.length) throw new Error('至少保留一道题；新建组卷请使用左上方入口。');
  next.generation = { ...next.generation, edited: true, countPolicy: 'fixed' };
  return next;
}

export function draftOperationsFor(actions, draft, tasks) {
  let baselineRequirements = structuredClone(draft.baseline.requirements);
  const slotId = number => { const slot = draft.slots.find(item => item.number === number); if (!slot) throw new Error(`没有第 ${number} 题。`); return slot.slotId; };
  return actions.flatMap(action => {
    if (action.type === 'replace') return [{ type: 'replace', slotIds: action.numbers.map(slotId), mode: 'direct', ...(action.taskId ? { taskId: action.taskId } : {}) }];
    if (action.type === 'delete') return action.numbers.map(number => ({ type: 'delete', slotId: slotId(number) }));
    if (action.type === 'difficulty') return [{ type: 'difficulty', slotIds: action.numbers.map(slotId), targetDifficulty: action.targetDifficulty, mode: 'direct' }];
    if (action.type === 'add') {
      const task = tasks.find(item => item.id === action.taskId); if (!task) throw new Error('考查任务已变化。');
      const anchor = action.afterNumber == null ? null : draft.slots.find(item => item.number === action.afterNumber);
      if (action.afterNumber != null && !anchor) throw new Error(`没有第 ${action.afterNumber} 题。`);
      if (anchor && anchor.questionType !== task.questionType) throw new Error('草稿按题型分组，只能指定同题型题目之后的位置；新增其他题型请使用默认位置。');
      const sample = draft.slots.find(item => item.questionType === task.questionType);
      const points = draft.baseline.requirements.scoringMode === 'none' ? 0 : sample?.points ?? ({ single_choice: 8, fill_blank: 10, free_response: 16 })[task.questionType];
      return Array.from({ length: action.count }, () => ({ type: 'add', taskId: task.id, points, ...(action.afterNumber ? { afterSlotId: slotId(action.afterNumber) } : {}) }));
    }
    if (action.type === 'allow_premise') {
      baselineRequirements = { ...baselineRequirements, premises: [...new Set([...baselineRequirements.premises, action.premiseId])] };
      return [{ type: 'baseline', requirements: structuredClone(baselineRequirements) }];
    }
    throw new Error('这项改动需要重新确认蓝图，请说明需要保留哪些题目。');
  });
}
