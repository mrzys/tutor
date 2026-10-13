// The three legacy curated IDs refer specifically to the verified sections of
// 人教 A 版必修第一册. Other books and short IDs are deliberately left intact.
const legacySections = Object.freeze({
  '1.1': 'rja-compulsory-1:1.1',
  '1.2': 'rja-compulsory-1:1.2',
  '1.3': 'rja-compulsory-1:1.3',
});

export function canonicalSectionId(id) {
  return Object.hasOwn(legacySections, id) ? legacySections[id] : id;
}

export function includesSection(scope, id) {
  return Array.isArray(scope) && scope.some(value => canonicalSectionId(value) === canonicalSectionId(id));
}

export function scopesOverlap(a, b) {
  return Array.isArray(a) && a.some(id => includesSection(b, id));
}
