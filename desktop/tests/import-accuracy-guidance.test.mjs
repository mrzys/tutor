import test from "node:test";
import assert from "node:assert/strict";
import { accuracyGuidance, accuracyGuidanceSummary } from "../src/import-accuracy-guidance.ts";

const question = (id = "simulated-q") => ({ questionId: id, accuracy: { strategyVersion: "import-two-model-v1", status: "needs_review", stage: "review",
  source: { status: "no_issue_found" }, mathematics: { status: "pending" }, teaching: { status: "pending" },
  canReview: true, reviewableDomains: ["source", "math", "teaching"], canRepair: true, findings: [] } });
const technical = (code, id = "simulated-q") => {
  const q = question(id); q.accuracy.findings = [{ id: "technical_failure", domain: "process", basis: code, message: "模拟：处理结果未完成" }]; return q;
};

test("simulated 19-question regression separates 10 invalid reports, 3 failed calls, 2 content cases and 4 ready", () => {
  const questions = Array.from({ length: 10 }, (_, index) => technical("accuracy_contract_invalid", `contract-${index}`));
  questions.push(...Array.from({ length: 3 }, (_, index) => technical("model_error", `model-${index}`)));
  for (const id of ["content-1", "content-2"]) { const q = question(id); q.accuracy.findings = [{ domain: "teaching", message: "模拟：任务身份未匹配", fieldPath: "task" }]; questions.push(q); }
  for (const id of ["ready-1", "ready-2", "ready-3", "ready-4"]) { const q = question(id); q.accuracy.status = "ready"; questions.push(q); }
  assert.deepEqual(accuracyGuidanceSummary(questions, {}), { technical: 13, content: 2, confirmation: 0, budget: 0, processing: 0 });
  assert.equal(accuracyGuidance(questions[0]).label, "复核报告异常");
  assert.equal(accuracyGuidance(questions[10]).label, "模型调用未完成");
});

test("lightweight technical findings preserve real codes and never infer a network failure", () => {
  const q = technical("unknown_process_code"); delete q.accuracy.findings[0].message;
  let guidance = accuracyGuidance(q);
  assert.equal(guidance.kind, "technical"); assert.equal(guidance.label, "处理异常");
  assert.equal(guidance.issues[0].code, "unknown_process_code"); assert.doesNotMatch(guidance.summary + guidance.nextStep, /网络/);
  q.accuracy.findings[0].code = "accuracy_contract_invalid"; q.accuracy.findings[0].basis = "模拟具体依据";
  guidance = accuracyGuidance(q); assert.equal(guidance.label, "复核报告异常");
  q.accuracy.findings[0].code = ""; assert.equal(accuracyGuidance(q).issues[0].code, "");
  q.accuracy.findings = [{ domain: "process", code: "accuracy_contract_invalid" }];
  assert.equal(accuracyGuidance(q).label, "复核报告异常");
});

test("technical guidance keeps other content findings without suggesting manual review or repair", () => {
  const q = technical("accuracy_contract_invalid"); q.accuracy.findings.push({ domain: "math", message: "模拟：端点需核查", fieldPath: "candidate.solution" });
  const guidance = accuracyGuidance(q);
  assert.equal(guidance.issues.length, 2); assert.match(guidance.summary, /另有 1 项/);
  assert.match(guidance.nextStep, /整卷.*继续未完成处理/); assert.match(guidance.nextStep, /复用成功结果.*沿用本次已用额度/);
  assert.equal(guidance.reviewDomain, undefined); assert.equal(guidance.canRepair, false);
});

test("review guidance respects candidate availability and backend domain permission", () => {
  const q = question(); q.accuracy.reviewableDomains = ["source"];
  let guidance = accuracyGuidance(q); assert.equal(guidance.reviewDomain, undefined); assert.equal(guidance.kind, "confirmation");
  assert.match(guidance.nextStep, /完整候选/);
  q.accuracy.reviewableDomains = ["source", "math", "teaching"];
  guidance = accuracyGuidance(q); assert.equal(guidance.reviewDomain, "math");
  q.accuracy.findings = [{ domain: "teaching", message: "模拟：任务身份尚未判明", fieldPath: "task" }];
  assert.equal(accuracyGuidance(q).reviewDomain, "teaching");
});

test("repair needs concrete content, backend permission and a checked source", () => {
  const q = question(); assert.equal(accuracyGuidance(q).canRepair, false);
  q.accuracy.findings = [{ domain: "math", message: "模拟：漏写端点验证", fieldPath: "candidate.solution" }];
  assert.equal(accuracyGuidance(q).canRepair, true);
  q.accuracy.source.status = "unresolved"; assert.equal(accuracyGuidance(q).canRepair, false);
  q.accuracy.source.status = "teacher_reviewed"; q.accuracy.canRepair = false; assert.equal(accuracyGuidance(q).canRepair, false);
});

test("only backend overall ready or explicit eligibility grants the ready reading state; published takes priority", () => {
  const q = question(); q.accuracy.mathematics.status = "no_issue_found"; q.accuracy.teaching.status = "teacher_reviewed";
  assert.equal(accuracyGuidance(q).kind, "confirmation");
  assert.equal(accuracyGuidance(q, true).kind, "ready");
  q.accuracy.status = "ready"; assert.equal(accuracyGuidance(q).kind, "ready");
  q.accuracy.status = "published"; assert.equal(accuracyGuidance(q, true).kind, "published");
});

test("budget and processing remain separate from content errors; absent references do not require invented answers", () => {
  const q = question(); q.accuracy.status = "budget_paused"; q.accuracy.budget = { reason: "模拟额度暂停" };
  assert.equal(accuracyGuidance(q).kind, "budget");
  q.accuracy.status = "running"; assert.equal(accuracyGuidance(q).kind, "processing");
  q.accuracy.status = "needs_review"; q.accuracy.source.status = "unresolved";
  q.accuracy.findings = [{ domain: "source", fieldPath: "originalReference.answer", message: "模拟：原卷没有参考答案" }];
  assert.match(accuracyGuidance(q).nextStep, /无需补造/); assert.match(accuracyGuidance(q).nextStep, /未判不等同题目错误/);
});

test("old records stay outside this guidance and all classification is read-only", () => {
  assert.equal(accuracyGuidance({ modelReview: { status: "ready" } }), null);
  const q = technical("model_error"), before = structuredClone(q);
  const guidance = accuracyGuidance(q); guidance.issues[0].message = "模拟仅改变显示副本";
  accuracyGuidanceSummary([q], { [q.questionId]: { eligible: true } });
  assert.deepEqual(q, before);
});
