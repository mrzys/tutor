import Database from 'better-sqlite3';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { hashContent } from '../question-bank/reader.mjs';

const registrations = new Map();
const kinds = ['drafts', 'papers', 'feedback', 'outputs'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const storageError = (code, message) => Object.assign(new Error(message), { code });

function validateEnvelope(kind, id, value) {
  if (kind === 'drafts' && (value.schemaVersion !== 1 || value.draft?.draftId !== id || value.sha256 !== hashContent(value.draft))) {
    throw storageError('integrity_error', '草稿校验不通过。');
  }
  if (kind === 'papers') {
    const paper = value.paper;
    if (value.schemaVersion !== 1 || paper?.schemaVersion !== 1 || paper.paperId !== id || value.sha256 !== hashContent(paper)
      || paper.snapshotSha256 !== hashContent(paper.draft) || paper.sourceDraftId !== paper.draft?.draftId
      || paper.sourceRevision !== (paper.draft.revision ?? 0)) throw storageError('integrity_error', '成卷校验不通过。');
  }
  if (kind === 'feedback' && (value.schemaVersion !== 1 || value.paperId !== id || !Array.isArray(value.records))) {
    throw storageError('integrity_error', '反馈记录校验不通过。');
  }
  if (kind === 'outputs' && (value.schemaVersion !== 1 || !['student', 'teacher'].includes(value.kind)
    || id !== `${id.split('/')[0]}/${value.kind}` || typeof value.paperHash !== 'string')) throw storageError('integrity_error', '输出清单校验不通过。');
}

export class SqliteRepository {
  constructor(filename) {
    this.filename = filename;
    this.database = new Database(filename);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('foreign_keys = ON');
    this.database.pragma('busy_timeout = 5000');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents(
        kind TEXT NOT NULL CHECK(kind IN ('drafts','papers','feedback','outputs')),
        id TEXT NOT NULL, payload TEXT NOT NULL, sha256 TEXT NOT NULL,
        revision INTEGER, source_draft_id TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY(kind,id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_paper_per_source_draft ON documents(source_draft_id) WHERE kind = 'papers';
      CREATE TRIGGER IF NOT EXISTS immutable_paper_update BEFORE UPDATE ON documents WHEN OLD.kind='papers'
        BEGIN SELECT RAISE(ABORT, 'immutable paper'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_paper_delete BEFORE DELETE ON documents WHEN OLD.kind='papers'
        BEGIN SELECT RAISE(ABORT, 'immutable paper'); END;
      CREATE TABLE IF NOT EXISTS legacy_imports(
        source_path TEXT PRIMARY KEY, kind TEXT NOT NULL, id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('imported','skipped','failed')),
        code TEXT, message TEXT, imported_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS intake_sessions(id TEXT PRIMARY KEY, payload TEXT NOT NULL, sha256 TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS llm_runs(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT OR IGNORE INTO schema_migrations VALUES(1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      INSERT OR IGNORE INTO schema_migrations VALUES(2, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    `);
    const queues = new Map();
    this.intakeStorage = {
      get: async id => {
        const row = this.database.prepare('SELECT payload,sha256 FROM intake_sessions WHERE id=?').get(id);
        if (!row) return null;
        const session = JSON.parse(row.payload);
        if (hashContent(session) !== row.sha256) throw storageError('integrity_error', '需求会话校验失败。');
        return session;
      },
      put: async session => {
        if (!session.sessionId) throw storageError('invalid_request', '需求会话身份无效。');
        this.database.transaction(() => {
          this.database.prepare(`INSERT INTO intake_sessions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET
            payload=excluded.payload,sha256=excluded.sha256,updated_at=excluded.updated_at`)
            .run(session.sessionId, JSON.stringify(session), hashContent(session), new Date().toISOString());
          if (session.llmRun) this.database.prepare('INSERT OR IGNORE INTO llm_runs VALUES(?,?,?,?)')
            .run(session.llmRun.runId ?? hashContent(session.llmRun), session.sessionId, JSON.stringify(session.llmRun), new Date().toISOString());
        }).immediate();
      },
      transaction: async (id, callback) => {
        const previous = queues.get(id) ?? Promise.resolve();
        const result = previous.then(callback); const tail = result.catch(() => {});
        queues.set(id, tail);
        try { return await result; }
        finally { if (queues.get(id) === tail) queues.delete(id); }
      },
    };
  }

  get(kind, id) {
    const row = this.database.prepare('SELECT payload,sha256 FROM documents WHERE kind=? AND id=?').get(kind, id);
    if (!row) return null;
    let value;
    try { value = JSON.parse(row.payload); }
    catch { throw storageError('integrity_error', 'SQLite 存储内容无法解析，未覆盖原记录。'); }
    if (hashContent(value) !== row.sha256) throw storageError('integrity_error', 'SQLite 存储校验失败，未覆盖原记录。');
    validateEnvelope(kind, id, value);
    return value;
  }

  list(kind) { return this.database.prepare('SELECT id FROM documents WHERE kind=? ORDER BY id').all(kind).map(row => row.id); }

  warnings(kind) {
    return this.database.prepare("SELECT id,code,message,source_path AS sourcePath FROM legacy_imports WHERE kind=? AND status='failed'").all(kind);
  }

  put(kind, id, value, { immutable = false, expectedRevision } = {}) {
    validateEnvelope(kind, id, value);
    const write = this.database.transaction(() => {
      const existing = this.get(kind, id);
      if ((immutable || kind === 'papers') && existing) throw storageError('operation_conflict', '不可变内容已存在，未覆盖。');
      if (expectedRevision !== undefined && (!existing || (existing.draft.revision ?? 0) !== expectedRevision)) {
        throw storageError('revision_conflict', '草稿已更新，请重新读取后再操作。');
      }
      if (kind === 'papers') {
        const sourceDraft = this.get('drafts', value.paper.sourceDraftId)?.draft;
        if (sourceDraft && sourceDraft.confirmedPaperId !== id && (sourceDraft.revision ?? 0) !== value.paper.sourceRevision) {
          throw storageError('revision_conflict', '草稿在确认期间已更新，未保存过期成卷。');
        }
      }
      if (kind === 'drafts') {
        const published = this.database.prepare("SELECT id FROM documents WHERE kind='papers' AND source_draft_id=?").get(id);
        if (published && value.draft.confirmedPaperId !== published.id) {
          throw storageError('finalized_draft', '此草稿已有不可变成卷，请恢复确认标记或派生新草稿。');
        }
      }
      const revision = kind === 'drafts' ? (value.draft.revision ?? 0) : null;
      const source = kind === 'papers' ? value.paper.sourceDraftId : null;
      try {
        this.database.prepare(`INSERT INTO documents(kind,id,payload,sha256,revision,source_draft_id,updated_at)
          VALUES(?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload,sha256=excluded.sha256,
          revision=excluded.revision,source_draft_id=excluded.source_draft_id,updated_at=excluded.updated_at`)
          .run(kind, id, JSON.stringify(value), hashContent(value), revision, source, new Date().toISOString());
      } catch (cause) {
        if (cause.code?.startsWith('SQLITE_CONSTRAINT')) throw storageError('operation_conflict', '内容身份或成卷来源冲突，未覆盖已有记录。');
        throw cause;
      }
    });
    write.immediate();
  }

  appendFeedback(paperId, record) {
    this.database.transaction(() => {
      const existing = this.get('feedback', paperId) ?? { schemaVersion: 1, paperId, records: [] };
      this.put('feedback', paperId, { ...existing, records: [...existing.records, record] });
    }).immediate();
  }

  close() { this.database.close(); }
}

export function sqliteStorage(directory, expectedKind) {
  const resolved = path.resolve(directory);
  for (const [baseRoot, repository] of registrations) {
    const relative = path.relative(baseRoot, resolved);
    if (relative === expectedKind) return repository;
  }
  return null;
}

async function names(directory) {
  try { return await readdir(directory, { withFileTypes: true }); }
  catch (cause) { if (cause.code === 'ENOENT') return []; throw cause; }
}

export async function importLegacyStorage(baseRoot, repository) {
  const report = { imported: 0, skipped: 0, warnings: [] };
  const files = [];
  for (const kind of kinds) {
    const directory = path.join(baseRoot, kind);
    for (const entry of await names(directory)) {
      if (kind === 'outputs' && entry.isDirectory() && uuid.test(entry.name)) {
        for (const manifest of await names(path.join(directory, entry.name))) {
          if (manifest.isFile() && ['student.json', 'teacher.json'].includes(manifest.name)) files.push({
            kind, id: `${entry.name}/${manifest.name.slice(0, -5)}`, filename: path.join(directory, entry.name, manifest.name),
          });
        }
      } else if (kind !== 'outputs' && entry.isFile() && entry.name.endsWith('.json')) files.push({
        kind, id: entry.name.slice(0, -5), filename: path.join(directory, entry.name),
      });
    }
  }
  for (const { kind, id, filename } of files) {
    const previous = repository.database.prepare('SELECT status,code,message FROM legacy_imports WHERE source_path=?').get(filename);
    if (previous) {
      report.skipped++;
      if (previous.status === 'failed') report.warnings.push({ kind, id, sourcePath: filename, code: previous.code, message: previous.message });
      continue;
    }
    let status = 'imported'; let code = null; let message = null;
    try {
      if (kind !== 'outputs' && !uuid.test(id)) throw storageError('integrity_error', '旧存储文件身份无效。');
      const value = JSON.parse(await readFile(filename, 'utf8'));
      validateEnvelope(kind, id, value);
      repository.database.transaction(() => {
        if (repository.get(kind, id)) { status = 'skipped'; return; }
        repository.put(kind, id, value, { immutable: true });
      }).immediate();
      report[status]++;
    } catch (cause) {
      status = 'failed'; code = cause.code ?? 'read_error'; message = `旧 JSON 保留原处，未导入：${cause.message}`;
      report.warnings.push({ kind, id, sourcePath: filename, code, message });
    }
    repository.database.prepare('INSERT INTO legacy_imports VALUES(?,?,?,?,?,?,?)')
      .run(filename, kind, id, status, code, message, new Date().toISOString());
  }
  return report;
}

export async function registerSqliteStorage(baseRoot, databasePath = path.join(baseRoot, 'tutor.sqlite')) {
  const resolved = path.resolve(baseRoot);
  if (registrations.has(resolved)) throw storageError('storage_in_use', '此存储目录已注册。');
  await mkdir(path.dirname(databasePath), { recursive: true });
  const repository = new SqliteRepository(databasePath);
  try {
    const migration = await importLegacyStorage(resolved, repository);
    registrations.set(resolved, repository);
    return { repository, migration, close() { registrations.delete(resolved); repository.close(); } };
  } catch (cause) { repository.close(); throw cause; }
}
