import test from 'node:test';import assert from 'node:assert/strict';
import {reviewRowsForFilter,nextReviewQuestion,sourceFieldStatuses,reviewStatusLabel} from '../src/import-review-flow.ts';
const rows=[{questionId:'ready',eligible:true,published:false,needsAction:false},
  {questionId:'ai-held',eligible:true,published:false,needsAction:true,teachingState:'needs_review',question:{teachingWorkflow:{status:'needs_review'}}},
  {questionId:'source-held',eligible:false,published:false,needsAction:true},
  {questionId:'published',eligible:false,published:true,needsAction:false}].map(row=>({...row,duplicateState:'none'}));
test('simulated source-ready and teaching filters preserve independent original qualification',()=>{
  assert.deepEqual(reviewRowsForFilter(rows,'source_ready').map(row=>row.questionId),['ready','ai-held']);
  assert.deepEqual(reviewRowsForFilter(rows,'source_pending').map(row=>row.questionId),['source-held']);
  assert.deepEqual(reviewRowsForFilter(rows,'teaching').map(row=>row.questionId),['ai-held']);
  assert.equal(rows[1].eligible,true); // Publishing source only remains a separate allowed scope.
});
test('non-actionable duplicates and rejected sources never claim ready',()=>{
  assert.equal(reviewStatusLabel({...rows[0],duplicateState:'exact'}),'题库已有此题');
  assert.equal(reviewStatusLabel({...rows[0],question:{reviewDecision:'reject'}}),'本题未采用');
  assert.equal(reviewStatusLabel(rows[1]),'原题可入库');
});
test('next pending navigation wraps but cannot discard current unresolved work or select itself',()=>{
  const original=JSON.stringify(rows);
  assert.equal(nextReviewQuestion(rows,'source-held'),'ai-held');
  assert.equal(nextReviewQuestion(rows,'ai-held','previous'),'ready');
  assert.equal(nextReviewQuestion(rows,'published','next'),null);
  assert.equal(nextReviewQuestion([rows[1]],'ai-held'),null);
  assert.equal(JSON.stringify(rows),original);
});
test('field review labels come from actual original fields and checks, never AI answers or eligibility',()=>{
  const q={questionType:'single_choice',answer:'',solution:'',parts:[],reviewChecks:{sourceMatched:true,formulaChecked:true},teachingWorkflow:{finalResult:{answer:'A',teachingSolution:'AI稿'}}};
  assert.deepEqual(sourceFieldStatuses(q).map(x=>x.id),['stem','options','materials']);
  assert.ok(sourceFieldStatuses(q).every(x=>x.status==='checked'));
  assert.ok(sourceFieldStatuses(q,[],true).every(x=>x.status==='pending'));
  const issues=[{message:'选项待核',target:{fieldPath:'options[1].text'}}];
  assert.equal(sourceFieldStatuses(q,issues)[1].status,'issue');
  assert.deepEqual(sourceFieldStatuses({...q,parts:[{answer:'原卷答案',solution:'原卷推导'}]}).slice(-2).map(x=>x.id),['answer','solution']);
});
