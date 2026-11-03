//! Two real requests after transcription: one candidate and one coverage review.
//! Components are explicit views of a single saved response, never invented
//! provider executions or claims of blind solving.
use super::*;

pub(super) fn is_run(store: &Store, record: &Value) -> AppResult<bool> {
    Ok(run_for(store, record)?["strategyVersion"] == VERSION)
}

pub(super) fn validate_configuration(model: &ModelClient) -> AppResult<()> {
    let settings = model.public_settings();
    for role in ["sourceParsing", "teachingGeneration", "teachingReview"] {
        let effective = &settings["effectiveImportRoles"][role];
        if effective["strategy"] != "explicit" || effective["configured"] != true {
            return Err(err(
                "import_model_not_configured",
                "请明确配置处理模型和复核模型并保存；新流程不会回退旧模型用途。",
            ));
        }
    }
    if settings["importRoles"]["sourceParsing"] != settings["importRoles"]["teachingGeneration"] {
        return Err(err(
            "import_processing_model_mismatch",
            "拆题和生成须使用同一处理模型，请在设置中统一处理模型并保存。",
        ));
    }
    model.import_source_model()?;
    model.import_generator()?;
    model.import_teaching_reviewer()?;
    Ok(())
}

pub(super) fn strategy_snapshot(model: &ModelClient) -> AppResult<Value> {
    validate_configuration(model)?;
    let settings = model.public_settings();
    let role_settings = json!({"sourceParsing":settings["effectiveImportRoles"]["sourceParsing"],"teachingGeneration":settings["effectiveImportRoles"]["teachingGeneration"],"teachingReview":settings["effectiveImportRoles"]["teachingReview"]});
    let bindings = json!({"sourceParsing":model.import_source_model()?.import_execution_identity()?,"teachingGeneration":model.import_generator()?.import_execution_identity()?,"teachingReview":model.import_teaching_reviewer()?.import_execution_identity()?});
    let rubric: Value =
        serde_json::from_str(include_str!("../../../../resources/difficulty-rubric.json"))?;
    Ok(
        json!({"strategyVersion":VERSION,"pipelineVersion":ENGINE,"processSchemaVersion":1,"bindings":bindings,"roleSettings":role_settings,
        "policy":ModelClient::combined_accuracy_policy_snapshot(),"responseContracts":{"accuracy_combined_generation":[contracts::response_contract("combined_generation")],"accuracy_combined_verification":[contracts::response_contract("combined_verification")],"accuracy_combined_repair":[contracts::response_contract("combined_generation")]},
        "inputLimits":{"accuracy_combined_generation":160_000,"accuracy_combined_verification":160_000,"accuracy_combined_repair":160_000},
        "sourceProjection":"source-page-locations-v1","catalogueProjection":"accuracy-catalogue-columns-rows-v1","difficultyRubric":rubric,"evidenceReuse":"exact-inputs-accepted-artifacts-v1","unknownUsagePolicy":"retain-reservation-continue-other-questions-v1",
        "stages":["generation","verification"],"composition":"combined-solution-metadata-v1","independentBlindSolve":false,"maxRepairsPerQuestion":1,"selfConfidenceGrantsEligibility":false}),
    )
}

fn component(reference: &Value, name: &str) -> Value {
    json!({"combinedResponse":reference,"component":name})
}

pub(super) fn component_from_payload(payload: &Value, name: &str) -> AppResult<Value> {
    if !matches!(
        name,
        "solution" | "metadata" | "source" | "math" | "teaching"
    ) || !payload["result"][name].is_object()
        || payload["result"][name]["questionId"] != payload["result"]["questionId"]
    {
        return Err(err(
            "accuracy_integrity",
            "合并响应的字段引用无效，未采用其他响应或伪造分域报告。",
        ));
    }
    let mut result = payload.clone();
    result["result"] = payload["result"][name].clone();
    Ok(result)
}

pub(super) fn component_payload(store: &Store, reference: &Value) -> AppResult<Value> {
    if reference.as_object().is_none_or(|object| object.len() != 2)
        || reference["combinedResponse"]
            .get("combinedResponse")
            .is_some()
    {
        return Err(err("accuracy_integrity", "合并响应引用结构无效。"));
    }
    component_from_payload(
        &store::artifact_payload(store, &reference["combinedResponse"])?,
        s(reference, "component"),
    )
}

fn exact_keys(value: &Value, expected: &[&str], q: &Value) -> AppResult<()> {
    if value.as_object().is_none_or(|object| {
        object.len() != expected.len() || expected.iter().any(|key| !object.contains_key(*key))
    }) || value["questionId"] != q["questionId"]
    {
        return Err(err(
            "accuracy_contract_invalid",
            "合并响应身份、必需字段或输出权限不符，未采用部分结果。",
        ));
    }
    Ok(())
}
fn validate_generation(q: &Value, value: &Value, catalogue: &Value) -> AppResult<()> {
    exact_keys(value, &["questionId", "solution", "metadata"], q)?;
    runner::validate_solution(q, &value["solution"])?;
    contracts::metadata(&value["metadata"], s(q, "questionId"), catalogue)
}
fn validate_review(q: &Value, value: &Value) -> AppResult<()> {
    exact_keys(value, &["questionId", "source", "math", "teaching"], q)?;
    for domain in ["source", "math", "teaching"] {
        contracts::report(&value[domain], s(q, "questionId"), &targets(q, domain))?;
        if rows(&value[domain]["disagreements"]).iter().any(|entry| {
            matches!(
                s(entry, "classification"),
                "independent_defect" | "both_defective"
            )
        }) {
            return Err(err(
                "accuracy_contract_invalid",
                "两模型策略未执行独立盲解，不能采用声称独立解有误的报告。",
            ));
        }
    }
    runner::validate_source_report(q, &value["source"])
}

fn crop_images(q: &Value, assets: &[Value]) -> AppResult<Vec<Value>> {
    let mut images = runner::images_for_group(q, assets, "student")?;
    images.extend(runner::images_for_group(q, assets, "teacher")?);
    Ok(images)
}
fn review_material(
    record: &Value,
    q: &Value,
    pages: &[Value],
    assets: &[Value],
) -> AppResult<(Vec<Value>, Vec<Value>)> {
    let selected = rows(&q["pages"]);
    let selected_page = |page: &Value| {
        selected.is_empty()
            || selected
                .iter()
                .any(|p| p == &page["page"] || p["page"] == page["page"])
    };
    let actual_pages: Vec<_> = pages
        .iter()
        .enumerate()
        .map(|(index, page)| {
            if page.is_string() {
                json!({"page":index+1,"text":page})
            } else {
                page.clone()
            }
        })
        .filter(selected_page)
        .map(|page| {
            if record["ocrSource"].is_object() {
                runner::source_page_locations(&page, q)
            } else {
                page
            }
        })
        .collect();
    let mut images: Vec<_> = assets
        .iter()
        .filter(|a| a["role"] == "source_page" && selected_page(a))
        .cloned()
        .collect();
    if record["ocrSource"].is_object()
        && (actual_pages.is_empty()
            || actual_pages
                .iter()
                .any(|page| !images.iter().any(|image| image["page"] == page["page"])))
    {
        return Err(err(
            "accuracy_images_required",
            "合并复核所需实际原页不完整，未用OCR或裁图替代。",
        ));
    }
    images.extend(crop_images(q, assets)?);
    Ok((actual_pages, images))
}
fn image_refs(images: &[Value]) -> Value {
    json!(
        images
            .iter()
            .map(|a| json!({"assetId":a["id"],"sha256":a["sha256"],"role":a["role"]}))
            .collect::<Vec<_>>()
    )
}
fn generation_context(q: &Value, catalogue: &Value) -> Value {
    json!({"questionId":q["questionId"],"student":student(q),"originalReference":source_input(q)["originalReference"],"catalogue":super::catalogue::model_input(catalogue),"responseContract":contracts::response_contract("combined_generation")})
}
fn review_context(
    record: &Value,
    q: &Value,
    generation: &Value,
    candidate: &Value,
    catalogue: &Value,
    pages: &[Value],
) -> Value {
    json!({"questionId":q["questionId"],"sourceCandidate":source_input(q),"student":student(q),"solution":generation["solution"],"metadata":generation["metadata"],"candidate":candidate,"catalogue":super::catalogue::model_input(catalogue),"originalPages":pages,"requiresImages":record["ocrSource"].is_object(),"generationSha256":hash_json(generation),"independentBlindSolve":false,"requiredTargets":{"source":targets(q,"source"),"math":targets(q,"math"),"teaching":targets(q,"teaching")},"responseContract":contracts::response_contract("combined_verification")})
}
fn request_inputs(q: &Value, context: &Value, images: &[Value]) -> Value {
    json!({"sourceSha256":source_sha(q),"contextSha256":hash_json(context),"assets":image_refs(images)})
}

fn request(
    store: &Store,
    model: &ModelClient,
    record: &Value,
    q: &Value,
    state: &mut Value,
    key: &str,
    role: &str,
    task: &str,
    context: &Value,
    images: &[Value],
    catalogue: &Value,
    cancel: &AtomicBool,
) -> AppResult<Value> {
    let inputs = request_inputs(q, context, images);
    if !state[key].is_null() {
        let envelope = store::get_artifact(store, &state[key])?;
        if envelope["inputs"] == inputs {
            return Ok(envelope["payload"].clone());
        }
    }
    cancelled(cancel)?;
    mutate_run(store, record, |run| {
        run["progress"]["stage"] = json!(key);
        run["status"] = json!("running");
    })?;
    let response = model_call(
        store,
        record,
        &runner::frozen_model(store, record, model, role)?,
        task,
        role,
        s(q, "questionId"),
        context,
        images,
        cancel,
    )?;
    if key == "verification" {
        validate_review(q, &response["result"])?;
    } else {
        validate_generation(q, &response["result"], catalogue)?;
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
    let qid = s(q, "questionId");
    if value["sourceCandidate"].is_null() {
        value["sourceCandidate"] = store::put_artifact(
            store,
            s(record, "accuracyRunId"),
            "source_candidate",
            qid,
            &json!({"sha256":source_sha(q)}),
            &source_input(q),
        )?;
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
        for key in [
            "generation",
            "verification",
            "solution",
            "metadata",
            "source",
            "math",
            "teaching",
            "composition",
            "mathManual",
            "teachingManual",
            "generationOrigin",
        ] {
            value[key] = Value::Null;
        }
    }
    let (actual_pages, review_images) = review_material(record, q, pages, assets)?;
    let images = crop_images(q, assets)?;
    let generated = if value["generationOrigin"] == "repair" {
        artifact(store, &value["generation"])?
    } else {
        request(
            store,
            model,
            record,
            q,
            value,
            "generation",
            "teachingGeneration",
            "accuracy_combined_generation",
            &generation_context(q, catalogue),
            &images,
            catalogue,
            cancel,
        )?
    };
    validate_generation(q, &generated["result"], catalogue)?;
    value["solution"] = component(&value["generation"], "solution");
    value["metadata"] = component(&value["generation"], "metadata");
    let candidate = runner::compose(
        q,
        &generated["result"]["solution"],
        &generated["result"]["metadata"],
    )?;
    value["composition"] = store::put_artifact(
        store,
        s(record, "accuracyRunId"),
        "composition",
        qid,
        &json!({"generation":value["generation"],"catalogue":value["catalogue"],"sourceSha256":source_sha(q)}),
        &json!({"candidate":candidate,"fieldOrigins":{"answer":value["solution"],"teachingSolution":value["solution"],"difficultyAssessment":value["metadata"],"teachingFocus":value["metadata"]}}),
    )?;
    save_state(store, record, q, value)?;
    request(
        store,
        model,
        record,
        q,
        value,
        "verification",
        "teachingReview",
        "accuracy_combined_verification",
        &review_context(
            record,
            q,
            &generated["result"],
            &candidate,
            catalogue,
            &actual_pages,
        ),
        &review_images,
        catalogue,
        cancel,
    )?;
    for domain in ["source", "math", "teaching"] {
        value[domain] = component(&value["verification"], domain);
    }
    value["lastError"] = Value::Null;
    save_state(store, record, q, value)
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
    if value["repairCalls"].as_u64().unwrap_or(0) > 0 || value["generation"].is_null() {
        return Err(err(
            "accuracy_repair_exhausted",
            "本题的一次显式修订已使用或没有完整候选。",
        ));
    }
    if !good(&checked_report(store, value, "source")?) {
        return Err(err(
            "review_required",
            "请先核对或修正原题来源；候选修订不能改写原卷。",
        ));
    }
    let catalogue = applicable_catalogue(store, record)?;
    let previous = artifact(store, &value["generation"])?;
    let metadata_only = good(&checked_report(store, value, "math")?);
    let context = json!({"questionId":q["questionId"],"student":student(q),"originalReference":source_input(q)["originalReference"],"candidate":previous["result"],"concreteProblem":basis,"scope":if metadata_only{"metadata"}else{"solution_and_metadata"},"lockedSolution":if metadata_only{previous["result"]["solution"].clone()}else{Value::Null},"catalogue":super::catalogue::model_input(&catalogue),"responseContract":contracts::response_contract("combined_generation")});
    let (pages, assets) = if record["ocrSource"].is_object() {
        let doc = paddle::load_document(store, record)?;
        (doc.pages, doc.assets)
    } else {
        (rows(&record["extractedPages"]), vec![])
    };
    let images = crop_images(q, &assets)?;
    let before = run_for(store, record)?["budgetState"]["usedCalls"].clone();
    value["repairCalls"] = json!(1);
    save_state(store, record, q, value)?;
    let response = model_call(
        store,
        record,
        &runner::frozen_model(store, record, model, "teachingReview")?,
        "accuracy_combined_repair",
        "teachingReview",
        s(q, "questionId"),
        &context,
        &images,
        cancel,
    );
    if response.is_err() && run_for(store, record)?["budgetState"]["usedCalls"] == before {
        value["repairCalls"] = json!(0);
        save_state(store, record, q, value)?;
    }
    let response = response?;
    validate_generation(q, &response["result"], &catalogue)?;
    if metadata_only && response["result"]["solution"] != previous["result"]["solution"] {
        return Err(err(
            "accuracy_repair_scope_violation",
            "本次只授权修订教学信息，已核对的答案与解析发生变化；原稿保留，未采用越权修订。",
        ));
    }
    value["repairOriginal"] = value["generation"].clone();
    value["generation"] = store::put_artifact(
        store,
        s(record, "accuracyRunId"),
        "combined_repair",
        s(q, "questionId"),
        &json!({"sourceSha256":source_sha(q),"prior":value["repairOriginal"],"problem":basis}),
        &response,
    )?;
    value["generationOrigin"] = json!("repair");
    for key in [
        "verification",
        "source",
        "math",
        "teaching",
        "mathManual",
        "teachingManual",
        "composition",
        "lastError",
    ] {
        value[key] = Value::Null;
    }
    save_state(store, record, q, value)?;
    process_question(
        store, model, record, q, value, &pages, &assets, &catalogue, cancel,
    )
}

pub(super) fn verify_question(store: &Store, record: &Value, q: &Value) -> AppResult<()> {
    let value = state(store, record, q)?;
    if artifact(store, &value["sourceCandidate"])? != source_input(q) {
        return Err(err("accuracy_integrity", "来源候选不能重放。"));
    }
    let catalogue = artifact(store, &value["catalogue"])?;
    let generation = projection::verify_execution_artifact(store, &value["generation"])?;
    validate_generation(q, &generation["result"], &catalogue)?;
    let verification = projection::verify_execution_artifact(store, &value["verification"])?;
    if !verification.is_null() {
        validate_review(q, &verification["result"])?;
    }
    if generation["_requestTask"] != "accuracy_combined_generation"
        && generation["_requestTask"] != "accuracy_combined_repair"
        || !verification.is_null()
            && verification["_requestTask"] != "accuracy_combined_verification"
    {
        return Err(err(
            "accuracy_integrity",
            "合并策略未引用真实的处理与复核执行。",
        ));
    }
    for name in ["solution", "metadata"] {
        if value[name] != component(&value["generation"], name) {
            return Err(err(
                "accuracy_integrity",
                "处理字段没有引用同一真实合并响应。",
            ));
        }
    }
    for name in ["source", "math", "teaching"] {
        if !verification.is_null() && value[name] != component(&value["verification"], name)
            || verification.is_null()
                && (!value[name].is_null()
                    || checked_report(store, &value, name)?["status"] != "teacher_reviewed")
        {
            return Err(err(
                "accuracy_integrity",
                "分域报告没有真实合并复核响应或对应教师实质核对凭据。",
            ));
        }
    }
    if !value["independent"].is_null() {
        return Err(err("accuracy_integrity", "两模型策略不能借用旧盲解身份。"));
    }
    let (pages, assets) = if record["ocrSource"].is_object() {
        let doc = paddle::load_document(store, record)?;
        (doc.pages, doc.assets)
    } else {
        (rows(&record["extractedPages"]), vec![])
    };
    let (actual_pages, review_images) = review_material(record, q, &pages, &assets)?;
    if generation["inputAssets"] != image_refs(&crop_images(q, &assets)?)
        || !verification.is_null() && verification["inputAssets"] != image_refs(&review_images)
    {
        return Err(err(
            "accuracy_integrity",
            "合并请求未投递本题完整且正确版本的实际素材。",
        ));
    }
    let candidate = runner::compose(
        q,
        &generation["result"]["solution"],
        &generation["result"]["metadata"],
    )?;
    if artifact(store, &value["composition"])?["candidate"] != candidate
        || !verification.is_null()
            && verification["_requestContext"]
                != review_context(
                    record,
                    q,
                    &generation["result"],
                    &candidate,
                    &catalogue,
                    &actual_pages,
                )
    {
        return Err(err(
            "accuracy_integrity",
            "合并复核与本次原题、候选、目录或原页不一致。",
        ));
    }
    if generation["_requestTask"] == "accuracy_combined_generation" {
        if generation["_requestContext"] != generation_context(q, &catalogue) {
            return Err(err(
                "accuracy_integrity",
                "合并处理未绑定本次题面、原参考与目录。",
            ));
        }
    } else {
        let original = projection::verify_execution_artifact(store, &value["repairOriginal"])?;
        let context = &generation["_requestContext"];
        if value["repairCalls"] != 1
            || context["candidate"] != original["result"]
            || context["student"] != student(q)
            || context["originalReference"] != source_input(q)["originalReference"]
            || context["catalogue"] != super::catalogue::model_input(&catalogue)
            || s(context, "concreteProblem").trim().chars().count() < 8
            || !matches!(s(context, "scope"), "metadata" | "solution_and_metadata")
            || context["scope"] == "metadata"
                && (context["lockedSolution"] != original["result"]["solution"]
                    || generation["result"]["solution"] != original["result"]["solution"])
        {
            return Err(err(
                "accuracy_integrity",
                "显式修订的候选、具体问题或权限不能重放。",
            ));
        }
    }
    for domain in ["source", "math", "teaching"] {
        if !value[format!("{domain}Manual")].is_null() {
            let report = checked_report(store, &value, domain)?;
            if report["sourceSha256"] != source_sha(q)
                || report["domainCandidateSha256"] != domain_candidate_sha(store, &value, domain)?
                || report["checkedBy"] != "teacher"
                || s(&report, "basis").trim().is_empty()
                || rows(&report["checks"]).len() != review_targets(q, &value, domain).len()
                || review_targets(q, &value, domain).iter().any(|target| {
                    rows(&report["checks"])
                        .iter()
                        .filter(|check| {
                            check["target"] == *target
                                && check["status"] == "checked"
                                && !s(check, "basis").trim().is_empty()
                        })
                        .count()
                        != 1
                })
            {
                return Err(err(
                    "accuracy_integrity",
                    "人工实质核对已因候选或发布范围变化失效。",
                ));
            }
        }
    }
    Ok(())
}
