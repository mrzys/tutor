import { questionTypes } from './type-constraints.mjs';

// Capacity is a preflight upper bound under current source, scope, solution and
// duplicate rules. It is never a claim of pedagogical fit or reviewed mastery.
export function planningCapacity(tasks, requirements, countPolicy) {
  const constraints = requirements.typeConstraints ?? { excludedTypes: [], exactCounts: {} };
  const candidates = new Map();
  const byTypeCandidates = Object.fromEntries(questionTypes.map(type => [type, new Set()]));
  for (const task of tasks) for (const candidate of task.foundationEligibleCandidates) {
    candidates.set(candidate.questionId, candidate);
    byTypeCandidates[task.questionType].add(candidate.questionId);
  }
  const byType = Object.fromEntries(questionTypes.map(type => [type,
    (constraints.excludedTypes.includes(type) || constraints.exactCounts[type] === 0 || (countPolicy === 'fixed' && requirements.counts[type] === 0)) ? 0 : new Set([...byTypeCandidates[type]].map(id => candidates.get(id).duplicateGroup)).size]));
  const slots = []; const exactIds = new Set();
  const add = (type, count, exact) => {
    for (let index = 0; index < count; index++) {
      const slotId = `capacity-${slots.length}`;
      slots.push({ slotId, questionType: type });
      if (exact) exactIds.add(slotId);
    }
  };
  if (countPolicy === 'fixed') questionTypes.forEach(type => add(type, requirements.counts[type], true));
  else {
    for (const type of questionTypes) if (Object.hasOwn(constraints.exactCounts, type)) add(type, constraints.exactCounts[type], true);
    for (const type of questionTypes) if (!constraints.excludedTypes.includes(type) && !Object.hasOwn(constraints.exactCounts, type)) add(type, 30, false);
  }
  const groupsBySlot = slots.map(slot => [...new Set([...byTypeCandidates[slot.questionType]].map(id => candidates.get(id).duplicateGroup))]);
  const owners = new Map();
  const match = (index, visited) => {
    for (const group of groupsBySlot[index]) {
      if (visited.has(group)) continue;
      visited.add(group);
      if (!owners.has(group) || match(owners.get(group), visited)) { owners.set(group, index); return true; }
    }
    return false;
  };
  // Match exact-demand slots first. Later augmentations may relocate their
  // duplicate group but cannot drop an already satisfied exact-demand slot.
  slots.forEach((_, index) => match(index, new Set()));
  const assigned = new Set([...owners.values()].map(index => slots[index].slotId));
  const requested = Object.values(requirements.counts).reduce((sum, count) => sum + count, 0);
  const exactMissing = [...exactIds].filter(id => !assigned.has(id)).length;
  const missing = Math.max(exactMissing, requested - assigned.size, 0);
  const typeShortages = questionTypes.flatMap(questionType => {
    const demand = countPolicy === 'fixed' ? requirements.counts[questionType] : constraints.exactCounts[questionType];
    return demand > byType[questionType] ? [{ questionType, requested: demand, available: byType[questionType], missing: demand - byType[questionType] }] : [];
  });
  const details = { requested, available: Math.max(0, requested - missing), missing, byType, countPolicy, typeShortages };
  if (missing && countPolicy === 'suggested' && !exactMissing && assigned.size > 0) {
    details.suggestedQuestionCount = assigned.size;
    details.suggestedCounts = Object.fromEntries(questionTypes.map(type => [type,
      slots.filter(slot => slot.questionType === type && assigned.has(slot.slotId)).length]));
  }
  return details;
}
