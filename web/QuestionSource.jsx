import React from 'react';
import { questionSource, sourceCaption } from '../src/question-bank/source-label.mjs';
import './QuestionSource.css';

export function QuestionSource({ question, manifest }) {
  const source = questionSource(question, manifest);
  return source.embedded ? null : <p className="question-source" data-source-kind={source.kind}>{sourceCaption(source)}</p>;
}
