import { For, Show, createMemo, type JSX } from "solid-js";
import { QuestionBody, RichText } from "./Paper";
import { TeachingEditableField } from "./TeachingEditableField";
import { ImportEditableSourceField } from "./ImportEditableSourceField";
import { ReviewMarkedText } from "./ReviewMarkedText";
import { importAssessmentPresentation, importTeachingPresentation, type TeachingReviewControls } from "./import-review";
import { reviewFieldLabel } from "./import-review-presentation";
import { difficultyLevels } from "./assembly-details";
import { compactTeachingText, teachingDisplayText } from "./teaching-text";
import type { TriageIssue } from "./import-triage";
import { ImportReadingTabs, type ImportReadingTab } from "./ImportReadingTabs";

/** Reading only. The parent owns the session, exact versions, and both kinds
 * of editor; switching tabs never starts model work or saves anything. */
export function ImportQuestionReading(props: {
  question: any; presentation: any; controls?: TeachingReviewControls; issues: readonly TriageIssue[];
  tab: ImportReadingTab; onTabChange: (tab: ImportReadingTab) => void;
  sourceCanEdit: (path: string) => boolean; teachingCanEdit: (path: string) => boolean;
  onEditSource: (path: string) => void; onEditTeaching: (path: string) => void;
  onSelectIssue: (id: string) => void;
  knowledgeNames: (ids: string[] | undefined) => string; premiseNames: (ids: string[]) => string;
}) {
  const draft = createMemo(() => importTeachingPresentation(props.question, props.controls));
  const assessment = createMemo(() => importAssessmentPresentation(props.question, props.controls));
  const issuesFor = (path: string) => props.issues.filter(issue => issue.domain === "teaching" && issue.target?.fieldPath === path);
  const marked = (path: string, value: string) => <ReviewMarkedText text={value} fieldPath={path}
    issues={props.issues} binding={props.controls} compact projectText={text => compactTeachingText(teachingDisplayText(text))}
    question={props.presentation} onSelectIssue={props.onSelectIssue} />;
  const editable = (path: string, label: string, children: JSX.Element) => <TeachingEditableField
    path={path} label={label} editable={props.teachingCanEdit(path)} issues={issuesFor(path)} onEdit={props.onEditTeaching}>{children}</TeachingEditableField>;
  const sourceField = (path: string, children: JSX.Element) => <ImportEditableSourceField path={path}
    label={reviewFieldLabel(path, "source")} editable={props.sourceCanEdit(path)} issues={props.issues} onEdit={props.onEditSource}>{children}</ImportEditableSourceField>;
  const primaryIds = () => props.question.primaryKnowledgeUids || props.question.knowledgeUids || [];
  return <article class="import-preview import-question-reading">
    <section class="import-source-reading" aria-label="原卷题目与参考">
      <QuestionBody question={props.presentation} hideMissingTeacherMaterials number={props.question.sourceLabel}
        teacher hideSource reviewFieldPrefix="source:" renderReviewField={sourceField} />
    </section>
    <ImportReadingTabs questionKey={props.question.questionId} value={props.tab} onChange={props.onTabChange}
      statuses={{ solution: draft() ? draft()!.ready ? "AI生成" : "待核对" : "未生成", assessment: assessment().needsSupplement ? "待补全" : "" }}
      solution={
    <Show when={draft()} fallback={<p class="muted">本题尚无AI教学稿，原卷实际答案与解析保留在“原题”中。</p>}>{value => <section class="import-reading-section" data-reading-section="solution">
      <div class="import-reading-section-content" aria-label="AI答案与解析">
        <Show when={value().answer}>{editable("answer", "AI答案", <p><strong>答案：</strong>{marked("answer", value().answer)}</p>)}</Show>
        <Show when={value().solution}>{editable("teachingSolution", "AI解析", marked("teachingSolution", value().solution))}</Show>
      </div>
    </section>}</Show>
      } assessment={
    <section class="import-reading-section" data-reading-section="assessment">
      <div class="import-reading-section-content" aria-label="考查信息">
        <Show when={assessment()}>{value => <>
          <dl class="import-reading-facts">
            <div><dt>主考知识点</dt><dd>{props.knowledgeNames(primaryIds())}<Show when={!primaryIds().length}><small>待补全</small></Show></dd></div>
            <div><dt>难度</dt><dd>
              <Show when={value().level} fallback={<>未评估<small>待补全</small></>}>{level => <>{difficultyLevels.find(item => item.id === level())?.label || level()}<small>{value().difficultyOrigin}</small></>}</Show>
              <Show when={value().candidateLevel}>{level => <small class="import-candidate-difficulty">AI候选：{difficultyLevels.find(item => item.id === level())?.label} · 待核对</small>}</Show>
            </dd></div>
            <div><dt>考查点</dt><dd><Show when={value().examFocus} fallback={<>未标注<small>待补全</small></>}>
              <Show when={draft()?.ready && props.question.knowledgeMappingSource !== "teacher_edit" && props.teachingCanEdit("teachingFocus.examFocus")}
                fallback={<RichText text={teachingDisplayText(value().examFocus)} question={props.presentation} teacher />}>
                {editable("teachingFocus.examFocus", "AI考查点", marked("teachingFocus.examFocus", draft()?.examFocus || value().examFocus))}
              </Show>
            </Show></dd></div>
          </dl>
          <Show when={draft()}>{candidate => <div class="import-candidate-assessment">
            <Show when={(!candidate().ready || value().difficultyOrigin !== "AI内容估计") && (candidate().basis || props.teachingCanEdit("difficultyAssessment.basis"))}>
              {editable("difficultyAssessment.basis", "候选难度依据", <><h4>{candidate().ready ? "AI难度依据" : "候选难度依据 · 待核对"}</h4>{marked("difficultyAssessment.basis", candidate().basis || "尚未填写难度依据")}</>)}
            </Show>
            <Show when={(!candidate().ready || props.question.knowledgeMappingSource === "teacher_edit") && candidate().examFocus}>
              {editable("teachingFocus.examFocus", "AI考查点", <><h4>{candidate().ready ? "AI考查点" : "候选考点 · 待核对"}</h4>{marked("teachingFocus.examFocus", candidate().examFocus)}</>)}
            </Show>
            <Show when={candidate().studentRequirements.length}><h4>对学生的要求</h4><ul><For each={candidate().studentRequirements}>{(item, index) =>
              <li>{editable(`teachingFocus.studentRequirements[${index()}]`, `对学生的要求第${index()+1}条`, marked(`teachingFocus.studentRequirements[${index()}]`, item))}</li>
            }</For></ul></Show>
          </div>}</Show>
          <Show when={value().basis}><section class="import-assessment-detail"><h4>难度依据</h4>
            <Show when={value().difficultyOrigin === "AI内容估计"} fallback={<RichText text={teachingDisplayText(value().basis)} question={props.presentation} teacher />}>
              {editable("difficultyAssessment.basis", "AI难度依据", marked("difficultyAssessment.basis", value().basis))}
            </Show>
          </section></Show>
          <Show when={value().paths.length}><section class="import-assessment-detail"><h4>解法所需知识</h4><For each={value().paths}>{(path, index) =>
            <section class="import-path-reading"><h5>解法 {index()+1}</h5><p>{props.knowledgeNames(path.requiredKnowledgeUids)}</p>
              <Show when={path.requiredPremises?.length}><p>额外工具或条件：{props.premiseNames(path.requiredPremises)}</p></Show>
              <RichText text={teachingDisplayText(path.basis || "本条解法依据待补充。")} question={props.presentation} teacher />
            </section>
          }</For></section></Show>
          <Show when={value().needsSupplement}><p class="muted">正式考查信息尚未补全，可通过页头的“考查信息”入口补充缺失项。原题核对和手动选题可继续进行。</p></Show>
        </>}</Show>
      </div>
    </section>
      } />
  </article>;
}
