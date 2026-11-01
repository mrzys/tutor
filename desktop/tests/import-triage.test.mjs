import test from "node:test";
import assert from "node:assert/strict";
import { importQuestionTriage, importTriage } from "../src/import-triage.ts";

const sourceHash = "a".repeat(64), candidateHash = "b".repeat(64);
function q(id = "simulated-1", status = "needs_review", findings = []) {
  const candidate = { answer: "2", teachingSolution: "由 $1+1=2$ 得答案。", issues: [] };
  return { questionId: id, stem: "模拟回归：求 $1+1$。", pages: [1], sourceLabel: "1",
    modelReview: { status: "ready", issues: [] }, teachingWorkflow: {
      status, sourceContentSha256: sourceHash, findings,
      candidateResult: candidate, ...(status === "ready_candidate" ? { finalResult: candidate } : {}),
    } };
}
function controls(question, extra = {}) {
  return { sourceContentSha256: sourceHash, candidateSha256: candidateHash, issues: [],
    editableFields: [{ path: "teachingSolution", value: question.teachingWorkflow.candidateResult.teachingSolution }],
    canPatch: true, canAcknowledge: true, ...extra };
}

test("simulated repeated term locations survive triage even when their task messages are equal", () => {
  const solution = "由 $\\int f(x)dx=\\int g(x)dx$，再由 $\\int h(x)dx=\\int k(x)dx$ 得结论。";
  const findings = [...solution.matchAll(/\\int/g)].map(match => ({ type: "term", term: "\\int",
    fieldPath: "teachingSolution", start: match.index, end: match.index + 4 }));
  const question = q("sim-repeat-ranges", "needs_review", findings);
  question.teachingWorkflow.candidateResult.teachingSolution = solution;
  const before = structuredClone(question);
  const row = importQuestionTriage(question, { controls: controls(question) });
  const marks = row.issues.filter(issue => issue.type === "term");
  assert.equal(marks.length, 4);
  assert.deepEqual(marks.map(issue => issue.target.start), findings.map(finding => finding.start));
  assert.deepEqual(marks.map(issue => issue.id), ["teaching:finding-0", "teaching:finding-1", "teaching:finding-2", "teaching:finding-3"]);
  assert.equal(row.teachingState, "needs_review");
  assert.equal(row.eligible, false);
  assert.deepEqual(question, before);
});

test("simulated colour cannot grant or revoke backend publication eligibility", () => {
  const question = q("simulated-1", "needs_review", [{ type: "quality", dimension: "proof", message: "缺少取等理由" }]);
  const row = importQuestionTriage(question, { eligibility: { eligible: true, method: "teacher_review" } });
  assert.equal(row.tone, "red");
  assert.equal(row.eligible, true);
  assert.equal(row.sourceState, "eligible");
  assert.equal(row.teachingState, "needs_review");
  assert.equal(importQuestionTriage(q("simulated-2", "ready_candidate")).eligible, false);
});

test("simulated code-only display concerns retain identity and targets while showing Chinese reasons", () => {
  for (const code of ["literal_newline_escape", "future_display_defect"]) {
    const question = q("simulated-display", "needs_review", [{ type: "display", code, fieldPath: "teachingSolution" }]);
    const before = structuredClone(question);
    const row = importQuestionTriage(question, { controls: controls(question), eligibility: { eligible: true, method: "teacher_review" } });
    const issue = row.issues[0];
    assert.equal(issue.code, code);
    assert.equal(issue.type, "display");
    assert.equal(issue.domain, "teaching");
    assert.equal(issue.location, "field");
    assert.equal(issue.target.fieldPath, "teachingSolution");
    assert.equal(issue.target.candidateSha256, candidateHash);
    assert.equal(row.tone, "amber");
    assert.equal(row.eligible, true);
    assert.equal(row.teachingState, "needs_review");
    assert.ok(!issue.message.includes(code));
    if (code === "literal_newline_escape") assert.equal(issue.message, "解析中存在未正确处理的换行符，需修复排版");
    assert.deepEqual(question, before);
  }
});

test("simulated published original keeps its independent teaching task", () => {
  const question = q("simulated-1", "needs_review", [{ type: "quality", dimension: "mathematics", message: "原推导系数待核对" }]);
  const row = importQuestionTriage(question, { record: { publishedQuestionIds: [question.questionId] } });
  assert.equal(row.sourceState, "published");
  assert.equal(row.teachingState, "needs_review");
  assert.equal(row.needsAction, true);
  assert.equal(row.tone, "red");
  assert.equal(row.eligible, false);
});

test("simulated adoption must be explicit; publication alone never adopts AI", () => {
  const question = q("simulated-1", "ready_candidate");
  const record = { publishedQuestionIds: [question.questionId] };
  let row = importQuestionTriage(question, { record });
  assert.equal(row.teachingState, "ready");
  assert.equal(row.needsAction, true);
  row = importQuestionTriage(question, { record, teachingActions: { adopted: true } });
  assert.equal(row.teachingState, "adopted");
  assert.equal(row.needsAction, false);
  question.teachingPublication = { status: "adopted", candidateSha256: "c".repeat(64) };
  row = importQuestionTriage(question, { record, controls: controls(question) });
  assert.equal(row.teachingState, "ready");
  question.teachingPublication.candidateSha256 = candidateHash;
  assert.equal(importQuestionTriage(question, { record, controls: controls(question) }).teachingState, "adopted");
  assert.equal(importQuestionTriage(question, { record, teachingActions: { adopted: false } }).teachingState, "ready");
});

test("simulated red priority follows explicit quality dimension, never problem wording", () => {
  const question = q("simulated-1", "needs_review", [
    { type: "technical", message: "网络故障" },
    { type: "term", term: "线性表示", category: "context" },
    { type: "quality", dimension: "explanation", message: "先证明存在唯一解，再核对单调性" },
  ]);
  assert.equal(importQuestionTriage(question).tone, "amber");
  question.teachingWorkflow.findings.push({ type: "quality", dimension: "method", message: "模型提示方法需核对" });
  assert.equal(importQuestionTriage(question).tone, "red");
  question.teachingWorkflow.findings[3].dimension = "mathematics";
  assert.equal(importQuestionTriage(question).tone, "red");
});

test("simulated bank adoption before local receipt commit remains an amber recoverable todo", () => {
  const question = q("simulated-1", "ready_candidate");
  const record = { questions: [question], publishedQuestionIds: [question.questionId] };
  const actions = { [question.questionId]: { adopted: true, canResumeTeachingPublication: true } };
  const result = importTriage(record, {}, {}, [], actions);
  const row = result.rows[0];
  assert.equal(row.sourceState, "published");
  assert.equal(row.teachingState, "adopted");
  assert.equal(row.needsAction, true);
  assert.equal(row.tone, "amber");
  assert.equal(row.teachingLabel, "解析已采用，更新回执待完成");
  assert.equal(row.issues.find(issue => issue.code === "teaching_publication_receipt_pending").type, "technical");
  assert.equal(result.counts.todo, 1);
  assert.equal(result.counts.published, 1);
  assert.equal(result.counts.teachingPending, 1);
  assert.equal(result.counts.eligible, 0);
  const completed = importTriage(record, {}, {}, [], { [question.questionId]: { adopted: true, canResumeTeachingPublication: false } });
  assert.equal(completed.rows[0].needsAction, false);
  assert.equal(completed.rows[0].teachingLabel, "解析已采用");
});

test("simulated pending publication not yet adopted preserves the original action for recovery", () => {
  const question = q("simulated-1", "ready_candidate");
  const row = importQuestionTriage(question, { record: { publishedQuestionIds: [question.questionId] },
    teachingActions: { adopted: false, canResumeTeachingPublication: true } });
  assert.equal(row.teachingState, "ready");
  assert.equal(row.needsAction, true);
  assert.equal(row.tone, "amber");
  assert.ok(row.issues.some(item => item.code === "teaching_publication_receipt_pending"));
});

test("simulated checked informative issues remain recorded without making a todo", () => {
  const question = q("simulated-1", "ready_candidate", [{ type: "model_issue", issue: "参考笔误已核对" }]);
  question.teachingWorkflow.candidateResult.issues = ["参考笔误已核对"];
  const control = controls(question, { issues: [{ issueIndex: 0, issue: "参考笔误已核对", issueSha256: "c".repeat(64),
    disposition: "informative", acknowledged: true, acknowledgeable: false }] });
  const row = importQuestionTriage(question, { controls: control, eligibility: { eligible: true } });
  assert.equal(row.teachingState, "ready");
  assert.equal(row.needsAction, false);
  assert.equal(row.notices.length, 1);
  assert.equal(row.issues.length, 0);
});

test("simulated source material defect is never silenced by teacher approval", () => {
  const question = q("simulated-1", "ready_candidate");
  question.sourceIssues = [{ code: "source_image_unresolved", message: "题图缺失" }];
  const row = importQuestionTriage(question, { eligibility: { eligible: false, method: "teacher_review" } });
  assert.equal(row.sourceState, "blocked");
  assert.equal(row.tone, "red");
  assert.equal(row.issues[0].domain, "source");
});

test("simulated equal issue wording at different indices requires every acknowledgement", () => {
  const question = q("simulated-1", "ready_candidate", [{ type: "model_issue", issue: "相同意见" }]);
  question.teachingWorkflow.candidateResult.issues = ["相同意见", "相同意见"];
  const control = controls(question, { issues: [
    { issueIndex: 0, issue: "相同意见", issueSha256: "c".repeat(64), disposition: "informative", acknowledged: true, acknowledgeable: false },
    { issueIndex: 1, issue: "相同意见", issueSha256: "c".repeat(64), disposition: "blocking", acknowledged: false, acknowledgeable: true },
  ] });
  const row = importQuestionTriage(question, { controls: control });
  assert.equal(row.teachingState, "needs_review");
  assert.equal(row.issues.length, 1);
  assert.equal(row.notices.length, 0);
  assert.equal(row.tone, "red");
});

test("simulated source page issues affect only matching pages and retain informative notices", () => {
  const question = q("simulated-1", "ready_candidate");
  const row = importQuestionTriage(question, { eligibility: { eligible: true }, record: { sourceIssues: [
    { page: 2, message: "另一页缺图" }, { page: 1, message: "本页水印", blocking: false },
  ] } });
  assert.equal(row.issues.length, 0);
  assert.equal(row.notices.length, 1);
  assert.equal(row.needsAction, false);
});

test("simulated duplicate is neutral without being counted as a failed question", () => {
  const question = q("simulated-1", "ready_candidate");
  question.duplicateCandidates = [{ exact: true }];
  const result = importTriage({ questions: [question] }, { [question.questionId]: { eligible: false } });
  assert.equal(result.rows[0].tone, "neutral");
  assert.equal(result.rows[0].duplicateState, "exact");
  assert.equal(result.rows[0].eligible, false);
  assert.equal(result.counts.todo, 0);
  assert.equal(result.counts.red, 0);
  assert.equal(result.counts.duplicates, 1);
  question.teachingWorkflow.status = "needs_review";
  question.teachingWorkflow.findings = [{ type: "quality", dimension: "method", message: "独立AI解析仍需核对" }];
  const next = importTriage({ questions: [question] });
  assert.equal(next.rows[0].tone, "neutral");
  assert.equal(next.counts.todo, 0);
  assert.equal(next.counts.teachingPending, 0);
  assert.equal(next.rows[0].issues[0].message, "独立AI解析仍需核对");
  assert.equal(next.rows[0].notices.length, 0);
});

test("real-shape regression: duplicate T1 remains readable but the material audit on ready Y15 becomes an actionable source task", () => {
  const duplicate = q("regression-tianjin-1", "needs_review", [
    { type: "model_issue", issue: "题面全集待核对" },
    { type: "quality", dimension: "mathematics", fieldPath: "answer", message: "全集未明确" },
  ]);
  duplicate.sourceLabel = "(1)";
  duplicate.duplicateCandidates = [{ exact: true }];
  const material = q("regression-yuxi-15", "ready_candidate");
  material.sourceLabel = "15";
  const before = structuredClone({ questions: [duplicate, material] });
  const initial = importTriage(before);
  assert.equal(initial.counts.todo, 0);
  const finding = { id: "independent-material", dimension: "material", fieldPath: "stem",
    reason: "回归形状：独立核对发现锐角条件矛盾，保留原题待核，不代表该旧ready正确。" };
  const eligibility = { [material.questionId]: { eligible: false, sourceMaterialFindings: [finding] } };
  const result = importTriage(before, eligibility, { [material.questionId]: controls(material) });
  assert.deepEqual(result.rows.filter(row => row.needsAction).map(row => row.questionId), [material.questionId]);
  assert.equal(result.counts.todo, 1);
  assert.equal(result.counts.duplicates, 1);
  assert.equal(result.counts.red, 1);
  assert.equal(result.counts.sourcePending, 1);
  assert.equal(result.counts.teachingPending, 0);
  assert.equal(result.rows[1].sourceState, "blocked");
  assert.equal(result.rows[1].issues[0].domain, "source");
  assert.equal(result.rows[1].issues[0].provenanceLabel, "人工核对");
  assert.equal(result.rows[1].issues[0].target.sourceContentSha256, sourceHash);
  assert.equal(result.rows[1].issues[0].target.candidateSha256, candidateHash);
  const refreshed = structuredClone(material);
  refreshed.teachingWorkflow.status = "needs_review";
  refreshed.teachingWorkflow.effectiveFindings = [{ ...finding, type: "quality", origin: "external_review" }];
  const repeated = importTriage({ questions: [refreshed] }, eligibility, { [refreshed.questionId]: controls(refreshed) });
  assert.equal(repeated.rows[0].issues.length, 1);
  assert.equal(repeated.counts.sourcePending, 1);
  assert.equal(repeated.counts.teachingPending, 0);
  assert.equal(repeated.rows[0].teachingState, "needs_review");
  for (const status of ["generation_pending", "generation_failed", "review_failed"]) {
    refreshed.teachingWorkflow.status = status;
    const technical = importTriage({ questions: [refreshed] }, eligibility, { [refreshed.questionId]: controls(refreshed) });
    assert.equal(technical.counts.teachingPending, 1, status);
  }
  assert.equal(result.rows[0].issues.length, 2);
  assert.equal(result.rows[0].notices.length, 0);
  assert.deepEqual(before, { questions: [duplicate, material] });
});

test("material domain uses canonical source paths and never guesses from a quality message", () => {
  for (const path of ["stem", "options[0].text", "parts[0].stem", "parts[0].prompt"]) {
    const question = q("simulated-material", "needs_review", [{ type: "quality", dimension: "material", fieldPath: path,
      reason: "模拟原题材料核对" }]);
    question.options = [{ label: "A", text: "模拟选项" }];
    question.parts = [{ stem: "模拟旧小问", prompt: "模拟真实合同小问" }];
    const row = importQuestionTriage(question, { controls: controls(question) });
    assert.equal(row.issues[0].domain, "source", path);
    assert.equal(row.issues[0].target.fieldPath, path);
    assert.equal(row.issues[0].target.sourceContentSha256, sourceHash);
    assert.equal(row.sourceState, "blocked");
    assert.equal(row.tone, "red");
  }
  const actualParts = q("simulated-actual-parts", "needs_review", [{ type: "quality", dimension: "material", fieldPath: "parts[0].stem",
    reason: "旧stem路径不指向当前prompt字段" }]);
  actualParts.parts = [{ prompt: "模拟实际小问字段" }];
  const absentStem = importQuestionTriage(actualParts, { controls: controls(actualParts) });
  assert.equal(absentStem.issues[0].domain, "teaching");
  assert.equal(absentStem.issues[0].location, "unavailable");
  for (const path of ["answer", "solution", "materials", "answer/teachingSolution/issues", "parts[(2)].prompt", "options[*].text"]) {
    const question = q("simulated-material", "needs_review", [{ type: "quality", dimension: "material", fieldPath: path,
      reason: "即使文案含原题或缺图，也不能猜测源字段" }]);
    const row = importQuestionTriage(question, { eligibility: { sourceMaterialFindings: [
      { dimension: "material", fieldPath: path, reason: "歧义字段不能由投影猜成原题" },
    ] } });
    assert.equal(row.issues[0].domain, "teaching", path);
    assert.ok(row.issues.every(item => item.domain !== "source"), path);
  }
});

test("issue provenance labels preserve model, external review, and program attribution without rewriting opinions", () => {
  const question = q("regression-guangan-18", "needs_review", [
    { type: "model_issue", issue: "模型原文：原题条件待核对" },
    { type: "quality", origin: "generation_self_check", dimension: "proof", reason: "模型自检意见" },
    { type: "quality", origin: "external_review", dimension: "mathematics", reason: "独立核对意见" },
    { type: "quality", origin: "operator", dimension: "proof", reason: "操作人核对意见" },
    { type: "technical", message: "连接未完成" },
    { type: "display", message: "公式分隔符未闭合" },
    { type: "term", term: "范数" },
  ]);
  const sourceOpinion = "回归旧模型意见：分布列表头X、Y疑似颠倒；本测试不确认该结论。";
  question.modelReview = { status: "needs_review", issues: [{ field: "stem", message: sourceOpinion }] };
  question.teachingWorkflow.candidateResult.issues = ["模型原文：原题条件待核对"];
  const original = structuredClone(question);
  const result = importQuestionTriage(question);
  assert.equal(result.issues.find(item => item.message === sourceOpinion).provenanceLabel, "模型提示");
  assert.equal(result.issues.find(item => item.message === "模型原文：原题条件待核对").provenanceLabel, "模型提示");
  assert.equal(result.issues.find(item => item.message === "模型自检意见").provenanceLabel, "模型提示");
  assert.equal(result.issues.find(item => item.message === "独立核对意见").provenanceLabel, "人工核对");
  assert.equal(result.issues.find(item => item.message === "操作人核对意见").provenanceLabel, "人工核对");
  assert.equal(result.issues.find(item => item.message === "连接未完成").provenanceLabel, "程序校验");
  assert.equal(result.issues.find(item => item.message === "公式分隔符未闭合").provenanceLabel, "程序校验");
  assert.equal(result.issues.find(item => item.type === "term").provenanceLabel, "术语检查");
  assert.deepEqual(question, original);
});

test("a source-material quality finding cannot reuse the location of a changed source", () => {
  const question = q("simulated-material", "needs_review", [{ type: "quality", dimension: "material", fieldPath: "stem",
    reason: "模拟必要题图引用缺失，需对照原卷" }]);
  const control = controls(question);
  question.teachingWorkflow.sourceContentSha256 = "c".repeat(64);
  const row = importQuestionTriage(question, { controls: control });
  assert.equal(row.issues[0].domain, "source");
  assert.equal(row.issues[0].location, "unavailable");
  assert.equal(row.needsAction, true);
  assert.equal(row.tone, "red");
});

test("simulated technical failures and interrupted review preserve failed status", () => {
  const question = q("simulated-1", "generation_failed");
  const before = structuredClone(question);
  const row = importQuestionTriage(question);
  assert.equal(row.teachingState, "failed");
  assert.equal(row.tone, "amber");
  assert.deepEqual(question, before);
  question.teachingWorkflow.status = "ready_candidate";
  question.teachingWorkflow.reviewFailurePending = true;
  assert.equal(importQuestionTriage(question).teachingState, "needs_review");
});

test("simulated published and todo counters overlap without changing eligible count", () => {
  const first = q("simulated-1", "ready_candidate");
  const second = q("simulated-2", "generation_failed");
  const third = q("simulated-3", "ready_candidate");
  third.duplicateCandidates = [{ exact: true }];
  const result = importTriage({ questions: [first, second, third], publishedQuestionIds: [second.questionId] },
    { [first.questionId]: { eligible: true } });
  assert.deepEqual(result.counts, { total: 3, todo: 1, amber: 1, red: 0, published: 1, eligible: 1, duplicates: 1, teachingPending: 1, sourcePending: 0 });
});

test("simulated exact bound UTF16 offsets are usable; stale targets never highlight another draft", () => {
  const question = q("simulated-1");
  question.teachingWorkflow.candidateResult.teachingSolution = "模拟😀线性表示结束";
  question.teachingWorkflow.findings = [{ type: "term", term: "线性表示", fieldPath: "teachingSolution", start: 4, end: 8 }];
  const control = controls(question);
  const row = importQuestionTriage(question, { controls: control });
  assert.equal(row.issues[0].location, "range");
  assert.equal(row.issues[0].target.start, 4);
  assert.equal(row.issues[0].target.end, 8);
  const changed = structuredClone(question);
  changed.teachingWorkflow.candidateResult.teachingSolution = "新稿不能复用旧位置";
  assert.equal(importQuestionTriage(changed, { controls: control }).issues[0].location, "unavailable");
  assert.equal(importQuestionTriage(question, { controls: control, dirty: true }).issues[0].location, "unavailable");
  question.teachingWorkflow.findings[0].target = { domain: "teaching", fieldPath: "teachingSolution",
    candidateSha256: "c".repeat(64), sourceContentSha256: sourceHash };
  assert.equal(importQuestionTriage(question, { controls: control }).issues[0].location, "unavailable");
});

test("simulated missing range degrades to field; absent location never guesses by quote", () => {
  const question = q("simulated-1", "needs_review", [{ type: "quality", dimension: "proof", fieldPath: "teachingSolution", quote: "由" }]);
  assert.equal(importQuestionTriage(question, { controls: controls(question) }).issues[0].location, "field");
  question.teachingWorkflow.findings[0].fieldPath = "untrusted.other";
  assert.equal(importQuestionTriage(question, { controls: controls(question) }).issues[0].location, "unavailable");
});

test("simulated stale explicit original-field target never highlights a changed source", () => {
  const question = q();
  question.modelReview = { status: "needs_review", issues: [{ field: "stem", message: "模拟原题核对", target: {
    domain: "source", fieldPath: "stem", sourceContentSha256: "c".repeat(64),
  } }] };
  const options = { controls: controls(question) };
  assert.equal(importQuestionTriage(question, options).issues[0].location, "unavailable");
  question.modelReview.issues[0].target.sourceContentSha256 = sourceHash;
  assert.equal(importQuestionTriage(question, options).issues[0].location, "field");
});

test("simulated old questions without teaching workflow do not manufacture an AI failure", () => {
  const question = { questionId: "simulated-legacy", modelReview: { status: "ready", issues: [] } };
  const row = importQuestionTriage(question, { eligibility: { eligible: true } });
  assert.equal(row.teachingState, "not_started");
  assert.equal(row.needsAction, false);
  assert.equal(row.issues.length, 0);
});
