import { config } from 'dotenv';
import Database from 'better-sqlite3';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { createDifficultyReviewGateway, validateDifficultyReview } from '../src/llm/difficulty-review-gateway.mjs';
import { unknownDifficultyInputs, applyDifficultyReviews } from '../src/question-bank/difficulty-review.mjs';
import { hashContent } from '../src/question-bank/integrity.mjs';

config({ quiet: true });
const args = process.argv.slice(2), option = key => args[args.indexOf(key) + 1];
if (!args.includes('--database') || !args.includes('--evidence-dir')) throw new Error('Required: --database PATH --evidence-dir PATH [--apply]');
const directory = path.resolve(option('--evidence-dir'));
await mkdir(directory, { recursive: true });
const db = new Database(path.resolve(option('--database')), { fileMustExist: true });
db.pragma('busy_timeout = 10000');
try {
  const questions = unknownDifficultyInputs(db), gateway = createDifficultyReviewGateway();
  if (!gateway.configured && questions.length) throw new Error('Configured model required.');
  const batches = Array.from({ length: Math.ceil(questions.length / 5) }, (_, n) => ({ questions: questions.slice(n * 5, n * 5 + 5) }));
  const records = []; let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, batches.length) }, async () => {
    while (next < batches.length) {
      const n = next++, input = batches[n], inputSha256 = hashContent(input), filename = path.join(directory, `${inputSha256}.json`);
      let record;
      try {
        const saved = JSON.parse(await readFile(filename, 'utf8'));
        if (saved.inputSha256 === inputSha256 && hashContent(saved.input) === inputSha256 && saved.result?.ok && saved.result.run.status === 'succeeded') {
          validateDifficultyReview(saved.result.proposal, input); record = saved;
        }
      } catch {}
      if (!record) {
        const result = await gateway.propose(input, { validate: proposal => validateDifficultyReview(proposal, input) });
        record = { inputSha256, input, result };
        const temporary = `${filename}.tmp`;
        await writeFile(temporary, JSON.stringify(record, null, 2)); await rename(temporary, filename);
      }
      records.push(record);
      console.log(JSON.stringify({ batch: n + 1, total: batches.length, status: record.result.run.status,
        durationMs: record.result.run.durationMs, provider: record.result.run.provider, model: record.result.run.model }));
    }
  }));
  const failures = records.filter(record => !record.result.ok);
  const successful = records.filter(record => record.result.ok);
  const applied = args.includes('--apply') ? applyDifficultyReviews(db, successful) : null;
  const summary = { reviewedAt: new Date().toISOString(), candidateCount: questions.length, batchCount: batches.length,
    failedBatches: failures.length, model: gateway.publicStatus(), applied,
    outcomes: successful.flatMap(record => record.result.proposal.questions.map(q => ({ questionId: q.questionId, level: q.level, rationale: q.rationale }))),
    remainingUnknown: unknownDifficultyInputs(db).length };
  await writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, outcomes: undefined, applied: applied && { changed: applied.changes.length, skipped: applied.skipped.length } }));
  if (failures.length) process.exitCode = 1;
} finally { db.close(); }
