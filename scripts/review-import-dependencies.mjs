import { config } from 'dotenv';
import Database from 'better-sqlite3';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createDependencyReviewGateway } from '../src/llm/dependency-review-gateway.mjs';
import { hashContent } from '../src/question-bank/integrity.mjs';

config({ quiet: true });
const directory = path.resolve('.tutor/chapter12-expansion/dependency-reviews');
await mkdir(directory, { recursive: true });
const db = new Database(path.resolve('.tutor/chapter12-expansion/import-storage/tutor.sqlite'));
try {
  const sections = db.prepare('SELECT section_id AS id,title AS label FROM curriculum_sections').all();
  const validIds = new Set(sections.map(item => item.id));
  const index = JSON.parse(db.prepare("SELECT payload FROM question_bank_state WHERE kind='question_index'").get().payload);
  const questions = db.prepare("SELECT payload FROM question_bank_questions WHERE question_id LIKE 'tutor-import-%' ORDER BY question_id").all().map(row => JSON.parse(row.payload));
  const gateway = createDependencyReviewGateway();
  const batches = Array.from({ length: Math.ceil(questions.length / 8) }, (_, n) => questions.slice(n * 8, n * 8 + 8));
  let next = 0;
  const results = [];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < batches.length) {
      const n = next++, batch = batches[n];
      const input = { trustedSections: sections, questions: batch.map(({ questionId, student, teacher, scopeEvidence }) => ({ questionId, student, teacher, allowedSolution: scopeEvidence.allowedSolution })) };
      const inputSha256 = hashContent(input), filename = path.join(directory, `${String(n + 1).padStart(3, '0')}.json`);
      let result;
      try { const cached = JSON.parse(await readFile(filename, 'utf8')); if (cached.inputSha256 === inputSha256 && cached.result.ok) result = cached.result; } catch {}
      const validate = (proposal, sourceInput = input) => {
        if (proposal.questions.length !== sourceInput.questions.length || new Set(proposal.questions.map(item => item.questionId)).size !== sourceInput.questions.length) throw new Error('逐题覆盖不完整或题号重复');
        for (const item of proposal.questions) {
          const q = sourceInput.questions.find(value => value.questionId === item.questionId);
          if (!q) throw new Error('题号不在当前批次');
          const texts = [q.student.stem, ...q.student.options.map(value => value.text), ...q.student.parts.map(value => value.prompt), ...q.teacher.solutions.map(value => value.text), q.allowedSolution ?? ''];
          for (const dep of item.dependencies) {
            if (!validIds.has(dep.sectionId)) throw new Error('章节ID不在真实教材目录中');
            if (!texts.some(value => value.includes(dep.quote))) throw new Error(`原文引用必须逐字来自题目或解析，不可改写: ${dep.quote.slice(0, 100)}`);
          }
          if (item.status === 'complete' && !item.dependencies.length) throw new Error('完整路径至少需要一个高中主考知识依赖');
        }
      };
      if (!result) result = await gateway.propose(input, { validate });
      if (!result.ok) {
        const singles = [];
        for (const question of input.questions) {
          const singleInput = { trustedSections: sections, questions: [question] };
          const single = await gateway.propose(singleInput, { validate: proposal => validate(proposal, singleInput) });
          singles.push({ questionId: question.questionId, ...single });
        }
        const initialRun = result.run;
        result = { ok: true, proposal: { questions: singles.map(single => single.proposal?.questions[0] ?? {
          questionId: single.questionId, status: 'unknown', dependencies: [], explanation: '单题模型复核失败，完整依赖保持未知。',
        }) }, run: { ...initialRun, status: singles.every(single => single.ok) ? 'succeeded_individual_retry' : 'partial_failure',
          initialRun, individualRuns: singles.map(({ questionId, run }) => ({ questionId, run })) } };
      }
      if (result.ok) validate(result.proposal);
      await writeFile(filename, JSON.stringify({ inputSha256, questionIds: batch.map(q => q.questionId), result }, null, 2));
      results.push({ n, inputSha256, result });
      console.log(JSON.stringify({ batch: n + 1, total: batches.length, status: result.run.status, milliseconds: result.run.durationMs }));
    }
  }));
  const now = new Date().toISOString();
  const outcomes = new Map(results.flatMap(batch => (batch.result.proposal?.questions ?? []).map(item => [item.questionId, { item, run: batch.result.run, inputSha256: batch.inputSha256 }])));
  const changes = [];
  const chapters = db.prepare('SELECT chapter_id,payload FROM question_bank_chapters').all().map(row => JSON.parse(row.payload));
  const canonical = id => {
    const section = sections.find(item => item.id === id);
    const legacy = id.startsWith('rja-compulsory-1:') && chapters.find(chapter => chapter.id === id.split(':')[1] && chapter.label === section?.label);
    return legacy?.id ?? chapters.find(chapter => chapter.textbookSectionId === id)?.id ?? id;
  };
  for (const q of questions) {
    const annotation = index.entries.find(item => item.questionId === q.questionId);
    const outcome = outcomes.get(q.questionId);
    const previous = structuredClone(annotation.dependencyReview?.previousSolutionPaths ?? annotation.solutionPaths);
    if (outcome?.item.status === 'complete') {
      annotation.solutionPaths = previous.map(item => ({ ...item, requiredSections: [...new Set([...item.requiredSections, ...outcome.item.dependencies.map(dep => canonical(dep.sectionId))])] }));
    } else annotation.solutionPaths = [];
    annotation.dependencyReview = { method: 'llm_dependency_audit', status: outcome?.item.status ?? 'unknown', reviewedAt: now,
      contentVersion: q.contentVersion, teacherVersion: q.teacherVersion, sourceQuestionId: q.verification.origin.sourceQuestionId,
      inputSha256: outcome?.inputSha256 ?? null, run: outcome?.run ?? null,
      evidence: outcome?.item.dependencies ?? [], explanation: outcome?.item.explanation ?? '模型复核失败，完整依赖保持未知。',
      previousSolutionPaths: previous, independentMathematicalVerification: false };
    changes.push({ questionId: q.questionId, sourceQuestionId: q.verification.origin.sourceQuestionId,
      status: annotation.dependencyReview.status, before: previous.flatMap(item => item.requiredSections), after: annotation.solutionPaths.flatMap(item => item.requiredSections) });
  }
  db.transaction(() => {
    for (const section of sections.filter(item => canonical(item.id) !== item.id)) {
      db.prepare('DELETE FROM question_bank_chapters WHERE chapter_id=?').run(section.id);
    }
    let position = db.prepare('SELECT coalesce(max(position),-1)+1 AS n FROM question_bank_chapters').get().n;
    const missing = new Set(index.entries.flatMap(item => item.solutionPaths.flatMap(value => value.requiredSections)).filter(id => !chapters.some(item => item.id === id)));
    for (const id of missing) {
      const section = sections.find(item => item.id === id);
      if (!section) throw new Error(`Unknown dependency section: ${id}`);
      const payload = { id, label: section.label, textbookSectionId: id };
      db.prepare('INSERT INTO question_bank_chapters VALUES(?,?,?,?,?)').run(id, position++, JSON.stringify(payload), hashContent(payload), now);
    }
    db.prepare("UPDATE question_bank_state SET payload=?,sha256=?,synced_at=? WHERE kind='question_index'").run(JSON.stringify(index), hashContent(index), now);
  }).immediate();
  const summary = { reviewedAt: now, questions: questions.length, complete: changes.filter(item => item.status === 'complete').length,
    unknown: changes.filter(item => item.status !== 'complete').length,
    expanded: changes.filter(item => item.after.some(id => !item.before.includes(id))).length, changes };
  await writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, changes: undefined }));
} finally { db.close(); }
