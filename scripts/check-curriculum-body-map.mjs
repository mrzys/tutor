import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const bundlePaths = ['compulsory-1', 'compulsory-2', 'selective'].map(n => `data/curriculum/body-map-${n}.json`);
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const markdownCell = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');

export function bodyMapReport(result) {
  const names = { 'rja-compulsory-1': '必修一', 'rja-compulsory-2': '必修二',
    'rja-selective-1': '选必一', 'rja-selective-2': '选必二', 'rja-selective-3': '选必三' };
  const summary = result.summary;
  const lines = ['# 教材—知识点正文映射核对结果', '',
    `保留 ${summary.knowledgePoints} 个原 UID，逐项建立 ${summary.leaves} 个叶知识点的正文记录，${summary.groups} 个分组从后代叶汇总。${summary.sectionsWithBodyLinks}/${summary.sections} 个教材节有正文位置候选关联。`, '',
    `本轮正文语义匹配 ${summary.text_evidence_matched} 条，待核验 ${summary.needs_review} 条，未找到 ${summary.not_found} 条。全部仍为教师待复核，匹配数量不等于独立学科审核数量。`, '',
    '| 册别 | 正文匹配 | 待核验 | 未找到 |', '| --- | ---: | ---: | ---: |',
    ...summary.books.map(b => `| ${names[b.bookId]} | ${b.text_evidence_matched} | ${b.needs_review} | ${b.not_found} |`), '',
    `另保留 ${summary.knowledgeRelations} 条旧知识关系。${summary.legacyPageRelocations} 项旧页码与本轮所选正文证据页没有交集，记录实际页及差异，未回写旧来源。`, '',
    '## 待核验项', '',
    '下表保留实质范围、条件和公式疑点。正文中的相关概念存在，不表示旧定义的每一个公式都已被教材直接给出。', '',
    '| UID | 册别 | 知识点 | 实际印刷页 | 待核验依据 |', '| --- | --- | --- | --- | --- |',
    ...result.mappings.filter(m => m.status !== 'text_evidence_matched').map(m =>
      `| ${m.uid} | ${names[m.bookId]} | ${markdownCell(m.name)} | ${[...new Set(m.evidence.map(e => e.printedPage))].join('、')} | ${markdownCell((m.notes ?? []).join(' '))} |`), '',
    '## 旧知识树覆盖缺口', '',
    '以下是本轮明确发现的内容或活动缺口，不是对教材所有未建节点内容的穷举。保留教材依据与已有 UID 候选，不自动创建新 UID，也不把活动过程强挂成同名知识点。', '',
    ...result.sectionCoverageGaps.map(g => `- ${g.sectionId ?? g.chapterId}：${markdownCell(g.title ?? g.topics?.join('；'))}。${markdownCell(g.explanation ?? g.notes?.join(' '))}`), '',
    '## 复查与使用', '',
    '完整原文片段、文件及文本哈希、物理页码、实际印刷页、关系和核对理由见 [正文映射 JSON](../../data/curriculum/textbook-body-knowledge-map.json)。分册报告与命令见 [教材与知识点](README.md)。', '',
    '此映射建立知识身份和教材证据；不自动改变现有题包、教师已学边界、允许解法、认知要求、能力或核心素养支持状态。', ''];
  return lines.join('\n');
}

export function buildBodyMap({ knowledge, textbooks, migration, bundles, readText, sourceBundles = [] }) {
  const leaves = knowledge.knowledgePoints.filter(k => k.is_leaf);
  const byUid = new Map(knowledge.knowledgePoints.map(k => [k.uid, k]));
  const books = new Map(textbooks.books.map(b => [b.id, b]));
  const old = new Map(migration.mappings.map(m => [m.kpUid, m]));
  for (const bundle of bundles) assert.equal(bundle.catalogVersion, knowledge.catalogVersion, '正文核对所用知识版本已过期');
  const items = bundles.flatMap(b => b.items);
  assert.equal(items.length, leaves.length, '正文映射必须逐叶完整记录');
  assert.equal(new Set(items.map(m => m.uid)).size, items.length, '正文映射 UID 重复');
  const mappings = items.map(item => {
    const kp = byUid.get(item.uid);
    assert(kp?.is_leaf, `不是已有叶 UID: ${item.uid}`);
    assert.equal(item.definitionSha256, hash(kp.definition ?? ''), `${item.uid} 知识定义已变更，须重新核对`);
    const book = books.get(item.bookId);
    assert(book, `${item.uid} 教材不存在`);
    assert.equal(item.bookId, old.get(item.uid).textbookId, `${item.uid} 册别不一致`);
    assert(['text_evidence_matched', 'needs_review', 'not_found'].includes(item.status), `${item.uid} 状态无效`);
    assert(['introduces', 'explains', 'applies', 'related'].includes(item.relation), `${item.uid} 关系无效`);
    assert.equal(item.reviewStatus, 'pending_review', `${item.uid} 不得自动标为教师已审`);
    assert(Array.isArray(item.evidence));
    if (item.status === 'text_evidence_matched') assert(item.evidence.length, `${item.uid} 匹配缺少正文证据`);
    for (const evidence of item.evidence) {
      const page = book.pages.find(p => p.pdfPage === evidence.pdfPage);
      assert(page, `${item.uid} 正文页不存在`);
      assert.equal(evidence.printedPage, page.printedPage, `${item.uid} 印刷页错位`);
      assert.equal(evidence.textSha256, page.textSha256, `${item.uid} 文本版本过期`);
      assert(evidence.quote?.trim(), `${item.uid} 摘录为空`);
      assert(evidence.matchReason?.trim(), `${item.uid} 缺少语义判断理由`);
      const text = readText(page.localTextPath);
      assert.equal(hash(text), page.textSha256, `${item.uid} 本地正文与教材清单不一致`);
      assert(text.toString('utf8').includes(evidence.quote), `${item.uid} 摘录不是该页实际原文`);
    }
    for (const visual of item.visualEvidence ?? []) {
      const page = book.pages.find(p => p.pdfPage === visual.pdfPage);
      assert(page, `${item.uid} 视觉复核页不存在`);
      assert.equal(visual.printedPage, page.printedPage);
      assert.equal(visual.sourceSha256, book.source.sha256, `${item.uid} 视觉复核来源版本错误`);
      assert(visual.renderPath, `${item.uid} 缺少视觉证据文件定位`);
      assert.equal(hash(readText(visual.renderPath)), visual.renderSha256, `${item.uid} 视觉证据哈希不一致`);
    }
    return { ...structuredClone(item), name: kp.name, catalogVersion: knowledge.catalogVersion,
      textbookSourceSha256: book.source.sha256,
      legacySourcePage: structuredClone(old.get(item.uid).sourcePage),
      chapterSectionCandidates: [...new Map(item.evidence.filter(e => e.contentContext !== 'chapter_review').flatMap(e => book.chapters.flatMap((chapter, ci) => {
        const end = book.chapters[ci + 1]?.printedPageStart ?? (book.bodyPrintedPageRange?.[1] + 1 || Infinity);
        return chapter.sections.filter((section, si) => e.printedPage >= section.printedPageStart &&
          e.printedPage < (chapter.sections[si + 1]?.printedPageStart ?? end)).map(section => [section.id,
          { chapterId: chapter.id, sectionId: section.id, title: section.title,
            basis: 'body_evidence_page_within_catalog_interval' }]);
      }))).values()],
    };
  }).sort((a, b) => a.uid.localeCompare(b.uid));
  const mappedUids = new Set(mappings.map(m => m.uid));
  for (const leaf of leaves) assert(mappedUids.has(leaf.uid), `缺少正文映射: ${leaf.uid}`);
  const statuses = rows => Object.fromEntries(['text_evidence_matched', 'needs_review', 'not_found'].map(s => [s, rows.filter(r => r.status === s).length]));
  const descendants = uid => knowledge.knowledgePoints.filter(k => k.parent_uid === uid)
    .flatMap(k => k.is_leaf ? [k.uid] : descendants(k.uid));
  const groups = knowledge.knowledgePoints.filter(k => !k.is_leaf).map(k => {
    const leafUids = descendants(k.uid);
    return { uid: k.uid, name: k.name, relation: 'derived_from_descendants', leafUids,
      summary: statuses(mappings.filter(m => leafUids.includes(m.uid))),
      reviewStatus: 'pending_review' };
  });
  const sectionMappings = textbooks.books.flatMap(book => book.chapters.flatMap(chapter => chapter.sections.map(section => {
    const rows = mappings.filter(m => m.bookId === book.id && m.chapterSectionCandidates.some(s => s.sectionId === section.id));
    return { bookId: book.id, chapterId: chapter.id, sectionId: section.id, title: section.title,
      knowledgeUids: rows.map(m => m.uid), summary: statuses(rows),
      status: rows.length ? 'has_body_evidence_location_candidates' : 'no_body_evidence_link', reviewStatus: 'pending_review' };
  })));
  const knowledgeRelations = knowledge.knowledgePoints.flatMap(kp => ['prerequisites', 'related_to'].flatMap(type =>
    (kp.metadata_json?.[type] ?? []).map(raw => {
      const targetUid = typeof raw === 'string' ? raw : raw.uid;
      assert(byUid.has(targetUid), `${kp.uid} 知识关系悬空: ${targetUid}`);
      return { sourceUid: kp.uid, targetUid, type, relationType: typeof raw === 'object' ? raw.relation_type ?? null : null,
        status: 'legacy_unverified', originalValue: structuredClone(raw) };
    })));
  const visited = new Set();
  const visiting = new Set();
  const visitPrerequisites = uid => {
    assert(!visiting.has(uid), `旧前置关系存在环: ${uid}`);
    if (visited.has(uid)) return;
    visiting.add(uid);
    for (const edge of knowledgeRelations.filter(e => e.sourceUid === uid && e.type === 'prerequisites')) visitPrerequisites(edge.targetUid);
    visiting.delete(uid); visited.add(uid);
  };
  for (const uid of byUid.keys()) visitPrerequisites(uid);
  const sectionCoverageGaps = bundles.flatMap(b => b.sectionCoverageGaps ?? []).map(gap => {
    const locationId = gap.sectionId ?? gap.chapterId;
    const book = textbooks.books.find(b => b.chapters.some(c => gap.sectionId ?
      c.sections.some(s => s.id === gap.sectionId) : c.id === gap.chapterId));
    assert(book, `覆盖缺口没有对应教材章/节: ${locationId}`);
    for (const evidence of gap.evidence ?? []) {
      const page = book.pages.find(p => p.pdfPage === evidence.pdfPage);
      assert(page, `覆盖缺口页码不存在: ${locationId}`);
      assert.equal(evidence.printedPage, page.printedPage);
      assert.equal(evidence.textSha256, page.textSha256);
      const bytes = readText(page.localTextPath);
      assert.equal(hash(bytes), page.textSha256);
      assert(evidence.quote?.trim() && bytes.toString('utf8').includes(evidence.quote), `覆盖缺口摘录失真: ${locationId}`);
    }
    return { ...structuredClone(gap), bookId: book.id, reviewStatus: 'pending_review' };
  });
  return { schemaVersion: 1, catalogVersion: knowledge.catalogVersion,
    textbookManifestRecordsSha256: hash(JSON.stringify(textbooks)), sourceBundles,
    semantics: {
      text_evidence_matched: '已逐项对照知识定义与所引教材正文；正文仍为抽取文本，未自动等同教师审核。',
      needs_review: '有相关证据，但公式 OCR、概念范围、版本或语义差异需要继续核验。',
      not_found: '本轮未找到足以支持该知识点的教材正文，保留 UID 和问题，不假设不存在。',
      groups: '分组节点只汇总后代叶映射，不产生额外的教材内容覆盖断言。',
      sections: '反向索引由正文页落入目录区间产生位置候选；明确标注的章末复习证据不归入最后一节。不能把位置区间等同新授内容归属。',
      knowledgeRelations: '旧 prerequisites/related_to 关系只规范化 UID 引用并保留原值；未自动成为当前题目的完整解法依赖或教师允许前提。',
      selection: '映射只建立知识身份与教材依据，不自动赋予题目认知要求、能力、素养或允许解法证据。',
    },
    mappings, groups, sectionMappings, knowledgeRelations, sectionCoverageGaps,
    summary: { knowledgePoints: byUid.size, leaves: leaves.length, groups: groups.length,
      ...statuses(mappings), teacherReviewed: 0, sections: sectionMappings.length,
      sectionsWithBodyLinks: sectionMappings.filter(s => s.knowledgeUids.length).length,
      legacyPageRelocations: mappings.filter(m => m.evidence.length && !m.evidence.some(e =>
        m.legacySourcePage.pages.includes(e.printedPage))).length,
      knowledgeRelations: knowledgeRelations.length,
      sectionCoverageGaps: sectionCoverageGaps.length,
      books: textbooks.books.map(b => ({ bookId: b.id, ...statuses(mappings.filter(m => m.bookId === b.id)) })) },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = buildBodyMap({ knowledge: readJson('data/curriculum/knowledge-points.json'),
    textbooks: readJson('data/curriculum/textbooks.json'), migration: readJson('data/curriculum/textbook-knowledge-map.json'),
    bundles: bundlePaths.map(readJson), sourceBundles: bundlePaths.map(file => ({ path: file, sha256: hash(fs.readFileSync(path.join(root, file))) })),
    readText: file => fs.readFileSync(path.join(root, file)) });
  const target = 'data/curriculum/textbook-body-knowledge-map.json';
  const reportPath = path.join(root, 'docs/curriculum/body-mapping-results.md');
  if (process.argv.includes('--write')) {
    fs.writeFileSync(path.join(root, target), JSON.stringify(result, null, 2) + '\n');
    fs.writeFileSync(reportPath, bodyMapReport(result));
  } else {
    assert.deepEqual(readJson(target), result, '正文映射汇总过期，请显式 --write 重建');
    assert.equal(fs.readFileSync(reportPath, 'utf8'), bodyMapReport(result), '正文映射报告过期');
  }
  console.log(JSON.stringify(result.summary, null, 2));
}
