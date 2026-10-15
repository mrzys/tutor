import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashContent } from '../question-bank/reader.mjs';
import { readDraft, updateDraft } from './store.mjs';
import { sqliteStorage } from '../storage/sqlite.mjs';

const defaultRoot = fileURLToPath(new URL('../../', import.meta.url));
const validId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const validOperation = /^[A-Za-z0-9_-]{1,100}$/;
const clone = value => structuredClone(value);
const sum = values => values.reduce((total, value) => total + value, 0);
const queues = new Map();
const error = (code, message) => Object.assign(new Error(message), { code });
const failure = cause => ({ ok: false, error: { code: cause.code ?? 'read_error', message: cause.message } });
const revisionOf = draft => draft.revision ?? 0;

function deterministicId(namespace, ...values) {
  const value = hashContent({ namespace, values }).slice(0, 32);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function validateDraft(draft) {
  if (!draft || draft.schemaVersion !== 1 || !validId.test(draft.draftId) || !Array.isArray(draft.slots)
      || !draft.baseline?.requirements || !Number.isInteger(revisionOf(draft)) || revisionOf(draft) < 0) {
    throw error('invalid_request', '确认成卷需要有效的已保存草稿及修订版本。');
  }
}

export function studentProblem(slot) {
  const question = slot.question;
  if (!question?.student || typeof question.student.stem !== 'string' || !question.student.stem.trim()) return '缺少完整题面';
  if (slot.questionType === 'single_choice' && (!Array.isArray(question.student.options) || question.student.options.length < 2
      || question.student.options.some(option => !option.label || !option.text))) return '选择题选项不完整';
  if (slot.questionType === 'free_response' && (!Array.isArray(question.student.parts) || !question.student.parts.length
      || question.student.parts.some(part => !part.partId || !part.prompt))) return '解答题小问不完整';
  return null;
}

export function preparePaperConfirmation(draft) {
  validateDraft(draft);
  const scored = draft.baseline.requirements.scoringMode !== 'none';
  const missing = []; const teacherIssues = []; const unknown = []; const scoringIssues = [];
  const available = [];
  for (const slot of draft.slots) {
    const location = { slotId: slot.slotId, number: slot.number };
    const problem = studentProblem(slot);
    if (problem) {
      missing.push({ ...location, reason: problem });
      teacherIssues.push({ ...location, code: 'student_incomplete', message: '此题缺少完整学生题面，教师版保留占位。' });
      continue;
    }
    available.push(slot);
    const studentParts = Array.isArray(slot.question.student.parts) ? slot.question.student.parts : [];
    const parts = studentParts.length ? studentParts.map(part => part.partId) : ['main'];
    for (const [field, code, label] of [['answers', 'answer_missing', '答案'], ['solutions', 'solution_missing', '解析']]) {
      const entries = Array.isArray(slot.question.teacher?.[field]) ? slot.question.teacher[field] : [];
      const hasWholeQuestion = entries.some(entry => entry.partId === 'main' && typeof entry.text === 'string' && entry.text.trim());
      for (const partId of parts) {
        if (!hasWholeQuestion && !entries.some(entry => entry.partId === partId && typeof entry.text === 'string' && entry.text.trim())) {
          teacherIssues.push({ ...location, partId, code, message: `${partId === 'main' ? '本题' : `小问 ${partId}`}缺少${label}；不编造为原卷资料。` });
        }
      }
    }
    if (scored && (!Array.isArray(slot.question.teacher?.scoringSuggestions) || !slot.question.teacher.scoringSuggestions.some(entry => typeof entry.text === 'string' && entry.text.trim()))) {
      teacherIssues.push({ ...location, code: 'rubric_missing', message: '缺少此题建议评分资料；保留当前题分与小问赋分，不补写原卷评分细则。' });
    }
    const applicability = slot.applicability;
    if (applicability && applicability.status !== 'eligible') unknown.push({ ...location,
      status: applicability.status, reasons: clone(applicability.reasons ?? ['当前适配未证实']) });
    else if (!slot.selection?.selectedReason?.allowedSolutionPath && slot.selection?.selectedReason?.method !== 'controlled_benchmark_fixture') {
      unknown.push({ ...location, status: 'unknown', reasons: ['缺少本次选入所依据的完整允许解法记录。'] });
    }
    if (scored) scoringIssues.push({ ...location, message: slot.scoringStatus?.message
      ?? '当前题分及小问分值为本次组卷赋分；引用建议不代表已按当前分值核定的完整评分细则。' });
  }
  const stats = { plannedQuestions: draft.slots.length, selectedQuestions: available.length,
    plannedPoints: sum(draft.slots.map(slot => slot.points)), availablePoints: sum(available.map(slot => slot.points)),
    missingQuestions: missing.length, difficultyEstimate: null };
  const differences = clone(draft.differences ?? []);
  return { schemaVersion: 1, revision: revisionOf(draft), title: draft.title, stats, scoringMode: scored ? 'points' : 'none',
    student: { complete: !missing.length, questionCount: available.length, points: stats.availablePoints, missing },
    teacher: { complete: !teacherIssues.length, issues: teacherIssues }, unknown, scoringIssues, differences,
    difficulty: { target: draft.baseline.requirements.targetDifficulty, estimate: null, message: '目标难度仅是偏好，题目分档可参考 LLM 内容估计；整卷精确系数未经学生作答标定。' },
    requiresAcknowledgement: Boolean(missing.length || teacherIssues.length || unknown.length || scoringIssues.length || differences.length) };
}

async function writeOnce(directory, id, payload) {
  const kind = payload.paper ? 'papers' : 'drafts';
  const repository = sqliteStorage(directory, kind);
  if (repository) return repository.put(kind, id, payload, { immutable: true });
  const target = path.join(directory, `${id}.json`);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let file;
  try {
    await mkdir(directory, { recursive: true });
    file = await open(temporary, 'wx');
    await file.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await file.sync(); await file.close(); file = undefined;
    // A hard link publishes complete bytes atomically and fails rather than overwriting an existing snapshot.
    await link(temporary, target);
  } catch (cause) {
    throw error(cause.code === 'EEXIST' ? 'operation_conflict' : 'save_error', `保存不可变内容失败：${cause.message}`);
  } finally {
    await file?.close().catch(() => {}); await unlink(temporary).catch(() => {});
  }
}

export async function getPaper(papersRoot, paperId) {
  try {
    if (!validId.test(paperId)) throw error('not_found', '没有找到该成卷。');
    let saved;
    try {
      const repository = sqliteStorage(papersRoot, 'papers');
      saved = repository ? repository.get('papers', paperId) : JSON.parse(await readFile(path.join(papersRoot, `${paperId}.json`), 'utf8'));
      if (!saved) throw error('ENOENT', '成卷不存在。');
    }
    catch (cause) { throw error(cause.code === 'ENOENT' ? 'not_found' : cause.code === 'integrity_error' ? 'integrity_error' : 'read_error', '成卷内容无法读取，未重新选题或覆盖。'); }
    const paper = saved.paper;
    if (saved.schemaVersion !== 1 || paper?.schemaVersion !== 1 || paper.paperId !== paperId
        || saved.sha256 !== hashContent(paper) || paper.snapshotSha256 !== hashContent(paper.draft)
        || paper.sourceDraftId !== paper.draft.draftId || paper.sourceRevision !== revisionOf(paper.draft)) {
      throw error('integrity_error', '成卷校验不通过，未使用当前题库替换内容。');
    }
    return { ok: true, paper };
  } catch (cause) { return failure(cause); }
}

export async function listPapers(papersRoot) {
  try {
    let names;
    const repository = sqliteStorage(papersRoot, 'papers');
    try { names = repository ? repository.list('papers').map(id => `${id}.json`) : await readdir(papersRoot); }
    catch (cause) {
      if (cause.code === 'ENOENT') return { ok: true, papers: [], warnings: [] };
      throw error('read_error', '无法读取成卷目录。');
    }
    const papers = []; const warnings = (repository?.warnings('papers') ?? []).map(item => ({ ...item, paperId: item.id }));
    for (const filename of names.filter(name => name.endsWith('.json'))) {
      const paperId = filename.slice(0, -5); const result = await getPaper(papersRoot, paperId);
      if (result.ok) {
        const { title, createdAt, sourceDraftId, sourceRevision, summary } = result.paper;
        papers.push({ paperId, title, createdAt, sourceDraftId, sourceRevision, summary });
      } else warnings.push({ paperId, ...result.error });
    }
    papers.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.paperId.localeCompare(b.paperId));
    return { ok: true, papers, warnings };
  } catch (cause) { return failure(cause); }
}

export async function findPaperForDraft(papersRoot, draftId) {
  const listed = await listPapers(papersRoot);
  if (!listed.ok) return listed;
  // A damaged paper may be the finalized snapshot for this draft. Fail closed until it is recovered.
  if (listed.warnings.length) return failure(error('integrity_error', '存在无法核验的成卷，请恢复成卷文件后再修改草稿。'));
  const summary = listed.papers.find(paper => paper.sourceDraftId === draftId);
  return summary ? getPaper(papersRoot, summary.paperId) : { ok: true, paper: null };
}

export async function prepareDraftPreview(draft, { root = defaultRoot } = {}) {
  try {
    return { ok: true, draftId: draft.draftId, revision: revisionOf(draft), assets: await freezeAssets(draft, root) };
  } catch (cause) { return failure(cause); }
}

async function freezeAssets(draft, root) {
  const assets = []; const resolvedRoot = await realpath(root);
  for (const slot of draft.slots) {
    for (const asset of slot.question?.student?.assets ?? []) {
      if (typeof asset.path !== 'string' || !asset.path || asset.path.includes('\\') || asset.path.includes(':')
          || path.isAbsolute(asset.path) || asset.path.split('/').some(part => !part || part === '.' || part === '..')) {
        throw error('integrity_error', '素材路径无效，不能冻结成卷。');
      }
      let bytes;
      const frozen = draft.frozenAssets?.find(item => item.slotId === slot.slotId && item.questionId === slot.question.questionId
        && item.path === asset.path && item.sha256 === asset.sha256 && item.assetId === asset.assetId);
      try {
        if (frozen) bytes = Buffer.from(frozen.dataBase64, 'base64');
        else {
          const target = await realpath(path.join(resolvedRoot, asset.path));
          const relative = path.relative(resolvedRoot, target);
          if (relative.startsWith('..') || path.isAbsolute(relative)) throw error('integrity_error', '素材路径超出项目目录。');
          bytes = await readFile(target);
        }
      } catch (cause) {
        if (cause.code === 'integrity_error') throw cause;
        throw error('read_error', `第 ${slot.number} 题的必要素材无法读取。`);
      }
      if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw error('integrity_error', `第 ${slot.number} 题的必要素材与已确认版本不同。`);
      assets.push({ ...clone(asset), slotId: slot.slotId, questionId: slot.question.questionId, dataBase64: bytes.toString('base64') });
    }
  }
  return assets;
}

function verifyFrozenVersions(draft) {
  for (const slot of draft.slots.filter(item => item.question)) {
    const question = slot.question;
    for (const field of ['student', 'teacher']) {
      const prefix = field === 'student' ? 'content' : 'teacher';
      const computed = hashContent(question[field]);
      if (question[`${prefix}Sha256`] !== computed || question[`${prefix}Version`] !== `${prefix}-${computed.slice(0, 16)}`) {
        throw error('integrity_error', `第 ${slot.number} 题的${field === 'student' ? '题面' : '教师资料'}与已保存版本不一致。`);
      }
    }
  }
}

export async function confirmPaper(storeRoot, draftId, request, { papersRoot = path.join(path.dirname(storeRoot), 'papers'), root = defaultRoot, persistDraft } = {}) {
  try {
    if (!request || !validOperation.test(request.operationId) || !Number.isInteger(request.expectedRevision)
        || request.expectedRevision < 0 || typeof request.acknowledgeDifferences !== 'boolean') {
      throw error('invalid_request', '确认需要操作身份、当前草稿修订版本和差异确认值。');
    }
    const paperId = deterministicId('tutor-paper-v1', draftId, request.operationId);
    const payloadHash = hashContent(request);
    let output;
    const finalize = (current, paper) => current.confirmedPaperId === paper.paperId ? current : {
      ...clone(current), confirmedPaperId: paper.paperId, finalizedAt: paper.createdAt, updatedAt: new Date().toISOString(),
      revision: revisionOf(current) + 1,
      finalization: { paperId: paper.paperId, operationId: paper.confirmation.operationId, sourceRevision: paper.sourceRevision, confirmedAt: paper.createdAt },
    };
    const result = await updateDraft(storeRoot, draftId, async current => {
      const existing = await getPaper(papersRoot, paperId);
      if (existing.ok) {
        if (existing.paper.confirmation.payloadHash !== payloadHash) return failure(error('operation_conflict', '此确认操作身份已用于不同内容。'));
        output = { ok: true, paper: existing.paper, replayed: true };
        return { ok: true, draft: finalize(current, existing.paper) };
      }
      if (existing.error.code !== 'not_found') return existing;
      validateDraft(current);
      if (current.confirmedPaperId) return failure(error('finalized_draft', '此草稿已确认成卷；请从成卷派生新草稿。'));
      const previousPaper = await findPaperForDraft(papersRoot, draftId);
      if (!previousPaper.ok) return previousPaper;
      if (previousPaper.paper) return failure(error('finalized_draft', '此草稿已有不可变成卷；请重试原确认操作或从成卷派生新草稿。'));
      if (revisionOf(current) !== request.expectedRevision) return failure(error('revision_conflict', '草稿已更新，请查看新的确认摘要后再成卷。'));
      const summary = preparePaperConfirmation(current);
      if (summary.requiresAcknowledgement && !request.acknowledgeDifferences) return failure(error('confirmation_required', '请查看并确认当前差异、未知和缺项后再保存成卷。'));
      verifyFrozenVersions(current);
      const draft = clone(current);
      const paper = { schemaVersion: 1, paperId, title: draft.title, createdAt: new Date().toISOString(),
        sourceDraftId: draftId, sourceRevision: revisionOf(draft), snapshotSha256: hashContent(draft),
        confirmation: { operationId: request.operationId, payloadHash, request: clone(request), summary: clone(summary) },
        summary, draft, contentVersions: draft.slots.filter(slot => slot.question).map(slot => ({ slotId: slot.slotId,
          questionId: slot.question.questionId, contentVersion: slot.question.contentVersion, teacherVersion: slot.question.teacherVersion,
          contentSha256: slot.question.contentSha256, teacherSha256: slot.question.teacherSha256,
          assets: clone(slot.question.student.assets) })), assets: await freezeAssets(draft, root) };
      await writeOnce(papersRoot, paperId, { schemaVersion: 1, sha256: hashContent(paper), paper });
      output = { ok: true, paper };
      return { ok: true, draft: finalize(current, paper) };
    }, persistDraft ? { persist: persistDraft } : {});
    return result.ok ? output : result;
  } catch (cause) { return failure(cause); }
}

export function deriveDraftFromPaper(paper, { operationId } = {}) {
  try {
    if (!paper || !validId.test(paper.paperId) || paper.snapshotSha256 !== hashContent(paper.draft)) throw error('integrity_error', '成卷快照无效，不能派生草稿。');
    validateDraft(paper.draft);
    if (operationId !== undefined && !validOperation.test(operationId)) throw error('invalid_request', '派生操作身份无效。');
    const draft = clone(paper.draft);
    draft.draftId = operationId ? deterministicId('tutor-derived-draft-v1', paper.paperId, operationId) : randomUUID();
    draft.revision = 0; draft.operations = [];
    delete draft.confirmedPaperId; delete draft.finalizedAt; delete draft.finalization;
    draft.createdAt = new Date().toISOString(); draft.updatedAt = draft.createdAt;
    draft.derivedFromPaperId = paper.paperId;
    draft.derivation = { paperId: paper.paperId, sourceDraftId: paper.sourceDraftId, sourceRevision: paper.sourceRevision,
      snapshotSha256: paper.snapshotSha256, ...(operationId ? { operationId } : {}) };
    draft.frozenAssets = clone(paper.assets ?? []);
    return { ok: true, draft };
  } catch (cause) { return failure(cause); }
}

async function serialized(key, task) {
  const previous = queues.get(key) ?? Promise.resolve();
  const operation = previous.then(task); const tail = operation.catch(() => {});
  queues.set(key, tail);
  try { return await operation; }
  finally { if (queues.get(key) === tail) queues.delete(key); }
}

export async function derivePaperDraft(storeRoot, papersRoot, paperId, request) {
  try {
    if (!request || !validOperation.test(request.operationId)) throw error('invalid_request', '派生需要稳定的操作身份。');
    const draftId = deterministicId('tutor-derived-draft-v1', paperId, request.operationId);
    return await serialized(path.resolve(storeRoot, `${draftId}.json`), async () => {
      const source = await getPaper(papersRoot, paperId); if (!source.ok) return source;
      try {
        const saved = await readDraft(storeRoot, draftId);
        if (saved.derivation?.paperId !== paperId || saved.derivation?.operationId !== request.operationId
            || saved.derivation?.payloadHash !== hashContent(request)) return failure(error('operation_conflict', '派生操作身份已用于不同内容。'));
        return { ok: true, draft: saved, replayed: true };
      } catch (cause) { if (cause.code !== 'not_found') throw cause; }
      const result = deriveDraftFromPaper(source.paper, request); if (!result.ok) return result;
      result.draft.derivation.payloadHash = hashContent(request);
      await writeOnce(storeRoot, result.draft.draftId, { schemaVersion: 1, sha256: hashContent(result.draft), draft: result.draft });
      return result;
    });
  } catch (cause) { return failure(cause); }
}
