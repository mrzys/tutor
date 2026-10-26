import { createWorkflowPresenter, type WorkflowClock, type WorkflowProgressEvent, type WorkflowStep } from "./workflow-progress.ts";
export { minimumStepDuration } from "./workflow-progress.ts";

export const preparationStepIds = ["scope", "supply", "requirements"] as const;
export type PreparationStepId = typeof preparationStepIds[number];
export type PreparationProgressEvent = WorkflowProgressEvent<PreparationStepId>;
export type PresentedStep = WorkflowStep<PreparationStepId>;

export function createPreparationPresenter(runId: string, mode: string, onChange: (steps: PresentedStep[]) => void, clock?: WorkflowClock) {
  return createWorkflowPresenter(runId, mode === "llm" ? preparationStepIds : ["requirements"], onChange, clock);
}
