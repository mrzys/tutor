import test from "node:test";
import assert from "node:assert/strict";
import { reviewMessageText } from "../src/review-message.ts";
import { mathSegments } from "../src/shared/math-segments.mjs";

test("simulated repeated structured term warnings render symbols without changing surrounding review copy", () => {
  const raw = String.raw`仍含需复核术语“\int”；检查术语“\int”；术语“\lim”。`;
  const view = reviewMessageText(raw);
  assert.equal(view, String.raw`仍含需复核术语“\(\int\)”；检查术语“\(\int\)”；术语“\(\lim\)”。`);
  assert.deepEqual(mathSegments(view).filter(part => part.type === "math").map(part => part.source), [String.raw`\int`, String.raw`\int`, String.raw`\lim`]);
  assert.equal(raw, String.raw`仍含需复核术语“\int”；检查术语“\int”；术语“\lim”。`);
});

test("simulated complete quoted fractions, roots, Greek symbols and bounded expressions use the existing renderer grammar", () => {
  for (const formula of [String.raw`\frac{1}{2}`, String.raw`\sqrt{x+1}`, String.raw`\alpha+\beta`,
    String.raw`\lim_{x\to0}\frac{\sin x}{x}=1`, String.raw`\int_0^1 x\,\mathrm{d}x`, String.raw`\left(\frac{1}{2}\right)`]) {
    for (const [open, close] of [["“", "”"], ["「", "」"], ["『", "』"], ['"', '"'], ["'", "'"]]) {
      assert.equal(reviewMessageText(`表达式${open}${formula}${close}待核对`), `表达式${open}\\(${formula}\\)${close}待核对`);
    }
  }
});

test("simulated existing formulas retain delimiters, layout and mathematical characters verbatim", () => {
  const raw = String.raw`已检查“$\int$”、\(\lim x\)、$$\frac{a}{b}$$、\[\sqrt{x}\]；仍有术语“\alpha”。`;
  const expected = String.raw`已检查“$\int$”、\(\lim x\)、$$\frac{a}{b}$$、\[\sqrt{x}\]；仍有术语“\(\alpha\)”。`;
  assert.equal(reviewMessageText(raw), expected);
  assert.deepEqual(mathSegments(reviewMessageText(raw)).filter(part => part.type === "math").slice(0, 4).map(part => part.raw),
    mathSegments(raw).filter(part => part.type === "math").map(part => part.raw));
  assert.equal(reviewMessageText(expected), expected);
});

test("simulated unquoted commands, filesystem paths and escaped backslashes are not rewritten", () => {
  for (const raw of [String.raw`术语 \int 仍未核对`, String.raw`路径“C:\int\alpha.txt”不可读`,
    String.raw`路径“\int”不存在`, String.raw`目录“\alpha”不存在`, String.raw`文件名“\int”`,
    String.raw`术语“\\int”`, String.raw`路径“\\server\int”`, String.raw`URL“https://example.com/\int”`]) {
    assert.equal(reviewMessageText(raw), raw);
  }
});

test("simulated unknown or incomplete commands stay visible instead of inventing arguments or dropping the warning", () => {
  for (const formula of [String.raw`\unknownsymbol`, String.raw`\frac{1}`, String.raw`\frac`, String.raw`\sqrt`,
    String.raw`\sqrt{`, String.raw`\frac{1}{2`, String.raw`\left(x`, String.raw`\alpha_`, String.raw`\int+\unknownsymbol`]) {
    const raw = `术语“${formula}”需修复`;
    assert.equal(reviewMessageText(raw), raw);
  }
  assert.equal(reviewMessageText('术语“\\int'), '术语“\\int');
});

test("simulated unsafe markup, renderer commands and malformed existing delimiters remain escaped text for MathText", () => {
  for (const raw of [String.raw`术语“\href{javascript:alert(1)}{x}”`, String.raw`术语“\htmlClass{evil}{x}”`,
    String.raw`术语“\includegraphics{file:///secret}”`, String.raw`术语“\newcommand{\a}{x}\a”`,
    String.raw`<img src=x onerror=alert(1)>；术语“<script>\int</script>”`,
    String.raw`未配对 \(；术语“\int”`, String.raw`未配对 $；术语“\int”`]) {
    assert.equal(reviewMessageText(raw), raw);
  }
  assert.equal(reviewMessageText(null), "");
  assert.equal(reviewMessageText({ message: String.raw`术语“\int”` }), "");
});
