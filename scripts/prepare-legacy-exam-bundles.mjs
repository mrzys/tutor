// Development-only, offline conversion of an explicit shared-paper export.
// No SQL, model calls, publication, private profiles, or reference generation.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const text = value => typeof value === 'string' ? value : '';
const identity = value => value === null || value === undefined ? '' : String(value);
const provenance = value => value === 'generated' || value === 'ai_generated' ? 'generated' : value === 'manual' ? 'manual' : 'unknown';
const issue = (code, message) => ({code, message, blocking:true});
function safeFilename(value) {
  const name = path.basename(text(value)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  return name.toLowerCase().endsWith('.pdf') ? name : `${name || '原卷'}.pdf`;
}
function kind(q) {
  const choice = q.choice_type || q.raw_content_snapshot?.choiceType;
  if (choice === '多选题') return 'multiple_choice';
  if (choice === '单选题') return 'single_choice';
  if (q.question_type === '填空题') return 'fill_blank';
  if (q.question_type === '解答题') return 'free_response';
  throw new Error(`Unsupported source type at occurrence ${q.occurrence_id}: ${q.question_type}/${choice}`);
}
function answerText(row) {
  const data = row.answer_data || {};
  return text(data.text) || (Array.isArray(data.selections) ? data.selections.map(String).join('') : '');
}
function legacyReferences(q) {
  return {
    boundary:'旧题库参考，不是原卷官方答案或独立数学审核；不能自动填入原文答案解析。',
    answers:(q.reference_answers || []).map(row => ({id:identity(row.id),text:answerText(row),provenance:provenance(row.provenance_category || row.source_type),sourceType:row.source_type,reviewStatus:row.review_status,raw:row.answer_data})),
    solutions:(q.reference_solution_paths || []).map(row => ({id:identity(row.id),title:text(row.title),provenance:provenance(row.provenance_category || row.source_type),sourceType:row.source_type,reviewStatus:row.review_status,appliesToPartIds:row.applies_to_part_uids || [],text:(row.steps || []).map(step => [text(step.goal),text(step.operation),text(step.result)].filter(Boolean).join('\n')).join('\n\n'),steps:row.steps || []})),
  };
}
function imageMime(bytes) {
  if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return ['image/png','png'];
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ['image/jpeg','jpg'];
  if (['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString())) return ['image/gif','gif'];
  if (bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP') return ['image/webp','webp'];
  throw new Error('Source asset is not a supported raster image');
}
const aliases = value => new Set([text(value),text(value).replaceAll('\\','/'),text(value).replaceAll('&amp;','&')].filter(Boolean));
function rewriteImages(value, mapping, problems) {
  const rendered = new Set();
  return value.replace(/<img\b[^>]*>/gi, tag => {
    const match = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const source = match?.[1] ?? match?.[2] ?? match?.[3] ?? '';
    const target = [...aliases(source)].map(key => mapping.get(key)).find(Boolean);
    if (!target) {
      problems.push(issue('legacy_image_unresolved', `原配图引用尚未匹配本地素材：${source.slice(0,180)}`));
      return '<span>SOURCE_VISUAL_UNRESOLVED</span>';
    }
    if (target.startsWith('evidence:')) return '';
    // Old extraction sometimes kept both a coordinate filename and its
    // replacement source key for the exact same crop. Print that crop once.
    if (rendered.has(target)) return '';
    rendered.add(target);
    return tag.slice(0,match.index) + `src="asset:${target}"` + tag.slice(match.index + match[0].length);
  });
}

export async function buildLegacyExamBundle(sourceDirectory, {reviewFindings = []} = {}) {
  const sourceRoot = await fs.realpath(sourceDirectory);
  async function localFile(...parts) {
    const target = await fs.realpath(path.join(sourceRoot,...parts));
    const relative = path.relative(sourceRoot,target);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('Source file escapes the explicit export directory');
    return fs.readFile(target);
  }
  const raw = await localFile('source.json');
  const source = JSON.parse(raw);
  const downloads = JSON.parse((await localFile('downloads.json')).toString('utf8'));
  const examId = identity(source.sourceExam?.id);
  if (!/^\d+$/.test(examId) || !Array.isArray(source.occurrences) || !source.occurrences.length || source.occurrences.length > 60) throw new Error('Invalid explicit source exam or occurrence count');
  const original = downloads.documents?.find(doc => doc.role === 'question_paper');
  const sourceDocument = source.documents?.find(doc => identity(doc.document_id) === identity(original?.documentId));
  if (!original || original.status !== 'verified' || original.sourceHashVerification !== 'matched_source_sha256' || !sourceDocument) throw new Error(`${examId}: original PDF is not source-hash verified`);
  const pdf = await localFile(path.win32.basename(original.path));
  if (pdf.length > 15 * 1024 * 1024 || pdf.subarray(0,5).toString() !== '%PDF-' || sha(pdf) !== original.sha256 || sha(pdf) !== sourceDocument.file_sha256) throw new Error(`${examId}: PDF bytes, type, limit or original hash mismatch`);
  const seen = new Set();
  const assetDownloads = new Map((downloads.assets || []).map(a => [identity(a.assetId),a]));
  const questions = [], evidenceAssetPayloads = [];
  for (const q of source.occurrences) {
    const occurrenceId = identity(q.occurrence_id);
    if (!occurrenceId || seen.has(occurrenceId)) throw new Error(`${examId}: duplicate or missing occurrence`);
    seen.add(occurrenceId);
    const sourceIssues = [], mapping = new Map(), refs = [], payloads = [], auditAssets = [];
    const findings = reviewFindings.filter(f=>identity(f.examId)===examId&&identity(f.occurrenceId)===occurrenceId);
    for(const finding of findings) {
      if(finding.originalPdfSha256!==sha(pdf)||finding.contentHash!==q.content_hash||finding.blocking!==true||
          !/^legacy_[a-z_]+$/.test(finding.code||'')||!text(finding.message).trim()||text(finding.message).length>4000)throw new Error(`${examId}/${occurrenceId}: source-review identity or hash mismatch`);
      sourceIssues.push(issue(finding.code,finding.message));
    }
    const fields = [text(q.body),...(q.options || []).map(o=>text(o.body)),...(q.parts || []).map(p=>text(p.body))].join('\n');
    const seenAssets = new Set();
    for (const asset of q.assets || []) {
      const id = identity(asset.asset_id);
      if (seenAssets.has(id)) continue;
      seenAssets.add(id);
      const downloaded = assetDownloads.get(id);
      if (!downloaded || !['downloaded','verified'].includes(downloaded.status)) {
        sourceIssues.push(issue('legacy_asset_unavailable',`旧库素材 ${id} 尚未保真读取。`));
        continue;
      }
      const bytes = await localFile('assets',path.win32.basename(downloaded.path));
      const digest = sha(bytes);
      if (digest !== downloaded.sha256 || asset.object_sha256 && digest !== asset.object_sha256) throw new Error(`${examId}/${occurrenceId}: asset ${id} hash changed`);
      const [mime,ext] = imageMime(bytes);
      const assetId = `legacy-${examId}-${id}`;
      const reference = {assetId,path:`legacy-exams/${examId}/asset-${id}.${ext}`,sha256:digest,mimeType:mime,alt:asset.type === 'table' ? '原卷表格' : '原卷配图'};
      const payload = {...reference,role:'student',dataBase64:bytes.toString('base64')};
      const sourceKey = text(asset.source_key);
      const bbox = asset.bbox;
      const coordinateAlias = bbox && ['x1','y1','x2','y2'].every(k=>Number.isSafeInteger(bbox[k])) &&
        (q.assets || []).filter(a=>a.bbox && ['x1','y1','x2','y2'].every(k=>a.bbox[k]===bbox[k])).length===1
        ? `imgs/img_in_image_box_${bbox.x1}_${bbox.y1}_${bbox.x2}_${bbox.y2}.jpg` : null;
      const acceptedAliases = new Set([...aliases(sourceKey),...(coordinateAlias?[coordinateAlias]:[])]);
      const referenced = [...acceptedAliases].some(key=>fields.replaceAll('&amp;','&').includes(key));
      // The original table bitmap is retained as source evidence when the
      // editable HTML table already represents it; do not print it twice.
      const scope = a => a.placement === 'option' ? `option:${a.source_anchor?.optionKey}` : a.placement === 'part' ? `part:${a.source_anchor?.partUid}` : a.placement === 'body' ? 'body' : '';
      const location = scope(asset);
      const scopeText = location === 'body' ? text(q.body) : location.startsWith('option:') ? text((q.options||[]).find(o=>identity(o.label)===identity(asset.source_anchor?.optionKey))?.body) : location.startsWith('part:') ? text((q.parts||[]).find(p=>identity(p.uid)===identity(asset.source_anchor?.partUid))?.body) : '';
      const tableCount = (scopeText.match(/<table\b/gi)||[]).length;
      const evidenceOnly = asset.type === 'table' && tableCount > 0 && tableCount === (q.assets||[]).filter(a=>a.type==='table'&&scope(a)===location).length;
      auditAssets.push({...asset,assetId,sha256:digest,localSha256:digest,sourceHashVerification:downloaded.sourceHashVerification,evidenceOnly});
      if (evidenceOnly) {evidenceAssetPayloads.push(payload);for(const key of acceptedAliases)mapping.set(key,`evidence:${assetId}`);continue;}
      refs.push(reference);payloads.push(payload);
      // Coordinate aliases require the exact, unique source crop rectangle.
      for (const key of acceptedAliases) mapping.set(key,assetId);
      if (!referenced) {
        // Preserve the actual identity without inventing an unknown placement.
        sourceIssues.push(issue('legacy_asset_placement_unresolved',`素材 ${id} 的原始内联位置未明确，请对照原卷核对。`));
      }
    }
    const stem = rewriteImages(text(q.body),mapping,sourceIssues);
    const options = (q.options || []).map(o=>({label:text(o.label),text:rewriteImages(text(o.body),mapping,sourceIssues)}));
    const partIds = new Map((q.parts||[]).map((p,i)=>[identity(p.id),text(p.uid)||`part-${i+1}`]));
    const parts = (q.parts || []).map((p,i)=>{
      const parentPartId=p.parent_part_id==null?null:partIds.get(identity(p.parent_part_id));
      if(p.parent_part_id!=null&&!parentPartId)throw new Error(`${examId}/${occurrenceId}: missing source parent part`);
      return {partId:text(p.uid) || `part-${i+1}`,label:text(p.label),parentPartId,prompt:rewriteImages(text(p.body),mapping,sourceIssues),answer:'',solution:''};
    });
    if (!stem.trim()) sourceIssues.push(issue('legacy_body_missing','旧库题干缺失，不能凭模型补写。'));
    const start = Number(q.source_page_start), end = Number(q.source_page_end);
    const pages = Number.isSafeInteger(start) && Number.isSafeInteger(end) && start > 0 && end >= start && end-start < 200 ? Array.from({length:end-start+1},(_,i)=>start+i) : [];
    if (!pages.length) sourceIssues.push(issue('legacy_source_pages_missing','缺少可信原卷页码。'));
    if (/如图|下图|见图|图中(?:阴影|所示)/.test([stem,...options.map(o=>o.text),...parts.map(p=>p.prompt)].join('\n')) && !refs.length && !/<table\b/i.test(fields)) sourceIssues.push(issue('legacy_figure_missing','原题提及配图，但旧库没有可用配图，需恢复原图后再入库。'));
    const snapshot = q.raw_content_snapshot || {};
    // A legacy snapshot with apparent answers needs explicit provenance review;
    // never silently equate an unclassified field with the original answer.
    if (snapshot.answer || snapshot.analysis) sourceIssues.push(issue('legacy_original_reference_unclassified','原始快照含未分类参考资料，需核实是否原卷内容。'));
    questions.push({
      sourceIdentity:{system:'legacy_tutor_kb',examId,occurrenceId,questionId:identity(q.question_id),contentVersionId:identity(q.content_version_id),contentHash:text(q.content_hash)},
      questionType:kind(q),stem,options,parts,answer:'',solution:'',sourceLabel:identity(q.question_number || q.position),pages,
      student:{assets:refs},teacher:{assets:[]},assetPayloads:payloads,legacyReferences:legacyReferences(q),sourceIssues,
      sourceAudit:{position:q.position,score:q.score,sourceAnchor:q.source_anchor,rawContentSnapshot:snapshot,readiness:q.readiness,assetProvenance:auditAssets,reviewFindings:findings},
    });
  }
  return {
    schemaVersion:1,kind:'legacy_exam_bundle_v1',exam:{...source.sourceExam,id:examId,title:source.sourceExam.title || source.sourceExam.official_name},
    original:{filename:safeFilename(sourceDocument.original_filename),contentBase64:pdf.toString('base64'),sha256:sha(pdf)},
    expectedQuestionCount:source.occurrences.length,questions,
    sourceAudit:{sourceExportSha256:sha(raw),sourceDocument,sourcePages:source.pages,evidenceAssetPayloads,referenceBoundary:source.referenceBoundary},
  };
}

async function main() {
  const args = process.argv.slice(2), opt = key => args[args.indexOf(key)+1];
  for (const key of ['--source-root','--output']) if (!args.includes(key) || !opt(key)) throw new Error(`Missing ${key}`);
  const sourceRoot = path.resolve(opt('--source-root')), output = path.resolve(opt('--output'));
  const summary = JSON.parse(await fs.readFile(path.join(sourceRoot,'preparation-summary.json'),'utf8'));
  const reviewFindings = args.includes('--source-review') ? JSON.parse(await fs.readFile(opt('--source-review'),'utf8')) : [];
  if(!Array.isArray(reviewFindings))throw new Error('Source review must be an explicit array of hash-bound findings');
  const requested = args.includes('--exam-ids') ? opt('--exam-ids').split(',') : summary.allPaperSummary.map(p=>String(p.sourceExamId));
  const allowed = new Set(summary.allPaperSummary.map(p=>String(p.sourceExamId)));
  await fs.mkdir(output,{recursive:true});const papers=[];
  for (const id of requested) {
    if (!allowed.has(id)) throw new Error('Exam must come from the explicit source summary');
    const bundle = await buildLegacyExamBundle(path.join(sourceRoot,id),{reviewFindings});
    const bytes = Buffer.from(JSON.stringify(bundle));
    if (bytes.length > 64 * 1024 * 1024) throw new Error('Bundle exceeds 64 MB');
    const bundleHash = sha(bytes), filename = path.join(output,`exam-${id}.json`);
    try {const existing=await fs.readFile(filename);if(sha(existing)!==bundleHash)throw new Error(`Bundle changed; choose a new output directory: ${id}`);}
    catch(error){if(error.code!=='ENOENT')throw error;await fs.writeFile(filename,bytes,{flag:'wx'});}
    papers.push({examId:id,title:bundle.exam.title,filename,bundleSha256:bundleHash,operationId:`legacy-exam-${id}-v1-${bundleHash.slice(0,20)}`,expectedQuestionCount:bundle.expectedQuestionCount,questionTypes:bundle.questions.reduce((out,q)=>(out[q.questionType]=(out[q.questionType]||0)+1,out),{}),assets:bundle.questions.reduce((n,q)=>n+q.assetPayloads.length,0),sourceIssues:bundle.questions.filter(q=>q.sourceIssues.length).map(q=>({number:q.sourceLabel,issues:q.sourceIssues})),isFirstFive:summary.firstFive.map(String).includes(id)});
  }
  const manifest={schemaVersion:1,firstFive:summary.firstFive.map(String),papers};
  await fs.writeFile(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2));
  console.log(JSON.stringify({output,papers:papers.length,questions:papers.reduce((n,p)=>n+p.expectedQuestionCount,0),sourceIssueQuestions:papers.reduce((n,p)=>n+p.sourceIssues.length,0)}));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
