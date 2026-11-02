use super::*;
use std::sync::{Arc, Barrier};

fn fixture() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path(), &crate::bank::tests::seed()).unwrap();
    initialize(&store).unwrap();
    (dir, store)
}
fn run(store: &Store, budget: Value) -> Value {
    create_run(store,"simulated-accuracy-import",
        &json!({"pipelineVersion":"simulated-v1","version":"simulated-strategy-v1","stageGraph":["math"]}),
        &json!({"sha256":"a".repeat(64)}),&budget).unwrap()
}
fn request() -> Value {
    json!({"model":"simulated-only-model","messages":[],"max_tokens":20})
}
fn known() -> Value {
    json!({"prompt_tokens":4,"completion_tokens":6})
}

#[test]
fn run_replay_keeps_strategy_budget_and_cas_cannot_rewrite_them() {
    let (_dir, store) = fixture();
    let first = run(&store, json!({"maxCalls":2}));
    let repeated = run(&store, json!({"maxCalls":2}));
    assert_eq!(first, repeated);
    let execution =
        reserve_execution(&store, s(&first, "id"), "math", "q1", &request(), 10, 20, 1).unwrap();
    finish_execution(
        &store,
        s(&execution, "id"),
        "completed",
        &known(),
        &Value::Null,
    )
    .unwrap();
    let current = load_run(&store, s(&first, "id")).unwrap();
    let mut forged = current.clone();
    forged["strategy"]["stageGraph"] = json!(["skip"]);
    assert_eq!(
        save_run(&store, n(&current, "revision"), &forged)
            .unwrap_err()
            .code,
        "invalid_accuracy_process"
    );
    let mut forged = current.clone();
    forged["operationBudget"]["maxCalls"] = json!(999);
    assert!(save_run(&store, n(&current, "revision"), &forged).is_err());
    let mut progress = current.clone();
    progress["progress"] = json!({"question":"q1","stage":"math"});
    let saved = save_run(&store, n(&current, "revision"), &progress).unwrap();
    assert_eq!(saved["budgetState"]["usedCalls"], 1);
    assert_eq!(
        save_run(&store, n(&current, "revision"), &progress)
            .unwrap_err()
            .code,
        "revision_conflict"
    );
    assert_eq!(
        run(&store, json!({"maxCalls":2}))["budgetState"]["usedCalls"],
        1
    );
}

#[test]
fn artifacts_and_finalizations_are_immutable_and_hash_bound() {
    let (_dir, store) = fixture();
    let run = run(&store, json!({}));
    let reference = put_artifact(
        &store,
        s(&run, "id"),
        "independent_solve",
        "q1",
        &json!({"source":"simulated"}),
        &json!({"answer":"2"}),
    )
    .unwrap();
    assert_eq!(artifact_payload(&store, &reference).unwrap()["answer"], "2");
    assert_eq!(
        put_artifact(
            &store,
            s(&run, "id"),
            "independent_solve",
            "q1",
            &json!({"source":"simulated"}),
            &json!({"answer":"2"})
        )
        .unwrap(),
        reference
    );
    assert_eq!(
        list_artifacts(&store, s(&run, "id"), Some("independent_solve"), Some("q1"))
            .unwrap()
            .len(),
        1
    );
    assert!(
        store
            .user
            .execute(
                "UPDATE import_process_artifacts SET payload='{}' WHERE id=?1",
                [s(&reference, "id")]
            )
            .is_err()
    );
    assert!(
        store
            .user
            .execute(
                "DELETE FROM import_process_artifacts WHERE id=?1",
                [s(&reference, "id")]
            )
            .is_err()
    );
    let mut bad = reference.clone();
    bad["sha256"] = json!("0".repeat(64));
    assert_eq!(
        get_artifact(&store, &bad).unwrap_err().code,
        "accuracy_integrity"
    );
    let manifest = json!({"questionId":"q1","selectedRefs":{"solution":reference}});
    let final_ref =
        save_finalization(&store, s(&run, "id"), "simulated-final-op", &manifest).unwrap();
    assert_eq!(
        load_finalization(&store, &final_ref).unwrap()["manifest"],
        manifest
    );
    assert_eq!(
        save_finalization(&store, s(&run, "id"), "simulated-final-op", &manifest).unwrap(),
        final_ref
    );
    assert_eq!(
        save_finalization(
            &store,
            s(&run, "id"),
            "simulated-final-op",
            &json!({"different":true})
        )
        .unwrap_err()
        .code,
        "operation_conflict"
    );
    assert!(
        store
            .user
            .execute("DELETE FROM import_finalizations", [])
            .is_err()
    );
}

#[test]
fn missing_usage_keeps_reservation_and_pauses_without_free_calls() {
    let (_dir, store) = fixture();
    let run = run(&store, json!({"maxCalls":3}));
    let execution =
        reserve_execution(&store, s(&run, "id"), "math", "q1", &request(), 10, 20, 1).unwrap();
    finish_execution(
        &store,
        s(&execution, "id"),
        "failed",
        &Value::Null,
        &json!({"code":"simulated_disconnect"}),
    )
    .unwrap();
    let after = load_run(&store, s(&run, "id")).unwrap();
    assert_eq!(after["status"], "budget_paused");
    assert_eq!(after["budgetState"]["reservedInputTokens"], 10);
    assert_eq!(after["budgetState"]["reservedOutputTokens"], 20);
    assert_eq!(after["budgetState"]["usedCalls"], 1);
    assert_eq!(after["budgetState"]["inFlight"], 0);
    assert_eq!(
        reserve_execution(&store, s(&run, "id"), "math", "q2", &request(), 10, 20, 1)
            .unwrap_err()
            .code,
        "budget_paused"
    );
    assert_eq!(
        load_run(&store, s(&run, "id")).unwrap()["budgetError"]["code"],
        "usage_unknown"
    );
    finish_execution(
        &store,
        s(&execution, "id"),
        "failed",
        &Value::Null,
        &json!({"code":"simulated_disconnect"}),
    )
    .unwrap();
    assert_eq!(
        finish_execution(
            &store,
            s(&execution, "id"),
            "completed",
            &known(),
            &Value::Null
        )
        .unwrap_err()
        .code,
        "execution_conflict"
    );
}

#[test]
fn final_request_limit_is_reserved_and_parent_budget_survives_new_strategy() {
    let (_dir, store) = fixture();
    let parent = run(&store, json!({"maxCalls":1}));
    assert_eq!(
        reserve_execution(
            &store,
            s(&parent, "id"),
            "math",
            "q1",
            &json!({"max_tokens":65536}),
            10,
            16000,
            1
        )
        .unwrap_err()
        .code,
        "invalid_accuracy_process"
    );
    assert_eq!(
        create_run(
            &store,
            "simulated-accuracy-import",
            &json!({"version":"simulated-strategy-v2"}),
            &json!({"sha256":"a".repeat(64)}),
            &json!({"maxCalls":50})
        )
        .unwrap_err()
        .code,
        "invalid_accuracy_process"
    );
    let child = create_run(
        &store,
        "simulated-accuracy-import",
        &json!({"version":"simulated-strategy-v2"}),
        &json!({"sha256":"a".repeat(64)}),
        &json!({"parentBudgetId":parent["id"],"maxCalls":50}),
    )
    .unwrap();
    let call =
        reserve_execution(&store, s(&child, "id"), "math", "q1", &request(), 10, 20, 1).unwrap();
    finish_execution(&store, s(&call, "id"), "completed", &known(), &Value::Null).unwrap();
    assert_eq!(
        load_run(&store, s(&child, "id")).unwrap()["budgetState"]["usedCalls"],
        1
    );
    assert_eq!(
        load_run(&store, s(&parent, "id")).unwrap()["budgetState"]["usedCalls"],
        1
    );
    assert_eq!(
        reserve_execution(&store, s(&child, "id"), "math", "q2", &request(), 10, 20, 1)
            .unwrap_err()
            .code,
        "budget_paused"
    );
}

#[test]
fn independent_connections_atomically_reserve_one_remaining_call() {
    let (dir, store) = fixture();
    let run = run(&store, json!({"maxCalls":1,"maxInFlight":3}));
    let path = dir.path().to_owned();
    let run_id = s(&run, "id").to_owned();
    let barrier = Arc::new(Barrier::new(3));
    let handles = (0..2)
        .map(|i| {
            let path = path.clone();
            let run_id = run_id.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                reserve_execution_at(
                    &path,
                    &run_id,
                    "math",
                    &format!("q{i}"),
                    &request(),
                    10,
                    20,
                    1,
                )
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let outcomes = handles
        .into_iter()
        .map(|h| h.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(outcomes.iter().filter(|v| v.is_ok()).count(), 1);
    assert_eq!(
        outcomes
            .iter()
            .filter(|v| v.as_ref().is_err_and(|e| e.code == "budget_paused"))
            .count(),
        1
    );
    let saved = load_run(&store, &run_id).unwrap();
    assert_eq!(saved["budgetState"]["usedCalls"], 1);
    assert_eq!(saved["budgetState"]["reservedOutputTokens"], 20);
}

#[test]
fn stale_or_tampered_run_and_request_are_detected_without_bank_writes() {
    let (_dir, store) = fixture();
    let run = run(&store, json!({"maxCalls":2}));
    let before = store
        .bank
        .annotation_connection()
        .query_row("SELECT COUNT(*) FROM bank_questions", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap();
    let call =
        reserve_execution(&store, s(&run, "id"), "math", "q1", &request(), 10, 20, 1).unwrap();
    store
        .user
        .execute(
            "UPDATE import_process_executions SET payload='{}' WHERE id=?1",
            [s(&call, "id")],
        )
        .unwrap();
    assert_eq!(
        load_execution(&store, s(&call, "id")).unwrap_err().code,
        "accuracy_integrity"
    );
    store
        .user
        .execute(
            "UPDATE import_process_runs SET payload='{}' WHERE id=?1",
            [s(&run, "id")],
        )
        .unwrap();
    assert_eq!(
        load_run(&store, s(&run, "id")).unwrap_err().code,
        "accuracy_integrity"
    );
    assert_eq!(
        before,
        store
            .bank
            .annotation_connection()
            .query_row("SELECT COUNT(*) FROM bank_questions", [], |r| r
                .get::<_, i64>(0))
            .unwrap()
    );
}

#[test]
fn role_and_in_flight_limits_reserve_no_extra_calls() {
    let (_dir, store) = fixture();
    let run = run(
        &store,
        json!({"maxCalls":5,"maxInFlight":1,"roleCallCaps":{"math":1}}),
    );
    let first =
        reserve_execution(&store, s(&run, "id"), "math", "q1", &request(), 10, 20, 1).unwrap();
    assert_eq!(
        reserve_execution(
            &store,
            s(&run, "id"),
            "teaching",
            "q2",
            &request(),
            10,
            20,
            1
        )
        .unwrap_err()
        .code,
        "accuracy_busy"
    );
    assert_eq!(
        load_run(&store, s(&run, "id")).unwrap()["budgetState"]["usedCalls"],
        1
    );
    finish_execution(&store, s(&first, "id"), "completed", &known(), &Value::Null).unwrap();
    assert_eq!(
        reserve_execution(&store, s(&run, "id"), "math", "q2", &request(), 10, 20, 1)
            .unwrap_err()
            .code,
        "budget_paused"
    );
    assert_eq!(list_executions(&store, s(&run, "id")).unwrap().len(), 1);
}

#[test]
fn insufficient_whole_request_deadline_pauses_before_execution() {
    let (_dir, store) = fixture();
    let run = run(&store, json!({"maxActiveWallSeconds":1}));
    assert_eq!(
        reserve_execution(&store, s(&run, "id"), "math", "q1", &request(), 10, 20, 2)
            .unwrap_err()
            .code,
        "budget_paused"
    );
    let saved = load_run(&store, s(&run, "id")).unwrap();
    assert_eq!(saved["budgetState"]["usedCalls"], 0);
    assert!(list_executions(&store, s(&run, "id")).unwrap().is_empty());
}

#[test]
fn explicit_pause_snapshots_active_time_and_keeps_prior_usage() {
    let (_dir, store) = fixture();
    let run = run(&store, json!({}));
    let execution =
        reserve_execution(&store, s(&run, "id"), "math", "q1", &request(), 10, 20, 1).unwrap();
    finish_execution(
        &store,
        s(&execution, "id"),
        "completed",
        &known(),
        &Value::Null,
    )
    .unwrap();
    let mut current = load_run(&store, s(&run, "id")).unwrap();
    current["status"] = json!("paused");
    let paused = save_run(&store, n(&current, "revision"), &current).unwrap();
    assert!(paused["budgetState"]["activeSinceMs"].is_null());
    assert_eq!(paused["budgetState"]["usedCalls"], 1);
    let next =
        reserve_execution(&store, s(&run, "id"), "math", "q2", &request(), 10, 20, 1).unwrap();
    assert_ne!(next["id"], execution["id"]);
    assert_eq!(
        load_run(&store, s(&run, "id")).unwrap()["budgetState"]["usedCalls"],
        2
    );
}

#[test]
fn interruption_and_explicit_resume_retain_unknown_reservations_and_actual_limits() {
    let (_dir, store) = fixture();
    let run = run(
        &store,
        json!({"maxCalls":2,"maxInputTokens":20,"maxOutputTokens":40}),
    );
    let execution =
        reserve_execution(&store, s(&run, "id"), "math", "q1", &request(), 10, 20, 1).unwrap();
    assert_eq!(
        resume_run(&store, s(&run, "id")).unwrap_err().code,
        "accuracy_busy"
    );
    interrupt_run(&store, s(&run, "id")).unwrap();
    let stopped = load_run(&store, s(&run, "id")).unwrap();
    assert_eq!(stopped["status"], "budget_paused");
    assert!(stopped["budgetState"]["activeSinceMs"].is_null());
    assert_eq!(
        load_execution(&store, s(&execution, "id")).unwrap()["status"],
        "interrupted"
    );
    let resumed = resume_run(&store, s(&run, "id")).unwrap();
    assert_eq!(resumed["status"], "ready");
    assert_eq!(resumed["budgetState"], stopped["budgetState"]);
    assert_eq!(resumed["budgetResumptions"].as_array().unwrap().len(), 1);
    let second =
        reserve_execution(&store, s(&run, "id"), "math", "q2", &request(), 10, 20, 1).unwrap();
    finish_execution(
        &store,
        s(&second, "id"),
        "completed",
        &known(),
        &Value::Null,
    )
    .unwrap();
    assert_eq!(
        reserve_execution(&store, s(&run, "id"), "math", "q3", &request(), 10, 20, 1)
            .unwrap_err()
            .code,
        "budget_paused"
    );
    assert_eq!(
        resume_run(&store, s(&run, "id")).unwrap_err().code,
        "budget_paused"
    );
    let final_run = load_run(&store, s(&run, "id")).unwrap();
    assert_eq!(final_run["budgetState"]["usedCalls"], 2);
    assert_eq!(final_run["budgetState"]["reservedInputTokens"], 10);
    assert_eq!(final_run["budgetState"]["reservedOutputTokens"], 20);
    let mut forged = final_run.clone();
    forged["budgetError"]["code"] = json!("usage_unknown");
    assert!(save_run(&store, n(&forged, "revision"), &forged).is_err());
}

#[test]
fn inherited_clocks_stop_only_after_in_flight_work_and_keep_all_used_quota() {
    let (_dir, store) = fixture();
    let parent = run(&store, json!({}));
    let child = create_run(
        &store,
        "simulated-accuracy-import",
        &json!({"version":"simulated-clock-child"}),
        &json!({"sha256":"a".repeat(64)}),
        &json!({"parentBudgetId":parent["id"]}),
    )
    .unwrap();
    let execution =
        reserve_execution(&store, s(&child, "id"), "math", "q1", &request(), 10, 20, 1).unwrap();
    let live_child = load_run(&store, s(&child, "id")).unwrap();
    let live_parent = load_run(&store, s(&parent, "id")).unwrap();
    pause_parent_clocks(&store, s(&child, "id")).unwrap();
    assert_eq!(load_run(&store, s(&child, "id")).unwrap(), live_child);
    assert_eq!(load_run(&store, s(&parent, "id")).unwrap(), live_parent);
    finish_execution(
        &store,
        s(&execution, "id"),
        "completed",
        &known(),
        &Value::Null,
    )
    .unwrap();
    pause_parent_clocks(&store, s(&child, "id")).unwrap();
    for id in [s(&child, "id"), s(&parent, "id")] {
        let paused = load_run(&store, id).unwrap();
        assert!(paused["budgetState"]["activeSinceMs"].is_null());
        assert_eq!(paused["budgetState"]["usedCalls"], 1);
        assert_eq!(paused["budgetState"]["usedInputTokens"], 4);
        assert_eq!(paused["budgetState"]["usedOutputTokens"], 6);
        assert_eq!(paused["budgetState"]["inFlight"], 0);
        assert_eq!(paused["budgetState"]["reservedInputTokens"], 0);
        pause_parent_clocks(&store, s(&child, "id")).unwrap();
        assert_eq!(
            load_run(&store, id).unwrap(),
            paused,
            "an already stopped clock does not create another revision"
        );
    }
}

fn unknown_policy_child(store: &Store, parent: &Value, budget: Value) -> Value {
    let mut budget = budget;
    budget["parentBudgetId"] = parent["id"].clone();
    create_run(store,"simulated-accuracy-import",&json!({"version":"simulated-v3","unknownUsagePolicy":"retain-reservation-continue-other-questions-v1"}),&parent["source"],&budget).unwrap()
}

#[test]
fn unknown_usage_uses_execution_child_policy_keeps_legacy_parent_hold_and_admits_another_question()
{
    let (_dir, store) = fixture();
    let parent = run(&store, json!({"maxInputTokens":30,"maxOutputTokens":60}));
    let child = unknown_policy_child(&store, &parent, json!({}));
    let first = reserve_execution(
        &store,
        s(&child, "id"),
        "math",
        "failed-q1",
        &request(),
        10,
        20,
        1,
    )
    .unwrap();
    finish_execution(
        &store,
        s(&first, "id"),
        "failed",
        &Value::Null,
        &json!({"code":"simulated_timeout"}),
    )
    .unwrap();
    for id in [s(&parent, "id"), s(&child, "id")] {
        let value = load_run(&store, id).unwrap();
        assert_ne!(value["status"], "budget_paused");
        assert_eq!(value["budgetState"]["reservedInputTokens"], 10);
        assert_eq!(value["budgetState"]["reservedOutputTokens"], 20);
        assert_eq!(
            value["budgetState"]["unknownUsageExecutions"],
            json!([first["id"]])
        );
        assert_eq!(value["budgetState"]["usedCalls"], 1);
    }
    assert_eq!(
        list_executions(&store, s(&child, "id")).unwrap().len(),
        1,
        "finishing never retries a failed question"
    );
    let second = reserve_execution(
        &store,
        s(&child, "id"),
        "math",
        "different-q2",
        &request(),
        10,
        20,
        1,
    )
    .unwrap();
    finish_execution(
        &store,
        s(&second, "id"),
        "completed",
        &known(),
        &Value::Null,
    )
    .unwrap();
    let charged = load_run(&store, s(&parent, "id")).unwrap();
    assert_eq!(charged["budgetState"]["usedCalls"], 2);
    assert_eq!(charged["budgetState"]["usedInputTokens"], 4);
    assert_eq!(charged["budgetState"]["reservedInputTokens"], 10);
    assert_eq!(
        load_execution(&store, s(&first, "id")).unwrap()["unknownUsagePolicy"],
        "retain-reservation-continue-other-questions-v1"
    );
    assert_eq!(
        reserve_execution(&store, s(&child, "id"), "math", "q3", &request(), 20, 20, 1)
            .unwrap_err()
            .code,
        "budget_paused",
        "held unknown usage still consumes the ancestor's real cap"
    );
    assert_eq!(
        load_run(&store, s(&parent, "id")).unwrap()["budgetState"]["usedCalls"],
        2
    );
    assert_eq!(
        check_strategy_continuation_budget(&store, s(&child, "id"))
            .unwrap_err()
            .code,
        "budget_paused"
    );
}

#[test]
fn legacy_execution_cannot_inherit_a_new_parent_unknown_policy_and_partial_actual_overage_still_pauses()
 {
    let (_dir, store) = fixture();
    let parent=create_run(&store,"simulated-accuracy-import",&json!({"version":"new-parent","unknownUsagePolicy":"retain-reservation-continue-other-questions-v1"}),&json!({"sha256":"a".repeat(64)}),&json!({})).unwrap();
    let legacy = create_run(
        &store,
        "simulated-accuracy-import",
        &json!({"version":"legacy-child"}),
        &parent["source"],
        &json!({"parentBudgetId":parent["id"]}),
    )
    .unwrap();
    let execution = reserve_execution(
        &store,
        s(&legacy, "id"),
        "math",
        "q1",
        &request(),
        10,
        20,
        1,
    )
    .unwrap();
    finish_execution(
        &store,
        s(&execution, "id"),
        "failed",
        &Value::Null,
        &Value::Null,
    )
    .unwrap();
    assert_eq!(
        load_run(&store, s(&legacy, "id")).unwrap()["status"],
        "budget_paused"
    );
    assert_eq!(
        load_run(&store, s(&parent, "id")).unwrap()["status"],
        "budget_paused"
    );
    let (_dir, store) = fixture();
    let parent = run(&store, json!({"maxInputTokens":10,"maxOutputTokens":100}));
    let child = unknown_policy_child(
        &store,
        &parent,
        json!({"maxInputTokens":10,"maxOutputTokens":100}),
    );
    let execution =
        reserve_execution(&store, s(&child, "id"), "math", "q1", &request(), 10, 20, 1).unwrap();
    finish_execution(
        &store,
        s(&execution, "id"),
        "failed",
        &json!({"prompt_tokens":11}),
        &Value::Null,
    )
    .unwrap();
    for id in [s(&parent, "id"), s(&child, "id")] {
        let value = load_run(&store, id).unwrap();
        assert_eq!(value["status"], "budget_paused");
        assert_eq!(value["budgetError"]["code"], "usage_exceeded");
        assert_eq!(value["budgetState"]["usedInputTokens"], 11);
        assert_eq!(value["budgetState"]["reservedInputTokens"], 0);
        assert_eq!(value["budgetState"]["reservedOutputTokens"], 20);
    }
    assert_eq!(
        check_strategy_continuation_budget(&store, s(&child, "id"))
            .unwrap_err()
            .code,
        "budget_paused"
    );
    assert_eq!(
        resume_run(&store, s(&child, "id")).unwrap_err().code,
        "budget_paused"
    );
}

#[test]
fn explicit_new_strategy_resumes_only_unknown_pauses_after_exact_saved_acknowledged_record() {
    let (_dir, store) = fixture();
    let parent = run(&store, json!({}));
    let execution = reserve_execution(
        &store,
        s(&parent, "id"),
        "math",
        "q1",
        &request(),
        10,
        20,
        1,
    )
    .unwrap();
    finish_execution(
        &store,
        s(&execution, "id"),
        "failed",
        &Value::Null,
        &Value::Null,
    )
    .unwrap();
    let paused = load_run(&store, s(&parent, "id")).unwrap();
    let child = unknown_policy_child(&store, &parent, json!({}));
    let payload = json!({"operationId":"simulated-explicit-strategy-resume","acknowledge":true});
    let record = json!({"importId":"simulated-accuracy-import","revision":2,"accuracyRunId":child["id"],"backgroundJob":{"strategyContinuation":true,"operationId":payload["operationId"],"payload":payload,"payloadHash":hash_json(&payload)}});
    store
        .put_document("imports", "simulated-accuracy-import", &record)
        .unwrap();
    let mut stale = record.clone();
    stale["revision"] = json!(1);
    assert_eq!(
        resume_unknown_strategy_chain(&store, s(&child, "id"), &stale)
            .unwrap_err()
            .code,
        "revision_conflict"
    );
    assert_eq!(load_run(&store, s(&parent, "id")).unwrap(), paused);
    resume_unknown_strategy_chain(&store, s(&child, "id"), &record).unwrap();
    let resumed = load_run(&store, s(&parent, "id")).unwrap();
    assert_eq!(resumed["status"], "ready");
    assert_eq!(resumed["budgetState"], paused["budgetState"]);
    assert_eq!(resumed["budgetError"], paused["budgetError"]);
    assert_eq!(
        resumed["budgetResumptions"][0]["reason"],
        "explicit_strategy_continue"
    );
    resume_unknown_strategy_chain(&store, s(&child, "id"), &record).unwrap();
    assert_eq!(load_run(&store, s(&parent, "id")).unwrap(), resumed);
    assert_eq!(load_run(&store, s(&child, "id")).unwrap(), child);
}
