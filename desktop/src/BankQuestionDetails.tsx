import { For, Show, createMemo } from "solid-js";
import { Drawer } from "./ui";
import { typeLabels } from "./bridge";
import { RichText } from "./Paper";
import { TeachingAnalysis } from "./TeachingAnalysis";
import { teachingDisplayText } from "./teaching-text";
import { teachingFindingMessage } from "./teaching-finding-display";
import { teachingAnalysisPresentation, teachingFocusPresentation } from "./shared/teaching-analysis.mjs";
import { difficultyLevels } from "./assembly-details";
import { BankQuestionPreview, bankMetadata } from "./BankQuestionCard";
import { questionSourcePresentation } from "./shared/source-label.mjs";
import { ReferenceAvailability } from "./ReferenceAvailability";
import { teacherReferenceEntries } from "./teacher-reference";

export function BankQuestionDetails(props: { row: any; config: any; onClose: () => void }) {
  const question = () => props.row.question || props.row;
  const metadata = createMemo(() => bankMetadata(props.row));
  const focus = createMemo(() => teachingFocusPresentation(question(), true, metadata().topics));
  const pendingTeaching = createMemo(() => question().importTeachingReview?.status === "needs_review"
    ? question().importTeachingReview : null);
  const pendingTeachingReasons = createMemo(() => [...new Set<string>((pendingTeaching()?.findings || [])
    .map(teachingFindingMessage)
    .filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0))]);
  const knowledge = () => metadata().topics.length ? metadata().topics : focus()?.knowledgePoints || [];
  const task = () => focus()?.examFocus.trim() || metadata().taskLabels.join("；") || metadata().taskSummary;
  const level = createMemo(() => difficultyLevels.find(level => level.id === metadata().difficulty.level));
  const text = (value: any) => typeof value === "string" ? value : typeof value?.rationale === "string" ? value.rationale : "";
  const basis = () => teachingDisplayText(text(metadata().difficulty.basis));
  const source = () => questionSourcePresentation(question(), props.config.sourceManifest);
  const locators = () => metadata().sourceRefs.filter((ref: any) => !/^tutor-set(?:-|$)/i.test(ref.locator || ""))
    .map((ref: any) => `${ref.locator || "题库收录"}${ref.pages?.length ? `（${ref.pages.join("、")} 页）` : ""}`).join("；");
  return <Drawer title="题目详情" onClose={props.onClose}>
    <ReferenceAvailability question={question()} teacher />
    <section class="bank-detail-preview desktop-bank" aria-label="题目内容"><BankQuestionPreview question={question()} manifest={props.config.sourceManifest} /></section>
    <section class="assembly-details-section question-details" aria-label="题目考查信息">
      <dl class="explanation-list">
        <div><dt>题型</dt><dd>{typeLabels[question().questionType] || "未记录"}</dd></div>
        <div><dt>题目难度</dt><dd><span class="bank-question-difficulty" data-difficulty={level()?.id || "unknown"}>{level()?.label || "未评估"}</span><Show when={level()}><small class="question-detail-note">内容估计，未经学生作答标定</small></Show></dd></div>
        <Show when={level() && basis()}><div><dt>难度依据</dt><dd><RichText text={basis()} question={question()} /></dd></div></Show>
        <div><dt>{metadata().topics.length || !knowledge().length ? metadata().knowledgeLabel : "考查知识（AI）"}</dt><dd><RichText text={knowledge().join("、") || "未标注"} question={question()} /></dd></div>
        <Show when={task() && task() !== "未单独标注"}><div><dt>考查任务</dt><dd><RichText text={task()} question={question()} teacher /></dd></div></Show>
        <Show when={focus()?.studentRequirements.length}><div><dt>对学生的要求</dt><dd><ul class="bank-detail-requirements"><For each={focus()!.studentRequirements}>{requirement => <li><RichText text={requirement} question={question()} teacher /></li>}</For></ul></dd></div></Show>
      </dl>
      <Show when={focus()?.needsReview}><p class="warning-text" role="status">AI 教学说明待复核。</p></Show>
      <Show when={pendingTeaching()}>
        <p class="warning-text" role="status">课堂教学稿待复核，未采用；原题已单独核对入库。</p>
        <Show when={pendingTeachingReasons().length}>
          <details class="question-dependency-details"><summary>待复核原因</summary>
            <ul><For each={pendingTeachingReasons()}>{reason => <li>{reason}</li>}</For></ul>
          </details>
        </Show>
      </Show>
    </section>
    <Show when={teacherReferenceEntries(question(), "answers").length}>
      <section class="assembly-details-section bank-reference-answers" aria-label="参考答案">
        <h3>参考答案</h3>
        <For each={teacherReferenceEntries(question(), "answers")}>{(entry: any) => <p><RichText text={entry.text} question={question()} teacher /></p>}</For>
      </section>
    </Show>
    <TeachingAnalysis question={question()} teacher renderText={value => <RichText text={value} question={question()} teacher />} />
    <Show when={teacherReferenceEntries(question(), "solutions").length}>
      <details class="question-dependency-details">
        <summary>{teachingAnalysisPresentation(question(), true) ? "原有解析" : "解析"}</summary>
        <For each={teacherReferenceEntries(question(), "solutions")}>{(entry: any) => <RichText text={entry.text} question={question()} teacher />}</For>
      </details>
    </Show>
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
    <details class="question-dependency-details">
      <summary>更多信息</summary>
      <dl class="explanation-list">
        <Show when={metadata().sectionLabels.length}><div><dt>所在小节</dt><dd>{metadata().sectionLabels.join("、")}</dd></div></Show>
        <Show when={metadata().abilities.length}><div><dt>能力</dt><dd>{metadata().abilities.join("、")}</dd></div></Show>
        <Show when={metadata().literacies.length}><div><dt>核心素养</dt><dd>{metadata().literacies.join("、")}</dd></div></Show>
        <div><dt>题目来源</dt><dd>{source().caption}</dd></div>
        <div><dt>来源定位</dt><dd>{locators() || "题库收录"}</dd></div>
        <Show when={focus()}>{item => <div><dt>教学说明来源</dt><dd>{item().originLabel}<Show when={item().model}> · {item().model}</Show></dd></div>}</Show>
      </dl>
      <Show when={metadata().pedagogyStatus === "pending_review" && (metadata().abilities.length || metadata().literacies.length)}><p class="question-detail-note">能力与素养标注待复核，供检索参考。</p></Show>
    </details>
  </Drawer>;
}
