import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { getQuestion, listQuestions } from '../question-bank/reader.mjs';
import { hashContent } from '../question-bank/integrity.mjs';
import { readPedagogySeed } from '../question-bank/pedagogy.mjs';
import { registerQuestionBank, registeredStorage, registerStorage, storageForDirectory,
  unregisterQuestionBank, unregisterStorage, questionBankStorage } from './registry.mjs';

const kinds = ['drafts', 'papers', 'feedback', 'outputs'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const storageError = (code, message) => Object.assign(new Error(message), { code });

function validateQuestionImport(value) {
  if (value?.schemaVersion !== 1 || !uuid.test(value.importId) || value.status !== 'pending_review'
      || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string'
      || !Array.isArray(value.questions) || value.questions.some(question => question?.status !== 'pending_review')
      || value.reviewSummary?.publicationBlocked !== true) {
    throw storageError('integrity_error', '试卷解析暂存记录校验不通过。');
  }
}

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
      CREATE TABLE IF NOT EXISTS users(
        user_id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL, password_salt TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','teacher')), created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_sessions(
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
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
      CREATE TABLE IF NOT EXISTS question_bank_state(
        kind TEXT PRIMARY KEY CHECK(kind IN ('ledger','question_index')),
        payload TEXT NOT NULL, sha256 TEXT NOT NULL, synced_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS question_bank_config(
        kind TEXT PRIMARY KEY CHECK(kind IN ('task_catalog','course_context','source_manifest')),
        payload TEXT NOT NULL, sha256 TEXT NOT NULL, synced_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS question_bank_pedagogy(
        kind TEXT PRIMARY KEY CHECK(kind='analysis'), payload TEXT NOT NULL,
        sha256 TEXT NOT NULL, synced_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS question_bank_questions(
        question_id TEXT PRIMARY KEY, payload TEXT NOT NULL, sha256 TEXT NOT NULL,
        content_version TEXT NOT NULL, teacher_version TEXT NOT NULL, synced_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS question_bank_chapters(
        chapter_id TEXT PRIMARY KEY, position INTEGER NOT NULL UNIQUE,
        payload TEXT NOT NULL, sha256 TEXT NOT NULL, synced_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS curriculum_textbooks(
        textbook_id TEXT PRIMARY KEY, position INTEGER NOT NULL UNIQUE,
        title TEXT NOT NULL, volume TEXT NOT NULL, publisher TEXT NOT NULL,
        edition_year INTEGER, source_path TEXT NOT NULL, source_sha256 TEXT NOT NULL,
        page_count INTEGER NOT NULL, byte_size INTEGER NOT NULL,
        processing_status TEXT NOT NULL, review_status TEXT NOT NULL,
        payload TEXT NOT NULL, sha256 TEXT NOT NULL, synced_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS curriculum_chapters(
        chapter_id TEXT PRIMARY KEY, textbook_id TEXT NOT NULL REFERENCES curriculum_textbooks(textbook_id) ON DELETE CASCADE,
        position INTEGER NOT NULL, number TEXT, title TEXT NOT NULL,
        printed_page_start INTEGER, printed_page_end INTEGER, pdf_page_start INTEGER, pdf_page_end INTEGER,
        payload TEXT NOT NULL, sha256 TEXT NOT NULL, synced_at TEXT NOT NULL,
        UNIQUE(textbook_id, position)
      );
      CREATE TABLE IF NOT EXISTS curriculum_sections(
        section_id TEXT PRIMARY KEY, chapter_id TEXT NOT NULL REFERENCES curriculum_chapters(chapter_id) ON DELETE CASCADE,
        position INTEGER NOT NULL, number TEXT, title TEXT NOT NULL, optional_in_contents INTEGER NOT NULL DEFAULT 0,
        printed_page_start INTEGER, printed_page_end INTEGER, pdf_page_start INTEGER, pdf_page_end INTEGER,
        payload TEXT NOT NULL, sha256 TEXT NOT NULL, synced_at TEXT NOT NULL,
        UNIQUE(chapter_id, position)
      );
      CREATE TABLE IF NOT EXISTS knowledge_points(
        knowledge_uid TEXT PRIMARY KEY, parent_uid TEXT, name TEXT NOT NULL,
        is_leaf INTEGER NOT NULL, definition TEXT, metadata_json TEXT NOT NULL,
        payload TEXT NOT NULL, sha256 TEXT NOT NULL, synced_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS section_knowledge_mappings(
        section_id TEXT NOT NULL REFERENCES curriculum_sections(section_id) ON DELETE CASCADE,
        knowledge_uid TEXT NOT NULL REFERENCES knowledge_points(knowledge_uid) ON DELETE CASCADE,
        relation TEXT, status TEXT NOT NULL, review_status TEXT NOT NULL,
        payload TEXT NOT NULL, sha256 TEXT NOT NULL, synced_at TEXT NOT NULL,
        PRIMARY KEY(section_id, knowledge_uid)
      );
      CREATE TABLE IF NOT EXISTS knowledge_relations(
        source_uid TEXT NOT NULL REFERENCES knowledge_points(knowledge_uid) ON DELETE CASCADE,
        target_uid TEXT NOT NULL REFERENCES knowledge_points(knowledge_uid) ON DELETE CASCADE,
        relation_type TEXT NOT NULL, status TEXT NOT NULL,
        payload TEXT NOT NULL, sha256 TEXT NOT NULL, synced_at TEXT NOT NULL,
        PRIMARY KEY(source_uid, target_uid, relation_type)
      );
      CREATE TABLE IF NOT EXISTS question_section_mappings(
        question_id TEXT NOT NULL REFERENCES question_bank_questions(question_id) ON DELETE CASCADE,
        section_id TEXT NOT NULL REFERENCES curriculum_sections(section_id) ON DELETE CASCADE,
        raw_section_id TEXT NOT NULL, position INTEGER NOT NULL,
        PRIMARY KEY(question_id, section_id)
      );
      CREATE TABLE IF NOT EXISTS question_knowledge_mappings(
        question_id TEXT NOT NULL REFERENCES question_bank_questions(question_id) ON DELETE CASCADE,
        knowledge_uid TEXT NOT NULL REFERENCES knowledge_points(knowledge_uid) ON DELETE CASCADE,
        topic TEXT NOT NULL, status TEXT NOT NULL, basis TEXT,
        payload TEXT NOT NULL, sha256 TEXT NOT NULL, synced_at TEXT NOT NULL,
        PRIMARY KEY(question_id, knowledge_uid, topic)
      );
      CREATE TABLE IF NOT EXISTS curriculum_mapping_evidence(
        evidence_id TEXT PRIMARY KEY, mapping_type TEXT NOT NULL,
        source_id TEXT, target_id TEXT, status TEXT,
        payload TEXT NOT NULL, sha256 TEXT NOT NULL, synced_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS curriculum_chapters_textbook ON curriculum_chapters(textbook_id, position);
      CREATE INDEX IF NOT EXISTS curriculum_sections_chapter ON curriculum_sections(chapter_id, position);
      CREATE INDEX IF NOT EXISTS section_knowledge_by_uid ON section_knowledge_mappings(knowledge_uid);
      CREATE INDEX IF NOT EXISTS question_sections_by_section ON question_section_mappings(section_id, question_id);
      CREATE TABLE IF NOT EXISTS question_imports(
        import_id TEXT PRIMARY KEY, payload TEXT NOT NULL, sha256 TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status = 'pending_review'), source_blob BLOB NOT NULL,
        source_sha256 TEXT NOT NULL, source_filename TEXT NOT NULL, source_mime_type TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO schema_migrations VALUES(1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      INSERT OR IGNORE INTO schema_migrations VALUES(2, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    `);
    const importColumns = new Set(this.database.pragma('table_info(question_imports)').map(column => column.name));
    if (!importColumns.has('source_blob')) {
      this.database.transaction(() => {
        this.database.exec(`
          ALTER TABLE question_imports RENAME TO question_imports_without_source_v3;
          CREATE TABLE question_imports(
            import_id TEXT PRIMARY KEY, payload TEXT NOT NULL, sha256 TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status = 'pending_review'), source_blob BLOB NOT NULL,
            source_sha256 TEXT NOT NULL, source_filename TEXT NOT NULL, source_mime_type TEXT NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
        `);
      }).immediate();
    }
    this.database.prepare(`INSERT OR IGNORE INTO schema_migrations VALUES(3, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run();
    this.database.prepare(`INSERT OR IGNORE INTO schema_migrations VALUES(4, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run();
    this.database.prepare(`INSERT OR IGNORE INTO schema_migrations VALUES(5, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run();
    this.database.prepare(`INSERT OR IGNORE INTO schema_migrations VALUES(6, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run();
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
          this.beforeIntakeWrite?.(session);
          this.database.prepare(`INSERT INTO intake_sessions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET
            payload=excluded.payload,sha256=excluded.sha256,updated_at=excluded.updated_at`)
            .run(session.sessionId, JSON.stringify(session), hashContent(session), new Date().toISOString());
          if (session.llmRun) this.database.prepare('INSERT OR IGNORE INTO llm_runs VALUES(?,?,?,?)')
            .run(session.llmRun.runId ?? hashContent(session.llmRun), session.sessionId, JSON.stringify(session.llmRun), new Date().toISOString());
          this.afterIntakeWrite?.(session);
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

  #readHashed(table, identityColumn, identity) {
    const row = this.database.prepare(`SELECT payload,sha256 FROM ${table} WHERE ${identityColumn}=?`).get(identity);
    if (!row) return null;
    let value;
    try { value = JSON.parse(row.payload); }
    catch { throw storageError('integrity_error', 'SQLite 题库内容无法解析。'); }
    if (hashContent(value) !== row.sha256) throw storageError('integrity_error', 'SQLite 题库内容校验失败。');
    return value;
  }

  getQuestionBankLedger() { return this.#readHashed('question_bank_state', 'kind', 'ledger'); }
  getQuestionBankIndex() { return this.#readHashed('question_bank_state', 'kind', 'question_index'); }
  getQuestionBankConfig(kind) { return this.#readHashed('question_bank_config', 'kind', kind); }
  getQuestionBankPedagogy() { return this.#readHashed('question_bank_pedagogy', 'kind', 'analysis'); }
  getQuestionBankSummary() {
    const count = table => this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
    return { readyQuestions: count('question_bank_questions'),
      annotations: this.getQuestionBankIndex()?.entries.length ?? 0, chapters: count('question_bank_chapters'),
      textbooks: count('curriculum_textbooks'), curriculumChapters: count('curriculum_chapters'),
      curriculumSections: count('curriculum_sections'), questionSectionMappings: count('question_section_mappings') };
  }
  getQuestionBankQuestion(questionId) { return this.#readHashed('question_bank_questions', 'question_id', questionId); }
  getQuestionBankChapters() {
    return this.database.prepare('SELECT chapter_id FROM question_bank_chapters ORDER BY position').all()
      .map(row => this.#readHashed('question_bank_chapters', 'chapter_id', row.chapter_id));
  }

  getQuestionBankTextbooks() {
    const bookRows = this.database.prepare(`SELECT textbook_id FROM curriculum_textbooks ORDER BY position`).all();
    const chapterRows = this.database.prepare(`SELECT chapter_id,textbook_id FROM curriculum_chapters
      ORDER BY textbook_id,position`).all();
    const sectionRows = this.database.prepare(`SELECT section_id,chapter_id FROM curriculum_sections
      ORDER BY chapter_id,position`).all();
    const books = bookRows.map(row => ({ row, payload: this.#readHashed('curriculum_textbooks', 'textbook_id', row.textbook_id) }));
    const chapters = chapterRows.map(row => ({ row, payload: this.#readHashed('curriculum_chapters', 'chapter_id', row.chapter_id) }));
    const sections = sectionRows.map(row => ({ row, payload: this.#readHashed('curriculum_sections', 'section_id', row.section_id) }));
    const counts = new Map(this.database.prepare(`SELECT section_id,COUNT(DISTINCT question_id) AS question_count
      FROM question_section_mappings GROUP BY section_id`).all().map(row => [row.section_id, Number(row.question_count)]));
    const sectionsByChapter = new Map();
    const chaptersByBook = new Map();
    for (const section of sections) sectionsByChapter.set(section.row.chapter_id,
      [...(sectionsByChapter.get(section.row.chapter_id) ?? []), section]);
    for (const chapter of chapters) chaptersByBook.set(chapter.row.textbook_id,
      [...(chaptersByBook.get(chapter.row.textbook_id) ?? []), chapter]);
    for (const book of books) {
      if (book.payload?.id !== book.row.textbook_id || !Array.isArray(book.payload.chapters)) {
        throw storageError('integrity_error', 'SQLite 教材目录身份校验失败。');
      }
      const children = chaptersByBook.get(book.row.textbook_id) ?? [];
      if (children.length !== book.payload.chapters.length
          || children.some((child, index) => child.row.chapter_id !== book.payload.chapters[index]?.id)) {
        throw storageError('integrity_error', 'SQLite 教材章目录与快照不一致。');
      }
    }
    for (const chapter of chapters) {
      if (chapter.payload?.id !== chapter.row.chapter_id || !Array.isArray(chapter.payload.sections)) {
        throw storageError('integrity_error', 'SQLite 教材章节身份校验失败。');
      }
      const children = sectionsByChapter.get(chapter.row.chapter_id) ?? [];
      if (children.length !== chapter.payload.sections.length
          || children.some((child, index) => child.row.section_id !== chapter.payload.sections[index]?.id)) {
        throw storageError('integrity_error', 'SQLite 教材小节目录与快照不一致。');
      }
    }
    for (const section of sections) {
      if (section.payload?.id !== section.row.section_id) {
        throw storageError('integrity_error', 'SQLite 教材小节身份校验失败。');
      }
    }
    return books.map(book => ({
      id: book.payload.id,
      label: book.payload.volume,
      title: book.payload.title,
      chapters: (chaptersByBook.get(book.payload.id) ?? []).map(chapter => ({
        id: chapter.payload.id,
        label: `${chapter.payload.number ? `第 ${chapter.payload.number} 章 ` : ''}${chapter.payload.title}`,
        number: chapter.payload.number ?? undefined,
        title: chapter.payload.title,
        sections: (sectionsByChapter.get(chapter.payload.id) ?? []).map(section => ({
          id: section.payload.id,
          label: `${section.payload.number ? `${section.payload.number} ` : ''}${section.payload.title}`,
          number: section.payload.number ?? undefined,
          title: section.payload.title,
          questionCount: counts.get(section.payload.id) ?? 0,
        })),
      })),
    }));
  }

  getQuestionSectionIds(questionId) {
    return this.database.prepare(`SELECT section_id FROM question_section_mappings WHERE question_id=? ORDER BY position`)
      .all(questionId).map(row => row.section_id);
  }

  putQuestionImport(record, source) {
    validateQuestionImport(record);
    if (!Buffer.isBuffer(source?.bytes) || source.sha256 !== record.source?.sha256
        || typeof source.filename !== 'string' || source.filename !== record.source?.filename
        || typeof source.mimeType !== 'string' || source.mimeType !== record.source?.mimeType
        || createHash('sha256').update(source.bytes).digest('hex') !== source.sha256) {
      throw storageError('integrity_error', '试卷解析源文件校验不通过。');
    }
    const existing = this.database.prepare(`SELECT sha256,source_sha256,source_blob FROM question_imports
      WHERE import_id=?`).get(record.importId);
    if (existing) {
      const exact = existing.sha256 === hashContent(record) && existing.source_sha256 === source.sha256
        && Buffer.compare(existing.source_blob, source.bytes) === 0;
      if (exact) return;
      throw storageError('operation_conflict', '试卷解析暂存记录已存在，不能覆盖。');
    }
    this.database.prepare(`INSERT INTO question_imports
      (import_id,payload,sha256,status,source_blob,source_sha256,source_filename,source_mime_type,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(record.importId, JSON.stringify(record), hashContent(record), record.status, source.bytes,
        source.sha256, source.filename, source.mimeType, record.createdAt, record.updatedAt);
  }

  getQuestionImport(importId) {
    const row = this.database.prepare(`SELECT payload,sha256,source_blob,source_sha256,source_filename,source_mime_type
      FROM question_imports WHERE import_id=?`).get(importId);
    if (!row) return null;
    let record;
    try { record = JSON.parse(row.payload); }
    catch { throw storageError('integrity_error', 'SQLite 试卷解析记录无法解析。'); }
    validateQuestionImport(record);
    const sourceHash = createHash('sha256').update(row.source_blob).digest('hex');
    if (hashContent(record) !== row.sha256 || sourceHash !== row.source_sha256
        || row.source_sha256 !== record.source.sha256 || row.source_filename !== record.source.filename
        || row.source_mime_type !== record.source.mimeType) {
      throw storageError('integrity_error', 'SQLite 试卷解析记录或源文件校验失败。');
    }
    return record;
  }
  listQuestionImports() {
    return this.database.prepare('SELECT import_id FROM question_imports ORDER BY created_at DESC, import_id DESC').all()
      .map(row => this.getQuestionImport(row.import_id));
  }

  close() { this.database.close(); }
}

export function sqliteStorage(directory, expectedKind) {
  return storageForDirectory(directory, expectedKind);
}

async function names(directory) {
  try { return await readdir(directory, { withFileTypes: true }); }
  catch (cause) { if (cause.code === 'ENOENT') return []; throw cause; }
}

async function readVersionedJson(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (cause) { throw storageError('integrity_error', `版本化题库文件无法读取：${path.basename(filename)}（${cause.message}）`); }
}

function validateQuestionIndex(index) {
  if (index?.schemaVersion !== 1 || !Array.isArray(index.entries)) {
    throw storageError('integrity_error', '选题依据清单无效。');
  }
  const ids = new Set();
  for (const annotation of index.entries) {
    if (!annotation || typeof annotation.questionId !== 'string' || ids.has(annotation.questionId)) {
      throw storageError('integrity_error', '选题依据包含无效或重复身份。');
    }
    ids.add(annotation.questionId);
  }
}

function validateChapters(config) {
  if (config?.schemaVersion !== 1 || !Array.isArray(config.chapters) || config.chapters.some(chapter =>
    !chapter || typeof chapter.id !== 'string' || !chapter.id || typeof chapter.label !== 'string' || !chapter.label.trim())
    || new Set(config.chapters.map(chapter => chapter.id)).size !== config.chapters.length) {
    throw storageError('integrity_error', '章节目录无效。');
  }
}

function validateCurriculum(textbooks, knowledge, catalogMap, bodyMap) {
  if (textbooks?.schemaVersion !== 1 || !Array.isArray(textbooks.books)
      || textbooks.books.some(book => !book?.id || !book?.title || !Array.isArray(book.chapters))) {
    throw storageError('integrity_error', '教材目录无效。');
  }
  const chapterIds = textbooks.books.flatMap(book => book.chapters.map(chapter => chapter.id));
  const sections = textbooks.books.flatMap(book => book.chapters.flatMap(chapter => chapter.sections ?? []));
  if (new Set(textbooks.books.map(book => book.id)).size !== textbooks.books.length
      || new Set(chapterIds).size !== chapterIds.length
      || new Set(sections.map(section => section.id)).size !== sections.length) {
    throw storageError('integrity_error', '教材目录包含重复身份。');
  }
  if (knowledge?.schemaVersion !== 1 || !Array.isArray(knowledge.knowledgePoints)
      || new Set(knowledge.knowledgePoints.map(point => point.uid)).size !== knowledge.knowledgePoints.length) {
    throw storageError('integrity_error', '知识点目录无效。');
  }
  if (catalogMap?.schemaVersion !== 1 || !Array.isArray(catalogMap.evidenceRecords)
      || !Array.isArray(catalogMap.questionMappings)
      || bodyMap?.schemaVersion !== 1 || !Array.isArray(bodyMap.sectionMappings)
      || !Array.isArray(bodyMap.mappings) || !Array.isArray(bodyMap.knowledgeRelations)) {
    throw storageError('integrity_error', '教材知识映射无效。');
  }
  const knownSections = new Set(sections.map(section => section.id));
  const knownKnowledge = new Set(knowledge.knowledgePoints.map(point => point.uid));
  if (bodyMap.sectionMappings.some(mapping => !knownSections.has(mapping.sectionId)
      || mapping.knowledgeUids?.some(uid => !knownKnowledge.has(uid)))) {
    throw storageError('integrity_error', '小节知识映射引用了未知身份。');
  }
}

function questionSectionAliases(config, textbooks) {
  const sections = textbooks.books.flatMap(book => book.chapters.flatMap(chapter => chapter.sections ?? []));
  return new Map(config.chapters.map(legacy => {
    const expectedTitle = legacy.label.replace(new RegExp(`^${legacy.id.replaceAll('.', '\\.') }\\s*`), '').trim();
    const matches = sections.filter(section => section.number === legacy.id && section.title === expectedTitle);
    if (matches.length !== 1) throw storageError('integrity_error', `旧题库小节 ${legacy.id} 无法唯一映射到教材目录。`);
    return [legacy.id, matches[0].id];
  }));
}

export async function syncQuestionBank(root, repository) {
  const resolvedRoot = path.resolve(root);
  if (questionBankStorage(resolvedRoot)) throw storageError('storage_in_use', '此题库根目录已注册，不能从另一数据库混合刷新。');
  const [ledger, index, config, listed, textbooks, knowledge, catalogMap, bodyMap, courseContext, sourceManifest, pedagogy] = await Promise.all([
    readVersionedJson(path.join(resolvedRoot, 'data', 'question-bank', 'ledger.json')),
    readVersionedJson(path.join(resolvedRoot, 'data', 'assembly', 'question-index.json')),
    readVersionedJson(path.join(resolvedRoot, 'data', 'assembly', 'task-catalog.json')),
    listQuestions({ root: resolvedRoot }),
    readVersionedJson(path.join(resolvedRoot, 'data', 'curriculum', 'textbooks.json')),
    readVersionedJson(path.join(resolvedRoot, 'data', 'curriculum', 'knowledge-points.json')),
    readVersionedJson(path.join(resolvedRoot, 'data', 'curriculum', 'textbook-knowledge-map.json')),
    readVersionedJson(path.join(resolvedRoot, 'data', 'curriculum', 'textbook-body-knowledge-map.json')),
    readVersionedJson(path.join(resolvedRoot, 'data', 'question-bank', 'course-context.json')),
    readVersionedJson(path.join(resolvedRoot, 'data', 'question-bank', 'sources.json')),
    readPedagogySeed(resolvedRoot),
  ]);
  if (!listed.ok) throw storageError(listed.error.code, listed.error.message);
  if (ledger?.schemaVersion !== 1 || !Array.isArray(ledger.entries)
      || hashContent(ledger.entries) !== hashContent(listed.entries)) {
    throw storageError('integrity_error', '题库台账在同步校验期间发生漂移。');
  }
  validateQuestionIndex(index);
  validateChapters(config);
  validateCurriculum(textbooks, knowledge, catalogMap, bodyMap);
  const sectionAliases = questionSectionAliases(config, textbooks);
  const packages = [];
  for (const entry of listed.entries.filter(item => item.status === 'ready')) {
    const loaded = await getQuestion(entry.questionId, { root: resolvedRoot,
      contentVersion: entry.contentVersion, teacherVersion: entry.teacherVersion });
    if (!loaded.ok) throw storageError(loaded.error.code, loaded.error.message);
    if (loaded.question.auditId !== entry.auditId || loaded.question.questionType !== entry.questionType) {
      throw storageError('integrity_error', '就绪题包与同步台账身份不一致。');
    }
    packages.push(loaded.question);
  }

  const syncedAt = new Date().toISOString();
  const readyIds = new Set(packages.map(question => question.questionId));
  repository.database.transaction(() => {
    const putState = repository.database.prepare(`INSERT INTO question_bank_state(kind,payload,sha256,synced_at)
      VALUES(?,?,?,?) ON CONFLICT(kind) DO UPDATE SET payload=excluded.payload,sha256=excluded.sha256,synced_at=excluded.synced_at`);
    putState.run('ledger', JSON.stringify(ledger), hashContent(ledger), syncedAt);
    putState.run('question_index', JSON.stringify(index), hashContent(index), syncedAt);
    const putConfig = repository.database.prepare(`INSERT INTO question_bank_config(kind,payload,sha256,synced_at)
      VALUES(?,?,?,?) ON CONFLICT(kind) DO UPDATE SET payload=excluded.payload,sha256=excluded.sha256,synced_at=excluded.synced_at`);
    for (const [kind, value] of [['task_catalog', config], ['course_context', courseContext], ['source_manifest', sourceManifest]]) {
      putConfig.run(kind, JSON.stringify(value), hashContent(value), syncedAt);
    }
    repository.database.prepare(`INSERT INTO question_bank_pedagogy(kind,payload,sha256,synced_at) VALUES('analysis',?,?,?)
      ON CONFLICT(kind) DO UPDATE SET payload=excluded.payload,sha256=excluded.sha256,synced_at=excluded.synced_at`)
      .run(JSON.stringify(pedagogy), hashContent(pedagogy), syncedAt);

    repository.database.prepare('DELETE FROM question_bank_questions').run();
    const putQuestion = repository.database.prepare(`INSERT INTO question_bank_questions
      (question_id,payload,sha256,content_version,teacher_version,synced_at) VALUES(?,?,?,?,?,?)`);
    for (const question of packages) putQuestion.run(question.questionId, JSON.stringify(question), hashContent(question),
      question.contentVersion, question.teacherVersion, syncedAt);

    repository.database.prepare('DELETE FROM question_bank_chapters').run();
    const putChapter = repository.database.prepare(`INSERT INTO question_bank_chapters
      (chapter_id,position,payload,sha256,synced_at) VALUES(?,?,?,?,?)`);
    config.chapters.forEach((chapter, position) => putChapter.run(chapter.id, position,
      JSON.stringify(chapter), hashContent(chapter), syncedAt));

    repository.database.prepare('DELETE FROM curriculum_mapping_evidence').run();
    repository.database.prepare('DELETE FROM question_knowledge_mappings').run();
    repository.database.prepare('DELETE FROM question_section_mappings').run();
    repository.database.prepare('DELETE FROM knowledge_relations').run();
    repository.database.prepare('DELETE FROM section_knowledge_mappings').run();
    repository.database.prepare('DELETE FROM knowledge_points').run();
    repository.database.prepare('DELETE FROM curriculum_textbooks').run();

    const putTextbook = repository.database.prepare(`INSERT INTO curriculum_textbooks
      (textbook_id,position,title,volume,publisher,edition_year,source_path,source_sha256,page_count,byte_size,
       processing_status,review_status,payload,sha256,synced_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const putCurriculumChapter = repository.database.prepare(`INSERT INTO curriculum_chapters
      (chapter_id,textbook_id,position,number,title,printed_page_start,printed_page_end,pdf_page_start,pdf_page_end,
       payload,sha256,synced_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    const putSection = repository.database.prepare(`INSERT INTO curriculum_sections
      (section_id,chapter_id,position,number,title,optional_in_contents,printed_page_start,printed_page_end,
       pdf_page_start,pdf_page_end,payload,sha256,synced_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    textbooks.books.forEach((book, bookPosition) => {
      putTextbook.run(book.id, bookPosition, book.title, book.volume, book.publisher, book.editionYear,
        book.source.path, book.source.sha256, book.source.pageCount, book.source.byteSize,
        book.processing.status, book.processing.reviewStatus, JSON.stringify(book), hashContent(book), syncedAt);
      book.chapters.forEach((chapter, chapterPosition) => {
        putCurriculumChapter.run(chapter.id, book.id, chapterPosition, chapter.number ?? null, chapter.title,
          chapter.printedPageStart ?? null, chapter.printedPageEnd ?? null, chapter.pdfPageStart ?? null,
          chapter.pdfPageEnd ?? null, JSON.stringify(chapter), hashContent(chapter), syncedAt);
        (chapter.sections ?? []).forEach((section, sectionPosition) => putSection.run(section.id, chapter.id,
          sectionPosition, section.number ?? null, section.title, section.optionalInContents ? 1 : 0,
          section.printedPageStart ?? null, section.printedPageEnd ?? null, section.pdfPageStart ?? null,
          section.pdfPageEnd ?? null, JSON.stringify(section), hashContent(section), syncedAt));
      });
    });

    const putKnowledge = repository.database.prepare(`INSERT INTO knowledge_points
      (knowledge_uid,parent_uid,name,is_leaf,definition,metadata_json,payload,sha256,synced_at)
      VALUES(?,?,?,?,?,?,?,?,?)`);
    for (const point of knowledge.knowledgePoints) putKnowledge.run(point.uid, point.parent_uid ?? null, point.name,
      point.is_leaf ? 1 : 0, point.definition ?? null, JSON.stringify(point.metadata_json ?? {}),
      JSON.stringify(point), hashContent(point), syncedAt);

    const bodyByUid = new Map(bodyMap.mappings.map(mapping => [mapping.uid, mapping]));
    const putSectionKnowledge = repository.database.prepare(`INSERT INTO section_knowledge_mappings
      (section_id,knowledge_uid,relation,status,review_status,payload,sha256,synced_at) VALUES(?,?,?,?,?,?,?,?)`);
    for (const sectionMapping of bodyMap.sectionMappings) {
      for (const uid of sectionMapping.knowledgeUids) {
        const body = bodyByUid.get(uid);
        const payload = { sectionId: sectionMapping.sectionId, knowledgeUid: uid,
          relation: body?.relation ?? null, status: body?.status ?? sectionMapping.status,
          reviewStatus: body?.reviewStatus ?? sectionMapping.reviewStatus, summary: sectionMapping.summary };
        putSectionKnowledge.run(sectionMapping.sectionId, uid, body?.relation ?? null,
          body?.status ?? sectionMapping.status, body?.reviewStatus ?? sectionMapping.reviewStatus,
          JSON.stringify(payload), hashContent(payload), syncedAt);
      }
    }

    const putRelation = repository.database.prepare(`INSERT OR REPLACE INTO knowledge_relations
      (source_uid,target_uid,relation_type,status,payload,sha256,synced_at) VALUES(?,?,?,?,?,?,?)`);
    for (const relation of bodyMap.knowledgeRelations) {
      const relationType = relation.type ?? relation.relationType;
      putRelation.run(relation.sourceUid, relation.targetUid, relationType, relation.status,
        JSON.stringify(relation), hashContent(relation), syncedAt);
    }

    const putQuestionSection = repository.database.prepare(`INSERT INTO question_section_mappings
      (question_id,section_id,raw_section_id,position) VALUES(?,?,?,?)`);
    for (const annotation of index.entries.filter(item => readyIds.has(item.questionId))) {
      annotation.primarySections.forEach((rawSectionId, position) => {
        const sectionId = sectionAliases.get(rawSectionId);
        if (!sectionId) throw storageError('integrity_error', `题目 ${annotation.questionId} 引用了未映射小节 ${rawSectionId}。`);
        putQuestionSection.run(annotation.questionId, sectionId, rawSectionId, position);
      });
    }

    const putQuestionKnowledge = repository.database.prepare(`INSERT OR IGNORE INTO question_knowledge_mappings
      (question_id,knowledge_uid,topic,status,basis,payload,sha256,synced_at) VALUES(?,?,?,?,?,?,?,?)`);
    for (const questionMapping of catalogMap.questionMappings.filter(item => readyIds.has(item.questionId))) {
      for (const topic of questionMapping.primaryTopics ?? []) {
        for (const uid of topic.suggestedKpUids ?? []) putQuestionKnowledge.run(questionMapping.questionId, uid,
          topic.topic, topic.status, topic.basis ?? null, JSON.stringify(topic), hashContent(topic), syncedAt);
      }
    }

    const putEvidence = repository.database.prepare(`INSERT INTO curriculum_mapping_evidence
      (evidence_id,mapping_type,source_id,target_id,status,payload,sha256,synced_at) VALUES(?,?,?,?,?,?,?,?)`);
    for (const evidence of catalogMap.evidenceRecords) putEvidence.run(evidence.id, 'legacy_knowledge_mapping',
      evidence.sourceId ?? null, evidence.kpUid ?? null, evidence.status ?? null,
      JSON.stringify(evidence), hashContent(evidence), syncedAt);
    for (const mapping of bodyMap.mappings) (mapping.evidence ?? []).forEach((evidence, position) => {
      const id = `body:${mapping.uid}:${position}`;
      putEvidence.run(id, 'textbook_body_location', evidence.localTextPath ?? null, mapping.uid,
        mapping.status ?? null, JSON.stringify(evidence), hashContent(evidence), syncedAt);
    });
  }).immediate();
  return { readyQuestions: packages.length, annotations: index.entries.length, chapters: config.chapters.length,
    textbooks: textbooks.books.length,
    curriculumChapters: textbooks.books.reduce((total, book) => total + book.chapters.length, 0),
    curriculumSections: textbooks.books.reduce((total, book) => total
      + book.chapters.reduce((count, chapter) => count + (chapter.sections?.length ?? 0), 0), 0),
    questionSectionMappings: index.entries.filter(item => readyIds.has(item.questionId))
      .reduce((total, item) => total + item.primarySections.length, 0),
  };
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

async function importLegacyQuestionImports(baseRoot, repository) {
  const recordsRoot = path.join(baseRoot, 'question-imports', 'records');
  const filesRoot = path.join(baseRoot, 'question-imports', 'files');
  const report = { imported: 0, skipped: 0, warnings: [] };
  for (const entry of await names(recordsRoot)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filename = path.join(recordsRoot, entry.name);
    try {
      const record = JSON.parse(await readFile(filename, 'utf8'));
      validateQuestionImport(record);
      if (repository.getQuestionImport(record.importId)) { report.skipped++; continue; }
      const sourceBytes = await readFile(path.join(filesRoot, `${record.importId}${record.source.extension}`));
      repository.putQuestionImport(record, { bytes: sourceBytes, sha256: record.source.sha256,
        filename: record.source.filename, mimeType: record.source.mimeType });
      report.imported++;
    } catch (cause) {
      report.warnings.push({ kind: 'question-imports', id: entry.name.slice(0, -5), sourcePath: filename,
        code: cause.code ?? 'read_error', message: `旧试卷解析文件保留原处，未导入：${cause.message}` });
    }
  }
  return report;
}

export async function registerSqliteStorage(baseRoot, databasePath, { questionBankRoot } = {}) {
  const resolved = path.resolve(baseRoot);
  if (registeredStorage(resolved)) throw storageError('storage_in_use', '此存储目录已注册。');
  if (questionBankRoot && questionBankStorage(questionBankRoot)) throw storageError('storage_in_use', '此题库根目录已注册。');
  const resolvedDatabasePath = databasePath === undefined ? path.join(resolved, 'tutor.sqlite')
    : path.isAbsolute(databasePath) ? databasePath : path.join(resolved, databasePath);
  await mkdir(path.dirname(resolvedDatabasePath), { recursive: true });
  const repository = new SqliteRepository(resolvedDatabasePath);
  try {
    const migration = await importLegacyStorage(resolved, repository);
    migration.questionImports = await importLegacyQuestionImports(resolved, repository);
    let questionBank = null;
    if (questionBankRoot) {
      const ledger = repository.getQuestionBankLedger();
      if (!ledger) questionBank = await syncQuestionBank(questionBankRoot, repository);
      else {
        // Upgrade older SQLite snapshots once without replacing database-owned question content.
        const configKinds = [['task_catalog', 'assembly/task-catalog.json'],
          ['course_context', 'question-bank/course-context.json'], ['source_manifest', 'question-bank/sources.json']];
        const missing = configKinds.filter(([kind]) => !repository.getQuestionBankConfig(kind));
        const values = await Promise.all(missing.map(async ([kind, filename]) => [kind,
          await readVersionedJson(path.join(questionBankRoot, 'data', filename))]));
        if (values.length) repository.database.transaction(() => {
          const insert = repository.database.prepare(`INSERT INTO question_bank_config(kind,payload,sha256,synced_at) VALUES(?,?,?,?)`);
          for (const [kind, value] of values) insert.run(kind, JSON.stringify(value), hashContent(value), new Date().toISOString());
        }).immediate();
        if (!repository.getQuestionBankIndex()) throw storageError('integrity_error', 'SQLite 选题依据清单缺失。');
        if (!repository.getQuestionBankPedagogy()) {
          const pedagogy = await readPedagogySeed(questionBankRoot);
          repository.database.prepare(`INSERT INTO question_bank_pedagogy(kind,payload,sha256,synced_at) VALUES('analysis',?,?,?)`)
            .run(JSON.stringify(pedagogy), hashContent(pedagogy), new Date().toISOString());
        }
        questionBank = repository.getQuestionBankSummary();
      }
      repository.database.prepare(`INSERT OR IGNORE INTO schema_migrations VALUES(7, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run();
    }
    registerStorage(resolved, repository);
    if (questionBankRoot) registerQuestionBank(questionBankRoot, repository);
    return { repository, migration, questionBank,
      close() {
        unregisterStorage(resolved);
        if (questionBankRoot) unregisterQuestionBank(questionBankRoot);
        repository.close();
      } };
  } catch (cause) { repository.close(); throw cause; }
}
