import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createNestApp } from '../src/api/app.ts';
import { previewBlueprint, createDraft } from '../src/assembly/engine.mjs';
import { saveDraft } from '../src/assembly/store.mjs';
import { generateOutput } from '../src/output/manager.mjs';
import { createHash } from 'node:crypto';

test('Nest auth protects business APIs and isolates drafts, papers, PDF files and intake sessions between users', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'tutor-auth-http-'));
  const storeRoot = path.join(base, 'drafts');
  const application = await createNestApp({ storeRoot, logger: false,
    intakeServiceFactory: ({ repository }) => ({
      async get(sessionId) {
        const session = await repository.intakeStorage.get(sessionId);
        return session ? { ok: true, session } : { ok: false, error: { code: 'not_found', message: '没有找到需求。' } };
      },
      async handle(input) {
        const session = { sessionId: input.sessionId, revision: 0, status: 'collecting' };
        await repository.intakeStorage.put(session);
        return { ok: true, session };
      },
    }),
  });
  t.after(async () => { await application.close(); await rm(base, { recursive: true, force: true }); });
  const preview = await previewBlueprint();
  const { draft: legacyDraft } = await createDraft(preview.blueprint);
  await saveDraft(storeRoot, legacyDraft);
  await application.repository.intakeStorage.put({ sessionId: 'legacy-intake', revision: 0, status: 'collecting' });
  await application.app.listen(0, '127.0.0.1');
  const baseUrl = await application.app.getUrl();
  const request = async (route, { cookie, body, origin = baseUrl, method = body ? 'POST' : 'GET' } = {}) => {
    const response = await fetch(`${baseUrl}${route}`, { method, headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, value: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const register = email => request('/api/auth/register', { body: { email, password: 'secure-test-2026', role: 'admin' } });
  assert.deepEqual((await request('/api/auth/me')).value, { ok: true, user: null, hasUsers: false });
  for (const route of ['/api/config', '/api/question-bank', '/api/drafts', '/api/papers', `/api/drafts/${legacyDraft.draftId}`]) {
    assert.equal((await request(route)).status, 401, route);
  }
  const admin = await register('admin@example.com');
  assert.equal(admin.status, 201);
  assert.equal(admin.value.user.role, 'admin');
  assert.equal((await request('/api/drafts', { cookie: admin.cookie })).value.drafts[0].draftId, legacyDraft.draftId);
  assert.equal((await request('/api/intake/legacy-intake', { cookie: admin.cookie })).status, 200);
  const teacher = await register('teacher@example.com');
  const otherTeacher = await register('other@example.com');
  assert.equal(teacher.value.user.role, 'teacher');
  assert.equal(otherTeacher.value.user.role, 'teacher');
  assert.deepEqual((await request('/api/drafts', { cookie: teacher.cookie })).value.drafts, []);
  assert.equal((await request(`/api/drafts/${legacyDraft.draftId}`, { cookie: teacher.cookie })).status, 404);
  assert.equal((await request('/api/intake/legacy-intake', { cookie: teacher.cookie })).status, 404);

  const bank = await request('/api/question-bank?pageSize=1', { cookie: teacher.cookie });
  assert.equal(bank.status, 200);
  const { questionId, contentVersion, teacherVersion } = bank.value.questions[0];
  const body = { selections: [{ questionId, contentVersion, teacherVersion }], title: '教师个人练习' };
  assert.equal((await request('/api/question-bank/manual-draft', { cookie: teacher.cookie, body, origin: 'https://attacker.invalid' })).status, 403);
  const saved = await request('/api/question-bank/manual-draft', { cookie: teacher.cookie, body });
  assert.equal(saved.status, 201, JSON.stringify(saved.value));
  const draftId = saved.value.draft.draftId;
  const previewAssets = await request(`/api/drafts/${draftId}/preview`, { cookie: teacher.cookie });
  assert.equal(previewAssets.status, 200); assert.equal(previewAssets.value.draftId, draftId);
  assert.equal((await request(`/api/drafts/${draftId}/preview`)).status, 401);
  assert.equal((await request(`/api/drafts/${draftId}`, { cookie: teacher.cookie })).status, 200);
  const rename = await request(`/api/drafts/${draftId}/operations`, { cookie: teacher.cookie,
    body: { type: 'rename', title: '教师私人诊断卷', operationId: 'rename-private-draft', expectedRevision: saved.value.draft.revision ?? 0 } });
  assert.equal(rename.status, 200, JSON.stringify(rename.value));
  assert.equal(rename.value.draft.title, '教师私人诊断卷');
  assert.deepEqual(rename.value.draft.baseline, saved.value.draft.baseline);
  assert.deepEqual(rename.value.draft.slots, saved.value.draft.slots);
  const confirmation = await request(`/api/drafts/${draftId}/confirm`, { cookie: teacher.cookie,
    body: { operationId: 'confirm-private-paper', expectedRevision: rename.value.draft.revision, acknowledgeDifferences: true } });
  assert.equal(confirmation.value.ok, true, JSON.stringify(confirmation.value));
  const paperId = confirmation.value.paper.paperId;
  assert.equal((await request(`/api/drafts/${draftId}/operations`, { cookie: teacher.cookie,
    body: { type: 'rename', title: 'cannot-rename-frozen', operationId: 'rename-frozen', expectedRevision: confirmation.value.draft?.revision ?? 2 } })).status, 409);
  assert.equal((await request(`/api/papers/${paperId}`, { cookie: teacher.cookie })).status, 200);
  const output = await generateOutput(confirmation.value.paper, 'student', { outputRoot: path.join(base, 'outputs'),
    generate: async (_paper, _kind, { outputRoot }) => {
      await mkdir(outputRoot, { recursive: true });
      const bytes = Buffer.from('%PDF-1.7\nprivate-output-fixture');
      const target = path.join(outputRoot, 'student.pdf');
      await writeFile(target, bytes);
      return { ok: true, artifact: { path: target, status: 'complete', sha256: createHash('sha256').update(bytes).digest('hex'), pages: 1 } };
    } });
  assert.equal(output.ok, true);
  const ownerPdf = await fetch(`${baseUrl}/api/papers/${paperId}/outputs/student/file`, { headers: { Cookie: teacher.cookie } });
  assert.equal(ownerPdf.status, 200);
  assert.equal(ownerPdf.headers.get('content-type'), 'application/pdf');
  assert.match(await ownerPdf.text(), /private-output-fixture/);
  const intake = await request('/api/intake', { cookie: teacher.cookie, body: { sessionId: 'private-intake', action: 'start' } });
  assert.equal(intake.status, 200);
  assert.equal((await request('/api/intake/private-intake', { cookie: teacher.cookie })).status, 200);

  for (const user of [admin, otherTeacher]) {
    const cookie = user.cookie;
    assert.equal((await request('/api/drafts', { cookie })).value.drafts.some(draft => draft.draftId === draftId), false);
    assert.equal((await request('/api/papers', { cookie })).value.papers.some(paper => paper.paperId === paperId), false);
    for (const route of [`/api/drafts/${draftId}`, `/api/drafts/${draftId}/preview`, `/api/drafts/${draftId}/confirmation`, `/api/papers/${paperId}`,
      `/api/papers/${paperId}/outputs/student/file`, '/api/intake/private-intake']) {
      assert.equal((await request(route, { cookie })).status, 404, route);
    }
    assert.equal((await request(`/api/drafts/${draftId}/candidates`, { cookie, body: {} })).status, 404);
    assert.equal((await request(`/api/drafts/${draftId}/operations`, { cookie,
      body: { type: 'rename', title: 'steal', operationId: 'steal-rename', expectedRevision: 2 } })).status, 404);
    assert.equal((await request(`/api/papers/${paperId}/derive`, { cookie, body: { operationId: 'steal-derive' } })).status, 404);
    assert.equal((await request('/api/intake', { cookie, body: { sessionId: 'private-intake', action: 'answer' } })).status, 404);
  }
  assert.equal((await request('/api/auth/logout', { cookie: teacher.cookie, method: 'POST' })).status, 200);
  assert.equal((await request('/api/config', { cookie: teacher.cookie })).status, 401);
});

test('Nest routes administrator user management and nested password reset through authentication', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'tutor-admin-http-'));
  const application = await createNestApp({ storeRoot: path.join(base, 'drafts'), logger: false });
  t.after(async () => { await application.close(); await rm(base, { recursive: true, force: true }); });
  await application.app.listen(0, '127.0.0.1');
  const baseUrl = await application.app.getUrl();
  const request = async (route, { cookie, body, origin = baseUrl } = {}) => {
    const response = await fetch(`${baseUrl}${route}`, { method: body ? 'POST' : 'GET', headers: {
      ...(cookie ? { Cookie: cookie } : {}), ...(body ? { Origin: origin, 'Content-Type': 'application/json' } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, value: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const admin = await request('/api/auth/register', { body: { email: 'admin@example.com', password: 'admin-password-2026' } });
  assert.equal((await request('/api/auth/users')).status, 401);
  const created = await request('/api/auth/users', { cookie: admin.cookie, body: { email: 'teacher@example.com', password: 'teacher-password-2026', role: 'admin' } });
  assert.equal(created.status, 201, JSON.stringify(created.value));
  assert.equal(created.cookie, undefined);
  assert.equal(created.value.user.role, 'teacher');
  assert.equal((await request('/api/auth/me', { cookie: admin.cookie })).value.user.role, 'admin');
  const teacher = await request('/api/auth/login', { body: { email: 'teacher@example.com', password: 'teacher-password-2026' } });
  assert.equal((await request('/api/auth/users', { cookie: teacher.cookie })).status, 403);
  const route = `/api/auth/users/${created.value.user.userId}/password`;
  const body = { password: 'changed-password-2026' };
  assert.equal((await request(route, { body })).status, 401);
  assert.equal((await request(route, { cookie: teacher.cookie, body })).status, 403);
  assert.equal((await request(route, { cookie: admin.cookie, body, origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await request(route, { cookie: admin.cookie, body })).status, 200);
  assert.equal((await request('/api/question-bank', { cookie: teacher.cookie })).status, 401);
  assert.equal((await request('/api/auth/login', { body: { email: 'teacher@example.com', password: 'teacher-password-2026' } })).status, 401);
  assert.equal((await request('/api/auth/login', { body: { email: 'teacher@example.com', ...body } })).status, 200);
  assert.equal((await request('/api/auth/users', { cookie: admin.cookie })).value.users.length, 2);
});
