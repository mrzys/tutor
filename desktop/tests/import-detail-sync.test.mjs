import test from "node:test";
import assert from "node:assert/strict";
import { mergeImportView, hasImportQuestionDetail, createImportRefreshQueue } from "../src/import-detail-sync.ts";
import { importTeachingStatus } from "../src/import-teaching-status.ts";
import { importAssessmentPresentation } from "../src/import-review.ts";
const full = id => ({questionId:id,stem:`模拟完整${id}`,assetPayloads:[{dataBase64:"simulated"}]});
const summary = id => ({questionId:id,stem:"",_detailLoaded:false});
const wait = ms => new Promise(resolve => setTimeout(resolve,ms));

test("simulated one-question fetch reuses only exact-snapshot details and keeps other questions unloaded",()=>{
  const a=full("a"),b=summary("b"),before={importId:"sim",questions:[a,b]};
  const result={summary:{importId:"sim",revision:7,questions:[summary("a"),summary("b"),summary("c")]},question:full("b"),detailVersion:"v1"};
  const next=mergeImportView(before,[a,b],"v1",result);
  assert.equal(next.record.questions[0],a);assert.equal(next.questions[1].stem,"模拟完整b");
  assert.equal(hasImportQuestionDetail(next.questions[2]),false);assert.deepEqual(next.reusedIds,["a"]);
  assert.equal(b._detailLoaded,false);
});
test("simulated changed snapshot invalidates cached content even at the same review revision",()=>{
  const before={importId:"sim",revision:7,questions:[full("a"),full("b")]};
  const next=mergeImportView(before,before.questions,"old",{summary:{...before,questions:[summary("a"),summary("b")]},question:full("b"),detailVersion:"new"});
  assert.equal(hasImportQuestionDetail(next.questions[0]),false);assert.equal(hasImportQuestionDetail(next.questions[1]),true);
  assert.throws(()=>mergeImportView(before,before.questions,"old",{summary:before,detailVersion:"new"},true),/未保存编辑已保留/);
});
test("simulated explicit reopen bypasses an unchanged import cache so derived bank bindings are re-read",()=>{
  const before={importId:"sim",questions:[full("a")]};
  const fresh=mergeImportView(before,before.questions,undefined,{summary:{importId:"sim",questions:[summary("a")]},detailVersion:"same"});
  assert.equal(hasImportQuestionDetail(fresh.questions[0]),false);
  assert.deepEqual(fresh.reusedIds,[]);
});
test("simulated loading another question preserves unsaved source text without changing its baseline",()=>{
  const baseline=full("a"),edited={...baseline,stem:"模拟教师未保存文字"},before={importId:"sim",questions:[baseline,summary("b")]};
  const next=mergeImportView(before,[edited,summary("b")],"same",{summary:before,question:full("b"),detailVersion:"same"},true);
  assert.equal(next.questions[0],edited);assert.equal(next.record.questions[0],baseline);assert.equal(next.questions[1].stem,"模拟完整b");
  assert.throws(()=>mergeImportView(before,[edited],"same",{summary:{...before,importId:"other"},detailVersion:"same"},true),/未保存编辑已保留/);
});
test("simulated navigation retains candidate-presence status without transferring its teaching text",()=>{
  const question={questionId:"sim-state",teachingWorkflow:{status:"needs_review",reviewCalls:0,candidateResult:{answer:"模拟答案",teachingSolution:"模拟完整推导"},findings:[{type:"term",term:"待核对术语"}]}};
  const compact={...question,_detailLoaded:false,teachingWorkflow:{...question.teachingWorkflow,_hasCandidate:true,candidateResult:{questionId:"sim-state",issues:[]}}};
  assert.deepEqual(importTeachingStatus(compact),importTeachingStatus(question));
  const forged={...compact,_detailLoaded:undefined};
  assert.notEqual(importTeachingStatus(forged).kind,"review_pending");
});
test("simulated unread assessment keeps the missing-path action without treating a structural hint as ready",()=>{
  const source="a".repeat(64),controls={sourceContentSha256:source,candidateSha256:"b".repeat(64),issues:[]};
  const candidate={questionId:"sim",answer:"2",teachingSolution:"模拟完整推导",issues:[]};
  for(const paths of [[],[{id:"sim-path",basis:"模拟解法依据"}]]){
    const question={questionId:"sim",difficultyAssessment:{level:"easy"},primaryKnowledgeUids:["sim-point"],task:{label:"模拟考点"},solutionPaths:paths,
      teachingWorkflow:{status:"ready_candidate",sourceContentSha256:source,finalResult:candidate,findings:[]}};
    const compact={...question,_detailLoaded:false,_needsSolutionPathSupplement:paths.length===0,solutionPaths:undefined,
      teachingWorkflow:{...question.teachingWorkflow,finalResult:{questionId:"sim",issues:[]}}};
    assert.equal(importAssessmentPresentation(compact,controls).needsSupplement,importAssessmentPresentation(question,controls).needsSupplement);
    assert.equal(importAssessmentPresentation({...compact,teachingWorkflow:{...compact.teachingWorkflow,status:"needs_review"}},controls).needsSupplement,false);
    assert.equal(importAssessmentPresentation({...question,_needsSolutionPathSupplement:true},controls).needsSupplement,paths.length===0);
  }
});
test("simulated burst events coalesce; an event during an in-flight read causes exactly one later refill",async()=>{
  let release,reads=0,active=0,max=0;
  const queue=createImportRefreshQueue(async()=>{reads++;max=Math.max(max,++active);if(reads===1)await new Promise(resolve=>release=resolve);active--;},0);
  for(let i=0;i<20;i++)queue.schedule();
  while(!release)await wait(1);
  for(let i=0;i<20;i++)queue.schedule();
  assert.equal(reads,1);release();await wait(20);
  assert.equal(reads,2);assert.equal(max,1);await wait(20);assert.equal(reads,2);
  queue.schedule();queue.dispose();await wait(10);assert.equal(reads,2);
});
