import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkBlueprintSupply } from '../scripts/check-blueprint-supply.mjs';
import { getAssemblyConfig, previewBlueprint, createDraft } from '../src/assembly/engine.mjs';

test('expanded real bank supplies every visible task, exhausts repeated supply, and respects learned boundaries', async () => {
  const result = await checkBlueprintSupply();
  assert.equal(result.ready, 45);
  assert.equal(result.pending, 5);
  assert.equal(result.taskCount, 34);
  assert.equal(result.allTasks.uniqueParents, 34);
});

test('geometry-dependent set tasks stay empty until junior geometry is explicitly allowed', async () => {
  const loaded = await getAssemblyConfig();
  assert.equal(loaded.config.defaultRequirements.premises.includes('basic_geometry'), false);
  const index = JSON.parse(await readFile(new URL('../data/assembly/question-index.json', import.meta.url), 'utf8'));
  const ids = ['tutor-set-014', 'tutor-set-017'];
  const tasks = ids.map(id => index.entries.find(entry => entry.questionId === id).tasks[0]);
  for (const allowed of [false, true]) {
    const proposed = await previewBlueprint({ counts: { single_choice: 2, fill_blank: 0, free_response: 0 },
      premises: allowed ? ['basic_geometry'] : [] });
    proposed.blueprint.slots.forEach((slot, i) => { slot.taskId = tasks[i]; });
    const result = await createDraft(proposed.blueprint);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.draft.stats.selectedQuestions, allowed ? 2 : 0);
    if (allowed) assert.deepEqual(result.draft.slots.map(slot => slot.question.questionId), ids);
    else assert.ok(result.draft.slots.every(slot => slot.question === null));
  }
});

test('new packages do not inherit unreviewed four-dimensional goal support or readiness of unresolved originals', async () => {
  const ledger = JSON.parse(await readFile(new URL('../data/question-bank/ledger.json', import.meta.url), 'utf8'));
  assert.deepEqual(ledger.entries.filter(q => q.status === 'pending').map(q => q.questionId),
    ['015', '019', '021', '025', '032'].map(id => `tutor-set-${id}`));
  const analysis = JSON.parse(await readFile(new URL('../data/pedagogy/set-questions-analysis.json', import.meta.url), 'utf8'));
  assert.equal(analysis.questions.length, 18);
  assert.ok(analysis.questions.every(q => q.verificationStatus !== 'evidence_verified'));
});
