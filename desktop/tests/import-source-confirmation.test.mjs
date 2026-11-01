import test from "node:test";
import assert from "node:assert/strict";
import { sourceConfirmationScopeLabel, sourceConfirmationUpdate } from "../src/import-source-confirmation.ts";

const selected = () => ({
  questionId: "simulated-q18", questionType: "free_response", sourceLabel: "18", pages: [4],
  stem: "模拟原题：直线交于不同于 $A$ 的两点 $M,N$。", options: [], parts: [], answer: "", solution: "",
  reviewDecision: "pending", reviewIssues: [], reviewChecks: { sourceMatched: false, formulaChecked: false, answerChecked: false, solutionChecked: false, unknownFutureCheck: false },
  reviewBasis: "", modelReview: { status: "needs_review", issues: [{ field: "p4-b5", message: "模拟：OCR漏不字，已按原页恢复。" }] },
  teachingWorkflow: { status: "needs_review", candidateResult: { answer: "模拟答案", teachingSolution: "模拟待复核解析", issues: ["模拟证明不足"] }, findings: [{ type: "quality", dimension: "proof" }] },
  futureMetadata: { preserved: true },
});
function fixture(question = selected()) {
  return { importId: "simulated-import", revision: 7, publishedQuestionIds: [], pendingPublication: null, pendingTeachingPublication: null,
    questions: [{ ...selected(), questionId: "simulated-q1", sourceLabel: "1" }, question], futureRecordField: "preserved" };
}
const confirm = (record, extra = {}) => sourceConfirmationUpdate(record, "simulated-q18", { confirmed: true, hardIssues: [], ...extra });

test("simulated single-question confirmation cannot save another question's unsaved edit", () => {
  const record=fixture(), persisted=structuredClone(record.questions);
  record.questions[0].stem="模拟另一题尚未保存的题干修改";
  assert.throws(()=>confirm(record,{persistedQuestions:persisted}),/其他题有未保存修改/);
  record.questions[0]=persisted[0];record.questions[1].stem+="（模拟当前题修正）";
  const payload=confirm(record,{persistedQuestions:persisted});
  assert.deepEqual(payload.questions[0],persisted[0]);
  assert.equal(payload.questions[1].reviewDecision,"approve");
});

test("simulated source confirmation requires an explicit user action and current blocker projection", () => {
  const record = fixture(), before = structuredClone(record);
  for (const value of [false, undefined, "true", 1]) assert.throws(() => confirm(record, { confirmed: value }), /明确确认/);
  assert.throws(() => confirm(record, { hardIssues: undefined }), /检查结果/);
  assert.deepEqual(record, before);
});

test("simulated OCR correction confirmation changes only current source review and never adopts AI", () => {
  const record = fixture(), before = structuredClone(record), question = record.questions[1];
  const payload = confirm(record);
  assert.equal(payload.importId, record.importId);
  assert.equal(payload.expectedRevision, 7);
  assert.equal(payload.questions[0], record.questions[0]);
  const changed = payload.questions[1];
  assert.notEqual(changed, question);
  assert.equal(changed.reviewDecision, "approve");
  assert.equal(changed.reviewChecks.sourceMatched, true);
  assert.equal(changed.reviewChecks.formulaChecked, true);
  assert.equal(changed.reviewChecks.answerChecked, false);
  assert.equal(changed.reviewChecks.solutionChecked, false);
  assert.equal(changed.reviewChecks.unknownFutureCheck, false);
  assert.match(changed.reviewBasis, /用户明确确认已对照原卷/);
  assert.doesNotMatch(changed.reviewBasis, /独立验算|数学正确|已核对解析|OCR漏不字/);
  for (const field of Object.keys(question).filter(key => !["reviewDecision", "reviewChecks", "reviewBasis"].includes(key))) assert.equal(changed[field], question[field], field);
  assert.equal(changed.teachingWorkflow.status, "needs_review");
  assert.deepEqual(record, before);
});

test("simulated original references in subparts are confirmed while absent source references stay absent", () => {
  const question = selected();
  question.parts = [{ partId: "p1", prompt: "模拟小问", answer: "原卷答案", solution: "原卷解析" }];
  const result = confirm(fixture(question)).questions[1];
  assert.equal(result.reviewChecks.answerChecked, true);
  assert.equal(result.reviewChecks.solutionChecked, true);
  assert.equal(result.answer, "");
  assert.equal(result.solution, "");
  assert.equal(result.parts, question.parts);
  assert.match(sourceConfirmationScopeLabel(question), /原卷答案、原卷解析/);
  const choice = { ...selected(), questionType: "single_choice" };
  assert.match(sourceConfirmationScopeLabel(choice), /^题干与选项/);
  assert.doesNotMatch(sourceConfirmationScopeLabel(selected()), /原卷答案|原卷解析/);
});

test("simulated published, frozen, active and hard-blocked sources cannot use compact confirmation", () => {
  for (const status of ["queued", "running"]) assert.throws(() => confirm({ ...fixture(), backgroundJob: { status } }), /正在处理/);
  assert.throws(() => confirm({ ...fixture(), publishedQuestionIds: ["simulated-q18"] }), /已入库/);
  for (const field of ["pendingPublication", "pendingTeachingPublication"]) assert.throws(() => confirm({ ...fixture(), [field]: { frozen: true } }), /上一次入库/);
  assert.throws(() => confirm(fixture(), { hardIssues: ["模拟：必要配图缺失"] }), /先修正/);
  const q = selected(); q.reviewIssues = ["模拟源字段不完整"];
  assert.throws(() => confirm(fixture(q)), /先修正/);
});

test("simulated version/identity failures cannot produce a review-save payload", () => {
  for (const revision of [undefined, -1, 1.5, "7"]) assert.throws(() => confirm({ ...fixture(), revision }), /版本信息/);
  assert.throws(() => sourceConfirmationUpdate(fixture(), "unknown", { confirmed: true, hardIssues: [] }), /身份/);
  const record = fixture(); record.questions.push(selected());
  assert.throws(() => confirm(record), /身份不唯一/);
});

test("simulated optional note preserves existing basis, is idempotent and respects backend length limit", () => {
  const record = fixture();record.questions[1].reviewBasis = "模拟：先前已对照第4页。";
  const once = confirm(record, { note: "确认已恢复不同于A。" });
  assert.match(once.questions[1].reviewBasis, /^模拟：先前已对照第4页。/);
  assert.match(once.questions[1].reviewBasis, /补充备注：确认已恢复不同于A。/);
  const again = confirm({ ...record, questions: once.questions }, { note: "确认已恢复不同于A。" });
  assert.equal(again.questions[1].reviewBasis, once.questions[1].reviewBasis);
  assert.throws(() => confirm(record, { note: 5 }), /备注格式/);
  assert.throws(() => confirm(record, { note: "长".repeat(5000) }), /5000/);
});
