import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { applyDraftOperation } from '../src/assembly/editor.mjs';
import { saveDraft, readDraft, listDrafts, updateDraft } from '../src/assembly/store.mjs';
import { createIntakeService } from '../src/intake/service.mjs';
import { automaticTitle, legacyAutomaticTitle } from '../src/assembly/title.mjs';

const fixture = () => ({ schemaVersion: 1, draftId: randomUUID(), revision: 0, title: '历史标题',
  createdAt: '2026-10-01T01:00:00.000Z', stats: { selectedQuestions: 1 },
  baseline: { requirements: { title: '历史标题', purpose: 'diagnostic', mainScope: ['1.2', 'rja-compulsory-1:1.2'], scoringMode: 'none' },
    slots: [{ slotId: 'slot-1', number: 1 }], taskCatalogSnapshot: { chapters: [{ id: 'rja-compulsory-1:1.2', label: '1.2 集合间的基本关系' }] } },
  slots: [{ slotId: 'slot-1', number: 1, question: { questionId: 'private-question', student: { stem: 'frozen content' } } }],
  differences: [{ code: 'historical', message: 'Preserve me' }] });
const operation = (fields = {}) => ({ type: 'rename', title: '  集合关系 · 学情诊断  ', operationId: 'rename-title', expectedRevision: 0, ...fields });

test('rename changes only the displayed title and operation metadata, without reading the question bank', async () => {
  const draft = fixture(); const before = structuredClone(draft);
  const result = await applyDraftOperation(draft, operation(), { root: 'missing-bank-must-not-be-read' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.draft.title, '集合关系 · 学情诊断');
  assert.equal(result.draft.revision, 1);
  const changed = Object.keys(result.draft).filter(key => JSON.stringify(result.draft[key]) !== JSON.stringify(before[key]));
  assert.deepEqual(changed.sort(), ['operations', 'revision', 'title', 'updatedAt']);
  assert.deepEqual(draft, before);
  const replay = await applyDraftOperation(result.draft, operation());
  assert.equal(replay.result.replayed, true);
  assert.deepEqual(replay.draft, result.draft);
  assert.equal((await applyDraftOperation(result.draft, operation({ title: 'different' }))).error.code, 'operation_conflict');
  assert.equal((await applyDraftOperation(result.draft, operation({ operationId: 'new-operation' }))).error.code, 'revision_conflict');
  assert.equal((await applyDraftOperation({ ...draft, confirmedPaperId: randomUUID() }, operation())).error.code, 'finalized_draft');
  for (const title of ['', '  ', '\nname', 'bad\u0000name', 'x'.repeat(121), 42, null]) {
    assert.equal((await applyDraftOperation(draft, operation({ title }))).error.code, 'invalid_operation');
  }
});

test('concurrent renames serialize revisions and small list summaries come only from the frozen draft', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tutor-draft-title-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const draft = fixture(); await saveDraft(root, draft);
  const results = await Promise.all(['A', 'B'].map(title => updateDraft(root, draft.draftId, current =>
    applyDraftOperation(current, operation({ title, operationId: `rename-${title}` })))));
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.find(result => !result.ok).error.code, 'revision_conflict');
  const saved = await readDraft(root, draft.draftId);
  assert.deepEqual(saved.baseline, draft.baseline);
  assert.deepEqual(saved.slots, draft.slots);
  const summary = (await listDrafts(root)).drafts[0];
  assert.equal(summary.title, 'A'); assert.equal(summary.revision, 1);
  assert.equal(summary.scopeSummary, '1.2 集合间的基本关系');
  assert.equal(summary.purposeLabel, '学情诊断');
  assert.equal(Object.hasOwn(summary, 'baseline'), false);
  assert.equal(Object.hasOwn(summary, 'slots'), false);
});

test('new intake titles distinguish selected sections and purposes while preserving teacher supplied names', async () => {
  const service = createIntakeService();
  const begin = async answers => {
    const result = await service.handle({ action: 'start', flow: 'quick', answers, operationId: randomUUID() });
    assert.equal(result.ok, true, JSON.stringify(result)); return result.session;
  };
  const one = await begin({ mainScope: ['1.1'], purpose: 'diagnostic' });
  const two = await begin({ mainScope: ['1.2'], purpose: 'diagnostic' });
  const three = await begin({ mainScope: ['1.1'], purpose: 'targeted_practice' });
  assert.equal(one.answers.title, '集合的概念 · 学情诊断');
  assert.notEqual(one.answers.title, two.answers.title);
  assert.notEqual(one.answers.title, three.answers.title);
  assert.match(three.answers.title, /专项训练/);
  const teacher = await begin({ mainScope: ['1.1'], title: '张老师的随堂练习' });
  const changed = await service.handle({ action: 'answer', sessionId: teacher.sessionId, revision: teacher.revision,
    operationId: randomUUID(), answers: { mainScope: ['1.2'], purpose: 'diagnostic' } });
  assert.equal(changed.ok, true, JSON.stringify(changed));
  assert.equal(changed.session.answers.title, '张老师的随堂练习');
  assert.equal(changed.session.requirements.title, '张老师的随堂练习');
  const explicitAutoName = await begin({ mainScope: ['1.1'], purpose: 'diagnostic', title: one.answers.title });
  const explicitChanged = await service.handle({ action: 'answer', sessionId: explicitAutoName.sessionId, revision: explicitAutoName.revision,
    operationId: randomUUID(), answers: { mainScope: ['1.2'], purpose: 'targeted_practice' } });
  assert.equal(explicitChanged.ok, true, JSON.stringify(explicitChanged));
  assert.equal(explicitChanged.session.answers.title, one.answers.title, 'Teacher title remains explicit even when it matches a generated name');
});

test('automatic titles summarize supported topics without listing every section or crossing textbook identities', () => {
  const chapters = Object.entries({ '1.1': '集合的概念', '1.2': '集合间的基本关系', '1.3': '集合的基本运算',
    '1.4': '充分条件与必要条件', '1.5': '全称量词与存在量词', '2.1': '等式性质与不等式性质',
    '2.2': '基本不等式', '2.3': '二次函数与一元二次方程、不等式' })
    .map(([number, label]) => ({ id: `rja-compulsory-1:${number}`, label: `${number} ${label}` }));
  const config = { chapters };
  assert.equal(automaticTitle(chapters.slice(5).map(item => item.id), 'consolidation', config), '不等式 · 课后巩固');
  assert.equal(automaticTitle(['1.1', chapters[0].id, '1.2', '1.3'], 'diagnostic', config), '集合 · 学情诊断');
  assert.equal(automaticTitle(chapters.slice(0, 5).map(item => item.id), 'consolidation', config), '集合与逻辑 · 课后巩固');
  assert.equal(automaticTitle(chapters.slice(3, 5).map(item => item.id), 'targeted_practice', config), '常用逻辑用语 · 专项训练');
  assert.equal(automaticTitle([chapters[7].id], 'consolidation', config), '二次函数与不等式 · 课后巩固');
  assert.equal(automaticTitle(['other-book:2.1'], 'consolidation', { chapters: [{ id: 'other-book:2.1', label: '2.1 平面向量' }] }), '平面向量 · 课后巩固');
  assert.equal(automaticTitle([], 'consolidation', config), '数学练习 · 课后巩固');
  assert.equal(legacyAutomaticTitle(chapters.slice(5).map(item => item.id), 'consolidation', config),
    '2.1 等式性质与不等式性质、2.2 基本不等式、2.3 二次函数与一元二次方程、不等式 · 课后巩固');
});
