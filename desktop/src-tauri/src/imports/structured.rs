//! Restricted adapter for a whole legacy paper. Original student content is
//! never rewritten by a model; only five-question metadata batches call it.
use super::*;
mod refresh;

pub(super) const IMMUTABLE_FIELDS: &[&str] = &[
    "sourceIdentity",
    "legacyReferences",
    "assetPayloads",
    "student",
    "teacher",
    "sourceIssues",
    "sourceMaterialRequirements",
    "sourceMaterialRoles",
    "annotationStatus",
    "annotationError",
    "annotationAttempts",
];
const MAX_BUNDLE_BYTES: usize = 64 * 1024 * 1024;
fn bad(message: &str) -> AppError {
    err("invalid_structured_import", message)
}
pub(super) fn is_structured(q: &Value) -> bool {
    q["sourceIdentity"]["system"] == "legacy_tutor_kb"
}
pub(super) fn has_student_assets(q: &Value) -> bool {
    !rows(&q["student"]["assets"]).is_empty() && verify_assets(q).is_ok()
}
pub(super) fn verify_assets(q: &Value) -> AppResult<()> {
    crate::bank::verify_embedded_assets(q)?;
    // Every image token must resolve to a real student reference. Extra assets
    // are valid (e.g. source diagrams rendered after the stem) but missing ones
    // must not be hidden by the presence of a different image.
    let refs = rows(&q["student"]["assets"]);
    let text = std::iter::once(s(q, "stem").to_owned())
        .chain(
            rows(&q["options"])
                .iter()
                .map(|option| s(option, "text").to_owned()),
        )
        .chain(
            rows(&q["parts"])
                .iter()
                .map(|part| s(part, "prompt").to_owned()),
        )
        .collect::<Vec<_>>()
        .join("\n");
    let re = regex::Regex::new(r#"!\[[^\]]*\]\(([^)]+)\)|(?i:<img\s[^>]*src=[\"']([^\"']+)[\"'])"#)
        .unwrap();
    for caps in re.captures_iter(&text) {
        let token = caps
            .get(1)
            .or_else(|| caps.get(2))
            .map(|m| m.as_str())
            .unwrap_or("");
        let token = token.trim().trim_start_matches("asset:");
        if !refs
            .iter()
            .any(|r| s(r, "assetId") == token || s(r, "path") == token)
        {
            return Err(bad("题面中的图片引用没有对应的已校验素材。"));
        }
    }
    Ok(())
}
pub(super) fn preserve(out: &mut Value, input: &Value) -> AppResult<()> {
    if !is_structured(input) {
        return Err(bad("结构化来源身份无效。"));
    }
    let identity = &input["sourceIdentity"];
    // Bounds and types were checked by the shared normalizer. Preserve source
    // whitespace rather than reformatting the old question during transport.
    for field in ["stem", "answer", "solution", "sourceLabel"] {
        if input[field].is_string() {
            out[field] = input[field].clone();
        }
    }
    for field in ["options", "parts"] {
        for (index, item) in rows(&input[field]).iter().enumerate() {
            for key in if field == "options" {
                &["label", "text"][..]
            } else {
                &[
                    "partId",
                    "prompt",
                    "answer",
                    "solution",
                    "label",
                    "parentPartId",
                ][..]
            } {
                if let Some(value) = item.get(*key) {
                    out[field][index][*key] = value.clone();
                }
            }
        }
    }
    for field in [
        "examId",
        "occurrenceId",
        "questionId",
        "contentVersionId",
        "contentHash",
    ] {
        let value = &identity[field];
        if !(value
            .as_str()
            .is_some_and(|v| !v.trim().is_empty() && v.len() <= 300)
            || value.as_u64().is_some())
        {
            return Err(bad("结构化题目缺少完整旧库身份与版本。"));
        }
    }
    for role in ["student", "teacher"] {
        let assets = input[role].get("assets").cloned().unwrap_or(json!([]));
        if !assets.is_array() {
            return Err(bad("素材引用需为数组。"));
        }
        out[role] = json!({"assets":assets});
    }
    out["assetPayloads"] = input.get("assetPayloads").cloned().unwrap_or(json!([]));
    out["sourceIdentity"] = identity.clone();
    let references = input
        .get("legacyReferences")
        .cloned()
        .unwrap_or(json!({"answers":[],"solutions":[]}));
    if !references.is_object() {
        return Err(bad("旧库参考格式无效。"));
    }
    for field in ["answers", "solutions"] {
        let values = references[field]
            .as_array()
            .ok_or_else(|| bad("旧库参考答案及解析需为数组。"))?;
        if values.len() > 100 {
            return Err(bad("旧库参考条目过多。"));
        }
        for reference in values {
            bounded_text(s(reference, "text"), 60_000, "旧库参考")?;
            if !matches!(
                s(reference, "provenance"),
                "generated" | "manual" | "unknown"
            ) {
                return Err(bad(
                    "旧库参考必须保留生成、人工或未知来源，不能冒称原卷答案。",
                ));
            }
        }
    }
    out["legacyReferences"] = references;
    let issues = input.get("sourceIssues").cloned().unwrap_or(json!([]));
    if !issues.is_array() || rows(&issues).len() > 100 {
        return Err(bad("来源问题格式无效。"));
    }
    for issue in rows(&issues) {
        if issue["blocking"] != true
            || s(&issue, "code").is_empty()
            || s(&issue, "message").is_empty()
        {
            return Err(bad("来源问题须明确保留阻塞原因。"));
        }
    }
    out["sourceIssues"] = issues;
    for field in ["annotationStatus", "annotationError", "annotationAttempts"] {
        if let Some(value) = input.get(field) {
            out[field] = value.clone();
        }
    }
    Ok(())
}
pub(super) fn check_review_immutable(old: &Value, next: &Value) -> AppResult<()> {
    for field in IMMUTABLE_FIELDS {
        if old.get(field) != next.get(field) {
            return Err(err(
                "immutable_source",
                "原卷身份、素材、旧库参考及标注过程不能通过审核改写；请保留原来源记录。",
            ));
        }
    }
    if is_structured(old) {
        let original = rows(&old["parts"]);
        let edited = rows(&next["parts"]);
        if original.len() != edited.len()
            || original.iter().zip(&edited).any(|(a, b)| {
                ["partId", "label", "parentPartId"]
                    .iter()
                    .any(|key| a.get(*key) != b.get(*key))
            })
        {
            return Err(err(
                "immutable_source",
                "小问原标签、层级及身份不能通过审核改写或丢失。",
            ));
        }
    }
    Ok(())
}
pub(super) fn validate_parts(parts: &[Value]) -> AppResult<()> {
    for part in parts {
        let mut parent = part.get("parentPartId").and_then(Value::as_str);
        let mut seen = HashSet::from([s(part, "partId")]);
        while let Some(id) = parent {
            if !seen.insert(id) {
                return Err(bad("小问层级存在循环。"));
            }
            let node = parts
                .iter()
                .find(|p| p["partId"] == id)
                .ok_or_else(|| bad("小问父级身份不在本题中。"))?;
            parent = node.get("parentPartId").and_then(Value::as_str);
        }
    }
    Ok(())
}
pub(super) fn body_chars(q: &Value) -> usize {
    // The source review budget covers question/reference text and metadata,
    // not embedded bytes or the separately preserved teaching audit trail.
    // Filter before cloning so large request/response histories are not copied
    // merely to measure a short source question.
    let body = q.as_object().map(|object|Value::Object(object.iter()
        .filter(|(key,_)|!matches!(key.as_str(),"assetPayloads"|"teachingWorkflow"))
        .map(|(key,value)|(key.clone(),value.clone())).collect()))
        .unwrap_or_else(||q.clone());
    body.to_string().chars().count()
}
fn safe_audit(value: &Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .filter(|(key, _)| {
                    !matches!(
                        key.as_str(),
                        "contentBase64" | "apiKey" | "authorization" | "signedUrl" | "downloadUrl"
                    )
                })
                .map(|(key, value)| (key.clone(), safe_audit(value)))
                .collect(),
        ),
        Value::Array(values) => json!(values.iter().map(safe_audit).collect::<Vec<_>>()),
        Value::String(text) if text.starts_with("http://") || text.starts_with("https://") => {
            json!("[remote URL omitted]")
        }
        _ => value.clone(),
    }
}
pub(super) fn verify_audit(store: &Store, record: &Value) -> AppResult<()> {
    if !record["structuredSource"].is_object() {
        return Ok(());
    }
    let root = store.data_dir.join("imports").canonicalize()?;
    let path = store
        .data_dir
        .join(s(&record["structuredSource"], "auditRelativePath"))
        .canonicalize()?;
    if !path.starts_with(&root) || !path.is_file() {
        return Err(bad("整卷审计来源路径无效。"));
    }
    let bytes = std::fs::read(path)?;
    if bytes.len() > MAX_BUNDLE_BYTES {
        return Err(bad("整卷审计来源过长。"));
    }
    let audit: Value = serde_json::from_slice(&bytes)?;
    if hash_json(&audit) != record["structuredSource"]["auditSha256"] {
        return Err(err(
            "source_changed",
            "整卷审计来源校验不一致，未继续标注或发布。",
        ));
    }
    Ok(())
}
fn prepare(
    store: &Store,
    model: &ModelClient,
    payload: &Value,
    cancel: &AtomicBool,
) -> AppResult<Value> {
    if !model.configured() {
        return Err(err(
            "not_configured",
            "请先配置当前使用的模型，再导入整卷。",
        ));
    }
    cancelled(cancel)?;
    if payload.to_string().len() > MAX_BUNDLE_BYTES {
        return Err(bad("整卷来源包超过 64 MB，请分拆来源材料。"));
    }
    let op = operation(payload)?;
    let hash = hash_json(payload);
    let bundle = &payload["bundle"];
    if bundle["schemaVersion"] != 1 || bundle["kind"] != "legacy_exam_bundle_v1" {
        return Err(bad("整卷来源包版本无效。"));
    }
    let questions = bundle["questions"]
        .as_array()
        .filter(|q| !q.is_empty() && q.len() <= MAX_QUESTIONS)
        .ok_or_else(|| bad("整卷需保留 1–60 道题目。"))?;
    if bundle["expectedQuestionCount"].as_u64() != Some(questions.len() as u64) {
        return Err(bad(
            "原卷预期题数与实际题目条目不一致，不能保存不完整试卷。",
        ));
    }
    let id = format!("import-{}", &hash_json(&json!(op))[..24]);
    if let Ok(existing) = store.document("imports", &id) {
        if existing["creationHash"] != hash {
            return Err(err(
                "operation_conflict",
                "此导入操作标识已用于不同来源包。",
            ));
        }
        return Ok(json!({"import":existing}));
    }
    let original = &bundle["original"];
    let (name, extension) = filename(s(original, "filename"))?;
    if extension != "pdf" {
        return Err(bad("结构化整卷需附原始 PDF。"));
    }
    if s(original, "contentBase64").len() > MAX_BYTES.div_ceil(3) * 4 + 4 {
        return Err(bad("原始 PDF 超过 15 MB。"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(s(original, "contentBase64"))
        .map_err(|_| bad("原始 PDF 编码无效。"))?;
    if bytes.is_empty()
        || bytes.len() > MAX_BYTES
        || sha(&bytes) != s(original, "sha256")
        || !bytes.starts_with(b"%PDF-")
    {
        return Err(bad("原始 PDF 字节或 SHA256 不匹配。"));
    }
    let pdf = lopdf::Document::load_mem(&bytes).map_err(|_| bad("原始 PDF 无法读取。"))?;
    if pdf.is_encrypted() {
        return Err(bad("原始 PDF 不能加密。"));
    }
    let page_count = pdf.get_pages().len();
    if page_count == 0 || page_count > 200 {
        return Err(bad("原始 PDF 页数需为 1–200 页。"));
    }
    let exam_id = &bundle["exam"]["id"];
    if exam_id.as_str().is_none_or(str::is_empty) && exam_id.as_u64().is_none() {
        return Err(bad("整卷缺少原试卷身份。"));
    }
    let mut seen = HashSet::new();
    let mut numbers = HashSet::new();
    let mut pending = vec![];
    for (index, input) in questions.iter().enumerate() {
        if input["sourceIdentity"]["examId"].to_string() != exam_id.to_string() {
            return Err(bad("题目不属于本次原卷身份。"));
        }
        if !seen.insert(input["sourceIdentity"]["occurrenceId"].to_string())
            || s(input, "sourceLabel").trim().is_empty()
            || !numbers.insert(s(input, "sourceLabel").to_owned())
        {
            return Err(bad("原卷题目出现重复身份、重复或缺失原题号。"));
        }
        let qid = format!("{id}-q{}", index + 1);
        let mut question = normalize_question_inner(input, &qid, page_count, true)?;
        question["knowledgeSchemaVersion"] = json!(2);
        question["primaryKnowledgeUids"] = json!([]);
        question["solutionPaths"] = json!([]);
        question["task"] = json!({"id":"","label":""});
        question["difficultyAssessment"] =
            json!({"level":null,"basis":"","rubricVersion":annotations::RUBRIC_VERSION});
        question["annotationStatus"] = json!("pending");
        question["annotationAttempts"] = json!([]);
        question["annotationError"] = Value::Null;
        question["reviewDecision"] = json!("pending");
        question["mappingConfirmed"] = json!(false);
        question["knowledgeMappingSource"] = json!("model");
        question["reviewBasis"] = json!("");
        question["reviewChecks"] = json!({"sourceMatched":false,"answerChecked":false,"solutionChecked":false,"formulaChecked":false});
        question["reviewIssues"] = json!(question_issues(&question, &json!([])));
        pending.push(question);
    }
    if pending.iter().map(body_chars).sum::<usize>() > MAX_TEXT {
        return Err(bad("整卷正文与参考超过 24 万字；内嵌素材不计正文。"));
    }
    duplicates::annotate(&store.bank, &mut pending)?;
    cancelled(cancel)?;
    let mut source = save_source(store, &id, &extension, &bytes)?;
    source["physicalPages"] = json!(page_count);
    let audit = safe_audit(bundle);
    let audit_path = store
        .data_dir
        .join("imports")
        .join(&id)
        .join("source-bundle.json");
    let audit_bytes = serde_json::to_vec_pretty(&audit)?;
    if audit_path.exists() {
        let saved: Value = serde_json::from_slice(&std::fs::read(&audit_path)?)?;
        if hash_json(&saved) != hash_json(&audit) {
            return Err(err(
                "source_conflict",
                "已有整卷审计资料与本次来源不同，未覆盖。",
            ));
        }
    } else {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&audit_path)?;
        file.write_all(&audit_bytes)?;
        file.sync_all()?;
    }
    let timestamp = now();
    let mut record = json!({"importId":id,"filename":name,"status":"pending_review","revision":0,"createdAt":timestamp,"updatedAt":timestamp,"creationHash":hash,"source":source,"questions":pending,"sourceIssues":[],"operations":[],"publishedQuestionIds":[],"publicationHistory":[],"error":null,"structuredSource":{"schemaVersion":1,"kind":"legacy_exam_bundle_v1","exam":bundle["exam"],"expectedQuestionCount":questions.len(),"auditSha256":hash_json(&audit),"auditRelativePath":format!("imports/{id}/source-bundle.json")},"annotationBatches":[]});
    finish(&mut record, op, &hash, "structured_prepare");
    save_cas(store, None, &record)?;
    Ok(json!({"import":record}))
}
/// A usable generated draft is an explicitly labelled annotation reference,
/// never an original answer or evidence of independent mathematical review.
/// Failed, pending, source-stale or malformed candidates are not transmitted.
pub(super) fn ready_teaching_reference(q: &Value) -> Option<Value> {
    let workflow = &q["teachingWorkflow"];
    let candidate = &workflow["finalResult"];
    if !teaching::ready(q)
        || teaching::validate(candidate, s(q, "questionId")).is_err()
        || s(candidate, "teachingSolution").trim().is_empty()
    {
        return None;
    }
    Some(json!({"provenance":"llm_generated","originalPaperReference":false,
        "independentlyVerified":false,"sourceContentSha256":workflow["sourceContentSha256"],
        "candidateSha256":hash_json(candidate),"answer":candidate["answer"],
        "solution":candidate["teachingSolution"],"difficultyAssessment":candidate["difficultyAssessment"],
        "teachingFocus":candidate["teachingFocus"]}))
}
fn annotation_input(q: &Value) -> Value {
    let mut input = json!({"questionId":q["questionId"],"questionType":q["questionType"],"stem":q["stem"],"options":q["options"],"parts":q["parts"],"answer":q["answer"],"solution":q["solution"],"legacyReferences":q["legacyReferences"],"sourceIdentity":q["sourceIdentity"],"pages":q["pages"],"student":{"assets":q["student"]["assets"]},"sourceIssues":q["sourceIssues"],"existingMetadata":{"task":q["task"],"difficultyAssessment":q["difficultyAssessment"],"primaryKnowledgeUids":q["primaryKnowledgeUids"],"solutionPaths":q["solutionPaths"]}});
    if let Some(reference) = ready_teaching_reference(q) {
        input["teachingReference"] = reference;
    }
    input
}
fn strict_metadata_paths(value: &Value) -> AppResult<()> {
    let paths = value["solutionPaths"]
        .as_array()
        .ok_or_else(|| bad("元数据解法路径必须为数组。"))?;
    let mut seen = HashSet::new();
    for path in paths {
        let keys = ["id", "requiredKnowledgeUids", "requiredPremises", "basis"];
        if path
            .as_object()
            .is_none_or(|o| o.len() != keys.len() || keys.iter().any(|key| !o.contains_key(*key)))
            || s(path, "id").trim().is_empty()
            || !seen.insert(s(path, "id"))
            || !path["basis"].is_string()
            || ["requiredKnowledgeUids", "requiredPremises"]
                .iter()
                .any(|key| {
                    path[*key]
                        .as_array()
                        .is_none_or(|a| a.iter().any(|v| !v.is_string()))
                })
        {
            return Err(bad(
                "元数据路径须有唯一id、requiredKnowledgeUids数组、requiredPremises数组及basis，不能使用替代字段或遗漏依赖。",
            ));
        }
    }
    Ok(())
}
fn attempt_file(store: &Store, record: &Value, operation: &str) -> AppResult<std::path::PathBuf> {
    let root = store.data_dir.join("imports").canonicalize()?;
    let source = store
        .data_dir
        .join(s(&record["source"], "relativePath"))
        .canonicalize()?;
    let directory = source.parent().ok_or_else(|| bad("来源目录无效。"))?;
    if !directory.starts_with(root) {
        return Err(bad("来源目录越界。"));
    }
    Ok(directory.join(format!(
        "annotation-attempt-{}.json",
        &hash_json(&json!(operation))[..24]
    )))
}
pub(super) fn step(
    store: &Store,
    model: &ModelClient,
    payload: &Value,
    cancel: &AtomicBool,
) -> AppResult<Value> {
    if !model.configured() {
        return Err(err(
            "not_configured",
            "请先配置当前模型，再补充整卷题目标注。",
        ));
    }
    let op = operation(payload)?;
    let hash = hash_json(payload);
    let mut record = store.document("imports", s(payload, "importId"))?;
    if replay(&record, op, &hash)? {
        return Ok(json!({"import":record}));
    }
    revision(&record, payload)?;
    if rows(&record["questions"]).is_empty() || record["status"] == "processing" {
        return Err(bad("请先完成原卷解析，再补充题目标注。"));
    }
    if matches!(s(&record["backgroundJob"], "status"), "queued" | "running")
        && payload["backgroundJobId"] != record["backgroundJob"]["jobId"]
    {
        return Err(err(
            "import_running",
            "此试卷正在后台处理，请等待完成后再补充考查信息。",
        ));
    }
    if record["pendingPublication"].is_object() {
        return Err(err("publication_pending", "请先完成待确认的入库操作。"));
    }
    read_source(store, &record)?;
    paddle::verify_audit(store, &record)?;
    let attempt_path = attempt_file(store, &record, op)?;
    let provider_path = attempt_path.with_extension("provider-response.json");
    if attempt_path.exists() || provider_path.exists() {
        return Err(err(
            "operation_conflict",
            "本次操作已有独立模型尝试记录，请核对当前审核版本并使用新的操作身份重试；不会自动采用旧响应。",
        ));
    }
    let prior = record.clone();
    let mut questions = rows(&record["questions"]);
    let published = ids(&record["publishedQuestionIds"]);
    let requested = payload
        .get("questionIds")
        .map(|value| -> AppResult<HashSet<String>> {
            let values = value
                .as_array()
                .filter(|values| !values.is_empty() && values.len() <= 5)
                .ok_or_else(|| bad("每批需指定1–5个题目身份。"))?;
            let mut ids = HashSet::new();
            for id in values {
                let id = id
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| bad("本批题目身份无效。"))?;
                if !ids.insert(id.to_owned())
                    || !questions.iter().any(|q| q["questionId"] == id)
                    || published.contains(&id.to_owned())
                {
                    return Err(bad("本批题目身份重复、不存在或已经入库。"));
                }
            }
            Ok(ids)
        })
        .transpose()?;
    let mut candidates = questions
        .iter()
        .enumerate()
        .filter(|(_, q)| {
            (s(q, "annotationStatus") != "succeeded" || requested.is_some())
                && !published.contains(&s(q, "questionId").to_owned())
                && requested
                    .as_ref()
                    .is_none_or(|ids| ids.contains(s(q, "questionId")))
        })
        .map(|(i, _)| i)
        .collect::<Vec<_>>();
    candidates.sort_by_key(|index| s(&questions[*index], "annotationStatus") != "pending");
    let targets = candidates.into_iter().take(5).collect::<Vec<_>>();
    if targets.is_empty() {
        return Ok(json!({"import":record}));
    }
    cancelled(cancel)?;
    let model_context = json!({"questions":targets.iter().map(|i|annotation_input(&questions[*i])).collect::<Vec<_>>(),"trustedCatalogue":trusted_catalog(store)?,"legacyReferencePolicy":"旧库参考非原卷答案；generated为旧模型生成、manual为旧库人工记录、unknown来源未知。只能参考并注明不确定性，不得改写原题或采纳为官方证据。","teachingReferencePolicy":"teachingReference仅为与本题当前来源哈希匹配的AI生成课堂稿，非原卷答案、非独立数学核验。只可核对其实际完整推导后用作知识点与解法依赖标注参考，basis注明“AI教学参考，非原卷解析”；仍有关键缺证或不能覆盖全部小问时solutionPaths=[]。不能改写原卷或重做教学稿。"});
    let proposed = model.propose_with_audit(
        "question_import_annotation",
        &model_context,
        cancel,
        Some(&provider_path),
    );
    // Model output survives a later personal-record CAS conflict. It is an
    // audit artifact only; stale attempts are never silently adopted.
    let attempted = json!({"schemaVersion":1,"importId":record["importId"],"operationId":op,"expectedRevision":payload["expectedRevision"],"requestSha256":hash,"questionIds":targets.iter().map(|i|questions[*i]["questionId"].clone()).collect::<Vec<_>>(),"at":now(),"modelResult":proposed.as_ref().ok().cloned().unwrap_or(Value::Null),"error":proposed.as_ref().err().map(|e|serde_json::to_value(e).unwrap_or(Value::Null)).unwrap_or(Value::Null)});
    let bytes = serde_json::to_vec_pretty(&attempted)?;
    let mut attempt = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&attempt_path)?;
    attempt.write_all(&bytes)?;
    attempt.sync_all()?;
    let mut batch = json!({"operationId":op,"questionIds":targets.iter().map(|i|questions[*i]["questionId"].clone()).collect::<Vec<_>>(),"at":now(),"modelResult":null,"error":null});
    batch["attemptRelativePath"] = json!(
        attempt_path
            .strip_prefix(store.data_dir.canonicalize()?)
            .map_err(|_| bad("审计路径无效。"))?
            .to_string_lossy()
            .replace('\\', "/")
    );
    batch["attemptSha256"] = json!(sha(&bytes));
    if provider_path.exists() {
        batch["providerResponseRelativePath"] = json!(
            provider_path
                .strip_prefix(store.data_dir.canonicalize()?)
                .map_err(|_| bad("模型响应审计路径无效。"))?
                .to_string_lossy()
                .replace('\\', "/")
        );
    }
    let outcome = (|| -> AppResult<()> {
        let raw = proposed?;
        batch["modelResult"] = raw.clone();
        let result = raw["questions"]
            .as_array()
            .filter(|q| q.len() == targets.len())
            .ok_or_else(|| bad("模型返回的题目数量与本批次不一致。"))?;
        let mut seen = HashSet::new();
        let config = store.bank.config()?;
        let catalogue = trusted_catalog(store)?;
        for value in result {
            let qid = s(value, "questionId");
            let index = targets
                .iter()
                .find(|i| questions[**i]["questionId"] == qid)
                .copied()
                .ok_or_else(|| bad("模型返回了批次之外的题目身份。"))?;
            if !seen.insert(qid.to_owned()) {
                return Err(bad("模型重复返回同一题目身份。"));
            }
            let allowed = [
                "questionId",
                "task",
                "difficultyAssessment",
                "knowledgeSchemaVersion",
                "primaryKnowledgeUids",
                "solutionPaths",
            ];
            if value
                .as_object()
                .is_none_or(|o| o.keys().any(|key| !allowed.contains(&key.as_str())))
            {
                return Err(bad("模型只能补充元数据，不能返回或改写原题内容。"));
            }
            let assessed = (|| -> AppResult<Value> {
                strict_metadata_paths(value)?;
                let mut updated = questions[index].clone();
                for field in [
                    "task",
                    "difficultyAssessment",
                    "knowledgeSchemaVersion",
                    "primaryKnowledgeUids",
                    "solutionPaths",
                ] {
                    if payload["supplementOnly"] == true
                        && match field {
                            "task" => !s(&questions[index]["task"], "label").trim().is_empty(),
                            "difficultyAssessment" => {
                                questions[index]["difficultyAssessment"]["level"].is_string()
                            }
                            "primaryKnowledgeUids" | "solutionPaths" => {
                                !rows(&questions[index][field]).is_empty()
                            }
                            _ => false,
                        }
                    {
                        continue;
                    }
                    updated[field] = value[field].clone();
                }
                if updated["knowledgeSchemaVersion"] != 2 {
                    return Err(bad("模型标注需使用新版知识点结构。"));
                }
                let validated = normalize_question_inner(
                    &updated,
                    qid,
                    record["source"]["physicalPages"].as_u64().unwrap_or(0) as usize,
                    is_structured(&updated),
                )?;
                knowledge_annotation(&validated, &config, &catalogue)?;
                crate::knowledge::validate_leaf_annotation(&validated, &config)?;
                // Validate the full object, then copy only the metadata
                // whitelist into the exact original. Formatting, assets,
                // source versions and existing teacher review stay unchanged.
                let mut updated = questions[index].clone();
                for field in [
                    "task",
                    "difficultyAssessment",
                    "knowledgeSchemaVersion",
                    "primaryKnowledgeUids",
                    "solutionPaths",
                ] {
                    updated[field] = validated[field].clone();
                }
                if rows(&questions[index]["primaryKnowledgeUids"]).is_empty()
                    && !rows(&updated["primaryKnowledgeUids"]).is_empty()
                {
                    // A newly model-filled association must not inherit an old
                    // teacher_edit marker from a previously cleared mapping.
                    updated["knowledgeMappingSource"] = json!("model");
                }
                Ok(updated)
            })();
            match assessed {
                Ok(mut updated) => {
                    updated["annotationStatus"] = json!("succeeded");
                    updated["annotationError"] = Value::Null;
                    questions[index] = updated;
                }
                Err(error) => {
                    questions[index]["annotationStatus"] = json!("failed");
                    questions[index]["annotationError"] = serde_json::to_value(&error)?;
                }
            }
        }
        if questions.iter().map(body_chars).sum::<usize>() > MAX_TEXT {
            return Err(bad("本批标注超过整卷正文长度限制，原题及先前标注保留。"));
        }
        Ok(())
    })();
    if let Err(error) = outcome {
        batch["error"] = serde_json::to_value(&error)?;
        for index in &targets {
            questions[*index] = prior["questions"][*index].clone();
            questions[*index]["annotationStatus"] = json!("failed");
            questions[*index]["annotationError"] = serde_json::to_value(&error)?;
        }
    }
    for index in &targets {
        let mut attempts = rows(&questions[*index]["annotationAttempts"]);
        attempts.push(
            json!({"operationId":op,"at":batch["at"],"error":questions[*index]["annotationError"]}),
        );
        questions[*index]["annotationAttempts"] = json!(attempts);
    }
    let mut duplicate_checked = questions.clone();
    duplicates::annotate(&store.bank, &mut duplicate_checked)?;
    for index in &targets {
        questions[*index] = duplicate_checked[*index].clone();
    }
    record["questions"] = json!(questions);
    let mut batches = rows(&record["annotationBatches"]);
    batches.push(batch);
    record["annotationBatches"] = json!(batches);
    record["status"] = json!(if published.is_empty() {
        "pending_review"
    } else {
        "partially_published"
    });
    finish(&mut record, op, &hash, "structured_annotation");
    save_cas(store, Some(&prior), &record)?;
    Ok(json!({"import":record}))
}
pub(super) fn dispatch(
    store: &Store,
    model: &ModelClient,
    action: &str,
    payload: &Value,
    cancel: &AtomicBool,
) -> AppResult<Option<Value>> {
    Ok(match action {
        "import_structured_prepare" => Some(prepare(store, model, payload, cancel)?),
        "import_structured_step" => Some(step(store, model, payload, cancel)?),
        "import_structured_source_refresh" => Some(refresh::run(store, payload, cancel)?),
        "import_original_read" => {
            let record = store.document("imports", s(payload, "importId"))?;
            let original = read_source(store, &record)?;
            let converted =
                record["source"]["extension"] == "docx" && record["renderedPdf"].is_object();
            let bytes = if converted {
                paddle::read_rendered_pdf(store, &record)?
            } else if record["source"]["extension"] == "pdf" {
                original
            } else {
                return Err(bad("此来源没有可对照的 PDF。"));
            };
            let filename = if converted {
                format!(
                    "{}（转换）.pdf",
                    Path::new(s(&record, "filename"))
                        .file_stem()
                        .and_then(|v| v.to_str())
                        .unwrap_or("试卷")
                )
            } else {
                s(&record, "filename").to_owned()
            };
            Some(
                json!({"importId":record["importId"],"filename":filename,"derivedFromDocx":converted,"dataBase64":base64::engine::general_purpose::STANDARD.encode(&bytes),"sha256":sha(&bytes)}),
            )
        }
        _ => None,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    fn fixture() -> (tempfile::TempDir, Store, ModelClient) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), &crate::bank::tests::seed()).unwrap();
        std::fs::write(dir.path().join("model-settings.json"), b"{}").unwrap();
        let model = ModelClient::open(dir.path()).unwrap();
        (dir, store, model)
    }
    fn pdf() -> Vec<u8> {
        use lopdf::{Document, Stream, dictionary};
        let mut doc = Document::with_version("1.5");
        let pages = doc.new_object_id();
        let content = doc.add_object(Stream::new(dictionary! {}, b"".to_vec()));
        let page=doc.add_object(dictionary!{"Type"=>"Page","Parent"=>pages,"Contents"=>content,"MediaBox"=>vec![0.into(),0.into(),300.into(),300.into()]});
        doc.objects.insert(
            pages,
            lopdf::Object::Dictionary(
                dictionary! {"Type"=>"Pages","Kids"=>vec![page.into()],"Count"=>1},
            ),
        );
        let root = doc.add_object(dictionary! {"Type"=>"Catalog","Pages"=>pages});
        doc.trailer.set("Root", root);
        let mut bytes = vec![];
        doc.save_to(&mut bytes).unwrap();
        bytes
    }
    fn bundle(count: usize) -> Value {
        let bytes = pdf();
        json!({"schemaVersion":1,"kind":"legacy_exam_bundle_v1","exam":{"id":"simulated-exam","title":"模拟整卷回归"},"original":{"filename":"模拟原卷.pdf","sha256":sha(&bytes),"contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes)},"expectedQuestionCount":count,"sourceAudit":{"unknownRetained":"原始台账保留","evidenceAssetPayloads":[{"dataBase64":"模拟仅审计资料"}]},"questions":(0..count).map(|i|json!({"sourceIdentity":{"system":"legacy_tutor_kb","examId":"simulated-exam","occurrenceId":format!("occ-{i}"),"questionId":format!("legacy-{i}"),"contentVersionId":format!("cv-{i}"),"contentHash":"a".repeat(64)},"questionType":"fill_blank","stem":format!("模拟整卷第{}题：计算 $7+{}=$____。",i+1,i+10),"options":[],"parts":[],"answer":"","solution":"","sourceLabel":(i+1).to_string(),"pages":[1],"student":{"assets":[]},"teacher":{"assets":[]},"assetPayloads":[],"sourceIssues":[],"legacyReferences":{"answers":[{"text":"模拟旧生成答案","provenance":"generated"}],"solutions":[{"text":"模拟旧生成参考解法，仅供核对，不代表原卷。","provenance":"generated"}]}})).collect::<Vec<_>>()})
    }
    #[cfg(windows)]
    fn configured(model: &mut ModelClient) {
        model.save(&json!({"baseUrl":"http://127.0.0.1:9/v1","model":"simulated-structured","apiKey":"simulated-only"})).unwrap();
    }
    fn payload(bundle: Value, op: &str) -> Value {
        json!({"operationId":op,"bundle":bundle})
    }
    fn approve(record: &Value) -> Value {
        let mut record = record.clone();
        for q in record["questions"].as_array_mut().unwrap() {
            q["reviewDecision"] = json!("approve");
            q["reviewChecks"] = json!({"sourceMatched":true,"answerChecked":true,"solutionChecked":true,"formulaChecked":true});
            q["reviewBasis"] = json!("模拟回归：逐项对照原卷并保留参考缺项，不是真实教师案例。");
        }
        record
    }
    fn with_image(q: &mut Value) {
        let encoded = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        let reference = json!({"assetId":"simulated-figure","path":"assets/simulated-figure.png","sha256":sha(&bytes),"mimeType":"image/png","alt":"模拟原图"});
        q["student"]["assets"] = json!([reference]);
        let mut embedded = reference;
        embedded["role"] = json!("student");
        embedded["dataBase64"] = json!(encoded);
        q["assetPayloads"] = json!([embedded]);
        q["stem"] = json!(
            "模拟图表题：如图 ![原图](asset:simulated-figure) 求值____。<table><tr><td>甲</td><td>2</td></tr></table>"
        );
    }
    #[test]
    #[cfg(windows)]
    fn source_refresh_only_adds_hierarchy_and_bound_blocking_findings_and_keeps_audit() {
        let (dir, store, mut model) = fixture();
        configured(&mut model);
        let mut source = bundle(1);
        source["questions"][0]["parts"] = json!([{"partId":"a","prompt":"模拟父问","answer":"","solution":""},{"partId":"b","prompt":"模拟子问","answer":"","solution":""}]);
        let record = prepare(
            &store,
            &model,
            &payload(source.clone(), "simulated-refresh-prepare"),
            &AtomicBool::new(false),
        )
        .unwrap()["import"]
            .clone();
        let old_audit = record["structuredSource"]["auditRelativePath"]
            .as_str()
            .unwrap();
        source["questions"][0]["parts"][0]["label"] = json!("(1)");
        source["questions"][0]["parts"][1]["label"] = json!("(i)");
        source["questions"][0]["parts"][1]["parentPartId"] = json!("a");
        let issue = json!({"code":"simulated_source_mismatch","message":"模拟审核发现原文有限上限被错误录入，保持原文阻塞。","blocking":true});
        source["questions"][0]["sourceIssues"] = json!([issue.clone()]);
        let mut finding = issue;
        for key in ["examId", "occurrenceId", "contentHash"] {
            finding[key] = source["questions"][0]["sourceIdentity"][key].clone();
        }
        finding["originalPdfSha256"] = source["original"]["sha256"].clone();
        source["questions"][0]["sourceAudit"] = json!({"reviewFindings":[finding]});
        let request = json!({"importId":record["importId"],"expectedRevision":record["revision"],"operationId":"simulated-refresh","bundle":source});
        for field in ["stem", "sourceIdentity", "sourceIssues"] {
            let mut invalid = request.clone();
            if field == "stem" {
                invalid["bundle"]["questions"][0][field] = json!("静默改文");
            } else if field == "sourceIdentity" {
                invalid["bundle"]["questions"][0][field]["contentHash"] = json!("wrong");
            } else {
                invalid["bundle"]["questions"][0]["sourceAudit"]["reviewFindings"] = json!([]);
            }
            assert!(refresh::run(&store, &invalid, &AtomicBool::new(false)).is_err());
        }
        let updated =
            refresh::run(&store, &request, &AtomicBool::new(false)).unwrap()["import"].clone();
        assert_eq!(updated["questions"][0]["parts"][1]["parentPartId"], "a");
        assert!(dir.path().join(old_audit).exists());
        assert_eq!(
            updated["structuredSource"]["auditHistory"][0]["auditRelativePath"],
            old_audit
        );
        assert_eq!(
            refresh::run(&store, &request, &AtomicBool::new(false)).unwrap()["import"],
            updated
        );
        assert_eq!(
            build_manifest(&store, &approve(&updated)).unwrap_err().code,
            "source_content_unresolved"
        );
        let mut edit = updated["questions"][0].clone();
        edit["parts"][1]
            .as_object_mut()
            .unwrap()
            .remove("parentPartId");
        assert!(check_review_immutable(&updated["questions"][0], &edit).is_err());
        let mut cycle = updated["questions"][0].clone();
        cycle["parts"][0]["parentPartId"] = json!("b");
        assert!(normalize_question_inner(&cycle, s(&cycle, "questionId"), 1, true).is_err());
    }
    #[test]
    #[cfg(windows)]
    fn source_refresh_proves_table_image_archival_and_rejects_other_content_changes() {
        let (_dir, store, mut model) = fixture();
        configured(&mut model);
        let mut source = bundle(1);
        with_image(&mut source["questions"][0]);
        let q = &mut source["questions"][0];
        q["student"]["assets"][0]["assetId"] = json!("legacy-simulated-exam-7");
        q["assetPayloads"][0]["assetId"] = json!("legacy-simulated-exam-7");
        q["stem"] = json!(
            "模拟<table><tr><td>甲</td><td>2</td></tr></table><div><img src=\"asset:legacy-simulated-exam-7\" /></div>"
        );
        q["sourceAudit"] = json!({"assetProvenance":[{"asset_id":7,"source_key":"assets/table.png","type":"table","placement":"body"}]});
        let record = prepare(
            &store,
            &model,
            &payload(source.clone(), "simulated-table-refresh-prepare"),
            &AtomicBool::new(false),
        )
        .unwrap()["import"]
            .clone();
        let image = source["questions"][0]["assetPayloads"][0].clone();
        source["sourceAudit"]["evidenceAssetPayloads"] = json!([image.clone()]);
        source["questions"][0]["sourceAudit"]["assetProvenance"][0]["assetId"] =
            image["assetId"].clone();
        source["questions"][0]["sourceAudit"]["assetProvenance"][0]["sha256"] =
            image["sha256"].clone();
        source["questions"][0]["sourceAudit"]["assetProvenance"][0]["evidenceOnly"] = json!(true);
        source["questions"][0]["student"]["assets"] = json!([]);
        source["questions"][0]["assetPayloads"] = json!([]);
        source["questions"][0]["stem"] =
            json!("模拟<table><tr><td>甲</td><td>2</td></tr></table><div></div>");
        let request = json!({"importId":record["importId"],"expectedRevision":record["revision"],"operationId":"simulated-table-refresh","bundle":source});
        for i in 0..3 {
            let mut bad = request.clone();
            match i {
                0 => {
                    bad["bundle"]["questions"][0]["stem"] =
                        json!("模拟<table><tr><td>甲</td><td>3</td></tr></table>")
                }
                1 => {
                    bad["bundle"]["sourceAudit"]["evidenceAssetPayloads"][0]["sha256"] =
                        json!("wrong")
                }
                _ => {
                    bad["bundle"]["questions"][0]["sourceAudit"]["assetProvenance"][0]["type"] =
                        json!("figure")
                }
            };
            assert!(refresh::run(&store, &bad, &AtomicBool::new(false)).is_err());
        }
        let updated =
            refresh::run(&store, &request, &AtomicBool::new(false)).unwrap()["import"].clone();
        assert_eq!(updated["questions"][0]["student"]["assets"], json!([]));
        assert!(s(&updated["questions"][0], "stem").contains("<table>"));
        verify_audit(&store, &updated).unwrap();
    }
    #[test]
    fn simulated_semantic_diagram_words_do_not_replace_model_review_but_real_assets_still_require_binding() {
        let mut q = bundle(1)["questions"][0].clone();
        q["stem"] = json!("模拟描述统计：直方图中小矩形面积表示频率的概念是____。");
        assert!(
            !question_issues(&q, &json!([]))
                .iter()
                .any(|i| i["code"] == "source_content_unresolved")
        );
        let mut legacy = q.clone();
        legacy.as_object_mut().unwrap().remove("sourceIdentity");
        assert!(
            !question_issues(&legacy, &json!([]))
                .iter()
                .any(|i| i["code"] == "source_content_unresolved")
        );
        for stem in [
            "模拟如图所示求值____。",
            "模拟见图求值____。",
            "模拟图中阴影部分面积____。",
        ] {
            q["stem"] = json!(stem);
            assert!(
                !question_issues(&q, &json!([]))
                    .iter()
                    .any(|i| i["code"] == "source_content_unresolved")
            );
        }
        for stem in ["![原图](asset:missing)","<img src='asset:missing'>","SOURCE_VISUAL_UNRESOLVED","SOURCE_FORMULA_UNRESOLVED","<svg>unavailable visual</svg>"] {
            q["stem"] = json!(stem);
            assert!(question_issues(&q,&json!([])).iter().any(|i|i["code"]=="source_content_unresolved"));
        }
    }
    #[test]
    fn metadata_paths_reject_missing_or_alias_fields_instead_of_erasing_dependencies() {
        for paths in [
            json!([{"basis":"模拟","premises":["absolute_root"],"requiredKnowledgeUids":[],"summary":"不能代替路径"}]),
            json!([{"id":"a","basis":"模拟","requiredKnowledgeUids":[]}]),
            json!([{"id":"a","basis":"模拟","requiredKnowledgeUids":[],"requiredPremises":[],"summary":"多余字段"}]),
            json!([{"id":"a","basis":"模拟","requiredKnowledgeUids":[],"requiredPremises":[]},{"id":"a","basis":"模拟","requiredKnowledgeUids":[],"requiredPremises":[]}]),
        ] {
            assert!(strict_metadata_paths(&json!({"solutionPaths":paths})).is_err());
        }
        assert!(strict_metadata_paths(&json!({"solutionPaths":[]})).is_ok());
        assert!(strict_metadata_paths(&json!({"solutionPaths":[{"id":"a","basis":"模拟完整依据","requiredKnowledgeUids":[],"requiredPremises":["absolute_root"]}]})).is_ok());
    }
    #[test]
    fn gate_precedes_bundle_decode_or_source_writes() {
        let (dir, store, model) = fixture();
        let error = prepare(
            &store,
            &model,
            &payload(
                json!({"original":{"contentBase64":"invalid"}}),
                "simulated-gate",
            ),
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert_eq!(error.code, "not_configured");
        assert!(!dir.path().join("imports").exists());
        assert!(store.list_documents("imports").unwrap().is_empty());
    }
    #[test]
    #[cfg(windows)]
    fn exact_count_occurrence_page_and_pdf_hash_are_checked_without_inventing_pages() {
        let (dir, store, mut model) = fixture();
        configured(&mut model);
        for (i, mut source) in (0..5).map(|i| (i, bundle(2))) {
            match i {
                0 => source["expectedQuestionCount"] = json!(3),
                1 => {
                    source["questions"][1]["sourceIdentity"]["occurrenceId"] =
                        source["questions"][0]["sourceIdentity"]["occurrenceId"].clone()
                }
                2 => source["questions"][0]["pages"] = json!([99]),
                3 => source["original"]["sha256"] = json!("0".repeat(64)),
                _ => source["questions"][1]["sourceLabel"] = json!("1"),
            };
            assert!(
                prepare(
                    &store,
                    &model,
                    &payload(source, &format!("simulated-invalid-{i}")),
                    &AtomicBool::new(false)
                )
                .is_err()
            );
            assert!(!dir.path().join("imports").exists());
        }
        let mut source = bundle(1);
        source["questions"][0]["pages"] = json!([]);
        let record = prepare(
            &store,
            &model,
            &payload(source, "simulated-unknown-page"),
            &AtomicBool::new(false),
        )
        .unwrap()["import"]
            .clone();
        assert_eq!(record["questions"][0]["pages"], json!([]));
        assert!(
            record["questions"][0]["reviewIssues"]
                .as_array()
                .unwrap()
                .iter()
                .any(|i| i["code"] == "source_page_unknown")
        );
        assert_eq!(
            build_manifest(&store, &approve(&record)).unwrap_err().code,
            "source_content_unresolved"
        );
    }
    #[test]
    #[cfg(windows)]
    fn assets_tables_generated_reference_and_source_identity_survive_review_publication_and_reopen()
    {
        let (dir, store, mut model) = fixture();
        configured(&mut model);
        let mut source = bundle(1);
        with_image(&mut source["questions"][0]);
        let request = payload(source.clone(), "simulated-image-bundle");
        let record =
            prepare(&store, &model, &request, &AtomicBool::new(false)).unwrap()["import"].clone();
        assert_eq!(record["questions"].as_array().unwrap().len(), 1);
        assert_eq!(record["questions"][0]["reviewDecision"], "pending");
        assert_eq!(record["questions"][0]["reviewIssues"], json!([]));
        assert_eq!(record["questions"][0]["answer"], "");
        assert_eq!(record["questions"][0]["solution"], "");
        assert_eq!(
            record["questions"][0]["legacyReferences"],
            source["questions"][0]["legacyReferences"]
        );
        assert_eq!(
            prepare(&store, &model, &request, &AtomicBool::new(false)).unwrap()["import"],
            record
        );
        let audit: Value = serde_json::from_slice(
            &std::fs::read(
                dir.path()
                    .join(s(&record["structuredSource"], "auditRelativePath")),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(audit["sourceAudit"], source["sourceAudit"]);
        let approved = approve(&record);
        let reviewed=review_save(&store,&json!({"importId":record["importId"],"operationId":"simulated-image-review","expectedRevision":record["revision"],"questions":approved["questions"]})).unwrap()["import"].clone();
        assert_eq!(
            reviewed["questions"][0]["assetPayloads"],
            record["questions"][0]["assetPayloads"]
        );
        let mut washed = rows(&reviewed["questions"]);
        washed[0]["legacyReferences"]["answers"][0]["provenance"] = json!("manual");
        assert_eq!(review_save(&store,&json!({"importId":record["importId"],"operationId":"simulated-wash","expectedRevision":reviewed["revision"],"questions":washed})).unwrap_err().code,"immutable_source");
        let published=publish(&store,&json!({"importId":record["importId"],"operationId":"simulated-image-publish","expectedRevision":reviewed["revision"],"acknowledgeReview":true}),&AtomicBool::new(false)).unwrap();
        assert_eq!(published["publication"]["addedQuestions"], 1);
        let q = store
            .bank
            .question(s(&reviewed["questions"][0], "questionId"))
            .unwrap();
        assert_eq!(
            q["student"]["assets"],
            source["questions"][0]["student"]["assets"]
        );
        assert_eq!(q["assetPayloads"], source["questions"][0]["assetPayloads"]);
        assert!(s(&q["student"], "stem").contains("<table>"));
        assert_eq!(q["teacher"]["answers"], json!([]));
        assert!(!q["student"].to_string().contains("旧生成"));
        assert_eq!(
            q["sourceIdentity"],
            source["questions"][0]["sourceIdentity"]
        );
        drop(store);
        let reopened = Store::open(dir.path(), &crate::bank::tests::seed()).unwrap();
        assert_eq!(reopened.bank.question(s(&q, "questionId")).unwrap(), q);
    }
    #[test]
    #[cfg(windows)]
    fn missing_or_bad_asset_is_retained_but_cannot_be_approved() {
        let (_dir, store, mut model) = fixture();
        configured(&mut model);
        for index in 0..3 {
            let mut source = bundle(1);
            with_image(&mut source["questions"][0]);
            match index {
                0 => source["questions"][0]["assetPayloads"] = json!([]),
                1 => source["questions"][0]["assetPayloads"][0]["sha256"] = json!("0".repeat(64)),
                _ => {
                    source["questions"][0]["stem"] =
                        json!("模拟引用缺另一幅图 ![缺图](asset:not-present)")
                }
            };
            let record = prepare(
                &store,
                &model,
                &payload(source, &format!("simulated-bad-asset-{index}")),
                &AtomicBool::new(false),
            )
            .unwrap()["import"]
                .clone();
            assert!(
                !record["questions"][0]["reviewIssues"]
                    .as_array()
                    .unwrap()
                    .is_empty()
            );
            assert_eq!(
                build_manifest(&store, &approve(&record)).unwrap_err().code,
                "source_content_unresolved"
            );
        }
    }
    #[test]
    #[cfg(windows)]
    fn source_review_budget_excludes_preserved_teaching_history_but_retains_actual_source_limits() {
        let (_dir,store,mut model)=fixture();configured(&mut model);
        let mut record=prepare(&store,&model,&payload(bundle(10),"sim-large-teaching-history"),&AtomicBool::new(false)).unwrap()["import"].clone();
        teaching::initialize_pending(&mut record["questions"][0]);
        record["questions"][0]["teachingWorkflow"]["preservedAuditHistory"]=json!([{"request":"模拟教学请求".repeat(50_000),"response":"模拟历史响应".repeat(50_000)}]);
        let workflow=record["questions"][0]["teachingWorkflow"].clone();
        assert!(workflow.to_string().chars().count()>MAX_TEXT);
        let mut without=record["questions"][0].clone();without.as_object_mut().unwrap().remove("teachingWorkflow");
        assert_eq!(body_chars(&record["questions"][0]),body_chars(&without));
        store.put_document("imports",s(&record,"importId"),&record).unwrap();
        let saved=review_save(&store,&json!({"importId":record["importId"],"expectedRevision":record["revision"],"operationId":"sim-save-short-source-large-history","questions":record["questions"]})).unwrap()["import"].clone();
        assert_eq!(saved["questions"][0]["teachingWorkflow"],workflow);
        // Long real source fields still fail the whole-review limit, even
        // though each individual field remains inside its normalizer bound.
        for field in ["stem","answer","solution"] {
            let mut questions=saved["questions"].clone();
            for q in questions.as_array_mut().unwrap(){q[field]=json!("文".repeat(25_000));}
            let error=review_save(&store,&json!({"importId":saved["importId"],"expectedRevision":saved["revision"],"operationId":format!("sim-over-budget-{field}"),"questions":questions})).unwrap_err();
            assert_eq!(error.code,"invalid_import");assert!(error.message.contains("总长度"),"{field}: {}",error.message);
            assert_eq!(store.document("imports",s(&saved,"importId")).unwrap(),saved);
        }
        let mut real=saved["questions"][0].clone();
        for (field,value) in [("options",json!([{"label":"A","text":"文".repeat(MAX_TEXT)}])),("parts",json!([{"partId":"p","prompt":"文".repeat(MAX_TEXT),"answer":"","solution":""}]))] {
            real[field]=value;assert!(body_chars(&real)>MAX_TEXT,"{field} still counts as source body");real[field]=json!([]);
        }
    }
    #[test]
    #[cfg(windows)]
    fn binary_payloads_do_not_count_as_prose_and_audit_tampering_blocks_publication() {
        let (dir, store, mut model) = fixture();
        configured(&mut model);
        let mut source = bundle(1);
        with_image(&mut source["questions"][0]);
        let mut bytes = base64::engine::general_purpose::STANDARD
            .decode(s(&source["questions"][0]["assetPayloads"][0], "dataBase64"))
            .unwrap();
        // PNG permits trailing data; retain the original decoded pixel image.
        bytes.extend(vec![0u8; 300_000]);
        let hash = sha(&bytes);
        source["questions"][0]["assetPayloads"][0]["dataBase64"] =
            json!(base64::engine::general_purpose::STANDARD.encode(bytes));
        source["questions"][0]["assetPayloads"][0]["sha256"] = json!(hash);
        source["questions"][0]["student"]["assets"][0]["sha256"] = json!(hash);
        let record = prepare(
            &store,
            &model,
            &payload(source, "simulated-large-binary"),
            &AtomicBool::new(false),
        )
        .unwrap()["import"]
            .clone();
        assert!(record["questions"].to_string().len() > MAX_TEXT);
        let approved = approve(&record);
        let reviewed=review_save(&store,&json!({"importId":record["importId"],"operationId":"simulated-large-review","expectedRevision":record["revision"],"questions":approved["questions"]})).unwrap()["import"].clone();
        std::fs::write(
            dir.path()
                .join(s(&reviewed["structuredSource"], "auditRelativePath")),
            b"{}",
        )
        .unwrap();
        assert_eq!(publish(&store,&json!({"importId":reviewed["importId"],"operationId":"simulated-audit-tampered","expectedRevision":reviewed["revision"],"acknowledgeReview":true}),&AtomicBool::new(false)).unwrap_err().code,"source_changed");
    }
    #[cfg(windows)]
    fn server(
        model: &mut ModelClient,
        handler: impl Fn(Value) -> Value + Send + 'static,
    ) -> std::thread::JoinHandle<Value> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        model.save(&json!({"baseUrl":format!("http://{}/v1",listener.local_addr().unwrap()),"model":"simulated-structured","apiKey":"simulated-only"})).unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(15)))
                .unwrap();
            let mut bytes = vec![];
            let mut chunk = [0u8; 4096];
            loop {
                let n = stream.read(&mut chunk).unwrap();
                bytes.extend_from_slice(&chunk[..n]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                    let length = header
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("content-length:")
                                .map(|s| s.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    if bytes.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let end = bytes.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
            let request: Value = serde_json::from_slice(&bytes[end + 4..]).unwrap();
            let context: Value =
                serde_json::from_str(request["messages"][1]["content"].as_str().unwrap()).unwrap();
            let result = handler(context.clone());
            let body = json!({"choices":[{"message":{"content":result.to_string()}}]}).to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
            context
        })
    }
    fn proposal(context: Value) -> Value {
        json!({"questions":rows(&context["questions"]).iter().map(|q|json!({"questionId":q["questionId"],"task":{"label":"模拟内容考查"},"difficultyAssessment":{"level":"easy_medium","basis":"模拟依据：常规方法上增加一次等价表示转换。","rubricVersion":"content-demand-v1"},"knowledgeSchemaVersion":2,"primaryKnowledgeUids":[],"solutionPaths":[]})).collect::<Vec<_>>()})
    }
    fn with_ready_teaching(q: &mut Value) {
        teaching::initialize(q, &json!({"generatedTeaching":{"answer":"17",
            "difficultyAssessment":{"level":"easy","basis":"题面明确要求整数相加，直接运算即可。"},
            "teachingSolution":"由题意，$7+10=17$。",
            "teachingFocusSchemaVersion":2,"teachingFocus":{"examFocus":"整数相加。",
                "studentRequirements":["写出正确的和。"]},"issues":[]}}));
        assert!(teaching::ready(q));
    }
    #[test]
    fn annotation_reference_is_source_bound_and_never_promotes_pending_or_failed_drafts() {
        let mut q = bundle(1)["questions"][0].clone();
        q["questionId"] = json!("simulated-teaching-reference-q1");
        with_ready_teaching(&mut q);
        let before = q.clone();
        let input = annotation_input(&q);
        let reference = &input["teachingReference"];
        assert_eq!(reference["provenance"], "llm_generated");
        assert_eq!(reference["originalPaperReference"], false);
        assert_eq!(reference["independentlyVerified"], false);
        assert_eq!(reference["sourceContentSha256"], teaching::source_hash(&q));
        assert_eq!(reference["candidateSha256"], hash_json(&q["teachingWorkflow"]["finalResult"]));
        assert_eq!(reference["solution"], q["teachingWorkflow"]["finalResult"]["teachingSolution"]);
        assert_eq!(input["answer"], "");
        assert_eq!(input["solution"], "");
        assert!(input.get("teachingWorkflow").is_none());
        assert_eq!(q, before);
        for status in ["generation_pending", "generation_failed", "needs_review", "review_failed"] {
            let mut held = q.clone();
            held["teachingWorkflow"]["status"] = json!(status);
            assert!(annotation_input(&held).get("teachingReference").is_none(), "{status}");
        }
        let mut stale = q.clone();
        stale["stem"] = json!("模拟题面已修改");
        assert!(annotation_input(&stale).get("teachingReference").is_none());
        let mut failed = q.clone();
        failed["teachingWorkflow"]["reviewFailurePending"] = json!(true);
        assert!(annotation_input(&failed).get("teachingReference").is_none());
        let mut malformed = q.clone();
        malformed["teachingWorkflow"]["finalResult"]["questionId"] = json!("other-q");
        assert!(annotation_input(&malformed).get("teachingReference").is_none());
    }
    #[test]
    #[cfg(windows)]
    fn explicit_metadata_supplement_uses_ready_ai_reference_without_rewriting_source_or_review() {
        let dir = tempfile::tempdir().unwrap();
        let mut seed = crate::bank::tests::seed();
        seed["config"]["knowledgeCatalogue"] = json!({"points":[{
            "uid":"simulated-addition-leaf","name":"模拟整数加法","isLeaf":true,
            "parentUid":null,"sectionIds":[]}]});
        let store = Store::open(dir.path(), &seed).unwrap();
        std::fs::write(dir.path().join("model-settings.json"), b"{}").unwrap();
        let mut model = ModelClient::open(dir.path()).unwrap();
        configured(&mut model);
        let mut record = prepare(&store, &model,
            &payload(bundle(1), "simulated-teaching-metadata-prepare"),
            &AtomicBool::new(false)).unwrap()["import"].clone();
        let uid = rows(&trusted_catalog(&store).unwrap()["knowledgePoints"]).iter()
            .find(|point| point["isLeaf"] == true).unwrap()["uid"].clone();
        let q = &mut record["questions"][0];
        with_ready_teaching(q);
        q["difficultyAssessment"] = json!({"level":"medium","basis":"模拟教师已有难度说明。","rubricVersion":"content-demand-v1"});
        q["primaryKnowledgeUids"] = json!([uid]);
        q["reviewDecision"] = json!("approve");
        q["reviewBasis"] = json!("模拟教师已有核对依据。 ");
        let original = q.clone();
        store.put_document("imports", s(&record, "importId"), &record).unwrap();
        let response_uid = uid.clone();
        let mock = server(&mut model, move |context| {
            assert_eq!(context["questions"][0]["answer"], "");
            assert_eq!(context["questions"][0]["solution"], "");
            assert_eq!(context["questions"][0]["teachingReference"]["provenance"], "llm_generated");
            assert!(s(&context, "teachingReferencePolicy").contains("非独立数学核验"));
            let mut result = proposal(context);
            result["questions"][0]["primaryKnowledgeUids"] = json!([response_uid]);
            result["questions"][0]["solutionPaths"] = json!([{"id":"path-1",
                "requiredKnowledgeUids":[response_uid],"requiredPremises":[],
                "basis":"AI教学参考，非原卷解析：由原条件完成整数相加，依赖所标运算知识。"}]);
            result
        });
        let updated = step(&store, &model, &json!({"importId":record["importId"],
            "operationId":"simulated-teaching-metadata-step","expectedRevision":record["revision"],
            "supplementOnly":true,"questionIds":[original["questionId"]]}),
            &AtomicBool::new(false)).unwrap()["import"].clone();
        mock.join().unwrap();
        let q = &updated["questions"][0];
        assert_eq!(q["annotationStatus"], "succeeded");
        assert_eq!(q["solutionPaths"][0]["id"], "path-1");
        for field in ["stem", "options", "parts", "answer", "solution", "sourceIdentity",
            "student", "teacher", "assetPayloads", "legacyReferences", "sourceIssues",
            "reviewDecision", "reviewBasis", "reviewChecks", "teachingWorkflow", "difficultyAssessment",
            "primaryKnowledgeUids"] {
            assert_eq!(q[field], original[field], "{field}");
        }
    }
    #[test]
    #[cfg(windows)]
    fn metadata_batches_are_exact_read_only_idempotent_and_keep_failed_questions_retryable() {
        let (_dir, store, mut model) = fixture();
        configured(&mut model);
        let source = bundle(6);
        let mut record = prepare(
            &store,
            &model,
            &payload(source, "simulated-six"),
            &AtomicBool::new(false),
        )
        .unwrap()["import"]
            .clone();
        let original = rows(&record["questions"]);
        let mock = server(&mut model, |context| {
            let mut p = proposal(context);
            p["questions"][1]["difficultyAssessment"]["basis"] = json!("");
            p
        });
        let request = json!({"importId":record["importId"],"operationId":"simulated-batch1","expectedRevision":record["revision"]});
        record = step(&store, &model, &request, &AtomicBool::new(false)).unwrap()["import"].clone();
        let context = mock.join().unwrap();
        assert_eq!(rows(&context["questions"]).len(), 5);
        assert_eq!(
            rows(&record["questions"])
                .iter()
                .filter(|q| q["annotationStatus"] == "succeeded")
                .count(),
            4
        );
        assert_eq!(record["questions"][1]["annotationStatus"], "failed");
        assert_eq!(record["questions"][5]["annotationStatus"], "pending");
        assert!(record["annotationBatches"][0]["modelResult"].is_object());
        assert_eq!(
            step(&store, &model, &request, &AtomicBool::new(false)).unwrap()["import"],
            record
        );
        let retry = server(&mut model, proposal);
        record=step(&store,&model,&json!({"importId":record["importId"],"operationId":"simulated-batch2","expectedRevision":record["revision"]}),&AtomicBool::new(false)).unwrap()["import"].clone();
        assert_eq!(rows(&retry.join().unwrap()["questions"]).len(), 2);
        assert!(
            rows(&record["questions"])
                .iter()
                .all(|q| q["annotationStatus"] == "succeeded")
        );
        for (i, q) in rows(&record["questions"]).iter().enumerate() {
            for field in [
                "stem",
                "options",
                "parts",
                "answer",
                "solution",
                "sourceIdentity",
                "legacyReferences",
            ] {
                assert_eq!(q[field], original[i][field]);
            }
            assert_eq!(q["reviewDecision"], "pending");
            assert_eq!(q["reviewChecks"]["sourceMatched"], false);
        }
        let previous = record.clone();
        let malicious = server(&mut model, |context| {
            let mut p = proposal(context);
            p["questions"][0]["stem"] = json!("模型篡改");
            p
        });
        let mut another = prepare(
            &store,
            &model,
            &payload(bundle(1), "simulated-malicious"),
            &AtomicBool::new(false),
        )
        .unwrap()["import"]
            .clone();
        another=step(&store,&model,&json!({"importId":another["importId"],"operationId":"simulated-malicious-step","expectedRevision":another["revision"]}),&AtomicBool::new(false)).unwrap()["import"].clone();
        malicious.join().unwrap();
        assert_eq!(another["questions"][0]["annotationStatus"], "failed");
        assert_eq!(record, previous);
    }
    #[test]
    #[cfg(windows)]
    fn model_output_is_durable_when_concurrent_review_wins_cas_and_is_not_automatically_adopted() {
        let (dir, store, mut model) = fixture();
        configured(&mut model);
        let record = prepare(
            &store,
            &model,
            &payload(bundle(1), "simulated-cas-bundle"),
            &AtomicBool::new(false),
        )
        .unwrap()["import"]
            .clone();
        let directory = dir.path().to_owned();
        let concurrent = record.clone();
        let mock = server(&mut model, move |context| {
            let other = Store::open(&directory, &crate::bank::tests::seed()).unwrap();
            let mut edited = rows(&concurrent["questions"]);
            edited[0]["stem"] = json!(format!("{} 模拟另一窗口审核修改", s(&edited[0], "stem")));
            review_save(&other,&json!({"importId":concurrent["importId"],"operationId":"simulated-other-review","expectedRevision":concurrent["revision"],"questions":edited})).unwrap();
            proposal(context)
        });
        let request = json!({"importId":record["importId"],"operationId":"simulated-stale-batch","expectedRevision":record["revision"]});
        assert_eq!(
            step(&store, &model, &request, &AtomicBool::new(false))
                .unwrap_err()
                .code,
            "revision_conflict"
        );
        mock.join().unwrap();
        let current = store.document("imports", s(&record, "importId")).unwrap();
        assert!(s(&current["questions"][0], "stem").contains("另一窗口"));
        assert_eq!(current["questions"][0]["annotationStatus"], "pending");
        assert!(rows(&current["annotationBatches"]).is_empty());
        let path = attempt_file(&store, &record, "simulated-stale-batch").unwrap();
        let raw: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert!(raw["modelResult"]["questions"][0]["difficultyAssessment"].is_object());
        assert_eq!(raw["expectedRevision"], record["revision"]);
        let mut replay = request.clone();
        replay["expectedRevision"] = current["revision"].clone();
        assert_eq!(
            step(&store, &model, &replay, &AtomicBool::new(false))
                .unwrap_err()
                .code,
            "operation_conflict"
        );
        assert_eq!(
            store.document("imports", s(&record, "importId")).unwrap(),
            current
        );
    }
}
