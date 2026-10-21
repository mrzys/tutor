import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { hashContent } from './lib/integrity.mjs';

// Read only the shared bank. Personal records, import uploads and credentials
// are deliberately outside this exporter and are never opened.
export function buildSupplement({ seed, annotations, config, questions, localRows, publications, id }) {
  if (!id || annotations.sourceMigrationId !== seed.migration.id) throw new Error('Invalid release identity');
  const baseline = structuredClone(seed.config);
  for (const patch of annotations.entries) {
    const i = baseline.assemblyIndex.entries.findIndex(row => row.questionId === patch.questionId);
    if (i < 0 || hashContent(baseline.assemblyIndex.entries[i]) !== patch.previousAnnotationSha256) throw new Error('Annotation baseline mismatch');
    baseline.assemblyIndex.entries[i] = patch.annotation;
  }
  const originalIds = new Set(seed.questions.map(q => q.questionId));
  const current = new Map();
  for (const q of questions) {
    if (current.has(q.questionId)) throw new Error('Duplicate question identity');
    current.set(q.questionId, q);
  }
  for (const q of seed.questions) {
    if (hashContent(q) !== hashContent(current.get(q.questionId))) throw new Error('Bundled question changed or missing');
  }
  const extra = questions.filter(q => !originalIds.has(q.questionId));
  const extraIds = new Set(extra.map(q => q.questionId));
  for (const q of extra) {
    if (q.verification?.result !== 'pass') throw new Error('Unverified question');
    for (const [role, prefix, version] of [['student', 'content', 'contentVersion'], ['teacher', 'teacher', 'teacherVersion']]) {
      const hash = hashContent(q[role]);
      if (q[`${prefix}Sha256`] !== hash || q[version] !== `${prefix}-${hash.slice(0, 16)}` || q.verification[version] !== q[version]) throw new Error('Question version/hash mismatch');
    }
  }
  const rows = localRows.filter(row => {
    const payload = JSON.parse(row.payload);
    if (hashContent(payload) !== row.sha256) throw new Error('Shared row hash mismatch');
    if (['question_knowledge_mappings', 'question_section_mappings'].includes(row.kind)) return extraIds.has(payload.question_id);
    if (row.kind === 'agent_manual_only_audit') return payload.changes?.length && payload.changes.every(change => extraIds.has(change.questionId));
    return false;
  });
  const receipts = publications.map(row => ({ operationId: row.operation_id, manifestSha256: row.manifest_sha256, receipt: JSON.parse(row.receipt) }))
    .filter(row => row.receipt.questionIds?.some(qid => extraIds.has(qid)));
  if (receipts.some(row => row.receipt.questionIds.some(qid => !extraIds.has(qid))) || extra.some(q => !receipts.some(row => row.receipt.questionIds.includes(q.questionId)))) throw new Error('Publication scope mismatch');
  const manifest = { schemaVersion: 1, id, sourceMigrationId: seed.migration.id, baselineConfig: baseline,
    baselineConfigSha256: hashContent(baseline), config, questions: extra, localRows: rows, publications: receipts };
  return { ...manifest, manifestSha256: hashContent(manifest) };
}

export async function exportSupplement({ database, seedPath, annotationsPath, output, id }) {
  const seed = JSON.parse(await readFile(seedPath, 'utf8'));
  const annotations = JSON.parse(await readFile(annotationsPath, 'utf8'));
  const db = new DatabaseSync(database, { readOnly: true });
  let manifest;
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    manifest = buildSupplement({ seed, annotations, id,
      config: JSON.parse(db.prepare("SELECT value FROM bank_metadata WHERE key='config'").get().value),
      questions: db.prepare('SELECT payload FROM bank_questions ORDER BY id').all().map(row => JSON.parse(row.payload)),
      localRows: db.prepare('SELECT kind,id,payload,sha256 FROM bank_local_rows ORDER BY kind,id').all(),
      publications: db.prepare('SELECT operation_id,manifest_sha256,receipt FROM bank_publications ORDER BY operation_id').all() });
    db.exec('COMMIT');
  } finally { db.close(); }
  await writeFile(output, `${JSON.stringify(manifest)}\n`, { flag: 'wx' });
  return { questions: manifest.questions.length, assets: manifest.questions.reduce((n, q) => n + (q.assetPayloads?.length ?? 0), 0), localRows: manifest.localRows.length, publications: manifest.publications.length, manifestSha256: manifest.manifestSha256 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = name => args[args.indexOf(name) + 1];
  for (const key of ['--database', '--seed', '--annotations', '--output', '--id']) if (!args.includes(key) || !value(key)) throw new Error(`Required: ${key}`);
  console.log(JSON.stringify(await exportSupplement({ database: value('--database'), seedPath: value('--seed'), annotationsPath: value('--annotations'), output: value('--output'), id: value('--id') }), null, 2));
}
