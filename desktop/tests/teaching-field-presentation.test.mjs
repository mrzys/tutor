import test from "node:test";
import assert from "node:assert/strict";
import { teachingFieldPanel, teachingIssuePresentation, teachingStatusTitle } from "../src/teaching-field-presentation.ts";
const issue=(id,path,extra={})=>({id,domain:"teaching",message:"模拟意见",target:path?{fieldPath:path}:undefined,...extra});
test("simulated difficulty/focus findings stay in assessment; answer/proof findings stay in solution",()=>{
  const basis=issue("basis","difficultyAssessment.basis"),answer=issue("answer","answer");
  assert.equal(teachingFieldPanel("teachingFocus.studentRequirements[0]"),"assessment");
  assert.equal(teachingFieldPanel("teachingSolution"),"solution");
  const one=teachingIssuePresentation([basis,issue("teaching:review-failed")]);
  assert.equal(one.assessmentOnly,true);assert.deepEqual(one.solution,[]);assert.deepEqual(one.assessment,[basis]);
  assert.equal(teachingIssuePresentation([basis,answer]).assessmentOnly,false);
});
test("simulated exact metadata validation code belongs to assessment without inventing a field",()=>{
  const validation=issue("validation",undefined,{code:"invalid_annotation"});
  const p=teachingIssuePresentation([validation]);
  assert.equal(p.assessmentOnly,true);assert.deepEqual(p.assessment,[validation]);assert.equal(validation.target,undefined);
});
test("simulated network failures and unbound prose remain global even when their text mentions difficulty",()=>{
  const timeout=issue("timeout",undefined,{type:"technical",code:"model_response_timeout",message:"模拟：难度依据复核超时"});
  const prose=issue("prose",undefined,{message:"模拟：难度依据看起来有问题"});
  const p=teachingIssuePresentation([issue("basis","difficultyAssessment.basis"),timeout,prose]);
  assert.equal(p.assessmentOnly,false);assert.deepEqual(p.general,[timeout,prose]);
});

test("simulated assessment labels retain simultaneous timeout and current-operation states",()=>{
  const p=teachingIssuePresentation([issue("basis","difficultyAssessment.basis")]);
  const failure={kind:"review_failed",title:"解析复核未完成"};
  assert.equal(teachingStatusTitle({teachingWorkflow:{retainedInitialReason:"model_response_timeout"}},failure,p),failure.title);
  const mixed={teachingWorkflow:{retainedInitialReason:"teaching_patch_unresolved",effectiveFindings:[{type:"technical",code:"model_http_error"}]}};
  assert.equal(teachingStatusTitle(mixed,failure,p),failure.title);
  for(const kind of ["generating","reviewing","source_changed","publication_pending","adopted"]){
    assert.equal(teachingStatusTitle({}, {kind,title:"模拟当前状态"},p),"模拟当前状态");
  }
});

test("simulated retained content-only difficulty findings have a field-specific label without changing workflow",()=>{
  const question={teachingWorkflow:{status:"needs_review",reviewFailurePending:true,retainedInitialReason:"teaching_patch_unresolved",
    effectiveFindings:[{type:"quality",fieldPath:"difficultyAssessment.basis"},{type:"technical",code:"teaching_review_failed_retained_initial"}]}};
  const before=structuredClone(question),p=teachingIssuePresentation([issue("basis","difficultyAssessment.basis")]);
  assert.equal(teachingStatusTitle(question,{kind:"review_failed",title:"解析复核未完成"},p),"考查信息待核对");
  assert.deepEqual(question,before);
});
