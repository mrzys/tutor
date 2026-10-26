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
fn legacy_assess(
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
fn legacy_candidates(
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
            let mut result = legacy_assess(q, slot, r, config, &used, &groups);
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

fn current_question_pool(store: &Store) -> AppResult<Vec<Value>> {
    let config = store.bank.config()?;
    store.bank.questions()?.iter()
        .map(|question| crate::bank_teaching::project(question, &config))
        .collect()
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
    crate::bank_teaching::project(&question, &store.bank.config()?)
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

fn legacy_supply(pool: &[Value], slots: &[Value], r: &Value, config: &Value) -> Value {
    json!({"ready":pool.len(),"slotSupply":slots.iter().map(|slot|{let c=legacy_candidates(pool,slot,r,config,&[]);json!({"slotId":slot["slotId"],"eligibleCount":c.iter().filter(|x|s(x,"status")=="eligible").count(),"unknownCount":c.iter().filter(|x|s(x,"status")=="unknown").count(),"relatedCount":c.iter().filter(|x|s(x,"status")=="related").count(),"readFailures":[]})}).collect::<Vec<_>>()})
}
// Type-level reference supply before the teacher confirms a split. Count real,
// version-checked questions under the current scope and learned boundary, with
// duplicate groups counted once. A later task/goal assignment may reduce supply.
pub(crate) fn intake_supply(store: &Store, r: &Value, config: &Value) -> AppResult<Value> {
    let requirements = intake::normalize(store, r)?;
    let pool = current_question_pool(store)?;
    let sources = strings(&requirements["sourceIds"]);
    let counts: serde_json::Map<String,Value> = TYPES.iter().map(|kind| {
        let count = pool.iter().filter(|q| s(q,"questionType")==*kind && list(&q["sourceRefs"]).iter().any(|source| sources.iter().any(|id| id==s(source,"sourceId")))).count();
        (kind.to_string(),json!({"readyCount":count}))
    }).collect();
    let _ = config;
    Ok(json!({"byType":counts,"basis":"verified_ready_inventory_not_teaching_fit","limitation":"仅为真实就绪题目库存，教学相关性、难度及已学适配由模型根据实际题面判断。"}))
}
fn legacy_blueprint_model_context(pool: &[Value], slots: &[Value], r: &Value, config: &Value) -> Value {
    // Keep every legal task, including tasks without supply. Import review,
    // provenance and scoring metadata do not help choose teaching targets.
    let tasks: Vec<_> = list(&config["tasks"])
        .iter()
        .filter(|t| {
            r["counts"][s(t, "questionType")].as_u64().unwrap_or(0) > 0
                && intake::overlaps(&t["sectionIds"], &r["mainScope"])
        })
        .map(|t| json!({"id":t["id"],"label":t["label"],"questionType":t["questionType"],"sectionIds":t["sectionIds"]}))
        .collect();
    let reference_slots: Vec<_> = slots
        .iter()
        .map(|slot| json!({"taskId":slot["taskId"],"goalIds":slot["goalIds"]}))
        .collect();
    let slot_supply: Vec<_> = list(&legacy_supply(pool, slots, r, config)["slotSupply"])
        .iter()
        .map(|row| json!({"eligibleCount":row["eligibleCount"],"unknownCount":row["unknownCount"],"relatedCount":row["relatedCount"]}))
        .collect();
    intake::model_context(
        &json!({"requirements":r,"tasks":tasks,"slots":reference_slots,"supply":{"referenceSlotSupply":slot_supply}}),
    )
}
fn plan_context(requirements: &Value, config: &Value, inventory: &Value) -> AppResult<Value> {
    let tasks:Vec<_> = list(&config["tasks"]).iter()
        .filter(|task| requirements["counts"][s(task,"questionType")].as_u64().unwrap_or(0)>0
            && intake::overlaps(&task["sectionIds"],&requirements["mainScope"]))
        .map(|task|json!({"id":task["id"],"label":task["label"],"questionType":task["questionType"],"sectionIds":task["sectionIds"],"partIds":task["partIds"]})).collect();
    let mut task_catalog_gaps=Vec::new();
    for (kind,label) in [("single_choice","单选"),("multiple_choice","多选"),("fill_blank","填空"),("free_response","解答")] {
        if requirements["counts"][kind].as_u64().unwrap_or(0)>0 && !tasks.iter().any(|task|s(task,"questionType")==kind) {
            task_catalog_gaps.push(json!({"questionType":kind,"requestedCount":requirements["counts"][kind],"reason":"confirmed_scope_task_not_registered","message":format!("已确认范围尚未登记{label}考查任务，不代表题库无题；原题量与范围保持不变，请补充目录或修改规划后确认。")}));
        }
    }
    let mut needed=HashSet::new();
    for field in ["mainScope","learnedScope"] {
        needed.extend(strings(&requirements[field]).iter().map(|id|intake::canonical(id)));
    }
    for goal in list(&requirements["teachingGoals"]) {
        needed.extend(strings(&goal["knowledgeScope"]).iter().map(|id|intake::canonical(id)));
    }
    for task in &tasks {
        needed.extend(strings(&task["sectionIds"]).iter().map(|id|intake::canonical(id)));
    }
    let mut seen=HashSet::new();
    let chapters:Vec<_>=list(&config["chapters"]).into_iter().filter(|chapter|{
        let id=intake::canonical(s(chapter,"id"));
        needed.contains(&id) && seen.insert(id)
    }).collect();
    Ok(json!({"requirements":intake::model_context(requirements),"tasks":tasks,"taskCatalogGaps":task_catalog_gaps,"inventory":inventory,"chapters":chapters}))
}
fn model_blueprint_slots(output: &Value, config: &Value) -> AppResult<Vec<Value>> {
    let generated = output["slots"]
        .as_array()
        .ok_or_else(|| invalid("AI 未返回有效题位规划。"))?;
    generated
        .iter()
        .enumerate()
        .map(|(index, slot)| {
            if !slot.is_object() {
                return Err(invalid("AI 未返回有效题位规划。"));
            }
            let t = task(config, s(slot, "taskId"))?;
            // Older model responses may include the type. Reject conflicting
            // values rather than silently repairing an inconsistent response.
            if slot.get("questionType").is_some_and(|kind| kind != &t["questionType"]) {
                return Err(invalid("题型与考查任务不匹配。"));
            }
            Ok(intake::merge(slot, &json!({"slotId":format!("slot-{}",index+1),"number":index+1,"questionType":t["questionType"],"points":0,"partPoints":[]})))
        })
        .collect()
}
fn legacy_allocate_plan_points(slots: &mut [Value], r: &Value, config: &Value) -> AppResult<()> {
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
        let t = task(config, s(slot, "taskId"))?;
        slot["points"] = json!(allocations[i]);
        slot["partPoints"] = parts(t, allocations[i]);
    }
    Ok(())
}
fn check_blueprint(store: &Store, input: &Value) -> AppResult<Value> {
    check_blueprint_with_review(store, input, false)
}
fn check_blueprint_with_review(store: &Store, input: &Value, allow_quantity_review: bool) -> AppResult<Value> {
    crate::assembly_log::data("validation", "recorded", json!({"validation":{"before":input}}));
    let result = check_blueprint_inner(store, input, false, allow_quantity_review);
    match &result {
        Ok(checked) => crate::assembly_log::data("validation", "completed", json!({"validation":{"valid":true,"after":checked}})),
        Err(error) => crate::assembly_log::data("validation", "failed", json!({"validation":{"valid":false,"errorCode":error.code,"message":error.message}})),
    }
    result
}
fn legacy_check_blueprint(store: &Store, input: &Value) -> AppResult<Value> { check_blueprint_inner(store,input,true,false) }
fn check_blueprint_inner(store: &Store, input: &Value, legacy: bool, allow_quantity_review: bool) -> AppResult<Value> {
    let config = store.bank.config()?;
    let r = intake::normalize(store, &input["requirements"])?;
    let source = input["slots"]
        .as_array()
        .ok_or_else(|| invalid("题位规划需包含题位数组。"))?;
    if allow_quantity_review && source.len()>60 {
        return Err(invalid("模型题位规划最多 60 道题，未自动截断。"));
    }
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
        if (legacy || input["generation"]["taskCatalogScope"]=="confirmed_main_scope_v1")
            && !intake::overlaps(&t["sectionIds"], &r["mainScope"]) {
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
            if legacy && (!intake::overlaps(&goal["knowledgeScope"], &t["sectionIds"])
                || (s(&goal["conditions"], "response") == "written_reasoning"
                    && s(t, "questionType") != "free_response"))
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
    if counts != r["counts"] && !allow_quantity_review {
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
        }) && !allow_quantity_review {
            return Err(invalid(
                "必须教学目标尚未关联任何兼容题位，请调整规划或需求后再确认。",
            ));
        }
    }
    let points: u64 = slots
        .iter()
        .map(|slot| slot["points"].as_u64().unwrap_or(0))
        .sum();
    if points != r["targetScore"].as_u64().unwrap_or(0) && !allow_quantity_review {
        return Err(invalid("题位分值合计与确认总分不一致。"));
    }
    let pool = current_question_pool(store)?;
    let inventory = if legacy { legacy_supply(&pool,&slots,&r,&config) } else { json!({"ready":pool.len(),"slotSupply":slots.iter().map(|slot|json!({"slotId":slot["slotId"],"readyCount":pool.iter().filter(|q|q["questionType"]==slot["questionType"]).count()})).collect::<Vec<_>>(),"basis":"inventory_not_teaching_fit"}) };
    let mut checked = json!({"schemaVersion":1,"requirements":r,"slots":slots,"plannedStats":{"questionCount":source.len(),"points":points},"generation":input["generation"],"supply":inventory});
    if allow_quantity_review {
        checked["quantityReview"] = json!({"matches":counts==r["counts"],"expectedCounts":r["counts"],"actualCounts":counts,"expectedTotal":r["questionCount"],"actualTotal":source.len()});
    }
    Ok(checked)
}
fn plan(store: &Store, input: &Value, model: &ModelClient, cancel: &AtomicBool) -> AppResult<Value> {
    check_cancel(cancel)?;
    if s(input,"mode") != "llm" { return Err(error("rule_retired","组卷教学规划已统一由模型处理，请配置模型后重试；已有需求保留。")); }
    crate::workflow_progress::emit("plan_supply","running");
    let requirements = intake::normalize(store,&input["requirements"])?;
    let config = store.bank.config()?;
    let inventory = intake_supply(store,&requirements,&config)?;
    let context = plan_context(&requirements,&config,&inventory)?;
    check_cancel(cancel)?;
    crate::workflow_progress::emit("plan_supply","completed");
    let (slots,generation) = if list(&context["tasks"]).is_empty() {
        (Vec::new(),json!({"mode":"not_run","provenance":"task_catalog_incomplete","taskCatalogScope":"confirmed_main_scope_v1","reason":"已确认范围与题型暂无登记考查任务，未调用模型；原要求保留，空规划等待修改。"}))
    } else {
        crate::workflow_progress::emit("plan_slots","running");
        let output = model.propose("blueprint",&context,cancel)?;
        let mut slots = model_blueprint_slots(&output,&config)?;
        if slots.iter().any(|slot|!list(&context["tasks"]).iter().any(|task|task["id"]==slot["taskId"])) {
            return Err(invalid("模型返回的考查任务不在本次已确认范围与题型的任务目录中，请重新规划或修改范围后确认；原要求已保留。"));
        }
        for (index,slot) in slots.iter_mut().enumerate() {
            slot["points"] = output["slots"][index].get("points").cloned().unwrap_or(json!(0));
            slot["partPoints"] = output["slots"][index].get("partPoints").cloned().unwrap_or(json!([]));
        }
        check_cancel(cancel)?;
        crate::workflow_progress::emit("plan_slots","completed");
        (slots,json!({"mode":"llm","provenance":"llm_planning_v1","taskCatalogScope":"confirmed_main_scope_v1"}))
    };
    check_cancel(cancel)?;
    crate::workflow_progress::emit("plan_check","running");
    let mut result = check_blueprint_with_review(store,&json!({"requirements":requirements,"slots":slots,"generation":generation}),true)?;
    result["taskCatalogGaps"]=context["taskCatalogGaps"].clone();
    check_cancel(cancel)?;
    crate::workflow_progress::emit("plan_check","completed");
    Ok(result)
}
fn legacy_plan(
    store: &Store,
    input: &Value,
    model: &ModelClient,
    cancel: &AtomicBool,
) -> AppResult<Value> {
    check_cancel(cancel)?;
    crate::workflow_progress::emit("plan_supply", "running");
    check_cancel(cancel)?;
    let r = intake::normalize(store, &input["requirements"])?;
    let config = store.bank.config()?;
    let pool = current_question_pool(store)?;
    // Choose rule tasks from verified supply under exactly the confirmed scope
    // and prerequisites. Catalog order is not evidence that a task can be used.
    let mut task_groups: HashMap<String, HashSet<String>> = HashMap::new();
    for question in &pool {
        check_cancel(cancel)?;
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
            check_cancel(cancel)?;
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
            let candidate = legacy_assess(
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
    check_cancel(cancel)?;
    crate::workflow_progress::emit("plan_supply", "completed");
    check_cancel(cancel)?;
    crate::workflow_progress::emit("plan_slots", "running");
    check_cancel(cancel)?;
    let mut used_groups = HashSet::new();
    let mut slots = Vec::new();
    for kind in TYPES {
        check_cancel(cancel)?;
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
            check_cancel(cancel)?;
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
            let output = model.propose(
                "blueprint",
                &legacy_blueprint_model_context(&pool, &slots, &r, &config),
                cancel,
            )?;
            check_cancel(cancel)?;
            slots = model_blueprint_slots(&output, &config)?;
        }
        _ => return Err(invalid("请明确选择 AI 规划或规则预设。")),
    }
    check_cancel(cancel)?;
    crate::workflow_progress::emit("plan_slots", "completed");
    check_cancel(cancel)?;
    crate::workflow_progress::emit("plan_check", "running");
    check_cancel(cancel)?;
    legacy_allocate_plan_points(&mut slots, &r, &config)?;
    check_cancel(cancel)?;
    let blueprint = legacy_check_blueprint(
        store,
        &json!({"requirements":r,"slots":slots,"generation":{"mode":s(input,"mode")}}),
    )?;
    check_cancel(cancel)?;
    crate::workflow_progress::emit("plan_check", "completed");
    Ok(blueprint)
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
    let manual=is_manual(draft);
    let requirements=&draft["baseline"]["requirements"];
    let mut planned_counts=json!({"single_choice":0,"multiple_choice":0,"fill_blank":0,"free_response":0});
    let mut requested_counts=planned_counts.clone();
    let mut missing_counts=planned_counts.clone();
    for kind in TYPES {
        let planned=slots.iter().filter(|slot|s(slot,"questionType")==kind).count() as u64;
        let requested=if manual {planned}else{requirements["counts"][kind].as_u64().unwrap_or(planned)};
        planned_counts[kind]=json!(planned);requested_counts[kind]=json!(requested);
        missing_counts[kind]=json!(requested.saturating_sub(planned));
    }
    let requested_total=TYPES.iter().map(|kind|requested_counts[*kind].as_u64().unwrap_or(0)).sum::<u64>();
    let unplanned=TYPES.iter().map(|kind|missing_counts[*kind].as_u64().unwrap_or(0)).sum::<u64>();
    let missing=unplanned+(slots.len()-selected.len()) as u64;
    if manual {draft.as_object_mut().unwrap().remove("planningShortage");}
    else {draft["planningShortage"]=json!({"requestedCounts":requested_counts,"plannedCounts":planned_counts,"missingCounts":missing_counts,"requestedTotal":requested_total,"plannedTotal":slots.len(),"missingTotal":unplanned,"reason":if unplanned>0{"requested_questions_not_planned"}else{""}});}
    draft["stats"] = json!({"questionCount":slots.len(),"requestedCount":requested_total,"unplannedCount":unplanned,"plannedCount":slots.len(),"selectedCount":selected.len(),"actualCount":selected.len(),"missingCount":missing,"plannedQuestions":slots.len(),"selectedQuestions":selected.len(),"missingQuestions":missing,"plannedPoints":points,"actualPoints":available_points,"availablePoints":available_points,"unknownDifficultyCount":selected.len(),"difficultyEstimate":null});
    let mut differences = Vec::new();
    if unplanned>0 {
        differences.push(json!({"code":"planning_shortage","message":format!("已确认题量中有 {unplanned} 道尚无题位，原需求保留；本次仅输出实际选中的题目。"),"missingCounts":missing_counts,"missingTotal":unplanned}));
    }
    for goal in list(&draft["baseline"]["requirements"]["teachingGoals"]).iter().filter(|goal|!manual && s(goal,"priority")=="required") {
        if !slots.iter().any(|slot|strings(&slot["goalIds"]).iter().any(|id|id==s(goal,"id"))) {
            differences.push(json!({"code":"missing_required_goal","goalId":goal["id"],"message":format!("必须教学目标「{}」尚未关联题位，请核对差异后确认。",s(goal,"observable"))}));
        }
    }
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
pub(crate) fn assignment(rows: &[Vec<(String, String)>]) -> HashMap<usize, String> {
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
fn create_draft(store: &mut Store, input: &Value, model: &ModelClient, cancel: &AtomicBool) -> AppResult<Value> {
    check_cancel(cancel)?;
    if s(input,"mode") != "llm" { return Err(error("rule_retired","自动选题已统一由模型判断，请配置模型后重试；已确认规划保留。")); }
    crate::workflow_progress::emit("select_pool","running");
    check_cancel(cancel)?;
    let blueprint = check_blueprint_with_review(store,&input["blueprint"],true)?;
    for kind in TYPES {
        let actual=list(&blueprint["slots"]).iter().filter(|slot|s(slot,"questionType")==kind).count() as u64;
        if actual>blueprint["requirements"]["counts"][kind].as_u64().unwrap_or(0) {
            return Err(invalid("规划题型数量超过已确认需求，未自动增题或更换题型配比；请移除多余题位后继续。"));
        }
    }
    let config = store.bank.config()?;
    let pool = current_question_pool(store)?;
    let requirements = &blueprint["requirements"];
    let planned = list(&blueprint["slots"]);
    crate::assembly_log::data_for_task("selection","validation","recorded",json!({"input":{"stage":"select_pool","requirements":intake::model_context(requirements),"slots":planned,"pool":pool.iter().map(|q|json!({"questionId":q["questionId"],"contentVersion":q["contentVersion"],"teacherVersion":q["teacherVersion"],"questionType":q["questionType"],"sourceRefs":q["sourceRefs"]})).collect::<Vec<_>>()}}));
    check_cancel(cancel)?;
    crate::workflow_progress::emit("select_pool","completed");
    check_cancel(cancel)?;
    let evaluations = if planned.is_empty() {Vec::new()} else {
        crate::workflow_progress::emit("select_evaluate","running");
        check_cancel(cancel)?;
        let evaluated=crate::assembly_llm::evaluate(&pool,&planned,requirements,&config,&[],model,cancel)?;
        check_cancel(cancel)?;
        crate::workflow_progress::emit("select_evaluate","completed");
        evaluated
    };
    check_cancel(cancel)?;
    crate::workflow_progress::emit("select_save","running");
    check_cancel(cancel)?;
    let rows:Vec<Vec<(String,String)>> = planned.iter().map(|slot| {
        evaluations.iter().find(|row|row["slotId"]==slot["slotId"]).map(|row|list(&row["candidates"]).iter().map(|c|(s(c,"questionId").to_owned(),s(c,"duplicateGroup").to_owned())).collect()).unwrap_or_default()
    }).collect();
    let matches = assignment(&rows);
    let mut slots = Vec::new();
    for (index,slot) in planned.iter().enumerate() {
        check_cancel(cancel)?;
        let evaluation = evaluations.iter().find(|row|row["slotId"]==slot["slotId"]).unwrap();
        let mut out = slot.clone();
        out["locked"] = json!(false); out["question"] = Value::Null; out["status"] = json!("empty");
        if let Some(qid) = matches.get(&index) {
            let decision = list(&evaluation["candidates"]).into_iter().find(|candidate|s(candidate,"questionId")==qid).unwrap();
            let question = pool.iter().find(|q|s(q,"questionId")==qid).ok_or_else(||error("integrity_error","真实候选快照缺失。"))?;
            out["question"] = question.clone(); out["status"] = json!("selected");
            out["partPoints"] = selection_part_points(question,&decision,slot,requirements);
            let mut decision = decision;
            decision["criteriaSha256"] = json!(crate::assembly_llm::signature(&out,requirements));
            out["applicability"] = decision;
        }
        let missing = if out["question"].is_null() { if s(evaluation,"missingReason").is_empty(){"模型认可的候选在整卷去重后不足，保留缺题位。"}else{s(evaluation,"missingReason")} }else{""};
        out["selection"] = json!({"candidates":evaluation["candidates"],"assessments":evaluation["assessments"],"search":evaluation["search"],"reasons":if missing.is_empty(){vec![]}else{vec![missing]},"failures":[]});
        slots.push(out);
    }
    let timestamp = now(); let draft_id = id();
    let mut draft = json!({"schemaVersion":1,"draftId":draft_id,"title":requirements["title"],"revision":0,"createdAt":timestamp,"updatedAt":timestamp,"baseline":{"requirements":requirements,"slots":planned,"confirmedAt":timestamp,"version":1,"courseContext":config["courseContext"],"sourceManifest":config["sourceManifest"],"questionIndexSnapshot":config["assemblyIndex"],"taskCatalogSnapshot":config},"slots":slots,"operations":[],"selectionGeneration":{"mode":"llm","provenance":"llm_selection_v1"}});
    if planned.is_empty() {draft["selectionGeneration"]=json!({"mode":"not_run","provenance":"empty_blueprint_no_selection","reason":"没有实际题位，未调用选题模型；原需求和未规划缺口保留。"});}
    if let Some(student)=requirements.get("student") { draft["student"]=student.clone(); }
    refresh(&mut draft); freeze_assets(&draft)?; check_cancel(cancel)?;
    for slot in list(&draft["slots"]).iter().filter(|slot|slot["question"].is_object()) {
        check_cancel(cancel)?;
        let current=match store.bank.question(s(&slot["question"],"questionId")){Ok(question)=>question,Err(error)=>{crate::assembly_log::data_for_task("selection","validation","failed",json!({"validation":{"stage":"select_save","valid":false,"questionId":slot["question"]["questionId"],"errorCode":error.code,"message":error.message}}));return Err(error);}};
        if current["contentVersion"]!=slot["question"]["contentVersion"] || current["teacherVersion"]!=slot["question"]["teacherVersion"] {
            let error=error("version_conflict","候选题版本在模型判断后已改变，未保存草稿；已确认规划保留。");
            crate::assembly_log::data_for_task("selection","validation","failed",json!({"validation":{"stage":"select_save","valid":false,"questionId":slot["question"]["questionId"],"expectedContentVersion":slot["question"]["contentVersion"],"actualContentVersion":current["contentVersion"],"expectedTeacherVersion":slot["question"]["teacherVersion"],"actualTeacherVersion":current["teacherVersion"],"errorCode":error.code,"message":error.message}}));
            return Err(error);
        }
    }
    check_cancel(cancel)?;
    crate::assembly_log::data_for_task("selection","validation","completed",json!({"validation":{"stage":"select_save","valid":true,"assignment":draft["slots"].as_array().unwrap().iter().map(|slot|json!({"slotId":slot["slotId"],"questionId":slot["question"]["questionId"],"contentVersion":slot["question"]["contentVersion"],"teacherVersion":slot["question"]["teacherVersion"]})).collect::<Vec<_>>(),"stats":draft["stats"],"planningShortage":draft["planningShortage"],"differences":draft["differences"]}}));
    store.put_document("drafts",&draft_id,&draft)?;
    crate::workflow_progress::emit("select_save","completed");
    let steps=if planned.is_empty(){vec!["select_pool","select_save"]}else{vec!["select_pool","select_evaluate","select_save"]};
    Ok(json!({"draft":draft,"workflowSteps":steps}))
}
fn selection_part_points(question: &Value, decision: &Value, slot: &Value, requirements: &Value) -> Value {
    if s(question,"questionType")!="free_response" { return json!([]); }
    if s(requirements,"scoringMode")=="none" { return json!(list(&question["student"]["parts"]).iter().map(|part|json!({"partId":part["partId"],"points":0})).collect::<Vec<_>>()); }
    let _ = slot;
    decision["partPoints"].clone()
}
fn legacy_create_draft(
    store: &mut Store,
    input: &Value,
    model: &ModelClient,
    cancel: &AtomicBool,
) -> AppResult<Value> {
    let blueprint = legacy_check_blueprint(store, &input["blueprint"])?;
    let config = store.bank.config()?;
    let pool = current_question_pool(store)?;
    let r = &blueprint["requirements"];
    let planned = list(&blueprint["slots"]);
    let options: Vec<Vec<Value>> = planned
        .iter()
        .map(|slot| legacy_candidates(&pool, slot, r, &config, &[]))
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
fn legacy_edit(store: &mut Store,payload:&Value)->AppResult<Value>{edit_internal(store,payload,None)}
fn edit(store: &mut Store, payload: &Value, model: &ModelClient, cancel: &AtomicBool) -> AppResult<Value> {
    check_cancel(cancel)?;
    let draft = store.document("drafts",s(payload,"draftId"))?;
    let operation=&payload["operation"];
    let replayed=list(&draft["operations"]).iter().any(|prior|prior["operationId"]==operation["operationId"]);
    if replayed || is_manual(&draft) { return edit_internal(store,payload,Some(&json!({}))); }
    revision(&draft,operation)?;
    let mut decisions=json!({});
    if s(operation,"type")=="replace" {
        let ids=if operation["slotIds"].is_array(){strings(&operation["slotIds"])}else{vec![s(operation,"slotId").to_owned()]};
        let targets:Vec<_>=list(&draft["slots"]).into_iter().filter(|slot|ids.iter().any(|id|id==s(slot,"slotId")) && !(s(operation,"mode")=="automatic" && slot["locked"]==true)).collect();
        if operation["candidateId"].as_str().is_none_or(str::is_empty) {
            if !targets.is_empty() {
                let config=store.bank.config()?;let pool=current_question_pool(store)?;
                let evaluated=crate::assembly_llm::evaluate(&pool,&targets,&draft["baseline"]["requirements"],&config,&list(&draft["slots"]),model,cancel)?;
                for row in evaluated {decisions[s(&row,"slotId")]=row.clone();}
            }
        } else {
            for slot in targets {
                let cached=&draft["candidateEvaluations"][s(&slot,"slotId")];
                if cached["criteriaSha256"]!=crate::assembly_llm::signature(&slot,&draft["baseline"]["requirements"]) {return Err(invalid("候选判断已失效，请重新点击换题由模型评估；原题保留。"));}
                let candidate=list(&cached["candidates"]).into_iter().find(|candidate|candidate["questionId"]==operation["candidateId"]).ok_or_else(||invalid("此题未通过本次真实模型判断，请重新评估候选；原题保留。"))?;
                let current=store.bank.question(s(&candidate,"questionId"))?;
                if candidate["contentVersion"]!=current["contentVersion"] || candidate["teacherVersion"]!=current["teacherVersion"] || operation["contentVersion"]!=current["contentVersion"] || operation["teacherVersion"]!=current["teacherVersion"] {return Err(error("version_conflict","候选版本已改变，原题保留，请重新由模型评估。"));}
                decisions[s(&slot,"slotId")]=cached.clone();
            }
        }
    }
    check_cancel(cancel)?;
    edit_internal(store,payload,Some(&decisions))
}
fn edit_internal(store: &mut Store, payload: &Value, decisions: Option<&Value>) -> AppResult<Value> {
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
        let pool = current_question_pool(store)?;
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
                    } else if let Some(decisions) = decisions {
                        list(&decisions[&sid]["candidates"]).into_iter().filter(|candidate| {
                            pool.iter().find(|q|q["questionId"]==candidate["questionId"]).is_some_and(|q|crate::assembly_llm::available(q,&slots[i],&draft["baseline"]["requirements"],&config,&slots) && crate::assembly_llm::saved_matches(candidate,q,&slots[i],&draft["baseline"]["requirements"]))
                        }).collect()
                    } else {
                        legacy_candidates(
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
                        if op["candidateId"].is_string()
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
                        if !manual && decisions.is_some() {proposed["partPoints"]=selection_part_points(new_question,c,&slots[i],&draft["baseline"]["requirements"]);}
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
                        let mut decision=c.clone();
                        if !manual && decisions.is_some() {decision["criteriaSha256"]=json!(crate::assembly_llm::signature(&slots[i],&draft["baseline"]["requirements"]));}
                        slots[i]["applicability"] = decision;
                        results.push(json!({"slotId":sid,"status":"replaced"}));
                    } else {
                        if manual {
                            return Err(invalid(
                                "此题已在本卷使用或题型不一致，请重新选择真实题目。",
                            ));
                        }
                        if decisions.is_some() && op["candidateId"].is_string(){return Err(invalid("所选候选已被其它题位使用或判断失效，原题保留，请重新评估。"));}
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
                if decisions.is_none() && !intake::overlaps(
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
                if slots[i]["question"].is_object() && decisions.is_none() {
                    let c = legacy_assess(
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
                    if slot["question"].is_object() && decisions.is_none() {
                        slot["applicability"] = legacy_assess(
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
            if decisions.is_some() && !manual && slot["question"].is_object() && !crate::assembly_llm::saved_matches(&slot["applicability"],&slot["question"],slot,&draft["baseline"]["requirements"]) {
                slot["applicability"] = json!({"status":"unknown","canSelect":false,"reasons":["本题位要求已改变或缺少当前版本的模型判断；现题保留，请显式换题重新评估。"]});
            }
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
        if !is_manual(draft) && !crate::assembly_llm::saved_matches(&slot["applicability"],q,slot,&draft["baseline"]["requirements"]) && !issues.iter().any(|issue|issue["code"]=="applicability_unconfirmed" && issue["slotId"]==slot["slotId"]) {
            issues.push(json!({"code":"applicability_unconfirmed","slotId":slot["slotId"],"message":"本题缺少与当前要求及版本一致的模型适配判断；现题保留，教师确认前可显式重新评估。"}));
        }
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
        crate::bank_teaching::verify_projection(q)?;
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
        let config=store.bank.config()?;
        let mut identities=HashSet::new();let mut groups=HashSet::new();
        // Re-read exact local versions; a modified bank cannot silently alter frozen snapshots.
        for slot in list(&draft["slots"]) {
            if slot["question"].is_object() {
                let q = &slot["question"];
                if !identities.insert(s(q,"questionId").to_owned()) || !groups.insert(crate::assembly_llm::duplicate_group(q,&config)) {return Err(invalid("本卷含有重复题目，未确认成卷；请先更换或移除重复题。"));}
                crate::bank_teaching::verify_projection(q)?;
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
        "blueprint_plan" => {
            let blueprint=plan(store,payload,model,cancel)?;
            let steps=if blueprint["generation"]["provenance"]=="task_catalog_incomplete" {vec!["plan_supply","plan_check"]} else {vec!["plan_supply","plan_slots","plan_check"]};
            json!({"blueprint":blueprint,"workflowSteps":steps})
        },
        "blueprint_check" => json!({"blueprint":check_blueprint(store,&payload["blueprint"])?}),
        "draft_create" => create_draft(store, payload, model, cancel)?,
        "manual_draft_create" => manual_draft_create(store, payload, cancel)?,
        "history_delete" => store.delete_history(payload)?,
        "draft_get" => json!({"draft":store.document("drafts",s(payload,"draftId"))?}),
        "draft_operation" => edit(store, payload, model, cancel)?,
        "draft_candidates" => {
            let mut draft = store.document("drafts", s(payload, "draftId"))?;
            let slots = list(&draft["slots"]);
            let i = find_slot(&slots, s(payload, "slotId"))?;
            let pool = current_question_pool(store)?;
            let mut missing=String::new();
            let mut preview = if is_manual(&draft) { manual_candidates(&pool, &slots[i], &slots)
            } else {
                if draft["confirmedPaperId"].is_string(){return Err(error("finalized_draft","此草稿已成卷，不能修改候选判断；请继续编辑为新草稿。"));}
                revision(&draft,payload)?;check_cancel(cancel)?;
                let config=store.bank.config()?;
                let evaluated=if payload["continuation"].is_null(){crate::assembly_llm::evaluate(&pool,&[slots[i].clone()],&draft["baseline"]["requirements"],&config,&slots,model,cancel)?}
                    else{crate::assembly_llm::continue_evaluate(&pool,&slots[i],&draft["baseline"]["requirements"],&config,&slots,model,cancel,&draft["candidateEvaluations"][s(payload,"slotId")],&payload["continuation"])?};
                let row=&evaluated[0];missing=s(row,"missingReason").to_owned();
                if !draft["candidateEvaluations"].is_object(){draft["candidateEvaluations"]=json!({});}
                draft["candidateEvaluations"][s(payload,"slotId")]=row.clone();
                let result=list(&row["candidates"]);
                check_cancel(cancel)?;
                draft["revision"]=json!(draft["revision"].as_u64().unwrap_or(0)+1);draft["updatedAt"]=json!(now());
                transact(store,|store|{
                    let current=store.document("drafts",s(payload,"draftId"))?;
                    revision(&current,payload)?;
                    if current["confirmedPaperId"].is_string(){return Err(error("finalized_draft","草稿已成卷，候选判断未写入。"));}
                    check_cancel(cancel)?;
                    store.put_document("drafts",s(payload,"draftId"),&draft)?;
                    Ok(())
                })?;
                result
            };
            for candidate in &mut preview {
                candidate["question"] = pool
                    .iter()
                    .find(|q| q["questionId"] == candidate["questionId"])
                    .ok_or_else(|| error("integrity_error", "备选题内容缺失，未省略内容。"))?
                    .clone();
            }
            json!({"candidates":preview,"search":draft["candidateEvaluations"][s(payload,"slotId")]["search"],"continuation":draft["candidateEvaluations"][s(payload,"slotId")]["search"]["continuation"],"draft":draft,"missingReason":missing})
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
    fn write_simulated_config(store:&Store,config:&Value) {
        let connection=rusqlite::Connection::open(store.data_dir.join("question-bank.sqlite")).unwrap();
        connection.execute("UPDATE bank_metadata SET value=?1 WHERE key='config'",[config.to_string()]).unwrap();
    }
    fn llm_fixture(directory:&std::path::Path, count:usize, respond:impl Fn(usize,&Value)->Value+Send+'static)->(ModelClient,std::thread::JoinHandle<()>) {
        use std::{io::{Read,Write},net::TcpListener,time::{Duration,Instant}};
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();listener.set_nonblocking(true).unwrap();
        let model=ModelClient::test_client(directory,&format!("http://{}/v1",listener.local_addr().unwrap()));
        let worker=std::thread::spawn(move||{
            for attempt in 0..count {
                let deadline=Instant::now()+Duration::from_secs(30);
                let mut stream=loop {match listener.accept(){Ok((stream,_))=>break stream,Err(e) if e.kind()==std::io::ErrorKind::WouldBlock && Instant::now()<deadline=>std::thread::sleep(Duration::from_millis(5)),Err(e)=>panic!("simulated model fixture did not receive expected request: {e}")}};
                stream.set_nonblocking(false).unwrap();stream.set_read_timeout(Some(Duration::from_secs(15))).unwrap();let mut bytes=Vec::new();
                let start=loop{let mut buffer=[0;8192];let n=stream.read(&mut buffer).unwrap();assert!(n>0);bytes.extend_from_slice(&buffer[..n]);assert!(bytes.len()<16*1024*1024);if let Some(end)=bytes.windows(4).position(|b|b==b"\r\n\r\n"){let headers=String::from_utf8_lossy(&bytes[..end]).to_lowercase();let size=headers.lines().find_map(|line|line.strip_prefix("content-length:").map(|n|n.trim().parse::<usize>().unwrap())).unwrap();if bytes.len()>=end+4+size{break end+4;}}};
                let body:Value=serde_json::from_slice(&bytes[start..]).unwrap();
                let context:Value=serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
                assert!(!context.to_string().contains("simulated-private-student"));
                let output=respond(attempt,&context);
                let response=json!({"choices":[{"finish_reason":"stop","message":{"content":output.to_string()}}],"usage":{"prompt_tokens":123,"completion_tokens":456}}).to_string();
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
            }
        });(model,worker)
    }
    fn llm_candidate(context:&Value,index:usize,status:&str)->Value {
        let q=&context["questions"][index];
        json!({"questionId":q["questionId"],"contentVersion":q["contentVersion"],"teacherVersion":q["teacherVersion"],"status":status,"reason":"模拟模型根据真实题面给出的教学关系判断；不是数学独立核验。","difficulty":{"level":"medium","basis":"模拟内容关口判断。"},"solutionBasis":"模拟模型对已提供题面与参考的可用解法判断，不依赖旧solutionPaths。","partPoints":[]})
    }
    fn llm_slot_candidate(context:&Value,slot_index:usize,index:usize,status:&str)->Value{
        let id=&context["slots"][slot_index]["candidateQuestionIds"][index];
        let q=context["questions"].as_array().unwrap().iter().position(|q|q["questionId"]==*id).unwrap();
        llm_candidate(context,q,status)
    }
    fn simulated_window_pool(store:&Store,count:usize,slot_count:usize)->(Vec<Value>,Value,Value,Vec<Value>){
        let original=store.bank.questions().unwrap().into_iter().find(|q|q["questionType"]=="single_choice" && list(&q["student"]["assets"]).is_empty() && list(&q["assetPayloads"]).is_empty()).unwrap();
        let mut pool=Vec::new();let mut entries=Vec::new();let mut config=store.bank.config().unwrap();
        let slots:Vec<_>=(0..slot_count).map(|i|json!({"slotId":format!("window-slot-{i}"),"taskId":format!("window-task-{i}"),"taskLabel":"模拟窗口任务","questionType":"single_choice","goalIds":[],"points":0,"partPoints":[]})).collect();
        config["tasks"]=json!(slots.iter().map(|slot|json!({"id":slot["taskId"],"sectionIds":["1.1"]})).collect::<Vec<_>>());
        for i in 0..count{
            let mut q=original.clone();q["questionId"]=json!(format!("window-q-{i:03}"));q["student"]["stem"]=json!(format!("{} [模拟窗口唯一题 {i}]",s(&original["student"],"stem")));
            let sha=hash(&q["student"]);let version=format!("content-{}",&sha[..16]);q["contentSha256"]=json!(sha);q["contentVersion"]=json!(version);q["verification"]["contentVersion"]=json!(version);
            crate::bank::verify_question(&q).unwrap();
            if i+1<count{
                let tasks=if i==0{slots.iter().map(|slot|slot["taskId"].clone()).collect::<Vec<_>>()}else{vec![json!(format!("window-task-{}",(i-1)/40))]};
                entries.push(json!({"questionId":q["questionId"],"contentVersion":q["contentVersion"],"teacherVersion":q["teacherVersion"],"tasks":tasks,"primarySections":["1.3"],"primaryKnowledgeUids":["window-leaf"],"annotationSource":"simulated","solutionPaths":[{"id":"window-path","requiredKnowledgeUids":["window-leaf"],"requiredPremises":["vieta"],"basis":"SIMULATED_FULL_PATH_BASIS_MUST_NOT_SEND"}]}));
            }
            pool.push(q);
        }
        config["assemblyIndex"]["entries"]=json!(entries);
        config["knowledgeCatalogue"]["points"]=json!([{ "uid":"window-parent","name":"模拟引用父知识点","sectionIds":["1.1"]},{"uid":"window-leaf","name":"模拟引用知识点","parentUid":"window-parent","sectionIds":["1.3"]},{"uid":"window-unrelated","name":"模拟不应发送的知识点","sectionIds":["rja-compulsory-1:2.3"]}]);
        let requirements=json!({"mainScope":["1.1"],"learnedScope":["1.1"],"counts":{"single_choice":slot_count},"scoringMode":"none","targetScore":0,"teachingGoals":[],"premises":["vieta"]});
        (pool,config,requirements,slots)
    }
    fn simulated_selection_events() -> Vec<(String,String)> {
        ["select_pool","select_evaluate","select_save"].into_iter()
            .flat_map(|step|["running","completed"].map(|status|(step.to_owned(),status.to_owned())))
            .collect()
    }
    fn observe_selection<T>(action:impl FnOnce()->T) -> (T,Vec<(String,String)>) {
        let events=std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let captured=events.clone();
        let result=crate::workflow_progress::observe(move|step,status|captured.borrow_mut().push((step.to_owned(),status.to_owned())),action);
        let recorded=events.borrow().clone();
        (result,recorded)
    }
    #[test]
    fn current_llm_http_planning_selection_query_direct_replace_confirm_preserve_boundaries() {
        let (dir,mut store,_)=simulated_flow_store();
        let (model,server)=llm_fixture(dir.path(),3,|attempt,context|{
            if attempt==0 {
                assert!(context.get("slots").is_none());
                return json!({"slots":[{"taskId":"set_determinacy","points":0,"partPoints":[],"planningReason":"模拟模型独立规划考查任务。"}]});
            }
            assert!(context["questions"].as_array().unwrap().len()>2);
            assert!(context["questions"][0]["student"]["stem"].is_string());
            assert!(context["questions"][0].get("audit").is_none());
            json!({"rankings":[{"slotId":context["slots"][0]["slotId"],"candidates":[llm_candidate(context,0,"suitable"),llm_candidate(context,1,"unsuitable")],"missingReason":""}]})
        });
        let cancel=AtomicBool::new(false);
        let blueprint=plan(&store,&json!({"mode":"llm","requirements":{"mainScope":["1.1"],"learnedScope":["1.1"],"scoringMode":"none","counts":{"single_choice":1,"multiple_choice":0,"fill_blank":0,"free_response":0}}}),&model,&cancel).unwrap();
        let (created,events)=observe_selection(||create_draft(&mut store,&json!({"mode":"llm","blueprint":blueprint}),&model,&cancel));
        let created=created.unwrap();
        assert_eq!(events,simulated_selection_events());
        assert_eq!(created["workflowSteps"],json!(["select_pool","select_evaluate","select_save"]));
        let created=created["draft"].clone();
        let draft_id=s(&created,"draftId").to_owned();
        assert_eq!(created["slots"][0]["status"],"selected");
        assert_eq!(created["slots"][0]["applicability"]["provenance"],"llm_selection_v1");
        let query=json!({"draftId":draft_id,"slotId":"slot-1","expectedRevision":0});
        assert_eq!(dispatch(&mut store,"draft_candidates",&query,&model,&AtomicBool::new(true)).unwrap_err().code,"cancelled");
        assert_eq!(store.document("drafts",&draft_id).unwrap()["revision"],0);
        let offered=dispatch(&mut store,"draft_candidates",&query,&model,&cancel).unwrap().unwrap();
        assert_eq!(offered["draft"]["revision"],1);
        assert_eq!(offered["candidates"].as_array().unwrap().len(),1);
        let candidate=&offered["candidates"][0];
        let replacement=json!({"draftId":draft_id,"operation":{"type":"replace","mode":"direct","slotIds":["slot-1"],"candidateId":candidate["questionId"],"contentVersion":candidate["contentVersion"],"teacherVersion":candidate["teacherVersion"],"expectedRevision":1,"operationId":"simulated-llm-direct"}});
        let replaced=edit(&mut store,&replacement,&model,&cancel).unwrap()["draft"].clone();
        assert_eq!(replaced["revision"],2);
        assert_eq!(replaced["slots"][0]["question"]["questionId"],candidate["questionId"]);
        assert!(crate::assembly_llm::saved_matches(&replaced["slots"][0]["applicability"],&replaced["slots"][0]["question"],&replaced["slots"][0],&replaced["baseline"]["requirements"]));
        let paper=confirm(&mut store,&json!({"draftId":draft_id,"expectedRevision":2,"operationId":"simulated-llm-confirm","acknowledgeDifferences":true})).unwrap()["paper"].clone();
        verify_frozen_paper(&paper).unwrap();
        assert_eq!(dispatch(&mut store,"draft_candidates",&json!({"draftId":draft_id,"slotId":"slot-1","expectedRevision":3}),&model,&cancel).unwrap_err().code,"finalized_draft");
        dispatch(&mut store,"paper_get",&json!({"paperId":paper["paperId"]}),&model,&cancel).unwrap();
        server.join().unwrap();
    }
    #[test]
    fn current_llm_http_rejects_fabricated_versions_duplicate_and_preserves_real_shortage() {
        let (dir,mut store,_)=simulated_flow_store();
        let requirements=intake::normalize(&store,&json!({"mainScope":["1.1"],"learnedScope":["1.1"],"scoringMode":"none","counts":{"single_choice":1,"multiple_choice":0,"fill_blank":0,"free_response":0}})).unwrap();
        let blueprint=check_blueprint(&store,&json!({"requirements":requirements,"slots":[{"slotId":"slot-1","number":1,"taskId":"set_determinacy","questionType":"single_choice","points":0,"partPoints":[]}],"generation":{"mode":"llm"}})).unwrap();
        let (model,server)=llm_fixture(dir.path(),5,|attempt,context|{
            let mut candidate=llm_candidate(context,0,"suitable");
            let candidates=match attempt {
                0=>{candidate["questionId"]=json!("simulated-invented-question");vec![candidate]},
                1=>{candidate["teacherVersion"]=json!("simulated-old-version");vec![candidate]},
                2=>vec![candidate.clone(),candidate],
                _=>vec![llm_candidate(context,0,"uncertain")],
            };
            json!({"rankings":[{"slotId":"slot-1","candidates":candidates,"missingReason":"模拟模型无法确认本题位适配，保留一题缺口。"}]})
        });
        for attempt in 0..4 {
            let (result,events)=observe_selection(||create_draft(&mut store,&json!({"mode":"llm","blueprint":blueprint}),&model,&AtomicBool::new(false)));
            if attempt<3 {assert!(result.is_err());assert_eq!(events,simulated_selection_events()[..3]);assert!(store.list_documents("drafts").unwrap().is_empty());}
            else {assert_eq!(events,simulated_selection_events());let draft=result.unwrap()["draft"].clone();assert!(draft["slots"][0]["question"].is_null());assert_eq!(draft["stats"]["missingCount"],1);assert_eq!(draft["baseline"]["requirements"]["questionCount"],1);assert!(draft["slots"][0]["selection"]["reasons"][0].as_str().unwrap().contains("模拟模型无法确认本题位适配，保留一题缺口。"));}
        }
        server.join().unwrap();
    }
    #[test]
    fn current_llm_http_candidate_query_revision_race_and_cancel_do_not_overwrite_draft() {
        let (dir,mut store,old_model)=simulated_flow_store();
        // Explicit historical fixture construction; the exercised query uses the real current LLM path.
        let blueprint=legacy_plan(&store,&json!({"mode":"rule","requirements":{"mainScope":["1.1"],"learnedScope":["1.1"],"scoringMode":"none","counts":{"single_choice":1,"multiple_choice":0,"fill_blank":0,"free_response":0}}}),&old_model,&AtomicBool::new(false)).unwrap();
        let draft=legacy_create_draft(&mut store,&json!({"mode":"rule","blueprint":blueprint}),&old_model,&AtomicBool::new(false)).unwrap()["draft"].clone();
        let draft_id=s(&draft,"draftId").to_owned();let target=draft_id.clone();
        let db_path=dir.path().join("personal.sqlite");
        let cancel=std::sync::Arc::new(AtomicBool::new(false));let stop=cancel.clone();
        let (model,server)=llm_fixture(dir.path(),2,move|attempt,context|{
            if attempt==0 {
                let db=rusqlite::Connection::open(&db_path).unwrap();
                let text:String=db.query_row("SELECT payload FROM documents WHERE kind='drafts' AND id=?1",[&target],|row|row.get(0)).unwrap();
                let mut changed:Value=serde_json::from_str(&text).unwrap();changed["revision"]=json!(1);changed["title"]=json!("模拟另一窗口已保存标题");
                db.execute("UPDATE documents SET payload=?2 WHERE kind='drafts' AND id=?1",rusqlite::params![target,changed.to_string()]).unwrap();
            } else {stop.store(true,Ordering::Relaxed);}
            json!({"rankings":[{"slotId":"slot-1","candidates":[llm_candidate(context,0,"suitable")],"missingReason":""}]})
        });
        let query=json!({"draftId":draft_id,"slotId":"slot-1","expectedRevision":0});
        assert_eq!(dispatch(&mut store,"draft_candidates",&query,&model,&cancel).unwrap_err().code,"revision_conflict");
        let saved=store.document("drafts",&draft_id).unwrap();assert_eq!(saved["title"],"模拟另一窗口已保存标题");assert_eq!(saved["revision"],1);assert!(saved.get("candidateEvaluations").is_none());
        assert_eq!(dispatch(&mut store,"draft_candidates",&json!({"draftId":draft_id,"slotId":"slot-1","expectedRevision":1}),&model,&cancel).unwrap_err().code,"cancelled");
        assert_eq!(hash(&store.document("drafts",&draft_id).unwrap()),hash(&saved));
        server.join().unwrap();
    }
    #[test]
    fn current_llm_http_seven_slots_use_two_validated_batches_and_cancel_without_partial_draft() {
        let (dir,mut store,_)=simulated_flow_store();
        let requirements=intake::normalize(&store,&json!({"mainScope":["1.1"],"learnedScope":["1.1"],"scoringMode":"none","counts":{"single_choice":7,"multiple_choice":0,"fill_blank":0,"free_response":0}})).unwrap();
        let slots:Vec<_>=(0..7).map(|i|json!({"slotId":format!("slot-{}",i+1),"number":i+1,"taskId":"set_determinacy","questionType":"single_choice","points":0,"partPoints":[]})).collect();
        let blueprint=check_blueprint(&store,&json!({"requirements":requirements,"slots":slots,"generation":{"mode":"llm"}})).unwrap();
        let cancel=std::sync::Arc::new(AtomicBool::new(false));let stop=cancel.clone();
        let config=store.bank.config().unwrap();
        let groups:HashMap<_,_>=current_question_pool(&store).unwrap().iter().map(|q|(s(q,"questionId").to_owned(),crate::assembly_llm::duplicate_group(q,&config))).collect();
        let (model,server)=llm_fixture(dir.path(),4,move|attempt,context|{
            let second=attempt%2==1;
            assert_eq!(context["candidateLimit"],3);
            assert_eq!(context["batch"]["total"],2);
            assert_eq!(context["slots"].as_array().unwrap().len(),if second{1}else{6});
            let rankings:Vec<_>=context["slots"].as_array().unwrap().iter().map(|slot|{
                let mut seen=HashSet::new();let ids:Vec<_>=strings(&slot["candidateQuestionIds"]).into_iter().filter(|id|seen.insert(groups[id].clone())).collect();
                let number=s(slot,"slotId").strip_prefix("slot-").unwrap().parse::<usize>().unwrap();
                let id=&ids[number-1];let index=context["questions"].as_array().unwrap().iter().position(|q|q["questionId"]==*id).unwrap();
                json!({"slotId":slot["slotId"],"candidates":[llm_candidate(context,index,"suitable")],"missingReason":""})
            }).collect();
            if attempt==3{stop.store(true,Ordering::Relaxed);}
            json!({"rankings":rankings})
        });
        let input=json!({"mode":"llm","blueprint":blueprint});
        let result=create_draft(&mut store,&input,&model,&cancel).unwrap();
        assert_eq!(result["draft"]["slots"].as_array().unwrap().len(),7);
        assert_eq!(result["draft"]["stats"]["selectedCount"],7);
        let before=store.list_documents("drafts").unwrap();
        let (cancelled,events)=observe_selection(||create_draft(&mut store,&input,&model,&cancel));
        assert_eq!(cancelled.unwrap_err().code,"cancelled");
        assert_eq!(events,simulated_selection_events()[..3]);
        assert_eq!(hash(&json!(store.list_documents("drafts").unwrap())),hash(&json!(before)));
        let mut empty_sources=requirements.clone();empty_sources["sourceIds"]=json!([]);
        let pool=current_question_pool(&store).unwrap();
        assert!(!crate::assembly_llm::available(&pool[0],&slots[0],&empty_sources,&store.bank.config().unwrap(),&[]));
        server.join().unwrap();
    }
    #[test]
    fn current_llm_http_selection_progress_cancel_before_save_never_reports_or_persists_completion() {
        let (dir,mut store,_)=simulated_flow_store();
        let requirements=intake::normalize(&store,&json!({"mainScope":["1.1"],"learnedScope":["1.1"],"scoringMode":"none","counts":{"single_choice":1,"multiple_choice":0,"fill_blank":0,"free_response":0}})).unwrap();
        let blueprint=check_blueprint(&store,&json!({"requirements":requirements,"slots":[{"slotId":"slot-1","number":1,"taskId":"set_determinacy","questionType":"single_choice","points":0,"partPoints":[]}],"generation":{"mode":"llm"}})).unwrap();
        let (model,server)=llm_fixture(dir.path(),1,|_,context|json!({"rankings":[{"slotId":"slot-1","candidates":[llm_candidate(context,0,"suitable")],"missingReason":""}]}));
        let input=json!({"mode":"llm","blueprint":blueprint});
        let (cancelled,events)=observe_selection(||create_draft(&mut store,&input,&model,&AtomicBool::new(true)));
        assert_eq!(cancelled.unwrap_err().code,"cancelled");
        assert!(events.is_empty());
        let (invalid,events)=observe_selection(||create_draft(&mut store,&json!({"mode":"llm","blueprint":{}}),&model,&AtomicBool::new(false)));
        assert!(invalid.is_err());
        assert_eq!(events,simulated_selection_events()[..1]);
        let events=std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let captured=events.clone();
        let cancel=std::sync::Arc::new(AtomicBool::new(false));
        let stop=cancel.clone();
        let cancelled=crate::workflow_progress::observe(move|step,status|{
            captured.borrow_mut().push((step.to_owned(),status.to_owned()));
            if step=="select_save" && status=="running" {stop.store(true,Ordering::Relaxed);}
        },||create_draft(&mut store,&input,&model,&cancel));
        assert_eq!(cancelled.unwrap_err().code,"cancelled");
        assert_eq!(*events.borrow(),simulated_selection_events()[..5]);
        assert!(store.list_documents("drafts").unwrap().is_empty());
        server.join().unwrap();
        // Observer teardown must keep a later, unrelated request isolated.
        crate::workflow_progress::emit("scope","running");
        assert_eq!(*events.borrow(),simulated_selection_events()[..5]);
    }
    fn simulated_plan_input(mode: &str) -> Value {
        json!({"requirements":{"title":"模拟分步规划","mainScope":["1.1"],"learnedScope":["1.1"],"scoringMode":"none","counts":{"single_choice":2,"multiple_choice":0,"fill_blank":0,"free_response":0}},"mode":mode})
    }
    fn simulated_plan_events() -> Vec<(String, String)> {
        ["plan_supply", "plan_slots", "plan_check"].into_iter()
            .flat_map(|step| ["running", "completed"].map(|status| (step.to_owned(), status.to_owned())))
            .collect()
    }
    #[test]
    fn simulated_blueprint_progress_rule_is_retired_without_selection_or_storage() {
        let (_dir,mut store,model)=simulated_flow_store();
        assert_eq!(dispatch(&mut store,"blueprint_plan",&simulated_plan_input("rule"),&model,&AtomicBool::new(false)).unwrap_err().code,"rule_retired");
        assert!(store.list_documents("drafts").unwrap().is_empty());
        assert_eq!(plan(&store,&simulated_plan_input("llm"),&model,&AtomicBool::new(true)).unwrap_err().code,"cancelled");
    }
    #[test]
    fn legacy_simulated_blueprint_progress_failure_cancel_and_retry_do_not_forge_completed_steps() {
        use std::{cell::RefCell, rc::Rc, sync::Arc};
        let (_dir, store, model) = simulated_flow_store();
        let expected = simulated_plan_events();
        let events = Rc::new(RefCell::new(Vec::new()));
        let mut invalid = simulated_plan_input("rule");
        invalid["requirements"]["mainScope"] = json!(["simulated-invented-section"]);
        let captured = events.clone();
        let error = crate::workflow_progress::observe(move |step, status| captured.borrow_mut().push((step.to_owned(), status.to_owned())),
            || legacy_plan(&store, &invalid, &model, &AtomicBool::new(false))).unwrap_err();
        assert_eq!(error.code, "invalid_plan");
        assert_eq!(*events.borrow(), expected[..1]);
        events.borrow_mut().clear();
        let captured = events.clone();
        let error = crate::workflow_progress::observe(move |step, status| captured.borrow_mut().push((step.to_owned(), status.to_owned())),
            || legacy_plan(&store, &simulated_plan_input("llm"), &model, &AtomicBool::new(false))).unwrap_err();
        assert_eq!(error.code, "not_configured");
        assert_eq!(*events.borrow(), expected[..3]);
        for stop_at in 0..5 {
            events.borrow_mut().clear();
            let cancel = Arc::new(AtomicBool::new(false));
            let stop = cancel.clone();
            let captured = events.clone();
            let target = expected[stop_at].clone();
            let error = crate::workflow_progress::observe(move |step, status| {
                captured.borrow_mut().push((step.to_owned(), status.to_owned()));
                if (step, status) == (target.0.as_str(), target.1.as_str()) { stop.store(true, Ordering::Relaxed); }
            }, || legacy_plan(&store, &simulated_plan_input("rule"), &model, &cancel)).unwrap_err();
            assert_eq!(error.code, "cancelled");
            assert_eq!(*events.borrow(), expected[..=stop_at]);
        }
        events.borrow_mut().clear();
        let captured = events.clone();
        assert_eq!(crate::workflow_progress::observe(move |step, status| captured.borrow_mut().push((step.to_owned(), status.to_owned())),
            || legacy_plan(&store, &simulated_plan_input("rule"), &model, &AtomicBool::new(true))).unwrap_err().code, "cancelled");
        assert!(events.borrow().is_empty());
        let captured = events.clone();
        crate::workflow_progress::observe(move |step, status| captured.borrow_mut().push((step.to_owned(), status.to_owned())),
            || legacy_plan(&store, &simulated_plan_input("rule"), &model, &AtomicBool::new(false))).unwrap();
        assert_eq!(*events.borrow(), expected);
        assert!(store.list_documents("drafts").unwrap().is_empty());
    }
    #[test]
    fn simulated_blueprint_progress_llm_transport_and_validation_have_distinct_stages() {
        use std::{cell::RefCell, rc::Rc, io::{Read, Write}, net::TcpListener, time::{Duration, Instant}};
        let (_dir, mut store, mut model) = simulated_flow_store();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
        model.save(&json!({"expectedRevision":0,"activeProfileId":"simulated-planning-progress","profiles":[{"id":"simulated-planning-progress","name":"模拟本地规划","baseUrl":endpoint,"model":"simulated-blueprint","apiKey":"simulated-local-key"}]})).unwrap();
        let server = std::thread::spawn(move || {
            for attempt in 0..3 {
                let deadline = Instant::now() + Duration::from_secs(15);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
                        Err(error) => panic!("simulated planning request not received: {error}"),
                    }
                };
                stream.set_nonblocking(false).unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
                let mut bytes = Vec::new();
                let start = loop {
                    let mut buffer = [0; 4096];
                    let count = stream.read(&mut buffer).unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&buffer[..count]);
                    assert!(bytes.len() < 2 * 1024 * 1024);
                    if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                        let size = headers.lines().find_map(|line| line.strip_prefix("content-length:").map(|value| value.trim().parse::<usize>().unwrap())).unwrap();
                        if bytes.len() >= end + 4 + size { break end + 4; }
                    }
                };
                let request: Value = serde_json::from_slice(&bytes[start..]).unwrap();
                let context: Value = serde_json::from_str(request["messages"][1]["content"].as_str().unwrap()).unwrap();
                assert_eq!(context["requirements"]["questionCount"], 2);
                let slot=json!({"taskId":context["tasks"][0]["id"],"points":0,"partPoints":[]});
                let slots=vec![slot;if attempt==1{1}else{2}];
                let response = json!({"choices":[{"finish_reason":if attempt == 0 {"length"} else {"stop"},"message":{"content":json!({"slots":slots}).to_string()}}]}).to_string();
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
            }
        });
        let expected = simulated_plan_events();
        for attempt in 0..3 {
            let events = Rc::new(RefCell::new(Vec::new()));
            let captured = events.clone();
            let result = crate::workflow_progress::observe(move |step, status| captured.borrow_mut().push((step.to_owned(), status.to_owned())),
                || dispatch(&mut store, "blueprint_plan", &simulated_plan_input("llm"), &model, &AtomicBool::new(false)));
            match attempt {
                0 => { assert_eq!(result.unwrap_err().code, "model_output_truncated"); assert_eq!(*events.borrow(), expected[..3]); }
                1 => {
                    let result=result.unwrap().unwrap();
                    assert_eq!(result["blueprint"]["quantityReview"],json!({"matches":false,"expectedCounts":{"single_choice":2,"multiple_choice":0,"fill_blank":0,"free_response":0},"actualCounts":{"single_choice":1,"multiple_choice":0,"fill_blank":0,"free_response":0},"expectedTotal":2,"actualTotal":1}));
                    assert_eq!(*events.borrow(),expected);
                }
                _ => {
                    let result = result.unwrap().unwrap();
                    assert_eq!(result["workflowSteps"], json!(["plan_supply", "plan_slots", "plan_check"]));
                    assert_eq!(result["blueprint"]["generation"]["mode"], "llm");
                    assert_eq!(result["blueprint"]["quantityReview"]["matches"],true);
                    assert_eq!(*events.borrow(), expected);
                }
            }
            assert!(store.list_documents("drafts").unwrap().is_empty());
            assert!(store.list_documents("papers").unwrap().is_empty());
        }
        server.join().unwrap();
    }
    #[test]
    fn current_llm_http_quantity_review_keeps_overages_blocked_and_corrected_shortage_can_continue() {
        let (dir,mut store,_)=simulated_flow_store();
        let input=json!({"mode":"llm","requirements":{"mainScope":["1.1"],"learnedScope":["1.1"],"scoringMode":"none","counts":{"single_choice":1,"multiple_choice":0,"fill_blank":1,"free_response":0}}});
        let requirements=intake::normalize(&store,&input["requirements"]).unwrap();
        let (model,server)=llm_fixture(dir.path(),5,|attempt,context|{
            if attempt<3 {
                let tasks=list(&context["tasks"]);
                let slot=|kind:&str|json!({"taskId":tasks.iter().find(|task|s(task,"questionType")==kind).unwrap()["id"],"points":0,"partPoints":[],"planningReason":"模拟模型原始题位，保留数量差异供修改。"});
                let slots=match attempt {0=>vec![slot("single_choice"),slot("single_choice")],1=>vec![slot("single_choice")],_=>vec![slot("single_choice"),slot("fill_blank"),slot("single_choice")]};
                return json!({"slots":slots});
            }
            assert_eq!(context["slots"].as_array().unwrap().len(),2);
            json!({"rankings":list(&context["slots"]).iter().map(|slot|json!({"slotId":slot["slotId"],"candidates":[],"missingReason":"模拟模型未确认适配候选，保留真实缺题位。"})).collect::<Vec<_>>()})
        });
        let cancel=AtomicBool::new(false);
        let mut first_review=Value::Null;
        for attempt in 0..3 {
            let result=dispatch(&mut store,"blueprint_plan",&input,&model,&cancel).unwrap().unwrap();
            let blueprint=&result["blueprint"];
            let actual=match attempt {0=>json!({"single_choice":2,"multiple_choice":0,"fill_blank":0,"free_response":0}),1=>json!({"single_choice":1,"multiple_choice":0,"fill_blank":0,"free_response":0}),_=>json!({"single_choice":2,"multiple_choice":0,"fill_blank":1,"free_response":0})};
            assert_eq!(blueprint["requirements"],requirements);
            assert_eq!(blueprint["quantityReview"],json!({"matches":false,"expectedCounts":requirements["counts"],"actualCounts":actual,"expectedTotal":2,"actualTotal":([2,1,3][attempt])}));
            assert_eq!(blueprint["slots"].as_array().unwrap().len(),[2,1,3][attempt]);
            assert_eq!(blueprint["slots"][0]["planningReason"],"模拟模型原始题位，保留数量差异供修改。");
            assert_eq!(dispatch(&mut store,"blueprint_check",&json!({"blueprint":blueprint}),&model,&cancel).unwrap_err().code,"invalid_plan");
            if attempt!=1 {assert_eq!(create_draft(&mut store,&json!({"mode":"llm","blueprint":blueprint}),&model,&cancel).unwrap_err().code,"invalid_plan");}
            assert!(store.list_documents("drafts").unwrap().is_empty());
            assert!(store.list_documents("papers").unwrap().is_empty());
            if attempt==0 {first_review=blueprint.clone();}
        }
        // Simulate the teacher changing only the second task, keeping confirmed requirements.
        let config=store.bank.config().unwrap();
        let fill=list(&config["tasks"]).into_iter().find(|task|s(task,"questionType")=="fill_blank").unwrap();
        first_review["slots"][1]["taskId"]=fill["id"].clone();
        first_review["slots"][1]["questionType"]=fill["questionType"].clone();
        let corrected=check_blueprint(&store,&first_review).unwrap();
        assert_eq!(corrected["requirements"],requirements);
        assert!(corrected.get("quantityReview").is_none());
        let draft=create_draft(&mut store,&json!({"mode":"llm","blueprint":corrected}),&model,&cancel).unwrap()["draft"].clone();
        assert_eq!(draft["slots"].as_array().unwrap().len(),2);
        assert_eq!(draft["baseline"]["requirements"],requirements);
        server.join().unwrap();
    }
    #[test]
    fn current_llm_http_quantity_review_retains_structure_boundaries_and_reviews_incomplete_points() {
        let (dir,mut store,_)=simulated_flow_store();
        let cancel=std::sync::Arc::new(AtomicBool::new(false));let stop=cancel.clone();
        let (model,server)=llm_fixture(dir.path(),6,move|attempt,context|{
            if attempt==0 {return json!({"slots":[{"taskId":"simulated-invented-task","points":0,"partPoints":[]}]});}
            if attempt==1 {return json!({"slots":"simulated-invalid-structure"});}
            if attempt==2 {return json!({"slots":[]});}
            let slot=json!({"taskId":context["tasks"][0]["id"],"points":if attempt==4{1}else{0},"partPoints":[]});
            if attempt==3 {return json!({"slots":vec![slot;61]});}
            if attempt==5 {stop.store(true,Ordering::Relaxed);}
            json!({"slots":[slot]})
        });
        for attempt in 0..6 {
            let mut input=simulated_plan_input("llm");
            if attempt==4 {input["requirements"]["scoringMode"]=json!("points");input["requirements"]["targetScore"]=json!(100);}
            let result=plan(&store,&input,&model,&cancel);
            if attempt==5 {assert_eq!(result.unwrap_err().code,"cancelled");}
            else if attempt==2 || attempt==4 {
                let blueprint=result.unwrap();
                assert_eq!(blueprint["slots"].as_array().unwrap().len(),if attempt==2{0}else{1});
                assert_eq!(blueprint["quantityReview"]["matches"],false);
                assert!(check_blueprint(&store,&blueprint).is_err());
                if attempt==4 {
                    assert_eq!(blueprint["requirements"]["targetScore"],100);
                    let mut corrected_quantity=blueprint.clone();
                    corrected_quantity["slots"].as_array_mut().unwrap().push(intake::merge(&blueprint["slots"][0],&json!({"slotId":"slot-2","number":2})));
                    assert!(check_blueprint(&store,&corrected_quantity).unwrap_err().message.contains("分值合计"));
                }
            } else {let error=result.unwrap_err();assert_eq!(error.code,"invalid_plan");if attempt==3 {assert!(error.message.contains("最多 60"));}}
            assert!(store.list_documents("drafts").unwrap().is_empty());
            assert!(store.list_documents("papers").unwrap().is_empty());
        }
        server.join().unwrap();
    }
    #[test]
    fn current_llm_http_scoped_plan_sends_compact_canonical_catalogue_without_losing_constraints() {
        let (dir,mut store,_)=simulated_flow_store();
        let mut config=store.bank.config().unwrap();
        config["chapters"].as_array_mut().unwrap().extend([
            json!({"id":"rja-compulsory-1:1.1","label":"模拟同一小节的canonical别名"}),
            json!({"id":"simulated-task-section","label":"模拟入选任务的另一真实目录项"}),
            json!({"id":"simulated-preferred-section","label":"模拟偏好目标真实目录项"}),
        ]);
        config["tasks"]=json!([
            {"id":"simulated-no-supply","label":"模拟暂无供给任务","questionType":"single_choice","sectionIds":["rja-compulsory-1:1.1"],"partIds":[],"audit":"simulated-task-audit-must-not-send"},
            {"id":"simulated-second-main","label":"模拟第二主考范围任务","questionType":"single_choice","sectionIds":["1.2"],"partIds":[]},
            {"id":"simulated-shared-task","label":"模拟跨目录任务","questionType":"single_choice","sectionIds":["1.1","simulated-task-section"],"partIds":[]},
            {"id":"simulated-learned-only","label":"模拟仅已学任务","questionType":"single_choice","sectionIds":["1.3"],"partIds":[]},
            {"id":"simulated-goal-only","label":"模拟仅目标范围任务","questionType":"single_choice","sectionIds":["rja-compulsory-1:2.3"],"partIds":[]},
            {"id":"simulated-zero-type","label":"模拟未请求题型任务","questionType":"fill_blank","sectionIds":["1.1"],"partIds":[]}
        ]);
        assert!(!list(&config["assemblyIndex"]["entries"]).iter().any(|entry|strings(&entry["tasks"]).contains(&"simulated-no-supply".to_owned())));
        write_simulated_config(&store,&config);
        let required=simulated_goal("required","answer","rja-compulsory-1:2.3");
        let mut preferred=simulated_goal("preferred","written_reasoning","simulated-preferred-section");preferred["id"]=json!("simulated-preferred-goal");
        let input=json!({"mode":"llm","requirements":{"mainScope":["rja-compulsory-1:1.1","1.2"],"learnedScope":["1.3"],"premises":["vieta"],"automaticFoundation":false,"teachingGoals":[required,preferred],"goal":"模拟保留完整教师教学目标及条件。","scoringMode":"none","counts":{"single_choice":2,"multiple_choice":0,"fill_blank":0,"free_response":0},"students":[{"name":"simulated-private-student"}]}});
        let expected=intake::model_context(&intake::normalize(&store,&input["requirements"]).unwrap());
        let sent_requirements=expected.clone();
        let (model,server)=llm_fixture(dir.path(),1,move|_,context|{
            assert_eq!(context["requirements"],sent_requirements);
            assert_eq!(context["requirements"]["premises"],json!(["vieta"]));
            assert_eq!(context["requirements"]["learnedScope"],json!(["1.3"]));
            assert_eq!(context["requirements"]["teachingGoals"].as_array().unwrap().len(),2);
            assert_eq!(list(&context["tasks"]).iter().map(|task|s(task,"id").to_owned()).collect::<Vec<_>>(),vec!["simulated-no-supply","simulated-second-main","simulated-shared-task"]);
            assert!(!context.to_string().contains("simulated-task-audit-must-not-send"));
            let actual:HashSet<_>=list(&context["chapters"]).iter().map(|chapter|intake::canonical(s(chapter,"id"))).collect();
            let expected:HashSet<_>=["rja-compulsory-1:1.1","rja-compulsory-1:1.2","rja-compulsory-1:1.3","rja-compulsory-1:2.3","simulated-task-section","simulated-preferred-section"].into_iter().map(str::to_owned).collect();
            assert_eq!(actual,expected);
            assert_eq!(context["chapters"].as_array().unwrap().len(),6);
            json!({"slots":[{"taskId":"simulated-no-supply","goalIds":["simulated-goal"],"points":0,"partPoints":[]}]})
        });
        let (result,events)=observe_selection(||dispatch(&mut store,"blueprint_plan",&input,&model,&AtomicBool::new(false)));
        let result=result.unwrap().unwrap();
        assert_eq!(events,simulated_plan_events());
        assert_eq!(result["workflowSteps"],json!(["plan_supply","plan_slots","plan_check"]));
        let blueprint=&result["blueprint"];
        assert_eq!(blueprint["generation"]["taskCatalogScope"],"confirmed_main_scope_v1");
        assert_eq!(blueprint["quantityReview"]["matches"],false);
        assert_eq!(blueprint["quantityReview"]["expectedTotal"],2);
        assert_eq!(blueprint["quantityReview"]["actualTotal"],1);
        assert_eq!(intake::model_context(&blueprint["requirements"]),expected);
        assert!(check_blueprint(&store,blueprint).unwrap_err().message.contains("题量不一致"));
        let mut corrected=blueprint.clone();
        corrected["slots"].as_array_mut().unwrap().push(intake::merge(&blueprint["slots"][0],&json!({"slotId":"slot-2","number":2})));
        let checked=check_blueprint(&store,&corrected).unwrap();
        assert_eq!(checked["generation"]["taskCatalogScope"],"confirmed_main_scope_v1");
        assert!(store.list_documents("drafts").unwrap().is_empty());
        assert!(store.list_documents("papers").unwrap().is_empty());
        server.join().unwrap();
    }
    #[test]
    fn current_llm_http_scoped_plan_rejects_unsent_tasks_and_guards_new_plans_without_rewriting_history() {
        let (dir,mut store,unconfigured)=simulated_flow_store();
        let input=json!({"mode":"llm","requirements":{"mainScope":["rja-compulsory-1:1.1"],"learnedScope":["1.2"],"scoringMode":"none","counts":{"single_choice":1,"multiple_choice":0,"fill_blank":0,"free_response":0}}});
        let (model,server)=llm_fixture(dir.path(),4,|attempt,context|{
            assert!(list(&context["tasks"]).iter().all(|task|intake::overlaps(&task["sectionIds"],&json!(["1.1"])) && task["questionType"]=="single_choice"));
            let task_id=match attempt {0=>"proper_subset",1=>"simulated-unknown-task",_=>"element_parameter_distinct"};
            if attempt==2 {return json!({"slots":[]});}
            json!({"slots":[{"taskId":task_id,"points":0,"partPoints":[]}]})
        });
        for attempt in 0..4 {
            let result=plan(&store,&input,&model,&AtomicBool::new(false));
            if attempt==2 {let blueprint=result.unwrap();assert_eq!(blueprint["slots"],json!([]));assert_eq!(blueprint["quantityReview"]["matches"],false);assert!(check_blueprint(&store,&blueprint).is_err());}
            else {let error=result.unwrap_err();assert_eq!(error.code,"invalid_plan");if attempt==0 || attempt==3 {assert!(error.message.contains("本次已确认范围与题型"));}}
            assert!(store.list_documents("drafts").unwrap().is_empty());
            assert!(store.list_documents("papers").unwrap().is_empty());
        }
        server.join().unwrap();
        let requirements=intake::normalize(&store,&input["requirements"]).unwrap();
        let config=store.bank.config().unwrap();
        let slots=model_blueprint_slots(&json!({"slots":[{"taskId":"proper_subset"}]}),&config).unwrap();
        let mut blueprint=json!({"requirements":requirements,"slots":slots,"generation":{"mode":"llm","provenance":"llm_planning_v1","taskCatalogScope":"confirmed_main_scope_v1"}});
        assert!(check_blueprint(&store,&blueprint).unwrap_err().message.contains("超出教师指定范围"));
        assert!(create_draft(&mut store,&json!({"mode":"llm","blueprint":blueprint}),&unconfigured,&AtomicBool::new(false)).unwrap_err().message.contains("超出教师指定范围"));
        // The pre-existing provenance alone must keep historical compatibility.
        blueprint["generation"].as_object_mut().unwrap().remove("taskCatalogScope");
        let historical=check_blueprint(&store,&blueprint).unwrap();
        assert_eq!(historical["slots"][0]["taskId"],"proper_subset");
        let mut no_task=config.clone();no_task["tasks"]=json!([]);write_simulated_config(&store,&no_task);
        let mut empty_input=input.clone();empty_input["requirements"]["scoringMode"]=json!("points");empty_input["requirements"]["targetScore"]=json!(100);empty_input["requirements"]["teachingGoals"]=json!([simulated_goal("required","answer","1.1")]);
        assert!(!unconfigured.configured());
        let (result,events)=observe_selection(||dispatch(&mut store,"blueprint_plan",&empty_input,&unconfigured,&AtomicBool::new(false)));
        let result=result.unwrap().unwrap();let blueprint=&result["blueprint"];
        assert_eq!(result["workflowSteps"],json!(["plan_supply","plan_check"]));
        assert_eq!(events,vec![("plan_supply".to_owned(),"running".to_owned()),("plan_supply".to_owned(),"completed".to_owned()),("plan_check".to_owned(),"running".to_owned()),("plan_check".to_owned(),"completed".to_owned())]);
        assert_eq!(blueprint["slots"],json!([]));
        assert_eq!(blueprint["generation"]["mode"],"not_run");
        assert_eq!(blueprint["generation"]["provenance"],"task_catalog_incomplete");
        assert_eq!(blueprint["taskCatalogGaps"][0]["questionType"],"single_choice");
        assert_eq!(blueprint["requirements"]["counts"],input["requirements"]["counts"]);
        assert_eq!(blueprint["requirements"]["targetScore"],100);
        assert_eq!(blueprint["requirements"]["teachingGoals"].as_array().unwrap().len(),1);
        assert!(check_blueprint(&store,blueprint).is_err());
        let empty=create_draft(&mut store,&json!({"mode":"llm","blueprint":blueprint}),&unconfigured,&AtomicBool::new(false)).unwrap();
        assert_eq!(empty["draft"]["slots"],json!([]));
        assert_eq!(empty["draft"]["stats"]["unplannedCount"],1);
        assert_eq!(store.list_documents("drafts").unwrap().len(),1);
    }
    #[test]
    fn current_llm_http_partial_catalogue_and_zero_slots_are_reviewable_without_changing_requested_types() {
        let (dir,mut store,_)=simulated_flow_store();
        let mut config=store.bank.config().unwrap();
        config["tasks"]=json!(list(&config["tasks"]).into_iter().filter(|task|s(task,"questionType")!="multiple_choice").collect::<Vec<_>>());
        config["tasks"].as_array_mut().unwrap().push(json!({"id":"simulated-multiple-outside-scope","label":"模拟范围外多选任务","questionType":"multiple_choice","sectionIds":["1.2"],"partIds":[]}));
        write_simulated_config(&store,&config);
        let input=json!({"mode":"llm","requirements":{"mainScope":["1.1"],"learnedScope":["1.1","1.2"],"scoringMode":"none","counts":{"single_choice":1,"multiple_choice":1,"fill_blank":0,"free_response":0}}});
        let requirements=intake::normalize(&store,&input["requirements"]).unwrap();
        let (model,server)=llm_fixture(dir.path(),2,|attempt,context|{
            assert_eq!(context["requirements"]["counts"],json!({"single_choice":1,"multiple_choice":1,"fill_blank":0,"free_response":0}));
            assert!(!list(&context["tasks"]).is_empty());
            assert!(list(&context["tasks"]).iter().all(|task|task["questionType"]=="single_choice"));
            let gaps=&context["taskCatalogGaps"];
            assert_eq!(gaps.as_array().unwrap().len(),1);
            assert_eq!(gaps[0]["questionType"],"multiple_choice");assert_eq!(gaps[0]["requestedCount"],1);
            assert_eq!(gaps[0]["reason"],"confirmed_scope_task_not_registered");
            assert!(s(&gaps[0],"message").contains("不代表题库无题"));
            assert!(gaps[0].get("readyCount").is_none());
            if attempt==1 {json!({"slots":[]})} else {json!({"slots":[{"taskId":context["tasks"][0]["id"],"points":0,"partPoints":[]}]})}
        });
        for attempt in 0..2 {
            let (result,events)=observe_selection(||dispatch(&mut store,"blueprint_plan",&input,&model,&AtomicBool::new(false)));
            let result=result.unwrap().unwrap();let blueprint=&result["blueprint"];
            assert_eq!(events,simulated_plan_events());
            assert_eq!(result["workflowSteps"],json!(["plan_supply","plan_slots","plan_check"]));
            assert_eq!(blueprint["requirements"],requirements);
            assert_eq!(blueprint["taskCatalogGaps"][0]["questionType"],"multiple_choice");
            assert_eq!(blueprint["quantityReview"]["expectedCounts"],requirements["counts"]);
            assert_eq!(blueprint["quantityReview"]["actualCounts"]["multiple_choice"],0);
            assert_eq!(blueprint["quantityReview"]["actualTotal"],if attempt==0{1}else{0});
            assert_eq!(blueprint["generation"]["provenance"],"llm_planning_v1");
            assert!(check_blueprint(&store,blueprint).unwrap_err().message.contains("题量不一致"));
            assert!(store.list_documents("drafts").unwrap().is_empty());
            assert!(store.list_documents("papers").unwrap().is_empty());
        }
        server.join().unwrap();
    }
    #[test]
    fn current_llm_http_required_goal_and_total_score_can_be_reviewed_but_per_slot_structure_stays_strict() {
        let (dir,mut store,_)=simulated_flow_store();
        let input=json!({"mode":"llm","requirements":{"mainScope":["1.1"],"learnedScope":["1.1"],"scoringMode":"points","targetScore":100,"counts":{"single_choice":1,"multiple_choice":0,"fill_blank":0,"free_response":0},"teachingGoals":[simulated_goal("required","answer","1.1")]}});
        let (model,server)=llm_fixture(dir.path(),4,|attempt,context|{
            let mut slot=json!({"taskId":context["tasks"][0]["id"],"points":20,"partPoints":[],"goalIds":[]});
            match attempt {1=>slot["points"]=json!("invalid-points"),2=>slot["goalIds"]=json!(["simulated-unknown-goal"]),3=>slot["partPoints"]=json!([{"partId":"simulated-part","points":20}]),_=>{}}
            json!({"slots":[slot]})
        });
        for attempt in 0..4 {
            let result=plan(&store,&input,&model,&AtomicBool::new(false));
            if attempt==0 {
                let mut blueprint=result.unwrap();
                assert_eq!(blueprint["quantityReview"]["matches"],true);
                assert_eq!(blueprint["plannedStats"]["points"],20);
                assert_eq!(blueprint["requirements"]["targetScore"],100);
                assert_eq!(blueprint["taskCatalogGaps"],json!([]));
                assert!(check_blueprint(&store,&blueprint).unwrap_err().message.contains("必须教学目标"));
                blueprint["slots"][0]["goalIds"]=json!(["simulated-goal"]);
                assert!(check_blueprint(&store,&blueprint).unwrap_err().message.contains("分值合计"));
                blueprint["slots"][0]["points"]=json!(100);
                assert_eq!(check_blueprint(&store,&blueprint).unwrap()["plannedStats"]["points"],100);
            } else {assert_eq!(result.unwrap_err().code,"invalid_plan");}
            assert!(store.list_documents("drafts").unwrap().is_empty());
            assert!(store.list_documents("papers").unwrap().is_empty());
        }
        server.join().unwrap();
    }
    #[test]
    fn current_llm_http_partial_draft_preserves_shortage_confirms_actual_questions_and_rejects_version_race() {
        let (dir,mut store,_)=simulated_flow_store();
        let requirements=intake::normalize(&store,&json!({"mainScope":["1.1"],"learnedScope":["1.1"],"scoringMode":"points","targetScore":100,"counts":{"single_choice":2,"multiple_choice":0,"fill_blank":0,"free_response":0},"teachingGoals":[simulated_goal("required","answer","1.1")]})).unwrap();
        let blueprint=json!({"requirements":requirements,"slots":[{"slotId":"slot-1","number":1,"taskId":"set_determinacy","questionType":"single_choice","points":20,"partPoints":[],"goalIds":[]}],"generation":{"mode":"llm","provenance":"llm_planning_v1","taskCatalogScope":"confirmed_main_scope_v1"}});
        assert!(check_blueprint(&store,&blueprint).is_err());
        let bank_path=dir.path().join("question-bank.sqlite");
        let (model,server)=llm_fixture(dir.path(),4,move|attempt,context|{
            assert_eq!(context["slots"].as_array().unwrap().len(),1);
            assert_eq!(context["requirements"]["counts"]["single_choice"],2);
            assert_eq!(context["requirements"]["targetScore"],100);
            assert_eq!(context["requirements"]["teachingGoals"].as_array().unwrap().len(),1);
            let candidate=llm_candidate(context,0,if attempt==1 || attempt==2{"uncertain"}else{"suitable"});
            if attempt==3 {
                let db=rusqlite::Connection::open(&bank_path).unwrap();
                let qid=s(&candidate,"questionId");
                let raw:String=db.query_row("SELECT payload FROM bank_questions WHERE id=?1",[qid],|row|row.get(0)).unwrap();
                let mut changed:Value=serde_json::from_str(&raw).unwrap();
                changed["teacher"]["simulatedVersionNote"]=json!("模拟模型响应前另一窗口更新参考内容。");
                let teacher_hash=hash(&changed["teacher"]);let version=format!("teacher-{}",&teacher_hash[..16]);
                changed["teacherSha256"]=json!(teacher_hash);changed["teacherVersion"]=json!(version);changed["verification"]["teacherVersion"]=json!(version);
                crate::bank::verify_question(&changed).unwrap();
                db.execute("UPDATE bank_questions SET payload=?2 WHERE id=?1",rusqlite::params![qid,changed.to_string()]).unwrap();
            }
            json!({"rankings":[{"slotId":"slot-1","candidates":[candidate],"missingReason":"模拟模型未确认适配，保留已有题位。"}]})
        });
        let input=json!({"mode":"llm","blueprint":blueprint});let cancel=AtomicBool::new(false);
        let created=create_draft(&mut store,&input,&model,&cancel).unwrap();let draft=&created["draft"];
        assert_eq!(draft["baseline"]["requirements"],requirements);
        assert_eq!(draft["slots"].as_array().unwrap().len(),1);
        assert_eq!(draft["stats"]["requestedCount"],2);assert_eq!(draft["stats"]["plannedCount"],1);assert_eq!(draft["stats"]["selectedCount"],1);
        assert_eq!(draft["stats"]["unplannedCount"],1);assert_eq!(draft["stats"]["missingCount"],1);assert_eq!(draft["stats"]["missingQuestions"],1);
        assert_eq!(draft["planningShortage"],json!({"requestedCounts":requirements["counts"],"plannedCounts":{"single_choice":1,"multiple_choice":0,"fill_blank":0,"free_response":0},"missingCounts":{"single_choice":1,"multiple_choice":0,"fill_blank":0,"free_response":0},"requestedTotal":2,"plannedTotal":1,"missingTotal":1,"reason":"requested_questions_not_planned"}));
        for code in ["planning_shortage","missing_required_goal","planned_score_differs"] {assert!(list(&draft["differences"]).iter().any(|issue|issue["code"]==code));}
        let confirmation=json!({"draftId":draft["draftId"],"expectedRevision":0,"operationId":"simulated-partial-confirm","acknowledgeDifferences":true});
        let mut unacknowledged=confirmation.clone();unacknowledged["acknowledgeDifferences"]=json!(false);
        assert_eq!(confirm(&mut store,&unacknowledged).unwrap_err().code,"confirmation_required");
        let paper=confirm(&mut store,&confirmation).unwrap()["paper"].clone();
        verify_frozen_paper(&paper).unwrap();
        assert_eq!(paper["draft"]["slots"].as_array().unwrap().len(),1);
        assert_eq!(list(&paper["draft"]["slots"]).iter().filter(|slot|slot["question"].is_object()).count(),1);
        assert_eq!(paper["draft"]["baseline"]["requirements"],requirements);
        let replay=confirm(&mut store,&confirmation).unwrap();assert_eq!(replay["replayed"],true);assert_eq!(replay["paper"],paper);
        assert_eq!(confirm(&mut store,&unacknowledged).unwrap_err().code,"operation_conflict");
        let empty=create_draft(&mut store,&input,&model,&cancel).unwrap()["draft"].clone();
        assert_eq!(empty["stats"]["selectedCount"],0);assert_eq!(empty["stats"]["plannedCount"],1);assert_eq!(empty["stats"]["unplannedCount"],1);assert_eq!(empty["stats"]["missingCount"],2);
        assert!(empty["slots"][0]["question"].is_null());
        let before=store.list_documents("drafts").unwrap();
        assert_eq!(create_draft(&mut store,&input,&model,&cancel).unwrap_err().code,"version_conflict");
        assert_eq!(store.list_documents("drafts").unwrap(),before);
        assert_eq!(create_draft(&mut store,&input,&model,&AtomicBool::new(true)).unwrap_err().code,"cancelled");
        let mut extra=input.clone();
        extra["blueprint"]["slots"]=json!((0..3).map(|index|intake::merge(&blueprint["slots"][0],&json!({"slotId":format!("slot-{}",index+1),"number":index+1}))).collect::<Vec<_>>());
        assert!(create_draft(&mut store,&extra,&model,&cancel).unwrap_err().message.contains("超过已确认需求"));
        let mut wrong_type=input.clone();wrong_type["blueprint"]["slots"][0]["taskId"]=json!("element_parameter_distinct");wrong_type["blueprint"]["slots"][0]["questionType"]=json!("fill_blank");
        assert!(create_draft(&mut store,&wrong_type,&model,&cancel).unwrap_err().message.contains("超过已确认需求"));
        let mut malformed=input.clone();malformed["blueprint"]["slots"][0]["points"]=json!(-1);
        assert_eq!(create_draft(&mut store,&malformed,&model,&cancel).unwrap_err().code,"invalid_plan");
        assert_eq!(store.list_documents("drafts").unwrap(),before);
        server.join().unwrap();
        assert_eq!(dispatch(&mut store,"paper_get",&json!({"paperId":paper["paperId"]}),&model,&cancel).unwrap().unwrap()["paper"],paper);
    }
    #[test]
    fn simulated_zero_slot_draft_skips_model_and_recomputes_shortage_after_explicit_edits() {
        let (_dir,mut store,model)=simulated_flow_store();assert!(!model.configured());
        let requirements=intake::normalize(&store,&json!({"mainScope":["1.1"],"learnedScope":["1.1"],"scoringMode":"points","targetScore":100,"counts":{"single_choice":2,"multiple_choice":0,"fill_blank":0,"free_response":0},"teachingGoals":[simulated_goal("required","answer","1.1")]})).unwrap();
        let input=json!({"mode":"llm","blueprint":{"requirements":requirements,"slots":[],"generation":{"mode":"not_run","provenance":"task_catalog_incomplete","taskCatalogScope":"confirmed_main_scope_v1"}}});
        let (created,events)=observe_selection(||create_draft(&mut store,&input,&model,&AtomicBool::new(false)));
        let created=created.unwrap();let draft=&created["draft"];
        assert_eq!(created["workflowSteps"],json!(["select_pool","select_save"]));
        let expected=vec![("select_pool".to_owned(),"running".to_owned()),("select_pool".to_owned(),"completed".to_owned()),("select_save".to_owned(),"running".to_owned()),("select_save".to_owned(),"completed".to_owned())];
        assert_eq!(events,expected);
        assert_eq!(draft["slots"],json!([]));assert_eq!(draft["stats"]["requestedCount"],2);assert_eq!(draft["stats"]["unplannedCount"],2);assert_eq!(draft["stats"]["missingCount"],2);
        assert_eq!(draft["selectionGeneration"]["mode"],"not_run");assert_eq!(draft["selectionGeneration"]["provenance"],"empty_blueprint_no_selection");
        assert!(!is_manual(draft));
        assert_eq!(draft["baseline"]["requirements"],requirements);
        let add=json!({"draftId":draft["draftId"],"operation":{"type":"add","taskId":"set_determinacy","points":0,"partPoints":[],"expectedRevision":0,"operationId":"simulated-partial-add"}});
        let added=edit(&mut store,&add,&model,&AtomicBool::new(false)).unwrap()["draft"].clone();
        assert_eq!(added["planningShortage"]["plannedTotal"],1);assert_eq!(added["planningShortage"]["missingTotal"],1);assert_eq!(added["stats"]["missingCount"],2);
        let remove=json!({"draftId":draft["draftId"],"operation":{"type":"delete","slotId":added["slots"][0]["slotId"],"expectedRevision":1,"operationId":"simulated-partial-remove"}});
        let removed=edit(&mut store,&remove,&model,&AtomicBool::new(false)).unwrap()["draft"].clone();
        assert_eq!(removed["planningShortage"]["missingTotal"],2);assert_eq!(removed["stats"]["plannedCount"],0);assert_eq!(removed["stats"]["missingCount"],2);
        let replay=edit(&mut store,&remove,&model,&AtomicBool::new(false)).unwrap();assert_eq!(replay["replayed"],true);assert_eq!(replay["draft"],removed);
        let paper=confirm(&mut store,&json!({"draftId":draft["draftId"],"expectedRevision":2,"operationId":"simulated-empty-confirm","acknowledgeDifferences":true})).unwrap()["paper"].clone();
        verify_frozen_paper(&paper).unwrap();assert_eq!(paper["draft"]["slots"],json!([]));assert_eq!(paper["draft"]["stats"]["actualCount"],0);
        let before=store.list_documents("drafts").unwrap();
        let cancel=std::sync::Arc::new(AtomicBool::new(false));let stop=cancel.clone();
        let cancelled=crate::workflow_progress::observe(move|step,status|{if step=="select_save" && status=="running"{stop.store(true,Ordering::Relaxed);}},||create_draft(&mut store,&input,&model,&cancel));
        assert_eq!(cancelled.unwrap_err().code,"cancelled");assert_eq!(store.list_documents("drafts").unwrap(),before);
    }
    #[test]
    fn current_llm_http_candidate_windows_bound_payload_and_expand_global_matching_conflicts() {
        let (dir,store,_)=simulated_flow_store();let (pool,config,requirements,slots)=simulated_window_pool(&store,292,6);
        let seen=std::sync::Arc::new(std::sync::Mutex::new(Vec::<HashSet<String>>::new()));let requests=seen.clone();
        let (model,server)=llm_fixture(dir.path(),2,move|attempt,context|{
            assert_eq!(context["batch"]["round"],attempt+1);
            let questions=list(&context["questions"]);assert!(questions.len()<=if attempt==0{72}else{120});
            assert!(list(&context["slots"]).iter().all(|slot|list(&slot["candidateQuestionIds"]).len()<=if attempt==0{12}else{20}));
            assert!(!context.to_string().contains("SIMULATED_FULL_PATH_BASIS_MUST_NOT_SEND"));
            assert!(!context.to_string().contains("window-unrelated"));
            assert!(list(&context["catalogue"]["knowledge"]).iter().any(|p|p["uid"]=="window-parent"));
            assert!(list(&context["catalogue"]["premises"]).iter().any(|p|p["id"]=="vieta"));
            assert!(questions.iter().all(|q|q["student"]["stem"].is_string() && q["teacher"]["answers"].is_array() && q["teacher"]["solutions"].is_array()));
            let ids=questions.iter().map(|q|s(q,"questionId").to_owned()).collect::<HashSet<_>>();let mut old=requests.lock().unwrap();if attempt==1{assert!(old[0].is_disjoint(&ids));assert_eq!(context["slots"].as_array().unwrap().len(),5);}old.push(ids);
            json!({"rankings":list(&context["slots"]).iter().enumerate().map(|(i,slot)|json!({"slotId":slot["slotId"],"candidates":[llm_slot_candidate(context,i,0,"suitable")],"missingReason":""})).collect::<Vec<_>>()})
        });
        let rows=crate::assembly_llm::evaluate(&pool,&slots,&requirements,&config,&[],&model,&AtomicBool::new(false)).unwrap();
        let matches=assignment(&rows.iter().map(|row|list(&row["candidates"]).iter().map(|c|(s(c,"questionId").to_owned(),s(c,"duplicateGroup").to_owned())).collect()).collect::<Vec<_>>());
        assert_eq!(matches.len(),6);assert_eq!(rows.len(),6);
        assert_eq!(rows.iter().filter(|row|row["search"]["presentedCount"]==32).count(),5);
        assert!(rows.iter().all(|row|row["search"]["poolCount"]==292 && row["search"]["assessedCount"].as_u64().unwrap()<=2 && row["search"]["searchIncomplete"]==true && row["search"]["continuation"].is_string()));
        server.join().unwrap();assert_eq!(seen.lock().unwrap().len(),2);
    }
    #[test]
    fn current_llm_http_continuation_reaches_unlabelled_questions_and_rejects_stale_or_forged_cursor() {
        let (dir,store,_)=simulated_flow_store();let (pool,config,requirements,slots)=simulated_window_pool(&store,40,1);
        let (model,server)=llm_fixture(dir.path(),3,|attempt,context|{
            if attempt<2 {json!({"rankings":[{"slotId":"window-slot-0","candidates":[llm_slot_candidate(context,0,0,"uncertain")],"missingReason":"模拟比较保留未知。"}]})}
            else {
                assert_eq!(context["questions"].as_array().unwrap().len(),8);
                assert!(list(&context["questions"]).iter().any(|q|q["questionId"]=="window-q-039" && q["metadataHints"].is_null()));
                let index=context["questions"].as_array().unwrap().iter().position(|q|q["questionId"]=="window-q-039").unwrap();
                json!({"rankings":[{"slotId":"window-slot-0","candidates":[llm_candidate(context,index,"suitable")],"missingReason":""}]})
            }
        });
        let cancel=AtomicBool::new(false);
        let first=crate::assembly_llm::evaluate(&pool,&slots,&requirements,&config,&[],&model,&cancel).unwrap().remove(0);
        assert_eq!(first["search"]["presentedCount"],32);assert_eq!(first["search"]["assessedCount"],2);assert_eq!(first["assessments"].as_array().unwrap().len(),2);
        assert!(s(&first,"missingReason").contains("尚有 8 道未比较"));
        let cursor=&first["search"]["continuation"];
        let mut changed_slot=slots[0].clone();changed_slot["taskLabel"]=json!("模拟条件已改变");
        assert!(crate::assembly_llm::continue_evaluate(&pool,&changed_slot,&requirements,&config,&[],&model,&cancel,&first,cursor).is_err());
        let mut changed_pool=pool.clone();changed_pool[39]["teacherVersion"]=json!("simulated-new-version");
        assert!(crate::assembly_llm::continue_evaluate(&changed_pool,&slots[0],&requirements,&config,&[],&model,&cancel,&first,cursor).is_err());
        assert!(crate::assembly_llm::continue_evaluate(&pool,&slots[0],&requirements,&config,&[],&model,&cancel,&first,&json!("forged-cursor")).is_err());
        let next=crate::assembly_llm::continue_evaluate(&pool,&slots[0],&requirements,&config,&[],&model,&cancel,&first,cursor).unwrap().remove(0);
        assert_eq!(next["candidates"][0]["questionId"],"window-q-039");assert_eq!(next["search"]["presentedCount"],40);assert_eq!(next["search"]["assessedCount"],3);
        assert!(next["search"]["continuation"].is_null());assert_eq!(next["search"]["searchIncomplete"],true);
        assert_eq!(next["assessments"].as_array().unwrap().len(),3);server.join().unwrap();
    }
    #[test]
    fn current_llm_http_window_fallback_failure_and_cancel_do_not_commit_candidate_cache() {
        let (dir,mut store,old_model)=simulated_flow_store();
        let blueprint=legacy_plan(&store,&json!({"mode":"rule","requirements":{"mainScope":["1.1"],"learnedScope":["1.1"],"scoringMode":"none","counts":{"single_choice":1,"multiple_choice":0,"fill_blank":0,"free_response":0}}}),&old_model,&AtomicBool::new(false)).unwrap();
        let draft=legacy_create_draft(&mut store,&json!({"mode":"rule","blueprint":blueprint}),&old_model,&AtomicBool::new(false)).unwrap()["draft"].clone();
        let prior=std::sync::Arc::new(std::sync::Mutex::new(Value::Null));let first_candidate=prior.clone();
        let cancel=std::sync::Arc::new(AtomicBool::new(false));let stop=cancel.clone();
        let (model,server)=llm_fixture(dir.path(),4,move|attempt,context|{
            let candidate=if attempt%2==0{let c=llm_slot_candidate(context,0,0,"uncertain");*first_candidate.lock().unwrap()=c.clone();c}else if attempt==1{let mut c=first_candidate.lock().unwrap().clone();c["status"]=json!("suitable");c}else{stop.store(true,Ordering::Relaxed);llm_slot_candidate(context,0,0,"uncertain")};
            json!({"rankings":[{"slotId":"slot-1","candidates":[candidate],"missingReason":"模拟需要继续比较。"}]})
        });
        let query=json!({"draftId":draft["draftId"],"slotId":"slot-1","expectedRevision":0});
        let error=dispatch(&mut store,"draft_candidates",&query,&model,&cancel).unwrap_err();assert!(error.message.contains("未发送给本题位"));
        assert_eq!(store.document("drafts",s(&draft,"draftId")).unwrap(),draft);
        assert_eq!(dispatch(&mut store,"draft_candidates",&query,&model,&cancel).unwrap_err().code,"cancelled");
        assert_eq!(store.document("drafts",s(&draft,"draftId")).unwrap(),draft);server.join().unwrap();
    }
    #[test]
    fn current_llm_http_candidate_continuation_commits_cumulative_cache_and_direct_selection_has_no_call() {
        let (dir,mut store,old_model)=simulated_flow_store();
        let blueprint=legacy_plan(&store,&json!({"mode":"rule","requirements":{"mainScope":["1.1"],"learnedScope":["1.1"],"scoringMode":"none","counts":{"single_choice":1,"multiple_choice":0,"fill_blank":0,"free_response":0}}}),&old_model,&AtomicBool::new(false)).unwrap();
        let draft=legacy_create_draft(&mut store,&json!({"mode":"rule","blueprint":blueprint}),&old_model,&AtomicBool::new(false)).unwrap()["draft"].clone();
        let seen=std::sync::Arc::new(std::sync::Mutex::new(HashSet::<String>::new()));let presented=seen.clone();
        let (model,server)=llm_fixture(dir.path(),2,move|_,context|{
            let ids=strings(&context["slots"][0]["candidateQuestionIds"]);let mut prior=presented.lock().unwrap();assert!(ids.iter().all(|id|!prior.contains(id)));prior.extend(ids);
            json!({"rankings":[{"slotId":"slot-1","candidates":[llm_slot_candidate(context,0,0,"suitable")],"missingReason":""}]})
        });
        let cancel=AtomicBool::new(false);let query=json!({"draftId":draft["draftId"],"slotId":"slot-1","expectedRevision":0});
        let first=dispatch(&mut store,"draft_candidates",&query,&model,&cancel).unwrap().unwrap();assert_eq!(first["search"]["presentedCount"],12);
        let old_cursor=first["continuation"].clone();
        let second=dispatch(&mut store,"draft_candidates",&json!({"draftId":draft["draftId"],"slotId":"slot-1","expectedRevision":1,"continuation":old_cursor}),&model,&cancel).unwrap().unwrap();
        assert_eq!(second["search"]["presentedCount"],24);assert_eq!(second["search"]["assessedCount"],2);assert_eq!(second["candidates"].as_array().unwrap().len(),2);
        let chosen=&second["candidates"][1];
        let replaced=edit(&mut store,&json!({"draftId":draft["draftId"],"operation":{"type":"replace","mode":"direct","slotIds":["slot-1"],"candidateId":chosen["questionId"],"contentVersion":chosen["contentVersion"],"teacherVersion":chosen["teacherVersion"],"expectedRevision":2,"operationId":"simulated-window-direct"}}),&model,&cancel).unwrap()["draft"].clone();
        assert_eq!(replaced["slots"][0]["question"]["questionId"],chosen["questionId"]);assert_eq!(replaced["revision"],3);
        assert!(dispatch(&mut store,"draft_candidates",&json!({"draftId":draft["draftId"],"slotId":"slot-1","expectedRevision":3,"continuation":old_cursor}),&model,&cancel).is_err());
        assert_eq!(store.document("drafts",s(&draft,"draftId")).unwrap(),replaced);
        server.join().unwrap();assert_eq!(seen.lock().unwrap().len(),24);
    }
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
    fn legacy_simulated_blueprint_context_keeps_all_legal_tasks_without_import_metadata() {
        let requirements = json!({"mainScope":["1.1"],"counts":{"single_choice":1,"multiple_choice":0,"fill_blank":0,"free_response":0},"teachingGoals":[{"id":"required-goal","priority":"required","observable":"模拟必须目标","knowledgeScope":["1.1"]}],"student":{"name":"不得发送"}});
        let config = json!({"tasks":[
            {"id":"reference-task","label":"模拟参考任务","questionType":"single_choice","sectionIds":["1.1"],"partIds":[],"review":{"summary":"私有审核说明"},"sourceRefs":["私有来源"]},
            {"id":"no-supply-task","label":"模拟暂无供给的合法任务","questionType":"single_choice","sectionIds":["1.1"],"partWeights":[1],"importId":"私有导入身份","reviewedBy":"私有审核者"},
            {"id":"outside-scope","label":"模拟范围外任务","questionType":"single_choice","sectionIds":["1.2"]},
            {"id":"unused-type","label":"模拟零题量题型任务","questionType":"free_response","sectionIds":["1.1"]}
        ]});
        let slots = vec![
            json!({"slotId":"slot-1","number":1,"taskId":"reference-task","taskLabel":"模拟参考任务","questionType":"single_choice","goalIds":["required-goal"],"points":0,"partPoints":[]}),
        ];
        let context = legacy_blueprint_model_context(&[], &slots, &requirements, &config);
        assert_eq!(
            context["tasks"],
            json!([
                {"id":"reference-task","label":"模拟参考任务","questionType":"single_choice","sectionIds":["1.1"]},
                {"id":"no-supply-task","label":"模拟暂无供给的合法任务","questionType":"single_choice","sectionIds":["1.1"]}
            ])
        );
        assert_eq!(
            context["slots"],
            json!([{"taskId":"reference-task","goalIds":["required-goal"]}])
        );
        assert_eq!(
            context["supply"],
            json!({"referenceSlotSupply":[{"eligibleCount":0,"unknownCount":0,"relatedCount":0}]})
        );
        assert_eq!(
            context["requirements"],
            intake::model_context(&requirements)
        );
        assert_eq!(
            context["requirements"]["teachingGoals"],
            requirements["teachingGoals"]
        );
        assert!(context.to_string().chars().count() < json!({"requirements":requirements,"tasks":config["tasks"],"slots":slots,"supply":legacy_supply(&[], &slots, &requirements, &config)}).to_string().chars().count());
    }
    #[test]
    fn legacy_simulated_compact_model_slots_backfill_types_and_preserve_blueprint_checks() {
        let (_dir, store, model) = simulated_store();
        let mut blueprint = legacy_plan(
            &store,
            &json!({"requirements":{"mainScope":["1.1"],"learnedScope":["1.1"],"scoringMode":"none","counts":{"single_choice":1,"multiple_choice":0,"fill_blank":0,"free_response":0}},"mode":"rule"}),
            &model,
            &AtomicBool::new(false),
        ).unwrap();
        blueprint["requirements"]["teachingGoals"] =
            json!([simulated_goal("required", "answer", "1.1")]);
        let config = store.bank.config().unwrap();
        let generated = json!({"slots":[{"taskId":blueprint["slots"][0]["taskId"],"goalIds":["simulated-goal"],"planningReason":"模拟安排依据"}]});
        blueprint["slots"] = json!(model_blueprint_slots(&generated, &config).unwrap());
        let checked = legacy_check_blueprint(&store, &blueprint).unwrap();
        assert_eq!(checked["slots"][0]["questionType"], "single_choice");
        assert_eq!(checked["slots"][0]["goalIds"], json!(["simulated-goal"]));
        assert_eq!(checked["slots"][0]["planningReason"], "模拟安排依据");

        let mut legacy = generated.clone();
        legacy["slots"][0]["questionType"] = json!("single_choice");
        assert_eq!(
            model_blueprint_slots(&legacy, &config).unwrap(),
            list(&blueprint["slots"])
        );
        legacy["slots"][0]["questionType"] = json!("free_response");
        assert!(model_blueprint_slots(&legacy, &config).is_err());
        legacy["slots"][0]["questionType"] = Value::Null;
        assert!(model_blueprint_slots(&legacy, &config).is_err());
        assert!(model_blueprint_slots(&json!({"slots":[null]}), &config).is_err());
        assert!(
            model_blueprint_slots(&json!({"slots":[{"taskId":"invented-task"}]}), &config).is_err()
        );

        blueprint["slots"][0]["goalIds"] = json!([]);
        assert!(
            legacy_check_blueprint(&store, &blueprint)
                .unwrap_err()
                .message
                .contains("必须教学目标")
        );
        blueprint["slots"] = json!(model_blueprint_slots(&generated, &config).unwrap());
        let extra = blueprint["slots"][0].clone();
        blueprint["slots"]
            .as_array_mut()
            .unwrap()
            .push(intake::merge(
                &extra,
                &json!({"slotId":"slot-2","number":2}),
            ));
        assert!(
            legacy_check_blueprint(&store, &blueprint)
                .unwrap_err()
                .message
                .contains("题量不一致")
        );
    }
    #[test]
    fn legacy_simulated_seed_compact_blueprints_validate_twenty_and_sixty_slots() {
        let (_dir, store, model) = simulated_store();
        let config = store.bank.config().unwrap();
        let pool = store.bank.questions().unwrap();
        for count in [20, 60] {
            let (single_choice, fill_blank, free_response) = if count == 20 {
                (12, 4, 4)
            } else {
                (30, 15, 15)
            };
            let blueprint = legacy_plan(
                &store,
                &json!({"requirements":{"counts":{"single_choice":single_choice,"multiple_choice":0,"fill_blank":fill_blank,"free_response":free_response},"targetDifficultyLevel":"medium_hard"},"mode":"rule"}),
                &model,
                &AtomicBool::new(false),
            ).unwrap();
            let requirements = blueprint["requirements"].clone();
            let references = list(&blueprint["slots"]);
            let compact_context =
                legacy_blueprint_model_context(&pool, &references, &requirements, &config);
            let old_context = intake::model_context(
                &json!({"requirements":requirements,"tasks":config["tasks"],"supply":legacy_supply(&pool,&references,&requirements,&config),"slots":references}),
            );
            let old_bytes = old_context.to_string().len();
            let compact_bytes = compact_context.to_string().len();
            eprintln!(
                "simulated blueprint slots={count} catalogTasks={} projectedTasks={} oldInputBytes={old_bytes} compactInputBytes={compact_bytes}",
                list(&config["tasks"]).len(),
                list(&compact_context["tasks"]).len()
            );
            assert!(compact_bytes < old_bytes);
            assert_eq!(compact_context["requirements"], requirements);

            // Simulate the compact model response through the same decoding,
            // deterministic scoring and validation used by the planning path.
            let generated = json!({"slots":references.iter().map(|slot|json!({"taskId":slot["taskId"],"goalIds":slot["goalIds"]})).collect::<Vec<_>>()});
            let mut slots = model_blueprint_slots(&generated, &config).unwrap();
            legacy_allocate_plan_points(&mut slots, &requirements, &config).unwrap();
            let checked =
                legacy_check_blueprint(&store, &json!({"requirements":requirements,"slots":slots}))
                    .unwrap();
            assert_eq!(checked["requirements"], requirements);
            assert_eq!(checked["plannedStats"]["questionCount"], count);
            assert_eq!(checked["slots"], blueprint["slots"]);
        }
    }
    #[test]
    fn legacy_simulated_five_level_targets_validate_and_inherit_without_guessing_legacy_numbers() {
        let (_dir, store, model) = simulated_store();
        let cancel = AtomicBool::new(false);
        for level in intake::DIFFICULTY_LEVELS {
            let requirements =
                intake::normalize(&store, &json!({"targetDifficultyLevel":level})).unwrap();
            let blueprint = legacy_plan(
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
            let checked = legacy_check_blueprint(&store, &custom).unwrap();
            assert_eq!(
                checked["slots"][0].get("targetDifficultyLevel"),
                Some(&Value::Null)
            );
            assert_eq!(checked["slots"][1]["targetDifficultyLevel"], "easy_medium");
            custom["slots"][0]["targetDifficultyLevel"] = json!("foundation");
            assert!(legacy_check_blueprint(&store, &custom).is_err());
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
        let old = legacy_plan(
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
        let checked = legacy_check_blueprint(&store, &old_slot).unwrap();
        assert_eq!(checked["slots"][0]["targetDifficulty"], 0.8);
        assert!(checked["slots"][0].get("targetDifficultyLevel").is_none());
    }
    #[test]
    fn legacy_simulated_semantic_difficulty_edits_persist_retry_and_freeze_without_replacing_questions() {
        let (dir, mut store, model) = simulated_store();
        let cancel = AtomicBool::new(false);
        let blueprint = legacy_plan(
            &store,
            &json!({"requirements":{"targetDifficultyLevel":"medium_hard"},"mode":"rule"}),
            &model,
            &cancel,
        )
        .unwrap();
        let mut draft = legacy_create_draft(
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
            draft = legacy_edit(&mut store, &op).unwrap()["draft"].clone();
            if index == 0 {
                first_operation = op.clone();
            }
            assert_eq!(draft["revision"], index + 1);
            assert_eq!(draft["slots"][0]["targetDifficultyLevel"], *level);
            assert_eq!(
                draft["slots"][0].get("targetDifficulty"),
                Some(&Value::Null)
            );
            assert_eq!(legacy_edit(&mut store, &op).unwrap()["draft"], draft);
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
            legacy_edit(&mut store, &reused).unwrap_err().code,
            "operation_conflict"
        );
        let op = |revision: &Value, operation_id: &str, patch: Value| json!({"draftId":draft["draftId"],"operation":intake::merge(&json!({"type":"difficulty","slotId":"slot-1","expectedRevision":revision,"operationId":operation_id}),&patch)});
        assert_eq!(
            legacy_edit(
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
                legacy_edit(
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
        draft = legacy_edit(&mut store, &legacy).unwrap()["draft"].clone();
        assert_eq!(draft["slots"][0]["targetDifficulty"], 0.8);
        assert!(draft["slots"][0].get("targetDifficultyLevel").is_none());
        let clear = json!({"draftId":draft["draftId"],"operation":{"type":"difficulty","slotId":"slot-1","targetDifficultyLevel":null,"operationId":"simulated-clear-difficulty","expectedRevision":draft["revision"]}});
        draft = legacy_edit(&mut store, &clear).unwrap()["draft"].clone();
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
        assert_eq!(legacy_edit(&mut store, &clear).unwrap()["draft"], draft);
        let paper = confirm(&mut store,&json!({"draftId":draft["draftId"],"expectedRevision":draft["revision"],"operationId":"simulated-difficulty-confirm","acknowledgeDifferences":true})).unwrap()["paper"].clone();
        verify_frozen_paper(&paper).unwrap();
        assert_eq!(paper["draft"], draft);
        let derived = derive(
            &mut store,
            &json!({"paperId":paper["paperId"],"operationId":"simulated-difficulty-derive"}),
        )
        .unwrap()["draft"]
            .clone();
        legacy_edit(&mut store,&json!({"draftId":derived["draftId"],"operation":{"type":"difficulty","slotId":"slot-1","targetDifficultyLevel":"easy_medium","operationId":"simulated-derived-difficulty","expectedRevision":0}})).unwrap();
        assert_eq!(
            store.document("papers", s(&paper, "paperId")).unwrap(),
            paper
        );
    }
    #[test]
    fn legacy_simulated_criteria_saves_task_and_semantic_difficulty_atomically() {
        let (_dir, mut store, model) = simulated_store();
        let cancel = AtomicBool::new(false);
        let blueprint = legacy_plan(
            &store,
            &json!({"requirements":{"targetDifficulty":0.8},"mode":"rule"}),
            &model,
            &cancel,
        )
        .unwrap();
        let original = legacy_create_draft(
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
            draft = legacy_edit(&mut store, &operation).unwrap()["draft"].clone();
            assert_eq!(draft["slots"][0].get("targetDifficultyLevel"), Some(&level));
            assert_eq!(
                draft["slots"][0].get("targetDifficulty"),
                Some(&Value::Null)
            );
            assert_eq!(
                draft["slots"][0]["question"],
                original["slots"][0]["question"]
            );
            assert_eq!(legacy_edit(&mut store, &operation).unwrap()["draft"], draft);
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
                legacy_edit(
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
        let retained = legacy_edit(&mut store, &without_target).unwrap()["draft"].clone();
        assert_eq!(retained["slots"][0]["targetDifficultyLevel"], "medium_hard");
    }
    #[test]
    fn legacy_simulated_multiple_choice_flows_through_planning_manual_editing_and_frozen_paper() {
        let (_dir, mut store, model) = simulated_store();
        let cancel = AtomicBool::new(false);
        let requirements = intake::normalize(&store, &json!({"scoringMode":"none"})).unwrap();
        assert_eq!(requirements["counts"]["multiple_choice"], 0);
        let no_supply = intake::normalize(&store,&json!({"counts":{"single_choice":0,"multiple_choice":2,"fill_blank":0,"free_response":0},"scoringMode":"none"})).unwrap();
        let no_task = legacy_plan(
            &store,
            &json!({"requirements":no_supply,"mode":"rule"}),
            &model,
            &cancel,
        )
        .unwrap_err();
        assert!(no_task.message.contains("2 道多选题"));
        assert!(no_task.message.contains("题量未改变"));
        assert!(store.list_documents("drafts").unwrap().is_empty());
        let original = legacy_plan(
            &store,
            &json!({"requirements":requirements,"mode":"rule"}),
            &model,
            &cancel,
        )
        .unwrap();
        let slot = &original["slots"][0];
        let pool = store.bank.questions().unwrap();
        let mut config = store.bank.config().unwrap();
        let candidate = legacy_candidates(&pool, slot, &requirements, &config, &[])
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
        let blueprint = legacy_plan(
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
        let draft = legacy_create_draft(
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
        let edited = legacy_edit(&mut store,&json!({"draftId":manual["draftId"],"operation":{"type":"add","questionType":"multiple_choice","operationId":"simulated-multiple-add","expectedRevision":manual["revision"]}})).unwrap()["draft"].clone();
        assert_eq!(edited["slots"][1]["questionType"], "multiple_choice");
        assert_eq!(edited["stats"]["missingCount"], 1);
        let removed=legacy_edit(&mut store,&json!({"draftId":manual["draftId"],"operation":{"type":"delete","slotId":edited["slots"][0]["slotId"],"operationId":"simulated-multiple-remove","expectedRevision":edited["revision"]}})).unwrap()["draft"].clone();
        assert!(removed.get("planningShortage").is_none());
        assert_eq!(removed["stats"]["requestedCount"],1);assert_eq!(removed["stats"]["unplannedCount"],0);assert_eq!(removed["stats"]["missingCount"],1);
        assert!(!list(&removed["differences"]).iter().any(|issue|issue["code"]=="planning_shortage" || issue["code"]=="missing_required_goal"));
    }
    #[test]
    fn legacy_simulated_deleted_history_is_inaccessible_without_cascading_to_independent_work() {
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
        let edited = legacy_edit(&mut store, &json!({"draftId":derived["draftId"],"operation":{"type":"rename","title":"模拟独立草稿仍可编辑","operationId":"history-independent-edit","expectedRevision":derived["revision"]}})).unwrap();
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
    fn legacy_simulated_manual_quantity_accepts_one_and_sixty_including_over_thirty_one_type() {
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
                assert_eq!(legacy_edit(&mut store,&json!({"draftId":draft["draftId"],"operation":{"type":"add","operationId":"manual-over-sixty","expectedRevision":0,"questionType":"single_choice","candidateId":q["questionId"],"contentVersion":q["contentVersion"],"teacherVersion":q["teacherVersion"]}})).unwrap_err().code,"invalid_plan");
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
    fn legacy_simulated_manual_edit_replace_add_finalize_and_derive_preserve_boundaries() {
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
            let result = legacy_edit(
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
        assert_eq!(legacy_edit(&mut store,&json!({"draftId":draft["draftId"],"operation":{"type":"rename","operationId":"manual-finalized-edit","expectedRevision":draft["revision"],"title":"禁止"}})).unwrap_err().code,"finalized_draft");
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
    fn legacy_simulated_manual_free_response_replacement_and_add_use_actual_part_identities() {
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
        draft = legacy_edit(
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
        draft = legacy_edit(
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
        let replay = legacy_edit(
            &mut store,
            &json!({"draftId":draft["draftId"],"operation":op}),
        )
        .unwrap();
        assert_eq!(replay["replayed"], true);
        assert_eq!(replay["draft"], draft);
        let mut changed = op.clone();
        changed["candidateId"] = free[0]["questionId"].clone();
        assert_eq!(
            legacy_edit(
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
    fn legacy_unknown_versions_never_eligible() {
        let q = json!({"questionId":"q","questionType":"single_choice","contentVersion":"new","teacherVersion":"t","sourceRefs":[{"sourceId":"source"}]});
        let config = json!({"assemblyIndex":{"entries":[{"questionId":"q","contentVersion":"old","teacherVersion":"t","primarySections":["1.1"],"duplicateGroup":"g"}]}});
        let result = legacy_assess(
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
    fn legacy_complete_path_and_required_goal_evidence_are_not_model_guesses() {
        let q = json!({"questionId":"q","questionType":"single_choice","contentVersion":"c","teacherVersion":"t","sourceRefs":[{"sourceId":"source"}]});
        let config = json!({"assemblyIndex":{"entries":[{"questionId":"q","contentVersion":"c","teacherVersion":"t","tasks":["task"],"primarySections":["1.1"],"duplicateGroup":"g","solutionPaths":[{"id":"path","requiredSections":["1.1"],"requiredPremises":["vieta"],"basis":"模拟完整解法依据"}]}]}});
        let slot = json!({"taskId":"task","goalIds":[]});
        let mut r = json!({"mainScope":["1.1"],"learnedScope":["1.1"],"sourceIds":["source"],"premises":[],"foundationPremises":[],"teachingGoals":[]});
        assert_eq!(
            legacy_assess(&q, &slot, &r, &config, &HashSet::new(), &HashSet::new())["status"],
            "unknown"
        );
        r["premises"] = json!(["vieta"]);
        assert_eq!(
            legacy_assess(&q, &slot, &r, &config, &HashSet::new(), &HashSet::new())["status"],
            "eligible"
        );
        r["teachingGoals"] = json!([{"id":"g1","priority":"required"}]);
        let slot = intake::merge(&slot, &json!({"goalIds":["g1"]}));
        assert_eq!(
            legacy_assess(&q, &slot, &r, &config, &HashSet::new(), &HashSet::new())["status"],
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
    fn legacy_simulated_knowledge_scope_distinguishes_points_in_the_same_section() {
        let (question, slot, mut requirements, config) = simulated_knowledge_assessment();
        let eligible = legacy_assess(
            &question,
            &slot,
            &requirements,
            &config,
            &HashSet::new(),
            &HashSet::new(),
        );
        assert_eq!(eligible["canSelect"], true);
        requirements["mainKnowledgeUids"] = json!(["simulated-b"]);
        let excluded = legacy_assess(
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
            legacy_assess(
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
            legacy_assess(
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
    fn legacy_simulated_legacy_sections_do_not_override_explicit_knowledge_boundaries() {
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
            legacy_assess(
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
            legacy_assess(
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
    fn legacy_simulated_knowledge_boundary_accepts_one_complete_allowed_solution_path() {
        let (question, slot, requirements, mut config) = simulated_knowledge_assessment();
        let entry = &mut config["assemblyIndex"]["entries"][0];
        let mut unavailable = entry["solutionPaths"][0].clone();
        unavailable["id"] = json!("simulated-needs-b");
        unavailable["requiredKnowledgeUids"] = json!(["simulated-a", "simulated-b"]);
        entry["solutionPaths"] = json!([unavailable]);
        assert_eq!(
            legacy_assess(
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
        let result = legacy_assess(
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
            legacy_assess(
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
            legacy_assess(
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
            legacy_assess(
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
    fn legacy_simulated_invalid_knowledge_evidence_never_falls_back_to_sections() {
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
            let result = legacy_assess(
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
    fn legacy_migrated_real_chapter_two_rules_respect_scope_and_use_verified_supply() {
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
            let blueprint = legacy_plan(
                &store,
                &json!({"requirements":requirements,"mode":"rule"}),
                &model,
                &cancel,
            )
            .unwrap();
            let draft = legacy_create_draft(
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
                                &legacy_assess(
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
    fn legacy_simulated_real_seed_shortage_revisions_idempotency_and_immutable_paper() {
        let (_dir, mut store, model) = simulated_store();
        let cancel = AtomicBool::new(false);
        let student = store
            .create_student(&json!({"name":"模拟学生","operationId":"student-case"}))
            .unwrap();
        let prepared=intake::legacy_prepare(&store,&json!({"requirements":{"mainScope":["1.1"],"learnedScope":["1.1"],"student":student},"message":"12道题，不要解答题","mode":"rule"}),&model,&cancel).unwrap();
        assert_eq!(prepared["requirements"]["questionCount"], 12);
        assert_eq!(prepared["requirements"]["counts"]["free_response"], 0);
        let mut blueprint = legacy_plan(
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
        let mut draft = legacy_create_draft(
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
        draft = legacy_edit(&mut store, &operation).unwrap()["draft"].clone();
        assert_eq!(draft["revision"], 1);
        assert_eq!(
            legacy_edit(&mut store, &operation).unwrap()["draft"]["revision"],
            1
        );
        let mut conflict = operation.clone();
        conflict["operation"]["title"] = json!("不同内容");
        assert_eq!(
            legacy_edit(&mut store, &conflict).unwrap_err().code,
            "operation_conflict"
        );
        assert_eq!(legacy_edit(&mut store,&json!({"draftId":draft["draftId"],"operation":{"type":"rename","operationId":"stale-case","expectedRevision":0,"title":"过期修改"}})).unwrap_err().code,"revision_conflict");
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
        assert_eq!(legacy_edit(&mut store,&json!({"draftId":draft["draftId"],"operation":{"type":"rename","operationId":"after-paper","expectedRevision":2,"title":"禁止修改"}})).unwrap_err().code,"finalized_draft");
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
    fn legacy_invalid_blueprint_and_cancellation_do_not_persist_a_draft() {
        let (_dir, mut store, model) = simulated_store();
        let cancel = AtomicBool::new(false);
        let prepared = intake::legacy_prepare(
            &store,
            &json!({"requirements":{},"message":"10道题","mode":"rule"}),
            &model,
            &cancel,
        )
        .unwrap();
        let mut requirements = prepared["requirements"].clone();
        requirements["counts"]["single_choice"] = json!(9);
        let blueprint = legacy_plan(
            &store,
            &json!({"requirements":requirements,"mode":"rule"}),
            &model,
            &cancel,
        )
        .unwrap();
        let mut bad = blueprint.clone();
        bad["slots"].as_array_mut().unwrap().pop();
        assert!(legacy_check_blueprint(&store, &bad).is_err());
        cancel.store(true, Ordering::Relaxed);
        assert_eq!(
            legacy_create_draft(
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
    fn legacy_simulated_required_goal_rebinding_confirms_plan_but_keeps_evidence_unknown_and_freezes_shortage()
     {
        let (dir, mut store, model) = simulated_flow_store();
        let cancel = AtomicBool::new(false);
        let prepared = intake::legacy_prepare(&store, &json!({"requirements":{"mainScope":["1.1"],"learnedScope":["1.1"],"teachingGoals":[simulated_goal("required","answer","1.1")]},"message":"2道单选题，不要填空题和解答题","mode":"rule"}), &model, &cancel).unwrap();
        let mut blueprint = legacy_plan(
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
        let rejected = legacy_create_draft(
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
        let checked = legacy_check_blueprint(&store, &blueprint).unwrap();
        assert_eq!(checked["slots"][0]["goalIds"], json!(["simulated-goal"]));
        let mut draft = legacy_create_draft(
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
        draft = legacy_edit(&mut store, &json!({"draftId":draft["draftId"],"operation":{"type":"rename","title":"模拟目标重绑缺题练习","operationId":"simulated-rebind-save","expectedRevision":0}})).unwrap()["draft"].clone();
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
        assert_eq!(legacy_edit(&mut reopened, &json!({"draftId":draft_id,"operation":{"type":"rename","title":"模拟禁止修改成卷","operationId":"simulated-rebind-after-confirm","expectedRevision":draft["revision"]}})).unwrap_err().code, "finalized_draft");
        assert_eq!(
            reopened.document("papers", s(&paper, "paperId")).unwrap(),
            paper
        );
    }

    #[test]
    fn legacy_simulated_goal_binding_compatibility_enforces_scope_and_written_response_without_model_claims()
     {
        let (_dir, store, model) = simulated_flow_store();
        let mut blueprint = legacy_plan(&store, &json!({"requirements":{"mainScope":["1.1"],"learnedScope":["1.1"],"counts":{"single_choice":1,"multiple_choice":0,"fill_blank":0,"free_response":0}},"mode":"rule"}), &model, &AtomicBool::new(false)).unwrap();
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
            assert_eq!(legacy_check_blueprint(&store, &blueprint).is_ok(), allowed);
        }
        blueprint["requirements"]["teachingGoals"] =
            json!([simulated_goal("required", "answer", "1.1")]);
        blueprint["slots"][0]["goalIds"] = json!(["unknown-goal"]);
        assert!(
            legacy_check_blueprint(&store, &blueprint)
                .unwrap_err()
                .message
                .contains("未知教学目标")
        );
    }

    #[test]
    fn legacy_simulated_selection_model_failure_invalid_ranking_cancel_and_retry_preserve_plan_and_saved_drafts()
     {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::time::{Duration, Instant};
        let (dir, mut store, mut model) = simulated_flow_store();
        let cancel = AtomicBool::new(false);
        let blueprint = legacy_plan(&store, &json!({"requirements":{"title":"模拟失败恢复练习","mainScope":["1.1"],"learnedScope":["1.1"],"counts":{"single_choice":2,"multiple_choice":0,"fill_blank":0,"free_response":0}},"mode":"rule"}), &model, &cancel).unwrap();
        let unchanged_plan = blueprint.clone();
        assert_eq!(
            legacy_create_draft(
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
            let failure = legacy_create_draft(
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
            legacy_create_draft(
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
        let ai_draft = legacy_create_draft(
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
        let rule_draft = legacy_create_draft(
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
            legacy_create_draft(
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
