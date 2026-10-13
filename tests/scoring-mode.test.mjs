import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createIntakeService } from '../src/intake/service.mjs';
import { createMemoryIntakeStorage } from '../src/intake/storage.mjs';
import { previewBlueprint, recheckBlueprint, createDraft } from '../src/assembly/engine.mjs';
import { planBlueprint } from '../src/assembly/planner.mjs';
import { applyDraftOperation } from '../src/assembly/editor.mjs';
import { preparePaperConfirmation, confirmPaper, deriveDraftFromPaper } from '../src/assembly/papers.mjs';
import { saveDraft, listDrafts } from '../src/assembly/store.mjs';
import { projectPaper, generatePaperOutput, findPdfPython } from '../src/output/pdf.mjs';

let n = 0;
const op = () => `scoring-${++n}`;
async function act(service, session, action, extra = {}) {
  const result = await service.handle({ action, sessionId: session.sessionId, revision: session.revision, operationId: op(), ...extra });
  assert.equal(result.ok, true, JSON.stringify(result)); return result.session;
}
async function edit(draft, operation) {
  const result = await applyDraftOperation(draft, { expectedRevision: draft.revision ?? 0, operationId: op(), ...operation });
  assert.equal(result.ok, true, JSON.stringify(result)); return result.draft;
}
const assertUnscored = draft => {
  assert.equal(draft.baseline.requirements.scoringMode, 'none');
  assert.equal(draft.baseline.requirements.targetScore, 0);
  assert.equal(draft.stats.plannedPoints, 0); assert.equal(draft.stats.availablePoints, 0);
  assert.ok(draft.slots.every(slot => slot.points === 0 && slot.partPoints.every(part => part.points === 0)));
  assert.ok(!draft.differences.some(item => /score|points/.test(item.code)));
};

test('new practices default to no scoring and changing purpose preserves an explicit scoring choice', async () => {
  const service = createIntakeService();
  let session = (await service.handle({ action: 'start', flow: 'quick', operationId: op() })).session;
  assert.equal(session.answers.scoringMode, 'none'); assert.equal(session.requirements.targetScore, 0);
  for (const purpose of ['targeted_practice', 'diagnostic', 'assessment', 'mock_exam', 'consolidation']) {
    session = await act(service, session, 'answer', { answers: { purpose } });
    assert.equal(session.requirements.scoringMode, 'none'); assert.equal(session.requirements.targetScore, 0);
  }
  session = await act(service, session, 'answer', { answers: { scoringMode: 'points', targetScore: 80 } });
  for (const purpose of ['targeted_practice', 'diagnostic', 'consolidation']) {
    session = await act(service, session, 'answer', { answers: { purpose } });
    assert.equal(session.requirements.scoringMode, 'points'); assert.equal(session.requirements.targetScore, 80);
  }
});

test('explicit teacher total becomes a visible pending points proposal, adopted only on confirmation', async () => {
  const storage = createMemoryIntakeStorage();
  const service = createIntakeService({ storage, gateway: { async propose(_context, { validate }) {
    return { ok: true, proposal: validate({ summary: '按教师指定80分整理。', changes: { targetScore: 80 }, blocks: [] }), run: { status: 'succeeded' } };
  } } });
  let session = (await service.handle({ action: 'start', flow: 'quick', operationId: op() })).session;
  session = await act(service, session, 'prepare', { message: '4题，80分', answers: { questionCount: 4 } });
  assert.equal(session.requirements.targetScore, 0);
  assert.equal(session.proposal.changes.scoringMode, 'points'); assert.equal(session.proposal.changes.targetScore, 80);
  assert.match(session.proposal.summary, /80 分/);
  session = await act(service, session, 'answer', { acceptProposal: true });
  session = await act(service, session, 'confirm');
  assert.equal(session.requirements.scoringMode, 'points'); assert.equal(session.requirements.targetScore, 80);
  assert.equal((await service.get(session.sessionId)).session.requirements.targetScore, 80);
});

test('LLM cannot override a manually locked no-score choice with a total', async () => {
  const service = createIntakeService({ gateway: { async propose(_context, { validate }) {
    return { ok: true, proposal: validate({ summary: '建议80分。', changes: { targetScore: 80 }, blocks: [] }) };
  } } });
  let session = (await service.handle({ action: 'start', flow: 'quick', operationId: op() })).session;
  session = await act(service, session, 'prepare', { message: '基础练习', lockedFields: ['scoringMode'] });
  assert.equal(session.proposal, null); assert.equal(session.requirements.scoringMode, 'none'); assert.equal(session.requirements.targetScore, 0);
});

test('unscored blueprints, replacements, additions, baselines, snapshots and derivation retain zero allocations', async () => {
  const preview = await previewBlueprint({ scoringMode: 'none', targetScore: 100 });
  assert.equal(preview.ok, true); assert.equal(preview.blueprint.requirements.targetScore, 0);
  const checked = await recheckBlueprint({ ...preview.blueprint, slots: preview.blueprint.slots.map(slot => ({ ...slot, points: 20, partPoints: slot.partPoints.map(part => ({ ...part, points: 10 })) })) });
  assert.equal(checked.ok, true); assert.equal(checked.blueprint.plannedStats.points, 0);
  let draft = (await createDraft(checked.blueprint)).draft; assertUnscored(draft);
  draft = await edit(draft, { type: 'replace', slotIds: [draft.slots[0].slotId], mode: 'direct' }); assertUnscored(draft);
  draft = await edit(draft, { type: 'add', taskId: 'set_determinacy', points: 8 }); assertUnscored(draft);
  draft = await edit(draft, { type: 'delete', slotId: draft.slots.at(-1).slotId }); assertUnscored(draft);
  const refused = await applyDraftOperation(draft, { type: 'points', slotId: draft.slots[0].slotId, points: 8, expectedRevision: draft.revision, operationId: op() });
  assert.equal(refused.ok, false);
  draft = await edit(draft, { type: 'baseline', requirements: { title: '不计分集合练习' } }); assertUnscored(draft);
  const summary = preparePaperConfirmation(draft);
  assert.equal(summary.scoringMode, 'none'); assert.deepEqual(summary.scoringIssues, []);
  assert.ok(!summary.teacher.issues.some(issue => issue.code === 'rubric_missing'));
  const root = await mkdtemp(path.join(tmpdir(), 'tutor-scoring-snapshot-'));
  const storeRoot = path.join(root, 'drafts'); await saveDraft(storeRoot, draft);
  assert.equal((await listDrafts(storeRoot)).drafts[0].scoringMode, 'none');
  const confirmed = await confirmPaper(storeRoot, draft.draftId, { operationId: op(), expectedRevision: draft.revision, acknowledgeDifferences: true }, { papersRoot: path.join(root, 'papers') });
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
  assertUnscored(confirmed.paper.draft);
  const derived = deriveDraftFromPaper(confirmed.paper); assert.equal(derived.ok, true); assertUnscored(derived.draft);
});

test('LLM blueprint plans zero points for practice and rejects a scored proposal in none mode', async () => {
  const requirements = { scoringMode: 'none', counts: { single_choice: 2, fill_blank: 0, free_response: 0 } };
  const proposal = { summary: '两个概念辨析任务。', slots: ['set_determinacy', 'number_membership'].map(taskId => ({ taskId, points: 0, goalIds: [], rationale: '练习集合概念。' })) };
  const gateway = { async propose(context) {
    assert.deepEqual(context.scoreReference.slotPoints, [0, 0]); assert.equal(context.requirements.targetScore, 0);
    return { ok: true, proposal };
  } };
  const planned = await planBlueprint(requirements, { gateway }); assert.equal(planned.ok, true, JSON.stringify(planned));
  assert.equal(planned.blueprint.plannedStats.points, 0);
  const rejected = await planBlueprint(requirements, { gateway: { async propose() { return { ok: true, proposal: { ...proposal, slots: proposal.slots.map(slot => ({ ...slot, points: 1 })) } }; } } });
  assert.equal(rejected.ok, false); assert.equal(rejected.error.code, 'invalid_plan');
  const scored = await planBlueprint({ ...requirements, scoringMode: 'points', targetScore: 2 }, { gateway: { async propose() { return { ok: true, proposal: { ...proposal, slots: proposal.slots.map((slot, index) => ({ ...slot, points: index ? 2 : 0 })) } }; } } });
  assert.equal(scored.ok, false); assert.equal(scored.error.code, 'invalid_plan');
});

test('real unscored student and teacher PDFs omit assigned scores and rubric requirements; old missing mode stays scored', async () => {
  const old = (await createDraft((await previewBlueprint()).blueprint)).draft;
  assert.equal(old.baseline.requirements.scoringMode, undefined); assert.equal(old.stats.availablePoints, 100);
  assert.equal(preparePaperConfirmation(old).scoringMode, 'points');
  const draft = (await createDraft((await previewBlueprint({ scoringMode: 'none' })).blueprint)).draft;
  const paper = { paperId: 'unscored-paper', title: draft.title, draft, summary: preparePaperConfirmation(draft) };
  assert.equal(projectPaper(paper, 'student').points, 0);
  assert.ok(projectPaper(paper, 'teacher').slots.every(slot => !slot.teacher?.scoringSuggestions));
  assert.ok(!projectPaper(paper, 'teacher').issues.some(issue => /评分/.test(issue)));
  const outputRoot = await mkdtemp(path.join(tmpdir(), 'tutor-no-score-pdf-'));
  for (const kind of ['student', 'teacher']) {
    const result = await generatePaperOutput(paper, kind, { outputRoot }); assert.equal(result.ok, true, result.error?.message);
    const script = 'import sys,json;from pypdf import PdfReader;print(json.dumps("\\n".join(p.extract_text(extraction_mode="layout") for p in PdfReader(sys.argv[1]).pages)))';
    const text = JSON.parse((await promisify(execFile)(await findPdfPython(), ['-c', script, result.artifact.path], { encoding: 'utf8', windowsHide: true })).stdout);
    assert.match(text, /共 10 题/); assert.match(text, /10\./);
    assert.doesNotMatch(text, /100 分|0 分|本卷赋分|评分建议|有效分值|赋分检查/);
    if (kind === 'teacher') { assert.match(text, /参考答案/); assert.match(text, /解析/); }
    else { assert.doesNotMatch(text, /参考答案|参考解析|答案速查/); }
  }
});
