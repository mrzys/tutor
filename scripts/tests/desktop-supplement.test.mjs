import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashContent } from '../lib/integrity.mjs';
import { buildSupplement, exportSupplement } from '../export-desktop-supplement.mjs';

const seed = JSON.parse(readFileSync(new URL('../../desktop/resources/seed.json', import.meta.url), 'utf8'));
const annotations = JSON.parse(readFileSync(new URL('../../desktop/resources/bank-annotations-v1.json', import.meta.url), 'utf8'));
function fixture() {
  const q = structuredClone(seed.questions[0]);
  q.questionId = 'simulated-supplement-question';
  const config = structuredClone(seed.config);
  for (const patch of annotations.entries) {
    config.assemblyIndex.entries[config.assemblyIndex.entries.findIndex(x => x.questionId === patch.questionId)] = patch.annotation;
  }
  return { seed, annotations, config, questions: [...seed.questions, q], localRows: [],
    publications: [{ operation_id: 'simulated-publish', manifest_sha256: 'a'.repeat(64), receipt: JSON.stringify({ addedQuestions: 1, questionIds: [q.questionId] }) }], id: 'simulated-release' };
}
test('simulated supplement exports only added verified questions and exact publication provenance', () => {
  const input = fixture();
  const result = buildSupplement(input);
  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0].questionId, 'simulated-supplement-question');
  const { manifestSha256, ...body } = result;
  assert.equal(manifestSha256, hashContent(body));
  assert.equal(result.baselineConfigSha256, hashContent(result.baselineConfig));
  assert.deepEqual(result.publications[0].receipt.questionIds, [result.questions[0].questionId]);
});
test('simulated supplement rejects changed originals, unverified additions and publication scope mismatch', () => {
  for (const kind of ['original', 'unverified', 'publication', 'duplicate']) {
    const input = fixture();
    if (kind === 'original') { input.questions = structuredClone(input.questions); input.questions[0].student.stem += ' changed'; }
    if (kind === 'unverified') input.questions.at(-1).verification.result = 'pending';
    if (kind === 'publication') input.publications[0].receipt = JSON.stringify({ questionIds: [] });
    if (kind === 'duplicate') input.questions.push(input.questions.at(-1));
    assert.throws(() => buildSupplement(input));
  }
});
test('simulated supplement excludes unrelated shared rows and rejects row corruption', () => {
  const input = fixture();
  const payload = JSON.stringify({ question_id: 'unrelated', knowledge_uid: 'simulated' });
  input.localRows = [{ kind: 'question_knowledge_mappings', id: 'simulated-row', payload, sha256: hashContent(JSON.parse(payload)) }];
  assert.deepEqual(buildSupplement(input).localRows, []);
  input.localRows[0].sha256 = '0'.repeat(64);
  assert.throws(() => buildSupplement(input), /hash mismatch/);
});
test('simulated export reads only shared allowlist tables and never overwrites an existing output', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tutor-supplement-export-'));
  try {
    const input = fixture();
    const database = path.join(root, 'shared.sqlite');
    const db = new DatabaseSync(database);
    db.exec('CREATE TABLE bank_metadata(key TEXT,value TEXT); CREATE TABLE bank_questions(id TEXT,payload TEXT); CREATE TABLE bank_local_rows(kind TEXT,id TEXT,payload TEXT,sha256 TEXT); CREATE TABLE bank_publications(operation_id TEXT,manifest_sha256 TEXT,receipt TEXT);');
    db.prepare('INSERT INTO bank_metadata VALUES(?,?)').run('config', JSON.stringify(input.config));
    for (const q of input.questions) db.prepare('INSERT INTO bank_questions VALUES(?,?)').run(q.questionId, JSON.stringify(q));
    const p = input.publications[0];
    db.prepare('INSERT INTO bank_publications VALUES(?,?,?)').run(p.operation_id, p.manifest_sha256, p.receipt);
    db.close();
    const options = { database, seedPath: new URL('../../desktop/resources/seed.json', import.meta.url), annotationsPath: new URL('../../desktop/resources/bank-annotations-v1.json', import.meta.url), output: path.join(root, 'release.json'), id: input.id };
    assert.equal((await exportSupplement(options)).questions, 1);
    await assert.rejects(exportSupplement(options), /EEXIST/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
