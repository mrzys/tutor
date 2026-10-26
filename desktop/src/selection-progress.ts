import { createWorkflowPresenter, type WorkflowClock, type WorkflowProgressEvent, type WorkflowStep } from "./workflow-progress.ts";

export const selectionStepIds = ["select_pool", "select_evaluate", "select_save"] as const;
export type SelectionStepId = typeof selectionStepIds[number];
export type SelectionProgressEvent = WorkflowProgressEvent<SelectionStepId>;
export type SelectionStep = WorkflowStep<SelectionStepId>;

export function createSelectionPresenter(runId: string, onChange: (steps: SelectionStep[]) => void, clock?: WorkflowClock) {
  return createWorkflowPresenter(runId, selectionStepIds, onChange, clock);
}
