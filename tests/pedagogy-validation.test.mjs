import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const validator = path.join(root, 'scripts/verify_pedagogy_analysis.py');

async function fixture(t, changes = []) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tutor-pedagogy-validator-'));
  t.after(async () => {
    assert.equal(path.dirname(dir), path.resolve(tmpdir()));
    assert.ok(path.basename(dir).startsWith('tutor-pedagogy-validator-'));
    await rm(dir, { recursive: true, force: true });
  });
  await Promise.all([
    cp(path.join(root, 'data/pedagogy'), path.join(dir, 'data/pedagogy'), { recursive: true }),
    cp(path.join(root, 'data/question-bank'), path.join(dir, 'data/question-bank'), { recursive: true }),
  ]);
  for (const [name, mutate] of changes) {
    const target = path.join(dir, `data/pedagogy/${name}.json`);
    const value = JSON.parse(await readFile(target, 'utf8'));
    mutate(value);
    await writeFile(target, JSON.stringify(value));
  }
  const result = spawnSync(process.env.PYTHON || 'python', [validator, '--root', dir], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.stderr, '', 'validator should report a JSON error, without traceback');
  return { code: result.status, body: JSON.parse(result.stdout) };
}

const cases = [
  ['rejects empty set coverage even if its declaration is also cleared', 'set-questions-analysis', v => {
    v.questions = []; v.coverage.questionIds = [];
  }, /集合分析为空/],
  ['rejects an illegal analysis state', 'set-questions-analysis', v => {
    v.questions[0].verificationStatus = 'auto_approved';
  }, /非法复核状态/],
  ['rejects a forged package-binding hash', 'set-questions-analysis', v => {
    v.questions[0].sourceContext.contentSha256 = '0'.repeat(64);
  }, /分析 content 哈希绑定不匹配/],
  ['rejects a supported judgment without evidence', 'set-questions-analysis', v => {
    const ev = v.questions[0].objectiveSupportEvaluations[0];
    ev.judgment = 'supported'; ev.evidence = ' ';
  }, /缺判断依据/],
  ['rejects repeated analysis part identities', 'set-questions-analysis', v => {
    const q = v.questions.find(q => q.partAnalyses?.length > 1);
    q.partAnalyses[1].partId = q.partAnalyses[0].partId;
  }, /小问 ID 缺失或重复/],
  ['rejects an invented benchmark objective', 'benchmark-samples', v => {
    v.samples[0].pedagogicalAnalysis.objectiveEvaluations[0].objectiveId = 'not-a-catalog-goal';
  }, /未知或重复目标/],
  ['rejects an illegal benchmark support judgment', 'benchmark-samples', v => {
    v.samples[0].pedagogicalAnalysis.objectiveEvaluations[0].judgment = 'probably_supported';
  }, /非法支持判定/],
  ['rejects a stale benchmark goal version', 'benchmark-samples', v => {
    v.samples[0].pedagogicalAnalysis.objectiveEvaluations[0].objectiveVersion = -1;
  }, /目标定义版本不匹配/],
  ['rejects a benchmark question absent from its source analysis', 'benchmark-samples', v => {
    v.samples.find(q => q.questionId.startsWith('gaokao-')).questionId = 'gaokao-missing-question';
  }, /标杆 .* 与已核对分析不同/],
  ['rejects source content modified without a new content checksum', 'gaokao-2025-analysis', v => {
    v.analyzedQuestions[0].analysis += ' Altered mathematics.';
  }, /内容哈希不匹配/],
  ['rejects a fabricated gaokao content checksum', 'gaokao-2025-analysis', v => {
    v.analyzedQuestions[0].analysisContentSha256 = '0'.repeat(64);
  }, /内容哈希不匹配/],
  ['rejects gaokao analysis parts absent from the source stem', 'gaokao-2025-analysis', v => {
    v.analyzedQuestions.find(q => q.isParent).partAnalyses[0].partId = 'p-invented';
  }, /分析小问与实际高考题面不一致/],
  ['rejects a forged individual PDF source hash', 'gaokao-2025-analysis', v => {
    v.analyzedQuestions[0].sourceVerification.blankPdfSha256 = '0'.repeat(64);
  }, /来源哈希不匹配/],
  ['rejects source pages beyond the declared PDF page count', 'gaokao-2025-analysis', v => {
    v.analyzedQuestions[0].sourceVerification.blankPages = [999];
  }, /来源页码非法或超界/],
  ['rejects source location pages inconsistent with the verification record', 'gaokao-2025-analysis', v => {
    v.analyzedQuestions[0].sourceLocation.blankPages = [2];
  }, /页码定位不一致/],
  ['rejects invalid source manifest hashes', 'gaokao-2025-analysis', v => {
    v.paperCatalogs[0].sourceAssets.blank.sha256 = 'not-a-hash';
  }, /来源哈希非法/],
  ['rejects repeated question units', 'gaokao-2025-analysis', v => {
    v.analyzedQuestions[1].unitId = v.analyzedQuestions[0].unitId;
  }, /分析单元 ID 缺失或重复/],
  ['rejects upgraded verification without an independent review record', 'gaokao-2025-analysis', v => {
    v.analyzedQuestions[0].verificationStatus = 'evidence_verified';
    delete v.analyzedQuestions[0].review;
  }, /已复核状态缺独立复核记录/],
];

test('pedagogy validator detects independently mutated invalid deliveries', async t => {
  await t.test('accepts the valid offline fixture without accessing external PDFs', async t => {
    const result = await fixture(t, [['gaokao-2025-analysis', v => {
      v.provenance.rawPdfDirectory = path.join(tmpdir(), 'intentionally-absent-pdf-source');
    }]]);
    assert.equal(result.code, 0);
    assert.equal(result.body.ok, true);
    assert.match(result.body.limitation, /不证明数学正确/);
    assert.match(result.body.limitation, /未在本次校验中重读外部PDF/);
  });
  await t.test('metadata edits do not invalidate a source-content-only checksum', async t => {
    const result = await fixture(t, [['gaokao-2025-analysis', v => {
      v.analyzedQuestions[0].annotationVerification.reason += ' New review note.';
    }]]);
    assert.equal(result.code, 0);
    assert.equal(result.body.ok, true);
  });
  for (const [label, name, mutate, message] of cases) {
    await t.test(label, async t => {
      const result = await fixture(t, [[name, mutate]]);
      assert.equal(result.code, 1);
      assert.equal(result.body.ok, false);
      assert.match(result.body.errors.join('\n'), message);
    });
  }
});
