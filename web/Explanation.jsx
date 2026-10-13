import React, { lazy, Suspense } from 'react';
import './Explanation.css';

const MathText = lazy(() => import('./MathText.jsx').then(module => ({ default: module.MathText })));

function Text({ text }) {
  return text.includes('$') ? <Suspense fallback={text}><MathText text={text}/></Suspense> : text;
}

// Preserve the model's wording, warnings and formulas. Only sentence layout changes.
function explanationLines(text, omitLine) {
  const formulas = [];
  const protectedText = String(text || '').replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g, formula => {
    formulas.push(formula);
    return `\u0000math-${formulas.length - 1}\u0000`;
  });
  return protectedText.split(/\r?\n+/).filter(line => !omitLine || line.trim() !== omitLine)
    .flatMap(line => line.split(/(?<=[。！？；])\s*/))
    .map(line => line.replace(/\u0000math-(\d+)\u0000/g, (_, index) => formulas[Number(index)]).trim()
      .replace(/^\s*(?:[-*•]\s+|\d+[.)、]\s*)/, ''))
    .filter(Boolean);
}

export function Explanation({ text, omitLine, className = '' }) {
  const lines = explanationLines(text, omitLine);
  if (!lines.length) return null;
  return <ul className={`explanation-list ${className}`}>{lines.map((line, index) => {
    const label = line.match(/^(?:\*\*)?([\u4e00-\u9fff]{2,12})(?:\*\*)?[：:]\s*(.*)$/s);
    return <li key={index}>{label ? <><strong>{label[1]}</strong><span><Text text={label[2]}/></span></> : <Text text={line}/>}</li>;
  })}</ul>;
}
