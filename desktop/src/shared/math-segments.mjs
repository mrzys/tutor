const escaped = (text, at) => {
  let n = 0;
  while (at > 0 && text[--at] === '\\') n++;
  return n % 2 === 1;
};

/** Read-only math tokenization shared by preview, tables and PDF.
 * @returns {Array<{type:'text',raw:string}|{type:'math',raw:string,source:string,displayMode:boolean}>}
 */
export function mathSegments(value) {
  const text = String(value ?? ''), out = [];
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    if (escaped(text, i)) continue;
    const open = text.startsWith('$$', i) ? '$$' : text[i] === '$' ? '$'
      : text.startsWith('\\(', i) ? '\\(' : text.startsWith('\\[', i) ? '\\[' : null;
    if (!open) continue;
    const close = open === '\\(' ? '\\)' : open === '\\[' ? '\\]' : open;
    let end = i + open.length;
    for (; end < text.length; end++) {
      if (open === '$' && text[end] === '\n') break;
      if (!escaped(text, end) && text.startsWith(close, end)
        && !(close === '$' && (text[end + 1] === '$' || text[end - 1] === '$'))) break;
    }
    if (end >= text.length || !text.startsWith(close, end) || end === i + open.length) continue;
    if (i > from) out.push({ type: 'text', raw: text.slice(from, i) });
    const after = end + close.length;
    out.push({ type: 'math', raw: text.slice(i, after), source: text.slice(i + open.length, end), displayMode: open === '$$' || open === '\\[' });
    from = after;
    i = after - 1;
  }
  if (from < text.length || !out.length) out.push({ type: 'text', raw: text.slice(from) });
  return out;
}
