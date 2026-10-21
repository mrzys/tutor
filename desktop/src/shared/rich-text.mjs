function cells(line) {
  const result = []; let cell = '', math = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && i + 1 < line.length) { cell += line[i] + line[++i]; continue; }
    if (line[i] === '$') {
      math = !math;
      if (line[i + 1] === '$') { cell += '$$'; i++; continue; }
    }
    if (line[i] === '|' && !math) { result.push(cell.trim()); cell = ''; } else cell += line[i];
  }
  result.push(cell.trim());
  if (line.trim().startsWith('|')) result.shift();
  if (line.trim().endsWith('|')) result.pop();
  return result;
}
function plainHtml(value) {
  return value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    // Formula comparisons can resemble HTML tags, e.g. $a<b>c$.
    // Strip markup only outside the same math delimiters used by MathText.
    .split(/(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)/g)
    .map((part, index) => index % 2 ? part : part.replace(/<br\s*\/?>/gi, '\n')
      .replace(/<!--[\s\S]*?-->|<\/?[a-z][\w:-]*(?:\s[^<>]*|\/)?>/gi, ''))
    .join('')
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|nbsp|quot|apos);/gi, (all, entity) => {
      const named = { amp: '&', lt: '<', gt: '>', nbsp: ' ', quot: '"', apos: "'" };
      if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? all;
      const number = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : all;
    });
}
function htmlRows(table) {
  return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(row =>
    [...row[1].matchAll(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi)].map(cell => {
      const span = key => Math.max(1, Math.min(20, Number(cell[2].match(new RegExp(`${key}\\s*=\\s*["']?(\\d+)`, 'i'))?.[1]) || 1));
      return { text: plainHtml(cell[3]), header: cell[1].toLowerCase() === 'th', colSpan: span('colspan'), rowSpan: span('rowspan') };
    })).filter(row => row.length);
}
export function paperTextBlocks(text = '') {
  const result = [];
  for (const part of String(text).split(/(<table\b[^>]*>[\s\S]*?<\/table>)/gi)) {
    if (!part) continue;
    if (/^<table\b/i.test(part)) {
      const rows = htmlRows(part);
      result.push(rows.length ? { type: 'table', rows } : { type: 'text', text: part }); continue;
    }
    const lines = part.split('\n'); let plain = [];
    const flush = () => { if (plain.length) result.push({ type: 'text', text: plain.join('\n') }); plain = []; };
    for (let i = 0; i < lines.length; i++) {
      const header = cells(lines[i]); const separator = i + 1 < lines.length ? cells(lines[i + 1]) : [];
      if (header.length > 1 && separator.length === header.length && separator.every(cell => /^:?-{3,}:?$/.test(cell))) {
        flush(); const rows = [header.map(text => ({ text, header: true }))]; i += 2;
        for (; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(cells(lines[i]).map(text => ({ text, header: false })));
        i--; result.push({ type: 'table', rows });
      } else plain.push(lines[i]);
    }
    flush();
  }
  return result;
}
