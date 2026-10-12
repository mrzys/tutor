// Shared by the server and UI. Versions bind a review to the exact frozen content;
// locking a question or saving feedback does not invalidate its teaching review.
export function coverageFingerprint(draft) {
  return JSON.stringify({ requirements: draft.baseline.requirements,
    slots: draft.slots.map(slot => ({ slotId: slot.slotId, taskId: slot.taskId,
      questionType: slot.questionType, goalIds: slot.goalIds, status: slot.status,
      questionId: slot.question?.questionId, contentVersion: slot.question?.contentVersion,
      teacherVersion: slot.question?.teacherVersion })) });
}

export function currentCoverageReview(draft) {
  return draft.coverageReview?.fingerprint === coverageFingerprint(draft) ? draft.coverageReview : null;
}
