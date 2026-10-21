import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { hashContent } from './lib/integrity.mjs';

// Explicit shared-data allowlist: never SELECT accounts, imports/uploads, students,
// sessions, drafts, papers, outputs or feedback from the old multi-user database.
export const SHARED_TABLES = [
  'question_bank_state', 'question_bank_config', 'question_bank_questions',
  'question_bank_chapters', 'question_bank_pedagogy', 'question_bank_promotions',
  'curriculum_textbooks', 'curriculum_chapters', 'curriculum_sections',
  'knowledge_points', 'section_knowledge_mappings', 'knowledge_relations',
  'question_section_mappings', 'question_knowledge_mappings', 'curriculum_mapping_evidence',
];

function payload(row, label) {
  const value = JSON.parse(row.payload);
  if (row.sha256 !== hashContent(value)) throw new Error(`${label}: payload hash mismatch`);
  return value;
}
function verifyQuestion(question) {
  if (question.schemaVersion !== 1 || question.verification?.result !== 'pass')
    throw new Error(`${question.questionId}: ready question is not verified`);
  for (const [field, prefix, versionKey, hashKey] of [
    ['student', 'content', 'contentVersion', 'contentSha256'],
    ['teacher', 'teacher', 'teacherVersion', 'teacherSha256'],
  ]) {
    const sha = hashContent(question[field]);
    const version = `${prefix}-${sha.slice(0, 16)}`;
    if (question[hashKey] !== sha || question[versionKey] !== version
      || question.verification[versionKey] !== version)
      throw new Error(`${question.questionId}: ${field} version mismatch`);
  }
}
async function inlineAssets(question, root) {
  const assets = [];
  for (const role of ['student', 'teacher']) for (const asset of question[role]?.assets ?? []) {
    if (typeof asset.path !== 'string' || asset.path.includes('\\') || asset.path.includes(':')
      || asset.path.split('/').some(part => !part || part === '.' || part === '..'))
      throw new Error(`${question.questionId}: unsafe asset path`);
    const filename = await realpath(path.join(root, asset.path));
    const relative = path.relative(root, filename);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error(`${question.questionId}: asset escapes bank root`);
    const bytes = await readFile(filename);
    if (bytes.length > 20 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== asset.sha256)
      throw new Error(`${question.questionId}: asset hash/size mismatch`);
    assets.push({ ...asset, role, dataBase64: bytes.toString('base64') });
  }
  return assets.length ? { ...question, assetPayloads: assets } : question;
}

export async function exportDesktopBank({ database, root, baseline, migrationId }) {
  const bankRoot = await realpath(root);
  const old = new DatabaseSync(database, { readOnly: true });
  const tables = {};
  try {
    old.exec('PRAGMA query_only=ON; BEGIN');
    const existing = new Set(old.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name));
    for (const table of SHARED_TABLES) {
      if (!existing.has(table)) continue;
      const columns = old.prepare(`PRAGMA table_info(${table})`).all();
      const keys = columns.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name);
      const rows = old.prepare(`SELECT * FROM ${table}${keys.length ? ` ORDER BY ${keys.join(',')}` : ''}`).all();
      for (const row of rows) if ('payload' in row && 'sha256' in row) payload(row, table);
      tables[table] = rows;
    }
    old.exec('COMMIT');
  } finally { old.close(); }
  const states = Object.fromEntries((tables.question_bank_state ?? []).map(row => [row.kind, payload(row, row.kind)]));
  const configs = Object.fromEntries((tables.question_bank_config ?? []).map(row => [row.kind, payload(row, row.kind)]));
  if (!Array.isArray(states.ledger?.entries) || !Array.isArray(states.question_index?.entries)
    || !configs.task_catalog || !configs.course_context || !configs.source_manifest)
    throw new Error('Shared bank configuration is incomplete');
  const rows = tables.question_bank_questions ?? [];
  const records = new Map(rows.map(row => [row.question_id, payload(row, row.question_id)]));
  const ready = states.ledger.entries.filter(entry => entry.status === 'ready');
  const ledgerIds = new Set(states.ledger.entries.map(entry => entry.questionId));
  if (ledgerIds.size !== states.ledger.entries.length || rows.some(row => !ledgerIds.has(row.question_id)))
    throw new Error('Ledger identities are duplicated or question rows lack their ledger state');
  if (states.ledger.entries.some(entry => !['ready', 'pending'].includes(entry.status)))
    throw new Error('Unknown question review state');
  const questions = [];
  for (const entry of ready) {
    const question = records.get(entry.questionId);
    if (!question || question.questionId !== entry.questionId) throw new Error(`${entry.questionId}: missing ready content`);
    verifyQuestion(question);
    questions.push(await inlineAssets(question, bankRoot));
  }
  questions.sort((a, b) => a.questionId.localeCompare(b.questionId, 'en'));
  const config = JSON.parse(JSON.stringify({
    ...configs.task_catalog,
    chapters: (tables.question_bank_chapters ?? []).slice().sort((a, b) => a.position - b.position).map(row => payload(row, row.chapter_id)),
    courseContext: configs.course_context, sourceManifest: configs.source_manifest,
    sources: configs.source_manifest.sources.map(({ sourceId, role, path }) => ({ sourceId, role, path })),
    assemblyIndex: states.question_index,
  }));
  const bankSnapshot = {
    schemaVersion: 1, ledger: states.ledger, questions: rows, tables,
    counts: { ready: ready.length, pending: states.ledger.entries.length - ready.length,
      questionRows: rows.length, sourceUnits: states.ledger.entries.length },
  };
  const manifestSha256 = hashContent({ config, questions, bankSnapshot });
  return { schemaVersion: 1, config, questions, bankSnapshot, migration: {
    id: migrationId, baselineConfig: baseline.config,
    baselineConfigSha256: hashContent(baseline.config), manifestSha256,
  } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, index, all) => {
    if (index % 2 === 0 && arg.startsWith('--') && all[index + 1]) pairs.push([arg.slice(2), all[index + 1]]);
    return pairs;
  }, []));
  if (!args.database || !args.output || !args.root || !args.baseline || !args.id)
    throw new Error('Required: --database --root --baseline --output --id');
  const sourcePath = await realpath(args.database);
  const outputPath = await realpath(args.output).catch(error => {
    if (error.code === 'ENOENT') return path.resolve(args.output);
    throw error;
  });
  if (sourcePath.toLowerCase() === outputPath.toLowerCase() || path.extname(outputPath).toLowerCase() !== '.json')
    throw new Error('Output must be a JSON file distinct from the source database');
  const baseline = JSON.parse(await readFile(args.baseline, 'utf8'));
  const seed = await exportDesktopBank({ ...args, migrationId: args.id, baseline });
  const staging = `${args.output}.${randomUUID()}.tmp`;
  try {
    await writeFile(staging, JSON.stringify(seed), { flag: 'wx' });
    await rename(staging, args.output);
  } catch (error) { await unlink(staging).catch(() => {}); throw error; }
  console.log(JSON.stringify({ ...seed.bankSnapshot.counts, manifestSha256: seed.migration.manifestSha256,
    embeddedAssets: seed.questions.reduce((sum, q) => sum + (q.assetPayloads?.length ?? 0), 0),
    questionTypes: seed.questions.reduce((counts, q) => ({ ...counts, [q.questionType]: (counts[q.questionType] ?? 0) + 1 }), {}) }));
}
