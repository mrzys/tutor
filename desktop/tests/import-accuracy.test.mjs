import test from "node:test";
import assert from "node:assert/strict";
import { accuracyActionCanSubmit, accuracyActionCurrent, accuracyActionPayload, accuracyBudget, accuracyEvidence, accuracyFindings, accuracyImportAction, accuracyKnowledgeNames, accuracyModelReadiness, accuracyPremiseNames, accuracyPreviewCandidate, accuracyScopeCurrent, accuracyScopePayload, accuracyStatus, createAccuracyActionDraft, createAccuracyScopeDraft } from "../src/import-accuracy.ts";

const question = () => ({ questionId: "simulated-q", stem: "模拟原题", answer: "原卷答案", teacher: { answers: ["原卷参考"] },
  accuracy: { strategyVersion: "accuracy-v1", status: "needs_review", stage: "math_verification", sourceSha256: "a".repeat(64), candidateSha256: "b".repeat(64),
    source: { status: "ready", reason: "模拟已对照原页" }, mathematics: { status: "unresolved", reason: "模拟第二小问缺少证明" }, teaching: { status: "pending" },
    canReview: true, reviewableDomains: ["source", "math", "teaching"], canRepair: true, findings: [{ id: "finding-one", domain: "math", message: "模拟：端点还需核查", fieldPath: "teachingSolution", partId: "p2", basis: "模拟缺少端点计算" }],
    candidate: { answer: "$x=1$", teachingSolution: "先验 $x=1$，再检验端点。", difficultyAssessment: { level: "medium", basis: "模拟条件检查" }, teachingFocus: { examFocus: "模拟求值", studentRequirements: ["模拟检验条件"] } } } });

test("old ready/model self-review never acquires the new verification status or a generated preview", () => {
  const old = { questionId: "old", teachingWorkflow: { status: "ready_candidate", finalResult: { answer: "2" } }, modelReview: { status: "ready" } };
  assert.equal(accuracyStatus(old), null); assert.equal(accuracyPreviewCandidate(old), null); assert.deepEqual(accuracyFindings(old), []);
  assert.equal(createAccuracyActionDraft(old, "simulated-import", 2, "review", "source", "simulated-op"), null);
});
test("three domains retain independent unknown/failure/manual states instead of inheriting overall ready", () => {
  const q = question(); q.accuracy.status = "ready";
  assert.equal(accuracyStatus(q, "source").label, "模型核对未发现问题");
  assert.equal(accuracyStatus(q, "math").kind, "needs_review");
  assert.equal(accuracyStatus(q, "teaching").kind, "pending");
  q.accuracy.mathematics.status = "teacher_reviewed";
  assert.equal(accuracyStatus(q, "math").label, "教师已核对");
  q.accuracy.teaching.status = "unexpected_ready_like_text";
  assert.equal(accuracyStatus(q, "teaching").kind, "pending");
  q.accuracy.teaching.status = "issues_found";
  assert.equal(accuracyStatus(q, "teaching").kind, "needs_review");
});
test("budget pauses and transport failures are not mathematical rejection or verified success", () => {
  const q = question(); q.accuracy.status = "budget_paused"; q.accuracy.budget = { reason: "模拟调用额度已用完" };
  assert.equal(accuracyStatus(q).kind, "budget_paused"); assert.equal(accuracyStatus(q).reason, "模拟调用额度已用完");
  q.accuracy.status = "failed"; assert.equal(accuracyStatus(q).kind, "failed");
  assert.equal(accuracyStatus(q, "math").kind, "needs_review");
});
test("generated preview preserves mathematical text and remains separate from original references", () => {
  const q = question(), before = structuredClone(q), candidate = accuracyPreviewCandidate(q);
  assert.equal(candidate.answer, q.accuracy.candidate.answer); assert.equal(candidate.teachingSolution, q.accuracy.candidate.teachingSolution);
  candidate.teachingFocus.studentRequirements.push("模拟本地阅读修改");
  candidate.difficultyAssessment.level = "hard";
  assert.deepEqual(q, before); assert.equal(q.answer, "原卷答案"); assert.deepEqual(q.teacher.answers, ["原卷参考"]);
});
test("review requires concrete input, acknowledgment and current identity; backend permission remains authoritative", () => {
  const q = question(), draft = createAccuracyActionDraft(q, "simulated-import", 2, "review", "math", "simulated-op");
  assert.ok(draft); assert.equal(accuracyActionCanSubmit(draft, q, "simulated-import", 2), false);
  draft.basis = "已代入模拟端点并核对小问条件，两个端点都满足要求。";
  assert.equal(accuracyActionCanSubmit(draft, q, "simulated-import", 2), false);
  draft.acknowledge = true;
  const payload = accuracyActionPayload(draft, q, "simulated-import", 2);
  assert.equal(payload.domain, "math"); assert.equal(payload.acknowledge, true); assert.equal(payload.expectedRevision, 2);
  assert.equal(payload.sourceSha256, q.accuracy.sourceSha256); assert.equal(payload.candidateSha256, q.accuracy.candidateSha256);
  assert.equal(accuracyActionCurrent(draft, q, "simulated-import", 3), false);
  q.accuracy.candidateSha256 = "c".repeat(64);
  assert.throws(() => accuracyActionPayload(draft, q, "simulated-import", 2));
  assert.match(draft.basis, /模拟端点/);
  q.accuracy.candidateSha256 = "b".repeat(64); q.accuracy.canReview = false;
  assert.equal(accuracyActionCanSubmit(draft, q, "simulated-import", 2), false);
});
test("explicit repair binds the same version without pretending a teacher review or mutating mathematical content", () => {
  const q = question(), before = structuredClone(q), draft = createAccuracyActionDraft(q, "simulated-import", 2, "repair", "source", "repair-op");
  draft.basis = "仅补齐第二小问端点的推导，不改其他已核内容。"; draft.acknowledge = true;
  const payload = accuracyActionPayload(draft, q, "simulated-import", 2);
  assert.equal(Object.hasOwn(payload, "domain"), false); assert.equal(Object.hasOwn(payload, "acknowledge"), false);
  assert.equal(Object.hasOwn(payload, "answer"), false); assert.equal(Object.hasOwn(payload, "teacher_review"), false);
  assert.equal(payload.operationId, "repair-op"); assert.deepEqual(q, before);
  q.accuracy.canRepair = false; assert.equal(createAccuracyActionDraft(q, "simulated-import", 2, "repair", "source", "next-op"), null);
});

test("concrete basis uses the same trimmed 8–4000 character boundary as Rust", () => {
  const q = question(), draft = createAccuracyActionDraft(q, "simulated-import", 2, "review", "source", "basis-boundary-op");
  draft.acknowledge = true;
  for (const basis of ["已核对", " ".repeat(8), "字".repeat(4001)]) {
    draft.basis = basis; assert.equal(accuracyActionCanSubmit(draft, q, "simulated-import", 2), false);
  }
  for (const basis of ["逐项核对原文无误", "字".repeat(4000), "🧮".repeat(8)]) {
    draft.basis = basis; assert.equal(accuracyActionCanSubmit(draft, q, "simulated-import", 2), true);
  }
});
test("missing bindings and malformed findings cannot create authorized actions or invented content", () => {
  const q = question(); delete q.accuracy.sourceSha256;
  assert.equal(createAccuracyActionDraft(q, "simulated-import", 2, "review", "source", "op"), null);
  q.accuracy.findings.push(null, "raw-code", { message: "" }, { message: "模拟未定位意见" });
  const entries = accuracyFindings(q); assert.equal(entries.length, 2); assert.equal(entries[1].fieldPath, "");
  assert.equal(entries[1].partId, null);
});
test("new uploads require saved explicit purpose bindings; legacy/general readiness is never a substitute", () => {
  const roles = ["sourceParsing", "teachingGeneration", "sourceVerification", "independentSolve", "mathVerification", "teachingVerification"];
  const model = { configured: true, importConfigured: true, profiles: [{ id: "sim-profile", configured: true }], importRoles: {}, effectiveImportRoles: {} };
  assert.equal(accuracyModelReadiness(model).configured, false);
  for (const role of roles) { model.importRoles[role] = "sim-profile"; model.effectiveImportRoles[role] = { strategy: "explicit", configured: true, profileId: "sim-profile" }; }
  assert.deepEqual(accuracyModelReadiness(model), { configured: true, missing: [] });
  assert.deepEqual(accuracyModelReadiness(model, true).missing, ["解析复核"]);
  model.effectiveImportRoles.independentSolve.strategy = "legacy";
  assert.deepEqual(accuracyModelReadiness(model).missing, ["独立求解"]);
  model.effectiveImportRoles.independentSolve.strategy = "explicit"; model.effectiveImportRoles.mathVerification.profileId = "another-profile";
  assert.deepEqual(accuracyModelReadiness(model).missing, ["数学核验"]);
});
test("source human review can bind an explicit empty candidate before a generated solution exists", () => {
  const q = question(); q.accuracy.candidateSha256 = "";
  const draft = createAccuracyActionDraft(q, "simulated-import", 2, "review", "source", "source-op");
  assert.ok(draft); draft.basis = "已逐项对照模拟原页题干、选项和素材。"; draft.acknowledge = true;
  assert.equal(accuracyActionPayload(draft, q, "simulated-import", 2).candidateSha256, "");
  q.accuracy.candidateSha256 = "b".repeat(64); assert.equal(accuracyActionCurrent(draft, q, "simulated-import", 2), false);
});
test("new uploads and new-run continuation never use the legacy start action; old-run continuation remains compatible", () => {
  const legacy = { importId: "simulated-old", questions: [{ teachingWorkflow: { status: "ready_candidate" } }] };
  const next = { importId: "simulated-new", accuracyRunId: "simulated-run" };
  assert.equal(accuracyImportAction(null), "import_accuracy_start");
  assert.equal(accuracyImportAction(legacy, false), "import_accuracy_start");
  assert.equal(accuracyImportAction(next, true), "import_accuracy_start");
  assert.equal(accuracyImportAction(legacy, true), "import_start");
});
test("new reading resolves names only from its frozen catalogue and never fills missing names from live or legacy labels", () => {
  const q = question(); q.primaryKnowledgeNames = ["不应代入的旧名称"];
  assert.equal(accuracyKnowledgeNames(q, ["kp-1"]), "知识点名称未记录");
  q.accuracy.catalogue = { knowledgePoints: [{ uid: "kp-1", name: "冻结知识名" }], premises: [{ id: "tool-1", label: "冻结前提名" }] };
  assert.equal(accuracyKnowledgeNames(q, ["kp-1", "missing"]), "冻结知识名、知识点名称未记录");
  assert.equal(accuracyPremiseNames(q, ["tool-1", "missing"]), "冻结前提名、前提名称未记录");
});
test("budget presentation distinguishes actual usage, held reservations and unknown executions without invented ETA", () => {
  const q = question(); q.accuracy.budget = { limits: { maxCalls: 8, maxInputTokens: 1000, maxOutputTokens: 2000 }, usage: { usedCalls: 3, usedInputTokens: 100, reservedInputTokens: 50, usedOutputTokens: 60, reservedOutputTokens: 70, unknownUsageExecutions: ["unknown-op"] } };
  const view = accuracyBudget(q); assert.equal(view.calls, "调用 3 / 8"); assert.match(view.input, /实际 100，预留 50，上限 1000/);
  assert.match(view.output, /实际 60，预留 70，上限 2000/); assert.match(view.unknown, /1 次用量未知/); assert.equal(view.time, "尚无实测预计时长");
  delete q.accuracy.budget.usage.usedInputTokens; assert.match(accuracyBudget(q).input, /实际 未记录/);
});
test("publication scope is a separate exact-version action and does not erase errors or mark manual review", () => {
  const q = question(), before = structuredClone(q), draft = createAccuracyScopeDraft(q, "simulated-import", 2, "source_only", "scope-op");
  const payload = accuracyScopePayload(draft, q, "simulated-import", 2);
  assert.equal(payload.publicationScope, "source_only"); assert.equal(payload.acknowledge, true); assert.equal(payload.responseScope, "question");
  assert.equal(Object.hasOwn(payload, "basis"), false); assert.equal(Object.hasOwn(payload, "domain"), false);
  assert.deepEqual(q, before); assert.equal(accuracyScopeCurrent(draft, q, "simulated-import", 3), false);
  assert.throws(() => accuracyScopePayload(draft, q, "simulated-import", 3));
  assert.equal(createAccuracyScopeDraft(q, "simulated-import", 2, "skip_errors", "invalid-op"), null);
});
test("read-only evidence preserves actual checks and disagreement steps without turning them into truth or a repair", () => {
  const q = question(); q.accuracy.mathematics = { status: "unresolved", reason: "模拟分歧", basis: "模拟逐步核算依据", checks: [{ target: "candidate.solution", status: "unresolved", basis: "模拟缺少端点" }], disagreements: [{ classification: "unresolved", claimA: "x=1", claimB: "x=2", stepA: "模拟步骤A", stepB: "模拟步骤B", basis: "尚无可靠错因" }] };
  const before = structuredClone(q), item = accuracyEvidence(q).find(item => item.label === "答案与证明");
  assert.equal(item.checks[0].label, "解析"); assert.equal(item.checks[0].status, "未判");
  assert.equal(item.disagreements[0].stepA, "模拟步骤A"); assert.equal(item.disagreements[0].label, "尚无法判断");
  assert.deepEqual(q, before); assert.equal(accuracyStatus(q, "math").kind, "needs_review");
});
