import test from "node:test";
import assert from "node:assert/strict";
import { frozenTeachingKnowledge, teachingAnalysisPresentation, teachingFocusPresentation } from "../src/shared/teaching-analysis.mjs";
import { richContent } from "../src/rich-content.ts";

function question(overrides = {}) {
  return {
    contentVersion: "simulated-content-1",
    teacherVersion: "simulated-reference-1",
    student: { stem: "模拟回归题：求最小值。" },
    teacher: { answers: [{ text: "2" }], solutions: [{ text: "模拟原有解析：$x+1/x\\ge2$。" }] },
    teachingAnalysis: {
      baseContentVersion: "simulated-content-1",
      baseTeacherVersion: "simulated-reference-1",
      provenance: "llm_generated",
      model: "simulated-model",
      solution: "模拟教学讲解：$x>0$，由基本不等式得 $x+\\frac{1}{x}\\ge2$。",
      status: "ready",
      issues: [],
      ...overrides,
    },
  };
}

test("student presentation excludes generated teaching text even when both reference and AI materials exist", () => {
  const q = question();
  assert.equal(teachingAnalysisPresentation(q), null);
  assert.equal(teachingAnalysisPresentation(q, false), null);
  assert.equal(teachingAnalysisPresentation(q, "student"), null);
  assert.equal(teachingAnalysisPresentation(q, true).solution, q.teachingAnalysis.solution);
});

function questionWithAcknowledgedNotice() {
  const issue = "模拟参考笔误：原参考变量名错误，新稿已独立核对。";
  const q = question({ answer: "2", issues: [issue] });
  q.teachingAnalysis.sourceCandidate = { answer: "2", teachingSolution: q.teachingAnalysis.solution,
    teachingFocus: q.teachingAnalysis.teachingFocus, issues: [issue] };
  q.teachingAnalysis.reviewDispositions = { version: 1, sourceContentSha256: "a".repeat(64), candidateSha256: "b".repeat(64),
    acknowledgements: [{ issueIndex: 0, issueSha256: "c".repeat(64), message: issue, classification: "reference_notice",
      basis: "模拟核对原页和本稿推导，不影响答案。", checks: { sourceMatched: true, answerChecked: true, solutionChecked: true, formulaChecked: true },
      method: "teacher_review", checkedBy: "teacher", operationId: "simulated-notice-ack", acknowledgedAt: "2026-10-24T00:00:00Z" }] };
  return q;
}

test("backend-validated ready notices remain visible without mislabelling the whole teaching draft", () => {
  const q = questionWithAcknowledgedNotice();
  const before = structuredClone(q);
  const display = teachingAnalysisPresentation(q, true);
  assert.equal(display.needsReview, false);
  assert.deepEqual(display.issues, []);
  assert.equal(display.notices[0].message, q.teachingAnalysis.issues[0]);
  assert.match(display.notices[0].basis, /核对原页/);
  assert.equal(display.notices[0].reviewerLabel, "人工核对");
  q.teachingAnalysis.reviewDispositions.acknowledgements[0].method = "user_authorized_agent_review";
  q.teachingAnalysis.reviewDispositions.acknowledgements[0].checkedBy = "codex";
  assert.equal(teachingAnalysisPresentation(q, true).notices[0].reviewerLabel, "授权代理核对");
  q.teachingAnalysis.reviewDispositions.acknowledgements[0].method = "teacher_review";
  q.teachingAnalysis.reviewDispositions.acknowledgements[0].checkedBy = "teacher";
  assert.deepEqual(q, before);
  assert.equal(teachingAnalysisPresentation(q, false), null);
});

test("notice labels alone cannot remove unresolved or stale teaching warnings", () => {
  for (const change of [
    q => { delete q.teachingAnalysis.sourceCandidate; },
    q => { q.teachingAnalysis.reviewDispositions.candidateSha256 = ""; },
    q => { q.teachingAnalysis.sourceCandidate.teachingSolution = "旧稿"; },
    q => { q.teachingAnalysis.reviewDispositions.acknowledgements[0].message = "另一条意见"; },
    q => { q.teachingAnalysis.reviewDispositions.acknowledgements[0].basis = " "; },
    q => { q.teachingAnalysis.reviewDispositions.acknowledgements[0].checks.formulaChecked = false; },
    q => { q.teachingAnalysis.reviewDispositions.acknowledgements[0].method = "model_auto_ack"; },
    q => { q.teachingAnalysis.reviewDispositions.acknowledgements.push(q.teachingAnalysis.reviewDispositions.acknowledgements[0]); },
    q => { q.teachingAnalysis.status = "needs_review"; },
  ]) {
    const q = questionWithAcknowledgedNotice(); change(q);
    const display = teachingAnalysisPresentation(q, true);
    assert.equal(display.needsReview, true);
    assert.equal(display.notices.length, 0);
    assert.deepEqual(display.issues, q.teachingAnalysis.issues);
  }
  const q = questionWithAcknowledgedNotice();
  q.teachingAnalysis.issues.push("模拟另一条未核对的条件疑点");
  q.teachingAnalysis.sourceCandidate.issues.push(q.teachingAnalysis.issues[1]);
  const display = teachingAnalysisPresentation(q, true);
  assert.equal(display.notices.length, 1);
  assert.equal(display.needsReview, true);
  assert.deepEqual(display.issues, ["模拟另一条未核对的条件疑点"]);
});

test("both source versions must match; archived questions and unusable drafts retain reference materials", () => {
  for (const change of [
    { baseContentVersion: "simulated-content-old" },
    { baseTeacherVersion: "simulated-reference-old" },
    { provenance: "source" },
    { status: "failed" },
    { status: "processing" },
    { solution: "  " },
  ]) {
    const q = question(change);
    assert.equal(teachingAnalysisPresentation(q, true), null);
    assert.equal(q.teacher.solutions[0].text, "模拟原有解析：$x+1/x\\ge2$。");
  }
  const frozen = question();
  delete frozen.teachingAnalysis;
  assert.equal(teachingAnalysisPresentation(frozen, true), null);
  for (const version of ["contentVersion", "teacherVersion"]) {
    const incomplete = question();
    delete incomplete[version];
    assert.equal(teachingAnalysisPresentation(incomplete, true), null);
  }
});

test("AI origin and unresolved feedback stay explicit without changing source answers or original solutions", () => {
  const q = question({ status: "needs_review", issues: ["模拟疑点：取等条件需核对。"] });
  const before = structuredClone(q);
  const display = teachingAnalysisPresentation(q, true);
  assert.equal(display.label, "AI教学解析");
  assert.equal(display.originLabel, "AI 生成");
  assert.equal(display.model, "simulated-model");
  assert.equal(display.statusLabel, "待复核");
  assert.deepEqual(display.issues, ["模拟疑点：取等条件需核对。"]);
  assert.deepEqual(q, before);
  assert.equal(teachingAnalysisPresentation(question({ issues: ["模拟未解决疑点"] }), true).needsReview, true);
  assert.equal(teachingAnalysisPresentation(question(), true).statusLabel, "");
});

test("new import draft answer is teacher-only and never fills missing original answers", () => {
  const q=question({answer:"模拟生成答案：$2$"});q.teacher.answers=[];
  const before=structuredClone(q);
  assert.equal(teachingAnalysisPresentation(q,false),null);
  assert.equal(teachingAnalysisPresentation(q,true).answer,"模拟生成答案：$2$");
  assert.equal(teachingAnalysisPresentation(question(),true).answer,"");
  assert.deepEqual(q,before);
});

test("teaching formulas, table cells and comparison signs reach the existing rich-text parser intact", () => {
  const solution = "模拟讲解：$a<b$，故 $\\frac{1}{a}>\\frac{1}{b}$。\n\n| 条件 | 结论 |\n| --- | --- |\n| $x>0$ | $x+1/x\\ge2$ |";
  const q = question({ solution });
  const display = teachingAnalysisPresentation(q, true);
  assert.equal(display.solution, solution);
  const blocks = richContent(display.solution).blocks;
  assert.equal(blocks[0].content[0].text.includes("$a<b$"), true);
  assert.equal(blocks[0].content[0].text.includes("$\\frac{1}{a}>\\frac{1}{b}$"), true);
  const table = blocks.find(block => block.type === "table");
  assert.equal(table.rows[1][1].content[0].text, "$x+1/x\\ge2$");
});

const simulatedFocus = {
  knowledgePoints: ["基本不等式", "正数的倒数"],
  examFocus: "识别正数条件，利用基本不等式求最小值并检查取等。",
  studentRequirements: ["能识别 $x>0$ 的适用条件", "能检验 $x=1$ 时等号成立"],
};

test("teaching focus belongs to the teacher view and the exact content/reference versions", () => {
  const q = question({ teachingFocus: simulatedFocus });
  for (const audience of [undefined, false, "teacher", "student"]) {
    assert.equal(teachingFocusPresentation(q, audience), null);
  }
  for (const overrides of [
    { baseContentVersion: "simulated-content-older" },
    { baseTeacherVersion: "simulated-reference-older" },
    { status: "processing" },
    { provenance: "source" },
  ]) {
    assert.equal(teachingFocusPresentation(question({ teachingFocus: simulatedFocus, ...overrides }), true), null);
  }
  const display = teachingFocusPresentation(q, true);
  assert.deepEqual(display.knowledgePoints, simulatedFocus.knowledgePoints);
  assert.equal(display.examFocus, simulatedFocus.examFocus);
  assert.deepEqual(display.studentRequirements, simulatedFocus.studentRequirements);
  assert.equal(display.originLabel, "AI 生成");
  assert.equal(display.model, "simulated-model");
});

test("legacy or unknown focus never infers requirements from old tags, source explanations or student records", () => {
  const legacy = question();
  legacy.scopeEvidence = { primaryTopics: ["模拟旧泛标签"] };
  legacy.studentRecord = { name: "模拟学生", remarks: "模拟掌握情况" };
  assert.equal(teachingFocusPresentation(legacy, true), null);
  for (const teachingFocus of [null, "模拟旧文本", []]) {
    assert.equal(teachingFocusPresentation(question({ teachingFocus }), true), null);
  }
  const unknown = question({ teachingFocus: {
    knowledgePoints: [null, " ", 3],
    examFocus: null,
    studentRequirements: undefined,
  } });
  const before = structuredClone(unknown);
  const display = teachingFocusPresentation(unknown, true);
  assert.deepEqual(display.knowledgePoints, []);
  assert.equal(display.examFocus, "");
  assert.deepEqual(display.studentRequirements, []);
  assert.deepEqual(unknown, before);
});

test("teaching focus preserves mathematical content and the current draft's unresolved status", () => {
  const formulas = {
    knowledgePoints: ["含参范围 $0<a<1$"],
    examFocus: "核对 $\\frac{1}{a}>1$ 与 $a<1$ 的等价关系。",
    studentRequirements: ["能写出 $a>0$", "能说明 $a=1$ 不可取"],
  };
  const q = question({ teachingFocus: formulas, status: "needs_review", issues: ["模拟待核对条件"] });
  const display = teachingFocusPresentation(q, true);
  assert.equal(display.needsReview, true);
  assert.equal(display.statusLabel, "待复核");
  assert.equal(display.examFocus, formulas.examFocus);
  for (const text of [...display.knowledgePoints, display.examFocus, ...display.studentRequirements]) {
    assert.equal(richContent(text).blocks[0].content[0].text, text);
  }
  assert.equal(teachingFocusPresentation(question({ teachingFocus: formulas }), true).needsReview, false);
});

test("v2 focus uses formal frozen knowledge and does not persist or reuse duplicated AI knowledge", () => {
  const q = question({ teachingFocusSchemaVersion: 2, teachingFocus: {
    examFocus: simulatedFocus.examFocus,
    studentRequirements: simulatedFocus.studentRequirements,
  } });
  q.questionId = "simulated-question";
  const snapshot = { entries: [{
    questionId: q.questionId,
    contentVersion: q.contentVersion,
    teacherVersion: q.teacherVersion,
    primaryKnowledgeUids: ["simulated-kp"],
  }] };
  const catalogue = { knowledgeCatalogue: { points: [{ uid: "simulated-kp", name: "模拟正式主考知识" }] } };
  const before = structuredClone(q);
  const knowledge = frozenTeachingKnowledge(q, snapshot, catalogue);
  const display = teachingFocusPresentation(q, true, knowledge);
  assert.equal(display.knowledgeLabel, "主考知识");
  assert.equal(display.examFocusLabel, "考查任务");
  assert.deepEqual(display.knowledgePoints, ["模拟正式主考知识"]);
  assert.equal(display.examFocus, simulatedFocus.examFocus);
  assert.deepEqual(display.studentRequirements, simulatedFocus.studentRequirements);
  assert.deepEqual(q, before);
  assert.equal(teachingFocusPresentation(q, false, knowledge), null);
  assert.deepEqual(teachingFocusPresentation(q, true).knowledgePoints, []);
  q.teachingAnalysis.teachingFocus.knowledgePoints = ["模拟不应再使用的冗余文字"];
  assert.deepEqual(teachingFocusPresentation(q, true, knowledge).knowledgePoints, knowledge);
  // The legacy snapshot keeps its original three fields, even when a caller
  // supplies newer catalogue names.
  const legacy = question({ teachingFocus: simulatedFocus });
  assert.deepEqual(teachingFocusPresentation(legacy, true, knowledge).knowledgePoints, simulatedFocus.knowledgePoints);
  assert.equal(teachingFocusPresentation(legacy, true, knowledge).knowledgeLabel, "考查知识点");
});

test("v2 knowledge never resolves from mismatched snapshot identities or scope prose", () => {
  const q = { ...question(), questionId: "simulated-question" };
  q.scopeEvidence = { primaryTopics: ["模拟旧泛标签"] };
  const entry = { questionId: q.questionId, contentVersion: q.contentVersion,
    teacherVersion: q.teacherVersion, primaryKnowledgeUids: ["simulated-kp"] };
  const catalogue = { knowledgeCatalogue: { points: [{ uid: "simulated-kp", name: "模拟正式主考知识" }] } };
  for (const field of ["questionId", "contentVersion", "teacherVersion"]) {
    assert.deepEqual(frozenTeachingKnowledge(q, { entries: [{ ...entry, [field]: "simulated-old" }] }, catalogue), []);
    assert.deepEqual(frozenTeachingKnowledge({ ...q, [field]: "" }, { entries: [entry] }, catalogue), []);
  }
  assert.deepEqual(frozenTeachingKnowledge(q, { entries: [{ ...entry, primaryKnowledgeUids: undefined }] }, catalogue), []);
  assert.deepEqual(frozenTeachingKnowledge(q, { entries: [entry] }, {}), ["知识点名称未记录"]);
  for (const schemaVersion of [1, 3, "2", null]) {
    assert.equal(teachingFocusPresentation(question({ teachingFocusSchemaVersion: schemaVersion,
      teachingFocus: simulatedFocus }), true), null);
  }
});
