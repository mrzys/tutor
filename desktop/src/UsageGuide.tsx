import { For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup, onMount, untrack } from "solid-js";
import { ArrowLeft, ArrowRight, ArrowUp, BookOpen, Check, CheckCheck, CircleCheck, FileCheck2, FileText, ListChecks, LoaderCircle, Pause, Pencil, Play, RotateCcw, ScanLine, Settings2, Upload } from "lucide-solid";
import "./UsageGuide.css";

type Topic = "assembly" | "import";
type GuideStep = { title: string; teacher: string; system: string; caption: string };
const assemblySteps: GuideStep[] = [
  { title: "确认需求", teacher: "选择范围与用途，写明题量、难度和特别要求，再确认需求。", system: "整理你的要求；题量由你决定，模型建议需要你采纳。", caption: "先说清楚这次要练什么。" },
  { title: "确认题位规划", teacher: "逐题查看题型、考查点与目标难度，调整后确认采用。", system: "为每个题位建议考查任务；此时还没有选定题目。", caption: "先看安排，满意后再开始选题。" },
  { title: "从题库选题", teacher: "检查匹配结果；缺题时决定调整要求或补充题库。", system: "按范围、题型、难度与可用解法，从真实题库匹配。找不到时保留缺题位置，不让模型编题补齐。", caption: "缺题时由你决定调整，不会自动放宽要求。" },
  { title: "调整与预览", teacher: "按题型查看、换题或调整要求，打开整卷预览检查排版。", system: "保存草稿；学生卷与教师卷分别展示。预览不会确认成卷或调用模型。", caption: "草稿可以修改，预览可以反复检查。" },
  { title: "确认成卷与导出", teacher: "核对题目与名称，确认成卷，再生成所需版本的 PDF。", system: "固定本次题目内容。以后继续编辑会创建新草稿，原卷与已有 PDF 保留。", caption: "确认后的试卷保留原样，方便再次使用。" },
];
const importSteps: GuideStep[] = [
  { title: "先完成配置", teacher: "在设置中保存当前模型，以及独立的 PaddleOCR 接口和 API Key。", system: "上传 PDF / DOCX 前检查两项配置。TXT / Markdown 导入只需要模型配置。", caption: "模型负责整理，PaddleOCR 负责识别原卷。" },
  { title: "上传原卷", teacher: "选择 PDF 或 DOCX 原件后，可以继续其它操作，在导入记录查看进展。", system: "保存原件并在后台解析。DOCX 通过本机 Word 或 LibreOffice 转成 PDF；缺少工具时提示先导出 PDF。", caption: "上传后在后台处理，不必停留在本页。" },
  { title: "识别文字与图表", teacher: "打开原文对照，将识别后的文字与原页图像并排核查；失败时查看具体原因和重试建议。", system: "PaddleOCR 读取逐页文字、公式和布局，并保留原页与实际图表素材。", caption: "原文是识别后的内容，原图保留原卷排版。" },
  { title: "整理并检查题目", teacher: "处理完成后直接查看题面、标注与检查意见，无需再启动一次模型初审。", system: "模型在整理题目的同一次响应中给出检查意见与置信档，不再对每题额外请求。难度和主考知识点可按题面估计；缺完整解法依据时依赖保持未知，不补编原卷缺失的答案解析。", caption: "导入时一并检查，完成后直接显示结果。" },
  { title: "按需处理疑点", teacher: "重点处理有疑点的题；需要时打开原文与原图对照。检查失败或修改题目后，可点击“重新检查”。", system: "高置信且通过完整性校验的题可统一确认入库，无需逐题勾选；缺图、选项不完整等问题仍会阻止入库。原卷没有答案解析时保持空白。", caption: "模型置信档不是实测正确率；可以随时返回组卷，稍后继续。" },
  { title: "确认加入题库", teacher: "点击右上角“加入题库”，统一提交符合条件的题目；有疑点的题可留待之后处理。", system: "分别保存模型意见和人工复核依据。旧记录缺少意见时，可按需重新检查；查看历史不会自动调用识别或模型。", caption: "不必处理完整份试卷才能离开或使用已合格的题目。" },
];

function DemoSheet(props: { heading?: string; review?: boolean; final?: boolean; intersection?: boolean }) {
  return <div class="usage-demo-sheet">
    <strong>{props.heading || "集合 · 课后巩固"}</strong>
    <div class="usage-demo-sheet-rule" />
    <Show when={props.intersection} fallback={<><p><span>1.</span> 已知集合 A = {'{1, 2}'}，判断元素与集合的关系。</p>
    <div class="usage-demo-options"><span>A. 1 ∈ A</span><span>B. 3 ∈ A</span></div></>}><p><span>1.</span> 已知 A = {'{1, 3}'}，B = {'{2, 3}'}，求 A ∩ B。</p><div class="usage-demo-options"><span>A. {'{1}'}</span><span>B. {'{3}'}</span><span>C. ∅</span></div></Show>
    <Show when={props.review}><div class="usage-demo-review"><Check size={15} /> 题面与原卷一致 <span>配图已核对</span></div></Show>
    <Show when={props.final}><div class="usage-demo-review"><FileCheck2 size={16} /> 已确认成卷</div></Show>
  </div>;
}

const assemblyDurations = [9000, 7000, 6500, 9500, 6500];
const demoRequirement = "今天讲了集合的交、并、补，出 10 道练习，侧重基础，不要解答题。";

// This is an offline illustration. Its clock only changes local presentation;
// the guide never invokes the Composer, model, question bank or persistence.
function AssemblyDemonstration(props: { step: number; elapsed: number | null; playing: boolean }) {
  const at = () => props.elapsed ?? assemblyDurations[props.step];
  const pressed = (start: number, end = Infinity) => props.elapsed !== null && at() >= start && at() < end;
  const typed = createMemo(() => demoRequirement.slice(0, Math.max(0, Math.floor((at() - 400) / 65))));
  const previewing = () => props.step === 3 && at() >= 5700;
  const selecting = () => props.step === 2 && at() < 4600;
  const matched = () => Math.min(10, Math.max(0, Math.floor(at() / 460)));
  return <div class="usage-assembly-workspace" data-scene={props.step} data-preview={previewing() ? "true" : "false"}>
    <div class="usage-assembly-heading"><span>{["新建组卷", "题位规划", "正在选题", "集合 · 课后巩固", "集合 · 课后巩固"][props.step]}</span><small>模拟演示</small></div>
    <Show when={props.step === 0}>
      <div class="usage-assembly-composer">
        <div class="usage-assembly-toolbar"><span>数学⌄</span><span>考查范围 · 集合</span><span>课后巩固</span></div>
        <div class="usage-assembly-input" aria-label="模拟输入需求"><span class="usage-assembly-subject">数学</span><span data-demo-typed>{typed()}</span><Show when={props.playing && at() < 400 + demoRequirement.length * 65}><i class="usage-assembly-caret" aria-hidden="true" /></Show></div>
        <div class="usage-assembly-input-footer"><small>{at() < 3600 ? "输入本次练习要求" : "保留你输入的要求"}</small><span class="usage-assembly-action" classList={{ pressed: pressed(3600, 4200) }}>开始组卷 <ArrowUp size={13} /></span></div>
      </div>
      <div class="usage-assembly-result-slot">
        <Show when={at() >= 3800 && at() < 5300}><div class="usage-assembly-working"><LoaderCircle size={15} class={props.playing ? "usage-assembly-spinner" : ""} />正在整理需求…</div></Show>
        <Show when={at() >= 5300}><div class="usage-assembly-result"><div><ListChecks size={16} /><strong>请确认本次要求</strong></div><p>集合的交、并、补 · 课后巩固</p><p><strong>10 题</strong>：单选 8 题、填空 2 题 · 基础为主</p><span class="usage-assembly-action" classList={{ pressed: pressed(7800) }}>确认需求 <Check size={13} /></span></div></Show>
      </div>
    </Show>
    <Show when={props.step === 1}>
      <div class="usage-assembly-status"><ListChecks size={15} /><span>{at() < 3300 ? "正在安排每个题位…" : "10 个题位已规划，等待你确认"}</span></div>
      <div class="usage-demo-plan usage-assembly-plan"><strong>题位规划 <span>10 题</span></strong><div><span>题位</span><span>题型与考查任务</span><span>难度</span></div><For each={[
        ["1", "单选 · 元素与集合的关系", "基础"],
        ["2", "单选 · 求两个集合的交集", "基础"],
        ["3", "单选 · 判断补集运算", "基础偏中等"],
        ["9", "填空 · 求集合的并集", "基础"],
      ]}>{(row, index) => <div classList={{ "usage-assembly-row-pending": at() < 500 + index() * 650 }}><b>{row[0]}</b><span>{row[1]}</span><span>{row[2]}</span></div>}</For><small>部分题位示例 · 此时尚未选定题目</small></div>
      <div class="usage-assembly-bottom"><small>{at() < 5200 ? "逐题核对任务、题型与难度" : "采纳后才开始从题库选题"}</small><span class="usage-assembly-action" classList={{ pressed: pressed(5400) }}>确认规划 <Check size={13} /></span></div>
    </Show>
    <Show when={props.step === 2}>
      <div class="usage-assembly-status"><Show when={selecting()} fallback={<Check size={15} />}><LoaderCircle size={15} class={props.playing ? "usage-assembly-spinner" : ""} /></Show><span>{selecting() ? "按已确认的安排匹配真实题库" : "选题完成，可以检查草稿"}</span><strong>{matched()} / 10</strong></div>
      <div class="usage-assembly-progress" role="progressbar" aria-label="模拟选题进度" aria-valuenow={matched()} aria-valuemin={0} aria-valuemax={10}><span style={{ width: `${matched() * 10}%` }} /></div>
      <div class="usage-assembly-matching"><For each={[1, 2, 3, 4]}>{(number) => <div><Show when={matched() >= number} fallback={<span class="usage-assembly-waiting">·</span>}><Check size={15} /></Show><span>题位 {number}</span><span>{matched() >= number ? "已匹配题库题目" : "等待匹配"}</span></div>}</For></div>
      <p class="usage-assembly-note">本次示例匹配 10 题。实际缺题会保留空位并说明原因，由你决定如何调整。</p>
    </Show>
    <Show when={props.step === 3}>
      <div class="usage-assembly-status"><span>{previewing() ? "整卷预览 · 学生卷" : "草稿 · 单选 8 题　填空 2 题"}</span><span class="usage-assembly-action secondary" classList={{ pressed: pressed(4800, 5700) }}><BookOpen size={13} />整卷预览</span></div>
      <Show when={previewing()} fallback={<div class="usage-assembly-draft"><div class="usage-assembly-draft-question"><p>1. <Show when={at() >= 2600} fallback={<>已知 A = {'{1, 2}'}，B = {'{2, 3}'}，求 A ∩ B。</>}>已知 A = {'{1, 3}'}，B = {'{2, 3}'}，求 A ∩ B。</Show></p><div class="usage-demo-options"><span>A. {'{1}'}</span><span>B. <Show when={at() >= 2600} fallback="{2}">{'{3}'}</Show></span><span>C. ∅</span></div><div class="usage-assembly-question-tools"><span classList={{ pressed: pressed(1400, 2600) }}><RotateCcw size={13} />换题</span><span><Pencil size={13} />调整</span></div></div><div class="usage-assembly-change"><Show when={at() >= 2600} fallback="可以换题，也可以调整这一题的要求"><Check size={14} />已替换第 1 题，其余题位保留</Show></div></div>}><div class="usage-assembly-preview"><DemoSheet intersection /><div class="usage-assembly-preview-line">填空题　2 题</div><p>9. 已知 A = {'{1, 2}'}，B = {'{2, 3}'}，则 A ∪ B = ______。</p><small>全部题型连续预览（此处节选）</small></div></Show>
    </Show>
    <Show when={props.step === 4}>
      <Show when={at() < 2900} fallback={<div class="usage-assembly-finished"><CircleCheck size={29} /><strong>已确认成卷</strong><span>集合 · 课后巩固　10 题</span><div class="usage-assembly-pdf"><span class="usage-assembly-action" classList={{ pressed: pressed(4000) }}><FileText size={14} />学生卷 PDF</span><span class="usage-assembly-action secondary"><FileText size={14} />教师卷 PDF</span></div><small>{at() >= 4700 ? "学生卷 PDF 已就绪（演示）" : "按需生成需要的版本"}</small><p>继续编辑会创建新草稿，原卷与已有 PDF 保留。</p></div>}><div class="usage-assembly-confirmation"><FileCheck2 size={23} /><strong>确认成卷</strong><p>集合 · 课后巩固</p><span>10 题 · 单选 8 题、填空 2 题</span><p>确认后保存本次题目内容。</p><span class="usage-assembly-action" classList={{ pressed: pressed(1800) }}>确认成卷 <Check size={13} /></span></div></Show>
    </Show>
  </div>;
}

function Demonstration(props: { topic: Topic; step: number; elapsed: number | null; playing: boolean }) {
  const assembly = () => props.topic === "assembly";
  return <div class="usage-demo-content" data-topic={props.topic} data-step={props.step}>
    <Show when={assembly()} fallback={
      <Show when={props.step === 0} fallback={
        <Show when={props.step === 1} fallback={
          <Show when={props.step === 2} fallback={
            <Show when={props.step === 3} fallback={
              <Show when={props.step === 4} fallback={<div class="usage-demo-publish"><div class="usage-demo-publish-actions"><span>2 题可入库</span><span class="usage-assembly-action"><Check size={13} />加入题库</span></div><CircleCheck size={34} /><strong>确认合格题加入题库</strong><span>疑点题留待处理，原卷与导入记录保留</span></div>}>
                <div class="usage-demo-check-content"><DemoSheet heading="导入检查意见" /><div class="usage-demo-tags"><span>模型自评置信 · 高</span><span>未发现疑点 · 可确认入库</span></div><small>演示意见，不是实测正确率；缺图、内容损坏仍需处理</small></div>
              </Show>
            }>
              <div class="usage-demo-annotations"><DemoSheet heading="整理后的题目" /><div class="usage-demo-tags"><span>难度估计 · 基础</span><span>主考 · 元素与集合</span><span>解法依赖 · 依据不足，未知</span></div><small>本示例原卷没有解析 → 保持空缺</small></div>
            </Show>
          }>
            <div class="usage-demo-recognition"><div class="usage-demo-page"><FileText size={28} /><span>原图 · 第 1 页</span><div class="usage-demo-recognition-box">保留原卷排版</div><div class="usage-demo-diagram"><span>A</span><i>1　2</i></div></div><ArrowRight size={20} /><div class="usage-demo-extracted"><strong>原文 · 识别结果</strong><span><Check size={14} /> 题面与公式</span><span><Check size={14} /> 页码与布局对应</span><span><Check size={14} /> 实际配图素材</span><small>原文、原图并排对照</small></div></div>
          </Show>
        }>
          <div class="usage-demo-upload"><Upload size={30} /><strong>阶段练习原卷.pdf</strong><span>已提交 · 后台处理中</span><small>可继续其它操作，在导入记录查看进展</small></div>
        </Show>
      }>
        <div class="usage-demo-config"><div><Settings2 size={20} /><span><strong>当前模型</strong><small>整理题目与标注</small></span><Check size={18} /></div><div><ScanLine size={20} /><span><strong>PaddleOCR</strong><small>独立接口与密钥</small></span><Check size={18} /></div></div>
      </Show>
    }>
      <AssemblyDemonstration step={props.step} elapsed={props.elapsed} playing={props.playing} />
    </Show>
  </div>;
}

export function UsageGuide(props: { initialTopic?: Topic }) {
  const uid = createUniqueId();
  const [topic, setTopic] = createSignal<Topic>(props.initialTopic || "assembly");
  const [step, setStep] = createSignal(0);
  const [playing, setPlaying] = createSignal(false);
  const [elapsed, setElapsed] = createSignal<number | null>(null);
  const [reducedMotion, setReducedMotion] = createSignal(false);
  const steps = createMemo(() => topic() === "assembly" ? assemblySteps : importSteps);
  const current = createMemo(() => steps()[step()]);
  const demonstration = createMemo(() => ({ topic: topic(), step: step() }));
  const selectStep = (next: number) => { setPlaying(false); setElapsed(null); setStep(Math.max(0, Math.min(next, steps().length - 1))); };
  const selectTopic = (next: Topic) => { setPlaying(false); setElapsed(null); setStep(0); setTopic(next); };
  const tabId = (index: number) => `${uid}-step-${index}`;
  const panelId = `${uid}-panel`;
  const keyStep = (event: KeyboardEvent, index: number) => {
    let next = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % steps().length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index + steps().length - 1) % steps().length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = steps().length - 1;
    else return;
    event.preventDefault(); selectStep(next); document.getElementById(tabId(next))?.focus();
  };
  onMount(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => { setReducedMotion(media.matches); if (media.matches) { setPlaying(false); setElapsed(null); } };
    const visibility = () => { if (document.hidden) setPlaying(false); };
    updateMotion(); media.addEventListener("change", updateMotion); document.addEventListener("visibilitychange", visibility);
    onCleanup(() => { media.removeEventListener("change", updateMotion); document.removeEventListener("visibilitychange", visibility); });
  });
  createEffect(() => {
    if (!playing() || reducedMotion()) return;
    const activeStep = step();
    const duration = topic() === "assembly" ? assemblyDurations[activeStep] : 6000;
    const total = steps().length;
    let progress = untrack(elapsed) ?? 0;
    let last = performance.now();
    const timer = window.setInterval(() => {
      if (document.hidden) { setPlaying(false); return; }
      const now = performance.now();
      progress = Math.min(duration, progress + now - last);
      last = now;
      setElapsed(progress);
      if (progress >= duration) {
        if (activeStep + 1 >= total) { setPlaying(false); setElapsed(null); }
        else { setElapsed(0); setStep(activeStep + 1); }
      }
    }, 50);
    onCleanup(() => window.clearInterval(timer));
  });
  const play = () => {
    if (playing()) setPlaying(false);
    else if (!reducedMotion() && !document.hidden) {
      if (step() === steps().length - 1 && elapsed() === null) { setStep(0); setElapsed(0); }
      else if (elapsed() === null) setElapsed(0);
      setPlaying(true);
      // The bottom controls can be far below the canvas on a narrow screen.
      // Bring the illustration back into view without obscuring the sticky steps.
      document.getElementById(panelId)?.scrollIntoView({ block: "start", behavior: "instant" });
    }
  };
  return <div class="usage-guide">
    <div class="usage-guide-topics" role="tablist" aria-label="使用说明主题">
      <For each={[["assembly", "组卷", BookOpen], ["import", "导入试卷", Upload]] as const}>{([key, label, Icon], index) => <button type="button" role="tab" aria-selected={topic() === key} aria-controls={`${uid}-topic-panel`} id={`${uid}-topic-${key}`} tabindex={topic() === key ? 0 : -1} onClick={() => selectTopic(key)} onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next: Topic = event.key === "Home" ? "assembly" : event.key === "End" ? "import" : index() === 0 ? "import" : "assembly"; selectTopic(next); document.getElementById(`${uid}-topic-${next}`)?.focus(); } }}><Icon size={17} />{label}</button>}</For>
    </div>
    <div id={`${uid}-topic-panel`} role="tabpanel" aria-labelledby={`${uid}-topic-${topic()}`} class="usage-guide-topic-panel">
      <p class="usage-guide-intro">{topic() === "assembly" ? "你确定要求与安排，系统从题库找题；检查满意后再确认成卷。" : "后台识别、整理时一并检查，重点处理疑点；统一确认合格题加入本地题库。"}</p>
      <div class="usage-guide-steps" role="tablist" aria-label={topic() === "assembly" ? "组卷步骤" : "导入步骤"}>
        <For each={steps()}>{(item, index) => <button type="button" id={tabId(index())} role="tab" aria-selected={step() === index()} aria-controls={panelId} tabindex={step() === index() ? 0 : -1} onClick={() => selectStep(index())} onKeyDown={(event) => keyStep(event, index())}><span class="usage-guide-step-number">{index() + 1}</span><span>{item.title}</span></button>}</For>
      </div>
      <div class="usage-guide-stage" id={panelId} role="tabpanel" aria-labelledby={tabId(step())}>
        <div class="usage-guide-demo" aria-label="流程演示示例">
          <span class="usage-guide-demo-label">演示示例 · 非真实试卷</span>
          <div class="usage-guide-canvas"><Show when={demonstration()} keyed>{(state) => <Demonstration topic={state.topic} step={state.step} elapsed={elapsed()} playing={playing()} />}</Show></div>
          <p class="usage-guide-demo-caption">{current().caption}</p>
        </div>
        <div class="usage-guide-explanation" aria-live={playing() ? "off" : "polite"} aria-atomic="true">
          <span class="usage-guide-position">第 {step() + 1} / {steps().length} 步</span>
          <h3>{current().title}</h3>
          <dl><div><dt><Pencil size={15} />你来决定</dt><dd>{current().teacher}</dd></div><div><dt><CheckCheck size={16} />系统完成</dt><dd>{current().system}</dd></div></dl>
        </div>
      </div>
      <div class="usage-guide-controls">
        <div class="usage-guide-playback"><button type="button" onClick={play} disabled={reducedMotion()} title={reducedMotion() ? "已启用减少动态效果，请使用上一步与下一步" : undefined}>{playing() ? <Pause size={16} /> : step() === steps().length - 1 && elapsed() === null ? <RotateCcw size={16} /> : <Play size={16} />}{playing() ? "暂停" : step() === steps().length - 1 && elapsed() === null ? "重新播放" : "播放演示"}</button><span>{reducedMotion() ? "已减少动态效果，可逐步查看" : playing() ? topic() === "assembly" ? "正在演示输入、确认与组卷" : "每步停留 6 秒" : elapsed() !== null ? "已暂停，再次播放可继续" : "点击步骤，或播放完整操作"}</span></div>
        <div class="usage-guide-navigation"><button type="button" onClick={() => selectStep(step() - 1)} disabled={step() === 0} aria-label="上一步"><ArrowLeft size={16} /><span>上一步</span></button><button type="button" onClick={() => selectStep(step() + 1)} disabled={step() === steps().length - 1} aria-label="下一步"><span>下一步</span><ArrowRight size={16} /></button></div>
      </div>
      <div class="usage-guide-extra">
        <Show when={topic() === "assembly"} fallback={<p><strong>文件与数据</strong>　原件、导入记录与题库保存在本机；识别时文件会发送给你配置的 PaddleOCR，整理材料会发送给当前模型服务。并非全程离线处理。</p>}>
          <details><summary>也可以手动选题</summary><p>到题库浏览题目，加入组卷篮，确认题目、顺序与基本设置后创建草稿。这个过程不调用模型；创建后仍可预览、调整并确认成卷。</p></details>
        </Show>
      </div>
    </div>
  </div>;
}
