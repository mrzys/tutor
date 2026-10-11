import React from 'react';
import { PencilLine } from 'lucide-react';
import { FloatingAssistant } from './FloatingAssistant.jsx';
import './AssemblyWorkbench.css';

const countLabels = [['single_choice', '单选'], ['fill_blank', '填空'], ['free_response', '解答']];
const stageLabels = { blueprint: '选题蓝图', planning: '正在规划蓝图', draft: '试卷草稿', paper: '已确认试卷' };

export function AssemblyWorkbench({ config, requirements, stage, assistantOpen, assistantAnchor, onToggleAssistant, onEditRequirements, busy, assistant, children }) {
  const chapters = new Map((config?.chapters || []).map(chapter => [chapter.id, chapter.label]));
  const scope = (requirements?.mainScope || []).map(id => chapters.get(id) || id).join('、');
  const counts = countLabels.map(([key, label]) => [Number(requirements?.counts?.[key]), label])
    .filter(([count]) => Number.isFinite(count) && count >= 0);
  const count = counts.reduce((sum, [value]) => sum + value, 0);
  const duration = Number(requirements?.durationMinutes);
  const points = Number(requirements?.targetScore);
  const summary = [scope, counts.length ? `${count} 题` : null,
    duration > 0 ? `${duration} 分钟` : null,
    requirements?.scoringMode === 'none' ? '不计分' : points > 0 ? `${points} 分` : null].filter(Boolean);

  return <section className="assembly-workbench" data-stage={stage} aria-label="组卷工作台">
    <header className="assembly-workbench-heading">
      <div><span className="assembly-workbench-stage">{stageLabels[stage] || '组卷工作台'}</span>
        <h1>{requirements?.title || '本次组卷'}</h1>
        {summary.length ? <p>{summary.join(' · ')}</p> : null}
      </div>
      {onEditRequirements ? <button type="button" className="assembly-assistant-trigger" disabled={busy} onClick={onEditRequirements}><PencilLine size={15} aria-hidden="true"/>修改需求</button> : null}
    </header>
    <div className="assembly-workbench-body">
      <div className="assembly-workbench-product">{children}</div>
    </div>
    <FloatingAssistant open={assistantOpen} anchor={assistantAnchor} onClose={onToggleAssistant}>{assistant}</FloatingAssistant>
  </section>;
}
