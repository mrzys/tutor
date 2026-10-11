import React, { useLayoutEffect, useRef, useState } from 'react';
import { MathText } from './MathText.jsx';

const columnGap = 24;

function Option({ option, measuring = false }) {
  return <div className={`option${measuring ? ' option-measure' : ''}`}>
    <span>{option.label}.</span><div className="option-text"><MathText text={option.text} readableFractions/></div>
  </div>;
}

export function QuestionOptions({ options }) {
  const containerRef = useRef(null);
  const probeRef = useRef(null);
  const [layout, setLayout] = useState({ columns: 1, width: undefined });

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !probeRef.current) return;
    const probes = [...probeRef.current.children];
    let disposed = false;
    const measure = () => {
      if (disposed) return;
      const available = container.clientWidth;
      const widest = Math.ceil(Math.max(0, ...probes.map(probe => probe.getBoundingClientRect().width))) + 8;
      const candidates = options.some(option => option.text.includes('$$')) ? [1] : [4, 2, 1];
      const next = candidates.find(count => count <= options.length && widest * count + columnGap * (count - 1) <= available) || 1;
      const width = next === 1 ? undefined : Math.max(140, widest) * next + columnGap * (next - 1);
      setLayout(current => current.columns === next && current.width === width ? current : { columns: next, width });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    probes.forEach(probe => observer.observe(probe));
    document.fonts?.ready.then(measure);
    return () => { disposed = true; observer.disconnect(); };
  }, [options]);

  if (!options.length) return null;
  return <div className="options-layout" ref={containerRef}>
    <div className="options options-adaptive" role="group" aria-label="选项" data-columns={layout.columns} style={{ gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`, maxWidth: layout.width, columnGap }}>
      {options.map(option => <Option key={option.label} option={option}/>)}
    </div>
    <div className="option-width-probe" aria-hidden="true" inert ref={probeRef}>
      {options.map(option => <Option key={option.label} option={option} measuring/>)}
    </div>
  </div>;
}
