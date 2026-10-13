import React, { useEffect, useState } from 'react';
import { MathText } from './MathText.jsx';
import { supplyPresentation } from './question-supply.js';
import { questionSource, sourceCaption } from '../src/question-bank/source-label.mjs';

const cognitionLabels = { understand: '理解与解释', apply: '应用与操作', reason: '推理与论证', unspecified: '未指定' };

export function QuestionSummary({ slot, draft, supply, expanded = false }) {
  const [open, setOpen] = useState(expanded);
  const [analysis, setAnalysis] = useState(null);
  const question = slot.question;
  useEffect(() => {
    setAnalysis(null);
    if (!open || !question) return;
    let disposed = false;
    // Producer analysis is reference material only, never evidence for automatic selection.
    import('../data/pedagogy/set-questions-analysis.json').then(module => {
      const match = module.default.questions.find(item => item.questionId === question.questionId
        && item.sourceContext.contentVersion === question.contentVersion
        && item.sourceContext.teacherVersion === question.teacherVersion);
      if (!disposed) setAnalysis(match ?? null);
    }).catch(() => { if (!disposed) setAnalysis(null); });
    return () => { disposed = true; };
  }, [open, question]);
  const goals = (draft.baseline.requirements.teachingGoals ?? []).filter(goal => (slot.goalIds ?? []).includes(goal.id));
  const topics = question?.scopeEvidence?.primaryTopics?.join('、') || slot.taskLabel;
  const availability = supplyPresentation(supply);
  const path = slot.applicability ? slot.applicability.allowedSolutionPath : slot.selection?.selectedReason?.allowedSolutionPath;
  const solutionExample = path?.basis || question?.scopeEvidence?.allowedSolution;
  const body = <div className="question-summary-body">
      <dl className="question-profile">
        <div><dt>题目来源</dt><dd>{sourceCaption(questionSource(question, draft.baseline.sourceManifest))}</dd></div>
        <div><dt>考查内容</dt><dd><MathText text={topics}/></dd></div>
        <div><dt>题位任务</dt><dd><MathText text={slot.taskLabel}/></dd></div>
        <div><dt>题目难度</dt><dd>未标定{Number.isFinite(slot.targetDifficulty ?? draft.baseline.requirements.targetDifficulty) ? ` · 目标 ${(slot.targetDifficulty ?? draft.baseline.requirements.targetDifficulty).toFixed(2)}` : ''}</dd></div>
        <div><dt>换题余量</dt><dd className={supply?.error ? 'warning-text' : undefined}>{availability.detail}{availability.exhausted ? <small>可查看差异建议，或调整本题要求后重新检索。</small> : null}</dd></div>
      </dl>
      {analysis ? <div className="pedagogy-reference"><p className="profile-label">教研参考 · 待独立复核，不计作已满足目标</p><dl className="question-profile">
        <div><dt>认知要求</dt><dd>{analysis.cognitiveRequirement.level.replace(/\s*\([^)]*\)\s*$/, '')}</dd></div>
        <div><dt>可观察能力</dt><dd>{analysis.observableAbilities.map(item => item.activity).join('；') || '未知'}</dd></div>
        <div><dt>核心素养</dt><dd>{analysis.coreLiteracy.primary || '未知'}</dd></div>
      </dl><details className="profile-reference"><summary>查看教研判定依据</summary><p>{analysis.cognitiveRequirement.evidence}</p>{analysis.observableAbilities.map((item, index) => <p key={index}>{item.activity}：{item.evidence}</p>)}<p>{analysis.coreLiteracy.evidence}</p></details></div> : <p className="help">认知、能力与核心素养：尚无与当前题目版本绑定的可展示分析，保持未知。</p>}
      {goals.length ? <div className="profile-goals"><p className="profile-label">教师要求 · 与上方题目分析分别核对</p>{goals.map(goal => <p key={goal.id}>{goal.observable} · {cognitionLabels[goal.cognition]} · {goal.priority === 'required' ? '必须满足' : '尽量满足'}{goal.abilities.length ? ` · 能力：${goal.abilities.join('、')}` : ''}{goal.literacies.length ? ` · 素养：${goal.literacies.join('、')}` : ''}<small>题目支持情况尚未证实</small></p>)}</div> : null}
      {solutionExample ? <details className="profile-reference"><summary>{path ? '学生可用解法示例' : '解法参考 · 适用性待核对'}（含答案信息）</summary><p><MathText text={solutionExample}/></p><p className="help">至少有一条能用已学知识与本次允许方法完成的完整解法即可。教师解析可保留其他解法，不要求与本示例一致。</p></details> : null}
      {slot.locked ? <p className="help">本题已锁定：批量自动换题跳过；仍可直接调整要求或手动换题。</p> : null}
    </div>;
  return expanded ? <section className="question-summary"><h3>题目摘要</h3>{body}</section>
    : <details className="question-summary" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary><strong>题目摘要</strong><span><MathText text={topics}/></span></summary>{body}</details>;
}
