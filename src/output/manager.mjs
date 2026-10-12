import path from 'node:path';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { hashContent } from '../question-bank/reader.mjs';
import { sqliteStorage } from '../storage/sqlite.mjs';
import { PDF_LAYOUT_VERSION } from './pdf.mjs';

const kinds = ['student', 'teacher'];
const queues = new Map();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function directory(paper, outputRoot, kind) {
  if (!/^[a-f0-9-]{36}$/.test(paper.paperId) || !kinds.includes(kind)) {
    throw Object.assign(new Error('成卷或输出类型无效。'), { code: 'invalid_request' });
  }
  return path.join(outputRoot, paper.paperId);
}

async function saveManifest(target, value) {
  const repository = sqliteStorage(path.dirname(path.dirname(target)), 'outputs');
  if (repository) return repository.put('outputs', `${path.basename(path.dirname(target))}/${value.kind}`, value);
  const temporary = `${target}.${randomUUID()}.tmp`;
  let file;
  try {
    await mkdir(path.dirname(target), { recursive: true });
    file = await open(temporary, 'wx');
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await file.sync(); await file.close(); file = undefined;
    await rename(temporary, target);
  } catch (error) {
    await file?.close().catch(() => {}); await unlink(temporary).catch(() => {});
    throw Object.assign(new Error(`输出状态保存失败：${error.message}`), { code: 'save_error' });
  }
}

async function readManifest(folder, kind, outputRoot) {
  const repository = sqliteStorage(outputRoot, 'outputs');
  if (!repository) return JSON.parse(await readFile(path.join(folder, `${kind}.json`), 'utf8'));
  const value = repository.get('outputs', `${path.basename(folder)}/${kind}`);
  if (!value) throw Object.assign(new Error('输出未生成。'), { code: 'ENOENT' });
  return value;
}

export async function getOutputStatus(paper, kind, { outputRoot }) {
  const folder = directory(paper, outputRoot, kind);
  let manifest;
  try { manifest = await readManifest(folder, kind, outputRoot); }
  catch (error) {
    if (error.code === 'ENOENT') return { kind, status: 'not_generated', issues: [] };
    return { kind, status: 'failed', message: '输出状态无法读取，成卷内容仍保留。', issues: [], errorCode: 'read_error' };
  }
  if (manifest.schemaVersion !== 1 || manifest.paperHash !== hashContent(paper) || manifest.kind !== kind) {
    return { kind, status: 'failed', message: '输出状态与成卷校验不一致，请重试本版。', issues: [], errorCode: 'integrity_error' };
  }
  if (['complete', 'incomplete'].includes(manifest.status)) {
    try {
      if (typeof manifest.filename !== 'string' || path.basename(manifest.filename) !== manifest.filename) throw new Error('Invalid path');
      if (digest(await readFile(path.join(folder, manifest.filename))) !== manifest.sha256) throw new Error('Invalid checksum');
    } catch {
      return { kind, status: 'failed', message: '输出文件缺失或校验失败，请从同一成卷重试本版。', issues: [], errorCode: 'integrity_error' };
    }
  }
  const { filename, paperHash, schemaVersion, ...status } = manifest;
  return { ...status, layoutOutdated: ['complete', 'incomplete'].includes(status.status) && status.layoutVersion !== PDF_LAYOUT_VERSION, ...(['complete', 'incomplete'].includes(status.status)
    ? { downloadUrl: `/api/papers/${paper.paperId}/outputs/${kind}/file` } : {}) };
}

export async function getPaperOutputs(paper, options) {
  const values = await Promise.all(kinds.map(kind => getOutputStatus(paper, kind, options)));
  return Object.fromEntries(values.map(value => [value.kind, value]));
}

export async function generateOutput(paper, kind, { outputRoot, root, generate } = {}) {
  const folder = directory(paper, outputRoot, kind);
  const key = path.join(folder, kind);
  const previous = queues.get(key) ?? Promise.resolve();
  const transaction = previous.then(async () => {
    const cached = await getOutputStatus(paper, kind, { outputRoot });
    if (['complete', 'incomplete'].includes(cached.status) && !cached.layoutOutdated) return { ok: true, output: cached };
    let output;
    try {
      const render = generate ?? (await import('./pdf.mjs')).generatePaperOutput;
      const result = await render(paper, kind, { outputRoot: folder, root });
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      const artifact = result.artifact;
      const relative = path.relative(folder, artifact.path);
      if (!relative || path.basename(relative) !== relative || path.isAbsolute(relative)) throw new Error('输出文件路径无效。');
      const bytes = await readFile(artifact.path);
      if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-')) || digest(bytes) !== artifact.sha256) throw new Error('输出文件校验失败。');
      if (!['complete', 'incomplete'].includes(artifact.status)) throw new Error('输出完成状态无效。');
      output = { schemaVersion: 1, paperHash: hashContent(paper), kind, status: artifact.status,
        filename: relative, sha256: artifact.sha256, pages: artifact.pages, issues: artifact.issues ?? [], layoutVersion: artifact.layoutVersion ?? PDF_LAYOUT_VERSION, createdAt: new Date().toISOString() };
    } catch (error) {
      // A failed layout upgrade must not make a previously verified PDF unavailable.
      if (['complete', 'incomplete'].includes(cached.status)) {
        return { ok: false, error: { code: error.code ?? 'output_error', message: error.message }, output: cached };
      }
      output = { schemaVersion: 1, paperHash: hashContent(paper), kind, status: 'failed',
        message: error.message, errorCode: error.code ?? 'output_error', issues: [], createdAt: new Date().toISOString() };
    }
    await saveManifest(path.join(folder, `${kind}.json`), output);
    const status = await getOutputStatus(paper, kind, { outputRoot });
    return status.status === 'failed'
      ? { ok: false, error: { code: status.errorCode ?? 'output_error', message: status.message }, output: status }
      : { ok: true, output: status };
  });
  const tail = transaction.catch(() => {}); queues.set(key, tail);
  try { return await transaction; }
  finally { if (queues.get(key) === tail) queues.delete(key); }
}

export async function readOutputFile(paper, kind, { outputRoot }) {
  const status = await getOutputStatus(paper, kind, { outputRoot });
  if (!['complete', 'incomplete'].includes(status.status)) {
    throw Object.assign(new Error(status.message ?? '本版尚未生成可下载文件。'), { code: status.errorCode ?? 'not_found' });
  }
  const folder = directory(paper, outputRoot, kind);
  const manifest = await readManifest(folder, kind, outputRoot);
  return { bytes: await readFile(path.join(folder, manifest.filename)), filename: `${kind}-${paper.paperId}.pdf` };
}
