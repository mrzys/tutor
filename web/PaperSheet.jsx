import React, { useState } from 'react';
import { typeTitles } from './api.js';
import { MathText } from './MathText.jsx';
import { QuestionOptions } from './QuestionOptions.jsx';
import { QuestionSource } from './QuestionSource.jsx';
import { questionSourcePresentation } from '../src/question-bank/source-label.mjs';
import { purposeFor } from '../src/assembly/purposes.mjs';
import { PaperRichText } from './PaperRichText.jsx';
import './Paper.css';
import './ExamLabels.css';
const kindNames = { student: '学生卷', teacher: '教师卷' };
function groupQuestionCount(slots, start) {
  const next = slots.findIndex((slot, index) => index > start && slot.questionType !== slots[start].questionType);
  return (next < 0 ? slots.length : next) - start;
}
function PaperImage({ asset }) {
  const [failed, setFailed] = useState(false);
  return failed ? <p className="paper-preview-missing-image" role="alert">配图无法显示：{asset.alt || '题目配图'}</p>
    : <img className="paper-question-image" alt={asset.alt || '题目配图'} src={`data:${asset.mimeType};base64,${asset.dataBase64}`} onError={() => setFailed(true)}/>;
}
export function PaperSheet({ draft, title, kind = 'student', assets = [], idPrefix = 'frozen' }) {
  const scored = draft.baseline.requirements.scoringMode !== 'none';
  const teacher = kind === 'teacher';
  const purpose = draft.baseline.requirements.purpose;
  const teacherSections = [['answers', '参考答案'], ['solutions', '解析'], ...(scored ? [['scoringSuggestions', '评分参考']] : [])];
  return <section className="frozen-student" id={`${idPrefix}-paper`} aria-label={`${kindNames[kind]}题面预览`}>
    <h2>{title || draft.title || '试卷题面'}</h2>
    <p className="paper-sheet-meta">{kindNames[kind]}{purpose ? ` · ${purposeFor(purpose)?.label || '练习'}` : ''} · {draft.slots.length} 题 · {draft.baseline.requirements.durationMinutes} 分钟{scored ? ` · ${draft.slots.reduce((sum, slot) => sum + slot.points, 0)} 分` : ''}</p>
    {draft.slots.map((slot, index) => <article className="question" id={`${idPrefix}-question-${slot.number}`} key={slot.slotId}>
      {index === 0 || draft.slots[index - 1].questionType !== slot.questionType ? <h3>{typeTitles[slot.questionType]}<span className="question-type-count">{groupQuestionCount(draft.slots, index)} 题</span></h3> : null}
      <div className="question-top"><span className="question-number" aria-label={`第 ${slot.number} 题`}>{slot.number}.</span><div className="question-stem">{slot.question ? <><QuestionSource question={slot.question} manifest={draft.baseline.sourceManifest}/><PaperRichText text={questionSourcePresentation(slot.question, draft.baseline.sourceManifest).stem}/></> : <span className="missing-stem">【第 {slot.number} 题缺题面】</span>}</div>{scored ? <span className="question-points">（{slot.points} 分）</span> : null}</div>
      {slot.question ? <div className="question-content">
        {assets.filter(asset => asset.slotId === slot.slotId).map(asset => <PaperImage key={`${asset.assetId}:${asset.sha256}`} asset={asset}/>)}
        {(slot.question.student.assets ?? []).filter(asset => !assets.some(image => image.slotId === slot.slotId && image.assetId === asset.assetId)).map(asset => <p key={asset.assetId} className="paper-preview-missing-image">【配图待加载：{asset.alt || '题目配图'}】</p>)}
        <QuestionOptions options={slot.question.student.options} renderText={PaperRichText}/>
        {slot.question.student.parts.map((part, partIndex) => <div className="question-part" key={part.partId}>（{partIndex + 1}）<PaperRichText text={part.prompt}/>{scored ? <span className="part-points">（{slot.partPoints.find(item => item.partId === part.partId)?.points ?? '—'} 分）</span> : null}</div>)}
        {teacher ? <div className="paper-teacher-material" aria-label={`第 ${slot.number} 题教师资料`}>{purpose === 'diagnostic' ? <section className="paper-diagnostic-focus"><h4>考查重点</h4><p><MathText text={slot.taskLabel || '按本次确认范围检查学生作答'}/></p></section> : null}{teacherSections.map(([field, label]) => {
          const entries = slot.question.teacher?.[field]?.filter(entry => entry.text?.trim()) || [];
          return <section key={field}><h4>{label}</h4>{entries.length ? entries.map((entry, entryIndex) => <div className="paper-material-entry" key={entryIndex}>{entry.partId && entry.partId !== 'main' ? <span className="paper-answer-part">（{slot.question.student.parts.findIndex(part => part.partId === entry.partId) + 1 || entry.partId}）</span> : null}<PaperRichText text={entry.text}/></div>) : <p className="warning-text">暂无{label}，需教师核对。</p>}</section>;
        })}</div> : null}
      </div> : null}
    </article>)}
  </section>;
}
