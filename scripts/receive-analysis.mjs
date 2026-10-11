import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { receiveAnalysisSubmission } from '../src/assembly/teaching-goals.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const inputPath = process.argv[2];
  if (!inputPath || process.argv.length !== 3) throw new Error('用法：npm run analysis:receive -- <分析提交.json>');
  const submission = receiveAnalysisSubmission(JSON.parse(await readFile(path.resolve(inputPath), 'utf8')));
  const directory = path.join(root, '.tutor', 'analysis-submissions');
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${randomUUID()}.json`);
  await writeFile(target, `${JSON.stringify(submission, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  console.log(JSON.stringify({ path: target, reviewStatus: submission.reviewStatus, matchingEligible: false,
    message: '仅接收待复核原始结果；未改变题包、就绪台账或选题支持结论。' }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
