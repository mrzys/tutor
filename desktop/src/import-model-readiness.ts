export type ImportModelReadiness = {
  configured: boolean;
  sourceConfigured: boolean;
  teachingConfigured: boolean;
  activeConfigured: boolean;
};

/** Local settings only; a separate assembly model is not an import prerequisite. */
export function importModelReadiness(model: any): ImportModelReadiness {
  const activeConfigured = model?.configured === true;
  const sourceConfigured = typeof model?.importSourceConfigured === "boolean"
    ? model.importSourceConfigured : activeConfigured;
  const teachingConfigured = typeof model?.importTeachingConfigured === "boolean"
    ? model.importTeachingConfigured : activeConfigured;
  const configured = typeof model?.importConfigured === "boolean"
    ? model.importConfigured : sourceConfigured && teachingConfigured;
  return { configured, sourceConfigured, teachingConfigured, activeConfigured };
}

export function importModelReady(model: any, resumeTeaching = false): boolean {
  const ready = importModelReadiness(model);
  return resumeTeaching ? ready.teachingConfigured : ready.configured;
}
