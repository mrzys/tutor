import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { getAssemblyConfig, recheckBlueprint, loadPool, slotCandidates } from './engine.mjs';
import { assessDraftReplacementCandidates } from './editor.mjs';
import { suggestedGoalIds } from './teaching-goals.mjs';
import { readDraft } from './store.mjs';
import { hashContent } from '../question-bank/reader.mjs';
import { createAssistantGateway, assistantProposalSchema } from '../llm/assistant-gateway.mjs';

const defaultRoot = fileURLToPath(new URL('../../', import.meta.url));
const requestSchema = z.discriminatedUnion('stage', [
  z.strictObject({ stage: z.literal('blueprint'), message: z.string().trim().min(1).max(2000), blueprint: z.record(z.string(), z.unknown()) }),
  z.strictObject({ stage: z.literal('draft'), message: z.string().trim().min(1).max(2000), draftId: z.string().uuid(), expectedRevision: z.number().int().min(0) }),
]);
const invalid = message => { throw Object.assign(new Error(message), { code: 'invalid_model_output' }); };
const abort = signal => { if (signal?.aborted) throw Object.assign(new Error('已停止调整建议，当前内容未改变。'), { code: 'cancelled' }); };

function mentionedNumbers(message, slots) {
  if (/全卷|整卷|所有题|全部题|每一题/.test(message)) return new Set(slots.map(slot => slot.number));
  const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 零: 0 };
  const parse = value => /^\d+$/.test(value) ? Number(value) : value.includes('十')
    ? (digits[value.split('十')[0]] || 1) * 10 + (digits[value.split('十')[1]] || 0) : digits[value];
  const found = new Set();
  for (const match of message.matchAll(/第\s*([0-9一二三四五六七八九十零、，,和及到至\-—～~\s]+)\s*(?:题|道)/g)) {
    const expression = match[1].trim();
    const range = expression.match(/^([0-9一二三四五六七八九十零]+)\s*[到至\-—～~]\s*([0-9一二三四五六七八九十零]+)$/);
    if (range) { const start = parse(range[1]); const end = parse(range[2]); if (start <= end && end <= 60) for (let n = start; n <= end; n++) found.add(n); }
    else for (const token of expression.split(/[、，,和及\s]+/)) { const n = parse(token); if (n) found.add(n); }
  }
  if (/最后一(?:道)?题/.test(message)) found.add(slots.at(-1)?.number);
  return found;
}

function validateProposal(output, context) {
  let proposal;
  try { proposal = assistantProposalSchema.parse(output); } catch { invalid('调整提案结构无效。'); }
  const explicitNumbers = mentionedNumbers(context.message, context.slots);
  if (proposal.status === 'clarify') {
    if (proposal.actions.length || !proposal.clarification) invalid('需要澄清时不得混入动作，必须提供一个必要问题。');
    return proposal;
  }
  if (!proposal.actions.length || proposal.clarification !== null) invalid('待确认提案须有动作，不能混入未解决澄清。');
  const byNumber = new Map(context.slots.map(slot => [slot.number, slot]));
  const byTask = new Map(context.tasks.map(task => [task.taskId, task]));
  const additionsByTask = new Map();
  const touched = []; const deleted = new Set(); const unique = new Set(); const numberedActions = new Set();
  let count = context.slots.length; let supplyClarification = null;
  for (const action of proposal.actions) {
    if (unique.has(JSON.stringify(action))) invalid('动作不能重复。'); unique.add(JSON.stringify(action));
    if (context.stage === 'draft' && ['set_task', 'set_counts'].includes(action.type)) invalid('草稿不能用蓝图重规划动作覆盖当前题目。');
    if (context.stage === 'blueprint' && action.type === 'replace') invalid('蓝图尚无选入题目，不能换题。');
    if (action.numbers) {
      if (action.numbers.some(number => !explicitNumbers.has(number))) invalid('教师没有明确这些题号，必须澄清作用范围。');
      if (new Set(action.numbers).size !== action.numbers.length || action.numbers.some(number => !byNumber.has(number))) invalid('动作包含不存在或重复的题号。');
      for (const number of action.numbers) {
        const key = `${action.type}:${number}`;
        if (numberedActions.has(key)) invalid('同一题位的同类修改不能重复或互相覆盖。');
        numberedActions.add(key);
      }
      touched.push(...action.numbers.map(number => ({ number, type: action.type })));
    }
    if (action.taskId && !byTask.has(action.taskId)) invalid('任务身份未知或不在当前主考范围内。');
    if (action.type === 'set_task' && action.numbers.some(number => byNumber.get(number).questionType !== byTask.get(action.taskId).questionType)) invalid('更改任务需保持当前题型；改题型请明确题量规划。');
    if (action.type === 'replace' && context.stage === 'draft') {
      if (action.taskId && action.numbers.length !== 1) invalid('更换考查任务需逐题确认。');
      const blocked = action.numbers.filter(number => {
        const slot = byNumber.get(number); const supply = slot.replacementSupply;
        return action.taskId && action.taskId !== slot.taskId
          ? !supply?.sameKnowledgeTasks?.some(task => task.taskId === action.taskId && task.eligibleCount > 0)
          : !(supply?.sameTaskCount > 0);
      });
      if (blocked.length) {
        const alternatives = blocked.flatMap(number => (byNumber.get(number).replacementSupply?.sameKnowledgeTasks ?? []).map(task => `第 ${number} 题：${task.label}（${task.eligibleCount} 道）`));
        supplyClarification = { status: 'clarify', summary: '已预检当前试卷备选，现题保留。', actions: [],
          clarification: alternatives.length ? `当前要求下第 ${blocked.join('、')} 题没有同任务备选。可在相同知识范围内改为：${alternatives.join('；')}。是否调整考查任务？` : `当前要求下第 ${blocked.join('、')} 题暂无未重复的合格备选。请保留现题，或明确调整本题要求。` };
      }
    }
    if (action.type === 'delete') { action.numbers.forEach(number => deleted.add(number)); count -= action.numbers.length; }
    if (action.type === 'add') {
      if (action.afterNumber !== null && !explicitNumbers.has(action.afterNumber)) invalid('新增位置未明确，默认末尾或先澄清。');
      if (action.afterNumber !== null && !byNumber.has(action.afterNumber)) invalid('新增位置题号不存在。');
      const requested = (additionsByTask.get(action.taskId) ?? 0) + action.count; additionsByTask.set(action.taskId, requested);
      if (!(byTask.get(action.taskId).eligibleCount >= requested)) supplyClarification = { status: 'clarify', summary: '已预检新增题的真实供给，当前试卷未改变。', actions: [], clarification: `该任务目前只有 ${byTask.get(action.taskId).eligibleCount} 道合格未重复候选，无法新增 ${requested} 道。请减少数量或选择当前范围内其他任务。` };
      count += action.count;
    }
    if (action.type === 'set_counts') {
      if (proposal.actions.length > 1) invalid('完整题型配比调整需独立确认，不和局部动作混用。');
      count = Object.values(action.counts).reduce((a, b) => a + b, 0);
      for (const [type, amount] of Object.entries(action.counts)) if (amount && !context.tasks.some(task => task.questionType === type)) invalid('该题型在当前范围没有已登记任务。');
    }
    if (action.type === 'difficulty' && !new RegExp(`(?:^|[^0-9.])${String(action.targetDifficulty).replace('.', '\\.')}(?:$|[^0-9.])`).test(context.message)) invalid('教师未给出这个难度数值，不能推断精确系数。');
    if (action.type === 'allow_premise') {
      const premise = context.specialPremises.find(item => item.premiseId === action.premiseId);
      if (!premise) invalid('方法未知、已允许或已属于自动初中基础。');
      const name = premise.label.replace(/（.*?）|\(.*?\)/g, '').trim();
      if (!context.message.includes(name) || !/允许|同意|可以使用/.test(context.message) || /是否|能否|可不可以/.test(context.message)) invalid('特殊方法需教师明确提出允许使用，不能为了补题自动放开。');
    }
    // The existing replacement API cannot honor new semantic dimensions. Do not
    // permit an injected/misbehaving model to silently discard a clear request.
    if (action.type === 'replace' && (/能力|素养|认知|更难|简单|容易|降低难度|提高难度|难一点|难些|数学抽象|逻辑推理|数据分析|建模|分类讨论|证明|新解法|换个解法/.test(context.message) || (!action.taskId && /知识点|考查任务|考察任务/.test(context.message)))) invalid('新考查维度或未标定难度不能用同任务换题表达；请澄清考查要求。');
  }
  if (count < 1 || count > 60) invalid('调整后总题量需为1到60。');
  if (touched.some(item => deleted.has(item.number) && item.type !== 'delete')) invalid('删除题位不能同时执行其他修改。');
  if (proposal.actions.some(action => action.type === 'add' && deleted.has(action.afterNumber))) invalid('新增位置不能指向同时删除的题位。');
  if (supplyClarification) return supplyClarification;
  const taskChanges = proposal.actions.filter(action => action.type === 'replace' && action.taskId && action.taskId !== byNumber.get(action.numbers[0]).taskId);
  if (taskChanges.length && !proposal.summary.includes('考查任务将调整为：')) proposal.summary = `${proposal.summary.slice(0, 180)} 考查任务将调整为：${taskChanges.map(action => `第 ${action.numbers[0]} 题「${byTask.get(action.taskId).label.slice(0, 30)}」`).join('；')}。知识范围及原教学目标保留，待确认后应用。`;
  return proposal;
}

/** Pure model proposal: reads current content and validates identities, never executes writes. */
export async function proposeAssemblyAdjustment(raw, { root = defaultRoot, storeRoot, gateway = createAssistantGateway(), signal } = {}) {
  let llmRun;
  try {
    const input = requestSchema.parse(raw); abort(signal);
    const loaded = await getAssemblyConfig({ root }); if (!loaded.ok) return loaded;
    const config = loaded.config;
    let slots; let requirements; let base; let currentDraft;
    if (input.stage === 'blueprint') {
      const checked = await recheckBlueprint(input.blueprint, { root }); if (!checked.ok) return checked;
      slots = checked.blueprint.slots; requirements = checked.blueprint.requirements;
      base = { stage: 'blueprint', blueprintHash: hashContent(input.blueprint) };
    } else {
      const draft = await readDraft(storeRoot, input.draftId);
      if (draft.confirmedPaperId) return { ok: false, error: { code: 'finalized_draft', message: '请先从成卷派生新草稿，再调整题目。' } };
      if ((draft.revision ?? 0) !== input.expectedRevision) return { ok: false, error: { code: 'revision_conflict', message: '草稿已更新，请读取最新版本后重新提出调整。' } };
      currentDraft = draft; slots = draft.slots; requirements = draft.baseline.requirements;
      base = { stage: 'draft', draftId: draft.draftId, revision: draft.revision ?? 0 };
    }
    const pool = await loadPool(root); abort(signal);
    const occupiedIds = new Set(slots.flatMap(slot => slot.question ? [slot.question.questionId] : []));
    const occupiedGroups = new Set(pool.records.filter(item => occupiedIds.has(item.entry.questionId)).map(item => item.annotation?.duplicateGroup).filter(Boolean));
    const tasks = config.tasks.filter(task => task.sectionIds.length && task.sectionIds.every(id => requirements.mainScope.includes(id))).map(task => ({
      taskId: task.id, label: task.label, questionType: task.questionType,
      eligibleCount: slotCandidates(pool, { questionType: task.questionType, taskId: task.id, goalIds: suggestedGoalIds(requirements.teachingGoals ?? [], task) }, requirements, occupiedIds, occupiedGroups).filter(item => item.status === 'eligible').length,
    }));
    const context = { stage: input.stage, message: input.message, requirements,
      slots: slots.map(slot => ({ number: slot.number, slotId: slot.slotId, taskId: slot.taskId, taskLabel: slot.taskLabel, questionType: slot.questionType, points: slot.points, targetDifficulty: slot.targetDifficulty ?? requirements.targetDifficulty,
        ...(currentDraft ? { replacementSupply: (() => {
          const { sameTask, sameKnowledge } = assessDraftReplacementCandidates(currentDraft, slot, pool, config);
          return { sameTaskCount: sameTask.filter(item => item.canSelect && item.status === 'eligible').length,
            sameKnowledgeTasks: [...new Set(sameKnowledge.map(item => item.replacementTaskId))].map(taskId => ({ taskId, label: config.tasks.find(task => task.id === taskId).label, eligibleCount: sameKnowledge.filter(item => item.replacementTaskId === taskId).length })) };
        })() } : {}),
        ...(slot.question ? { questionId: slot.question.questionId, stem: slot.question.student.stem.slice(0, 1500) } : {}) })), tasks,
      specialPremises: config.premises.filter(item => !(requirements.foundationPremises ?? []).includes(item.id) && !requirements.premises.includes(item.id)).map(item => ({ premiseId: item.id, label: item.label, description: item.description })),
      constraints: { proposalOnly: true, actualDifficulty: 'unknown', replacementRetainsConfirmedScopeAndGoals: true, differentSolutionMethodsAllowed: true, maxQuestions: 60 } };
    const validate = output => validateProposal(output, context);
    const result = await gateway.propose(context, { signal, validate }); llmRun = result.run;
    if (!result.ok) return { ok: false, error: result.error, ...(llmRun ? { llmRun } : {}) };
    abort(signal);
    const proposal = validate(result.proposal);
    // Re-read revision after the model call; avoid presenting a ready proposal for
    // a concurrently changed draft. This still performs no writes.
    if (input.stage === 'draft') {
      const latest = await readDraft(storeRoot, input.draftId);
      if ((latest.revision ?? 0) !== input.expectedRevision || latest.confirmedPaperId) return { ok: false, error: { code: 'revision_conflict', message: '助手工作期间草稿已变化，请重新整理调整建议。' }, ...(llmRun ? { llmRun } : {}) };
    }
    return { ok: true, proposal, base, ...(llmRun ? { llmRun } : {}) };
  } catch (error) {
    const allowed = new Set(['invalid_model_output', 'cancelled', 'not_found', 'read_error', 'integrity_error']);
    return { ok: false, error: { code: error.name === 'ZodError' ? 'invalid_request' : allowed.has(error.code) ? error.code : 'assistant_error',
      message: error.name === 'ZodError' ? '对话调整请求或提案格式无效，当前内容未改变。' : allowed.has(error.code) ? error.message : '助手无法整理本次调整，当前内容未改变。' }, ...(llmRun ? { llmRun } : {}) };
  }
}
