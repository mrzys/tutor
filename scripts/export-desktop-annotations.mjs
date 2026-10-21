import {DatabaseSync} from 'node:sqlite';
import {readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {hashContent} from './lib/integrity.mjs';

const args=process.argv.slice(2), option=name=>args[args.indexOf(name)+1];
for(const name of ['--database','--baseline-job','--seed','--output','--id']) if(!args.includes(name)||!option(name)) throw new Error(`Missing ${name}`);
const seed=JSON.parse(await readFile(option('--seed'),'utf8'));
const baseline=JSON.parse(await readFile(option('--baseline-job'),'utf8'));
const levels=new Set(['easy','easy_medium','medium','medium_hard','hard']);
const editable=['difficultyLevel','difficultyBasis','difficultyRubricVersion','knowledgeSchemaVersion','primaryKnowledgeUids','solutionPaths','primarySections','annotationSource','annotationUpdatedAt'];
const db=new DatabaseSync(option('--database'),{readOnly:true});
let manifest;
try {
  db.exec('BEGIN');
  // Deliberately read only the shared question bank and index; never personal.sqlite,
  // profiles, model settings, student records, papers, imports or raw model logs.
  const config=JSON.parse(db.prepare('SELECT value FROM bank_metadata WHERE key=?').get('config').value);
  const actual=new Map(config.assemblyIndex.entries.map(entry=>[entry.questionId,entry]));
  const base=new Map(seed.config.assemblyIndex.entries.map(entry=>[entry.questionId,entry]));
  const captured=new Map(baseline.items.map(item=>[item.questionId,item]));
  const entries=[];
  for(const expected of seed.questions){
    const id=expected.questionId,old=base.get(id),item=captured.get(id),next=actual.get(id);
    if(!old||!item||item.annotationSha256!==hashContent(old)) throw new Error(`${id}: pre-run annotation does not match the distributable seed`);
    const row=db.prepare('SELECT payload FROM bank_questions WHERE id=?').get(id);
    if(!row)throw new Error(`${id}: shared question is missing`);
    const q=JSON.parse(row.payload);
    for(const [role,version,sha] of [['student','contentVersion','contentSha256'],['teacher','teacherVersion','teacherSha256']]){
      if(q[version]!==expected[version]||hashContent(q[role])!==q[sha]||q[sha]!==expected[sha]||q.verification?.[version]!==q[version])throw new Error(`${id}: question content or version changed`);
    }
    if(q.verification?.result!=='pass'||next?.knowledgeSchemaVersion!==2||next?.annotationSource!=='model_reannotation'||next?.difficultyRubricVersion!=='content-demand-v1'||!Array.isArray(next?.primaryKnowledgeUids)||!Array.isArray(next?.solutionPaths))throw new Error(`${id}: full reannotation is incomplete`);
    if(next.difficultyLevel!==null&&(!levels.has(next.difficultyLevel)||next.difficultyBasis?.trim().length<8))throw new Error(`${id}: difficulty assessment is invalid`);
    const annotation=structuredClone(old);delete annotation.difficultyEstimate;
    for(const key of editable){if(Object.hasOwn(next,key))annotation[key]=next[key];else delete annotation[key];}
    entries.push({questionId:id,contentVersion:q.contentVersion,teacherVersion:q.teacherVersion,previousAnnotationSha256:item.annotationSha256,annotation});
  }
  manifest={id:option('--id'),sourceMigrationId:seed.migration.id,entries};
  db.exec('COMMIT');
} finally {db.close();}
const output=option('--output'),temporary=`${output}.${randomUUID()}.tmp`;
try{await writeFile(temporary,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});await rename(temporary,output);}finally{await unlink(temporary).catch(()=>{});}
console.log(JSON.stringify({id:manifest.id,entries:manifest.entries.length,manifestSha256:hashContent(manifest)}));
