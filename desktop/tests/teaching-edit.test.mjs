import test from "node:test";
import assert from "node:assert/strict";
import { createTeachingEditDraft, teachingEditCurrent, teachingEditDirty, teachingEditCanSave } from "../src/teaching-edit.ts";

const fixture = () => ({question: {questionId: "sim-q-5", sourceLabel: "5"}, controls: {
  sourceContentSha256: "a".repeat(64), candidateSha256: "b".repeat(64), canPatch: true, canAcknowledge: false, issues: [],
  editableFields: [
    {path: "teachingSolution", value: "模拟原推导"},
    {path: "difficultyAssessment.basis", value: "模拟难度依据"},
    {path: "teachingFocus.examFocus", value: "模拟考点"},
    {path: "teachingFocus.studentRequirements[0]", value: "模拟要求"},
  ],
}});

test("simulated explicit field request freezes the exact field and never falls back to another field", () => {
  const {question, controls} = fixture();
  for (const field of controls.editableFields) {
    const draft = createTeachingEditDraft(question, controls, field.path);
    assert.equal(draft.fieldPath, field.path);
    assert.equal(draft.oldText, field.value);
    assert.equal(teachingEditDirty(draft), false);
  }
  assert.equal(createTeachingEditDraft(question, controls, "unsupported"), null);
  assert.equal(createTeachingEditDraft(question, {...controls, canPatch: false}, "teachingSolution"), null);
});

test("simulated same-snapshot projection leaves a modified draft current without replacing its local input", () => {
  const {question, controls} = fixture();
  const draft = {...createTeachingEditDraft(question, controls, "teachingSolution"), replacement: "模拟教师新推导", basis: "模拟核对依据", confirmed: true};
  const refreshed = structuredClone(controls);
  assert.equal(teachingEditCurrent(draft, {...question, unrelatedMetadata: "模拟详情缓存"}, refreshed), true);
  assert.equal(teachingEditCanSave(draft, question, refreshed), true);
  assert.equal(draft.replacement, "模拟教师新推导");
  assert.equal(refreshed.editableFields[0].value, "模拟原推导");
});

test("simulated source, candidate, question or exact field change invalidates submission and retains input", () => {
  const {question, controls} = fixture();
  const draft = {...createTeachingEditDraft(question, controls, "teachingSolution"), replacement: "模拟未保存推导", basis: "模拟依据", confirmed: true};
  for (const [nextQuestion, nextControls] of [
    [{...question, questionId: "another"}, controls],
    [question, {...controls, sourceContentSha256: "c".repeat(64)}],
    [question, {...controls, candidateSha256: "c".repeat(64)}],
    [question, {...controls, editableFields: [{path: "teachingSolution", value: "模拟外部已修改"}]}],
    [question, {...controls, editableFields: []}],
    [question, {...controls, canPatch: false}],
  ]) {
    assert.equal(teachingEditCanSave(draft, nextQuestion, nextControls), false);
    assert.equal(teachingEditDirty(draft), true);
    assert.equal(draft.replacement, "模拟未保存推导");
  }
});

test("simulated editing requires an actual nonempty change, a basis and explicit conclusion confirmation", () => {
  const {question, controls} = fixture();
  const clean = createTeachingEditDraft(question, controls, "teachingSolution");
  for (const changes of [{}, {replacement: " "}, {replacement: "模拟新推导"},
    {replacement: "模拟新推导", basis: "模拟依据"},
    {replacement: "模拟新推导", basis: " ", confirmed: true},
    {replacement: "模拟新推导", basis: "x".repeat(5001), confirmed: true}]) {
    assert.equal(teachingEditCanSave({...clean, ...changes}, question, controls), false);
  }
  assert.equal(teachingEditDirty({...clean, confirmed: true}), true);
  assert.equal(teachingEditDirty({...clean, basis: "模拟尚未保存的依据"}), true);
  assert.equal(teachingEditCanSave({...clean, replacement: "模拟新推导", basis: "模拟依据", confirmed: true}, question, controls), true);
});
