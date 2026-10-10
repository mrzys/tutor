import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAssemblyConfig, previewBlueprint, recheckBlueprint, createDraft } from './assembly/engine.mjs';
import { listQuestions } from './question-bank/reader.mjs';
import { saveDraft, readDraft, listDrafts, updateDraft } from './assembly/store.mjs';
import { applyDraftOperation, previewDraftCandidates } from './assembly/editor.mjs';
import { confirmPaper, preparePaperConfirmation, getPaper, listPapers, derivePaperDraft, findPaperForDraft } from './assembly/papers.mjs';
import { readFeedback, saveFeedback } from './assembly/feedback.mjs';
import { getPaperOutputs, generateOutput, readOutputFile } from './output/manager.mjs';

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

function editorStatus(result) {
  if (result.ok) return 200;
  if (['revision_conflict', 'operation_conflict', 'finalized_draft'].includes(result.error.code)) return 409;
  if (['invalid_operation', 'invalid_plan', 'invalid_request', 'confirmation_required'].includes(result.error.code)) return 400;
  if (result.error.code === 'not_found') return 404;
  return 500;
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
  const papersRoot = path.join(path.dirname(storeRoot), 'papers');
  const outputRoot = path.join(path.dirname(storeRoot), 'outputs');
  const feedbackRoot = path.join(path.dirname(storeRoot), 'feedback');
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
      const confirmationRoute = url.pathname.match(/^\/api\/drafts\/([^/]+)\/(confirmation|confirm)$/);
      if (confirmationRoute?.[2] === 'confirmation' && request.method === 'GET') {
        const current = await readDraft(storeRoot, confirmationRoute[1]);
        return json(response, 200, { ok: true, summary: preparePaperConfirmation(current), confirmedPaperId: current.confirmedPaperId });
      }
      if (confirmationRoute?.[2] === 'confirm' && request.method === 'POST') {
        const result = await confirmPaper(storeRoot, confirmationRoute[1], await body(request), { root, papersRoot });
        return json(response, editorStatus(result), result);
      }
      const editRoute = url.pathname.match(/^\/api\/drafts\/([^/]+)\/(operations|candidates)$/);
      if (editRoute && request.method === 'POST') {
        const input = await body(request);
        const draftId = editRoute[1];
        const result = editRoute[2] === 'operations'
          ? await updateDraft(storeRoot, draftId, async current => {
            const frozen = await findPaperForDraft(papersRoot, draftId);
            if (!frozen.ok) return frozen;
            if (frozen.paper && !(current.operations ?? []).some(item => item.operationId === input.operationId)) {
              return { ok: false, error: { code: 'finalized_draft', message: '该草稿已确认成卷，请从成卷派生新草稿后修改。' } };
            }
            return applyDraftOperation(current, input, { root });
          })
          : await previewDraftCandidates(await readDraft(storeRoot, draftId), input, { root });
        return json(response, editorStatus(result), result);
      }
      if (url.pathname.startsWith('/api/drafts/') && request.method === 'GET') {
        const draft = await readDraft(storeRoot, url.pathname.slice('/api/drafts/'.length));
        const frozen = await findPaperForDraft(papersRoot, draft.draftId);
        if (!frozen.ok) return json(response, editorStatus(frozen), frozen);
        return json(response, 200, { ok: true, draft: frozen.paper && !draft.confirmedPaperId ? { ...draft, confirmedPaperId: frozen.paper.paperId } : draft });
      }
      if (url.pathname === '/api/papers' && request.method === 'GET') {
        const result = await listPapers(papersRoot);
        return json(response, editorStatus(result), result);
      }
      const paperRoute = url.pathname.match(/^\/api\/papers\/([^/]+)(?:\/(derive|feedback|outputs)(?:\/(student|teacher)(?:\/(file))?)?)?$/);
      if (paperRoute) {
        const result = await getPaper(papersRoot, paperRoute[1]);
        if (!result.ok) return json(response, editorStatus(result), result);
        const paper = result.paper;
        if (!paperRoute[2] && request.method === 'GET') {
          let feedback = null; const warnings = [];
          try { feedback = await readFeedback(feedbackRoot, paper.paperId); }
          catch (error) { warnings.push({ code: error.code, message: error.message }); }
          return json(response, 200, { ok: true, paper, outputs: await getPaperOutputs(paper, { outputRoot }), feedback, warnings });
        }
        if (paperRoute[2] === 'derive' && request.method === 'POST') {
          const derived = await derivePaperDraft(storeRoot, papersRoot, paper.paperId, await body(request));
          return json(response, editorStatus(derived), derived);
        }
        if (paperRoute[2] === 'feedback' && request.method === 'POST') {
          const feedback = await saveFeedback(feedbackRoot, paper, await body(request));
          return json(response, 200, { ok: true, feedback });
        }
        if (paperRoute[2] === 'outputs' && paperRoute[3] && !paperRoute[4] && request.method === 'POST') {
          const output = await generateOutput(paper, paperRoute[3], { root, outputRoot });
          return json(response, editorStatus(output), output);
        }
        if (paperRoute[2] === 'outputs' && paperRoute[3] && paperRoute[4] && request.method === 'GET') {
          const file = await readOutputFile(paper, paperRoute[3], { outputRoot });
          response.writeHead(200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store',
            'Content-Disposition': `attachment; filename="${file.filename}"` });
          return response.end(file.bytes);
        }
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
      json(response, error.status ?? editorStatus({ ok: false, error }),
        { ok: false, error: { code: error.code ?? 'server_error', message: error.message } });
    }
  });
}
