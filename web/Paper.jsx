import { Select } from './Select.jsx';
import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ClipboardCheck, Eye, FilePenLine, LoaderCircle, MessageSquare } from 'lucide-react';
import { api } from './api.js';
import { Modal } from './DraftEditor.jsx';
import { PaperSheet } from './PaperSheet.jsx';
import { ExamPreview } from './ExamPreview.jsx';
import './Paper.css';
import './ExamLabels.css';
import './PaperHeaderActions.css';
import { WorkbenchHeaderActions } from './WorkbenchHeaderActions.jsx';

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
  const footer = <div className="action-row"><button disabled={busy} onClick={onClose}>返回调整</button><button className="primary" disabled={loading || !summary || busy || !!failure && !failure.retry || (summary?.requiresAcknowledgement && !acknowledged)} onClick={confirm}>{busy ? '正在保存成卷…' : failure?.retry ? '重试保存' : '确认并保存成卷'}</button></div>;
  const hasDifferences = !!(summary?.differences?.length || summary?.unknown?.length);
  const hasTeacherIssues = !!(summary?.teacher?.issues?.length || summary?.scoringIssues?.length);
  return <Modal title="确认成卷" onClose={onClose} busy={busy} className="paper-confirmation" footer={footer}>
    {loading ? <p role="status">正在检查试卷…</p> : <>
      {failure ? <div className="notice error" role="alert"><span>{failure.message}</span>{failure.status === 409 ? <button disabled={busy} onClick={onReload}>读取最新草稿</button> : null}</div> : null}
      {summary ? <>
        <div className="confirmation-facts"><div><span>题目</span><strong>{summary.student.questionCount} 题</strong></div>{summary.scoringMode !== 'none' ? <div><span>总分</span><strong>{summary.student.points} 分</strong></div> : null}</div>
        <p className="help">确认后可预览、下载学生卷和教师卷。</p>
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

function UserFeedback({ paperId, initialFeedback, onSaved, onBusyChange }) {
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
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  async function save(event) {
    event.preventDefault();
    if (pending.current || !willingToUse) return;
    pending.current = true; setBusy(true); setError('');
    try { const response = await api(`/api/papers/${encodeURIComponent(paperId)}/feedback`, { willingToUse, reason, manualCorrections }); if (mounted.current) { setRecord(response.feedback); onSaved?.(response.feedback); } }
    catch (failure) { if (mounted.current) setError(failure.message); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  return <section className="user-feedback"><h2>使用反馈</h2><p className="help">检查试卷后，记录使用感受和仍需调整的内容。</p>{record ? <div className="notice" role="status">已记录反馈：{{ yes: '愿意使用', after_changes: '修改后愿意使用', no: '暂不使用' }[record.willingToUse]}。{record.metrics?.replacementCount !== undefined ? `本次草稿换题 ${record.metrics.replacementCount} 次。` : ''}<small>记录于 {new Date(record.createdAt).toLocaleString('zh-CN')}</small></div> : <p className="feedback-pending">尚未记录反馈。</p>}<form onSubmit={save}><label className="field">是否愿意实际使用此卷？<Select required value={willingToUse} disabled={busy} onChange={event => setWillingToUse(event.target.value)}><option value="" disabled>请选择实际判断</option><option value="yes">愿意使用</option><option value="after_changes">修改后愿意使用</option><option value="no">暂不使用</option></Select></label><label className="field">原因与缺项（可选）<textarea aria-label="原因与缺项（可选）" value={reason} maxLength={2000} rows="3" disabled={busy} onChange={event => setReason(event.target.value)} placeholder="哪些题目、分值或输出细节仍需调整？"/></label><label className="field">手工修正记录（可选）<textarea aria-label="手工修正记录（可选）" value={manualCorrections} maxLength={2000} rows="2" disabled={busy} onChange={event => setManualCorrections(event.target.value)} placeholder="记录系统外补充或修正的内容"/></label>{error ? <p className="error-text" role="alert">{error}</p> : null}<div className="action-row"><button disabled={busy || !willingToUse}>{busy ? '正在保存反馈…' : record ? '更新我的实际反馈' : '保存我的实际反馈'}</button></div></form></section>;
}

export function Paper({ paper, initialOutputs = {}, initialFeedback = null, initialWarnings = [], onDerived }) {
  const [outputs, setOutputs] = useState(initialOutputs);
  const [activeKind, setActiveKind] = useState('student');
  const [previewKind, setPreviewKind] = useState(null);
  const [working, setWorking] = useState({});
  const [errors, setErrors] = useState({});
  const [deriving, setDeriving] = useState(false);
  const [panel, setPanel] = useState(null);
  const [feedback, setFeedback] = useState(initialFeedback);
  const [feedbackBusy, setFeedbackBusy] = useState(false);
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
    try {
      const [response] = await Promise.all([
        api(`/api/papers/${encodeURIComponent(paper.paperId)}/derive`, derivePayload.current),
        new Promise(resolve => setTimeout(resolve, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180)),
      ]);
      if (mounted.current) onDerived(response.draft);
    }
    catch (error) { if (mounted.current) setErrors(current => ({ ...current, derive: error.message })); }
    finally { deriveInFlight.current = false; if (mounted.current) setDeriving(false); }
  }
  const summary = paper.summary;
  const confirmationCount = (summary.differences?.length || 0) + (summary.unknown?.length || 0) + (summary.scoringIssues?.length || 0);
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
    <WorkbenchHeaderActions><div className="paper-header-actions" role="group" aria-label="试卷操作">
      <button type="button" onClick={() => setPanel('preview')}><Eye size={16} aria-hidden="true"/>预览</button>
      <button type="button" disabled={deriving} title="创建新草稿，保留当前成卷" onClick={() => setPanel('derive')}><FilePenLine size={16} aria-hidden="true"/>{deriving ? '创建中…' : errors.derive ? '重试编辑' : '继续编辑'}</button>
      {confirmationCount ? <button type="button" onClick={() => setPanel('issues')}><ClipboardCheck size={16} aria-hidden="true"/>确认事项<span className="paper-action-count">（{confirmationCount}）</span></button> : null}
      <button type="button" onClick={() => setPanel('feedback')}><MessageSquare size={16} aria-hidden="true"/>反馈</button>
    </div></WorkbenchHeaderActions>
    {initialWarnings.length ? <div className="notice warning" role="status"><Issues items={initialWarnings}/></div> : null}
    {errors.derive && panel !== 'derive' ? <p className="error-text" role="alert">{errors.derive}。请点击“重试编辑”。</p> : null}
    {!summary.student.complete ? <div className="notice warning" role="alert"><strong>试卷仍有缺题，请检查后再使用。</strong><Issues items={summary.student.missing}/></div> : null}
    <section className={`paper-document${deriving ? ' is-deriving' : ''}`} aria-label="已保存试卷">
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
          <PaperSheet draft={paper.draft} title={paper.title} kind={activeKind} assets={paper.assets}/>
        </>}
      </div>
    </section>
    {panel === 'preview' ? <ExamPreview draft={paper.draft} title={paper.title} assets={paper.assets ?? []} initialKind={activeKind} onClose={() => setPanel(null)}/> : null}
    {panel === 'derive' ? <Modal title="继续编辑" className="paper-edit-prompt" busy={deriving} onClose={() => setPanel(null)} footer={<>
      <button type="button" disabled={deriving} onClick={() => setPanel(null)}>取消</button>
      <button type="button" className="primary" disabled={deriving} onClick={derive}>{deriving ? <><LoaderCircle size={16} className="spinning" aria-hidden="true"/>正在创建…</> : errors.derive ? '重试' : '确认'}</button>
    </>}>
      <p>创建一份可编辑的草稿，原试卷和 PDF 保留。</p>
      {deriving ? <p className="help" role="status">正在打开编辑页面…</p> : null}
      {errors.derive ? <p className="error-text" role="alert">{errors.derive}</p> : null}
    </Modal> : null}
    {panel === 'issues' ? <Modal title="已确认事项" onClose={() => setPanel(null)}><Issues items={summary.differences}/><Issues items={summary.unknown}/><Issues items={summary.scoringIssues}/></Modal> : null}
    {panel === 'feedback' ? <Modal title="反馈" className="paper-feedback-dialog" busy={feedbackBusy} onClose={() => setPanel(null)}><UserFeedback paperId={paper.paperId} initialFeedback={feedback} onSaved={setFeedback} onBusyChange={setFeedbackBusy}/></Modal> : null}
  </div>;
}
