import { scanTeachingDisplay } from './teaching-format-recovery.mjs';

const escaped = (text, i) => {
  let slashes = 0;
  while (i > 0 && text[--i] === '\\') slashes++;
  return slashes % 2 === 1;
};

function normalizeString(text) {
  let output = '', open = null, replacements = 0;
  for (let i = 0; i < text.length; i++) {
    if (!escaped(text, i)) {
      if (open?.close && text.startsWith(open.close, i)) {
        output += open.output;
        i += open.close.length - 1;
        open = null;
        replacements++;
        continue;
      }
      if (!open && (text.startsWith('\\(', i) || text.startsWith('\\[', i))) {
        const display = text[i + 1] === '[';
        const delimiter = display ? '$$' : '$';
        output += delimiter;
        open = { close: display ? '\\]' : '\\)', output: delimiter };
        i++;
        replacements++;
        continue;
      }
      if (text[i] === '$') {
        const delimiter = text[i + 1] === '$' ? '$$' : '$';
        if (!open) open = { dollar: delimiter };
        else if (open.dollar === delimiter) open = null;
        output += delimiter;
        i += delimiter.length - 1;
        continue;
      }
    }
    output += text[i];
  }
  return { text: output, replacements };
}

/** Pure rendering adaptation: paired delimiters only; no JSON, math or wording repair. */
export function normalizeTeachingDisplay(result) {
  const copy = structuredClone(result);
  const scan = scanTeachingDisplay(copy);
  if (scan.findings.length) return { result: copy, changes: [], blockedBy: scan.findings };
  const changes = [];
  const field = (owner, key, fieldPath) => {
    if (typeof owner?.[key] !== 'string') return;
    const normalized = normalizeString(owner[key]);
    if (normalized.replacements) {
      owner[key] = normalized.text;
      changes.push({ fieldPath, kind: 'paired_math_delimiters_to_dollars', delimitersReplaced: normalized.replacements });
    }
  };
  field(copy, 'answer', 'answer');
  field(copy.difficultyAssessment, 'basis', 'difficultyAssessment.basis');
  field(copy, 'teachingSolution', 'teachingSolution');
  field(copy.teachingFocus, 'examFocus', 'teachingFocus.examFocus');
  for (let i = 0; i < (copy.teachingFocus?.studentRequirements?.length ?? 0); i++) field(copy.teachingFocus.studentRequirements, i, `teachingFocus.studentRequirements[${i}]`);
  for (let i = 0; i < (copy.issues?.length ?? 0); i++) field(copy.issues, i, `issues[${i}]`);
  return { result: copy, changes, blockedBy: [] };
}
