import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Check, Pause, Play, RefreshCw } from "lucide-solid";
import { operationId, request } from "./bridge";
import { Busy, ErrorBanner, Modal } from "./ui";
import { difficultyLevels } from "./assembly-details";
import "./BankAnnotation.css";

export function BankAnnotation(props: { onClose: () => void; onChanged: () => void | Promise<void>; onConfigure: () => void }) {
  const [books, setBooks] = createSignal<any[]>([]);
  const [textbook, setTextbook] = createSignal("");
  const [mode, setMode] = createSignal("full");
  const [model, setModel] = createSignal<any>(null);
  const [jobs, setJobs] = createSignal<any[]>([]);
  const [job, setJob] = createSignal<any>(null);
  const [preview, setPreview] = createSignal<any>(null);
  const [loading, setLoading] = createSignal(true);
  const [working, setWorking] = createSignal(false);
  const [running, setRunning] = createSignal(false);
  const [pausing, setPausing] = createSignal(false);
  const [error, setError] = createSignal("");
  let alive = true, stopped = false;
  let startAttempt: { key: string; id: string } | undefined;
  onCleanup(() => { alive = false; stopped = true; });
  const busy = () => working() || running();
  const status = (value: string) => ({running:"待继续",cancelled:"已暂停",completed:"已完成",completed_with_errors:"部分失败"}[value] || value);
  async function load() {
    setLoading(true); setError("");
    try {
      const [catalog, settings, history] = await Promise.all([request("bank_catalog"), request("model_get"), request("bank_annotation_list")]);
      if (!alive) return;
      setBooks(catalog.textbooks || []); setTextbook(current => current || catalog.textbooks?.[0]?.id || ""); setModel(settings); setJobs(history.jobs || []);
    } catch (failure: any) { if (alive) setError(failure.message); }
    finally { if (alive) setLoading(false); }
  }
  onMount(load);
  async function inspect() {
    setWorking(true); setError("");
    try { setPreview(await request("bank_annotation_start", {textbookId:textbook(), mode:mode(), dryRun:true})); }
    catch (failure: any) { setError(failure.message); }
    finally { setWorking(false); }
  }
  async function openJob(id: string) {
    setWorking(true); setError("");
    try { setJob((await request("bank_annotation_get", {jobId:id})).job); }
    catch (failure: any) { setError(failure.message); }
    finally { setWorking(false); }
  }
  async function run(current: any) {
    setRunning(true); setPausing(false); stopped = false;
    try {
      while (alive && !stopped && current.pending > 0 && current.status !== "cancelled") {
        current = (await request("bank_annotation_step", {jobId:current.jobId})).job;
        if (alive) setJob(current);
      }
      if (stopped && current.status !== "completed") {
        current = (await request("bank_annotation_cancel", {jobId:current.jobId})).job;
        if (alive) setJob(current);
      }
    } catch (failure: any) { if (alive) setError(failure.message); }
    finally {
      if (alive) {
        setRunning(false); setPausing(false);
        try { setJobs((await request("bank_annotation_list")).jobs || []); await props.onChanged(); }
        catch (failure: any) { setError(failure.message); }
      }
    }
  }
  async function start() {
    setWorking(true); setError("");
    try {
      const key = `${textbook()}:${mode()}`;
      if (startAttempt?.key !== key) startAttempt = {key,id:operationId()};
      const result = await request("bank_annotation_start", {textbookId:textbook(),mode:mode(),operationId:startAttempt.id});
      setJob(result.job); setPreview(null); startAttempt = undefined; setWorking(false);
      await run(result.job);
    } catch (failure: any) { setError(failure.message); }
    finally { setWorking(false); }
  }
  async function resume() {
    setWorking(true); setError("");
    try {
      const result = await request("bank_annotation_resume", {jobId:job().jobId});
      setJob(result.job); setWorking(false); await run(result.job);
    } catch (failure: any) { setError(failure.message); }
    finally { setWorking(false); }
  }
  const failures = () => (job()?.items || []).filter((item: any) => item.status === "failed");
  const latest = () => [...(job()?.items || [])].reverse().find((item: any) => item.status === "succeeded");
  return <Modal title="重新标注题库" stable wide busy={busy()} onClose={props.onClose} footer={<>
    <Show when={running()} fallback={<Show when={job() && job().status !== "completed"}><button class="primary" disabled={working()} onClick={resume}><Play size={16} />{job().failed ? "继续并重试失败题" : "继续任务"}</button></Show>}>
      <button class="secondary" disabled={pausing()} onClick={() => {stopped=true;setPausing(true);}}><Pause size={16} />{pausing()?"当前题完成后暂停…":"暂停"}</button>
    </Show>
    <Show when={!job()}><button class="primary" disabled={busy() || !preview()?.total || !model()?.configured} onClick={start}><RefreshCw size={16} />开始重新标注</button></Show>
  </>}>
    <ErrorBanner message={error()} />
    <Show when={!loading()} fallback={<Busy label="读取题库任务…" />}>
      <p class="muted">按五档标准重评难度，并可同时更新主考知识点和逐解法依赖。成功结果用于后续组卷；已有草稿、成卷和题面保留。模型标注不代表数学正确性已经复核。</p>
      <Show when={!model()?.configured}><p class="warning-text">请先配置当前使用的模型。</p><button class="secondary" onClick={props.onConfigure}>设置模型</button></Show>
      <Show when={!job()} fallback={<section class="bank-annotation-progress" aria-label="标注任务进度">
        <div class="bank-annotation-status"><strong>{running()?"正在重新标注":status(job().status)}</strong><span>{job().completed} / {job().total} 题</span></div>
        <progress value={job().completed + job().failed} max={job().total} aria-label="已处理题目" />
        <p role="status">成功 {job().completed} · 失败 {job().failed} · 待处理 {job().pending}</p>
        <p class="muted">暂停后可以继续；失败题保留原标注，重试不重复处理成功题。{job().modelIdentity?.model ? `使用：${job().modelIdentity.model}` : ""}</p>
        <Show when={latest()}>{item => <p><Check size={15} /> 已完成示例：{difficultyLevels.find(level=>level.id===item().difficultyAssessment?.level)?.label || "未评估"}<small class="bank-annotation-basis">{item().difficultyAssessment?.basis}</small></p>}</Show>
        <Show when={failures().length}><details open><summary>失败题目（{failures().length}）</summary><For each={failures()}>{(item:any)=><p class="warning-text">{item.questionId}：{item.error?.message || "本次标注未完成，原标注保留。"}</p>}</For></details></Show>
        <Show when={!busy()}><button class="secondary" onClick={()=>{setJob(null);setPreview(null);}}>新建重标任务</button></Show>
      </section>}>
        <div class="bank-annotation-fields"><label class="field-label">教材<select aria-label="重标教材" disabled={busy()} value={textbook()} onChange={e=>{setTextbook(e.currentTarget.value);setPreview(null);}}><For each={books()}>{book=><option value={book.id}>{book.title}</option>}</For></select></label>
          <label class="field-label">标注内容<select aria-label="重标内容" disabled={busy()} value={mode()} onChange={e=>{setMode(e.currentTarget.value);setPreview(null);}}><option value="full">难度、主考知识点与逐解法依赖</option><option value="difficulty_only">仅难度与评估依据</option></select></label></div>
        <button class="secondary" disabled={busy() || !textbook() || !model()?.configured} onClick={inspect}>查看处理范围</button>
        <Show when={preview()}><p role="status">将处理 {preview().total} 道当前可用题。范围按现有主考归属确定，不包含待审核题；查看范围不会调用模型。</p></Show>
      </Show>
      <Show when={jobs().length && !running()}><details class="bank-annotation-history"><summary>已有任务（{jobs().length}）</summary><For each={jobs()}>{item=><button disabled={busy()} onClick={()=>openJob(item.jobId)}><span>{item.mode==="full"?"完整重标":"难度重评"} · {item.total} 题</span><small>{status(item.status)} · 成功 {item.completed} · 失败 {item.failed}</small></button>}</For></details></Show>
    </Show>
  </Modal>;
}
