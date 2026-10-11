import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { registerSqliteStorage, SqliteRepository } from '../src/storage/sqlite.mjs';
import { previewBlueprint, createDraft } from '../src/assembly/engine.mjs';
import { saveDraft, readDraft, updateDraft, listDrafts } from '../src/assembly/store.mjs';
import { confirmPaper, getPaper, derivePaperDraft } from '../src/assembly/papers.mjs';
import { saveFeedback, readFeedback } from '../src/assembly/feedback.mjs';
import { generateOutput, readOutputFile, getOutputStatus } from '../src/output/manager.mjs';
import { hashContent } from '../src/question-bank/reader.mjs';
import { getQuestion, listQuestions } from '../src/question-bank/reader.mjs';
import { getAssemblyConfig, loadPool } from '../src/assembly/engine.mjs';
import { listQuestionBankCatalog } from '../src/question-bank/catalog.mjs';
import Database from 'better-sqlite3';

async function fixture(t, { register = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tutor-sqlite-'));
  const storeRoot = path.join(root, 'drafts');
  const paths = { root, storeRoot, papersRoot: path.join(root, 'papers'), outputRoot: path.join(root, 'outputs'), feedbackRoot: path.join(root, 'feedback') };
  let storage = register ? await registerSqliteStorage(root) : undefined;
  t.after(async () => {
    storage?.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('tutor-sqlite-'));
    await rm(root, { recursive: true, force: true });
  });
  return { ...paths, get storage() { return storage; }, async reopen() { storage?.close(); storage = await registerSqliteStorage(root); return storage; } };
}

async function realDraft(storeRoot) {
  const { blueprint } = await previewBlueprint(); const { draft } = await createDraft(blueprint);
  await saveDraft(storeRoot, draft); return draft;
}

test('SQLite saves real draft, immutable paper, derivation, feedback and PDF manifest without JSON dual writes', async t => {
  const f = await fixture(t); const draft = await realDraft(f.storeRoot);
  assert.deepEqual(await readDraft(f.storeRoot, draft.draftId), draft);
  assert.equal((await listDrafts(f.storeRoot)).drafts.length, 1);
  const request = { operationId: 'sqlite-confirm', expectedRevision: 0, acknowledgeDifferences: true };
  const result = await confirmPaper(f.storeRoot, draft.draftId, request, { papersRoot: f.papersRoot });
  assert.equal(result.ok, true); const paper = result.paper;
  assert.equal((await confirmPaper(f.storeRoot, draft.draftId, request, { papersRoot: f.papersRoot })).replayed, true);
  assert.equal((await confirmPaper(f.storeRoot, draft.draftId, { ...request, acknowledgeDifferences: false }, { papersRoot: f.papersRoot })).error.code, 'operation_conflict');
  await assert.rejects(saveDraft(f.storeRoot, { ...draft, title: 'stale cross-process overwrite', revision: 1 }), { code: 'finalized_draft' });
  assert.throws(() => f.storage.repository.put('papers', paper.paperId, { schemaVersion: 1, sha256: hashContent(paper), paper }), { code: 'operation_conflict' });
  assert.throws(() => f.storage.repository.database.prepare("DELETE FROM documents WHERE kind='papers'").run(), /immutable paper/);
  const derived = await derivePaperDraft(f.storeRoot, f.papersRoot, paper.paperId, { operationId: 'derive-sqlite' });
  assert.equal(derived.ok, true);
  assert.equal((await derivePaperDraft(f.storeRoot, f.papersRoot, paper.paperId, { operationId: 'derive-sqlite' })).replayed, true);
  const feedback = await saveFeedback(f.feedbackRoot, paper, { willingToUse: 'yes', reason: '可用', manualCorrections: '' });
  assert.deepEqual(await readFeedback(f.feedbackRoot, paper.paperId), feedback);
  const output = await generateOutput(paper, 'student', { outputRoot: f.outputRoot, generate: async (_paper, _kind, { outputRoot }) => {
    await mkdir(outputRoot, { recursive: true });
    const bytes = Buffer.from('%PDF-1.7\nfixture artifact'); const target = path.join(outputRoot, 'student.pdf');
    await writeFile(target, bytes);
    return { ok: true, artifact: { path: target, status: 'complete', sha256: createHash('sha256').update(bytes).digest('hex'), pages: 1 } };
  } });
  assert.equal(output.ok, true);
  assert.ok((await readOutputFile(paper, 'student', f)).bytes.subarray(0, 5).equals(Buffer.from('%PDF-')));
  assert.deepEqual(await readdir(path.join(f.outputRoot, paper.paperId)), ['student.pdf']);
  assert.equal((await readdir(f.root)).includes('drafts'), false);
  assert.equal((await readdir(f.root)).includes('papers'), false);
  await f.reopen();
  assert.deepEqual((await getPaper(f.papersRoot, paper.paperId)).paper, paper);
  assert.equal((await getOutputStatus(paper, 'student', f)).status, 'complete');
  assert.deepEqual(await readFeedback(f.feedbackRoot, paper.paperId), feedback);
});

test('SQLite imports old valid JSON once, preserves damaged source and does not overwrite newer database revisions', async t => {
  const f = await fixture(t, { register: false }); const draft = await realDraft(f.storeRoot);
  const filename = path.join(f.storeRoot, `${draft.draftId}.json`);
  const original = await readFile(filename, 'utf8'); const damagedId = randomUUID();
  await writeFile(path.join(f.storeRoot, `${damagedId}.json`), '{bad json');
  const first = await f.reopen();
  assert.equal(first.migration.imported, 1); assert.equal(first.migration.warnings.length, 1);
  assert.equal((await listDrafts(f.storeRoot)).warnings.length, 1);
  await updateDraft(f.storeRoot, draft.draftId, current => ({ ok: true, draft: { ...current, title: 'SQLite changed', revision: 1 } }));
  assert.equal(await readFile(filename, 'utf8'), original);
  const second = await f.reopen();
  assert.equal(second.migration.imported, 0);
  assert.equal((await readDraft(f.storeRoot, draft.draftId)).title, 'SQLite changed');
  assert.equal(await readFile(path.join(f.storeRoot, `${damagedId}.json`), 'utf8'), '{bad json');
});

test('SQLite revision compare-and-swap detects another connection and tampered payload fails closed', async t => {
  const f = await fixture(t); const draft = await realDraft(f.storeRoot);
  const other = new SqliteRepository(f.storage.repository.filename);
  try { other.put('drafts', draft.draftId, { schemaVersion: 1, sha256: hashContent({ ...draft, revision: 1 }), draft: { ...draft, revision: 1 } }, { expectedRevision: 0 }); }
  finally { other.close(); }
  assert.throws(() => f.storage.repository.put('drafts', draft.draftId,
    { schemaVersion: 1, sha256: hashContent({ ...draft, revision: 1 }), draft: { ...draft, revision: 1 } }, { expectedRevision: 0 }), { code: 'revision_conflict' });
  f.storage.repository.database.prepare("UPDATE documents SET payload='{}' WHERE kind='drafts' AND id=?").run(draft.draftId);
  await assert.rejects(readDraft(f.storeRoot, draft.draftId), { code: 'integrity_error' });
});

test('SQLite intake adapter serializes session mutations and persists model audit records across restart', async t => {
  const f = await fixture(t); const sessionId = randomUUID(); const storage = f.storage.repository.intakeStorage;
  await storage.put({ sessionId, revision: 0 });
  await Promise.all([1, 2, 3].map(() => storage.transaction(sessionId, async () => {
    const current = await storage.get(sessionId);
    await storage.put({ ...current, revision: current.revision + 1, llmRun: { runId: 'model-real-id', provider: 'fixture', status: 'complete' } });
  })));
  assert.equal((await storage.get(sessionId)).revision, 3);
  assert.equal(f.storage.repository.database.prepare('SELECT COUNT(*) AS count FROM llm_runs').get().count, 1);
  await f.reopen();
  assert.equal((await f.storage.repository.intakeStorage.get(sessionId)).revision, 3);
});

test('SQLite rejects stale paper insertion and exact retry recovers a published paper after finalization save failure', async t => {
  const f = await fixture(t); const draft = await realDraft(f.storeRoot);
  const request = { operationId: 'sqlite-recovery', expectedRevision: 0, acknowledgeDifferences: true };
  const failed = await confirmPaper(f.storeRoot, draft.draftId, request, { papersRoot: f.papersRoot,
    persistDraft: async () => { throw Object.assign(new Error('simulated interruption'), { code: 'save_error' }); } });
  assert.equal(failed.ok, false);
  assert.equal(f.storage.repository.list('papers').length, 1);
  await assert.rejects(saveDraft(f.storeRoot, { ...draft, revision: 1, title: 'must not overwrite frozen source' }), { code: 'finalized_draft' });
  const recovered = await confirmPaper(f.storeRoot, draft.draftId, request, { papersRoot: f.papersRoot });
  assert.equal(recovered.ok, true); assert.equal(recovered.replayed, true);
  const secondDraft = await realDraft(f.storeRoot);
  const second = await confirmPaper(f.storeRoot, secondDraft.draftId, { ...request, operationId: 'second-paper' }, { papersRoot: f.papersRoot });
  const stale = structuredClone(second.paper); stale.paperId = randomUUID(); stale.sourceDraftId = draft.draftId;
  stale.draft = { ...draft, revision: 999 }; stale.sourceRevision = 999; stale.snapshotSha256 = hashContent(stale.draft);
  assert.throws(() => f.storage.repository.put('papers', stale.paperId, { schemaVersion: 1, sha256: hashContent(stale), paper: stale }), { code: 'revision_conflict' });
});

test('Nest registration seeds the versioned question bank into SQLite and runtime readers use the registered snapshot', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'tutor-bank-sqlite-'));
  const projectRoot = path.resolve('.');
  const storage = await registerSqliteStorage(base, 'bank.sqlite', { questionBankRoot: projectRoot });
  t.after(async () => {
    storage.close();
    assert.equal(path.dirname(base), path.resolve(os.tmpdir()));
    await rm(base, { recursive: true, force: true });
  });
  assert.equal(storage.repository.filename, path.join(base, 'bank.sqlite'));
  assert.deepEqual(storage.questionBank, { readyQuestions: 45, annotations: 45, chapters: 3,
    textbooks: 5, curriculumChapters: 18, curriculumSections: 73, questionSectionMappings: 53 });
  assert.equal(storage.repository.database.prepare('SELECT COUNT(*) AS count FROM question_bank_questions').get().count, 45);
  assert.equal(storage.repository.database.prepare('SELECT COUNT(*) AS count FROM question_bank_chapters').get().count, 3);
  assert.equal(storage.repository.database.prepare('SELECT COUNT(*) AS count FROM curriculum_textbooks').get().count, 5);
  assert.equal(storage.repository.database.prepare('SELECT COUNT(*) AS count FROM curriculum_chapters').get().count, 18);
  assert.equal(storage.repository.database.prepare('SELECT COUNT(*) AS count FROM curriculum_sections').get().count, 73);
  assert.equal(storage.repository.database.prepare('SELECT COUNT(*) AS count FROM question_section_mappings').get().count, 53);
  assert.equal(storage.repository.database.prepare(`SELECT COUNT(*) AS count FROM question_section_mappings
    WHERE section_id NOT LIKE 'rja-compulsory-1:1.%'`).get().count, 0);
  const catalog = await listQuestionBankCatalog({ root: projectRoot });
  assert.equal(catalog.ok, true, JSON.stringify(catalog));
  assert.equal(catalog.textbooks.length, 5);
  assert.equal(catalog.textbooks.flatMap(book => book.chapters).length, 18);
  assert.equal(catalog.textbooks.flatMap(book => book.chapters.flatMap(chapter => chapter.sections)).length, 73);
  const sectionCounts = new Map(catalog.textbooks.flatMap(book => book.chapters
    .flatMap(chapter => chapter.sections.map(section => [section.id, section.questionCount]))));
  assert.equal(sectionCounts.get('rja-compulsory-1:1.1'), 28);
  assert.equal(sectionCounts.get('rja-compulsory-1:1.2'), 14);
  assert.equal(sectionCounts.get('rja-compulsory-1:1.3'), 11);
  assert.equal(sectionCounts.get('rja-selective-1:1.1'), 0);
  assert.equal([...sectionCounts.values()].filter(count => count === 0).length, 70);
  assert.deepEqual(catalog.questions.find(question => question.questionId === 'tutor-set-001').sectionIds,
    ['rja-compulsory-1:1.1']);
  const sectionSnapshot = storage.repository.database.prepare(`SELECT payload,sha256 FROM curriculum_sections
    WHERE section_id='rja-compulsory-1:1.1'`).get();
  storage.repository.database.prepare(`UPDATE curriculum_sections SET payload='{}'
    WHERE section_id='rja-compulsory-1:1.1'`).run();
  assert.throws(() => storage.repository.getQuestionBankTextbooks(), { code: 'integrity_error' });
  storage.repository.database.prepare(`UPDATE curriculum_sections SET payload=?,sha256=?
    WHERE section_id='rja-compulsory-1:1.1'`).run(sectionSnapshot.payload, sectionSnapshot.sha256);
  storage.repository.database.prepare(`UPDATE curriculum_sections SET sha256='${'0'.repeat(64)}'
    WHERE section_id='rja-compulsory-1:1.1'`).run();
  assert.throws(() => storage.repository.getQuestionBankTextbooks(), { code: 'integrity_error' });
  storage.repository.database.prepare(`UPDATE curriculum_sections SET sha256=?
    WHERE section_id='rja-compulsory-1:1.1'`).run(sectionSnapshot.sha256);
  const packageRow = storage.repository.database.prepare(`SELECT payload FROM question_bank_questions
    WHERE question_id='tutor-set-001'`).get();
  assert.ok(JSON.parse(packageRow.payload).teacher.answers.length > 0);
  assert.equal((await listQuestions({ root: projectRoot })).totals.ready, 45);
  const pool = await loadPool(projectRoot);
  assert.equal(pool.records.length, 45);
  assert.equal(pool.questionIndexSnapshot.entries.length, 45);
});

test('SQLite migrates the pre-BLOB question import table instead of treating CREATE IF NOT EXISTS as a migration', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tutor-import-schema-'));
  const filename = path.join(root, 'legacy.sqlite');
  const legacy = new Database(filename);
  legacy.exec(`CREATE TABLE question_imports(
    import_id TEXT PRIMARY KEY, payload TEXT NOT NULL, sha256 TEXT NOT NULL,
    status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  legacy.close();
  const repository = new SqliteRepository(filename);
  t.after(async () => { repository.close(); await rm(root, { recursive: true, force: true }); });
  const columns = new Set(repository.database.pragma('table_info(question_imports)').map(column => column.name));
  assert.equal(columns.has('source_blob'), true);
  assert.equal(columns.has('source_sha256'), true);
  assert.ok(repository.database.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name='question_imports_without_source_v3'`).get());
});

test('SQLite bank survives restart without seed JSON or source PDFs and preserves database-owned content', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'tutor-authoritative-bank-'));
  const emptyProjectRoot = path.join(base, 'empty-project');
  await mkdir(emptyProjectRoot);
  let storage;
  t.after(async () => { storage?.close(); await rm(base, { recursive: true, force: true }); });
  storage = await registerSqliteStorage(base, 'bank.sqlite', { questionBankRoot: path.resolve('.') });
  const original = await getAssemblyConfig();
  assert.equal(original.ok, true);
  const seededAt = storage.repository.database.prepare(`SELECT synced_at FROM question_bank_state WHERE kind='ledger'`).get().synced_at;
  const updatedContext = { ...original.config.courseContext, contextId: 'database-owned-context' };
  storage.repository.database.prepare(`UPDATE question_bank_config SET payload=?,sha256=? WHERE kind='course_context'`)
    .run(JSON.stringify(updatedContext), hashContent(updatedContext));
  storage.close(); storage = undefined;

  // This deployment root contains neither data/ JSON nor any original source paper.
  storage = await registerSqliteStorage(base, 'bank.sqlite', { questionBankRoot: emptyProjectRoot });
  assert.deepEqual(await readdir(emptyProjectRoot), []);
  assert.equal(storage.questionBank.readyQuestions, 45);
  assert.equal(storage.repository.database.prepare(`SELECT synced_at FROM question_bank_state WHERE kind='ledger'`).get().synced_at, seededAt);
  assert.equal((await listQuestions({ root: emptyProjectRoot })).totals.ready, 45);
  const question = await getQuestion('tutor-set-001', { root: emptyProjectRoot });
  assert.equal(question.ok, true, JSON.stringify(question));
  const configured = await getAssemblyConfig({ root: emptyProjectRoot });
  assert.equal(configured.ok, true, JSON.stringify(configured));
  assert.equal(configured.config.courseContext.contextId, 'database-owned-context');
  assert.deepEqual(configured.config.tasks, original.config.tasks);
  assert.deepEqual(configured.config.sourceManifest, original.config.sourceManifest);
  const pool = await loadPool(emptyProjectRoot);
  assert.equal(pool.records.length, 45);
  assert.equal(pool.failures.length, 0);
  assert.equal((await listQuestionBankCatalog({ root: emptyProjectRoot })).questions.length, 45);
});
