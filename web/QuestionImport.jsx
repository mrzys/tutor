import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileUp, LoaderCircle, RefreshCw } from 'lucide-react';
import { api, typeLabels, uploadApi } from './api.js';
import { MathText } from './MathText.jsx';

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const supportedExtension = /\.(txt|md|pdf|docx)$/i;

function textList(value) {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map(item => typeof item === 'string' ? item : item?.message ?? item?.label ?? item?.name ?? item?.id ?? '未命名建议');
}

function ParsedQuestion({ question, index }) {
  const stem = question.student?.stem ?? question.stem ?? question.content ?? '未识别出题干';
  const chapters = textList(question.dimensions?.chapterCandidates ?? question.chapterSuggestions ?? question.chapters ?? question.dimensionSuggestions?.chapters);
  const tasks = textList(question.dimensions?.taskCandidates ?? question.taskSuggestions);
  const knowledge = textList(question.dimensions?.knowledgePoints ?? question.knowledgePointSuggestions ?? question.knowledgePoints ?? question.dimensionSuggestions?.knowledgePoints);
  const issues = textList(question.reviewIssues);
  const questionType = question.questionType ?? question.type;
  return <article className="import-question-card">
    <div className="import-question-title"><strong>第 {question.number ?? index + 1} 题</strong><span>{typeLabels[questionType] ?? questionType ?? '题型待确认'}</span>{issues.length ? <b>需审核</b> : <em>待审核</em>}</div>
    <p className="import-question-stem"><MathText text={stem}/></p>
    <dl><dt>章节建议</dt><dd>{chapters.join('、') || '未识别'}</dd><dt>任务建议</dt><dd>{tasks.join('、') || '未识别'}</dd><dt>知识点建议</dt><dd>{knowledge.join('、') || '未识别'}</dd></dl>
    {issues.length ? <div className="import-review-issues"><AlertTriangle size={16}/><div><strong>人工审核项</strong><ul>{issues.map((issue, issueIndex) => <li key={`${issue}-${issueIndex}`}>{issue}</li>)}</ul></div></div> : null}
  </article>;
}

function ReviewSummary({ value, publication }) {
  if (publication?.lastPublishedAt) return <p>已审核入库 {publication.accepted} 道，当前可用 {publication.currentReady} 道{publication.currentPending ? `，入库后待复核 ${publication.currentPending} 道` : ''}；重复 {publication.duplicates} 道，未通过 {publication.rejected} 道，未处理 {publication.held} 道。原始解析记录保留，便于对照复核。</p>;
  if (!value) return null;
  if (typeof value === 'string') return <p>{value}</p>;
  if (Array.isArray(value)) return <ul>{value.map((item, index) => <li key={index}>{typeof item === 'string' ? item : JSON.stringify(item)}</li>)}</ul>;
  if (value.publicationBlocked) return <><p>{value.reason || '解析结果仅进入暂存区，人工审核完成前不能发布。'}</p><p><strong>当前状态：</strong>待人工审核，未进入正式题库。</p></>;
  return <dl>{Object.entries(value).map(([key, item]) => <React.Fragment key={key}><dt>{key}</dt><dd>{Array.isArray(item) ? item.join('、') : typeof item === 'object' && item ? JSON.stringify(item) : String(item)}</dd></React.Fragment>)}</dl>;
}

export function QuestionImport() {
  const inputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [imports, setImports] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  async function loadImports(signal) {
    setHistoryLoading(true);
    try { const response = await api('/api/question-imports', undefined, signal); setImports(response.imports ?? []); }
    catch (failure) { if (failure.name !== 'AbortError' && failure.status !== 404) setError(failure.message); }
    finally { if (!signal?.aborted) setHistoryLoading(false); }
  }

  useEffect(() => {
    const controller = new AbortController();
    loadImports(controller.signal);
    return () => controller.abort();
  }, []);

  function chooseFile(next) {
    setError(''); setResult(null);
    if (!next) { setFile(null); return; }
    if (!supportedExtension.test(next.name)) { setError('仅支持 TXT、MD、PDF 或 DOCX 文件。'); setFile(null); return; }
    if (next.size > MAX_FILE_BYTES) { setError('文件不能超过 15MB。'); setFile(null); return; }
    setFile(next);
  }

  async function upload(event) {
    event.preventDefault();
    if (!file || busy) return;
    setBusy(true); setError(''); setResult(null);
    try {
      const form = new FormData(); form.append('file', file);
      const response = await uploadApi('/api/question-imports', form);
      setResult(response.import); setFile(null); if (inputRef.current) inputRef.current.value = '';
      await loadImports();
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  async function openImport(importId) {
    if (busy) return;
    setBusy(true); setError('');
    try { const response = await api(`/api/question-imports/${encodeURIComponent(importId)}`); setResult(response.import); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  return <section className="question-import-page">
    <div className="question-bank-heading"><div><span className="bank-eyebrow"><FileUp size={16}/>试卷导入</span><h1>上传并解析试卷</h1><p>LLM 会拆分题目并建议题型、章节和知识点；结果只进入待审核区。</p></div></div>
    <div className="import-safety-note"><AlertTriangle size={18}/><div><strong>审核通过后才能进入正式题库</strong><p>请对照原文件核对题面、答案、解析和公式；含图片、表格的题目还需核对内容及对应关系，未核验完整时保留在待审核区。AI 解析与难度估计仅作参考。</p></div></div>
    <form className="import-upload-card" onSubmit={upload}>
      <label className="import-file-drop"><FileUp size={27}/><span><strong>{file ? file.name : '选择一份试卷文件'}</strong><small>{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : '支持 TXT、MD、PDF、DOCX，最大 15MB'}</small></span><input ref={inputRef} type="file" accept=".txt,.md,.pdf,.docx,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={event => chooseFile(event.target.files?.[0])} disabled={busy}/></label>
      <button className="primary" type="submit" disabled={!file || busy}>{busy ? <><LoaderCircle className="spinning" size={17}/>正在上传并解析…</> : '开始解析'}</button>
    </form>
    {busy ? <div className="import-progress" role="status"><LoaderCircle className="spinning" size={19}/><div><strong>正在处理试卷</strong><p>文件已提交，正在提取文本、拆分题目并生成维度建议，请稍候。</p></div></div> : null}
    {error ? <div className="notice error" role="alert">{error}</div> : null}
    {result ? <section className="import-result" aria-label="解析结果">
      <div className="import-result-heading"><div><CheckCircle2 size={21}/><div><h2>{result.title || '试卷解析结果'}</h2><p>{result.source?.filename ?? result.source?.name ?? (typeof result.source === 'string' ? result.source : '上传文件')} · {result.questions?.length ?? 0} 道题</p></div></div><span>{result.publicationSummary?.lastPublishedAt ? `已入库 ${result.publicationSummary.accepted} 道` : '待人工审核'}</span></div>
      <div className="import-review-summary"><h3>审核概览</h3><ReviewSummary value={result.reviewSummary} publication={result.publicationSummary}/></div>
      <div className="import-question-list">{(result.questions ?? []).map((question, index) => <ParsedQuestion key={question.questionId ?? question.id ?? index} question={question} index={index}/>)}</div>
      {!result.questions?.length ? <p className="bank-empty">没有拆分出可展示的题目，请检查审核概览或重新上传更清晰的文件。</p> : null}
    </section> : null}
    <section className="import-history"><div className="section-heading"><h2>最近上传</h2><button className="link-button" onClick={() => loadImports()} disabled={historyLoading}><RefreshCw size={14}/>刷新</button></div>
      {historyLoading ? <p className="history-loading" role="status">正在读取上传记录…</p> : imports.length ? <ul>{imports.map(item => <li key={item.importId}><button onClick={() => openImport(item.importId)} disabled={busy}><span><strong>{item.title || item.source?.filename || '未命名试卷'}</strong><small>{item.questions?.length ?? item.questionCount ?? '—'} 道题 · {item.publicationSummary?.lastPublishedAt ? `已入库 ${item.publicationSummary.accepted} 道 · 可用 ${item.publicationSummary.currentReady} 道` : '待人工审核'}</small></span><span>查看结果</span></button></li>)}</ul> : <p className="bank-empty">还没有上传记录。</p>}
    </section>
  </section>;
}
