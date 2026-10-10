import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAssemblyConfig, previewBlueprint, recheckBlueprint, createDraft } from './assembly/engine.mjs';
import { listQuestions } from './question-bank/reader.mjs';
import { saveDraft, readDraft, listDrafts } from './assembly/store.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml',
};

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function body(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    throw Object.assign(new Error('请使用 JSON 提交需求。'), { code: 'invalid_request', status: 400 });
  }
  let bytes = 0; const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 256 * 1024) throw Object.assign(new Error('需求内容过长。'), { code: 'invalid_request', status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('提交内容不是有效 JSON。'), { code: 'invalid_request', status: 400 }); }
}

export function createAppServer({ root = repoRoot, storeRoot = path.join(root, '.tutor', 'drafts') } = {}) {
  return http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'POST' && request.headers.origin) {
        const allowed = new Set([`http://${request.headers.host}`, 'http://127.0.0.1:5173']);
        if (!allowed.has(request.headers.origin)) {
          return json(response, 403, { ok: false, error: { code: 'invalid_origin', message: '此操作仅接受本地组卷页面。' } });
        }
      }
      if (url.pathname === '/api/config' && request.method === 'GET') {
        const [config, bank, context, saved] = await Promise.all([
          getAssemblyConfig({ root }), listQuestions({ root }),
          readFile(path.join(root, 'data/question-bank/course-context.json'), 'utf8').then(JSON.parse),
          listDrafts(storeRoot),
        ]);
        if (!config.ok) return json(response, 500, config);
        if (!bank.ok) return json(response, 500, bank);
        config.config.sources = config.config.sources.map(source => ({ ...source,
          label: source.sourceId === 'set-teacher' ? '集合汇编 · 解析版' : '集合汇编 · 原卷版（已分离答案）',
        }));
        return json(response, 200, { ok: true, config: { ...config.config, foundation: context.foundation,
          context, supply: bank.totals, drafts: saved.drafts, draftWarnings: saved.warnings } });
      }
      if (url.pathname === '/api/blueprint' && request.method === 'POST') {
        const input = await body(request);
        const result = await previewBlueprint(input.requirements, { root });
        return json(response, result.ok ? 200 : result.error.code === 'invalid_plan' ? 400 : 500, result);
      }
      if (url.pathname === '/api/blueprint/recheck' && request.method === 'POST') {
        const input = await body(request);
        const result = await recheckBlueprint(input.blueprint, { root });
        return json(response, result.ok ? 200 : result.error.code === 'invalid_plan' ? 400 : 500, result);
      }
      if (url.pathname === '/api/drafts' && request.method === 'POST') {
        const input = await body(request);
        const result = await createDraft(input.blueprint, { root });
        if (!result.ok) return json(response, result.error.code === 'invalid_plan' ? 400 : 500, result);
        await saveDraft(storeRoot, result.draft);
        return json(response, 201, result);
      }
      if (url.pathname === '/api/drafts' && request.method === 'GET') {
        return json(response, 200, { ok: true, ...await listDrafts(storeRoot) });
      }
      if (url.pathname.startsWith('/api/drafts/') && request.method === 'GET') {
        return json(response, 200, { ok: true, draft: await readDraft(storeRoot, url.pathname.slice('/api/drafts/'.length)) });
      }
      if (url.pathname.startsWith('/api/')) {
        return json(response, 404, { ok: false, error: { code: 'not_found', message: '没有找到该操作。' } });
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json(response, 405, { ok: false, error: { code: 'method_not_allowed', message: '该地址不支持此操作。' } });
      }
      const distRoot = path.join(root, 'dist');
      let relative = decodeURIComponent(url.pathname).slice(1) || 'index.html';
      if (relative.includes('\\') || relative.includes('\0') || relative.split('/').includes('..')) {
        return json(response, 400, { ok: false, error: { code: 'invalid_path', message: '文件路径无效。' } });
      }
      let target = path.resolve(distRoot, relative);
      if (path.relative(distRoot, target).startsWith('..') || path.isAbsolute(path.relative(distRoot, target))) {
        return json(response, 400, { ok: false, error: { code: 'invalid_path', message: '文件路径无效。' } });
      }
      try { if (!(await stat(target)).isFile()) throw new Error('Not a file'); }
      catch {
        if (path.extname(relative)) return json(response, 404, { ok: false, error: { code: 'not_found', message: '没有找到页面资源。' } });
        target = path.join(distRoot, 'index.html');
      }
      let content;
      try { content = await readFile(target); }
      catch { return json(response, 503, { ok: false, error: { code: 'build_required', message: '请先运行 npm run build，或运行 npm run dev。' } }); }
      response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(target)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache' });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      json(response, error.status ?? (error.code === 'not_found' ? 404 : 500),
        { ok: false, error: { code: error.code ?? 'server_error', message: error.message } });
    }
  });
}
