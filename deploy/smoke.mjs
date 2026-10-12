// Exercise a disposable clone; never create accounts or papers in production.
import { config } from 'dotenv';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import Database from 'better-sqlite3';
import { createNestApp } from '../src/api/app.ts';

config({ path: '/etc/tutor-v1.env', quiet: true });
const directory = await mkdtemp(path.join(os.tmpdir(), 'tutor-deploy-smoke-'));
const databasePath = path.join(directory, 'tutor.sqlite');
const source = new Database(process.env.TUTOR_DATABASE_PATH, { readonly: true });
try { await source.backup(databasePath); } finally { source.close(); }
const application = await createNestApp({ storeRoot: path.join(directory, 'drafts'), databasePath, logger: false });
try {
  await application.app.listen(0, '127.0.0.1');
  const port = application.app.getHttpServer().address().port;
  let cookie;
  async function api(route, body) {
    // Node fetch replaces Host with its URL host; use HTTP directly to emulate Nginx.
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest(`http://127.0.0.1:${port}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Host: 'tutor.mrzys.fun', Origin: 'https://tutor.mrzys.fun', 'X-Forwarded-Proto': 'https',
        ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      }, incoming => {
        const chunks = [];
        incoming.on('data', chunk => chunks.push(chunk));
        incoming.on('end', () => resolve({ headers: incoming.headers, body: Buffer.concat(chunks).toString('utf8') }));
        incoming.on('error', reject);
      });
      request.on('error', reject);
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const value = JSON.parse(response.body);
    assert.equal(value.ok, true, `${route}: ${JSON.stringify(value)}`);
    const issued = response.headers['set-cookie']?.[0];
    if (issued) { assert.match(issued, /; Secure/); cookie = issued.split(';')[0]; }
    return value;
  }
  const { hasUsers } = await api('/api/auth/me');
  assert.equal(typeof hasUsers, 'boolean');
  const registrationRole = hasUsers ? 'teacher' : 'admin';
  const credentials = { email: `deployment-smoke-${randomUUID()}@example.test`, password: randomUUID() };
  assert.equal((await api('/api/auth/register', credentials)).user.role, registrationRole);
  await api('/api/auth/logout', {});
  await api('/api/auth/login', credentials);
  const configuration = (await api('/api/config')).config;
  let liveAi = 'not_requested';
  if (process.argv.includes('--ai')) {
    const session = (await api('/api/intake', { action: 'start', flow: 'quick', operationId: randomUUID(),
      answers: { mainScope: ['1.1'], questionCount: 4, scoringMode: 'none' } })).session;
    const prepared = (await api('/api/intake', { action: 'prepare', sessionId: session.sessionId,
      revision: session.revision, operationId: randomUUID(), message: '4道集合概念基础题，检查集合的确定性与元素归属，不计分。',
      lockedFields: ['questionCount', 'scoringMode'] })).session;
    assert.equal(prepared.llmRun?.status, 'succeeded', JSON.stringify(prepared.assistantError));
    assert.ok(prepared.proposal);
    liveAi = 'passed';
  }
  const bank = await api('/api/question-bank?pageSize=2');
  assert.equal(bank.questions.length, 2);
  const preview = await api('/api/blueprint', { requirements: configuration.defaultRequirements });
  assert.ok(preview.blueprint.slots.length > 0);
  const draft = (await api('/api/question-bank/manual-draft', { title: '部署隔离验证',
    selections: bank.questions.map(({ questionId, contentVersion, teacherVersion }) => ({ questionId, contentVersion, teacherVersion })) })).draft;
  const paper = (await api(`/api/drafts/${draft.draftId}/confirm`, {
    operationId: randomUUID(), expectedRevision: draft.revision ?? 0, acknowledgeDifferences: true,
  })).paper;
  for (const kind of ['student', 'teacher']) {
    await api(`/api/papers/${paper.paperId}/outputs/${kind}`, {});
    const pdf = await fetch(`http://127.0.0.1:${port}/api/papers/${paper.paperId}/outputs/${kind}/file`, { headers: { Cookie: cookie } });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.ok((await pdf.arrayBuffer()).byteLength > 1000);
  }
  console.log(JSON.stringify({ ok: true, supply: configuration.supply,
    aiConfigured: configuration.intake.configured, liveAi, registrationLogin: 'passed',
    blueprint: 'passed', assemblyConfirmation: 'passed', studentAndTeacherPdf: 'passed',
    productionDataUnchanged: true }));
} finally {
  await application.close();
  await rm(directory, { recursive: true, force: true });
}
