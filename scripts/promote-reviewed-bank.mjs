import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashContent } from '../src/question-bank/integrity.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const snapshots = ['question_bank_state', 'question_bank_config', 'question_bank_pedagogy'];
const immutableShared = ['curriculum_textbooks', 'curriculum_chapters', 'curriculum_sections', 'knowledge_points',
  'section_knowledge_mappings', 'knowledge_relations', 'curriculum_mapping_evidence'];
const bankTables = ['question_imports', 'question_bank_questions', 'question_bank_chapters',
  'question_import_publications', 'question_import_published_items', 'question_section_mappings', 'question_knowledge_mappings', ...snapshots];
const keys = { question_imports: ['import_id'], question_bank_questions: ['question_id'], question_bank_chapters: ['chapter_id'],
  question_import_publications: ['publication_id'], question_import_published_items: ['import_id', 'staging_question_id'],
  question_section_mappings: ['question_id', 'section_id'], question_knowledge_mappings: ['question_id', 'knowledge_uid', 'topic'],
  question_bank_state: ['kind'], question_bank_config: ['kind'], question_bank_pedagogy: ['kind'] };
const exists = (db, table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
const rows = (db, table) => exists(db, table) ? db.prepare(`SELECT * FROM ${table}`).all() : [];
function verifiedRows(db, table) {
  return rows(db, table).map(row => {
    if (row.payload !== undefined) {
      let value;
      try { value = JSON.parse(row.payload); } catch { fail('integrity_error', `${table} contains invalid JSON.`); }
      if (hashContent(value) !== row.sha256) fail('integrity_error', `${table} payload hash differs.`);
      if (table === 'question_imports' && (createHash('sha256').update(row.source_blob).digest('hex') !== row.source_sha256
          || value.source.sha256 !== row.source_sha256)) fail('integrity_error', 'Import source bytes differ.');
    }
    return row;
  });
}
const identity = (row, columns) => JSON.stringify(columns.map(key => row[key]));
function subset(target, source, columns, label) {
  const sourceById = new Map(source.map(row => [identity(row, columns), row]));
  for (const row of target) {
    const other = sourceById.get(identity(row, columns));
    if (!other || row.sha256 !== other.sha256) fail('target_diverged', `Target ${label} is not an identical subset of the reviewed source.`);
  }
}
const snapshot = (data, table, kind) => JSON.parse(data[table].find(row => row.kind === kind)?.payload ?? 'null');
function validate(source, target, data) {
  for (const table of immutableShared) {
    const left = verifiedRows(source, table), right = verifiedRows(target, table);
    const cols = source.pragma(`table_info(${table})`).filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name);
    if (left.length !== right.length) fail('curriculum_diverged', `${table} differs between source and target.`);
    subset(right, left, cols, table);
  }
  subset(verifiedRows(target, 'question_bank_questions'), data.question_bank_questions, keys.question_bank_questions, 'questions');
  subset(verifiedRows(target, 'question_bank_chapters'), data.question_bank_chapters, keys.question_bank_chapters, 'chapters');
  for (const table of ['question_imports', 'question_import_publications']) {
    const sourceById = new Map(data[table].map(row => [identity(row, keys[table]), row]));
    for (const row of verifiedRows(target, table)) {
      const other = sourceById.get(identity(row, keys[table]));
      if (other && other.sha256 !== row.sha256) fail('target_diverged', `Conflicting ${table} record.`);
    }
  }
  const targetData = Object.fromEntries(snapshots.map(table => [table, verifiedRows(target, table)]));
  for (const [table, kind, field, id] of [
    ['question_bank_state', 'ledger', 'entries', 'questionId'], ['question_bank_state', 'question_index', 'entries', 'questionId'],
    ['question_bank_config', 'source_manifest', 'sources', 'sourceId'], ['question_bank_config', 'task_catalog', 'tasks', 'id'],
    ['question_bank_pedagogy', 'analysis', 'entries', 'questionId'],
  ]) {
    const before = snapshot(targetData, table, kind), after = snapshot(data, table, kind);
    if (!before || !after || !Array.isArray(before[field]) || !Array.isArray(after[field])) fail('integrity_error', `Missing ${kind} snapshot.`);
    subset(before[field].map(value => ({ id: value[id], sha256: hashContent(value) })),
      after[field].map(value => ({ id: value[id], sha256: hashContent(value) })), ['id'], kind);
  }
  if (hashContent(snapshot(targetData, 'question_bank_config', 'course_context')) !== hashContent(snapshot(data, 'question_bank_config', 'course_context'))) {
    fail('curriculum_diverged', 'Course context differs.');
  }
  const ledger = snapshot(data, 'question_bank_state', 'ledger'), index = snapshot(data, 'question_bank_state', 'question_index');
  const packages = new Map(data.question_bank_questions.map(row => [row.question_id, JSON.parse(row.payload)]));
  const publications = new Map(data.question_import_publications.map(row => [row.publication_id, JSON.parse(row.payload)]));
  for (const entry of ledger.entries.filter(value => value.status === 'ready')) {
    const question = packages.get(entry.questionId), annotation = index.entries.find(value => value.questionId === entry.questionId);
    if (!question || !annotation || question.contentSha256 !== hashContent(question.student) || question.teacherSha256 !== hashContent(question.teacher)
        || question.contentVersion !== entry.contentVersion || question.teacherVersion !== entry.teacherVersion
        || annotation.contentVersion !== question.contentVersion || annotation.teacherVersion !== question.teacherVersion
        || question.verification?.result !== 'pass') fail('integrity_error', `Invalid ready package ${entry.questionId}.`);
    if (question.questionId.startsWith('tutor-import-')) {
      const item = data.question_import_published_items.find(value => value.question_id === question.questionId);
      const publication = item && publications.get(item.publication_id);
      const imported = item && data.question_imports.find(value => value.import_id === item.import_id);
      if (!publication || !imported || publication.sourceSha256 !== imported.source_sha256
          || question.verification.publicationId !== item.publication_id
          || !publication.accepted.some(value => value.questionId === question.questionId && value.stagingQuestionId === item.staging_question_id
            && value.contentVersion === question.contentVersion && value.teacherVersion === question.teacherVersion)) {
        fail('publication_audit_missing', `Imported package ${entry.questionId} lacks matching publication audit.`);
      }
    }
  }
}

/** Copy reviewed shared bank data only. Existing accounts, sessions and teaching work stay in target. */
export async function promoteReviewedBank({ source: sourcePath, target: targetPath, apply = false } = {}) {
  if (!sourcePath || !targetPath) fail('usage_error', 'Explicit --source and --target database paths are required.');
  const [sourceFile, targetFile] = await Promise.all([realpath(path.resolve(sourcePath)), realpath(path.resolve(targetPath))]);
  if (sourceFile.toLowerCase() === targetFile.toLowerCase()) fail('same_database', 'Source and target must be different databases.');
  const source = new Database(sourceFile, { readonly: true, fileMustExist: true });
  const target = new Database(targetFile, { readonly: !apply, fileMustExist: true });
  try {
    target.pragma('foreign_keys = ON'); target.pragma('busy_timeout = 5000');
    source.exec('BEGIN');
    const data = Object.fromEntries(bankTables.map(table => [table, verifiedRows(source, table)]));
    validate(source, target, data);
    const admin = target.prepare("SELECT user_id FROM users WHERE role='admin' ORDER BY created_at,user_id LIMIT 1").get();
    if (!admin || !exists(target, 'resource_owners')) fail('target_admin_required', 'Target needs an existing administrator to own copied import records.');
    const report = { ok: true, applied: false, source: sourceFile, target: targetFile,
      migrationActor: { name: 'Codex', authority: 'user_authorized_reviewed_bank_transfer',
        meaning: 'Copies existing audited records; does not claim the target administrator independently solved these questions.' },
      counts: Object.fromEntries(bankTables.map(table => [table, data[table].length])),
      addedQuestions: data.question_bank_questions.length - rows(target, 'question_bank_questions').length,
      importOwner: admin.user_id, preserved: ['users', 'auth_sessions', 'documents', 'intake_sessions', 'llm_runs'], backup: null };
    if (!apply) return report;
    const backup = `${targetFile}.before-reviewed-bank-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.sqlite`;
    await target.backup(backup);
    report.backup = backup;
    target.transaction(() => {
      validate(source, target, data);
      for (const table of ['question_import_publications', 'question_import_published_items']) {
        if (!exists(target, table)) {
          const sql = source.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql;
          if (!sql) fail('source_schema_missing', `Source missing ${table}.`);
          target.exec(sql);
        }
      }
      for (const table of bankTables) {
        const values = data[table];
        if (!values.length) continue;
        const columns = Object.keys(values[0]);
        const updates = columns.filter(column => !keys[table].includes(column)).map(column => `${column}=excluded.${column}`).join(',');
        const statement = target.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})
          ON CONFLICT(${keys[table].join(',')}) DO ${updates ? `UPDATE SET ${updates}` : 'NOTHING'}`);
        for (const row of values) statement.run(...columns.map(column => row[column]));
      }
      const own = target.prepare("INSERT OR IGNORE INTO resource_owners(kind,id,user_id) VALUES('imports',?,?)");
      for (const row of data.question_imports) own.run(row.import_id, admin.user_id);
      target.exec(`CREATE TABLE IF NOT EXISTS question_bank_promotions(
        promotion_id TEXT PRIMARY KEY,payload TEXT NOT NULL,sha256 TEXT NOT NULL,created_at TEXT NOT NULL)`);
      report.applied = true;
      target.prepare('INSERT INTO question_bank_promotions VALUES(?,?,?,?)').run(randomUUID(), JSON.stringify(report), hashContent(report), new Date().toISOString());
      if (target.pragma('foreign_key_check').length) fail('foreign_key_error', 'Target foreign-key check failed; promotion rolled back.');
      validate(source, target, data);
    }).immediate();
    return report;
  } finally { source.close(); target.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = {};
    const args = process.argv.slice(2);
    while (args.length) {
      const option = args.shift();
      if (option === '--apply' && !options.apply) options.apply = true;
      else if (['--source', '--target'].includes(option) && !options[option.slice(2)] && args[0] && !args[0].startsWith('--')) options[option.slice(2)] = args.shift();
      else fail('usage_error', 'Usage: node scripts/promote-reviewed-bank.mjs --source <db> --target <db> [--apply]');
    }
    console.log(JSON.stringify(await promoteReviewedBank(options), null, 2));
  } catch (error) { console.error(JSON.stringify({ ok: false, error: { code: error.code ?? 'promotion_failed', message: error.message } }, null, 2)); process.exitCode = 1; }
}
