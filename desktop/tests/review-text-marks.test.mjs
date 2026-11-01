import test from "node:test";
import assert from "node:assert/strict";
import { reviewTextMarks } from "../src/review-text-marks.ts";
import { mathSegments } from "../src/shared/math-segments.mjs";
import { richContent } from "../src/rich-content.ts";
import { compactTeachingText } from "../src/teaching-text.ts";

const binding = { candidateSha256: "a".repeat(64), sourceContentSha256: "b".repeat(64) };
function issue(id, text, term, extra = {}) {
  const start = text.indexOf(term);
  return { id, domain: "teaching", location: "range", target: { domain: "teaching", fieldPath: "teachingSolution", ...binding, start, end: start + term.length }, ...extra };
}
const marked = value => value.runs.filter(run => run.issueIds.length);

test("simulated exact plain-text positions mark only the bound occurrence and preserve original characters", () => {
  const text = "凹凸一词先出现，后文再讨论凹凸。";
  const finding = issue("sim-last", text, "凹凸");
  finding.target.start = text.lastIndexOf("凹凸"); finding.target.end = finding.target.start + 2;
  const before = structuredClone(finding);
  const result = reviewTextMarks(text, "teachingSolution", [finding], binding);
  assert.equal(marked(result).length, 1);
  assert.equal(marked(result)[0].start, text.lastIndexOf("凹凸"));
  assert.equal(marked(result)[0].text, "凹凸");
  assert.equal(result.runs.map(run => run.text).join(""), text);
  assert.deepEqual(finding, before);
});

test("simulated LaTeX command flags expand to one complete formula and retain every issue identity", () => {
  const formula = "$S=\\int_0^1 x^2\\,dx+\\int_1^2 x\\,dx$";
  const text = `先求面积：${formula}，再判断凹凸。`;
  const first = issue("sim-int-1", text, "\\int");
  const second = issue("sim-int-2", text, "\\int");
  second.target.start = text.lastIndexOf("\\int"); second.target.end = second.target.start + 4;
  const third = issue("sim-word", text, "凹凸");
  const result = reviewTextMarks(text, "teachingSolution", [first, second, third], binding);
  assert.equal(marked(result).length, 2);
  assert.equal(marked(result)[0].text, formula);
  assert.deepEqual(marked(result)[0].issueIds, ["sim-int-1", "sim-int-2"]);
  assert.deepEqual(mathSegments(marked(result)[0].text).map(part => part.type), ["math"]);
  assert.equal(result.runs.map(run => run.text).join(""), text);
});

test("simulated display and multiline math are never cut into invalid KaTeX fragments", () => {
  const formula = "\\[\\begin{aligned}S&=\\int_0^1 x\\,dx\\\\\n&=\\frac12\\end{aligned}\\]";
  const text = `由题意\n${formula}\n得结论。`;
  const result = reviewTextMarks(text, "teachingSolution", [issue("sim-display", text, "\\int")], binding);
  assert.equal(marked(result)[0].text, formula);
  assert.equal(mathSegments(marked(result)[0].text)[0].displayMode, true);
  assert.equal(result.fallback, null);
});

test("simulated wrong field, domain, stale binding and invalid UTF16 offsets never invent a mark", () => {
  const text = "🙂再讨论凹凸。";
  const valid = issue("sim-correct", text, "凹凸");
  const wrongField = { ...valid, id: "sim-field", target: { ...valid.target, fieldPath: "difficultyAssessment.basis" } };
  const source = { ...valid, id: "sim-source", domain: "source" };
  const stale = { ...valid, id: "sim-stale", target: { ...valid.target, candidateSha256: "c".repeat(64) } };
  const invalid = { ...valid, id: "sim-invalid", target: { ...valid.target, start: 1, end: 2 } };
  const fieldOnly = { ...valid, id: "sim-field-only", location: "field", target: { ...valid.target, start: undefined, end: undefined } };
  const noTarget = { ...valid, id: "sim-no-target", target: undefined };
  const result = reviewTextMarks(text, "teachingSolution", [wrongField, source, stale, invalid, fieldOnly, noTarget], binding);
  assert.equal(marked(result).length, 0);
  assert.deepEqual(result.fieldIssueIds, ["sim-invalid", "sim-field-only"]);
  assert.deepEqual(result.unlocatedIssueIds, ["sim-invalid", "sim-field-only"]);
});

test("simulated tables, images, HTML and code stay whole through the established renderer", () => {
  const fixtures = [
    "| 方法 | 说明 |\n| --- | --- |\n| 凹凸 | 待核对 |",
    '<table><tr><td rowspan="2">凹凸</td><td>$a<b$</td></tr></table>',
    "先判断凹凸，见图 ![函数图](asset:real-image)。",
    "<p>判断凹凸</p>",
    "把 &amp; 与凹凸表述一起核对。",
    "检查 `凹凸` 表述。",
  ];
  for (const text of fixtures) {
    const result = reviewTextMarks(text, "teachingSolution", [issue("sim-structure", text, "凹凸")], binding);
    assert.equal(result.fallback, "rich_structure");
    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0].text, text);
    assert.equal(marked(result).length, 0);
    assert.deepEqual(richContent(result.runs[0].text), richContent(text));
    assert.deepEqual(result.unlocatedIssueIds, ["sim-structure"]);
  }
});

test("simulated unpaired math and cross-run display changes fall back without damaging content", () => {
  const broken = "用 $\\int x 后判断凹凸。";
  assert.equal(reviewTextMarks(broken, "teachingSolution", [issue("sim-broken", broken, "凹凸")], binding).fallback, "rich_structure");
  const text = "先说明 凹凸 再计算。";
  const project = value => value.replace("说明 凹凸 再", "说明凹凸再");
  const result = reviewTextMarks(text, "teachingSolution", [issue("sim-projection", text, "凹凸")], binding, project);
  assert.equal(result.fallback, "display_projection");
  assert.equal(result.runs[0].text, project(text));
  assert.deepEqual(result.unlocatedIssueIds, ["sim-projection"]);
});

test("simulated whole-field display projection remains exact without marks or model findings", () => {
  const text = "此题为 medium_hard。";
  const project = value => value.replace("medium_hard", "中等偏较难");
  const result = reviewTextMarks(text, "difficultyAssessment.basis", [], binding, project);
  assert.equal(result.runs[0].text, "此题为 中等偏较难。");
  assert.equal(result.fallback, null);
  assert.deepEqual(result.fieldIssueIds, []);
  assert.equal(text, "此题为 medium_hard。");
});

test("simulated compact formula layout retains reliable marks and matches the complete reading projection", () => {
  const formula = "$$S=\\int_0^1 x\\,dx$$";
  const text = `先计算\n${formula}\n再判断。`;
  const result = reviewTextMarks(text, "teachingSolution", [issue("sim-compact", text, "\\int")], binding, compactTeachingText);
  assert.equal(result.fallback, null);
  assert.equal(marked(result).length, 1);
  assert.deepEqual(marked(result)[0].issueIds, ["sim-compact"]);
  assert.equal(result.runs.map(run => run.text).join(""), compactTeachingText(text));
  assert.equal(mathSegments(marked(result)[0].text).find(part => part.type === "math").source, "S=\\int_0^1 x\\,dx");
  const paragraphs = `先计算\n\n${formula}\n\n再判断。`;
  const paragraphResult = reviewTextMarks(paragraphs, "teachingSolution", [issue("sim-paragraph", paragraphs, "\\int")], binding, compactTeachingText);
  assert.equal(paragraphResult.runs.map(run => run.text).join(""), compactTeachingText(paragraphs));
});
