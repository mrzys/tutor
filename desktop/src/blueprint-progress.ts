import { createWorkflowPresenter, type WorkflowClock, type WorkflowProgressEvent, type WorkflowStep } from "./workflow-progress.ts";

export const blueprintStepIds = ["plan_supply", "plan_slots", "plan_check"] as const;
export type BlueprintStepId = typeof blueprintStepIds[number];
export type BlueprintProgressEvent = WorkflowProgressEvent<BlueprintStepId>;
export type BlueprintStep = WorkflowStep<BlueprintStepId>;

export function createBlueprintPresenter(runId: string, onChange: (steps: BlueprintStep[]) => void, clock?: WorkflowClock) {
  return createWorkflowPresenter(runId, blueprintStepIds, onChange, clock);
}
