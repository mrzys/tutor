import { readFileSync } from 'node:fs';

// Fixed notation grammar, not dictionary-supplied regex. Only third/higher
// derivatives trigger by notation; differentiating a derivative is allowed.
// A power on its own is ordinary algebra; require complete differential operands.
const differential = String.raw`(?:d|\\mathrm\s*\{\s*d\s*\}|\\mathrm\s+d)`;
const derivativeOrder = String.raw`(?:\{\s*(?:[3-9]|[1-9][0-9]+)\s*\}|[3-9]|[1-9][0-9]+)`;
const dependentFunction = String.raw`(?:[A-Za-z]|\\[A-Za-z]+)(?:\s*_\s*(?:\{[A-Za-z0-9]+\}|[A-Za-z0-9]))?(?:\s*\([^{}()\r\n]{0,80}\))?`;
const latexDerivativeFraction = String.raw`\\(?:frac|dfrac|tfrac)\s*\{\s*${differential}\s*\^\s*${derivativeOrder}\s*(?:${dependentFunction})?\s*\}\s*\{\s*${differential}\s*(?:[A-Za-z]|\\[A-Za-z]+)\s*\^\s*${derivativeOrder}\s*\}`;
const unicodeDerivativeFraction = String.raw`${differential}[³⁴⁵⁶⁷⁸⁹]\s*(?:${dependentFunction})?\s*/\s*${differential}\s*(?:[A-Za-z]|\\[A-Za-z]+)[³⁴⁵⁶⁷⁸⁹]`;
const derivativeFraction = new RegExp(`${latexDerivativeFraction}|${unicodeDerivativeFraction}`, 'gu');
// Both operands must explicitly be vectors; ordinary scalar multiplication
// and dot products do not grant a special-method finding.
const vectorOperand = String.raw`\\(?:overrightarrow|vec)\s*\{\s*[A-Za-z][A-Za-z0-9]{0,11}\s*\}`;
const vectorCrossProduct = new RegExp(`${vectorOperand}\\s*\\\\times\\s*${vectorOperand}`, 'gu');

// The dictionary is data only: literal terms and names from this fixed matcher
// allowlist. Never evaluate dictionary strings or compile them as regex/code.
const MATCHERS = Object.freeze({
  'modulo-number': /模\s*\$?\s*\d+(?:\s*\$)?/gu,
  'modulo-notation': /\\(?:pmod|bmod)(?![A-Za-z])|[（(]\s*mod\s+[^()（）\r\n]{1,32}[)）]/giu,
  'operation-closure': /(?:对|关于)\s*(?:加法|乘法|加、乘法|加法和乘法|加法与乘法|加法、乘法)\s*(?:运算)?\s*封闭/gu,
  'phi-notation': /\\Phi(?![A-Za-z])|(?<![A-Za-z\\])Phi(?![A-Za-z])|Φ/gu,
  'limit-notation': /\\lim(?![A-Za-z])|(?<![A-Za-z\\])lim(?![A-Za-z])/gu,
  'epsilon-delta-argument': /(?:取|任意|给定|设)[^。；\r\n]{0,160}(?:\\(?:varepsilon|epsilon)(?:[^A-Za-z]|$)|[εϵ])[^。；\r\n]{0,240}(?:存在|取)[^。；\r\n]{0,80}(?:\\delta(?:[^A-Za-z]|$)|δ)/gu,
  'integral-notation': /\\(?:int|iint|iiint|oint)(?![A-Za-z])|[∫∮]/gu,
  'english-classroom-method': /(?<![A-Za-z])(?:telescoping|geometric\s+series|infinite\s+series|integration\s+constant)(?![A-Za-z])/giu,
  'higher-derivative-primes': /(?<![A-Za-z\\])(?:[A-Za-z]|\\[A-Za-z]+)(?:_\s*(?:\{[A-Za-z0-9]+\}|[A-Za-z0-9]))?\s*(?:(?:['′]{3}|['′]{1,2}″|″['′″‴⁗]|['′]{0,2}[‴⁗])['′″‴⁗]*|\^\s*\{\s*\\prime\s*\\prime\s*\\prime(?:\s*\\prime)*\s*\})/gu,
  'higher-derivative-order': /(?<![A-Za-z\\])(?:[A-Za-z]|\\[A-Za-z]+)\s*\^\s*\{\s*\(\s*(?:[3-9]|[1-9]\d+)\s*\)\s*\}/gu,
  'higher-derivative-fraction': derivativeFraction,
  'vector-cross-product': vectorCrossProduct,
  'infinite-sum-notation': /(?:\\sum(?![A-Za-z])|[∑Σ])\s*(?:\\limits\s*)?(?:_\s*(?:\{[^{}\r\n]{1,80}\}|[A-Za-z0-9=]+)\s*)?(?:\^\s*\{?\s*\+?\s*(?:\\infty(?![A-Za-z])|∞)|∞)/gu,
  'endpoint-limit-shorthand': /(?<![A-Za-z\\])(?:[A-Za-z]|\\[A-Za-z]+)\s*(?:\\left\s*)?\(\s*(?:(?:[+-]?\d+(?:\.\d+)?|[a-zA-Z])\s*(?:[+-]|\^\s*(?:\{\s*[+-]\s*\}|[+-]))|[+-]?\s*(?:\\infty(?![A-Za-z])|∞))\s*(?:\\right\s*)?\)/gu,
});

function loadDictionary() {
  const raw = JSON.parse(readFileSync(new URL('../resources/teaching-term-triggers.json', import.meta.url), 'utf8'));
  if (typeof raw.version !== 'string' || !raw.version || !Array.isArray(raw.rules)) {
    throw new TypeError('Invalid teaching term dictionary');
  }
  const ids = new Set();
  const categories = new Set(['classroom', 'special_tool', 'context']);
  for (const rule of raw.rules) {
    if (typeof rule.id !== 'string' || !rule.id || ids.has(rule.id)
      || !categories.has(rule.category) || typeof rule.guidance !== 'string' || !rule.guidance
      || !Array.isArray(rule.terms) || rule.terms.some(term => typeof term !== 'string' || !term)
      || (rule.matchers !== undefined && (!Array.isArray(rule.matchers)
        || rule.matchers.some(name => !Object.hasOwn(MATCHERS, name) && name !== 'contextual-congruence')))) {
      throw new TypeError('Invalid teaching term dictionary rule');
    }
    ids.add(rule.id);
    Object.freeze(rule.terms);
    if (rule.matchers) Object.freeze(rule.matchers);
    Object.freeze(rule);
  }
  Object.freeze(raw.rules);
  return Object.freeze(raw);
}

const DICTIONARY = loadDictionary();

// Capture the exact immutable dictionary used by this process for audit.
export function teachingTermDictionarySnapshot() {
  return structuredClone(DICTIONARY);
}

function generatedFields(result) {
  const fields = [];
  const add = (fieldPath, value) => {
    if (typeof value === 'string') fields.push({ fieldPath, value });
  };
  add('answer', result?.answer);
  add('difficultyAssessment.basis', result?.difficultyAssessment?.basis);
  add('teachingSolution', result?.teachingSolution);
  add('teachingFocus.examFocus', result?.teachingFocus?.examFocus);
  if (Array.isArray(result?.teachingFocus?.studentRequirements)) {
    result.teachingFocus.studentRequirements.forEach((value, index) => {
      add(`teachingFocus.studentRequirements[${index}]`, value);
    });
  }
  return fields;
}

function congruencePositions(value) {
  const candidates = [];
  // ≡ may mean an identity. Only a same-sentence explicit modular context
  // makes the symbol a review trigger; the scanner still makes no verdict.
  for (const match of value.matchAll(/≡|\\equiv(?![A-Za-z])/gu)) {
    const left = value.slice(0, match.index).search(/[^。！？!?\n]*$/u);
    const rightBreak = value.slice(match.index).search(/[。！？!?\n]/u);
    const sentence = value.slice(left, rightBreak < 0 ? value.length : match.index + rightBreak);
    if (/同余|模\s*\$?\s*\d+|\\(?:pmod|bmod)(?![A-Za-z])|[（(]\s*mod\s+/iu.test(sentence)) {
      candidates.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return candidates;
}

function ruleMatches(value, rule) {
  const candidates = [];
  for (const term of rule.terms) {
    let start = value.indexOf(term);
    while (start >= 0) {
      candidates.push({ start, end: start + term.length });
      start = value.indexOf(term, start + term.length);
    }
  }
  for (const name of rule.matchers ?? []) {
    if (name === 'contextual-congruence') {
      candidates.push(...congruencePositions(value));
    } else {
      // matchAll clones the fixed global regex and does not mutate its state.
      for (const match of value.matchAll(MATCHERS[name])) {
        candidates.push({ start: match.index, end: match.index + match[0].length });
      }
    }
  }
  // Prefer the longest spelling in an overlap (e.g. 非平凡解/平凡解,
  // 整数线性表示/线性表示); distinct occurrences remain observable.
  candidates.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const selected = [];
  for (const candidate of candidates) {
    if (!selected.some(other => candidate.start < other.end && other.start < candidate.end)) {
      selected.push(candidate);
    }
  }
  return selected.sort((a, b) => a.start - b.start);
}

/**
 * Scan only generated classroom fields. A finding is a review trigger, not a
 * curriculum/validity verdict. No source text is rewritten or normalized.
 * start/end are zero-based UTF-16 code-unit offsets (end exclusive), exactly
 * compatible with originalField.slice(start, end), including emoji and LaTeX.
 */
export function scanTeachingTerms(result) {
  const fields = generatedFields(result);
  const findings = [];
  for (const { fieldPath, value } of fields) {
    const fieldFindings = [];
    for (const rule of DICTIONARY.rules) {
      for (const { start, end } of ruleMatches(value, rule)) {
        fieldFindings.push({
          ruleId: rule.id,
          category: rule.category,
          term: value.slice(start, end),
          fieldPath,
          start,
          end,
          excerpt: value.slice(Math.max(0, start - 40), Math.min(value.length, end + 40)),
          guidance: rule.guidance,
        });
      }
    }
    fieldFindings.sort((a, b) => a.start - b.start || b.end - a.end || a.ruleId.localeCompare(b.ruleId));
    findings.push(...fieldFindings);
  }
  return {
    dictionaryVersion: DICTIONARY.version,
    findings,
    scannedFields: fields.map(({ fieldPath }) => fieldPath),
  };
}
