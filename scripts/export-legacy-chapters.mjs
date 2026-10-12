/** Read-only export of real, student-ready legacy questions. No credentials enter outputs.
 * Usage: node scripts/export-legacy-chapters.mjs [--count=350] [--batch-size=10]
 * Requires Python with psycopg2, or set PYTHON to that Python executable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => process.argv.find(v => v.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? fallback;
const legacyRoot = path.resolve(arg('legacy-root', path.join(root, '../tutor')));
const output = path.resolve(arg('output', path.join(root, '.tutor/chapter12-expansion')));
const wanted = Number(arg('count', '350'));
const batchSize = Number(arg('batch-size', '5'));
fs.mkdirSync(output, { recursive: true });
const rawPath = path.join(output, 'legacy-query.json');
const python = String.raw`
import os,sys,json,datetime
from pathlib import Path
import psycopg2, psycopg2.extras
cfg={}
for line in (Path(sys.argv[1])/'.env').read_text(encoding='utf-8-sig').splitlines():
 if '=' in line and not line.lstrip().startswith('#'):
  k,v=line.split('=',1);cfg[k.strip()]=v.strip().strip('"').strip("'")
uri=cfg.get('QUESTION_BANK_DATABASE_URL','').replace('postgresql+psycopg://','postgresql://')
if not uri: raise SystemExit('QUESTION_BANK_DATABASE_URL is missing')
conn=psycopg2.connect(uri,connect_timeout=10,application_name='tutor-v1-readonly-chapter12-export')
conn.set_session(readonly=True)
conn.set_client_encoding('UTF8')
c=conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
c.execute("set statement_timeout='60s'")
c.execute("select uid::text,name,parent_uid::text,metadata_json from public.knowledge_points where subject_id=1 and (uid like 'M-K-01-1%' or uid like 'M-K-01-2%') order by uid")
kps=[dict(v) for v in c.fetchall()]
c.execute("""
select p.question_id,p.content_version_id,p.primary_kp_uids,p.supporting_kp_uids,
 p.question_type,p.choice_type,p.duplicate_cluster_id,p.difficulty as legacy_difficulty,
 p.student_content_hash,p.source_evidence_hash,p.asset_identity_hash,p.source_occurrence_id,
 r.status as readiness_status,r.verification_method,cv.body,cv.review_status as content_review_status,
 ex.id as source_exam_id,ex.title as source_title,ex.paper_type,oc.question_number,
 coalesce((select jsonb_object_agg(o.option_key,o.body order by o.order_index) from kb_v2.question_options o where o.content_version_id=cv.id),'{}'::jsonb) as options,
 coalesce((select jsonb_agg(jsonb_build_object('uid',part.stable_uid,'label',part.label,'body',part.body) order by part.order_index) from kb_v2.question_parts part where part.content_version_id=cv.id),'[]'::jsonb) as parts,
 coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'data',a.answer_data,'reviewStatus',a.review_status,'sourceType',a.source_type) order by a.id desc) from kb_v2.question_answers a where a.content_version_id=cv.id and a.review_status in ('auto_verified','human_verified','corrected')),'[]'::jsonb) as answers,
 coalesce((select jsonb_agg(jsonb_build_object('id',sp.id,'title',sp.title,'pathType',sp.path_type,'reviewStatus',sp.review_status,'sourceType',sp.source_type,'partUids',sp.applies_to_part_uids,'steps',
  coalesce((select jsonb_agg(jsonb_build_object('uid',s.stable_uid,'partUid',s.question_part_uid,'goal',s.goal,'operation',s.operation,'result',s.result) order by s.order_index) from kb_v2.question_solution_steps s where s.solution_path_id=sp.id),'[]'::jsonb)) order by sp.id)
 from kb_v2.question_solution_paths sp where sp.content_version_id=cv.id and sp.stale_at is null and sp.eligible_for_scope and sp.review_status in ('auto_verified','human_verified','corrected')),'[]'::jsonb) as solution_paths,
 (select count(*) from kb_v2.question_asset_links al where al.content_version_id=cv.id) as asset_link_count
from kb_v2.question_student_selection_projection p
join kb_v2.questions q on q.id=p.question_id and q.current_content_version_id=p.content_version_id and q.canonical_status='active'
join kb_v2.question_content_versions cv on cv.id=p.content_version_id
join kb_v2.question_student_content_readiness r on r.id=p.readiness_id and r.question_id=q.id and r.content_version_id=cv.id
 and r.student_content_hash=p.student_content_hash and r.source_evidence_hash=p.source_evidence_hash and r.asset_identity_hash=p.asset_identity_hash
join kb_v2.question_occurrences oc on oc.id=p.source_occurrence_id and oc.canonical_question_id=q.id and oc.lifecycle_status='active' and oc.review_status<>'review_required'
join kb_v2.source_exams ex on ex.id=oc.source_exam_id and ex.lifecycle_status='active'
where r.status='ready' and r.policy_version='student-content-ready-v1'
 and (p.projection_version='student-selection-v2' or (p.projection_version='student-selection-v1' and q.publication_status='published' and kb_v2.has_legacy_student_projection_binding(q.id,cv.id)))
 and not kb_v2.has_student_content_review_hold(q.id,cv.id)
 and p.primary_kp_uids && array(select uid::text from public.knowledge_points where uid like 'M-K-01-1%' or uid like 'M-K-01-2%')
order by p.question_id
""")
rows=[dict(v) for v in c.fetchall()]
Path(sys.argv[2]).write_text(json.dumps({'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'knowledgePoints':kps,'questions':rows},ensure_ascii=False,default=str,indent=2),encoding='utf-8')
conn.close()
print(json.dumps({'readOnly':True,'rawQuestionCount':len(rows),'knowledgePointCount':len(kps)}))
`;
const query = spawnSync(process.env.PYTHON || 'python', ['-', legacyRoot, rawPath], { input: python, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
if (query.status !== 0) throw new Error(`Legacy read-only export failed: ${query.stderr.replace(/postgres(?:ql)?[^\s"']*/g, '[database]')}`);
const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
const kpById = new Map(raw.knowledgePoints.map(v => [v.uid, v]));
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const normalize = value => String(value).normalize('NFKC').replace(/\s+|\\(?:left|right|,|;|!|quad|qquad|displaystyle|textstyle)/g, '').replace(/[，。；：]/g, '');
const sectionOf = uid => uid.startsWith('M-K-01-11') ? '1.1' : ['M-K-01-1210','M-K-01-1211','M-K-01-1212','M-K-01-1213','M-K-01-1214'].includes(uid) ? '1.3' : uid.startsWith('M-K-01-12') ? '1.2' : ['M-K-01-1314','M-K-01-1315','M-K-01-1316','M-K-01-1317'].includes(uid) ? '1.4' : uid.startsWith('M-K-01-13') ? '1.5' : uid.startsWith('M-K-01-21') ? '2.1' : uid.startsWith('M-K-01-22') ? '2.2' : uid.startsWith('M-K-01-23') ? '2.3' : 'unknown';
const exclusions = [], pool = [], seenHashes = new Set(), seenClusters = new Set();
for (const row of raw.questions) {
 const reasons = [];
 if (row.choice_type?.includes('多选')) reasons.push('multi_choice_not_supported');
 if (row.asset_link_count || /!\[|<img\b|\b(?:asset|oss|image):\/\/|\[图片|\[图\]/i.test(JSON.stringify([row.body,row.options,row.parts]))) reasons.push('asset_dependency');
 if (!row.body?.trim()) reasons.push('missing_body');
 if (!row.answers.length || !row.answers.some(a => a.data?.text?.trim() || a.data?.finalAnswer?.trim() || a.data?.selections?.length)) reasons.push('missing_verified_answer');
 if (!row.solution_paths.some(p => p.steps?.some(s => s.operation?.trim() || s.result?.trim()))) reasons.push('missing_verified_solution');
 if (row.question_type?.includes('选择') && Object.keys(row.options).length !== 4) reasons.push('incomplete_options');
 const contentHash=hash(normalize(JSON.stringify([row.body,row.options,row.parts])));
 if (seenHashes.has(contentHash) || row.duplicate_cluster_id && seenClusters.has(row.duplicate_cluster_id)) reasons.push('duplicate');
 if (reasons.length) { exclusions.push({ questionId:row.question_id,reasons });continue; }
 seenHashes.add(contentHash);if (row.duplicate_cluster_id) seenClusters.add(row.duplicate_cluster_id);
 const sections=[...new Set(row.primary_kp_uids.map(sectionOf).filter(s=>s!=='unknown'))];
 pool.push({...row,sections,contentFingerprint:contentHash});
}
// Include all chapter 2 supply first, then round-robin chapter 1 sections for balanced coverage.
const chapter2=pool.filter(v=>v.sections.some(s=>s.startsWith('2.')));
const chapter1=pool.filter(v=>!chapter2.includes(v));
const buckets=new Map();for(const row of chapter1){const s=row.sections[0]||'unknown';if(!buckets.has(s))buckets.set(s,[]);buckets.get(s).push(row);}
const selected=chapter2.slice(0,wanted);while(selected.length<wanted&&[...buckets.values()].some(v=>v.length))for(const rows of buckets.values())if(rows.length&&selected.length<wanted)selected.push(rows.shift());
selected.sort((a,b)=>a.sections[0].localeCompare(b.sections[0])||a.question_id-b.question_id);
const batches=[];
for(let i=0;i<selected.length;i+=batchSize){
 const rows=selected.slice(i,i+batchSize);const name=`legacy-ch12-${String(batches.length+1).padStart(3,'0')}.md`;
 let md='# 必修第一册第一、二章旧题库定向导入材料\n\n本文件来自旧题库只读查询。旧知识点与旧难度仅为参考；请独立复核解答、重新判定难度，保留来源题号，不编造缺失内容。\n\n';
 for(const [j,q]of rows.entries()){
  md+=`## 第 ${j+1} 题（旧题 ID ${q.question_id}，版本 ${q.content_version_id}）\n\n`;
  md+=`- 来源：${q.source_title||'旧题库'}；原卷题号：${q.question_number??'未提供'}\n- 题型：${q.question_type}${q.choice_type?' / '+q.choice_type:''}\n- 参考章节：${q.sections.join('、')}\n- 旧主知识点：${q.primary_kp_uids.map(uid=>`${uid} ${kpById.get(uid)?.name||''}`).join('；')}\n\n`;
  md+=q.body+'\n\n';for(const[k,v]of Object.entries(q.options))md+=`${k}. ${v}\n\n`;
  for(const part of q.parts)md+=`${part.label||part.uid} ${part.body}\n\n`;
  md+='### 参考答案（旧库已自动或人工复核；本次仍需独立核验）\n\n'+JSON.stringify(q.answers[0].data,null,2)+'\n\n';
  md+='### 参考解析\n\n';for(const p of q.solution_paths){md+=`${p.title||'解法'}\n\n`;for(const s of p.steps)md+=`${s.goal||''}：${s.operation||''}；${s.result||''}\n\n`;}
 }
 fs.writeFileSync(path.join(output,name),md,'utf8');batches.push({filename:name,questionIds:rows.map(v=>v.question_id),sha256:hash(md),count:rows.length});
}
const counts=rows=>Object.fromEntries([...new Set(rows.flatMap(v=>v.sections))].sort().map(s=>[s,rows.filter(v=>v.sections.includes(s)).length]));
const manifest={schemaVersion:1,observedAt:raw.observedAt,querySource:'configured legacy QUESTION_BANK_DATABASE_URL (read-only, credentials excluded)',chapterRoots:['M-K-01-100','M-K-01-200'],rawQuestionCount:raw.questions.length,eligibleQuestionCount:pool.length,selectedQuestionCount:selected.length,eligibleSectionCounts:counts(pool),selectedSectionCounts:counts(selected),questionTypes:Object.fromEntries([...new Set(selected.map(v=>v.choice_type||v.question_type))].map(t=>[t,selected.filter(v=>(v.choice_type||v.question_type)===t).length])),knowledgePoints:raw.knowledgePoints,batches,exclusions,questions:selected};
fs.writeFileSync(path.join(output,'source-manifest.json'),JSON.stringify(manifest,null,2),'utf8');
console.log(JSON.stringify({output,rawQuestionCount:raw.questions.length,eligibleQuestionCount:pool.length,selectedQuestionCount:selected.length,sectionCounts:manifest.selectedSectionCounts,questionTypes:manifest.questionTypes,batchCount:batches.length},null,2));
