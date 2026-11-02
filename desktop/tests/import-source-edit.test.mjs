import test from "node:test";
import assert from "node:assert/strict";
import { readImportSourceField, replaceImportSourceField, importSourceEditDirty, importSourceEditCurrent } from "../src/import-source-edit.ts";

const fixture = () => ({
  questionId: "simulated-source-q5", stem: "  模拟题干 $x^2$\r\n", answer: "", solution: "模拟原解",
  options: [{ label: "A", text: "模拟选项", image: { assetId: "simulated-image" } }],
  parts: [{ stem: "模拟小问", prompt: "模拟提示", answer: "模拟小问答案", solution: "模拟小问解析", score: 5 }],
  teachingWorkflow: { candidateResult: { answer: "模拟AI答案" }, sourceContentSha256: "a".repeat(64) },
  source: { manifest: "模拟台账", raw: [null, { unmodified: true }] }, reviewChecks: { sourceMatched: true },
});

test("simulated source field editor reads only exact existing text paths", () => {
  const question = fixture();
  for (const [path, value] of [
    ["stem", question.stem], ["answer", ""], ["solution", question.solution], ["options[0].text", "模拟选项"],
    ["parts[0].stem", "模拟小问"], ["parts[0].prompt", "模拟提示"], ["parts[0].answer", "模拟小问答案"], ["parts[0].solution", "模拟小问解析"],
  ]) assert.equal(readImportSourceField(question, path), value);
  for (const path of ["prompt", "questionId", "reviewChecks.sourceMatched", "teachingWorkflow.candidateResult.answer", "source.manifest",
    "options", "options[0].label", "options[0].stem", "parts[0].text", "parts[0].score", "options[-1].text", "options[01].text",
    "options[1].text", "options[9007199254740993].text", "parts[0].__proto__", "__proto__", "options[0].text.extra"]) {
    assert.equal(readImportSourceField(question, path), null, path);
    assert.throws(() => replaceImportSourceField(question, path, "", "模拟新内容"), /不可编辑/);
  }
  assert.equal(readImportSourceField({ stem: 1 }, "stem"), null);
  assert.equal(readImportSourceField(Object.create({ stem: "模拟继承文本" }), "stem"), null);
  assert.equal(readImportSourceField({ parts: [Object.create({ answer: "模拟继承文本" })] }, "parts[0].answer"), null);
});

test("simulated replacement changes one string without normalizing or mutating other source, assets or AI work", () => {
  for (const path of ["stem", "answer", "solution", "options[0].text", "parts[0].stem", "parts[0].prompt", "parts[0].answer", "parts[0].solution"]) {
    const question = fixture();
    const original = structuredClone(question);
    const newText = " \n模拟修正 $\\frac{1}{2}$\r\n ";
    const changed = replaceImportSourceField(question, path, readImportSourceField(question, path), newText);
    assert.equal(readImportSourceField(changed, path), newText);
    assert.deepEqual(question, original);
    assert.deepEqual(replaceImportSourceField(changed, path, newText, readImportSourceField(original, path)), original);
    assert.notEqual(changed.source, question.source);
    assert.notEqual(changed.teachingWorkflow, question.teachingWorkflow);
  }
  assert.equal(replaceImportSourceField(fixture(), "solution", "模拟原解", "").solution, "");
});

test("simulated stale text, missing fields and invalid replacement cannot silently overwrite or create source content", () => {
  const question = fixture();
  assert.throws(() => replaceImportSourceField(question, "stem", question.stem.trim(), "模拟覆盖"), /已变化/);
  assert.throws(() => replaceImportSourceField({ parts: [{}] }, "parts[0].answer", "", "模拟补造"), /不可编辑/);
  assert.throws(() => replaceImportSourceField(question, "stem", question.stem, null), /必须是文本/);
  assert.equal(question.stem, fixture().stem);
});

test("simulated version change keeps field draft dirty but disables its original identity", () => {
  const draft = { id: 1, identity: "simulated-v1", fieldPath: "stem", label: "题干", oldText: "模拟原文", replacement: "模拟输入" };
  assert.equal(importSourceEditDirty(draft), true);
  assert.equal(importSourceEditCurrent(draft, "simulated-v1"), true);
  assert.equal(importSourceEditCurrent(draft, "simulated-v2"), false);
  assert.equal(importSourceEditCurrent(draft, ""), false);
  assert.equal(draft.replacement, "模拟输入");
  assert.equal(importSourceEditDirty({ ...draft, replacement: draft.oldText }), false);
});
