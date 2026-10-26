import test from "node:test";
import assert from "node:assert/strict";
import { confirmedSlotTaskLabel, frozenAnnotation, frozenDifficultyBasis } from "../src/shared/assembly-evidence.mjs";
import { richContent } from "../src/rich-content.ts";

const question = { questionId: "simulated-question", contentVersion: "content-1", teacherVersion: "teacher-1" };
const basis = "模拟内容依据：需辨认 $x>0$，再使用 $x+1/x\\ge2$ 并检查取等条件。";
const annotation = { ...question, difficultyLevel: "medium", difficultyBasis: { rationale: basis } };

test("模拟回归：难度依据只取冻结同版本字段，不将题位目标或教学解法作为依据", () => {
  const slot = { question, targetDifficulty: 0.70, planningReason: "模拟规划理由", difficultyBasis: "模拟题位理由" };
  const withTeaching = { ...question, teachingAnalysis: { solution: "模拟教学解法" }, teacher: { solutions: [{ text: "模拟参考解析" }] } };
  const snapshot = { entries: [{ ...annotation, difficultyBasis: "模拟过期注解", teacherVersion: "teacher-old" }, annotation] };
  const before = structuredClone({ slot, snapshot, withTeaching });
  assert.equal(frozenAnnotation(question, snapshot), annotation);
  assert.equal(frozenDifficultyBasis(slot.question, snapshot), basis);
  assert.equal(frozenDifficultyBasis(withTeaching, snapshot), basis);
  assert.equal(frozenDifficultyBasis(question, { entries: [{ ...annotation, difficultyBasis: "模拟字符串依据" }] }), "模拟字符串依据");
  assert.deepEqual({ slot, snapshot, withTeaching }, before);
  assert.equal(richContent(basis).blocks[0].content[0].text, basis);
});

test("模拟回归：旧卷缺注解、身份或任一版本不匹配时不显示其它来源的难度依据", () => {
  for (const changed of [
    { questionId: "simulated-other" }, { contentVersion: "content-old" }, { teacherVersion: "teacher-old" },
  ]) assert.equal(frozenDifficultyBasis(question, { entries: [{ ...annotation, ...changed }] }), "");
  for (const field of ["questionId", "contentVersion", "teacherVersion"]) {
    const incomplete = { ...question };
    delete incomplete[field];
    const incompleteAnnotation = { ...annotation };
    delete incompleteAnnotation[field];
    assert.equal(frozenDifficultyBasis(incomplete, { entries: [incompleteAnnotation] }), "");
  }
  assert.equal(frozenDifficultyBasis(question, undefined), "");
  assert.equal(frozenDifficultyBasis(question, { entries: [{ ...annotation, difficultyBasis: { solution: "模拟解法" } }] }), "");
  assert.equal(frozenDifficultyBasis(null, { entries: [annotation] }), "");
});

test("模拟回归：缺题位展示已保存考查点，缺标签只按精确任务身份回退冻结目录", () => {
  const frozen = { tasks: [{ id: "simulated-a", label: "模拟冻结任务：用基本不等式求最值" }, { id: "simulated-b", label: "模拟其它考查点" }] };
  const slot = { taskId: "simulated-a", taskLabel: "模拟已确认任务：检查取等条件", planningReason: "模拟规划理由" };
  const before = structuredClone({ slot, frozen });
  assert.equal(confirmedSlotTaskLabel(slot, frozen), slot.taskLabel);
  assert.equal(confirmedSlotTaskLabel({ ...slot, taskLabel: "  " }, frozen), frozen.tasks[0].label);
  assert.equal(confirmedSlotTaskLabel({ taskId: "simulated-missing", planningReason: "模拟不可替代考查点" }, frozen), "考查点未记录");
  assert.equal(confirmedSlotTaskLabel({ taskId: "simulated-a" }, undefined), "考查点未记录");
  assert.deepEqual({ slot, frozen }, before);
});
