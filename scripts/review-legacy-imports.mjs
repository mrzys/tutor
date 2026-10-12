import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import katex from 'katex';

const directory = path.resolve(process.argv[2] ?? '.tutor/chapter12-expansion');
const manifest = JSON.parse(await readFile(path.join(directory, 'source-manifest.json'), 'utf8'));
const sources = new Map(manifest.questions.map(item => [item.question_id, item]));
// Formatting equivalences only: comparisons do not solve mathematics or certify legacy answers.
export function normalizeMath(value) {
  return String(value ?? '').normalize('NFKC')
    .replace(/\\(?:left|right|displaystyle|textstyle|quad|qquad|,|;|!)/g, '')
    .replace(/\\(?:leqslant|leq|le)\b|≤/g, '<=')
    .replace(/\\(?:geqslant|geq|ge)\b|≥/g, '>=')
    .replace(/\\(?:ne|neq)\b|≠/g, '!=')
    .replace(/\\(?:cdot|times)\b|[×·]/g, '*')
    .replace(/\\(?:dfrac|tfrac)\b/g, '\\frac')
    .replace(/\\mid\b/g, '|')
    .replace(/[−–]/g, '-')
    .replace(/[\s$，。；：、,;:]/g, '')
    .replace(/\\[()[\]]/g, '').replace(/\\[{}]/g, '')
    .replace(/[{}]/g, '').replace(/(?:[.。]|\(\))*$/g, '');
}
const reviews = [], failures = [];
for (const filename of (await readdir(path.join(directory, 'import-results'))).filter(name => name.endsWith('.json')).sort()) {
  const result = JSON.parse(await readFile(path.join(directory, 'import-results', filename), 'utf8'));
  if (!result.result?.ok) { failures.push({ filename, error: result.result?.error }); continue; }
  const record = result.result.import;
  for (const item of record.questions) {
    const explicitId = /旧题\s*ID\s*(\d+)/i.exec(item.sourceLabel)?.[1];
    const ordinal = Number(/第\s*(\d+)\s*题/.exec(item.sourceLabel)?.[1]);
    const sourceId = explicitId ? Number(explicitId) : result.batch.questionIds[ordinal - 1];
    const source = sources.get(sourceId);
    const issues = [];
    if (!source || !result.batch.questionIds.includes(sourceId)) issues.push('source_identity_mismatch');
    if (source) {
      if (normalizeMath(source.body) !== normalizeMath(item.student.stem)) issues.push('stem_diff');
      const options = Object.entries(source.options);
      if (options.length !== item.student.options.length || options.some(([label, text]) =>
        normalizeMath(text) !== normalizeMath(item.student.options.find(option => option.label === label)?.text))) issues.push('option_diff');
      if (item.questionType === 'single_choice') {
        const expected = source.answers.find(answer => answer.data?.selections?.length)?.data.selections.join('')
          ?? source.answers.find(answer => answer.data?.text)?.data.text;
        if (normalizeMath(expected) !== normalizeMath(item.teacher.answers.map(answer => answer.text).join(''))) issues.push('answer_diff');
      }
      if (source.parts.length !== item.student.parts.length) issues.push('parts_diff');
    }
    if ([6840, 8208, 6132].includes(sourceId)) issues.push('independent_review_hold');
    if ([6151, 5682].includes(sourceId)) issues.push('semantic_duplicate');
    for (const value of [item.student.stem, ...item.student.options.map(option => option.text), ...item.student.parts.map(part => part.prompt)]) {
      for (const match of value.matchAll(/\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g)) {
        try { katex.renderToString(match[1] ?? match[2], { throwOnError: true, strict: false, trust: false }); }
        catch { if (!issues.includes('formula_render_error')) issues.push('formula_render_error'); }
      }
    }
    reviews.push({ filename, importId: record.importId, stagingQuestionId: item.stagingQuestionId,
      sourceQuestionId: sourceId, sourceContentVersionId: source?.content_version_id,
      issues, difficulty: item.dimensions.difficultySuggestion,
      assessmentTask: item.dimensions.assessmentTask ?? null,
      sourceComparison: issues.filter(issue => issue !== 'independent_review_hold').length === 0,
      note: '题干/选项/单选答案/小问数做格式归一后比对；解析语义及数学正确性另行抽样，不由此自动认证。' });
  }
}
const output = { observedAt: new Date().toISOString(), imported: reviews.length, failures,
  exactFormattingMatches: reviews.filter(item => item.sourceComparison).length,
  issueCounts: Object.fromEntries([...new Set(reviews.flatMap(item => item.issues))].map(issue => [issue, reviews.filter(item => item.issues.includes(issue)).length])), reviews };
await writeFile(path.join(directory, 'source-comparison-review.json'), JSON.stringify(output, null, 2));
console.log(JSON.stringify({ imported: output.imported, exactFormattingMatches: output.exactFormattingMatches, issueCounts: output.issueCounts, failures: failures.length }));
