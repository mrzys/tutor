import React, { memo } from 'react';
import katex from 'katex';

const mathPattern = /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)/g;
export const MathText = memo(function MathText({ text = '', readableFractions = false }) {
  const parts = String(text).split(mathPattern);
  return <>{parts.map((part, index) => {
    if (!part.startsWith('$') || !part.endsWith('$') || part.length < 3) return <React.Fragment key={index}>{part}</React.Fragment>;
    const displayMode = part.startsWith('$$');
    const expression = part.slice(displayMode ? 2 : 1, displayMode ? -2 : -1);
    const renderedExpression = readableFractions ? expression.replace(/\\(?:t?frac)(?![A-Za-z])/g, '\\dfrac') : expression;
    const html = katex.renderToString(renderedExpression, { throwOnError: false, trust: false, strict: 'warn', displayMode });
    return <span key={index} className={displayMode ? 'math-display' : 'math-inline'} dangerouslySetInnerHTML={{ __html: html }} />;
  })}</>;
});
