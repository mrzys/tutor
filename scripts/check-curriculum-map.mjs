import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inventoryPath = 'docs/curriculum/inventory.json';
const bookIds = { '必修第一册': 'rja-compulsory-1', '必修第二册': 'rja-compulsory-2',
  '选择性必修第一册': 'rja-selective-1', '选择性必修第二册': 'rja-selective-2', '选择性必修第三册': 'rja-selective-3' };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const curriculumHash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const bytesHash = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = target => JSON.parse(fs.readFileSync(path.join(root, target), 'utf8'));

export function parseLegacyPages(value) {
  const originalText = value === null || value === undefined ? '' : String(value);
  const text = originalText.trim().replace(/[–—－]/g, '-');
  if (!/^\d+(?:\s*-\s*\d+)?(?:\s*[,，、]\s*\d+(?:\s*-\s*\d+)?)*$/.test(text)) return { originalValue: value ?? null, originalText, pages: [], status: 'unparsed' };
  const pages = [];
  for (const range of text.split(/[,，、]/)) {
    const [start, end = start] = range.split('-').map(Number);
    if (start < 1 || end < start || end - start > 100) return { originalValue: value, originalText, pages: [], status: 'unparsed' };
    for (let page = start; page <= end; page++) pages.push(page);
  }
  return { originalValue: value, originalText, pages: [...new Set(pages)].sort((a, b) => a - b), status: 'parsed' };
}

// These are explicit migration suggestions for the existing local topic labels.
// They do not approve a question's primary knowledge or any ability/literacy tag.
const topicSuggestions = {
  '集合的确定性': ['M-K-01-112'],
  '辨析确定性、无序性和重复元素计数': ['M-K-01-112'],
  '辨析对象能否构成集合并填写序号': ['M-K-01-112'],
  '常用数集及其记法': ['M-K-01-116'],
  '元素与集合的关系': ['M-K-01-113'],
  '判断常用数集的元素关系并填符号': ['M-K-01-113', 'M-K-01-116'],
  '辨析元素关系、真子集和常用数集': ['M-K-01-113', 'M-K-01-127', 'M-K-01-116'],
  '由四元长度集合判断可能的四边形': ['M-K-01-112'],
  '判断含参一次方程可能的解集': ['M-K-01-112', 'M-K-01-129'],
  '由三个集合元素构成边长排除等腰三角形': ['M-K-01-112'],
  '集合的互异性': ['M-K-01-112'],
  '集合的表示法': ['M-K-01-114', 'M-K-01-115'],
  '将有限等差数集识别为描述法': ['M-K-01-115'],
  '将自然数描述集合化为列举法': ['M-K-01-114', 'M-K-01-115'],
  '将已因式分解方程根集化为列举法': ['M-K-01-114'],
  '求方程组解并用有序数对列举解集': ['M-K-01-114'],
  '判断整数线性组合集合与偶数集相等': ['M-K-01-128'],
  '辨析集合元素类型与集合相等': ['M-K-01-112', 'M-K-01-128'],
  '辨析数集、点集、空集与描述法中的集合相等': ['M-K-01-115', 'M-K-01-128', 'M-K-01-129'],
  '集合间的基本关系': ['M-K-01-126', 'M-K-01-127', 'M-K-01-128'],
  '由空集为根集的真子集求参数': ['M-K-01-127', 'M-K-01-129'],
  '计算有限集与区间交集的子集数': ['M-K-01-1211', 'M-K-01-126'],
  '用一般最大元素分组论证和不在集内的最大基数': ['M-K-01-126'],
  '从已枚举的二人组合中筛选满足条件的子集': ['M-K-01-126'],
  '按商集新定义求并集并计算真子集数': ['M-K-01-1210', 'M-K-01-127'],
  '集合的基本运算': ['M-K-01-1210', 'M-K-01-1211', 'M-K-01-1213'],
  '计算平方约束区间与开区间的并集': ['M-K-01-1210'],
  '由因式符号求区间并取交集': ['M-K-01-1211'],
  '由绝对值条件求实数区间补集': ['M-K-01-1213'],
  '在整数全集中求补集再与有限集并集': ['M-K-01-1210', 'M-K-01-1213'],
  '计算已给区间的交集并判断端点': ['M-K-01-1211'],
};

function catalogCandidates(book, pages) {
  if (!book || !pages.length) return [];
  return book.chapters.flatMap((chapter, ci) => {
    const chapterEnd = chapter.printedPageEnd ?? ((book.chapters[ci + 1]?.printedPageStart ?? (book.source.pageCount - book.printedPageOffset + 1)) - 1);
    return (chapter.sections ?? []).flatMap((section, si) => {
      const end = section.printedPageEnd ?? ((chapter.sections[si + 1]?.printedPageStart ?? chapterEnd + 1) - 1);
      if (!pages.some(page => page >= section.printedPageStart && page <= end)) return [];
      return [{ nodeId: section.id, chapterId: chapter.id, title: section.title,
        printedPageStart: section.printedPageStart, printedPageEnd: end,
        basis: 'legacy_page_within_catalog_interval', status: 'unverified',
        reason: '目录区间只用于定位；旧册名页码尚未逐条核对版次及正文，不能证明知识覆盖。' }];
    });
  });
}

export function buildCurriculumMap(inventory, { snapshotSha256, textbooks, textbooksSha256, questions = [] } = {}) {
  const rows = inventory.queries.knowledgePoints.rows;
  const knowledgeSha256 = curriculumHash(rows);
  const catalogVersion = `legacy-kp-${knowledgeSha256.slice(0, 16)}`;
  const knowledge = { schemaVersion: 1, catalogVersion,
    source: { id: 'legacy-knowledge-points', path: inventoryPath, sha256: snapshotSha256,
      recordsSha256: knowledgeSha256, observedAt: inventory.observedAt, query: 'knowledgePoints' },
    semantics: { masteryRequirement: '旧项目知识元数据；不是课标原文等级、题目认知等级或学生掌握状态。',
      parentTree: '保留旧父子关系；册别按 metadata_json.source_textbook，不按根节点名称推断。' },
    knowledgePoints: structuredClone(rows) };
  const legacyRows = inventory.queries.legacyMappings.rows;
  const v2Rows = inventory.queries.v2Mappings.rows;
  const evidenceSources = [
    { id: 'legacy-public-mappings', path: inventoryPath, sha256: snapshotSha256, query: 'legacyMappings', recordsSha256: curriculumHash(legacyRows) },
    { id: 'legacy-v2-mappings', path: inventoryPath, sha256: snapshotSha256, query: 'v2Mappings', recordsSha256: curriculumHash(v2Rows) },
  ];
  if (textbooks) evidenceSources.push({ id: 'current-textbooks', path: 'data/curriculum/textbooks.json', sha256: textbooksSha256,
    version: textbooks.catalogVersion ?? `textbooks-${textbooksSha256.slice(0,16)}` });
  const evidenceRecords = [
    ...legacyRows.map(row => ({ id: `legacy-public-map-${row.id}`, kpUid: row.kp_uid,
      sourceId: 'legacy-public-mappings', status: row.verified ? 'legacy_verified' : 'unverified',
      recordSha256: curriculumHash(row), originalRecord: structuredClone(row),
      textbookNode: structuredClone(inventory.queries.legacyNodes.rows.find(node => node.id === row.textbook_node_id)),
      textbookEdition: structuredClone(inventory.queries.legacyEditions.rows.find(edition => edition.id === inventory.queries.legacyNodes.rows.find(node => node.id === row.textbook_node_id)?.textbook_edition_id)) })),
    ...v2Rows.map(row => ({ id: `legacy-v2-map-${row.id}`, kpUid: row.kp_uid, sourceId: 'legacy-v2-mappings',
      status: row.review_status, recordSha256: curriculumHash(row), originalRecord: structuredClone(row),
      textbookNode: structuredClone(inventory.queries.v2Nodes.rows.find(node => node.id === row.textbook_node_id)),
      textbookRevision: structuredClone(inventory.queries.v2Revisions.rows.find(revision => revision.id === row.textbook_revision_id)),
      sourceDocument: { sourceTextbookId: inventory.queries.v2Sources.rows[0].id,
        sha256: inventory.queries.v2Sources.rows[0].file_sha256 } })),
  ];
  const mappings = rows.filter(row => row.is_leaf).map(row => {
    const volume = row.metadata_json?.source_textbook ?? null;
    const textbookId = bookIds[volume] ?? null;
    const book = textbooks?.books.find(item => item.id === textbookId);
    const sourcePage = parseLegacyPages(row.metadata_json?.source_page);
    const candidates = catalogCandidates(book, sourcePage.pages);
    const refs = evidenceRecords.filter(evidence => evidence.kpUid === row.uid).map(evidence => evidence.id);
    return { id: `kp-book:${row.uid}`, kpUid: row.uid, catalogVersion, textbookId, volume,
      sourcePage, textbookSourceSha256: book?.source.sha256 ?? null,
      status: refs.length || candidates.length ? 'unverified' : 'legacy_metadata_only',
      pendingReasons: [!textbookId ? 'unknown_volume' : null, !book ? 'catalog_not_loaded' : null,
        sourcePage.status !== 'parsed' ? 'legacy_page_unparsed' : null,
        book && !candidates.length ? 'no_section_at_legacy_page' : null,
        'edition_and_content_coverage_not_verified'].filter(Boolean),
      textbookNodeCandidates: candidates, evidenceRefs: refs };
  });
  const questionMappings = questions.map(question => ({ questionId: question.questionId,
    contentVersion: question.contentVersion, teacherVersion: question.teacherVersion,
    primaryTopics: (question.scopeEvidence?.primaryTopics ?? []).map(topic => ({ topic,
      status: 'pending_uid_mapping', suggestedKpUids: topicSuggestions[topic] ?? [],
      basis: topicSuggestions[topic] ? 'explicit_internal_label_suggestion' : 'unmapped_local_topic',
      reason: '题包原 primaryTopics 是本地描述；候选不替代逐题主知识核验，也不自动迁入题包。' })) }));
  const map = { schemaVersion: 1, catalogVersion, sourceKnowledgeSha256: knowledgeSha256,
    snapshotSource: knowledge.source, evidenceSources, evidenceRecords,
    statusPolicy: { confirmed: '只有指定版本教材正文证据及映射核验完成才可确认；本轮不自动确认。',
      unverified: '已有目录定位候选或旧映射，但版本/内容覆盖尚待核验。',
      legacy_metadata_only: '只有旧知识元数据册名/页码，没有已接入目录或旧直接映射。',
      pending_uid_mapping: '题目描述尚未核实映射到正式 UID；建议 UID 不可作为已确认过滤条件。' },
    mappings, questionMappings };
  map.summary = summarize(knowledge, map);
  return { knowledge, map };
}

function summarize(knowledge, map) {
  const countBy = (items, key) => items.reduce((out, item) => (out[item[key] ?? 'unknown'] = (out[item[key] ?? 'unknown'] ?? 0) + 1, out), {});
  return { knowledgePoints: knowledge.knowledgePoints.length, leaves: knowledge.knowledgePoints.filter(kp => kp.is_leaf).length,
    byVolume: countBy(map.mappings, 'volume'), byStatus: countBy(map.mappings, 'status'),
    withCatalogCandidates: map.mappings.filter(mapping => mapping.textbookNodeCandidates.length).length,
    legacyPublicEvidence: map.evidenceRecords.filter(evidence => evidence.sourceId === 'legacy-public-mappings').length,
    legacyV2Evidence: map.evidenceRecords.filter(evidence => evidence.sourceId === 'legacy-v2-mappings').length,
    questionCount: map.questionMappings.length, questionPrimaryTopics: map.questionMappings.reduce((count, question) => count + question.primaryTopics.length, 0),
    questionTopicsPending: map.questionMappings.reduce((count, question) => count + question.primaryTopics.filter(topic => topic.status === 'pending_uid_mapping').length, 0) };
}

export function validateCurriculumMap(knowledge, map, { inventory, textbooks, questions } = {}) {
  const errors = [];
  const require = (condition, message) => { if (!condition) errors.push(message); };
  const records = knowledge.knowledgePoints;
  const uidMap = new Map(records.map(kp => [kp.uid, kp]));
  require(uidMap.size === records.length, 'duplicate knowledge UID');
  require(records.length === 509, 'legacy knowledge count must remain 509');
  const leaves = records.filter(kp => kp.is_leaf);
  require(leaves.length === 423, 'legacy leaf count must remain 423');
  for (const kp of records) {
    require(!kp.parent_uid || uidMap.has(kp.parent_uid), `missing parent: ${kp.uid}`);
    const visited = new Set(); let item = kp;
    while (item) { if (visited.has(item.uid)) { errors.push(`parent cycle: ${kp.uid}`); break; } visited.add(item.uid); item = uidMap.get(item.parent_uid); }
  }
  require(map.catalogVersion === knowledge.catalogVersion, 'catalog version mismatch');
  require(curriculumHash(records) === knowledge.source.recordsSha256, 'knowledge source records hash mismatch');
  require(map.sourceKnowledgeSha256 === knowledge.source.recordsSha256, 'mapping source knowledge hash mismatch');
  require(/^[a-f0-9]{64}$/.test(knowledge.source.sha256), 'missing source snapshot SHA-256');
  const mapped = new Set(map.mappings.map(mapping => mapping.kpUid));
  require(mapped.size === map.mappings.length && mapped.size === 423, 'leaf mappings must be unique and complete');
  const evidenceById = new Map(map.evidenceRecords.map(evidence => [evidence.id, evidence]));
  require(evidenceById.size === map.evidenceRecords.length, 'duplicate evidence identity');
  for (const evidence of map.evidenceRecords) {
    require(uidMap.has(evidence.kpUid), `unknown evidence UID: ${evidence.id}`);
    require(curriculumHash(evidence.originalRecord) === evidence.recordSha256, `evidence hash mismatch: ${evidence.id}`);
    require(evidence.sourceId === 'legacy-public-mappings' ? evidence.status === (evidence.originalRecord.verified ? 'legacy_verified' : 'unverified')
      : evidence.status === evidence.originalRecord.review_status, `evidence status upgraded: ${evidence.id}`);
  }
  for (const kp of leaves) {
    require(mapped.has(kp.uid), `missing leaf mapping: ${kp.uid}`);
    const mapping = map.mappings.find(item => item.kpUid === kp.uid);
    if (!mapping) continue;
    require(mapping.volume === kp.metadata_json?.source_textbook, `volume changed: ${kp.uid}`);
    require(mapping.textbookId === (bookIds[mapping.volume] ?? null), `wrong textbook identity: ${kp.uid}`);
    require(mapping.sourcePage.originalValue === kp.metadata_json?.source_page && mapping.sourcePage.originalText === String(kp.metadata_json?.source_page ?? ''), `legacy page lost: ${kp.uid}`);
    require(JSON.stringify(mapping.sourcePage) === JSON.stringify(parseLegacyPages(kp.metadata_json?.source_page)), `legacy page parse changed: ${kp.uid}`);
    require(['unverified', 'legacy_metadata_only'].includes(mapping.status), `unsupported mapping confirmation: ${kp.uid}`);
    require(mapping.pendingReasons.includes('edition_and_content_coverage_not_verified'), `missing review reason: ${kp.uid}`);
    require(mapping.evidenceRefs.every(id => evidenceById.get(id)?.kpUid === kp.uid), `wrong evidence link: ${kp.uid}`);
    require(JSON.stringify(mapping.evidenceRefs) === JSON.stringify(map.evidenceRecords.filter(evidence => evidence.kpUid === kp.uid).map(evidence => evidence.id)), `evidence references lost: ${kp.uid}`);
    if (textbooks) {
      const book = textbooks.books.find(item => item.id === mapping.textbookId);
      require(Boolean(book), `book missing: ${kp.uid}`);
      require(mapping.textbookSourceSha256 === book?.source.sha256, `textbook source version mismatch: ${kp.uid}`);
      require(JSON.stringify(mapping.textbookNodeCandidates) === JSON.stringify(catalogCandidates(book, mapping.sourcePage.pages)), `catalog locator mismatch: ${kp.uid}`);
    }
  }
  require(Object.keys(summarize(knowledge, map).byVolume).length === 5, 'all five volumes must be represented');
  require(JSON.stringify(map.summary) === JSON.stringify(summarize(knowledge, map)), 'summary stale');
  for (const question of map.questionMappings) for (const topic of question.primaryTopics) {
    require(topic.status === 'pending_uid_mapping', `question topic confirmation unsupported: ${question.questionId}`);
    require(topic.suggestedKpUids.every(uid => uidMap.has(uid)), `unknown question suggested UID: ${question.questionId}`);
  }
  if (inventory) {
    require(JSON.stringify(records) === JSON.stringify(inventory.queries.knowledgePoints.rows), 'legacy records changed or omitted');
    require(map.evidenceRecords.filter(evidence => evidence.sourceId === 'legacy-public-mappings').length === inventory.queries.legacyMappings.rows.length, 'legacy public evidence lost');
    require(map.evidenceRecords.filter(evidence => evidence.sourceId === 'legacy-v2-mappings').length === inventory.queries.v2Mappings.rows.length, 'legacy V2 evidence lost');
    for (const source of map.evidenceSources.filter(source => source.query)) require(source.recordsSha256 === curriculumHash(inventory.queries[source.query].rows), `source records hash stale: ${source.id}`);
    require(JSON.stringify(map.evidenceRecords.filter(evidence => evidence.sourceId === 'legacy-public-mappings').map(evidence => evidence.originalRecord)) === JSON.stringify(inventory.queries.legacyMappings.rows), 'legacy public evidence changed');
    require(JSON.stringify(map.evidenceRecords.filter(evidence => evidence.sourceId === 'legacy-v2-mappings').map(evidence => evidence.originalRecord)) === JSON.stringify(inventory.queries.v2Mappings.rows), 'legacy V2 evidence changed');
  }
  if (questions) {
    const ids = new Set(map.questionMappings.map(question => question.questionId));
    require(ids.size === map.questionMappings.length && ids.size === questions.length, 'question mapping count or uniqueness mismatch');
    for (const question of questions) {
      const record = map.questionMappings.find(item => item.questionId === question.questionId);
      require(record?.contentVersion === question.contentVersion && record?.teacherVersion === question.teacherVersion, `question version stale: ${question.questionId}`);
      require(JSON.stringify(record?.primaryTopics.map(topic => topic.topic)) === JSON.stringify(question.scopeEvidence?.primaryTopics ?? []), `question topics lost: ${question.questionId}`);
    }
  }
  return { ok: !errors.length, errors, summary: summarize(knowledge, map) };
}

function currentQuestions() {
  const ledger = readJson('data/question-bank/ledger.json');
  return ledger.entries.filter(entry => entry.status === 'ready').map(entry => readJson(`data/question-bank/${entry.contentPath}`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inventory = readJson(inventoryPath);
  const textbookPath = path.join(root, 'data/curriculum/textbooks.json');
  const textbooks = fs.existsSync(textbookPath) ? readJson('data/curriculum/textbooks.json') : undefined;
  const questions = currentQuestions();
  if (process.argv.includes('--write')) {
    const { knowledge, map } = buildCurriculumMap(inventory, { snapshotSha256: bytesHash(fs.readFileSync(path.join(root, inventoryPath))),
      textbooks, textbooksSha256: textbooks ? bytesHash(fs.readFileSync(textbookPath)) : undefined, questions });
    fs.mkdirSync(path.join(root, 'data/curriculum'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data/curriculum/knowledge-points.json'), JSON.stringify(knowledge, null, 2) + '\n');
    fs.writeFileSync(path.join(root, 'data/curriculum/textbook-knowledge-map.json'), JSON.stringify(map, null, 2) + '\n');
  }
  const knowledge = readJson('data/curriculum/knowledge-points.json');
  const map = readJson('data/curriculum/textbook-knowledge-map.json');
  const result = validateCurriculumMap(knowledge, map, { inventory, textbooks, questions });
  if (knowledge.source.sha256 !== bytesHash(fs.readFileSync(path.join(root, inventoryPath)))) result.errors.push('inventory file hash stale');
  if (textbooks && map.evidenceSources.find(source => source.id === 'current-textbooks')?.sha256 !== bytesHash(fs.readFileSync(textbookPath))) result.errors.push('textbook file hash stale');
  result.ok = result.errors.length === 0;
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
