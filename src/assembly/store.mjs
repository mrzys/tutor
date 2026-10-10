import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { hashContent } from '../question-bank/reader.mjs';

const validId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function storeError(code, message) {
  return Object.assign(new Error(message), { code });
}

export async function readDraft(storeRoot, draftId) {
  if (!validId.test(draftId)) throw storeError('not_found', '没有找到该草稿。');
  let saved;
  try { saved = JSON.parse(await readFile(path.join(storeRoot, `${draftId}.json`), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw storeError('not_found', '没有找到该草稿。');
    throw storeError('read_error', '草稿文件无法读取，请保留文件并检查本地存储。');
  }
  if (saved.schemaVersion !== 1 || saved.draft?.draftId !== draftId
      || saved.sha256 !== hashContent(saved.draft)) {
    throw storeError('integrity_error', '草稿校验不通过，未替换为其他内容。');
  }
  return saved.draft;
}

export async function saveDraft(storeRoot, draft) {
  if (!validId.test(draft.draftId)) throw storeError('save_error', '草稿身份无效。');
  const target = path.join(storeRoot, `${draft.draftId}.json`);
  const temp = `${target}.${process.pid}.tmp`;
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
  try { files = await readdir(storeRoot); }
  catch (error) {
    if (error.code === 'ENOENT') return { drafts: [], warnings: [] };
    throw storeError('read_error', '无法读取已保存草稿目录。');
  }
  const drafts = []; const warnings = [];
  for (const filename of files.filter(name => name.endsWith('.json'))) {
    const draftId = filename.slice(0, -5);
    try {
      const draft = await readDraft(storeRoot, draftId);
      drafts.push({ draftId, title: draft.title, createdAt: draft.createdAt, stats: draft.stats });
    } catch (error) { warnings.push({ draftId, code: error.code, message: error.message }); }
  }
  drafts.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.draftId.localeCompare(b.draftId));
  return { drafts, warnings };
}
