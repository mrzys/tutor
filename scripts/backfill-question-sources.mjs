/** Dry-run first. Apply backs up the database and only updates question source metadata.
 * node scripts/backfill-question-sources.mjs --database=... --legacy=... [--apply] [--report=...]
 */
import Database from 'better-sqlite3';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hashContent } from '../src/question-bank/integrity.mjs';
import { planSourceBackfill } from '../src/question-bank/source-backfill.mjs';

const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
if (!arg('database') || !arg('legacy')) throw new Error('需显式指定 --database 和 --legacy 路径。');
const apply = process.argv.includes('--apply');
const databasePath = path.resolve(arg('database'));
const db = new Database(databasePath, { readonly: !apply, fileMustExist: true });
try {
  const legacy = JSON.parse(await readFile(path.resolve(arg('legacy')), 'utf8'));
  const rows = db.prepare('SELECT question_id,payload,sha256 FROM question_bank_questions').all();
  const questions = rows.map(row => {
    const question = JSON.parse(row.payload);
    if (question.questionId !== row.question_id || hashContent(question) !== row.sha256) throw new Error('现有题目哈希校验失败，停止回填。');
    return question;
  });
  const plan = planSourceBackfill(questions, legacy);
  if (plan.conflicts.length) throw new Error(`已有来源冲突，未修改：${plan.conflicts.join('、')}`);
  let backup;
  if (apply && plan.changes.length) {
    backup = `${databasePath}.before-source-backfill-${Date.now()}.sqlite`;
    await db.backup(backup);
    db.transaction(() => {
      const update = db.prepare('UPDATE question_bank_questions SET payload=?,sha256=? WHERE question_id=? AND sha256=?');
      for (const change of plan.changes) {
        const result = update.run(JSON.stringify(change.question), change.afterHash, change.questionId, change.beforeHash);
        if (result.changes !== 1) throw new Error('题目发生并发修改，回填已回滚。');
      }
    })();
  }
  const report = { applied: apply, databasePath, backup, observedAt: new Date().toISOString(), legacyObservedAt: legacy.observedAt,
    total: questions.length, changed: plan.changes.length, unchanged: plan.unchanged.length, unmatched: plan.unmatched,
    changes: plan.changes.map(({ questionId, sourceTitle, sourceQuestionNumber, beforeHash, afterHash }) => ({ questionId, sourceTitle, sourceQuestionNumber, beforeHash, afterHash })) };
  if (arg('report')) await writeFile(path.resolve(arg('report')), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, changes: report.changes.slice(0, 4) }, null, 2));
} finally { db.close(); }
