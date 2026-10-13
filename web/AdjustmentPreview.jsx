import React from 'react';
import { MathText } from './MathText.jsx';
import { typeLabels } from './api.js';

// Show the actual proposed operations before the teacher commits them.
export function AdjustmentPreview({ actions = [], slots = [], config }) {
  const taskLabel = id => config.tasks.find(task => task.id === id)?.label || id;
  return <ul className="adjustment-preview" aria-label="待应用的具体修改">{actions.map((action, index) => {
    const targets = (action.numbers || []).map(number => slots.find(slot => slot.number === number)).filter(Boolean);
    const numbers = action.numbers?.map(number => `第 ${number} 题`).join('、');
    let label, before, after;
    switch (action.type) {
      case 'set_task':
        label = `${numbers} · 修改考查任务`;
        before = targets.map(slot => slot.taskLabel || taskLabel(slot.taskId)).join('；');
        after = taskLabel(action.taskId); break;
      case 'replace': label = `${numbers} · 更换题目`; after = action.taskId ? `按「${taskLabel(action.taskId)}」寻找备选` : '保留考查要求，寻找其他合格题目'; break;
      case 'delete': label = `${numbers} · 删除题位`; after = '删除后重新编号'; break;
      case 'add': label = `新增 ${action.count} 题`; after = `${taskLabel(action.taskId)}${action.afterNumber ? `，放在第 ${action.afterNumber} 题后` : ''}`; break;
      case 'set_counts':
        label = '调整题型数量';
        before = Object.entries(typeLabels).filter(([type]) => ['single_choice', 'fill_blank', 'free_response'].includes(type)).map(([type, name]) => `${name} ${slots.filter(slot => slot.questionType === type).length} 题`).join(' · ');
        after = Object.entries(action.counts).map(([type, count]) => `${typeLabels[type] || type} ${count} 题`).join(' · '); break;
      case 'difficulty': label = `${numbers} · 修改难度目标`; after = `${action.targetDifficulty}（目标偏好，不会直接换题）`; break;
      case 'allow_premise': label = '调整解题条件'; after = `允许使用${config.premises.find(item => item.id === action.premiseId)?.label || action.premiseId}`; break;
      default: return null;
    }
    return <li key={index}><strong>{label}</strong>{before ? <div className="adjustment-before"><span>原安排</span><MathText text={before}/></div> : null}<div className="adjustment-after"><span>{before ? '改为' : '处理方式'}</span><MathText text={after}/></div></li>;
  })}</ul>;
}
