import test from "node:test";
import assert from "node:assert/strict";
import { importConfirmationContext } from "../src/import-confirmation-context.ts";
import { sourceConfirmationUpdate } from "../src/import-source-confirmation.ts";
import { importQuestionTriage } from "../src/import-triage.ts";

const original = () => ({
  questionId: "simulated-confirmation-q", questionType: "single_choice", sourceLabel: "6",
  stem: "模拟原题：求 $x+1$。", options: [{ label: "A", text: "2" }], parts: [], answer: "", solution: "",
  reviewDecision: "pending", reviewChecks: {}, reviewIssues: [], reviewBasis: "",
});
const modelDraft = () => ({ status: "needs_review", candidateResult: {
  answer: "模拟生成答案", teachingSolution: "模拟待核对证明", issues: ["模拟：此证明缺少必要步骤"],
  difficultyAssessment: { level: "medium", basis: "模拟候选依据" },
  teachingFocus: { examFocus: "模拟考查点", studentRequirements: [] },
}, findings: [{ type: "quality", dimension: "proof", fieldPath: "teachingSolution", message: "模拟证明缺步骤" }] });
function fixture(question = original(), changes = {}) {
  const record = { importId: "simulated-confirmation-import", revision: 3, questions: [question], publishedQuestionIds: [] };
  return { record, question, domain: "source", accuracyDomain: "source", preview: true, dirty: false,
    otherQuestionEdits: false, busy: "", activeJob: false, editingDirty: false,
    publicationPending: false, sourceBlockers: [], ...changes };
}
const accuracyQuestion = () => ({ ...original(), accuracy: {
  strategyVersion: "simulated-accuracy-v1", publicationScope: "source_only", canReview: true, reviewableDomains: ["source", "math", "teaching"],
  source: { status: "model_checked" }, mathematics: { status: "unresolved" }, teaching: { status: "pending" },
} });

test("simulated missing original reference never confirms generated or old-library reference fields", () => {
  const question = { ...original(), teachingWorkflow: modelDraft(), oldReferenceAnswer: "模拟旧库答案",
    teacher: { answers: [{ text: "模拟旧库教师参考" }], solutions: [{ text: "模拟旧库解析" }] } };
  const input = fixture(question), before = structuredClone(input);
  const context = importConfirmationContext(input);
  assert.match(context.scope, /仅确认原题：题干与选项、公式、图片与表格/);
  assert.doesNotMatch(context.scope, /原卷答案|原卷解析|AI教学稿|考查信息/);
  assert.match(context.note, /不确认或采用AI教学稿、考查信息/);
  assert.equal(context.sourceConfirmBlocked, false);
  assert.equal(context.inlineScope, true);
  assert.deepEqual(input, before);
});

test("simulated scope includes only original answer/solution fields that actually contain content, including subquestions", () => {
  const answerOnly = original(); answerOnly.parts = [{ stem: "模拟小问", answer: "原卷答案", solution: "  " }];
  const first = importConfirmationContext(fixture(answerOnly));
  assert.match(first.scope, /原卷答案/); assert.doesNotMatch(first.scope, /原卷解析/);
  answerOnly.parts[0].solution = "原卷步骤";
  assert.match(importConfirmationContext(fixture(answerOnly)).scope, /原卷答案、原卷解析/);
  const freeResponse = { ...original(), questionType: "free_response", answer: "模拟原卷答案", solution: "模拟原卷解析" };
  assert.match(importConfirmationContext(fixture(freeResponse)).scope, /题干与小问、公式、图片与表格、原卷答案、原卷解析/);
});

test("simulated AI proof issues and backend publication reason do not forbid original confirmation", () => {
  const input = fixture({ ...original(), teachingWorkflow: modelDraft() }, {
    eligibility: { eligible: false, reason: "模拟：AI证明尚有未解决事项" },
  });
  const context = importConfirmationContext(input);
  assert.equal(context.sourceConfirmBlocked, false);
  assert.equal(context.barriers.filter(row => row.kind === "action").length, 0);
  assert.deepEqual(context.barriers, [{ kind: "publication", message: "模拟：AI证明尚有未解决事项" }]);
  assert.equal(context.statuses.find(row => row.id === "solution").tone, "blocked");
  assert.doesNotMatch(context.statuses.find(row => row.id === "source").status, /教师已核对|已确认/);
  // The real original-confirmation preparation still accepts this exact shape
  // and leaves the independent model draft intact.
  const confirmed = sourceConfirmationUpdate(input.record, input.question.questionId, { confirmed: true, hardIssues: [] });
  assert.equal(confirmed.questions[0].reviewDecision, "approve");
  assert.deepEqual(confirmed.questions[0].teachingWorkflow, input.question.teachingWorkflow);
});

test("simulated missing source image blocks confirmation with its concrete reason", () => {
  const reason = "模拟：题干引用的原图缺失，请补回真实素材";
  const input = fixture(original(), { sourceBlockers: [reason, reason] });
  const context = importConfirmationContext(input);
  assert.equal(context.sourceConfirmBlocked, true);
  assert.deepEqual(context.barriers, [{ kind: "action", message: reason }]);
  assert.equal(context.statuses.find(row => row.id === "source").tone, "blocked");
  assert.throws(() => sourceConfirmationUpdate(input.record, input.question.questionId, { confirmed: true, hardIssues: [reason] }), /材料问题/);
});

test("simulated empty original stem surfaces the same structural barrier as Rust even when AI content and options exist", () => {
  const question = { ...original(), stem: "  ", teachingWorkflow: modelDraft() };
  const input = fixture(question);
  const context = importConfirmationContext(input);
  assert.equal(context.sourceConfirmBlocked, true);
  assert.ok(context.barriers.some(item => item.kind === "action" && /题干不能为空/.test(item.message)));
  assert.throws(() => sourceConfirmationUpdate(input.record, question.questionId, { confirmed: true, hardIssues: [] }), /题干不能为空/);
  assert.equal(input.question.stem, "  ");
  assert.deepEqual(input.question.teachingWorkflow, question.teachingWorkflow);
});

test("simulated runtime, field-edit, other-question and pending-publication guards have distinct explanations", () => {
  for (const [changes, pattern] of [
    [{ busy: "模拟正在保存" }, /模拟正在保存/],
    [{ activeJob: true }, /后台处理/],
    [{ editingDirty: true }, /未保存的字段修改/],
    [{ otherQuestionEdits: true }, /其他题有未保存修改/],
    [{ publicationPending: true }, /上一次入库或解析更新尚未完成/],
  ]) {
    const context = importConfirmationContext(fixture(original(), changes));
    assert.equal(context.sourceConfirmBlocked, true);
    assert.ok(context.barriers.some(row => row.kind === "action" && pattern.test(row.message)));
  }
  const input = fixture(); input.record.backgroundJob = { status: "running" };
  assert.match(importConfirmationContext(input).barriers[0].message, /后台处理/);
  input.record.backgroundJob = null; input.record.pendingTeachingPublication = { operationId: "simulated-pending" };
  assert.match(importConfirmationContext(input).barriers[0].message, /上一次入库/);
});

test("simulated save explains explicit review fields and does not pretend to exclude the user's checked items", () => {
  const context = importConfirmationContext(fixture(original(), { preview: false, dirty: true, otherQuestionEdits: true }));
  assert.match(context.scope, /保存当前编辑及显式填写的核对项/);
  assert.equal(context.inlineScope, true);
  assert.match(context.note, /审核决定、核对项及依据/);
  assert.match(context.note, /不自动采用AI内容/);
  assert.equal(context.barriers.filter(row => row.kind === "action").length, 0);
  assert.equal(context.sourceConfirmBlocked, true); // Confirmation and save have different guards.
  assert.ok(importConfirmationContext(fixture(original(), { preview: false })).barriers.some(row => /没有待保存/.test(row.message)));
});

test("simulated accuracy source_only keeps teaching gates and distinguishes publication blockers from an available review", () => {
  const context = importConfirmationContext(fixture(accuracyQuestion(), { accuracyDomain: "teaching",
    eligibility: { eligible: false, publicationScope: "source_only", reason: "模拟：主考知识和难度仍须核对" } }));
  assert.match(context.scope, /当前核对：教学信息；入库范围：原题、实际原卷参考及组卷信息/);
  assert.equal(context.inlineScope, true);
  assert.match(context.note, /主考知识、解法依赖和难度仍须核对/);
  assert.equal(context.sourceConfirmBlocked, false);
  assert.equal(context.barriers.filter(row => row.kind === "action").length, 0);
  assert.deepEqual(context.barriers, [{ kind: "publication", message: "模拟：主考知识和难度仍须核对" }]);
  assert.equal(context.statuses.find(row => row.id === "source").status, "模型核对未发现问题");
  assert.equal(context.statuses.find(row => row.id === "solution").tone, "blocked");
  assert.equal(context.statuses.find(row => row.id === "assessment").tone, "pending");
});

test("simulated pending unused domains cannot imply that current manual review is forbidden or revoke backend scope eligibility", () => {
  const question = accuracyQuestion(); question.accuracy.source.status = "human_reviewed";
  const context = importConfirmationContext(fixture(question, {
    eligibility: { eligible: true, publicationScope: "source_only" }, sourceBlockers: [],
  }));
  assert.equal(context.statuses[0].status, "教师已核对");
  assert.deepEqual(context.barriers, []);
  assert.doesNotMatch(context.note, /全部.*完成|禁止.*核对|不能.*核对/);
  assert.equal(context.statuses[1].tone, "blocked"); // The separate issue stays visible.
});

test("simulated actual backend publication scope takes priority and unknown scope is not invented", () => {
  const input = fixture(accuracyQuestion(), { eligibility: { eligible: false, publicationScope: "source_and_teaching" } });
  assert.match(importConfirmationContext(input).scope, /AI答案解析及考查信息/);
  delete input.eligibility.publicationScope; delete input.question.accuracy.publicationScope;
  assert.match(importConfirmationContext(input).scope, /入库范围：待后端确认/);
});

test("simulated assessment-only issue remains in assessment instead of marking the original or proof blocked", () => {
  const question = { ...original(), teachingWorkflow: modelDraft() };
  question.teachingWorkflow.candidateResult.issues = [];
  question.teachingWorkflow.findings = [{ type: "term", term: "模拟术语", fieldPath: "difficultyAssessment.basis", message: "模拟难度依据术语需核对" }];
  question.teachingWorkflow.sourceContentSha256 = "a".repeat(64);
  const input = fixture(question);
  input.controls = { sourceContentSha256: "a".repeat(64), candidateSha256: "b".repeat(64), canPatch: true, canAcknowledge: true,
    issues: [], editableFields: [{ path: "difficultyAssessment.basis", value: question.teachingWorkflow.candidateResult.difficultyAssessment.basis }] };
  const context = importConfirmationContext(input);
  assert.equal(context.statuses[0].tone, "pending");
  assert.equal(context.statuses[1].tone, "pending");
  assert.equal(context.statuses[2].tone, "blocked");
  assert.equal(context.statuses[2].status, "待核对、待补全");
  assert.equal(context.sourceConfirmBlocked, false);
  // Finishing the missing formal annotations does not clear the independent
  // bound assessment finding or retain a now-false supplement warning.
  question.difficultyAssessment = { level: "medium", basis: "模拟已存依据" };
  question.primaryKnowledgeUids = ["simulated-knowledge"];
  question.task = { label: "模拟已存考查点" };
  assert.equal(importConfirmationContext(input).statuses[2].status, "有疑点，待核对");
});

test("simulated stale other-question triage is ignored and a published original remains immutable", () => {
  const input = fixture();
  const other = { ...original(), questionId: "simulated-other", status: "published" };
  input.row = importQuestionTriage(other);
  assert.equal(importConfirmationContext(input).statuses[0].status, "待核对");
  input.record.publishedQuestionIds.push(input.question.questionId);
  const context = importConfirmationContext(input);
  assert.equal(context.sourceConfirmBlocked, true);
  assert.equal(context.statuses[0].status, "已入库");
  assert.equal(context.barriers.filter(row => row.kind === "action").length, 0);
  assert.equal(context.scope, "查看已入库原题");
});

test("simulated completed or unused original records describe reading instead of an unavailable confirmation", () => {
  const cases = [
    { state: "eligible", eligibility: { eligible: true, method: "model_review" }, scope: "查看可入库原题", label: "可入库" },
    { state: "published", eligibility: { eligible: false, reason: "模拟：本题已入库" }, scope: "查看已入库原题", label: "已入库" },
    { state: "duplicate", eligibility: { eligible: false, reason: "模拟：题库已有完全重复题" }, scope: "查看题库已有的原题", label: "题库已有此题" },
    { state: "rejected", eligibility: { eligible: false, reason: "模拟：本题未采用" }, scope: "查看未采用原题", label: "未采用" },
  ];
  for (const scenario of cases) {
    const input = fixture(original(), { eligibility: scenario.eligibility });
    input.row = { ...importQuestionTriage(input.question), eligible: scenario.state === "eligible", published: scenario.state === "published",
      duplicateState: scenario.state === "duplicate" ? "exact" : "none",
      question: { ...input.question, reviewDecision: scenario.state === "rejected" ? "reject" : "pending" } };
    const context = importConfirmationContext(input);
    assert.equal(context.scope, scenario.scope);
    assert.equal(context.inlineScope, false);
    assert.equal(context.statuses[0].status, scenario.label);
    assert.match(context.note, /AI教学稿和考查信息的状态分别保留/);
    assert.match(context.note, /入库由单独操作显式发起/);
    assert.doesNotMatch(context.scope, /仅确认|已核对/); // Model eligibility is not teacher review.
    assert.deepEqual(context.barriers, []);
    if (scenario.state === "published") assert.equal(context.sourceConfirmBlocked, true);
  }
});

test("simulated generic teaching guidance belongs in details while states and real barriers remain available beside actions", () => {
  const reason = "模拟：教学稿仍须核对";
  const context = importConfirmationContext(fixture({ ...original(), teachingWorkflow: modelDraft() }, {
    domain: "teaching", eligibility: { eligible: false, reason },
  }));
  assert.equal(context.inlineScope, false);
  assert.match(context.scope, /AI教学稿与考查信息/);
  assert.match(context.note, /不替代原题核对/);
  assert.equal(context.statuses.length, 3);
  assert.deepEqual(context.barriers, [{ kind: "publication", message: reason }]);
});

test("simulated initial loading or summary-only question returns unknown states without inventing a confirmation scope", () => {
  for (const question of [undefined, { ...original(), _detailLoaded: false }]) {
    const context = importConfirmationContext({ ...fixture(), question });
    assert.equal(context.sourceConfirmBlocked, true);
    assert.ok(context.statuses.every(row => row.status === "详情待读取" && row.tone === "neutral"));
    assert.doesNotMatch(context.scope, /题干与选项|原卷答案|已核对/);
  }
});
