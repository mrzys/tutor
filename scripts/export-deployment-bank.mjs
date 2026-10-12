import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { SqliteRepository } from '../src/storage/sqlite.mjs';

const [sourcePath, targetPath] = process.argv.slice(2).map(value => path.resolve(value));
if (!sourcePath || !targetPath || sourcePath === targetPath) throw new Error('Usage: node scripts/export-deployment-bank.mjs SOURCE.sqlite NEW_TARGET.sqlite');
try { await access(targetPath); throw new Error('Target already exists; refusing to overwrite it.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const tables = [
  'question_bank_state', 'question_bank_config', 'question_bank_questions', 'question_bank_chapters',
  'curriculum_textbooks', 'curriculum_chapters', 'curriculum_sections', 'knowledge_points',
  'section_knowledge_mappings', 'knowledge_relations', 'question_section_mappings',
  'question_knowledge_mappings', 'curriculum_mapping_evidence', 'question_bank_pedagogy',
  'question_imports', 'question_import_publications', 'question_import_published_items', 'question_bank_promotions',
];
const temporary = await mkdtemp(path.join(os.tmpdir(), 'tutor-bank-export-'));
let target;
try {
  const source = new Database(sourcePath, { readonly: true });
  try { await source.backup(path.join(temporary, 'snapshot.sqlite')); } finally { source.close(); }
  await mkdir(path.dirname(targetPath), { recursive: true });
  target = new SqliteRepository(targetPath).database;
  target.prepare('ATTACH DATABASE ? AS source').run(path.join(temporary, 'snapshot.sqlite'));
  target.transaction(() => {
    for (const table of tables) {
      // Some bank audit tables are created by explicit publication scripts.
      if (!target.prepare('SELECT 1 FROM main.sqlite_master WHERE type=? AND name=?').get('table', table)) {
        const definition = target.prepare('SELECT sql FROM source.sqlite_master WHERE type=? AND name=?').get('table', table);
        if (definition) target.exec(definition.sql);
        else continue;
      }
      if (target.prepare('SELECT 1 FROM source.sqlite_master WHERE type=? AND name=?').get('table', table)) target.exec(`INSERT INTO main.${table} SELECT * FROM source.${table}`);
    }
  }).immediate();
  target.exec('DETACH DATABASE source');
  if (target.pragma('foreign_key_check').length) throw new Error('Foreign key validation failed.');
  if (target.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Integrity validation failed.');
  target.pragma('wal_checkpoint(TRUNCATE)');
  console.log(JSON.stringify({ targetPath, tables: Object.fromEntries([...tables, 'users', 'auth_sessions', 'documents', 'intake_sessions', 'llm_runs', 'resource_owners'].map(table => [table, target.prepare('SELECT 1 FROM sqlite_master WHERE type=? AND name=?').get('table', table) ? target.prepare(`SELECT count(*) AS count FROM ${table}`).get().count : 0])) }, null, 2));
} finally {
  target?.close();
  await rm(temporary, { recursive: true, force: true });
}
