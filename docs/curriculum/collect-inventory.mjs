// Read-only source inventory. Credentials stay in memory and are never exported.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const legacyRoot = 'C:/Users/mrzys/OPC/tutor-kb';
const require = createRequire(`${legacyRoot}/package.json`);
const env = require('dotenv').parse(fs.readFileSync(`${legacyRoot}/.env`, 'utf8'));
const client = new (require('pg').Client)({ connectionString: env.DATABASE_URL,
  connectionTimeoutMillis: 12000, options: '-c default_transaction_read_only=on -c statement_timeout=20000' });
const result = {schemaVersion:1, observedAt:new Date().toISOString(), source:'legacy configured PostgreSQL, read-only repeatable-read transaction', queries:{}};
async function record(name, sql) {result.queries[name]={sql, rows:(await client.query(sql)).rows};}
try {
  await client.connect();
  await client.query('begin isolation level repeatable read read only');
  await record('readOnly', 'show transaction_read_only');
  await record('legacyEditions', `select e.*, (select count(*) from public.textbook_nodes n where n.textbook_edition_id=e.id) node_count,
    (select count(*) from public.kp_textbook_mappings m join public.textbook_nodes n on n.id=m.textbook_node_id where n.textbook_edition_id=e.id) mapping_count,
    (select count(*) from public.kp_textbook_mappings m join public.textbook_nodes n on n.id=m.textbook_node_id where n.textbook_edition_id=e.id and m.verified) verified_mapping_count
    from public.textbook_editions e order by e.id`);
  await record('legacyWorkflows', `select id,title,publisher,series,edition_year,volume,isbn,curriculum_standard_version,source_filename,
    status,current_stage,ocr_status,structure_status,mapping_status,publish_status,published_textbook_id,
    length(ocr_text) ocr_text_length,review_required,review_reason from public.textbook_workflows order by id`);
  await record('legacyNodes', 'select * from public.textbook_nodes order by textbook_edition_id,position,id');
  await record('legacyMappings', 'select * from public.kp_textbook_mappings order by textbook_node_id,kp_uid');
  await record('knowledgePoints', 'select uid,name,parent_uid,is_leaf,definition,metadata_json,updated_at from public.knowledge_points order by uid');
  await record('v2Sources', `select t.*,d.original_filename,d.byte_size,d.file_sha256,d.storage_kind,d.ingest_status
    from kb_v2.source_textbooks t join kb_v2.source_documents d on d.id=t.source_document_id order by t.id`);
  await record('v2Editions', 'select * from kb_v2.textbook_editions order by id');
  await record('v2Revisions', `select r.*, (select count(*) from kb_v2.textbook_nodes n where n.textbook_revision_id=r.id) node_count,
    (select count(*) from kb_v2.textbook_content_blocks b where b.textbook_revision_id=r.id and b.stale_at is null) active_block_count
    from kb_v2.textbook_revisions r order by r.id`);
  await record('v2Nodes','select * from kb_v2.textbook_nodes order by textbook_revision_id,position');
  await record('v2MappingSummary', 'select review_status,coverage_type,coverage_role,count(*) from kb_v2.textbook_block_knowledge_mappings group by 1,2,3 order by 1,2,3');
  await record('v2Mappings', `select m.*,b.stable_uid block_uid,b.textbook_revision_id,b.textbook_node_id,b.title block_title,
    b.review_status block_review_status, b.stale_at block_stale_at,
    (select jsonb_agg(jsonb_build_object('printedPage',s.printed_page,'excerpt',s.excerpt,'excerptHash',s.excerpt_hash,'bbox',s.bbox) order by s.span_index)
      from kb_v2.textbook_block_source_spans s where s.textbook_block_id=b.id) source_spans,
    (select jsonb_agg(jsonb_build_object('evidenceType',e.evidence_type,'sourceReferences',e.source_references,'excerpt',e.excerpt,'reason',e.reason))
      from kb_v2.textbook_block_knowledge_evidence e where e.mapping_id=m.id) mapping_evidence
    from kb_v2.textbook_block_knowledge_mappings m join kb_v2.textbook_content_blocks b on b.id=m.textbook_block_id order by m.id`);
  await record('v2BlockSummary','select textbook_revision_id,review_status,usability_level,count(*) from kb_v2.textbook_content_blocks where stale_at is null group by 1,2,3 order by 1,2,3');
  await client.query('rollback');
  fs.writeFileSync(new URL('./inventory.json', import.meta.url), JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(Object.fromEntries(Object.entries(result.queries).map(([key,val])=>[key,val.rows.length])),null,2));
} finally {await client.end();}
