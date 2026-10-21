import { For, Show, createMemo } from "solid-js";
import { Drawer } from "./ui";
import { typeLabels } from "./bridge";
import { RichText } from "./Paper";
import { questionInformation, slotDifficulty } from "./assembly-details";
import { questionSourcePresentation } from "./shared/source-label.mjs";

export function QuestionDetails(props: { slot: any; draft: any; onClose: () => void }) {
  const information = createMemo(() => questionInformation(props.slot, props.draft));
  const difficulty = createMemo(() => slotDifficulty(props.slot, props.draft?.baseline?.requirements, props.draft?.baseline?.questionIndexSnapshot));
  const source = createMemo(() => props.slot.question ? questionSourcePresentation(props.slot.question, props.draft?.baseline?.sourceManifest).caption.replace(/^来源[：:]\s*/, "") : "");
  const task = () => props.slot.taskLabel || props.draft?.baseline?.taskCatalogSnapshot?.tasks?.find((task: any) => task.id === props.slot.taskId)?.label || "未指定";
  return <Drawer title={`第 ${props.slot.number} 题详情`} onClose={props.onClose}>
    <Show when={props.slot.question} fallback={<p class="warning-text">尚未选题，可先查看本题位的要求。</p>}>
      <section class="assembly-details-section question-details" aria-label="题目信息">
        <h3>题目信息</h3>
        <dl class="explanation-list">
          <div><dt>题型</dt><dd>{typeLabels[props.slot.question?.questionType] || "未记录"}</dd></div>
          <div><dt>题目难度</dt><dd>{difficulty().estimate}<Show when={difficulty().estimate !== "未评估"}><small class="question-detail-note">内容估计，未经学生作答标定</small></Show></dd></div>
          <Show when={difficulty().basis}><div><dt>难度依据</dt><dd><RichText text={difficulty().basis} /></dd></div></Show>
          <div><dt>考查点</dt><dd><RichText text={information().tasks.join("；") || "未单独标注"} /></dd></div>
          <div><dt>{information().knowledgeLabel}</dt><dd><RichText text={information().knowledge.join("、") || "未单独标注"} /></dd></div>
          <div><dt>所在小节</dt><dd>{information().sections.join("、") || "未单独标注"}</dd></div>
          <div><dt>来源</dt><dd>{source()}</dd></div>
        </dl>
      </section>
      <Show when={information().paths.length} fallback={<p class="muted">暂未记录有完整依据的解法依赖。</p>}>
        <details class="question-dependency-details">
          <summary>解法依赖（{information().paths.length}）</summary>
          <For each={information().paths}>{path => <section class="question-path">
            <h4>{path.label}</h4>
            <dl class="explanation-list">
              <div><dt>{path.knowledgeLabel}</dt><dd>{path.knowledge.join("、") || "未单独标注"}</dd></div>
              <Show when={path.premises.length}><div><dt>工具与前提</dt><dd>{path.premises.join("、")}</dd></div></Show>
              <Show when={path.basis}><div><dt>解法依据</dt><dd><RichText text={path.basis} /></dd></div></Show>
            </dl>
          </section>}</For>
        </details>
      </Show>
    </Show>
    <section class="assembly-details-section question-details" aria-label="题位要求">
      <h3>题位要求</h3>
      <dl class="explanation-list">
        <div><dt>考查点</dt><dd><RichText text={task()} /></dd></div>
        <div><dt>难度要求</dt><dd>{difficulty().targetLabel || "未指定"}</dd></div>
      </dl>
    </section>
  </Drawer>;
}
