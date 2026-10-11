import test from 'node:test';
import assert from 'node:assert/strict';
import { createManualQuestionDraft, listQuestionBankCatalog } from '../src/question-bank/catalog.mjs';

test('question bank catalog groups ready student questions by chapter without teacher content', async () => {
  const result = await listQuestionBankCatalog();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.questions.length, result.totals.ready);
  assert.ok(result.chapters.every(chapter => chapter.questionCount > 0));
  const question = result.questions[0];
  assert.equal(typeof question.contentVersion, 'string');
  assert.equal(typeof question.teacherVersion, 'string');
  assert.ok(question.student.stem);
  assert.equal(question.teacher, undefined);
  assert.doesNotMatch(JSON.stringify(question), /"answers"|"solutions"/);
});

test('manual draft writes the exact versioned user selection in order without automatic replacement', async () => {
  const catalog = await listQuestionBankCatalog();
  const chosen = ['tutor-set-005', 'tutor-set-001'].map(questionId => {
    const question = catalog.questions.find(item => item.questionId === questionId);
    return { questionId, contentVersion: question.contentVersion, teacherVersion: question.teacherVersion };
  });
  const result = await createManualQuestionDraft({ title: '手动选择测试卷', selections: chosen });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.draft.slots.map(slot => slot.question.questionId), chosen.map(item => item.questionId));
  assert.ok(result.draft.slots.every(slot => slot.selection.selectedReason.method === 'manual_question_bank'));
  assert.equal(result.draft.retrieval.mode, 'manual_question_bank');
  assert.equal(result.draft.baseline.generation.mode, 'manual_question_bank');
  assert.equal(result.draft.baseline.requirements.scoringMode, 'none');
  assert.equal(result.draft.stats.missingQuestions, 0);
});

test('manual draft rejects stale versions and duplicate identities while retaining legacy questionIds support', async () => {
  const catalog = await listQuestionBankCatalog();
  const question = catalog.questions[0];
  const stale = await createManualQuestionDraft({ selections: [{ questionId: question.questionId,
    contentVersion: 'content-stale', teacherVersion: question.teacherVersion }] });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'version_conflict');
  const duplicate = await createManualQuestionDraft({ questionIds: [question.questionId, question.questionId] });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error.code, 'invalid_request');
  const legacy = await createManualQuestionDraft({ questionIds: [question.questionId] });
  assert.equal(legacy.ok, true);
});
