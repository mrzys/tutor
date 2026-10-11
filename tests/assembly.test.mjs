import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { hashContent } from '../src/question-bank/reader.mjs';
import { getAssemblyConfig, previewBlueprint, recheckBlueprint, createDraft } from '../src/assembly/engine.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const readJson = async target => JSON.parse(await readFile(target, 'utf8'));
const writeJson = (target, value) => writeFile(target, JSON.stringify(value, null, 2), 'utf8');
const sum = values => values.reduce((a, b) => a + b, 0);

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tutor-assembly-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('tutor-assembly-test-'));
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
  return { root, indexPath: path.join(root, 'data', 'assembly', 'question-index.json'),
    ledgerPath: path.join(root, 'data', 'question-bank', 'ledger.json') };
}

test('real default preview and draft use the current 50-unit bank, with ten unique complete selected questions', async () => {
  const config = await getAssemblyConfig();
  assert.equal(config.ok, true);
  const preview = await previewBlueprint(config.config.defaultRequirements);
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.deepEqual(preview.blueprint.plannedStats, { questionCount: 10, points: 100 });
  assert.equal(preview.blueprint.supply.sourceUnits, 50);
  assert.equal(preview.blueprint.supply.ready, 45);
  assert.equal(preview.blueprint.supply.pendingCount, 5);
  assert.equal(preview.blueprint.supply.pending.length, 5);
  assert.deepEqual(preview.blueprint.slots.map(slot => slot.points), [8, 8, 8, 8, 8, 8, 10, 10, 14, 18]);
  assert.deepEqual(preview.blueprint.slots.filter(slot => slot.questionType === 'free_response').map(slot => slot.partPoints.map(part => part.points)), [[6, 8], [8, 10]]);
  const generated = await createDraft(preview.blueprint);
  assert.equal(generated.ok, true, JSON.stringify(generated));
  const { draft } = generated;
  assert.equal(draft.stats.selectedQuestions, 10);
  assert.equal(draft.stats.availablePoints, 100);
  assert.equal(draft.stats.difficultyEstimate, null);
  assert.equal(new Set(draft.slots.map(slot => slot.question.questionId)).size, 10);
  assert.equal(new Set(draft.slots.map(slot => slot.selection.candidates.find(candidate => candidate.questionId === slot.question.questionId).duplicateGroup)).size, 10);
  for (const slot of draft.slots) {
    assert.ok(slot.question.student.stem);
    assert.equal(slot.question.verification.result, 'pass');
    assert.equal(slot.question.contentVersion, slot.question.scopeEvidence.contentVersion);
    assert.ok(slot.selection.selectedReason.allowedSolutionPath.basis);
    assert.equal(slot.status, 'selected');
  }
  const annotations = await readJson(path.join(repo, 'data', 'assembly', 'question-index.json'));
  for (const slot of draft.slots) {
    assert.deepEqual(slot.selection.selectedReason.notes, annotations.entries.find(item => item.questionId === slot.question.questionId).notes);
  }
  const repeat = await createDraft(preview.blueprint);
  assert.deepEqual(repeat.draft.slots.map(slot => slot.question.questionId), draft.slots.map(slot => slot.question.questionId));
  assert.notEqual(repeat.draft.draftId, draft.draftId);
});

test('explicit removal of Vieta keeps the unsupported fill slot empty and preserves other selected questions', async () => {
  const config = (await getAssemblyConfig()).config;
  const preview = await previewBlueprint({ ...config.defaultRequirements, premises: config.defaultRequirements.premises.filter(id => id !== 'vieta') });
  const generated = await createDraft(preview.blueprint);
  assert.equal(generated.ok, true);
  const unknownFill = generated.draft.slots.filter(slot => slot.questionType === 'fill_blank' && slot.status === 'empty');
  assert.equal(unknownFill.length, 1);
  assert.equal(generated.draft.stats.selectedQuestions, 9);
  assert.equal(generated.draft.stats.availablePoints, 90);
  assert.ok(unknownFill[0].selection.candidates.some(candidate => candidate.status === 'unknown'));
  assert.ok(unknownFill[0].selection.suggestions.length);
});

test('removing all explicit tools preserves automatically injected foundation-only solutions', async () => {
  const { blueprint } = await previewBlueprint({ premises: [] });
  const generated = await createDraft(blueprint);
  assert.equal(generated.ok, true);
  const { draft } = generated;
  assert.deepEqual(draft.baseline.requirements.premises, []);
  assert.equal(draft.stats.selectedQuestions, 7);
  assert.equal(draft.stats.availablePoints, 64);
  const foundation = draft.baseline.courseContext.foundation.join('；');
  assert.match(foundation, /平方根/);
  assert.match(foundation, /绝对值.*基本.*计算/);
  for (const identity of ['tutor-set-001', 'tutor-set-018', 'tutor-set-045']) {
    const slot = draft.slots.find(item => item.question?.questionId === identity);
    assert.ok(slot, `${identity} must remain selected through its recorded foundation-only path`);
    assert.deepEqual(slot.selection.selectedReason.allowedSolutionPath.requiredPremises, []);
  }
  assert.equal(draft.slots[0].selection.selectedReason.allowedSolutionPath.id, 'square-root-path');
  for (const number of [6, 8, 10]) {
    const slot = draft.slots.find(item => item.number === number);
    assert.equal(slot.status, 'empty');
    assert.equal(slot.question, null);
    assert.ok(slot.selection.candidates.some(candidate => candidate.status === 'unknown'));
    assert.equal(slot.selection.failures.length, 0);
  }
});

test('narrowed learned scope cannot silently use unconfirmed complete solution paths', async () => {
  const preview = await previewBlueprint({ learnedScope: ['1.1'] });
  const generated = await createDraft(preview.blueprint);
  assert.equal(generated.ok, true);
  assert.ok(generated.draft.stats.missingQuestions > 0);
  assert.ok(generated.draft.slots.filter(slot => slot.questionType === 'free_response').every(slot => slot.question === null));
  for (const slot of generated.draft.slots.filter(slot => slot.question)) {
    assert.ok(slot.selection.selectedReason.allowedSolutionPath.requiredSections.every(section => section === '1.1'));
  }
});

test('empty source or main scope remains empty instead of reverting to default source or scope', async () => {
  for (const requirements of [{ sourceIds: [] }, { mainScope: [] }]) {
    const preview = await previewBlueprint(requirements);
    assert.equal(preview.ok, true);
    const generated = await createDraft(preview.blueprint);
    assert.equal(generated.ok, true);
    assert.equal(generated.draft.stats.selectedQuestions, 0);
    assert.ok(generated.draft.slots.every(slot => slot.status === 'empty'));
    assert.equal(generated.draft.retrieval.failures.length, 0);
  }
});

test('requested repeated slots exhaust real candidates without duplicating or inventing questions', async () => {
  const preview = await previewBlueprint({ counts: { single_choice: 30, fill_blank: 0, free_response: 0 } });
  assert.equal(preview.ok, true);
  assert.equal(sum(preview.blueprint.slots.map(slot => slot.points)), 100);
  const generated = await createDraft(preview.blueprint);
  assert.equal(generated.ok, true);
  const selected = generated.draft.slots.filter(slot => slot.question);
  assert.ok(selected.length > 0 && selected.length < 30);
  assert.equal(new Set(selected.map(slot => slot.question.questionId)).size, selected.length);
  assert.ok(generated.draft.slots.some(slot => slot.selection.candidates.some(candidate => candidate.reasons.includes('本卷已使用同题或重复组'))));
});

test('target-score allocation is deterministic and edited confirmed point totals are not silently restored', async () => {
  const preview = await previewBlueprint({ targetScore: 103 });
  assert.equal(sum(preview.blueprint.slots.map(slot => slot.points)), 103);
  for (const slot of preview.blueprint.slots.filter(slot => slot.questionType === 'free_response')) assert.equal(sum(slot.partPoints.map(part => part.points)), slot.points);
  const repeated = await previewBlueprint({ targetScore: 103 });
  assert.deepEqual(repeated.blueprint.slots, preview.blueprint.slots);
  preview.blueprint.slots[0].points += 2;
  const generated = await createDraft(preview.blueprint);
  assert.equal(generated.ok, true);
  assert.equal(generated.draft.stats.plannedPoints, 105);
  assert.equal(generated.draft.stats.availablePoints, 105);
  assert.ok(generated.draft.differences.some(item => item.code === 'planned_score_differs' && item.actual === 105));
  assert.equal(generated.draft.baseline.requirements.targetScore, 103);
});

test('malformed numeric requirements and inconsistent edited blueprints fail before selection', async () => {
  for (const requirements of [{ targetDifficulty: NaN }, { targetScore: -1 }, { durationMinutes: Infinity }, { mainScope: ['unknown'] },
    { sourceIds: ['unregistered'] }, { counts: { single_choice: 31, fill_blank: 0, free_response: 0 } },
    { counts: { single_choice: 30, fill_blank: 30, free_response: 1 } }]) {
    assert.equal((await previewBlueprint(requirements)).error.code, 'invalid_plan');
  }
  const { blueprint } = await previewBlueprint();
  for (const mutate of [
    plan => { plan.slots[1].slotId = plan.slots[0].slotId; },
    plan => { plan.slots[0].taskId = plan.slots.at(-1).taskId; },
    plan => { plan.slots[0].points = -1; },
    plan => { plan.slots.at(-1).partPoints[0].points++; },
    plan => { plan.slots.pop(); },
  ]) {
    const plan = structuredClone(blueprint); mutate(plan);
    assert.equal((await createDraft(plan)).error.code, 'invalid_plan');
  }
});

test('stale annotation versions remain unknown instead of qualifying real current content', async t => {
  const f = await fixture(t);
  const index = await readJson(f.indexPath);
  for (const entry of index.entries) entry.contentVersion = 'content-stale';
  await writeJson(f.indexPath, index);
  const preview = await previewBlueprint({}, { root: f.root });
  assert.equal(preview.ok, true);
  assert.ok(preview.blueprint.supply.slotSupply.every(slot => slot.eligibleCount === 0 && slot.unknownCount > 0));
  const generated = await createDraft(preview.blueprint, { root: f.root });
  assert.equal(generated.ok, true);
  assert.equal(generated.draft.stats.selectedQuestions, 0);
  assert.equal(generated.draft.retrieval.failures.length, 0);
});

test('a real unreadable candidate produces retrieval failure, distinct from zero qualifying candidates', async t => {
  const f = await fixture(t);
  const initial = await previewBlueprint({}, { root: f.root });
  const singleSlot = initial.blueprint.slots.find(slot => initial.blueprint.supply.slotSupply.find(item => item.slotId === slot.slotId).eligibleCount === 1);
  const draftBefore = await createDraft(initial.blueprint, { root: f.root });
  const identity = draftBefore.draft.slots.find(slot => slot.slotId === singleSlot.slotId).question.questionId;
  const ledger = await readJson(f.ledgerPath);
  const entry = ledger.entries.find(item => item.questionId === identity);
  await writeFile(path.join(f.root, 'data', 'question-bank', entry.contentPath), '{invalid json');
  const generated = await createDraft(initial.blueprint, { root: f.root });
  assert.equal(generated.ok, true);
  const slot = generated.draft.slots.find(item => item.slotId === singleSlot.slotId);
  assert.equal(slot.status, 'search_failed');
  assert.equal(slot.question, null);
  assert.ok(slot.selection.failures.some(item => item.questionId === identity && item.errorCode === 'read_error'));
  assert.ok(generated.draft.retrieval.failures.some(item => item.questionId === identity));
  assert.ok(generated.draft.stats.selectedQuestions > 0);
});

test('missing teacher answers alone do not block an otherwise verified and applicable student question', async t => {
  const f = await fixture(t);
  const { blueprint } = await previewBlueprint({}, { root: f.root });
  const initial = await createDraft(blueprint, { root: f.root });
  const identity = initial.draft.slots[0].question.questionId;
  const ledger = await readJson(f.ledgerPath);
  const entry = ledger.entries.find(item => item.questionId === identity);
  const recordPath = path.join(f.root, 'data', 'question-bank', entry.contentPath);
  const record = await readJson(recordPath);
  record.teacher = { answers: [], solutions: [], scoringSuggestions: [] };
  record.teacherSha256 = hashContent(record.teacher);
  record.teacherVersion = `teacher-${record.teacherSha256.slice(0, 16)}`;
  record.scopeEvidence.teacherVersion = record.teacherVersion;
  record.verification.teacherVersion = record.teacherVersion;
  entry.teacherVersion = record.teacherVersion;
  const index = await readJson(f.indexPath);
  index.entries.find(item => item.questionId === identity).teacherVersion = record.teacherVersion;
  await Promise.all([writeJson(recordPath, record), writeJson(f.ledgerPath, ledger), writeJson(f.indexPath, index)]);
  const generated = await createDraft(blueprint, { root: f.root });
  assert.equal(generated.ok, true);
  assert.equal(generated.draft.slots[0].question.questionId, identity);
  assert.deepEqual(generated.draft.slots[0].question.teacher.answers, []);
  assert.equal(generated.draft.stats.selectedQuestions, 10);
});

test('edited task supply is checked again without regenerating the plan or changing edited points', async () => {
  const { blueprint } = await previewBlueprint();
  const config = (await getAssemblyConfig()).config;
  const edited = structuredClone(blueprint);
  const first = edited.slots[0];
  const alternativeSlot = blueprint.slots.find(slot => slot.questionType === first.questionType
    && blueprint.supply.slotSupply.find(item => item.slotId === slot.slotId).eligibleCount
      !== blueprint.supply.slotSupply[0].eligibleCount);
  assert.ok(alternativeSlot);
  first.taskId = alternativeSlot.taskId;
  first.points += 3;
  const checked = await recheckBlueprint(edited);
  assert.equal(checked.ok, true, JSON.stringify(checked));
  assert.equal(checked.blueprint.slots[0].points, first.points);
  assert.equal(checked.blueprint.slots[0].taskId, alternativeSlot.taskId);
  assert.equal(checked.blueprint.slots[0].taskLabel, config.tasks.find(task => task.id === alternativeSlot.taskId).label);
  assert.equal(checked.blueprint.supply.slotSupply[0].eligibleCount,
    blueprint.supply.slotSupply.find(item => item.slotId === alternativeSlot.slotId).eligibleCount);
  assert.notEqual(checked.blueprint.supply.slotSupply[0].eligibleCount, blueprint.supply.slotSupply[0].eligibleCount);
  assert.equal(checked.blueprint.plannedStats.points, 103);
  assert.deepEqual(edited.slots[0], first);
  edited.slots.at(-1).partPoints[0].points++;
  assert.equal((await recheckBlueprint(edited)).error.code, 'invalid_plan');
});

test('confirmed baseline preserves allowed foundation, dependencies, source hashes, task definitions and all version-bound paths', async t => {
  const f = await fixture(t);
  const contextPath = path.join(f.root, 'data', 'question-bank', 'course-context.json');
  const originalContext = await readJson(contextPath);
  const sourceManifest = await readJson(path.join(f.root, 'data', 'question-bank', 'sources.json'));
  const index = await readJson(f.indexPath);
  const config = (await getAssemblyConfig({ root: f.root })).config;
  assert.deepEqual(config.courseContext, originalContext);
  assert.deepEqual(config.sourceManifest, sourceManifest);
  const { blueprint } = await previewBlueprint({}, { root: f.root });
  const { draft } = await createDraft(blueprint, { root: f.root });
  assert.deepEqual(draft.baseline.courseContext, originalContext);
  assert.deepEqual(draft.baseline.sourceManifest, sourceManifest);
  assert.deepEqual(draft.baseline.questionIndexSnapshot, index);
  assert.deepEqual(draft.baseline.taskCatalogSnapshot.tasks, config.tasks);
  assert.ok(draft.baseline.courseContext.foundation.length);
  assert.ok(draft.baseline.courseContext.dependencies.length);
  originalContext.foundation.push('LATER_CONTEXT_CHANGE');
  await writeJson(contextPath, originalContext);
  config.tasks[0].label = 'LATER_TASK_CHANGE';
  assert.equal(JSON.stringify(draft.baseline).includes('LATER_'), false);
  await writeFile(contextPath, '{invalid');
  assert.equal((await getAssemblyConfig({ root: f.root })).error.code, 'read_error');
  assert.equal((await createDraft(blueprint, { root: f.root })).error.code, 'read_error');
});
