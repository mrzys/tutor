import { createHash } from 'node:crypto';
import { validateTeachingResult } from './teaching-term-pipeline.mjs';
import { validateQualityResolutions } from './teaching-quality-signals.mjs';
import { mergeTeachingSentencePatch } from './teaching-sentence-patch.mjs';

const fail = code => Object.assign(new Error(code), { code });
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
export const teachingPatchHash = value => createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');

function pathKeys(path) {
  if (['answer', 'teachingSolution'].includes(path)) return [path];
  if (path === 'difficultyAssessment.basis') return ['difficultyAssessment', 'basis'];
  if (path === 'teachingFocus.examFocus') return ['teachingFocus', 'examFocus'];
  const match = /^teachingFocus\.studentRequirements\[([0-2])\]$/u.exec(path ?? '');
  return match ? ['teachingFocus', 'studentRequirements', Number(match[1])] : null;
}
function field(candidate, path) {
  const keys = pathKeys(path);
  if (!keys) return undefined;
  return keys.reduce((owner, key) => owner?.[key], candidate);
}
function validatePatchCandidate(candidate, questionId) {
  try { return validateTeachingResult(candidate, questionId); }
  catch (error) {
    if (error?.code === 'incomplete_result_without_explanation') return { textComplete: false };
    throw error;
  }
}

/** Exact teacher-text replacements only. This validates structure, not math;
 * callers rescan and retain any remaining findings after the atomic merge. */
export function applyTeachingTextPatches(candidate, questionId, patches, allowedFieldPaths) {
  validatePatchCandidate(candidate, questionId);
  if (!Array.isArray(patches) || !patches.length || patches.length > 12 || !Array.isArray(allowedFieldPaths)) throw fail('invalid_teaching_patch');
  const next = structuredClone(candidate), seen = new Set();
  for (const patch of patches) {
    if (!exact(patch, ['fieldPath', 'oldText', 'newText'])) throw fail('invalid_teaching_patch');
    const { fieldPath, oldText, newText } = patch;
    const keys = pathKeys(fieldPath);
    if (!keys || !allowedFieldPaths.includes(fieldPath) || seen.has(fieldPath) || typeof oldText !== 'string'
      || typeof newText !== 'string' || [...newText].length > 60000) throw fail('invalid_teaching_patch');
    seen.add(fieldPath);
    if (typeof field(next, fieldPath) !== 'string' || field(next, fieldPath) !== oldText) throw fail('revision_conflict');
    let owner = next;
    for (const key of keys.slice(0, -1)) owner = owner[key];
    owner[keys.at(-1)] = newText;
  }
  validatePatchCandidate(next, questionId);
  return next;
}

/** Only actual, finite field locations can restrict a complete candidate.
 * Missing/invalid JSON, material issues or unlocated findings need the existing
 * single full review instead. No keywords choose a mathematical method. */
export function createTeachingPatchContract(context) {
  const { originalMaterial, candidate, reviewFindings } = context ?? {};
  const questionId = originalMaterial?.questionId;
  try { if (!validatePatchCandidate(candidate, questionId).textComplete) return null; } catch { return null; }
  if (typeof questionId !== 'string' || !questionId || candidate.issues.length || !Array.isArray(reviewFindings) || !reviewFindings.length) return null;
  const qualityFindings = reviewFindings.filter(f => f.type === 'quality');
  // Already persisted contracts are immutable replay inputs. Only newly built
  // semantic contracts default to v2; manual text patches remain v1.
  const fieldHashMode = context.patchContract ? context.patchContract.fieldHashMode === true : qualityFindings.length > 0;
  const allowedFields = [];
  for (const finding of reviewFindings) {
    if (!['term', 'display', 'quality'].includes(finding?.type)) return null;
    if (finding.type === 'quality' && ['material', 'assessment'].includes(finding.dimension)) return null;
    const paths = finding.type === 'quality' && ['mathematics', 'proof', 'method'].includes(finding.dimension)
      ? ['teachingSolution', 'answer', 'difficultyAssessment.basis', 'teachingFocus.examFocus', ...candidate.teachingFocus.studentRequirements.map((_, i) => `teachingFocus.studentRequirements[${i}]`)]
      : [finding.fieldPath];
    for (const fieldPath of paths) {
      const expectedText = field(candidate, fieldPath);
      if (typeof expectedText !== 'string') return null;
      if (!allowedFields.some(item => item.fieldPath === fieldPath)) allowedFields.push({ fieldPath, expectedText,
        ...(fieldHashMode ? { expectedTextSha256: teachingPatchHash(expectedText) } : {}) });
    }
  }
  return { questionId, candidateSha256: teachingPatchHash(candidate),
    sourceContentSha256: teachingPatchHash(originalMaterial), allowedFields, ...(qualityFindings.length ? { qualityFindings } : {}), ...(fieldHashMode ? { fieldHashMode: true } : {}) };
}

/** Re-derive the permitted scope and CAS identities, then merge once. Source
 * hashing here binds the exact offline originalMaterial; Rust imports bind
 * their own complete source-content contract. Neither trusts response hashes. */
export function mergeTeachingBoundedPatch(context, patch) {
  if ([1,2].includes(context?.patchContract?.segmentPatchVersion)) return mergeTeachingSentencePatch(context, patch);
  const contract = createTeachingPatchContract(context);
  if (!contract || teachingPatchHash(contract) !== teachingPatchHash(context.patchContract)
    || !exact(patch, ['questionId', 'candidateSha256', 'sourceContentSha256', 'patches', 'unresolvedIssues', ...(contract?.qualityFindings ? ['qualityResolutions'] : [])])
    || ['questionId', 'candidateSha256', 'sourceContentSha256'].some(key => patch[key] !== contract[key])
    || !Array.isArray(patch.unresolvedIssues) || patch.unresolvedIssues.length > 100
    || patch.unresolvedIssues.some(issue => typeof issue !== 'string' || !issue.trim() || [...issue].length > 4000)
    || !Array.isArray(patch.patches)) throw fail('invalid_teaching_patch');
  if (patch.unresolvedIssues.length) throw fail('teaching_patch_unresolved');
  const patches = contract.fieldHashMode ? patch.patches.map(item => {
    if (!exact(item, ['fieldPath', 'oldTextSha256', 'newText'])) throw fail('invalid_teaching_patch');
    const allowed = contract.allowedFields.find(f => f.fieldPath === item.fieldPath);
    const current = field(context.candidate, item.fieldPath);
    if (!allowed || typeof current !== 'string' || allowed.expectedTextSha256 !== teachingPatchHash(current)
      || item.oldTextSha256 !== allowed.expectedTextSha256) throw fail('revision_conflict');
    return { fieldPath: item.fieldPath, oldText: current, newText: item.newText };
  }) : patch.patches;
  const next = !patches.length ? structuredClone(context.candidate)
    : applyTeachingTextPatches(context.candidate, contract.questionId, patches, contract.allowedFields.map(item => item.fieldPath));
  validateQualityResolutions(context, patch, next);
  return next;
}
