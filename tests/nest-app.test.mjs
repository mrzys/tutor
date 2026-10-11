import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNestApp } from '../src/api/app.ts';

test('NestJS serves existing contracts through one listener with SQLite persistence', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'tutor-nest-'));
  let serviceRepository;
  const questionImportGateway = {
    publicStatus: () => ({ configured: true, provider: 'fixture', model: 'fixture' }),
    async propose() {
      return { ok: true, proposal: { title: 'SQLite 导入', questions: [{
        sourceLabel: '第1题', pages: [1], questionType: 'single_choice',
        student: { stem: '能构成集合的是（ ）', options: [{ label: 'A', text: '较大的数' }, { label: 'B', text: '方程的实根' }], parts: [] },
        teacher: { answers: [{ partId: 'main', text: 'B', sourceBasis: 'explicit' }], solutions: [] },
        dimensions: { chapterCandidates: ['1.1'], taskCandidates: ['set_determinacy'], primaryTopics: ['集合'],
          requiredKnowledge: ['确定性'], knowledgePoints: [{ name: '集合', role: 'primary' }], allowedSolution: '按确定性判断。',
          cognition: 'understand', abilities: [], literacies: [], difficultySuggestion: { level: 'unknown', rationale: '' } },
      }] }, run: { status: 'succeeded', attempts: [{ status: 'succeeded' }] } };
    },
  };
  const application = await createNestApp({ storeRoot: path.join(base, 'drafts'), logger: false,
    legacyOptions: { questionImportGateway },
    intakeServiceFactory: ({ repository }) => { serviceRepository = repository; return undefined; } });
  t.after(async () => {
    await application.close();
    assert.equal(path.dirname(base), path.resolve(os.tmpdir())); assert.ok(path.basename(base).startsWith('tutor-nest-'));
    await rm(base, { recursive: true, force: true });
  });
  await application.app.listen(0, '127.0.0.1');
  const url = await application.app.getUrl();
  const configResponse = await fetch(`${url}/api/config`); const config = await configResponse.json();
  assert.equal(configResponse.status, 200); assert.equal(config.ok, true);
  assert.equal(config.config.supply.ready, 45);
  assert.equal(configResponse.headers.get('x-powered-by'), null);
  const post = async (endpoint, value) => {
    const response = await fetch(`${url}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    return { status: response.status, value: await response.json() };
  };
  const preview = await post('/api/blueprint', { requirements: config.config.defaultRequirements });
  assert.equal(preview.value.ok, true);
  const saved = await post('/api/drafts', { blueprint: preview.value.blueprint });
  assert.equal(saved.status, 201);
  const reopened = await (await fetch(`${url}/api/drafts/${saved.value.draft.draftId}`)).json();
  assert.deepEqual(reopened.draft, saved.value.draft);
  assert.equal(serviceRepository, application.repository);
  assert.equal(application.repository.list('drafts').length, 1);
  assert.equal((await readdir(base)).includes('drafts'), false);

  const source = '第1题 能构成集合的是（ ）\nA. 较大的数\nB. 方程的实根\n答案：B';
  const form = new FormData();
  form.append('file', new Blob([source], { type: 'text/plain' }), '集合练习.txt');
  const uploadResponse = await fetch(`${url}/api/question-imports`, { method: 'POST', body: form });
  const upload = await uploadResponse.json();
  assert.equal(uploadResponse.status, 201, JSON.stringify(upload));
  const stored = application.repository.database.prepare(`SELECT source_blob,source_sha256,status
    FROM question_imports WHERE import_id=?`).get(upload.import.importId);
  assert.equal(stored.source_blob.toString('utf8'), source);
  assert.equal(stored.source_sha256, upload.import.source.sha256);
  assert.equal(stored.status, 'pending_review');
  application.repository.putQuestionImport(upload.import, { bytes: Buffer.from(source), sha256: upload.import.source.sha256,
    filename: '集合练习.txt', mimeType: 'text/plain' });
  assert.throws(() => application.repository.putQuestionImport({ ...upload.import, title: '不可覆盖' }, {
    bytes: Buffer.from(source), sha256: upload.import.source.sha256, filename: '集合练习.txt', mimeType: 'text/plain',
  }), { code: 'operation_conflict' });
  assert.equal(application.repository.database.prepare('SELECT COUNT(*) AS count FROM question_bank_questions').get().count, 45);
  assert.equal(application.repository.database.prepare('SELECT COUNT(*) AS count FROM question_bank_chapters').get().count, 3);
  assert.equal(application.repository.database.prepare('SELECT COUNT(*) AS count FROM curriculum_textbooks').get().count, 5);
  assert.equal(application.repository.database.prepare('SELECT COUNT(*) AS count FROM curriculum_chapters').get().count, 18);
  assert.equal(application.repository.database.prepare('SELECT COUNT(*) AS count FROM curriculum_sections').get().count, 73);
  const bankResponse = await fetch(`${url}/api/question-bank`);
  const bank = await bankResponse.json();
  assert.equal(bankResponse.status, 200);
  assert.equal(bank.textbooks.length, 5);
  assert.equal(bank.textbooks[0].chapters[0].title, '集合与常用逻辑用语');
  assert.equal(bank.textbooks[0].chapters[0].sections[0].questionCount, 28);
  assert.equal(bank.questions[0].sectionIds[0].startsWith('rja-compulsory-1:'), true);
  assert.deepEqual(await readdir(path.join(base, 'question-imports', 'files')), []);
  assert.equal((await fetch(`${url}/api/question-imports/${upload.import.importId}`)).status, 200);
  application.repository.database.prepare('UPDATE question_imports SET source_blob=? WHERE import_id=?')
    .run(Buffer.from('tampered'), upload.import.importId);
  const tampered = await fetch(`${url}/api/question-imports/${upload.import.importId}`);
  assert.equal(tampered.status, 500);
});
