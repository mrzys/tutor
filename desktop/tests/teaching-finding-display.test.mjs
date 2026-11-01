import test from "node:test";
import assert from "node:assert/strict";
import { teachingFindingMessage } from "../src/teaching-finding-display.ts";

test("simulated display findings explain each known formatting defect in Chinese", () => {
  const expected = {
    literal_newline_escape: "解析中存在未正确处理的换行符，需修复排版",
    control_character: "解析中存在异常控制字符，需修复排版",
    unpaired_math_delimiter: "解析中的公式标记未成对，需修复公式排版",
    mixed_math_delimiter: "解析中的公式标记混用，需统一公式排版",
  };
  for (const [code, message] of Object.entries(expected)) {
    assert.equal(teachingFindingMessage({ type: "display", code }), message);
    assert.equal(teachingFindingMessage({ type: "display", code, message: code }), message);
  }
});

test("simulated unknown codes retain an actionable Chinese fallback without exposing enums", () => {
  assert.equal(teachingFindingMessage({ type: "display", code: "future_display_defect" }), "解析中存在排版异常，请核对并修复");
  assert.equal(teachingFindingMessage({ type: "incomplete", code: "future_missing_field" }), "解析内容不完整，请补充后重新核对");
  for (const code of ["future_quality_check", "constructor", "__proto__"]) {
    const message = teachingFindingMessage({ code });
    assert.match(message, /核对/);
    assert.ok(!message.includes(code));
  }
  assert.equal(teachingFindingMessage({ type: "format", message: "unknown_format_error" }), "解析结构不符合要求，请检查内容是否完整");
});

test("simulated detailed opinions and terminology remain visible without mutating the audit", () => {
  const finding = { type: "display", code: "literal_newline_escape", message: "第二行的换行位置需对照解析调整", fieldPath: "teachingSolution", start: 4 };
  const original = structuredClone(finding);
  assert.equal(teachingFindingMessage(finding), finding.message);
  assert.deepEqual(finding, original);
  assert.equal(teachingFindingMessage({ type: "model_issue", issue: "参数取值缺少讨论" }), "参数取值缺少讨论");
  assert.equal(teachingFindingMessage({ type: "term", term: "模拟术语" }), "仍含需复核术语“模拟术语”");
});
