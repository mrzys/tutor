import React from 'react';
import { Modal } from './DraftEditor.jsx';
import { MathText } from './MathText.jsx';
import { purposeFor } from '../src/assembly/purposes.mjs';
import { typeTitles } from './api.js';

// Reviewing a completed stage never opens an editable blueprint or changes the paper.
export function AssemblyReview({ stage, config, requirements, slots, onClose }) {
  const planning = stage === 'blueprint';
  const chapters = new Map(config.chapters.map(chapter => [chapter.id, chapter.label]));
  const scored = requirements.scoringMode !== 'none';
  return <Modal title={planning ? '已确认题位规划' : '已确认需求'} onClose={onClose}>
    {planning ? <div className="assembly-plan-review">
      <p className="help">查看确认时的安排，试卷编辑以当前题目为准。</p>
      {['single_choice', 'fill_blank', 'free_response'].map(type => {
        const items = slots.filter(slot => slot.questionType === type);
        return items.length ? <section key={type}><h3>{typeTitles[type]} <span>{items.length} 题</span></h3><ol>{items.map(slot => <li key={slot.slotId}>
          <span className="assembly-review-number">{slot.number}</span><span className="assembly-review-task"><MathText text={slot.taskLabel || config.tasks.find(task => task.id === slot.taskId)?.label || '未指定考查任务'}/></span>{scored ? <span className="muted">{slot.points} 分</span> : null}
        </li>)}</ol></section> : null;
      })}
    </div> : <dl className="assembly-requirements-review">
      <div><dt>组卷用途</dt><dd>{purposeFor(requirements.purpose)?.label || requirements.goal}</dd></div>
      <div><dt>考查范围</dt><dd>{requirements.mainScope.map(id => chapters.get(id) || id).join('、')}</dd></div>
      <div><dt>题量与时长</dt><dd>{Object.values(requirements.counts).reduce((sum, count) => sum + count, 0)} 题 · {requirements.durationMinutes} 分钟 · {scored ? `${requirements.targetScore} 分` : '不计分'}</dd></div>
      {(requirements.teachingGoals || []).length ? <div><dt>考查目标</dt><dd><ul>{requirements.teachingGoals.map(goal => <li key={goal.id}><MathText text={goal.observable}/></li>)}</ul></dd></div> : null}
      {requirements.teacherRequest ? <div><dt>教师要求</dt><dd><MathText text={requirements.teacherRequest}/></dd></div> : null}
    </dl>}
  </Modal>;
}
