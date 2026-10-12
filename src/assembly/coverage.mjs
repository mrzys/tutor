import { createCoverageGateway, coverageSchema } from '../llm/coverage-gateway.mjs';
import { coverageFingerprint } from './coverage-state.mjs';

export function coverageContext(draft) {
  const requirements = draft.baseline.requirements;
  const confirmedTargets = (requirements.teachingGoals ?? []).map(goal => goal.observable).filter(Boolean);
  if (!confirmedTargets.length) confirmedTargets.push(requirements.goal || requirements.teacherRequest || '按所选范围练习');
  return { requirements, confirmedTargets, questions: draft.slots.filter(slot => slot.question).map(slot => {
    const evidence = {}; let remaining = 9000; let truncated = false;
    const add = (key, text) => { if (typeof text !== 'string' || !text) return;
      evidence[key] = text.slice(0, remaining); remaining -= evidence[key].length;
      if (evidence[key].length < text.length) truncated = true; };
    add('student.stem', slot.question.student.stem);
    slot.question.student.options.forEach((item, i) => add(`student.options[${i}].text`, `${item.label}. ${item.text}`));
    slot.question.student.parts.forEach((item, i) => add(`student.parts[${i}].prompt`, item.prompt));
    slot.question.teacher.solutions.forEach((item, i) => add(`teacher.solutions[${i}].text`, item.text));
    return { slotId: slot.slotId, number: slot.number, questionId: slot.question.questionId,
      contentVersion: slot.question.contentVersion, teacherVersion: slot.question.teacherVersion,
      questionType: slot.questionType, evidence, visibleContentTruncated: truncated,
      imagesNotProvided: slot.question.student.assets.length > 0 };
  }) };
}

export function validateCoverage(proposal, context) {
  const parsed = coverageSchema.parse(proposal);
  for (const check of parsed.checks) {
    if (!context.confirmedTargets.some(target => target.includes(check.requirement))) {
      throw Object.assign(new Error(`检查项目“${check.requirement}”不是 confirmedTargets 的原文片段。不得新增含参综合、书面推理等教师未要求的目标；请逐字提取已确认目标。`), { code: 'invalid_model_output' });
    }
    if (check.status === 'covered' && check.suggestion) {
      throw Object.assign(new Error('已覆盖事项不需追加训练建议，请将 suggestion 设为空字符串。'), { code: 'invalid_model_output' });
    }
    for (const reference of check.evidence) {
      const question = context.questions.find(item => item.slotId === reference.slotId);
      if (!question || !Object.hasOwn(question.evidence, reference.ref) || !question.evidence[reference.ref]) {
        throw Object.assign(new Error('覆盖依据引用了不存在的题位或内容。'), { code: 'invalid_model_output' });
      }
    }
    if (['covered', 'partial'].includes(check.status) && !check.evidence.some(item => item.ref.startsWith('student.'))) {
      throw Object.assign(new Error('覆盖判断必须引用实际题面。'), { code: 'invalid_model_output' });
    }
  }
  return parsed;
}

export async function reviewDraftCoverage(draft, { gateway = createCoverageGateway(), signal } = {}) {
  const fingerprint = coverageFingerprint(draft);
  const context = coverageContext(draft);
  const base = { fingerprint, method: 'llm_content_review', empirical: false, reviewedAt: new Date().toISOString() };
  if (!context.questions.length) return { ...base, status: 'unavailable', reason: '暂无可复核题面。' };
  if (JSON.stringify(context).length > 150000) return { ...base, status: 'unavailable', reason: '题面内容较多，请分卷复核。' };
  let abortHandler;
  try {
    if (signal?.aborted) throw Object.assign(new Error('已取消覆盖复核。'), { code: 'cancelled' });
    const aborted = new Promise((_, reject) => {
      abortHandler = () => reject(Object.assign(new Error('已取消覆盖复核。'), { code: 'cancelled' }));
      signal?.addEventListener('abort', abortHandler, { once: true });
    });
    const result = await Promise.race([gateway.propose(context, { signal, validate: proposal => validateCoverage(proposal, context) }), aborted]);
    if (signal?.aborted) throw Object.assign(new Error('已取消覆盖复核。'), { code: 'cancelled' });
    if (!result.ok) return { ...base, status: 'unavailable', reason: '本次 AI 覆盖复核未完成，题面已保留，可重试。', run: result.run ?? null };
    return { ...base, status: 'complete', ...validateCoverage(result.proposal, context), run: result.run ?? null };
  } catch (error) {
    if (signal?.aborted || error.code === 'cancelled') throw error;
    return { ...base, status: 'unavailable', reason: '本次 AI 覆盖复核未通过证据校验，题面已保留，可重试。' };
  } finally { signal?.removeEventListener('abort', abortHandler); }
}

export function attachCoverageReview(current, review, expectedRevision) {
  if ((current.revision ?? 0) !== expectedRevision || coverageFingerprint(current) !== review.fingerprint) {
    return { ok: false, error: { code: 'revision_conflict', message: '复核期间草稿已更新，请按当前题面重新复核。' } };
  }
  if (current.confirmedPaperId) return { ok: false, error: { code: 'finalized_draft', message: '该草稿已成卷，请从成卷派生后复核。' } };
  return { ok: true, draft: { ...current, coverageReview: review, revision: expectedRevision + 1 } };
}
