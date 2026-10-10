import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { generateOutput, getPaperOutputs, readOutputFile } from '../src/output/manager.mjs';

test('isolated renderer failure preserves the other output and retries the same immutable paper', async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'tutor-s304-output-state-'));
  const paper = { paperId: randomUUID(), draft: { title: '输出状态故障注入测试' } };
  const before = structuredClone(paper); const calls = []; let failTeacher = true;
  // These are test-only byte fixtures, not evidence of rendered PDF validity.
  const generate = async (snapshot, kind, options) => {
    calls.push(kind); assert.deepEqual(snapshot, before);
    if (kind === 'teacher' && failTeacher) return { ok: false, error: { code: 'injected_failure', message: 'Injected teacher renderer failure' } };
    await mkdir(options.outputRoot, { recursive: true });
    const bytes = Buffer.from(`%PDF-1.7\nTEST_FIXTURE_${kind}`);
    const filename = path.join(options.outputRoot, `${kind}.pdf`);
    await writeFile(filename, bytes);
    return { ok: true, artifact: { path: filename, sha256: createHash('sha256').update(bytes).digest('hex'),
      status: kind === 'teacher' ? 'incomplete' : 'complete', pages: 1, issues: kind === 'teacher' ? ['Missing reference explanation'] : [] } };
  };
  const options = { outputRoot, generate };
  const initial = await Promise.all(['student', 'teacher'].map(kind => generateOutput(paper, kind, options)));
  assert.equal(initial[0].ok, true); assert.equal(initial[1].ok, false);
  const states = await getPaperOutputs(paper, options);
  assert.equal(states.student.status, 'complete'); assert.equal(states.teacher.status, 'failed');
  const student = await readOutputFile(paper, 'student', options);
  failTeacher = false;
  const retry = await generateOutput(paper, 'teacher', options);
  assert.equal(retry.output.status, 'incomplete');
  assert.deepEqual((await readOutputFile(paper, 'student', options)).bytes, student.bytes);
  await generateOutput(paper, 'student', options);
  assert.deepEqual(calls, ['student', 'teacher', 'teacher'], 'Successful output reuses its verified file');
  assert.deepEqual(paper, before);
});

test('corrupted PDF cannot be downloaded and its own output can be regenerated', async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'tutor-s304-output-integrity-'));
  const paper = { paperId: randomUUID(), draft: {} };
  const generate = async (snapshot, kind, options) => {
    await mkdir(options.outputRoot, { recursive: true });
    const bytes = Buffer.from('%PDF-1.7\nTEST_FIXTURE');
    const filename = path.join(options.outputRoot, `${kind}.pdf`);
    await writeFile(filename, bytes);
    return { ok: true, artifact: { path: filename, sha256: createHash('sha256').update(bytes).digest('hex'), status: 'complete', pages: 1 } };
  };
  const options = { outputRoot, generate };
  await generateOutput(paper, 'student', options);
  await writeFile(path.join(outputRoot, paper.paperId, 'student.pdf'), 'CORRUPTED_TEST_FILE');
  assert.equal((await getPaperOutputs(paper, options)).student.status, 'failed');
  await assert.rejects(readOutputFile(paper, 'student', options), { code: 'integrity_error' });
  assert.equal((await generateOutput(paper, 'student', options)).ok, true);
  assert.equal((await getPaperOutputs(paper, options)).teacher.status, 'not_generated');
});
