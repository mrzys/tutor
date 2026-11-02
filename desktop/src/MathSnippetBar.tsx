import { For } from "solid-js";

/** Explicit editor helper; it never edits the reading DOM. */
export function MathSnippetBar(props: { onInsert: (snippet: string) => void }) {
  const snippets = [
    ["$...$", "$$", "行内数学公式"], ["a/b", "\\frac{a}{b}", "分式"],
    ["√x", "\\sqrt{x}", "根号"], ["x²", "^{2}", "上标/平方"],
    ["x₁", "_{1}", "下标"], ["≤", "\\le ", "小于等于"],
    ["≥", "\\ge ", "大于等于"], ["≠", "\\neq ", "不等于"],
    ["∈", "\\in ", "属于"], ["⊂", "\\subset ", "真子集"],
    ["±", "\\pm ", "正负号"], ["π", "\\pi ", "圆周率"],
    ["△", "\\triangle ", "三角形"], ["∠", "\\angle ", "角"],
    ["a⃗", "\\vec{a}", "向量"],
  ];
  return <div class="import-math-toolbar" role="toolbar" aria-label="常用数学符号快捷插入">
    <span class="import-math-toolbar-label">常用符号</span>
    <For each={snippets}>{([label, snippet, title]) =>
      <button type="button" class="import-math-token" title={title} aria-label={`插入${title}`}
        onClick={() => props.onInsert(snippet)}>{label}</button>
    }</For>
  </div>;
}
