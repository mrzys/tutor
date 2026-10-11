import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildBodyMap } from '../scripts/check-curriculum-body-map.mjs';

function fixture() {
  const text = Buffer.from('把研究对象统称为元素。把一些元素组成的总体叫做集合。');
  const textSha256 = createHash('sha256').update(text).digest('hex');
  return { knowledge: { catalogVersion: 'v1', knowledgePoints: [
    { uid: 'group', name: '集合', is_leaf: false, parent_uid: null },
    { uid: 'element', name: '元素', definition: '研究对象', is_leaf: true, parent_uid: 'group' },
    { uid: 'set', name: '集合', definition: '元素的总体', is_leaf: true, parent_uid: 'group' },
  ] }, textbooks: { books: [{ id: 'book', source: { sha256: 'source-v1' },
    pages: [{ pdfPage: 9, printedPage: 2, textSha256, localTextPath: 'page.txt' }],
    chapters: [{ id: 'ch1', printedPageStart: 1, sections: [{ id: 's1', title: '集合的概念', printedPageStart: 2 }] }],
  }] }, migration: { mappings: ['element', 'set'].map(kpUid => ({ kpUid, textbookId: 'book', sourcePage: { pages: [2] } })) },
  bundles: [{ catalogVersion: 'v1', items: ['element', 'set'].map(uid => ({ uid, bookId: 'book', relation: 'introduces',
    definitionSha256: createHash('sha256').update(uid === 'element' ? '研究对象' : '元素的总体').digest('hex'),
    status: 'text_evidence_matched', reviewStatus: 'pending_review', evidence: [{ pdfPage: 9, printedPage: 2,
      textSha256, quote: uid === 'element' ? '把研究对象统称为元素。' : '把一些元素组成的总体叫做集合。', matchReason: '正文直接给出定义。' }] })) }],
  readText: () => text };
}

test('body evidence covers all leaves, derives groups and keeps teacher review separate', () => {
  const result = buildBodyMap(fixture());
  assert.equal(result.summary.text_evidence_matched, 2);
  assert.equal(result.summary.teacherReviewed, 0);
  assert.equal(result.groups[0].relation, 'derived_from_descendants');
  assert.deepEqual(result.groups[0].leafUids, ['element', 'set']);
  assert.equal(result.mappings[0].chapterSectionCandidates[0].sectionId, 's1');
});

test('missing or duplicated leaves cannot masquerade as complete coverage', () => {
  for (const mutation of [f => f.bundles[0].items.pop(), f => { f.bundles[0].items[1].uid = 'element'; }]) {
    const f = fixture(); mutation(f); assert.throws(() => buildBodyMap(f));
  }
});

test('wrong book, page, text version and fabricated quotes are rejected', () => {
  for (const mutation of [
    i => { i.bookId = 'wrong'; },
    i => { i.definitionSha256 = 'old'; },
    i => { i.evidence[0].pdfPage = 10; },
    i => { i.evidence[0].printedPage = 3; },
    i => { i.evidence[0].textSha256 = 'old'; },
    i => { i.evidence[0].quote = 'This text was not in the textbook.'; },
  ]) {
    const f = fixture(); mutation(f.bundles[0].items[0]); assert.throws(() => buildBodyMap(f));
  }
  const f = fixture(); f.readText = () => Buffer.from('modified page'); assert.throws(() => buildBodyMap(f));
  const version = fixture(); version.bundles[0].catalogVersion = 'v0'; assert.throws(() => buildBodyMap(version));
});

test('no evidence and teacher approval cannot silently become semantic matches', () => {
  const f = fixture(); f.bundles[0].items[0].evidence = [];
  assert.throws(() => buildBodyMap(f));
  f.bundles[0].items[0].status = 'not_found';
  assert.equal(buildBodyMap(f).summary.not_found, 1);
  f.bundles[0].items[0].reviewStatus = 'reviewed';
  assert.throws(() => buildBodyMap(f));
});

test('chapter review evidence is retained without assigning it to the final section', () => {
  const f = fixture();
  for (const item of f.bundles[0].items) item.evidence[0].contentContext = 'chapter_review';
  const result = buildBodyMap(f);
  assert.equal(result.mappings[0].evidence.length, 1);
  assert.equal(result.sectionMappings[0].knowledgeUids.length, 0);
  assert.equal(result.summary.sectionsWithBodyLinks, 0);
});

test('legacy dependency and related references preserve raw values without becoming approved prerequisites', () => {
  const f = fixture();
  f.knowledge.knowledgePoints[1].metadata_json = { prerequisites: ['set'], related_to: [{ uid: 'set', relation_type: '配套' }] };
  const result = buildBodyMap(f);
  assert.equal(result.knowledgeRelations.length, 2);
  assert.equal(result.knowledgeRelations[0].status, 'legacy_unverified');
  assert.deepEqual(result.knowledgeRelations[1].originalValue, { uid: 'set', relation_type: '配套' });
  f.knowledge.knowledgePoints[1].metadata_json.prerequisites.push('missing');
  assert.throws(() => buildBodyMap(f));
  f.knowledge.knowledgePoints[1].metadata_json.prerequisites.pop();
  f.knowledge.knowledgePoints[2].metadata_json = { prerequisites: ['element'] };
  assert.throws(() => buildBodyMap(f));
});

test('catalog gaps can belong to a chapter but must retain real page evidence', () => {
  const f = fixture();
  f.bundles[0].sectionCoverageGaps = [{ chapterId: 'ch1', title: 'Gap', evidence: [structuredClone(f.bundles[0].items[0].evidence[0])] }];
  assert.equal(buildBodyMap(f).sectionCoverageGaps[0].bookId, 'book');
  f.bundles[0].sectionCoverageGaps[0].evidence[0].quote = 'fabricated';
  assert.throws(() => buildBodyMap(f));
});

test('visual checks bind a rendered file to the exact PDF source and page', () => {
  const f = fixture();
  f.bundles[0].items[0].visualEvidence = [{ pdfPage: 9, printedPage: 2, sourceSha256: 'source-v1',
    renderPath: 'render.png', renderSha256: f.textbooks.books[0].pages[0].textSha256 }];
  assert.equal(buildBodyMap(f).mappings.length, 2);
  f.bundles[0].items[0].visualEvidence[0].sourceSha256 = 'other-pdf';
  assert.throws(() => buildBodyMap(f));
  f.bundles[0].items[0].visualEvidence[0].sourceSha256 = 'source-v1';
  f.bundles[0].items[0].visualEvidence[0].renderSha256 = 'tampered-image';
  assert.throws(() => buildBodyMap(f));
});
