import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAppServer } from '../src/server.mjs';
import { createQuestionImportGateway } from '../src/llm/question-import-gateway.mjs';

const parsedPaper = {
  title: '集合单元练习',
  questions: [{
    sourceLabel: '第1题', pages: [1], questionType: 'single_choice',
    student: { stem: '下列对象能构成集合的是（ ）', options: [{ label: 'A', text: '较大的数' }, { label: 'B', text: '方程 $x=1$ 的实根' }], parts: [] },
    teacher: { answers: [{ partId: 'main', text: 'B', sourceBasis: 'explicit' }], solutions: [] },
    dimensions: { chapterCandidates: ['1.1'], taskCandidates: ['set_determinacy'], primaryTopics: ['集合的确定性'], requiredKnowledge: ['集合元素的确定性'],
      knowledgePoints: [{ name: '集合', role: 'primary' }], allowedSolution: '按集合元素的确定性判断。', cognition: 'understand', abilities: [], literacies: [],
      difficultySuggestion: { level: 'unknown', rationale: '' } },
  }],
};

function fixtureGateway(proposal = parsedPaper) {
  return {
    publicStatus: () => ({ configured: true, provider: 'fixture', model: 'fixture' }),
    async propose(context) {
      assert.equal(context.task, 'parse_question_paper_for_staging');
      assert.ok(context.trustedCatalog.chapters.some(item => item.id === '1.1'));
      assert.ok(context.trustedCatalog.tasks.some(item => item.id === 'set_determinacy' && item.questionType === 'single_choice'));
      assert.match(context.documentText, /\[PAGE 1\]/);
      assert.match(context.documentText, /下列对象/);
      return { ok: true, proposal: structuredClone(proposal), run: { status: 'succeeded', attempts: [{ status: 'succeeded' }] } };
    },
  };
}

async function start(t, gateway = fixtureGateway()) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'tutor-question-import-'));
  const storeRoot = path.join(base, 'drafts');
  const server = createAppServer({ storeRoot, questionImportGateway: gateway });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(base, { recursive: true, force: true }); });
  return { base, url: `http://127.0.0.1:${server.address().port}` };
}

test('multipart text upload is parsed into review-only staging without touching the ready ledger', async t => {
  const { base, url } = await start(t);
  const ledgerPath = path.resolve('data/question-bank/ledger.json');
  const ledgerBefore = await readFile(ledgerPath, 'utf8');
  const form = new FormData();
  form.append('file', new Blob(['第1题 下列对象能构成集合的是（ ）\nA. 较大的数\nB. 方程 x=1 的实根\n答案：B'], { type: 'text/plain' }), '集合练习.txt');
  const response = await fetch(`${url}/api/question-imports`, { method: 'POST', body: form });
  const result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result));
  assert.equal(result.import.status, 'pending_review');
  assert.equal(result.import.reviewSummary.publicationBlocked, true);
  assert.equal(result.import.questions[0].status, 'pending_review');
  assert.ok(result.import.questions[0].reviewIssues.some(item => item.code === 'ai_extraction_unverified'));
  assert.ok(result.import.questions[0].reviewIssues.some(item => item.code === 'solution_missing'));
  assert.equal(result.import.questions[0].dimensions.knowledgePoints[0].matchStatus, 'suggested');
  assert.equal(result.import.questions[0].dimensions.knowledgePoints[0].suggestedUid, 'M-K-01-112');
  assert.equal(result.import.questions[0].dimensions.chapterCandidates[0].id, '1.1');
  assert.equal(result.import.questions[0].dimensions.chapterCandidates[0].matchStatus, 'suggested');
  assert.equal(result.import.questions[0].dimensions.taskCandidates[0].id, 'set_determinacy');
  assert.equal(result.import.questions[0].dimensions.taskCandidates[0].matchStatus, 'suggested');
  assert.equal(await readFile(ledgerPath, 'utf8'), ledgerBefore);

  const reopened = await (await fetch(`${url}/api/question-imports/${result.import.importId}`)).json();
  assert.deepEqual(reopened.import, result.import);
  const listed = await (await fetch(`${url}/api/question-imports`)).json();
  assert.equal(listed.imports.length, 1);
  assert.equal(listed.imports[0].publicationBlocked, true);
  assert.equal((await readdir(path.join(base, 'question-imports', 'files'))).length, 1);
  assert.equal((await readdir(path.join(base, 'question-imports', 'records'))).length, 1);
});

test('upload rejects unsupported files before model execution', async t => {
  let called = false;
  const gateway = fixtureGateway();
  gateway.propose = async () => { called = true; return { ok: true, proposal: parsedPaper, run: {} }; };
  const { url } = await start(t, gateway);
  const form = new FormData();
  form.append('file', new Blob(['not an image'], { type: 'image/png' }), 'paper.png');
  const response = await fetch(`${url}/api/question-imports`, { method: 'POST', body: form });
  const result = await response.json();
  assert.equal(response.status, 415);
  assert.equal(result.error.code, 'unsupported_file');
  assert.equal(called, false);
});

test('failed model parsing leaves no orphaned uploaded source', async t => {
  const gateway = {
    publicStatus: () => ({ configured: true, provider: 'fixture', model: 'fixture' }),
    async propose() { return { ok: false, error: { code: 'model_error', message: 'fixture failure' }, run: { status: 'model_error' } }; },
  };
  const { base, url } = await start(t, gateway);
  const form = new FormData();
  form.append('file', new Blob(['第1题 仅用于清理测试'], { type: 'text/plain' }), 'paper.txt');
  const response = await fetch(`${url}/api/question-imports`, { method: 'POST', body: form });
  const result = await response.json();
  assert.equal(response.status, 503);
  assert.equal(result.error.code, 'model_error');
  assert.deepEqual(await readdir(path.join(base, 'question-imports', 'files')), []);
});

test('strict LLM schema rejects guessed or malformed question structures', async () => {
  const gateway = createQuestionImportGateway({
    env: { LLM_BASE_URL: 'https://fixture.invalid/v1', LLM_API_KEY: 'fixture', LLM_MODEL: 'fixture' },
    generate: async () => ({ output: { title: 'bad', questions: [{ sourceLabel: '1', pages: [0], questionType: 'essay', invented: true }] } }),
  });
  const result = await gateway.propose({ documentText: '[PAGE 1]\nfixture' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'invalid_model_output');
  assert.equal(result.run.attempts.length, 2);
});
