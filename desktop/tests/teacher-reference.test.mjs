import test from "node:test";
import assert from "node:assert/strict";
import { teacherReferenceAvailability, teacherReferenceEntries } from "../src/teacher-reference.ts";

function question() {
  return { questionId: "simulated-availability", contentVersion: "simulated-content", teacherVersion: "simulated-teacher",
    student: { stem: "模拟回归题：计算17+25。", parts: [] }, teacher: { answers: [], solutions: [] } };
}
function generated(q, changes = {}) {
  q.teachingAnalysis = { provenance: "llm_generated", baseContentVersion: q.contentVersion, baseTeacherVersion: q.teacherVersion,
    answer: "42", solution: "模拟解答：17+20+5=42。", status: "ready", issues: [], ...changes };
  return q;
}

test("reference feedback is explicitly teacher-only and does not infer from student answers or legacy flags", () => {
  const q = question(); q.student.answer = "42"; q.teacher.missingReferenceAnswer = false;
  for (const teacher of [undefined, false, "student", "teacher"]) assert.equal(teacherReferenceAvailability(q, teacher), null);
  const value = teacherReferenceAvailability(q, true);
  assert.equal(value.missingAnswer, true); assert.equal(value.missingSolution, true);
  assert.match(value.message, /未附参考答案/); assert.match(value.message, /未附解析/);
  assert.equal(teacherReferenceAvailability(null, true), null);
});

test("empty placeholder rows are absent while short answers, math, tables and image references count as actual content", () => {
  const q = question(); q.teacher.answers = [{ text: "  " }, { text: "<p>&nbsp;</p>" }]; q.teacher.solutions = [{ text: "\u200b\n" }];
  assert.equal(teacherReferenceEntries(q, "answers").length, 0);
  assert.equal(teacherReferenceAvailability(q, true).missingAnswer, true);
  for (const text of ["0", "$\\frac{1}{2}$", "![模拟原卷答案图](asset:answer)", "<table><tr><td>42</td></tr></table>"]) {
    q.teacher.answers = [{ text }]; assert.equal(teacherReferenceAvailability(q, true).missingAnswer, false);
  }
  q.teacher.solutions = [{ text: "17+25=42。" }]; assert.equal(teacherReferenceAvailability(q, true).message, "");
});

test("part references must cover actual parts, and one whole-question reference can cover all parts", () => {
  const q = question(); q.student.parts = [{ partId: "p1" }, { partId: "p2" }];
  q.teacher.answers = [{ partId: "p1", text: "42" }]; q.teacher.solutions = [{ partId: "p2", text: "模拟第二问证明。" }];
  let value = teacherReferenceAvailability(q, true);
  assert.deepEqual(value.missingAnswerParts, ["p2"]); assert.deepEqual(value.missingSolutionParts, ["p1"]);
  assert.match(value.message, /部分小问/);
  q.teacher.answers.push({ partId: "p2", text: "0" }); assert.equal(teacherReferenceAvailability(q, true).missingAnswer, false);
  q.teacher.solutions = [{ partId: null, text: "模拟整题完整证明。" }]; assert.equal(teacherReferenceAvailability(q, true).message, "");
  q.teacher.answers = [{ partId: "another-question-part", text: "42" }];
  value = teacherReferenceAvailability(q, true); assert.equal(value.missingAnswer, true); assert.equal(value.partialAnswer, false);
});

test("the actual legacy main identity covers a whole question without accepting foreign part identities", () => {
  const q = question(); q.teacher.answers = [{ partId: "main", text: "B" }]; q.teacher.solutions = [{ partId: "main", text: "模拟完整原参考解析。" }];
  assert.equal(teacherReferenceAvailability(q, true).message, "");
  q.teacher.answers = [{ partId: "unrelated", text: "B" }]; assert.equal(teacherReferenceAvailability(q, true).missingAnswer, true);
  q.student.parts = [{ partId: "p1" }]; q.teacher.answers = [{ partId: "main", text: "B" }];
  assert.deepEqual(teacherReferenceAvailability(q, true).missingAnswerParts, ["p1"]);
});

test("hierarchical parts accept their actual parent reference without demanding answers for introduction parts", () => {
  const q = question(); q.student.parts = [{ partId: "p1" }, { partId: "p1a", parentPartId: "p1" }, { partId: "p1b", parentPartId: "p1" }, { partId: "p2" }];
  q.teacher.answers = [{ partId: "p1", text: "模拟第一问两项答案。" }, { partId: "p2", text: "42" }];
  assert.equal(teacherReferenceAvailability(q, true).missingAnswer, false);
  q.teacher.answers = [{ partId: "p1a", text: "42" }];
  assert.deepEqual(teacherReferenceAvailability(q, true).missingAnswerParts, ["p1b", "p2"]);
});

test("a ready version-bound AI draft supplies material without hiding missing answers behind its solution", () => {
  const q = generated(question()); const before = structuredClone(q);
  assert.equal(teacherReferenceAvailability(q, true).message, "");
  assert.deepEqual(q, before);
  q.teachingAnalysis.answer = " ";
  const value = teacherReferenceAvailability(q, true); assert.equal(value.missingAnswer, true); assert.equal(value.missingSolution, false);
});

test("pending, stale, invalid and blocking AI drafts cannot claim ready reference availability", () => {
  for (const changes of [{ status: "needs_review" }, { baseContentVersion: "older" }, { baseTeacherVersion: "older" }, { provenance: "source" }, { status: "failed" }, { issues: ["模拟证明仍待核对"] }]) {
    const q = generated(question(), changes); const value = teacherReferenceAvailability(q, true);
    assert.equal(value.missingAnswer, true); assert.equal(value.missingSolution, true);
  }
  assert.equal(teacherReferenceAvailability(generated(question(), { status: "needs_review" }), true).pendingAi, true);
  const q = generated(question(), { status: "needs_review" }); q.teacher.answers = [{ text: "42" }]; q.teacher.solutions = [{ text: "模拟完整原参考。" }];
  assert.equal(teacherReferenceAvailability(q, true).message, "");
});
