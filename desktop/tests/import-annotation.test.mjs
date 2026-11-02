import test from "node:test";
import assert from "node:assert/strict";
import { createImportAnnotationPlan, importAnnotationPlanCurrent } from "../src/import-annotation.ts";

const fixture = () => ({importId:"sim-whole-paper",filename:"模拟整卷.txt",revision:7,
  annotationQuestionIds:["a","c"],questions:[
    {questionId:"a",sourceLabel:"2",_detailLoaded:false},
    {questionId:"b",sourceLabel:"5",stem:"模拟已加载且标注完整的题"},
    {questionId:"c",sourceLabel:"9",_detailLoaded:false},
  ]});

test("simulated whole-paper annotation uses backend scope including unread questions",()=>{
  const record=fixture(),plan=createImportAnnotationPlan(record,"v1");
  assert.deepEqual(plan.questions,[{questionId:"a",label:"2"},{questionId:"c",label:"9"}]);
  const enriched={...record,questions:record.questions.map(q=>({...q,stem:"模拟刚读详情",_detailLoaded:undefined}))};
  assert.equal(importAnnotationPlanCurrent(plan,enriched,"v1"),true);
  assert.deepEqual(createImportAnnotationPlan(enriched,"v1").questions,plan.questions);
});

test("simulated confirmation freezes title and question scope without mutating the record",()=>{
  const record=fixture(),plan=createImportAnnotationPlan(record,"v1");
  record.annotationQuestionIds.push("b");record.questions[0].sourceLabel="22";record.filename="模拟另一次标题";
  assert.equal(plan.title,"模拟整卷.txt");assert.equal(plan.questions.length,2);assert.equal(plan.questions[0].label,"2");
  assert.equal(importAnnotationPlanCurrent(plan,record,"v1"),false);
});

test("simulated confirmation rejects another import, revision or checkpoint even when count stays equal",()=>{
  const record=fixture(),plan=createImportAnnotationPlan(record,"v1");
  for(const [next,version] of [[{...record,importId:"another"},"v1"],[{...record,revision:8},"v1"],
    [record,"new-checkpoint"],[{...record,annotationQuestionIds:["a","b"]},"v1"]]){
    assert.equal(importAnnotationPlanCurrent(plan,next,version),false);
  }
});

test("simulated malformed target scope cannot silently confirm a partial question list",()=>{
  for(const annotationQuestionIds of [undefined,["a","a"],["foreign"],[null]]) {
    assert.throws(()=>createImportAnnotationPlan({...fixture(),annotationQuestionIds},"v1"),/范围读取不完整/);
  }
  assert.throws(()=>createImportAnnotationPlan(fixture(),undefined),/范围读取不完整/);
});
