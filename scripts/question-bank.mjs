import { getQuestion, getStudentQuestion, listQuestions } from '../src/question-bank/reader.mjs';

const [command, ...args] = process.argv.slice(2);
let result;
if (command === 'list' && !args.length) {
  result = await listQuestions();
} else if (command === 'get' && args[0] && !args[0].startsWith('--')) {
  const questionId = args.shift();
  const options = {};
  let student = false;
  let valid = true;
  while (args.length) {
    const flag = args.shift();
    if (flag === '--student' && !student) student = true;
    else if (flag === '--version' && options.contentVersion === undefined && args[0] && !args[0].startsWith('--')) options.contentVersion = args.shift();
    else if (flag === '--teacher-version' && options.teacherVersion === undefined && args[0] && !args[0].startsWith('--')) options.teacherVersion = args.shift();
    else { valid = false; break; }
  }
  if (valid) result = await (student ? getStudentQuestion : getQuestion)(questionId, options);
} else if (command === 'check' && !args.length) {
  const list = await listQuestions();
  if (!list.ok) result = list;
  else {
    const checks = [];
    for (const entry of list.entries.filter(entry => entry.status === 'ready')) {
      const check = await getQuestion(entry.questionId);
      checks.push(check.ok
        ? { questionId: entry.questionId, ok: true, contentVersion: check.question.contentVersion, teacherVersion: check.question.teacherVersion }
        : { questionId: entry.questionId, ...check });
    }
    result = { ok: checks.every(check => check.ok), totals: { ...list.totals, checked: checks.length, failed: checks.filter(check => !check.ok).length }, checks };
  }
}
if (!result) result = { ok: false, error: { code: 'usage_error', message: 'Usage: node scripts/question-bank.mjs list | get <questionId> [--version <contentVersion>] [--teacher-version <teacherVersion>] [--student] | check' } };
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = result.error?.code === 'usage_error' ? 2 : 1;
