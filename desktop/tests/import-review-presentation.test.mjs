import test from "node:test";
import assert from "node:assert/strict";
import { groupReviewIssues, isReviewOutcomeGroup, isReviewProcessGroup, sourceCorrectionForGroup, reviewDisplayMessage, reviewFieldLabel } from "../src/import-review-presentation.ts";

function issue(id, extra = {}) {
  return { id, domain: "teaching", tone: "amber", message: "仍含需复核术语“目标式”", type: "term",
    provenanceLabel: "术语检查", location: "unavailable", process: { categoryLabel: "模型输出与内容" }, ...extra };
}
function target(path, extra = {}) {
  return { domain: "teaching", fieldPath: path, candidateSha256: "b".repeat(64), sourceContentSha256: "a".repeat(64), ...extra };
}

test("simulated duplicate messages share one card while all original identities and bound locations remain", () => {
  const first = issue("sim-term-unlocated");
  const second = issue("sim-term-solution", { target: target("teachingSolution", { start: 4, end: 7 }), location: "range" });
  const third = issue("sim-term-basis", { target: target("difficultyAssessment.basis"), location: "field", tone: "red" });
  const groups = groupReviewIssues([first, second, third]);
  assert.equal(groups.length, 1);
  const group = groups[0];
  assert.equal(group.title, "检查术语“目标式”");
  assert.equal(group.message, first.message);
  assert.equal(group.tone, "red");
  assert.deepEqual(group.members.map(item => item.id), [first.id, second.id, third.id]);
  assert.equal(group.members[0], first);
  assert.equal(group.members[1], second);
  assert.deepEqual(group.locatableIssues, [second, third]);
  assert.equal(group.locatableIssues[0].target, second.target);
  assert.deepEqual(group.fieldLabels, ["教学解析", "难度依据"]);
});

test("simulated identical source and teaching messages remain separate and near-matching prose is not merged", () => {
  const source = issue("sim-source", { domain: "source", type: "quality" });
  const teaching = issue("sim-teaching");
  const distinct = issue("sim-distinct", { message: teaching.message + "。" });
  const groups = groupReviewIssues([source, teaching, distinct]);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map(item => item.domain), ["source", "teaching", "teaching"]);
  assert.equal(groups[0].members[0], source);
});

test("simulated missing or unavailable target never becomes a guessed location", () => {
  const noTarget = issue("sim-no-target", { type: "format", message: "请核对教学解析里的内容", location: "field" });
  const unavailable = issue("sim-unavailable", { type: "format", message: noTarget.message, target: target("teachingSolution") });
  const [group] = groupReviewIssues([noTarget, unavailable]);
  assert.deepEqual(group.locatableIssues, []);
  assert.deepEqual(group.fieldLabels, []);
  assert.equal(group.title, "检查内容结构");
});

test("simulated presentation does not mutate inputs or equate grouping with resolving a gate", () => {
  const original = [issue("sim-first"), issue("sim-second", { target: target("difficultyAssessment.basis"), location: "field" })];
  const before = structuredClone(original);
  const result = groupReviewIssues(original);
  assert.deepEqual(original, before);
  assert.equal(original.length, 2);
  assert.equal(result[0].members.length, 2);
  assert.ok(!("acknowledged" in result[0]));
  assert.ok(!("eligible" in result[0]));
  assert.ok(!("resolved" in result[0]));
});

test("simulated canonical field labels avoid leaking or guessing internal identifiers", () => {
  const fields = {
    stem: "题干", "options[3].text": "选项", "parts[1].prompt": "小问题干",
    "parts[1].answer": "小问答案", "parts[1].solution": "小问解析",
    teachingSolution: "教学解析", "difficultyAssessment.basis": "难度依据",
    "teachingFocus.examFocus": "考查点", "teachingFocus.studentRequirements[1]": "对学生的要求",
  };
  for (const [path, label] of Object.entries(fields)) assert.equal(reviewFieldLabel(path), label);
  assert.equal(reviewFieldLabel("answer", "source"), "原卷答案");
  assert.equal(reviewFieldLabel("answer", "teaching"), "生成答案");
  assert.equal(reviewFieldLabel("future_internal_key", "source"), "原题内容");
  assert.equal(reviewFieldLabel(undefined), "解析内容");
});

test("simulated known error codes give direct titles without elevating process metadata or parsing prose", () => {
  const display = issue("sim-newline", { type: "display", code: "literal_newline_escape", message: "原始具体排版说明" });
  assert.equal(groupReviewIssues([display])[0].title, "修复换行排版");
  const unknown = issue("sim-unknown", { type: undefined, code: "constructor", message: "含有术语“目标式”的任意模型描述" });
  assert.equal(groupReviewIssues([unknown])[0].title, "核对解析疑点");
  assert.equal(groupReviewIssues([unknown])[0].message, unknown.message);
  const requirements = issue("sim-requirements", { type: "quality", message: "模拟具体要求需核对", location: "field", target: target("teachingFocus.studentRequirements[0]") });
  assert.equal(groupReviewIssues([requirements])[0].title, "核对学生要求");
  assert.deepEqual(groupReviewIssues([]), []);
});

test("simulated invalid annotation names the metadata task without guessing a field or a location", () => {
  const message = "已评估难度需填写具体依据（至少8字）；无法判断时使用未评估。";
  const finding = issue("sim-annotation", { type: "technical", code: "invalid_annotation", message });
  const [group] = groupReviewIssues([finding]);
  assert.equal(group.title, "检查考查信息");
  assert.equal(group.message, message);
  assert.equal(group.members[0], finding);
  assert.deepEqual(group.fieldLabels, []);
  assert.deepEqual(group.locatableIssues, []);
  assert.equal(group.members[0].target, undefined);
  const noCode = issue("sim-same-prose", { type: "technical", message });
  assert.equal(groupReviewIssues([noCode])[0].title, "处理过程未完成");
});

test("simulated review outcome grouping requires every member's exact local projection identity", () => {
  const message = "复核未完成，初稿已保留，仍需核对";
  const outcome = issue("teaching:review-failed", { type: "technical", message });
  const [outcomeGroup] = groupReviewIssues([outcome]);
  assert.equal(isReviewOutcomeGroup(outcomeGroup), true);
  const specific = issue("teaching:finding-2", { type: "quality", message });
  const [mixed] = groupReviewIssues([outcome, specific]);
  assert.equal(mixed.members.length, 2);
  assert.equal(isReviewOutcomeGroup(mixed), false);
  assert.equal(isReviewOutcomeGroup(groupReviewIssues([specific])[0]), false);
  assert.equal(isReviewOutcomeGroup(groupReviewIssues([issue("teaching:review-failed-other", { message })])[0]), false);
  assert.equal(isReviewOutcomeGroup({ ...outcomeGroup, members: [] }), false);
  assert.equal(outcome.id, "teaching:review-failed");
});

test("simulated corrected source display requires exact backend evidence for every grouped concern and is invalidated by edits", () => {
  const source = issue("source:review-0", { domain: "source", type: "quality", message: "OCR末尾截断，已补齐" });
  const group = groupReviewIssues([source])[0];
  const note = { schemaVersion: 1, status: "corrected_pending_confirmation", kind: "ocr_transcription", issueIndex: 0,
    issueMessage: source.message, fieldPath: "options[3].text", sourceContentSha256: "a".repeat(64) };
  assert.equal(sourceCorrectionForGroup(group), undefined);
  assert.equal(sourceCorrectionForGroup(group, [note]), note);
  assert.equal(sourceCorrectionForGroup(group, [note], true), undefined);
  assert.equal(sourceCorrectionForGroup(group, [{ ...note, issueMessage: "另一疑点" }]), undefined);
  assert.equal(sourceCorrectionForGroup(group, [{ ...note, issueIndex: 1 }]), undefined);
  assert.equal(sourceCorrectionForGroup(group, [note, note]), undefined);
  const extra = issue("source:material-0", { domain: "source", type: "quality", message: source.message });
  assert.equal(sourceCorrectionForGroup(groupReviewIssues([source, extra])[0], [note]), undefined);
  assert.equal(sourceCorrectionForGroup(groupReviewIssues([issue("teaching:finding-0")])[0], [note]), undefined);
  assert.equal(source.message, "OCR末尾截断，已补齐");
});

test("simulated process failures and content tasks stay distinct; known notation receives readable copy only", () => {
  const timeout = issue("teaching:finding-0", { type: "technical", code: "model_response_timeout", message: "读取超时" });
  assert.equal(isReviewProcessGroup(groupReviewIssues([timeout])[0]), true);
  const content = issue("teaching:finding-1", { type: "quality", code: "model_response_timeout", message: timeout.message });
  assert.equal(isReviewProcessGroup(groupReviewIssues([timeout, content])[0]), false);
  const annotation = issue("teaching:finding-2", { type: "technical", code: "invalid_annotation", message: "难度依据未填写" });
  assert.equal(isReviewProcessGroup(groupReviewIssues([annotation])[0]), false);
  assert.equal(isReviewProcessGroup(groupReviewIssues([annotation])[0], "invalid_annotation"), true);
  assert.equal(groupReviewIssues([issue("sim-integral", { message: "仍含需复核术语“\\int”" })])[0].title, "检查术语“积分记号”");
  assert.equal(reviewDisplayMessage("仍含需复核术语“\\lim”"), "需核对：极限记号");
  assert.equal(reviewDisplayMessage("模型说明包含 \\int 不构成固定词表消息"), "模型说明包含 \\int 不构成固定词表消息");
});
