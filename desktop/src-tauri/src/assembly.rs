use crate::{
    bank::BankRepository,
    error::{AppError, AppResult},
    intake::{self, TYPES, invalid, list, s, strings},
    model::ModelClient,
    storage::Store,
};
use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    sync::atomic::{AtomicBool, Ordering},
};

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
fn hash(value: &Value) -> String {
    crate::bank::hash_json(value)
}
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn stable_id(namespace: &str, parent: &str, operation: &str) -> String {
    hash(&json!([namespace, parent, operation]))[..32].to_owned()
}
fn error(code: &str, message: &str) -> AppError {
    AppError::new(code, message)
}
fn check_cancel(cancel: &AtomicBool) -> AppResult<()> {
    if cancel.load(Ordering::Relaxed) {
        Err(error("cancelled", "已取消，已有成果保留。"))
    } else {
        Ok(())
    }
}
fn operation_id(v: &Value) -> AppResult<&str> {
    let value = s(v, "operationId");
    if value.is_empty()
        || value.len() > 100
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(invalid("操作需要稳定且有效的身份。"));
    }
    Ok(value)
}
fn task<'a>(config: &'a Value, id: &str) -> AppResult<&'a Value> {
    config["tasks"]
        .as_array()
        .and_then(|a| a.iter().find(|t| s(t, "id") == id))
        .ok_or_else(|| invalid("考查任务无效。"))
}
fn parts(task: &Value, points: u64) -> Value {
    let ids = list(&task["partIds"]);
    let weights: Vec<u64> = ids
        .iter()
        .enumerate()
        .map(|(i, _)| task["partWeights"][i].as_u64().unwrap_or(1))
        .collect();
    let values = intake::distribute(points, &weights);
    json!(
        ids.iter()
            .enumerate()
            .map(|(i, part)| json!({"partId":part,"points":values[i]}))
            .collect::<Vec<_>>()
    )
}
fn point_validation(
    slot: &Value,
    points: &Value,
    part_points: &Value,
    task: &Value,
) -> AppResult<()> {
    let n = points
        .as_u64()
        .filter(|n| *n <= 1000)
        .ok_or_else(|| invalid("题分需为 0～1000 的整数。"))?;
    let allocations = part_points
        .as_array()
        .ok_or_else(|| invalid("小问赋分需为数组。"))?;
    if s(slot, "questionType") != "free_response" {
        if !allocations.is_empty() {
            return Err(invalid("非解答题不能设置小问分值。"));
        }
        return Ok(());
    }
    let expected = if slot["question"].is_object() {
        list(&slot["question"]["student"]["parts"])
            .iter()
            .map(|p| s(p, "partId").to_owned())
            .collect::<Vec<_>>()
    } else {
        strings(&task["partIds"])
    };
    let mut seen = HashSet::new();
    let mut sum = 0;
    for p in allocations {
        let part = s(p, "partId");
        if !expected.iter().any(|x| x == part) || !seen.insert(part) {
            return Err(invalid("小问身份与题目不匹配。"));
        }
        sum += p["points"]
            .as_u64()
            .filter(|n| *n <= 1000)
            .ok_or_else(|| invalid("小问赋分无效。"))?;
    }
    if seen.len() != expected.len() || sum != n {
        return Err(invalid("小问分值合计需与题分一致。"));
    }
    Ok(())
}

// Only version-bound, verified task/scope/complete-path evidence authorizes automatic selection.
fn assess(
    question: &Value,
    slot: &Value,
    r: &Value,
    config: &Value,
    used: &HashSet<String>,
    groups: &HashSet<String>,
) -> Value {
    let qid = s(question, "questionId");
    let annotation = config["assemblyIndex"]["entries"]
        .as_array()
        .and_then(|entries| entries.iter().find(|a| s(a, "questionId") == qid));
    let mut reasons = Vec::<String>::new();
    if !list(&question["sourceRefs"]).iter().any(|source| {
        strings(&r["sourceIds"])
            .iter()
            .any(|id| id == s(source, "sourceId"))
    }) {
        reasons.push("不在本次来源范围".into());
    }
    let base = json!({"questionId":qid,"contentVersion":question["contentVersion"],"current":false,"duplicate":false,"canSelect":false});
    let Some(a) = annotation else {
        return intake::merge(
            &base,
            &json!({"status":"unknown","reasons":["缺少已核实的适配依据"]}),
        );
    };
    if a["contentVersion"] != question["contentVersion"]
        || a["teacherVersion"] != question["teacherVersion"]
        || (!crate::knowledge::uses_knowledge(a) && strings(&a["primarySections"]).is_empty())
        || s(&a, "duplicateGroup").is_empty()
    {
        return intake::merge(
            &base,
            &json!({"status":"unknown","reasons":["适配依据与题目版本不一致"]}),
        );
    }
    if !strings(&a["tasks"])
        .iter()
        .any(|id| id == s(slot, "taskId"))
    {
        reasons.push("具体考查任务不同".into());
    }
    let knowledge_based = crate::knowledge::uses_knowledge(a);
    if !knowledge_based
        && (r.get("mainKnowledgeUids").is_some() || r.get("learnedKnowledgeUids").is_some())
    {
        return intake::merge(
            &base,
            &json!({"status":"unknown","reasons":["此题仅有旧版小节标注，尚无本次知识点范围所需的精细依据"]}),
        );
    }
    if knowledge_based {
        if let Err(err) = crate::knowledge::validate_annotation(a, config) {
            return intake::merge(
                &base,
                &json!({"status":"unknown","reasons":[format!("知识点适配依据无效：{}", err.message)]}),
            );
        }
        if strings(&a["primaryKnowledgeUids"]).is_empty() {
            return intake::merge(
                &base,
                &json!({"status":"unknown","reasons":["尚未标注主要考查知识点"]}),
            );
        }
        if strings(&a["primaryKnowledgeUids"]).iter().any(|uid| {
            !crate::knowledge::uid_in_scope(
                uid,
                &r["mainScope"],
                r.get("mainKnowledgeUids"),
                config,
            )
        }) {
            reasons.push("主要考查知识点不在主考范围".into());
        }
    } else if strings(&a["primarySections"])
        .iter()
        .any(|id| !intake::includes(&r["mainScope"], id))
    {
        reasons.push("主要考查内容不在主考范围".into());
    }
    let path = a["solutionPaths"].as_array().and_then(|paths| {
        paths.iter().find(|path| {
            !s(path, "id").is_empty()
                && !s(path, "basis").trim().is_empty()
                && path["requiredPremises"].is_array()
                && if knowledge_based {
                    let required = strings(&path["requiredKnowledgeUids"]);
                    path["requiredKnowledgeUids"].is_array()
                        && !required.is_empty()
                        && strings(&a["primaryKnowledgeUids"])
                            .iter()
                            .all(|uid| required.contains(uid))
                        && required.iter().all(|uid| {
                            crate::knowledge::uid_in_scope(
                                uid,
                                &r["learnedScope"],
                                r.get("learnedKnowledgeUids"),
                                config,
                            )
                        })
                } else {
                    path["requiredSections"].is_array()
                        && strings(&path["requiredSections"])
                            .iter()
                            .all(|id| intake::includes(&r["learnedScope"], id))
                }
                && strings(&path["requiredPremises"]).iter().all(|id| {
                    strings(&r["premises"]).contains(id)
                        || strings(&r["foundationPremises"]).contains(id)
                })
        })
    });
    let duplicate = used.contains(qid) || groups.contains(s(&a, "duplicateGroup"));
    if duplicate {
        reasons.push("本卷已使用同题或重复组".into());
    }
    let required = list(&r["teachingGoals"]).iter().any(|g| {
        s(g, "priority") == "required"
            && strings(&slot["goalIds"]).iter().any(|id| id == s(g, "id"))
    });
    if path.is_none() {
        reasons.push("尚无符合已学边界及前提的完整解法证据".into());
    }
    if required {
        reasons.push("必须教学目标尚无已复核的题目支持证据".into());
    }
    let status = if path.is_none() || required {
        "unknown"
    } else if reasons.is_empty() {
        "eligible"
    } else {
        "related"
    };
    intake::merge(
        &base,
        &json!({"status":status,"reasons":reasons,"duplicate":duplicate,"canSelect":status=="eligible","duplicateGroup":a["duplicateGroup"],"allowedSolutionPath":path,"primaryKnowledgeUids":a["primaryKnowledgeUids"],"knowledgeSchemaVersion":a["knowledgeSchemaVersion"],"notes":a["notes"],"difficultyEstimate":a["difficultyEstimate"]}),
    )
}
fn candidates(
    pool: &[Value],
    slot: &Value,
    r: &Value,
    config: &Value,
    slots: &[Value],
) -> Vec<Value> {
    let mut used = HashSet::new();
    let mut groups = HashSet::new();
    for other in slots
        .iter()
        .filter(|other| s(other, "slotId") != s(slot, "slotId"))
    {
        if let Some(q) = other.get("question").filter(|q| q.is_object()) {
            used.insert(s(q, "questionId").to_owned());
            if let Some(a) = list(&config["assemblyIndex"]["entries"])
                .iter()
                .find(|a| s(a, "questionId") == s(q, "questionId"))
            {
                groups.insert(s(a, "duplicateGroup").to_owned());
            }
        }
    }
    let mut out: Vec<_> = pool
        .iter()
        .filter(|q| s(q, "questionType") == s(slot, "questionType"))
        .map(|q| {
            let mut result = assess(q, slot, r, config, &used, &groups);
            let current = s(&slot["question"], "questionId") == s(q, "questionId");
            result["current"] = json!(current);
            if current {
                result["canSelect"] = json!(false);
            }
            result
        })
        .collect();
    out.sort_by(|a, b| s(a, "questionId").cmp(s(b, "questionId")));
    out
}

fn is_manual(draft: &Value) -> bool {
    s(&draft["selectionGeneration"], "mode") == "manual"
}

// A teacher's explicit choice is permission to use a verified bank snapshot,
// not proof that a question matches a teaching goal or a learned boundary.
fn manual_candidates(pool: &[Value], slot: &Value, slots: &[Value]) -> Vec<Value> {
    pool.iter()
        .filter(|q| q["questionType"] == slot["questionType"])
        .map(|q| {
            let current = q["questionId"] == slot["question"]["questionId"];
            let duplicate = slots.iter().any(|other| {
                other["slotId"] != slot["slotId"]
                    && other["question"]["questionId"] == q["questionId"]
            });
            json!({"questionId":q["questionId"],"contentVersion":q["contentVersion"],"teacherVersion":q["teacherVersion"],"current":current,"duplicate":duplicate,"canSelect":!current && !duplicate,"status":"teacher_selected","teachingMatchVerified":false,"reasons":if duplicate {vec!["本卷已使用该题"]}else{vec![]}})
        })
        .collect()
}

fn edit_task(config: &Value, slot: &Value, manual: bool) -> AppResult<Value> {
    if manual && s(slot, "taskId").is_empty() {
        return Ok(json!({"questionType":slot["questionType"],"partIds":[]}));
    }
    Ok(task(config, s(slot, "taskId"))?.clone())
}

fn manual_question(store: &Store, selection: &Value) -> AppResult<Value> {
    let qid = selection["questionId"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 250 && !id.chars().any(char::is_control))
        .ok_or_else(|| invalid("已选题目身份无效。"))?;
    if ["contentVersion", "teacherVersion"].iter().any(|key| {
        selection[*key]
            .as_str()
            .is_none_or(|version| version.is_empty() || version.len() > 100)
    }) {
        return Err(invalid("已选题目缺少内容或教师版版本，请刷新题库后重试。"));
    }
    // BankRepository excludes unpublished/pending entries and verifies payload
    // hashes, version identities, review status, and embedded assets on read.
    let question = store.bank.question(qid)?;
    if selection["contentVersion"] != question["contentVersion"]
        || selection["teacherVersion"] != question["teacherVersion"]
    {
        return Err(error(
            "version_conflict",
            "已选题目版本已更新，请重新查看并选择；题篮保留。",
        ));
    }
    if !TYPES.contains(&s(&question, "questionType")) {
        return Err(invalid("此题型暂不支持手动组卷，请从题篮移除后重试。"));
    }
    Ok(question)
}

fn manual_requirements(input: &Value, counts: &Value, student: Option<Value>) -> AppResult<Value> {
    let title = intake::validate_title(s(input, "title"))?;
    let purpose = s(input, "purpose");
    if !["consolidation", "targeted_practice", "diagnostic"].contains(&purpose) {
        return Err(invalid("请选择课后巩固、专项训练或学情诊断。"));
    }
    let minutes = input["durationMinutes"]
        .as_u64()
        .filter(|n| (1..=300).contains(n))
        .ok_or_else(|| invalid("练习时长需为 1～300 分钟。"))?;
    let mut requirements = json!({"mode":"manual","subject":"math","title":title,"purpose":purpose,"durationMinutes":minutes,"counts":counts,"questionCount":TYPES.iter().map(|kind|counts[*kind].as_u64().unwrap_or(0)).sum::<u64>(),"scoringMode":"none","targetScore":0,"mainScope":[],"learnedScope":[],"premises":[],"sourceIds":[],"automaticFoundation":false,"foundationPremises":[],"teachingGoals":[],"goal":"","targetDifficulty":null,"scopePolicy":"selected_questions","typeConstraints":{"exactCounts":counts,"excludedTypes":[]}});
    if let Some(student) = student {
        requirements["student"] = student;
    }
    Ok(requirements)
}

fn manual_draft_create(
    store: &mut Store,
    payload: &Value,
    cancel: &AtomicBool,
) -> AppResult<Value> {
    let oid = operation_id(payload)?.to_owned();
    let payload_hash = hash(payload);
    let draft_id = stable_id("manual-draft", "local", &oid);
    check_cancel(cancel)?;
    transact(store, |store| {
        if let Some(prior) = store
            .list_documents("drafts")?
            .into_iter()
            .find(|draft| s(draft, "draftId") == draft_id)
        {
            if s(&prior["creation"], "payloadHash") != payload_hash {
                return Err(error(
                    "operation_conflict",
                    "同一创建操作已用于不同内容，未覆盖原草稿。",
                ));
            }
            return Ok(json!({"draft":prior,"replayed":true}));
        }
        let selections = payload["selections"]
            .as_array()
            .filter(|selections| (1..=60).contains(&selections.len()))
            .ok_or_else(|| invalid("请选择 1～60 道题目。"))?;
        let mut seen = HashSet::new();
        let mut questions = Vec::new();
        for selection in selections {
            check_cancel(cancel)?;
            if !seen.insert(s(selection, "questionId").to_owned()) {
                return Err(invalid("题篮包含重复题目，请移除重复项。"));
            }
            questions.push(manual_question(store, selection)?);
        }
        // Stable grouping preserves the teacher's order within each type.
        questions.sort_by_key(|q| {
            TYPES
                .iter()
                .position(|kind| *kind == s(q, "questionType"))
                .unwrap()
        });
        let mut counts =
            json!({"single_choice":0,"multiple_choice":0,"fill_blank":0,"free_response":0});
        let mut slots = Vec::new();
        for (index, question) in questions.into_iter().enumerate() {
            let kind = s(&question, "questionType").to_owned();
            counts[&kind] = json!(counts[&kind].as_u64().unwrap_or(0) + 1);
            let part_points: Vec<Value> = if kind == "free_response" {
                list(&question["student"]["parts"])
                    .iter()
                    .map(|part| json!({"partId":part["partId"],"points":0}))
                    .collect()
            } else {
                vec![]
            };
            slots.push(json!({"slotId":format!("slot-{}",index+1),"number":index+1,"questionType":kind,"taskId":"","taskLabel":"","goalIds":[],"points":0,"partPoints":part_points,"locked":false,"question":question,"status":"selected","applicability":{"status":"teacher_selected","basis":"teacher_manual_selection","teachingMatchVerified":false},"selection":{"candidates":[],"reasons":[],"failures":[]}}));
        }
        let student = match payload.get("student") {
            None | Some(Value::Null) => None,
            Some(reference) => Some(
                store.student(
                    reference["studentId"]
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .ok_or_else(|| invalid("关联学生身份无效。"))?,
                )?,
            ),
        };
        let requirements = manual_requirements(payload, &counts, student.clone())?;
        let config = store.bank.config()?;
        let timestamp = now();
        let planned: Vec<Value> = slots
            .iter()
            .map(|slot| {
                let mut plan = slot.clone();
                for key in ["question", "applicability", "selection", "status", "locked"] {
                    plan.as_object_mut().unwrap().remove(key);
                }
                plan
            })
            .collect();
        let mut draft = json!({"schemaVersion":1,"draftId":draft_id,"title":requirements["title"],"titleSource":"teacher","revision":0,"createdAt":timestamp,"updatedAt":timestamp,"baseline":{"requirements":requirements,"slots":planned,"confirmedAt":timestamp,"version":1,"confirmationMode":"teacher_manual_selection","courseContext":config["courseContext"],"sourceManifest":config["sourceManifest"],"questionIndexSnapshot":config["assemblyIndex"],"taskCatalogSnapshot":config},"slots":slots,"operations":[],"selectionGeneration":{"mode":"manual","teachingMatchVerified":false},"creation":{"operationId":oid,"payloadHash":payload_hash}});
        if let Some(student) = student {
            draft["student"] = student;
        }
        refresh(&mut draft);
        freeze_assets(&draft)?;
        check_cancel(cancel)?;
        store.put_document("drafts", &draft_id, &draft)?;
        Ok(json!({"draft":draft}))
    })
}

fn supply(pool: &[Value], slots: &[Value], r: &Value, config: &Value) -> Value {
    json!({"ready":pool.len(),"slotSupply":slots.iter().map(|slot|{let c=candidates(pool,slot,r,config,&[]);json!({"slotId":slot["slotId"],"eligibleCount":c.iter().filter(|x|s(x,"status")=="eligible").count(),"unknownCount":c.iter().filter(|x|s(x,"status")=="unknown").count(),"relatedCount":c.iter().filter(|x|s(x,"status")=="related").count(),"readFailures":[]})}).collect::<Vec<_>>()})
}
fn check_blueprint(store: &Store, input: &Value) -> AppResult<Value> {
    let config = store.bank.config()?;
    let r = intake::normalize(store, &input["requirements"])?;
    let source = input["slots"]
        .as_array()
        .ok_or_else(|| invalid("题位规划需包含题位数组。"))?;
    let mut ids = HashSet::new();
    let mut counts =
        json!({"single_choice":0,"multiple_choice":0,"fill_blank":0,"free_response":0});
    let mut slots = Vec::new();
    for (index, slot) in source.iter().enumerate() {
        let sid = s(slot, "slotId");
        if sid.is_empty() || sid.len() > 80 || !ids.insert(sid) {
            return Err(invalid("题位身份无效或重复。"));
        }
        let t = task(&config, s(slot, "taskId"))?;
        if s(slot, "questionType") != s(t, "questionType")
            || slot["number"].as_u64() != Some(index as u64 + 1)
        {
            return Err(invalid("题型或连续题号与考查任务不匹配。"));
        }
        if !intake::overlaps(&t["sectionIds"], &r["mainScope"]) {
            return Err(invalid("考查任务超出教师指定范围，请调整题位。"));
        }
        let mut out = json!({"slotId":sid,"number":index+1,"questionType":t["questionType"],"taskId":t["id"],"taskLabel":t["label"],"goalIds":slot.get("goalIds").cloned().unwrap_or(json!([])),"points":slot["points"],"partPoints":slot.get("partPoints").cloned().unwrap_or(json!([]))});
        if s(&r, "scoringMode") == "none" {
            out["points"] = json!(0);
            out["partPoints"] = parts(t, 0);
        }
        point_validation(&out, &out["points"], &out["partPoints"], t)?;
        for gid in strings(&out["goalIds"]) {
            let goals = list(&r["teachingGoals"]);
            let Some(goal) = goals.iter().find(|g| s(g, "id") == gid) else {
                return Err(invalid("题位关联了未知教学目标。"));
            };
            if !intake::overlaps(&goal["knowledgeScope"], &t["sectionIds"])
                || (s(&goal["conditions"], "response") == "written_reasoning"
                    && s(t, "questionType") != "free_response")
            {
                return Err(invalid("题位任务或作答形式与关联教学目标不兼容。"));
            }
        }
        if let Some(d) = slot.get("targetDifficulty") {
            if !d.is_null() && !d.as_f64().is_some_and(|n| (0.0..=1.0).contains(&n)) {
                return Err(invalid("题位目标难度无效。"));
            }
            out["targetDifficulty"] = d.clone();
        }
        // An explicit null is a per-slot override, not permission to fall back.
        // Legacy numeric targets keep their original meaning; never infer a band.
        if let Some(level) = slot.get("targetDifficultyLevel") {
            intake::validate_difficulty_level(level)?;
            out["targetDifficultyLevel"] = level.clone();
            out["targetDifficulty"] = Value::Null;
        } else if slot.get("targetDifficulty").is_none()
            && let Some(level) = r.get("targetDifficultyLevel")
        {
            out["targetDifficultyLevel"] = level.clone();
            out["targetDifficulty"] = Value::Null;
        }
        if let Some(reason) = slot.get("planningReason") {
            if !reason.is_string() || reason.as_str().unwrap().chars().count() > 1000 {
                return Err(invalid("规划说明无效。"));
            }
            out["planningReason"] = reason.clone();
        }
        let kind = s(t, "questionType");
        counts[kind] = json!(counts[kind].as_u64().unwrap_or(0) + 1);
        slots.push(out);
    }
    if counts != r["counts"] {
        return Err(invalid("题位数量与教师确认的题量不一致，未自动增减题量。"));
    }
    for goal in list(&r["teachingGoals"])
        .iter()
        .filter(|g| s(g, "priority") == "required")
    {
        if !slots.iter().any(|slot| {
            strings(&slot["goalIds"])
                .iter()
                .any(|gid| gid == s(goal, "id"))
        }) {
            return Err(invalid(
                "必须教学目标尚未关联任何兼容题位，请调整规划或需求后再确认。",
            ));
        }
    }
    let points: u64 = slots
        .iter()
        .map(|slot| slot["points"].as_u64().unwrap_or(0))
        .sum();
    if points != r["targetScore"].as_u64().unwrap_or(0) {
        return Err(invalid("题位分值合计与确认总分不一致。"));
    }
    let pool = store.bank.questions()?;
    Ok(
        json!({"schemaVersion":1,"requirements":r,"slots":slots,"plannedStats":{"questionCount":source.len(),"points":points},"generation":input["generation"],"supply":supply(&pool,&slots,&r,&config)}),
    )
}
fn plan(
    store: &Store,
    input: &Value,
    model: &ModelClient,
    cancel: &AtomicBool,
) -> AppResult<Value> {
    let r = intake::normalize(store, &input["requirements"])?;
    let config = store.bank.config()?;
    let pool = store.bank.questions()?;
    // Choose rule tasks from verified supply under exactly the confirmed scope
    // and prerequisites. Catalog order is not evidence that a task can be used.
    let mut task_groups: HashMap<String, HashSet<String>> = HashMap::new();
    for question in &pool {
        let annotation = config["assemblyIndex"]["entries"]
            .as_array()
            .and_then(|entries| {
                entries
                    .iter()
                    .find(|entry| s(entry, "questionId") == s(question, "questionId"))
            });
        let Some(annotation) = annotation else {
            continue;
        };
        for task_id in strings(&annotation["tasks"]) {
            let Ok(task) = task(&config, &task_id) else {
                continue;
            };
            if task["questionType"] != question["questionType"] {
                continue;
            }
            let goal_ids: Vec<_> = list(&r["teachingGoals"])
                .iter()
                .filter(|goal| {
                    intake::overlaps(&goal["knowledgeScope"], &task["sectionIds"])
                        && (s(&goal["conditions"], "response") != "written_reasoning"
                            || s(task, "questionType") == "free_response")
                })
                .map(|goal| goal["id"].clone())
                .collect();
            let candidate = assess(
                question,
                &json!({"taskId":task_id,"goalIds":goal_ids}),
                &r,
                &config,
                &HashSet::new(),
                &HashSet::new(),
            );
            if s(&candidate, "status") == "eligible" {
                task_groups
                    .entry(task_id)
                    .or_default()
                    .insert(s(&candidate, "duplicateGroup").to_owned());
            }
        }
    }
    let mut used_groups = HashSet::new();
    let mut slots = Vec::new();
    for kind in TYPES {
        let available: Vec<_> = list(&config["tasks"])
            .into_iter()
            .filter(|t| {
                s(t, "questionType") == kind && intake::overlaps(&t["sectionIds"], &r["mainScope"])
            })
            .collect();
        let n = r["counts"][kind].as_u64().unwrap_or(0);
        if n > 0 && available.is_empty() {
            let label = match kind {
                "single_choice" => "单选",
                "multiple_choice" => "多选",
                "fill_blank" => "填空",
                _ => "解答",
            };
            return Err(invalid(&format!(
                "本次要求 {n} 道{label}题，指定范围尚无可用的{label}考查任务。题量未改变，请补充题库或明确调整题型、范围。"
            )));
        }
        let eligible: Vec<_> = available
            .iter()
            .filter(|task| task_groups.contains_key(s(task, "id")))
            .collect();
        let choices: Vec<_> = if eligible.is_empty() {
            available.iter().collect()
        } else {
            eligible
        };
        for i in 0..n {
            let preferred = (0..choices.len())
                .map(|step| choices[(i as usize + step) % choices.len()])
                .find_map(|task| {
                    let group = task_groups
                        .get(s(task, "id"))?
                        .iter()
                        .filter(|group| !used_groups.contains(*group))
                        .min()?
                        .clone();
                    Some((task, group))
                });
            let t = if let Some((task, group)) = preferred {
                used_groups.insert(group);
                task
            } else {
                choices[i as usize % choices.len()]
            };
            let number = slots.len() + 1;
            slots.push(json!({"slotId":format!("slot-{number}"),"number":number,"questionType":kind,"taskId":t["id"],"taskLabel":t["label"],"goalIds":list(&r["teachingGoals"]).iter().filter(|g|intake::overlaps(&g["knowledgeScope"],&t["sectionIds"]) && (s(&g["conditions"],"response")!="written_reasoning" || kind=="free_response")).map(|g|g["id"].clone()).collect::<Vec<_>>(),"points":0,"partPoints":parts(t,0)}));
        }
    }
    match s(input, "mode") {
        "rule" => {}
        "llm" => {
            let output=model.propose("blueprint",&intake::model_context(&json!({"requirements":r,"tasks":config["tasks"],"supply":supply(&pool,&slots,&r,&config),"slots":slots})),cancel)?;
            let generated = output["slots"]
                .as_array()
                .ok_or_else(|| invalid("AI 未返回有效题位规划。"))?;
            slots=generated.iter().enumerate().map(|(i,v)|intake::merge(v,&json!({"slotId":format!("slot-{}",i+1),"number":i+1,"points":0,"partPoints":[]}))).collect();
        }
        _ => return Err(invalid("请明确选择 AI 规划或规则预设。")),
    }
    let weights: Vec<u64> = slots
        .iter()
        .map(|slot| match s(slot, "questionType") {
            "single_choice" => 8,
            "multiple_choice" => 10,
            "fill_blank" => 10,
            _ => 16,
        })
        .collect();
    let allocations = intake::distribute(r["targetScore"].as_u64().unwrap_or(0), &weights);
    for (i, slot) in slots.iter_mut().enumerate() {
        let t = task(&config, s(slot, "taskId"))?;
        slot["points"] = json!(allocations[i]);
        slot["partPoints"] = parts(t, allocations[i]);
    }
    check_cancel(cancel)?;
    check_blueprint(
        store,
        &json!({"requirements":r,"slots":slots,"generation":{"mode":s(input,"mode")}}),
    )
}

fn refresh(draft: &mut Value) {
    let slots = list(&draft["slots"]);
    let selected: Vec<_> = slots.iter().filter(|s| s["question"].is_object()).collect();
    let points: u64 = slots
        .iter()
        .map(|s| s["points"].as_u64().unwrap_or(0))
        .sum();
    let available_points = selected
        .iter()
        .map(|s| s["points"].as_u64().unwrap_or(0))
        .sum::<u64>();
    draft["stats"] = json!({"questionCount":slots.len(),"plannedCount":slots.len(),"selectedCount":selected.len(),"actualCount":selected.len(),"missingCount":slots.len()-selected.len(),"plannedQuestions":slots.len(),"selectedQuestions":selected.len(),"missingQuestions":slots.len()-selected.len(),"plannedPoints":points,"actualPoints":available_points,"availablePoints":available_points,"unknownDifficultyCount":selected.len(),"difficultyEstimate":null});
    let mut differences = Vec::new();
    for slot in &slots {
        if !slot["question"].is_object() {
            differences.push(json!({"code":"missing_question","slotId":slot["slotId"],"message":format!("第 {} 题缺少符合条件的题目，保留题位。可调整该题考查任务或补充题库。",slot["number"])}));
        } else if slot["applicability"].is_object()
            && s(&slot["applicability"], "status") != "eligible"
            && !(is_manual(draft) && s(&slot["applicability"], "status") == "teacher_selected")
        {
            differences.push(json!({"code":"applicability_unconfirmed","slotId":slot["slotId"],"message":format!("第 {} 题的适配仍需核对。",slot["number"])}));
        }
    }
    for baseline in list(&draft["baseline"]["slots"]) {
        if let Some(current) = slots.iter().find(|x| x["slotId"] == baseline["slotId"]) {
            if current["points"] != baseline["points"] {
                differences.push(json!({"code":"points_changed","slotId":current["slotId"],"message":"题分已调整，评分细则需核对。"}));
            }
        } else {
            differences.push(json!({"code":"slot_deleted","slotId":baseline["slotId"],"message":"原规划题位已删除。"}));
        }
    }
    for slot in &slots {
        if !list(&draft["baseline"]["slots"])
            .iter()
            .any(|x| x["slotId"] == slot["slotId"])
        {
            differences.push(
                json!({"code":"slot_added","slotId":slot["slotId"],"message":"存在新增题位。"}),
            );
        }
    }
    for kind in TYPES {
        if slots
            .iter()
            .filter(|slot| s(slot, "questionType") == kind)
            .count() as u64
            != draft["baseline"]["requirements"]["counts"][kind]
                .as_u64()
                .unwrap_or(0)
        {
            differences.push(json!({"code":"count_changed","message":"当前题型数量与教师确认需求不同，请核对后确认。"}));
            break;
        }
    }
    if points
        != draft["baseline"]["requirements"]["targetScore"]
            .as_u64()
            .unwrap_or(0)
    {
        differences
            .push(json!({"code":"planned_score_differs","message":"当前题分合计与需求总分不同。"}));
    }
    draft["differences"] = json!(differences);
}
// Augmenting-path maximum matching prevents greedy selection from inventing a shortage.
fn assignment(rows: &[Vec<(String, String)>]) -> HashMap<usize, String> {
    fn augment(
        i: usize,
        rows: &[Vec<(String, String)>],
        seen: &mut HashSet<String>,
        owners: &mut HashMap<String, (usize, String)>,
    ) -> bool {
        for (q, g) in &rows[i] {
            if !seen.insert(g.clone()) {
                continue;
            }
            let previous = owners.get(g).cloned();
            if previous.is_none() || augment(previous.unwrap().0, rows, seen, owners) {
                owners.insert(g.clone(), (i, q.clone()));
                return true;
            }
        }
        false
    }
    let mut owners = HashMap::new();
    for i in 0..rows.len() {
        augment(i, rows, &mut HashSet::new(), &mut owners);
    }
    owners.into_values().collect()
}
fn create_draft(
    store: &mut Store,
    input: &Value,
    model: &ModelClient,
    cancel: &AtomicBool,
) -> AppResult<Value> {
    let blueprint = check_blueprint(store, &input["blueprint"])?;
    let config = store.bank.config()?;
    let pool = store.bank.questions()?;
    let r = &blueprint["requirements"];
    let planned = list(&blueprint["slots"]);
    let options: Vec<Vec<Value>> = planned
        .iter()
        .map(|slot| candidates(&pool, slot, r, &config, &[]))
        .collect();
    let mut rows: Vec<Vec<(String, String)>> = options
        .iter()
        .map(|c| {
            c.iter()
                .filter(|v| s(v, "status") == "eligible")
                .map(|v| {
                    (
                        s(v, "questionId").to_owned(),
                        s(v, "duplicateGroup").to_owned(),
                    )
                })
                .collect()
        })
        .collect();
    match s(input, "mode") {
        "rule" => {}
        "llm" => {
            let context = json!({"requirements":r,"slots":planned,"candidates":options.iter().enumerate().map(|(i,items)|json!({"slotId":planned[i]["slotId"],"candidates":items.iter().filter(|v|s(v,"status")=="eligible").map(|c|json!({"questionId":c["questionId"],"questionBody":pool.iter().find(|q|q["questionId"]==c["questionId"]).map(|q|&q["student"]),"allowedSolutionPath":c["allowedSolutionPath"]})).collect::<Vec<_>>()})).collect::<Vec<_>>()});
            // Question.student is the student-facing question body, not a person. Strip associations at requirements only.
            let mut context = context;
            context["requirements"] = intake::model_context(r);
            let output = model.propose("selection", &context, cancel)?;
            let rankings = output["rankings"]
                .as_array()
                .ok_or_else(|| invalid("AI 未返回真实候选排序。"))?;
            if rankings.len() != planned.len() {
                return Err(invalid("AI 候选排序未覆盖全部题位。"));
            }
            let mut seen = HashSet::new();
            for ranking in rankings {
                let sid = s(ranking, "slotId");
                let i = planned
                    .iter()
                    .position(|v| s(v, "slotId") == sid)
                    .ok_or_else(|| invalid("AI 返回未知题位。"))?;
                if !seen.insert(sid) {
                    return Err(invalid("AI 重复返回题位。"));
                }
                let ids = ranking["questionIds"]
                    .as_array()
                    .ok_or_else(|| invalid("AI 候选排序结构无效。"))?;
                let mut chosen = HashSet::new();
                let original = rows[i].clone();
                let mut ordered = Vec::new();
                for q in ids {
                    let qid = q.as_str().ok_or_else(|| invalid("AI 候选身份无效。"))?;
                    if !chosen.insert(qid) {
                        return Err(invalid("AI 候选排序包含重复题目。"));
                    }
                    ordered.push(
                        original
                            .iter()
                            .find(|(id, _)| id == qid)
                            .cloned()
                            .ok_or_else(|| invalid("AI 返回未通过本地条件核验的题目。"))?,
                    );
                }
                // A complete eligible ordering is required; missing rows cannot silently become teacher shortages.
                if ordered.len() != original.len() {
                    return Err(invalid("AI 候选排序不完整，请重试或显式使用规则选题。"));
                }
                rows[i] = ordered;
            }
        }
        _ => return Err(invalid("请明确选择 AI 选题或规则选题。")),
    }
    let matches = assignment(&rows);
    let mut slots = Vec::new();
    for (i, slot) in planned.iter().enumerate() {
        let mut out = slot.clone();
        out["locked"] = json!(false);
        out["question"] = Value::Null;
        out["status"] = json!("empty");
        if let Some(qid) = matches.get(&i) {
            let c = options[i]
                .iter()
                .find(|c| s(c, "questionId") == qid)
                .unwrap();
            out["question"] = pool
                .iter()
                .find(|q| q["questionId"] == c["questionId"])
                .ok_or_else(|| error("integrity_error", "已选候选的真实题目快照缺失。"))?
                .clone();
            out["applicability"] = c.clone();
            out["status"] = json!("selected");
        }
        out["selection"] = json!({"candidates":options[i],"reasons":if out["question"].is_null(){vec!["符合本题要求且未重复的题目不足，已保留空位。"]}else{vec![]},"failures":[]});
        slots.push(out);
    }
    let timestamp = now();
    let draft_id = id();
    let mut draft = json!({"schemaVersion":1,"draftId":draft_id,"title":r["title"],"revision":0,"createdAt":timestamp,"updatedAt":timestamp,"baseline":{"requirements":r,"slots":planned,"confirmedAt":timestamp,"version":1,"courseContext":config["courseContext"],"sourceManifest":config["sourceManifest"],"questionIndexSnapshot":config["assemblyIndex"],"taskCatalogSnapshot":config},"slots":slots,"operations":[],"selectionGeneration":{"mode":s(input,"mode")}});
    if let Some(student) = r.get("student") {
        draft["student"] = student.clone();
    }
    refresh(&mut draft);
    freeze_assets(&draft)?;
    check_cancel(cancel)?;
    store.put_document("drafts", &draft_id, &draft)?;
    Ok(json!({"draft":draft}))
}

fn find_slot(slots: &[Value], sid: &str) -> AppResult<usize> {
    slots
        .iter()
        .position(|slot| s(slot, "slotId") == sid)
        .ok_or_else(|| invalid("题位不存在。"))
}
fn revision(draft: &Value, operation: &Value) -> AppResult<()> {
    if operation["expectedRevision"].as_u64() != draft["revision"].as_u64() {
        Err(error(
            "revision_conflict",
            "草稿已更新，请重新读取后再操作。",
        ))
    } else {
        Ok(())
    }
}
fn transact<T>(store: &mut Store, action: impl FnOnce(&mut Store) -> AppResult<T>) -> AppResult<T> {
    store.user.execute_batch("BEGIN IMMEDIATE")?;
    match action(store) {
        Ok(value) => {
            store.user.execute_batch("COMMIT")?;
            Ok(value)
        }
        Err(e) => {
            let _ = store.user.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}
fn edit(store: &mut Store, payload: &Value) -> AppResult<Value> {
    let draft_id = s(payload, "draftId");
    let op = &payload["operation"];
    let oid = operation_id(op)?.to_owned();
    let payload_hash = hash(op);
    transact(store, |store| {
        let mut draft = store.document("drafts", draft_id)?;
        if let Some(prior) = list(&draft["operations"])
            .iter()
            .find(|v| s(v, "operationId") == oid)
        {
            if s(prior, "payloadHash") != payload_hash {
                return Err(error("operation_conflict", "同一操作身份已用于不同内容。"));
            }
            return Ok(json!({"draft":draft,"replayed":true}));
        }
        if draft["confirmedPaperId"].is_string() {
            return Err(error(
                "finalized_draft",
                "此草稿已成卷，请继续编辑为新草稿。",
            ));
        }
        revision(&draft, op)?;
        let config = store.bank.config()?;
        let pool = store.bank.questions()?;
        let manual = is_manual(&draft);
        let mut slots = list(&draft["slots"]);
        let mut results = Vec::new();
        let kind = s(op, "type");
        match kind {
            "rename" => {
                draft["title"] = json!(intake::validate_title(s(op, "title"))?);
                draft["titleSource"] = json!("teacher");
            }
            "lock" => {
                let i = find_slot(&slots, s(op, "slotId"))?;
                if !op["locked"].is_boolean() {
                    return Err(invalid("锁定值需为布尔值。"));
                }
                slots[i]["locked"] = op["locked"].clone();
            }
            "delete" => {
                let i = find_slot(&slots, s(op, "slotId"))?;
                slots.remove(i);
            }
            "add" => {
                if slots.len() >= 60 {
                    return Err(invalid("最多 60 个题位。"));
                }
                let manual_question = if manual && op["candidateId"].is_string() {
                    let q = manual_question(
                        store,
                        &json!({"questionId":op["candidateId"],"contentVersion":op["contentVersion"],"teacherVersion":op["teacherVersion"]}),
                    )?;
                    if q["questionType"] != op["questionType"] {
                        return Err(invalid("新增题目与所选题型不一致。"));
                    }
                    if slots
                        .iter()
                        .any(|slot| slot["question"]["questionId"] == q["questionId"])
                    {
                        return Err(invalid("本卷已使用该题，请选择其它题目。"));
                    }
                    Some(q)
                } else {
                    None
                };
                let manual_type = s(op, "questionType");
                let t = if manual {
                    if !s(op, "taskId").is_empty() {
                        return Err(invalid(
                            "手动组卷按明确选择的题型添加，不使用自动考查任务。",
                        ));
                    }
                    if !TYPES.contains(&manual_type) {
                        return Err(invalid("请选择支持的题型。"));
                    }
                    json!({"id":"","label":"","questionType":manual_type,"partIds":[]})
                } else {
                    task(&config, s(op, "taskId"))?.clone()
                };
                let points = if s(&draft["baseline"]["requirements"], "scoringMode") == "none" {
                    json!(0)
                } else {
                    op.get("points").cloned().unwrap_or(json!(0))
                };
                let mut slot = json!({"slotId":format!("slot-{}",id()),"number":0,"questionType":t["questionType"],"taskId":t["id"],"taskLabel":t["label"],"goalIds":[],"points":points,"partPoints":op.get("partPoints").cloned().unwrap_or(parts(&t,points.as_u64().unwrap_or(0))),"status":"empty","question":null,"locked":false,"selection":{"reasons":["新增题位尚未选题，请选择真实候选。"]}});
                if let Some(level) = draft["baseline"]["requirements"].get("targetDifficultyLevel")
                {
                    intake::validate_difficulty_level(level)?;
                    slot["targetDifficultyLevel"] = level.clone();
                    slot["targetDifficulty"] = Value::Null;
                }
                if let Some(q) = manual_question {
                    slot["partPoints"] = if s(&q, "questionType") == "free_response" {
                        let ids = list(&q["student"]["parts"]);
                        let values =
                            intake::distribute(points.as_u64().unwrap_or(0), &vec![1; ids.len()]);
                        json!(
                            ids.iter()
                                .enumerate()
                                .map(
                                    |(i, part)| json!({"partId":part["partId"],"points":values[i]})
                                )
                                .collect::<Vec<_>>()
                        )
                    } else {
                        json!([])
                    };
                    slot["question"] = q;
                    slot["status"] = json!("selected");
                    slot["applicability"] = json!({"status":"teacher_selected","basis":"teacher_manual_selection","teachingMatchVerified":false});
                    slot["selection"] = json!({"candidates":[],"reasons":[],"failures":[]});
                }
                point_validation(&slot, &slot["points"], &slot["partPoints"], &t)?;
                let position = if let Some(after) = op["afterSlotId"].as_str() {
                    let i = find_slot(&slots, after)?;
                    if slots[i]["questionType"] != slot["questionType"] {
                        return Err(invalid("新增位置需为同题型题目之后。"));
                    }
                    i + 1
                } else {
                    slots.len()
                };
                slots.insert(position, slot);
            }
            "replace" => {
                if manual
                    && (s(op, "mode") == "automatic"
                        || op["candidateId"].as_str().is_none_or(str::is_empty))
                {
                    return Err(invalid("手动组卷请明确选择要替换的真实题目，未自动换题。"));
                }
                if manual {
                    manual_question(
                        store,
                        &json!({"questionId":op["candidateId"],"contentVersion":op["contentVersion"],"teacherVersion":op["teacherVersion"]}),
                    )?;
                }
                let selected = if let Some(ids) = op["slotIds"].as_array() {
                    strings(&json!(ids))
                } else {
                    vec![s(op, "slotId").to_owned()]
                };
                if selected.is_empty() {
                    return Err(invalid("请选择题位。"));
                }
                if selected.len() > 1 && op["candidateId"].is_string() {
                    return Err(invalid("指定候选只能用于一个题位。"));
                }
                for sid in selected {
                    let i = find_slot(&slots, &sid)?;
                    if s(op, "mode") == "automatic" && slots[i]["locked"] == true {
                        results.push(json!({"slotId":sid,"status":"skipped_locked"}));
                        continue;
                    }
                    let options = if manual {
                        manual_candidates(&pool, &slots[i], &slots)
                    } else {
                        candidates(
                            &pool,
                            &slots[i],
                            &draft["baseline"]["requirements"],
                            &config,
                            &slots,
                        )
                    };
                    let candidate = if let Some(qid) = op["candidateId"].as_str() {
                        options
                            .iter()
                            .find(|c| s(c, "questionId") == qid && c["canSelect"] == true)
                    } else {
                        options.iter().find(|c| c["canSelect"] == true)
                    };
                    if let Some(c) = candidate {
                        let new_question = pool
                            .iter()
                            .find(|q| q["questionId"] == c["questionId"])
                            .ok_or_else(|| error("integrity_error", "备选题的真实内容缺失。"))?;
                        if manual
                            && (new_question["contentVersion"] != op["contentVersion"]
                                || new_question["teacherVersion"] != op["teacherVersion"])
                        {
                            return Err(error(
                                "version_conflict",
                                "候选版本已改变，请重新查看后选题；现题保留。",
                            ));
                        }
                        let mut proposed = slots[i].clone();
                        proposed["question"] = new_question.clone();
                        if manual && s(&proposed, "questionType") == "free_response" {
                            let ids = list(&new_question["student"]["parts"]);
                            let values = intake::distribute(
                                proposed["points"].as_u64().unwrap_or(0),
                                &vec![1; ids.len()],
                            );
                            proposed["partPoints"] = json!(ids.iter().enumerate().map(|(i,part)|json!({"partId":part["partId"],"points":values[i]})).collect::<Vec<_>>());
                        }
                        let t = edit_task(&config, &proposed, manual)?;
                        point_validation(
                            &proposed,
                            &proposed["points"],
                            &proposed["partPoints"],
                            &t,
                        )?;
                        slots[i]["question"] = new_question.clone();
                        slots[i]["partPoints"] = proposed["partPoints"].clone();
                        slots[i]["status"] = json!("selected");
                        slots[i]["applicability"] = c.clone();
                        results.push(json!({"slotId":sid,"status":"replaced"}));
                    } else {
                        if manual {
                            return Err(invalid(
                                "此题已在本卷使用或题型不一致，请重新选择真实题目。",
                            ));
                        }
                        results.push(json!({"slotId":sid,"status":"unchanged","message":"没有合格且未重复的备选题，现题保留。请调整考查任务或补充题库。"}));
                    }
                }
            }
            "points" => {
                if s(&draft["baseline"]["requirements"], "scoringMode") == "none" {
                    return Err(invalid("本卷不计分，不能单独调整题分。"));
                }
                let i = find_slot(&slots, s(op, "slotId"))?;
                let parts = op.get("partPoints").cloned().unwrap_or(json!([]));
                let t = edit_task(&config, &slots[i], manual)?;
                point_validation(&slots[i], &op["points"], &parts, &t)?;
                slots[i]["points"] = op["points"].clone();
                slots[i]["partPoints"] = parts;
            }
            "difficulty" => {
                let semantic = op.get("targetDifficultyLevel");
                if semantic.is_some() && op.get("targetDifficulty").is_some() {
                    return Err(invalid("请只提供一种目标难度，不能同时提供等级与旧数值。"));
                }
                if let Some(level) = semantic {
                    intake::validate_difficulty_level(level)?;
                } else if !op["targetDifficulty"]
                    .as_f64()
                    .is_some_and(|n| (0.0..=1.0).contains(&n))
                {
                    return Err(invalid("目标难度无效。"));
                }
                let ids = if op["slotIds"].is_array() {
                    strings(&op["slotIds"])
                } else {
                    vec![s(op, "slotId").into()]
                };
                for sid in ids {
                    let i = find_slot(&slots, &sid)?;
                    if s(op, "mode") == "automatic" && slots[i]["locked"] == true {
                        continue;
                    }
                    if let Some(level) = semantic {
                        slots[i]["targetDifficultyLevel"] = level.clone();
                        slots[i]["targetDifficulty"] = Value::Null;
                    } else {
                        slots[i]
                            .as_object_mut()
                            .unwrap()
                            .remove("targetDifficultyLevel");
                        slots[i]["targetDifficulty"] = op["targetDifficulty"].clone();
                    }
                }
                results.push(json!({"status":"unknown","message":"仅记录目标难度，现题保留；无学生作答标定。"}));
            }
            "criteria" => {
                let i = find_slot(&slots, s(op, "slotId"))?;
                let t = task(&config, s(op, "taskId"))?;
                if t["questionType"] != slots[i]["questionType"] {
                    return Err(invalid("调整考查任务需保持题型。"));
                }
                if !intake::overlaps(
                    &t["sectionIds"],
                    &draft["baseline"]["requirements"]["mainScope"],
                ) {
                    return Err(invalid("新任务超出已确认范围，请先修改需求基线。"));
                }
                let empty = intake::merge(&slots[i], &json!({"question":null}));
                point_validation(&empty, &slots[i]["points"], &slots[i]["partPoints"], t)?;
                if op.get("teachingGoal").is_some_and(|v| !v.is_null()) {
                    return Err(invalid("教学目标修改请在需求确认中完成后显式更新基线。"));
                }
                slots[i]["taskId"] = t["id"].clone();
                slots[i]["taskLabel"] = t["label"].clone();
                if op.get("targetDifficultyLevel").is_some() && op.get("targetDifficulty").is_some()
                {
                    return Err(invalid("请只提供一种目标难度，不能同时提供等级与旧数值。"));
                }
                if let Some(level) = op.get("targetDifficultyLevel") {
                    intake::validate_difficulty_level(level)?;
                    slots[i]["targetDifficultyLevel"] = level.clone();
                    slots[i]["targetDifficulty"] = Value::Null;
                }
                if let Some(d) = op.get("targetDifficulty") {
                    if !d.is_null() && !d.as_f64().is_some_and(|n| (0.0..=1.0).contains(&n)) {
                        return Err(invalid("目标难度无效。"));
                    }
                    slots[i]["targetDifficulty"] = d.clone();
                    slots[i]
                        .as_object_mut()
                        .unwrap()
                        .remove("targetDifficultyLevel");
                }
                if slots[i]["question"].is_object() {
                    let c = assess(
                        &slots[i]["question"],
                        &slots[i],
                        &draft["baseline"]["requirements"],
                        &config,
                        &HashSet::new(),
                        &HashSet::new(),
                    );
                    slots[i]["applicability"] = c;
                }
                results.push(json!({"status":"updated","message":"已修改本题考查任务，保留现题；请查看候选并确认换题。"}));
            }
            "baseline" => {
                if manual {
                    return Err(invalid(
                        "手动组卷请直接增减题目或修改标题；重新设置教学需求请新建组卷。",
                    ));
                }
                let requirements = intake::normalize(
                    store,
                    &intake::merge(&draft["baseline"]["requirements"], &op["requirements"]),
                )?;
                let mut history = list(&draft["baselineHistory"]);
                history.push(draft["baseline"].clone());
                draft["baselineHistory"] = json!(history);
                draft["baseline"]["requirements"] = requirements.clone();
                draft["baseline"]["version"] =
                    json!(draft["baseline"]["version"].as_u64().unwrap_or(1) + 1);
                draft["baseline"]["slots"] = json!(slots);
                draft["baseline"]["confirmedAt"] = json!(now());
                if let Some(student) = requirements.get("student") {
                    draft["student"] = student.clone();
                } else {
                    draft.as_object_mut().unwrap().remove("student");
                }
                for slot in &mut slots {
                    if slot["question"].is_object() {
                        slot["applicability"] = assess(
                            &slot["question"],
                            slot,
                            &requirements,
                            &config,
                            &HashSet::new(),
                            &HashSet::new(),
                        );
                    }
                }
            }
            "group_by_type" => {}
            _ => return Err(invalid("不支持的草稿操作。")),
        }
        if ["add", "delete", "group_by_type"].contains(&kind) {
            slots.sort_by_key(|slot| {
                TYPES
                    .iter()
                    .position(|k| *k == s(slot, "questionType"))
                    .unwrap_or(3)
            });
        }
        for (i, slot) in slots.iter_mut().enumerate() {
            slot["number"] = json!(i + 1);
        }
        draft["slots"] = json!(slots);
        refresh(&mut draft);
        if manual {
            freeze_assets(&draft)?;
        }
        draft["revision"] = json!(draft["revision"].as_u64().unwrap_or(0) + 1);
        draft["updatedAt"] = json!(now());
        let mut operations = list(&draft["operations"]);
        operations.push(json!({"operationId":oid,"payloadHash":payload_hash,"operation":op,"revision":draft["revision"],"result":{"type":kind,"entries":results}}));
        draft["operations"] = json!(operations);
        store.put_document("drafts", draft_id, &draft)?;
        Ok(json!({"draft":draft,"result":{"type":kind,"entries":results}}))
    })
}
fn confirmation(draft: &Value) -> Value {
    let mut issues = list(&draft["differences"]);
    for slot in list(&draft["slots"])
        .iter()
        .filter(|s| s["question"].is_object())
    {
        let q = &slot["question"];
        for (field, label) in [("answers", "答案"), ("solutions", "解析")] {
            if list(&q["teacher"][field]).is_empty() {
                issues.push(json!({"code":format!("missing_{field}"),"slotId":slot["slotId"],"message":format!("第 {} 题缺少{label}，教师卷将如实标记。",slot["number"])}));
            }
        }
    }
    json!({"title":draft["title"],"draftId":draft["draftId"],"revision":draft["revision"],"stats":draft["stats"],"differences":issues,"requiresAcknowledgement":!issues.is_empty(),"canConfirm":true})
}
fn image_header_matches(mime: &str, bytes: &[u8]) -> bool {
    match mime {
        "image/png" => {
            bytes.len() >= 45
                && bytes.starts_with(b"\x89PNG\r\n\x1a\n")
                && &bytes[12..16] == b"IHDR"
                && &bytes[bytes.len() - 8..bytes.len() - 4] == b"IEND"
        }
        "image/jpeg" => {
            bytes.len() >= 4 && bytes.starts_with(b"\xff\xd8\xff") && bytes.ends_with(b"\xff\xd9")
        }
        "image/gif" => {
            bytes.len() >= 14
                && (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"))
                && bytes.last() == Some(&0x3b)
        }
        "image/webp" => {
            bytes.len() >= 20
                && bytes.starts_with(b"RIFF")
                && &bytes[8..12] == b"WEBP"
                && [b"VP8 ", b"VP8L", b"VP8X"]
                    .iter()
                    .any(|header| &bytes[12..16] == *header)
                && u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize + 8 == bytes.len()
        }
        _ => false,
    }
}
fn freeze_assets(draft: &Value) -> AppResult<Vec<Value>> {
    let mut frozen = Vec::new();
    for slot in list(&draft["slots"]) {
        let question = &slot["question"];
        if !question.is_object() {
            continue;
        }
        let payloads = match question.get("assetPayloads") {
            None => vec![],
            Some(value) => value
                .as_array()
                .cloned()
                .ok_or_else(|| error("integrity_error", "题目内嵌素材格式无效。"))?,
        };
        let mut matched = HashSet::new();
        let mut references = HashSet::new();
        for role in ["student", "teacher"] {
            let refs = match question[role].get("assets") {
                None => vec![],
                Some(value) => value
                    .as_array()
                    .cloned()
                    .ok_or_else(|| error("integrity_error", "题目素材引用需为数组。"))?,
            };
            for reference in refs {
                let asset_id = s(&reference, "assetId");
                let path = s(&reference, "path");
                let mime = s(&reference, "mimeType");
                let sha = s(&reference, "sha256");
                if asset_id.is_empty()
                    || path.is_empty()
                    || path.starts_with('/')
                    || path.contains('\\')
                    || path.contains(':')
                    || path
                        .split('/')
                        .any(|part| part.is_empty() || part == "." || part == "..")
                    || sha.len() != 64
                    || !sha
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    || !references.insert((role.to_owned(), asset_id.to_owned()))
                {
                    return Err(error(
                        "integrity_error",
                        "素材身份、相对路径、哈希或重复引用无效，未使用旧库路径。",
                    ));
                }
                let found: Vec<_> = payloads
                    .iter()
                    .enumerate()
                    .filter(|(_, payload)| {
                        s(payload, "role") == role
                            && s(payload, "assetId") == asset_id
                            && s(payload, "path") == path
                            && s(payload, "sha256") == sha
                            && s(payload, "mimeType") == mime
                    })
                    .collect();
                if found.len() != 1 {
                    return Err(error(
                        "integrity_error",
                        &format!(
                            "第 {} 题的{}素材 {} 缺失或身份不一致，未省略配图。",
                            slot["number"],
                            if role == "student" {
                                "题面"
                            } else {
                                "教师"
                            },
                            asset_id
                        ),
                    ));
                }
                let (index, payload) = found[0];
                matched.insert(index);
                let encoded = s(payload, "dataBase64");
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .map_err(|_| error("integrity_error", "素材 Base64 数据损坏。"))?;
                if bytes.is_empty()
                    || format!("{:x}", Sha256::digest(&bytes)) != sha
                    || !image_header_matches(mime, &bytes)
                {
                    return Err(error(
                        "integrity_error",
                        "素材内容、类型或文件头校验失败，未读取旧库文件或生成遗漏配图的试卷。",
                    ));
                }
                let mut copy = payload.clone();
                copy["slotId"] = slot["slotId"].clone();
                copy["questionId"] = question["questionId"].clone();
                copy["role"] = json!(role);
                frozen.push(copy);
            }
        }
        if matched.len() != payloads.len() {
            return Err(error(
                "integrity_error",
                "内嵌素材含有未关联或重复的题面／教师附件，未混入学生卷。",
            ));
        }
    }
    Ok(frozen)
}
/// Every frozen read/output checks the stored snapshot itself, without reloading
/// a newer bank version or mutating historical teacher data.
pub fn verify_frozen_paper(paper: &Value) -> AppResult<()> {
    let draft = &paper["draft"];
    if paper["schemaVersion"] != 1
        || !draft.is_object()
        || !draft["slots"].is_array()
        || s(paper, "paperId").is_empty()
        || s(draft, "draftId").is_empty()
        || s(paper, "title").trim().is_empty()
        || draft["schemaVersion"] != 1
        || !draft["revision"].is_u64()
        || s(paper, "snapshotSha256") != hash(draft)
        || paper["title"] != draft["title"]
        || paper["sourceDraftId"] != draft["draftId"]
        || paper["sourceRevision"] != draft["revision"]
    {
        return Err(error(
            "integrity_error",
            "成卷快照、名称或来源修订不一致，未读取或输出。",
        ));
    }
    for slot in list(&draft["slots"]) {
        let q = &slot["question"];
        if !q.is_object() {
            continue;
        }
        for (body, prefix, hash_field, version_field) in [
            ("student", "content", "contentSha256", "contentVersion"),
            ("teacher", "teacher", "teacherSha256", "teacherVersion"),
        ] {
            let actual = hash(&q[body]);
            if !q[body].is_object()
                || q[hash_field] != actual
                || q[version_field] != format!("{prefix}-{}", &actual[..16])
            {
                return Err(error(
                    "integrity_error",
                    "成卷题目与冻结的内容版本不一致，未读取或输出。",
                ));
            }
        }
    }
    let assets = freeze_assets(draft)?;
    if paper["assets"] != json!(assets) {
        return Err(error("integrity_error", "成卷冻结素材与题目引用不一致。"));
    }
    Ok(())
}
fn confirm(store: &mut Store, payload: &Value) -> AppResult<Value> {
    let oid = operation_id(payload)?;
    let did = s(payload, "draftId");
    let pid = stable_id("paper", did, oid);
    let ph = hash(payload);
    if !payload["acknowledgeDifferences"].is_boolean() {
        return Err(invalid("请明确确认差异。"));
    }
    transact(store, |store| {
        if let Some(p) = store
            .list_documents("papers")?
            .into_iter()
            .find(|p| s(p, "paperId") == pid)
        {
            verify_frozen_paper(&p)?;
            if s(&p["confirmation"], "payloadHash") != ph {
                return Err(error("operation_conflict", "确认身份已用于不同内容。"));
            }
            return Ok(json!({"paper":p,"replayed":true}));
        }
        let mut draft = store.document("drafts", did)?;
        if draft["confirmedPaperId"].is_string() {
            return Err(error(
                "finalized_draft",
                "草稿已成卷，请使用原操作重试或派生新草稿。",
            ));
        }
        revision(&draft, payload)?;
        let summary = confirmation(&draft);
        if summary["requiresAcknowledgement"] == true && payload["acknowledgeDifferences"] != true {
            return Err(error(
                "confirmation_required",
                "请确认缺题、差异与缺项后再保存成卷。",
            ));
        }
        let assets = freeze_assets(&draft)?;
        // Re-read exact local versions; a modified bank cannot silently alter frozen snapshots.
        for slot in list(&draft["slots"]) {
            if slot["question"].is_object() {
                let q = &slot["question"];
                let original = store.bank.question(s(q, "questionId"))?;
                if q["contentSha256"] != original["contentSha256"]
                    || q["teacherSha256"] != original["teacherSha256"]
                    || q["student"] != original["student"]
                    || q["teacher"] != original["teacher"]
                {
                    return Err(error(
                        "integrity_error",
                        "草稿题目与已核实版本不一致，未确认成卷。",
                    ));
                }
            }
        }
        let timestamp = now();
        let mut paper = json!({"schemaVersion":1,"paperId":pid,"title":draft["title"],"createdAt":timestamp,"sourceDraftId":did,"sourceRevision":draft["revision"],"snapshotSha256":hash(&draft),"confirmation":{"operationId":oid,"payloadHash":ph,"summary":summary},"summary":summary,"draft":draft,"assets":assets});
        if let Some(student) = draft["baseline"]["requirements"].get("student") {
            paper["student"] = student.clone();
        }
        verify_frozen_paper(&paper)?;
        store.put_document("papers", &pid, &paper)?;
        draft["confirmedPaperId"] = json!(pid);
        draft["finalizedAt"] = json!(timestamp);
        draft["updatedAt"] = json!(timestamp);
        draft["revision"] = json!(draft["revision"].as_u64().unwrap_or(0) + 1);
        store.put_document("drafts", did, &draft)?;
        Ok(json!({"paper":paper}))
    })
}
fn derive(store: &mut Store, payload: &Value) -> AppResult<Value> {
    let oid = operation_id(payload)?;
    let pid = s(payload, "paperId");
    let did = stable_id("derived", pid, oid);
    transact(store, |store| {
        let paper = store.document("papers", pid)?;
        verify_frozen_paper(&paper)?;
        if let Some(draft) = store
            .list_documents("drafts")?
            .into_iter()
            .find(|d| s(d, "draftId") == did)
        {
            return Ok(json!({"draft":draft,"replayed":true}));
        }
        let mut draft = paper["draft"].clone();
        draft["draftId"] = json!(did);
        draft["revision"] = json!(0);
        draft["operations"] = json!([]);
        draft["createdAt"] = json!(now());
        draft["updatedAt"] = draft["createdAt"].clone();
        draft["derivedFromPaperId"] = json!(pid);
        for key in ["confirmedPaperId", "finalizedAt", "finalization"] {
            draft.as_object_mut().unwrap().remove(key);
        }
        store.put_document("drafts", &did, &draft)?;
        Ok(json!({"draft":draft}))
    })
}
pub fn dispatch(
    store: &mut Store,
    action: &str,
    payload: &Value,
    model: &ModelClient,
    cancel: &AtomicBool,
) -> AppResult<Option<Value>> {
    let value = match action {
        "intake_prepare" => intake::prepare(store, payload, model, cancel)?,
        "blueprint_plan" => json!({"blueprint":plan(store,payload,model,cancel)?}),
        "blueprint_check" => json!({"blueprint":check_blueprint(store,&payload["blueprint"])?}),
        "draft_create" => create_draft(store, payload, model, cancel)?,
        "manual_draft_create" => manual_draft_create(store, payload, cancel)?,
        "history_delete" => store.delete_history(payload)?,
        "draft_get" => json!({"draft":store.document("drafts",s(payload,"draftId"))?}),
        "draft_operation" => edit(store, payload)?,
        "draft_candidates" => {
            let draft = store.document("drafts", s(payload, "draftId"))?;
            let slots = list(&draft["slots"]);
            let i = find_slot(&slots, s(payload, "slotId"))?;
            let pool = store.bank.questions()?;
            let mut preview = if is_manual(&draft) {
                manual_candidates(&pool, &slots[i], &slots)
            } else {
                candidates(
                    &pool,
                    &slots[i],
                    &draft["baseline"]["requirements"],
                    &store.bank.config()?,
                    &slots,
                )
            };
            for candidate in &mut preview {
                candidate["question"] = pool
                    .iter()
                    .find(|q| q["questionId"] == candidate["questionId"])
                    .ok_or_else(|| error("integrity_error", "备选题内容缺失，未省略内容。"))?
                    .clone();
            }
            json!({"candidates":preview})
        }
        "paper_confirmation" => {
            json!({"summary":confirmation(&store.document("drafts",s(payload,"draftId"))?)})
        }
        "paper_confirm" => confirm(store, payload)?,
        "paper_get" => {
            let paper = store.document("papers", s(payload, "paperId"))?;
            verify_frozen_paper(&paper)?;
            json!({"paper":paper})
        }
        "paper_derive" => derive(store, payload)?,
        _ => return Ok(None),
    };
    Ok(Some(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn simulated_store() -> (tempfile::TempDir, Store, ModelClient) {
        let dir = tempfile::tempdir().unwrap();
        let seed: Value = serde_json::from_str(include_str!("../../resources/seed.json")).unwrap();
        let store = Store::open(dir.path(), &seed).unwrap();
        let model = ModelClient::open(dir.path()).unwrap();
        (dir, store, model)
    }
    fn manual_payload(operation: &str, questions: &[Value]) -> Value {
        json!({"operationId":operation,"title":"模拟手选练习","purpose":"consolidation","durationMinutes":45,"student":null,"selections":questions.iter().map(|q|json!({"questionId":q["questionId"],"contentVersion":q["contentVersion"],"teacherVersion":q["teacherVersion"]})).collect::<Vec<_>>()})
    }
    fn write_simulated_question(store: &Store, question: &Value) {
        let connection =
            rusqlite::Connection::open(store.data_dir.join("question-bank.sqlite")).unwrap();
        connection
            .execute(
                "UPDATE bank_questions SET payload=?1 WHERE id=?2",
                rusqlite::params![question.to_string(), s(question, "questionId")],
            )
            .unwrap();
    }
    #[test]
    fn simulated_five_level_targets_validate_and_inherit_without_guessing_legacy_numbers() {
        let (_dir, store, model) = simulated_store();
        let cancel = AtomicBool::new(false);
        for level in intake::DIFFICULTY_LEVELS {
            let requirements =
                intake::normalize(&store, &json!({"targetDifficultyLevel":level})).unwrap();
            let blueprint = plan(
                &store,
                &json!({"requirements":requirements,"mode":"rule"}),
                &model,
                &cancel,
            )
            .unwrap();
            assert!(
                list(&blueprint["slots"])
                    .iter()
                    .all(|slot| slot["targetDifficultyLevel"] == level
                        && slot["targetDifficulty"].is_null())
            );
            let mut custom = blueprint.clone();
            custom["slots"][0]["targetDifficultyLevel"] = Value::Null;
            custom["slots"][1]["targetDifficultyLevel"] = json!("easy_medium");
            let checked = check_blueprint(&store, &custom).unwrap();
            assert_eq!(
                checked["slots"][0].get("targetDifficultyLevel"),
                Some(&Value::Null)
            );
            assert_eq!(checked["slots"][1]["targetDifficultyLevel"], "easy_medium");
            custom["slots"][0]["targetDifficultyLevel"] = json!("foundation");
            assert!(check_blueprint(&store, &custom).is_err());
        }
        for invalid in [
            json!("unknown"),
            json!(""),
            json!(0.8),
            json!(false),
            json!([]),
        ] {
            assert!(intake::normalize(&store, &json!({"targetDifficultyLevel":invalid})).is_err());
        }
        assert!(intake::normalize(&store, &json!({"targetDifficultyLevel":null})).is_ok());
        let old = plan(
            &store,
            &json!({"requirements":{"targetDifficulty":0.8},"mode":"rule"}),
            &model,
            &cancel,
        )
        .unwrap();
        assert!(old["requirements"].get("targetDifficultyLevel").is_none());
        assert!(
            list(&old["slots"])
                .iter()
                .all(|slot| slot.get("targetDifficultyLevel").is_none())
        );
        let mut old_slot = old;
        old_slot["requirements"]["targetDifficultyLevel"] = json!("hard");
        old_slot["slots"][0]["targetDifficulty"] = json!(0.8);
        let checked = check_blueprint(&store, &old_slot).unwrap();
        assert_eq!(checked["slots"][0]["targetDifficulty"], 0.8);
        assert!(checked["slots"][0].get("targetDifficultyLevel").is_none());
    }
    #[test]
    fn simulated_semantic_difficulty_edits_persist_retry_and_freeze_without_replacing_questions() {
        let (dir, mut store, model) = simulated_store();
        let cancel = AtomicBool::new(false);
        let blueprint = plan(
            &store,
            &json!({"requirements":{"targetDifficultyLevel":"medium_hard"},"mode":"rule"}),
            &model,
            &cancel,
        )
        .unwrap();
        let mut draft = create_draft(
            &mut store,
            &json!({"blueprint":blueprint,"mode":"rule"}),
            &model,
            &cancel,
        )
        .unwrap()["draft"]
            .clone();
        let original_questions = list(&draft["slots"])
            .iter()
            .map(|slot| slot["question"].clone())
            .collect::<Vec<_>>();
        assert!(original_questions.iter().any(Value::is_object));
        let baseline = draft["baseline"].clone();
        let mut first_operation = Value::Null;
        for (index, level) in intake::DIFFICULTY_LEVELS.iter().enumerate() {
            let op = json!({"draftId":draft["draftId"],"operation":{"type":"difficulty","slotId":"slot-1","targetDifficultyLevel":level,"operationId":format!("simulated-semantic-{index}"),"expectedRevision":draft["revision"]}});
            draft = edit(&mut store, &op).unwrap()["draft"].clone();
            if index == 0 {
                first_operation = op.clone();
            }
            assert_eq!(draft["revision"], index + 1);
            assert_eq!(draft["slots"][0]["targetDifficultyLevel"], *level);
            assert_eq!(
                draft["slots"][0].get("targetDifficulty"),
                Some(&Value::Null)
            );
            assert_eq!(edit(&mut store, &op).unwrap()["draft"], draft);
            assert_eq!(
                list(&draft["slots"])
                    .iter()
                    .map(|slot| slot["question"].clone())
                    .collect::<Vec<_>>(),
                original_questions
            );
            assert_eq!(draft["baseline"], baseline);
        }
        let mut reused = first_operation;
        reused["operation"]["targetDifficultyLevel"] = json!("hard");
        assert_eq!(
            edit(&mut store, &reused).unwrap_err().code,
            "operation_conflict"
        );
        let op = |revision: &Value, operation_id: &str, patch: Value| json!({"draftId":draft["draftId"],"operation":intake::merge(&json!({"type":"difficulty","slotId":"slot-1","expectedRevision":revision,"operationId":operation_id}),&patch)});
        assert_eq!(
            edit(
                &mut store,
                &op(
                    &json!(0),
                    "simulated-stale-difficulty",
                    json!({"targetDifficultyLevel":"easy"})
                )
            )
            .unwrap_err()
            .code,
            "revision_conflict"
        );
        for patch in [
            json!({"targetDifficultyLevel":"unknown"}),
            json!({"targetDifficultyLevel":"easy","targetDifficulty":0.8}),
            json!({}),
        ] {
            assert!(
                edit(
                    &mut store,
                    &op(&draft["revision"], "simulated-invalid-difficulty", patch)
                )
                .is_err()
            );
        }
        let legacy = op(
            &draft["revision"],
            "simulated-legacy-difficulty",
            json!({"targetDifficulty":0.8}),
        );
        draft = edit(&mut store, &legacy).unwrap()["draft"].clone();
        assert_eq!(draft["slots"][0]["targetDifficulty"], 0.8);
        assert!(draft["slots"][0].get("targetDifficultyLevel").is_none());
        let clear = json!({"draftId":draft["draftId"],"operation":{"type":"difficulty","slotId":"slot-1","targetDifficultyLevel":null,"operationId":"simulated-clear-difficulty","expectedRevision":draft["revision"]}});
        draft = edit(&mut store, &clear).unwrap()["draft"].clone();
        assert_eq!(
            draft["slots"][0].get("targetDifficultyLevel"),
            Some(&Value::Null)
        );
        assert_eq!(
            draft["slots"][0].get("targetDifficulty"),
            Some(&Value::Null)
        );
        assert_eq!(
            draft["baseline"]["requirements"]["targetDifficultyLevel"],
            "medium_hard"
        );
        drop(store);
        let seed: Value = serde_json::from_str(include_str!("../../resources/seed.json")).unwrap();
        let mut store = Store::open(dir.path(), &seed).unwrap();
        assert_eq!(
            store.document("drafts", s(&draft, "draftId")).unwrap(),
            draft
        );
        assert_eq!(edit(&mut store, &clear).unwrap()["draft"], draft);
        let paper = confirm(&mut store,&json!({"draftId":draft["draftId"],"expectedRevision":draft["revision"],"operationId":"simulated-difficulty-confirm","acknowledgeDifferences":true})).unwrap()["paper"].clone();
        verify_frozen_paper(&paper).unwrap();
        assert_eq!(paper["draft"], draft);
        let derived = derive(
            &mut store,
            &json!({"paperId":paper["paperId"],"operationId":"simulated-difficulty-derive"}),
        )
        .unwrap()["draft"]
            .clone();
        edit(&mut store,&json!({"draftId":derived["draftId"],"operation":{"type":"difficulty","slotId":"slot-1","targetDifficultyLevel":"easy_medium","operationId":"simulated-derived-difficulty","expectedRevision":0}})).unwrap();
        assert_eq!(
            store.document("papers", s(&paper, "paperId")).unwrap(),
            paper
        );
    }
    #[test]
    fn simulated_criteria_saves_task_and_semantic_difficulty_atomically() {
        let (_dir, mut store, model) = simulated_store();
        let cancel = AtomicBool::new(false);
        let blueprint = plan(
            &store,
            &json!({"requirements":{"targetDifficulty":0.8},"mode":"rule"}),
            &model,
            &cancel,
        )
        .unwrap();
        let original = create_draft(
            &mut store,
            &json!({"blueprint":blueprint,"mode":"rule"}),
            &model,
            &cancel,
        )
        .unwrap()["draft"]
            .clone();
        let mut draft = original.clone();
        for (number, level) in [json!("easy_medium"), Value::Null, json!("medium_hard")]
            .into_iter()
            .enumerate()
        {
            let operation = json!({"draftId":draft["draftId"],"operation":{"type":"criteria","slotId":"slot-1","taskId":draft["slots"][0]["taskId"],"targetDifficultyLevel":level,"operationId":format!("simulated-criteria-difficulty-{number}"),"expectedRevision":draft["revision"]}});
            draft = edit(&mut store, &operation).unwrap()["draft"].clone();
            assert_eq!(draft["slots"][0].get("targetDifficultyLevel"), Some(&level));
            assert_eq!(
                draft["slots"][0].get("targetDifficulty"),
                Some(&Value::Null)
            );
            assert_eq!(
                draft["slots"][0]["question"],
                original["slots"][0]["question"]
            );
            assert_eq!(edit(&mut store, &operation).unwrap()["draft"], draft);
        }
        for patch in [
            json!({"targetDifficultyLevel":"foundation"}),
            json!({"targetDifficultyLevel":"hard","targetDifficulty":0.8}),
        ] {
            let operation = intake::merge(
                &json!({"type":"criteria","slotId":"slot-1","taskId":draft["slots"][1]["taskId"],"operationId":"simulated-invalid-criteria-difficulty","expectedRevision":draft["revision"]}),
                &patch,
            );
            assert!(
                edit(
                    &mut store,
                    &json!({"draftId":draft["draftId"],"operation":operation})
                )
                .is_err()
            );
            assert_eq!(
                store.document("drafts", s(&draft, "draftId")).unwrap(),
                draft
            );
        }
        let without_target = json!({"draftId":draft["draftId"],"operation":{"type":"criteria","slotId":"slot-1","taskId":draft["slots"][0]["taskId"],"operationId":"simulated-criteria-retain-difficulty","expectedRevision":draft["revision"]}});
        let retained = edit(&mut store, &without_target).unwrap()["draft"].clone();
        assert_eq!(retained["slots"][0]["targetDifficultyLevel"], "medium_hard");
    }
    #[test]
    fn simulated_multiple_choice_flows_through_planning_manual_editing_and_frozen_paper() {
        let (_dir, mut store, model) = simulated_store();
        let cancel = AtomicBool::new(false);
        let requirements = intake::normalize(&store, &json!({"scoringMode":"none"})).unwrap();
        assert_eq!(requirements["counts"]["multiple_choice"], 0);
        let no_supply = intake::normalize(&store,&json!({"counts":{"single_choice":0,"multiple_choice":2,"fill_blank":0,"free_response":0},"scoringMode":"none"})).unwrap();
        let no_task = plan(
            &store,
            &json!({"requirements":no_supply,"mode":"rule"}),
            &model,
            &cancel,
        )
        .unwrap_err();
        assert!(no_task.message.contains("2 道多选题"));
        assert!(no_task.message.contains("题量未改变"));
        assert!(store.list_documents("drafts").unwrap().is_empty());
        let original = plan(
            &store,
            &json!({"requirements":requirements,"mode":"rule"}),
            &model,
            &cancel,
        )
        .unwrap();
        let slot = &original["slots"][0];
        let pool = store.bank.questions().unwrap();
        let mut config = store.bank.config().unwrap();
        let candidate = candidates(&pool, slot, &requirements, &config, &[])
            .into_iter()
            .find(|candidate| s(candidate, "status") == "eligible")
            .unwrap();
        let mut question = pool
            .into_iter()
            .find(|q| q["questionId"] == candidate["questionId"])
            .unwrap();
        // Synthetic type fixture in a temporary bank only; never reclassify production questions.
        question["questionType"] = json!("multiple_choice");
        write_simulated_question(&store, &question);
        let task = config["tasks"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|task| task["id"] == slot["taskId"])
            .unwrap();
        task["questionType"] = json!("multiple_choice");
        task["label"] = json!("模拟多选考查任务");
        let connection =
            rusqlite::Connection::open(store.data_dir.join("question-bank.sqlite")).unwrap();
        connection
            .execute(
                "UPDATE bank_metadata SET value=?1 WHERE key='config'",
                [config.to_string()],
            )
            .unwrap();

        let requirements = intake::normalize(&store, &json!({"scoringMode":"none","counts":{"single_choice":0,"multiple_choice":2,"fill_blank":0,"free_response":0}})).unwrap();
        let blueprint = plan(
            &store,
            &json!({"requirements":requirements,"mode":"rule"}),
            &model,
            &cancel,
        )
        .unwrap();
        assert_eq!(blueprint["slots"].as_array().unwrap().len(), 2);
        assert!(
            list(&blueprint["slots"])
                .iter()
                .all(|slot| slot["questionType"] == "multiple_choice")
        );
        let draft = create_draft(
            &mut store,
            &json!({"blueprint":blueprint,"mode":"rule"}),
            &model,
            &cancel,
        )
        .unwrap()["draft"]
            .clone();
        assert_eq!(draft["stats"]["actualCount"], 1);
        assert_eq!(draft["stats"]["missingCount"], 1);
        let paper = confirm(&mut store,&json!({"draftId":draft["draftId"],"expectedRevision":draft["revision"],"operationId":"simulated-multiple-confirm","acknowledgeDifferences":true})).unwrap()["paper"].clone();
        verify_frozen_paper(&paper).unwrap();
        assert_eq!(paper["draft"]["slots"].as_array().unwrap().len(), 2);
        assert!(
            list(&paper["draft"]["slots"])
                .iter()
                .any(|slot| slot["question"]["questionType"] == "multiple_choice")
        );

        let manual = manual_draft_create(
            &mut store,
            &manual_payload("simulated-multiple-manual", &[question.clone()]),
            &cancel,
        )
        .unwrap()["draft"]
            .clone();
        assert_eq!(
            manual["baseline"]["requirements"]["counts"]["multiple_choice"],
            1
        );
        assert_eq!(manual["slots"][0]["question"], question);
        let edited = edit(&mut store,&json!({"draftId":manual["draftId"],"operation":{"type":"add","questionType":"multiple_choice","operationId":"simulated-multiple-add","expectedRevision":manual["revision"]}})).unwrap()["draft"].clone();
        assert_eq!(edited["slots"][1]["questionType"], "multiple_choice");
        assert_eq!(edited["stats"]["missingCount"], 1);
    }
    #[test]
    fn simulated_deleted_history_is_inaccessible_without_cascading_to_independent_work() {
        let (_dir, mut store, model) = simulated_store();
        let cancel = AtomicBool::new(false);
        let question = store
            .bank
            .questions()
            .unwrap()
            .into_iter()
            .find(|q| s(q, "questionType") == "single_choice")
            .unwrap();
        let creation = manual_payload("history-create", &[question]);
        let draft = manual_draft_create(&mut store, &creation, &cancel).unwrap()["draft"].clone();
        let confirmation = json!({"draftId":draft["draftId"],"expectedRevision":draft["revision"],"operationId":"history-confirm","acknowledgeDifferences":true});
        let paper = confirm(&mut store, &confirmation).unwrap()["paper"].clone();
        let derivation = json!({"paperId":paper["paperId"],"operationId":"history-derive"});
        let derived = derive(&mut store, &derivation).unwrap()["draft"].clone();
        let source = store.document("drafts", s(&draft, "draftId")).unwrap();
        let deleted = dispatch(&mut store, "history_delete", &json!({"kind":"draft","id":source["draftId"],"expectedRevision":source["revision"],"operationId":"history-delete-source"}), &model, &cancel).unwrap().unwrap();
        assert_eq!(deleted["deleted"], true);
        assert_eq!(deleted["kind"], "draft");
        for (action, payload) in [
            ("draft_get", json!({"draftId":draft["draftId"]})),
            (
                "draft_candidates",
                json!({"draftId":draft["draftId"],"slotId":"slot-1"}),
            ),
            (
                "draft_operation",
                json!({"draftId":draft["draftId"],"operation":{"type":"rename","title":"禁止恢复","operationId":"deleted-edit","expectedRevision":source["revision"]}}),
            ),
            ("paper_confirmation", json!({"draftId":draft["draftId"]})),
        ] {
            assert_eq!(
                dispatch(&mut store, action, &payload, &model, &cancel)
                    .unwrap_err()
                    .code,
                "not_found",
                "{action}"
            );
        }
        assert_eq!(
            store.document("papers", s(&paper, "paperId")).unwrap(),
            paper
        );
        assert_eq!(
            manual_draft_create(&mut store, &creation, &cancel)
                .unwrap_err()
                .code,
            "not_found"
        );
        let deletion =
            json!({"kind":"paper","id":paper["paperId"],"operationId":"history-delete-paper"});
        dispatch(&mut store, "history_delete", &deletion, &model, &cancel).unwrap();
        assert_eq!(
            dispatch(&mut store, "history_delete", &deletion, &model, &cancel)
                .unwrap()
                .unwrap()["replayed"],
            true
        );
        for (action, payload) in [
            ("paper_get", json!({"paperId":paper["paperId"]})),
            ("paper_derive", derivation),
            ("paper_confirm", confirmation),
        ] {
            assert!(
                dispatch(&mut store, action, &payload, &model, &cancel).is_err(),
                "{action}"
            );
        }
        assert_eq!(
            store.document("drafts", s(&derived, "draftId")).unwrap(),
            derived
        );
        let edited = edit(&mut store, &json!({"draftId":derived["draftId"],"operation":{"type":"rename","title":"模拟独立草稿仍可编辑","operationId":"history-independent-edit","expectedRevision":derived["revision"]}})).unwrap();
        assert_eq!(edited["draft"]["title"], "模拟独立草稿仍可编辑");
        assert_eq!(store.list_documents("drafts").unwrap().len(), 1);
        assert!(store.list_documents("papers").unwrap().is_empty());
    }
    #[test]
    fn simulated_manual_creation_preserves_exact_versions_order_and_student_without_model() {
        let (dir, mut store, _) = simulated_store();
        std::fs::write(
            dir.path().join("model-settings.json"),
            br#"{"schemaVersion":2,"revision":0,"activeProfileId":null,"profiles":[]}"#,
        )
        .unwrap();
        let model = ModelClient::open(dir.path()).unwrap();
        assert!(!model.configured());
        let pool = store.bank.questions().unwrap();
        let singles: Vec<_> = pool
            .iter()
            .filter(|q| s(q, "questionType") == "single_choice")
            .take(2)
            .cloned()
            .collect();
        let fill = pool
            .iter()
            .find(|q| s(q, "questionType") == "fill_blank")
            .unwrap()
            .clone();
        let free = pool
            .iter()
            .find(|q| s(q, "questionType") == "free_response")
            .unwrap()
            .clone();
        let chosen = vec![
            free.clone(),
            singles[1].clone(),
            fill.clone(),
            singles[0].clone(),
        ];
        let student = store
            .create_student(
                &json!({"name":"模拟私密学生","grade":"高一","operationId":"manual-student"}),
            )
            .unwrap();
        let mut payload = manual_payload("manual-exact-order", &chosen);
        payload["student"] = json!({"studentId":student["studentId"],"name":"不可伪造的姓名"});
        let response = dispatch(
            &mut store,
            "manual_draft_create",
            &payload,
            &model,
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
        let draft = &response["draft"];
        let expected = vec![singles[1].clone(), singles[0].clone(), fill, free];
        assert_eq!(draft["selectionGeneration"]["mode"], "manual");
        assert_eq!(
            draft["baseline"]["confirmationMode"],
            "teacher_manual_selection"
        );
        assert_eq!(draft["baseline"]["requirements"]["mainScope"], json!([]));
        assert_eq!(
            draft["baseline"]["requirements"]["counts"],
            json!({"single_choice":2,"multiple_choice":0,"fill_blank":1,"free_response":1})
        );
        assert_eq!(draft["stats"]["actualCount"], 4);
        assert_eq!(draft["stats"]["missingCount"], 0);
        assert_eq!(draft["stats"]["plannedPoints"], 0);
        assert_eq!(draft["student"], student);
        assert_eq!(draft["baseline"]["requirements"]["student"], student);
        assert_eq!(draft["differences"], json!([]));
        for (index, slot) in list(&draft["slots"]).iter().enumerate() {
            assert_eq!(slot["number"], index + 1);
            assert_eq!(slot["question"], expected[index]);
            assert_eq!(slot["applicability"]["status"], "teacher_selected");
            assert_eq!(slot["applicability"]["teachingMatchVerified"], false);
            assert_eq!(draft["baseline"]["slots"][index]["slotId"], slot["slotId"]);
        }
        let mut changed = payload.clone();
        changed["title"] = json!("不同创建内容");
        assert_eq!(
            manual_draft_create(&mut store, &changed, &AtomicBool::new(false))
                .unwrap_err()
                .code,
            "operation_conflict"
        );
        assert_eq!(
            manual_draft_create(&mut store, &payload, &AtomicBool::new(false)).unwrap()["draft"],
            *draft
        );
        assert_eq!(store.list_documents("drafts").unwrap().len(), 1);
        // Reopening the actual local DB preserves operation identity and exact snapshots.
        drop(store);
        let seed: Value = serde_json::from_str(include_str!("../../resources/seed.json")).unwrap();
        let mut reopened = Store::open(dir.path(), &seed).unwrap();
        let replay = manual_draft_create(&mut reopened, &payload, &AtomicBool::new(false)).unwrap();
        assert_eq!(replay["replayed"], true);
        assert_eq!(replay["draft"], *draft);
        assert!(!dir.path().join("llm-runs").exists());
    }
    #[test]
    fn simulated_manual_quantity_accepts_one_and_sixty_including_over_thirty_one_type() {
        let (_dir, mut store, _model) = simulated_store();
        let pool: Vec<_> = store
            .bank
            .questions()
            .unwrap()
            .into_iter()
            .filter(|q| s(q, "questionType") == "single_choice")
            .take(61)
            .collect();
        for count in [1, 31, 60] {
            let response = manual_draft_create(
                &mut store,
                &manual_payload(&format!("manual-count-{count}"), &pool[..count]),
                &AtomicBool::new(false),
            )
            .unwrap();
            let draft = &response["draft"];
            assert_eq!(list(&draft["slots"]).len(), count);
            assert_eq!(
                draft["baseline"]["requirements"]["counts"]["single_choice"],
                count
            );
            assert_eq!(draft["stats"]["selectedCount"], count);
            assert_eq!(draft["differences"], json!([]));
            if count == 60 {
                let q = &pool[60];
                assert_eq!(edit(&mut store,&json!({"draftId":draft["draftId"],"operation":{"type":"add","operationId":"manual-over-sixty","expectedRevision":0,"questionType":"single_choice","candidateId":q["questionId"],"contentVersion":q["contentVersion"],"teacherVersion":q["teacherVersion"]}})).unwrap_err().code,"invalid_plan");
                assert_eq!(
                    store.document("drafts", s(draft, "draftId")).unwrap(),
                    *draft
                );
            }
        }
        for chosen in [&pool[..0], &pool[..61]] {
            assert_eq!(
                manual_draft_create(
                    &mut store,
                    &manual_payload("manual-bad-count", chosen),
                    &AtomicBool::new(false)
                )
                .unwrap_err()
                .code,
                "invalid_plan"
            );
        }
        assert_eq!(store.list_documents("drafts").unwrap().len(), 3);
    }
    #[test]
    fn simulated_manual_rejects_bad_inputs_stale_and_unpublished_without_partial_drafts() {
        let (_dir, mut store, _model) = simulated_store();
        let pool = store.bank.questions().unwrap();
        let original = manual_payload("manual-bad-input", &pool[..2]);
        for (field, value) in [
            ("title", json!("")),
            ("title", json!("x".repeat(121))),
            ("purpose", json!("exam")),
            ("durationMinutes", json!(0)),
            ("durationMinutes", json!(301)),
            ("durationMinutes", json!(1.5)),
            ("operationId", json!("bad/id")),
            ("student", json!({"studentId":"missing"})),
        ] {
            let mut payload = original.clone();
            payload[field] = value;
            assert!(
                manual_draft_create(&mut store, &payload, &AtomicBool::new(false)).is_err(),
                "{field}"
            );
            assert!(store.list_documents("drafts").unwrap().is_empty());
        }
        let seed: Value = serde_json::from_str(include_str!("../../resources/seed.json")).unwrap();
        let pending = list(&seed["bankSnapshot"]["ledger"]["entries"])
            .into_iter()
            .find(|entry| s(entry, "status") != "ready")
            .unwrap();
        for (field, value, code) in [
            ("contentVersion", json!("outdated"), "version_conflict"),
            ("teacherVersion", json!("outdated"), "version_conflict"),
            ("contentVersion", Value::Null, "invalid_plan"),
            ("questionId", json!("missing"), "not_found"),
            ("questionId", pending["questionId"].clone(), "not_found"),
        ] {
            let mut payload = original.clone();
            payload["selections"][1][field] = value;
            assert_eq!(
                manual_draft_create(&mut store, &payload, &AtomicBool::new(false))
                    .unwrap_err()
                    .code,
                code,
                "{field}"
            );
            assert!(store.list_documents("drafts").unwrap().is_empty());
        }
        let mut duplicate = original.clone();
        duplicate["selections"][1] = duplicate["selections"][0].clone();
        assert_eq!(
            manual_draft_create(&mut store, &duplicate, &AtomicBool::new(false))
                .unwrap_err()
                .code,
            "invalid_plan"
        );
        assert!(store.list_documents("drafts").unwrap().is_empty());
    }
    #[test]
    fn simulated_manual_bank_tampering_and_valid_version_updates_fail_atomically() {
        let (_dir, mut store, _model) = simulated_store();
        let pool = store.bank.questions().unwrap();
        let payload = manual_payload("manual-bank-change", &pool[..2]);
        let mut changed = pool[1].clone();
        changed["student"]["stem"] = json!("模拟已更新版本 $x+1$");
        write_simulated_question(&store, &changed);
        assert_eq!(
            manual_draft_create(&mut store, &payload, &AtomicBool::new(false))
                .unwrap_err()
                .code,
            "integrity_error"
        );
        assert!(store.list_documents("drafts").unwrap().is_empty());
        let content_hash = hash(&changed["student"]);
        let version = format!("content-{}", &content_hash[..16]);
        changed["contentSha256"] = json!(content_hash);
        changed["contentVersion"] = json!(version);
        changed["verification"]["contentVersion"] = json!(version);
        write_simulated_question(&store, &changed);
        assert_eq!(
            manual_draft_create(&mut store, &payload, &AtomicBool::new(false))
                .unwrap_err()
                .code,
            "version_conflict"
        );
        assert!(store.list_documents("drafts").unwrap().is_empty());
        changed = pool[1].clone();
        changed["verification"]["result"] = json!("pending");
        write_simulated_question(&store, &changed);
        assert_eq!(
            manual_draft_create(&mut store, &payload, &AtomicBool::new(false))
                .unwrap_err()
                .code,
            "integrity_error"
        );
        changed = pool[1].clone();
        changed["questionType"] = json!("simulated_unsupported_type");
        write_simulated_question(&store, &changed);
        assert_eq!(
            manual_draft_create(&mut store, &payload, &AtomicBool::new(false))
                .unwrap_err()
                .code,
            "integrity_error"
        );
        assert!(store.list_documents("drafts").unwrap().is_empty());
    }
    #[test]
    fn simulated_manual_cancel_and_storage_failure_are_retryable_without_partial_results() {
        let (_dir, mut store, _model) = simulated_store();
        let pool = store.bank.questions().unwrap();
        let payload = manual_payload("manual-retry-after-cancel", &pool[..2]);
        let cancel = AtomicBool::new(true);
        assert_eq!(
            manual_draft_create(&mut store, &payload, &cancel)
                .unwrap_err()
                .code,
            "cancelled"
        );
        assert!(store.list_documents("drafts").unwrap().is_empty());
        cancel.store(false, Ordering::Relaxed);
        store.user.execute_batch("CREATE TRIGGER simulated_manual_failure BEFORE INSERT ON documents WHEN NEW.kind='drafts' BEGIN SELECT RAISE(ABORT,'simulated_no_space'); END;").unwrap();
        assert_eq!(
            manual_draft_create(&mut store, &payload, &cancel)
                .unwrap_err()
                .code,
            "storage_error"
        );
        assert!(store.list_documents("drafts").unwrap().is_empty());
        assert!(store.user.is_autocommit());
        store
            .user
            .execute_batch("DROP TRIGGER simulated_manual_failure")
            .unwrap();
        let created = manual_draft_create(&mut store, &payload, &cancel).unwrap();
        assert_eq!(created["draft"]["stats"]["actualCount"], 2);
        assert_eq!(
            manual_draft_create(&mut store, &payload, &cancel).unwrap()["replayed"],
            true
        );
        assert_eq!(store.list_documents("drafts").unwrap().len(), 1);
    }
    #[test]
    fn simulated_manual_edit_replace_add_finalize_and_derive_preserve_boundaries() {
        let (_dir, mut store, model) = simulated_store();
        let cancel = AtomicBool::new(false);
        let singles: Vec<_> = store
            .bank
            .questions()
            .unwrap()
            .into_iter()
            .filter(|q| s(q, "questionType") == "single_choice")
            .take(4)
            .collect();
        let mut draft = manual_draft_create(
            &mut store,
            &manual_payload("manual-editing", &singles[..2]),
            &cancel,
        )
        .unwrap()["draft"]
            .clone();
        let mut apply = |operation: Value| -> AppResult<Value> {
            let operation = intake::merge(
                &operation,
                &json!({"operationId":format!("manual-edit-{}",draft["revision"]),"expectedRevision":draft["revision"]}),
            );
            let result = edit(
                &mut store,
                &json!({"draftId":draft["draftId"],"operation":operation}),
            );
            if let Ok(result) = &result {
                draft = result["draft"].clone();
            }
            result
        };
        assert_eq!(
            apply(json!({"type":"replace","mode":"automatic","slotIds":["slot-1"]}))
                .unwrap_err()
                .code,
            "invalid_plan"
        );
        apply(json!({"type":"lock","slotId":"slot-1","locked":true})).unwrap();
        assert_eq!(apply(json!({"type":"replace","mode":"direct","slotIds":["slot-1"],"candidateId":singles[1]["questionId"],"contentVersion":singles[1]["contentVersion"],"teacherVersion":singles[1]["teacherVersion"]})).unwrap_err().code,"invalid_plan");
        assert_eq!(apply(json!({"type":"replace","mode":"direct","slotIds":["slot-1"],"candidateId":singles[2]["questionId"],"contentVersion":"stale","teacherVersion":singles[2]["teacherVersion"]})).unwrap_err().code,"version_conflict");
        apply(json!({"type":"replace","mode":"direct","slotIds":["slot-1"],"candidateId":singles[2]["questionId"],"contentVersion":singles[2]["contentVersion"],"teacherVersion":singles[2]["teacherVersion"]})).unwrap();
        apply(json!({"type":"add","questionType":"single_choice","candidateId":singles[3]["questionId"],"contentVersion":singles[3]["contentVersion"],"teacherVersion":singles[3]["teacherVersion"]})).unwrap();
        assert_eq!(apply(json!({"type":"add","questionType":"single_choice","candidateId":singles[0]["questionId"],"contentVersion":"stale","teacherVersion":singles[0]["teacherVersion"]})).unwrap_err().code,"version_conflict");
        apply(json!({"type":"delete","slotId":"slot-2"})).unwrap();
        apply(json!({"type":"rename","title":"模拟教师改名"})).unwrap();
        drop(apply);
        assert_eq!(draft["slots"][0]["question"], singles[2]);
        assert_eq!(draft["slots"][1]["question"], singles[3]);
        assert_eq!(draft["slots"][0]["locked"], true);
        assert!(
            !list(&draft["differences"])
                .iter()
                .any(|d| s(d, "code") == "applicability_unconfirmed")
        );
        let preview = dispatch(
            &mut store,
            "draft_candidates",
            &json!({"draftId":draft["draftId"],"slotId":"slot-1"}),
            &model,
            &cancel,
        )
        .unwrap()
        .unwrap();
        let used = list(&preview["candidates"])
            .into_iter()
            .find(|c| c["questionId"] == singles[3]["questionId"])
            .unwrap();
        assert_eq!(used["canSelect"], false);
        assert_eq!(used["duplicate"], true);
        let available = list(&preview["candidates"])
            .into_iter()
            .find(|c| c["questionId"] == singles[0]["questionId"])
            .unwrap();
        assert_eq!(available["canSelect"], true);
        assert_eq!(available["status"], "teacher_selected");
        let paper=confirm(&mut store,&json!({"draftId":draft["draftId"],"expectedRevision":draft["revision"],"operationId":"manual-finalize","acknowledgeDifferences":true})).unwrap()["paper"].clone();
        verify_frozen_paper(&paper).unwrap();
        assert_eq!(paper["draft"]["slots"], draft["slots"]);
        assert_eq!(edit(&mut store,&json!({"draftId":draft["draftId"],"operation":{"type":"rename","operationId":"manual-finalized-edit","expectedRevision":draft["revision"],"title":"禁止"}})).unwrap_err().code,"finalized_draft");
        let derived = derive(
            &mut store,
            &json!({"paperId":paper["paperId"],"operationId":"manual-derive"}),
        )
        .unwrap()["draft"]
            .clone();
        assert!(is_manual(&derived));
        assert_eq!(derived["slots"], draft["slots"]);
        assert_eq!(
            store.document("papers", s(&paper, "paperId")).unwrap(),
            paper
        );
    }
    #[test]
    fn simulated_manual_free_response_replacement_and_add_use_actual_part_identities() {
        let (_dir, mut store, _model) = simulated_store();
        let free: Vec<_> = store
            .bank
            .questions()
            .unwrap()
            .into_iter()
            .filter(|q| s(q, "questionType") == "free_response")
            .take(3)
            .collect();
        let payload = manual_payload("manual-free-response", &free[..1]);
        let mut draft = manual_draft_create(&mut store, &payload, &AtomicBool::new(false)).unwrap()
            ["draft"]
            .clone();
        let op = json!({"type":"replace","operationId":"manual-free-replace","expectedRevision":0,"mode":"direct","slotIds":["slot-1"],"candidateId":free[1]["questionId"],"contentVersion":free[1]["contentVersion"],"teacherVersion":free[1]["teacherVersion"]});
        draft = edit(
            &mut store,
            &json!({"draftId":draft["draftId"],"operation":op}),
        )
        .unwrap()["draft"]
            .clone();
        let expected: Vec<_> = list(&free[1]["student"]["parts"])
            .iter()
            .map(|part| json!({"partId":part["partId"],"points":0}))
            .collect();
        assert_eq!(draft["slots"][0]["partPoints"], json!(expected));
        let op = json!({"type":"add","operationId":"manual-free-add","expectedRevision":1,"questionType":"free_response","candidateId":free[2]["questionId"],"contentVersion":free[2]["contentVersion"],"teacherVersion":free[2]["teacherVersion"]});
        draft = edit(
            &mut store,
            &json!({"draftId":draft["draftId"],"operation":op}),
        )
        .unwrap()["draft"]
            .clone();
        let expected: Vec<_> = list(&free[2]["student"]["parts"])
            .iter()
            .map(|part| json!({"partId":part["partId"],"points":0}))
            .collect();
        assert_eq!(draft["slots"][1]["partPoints"], json!(expected));
        assert_eq!(draft["slots"][1]["question"], free[2]);
        let replay = edit(
            &mut store,
            &json!({"draftId":draft["draftId"],"operation":op}),
        )
        .unwrap();
        assert_eq!(replay["replayed"], true);
        assert_eq!(replay["draft"], draft);
        let mut changed = op.clone();
        changed["candidateId"] = free[0]["questionId"].clone();
        assert_eq!(
            edit(
                &mut store,
                &json!({"draftId":draft["draftId"],"operation":changed})
            )
            .unwrap_err()
            .code,
            "operation_conflict"
        );
        assert!(
            !list(&draft["differences"])
                .iter()
                .any(|d| s(d, "code") == "applicability_unconfirmed")
        );
        let paper=confirm(&mut store,&json!({"draftId":draft["draftId"],"expectedRevision":2,"operationId":"manual-free-confirm","acknowledgeDifferences":true})).unwrap()["paper"].clone();
        verify_frozen_paper(&paper).unwrap();
        assert_eq!(paper["draft"]["slots"], draft["slots"]);
    }
    #[test]
    fn assignment_maximizes_real_supply() {
        let rows = vec![
            vec![("a".into(), "a".into()), ("b".into(), "b".into())],
            vec![("a".into(), "a".into())],
        ];
        let result = assignment(&rows);
        assert_eq!(result.len(), 2);
        assert_eq!(result[&0], "b");
        assert_eq!(result[&1], "a");
    }
    #[test]
    fn duplicate_group_cannot_fill_two_slots() {
        assert_eq!(
            assignment(&[
                vec![("a".into(), "same".into())],
                vec![("b".into(), "same".into())]
            ])
            .len(),
            1
        );
    }
    #[test]
    fn unknown_versions_never_eligible() {
        let q = json!({"questionId":"q","questionType":"single_choice","contentVersion":"new","teacherVersion":"t","sourceRefs":[{"sourceId":"source"}]});
        let config = json!({"assemblyIndex":{"entries":[{"questionId":"q","contentVersion":"old","teacherVersion":"t","primarySections":["1.1"],"duplicateGroup":"g"}]}});
        let result = assess(
            &q,
            &json!({"taskId":"task"}),
            &json!({"sourceIds":["source"]}),
            &config,
            &HashSet::new(),
            &HashSet::new(),
        );
        assert_eq!(result["status"], "unknown");
        assert_eq!(result["canSelect"], false);
    }
    #[test]
    fn complete_path_and_required_goal_evidence_are_not_model_guesses() {
        let q = json!({"questionId":"q","questionType":"single_choice","contentVersion":"c","teacherVersion":"t","sourceRefs":[{"sourceId":"source"}]});
        let config = json!({"assemblyIndex":{"entries":[{"questionId":"q","contentVersion":"c","teacherVersion":"t","tasks":["task"],"primarySections":["1.1"],"duplicateGroup":"g","solutionPaths":[{"id":"path","requiredSections":["1.1"],"requiredPremises":["vieta"],"basis":"模拟完整解法依据"}]}]}});
        let slot = json!({"taskId":"task","goalIds":[]});
        let mut r = json!({"mainScope":["1.1"],"learnedScope":["1.1"],"sourceIds":["source"],"premises":[],"foundationPremises":[],"teachingGoals":[]});
        assert_eq!(
            assess(&q, &slot, &r, &config, &HashSet::new(), &HashSet::new())["status"],
            "unknown"
        );
        r["premises"] = json!(["vieta"]);
        assert_eq!(
            assess(&q, &slot, &r, &config, &HashSet::new(), &HashSet::new())["status"],
            "eligible"
        );
        r["teachingGoals"] = json!([{"id":"g1","priority":"required"}]);
        let slot = intake::merge(&slot, &json!({"goalIds":["g1"]}));
        assert_eq!(
            assess(&q, &slot, &r, &config, &HashSet::new(), &HashSet::new())["status"],
            "unknown"
        );
    }
    fn simulated_knowledge_assessment() -> (Value, Value, Value, Value) {
        let question = json!({"questionId":"simulated-knowledge-question","contentVersion":"simulated-content","teacherVersion":"simulated-teacher","sourceRefs":[{"sourceId":"simulated-source"}]});
        let slot = json!({"taskId":"simulated-task","goalIds":[]});
        let requirements = json!({"mainScope":["1.1"],"learnedScope":["1.1"],"mainKnowledgeUids":["simulated-a"],"learnedKnowledgeUids":["simulated-a"],"sourceIds":["simulated-source"],"premises":[],"foundationPremises":[],"teachingGoals":[]});
        let config = json!({"knowledgeCatalogue":{"points":[
            {"uid":"simulated-root","parentUid":null,"sectionIds":["rja-compulsory-1:1.1"]},
            {"uid":"simulated-a","parentUid":"simulated-root","sectionIds":["rja-compulsory-1:1.1"]},
            {"uid":"simulated-b","parentUid":"simulated-root","sectionIds":["rja-compulsory-1:1.1"]}
        ]},"assemblyIndex":{"entries":[{"questionId":"simulated-knowledge-question","contentVersion":"simulated-content","teacherVersion":"simulated-teacher","tasks":["simulated-task"],"primarySections":["1.1"],"primaryKnowledgeUids":["simulated-a"],"duplicateGroup":"simulated-group","solutionPaths":[{"id":"simulated-path","requiredSections":["1.1"],"requiredKnowledgeUids":["simulated-a"],"requiredPremises":[],"basis":"模拟回归：完整解法仅需知识点 A。"}]}]}});
        (question, slot, requirements, config)
    }
    #[test]
    fn simulated_knowledge_scope_distinguishes_points_in_the_same_section() {
        let (question, slot, mut requirements, config) = simulated_knowledge_assessment();
        let eligible = assess(
            &question,
            &slot,
            &requirements,
            &config,
            &HashSet::new(),
            &HashSet::new(),
        );
        assert_eq!(eligible["canSelect"], true);
        requirements["mainKnowledgeUids"] = json!(["simulated-b"]);
        let excluded = assess(
            &question,
            &slot,
            &requirements,
            &config,
            &HashSet::new(),
            &HashSet::new(),
        );
        assert_eq!(excluded["canSelect"], false);
        assert_eq!(excluded["status"], "related");
        assert!(
            strings(&excluded["reasons"])
                .iter()
                .any(|reason| reason.contains("主考范围"))
        );
        // Choosing a parent includes its catalogue descendants, without graph inference.
        requirements["mainKnowledgeUids"] = json!(["simulated-root"]);
        assert_eq!(
            assess(
                &question,
                &slot,
                &requirements,
                &config,
                &HashSet::new(),
                &HashSet::new()
            )["canSelect"],
            true
        );
        // Existing section-based requirements remain a valid entry point for new annotations.
        requirements
            .as_object_mut()
            .unwrap()
            .remove("mainKnowledgeUids");
        requirements
            .as_object_mut()
            .unwrap()
            .remove("learnedKnowledgeUids");
        assert_eq!(
            assess(
                &question,
                &slot,
                &requirements,
                &config,
                &HashSet::new(),
                &HashSet::new()
            )["canSelect"],
            true
        );
    }
    #[test]
    fn simulated_legacy_sections_do_not_override_explicit_knowledge_boundaries() {
        let (question, slot, mut requirements, mut config) = simulated_knowledge_assessment();
        config["assemblyIndex"]["entries"][0]
            .as_object_mut()
            .unwrap()
            .remove("primaryKnowledgeUids");
        config["assemblyIndex"]["entries"][0]["solutionPaths"][0]
            .as_object_mut()
            .unwrap()
            .remove("requiredKnowledgeUids");
        assert_eq!(
            assess(
                &question,
                &slot,
                &requirements,
                &config,
                &HashSet::new(),
                &HashSet::new()
            )["status"],
            "unknown"
        );
        requirements
            .as_object_mut()
            .unwrap()
            .remove("mainKnowledgeUids");
        requirements
            .as_object_mut()
            .unwrap()
            .remove("learnedKnowledgeUids");
        assert_eq!(
            assess(
                &question,
                &slot,
                &requirements,
                &config,
                &HashSet::new(),
                &HashSet::new()
            )["canSelect"],
            true
        );
    }
    #[test]
    fn simulated_knowledge_boundary_accepts_one_complete_allowed_solution_path() {
        let (question, slot, requirements, mut config) = simulated_knowledge_assessment();
        let entry = &mut config["assemblyIndex"]["entries"][0];
        let mut unavailable = entry["solutionPaths"][0].clone();
        unavailable["id"] = json!("simulated-needs-b");
        unavailable["requiredKnowledgeUids"] = json!(["simulated-a", "simulated-b"]);
        entry["solutionPaths"] = json!([unavailable]);
        assert_eq!(
            assess(
                &question,
                &slot,
                &requirements,
                &config,
                &HashSet::new(),
                &HashSet::new()
            )["status"],
            "unknown"
        );
        let mut available = config["assemblyIndex"]["entries"][0]["solutionPaths"][0].clone();
        available["id"] = json!("simulated-only-a");
        available["requiredKnowledgeUids"] = json!(["simulated-a"]);
        config["assemblyIndex"]["entries"][0]["solutionPaths"]
            .as_array_mut()
            .unwrap()
            .push(available);
        let result = assess(
            &question,
            &slot,
            &requirements,
            &config,
            &HashSet::new(),
            &HashSet::new(),
        );
        assert_eq!(result["canSelect"], true);
        assert_eq!(result["allowedSolutionPath"]["id"], "simulated-only-a");
        config["assemblyIndex"]["entries"][0]["solutionPaths"][1]["requiredPremises"] =
            json!(["simulated-tool"]);
        assert_eq!(
            assess(
                &question,
                &slot,
                &requirements,
                &config,
                &HashSet::new(),
                &HashSet::new()
            )["status"],
            "unknown"
        );
        let mut permitted = requirements.clone();
        permitted["premises"] = json!(["simulated-tool"]);
        assert_eq!(
            assess(
                &question,
                &slot,
                &permitted,
                &config,
                &HashSet::new(),
                &HashSet::new()
            )["canSelect"],
            true
        );
        permitted["learnedKnowledgeUids"] = json!([]);
        assert_eq!(
            assess(
                &question,
                &slot,
                &permitted,
                &config,
                &HashSet::new(),
                &HashSet::new()
            )["status"],
            "unknown"
        );
    }
    #[test]
    fn simulated_invalid_knowledge_evidence_never_falls_back_to_sections() {
        let (question, slot, requirements, config) = simulated_knowledge_assessment();
        let mut variants = Vec::new();
        for primary in [
            json!([]),
            json!(null),
            json!("simulated-a"),
            json!(["unknown-uid"]),
        ] {
            let mut invalid = config.clone();
            invalid["assemblyIndex"]["entries"][0]["primaryKnowledgeUids"] = primary;
            variants.push(invalid);
        }
        for required in [
            None,
            Some(json!([])),
            Some(json!(["unknown-uid"])),
            Some(json!(["simulated-b"])),
        ] {
            let mut invalid = config.clone();
            let path = &mut invalid["assemblyIndex"]["entries"][0]["solutionPaths"][0];
            if let Some(required) = required {
                path["requiredKnowledgeUids"] = required;
            } else {
                path.as_object_mut()
                    .unwrap()
                    .remove("requiredKnowledgeUids");
            }
            variants.push(invalid);
        }
        let mut outdated = config.clone();
        outdated["assemblyIndex"]["entries"][0]["contentVersion"] = json!("simulated-old-version");
        variants.push(outdated);
        let mut missing_primary = config.clone();
        missing_primary["assemblyIndex"]["entries"][0]
            .as_object_mut()
            .unwrap()
            .remove("primaryKnowledgeUids");
        variants.push(missing_primary);
        let mut no_path = config.clone();
        no_path["assemblyIndex"]["entries"][0]["solutionPaths"] = json!([]);
        variants.push(no_path);
        for invalid in variants {
            let result = assess(
                &question,
                &slot,
                &requirements,
                &invalid,
                &HashSet::new(),
                &HashSet::new(),
            );
            assert_eq!(result["canSelect"], false, "{invalid}");
            assert_eq!(result["status"], "unknown", "{invalid}");
        }
    }
    #[test]
    fn simulated_frozen_read_rejects_tampering_and_replay_before_returning_data() {
        let (_dir, mut store, model) = simulated_store();
        let cancel = AtomicBool::new(false);
        let draft = json!({"schemaVersion":1,"draftId":"simulated-origin","revision":0,"title":"模拟冻结练习","slots":[]});
        let paper = json!({"schemaVersion":1,"paperId":"simulated-paper","title":draft["title"],"sourceDraftId":draft["draftId"],"sourceRevision":draft["revision"],"snapshotSha256":hash(&draft),"draft":draft,"assets":[]});
        verify_frozen_paper(&paper).unwrap();
        for (field, value) in [
            ("snapshotSha256", json!("tampered")),
            ("title", json!("不同名称")),
            ("sourceDraftId", json!("different-origin")),
            ("sourceRevision", json!(1)),
        ] {
            let mut corrupt = paper.clone();
            corrupt[field] = value;
            assert_eq!(
                verify_frozen_paper(&corrupt).unwrap_err().code,
                "integrity_error",
                "{field}"
            );
        }
        let mut corrupt = paper.clone();
        corrupt["snapshotSha256"] = json!("tampered");
        store
            .put_document("papers", "simulated-paper", &corrupt)
            .unwrap();
        assert_eq!(
            dispatch(
                &mut store,
                "paper_get",
                &json!({"paperId":"simulated-paper"}),
                &model,
                &cancel
            )
            .unwrap_err()
            .code,
            "integrity_error"
        );
        assert_eq!(
            derive(
                &mut store,
                &json!({"paperId":"simulated-paper","operationId":"simulated-derive"})
            )
            .unwrap_err()
            .code,
            "integrity_error"
        );
        let payload = json!({"draftId":"simulated-replay-origin","operationId":"simulated-confirm-replay","expectedRevision":0,"acknowledgeDifferences":true});
        let pid = stable_id(
            "paper",
            "simulated-replay-origin",
            "simulated-confirm-replay",
        );
        let mut corrupt = paper;
        corrupt["paperId"] = json!(pid);
        corrupt["sourceDraftId"] = payload["draftId"].clone();
        corrupt["confirmation"] = json!({"payloadHash":hash(&payload)});
        store.put_document("papers", &pid, &corrupt).unwrap();
        assert_eq!(
            confirm(&mut store, &payload).unwrap_err().code,
            "integrity_error"
        );
        assert!(store.list_documents("drafts").unwrap().is_empty());
    }
    #[test]
    fn simulated_embedded_assets_freeze_without_old_paths_and_preserve_roles() {
        let directory = tempfile::tempdir().unwrap();
        let mut seed: Value =
            serde_json::from_str(include_str!("../../resources/seed.json")).unwrap();
        let encoded = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWWkAAAAASUVORK5CYII=";
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        let sha = format!("{:x}", Sha256::digest(&bytes));
        assert!(image_header_matches("image/png", &bytes));
        let q = &mut seed["questions"][0];
        let mut payloads = Vec::new();
        for role in ["student", "teacher"] {
            let asset = json!({"assetId":format!("simulated-{role}-image"),"path":format!("simulated/no-old-directory/{role}.png"),"mimeType":"image/png","sha256":sha,"alt":format!("模拟{role}配图")});
            q[role]["assets"] = json!([asset]);
            let mut payload = asset;
            payload["role"] = json!(role);
            payload["dataBase64"] = json!(encoded);
            payloads.push(payload);
            let body_hash = hash(&q[role]);
            let prefix = if role == "student" {
                "content"
            } else {
                "teacher"
            };
            q[format!("{prefix}Sha256")] = json!(body_hash);
            q[format!("{prefix}Version")] = json!(format!("{prefix}-{}", &body_hash[..16]));
            q["verification"][format!("{prefix}Version")] = q[format!("{prefix}Version")].clone();
        }
        q["assetPayloads"] = json!(payloads);
        let question = q.clone();
        // This is an explicit simulated image fixture, not a mutation of the
        // separately hashed real migration archive.
        seed.as_object_mut().unwrap().remove("migration");
        seed.as_object_mut().unwrap().remove("bankSnapshot");
        let mut store = Store::open(directory.path(), &seed).unwrap();
        let draft = json!({"schemaVersion":1,"draftId":"simulated-embedded-draft","revision":0,"title":"模拟内嵌配图练习","slots":[{"slotId":"slot-1","number":1,"question":question}],"differences":[]});
        store
            .put_document("drafts", "simulated-embedded-draft", &draft)
            .unwrap();
        let paper=confirm(&mut store,&json!({"draftId":"simulated-embedded-draft","operationId":"simulated-embedded-confirm","expectedRevision":0,"acknowledgeDifferences":true})).unwrap()["paper"].clone();
        verify_frozen_paper(&paper).unwrap();
        assert_eq!(paper["assets"].as_array().unwrap().len(), 2);
        assert_eq!(paper["assets"][0]["role"], "student");
        assert_eq!(paper["assets"][1]["role"], "teacher");
        assert_ne!(
            paper["draft"]["slots"][0]["question"]["student"]["assets"][0]["assetId"],
            paper["assets"][1]["assetId"]
        );
        assert!(!directory.path().join("simulated/no-old-directory").exists());
        for change in ["missing", "base64", "hash", "mime", "role", "extra"] {
            let mut altered = paper.clone();
            let payloads = altered["draft"]["slots"][0]["question"]["assetPayloads"]
                .as_array_mut()
                .unwrap();
            match change {
                "missing" => {
                    payloads.pop();
                }
                "base64" => payloads[0]["dataBase64"] = json!("%%%invalid"),
                "hash" => payloads[0]["dataBase64"] = json!("AAAA"),
                "mime" => payloads[0]["mimeType"] = json!("image/jpeg"),
                "role" => payloads[1]["role"] = json!("student"),
                "extra" => {
                    payloads.push(payloads[0].clone());
                }
                _ => unreachable!(),
            }
            altered["snapshotSha256"] = json!(hash(&altered["draft"]));
            assert_eq!(
                verify_frozen_paper(&altered).unwrap_err().code,
                "integrity_error",
                "{change}"
            );
        }
        let mut altered = paper;
        altered["assets"][1]["role"] = json!("student");
        assert_eq!(
            verify_frozen_paper(&altered).unwrap_err().code,
            "integrity_error"
        );
    }
    #[test]
    fn simulated_missing_assets_block_confirmation_instead_of_disappearing() {
        let (_dir, mut store, _model) = simulated_store();
        let mut question = store.bank.questions().unwrap().remove(0);
        question["student"]["assets"] =
            json!([{"assetId":"simulated-image","path":"not-frozen/image.png"}]);
        let sha = hash(&question["student"]);
        question["contentSha256"] = json!(sha);
        question["contentVersion"] = json!(format!("content-{}", &sha[..16]));
        let draft = json!({"schemaVersion":1,"draftId":"simulated-assets-draft","revision":0,"title":"模拟带图练习","slots":[{"slotId":"slot-1","number":1,"question":question}],"differences":[]});
        let paper = json!({"schemaVersion":1,"paperId":"simulated-assets-paper","title":draft["title"],"sourceDraftId":draft["draftId"],"sourceRevision":0,"snapshotSha256":hash(&draft),"draft":draft,"assets":[]});
        assert_eq!(
            verify_frozen_paper(&paper).unwrap_err().code,
            "integrity_error"
        );
        store
            .put_document("drafts", "simulated-assets-draft", &draft)
            .unwrap();
        assert_eq!(confirm(&mut store,&json!({"draftId":"simulated-assets-draft","operationId":"simulated-assets-confirm","expectedRevision":0,"acknowledgeDifferences":true})).unwrap_err().code,"integrity_error");
        assert!(store.list_documents("papers").unwrap().is_empty());
        assert_eq!(
            store.document("drafts", "simulated-assets-draft").unwrap(),
            draft
        );
    }
    #[test]
    fn migrated_real_chapter_two_rules_respect_scope_and_use_verified_supply() {
        let (_directory, mut store, model) = simulated_store();
        let config = store.bank.config().unwrap();
        let pool = store.bank.questions().unwrap();
        let cancel = AtomicBool::new(false);
        assert_eq!(
            pool.len(),
            378,
            "migration regression uses the exported ready bank, not a teacher adoption case"
        );
        let mut chosen = 0;
        for number in ["2.1", "2.2", "2.3"] {
            let section = format!("rja-compulsory-1:{number}");
            let learned: Vec<_> = list(&config["chapters"])
                .iter()
                .map(|chapter| s(chapter, "id").to_owned())
                .filter(|id| {
                    let canonical = intake::canonical(id);
                    canonical
                        .strip_prefix("rja-compulsory-1:")
                        .is_some_and(|suffix| suffix <= number)
                })
                .collect();
            let requirements=intake::normalize(&store,&json!({"mainScope":[section],"learnedScope":learned,"counts":{"single_choice":1,"fill_blank":1,"free_response":1},"scoringMode":"none"})).unwrap();
            let blueprint = plan(
                &store,
                &json!({"requirements":requirements,"mode":"rule"}),
                &model,
                &cancel,
            )
            .unwrap();
            let draft = create_draft(
                &mut store,
                &json!({"blueprint":blueprint,"mode":"rule"}),
                &model,
                &cancel,
            )
            .unwrap()["draft"]
                .clone();
            assert_eq!(
                draft["baseline"]["requirements"]["mainScope"],
                json!([section])
            );
            assert_eq!(
                draft["baseline"]["requirements"]["learnedScope"],
                json!(learned)
            );
            for slot in list(&draft["slots"]) {
                let mut eligible = HashSet::new();
                for question in pool
                    .iter()
                    .filter(|q| s(q, "questionType") == s(&slot, "questionType"))
                {
                    if let Some(annotation) = config["assemblyIndex"]["entries"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|entry| s(entry, "questionId") == s(question, "questionId"))
                    {
                        for task_id in strings(&annotation["tasks"]) {
                            let probe = intake::merge(&slot, &json!({"taskId":task_id}));
                            if s(
                                &assess(
                                    question,
                                    &probe,
                                    &requirements,
                                    &config,
                                    &HashSet::new(),
                                    &HashSet::new(),
                                ),
                                "status",
                            ) == "eligible"
                            {
                                eligible.insert(task_id);
                            }
                        }
                    }
                }
                let eligible_tasks = eligible.len();
                println!(
                    "real migration {number} {}: {} eligible tasks; chosen {}",
                    s(&slot, "questionType"),
                    eligible_tasks,
                    s(&slot["question"], "questionId")
                );
                if eligible_tasks > 0 {
                    assert!(
                        slot["question"].is_object(),
                        "{number} {} has real eligible supply but rule planning chose an unsupported task",
                        s(&slot, "questionType")
                    );
                }
                if slot["question"].is_object() {
                    chosen += 1;
                    let qid = s(&slot["question"], "questionId");
                    let annotation = list(&config["assemblyIndex"]["entries"])
                        .into_iter()
                        .find(|a| s(a, "questionId") == qid)
                        .unwrap();
                    assert!(
                        strings(&annotation["primarySections"])
                            .iter()
                            .all(|id| intake::includes(&requirements["mainScope"], id))
                    );
                }
            }
        }
        assert!(chosen >= 3);
    }
    #[test]
    fn simulated_real_seed_shortage_revisions_idempotency_and_immutable_paper() {
        let (_dir, mut store, model) = simulated_store();
        let cancel = AtomicBool::new(false);
        let student = store
            .create_student(&json!({"name":"模拟学生","operationId":"student-case"}))
            .unwrap();
        let prepared=intake::prepare(&store,&json!({"requirements":{"mainScope":["1.1"],"learnedScope":["1.1"],"student":student},"message":"12道题，不要解答题","mode":"rule"}),&model,&cancel).unwrap();
        assert_eq!(prepared["requirements"]["questionCount"], 12);
        assert_eq!(prepared["requirements"]["counts"]["free_response"], 0);
        let mut blueprint = plan(
            &store,
            &json!({"requirements":prepared["requirements"],"mode":"rule"}),
            &model,
            &cancel,
        )
        .unwrap();
        // Deliberately constrain all single-choice positions to the same real task: actual supply cannot fill twelve positions.
        for slot in blueprint["slots"].as_array_mut().unwrap() {
            if s(slot, "questionType") == "single_choice" {
                slot["taskId"] = json!("set_determinacy");
            }
        }
        let mut draft = create_draft(
            &mut store,
            &json!({"blueprint":blueprint,"mode":"rule"}),
            &model,
            &cancel,
        )
        .unwrap()["draft"]
            .clone();
        assert_eq!(draft["slots"].as_array().unwrap().len(), 12);
        assert!(draft["stats"]["missingQuestions"].as_u64().unwrap() > 0);
        assert_eq!(draft["student"]["name"], "模拟学生");
        let selected: Vec<_> = list(&draft["slots"])
            .into_iter()
            .filter(|s| s["question"].is_object())
            .collect();
        let unique: HashSet<_> = selected
            .iter()
            .map(|slot| s(&slot["question"], "questionId"))
            .collect();
        assert_eq!(unique.len(), selected.len());
        let operation = json!({"draftId":draft["draftId"],"operation":{"type":"rename","operationId":"rename-case","expectedRevision":0,"title":"教师自定义练习"}});
        draft = edit(&mut store, &operation).unwrap()["draft"].clone();
        assert_eq!(draft["revision"], 1);
        assert_eq!(
            edit(&mut store, &operation).unwrap()["draft"]["revision"],
            1
        );
        let mut conflict = operation.clone();
        conflict["operation"]["title"] = json!("不同内容");
        assert_eq!(
            edit(&mut store, &conflict).unwrap_err().code,
            "operation_conflict"
        );
        assert_eq!(edit(&mut store,&json!({"draftId":draft["draftId"],"operation":{"type":"rename","operationId":"stale-case","expectedRevision":0,"title":"过期修改"}})).unwrap_err().code,"revision_conflict");
        let payload = json!({"draftId":draft["draftId"],"operationId":"confirmation-case","expectedRevision":1,"acknowledgeDifferences":false});
        assert_eq!(
            confirm(&mut store, &payload).unwrap_err().code,
            "confirmation_required"
        );
        let mut payload = payload;
        payload["acknowledgeDifferences"] = json!(true);
        let paper = confirm(&mut store, &payload).unwrap()["paper"].clone();
        assert_eq!(paper["title"], "教师自定义练习");
        assert_eq!(confirm(&mut store, &payload).unwrap()["paper"], paper);
        assert_eq!(edit(&mut store,&json!({"draftId":draft["draftId"],"operation":{"type":"rename","operationId":"after-paper","expectedRevision":2,"title":"禁止修改"}})).unwrap_err().code,"finalized_draft");
        let derived = derive(
            &mut store,
            &json!({"paperId":paper["paperId"],"operationId":"derive-case"}),
        )
        .unwrap()["draft"]
            .clone();
        assert_eq!(derived["title"], paper["title"]);
        assert_eq!(derived["revision"], 0);
        assert!(derived.get("confirmedPaperId").is_none());
        assert_eq!(
            store.document("papers", s(&paper, "paperId")).unwrap(),
            paper
        );
    }
    #[test]
    fn invalid_blueprint_and_cancellation_do_not_persist_a_draft() {
        let (_dir, mut store, model) = simulated_store();
        let cancel = AtomicBool::new(false);
        let prepared = intake::prepare(
            &store,
            &json!({"requirements":{},"message":"10道题","mode":"rule"}),
            &model,
            &cancel,
        )
        .unwrap();
        let mut requirements = prepared["requirements"].clone();
        requirements["counts"]["single_choice"] = json!(9);
        let blueprint = plan(
            &store,
            &json!({"requirements":requirements,"mode":"rule"}),
            &model,
            &cancel,
        )
        .unwrap();
        let mut bad = blueprint.clone();
        bad["slots"].as_array_mut().unwrap().pop();
        assert!(check_blueprint(&store, &bad).is_err());
        cancel.store(true, Ordering::Relaxed);
        assert_eq!(
            create_draft(
                &mut store,
                &json!({"blueprint":blueprint,"mode":"rule"}),
                &model,
                &cancel
            )
            .unwrap_err()
            .code,
            "cancelled"
        );
        assert!(store.list_documents("drafts").unwrap().is_empty());
    }

    // These are isolated simulated workflows, not teacher-use or teaching-quality evidence.
    fn simulated_goal(priority: &str, response: &str, section: &str) -> Value {
        json!({"id":"simulated-goal","version":1,"observable":"模拟判断集合元素关系", "knowledgeScope":[section],"cognition":"understand","conditions":{"prompt":"provided","response":response},"priority":priority,"source":{"kind":"teacher","text":"模拟回归要求"}})
    }

    fn simulated_flow_store() -> (tempfile::TempDir, Store, ModelClient) {
        let dir = tempfile::tempdir().unwrap();
        // Explicitly isolate model configuration as well as SQLite: never read the dev key.
        std::fs::write(
            dir.path().join("model-settings.json"),
            json!({"schemaVersion":2,"revision":0,"activeProfileId":null,"profiles":[]})
                .to_string(),
        )
        .unwrap();
        let seed: Value = serde_json::from_str(include_str!("../../resources/seed.json")).unwrap();
        let store = Store::open(dir.path(), &seed).unwrap();
        let model = ModelClient::open(dir.path()).unwrap();
        assert!(!model.configured());
        (dir, store, model)
    }

    #[test]
    fn simulated_required_goal_rebinding_confirms_plan_but_keeps_evidence_unknown_and_freezes_shortage()
     {
        let (dir, mut store, model) = simulated_flow_store();
        let cancel = AtomicBool::new(false);
        let prepared = intake::prepare(&store, &json!({"requirements":{"mainScope":["1.1"],"learnedScope":["1.1"],"teachingGoals":[simulated_goal("required","answer","1.1")]},"message":"2道单选题，不要填空题和解答题","mode":"rule"}), &model, &cancel).unwrap();
        let mut blueprint = plan(
            &store,
            &json!({"requirements":prepared["requirements"],"mode":"rule"}),
            &model,
            &cancel,
        )
        .unwrap();
        assert_eq!(blueprint["slots"].as_array().unwrap().len(), 2);
        for slot in blueprint["slots"].as_array_mut().unwrap() {
            slot["taskId"] = json!("set_determinacy");
            slot["goalIds"] = json!([]);
        }
        let original = blueprint.clone();
        let rejected = create_draft(
            &mut store,
            &json!({"blueprint":blueprint,"mode":"rule"}),
            &model,
            &cancel,
        )
        .unwrap_err();
        assert!(rejected.message.contains("必须教学目标尚未关联"));
        assert!(store.list_documents("drafts").unwrap().is_empty());
        assert_eq!(
            blueprint, original,
            "a rejected confirmation must preserve the editable plan"
        );

        // Explicit rebind permits plan confirmation; it does not certify question support.
        blueprint["slots"][0]["goalIds"] = json!(["simulated-goal"]);
        blueprint["slots"][0]["planningReason"] = json!("模拟重新选择任务后的说明");
        let checked = check_blueprint(&store, &blueprint).unwrap();
        assert_eq!(checked["slots"][0]["goalIds"], json!(["simulated-goal"]));
        let mut draft = create_draft(
            &mut store,
            &json!({"blueprint":checked,"mode":"rule"}),
            &model,
            &cancel,
        )
        .unwrap()["draft"]
            .clone();
        assert_eq!(draft["slots"].as_array().unwrap().len(), 2);
        assert_eq!(draft["baseline"]["requirements"]["questionCount"], 2);
        assert!(draft["slots"][0]["question"].is_null());
        assert!(
            list(&draft["slots"][0]["selection"]["candidates"])
                .iter()
                .all(|candidate| candidate["status"] != "eligible")
        );
        assert!(
            list(&draft["slots"][0]["selection"]["candidates"])
                .iter()
                .any(|candidate| strings(&candidate["reasons"])
                    .iter()
                    .any(|reason| reason.contains("必须教学目标尚无已复核")))
        );
        assert!(draft["stats"]["missingQuestions"].as_u64().unwrap() >= 1);
        assert!(
            draft["slots"][1]["question"].is_object(),
            "the unrelated compatible position should retain real supply"
        );
        draft = edit(&mut store, &json!({"draftId":draft["draftId"],"operation":{"type":"rename","title":"模拟目标重绑缺题练习","operationId":"simulated-rebind-save","expectedRevision":0}})).unwrap()["draft"].clone();
        let draft_id = s(&draft, "draftId").to_owned();
        drop(store);
        let seed: Value = serde_json::from_str(include_str!("../../resources/seed.json")).unwrap();
        let mut reopened = Store::open(dir.path(), &seed).unwrap();
        let restored = dispatch(
            &mut reopened,
            "draft_get",
            &json!({"draftId":draft_id}),
            &model,
            &cancel,
        )
        .unwrap()
        .unwrap()["draft"]
            .clone();
        assert_eq!(restored, draft);
        assert_eq!(
            restored["baseline"]["slots"][0]["goalIds"],
            json!(["simulated-goal"])
        );
        let mut confirmation = json!({"draftId":draft_id,"expectedRevision":draft["revision"],"operationId":"simulated-rebind-confirm","acknowledgeDifferences":false});
        assert_eq!(
            confirm(&mut reopened, &confirmation).unwrap_err().code,
            "confirmation_required"
        );
        assert!(reopened.list_documents("papers").unwrap().is_empty());
        confirmation["acknowledgeDifferences"] = json!(true);
        let paper = confirm(&mut reopened, &confirmation).unwrap()["paper"].clone();
        assert_eq!(paper["draft"]["slots"].as_array().unwrap().len(), 2);
        assert!(paper["draft"]["slots"][0]["question"].is_null());
        verify_frozen_paper(&paper).unwrap();
        assert_eq!(
            confirm(&mut reopened, &confirmation).unwrap()["paper"],
            paper
        );
        assert_eq!(edit(&mut reopened, &json!({"draftId":draft_id,"operation":{"type":"rename","title":"模拟禁止修改成卷","operationId":"simulated-rebind-after-confirm","expectedRevision":draft["revision"]}})).unwrap_err().code, "finalized_draft");
        assert_eq!(
            reopened.document("papers", s(&paper, "paperId")).unwrap(),
            paper
        );
    }

    #[test]
    fn simulated_goal_binding_compatibility_enforces_scope_and_written_response_without_model_claims()
     {
        let (_dir, store, model) = simulated_flow_store();
        let mut blueprint = plan(&store, &json!({"requirements":{"mainScope":["1.1"],"learnedScope":["1.1"],"counts":{"single_choice":1,"multiple_choice":0,"fill_blank":0,"free_response":0}},"mode":"rule"}), &model, &AtomicBool::new(false)).unwrap();
        for (goal, allowed) in [
            (simulated_goal("required", "answer", "1.1"), true),
            (simulated_goal("required", "unspecified", "1.1"), true),
            (
                simulated_goal("required", "written_reasoning", "1.1"),
                false,
            ),
            (simulated_goal("required", "answer", "1.2"), false),
        ] {
            blueprint["requirements"]["teachingGoals"] = json!([goal]);
            blueprint["slots"][0]["goalIds"] = json!(["simulated-goal"]);
            blueprint["slots"][0]["planningReason"] = json!("模拟模型声称已覆盖，不能代替兼容检查");
            assert_eq!(check_blueprint(&store, &blueprint).is_ok(), allowed);
        }
        blueprint["requirements"]["teachingGoals"] =
            json!([simulated_goal("required", "answer", "1.1")]);
        blueprint["slots"][0]["goalIds"] = json!(["unknown-goal"]);
        assert!(
            check_blueprint(&store, &blueprint)
                .unwrap_err()
                .message
                .contains("未知教学目标")
        );
    }

    #[test]
    fn simulated_selection_model_failure_invalid_ranking_cancel_and_retry_preserve_plan_and_saved_drafts()
     {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::time::{Duration, Instant};
        let (dir, mut store, mut model) = simulated_flow_store();
        let cancel = AtomicBool::new(false);
        let blueprint = plan(&store, &json!({"requirements":{"title":"模拟失败恢复练习","mainScope":["1.1"],"learnedScope":["1.1"],"counts":{"single_choice":2,"multiple_choice":0,"fill_blank":0,"free_response":0}},"mode":"rule"}), &model, &cancel).unwrap();
        let unchanged_plan = blueprint.clone();
        assert_eq!(
            create_draft(
                &mut store,
                &json!({"blueprint":blueprint,"mode":"llm"}),
                &model,
                &cancel
            )
            .unwrap_err()
            .code,
            "not_configured"
        );
        assert!(store.list_documents("drafts").unwrap().is_empty());

        // A bounded local HTTP fixture exercises actual model transport and response validation.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
        model.save(&json!({"expectedRevision":0,"activeProfileId":"simulated-flow","profiles":[{"id":"simulated-flow","name":"模拟流程模型","baseUrl":endpoint,"model":"simulated-selection","apiKey":"simulated-local-key"}]})).unwrap();
        let server = std::thread::spawn(move || {
            for attempt in 0..4 {
                let deadline = Instant::now() + Duration::from_secs(15);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(e)
                            if e.kind() == std::io::ErrorKind::WouldBlock
                                && Instant::now() < deadline =>
                        {
                            std::thread::sleep(Duration::from_millis(5))
                        }
                        Err(e) => panic!("simulated model request not received: {e}"),
                    }
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(10)))
                    .unwrap();
                let mut bytes = Vec::new();
                let (header_end, body_size) = loop {
                    let mut buffer = [0; 4096];
                    let length = match stream.read(&mut buffer) {
                        Ok(length) => length,
                        Err(error)
                            if matches!(
                                error.kind(),
                                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                            ) && Instant::now() < deadline =>
                        {
                            continue;
                        }
                        Err(error) => panic!("simulated model request read failed: {error}"),
                    };
                    assert!(length > 0);
                    bytes.extend_from_slice(&buffer[..length]);
                    assert!(bytes.len() < 2 * 1024 * 1024);
                    if let Some(end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]);
                        let size = headers
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|n| n.trim().parse::<usize>().unwrap())
                            })
                            .unwrap();
                        if bytes.len() >= end + 4 + size {
                            break (end + 4, size);
                        }
                    }
                };
                let request: Value =
                    serde_json::from_slice(&bytes[header_end..header_end + body_size]).unwrap();
                let context: Value =
                    serde_json::from_str(request["messages"][1]["content"].as_str().unwrap())
                        .unwrap();
                let rankings: Vec<_> = if attempt == 1 {
                    vec![]
                } else {
                    list(&context["candidates"]).iter().map(|row| json!({"slotId":row["slotId"],"questionIds":list(&row["candidates"]).iter().map(|q|q["questionId"].clone()).collect::<Vec<_>>()})).collect()
                };
                let body = json!({"choices":[{"message":{"content":json!({"rankings":rankings}).to_string()}}]}).to_string();
                let status = if attempt == 0 || attempt == 3 {
                    "503 Service Unavailable"
                } else {
                    "200 OK"
                };
                write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            }
        });
        for expected_code in ["model_error", "invalid_plan"] {
            let failure = create_draft(
                &mut store,
                &json!({"blueprint":blueprint,"mode":"llm"}),
                &model,
                &cancel,
            )
            .unwrap_err();
            assert_eq!(failure.code, expected_code);
            assert!(store.list_documents("drafts").unwrap().is_empty());
            assert_eq!(blueprint, unchanged_plan);
        }
        cancel.store(true, Ordering::Relaxed);
        assert_eq!(
            create_draft(
                &mut store,
                &json!({"blueprint":blueprint,"mode":"llm"}),
                &model,
                &cancel
            )
            .unwrap_err()
            .code,
            "cancelled"
        );
        assert!(store.list_documents("drafts").unwrap().is_empty());
        cancel.store(false, Ordering::Relaxed);
        let ai_draft = create_draft(
            &mut store,
            &json!({"blueprint":blueprint,"mode":"llm"}),
            &model,
            &cancel,
        )
        .unwrap()["draft"]
            .clone();
        assert_eq!(ai_draft["selectionGeneration"]["mode"], "llm");
        assert_eq!(ai_draft["baseline"]["slots"], blueprint["slots"]);
        assert_eq!(ai_draft["slots"].as_array().unwrap().len(), 2);
        assert!(
            list(&ai_draft["slots"])
                .iter()
                .all(|slot| slot["question"].is_object())
        );
        // An explicitly requested rule recovery is a distinct saved draft, never an automatic fallback.
        let rule_draft = create_draft(
            &mut store,
            &json!({"blueprint":blueprint,"mode":"rule"}),
            &model,
            &cancel,
        )
        .unwrap()["draft"]
            .clone();
        assert_eq!(rule_draft["selectionGeneration"]["mode"], "rule");
        assert_ne!(rule_draft["draftId"], ai_draft["draftId"]);
        assert_eq!(
            create_draft(
                &mut store,
                &json!({"blueprint":blueprint,"mode":"llm"}),
                &model,
                &cancel,
            )
            .unwrap_err()
            .code,
            "model_error"
        );
        server.join().unwrap();
        assert_eq!(blueprint, unchanged_plan);
        assert_eq!(store.list_documents("drafts").unwrap().len(), 2);
        assert_eq!(
            store.document("drafts", s(&ai_draft, "draftId")).unwrap(),
            ai_draft
        );
        assert_eq!(
            store.document("drafts", s(&rule_draft, "draftId")).unwrap(),
            rule_draft
        );
        drop(store);
        let seed: Value = serde_json::from_str(include_str!("../../resources/seed.json")).unwrap();
        let reopened = Store::open(dir.path(), &seed).unwrap();
        assert_eq!(reopened.list_documents("drafts").unwrap().len(), 2);
        assert_eq!(
            reopened
                .document("drafts", s(&ai_draft, "draftId"))
                .unwrap(),
            ai_draft
        );
        assert_eq!(
            reopened
                .document("drafts", s(&rule_draft, "draftId"))
                .unwrap(),
            rule_draft
        );
    }
}
