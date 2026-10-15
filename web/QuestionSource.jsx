import React from 'react';
import { questionSourcePresentation } from '../src/question-bank/source-label.mjs';
import { MathText } from './MathText.jsx';
import './QuestionSource.css';

export function QuestionSource({ question, manifest }) {
  const { source, label, caption } = questionSourcePresentation(question, manifest);
  return <span className="question-source" data-source-kind={source.kind} title={caption}>（{label}）</span>;
}

export function QuestionStem({ question, manifest }) {
  const { stem } = questionSourcePresentation(question, manifest);
  return <><QuestionSource question={question} manifest={manifest}/><MathText text={stem}/></>;
}
