import { includesSection } from '../curriculum/section-identity.mjs';
import { randomUUID } from 'node:crypto';
import { currentUser } from '../auth/access.mjs';
import { hashContent } from './integrity.mjs';
import { validateSolutionDependencies } from './dependencies.mjs';

const reject = (code, message, status = 400) => { throw Object.assign(new Error(message), { code, status }); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const unique = values => [...new Set(values)];
const fingerprint = student => hashContent({ stem: student.stem.replace(/\s+/gu, ''),
  options: student.options.map(({ label, text: value }) => ({ label, text: value.replace(/\s+/gu, '') })),
  parts: student.parts.map(({ partId, prompt }) => ({ partId, prompt: prompt.replace(/\s+/gu, '') })) });
const blockedIssues = new Set(['source_page_missing', 'answer_missing', 'solution_missing', 'options_incomplete',
  'unexpected_options', 'parts_missing', 'part_alignment_error', 'teacher_content_not_explicit',
  'source_visual_unresolved', 'source_table_unresolved']);

function writeSnapshot(db, table, kind, value, now) {
  db.prepare(`INSERT INTO ${table}(kind,payload,sha256,synced_at) VALUES(?,?,?,?)
    ON CONFLICT(kind) DO UPDATE SET payload=excluded.payload,sha256=excluded.sha256,synced_at=excluded.synced_at`)
    .run(kind, JSON.stringify(value), hashContent(value), now);
}

/** Publishing is an explicit administrator review, separate from immutable AI staging. */
export function publishQuestionImport(repository, importId, input) {
  const user = currentUser();
  if (!user || user.role !== 'admin') reject('administrator_required', '只有管理员可审核入库。', 403);
  if (!repository?.database) reject('database_required', '审核入库需要 SQLite 题库。', 503);
  if (!input || !text(input.sourceSha256) || !Array.isArray(input.questions) || !input.questions.length
      || input.questions.length > 60 || input.questions.some(item => !text(item?.stagingQuestionId))
      || new Set(input.questions.map(item => item.stagingQuestionId)).size !== input.questions.length) {
    reject('invalid_review', '请提供源文件版本与 1～60 个不重复的逐题审核记录。');
  }
  const review = input.review;
  const corpusSample = review?.sampleScope === 'corpus';
  if (!review || !['individual', 'source_comparison_and_sample'].includes(review.method)
      || !text(review.basis) || review.samplePassed !== true || !Array.isArray(review.sampleQuestionIds)
      || (!corpusSample && !review.sampleQuestionIds.length)
      || new Set(review.sampleQuestionIds).size !== review.sampleQuestionIds.length
      || review.sampleQuestionIds.some(id => !input.questions.some(item => item.stagingQuestionId === id))) {
    reject('review_required', '需要明确来源比对依据及通过的抽样或逐题复核记录。');
  }
  if (review.sampleScope !== undefined && !['batch', 'corpus'].includes(review.sampleScope)) reject('review_required', '抽样范围只能是本批或完整语料。');
  if (corpusSample) {
    const evidence = review.sampleEvidence;
    const sha = /^[a-f0-9]{64}$/;
    if (review.method !== 'source_comparison_and_sample' || !evidence
        || !sha.test(evidence.corpusSha256 ?? '') || !sha.test(evidence.reviewSha256 ?? '')
        || !Number.isSafeInteger(evidence.sampleSize) || evidence.sampleSize < 1 || evidence.sampleSize > 100000
        || !Array.isArray(evidence.sourceQuestionIds) || evidence.sourceQuestionIds.length !== evidence.sampleSize
        || evidence.sourceQuestionIds.some(id => !text(id))
        || new Set(evidence.sourceQuestionIds).size !== evidence.sampleSize) {
      reject('corpus_sample_evidence_required', '跨批抽样需要完整语料及复核报告 SHA-256、实际样本数与不重复的来源题号。');
    }
    if (review.sampleQuestionIds.some(id => {
      const item = input.questions.find(question => question.stagingQuestionId === id);
      return !text(item?.origin?.sourceQuestionId) || !evidence.sourceQuestionIds.includes(item.origin.sourceQuestionId);
    })) reject('sample_identity_mismatch', '本批独立复核题必须能对应跨批抽样证据中的来源题号。');
  }
  if (review.method === 'individual' && input.questions.some(item => !review.sampleQuestionIds.includes(item.stagingQuestionId))) {
    reject('review_required', '逐题独立复核方式需列出全部审核题号。');
  }
  const requestHash = hashContent(input);
  const db = repository.database;
  return db.transaction(() => {
    const record = repository.getQuestionImport(importId);
    if (!record) reject('not_found', '未找到该试卷导入记录。', 404);
    if (record.source.sha256 !== input.sourceSha256) reject('version_conflict', '审核源文件版本与暂存记录不一致。', 409);
    const replay = db.prepare('SELECT payload,sha256 FROM question_import_publications WHERE import_id=? AND request_sha256=?').get(importId, requestHash);
    if (replay) {
      const value = JSON.parse(replay.payload);
      if (hashContent(value) !== replay.sha256) reject('integrity_error', '发布审核记录校验失败。', 500);
      return { ok: true, publication: value, replayed: true };
    }
    const now = new Date().toISOString();
    const publicationId = randomUUID();
    const ledger = repository.getQuestionBankLedger();
    const index = repository.getQuestionBankIndex();
    const config = repository.getQuestionBankConfig('task_catalog');
    const manifest = repository.getQuestionBankConfig('source_manifest');
    const pedagogy = repository.getQuestionBankPedagogy();
    if (![ledger, index, config, manifest, pedagogy].every(Boolean)) reject('integrity_error', '正式题库快照缺失。', 500);
    const sections = new Map(repository.getQuestionBankTextbooks().flatMap(book => book.chapters.flatMap(chapter => chapter.sections)).map(section => [section.id, section]));
    const sourceId = `import-${importId}`;
    const sourceRef = question => ({ sourceId, pages: question.pages, locator: question.sourceLabel });
    const existingFingerprints = new Map(db.prepare('SELECT question_id FROM question_bank_questions').all().map(row => {
      const question = repository.getQuestionBankQuestion(row.question_id);
      return [fingerprint(question.student), question.questionId];
    }));
    const publication = { schemaVersion: 1, publicationId, importId, sourceSha256: input.sourceSha256,
      createdAt: now, reviewer: { userId: user.userId, role: user.role }, review, questionReviews: structuredClone(input.questions),
      reviewMeaning: corpusSample
        ? '逐题 checks 核对上传文档的一致性；独立数学复核为整个语料的分层抽样，样本身份及证据版本见 sampleEvidence；本批仅 sampleQuestionIds 对应题标为 sample_reviewed，其余题只作来源比对。不认证所有参考答案为原卷官方答案。'
        : '逐题 checks 核对上传文档的一致性；独立数学复核仅覆盖本批 sampleQuestionIds，不认证所有参考答案为原卷官方答案。',
      llmRun: record.llmRun, accepted: [], duplicates: [], rejected: [] };
    const items = [];
    let nextChapterPosition = db.prepare('SELECT coalesce(max(position),-1)+1 AS position FROM question_bank_chapters').get().position;
    const canonicalScope = id => {
      const section = sections.get(id);
      // Existing curated 1.1–1.3 aliases are retained; every new section uses its real textbook UID.
      const legacy = repository.getQuestionBankChapters().find(chapter => chapter.id === section.number && chapter.label === section.label);
      return legacy?.id ?? id;
    };
    for (const item of input.questions) {
      const question = record.questions.find(value => value.stagingQuestionId === item.stagingQuestionId);
      try {
        if (!question) reject('unknown_staging_question', '审核题号不存在。');
        if (!text(item.basis) || ['sourceMatched', 'answerChecked', 'solutionChecked', 'formulaChecked'].some(key => item.checks?.[key] !== true)) {
          reject('review_incomplete', '题面、答案、解析、公式均需明确复核通过并记录依据。');
        }
        const teacherProvenance = item.teacherProvenance ?? 'source';
        if (!['source', 'source_adapted', 'proposed', 'generated'].includes(teacherProvenance)) reject('invalid_provenance', '参考答案来源类型无效。');
        const blockers = question.reviewIssues.filter(issue => blockedIssues.has(issue.code));
        if (blockers.length) reject('content_blocked', blockers.map(issue => issue.message).join('；'));
        if (new Set(question.student.options.map(option => option.label)).size !== question.student.options.length
            || new Set(question.student.parts.map(part => part.partId)).size !== question.student.parts.length) {
          reject('duplicate_student_identity', '选项标签或小问身份重复。');
        }
        if (question.questionType === 'free_response'
            && question.student.parts.some(part => !question.teacher.answers.some(answer => answer.partId === part.partId)
              || !question.teacher.solutions.some(solution => solution.partId === part.partId))) {
          reject('incomplete_part_solution', '解答题需要覆盖每个小问的参考答案和完整解析。');
        }
        if (!text(question.dimensions.allowedSolution) || !question.teacher.answers.length || !question.teacher.solutions.length
            || [...question.teacher.answers, ...question.teacher.solutions].some(value => value.sourceBasis !== 'explicit')) {
          reject('solution_evidence_missing', '缺少完整允许解法或原文明确答案、解析。');
        }
        if (!Array.isArray(item.sectionIds) || !item.sectionIds.length || item.sectionIds.some(id => !sections.has(id))
            || new Set(item.sectionIds).size !== item.sectionIds.length) reject('section_unresolved', '主考范围需绑定真实教材小节身份。');
        const requiredSections = item.requiredSectionIds ?? item.sectionIds;
        if (!Array.isArray(requiredSections) || !requiredSections.length || requiredSections.some(id => !sections.has(id))) reject('section_unresolved', '解法依赖小节身份无效。');
        const dependencyGuard = validateSolutionDependencies([question.dimensions.allowedSolution,
          ...question.teacher.solutions.map(solution => solution.text)].join('\n'), [...sections.values()], requiredSections);
        if (!dependencyGuard.ok) reject('solution_dependency_missing', `完整解法的显式知识依赖尚未映射：${[
          ...dependencyGuard.missingSectionIds, ...dependencyGuard.unmapped.map(value => value.title)].join('、')}。`);
        const requiredPremises = item.requiredPremises ?? [];
        if (!Array.isArray(requiredPremises) || requiredPremises.some(id => !config.premises.some(value => value.id === id))) reject('premise_unresolved', '解法前提未匹配当前配置。');
        const knowledgeUids = item.knowledgePointUids ?? question.dimensions.knowledgePoints.filter(value => value.suggestedUid).map(value => value.suggestedUid);
        if (!Array.isArray(knowledgeUids) || knowledgeUids.some(uid => !db.prepare('SELECT 1 FROM knowledge_points WHERE knowledge_uid=?').get(uid))) reject('knowledge_unresolved', '知识点 UID 不存在。');
        const duplicate = db.prepare('SELECT question_id FROM question_import_published_items WHERE import_id=? AND staging_question_id=?').get(importId, item.stagingQuestionId);
        const student = { ...question.student, assets: [] };
        const contentFingerprint = fingerprint(student);
        const duplicateId = duplicate?.question_id ?? existingFingerprints.get(contentFingerprint);
        if (duplicateId) {
          const existing = repository.getQuestionBankQuestion(duplicateId) ?? items.find(value => value.published.questionId === duplicateId)?.published;
          const answersFingerprint = answers => hashContent(answers.map(value => ({ partId: value.partId, text: value.text.replace(/\s+/gu, '') })));
          if (!existing || answersFingerprint(existing.teacher.answers) !== answersFingerprint(question.teacher.answers)) {
            reject('duplicate_answer_conflict', '相同题面已有不同参考答案，请先复核冲突。');
          }
          publication.duplicates.push({ stagingQuestionId: item.stagingQuestionId, questionId: duplicateId, reason: '相同规范化题干、选项、小问及参考答案已入库。' }); continue;
        }
        if (!question.pages.length || question.pages.some(page => !Number.isInteger(page) || page < 1 || page > record.source.pageCount)) reject('source_page_invalid', '来源页码超出文件范围。');
        const primarySections = unique(item.sectionIds.map(canonicalScope));
        let task = item.taskId ? config.tasks.find(value => value.id === item.taskId && value.questionType === question.questionType) : null;
        if (item.taskId && !task) reject('task_unresolved', '已有考查任务身份或题型不匹配。');
        if (!task && !text(item.taskLabel)) reject('task_unresolved', '请明确本题可观察考查任务，不能伪造已有任务身份。');
        if (!task) {
          const label = item.taskLabel.trim();
          if (label.length > 160) reject('task_unresolved', '考查任务标签过长。');
          const taskId = `import-task-${hashContent({ label, type: question.questionType, primarySections, partIds: student.parts.map(value => value.partId) }).slice(0, 20)}`;
          task = config.tasks.find(value => value.id === taskId) ?? { id: taskId, label, questionType: question.questionType,
            sectionIds: primarySections, partIds: student.parts.map(value => value.partId), partWeights: student.parts.map(() => 1),
            provenance: 'reviewed_import', importId, reviewBasis: item.basis };
        }
        if (task.sectionIds.some(id => !includesSection(primarySections, id))) reject('task_scope_mismatch', '已有任务的范围与复核主考小节不匹配。');
        if (question.questionType === 'free_response' && hashContent(task.partIds ?? []) !== hashContent(student.parts.map(part => part.partId))) {
          reject('task_part_mismatch', '已有任务的小问结构与本题不匹配。');
        }
        const id = contentFingerprint.slice(0, 24);
        const questionId = `tutor-import-${id}`;
        const teacher = { answers: question.teacher.answers.map(({ partId, text: value }) => ({ partId, text: value, provenance: teacherProvenance, sourceRefs: [sourceRef(question)] })),
          solutions: question.teacher.solutions.map(({ partId, text: value }) => ({ partId, text: value, provenance: teacherProvenance, sourceRefs: [sourceRef(question)] })), scoringSuggestions: [] };
        const contentSha256 = hashContent(student), teacherSha256 = hashContent(teacher);
        const versions = { contentVersion: `content-${contentSha256.slice(0, 16)}`, teacherVersion: `teacher-${teacherSha256.slice(0, 16)}` };
        const published = { schemaVersion: 1, questionId, auditId: `IMPORT-SRC-${id}`, questionType: question.questionType,
          student, teacher, ...versions, contentSha256, teacherSha256, sourceRefs: [sourceRef(question)],
          scopeEvidence: { ...versions, status: 'within', primaryTopics: question.dimensions.primaryTopics,
            requiredKnowledge: question.dimensions.requiredKnowledge, allowedSolution: question.dimensions.allowedSolution,
            courseBasis: `reviewed-import:${importId}` },
          verification: { ...versions, result: 'pass', method: review.method, checkedBy: user.userId, checkedOn: now,
            checkedSourcePages: [sourceRef(question)], differences: [], reviewBasis: item.basis, publicationId,
            origin: item.origin ?? null, teacherProvenance, reviewMeaning: publication.reviewMeaning,
            reviewCoverage: review.sampleQuestionIds.includes(item.stagingQuestionId) ? 'sample_reviewed' : 'source_comparison' } };
        const suggestion = question.dimensions.difficultySuggestion;
        if (suggestion.level !== 'unknown' && !text(suggestion.rationale)) reject('difficulty_basis_missing', 'LLM 难度分档缺少内容判断依据。');
        const difficultyLevel = { foundation: 'easy', standard: 'medium', challenge: 'hard' }[suggestion.level] ?? 'unknown';
        const difficultyBasis = { method: 'llm_estimate', empirical: false, level: suggestion.level,
          rationale: suggestion.rationale, llmRun: record.llmRun, reviewedBy: user.userId, publicationId };
        const annotation = { questionId, ...versions, tasks: [task.id], primarySections, dependencyGuard,
          solutionPaths: [{ id: 'reviewed-import-path', requiredSections: unique(requiredSections.map(canonicalScope)), requiredPremises,
            basis: question.dimensions.allowedSolution, provenance: 'reviewed_import' }],
          duplicateGroup: `content-${contentFingerprint}`, difficultyLevel, difficultyEstimate: null, difficultyBasis,
          basis: { sourceRefs: [sourceRef(question)], scopeEvidenceStatus: 'within', publicationId }, notes: ['难度为 LLM 内容估计，未经学生作答实测。'] };
        items.push({ item, published, annotation, knowledgeUids, task });
        existingFingerprints.set(contentFingerprint, questionId);
        publication.accepted.push({ stagingQuestionId: item.stagingQuestionId, questionId, ...versions, difficultyLevel });
      } catch (cause) { publication.rejected.push({ stagingQuestionId: item.stagingQuestionId, code: cause.code ?? 'invalid_review', message: cause.message }); }
    }
    if (publication.rejected.some(item => review.sampleQuestionIds.includes(item.stagingQuestionId))) {
      reject('sample_review_failed', `抽样复核题仍有未解决的关键问题，本批次不能入库：${publication.rejected
        .filter(item => review.sampleQuestionIds.includes(item.stagingQuestionId)).map(item => item.message).join('；')}`, 409);
    }
    // Rejected questions stay staged; only validated records enter all snapshots in one transaction.
    for (const { item, published, annotation, knowledgeUids, task } of items) {
      if (!config.tasks.some(value => value.id === task.id)) config.tasks.push(task);
      db.prepare('INSERT INTO question_bank_questions VALUES(?,?,?,?,?,?)').run(published.questionId, JSON.stringify(published), hashContent(published), published.contentVersion, published.teacherVersion, now);
      ledger.entries.push({ questionId: published.questionId, auditId: published.auditId, questionType: published.questionType,
        status: 'ready', contentPath: `imports/${published.questionId}.json`, contentVersion: published.contentVersion,
        teacherVersion: published.teacherVersion, pendingReasons: [], taskSummary: task.label });
      index.entries.push(annotation);
      pedagogy.entries.push({ questionId: published.questionId, contentVersion: published.contentVersion, teacherVersion: published.teacherVersion,
        abilities: questionFor(record, item).dimensions.abilities, literacies: questionFor(record, item).dimensions.literacies,
        status: 'pending_review', evidence: { source: 'llm_import', importId, publicationId } });
      unique([...item.sectionIds, ...(item.requiredSectionIds ?? [])]).forEach(sectionId => {
        const scopeId = canonicalScope(sectionId);
        if (!db.prepare('SELECT 1 FROM question_bank_chapters WHERE chapter_id=?').get(scopeId)) {
          const section = sections.get(sectionId);
          const payload = { id: scopeId, label: section.label, textbookSectionId: sectionId };
          db.prepare('INSERT INTO question_bank_chapters VALUES(?,?,?,?,?)').run(scopeId, nextChapterPosition++, JSON.stringify(payload), hashContent(payload), now);
        }
      });
      item.sectionIds.forEach((sectionId, position) => db.prepare('INSERT INTO question_section_mappings VALUES(?,?,?,?)')
        .run(published.questionId, sectionId, canonicalScope(sectionId), position));
      for (const uid of unique(knowledgeUids)) {
        const point = db.prepare('SELECT name FROM knowledge_points WHERE knowledge_uid=?').get(uid);
        const payload = { uid, status: 'reviewed_import_mapping', basis: item.basis, publicationId };
        db.prepare('INSERT INTO question_knowledge_mappings VALUES(?,?,?,?,?,?,?,?)').run(published.questionId, uid, point.name, payload.status, item.basis, JSON.stringify(payload), hashContent(payload), now);
      }
    }
    if (items.length) {
      config.defaultRequirements.sourceIds = unique([...(config.defaultRequirements.sourceIds ?? []), sourceId]);
      if (!manifest.sources.some(source => source.sourceId === sourceId)) manifest.sources.push({ sourceId, role: 'reviewed_import',
        label: record.title, path: `imports/${importId}${record.source.extension}`, sha256: record.source.sha256, physicalPages: record.source.pageCount });
      writeSnapshot(db, 'question_bank_state', 'ledger', ledger, now);
      writeSnapshot(db, 'question_bank_state', 'question_index', index, now);
      writeSnapshot(db, 'question_bank_config', 'task_catalog', config, now);
      writeSnapshot(db, 'question_bank_config', 'source_manifest', manifest, now);
      writeSnapshot(db, 'question_bank_pedagogy', 'analysis', pedagogy, now);
    }
    db.prepare('INSERT INTO question_import_publications VALUES(?,?,?,?,?,?,?)').run(publicationId, importId, requestHash, user.userId, JSON.stringify(publication), hashContent(publication), now);
    for (const { item, published } of items) db.prepare('INSERT INTO question_import_published_items VALUES(?,?,?,?)').run(importId, item.stagingQuestionId, published.questionId, publicationId);
    return { ok: true, publication, replayed: false };
  }).immediate();
}

const questionFor = (record, item) => record.questions.find(value => value.stagingQuestionId === item.stagingQuestionId);
