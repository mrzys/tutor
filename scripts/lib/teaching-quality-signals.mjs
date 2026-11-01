// Explicit findings are data, never a keyword-derived mathematical verdict.
import { createHash } from 'node:crypto';
const sorted = v => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])])) : v;
export const qualityHash = v => createHash('sha256').update(JSON.stringify(sorted(v))).digest('hex');
const fail = () => Object.assign(Error('invalid_quality_signals'), { code: 'invalid_quality_signals' });
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
export const qualityDimensions = ['mathematics', 'proof', 'method', 'explanation', 'assessment'];
export function validateQualityFindings(value) {
  if (!Array.isArray(value) || value.length > 30) throw fail();
  const seen = new Set();
  for (const f of value) {
    if (!exact(f, ['id', 'dimension', 'fieldPath', 'reason', ...(Object.hasOwn(f ?? {}, 'quote') ? ['quote'] : [])]) || !/^[A-Za-z0-9_-]{1,80}$/u.test(f.id) || seen.has(f.id)
      || ![...qualityDimensions, 'material'].includes(f.dimension) || typeof f.fieldPath !== 'string' || f.fieldPath.length > 120
      || typeof f.reason !== 'string' || !f.reason.trim() || [...f.reason].length > 4000
      || (Object.hasOwn(f, 'quote') && (typeof f.quote !== 'string' || !f.quote.trim() || [...f.quote].length > 1600))) throw fail();
    seen.add(f.id);
  }
  return value.map(f => ({ type: 'quality', ...structuredClone(f), message: f.reason }));
}
export function readQualitySignals(signal, questionId) {
  if (signal == null) return { findings: [], semanticAssessment: 'unknown' };
  if (!exact(signal, ['questionId', 'checks', 'findings']) || signal.questionId !== questionId || !exact(signal.checks, qualityDimensions)
    || qualityDimensions.some(k => !['pass', 'concern', 'unknown'].includes(signal.checks[k]))) throw fail();
  const findings = validateQualityFindings(signal.findings);
  if (qualityDimensions.some(k => signal.checks[k] === 'concern' && !findings.some(f => f.dimension === k))) throw fail();
  return { findings: findings.map(f => ({ ...f, origin: 'generation_self_check' })), semanticAssessment: 'model_self_check_only' };
}
export function externalQualityFindings(audit, original, candidate) {
  if (audit == null) return [];
  if (audit.questionId !== original.questionId || audit.sourceContentSha256 !== qualityHash(original) || audit.candidateSha256 !== qualityHash(candidate)
    || ![['teacher_review', 'teacher'], ['user_authorized_agent_review', 'codex']].some(([m, b]) => audit.method === m && audit.checkedBy === b)
    || typeof audit.evidence !== 'string' || !audit.evidence.trim()) throw fail();
  return validateQualityFindings(audit.findings).map(f => ({ ...f, origin: 'external_review', evidence: audit.evidence }));
}
export function validateQualityResolutions(context, response, next) {
  const flags = (context.reviewFindings ?? []).filter(f => f.type === 'quality');
  if (!flags.length) return;
  // A saved contract is the replay authority. Its missing version means the
  // historical protocol; a new context flag must not upgrade old receipts.
  const version = context.patchContract ? context.patchContract.resolutionVersion : context.reviewResolutionVersion;
  const v2 = version === 2;
  if (version !== undefined && !v2) throw Object.assign(Error('teaching_quality_unresolved'), { code: 'teaching_quality_unresolved' });
  const resolutions = response?.qualityResolutions;
  if (!Array.isArray(resolutions) || resolutions.length !== flags.length || new Set(resolutions.map(r => r?.id)).size !== flags.length
    || resolutions.some(r => !exact(r, ['id', 'status', 'basis']) || !flags.some(f => f.id === r.id)
      || !(v2 ? ['repaired', 'false_positive'] : ['resolved']).includes(r.status)
      || typeof r.basis !== 'string' || !r.basis.trim() || [...r.basis].length > 4000)) throw Object.assign(Error('teaching_quality_unresolved'), { code: 'teaching_quality_unresolved' });
  // A semantic repair cannot be cleared merely by deleting a label or returning
  // the same proof. The explanation remains model evidence, not independent truth.
  const textAt = (value, path) => {
    if (typeof path !== 'string' || !/^(answer|teachingSolution|difficultyAssessment(?:\.basis)?|teachingFocus(?:\.(?:examFocus|studentRequirements(?:\[[0-2]\])?))?)$/u.test(path)) return undefined;
    return path.replace(/\[([0-2])\]/gu, '.$1').split('.').reduce((owner, key) => owner?.[key], value);
  };
  const changedText = (before, after) => typeof before === 'string' || typeof after === 'string' ? before !== after
    : before && after && typeof before === 'object' && typeof after === 'object'
      && [...new Set([...Object.keys(before), ...Object.keys(after)])].some(key => key !== 'level' && changedText(before[key], after[key]));
  if (v2 ? flags.some(f => resolutions.find(r => r.id === f.id).status === 'repaired'
      && !changedText(textAt(context.candidate, f.fieldPath), textAt(next, f.fieldPath)))
    : flags.some(f => ['mathematics', 'proof', 'method'].includes(f.dimension)) && next.teachingSolution === context.candidate.teachingSolution)
    throw Object.assign(Error('teaching_quality_unchanged'), { code: 'teaching_quality_unchanged' });
  const allowed = new Set(['issues']);
  for (const f of context.reviewFindings ?? []) {
    if (f.type !== 'quality') { if (typeof f.fieldPath === 'string') allowed.add(f.fieldPath); continue; }
    if (f.dimension === 'material') for (const path of ['answer', 'teachingSolution', 'difficultyAssessment', 'teachingFocus']) allowed.add(path);
    else if (['mathematics', 'proof', 'method'].includes(f.dimension)) for (const path of ['answer', 'teachingSolution', 'difficultyAssessment', 'teachingFocus']) allowed.add(path);
    else if (f.dimension === 'assessment') for (const path of ['difficultyAssessment', 'teachingFocus']) allowed.add(path);
    else allowed.add(f.fieldPath);
  }
  for (const path of ['questionId', 'answer', 'teachingSolution', 'teachingFocusSchemaVersion', 'difficultyAssessment', 'teachingFocus']) {
    if (!allowed.has(path) && ![...allowed].some(p => p.startsWith(`${path}.`)) && qualityHash(next[path]) !== qualityHash(context.candidate[path]))
      throw Object.assign(Error('invalid_teaching_patch'), { code: 'invalid_teaching_patch' });
  }
}
