import test from "node:test";
import assert from "node:assert/strict";
import { importTeachingStatus } from "../src/import-teaching-status.ts";

const q = (workflow = {}) => ({ questionId: "simulated-question", teachingWorkflow: { status: "needs_review", generationCalls: 1, reviewCalls: 0, ...workflow } });
const candidate = { answer: "模拟答案", teachingSolution: "模拟保留的解析" };
const term = (value = "凹凸") => ({ type: "term", term: value, fieldPath: "teachingSolution" });
const row = (question, state, issues = []) => ({ questionId: question.questionId, teachingState: state, issues });
const issue = (id, message, extra = {}) => ({ id, domain: "teaching", message, location: "unavailable", ...extra });

test("模拟q10：有完整候选和术语命中但尚未使用复核，不显示生成失败", () => {
  const question = q({ candidateResult: candidate, findings: [term("\\int"), term()] });
  const before = structuredClone(question);
  const result = importTeachingStatus(question);
  assert.equal(result.kind, "review_pending");
  assert.equal(result.title, "解析有疑点，尚未执行复核");
  assert.equal(result.actionHint, "continue_workflow");
  assert.equal(result.reasons.length, 2);
  assert.ok(result.reasons.some(reason => reason.includes("凹凸")));
  assert.deepEqual(question, before);
});

test("模拟q11/12：实际响应超时属于生成失败，具体总预算原因保留", () => {
  for (const id of ["simulated-q11", "simulated-q12"]) {
    const question = { ...q({ status: "generation_failed", findings: [{ type: "technical", code: "model_response_timeout", message: "读取模型响应超时（请求总预算120秒），已有内容保留，请显式重试。" }] }), questionId: id };
    const result = importTeachingStatus(question);
    assert.equal(result.kind, "generation_failed");
    assert.equal(result.actionHint, "retry_generation");
    assert.deepEqual(result.reasons, ["读取模型响应超时（请求总预算120秒），已有内容保留，请显式重试。"]);
  }
});

test("模拟旧JSON生成失败：只凭无候选和具体技术码识别，不把内部码直接显示", () => {
  const question = q({ reviewEligible: true, findings: [{ type: "technical", code: "model_output_invalid_json", message: "model_output_invalid_json" }] });
  const result = importTeachingStatus(question);
  assert.equal(result.kind, "generation_failed");
  assert.equal(result.actionHint, "retry_generation");
  assert.deepEqual(result.reasons, ["模型返回的解析数据格式有误"]);
  const withCandidate = q({ candidateResult: candidate, findings: [term(), { type: "technical", code: "model_output_invalid_json" }] });
  assert.equal(importTeachingStatus(withCandidate).kind, "review_pending");
});

test("模拟q6：复核未完成优先展示真实考查信息错误，保留其余待核对原因", () => {
  const message = "已评估难度需填写具体依据（至少8字）；无法判断时使用未评估。";
  const question = q({ candidateResult: candidate, reviewCalls: 1, reviewFailurePending: true, retainedInitialReason: "invalid_annotation", retainedInitialMessage: message,
    findings: [term("目标式"), { type: "technical", code: "invalid_annotation", message }] });
  const result = importTeachingStatus(question);
  assert.equal(result.kind, "review_failed");
  assert.equal(result.actionHint, "edit_content");
  assert.equal(result.reasons[0], message);
  assert.equal(result.reasons.length, 2);
  assert.ok(result.reasons[1].includes("目标式"));
});

test("模拟q19：受限补丁未解决是复核未完成，不能降成生成失败或已就绪", () => {
  const question = q({ candidateResult: candidate, reviewCalls: 1, reviewFailurePending: true, retainedInitialReason: "teaching_patch_unresolved", retainedInitialMessage: "受限复核尚未解决。", findings: [term("下界")] });
  const result = importTeachingStatus(question);
  assert.equal(result.kind, "review_failed");
  assert.equal(result.reasons[0], "受限复核尚未解决。");
  assert.ok(result.reasons[1].includes("下界"));
  assert.equal(result.actionHint, "edit_content");
});

test("模拟正常返回但仍有内容疑点与复核技术失败分开", () => {
  const question = q({ candidateResult: candidate, reviewCalls: 1, reviewFailurePending: false, retainedInitialReason: "review_findings_remaining", findings: [term()] });
  const result = importTeachingStatus(question);
  assert.equal(result.kind, "content_issues");
  assert.equal(result.title, "复核后仍有内容疑点");
  assert.equal(result.actionHint, "edit_content");
});

test("模拟生成/复核运行中优先显示本次实际阶段，不沿用旧保留失败信息", () => {
  const question = q({ reviewFailurePending: true, retainedInitialReason: "invalid_annotation", findings: [term()] });
  for (const [activeStage, kind] of [["teaching_generation", "generating"], ["teaching_review", "reviewing"], ["teaching_check", "checking"]]) {
    const result = importTeachingStatus(question, { activeStage });
    assert.equal(result.kind, kind);
    assert.equal(result.actionHint, "none");
    assert.deepEqual(result.reasons, []);
  }
  assert.equal(importTeachingStatus(q({ status: "generating" })).kind, "generating");
  assert.equal(importTeachingStatus(q({ status: "reviewing" })).kind, "reviewing");
  const queued = importTeachingStatus(question, { triage: row(question, "generating") });
  assert.equal(queued.kind, "processing");
  assert.equal(queued.title, "正在处理本题解析");
  assert.equal(queued.actionHint, "none");
});

test("模拟原题改变使旧解析需核对，不能因旧ready标签显示就绪", () => {
  const question = q({ status: "needs_review", candidateResult: candidate, findings: [{ type: "technical", code: "source_changed", message: "题面或原卷参考已修改，旧教学稿失效，需重新核对。" }] });
  const result = importTeachingStatus(question, { triage: row(question, "needs_review") });
  assert.equal(result.kind, "source_changed");
  assert.equal(result.actionHint, "view_details");
  assert.deepEqual(result.reasons, ["题面或原卷参考已修改，旧教学稿失效，需重新核对。"]);
});

test("模拟同题现行triage只保留未解决问题，已核对提醒和一般过程状态不复活", () => {
  const question = q({ candidateResult: candidate, reviewCalls: 1, findings: [term(), term("上界")] });
  const current = row(question, "needs_review", [issue("teaching:finding-2", "仍含需复核术语“上界”", { type: "term", term: "上界" }), issue("teaching:review-failed", "复核未完成，初稿已保留，仍需核对")]);
  const result = importTeachingStatus(question, { triage: current });
  assert.deepEqual(result.reasons, ["仍含需复核术语“上界”"]);
  const unrelated = { ...current, questionId: "some-other-question" };
  assert.equal(importTeachingStatus(question, { triage: unrelated }).reasons.length, 2);
});

test("模拟ready/adopted采用现有状态投影，不制造数学正确率或发布资格", () => {
  const question = q({ status: "ready_candidate", finalResult: candidate, findings: [], retainedInitialReason: "invalid_annotation" });
  assert.equal(importTeachingStatus(question).kind, "ready");
  assert.equal(importTeachingStatus(question, { triage: row(question, "adopted") }).kind, "adopted");
  const unready = importTeachingStatus(question, { triage: row(question, "needs_review", [issue("teaching:finding-0", "尚有一项说明需核对")]) });
  assert.equal(unready.kind, "review_pending");
  for (const view of [importTeachingStatus(question), unready]) {
    assert.ok(!("eligible" in view));
    assert.ok(!("canPublish" in view));
    assert.ok(!("independentAccuracy" in view));
  }
});

test("模拟缺少完整triage的旧记录：具体复核技术原因不丢失，矛盾ready标签不遮盖现行疑点", () => {
  const failed = q({ status: "review_failed", findings: [{ type: "technical", code: "model_response_timeout", message: "复核读取响应超时，初稿已保留。" }] });
  assert.deepEqual(importTeachingStatus(failed, { triage: row(failed, "failed") }).reasons, ["复核读取响应超时，初稿已保留。"]);
  const contradictory = q({ status: "ready_candidate", candidateResult: candidate, findings: [term()] });
  assert.equal(importTeachingStatus(contradictory).kind, "review_pending");
});

test("模拟旧格式修复复核失败：没有可保留的有效初稿也不混为生成失败", () => {
  const question = q({ reviewCalls: 1, findings: [{ type: "technical", code: "invalid_teaching_patch", message: "复核提交了未授权句段，修改未采用。" }] });
  const result = importTeachingStatus(question);
  assert.equal(result.kind, "review_failed");
  assert.deepEqual(result.reasons, ["复核提交了未授权句段，修改未采用。"]);
  assert.equal(result.actionHint, "edit_content");
});

test("模拟已用复核的旧JSON生成失败：全technical且无候选时提示显式重试生成，额度不重置", () => {
  for (const reviewFailurePending of [undefined, true]) {
    const question = q({ reviewCalls: 1, reviewEligible: false, reviewFailurePending,
      findings: [{ type: "technical", code: "model_output_invalid_json" }, { type: "technical", code: "invalid_teaching_candidate" }] });
    const before = structuredClone(question);
    const result = importTeachingStatus(question);
    assert.equal(result.kind, "generation_failed");
    assert.equal(result.actionHint, "retry_generation");
    assert.deepEqual(result.reasons, ["模型返回的解析数据格式有误", "模型返回的解析候选不符合要求"]);
    assert.deepEqual(question, before);
    assert.equal(question.teachingWorkflow.reviewCalls, 1);
  }
});

test("模拟显式本次生成失败优先于历史复核次数或保留失败标记", () => {
  const question = q({ status: "generation_failed", reviewCalls: 1, reviewFailurePending: true,
    retainedInitialReason: "invalid_teaching_patch", retainedInitialMessage: "历史复核句段有误。",
    findings: [{ type: "technical", code: "model_response_timeout", message: "本次解析生成读取响应超时。" }] });
  const before = structuredClone(question);
  const result = importTeachingStatus(question);
  assert.equal(result.kind, "generation_failed");
  assert.equal(result.actionHint, "retry_generation");
  assert.deepEqual(result.reasons, ["本次解析生成读取响应超时。"]);
  assert.deepEqual(question, before);
});

test("模拟旧JSON恢复边界：有稿、混有内容疑点或明确复核失败时不扩大生成重试提示", () => {
  const failures = [{ type: "technical", code: "model_output_invalid_json" }, { type: "technical", code: "invalid_teaching_candidate" }];
  const withDraft = q({ reviewCalls: 1, candidateResult: candidate, findings: failures });
  assert.equal(importTeachingStatus(withDraft).kind, "review_failed");
  const withMathIssue = q({ reviewCalls: 1, findings: [...failures, { type: "quality", dimension: "mathematics", reason: "模拟计算需核对。" }] });
  assert.equal(importTeachingStatus(withMathIssue).kind, "review_failed");
  const explicitReview = q({ status: "review_failed", reviewCalls: 1, findings: failures });
  assert.equal(importTeachingStatus(explicitReview).kind, "review_failed");
});

test("模拟回执待完成仅显示继续原操作，不重新生成或采用另一候选", () => {
  const question = q({ status: "ready_candidate", finalResult: candidate, findings: [] });
  const result = importTeachingStatus(question, { triage: row(question, "adopted", [issue("teaching:publication-receipt", "题库解析已采用，本地更新回执待完成，请继续上次解析更新", { code: "teaching_publication_receipt_pending" })]) });
  assert.equal(result.kind, "publication_pending");
  assert.equal(result.actionHint, "continue_workflow");
  assert.ok(result.reasons[0].includes("更新回执"));
});

test("模拟状态明确而未知错误码时提供中文回退，不猜责任方或泄漏枚举", () => {
  const question = q({ status: "review_failed", retainedInitialReason: "future_review_failure", findings: [] });
  const result = importTeachingStatus(question);
  assert.equal(result.kind, "review_failed");
  assert.ok(result.reasons.every(reason => !reason.includes("future_review_failure")));
  assert.ok(result.reasons[0].includes("解析处理未完成"));
  assert.equal(importTeachingStatus({ questionId: "legacy" }).kind, "not_started");
  assert.equal(importTeachingStatus(q({ status: "generation_pending", generationCalls: 0 })).kind, "not_started");
});
