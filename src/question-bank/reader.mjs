import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, hashContent } from './integrity.mjs';
import { questionBankStorage } from '../storage/registry.mjs';

export { canonicalJson, hashContent } from './integrity.mjs';

const defaultRoot = fileURLToPath(new URL('../../', import.meta.url));
const idPattern = /^(?:tutor-set-\d{3}|tutor-import-[a-f0-9]{24})$/;
const shaPattern = /^[a-f0-9]{64}$/;

class BankError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const invalid = message => { throw new BankError('integrity_error', message); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireArray = (value, name) => { if (!Array.isArray(value)) invalid(`${name} must be an array.`); };
const requireText = (value, name) => { if (typeof value !== 'string' || !value.trim()) invalid(`${name} must be nonempty text.`); };
const requireSha = (value, name) => { if (typeof value !== 'string' || !shaPattern.test(value)) invalid(`${name} must be a lowercase SHA-256 hash.`); };

function safePath(base, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || path.isAbsolute(relative)
      || relative.split('/').some(part => part === '..' || part === '.' || !part)
      || relative.includes(':') || relative.includes('\0')) {
    invalid('Data paths must be safe relative paths using forward slashes.');
  }
  const resolved = path.resolve(base, relative);
  const tail = path.relative(base, resolved);
  if (tail.startsWith('..') || path.isAbsolute(tail)) invalid('Data path escapes its allowed directory.');
  return resolved;
}

async function readSafe(base, relative) {
  const target = safePath(base, relative);
  const [realBase, realTarget] = await Promise.all([realpath(base), realpath(target)]);
  const tail = path.relative(realBase, realTarget);
  if (tail.startsWith('..') || path.isAbsolute(tail)) invalid('Data symlink escapes its allowed directory.');
  return readFile(realTarget);
}

async function readJson(base, relative) {
  return JSON.parse((await readSafe(base, relative)).toString('utf8'));
}

function failure(error) {
  return { ok: false, error: {
    code: error instanceof BankError ? error.code : 'read_error',
    message: error instanceof BankError ? error.message : `Question data could not be read: ${error.message}`,
  } };
}

async function readLedger(root) {
  const bankRoot = path.join(path.resolve(root), 'data', 'question-bank');
  const repository = questionBankStorage(root);
  const ledger = repository ? repository.getQuestionBankLedger() : await readJson(bankRoot, 'ledger.json');
  if (repository && !ledger) invalid('SQLite question-bank ledger is missing.');
  if (!isObject(ledger) || ledger.schemaVersion !== 1) invalid('Unsupported ledger schema.');
  requireArray(ledger.entries, 'ledger.entries');
  const ids = new Set();
  const audits = new Set();
  for (const entry of ledger.entries) {
    if (!isObject(entry) || !idPattern.test(entry.questionId)) invalid('Invalid ledger question identity.');
    if (ids.has(entry.questionId) || audits.has(entry.auditId)) invalid('Duplicate ledger identity.');
    if (!/^(?:SET-SRC-\d{3}|IMPORT-SRC-[a-f0-9]{24})$/.test(entry.auditId)) invalid('Invalid ledger audit identity.');
    ids.add(entry.questionId); audits.add(entry.auditId);
    if (!['ready', 'pending'].includes(entry.status)) invalid('Unknown ledger status.');
    if (entry.status === 'ready') safePath(bankRoot, entry.contentPath);
    requireArray(entry.pendingReasons, 'entry.pendingReasons');
    if (entry.status === 'pending' && !entry.pendingReasons.length) invalid('Pending question needs a reason.');
  }
  return { ledger, bankRoot };
}

export async function listQuestions({ root = defaultRoot } = {}) {
  try {
    const { ledger } = await readLedger(root);
    const ready = ledger.entries.filter(entry => entry.status === 'ready').length;
    return { ok: true, totals: { sourceUnits: ledger.entries.length, ready, pending: ledger.entries.length - ready }, entries: ledger.entries };
  } catch (error) { return failure(error); }
}

function verifyRevision(record, field, hashField, payloadField, prefix) {
  const computed = hashContent(record[payloadField]);
  requireSha(record[hashField], hashField);
  if (record[hashField] !== computed || record[field] !== `${prefix}-${computed.slice(0, 16)}`) {
    invalid(`${payloadField} content does not match its version and hash.`);
  }
}

function verifyStudent(student) {
  if (!isObject(student)) invalid('Missing student content.');
  requireText(student.stem, 'student.stem');
  requireArray(student.options, 'student.options');
  requireArray(student.parts, 'student.parts');
  requireArray(student.assets, 'student.assets');
  const labels = new Set();
  for (const option of student.options) {
    requireText(option?.label, 'option.label'); requireText(option?.text, 'option.text');
    if (labels.has(option.label)) invalid('Duplicate option label.');
    labels.add(option.label);
  }
  const parts = new Set();
  for (const part of student.parts) {
    requireText(part?.partId, 'part.partId'); requireText(part?.prompt, 'part.prompt');
    if (parts.has(part.partId)) invalid('Duplicate parent-question part identity.');
    parts.add(part.partId);
  }
}

function verifyTeacher(record) {
  if (!isObject(record.teacher)) invalid('Missing teacher container.');
  const partIds = new Set(['main', ...record.student.parts.map(part => part.partId)]);
  const provenances = new Set(['source', 'source_adapted', 'proposed', 'generated']);
  for (const field of ['answers', 'solutions', 'scoringSuggestions']) {
    requireArray(record.teacher[field], `teacher.${field}`);
    for (const item of record.teacher[field]) {
      if (!isObject(item) || !partIds.has(item.partId)) invalid(`teacher.${field} refers to an unknown parent-question part.`);
      requireText(item.text, `teacher.${field}.text`);
      if (!provenances.has(item.provenance)) invalid(`teacher.${field} has an unknown provenance.`);
    }
  }
}

async function verifySources(root, bankRoot, record) {
  const repository = questionBankStorage(root);
  const manifest = repository ? repository.getQuestionBankConfig('source_manifest') : await readJson(bankRoot, 'sources.json');
  if (!isObject(manifest) || manifest.schemaVersion !== 1) invalid('Unsupported source manifest schema.');
  requireArray(manifest.sources, 'sources');
  const sources = new Map();
  for (const source of manifest.sources) {
    requireText(source?.sourceId, 'sourceId'); requireSha(source.sha256, 'source.sha256');
    if (sources.has(source.sourceId)) invalid('Duplicate source identity.');
    if (!Number.isInteger(source.physicalPages) || source.physicalPages < 1) invalid('Invalid source page count.');
    safePath(root, source.path);
    sources.set(source.sourceId, source);
  }
  requireArray(record.sourceRefs, 'sourceRefs');
  if (!record.sourceRefs.length) invalid('A ready question needs source references.');
  const refs = [...record.sourceRefs, ...record.verification.checkedSourcePages];
  for (const field of ['answers', 'solutions', 'scoringSuggestions']) {
    for (const item of record.teacher[field]) {
      if (item.sourceRefs !== undefined) {
        requireArray(item.sourceRefs, `teacher.${field}.sourceRefs`);
        refs.push(...item.sourceRefs);
      }
    }
  }
  const used = new Set();
  for (const ref of refs) {
    const source = sources.get(ref?.sourceId);
    if (!source) invalid('Question references an unknown source.');
    requireArray(ref.pages, 'sourceRef.pages');
    if (!ref.pages.length || ref.pages.some(page => !Number.isInteger(page) || page < 1 || page > source.physicalPages)) {
      invalid(`Source pages are outside ${ref.sourceId}.`);
    }
    used.add(ref.sourceId);
  }
  // Import verifies source bytes before publishing the SQLite snapshot. Runtime reads
  // validate the saved references without repeatedly reading original paper PDFs.
  if (!repository) await Promise.all([...used].map(async sourceId => {
    const source = sources.get(sourceId);
    const hash = createHash('sha256').update(await readSafe(root, source.path)).digest('hex');
    if (hash !== source.sha256) invalid(`Source hash mismatch: ${sourceId}.`);
  }));
  await Promise.all(record.student.assets.map(async asset => {
    requireSha(asset?.sha256, 'asset.sha256');
    safePath(root, asset.path);
    if (repository) return;
    const hash = createHash('sha256').update(await readSafe(root, asset.path)).digest('hex');
    if (hash !== asset.sha256) invalid(`Asset hash mismatch: ${asset.path}.`);
  }));
}

export async function getQuestion(questionId, { contentVersion, teacherVersion, root = defaultRoot } = {}) {
  try {
    if (typeof questionId !== 'string' || !idPattern.test(questionId)) {
      throw new BankError('not_found', 'Question identity was not found.');
    }
    const { ledger, bankRoot } = await readLedger(root);
    const entry = ledger.entries.find(item => item.questionId === questionId);
    if (!entry) throw new BankError('not_found', `Question not found: ${questionId}.`);
    if (entry.status !== 'ready') throw new BankError('not_ready', `Question is pending: ${entry.pendingReasons.join('; ')}`);
    const repository = questionBankStorage(root);
    const record = repository ? repository.getQuestionBankQuestion(questionId) : await readJson(bankRoot, entry.contentPath);
    if (repository && !record) invalid('SQLite ready question package is missing.');
    if (!isObject(record) || record.schemaVersion !== 1 || record.questionId !== questionId || record.auditId !== entry.auditId
        || record.questionType !== entry.questionType) invalid('Question identity does not match the ledger.');
    for (const versionField of ['contentVersion', 'teacherVersion']) {
      if (entry[versionField] !== undefined && entry[versionField] !== record[versionField]) invalid(`Ledger ${versionField} differs from the question package.`);
    }
    if (!['single_choice', 'fill_blank', 'free_response'].includes(record.questionType)) invalid('Unsupported question type.');
    verifyStudent(record.student);
    if (record.questionType === 'single_choice' && record.student.options.length < 2) invalid('Single-choice student content needs options.');
    if (record.questionType === 'fill_blank' && record.student.options.length) invalid('Fill-blank student content cannot contain choice options.');
    if (record.questionType === 'free_response' && !record.student.parts.length) invalid('Free-response student content needs parent-question parts.');
    verifyTeacher(record);
    verifyRevision(record, 'contentVersion', 'contentSha256', 'student', 'content');
    verifyRevision(record, 'teacherVersion', 'teacherSha256', 'teacher', 'teacher');
    for (const field of ['scopeEvidence', 'verification']) {
      if (!isObject(record[field]) || record[field].contentVersion !== record.contentVersion
          || record[field].teacherVersion !== record.teacherVersion) invalid(`${field} is not bound to these content versions.`);
    }
    if (record.scopeEvidence.status !== 'within' || record.verification.result !== 'pass') invalid('Ready question lacks passing scope and source checks.');
    requireText(record.scopeEvidence.allowedSolution, 'scopeEvidence.allowedSolution');
    requireText(record.scopeEvidence.courseBasis, 'scopeEvidence.courseBasis');
    requireArray(record.scopeEvidence.primaryTopics, 'scopeEvidence.primaryTopics');
    requireArray(record.scopeEvidence.requiredKnowledge, 'scopeEvidence.requiredKnowledge');
    requireText(record.verification.method, 'verification.method');
    requireArray(record.verification.checkedSourcePages, 'verification.checkedSourcePages');
    if (!record.verification.checkedSourcePages.length) invalid('Source verification needs checked physical pages.');
    await verifySources(path.resolve(root), bankRoot, record);
    if ((contentVersion !== undefined && contentVersion !== record.contentVersion)
        || (teacherVersion !== undefined && teacherVersion !== record.teacherVersion)) {
      throw new BankError('version_not_found', 'The requested version is unavailable; no fallback was selected.');
    }
    return { ok: true, question: record };
  } catch (error) { return failure(error); }
}

// Student consumers receive a constructed allowlist, never the teacher package.
export async function getStudentQuestion(questionId, options = {}) {
  const result = await getQuestion(questionId, options);
  if (!result.ok) return result;
  const record = result.question;
  const student = {
    stem: record.student.stem,
    options: record.student.options.map(({ label, text }) => ({ label, text })),
    parts: record.student.parts.map(({ partId, prompt }) => ({ partId, prompt })),
    assets: record.student.assets.map(({ assetId, path: assetPath, sha256, mimeType, alt }) =>
      Object.fromEntries(Object.entries({ assetId, path: assetPath, sha256, mimeType, alt }).filter(([, value]) => value !== undefined))),
  };
  return { ok: true, question: {
    schemaVersion: record.schemaVersion,
    questionId: record.questionId,
    auditId: record.auditId,
    questionType: record.questionType,
    contentVersion: record.contentVersion,
    contentSha256: record.contentSha256,
    student,
  } };
}
