export const questionTypeOrder = Object.freeze(['single_choice', 'fill_blank', 'free_response']);

// Keep stable slot identities and the teacher's order within each question type.
// Unknown types remain visible for validation rather than being silently dropped.
export function groupSlotsByType(slots) {
  const rank = type => {
    const index = questionTypeOrder.indexOf(type);
    return index < 0 ? questionTypeOrder.length : index;
  };
  return [...slots].sort((a, b) => rank(a.questionType) - rank(b.questionType))
    .map((slot, index) => ({ ...slot, number: index + 1 }));
}

export function slotsAreGroupedByType(slots) {
  const grouped = groupSlotsByType(slots);
  return slots.every((slot, index) => slot.slotId === grouped[index].slotId && slot.number === index + 1);
}
