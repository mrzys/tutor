import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readDraft, saveDraft, updateDraft } from '../src/assembly/store.mjs';

test('failed persistence leaves the last saved revision intact and releases the draft queue', async () => {
  const storeRoot = await mkdtemp(path.join(os.tmpdir(), 'tutor-s303-save-failure-'));
  const draft = { draftId: randomUUID(), revision: 0, title: '保存失败隔离验证', slots: [] };
  await saveDraft(storeRoot, draft);
  const transform = async current => ({ ok: true, draft: { ...current, revision: current.revision + 1 } });
  await assert.rejects(updateDraft(storeRoot, draft.draftId, transform, {
    persist: async () => { throw Object.assign(new Error('Injected disk failure'), { code: 'save_error' }); },
  }), { code: 'save_error' });
  assert.deepEqual(await readDraft(storeRoot, draft.draftId), draft);
  const recovered = await updateDraft(storeRoot, draft.draftId, transform);
  assert.equal(recovered.draft.revision, 1);
  assert.deepEqual(await readDraft(storeRoot, draft.draftId), recovered.draft);
});
