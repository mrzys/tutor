//! Explicit teaching-material maintenance. Original bank questions and source
//! verification remain immutable; generated explanations have a separate identity.
use crate::{
    annotations::{RUBRIC_VERSION, normalize_difficulty},
    bank::{BankRepository, LocalQuestionBank, hash_json},
    error::{AppError, AppResult},
};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use std::collections::HashSet;

fn invalid(message: &str) -> AppError {
    AppError::new("invalid_teaching_analysis", message)
}
fn conflict(message: &str) -> AppError {
    AppError::new("teaching_analysis_conflict", message)
}
fn text<'a>(v: &'a Value, key: &str, limit: usize) -> AppResult<&'a str> {
    v[key]
        .as_str()
        .filter(|s| {
            !s.trim().is_empty()
                && s.chars().count() <= limit
                && !s.chars().any(|c| c.is_control() && c != '\n' && c != '\t')
        })
        .ok_or_else(|| invalid(&format!("教学整理缺少有效字段：{key}。")))
}
fn sha<'a>(v: &'a Value, key: &str) -> AppResult<&'a str> {
    let value = text(v, key, 64)?;
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid("教学整理哈希格式无效。"));
    }
    Ok(value)
}
fn timestamp(v: &Value, key: &str) -> AppResult<()> {
    let value = text(v, key, 80)?;
    chrono::DateTime::parse_from_rfc3339(value).map_err(|_| invalid("教学整理时间格式无效。"))?;
    Ok(())
}
fn issues(v: &Value) -> AppResult<&Vec<Value>> {
    let entries = v["issues"]
        .as_array()
        .filter(|a| a.len() <= 100)
        .ok_or_else(|| invalid("教学整理疑点必须是文本数组。"))?;
    for issue in entries {
        text(&json!({"issue":issue}), "issue", 4000)?;
    }
    Ok(entries)
}
/// Classroom descriptions are generated text, not UID mappings or evidence of
/// a particular student's actual knowledge. Missing fields remain compatible
/// with older generations; a present value must satisfy the complete contract.
fn verify_teaching_focus(focus: &Value, version: Option<&Value>) -> AppResult<()> {
    let modern = match version {
        None => false,
        Some(value) if value == 2 => true,
        Some(_) => return Err(invalid("教学考查信息版本不受支持。")),
    };
    let keys: &[&str] = if modern {
        &["examFocus", "studentRequirements"]
    } else {
        &["knowledgePoints", "examFocus", "studentRequirements"]
    };
    let object = focus
        .as_object()
        .filter(|object| {
            object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
        })
        .ok_or_else(|| invalid("教学考查信息字段与保存版本不一致。"))?;
    if !modern {
        let points = object["knowledgePoints"]
            .as_array()
            .filter(|points| !points.is_empty() && points.len() <= 12)
            .ok_or_else(|| invalid("教学知识点需为1至12个简短名称。"))?;
        for point in points {
            text(&json!({"knowledgePoint":point}), "knowledgePoint", 120)?;
        }
    }
    text(focus, "examFocus", 600)?;
    let requirements = object["studentRequirements"]
        .as_array()
        .filter(|requirements| (1..=3).contains(&requirements.len()))
        .ok_or_else(|| invalid("学生作答要求需为1至3条可观察的要求。"))?;
    for requirement in requirements {
        text(
            &json!({"studentRequirement":requirement}),
            "studentRequirement",
            400,
        )?;
    }
    Ok(())
}
fn verify_focus_container(container: &Value) -> AppResult<()> {
    match container.get("teachingFocus") {
        Some(focus) => verify_teaching_focus(focus, container.get("teachingFocusSchemaVersion")),
        None if container.get("teachingFocusSchemaVersion").is_some() => {
            Err(invalid("教学考查信息版本缺少对应内容。"))
        }
        None => Ok(()),
    }
}
fn has_formal_knowledge(annotation: &Value, config: &Value) -> bool {
    annotation["primaryKnowledgeUids"]
        .as_array()
        .is_some_and(|uids| !uids.is_empty())
        && crate::knowledge::validate_annotation(annotation, config).is_ok()
}
fn canonical_focus(analysis: &mut Value) {
    analysis["teachingFocus"]
        .as_object_mut()
        .unwrap()
        .remove("knowledgePoints");
    analysis["teachingFocusSchemaVersion"] = json!(2);
}
fn sign_analysis(analysis: &mut Value) {
    let digest = hash_json(&analysis_content(analysis));
    analysis["sha256"] = json!(digest);
    analysis["teachingVersion"] = json!(format!("teaching-{}", &digest[..16]));
}
fn analysis_content(analysis: &Value) -> Value {
    let mut content = analysis.clone();
    if let Some(object) = content.as_object_mut() {
        object.remove("sha256");
        object.remove("teachingVersion");
    }
    content
}

/// Raw model issues remain immutable. Only exact, evidence-bearing dispositions
/// tied to this candidate and source can make an observation nonblocking.
fn blocking_issue_count(analysis: &Value, raw: &Value) -> AppResult<usize> {
    let all = issues(analysis)?;
    let Some(dispositions) = analysis.get("reviewDispositions") else { return Ok(all.len()); };
    let candidate = &analysis["sourceCandidate"];
    if dispositions["version"] != 1 || !candidate.is_object()
        || candidate["questionId"] != analysis["sourceQuestionId"]
        || analysis["sourceQuestionId"] != raw["questionId"]
        || dispositions["candidateSha256"] != hash_json(candidate)
        || dispositions["sourceContentSha256"] != analysis["sourceContentSha256"]
        || candidate["issues"] != analysis["issues"]
        || candidate["teachingSolution"] != analysis["solution"]
        || candidate["answer"] != analysis["answer"]
        || candidate["teachingFocus"] != analysis["teachingFocus"]
        || candidate["teachingFocusSchemaVersion"] != analysis["teachingFocusSchemaVersion"]
    { return Err(invalid("告警处置与当前来源、候选或教学字段不一致。")); }
    sha(analysis,"sourceContentSha256")?;
    let acknowledgements = dispositions["acknowledgements"].as_array()
        .filter(|a|a.len()<=100).ok_or_else(||invalid("告警处置记录格式无效。"))?;
    let mut covered = HashSet::new();
    for ack in acknowledgements {
        let index = ack["issueIndex"].as_u64().and_then(|i|usize::try_from(i).ok())
            .filter(|i|*i<all.len()).ok_or_else(||invalid("告警处置位置无效。"))?;
        if !covered.insert(index) || ack["message"] != all[index]
            || ack["issueSha256"] != hash_json(&all[index])
            || !matches!(ack["classification"].as_str(),Some("reference_notice"|"nonblocking_observation"))
            || !matches!((ack["method"].as_str(),ack["checkedBy"].as_str()),
                (Some("teacher_review"),Some("teacher"))|(Some("user_authorized_agent_review"),Some("codex")))
            || ["sourceMatched","answerChecked","solutionChecked","formulaChecked"].iter().any(|key|ack["checks"][*key]!=true)
        { return Err(invalid("告警处置缺少逐项核对或身份、原文不匹配。")); }
        text(ack,"basis",5000)?;text(ack,"operationId",100)?;timestamp(ack,"acknowledgedAt")?;
    }
    Ok(all.len()-covered.len())
}
fn verify_analysis(analysis: &Value, raw: &Value) -> AppResult<()> {
    if !analysis.is_object()
        || analysis["questionId"] != raw["questionId"]
        || analysis["baseContentVersion"] != raw["contentVersion"]
        || analysis["baseTeacherVersion"] != raw["teacherVersion"]
        || analysis["provenance"] != "llm_generated"
    {
        return Err(invalid("教学解析不属于当前原题及参考材料版本。"));
    }
    text(analysis, "solution", 60000)?;
    // New imports retain the independently generated answer alongside their
    // classroom explanation. Historical maintenance generations omit it;
    // original teacher answers and old frozen snapshots are never changed.
    if analysis.get("answer").is_some() {
        text(analysis,"answer",30000)?;
    }
    text(analysis, "model", 200)?;
    text(analysis, "operationId", 160)?;
    sha(analysis, "promptSha256")?;
    sha(analysis, "requestSha256")?;
    timestamp(analysis, "generatedAt")?;
    verify_focus_container(analysis)?;
    let findings = issues(analysis)?;
    if let Some(flags) = analysis.get("maintenanceFlags") {
        let flags = flags
            .as_array()
            .filter(|entries| !entries.is_empty() && entries.len() <= 100)
            .ok_or_else(|| invalid("教学整理标记历史必须是非空数组。"))?;
        let mut operations = HashSet::new();
        for flag in flags {
            let operation = text(flag, "operationId", 160)?;
            if operation.chars().any(char::is_control) || !operations.insert(operation) {
                return Err(invalid("教学整理标记操作身份无效或重复。"));
            }
            timestamp(flag, "markedAt")?;
            let marked = issues(flag)?;
            if marked.is_empty() || marked.iter().any(|issue| !findings.contains(issue)) {
                return Err(invalid("教学整理标记缺少具体疑点或与当前疑点不一致。"));
            }
        }
    }
    let expected_status = if blocking_issue_count(analysis,raw)? == 0 {
        "ready"
    } else {
        "needs_review"
    };
    if analysis["status"] != expected_status {
        return Err(invalid("教学解析状态与保存的疑点不一致。"));
    }
    let expected = hash_json(&analysis_content(analysis));
    if sha(analysis, "sha256")? != expected
        || analysis["teachingVersion"] != format!("teaching-{}", &expected[..16])
    {
        return Err(invalid("教学解析自身版本或哈希校验失败。"));
    }
    Ok(())
}

/// Validate a teaching snapshot already embedded in a draft or frozen paper.
/// This never consults the current bank or refreshes the stored explanation.
pub(crate) fn verify_projection(question: &Value) -> AppResult<()> {
    match question.get("teachingAnalysis") {
        Some(analysis) => verify_analysis(analysis, question),
        None => Ok(()),
    }
}

/// Attach only the independently versioned explanation. Callers use this for
/// current bank views and newly selected question snapshots, never to refresh an
/// existing draft or frozen paper. Raw repository reads stay byte-identical.
pub fn project(raw: &Value, config: &Value) -> AppResult<Value> {
    if !raw.is_object() {
        return Err(invalid("题目投影缺少原始题目。"));
    }
    let mut result = raw.clone();
    result.as_object_mut().unwrap().remove("teachingAnalysis");
    result.as_object_mut().unwrap().remove("importTeachingReview");
    let entries = config["assemblyIndex"]["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| a["questionId"] == raw["questionId"])
        .collect::<Vec<_>>();
    if entries.len() > 1 {
        return Err(invalid("题目存在重复教学索引。"));
    }
    let Some(annotation) = entries.first() else {
        return Ok(result);
    };
    if annotation.get("teachingAnalysis").is_none()
        && annotation.get("importTeachingReview").is_none()
    {
        return Ok(result);
    }
    if ["contentVersion", "teacherVersion"]
        .iter()
        .any(|key| annotation[*key] != raw[*key])
    {
        return Err(invalid("教学索引与原题版本不一致。"));
    }
    if let Some(analysis) = annotation.get("teachingAnalysis") {
        verify_analysis(analysis, raw)?;
        result["teachingAnalysis"] = analysis.clone();
        // A newer, valid teaching draft supersedes the import's historical
        // pending marker. Never resurrect an old warning after maintenance.
    } else if let Some(marker) = annotation.get("importTeachingReview") {
        if !marker.is_object() || !matches!(marker["status"].as_str(), Some("ready" | "needs_review")) {
            return Err(invalid("导入教学稿复核标记格式无效。"));
        }
        if marker["status"] == "needs_review" {
            sha(marker, "sourceContentSha256")?;
            let findings = marker["findings"].as_array()
                .ok_or_else(|| invalid("导入教学稿待复核原因格式无效。"))?;
            let mut projected = vec![];
            for finding in findings {
                if !finding.is_object() {
                    return Err(invalid("导入教学稿待复核原因格式无效。"));
                }
                let mut safe = serde_json::Map::new();
                for key in ["type", "code", "message", "term", "issue", "fieldPath"] {
                    if finding.get(key).is_some() {
                        safe.insert(key.into(), json!(text(finding, key, 4000)?));
                    }
                }
                projected.push(Value::Object(safe));
            }
            let mut safe = json!({"status":"needs_review","findings":projected,"sourceContentSha256":marker["sourceContentSha256"]});
            for key in ["generationCalls", "reviewCalls"] {
                if let Some(value) = marker.get(key) {
                    if !matches!(value.as_u64(), Some(0 | 1)) {
                        return Err(invalid("导入教学稿执行次数格式无效。"));
                    }
                    safe[key] = value.clone();
                }
            }
            result["importTeachingReview"] = safe;
        }
    }
    Ok(result)
}

/// Atomically apply a user-authorized, already generated batch. No provider is
/// contacted here; a malformed/stale entry rolls back every entry and its audit.
pub fn apply(bank: &LocalQuestionBank, manifest: &Value) -> AppResult<Value> {
    let operation = text(manifest, "operationId", 160)?;
    if operation.chars().any(char::is_control) {
        return Err(invalid("教学整理操作身份无效。"));
    }
    let entries = manifest["entries"]
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= 10000)
        .ok_or_else(|| invalid("教学整理必须包含1至10000个条目。"))?;
    let manifest_sha = hash_json(manifest);
    let tx = rusqlite::Transaction::new_unchecked(
        bank.annotation_connection(),
        TransactionBehavior::Immediate,
    )?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS bank_teaching_operations(operation_id TEXT PRIMARY KEY,manifest_sha256 TEXT NOT NULL,payload TEXT NOT NULL,sha256 TEXT NOT NULL);")?;
    let previous: Option<(String, String, String)> = tx.query_row(
        "SELECT manifest_sha256,payload,sha256 FROM bank_teaching_operations WHERE operation_id=?1",
        [operation], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional()?;
    if let Some((old_manifest_sha, payload, old_sha)) = previous {
        let old: Value = serde_json::from_str(&payload)?;
        if old_manifest_sha != manifest_sha || hash_json(&old) != old_sha {
            return Err(conflict(
                "教学整理操作身份已用于不同内容或审计损坏；未修改题库。",
            ));
        }
        let mut receipt = old["receipt"].clone();
        receipt["applied"] = json!(0);
        receipt["replayed"] = json!(true);
        tx.commit()?;
        return Ok(receipt);
    }
    let raw_config: String = tx.query_row(
        "SELECT value FROM bank_metadata WHERE key='config'",
        [],
        |row| row.get(0),
    )?;
    let mut config: Value = serde_json::from_str(&raw_config)?;
    let validation_config = bank.config()?;
    if !config["assemblyIndex"]["entries"].is_array() {
        return Err(invalid("现有题库索引无效，未写入教学整理。"));
    }
    let mut seen = HashSet::new();
    let mut audit = Vec::new();
    for entry in entries {
        let qid = text(entry, "questionId", 250)?;
        if !seen.insert(qid) {
            return Err(invalid("教学整理包含重复题目。"));
        }
        let raw = bank.question(qid)?;
        if sha(entry, "expectedQuestionSha256")? != hash_json(&raw)
            || ["contentVersion", "teacherVersion"].iter().any(|key| {
                entry[*key].as_str().is_none_or(str::is_empty) || entry[*key] != raw[*key]
            })
        {
            return Err(conflict(
                "原题内容、参考材料或版本已变化，整批教学整理已回滚。",
            ));
        }
        let indices = config["assemblyIndex"]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .filter(|(_, a)| a["questionId"] == qid)
            .map(|(i, _)| i)
            .collect::<Vec<_>>();
        if indices.len() != 1 {
            return Err(invalid("教学整理要求题目有唯一的现有索引。"));
        }
        let index = indices[0];
        let old = config["assemblyIndex"]["entries"][index].clone();
        if sha(entry, "expectedAnnotationSha256")? != hash_json(&old)
            || ["contentVersion", "teacherVersion"]
                .iter()
                .any(|key| old[*key] != raw[*key])
        {
            return Err(conflict("题目标注或其版本已变化，整批教学整理已回滚。"));
        }
        let mark_only = match entry.get("markOnly") {
            None => false,
            Some(value) => value
                .as_bool()
                .ok_or_else(|| invalid("仅标记模式必须是布尔值。"))?,
        };
        if mark_only {
            // An unsuccessful model response must never become a new solution
            // or acquire the provenance of a successful generation.
            if [
                "result",
                "model",
                "promptSha256",
                "requestSha256",
                "generatedAt",
            ]
            .iter()
            .any(|key| entry.get(*key).is_some())
            {
                return Err(invalid("仅标记模式不得包含新生成稿或模型溯源。"));
            }
            timestamp(entry, "markedAt")?;
            let issue_container = json!({"issues":entry["maintenanceIssues"]});
            let marked = issues(&issue_container)?;
            if marked.is_empty() {
                return Err(invalid("仅标记模式需要至少一个具体疑点。"));
            }
            let mut analysis = old["teachingAnalysis"].clone();
            verify_analysis(&analysis, &raw)?;
            let mut unique_marked = Vec::new();
            for issue in marked {
                if !unique_marked.contains(issue) {
                    unique_marked.push(issue.clone());
                }
                let existing = analysis["issues"].as_array_mut().unwrap();
                if !existing.contains(issue) {
                    existing.push(issue.clone());
                }
            }
            if analysis.get("maintenanceFlags").is_none() {
                analysis["maintenanceFlags"] = json!([]);
            }
            analysis["maintenanceFlags"]
                .as_array_mut()
                .unwrap()
                .push(json!({"operationId":operation,"markedAt":entry["markedAt"],"issues":unique_marked}));
            analysis["status"] = json!("needs_review");
            sign_analysis(&mut analysis);
            verify_analysis(&analysis, &raw)?;
            let mut next = old.clone();
            next["teachingAnalysis"] = analysis;
            config["assemblyIndex"]["entries"][index] = next.clone();
            audit.push(
                json!({"questionId":qid,"previousAnnotation":old,"annotation":next,
                "expectedQuestionSha256":entry["expectedQuestionSha256"],"maintenance":entry}),
            );
            continue;
        }
        let result = &entry["result"];
        text(result, "answer", 30000)?;
        let solution = text(result, "teachingSolution", 60000)?;
        let findings = issues(result)?;
        if !result["difficultyAssessment"].is_object() {
            return Err(invalid("教学整理缺少难度评估。"));
        }
        let difficulty = normalize_difficulty(result)?;
        verify_focus_container(result)?;
        let formal_knowledge = has_formal_knowledge(&old, &validation_config);
        if result.get("teachingFocusSchemaVersion").is_some() && !formal_knowledge {
            return Err(invalid(
                "精简教学考查信息需要有效的正式主考知识关联，未修改题库。",
            ));
        }
        let model = text(entry, "model", 200)?;
        let prompt_sha = sha(entry, "promptSha256")?;
        let request_sha = sha(entry, "requestSha256")?;
        timestamp(entry, "generatedAt")?;
        let mut analysis = json!({
            "questionId":qid,
            "baseContentVersion":raw["contentVersion"],"baseTeacherVersion":raw["teacherVersion"],
            "provenance":"llm_generated","model":model,"promptSha256":prompt_sha,
            "requestSha256":request_sha,"operationId":operation,"solution":solution,
            "generatedAt":entry["generatedAt"],
            "status":if findings.is_empty() {"ready"} else {"needs_review"},"issues":findings,
        });
        if let Some(focus) = result.get("teachingFocus") {
            analysis["teachingFocus"] = focus.clone();
            if formal_knowledge {
                canonical_focus(&mut analysis);
            }
        }
        sign_analysis(&mut analysis);
        verify_analysis(&analysis, &raw)?;
        let mut next = old.clone();
        next["difficultyLevel"] = difficulty["level"].clone();
        next["difficultyBasis"] = difficulty["basis"].clone();
        next["difficultyRubricVersion"] = json!(RUBRIC_VERSION);
        next["teachingAnalysis"] = analysis;
        // No source, teacher, knowledge role, complete path, or old review field
        // is copied from provider output or rewritten as a consequence of it.
        config["assemblyIndex"]["entries"][index] = next.clone();
        audit.push(
            json!({"questionId":qid,"previousAnnotation":old,"annotation":next,
            "expectedQuestionSha256":entry["expectedQuestionSha256"],"generation":entry}),
        );
    }
    let receipt = json!({"operationId":operation,"manifestSha256":manifest_sha,
        "applied":entries.len(),"total":entries.len(),"replayed":false,
        "originalQuestionsChanged":0,"originalTeacherMaterialsChanged":0});
    let stored = json!({"schemaVersion":1,"manifest":manifest,"appliedAt":chrono::Utc::now().to_rfc3339(),
        "items":audit,"receipt":receipt});
    tx.execute(
        "UPDATE bank_metadata SET value=?1 WHERE key='config'",
        [config.to_string()],
    )?;
    tx.execute("INSERT INTO bank_teaching_operations(operation_id,manifest_sha256,payload,sha256) VALUES(?1,?2,?3,?4)",
        params![operation,manifest_sha,stored.to_string(),hash_json(&stored)])?;
    tx.commit()?;
    Ok(receipt)
}

/// Normalize only the live bank annotations. Legacy snapshots and original
/// questions retain their original hashes; the complete old annotation is
/// archived before its redundant generated knowledge names are removed.
pub fn normalize_focus(bank: &LocalQuestionBank) -> AppResult<Value> {
    const OPERATION: &str = "teaching-focus-v2";
    let tx = rusqlite::Transaction::new_unchecked(
        bank.annotation_connection(),
        TransactionBehavior::Immediate,
    )?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS bank_teaching_focus_migrations(operation_id TEXT PRIMARY KEY,payload TEXT NOT NULL,sha256 TEXT NOT NULL);")?;
    let previous: Option<(String, String)> = tx
        .query_row(
            "SELECT payload,sha256 FROM bank_teaching_focus_migrations WHERE operation_id=?1",
            [OPERATION],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let mut audit = Vec::new();
    if let Some((payload, digest)) = previous {
        let stored: Value = serde_json::from_str(&payload)?;
        if hash_json(&stored) != digest
            || stored["operationId"] != OPERATION
            || stored["schemaVersion"] != 2
            || !stored["items"].is_array()
        {
            return Err(conflict("教学信息升级审计损坏，未修改题库。"));
        }
        audit = stored["items"].as_array().unwrap().clone();
        for item in &audit {
            if item["previousAnnotationSha256"] != hash_json(&item["previousAnnotation"])
                || item["annotationSha256"] != hash_json(&item["annotation"])
            {
                return Err(conflict("教学信息升级条目审计损坏，未修改题库。"));
            }
        }
    }
    let payload: String = tx.query_row(
        "SELECT value FROM bank_metadata WHERE key='config'",
        [],
        |r| r.get(0),
    )?;
    let mut config: Value = serde_json::from_str(&payload)?;
    let validation_config = bank.config()?;
    let Some(entries) = config["assemblyIndex"]["entries"].as_array_mut() else {
        // Minimal historical/test seeds may have no teaching index at all.
        tx.commit()?;
        return Ok(
            json!({"operationId":OPERATION,"applied":0,"total":audit.len(),"skippedWithoutFormalKnowledge":0,"replayed":true,"originalQuestionsChanged":0,"originalTeacherMaterialsChanged":0}),
        );
    };
    let mut seen = HashSet::new();
    let mut applied = 0;
    let mut skipped = 0;
    for annotation in entries {
        let Some(analysis) = annotation.get("teachingAnalysis") else {
            continue;
        };
        let qid = text(annotation, "questionId", 250)?.to_owned();
        if !seen.insert(qid.clone()) {
            return Err(invalid("教学信息升级发现重复题目索引。"));
        }
        let raw = bank.question(&qid)?;
        if ["contentVersion", "teacherVersion"]
            .iter()
            .any(|key| annotation[*key] != raw[*key])
        {
            return Err(conflict("教学信息升级发现过期题目索引，整批已回滚。"));
        }
        verify_analysis(analysis, &raw)?;
        if analysis.get("teachingFocus").is_none()
            || analysis.get("teachingFocusSchemaVersion").is_some()
        {
            continue;
        }
        if !has_formal_knowledge(annotation, &validation_config) {
            skipped += 1;
            continue;
        }
        let previous = annotation.clone();
        canonical_focus(&mut annotation["teachingAnalysis"]);
        sign_analysis(&mut annotation["teachingAnalysis"]);
        verify_analysis(&annotation["teachingAnalysis"], &raw)?;
        audit.push(
            json!({"questionId":qid,"expectedQuestionSha256":hash_json(&raw),
            "previousAnnotationSha256":hash_json(&previous),"previousAnnotation":previous,
            "annotationSha256":hash_json(annotation),"annotation":annotation.clone()}),
        );
        applied += 1;
    }
    let receipt = json!({"operationId":OPERATION,"applied":applied,"total":audit.len(),
        "skippedWithoutFormalKnowledge":skipped,"replayed":applied==0,
        "originalQuestionsChanged":0,"originalTeacherMaterialsChanged":0});
    if applied > 0 {
        let stored = json!({"schemaVersion":2,"operationId":OPERATION,"items":audit,"receipt":receipt,
            "updatedAt":chrono::Utc::now().to_rfc3339()});
        tx.execute(
            "UPDATE bank_metadata SET value=?1 WHERE key='config'",
            [config.to_string()],
        )?;
        tx.execute("INSERT INTO bank_teaching_focus_migrations(operation_id,payload,sha256) VALUES(?1,?2,?3) ON CONFLICT(operation_id) DO UPDATE SET payload=excluded.payload,sha256=excluded.sha256",
            params![OPERATION,stored.to_string(),hash_json(&stored)])?;
    }
    tx.commit()?;
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_bound_notice_keeps_raw_issue_but_rejects_forged_or_stale_disposition() {
        let issue="模拟参考笔误，已对照原题核实，不影响新教学稿。";
        let candidate=json!({"questionId":"sim-notice","answer":"2","teachingSolution":"模拟1+1=2。",
            "teachingFocusSchemaVersion":2,"teachingFocus":{"examFocus":"模拟加法","studentRequirements":["能计算。"]},
            "difficultyAssessment":{"level":"easy","basis":"模拟直接计算。"},"issues":[issue]});
        let raw=json!({"questionId":"sim-notice"});
        let mut analysis=json!({"sourceQuestionId":"sim-notice","sourceContentSha256":"c".repeat(64),
            "sourceCandidate":candidate,"answer":"2","solution":"模拟1+1=2。","issues":[issue],
            "teachingFocusSchemaVersion":2,"teachingFocus":candidate["teachingFocus"],
            "reviewDispositions":{"version":1,"sourceContentSha256":"c".repeat(64),"candidateSha256":hash_json(&candidate),
                "acknowledgements":[{"issueIndex":0,"message":issue,"issueSha256":hash_json(&json!(issue)),
                    "classification":"reference_notice","basis":"模拟已对照原页与新稿逐项核查。",
                    "checks":{"sourceMatched":true,"answerChecked":true,"solutionChecked":true,"formulaChecked":true},
                    "method":"user_authorized_agent_review","checkedBy":"codex","operationId":"sim-notice-ack","acknowledgedAt":"2026-10-24T00:00:00Z"}]}});
        assert_eq!(blocking_issue_count(&analysis,&raw).unwrap(),0);
        assert_eq!(analysis["issues"],json!([issue]));
        for path in ["/reviewDispositions/candidateSha256","/reviewDispositions/sourceContentSha256",
            "/reviewDispositions/acknowledgements/0/issueSha256","/reviewDispositions/acknowledgements/0/message",
            "/reviewDispositions/acknowledgements/0/method","/sourceCandidate/teachingSolution"] {
            let mut changed=analysis.clone();*changed.pointer_mut(path).unwrap()=json!("forged");
            assert!(blocking_issue_count(&changed,&raw).is_err(),"{path}");
        }
        analysis["reviewDispositions"]["acknowledgements"]=json!([]);
        assert_eq!(blocking_issue_count(&analysis,&raw).unwrap(),1);
    }
    fn fixture() -> (tempfile::TempDir, LocalQuestionBank, Value) {
        let dir = tempfile::tempdir().unwrap();
        let mut seed = crate::bank::tests::seed();
        let mut second = seed["questions"][0].clone();
        second["questionId"] = json!("simulated-second");
        seed["questions"].as_array_mut().unwrap().push(second);
        let annotations = seed["questions"].as_array().unwrap().iter().map(|q| json!({
            "questionId":q["questionId"],"contentVersion":q["contentVersion"],"teacherVersion":q["teacherVersion"],
            "primaryKnowledgeUids":["simulated-leaf"],"solutionPaths":[{"id":"simulated-original-path","basis":"模拟原解法依据"}],
            "difficultyLevel":"medium","difficultyBasis":"模拟原难度依据，需保持审计。",
            "difficultyRubricVersion":RUBRIC_VERSION,"teacherProvenance":{"reviewStatus":"source_comparison"},
        })).collect::<Vec<_>>();
        seed["config"]["assemblyIndex"] = json!({"entries":annotations});
        let bank = LocalQuestionBank::open(&dir.path().join("bank.sqlite"), &seed).unwrap();
        (dir, bank, seed)
    }
    fn manifest(bank: &LocalQuestionBank) -> Value {
        let config = bank.config().unwrap();
        let entries = bank.questions().unwrap().iter().map(|q| {
            let annotation = config["assemblyIndex"]["entries"].as_array().unwrap()
                .iter().find(|a| a["questionId"] == q["questionId"]).unwrap();
            json!({"questionId":q["questionId"],"contentVersion":q["contentVersion"],"teacherVersion":q["teacherVersion"],
                "expectedQuestionSha256":hash_json(q),"expectedAnnotationSha256":hash_json(annotation),
                "result":{"answer":"模拟答案2","difficultyAssessment":{"level":"easy_medium","basis":"模拟回归：多一层条件检查，说明内容难度。","rubricVersion":RUBRIC_VERSION},"teachingSolution":"模拟教学解析：1+1=2。","issues":[]},
                "model":"simulated-model","promptSha256":"a".repeat(64),"requestSha256":"b".repeat(64),"generatedAt":"2026-10-21T12:00:00Z"})
        }).collect::<Vec<_>>();
        json!({"operationId":"simulated-teaching-operation","scope":"模拟用户显式授权教学整理","entries":entries})
    }
    fn mark_manifest(bank: &LocalQuestionBank) -> Value {
        let mut input = manifest(bank);
        input["operationId"] = json!("simulated-mark-only-operation");
        for entry in input["entries"].as_array_mut().unwrap() {
            for key in [
                "result",
                "model",
                "promptSha256",
                "requestSha256",
                "generatedAt",
            ] {
                entry.as_object_mut().unwrap().remove(key);
            }
            entry["markOnly"] = json!(true);
            entry["maintenanceIssues"] = json!(["模拟复核输出格式失败，旧教学稿需核对。"]);
            entry["markedAt"] = json!("2026-10-23T13:00:00Z");
        }
        input
    }
    fn focus() -> Value {
        json!({
            "knowledgePoints":["模拟知识：整数加法"],
            "examFocus":"模拟考点：按加法意义求两个单位量的和。",
            "studentRequirements":["模拟要求：写出加法运算。", "模拟要求：给出正确的运算结果。"],
        })
    }
    fn write_config(bank: &LocalQuestionBank, config: &Value) {
        bank.annotation_connection()
            .execute(
                "UPDATE bank_metadata SET value=?1 WHERE key='config'",
                [config.to_string()],
            )
            .unwrap();
    }
    fn formal_knowledge(bank: &LocalQuestionBank) {
        let mut config = bank.config().unwrap();
        config["knowledgeCatalogue"] =
            json!({"points":[{"uid":"simulated-leaf","name":"模拟整数加法","isLeaf":true}]});
        for annotation in config["assemblyIndex"]["entries"].as_array_mut().unwrap() {
            annotation["solutionPaths"][0]["requiredKnowledgeUids"] = json!(["simulated-leaf"]);
            annotation["solutionPaths"][0]["requiredPremises"] = json!([]);
        }
        write_config(bank, &config);
    }
    fn legacy_focus_batch(bank: &LocalQuestionBank) {
        let mut input = manifest(bank);
        for entry in input["entries"].as_array_mut().unwrap() {
            entry["result"]["teachingFocus"] = focus();
        }
        apply(bank, &input).unwrap();
    }
    fn pending_import_marker() -> Value {
        json!({"status":"needs_review","sourceContentSha256":"c".repeat(64),"generationCalls":1,"reviewCalls":1,
            "findings":[{"type":"term","term":"下界","fieldPath":"teachingSolution","excerpt":"模拟未采用稿","candidate":{"answer":"不得投影"}}],
            "rawCandidate":{"answer":"不得投影"},"requestRelativePath":"不得投影"})
    }
    #[test]
    fn import_pending_marker_is_projected_without_draft_or_source_mutation() {
        let (_dir, bank, _) = fixture();
        let original = bank.questions().unwrap()[0].clone();
        let mut config = bank.config().unwrap();
        config["assemblyIndex"]["entries"][0]["importTeachingReview"] = pending_import_marker();
        let projected = project(&original, &config).unwrap();
        assert_eq!(projected["importTeachingReview"], json!({"status":"needs_review","sourceContentSha256":"c".repeat(64),"generationCalls":1,"reviewCalls":1,
            "findings":[{"type":"term","term":"下界","fieldPath":"teachingSolution"}]}));
        assert!(projected.get("teachingAnalysis").is_none());
        let mut unchanged = projected;
        unchanged.as_object_mut().unwrap().remove("importTeachingReview");
        assert_eq!(unchanged, original);
        assert_eq!(bank.questions().unwrap()[0], original);
    }
    #[test]
    fn import_pending_marker_rejects_stale_versions_and_ignores_raw_markers() {
        let (_dir, bank, _) = fixture();
        let mut raw = bank.questions().unwrap()[0].clone();
        let mut config = bank.config().unwrap();
        raw["importTeachingReview"] = pending_import_marker();
        assert!(project(&raw, &config).unwrap().get("importTeachingReview").is_none());
        config["assemblyIndex"]["entries"][0]["importTeachingReview"] = pending_import_marker();
        for key in ["contentVersion", "teacherVersion"] {
            let mut stale = config.clone();
            stale["assemblyIndex"]["entries"][0][key] = json!("simulated-stale-version");
            assert!(project(&raw, &stale).is_err());
        }
        config["assemblyIndex"]["entries"][0]["importTeachingReview"]["reviewCalls"] = json!(2);
        assert!(project(&raw, &config).is_err());
    }
    #[test]
    fn valid_teaching_analysis_supersedes_old_import_pending_marker() {
        let (_dir, bank, _) = fixture();
        let original = bank.questions().unwrap()[0].clone();
        apply(&bank, &manifest(&bank)).unwrap();
        let mut config = bank.config().unwrap();
        config["assemblyIndex"]["entries"][0]["importTeachingReview"] = pending_import_marker();
        let projected = project(&original, &config).unwrap();
        assert_eq!(projected["teachingAnalysis"]["status"], "ready");
        assert!(projected.get("importTeachingReview").is_none());
        config["assemblyIndex"]["entries"][0]["teachingAnalysis"]["solution"] = json!("模拟破损教学稿");
        assert!(project(&original, &config).is_err());
    }
    #[test]
    fn focus_v2_apply_uses_formal_knowledge_and_keeps_original_generation_audit() {
        for modern_input in [false, true] {
            let (_dir, bank, _) = fixture();
            formal_knowledge(&bank);
            let originals = bank.questions().unwrap();
            let mut input = manifest(&bank);
            for entry in input["entries"].as_array_mut().unwrap() {
                entry["result"]["teachingFocus"] = focus();
                if modern_input {
                    entry["result"]["teachingFocus"]
                        .as_object_mut()
                        .unwrap()
                        .remove("knowledgePoints");
                    entry["result"]["teachingFocusSchemaVersion"] = json!(2);
                }
            }
            apply(&bank, &input).unwrap();
            let config = bank.config().unwrap();
            let snapshot = project(&originals[0], &config).unwrap();
            let analysis = &snapshot["teachingAnalysis"];
            assert_eq!(analysis["teachingFocusSchemaVersion"], 2);
            assert_eq!(analysis["teachingFocus"].as_object().unwrap().len(), 2);
            assert!(analysis["teachingFocus"].get("knowledgePoints").is_none());
            assert!(verify_projection(&snapshot).is_ok());
            // A recomputed hash cannot authorize a different schema or bring
            // the redundant generated knowledge array back into v2.
            for malformed_focus in [false, true] {
                let mut malformed = snapshot.clone();
                if malformed_focus {
                    malformed["teachingAnalysis"]["teachingFocus"]["knowledgePoints"] =
                        json!(["模拟不应恢复的重复知识"]);
                } else {
                    malformed["teachingAnalysis"]["teachingFocusSchemaVersion"] = json!(3);
                }
                sign_analysis(&mut malformed["teachingAnalysis"]);
                assert!(verify_projection(&malformed).is_err());
            }
            assert_eq!(bank.questions().unwrap(), originals);
            let audit: String = bank
                .annotation_connection()
                .query_row("SELECT payload FROM bank_teaching_operations", [], |r| {
                    r.get(0)
                })
                .unwrap();
            let audit: Value = serde_json::from_str(&audit).unwrap();
            assert_eq!(audit["items"][0]["generation"], input["entries"][0]);
            assert_eq!(apply(&bank, &input).unwrap()["replayed"], true);
        }
    }
    #[test]
    fn modern_focus_needs_real_formal_mappings_and_rejects_unknown_versions() {
        for version in [json!(2), json!(3), Value::Null, json!("2")] {
            let (_dir, bank, _) = fixture();
            let before = bank.config().unwrap();
            let mut input = manifest(&bank);
            input["entries"][0]["result"]["teachingFocus"] = focus();
            input["entries"][0]["result"]["teachingFocus"]
                .as_object_mut()
                .unwrap()
                .remove("knowledgePoints");
            input["entries"][0]["result"]["teachingFocusSchemaVersion"] = version;
            assert!(apply(&bank, &input).is_err());
            assert_eq!(bank.config().unwrap(), before);
        }
    }
    #[test]
    fn focus_migration_is_audited_idempotent_and_preserves_frozen_legacy_and_originals() {
        let (_dir, bank, _) = fixture();
        legacy_focus_batch(&bank);
        let originals = bank.questions().unwrap();
        let legacy = project(&originals[0], &bank.config().unwrap()).unwrap();
        let old_analysis = legacy["teachingAnalysis"].clone();
        // Missing trustworthy mappings retain the only knowledge description.
        assert_eq!(
            normalize_focus(&bank).unwrap()["skippedWithoutFormalKnowledge"],
            2
        );
        assert_eq!(
            project(&originals[0], &bank.config().unwrap()).unwrap(),
            legacy
        );
        formal_knowledge(&bank);
        let before = bank.config().unwrap();
        let receipt = normalize_focus(&bank).unwrap();
        assert_eq!(receipt["applied"], 2);
        let next = bank.config().unwrap();
        assert_eq!(bank.questions().unwrap(), originals);
        assert!(verify_projection(&legacy).is_ok());
        assert_eq!(legacy["teachingAnalysis"], old_analysis);
        let current = project(&originals[0], &next).unwrap();
        assert!(verify_projection(&current).is_ok());
        assert_eq!(current["teachingAnalysis"]["teachingFocusSchemaVersion"], 2);
        assert_ne!(
            current["teachingAnalysis"]["sha256"],
            old_analysis["sha256"]
        );
        assert!(
            current["teachingAnalysis"]["teachingFocus"]
                .get("knowledgePoints")
                .is_none()
        );
        let audit: String = bank
            .annotation_connection()
            .query_row(
                "SELECT payload FROM bank_teaching_focus_migrations",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let audit: Value = serde_json::from_str(&audit).unwrap();
        assert_eq!(
            audit["items"][0]["previousAnnotation"],
            before["assemblyIndex"]["entries"][0]
        );
        assert_eq!(
            audit["items"][0]["annotation"],
            next["assemblyIndex"]["entries"][0]
        );
        assert_eq!(normalize_focus(&bank).unwrap()["applied"], 0);
        assert_eq!(bank.config().unwrap(), next);
        assert_eq!(normalize_focus(&bank).unwrap()["total"], 2);
        // A later original-format manifest is immediately canonicalized.
        let mut input = manifest(&bank);
        input["operationId"] = json!("simulated-after-migration");
        input["entries"][0]["result"]["teachingFocus"] = focus();
        apply(&bank, &input).unwrap();
        assert_eq!(
            project(&originals[0], &bank.config().unwrap()).unwrap()["teachingAnalysis"]["teachingFocusSchemaVersion"],
            2
        );
    }
    #[test]
    fn migration_rolls_back_on_late_tampering_and_does_not_accept_corrupt_audit() {
        let (_dir, bank, _) = fixture();
        legacy_focus_batch(&bank);
        formal_knowledge(&bank);
        let mut config = bank.config().unwrap();
        config["assemblyIndex"]["entries"][1]["teachingAnalysis"]["solution"] = json!("模拟篡改");
        write_config(&bank, &config);
        assert!(normalize_focus(&bank).is_err());
        assert_eq!(bank.config().unwrap(), config);
        let exists: bool = bank.annotation_connection().query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='bank_teaching_focus_migrations')", [], |r| r.get(0)).unwrap();
        assert!(!exists);

        let (_dir, bank, _) = fixture();
        legacy_focus_batch(&bank);
        formal_knowledge(&bank);
        normalize_focus(&bank).unwrap();
        let config = bank.config().unwrap();
        bank.annotation_connection()
            .execute(
                "UPDATE bank_teaching_focus_migrations SET sha256=?1",
                ["0".repeat(64)],
            )
            .unwrap();
        assert!(normalize_focus(&bank).is_err());
        assert_eq!(bank.config().unwrap(), config);
    }
    #[test]
    fn apply_preserves_original_teacher_verification_and_knowledge_and_archives_previous_values() {
        let (_dir, bank, _) = fixture();
        let before = bank.questions().unwrap();
        let old_config = bank.config().unwrap();
        let input = manifest(&bank);
        assert_eq!(apply(&bank, &input).unwrap()["applied"], 2);
        assert_eq!(bank.questions().unwrap(), before);
        let config = bank.config().unwrap();
        for q in &before {
            let projected = project(q, &config).unwrap();
            assert_eq!(projected["teacher"], q["teacher"]);
            assert_eq!(projected["verification"], q["verification"]);
            assert_eq!(projected["teachingAnalysis"]["provenance"], "llm_generated");
            assert_eq!(projected["teachingAnalysis"]["status"], "ready");
            assert!(projected["teachingAnalysis"].get("answer").is_none());
        }
        for (old, next) in old_config["assemblyIndex"]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .zip(config["assemblyIndex"]["entries"].as_array().unwrap())
        {
            for key in ["primaryKnowledgeUids", "solutionPaths", "teacherProvenance"] {
                assert_eq!(old[key], next[key]);
            }
        }
        let stored: String = bank
            .annotation_connection()
            .query_row("SELECT payload FROM bank_teaching_operations", [], |r| {
                r.get(0)
            })
            .unwrap();
        let stored: Value = serde_json::from_str(&stored).unwrap();
        assert_eq!(
            stored["items"][0]["previousAnnotation"],
            old_config["assemblyIndex"]["entries"][0]
        );
        assert_eq!(stored["manifest"], input);
    }
    #[test]
    fn late_version_or_hash_conflict_rolls_back_every_entry_and_audit() {
        for field in [
            "contentVersion",
            "teacherVersion",
            "expectedQuestionSha256",
            "expectedAnnotationSha256",
        ] {
            let (_dir, bank, _) = fixture();
            let old_config = bank.config().unwrap();
            let mut input = manifest(&bank);
            input["entries"][1][field] = json!(if field.contains("Sha256") {
                "c".repeat(64)
            } else {
                "simulated-stale".into()
            });
            assert!(apply(&bank, &input).is_err());
            assert_eq!(bank.config().unwrap(), old_config);
            let exists: bool = bank.annotation_connection().query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='bank_teaching_operations')", [], |r| r.get(0)).unwrap();
            assert!(!exists);
        }
    }
    #[test]
    fn replay_is_idempotent_and_operation_identity_cannot_be_reused() {
        let (_dir, bank, _) = fixture();
        let input = manifest(&bank);
        apply(&bank, &input).unwrap();
        let config = bank.config().unwrap();
        let replay = apply(&bank, &input).unwrap();
        assert_eq!(replay["replayed"], true);
        assert_eq!(replay["applied"], 0);
        assert_eq!(bank.config().unwrap(), config);
        let mut different = input.clone();
        different["entries"][0]["result"]["teachingSolution"] = json!("模拟不同解析");
        assert!(apply(&bank, &different).is_err());
        assert_eq!(bank.config().unwrap(), config);
    }
    #[test]
    fn projection_rejects_tampering_wrong_base_and_stale_annotation_without_trusting_raw_overlay() {
        let (_dir, bank, _) = fixture();
        apply(&bank, &manifest(&bank)).unwrap();
        let raw = bank.questions().unwrap()[0].clone();
        let config = bank.config().unwrap();
        for key in [
            "solution",
            "baseTeacherVersion",
            "sha256",
            "teachingVersion",
        ] {
            let mut bad = config.clone();
            bad["assemblyIndex"]["entries"][0]["teachingAnalysis"][key] =
                json!("simulated-tampered");
            assert!(project(&raw, &bad).is_err());
        }
        let mut stale = config.clone();
        stale["assemblyIndex"]["entries"][0]["teacherVersion"] = json!("simulated-stale");
        assert!(project(&raw, &stale).is_err());
        let mut forged = raw.clone();
        forged["teachingAnalysis"] = json!({"solution":"模拟伪造"});
        assert!(
            project(&forged, &json!({}))
                .unwrap()
                .get("teachingAnalysis")
                .is_none()
        );
    }
    #[test]
    fn required_generation_fields_are_checked_and_issues_stay_unreviewed() {
        for field in ["model", "promptSha256", "requestSha256", "generatedAt"] {
            let (_dir, bank, _) = fixture();
            let mut input = manifest(&bank);
            input["entries"][0].as_object_mut().unwrap().remove(field);
            assert!(apply(&bank, &input).is_err());
        }
        for field in [
            "answer",
            "difficultyAssessment",
            "teachingSolution",
            "issues",
        ] {
            let (_dir, bank, _) = fixture();
            let mut input = manifest(&bank);
            input["entries"][0]["result"]
                .as_object_mut()
                .unwrap()
                .remove(field);
            assert!(apply(&bank, &input).is_err());
        }
        let (_dir, bank, _) = fixture();
        let mut input = manifest(&bank);
        input["entries"][0]["result"]["issues"] = json!(["模拟需核对：原参考答案有疑点。"]);
        apply(&bank, &input).unwrap();
        let q = bank.questions().unwrap()[0].clone();
        assert_eq!(
            project(&q, &bank.config().unwrap()).unwrap()["teachingAnalysis"]["status"],
            "needs_review"
        );
    }

    #[test]
    fn embedded_snapshot_verification_rejects_wrong_question_and_modified_solution_or_hash() {
        let (_dir, bank, _) = fixture();
        let raw = bank.questions().unwrap()[0].clone();
        assert!(verify_projection(&raw).is_ok());
        apply(&bank, &manifest(&bank)).unwrap();
        let snapshot = project(&raw, &bank.config().unwrap()).unwrap();
        assert!(verify_projection(&snapshot).is_ok());
        let mut wrong_question = snapshot.clone();
        wrong_question["questionId"] = json!("simulated-other-question");
        assert!(verify_projection(&wrong_question).is_err());
        for key in ["solution", "sha256"] {
            let mut tampered = snapshot.clone();
            tampered["teachingAnalysis"][key] = json!("simulated-tampered");
            assert!(verify_projection(&tampered).is_err());
        }
        // A later bank generation cannot invalidate or silently replace a
        // self-consistent snapshot; validation requires no live bank lookup.
        let mut next = manifest(&bank);
        next["operationId"] = json!("simulated-next-generation");
        for entry in next["entries"].as_array_mut().unwrap() {
            entry["result"]["teachingSolution"] = json!("模拟新一代教学解析：仍不刷新已有快照。");
        }
        apply(&bank, &next).unwrap();
        assert!(verify_projection(&snapshot).is_ok());
        assert_eq!(
            snapshot["teachingAnalysis"]["solution"],
            "模拟教学解析：1+1=2。"
        );
    }

    #[test]
    fn teaching_focus_persists_projects_and_preserves_legacy_snapshots_and_original_mappings() {
        let (_dir, bank, _) = fixture();
        let original_questions = bank.questions().unwrap();
        apply(&bank, &manifest(&bank)).unwrap();
        let old_config = bank.config().unwrap();
        let legacy_snapshot = project(&original_questions[0], &old_config).unwrap();
        assert!(
            legacy_snapshot["teachingAnalysis"]
                .get("teachingFocus")
                .is_none()
        );

        let mut input = manifest(&bank);
        input["operationId"] = json!("simulated-focus-generation");
        for entry in input["entries"].as_array_mut().unwrap() {
            entry["result"]["teachingFocus"] = focus();
        }
        assert_eq!(apply(&bank, &input).unwrap()["applied"], 2);
        let config = bank.config().unwrap();
        assert_eq!(bank.questions().unwrap(), original_questions);
        for (index, question) in original_questions.iter().enumerate() {
            let current = project(question, &config).unwrap();
            assert_eq!(current["teachingAnalysis"]["teachingFocus"], focus());
            assert!(verify_projection(&current).is_ok());
            for key in ["primaryKnowledgeUids", "solutionPaths", "teacherProvenance"] {
                assert_eq!(
                    config["assemblyIndex"]["entries"][index][key],
                    old_config["assemblyIndex"]["entries"][index][key],
                );
            }
        }
        assert!(verify_projection(&legacy_snapshot).is_ok());
        assert!(
            legacy_snapshot["teachingAnalysis"]
                .get("teachingFocus")
                .is_none()
        );
        let audit: String = bank
            .annotation_connection()
            .query_row(
                "SELECT payload FROM bank_teaching_operations WHERE operation_id=?1",
                ["simulated-focus-generation"],
                |row| row.get(0),
            )
            .unwrap();
        let audit: Value = serde_json::from_str(&audit).unwrap();
        assert_eq!(
            audit["items"][0]["annotation"]["teachingAnalysis"]["teachingFocus"],
            focus()
        );
        assert_eq!(
            audit["items"][0]["previousAnnotation"],
            old_config["assemblyIndex"]["entries"][0]
        );
        assert_eq!(apply(&bank, &input).unwrap()["replayed"], true);
    }

    #[test]
    fn teaching_focus_changes_are_covered_by_snapshot_hash_and_shape_validation() {
        let (_dir, bank, _) = fixture();
        let mut input = manifest(&bank);
        input["entries"][0]["result"]["teachingFocus"] = focus();
        apply(&bank, &input).unwrap();
        let raw = bank.questions().unwrap()[0].clone();
        let config = bank.config().unwrap();
        let snapshot = project(&raw, &config).unwrap();
        for key in ["knowledgePoints", "examFocus", "studentRequirements"] {
            let mut changed = snapshot.clone();
            changed["teachingAnalysis"]["teachingFocus"][key] = match key {
                "examFocus" => json!("模拟篡改考点"),
                _ => json!(["模拟篡改条目"]),
            };
            assert!(verify_projection(&changed).is_err());
        }
        let mut removed = snapshot.clone();
        removed["teachingAnalysis"]
            .as_object_mut()
            .unwrap()
            .remove("teachingFocus");
        assert!(verify_projection(&removed).is_err());
        // Even a recomputed snapshot hash cannot make an invalid metadata
        // shape acceptable to the current or frozen-question validators.
        let mut malformed = snapshot.clone();
        malformed["teachingAnalysis"]["teachingFocus"]["studentRequirements"] = json!([]);
        let updated_sha = hash_json(&analysis_content(&malformed["teachingAnalysis"]));
        malformed["teachingAnalysis"]["sha256"] = json!(updated_sha);
        malformed["teachingAnalysis"]["teachingVersion"] =
            json!(format!("teaching-{}", &updated_sha[..16]));
        assert!(verify_projection(&malformed).is_err());
        let mut malformed_config = config.clone();
        malformed_config["assemblyIndex"]["entries"][0]["teachingAnalysis"] =
            malformed["teachingAnalysis"].clone();
        assert!(project(&raw, &malformed_config).is_err());
    }

    #[test]
    fn invalid_teaching_focus_late_in_a_batch_rolls_back_all_changes_and_audit() {
        let valid = focus();
        let mut invalid_cases = vec![Value::Null, json!("模拟错误对象类型"), json!({})];
        for (key, values) in [
            (
                "knowledgePoints",
                vec![
                    json!([]),
                    json!("模拟错误数组类型"),
                    json!([""]),
                    json!(["  "]),
                    json!([42]),
                    json!(["点".repeat(121)]),
                    json!(vec!["模拟知识"; 13]),
                ],
            ),
            (
                "examFocus",
                vec![
                    Value::Null,
                    json!(""),
                    json!("  "),
                    json!([]),
                    json!("点".repeat(601)),
                ],
            ),
            (
                "studentRequirements",
                vec![
                    json!([]),
                    json!("模拟错误数组类型"),
                    json!(["", "模拟要求"]),
                    json!(["  "]),
                    json!([false]),
                    json!(["项".repeat(401)]),
                    json!(vec!["模拟要求"; 4]),
                ],
            ),
        ] {
            let mut missing = valid.clone();
            missing.as_object_mut().unwrap().remove(key);
            invalid_cases.push(missing);
            for value in values {
                let mut malformed = valid.clone();
                malformed[key] = value;
                invalid_cases.push(malformed);
            }
        }
        let mut extra = valid.clone();
        extra["mastery"] = json!("模拟不允许的额外字段");
        invalid_cases.push(extra);
        for malformed in invalid_cases {
            let (_dir, bank, _) = fixture();
            let before_config = bank.config().unwrap();
            let before_questions = bank.questions().unwrap();
            let mut input = manifest(&bank);
            input["entries"][0]["result"]["teachingFocus"] = valid.clone();
            input["entries"][1]["result"]["teachingFocus"] = malformed;
            assert!(apply(&bank, &input).is_err());
            assert_eq!(bank.config().unwrap(), before_config);
            assert_eq!(bank.questions().unwrap(), before_questions);
            let exists: bool = bank.annotation_connection().query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='bank_teaching_operations')",
                [], |row| row.get(0),
            ).unwrap();
            assert!(!exists);
        }
    }

    #[test]
    fn teaching_focus_accepts_one_observable_requirement_without_relaxing_complete_answer_gate() {
        let (_dir, bank, _) = fixture();
        let mut input = manifest(&bank);
        let mut single_requirement = focus();
        single_requirement["studentRequirements"] = json!(["模拟要求：给出正确的加法结果。"]);
        input["entries"][0]["result"]["teachingFocus"] = single_requirement.clone();
        let mut incomplete = input.clone();
        incomplete["entries"][1]["result"]["answer"] = json!("");
        incomplete["entries"][1]["result"]["issues"] = json!(["解答：模拟部分未完成。"]);
        assert!(apply(&bank, &incomplete).is_err());
        assert_eq!(apply(&bank, &input).unwrap()["applied"], 2);
        let raw = bank.questions().unwrap()[0].clone();
        assert_eq!(
            project(&raw, &bank.config().unwrap()).unwrap()["teachingAnalysis"]["teachingFocus"],
            single_requirement
        );
    }

    #[test]
    fn mark_only_preserves_generation_provenance_difficulty_and_frozen_snapshots_with_full_audit() {
        let (_dir, bank, _) = fixture();
        legacy_focus_batch(&bank);
        let originals = bank.questions().unwrap();
        let before = bank.config().unwrap();
        let frozen = project(&originals[0], &before).unwrap();
        let input = mark_manifest(&bank);
        assert_eq!(apply(&bank, &input).unwrap()["applied"], 2);
        let after = bank.config().unwrap();
        assert_eq!(bank.questions().unwrap(), originals);
        for (old, next) in before["assemblyIndex"]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .zip(after["assemblyIndex"]["entries"].as_array().unwrap())
        {
            let old_analysis = &old["teachingAnalysis"];
            let next_analysis = &next["teachingAnalysis"];
            let mut unchanged = next.clone();
            unchanged["teachingAnalysis"] = old_analysis.clone();
            assert_eq!(
                &unchanged, old,
                "only independently signed teaching analysis can change"
            );
            let mut provenance = next_analysis.clone();
            for key in [
                "issues",
                "status",
                "sha256",
                "teachingVersion",
                "maintenanceFlags",
            ] {
                match old_analysis.get(key) {
                    Some(value) => {
                        provenance[key] = value.clone();
                    }
                    None => {
                        provenance.as_object_mut().unwrap().remove(key);
                    }
                }
            }
            assert_eq!(
                &provenance, old_analysis,
                "a failed review must not replace original model evidence"
            );
            assert_eq!(next_analysis["status"], "needs_review");
            assert_eq!(
                next_analysis["maintenanceFlags"][0]["operationId"],
                input["operationId"]
            );
            assert_ne!(
                next_analysis["teachingVersion"],
                old_analysis["teachingVersion"]
            );
            let raw = originals
                .iter()
                .find(|q| q["questionId"] == next["questionId"])
                .unwrap();
            assert!(verify_projection(&project(raw, &after).unwrap()).is_ok());
        }
        assert!(verify_projection(&frozen).is_ok());
        assert_eq!(
            frozen["teachingAnalysis"],
            before["assemblyIndex"]["entries"][0]["teachingAnalysis"]
        );
        let stored: String = bank
            .annotation_connection()
            .query_row(
                "SELECT payload FROM bank_teaching_operations WHERE operation_id=?1",
                ["simulated-mark-only-operation"],
                |r| r.get(0),
            )
            .unwrap();
        let stored: Value = serde_json::from_str(&stored).unwrap();
        assert_eq!(stored["schemaVersion"], 1);
        assert_eq!(
            stored["items"][0]["previousAnnotation"],
            before["assemblyIndex"]["entries"][0]
        );
        assert_eq!(
            stored["items"][0]["annotation"],
            after["assemblyIndex"]["entries"][0]
        );
        assert_eq!(stored["items"][0]["maintenance"], input["entries"][0]);
        assert!(stored["items"][0].get("generation").is_none());
        let replay = apply(&bank, &input).unwrap();
        assert_eq!(replay["applied"], 0);
        assert_eq!(replay["replayed"], true);
        assert_eq!(bank.config().unwrap(), after);
        let mut collision = input.clone();
        collision["entries"][0]["maintenanceIssues"] = json!(["模拟不同操作内容"]);
        assert!(apply(&bank, &collision).is_err());
        assert_eq!(bank.config().unwrap(), after);
    }

    #[test]
    fn mark_only_deduplicates_issues_and_retains_each_explicit_operation_history() {
        let (_dir, bank, _) = fixture();
        apply(&bank, &manifest(&bank)).unwrap();
        let mut first = mark_manifest(&bank);
        first["entries"][0]["maintenanceIssues"] = json!(["模拟同一疑点", "模拟同一疑点"]);
        apply(&bank, &first).unwrap();
        let mut second = mark_manifest(&bank);
        second["operationId"] = json!("simulated-next-mark");
        second["entries"][0]["maintenanceIssues"] = json!(["模拟同一疑点", "模拟新增疑点"]);
        apply(&bank, &second).unwrap();
        let config = bank.config().unwrap();
        let analysis = &config["assemblyIndex"]["entries"][0]["teachingAnalysis"];
        assert_eq!(analysis["issues"], json!(["模拟同一疑点", "模拟新增疑点"]));
        assert_eq!(analysis["maintenanceFlags"].as_array().unwrap().len(), 2);
        assert_eq!(
            analysis["maintenanceFlags"][0]["issues"],
            json!(["模拟同一疑点"])
        );
        assert_eq!(analysis["operationId"], "simulated-teaching-operation");
    }

    #[test]
    fn mark_only_missing_or_corrupt_existing_analysis_rolls_back_earlier_entries_and_audit() {
        for corrupt in [false, true] {
            let (_dir, bank, _) = fixture();
            let mut generated = manifest(&bank);
            if !corrupt {
                generated["entries"].as_array_mut().unwrap().truncate(1);
            }
            apply(&bank, &generated).unwrap();
            if corrupt {
                let mut config = bank.config().unwrap();
                config["assemblyIndex"]["entries"][1]["teachingAnalysis"]["solution"] =
                    json!("模拟未签名篡改");
                write_config(&bank, &config);
            }
            let before = bank.config().unwrap();
            let input = mark_manifest(&bank);
            assert!(apply(&bank, &input).is_err());
            assert_eq!(bank.config().unwrap(), before);
            let count: i64 = bank
                .annotation_connection()
                .query_row("SELECT COUNT(*) FROM bank_teaching_operations", [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(count, 1);
        }
    }

    #[test]
    fn mark_only_rejects_stale_bindings_invalid_marks_and_new_generation_claims_atomically() {
        let cases = [
            ("markOnly", json!("true")),
            ("maintenanceIssues", json!([])),
            ("maintenanceIssues", json!([""])),
            ("maintenanceIssues", json!([false])),
            ("maintenanceIssues", json!(["模拟\u{0008}疑点"])),
            ("markedAt", json!("invalid-time")),
            ("markedAt", Value::Null),
            ("contentVersion", json!("stale")),
            ("teacherVersion", json!("stale")),
            ("expectedQuestionSha256", json!("c".repeat(64))),
            ("expectedAnnotationSha256", json!("d".repeat(64))),
            ("model", json!("new-failed-model")),
            ("promptSha256", json!("f".repeat(64))),
            ("requestSha256", json!("f".repeat(64))),
            ("generatedAt", json!("2026-10-23T13:00:00Z")),
            ("result", json!({"teachingSolution":"伪造失败复核的新稿"})),
        ];
        for (field, value) in cases {
            let (_dir, bank, _) = fixture();
            apply(&bank, &manifest(&bank)).unwrap();
            let before = bank.config().unwrap();
            let mut input = mark_manifest(&bank);
            input["entries"][1][field] = value;
            assert!(apply(&bank, &input).is_err(), "must reject {field}");
            assert_eq!(bank.config().unwrap(), before);
            let count: i64 = bank
                .annotation_connection()
                .query_row("SELECT COUNT(*) FROM bank_teaching_operations", [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(count, 1);
        }
    }
}
