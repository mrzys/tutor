import test from "node:test";
import assert from "node:assert/strict";
import { choicePresentation } from "../src/choice-presentation.ts";

const images = ["A", "B", "C", "D"].map(label => `![图${label}](asset:${label})\n(${label})`).join("\n");
const stem = `模拟回归：判断图象\n![题图](asset:stem)\n${images}`;
const valid = source => /^asset:[A-D]$/.test(source);
test("reading projection separates only a complete terminal image-caption A-D sequence", () => {
  const result = choicePresentation(stem, [], "single_choice", valid);
  assert.equal(result.stem, "模拟回归：判断图象\n![题图](asset:stem)");
  assert.deepEqual(result.options.map(option => option.label), ["A", "B", "C", "D"]);
  assert.deepEqual(result.options.map(option => option.text), ["A", "B", "C", "D"].map(label => `![图${label}](asset:${label})`));
  assert.equal(result.extracted, true);
  assert.equal(stem.includes("\n(D)"), true);
});
test("unknown assets, duplicate captions, partial choices and mixed prose remain untouched", () => {
  for (const input of [stem.replace("(D)", "(C)"), stem.replace("(C)", "(C) 此后有说明"), stem.replace("asset:D", "asset:A"), stem.replace(/\n!\[图D\][\s\S]+$/, ""), stem + "\n后续条件"]) {
    const result = choicePresentation(input, [], "single_choice", valid);
    assert.equal(result.stem, input);
    assert.equal(result.extracted, false);
  }
  assert.equal(choicePresentation(stem, [], "single_choice", () => false).extracted, false);
  assert.equal(choicePresentation(stem, [], "free_response", valid).extracted, false);
});
test("explicit options are authoritative and never regrouped from the stem", () => {
  const options = [{ label: "A", text: "$x$" }];
  const result = choicePresentation(stem, options, "multiple_choice", valid);
  assert.equal(result.stem, stem);
  assert.equal(result.options, options);
});
