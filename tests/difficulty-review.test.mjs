import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createDifficultyReviewGateway, validateDifficultyReview } from '../src/llm/difficulty-review-gateway.mjs';
import { applyDifficultyReviews, unknownDifficultyInputs } from '../src/question-bank/difficulty-review.mjs';
import { hashContent } from '../src/question-bank/integrity.mjs';

const env = { LLM_BASE_URL: 'https://fixture.invalid/v1', LLM_API_KEY: 'test-secret', LLM_MODEL: 'fixture-model' };
function fixture() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE question_bank_state(kind TEXT PRIMARY KEY,payload TEXT,sha256 TEXT,synced_at TEXT); CREATE TABLE question_bank_questions(question_id TEXT PRIMARY KEY,payload TEXT,sha256 TEXT);');
  const questions = ['unknown', 'easy', 'unknown'].map((level,n) => ({ questionId: `q${n}`, contentVersion: 'content-v1', teacherVersion: 'teacher-v1',
    questionType: 'single_choice', student: { stem: '判断集合交集', options: [], parts: [], assets: [] },
    teacher: { answers: [{ text: '答案为零' }], solutions: [{ text: '直接计算集合交集' }] } }));
  for (const q of questions) db.prepare('INSERT INTO question_bank_questions VALUES(?,?,?)').run(q.questionId, JSON.stringify(q), hashContent(q));
  const ledger = { entries: questions.map((q,n) => ({ questionId: q.questionId, status: n === 2 ? 'pending' : 'ready' })) };
  const index = { entries: questions.map((q,n) => ({ questionId: q.questionId, contentVersion: q.contentVersion, teacherVersion: q.teacherVersion,
    difficultyLevel: n === 1 ? 'easy' : 'unknown', tasks: [`task-${n}`], notes: ['preserve'] })) };
  for (const [kind,value] of [['ledger',ledger],['question_index',index]]) db.prepare('INSERT INTO question_bank_state VALUES(?,?,?,?)').run(kind,JSON.stringify(value),hashContent(value),'before');
  return db;
}
function record(db, level = 'standard') {
  const input = { questions: unknownDifficultyInputs(db) };
  return { input, inputSha256: hashContent(input), result: { ok: true, run: { status: 'succeeded', model: 'fixture-model' },
    proposal: { questions: input.questions.map(q => ({ questionId: q.questionId, level, rationale: '需要直接计算交集。', evidence: [{ ref: 'teacher.solutions.0', quote: '直接计算集合交集' }] })) } } };
}
const rawIndex = db => db.prepare("SELECT payload FROM question_bank_state WHERE kind='question_index'").get().payload;

test('only ready unknown questions are eligible; metadata update is version bound and idempotent', () => {
  const db = fixture();
  try {
    assert.deepEqual(unknownDifficultyInputs(db).map(q => q.questionId), ['q0']);
    const source = db.prepare('SELECT * FROM question_bank_questions').all();
    const before = JSON.parse(rawIndex(db)), reviewed = record(db);
    assert.equal(applyDifficultyReviews(db,[reviewed]).changes.length, 1);
    const after = JSON.parse(rawIndex(db));
    assert.equal(after.entries[0].difficultyLevel, 'medium');
    assert.equal(after.entries[0].difficultyBasis.empirical, false);
    assert.equal(after.entries[0].difficultyBasis.method, 'llm_estimate');
    assert.deepEqual(after.entries[0].tasks, before.entries[0].tasks);
    assert.deepEqual(after.entries.slice(1), before.entries.slice(1));
    assert.deepEqual(db.prepare('SELECT * FROM question_bank_questions').all(), source);
    const saved = rawIndex(db);
    assert.equal(applyDifficultyReviews(db,[reviewed]).changes.length, 0);
    assert.equal(rawIndex(db), saved);
  } finally { db.close(); }
});

test('invalid identities, invented quotes, failed model and stale versions never write', () => {
  const db = fixture();
  try {
    for (const mutate of [r => { r.result.proposal.questions[0].questionId = 'invented'; },
      r => { r.result.proposal.questions[0].evidence[0].quote = 'invented'; },
      r => { r.result.ok = false; }, r => { r.inputSha256 = 'invented'; }]) {
      const r = record(db), before = rawIndex(db); mutate(r);
      assert.throws(() => applyDifficultyReviews(db,[r])); assert.equal(rawIndex(db), before);
    }
    const r = record(db), q = JSON.parse(db.prepare("SELECT payload FROM question_bank_questions WHERE question_id='q0'").get().payload);
    q.student.stem = 'modified stem';
    db.prepare("UPDATE question_bank_questions SET payload=?,sha256=? WHERE question_id='q0'").run(JSON.stringify(q),hashContent(q));
    const before = rawIndex(db);
    assert.throws(() => applyDifficultyReviews(db,[r]), /changed/);
    assert.equal(rawIndex(db), before);
  } finally { db.close(); }
});

test('model unknown stays unknown and concurrent annotation edits survive', () => {
  const db = fixture();
  try {
    const unknown = record(db,'unknown'), before = rawIndex(db);
    assert.equal(applyDifficultyReviews(db,[unknown]).skipped[0].reason, 'model_unknown');
    assert.equal(rawIndex(db), before);
    const r = record(db), index = JSON.parse(before);
    index.entries[0].notes.push('concurrent review');
    db.prepare("UPDATE question_bank_state SET payload=?,sha256=? WHERE kind='question_index'").run(JSON.stringify(index),hashContent(index));
    applyDifficultyReviews(db,[r]);
    assert.deepEqual(JSON.parse(rawIndex(db)).entries[0].notes, ['preserve','concurrent review']);
  } finally { db.close(); }
});

test('structured gateway retries bad evidence and records real model run metadata', async () => {
  const db = fixture();
  try {
    const r = record(db); let calls = 0;
    const gateway = createDifficultyReviewGateway({ env, generate: async () => {
      const output = structuredClone(r.result.proposal);
      if (++calls === 1) output.questions[0].evidence[0].ref = 'wrong-ref';
      return { output, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    } });
    const result = await gateway.propose(r.input,{ validate: p => validateDifficultyReview(p,r.input) });
    assert.equal(result.ok,true); assert.equal(calls,2); assert.equal(result.run.usage.totalTokens,30);
    assert.equal(result.run.attempts[0].status,'invalid_model_output');
    assert.ok(!JSON.stringify(result).includes(env.LLM_API_KEY));
  } finally { db.close(); }
});
