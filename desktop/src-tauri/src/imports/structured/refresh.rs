//! Narrow source transport repair, never a free-form content replacement.
use super::*;

fn comparable(text: &str) -> String {
    let empty = regex::Regex::new(r"(?is)<div\b[^>]*>\s*</div>").unwrap();
    empty.replace_all(text, "").into_owned()
}
fn checked_text(
    old: &str,
    next: &str,
    allowed: &HashSet<String>,
    used: &mut HashSet<String>,
) -> AppResult<()> {
    if old == next {
        return Ok(());
    }
    let images =
        regex::Regex::new(r#"(?is)<img\b[^>]*\bsrc=["']asset:([^"']+)["'][^>]*>"#).unwrap();
    let mut removed = HashSet::new();
    let stripped = images.replace_all(old, |caps: &regex::Captures| {
        if allowed.contains(&caps[1]) {
            removed.insert(caps[1].to_owned());
            String::new()
        } else {
            caps[0].to_owned()
        }
    });
    let tables = regex::Regex::new(r"(?i)<table\b")
        .unwrap()
        .find_iter(old)
        .count();
    if removed.is_empty() || tables != removed.len() || comparable(&stripped) != comparable(next) {
        return Err(bad(
            "来源刷新只能移除已验证的同一位置重复表格图片，不能修改原题正文。",
        ));
    }
    used.extend(removed);
    Ok(())
}
fn table_removals(
    old: &Value,
    next: &Value,
    old_audit: &Value,
    bundle: &Value,
) -> AppResult<HashSet<String>> {
    let mut removed = HashSet::new();
    for reference in rows(&old["student"]["assets"]) {
        let id = s(&reference, "assetId");
        if rows(&next["student"]["assets"])
            .iter()
            .any(|r| r == &reference)
        {
            continue;
        }
        let p = rows(&next["sourceAudit"]["assetProvenance"])
            .into_iter()
            .find(|p| p["assetId"] == id && p["evidenceOnly"] == true && p["type"] == "table")
            .ok_or_else(|| bad("不能移除未证明为重复表格的学生图片。"))?;
        let original = rows(&old_audit["sourceAudit"]["assetProvenance"])
            .into_iter()
            .find(|a| {
                a["asset_id"] == p["asset_id"]
                    && a["source_key"] == p["source_key"]
                    && a["type"] == "table"
                    && a["placement"] == p["placement"]
            })
            .ok_or_else(|| bad("重复表格必须有原始素材类型和位置证据。"))?;
        let expected_id = format!(
            "legacy-{}-{}",
            s(&old["sourceIdentity"], "examId"),
            original["asset_id"]
                .as_u64()
                .map(|n| n.to_string())
                .unwrap_or_else(|| s(&original, "asset_id").to_owned())
        );
        if id != expected_id || p["sha256"] != reference["sha256"] {
            return Err(bad("重复表格身份或内容哈希不匹配。"));
        }
        let evidence = rows(&bundle["sourceAudit"]["evidenceAssetPayloads"])
            .into_iter()
            .find(|a| {
                a["assetId"] == id
                    && a["sha256"] == reference["sha256"]
                    && a["mimeType"] == reference["mimeType"]
            })
            .ok_or_else(|| bad("重复表格原图片须保留到来源审计。"))?;
        let data = base64::engine::general_purpose::STANDARD
            .decode(s(&evidence, "dataBase64"))
            .map_err(|_| bad("审计表格图片编码无效。"))?;
        if sha(&data) != s(&reference, "sha256") {
            return Err(bad("审计表格图片哈希不匹配。"));
        }
        removed.insert(id.to_owned());
    }
    for key in ["student", "teacher"] {
        let expected = rows(&old[key]["assets"])
            .into_iter()
            .filter(|r| key != "student" || !removed.contains(s(r, "assetId")))
            .collect::<Vec<_>>();
        if json!(expected) != next[key]["assets"] {
            return Err(bad("来源刷新不能添加、换版或重排素材。"));
        }
    }
    let expected = rows(&old["assetPayloads"])
        .into_iter()
        .filter(|r| !removed.contains(s(r, "assetId")))
        .collect::<Vec<_>>();
    if json!(expected) != next["assetPayloads"] {
        return Err(bad("来源刷新只能归档已经验证的重复表格素材。"));
    }
    Ok(removed)
}
fn added_issues(old: &Value, next: &Value, bundle: &Value) -> AppResult<()> {
    let original = rows(&old["sourceIssues"]);
    let updated = rows(&next["sourceIssues"]);
    if original.iter().any(|i| !updated.contains(i)) {
        return Err(bad("来源刷新不能移除原有阻塞问题。"));
    }
    for issue in updated.iter().filter(|i| !original.contains(i)) {
        let findings = rows(&next["sourceAudit"]["reviewFindings"]);
        if !findings.iter().any(|f| {
            f["examId"] == next["sourceIdentity"]["examId"]
                && f["occurrenceId"] == next["sourceIdentity"]["occurrenceId"]
                && f["contentHash"] == next["sourceIdentity"]["contentHash"]
                && f["originalPdfSha256"] == bundle["original"]["sha256"]
                && f["code"] == issue["code"]
                && f["message"] == issue["message"]
                && f["blocking"] == true
        }) {
            return Err(bad("新增来源问题须绑定原卷哈希及本题身份。"));
        }
    }
    Ok(())
}
pub(super) fn run(store: &Store, payload: &Value, cancel: &AtomicBool) -> AppResult<Value> {
    if payload.to_string().len() > MAX_BUNDLE_BYTES {
        return Err(bad("整卷来源包超过 64 MB。"));
    }
    let op = operation(payload)?;
    let hash = hash_json(payload);
    let mut record = store.document("imports", s(payload, "importId"))?;
    if replay(&record, op, &hash)? {
        return Ok(json!({"import":record}));
    }
    revision(&record, payload)?;
    if !record["structuredSource"].is_object()
        || !rows(&record["publishedQuestionIds"]).is_empty()
        || record["pendingPublication"].is_object()
        || rows(&record["questions"]).iter().any(|q| {
            q["reviewDecision"] != "pending"
                || !s(q, "reviewBasis").is_empty()
                || q["reviewChecks"]
                    .as_object()
                    .is_none_or(|o| o.values().any(|v| v != false))
        })
    {
        return Err(bad("只有尚未审核或发布的整卷可刷新来源传输。"));
    }
    let prior = record.clone();
    let original = read_source(store, &record)?;
    let bundle = &payload["bundle"];
    if bundle["schemaVersion"] != 1
        || bundle["kind"] != "legacy_exam_bundle_v1"
        || bundle["exam"] != record["structuredSource"]["exam"]
        || bundle["expectedQuestionCount"] != record["structuredSource"]["expectedQuestionCount"]
        || s(&bundle["original"], "sha256") != sha(&original)
    {
        return Err(bad("来源刷新须保持整卷身份、题数和原始 PDF 不变。"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(s(&bundle["original"], "contentBase64"))
        .map_err(|_| bad("原卷编码无效。"))?;
    if bytes != original {
        return Err(bad("来源刷新不能替换原始 PDF。"));
    }
    let old_audit: Value = serde_json::from_slice(&std::fs::read(
        store
            .data_dir
            .join(s(&record["structuredSource"], "auditRelativePath")),
    )?)?;
    let current = rows(&record["questions"]);
    let inputs = rows(&bundle["questions"]);
    if current.len() != inputs.len() {
        return Err(bad("来源刷新不能添加或删除原卷题目。"));
    }
    let mut updated = vec![];
    for (index, (old, input)) in current.iter().zip(&inputs).enumerate() {
        for key in [
            "sourceIdentity",
            "questionType",
            "sourceLabel",
            "pages",
            "answer",
            "solution",
            "legacyReferences",
        ] {
            if old[key] != input[key] {
                return Err(bad(
                    "来源刷新不能替换原题身份、内容版本、题号、页码或答案。",
                ));
            }
        }
        let removed = table_removals(old, input, &old_audit["questions"][index], bundle)?;
        let mut used = HashSet::new();
        checked_text(s(old, "stem"), s(input, "stem"), &removed, &mut used)?;
        for (field, body) in [("options", "text"), ("parts", "prompt")] {
            let a = rows(&old[field]);
            let b = rows(&input[field]);
            if a.len() != b.len() {
                return Err(bad("来源刷新不能添加或删除选项和小问。"));
            }
            for (a, b) in a.iter().zip(&b) {
                for key in if field == "options" {
                    &["label"][..]
                } else {
                    &["partId", "answer", "solution"][..]
                } {
                    if a[key] != b[key] {
                        return Err(bad("来源刷新不能替换选项或小问身份及答案。"));
                    }
                }
                for key in ["label", "parentPartId"] {
                    if field == "parts" && a.get(key).is_some() && a[key] != b[key] {
                        return Err(bad("来源刷新不能覆盖已有小问标签或层级。"));
                    }
                }
                checked_text(s(a, body), s(b, body), &removed, &mut used)?;
            }
        }
        if removed != used {
            return Err(bad("移出的表格素材必须逐一在同位置 HTML 表格中得到对应。"));
        }
        added_issues(old, input, bundle)?;
        let mut next = old.clone();
        for key in [
            "stem",
            "options",
            "parts",
            "student",
            "teacher",
            "assetPayloads",
            "sourceIssues",
        ] {
            next[key] = input[key].clone();
        }
        next = normalize_question_inner(
            &next,
            s(old, "questionId"),
            record["source"]["physicalPages"].as_u64().unwrap_or(0) as usize,
            true,
        )?;
        verify_assets(&next)?;
        next["reviewIssues"] = json!(question_issues(&next, &json!([])));
        updated.push(next);
    }
    duplicates::annotate(&store.bank, &mut updated)?;
    cancelled(cancel)?;
    let audit = safe_audit(bundle);
    let path = store
        .data_dir
        .join("imports")
        .join(s(&record, "importId"))
        .join(format!(
            "source-bundle-refresh-{}.json",
            &hash_json(&json!(op))[..24]
        ));
    if path.exists() {
        let saved: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
        if saved != audit {
            return Err(bad("已有刷新审计文件不同，不能覆盖。"));
        }
    } else {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)?;
        file.write_all(&serde_json::to_vec_pretty(&audit)?)?;
        file.sync_all()?;
    }
    let mut history = rows(&record["structuredSource"]["auditHistory"]);
    history.push(json!({"auditRelativePath":record["structuredSource"]["auditRelativePath"],"auditSha256":record["structuredSource"]["auditSha256"],"operationId":op,"at":now()}));
    record["structuredSource"]["auditHistory"] = json!(history);
    record["structuredSource"]["auditSha256"] = json!(hash_json(&audit));
    record["structuredSource"]["auditRelativePath"] = json!(
        path.strip_prefix(&store.data_dir)
            .map_err(|_| bad("审计路径无效。"))?
            .to_string_lossy()
            .replace('\\', "/")
    );
    record["questions"] = json!(updated);
    finish(&mut record, op, &hash, "structured_source_refresh");
    save_cas(store, Some(&prior), &record)?;
    Ok(json!({"import":record}))
}
