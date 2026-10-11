import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildCurriculumMap, parseLegacyPages, validateCurriculumMap } from '../scripts/check-curriculum-map.mjs';

const inventory = JSON.parse(fs.readFileSync(new URL('../docs/curriculum/inventory.json', import.meta.url), 'utf8'));
const snapshotSha256 = '1'.repeat(64);
const input = { snapshotSha256, questions: [{ questionId: 'fixture-question', contentVersion: 'content-v1', teacherVersion: 'teacher-v1',
  scopeEvidence: { primaryTopics: ['集合的确定性', 'unknown topic'] } }] };
const fixture = () => buildCurriculumMap(inventory, input);
const check = (knowledge, map) => validateCurriculumMap(knowledge, map, { inventory, questions: input.questions });

test('full legacy migration retains all 509 UIDs, 423 leaf mappings, five volumes, 589 unapproved evidence records', () => {
  const { knowledge, map } = fixture();
  assert.equal(check(knowledge, map).ok, true);
  assert.deepEqual(knowledge.knowledgePoints, inventory.queries.knowledgePoints.rows);
  assert.equal(map.mappings.length, 423);
  assert.equal(map.evidenceRecords.length, 589);
  assert.equal(map.evidenceRecords.some(evidence => evidence.status !== 'unverified'), false);
  assert.equal(map.mappings.some(mapping => mapping.status === 'confirmed'), false);
  assert.equal(map.questionMappings[0].primaryTopics[0].status, 'pending_uid_mapping');
  assert.deepEqual(map.questionMappings[0].primaryTopics[1].suggestedKpUids, []);
});

test('migration uses leaf metadata volume instead of misleading compulsory root label', () => {
  const { knowledge, map } = fixture();
  const selective = knowledge.knowledgePoints.find(kp => kp.is_leaf && kp.metadata_json.source_textbook === '选择性必修第二册');
  assert.equal(map.mappings.find(mapping => mapping.kpUid === selective.uid).textbookId, 'rja-selective-2');
  map.mappings.find(mapping => mapping.kpUid === selective.uid).textbookId = 'rja-compulsory-1';
  assert.equal(check(knowledge, map).ok, false);
});

test('integrity validation rejects missing leaves, duplicate UIDs, orphan parents and cycles', () => {
  for (const mutate of [
    ({ map }) => map.mappings.pop(),
    ({ knowledge }) => knowledge.knowledgePoints.push(structuredClone(knowledge.knowledgePoints[0])),
    ({ knowledge }) => { knowledge.knowledgePoints[1].parent_uid = 'missing'; },
    ({ knowledge }) => { knowledge.knowledgePoints[0].parent_uid = knowledge.knowledgePoints[1].uid; },
  ]) {
    const data = fixture(); mutate(data);
    assert.equal(check(data.knowledge, data.map).ok, false);
  }
});

test('old labels, original numeric/string pages and records cannot silently change or gain approval', () => {
  for (const mutate of [
    ({ knowledge }) => { knowledge.knowledgePoints[1].name = 'renamed'; },
    ({ map }) => { map.mappings[0].sourcePage.originalValue = '2'; },
    ({ map }) => { map.evidenceRecords[0].status = 'legacy_verified'; },
    ({ map }) => { map.mappings[0].status = 'confirmed'; },
    ({ map }) => { map.mappings.find(mapping => mapping.evidenceRefs.length).evidenceRefs.pop(); },
  ]) {
    const data = fixture(); mutate(data);
    assert.equal(check(data.knowledge, data.map).ok, false);
  }
});

test('legacy page parser preserves original string and refuses ambiguous or reversed ranges', () => {
  assert.deepEqual(parseLegacyPages(' 2–4、7 '), { originalValue: ' 2–4、7 ', originalText: ' 2–4、7 ', pages: [2, 3, 4, 7], status: 'parsed' });
  assert.deepEqual(parseLegacyPages(2), { originalValue: 2, originalText: '2', pages: [2], status: 'parsed' });
  for (const value of ['参考第2页', '4-2', '1-900', 0, null]) assert.equal(parseLegacyPages(value).status, 'unparsed');
});

test('catalog page containment offers node candidates without upgrading semantic coverage', () => {
  const textbooks = { books: [{ id: 'rja-compulsory-1', source: { sha256: '2'.repeat(64), pageCount: 270 }, printedPageOffset: 7,
    chapters: [{ id: 'rja-compulsory-1:1', printedPageStart: 1, sections: [
      { id: 'rja-compulsory-1:1.1', title: '集合的概念', printedPageStart: 2 },
      { id: 'rja-compulsory-1:1.2', title: '集合间的基本关系', printedPageStart: 7 },
    ] }] }] };
  const { map } = buildCurriculumMap(inventory, { ...input, textbooks, textbooksSha256: '3'.repeat(64) });
  const item = map.mappings.find(mapping => mapping.kpUid === 'M-K-01-112');
  assert.equal(item.textbookNodeCandidates[0].nodeId, 'rja-compulsory-1:1.1');
  assert.equal(item.status, 'unverified');
  assert.equal(item.textbookNodeCandidates[0].status, 'unverified');
  assert.equal(item.textbookSourceSha256, '2'.repeat(64));
});

test('question primary topic changes or content version changes require rebuilding mapping', () => {
  const { knowledge, map } = fixture();
  const changed = structuredClone(input.questions);
  changed[0].contentVersion = 'content-v2';
  assert.equal(validateCurriculumMap(knowledge, map, { inventory, questions: changed }).ok, false);
  changed[0].contentVersion = 'content-v1';
  changed[0].scopeEvidence.primaryTopics.push('extra topic');
  assert.equal(validateCurriculumMap(knowledge, map, { inventory, questions: changed }).ok, false);
});
