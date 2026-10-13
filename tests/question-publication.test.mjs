import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { registerSqliteStorage } from '../src/storage/sqlite.mjs';
import { createQuestionImportService } from '../src/question-bank/imports.mjs';
import { installUserAccess } from '../src/auth/access.mjs';
import { getQuestion } from '../src/question-bank/reader.mjs';
import { getAssemblyConfig, loadPool, slotCandidates, normalizeRequirements } from '../src/assembly/engine.mjs';
import { createManualQuestionDraft, listQuestionBankCatalog } from '../src/question-bank/catalog.mjs';
import { createNestApp } from '../src/api/app.ts';
import { hashContent } from '../src/question-bank/integrity.mjs';
import { canonicalSectionId, includesSection } from '../src/curriculum/section-identity.mjs';
import { planBlueprint } from '../src/assembly/planner.mjs';
import { createIntakeService } from '../src/intake/service.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const checks = { sourceMatched: true, answerChecked: true, solutionChecked: true, formulaChecked: true };
const sample = { method: 'source_comparison_and_sample', basis: 'fixture source compared; first item independently solved', sampleQuestionIds: ['staged-001'], samplePassed: true };
const question = {
  sourceLabel: '练习1', pages: [1], questionType: 'single_choice',
  student: { stem: '发布测试：不等式 $x^2>4$ 的解集为（ ）', options: [{ label: 'A', text: '$(-2,2)$' }, { label: 'B', text: '$(-\\infty,-2)\\cup(2,+\\infty)$' }], parts: [] },
  teacher: { answers: [{ partId: 'main', text: 'B', sourceBasis: 'explicit' }], solutions: [{ partId: 'main', text: '移项因式分解，乘积大于零，得选项 B。', sourceBasis: 'explicit' }] },
  dimensions: { chapterCandidates: ['rja-compulsory-1:2.3'], taskCandidates: [], primaryTopics: ['一元二次不等式'], requiredKnowledge: ['因式分解与符号判断'],
    knowledgePoints: [], allowedSolution: '将 x²−4 分解为 (x−2)(x+2)，两因式同号得到 x<−2 或 x>2。', cognition: 'apply', abilities: ['因式符号判断'], literacies: ['数学运算'], difficultySuggestion: { level: 'standard', rationale: '需要因式分解并作符号判断，属于常规两步运用。' } },
};

async function setup(t, importedQuestion = question) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'tutor-publication-'));
  const storage = await registerSqliteStorage(base, undefined, { questionBankRoot: root });
  t.after(async () => { storage.close(); await rm(base, { recursive: true, force: true }); });
  const { repository } = storage;
  const access = installUserAccess(repository);
  const admin = { userId: 'publication-admin', role: 'admin' }, teacher = { userId: 'publication-teacher', role: 'teacher' };
  for (const user of [admin, teacher]) repository.database.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(user.userId, `${user.userId}@example.test`, 'test', 'test', user.role, new Date().toISOString());
  const service = createQuestionImportService({ root, storeRoot: path.join(base, 'question-imports'), gateway: {
    publicStatus: () => ({ configured: true }), propose: async () => ({ ok: true, proposal: { title: '第二章试卷', questions: [structuredClone(importedQuestion), { ...structuredClone(question), sourceLabel: '练习2', student: { ...question.student, stem: '另题不完整解析' }, teacher: { answers: question.teacher.answers, solutions: [] } }] }, run: { model: 'fixture-deepseek', status: 'succeeded' } }),
  } });
  const request = Readable.from([Buffer.from(JSON.stringify({ filename: 'paper.txt', mimeType: 'text/plain', text: '不等式 x²>4，答案B，解析为因式分解。' }))]);
  request.headers = { 'content-type': 'application/json' };
  const result = await access.run(admin, () => service.create(request));
  assert.equal(result.ok, true);
  const record = result.import;
  const input = { sourceSha256: record.source.sha256, review: sample, questions: [
    { stagingQuestionId: 'staged-001', sectionIds: ['rja-compulsory-1:2.3'], taskLabel: '因式分解求一元二次不等式解集', checks, basis: '逐字段与上传文档一致，抽样独立解答得B。', teacherProvenance: 'generated', origin: { sourceQuestionId: 'legacy-42', sourceVersion: 'v1', answerSource: 'legacy_ai_generated' } },
    { stagingQuestionId: 'staged-002', sectionIds: ['rja-compulsory-1:2.3'], taskLabel: '不应入库', checks, basis: '缺解析，应拒绝。' },
  ] };
  return { service, record, input, access, admin, teacher, repository };
}

test('reviewed imports publish atomically into SQL retrieval, curriculum and automatic/manual assembly, retaining model estimates and source provenance', async t => {
  const { service, record, input, access, admin, teacher, repository } = await setup(t);
  assert.throws(() => service.publish(record.importId, input), error => error.status === 403);
  assert.throws(() => access.run(teacher, () => service.publish(record.importId, input)), error => error.status === 403);
  assert.throws(() => access.run(admin, () => service.publish(record.importId, { ...input, sourceSha256: 'stale' })), error => error.code === 'version_conflict');
  const result = access.run(admin, () => service.publish(record.importId, input));
  assert.equal(result.ok, true);
  assert.equal(result.publication.accepted.length, 1);
  assert.equal(result.publication.rejected[0].code, 'content_blocked');
  const id = result.publication.accepted[0].questionId;
  const read = await getQuestion(id, { root });
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.equal(read.question.teacher.answers[0].provenance, 'generated');
  assert.equal(read.question.verification.origin.sourceQuestionId, 'legacy-42');
  assert.equal(read.question.verification.reviewCoverage, 'sample_reviewed');
  const catalog = await listQuestionBankCatalog({ root, sectionId: 'rja-compulsory-1:2.3', difficulty: 'medium', ability: '因式符号判断', literacy: '数学运算' });
  assert.equal(catalog.ok, true, JSON.stringify(catalog));
  assert.deepEqual(catalog.questions.map(value => value.questionId), [id]);
  assert.equal(catalog.questions[0].pedagogyStatus, 'pending_review');
  assert.equal(catalog.questions[0].difficulty.estimate, null);
  assert.equal(catalog.textbooks[0].chapters[1].sections.find(value => value.id === 'rja-compulsory-1:2.3').questionCount, 1);
  const config = (await getAssemblyConfig({ root })).config;
  const task = config.tasks.find(value => value.label === input.questions[0].taskLabel);
  assert.equal(task.provenance, 'reviewed_import');
  assert.ok(config.chapters.some(value => value.id === 'rja-compulsory-1:2.3' && value.textbookSectionId));
  const requirements = normalizeRequirements({ ...config.defaultRequirements, mainScope: ['rja-compulsory-1:2.3'], learnedScope: ['rja-compulsory-1:2.3'], sourceIds: config.sources.map(value => value.sourceId), teachingGoals: [] }, config, config.sources.map(value => value.sourceId));
  const pool = await loadPool(root);
  assert.equal(slotCandidates(pool, { taskId: task.id, questionType: 'single_choice', goalIds: [] }, requirements).find(value => value.questionId === id).status, 'eligible');
  const draft = await createManualQuestionDraft({ questionIds: [id] }, { root });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  const annotation = repository.getQuestionBankIndex().entries.find(value => value.questionId === id);
  assert.equal(annotation.difficultyBasis.empirical, false);
  assert.equal(annotation.difficultyBasis.method, 'llm_estimate');
  assert.equal(access.run(admin, () => service.publish(record.importId, input)).replayed, true);
  const duplicate = access.run(admin, () => service.publish(record.importId, { ...input, review: { ...sample, basis: 'second audit' } }));
  assert.equal(duplicate.publication.accepted.length, 0);
  assert.equal(duplicate.publication.duplicates.length, 1);
  assert.equal(repository.getQuestionImport(record.importId).status, 'pending_review');
  const summary = (await service.get(record.importId)).import.publicationSummary;
  assert.equal(summary.accepted, 1);
  assert.equal(summary.currentReady, 1);
  assert.equal(summary.rejected, 1);
  assert.equal(summary.duplicates, 0, 'duplicate replay does not erase earlier accepted state');
  assert.equal((await service.list()).imports[0].publicationSummary.currentReady, 1);
  assert.equal(repository.getQuestionImport(record.importId).publicationSummary, undefined, 'staging remains immutable');
});

test('missing review checks and malformed stable IDs do not mutate bank, tasks or snapshots', async t => {
  const { service, record, input, access, admin, repository } = await setup(t);
  const before = repository.getQuestionBankSummary();
  const tasks = repository.getQuestionBankConfig('task_catalog').tasks.length;
  const bad = structuredClone(input); bad.questions[0].checks.formulaChecked = false;
  assert.throws(() => access.run(admin, () => service.publish(record.importId, bad)), error => error.code === 'sample_review_failed');
  assert.deepEqual(repository.getQuestionBankSummary(), before);
  assert.equal(repository.getQuestionBankConfig('task_catalog').tasks.length, tasks);
  const wrongSection = structuredClone(input); wrongSection.questions[0].sectionIds = ['2.3'];
  assert.throws(() => access.run(admin, () => service.publish(record.importId, wrongSection)), error => error.code === 'sample_review_failed');
});

test('held ledger records do not count toward ready supply or curriculum section totals', async t => {
  const { service, record, input, access, admin, repository } = await setup(t);
  const before = repository.getQuestionBankSummary().readyQuestions;
  const result = access.run(admin, () => service.publish(record.importId, input));
  assert.equal(repository.getQuestionBankSummary().readyQuestions, before + 1);
  const ledger = repository.getQuestionBankLedger();
  ledger.entries.find(entry => entry.questionId === result.publication.accepted[0].questionId).status = 'pending';
  repository.database.prepare("UPDATE question_bank_state SET payload=?,sha256=? WHERE kind='ledger'")
    .run(JSON.stringify(ledger), hashContent(ledger));
  assert.equal(repository.getQuestionBankSummary().readyQuestions, before);
  assert.equal((await service.get(record.importId)).import.publicationSummary.currentPending, 1);
  assert.equal(repository.getQuestionBankTextbooks()[0].chapters[1].sections.find(section => section.id === 'rja-compulsory-1:2.3').questionCount, 0);
});

test('catalog materializes index snapshots for indexed joins and counts all chapters in one grouped query', async t => {
  const { repository } = await setup(t);
  const db = repository.database, prepare = db.prepare.bind(db);
  const statements = [];
  db.prepare = sql => { statements.push(sql); return prepare(sql); };
  t.after(() => { db.prepare = prepare; });
  const result = await listQuestionBankCatalog({ root, page: 1, difficulty: 'unknown' });
  assert.equal(result.ok, true, JSON.stringify(result));
  // Verify one aggregate per catalog view, independent of aliases or the CASE
  // expression used to canonicalize legacy IDs. This guards against one query
  // per chapter while allowing the SQL's selected/grouped field names to evolve.
  const chapterQueries = statements.filter(sql => sql.includes('question_section_mappings') && /\bGROUP\s+BY\b/i.test(sql));
  assert.equal(chapterQueries.length, 1, 'Textbook section counts must use one grouped mapping query');
  const annotationQueries = statements.filter(sql => sql.includes('$.primarySections') && /\bGROUP\s+BY\b/i.test(sql));
  assert.equal(annotationQueries.length, 1, 'Assembly chapter counts must use one grouped annotation query');
  const countSql = statements.find(sql => sql.includes('SELECT count(*) AS count FROM question_bank_questions'));
  // Bind the difficulty filter used above. The plan must index materialized identity
  // columns rather than rescan unindexed JSON virtual tables for every question.
  const plan = prepare(`EXPLAIN QUERY PLAN ${countSql}`).all('unknown').map(row => row.detail).join('\n');
  assert.match(plan, /MATERIALIZE annotation_rows/);
  assert.match(plan, /SEARCH e USING AUTOMATIC/);
  assert.match(plan, /SEARCH p USING AUTOMATIC/);
  assert.equal(result.questions.some(question => Object.hasOwn(question, 'teacher')), false);
});

test('unresolved source visual and table blockers cannot be overridden by complete review checkboxes', async t => {
  for (const code of ['source_visual_unresolved', 'source_table_unresolved']) await t.test(code, async subtest => {
    const { service, record, input, access, admin, repository } = await setup(subtest);
    const altered = repository.getQuestionImport(record.importId);
    altered.questions[0].reviewIssues.push({ code, message: '题目依赖尚未恢复的来源图表。' });
    repository.database.prepare('UPDATE question_imports SET payload=?,sha256=? WHERE import_id=?')
      .run(JSON.stringify(altered), hashContent(altered), record.importId);
    const before = repository.getQuestionBankSummary();
    assert.throws(() => access.run(admin, () => service.publish(record.importId, input)), error => error.code === 'sample_review_failed');
    assert.deepEqual(repository.getQuestionBankSummary(), before);
    const unsampled = structuredClone(input);
    unsampled.review = { ...sample, sampleScope: 'corpus', sampleQuestionIds: [], sampleEvidence: {
      corpusSha256: 'a'.repeat(64), reviewSha256: 'b'.repeat(64), sampleSize: 1, sourceQuestionIds: ['another-batch-question'],
    } };
    const result = access.run(admin, () => service.publish(record.importId, unsampled));
    assert.equal(result.publication.accepted.length, 0);
    assert.equal(result.publication.rejected[0].code, 'content_blocked');
    assert.equal(repository.getQuestionImport(record.importId).status, 'pending_review');
    assert.deepEqual(repository.getQuestionBankSummary(), before);
  });
});

test('publication refuses unresolved explicit solution dependencies even when review checks passed', async t => {
  const { service, record, input, access, admin, repository } = await setup(t);
  const altered = repository.getQuestionImport(record.importId);
  altered.questions[0].dimensions.allowedSolution = '利用指数函数的单调性解指数不等式。';
  repository.database.prepare('UPDATE question_imports SET payload=?,sha256=? WHERE import_id=?')
    .run(JSON.stringify(altered), hashContent(altered), record.importId);
  assert.throws(() => access.run(admin, () => service.publish(record.importId, input)), error => error.code === 'sample_review_failed');
  const withDependency = structuredClone(input);
  withDependency.questions[0].requiredSectionIds = ['rja-compulsory-1:2.3', 'rja-compulsory-1:4.2', 'rja-compulsory-1:3.2'];
  const result = access.run(admin, () => service.publish(record.importId, withDependency));
  assert.equal(result.publication.accepted.length, 1);
  assert.equal(repository.getQuestionBankIndex().entries.find(entry => entry.questionId === result.publication.accepted[0].questionId).dependencyGuard.ok, true);
});

test('corpus sampling permits unsampled batches only with versioned evidence and never marks non-samples independently reviewed', async t => {
  const { service, record, input, access, admin, repository } = await setup(t);
  const corpus = { ...sample, sampleScope: 'corpus', sampleQuestionIds: [], sampleEvidence: {
    corpusSha256: 'a'.repeat(64), reviewSha256: 'b'.repeat(64), sampleSize: 2, sourceQuestionIds: ['legacy-100', 'legacy-200'],
  } };
  const publish = review => access.run(admin, () => service.publish(record.importId, { ...input, review }));
  assert.throws(() => publish({ ...sample, sampleQuestionIds: [] }), error => error.code === 'review_required');
  assert.throws(() => publish({ ...corpus, sampleEvidence: undefined }), error => error.code === 'corpus_sample_evidence_required');
  assert.throws(() => publish({ ...corpus, sampleEvidence: { ...corpus.sampleEvidence, sampleSize: 1 } }), error => error.code === 'corpus_sample_evidence_required');
  assert.throws(() => publish({ ...corpus, sampleEvidence: { ...corpus.sampleEvidence, reviewSha256: 'invalid' } }), error => error.code === 'corpus_sample_evidence_required');
  assert.throws(() => publish({ ...corpus, sampleEvidence: { ...corpus.sampleEvidence, sourceQuestionIds: ['legacy-100', 'legacy-100'] } }), error => error.code === 'corpus_sample_evidence_required');
  assert.throws(() => publish({ ...corpus, sampleQuestionIds: ['staged-001'] }), error => error.code === 'sample_identity_mismatch');
  const result = publish(corpus);
  assert.equal(result.publication.accepted.length, 1);
  const question = repository.getQuestionBankQuestion(result.publication.accepted[0].questionId);
  assert.equal(question.verification.reviewCoverage, 'source_comparison');
  assert.match(result.publication.reviewMeaning, /整个语料/);
  assert.deepEqual(result.publication.review.sampleEvidence, corpus.sampleEvidence);
  const validLocal = { ...corpus, sampleQuestionIds: ['staged-001'], sampleEvidence: { ...corpus.sampleEvidence,
    sourceQuestionIds: ['legacy-42', 'legacy-200'] } };
  assert.equal(publish(validLocal).publication.duplicates.length, 1);
});

test('publication HTTP endpoint requires authenticated administrator, CSRF origin, owner and exact staging version', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'tutor-publication-http-'));
  const application = await createNestApp({ root, storeRoot: path.join(base, 'drafts'), logger: false,
    legacyOptions: { questionImportGateway: { publicStatus: () => ({ configured: true }),
      propose: async () => ({ ok: true, proposal: { title: '试卷', questions: [structuredClone(question)] }, run: { model: 'fixture', status: 'succeeded' } }) } } });
  t.after(async () => { await application.close(); await rm(base, { recursive: true, force: true }); });
  await application.app.listen(0, '127.0.0.1');
  const url = await application.app.getUrl();
  const request = async (route, data, cookie, origin = url) => {
    const response = await fetch(`${url}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(data) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const admin = await request('/api/auth/register', { email: 'publisher@example.test', password: 'secure-publication-2026' });
  const teacher = await request('/api/auth/register', { email: 'teacher@example.test', password: 'secure-publication-2026' });
  const uploaded = await request('/api/question-imports', { filename: 'chapter2.txt', mimeType: 'text/plain', text: '不等式 x²>4，答案B，解析因式分解。' }, admin.cookie);
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded));
  const record = uploaded.body.import;
  const input = { sourceSha256: record.source.sha256, review: sample, questions: [{ stagingQuestionId: 'staged-001', sectionIds: ['rja-compulsory-1:2.3'], taskLabel: '因式分解求一元二次不等式解集', checks, basis: '源文档一致且抽样复核通过。' }] };
  const route = `/api/question-imports/${record.importId}/publish`;
  assert.equal((await request(route, input)).status, 401);
  assert.equal((await request(route, input, teacher.cookie)).status, 403);
  assert.equal((await request(route, input, admin.cookie, 'https://attacker.invalid')).status, 403);
  assert.equal((await request(route, { ...input, sourceSha256: 'stale' }, admin.cookie)).status, 409);
  const published = await request(route, input, admin.cookie);
  assert.equal(published.status, 200, JSON.stringify(published));
  assert.equal(published.body.publication.accepted.length, 1);
  assert.equal((await request(route, input, admin.cookie)).body.replayed, true);
  const foreignUpload = await request('/api/question-imports', { filename: 'teacher.txt', text: '题干答案解析' }, teacher.cookie);
  assert.equal((await request(`/api/question-imports/${foreignUpload.body.import.importId}/publish`, { ...input, sourceSha256: foreignUpload.body.import.source.sha256 }, admin.cookie)).status, 404);
});


test('canonical published questions and legacy curated questions share only the verified chapter identities', async t => {
  const imported = structuredClone(question);
  imported.student = { stem: '身份回归：集合 A={1,2}，B={2,3}，求 A∪B。', options: [{ label: 'A', text: '{1,2,3}' }, { label: 'B', text: '{2}' }], parts: [] };
  imported.teacher = { answers: [{ partId: 'main', text: 'A', sourceBasis: 'explicit' }],
    solutions: [{ partId: 'main', text: '把两个集合的所有元素合在一起，重复元素只保留一次，得到{1,2,3}。', sourceBasis: 'explicit' }] };
  imported.dimensions.chapterCandidates = ['rja-compulsory-1:1.3'];
  imported.dimensions.primaryTopics = ['集合并集'];
  imported.dimensions.requiredKnowledge = ['并集定义'];
  imported.dimensions.allowedSolution = '按并集定义合并集合A与B的元素。';
  const { service, record, input, access, admin, repository } = await setup(t, imported);
  // A canonical-only catalog reproduces a current import, while seed questions
  // still retain their old short IDs. The live SQLite store is isolated to tmp.
  const chapters = repository.getQuestionBankChapters();
  t.mock.method(repository, 'getQuestionBankChapters', () => chapters.map(chapter => ({ ...chapter, id: canonicalSectionId(chapter.id) })));
  input.questions = [{ ...input.questions[0], sectionIds: ['rja-compulsory-1:1.3'], taskLabel: '身份回归：求有限集合并集' }];
  const published = access.run(admin, () => service.publish(record.importId, input));
  assert.equal(published.ok, true, JSON.stringify(published));
  assert.equal(published.publication.accepted.length, 1, JSON.stringify(published));
  const questionId = published.publication.accepted[0].questionId;
  const annotation = repository.getQuestionBankIndex().entries.find(item => item.questionId === questionId);
  assert.deepEqual(annotation.primarySections, ['rja-compulsory-1:1.3']);
  const legacyCatalog = await listQuestionBankCatalog({ root, sectionId: '1.3', query: questionId });
  const canonicalCatalog = await listQuestionBankCatalog({ root, sectionId: 'rja-compulsory-1:1.3', query: questionId });
  assert.deepEqual(legacyCatalog.questions.map(item => item.questionId), [questionId]);
  assert.deepEqual(canonicalCatalog.questions.map(item => item.questionId), [questionId]);
  const { config } = await getAssemblyConfig({ root });
  const pool = await loadPool(root);
  const taskId = annotation.tasks[0];
  const normalize = scopes => normalizeRequirements({ ...config.defaultRequirements, ...scopes,
    counts: { single_choice: 1, fill_blank: 0, free_response: 0 }, scoringMode: 'none', targetScore: 0,
    sourceIds: config.sources.map(item => item.sourceId), teachingGoals: [] }, config, config.sources.map(item => item.sourceId));
  const legacy = normalize({ mainScope: ['1.3'], learnedScope: ['1.1', '1.2', '1.3'] });
  assert.equal(slotCandidates(pool, { taskId, questionType: 'single_choice', goalIds: [] }, legacy).find(item => item.questionId === questionId).status, 'eligible');
  assert.deepEqual(legacy.mainScope, ['1.3']);
  assert.deepEqual(legacy.learnedScope, ['1.1', '1.2', '1.3']);
  const canonical = normalize({ mainScope: ['rja-compulsory-1:1.1'], learnedScope: ['rja-compulsory-1:1.1'] });
  const old = pool.records.find(item => item.annotation?.primarySections.length === 1 && item.annotation.primarySections[0] === '1.1'
    && item.annotation.solutionPaths.some(solution => solution.requiredSections.every(section => includesSection(canonical.learnedScope, section)) && !solution.requiredPremises.length));
  assert.ok(old, 'A genuinely curated legacy question is present');
  assert.equal(slotCandidates(pool, { taskId: old.annotation.tasks[0], questionType: old.entry.questionType, goalIds: [] }, canonical)
    .find(item => item.questionId === old.entry.questionId).status, 'eligible');
  let context;
  const planned = await planBlueprint(legacy, { root, gateway: { async propose(value) {
    context = value; return { ok: true, proposal: { summary: '实际入库题身份回归。', slots: [{ taskId, points: 0, goalIds: [], rationale: '同一小节的新入库题可见。' }] } };
  } } });
  assert.equal(planned.ok, true, JSON.stringify(planned));
  assert.ok(context.tasks.some(task => task.taskId === taskId && task.eligibleCount === 1));
  assert.deepEqual(planned.blueprint.requirements.mainScope, ['1.3']);
  assert.deepEqual(planned.blueprint.requirements.learnedScope, legacy.learnedScope);
  t.mock.method(repository, 'getQuestionBankChapters', () => [...chapters, ...chapters.map(chapter => ({ ...chapter, id: canonicalSectionId(chapter.id) }))]);
  const intake = await createIntakeService({ root }).handle({ action: 'start', flow: 'quick', operationId: 'mixed-catalog-display',
    answers: { mainScope: ['1.3'], learnedScope: ['1.1', '1.2', '1.3'], learnedScopeMode: 'custom' } });
  assert.equal(intake.ok, true, JSON.stringify(intake));
  assert.equal(intake.session.summary.mainScope.length, 1);
  assert.equal(intake.session.summary.learnedScope.length, 3);
  assert.equal(new Set(intake.session.progression.orderedIds.map(canonicalSectionId)).size, intake.session.progression.orderedIds.length);
  assert.deepEqual(intake.session.answers.mainScope, ['1.3']);
  assert.deepEqual(intake.session.answers.learnedScope, ['1.1', '1.2', '1.3']);
  const wrongBook = { ...legacy, mainScope: ['other-book:1.3'], learnedScope: ['other-book:1.3'] };
  assert.notEqual(slotCandidates(pool, { taskId, questionType: 'single_choice', goalIds: [] }, wrongBook)
    .find(item => item.questionId === questionId).status, 'eligible');
  const wrongChapter = { ...legacy, mainScope: ['rja-compulsory-1:2.3'], learnedScope: ['rja-compulsory-1:2.3'] };
  assert.notEqual(slotCandidates(pool, { taskId, questionType: 'single_choice', goalIds: [] }, wrongChapter)
    .find(item => item.questionId === questionId).status, 'eligible');
});
