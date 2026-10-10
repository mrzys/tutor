import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { getQuestion } from '../src/question-bank/reader.mjs';
import { previewBlueprint, createDraft } from '../src/assembly/engine.mjs';
import { previewDraftCandidates, applyDraftOperation } from '../src/assembly/editor.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const writeJson = (file, data) => writeFile(file, JSON.stringify(data, null, 2));
let sequence = 0;
const operation = (draft, type, rest = {}) => ({ operationId: `test-${++sequence}`, expectedRevision: draft.revision ?? 0, type, ...rest });
async function apply(draft, type, fields, options) {
  const result = await applyDraftOperation(draft, operation(draft, type, fields), options);
  assert.equal(result.ok, true, JSON.stringify(result)); return result;
}

async function baseline(options = {}) {
  const preview = await previewBlueprint({}, options);
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const generated = await createDraft(preview.blueprint, options);
  assert.equal(generated.ok, true, JSON.stringify(generated));
  // Controlled acceptance fixture: actual verified packages replace the first draft's choices.
  // These IDs belong only to the benchmark test, never to the selection implementation.
  const ids = ['001', '008', '022', '035', '045', '047', '018', '049', '050', '041'];
  for (const [index, id] of ids.entries()) {
    const read = await getQuestion(`tutor-set-${id}`, options);
    assert.equal(read.ok, true, JSON.stringify(read));
    generated.draft.slots[index].question = read.question;
    generated.draft.slots[index].selection = { ...generated.draft.slots[index].selection,
      selectedReason: { method: 'controlled_benchmark_fixture', text: '用于 S3-03 局部调整验收的真实题包受控标杆。' } };
  }
  return generated.draft;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tutor-editor-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('tutor-editor-test-'));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, 'data'), { recursive: true });
  await cp(path.join(repo, 'data', 'question-bank'), path.join(root, 'data', 'question-bank'), { recursive: true });
  await cp(path.join(repo, 'data', 'assembly'), path.join(root, 'data', 'assembly'), { recursive: true });
  const sources = await readJson(path.join(root, 'data', 'question-bank', 'sources.json'));
  for (const source of sources.sources) {
    await mkdir(path.dirname(path.join(root, source.path)), { recursive: true });
    await cp(path.join(repo, source.path), path.join(root, source.path));
  }
  return { root };
}

test('real controlled benchmark candidates respect complete task, pending partial material and occupied questions', async () => {
  const draft = await baseline();
  const preview = slotId => previewDraftCandidates(draft, { slotId, expectedRevision: 0 });
  const third = await preview('slot-3');
  assert.equal(third.ok, true);
  assert.deepEqual(third.candidates.map(item => item.questionId), ['tutor-set-020']);
  assert.ok(third.candidates[0].question.student.stem);
  assert.equal(third.candidates[0].canSelect, true);
  assert.equal(third.supply.ready, 18);
  assert.equal(third.pending.length, 32);
  const seventh = await preview('slot-7');
  assert.equal(seventh.candidates.length, 0);
  const partial = seventh.suggestions.find(item => item.questionId === 'tutor-set-019');
  assert.equal(partial.status, 'pending');
  assert.match(partial.reasons.join(';'), /未覆盖.*完整目标/);
  assert.equal(partial.question, undefined);
  const ninth = await preview('slot-9');
  assert.equal(ninth.candidates.length, 0);
  const occupied = ninth.suggestions.find(item => item.questionId === 'tutor-set-041');
  assert.equal(occupied.duplicate, true);
  assert.equal(occupied.canSelect, false);
  const forbidden = await apply(draft, 'replace', { slotIds: ['slot-9'], mode: 'direct', candidateId: 'tutor-set-041', allowDifference: true });
  assert.equal(forbidden.result.entries[0].status, 'unchanged');
  assert.deepEqual(forbidden.draft.slots, draft.slots);
});

test('batch replace keeps success, unsupported original, unrelated content and locks unchanged', async () => {
  let draft = await baseline();
  draft = (await apply(draft, 'lock', { slotId: 'slot-1', locked: true })).draft;
  const before = structuredClone(draft);
  const changed = await apply(draft, 'replace', { slotIds: ['slot-3', 'slot-8'], mode: 'direct' });
  assert.deepEqual(changed.result.entries.map(item => item.status), ['replaced', 'unchanged']);
  assert.equal(changed.draft.slots[2].question.questionId, 'tutor-set-020');
  for (let index = 0; index < draft.slots.length; index++) {
    if (index !== 2) assert.deepEqual(changed.draft.slots[index], before.slots[index]);
  }
  assert.deepEqual(changed.draft.baseline, before.baseline);
  assert.equal(changed.draft.slots[2].points, 8);
  assert.equal(changed.draft.slots[2].scoringStatus.status, 'unconfirmed');
  assert.equal(changed.draft.slots[2].scoringStatus.questionId, 'tutor-set-020');
  const actualNew = (await getQuestion('tutor-set-020')).question;
  assert.deepEqual(changed.draft.slots[2].question.teacher, actualNew.teacher);
});

test('034 replacement carries its actual fine-grained difference instead of promising full equivalence', async () => {
  const draft = await baseline();
  const changed = await apply(draft, 'replace', { slotIds: ['slot-4'], mode: 'direct', candidateId: 'tutor-set-034' });
  assert.equal(changed.result.entries[0].status, 'replaced');
  assert.ok(changed.result.entries[0].notes.length);
  assert.match(changed.result.entries[0].notes.join('；'), /差异|不同|不完全|不覆盖/);
  assert.deepEqual(changed.draft.slots[3].selection.selectedReason.notes, changed.result.entries[0].notes);
});

test('automatic actions skip locks while direct user replacement and difficulty adjustment can operate on locked slots', async () => {
  const initial = await baseline();
  const locked = (await apply(initial, 'lock', { slotId: 'slot-3', locked: true })).draft;
  const auto = await apply(locked, 'replace', { slotIds: ['slot-3'], mode: 'automatic' });
  assert.equal(auto.result.entries[0].status, 'skipped_locked');
  assert.deepEqual(auto.draft.slots, locked.slots);
  const harder = await apply(auto.draft, 'difficulty', { slotIds: ['slot-3', 'slot-4'], mode: 'automatic', targetDifficulty: 0.9 });
  assert.deepEqual(harder.result.entries.map(item => item.status), ['skipped_locked', 'unknown']);
  assert.equal(harder.draft.slots[2].targetDifficulty, undefined);
  assert.equal(harder.draft.slots[3].targetDifficulty, 0.9);
  const direct = await apply(harder.draft, 'replace', { slotIds: ['slot-3'], mode: 'direct' });
  assert.equal(direct.draft.slots[2].question.questionId, 'tutor-set-020');
  assert.equal(direct.draft.slots[2].locked, true);
  const directDifficulty = await apply(direct.draft, 'difficulty', { slotIds: ['slot-3'], mode: 'direct', targetDifficulty: 0.8 });
  assert.equal(directDifficulty.draft.slots[2].targetDifficulty, 0.8);
  assert.deepEqual(directDifficulty.draft.slots[2].question, direct.draft.slots[2].question);
  assert.equal(directDifficulty.draft.stats.difficultyEstimate, null);
});

test('delete and point edits update actual counts and totals without changing baseline or redistributing other questions', async () => {
  const original = await baseline();
  const deleted = await apply(original, 'delete', { slotId: 'slot-8' });
  assert.equal(deleted.draft.stats.selectedQuestions, 9);
  assert.equal(deleted.draft.stats.availablePoints, 90);
  assert.deepEqual(deleted.draft.slots.map(slot => slot.number), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(deleted.draft.baseline, original.baseline);
  assert.ok(deleted.draft.differences.some(item => item.code === 'slot_deleted' && item.slotId === 'slot-8'));
  const scored = await apply(original, 'points', { slotId: 'slot-8', points: 12, partPoints: [] });
  assert.equal(scored.draft.stats.selectedQuestions, 10);
  assert.equal(scored.draft.stats.availablePoints, 102);
  assert.equal(scored.draft.stats.plannedPoints, 102);
  assert.deepEqual(scored.draft.baseline, original.baseline);
  for (const slot of scored.draft.slots.filter(slot => slot.slotId !== 'slot-8')) assert.deepEqual(slot, original.slots.find(item => item.slotId === slot.slotId));
  assert.ok(scored.draft.differences.some(item => item.code === 'points_changed'));
});

test('new task slot uses real unoccupied supply and new IDs, unsupported slot remains empty', async () => {
  const original = await baseline();
  const added = await apply(original, 'add', { taskId: 'positive_integer_listing', points: 8, partPoints: [], afterSlotId: 'slot-3' });
  assert.equal(added.draft.slots.length, 11);
  const newSlot = added.draft.slots[3];
  assert.equal(newSlot.question.questionId, 'tutor-set-020');
  assert.notEqual(newSlot.slotId, original.slots[3].slotId);
  assert.equal(added.draft.stats.availablePoints, 108);
  assert.ok(added.draft.differences.some(item => item.code === 'slot_added'));
  const empty = await apply(original, 'add', { taskId: 'complement_quadratic_coefficients', points: 10, partPoints: [] });
  assert.equal(empty.draft.slots.at(-1).question, null);
  assert.equal(empty.draft.stats.plannedQuestions, 11);
  assert.equal(empty.draft.stats.selectedQuestions, 10);
  assert.equal(empty.draft.stats.plannedPoints, 110);
  assert.equal(empty.draft.stats.availablePoints, 100);
});

test('part allocations must match real parts and totals; score edit preserves the question and updates only its allocation', async () => {
  const draft = await baseline();
  for (const partPoints of [[{ partId: 'p1', points: 8 }, { partId: 'p2', points: 8 }], [{ partId: 'p1', points: 8 }, { partId: 'p1', points: 8 }], []]) {
    const invalid = await applyDraftOperation(draft, operation(draft, 'points', { slotId: 'slot-9', points: 15, partPoints }));
    assert.equal(invalid.error.code, 'invalid_operation');
  }
  const changed = await apply(draft, 'points', { slotId: 'slot-9', points: 15, partPoints: [{ partId: 'p1', points: 7 }, { partId: 'p2', points: 8 }] });
  assert.equal(changed.draft.stats.availablePoints, 101);
  assert.deepEqual(changed.draft.slots[8].question, draft.slots[8].question);
  assert.equal(changed.draft.slots[8].scoringStatus.status, 'unconfirmed');
  const badAdd = await applyDraftOperation(draft, operation(draft, 'add', { taskId: 'interval_complement_parameter', points: 15,
    partPoints: [{ partId: 'p1', points: 7 }, { partId: 'p2', points: 9 }] }));
  assert.equal(badAdd.error.code, 'invalid_operation');
});

test('baseline correction archives current confirmed basis, retains questions and locks, and marks removed Vieta path unknown', async () => {
  let draft = await baseline();
  draft = (await apply(draft, 'lock', { slotId: 'slot-8', locked: true })).draft;
  const corrected = await apply(draft, 'baseline', { requirements: { premises: draft.baseline.requirements.premises.filter(id => id !== 'vieta') } });
  assert.equal(corrected.draft.baseline.version, 2);
  assert.equal(corrected.draft.baselineHistory.length, 1);
  assert.deepEqual(corrected.draft.baselineHistory[0], draft.baseline);
  assert.equal(corrected.draft.slots[7].question.questionId, 'tutor-set-049');
  assert.equal(corrected.draft.slots[7].locked, true);
  assert.equal(corrected.draft.slots[7].applicability.status, 'unknown');
  assert.equal(corrected.draft.stats.selectedQuestions, 10);
  assert.equal(corrected.draft.stats.availablePoints, 100);
  assert.ok(corrected.draft.differences.some(item => item.slotId === 'slot-8' && item.code === 'applicability_unconfirmed'));
  for (let i = 0; i < draft.slots.length; i++) assert.deepEqual(corrected.draft.slots[i].question, draft.slots[i].question);
  assert.deepEqual(corrected.draft.retrieval.conditions, corrected.draft.baseline.requirements);
  assert.ok(corrected.draft.baseline.sourceManifest.sources.every(source => source.sha256));
  const badSource = await applyDraftOperation(corrected.draft, operation(corrected.draft, 'baseline', { requirements: { sourceIds: ['unverified-source'] } }));
  assert.equal(badSource.error.code, 'invalid_plan');
});

test('explicit complete ready difference/unknown selection is opt-in and never silently relabelled eligible', async () => {
  const original = await baseline();
  const corrected = (await apply(original, 'baseline', { requirements: { learnedScope: ['1.1'] } })).draft;
  const preview = await previewDraftCandidates(corrected, { slotId: 'slot-4', expectedRevision: corrected.revision });
  const unknown = preview.suggestions.find(item => item.questionId === 'tutor-set-034');
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.canSelect, true);
  assert.ok(unknown.question.student.stem);
  const safe = await apply(corrected, 'replace', { slotIds: ['slot-4'], mode: 'direct', candidateId: 'tutor-set-034' });
  assert.equal(safe.result.entries[0].status, 'unchanged');
  const explicit = await apply(safe.draft, 'replace', { slotIds: ['slot-4'], mode: 'direct', candidateId: 'tutor-set-034', allowDifference: true });
  assert.equal(explicit.result.entries[0].status, 'replaced');
  assert.equal(explicit.draft.slots[3].applicability.status, 'unknown');
  assert.equal(explicit.draft.slots[3].selection.selectedReason.method, 'explicit_difference_selection');
  const pending = await apply(explicit.draft, 'replace', { slotIds: ['slot-7'], mode: 'direct', candidateId: 'tutor-set-019', allowDifference: true });
  assert.equal(pending.result.entries[0].status, 'unchanged');
  const occupiedUnknown = await previewDraftCandidates(explicit.draft, { slotId: 'slot-9', expectedRevision: explicit.draft.revision });
  const duplicate = occupiedUnknown.suggestions.find(item => item.questionId === 'tutor-set-041');
  assert.equal(duplicate.status, 'unknown');
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.canSelect, false);
  const duplicateAttempt = await apply(explicit.draft, 'replace', { slotIds: ['slot-9'], mode: 'direct', candidateId: 'tutor-set-041', allowDifference: true });
  assert.equal(duplicateAttempt.result.entries[0].status, 'unchanged');
});

test('idempotent retry preserves current draft after later changes; reused IDs and late suggestions fail distinctly', async () => {
  const initial = await baseline();
  const request = operation(initial, 'replace', { slotIds: ['slot-3', 'slot-8'], mode: 'direct' });
  const first = await applyDraftOperation(initial, request);
  assert.equal(first.ok, true);
  const later = await apply(first.draft, 'points', { slotId: 'slot-8', points: 12, partPoints: [] });
  const retry = await applyDraftOperation(later.draft, request);
  assert.equal(retry.ok, true);
  assert.equal(retry.result.replayed, true);
  assert.deepEqual(retry.draft, later.draft);
  assert.deepEqual(retry.result.entries, first.result.entries);
  assert.equal(retry.draft.operations.length, 2);
  const conflict = await applyDraftOperation(later.draft, { ...request, slotIds: ['slot-2'] });
  assert.equal(conflict.error.code, 'operation_conflict');
  const stale = await applyDraftOperation(later.draft, operation(initial, 'lock', { slotId: 'slot-3', locked: true }));
  assert.equal(stale.error.code, 'revision_conflict');
  assert.equal((await previewDraftCandidates(later.draft, { slotId: 'slot-3', expectedRevision: 0 })).error.code, 'revision_conflict');
});

test('injected candidate read failure retains existing question and separate successful batch item', async t => {
  const options = await fixture(t); const original = await baseline(options);
  const file = path.join(options.root, 'data', 'question-bank', 'questions', 'tutor-set-020.json');
  await writeFile(file, '{INJECTED_READ_FAILURE');
  const failed = await apply(original, 'replace', { slotIds: ['slot-3', 'slot-4'], mode: 'direct' }, options);
  assert.deepEqual(failed.result.entries.map(item => item.status), ['read_failed', 'replaced']);
  assert.deepEqual(failed.draft.slots[2], original.slots[2]);
  assert.equal(failed.draft.slots[3].question.questionId, 'tutor-set-034');
  assert.ok(failed.result.entries[0].failures.some(item => item.questionId === 'tutor-set-020'));
  assert.equal(failed.draft.stats.availablePoints, 100);
});

test('baseline recheck preserves pinned question when content cannot be read and never calls it verified', async t => {
  const options = await fixture(t); const original = await baseline(options);
  await writeFile(path.join(options.root, 'data', 'question-bank', 'questions', 'tutor-set-049.json'), '{INJECTED_READ_FAILURE');
  const corrected = await apply(original, 'baseline', { requirements: { learnedScope: ['1.1', '1.2'] } }, options);
  assert.deepEqual(corrected.draft.slots[7].question, original.slots[7].question);
  assert.equal(corrected.draft.slots[7].applicability.status, 'read_failed');
  assert.equal(corrected.result.entries[7].status, 'read_failed');
});

test('preview is read-only and malformed operations never mutate caller input', async () => {
  const draft = await baseline(); const before = structuredClone(draft);
  assert.equal((await previewDraftCandidates(draft, { slotId: 'slot-3', expectedRevision: 0 })).ok, true);
  for (const rest of [{ type: 'delete', slotId: 'missing' }, { type: 'lock', slotId: 'slot-1', locked: 'true' },
    { type: 'difficulty', slotIds: ['slot-1'], mode: 'automatic', targetDifficulty: 2 },
    { type: 'replace', slotIds: ['slot-1', 'slot-1'], mode: 'direct' }, { type: 'unsupported' }]) {
    const failed = await applyDraftOperation(draft, { operationId: `invalid-${++sequence}`, expectedRevision: 0, ...rest });
    assert.equal(failed.error.code, 'invalid_operation');
  }
  assert.deepEqual(draft, before);
});
