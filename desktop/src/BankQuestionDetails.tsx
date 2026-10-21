import { For, Show, createMemo } from "solid-js";
import { Drawer } from "./ui";
import { typeLabels } from "./bridge";
import { RichText } from "./Paper";
import { difficultyLevels } from "./assembly-details";
import { BankQuestionPreview, bankMetadata } from "./BankQuestionCard";
import { questionSourcePresentation } from "./shared/source-label.mjs";

export function BankQuestionDetails(props: { row: any; config: any; onClose: () => void }) {
  const question = () => props.row.question || props.row;
  const metadata = createMemo(() => bankMetadata(props.row));
  const level = createMemo(() => difficultyLevels.find(level => level.id === metadata().difficulty.level));
  const text = (value: any) => typeof value === "string" ? value : typeof value?.rationale === "string" ? value.rationale : "";
  const basis = () => text(metadata().difficulty.basis);
  const source = () => questionSourcePresentation(question(), props.config.sourceManifest);
  const locators = () => metadata().sourceRefs.filter((ref: any) => !/^tutor-set(?:-|$)/i.test(ref.locator || ""))
    .map((ref: any) => `${ref.locator || "题库收录"}${ref.pages?.length ? `（${ref.pages.join("、")} 页）` : ""}`).join("；");
  return <Drawer title="题目信息" onClose={props.onClose}>
    <section class="assembly-details-section question-details" aria-label="题目考查信息">
      <dl class="explanation-list">
        <div><dt>题型</dt><dd>{typeLabels[question().questionType] || "未记录"}</dd></div>
        <div><dt>题目难度</dt><dd>{level()?.label || "未评估"}<Show when={level()}><small class="question-detail-note">内容估计，未经学生作答标定</small></Show></dd></div>
        <Show when={level() && basis()}><div><dt>难度依据</dt><dd><RichText text={basis()} question={question()} /></dd></div></Show>
        <div><dt>考查点</dt><dd><RichText text={metadata().taskLabels.join("；") || metadata().taskSummary} question={question()} /></dd></div>
        <div><dt>{metadata().knowledgeLabel}</dt><dd><RichText text={metadata().topics.join("、") || "未单独标注"} question={question()} /></dd></div>
        <div><dt>所在小节</dt><dd>{metadata().sectionLabels.join("、") || "未单独标注"}</dd></div>
        <div><dt>能力</dt><dd>{metadata().abilities.join("、") || "未单独标注"}</dd></div>
        <div><dt>核心素养</dt><dd>{metadata().literacies.join("、") || "未单独标注"}</dd></div>
      </dl>
      <Show when={metadata().pedagogyStatus === "pending_review" && (metadata().abilities.length || metadata().literacies.length)}><p class="question-detail-note">能力与素养标注待复核，供检索参考。</p></Show>
    </section>
    <Show when={metadata().solutionPaths.length} fallback={<p class="muted">暂未记录有完整依据的解法依赖。</p>}>
      <details class="question-dependency-details">
        <summary>解法依赖（{metadata().solutionPaths.length}）</summary>
        <For each={metadata().solutionPaths}>{(path: any, index) => <section class="question-path">
          <h4>解法 {index() + 1}</h4>
          <dl class="explanation-list">
            <div><dt>所需知识</dt><dd><RichText text={path.knowledge.join("、") || "未单独标注"} question={question()} /></dd></div>
            <Show when={path.premises.length}><div><dt>工具与前提</dt><dd>{path.premises.join("、")}</dd></div></Show>
            <div><dt>解法依据</dt><dd><RichText text={text(path.basis) || "未记录完整依据"} question={question()} /></dd></div>
          </dl>
        </section>}</For>
      </details>
    </Show>
    <section class="assembly-details-section question-details" aria-label="题目来源信息">
      <h3>来源</h3>
      <dl class="explanation-list">
        <div><dt>题目来源</dt><dd>{source().caption}</dd></div>
        <div><dt>来源定位</dt><dd>{locators() || "题库收录"}</dd></div>
      </dl>
    </section>
    <details class="bank-detail-preview"><summary>查看题目</summary><div class="desktop-bank"><BankQuestionPreview question={question()} manifest={props.config.sourceManifest} /></div></details>
  </Drawer>;
}
