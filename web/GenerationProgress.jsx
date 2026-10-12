import React, { useEffect, useState } from 'react';
import { Check, LoaderCircle, Square, Sparkles, CircleAlert } from 'lucide-react';
import { typeLabels } from './api.js';
import './GenerationProgress.css';

const stages = [
  { id: 'retrieving', label: '查找候选', detail: '按蓝图范围和题位要求查找题库。' },
  { id: 'comparing', label: 'AI 比较', detail: '分批比较候选题与考查目标的匹配情况。' },
  { id: 'combining', label: '去重组合', detail: '汇总候选排名，去重并组合试卷。' },
  { id: 'saving', label: '保存草稿', detail: '保存选题结果并加载试卷。' },
];

export function GenerationProgress({ selection, onCancel, onRetry, onRule }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!selection) return;
    const update = () => setElapsed(Math.max(0, Math.floor(((selection.endedAt || Date.now()) - selection.startedAt) / 1000)));
    update();
    if (selection.status !== 'loading') return;
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [selection?.status, selection?.startedAt, selection?.endedAt]);
  if (!selection) return null;
  const loading = selection.status === 'loading';
  const progress = selection.progress || { stage: 'retrieving' };
  const active = Math.max(0, stages.findIndex(stage => stage.id === progress.stage));
  const title = loading ? '正在生成试卷' : selection.status === 'cancelled' ? '已停止生成' : '生成未完成';
  const batches = progress.batches || [];
  return <section className="generation-progress" aria-label="试卷生成进展">
    <div className="generation-progress-heading">
      <div className="generation-progress-title" role={selection.status === 'error' ? 'alert' : 'status'}>
        {loading ? <LoaderCircle size={19} className="spinning" aria-hidden="true"/> : <CircleAlert size={19} aria-hidden="true"/>}
        <strong>{title}</strong><span className="generation-elapsed" aria-live="off">已用 {elapsed} 秒</span>
      </div>
      {loading && <button type="button" className="generation-stop" onClick={onCancel}><Square size={13}/>停止</button>}
    </div>
    <ol className="generation-stages" aria-label="生成阶段">
      {stages.map((stage, index) => {
        const skipped = selection.mode === 'rule' && stage.id === 'comparing';
        const done = index < active && !skipped;
        const current = index === active;
        return <li key={stage.id} className={`${current ? 'is-current' : done ? 'is-complete' : ''} ${skipped ? 'is-skipped' : ''}`} aria-current={current ? 'step' : undefined}>
          <span className="generation-stage-marker">{done ? <Check size={13} aria-hidden="true"/> : index + 1}</span>
          <span>{stage.label}{skipped && <small>跳过</small>}</span>
        </li>;
      })}
    </ol>
    <p className="generation-detail" role="status">{loading ? stages[active].detail : selection.error || '蓝图已保留，可以继续选题。'}</p>
    {batches.length > 0 && <div className="generation-batches" aria-label="候选比较批次">
      <span className="generation-batch-summary">已完成 {progress.completedBatches ?? batches.filter(batch => batch.status === 'complete').length} / {progress.totalBatches ?? batches.length} 批</span>
      {batches.map(batch => <span key={batch.batchId} className={`generation-batch ${batch.status}`}>
        {batch.status === 'complete' ? <Check size={13} aria-hidden="true"/> : batch.status === 'running' && loading ? <LoaderCircle size={13} className="spinning" aria-hidden="true"/> : <span className="generation-batch-dot"/>}
        {typeLabels[batch.questionType] || batch.questionType} · {batch.slotCount} 题
        <small>{batch.status === 'complete' ? '完成' : !loading ? '未完成' : batch.status === 'running' ? '比较中' : '等待'}</small>
      </span>)}
    </div>}
    {!loading && <div className="generation-recovery"><button type="button" onClick={onRetry}><Sparkles size={15}/>重试 AI 选题</button><button type="button" onClick={onRule}>改用规则选题</button></div>}
  </section>;
}
