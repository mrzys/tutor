import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createQuestionImportGateway } from '../llm/question-import-gateway.mjs';
import { sqliteStorage } from '../storage/sqlite.mjs';
import { questionBankStorage } from '../storage/registry.mjs';
import { publishQuestionImport } from './publication.mjs';

const exec = promisify(execFile);
const defaultRoot = fileURLToPath(new URL('../../', import.meta.url));
const allowed = new Map([
  ['.txt', ['text/plain']], ['.md', ['text/markdown', 'text/plain']],
  ['.pdf', ['application/pdf']],
  ['.docx', ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/octet-stream']],
]);
const maxUploadBytes = 15 * 1024 * 1024;
const maxExtractedCharacters = 240000;
const idPattern = /^[a-f0-9-]{36}$/;

const importError = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function readLimited(request, limit = Math.ceil(maxUploadBytes * 4 / 3) + 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw importError('file_too_large', '上传文件不能超过 15 MB。', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseDisposition(value = '') {
  const name = /(?:^|;)\s*name="([^"]+)"/i.exec(value)?.[1];
  const filename = /(?:^|;)\s*filename="([^"]*)"/i.exec(value)?.[1];
  return { name, filename };
}

function parseMultipart(bytes, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)?.slice(1).find(Boolean);
  if (!boundary || boundary.length > 200) throw importError('invalid_upload', '上传表单缺少有效边界。');
  const marker = Buffer.from(`--${boundary}`);
  const fields = {}; let file = null; let offset = 0;
  while (true) {
    const start = bytes.indexOf(marker, offset);
    if (start < 0) break;
    const next = bytes.indexOf(marker, start + marker.length);
    if (next < 0) break;
    let part = bytes.subarray(start + marker.length, next);
    if (part.subarray(0, 2).toString() === '\r\n') part = part.subarray(2);
    if (part.subarray(-2).toString() === '\r\n') part = part.subarray(0, -2);
    const separator = part.indexOf(Buffer.from('\r\n\r\n'));
    if (separator > 0) {
      const headers = Object.fromEntries(part.subarray(0, separator).toString('utf8').split('\r\n').map(line => {
        const split = line.indexOf(':'); return [line.slice(0, split).trim().toLowerCase(), line.slice(split + 1).trim()];
      }));
      const disposition = parseDisposition(headers['content-disposition']);
      const value = part.subarray(separator + 4);
      if (disposition.filename !== undefined) {
        if (file) throw importError('invalid_upload', '每次只能上传一个试卷文件。');
        file = { filename: disposition.filename, mimeType: headers['content-type'] ?? 'application/octet-stream', bytes: value };
      } else if (disposition.name) fields[disposition.name] = value.toString('utf8');
    }
    offset = next;
  }
  if (!file) throw importError('invalid_upload', '请选择要解析的试卷文件。');
  return { file, fields };
}

export async function parseQuestionImportUpload(request) {
  const contentType = request.headers['content-type'] ?? '';
  const bytes = await readLimited(request);
  let upload;
  if (contentType.startsWith('multipart/form-data')) upload = parseMultipart(bytes, contentType);
  else if (contentType.startsWith('application/json')) {
    let input;
    try { input = JSON.parse(bytes.toString('utf8')); } catch { throw importError('invalid_upload', '上传请求不是有效 JSON。'); }
    if (typeof input?.contentBase64 === 'string'
        && (input.contentBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.contentBase64))) {
      throw importError('invalid_upload', 'contentBase64 不是有效的 Base64。');
    }
    const fileBytes = typeof input?.contentBase64 === 'string' ? Buffer.from(input.contentBase64, 'base64')
      : typeof input?.text === 'string' ? Buffer.from(input.text, 'utf8') : null;
    if (!fileBytes) throw importError('invalid_upload', 'JSON 上传需要 contentBase64 或 text。');
    upload = { file: { filename: input.filename, mimeType: input.mimeType ?? 'application/octet-stream', bytes: fileBytes }, fields: {} };
  } else throw importError('invalid_upload', '请使用 multipart/form-data 上传文件。', 415);
  const filename = path.basename(String(upload.file.filename ?? '')).replace(/[\u0000-\u001f]/g, '').trim();
  const extension = path.extname(filename).toLowerCase();
  if (!filename || !allowed.has(extension)) throw importError('unsupported_file', '仅支持 TXT、Markdown、PDF 和 DOCX 试卷。', 415);
  if (!upload.file.bytes.length) throw importError('empty_file', '上传文件为空。');
  if (upload.file.bytes.length > maxUploadBytes) throw importError('file_too_large', '上传文件不能超过 15 MB。', 413);
  const acceptedMimes = allowed.get(extension);
  if (upload.file.mimeType && upload.file.mimeType !== 'application/octet-stream' && !acceptedMimes.includes(upload.file.mimeType)) {
    throw importError('file_type_mismatch', '文件扩展名与内容类型不一致。', 415);
  }
  if (extension === '.pdf' && !upload.file.bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw importError('file_type_mismatch', '文件内容不是有效 PDF。', 415);
  }
  if (extension === '.docx' && !upload.file.bytes.subarray(0, 2).equals(Buffer.from('PK'))) {
    throw importError('file_type_mismatch', '文件内容不是有效 DOCX。', 415);
  }
  return { filename, extension, mimeType: upload.file.mimeType || acceptedMimes[0], bytes: upload.file.bytes };
}

async function findPython() {
  if (process.env.TUTOR_PYTHON) return process.env.TUTOR_PYTHON;
  const bundled = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python');
  try { await access(bundled); return bundled; } catch { return process.platform === 'win32' ? 'python' : 'python3'; }
}

function retainSourceReferences(page) {
  const { text } = page;
  const visuals = [...(page.visuals ?? [])], tables = [...(page.tables ?? [])];
  if (!visuals.length && /!\[[^\]]*\]\([^)]*\)|<img\b|<svg\b|\b(?:asset|oss|image):\/\/|SOURCE_VISUAL_UNRESOLVED|如图|下图|图中|图示|右图|左图|附图/i.test(text)) {
    visuals.push({ id: `text-p${page.page}-visual-1`, kind: 'text_visual_reference', page: page.page, requiresReview: true, pixelsProvidedToModel: false });
  }
  if (!tables.length && /<table\b|\\begin\{(?:tabular|longtable)\}|^[^\r\n]*\|[^\r\n]*\r?\n[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$|下表|上表(?!示|达|现|征|述)|表中|表格|如下表/m.test(text)) {
    tables.push({ id: `text-p${page.page}-table-1`, page: page.page, requiresReview: true, reason: 'Table source-to-question alignment requires review' });
  }
  return { ...page, visuals, tables };
}

export async function extractQuestionDocument(filename, { root = defaultRoot } = {}) {
  const extension = path.extname(filename).toLowerCase();
  let pages;
  if (extension === '.txt' || extension === '.md') {
    const bytes = await readFile(filename);
    let text = bytes.toString('utf8').replace(/^\uFEFF/, '');
    if (text.includes('\uFFFD')) throw importError('invalid_text_encoding', '文本文件必须使用 UTF-8 编码。', 422);
    pages = [{ page: 1, text }];
  } else {
    let output;
    try {
      output = await exec(await findPython(), [path.join(root, 'scripts', 'extract-paper-text.py'), filename], {
        windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8',
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      });
    } catch (cause) {
      let detail = '';
      try { detail = JSON.parse(cause.stdout || '{}').error ?? ''; } catch {}
      throw importError('extraction_failed', detail ? `无法提取试卷文本：${detail}` : '无法提取试卷文本。', 422);
    }
    try { pages = JSON.parse(output.stdout).pages; }
    catch { throw importError('extraction_failed', '文档提取器返回了无效结果。', 422); }
  }
  if (!Array.isArray(pages) || pages.some(item => !Number.isInteger(item?.page) || typeof item.text !== 'string')) {
    throw importError('extraction_failed', '文档提取结果缺少页码或文本。', 422);
  }
  pages = pages.map(item => retainSourceReferences({ ...item, text: item.text.replace(/\u0000/g, '') }));
  const totalCharacters = pages.reduce((sum, item) => sum + item.text.length, 0);
  if (!pages.some(item => item.text.trim())) throw importError('no_extractable_text', '文件没有可提取文本；扫描版 PDF 请先完成 OCR。', 422);
  if (totalCharacters > maxExtractedCharacters) throw importError('document_too_long', '提取文本超过 24 万字，请拆分试卷后上传。', 413);
  return { pages, totalCharacters, pageCount: pages.length };
}

function normalizedName(value) { return value.normalize('NFKC').replace(/[\s·・,，、()（）]/g, '').toLowerCase(); }

async function loadKnowledgeCatalog(root) {
  try {
    const source = JSON.parse(await readFile(path.join(root, 'data', 'curriculum', 'knowledge-points.json'), 'utf8'));
    const byName = new Map();
    for (const item of source.knowledgePoints ?? []) {
      const key = normalizedName(item.name);
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(item);
    }
    return { catalogVersion: source.catalogVersion ?? null, byName };
  } catch { return { catalogVersion: null, byName: new Map() }; }
}

async function loadAssemblyCatalog(root) {
  try {
    const repository = questionBankStorage(root);
    const source = repository?.getQuestionBankConfig('task_catalog') ?? JSON.parse(await readFile(path.join(root, 'data', 'assembly', 'task-catalog.json'), 'utf8'));
    const chapters = new Map((source.chapters ?? []).map(item => [item.id, item]));
    if (repository) for (const section of repository.getQuestionBankTextbooks().flatMap(book => book.chapters.flatMap(chapter => chapter.sections))) {
      chapters.set(section.id, { id: section.id, label: section.label });
    }
    const tasks = new Map((source.tasks ?? []).map(item => [item.id, item]));
    return { catalogId: source.catalogId ?? null, chapters, tasks };
  } catch { return { catalogId: null, chapters: new Map(), tasks: new Map() }; }
}

function resolveStableIds(ids, entries, reviewIssues, type, questionType) {
  return ids.map(id => {
    const entry = entries.get(id);
    const compatible = !entry?.questionType || entry.questionType === questionType;
    if (!entry || !compatible) reviewIssues.push({ code: `${type}_unresolved`, message: !entry
      ? `${type === 'chapter' ? '章节' : '任务'} ID“${id}”不在当前目录。`
      : `任务“${id}”的题型与本题不一致。` });
    return { id, label: entry?.label ?? null, matchStatus: entry && compatible ? 'suggested' : 'unresolved' };
  });
}

function enrichQuestion(question, index, catalog, assemblyCatalog, extraction) {
  const reviewIssues = [{ code: 'ai_extraction_unverified', message: '题干、拆题边界、公式和维度均需对照原文件复核。' }];
  const knownParts = new Set(['main', ...question.student.parts.map(item => item.partId)]);
  if (!question.pages.length) reviewIssues.push({ code: 'source_page_missing', message: '缺少来源页码。' });
  const sourcePages = (extraction?.pages ?? []).filter(page => question.pages.includes(page.page));
  if (sourcePages.length !== question.pages.length) reviewIssues.push({ code: 'source_page_missing', message: '题目来源页码未对应提取结果，请核对原文件。' });
  const visuals = sourcePages.flatMap(page => page.visuals ?? []);
  const tables = sourcePages.flatMap(page => page.tables ?? []);
  // Page-level attribution is intentionally conservative. DOCX page 1 is the whole logical
  // document, and a text-only model cannot certify that an omitted picture belongs elsewhere.
  if (visuals.length) reviewIssues.push({ code: 'source_visual_unresolved', message: `来源页含 ${visuals.length} 个图片、绘图或未解析对象，当前仅向模型提供文本与占位，尚未核验视觉内容，不能发布为完整题。` });
  if (tables.length) reviewIssues.push({ code: 'source_table_unresolved', message: `来源页含 ${tables.length} 个表格或表格引用，需逐行逐格核对其在本题中的归属与完整性，尚不能直接发布。` });
  if (!question.teacher.answers.length) reviewIssues.push({ code: 'answer_missing', message: '原文件中未识别到答案。' });
  if (!question.teacher.solutions.length) reviewIssues.push({ code: 'solution_missing', message: '原文件中未识别到解析。' });
  if (question.questionType === 'single_choice' && question.student.options.length < 2) reviewIssues.push({ code: 'options_incomplete', message: '单选题选项不足。' });
  if (question.questionType !== 'single_choice' && question.student.options.length) reviewIssues.push({ code: 'unexpected_options', message: '非选择题包含选项，请核对题型。' });
  if (question.questionType === 'free_response' && !question.student.parts.length) reviewIssues.push({ code: 'parts_missing', message: '解答题未拆出小问，请核对是否为单问题。' });
  for (const item of [...question.teacher.answers, ...question.teacher.solutions]) {
    if (!knownParts.has(item.partId)) reviewIssues.push({ code: 'part_alignment_error', message: `答案或解析引用未知小问 ${item.partId}。` });
    if (item.sourceBasis !== 'explicit') reviewIssues.push({ code: 'teacher_content_not_explicit', message: `${item.partId} 的答案或解析不是原文件明确内容。` });
  }
  const knowledgePoints = question.dimensions.knowledgePoints.map(item => {
    const matches = catalog.byName.get(normalizedName(item.name)) ?? [];
    if (matches.length !== 1) {
      reviewIssues.push({ code: 'knowledge_point_unresolved', message: `知识点“${item.name}”未唯一匹配本地目录。` });
      return { ...item, suggestedUid: null, matchStatus: 'unresolved' };
    }
    return { ...item, suggestedUid: matches[0].uid, matchStatus: 'suggested' };
  });
  const chapterCandidates = resolveStableIds(question.dimensions.chapterCandidates, assemblyCatalog.chapters,
    reviewIssues, 'chapter', question.questionType);
  const taskCandidates = resolveStableIds(question.dimensions.taskCandidates, assemblyCatalog.tasks,
    reviewIssues, 'task', question.questionType);
  return {
    stagingQuestionId: `staged-${String(index + 1).padStart(3, '0')}`,
    status: 'pending_review',
    ...question,
    dimensions: { ...question.dimensions, chapterCandidates, taskCandidates, knowledgePoints,
      catalogVersion: catalog.catalogVersion, taskCatalogId: assemblyCatalog.catalogId },
    reviewIssues: [...new Map(reviewIssues.map(item => [`${item.code}:${item.message}`, item])).values()],
  };
}

async function atomicJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
  try { await rename(temporary, filename); } catch (cause) { await rm(temporary, { force: true }); throw cause; }
}

function modelContext(upload, extraction, assemblyCatalog) {
  return {
    task: 'parse_question_paper_for_staging',
    source: { filename: upload.filename, mimeType: upload.mimeType, pageCount: extraction.pageCount,
      visuals: extraction.pages.flatMap(page => page.visuals ?? []),
      tables: extraction.pages.flatMap(page => page.tables ?? []),
      visualInput: 'text_and_placeholders_only; picture pixels are not provided' },
    trustedCatalog: {
      catalogId: assemblyCatalog.catalogId,
      chapters: [...assemblyCatalog.chapters.values()].map(({ id, label }) => ({ id, label })),
      tasks: [...assemblyCatalog.tasks.values()].map(({ id, label, questionType, sectionIds }) => ({ id, label, questionType, sectionIds })),
    },
    documentText: extraction.pages.map(item => `[PAGE ${item.page}]\n${item.text}`).join('\n\n'),
  };
}

export function createQuestionImportService({ root = defaultRoot,
  storeRoot = path.join(root, '.tutor', 'question-imports'), gateway = createQuestionImportGateway(), extractor = extractQuestionDocument } = {}) {
  const recordsRoot = path.join(storeRoot, 'records');
  const filesRoot = path.join(storeRoot, 'files');
  const repository = sqliteStorage(storeRoot, 'question-imports');
  return {
    publicStatus() { return { ...gateway.publicStatus(), acceptedExtensions: [...allowed.keys()], maxUploadBytes, publication: 'explicit_admin_review' }; },
    publish(importId, input) { return publishQuestionImport(repository, importId, input); },
    async create(request, { signal } = {}) {
      const upload = await parseQuestionImportUpload(request);
      const importId = randomUUID();
      const sourcePath = path.join(filesRoot, `${importId}${upload.extension}`);
      await mkdir(filesRoot, { recursive: true });
      await writeFile(sourcePath, upload.bytes, { flag: 'wx' });
      try {
        const extraction = await extractor(sourcePath, { root });
        const assemblyCatalog = await loadAssemblyCatalog(root);
        const result = await gateway.propose(modelContext(upload, extraction, assemblyCatalog), { signal });
        if (!result.ok) {
          await rm(sourcePath, { force: true }).catch(() => {});
          return result;
        }
        const catalog = await loadKnowledgeCatalog(root);
        const createdAt = new Date().toISOString();
        const record = {
          schemaVersion: 1, importId, status: 'pending_review', createdAt, updatedAt: createdAt,
          source: { filename: upload.filename, mimeType: upload.mimeType, extension: upload.extension,
            bytes: upload.bytes.length, sha256: digest(upload.bytes), pageCount: extraction.pageCount,
            extractedCharacters: extraction.totalCharacters,
            visuals: extraction.pages.flatMap(page => page.visuals ?? []),
            tables: extraction.pages.flatMap(page => page.tables ?? []),
            pagination: upload.extension === '.pdf' ? 'physical_pages' : upload.extension === '.docx' ? 'logical_document' : 'text_document' },
          title: result.proposal.title,
          questions: result.proposal.questions.map((item, index) => enrichQuestion(item, index, catalog, assemblyCatalog, extraction)),
          reviewSummary: { publicationBlocked: true, reason: 'AI 解析结果仅进入暂存区；逐题核对来源、内容、答案和维度后方可进入正式题库。',
            limitations: upload.extension === '.docx' ? ['DOCX 不保留物理分页，暂存页码 1 表示整个逻辑文档。', '复杂 Word 公式、图片与版式需对照原文件人工核查。']
              : upload.extension === '.pdf' ? ['扫描版 PDF 需先完成 OCR；公式、图片与阅读顺序需对照原文件人工核查。']
              : ['纯文本不包含原试卷版式与图片，需人工核查题目边界。'] },
          llmRun: result.run,
        };
        if (repository) {
          repository.putQuestionImport(record, { bytes: upload.bytes, sha256: record.source.sha256,
            filename: upload.filename, mimeType: upload.mimeType });
          await rm(sourcePath, { force: true });
        } else await atomicJson(path.join(recordsRoot, `${importId}.json`), record);
        return { ok: true, import: record };
      } catch (cause) {
        await rm(sourcePath, { force: true }).catch(() => {});
        throw cause;
      }
    },
    async get(importId) {
      if (!idPattern.test(importId)) return { ok: false, error: { code: 'not_found', message: '未找到该试卷导入记录。' } };
      if (repository) {
        try {
          const record = repository.getQuestionImport(importId);
          return record ? { ok: true, import: { ...record, publicationSummary: repository.getQuestionImportPublicationSummary(importId, record) } }
            : { ok: false, error: { code: 'not_found', message: '未找到该试卷导入记录。' } };
        } catch { return { ok: false, error: { code: 'read_error', message: '暂存记录无法读取。' } }; }
      }
      try { return { ok: true, import: JSON.parse(await readFile(path.join(recordsRoot, `${importId}.json`), 'utf8')) }; }
      catch (cause) {
        if (cause.code === 'ENOENT') return { ok: false, error: { code: 'not_found', message: '未找到该试卷导入记录。' } };
        return { ok: false, error: { code: 'read_error', message: '暂存记录无法读取。' } };
      }
    },
    async list() {
      if (repository) {
        try {
          return { ok: true, imports: repository.listQuestionImports().map(item => ({
            importId: item.importId, status: item.status, title: item.title, createdAt: item.createdAt,
            source: item.source, questionCount: item.questions?.length ?? 0, publicationBlocked: true,
            publicationSummary: repository.getQuestionImportPublicationSummary(item.importId, item),
          })) };
        } catch { return { ok: false, error: { code: 'read_error', message: '暂存记录无法读取。' } }; }
      }
      let names;
      try { names = await readdir(recordsRoot); } catch (cause) { if (cause.code === 'ENOENT') return { ok: true, imports: [] }; throw cause; }
      const imports = [];
      for (const name of names.filter(item => item.endsWith('.json')).sort().reverse()) {
        try {
          const item = JSON.parse(await readFile(path.join(recordsRoot, name), 'utf8'));
          imports.push({ importId: item.importId, status: item.status, title: item.title, createdAt: item.createdAt,
            source: item.source, questionCount: item.questions?.length ?? 0, publicationBlocked: true });
        } catch {}
      }
      return { ok: true, imports };
    },
  };
}
