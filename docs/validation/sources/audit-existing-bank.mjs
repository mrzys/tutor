// Read-only evidence collection for S2-02. No processing or publication calls.
// node audit-existing-bank.mjs --bank-root <existing checkout> --api-config <env> --output <json>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  'bank-root': { type: 'string' }, 'api-config': { type: 'string' }, output: { type: 'string' },
} });
if (!values['bank-root'] || !values.output) throw new Error('--bank-root and --output required');
const root = path.resolve(values['bank-root']);
const require = createRequire(path.join(root, 'package.json'));
const dotenv = require('dotenv');
const { Client } = require('pg');
const config = dotenv.parse(fs.readFileSync(path.join(root, '.env'), 'utf8'));
const client = new Client({
  connectionString: config.DATABASE_URL, connectionTimeoutMillis: 12000,
  options: '-c default_transaction_read_only=on -c statement_timeout=20000',
  application_name: 'tutor-v1-s2-02-readonly',
});
// The existing taxonomy places union directly under chapter 1, outside the
// relationships/operations branch. Include it explicitly to avoid false gaps.
const roots = ['M-K-01-110', 'M-K-01-120', 'M-K-01-1210'];
const hashes = [
  '866fb29f1d6a285f74290b03d6f5793569fbeb796d58a9ada1f8c5d918b35da2',
  '4e721470062d7f8ecc6a7b749a16863636f751aa950260cf709750e86a2d0217',
];
const scope = `with recursive scope as (
  select uid,name,parent_uid from public.knowledge_points where uid=any($1::text[])
  union select k.uid,k.name,k.parent_uid from public.knowledge_points k join scope s on k.parent_uid=s.uid
) `;
const overlap = 'p.primary_kp_uids && array(select uid::text from scope)';
const evidence = {
  observedAt: new Date().toISOString(), source: 'existing-bank-configured-database',
  sourceConfiguration: 'existing checkout root .env DATABASE_URL; connection details excluded',
  intent: 'inventory only; no claim that old tags prove learned-boundary conformity',
  readOnly: true, scopeRoots: roots, baselinePdfHashes: hashes, queries: {}, api: [],
};
async function record(name, sql, params = []) {
  const { rows } = await client.query(sql, params);
  evidence.queries[name] = { sql, params, rows };
  return rows;
}
try {
  await client.connect();
  await client.query('begin isolation level repeatable read read only');
  const mode = await client.query('show transaction_read_only');
  if (mode.rows[0].transaction_read_only !== 'on') throw new Error('Read-only protection missing');
  await record('inventory', `select 'v1_exams' entity,count(*) from public.exams
    union all select 'v1_questions',count(*) from public.questions
    union all select 'v2_exams',count(*) from kb_v2.source_exams
    union all select 'v2_questions',count(*) from kb_v2.questions
    union all select 'v2_student_projection',count(*) from kb_v2.question_student_selection_projection
    union all select 'v2_teacher_projection',count(*) from kb_v2.question_selection_projection`);
  await record('scopeTaxonomy', scope + 'select * from scope order by uid', [roots]);
  await record('exactSourceDocuments', `select id,original_filename,file_sha256,byte_size,ingest_status
    from kb_v2.source_documents where file_sha256=any($1::text[])`, [hashes]);
  await record('namedV2Sources', `select id,title,status,source_document_id from kb_v2.source_exams
    where title ilike $1 order by id`, ['%集合%']);
  const namedV1 = await record('namedV1Sources', `select id,source_filename,current_stage,current_status
    from public.exams where source_filename ilike $1 order by id`, ['%集合%']);
  await record('namedV1Records', `select id,exam_id,number,question_type,choice_type,status,label_status,
    source_page,left(body,180) body_excerpt,length(coalesce(answer,'')) answer_length,
    length(coalesce(analysis,'')) analysis_length,solution_source
    from public.questions where exam_id=any($1::int[]) order by exam_id,number,id`, [namedV1.map(x => x.id)]);
  const candidates = await record('studentCandidates', scope + `select p.question_id,p.content_version_id,
    v.content_hash,p.question_type,p.choice_type,p.difficulty,p.primary_kp_uids,p.supporting_kp_uids,
    p.duplicate_cluster_id,p.source_occurrence_id,p.student_content_hash,p.source_evidence_hash,
    p.projection_version,v.body from kb_v2.question_student_selection_projection p
    join kb_v2.question_content_versions v on v.id=p.content_version_id
    where ${overlap} order by p.question_id`, [roots]);
  const ids = candidates.map(x => x.question_id);
  await record('teacherCandidates', scope + `select p.question_id,p.content_version_id,p.quality_level,
    p.solution_status,p.asset_status,p.scoring_status,p.path_dependency_sets,p.dependency_closure
    from kb_v2.question_selection_projection p where ${overlap} order by p.question_id`, [roots]);
  await record('labelOnlyContainmentProbe', scope + `select p.question_id,p.question_type,p.choice_type
    from kb_v2.question_student_selection_projection p where ${overlap}
    and p.primary_kp_uids <@ array(select uid::text from scope)
    and p.supporting_kp_uids <@ array(select uid::text from scope) order by p.question_id`, [roots]);
  await record('candidateSources', `select o.id occurrence_id,o.canonical_question_id question_id,
    o.source_exam_id,o.question_number,o.source_page_start,o.source_page_end,o.lifecycle_status,
    e.title,d.id document_id,d.original_filename,d.file_sha256
    from kb_v2.question_occurrences o join kb_v2.source_exams e on e.id=o.source_exam_id
    join kb_v2.source_documents d on d.id=e.source_document_id
    where o.canonical_question_id=any($1::bigint[]) order by o.canonical_question_id,o.id`, [ids]);
  await record('answerProvenance', `select a.source_type,a.review_status,count(*),count(distinct a.question_id) distinct_questions
    from kb_v2.question_answers a join kb_v2.questions q on q.current_content_version_id=a.content_version_id
    where a.question_id=any($1::bigint[]) group by 1,2 order by 1,2`, [ids]);
  await record('solutionProvenance', `select s.source_type,s.review_status,s.eligible_for_scope,count(*),count(distinct s.question_id) distinct_questions
    from kb_v2.question_solution_paths s join kb_v2.questions q on q.current_content_version_id=s.content_version_id
    where s.question_id=any($1::bigint[]) group by 1,2,3 order by 1,2,3`, [ids]);
  await record('partStructure', `select q.id question_id,count(p.id)::int part_count
    from kb_v2.questions q left join kb_v2.question_parts p on p.content_version_id=q.current_content_version_id
    where q.id=any($1::bigint[]) group by q.id order by q.id`, [ids]);
  await record('relatedTaxonomy', `select uid,name,parent_uid from public.knowledge_points
    where uid=any($1::text[]) order by uid`, [[...new Set(candidates.flatMap(x => [...x.primary_kp_uids, ...x.supporting_kp_uids]))]]);
  await client.query('commit');
} finally { await client.end(); }

if (values['api-config']) {
  const apiConfig = dotenv.parse(fs.readFileSync(values['api-config'], 'utf8'));
  const base = apiConfig.QUESTION_BANK_API_BASE_URL?.replace(/\/+$/, '');
  const key = apiConfig.QUESTION_BANK_API_KEY;
  if (!base || !key) evidence.api.push({ configured: false });
  else {
    for (const profile of ['student_content', 'teacher_material']) {
      const request = { subject: 'math', hard_constraints: {
        target_kp_uids: roots, readiness_profile: profile, knowledge_scope_policy: 'primary_overlap',
        quality_level: profile === 'student_content' ? 'source_ready' : 'solution_ready',
        require_complete_solution: profile !== 'student_content', require_assets_ready: true,
        require_official_scoring: false,
      }, pool: { limit: 300, seed: 's2-02-existing-bank-20261010' } };
      try {
        const response = await fetch(base + '/question-candidates', { method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': key },
          body: JSON.stringify(request), signal: AbortSignal.timeout(25000) });
        const text = await response.text();
        let result;
        try { result = JSON.parse(text); } catch { result = { nonJson: true }; }
        // Preserve candidate response, never headers, credentials or signed assets.
        const items = Array.isArray(result.items) ? result.items.map(item => ({
          questionId: item.questionId, contentVersionId: item.contentVersionId,
          questionType: item.questionType, choiceType: item.choiceType,
          duplicateClusterId: item.duplicateClusterId,
        })) : [];
        evidence.api.push({ base, path: '/question-candidates', request,
          httpStatus: response.status, observedAt: new Date().toISOString(), items,
          nextCursorPresent: !!(result.nextCursor ?? result.next_cursor),
          responseFieldNames: Object.keys(result),
        });
      } catch (error) {
        evidence.api.push({ base, path: '/question-candidates', request, errorType: error.name });
      }
    }
  }
}
fs.writeFileSync(path.resolve(values.output), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ observedAt: evidence.observedAt,
  exactSourceMatches: evidence.queries.exactSourceDocuments.rows.length,
  candidateCount: evidence.queries.studentCandidates.rows.length,
  api: evidence.api.map(x => ({ profile: x.request?.hard_constraints.readiness_profile,
    status: x.httpStatus, items: x.items?.length, errorType: x.errorType })),
}));
