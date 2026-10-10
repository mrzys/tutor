import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { previewBlueprint, createDraft } from '../src/assembly/engine.mjs';
import { applyDraftOperation } from '../src/assembly/editor.mjs';
import { hashContent } from '../src/question-bank/reader.mjs';
import { saveDraft, readDraft, updateDraft } from '../src/assembly/store.mjs';
import { preparePaperConfirmation, confirmPaper, getPaper, listPapers, findPaperForDraft, deriveDraftFromPaper, derivePaperDraft } from '../src/assembly/papers.mjs';

let sequence = 0;
const request = (draft, extra = {}) => ({ operationId: `confirm-${++sequence}`, expectedRevision: draft.revision ?? 0, acknowledgeDifferences: true, ...extra });
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tutor-papers-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('tutor-papers-test-'));
    await rm(root, { recursive: true, force: true });
  });
  const storeRoot = path.join(root, '.tutor', 'drafts'); const papersRoot = path.join(root, '.tutor', 'papers');
  const { blueprint } = await previewBlueprint();
  const { draft } = await createDraft(blueprint);
  await saveDraft(storeRoot, draft);
  return { root, storeRoot, papersRoot, draft, options: { root, papersRoot } };
}

test('confirmation summary calculates actual content independently and keeps teacher gaps separate from student counts', async t => {
  const f = await fixture(t); const draft = structuredClone(f.draft);
  draft.slots[7].question = null; draft.slots[7].status = 'empty';
  draft.slots[0].question.teacher = { answers: [], solutions: [], scoringSuggestions: [] };
  draft.slots[1].applicability = { status: 'unknown', reasons: ['测试：未证实完整允许解法。'] };
  draft.stats = { selectedQuestions: 999, availablePoints: 999 };
  const summary = preparePaperConfirmation(draft);
  assert.equal(summary.stats.selectedQuestions, 9);
  assert.equal(summary.stats.availablePoints, 90);
  assert.equal(summary.student.complete, false);
  assert.equal(summary.student.missing[0].number, 8);
  assert.equal(summary.teacher.complete, false);
  assert.ok(summary.teacher.issues.some(issue => issue.slotId === 'slot-1' && issue.code === 'answer_missing'));
  assert.ok(summary.teacher.issues.some(issue => issue.slotId === 'slot-1' && issue.code === 'solution_missing'));
  assert.equal(summary.unknown[0].slotId, 'slot-2');
  assert.equal(summary.difficulty.estimate, null);
  assert.equal(summary.requiresAcknowledgement, true);
  assert.equal(summary.scoringIssues.length, 9);
});

test('confirmation freezes exact reviewed content, versions, baseline history and summary while marking its source finalized', async t => {
  const f = await fixture(t);
  const edited = await applyDraftOperation(f.draft, { operationId: 'vieta-correction', expectedRevision: 0, type: 'baseline',
    requirements: { premises: f.draft.baseline.requirements.premises.filter(item => item !== 'vieta') } });
  assert.equal(edited.ok, true); await saveDraft(f.storeRoot, edited.draft);
  const result = await confirmPaper(f.storeRoot, edited.draft.draftId, request(edited.draft), f.options);
  assert.equal(result.ok, true, JSON.stringify(result));
  const { paper } = result;
  assert.deepEqual(paper.draft, edited.draft);
  assert.equal(paper.sourceRevision, 1);
  assert.equal(paper.snapshotSha256, hashContent(edited.draft));
  assert.equal(paper.contentVersions.length, 10);
  assert.equal(paper.summary.student.questionCount, 10);
  assert.equal(paper.summary.student.points, 100);
  assert.equal(paper.summary.unknown.find(item => item.slotId === 'slot-8').status, 'unknown');
  assert.equal(paper.draft.baselineHistory.length, 1);
  assert.deepEqual(paper.confirmation.summary, paper.summary);
  const finalized = await readDraft(f.storeRoot, edited.draft.draftId);
  assert.equal(finalized.confirmedPaperId, paper.paperId);
  assert.equal(finalized.revision, 2);
  assert.deepEqual(finalized.slots, edited.draft.slots);
  assert.deepEqual((await getPaper(f.papersRoot, paper.paperId)).paper, paper);
  assert.equal((await listPapers(f.papersRoot)).papers.length, 1);
});

test('unknown and incomplete content may be explicitly confirmed, missing teacher material does not lower student availability', async t => {
  const f = await fixture(t); const draft = structuredClone(f.draft);
  draft.slots[7].question = null; draft.slots[7].status = 'empty';
  const question = draft.slots[0].question;
  question.teacher = { answers: [], solutions: [], scoringSuggestions: [] };
  question.teacherSha256 = hashContent(question.teacher); question.teacherVersion = `teacher-${question.teacherSha256.slice(0, 16)}`;
  question.scopeEvidence.teacherVersion = question.teacherVersion; question.verification.teacherVersion = question.teacherVersion;
  await saveDraft(f.storeRoot, draft);
  const result = await confirmPaper(f.storeRoot, draft.draftId, request(draft), f.options);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.paper.summary.student.questionCount, 9);
  assert.equal(result.paper.summary.student.points, 90);
  assert.equal(result.paper.summary.student.complete, false);
  assert.equal(result.paper.summary.teacher.complete, false);
  assert.deepEqual(result.paper.draft.slots[0].question.teacher.answers, []);
});

test('concurrent duplicate confirmation executes once, finalizes source and retry returns the original immutable paper', async t => {
  const f = await fixture(t); const confirmation = request(f.draft);
  const results = await Promise.all([confirmPaper(f.storeRoot, f.draft.draftId, confirmation, f.options), confirmPaper(f.storeRoot, f.draft.draftId, confirmation, f.options)]);
  assert.ok(results.every(result => result.ok));
  assert.equal(results[0].paper.paperId, results[1].paper.paperId);
  assert.equal(results[1].replayed, true);
  const finalized = await readDraft(f.storeRoot, f.draft.draftId);
  const changed = await updateDraft(f.storeRoot, f.draft.draftId, current => applyDraftOperation(current,
    { operationId: 'point-edit-after-paper', expectedRevision: finalized.revision, type: 'points', slotId: 'slot-8', points: 12, partPoints: [] }));
  assert.equal(changed.error.code, 'finalized_draft');
  const retry = await confirmPaper(f.storeRoot, f.draft.draftId, confirmation, f.options);
  assert.equal(retry.ok, true);
  assert.equal(retry.replayed, true);
  assert.equal(retry.paper.summary.student.points, 100);
  assert.equal(retry.paper.sourceRevision, 0);
  assert.equal((await readDraft(f.storeRoot, f.draft.draftId)).stats.availablePoints, 100);
  assert.equal((await readDraft(f.storeRoot, f.draft.draftId)).revision, 1);
  assert.equal((await listPapers(f.papersRoot)).papers.length, 1);
  const conflict = await confirmPaper(f.storeRoot, f.draft.draftId, { ...confirmation, expectedRevision: 1 }, f.options);
  assert.equal(conflict.error.code, 'operation_conflict');
});

test('stale confirmation or absent acknowledgement never saves an unreviewed paper', async t => {
  const f = await fixture(t);
  const changed = await updateDraft(f.storeRoot, f.draft.draftId, current => applyDraftOperation(current,
    { operationId: 'lock-before-confirmation', expectedRevision: 0, type: 'lock', slotId: 'slot-1', locked: true }));
  assert.equal(changed.ok, true);
  assert.equal((await confirmPaper(f.storeRoot, f.draft.draftId, request(f.draft), f.options)).error.code, 'revision_conflict');
  assert.equal((await confirmPaper(f.storeRoot, f.draft.draftId, request(changed.draft, { acknowledgeDifferences: false }), f.options)).error.code, 'confirmation_required');
  assert.deepEqual((await listPapers(f.papersRoot)).papers, []);
});

test('snapshot content survives current bank changes and subsequent draft changes', async t => {
  const f = await fixture(t); const question = f.draft.slots[0].question;
  const bankFile = path.join(f.root, 'question-bank-example.json');
  await writeFile(bankFile, JSON.stringify(question));
  const confirmed = await confirmPaper(f.storeRoot, f.draft.draftId, request(f.draft), f.options);
  assert.equal(confirmed.ok, true);
  const original = structuredClone(confirmed.paper);
  await writeFile(bankFile, JSON.stringify({ ...question, student: { ...question.student, stem: 'LATER_BANK_CONTENT_CHANGE' } }));
  const draft = structuredClone(f.draft); draft.slots[0].question.student.stem = 'LATER_DRAFT_CONTENT_CHANGE';
  await saveDraft(f.storeRoot, draft);
  const reopened = await getPaper(f.papersRoot, confirmed.paper.paperId);
  assert.deepEqual(reopened.paper, original);
  assert.ok(!JSON.stringify(reopened.paper).includes('LATER_'));
});

test('required asset bytes are embedded and checked, so later asset changes cannot affect the snapshot', async t => {
  const f = await fixture(t); const draft = structuredClone(f.draft);
  const bytes = Buffer.from('INJECTED_TEST_IMAGE_BYTES'); const sha256 = createHash('sha256').update(bytes).digest('hex');
  await mkdir(path.join(f.root, 'assets'));
  await writeFile(path.join(f.root, 'assets', 'test.png'), bytes);
  const question = draft.slots[0].question;
  question.student.assets = [{ assetId: 'test-figure', path: 'assets/test.png', sha256, mimeType: 'image/png', alt: '测试素材' }];
  question.contentSha256 = hashContent(question.student); question.contentVersion = `content-${question.contentSha256.slice(0, 16)}`;
  question.scopeEvidence.contentVersion = question.contentVersion; question.verification.contentVersion = question.contentVersion;
  await saveDraft(f.storeRoot, draft);
  const saved = await confirmPaper(f.storeRoot, draft.draftId, request(draft), f.options);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.paper.assets[0].dataBase64, bytes.toString('base64'));
  assert.equal(saved.paper.assets[0].sha256, sha256);
  await writeFile(path.join(f.root, 'assets', 'test.png'), 'LATER_ASSET_CHANGE');
  assert.equal((await getPaper(f.papersRoot, saved.paper.paperId)).paper.assets[0].dataBase64, bytes.toString('base64'));
  const derivative = await derivePaperDraft(f.storeRoot, f.papersRoot, saved.paper.paperId, { operationId: 'derive-asset-test' });
  assert.equal(derivative.draft.frozenAssets[0].dataBase64, bytes.toString('base64'));
  const derivedPaper = await confirmPaper(f.storeRoot, derivative.draft.draftId, request(derivative.draft), f.options);
  assert.equal(derivedPaper.ok, true);
  assert.equal(derivedPaper.paper.assets[0].dataBase64, bytes.toString('base64'));
  const newDraft = { ...structuredClone(draft), draftId: randomUUID() };
  await saveDraft(f.storeRoot, newDraft);
  const mismatched = await confirmPaper(f.storeRoot, newDraft.draftId, request(newDraft), f.options);
  assert.equal(mismatched.error.code, 'integrity_error');
  await rm(path.join(f.root, 'assets', 'test.png'));
  assert.equal((await confirmPaper(f.storeRoot, newDraft.draftId, request(newDraft), f.options)).error.code, 'read_error');
});

test('tampering is detected and an unreadable original snapshot is not silently regenerated on retry', async t => {
  const f = await fixture(t); const confirmation = request(f.draft);
  const saved = await confirmPaper(f.storeRoot, f.draft.draftId, confirmation, f.options);
  const file = path.join(f.papersRoot, `${saved.paper.paperId}.json`);
  const corrupt = await readJson(file); corrupt.paper.draft.slots[0].points++;
  await writeFile(file, JSON.stringify(corrupt));
  assert.equal((await getPaper(f.papersRoot, saved.paper.paperId)).error.code, 'integrity_error');
  assert.equal((await confirmPaper(f.storeRoot, f.draft.draftId, confirmation, f.options)).error.code, 'integrity_error');
  assert.equal((await listPapers(f.papersRoot)).warnings.length, 1);
  assert.deepEqual((await listPapers(f.papersRoot)).papers, []);
  await writeFile(file, '{INJECTED_CORRUPTION');
  assert.equal((await confirmPaper(f.storeRoot, f.draft.draftId, confirmation, f.options)).error.code, 'read_error');
});

test('failed snapshot persistence reports failure and retains the original saved draft', async t => {
  const f = await fixture(t); const blocked = path.join(f.root, 'blocked-papers');
  await writeFile(blocked, 'INJECTED_STORAGE_FAILURE');
  const result = await confirmPaper(f.storeRoot, f.draft.draftId, request(f.draft), { ...f.options, papersRoot: blocked });
  assert.equal(result.ok, false);
  assert.deepEqual(await readDraft(f.storeRoot, f.draft.draftId), f.draft);
  assert.equal((await listPapers(f.papersRoot)).papers.length, 0);
});

test('injected source-finalization save failure can recover the published paper by exact retry', async t => {
  const f = await fixture(t); const confirmation = request(f.draft);
  const failed = await confirmPaper(f.storeRoot, f.draft.draftId, confirmation, { ...f.options,
    persistDraft: async () => { throw Object.assign(new Error('INJECTED_FINALIZATION_SAVE_FAILURE'), { code: 'save_error' }); } });
  assert.equal(failed.error.code, 'save_error');
  assert.deepEqual(await readDraft(f.storeRoot, f.draft.draftId), f.draft);
  const found = await findPaperForDraft(f.papersRoot, f.draft.draftId);
  assert.equal(found.ok, true);
  assert.ok(found.paper);
  assert.equal(found.paper.sourceRevision, 0);
  const differentRequest = await confirmPaper(f.storeRoot, f.draft.draftId, request(f.draft), f.options);
  assert.equal(differentRequest.error.code, 'finalized_draft');
  const recovered = await confirmPaper(f.storeRoot, f.draft.draftId, confirmation, f.options);
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.replayed, true);
  assert.equal(recovered.paper.paperId, found.paper.paperId);
  const finalized = await readDraft(f.storeRoot, f.draft.draftId);
  assert.equal(finalized.confirmedPaperId, found.paper.paperId);
  assert.equal(finalized.revision, 1);
  assert.equal((await listPapers(f.papersRoot)).papers.length, 1);
});

test('pure derivation creates independent new editable draft without mutating frozen content', async t => {
  const f = await fixture(t);
  const saved = await confirmPaper(f.storeRoot, f.draft.draftId, request(f.draft), f.options);
  const before = structuredClone(saved.paper);
  const derived = deriveDraftFromPaper(saved.paper);
  assert.equal(derived.ok, true);
  assert.notEqual(derived.draft.draftId, f.draft.draftId);
  assert.equal(derived.draft.revision, 0);
  assert.deepEqual(derived.draft.operations, []);
  assert.deepEqual(derived.draft.slots, f.draft.slots);
  assert.deepEqual(derived.draft.baseline, f.draft.baseline);
  assert.equal(derived.draft.derivedFromPaperId, saved.paper.paperId);
  assert.equal(derived.draft.confirmedPaperId, undefined);
  assert.equal(derived.draft.finalization, undefined);
  assert.equal(derived.draft.finalizedAt, undefined);
  derived.draft.slots[0].question.student.stem = 'DERIVED_ONLY';
  assert.deepEqual(saved.paper, before);
});

test('confirmation and competing source edit serialize so the reviewed revision cannot be overwritten', async t => {
  const f = await fixture(t);
  const [confirmed, changed] = await Promise.all([
    confirmPaper(f.storeRoot, f.draft.draftId, request(f.draft), f.options),
    updateDraft(f.storeRoot, f.draft.draftId, current => applyDraftOperation(current,
      { operationId: 'concurrent-edit', expectedRevision: 0, type: 'points', slotId: 'slot-1', points: 10, partPoints: [] })),
  ]);
  assert.equal(confirmed.ok, true);
  assert.equal(changed.error.code, 'finalized_draft');
  assert.equal(confirmed.paper.summary.student.points, 100);
  assert.equal((await readDraft(f.storeRoot, f.draft.draftId)).stats.availablePoints, 100);
});

test('persisted concurrent derivation is idempotent and retry preserves subsequent edits', async t => {
  const f = await fixture(t);
  const saved = await confirmPaper(f.storeRoot, f.draft.draftId, request(f.draft), f.options);
  const derivation = { operationId: 'derive-same-operation' };
  const results = await Promise.all([derivePaperDraft(f.storeRoot, f.papersRoot, saved.paper.paperId, derivation), derivePaperDraft(f.storeRoot, f.papersRoot, saved.paper.paperId, derivation)]);
  assert.ok(results.every(result => result.ok));
  assert.equal(results[0].draft.draftId, results[1].draft.draftId);
  assert.equal(results[1].replayed, true);
  assert.equal((await readdir(f.storeRoot)).filter(name => name.endsWith('.json')).length, 2);
  const changed = await updateDraft(f.storeRoot, results[0].draft.draftId, current => applyDraftOperation(current,
    { operationId: 'derived-score-edit', expectedRevision: 0, type: 'points', slotId: 'slot-1', points: 10, partPoints: [] }));
  assert.equal(changed.ok, true);
  const retry = await derivePaperDraft(f.storeRoot, f.papersRoot, saved.paper.paperId, derivation);
  assert.equal(retry.draft.revision, 1);
  assert.equal(retry.draft.stats.availablePoints, 102);
  assert.deepEqual((await getPaper(f.papersRoot, saved.paper.paperId)).paper, saved.paper);
  const conflicting = await derivePaperDraft(f.storeRoot, f.papersRoot, saved.paper.paperId, { ...derivation, unexpectedChange: true });
  assert.equal(conflicting.error.code, 'operation_conflict');
});
