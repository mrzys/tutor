const scopeIds = (scope: string[] = []) =>
  scope.map(id => id.replace(/^rja-compulsory-1:/, "")).sort();

// Teaching text belongs to the current scope. Template pedagogy and a previous
// scope's goals must not travel into a new request as if the teacher supplied them.
export function composerRequirements(defaults: any, initial: any, scope: string[], message = initial?.teacherRequest || "") {
  const { title, goal, teachingGoals, ...preset } = defaults || {};
  const requirements = { ...preset, ...initial };
  requirements.quantityAuthority = { ...initial?.quantityAuthority };
  if (message !== (initial?.teacherRequest || "")) {
    requirements.quantityAuthority = {};
    delete requirements.quantityPlan;
  }
  if (!initial || JSON.stringify(scopeIds(initial.mainScope)) !== JSON.stringify(scopeIds(scope))) {
    requirements.goal = "";
    requirements.teachingGoals = [];
    delete requirements.quantityPlan;
  }
  return requirements;
}
