import { createHash } from 'node:crypto';

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined || (typeof value === 'number' && !Number.isFinite(value))) {
    throw new TypeError('Canonical JSON requires finite JSON values.');
  }
  return encoded;
}

export function hashContent(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
