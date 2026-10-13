import { Select } from './Select.jsx';
import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api, typeTitles } from './api.js';
import { Modal } from './DraftEditor.jsx';
import { MathText } from './MathText.jsx';
import { QuestionOptions } from './QuestionOptions.jsx';
import { QuestionSource } from './QuestionSource.jsx';
import './Paper.css';
import { purposeFor } from '../src/assembly/purposes.mjs';

const PdfPreview = lazy(() => import('./PdfPreview.jsx'));

const kindNames = { student: '学生卷', teacher: '教师卷' };
const outputNames = { not_generated: '尚未生成', complete: '已生成', incomplete: '已生成 · 存在未满足项', failed: '生成失败' };
const issueText = issue => {
  if (typeof issue === 'string') return issue;
  const text = issue.message || issue.reason || issue.reasons?.join('；') || '内容待核查';
  return issue.number && !text.startsWith(`第 ${issue.number} 题`) ? `第 ${issue.number} 题：${text}` : text;
};

function Issues({ items, className = '' }) {
  return items?.length ? <ul className={className}>{items.map((item, index) => <li key={index}>{issueText(item)}</li>)}</ul> : null;
}

export function Confirmation({ draft, onClose, onConfirmed, onReload }) {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [failure, setFailure] = useState(null);
  const payload = useRef(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    api(`/api/drafts/${encodeURIComponent(draft.draftId)}/confirmation`, undefined, controller.signal)
      .then(response => { if (mounted.current) { setSummary(response.summary); if (response.summary.revision !== (draft.revision ?? 0)) setFailure({ message: '草稿已更新，请读取最新草稿并重新检查确认内容。', status: 409 }); } })
      .catch(error => { if (error.name !== 'AbortError' && mounted.current) setFailure({ message: error.message, status: error.status }); })
      .finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; controller.abort(); };
  }, [draft.draftId, draft.revision]);
  async function confirm() {
    if (inFlight.current || !summary || (summary.requiresAcknowledgement && !acknowledged)) return;
    if (!payload.current) payload.current = { operationId: crypto.randomUUID(), expectedRevision: summary.revision, acknowledgeDifferences: acknowledged };
    inFlight.current = true; setBusy(true); setFailure(null);
    try {
      const response = await api(`/api/drafts/${encodeURIComponent(draft.draftId)}/confirm`, payload.current);
      if (mounted.current) onConfirmed(response.paper);
    } catch (error) {
      if (mounted.current) { const retry = !error.status || error.status >= 500; setFailure({ message: error.message, status: error.status, retry }); if (!retry) payload.current = null; }
    } finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }
  const footer = <><p className="help">保存后可生成学生卷和教师卷 PDF。</p><div className="action-row"><button disabled={busy} onClick={onClose}>返回调整</button><button className="primary" disabled={loading || !summary || busy || !!failure && !failure.retry || (summary?.requiresAcknowledgement && !acknowledged)} onClick={confirm}>{busy ? '正在保存成卷…' : failure?.retry ? '重试保存' : '确认并保存成卷'}</button></div></>;
  const hasDifferences = !!(summary?.differences?.length || summary?.unknown?.length);
  const hasTeacherIssues = !!(summary?.teacher?.issues?.length || summary?.scoringIssues?.length);
  return <Modal title="确认当前内容并保存成卷" onClose={onClose} busy={busy} className="paper-confirmation" footer={footer}>
    {loading ? <p role="status">正在检查试卷…</p> : <>
      {failure ? <div className="notice error" role="alert"><span>{failure.message}</span>{failure.status === 409 ? <button disabled={busy} onClick={onReload}>读取最新草稿</button> : null}</div> : null}
      {summary ? <>
        <div className="confirmation-facts"><div><span>题目</span><strong>{summary.student.questionCount} 题</strong></div>{summary.scoringMode !== 'none' ? <div><span>总分</span><strong>{summary.student.points} 分</strong></div> : null}</div>
        <p className="help">保存当前题目与顺序，之后仍可基于此卷继续编辑。</p>
        {!summary.student.complete ? <div className="notice warning">试卷仍有缺题，请检查后再使用。<Issues items={summary.student.missing}/></div> : null}
        {hasDifferences ? <details open><summary>需要留意的事项</summary><Issues items={summary.differences}/><Issues items={summary.unknown}/></details> : null}
        {hasTeacherIssues ? <details><summary>答案与评分待核对</summary><Issues items={summary.teacher.issues}/><Issues items={summary.scoringIssues}/></details> : null}
        {summary.requiresAcknowledgement ? <label className="check-item confirmation-ack"><input type="checkbox" checked={acknowledged} disabled={busy || !!payload.current} onChange={event => setAcknowledged(event.target.checked)}/><span>我已检查上述差异、未知与缺项，确认保存当前内容。</span></label> : null}
      </> : null}
    </>}
  </Modal>;
}

export function SavedPapers({ papers, warnings, onOpen, busy }) {
  return <div className="saved-drafts"><div className="section-heading"><h2>已保存成卷</h2><span className="muted">内容与资料版本已固定</span></div><Issues items={warnings} className="warning-text"/>{papers.length ? <ul>{papers.map(paper => <li key={paper.paperId}><div><strong>{paper.title}</strong><small>{new Date(paper.createdAt).toLocaleString('zh-CN')} · {paper.summary?.student?.questionCount ?? paper.stats?.selectedQuestions ?? '—'} 题{paper.summary?.scoringMode !== 'none' ? ` / ${paper.summary?.student?.points ?? paper.stats?.availablePoints ?? '—'} 分` : ''}</small></div><button disabled={busy} onClick={() => onOpen(paper.paperId)}>打开成卷</button></li>)}</ul> : <p className="empty-message">尚未保存成卷。检查当前草稿后可确认保存。</p>}</div>;
}

function FrozenStudent({ draft, title, kind = 'student', assets = [] }) {
  const scored = draft.baseline.requirements.scoringMode !== 'none';
  const teacher = kind === 'teacher';
  const purpose = draft.baseline.requirements.purpose;
  const teacherSections = [['answers', '参考答案'], ['solutions', '解析'], ...(scored ? [['scoringSuggestions', '评分参考']] : [])];
  return <section className="frozen-student" id="frozen-paper" aria-label={`${kindNames[kind]}题面预览`}>
    <h2>{title || draft.title || '试卷题面'}</h2>
    <p className="paper-sheet-meta">{kindNames[kind]}{purpose ? ` · ${purposeFor(purpose)?.label || '练习'}` : ''} · {draft.slots.length} 题 · {draft.baseline.requirements.durationMinutes} 分钟{scored ? ` · ${draft.slots.reduce((sum, slot) => sum + slot.points, 0)} 分` : ''}</p>
    {draft.slots.map((slot, index) => <article className="question" id={`frozen-question-${slot.number}`} key={slot.slotId}>
      {index === 0 || draft.slots[index - 1].questionType !== slot.questionType ? <h3>{typeTitles[slot.questionType]}</h3> : null}
      <div className="question-top"><span className="question-number" aria-label={`第 ${slot.number} 题`}>{slot.number}</span><div className="question-stem">{slot.question ? <MathText text={slot.question.student.stem}/> : <span className="missing-stem">【第 {slot.number} 题缺题面】</span>}</div>{scored ? <span className="question-points">（{slot.points} 分）</span> : null}</div>
      {slot.question ? <div className="question-content">
        <QuestionSource question={slot.question} manifest={draft.baseline.sourceManifest}/>
        {assets.filter(asset => asset.slotId === slot.slotId).map(asset => <img className="paper-question-image" key={asset.assetId} alt={asset.alt || '题目配图'} src={`data:${asset.mimeType};base64,${asset.dataBase64}`}/>)}
        <QuestionOptions options={slot.question.student.options}/>
        {slot.question.student.parts.map((part, partIndex) => <p className="question-part" key={part.partId}>（{partIndex + 1}）<MathText text={part.prompt}/>{scored ? <span className="part-points">（{slot.partPoints.find(item => item.partId === part.partId)?.points ?? '—'} 分）</span> : null}</p>)}
        {teacher ? <div className="paper-teacher-material" aria-label={`第 ${slot.number} 题教师资料`}>{purpose === 'diagnostic' ? <section className="paper-diagnostic-focus"><h4>考查重点</h4><p><MathText text={slot.taskLabel || '按本次确认范围检查学生作答'}/></p></section> : null}{teacherSections.map(([field, label]) => {
          const entries = slot.question.teacher?.[field]?.filter(entry => entry.text?.trim()) || [];
          return <section key={field}><h4>{label}</h4>{entries.length ? entries.map((entry, entryIndex) => <p key={entryIndex}>{entry.partId && entry.partId !== 'main' ? <span className="paper-answer-part">（{slot.question.student.parts.findIndex(part => part.partId === entry.partId) + 1 || entry.partId}）</span> : null}<MathText text={entry.text}/></p>) : <p className="warning-text">暂无{label}，需教师核对。</p>}</section>;
        })}</div> : null}
      </div> : null}
    </article>)}
  </section>;
}

function UserFeedback({ paperId, initialFeedback }) {
  const initial = initialFeedback?.latest || (initialFeedback?.willingToUse ? initialFeedback : null);
  const [record, setRecord] = useState(initial);
  const [willingToUse, setWillingToUse] = useState(initial?.willingToUse || '');
  const [reason, setReason] = useState(initial?.reason || '');
  const [manualCorrections, setManualCorrections] = useState(initial?.manualCorrections || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function save(event) {
    event.preventDefault();
    if (pending.current || !willingToUse) return;
    pending.current = true; setBusy(true); setError('');
    try { const response = await api(`/api/papers/${encodeURIComponent(paperId)}/feedback`, { willingToUse, reason, manualCorrections }); if (mounted.current) setRecord(response.feedback); }
    catch (failure) { if (mounted.current) setError(failure.message); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  return <section className="user-feedback"><h2>使用反馈</h2><p className="help">检查试卷后，记录使用感受和仍需调整的内容。</p>{record ? <div className="notice" role="status">已记录反馈：{{ yes: '愿意使用', after_changes: '修改后愿意使用', no: '暂不使用' }[record.willingToUse]}。{record.metrics?.replacementCount !== undefined ? `本次草稿换题 ${record.metrics.replacementCount} 次。` : ''}<small>记录于 {new Date(record.createdAt).toLocaleString('zh-CN')}</small></div> : <p className="feedback-pending">尚未记录反馈。</p>}<form onSubmit={save}><label className="field">是否愿意实际使用此卷？<Select required value={willingToUse} disabled={busy} onChange={event => setWillingToUse(event.target.value)}><option value="" disabled>请选择实际判断</option><option value="yes">愿意使用</option><option value="after_changes">修改后愿意使用</option><option value="no">暂不使用</option></Select></label><label className="field">原因与缺项（可选）<textarea value={reason} maxLength={2000} rows="3" disabled={busy} onChange={event => setReason(event.target.value)} placeholder="哪些题目、分值或输出细节仍需调整？"/></label><label className="field">手工修正记录（可选）<textarea value={manualCorrections} maxLength={2000} rows="2" disabled={busy} onChange={event => setManualCorrections(event.target.value)} placeholder="记录系统外补充或修正的内容"/></label>{error ? <p className="error-text" role="alert">{error}</p> : null}<div className="action-row"><button disabled={busy || !willingToUse}>{busy ? '正在保存反馈…' : record ? '更新我的实际反馈' : '保存我的实际反馈'}</button></div></form></section>;
}

export function Paper({ paper, initialOutputs = {}, initialFeedback = null, initialWarnings = [], onDerived }) {
  const [outputs, setOutputs] = useState(initialOutputs);
  const [activeKind, setActiveKind] = useState('student');
  const [previewKind, setPreviewKind] = useState(null);
  const [working, setWorking] = useState({});
  const [errors, setErrors] = useState({});
  const [deriving, setDeriving] = useState(false);
  const derivePayload = useRef(null);
  const deriveInFlight = useRef(false);
  const requests = useRef({});
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function generate(kind) {
    if (requests.current[kind]) return;
    const token = {}; requests.current[kind] = token;
    setWorking(current => ({ ...current, [kind]: true })); setErrors(current => ({ ...current, [kind]: null }));
    try {
      const response = await api(`/api/papers/${encodeURIComponent(paper.paperId)}/outputs/${kind}`, {});
      if (mounted.current && requests.current[kind] === token) setOutputs(current => ({ ...current, [kind]: response.output }));
    } catch (error) { if (mounted.current && requests.current[kind] === token) setErrors(current => ({ ...current, [kind]: error.message })); }
    finally { if (requests.current[kind] === token) { delete requests.current[kind]; if (mounted.current) setWorking(current => ({ ...current, [kind]: false })); } }
  }
  async function derive() {
    if (deriveInFlight.current) return;
    if (!derivePayload.current) derivePayload.current = { operationId: crypto.randomUUID() };
    deriveInFlight.current = true; setDeriving(true); setErrors(current => ({ ...current, derive: null }));
    try { const response = await api(`/api/papers/${encodeURIComponent(paper.paperId)}/derive`, derivePayload.current); if (mounted.current) onDerived(response.draft); }
    catch (error) { if (mounted.current) setErrors(current => ({ ...current, derive: error.message })); }
    finally { deriveInFlight.current = false; if (mounted.current) setDeriving(false); }
  }
  const summary = paper.summary;
  const output = outputs[activeKind];
  const label = kindNames[activeKind];
  const available = !!output?.downloadUrl && ['complete', 'incomplete'].includes(output.status);
  const attempted = output && output.status !== 'not_generated';
  const sources = Object.entries(kindNames)
    .filter(([kind]) => outputs[kind]?.downloadUrl && ['complete', 'incomplete'].includes(outputs[kind].status))
    .map(([kind, name]) => ({ kind, label: name, url: outputs[kind].downloadUrl, downloadUrl: outputs[kind].downloadUrl }));
  function switchKind(kind) {
    setActiveKind(kind);
    setPreviewKind(current => current && outputs[kind]?.downloadUrl && ['complete', 'incomplete'].includes(outputs[kind].status) ? kind : null);
  }
  function moveTab(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const kind = event.key === 'Home' ? 'student' : event.key === 'End' ? 'teacher' : activeKind === 'student' ? 'teacher' : 'student';
    switchKind(kind);
    event.currentTarget.parentElement.querySelector(`[data-paper-kind="${kind}"]`)?.focus();
  }
  return <div className="paper-result paper-workspace">
    {initialWarnings.length ? <div className="notice warning" role="status"><Issues items={initialWarnings}/></div> : null}
    <div className="paper-saved-line">
      <span>已保存</span>
      <span>{new Date(paper.createdAt).toLocaleString('zh-CN')}</span>
    </div>
    {!summary.student.complete ? <div className="notice warning" role="alert"><strong>试卷仍有缺题，请检查后再使用。</strong><Issues items={summary.student.missing}/></div> : null}
    <section className="paper-document" aria-label="已保存试卷">
      <div className="paper-document-toolbar">
        <div className="paper-version-tabs" role="tablist" aria-label="试卷版本">
          {Object.entries(kindNames).map(([kind, name]) => <button key={kind} id={`paper-tab-${kind}`} data-paper-kind={kind} type="button" role="tab" aria-selected={activeKind === kind} aria-controls="paper-document-panel" tabIndex={activeKind === kind ? 0 : -1} onKeyDown={moveTab} onClick={() => switchKind(kind)}>{name}</button>)}
        </div>
        <div className="paper-document-actions">
          {available ? <>
            <button type="button" onClick={() => setPreviewKind(current => current ? null : activeKind)}>{previewKind ? '返回题面' : '预览 PDF'}</button>
            <a className={output.layoutOutdated ? '' : 'primary'} href={output.downloadUrl} download>下载{label}</a>
          </> : null}
          {!available || output?.layoutOutdated ? <button className="primary" disabled={working[activeKind]} onClick={() => generate(activeKind)}>{working[activeKind] ? '正在生成 PDF…' : output?.layoutOutdated ? '更新 PDF 排版' : attempted || errors[activeKind] ? '重试生成 PDF' : `生成${label} PDF`}</button> : null}
        </div>
      </div>
      {working[activeKind] || output && output.status !== 'not_generated' ? <div className="paper-document-status" aria-live="polite">
        <span>{working[activeKind] ? '正在生成 PDF，可继续查看题面。' : outputNames[output.status] || output.status}</span>
        {output?.pages ? <span>A4 · {output.pages} 页</span> : null}
      </div> : null}
      {output?.layoutOutdated ? <p className="warning-text" role="status">已有文件使用旧版排版，更新后可下载新版。试卷内容保持固定。</p> : null}
      {output?.message ? <p className={output.status === 'failed' ? 'error-text' : 'help'}>{output.message}</p> : null}
      <Issues items={output?.issues} className="warning-text"/>
      {activeKind === 'teacher' && (!output || output.status === 'not_generated') ? <Issues items={summary.teacher.issues} className="warning-text"/> : null}
      {errors[activeKind] ? <p className="error-text" role="alert">{errors[activeKind]}。已保存的试卷和文件仍然保留。</p> : null}
      <div id="paper-document-panel" className="paper-document-panel" role="tabpanel" aria-labelledby={`paper-tab-${activeKind}`}>
        {previewKind ? <Suspense fallback={<p role="status">正在加载 PDF 预览器…</p>}><PdfPreview key={`${previewKind}-${outputs[previewKind]?.sha256}`} kind={previewKind} onKindChange={switchKind} onClose={() => setPreviewKind(null)} sources={sources}/></Suspense> : <>
          <FrozenStudent draft={paper.draft} title={paper.title} kind={activeKind} assets={paper.assets}/>
        </>}
      </div>
      <details className="paper-output-tools"><summary>文件与版本</summary>
        <p className="help">试卷内容与资料版本已固定 · 来源草稿修订 {paper.sourceRevision}</p>
        <button disabled={working[activeKind]} onClick={() => generate(activeKind)}>{working[activeKind] ? '正在生成…' : available ? `重新生成${label} PDF` : `生成${label} PDF`}</button>
        {output?.sha256 ? <p className="help">文件校验值 <code>{output.sha256}</code></p> : null}
        <button disabled={deriving} onClick={derive}>{deriving ? '正在创建新草稿…' : errors.derive ? '重试创建新草稿' : '基于此卷继续编辑'}</button>
        <p className="help">继续编辑会创建新草稿，保留当前成卷。</p>
        {errors.derive ? <p className="error-text" role="alert">{errors.derive}</p> : null}
      </details>
    </section>
    <div className="paper-secondary-content">
      {summary.differences?.length || summary.unknown?.length || summary.scoringIssues?.length ? <details className="paper-confirmed-issues"><summary>查看确认事项（{(summary.differences?.length || 0) + (summary.unknown?.length || 0) + (summary.scoringIssues?.length || 0)} 项）</summary><Issues items={summary.differences}/><Issues items={summary.unknown}/><Issues items={summary.scoringIssues}/></details> : null}
      <details className="paper-feedback-details"><summary>记录使用反馈</summary><UserFeedback paperId={paper.paperId} initialFeedback={initialFeedback}/></details>
    </div>
  </div>;
}
