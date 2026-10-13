import { canonicalSectionId, includesSection } from '../curriculum/section-identity.mjs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getAssemblyConfig, loadPool, normalizeRequirements } from '../assembly/engine.mjs';
import { questionBankStorage } from '../storage/registry.mjs';
import { getQuestion } from './reader.mjs';
import { pedagogyForQuestion, readPedagogySeed } from './pedagogy.mjs';
import { questionSource } from './source-label.mjs';

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
  return { config: configured.config, pool, annotations, ready, repository: questionBankStorage(root) };
}

function publicQuestion(record, repository, manifest) {
  const question = record.result.question;
  const annotation = record.annotation;
  return {
    questionId: question.questionId,
    questionType: question.questionType,
    contentVersion: question.contentVersion,
    teacherVersion: question.teacherVersion,
    chapters: clone(annotation.primarySections),
    sectionIds: repository?.getQuestionSectionIds(question.questionId) ?? [],
    tasks: clone(annotation.tasks),
    taskSummary: record.entry.taskSummary,
    student: clone(question.student),
    topics: clone(question.scopeEvidence.primaryTopics),
    requiredKnowledge: clone(question.scopeEvidence.requiredKnowledge),
    difficulty: { level: ['easy', 'medium', 'hard'].includes(annotation.difficultyLevel) ? annotation.difficultyLevel : 'unknown',
      estimate: Number.isFinite(annotation.difficultyEstimate) ? annotation.difficultyEstimate : null },
    abilities: clone(record.pedagogy?.abilities ?? []),
    literacies: clone(record.pedagogy?.literacies ?? []),
    pedagogyStatus: record.pedagogy?.status ?? 'unknown',
    sourceRefs: clone(question.sourceRefs.map(({ sourceId, pages, locator }) => ({ sourceId, pages, locator }))),
    source: questionSource(question, manifest ?? repository?.getQuestionBankConfig('source_manifest')),
  };
}

function queryOptions(input) {
  const { sectionId = '', query = '', questionType = '', difficulty = '', ability = '', literacy = '', page, pageSize } = input;
  if (typeof query !== 'string' || query.length > 256 || typeof sectionId !== 'string' || sectionId.length > 160
      || !['', 'single_choice', 'fill_blank', 'free_response'].includes(questionType)
      || !['', 'unknown', 'easy', 'medium', 'hard'].includes(difficulty)
      || [ability, literacy].some(value => typeof value !== 'string' || value.length > 160)) reject('invalid_request', '题库筛选条件无效。');
  const paginated = page !== undefined || pageSize !== undefined || !!sectionId || !!query || !!questionType || !!difficulty || !!ability || !!literacy;
  const currentPage = page === undefined ? 1 : Number(page);
  const size = pageSize === undefined ? 12 : Number(pageSize);
  if (!Number.isSafeInteger(currentPage) || currentPage < 1 || currentPage > 100000
      || !Number.isSafeInteger(size) || size < 1 || size > 60) reject('invalid_request', '分页参数无效。');
  return { sectionId, query: query.trim(), questionType, difficulty, ability: ability.trim(), literacy: literacy.trim(), page: currentPage, pageSize: size, paginated };
}

const difficultyLevels = [['easy', '基础'], ['medium', '中等'], ['hard', '较难'], ['unknown', '未评估']];
const difficultySql = `CASE WHEN json_extract(a.value,'$.difficultyLevel') IN ('easy','medium','hard')
  THEN json_extract(a.value,'$.difficultyLevel') ELSE 'unknown' END`;
// Materialize each JSON snapshot once. Joining json_each virtual tables directly
// repeatedly scans and reparses all three arrays for every question and facet.
const snapshotCtes = `WITH
  annotation_rows AS MATERIALIZED (SELECT value, CAST(json_extract(value,'$.questionId') AS TEXT) AS question_id,
    CAST(json_extract(value,'$.contentVersion') AS TEXT) AS content_version, CAST(json_extract(value,'$.teacherVersion') AS TEXT) AS teacher_version
    FROM json_each((SELECT payload FROM question_bank_state WHERE kind='question_index'), '$.entries')),
  ledger_rows AS MATERIALIZED (SELECT value, CAST(json_extract(value,'$.questionId') AS TEXT) AS question_id
    FROM json_each((SELECT payload FROM question_bank_state WHERE kind='ledger'), '$.entries')),
  pedagogy_rows AS MATERIALIZED (SELECT value, CAST(json_extract(value,'$.questionId') AS TEXT) AS question_id,
    CAST(json_extract(value,'$.contentVersion') AS TEXT) AS content_version, CAST(json_extract(value,'$.teacherVersion') AS TEXT) AS teacher_version
    FROM json_each((SELECT payload FROM question_bank_pedagogy WHERE kind='analysis'), '$.entries'))`;

function publicFilterOptions(questions) {
  const tags = key => {
    const values = [...new Set(questions.flatMap(question => question[key]))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    return [...values.map(value => ({ value, label: value, count: questions.filter(question => question[key].includes(value)).length })),
      { value: 'unknown', label: '未标注', count: questions.filter(question => !question[key].length).length }];
  };
  return { difficulty: difficultyLevels.map(([value, label]) => ({ value, label,
    count: questions.filter(question => question.difficulty.level === value).length })), abilities: tags('abilities'), literacies: tags('literacies') };
}

function databaseFilterOptions(repository, from, baseConditions) {
  const where = `WHERE ${baseConditions.join(' AND ')}`;
  const rows = repository.database.prepare(`${snapshotCtes} SELECT ${difficultySql} AS level, count(*) AS count ${from} ${where} GROUP BY level`).all();
  const tags = key => {
    const tagged = repository.database.prepare(`${snapshotCtes} SELECT tag.value AS value, COUNT(DISTINCT q.question_id) AS count
      ${from} JOIN json_each(p.value,'$.${key}') tag ${where} GROUP BY tag.value ORDER BY tag.value`).all();
    const unknown = repository.database.prepare(`${snapshotCtes} SELECT count(*) AS count ${from} ${where}
      AND coalesce(json_array_length(p.value,'$.${key}'),0)=0`).get().count;
    return [...tagged.map(item => ({ ...item, label: item.value })), { value: 'unknown', label: '未标注', count: unknown }];
  };
  return { difficulty: difficultyLevels.map(([value, label]) => ({ value, label, count: rows.find(row => row.level === value)?.count ?? 0 })),
    abilities: tags('abilities'), literacies: tags('literacies') };
}

async function databaseCatalog(repository, root, options) {
  const sourceManifest = repository.getQuestionBankConfig('source_manifest');
  // SQL filters before materialising question bodies; placeholders keep teacher text literal.
  const from = `FROM question_bank_questions q
    JOIN annotation_rows a ON a.question_id=q.question_id
    JOIN ledger_rows e ON e.question_id=q.question_id
    LEFT JOIN pedagogy_rows p ON p.question_id=q.question_id
      AND p.content_version=q.content_version AND p.teacher_version=q.teacher_version`;
  const baseConditions = ["json_extract(e.value,'$.status')='ready'",
    "json_extract(a.value,'$.contentVersion')=q.content_version", "json_extract(a.value,'$.teacherVersion')=q.teacher_version"];
  const conditions = [...baseConditions];
  const parameters = [];
  if (options.sectionId) {
    conditions.push('EXISTS (SELECT 1 FROM question_section_mappings m WHERE m.question_id=q.question_id AND m.section_id=?)');
    parameters.push(canonicalSectionId(options.sectionId));
  }
  if (options.questionType) { conditions.push("json_extract(q.payload,'$.questionType')=?"); parameters.push(options.questionType); }
  if (options.difficulty) { conditions.push(`${difficultySql}=?`); parameters.push(options.difficulty); }
  for (const [key, value] of [['abilities', options.ability], ['literacies', options.literacy]]) {
    if (!value) continue;
    if (value === 'unknown') conditions.push(`coalesce(json_array_length(p.value,'$.${key}'),0)=0`);
    else { conditions.push(`EXISTS (SELECT 1 FROM json_each(p.value,'$.${key}') tag WHERE tag.value=?)`); parameters.push(value); }
  }
  if (options.query) {
    conditions.push(`instr(lower(q.question_id || ' ' || coalesce(json_extract(q.payload,'$.student'),'') || ' ' ||
      coalesce(json_extract(q.payload,'$.scopeEvidence'),'') || ' ' || coalesce(json_extract(e.value,'$.taskSummary'),'')), lower(?)) > 0`);
    parameters.push(options.query);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  // Verify the shared snapshots before querying their JSON fields.
  const ledger = repository.getQuestionBankLedger();
  const index = repository.getQuestionBankIndex();
  const pedagogy = repository.getQuestionBankPedagogy();
  if (!ledger || !index) reject('integrity_error', 'SQLite 题库索引缺失。');
  if (!pedagogy || !Array.isArray(pedagogy.entries)) reject('integrity_error', 'SQLite 教研标注快照缺失。');
  const total = repository.database.prepare(`${snapshotCtes} SELECT count(*) AS count ${from} ${where}`).get(...parameters).count;
  const pageSize = options.paginated ? options.pageSize : Math.max(1, total);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(options.page, totalPages);
  const rows = repository.database.prepare(`${snapshotCtes} SELECT q.question_id ${from} ${where} ORDER BY q.question_id LIMIT ? OFFSET ?`)
    .all(...parameters, pageSize, (page - 1) * pageSize);
  const entries = new Map(ledger.entries.map(entry => [entry.questionId, entry]));
  const annotations = new Map(index.entries.map(entry => [entry.questionId, entry]));
  const questions = await Promise.all(rows.map(async row => {
    const result = await getQuestion(row.question_id, { root });
    if (!result.ok) reject(result.error.code, result.error.message);
    return publicQuestion({ result, entry: entries.get(row.question_id), annotation: annotations.get(row.question_id),
      pedagogy: pedagogyForQuestion(pedagogy, result.question) }, repository, sourceManifest);
  }));
  const chapterCounts = new Map(repository.database.prepare(`${snapshotCtes}
    SELECT CASE s.value
      WHEN '1.1' THEN 'rja-compulsory-1:1.1' WHEN '1.2' THEN 'rja-compulsory-1:1.2'
      WHEN '1.3' THEN 'rja-compulsory-1:1.3' ELSE s.value END AS section_id,COUNT(DISTINCT q.question_id) AS count ${from}
    JOIN json_each(a.value,'$.primarySections') s WHERE ${baseConditions.join(' AND ')} GROUP BY section_id`)
    .all().map(row => [row.section_id, row.count]));
  const chapters = repository.getQuestionBankChapters().map(chapter => ({ ...chapter,
    questionCount: chapterCounts.get(canonicalSectionId(chapter.id)) ?? 0 }));
  const ready = ledger.entries.filter(entry => entry.status === 'ready').length;
  return { ok: true, chapters, textbooks: repository.getQuestionBankTextbooks(), questions,
    filterOptions: databaseFilterOptions(repository, from, baseConditions),
    pagination: { page, pageSize, total, totalPages },
    totals: { sourceUnits: ledger.entries.length, ready, pending: ledger.entries.length - ready },
    storage: 'sqlite', limits: { teacherContentIncluded: false,
      difficultyAvailable: index.entries.some(item => ['easy', 'medium', 'hard'].includes(item.difficultyLevel)),
      pedagogyLabelsAreSelectionEvidence: false } };
}

export async function listQuestionBankCatalog({ root = defaultRoot, ...input } = {}) {
  try {
    const options = queryOptions(input);
    const registered = questionBankStorage(root);
    if (registered) return await databaseCatalog(registered, root, options);
    const { config, pool, ready, repository } = await loadCatalog(root);
    const pedagogy = await readPedagogySeed(root);
    const allQuestions = ready.map(record => publicQuestion({ ...record, pedagogy: pedagogyForQuestion(pedagogy, record.result.question) }, repository, config.sourceManifest))
      .sort((a, b) => a.questionId.localeCompare(b.questionId));
    const matching = allQuestions.filter(question => (!options.sectionId || includesSection(question.chapters, options.sectionId))
      && (!options.questionType || question.questionType === options.questionType)
      && (!options.difficulty || question.difficulty.level === options.difficulty)
      && (!options.ability || (options.ability === 'unknown' ? !question.abilities.length : question.abilities.includes(options.ability)))
      && (!options.literacy || (options.literacy === 'unknown' ? !question.literacies.length : question.literacies.includes(options.literacy)))
      && (!options.query || JSON.stringify(question).toLowerCase().includes(options.query.toLowerCase())));
    const pageSize = options.paginated ? options.pageSize : Math.max(1, matching.length);
    const totalPages = Math.max(1, Math.ceil(matching.length / pageSize));
    const page = Math.min(options.page, totalPages);
    const questions = matching.slice((page - 1) * pageSize, page * pageSize);
    return { ok: true,
      chapters: config.chapters.map(chapter => ({ ...clone(chapter), questionCount: allQuestions.filter(item => includesSection(item.chapters, chapter.id)).length })),
      textbooks: repository?.getQuestionBankTextbooks() ?? [],
      questions,
      filterOptions: publicFilterOptions(allQuestions),
      pagination: { page, pageSize, total: matching.length, totalPages },
      totals: clone(pool.totals),
      limits: { teacherContentIncluded: false, difficultyAvailable: allQuestions.some(question => question.difficulty.level !== 'unknown'),
        pedagogyLabelsAreSelectionEvidence: false },
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
      .sort((a, b) => config.chapters.findIndex(item => includesSection([item.id], a)) - config.chapters.findIndex(item => includesSection([item.id], b)));
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
