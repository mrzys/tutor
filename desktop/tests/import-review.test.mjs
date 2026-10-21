import test from "node:test";
import assert from "node:assert/strict";
import { requiredReviewChecks, sourceReviewLabel, sourceReviewDescription, briefReviewReasons } from "../src/import-review.ts";

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
