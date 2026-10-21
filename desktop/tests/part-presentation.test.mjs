import test from "node:test";
import assert from "node:assert/strict";
import { partDisplayLabel } from "../src/part-presentation.ts";

test("source Roman headings suppress the invented index without changing prompt text", () => {
  const prompts = ["（Ⅰ）求 $\\omega$ 的值：", "（Ⅱ）求函数的值域。", "（Ⅲ）数列是否为等差数列？"];
  prompts.forEach((prompt, index) => assert.equal(partDisplayLabel(undefined, prompt, index), ""));
  assert.equal(partDisplayLabel("", "(II) 求函数的值域。", 0), "");
  assert.equal(partDisplayLabel("", "（１２） 求和。", 0), "");
  assert.equal(partDisplayLabel("", "（ＩＩ）求函数的值域。", 0), "");
});
test("equivalent explicit labels use the original prompt's single heading", () => {
  for (const label of ["(1)", "（１）", "Ⅰ", "1.", "1、", "（I）"]) {
    assert.equal(partDisplayLabel(label, "（Ⅰ）求值。", 0), "");
  }
  assert.equal(partDisplayLabel("（２）", "(II) 证明。", 1), "");
  assert.equal(partDisplayLabel("（ⅳ）", "（４） 求值。", 3), "");
});
test("different explicit hierarchy and meaningful parenthesized expressions are preserved", () => {
  assert.equal(partDisplayLabel("（1）", "（Ⅱ） 求值。", 0), "（1）");
  for (const prompt of ["(x+1) 是一个因式。", "$(1)$ 为约束条件。", "（a）为待定参数。", "(IVV) 求值。", "设（Ⅰ）成立，求值。", "(1,2)为已知坐标。", "(1)+x=3"]) {
    assert.equal(partDisplayLabel(undefined, prompt, 1), "（2）");
  }
  assert.equal(partDisplayLabel("（甲）", "求值。", 0), "（甲）");
});
