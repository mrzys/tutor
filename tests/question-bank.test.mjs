import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson, hashContent, listQuestions, getQuestion, getStudentQuestion } from '../src/question-bank/reader.mjs';

async function fixture(t, { freeResponse = false, teacherEmpty = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tutor-bank-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.equal(path.basename(root).startsWith('tutor-bank-test-'), true);
    return rm(root, { recursive: true, force: true });
  });
  const bank = path.join(root, 'data', 'question-bank');
  await mkdir(path.join(bank, 'questions'), { recursive: true });
  await mkdir(path.join(root, 'sources'));
  const sourceBytes = Buffer.from('fixture source bytes');
  await writeFile(path.join(root, 'sources', 'paper.pdf'), sourceBytes);
  const ref = { sourceId: 'set-teacher', pages: [1], locator: 'Example 1' };
  const student = {
    stem: 'Given $A=\\{1,2\\}$, answer the question.',
    options: freeResponse ? [] : [{ label: 'A', text: '$1$' }, { label: 'B', text: '$2$' }],
    parts: freeResponse ? [{ partId: 'p1', prompt: 'Find $A$.' }, { partId: 'p2', prompt: 'Find its cardinality.' }] : [],
    assets: [],
  };
  const teacher = {
    answers: teacherEmpty ? [] : [{ partId: freeResponse ? 'p1' : 'main', text: 'SECRET_ANSWER', provenance: 'source', sourceRefs: [ref] }],
    solutions: [], scoringSuggestions: [],
  };
  const record = { schemaVersion: 1, questionId: 'tutor-set-001', auditId: 'SET-SRC-001', questionType: freeResponse ? 'free_response' : 'single_choice', student, teacher, sourceRefs: [ref] };
  rebind(record);
  const entries = [
    { questionId: record.questionId, auditId: record.auditId, status: 'ready', contentPath: 'questions/tutor-set-001.json', questionType: record.questionType, pendingReasons: [] },
    { questionId: 'tutor-set-002', auditId: 'SET-SRC-002', status: 'pending', questionType: 'fill_blank', pendingReasons: ['Formula transcription is pending.'] },
  ];
  await writeJson(path.join(bank, 'ledger.json'), { schemaVersion: 1, entries });
  await writeJson(path.join(bank, 'sources.json'), { schemaVersion: 1, sources: [{ sourceId: 'set-teacher', path: 'sources/paper.pdf', sha256: createHash('sha256').update(sourceBytes).digest('hex'), physicalPages: 2 }] });
  const recordPath = path.join(bank, 'questions', 'tutor-set-001.json');
  await writeJson(recordPath, record);
  return { root, bank, record, recordPath, entries };
}
const writeJson = (target, value) => writeFile(target, JSON.stringify(value, null, 2), 'utf8');
function rebind(record) {
  record.contentSha256 = hashContent(record.student);
  record.contentVersion = `content-${record.contentSha256.slice(0, 16)}`;
  record.teacherSha256 = hashContent(record.teacher);
  record.teacherVersion = `teacher-${record.teacherSha256.slice(0, 16)}`;
  record.scopeEvidence = { contentVersion: record.contentVersion, teacherVersion: record.teacherVersion, status: 'within', primaryTopics: ['sets'], requiredKnowledge: ['enumeration'], allowedSolution: 'Use elementary set enumeration.', courseBasis: 's201-sets-v1' };
  record.verification = { contentVersion: record.contentVersion, teacherVersion: record.teacherVersion, result: 'pass', method: 'Inspect physical source page.', checkedSourcePages: [{ sourceId: 'set-teacher', pages: [1] }] };
}

test('canonical hashing preserves Unicode and array order while sorting object keys', () => {
  assert.equal(canonicalJson({ z: '集合', a: [{ y: 2, x: 1 }] }), '{"a":[{"x":1,"y":2}],"z":"集合"}');
  assert.equal(hashContent({ z: 2, a: 1 }), hashContent({ a: 1, z: 2 }));
  assert.notEqual(hashContent([1, 2]), hashContent([2, 1]));
});

test('ledger and exact content/teacher versions are readable without fallback', async t => {
  const f = await fixture(t);
  assert.deepEqual((await listQuestions({ root: f.root })).totals, { sourceUnits: 2, ready: 1, pending: 1 });
  const options = { root: f.root, contentVersion: f.record.contentVersion, teacherVersion: f.record.teacherVersion };
  assert.equal((await getQuestion('tutor-set-001', options)).ok, true);
  assert.equal((await getQuestion('tutor-set-001', { ...options, contentVersion: 'content-old' })).error.code, 'version_not_found');
  assert.equal((await getQuestion('tutor-set-001', { ...options, teacherVersion: 'teacher-old' })).error.code, 'version_not_found');
});

test('pending, nonexistent and unreadable records produce distinct failures', async t => {
  const f = await fixture(t);
  assert.equal((await getQuestion('tutor-set-002', { root: f.root })).error.code, 'not_ready');
  assert.equal((await getQuestion('tutor-set-099', { root: f.root })).error.code, 'not_found');
  await writeFile(f.recordPath, '{broken');
  assert.equal((await getQuestion('tutor-set-001', { root: f.root })).error.code, 'read_error');
});

test('student read excludes teacher content and extra nested metadata', async t => {
  const f = await fixture(t);
  f.record.student.options[0].correct = true;
  f.record.student.answer = 'NESTED_SECRET';
  rebind(f.record);
  await writeJson(f.recordPath, f.record);
  const result = await getStudentQuestion('tutor-set-001', { root: f.root });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal(JSON.stringify(result).includes('correct'), false);
  assert.equal('teacher' in result.question, false);
  assert.equal('scopeEvidence' in result.question, false);
});

test('student content changes and stale scope/verification bindings are rejected', async t => {
  const f = await fixture(t);
  f.record.student.stem += ' Changed';
  await writeJson(f.recordPath, f.record);
  assert.equal((await getQuestion('tutor-set-001', { root: f.root })).error.code, 'integrity_error');
  rebind(f.record);
  f.record.scopeEvidence.contentVersion = 'content-stale';
  await writeJson(f.recordPath, f.record);
  assert.equal((await getQuestion('tutor-set-001', { root: f.root })).error.code, 'integrity_error');
  rebind(f.record);
  f.record.verification.teacherVersion = 'teacher-stale';
  await writeJson(f.recordPath, f.record);
  assert.equal((await getQuestion('tutor-set-001', { root: f.root })).error.code, 'integrity_error');
});

test('source mutation and invalid physical pages fail integrity checks', async t => {
  const f = await fixture(t);
  f.record.sourceRefs[0].pages = [3];
  await writeJson(f.recordPath, f.record);
  assert.equal((await getQuestion('tutor-set-001', { root: f.root })).error.code, 'integrity_error');
  f.record.sourceRefs[0].pages = [1];
  await writeJson(f.recordPath, f.record);
  await writeFile(path.join(f.root, 'sources', 'paper.pdf'), 'replaced source');
  assert.equal((await getQuestion('tutor-set-001', { root: f.root })).error.code, 'integrity_error');
});

test('free response retains common stem and both parent parts; teacher answer absence is not a gate', async t => {
  const f = await fixture(t, { freeResponse: true, teacherEmpty: true });
  const result = await getQuestion('tutor-set-001', { root: f.root });
  assert.equal(result.ok, true);
  assert.equal(result.question.student.parts.length, 2);
  assert.equal(result.question.student.stem, f.record.student.stem);
  assert.deepEqual(result.question.teacher.answers, []);
});

test('unsafe content and source paths cannot escape the allowed directory', async t => {
  const f = await fixture(t);
  f.entries[0].contentPath = '../../../outside.json';
  await writeJson(path.join(f.bank, 'ledger.json'), { schemaVersion: 1, entries: f.entries });
  assert.equal((await getQuestion('tutor-set-001', { root: f.root })).error.code, 'integrity_error');
  f.entries[0].contentPath = 'questions/tutor-set-001.json';
  await writeJson(path.join(f.bank, 'ledger.json'), { schemaVersion: 1, entries: f.entries });
  const sourcesPath = path.join(f.bank, 'sources.json');
  const sources = JSON.parse(await readFile(sourcesPath, 'utf8'));
  sources.sources[0].path = '../outside.pdf';
  await writeJson(sourcesPath, sources);
  assert.equal((await getQuestion('tutor-set-001', { root: f.root })).error.code, 'integrity_error');
});

test('required assets distinguish absence from corrupted bytes', async t => {
  const f = await fixture(t);
  const bytes = Buffer.from('diagram');
  f.record.student.assets = [{ assetId: 'figure-1', path: 'sources/figure.png', sha256: createHash('sha256').update(bytes).digest('hex') }];
  rebind(f.record);
  await writeJson(f.recordPath, f.record);
  assert.equal((await getQuestion('tutor-set-001', { root: f.root })).error.code, 'read_error');
  await writeFile(path.join(f.root, 'sources', 'figure.png'), 'wrong diagram');
  assert.equal((await getQuestion('tutor-set-001', { root: f.root })).error.code, 'integrity_error');
  await writeFile(path.join(f.root, 'sources', 'figure.png'), bytes);
  assert.equal((await getQuestion('tutor-set-001', { root: f.root })).ok, true);
});

test('ledger cannot silently drift from the packaged content or teacher version', async t => {
  const f = await fixture(t);
  for (const field of ['contentVersion', 'teacherVersion']) {
    f.entries[0][field] = 'stale-version';
    await writeJson(path.join(f.bank, 'ledger.json'), { schemaVersion: 1, entries: f.entries });
    assert.equal((await getQuestion('tutor-set-001', { root: f.root })).error.code, 'integrity_error');
    delete f.entries[0][field];
  }
});

test('within and pass labels alone cannot substitute for scope or source evidence', async t => {
  const f = await fixture(t);
  const corruptions = [
    record => { record.scopeEvidence.allowedSolution = ''; },
    record => { delete record.scopeEvidence.courseBasis; },
    record => { record.scopeEvidence.primaryTopics = 'sets'; },
    record => { delete record.scopeEvidence.requiredKnowledge; },
    record => { record.verification.method = ''; },
    record => { record.verification.checkedSourcePages = []; },
    record => { record.verification.checkedSourcePages[0].pages = [3]; },
  ];
  for (const corrupt of corruptions) {
    const changed = structuredClone(f.record);
    corrupt(changed);
    await writeJson(f.recordPath, changed);
    const result = await getQuestion('tutor-set-001', { root: f.root });
    assert.equal(result.error?.code, 'integrity_error');
  }
});

test('teacher additions must name an existing part and preserve their provenance', async t => {
  const f = await fixture(t, { freeResponse: true });
  for (const corrupt of [
    record => { record.teacher.answers[0].partId = 'p999'; },
    record => { record.teacher.answers[0].provenance = 'unattributed'; },
    record => { record.teacher.answers[0].text = ' '; },
  ]) {
    const changed = structuredClone(f.record);
    corrupt(changed); rebind(changed);
    await writeJson(f.recordPath, changed);
    assert.equal((await getQuestion('tutor-set-001', { root: f.root })).error.code, 'integrity_error');
  }
});

test('question-type contracts reject lost options, stray fill-blank options and detached free-response parts', async t => {
  const f = await fixture(t);
  const invalidCases = [
    { questionType: 'single_choice', options: [], parts: [] },
    { questionType: 'fill_blank', options: f.record.student.options, parts: [] },
    { questionType: 'free_response', options: [], parts: [] },
  ];
  for (const invalidCase of invalidCases) {
    const changed = structuredClone(f.record);
    changed.questionType = invalidCase.questionType;
    changed.student.options = invalidCase.options;
    changed.student.parts = invalidCase.parts;
    rebind(changed);
    f.entries[0].questionType = changed.questionType;
    await writeJson(path.join(f.bank, 'ledger.json'), { schemaVersion: 1, entries: f.entries });
    await writeJson(f.recordPath, changed);
    assert.equal((await getQuestion('tutor-set-001', { root: f.root })).error.code, 'integrity_error');
  }
});
