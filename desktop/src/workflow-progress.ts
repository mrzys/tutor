export type WorkflowProgressEvent<StepId extends string = string> = { runId: string; step: StepId; status: "running" | "completed" };
export type WorkflowStep<StepId extends string = string> = { id: StepId; status: "pending" | "running" | "completed"; active: boolean };
export const minimumStepDuration = 650;

export type WorkflowClock = { now: () => number; schedule: (callback: () => void, delay: number) => unknown; clear: (timer: unknown) => void };
const browserClock: WorkflowClock = {
  now: () => performance.now(),
  schedule: (callback, delay) => setTimeout(callback, delay),
  clear: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

// Backend work never waits on this presenter. Completed fast steps remain visible
// briefly; slow steps advance immediately when their next real event arrives.
export function createWorkflowPresenter<StepId extends string>(runId: string, stepIds: readonly StepId[], onChange: (steps: WorkflowStep<StepId>[]) => void, clock = browserClock) {
  const ids = [...stepIds];
  const states = ids.map(() => "pending" as WorkflowStep<StepId>["status"]);
  let active = -1;
  let visibleSince = 0;
  let timer: unknown;
  let backendFinished = false;
  let disposed = false;
  let resolveFinished: ((completed: boolean) => void) | undefined;
  const finished = new Promise<boolean>(resolve => { resolveFinished = resolve; });
  function publish() {
    onChange(ids.map((id, index) => ({ id, status: index <= active ? states[index] : "pending", active: index === active })));
  }
  function tick() {
    clock.clear(timer);
    if (disposed || active < 0) return;
    publish();
    if (states[active] !== "completed") return;
    const hasNext = active + 1 < ids.length && states[active + 1] !== "pending";
    const lastComplete = backendFinished && active === ids.length - 1;
    if (!hasNext && !lastComplete) return;
    const remaining = minimumStepDuration - (clock.now() - visibleSince);
    if (remaining > 0) { timer = clock.schedule(tick, remaining); return; }
    if (hasNext) { active++; visibleSince = clock.now(); tick(); }
    else { disposed = true; resolveFinished?.(true); }
  }
  function receive(event: WorkflowProgressEvent<StepId>) {
    if (disposed || event.runId !== runId || !["running", "completed"].includes(event.status)) return;
    const index = ids.indexOf(event.step);
    if (index < 0 || (states[index] === "completed" && event.status === "running")) return;
    states[index] = event.status;
    if (active < 0 && index === 0) { active = 0; visibleSince = clock.now(); }
    tick();
  }
  function finish(completedSteps: StepId[]) {
    // A successful response includes the real completed stages, also covering an
    // event delivered after its IPC response. No work is inferred from timers.
    // Remove only never-started stages explicitly omitted by the backend.
    const current = ids[active];
    for (let index = ids.length - 1; index >= 0; index--) {
      if (states[index] === "pending" && !completedSteps.includes(ids[index])) {
        ids.splice(index, 1); states.splice(index, 1);
      }
    }
    active = current ? ids.indexOf(current) : -1;
    for (const step of completedSteps) receive({ runId, step, status: "completed" });
    backendFinished = true;
    tick();
    return finished;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    clock.clear(timer);
    resolveFinished?.(false);
  }
  publish();
  return { receive, finish, dispose };
}
