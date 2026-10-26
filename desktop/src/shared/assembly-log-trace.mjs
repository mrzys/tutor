const actions = new Set([
  "intake_prepare", "blueprint_plan", "blueprint_check", "draft_create", "manual_draft_create",
  "draft_candidates", "draft_operation", "paper_confirmation", "paper_confirm", "paper_derive",
  "feedback_save", "history_delete", "pdf_export", "pdf_read",
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A request captures its trace before awaiting IPC. Manual creation retries keep
// the same trace and operation identity even after a different flow was opened.
export function createAssemblyTraceTracker(makeId = () => crypto.randomUUID()) {
  let current = makeId();
  const listeners = new Set();
  const manualOperations = new Map();
  function change(id) {
    current = id;
    for (const listener of listeners) listener(id);
    return id;
  }
  return {
    current: () => current,
    begin: () => change(makeId()),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    payload(action, input) {
      if (!actions.has(action)) return input;
      if (action === "manual_draft_create" && uuid.test(input?.operationId || "")) {
        const operation = input.operationId;
        if (!manualOperations.has(operation)) {
          manualOperations.set(operation, makeId());
          if (manualOperations.size > 40) manualOperations.delete(manualOperations.keys().next().value);
        }
        change(manualOperations.get(operation));
      }
      return { ...input, assemblyTraceId: uuid.test(input?.assemblyTraceId || "") ? input.assemblyTraceId : current };
    },
  };
}
