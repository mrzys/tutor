import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNestApp } from '../src/api/app.ts';

test('NestJS serves existing contracts through one listener with SQLite persistence', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'tutor-nest-'));
  let serviceRepository;
  const application = await createNestApp({ storeRoot: path.join(base, 'drafts'), logger: false,
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
});
