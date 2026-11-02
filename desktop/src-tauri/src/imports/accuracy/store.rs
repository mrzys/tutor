//! Personal-domain, append-only evidence and transactional execution budgets.
//! This module never opens the question bank or changes either end contract.
use crate::{
    bank::hash_json,
    error::{AppError, AppResult},
    storage::Store,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use std::{collections::HashSet, path::Path, time::Duration};

fn problem(code: &str, message: &str) -> AppError {
    AppError::new(code, message)
}
fn invalid(message: &str) -> AppError {
    problem("invalid_accuracy_process", message)
}
fn integrity() -> AppError {
    problem(
        "accuracy_integrity",
        "导入过程记录或版本凭据发生变化，未继续处理。",
    )
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
fn millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_default()
}
fn n(v: &Value, k: &str) -> u64 {
    v[k].as_u64().unwrap_or(0)
}
fn id(value: &str) -> AppResult<()> {
    if value.is_empty() || value.len() > 250 || value.chars().any(char::is_control) {
        return Err(invalid("过程身份无效。"));
    }
    Ok(())
}
fn add(a: u64, b: u64) -> AppResult<u64> {
    a.checked_add(b)
        .ok_or_else(|| invalid("过程预算计数溢出。"))
}

pub(crate) fn initialize(store: &Store) -> AppResult<()> {
    schema(&store.user)
}
fn schema(db: &Connection) -> AppResult<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS import_process_runs(
        id TEXT PRIMARY KEY,import_id TEXT NOT NULL,creation_key TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL,payload TEXT NOT NULL,sha256 TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS import_process_runs_import ON import_process_runs(import_id,id);
      CREATE TABLE IF NOT EXISTS import_process_artifacts(
        id TEXT PRIMARY KEY,run_id TEXT NOT NULL,kind TEXT NOT NULL,question_id TEXT NOT NULL,
        payload TEXT NOT NULL,sha256 TEXT NOT NULL,content_key TEXT NOT NULL UNIQUE);
      CREATE INDEX IF NOT EXISTS import_process_artifacts_run ON import_process_artifacts(run_id,kind,question_id);
      CREATE TABLE IF NOT EXISTS import_process_executions(
        id TEXT PRIMARY KEY,run_id TEXT NOT NULL,role TEXT NOT NULL,question_id TEXT NOT NULL,
        status TEXT NOT NULL,payload TEXT NOT NULL,sha256 TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS import_process_executions_running ON import_process_executions(status,role);
      CREATE TABLE IF NOT EXISTS import_finalizations(
        id TEXT PRIMARY KEY,run_id TEXT NOT NULL,operation_id TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,sha256 TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS import_process_artifact_immutable_update BEFORE UPDATE ON import_process_artifacts
        BEGIN SELECT RAISE(ABORT,'immutable_accuracy_artifact'); END;
      CREATE TRIGGER IF NOT EXISTS import_process_artifact_immutable_delete BEFORE DELETE ON import_process_artifacts
        BEGIN SELECT RAISE(ABORT,'immutable_accuracy_artifact'); END;
      CREATE TRIGGER IF NOT EXISTS import_finalization_immutable_update BEFORE UPDATE ON import_finalizations
        BEGIN SELECT RAISE(ABORT,'immutable_accuracy_finalization'); END;
      CREATE TRIGGER IF NOT EXISTS import_finalization_immutable_delete BEFORE DELETE ON import_finalizations
        BEGIN SELECT RAISE(ABORT,'immutable_accuracy_finalization'); END;")?;
    Ok(())
}

fn decode(payload: String, sha: String) -> AppResult<Value> {
    let v: Value = serde_json::from_str(&payload)?;
    if hash_json(&v) != sha {
        return Err(integrity());
    }
    Ok(v)
}
fn read_run(db: &Connection, run_id: &str) -> AppResult<Value> {
    id(run_id)?;
    let found: Option<(String, String, i64)> = db
        .query_row(
            "SELECT payload,sha256,revision FROM import_process_runs WHERE id=?1",
            [run_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let (payload, sha, revision) = found.ok_or_else(|| problem("not_found", "未找到导入过程。"))?;
    let v = decode(payload, sha)?;
    if s(&v, "id") != run_id
        || s(&v, "runId") != run_id
        || i64::try_from(n(&v, "revision")).ok() != Some(revision)
        || hash_json(&v["strategy"]) != s(&v, "strategySha256")
        || hash_json(&v["source"]) != s(&v, "sourceSha256")
    {
        return Err(integrity());
    }
    Ok(v)
}
fn write_run(db: &Connection, expected: u64, mut run: Value) -> AppResult<Value> {
    let next = add(expected, 1)?;
    let next_sql = i64::try_from(next).map_err(|_| invalid("过程版本计数溢出。"))?;
    let expected_sql = i64::try_from(expected).map_err(|_| invalid("过程版本计数溢出。"))?;
    run["revision"] = json!(next);
    run["updatedAt"] = json!(now());
    let changed=db.execute("UPDATE import_process_runs SET revision=?1,payload=?2,sha256=?3 WHERE id=?4 AND revision=?5",
        params![next_sql,run.to_string(),hash_json(&run),s(&run,"id"),expected_sql])?;
    if changed != 1 {
        return Err(problem(
            "revision_conflict",
            "导入过程已更新，请保留输入并重新读取。",
        ));
    }
    Ok(run)
}

fn policy(input: &Value) -> AppResult<Value> {
    if !input.is_object() {
        return Err(invalid("导入预算必须为对象。"));
    }
    let mut out = input.clone();
    for (key, default) in [
        ("maxCalls", 324),
        ("maxInputTokens", 10_000_000),
        ("maxOutputTokens", 16_000_000),
        ("maxActiveWallSeconds", 7200),
        ("maxInFlight", 3),
        ("maxRoleInFlight", 2),
    ] {
        let value = match input.get(key) {
            None => default,
            Some(v) => v
                .as_u64()
                .filter(|n| *n > 0)
                .ok_or_else(|| invalid("导入预算上限需为正整数。"))?,
        };
        if value > i64::MAX as u64 {
            return Err(invalid("导入预算上限过大。"));
        }
        out[key] = json!(value);
    }
    for key in ["roleCallCaps", "roleInFlightCaps"] {
        let caps = input.get(key).cloned().unwrap_or(json!({}));
        let caps = caps
            .as_object()
            .ok_or_else(|| invalid("用途预算需为对象。"))?;
        for (role, cap) in caps {
            id(role)?;
            if cap.as_u64().is_none() {
                return Err(invalid("用途预算需为非负整数。"));
            }
        }
        out[key] = json!(caps);
    }
    if let Some(parent) = input.get("parentBudgetId").filter(|v| !v.is_null()) {
        id(parent.as_str().ok_or_else(|| invalid("父预算身份无效。"))?)?;
    }
    Ok(out)
}

pub(crate) fn create_run(
    store: &Store,
    import_id: &str,
    strategy: &Value,
    source: &Value,
    budget: &Value,
) -> AppResult<Value> {
    initialize(store)?;
    id(import_id)?;
    if !strategy.is_object() || !source.is_object() {
        return Err(invalid("策略快照和来源身份必须为对象。"));
    }
    let version = strategy["strategyVersion"]
        .as_str()
        .or_else(|| strategy["version"].as_str())
        .unwrap_or_default();
    id(version)?;
    let budget = policy(budget)?;
    let key = hash_json(
        &json!({"importId":import_id,"strategy":strategy,"source":source,"budget":budget}),
    );
    let tx = rusqlite::Transaction::new_unchecked(&store.user, TransactionBehavior::Immediate)?;
    if let Some(existing) = tx
        .query_row(
            "SELECT id FROM import_process_runs WHERE creation_key=?1",
            [&key],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        let run = read_run(&tx, &existing)?;
        tx.commit()?;
        return Ok(run);
    }
    if let Some(parent) = budget["parentBudgetId"].as_str() {
        let run = read_run(&tx, parent)?;
        if run["importId"] != import_id {
            return Err(invalid("父预算必须属于同一导入任务。"));
        }
    } else if tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM import_process_runs WHERE import_id=?1)",
        [import_id],
        |r| r.get::<_, bool>(0),
    )? {
        return Err(invalid(
            "此导入已有过程预算；新策略或输入修订必须显式继承原预算，不能重置额度。",
        ));
    }
    let run_id = format!("accuracy-run-{}", uuid::Uuid::new_v4());
    let timestamp = now();
    let run = json!({"schemaVersion":1,"id":run_id,"runId":run_id,"importId":import_id,"revision":0,
      "pipelineVersion":strategy["pipelineVersion"].as_str().unwrap_or("accuracy-process-v1"),
      "strategyVersion":version,"strategySha256":hash_json(strategy),"strategy":strategy,
      "source":source,"sourceSha256":hash_json(source),"operationBudget":budget,
      "status":"ready","createdAt":timestamp,"updatedAt":timestamp,
      "budgetState":{"usedCalls":0,"usedInputTokens":0,"usedOutputTokens":0,"reservedInputTokens":0,
        "reservedOutputTokens":0,"inFlight":0,"roleCalls":{},"roleInFlight":{},
        "elapsedActiveMs":0,"activeSinceMs":null,"unknownUsageExecutions":[]},"progress":{}});
    tx.execute("INSERT INTO import_process_runs(id,import_id,creation_key,revision,payload,sha256) VALUES(?1,?2,?3,0,?4,?5)",
        params![run_id,import_id,key,run.to_string(),hash_json(&run)])?;
    tx.commit()?;
    Ok(run)
}
pub(crate) fn load_run(store: &Store, run_id: &str) -> AppResult<Value> {
    initialize(store)?;
    read_run(&store.user, run_id)
}
pub(crate) fn save_run(store: &Store, expected_revision: u64, run: &Value) -> AppResult<Value> {
    initialize(store)?;
    let tx = rusqlite::Transaction::new_unchecked(&store.user, TransactionBehavior::Immediate)?;
    let old = read_run(&tx, s(run, "id"))?;
    if n(&old, "revision") != expected_revision {
        return Err(problem("revision_conflict", "导入过程已更新，请重新读取。"));
    }
    for key in [
        "id",
        "runId",
        "importId",
        "schemaVersion",
        "pipelineVersion",
        "strategyVersion",
        "strategySha256",
        "strategy",
        "source",
        "sourceSha256",
        "operationBudget",
        "createdAt",
        "budgetState",
        "budgetError",
        "budgetResumptions",
    ] {
        if old[key] != run[key] {
            return Err(invalid("不能通过保存进度改变策略、来源或预算。"));
        }
    }
    if old["status"] == "budget_paused" && run["status"] != "budget_paused" {
        return Err(problem(
            "budget_paused",
            "预算已暂停，不能通过修改状态继续花费。",
        ));
    }
    let mut next = run.clone();
    // A persisted pause/completion boundary ends active wall accounting. Waiting
    // for the teacher or a later explicit continuation must not consume it.
    if next["status"] != "running" && n(&next["budgetState"], "inFlight") == 0 {
        let elapsed = active_ms(&next, millis());
        next["budgetState"]["elapsedActiveMs"] = json!(elapsed);
        next["budgetState"]["activeSinceMs"] = Value::Null;
    }
    let next = write_run(&tx, expected_revision, next)?;
    tx.commit()?;
    Ok(next)
}
pub(crate) fn list_runs_for_import(store: &Store, import_id: &str) -> AppResult<Vec<Value>> {
    initialize(store)?;
    id(import_id)?;
    let ids = store
        .user
        .prepare("SELECT id FROM import_process_runs WHERE import_id=?1 ORDER BY rowid DESC")?
        .query_map([import_id], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    ids.iter()
        .map(|id| {
            let run = read_run(&store.user, id)?;
            if run["importId"] != import_id {
                return Err(integrity());
            }
            Ok(run)
        })
        .collect()
}

pub(crate) fn put_artifact(
    store: &Store,
    run_id: &str,
    kind: &str,
    question_id: &str,
    inputs: &Value,
    payload: &Value,
) -> AppResult<Value> {
    initialize(store)?;
    id(kind)?;
    if !question_id.is_empty() {
        id(question_id)?;
    }
    let tx = rusqlite::Transaction::new_unchecked(&store.user, TransactionBehavior::Immediate)?;
    let run = read_run(&tx, run_id)?;
    let key = hash_json(
        &json!({"runId":run_id,"kind":kind,"questionId":question_id,"inputs":inputs,"payload":payload}),
    );
    if let Some(found) = tx
        .query_row(
            "SELECT payload,sha256 FROM import_process_artifacts WHERE content_key=?1",
            [&key],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?
    {
        let v = decode(found.0, found.1)?;
        tx.commit()?;
        return Ok(reference(&v));
    }
    let v = json!({"schemaVersion":1,"id":format!("accuracy-artifact-{}",uuid::Uuid::new_v4()),"revision":1,
      "importId":run["importId"],"runId":run_id,"kind":kind,"questionId":question_id,
      "strategySha256":run["strategySha256"],"inputs":inputs,"payload":payload,"createdAt":now()});
    let hash = hash_json(&v);
    tx.execute("INSERT INTO import_process_artifacts(id,run_id,kind,question_id,payload,sha256,content_key) VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![s(&v,"id"),run_id,kind,question_id,v.to_string(),hash,key])?;
    tx.commit()?;
    Ok(json!({"id":v["id"],"revision":1,"sha256":hash}))
}
fn reference(envelope: &Value) -> Value {
    json!({"id":envelope["id"],"revision":envelope["revision"],"sha256":hash_json(envelope)})
}
pub(crate) fn get_artifact(store: &Store, reference: &Value) -> AppResult<Value> {
    initialize(store)?;
    read_artifact(&store.user, reference)
}
fn read_artifact(db: &Connection, reference: &Value) -> AppResult<Value> {
    id(s(reference, "id"))?;
    let found = db
        .query_row(
            "SELECT payload,sha256 FROM import_process_artifacts WHERE id=?1",
            [s(reference, "id")],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?
        .ok_or_else(|| problem("not_found", "未找到候选或核验记录。"))?;
    let v = decode(found.0, found.1)?;
    if v["id"] != reference["id"]
        || v["revision"] != reference["revision"]
        || hash_json(&v) != s(reference, "sha256")
    {
        return Err(integrity());
    }
    Ok(v)
}
pub(crate) fn artifact_payload(store: &Store, reference: &Value) -> AppResult<Value> {
    Ok(get_artifact(store, reference)?["payload"].clone())
}
pub(crate) fn list_artifacts(
    store: &Store,
    run_id: &str,
    kind: Option<&str>,
    question_id: Option<&str>,
) -> AppResult<Vec<Value>> {
    initialize(store)?;
    read_run(&store.user, run_id)?;
    let mut stmt=store.user.prepare("SELECT payload,sha256 FROM import_process_artifacts WHERE run_id=?1 AND (?2 IS NULL OR kind=?2) AND (?3 IS NULL OR question_id=?3) ORDER BY rowid")?;
    let found = stmt
        .query_map(params![run_id, kind, question_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    found
        .into_iter()
        .map(|v| {
            let artifact = decode(v.0, v.1)?;
            if artifact["runId"] != run_id
                || kind.is_some_and(|value| artifact["kind"] != value)
                || question_id.is_some_and(|value| artifact["questionId"] != value)
            {
                return Err(integrity());
            }
            Ok(artifact)
        })
        .collect()
}

fn budget_chain(db: &Connection, run_id: &str) -> AppResult<Vec<Value>> {
    let mut out = vec![];
    let mut next = run_id.to_owned();
    let mut seen = HashSet::new();
    for _ in 0..16 {
        if !seen.insert(next.clone()) {
            return Err(integrity());
        }
        let run = read_run(db, &next)?;
        if out
            .first()
            .is_some_and(|first: &Value| first["importId"] != run["importId"])
        {
            return Err(integrity());
        }
        let parent = run["operationBudget"]["parentBudgetId"]
            .as_str()
            .map(str::to_owned);
        out.push(run);
        if let Some(parent) = parent {
            next = parent;
        } else {
            return Ok(out);
        }
    }
    Err(invalid("父预算层级过深。"))
}
fn active_ms(run: &Value, at: i64) -> u64 {
    n(&run["budgetState"], "elapsedActiveMs").saturating_add(
        run["budgetState"]["activeSinceMs"]
            .as_i64()
            .map(|start| at.saturating_sub(start).max(0) as u64)
            .unwrap_or(0),
    )
}
fn pause_run(run: &mut Value, code: &str, message: &str, at: i64) {
    let elapsed = active_ms(run, at);
    run["budgetState"]["elapsedActiveMs"] = json!(elapsed);
    run["budgetState"]["activeSinceMs"] = Value::Null;
    run["status"] = json!("budget_paused");
    if !matches!(
        s(&run["budgetError"], "code"),
        "budget_limit" | "usage_exceeded"
    ) {
        run["budgetError"] = json!({"code":code,"message":message});
    }
}
fn limit_reason(
    run: &Value,
    role: &str,
    input: u64,
    output: u64,
    timeout: u64,
    at: i64,
) -> AppResult<Option<&'static str>> {
    let p = &run["operationBudget"];
    let b = &run["budgetState"];
    if run["status"] == "budget_paused" {
        return Ok(Some("预算已暂停，需要明确调整或确认用量后继续。"));
    }
    if matches!(s(run, "status"), "completed" | "cancelled") {
        return Err(invalid("此运行已经结束，不能再次外呼。"));
    }
    if add(n(b, "usedCalls"), 1)? > n(p, "maxCalls") {
        return Ok(Some("已达到本次模型调用上限。"));
    }
    if let Some(cap) = p["roleCallCaps"][role].as_u64() {
        if add(b["roleCalls"][role].as_u64().unwrap_or(0), 1)? > cap {
            return Ok(Some("已达到该用途调用上限。"));
        }
    }
    if add(
        add(n(b, "usedInputTokens"), n(b, "reservedInputTokens"))?,
        input,
    )? > n(p, "maxInputTokens")
    {
        return Ok(Some("剩余输入额度不足以容纳本次实际请求。"));
    }
    if add(
        add(n(b, "usedOutputTokens"), n(b, "reservedOutputTokens"))?,
        output,
    )? > n(p, "maxOutputTokens")
    {
        return Ok(Some("剩余输出额度不足以容纳本次实际请求。"));
    }
    if active_ms(run, at).saturating_add(timeout.saturating_mul(1000))
        > n(p, "maxActiveWallSeconds").saturating_mul(1000)
    {
        return Ok(Some("剩余处理时间不足以容纳本次完整请求截止。"));
    }
    Ok(None)
}

pub(crate) fn reserve_execution(
    store: &Store,
    run_id: &str,
    role: &str,
    question_id: &str,
    request: &Value,
    input_tokens: u64,
    output_tokens: u64,
    timeout_seconds: u64,
) -> AppResult<Value> {
    initialize(store)?;
    reserve(
        &store.user,
        run_id,
        role,
        question_id,
        request,
        input_tokens,
        output_tokens,
        timeout_seconds,
    )
}
fn reserve(
    db: &Connection,
    run_id: &str,
    role: &str,
    question_id: &str,
    request: &Value,
    input: u64,
    output: u64,
    timeout: u64,
) -> AppResult<Value> {
    id(role)?;
    if !question_id.is_empty() {
        id(question_id)?;
    }
    if !request.is_object() || input == 0 || output == 0 || timeout == 0 {
        return Err(invalid("执行预算或实际请求无效。"));
    }
    let body = request.get("body").unwrap_or(request);
    if !body.is_object() {
        return Err(invalid("模型实际请求正文无效。"));
    }
    let mut output_limit_present = false;
    for key in ["max_tokens", "max_completion_tokens", "max_output_tokens"] {
        if let Some(limit) = body.get(key) {
            output_limit_present = true;
            let max = limit
                .as_u64()
                .filter(|limit| *limit > 0)
                .ok_or_else(|| invalid("模型实际请求缺少可靠的正数输出上限。"))?;
            if max > output {
                return Err(invalid("输出预留小于最终实际请求额度，未发送请求。"));
            }
        }
    }
    if !output_limit_present {
        return Err(invalid("模型实际请求缺少可靠的输出上限，未发送请求。"));
    }
    let tx = rusqlite::Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
    let mut chain = budget_chain(&tx, run_id)?;
    let at = millis();
    let mut reason = None;
    for run in &chain {
        if let Some(message) = limit_reason(run, role, input, output, timeout, at)? {
            let code = if run["status"] == "budget_paused" {
                run["budgetError"]["code"]
                    .as_str()
                    .unwrap_or("budget_limit")
            } else {
                "budget_limit"
            };
            reason = Some((message, code.to_owned()));
            break;
        }
    }
    if let Some((message, code)) = reason {
        for mut parent in chain {
            let rev = n(&parent, "revision");
            pause_run(&mut parent, &code, message, at);
            write_run(&tx, rev, parent)?;
        }
        tx.commit()?;
        return Err(problem("budget_paused", message));
    }
    let global_running: i64 = tx.query_row(
        "SELECT COUNT(*) FROM import_process_executions WHERE status='running'",
        [],
        |r| r.get(0),
    )?;
    let global_role: i64 = tx.query_row(
        "SELECT COUNT(*) FROM import_process_executions WHERE status='running' AND role=?1",
        [role],
        |r| r.get(0),
    )?;
    for run in &chain {
        let p = &run["operationBudget"];
        let cap = p["roleInFlightCaps"][role]
            .as_u64()
            .unwrap_or(n(p, "maxRoleInFlight"));
        if global_running as u64 >= n(p, "maxInFlight") || global_role as u64 >= cap {
            return Err(problem(
                "accuracy_busy",
                "模型任务正在执行，请等待在途请求完成后继续调度。",
            ));
        }
    }
    let execution = json!({"schemaVersion":1,"id":format!("accuracy-execution-{}",uuid::Uuid::new_v4()),
        "runId":run_id,"importId":chain[0]["importId"],"budgetRunIds":chain.iter().map(|r|r["id"].clone()).collect::<Vec<_>>(),
        "role":role,"questionId":question_id,"status":"running","requestSha256":hash_json(body),
        "requestEnvelopeSha256":hash_json(request),"request":request,"reservedInputTokens":input,
        "reservedOutputTokens":output,"timeoutSeconds":timeout,"startedAt":now(),"startedAtMs":at,
        "deadlineMs":at.saturating_add(timeout.saturating_mul(1000).min(i64::MAX as u64) as i64)});
    tx.execute("INSERT INTO import_process_executions(id,run_id,role,question_id,status,payload,sha256) VALUES(?1,?2,?3,?4,'running',?5,?6)",
        params![s(&execution,"id"),run_id,role,question_id,execution.to_string(),hash_json(&execution)])?;
    for run in &mut chain {
        let rev = n(run, "revision");
        let b = &mut run["budgetState"];
        b["usedCalls"] = json!(add(n(b, "usedCalls"), 1)?);
        b["reservedInputTokens"] = json!(add(n(b, "reservedInputTokens"), input)?);
        b["reservedOutputTokens"] = json!(add(n(b, "reservedOutputTokens"), output)?);
        b["inFlight"] = json!(add(n(b, "inFlight"), 1)?);
        b["roleCalls"][role] = json!(add(b["roleCalls"][role].as_u64().unwrap_or(0), 1)?);
        b["roleInFlight"][role] = json!(add(b["roleInFlight"][role].as_u64().unwrap_or(0), 1)?);
        if b["activeSinceMs"].is_null() {
            b["activeSinceMs"] = json!(at);
        }
        run["status"] = json!("running");
        write_run(&tx, rev, run.clone())?;
    }
    tx.commit()?;
    Ok(execution)
}

fn read_execution(db: &Connection, execution_id: &str) -> AppResult<Value> {
    id(execution_id)?;
    let row = db
        .query_row(
            "SELECT payload,sha256,status FROM import_process_executions WHERE id=?1",
            [execution_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| problem("not_found", "未找到模型执行记录。"))?;
    let value = decode(row.0, row.1)?;
    let body = value["request"].get("body").unwrap_or(&value["request"]);
    if s(&value, "id") != execution_id
        || s(&value, "status") != row.2
        || hash_json(body) != s(&value, "requestSha256")
        || hash_json(&value["request"]) != s(&value, "requestEnvelopeSha256")
    {
        return Err(integrity());
    }
    Ok(value)
}
pub(crate) fn load_execution(store: &Store, execution_id: &str) -> AppResult<Value> {
    initialize(store)?;
    read_execution(&store.user, execution_id)
}
pub(crate) fn list_executions(store: &Store, run_id: &str) -> AppResult<Vec<Value>> {
    initialize(store)?;
    read_run(&store.user, run_id)?;
    let ids = store
        .user
        .prepare("SELECT id FROM import_process_executions WHERE run_id=?1 ORDER BY rowid")?
        .query_map([run_id], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    ids.iter()
        .map(|id| read_execution(&store.user, id))
        .collect()
}
/// Local recovery retains the full reservation for unfinished HTTP work.
pub(crate) fn interrupt_run(store: &Store, run_id: &str) -> AppResult<()> {
    for execution in list_executions(store, run_id)? {
        if execution["status"] == "running" {
            finish_execution(
                store,
                s(&execution, "id"),
                "interrupted",
                &Value::Null,
                &json!({"code":"import_interrupted","message":"处理因退出或中断而结束，实际用量未知，保留原预留额度。"}),
            )?;
        }
    }
    let tx = rusqlite::Transaction::new_unchecked(&store.user, TransactionBehavior::Immediate)?;
    let at = millis();
    for mut run in budget_chain(&tx, run_id)? {
        // Another child may still be running on the shared parent budget.
        if n(&run["budgetState"], "inFlight") != 0 {
            continue;
        }
        let revision = n(&run, "revision");
        let elapsed = active_ms(&run, at);
        run["budgetState"]["elapsedActiveMs"] = json!(elapsed);
        run["budgetState"]["activeSinceMs"] = Value::Null;
        if !matches!(
            s(&run, "status"),
            "budget_paused" | "completed" | "cancelled"
        ) {
            run["status"] = json!("paused");
        }
        write_run(&tx, revision, run)?;
    }
    tx.commit()?;
    Ok(())
}
/// Finish an operation's active wall interval across its inherited budget.
/// Other live children keep their parent's clock, and no usage is reconciled.
pub(crate) fn pause_parent_clocks(store: &Store, run_id: &str) -> AppResult<()> {
    initialize(store)?;
    let tx = rusqlite::Transaction::new_unchecked(&store.user, TransactionBehavior::Immediate)?;
    let at = millis();
    for mut run in budget_chain(&tx, run_id)? {
        if n(&run["budgetState"], "inFlight") != 0 {
            continue;
        }
        if run["budgetState"]["activeSinceMs"].is_null() && run["status"] != "running" {
            continue;
        }
        let revision = n(&run, "revision");
        let elapsed = active_ms(&run, at);
        run["budgetState"]["elapsedActiveMs"] = json!(elapsed);
        run["budgetState"]["activeSinceMs"] = Value::Null;
        if run["status"] == "running" {
            run["status"] = json!("paused");
        }
        write_run(&tx, revision, run)?;
    }
    tx.commit()?;
    Ok(())
}
/// Explicit continuation accepts the retained worst-case cost of unknown usage.
/// It never increases a limit or clears a counter or reservation.
pub(crate) fn resume_run(store: &Store, run_id: &str) -> AppResult<Value> {
    initialize(store)?;
    let tx = rusqlite::Transaction::new_unchecked(&store.user, TransactionBehavior::Immediate)?;
    let chain = budget_chain(&tx, run_id)?;
    if chain[0]["status"] == "running"
        || chain.iter().any(|r| n(&r["budgetState"], "inFlight") != 0)
    {
        return Err(problem(
            "accuracy_busy",
            "原请求尚未结束，不能再次继续或重置预留。",
        ));
    }
    if matches!(s(&chain[0], "status"), "completed" | "cancelled") {
        return Err(invalid("已结束的运行不能通过继续操作重新开启。"));
    }
    for run in &chain {
        let code = s(&run["budgetError"], "code");
        if matches!(code, "budget_limit" | "usage_exceeded")
            || run["status"] == "budget_paused" && code != "usage_unknown"
        {
            return Err(problem(
                "budget_paused",
                "实际预算上限已耗尽，继续不能增加或重置原预算。",
            ));
        }
    }
    let mut result = Value::Null;
    for mut run in chain {
        let revision = n(&run, "revision");
        let mut resumptions = run["budgetResumptions"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        resumptions.push(json!({"at":now(),"reason":"explicit_continue","previousStatus":run["status"],
            "previousBudgetError":run["budgetError"],"retainedInputTokens":run["budgetState"]["reservedInputTokens"],
            "retainedOutputTokens":run["budgetState"]["reservedOutputTokens"],"usedCalls":run["budgetState"]["usedCalls"]}));
        run["budgetResumptions"] = json!(resumptions);
        run["status"] = json!("ready");
        let saved = write_run(&tx, revision, run)?;
        if s(&saved, "id") == run_id {
            result = saved;
        }
    }
    tx.commit()?;
    Ok(result)
}
fn usage_number(usage: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter().find_map(|key| usage[*key].as_u64())
}
fn continues_with_unknown_usage(run: &Value) -> bool {
    run["strategy"]["unknownUsagePolicy"] == "retain-reservation-continue-other-questions-v1"
}
fn check_continuation_chain(chain: &[Value]) -> AppResult<()> {
    for run in chain {
        let state = &run["budgetState"];
        let budget = &run["operationBudget"];
        if n(state, "inFlight") != 0 {
            return Err(problem("accuracy_busy", "原请求尚在途，不能切换策略继续。"));
        }
        let code = s(&run["budgetError"], "code");
        if matches!(code, "budget_limit" | "usage_exceeded")
            || run["status"] == "budget_paused" && code != "usage_unknown"
            || n(state, "usedCalls") >= n(budget, "maxCalls")
            || add(n(state, "usedInputTokens"), n(state, "reservedInputTokens"))?
                >= n(budget, "maxInputTokens")
            || add(
                n(state, "usedOutputTokens"),
                n(state, "reservedOutputTokens"),
            )? >= n(budget, "maxOutputTokens")
            || active_ms(run, millis()) >= n(budget, "maxActiveWallSeconds").saturating_mul(1000)
        {
            return Err(problem(
                "budget_paused",
                "真实预算上限已达到，策略修订不能增加或重置已用及预留额度。",
            ));
        }
    }
    Ok(())
}
/// Read-only admission before creating or persisting a strategy continuation.
pub(crate) fn check_strategy_continuation_budget(store: &Store, run_id: &str) -> AppResult<()> {
    initialize(store)?;
    check_continuation_chain(&budget_chain(&store.user, run_id)?)
}
/// Resume only unknown-usage pauses, after the exact acknowledged queue record
/// was saved. The owning new strategy authorizes this; no credit is released.
pub(crate) fn resume_unknown_strategy_chain(
    store: &Store,
    run_id: &str,
    expected_record: &Value,
) -> AppResult<()> {
    initialize(store)?;
    let tx = rusqlite::Transaction::new_unchecked(&store.user, TransactionBehavior::Immediate)?;
    let chain = budget_chain(&tx, run_id)?;
    if !continues_with_unknown_usage(&chain[0]) {
        return Err(invalid("冻结策略没有授权保留未知用量后继续其它题目。"));
    }
    let persisted: String = tx.query_row(
        "SELECT payload FROM documents WHERE kind='imports' AND id=?1",
        [s(&chain[0], "importId")],
        |r| r.get(0),
    )?;
    let current: Value = serde_json::from_str(&persisted)?;
    if current != *expected_record || current["accuracyRunId"] != run_id {
        return Err(problem(
            "revision_conflict",
            "策略接受记录已变化，未恢复父预算状态。",
        ));
    }
    let job = &current["backgroundJob"];
    if job["strategyContinuation"] != true
        || job["payload"]["acknowledge"] != true
        || hash_json(&job["payload"]) != job["payloadHash"]
    {
        return Err(invalid("策略继续缺少已保存的明确确认请求。"));
    }
    check_continuation_chain(&chain)?;
    for mut run in chain {
        if run["status"] != "budget_paused" || run["budgetError"]["code"] != "usage_unknown" {
            continue;
        }
        let revision = n(&run, "revision");
        let mut resumptions = run["budgetResumptions"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        resumptions.push(json!({"at":now(),"reason":"explicit_strategy_continue","operationId":job["operationId"],
            "authorizedRunId":run_id,"previousBudgetError":run["budgetError"],"retainedInputTokens":run["budgetState"]["reservedInputTokens"],
            "retainedOutputTokens":run["budgetState"]["reservedOutputTokens"],"usedCalls":run["budgetState"]["usedCalls"]}));
        run["budgetResumptions"] = json!(resumptions);
        run["status"] = json!("ready");
        write_run(&tx, revision, run)?;
    }
    tx.commit()?;
    Ok(())
}
pub(crate) fn finish_execution(
    store: &Store,
    execution_id: &str,
    status: &str,
    usage: &Value,
    error: &Value,
) -> AppResult<()> {
    initialize(store)?;
    finish(&store.user, execution_id, status, usage, error)
}
fn finish(
    db: &Connection,
    execution_id: &str,
    status: &str,
    usage: &Value,
    error: &Value,
) -> AppResult<()> {
    let status = if status == "succeeded" {
        "completed"
    } else {
        status
    };
    if !matches!(status, "completed" | "failed" | "cancelled" | "interrupted") {
        return Err(invalid("模型结束状态无效。"));
    }
    let tx = rusqlite::Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
    let mut execution = read_execution(&tx, execution_id)?;
    if execution["status"] != "running" {
        if execution["status"] == status
            && execution["usage"] == *usage
            && execution["error"] == *error
        {
            return Ok(());
        }
        return Err(problem(
            "execution_conflict",
            "执行已结束，不能覆盖原始结果或用量。",
        ));
    }
    let input = usage_number(usage, &["inputTokens", "prompt_tokens", "input_tokens"]);
    let output = usage_number(
        usage,
        &["outputTokens", "completion_tokens", "output_tokens"],
    );
    let at = millis();
    // The execution owner's immutable policy governs every charged ancestor.
    // An older parent must not re-pause a v3 child's conservatively held cost.
    let owner = read_run(&tx, s(&execution, "runId"))?;
    let retain_and_continue = continues_with_unknown_usage(&owner);
    let role = s(&execution, "role").to_owned();
    let budget_ids = execution["budgetRunIds"]
        .as_array()
        .ok_or_else(integrity)?
        .clone();
    for value in budget_ids {
        let mut run = read_run(&tx, value.as_str().ok_or_else(integrity)?)?;
        let rev = n(&run, "revision");
        let b = &mut run["budgetState"];
        b["inFlight"] = json!(n(b, "inFlight").checked_sub(1).ok_or_else(integrity)?);
        b["roleInFlight"][&role] = json!(
            b["roleInFlight"][&role]
                .as_u64()
                .unwrap_or(0)
                .checked_sub(1)
                .ok_or_else(integrity)?
        );
        for (used, reserved, amount, estimate) in [
            (
                "usedInputTokens",
                "reservedInputTokens",
                input,
                n(&execution, "reservedInputTokens"),
            ),
            (
                "usedOutputTokens",
                "reservedOutputTokens",
                output,
                n(&execution, "reservedOutputTokens"),
            ),
        ] {
            if let Some(actual) = amount {
                b[reserved] = json!(n(b, reserved).checked_sub(estimate).ok_or_else(integrity)?);
                b[used] = json!(add(n(b, used), actual)?);
            }
        }
        if input.is_none() || output.is_none() {
            let unknown = b["unknownUsageExecutions"]
                .as_array_mut()
                .ok_or_else(integrity)?;
            unknown.push(json!(execution_id));
            if !retain_and_continue {
                pause_run(
                    &mut run,
                    "usage_unknown",
                    "模型用量尚不明确，已保留预留额度，请核对后继续。",
                    at,
                );
            }
        }
        if add(
            n(&run["budgetState"], "usedInputTokens"),
            n(&run["budgetState"], "reservedInputTokens"),
        )? > n(&run["operationBudget"], "maxInputTokens")
            || add(
                n(&run["budgetState"], "usedOutputTokens"),
                n(&run["budgetState"], "reservedOutputTokens"),
            )? > n(&run["operationBudget"], "maxOutputTokens")
        {
            pause_run(
                &mut run,
                "usage_exceeded",
                "实际模型用量超过本次上限，已停止后续请求。",
                at,
            );
        }
        write_run(&tx, rev, run)?;
    }
    execution["status"] = json!(status);
    execution["usage"] = usage.clone();
    execution["error"] = error.clone();
    execution["usageKnown"] = json!(input.is_some() && output.is_some());
    execution["unknownUsagePolicy"] = owner["strategy"]["unknownUsagePolicy"].clone();
    execution["finishedAt"] = json!(now());
    tx.execute("UPDATE import_process_executions SET status=?1,payload=?2,sha256=?3 WHERE id=?4 AND status='running'",
        params![status,execution.to_string(),hash_json(&execution),execution_id])?;
    tx.commit()?;
    Ok(())
}

fn open_personal(data_dir: &Path) -> AppResult<Connection> {
    let path = data_dir.join("personal.sqlite");
    if !path.is_file() {
        return Err(problem(
            "not_found",
            "未找到当前本机个人数据库，未创建替代数据库。",
        ));
    }
    let db = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    db.busy_timeout(Duration::from_secs(5))?;
    schema(&db)?;
    Ok(db)
}
pub(crate) fn reserve_execution_at(
    data_dir: &Path,
    run_id: &str,
    role: &str,
    question_id: &str,
    request: &Value,
    input_tokens: u64,
    output_tokens: u64,
    timeout_seconds: u64,
) -> AppResult<Value> {
    reserve(
        &open_personal(data_dir)?,
        run_id,
        role,
        question_id,
        request,
        input_tokens,
        output_tokens,
        timeout_seconds,
    )
}
pub(crate) fn finish_execution_at(
    data_dir: &Path,
    execution_id: &str,
    status: &str,
    usage: &Value,
    error: &Value,
) -> AppResult<()> {
    finish(
        &open_personal(data_dir)?,
        execution_id,
        status,
        usage,
        error,
    )
}

pub(crate) fn save_finalization(
    store: &Store,
    run_id: &str,
    operation_id: &str,
    manifest: &Value,
) -> AppResult<Value> {
    initialize(store)?;
    id(operation_id)?;
    if !manifest.is_object() {
        return Err(invalid("定稿清单必须为对象。"));
    }
    let tx = rusqlite::Transaction::new_unchecked(&store.user, TransactionBehavior::Immediate)?;
    let run = read_run(&tx, run_id)?;
    if let Some(row) = tx
        .query_row(
            "SELECT payload,sha256 FROM import_finalizations WHERE operation_id=?1",
            [operation_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?
    {
        let v = decode(row.0, row.1)?;
        if v["runId"] != run_id || v["manifest"] != *manifest {
            return Err(problem(
                "operation_conflict",
                "定稿操作身份已用于不同内容。",
            ));
        }
        tx.commit()?;
        return Ok(reference(&v));
    }
    let v = json!({"schemaVersion":1,"id":format!("accuracy-finalization-{}",uuid::Uuid::new_v4()),"revision":1,
        "runId":run_id,"importId":run["importId"],"operationId":operation_id,"strategySha256":run["strategySha256"],
        "manifest":manifest,"manifestSha256":hash_json(manifest),"createdAt":now()});
    let hash = hash_json(&v);
    tx.execute("INSERT INTO import_finalizations(id,run_id,operation_id,payload,sha256) VALUES(?1,?2,?3,?4,?5)",
        params![s(&v,"id"),run_id,operation_id,v.to_string(),hash])?;
    tx.commit()?;
    Ok(json!({"id":v["id"],"revision":1,"sha256":hash}))
}
pub(crate) fn load_finalization(store: &Store, reference: &Value) -> AppResult<Value> {
    initialize(store)?;
    id(s(reference, "id"))?;
    let row = store
        .user
        .query_row(
            "SELECT payload,sha256 FROM import_finalizations WHERE id=?1",
            [s(reference, "id")],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?
        .ok_or_else(|| problem("not_found", "未找到定稿清单。"))?;
    let v = decode(row.0, row.1)?;
    if v["id"] != reference["id"]
        || v["revision"] != reference["revision"]
        || hash_json(&v) != s(reference, "sha256")
        || hash_json(&v["manifest"]) != s(&v, "manifestSha256")
    {
        return Err(integrity());
    }
    Ok(v)
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
