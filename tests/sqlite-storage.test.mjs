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
