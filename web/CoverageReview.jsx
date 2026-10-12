import React, { useRef, useState, useEffect } from 'react';
import { Sparkles } from 'lucide-react';
import { MathText } from './MathText.jsx';
import { api } from './api.js';
import { currentCoverageReview } from '../src/assembly/coverage-state.mjs';

const labels = { covered: '有题面支持', partial: '部分涉及', missing: '尚未涉及', unknown: '证据不足' };
export function CoverageReview({ draft, onChange, disabled }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  useEffect(() => { request.current++; setBusy(false); setError(''); }, [draft.draftId]);
  useEffect(() => () => { request.current++; }, []);
  const review = currentCoverageReview(draft);
  const checks = review?.status === 'complete' ? review.checks : [];
  const gaps = checks.filter(check => check.status !== 'covered');
  async function reviewCoverage() {
    const token = ++request.current; setBusy(true); setError('');
    try {
      const result = await api(`/api/drafts/${draft.draftId}/coverage`, { expectedRevision: draft.revision ?? 0 });
      const current = latestDraft.current;
      if (request.current === token && current.draftId === result.draft.draftId && !current.confirmedPaperId
        && (result.draft.revision ?? 0) >= (current.revision ?? 0)) onChange(result.draft);
    } catch (err) { if (request.current === token) setError(err.message); }
    finally { if (request.current === token) setBusy(false); }
  }
  return <section className="coverage-review" aria-label="目标覆盖检查" aria-busy={busy}>
    <div className="coverage-heading"><strong><Sparkles size={14} aria-hidden="true"/>目标覆盖检查<span className="coverage-optional">可选</span></strong>
      {!draft.confirmedPaperId ? <button className="link-button" disabled={busy || disabled} onClick={reviewCoverage}>{busy ? 'AI 正在检查…' : review || draft.coverageReview ? '重新检查' : 'AI 检查目标覆盖'}</button> : null}</div>
    <p className="help" role="status">{busy ? '正在对照考查目标阅读题面，完成后显示建议。' : review?.status === 'complete' ? gaps.length ? `有 ${gaps.length} 项需要留意，展开查看调整建议。` : '本次检查为各项目标找到了题面支持，供教师核对。' : draft.coverageReview && !review ? '题目或需求已调整，可按需重新检查。' : review?.reason ?? '按需检查试卷是否涉及考查目标，不影响查看、调整或保存试卷。'}</p>
    {review || busy ? <p className="help">仅评估目标覆盖，不替代题库导入审核。</p> : null}
    {gaps.length ? <ul className="coverage-gaps">{gaps.slice(0, 3).map((check, index) => <li key={index}><span>{labels[check.status]} · <MathText text={check.requirement}/></span></li>)}{gaps.length > 3 ? <li>另有 {gaps.length - 3} 项，展开查看。</li> : null}</ul> : null}
    {checks.length ? <details><summary>查看缺口与题面依据（{checks.length} 项）</summary>{checks.map((check, index) => <div className="coverage-check" key={index}><strong>{labels[check.status]} · <MathText text={check.requirement}/></strong><p><MathText text={check.rationale}/></p>{check.suggestion ? <p><MathText text={check.suggestion}/></p> : null}{check.evidence.length ? <p className="help">依据：{[...new Set(check.evidence.map(item => draft.slots.find(slot => slot.slotId === item.slotId)?.number).filter(Boolean))].map(number => <a href={`#question-${number}`} key={number}>第 {number} 题</a>)}</p> : null}</div>)}</details> : null}
    {error ? <p className="error-text" role="alert">{error}</p> : null}
  </section>;
}
