import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getAssemblyConfig, normalizeRequirements, loadPool } from '../assembly/engine.mjs';
import { listQuestions } from '../question-bank/reader.mjs';
import { createLlmGateway } from '../llm/gateway.mjs';
import { createMemoryIntakeStorage } from './storage.mjs';
import { requestSchema, answerSchema, proposalSchema, stages } from './schema.mjs';

const defaultRoot = fileURLToPath(new URL('../../', import.meta.url));
const copy = value => structuredClone(value);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const fieldsByStage = {
  purpose: ['purpose', 'title'], scope: ['mainScope'], boundary: ['learnedScope', 'learnedScopeMode', 'premises'],
  size: ['size', 'questionCount', 'singleChoiceCount', 'fillBlankCount', 'freeResponseCount', 'targetScore', 'scoringMode', 'durationMinutes'],
  goal: ['cognition', 'priority', 'observable', 'response', 'prompt', 'abilities', 'literacies'], review: [],
};
const dependentStages = { purpose: ['purpose', 'goal'], scope: ['scope', 'boundary', 'goal'],
  boundary: ['boundary', 'goal'], size: ['size'], goal: ['goal'], review: [] };
const quickGoalFields = ['observable', 'cognition', 'priority', 'abilities', 'literacies'];
const quickNumericFields = ['questionCount', 'targetScore', 'durationMinutes'];
const quickTypeFields = ['singleChoiceCount', 'fillBlankCount', 'freeResponseCount'];
// Fixed planning is distinct from a teacher's manual lock: extracted counts can
// be replaced by a later teacher message, but only through another proposal.
const editableQuickTypes = session => session.answers.size === 'recommend' || session.quickTypeCountSource === 'model';
const effectiveQuickLocks = session => [...new Set([...(session.lockedFields ?? []),
  ...(!editableQuickTypes(session) ? ['questionCount'] : [])])];
function rememberManualTypeCounts(session, patch = {}) {
  if (patch.size === 'recommend') session.quickTypeCountSource = 'suggested';
  else if (['custom', 'preset'].includes(patch.size) || quickTypeFields.some(field => patch[field] !== undefined)) session.quickTypeCountSource = 'manual';
}
const purposes = [
  { id: 'consolidation', label: '课后巩固', description: '巩固概念和常规运用，发现薄弱点。' },
  { id: 'diagnostic', label: '学情诊断', description: '关注学生目前会什么、卡在哪里。' },
  { id: 'assessment', label: '阶段检测', description: '围绕已学范围检查综合表现。' },
  { id: 'mock_exam', label: '模拟考试', description: '按考试结构安排题型、分值与时间。' },
];
const cognitions = [
  { id: 'unspecified', label: '先按范围组卷', description: '暂不设置教学目标约束。' },
  { id: 'understand', label: '理解概念', description: '解释含义、判断正反例。' },
  { id: 'apply', label: '常规运用', description: '在明确问题中选择并运用已学概念和方法。' },
  { id: 'reason', label: '推理说明', description: '选择方法、展开推导并说明关键理由。' },
];
const priorities = [
  { id: 'preferred', label: '尽量满足', description: '目标支持尚待核验时保留候选，明确标示未知。' },
  { id: 'required', label: '必须满足', description: '承担此目标的题位只选有支持证据的题；证据不足时保留缺口。' },
];
const block = (kind, field, title, value, options, description) => ({ kind, id: `field-${field}`, field, title, value, ...(options ? { options } : {}), ...(description ? { description } : {}) });
const notice = (id, title, description) => ({ kind: 'notice', id, title, description });

function defaultAnswers(config) {
  return { title: config.defaultRequirements.title, purpose: 'consolidation',
    mainScope: [...config.defaultRequirements.mainScope], learnedScope: [...config.defaultRequirements.learnedScope], premises: [],
    size: 'recommend', singleChoiceCount: 6, fillBlankCount: 2, freeResponseCount: 2, targetScore: 100, durationMinutes: 45,
    cognition: 'unspecified', priority: 'preferred', observable: '', response: 'answer', prompt: 'independent', abilities: [], literacies: [] };
}

// Only a verified textbook contents entry can establish the progression order.
// A chapter number alone is ambiguous across volumes and must never be sorted as text.
export function verifiedProgression(config, textbooks) {
  const mappings = config.chapters.map(chapter => {
    const matches = (textbooks?.books ?? []).flatMap((book, bookIndex) =>
      book.tocVerification?.status === 'visually_checked'
        ? (book.chapters ?? []).flatMap(item => item.sections ?? []).flatMap((section, sectionIndex) =>
          (chapter.textbookSectionId ? section.id === chapter.textbookSectionId
            : section.number === chapter.id && chapter.label === `${section.number} ${section.title}`)
            ? [{ id: chapter.id, bookId: book.id, sectionId: section.id, bookIndex, sectionIndex,
              sourceSha256: book.source?.sha256, pdfPage: section.pdfPageStart }] : [])
        : []);
    return matches.length === 1 ? matches[0] : null;
  });
  if (mappings.some(item => !item)) return { status: 'unavailable', orderedIds: [],
    basis: 'data/curriculum/textbooks.json', reason: '部分章节尚未对应唯一且已核实的教材目录，请自定义已学范围。' };
  mappings.sort((a, b) => a.bookIndex - b.bookIndex || a.sectionIndex - b.sectionIndex);
  return { status: 'verified', orderedIds: mappings.map(item => item.id),
    basis: 'data/curriculum/textbooks.json', entries: mappings };
}

function progressionAnswers(answers, config) {
  if (answers.learnedScopeMode !== 'progress') return answers;
  const order = config.progression.orderedIds;
  if (config.progression.status !== 'verified') return { ...answers, learnedScope: [] };
  const latest = Math.max(-1, ...answers.mainScope.map(id => order.indexOf(id)));
  return { ...answers, learnedScope: order.slice(0, latest + 1) };
}

function checkAnswers(input, config) {
  const answers = answerSchema.parse(input);
  for (const [field, ids] of [['mainScope', config.chapters.map(item => item.id)], ['learnedScope', config.chapters.map(item => item.id)], ['premises', config.premises.map(item => item.id)]]) {
    if (answers[field] && (new Set(answers[field]).size !== answers[field].length || answers[field].some(id => !ids.includes(id)))) fail('invalid_intake', `${field} 包含未知或重复项目。`);
  }
  for (const field of ['abilities', 'literacies']) if (answers[field] && new Set(answers[field]).size !== answers[field].length) fail('invalid_intake', '能力或素养项目重复。');
  return answers;
}

function applyAnswers(existing, patch, config) {
  let next = { ...existing, ...checkAnswers(patch, config) };
  // New quick sessions carry a mode; legacy guided sessions keep point semantics.
  if (existing.scoringMode !== undefined && patch.scoringMode === undefined && patch.purpose !== undefined && patch.purpose !== existing.purpose) {
    next.scoringMode = ['assessment', 'mock_exam'].includes(patch.purpose) ? 'points' : 'none';
  }
  if (patch.targetScore > 0 && patch.scoringMode === undefined && existing.scoringMode === 'none') next.scoringMode = 'points';
  if (next.scoringMode === 'points' && !(next.targetScore > 0)) next.targetScore = 100;
  // Direct editing of the boundary is an explicit override of progression defaults.
  if (existing.learnedScopeMode && patch.learnedScope !== undefined && patch.learnedScopeMode === undefined) next.learnedScopeMode = 'custom';
  next = progressionAnswers(next, config);
  const preset = { singleChoiceCount: 6, fillBlankCount: 2, freeResponseCount: 2, targetScore: 100, durationMinutes: 45 };
  const quickCount = existing.questionCount !== undefined;
  if (!quickCount && patch.questionCount !== undefined) fail('invalid_intake', '请在快速需求中指定总题量，或使用各题型数量。');
  if (patch.size === 'preset') {
    if (Object.entries(preset).some(([field, value]) => patch[field] !== undefined && patch[field] !== value)) fail('invalid_intake', '预设规模与自定义数字不一致，请选择自定义。');
    Object.assign(next, preset);
  }
  else if (patch.size === 'recommend') {
    if (!quickCount) {
      if (['singleChoiceCount', 'fillBlankCount', 'freeResponseCount'].some(field => patch[field] !== undefined && patch[field] !== preset[field])) fail('invalid_intake', 'AI 配比建议以 10 题为起点；如需指定各题型数量，请选择自定义。');
      Object.assign(next, { singleChoiceCount: 6, fillBlankCount: 2, freeResponseCount: 2 });
    }
  }
  else if (Object.keys(patch).some(key => ['singleChoiceCount', 'fillBlankCount', 'freeResponseCount'].includes(key))
    || (next.size !== 'recommend' && Object.keys(patch).some(key => ['targetScore', 'durationMinutes'].includes(key)))) next.size = 'custom';
  if (quickCount && next.size === 'recommend') {
    // These counts only hold the requested total for the planner; the teacher
    // confirms the model's actual proposed ratio in the resulting blueprint.
    const total = next.questionCount;
    const quotas = [0.6, 0.2, 0.2].map(weight => total * weight);
    const counts = quotas.map(value => Math.min(30, Math.floor(value)));
    for (let remaining = total - counts.reduce((sum, count) => sum + count, 0); remaining > 0; remaining--) {
      const index = counts.reduce((best, count, index) => count < 30
        && (best < 0 || quotas[index] - count > quotas[best] - counts[best]) ? index : best, -1);
      counts[index] += 1;
    }
    [next.singleChoiceCount, next.fillBlankCount, next.freeResponseCount] = counts;
  }
  if (quickCount) next.questionCount = next.singleChoiceCount + next.fillBlankCount + next.freeResponseCount;
  if (next.scoringMode === 'none') next.targetScore = 0;
  if (next.scoringMode !== 'none' && next.targetScore < 1) fail('invalid_intake', '计分时总分需为正整数。');
  checkAnswers(next, config);
  const count = next.singleChoiceCount + next.fillBlankCount + next.freeResponseCount;
  if (count < 1 || count > 60) fail('invalid_intake', '总题量需为 1～60 题。');
  return next;
}

function validateStep(stage, answers) {
  if ((stage === 'scope' || stage === 'review') && !answers.mainScope.length) fail('invalid_intake', '至少选择一个主考章节。');
  if (stage === 'boundary' || stage === 'review') {
    if (!answers.learnedScope.length) fail('invalid_intake', '请确认已学范围。');
    if (answers.mainScope.some(id => !answers.learnedScope.includes(id))) fail('invalid_intake', '主考章节超出了已学边界，请先调整范围。');
  }
}

function requirementsFor(answers, config, teacherRequest, quick = false) {
  const scopeLabels = config.chapters.filter(chapter => answers.mainScope.includes(chapter.id)).map(item => item.label).join('、');
  const statements = { understand: `解释${scopeLabels}的基本概念，判断符合与不符合定义的例子。`, apply: `在常规问题中运用${scopeLabels}，完成相应判断与运算。`, reason: `针对${scopeLabels}的问题选择方法，写出推导并说明关键理由。` };
  const observable = answers.observable || statements[answers.cognition] || '';
  const teachingGoals = answers.cognition === 'unspecified' && !observable ? [] : [{
    id: 'teacher-goal-1', version: 1, knowledgeScope: answers.mainScope, cognition: answers.cognition,
    observable, conditions: { prompt: answers.prompt, response: answers.response },
    priority: answers.priority, abilities: answers.abilities, literacies: answers.literacies,
    source: { kind: 'teacher', text: `${purposes.find(item => item.id === answers.purpose).label}；${observable}` },
  }];
  return normalizeRequirements({ ...config.defaultRequirements,
    ...(teacherRequest !== undefined ? { teacherRequest } : {}),
    ...(quick ? { automaticFoundation: true } : {}),
    ...(answers.scoringMode !== undefined ? { scoringMode: answers.scoringMode, purpose: answers.purpose } : {}),
    title: answers.title, goal: `${purposes.find(item => item.id === answers.purpose).label}。${observable || '按已确认的章节与解题边界组卷。'}`,
    mainScope: answers.mainScope, learnedScope: answers.learnedScope, premises: answers.premises,
    durationMinutes: answers.durationMinutes, targetScore: answers.targetScore, targetDifficulty: null,
    counts: { single_choice: answers.singleChoiceCount, fill_blank: answers.fillBlankCount, free_response: answers.freeResponseCount }, teachingGoals,
  }, config, config.sources.map(item => item.sourceId));
}

function stageBlocks(stage, answers, config) {
  if (stage === 'purpose') return [block('single_choice', 'purpose', '这次组卷主要用来做什么？', answers.purpose, purposes)];
  if (stage === 'scope') return [block('multi_choice', 'mainScope', '主要考查哪些内容？', answers.mainScope, config.chapters), notice('scope-note', '主考范围', '这里只确定主要考什么；下一步单独确认解题允许用什么。')];
  if (stage === 'boundary') return [block('multi_choice', 'learnedScope', '学生已经学到哪里？', answers.learnedScope, config.chapters),
    ...(answers.premises.length ? [block('multi_choice', 'premises', '额外允许使用的知识与方法', answers.premises,
      config.premises.filter(item => answers.premises.includes(item.id)), '这些是你已允许的方法，可以取消；新增建议须由你确认。')] : [])];
  if (stage === 'size') return [block('single_choice', 'scoringMode', '本次是否计分？', answers.scoringMode ?? 'points', [{ id: 'none', label: '不计分' }, { id: 'points', label: '计分' }]), block('single_choice', 'size', '选择试卷规模', answers.size, [{ id: 'recommend', label: '10 题 · AI 建议题型配比', description: '保持总题量、总分与时长，由 AI 结合教学目标和真实候选安排题型；蓝图中再确认。' }, { id: 'preset', label: '10 题 · 100 分 · 45 分钟', description: '固定 6 道单选、2 道填空、2 道解答；AI 在此结构内规划考查任务。' }, { id: 'custom', label: '自定义题量与分值' }]),
    ...(answers.size === 'custom' ? [['singleChoiceCount', '单选题数量'], ['fillBlankCount', '填空题数量'], ['freeResponseCount', '解答题数量'], ...(answers.scoringMode === 'none' ? [] : [['targetScore', '总分']]), ['durationMinutes', '时间（分钟）']].map(([field, title]) => block('number', field, title, answers[field])) : []),
    notice('size-note', '实际供给会在蓝图中核查', `当前有 ${config.availableCounts.freeResponse} 道就绪解答题。AI 建议配比只调整题型安排，不增加允许工具或放宽目标；不能满足的位置仍会留空。`)];
  if (stage === 'goal') return [block('single_choice', 'cognition', '希望学生做到什么程度？', answers.cognition, cognitions),
    ...(answers.cognition !== 'unspecified' || answers.observable ? [block('single_choice', 'priority', '这个目标的要求强度', answers.priority, priorities),
      block('text', 'observable', '补充可观察的学生表现（可选）', answers.observable, null, '留空时采用当前认知要求的可见描述；能力、素养标签不自动构成题目支持证据。'),
      block('single_choice', 'response', '作答要求', answers.response, [{ id: 'answer', label: '给出答案' }, { id: 'written_reasoning', label: '写出推导与理由' }]),
      block('single_choice', 'prompt', '提示条件', answers.prompt, [{ id: 'independent', label: '独立完成' }, { id: 'provided', label: '提供必要提示' }])] : [])];
  return [notice('review-note', '请确认本次需求', '确认后才进入蓝图。目标关联是规划建议，题目支持仍需证据核查；不能满足的位置会保留为空。'),
    ...(answers.priority === 'required' && (answers.cognition !== 'unspecified' || answers.observable) ? [notice('required-warning', '必须目标需要题目证据', '蓝图会明确承担目标的关键题位；这些题位缺少支持证据时保留为空，其他题位可安排基础练习。请核对目标与关联题位。')] : [])];
}

function safeProposal(input, config, answers) {
  const proposal = proposalSchema.parse(input);
  checkAnswers(proposal.changes, config);
  applyAnswers(answers, proposal.changes, config);
  if (new Set(proposal.blocks.map(item => item.id)).size !== proposal.blocks.length) fail('invalid_model_output', '模型组件身份重复。');
  for (const item of proposal.blocks) {
    if (item.kind === 'notice') {
      if (item.field || item.options || item.value !== undefined) fail('invalid_model_output', '提示组件不能修改字段。');
      continue;
    }
    if (!item.field) fail('invalid_model_output', '模型组件缺少受控字段。');
    const schema = answerSchema.shape[item.field];
    if (item.value !== undefined) {
      checkAnswers({ [item.field]: item.value }, config);
      if (proposal.changes[item.field] !== undefined && JSON.stringify(proposal.changes[item.field]) !== JSON.stringify(item.value)) fail('invalid_model_output', '模型组件默认值与建议变更冲突。');
      // A displayed proposed value belongs to the explicit pending change set as well.
      proposal.changes[item.field] = copy(item.value);
    }
    const inner = schema.unwrap();
    const expected = inner.type ?? inner._def.type;
    const enumFields = ['purpose', 'size', 'scoringMode', 'cognition', 'priority', 'response', 'prompt'];
    const multiFields = ['mainScope', 'learnedScope', 'premises', 'abilities', 'literacies'];
    if ((enumFields.includes(item.field) && item.kind !== 'single_choice') || (multiFields.includes(item.field) && item.kind !== 'multi_choice')
      || (['title', 'observable'].includes(item.field) && item.kind !== 'text') || (expected === 'number' && item.kind !== 'number')) fail('invalid_model_output', '模型字段与组件类型不一致。');
    if (['single_choice', 'multi_choice'].includes(item.kind)) {
      if (!item.options?.length || new Set(item.options.map(option => option.id)).size !== item.options.length) fail('invalid_model_output', '模型选择项缺失或重复。');
      for (const option of item.options) checkAnswers({ [item.field]: item.kind === 'multi_choice' ? [option.id] : option.id }, config);
      if (item.value !== undefined && (Array.isArray(item.value) ? item.value : [item.value]).some(value => !item.options.some(option => option.id === value))) fail('invalid_model_output', '模型默认值不在选择项中。');
    } else if (item.options) fail('invalid_model_output', '模型组件不允许额外选择项。');
  }
  applyAnswers(answers, proposal.changes, config);
  return proposal;
}

function safeQuickProposal(input, config, answers, lockedFields = [], typesEditable = answers.size === 'recommend') {
  // A total explicitly extracted from the teacher's words is still a visible, pending points suggestion.
  const candidate = copy(input);
  if (candidate?.changes?.targetScore > 0 && candidate.changes.scoringMode === undefined && answers.scoringMode === 'none' && !lockedFields.includes('scoringMode')) candidate.changes.scoringMode = 'points';
  if (candidate?.changes?.targetScore > 0 && answers.scoringMode === 'none' && lockedFields.includes('scoringMode')) fail('invalid_model_output', '教师已选择不计分，模型不能写入总分。');
  const proposal = safeProposal(candidate, config, answers);
  const allowedFields = [...quickGoalFields, ...(!lockedFields.includes('scoringMode') ? ['scoringMode'] : []), ...quickNumericFields.filter(field => !lockedFields.includes(field)),
    ...(typesEditable ? quickTypeFields : [])];
  if (Object.keys(proposal.changes).some(field => !allowedFields.includes(field))) {
    fail('invalid_model_output', '快速整理只能完善目标及未手动指定的规模；明确题型只能在尚未指定配比时提取，不能覆盖已选条件或锁定数值。');
  }
  if (typesEditable && answers.size !== 'recommend' && proposal.changes.questionCount !== undefined
      && proposal.changes.questionCount !== answers.questionCount && !quickTypeFields.some(field => proposal.changes[field] !== undefined)) {
    fail('invalid_model_output', '修改此前从原话采纳的总题量时，请同时给出单选、填空、解答三项新数量，避免旧固定配比吞掉新题量。');
  }
  if (quickTypeFields.some(field => proposal.changes[field] !== undefined)) {
    if (quickTypeFields.some(field => proposal.changes[field] === undefined)) fail('invalid_model_output', '明确题型数量需同时给出单选、填空、解答三项；未要求题型填 0。');
    const total = quickTypeFields.reduce((sum, field) => sum + proposal.changes[field], 0);
    if (proposal.changes.questionCount !== undefined && total !== proposal.changes.questionCount) fail('invalid_model_output', '明确题型数量合计须与建议总题量一致。');
    if (lockedFields.includes('questionCount') && total !== answers.questionCount) fail('invalid_model_output', '明确题型数量不能覆盖教师手动锁定的总题量。');
  }
  if (proposal.blocks.length > 2 || proposal.blocks.some(item => item.kind !== 'notice'
      && (item.kind !== 'text' || item.field !== 'observable'))) {
    fail('invalid_model_output', '快速需求仅在目标表述确有必要时展示最多两个澄清，不生成字段选择表单。');
  }
  if (answers.priority === 'required' && proposal.changes.priority !== undefined && proposal.changes.priority !== 'required') {
    fail('invalid_model_output', '必须保留教师明确的必须目标，不能降为偏好。');
  }
  const proposed = applyAnswers(answers, proposal.changes, config);
  const scaleSummary = `规模：${proposed.questionCount} 题${proposed.scoringMode === 'none' ? ' · 不计分' : ` · ${proposed.targetScore} 分`} · ${proposed.durationMinutes} 分钟。`;
  if (!proposal.summary.endsWith(scaleSummary)) proposal.summary += `\n${scaleSummary}`;
  proposalSchema.parse(proposal);
  return proposal;
}

async function methodDependencies(root, answers, config) {
  const pool = await loadPool(root);
  const methods = new Map(config.premises.map(method => [method.id, { ...method, evidenceRefs: [] }]));
  const alreadyAllowedQuestions = new Set();
  for (const { entry, annotation, result } of pool.records) {
    if (!result.ok || !annotation || annotation.contentVersion !== result.question.contentVersion
        || annotation.teacherVersion !== result.question.teacherVersion
        || !Array.isArray(annotation.primarySections) || !annotation.primarySections.length
        || !annotation.primarySections.every(id => answers.mainScope.includes(id))
        || !Array.isArray(annotation.solutionPaths)
        || !result.question.sourceRefs.some(ref => config.defaultRequirements.sourceIds.includes(ref.sourceId))) continue;
    for (const solution of annotation.solutionPaths) {
      if (!solution || typeof solution.id !== 'string' || !solution.id
          || !Array.isArray(solution.requiredSections) || !Array.isArray(solution.requiredPremises)
          || !solution.requiredSections.every(id => answers.learnedScope.includes(id))
          || !solution.requiredPremises.every(id => methods.has(id))
          || typeof solution.basis !== 'string' || !solution.basis.trim()) continue;
      if (solution.requiredPremises.every(id => answers.premises.includes(id))) alreadyAllowedQuestions.add(entry.questionId);
      for (const id of new Set(solution.requiredPremises)) methods.get(id).evidenceRefs.push({
        questionId: entry.questionId, contentVersion: entry.contentVersion, teacherVersion: result.question.teacherVersion,
        solutionPathId: solution.id, requiredSections: copy(solution.requiredSections), requiredPremises: copy(solution.requiredPremises),
        sourceRefs: copy(result.question.sourceRefs), basis: solution.basis,
      });
    }
  }
  return { methods: [...methods.values()].filter(method => method.evidenceRefs.length || answers.premises.includes(method.id)).map(method => ({
    ...method, alreadyAllowed: answers.premises.includes(method.id),
    candidateEvidenceCount: new Set(method.evidenceRefs.map(ref => ref.questionId)).size,
    solutionPathEvidenceCount: method.evidenceRefs.length,
    // Keep prompts bounded while retaining the total and exact version-bound references.
    evidenceRefs: method.evidenceRefs.slice(0, 8),
  })), alreadyAllowedQuestionCount: alreadyAllowedQuestions.size,
  readyCount: pool.records.length, readFailureCount: pool.failures.length,
  evidenceNote: '仅含主考范围内、版本绑定且已证实的完整解法依赖；所需高中章节必须在已学边界内。方法建议仍需教师许可，不保证去重后题量、教学目标或难度。' };
}

function safeMethodsProposal(input, config, answers, dependencies) {
  const proposal = proposalSchema.parse(input);
  if (Object.keys(proposal.changes).some(field => field !== 'premises')) fail('invalid_model_output', '知识与方法建议只能提出额外允许项，不能修改主考范围、已学边界或其他需求。');
  const allowedIds = dependencies.methods.map(method => method.id);
  if (proposal.blocks.some(item => item.kind !== 'notice' && (item.kind !== 'multi_choice' || item.field !== 'premises'))) fail('invalid_model_output', '知识与方法建议只能使用方法多选或提示组件。');
  for (const item of proposal.blocks) {
    if (item.options?.some(option => !allowedIds.includes(option.id))) fail('invalid_model_output', '知识与方法建议包含未知或缺少本次相关依赖证据的选项。');
  }
  const checked = safeProposal(proposal, config, answers);
  const proposedIds = checked.changes.premises ?? answers.premises;
  if (proposedIds.some(id => !allowedIds.includes(id))) fail('invalid_model_output', '新增方法需有当前范围内可核查的题目依赖依据。');
  if (answers.premises.some(id => !proposedIds.includes(id))) fail('invalid_model_output', '方法建议必须保留教师已允许的项目；取消应由教师直接操作。');
  return checked;
}

function present(session, config) {
  const output = copy(session);
  delete output.operations;
  output.requirements = output.status === 'confirmed' && output.requirements ? output.requirements
    : requirementsFor(output.answers, config, output.teacherRequest, output.mode === 'quick');
  output.blocks = stageBlocks(output.stage, output.answers, config);
  if (output.mode === 'quick') {
    output.blocks = [];
    output.progression = { ...copy(session.progression ?? config.progression), mode: output.answers.learnedScopeMode,
      inferredScope: copy(output.answers.learnedScope), automatic: output.answers.learnedScopeMode === 'progress' };
  }
  const requirements = output.requirements;
  output.planning = { countPolicy: output.answers.size === 'recommend' ? 'suggested' : 'fixed' };
  output.summary = output.status === 'confirmed' && output.summary ? output.summary : { title: requirements.title, purpose: purposes.find(item => item.id === output.answers.purpose).label,
    mainScope: config.chapters.filter(item => requirements.mainScope.includes(item.id)).map(item => item.label),
    learnedScope: config.chapters.filter(item => requirements.learnedScope.includes(item.id)).map(item => item.label),
    premises: config.premises.filter(item => requirements.premises.includes(item.id)).map(item => item.label),
    scoringMode: requirements.scoringMode ?? 'points',
    questionCount: Object.values(requirements.counts).reduce((sum, count) => sum + count, 0), points: requirements.targetScore,
    durationMinutes: requirements.durationMinutes, cognition: cognitions.find(item => item.id === output.answers.cognition).label,
    goals: requirements.teachingGoals, goalEvidenceStatus: requirements.teachingGoals.length ? 'unknown' : 'not_requested' };
  return output;
}

export function createIntakeService({ root = defaultRoot, storage = createMemoryIntakeStorage(), gateway = createLlmGateway() } = {}) {
  async function configFor() {
    const result = await getAssemblyConfig({ root });
    if (!result.ok) fail('config_error', '需求目录读取失败。');
    const bank = await listQuestions({ root });
    if (!bank.ok) fail('config_error', '题库供给目录读取失败。');
    const ready = bank.entries.filter(item => item.status === 'ready');
    let textbooks;
    try { textbooks = JSON.parse(await readFile(path.join(root, 'data', 'curriculum', 'textbooks.json'), 'utf8')); }
    catch { textbooks = null; }
    return { ...result.config, progression: verifiedProgression(result.config, textbooks),
      availableCounts: { ready: ready.length, freeResponse: ready.filter(item => item.questionType === 'free_response').length } };
  }
  const publicErrors = new Set(['invalid_intake', 'config_error', 'not_found', 'operation_conflict', 'revision_conflict', 'already_confirmed', 'session_exists', 'cancelled', 'incomplete_intake', 'invalid_model_output', 'invalid_plan']);
  const errorResponse = error => ({ ok: false, error: { code: publicErrors.has(error.code) ? error.code : 'invalid_intake',
    message: error.name === 'ZodError' ? '需求或模型组件格式无效，未修改已确认内容。' : publicErrors.has(error.code) ? error.message : '需求处理失败，未保存变更。' } });
  return {
    publicStatus() { return gateway.publicStatus?.() ?? { configured: Boolean(gateway.configured), provider: null, model: null }; },
    async get(id) {
      try {
        if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) fail('invalid_intake', '需求会话身份无效。');
        // A cancelled HTTP request can still be finishing its persisted revision.
        // Join this session's queue so recovery never returns the previous proposal.
        const session = await storage.transaction(id, () => storage.get(id));
        if (!session) fail('not_found', '未找到需求会话。');
        return { ok: true, session: present(session, await configFor()) };
      } catch (error) { return errorResponse(error); }
    },
    async handle(rawInput, { signal } = {}) {
      try {
        const input = requestSchema.parse(rawInput);
        if (input.lockedFields !== undefined && input.action !== 'prepare') fail('invalid_intake', '数值锁定设置仅用于整理快速需求。');
        const config = await configFor();
        if (signal?.aborted) fail('cancelled', '已取消本次操作。');
        const createsSession = input.action === 'start' || input.action === 'revise';
        const id = createsSession ? (input.action === 'start' && input.sessionId) || `intake-${input.operationId ? createHash('sha256').update(input.operationId).digest('hex').slice(0, 32) : randomUUID()}` : input.sessionId;
        if (!id) fail('invalid_intake', '缺少需求会话身份。');
        const fingerprint = JSON.stringify(input);
        return await storage.transaction(id, async () => {
          let session = await storage.get(id);
          const previous = input.operationId && session?.operations?.[input.operationId];
          if (previous) {
            if (previous.fingerprint !== fingerprint) fail('operation_conflict', '同一操作身份不能提交不同内容。');
            return { ok: true, session: copy(previous.session) };
          }
          if (input.action === 'revise') {
            if (!input.sessionId || !input.operationId || input.answers || input.acceptProposal || input.next) fail('invalid_intake', '请从已确认的需求打开单项编辑。');
            if (session) fail('session_exists', '编辑会话已经存在。');
            const source = await storage.get(input.sessionId);
            if (!source) fail('not_found', '未找到原需求会话。');
            if (source.revision !== input.revision) fail('revision_conflict', '原需求已更新，请重新读取。');
            if (source.status !== 'confirmed') fail('invalid_intake', '只有已确认需求可以派生单项编辑。');
            session = { sessionId: id, revision: 0, stage: input.stage || 'review', status: 'collecting',
              ...(source.mode ? { mode: source.mode } : {}),
              answers: copy(source.answers), confirmedStages: copy(source.confirmedStages), editing: true,
              ...(source.assistantMessage !== undefined ? { assistantMessage: source.assistantMessage } : {}),
              ...(source.teacherRequest !== undefined ? { teacherRequest: source.teacherRequest }
                : source.requirements?.teacherRequest !== undefined ? { teacherRequest: source.requirements.teacherRequest } : {}),
              ...(source.lockedFields ? { lockedFields: copy(source.lockedFields) } : {}),
              ...(source.quickTypeCountSource ? { quickTypeCountSource: source.quickTypeCountSource } : {}),
              sourceSessionId: source.sessionId, proposal: null, proposalKind: null, llmRun: null,
              operations: {}, createdAt: new Date().toISOString() };
          } else if (input.action === 'start') {
            if (session) fail('session_exists', '需求会话已经存在，请读取后继续。');
            const quick = input.flow === 'quick';
            session = { sessionId: id, revision: 0, stage: quick ? 'scope' : 'purpose', status: 'collecting',
              ...(quick ? { mode: 'quick' } : {}),
              answers: applyAnswers({ ...defaultAnswers(config), ...(quick
                ? { learnedScopeMode: 'progress', scoringMode: 'none', targetScore: 0, questionCount: 10, response: 'unspecified', prompt: 'unspecified' } : {}) }, input.answers ?? {}, config), confirmedStages: [],
              proposal: null, proposalKind: null, llmRun: null, operations: {}, createdAt: new Date().toISOString() };
            if (quick) rememberManualTypeCounts(session, input.answers);
          } else {
            if (!session) fail('not_found', '未找到需求会话。');
            if (!input.operationId || input.revision !== session.revision) fail('revision_conflict', '需求已更新，请重新读取后继续。');
            if (session.status === 'confirmed') fail('already_confirmed', '需求已经确认，请开始新需求。');
            if (input.action === 'prepare' || input.action === 'assist' || input.action === 'suggest_methods') {
              const quick = input.action === 'prepare';
              if (quick && session.mode !== 'quick') fail('invalid_intake', '快速整理只用于快速需求会话。');
              if (quick && (input.next || input.stage || input.acceptProposal)) fail('invalid_intake', '请先整理需求，再明确采纳建议。');
              if (quick) {
                session.answers = applyAnswers(session.answers, input.answers ?? {}, config);
                rememberManualTypeCounts(session, input.answers);
                session.lockedFields = copy(input.lockedFields ?? session.lockedFields ?? []);
                validateStep('review', session.answers);
                session.stage = 'review';
              }
              const methodsOnly = input.action === 'suggest_methods';
              if (methodsOnly && session.stage !== 'boundary') fail('invalid_intake', '请在确认已学边界时请求知识与方法建议。');
              if (methodsOnly && (input.answers || input.stage || input.next || input.acceptProposal)) fail('invalid_intake', '请先保存当前范围和已学边界，再单独请求方法建议。');
              if (methodsOnly) validateStep('boundary', session.answers);
              if (!quick && !methodsOnly && !input.message) fail('invalid_intake', '请填写希望助手补充的需求。');
              const dependencies = methodsOnly ? await methodDependencies(root, session.answers, config) : null;
              if (signal?.aborted) fail('cancelled', '已取消本次操作。');
              const validate = candidate => methodsOnly ? safeMethodsProposal(candidate, config, session.answers, dependencies)
                : quick ? safeQuickProposal(candidate, config, session.answers, effectiveQuickLocks(session), editableQuickTypes(session)) : safeProposal(candidate, config, session.answers);
              if (!methodsOnly) {
                session.assistantMessage = input.message ?? (quick ? session.assistantMessage ?? '' : '');
                if (input.message !== undefined) session.teacherRequest = input.message;
              }
              const modelMessage = methodsOnly ? '按本次考查范围与真实题目依赖，建议需要额外确认的知识与方法。'
                : session.assistantMessage;
              session.proposalKind = methodsOnly ? 'methods' : quick ? 'quick_intake' : 'intake';
              let result;
              try { result = await gateway.propose({ task: methodsOnly ? 'suggest_methods' : quick ? 'quick_intake' : 'intake', message: modelMessage, stage: session.stage, answers: session.answers,
                confirmedStages: session.confirmedStages, chapters: config.chapters, premises: config.premises,
                availableCounts: config.availableCounts, supportedFields: methodsOnly ? ['premises'] : quick
                  ? [...quickGoalFields, ...(!effectiveQuickLocks(session).includes('scoringMode') ? ['scoringMode'] : []), ...quickNumericFields.filter(field => !effectiveQuickLocks(session).includes(field)),
                    ...(editableQuickTypes(session) ? quickTypeFields : [])] : Object.keys(answerSchema.shape),
                ...(quick ? { lockedFields: effectiveQuickLocks(session), typeCountsEditable: editableQuickTypes(session),
                  typeCountSource: session.quickTypeCountSource ?? (session.answers.size === 'recommend' ? 'suggested' : 'manual_or_legacy') } : {}),
                ...(methodsOnly ? { premises: dependencies.methods.map(({ id, label, description }) => ({ id, label, description })),
                  methodDependencies: dependencies, foundation: config.courseContext.foundation } : {}),
              }, { signal, validate: candidate => {
                try { return validate(candidate); }
                catch (error) {
                  throw Object.assign(new Error(error.name === 'ZodError'
                    ? '组件默认值或选择项不符合对应字段合同。' : error.message), { code: 'invalid_model_output' });
                }
              } }); }
              catch (error) {
                if (!quick) throw error;
                // Basic teacher inputs survive an unexpected provider failure as well.
                result = { ok: false, error: { code: signal?.aborted ? 'cancelled' : 'model_error',
                  message: signal?.aborted ? '已取消模型整理，基本条件已保存。' : '模型整理失败，基本条件已保存，可按当前条件继续。' },
                  run: { status: signal?.aborted ? 'cancelled' : 'model_error' } };
              }
              session.llmRun = result.run;
              if (result.ok) {
                try { session.proposal = validate(result.proposal); }
                catch (error) { session.proposal = null; session.llmRun = { ...result.run, status: 'invalid_model_output',
                  validationIssue: { code: error.code ?? 'invalid_model_output', message: error.name === 'ZodError' ? '组件字段值不符合合同。' : error.message } };
                  session.assistantError = { code: 'invalid_model_output', message: '模型建议未通过目录与组件校验，未修改需求。' }; }
                if (session.proposal) delete session.assistantError;
              } else { session.proposal = null; session.assistantError = result.error; }
            } else if (input.action === 'answer') {
              let patch = input.answers ?? {};
              const previousMessage = session.assistantMessage ?? '';
              if (session.mode === 'quick' && input.acceptProposal && input.message !== undefined && input.message !== previousMessage) {
                fail('invalid_intake', '教师原话已修改，请重新整理后再采纳目标建议。');
              }
              if (input.acceptProposal) {
                if (!session.proposal) fail('invalid_intake', '没有待采纳的模型建议。');
                if (session.proposalKind === 'methods' && Object.keys(patch).some(field => field !== 'premises')) {
                  fail('invalid_intake', '采纳知识与方法建议时只能调整允许的方法；请先单独保存其他需求，再重新请求建议。');
                }
                patch = { ...session.proposal.changes, ...patch };
              }
              const previousAnswers = session.answers;
              session.answers = applyAnswers(session.answers, patch, config);
              if (session.mode === 'quick') {
                if (input.acceptProposal && quickTypeFields.some(field => session.proposal.changes[field] !== undefined)) session.quickTypeCountSource = 'model';
                rememberManualTypeCounts(session, input.answers);
              }
              if (session.mode === 'quick' && input.message !== undefined) session.assistantMessage = input.message;
              if (input.message !== undefined) session.teacherRequest = input.message;
              if (session.mode === 'quick' && !input.acceptProposal && session.proposal
                  && (JSON.stringify(previousAnswers) !== JSON.stringify(session.answers)
                    || previousMessage !== (session.assistantMessage ?? ''))) {
                session.proposal = null; session.proposalKind = null; delete session.assistantError;
              }
              if (session.proposalKind === 'methods' && !input.acceptProposal
                  && ['mainScope', 'learnedScope', 'premises'].some(field => JSON.stringify(previousAnswers[field]) !== JSON.stringify(session.answers[field]))) {
                session.proposal = null; session.proposalKind = null; delete session.assistantError;
              }
              const changedStages = Object.keys(fieldsByStage).filter(stage => fieldsByStage[stage].some(field => JSON.stringify(previousAnswers[field]) !== JSON.stringify(session.answers[field])));
              // Earlier decisions affect later planning. Changing scope must also re-confirm boundaries and goals.
              const firstChanged = Math.min(...changedStages.map(stage => stages.indexOf(stage)));
              session.confirmedStages = session.confirmedStages.filter(stage => session.editing
                ? !changedStages.some(changed => dependentStages[changed].includes(stage))
                : stages.indexOf(stage) < firstChanged);
              if (input.acceptProposal) { session.proposal = null; session.proposalKind = null; session.stage = session.mode === 'quick' ? 'review' : changedStages[0] ?? session.stage; }
              if (input.stage) session.stage = input.stage;
              if (input.next) {
                validateStep(session.stage, session.answers);
                if (!session.confirmedStages.includes(session.stage)) session.confirmedStages.push(session.stage);
                session.stage = session.mode === 'quick' ? 'review' : session.editing ? stages.find(stage => stage !== 'review' && !session.confirmedStages.includes(stage)) || 'review'
                  : stages[Math.min(stages.indexOf(session.stage) + 1, stages.length - 1)];
              }
            } else if (input.action === 'confirm') {
              if (input.answers || input.acceptProposal) fail('invalid_intake', '请先保存变更，再确认需求。');
              if (session.mode === 'quick' ? session.stage !== 'review' : stages.slice(0, -1).some(stage => !session.confirmedStages.includes(stage))) fail('incomplete_intake', '请先核对本次需求后确认。');
              validateStep('review', session.answers);
              session.status = 'confirmed'; session.stage = 'review'; session.confirmedAt = new Date().toISOString(); session.proposal = null; session.proposalKind = null;
            }
            session.revision += 1;
          }
          session.updatedAt = new Date().toISOString();
          if (session.mode === 'quick') session.progression = copy(config.progression);
          const output = present(session, config);
          if (session.status === 'confirmed') {
            session.requirements = copy(output.requirements);
            session.summary = copy(output.summary);
          }
          if (input.operationId) {
            session.operations[input.operationId] = { fingerprint, session: copy(output) };
            const keys = Object.keys(session.operations);
            if (keys.length > 100) delete session.operations[keys[0]];
          }
          await storage.put(session);
          return { ok: true, session: output };
        });
      } catch (error) { return errorResponse(error); }
    },
  };
}
