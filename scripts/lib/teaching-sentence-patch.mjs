import { validateTeachingResult } from './teaching-term-pipeline.mjs';
import { qualityHash, validateQualityResolutions } from './teaching-quality-signals.mjs';

const fail = code => Object.assign(new Error(code), { code });
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const scalarLength = text => [...text].length;
function pathKeys(path) {
  if (['answer', 'teachingSolution'].includes(path)) return [path];
  if (path === 'difficultyAssessment.basis') return ['difficultyAssessment', 'basis'];
  if (path === 'teachingFocus.examFocus') return ['teachingFocus', 'examFocus'];
  const m = /^teachingFocus\.studentRequirements\[([0-2])\]$/u.exec(path ?? '');
  return m ? ['teachingFocus', 'studentRequirements', Number(m[1])] : null;
}
const get = (candidate, path) => pathKeys(path)?.reduce((v, key) => v?.[key], candidate);
const termIdentity = finding => ['ruleId', 'fieldPath', 'term', 'start', 'end'].map(key => finding?.[key] ?? null);
const termFindingId = finding => qualityHash(termIdentity(finding));
const escaped = (chars, at) => { let count = 0; while (at > 0 && chars[--at] === '\\') count++; return count % 2 === 1; };

/** Descriptive request schema, not a new authority or a semantic verdict. */
export function teachingReviewResponseContract(contract) {
  if (![1, 2].includes(contract?.segmentPatchVersion)) return null;
  const compact = contract.segmentPatchVersion === 2;
  return { requiredKeys: [...(compact ? ['requestId'] : ['questionId', 'candidateSha256', 'sourceContentSha256']), 'patches', 'unresolvedIssues',
    ...(contract.qualityFindings ? ['qualityResolutions'] : []), ...(contract.allowedIssues ? ['issueResolutions'] : []),
    ...(contract.termFindings ? ['termResolutions'] : [])],
    patchKeys: compact ? ['segmentId', 'newText'] : ['segmentId', 'oldTextSha256', 'newText'],
    ...(compact && contract.allowedIssues ? { issueResolutionKeys: ['issueIndex', 'status', 'basis'] } : {}),
    textMutationAllowed: contract.allowedSegments.length > 0, issueResolutionAllowed: Boolean(contract.allowedIssues?.length),
    issueResolutionNeedsTextPatch: false,
    ...(contract.resolutionVersion === 2 ? { resolutionVersion: 2,
      resolutionStatuses: ['repaired', 'false_positive', 'confirmed_defect', 'unresolved'],
      repairedRequiresRelatedTextChange: true, falsePositiveRequiresMaterialBasis: true } : {}) };
}

/** Only the local contract carries revision hashes. Aliases belong to this
 * request's ordered findings and are expanded only after the full local CAS. */
export function teachingReviewModelContract(contract) {
  if (contract?.segmentPatchVersion !== 2) return structuredClone(contract);
  const withoutHashes = value => Array.isArray(value) ? value.map(withoutHashes)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/sha256|hash/iu.test(key)).map(([key, item]) => [key, withoutHashes(item)])) : value;
  const projected = withoutHashes(contract);
  delete projected.questionId;
  delete projected.methodScopes;
  if (contract.falsePositiveScopeVersion === 1) projected.allowedSegments = projected.allowedSegments.map(segment => ({ ...segment,
    maxNewTextChars: segment.scope === 'method' ? 12000 : Math.min(6000, Math.max(1000, scalarLength(segment.expectedText) * 3)) }));
  if (projected.qualityFindings) projected.qualityFindings = projected.qualityFindings.map((f, i) => ({ ...f, id: `q${i}` }));
  if (projected.termFindings) projected.termFindings = projected.termFindings.map((f, i) => ({ ...f, findingId: `t${i}` }));
  return projected;
}

/** Does not grant acceptance. Merge verifies the full saved contract and
 * response before consuming these locally expanded resolution identities. */
export function expandTeachingReviewResponse(contract, response) {
  const expanded = structuredClone(response);
  if (contract?.segmentPatchVersion !== 2) return expanded;
  for (const [key, identity, findings, prefix] of [
    ['qualityResolutions', 'id', contract.qualityFindings, 'q'],
    ['termResolutions', 'findingId', contract.termFindings, 't'],
  ]) {
    if (!findings || !Array.isArray(expanded?.[key])) continue;
    for (const item of expanded[key]) {
      if (!item || typeof item !== 'object' || typeof item[identity] !== 'string') throw fail('invalid_teaching_patch');
      const index = findings.findIndex((_, i) => item[identity] === `${prefix}${i}`);
      if (index < 0) throw fail('invalid_teaching_patch');
      item[identity] = findings[index][identity];
    }
  }
  return expanded;
}

/** Text boundaries only, never mathematical or curriculum judgments. Offsets
 * are Unicode scalar values, shared with Rust. Formula delimiters are atomic. */
export function teachingSentenceRanges(text) {
  const chars = [...text], ranges = [];
  let start = 0, close = null;
  for (let i = 0; i < chars.length; i++) {
    const pair = chars[i] + (chars[i + 1] ?? '');
    if (close) {
      if (!escaped(chars, i) && (close.length === 2 ? pair === close : chars[i] === close)) {
        i += close.length - 1; close = null;
      }
      continue;
    }
    if (!escaped(chars, i)) {
      if (pair === '$$' || pair === '\\(' || pair === '\\[') {
        close = pair === '\\(' ? '\\)' : pair === '\\[' ? '\\]' : '$$'; i++; continue;
      }
      if (chars[i] === '$') { close = '$'; continue; }
    }
    const decimal = /\d/u.test(chars[i - 1] ?? '') && /\d/u.test(chars[i + 1] ?? '');
    if ('。！？；!?;\n'.includes(chars[i]) || (chars[i] === '.' && !decimal && (i + 1 === chars.length || /\s/u.test(chars[i + 1])))) {
      ranges.push({ start, end: i + 1 }); start = i + 1;
    }
  }
  // An unclosed formula has no trustworthy trailing sentence boundary.
  if (!close && start < chars.length) ranges.push({ start, end: chars.length });
  return ranges;
}

function targetRange(text, finding) {
  const { start, end } = finding;
  // Existing term/display scanners emit UTF-16 offsets. Refuse half-surrogate
  // boundaries, stale spellings, and empty slices before converting units.
  if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end <= text.length
    && !(/[\uD800-\uDBFF]/u.test(text[start - 1] ?? '') && /[\uDC00-\uDFFF]/u.test(text[start] ?? ''))
    && !(/[\uD800-\uDBFF]/u.test(text[end - 1] ?? '') && /[\uDC00-\uDFFF]/u.test(text[end] ?? ''))
    && (typeof finding.term !== 'string' || text.slice(start, end) === finding.term)) {
    return { start: scalarLength(text.slice(0, start)), end: scalarLength(text.slice(0, end)) };
  }
  for (const key of ['term', 'quote', 'oldText']) {
    const literal = finding[key];
    if (typeof literal !== 'string' || !literal.length) continue;
    const at = text.indexOf(literal);
    if (at >= 0 && text.indexOf(literal, at + 1) < 0) return { start: scalarLength(text.slice(0, at)), end: scalarLength(text.slice(0, at + literal.length)) };
  }
  return null;
}

// A change elsewhere in the same field cannot mechanically establish that
// this located concern was repaired. Explicit method scopes remain the unit
// authorized for a method rewrite; mathematical adequacy is still reviewed.
function repairedAuthorizedSegment(context, finding, replacements) {
  const text = get(context.candidate, finding.fieldPath);
  if (typeof text !== 'string') return false;
  const target = targetRange(text, finding);
  return target && replacements.some(r => r.fieldPath === finding.fieldPath
    && r.start <= target.start && target.end <= r.end && r.expectedText !== r.newText);
}

/** New model calls use this contract. Legacy persisted whole-field contracts
 * are separate replay inputs and are not silently upgraded or widened. */
export function createTeachingSentencePatchContract(context) {
  return deriveTeachingSentencePatchContract(context, 2, 1, 2, 1);
}
function deriveTeachingSentencePatchContract(context, resolutionVersion, classroomPolicyVersion, segmentPatchVersion = 1, falsePositiveScopeVersion) {
  const { originalMaterial, candidate, reviewFindings } = context ?? {}, id = originalMaterial?.questionId;
  try { if (!validateTeachingResult(candidate, id).textComplete || !candidate.difficultyAssessment.basis.trim()) return null; } catch { return null; }
  if (typeof id !== 'string' || !id || !Array.isArray(reviewFindings) || !reviewFindings.length) return null;
  const spans = [];
  for (const finding of reviewFindings) {
    if (!finding || !['term', 'display', 'quality', 'model_issue'].includes(finding.type)) continue;
    const text = get(candidate, finding.fieldPath);
    if (typeof text !== 'string') continue;
    const target = targetRange(text, finding);
    if (!target) continue;
    const pieces = teachingSentenceRanges(text).filter(r => r.start < target.end && target.start < r.end);
    if (!pieces.length) continue;
    const start = pieces[0].start, end = pieces.at(-1).end;
    if (end - start > 1600) continue;
    spans.push({ fieldPath: finding.fieldPath, start, end });
  }
  spans.sort((a, b) => (a.fieldPath < b.fieldPath ? -1 : a.fieldPath > b.fieldPath ? 1 : 0) || a.start - b.start || a.end - b.end);
  const merged = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous?.fieldPath === span.fieldPath && span.start < previous.end) previous.end = Math.max(previous.end, span.end);
    else merged.push({ ...span });
  }
  let allowedRanges = merged.filter(r => r.end - r.start <= 1600);
  const methodScopes = context.reviewMethodScopes !== undefined ? context.reviewMethodScopes : context.patchContract?.methodScopes;
  if (segmentPatchVersion === 2 && methodScopes !== undefined) {
    if (!Array.isArray(methodScopes) || methodScopes.length > 12) return null;
    const methods = [];
    for (const scope of methodScopes) {
      if (!exact(scope, ['fieldPath', 'start', 'end', 'expectedText', 'scopeBasis']) || scope.fieldPath !== 'teachingSolution'
        || !Number.isSafeInteger(scope.start) || !Number.isSafeInteger(scope.end) || scope.start < 0 || scope.end <= scope.start
        || scope.end - scope.start > 6000 || typeof scope.expectedText !== 'string'
        || typeof scope.scopeBasis !== 'string' || !scope.scopeBasis.trim() || scalarLength(scope.scopeBasis) > 4000) return null;
      const text = get(candidate, scope.fieldPath), chars = [...text];
      if (scope.end > chars.length || chars.slice(scope.start, scope.end).join('') !== scope.expectedText) return null;
      const sentences = teachingSentenceRanges(text).filter(r => r.start < scope.end && scope.start < r.end);
      if (!sentences.length || sentences[0].start !== scope.start || sentences.at(-1).end !== scope.end) return null;
      const overlaps = r => r.fieldPath === scope.fieldPath && r.start < scope.end && scope.start < r.end;
      if (methods.some(overlaps) || allowedRanges.some(r => overlaps(r) && (r.start < scope.start || r.end > scope.end))) return null;
      const actualMethod = reviewFindings.some(f => f.fieldPath === scope.fieldPath
        && ((f.type === 'term' && (f.ruleId === 'limit-notation' || f.category === 'special_tool')) || (f.type === 'quality' && f.dimension === 'method'))
        && (() => { const target = targetRange(text, f); return target && scope.start <= target.start && target.end <= scope.end; })());
      if (!actualMethod) return null;
      methods.push({ fieldPath: scope.fieldPath, start: scope.start, end: scope.end, scope: 'method', scopeBasis: scope.scopeBasis });
    }
    allowedRanges = [...allowedRanges.filter(r => !methods.some(m => m.fieldPath === r.fieldPath && m.start <= r.start && r.end <= m.end)), ...methods]
      .sort((a, b) => (a.fieldPath < b.fieldPath ? -1 : a.fieldPath > b.fieldPath ? 1 : 0) || a.start - b.start || a.end - b.end);
  }
  const allowedSegments = allowedRanges.map((r, i) => {
    const text = get(candidate, r.fieldPath), expectedText = [...text].slice(r.start, r.end).join('');
    return { segmentId: `s${i}`, ...r, expectedText, expectedTextSha256: qualityHash(expectedText), fieldTextSha256: qualityHash(text) };
  });
  const qualityFindings = reviewFindings.filter(f => f.type === 'quality');
  const allowedIssues = candidate.issues.map((expectedText, issueIndex) => ({ issueIndex, expectedText, expectedTextSha256: qualityHash(expectedText) }));
  const termFindings = [...new Map(reviewFindings.filter(f => f.type === 'term').map(f => {
    const [ruleId, fieldPath, term, start, end] = termIdentity(f), findingId = termFindingId(f);
    return [findingId, { findingId, ruleId, fieldPath, term, start, end,
      ...(segmentPatchVersion === 2 && Object.hasOwn(f, 'category') ? { category: f.category } : {}),
      ...(classroomPolicyVersion === 1 && ruleId === 'limit-notation' ? { requiredAction: 'rewrite_without_limits' } : {}) }];
  })).values()];
  const contract = { questionId: id, candidateSha256: qualityHash(candidate), sourceContentSha256: qualityHash(originalMaterial), segmentPatchVersion,
    ...(segmentPatchVersion === 2 && methodScopes?.length ? { methodScopes: structuredClone(methodScopes) } : {}),
    ...(resolutionVersion === 2 ? { resolutionVersion: 2 } : {}), allowedSegments,
    ...(segmentPatchVersion === 2 && falsePositiveScopeVersion === 1 ? { falsePositiveScopeVersion: 1 } : {}),
    ...(classroomPolicyVersion === 1 ? { classroomPolicyVersion: 1 } : {}),
    ...(qualityFindings.length ? { qualityFindings } : {}), ...(allowedIssues.length ? { allowedIssues } : {}),
    ...(resolutionVersion === 2 && termFindings.length ? { termFindings } : {}) };
  if (segmentPatchVersion === 2) contract.requestId = `r-${qualityHash(contract).slice(0, 16)}`;
  return contract;
}

/** Atomic exact-range application. Unchanged text and source identities are
 * locked. Passing this contract does not independently establish valid math. */
export function mergeTeachingSentencePatch(context, response) {
  const saved = context?.patchContract;
  if (!saved || ![1, 2].includes(saved.segmentPatchVersion)
    || (Object.hasOwn(saved, 'resolutionVersion') && saved.resolutionVersion !== 2)
    || (saved.segmentPatchVersion === 2 && saved.resolutionVersion !== 2)) throw fail('invalid_teaching_patch');
  // Persisted pre-v2 contracts retain their exact old status semantics, even
  // when replayed by a caller that otherwise creates new v2 contexts.
  if (Object.hasOwn(saved, 'classroomPolicyVersion') && saved.classroomPolicyVersion !== 1) throw fail('invalid_teaching_patch');
  if (saved.segmentPatchVersion === 2 && saved.classroomPolicyVersion !== 1) throw fail('invalid_teaching_patch');
  if (Object.hasOwn(saved, 'falsePositiveScopeVersion') && (saved.falsePositiveScopeVersion !== 1 || saved.segmentPatchVersion !== 2)) throw fail('invalid_teaching_patch');
  const contract = deriveTeachingSentencePatchContract(context, saved.resolutionVersion === 2 ? 2 : 1, saved.classroomPolicyVersion, saved.segmentPatchVersion, saved.falsePositiveScopeVersion);
  const compact = saved.segmentPatchVersion === 2;
  const keys = [...(compact ? ['requestId'] : ['questionId', 'candidateSha256', 'sourceContentSha256']), 'patches', 'unresolvedIssues',
    ...(contract?.qualityFindings ? ['qualityResolutions'] : []), ...(contract?.allowedIssues ? ['issueResolutions'] : []),
    ...(contract?.termFindings ? ['termResolutions'] : [])];
  if (!contract || qualityHash(contract) !== qualityHash(context.patchContract) || !exact(response, keys)
    || (compact ? ['requestId'] : ['questionId', 'candidateSha256', 'sourceContentSha256']).some(k => response[k] !== contract[k])
    || !Array.isArray(response.patches) || response.patches.length > 12 || !Array.isArray(response.unresolvedIssues) || response.unresolvedIssues.length > 100
    || response.unresolvedIssues.some(v => typeof v !== 'string' || !v.trim() || scalarLength(v) > 4000)) throw fail('invalid_teaching_patch');
  if (response.unresolvedIssues.length) throw fail('teaching_patch_unresolved');
  response = expandTeachingReviewResponse(contract, response);
  const replacements = [], seen = new Set();
  for (const patch of response.patches) {
    if (!exact(patch, compact ? ['segmentId', 'newText'] : ['segmentId', 'oldTextSha256', 'newText']) || seen.has(patch.segmentId) || typeof patch.newText !== 'string') throw fail('invalid_teaching_patch');
    seen.add(patch.segmentId);
    const span = contract.allowedSegments.find(s => s.segmentId === patch.segmentId);
    if (!span) throw fail('invalid_teaching_patch');
    const text = get(context.candidate, span.fieldPath), chars = [...text];
    if (qualityHash(text) !== span.fieldTextSha256 || qualityHash(chars.slice(span.start, span.end).join('')) !== span.expectedTextSha256
      || (!compact && patch.oldTextSha256 !== span.expectedTextSha256)) throw fail('revision_conflict');
    if (scalarLength(patch.newText) > (span.scope === 'method' ? 12000 : Math.min(6000, Math.max(1000, (span.end - span.start) * 3)))) throw fail('teaching_patch_scope_exceeded');
    if (replacements.some(r => r.fieldPath === span.fieldPath && r.start < span.end && span.start < r.end)) throw fail('invalid_teaching_patch');
    replacements.push({ ...span, newText: patch.newText });
  }
  const resolvedIssues = new Set();
  let repairedIssue = false;
  if (contract.allowedIssues) {
    if (!Array.isArray(response.issueResolutions) || response.issueResolutions.length !== contract.allowedIssues.length) throw fail('invalid_teaching_patch');
    for (const item of response.issueResolutions) {
      if (!exact(item, compact ? ['issueIndex', 'status', 'basis'] : ['issueIndex', 'oldTextSha256', 'status', 'basis']) || !Number.isSafeInteger(item.issueIndex) || resolvedIssues.has(item.issueIndex)
        || !(contract.resolutionVersion === 2 ? ['repaired', 'false_positive', 'confirmed_defect', 'unresolved'] : ['resolved', 'unresolved']).includes(item.status)
        || typeof item.basis !== 'string' || !item.basis.trim() || scalarLength(item.basis) > 4000) throw fail('invalid_teaching_patch');
      const allowed = contract.allowedIssues.find(a => a.issueIndex === item.issueIndex);
      if (!allowed || (!compact && allowed.expectedTextSha256 !== item.oldTextSha256) || qualityHash(context.candidate.issues[item.issueIndex]) !== allowed.expectedTextSha256) throw fail('revision_conflict');
      if (!(contract.resolutionVersion === 2 ? ['repaired', 'false_positive'] : ['resolved']).includes(item.status)) throw fail('teaching_patch_unresolved');
      if (contract.resolutionVersion === 2 && item.status === 'repaired') repairedIssue = true;
      resolvedIssues.add(item.issueIndex);
    }
  }
  const next = structuredClone(context.candidate);
  replacements.sort((a, b) => (a.fieldPath < b.fieldPath ? -1 : a.fieldPath > b.fieldPath ? 1 : 0) || b.start - a.start);
  for (const replacement of replacements) {
    const keys = pathKeys(replacement.fieldPath), chars = [...get(next, replacement.fieldPath)];
    let owner = next; for (const key of keys.slice(0, -1)) owner = owner[key];
    owner[keys.at(-1)] = chars.slice(0, replacement.start).join('') + replacement.newText + chars.slice(replacement.end).join('');
  }
  if (repairedIssue && !replacements.some(r => !r.fieldPath.startsWith('difficultyAssessment.')
    && get(context.candidate, r.fieldPath) !== get(next, r.fieldPath))) throw fail('teaching_quality_unchanged');
  next.issues = next.issues.filter((_, i) => !resolvedIssues.has(i));
  if (contract.termFindings) {
    if (!Array.isArray(response.termResolutions) || response.termResolutions.length !== contract.termFindings.length) throw fail('invalid_teaching_patch');
    const termSeen = new Set();
    for (const item of response.termResolutions) {
      if (!exact(item, ['findingId', 'status', 'basis']) || termSeen.has(item.findingId)
        || !contract.termFindings.some(f => f.findingId === item.findingId)
        || !['repaired', 'false_positive', 'confirmed_defect', 'unresolved'].includes(item.status)
        || typeof item.basis !== 'string' || !item.basis.trim() || scalarLength(item.basis) > 4000) throw fail('invalid_teaching_patch');
      termSeen.add(item.findingId);
      if (!['repaired', 'false_positive'].includes(item.status)) throw fail('teaching_patch_unresolved');
      const finding = contract.termFindings.find(f => f.findingId === item.findingId);
      if (finding.requiredAction === 'rewrite_without_limits' && item.status === 'false_positive') throw fail('teaching_classroom_rewrite_required');
      if (item.status === 'repaired' && (typeof get(context.candidate, finding.fieldPath) !== 'string'
        || get(context.candidate, finding.fieldPath) === get(next, finding.fieldPath))) throw fail('teaching_quality_unchanged');
      if (compact && item.status === 'repaired' && !repairedAuthorizedSegment(context, finding, replacements)) throw fail('teaching_quality_unchanged');
    }
  }
  validateTeachingResult(next, contract.questionId);
  validateQualityResolutions(context, response, next);
  if (compact && contract.qualityFindings?.some(f => response.qualityResolutions.find(r => r.id === f.id)?.status === 'repaired'
    && !repairedAuthorizedSegment(context, f, replacements))) throw fail('teaching_quality_unchanged');
  return next;
}

/** Preserve a model-reviewed occurrence only while its whole sentence survives
 * at the exact position obtained from the authorized patches. */
function retainedOccurrence(context, response, next, old, current) {
  if (['ruleId', 'fieldPath', 'term'].some(key => old[key] !== current[key])) return false;
  const before = get(context.candidate, old.fieldPath), after = get(next, old.fieldPath);
  if (typeof before !== 'string' || typeof after !== 'string') return false;
  if (!Number.isSafeInteger(current.start) || !Number.isSafeInteger(current.end) || current.start < 0 || current.end <= current.start || current.end > after.length
    || after.slice(current.start, current.end) !== current.term) return false;
  const target = targetRange(before, old);
  const sentence = target && teachingSentenceRanges(before).find(r => r.start <= target.start && target.end <= r.end);
  if (!sentence) return false;
  const chars = [...before]; let offset = 0;
  const replacements = response.patches.map(p => ({ ...context.patchContract.allowedSegments.find(s => s.segmentId === p.segmentId), newText: p.newText }))
    .filter(r => r.fieldPath === old.fieldPath).sort((a, b) => a.start - b.start);
  for (const patch of replacements) {
    const { start, end } = patch, replacement = [...patch.newText];
    if (end <= sentence.start) { offset += replacement.length - (end - start); continue; }
    if (sentence.end <= start) continue;
    const original = chars.slice(start, end); let prefix = 0, suffix = 0;
    while (prefix < original.length && prefix < replacement.length && original[prefix] === replacement[prefix]) prefix++;
    while (suffix < original.length - prefix && suffix < replacement.length && original.at(-suffix - 1) === replacement.at(-suffix - 1)) suffix++;
    if (start + prefix >= sentence.end) continue;
    if (end - suffix <= sentence.start) { offset += replacement.length - original.length; continue; }
    return false;
  }
  const mapped = { start: sentence.start + offset, end: sentence.end + offset }, afterChars = [...after];
  const at = targetRange(after, current);
  return mapped.start >= 0 && afterChars.slice(mapped.start, mapped.end).join('') === chars.slice(sentence.start, sentence.end).join('')
    && teachingSentenceRanges(after).some(r => r.start === mapped.start && r.end === mapped.end)
    && at?.start === target.start + offset && at?.end === target.end + offset;
}

/** Source/candidate CAS and the complete reply are checked before any explicit
 * false-positive disposition is applied. Archived contracts keep old semantics. */
export function filterReviewedTermFindings(findings, context, response, next) {
  if (context?.patchContract?.resolutionVersion !== 2 || !context.patchContract.termFindings) return findings;
  const verified = mergeTeachingSentencePatch(context, response);
  if (qualityHash(verified) !== qualityHash(next)) return findings;
  response = expandTeachingReviewResponse(context.patchContract, response);
  const falsePositives = new Set(response.termResolutions.filter(r => r.status === 'false_positive').map(r => r.findingId));
  return findings.filter(f => {
    if (f?.type && f.type !== 'term') return true;
    return !context.patchContract.termFindings.some(old => {
      if (!falsePositives.has(old.findingId)) return false;
      if (context.patchContract.falsePositiveScopeVersion === 1) return retainedOccurrence(context, response, next, old, f);
      return old.findingId === termFindingId(f) && typeof get(context.candidate, old.fieldPath) === 'string'
        && get(next, old.fieldPath) === get(context.candidate, old.fieldPath)
        && qualityHash(termIdentity(f)) === qualityHash(termIdentity(old));
    });
  });
}
