use super::*;

pub(super) fn frozen_model(
    store: &Store,
    record: &Value,
    model: &ModelClient,
    role: &str,
) -> AppResult<ModelClient> {
    let selected = if role == "teachingGeneration" {
        model.import_generator()?
    } else if role == "teachingReview" {
        model.import_teaching_reviewer()?
    } else {
        model.import_accuracy_model(role)?
    };
    let run = run_for(store, record)?;
    if (role != "teachingReview" || super::two_model::is_run(store, record)?)
        && selected.import_execution_identity()? != run["strategy"]["bindings"][role]
    {
        return Err(err(
            "accuracy_configuration_changed",
            "用途配置已变更，请恢复本次保存的配置后继续；不会自动换模型或重置预算。",
        ));
    }
    if (role != "teachingReview" || super::two_model::is_run(store, record)?)
        && model.public_settings()["effectiveImportRoles"][role]
            != run["strategy"]["roleSettings"][role]
    {
        return Err(err(
            "accuracy_configuration_changed",
            "本次用途的型号或思考参数已变更，未自动套用新配置。",
        ));
    }
    Ok(selected)
}
fn stage(
    store: &Store,
    record: &Value,
    model: &ModelClient,
    q: &Value,
    state: &mut Value,
    key: &str,
    role: &str,
    task: &str,
    context: Value,
    assets: &[Value],
    cancel: &AtomicBool,
) -> AppResult<Value> {
    let inputs = json!({"sourceSha256":source_sha(q),"contextSha256":hash_json(&context),"assets":assets.iter().map(|a|json!({"id":a["id"],"sha256":a["sha256"],"role":a["role"]})).collect::<Vec<_>>()});
    if !state[key].is_null() {
        let envelope = store::get_artifact(store, &state[key])?;
        if envelope["inputs"] == inputs {
            return Ok(envelope["payload"].clone());
        }
    }
    cancelled(cancel)?;
    mutate_run(store, record, |r| {
        r["progress"]["stage"] = json!(key);
        r["status"] = json!("running");
    })?;
    let response = model_call(
        store,
        record,
        &frozen_model(store, record, model, role)?,
        task,
        role,
        s(q, "questionId"),
        &context,
        assets,
        cancel,
    )?;
    let value = &response["result"];
    match key {
        "source" => {
            contracts::report(value, s(q, "questionId"), &targets(q, "source"))?;
            validate_source_report(q, value)?;
        }
        "math" => contracts::report(value, s(q, "questionId"), &targets(q, "math"))?,
        "teaching" => contracts::report(value, s(q, "questionId"), &targets(q, "teaching"))?,
        "metadata" => contracts::metadata(
            value,
            s(q, "questionId"),
            &artifact(store, &state["catalogue"])?,
        )?,
        "solution" | "independent" => validate_solution(q, value)?,
        _ => return Err(err("accuracy_stage_invalid", "未知的准确性处理阶段。")),
    }
    state[key] = store::put_artifact(
        store,
        s(record, "accuracyRunId"),
        key,
        s(q, "questionId"),
        &inputs,
        &response,
    )?;
    state["lastError"] = Value::Null;
    save_state(store, record, q, state)?;
    Ok(response)
}
pub(super) fn validate_solution(q: &Value, value: &Value) -> AppResult<()> {
    let keys = [
        "questionId",
        "answer",
        "solution",
        "partCoverage",
        "limitations",
    ];
    let expected: Vec<Value> = if rows(&q["parts"]).is_empty() {
        vec![Value::Null]
    } else {
        rows(&q["parts"])
            .iter()
            .map(|p| p["partId"].clone())
            .collect()
    };
    let actual = rows(&value["partCoverage"]);
    if value
        .as_object()
        .is_none_or(|o| o.len() != keys.len() || keys.iter().any(|k| !o.contains_key(*k)))
        || value["questionId"] != q["questionId"]
        || s(value, "answer").trim().is_empty()
        || s(value, "solution").trim().is_empty()
        || s(value, "answer").chars().count() > 30_000
        || s(value, "solution").chars().count() > 60_000
        || !value["limitations"].is_array()
        || !rows(&value["limitations"]).iter().all(Value::is_string)
        || actual.len() != expected.len()
        || expected
            .iter()
            .any(|id| actual.iter().filter(|a| *a == id).count() != 1)
    {
        return Err(err(
            "invalid_accuracy_solution",
            "解答候选身份、完整小问覆盖或字段不符合合同，原响应已保留。",
        ));
    }
    Ok(())
}
pub(super) fn validate_source_report(q: &Value, report: &Value) -> AppResult<()> {
    let presence = &report["referencePresence"];
    for field in ["answer", "solution"] {
        let has = !s(q, field).trim().is_empty()
            || rows(&q["parts"])
                .iter()
                .any(|p| !s(p, field).trim().is_empty());
        if !matches!(s(presence, field), "present" | "absent" | "uncertain")
            || good(report)
                && (has != (presence[field] == "present") || presence[field] == "uncertain")
        {
            return Err(err(
                "invalid_accuracy_report",
                "来源报告与实际保留的原参考不一致。",
            ));
        }
    }
    let disclosures = rows(&report["assetDisclosures"]);
    for group in ["student", "teacher"] {
        for asset in rows(&q[group]["assets"]) {
            let id = s(&asset, "assetId");
            let found: Vec<_> = disclosures.iter().filter(|a| a["assetId"] == id).collect();
            if found.len() != 1
                || group == "student" && good(report) && found[0]["role"] != "student_original"
            {
                return Err(err(
                    "invalid_accuracy_report",
                    "来源报告缺少逐素材角色核对，不能把参考图或未判图片送入盲解。",
                ));
            }
        }
    }
    if !report["assetDisclosures"].is_array() {
        return Err(err("invalid_accuracy_report", "来源报告缺少素材披露。"));
    }
    Ok(())
}
fn images_for_reference(q: &Value, assets: &[Value]) -> AppResult<Vec<Value>> {
    images_for_group(q, assets, "teacher")
}
pub(super) fn images_for_group(q: &Value, assets: &[Value], group: &str) -> AppResult<Vec<Value>> {
    rows(&q[group]["assets"])
        .into_iter()
        .map(|reference| {
            let mut asset = assets
                .iter()
                .find(|a| {
                    a["id"] == reference["assetId"]
                        && a["sha256"] == reference["sha256"]
                        && a["role"] != "source_page"
                })
                .cloned()
                .ok_or_else(|| {
                    err(
                        "accuracy_images_required",
                        "原题或原参考图像缺失、版本不一致，未把图片引用冒充实际材料。",
                    )
                })?;
            asset["role"] = json!(group);
            Ok(asset)
        })
        .collect()
}
fn images_for_student(q: &Value, assets: &[Value], source_report: &Value) -> AppResult<Vec<Value>> {
    let mut out = vec![];
    for reference in rows(&q["student"]["assets"]) {
        let id = s(&reference, "assetId");
        if !rows(&source_report["assetDisclosures"])
            .iter()
            .any(|d| d["assetId"] == id && d["role"] == "student_original")
        {
            return Err(err(
                "accuracy_visual_unresolved",
                "题图的独立性尚未核对，未发起盲解。",
            ));
        }
        let mut asset = assets
            .iter()
            .find(|a| {
                a["id"] == id && a["role"] != "source_page" && a["sha256"] == reference["sha256"]
            })
            .cloned()
            .ok_or_else(|| {
                err(
                    "accuracy_images_required",
                    "实际学生题图缺失或版本不一致，未发起盲解。",
                )
            })?;
        asset["role"] = json!("student");
        asset["disclosure"] = json!("student_original");
        out.push(asset);
    }
    Ok(out)
}
pub(super) fn source_page_locations(page: &Value, q: &Value) -> Value {
    let wanted = ids(&q["sourceBlockIds"]);
    let blocks:Vec<_>=rows(&page["blocks"]).into_iter().filter_map(|block|{
        let id=block["id"].as_str().map(str::to_owned).unwrap_or_else(||block["id"].to_string());
        let key=format!("p{}-b{}",page["page"],id);
        wanted.contains(&key).then(||json!({"sourceBlockId":key,"id":block["id"],"bbox":block["bbox"],"type":block["type"],"order":block["order"]}))
    }).collect();
    json!({"projectionVersion":"source-page-locations-v1","page":page["page"],"width":page["width"],"height":page["height"],"sourceImageAssetId":page["sourceImageAssetId"],"coordinateTransform":page["coordinateTransform"],"blocks":blocks,"evidencePolicy":"原页图与实际裁图是保真依据；blocks仅用于定位，不重复整页OCR文字。"})
}
#[cfg(test)]
mod source_projection_tests {
    use super::*;
    #[test]
    fn large_ocr_layout_is_immutable_while_only_real_question_locations_are_sent() {
        let page = json!({"page":1,"width":2000,"height":1413,"sourceImageAssetId":"real-source-page","text":"原卷完整OCR文字".repeat(4000),"blocks":[{"id":0,"bbox":[0,0,500,200],"text":"邻题文字".repeat(1000),"type":"text","order":1},{"id":2,"bbox":[600,300,1100,500],"text":"本题OCR文字".repeat(1000),"type":"text","order":3}],"coordinateTransform":{"imageWidth":2000,"imageHeight":1413}});
        let original = page.clone();
        let q = json!({"sourceBlockIds":["p1-b2"]});
        let projected = source_page_locations(&page, &q);
        assert_eq!(page, original);
        assert_eq!(projected["sourceImageAssetId"], "real-source-page");
        assert_eq!(projected["blocks"].as_array().unwrap().len(), 1);
        assert_eq!(projected["blocks"][0]["sourceBlockId"], "p1-b2");
        assert_eq!(projected["blocks"][0]["bbox"], json!([600, 300, 1100, 500]));
        assert!(projected.get("text").is_none());
        assert!(projected["blocks"][0].get("text").is_none());
        assert!(projected.to_string().len() < 2000);
        let body = json!({"model":"deepseek-flash","messages":[{"role":"system","content":"对照实际原页与裁图逐项核对，OCR仅定位。"},{"role":"user","content":json!({"candidate":q,"originalPages":[projected],"responseContract":contracts::response_contract("source")}).to_string()}],"max_tokens":24576});
        assert!(budget::estimate_input_for(&body, 24_000, "https://api.deepseek.com").is_ok());
    }
    #[test]
    fn locator_selection_never_invents_a_missing_block_or_uses_neighboring_question_text() {
        let page = json!({"page":2,"blocks":[{"id":2,"text":"不能作为p1-b2的原文"}]});
        let projected = source_page_locations(&page, &json!({"sourceBlockIds":["p1-b2"]}));
        assert_eq!(projected["blocks"], json!([]));
    }
}
pub(super) fn process(
    store: &mut Store,
    model: &ModelClient,
    record: &mut Value,
    cancel: &AtomicBool,
) -> AppResult<()> {
    if super::two_model::is_run(store, record)? {
        validate_configuration(model)?;
    } else {
        validate_legacy_configuration(model)?;
    }
    let mut saved = record.clone();
    // Remove only the legacy process placeholder from new records. Raw source
    // fields, references, OCR, and provenance stay intact.
    for q in record["questions"].as_array_mut().into_iter().flatten() {
        q.as_object_mut().unwrap().remove("teachingWorkflow");
    }
    let (pages, assets) = if record["ocrSource"].is_object() {
        let doc = paddle::load_document(store, record)?;
        (doc.pages, doc.assets)
    } else {
        (rows(&record["extractedPages"]), vec![])
    };
    let catalogue = applicable_catalogue(store, record)?;
    for q in rows(&record["questions"]) {
        cancelled(cancel)?;
        if ids(&record["publishedQuestionIds"]).contains(&s(&q, "questionId").to_owned()) {
            continue;
        }
        if eligible(store, record, &q)? {
            continue;
        }
        let mut value = state(store, record, &q)?;
        if !value.is_object() {
            value = json!({"sourceSha256":source_sha(&q),"repairCalls":0});
        }
        let result = process_question(
            store, model, record, &q, &mut value, &pages, &assets, &catalogue, cancel,
        );
        if let Err(error) = &result {
            value["lastError"] = json!({"code":error.code,"message":error.message});
            save_state(store, record, &q, &value)?;
        }
        record["recognitionStage"] = json!("accuracy_processing");
        save_cas(store, Some(&saved), record)?;
        saved = record.clone();
        if let Err(error) = result {
            if matches!(
                error.code.as_str(),
                "cancelled"
                    | "budget_paused"
                    | "accuracy_input_budget"
                    | "accuracy_integrity"
                    | "accuracy_configuration_changed"
                    | "accuracy_storage_budget"
                    | "accuracy_visual_budget_unknown"
            ) {
                return Err(error);
            }
        }
        if run_for(store, record)?["status"] == "budget_paused" {
            return Err(err(
                "budget_paused",
                "本次预算已暂停，已完成证据和额度保留。",
            ));
        }
    }
    mutate_run(store, record, |r| {
        r["status"] = json!("awaiting_confirmation");
        r["progress"]["stage"] = json!("review");
    })?;
    store::pause_parent_clocks(store, s(record, "accuracyRunId"))?;
    record["recognitionStage"] = json!("complete");
    save_cas(store, Some(&saved), record)?;
    Ok(())
}
pub(super) fn process_question(
    store: &Store,
    model: &ModelClient,
    record: &Value,
    q: &Value,
    value: &mut Value,
    pages: &[Value],
    assets: &[Value],
    catalogue: &Value,
    cancel: &AtomicBool,
) -> AppResult<()> {
    if super::two_model::is_run(store, record)? {
        return super::two_model::process_question(store, model, record, q, value, pages, assets, catalogue, cancel);
    }
    let qid = s(q, "questionId");
    let source = source_input(q);
    if value["sourceCandidate"].is_null() {
        value["sourceCandidate"] = store::put_artifact(
            store,
            s(record, "accuracyRunId"),
            "source_candidate",
            qid,
            &json!({"sha256":source_sha(q)}),
            &source,
        )?;
        save_state(store, record, q, value)?;
    }
    let selected_pages = rows(&q["pages"]);
    let page_selected = |page: &Value| {
        selected_pages.is_empty()
            || selected_pages
                .iter()
                .any(|p| p == &page["page"] || p["page"] == page["page"])
    };
    let normalized_pages: Vec<_> = pages
        .iter()
        .enumerate()
        .map(|(i, p)| {
            if p.is_string() {
                json!({"page":i+1,"text":p})
            } else {
                p.clone()
            }
        })
        .collect();
    let mut actual_pages: Vec<_> = normalized_pages
        .iter()
        .filter(|p| page_selected(p))
        .cloned()
        .collect();
    if record["ocrSource"].is_object()
        && run_for(store, record)?["strategy"]["sourceProjection"] == "source-page-locations-v1"
    {
        actual_pages = actual_pages
            .iter()
            .map(|page| source_page_locations(page, q))
            .collect();
    }
    let mut source_images: Vec<_> = assets
        .iter()
        .filter(|a| a["role"] == "source_page" && page_selected(a))
        .cloned()
        .collect();
    if record["ocrSource"].is_object()
        && (actual_pages.is_empty()
            || actual_pages.iter().any(|page| {
                !source_images
                    .iter()
                    .any(|asset| asset["page"] == page["page"])
            }))
    {
        return Err(err(
            "accuracy_images_required",
            "待核对的原页图不完整，未用OCR文字或裁图冒充实际原页。",
        ));
    }
    source_images.extend(images_for_group(q, assets, "student")?);
    source_images.extend(images_for_reference(q, assets)?);
    let manual_source = checked_report(store, value, "source")?;
    let fidelity = if manual_source["status"] == "teacher_reviewed" {
        json!({"result":manual_source})
    } else {
        stage(
            store,
            record,
            model,
            q,
            value,
            "source",
            "sourceVerification",
            "accuracy_source_verification",
            json!({"questionId":qid,"candidate":source,"originalPages":actual_pages,"requiresImages":record["ocrSource"].is_object(),"requiredTargets":targets(q,"source"),"responseContract":contracts::response_contract("source")}),
            &source_images,
            cancel,
        )?
    };
    if !good(&checked_report(store, value, "source")?) {
        return Ok(());
    }
    let student_images = images_for_student(q, assets, &fidelity["result"])?;
    let mut with_reference = student_images.clone();
    with_reference.extend(images_for_reference(q, assets)?);
    let solution = if value["solutionOrigin"] == "repair" {
        artifact(store, &value["solution"])?
    } else {
        stage(
            store,
            record,
            model,
            q,
            value,
            "solution",
            "teachingGeneration",
            "accuracy_solution_generation",
            json!({"questionId":qid,"student":student(q),"originalReference":source["originalReference"],"responseContract":contracts::response_contract("solution")}),
            &with_reference,
            cancel,
        )?
    };
    // The blind result is persisted by stage() before any comparison request.
    let manual_math = checked_report(store, value, "math")?;
    let teacher_math = manual_math["status"] == "teacher_reviewed";
    let independent = if teacher_math && value["independent"].is_null() {
        json!({"result":null})
    } else {
        stage(
            store,
            record,
            model,
            q,
            value,
            "independent",
            "independentSolve",
            "accuracy_independent_solve",
            json!({"questionId":qid,"student":student(q),"responseContract":contracts::response_contract("independent")}),
            &student_images,
            cancel,
        )?
    };
    let math = if teacher_math {
        json!({"result":manual_math})
    } else {
        stage(
            store,
            record,
            model,
            q,
            value,
            "math",
            "mathVerification",
            "accuracy_math_verification",
            json!({"questionId":qid,"student":student(q),"originalReference":source["originalReference"],"candidate":solution["result"],"independent":independent["result"],"requiredTargets":targets(q,"math"),"responseContract":contracts::response_contract("math")}),
            &with_reference,
            cancel,
        )?
    };
    let _ = math;
    if !good(&checked_report(store, value, "math")?) {
        return Ok(());
    }
    if teacher_math
        && targets(q, "math").iter().any(|target| {
            !rows(&manual_math["checks"])
                .iter()
                .any(|check| check["target"] == *target && check["status"] == "checked")
        })
        && value["metadata"].is_null()
    {
        return Ok(());
    }
    let snapshot = store::put_artifact(
        store,
        s(record, "accuracyRunId"),
        "catalogue_snapshot",
        qid,
        &json!({"sha256":hash_json(catalogue)}),
        catalogue,
    )?;
    if value["catalogue"] != snapshot {
        value["catalogue"] = snapshot;
        value["metadata"] = Value::Null;
        value["teaching"] = Value::Null;
        value["teachingManual"] = Value::Null;
        value["metadataOrigin"] = Value::Null;
    }
    let model_catalogue = super::catalogue::model_input(catalogue);
    value["catalogueModelInput"] = store::put_artifact(
        store,
        s(record, "accuracyRunId"),
        "catalogue_model_input",
        qid,
        &json!({"catalogue":value["catalogue"],"projectionVersion":"accuracy-catalogue-columns-rows-v1"}),
        &model_catalogue,
    )?;
    save_state(store, record, q, value)?;
    let metadata = if value["metadataOrigin"] == "repair" {
        artifact(store, &value["metadata"])?
    } else {
        stage(
            store,
            record,
            model,
            q,
            value,
            "metadata",
            "teachingGeneration",
            "accuracy_teaching_generation",
            json!({"questionId":qid,"student":student(q),"verifiedSolution":solution["result"],"catalogue":model_catalogue,"responseContract":contracts::response_contract("metadata")}),
            &student_images,
            cancel,
        )?
    };
    let candidate = compose(q, &solution["result"], &metadata["result"])?;
    let inputs = json!({"solution":value["solution"],"metadata":value["metadata"],"sourceSha256":source_sha(q),"catalogue":value["catalogue"]});
    value["composition"] = store::put_artifact(
        store,
        s(record, "accuracyRunId"),
        "composition",
        qid,
        &inputs,
        &json!({"candidate":candidate,"fieldOrigins":{"answer":value["solution"],"teachingSolution":value["solution"],"difficultyAssessment":value["metadata"],"teachingFocus":value["metadata"]}}),
    )?;
    save_state(store, record, q, value)?;
    if checked_report(store, value, "teaching")?["status"] != "teacher_reviewed" {
        stage(
            store,
            record,
            model,
            q,
            value,
            "teaching",
            "teachingVerification",
            "accuracy_teaching_verification",
            json!({"questionId":qid,"student":student(q),"verifiedSolution":solution["result"],"candidate":candidate,"metadata":metadata["result"],"catalogue":model_catalogue,"requiredTargets":targets(q,"teaching"),"responseContract":contracts::response_contract("teaching")}),
            &student_images,
            cancel,
        )?;
    }
    Ok(())
}
pub(super) fn compose(q: &Value, solution: &Value, metadata: &Value) -> AppResult<Value> {
    let value = json!({"questionId":q["questionId"],"answer":solution["answer"],"teachingSolution":solution["solution"],"difficultyAssessment":metadata["difficultyAssessment"],"teachingFocusSchemaVersion":2,"teachingFocus":metadata["teachingFocus"],"issues":metadata["issues"]});
    teaching::validate(&value, s(q, "questionId"))?;
    Ok(value)
}
pub(super) fn repair(
    store: &Store,
    model: &ModelClient,
    record: &Value,
    q: &Value,
    value: &mut Value,
    basis: &str,
    cancel: &AtomicBool,
) -> AppResult<()> {
    if super::two_model::is_run(store, record)? {
        return super::two_model::repair(store, model, record, q, value, basis, cancel);
    }
    if value["repairCalls"].as_u64().unwrap_or(0) > 0 || value["solution"].is_null() {
        return Err(err(
            "accuracy_repair_exhausted",
            "本题的一次显式修订已使用，原稿与核对依据保留。",
        ));
    }
    if !good(&checked_report(store, value, "source")?) {
        return Err(err(
            "review_required",
            "请先核对或修正原题来源；解答修订不能改写原卷。",
        ));
    }
    let metadata_only =
        good(&checked_report(store, value, "math")?) && !value["metadata"].is_null();
    let key = if metadata_only {
        "metadata"
    } else {
        "solution"
    };
    let previous = artifact(store, &value[key])?;
    let catalogue = applicable_catalogue(store, record)?;
    let context = json!({"questionId":q["questionId"],"student":student(q),"candidate":previous["result"],"scope":key,"concreteProblem":basis,"catalogue":if metadata_only{super::catalogue::model_input(&catalogue)}else{Value::Null},"verifiedSolution":if metadata_only{artifact(store,&value["solution"])?["result"].clone()}else{Value::Null},"responseContract":contracts::response_contract(if metadata_only{"metadata"}else{"repair"})});
    let calls_before = run_for(store, record)?["budgetState"]["usedCalls"].clone();
    value["repairCalls"] = json!(1);
    save_state(store, record, q, value)?;
    let images = if record["ocrSource"].is_object() {
        let doc = paddle::load_document(store, record)?;
        images_for_student(q, &doc.assets, &checked_report(store, value, "source")?)?
    } else {
        vec![]
    };
    let response = model_call(
        store,
        record,
        &frozen_model(store, record, model, "teachingReview")?,
        "accuracy_repair",
        "teachingReview",
        s(q, "questionId"),
        &context,
        &images,
        cancel,
    );
    if response.is_err() && run_for(store, record)?["budgetState"]["usedCalls"] == calls_before {
        value["repairCalls"] = json!(0);
        save_state(store, record, q, value)?;
    }
    let response = response?;
    if metadata_only {
        contracts::metadata(&response["result"], s(q, "questionId"), &catalogue)?;
    } else {
        validate_solution(q, &response["result"])?;
    }
    value["repairOriginal"] = value[key].clone();
    value[key] = store::put_artifact(
        store,
        s(record, "accuracyRunId"),
        key,
        s(q, "questionId"),
        &json!({"sourceSha256":source_sha(q),"prior":value["repairOriginal"],"problem":basis}),
        &response,
    )?;
    value[format!("{key}Origin")] = json!("repair");
    value["composition"] = Value::Null;
    value["teaching"] = Value::Null;
    value["teachingManual"] = Value::Null;
    value["lastError"] = Value::Null;
    if !metadata_only {
        for field in ["math", "mathManual", "metadata"] {
            value[field] = Value::Null;
        }
        value["metadataOrigin"] = Value::Null;
    }
    save_state(store, record, q, value)?;
    let (pages, assets) = if record["ocrSource"].is_object() {
        let doc = paddle::load_document(store, record)?;
        (doc.pages, doc.assets)
    } else {
        (rows(&record["extractedPages"]), vec![])
    };
    process_question(
        store, model, record, q, value, &pages, &assets, &catalogue, cancel,
    )
}
