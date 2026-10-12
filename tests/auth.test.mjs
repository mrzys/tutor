import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SqliteRepository } from '../src/storage/sqlite.mjs';
import { createAuthService } from '../src/auth/service.mjs';
import { requestClientAddress } from '../src/auth/request-origin.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tutor-auth-'));
  const repository = new SqliteRepository(path.join(directory, 'auth.sqlite'));
  const auth = createAuthService(repository, options);
  const server = createServer(async (request, response) => {
    if (!(await auth.handle(request, response, new URL(request.url, `http://${request.headers.host}`)))) {
      response.end(JSON.stringify(auth.authenticate(request)));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    repository.database.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function request(route, { body, cookie, origin = base, headers = {}, method = body ? 'POST' : 'GET' } = {}) {
    const response = await fetch(base + route, { method, headers: {
      ...(method === 'POST' ? { 'content-type': 'application/json', origin } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), headers: response.headers,
      cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  return { repository, auth, base, request };
}
const credentials = (email = 'teacher@example.com') => ({ email, password: 'teach-math-2026' });

test('proxy login limits use the original IP only from a trusted loopback proxy', () => {
  const request = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-real-ip': '203.0.113.42' } };
  assert.equal(requestClientAddress(request, true), '203.0.113.42');
  assert.equal(requestClientAddress(request, false), '127.0.0.1');
  assert.equal(requestClientAddress({ ...request, socket: { remoteAddress: '203.0.113.10' } }, true), '203.0.113.10');
  assert.equal(requestClientAddress({ ...request, headers: { 'x-real-ip': 'invalid' } }, true), '127.0.0.1');
});

test('explicit loopback proxy supports HTTPS origins and secure cookies without trusting remote spoofed headers', async t => {
  const f = await fixture(t, { trustProxy: true });
  const created = await f.request('/api/auth/register', { body: credentials(), origin: f.base.replace('http:', 'https:'), headers: { 'x-forwarded-proto': 'https' } });
  assert.equal(created.status, 201);
  assert.match(created.headers.get('set-cookie'), /; Secure/);
  assert.throws(() => f.auth.assertSameOrigin({ socket: { remoteAddress: '203.0.113.10' }, headers: { host: 'tutor.example', origin: 'https://tutor.example', 'x-forwarded-proto': 'https' } }), { code: 'invalid_origin' });
  assert.throws(() => f.auth.assertSameOrigin({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'tutor.example', origin: 'https://attacker.example', 'x-forwarded-proto': 'https' } }), { code: 'invalid_origin' });
});

test('forwarded HTTPS headers are ignored when proxy trust is disabled', async t => {
  const f = await fixture(t, { trustProxy: false });
  assert.equal((await f.request('/api/auth/register', { body: credentials(), origin: f.base.replace('http:', 'https:'), headers: { 'x-forwarded-proto': 'https' } })).status, 403);
});

test('concurrent first registrations assign exactly one admin and store only salted passwords and hashed opaque sessions', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request('/api/auth/me')).data, { ok: true, user: null, hasUsers: false });
  const results = await Promise.all(['FIRST@example.com', 'second@example.com'].map(email => f.request('/api/auth/register', { body: credentials(email) })));
  assert.deepEqual(results.map(result => result.status), [201, 201]);
  assert.equal(results.filter(result => result.data.user.role === 'admin').length, 1);
  assert.equal(results.filter(result => result.data.user.role === 'teacher').length, 1);
  assert.equal(results[0].data.user.email, 'first@example.com');
  for (const result of results) {
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.match(result.headers.get('set-cookie'), /HttpOnly; SameSite=Lax; Max-Age=604800/);
    assert.deepEqual(Object.keys(result.data.user).sort(), ['createdAt', 'email', 'role', 'userId']);
    assert.equal((await f.request('/api/auth/me', { cookie: result.cookie })).data.user.userId, result.data.user.userId);
    const token = result.cookie.split('=')[1];
    const row = f.repository.database.prepare('SELECT * FROM auth_sessions WHERE token_hash=?').get(createHash('sha256').update(token).digest('hex'));
    assert.ok(row);
    assert.notEqual(row.token_hash, token);
  }
  const users = f.repository.database.prepare('SELECT * FROM users').all();
  assert.equal(new Set(users.map(user => user.password_salt)).size, 2);
  assert.equal(new Set(users.map(user => user.password_hash)).size, 2);
  assert.ok(users.every(user => !JSON.stringify(user).includes(credentials().password)));
});

test('duplicate emails, invalid credentials, logout and expiration are enforced', async t => {
  let now = Date.now();
  const f = await fixture(t, { clock: () => now, sessionTtlMs: 2000 });
  const created = await f.request('/api/auth/register', { body: credentials() });
  assert.equal((await f.request('/api/auth/register', { body: credentials('TEACHER@example.com') })).status, 409);
  for (const body of [credentials('absent@example.com'), { ...credentials(), password: 'wrong-password' }]) {
    const failed = await f.request('/api/auth/login', { body });
    assert.equal(failed.status, 401);
    assert.equal(failed.data.error.code, 'invalid_credentials');
    assert.equal(failed.headers.get('set-cookie'), null);
  }
  const logged = await f.request('/api/auth/login', { body: credentials('TEACHER@example.com') });
  assert.equal(logged.status, 200);
  assert.notEqual(logged.cookie, created.cookie);
  assert.equal((await f.request('/api/auth/logout', { method: 'POST', cookie: logged.cookie })).status, 200);
  assert.equal((await f.request('/api/auth/me', { cookie: logged.cookie })).data.user, null);
  now += 2001;
  assert.equal((await f.request('/api/auth/me', { cookie: created.cookie })).data.user, null);
});

test('authentication survives restart without needing seed files', async t => {
  const f = await fixture(t);
  const created = await f.request('/api/auth/register', { body: credentials() });
  const reopened = new SqliteRepository(f.repository.filename);
  try {
    const user = createAuthService(reopened).authenticate({ headers: { cookie: created.cookie } });
    assert.equal(user.email, credentials().email);
    assert.equal(user.role, 'admin');
  } finally { reopened.database.close(); }
});

test('cross-origin requests, malformed input and repeated login attempts are rejected', async t => {
  const f = await fixture(t);
  const denied = await f.request('/api/auth/register', { body: credentials(), origin: 'http://attacker.invalid' });
  assert.equal(denied.status, 403);
  assert.equal(f.repository.database.prepare('SELECT count(*) n FROM users').get().n, 0);
  assert.equal((await f.request('/api/auth/register', { body: { ...credentials(), password: 'tiny' } })).status, 400);
  assert.equal((await f.request('/api/auth/register', { body: { ...credentials(), email: 'invalid' } })).status, 400);
  assert.equal((await f.request('/api/auth/login', { body: { ...credentials(), password: 'x'.repeat(5000) } })).status, 413);
  for (let i = 0; i < 20; i += 1) await f.request('/api/auth/login', { body: { email: 'invalid', password: 'invalid' } });
  const limited = await f.request('/api/auth/login', { body: credentials() });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '900');
});

test('first admin hook is atomic with registration', async t => {
  const f = await fixture(t, { onFirstUser() { throw new Error('claim failed'); } });
  assert.equal((await f.request('/api/auth/register', { body: credentials() })).status, 500);
  assert.equal(f.repository.database.prepare('SELECT count(*) n FROM users').get().n, 0);
  assert.equal(f.repository.database.prepare('SELECT count(*) n FROM auth_sessions').get().n, 0);
});

test('admin account creation validates input, prevents escalation and keeps the administrator session', async t => {
  const f = await fixture(t);
  const admin = await f.request('/api/auth/register', { body: credentials('admin@example.com') });
  const teacher = await f.request('/api/auth/register', { body: credentials('ordinary@example.com') });
  for (const route of ['/api/auth/users', `/api/auth/users/${admin.data.user.userId}/password`]) {
    const options = route.endsWith('/password') ? { body: { password: 'changed-password' } } : {};
    assert.equal((await f.request(route, options)).status, 401);
    assert.equal((await f.request(route, { ...options, cookie: teacher.cookie })).status, 403);
  }
  assert.equal((await f.request('/api/auth/users', { body: credentials('denied@example.com') })).status, 401);
  assert.equal((await f.request('/api/auth/users', { body: credentials('denied@example.com'), cookie: teacher.cookie })).status, 403);
  const created = await f.request('/api/auth/users', { cookie: admin.cookie, body: { ...credentials('NEW@example.com'), role: 'admin' } });
  assert.equal(created.status, 201);
  assert.equal(created.cookie, undefined);
  assert.equal(created.data.user.role, 'teacher');
  assert.equal(created.data.user.email, 'new@example.com');
  assert.deepEqual(Object.keys(created.data.user).sort(), ['createdAt', 'email', 'role', 'userId']);
  assert.equal((await f.request('/api/auth/me', { cookie: admin.cookie })).data.user.userId, admin.data.user.userId);
  assert.equal((await f.request('/api/auth/login', { body: credentials('new@example.com') })).status, 200);
  const listed = await f.request('/api/auth/users', { cookie: admin.cookie });
  assert.equal(listed.status, 200);
  assert.equal(listed.data.users.length, 3);
  assert.equal(listed.headers.get('cache-control'), 'no-store');
  assert.ok(listed.data.users.every(user => Object.keys(user).length === 4));
  assert.equal((await f.request('/api/auth/users', { cookie: admin.cookie, body: credentials('New@EXAMPLE.COM') })).status, 409);
  for (const body of [{ ...credentials(), email: 'invalid' }, { ...credentials(), password: 'tiny' }, { ...credentials(), password: 'x'.repeat(129) }]) {
    assert.equal((await f.request('/api/auth/users', { cookie: admin.cookie, body })).status, 400);
  }
  assert.equal((await f.request('/api/auth/users', { cookie: admin.cookie, origin: 'http://attacker.invalid', body: credentials('cross@example.com') })).status, 403);
  assert.equal(f.repository.database.prepare('SELECT count(*) n FROM users').get().n, 3);
});

test('admin password changes revoke target sessions, replace credentials and rotate the current admin session', async t => {
  const f = await fixture(t);
  const admin = await f.request('/api/auth/register', { body: credentials('admin@example.com') });
  const teacher = await f.request('/api/auth/register', { body: credentials() });
  const secondTeacherSession = await f.request('/api/auth/login', { body: credentials() });
  const route = `/api/auth/users/${teacher.data.user.userId}/password`;
  assert.equal((await f.request(route, { cookie: admin.cookie, origin: 'http://attacker.invalid', body: { password: 'new-teacher-password' } })).status, 403);
  assert.equal((await f.request(route, { cookie: admin.cookie, body: { password: 'short' } })).status, 400);
  assert.equal((await f.request('/api/auth/users/absent/password', { cookie: admin.cookie, body: { password: 'new-teacher-password' } })).status, 404);
  const before = f.repository.database.prepare('SELECT password_hash,password_salt FROM users WHERE user_id=?').get(teacher.data.user.userId);
  const changed = await f.request(route, { cookie: admin.cookie, body: { password: 'new-teacher-password', role: 'admin' } });
  assert.equal(changed.status, 200);
  assert.equal(changed.cookie, undefined);
  assert.equal(changed.data.user.role, 'teacher');
  assert.ok(!JSON.stringify(changed.data).includes('new-teacher-password'));
  const after = f.repository.database.prepare('SELECT password_hash,password_salt FROM users WHERE user_id=?').get(teacher.data.user.userId);
  assert.notEqual(after.password_hash, before.password_hash);
  assert.notEqual(after.password_salt, before.password_salt);
  for (const cookie of [teacher.cookie, secondTeacherSession.cookie]) {
    assert.equal((await f.request('/api/auth/me', { cookie })).data.user, null);
  }
  assert.equal((await f.request('/api/auth/login', { body: credentials() })).status, 401);
  assert.equal((await f.request('/api/auth/login', { body: { ...credentials(), password: 'new-teacher-password' } })).status, 200);
  assert.equal((await f.request('/api/auth/me', { cookie: admin.cookie })).data.user.role, 'admin');

  const otherAdminSession = await f.request('/api/auth/login', { body: credentials('admin@example.com') });
  const selfReset = await f.request(`/api/auth/users/${admin.data.user.userId}/password`, { cookie: admin.cookie, body: { password: 'new-admin-password' } });
  assert.equal(selfReset.status, 200);
  assert.ok(selfReset.cookie);
  assert.notEqual(selfReset.cookie, admin.cookie);
  for (const cookie of [admin.cookie, otherAdminSession.cookie]) assert.equal((await f.request('/api/auth/me', { cookie })).data.user, null);
  assert.equal((await f.request('/api/auth/me', { cookie: selfReset.cookie })).data.user.role, 'admin');
  assert.equal((await f.request('/api/auth/users', { cookie: selfReset.cookie })).status, 200);
  assert.equal((await f.request('/api/auth/login', { body: credentials('admin@example.com') })).status, 401);
  assert.equal((await f.request('/api/auth/login', { body: { ...credentials('admin@example.com'), password: 'new-admin-password' } })).status, 200);
});

test('administrator password hashing operations are rate limited', async t => {
  const f = await fixture(t);
  const admin = await f.request('/api/auth/register', { body: credentials('admin@example.com') });
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await f.request('/api/auth/users', { cookie: admin.cookie, body: { email: 'invalid', password: 'invalid' } })).status, 400);
  }
  const limited = await f.request('/api/auth/users', { cookie: admin.cookie, body: credentials('limited@example.com') });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '900');
  assert.equal(f.repository.database.prepare('SELECT count(*) n FROM users').get().n, 1);
});
