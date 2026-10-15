import React from 'react';
import { MathText } from './MathText.jsx';
import { paperTextBlocks } from './paper-tables.js';

export function PaperRichText({ text, readableFractions = false }) {
  return paperTextBlocks(text).map((block, index) => block.type === 'table'
    ? <div className="paper-table-scroll" key={index}><table><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, column) => {
      const Cell = cell.header ? 'th' : 'td';
      return <Cell key={column} colSpan={cell.colSpan} rowSpan={cell.rowSpan}><MathText text={cell.text} readableFractions={readableFractions}/></Cell>;
    })}</tr>)}</tbody></table></div>
    : <span className="paper-rich-text" key={index}><MathText text={block.text} readableFractions={readableFractions}/></span>);
}
