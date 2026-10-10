import React, { useEffect, useRef, useState } from 'react';
import { api, typeTitles } from './api.js';
import { Modal } from './DraftEditor.jsx';
import { MathText } from './MathText.jsx';

const kindNames = { student: '学生版', teacher: '教师版' };
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
  return <Modal title="确认当前内容并保存成卷" onClose={onClose} busy={busy}>{loading ? <p role="status">正在核查当前内容与版本…</p> : <>{failure ? <div className="notice error" role="alert"><span>{failure.message}</span>{failure.status === 409 ? <button disabled={busy} onClick={onReload}>读取最新草稿</button> : null}</div> : null}{summary ? <><div className="confirmation-facts"><div><span>完整可作答题</span><strong>{summary.student.questionCount} 题</strong></div><div><span>有效分值</span><strong>{summary.student.points} 分</strong></div><div><span>确认修订</span><strong>{summary.revision}</strong></div></div><p className="help">保存当前题目、顺序、分值和资料版本。成卷后内容固定，后续调整需派生新草稿。</p>{!summary.student.complete ? <div className="notice warning">学生版未完整，缺题位置保留题号及明确占位。<Issues items={summary.student.missing}/></div> : null}<details open><summary>计划差异与适配未知</summary><Issues items={summary.differences}/><Issues items={summary.unknown}/>{!summary.differences?.length && !summary.unknown?.length ? <p className="help">没有额外差异或未知项。</p> : null}</details><details><summary>教师资料与本次评分待核对项</summary><Issues items={summary.teacher.issues}/><Issues items={summary.scoringIssues}/>{!summary.teacher.issues?.length && !summary.scoringIssues?.length ? <p className="help">没有记录的未满足项。</p> : null}</details>{summary.requiresAcknowledgement ? <label className="check-item confirmation-ack"><input type="checkbox" checked={acknowledged} disabled={busy || !!payload.current} onChange={event => setAcknowledged(event.target.checked)}/><span>我已检查上述差异、未知与缺项，确认保存当前内容。</span></label> : null}<div className="action-row"><button className="primary" disabled={busy || failure?.status === 409 || (summary.requiresAcknowledgement && !acknowledged)} onClick={confirm}>{busy ? '正在保存成卷…' : failure?.retry ? '重试同一确认' : '确认并保存成卷'}</button></div><p className="help">保存成卷后分别生成两版 PDF；保存成功不代表文件已生成。</p></> : <button onClick={onClose}>返回草稿</button>}</>}</Modal>;
}

export function SavedPapers({ papers, warnings, onOpen, busy }) {
  return <div className="saved-drafts"><div className="section-heading"><h2>已保存成卷</h2><span className="muted">内容与资料版本已固定</span></div><Issues items={warnings} className="warning-text"/>{papers.length ? <ul>{papers.map(paper => <li key={paper.paperId}><div><strong>{paper.title}</strong><small>{new Date(paper.createdAt).toLocaleString('zh-CN')} · {paper.summary?.student?.questionCount ?? paper.stats?.selectedQuestions ?? '—'} 题 / {paper.summary?.student?.points ?? paper.stats?.availablePoints ?? '—'} 分</small></div><button disabled={busy} onClick={() => onOpen(paper.paperId)}>打开成卷</button></li>)}</ul> : <p className="empty-message">尚未保存成卷。检查当前草稿后可确认保存。</p>}</div>;
}

function FrozenStudent({ draft }) {
  return <section className="frozen-student" id="frozen-paper"><h2>已确认的学生题面</h2><p className="help">两版 PDF 采用以下固定顺序和分值；此处只展示学生内容。</p>{draft.slots.map((slot, index) => <article className="question" id={`frozen-question-${slot.number}`} key={slot.slotId}>{index === 0 || draft.slots[index - 1].questionType !== slot.questionType ? <h3>{typeTitles[slot.questionType]}</h3> : null}<div className="question-top"><strong className="question-number">{slot.number}.</strong><div className="question-stem">{slot.question ? <MathText text={slot.question.student.stem}/> : <span className="missing-stem">【第 {slot.number} 题缺题面】</span>}</div><span className="question-points">（{slot.points} 分）</span></div>{slot.question ? <div className="question-content">{slot.question.student.options.map(option => <div className="option" key={option.label}><span>{option.label}.</span><MathText text={option.text}/></div>)}{slot.question.student.parts.map((part, partIndex) => <p className="question-part" key={part.partId}>（{partIndex + 1}）<MathText text={part.prompt}/><span className="part-points">（{slot.partPoints.find(item => item.partId === part.partId)?.points ?? '—'} 分）</span></p>)}</div> : null}</article>)}</section>;
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
  return <section className="user-feedback"><h2>当前用户实际使用反馈</h2><p className="help">打开两版文件并实际检查后，可以记录是否愿意使用。开发者检查不等于用户接受；未填写时保持待验证。</p>{record ? <div className="notice" role="status">已记录反馈：{{ yes: '愿意使用', after_changes: '修改后愿意使用', no: '暂不使用' }[record.willingToUse]}。{record.metrics?.replacementCount !== undefined ? `本次草稿换题 ${record.metrics.replacementCount} 次。` : ''}<small>记录于 {new Date(record.createdAt).toLocaleString('zh-CN')}</small></div> : <p className="feedback-pending">实际使用验证：待当前用户反馈。</p>}<form onSubmit={save}><label className="field">是否愿意实际使用此卷？<select required value={willingToUse} disabled={busy} onChange={event => setWillingToUse(event.target.value)}><option value="" disabled>请选择实际判断</option><option value="yes">愿意使用</option><option value="after_changes">修改后愿意使用</option><option value="no">暂不使用</option></select></label><label className="field">原因与缺项（可选）<textarea value={reason} maxLength={2000} rows="3" disabled={busy} onChange={event => setReason(event.target.value)} placeholder="哪些题目、分值或输出细节仍需调整？"/></label><label className="field">手工修正记录（可选）<textarea value={manualCorrections} maxLength={2000} rows="2" disabled={busy} onChange={event => setManualCorrections(event.target.value)} placeholder="记录系统外补充或修正的内容"/></label>{error ? <p className="error-text" role="alert">{error}</p> : null}<div className="action-row"><button disabled={busy || !willingToUse}>{busy ? '正在保存反馈…' : record ? '更新我的实际反馈' : '保存我的实际反馈'}</button></div></form></section>;
}

export function Paper({ paper, initialOutputs = {}, initialFeedback = null, initialWarnings = [], onDerived }) {
  const [outputs, setOutputs] = useState(initialOutputs);
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
  return <div className="paper-result">{initialWarnings.length ? <div className="notice warning" role="status"><Issues items={initialWarnings}/></div> : null}<div className="notice"><strong>成卷已保存，内容与版本固定。</strong><p>来源草稿修订 {paper.sourceRevision} · {new Date(paper.createdAt).toLocaleString('zh-CN')}</p></div><div className="paper-summary"><div className="confirmation-facts"><div><span>完整可作答题</span><strong>{summary.student.questionCount} 题</strong></div><div><span>有效分值</span><strong>{summary.student.points} 分</strong></div><div><span>学生题面</span><strong>{summary.student.complete ? '完整' : '未完整'}</strong></div></div><button disabled={deriving} onClick={derive}>{deriving ? '正在创建新草稿…' : errors.derive ? '重试派生新草稿' : '从此成卷派生新草稿'}</button>{errors.derive ? <p className="error-text" role="alert">{errors.derive}</p> : null}</div><section className="paper-output-section"><h2>分别生成两版 PDF</h2><p className="help">文件从同一成卷生成；一版失败不影响另一版。请打开文件检查 A4、公式、分页和解答留白。</p><div className="paper-outputs">{Object.entries(kindNames).map(([kind, label]) => { const output = outputs[kind]; const attempted = output && output.status !== 'not_generated'; return <article className="paper-output" key={kind}><h3>{label}</h3><p className={output?.status === 'failed' ? 'error-text' : output?.status === 'incomplete' ? 'warning-text' : 'output-status'}>{working[kind] ? '正在生成 PDF…' : output ? outputNames[output.status] || output.status : '尚未生成'}</p>{output?.message ? <p className="help">{output.message}</p> : null}<Issues items={output?.issues} className="help"/>{kind === 'teacher' && (!output || output.status === 'not_generated') ? <Issues items={summary.teacher.issues} className="help"/> : null}{errors[kind] ? <p className="error-text" role="alert">{errors[kind]}。已保存成卷及另一版结果保留。</p> : null}<div className="output-actions"><button disabled={working[kind]} onClick={() => generate(kind)}>{working[kind] ? '正在生成…' : attempted || errors[kind] ? `重新生成${label}` : `生成${label} PDF`}</button>{output && ['complete', 'incomplete'].includes(output.status) && output.downloadUrl ? <a href={output.downloadUrl} download>下载{label} PDF</a> : null}</div>{output?.pages ? <small className="help">A4 · {output.pages} 页</small> : null}{output?.sha256 ? <details className="output-identity"><summary>文件身份</summary><code>{output.sha256}</code></details> : null}</article>; })}</div></section><details className="paper-confirmed-issues"><summary>确认时的差异、未知及评分事项</summary><Issues items={summary.differences}/><Issues items={summary.unknown}/><Issues items={summary.scoringIssues}/></details><UserFeedback paperId={paper.paperId} initialFeedback={initialFeedback}/><FrozenStudent draft={paper.draft}/></div>;
}
