# -*- coding: utf-8 -*-
"""Check analysis bindings, not mathematical truth or human review completion."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

FILES = ('objectives-catalog', 'benchmark-samples', 'set-questions-analysis',
         'set-unready-inventory', 'gaokao-2025-analysis')
JUDGMENTS = {'supported', 'partially_supported', 'insufficient_evidence', 'unsupported'}
STATES = {'generated', 'pending_review', 'source_checked', 'evidence_verified'}
CONTENT_FIELDS = ('stem', 'options', 'parts', 'answer', 'analysis')


def valid_sha(value):
    return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value) is not None


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(',', ':')).encode('utf-8')).hexdigest()


def validate(root):
    errors = []
    def check(ok, message):
        if not ok:
            errors.append(message)
    def read(relative):
        return json.loads((root / relative).read_text(encoding='utf-8'))

    data = {name: read(f'data/pedagogy/{name}.json') for name in FILES}
    ledger = read('data/question-bank/ledger.json')['entries']
    entries = {q['questionId']: q for q in ledger}
    catalog = data['objectives-catalog']
    objectives = catalog.get('objectives', [])
    ids = [q.get('objectiveId') for q in objectives]
    check(bool(ids) and all(isinstance(i, str) and i for i in ids)
          and len(set(ids)) == len(ids), '目标 ID 为空或重复')
    for q in objectives:
        check(isinstance(q.get('version'), int) and q['version'] > 0,
              f"{q.get('objectiveId')}: 缺目标定义版本")
    goal_versions = {q['objectiveId']: q.get('version') for q in objectives}

    gaokao = data['gaokao-2025-analysis']
    papers = gaokao.get('paperCatalogs', [])
    paper_ids = [p.get('paperId') for p in papers]
    check(bool(paper_ids) and all(isinstance(i, str) and i for i in paper_ids)
          and len(paper_ids) == len(set(paper_ids)), '高考来源试卷 ID 为空或重复')
    paper_by_id = {p.get('paperId'): p for p in papers}
    for paper in papers:
        for kind in ('blank', 'analysis'):
            asset = paper.get('sourceAssets', {}).get(kind, {})
            check(asset.get('fileName') == paper.get(kind + 'Pdf')
                  and isinstance(asset.get('fileName'), str),
                  f"{paper.get('paperId')}: {kind} 来源文件绑定不一致")
            check(valid_sha(asset.get('sha256')), f"{paper.get('paperId')}: {kind} 来源哈希非法")
            count = asset.get('pageCount')
            check(type(count) is int and count > 0, f"{paper.get('paperId')}: {kind} 来源页数非法")

    def source_binding(q):
        qid = q.get('questionId')
        paper = paper_by_id.get(q.get('paperId'), {})
        check(bool(paper), f'{qid}: 未知来源试卷')
        number = q.get('questionNumber')
        check(type(number) is int and 1 <= number <= paper.get('totalQuestions', 0),
              f'{qid}: 原卷题号超界')
        verification = q.get('sourceVerification', {})
        check(verification.get('status') in STATES, f'{qid}: 非法源核对状态')
        check(bool(verification.get('checkedBy')) and bool(verification.get('checkedOn'))
              and bool(verification.get('method')), f'{qid}: 源核对记录缺失')
        for kind in ('blank', 'analysis'):
            asset = paper.get('sourceAssets', {}).get(kind, {})
            check(verification.get(kind + 'Pdf') == asset.get('fileName'),
                  f'{qid}: {kind} 来源文件不匹配')
            sha = verification.get(kind + 'PdfSha256')
            check(valid_sha(sha) and sha == asset.get('sha256'), f'{qid}: {kind} 来源哈希不匹配')
            pages = verification.get(kind + 'Pages', [])
            count = asset.get('pageCount', 0)
            valid_pages = (isinstance(pages, list) and bool(pages)
                           and all(type(n) is int and 1 <= n <= count for n in pages))
            check(valid_pages and len(set(pages)) == len(pages), f'{qid}: {kind} 来源页码非法或超界')
            location = q.get('sourceLocation', {})
            check(pages == location.get(kind + 'Pages') and (pages or [None])[0] == location.get(kind + 'Page'),
                  f'{qid}: {kind} 页码定位不一致')
        sha = q.get('analysisContentSha256')
        check(valid_sha(sha) and sha == digest({k: q.get(k) for k in CONTENT_FIELDS}),
              f'{qid}: 高考题面答案解析内容哈希不匹配')

    def evaluations(values, where):
        check(isinstance(values, list), f'{where}: 判定不是数组')
        seen = set()
        for ev in values or []:
            oid = ev.get('objectiveId')
            check(oid in goal_versions and oid not in seen, f'{where}: 未知或重复目标 {oid}')
            seen.add(oid)
            check(ev.get('objectiveVersion') == goal_versions.get(oid), f'{where}: 目标定义版本不匹配')
            check(ev.get('judgment') in JUDGMENTS, f'{where}: 非法支持判定')
            check(isinstance(ev.get('evidence'), str) and bool(ev['evidence'].strip()), f'{where}: 缺判断依据')

    unit_ids = set()
    packages = {}
    def unit(q, sample=False):
        qid = q.get('questionId', '')
        uid = q.get('unitId')
        check(isinstance(uid, str) and uid and uid not in unit_ids, f'{qid}: 分析单元 ID 缺失或重复')
        unit_ids.add(uid)
        check(q.get('verificationStatus') in STATES, f'{qid}: 非法复核状态')
        if q.get('verificationStatus') == 'evidence_verified':
            review = q.get('review', {})
            check(review.get('status') == 'approved' and bool(review.get('reviewer'))
                  and bool(review.get('checkedAt')) and bool(review.get('evidenceRefs')),
                  f'{qid}: 已复核状态缺独立复核记录')
        body = q.get('pedagogicalAnalysis', {}) if sample else q
        evaluations(body.get('objectiveEvaluations' if sample else 'objectiveSupportEvaluations', []), qid)
        parts = body.get('partAnalyses', [])
        part_ids = [p.get('partId') for p in parts]
        check(all(isinstance(i, str) and i for i in part_ids) and len(part_ids) == len(set(part_ids)),
              f'{qid}: 小问 ID 缺失或重复')
        for p in parts:
            evaluations(p.get('objectiveEvaluations', []), f"{qid}.{p.get('partId')}")
        if qid.startswith('tutor-set-'):
            entry = entries.get(qid, {})
            check(entry.get('status') == 'ready', f'{qid}: 分析绑定到未就绪/不存在题目')
            if not entry.get('contentPath'):
                return
            package = packages.setdefault(qid, read('data/question-bank/' + entry['contentPath']))
            ctx = q.get('sourceContext', {})
            for prefix, payload in [('content', 'student'), ('teacher', 'teacher')]:
                sha = digest(package[payload])
                version = prefix + '-' + sha[:16]
                check(package.get(prefix + 'Sha256') == sha, f'{qid}: 题包 {prefix} 哈希损坏')
                check(package.get(prefix + 'Version') == version == entry.get(prefix + 'Version')
                      == ctx.get(prefix + 'Version'), f'{qid}: {prefix} 版本绑定不匹配')
                check(ctx.get(prefix + 'Sha256') == sha, f'{qid}: 分析 {prefix} 哈希绑定不匹配')
            expected_parts = [p['partId'] for p in package['student'].get('parts', [])]
            check(q.get('isParent') == (len(expected_parts) > 1), f'{qid}: 父题标记不一致')
            check(set(part_ids) == set(expected_parts), f'{qid}: 分析小问与实际题包不一致')
            if sample:
                content = q.get('questionContent', {})
                for key in ('stem', 'options', 'parts'):
                    fallback = '' if key == 'stem' else []
                    check(content.get(key, fallback) == package['student'].get(key, fallback),
                          f'{qid}: 标杆 {key} 与版本绑定的实际题面不一致')
        elif qid.startswith('gaokao-'):
            content = q.get('questionContent', {}) if sample else q
            source_parts = content.get('parts', [])
            expected_parts = [p.get('partId') for p in source_parts]
            check(all(isinstance(i, str) and i for i in expected_parts)
                  and len(expected_parts) == len(set(expected_parts)), f'{qid}: 题面小问 ID 缺失或重复')
            check(set(part_ids) == set(expected_parts), f'{qid}: 分析小问与实际高考题面不一致')
            check(q.get('isParent') == (len(expected_parts) > 1), f'{qid}: 高考父题标记不一致')
            if q.get('isParent'):
                check(len(parts) >= 2, f'{qid}: 父题缺小问分析')
            else:
                check(not parts, f'{qid}: 非父题带小问分析')
            if not sample:
                source_binding(q)
        else:
            check(False, f'{qid}: 无效题目身份')

    sets = data['set-questions-analysis']
    questions = sets.get('questions', [])
    qids = [q.get('questionId') for q in questions]
    declared = sets.get('coverage', {}).get('questionIds', [])
    check(bool(qids) and len(qids) == len(set(qids)) and set(qids) == set(declared),
          '集合分析为空、重复或与声明覆盖清单不符')
    for q in questions:
        unit(q)
    gquestions = gaokao.get('analyzedQuestions', [])
    gids = [q.get('questionId') for q in gquestions]
    check(bool(gids) and len(gids) == len(set(gids)), '高考分析为空或重复')
    for q in gquestions:
        unit(q)
    samples = data['benchmark-samples'].get('samples', [])
    check(bool(samples), '标杆样例为空')
    source_analyses = {q['questionId']: q for q in gquestions}
    for q in samples:
        unit(q, sample=True)
        if q['questionId'].startswith('gaokao-'):
            source = source_analyses.get(q['questionId'], {})
            content = q.get('questionContent', {})
            for key in (*CONTENT_FIELDS, 'questionType'):
                check(content.get(key, []) == source.get(key, []), f"{q['questionId']}: 标杆 {key} 与已核对分析不同")
            ctx = q.get('sourceContext', {})
            for key in ('blankPages', 'analysisPages'):
                check(ctx.get(key) == source.get('sourceVerification', {}).get(key),
                      f"{q['questionId']}: 标杆 {key} 与来源核对页码不一致")

    inventory = data['set-unready-inventory'].get('unreadyUnits', [])
    pending_ids = [q.get('questionId') for q in inventory]
    expected = {q['questionId'] for q in ledger if q['status'] != 'ready'}
    check(len(pending_ids) == len(set(pending_ids)) and set(pending_ids) == expected, '未就绪清单与实时台账不一致')
    for q in inventory:
        check(q.get('isSelectableCandidate') is False and bool(q.get('pendingReasons') or q.get('reportedIssues')),
              f"{q.get('questionId')}: 未就绪题可选或缺原因")
    return errors, {'setAnalyses': len(questions), 'gaokaoAnalyses': len(gquestions),
                    'benchmarkSamples': len(samples), 'pendingBankUnits': len(expected),
                    'bankReady': sum(q['status'] == 'ready' for q in ledger),
                    'evidenceVerified': sum(q.get('verificationStatus') == 'evidence_verified' for q in questions + gquestions)}


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    try:
        errors, counts = validate(args.root)
    except (ValueError, KeyError, TypeError, AttributeError, OSError) as exc:
        errors, counts = [str(exc)], {}
    print(json.dumps({'ok': not errors, 'counts': counts, 'errors': errors,
                      'limitation': '程序校验只证明结构和绑定一致；不证明数学正确或教学目标支持已复核。来源清单是离线证据，未在本次校验中重读外部PDF；同步篡改清单和记录无法由此识别。'},
                     ensure_ascii=False, indent=2))
    sys.exit(1 if errors else 0)
