import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { SqliteRepository } from '../src/storage/sqlite.mjs';
import { installUserAccess } from '../src/auth/access.mjs';

test('simultaneous private intake writes cannot claim the same ID or overwrite another teacher session', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'tutor-auth-access-'));
  const repository = new SqliteRepository(path.join(base, 'auth.sqlite'));
  t.after(async () => { repository.database.close(); await rm(base, { recursive: true, force: true }); });
  const access = installUserAccess(repository);
  const users = [0, 1].map(index => ({ userId: randomUUID(), email: `teacher${index}@example.com`, role: 'teacher' }));
  const insert = repository.database.prepare('INSERT INTO users(user_id,email,password_hash,password_salt,role,created_at) VALUES(?,?,?,?,?,?)');
  for (const user of users) insert.run(user.userId, user.email, 'fixture-hash', 'fixture-salt', user.role, new Date().toISOString());
  const results = await Promise.allSettled(users.map(user => access.run(user, () => repository.intakeStorage.put({
    sessionId: 'same-id', revision: 0, marker: user.email,
  }))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.equal(rejected.reason.status, 404);
  const winner = users[results.findIndex(result => result.status === 'fulfilled')];
  const loser = users.find(user => user.userId !== winner.userId);
  assert.equal((await access.run(winner, () => repository.intakeStorage.get('same-id'))).marker, winner.email);
  assert.equal(await access.run(loser, () => repository.intakeStorage.get('same-id')), null);
  assert.equal(repository.database.prepare("SELECT user_id FROM resource_owners WHERE kind='intake' AND id='same-id'").get().user_id, winner.userId);
});
