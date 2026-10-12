import { config } from 'dotenv';
import { createNestApp } from '../src/api/app.ts';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Real authenticated upload API. Isolated storage keeps the teacher's accounts and drafts untouched.
config({ quiet: true });
const arg = name => process.argv.find(item => item.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const directory = path.resolve(arg('directory') ?? '.tutor/chapter12-expansion');
const manifest = JSON.parse(await readFile(path.join(directory, 'source-manifest.json'), 'utf8'));
const limit = Number(arg('limit') ?? manifest.batches.length);
const offset = Number(arg('offset') ?? 0);
const concurrency = Math.max(1, Math.min(4, Number(arg('concurrency') ?? 3)));
const resultsRoot = path.join(directory, 'import-results');
await mkdir(resultsRoot, { recursive: true });
const app = await createNestApp({ storeRoot: path.join(directory, 'import-storage', 'drafts'), logger: false });
await app.app.listen(0, '127.0.0.1');
const base = await app.app.getUrl();
let cookie;
async function request(route, input) {
  const response = await fetch(base + route, { ...(input ? { method: 'POST', body: JSON.stringify(input) } : {}),
    headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}) } });
  if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return { status: response.status, result: await response.json() };
}
try {
  const credentials = { email: 'chapter-import@example.test', password: 'Isolated-import-QA-2026!' };
  let auth = await request('/api/auth/register', credentials);
  if (!auth.result.ok) auth = await request('/api/auth/login', credentials);
  if (!auth.result.ok) throw new Error('Isolated import authentication failed');
  const configuration = await request('/api/config');
  console.log(JSON.stringify({ event: 'configured', model: configuration.result.config.questionImport,
    batches: limit, concurrency, database: path.join(directory, 'import-storage', 'tutor.sqlite') }));
  const queue = manifest.batches.slice(offset, offset + limit);
  async function worker() {
    while (queue.length) {
      const batch = queue.shift();
      const filename = path.join(resultsRoot, batch.filename.replace(/\.md$/, '.json'));
      try { if (JSON.parse(await readFile(filename, 'utf8')).result?.ok) {
        console.log(JSON.stringify({ event: 'resumed', filename: batch.filename })); continue;
      } } catch {}
      const startedAt = new Date().toISOString();
      const started = Date.now();
      const text = await readFile(path.join(directory, batch.filename), 'utf8');
      try {
        const response = await request('/api/question-imports', { filename: batch.filename, mimeType: 'text/markdown', text });
        const evidence = { batch, startedAt, durationMs: Date.now() - started, transport: 'authenticated Nest HTTP upload API', ...response };
        await writeFile(filename, JSON.stringify(evidence, null, 2));
        console.log(JSON.stringify({ event: 'imported', filename: batch.filename, status: response.status,
          count: response.result.import?.questions.length ?? 0, durationMs: evidence.durationMs,
          error: response.result.error, model: response.result.import?.llmRun?.model }));
      } catch (cause) {
        await writeFile(filename, JSON.stringify({ batch, startedAt, durationMs: Date.now() - started,
          result: { ok: false, error: { code: 'transport_error', message: cause.message } } }, null, 2));
        console.log(JSON.stringify({ event: 'failed', filename: batch.filename, message: cause.message }));
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
} finally { await app.close(); }
