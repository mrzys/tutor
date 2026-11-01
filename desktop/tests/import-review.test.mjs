import test from "node:test";
import assert from "node:assert/strict";
import { requiredReviewChecks, sourceReviewLabel, sourceReviewDescription, briefReviewReasons, importTeachingPresentation, importAssessmentPresentation, hasUnstartedTeaching,
  teachingIssueRows, teachingAcknowledgementPayload, teachingPatchPayload } from "../src/import-review.ts";

test('simulated assessment: ready draft fills display gaps without inventing formal knowledge or paths', () => {
  const q = {difficultyAssessment:{level:null},primaryKnowledgeUids:[],solutionPaths:[],task:{id:'',label:''},teachingWorkflow:{status:'ready_candidate',finalResult:{difficultyAssessment:{level:'easy_medium',basis:'定义域与包含关系'},teachingFocus:{examFocus:'判断充分必要条件'},teachingSolution:'完整解析',issues:[]}}};
  const original = JSON.stringify(q);
  const view = importAssessmentPresentation(q);
  assert.equal(view.level,'easy_medium');
  assert.equal(view.examFocus,'判断充分必要条件');
  assert.equal(view.difficultyOrigin,'AI内容估计');
  assert.equal(view.hasTeachingSolution,true);
  assert.equal(view.needsSupplement,true);
  assert.deepEqual(view.paths,[]);
  assert.equal(JSON.stringify(q),original);
});

test('simulated assessment: manual difficulty wins and pending drafts never become usable assessments', () => {
  const q = {difficultyAssessment:{level:'medium',basis:'人工依据'},task:{id:'t',label:'正式任务'},primaryKnowledgeUids:['k'],solutionPaths:[{id:'p'}],teachingWorkflow:{status:'needs_review',candidateResult:{difficultyAssessment:{level:'hard'},teachingFocus:{examFocus:'待核考点'},teachingSolution:'问题稿'}}};
  const view=importAssessmentPresentation(q);
  assert.equal(view.level,'medium'); assert.equal(view.basis,'人工依据');
  assert.equal(view.examFocus,'正式任务'); assert.equal(view.needsSupplement,false);
  assert.equal(view.hasTeachingSolution,false); assert.equal(view.teachingSolutionPending,true);
  assert.equal(importAssessmentPresentation({...q,knowledgeMappingSource:'teacher_edit',teachingWorkflow:{...q.teachingWorkflow,status:'ready_candidate',finalResult:q.teachingWorkflow.candidateResult}}).examFocus,'正式任务');
  assert.equal(importAssessmentPresentation({...q,difficultyAssessment:{level:null}}).level,null);
});

test('simulated assessment: stale bindings and failed review holds never supply effective metadata', () => {
  const q = {teachingWorkflow:{status:'ready_candidate',sourceContentSha256:'a'.repeat(64),finalResult:{difficultyAssessment:{level:'medium'},teachingFocus:{examFocus:'旧考点'},teachingSolution:'旧稿'}}};
  const control = {sourceContentSha256:'a'.repeat(64),candidateSha256:'c'.repeat(64)};
  assert.equal(importAssessmentPresentation(q,control).level,'medium');
  assert.equal(importAssessmentPresentation(q,{...control,sourceContentSha256:'b'.repeat(64)}).level,null);
  assert.equal(importAssessmentPresentation(q,{...control,candidateSha256:null}).examFocus,'');
  q.teachingWorkflow.reviewFailurePending=true;
  assert.equal(importAssessmentPresentation(q,control).level,null);
});

test("simulated review: absent answers and solutions require only source and material checks", () => {
  assert.deepEqual(requiredReviewChecks({answer:"",solution:"",parts:[]}), ["sourceMatched","formulaChecked"]);
  assert.deepEqual(requiredReviewChecks({answer:" ",solution:"\n",legacyReferences:{answers:[{text:"generated reference"}]}}), ["sourceMatched","formulaChecked"]);
});
test("simulated review: each source field independently adds its applicable check", () => {
  assert.deepEqual(requiredReviewChecks({answer:"A"}), ["sourceMatched","formulaChecked","answerChecked"]);
  assert.deepEqual(requiredReviewChecks({solution:"source derivation"}), ["sourceMatched","formulaChecked","solutionChecked"]);
  assert.deepEqual(requiredReviewChecks({parts:[{answer:"1"},{solution:"source steps"}]}), ["sourceMatched","formulaChecked","answerChecked","solutionChecked"]);
});

test("simulated review: non-choice questions do not ask the teacher to inspect options", () => {
  for (const questionType of ["fill_blank", "free_response"]) {
    assert.equal(sourceReviewLabel({questionType}), "题干与小问");
    assert.ok(!sourceReviewDescription({questionType}).includes("选项"));
  }
  assert.equal(sourceReviewLabel({questionType:"single_choice"}), "题干与选项");
});

test("simulated review: brief reasons prioritize content concerns without changing the audit", () => {
  const question = {questionType:"fill_blank",modelReview:{status:"needs_review",summary:"原有完整意见",issues:[
    {field:"answer",message:"旧意见：原卷没有答案"},
    {field:"solution",message:"旧意见：原卷没有解析"},
    {field:"stem",message:"题干第二处填空前文字需核对"},
  ]}};
  const before = JSON.stringify(question);
  assert.deepEqual(briefReviewReasons(question), ["题干或小问需核对"]);
  assert.equal(JSON.stringify(question), before);
  assert.deepEqual(briefReviewReasons({modelReview:{status:"stale"}}), ["题目已修改，请重新检查"]);
});

test("simulated review: generated teaching stays separate and unresolved findings stay visible", () => {
  const q = {answer:"",solution:"",modelReview:{status:"ready",summary:"原文检查正常"},teachingWorkflow:{status:"needs_review",candidateResult:{answer:"A",teachingSolution:"由柯西不等式得。"},findings:[{type:"term",term:"柯西不等式"}]}};
  const before=JSON.stringify(q);
  assert.deepEqual(requiredReviewChecks(q),["sourceMatched","formulaChecked"]);
  assert.deepEqual(briefReviewReasons(q,"教学稿待复核：术语“柯西不等式”"),["教学稿待复核：术语“柯西不等式”"]);
  const view=importTeachingPresentation(q);
  assert.equal(view.ready,false); assert.equal(view.answer,"A");assert.match(view.issues[0],/柯西不等式/);
  assert.equal(JSON.stringify(q),before);
  assert.equal(importTeachingPresentation({}),null);
  assert.equal(importTeachingPresentation({teachingWorkflow:{status:"ready_candidate",initialCandidate:{answer:"旧"},finalResult:{answer:"新",teachingSolution:"新解析"}}}).answer,"新");
});

test("simulated review: continue only exposes unspent teaching work", () => {
  const q=(status,reviewCalls=0,extra={})=>({teachingWorkflow:{status,reviewCalls,...extra}});
  assert.equal(hasUnstartedTeaching(q("needs_review",0,{findings:[{code:"model_catalog_error"}]})),true);
  assert.equal(hasUnstartedTeaching(q("needs_review",1)),false);
  assert.equal(hasUnstartedTeaching(q("ready_candidate")),false);
  assert.equal(hasUnstartedTeaching(q("generation_pending")),true);
  assert.equal(hasUnstartedTeaching(q("generation_failed",0,{reviewEligible:true})),true);
  assert.equal(hasUnstartedTeaching(q("generation_failed",0,{reviewEligible:false})),false);
  for(const code of ["source_changed","generation_interrupted","review_interrupted"]) assert.equal(hasUnstartedTeaching(q("needs_review",0,{findings:[{code}]})),false);
});

test("simulated teaching display translates codes while every unresolved finding still blocks readiness", () => {
  for (const code of ["literal_newline_escape", "unpaired_math_delimiter", "future_display_defect"]) {
    const question = { teachingWorkflow: { status: "ready_candidate", finalResult: { answer: "2", teachingSolution: "模拟解析" }, findings: [{ type: "display", code }] } };
    const before = structuredClone(question);
    const view = importTeachingPresentation(question);
    assert.equal(view.ready, false);
    assert.equal(view.issues.length, 1);
    assert.match(view.issues[0], /解析/);
    assert.ok(!view.issues[0].includes(code));
    if (code === "literal_newline_escape") assert.equal(view.issues[0], "解析中存在未正确处理的换行符，需修复排版");
    assert.deepEqual(question, before);
  }
});

function simulatedTeachingControls() {
  const issue = "模拟：原参考末行变量笔误，新稿已独立核对正确。";
  const candidate = { answer: "2", teachingSolution: "模拟已核对讲解：$1+1=2$。", issues: [issue] };
  const question = { questionId: "simulated-teaching-q", teachingWorkflow: { status: "needs_review", candidateResult: candidate,
    findings: [{ type: "model_issue", issue }, { type: "term", term: "模拟待核词" }] } };
  const controls = { sourceContentSha256: "a".repeat(64), candidateSha256: "b".repeat(64),
    canPatch: true, canAcknowledge: true,
    issues: [{ issueIndex: 0, issue, issueSha256: "c".repeat(64), disposition: "blocking", acknowledged: false, acknowledgeable: true }],
    editableFields: [{ path: "teachingSolution", value: candidate.teachingSolution }, { path: "teachingFocus.studentRequirements[0]", value: "模拟要求" }] };
  return { record: { importId: "simulated-import", revision: 4 }, question, controls };
}

test("simulated teaching notices keep raw opinions and never hide term/source failures", () => {
  const { question, controls } = simulatedTeachingControls();
  controls.issues[0] = { ...controls.issues[0], disposition: "informative", acknowledged: true, basis: "模拟已对照原页和新稿验算。" };
  const before = structuredClone(question);
  const view = importTeachingPresentation(question, controls);
  assert.equal(view.notices.length, 1);
  assert.deepEqual(view.issues, ["仍含需复核术语“模拟待核词”"]);
  assert.equal(view.ready, false);
  assert.deepEqual(question, before);
  controls.issues[0].issue = "其它意见不能代替原意见";
  assert.equal(teachingIssueRows(question, controls)[0].disposition, "blocking");
  assert(importTeachingPresentation(question, controls).issues.includes(question.teachingWorkflow.candidateResult.issues[0]));
});

test("simulated duplicate issue text does not allow one acknowledgement to hide another issue", () => {
  const { question, controls } = simulatedTeachingControls();
  question.teachingWorkflow.candidateResult.issues.push(question.teachingWorkflow.candidateResult.issues[0]);
  controls.issues[0] = { ...controls.issues[0], disposition: "informative", acknowledged: true };
  const view = importTeachingPresentation(question, controls);
  assert.equal(view.notices.length, 1);
  assert(view.issues.includes(question.teachingWorkflow.candidateResult.issues[1]));
});

test("simulated stale ready label cannot hide an unacknowledged original issue", () => {
  const { question, controls } = simulatedTeachingControls();
  question.teachingWorkflow.status = "ready_candidate";
  question.teachingWorkflow.finalResult = structuredClone(question.teachingWorkflow.candidateResult);
  question.teachingWorkflow.findings = [];
  assert.equal(importTeachingPresentation(question, controls).ready, false);
  assert.equal(importTeachingPresentation(question, controls).issues.length, 1);
});

test("simulated explicit acknowledgement binds one current issue and requires actual checks and basis", () => {
  const { record, question, controls } = simulatedTeachingControls();
  const checks = { sourceMatched: true, answerChecked: true, solutionChecked: true, formulaChecked: true };
  const before = structuredClone({ record, question, controls });
  const payload = teachingAcknowledgementPayload(record, question, controls, controls.issues[0], "reference_notice", " 模拟逐项验算并核对了原卷变量名。 ", checks);
  assert.equal(payload.questionId, question.questionId);
  assert.equal(payload.expectedRevision, 4);
  assert.equal(payload.candidateSha256, controls.candidateSha256);
  assert.equal(payload.issueIndex, 0);
  assert.equal(payload.basis, "模拟逐项验算并核对了原卷变量名。");
  assert.equal(Object.hasOwn(payload, "questions"), false);
  assert.equal(Object.hasOwn(payload, "reviewer"), false);
  for (const [kind, basis, changedChecks] of [["fatal", "模拟依据", checks], ["reference_notice", " ", checks], ["reference_notice", "模拟依据", { ...checks, answerChecked: false }]]) {
    assert.throws(() => teachingAcknowledgementPayload(record, question, controls, controls.issues[0], kind, basis, changedChecks));
  }
  assert.throws(() => teachingAcknowledgementPayload(record, question, { ...controls, canAcknowledge: false }, controls.issues[0], "reference_notice", "模拟依据", checks));
  assert.throws(() => teachingAcknowledgementPayload(record, question, controls, { ...controls.issues[0], issueSha256: "d".repeat(64) }, "reference_notice", "模拟依据", checks));
  assert.deepEqual({ record, question, controls }, before);
});

test("simulated patch construction cannot expand fields, erase issues or replace stale text", () => {
  const { record, question, controls } = simulatedTeachingControls();
  const oldText = controls.editableFields[0].value;
  const payload = teachingPatchPayload(record, question, controls, "teachingSolution", oldText, "模拟修订：$1+1=2$。", "模拟仅补说明，已核对结论。");
  assert.deepEqual(payload.patches, [{ fieldPath: "teachingSolution", oldText, newText: "模拟修订：$1+1=2$。" }]);
  assert.equal(payload.sourceContentSha256, controls.sourceContentSha256);
  for (const fieldPath of ["stem", "questionId", "issues[0]", "difficultyAssessment.level", "teachingFocus.studentRequirements", "__proto__.value"]) {
    const widened = { ...controls, editableFields: [...controls.editableFields, { path: fieldPath, value: oldText }] };
    assert.throws(() => teachingPatchPayload(record, question, widened, fieldPath, oldText, "模拟任意改写", "模拟依据"));
  }
  assert.throws(() => teachingPatchPayload(record, question, controls, "teachingSolution", "过期内容", "模拟新内容", "模拟依据"));
  assert.throws(() => teachingPatchPayload(record, question, controls, "teachingSolution", oldText, oldText, "模拟依据"));
  assert.throws(() => teachingPatchPayload(record, question, controls, "teachingSolution", oldText, "", "模拟依据"));
  assert.throws(() => teachingPatchPayload(record, question, { ...controls, candidateSha256: "" }, "teachingSolution", oldText, "模拟新内容", "模拟依据"));
});
