//! Source-bound model first review. Opinions never mutate question contents or
//! masquerade as a teacher check, and are invalidated by any content change.
use super::*;

pub(super) fn content_hash(q: &Value) -> String {
    let mut content = serde_json::Map::new();
    for key in [
        "questionId",
        "questionType",
        "stem",
        "options",
        "parts",
        "answer",
        "solution",
        "pages",
        "sourceLabel",
        "sourceIdentity",
        "sourceBlockIds",
        "student",
        "teacher",
        "assetPayloads",
        "sourceIssues",
    ] {
        content.insert(key.to_owned(), q[key].clone());
    }
    // New role evidence participates in new opinions without invalidating the
    // content hashes of historical imports that predate this optional field.
    if let Some(roles) = q.get("sourceMaterialRoles") {
        content.insert("sourceMaterialRoles".to_owned(), roles.clone());
    }
    hash_json(&Value::Object(content))
}
fn hard_problem(q: &Value, record: &Value) -> Option<String> {
    if paddle::uses(q)
        && (q["sourceIdentity"]["sourceSha256"] != record["source"]["sha256"]
            || q["sourceIdentity"]["manifestSha256"] != record["ocrSource"]["manifestSha256"])
    {
        return Some("题目身份与已保存原卷材料不匹配。".into());
    }
    if !question_issues(q, &record["sourceIssues"]).is_empty() {
        return Some("原文、公式或图表仍有保真问题，修正后再处理。".into());
    }
    if let Err(error) = teaching::verify_source_material(q) {
        return Some(error.message);
    }
    if matches!(s(q, "questionType"), "single_choice" | "multiple_choice")
        && (rows(&q["options"]).len() < 2
            || rows(&q["options"])
                .iter()
                .any(|o| s(o, "text").trim().is_empty()))
    {
        return Some("选择题选项不完整，请补齐原卷选项。".into());
    }
    if rows(&q["duplicateCandidates"])
        .iter()
        .any(|c| c["exact"] == true)
    {
        return Some("此题已存在于题库，不能重复入库。".into());
    }
    None
}
pub(super) fn model_ready(q: &Value, record: &Value) -> bool {
    let review = &q["modelReview"];
    s(q, "reviewDecision") != "reject"
        && review["status"] == "ready"
        && matches!(s(review,"confidence"), "high"|"medium"|"low")
        && rows(&review["issues"]).is_empty()
        && review["contentSha256"] == content_hash(q)
        && review["evidence"]["sourceSha256"] == record["source"]["sha256"]
        && review["evidence"]["ocrManifestSha256"] == record["ocrSource"]["manifestSha256"]
        && review["evidence"]["extractedPagesSha256"] == hash_json(&record["extractedPages"])
        && hard_problem(q, record).is_none()
        && (q.get("teachingWorkflow").is_none() || teaching::ready(q))
}
pub(super) fn eligibility(record: &Value) -> Value {
    let published = ids(&record["publishedQuestionIds"]);
    let mut result = serde_json::Map::new();
    for q in rows(&record["questions"]) {
        let id = s(&q, "questionId");
        let hard = hard_problem(&q, record);
        let teacher = s(&q, "reviewDecision") == "approve" && check_approved(&q, record).is_ok();
        let model = model_ready(&q, record);
        let eligible = !published.contains(&id.to_owned()) && hard.is_none() && (teacher || model);
        let reason = hard.unwrap_or_else(|| {
            if published.contains(&id.to_owned()) {
                "已入库".into()
            } else if teacher {
                "已由教师核对".into()
            } else if model {
                "模型检查未发现疑点，可确认入库".into()
            } else if !teaching::reason(&q).is_empty() {
                teaching::reason(&q)
            } else if q["modelReview"]["status"] == "needs_review" {
                s(&q["modelReview"], "summary").to_owned()
            } else {
                "尚未完成模型检查或人工核对".into()
            }
        });
        // Match apply_to_entry exactly; this describes the prospective payload,
        // not a new eligibility gate or an independent correctness claim.
        let publication_scope = if teaching::ready(&q) {"source_and_teaching"} else {"source_only"};
        result.insert(id.to_owned(),json!({"eligible":eligible,"method":if teacher {json!("teacher_review")} else if model {json!("model_review")}else{Value::Null},"reason":reason,"publicationScope":publication_scope,"sourceMaterialFindings":teaching::source_material_findings(&q)}));
    }
    Value::Object(result)
}
fn import_response_question_hash_matches(
    raw: &Value,
    index: usize,
    expected: &Value,
    source_bound: bool,
) -> bool {
    let Some(original) = raw["questions"].get(index).filter(|q| q.is_object()) else {
        return false;
    };
    if hash_json(original) == *expected {
        return true;
    }
    // Historic source batches bound the known contract-normalized clone instead
    // of the provider question. Recompute only that identity compatibility from
    // the preserved provider bytes, never from the current/asset-bound question.
    source_bound
        && source_batches::canonical_source_contract(&json!({"questions":[original]}))
            .is_ok_and(|canonical| hash_json(&canonical["questions"][0]) == *expected)
}
pub(super) fn verify_opinion(store: &Store, q: &Value, record: &Value) -> AppResult<()> {
    if !model_ready(q, record) {
        return Err(err(
            "review_required",
            "本题模型检查未通过或内容已更改，请重新检查或人工核对。",
        ));
    }
    verify_bound_opinion(store, q, record)
}
/// Optional correction display shares the same preserved request/response
/// proof as publication, without treating a needs-review opinion as ready.
pub(super) fn verify_display_opinion(store: &Store, q: &Value, record: &Value) -> AppResult<()> {
    if q["modelReview"]["origin"] != "import" || q["modelReview"]["status"] != "needs_review"
        || q["modelReview"]["contentSha256"] != content_hash(q)
        || q["modelReview"]["evidence"]["imageReviewAvailable"] != true {
        return Err(err("review_audit_changed", "修正展示缺少当前原题的原页核对依据。"));
    }
    let root=store.data_dir.join("imports").canonicalize()?;
    let owned=root.join(s(record,"importId")).canonicalize()?;
    if !owned.starts_with(&root) {return Err(err("review_audit_changed","修正展示不属于当前原卷。"));}
    for key in ["relativePath","requestRelativePath"] {
        if !store.data_dir.join(s(&q["modelReview"]["audit"],key)).canonicalize()?.starts_with(&owned) {
            return Err(err("review_audit_changed","修正展示审计不属于当前原卷。"));
        }
    }
    verify_bound_opinion(store, q, record)
}
fn verify_bound_opinion(store: &Store, q: &Value, record: &Value) -> AppResult<()> {
    let review = &q["modelReview"];
    let root = store.data_dir.join("imports").canonicalize()?;
    let path = store
        .data_dir
        .join(s(&review["audit"], "relativePath"))
        .canonicalize()
        .map_err(|_| {
            err(
                "review_audit_changed",
                "模型检查响应文件缺失，请重新检查或人工核对后再入库。",
            )
        })?;
    if !path.starts_with(&root)
        || std::fs::metadata(&path)?.len() > 2 * 1024 * 1024
        || sha(&std::fs::read(&path)?) != review["audit"]["sha256"]
    {
        return Err(err(
            "review_audit_changed",
            "模型检查审计校验失败，未加入题库。",
        ));
    }
    let response: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    let raw: Value = serde_json::from_str(s(&response["choices"][0]["message"], "content"))
        .map_err(|_| err("review_audit_changed", "模型检查响应已损坏。"))?;
    let integrated = review["origin"] == "import";
    let response_index = review["audit"]["responseQuestionIndex"]
        .as_u64()
        .unwrap_or(u64::MAX) as usize;
    let input = if integrated {
        if review["audit"]["task"] != "question_import"
            || !import_response_question_hash_matches(
                &raw,
                response_index,
                &review["audit"]["responseQuestionSha256"],
                paddle::uses(q),
            )
        {
            return Err(err(
                "review_audit_changed",
                "导入响应未绑定当前题目的检查意见。",
            ));
        }
        imported_opinion(&raw, response_index, q)?
    } else {
        raw.clone()
    };
    let normalized = normalize_opinion(
        &input,
        q,
        record,
        review["evidence"]["imageReviewAvailable"] == true,
    )?;
    for field in [
        "status",
        "confidence",
        "summary",
        "issues",
        "contentSha256",
        "evidence",
    ] {
        if normalized[field] != review[field] {
            return Err(err(
                "review_audit_changed",
                "模型检查意见与响应不一致，未加入题库。",
            ));
        }
    }
    let request_path = store
        .data_dir
        .join(s(&review["audit"], "requestRelativePath"))
        .canonicalize()
        .map_err(|_| {
            err(
                "review_audit_changed",
                "模型检查请求文件缺失，请重新检查后再入库。",
            )
        })?;
    if !request_path.starts_with(&root) || std::fs::metadata(&request_path)?.len() > 8 * 1024 * 1024
    {
        return Err(err("review_audit_changed", "模型检查请求路径或大小无效。"));
    }
    let request_bytes = std::fs::read(request_path)?;
    if sha(&request_bytes) != review["audit"]["requestSha256"] {
        return Err(err("review_audit_changed", "模型检查请求校验失败。"));
    }
    let request: Value = serde_json::from_slice(&request_bytes)?;
    if (integrated
        && (request["task"] != "question_import"
            || request["origin"] != "import"
            || request["responseQuestionIndex"] != review["audit"]["responseQuestionIndex"]
            || request["responseQuestionSha256"] != review["audit"]["responseQuestionSha256"]
            || request["context"]["sourceSha256"] != record["source"]["sha256"]))
        || (!integrated && request["task"] != "question_import_review")
        || request["contentSha256"] != content_hash(q)
        || request["evidence"] != review["evidence"]
        || request["model"] != review["model"]
    {
        return Err(err(
            "review_audit_changed",
            "模型检查请求未绑定当前题目与原卷。",
        ));
    }
    if integrated && review["model"]["identityEvidence"]["kind"] == "provider_request_receipt"
        && source_model_identity(store, &path)? != review["model"]
    {
        return Err(err("review_audit_changed", "来源模型归因与已保存实际请求不一致。"));
    }
    Ok(())
}
fn original_context(
    record: &Value,
    q: &Value,
    document: Option<&crate::ocr::OcrDocument>,
) -> AppResult<Value> {
    let pages = rows(&q["pages"]);
    if pages.is_empty() {
        return Err(err(
            "review_source_missing",
            "本题缺少原卷页码，不能仅根据题目自身检查。",
        ));
    }
    let mut originals = vec![];
    for page in &pages {
        let index = page
            .as_u64()
            .and_then(|p| p.checked_sub(1))
            .ok_or_else(|| err("review_source_missing", "原卷页码无效。"))?
            as usize;
        let text = record["extractedPages"][index]
            .as_str()
            .filter(|t| !t.trim().is_empty())
            .ok_or_else(|| {
                err(
                    "review_source_missing",
                    "缺少已保存的原始识别文本，请重新导入或人工核对。",
                )
            })?;
        let mut original = json!({"page":page,"text":text});
        if let Some(document) = document {
            original["layout"] = document.pages.get(index).cloned().unwrap_or(Value::Null);
        }
        originals.push(original);
    }
    let fields = [
        "questionId",
        "questionType",
        "stem",
        "options",
        "parts",
        "answer",
        "solution",
        "pages",
        "sourceLabel",
        "sourceBlockIds",
    ];
    let mut question = serde_json::Map::new();
    for field in fields {
        question.insert(field.to_owned(), q[field].clone());
    }
    Ok(
        json!({"source":{"sha256":record["source"]["sha256"],"filename":record["filename"],"pages":originals},"questions":[question],"reviewScope":{"questionType":q["questionType"],"optionsApplicable":matches!(s(q,"questionType"),"single_choice"|"multiple_choice"),"extractedAnswerPresent":review_requirements(q).contains(&"answerChecked"),"extractedSolutionPresent":review_requirements(q).contains(&"solutionChecked"),"sourceAbsenceUnknownFromEmptyFields":true,"requiredChecks":review_requirements(q)}}),
    )
}
pub(super) fn normalize_opinion(value: &Value, q: &Value, record: &Value, images: bool) -> AppResult<Value> {
    let values = value["questions"]
        .as_array()
        .filter(|v| v.len() == 1)
        .ok_or_else(|| {
            err(
                "model_review_invalid",
                "模型检查未返回唯一题目意见，未放行。",
            )
        })?;
    let result = &values[0];
    if result["questionId"] != q["questionId"]
        || !matches!(s(result, "status"), "ready" | "needs_review")
        || !matches!(s(result, "confidence"), "high" | "medium" | "low")
    {
        return Err(err(
            "model_review_invalid",
            "模型检查身份或状态无效，未放行。",
        ));
    }
    let summary = bounded_text(s(result, "summary"), 3000, "检查理由")?;
    if summary.trim().is_empty() {
        return Err(err(
            "model_review_invalid",
            "模型没有说明检查依据，未放行。",
        ));
    }
    let mut issues = vec![];
    for issue in result["issues"]
        .as_array()
        .filter(|v| v.len() <= 40)
        .ok_or_else(|| err("model_review_invalid", "模型检查疑点结构无效。"))?
    {
        let message = bounded_text(s(issue, "message"), 1000, "疑点")?;
        if message.trim().is_empty() {
            return Err(err("model_review_invalid", "模型检查疑点缺少说明。"));
        }
        let mut normalized_issue = json!({"field":bounded_text(s(issue,"field"),40,"疑点位置")?,"message":message});
        if let Some(correction) = source_display::normalize_model_correction(&issue["correction"], q, record, images) {
            normalized_issue["correction"] = correction;
        }
        issues.push(normalized_issue);
    }
    let evidence = rows(&result["evidencePages"]);
    let pages = rows(&q["pages"]);
    if evidence.is_empty()
        || evidence.iter().any(|page| !pages.contains(page))
        || pages.iter().any(|page| !evidence.contains(page))
    {
        return Err(err(
            "model_review_invalid",
            "模型检查未完整绑定本题真实原文页码，未放行。",
        ));
    }
    let body = json!([q["stem"], q["options"], q["parts"]]).to_string();
    if !images && (body.contains("asset:") || rows(&q["sourceMaterialRoles"]).iter().any(|role| role["requiresVisualReview"] == true)) {
        issues.push(json!({"field":"image","message":"当前模型未实际接收原图，配图需人工对照。"}));
    }
    if let Some(problem) = hard_problem(q, record) {
        issues.push(json!({"field":"source","message":problem}));
    }
    let ready = result["status"] == "ready" && issues.is_empty();
    Ok(
        json!({"schemaVersion":1,"status":if ready {"ready"}else{"needs_review"},"confidence":result["confidence"],"summary":summary,"issues":issues,"contentSha256":content_hash(q),"reviewedAt":now(),"evidence":{"pages":evidence,"sourceSha256":record["source"]["sha256"],"ocrManifestSha256":record["ocrSource"]["manifestSha256"],"extractedPagesSha256":hash_json(&record["extractedPages"]),"imageReviewAvailable":images},"method":"model_review","disclaimer":"模型检查意见，非独立数学证明或教师审核"}),
    )
}
fn preserve_request_audit(store: &Store, path: &Path, bytes: &[u8]) -> AppResult<()> {
    let root = store.data_dir.join("imports").canonicalize()?;
    if !path
        .parent()
        .ok_or_else(|| err("review_audit_changed", "检查请求位置无效。"))?
        .canonicalize()?
        .starts_with(&root)
    {
        return Err(err("review_audit_changed", "检查请求不在当前原卷范围内。"));
    }
    let compare = || -> AppResult<()> {
        let actual = path.canonicalize()?;
        if !actual.starts_with(&root)
            || std::fs::metadata(&actual)?.len() > 8 * 1024 * 1024
            || std::fs::read(actual)? != bytes
        {
            return Err(err(
                "review_audit_conflict",
                "已保存的检查请求与本次内容不一致，原文件保留，未覆盖。",
            ));
        }
        Ok(())
    };
    match std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
    {
        Ok(mut file) => {
            file.write_all(bytes)?;
            file.sync_all()?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => compare(),
        Err(error) => Err(error.into()),
    }
}
fn source_model_identity(store: &Store, response_path: &Path) -> AppResult<Value> {
    let receipt = response_path.with_extension("request.json");
    let unknown = || json!({"profileId":null,"name":null,"model":null,"baseUrl":null,"reasoningEffort":null,"identityEvidence":{"kind":"unavailable"}});
    if !receipt.exists() {
        return Ok(unknown());
    }
    let root = store.data_dir.join("imports").canonicalize()?;
    let path = receipt.canonicalize()?;
    if !path.starts_with(&root) || std::fs::metadata(&path)?.len() > 45 * 1024 * 1024 {
        return Err(err("review_audit_changed", "来源模型请求路径或大小无效。"));
    }
    let bytes = std::fs::read(&path)?;
    let request: Value = serde_json::from_slice(&bytes)?;
    let actual = request["body"]["model"].as_str().filter(|v| !v.is_empty() && v.len() <= 200 && !v.chars().any(char::is_control));
    let Some(actual) = actual else { return Ok(unknown()); };
    if request.get("bodySha256").is_some() && request["bodySha256"] != hash_json(&request["body"]) {
        return Err(err("review_audit_changed", "来源模型请求正文校验失败。"));
    }
    let saved = &request["sourceModelIdentity"];
    if saved.is_object() && saved["model"] != actual {
        return Err(err("review_audit_changed", "来源模型快照与实际请求模型不一致。"));
    }
    // A historic receipt's body proves its model, not which current profile or
    // credential produced it. Only an identity frozen in that receipt can do so.
    Ok(json!({"profileId":saved["profileId"],"name":saved["name"],"model":actual,
        "baseUrl":saved["baseUrl"],"reasoningEffort":saved["reasoningEffort"],
        "identityEvidence":{"kind":"provider_request_receipt","relativePath":audit_relative_path(store,&path)?,"sha256":sha(&bytes)}}))
}

fn imported_opinion(raw: &Value, index: usize, q: &Value) -> AppResult<Value> {
    let original = raw["questions"]
        .get(index)
        .ok_or_else(|| err("import_review_invalid", "导入检查意见缺少对应题目。"))?;
    if s(original, "sourceLabel").trim() != s(q, "sourceLabel") || original["pages"] != q["pages"] {
        return Err(err(
            "import_review_invalid",
            "导入检查意见与原题号或页码不匹配。",
        ));
    }
    let mut opinion = original["review"]
        .as_object()
        .map(|v| Value::Object(v.clone()))
        .ok_or_else(|| {
            err(
                "import_review_missing",
                "导入已完成，但模型未返回本题检查意见；可点击重新检查。",
            )
        })?;
    opinion["questionId"] = q["questionId"].clone();
    Ok(json!({"questions":[opinion]}))
}
/// The upload's one parsing response also carries its own source comparison.
/// Missing/malformed opinions never discard faithful parsed content, and never
/// trigger an unrequested second model call.
pub(super) fn attach_import_opinions(
    store: &Store,
    _model: &ModelClient,
    record: &Value,
    raw: &Value,
    context: &Value,
    response_path: &Path,
    questions: &mut [Value],
) -> AppResult<()> {
    let image_available = context["imageReviewAvailable"] == true;
    let provider_sha = sha(&std::fs::read(response_path)?);
    let provider_relative = audit_relative_path(store, &response_path.canonicalize()?)?;
    let identity = source_model_identity(store, response_path)?;
    for (index, q) in questions.iter_mut().enumerate() {
        let outcome = (|| -> AppResult<Value> {
            // Ensure actual preserved source pages exist independently from the
            // newly returned question, including for TXT-only uploads.
            original_context(record, q, None)?;
            let opinion = imported_opinion(raw, index, q)?;
            let mut result = normalize_opinion(&opinion, q, record, image_available)?;
            result["origin"] = json!("import");
            result["model"] = identity.clone();
            let request = json!({"schemaVersion":1,"task":"question_import","origin":"import","context":context,"contentSha256":result["contentSha256"],"evidence":result["evidence"],"model":identity,"responseQuestionIndex":index,"responseQuestionSha256":hash_json(&raw["questions"][index]),"sourceLabel":q["sourceLabel"]});
            let request_path = response_path.with_file_name(format!(
                "{}-opinion-v2-q{index}.request.json",
                response_path
                    .file_stem()
                    .and_then(|v| v.to_str())
                    .unwrap_or("import")
            ));
            let request_bytes = serde_json::to_vec_pretty(&request)?;
            preserve_request_audit(store, &request_path, &request_bytes)?;
            result["audit"] = json!({"task":"question_import","origin":"import","relativePath":provider_relative,"sha256":provider_sha,"requestRelativePath":audit_relative_path(store,&request_path.canonicalize()?)?,"requestSha256":sha(&request_bytes),"responseQuestionIndex":index,"responseQuestionSha256":hash_json(&raw["questions"][index])});
            Ok(result)
        })();
        match outcome {
            Ok(result) => q["modelReview"] = result,
            Err(error) => {
                q["modelReview"] = json!({"schemaVersion":1,"origin":"import","status":"failed","confidence":"low","summary":error.message,"error":error,"contentSha256":content_hash(q),"reviewedAt":now(),"method":"model_review","model":identity})
            }
        }
    }
    Ok(())
}
pub(super) fn process(
    store: &Store,
    model: &ModelClient,
    op: &str,
    hash: &str,
    cancel: &AtomicBool,
    mut record: Value,
) -> AppResult<()> {
    read_source(store, &record)?;
    paddle::verify_audit(store, &record)?;
    let document = if record["ocrSource"].is_object() {
        Some(paddle::load_document(store, &record)?)
    } else {
        None
    };
    let id = s(&record, "importId").to_owned();
    let job_id = record["backgroundJob"]["jobId"].clone();
    let targets = rows(&record["backgroundJob"]["targetQuestionIds"]);
    let mut failed = 0usize;
    let settings = model.public_settings();
    for (position, target) in targets.iter().enumerate() {
        cancelled(cancel)?;
        record = store.document("imports", &id)?;
        if record["backgroundJob"]["jobId"] != job_id {
            return Err(err("job_changed", "模型检查任务已变更，未覆盖新结果。"));
        }
        let index = rows(&record["questions"])
            .iter()
            .position(|q| q["questionId"] == *target)
            .ok_or_else(|| err("question_changed", "检查题目身份已变更。"))?;
        let q = record["questions"][index].clone();
        let audit_dir = store
            .data_dir
            .join("imports")
            .join(&id)
            .join("review-audits");
        std::fs::create_dir_all(&audit_dir)?;
        let path = audit_dir.join(format!("{}-{position}.json", &hash_json(&json!(op))[..24]));
        let outcome = (|| -> AppResult<Value> {
            let mut context = original_context(&record, &q, document.as_ref())?;
            let pages = rows(&q["pages"]);
            let assets = document
                .as_ref()
                .map(|doc| {
                    doc.assets
                        .iter()
                        .filter(|a| pages.contains(&a["page"]))
                        .cloned()
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let images = model.import_review_images_supported() && !assets.is_empty();
            context["imageReviewAvailable"] = json!(images);
            if path.exists() {
                return Err(err(
                    "operation_conflict",
                    "检查审计已存在，请使用新的操作重试。",
                ));
            }
            let raw = model.propose_review_with_audit(&context, &assets, cancel, &path)?;
            let mut result = normalize_opinion(&raw, &q, &record, images)?;
            let profile = rows(&settings["profiles"])
                .into_iter()
                .find(|p| p["id"] == settings["activeProfileId"])
                .unwrap_or(Value::Null);
            result["origin"] = json!("recheck");
            result["model"] = json!({"profileId":settings["activeProfileId"],"name":profile["name"],"model":settings["model"],"baseUrl":settings["baseUrl"]});
            let request_path = path.with_extension("request.json");
            let request = json!({"schemaVersion":1,"task":"question_import_review","origin":"recheck","context":context,"contentSha256":result["contentSha256"],"evidence":result["evidence"],"model":result["model"],"sourceAssetHashes":assets.iter().map(|asset|json!({"id":asset["id"],"page":asset["page"],"sha256":asset["sha256"]})).collect::<Vec<_>>()});
            let request_bytes = serde_json::to_vec_pretty(&request)?;
            preserve_request_audit(store, &request_path, &request_bytes)?;
            result["audit"] = json!({"task":"question_import_review","origin":"recheck","relativePath":audit_relative_path(store,&path.canonicalize()?)?,"sha256":sha(&std::fs::read(&path)?),"requestRelativePath":audit_relative_path(store,&request_path.canonicalize()?)?,"requestSha256":sha(&request_bytes)});
            Ok(result)
        })();
        let saved = record.clone();
        match outcome {
            Ok(opinion) => record["questions"][index]["modelReview"] = opinion,
            Err(error) => {
                if error.code == "cancelled" {
                    return Err(error);
                }
                failed += 1;
                record["questions"][index]["modelReview"] = json!({"schemaVersion":1,"status":"failed","confidence":"low","summary":error.message,"error":error,"contentSha256":content_hash(&q),"reviewedAt":now(),"method":"model_review"});
            }
        }
        record["backgroundJob"]["completedQuestions"] = json!(position + 1);
        record["backgroundJob"]["failedQuestions"] = json!(failed);
        save_cas(store, Some(&saved), &record)?;
    }
    cancelled(cancel)?;
    let saved = record.clone();
    record["backgroundJob"]["status"] = json!(if failed > 0 { "failed" } else { "completed" });
    record["backgroundJob"]["finishedAt"] = json!(now());
    record["backgroundJob"]["error"] = if failed > 0 {
        json!({"code":"model_review_incomplete","message":format!("{failed} 题检查未完成；原题保留，可重试或人工核对。")})
    } else {
        Value::Null
    };
    finish(&mut record, op, hash, "model_review");
    save_cas(store, Some(&saved), &record)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Store, Value) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("model-settings.json"), b"{}").unwrap();
        let store = Store::open(dir.path(), &crate::bank::tests::seed()).unwrap();
        let id = "simulated-model-review";
        let mut source =
            save_source(&store, id, "txt", b"Simulated original: calculate 1+1.").unwrap();
        source["physicalPages"] = json!(1);
        let q=normalize_question(&json!({"questionType":"fill_blank","stem":"Simulated original: calculate 1+1.","sourceLabel":"1","pages":[1],"answer":"","solution":"","options":[],"parts":[]}),"simulated-review-q",1).unwrap();
        let record = json!({"importId":id,"filename":"simulated-review.txt","source":source,"sourceIssues":[],"extractedPages":["Simulated original: calculate 1+1."],"status":"pending_review","revision":1,"questions":[q],"operations":[],"publishedQuestionIds":[],"publicationHistory":[],"backgroundJob":{"jobId":"simulated-review-job","mode":"review","status":"completed","targetQuestionIds":["simulated-review-q"]}});
        store.put_document("imports", id, &record).unwrap();
        (dir, store, record)
    }
    fn raw(record: &Value) -> Value {
        json!({"questions":[{"questionId":record["questions"][0]["questionId"],"status":"ready","confidence":"high","summary":"Compared source page 1: exact calculation and all original conditions retained; source has no answer or solution.","issues":[],"evidencePages":[1]}]})
    }
    fn source_material_fixture(dimension: &str, field: &str) -> (tempfile::TempDir, Store, Value) {
        let (dir, store, mut record) = fixture();
        let q = &mut record["questions"][0];
        q["reviewDecision"] = json!("approve");
        q["reviewBasis"] = json!("模拟回归：人工核对原题，非真实教师使用证据。");
        q["reviewChecks"] = json!({"sourceMatched":true,"formulaChecked":true,"answerChecked":true,"solutionChecked":true});
        teaching::initialize(q, &json!({"generatedTeaching":{"questionId":q["questionId"],"answer":"2","difficultyAssessment":{"level":"easy","basis":"模拟：直接相加。"},"teachingSolution":"模拟：由1+1=2得答案。","teachingFocusSchemaVersion":2,"teachingFocus":{"examFocus":"模拟加法。","studentRequirements":["计算正确的和。"]},"issues":[]}}));
        let audit = json!({"questionId":q["questionId"],"sourceContentSha256":teaching::source_hash(q),"candidateSha256":hash_json(&teaching::controls::active_candidate(q)),"method":"user_authorized_agent_review","checkedBy":"codex","evidence":"模拟独立核对原题与具体条件。","findings":[{"id":"sim-source-material","dimension":dimension,"fieldPath":field,"reason":"模拟：指定位置仍需核对。"}]});
        teaching::attach_quality_review(q, &audit).unwrap();
        store.put_document("imports", s(&record,"importId"), &record).unwrap();
        (dir, store, record)
    }
    #[test]
    fn simulated_source_material_finding_blocks_teacher_source_only_and_frozen_publication() {
        let (_dir, store, mut record) = source_material_fixture("material", "stem");
        let q = &record["questions"][0];
        let id = s(q,"questionId").to_owned();
        assert_eq!(eligibility(&record)[&id]["eligible"], false);
        assert_eq!(eligibility(&record)[&id]["publicationScope"], "source_only");
        assert_eq!(rows(&eligibility(&record)[&id]["sourceMaterialFindings"]).len(), 1);
        assert_eq!(check_approved(q,&record).unwrap_err().code,"source_content_unresolved");
        let payload = json!({"importId":record["importId"],"expectedRevision":record["revision"],"operationId":"sim-material-publish","acknowledgeReview":true});
        assert_eq!(publish(&store,&payload,&AtomicBool::new(false)).unwrap_err().code,"source_content_unresolved");
        assert!(store.bank.question(&id).is_err());
        assert_eq!(store.document("imports",s(&record,"importId")).unwrap(),record);
        // Simulate an already frozen source-only publication that previously
        // failed at the bank write; the retry must not skip the new source gate.
        record["pendingPublication"] = json!({"operationId":payload["operationId"],"payloadHash":hash_json(&payload),"manifest":{"questions":[{"questionId":id}],"configPatch":{"assemblyIndex":{"entries":[]}}}});
        store.put_document("imports",s(&record,"importId"),&record).unwrap();
        assert_eq!(publish(&store,&payload,&AtomicBool::new(false)).unwrap_err().code,"source_content_unresolved");
        assert!(store.bank.question(&id).is_err());
    }
    #[test]
    fn simulated_teaching_or_unlocated_material_findings_allow_checked_source_only_publication() {
        for (dimension, field) in [("proof","stem"),("material","teachingSolution"),("material",""),("material","parts[0].answer")] {
            let (_dir,store,record) = source_material_fixture(dimension,field);
            let id=s(&record["questions"][0],"questionId");
            assert!(rows(&eligibility(&record)[id]["sourceMaterialFindings"]).is_empty());
            assert_eq!(eligibility(&record)[id]["eligible"],true,"{dimension}/{field}");
            let payload=json!({"importId":record["importId"],"expectedRevision":record["revision"],"operationId":"sim-teaching-source-only","acknowledgeReview":true});
            let result=publish(&store,&payload,&AtomicBool::new(false)).unwrap();
            assert_eq!(result["import"]["publishedQuestionIds"],json!([id]));
            assert!(store.bank.question(id).is_ok());
        }
    }
    #[test]
    fn legacy_source_opinion_hash_accepts_only_provider_or_known_identity_contract() {
        for identity in [
            json!({"options":[{"key":"A","text":"2"},{"key":"B","text":"3"}],"parts":[]}),
            json!({"options":[],"parts":[{"label":"(1)","prompt":"Calculate 1+1.","answer":"","solution":""}]}),
        ] {
            let (_dir, store, mut record) = fixture();
            record["ocrSource"] = json!({"manifestSha256":"simulated-source-manifest"});
            let mut provider_question = record["questions"][0].clone();
            provider_question["options"] = identity["options"].clone();
            provider_question["parts"] = identity["parts"].clone();
            if !rows(&identity["options"]).is_empty() {
                provider_question["questionType"] = json!("single_choice");
            }
            provider_question["review"] = json!({"status":"ready","confidence":"high","summary":"Compared original page; source text retained.","issues":[],"evidencePages":[1]});
            let provider = json!({"questions":[provider_question]});
            let canonical = source_batches::canonical_source_contract(&provider).unwrap();
            let provider_hash = json!(hash_json(&provider["questions"][0]));
            let canonical_hash = json!(hash_json(&canonical["questions"][0]));
            assert_ne!(provider_hash, canonical_hash);
            assert!(import_response_question_hash_matches(&provider, 0, &provider_hash, false));
            assert!(import_response_question_hash_matches(&provider, 0, &canonical_hash, true));
            assert!(!import_response_question_hash_matches(&provider, 0, &canonical_hash, false));
            let mut question = normalize_question(&canonical["questions"][0], "simulated-review-q", 1).unwrap();
            question["sourceIdentity"] = json!({"system":"paddleocr_upload","sourceSha256":record["source"]["sha256"],"manifestSha256":record["ocrSource"]["manifestSha256"]});
            question["sourceMaterialRequirements"] = json!({"studentTables":[],"teacherTables":[]});
            record["questions"] = json!([question]);
            let response_path = store.data_dir.join("imports").join(s(&record,"importId")).join("legacy-provider.json");
            let response_bytes = serde_json::to_vec(&json!({"httpStatus":200,"choices":[{"finish_reason":"stop","message":{"content":provider.to_string()}}]})).unwrap();
            std::fs::write(&response_path, &response_bytes).unwrap();
            let mut questions = rows(&record["questions"]);
            let context = json!({"sourceSha256":record["source"]["sha256"],"imageReviewAvailable":false});
            // Reproduce the old caller exactly: canonical question hash, actual
            // immutable provider response file and unchanged original opinion.
            attach_import_opinions(&store, &ModelClient::open(&store.data_dir).unwrap(), &record, &canonical, &context, &response_path, &mut questions).unwrap();
            assert_eq!(questions[0]["modelReview"]["status"], "ready", "{}", questions[0]["modelReview"]);
            assert_eq!(questions[0]["modelReview"]["audit"]["responseQuestionSha256"], canonical_hash);
            let request_path = store.data_dir.join(s(&questions[0]["modelReview"]["audit"],"requestRelativePath"));
            let request_bytes = std::fs::read(&request_path).unwrap();
            verify_opinion(&store, &questions[0], &record).unwrap();
            assert_eq!(std::fs::read(&response_path).unwrap(), response_bytes);
            assert_eq!(std::fs::read(&request_path).unwrap(), request_bytes);
            for (field, changed) in [
                ("stem", json!("Altered original prose")),
                ("review", json!({"status":"ready","confidence":"high","summary":"Altered opinion","issues":[],"evidencePages":[1]})),
                ("sourceAssetBindingAudit", json!({"derived":true})),
                ("assetPlacements", json!([{"assetId":"derived-hint","target":{"field":"stem"}}])),
            ] {
                let mut derived = canonical["questions"][0].clone();
                derived[field] = changed;
                let derived_hash = json!(hash_json(&derived));
                assert!(!import_response_question_hash_matches(&provider, 0, &derived_hash, true), "{field}");
                let mut forged = questions[0].clone();
                forged["modelReview"]["audit"]["responseQuestionSha256"] = derived_hash;
                assert_eq!(verify_opinion(&store, &forged, &record).unwrap_err().code, "review_audit_changed");
            }
            let mut changed_opinion = questions[0].clone();
            changed_opinion["modelReview"]["summary"] = json!("Altered saved opinion");
            assert_eq!(verify_opinion(&store, &changed_opinion, &record).unwrap_err().code, "review_audit_changed");
        }
    }
    #[test]
    #[ignore = "read-only actual provider fixture; supply TUTOR_REVIEW_PROVIDER_RESPONSE"]
    fn saved_source_provider_legacy_opinion_hash_regression() {
        let path = std::env::var_os("TUTOR_REVIEW_PROVIDER_RESPONSE").expect("provider response path");
        let bytes = std::fs::read(&path).unwrap();
        let response: Value = serde_json::from_slice(&bytes).unwrap();
        let provider: Value = serde_json::from_str(s(&response["choices"][0]["message"],"content")).unwrap();
        let canonical = source_batches::canonical_source_contract(&provider).unwrap();
        let mut normalized = 0;
        for (index, question) in rows(&provider["questions"]).iter().enumerate() {
            let canonical_question = &canonical["questions"][index];
            let hash = json!(hash_json(canonical_question));
            assert!(import_response_question_hash_matches(&provider, index, &json!(hash_json(question)), true));
            assert!(import_response_question_hash_matches(&provider, index, &hash, true));
            normalized += usize::from(question != canonical_question);
            for field in ["stem", "review", "sourceAssetBindingAudit", "assetPlacements"] {
                let mut changed = canonical_question.clone();
                changed[field] = json!("not actual provider content");
                assert!(!import_response_question_hash_matches(&provider, index, &json!(hash_json(&changed)), true));
            }
        }
        assert!(normalized > 0, "fixture must reproduce historic key/part identity normalization");
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
    #[test]
    fn simulated_source_identity_uses_actual_receipt_and_keeps_unknown_historic_profile() {
        let (_dir, store, record) = fixture();
        let root = store.data_dir.join(s(&record["source"], "relativePath")).parent().unwrap().to_path_buf();
        let response = root.join("simulated-old-response.json");
        let body = json!({"model":"simulated-original-source","messages":[]});
        let receipt = json!({"bodySha256":hash_json(&body),"body":body});
        std::fs::write(response.with_extension("request.json"), serde_json::to_vec(&receipt).unwrap()).unwrap();
        let original = std::fs::read(response.with_extension("request.json")).unwrap();
        let identity = source_model_identity(&store, &response).unwrap();
        assert_eq!(identity["model"], "simulated-original-source");
        for field in ["profileId", "name", "baseUrl", "reasoningEffort"] { assert!(identity[field].is_null()); }
        assert_eq!(identity["identityEvidence"]["kind"], "provider_request_receipt");
        assert_eq!(std::fs::read(response.with_extension("request.json")).unwrap(), original);
        assert_eq!(source_model_identity(&store, &root.join("no-receipt.json")).unwrap()["identityEvidence"]["kind"], "unavailable");
    }

    #[test]
    fn simulated_source_identity_accepts_frozen_profile_without_using_current_selector() {
        let (_dir, store, record) = fixture();
        let root = store.data_dir.join(s(&record["source"], "relativePath")).parent().unwrap().to_path_buf();
        let response = root.join("simulated-frozen-response.json");
        let body = json!({"model":"simulated-original-source","messages":[]});
        let receipt = json!({"bodySha256":hash_json(&body),"body":body,"sourceModelIdentity":{"profileId":"simulated-old-profile","model":"simulated-original-source","baseUrl":"http://127.0.0.1:1/v1","reasoningEffort":null}});
        std::fs::write(response.with_extension("request.json"), serde_json::to_vec(&receipt).unwrap()).unwrap();
        let identity = source_model_identity(&store, &response).unwrap();
        assert_eq!(identity["profileId"], "simulated-old-profile");
        assert_eq!(identity["baseUrl"], "http://127.0.0.1:1/v1");
        assert!(identity["reasoningEffort"].is_null());
    }

    #[test]
    fn simulated_source_identity_rejects_changed_receipt_or_model_snapshot_conflict() {
        let (_dir, store, record) = fixture();
        let root = store.data_dir.join(s(&record["source"], "relativePath")).parent().unwrap().to_path_buf();
        let response = root.join("simulated-conflict-response.json");
        let body = json!({"model":"simulated-real-source","messages":[]});
        for receipt in [json!({"bodySha256":"wrong","body":body}),json!({"bodySha256":hash_json(&body),"body":body,"sourceModelIdentity":{"model":"simulated-different-model"}})] {
            std::fs::write(response.with_extension("request.json"), serde_json::to_vec(&receipt).unwrap()).unwrap();
            assert_eq!(source_model_identity(&store,&response).unwrap_err().code,"review_audit_changed");
        }
    }

    #[test]
    fn simulated_model_status_drives_review_but_never_overrides_missing_material_or_specific_doubt() {
        let (_dir, _store, record) = fixture();
        let q = &record["questions"][0];
        let value = raw(&record);
        let clean = normalize_opinion(&value, q, &record, false).unwrap();
        assert_eq!(clean["status"], "ready");
        let mut weak = value.clone();
        weak["questions"][0]["confidence"] = json!("medium");
        assert_eq!(
            normalize_opinion(&weak, q, &record, false).unwrap()["status"],
            "ready"
        );
        let mut issue = value.clone();
        issue["questions"][0]["issues"] =
            json!([{"field":"formula","message":"Unclear original sign"}]);
        assert_eq!(
            normalize_opinion(&issue, q, &record, false).unwrap()["status"],
            "needs_review"
        );
        let mut visual = q.clone();
        visual["stem"] = json!("如图，模拟图形");
        assert_eq!(
            normalize_opinion(&value, &visual, &record, false).unwrap()["status"],
            "ready"
        );
        let mut model_semantic_review = value.clone();
        model_semantic_review["questions"][0]["status"] = json!("needs_review");
        model_semantic_review["questions"][0]["issues"] = json!([{"field":"image","message":"模拟模型对照原文发现此题需要配图但材料未提供，待补充核对。"}]);
        let semantic_opinion = normalize_opinion(&model_semantic_review,&visual,&record,false).unwrap();
        assert_eq!(semantic_opinion["status"],"needs_review");
        assert_eq!(semantic_opinion["issues"][0]["message"],model_semantic_review["questions"][0]["issues"][0]["message"]);
        visual["stem"] = json!("![原卷配图](asset:actual-diagram)");
        assert_eq!(normalize_opinion(&value, &visual, &record, false).unwrap()["status"], "needs_review");
        visual["stem"] = q["stem"].clone();
        visual["sourceMaterialRoles"] = json!([{"assetId":"actual-document-figure","role":"document","requiresVisualReview":true}]);
        assert_eq!(normalize_opinion(&value,&visual,&record,false).unwrap()["status"],"needs_review");
        weak["questions"][0]["status"] = json!("needs_review");
        assert_eq!(normalize_opinion(&weak, q, &record, false).unwrap()["status"], "needs_review");
        let mut missing = record.clone();
        missing["extractedPages"] = json!([]);
        assert_eq!(
            original_context(&missing, q, None).unwrap_err().code,
            "review_source_missing"
        );
        let mut forged = value.clone();
        forged["questions"][0]["evidencePages"] = json!([2]);
        assert_eq!(
            normalize_opinion(&forged, q, &record, false)
                .unwrap_err()
                .code,
            "model_review_invalid"
        );
    }
    #[test]
    fn question_type_and_actual_reference_presence_define_checks_without_hiding_source_loss() {
        let (_dir, store, record) = fixture();
        let q = &record["questions"][0];
        let raw = raw(&record);
        for kind in ["fill_blank", "free_response"] {
            let mut question = q.clone();
            question["questionType"] = json!(kind);
            assert!(rows(&question["options"]).is_empty());
            assert!(hard_problem(&question, &record).is_none());
            assert_eq!(
                review_requirements(&question),
                vec!["sourceMatched", "formulaChecked"]
            );
            let opinion = normalize_opinion(&raw, &question, &record, false).unwrap();
            assert_eq!(opinion["status"], "ready");
            question["modelReview"] = opinion;
            assert!(model_ready(&question, &record));
            let scope = original_context(&record, &question, None).unwrap()["reviewScope"].clone();
            assert_eq!(scope["optionsApplicable"], false);
            assert_eq!(scope["extractedAnswerPresent"], false);
            assert_eq!(scope["extractedSolutionPresent"], false);
            assert_eq!(scope["sourceAbsenceUnknownFromEmptyFields"], true);
        }
        for kind in ["single_choice", "multiple_choice"] {
            let mut question = q.clone();
            question["questionType"] = json!(kind);
            assert!(
                hard_problem(&question, &record)
                    .unwrap()
                    .contains("选择题选项不完整")
            );
            let opinion = normalize_opinion(&raw, &question, &record, false).unwrap();
            assert_eq!(opinion["status"], "needs_review");
            assert!(
                rows(&opinion["issues"])
                    .iter()
                    .any(|i| s(i, "message").contains("选项"))
            );
        }
        // Empty extracted fields do not prove source absence: source-present
        // omissions remain real issues even when the returned confidence is high.
        let reference_text = "模拟原卷条件x>0；题目计算1+1。答案：2。解析：按整数加法1+1=2。";
        let mut reference_record = record.clone();
        reference_record["source"] = save_source(
            &store,
            "simulated-with-reference",
            "txt",
            reference_text.as_bytes(),
        )
        .unwrap();
        reference_record["source"]["physicalPages"] = json!(1);
        reference_record["extractedPages"] = json!([reference_text]);
        assert_eq!(
            read_source(&store, &reference_record).unwrap(),
            reference_text.as_bytes()
        );
        for (field, message) in [
            ("answer", "第1页原卷答案为2，录入答案为空；请补回原文答案。"),
            (
                "solution",
                "第1页原卷附有计算步骤，录入解析为空；请恢复原文步骤。",
            ),
            ("stem", "第1页原文含条件x>0，题干遗漏；请补回该条件。"),
        ] {
            let mut response = raw.clone();
            response["questions"][0]["issues"] = json!([{"field":field,"message":message}]);
            let opinion = normalize_opinion(&response, q, &reference_record, false).unwrap();
            assert_eq!(opinion["status"], "needs_review");
            assert_eq!(opinion["issues"][0]["message"], message);
        }
        let mut broken = record.clone();
        broken["sourceIssues"] = json!([{"code":"source_text_unresolved","page":1,"blocking":true,"message":"模拟原文条件缺失，未完整提取。"}]);
        let opinion = normalize_opinion(&raw, q, &broken, false).unwrap();
        assert_eq!(opinion["status"], "needs_review");
        let mut question = q.clone();
        question["modelReview"] = opinion;
        assert!(!model_ready(&question, &broken));
    }

    #[test]
    fn client_cannot_add_review_and_content_edit_invalidates_previous_opinion() {
        let (_dir, store, mut record) = fixture();
        let mut questions = rows(&record["questions"]);
        questions[0]["modelReview"] = json!({"status":"ready","confidence":"high","contentSha256":content_hash(&questions[0])});
        let saved=review_save(&store,&json!({"importId":record["importId"],"operationId":"simulated-forged-review","expectedRevision":1,"questions":questions})).unwrap()["import"].clone();
        assert!(saved["questions"][0].get("modelReview").is_none());
        record = saved;
        record["questions"][0]["modelReview"] =
            normalize_opinion(&raw(&record), &record["questions"][0], &record, false).unwrap();
        store
            .put_document("imports", s(&record, "importId"), &record)
            .unwrap();
        let mut edits = rows(&record["questions"]);
        edits[0]["stem"] = json!("Simulated edited question 2+2");
        let saved=review_save(&store,&json!({"importId":record["importId"],"operationId":"simulated-stale-review","expectedRevision":record["revision"],"questions":edits})).unwrap()["import"].clone();
        assert_eq!(saved["questions"][0]["modelReview"]["status"], "stale");
        assert_eq!(eligibility(&saved)["simulated-review-q"]["eligible"], false);
    }
    #[test]
    fn same_saved_import_response_reuses_request_audit_but_never_overwrites_conflicting_bytes() {
        let (_dir, store, record) = fixture();
        let model = ModelClient::open(&store.data_dir).unwrap();
        let mut raw_question = record["questions"][0].clone();
        raw_question["review"] = json!({"status":"ready","confidence":"high","summary":"模拟对照原页、条件与所有选项，原文无答案解析。","issues":[],"evidencePages":[1]});
        let raw = json!({"questions":[raw_question]});
        let context = json!({"sourceSha256":record["source"]["sha256"],"document":{"pages":[{"page":1,"text":record["extractedPages"][0]}]},"imageReviewAvailable":false});
        let response_path = store
            .data_dir
            .join("imports")
            .join(s(&record, "importId"))
            .join("saved-provider.json");
        std::fs::write(
            &response_path,
            serde_json::to_vec(&json!({"choices":[{"message":{"content":raw.to_string()}}]}))
                .unwrap(),
        )
        .unwrap();
        let mut questions = rows(&record["questions"]);
        attach_import_opinions(
            &store,
            &model,
            &record,
            &raw,
            &context,
            &response_path,
            &mut questions,
        )
        .unwrap();
        assert_eq!(questions[0]["modelReview"]["status"], "ready");
        let request_path = store.data_dir.join(s(
            &questions[0]["modelReview"]["audit"],
            "requestRelativePath",
        ));
        let before = std::fs::read(&request_path).unwrap();
        // Simulate a crash before the opinion-bearing personal record committed.
        let mut resumed = rows(&record["questions"]);
        attach_import_opinions(
            &store,
            &model,
            &record,
            &raw,
            &context,
            &response_path,
            &mut resumed,
        )
        .unwrap();
        assert_eq!(resumed[0]["modelReview"]["status"], "ready");
        assert_eq!(std::fs::read(&request_path).unwrap(), before);
        verify_opinion(&store, &resumed[0], &record).unwrap();
        let changed = b"simulated conflicting audit bytes";
        std::fs::write(&request_path, changed).unwrap();
        let mut conflict = rows(&record["questions"]);
        attach_import_opinions(
            &store,
            &model,
            &record,
            &raw,
            &context,
            &response_path,
            &mut conflict,
        )
        .unwrap();
        assert_eq!(conflict[0]["modelReview"]["status"], "failed");
        assert_eq!(
            conflict[0]["modelReview"]["error"]["code"],
            "review_audit_conflict"
        );
        assert_eq!(std::fs::read(request_path).unwrap(), changed);
    }

    #[cfg(windows)]
    fn single_response(model: &mut ModelClient, response: Value) -> std::thread::JoinHandle<Value> {
        let response=teaching::simulated_complete_response(response);
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        model.save(&json!({"baseUrl":format!("http://{}/v1",listener.local_addr().unwrap()),"model":"simulated-integrated-import","apiKey":"simulated-only"})).unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(10)))
                .unwrap();
            let mut bytes = vec![];
            let end = loop {
                let mut buffer = [0; 8192];
                let count = stream.read(&mut buffer).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&buffer[..count]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                    let length = header
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("content-length:")
                                .and_then(|v| v.trim().parse::<usize>().ok())
                        })
                        .unwrap();
                    if bytes.len() >= end + 4 + length {
                        break end;
                    }
                }
            };
            let body =
                json!({"choices":[{"message":{"content":response.to_string()}}]}).to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
            serde_json::from_slice(&bytes[end + 4..]).unwrap()
        })
    }
    #[cfg(windows)]
    #[test]
    fn simulated_upload_one_response_contains_opinion_and_old_provider_omission_stays_completed() {
        for opinion_mode in 0..3 {
            let include_opinion = opinion_mode == 0;
            let dir = tempfile::tempdir().unwrap();
            std::fs::write(dir.path().join("model-settings.json"), b"{}").unwrap();
            let mut runtime = crate::Runtime::open(dir.path()).unwrap();
            let cancel = AtomicBool::new(false);
            runtime
                .request(
                    "profile_save",
                    &json!({"nickname":"模拟同次导入检查"}),
                    &cancel,
                )
                .unwrap();
            let mut proposed = json!({"questionType":"fill_blank","stem":"模拟一次导入：计算 $1+1=$____。","sourceLabel":"1","pages":[1],"options":[],"parts":[],"answer":"","solution":"","task":{"label":"模拟加法"}});
            if include_opinion {
                proposed["review"] = json!({"status":"ready","confidence":"high","summary":"对照第1页题号1和加法条件，题干完整；原卷没有答案解析，保留空缺。","issues":[],"evidencePages":[1]});
            }
            if opinion_mode == 2 {
                proposed["review"] = json!({"status":"ready","confidence":0.99,"summary":"模拟错误置信类型","issues":[],"evidencePages":[1]});
            }
            let server = single_response(&mut runtime.model, json!({"questions":[proposed]}));
            let payload = json!({"operationId":"simulated-integrated-upload","filename":"模拟同次导入.txt","contentBase64":base64::engine::general_purpose::STANDARD.encode("模拟一次导入：计算1+1=____。")});
            let accepted = runtime.request("import_start", &payload, &cancel).unwrap();
            let id = accepted["import"]["importId"].clone();
            let request = server.join().unwrap();
            let user: Value =
                serde_json::from_str(request["messages"][1]["content"].as_str().unwrap()).unwrap();
            assert_eq!(user["includeSourcePagesForReview"], true);
            assert!(
                request["messages"][0]["content"]
                    .as_str()
                    .unwrap()
                    .contains("同一次请求")
            );
            let prompt = request["messages"][0]["content"].as_str().unwrap();
            for rule in [
                "只有single_choice和multiple_choice",
                "options=[]是正确结构",
                "不因此降低confidence",
                "若原卷实际有答案",
                "20–50字",
                "原文片段",
            ] {
                assert!(prompt.contains(rule), "missing rule: {rule}");
            }
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
            let completed = loop {
                let result = runtime
                    .request("import_job_get", &json!({"importId":id}), &cancel)
                    .unwrap();
                if !matches!(s(&result["job"], "status"), "queued" | "running") {
                    break result;
                }
                assert!(std::time::Instant::now() < deadline);
                std::thread::sleep(std::time::Duration::from_millis(30));
            };
            assert_eq!(completed["job"]["mode"], "import");
            assert_eq!(completed["job"]["status"], "completed", "{completed}");
            assert_eq!(rows(&completed["import"]["modelAttempts"]).len(), 1);
            let record = &completed["import"];
            let q = &record["questions"][0];
            let qid = s(q, "questionId");
            assert_eq!(q["reviewDecision"], "pending");
            assert_eq!(q["answer"], "");
            assert_eq!(q["solution"], "");
            assert_eq!(
                completed["reviewEligibility"][qid]["eligible"],
                include_opinion
            );
            assert_eq!(
                runtime.request("import_start", &payload, &cancel).unwrap()["import"],
                *record
            );
            if include_opinion {
                assert_eq!(q["modelReview"]["origin"], "import");
                assert_eq!(q["modelReview"]["audit"]["task"], "question_import");
                verify_opinion(&runtime.store, q, record).unwrap();
                let published=runtime.request("import_publish",&json!({"importId":id,"expectedRevision":record["revision"],"operationId":"simulated-integrated-publish","acknowledgeReview":true}),&cancel).unwrap();
                assert_eq!(published["publication"]["addedQuestions"], 1);
                assert_eq!(
                    runtime.store.bank.question(qid).unwrap()["verification"]["method"],
                    "model_review"
                );
                let mut wrong = q.clone();
                wrong["modelReview"]["origin"] = json!("recheck");
                assert!(verify_opinion(&runtime.store, &wrong, record).is_err());
            } else {
                assert_eq!(q["modelReview"]["status"], "failed");
                assert_eq!(
                    q["modelReview"]["error"]["code"],
                    if opinion_mode == 1 {
                        "import_review_missing"
                    } else {
                        "model_review_invalid"
                    }
                );
                if opinion_mode == 1 {
                    assert!(s(&q["modelReview"], "summary").contains("重新检查"));
                }
            }
            let offline = runtime
                .request("import_get", &json!({"importId":id}), &cancel)
                .unwrap();
            assert_eq!(
                offline["import"]["questions"][0]["modelReview"]["origin"],
                "import"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn actual_provider_audit_binds_one_explicit_publication_and_preserves_missing_answers() {
        use std::net::TcpListener;
        let (_dir, store, record) = fixture();
        let mut model = ModelClient::open(&store.data_dir).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        model.save(&json!({"baseUrl":format!("http://{}/v1",listener.local_addr().unwrap()),"model":"simulated-review","apiKey":"simulated-review-only"})).unwrap();
        let response = raw(&record);
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(10)))
                .unwrap();
            let mut bytes = vec![];
            loop {
                let mut chunk = [0; 8192];
                let count = stream.read(&mut chunk).unwrap();
                bytes.extend_from_slice(&chunk[..count]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                    let length = header
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("content-length:")
                                .and_then(|v| v.trim().parse::<usize>().ok())
                        })
                        .unwrap();
                    if bytes.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let body =
                json!({"choices":[{"message":{"content":response.to_string()}}]}).to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
            String::from_utf8(bytes).unwrap()
        });
        process(
            &store,
            &model,
            "simulated-review-operation",
            "simulated-hash",
            &AtomicBool::new(false),
            record.clone(),
        )
        .unwrap();
        let request = server.join().unwrap();
        assert!(request.contains("questionId"));
        assert!(request.contains("原卷"));
        let completed = store.document("imports", s(&record, "importId")).unwrap();
        assert_eq!(completed["questions"][0]["reviewDecision"], "pending");
        assert_eq!(
            completed["questions"][0]["stem"],
            record["questions"][0]["stem"]
        );
        assert_eq!(
            eligibility(&completed)["simulated-review-q"]["eligible"],
            true,
            "{completed}"
        );
        assert!(store.bank.question("simulated-review-q").is_err());
        let q = &completed["questions"][0];
        verify_opinion(&store, q, &completed).unwrap();
        let payload = json!({"importId":record["importId"],"operationId":"simulated-reviewed-publish","expectedRevision":completed["revision"],"acknowledgeReview":true});
        let published = publish(&store, &payload, &AtomicBool::new(false)).unwrap();
        assert_eq!(published["publication"]["addedQuestions"], 1);
        let bank = store.bank.question("simulated-review-q").unwrap();
        assert_eq!(bank["verification"]["method"], "model_review");
        assert_eq!(bank["teacher"]["answers"], json!([]));
        assert_eq!(bank["teacher"]["solutions"], json!([]));
        assert_eq!(
            publish(&store, &payload, &AtomicBool::new(false)).unwrap()["publication"],
            published["publication"]
        );
        std::fs::write(
            store
                .data_dir
                .join(s(&q["modelReview"]["audit"], "relativePath")),
            b"tampered simulated response",
        )
        .unwrap();
        assert_eq!(
            verify_opinion(&store, q, &completed).unwrap_err().code,
            "review_audit_changed"
        );
    }
}
