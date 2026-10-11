import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getAssemblyConfig, loadPool, normalizeRequirements } from '../assembly/engine.mjs';

const defaultRoot = fileURLToPath(new URL('../../', import.meta.url));
const clone = value => structuredClone(value);

class CatalogError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const failure = error => ({ ok: false, error: { code: error.code ?? 'read_error', message: error.message } });
const reject = (code, message) => { throw new CatalogError(code, message); };

async function loadCatalog(root) {
  const [configured, pool] = await Promise.all([getAssemblyConfig({ root }), loadPool(root)]);
  if (!configured.ok) throw new CatalogError(configured.error.code, configured.error.message);
  const annotations = new Map(pool.questionIndexSnapshot.entries.map(item => [item.questionId, item]));
  const ready = pool.records.filter(item => item.result.ok && item.annotation);
  return { config: configured.config, pool, annotations, ready };
}

function publicQuestion(record) {
  const question = record.result.question;
  const annotation = record.annotation;
  return {
    questionId: question.questionId,
    questionType: question.questionType,
    contentVersion: question.contentVersion,
    teacherVersion: question.teacherVersion,
    chapters: clone(annotation.primarySections),
    tasks: clone(annotation.tasks),
    taskSummary: record.entry.taskSummary,
    student: clone(question.student),
    topics: clone(question.scopeEvidence.primaryTopics),
    requiredKnowledge: clone(question.scopeEvidence.requiredKnowledge),
    sourceRefs: clone(question.sourceRefs.map(({ sourceId, pages, locator }) => ({ sourceId, pages, locator }))),
  };
}

export async function listQuestionBankCatalog({ root = defaultRoot } = {}) {
  try {
    const { config, pool, ready } = await loadCatalog(root);
    const questions = ready.map(publicQuestion).sort((a, b) => a.questionId.localeCompare(b.questionId));
    return { ok: true,
      chapters: config.chapters.map(chapter => ({ ...clone(chapter), questionCount: questions.filter(item => item.chapters.includes(chapter.id)).length })),
      questions,
      totals: clone(pool.totals),
      limits: { teacherContentIncluded: false, difficultyAvailable: false },
    };
  } catch (error) { return failure(error); }
}

function manualSlot(record, task, number) {
  const question = clone(record.result.question);
  const annotation = record.annotation;
  return {
    slotId: `manual-${number}`,
    number,
    questionType: question.questionType,
    taskId: task.id,
    taskLabel: task.label,
    goalIds: [],
    points: 0,
    partPoints: question.student.parts.map(part => ({ partId: part.partId, points: 0 })),
    status: 'selected',
    question,
    selection: {
      candidates: [], failures: [], reasons: [], suggestions: [],
      selectedReason: {
        method: 'manual_question_bank',
        text: '由用户在题库中明确勾选，按勾选顺序直接写入草稿，未经过自动候选替换。',
        allowedSolutionPath: clone(annotation.solutionPaths[0]),
        goalSupport: [],
        notes: clone(annotation.notes ?? []),
      },
    },
  };
}

export async function createManualQuestionDraft(input, { root = defaultRoot } = {}) {
  try {
    const exactSelections = Array.isArray(input?.selections) ? input.selections : null;
    const selections = exactSelections ?? (Array.isArray(input?.questionIds) ? input.questionIds.map(questionId => ({ questionId })) : null);
    if (!selections) reject('invalid_request', '请选择要加入试卷的题目。');
    if (!selections.length || selections.length > 60
        || selections.some(item => !item || typeof item.questionId !== 'string')
        || new Set(selections.map(item => item.questionId)).size !== selections.length) {
      reject('invalid_request', '请选择 1～60 道不重复的题目。');
    }
    if (exactSelections && selections.some(item => typeof item.contentVersion !== 'string' || typeof item.teacherVersion !== 'string')) {
      reject('invalid_request', '手动组卷需要提供题面与解析的精确版本。');
    }
    if (input.title !== undefined && (typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 120)) {
      reject('invalid_request', '试卷标题需为 1～120 个字符。');
    }
    const { config, pool, ready } = await loadCatalog(root);
    const records = new Map(ready.map(record => [record.entry.questionId, record]));
    const selected = selections.map(selection => {
      const record = records.get(selection.questionId);
      if (!record) reject('invalid_request', `题目 ${selection.questionId} 当前不可用于组卷，请刷新题库后重试。`);
      if (exactSelections && (selection.contentVersion !== record.result.question.contentVersion
          || selection.teacherVersion !== record.result.question.teacherVersion)) {
        reject('version_conflict', `题目 ${selection.questionId} 已更新，请刷新题库并重新确认选择。`);
      }
      return record;
    });
    const duplicateGroups = selected.map(record => record.annotation.duplicateGroup);
    if (new Set(duplicateGroups).size !== duplicateGroups.length) {
      reject('invalid_request', '所选题目包含同一重复组，不能在同一份试卷中重复使用。');
    }
    const counts = { single_choice: 0, fill_blank: 0, free_response: 0 };
    selected.forEach(record => { counts[record.result.question.questionType]++; });
    const chapters = [...new Set(selected.flatMap(record => record.annotation.primarySections))]
      .sort((a, b) => config.chapters.findIndex(item => item.id === a) - config.chapters.findIndex(item => item.id === b));
    const requirements = normalizeRequirements({ ...config.defaultRequirements,
      title: input.title?.trim() || '题库手动组卷', scoringMode: 'none', targetScore: 0,
      goal: '由用户从题库中手动选择题目组成试卷。', teacherRequest: '从题库手动选择；不执行自动候选替换。',
      counts, mainScope: chapters, learnedScope: chapters, teachingGoals: [],
    }, config, config.sources.map(item => item.sourceId));
    const slots = selected.map((record, index) => {
      const task = record.annotation.tasks.map(id => config.tasks.find(item => item.id === id))
        .find(item => item?.questionType === record.result.question.questionType);
      if (!task) reject('config_error', `题目 ${record.entry.questionId} 缺少可用的考查任务映射。`);
      return manualSlot(record, task, index + 1);
    });
    const baselineSlots = slots.map(({ question, selection, status, ...slot }) => clone(slot));
    const now = new Date().toISOString();
    const draft = {
      schemaVersion: 1, draftId: randomUUID(), createdAt: now, title: requirements.title,
      baseline: {
        requirements: clone(requirements), slots: baselineSlots, confirmedAt: now, version: 1,
        generation: { mode: 'manual_question_bank', label: '题库手动选题' },
        courseContext: clone(config.courseContext), sourceManifest: clone(config.sourceManifest),
        taskCatalogSnapshot: clone({ catalogId: config.catalogId, chapters: config.chapters, premises: config.premises, tasks: config.tasks }),
        questionIndexSnapshot: clone(pool.questionIndexSnapshot),
      },
      slots,
      stats: { plannedQuestions: slots.length, selectedQuestions: slots.length, plannedPoints: 0, availablePoints: 0, missingQuestions: 0, difficultyEstimate: null },
      differences: [{ code: 'difficulty_unknown', message: '现有题包没有独立难度估计，实际整卷难度保持未知。' }],
      retrieval: { ...clone(pool.totals), pendingCount: pool.pending.length, pending: clone(pool.pending), failures: clone(pool.failures),
        mode: 'manual_question_bank', conditions: clone(requirements), candidateOrder: 'user_selected_order', noAutomaticRelaxation: true },
    };
    return { ok: true, draft };
  } catch (error) { return failure(error); }
}
