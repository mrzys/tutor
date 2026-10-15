import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { hashContent } from '../question-bank/reader.mjs';
import { randomUUID } from 'node:crypto';
import { sqliteStorage } from '../storage/sqlite.mjs';
import { purposeFor } from './purposes.mjs';
import { canonicalSectionId } from '../curriculum/section-identity.mjs';

const validId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const updates = new Map();

function storeError(code, message) {
  return Object.assign(new Error(message), { code });
}

export async function readDraft(storeRoot, draftId) {
  if (!validId.test(draftId)) throw storeError('not_found', '没有找到该草稿。');
  let saved;
  try {
    const repository = sqliteStorage(storeRoot, 'drafts');
    if (repository) {
      saved = repository.get('drafts', draftId);
      if (!saved) throw storeError('ENOENT', '没有找到该草稿。');
    } else saved = JSON.parse(await readFile(path.join(storeRoot, `${draftId}.json`), 'utf8'));
  }
  catch (error) {
    if (error.code === 'ENOENT') throw storeError('not_found', '没有找到该草稿。');
    if (error.code === 'integrity_error') throw error;
    throw storeError('read_error', '草稿文件无法读取，请保留文件并检查本地存储。');
  }
  if (saved.schemaVersion !== 1 || saved.draft?.draftId !== draftId
      || saved.sha256 !== hashContent(saved.draft)) {
    throw storeError('integrity_error', '草稿校验不通过，未替换为其他内容。');
  }
  return saved.draft;
}

export async function saveDraft(storeRoot, draft, options = {}) {
  if (!validId.test(draft.draftId)) throw storeError('save_error', '草稿身份无效。');
  const repository = sqliteStorage(storeRoot, 'drafts');
  if (repository) {
    repository.put('drafts', draft.draftId, { schemaVersion: 1, sha256: hashContent(draft), draft }, options);
    return draft;
  }
  const target = path.join(storeRoot, `${draft.draftId}.json`);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const payload = JSON.stringify({ schemaVersion: 1, sha256: hashContent(draft), draft }, null, 2);
  let file;
  try {
    await mkdir(storeRoot, { recursive: true });
    file = await open(temp, 'wx');
    await file.writeFile(`${payload}\n`, 'utf8');
    await file.sync();
    await file.close(); file = undefined;
    await rename(temp, target);
  } catch (error) {
    await file?.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw storeError('save_error', `草稿保存失败：${error.message}`);
  }
  return draft;
}

export async function listDrafts(storeRoot) {
  let files;
  const repository = sqliteStorage(storeRoot, 'drafts');
  try { files = repository ? repository.list('drafts').map(id => `${id}.json`) : await readdir(storeRoot); }
  catch (error) {
    if (error.code === 'ENOENT') return { drafts: [], warnings: [] };
    throw storeError('read_error', '无法读取已保存草稿目录。');
  }
  const drafts = []; const warnings = (repository?.warnings('drafts') ?? []).map(item => ({ ...item, draftId: item.id }));
  for (const filename of files.filter(name => name.endsWith('.json'))) {
    const draftId = filename.slice(0, -5);
    try {
      const draft = await readDraft(storeRoot, draftId);
      const requirements = draft.baseline.requirements;
      const chapters = draft.baseline.taskCatalogSnapshot?.chapters ?? [];
      const seen = new Set();
      const scopeLabels = (requirements.mainScope ?? []).flatMap(id => {
        const canonical = canonicalSectionId(id);
        if (seen.has(canonical)) return [];
        seen.add(canonical);
        const chapter = chapters.find(item => canonicalSectionId(item.id) === canonical);
        return typeof chapter?.label === 'string' ? [chapter.label] : [];
      });
      drafts.push({ draftId, title: draft.title, createdAt: draft.createdAt, stats: draft.stats, revision: draft.revision ?? 0,
        scoringMode: requirements.scoringMode ?? 'points', scopeSummary: scopeLabels.join('、').slice(0, 400),
        purposeLabel: purposeFor(requirements.purpose)?.label ?? '' });
    } catch (error) { warnings.push({ draftId, code: error.code, message: error.message }); }
  }
  drafts.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.draftId.localeCompare(b.draftId));
  return { drafts, warnings };
}

// Serialize read-check-write for a draft. Other drafts can progress independently.
export async function updateDraft(storeRoot, draftId, transform, { persist = saveDraft } = {}) {
  if (!validId.test(draftId)) throw storeError('not_found', '没有找到该草稿。');
  const key = path.resolve(storeRoot, `${draftId}.json`);
  const previous = updates.get(key) ?? Promise.resolve();
  const transaction = previous.then(async () => {
    const current = await readDraft(storeRoot, draftId);
    const result = await transform(current);
    if (!result.ok) return result;
    if ((result.draft.revision ?? 0) !== (current.revision ?? 0)) {
      await persist(storeRoot, result.draft, { expectedRevision: current.revision ?? 0 });
    }
    return result;
  });
  const tail = transaction.catch(() => {});
  updates.set(key, tail);
  try { return await transaction; }
  finally { if (updates.get(key) === tail) updates.delete(key); }
}
