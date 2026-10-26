import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  lazy,
  onCleanup,
} from "solid-js";
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  FileText,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Upload,
  UserRound,
  X,
} from "lucide-solid";
import { operationId, request } from "./bridge";
import { Busy, ErrorBanner, Modal } from "./ui";
import { PaperSheet, RichText } from "./Paper";
import { DateField } from "./DateField";
import "./StudentWork.css";
const PdfPreview = lazy(() =>
  import("./PdfPreview").then((module) => ({ default: module.PdfPreview })),
);

const stages: Record<string, string> = {
  saved: "已保存",
  queued: "等待批改",
  running: "批改中",
  completed: "已完成",
  failed: "批改失败",
  cancelled: "已停止",
  interrupted: "上次批改中断",
};
const judgements: Record<string, string> = {
  correct: "正确",
  incorrect: "错误",
  partial: "部分正确",
  unanswered: "未作答",
  unable: "暂无法判断",
};
const grades = [
  {
    label: "小学",
    values: ["一年级", "二年级", "三年级", "四年级", "五年级", "六年级"],
  },
  { label: "初中", values: ["初一", "初二", "初三"] },
  { label: "高中", values: ["高一", "高二", "高三"] },
];
const running = (value: any) => ["queued", "running"].includes(value?.status);
const textError = (value: any) =>
  typeof value === "string" ? value : value?.message || "";
const stamp = (value: string) =>
  value
    ? new Date(value).toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
function FileList(props: {
  files: File[];
  onRemove: (index: number) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  disabled: boolean;
  onPreview: (file: File) => void;
}) {
  function move(event: MouseEvent, index: number, direction: -1 | 1) {
    if (props.disabled) return;
    const button = event.currentTarget as HTMLButtonElement;
    props.onMove(index, direction);
    queueMicrotask(() => {
      if (!button.isConnected) return;
      if (!button.disabled) button.focus();
      else
        button.parentElement?.querySelector<HTMLButtonElement>("button[data-file-move]:not(:disabled)")?.focus();
    });
  }
  return (
    <ul class="student-file-list">
      <For each={props.files}>
        {(file, index) => (
          <li>
            <FileText size={15} />
            <button
              type="button"
              class="text-button student-file-name"
              onClick={() => props.onPreview(file)}
            >
              {file.name}
            </button>
            <small>{Math.max(1, Math.round(file.size / 1024))} KB</small>
            <div class="student-file-actions">
              <button
                type="button"
                class="icon-button"
                data-file-move="previous"
                disabled={props.disabled || index() === 0}
                aria-label={`前移 ${file.name}`}
                title="前移文件"
                onClick={(event) => move(event, index(), -1)}
              ><ArrowUp size={16} /></button>
              <button
                type="button"
                class="icon-button"
                data-file-move="next"
                disabled={props.disabled || index() === props.files.length - 1}
                aria-label={`后移 ${file.name}`}
                title="后移文件"
                onClick={(event) => move(event, index(), 1)}
              ><ArrowDown size={16} /></button>
              <button
                type="button"
                class="icon-button"
                disabled={props.disabled}
                aria-label={`移除 ${file.name}`}
                title="移除文件"
                onClick={() => props.onRemove(index())}
              >
                <X size={16} />
              </button>
            </div>
          </li>
        )}
      </For>
    </ul>
  );
}

async function readOriginal(workId: string, file: any) {
  if (file instanceof File) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = Array.from(new Uint8Array(digest), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
    let binary = "";
    for (let start = 0; start < bytes.length; start += 32768)
      binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
    const mimeType = /\.pdf$/i.test(file.name)
      ? "application/pdf"
      : /\.png$/i.test(file.name)
        ? "image/png"
        : "image/jpeg";
    return {
      filename: file.name,
      mimeType,
      contentBase64: btoa(binary),
      dataBase64: btoa(binary),
      sha256,
      bytes,
    };
  }
  const response = await request("student_work_file_read", {
    workId,
    fileId: file.fileId,
  });
  if (
    !response.contentBase64 ||
    !["application/pdf", "image/png", "image/jpeg"].includes(response.mimeType)
  )
    throw new Error("原件类型不受支持或无法读取。");
  if (file.sha256 && response.sha256 !== file.sha256)
    throw new Error("原件版本与记录不一致，请重新读取。");
  const bytes = Uint8Array.from(atob(response.contentBase64), (character) =>
    character.charCodeAt(0),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha = Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  if (sha !== response.sha256)
    throw new Error("原件内容校验失败，未显示文件。");
  return { ...response, dataBase64: response.contentBase64, bytes };
}
function Original(props: { workId: string; file: any }) {
  const [src, setSrc] = createSignal("");
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  const pdf = () =>
    props.file.mimeType === "application/pdf" ||
    /\.pdf$/i.test(props.file.filename || props.file.name || "");
  createEffect(() => {
    const workId = props.workId,
      file = props.file;
    let active = true;
    setSrc("");
    setError("");
    setLoading(true);
    if (!pdf())
      readOriginal(workId, file)
        .then((response) => {
          if (
            response.mimeType !== "image/png" &&
            response.mimeType !== "image/jpeg"
          )
            throw new Error("此文件不是可显示的图片。");
          if (active)
            setSrc(
              `data:${response.mimeType};base64,${response.contentBase64}`,
            );
        })
        .catch((failure) => {
          if (active) setError(failure.message);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    onCleanup(() => {
      active = false;
    });
  });
  const reader = () => readOriginal(props.workId, props.file);
  return (
    <Show
      when={pdf()}
      fallback={
        <>
          <Show when={loading()}>
            <Busy label="读取原件…" />
          </Show>
          <ErrorBanner message={error()} />
          <Show when={src()}>
            <img
              class="student-original-image"
              src={src()}
              alt={props.file.filename || "答卷原件"}
              onError={() => setError("图片无法显示，请检查文件是否损坏。")}
            />
          </Show>
        </>
      }
    >
      <PdfPreview reader={reader} />
    </Show>
  );
}

export function StudentWork(props: {
  active: boolean;
  onConfigure: () => void;
  onJobs: (count: number) => void;
}) {
  const [students, setStudents] = createSignal<any[]>([]);
  const [query, setQuery] = createSignal("");
  const [studentId, setStudentId] = createSignal("");
  const [works, setWorks] = createSignal<any[]>([]);
  const [work, replaceWork] = createSignal<any>(null);
  function setWork(value: any) {
    const old = work();
    if (!value || !old || old.workId !== value.workId) {
      replaceWork(value);
      return;
    }
    if (Number(value.revision) < Number(old.revision)) return;
    if (JSON.stringify(old) === JSON.stringify(value)) return;
    replaceWork({
      ...value,
      aiResult:
        JSON.stringify(old.aiResult) === JSON.stringify(value.aiResult)
          ? old.aiResult
          : value.aiResult,
    });
  }
  function retainRows(values: any[], previous: any[], field: string) {
    return values.map((value) => {
      const old = previous.find((item) => item[field] === value[field]);
      return old && JSON.stringify(old) === JSON.stringify(value) ? old : value;
    });
  }
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal("");
  const [editing, setEditing] = createSignal<any>(null);
  const [name, setName] = createSignal("");
  const [grade, setGrade] = createSignal("");
  const [notes, setNotes] = createSignal("");
  const [studentBusy, setStudentBusy] = createSignal(false);
  const [studentError, setStudentError] = createSignal("");
  const [upload, setUpload] = createSignal(false);
  const [uploadStudent, setUploadStudent] = createSignal("");
  const [title, setTitle] = createSignal("");
  const [completedOn, setCompletedOn] = createSignal("");
  const [workNotes, setWorkNotes] = createSignal("");
  const [sourceKind, setSourceKind] = createSignal("paper");
  const [paperId, setPaperId] = createSignal("");
  const [papers, setPapers] = createSignal<any[]>([]);
  const [sources, setSources] = createSignal<File[]>([]);
  const [answers, setAnswers] = createSignal<File[]>([]);
  const [saving, setSaving] = createSignal(false);
  const [uploadError, setUploadError] = createSignal("");
  const [frozenUpload, setFrozenUpload] = createSignal(false);
  const [actionBusy, setActionBusy] = createSignal("");
  const [override, setOverride] = createSignal<any>(null);
  const [judgement, setJudgement] = createSignal("unable");
  const [comment, setComment] = createSignal("");
  const [earned, setEarned] = createSignal("");
  const [overrideError, setOverrideError] = createSignal("");
  const [overrideBusy, setOverrideBusy] = createSignal(false);
  const [viewer, setViewer] = createSignal<any>(null);
  const [paperPreview, setPaperPreview] = createSignal<any>(null);
  const [notice, setNotice] = createSignal("");
  const currentStudent = createMemo(() =>
    students().find((student) => student.studentId === studentId()),
  );
  const studentWorks = createMemo(() =>
    works().filter((item) => item.student?.studentId === studentId()),
  );
  const items = createMemo<any[]>(() => work()?.aiResult?.items || []);
  const operations = new Map<string, string>();
  let studentCreateSession = operationId();
  let uploadAttempt: any = null;
  let alive = true;
  let listVersion = 0;
  let detailVersion = 0;
  let poll: ReturnType<typeof setTimeout>;
  let searchTimer: ReturnType<typeof setTimeout>;
  function stable(action: string, payload: any) {
    const key = JSON.stringify({ action, ...payload });
    if (!operations.has(key)) operations.set(key, operationId());
    return { ...payload, operationId: operations.get(key) };
  }
  onCleanup(() => {
    alive = false;
    ++listVersion;
    ++detailVersion;
    clearTimeout(poll);
    clearTimeout(searchTimer);
    props.onJobs(0);
  });
  async function refresh(quiet = false) {
    const own = ++listVersion;
    if (!quiet) setLoading(true);
    try {
      const [studentResult, workResult] = await Promise.all([
        request("students_list", { query: query() }),
        request("student_work_list"),
      ]);
      if (!alive || own !== listVersion) return;
      setStudents(
        retainRows(studentResult.students || [], students(), "studentId"),
      );
      setWorks(retainRows(workResult.works || [], works(), "workId"));
      props.onJobs((workResult.works || []).filter(running).length);
      if (!studentId() && studentResult.students?.length)
        setStudentId(studentResult.students[0].studentId);
      if (work()) {
        const result = await request("student_work_get", {
          workId: work().workId,
        });
        if (
          alive &&
          own === listVersion &&
          work()?.workId === result.work.workId
        )
          setWork(result.work);
      }
    } catch (failure: any) {
      if (alive && own === listVersion) setError(failure.message);
    } finally {
      if (alive && own === listVersion) {
        setLoading(false);
        schedule();
      }
    }
  }
  function schedule() {
    clearTimeout(poll);
    if (alive && (props.active || works().some(running)))
      poll = setTimeout(
        () => refresh(true),
        works().some(running) ? 2000 : 15000,
      );
  }
  createEffect(() => {
    const active = props.active;
    if (active) {
      setError("");
      void refresh();
    } else schedule();
  });
  async function openWork(workId: string) {
    const own = ++detailVersion;
    setError("");
    try {
      const result = await request("student_work_get", { workId });
      if (alive && own === detailVersion) setWork(result.work);
    } catch (failure: any) {
      if (alive && own === detailVersion) setError(failure.message);
    }
  }
  function selectStudent(id: string) {
    ++detailVersion;
    setStudentId(id);
    setWork(null);
    setError("");
    setNotice("");
  }
  function editStudent(value: any = {}) {
    studentCreateSession = operationId();
    setEditing(value);
    setName(value.name || "");
    setGrade(value.grade || "");
    setNotes(value.notes || "");
    setStudentError("");
  }
  async function saveStudent() {
    if (studentBusy() || !name().trim()) return;
    setStudentBusy(true);
    setStudentError("");
    try {
      const result = await request(
        editing()?.studentId ? "students_update" : "students_create",
        stable(
          editing()?.studentId
            ? "update_student"
            : `create_student:${studentCreateSession}`,
          {
            ...(editing()?.studentId
              ? {
                  studentId: editing().studentId,
                  expectedRevision: editing().revision,
                }
              : {}),
            name: name().trim(),
            grade: grade(),
            notes: notes().trim(),
          },
        ),
      );
      setQuery("");
      setStudentId(result.student.studentId);
      setEditing(null);
      await refresh(true);
      setNotice("学生信息已保存。");
    } catch (failure: any) {
      setStudentError(failure.message);
    } finally {
      setStudentBusy(false);
    }
  }
  async function openUpload() {
    if (
      !uploadStudent() ||
      (!frozenUpload() &&
        !answers().length &&
        !sources().length &&
        !title().trim())
    )
      setUploadStudent(studentId());
    setUploadError("");
    setUpload(true);
    try {
      const result = await request("history_list");
      if (alive) setPapers(result.papers || []);
    } catch (failure: any) {
      setUploadError(failure.message);
    }
  }
  function chooseFiles(event: Event, target: "source" | "answer") {
    const input = event.currentTarget as HTMLInputElement;
    const selected = [...(input.files || [])];
    input.value = "";
    if (saving() || frozenUpload()) return;
    if (
      selected.some(
        (file) =>
          !/\.(pdf|png|jpe?g)$/i.test(file.name) ||
          file.size < 1 ||
          file.size > 15 * 1024 * 1024,
      )
    ) {
      setUploadError("请选择 PDF、PNG 或 JPEG，每个文件不超过 15 MB。");
      return;
    }
    const next = [
      ...(target === "source" ? sources() : answers()),
      ...selected,
    ];
    const all =
      target === "source" ? [...next, ...answers()] : [...sources(), ...next];
    if (
      all.length > 8 ||
      all.reduce((sum, file) => sum + file.size, 0) > 45 * 1024 * 1024
    ) {
      setUploadError("原题与答卷合计最多 8 个文件、45 MB。");
      return;
    }
    target === "source" ? setSources(next) : setAnswers(next);
    setUploadError("");
  }
  function moveFile(target: "source" | "answer", index: number, direction: -1 | 1) {
    if (saving() || frozenUpload()) return;
    const update = target === "source" ? setSources : setAnswers;
    update((files) => {
      const destination = index + direction;
      if (index < 0 || index >= files.length || destination < 0 || destination >= files.length) return files;
      const next = [...files];
      [next[index], next[destination]] = [next[destination], next[index]];
      return next;
    });
  }
  const canSave = () =>
    Boolean(
      uploadStudent() &&
        answers().length &&
        (sourceKind() === "paper"
          ? paperId()
          : title().trim()),
    );
  async function encode(file: File) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let start = 0; start < bytes.length; start += 32768)
      binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
    return { filename: file.name, contentBase64: btoa(binary) };
  }
  async function saveWork(start: boolean) {
    if (saving() || (!uploadAttempt && !canSave())) return;
    setSaving(true);
    setUploadError("");
    try {
      if (!uploadAttempt) {
        const answerFiles = await Promise.all(answers().map(encode));
        const source =
          sourceKind() === "paper"
            ? { kind: "paper", paperId: paperId() }
            : {
                kind: "external",
                externalSourceMode: sources().length ? "separate_materials" : "answer_only",
                files: await Promise.all(sources().map(encode)),
              };
        uploadAttempt = {
          operationId: operationId(),
          studentId: uploadStudent(),
          title: title().trim(),
          completedOn: completedOn() || null,
          notes: workNotes().trim(),
          source,
          answers: answerFiles,
        };
        setFrozenUpload(true);
      }
      const result = await request("student_work_create", uploadAttempt);
      setWork(result.work);
      setStudentId(result.work.student.studentId);
      setUpload(false);
      setFrozenUpload(false);
      uploadAttempt = null;
      setTitle("");
      setCompletedOn("");
      setWorkNotes("");
      setPaperId("");
      setSources([]);
      setAnswers([]);
      setNotice("答卷已保存在本机。");
      await refresh(true);
      if (start) await startWork(result.work);
    } catch (failure: any) {
      if (failure.code === "invalid_upload") {
        uploadAttempt = null;
        setFrozenUpload(false);
      }
      setUploadError(failure.message);
    } finally {
      setSaving(false);
    }
  }
  async function startWork(value = work(), retry = false) {
    if (!value || actionBusy()) return;
    setActionBusy(value.workId);
    setError("");
    try {
      const result = await request(
        retry ? "student_work_retry" : "student_work_start",
        stable(retry ? "work_retry" : "work_start", {
          workId: value.workId,
          expectedRevision: value.revision,
        }),
      );
      if (work()?.workId === value.workId) setWork(result.work);
      setNotice("已开始后台批改，可以继续组卷。");
      await refresh(true);
    } catch (failure: any) {
      setError(`答卷已保存，批改状态尚未确认：${failure.message}`);
    } finally {
      setActionBusy("");
    }
  }
  async function stopWork() {
    if (!work() || actionBusy()) return;
    const value = work();
    setActionBusy(value.workId);
    setError("");
    try {
      const result = await request("student_work_cancel", {
        workId: value.workId,
        jobId: value.job?.jobId || value.jobId,
      });
      if (work()?.workId === value.workId) setWork(result.work);
      await refresh(true);
    } catch (failure: any) {
      setError(failure.message);
    } finally {
      setActionBusy("");
    }
  }
  function teacherValue(item: any) {
    return [...(work()?.teacherOverrides || [])]
      .reverse()
      .find(
        (value) =>
          Boolean(work()?.aiResult?.jobId) &&
          value.itemId === item.itemId &&
          value.jobId === work()?.aiResult?.jobId,
      );
  }
  function historyValue(attempt: any, item: any) {
    return [...(work()?.teacherOverrides || [])]
      .reverse()
      .find(
        (value) =>
          value.jobId === attempt.jobId && value.itemId === item.itemId,
      );
  }
  const attempts = createMemo(() => {
    const values = [...(work()?.attempts || [])];
    const job = work()?.job;
    if (
      job?.jobId &&
      ["failed", "cancelled", "interrupted"].includes(job.status) &&
      !values.some((value) => value.jobId === job.jobId)
    )
      values.push({ ...job, completedAt: job.finishedAt });
    return values;
  });
  function correct(item: any) {
    const previous = teacherValue(item);
    setOverride({ ...item, resultJobId: work()?.aiResult?.jobId });
    setJudgement(previous?.judgement || item.judgement || "unable");
    setComment(previous?.comment || "");
    setEarned(
      previous?.earnedPoints !== undefined && previous?.earnedPoints !== null
        ? String(previous.earnedPoints)
        : item.earnedPoints !== undefined && item.earnedPoints !== null
          ? String(item.earnedPoints)
          : "",
    );
    setOverrideError("");
  }
  async function saveOverride() {
    if (!override() || overrideBusy()) return;
    if (override().resultJobId !== work()?.aiResult?.jobId) {
      setOverrideError("批改结果已更新，请重新打开修正。");
      return;
    }
    setOverrideBusy(true);
    setOverrideError("");
    try {
      const result = await request(
        "student_work_override",
        stable("override", {
          workId: work().workId,
          expectedRevision: work().revision,
          itemId: override().itemId,
          judgement: judgement(),
          comment: comment().trim(),
          ...(typeof override().maxPoints === "number"
            ? { earnedPoints: earned().trim() ? Number(earned()) : null }
            : {}),
        }),
      );
      setWork(result.work);
      setOverride(null);
      await refresh(true);
    } catch (failure: any) {
      setOverrideError(failure.message);
    } finally {
      setOverrideBusy(false);
    }
  }
  async function showPaper() {
    setError("");
    if (work()?.source?.paperSnapshot) {
      setPaperPreview(work().source.paperSnapshot);
      return;
    }
    try {
      const result = await request("paper_get", {
        paperId: work().source.paperId,
      });
      setPaperPreview(result.paper);
    } catch (failure: any) {
      setError(failure.message);
    }
  }
  const allFiles = () => [
    ...(work()?.source?.files || []),
    ...(work()?.answerFiles || []),
  ];
  return (
    <section class="student-work-page">
      <header class="page-heading">
        <div>
          <h1>学生管理</h1>
          <p class="muted">学生资料、答卷与批改记录。</p>
        </div>
        <button class="primary" onClick={() => editStudent()}>
          <Plus size={17} />
          新增学生
        </button>
      </header>
      <ErrorBanner
        message={error()}
        retry={() => {
          setError("");
          refresh();
        }}
      />
      <Show when={/配置|密钥/.test(error())}>
        <button class="text-button" onClick={props.onConfigure}>
          识别与模型设置
        </button>
      </Show>
      <Show when={notice()}>
        <p class="student-notice" role="status">
          <Check size={15} />
          {notice()}
        </p>
      </Show>
      <div class="student-work-layout">
        <aside class="student-list-panel" aria-label="学生名单">
          <div class="student-list-heading">
            <h2>{query() ? "搜索结果" : "学生"}</h2>
            <span>{students().length} 位</span>
          </div>
          <label class="search-field">
            <Search size={16} />
            <input
              type="search"
              aria-label="搜索学生"
              placeholder="搜索姓名、年级"
              value={query()}
              onInput={(event) => {
                setQuery(event.currentTarget.value);
                clearTimeout(searchTimer);
                searchTimer = setTimeout(() => refresh(), 220);
              }}
            />
          </label>
          <Show when={loading() && !students().length}>
            <Busy label="读取学生…" />
          </Show>
          <div class="student-list-items"><For each={students()}>
            {(student) => (
              <button
                class={`student-list-item ${studentId() === student.studentId ? "active" : ""}`}
                aria-pressed={studentId() === student.studentId}
                onClick={() => selectStudent(student.studentId)}
              >
                <span class="student-list-avatar" aria-hidden="true"><UserRound size={18} /></span>
                <span class="student-list-identity">
                  <strong>{student.name}</strong>
                  <small>{student.grade || "未设置年级"}</small>
                </span>
              </button>
            )}
          </For></div>
          <Show when={!loading() && !students().length}>
            <p class="empty-state">
              {query() ? "没有匹配的学生。" : "添加一名学生，开始保存答卷。"}
            </p>
          </Show>
        </aside>
        <main class="student-work-main">
          <Show
            when={currentStudent()}
            fallback={
              <Show when={!loading()} fallback={<Busy label="读取学生资料…" />}>
                <div class="student-welcome-state">
                  <span class="student-empty-icon" aria-hidden="true"><UserRound size={28} /></span>
                  <h2>{query() ? "选择一名学生" : students().length ? "查看学生的答卷" : "从一名学生开始"}</h2>
                  <p>{query() ? "在左侧选择学生，或调整搜索内容。" : "记录基础资料，集中保存答卷和批改结果。"}</p>
                  <Show when={!query() && !students().length}>
                    <button class="primary" onClick={() => editStudent()}><Plus size={17} />添加第一名学生</button>
                  </Show>
                </div>
              </Show>
            }
          >
            <header class="student-profile-heading">
              <div class="student-profile-identity">
                <span class="student-profile-avatar" aria-hidden="true"><UserRound size={24} /></span>
                <div><h2>
                  {currentStudent()?.name}
                  <Show when={currentStudent()?.grade}><span>{currentStudent()?.grade}</span></Show>
                </h2>
                <Show when={currentStudent()?.notes}>
                  <p class="muted student-notes">{currentStudent().notes}</p>
                </Show></div>
              </div>
              <div class="inline-actions">
                <button
                  class="text-button"
                  onClick={() => editStudent(currentStudent())}
                >
                  <Pencil size={15} />
                  编辑资料
                </button>
                <Show when={studentWorks().length || work()}><button class="primary" onClick={openUpload}>
                  <Upload size={16} />
                  上传答卷
                </button></Show>
              </div>
            </header>
            <Show
              when={!work()}
              fallback={
                <>
                  <button
                    class="text-button student-back"
                    onClick={() => {
                      ++detailVersion;
                      setWork(null);
                      setError("");
                    }}
                  >
                    <ArrowLeft size={16} />
                    练习记录
                  </button>
                  <header class="student-work-heading">
                    <div>
                      <h2>{work()?.title || "练习答卷"}</h2>
                      <p class="muted">
                        {stages[work()?.status] || "状态待确认"} ·{" "}
                        {stamp(work()?.createdAt)}
                      </p>
                    </div>
                    <div class="inline-actions">
                      <Show
                        when={running(work())}
                        fallback={
                          <button
                            class="secondary"
                            disabled={Boolean(actionBusy())}
                            onClick={() =>
                              startWork(
                                work(),
                                ["failed", "cancelled", "interrupted"].includes(
                                  work()?.status,
                                ),
                              )
                            }
                          >
                            <RefreshCw size={15} />
                            {work()?.status === "saved"
                              ? "开始批改"
                              : "重新批改"}
                          </button>
                        }
                      >
                        <button
                          class="secondary"
                          disabled={Boolean(actionBusy())}
                          onClick={stopWork}
                        >
                          停止批改
                        </button>
                      </Show>
                    </div>
                  </header>
                  <Show when={work()?.completedOn || work()?.notes}>
                    <p class="muted student-work-local-notes">
                      <Show when={work()?.completedOn}>
                        作答日期：{work().completedOn}　
                      </Show>
                      {work()?.notes}
                    </p>
                  </Show>
                  <Show when={running(work())}>
                    <p class="student-task-status" role="status">
                      后台处理中，可以离开此页继续组卷。
                      <Show when={work()?.job?.message}>
                        <span>{work().job.message}</span>
                      </Show>
                    </p>
                  </Show>
                  <Show when={work()?.error || work()?.job?.error}>
                    <ErrorBanner
                      message={textError(work()?.error || work()?.job?.error)}
                    />
                  </Show>
                  <section class="student-originals">
                    <h3>原题与答卷</h3>
                    <div class="inline-actions">
                      <Show when={work()?.source?.kind === "paper"}>
                        <button class="secondary" onClick={showPaper}>
                          <FileText size={15} />
                          原试卷
                        </button>
                      </Show>
                      <Show
                        when={
                          work()?.source?.externalSourceMode ===
                          "answer_contains_questions"
                        }
                      >
                        <span class="muted">答卷包含完整题目</span>
                      </Show>
                      <For each={allFiles()}>
                        {(file) => (
                          <button
                            class="secondary"
                            onClick={() =>
                              setViewer({ workId: work().workId, file })
                            }
                          >
                            <FileText size={15} />
                            {file.filename || "查看原件"}
                          </button>
                        )}
                      </For>
                    </div>
                  </section>
                  <Show
                    when={items().length}
                    fallback={
                      <Show when={!running(work())}>
                        <p class="empty-state">
                          {work()?.status === "saved"
                            ? "答卷已保存，点击开始批改查看结果。"
                            : work()?.status === "completed"
                              ? "暂未得到可判断的逐题结果，请查看原件或重试。"
                              : "已有原件保留在本机，可修正配置后重试。"}
                        </p>
                      </Show>
                    }
                  >
                    <Show
                      when={
                        work()?.aiResult?.jobId &&
                        work()?.job?.jobId &&
                        work().aiResult.jobId !== work().job.jobId
                      }
                    >
                      <p class="student-task-status" role="status">
                        以下为上次完成的批改结果，
                        {work().status === "failed"
                          ? "本次批改已失败。"
                          : work().status === "cancelled"
                            ? "本次批改已停止。"
                            : work().status === "interrupted"
                              ? "本次批改已中断。"
                              : "本次批改尚未完成。"}
                      </p>
                    </Show>
                    <div class="student-result-summary">
                      <span class="muted">
                        按题／小问计 {items().length} 项
                      </span>
                      <For each={Object.entries(judgements)}>
                        {([id, label]) => (
                          <span>
                            {label}{" "}
                            <b>
                              {
                                items().filter(
                                  (item) =>
                                    (teacherValue(item)?.judgement ||
                                      item.judgement) === id,
                                ).length
                              }
                            </b>
                          </span>
                        )}
                      </For>
                    </div>
                    <p class="muted student-result-note">
                      {work()?.aiResult?.summary ||
                        "模型批改供教学参考；辨认不清或依据不足的题目保留为“暂无法判断”，可按需修正。"}
                    </p>
                    <Show when={work()?.source?.kind === "external"}>
                      <p class="muted student-result-note">
                        仅展示已识别题目，整卷完整性未核验。
                      </p>
                    </Show>
                    <For each={items()}>
                      {(item) => (
                        <article
                          class={`student-result-item judgement-${teacherValue(item)?.judgement || item.judgement}`}
                        >
                          <header>
                            <h3>{item.questionLabel || "题目"}</h3>
                            <span>
                              {judgements[
                                teacherValue(item)?.judgement || item.judgement
                              ] || "暂无法判断"}
                              <Show when={teacherValue(item)}> · 教师修正</Show>
                            </span>
                            <Show when={typeof item.maxPoints === "number"}>
                              <span class="student-item-score">
                                {teacherValue(item)?.earnedPoints !== undefined
                                  ? (teacherValue(item).earnedPoints ?? "—")
                                  : (item.earnedPoints ?? "—")}{" "}
                                / {item.maxPoints} 分
                              </span>
                            </Show>
                            <button
                              class="text-button"
                              onClick={() => correct(item)}
                            >
                              <Pencil size={14} />
                              修正
                            </button>
                          </header>
                          <p class="student-result-reason">
                            <RichText
                              text={
                                teacherValue(item)?.comment ||
                                item.reason ||
                                "暂无充分依据。"
                              }
                            />
                          </p>
                          <details>
                            <summary>
                              题目、作答与依据
                              <Show when={teacherValue(item)}>
                                及原模型判断
                              </Show>
                            </summary>
                            <p class="muted">
                              模型自评：
                              {{ high: "高", medium: "中", low: "低" }[
                                item.confidence as "high" | "medium" | "low"
                              ] || "未提供"}
                            </p>
                            <Show when={item.questionText}>
                              <div class="student-result-question">
                                <RichText text={item.questionText} />
                              </div>
                            </Show>
                            <dl>
                              <div>
                                <dt>学生作答</dt>
                                <dd>
                                  <RichText
                                    text={
                                      item.studentAnswer ||
                                      (item.judgement === "unanswered"
                                        ? "未作答"
                                        : "未能辨认")
                                    }
                                  />
                                </dd>
                              </div>
                              <Show when={item.referenceAnswer}>
                                <div>
                                  <dt>参考答案</dt>
                                  <dd>
                                    <RichText text={item.referenceAnswer} />
                                  </dd>
                                </div>
                              </Show>
                              <Show when={teacherValue(item)?.comment}>
                                <div>
                                  <dt>教师备注</dt>
                                  <dd>{teacherValue(item).comment}</dd>
                                </div>
                              </Show>
                            </dl>
                            <Show when={teacherValue(item)}>
                              <p>
                                原模型判断：
                                {judgements[item.judgement] || "暂无法判断"}
                              </p>
                            </Show>
                            <For each={item.evidence || []}>
                              {(entry) => (
                                <p class="student-evidence">
                                  <button
                                    class="text-button"
                                    onClick={() => {
                                      const file = allFiles().find(
                                        (value) =>
                                          value.fileId === entry.fileId,
                                      );
                                      if (file)
                                        setViewer({
                                          workId: work().workId,
                                          file,
                                        });
                                    }}
                                  >
                                    {allFiles().find(
                                      (value) => value.fileId === entry.fileId,
                                    )?.filename || "答卷材料"}{" "}
                                    · 第 {entry.page || "?"} 页
                                  </button>
                                  <span>{entry.quote}</span>
                                </p>
                              )}
                            </For>
                            <Show when={!item.evidence?.length}>
                              <p class="muted">暂无可定位的答卷依据。</p>
                            </Show>
                          </details>
                        </article>
                      )}
                    </For>
                  </Show>
                  <Show when={attempts().length}>
                    <details class="student-attempts">
                      <summary>批改记录 · {attempts().length}</summary>
                      <p class="muted">
                        同一份答卷的批改记录，保留原模型结果和对应的教师修正。
                      </p>
                      <For each={attempts()}>
                        {(attempt) => (
                          <details>
                            <summary>
                              {stamp(
                                attempt.completedAt ||
                                  attempt.finishedAt ||
                                  attempt.createdAt,
                              )}{" "}
                              · {stages[attempt.status] || "已完成"}
                              {attempt.jobId === work()?.aiResult?.jobId
                                ? " · 当前结果"
                                : ""}
                            </summary>
                            <Show when={attempt.error}>
                              <p class="warning-text">
                                {textError(attempt.error)}
                              </p>
                            </Show>
                            <For each={attempt.result?.items || []}>
                              {(item) => (
                                <div class="student-attempt-item">
                                  <strong>
                                    {item.questionLabel || "题目"} ·{" "}
                                    {judgements[
                                      historyValue(attempt, item)?.judgement ||
                                        item.judgement
                                    ] || "暂无法判断"}
                                    <Show when={historyValue(attempt, item)}>
                                      {" "}
                                      · 教师修正
                                    </Show>
                                  </strong>
                                  <p>
                                    <RichText
                                      text={
                                        historyValue(attempt, item)?.comment ||
                                        item.reason ||
                                        "暂无充分依据。"
                                      }
                                    />
                                  </p>
                                  <Show when={historyValue(attempt, item)}>
                                    <small class="muted">
                                      原模型判断：
                                      {judgements[item.judgement] ||
                                        "暂无法判断"}
                                    </small>
                                  </Show>
                                </div>
                              )}
                            </For>
                          </details>
                        )}
                      </For>
                    </details>
                  </Show>
                </>
              }
            >
              <div class="section-heading student-records-heading">
                <h3>练习记录</h3>
                <span class="student-record-count">{studentWorks().length} 份答卷</span>
              </div>
              <Show when={!studentWorks().length}>
                <div class="student-answer-empty">
                  <span class="student-empty-icon" aria-hidden="true"><FileText size={28} /></span>
                  <h3>记录第一份答卷</h3>
                  <p>选择已组好的试卷或上传其他练习，保存答卷后即可后台批改。</p>
                  <button class="primary" onClick={openUpload}><Upload size={17} />上传答卷</button>
                  <span class="student-empty-formats">支持 PDF、PNG、JPEG</span>
                </div>
              </Show>
              <For each={studentWorks()}>
                {(value) => (
                  <button
                    class="student-work-row"
                    onClick={() => openWork(value.workId)}
                  >
                    <span class="student-record-icon" aria-hidden="true"><FileText size={20} /></span>
                    <span class="student-record-identity">
                      <strong>{value.title || "练习答卷"}</strong>
                      <small>{value.completedOn ? `作答 ${value.completedOn.replaceAll("-", ".")}` : `上传 ${stamp(value.createdAt)}`}<span aria-hidden="true"> · </span>{value.source?.kind === "paper" ? "已组好的试卷" : "其他练习"}</small>
                    </span>
                    <span
                      class={`student-work-state ${value.status} ${running(value) ? "is-running" : ""}`}
                    >
                      {stages[value.status] || "状态待确认"}
                    </span>
                    <ChevronRight size={17} class="student-record-chevron" aria-hidden="true" />
                  </button>
                )}
              </For>
            </Show>
          </Show>
        </main>
      </div>
      <Show when={editing()}>
        <Modal
          title={editing()?.studentId ? "编辑学生" : "新增学生"}
          busy={studentBusy()}
          onClose={() => setEditing(null)}
          footer={
            <>
              <button
                class="secondary"
                disabled={studentBusy()}
                onClick={() => setEditing(null)}
              >
                取消
              </button>
              <button
                class="primary"
                disabled={studentBusy() || !name().trim()}
                onClick={saveStudent}
              >
                {studentBusy() ? "保存中…" : "保存"}
              </button>
            </>
          }
        >
          <label class="field-label">
            姓名或昵称
            <input
              maxLength={40}
              value={name()}
              onInput={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <label class="field-label">
            年级
            <select
              aria-label="学生年级"
              value={grade()}
              onChange={(event) => setGrade(event.currentTarget.value)}
            >
              <option value="">暂不设置</option>
              <For each={grades}>
                {(group) => (
                  <optgroup label={group.label}>
                    <For each={group.values}>
                      {(value) => <option value={value}>{value}</option>}
                    </For>
                  </optgroup>
                )}
              </For>
            </select>
          </label>
          <label class="field-label">
            备注
            <textarea
              rows={3}
              maxLength={2000}
              value={notes()}
              placeholder="选填，例如授课安排。"
              onInput={(event) => setNotes(event.currentTarget.value)}
            />
          </label>
          <ErrorBanner message={studentError()} />
        </Modal>
      </Show>
      <Show when={upload()}>
        <Modal
          title="上传答卷"
          wide
          busy={saving()}
          onClose={() => setUpload(false)}
          footer={
            <>
              <span class="student-upload-footer-hint">
                {!uploadStudent() ? "请选择学生" : sourceKind() === "paper" && !paperId() ? "请选择试卷" : sourceKind() === "external" && !title().trim() ? "请填写练习名称" : answers().length ? `已添加 ${answers().length} 份答卷` : "添加学生答卷后即可保存"}
              </span>
              <button
                class="secondary"
                disabled={saving() || (!frozenUpload() && !canSave())}
                onClick={() => saveWork(false)}
              >
                仅保存
              </button>
              <button
                class="primary"
                disabled={saving() || (!frozenUpload() && !canSave())}
                onClick={() => saveWork(true)}
              >
                {saving()
                  ? "保存中…"
                  : frozenUpload()
                    ? "重试保存并批改"
                    : "保存并批改"}
              </button>
            </>
          }
        >
          <ErrorBanner message={uploadError()} />
          <fieldset
            class="student-upload-fields"
            disabled={saving() || frozenUpload()}
          >
            <div class="student-upload-context">
            <label class="field-label">
              学生
              <select
                aria-label="答卷所属学生"
                value={uploadStudent()}
                onChange={(event) =>
                  setUploadStudent(event.currentTarget.value)
                }
              >
                <option value="">选择学生</option>
                <For each={students()}>
                  {(student) => (
                    <option value={student.studentId}>
                      {student.name}
                      {student.grade ? ` · ${student.grade}` : ""}
                    </option>
                  )}
                </For>
              </select>
            </label>
            <div class="type-tabs student-upload-source-tabs" role="tablist" aria-label="练习来源">
              <button
                type="button"
                role="tab"
                aria-selected={sourceKind() === "paper"}
                class={sourceKind() === "paper" ? "active" : ""}
                onClick={() => setSourceKind("paper")}
              >
                已组好的试卷
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sourceKind() === "external"}
                class={sourceKind() === "external" ? "active" : ""}
                onClick={() => setSourceKind("external")}
              >
                上传其他练习
              </button>
            </div>
            </div>
            <p class="student-source-explanation">
              {sourceKind() === "paper"
                ? "直接使用已组好试卷的题目，上传学生答卷即可。"
                : "上传答卷即可。原试卷选填，缺少必要题干的题会标为暂无法判断。"}
            </p>
            <Show
              when={sourceKind() === "paper"}
              fallback={
                <>
                  <label class="field-label">
                    练习名称
                    <input
                      maxLength={120}
                      value={title()}
                      onInput={(event) => setTitle(event.currentTarget.value)}
                      placeholder="例如：二次函数课后练习"
                    />
                  </label>
                </>
              }
            >
              <label class="field-label">
                选择试卷
                <select
                  aria-label="选择本机成卷"
                  value={paperId()}
                  onChange={(event) => setPaperId(event.currentTarget.value)}
                >
                  <option value="">选择已确认的试卷</option>
                  <For each={papers()}>
                    {(paper) => (
                      <option value={paper.paperId}>
                        {paper.title || "未命名试卷"}
                      </option>
                    )}
                  </For>
                </select>
              </label>
              <Show when={!papers().length}>
                <p class="muted">
                  暂无已确认的试卷。可以先组卷，或切换到“上传其他练习”。
                </p>
              </Show>
              <label class="field-label">
                记录名称
                <input
                  maxLength={120}
                  value={title()}
                  onInput={(event) => setTitle(event.currentTarget.value)}
                  placeholder="选填，默认使用试卷名称"
                />
              </label>
            </Show>
            <label class="student-file-picker student-answer-picker">
              <span class="student-upload-icon" aria-hidden="true"><Upload size={24} /></span>
              <span class="student-upload-picker-copy">
                <strong>{answers().length ? "继续添加答卷" : "添加学生答卷"}</strong>
                <span>PDF、PNG、JPEG · 每份不超过 15 MB</span>
              </span>
              <span class="student-upload-picker-action">选择文件</span>
              <input
                type="file"
                multiple
                accept=".pdf,.png,.jpg,.jpeg"
                aria-label="学生答卷文件"
                onChange={(event) => chooseFiles(event, "answer")}
              />
            </label>
            <FileList
              files={answers()}
              onPreview={(file) => setViewer({ workId: "", file, local: true })}
              disabled={saving() || frozenUpload()}
              onMove={(index, direction) => moveFile("answer", index, direction)}
              onRemove={(index) =>
                setAnswers((files) => files.filter((_, item) => item !== index))
              }
            />
            <Show when={sourceKind() === "external"}>
              <details class="student-source-materials" open={sources().length > 0}>
                <summary>
                  <FileText size={16} aria-hidden="true" />
                  <span>补充原试卷 <small>选填{sources().length ? ` · ${sources().length} 份` : ""}</small></span>
                  <span class="student-source-summary-hint">帮助对照题干与题号</span>
                </summary>
                <p>答卷没有完整题干时，可以补充原试卷。未上传也可以保存并批改。</p>
                <label class="student-file-picker student-source-picker">
                  <Upload size={18} />
                  <strong>选择原试卷</strong>
                  <span>PDF、PNG、JPEG</span>
                  <input
                    type="file"
                    multiple
                    accept=".pdf,.png,.jpg,.jpeg"
                    aria-label="原题材料"
                    onChange={(event) => chooseFiles(event, "source")}
                  />
                </label>
                <FileList
                  files={sources()}
                  onPreview={(file) => setViewer({ workId: "", file, local: true })}
                  disabled={saving() || frozenUpload()}
                  onMove={(index, direction) => moveFile("source", index, direction)}
                  onRemove={(index) => setSources((files) => files.filter((_, item) => item !== index))}
                />
              </details>
            </Show>
            <div class="student-work-fields-row">
              <div class="field-label">
                <span>作答日期（选填）</span>
                <DateField
                  label="作答日期"
                  value={completedOn()}
                  onChange={setCompletedOn}
                  disabled={saving() || frozenUpload()}
                />
              </div>
              <label class="field-label">
                答卷备注
                <input
                  maxLength={2000}
                  value={workNotes()}
                  onInput={(event) => setWorkNotes(event.currentTarget.value)}
                  placeholder="选填，仅保存在本机"
                />
              </label>
            </div>
          </fieldset>
          <div class="student-upload-service-note">
            <p class="muted student-upload-note">
              原件保存在本机，批改时发送至已配置的识别与模型服务；图片可能包含姓名。
            </p>
          <button
            class="text-button"
            disabled={saving()}
            onClick={props.onConfigure}
          >
            识别与模型设置
          </button>
          </div>
          <Show when={frozenUpload() && uploadError()}>
            <p class="muted">
              本次保存已固定，重试不会重复创建记录；可关闭后稍后继续。
            </p>
          </Show>
        </Modal>
      </Show>
      <Show when={override()}>
        <Modal
          title={`修正 · ${override()?.questionLabel || "题目"}`}
          busy={overrideBusy()}
          onClose={() => setOverride(null)}
          footer={
            <>
              <button
                class="secondary"
                disabled={overrideBusy()}
                onClick={() => setOverride(null)}
              >
                取消
              </button>
              <button
                class="primary"
                disabled={overrideBusy()}
                onClick={saveOverride}
              >
                {overrideBusy() ? "保存中…" : "保存修正"}
              </button>
            </>
          }
        >
          <label class="field-label">
            判断
            <select
              aria-label="教师判断"
              value={judgement()}
              onChange={(event) => setJudgement(event.currentTarget.value)}
            >
              <For each={Object.entries(judgements)}>
                {([id, label]) => <option value={id}>{label}</option>}
              </For>
            </select>
          </label>
          <label class="field-label">
            说明
            <textarea
              rows={3}
              maxLength={2000}
              value={comment()}
              onInput={(event) => setComment(event.currentTarget.value)}
              placeholder="选填，记录修正依据。"
            />
          </label>
          <Show when={typeof override()?.maxPoints === "number"}>
            <label class="field-label">
              本题得分
              <input
                type="number"
                min={0}
                max={override().maxPoints}
                step="0.5"
                value={earned()}
                onInput={(event) => setEarned(event.currentTarget.value)}
                placeholder="留空表示暂不赋分"
              />
              <small class="muted">满分 {override().maxPoints} 分</small>
            </label>
          </Show>
          <p class="muted">保留原模型结果，教师修正单独记录。</p>
          <ErrorBanner message={overrideError()} />
        </Modal>
      </Show>
      <Show when={viewer()} keyed>
        {(value) => (
          <Modal
            title={value.file.filename || value.file.name || "原件"}
            wide
            expanded
            onClose={() => setViewer(null)}
          >
            <div
              class={value.local || !items().length ? "" : "student-comparison"}
            >
              <div class="student-comparison-original">
                <Original workId={value.workId} file={value.file} />
              </div>
              <Show when={!value.local && items().length}>
                <aside class="student-comparison-results" aria-label="批改对照">
                  <h3>批改结果</h3>
                  <For each={items()}>
                    {(item) => (
                      <article>
                        <header>
                          <strong>{item.questionLabel || "题目"}</strong>
                          <span>
                            {judgements[
                              teacherValue(item)?.judgement || item.judgement
                            ] || "暂无法判断"}
                          </span>
                        </header>
                        <Show when={item.questionText}>
                          <RichText text={item.questionText} />
                        </Show>
                        <p>
                          <span class="muted">学生作答：</span>
                          <RichText
                            text={
                              item.studentAnswer ||
                              (item.judgement === "unanswered"
                                ? "未作答"
                                : "未能辨认")
                            }
                          />
                        </p>
                        <RichText
                          text={
                            teacherValue(item)?.comment ||
                            item.reason ||
                            "暂无充分依据。"
                          }
                        />
                      </article>
                    )}
                  </For>
                </aside>
              </Show>
            </div>
          </Modal>
        )}
      </Show>
      <Show when={paperPreview()}>
        <Modal
          title="原试卷"
          wide
          expanded
          onClose={() => setPaperPreview(null)}
        >
          <PaperSheet
            draft={paperPreview().draft}
            title={paperPreview().title}
            kind="teacher"
          />
        </Modal>
      </Show>
    </section>
  );
}
