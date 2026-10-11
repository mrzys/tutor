import { config } from 'dotenv';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteRepository, syncQuestionBank } from '../src/storage/sqlite.mjs';

config({ quiet: true });
const root = fileURLToPath(new URL('../', import.meta.url));
const storageRoot = path.resolve(process.env.TUTOR_STORAGE_ROOT || path.join(root, '.tutor'));
const databasePath = process.env.TUTOR_DATABASE_PATH || 'tutor.sqlite';
const filename = path.isAbsolute(databasePath) ? databasePath : path.join(storageRoot, databasePath);
await mkdir(path.dirname(filename), { recursive: true });
const repository = new SqliteRepository(filename);
try {
  const result = await syncQuestionBank(root, repository);
  console.log(JSON.stringify({ database: filename, ...result }, null, 2));
} finally { repository.close(); }
