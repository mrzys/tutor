import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { requestClientAddress, requestOrigin, secureRequest } from './request-origin.mjs';

const scrypt = promisify(scryptCallback);
const COOKIE_NAME = 'tutor_session';
const DAY = 24 * 60 * 60 * 1000;
const authError = (status, code, message) => Object.assign(new Error(message), { status, code });
const publicUser = row => row ? { userId: row.user_id, email: row.email, role: row.role, createdAt: row.created_at } : null;
const tokenHash = token => createHash('sha256').update(token).digest('hex');

function sessionToken(request) {
  const cookies = String(request.headers.cookie ?? '').split(';');
  const token = cookies.map(cookie => cookie.trim()).find(cookie => cookie.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

async function readBody(request) {
  if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw authError(415, 'invalid_content_type', '请使用 JSON 提交登录信息。');
  }
  if (Number(request.headers['content-length']) > 4096) throw authError(413, 'request_too_large', '提交内容过长。');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4096) throw authError(413, 'request_too_large', '提交内容过长。');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid body');
    return body;
  } catch {
    throw authError(400, 'invalid_request', '登录信息格式不正确。');
  }
}

function credentials(body) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email)) {
    throw authError(400, 'invalid_email', '请输入有效的邮箱地址。');
  }
  return { email, password: validPassword(body.password) };
}

function validPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128 || Buffer.byteLength(password) > 512) {
    throw authError(400, 'invalid_password', '密码需为 8–128 个字符。');
  }
  return password;
}

/** SQLite is authoritative for users and opaque sessions. No password or token is returned in JSON.
 * @param {any} repository
 * @param {{clock?:()=>number,sessionTtlMs?:number,onFirstUser?:(user:any)=>void,trustProxy?:boolean}} options
 */
export function createAuthService(repository, { clock = Date.now, sessionTtlMs = 7 * DAY, onFirstUser, trustProxy = process.env.TUTOR_TRUST_PROXY === 'loopback' } = {}) {
  const db = repository.database;
  const attempts = new Map();
  let activeHashes = 0;

  const getBootstrapState = () => ({ hasUsers: db.prepare('SELECT 1 FROM users LIMIT 1').get() !== undefined });
  function assertSameOrigin(request) {
    const expected = requestOrigin(request, trustProxy);
    if (request.headers.origin !== expected || ['cross-site', 'same-site'].includes(request.headers['sec-fetch-site'])) {
      throw authError(403, 'invalid_origin', '请求来源不受信任，请刷新页面后重试。');
    }
  }
  function limit(request, kind) {
    const now = clock();
    const key = `${kind}:${requestClientAddress(request, trustProxy)}`;
    const max = kind === 'login' ? 20 : 10;
    const previous = attempts.get(key);
    if (!previous || previous.until <= now) {
      if (attempts.size > 10000) {
        for (const [entry, value] of attempts) if (value.until <= now) attempts.delete(entry);
        if (attempts.size > 10000) throw authError(429, 'rate_limited', '请求较多，请稍后再试。');
      }
      attempts.set(key, { count: 1, until: now + 15 * 60 * 1000 });
    } else if (++previous.count > max) throw authError(429, 'rate_limited', '尝试次数较多，请 15 分钟后再试。');
  }
  async function passwordHash(password, salt) {
    if (activeHashes >= 8) throw authError(429, 'server_busy', '当前请求较多，请稍后重试。');
    activeHashes += 1;
    try { return await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }); }
    finally { activeHashes -= 1; }
  }
  function authenticate(request) {
    const token = sessionToken(request);
    if (!token) return null;
    return publicUser(db.prepare(`SELECT u.* FROM auth_sessions s JOIN users u ON u.user_id=s.user_id
      WHERE s.token_hash=? AND s.expires_at>?`).get(tokenHash(token), clock()));
  }
  function requireAdmin(request) {
    const user = authenticate(request);
    if (!user) throw authError(401, 'authentication_required', '请先登录后继续。');
    if (user.role !== 'admin') throw authError(403, 'admin_required', '仅管理员可以管理用户。');
    return user;
  }
  function cookie(response, request, token, maxAge) {
    response.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureRequest(request, trustProxy) ? '; Secure' : ''}`);
  }
  function createSession(response, request, user) {
    const token = randomBytes(32).toString('base64url');
    const now = clock();
    db.transaction(() => {
      db.prepare('DELETE FROM auth_sessions WHERE expires_at<=?').run(now);
      db.prepare('INSERT INTO auth_sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)')
        .run(tokenHash(token), user.userId, now, now + sessionTtlMs);
    })();
    cookie(response, request, token, Math.floor(sessionTtlMs / 1000));
  }
  function send(response, status, value) {
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.end(JSON.stringify(value));
  }
  async function handle(request, response, url) {
    if (!url.pathname.startsWith('/api/auth/')) return false;
    try {
      if (url.pathname === '/api/auth/me' && request.method === 'GET') {
        send(response, 200, { ok: true, user: authenticate(request), ...getBootstrapState() });
        return true;
      }
      const passwordRoute = /^\/api\/auth\/users\/([^/]+)\/password$/.exec(url.pathname);
      if ((url.pathname === '/api/auth/users' && ['GET', 'POST'].includes(request.method))
        || (passwordRoute && request.method === 'POST')) {
        const administrator = requireAdmin(request);
        if (request.method === 'GET') {
          const users = db.prepare('SELECT user_id,email,role,created_at FROM users ORDER BY created_at,user_id').all().map(publicUser);
          send(response, 200, { ok: true, users });
          return true;
        }
        assertSameOrigin(request);
        limit(request, passwordRoute ? 'admin_password' : 'admin_create');
        const body = await readBody(request);
        if (passwordRoute) {
          const targetId = passwordRoute[1];
          const target = publicUser(db.prepare('SELECT user_id,email,role,created_at FROM users WHERE user_id=?').get(targetId));
          if (!target) throw authError(404, 'user_not_found', '没有找到该用户。');
          const password = validPassword(body.password);
          const salt = randomBytes(16).toString('hex');
          const hash = (await passwordHash(password, salt)).toString('hex');
          // Password derivation yields: recheck privileges before committing any account change.
          requireAdmin(request);
          db.transaction(() => {
            const changed = db.prepare('UPDATE users SET password_hash=?,password_salt=? WHERE user_id=?').run(hash, salt, targetId);
            if (!changed.changes) throw authError(404, 'user_not_found', '没有找到该用户。');
            db.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(targetId);
            // Rotate the current administrator session while signing out all other sessions.
            if (targetId === administrator.userId) createSession(response, request, administrator);
          })();
          send(response, 200, { ok: true, user: target });
          return true;
        }
        const { email, password } = credentials(body);
        const salt = randomBytes(16).toString('hex');
        const hash = (await passwordHash(password, salt)).toString('hex');
        requireAdmin(request);
        const user = { userId: randomUUID(), email, role: 'teacher', createdAt: new Date(clock()).toISOString() };
        try {
          db.prepare('INSERT INTO users(user_id,email,password_hash,password_salt,role,created_at) VALUES(?,?,?,?,?,?)')
            .run(user.userId, email, hash, salt, user.role, user.createdAt);
        } catch (cause) {
          if (cause.code === 'SQLITE_CONSTRAINT_UNIQUE') throw authError(409, 'email_exists', '该邮箱已注册，请使用其他邮箱。');
          throw cause;
        }
        send(response, 201, { ok: true, user });
        return true;
      }
      if (request.method !== 'POST' || !['/api/auth/register', '/api/auth/login', '/api/auth/logout'].includes(url.pathname)) {
        throw authError(404, 'not_found', '未找到账号接口。');
      }
      assertSameOrigin(request);
      if (url.pathname === '/api/auth/logout') {
        const token = sessionToken(request);
        if (token) db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(tokenHash(token));
        cookie(response, request, '', 0);
        send(response, 200, { ok: true, user: null });
        return true;
      }
      const isRegister = url.pathname === '/api/auth/register';
      limit(request, isRegister ? 'register' : 'login');
      const { email, password } = credentials(await readBody(request));
      let user;
      if (isRegister) {
        const salt = randomBytes(16).toString('hex');
        const hash = (await passwordHash(password, salt)).toString('hex');
        try {
          user = db.transaction(() => {
            const role = getBootstrapState().hasUsers ? 'teacher' : 'admin';
            const userId = randomUUID();
            const createdAt = new Date(clock()).toISOString();
            db.prepare('INSERT INTO users(user_id,email,password_hash,password_salt,role,created_at) VALUES(?,?,?,?,?,?)')
              .run(userId, email, hash, salt, role, createdAt);
            const created = { userId, email, role, createdAt };
            // Synchronous hook runs inside the same transaction, e.g. to claim legacy documents.
            if (role === 'admin') onFirstUser?.(created);
            return created;
          }).immediate();
        } catch (cause) {
          if (cause.code === 'SQLITE_CONSTRAINT_UNIQUE') throw authError(409, 'email_exists', '该邮箱已注册，请直接登录。');
          throw cause;
        }
      } else {
        const row = db.prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE').get(email);
        // Unknown accounts still execute the same expensive derivation.
        const hash = await passwordHash(password, row?.password_salt ?? '0'.repeat(32));
        const current = row && db.prepare('SELECT password_hash,password_salt FROM users WHERE user_id=?').get(row.user_id);
        if (!row || !current || current.password_hash !== row.password_hash || current.password_salt !== row.password_salt
          || !timingSafeEqual(hash, Buffer.from(row.password_hash, 'hex'))) {
          throw authError(401, 'invalid_credentials', '邮箱或密码不正确。');
        }
        user = publicUser(row);
      }
      createSession(response, request, user);
      request.auth = user;
      send(response, isRegister ? 201 : 200, { ok: true, user });
    } catch (cause) {
      const status = cause.status ?? 500;
      if (status === 429) response.setHeader('Retry-After', '900');
      send(response, status, { ok: false, error: { code: cause.code ?? 'internal_error', message: status === 500 ? '账号服务暂不可用，请稍后再试。' : cause.message } });
    }
    return true;
  }
  return { handle, authenticate, assertSameOrigin, getBootstrapState };
}
