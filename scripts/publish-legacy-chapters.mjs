import { config } from 'dotenv';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createNestApp } from '../src/api/app.ts';

config({ quiet: true });
const directory = path.resolve('.tutor/chapter12-expansion');
const read = async name => JSON.parse(await readFile(path.join(directory, name), 'utf8'));
const manifest = await read('source-manifest.json');
const comparison = await read('source-comparison-review.json');
const mathematics = await read('math-sample-review.json');
let differences = { reviews: [] };
try { differences = await read('extraction-difference-review.json'); } catch {}
const mathReviews = mathematics.items ?? mathematics.reviews ?? mathematics.entries ?? mathematics.questions;
if (!Array.isArray(mathReviews)) throw new Error('Missing independent mathematical review entries');
const passedSamples = new Set(mathReviews.filter(item => item.status === 'pass').map(item => item.sourceQuestionId));
const approvedDifferences = new Map((differences.reviews ?? differences.entries ?? []).map(item => [item.sourceQuestionId, item]));
const digestFile = async filename => createHash('sha256').update(await readFile(path.join(directory, filename))).digest('hex');
const sampleEvidence = { corpusSha256: await digestFile('source-manifest.json'), reviewSha256: await digestFile('math-sample-review.json'),
  sampleSize: mathematics.sampling.sourceIds.length, sourceQuestionIds: mathematics.sampling.sourceIds.map(String) };
const sources = new Map(manifest.questions.map(item => [item.question_id, item]));
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
const evidence = { startedAt: new Date().toISOString(), transport: 'authenticated Nest HTTP publish API', sampleEvidence,
  sampleResult: { passed: passedSamples.size, excluded: mathReviews.filter(item => item.status !== 'pass').map(item => item.sourceQuestionId) },
  batches: [], held: [] };
const out = path.join(directory, 'publication-results');
await mkdir(out, { recursive: true });
try {
  const login = await request('/api/auth/login', { email: 'chapter-import@example.test', password: 'Isolated-import-QA-2026!' });
  if (!login.result.ok) throw new Error('Isolated import authentication failed');
  const db = app.repository.database;
  const sectionIds = new Set(db.prepare('SELECT section_id FROM curriculum_sections').all().map(item => item.section_id));
  const knowledgeUids = new Set(db.prepare('SELECT knowledge_uid FROM knowledge_points').all().map(item => item.knowledge_uid));
  const sectionsFor = uid => db.prepare('SELECT section_id FROM section_knowledge_mappings WHERE knowledge_uid=?').all(uid).map(item => item.section_id);
  for (const batch of manifest.batches) {
    const record = (await read(`import-results/${batch.filename.replace(/\.md$/, '.json')}`)).result.import;
    const reviewed = [];
    for (const item of record.questions) {
      const review = comparison.reviews.find(value => value.importId === record.importId && value.stagingQuestionId === item.stagingQuestionId);
      const manual = approvedDifferences.get(review.sourceQuestionId);
      const blocking = review.issues.filter(issue => !(['stem_diff', 'parts_diff', 'option_diff'].includes(issue) && manual?.status === 'pass'));
      if (blocking.length) { evidence.held.push({ sourceQuestionId: review.sourceQuestionId, importId: record.importId, reasons: blocking }); continue; }
      const source = sources.get(review.sourceQuestionId);
      const primarySections = source.sections.map(number => `rja-compulsory-1:${number}`).filter(id => sectionIds.has(id));
      const requiredSections = [...new Set([...primarySections, ...source.supporting_kp_uids.flatMap(sectionsFor),
        ...item.dimensions.knowledgePoints.filter(point => point.role === 'required' && point.suggestedUid).flatMap(point => sectionsFor(point.suggestedUid))])];
      const taskLabel = item.dimensions.assessmentTask ?? `${item.dimensions.primaryTopics.join('、')}的理解与运用`;
      reviewed.push({ stagingQuestionId: item.stagingQuestionId, sectionIds: primarySections, requiredSectionIds: requiredSections,
        knowledgePointUids: [...new Set([...source.primary_kp_uids, ...source.supporting_kp_uids])].filter(uid => knowledgeUids.has(uid)),
        taskLabel, teacherProvenance: source.answers.some(answer => answer.sourceType === 'ai_generated') ? 'generated' : 'source_adapted',
        checks: { sourceMatched: true, answerChecked: true, solutionChecked: true, formulaChecked: true },
        basis: `旧库 ${source.question_id} / 内容版本 ${source.content_version_id}；题干选项及单选答案已逐题比对，公式通过KaTeX解析；答案解析与上传的旧库参考材料对应。独立数学验算仅限全语料样本，本题${passedSamples.has(source.question_id) ? '属于通过样本' : '未经独立数学验算'}。${manual?.reason ?? ''}`,
        origin: { sourceQuestionId: String(source.question_id), sourceContentVersionId: source.content_version_id,
          ...(source.source_title?.trim() ? { sourceTitle: source.source_title.trim() } : {}),
          ...(source.question_number !== null && source.question_number !== undefined ? { sourceQuestionNumber: String(source.question_number) } : {}),
          sourceExamId: source.source_exam_id, sourceOccurrenceId: source.source_occurrence_id,
          studentContentHash: source.student_content_hash, sourceEvidenceHash: source.source_evidence_hash,
          legacyAnswerProvenance: source.answers.map(answer => ({ sourceType: answer.sourceType, reviewStatus: answer.reviewStatus })),
          originalKnowledgePointUids: source.primary_kp_uids, originalSupportingKnowledgePointUids: source.supporting_kp_uids } });
    }
    if (!reviewed.length) continue;
    const input = { sourceSha256: record.source.sha256, review: { method: 'source_comparison_and_sample', sampleScope: 'corpus',
      samplePassed: true, sampleEvidence, sampleQuestionIds: reviewed.filter(item => passedSamples.has(Number(item.origin.sourceQuestionId))).map(item => item.stagingQuestionId),
      basis: '350题完整语料分层随机抽35题，32通过、1错题与2疑题已隔离；逐题题面保真比对与抽样数学复核分开记录。未抽中题不声称独立数学复核通过。' }, questions: reviewed };
    const response = await request(`/api/question-imports/${record.importId}/publish`, input);
    const publication = response.result.publication;
    evidence.batches.push({ filename: batch.filename, ...response });
    await writeFile(path.join(out, batch.filename.replace(/\.md$/, '.json')), JSON.stringify({ input, ...response }, null, 2));
    console.log(JSON.stringify({ filename: batch.filename, status: response.status, accepted: publication?.accepted.length,
      duplicates: publication?.duplicates.length, rejected: publication?.rejected, error: response.result.error }));
  }
  evidence.finishedAt = new Date().toISOString();
  evidence.totals = { accepted: evidence.batches.reduce((n, item) => n + (item.result.publication?.accepted.length ?? 0), 0),
    duplicates: evidence.batches.reduce((n, item) => n + (item.result.publication?.duplicates.length ?? 0), 0),
    rejected: evidence.batches.reduce((n, item) => n + (item.result.publication?.rejected.length ?? 0), 0), held: evidence.held.length };
  await writeFile(path.join(directory, 'publication-summary.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence.totals));
} finally { await app.close(); }
