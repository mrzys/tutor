// Project-local planning vocabulary; these are not official curriculum codes.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = message => { throw Object.assign(new Error(message), { code: 'invalid_plan' }); };
const text = (value, label, max = 1000) => {
  if (typeof value !== 'string' || value.length > max) invalid(`${label}需为不超过 ${max} 字符的文本。`);
  return value.trim();
};
const oneOf = (value, values, label) => {
  if (!values.includes(value)) invalid(`${label}无效。`);
  return value;
};
const list = (value, label) => {
  if (!Array.isArray(value) || value.length > 20 || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 120)
      || new Set(value.map(item => item.trim())).size !== value.length) invalid(`${label}需为不重复的文本数组，最多 20 项。`);
  return value.map(item => item.trim());
};

export function normalizeTeachingGoals(input = [], chapterIds) {
  if (!Array.isArray(input) || input.length > 20) invalid('教学目标需为数组，最多 20 项。');
  const ids = new Set();
  return input.map(goal => {
    if (!object(goal) || typeof goal.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(goal.id) || ids.has(goal.id)) invalid('教学目标身份无效或重复。');
    ids.add(goal.id);
    if (!Number.isInteger(goal.version) || goal.version < 1) invalid('教学目标版本需为正整数。');
    const knowledgeScope = list(goal.knowledgeScope, '目标知识范围');
    if (knowledgeScope.some(id => !chapterIds.includes(id))) invalid('目标知识范围包含未登记章节。');
    if (!object(goal.conditions) || !object(goal.source) || goal.source.kind !== 'teacher') invalid('目标需保留教师来源及完成条件。');
    return {
      id: goal.id, version: goal.version, knowledgeScope,
      cognition: oneOf(goal.cognition, ['unspecified', 'understand', 'apply', 'reason'], '认知要求'),
      observable: text(goal.observable, '可观察表现'),
      conditions: {
        prompt: oneOf(goal.conditions.prompt, ['unspecified', 'provided', 'independent'], '提示条件'),
        response: oneOf(goal.conditions.response, ['unspecified', 'answer', 'written_reasoning'], '作答要求'),
      },
      priority: oneOf(goal.priority, ['required', 'preferred'], '目标优先级'),
      abilities: list(goal.abilities ?? [], '能力'), literacies: list(goal.literacies ?? [], '核心素养'),
      source: { kind: 'teacher', text: text(goal.source.text, '教师原始表达') },
    };
  });
}

export function compatibleGoal(goal, task) {
  return Boolean(task) && goal.knowledgeScope.some(id => task.sectionIds.includes(id))
    && (goal.conditions.response !== 'written_reasoning' || task.questionType === 'free_response');
}

// These are planning links only. A chapter/task link never establishes item support.
export function suggestedGoalIds(goals, task) {
  return goals.filter(goal => compatibleGoal(goal, task)).map(goal => goal.id);
}

export function goalReview(requirements, slots, tasks) {
  const goals = requirements.teachingGoals ?? [];
  const items = goals.map(goal => {
    const linked = slots.filter(slot => (slot.goalIds ?? []).includes(goal.id));
    const issues = [];
    const vague = /^(活题|提高能力|提升能力|综合题|素养题|熟练使用|理解概念)[。！!\s]*$/.test(goal.observable);
    if (!goal.observable) issues.push('尚未说明学生需要完成的可观察表现，需澄清。');
    if (vague) issues.push('目标表述仍需澄清：是解释概念、在常规问题中运用，还是独立选择方法并说明理由？请补充具体表现。');
    if (!goal.knowledgeScope.length) issues.push('尚未指定目标知识范围，需澄清。');
    if (goal.knowledgeScope.some(id => !requirements.mainScope.includes(id))) issues.push('目标知识范围超出本次主考范围，请明确保留目标还是调整范围。');
    if (goal.knowledgeScope.some(id => !requirements.learnedScope.includes(id))) issues.push('目标涉及尚未确认已学的章节，需核对允许解法。');
    if (linked.some(slot => !compatibleGoal(goal, tasks.find(task => task.id === slot.taskId)))) issues.push('关联题位的章节或作答形式与目标不兼容，请调整题位或关联。');
    if (!linked.length) issues.push('尚无关联题位；保留原优先级，不计为已覆盖。');
    return { goalId: goal.id, observable: goal.observable, priority: goal.priority,
      status: !goal.observable || vague || !goal.knowledgeScope.length ? 'pending_clarification' : linked.length ? 'planned' : 'unassigned',
      slotIds: linked.map(slot => slot.slotId), issues };
  });
  return { items, issues: items.flatMap(item => item.issues.map(message => `${item.goalId}：${message}`)) };
}

export function goalDifferences(requirements, slots, tasks) {
  const review = goalReview(requirements, slots, tasks);
  return review.items.map(item => ({ code: 'goal_support_unknown', goalId: item.goalId,
    message: `教学目标「${item.observable || '待澄清'}」${item.priority === 'required' ? '（必须）' : '（偏好）'}：${item.issues.join('；') || '已规划题位，题目支持证据待复核'}。当前不计为已证实覆盖。` }));
}

export function unknownGoalSupport(requirements, slot) {
  const ids = slot.goalIds ?? [];
  return (requirements.teachingGoals ?? []).filter(goal => ids.includes(goal.id)).map(goal => ({
    goalId: goal.id, goalVersion: goal.version, status: 'unknown', priority: goal.priority,
    reason: '尚未接入与本目标、完成条件及题目版本绑定且已复核的支持证据。',
  }));
}

// Reception is intentionally separate from publication, bank readiness and matching.
// Keep the producer's payload intact; adapters can be added after seeing real output.
export function receiveAnalysisSubmission(input) {
  if (!object(input) || input.schemaVersion !== 1 || typeof input.questionId !== 'string' || !input.questionId
      || typeof input.contentVersion !== 'string' || !input.contentVersion
      || typeof input.producer !== 'string' || !input.producer || !object(input.rawAnalysis)
      || (input.teacherVersion != null && (typeof input.teacherVersion !== 'string' || !input.teacherVersion))) {
    throw Object.assign(new Error('分析提交需含 schemaVersion、questionId、contentVersion、producer 和原始 rawAnalysis 对象。'), { code: 'invalid_analysis' });
  }
  return { schemaVersion: 1, questionId: input.questionId, contentVersion: input.contentVersion,
    teacherVersion: input.teacherVersion ?? null, producer: input.producer,
    rawAnalysis: structuredClone(input.rawAnalysis), rawSubmission: structuredClone(input),
    reviewStatus: 'pending_review', matchingEligible: false };
}
