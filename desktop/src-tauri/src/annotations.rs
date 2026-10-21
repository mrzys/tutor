//! Explicit, resumable annotation jobs. Only metadata indexes change; question
//! payloads and immutable personal papers are never written by this module.
use crate::{
    bank::{BankRepository, LocalQuestionBank, hash_json},
    error::{AppError, AppResult},
    knowledge,
    model::ModelClient,
    storage::Store,
};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::{collections::HashSet, sync::atomic::AtomicBool};

pub const RUBRIC_VERSION: &str = "content-demand-v1";
fn invalid(message: &str) -> AppError {
    AppError::new("invalid_annotation", message)
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
fn rows(v: &Value) -> impl Iterator<Item = &Value> {
    v.as_array().into_iter().flatten()
}
fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or_default()
}

/// Existing imports without the new field remain explicitly unassessed.
pub(crate) fn normalize_difficulty(q: &Value) -> AppResult<Value> {
    let Some(value) = q.get("difficultyAssessment") else {
        return Ok(json!({"level":null,"basis":"","rubricVersion":RUBRIC_VERSION}));
    };
    if !value.is_object() {
        return Err(invalid("难度评估需包含等级、依据及标准版本。"));
    }
    let level = value
        .get("level")
        .ok_or_else(|| invalid("难度评估缺少等级。"))?;
    if !level.is_null()
        && !level
            .as_str()
            .is_some_and(|s| crate::intake::DIFFICULTY_LEVELS.contains(&s))
    {
        return Err(invalid("难度等级无效。"));
    }
    let basis = value["basis"]
        .as_str()
        .ok_or_else(|| invalid("难度评估依据需为文本。"))?
        .trim();
    if basis.chars().count() > 4000
        || basis
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
        || (!level.is_null() && basis.chars().count() < 8)
    {
        return Err(invalid(
            "已评估难度需填写具体依据（至少 8 字）；无法判断时使用未评估。",
        ));
    }
    if value
        .get("rubricVersion")
        .is_some_and(|v| v != RUBRIC_VERSION)
    {
        return Err(invalid("难度评估标准版本不一致。"));
    }
    Ok(json!({"level":level,"basis":basis,"rubricVersion":RUBRIC_VERSION}))
}
pub(crate) fn apply_difficulty(annotation: &mut Value, q: &Value) {
    annotation["difficultyLevel"] = q["difficultyAssessment"]["level"].clone();
    annotation["difficultyBasis"] = q["difficultyAssessment"]["basis"].clone();
    annotation["difficultyRubricVersion"] = json!(RUBRIC_VERSION);
    if let Some(object) = annotation.as_object_mut() {
        object.remove("difficultyEstimate");
    }
}
fn schema(bank: &LocalQuestionBank) -> AppResult<()> {
    bank.annotation_connection().execute_batch("CREATE TABLE IF NOT EXISTS bank_annotation_jobs(id TEXT PRIMARY KEY, operation_id TEXT UNIQUE NOT NULL, request_sha256 TEXT NOT NULL, payload TEXT NOT NULL, sha256 TEXT NOT NULL);")?;
    Ok(())
}
fn save(bank: &LocalQuestionBank, job: &Value, expected: &mut String) -> AppResult<()> {
    let hash = hash_json(job);
    let changed = bank.annotation_connection().execute(
        "UPDATE bank_annotation_jobs SET payload=?1,sha256=?2 WHERE id=?3 AND sha256=?4",
        params![job.to_string(), hash, text(job, "jobId"), expected.as_str()],
    )?;
    if changed != 1 {
        return Err(AppError::new(
            "revision_conflict",
            "标注任务已被其他窗口更新，请刷新任务。",
        ));
    }
    *expected = hash;
    Ok(())
}
fn lease_active(item: &Value) -> bool {
    item["status"] == "running"
        && item["leaseExpiresAt"]
            .as_i64()
            .is_some_and(|t| t > chrono::Utc::now().timestamp())
}

fn load(bank: &LocalQuestionBank, id: &str) -> AppResult<Value> {
    let value: Option<(String, String)> = bank
        .annotation_connection()
        .query_row(
            "SELECT payload,sha256 FROM bank_annotation_jobs WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (payload, sha) = value.ok_or_else(|| AppError::new("not_found", "没有找到标注任务。"))?;
    let job: Value = serde_json::from_str(&payload)?;
    if hash_json(&job) != sha {
        return Err(AppError::new(
            "integrity_error",
            "标注任务记录校验失败，原标注保留。",
        ));
    }
    Ok(job)
}
fn summary(job: &mut Value) {
    let items = job["items"].as_array().unwrap();
    let completed = items.iter().filter(|i| i["status"] == "succeeded").count();
    let failed = items.iter().filter(|i| i["status"] == "failed").count();
    let pending = items
        .iter()
        .filter(|i| matches!(i["status"].as_str(), Some("pending" | "running")))
        .count();
    job["completed"] = json!(completed);
    job["failed"] = json!(failed);
    job["pending"] = json!(pending);
    if job["status"] != "cancelled" {
        job["status"] = json!(if pending > 0 {
            "running"
        } else if failed > 0 {
            "completed_with_errors"
        } else {
            "completed"
        });
    }
    job["updatedAt"] = json!(now());
}
fn identity(model: &ModelClient) -> Value {
    let settings = model.public_settings();
    json!({"activeProfileId":settings["activeProfileId"],"baseUrl":settings["baseUrl"],"model":settings["model"],"revision":settings["revision"]})
}
fn annotation(config: &Value, question_id: &str) -> AppResult<Value> {
    let entries = rows(&config["assemblyIndex"]["entries"])
        .filter(|e| e["questionId"] == question_id)
        .collect::<Vec<_>>();
    if entries.len() > 1 {
        return Err(invalid("题目有重复索引，请先修复原始索引。"));
    }
    Ok(entries.first().map(|v| (*v).clone()).unwrap_or(Value::Null))
}
fn selected(bank: &LocalQuestionBank, payload: &Value) -> AppResult<Vec<Value>> {
    let explicit = payload.get("questionIds");
    let textbook = payload.get("textbookId");
    if explicit.is_some() == textbook.is_some() {
        return Err(invalid("请选择题目 ID 列表或一本教材，不能同时选择。"));
    }
    let questions = bank.questions()?;
    if let Some(ids) = explicit {
        let ids = ids
            .as_array()
            .filter(|v| !v.is_empty() && v.len() <= 10000)
            .ok_or_else(|| invalid("题目列表不能为空且最多 10000 题。"))?;
        let mut seen = HashSet::new();
        let mut result = Vec::new();
        for id in ids {
            let id = id
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or_else(|| invalid("题目身份无效。"))?;
            if !seen.insert(id) {
                return Err(invalid("题目列表不能重复。"));
            }
            result.push(
                questions
                    .iter()
                    .find(|q| q["questionId"] == id)
                    .cloned()
                    .ok_or_else(|| AppError::new("not_found", "所选题目已不可选。"))?,
            );
        }
        return Ok(result);
    }
    let id = textbook
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| invalid("教材身份无效。"))?;
    let catalogue = bank.catalog()?;
    let book = rows(&catalogue["textbooks"])
        .find(|b| b["id"] == id)
        .ok_or_else(|| AppError::new("not_found", "没有找到该教材。"))?;
    let scope = rows(&book["chapters"])
        .flat_map(|c| rows(&c["sections"]))
        .filter_map(|s| s["id"].as_str())
        .map(crate::intake::canonical)
        .collect::<HashSet<_>>();
    let config = bank.config()?;
    Ok(questions
        .into_iter()
        .filter(|q| {
            annotation(&config, text(q, "questionId"))
                .ok()
                .is_some_and(|a| {
                    knowledge::primary_sections(&a, &config)
                        .iter()
                        .any(|s| scope.contains(&crate::intake::canonical(s)))
                })
        })
        .collect())
}
fn start(bank: &LocalQuestionBank, model: &ModelClient, payload: &Value) -> AppResult<Value> {
    if !model.configured() {
        return Err(AppError::new(
            "not_configured",
            "请先配置当前使用的模型，再开始重新标注。",
        ));
    }
    let mode = text(payload, "mode");
    if !matches!(mode, "difficulty_only" | "full") {
        return Err(invalid("请选择仅重评难度或完整重新标注。"));
    }
    let questions = selected(bank, payload)?;
    let ids = questions
        .iter()
        .map(|q| q["questionId"].clone())
        .collect::<Vec<_>>();
    let mut review_notes = serde_json::Map::new();
    if let Some(notes) = payload.get("reviewNotes") {
        let notes = notes
            .as_object()
            .ok_or_else(|| invalid("纠错审核意见需按本次题目 ID 保存为对象。"))?;
        let allowed = ids.iter().filter_map(Value::as_str).collect::<HashSet<_>>();
        for (id, note) in notes {
            if !allowed.contains(id.as_str()) {
                return Err(invalid("纠错意见只能关联本次任务内的题目。"));
            }
            let note = note
                .as_str()
                .filter(|note| {
                    note.chars().count() <= 4000
                        && !note
                            .chars()
                            .any(|c| c.is_control() && c != '\n' && c != '\t')
                })
                .ok_or_else(|| invalid("每题纠错意见须为不超过 4000 字的文本。"))?;
            review_notes.insert(id.clone(), json!(note));
        }
    }
    if payload["dryRun"] == true {
        return Ok(
            json!({"total":ids.len(),"questionIds":ids,"mode":mode,"textbookId":payload["textbookId"],"scopeDefinition":"当前可选题目中，当前主考小节投影属于该教材；未归属题目需显式选择 questionIds。"}),
        );
    }
    if questions.is_empty() {
        return Err(invalid("所选范围没有可重新标注的题目。"));
    }
    let operation = text(payload, "operationId");
    if operation.is_empty() || operation.len() > 200 || operation.chars().any(char::is_control) {
        return Err(invalid("标注任务缺少有效操作身份。"));
    }
    let mut request_identity = json!({"mode":mode,"questionIds":payload["questionIds"],"textbookId":payload["textbookId"]});
    // Preserve no-notes operation identities created by previous releases.
    if payload.get("reviewNotes").is_some() {
        request_identity["reviewNotes"] = json!(review_notes);
    }
    let request_hash = hash_json(&request_identity);
    let existing: Option<(String, String)> = bank
        .annotation_connection()
        .query_row(
            "SELECT id,request_sha256 FROM bank_annotation_jobs WHERE operation_id=?1",
            [operation],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((id, hash)) = existing {
        if hash != request_hash {
            return Err(AppError::new(
                "operation_conflict",
                "该操作身份已用于另一项任务。",
            ));
        }
        return Ok(json!({"job":load(bank,&id)?}));
    }
    let config = bank.config()?;
    let mut items = Vec::new();
    for q in questions {
        let old = annotation(&config, text(&q, "questionId"))?;
        items.push(json!({"questionId":q["questionId"],"status":"pending","attempts":0,"questionSha256":hash_json(&q),"contentVersion":q["contentVersion"],"teacherVersion":q["teacherVersion"],"previousAnnotation":old,"annotationSha256":hash_json(&old),"attemptHistory":[]}));
    }
    let mut job = json!({"jobId":format!("annotation-{}",uuid::Uuid::new_v4()),"mode":mode,"status":"running","textbookId":payload["textbookId"],"total":items.len(),"items":items,"modelIdentity":identity(model),"rubricVersion":RUBRIC_VERSION,"reviewNotes":review_notes,"createdAt":now()});
    summary(&mut job);
    bank.annotation_connection().execute("INSERT INTO bank_annotation_jobs(id,operation_id,request_sha256,payload,sha256) VALUES(?1,?2,?3,?4,?5)",params![text(&job,"jobId"),operation,request_hash,job.to_string(),hash_json(&job)])?;
    Ok(json!({"job":job}))
}
fn normalized_annotation(
    old: &Value,
    q: &Value,
    result: &Value,
    mode: &str,
    config: &Value,
) -> AppResult<Value> {
    if !result
        .get("difficultyAssessment")
        .is_some_and(Value::is_object)
    {
        return Err(invalid(
            "重新标注结果必须显式提供难度评估；无法判断时填写 level:null。",
        ));
    }
    let assessment = normalize_difficulty(result)?;
    let mut next = if old.is_object() {
        old.clone()
    } else {
        json!({"questionId":q["questionId"],"contentVersion":q["contentVersion"],"teacherVersion":q["teacherVersion"],"tasks":[],"duplicateGroup":q["questionId"]})
    };
    apply_difficulty(&mut next, &json!({"difficultyAssessment":assessment}));
    if mode == "full" {
        if result["knowledgeSchemaVersion"] != 2 {
            return Err(invalid("完整重标必须使用第 2 版知识点结构。"));
        }
        for key in [
            "knowledgeSchemaVersion",
            "primaryKnowledgeUids",
            "solutionPaths",
        ] {
            next[key] = result[key].clone();
        }
        knowledge::validate_annotation(&next, config)?;
        knowledge::validate_leaf_annotation(&next, config)?;
        let premises = rows(&config["premises"])
            .filter_map(|p| p["id"].as_str().or_else(|| p.as_str()))
            .collect::<HashSet<_>>();
        for path in rows(&next["solutionPaths"]) {
            if rows(&path["requiredPremises"])
                .filter_map(Value::as_str)
                .any(|p| !premises.contains(p))
            {
                return Err(invalid("解法前提必须使用现有目录身份。"));
            }
            // Incomplete path annotations remain unknown; no dependency is fabricated.
            if !text(path, "basis").trim().is_empty()
                && rows(&path["requiredKnowledgeUids"]).next().is_some()
                && rows(&next["primaryKnowledgeUids"])
                    .any(|uid| !rows(&path["requiredKnowledgeUids"]).any(|r| r == uid))
            {
                return Err(invalid("完整解法必须包含全部主考知识点。"));
            }
        }
        next["primarySections"] = json!(knowledge::primary_sections(&next, config));
        let paths = next["solutionPaths"].as_array_mut().unwrap();
        for path in paths {
            path["requiredSections"] = json!(knowledge::sections_for_uids(
                config,
                &path["requiredKnowledgeUids"]
            ));
        }
    }
    next["annotationSource"] = json!("model_reannotation");
    next["annotationUpdatedAt"] = json!(now());
    Ok(next)
}
/// Compare both immutable question content and the old annotation inside the
/// same immediate transaction as applying metadata and recording success.
fn commit(
    bank: &LocalQuestionBank,
    job: &mut Value,
    index: usize,
    q: &Value,
    next: &Value,
    expected: &mut String,
) -> AppResult<()> {
    let tx = rusqlite::Transaction::new_unchecked(
        bank.annotation_connection(),
        rusqlite::TransactionBehavior::Immediate,
    )?;
    let raw: String = tx.query_row(
        "SELECT payload FROM bank_questions WHERE id=?1",
        [text(q, "questionId")],
        |r| r.get(0),
    )?;
    let current: Value = serde_json::from_str(&raw)?;
    if hash_json(&current) != job["items"][index]["questionSha256"] {
        return Err(AppError::new(
            "revision_conflict",
            "题目版本已改变，原标注未修改；请为新版本重新创建任务。",
        ));
    }
    let raw: String = tx.query_row(
        "SELECT value FROM bank_metadata WHERE key='config'",
        [],
        |r| r.get(0),
    )?;
    let mut config: Value = serde_json::from_str(&raw)?;
    let old = annotation(&config, text(q, "questionId"))?;
    if hash_json(&old) != job["items"][index]["annotationSha256"] {
        return Err(AppError::new(
            "revision_conflict",
            "题目标注已被其他操作修改，本次结果未覆盖。",
        ));
    }
    if !config["assemblyIndex"].is_object() {
        config["assemblyIndex"] = json!({"entries":[]});
    }
    if !config["assemblyIndex"]["entries"].is_array() {
        config["assemblyIndex"]["entries"] = json!([]);
    }
    let entries = config["assemblyIndex"]["entries"].as_array_mut().unwrap();
    if let Some(row) = entries
        .iter_mut()
        .find(|r| r["questionId"] == q["questionId"])
    {
        *row = next.clone();
    } else {
        entries.push(next.clone());
    }
    let audit = json!({"at":now(),"status":"succeeded","rawResult":job["items"][index]["rawResult"],"modelIdentity":job["modelIdentity"],"rubricVersion":RUBRIC_VERSION,"reusedResult":job["items"][index]["reusedResult"]});
    job["items"][index]["attemptHistory"]
        .as_array_mut()
        .unwrap()
        .push(audit);
    job["items"][index]["status"] = json!("succeeded");
    job["items"][index]["annotation"] = next.clone();
    summary(job);
    tx.execute(
        "UPDATE bank_metadata SET value=?1 WHERE key='config'",
        [config.to_string()],
    )?;
    let hash = hash_json(job);
    if tx.execute(
        "UPDATE bank_annotation_jobs SET payload=?1,sha256=?2 WHERE id=?3 AND sha256=?4",
        params![job.to_string(), hash, text(job, "jobId"), expected.as_str()],
    )? != 1
    {
        return Err(AppError::new(
            "revision_conflict",
            "标注任务已改变，本次结果未覆盖。",
        ));
    }
    tx.commit()?;
    *expected = hash;
    Ok(())
}
fn step(
    bank: &LocalQuestionBank,
    model: &ModelClient,
    payload: &Value,
    cancel: &AtomicBool,
) -> AppResult<Value> {
    let mut job = load(bank, text(payload, "jobId"))?;
    let mut expected = hash_json(&job);
    if job["status"] == "cancelled" || job["status"] == "completed" {
        return Ok(json!({"job":job}));
    }
    if identity(model) != job["modelIdentity"] {
        return Err(AppError::new(
            "model_configuration_changed",
            "模型配置已改变；请恢复原配置或重新创建任务。",
        ));
    }
    if !model.configured() {
        return Err(AppError::new("not_configured", "请先配置模型。"));
    }
    if rows(&job["items"]).any(lease_active) {
        return Err(AppError::new(
            "annotation_busy",
            "当前题正在处理，请稍后刷新；不会重复调用模型。",
        ));
    }
    let index = job["items"].as_array().unwrap().iter().position(|i| {
        i["status"] == "pending"
            || i["status"] == "running"
            || payload["retryFailed"] == true && i["status"] == "failed"
    });
    let Some(index) = index else {
        summary(&mut job);
        save(bank, &job, &mut expected)?;
        return Ok(json!({"job":job}));
    };
    let reusable_result = if matches!(
        job["items"][index]["error"]["code"].as_str(),
        Some("storage_error" | "storage_busy")
    ) {
        job["items"][index]
            .get("rawResult")
            .filter(|raw| raw.is_object())
            .cloned()
    } else {
        None
    };
    // Older versions may have retried a provider after a commit-only failure.
    // Recover only responses whose own attempt failed during storage, never
    // responses attached to model or structural validation failures.
    let mut reusable_results = reusable_result.iter().cloned().collect::<Vec<_>>();
    if let Some(history) = job["items"][index]["attemptHistory"].as_array() {
        for attempt in history.iter().rev() {
            if matches!(
                attempt["error"]["code"].as_str(),
                Some("storage_error" | "storage_busy")
            ) {
                if let Some(raw) = attempt.get("rawResult").filter(|raw| raw.is_object()) {
                    if !reusable_results
                        .iter()
                        .any(|prior| hash_json(prior) == hash_json(raw))
                    {
                        reusable_results.push(raw.clone());
                    }
                }
            }
        }
    }
    let mut reused_result = false;
    job["items"][index]["reusedResult"] = json!(false);
    job["items"][index]["status"] = json!("running");
    let lease = uuid::Uuid::new_v4().to_string();
    job["items"][index]["leaseId"] = json!(lease);
    job["items"][index]["leaseExpiresAt"] = json!(chrono::Utc::now().timestamp() + 180);
    job["items"][index]["attempts"] =
        json!(job["items"][index]["attempts"].as_u64().unwrap_or(0) + 1);
    job["items"][index]["startedAt"] = json!(now());
    if let Some(o) = job["items"][index].as_object_mut() {
        o.remove("error");
        if reusable_result.is_none() {
            o.remove("rawResult");
        }
    }
    save(bank, &job, &mut expected)?;
    let result = (|| -> AppResult<(Value, Value, Value)> {
        let q = bank.question(text(&job["items"][index], "questionId"))?;
        if hash_json(&q) != job["items"][index]["questionSha256"] {
            return Err(AppError::new(
                "revision_conflict",
                "题目版本已改变，未调用模型或修改标注。",
            ));
        }
        let old = &job["items"][index]["previousAnnotation"];
        if old.is_object()
            && ["contentVersion", "teacherVersion"]
                .iter()
                .any(|key| old[*key] != q[*key])
        {
            return Err(AppError::new(
                "revision_conflict",
                "旧标注不属于当前题目版本，请先修复版本索引。",
            ));
        }
        let config = bank.config()?;
        if hash_json(&annotation(&config, text(&q, "questionId"))?)
            != job["items"][index]["annotationSha256"]
        {
            return Err(AppError::new(
                "revision_conflict",
                "题目标注已改变，未调用模型或覆盖。",
            ));
        }
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(AppError::new(
                "cancelled",
                "已暂停本次操作，已有模型结果保留。",
            ));
        }
        let valid_cached = reusable_results.iter().find(|raw| {
            normalized_annotation(
                &job["items"][index]["previousAnnotation"],
                &q,
                raw,
                text(&job, "mode"),
                &config,
            )
            .is_ok()
        });
        let raw = if let Some(raw) = valid_cached {
            reused_result = true;
            raw.clone()
        } else {
            // Structural/model failures require a fresh provider response. A
            // previous metadata write failure alone permits verified reuse.
            if reusable_result.is_some() {
                job["items"][index]
                    .as_object_mut()
                    .unwrap()
                    .remove("rawResult");
                save(bank, &job, &mut expected)?;
            }
            model.propose("question_annotation",&json!({"mode":job["mode"],"question":q,"operatorReview":job["reviewNotes"].get(text(&q,"questionId")).cloned().unwrap_or(Value::Null),"operatorReviewInstruction":"operatorReview 是维护者明确提交的待核实审核意见，不是题目原文或独立证据。应依据题目内容和可信知识目录核实，可说明不能采纳的原因；不得据此改写题面、来源、原答案或升级审核状态。","knowledgeCatalogue":config["knowledgeCatalogue"],"premises":config["premises"],"rubricVersion":RUBRIC_VERSION}),cancel)?
        };
        // Other windows may pause while the provider is working. Reload rather
        // than overwriting their cancellation or a newer lease.
        job = load(bank, text(payload, "jobId"))?;
        expected = hash_json(&job);
        if job["items"][index]["leaseId"] != lease {
            return Err(AppError::new(
                "revision_conflict",
                "当前题已由另一项操作接管。",
            ));
        }
        job["items"][index]["rawResult"] = raw.clone();
        job["items"][index]["reusedResult"] = json!(reused_result);
        if job["status"] == "cancelled" {
            return Err(AppError::new("cancelled", "已暂停任务，当前结果未应用。"));
        }
        // Raw output survives structural failure for audit/retry diagnostics.
        save(bank, &job, &mut expected)?;
        let next = normalized_annotation(
            &job["items"][index]["previousAnnotation"],
            &q,
            &raw,
            text(&job, "mode"),
            &config,
        )?;
        Ok((q, next, raw))
    })();
    let result = match result {
        Ok((q, next, raw)) => {
            job["items"][index]["difficultyAssessment"] = normalize_difficulty(&raw)?;
            commit(bank, &mut job, index, &q, &next, &mut expected)
        }
        Err(e) => Err(e),
    };
    if let Err(error) = result {
        let raw = job["items"][index].get("rawResult").cloned();
        let current = load(bank, text(payload, "jobId"))?;
        // A newer lease or committed result wins over this provider response.
        if current["items"][index]["leaseId"] != lease
            || current["items"][index]["status"] == "succeeded"
        {
            return Ok(json!({"job":current}));
        }
        job = current;
        expected = hash_json(&job);
        if let Some(raw) = raw {
            job["items"][index]["rawResult"] = raw;
        }
        job["items"][index]["reusedResult"] = json!(reused_result);
        let paused = job["status"] == "cancelled" || error.code == "cancelled";
        job["items"][index]["status"] = json!(if paused { "pending" } else { "failed" });
        job["items"][index]["error"] = serde_json::to_value(&error)?;
        if paused {
            job["status"] = json!("cancelled");
        }
        let attempt = json!({"at":now(),"error":error,"rawResult":job["items"][index]["rawResult"],"reusedResult":reused_result});
        job["items"][index]["attemptHistory"]
            .as_array_mut()
            .unwrap()
            .push(attempt);
        summary(&mut job);
        save(bank, &job, &mut expected)?;
    }
    Ok(json!({"job":job}))
}
pub fn dispatch(
    store: &mut Store,
    action: &str,
    payload: &Value,
    cancel: &AtomicBool,
) -> AppResult<Option<Value>> {
    if !action.starts_with("bank_annotation_") {
        return Ok(None);
    }
    let bank = &store.bank;
    schema(bank)?;
    let value = match action {
        "bank_annotation_start" => start(bank, &ModelClient::open(&store.data_dir)?, payload)?,
        "bank_annotation_step" => {
            step(bank, &ModelClient::open(&store.data_dir)?, payload, cancel)?
        }
        "bank_annotation_get" => json!({"job":load(bank,text(payload,"jobId"))?}),
        "bank_annotation_list" => {
            let mut statement = bank
                .annotation_connection()
                .prepare("SELECT id FROM bank_annotation_jobs ORDER BY rowid DESC")?;
            let ids = statement
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            let jobs = ids
                .iter()
                .map(|id| {
                    load(bank, id).map(|mut job| {
                        job.as_object_mut().unwrap().remove("items");
                        job
                    })
                })
                .collect::<AppResult<Vec<_>>>()?;
            json!({"jobs":jobs})
        }
        "bank_annotation_cancel" | "bank_annotation_resume" => {
            let mut job = load(bank, text(payload, "jobId"))?;
            let mut expected = hash_json(&job);
            if job["status"] != "completed" {
                if action == "bank_annotation_cancel" {
                    job["status"] = json!("cancelled");
                } else {
                    if rows(&job["items"]).any(lease_active) {
                        return Err(AppError::new(
                            "annotation_busy",
                            "当前题尚未结束，请稍后继续；若应用意外退出，最多 3 分钟后可恢复。",
                        ));
                    }
                    let model = ModelClient::open(&store.data_dir)?;
                    if identity(&model) != job["modelIdentity"] {
                        return Err(AppError::new(
                            "model_configuration_changed",
                            "请使用原模型配置继续，或创建新的重标任务。",
                        ));
                    }
                    job["status"] = json!("running");
                    for item in job["items"].as_array_mut().unwrap() {
                        if matches!(item["status"].as_str(), Some("running" | "failed")) {
                            item["status"] = json!("pending");
                        }
                    }
                }
                summary(&mut job);
                save(bank, &job, &mut expected)?;
            }
            json!({"job":job})
        }
        _ => return Err(AppError::new("unknown_action", "不支持的标注操作。")),
    };
    Ok(Some(value))
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::atomic::{AtomicUsize, Ordering},
    };
    fn fixture() -> Value {
        let mut seed = crate::bank::tests::seed();
        let q = &seed["questions"][0];
        seed["config"] = json!({"subject":"math","premises":[{"id":"simulated-premise"}],"knowledgeCatalogue":{"points":[{"uid":"simulated-point","name":"模拟知识点","sectionIds":["1.1"]}]},"assemblyIndex":{"entries":[{"questionId":q["questionId"],"contentVersion":q["contentVersion"],"teacherVersion":q["teacherVersion"],"tasks":["simulated-task"],"primarySections":["1.1"],"difficultyEstimate":0.4,"difficultyLevel":"medium","solutionPaths":[],"goalEvidence":[{"status":"unknown"}],"teacherProvenance":{"kind":"generated","reviewStatus":"sample_reviewed"}}]}});
        seed
    }
    fn empty_model(path: &std::path::Path) {
        std::fs::write(
            path.join("model-settings.json"),
            json!({"schemaVersion":2,"revision":0,"profiles":[],"activeProfileId":null})
                .to_string(),
        )
        .unwrap();
    }
    fn result() -> Value {
        json!({"difficultyAssessment":{"level":"easy_medium","basis":"模拟回归：直接方法后需一次简单变形与条件检查。","rubricVersion":RUBRIC_VERSION},"knowledgeSchemaVersion":2,"primaryKnowledgeUids":["simulated-point"],"solutionPaths":[{"id":"simulated-path","requiredKnowledgeUids":["simulated-point"],"requiredPremises":[],"basis":"模拟回归：先按概念表示，再运算，完整处理题目。"}]})
    }
    fn configure(path: &std::path::Path, url: &str) -> ModelClient {
        empty_model(path);
        let mut model = ModelClient::open(path).unwrap();
        model.save(&json!({"baseUrl":url,"model":"simulated-local-model","apiKey":"simulated-local-key"})).unwrap();
        model
    }
    fn begin(bank: &LocalQuestionBank, model: &ModelClient, operation: &str) -> Value {
        schema(bank).unwrap();
        start(
            bank,
            model,
            &json!({"mode":"full","questionIds":["simulated-question"],"operationId":operation}),
        )
        .unwrap()["job"]
            .clone()
    }
    fn server(
        responses: Vec<(u16, Value)>,
    ) -> (
        String,
        std::thread::JoinHandle<()>,
        std::sync::Arc<AtomicUsize>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let calls = std::sync::Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let handle = std::thread::spawn(move || {
            for (status, result) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(10)))
                    .unwrap();
                let mut data = Vec::new();
                let mut buf = [0u8; 4096];
                loop {
                    let n = stream.read(&mut buf).unwrap();
                    if n == 0 {
                        break;
                    }
                    data.extend_from_slice(&buf[..n]);
                    if let Some(end) = data.windows(4).position(|b| b == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&data[..end]).to_lowercase();
                        let length = headers
                            .lines()
                            .find_map(|l| {
                                l.strip_prefix("content-length:")
                                    .and_then(|v| v.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if data.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                count.fetch_add(1, Ordering::SeqCst);
                let request = String::from_utf8(data).unwrap();
                assert!(request.contains("simulated-local-model"));
                assert!(request.contains("simulated-question"));
                let body =
                    json!({"choices":[{"message":{"content":result.to_string()}}]}).to_string();
                write!(stream,"HTTP/1.1 {status} Simulated\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
            }
        });
        (url, handle, calls)
    }
    #[test]
    fn simulated_difficulty_requires_named_rubric_and_specific_basis_without_false_precision() {
        assert_eq!(
            normalize_difficulty(&json!({})).unwrap()["level"],
            Value::Null
        );
        for level in crate::intake::DIFFICULTY_LEVELS {
            assert!(normalize_difficulty(&json!({"difficultyAssessment":{"level":level,"basis":"模拟回归：需要独立发现条件边界。","rubricVersion":RUBRIC_VERSION}})).is_ok());
        }
        for bad in [
            json!({"level":"easy","basis":"简单"}),
            json!({"level":"expert","basis":"模拟无效等级说明"}),
            json!({"level":"medium","basis":"模拟具体说明","rubricVersion":"other"}),
            json!({"level":0.5,"basis":"模拟数字不可当等级"}),
            json!(null),
        ] {
            assert!(normalize_difficulty(&json!({"difficultyAssessment":bad})).is_err());
        }
        let mut a = json!({"difficultyEstimate":0.6,"tasks":["keep"]});
        apply_difficulty(
            &mut a,
            &json!({"difficultyAssessment":normalize_difficulty(&result()).unwrap()}),
        );
        assert!(a.get("difficultyEstimate").is_none());
        assert_eq!(a["tasks"], json!(["keep"]));
    }
    #[test]
    fn simulated_full_annotation_validates_exact_uids_and_leaves_incomplete_paths_unknown() {
        let seed = fixture();
        let q = &seed["questions"][0];
        let old = &seed["config"]["assemblyIndex"]["entries"][0];
        let mut missing = result();
        missing
            .as_object_mut()
            .unwrap()
            .remove("difficultyAssessment");
        for mode in ["full", "difficulty_only"] {
            assert!(normalized_annotation(old, q, &missing, mode, &seed["config"]).is_err());
        }
        let mut explicit_unknown = result();
        explicit_unknown["difficultyAssessment"] = json!({"level":null,"basis":"原解析不足，无法可靠评估。","rubricVersion":RUBRIC_VERSION});
        assert_eq!(
            normalized_annotation(old, q, &explicit_unknown, "full", &seed["config"]).unwrap()["difficultyLevel"],
            Value::Null
        );
        let full = normalized_annotation(old, q, &result(), "full", &seed["config"]).unwrap();
        assert_eq!(full["primaryKnowledgeUids"], json!(["simulated-point"]));
        assert_eq!(full["tasks"], old["tasks"]);
        assert_eq!(full["goalEvidence"], old["goalEvidence"]);
        assert_eq!(full["teacherProvenance"], old["teacherProvenance"]);
        let mut empty = result();
        empty["primaryKnowledgeUids"] = json!([]);
        empty["solutionPaths"] = json!([]);
        let unknown = normalized_annotation(old, q, &empty, "full", &seed["config"]).unwrap();
        assert_eq!(unknown["solutionPaths"], json!([]));
        assert_eq!(unknown["primarySections"], json!([]));
        let mut bad = result();
        bad["primaryKnowledgeUids"] = json!(["invented"]);
        assert!(normalized_annotation(old, q, &bad, "full", &seed["config"]).is_err());
        bad = result();
        bad["solutionPaths"][0]["requiredPremises"] = json!(["invented-premise"]);
        assert!(normalized_annotation(old, q, &bad, "full", &seed["config"]).is_err());
        bad = result();
        bad["solutionPaths"][0]["requiredKnowledgeUids"] = json!(["invented"]);
        assert!(normalized_annotation(old, q, &bad, "full", &seed["config"]).is_err());
        let only =
            normalized_annotation(old, q, &result(), "difficulty_only", &seed["config"]).unwrap();
        assert!(only.get("primaryKnowledgeUids").is_none());
        assert_eq!(only["solutionPaths"], old["solutionPaths"]);
    }
    #[test]
    fn simulated_reannotation_http_failure_resume_idempotency_and_frozen_personal_data() {
        let dir = tempfile::tempdir().unwrap();
        let seed = fixture();
        let mut store = Store::open(dir.path(), &seed).unwrap();
        let original = store.bank.question("simulated-question").unwrap();
        let config = store.bank.config().unwrap();
        let paper = json!({"paperId":"simulated-frozen","questions":[original],"annotationSnapshot":config["assemblyIndex"],"sourceDraftId":"simulated-draft"});
        store
            .put_document("papers", "simulated-frozen", &paper)
            .unwrap();
        let (url, handle, calls) = server(vec![(503, json!({})), (200, result())]);
        let model = configure(dir.path(), &url);
        let cancel = AtomicBool::new(false);
        let job = begin(&store.bank, &model, "simulated-operation");
        let request = json!({"jobId":job["jobId"]});
        assert_eq!(
            begin(&store.bank, &model, "simulated-operation")["jobId"],
            job["jobId"]
        );
        let paused = dispatch(&mut store, "bank_annotation_cancel", &request, &cancel)
            .unwrap()
            .unwrap();
        assert_eq!(paused["job"]["status"], "cancelled");
        assert_eq!(
            step(&store.bank, &model, &request, &cancel).unwrap()["job"]["completed"],
            0
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        dispatch(&mut store, "bank_annotation_resume", &request, &cancel).unwrap();
        let failed = step(&store.bank, &model, &request, &cancel).unwrap();
        assert_eq!(failed["job"]["failed"], 1);
        assert_eq!(store.bank.config().unwrap(), config);
        dispatch(&mut store, "bank_annotation_resume", &request, &cancel).unwrap();
        let done = step(&store.bank, &model, &request, &cancel).unwrap();
        assert_eq!(done["job"]["completed"], 1);
        assert_eq!(done["job"]["items"][0]["attempts"], 2);
        assert_eq!(
            done["job"]["items"][0]["attemptHistory"][0]["error"]["code"],
            "model_error"
        );
        assert_eq!(
            step(&store.bank, &model, &request, &cancel).unwrap()["job"],
            done["job"]
        );
        handle.join().unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(store.bank.question("simulated-question").unwrap(), original);
        assert_eq!(store.document("papers", "simulated-frozen").unwrap(), paper);
        let updated = store.bank.config().unwrap()["assemblyIndex"]["entries"][0].clone();
        assert_eq!(updated["difficultyLevel"], "easy_medium");
        assert!(updated.get("difficultyEstimate").is_none());
        assert_eq!(
            updated["teacherProvenance"],
            config["assemblyIndex"]["entries"][0]["teacherProvenance"]
        );
        drop(store);
        let mut reopened = Store::open(dir.path(), &seed).unwrap();
        assert_eq!(
            load(&reopened.bank, text(&job, "jobId")).unwrap()["status"],
            "completed"
        );
        assert_eq!(
            reopened.document("papers", "simulated-frozen").unwrap(),
            paper
        );
        let listing = dispatch(&mut reopened, "bank_annotation_list", &json!({}), &cancel)
            .unwrap()
            .unwrap();
        assert!(listing["jobs"][0].get("items").is_none());
    }
    #[test]
    fn simulated_concurrent_jobs_cannot_overwrite_new_annotation_or_cancelled_job() {
        let dir = tempfile::tempdir().unwrap();
        let seed = fixture();
        let mut store = Store::open(dir.path(), &seed).unwrap();
        let model = configure(dir.path(), "http://127.0.0.1:9/v1");
        let cancel = AtomicBool::new(false);
        let mut a = begin(&store.bank, &model, "simulated-concurrent-a");
        let mut b = begin(&store.bank, &model, "simulated-concurrent-b");
        let q = store.bank.question("simulated-question").unwrap();
        let config = store.bank.config().unwrap();
        let next = normalized_annotation(
            &a["items"][0]["previousAnnotation"],
            &q,
            &result(),
            "full",
            &config,
        )
        .unwrap();
        let mut expected_a = hash_json(&a);
        let mut expected_b = hash_json(&b);
        a["items"][0]["status"] = json!("running");
        a["items"][0]["leaseExpiresAt"] = json!(chrono::Utc::now().timestamp() + 180);
        save(&store.bank, &a, &mut expected_a).unwrap();
        assert_eq!(
            step(&store.bank, &model, &json!({"jobId":a["jobId"]}), &cancel)
                .unwrap_err()
                .code,
            "annotation_busy"
        );
        commit(&store.bank, &mut a, 0, &q, &next, &mut expected_a).unwrap();
        let after = store.bank.config().unwrap();
        assert_eq!(
            commit(&store.bank, &mut b, 0, &q, &next, &mut expected_b)
                .unwrap_err()
                .code,
            "revision_conflict"
        );
        assert_eq!(store.bank.config().unwrap(), after);
        let mut c = begin(&store.bank, &model, "simulated-cancel-c");
        let mut stale_hash = hash_json(&c);
        dispatch(
            &mut store,
            "bank_annotation_cancel",
            &json!({"jobId":c["jobId"]}),
            &cancel,
        )
        .unwrap();
        let next = normalized_annotation(
            &c["items"][0]["previousAnnotation"],
            &q,
            &result(),
            "full",
            &after,
        )
        .unwrap();
        assert_eq!(
            commit(&store.bank, &mut c, 0, &q, &next, &mut stale_hash)
                .unwrap_err()
                .code,
            "revision_conflict"
        );
        assert_eq!(
            load(&store.bank, text(&c, "jobId")).unwrap()["status"],
            "cancelled"
        );
        assert_eq!(store.bank.config().unwrap(), after);
    }
    #[test]
    fn simulated_version_change_fails_before_model_and_preserves_old_indexes() {
        let dir = tempfile::tempdir().unwrap();
        let seed = fixture();
        let store = Store::open(dir.path(), &seed).unwrap();
        let model = configure(dir.path(), "http://127.0.0.1:9/v1");
        let job = begin(&store.bank, &model, "simulated-version-change");
        let before = store.bank.config().unwrap();
        let mut q = store.bank.question("simulated-question").unwrap();
        q["source"] = json!({"label":"模拟来源版本变化"});
        store
            .bank
            .annotation_connection()
            .execute(
                "UPDATE bank_questions SET payload=?1 WHERE id='simulated-question'",
                [q.to_string()],
            )
            .unwrap();
        let response = step(
            &store.bank,
            &model,
            &json!({"jobId":job["jobId"]}),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(
            response["job"]["items"][0]["error"]["code"],
            "revision_conflict"
        );
        assert_eq!(store.bank.config().unwrap(), before);
    }
    #[test]
    fn simulated_two_connections_pause_inflight_http_without_overwriting_results_or_duplicate_calls()
     {
        for status in [200u16, 503u16] {
            let dir = tempfile::tempdir().unwrap();
            let seed = fixture();
            let mut store = Store::open(dir.path(), &seed).unwrap();
            let before = store.bank.config().unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/v1", listener.local_addr().unwrap());
            let (ready_send, ready_recv) = std::sync::mpsc::channel();
            let (release_send, release_recv) = std::sync::mpsc::channel();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(10)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buf = [0u8; 4096];
                loop {
                    let n = stream.read(&mut buf).unwrap();
                    bytes.extend_from_slice(&buf[..n]);
                    if n == 0 {
                        break;
                    }
                    if let Some(end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                        let length = headers
                            .lines()
                            .find_map(|l| {
                                l.strip_prefix("content-length:")
                                    .and_then(|v| v.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                ready_send.send(()).unwrap();
                release_recv
                    .recv_timeout(std::time::Duration::from_secs(10))
                    .unwrap();
                let body =
                    json!({"choices":[{"message":{"content":result().to_string()}}]}).to_string();
                write!(stream,"HTTP/1.1 {status} Simulated\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
            });
            let model = configure(dir.path(), &url);
            let job = begin(&store.bank, &model, &format!("simulated-inflight-{status}"));
            let request = json!({"jobId":job["jobId"]});
            let worker_dir = dir.path().to_path_buf();
            let worker_seed = seed.clone();
            let worker_request = request.clone();
            let worker = std::thread::spawn(move || {
                let store = Store::open(&worker_dir, &worker_seed).unwrap();
                let model = ModelClient::open(&worker_dir).unwrap();
                step(
                    &store.bank,
                    &model,
                    &worker_request,
                    &AtomicBool::new(false),
                )
                .unwrap()
            });
            ready_recv
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap();
            assert_eq!(
                step(&store.bank, &model, &request, &AtomicBool::new(false))
                    .unwrap_err()
                    .code,
                "annotation_busy"
            );
            dispatch(
                &mut store,
                "bank_annotation_cancel",
                &request,
                &AtomicBool::new(false),
            )
            .unwrap();
            release_send.send(()).unwrap();
            let response = worker.join().unwrap();
            server.join().unwrap();
            assert_eq!(response["job"]["status"], "cancelled");
            assert_eq!(response["job"]["items"][0]["status"], "pending");
            assert_eq!(store.bank.config().unwrap(), before);
            let resumed = dispatch(
                &mut store,
                "bank_annotation_resume",
                &request,
                &AtomicBool::new(false),
            )
            .unwrap()
            .unwrap();
            assert_eq!(resumed["job"]["status"], "running");
            assert_eq!(resumed["job"]["items"][0]["attempts"], 1);
        }
    }
    #[test]
    fn simulated_two_independent_jobs_simultaneous_http_success_preserves_both_indexes() {
        let dir = tempfile::tempdir().unwrap();
        let mut seed = fixture();
        let mut second = seed["questions"][0].clone();
        second["questionId"] = json!("simulated-question-second");
        seed["questions"].as_array_mut().unwrap().push(second);
        let mut index = seed["config"]["assemblyIndex"]["entries"][0].clone();
        index["questionId"] = json!("simulated-question-second");
        seed["config"]["assemblyIndex"]["entries"]
            .as_array_mut()
            .unwrap()
            .push(index);
        let store = Store::open(dir.path(), &seed).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let server_barrier = barrier.clone();
        let server = std::thread::spawn(move || {
            let mut handlers = Vec::new();
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let barrier = server_barrier.clone();
                handlers.push(std::thread::spawn(move||{
                stream.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();let mut bytes=Vec::new();let mut buf=[0u8;4096];
                loop{let n=stream.read(&mut buf).unwrap();bytes.extend_from_slice(&buf[..n]);if n==0{break;}if let Some(end)=bytes.windows(4).position(|b|b==b"\r\n\r\n"){let headers=String::from_utf8_lossy(&bytes[..end]).to_lowercase();let length=headers.lines().find_map(|l|l.strip_prefix("content-length:").and_then(|v|v.trim().parse::<usize>().ok())).unwrap_or(0);if bytes.len()>=end+4+length{break;}}}
                barrier.wait();let body=json!({"choices":[{"message":{"content":result().to_string()}}]}).to_string();write!(stream,"HTTP/1.1 200 Simulated\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
            }));
            }
            for handler in handlers {
                handler.join().unwrap();
            }
        });
        let model = configure(dir.path(), &url);
        schema(&store.bank).unwrap();
        let jobs=["simulated-question","simulated-question-second"].iter().enumerate().map(|(i,id)|start(&store.bank,&model,&json!({"mode":"full","questionIds":[id],"operationId":format!("simulated-parallel-{i}")})).unwrap()["job"].clone()).collect::<Vec<_>>();
        let workers = jobs
            .iter()
            .map(|job| {
                let path = dir.path().to_path_buf();
                let seed = seed.clone();
                let request = json!({"jobId":job["jobId"]});
                std::thread::spawn(move || {
                    let store = Store::open(&path, &seed).unwrap();
                    let model = ModelClient::open(&path).unwrap();
                    step(&store.bank, &model, &request, &AtomicBool::new(false)).unwrap()
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        for worker in workers {
            let result = worker.join().unwrap();
            assert_eq!(result["job"]["completed"], 1, "{result}");
            assert_eq!(result["job"]["failed"], 0);
        }
        server.join().unwrap();
        let entries = store.bank.config().unwrap()["assemblyIndex"]["entries"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(entries.len(), 2);
        for entry in entries {
            assert_eq!(entry["difficultyLevel"], "easy_medium");
            assert_eq!(entry["primaryKnowledgeUids"], json!(["simulated-point"]));
            assert_eq!(entry["teacherProvenance"]["kind"], "generated");
        }
        for job in jobs {
            assert_eq!(
                load(&store.bank, text(&job, "jobId")).unwrap()["status"],
                "completed"
            );
        }
    }
    #[test]
    fn simulated_failed_metadata_commit_reuses_verified_response_after_explicit_resume_without_second_http()
     {
        let dir = tempfile::tempdir().unwrap();
        let seed = fixture();
        let mut store = Store::open(dir.path(), &seed).unwrap();
        let before = store.bank.config().unwrap();
        let (url, server, calls) = server(vec![(200, result())]);
        let model = configure(dir.path(), &url);
        let job = begin(&store.bank, &model, "simulated-cache-recovery");
        let request = json!({"jobId":job["jobId"]});
        let cancel = AtomicBool::new(false);
        // Real SQLite failure at exactly the metadata commit boundary; the raw
        // HTTP response and failure audit remain writable in the job table.
        store.bank.annotation_connection().execute_batch("CREATE TRIGGER simulated_fail_annotation_commit BEFORE UPDATE ON bank_metadata WHEN OLD.key='config' BEGIN SELECT RAISE(ABORT,'simulated transient metadata write failure'); END;").unwrap();
        let failed = step(&store.bank, &model, &request, &cancel).unwrap();
        server.join().unwrap();
        assert_eq!(failed["job"]["items"][0]["error"]["code"], "storage_error");
        assert_eq!(failed["job"]["items"][0]["rawResult"], result());
        assert_eq!(failed["job"]["completed"], 0);
        assert_eq!(store.bank.config().unwrap(), before);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        store
            .bank
            .annotation_connection()
            .execute_batch("DROP TRIGGER simulated_fail_annotation_commit;")
            .unwrap();
        dispatch(&mut store, "bank_annotation_resume", &request, &cancel).unwrap();
        let done = step(&store.bank, &model, &request, &cancel).unwrap();
        assert_eq!(done["job"]["completed"], 1, "{done}");
        assert_eq!(done["job"]["items"][0]["reusedResult"], true);
        assert_eq!(
            done["job"]["items"][0]["attemptHistory"][1]["reusedResult"],
            true
        );
        assert_eq!(done["job"]["items"][0]["attempts"], 2);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn simulated_invalid_model_metadata_is_requested_again_instead_of_reusing_failed_structure() {
        let dir = tempfile::tempdir().unwrap();
        let seed = fixture();
        let mut store = Store::open(dir.path(), &seed).unwrap();
        let (url, server, calls) = server(vec![
            (
                200,
                json!({"knowledgeSchemaVersion":2,"primaryKnowledgeUids":[],"solutionPaths":[]}),
            ),
            (200, result()),
        ]);
        let model = configure(dir.path(), &url);
        let job = begin(&store.bank, &model, "simulated-no-invalid-cache");
        let request = json!({"jobId":job["jobId"]});
        let cancel = AtomicBool::new(false);
        let failed = step(&store.bank, &model, &request, &cancel).unwrap();
        assert_eq!(
            failed["job"]["items"][0]["error"]["code"],
            "invalid_annotation"
        );
        assert!(failed["job"]["items"][0]["rawResult"].is_object());
        dispatch(&mut store, "bank_annotation_resume", &request, &cancel).unwrap();
        let done = step(&store.bank, &model, &request, &cancel).unwrap();
        server.join().unwrap();
        assert_eq!(done["job"]["completed"], 1);
        assert_eq!(done["job"]["items"][0]["reusedResult"], false);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
    #[test]
    fn simulated_historical_storage_response_survives_later_model_failure_and_avoids_further_calls()
    {
        let dir = tempfile::tempdir().unwrap();
        let seed = fixture();
        let mut store = Store::open(dir.path(), &seed).unwrap();
        let (url, server, calls) = server(vec![
            (200, result()),
            (200, json!("simulated JSON response was not an object")),
        ]);
        let model = configure(dir.path(), &url);
        let job = begin(&store.bank, &model, "simulated-historical-storage-cache");
        let request = json!({"jobId":job["jobId"]});
        let cancel = AtomicBool::new(false);
        store.bank.annotation_connection().execute_batch("CREATE TRIGGER simulated_fail_annotation_commit BEFORE UPDATE ON bank_metadata WHEN OLD.key='config' BEGIN SELECT RAISE(ABORT,'simulated transient metadata write failure'); END;").unwrap();
        let first = step(&store.bank, &model, &request, &cancel).unwrap();
        assert_eq!(first["job"]["items"][0]["error"]["code"], "storage_error");
        store
            .bank
            .annotation_connection()
            .execute_batch("DROP TRIGGER simulated_fail_annotation_commit;")
            .unwrap();
        // Reproduce an already persisted older-CLI history: after the first
        // real commit failure it issued another real provider request, which
        // failed parsing/shape validation and had no object response to save.
        let error = model
            .propose(
                "question_annotation",
                &json!({"question":store.bank.question("simulated-question").unwrap()}),
                &cancel,
            )
            .unwrap_err();
        assert_eq!(error.code, "model_error");
        server.join().unwrap();
        let mut legacy = load(&store.bank, text(&job, "jobId")).unwrap();
        let mut expected = hash_json(&legacy);
        legacy["items"][0]["attempts"] = json!(2);
        legacy["items"][0]["error"] = serde_json::to_value(&error).unwrap();
        legacy["items"][0]
            .as_object_mut()
            .unwrap()
            .remove("rawResult");
        legacy["items"][0]["attemptHistory"]
            .as_array_mut()
            .unwrap()
            .push(json!({"at":now(),"error":error,"rawResult":null}));
        save(&store.bank, &legacy, &mut expected).unwrap();
        dispatch(&mut store, "bank_annotation_resume", &request, &cancel).unwrap();
        let done = step(&store.bank, &model, &request, &cancel).unwrap();
        assert_eq!(done["job"]["completed"], 1, "{done}");
        assert_eq!(done["job"]["items"][0]["reusedResult"], true);
        assert_eq!(done["job"]["items"][0]["attempts"], 3);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(done["job"]["items"][0]["rawResult"], result());
    }
    #[test]
    fn simulated_new_full_annotations_require_actual_leaf_uids_but_legacy_groups_remain_readable() {
        let seed = fixture();
        let q = &seed["questions"][0];
        let old = &seed["config"]["assemblyIndex"]["entries"][0];
        let mut config = seed["config"].clone();
        config["knowledgeCatalogue"]["points"][0]["parentUid"] = json!("simulated-group");
        config["knowledgeCatalogue"]["points"][0]["isLeaf"] = json!(true);
        config["knowledgeCatalogue"]["points"].as_array_mut().unwrap().push(json!({"uid":"simulated-group","name":"模拟集合分类节点","isLeaf":false,"sectionIds":["1.1"]}));
        assert!(normalized_annotation(old, q, &result(), "full", &config).is_ok());
        let mut grouped = result();
        grouped["primaryKnowledgeUids"] = json!(["simulated-group"]);
        grouped["solutionPaths"][0]["requiredKnowledgeUids"] = json!(["simulated-group"]);
        assert!(
            knowledge::validate_annotation(&grouped, &config).is_ok(),
            "legacy identity validation stays unchanged"
        );
        assert!(normalized_annotation(old, q, &grouped, "full", &config).is_err());
        // A stale or missing leaf flag cannot override actual catalogue children.
        config["knowledgeCatalogue"]["points"][1]["isLeaf"] = json!(true);
        assert!(normalized_annotation(old, q, &grouped, "full", &config).is_err());
        config["knowledgeCatalogue"]["points"][1]
            .as_object_mut()
            .unwrap()
            .remove("isLeaf");
        assert!(normalized_annotation(old, q, &grouped, "full", &config).is_err());
        let mut supporting = result();
        supporting["solutionPaths"][0]["requiredKnowledgeUids"] =
            json!(["simulated-point", "simulated-group"]);
        assert!(normalized_annotation(old, q, &supporting, "full", &config).is_err());
        let mut unknown = result();
        unknown["primaryKnowledgeUids"] = json!([]);
        unknown["solutionPaths"] = json!([]);
        let empty = normalized_annotation(old, q, &unknown, "full", &config).unwrap();
        assert_eq!(empty["primaryKnowledgeUids"], json!([]));
        assert_eq!(empty["solutionPaths"], json!([]));
        assert!(
            normalized_annotation(&grouped, q, &result(), "difficulty_only", &config).is_ok(),
            "difficulty-only operation does not rewrite historical group associations"
        );
        config["knowledgeCatalogue"]["points"][0]
            .as_object_mut()
            .unwrap()
            .remove("isLeaf");
        assert!(
            normalized_annotation(old, q, &result(), "full", &config).is_ok(),
            "fixtures without flags use real child relationships"
        );
    }
    #[test]
    fn simulated_operator_review_is_scoped_idempotent_and_only_current_note_reaches_http() {
        let dir = tempfile::tempdir().unwrap();
        let mut seed = fixture();
        let mut second = seed["questions"][0].clone();
        second["questionId"] = json!("simulated-question-second");
        seed["questions"].as_array_mut().unwrap().push(second);
        let store = Store::open(dir.path(), &seed).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(10)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buf = [0u8; 4096];
            let body_start;
            loop {
                let n = stream.read(&mut buf).unwrap();
                bytes.extend_from_slice(&buf[..n]);
                if let Some(end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                    let length = headers
                        .lines()
                        .find_map(|l| {
                            l.strip_prefix("content-length:")
                                .and_then(|v| v.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= end + 4 + length {
                        body_start = end + 4;
                        break;
                    }
                }
                assert_ne!(n, 0);
            }
            let request: Value = serde_json::from_slice(&bytes[body_start..]).unwrap();
            let context: Value =
                serde_json::from_str(request["messages"][1]["content"].as_str().unwrap()).unwrap();
            let body =
                json!({"choices":[{"message":{"content":result().to_string()}}]}).to_string();
            write!(stream,"HTTP/1.1 200 Simulated\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
            context
        });
        let model = configure(dir.path(), &url);
        schema(&store.bank).unwrap();
        let note = "模拟审核意见甲：请核实当前题是否真正使用指定知识点。";
        let other_note = "模拟审核意见乙不得发送给第一题。";
        let payload = json!({"mode":"full","questionIds":["simulated-question","simulated-question-second"],"operationId":"simulated-review-notes","reviewNotes":{"simulated-question":note,"simulated-question-second":other_note}});
        let job = start(&store.bank, &model, &payload).unwrap()["job"].clone();
        assert_eq!(job["reviewNotes"], payload["reviewNotes"]);
        assert_eq!(
            start(&store.bank, &model, &payload).unwrap()["job"]["jobId"],
            job["jobId"]
        );
        let mut changed = payload.clone();
        changed["reviewNotes"]["simulated-question"] = json!("模拟同操作不同意见必须冲突");
        assert_eq!(
            start(&store.bank, &model, &changed).unwrap_err().code,
            "operation_conflict"
        );
        for bad in [
            json!({"outside-question":"不可越界"}),
            json!({"simulated-question":"长".repeat(4001)}),
            json!({"simulated-question":42}),
            json!([]),
        ] {
            changed = payload.clone();
            changed["operationId"] = json!("simulated-invalid-review");
            changed["reviewNotes"] = bad;
            assert!(start(&store.bank, &model, &changed).is_err());
        }
        let before = store.bank.question("simulated-question").unwrap();
        let response = step(
            &store.bank,
            &model,
            &json!({"jobId":job["jobId"]}),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(response["job"]["completed"], 1);
        let context = server.join().unwrap();
        assert_eq!(context["operatorReview"], note);
        assert!(
            context["operatorReviewInstruction"]
                .as_str()
                .unwrap()
                .contains("不是题目原文或独立证据")
        );
        assert!(!context.to_string().contains(other_note));
        assert!(context.get("previousAnnotation").is_none());
        assert_eq!(store.bank.question("simulated-question").unwrap(), before);
        assert_eq!(
            load(&store.bank, text(&job, "jobId")).unwrap()["items"][0]["previousAnnotation"],
            seed["config"]["assemblyIndex"]["entries"][0]
        );
    }
}
