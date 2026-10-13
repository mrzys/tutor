import React, { lazy, Suspense, useEffect, useState } from 'react';
import { ChevronRight, PencilLine } from 'lucide-react';
import { FloatingAssistant } from './FloatingAssistant.jsx';
import './AssemblyWorkbench.css';
import { purposeFor } from '../src/assembly/purposes.mjs';

const countLabels = [['single_choice', '单选'], ['fill_blank', '填空'], ['free_response', '解答']];
const AssemblyReview = lazy(() => import('./AssemblyReview.jsx').then(module => ({ default: module.AssemblyReview })));
const stages = [{ id: 'requirements', label: '需求' }, { id: 'blueprint', label: '题位规划' }, { id: 'draft', label: '试卷' }];

export function AssemblyWorkbench({ config, reviewConfig, requirements, confirmedRequirements, stage, plannedSlots, documentId, assistantOpen, assistantAnchor, onToggleAssistant, onEditRequirements, busy, assistant, children }) {
  const [reviewStage, setReviewStage] = useState(null);
  useEffect(() => setReviewStage(null), [stage, documentId]);
  const stageIndex = stages.findIndex(item => item.id === stage);
  const chapters = new Map((config?.chapters || []).map(chapter => [chapter.id, chapter.label]));
  const scope = (requirements?.mainScope || []).map(id => chapters.get(id) || id).join('、');
  const counts = countLabels.map(([key, label]) => [Number(requirements?.counts?.[key]), label])
    .filter(([count]) => Number.isFinite(count) && count >= 0);
  const count = counts.reduce((sum, [value]) => sum + value, 0);
  const duration = Number(requirements?.durationMinutes);
  const points = Number(requirements?.targetScore);
  const planning = ['blueprint', 'planning'].includes(stage);
  const summary = [requirements?.purpose ? purposeFor(requirements.purpose)?.label : null, scope,
    ...(planning ? [counts.length ? `${count} 题` : null, duration > 0 ? `${duration} 分钟` : null,
      requirements?.scoringMode === 'none' ? '不计分' : points > 0 ? `${points} 分` : null] : [])].filter(Boolean);

  return <section className="assembly-workbench" data-stage={stage} aria-label="组卷工作台">
    <header className="assembly-workbench-heading">
      <div>{['blueprint', 'draft'].includes(stage) ? <nav className="assembly-stage-nav" aria-label="组卷流程"><ol>{stages.map((item, index) => <li key={item.id}>
        {index > 0 ? <ChevronRight size={12} aria-hidden="true"/> : null}
        {index < stageIndex ? <button type="button" disabled={busy} aria-label={`查看已确认${item.label}`} onClick={() => setReviewStage(item.id)}>{item.label}</button> : <span aria-current={index === stageIndex ? 'step' : undefined}>{item.label}</span>}
      </li>)}</ol></nav> : null}
        <h1>{requirements?.title || '本次组卷'}</h1>
        {summary.length ? <p>{summary.join(' · ')}</p> : null}
      </div>
      {onEditRequirements ? <button type="button" className="assembly-assistant-trigger" title="返回修改范围、用途或题量，确认后重新规划" disabled={busy} onClick={onEditRequirements}><PencilLine size={15} aria-hidden="true"/>修改需求</button> : null}
    </header>
    <div className="assembly-workbench-body">
      <div className="assembly-workbench-product">{children}</div>
    </div>
    {reviewStage ? <Suspense fallback={<p role="status">正在加载确认记录…</p>}><AssemblyReview stage={reviewStage} config={reviewConfig || config} requirements={confirmedRequirements || requirements} slots={plannedSlots || []} onClose={() => setReviewStage(null)}/></Suspense> : null}
    <FloatingAssistant open={assistantOpen} anchor={assistantAnchor} onClose={onToggleAssistant}>{assistant}</FloatingAssistant>
  </section>;
}
