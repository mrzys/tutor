// Simulated fixtures follow the real explicit legacy export schema. They do not
// represent a teacher case or claim PDF/source correctness beyond converter gates.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {buildLegacyExamBundle} from '../prepare-legacy-exam-bundles.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ea0AAAAASUVORK5CYII=', 'base64');
async function fixture(t) {
  const holder = await fs.mkdtemp(path.join(os.tmpdir(), 'tutor-legacy-bundle-test-'));
  const root = path.join(holder, '258');
  await fs.mkdir(path.join(root, 'assets'), {recursive:true});
  t.after(async () => {
    // Only the random directory created by this test is removed.
    assert.equal(path.dirname(holder), path.resolve(os.tmpdir()));
    await fs.rm(holder, {recursive:true, force:true});
  });
  const pdf = Buffer.from('%PDF-1.4\n% simulated question-only export fixture\n%%EOF\n');
  await fs.writeFile(path.join(root, 'paper.pdf'), pdf);
  const occurrences = [
    {occurrence_id:6462, question_id:6464, content_version_id:5410, question_number:'1', position:1, question_type:'选择题', choice_type:'单选题', body:'若 $a>b$，则下列结论正确的是（ ）', options:[{label:'A',body:'$a-b>0$'},{label:'B',body:'$a+b>0$'}], parts:[]},
    {occurrence_id:6463, question_id:6465, content_version_id:5411, question_number:'2', position:2, question_type:'选择题', body:'下列恒成立的有（ ）', options:[{label:'A',body:'$a^2\\geq 0$'},{label:'B',body:'$a^2<0$'}], parts:[], raw_content_snapshot:{choiceType:'多选题'}},
    {occurrence_id:6464, question_id:6466, content_version_id:5412, question_number:'3', position:3, question_type:'填空题', body:'$1+1=$______。', options:[], parts:[]},
    {occurrence_id:6465, question_id:6467, content_version_id:5413, question_number:'4', position:4, question_type:'解答题', body:'已知 $f(x)=x^2$。', options:[], parts:[{uid:'source-part-1',body:'求 $f(1)$。'},{uid:'source-part-2',body:'证明 $f(x)\\geq 0$。'}]},
  ].map(q => ({...q, content_hash:sha(Buffer.from(q.body)), source_page_start:1, source_page_end:2, score:5, source_anchor:{questionNumber:q.question_number}, readiness:{sourceReady:true}, assets:[], reference_answers:[], reference_solution_paths:[], raw_content_snapshot:q.raw_content_snapshot || {body:q.body}}));
  const source = {
    sourceExam:{id:258,title:'模拟格式回归试卷',official_name:'模拟整卷'},
    documents:[{document_id:9001,original_filename:'模拟试卷.pdf',file_sha256:sha(pdf)}],
    occurrences,
    pages:[{page_number:1},{page_number:2}],
    referenceBoundary:'旧题库答案解析仅为独立参考，不属于原卷正文。',
  };
  const downloads = {
    documents:[{documentId:9001,role:'question_paper',path:'C:\\simulated-export\\paper.pdf',status:'verified',sourceHashVerification:'matched_source_sha256',sha256:sha(pdf)}],
    assets:[],
  };
  const save = async () => {
    await fs.writeFile(path.join(root, 'source.json'), JSON.stringify(source));
    await fs.writeFile(path.join(root, 'downloads.json'), JSON.stringify(downloads));
  };
  const addAsset = async (question, {id=81,type='figure',sourceKey='https://example.test/figure.png',filename=`asset-${id}.png`}={}) => {
    await fs.writeFile(path.join(root, 'assets', filename), png);
    question.assets.push({asset_id:id,type,source_key:sourceKey,object_sha256:sha(png)});
    downloads.assets.push({assetId:id,path:`C:\\simulated-export\\assets\\${filename}`,status:'verified',sourceHashVerification:'matched_source_sha256',sha256:sha(png)});
    return id;
  };
  await save();
  return {holder,root,pdf,source,downloads,save,addAsset};
}

test('simulated full export keeps all occurrences, four question types, PDF hash and stable source identities', async t => {
  const f = await fixture(t);
  const bundle = await buildLegacyExamBundle(f.root);
  assert.equal(bundle.expectedQuestionCount, 4);
  assert.equal(bundle.questions.length, 4);
  assert.deepEqual(bundle.questions.map(q=>q.questionType), ['single_choice','multiple_choice','fill_blank','free_response']);
  assert.equal(bundle.original.sha256, sha(f.pdf));
  assert.deepEqual(Buffer.from(bundle.original.contentBase64,'base64'), f.pdf);
  assert.equal(bundle.sourceAudit.sourceExportSha256, sha(await fs.readFile(path.join(f.root,'source.json'))));
  assert.deepEqual(bundle.questions[0].sourceIdentity, {system:'legacy_tutor_kb',examId:'258',occurrenceId:'6462',questionId:'6464',contentVersionId:'5410',contentHash:f.source.occurrences[0].content_hash});
  assert.deepEqual(bundle.questions.map(q=>q.sourceLabel), ['1','2','3','4']);
  assert.deepEqual(bundle.questions[3].parts.map(p=>p.partId), ['source-part-1','source-part-2']);
  assert.ok(bundle.questions.every(q=>q.pages.join(',')==='1,2'));
  assert.deepEqual(await buildLegacyExamBundle(f.root), bundle, 'identities and bundle content must not depend on random IDs or conversion time');
});

test('simulated original PDF hash and source-verification gates reject changed or unverified bytes', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root,'paper.pdf'), Buffer.from('%PDF-1.4\nchanged simulated bytes'));
  await assert.rejects(buildLegacyExamBundle(f.root), /PDF bytes.*hash mismatch/);
  await fs.writeFile(path.join(f.root,'paper.pdf'), f.pdf);
  f.downloads.documents[0].sourceHashVerification='not_verified'; await f.save();
  await assert.rejects(buildLegacyExamBundle(f.root), /not source-hash verified/);
  f.downloads.documents[0].sourceHashVerification='matched_source_sha256';
  f.source.documents[0].file_sha256='0'.repeat(64); await f.save();
  await assert.rejects(buildLegacyExamBundle(f.root), /PDF bytes.*hash mismatch/);
});

test('simulated inline images bind exact bytes and hashes once in stem and options, and reject asset tampering', async t => {
  const f = await fixture(t); const q=f.source.occurrences[0];
  q.body+=' <img src="https://example.test/figure.png" alt="原图">';
  q.options[0].body+=' <img src=\'https://example.test/figure.png\'>';
  await f.addAsset(q); q.assets.push({...q.assets[0]}); await f.save();
  const bundle=await buildLegacyExamBundle(f.root); const actual=bundle.questions[0];
  assert.match(actual.stem,/src="asset:legacy-258-81"/);
  assert.match(actual.options[0].text,/src="asset:legacy-258-81"/);
  assert.equal(actual.student.assets.length,1); assert.equal(actual.assetPayloads.length,1);
  assert.equal(actual.student.assets[0].path,'legacy-exams/258/asset-81.png');
  assert.equal(actual.assetPayloads[0].sha256,sha(png));
  assert.deepEqual(Buffer.from(actual.assetPayloads[0].dataBase64,'base64'),png);
  assert.deepEqual(actual.sourceIssues,[]);
  await fs.writeFile(path.join(f.root,'assets','asset-81.png'), Buffer.concat([png,Buffer.from('tampered')]));
  await assert.rejects(buildLegacyExamBundle(f.root), /asset 81 hash changed/);
});

test('simulated asset junction outside the explicit export root is rejected even when its bytes and hash match', async t => {
  const f=await fixture(t); const outside=path.join(f.holder,'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside,'asset-81.png'),png);
  const q=f.source.occurrences[0];q.body+=' <img src="https://example.test/figure.png">';
  q.assets=[{asset_id:81,type:'figure',source_key:'https://example.test/figure.png',object_sha256:sha(png)}];
  f.downloads.assets=[{assetId:81,path:'C:\\other\\asset-81.png',status:'verified',sourceHashVerification:'matched_source_sha256',sha256:sha(png)}];
  await fs.rmdir(path.join(f.root,'assets'));
  await fs.symlink(outside,path.join(f.root,'assets'),'junction');
  await f.save();
  await assert.rejects(buildLegacyExamBundle(f.root), /escapes the explicit export directory/);
});

test('simulated question-only original never receives legacy answers or solutions in original-content fields', async t => {
  const f=await fixture(t); const q=f.source.occurrences[3];
  q.reference_answers=[{id:21,answer_data:{text:'SIMULATED_LEGACY_ANSWER'},source_type:'ai_generated',review_status:'auto_verified'}];
  q.reference_solution_paths=[{id:22,title:'旧库生成解法',source_type:'ai_generated',review_status:'auto_verified',applies_to_part_uids:['source-part-1'],steps:[{goal:'SIMULATED_LEGACY_GOAL',operation:'SIMULATED_LEGACY_SOLUTION',result:'SIMULATED_LEGACY_RESULT'}]}];
  await f.save(); const bundle=await buildLegacyExamBundle(f.root); const actual=bundle.questions[3];
  assert.equal(actual.answer,''); assert.equal(actual.solution,'');
  assert.ok(actual.parts.every(p=>p.answer==='' && p.solution===''));
  const studentContent=JSON.stringify({stem:actual.stem,options:actual.options,parts:actual.parts,student:actual.student});
  assert.doesNotMatch(studentContent,/SIMULATED_LEGACY_(?:ANSWER|GOAL|SOLUTION|RESULT)/);
  assert.equal(actual.legacyReferences.answers[0].text,'SIMULATED_LEGACY_ANSWER');
  assert.equal(actual.legacyReferences.answers[0].provenance,'generated');
  assert.equal(actual.legacyReferences.solutions[0].provenance,'generated');
  assert.match(actual.legacyReferences.boundary,/不是原卷官方答案或独立数学审核/);
});

test('simulated editable HTML table keeps its bitmap only as evidence and never prints a second PNG', async t => {
  const f=await fixture(t); const q=f.source.occurrences[2];
  q.body='根据下表回答：<table><tr><th>甲</th><th>乙</th></tr><tr><td>$1$</td><td>$2$</td></tr></table>';
  await f.addAsset(q,{id:82,type:'table',sourceKey:'https://example.test/table-bitmap.png'});q.assets[0].placement='body';await f.save();
  const bundle=await buildLegacyExamBundle(f.root);const actual=bundle.questions[2];
  assert.equal(actual.stem,q.body); assert.doesNotMatch(actual.stem,/<img\b/);
  assert.deepEqual(actual.student.assets,[]);assert.deepEqual(actual.assetPayloads,[]);
  assert.equal(bundle.sourceAudit.evidenceAssetPayloads.length,1);
  assert.equal(bundle.sourceAudit.evidenceAssetPayloads[0].sha256,sha(png));
  assert.equal(actual.sourceAudit.assetProvenance[0].evidenceOnly,true);
  assert.deepEqual(actual.sourceIssues,[]);
});

test('simulated unresolved source content produces blocking source issues without invented placement, text or pages', async t => {
  const f=await fixture(t);
  f.source.occurrences[0].body='';
  f.source.occurrences[1].body='如图所示，求值。';
  f.source.occurrences[2].body='<img src="https://example.test/missing.png">';
  f.source.occurrences[2].assets=[{asset_id:99,type:'figure',source_key:'https://example.test/missing.png'}];
  const q=f.source.occurrences[3];q.source_page_start=null;q.source_page_end=null;
  q.raw_content_snapshot={answer:'待分类旧字段',analysis:'待核验旧解析'};
  await f.addAsset(q,{id:83,sourceKey:'https://example.test/no-inline-position.png'});await f.save();
  const bundle=await buildLegacyExamBundle(f.root);const codes=bundle.questions.map(q=>q.sourceIssues.map(i=>i.code));
  assert.ok(codes[0].includes('legacy_body_missing'));
  assert.ok(codes[1].includes('legacy_figure_missing'));
  assert.ok(codes[2].includes('legacy_asset_unavailable'));assert.ok(codes[2].includes('legacy_image_unresolved'));
  assert.ok(codes[3].includes('legacy_source_pages_missing'));assert.ok(codes[3].includes('legacy_original_reference_unclassified'));assert.ok(codes[3].includes('legacy_asset_placement_unresolved'));
  assert.ok(bundle.questions.flatMap(q=>q.sourceIssues).every(i=>i.blocking===true));
  assert.equal(bundle.questions[0].stem,''); assert.deepEqual(bundle.questions[3].pages,[]);
  assert.match(bundle.questions[2].stem,/SOURCE_VISUAL_UNRESOLVED/);
  assert.equal(bundle.questions[3].stem,q.body);assert.equal(bundle.questions[3].answer,'');
});

test('simulated duplicate occurrence IDs and unsupported source question types fail the whole conversion', async t => {
  const f=await fixture(t);f.source.occurrences[1].occurrence_id=f.source.occurrences[0].occurrence_id;await f.save();
  await assert.rejects(buildLegacyExamBundle(f.root),/duplicate or missing occurrence/);
  f.source.occurrences[1].occurrence_id=6463;f.source.occurrences[1].raw_content_snapshot.choiceType='判断题';await f.save();
  await assert.rejects(buildLegacyExamBundle(f.root),/Unsupported source type/);
});

test('simulated HTML-escaped ampersand image URL binds without a false unresolved-placement issue', async t => {
  const f=await fixture(t);const q=f.source.occurrences[0];
  q.body+=' <img src="https://example.test/figure.png?x=1&amp;y=2">';
  await f.addAsset(q,{id:84,sourceKey:'https://example.test/figure.png?x=1&y=2'});await f.save();
  const bundle=await buildLegacyExamBundle(f.root);const actual=bundle.questions[0];
  assert.match(actual.stem,/src="asset:legacy-258-84"/);
  assert.deepEqual(actual.sourceIssues,[], 'an equivalent escaped URL has a known inline placement');
});

test('simulated unique exact bbox alias and source-key image of the same crop render once per field', async t => {
  const f=await fixture(t);const q=f.source.occurrences[0];
  q.body+=' <img src="imgs/img_in_image_box_1_2_30_40.jpg"><img src="https://example.test/crop.png">';
  await f.addAsset(q,{id:85,sourceKey:'https://example.test/crop.png'});q.assets[0].bbox={x1:1,y1:2,x2:30,y2:40};await f.save();
  const bundle=await buildLegacyExamBundle(f.root);const actual=bundle.questions[0];
  assert.equal((actual.stem.match(/<img\b/g)||[]).length,1);
  assert.match(actual.stem,/src="asset:legacy-258-85"/);assert.deepEqual(actual.sourceIssues,[]);
  assert.equal(actual.assetPayloads.length,1);
  // A second distinct source crop with the same coordinates makes that alias
  // ambiguous. It must remain unresolved rather than choose the first image.
  await f.addAsset(q,{id:86,sourceKey:'https://example.test/another-crop.png'});q.assets[1].bbox={x1:1,y1:2,x2:30,y2:40};await f.save();
  const ambiguous=(await buildLegacyExamBundle(f.root)).questions[0];
  assert.match(ambiguous.stem,/SOURCE_VISUAL_UNRESOLVED/);
  assert.ok(ambiguous.sourceIssues.some(i=>i.code==='legacy_image_unresolved'));
});

test('simulated coordinate-only exact bbox alias has a known inline image position', async t => {
  const f=await fixture(t);const q=f.source.occurrences[0];
  q.body+=' <img src="imgs/img_in_image_box_2_3_40_50.jpg">';
  await f.addAsset(q,{id:87,sourceKey:'https://example.test/replaced-crop.png'});q.assets[0].bbox={x1:2,y1:3,x2:40,y2:50};await f.save();
  const actual=(await buildLegacyExamBundle(f.root)).questions[0];
  assert.match(actual.stem,/src="asset:legacy-258-87"/);
  assert.deepEqual(actual.sourceIssues,[], 'an accepted exact bbox alias establishes the actual inline placement');
});

test('simulated part labels and numeric parent identities survive conversion with stable UID links', async t => {
  const f=await fixture(t);const q=f.source.occurrences[3];
  q.parts=[
    {id:501,uid:'source-parent',label:'（1）',parent_part_id:null,body:'第一部分。'},
    {id:502,uid:'source-child-a',label:'①',parent_part_id:501,body:'子问题甲。'},
    {id:503,uid:'source-child-b',label:'②',parent_part_id:'501',body:'子问题乙。'},
    {id:504,uid:'',label:'（2）',parent_part_id:null,body:'第二部分。'},
  ];await f.save();const parts=(await buildLegacyExamBundle(f.root)).questions[3].parts;
  assert.deepEqual(parts.map(p=>({id:p.partId,label:p.label,parent:p.parentPartId})),[
    {id:'source-parent',label:'（1）',parent:null},
    {id:'source-child-a',label:'①',parent:'source-parent'},
    {id:'source-child-b',label:'②',parent:'source-parent'},
    {id:'part-4',label:'（2）',parent:null},
  ]);
  assert.deepEqual(parts.map(p=>p.prompt),q.parts.map(p=>p.body));
  assert.ok(parts.every(p=>p.answer==='' && p.solution===''));
  assert.deepEqual((await buildLegacyExamBundle(f.root)).questions[3].parts,parts);
});

test('simulated missing parent part fails conversion rather than flattening or inventing a parent', async t => {
  const f=await fixture(t);f.source.occurrences[3].parts=[{id:502,uid:'orphan',label:'①',parent_part_id:9999,body:'父小问缺失。'}];await f.save();
  await assert.rejects(buildLegacyExamBundle(f.root),/missing source parent part/);
});

test('simulated table bitmaps are deduplicated only against HTML tables in their explicit body, option or part scope', async t => {
  const f=await fixture(t);const table='<table><tr><td>$1$</td><td>$2$</td></tr></table>';
  const body=f.source.occurrences[0];body.body=`根据表格回答：${table}<img src="https://example.test/body-table.png">`;
  await f.addAsset(body,{id:91,type:'table',sourceKey:'https://example.test/body-table.png'});body.assets[0].placement='body';
  const option=f.source.occurrences[1];option.options[0].body=`${table}<img src="https://example.test/option-table.png">`;
  await f.addAsset(option,{id:92,type:'table',sourceKey:'https://example.test/option-table.png'});option.assets[0].placement='option';option.assets[0].source_anchor={optionKey:'A'};
  const part=f.source.occurrences[3];part.parts[0].body=`${table}<img src="https://example.test/part-table.png">`;
  await f.addAsset(part,{id:93,type:'table',sourceKey:'https://example.test/part-table.png'});part.assets[0].placement='part';part.assets[0].source_anchor={partUid:'source-part-1'};
  await f.save();const bundle=await buildLegacyExamBundle(f.root);
  assert.equal(bundle.sourceAudit.evidenceAssetPayloads.length,3);
  for(const index of [0,1,3]){
    const q=bundle.questions[index];assert.deepEqual(q.student.assets,[]);assert.deepEqual(q.assetPayloads,[]);assert.deepEqual(q.sourceIssues,[]);assert.equal(q.sourceAudit.assetProvenance[0].evidenceOnly,true);
  }
  for(const field of [bundle.questions[0].stem,bundle.questions[1].options[0].text,bundle.questions[3].parts[0].prompt]){assert.match(field,/<table\b/);assert.doesNotMatch(field,/<img\b/);}
});

test('simulated ambiguous or absent table placement does not discard original table bitmaps', async t => {
  const f=await fixture(t);const q=f.source.occurrences[0];const table='<table><tr><td>甲</td></tr></table>';
  q.body=`${table}<img src="https://example.test/table-one.png"><img src="https://example.test/table-two.png">`;
  await f.addAsset(q,{id:94,type:'table',sourceKey:'https://example.test/table-one.png'});q.assets[0].placement='body';
  await f.addAsset(q,{id:95,type:'table',sourceKey:'https://example.test/table-two.png'});q.assets[1].placement='body';await f.save();
  const ambiguous=await buildLegacyExamBundle(f.root);assert.equal(ambiguous.sourceAudit.evidenceAssetPayloads.length,0);assert.equal(ambiguous.questions[0].assetPayloads.length,2);assert.equal((ambiguous.questions[0].stem.match(/<img\b/g)||[]).length,2);
  q.assets.splice(1);f.downloads.assets.splice(1);q.body=`${table}<img src="https://example.test/table-one.png">`;delete q.assets[0].placement;await f.save();
  const unknown=await buildLegacyExamBundle(f.root);assert.equal(unknown.sourceAudit.evidenceAssetPayloads.length,0);assert.equal(unknown.questions[0].assetPayloads.length,1);assert.match(unknown.questions[0].stem,/<img\b/);
});

test('simulated generic residual-plot terminology does not invent a missing figure but concrete shadow references stay blocked', async t => {
  const f=await fixture(t);
  f.source.occurrences[0].body='研究残差图中残差的分布特点，判断回归模型是否适合。';
  f.source.occurrences[1].body='求图中阴影部分所表示的集合。';
  f.source.occurrences[2].body='图中所示曲线的零点为______。';
  f.source.occurrences[3].body='如图，求相应面积。';await f.save();
  const bundle=await buildLegacyExamBundle(f.root);
  assert.ok(!bundle.questions[0].sourceIssues.some(i=>i.code==='legacy_figure_missing'));
  for(const index of [1,2,3]) assert.ok(bundle.questions[index].sourceIssues.some(i=>i.code==='legacy_figure_missing' && i.blocking));
});

test('simulated hash-bound source-review findings add blocking audit issues only to the exact occurrence without rewriting original content', async t => {
  const f=await fixture(t);const original=await buildLegacyExamBundle(f.root);
  const finding={examId:'258',occurrenceId:'6462',contentHash:f.source.occurrences[0].content_hash,originalPdfSha256:sha(f.pdf),code:'legacy_source_formula_mismatch',message:'模拟原卷核对：此题抽取公式与原 PDF 不一致，须人工恢复。',blocking:true};
  const unrelated={...finding,examId:'999',occurrenceId:'6463',message:'模拟另一试卷的审核记录不应混入。'};
  const before=structuredClone([finding,unrelated]);const bundle=await buildLegacyExamBundle(f.root,{reviewFindings:[finding,unrelated]});
  assert.deepEqual(bundle.questions[0].sourceIssues,[{code:finding.code,message:finding.message,blocking:true}]);
  assert.deepEqual(bundle.questions[0].sourceAudit.reviewFindings,[finding]);
  for(let i=1;i<bundle.questions.length;i++){
    assert.deepEqual(bundle.questions[i].sourceIssues,original.questions[i].sourceIssues);
    assert.deepEqual(bundle.questions[i].sourceAudit.reviewFindings,[]);
  }
  for(let i=0;i<bundle.questions.length;i++){
    const actual=bundle.questions[i], baseline=original.questions[i];
    for(const key of ['stem','options','parts','answer','solution','student','teacher','assetPayloads','sourceIdentity','pages','legacyReferences'])assert.deepEqual(actual[key],baseline[key],`source review must not change original-content field ${key}`);
    assert.deepEqual(actual.sourceAudit.rawContentSnapshot,baseline.sourceAudit.rawContentSnapshot);
  }
  assert.deepEqual(bundle.original,original.original);
  assert.deepEqual([finding,unrelated],before,'caller-provided hash-bound review records remain unchanged');
});

test('simulated source-review findings reject a wrong PDF hash, wrong question hash or missing explicit blocking flag', async t => {
  const f=await fixture(t);
  const valid={examId:258,occurrenceId:6462,contentHash:f.source.occurrences[0].content_hash,originalPdfSha256:sha(f.pdf),code:'legacy_source_formula_mismatch',message:'模拟原卷核对后发现公式不一致。',blocking:true};
  for(const invalid of [
    {...valid,originalPdfSha256:'0'.repeat(64)},
    {...valid,contentHash:'0'.repeat(64)},
    {...valid,blocking:false},
    Object.fromEntries(Object.entries(valid).filter(([key])=>key!=='blocking')),
  ])await assert.rejects(buildLegacyExamBundle(f.root,{reviewFindings:[invalid]}),/source-review identity or hash mismatch/);
  const accepted=await buildLegacyExamBundle(f.root,{reviewFindings:[valid]});
  assert.equal(accepted.questions[0].sourceIssues[0].code,'legacy_source_formula_mismatch');
  assert.equal(accepted.questions[0].sourceAudit.reviewFindings[0].originalPdfSha256,sha(f.pdf));
});
