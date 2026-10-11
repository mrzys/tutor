import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAssemblyConfig, previewBlueprint, recheckBlueprint, createDraft } from './assembly/engine.mjs';
import { listQuestions } from './question-bank/reader.mjs';
import { saveDraft, readDraft, listDrafts, updateDraft } from './assembly/store.mjs';
import { applyDraftOperation, previewDraftCandidates, previewDraftCandidateSupply } from './assembly/editor.mjs';
import { confirmPaper, preparePaperConfirmation, getPaper, listPapers, derivePaperDraft, findPaperForDraft } from './assembly/papers.mjs';
import { readFeedback, saveFeedback } from './assembly/feedback.mjs';
import { getPaperOutputs, generateOutput, readOutputFile } from './output/manager.mjs';
import { createIntakeService } from './intake/service.mjs';
import { planBlueprint } from './assembly/planner.mjs';
import { createBlueprintGateway } from './llm/blueprint-gateway.mjs';
import { createSelectionGateway } from './llm/selection-gateway.mjs';
import { createAssistantGateway } from './llm/assistant-gateway.mjs';
import { proposeAssemblyAdjustment } from './assembly/assistant.mjs';
import { createQuestionImportService } from './question-bank/imports.mjs';
import { createManualQuestionDraft, listQuestionBankCatalog } from './question-bank/catalog.mjs';

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

export function createAppServer({ root = repoRoot, storeRoot = path.join(root, '.tutor', 'drafts'),
  intakeService, intakeStorage, intakeGateway, blueprintGateway = createBlueprintGateway(),
  selectionGateway = createSelectionGateway(), assistantGateway = createAssistantGateway(),
  questionImportService, questionImportGateway } = {}) {
  const intake = intakeService ?? createIntakeService({ root, storage: intakeStorage, gateway: intakeGateway });
  const questionImports = questionImportService ?? createQuestionImportService({ root,
    storeRoot: path.join(path.dirname(storeRoot), 'question-imports'), gateway: questionImportGateway });
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
        const [config, bank, saved] = await Promise.all([
          getAssemblyConfig({ root }), listQuestions({ root }),
          listDrafts(storeRoot),
        ]);
        if (!config.ok) return json(response, 500, config);
        if (!bank.ok) return json(response, 500, bank);
        const context = config.config.courseContext;
        config.config.sources = config.config.sources.map(source => ({ ...source,
          label: source.sourceId === 'set-teacher' ? '集合汇编 · 解析版' : '集合汇编 · 原卷版（已分离答案）',
        }));
        return json(response, 200, { ok: true, config: { ...config.config, foundation: context.foundation,
          context, supply: bank.totals, drafts: saved.drafts, draftWarnings: saved.warnings,
          intake: intake.publicStatus(), blueprintPlanner: blueprintGateway.publicStatus(),
          candidateSelector: selectionGateway.publicStatus(), assemblyAssistant: assistantGateway.publicStatus?.() ?? { configured: false },
          questionImport: questionImports.publicStatus() } });
      }
      if (url.pathname === '/api/question-imports' && request.method === 'GET') {
        return json(response, 200, await questionImports.list());
      }
      if (url.pathname === '/api/question-imports' && request.method === 'POST') {
        const controller = new AbortController();
        const cancel = () => { if (!response.writableEnded) controller.abort(); };
        response.once('close', cancel);
        try {
          const result = await questionImports.create(request, { signal: controller.signal });
          if (response.destroyed) return;
          const status = result.ok ? 201 : ['not_configured', 'model_error', 'timeout'].includes(result.error.code) ? 503
            : result.error.code === 'cancelled' ? 499 : 400;
          return json(response, status, result);
        } finally { response.off('close', cancel); }
      }
      const questionImportRoute = url.pathname.match(/^\/api\/question-imports\/([^/]+)$/);
      if (questionImportRoute && request.method === 'GET') {
        const result = await questionImports.get(questionImportRoute[1]);
        return json(response, result.ok ? 200 : result.error.code === 'not_found' ? 404 : 500, result);
      }
      if (url.pathname === '/api/question-bank' && request.method === 'GET') {
        const filters = Object.fromEntries(['sectionId', 'query', 'questionType', 'difficulty', 'ability', 'literacy', 'page', 'pageSize']
          .filter(key => url.searchParams.has(key)).map(key => [key, url.searchParams.get(key)]));
        const result = await listQuestionBankCatalog({ root, ...filters });
        return json(response, result.ok ? 200 : result.error.code === 'invalid_request' ? 400 : 500, result);
      }
      if (url.pathname === '/api/question-bank/manual-draft' && request.method === 'POST') {
        const result = await createManualQuestionDraft(await body(request), { root });
        if (!result.ok) return json(response, result.error.code === 'version_conflict' ? 409 : result.error.code === 'invalid_request' ? 400 : 500, result);
        await saveDraft(storeRoot, result.draft);
        return json(response, 201, result);
      }
      if (url.pathname === '/api/intake' && request.method === 'POST') {
        const input = await body(request);
        const controller = new AbortController();
        const cancel = () => { if (!response.writableEnded) controller.abort(); };
        response.once('close', cancel);
        try {
          const result = await intake.handle(input, { signal: controller.signal });
          if (response.destroyed) return;
          return json(response, result.ok ? 200 : result.error.code === 'revision_conflict'
            || result.error.code === 'operation_conflict' ? 409
            : result.error.code === 'not_found' ? 404
            : ['not_configured', 'model_error', 'timeout'].includes(result.error.code) ? 503 : 400, result);
        } finally { response.off('close', cancel); }
      }
      const intakeRoute = url.pathname.match(/^\/api\/intake\/([^/]+)$/);
      if (intakeRoute && request.method === 'GET') {
        const result = await intake.get(intakeRoute[1]);
        return json(response, result.ok ? 200 : result.error.code === 'not_found' ? 404 : 400, result);
      }
      if (url.pathname === '/api/assistant/propose' && request.method === 'POST') {
        const input = await body(request);
        if (input?.stage === 'draft' && typeof input.draftId === 'string') {
          const frozen = await findPaperForDraft(papersRoot, input.draftId);
          if (!frozen.ok) return json(response, editorStatus(frozen), frozen);
          if (frozen.paper) return json(response, 409, { ok: false, error: { code: 'finalized_draft', message: '请从成卷派生新草稿后再调整。' } });
        }
        const controller = new AbortController();
        const cancel = () => { if (!response.writableEnded) controller.abort(); };
        response.once('close', cancel);
        try {
          const result = await proposeAssemblyAdjustment(input, { root, storeRoot, gateway: assistantGateway, signal: controller.signal });
          if (response.destroyed) return;
          const status = result.ok ? 200 : ['revision_conflict', 'finalized_draft'].includes(result.error.code) ? 409
            : result.error.code === 'not_found' ? 404 : result.error.code === 'cancelled' ? 499
            : ['invalid_request', 'invalid_plan', 'invalid_model_output'].includes(result.error.code) ? 400 : 503;
          return json(response, status, result);
        } finally { response.off('close', cancel); }
      }
      if (url.pathname === '/api/blueprint' && request.method === 'POST') {
        const input = await body(request);
        const result = await previewBlueprint(input.requirements, { root });
        return json(response, result.ok ? 200 : result.error.code === 'invalid_plan' ? 400 : 500, result);
      }
      if (url.pathname === '/api/blueprint/plan' && request.method === 'POST') {
        const input = await body(request);
        if (!input || !['fixed', 'suggested'].includes(input.countPolicy ?? 'fixed')) {
          return json(response, 400, { ok: false, error: { code: 'invalid_plan', message: '请选择保留题型数量或允许 AI 建议配比。' } });
        }
        const controller = new AbortController();
        const cancel = () => { if (!response.writableEnded) controller.abort(); };
        response.once('close', cancel);
        try {
          const result = await planBlueprint(input.requirements, { root, gateway: blueprintGateway,
            signal: controller.signal, countPolicy: input.countPolicy ?? 'fixed' });
          if (response.destroyed) return;
          return json(response, result.ok ? 200 : ['invalid_plan', 'invalid_model_output'].includes(result.error.code) ? 400
            : result.error.code === 'cancelled' ? 499 : 503, result);
        } finally { response.off('close', cancel); }
      }
      if (url.pathname === '/api/blueprint/recheck' && request.method === 'POST') {
        const input = await body(request);
        const result = await recheckBlueprint(input.blueprint, { root });
        return json(response, result.ok ? 200 : result.error.code === 'invalid_plan' ? 400 : 500, result);
      }
      if (url.pathname === '/api/drafts' && request.method === 'POST') {
        const input = await body(request);
        const selectionMode = input?.selectionMode ?? (input?.blueprint?.generation?.mode === 'llm' ? 'llm' : 'rule');
        if (!['llm', 'rule'].includes(selectionMode)) {
          return json(response, 400, { ok: false, error: { code: 'invalid_request', message: '选题方式只能是 AI 比较候选或规则选题。' } });
        }
        const controller = new AbortController();
        const cancel = () => { if (!response.writableEnded) controller.abort(); };
        response.once('close', cancel);
        try {
          const result = await createDraft(input?.blueprint, { root, selectionMode, gateway: selectionGateway, signal: controller.signal });
          if (controller.signal.aborted || response.destroyed) return;
          if (!result.ok) return json(response, ['invalid_plan', 'invalid_model_output'].includes(result.error.code) ? 400
            : result.error.code === 'cancelled' ? 499
            : ['not_configured', 'model_error', 'timeout', 'selection_resource_limit'].includes(result.error.code) ? 503 : 500, result);
          await saveDraft(storeRoot, result.draft);
          return json(response, 201, result);
        } finally { response.off('close', cancel); }
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
      const editRoute = url.pathname.match(/^\/api\/drafts\/([^/]+)\/(operations|candidates|candidate-supply)$/);
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
          : await (editRoute[2] === 'candidate-supply' ? previewDraftCandidateSupply : previewDraftCandidates)(await readDraft(storeRoot, draftId), input, { root });
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
