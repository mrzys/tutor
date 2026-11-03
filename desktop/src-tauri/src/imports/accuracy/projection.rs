use super::*;

pub(super) fn candidate_sha(store: &Store, value: &Value) -> AppResult<Value> {
    let composed = artifact(store, &value["composition"])?;
    if composed["candidate"].is_object() {
        Ok(json!(hash_json(&composed["candidate"])))
    } else {
        let solution = artifact(store, &value["solution"])?;
        Ok(if solution.is_null() {
            Value::Null
        } else {
            json!(hash_json(&solution["result"]))
        })
    }
}
fn domain_view(report: &Value) -> Value {
    json!({"status":report.get("status").cloned().unwrap_or(json!("pending")),"basis":report["basis"],"checks":report["checks"],"disagreements":report["disagreements"],"reason":if good(report){if report["status"]=="teacher_reviewed"{"教师已记录实质核对依据"}else{"模型核对未发现问题"}.to_owned()}else{rows(&report["findings"]).first().map(|f|s(f,"message").to_owned()).unwrap_or_else(||if report.is_null(){"尚未完成核对".into()}else{"仍有未判或待处理项目".into()})}})
}
pub(crate) fn project_record(store: &Store, record: &Value) -> AppResult<Value> {
    if s(record, "accuracyRunId").is_empty() {
        return Ok(record.clone());
    }
    let run = run_for(store, record)?;
    let mut result = record.clone();
    for q in result["questions"].as_array_mut().into_iter().flatten() {
        q.as_object_mut().unwrap().remove("teachingWorkflow");
        q.as_object_mut().unwrap().remove("modelReview");
        let value = state(store, record, q)?;
        let source = checked_report(store, &value, "source")?;
        let math = checked_report(store, &value, "math")?;
        let teaching = checked_report(store, &value, "teaching")?;
        let composition = artifact(store, &value["composition"])?;
        let solution = artifact(store, &value["solution"])?;
        let metadata = artifact(store, &value["metadata"])?;
        if metadata["result"].is_object() {
            for key in [
                "primaryKnowledgeUids",
                "solutionPaths",
                "task",
                "difficultyAssessment",
            ] {
                q[key] = metadata["result"][key].clone();
            }
            q["knowledgeSchemaVersion"] = json!(2);
        }
        let mut findings = vec![];
        for report in [&source, &math, &teaching] {
            findings.extend(rows(&report["findings"]));
        }
        if value["lastError"].is_object() {
            findings.push(json!({"id":"technical_failure","domain":"process","message":value["lastError"]["message"],"basis":value["lastError"]["code"]}));
        }
        let ready = eligible(store, record, q)?;
        let already_published =
            ids(&record["publishedQuestionIds"]).contains(&s(q, "questionId").to_owned());
        let candidate = if composition["candidate"].is_object() {
            composition["candidate"].clone()
        } else if solution["result"].is_object() {
            json!({"answer":solution["result"]["answer"],"teachingSolution":solution["result"]["solution"]})
        } else {
            Value::Null
        };
        let can_review = !already_published && !s(q,"stem").trim().is_empty();
        // Match the action handler's material prerequisites. An unfinished
        // domain is not reviewable until its actual candidate exists; the
        // handler still revalidates versions, evidence and publication locks.
        let reviewable_domains: Vec<_> = [("source", true), ("math", !value["solution"].is_null()),
            ("teaching", !value["composition"].is_null())].into_iter()
            .filter_map(|(domain, available)| (can_review && available).then_some(domain)).collect();
        q["accuracy"] = json!({"strategyVersion":run["strategyVersion"],"status":if already_published{"published"}else if ready{"ready"}else if run["status"]=="budget_paused"{"budget_paused"}else{"needs_review"},"stage":run["progress"]["stage"],"source":domain_view(&source),"mathematics":domain_view(&math),"teaching":domain_view(&teaching),"findings":findings,"candidate":candidate,"sourceSha256":source_sha(q),"candidateSha256":candidate_sha(store,&value)?,"canReview":can_review,"reviewableDomains":reviewable_domains,"canRepair":!already_published&&run["status"]!="budget_paused"&&value["repairCalls"].as_u64().unwrap_or(0)==0&&!value["solution"].is_null(),"budget":aggregate_budget(store,&run)?,"catalogue":artifact(store,&value["catalogue"])?,"publicationScope":scope::publication_scope(&value)});
        // This is a view of a real source verification, not a legacy self-check.
        let evidence_ref = ["source", "teaching", "math", "metadata"]
            .iter()
            .find_map(|key| (!value[*key].is_null()).then(|| value[*key].clone()));
        if let Some(reference) = evidence_ref {
            let envelope = artifact(store, &reference)?;
            q["modelReview"] = json!({"status":if ready||already_published{"ready"}else{"needs_review"},"confidence":envelope["result"]["confidence"],"summary":if ready||already_published{"实际发布范围已取得有效核对记录"}else{"准确性流程尚有待处理项目"},"issues":if ready||already_published{vec![]}else{findings},"model":envelope["model"],"audit":{"sha256":envelope["audit"]["responseSha256"],"relativePath":envelope["audit"]["responseRelativePath"]}});
        }
    }
    Ok(result)
}
pub(crate) fn detail_version(store: &Store, record: &Value, legacy: &str) -> AppResult<String> {
    if s(record, "accuracyRunId").is_empty() {
        return Ok(legacy.into());
    }
    let run = run_for(store, record)?;
    Ok(hash_json(
        &json!({"document":legacy,"runId":run["id"],"revision":run["revision"],"strategySha256":run["strategySha256"]}),
    ))
}
pub(crate) fn eligible(store: &Store, record: &Value, q: &Value) -> AppResult<bool> {
    if s(q, "reviewDecision") == "reject"
        || ids(&record["publishedQuestionIds"]).contains(&s(q, "questionId").to_owned())
        || rows(&q["duplicateCandidates"])
            .iter()
            .any(|c| c["exact"] == true)
    {
        return Ok(false);
    }
    if !question_issues(q, &record["sourceIssues"]).is_empty()
        || teaching::verify_source_material(q).is_err()
    {
        return Ok(false);
    }
    let value = state(store, record, q)?;
    if value.is_null() || value["composition"].is_null() || value["lastError"].is_object() {
        return Ok(false);
    }
    let math_report = checked_report(store, &value, "math")?;
    if super::two_model::is_run(store, record)? && scope::publication_scope(&value) == "source_only"
        && (!good(&math_report) || targets(q,"math").iter().any(|target| rows(&math_report["checks"]).iter().filter(|check| check["target"] == *target && check["status"] == "checked" && !s(check,"basis").trim().is_empty()).count() != 1)) {
        // Merged metadata was generated together with the proposed solution.
        // Withholding that text cannot publish its still-dependent paths or
        // difficulty before math (or full concrete teacher evidence) is sound.
        return Ok(false);
    }
    if !scope::eligible_reports(
        q,
        &value,
        &checked_report(store, &value, "source")?,
        &checked_report(store, &value, "math")?,
        &checked_report(store, &value, "teaching")?,
    ) {
        return Ok(false);
    }
    let snapshot = artifact(store, &value["catalogue"])?;
    if snapshot != applicable_catalogue(store, record)? {
        return Ok(false);
    }
    Ok(true)
}
fn read_bound(store: &Store, relative: &str, expected: &str) -> AppResult<Value> {
    let path = store.data_dir.join(relative).canonicalize()?;
    if !path.starts_with(store.data_dir.join("imports").canonicalize()?) {
        return Err(err("accuracy_integrity", "核验审计路径越界。"));
    }
    let bytes = std::fs::read(&path)?;
    if sha(&bytes) != expected {
        return Err(err(
            "accuracy_integrity",
            "原始模型审计内容已变化，未发布。",
        ));
    }
    Ok(serde_json::from_slice(&bytes)?)
}
pub(super) fn verify_execution_artifact(store: &Store, reference: &Value) -> AppResult<Value> {
    if reference.is_null() {
        return Ok(Value::Null);
    }
    if reference.get("combinedResponse").is_some() {
        let parent = verify_execution_artifact(store, &reference["combinedResponse"])?;
        return super::two_model::component_from_payload(&parent, s(reference, "component"));
    }
    let envelope = store::get_artifact(store, reference)?;
    let mut payload = envelope["payload"].clone();
    let audit = &payload["audit"];
    let response = read_bound(
        store,
        s(audit, "responseRelativePath"),
        s(audit, "responseSha256"),
    )?;
    let request = read_bound(
        store,
        s(audit, "requestRelativePath"),
        s(audit, "requestFileSha256"),
    )?;
    let execution = store::load_execution(store, s(audit, "executionId"))?;
    let run = store::load_run(store, s(&execution, "runId"))?;
    let task = s(&request, "task");
    let role = match task {
        "accuracy_source_verification" => "sourceVerification",
        "accuracy_solution_generation" | "accuracy_teaching_generation" => "teachingGeneration",
        "accuracy_independent_solve" => "independentSolve",
        "accuracy_math_verification" => "mathVerification",
        "accuracy_teaching_verification" => "teachingVerification",
        "accuracy_repair" => "teachingReview",
        "accuracy_combined_generation" => "teachingGeneration",
        "accuracy_combined_verification" | "accuracy_combined_repair" => "teachingReview",
        _ => "",
    };
    if role.is_empty()
        || execution["role"] != role
        || envelope["runId"] != execution["runId"]
        || envelope["questionId"] != execution["questionId"]
        || execution["questionId"] != payload["result"]["questionId"]
        || request["body"]["messages"][0]["content"]
            != run["strategy"]["policy"]["tasks"][task]["instruction"]
        || request["timeoutSeconds"] != run["strategy"]["policy"]["tasks"][task]["timeoutSeconds"]
    {
        return Err(err(
            "accuracy_integrity",
            "实际执行角色、题目或任务合同与冻结策略不一致。",
        ));
    }
    if execution["status"] != "completed"
        || request["bodySha256"] != hash_json(&request["body"])
        || request["bodySha256"] != audit["requestSha256"]
        || execution["requestSha256"] != request["bodySha256"]
        || response["completeHttpBody"] != true
        || response["response"]["choices"][0]["finish_reason"] != "stop"
    {
        return Err(err(
            "accuracy_integrity",
            "请求、执行及响应凭据不一致，未发布。",
        ));
    }
    let value = ModelClient::replay_accuracy_output(&response["response"])?;
    if value != payload["result"] {
        return Err(err(
            "accuracy_integrity",
            "采用的候选与原始响应不一致，未发布。",
        ));
    }
    let content = &request["body"]["messages"][1]["content"];
    let mut delivered = vec![];
    for block in rows(content) {
        if block["type"] == "image_url" {
            let url = s(&block["image_url"], "url");
            let encoded = url
                .strip_prefix("data:")
                .and_then(|value| value.split_once(";base64,").map(|(_, encoded)| encoded))
                .ok_or_else(|| err("accuracy_integrity", "核对图像不是保存的实际数据。"))?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| err("accuracy_integrity", "实际请求图像已损坏。"))?;
            delivered.push(json!(sha(&bytes)));
        }
    }
    let claimed: Vec<_> = rows(&payload["inputAssets"])
        .iter()
        .map(|asset| asset["sha256"].clone())
        .collect();
    if delivered != claimed {
        return Err(err(
            "accuracy_integrity",
            "实际图像请求与采用的素材证据不一致。",
        ));
    }
    let text = content
        .as_str()
        .or_else(|| content[0]["text"].as_str())
        .ok_or_else(|| err("accuracy_integrity", "缺少真实模型输入正文。"))?;
    payload["_requestContext"] = serde_json::from_str(text)?;
    if payload["_requestContext"]["questionId"] != execution["questionId"] {
        return Err(err(
            "accuracy_integrity",
            "实际请求的题目身份与采用候选不一致。",
        ));
    }
    payload["_requestTask"] = request["task"].clone();
    Ok(payload)
}
pub(crate) fn verify_question(store: &Store, record: &Value, q: &Value) -> AppResult<()> {
    if !eligible(store, record, q)? {
        return Err(err(
            "review_required",
            "题目实际发布内容尚未完成有效核对，不能靠确认按钮绕过。",
        ));
    }
    read_source(store, record)?;
    paddle::verify_audit(store, record)?;
    if super::two_model::is_run(store, record)? {
        return super::two_model::verify_question(store, record, q);
    }
    let value = state(store, record, q)?;
    if artifact(store, &value["sourceCandidate"])? != source_input(q) {
        return Err(err("accuracy_integrity", "来源候选不能重放。"));
    }
    let source = verify_execution_artifact(store, &value["source"])?;
    if !source.is_null() {
        if source["_requestContext"]["candidate"] != source_input(q) {
            return Err(err(
                "accuracy_integrity",
                "来源核对未绑定当前题面与原参考。",
            ));
        }
        runner::validate_source_report(q, &source["result"])?;
        let crops:Vec<_>=["student","teacher"].iter().flat_map(|group|rows(&q[*group]["assets"]).into_iter().map(|asset|json!({"assetId":asset["assetId"],"sha256":asset["sha256"],"role":group})).collect::<Vec<_>>()).collect();
        let delivered = rows(&source["inputAssets"]);
        if crops
            .iter()
            .any(|crop| delivered.iter().filter(|asset| *asset == crop).count() != 1)
            || delivered
                .iter()
                .filter(|asset| asset["role"] != "source_page")
                .count()
                != crops.len()
        {
            return Err(err(
                "accuracy_integrity",
                "来源核对没有实际查看每张学生裁图及原参考裁图。",
            ));
        }
        if record["ocrSource"].is_object() {
            let doc = paddle::load_document(store, record)?;
            let pages = rows(&q["pages"]);
            let mut expected:Vec<_>=doc.assets.iter().filter(|asset|asset["role"]=="source_page"&&(pages.is_empty()||pages.iter().any(|page|page==&asset["page"]||page["page"]==asset["page"]))).map(|asset|json!({"assetId":asset["id"],"sha256":asset["sha256"],"role":"source_page"})).collect();
            expected.extend(crops);
            if delivered != expected {
                return Err(err(
                    "accuracy_integrity",
                    "来源核对实际原页或裁图与当前来源清单不一致。",
                ));
            }
        }
    }
    for (key, domain) in [
        ("source", "source"),
        ("math", "math"),
        ("teaching", "teaching"),
    ] {
        let payload = verify_execution_artifact(store, &value[key])?;
        if !payload.is_null() {
            contracts::report(&payload["result"], s(q, "questionId"), &targets(q, domain))?;
        }
        if !value[format!("{domain}Manual")].is_null() {
            let report = checked_report(store, &value, domain)?;
            if report["sourceSha256"] != source_sha(q)
                || report["domainCandidateSha256"] != domain_candidate_sha(store, &value, domain)?
                || s(&report, "basis").trim().is_empty()
                || report["checkedBy"] != "teacher"
                || rows(&report["checks"]).len() != review_targets(q, &value, domain).len()
                || review_targets(q, &value, domain).iter().any(|target| {
                    rows(&report["checks"])
                        .iter()
                        .filter(|c| {
                            c["target"] == *target
                                && c["status"] == "checked"
                                && !s(c, "basis").trim().is_empty()
                        })
                        .count()
                        != 1
                })
            {
                return Err(err("accuracy_integrity", "人工核对已因候选变化失效。"));
            }
        } else if payload.is_null() {
            return Err(err("accuracy_integrity", "发布领域缺少实际核对凭据。"));
        }
    }
    let solution = verify_execution_artifact(store, &value["solution"])?;
    runner::validate_solution(q, &solution["result"])?;
    let independent = verify_execution_artifact(store, &value["independent"])?;
    if !independent.is_null() {
        runner::validate_solution(q, &independent["result"])?;
    } else if checked_report(store, &value, "math")?["status"] != "teacher_reviewed" {
        return Err(err(
            "accuracy_integrity",
            "没有隔离求解或实际人工数学核对。",
        ));
    }
    let metadata = verify_execution_artifact(store, &value["metadata"])?;
    let snapshot = artifact(store, &value["catalogue"])?;
    contracts::metadata(&metadata["result"], s(q, "questionId"), &snapshot)?;
    let model_catalogue = if value["catalogueModelInput"].is_null() {
        snapshot.clone()
    } else {
        let projected = artifact(store, &value["catalogueModelInput"])?;
        if projected != catalogue::model_input(&snapshot) {
            return Err(err(
                "accuracy_integrity",
                "模型目录投影不能由完整目录快照重放。",
            ));
        }
        projected
    };
    let composed = artifact(store, &value["composition"])?;
    if composed["candidate"] != runner::compose(q, &solution["result"], &metadata["result"])? {
        return Err(err("accuracy_integrity", "定稿字段组合无法重放。"));
    }
    let mut blind_student = student(q);
    let student_assets: Vec<_> = rows(&q["student"]["assets"])
        .iter()
        .map(|asset| json!({"assetId":asset["assetId"],"sha256":asset["sha256"],"role":"student"}))
        .collect();
    let mut with_reference = student_assets.clone();
    with_reference.extend(rows(&q["teacher"]["assets"]).iter().map(
        |asset| json!({"assetId":asset["assetId"],"sha256":asset["sha256"],"role":"teacher"}),
    ));
    if solution["inputAssets"]
        != json!(if solution["_requestTask"] == "accuracy_repair" {
            student_assets.clone()
        } else {
            with_reference.clone()
        })
        || !independent.is_null() && independent["inputAssets"] != json!(student_assets.clone())
        || metadata["inputAssets"] != json!(student_assets.clone())
    {
        return Err(err(
            "accuracy_integrity",
            "求解、盲解或教学请求未投递各自完整且隔离的实际素材。",
        ));
    }
    for asset in blind_student["assets"].as_array_mut().into_iter().flatten() {
        *asset = json!({"assetId":asset["assetId"],"sha256":asset["sha256"]});
    }
    let blind = &independent["_requestContext"];
    if !independent.is_null()
        && (blind["student"] != blind_student
            || blind.as_object().is_none_or(|o| {
                o.len() != 3
                    || o.keys().any(|k| {
                        !matches!(k.as_str(), "questionId" | "student" | "responseContract")
                    })
            }))
    {
        return Err(err(
            "accuracy_integrity",
            "盲解实际输入不再满足学生材料隔离合同。",
        ));
    }
    for payload in [&solution, &metadata] {
        if payload["_requestContext"]["student"] != student(q) {
            return Err(err("accuracy_integrity", "生成稿不对应当前学生题面。"));
        }
    }
    let math = verify_execution_artifact(store, &value["math"])?;
    if !math.is_null() && math["inputAssets"] != json!(with_reference) {
        return Err(err(
            "accuracy_integrity",
            "数学核对没有收到完整学生图与原参考图。",
        ));
    }
    let context = &math["_requestContext"];
    if !math.is_null()
        && (context["student"] != student(q)
            || context["candidate"] != solution["result"]
            || context["independent"] != independent["result"]
            || context["originalReference"] != source_input(q)["originalReference"])
    {
        return Err(err(
            "accuracy_integrity",
            "数学核对绑定了其他版本的候选或参考。",
        ));
    }
    let context = &metadata["_requestContext"];
    if context["verifiedSolution"] != solution["result"] || context["catalogue"] != model_catalogue
    {
        return Err(err(
            "accuracy_integrity",
            "教学元数据未使用本次固定解法或目录快照。",
        ));
    }
    let teaching_report = verify_execution_artifact(store, &value["teaching"])?;
    if !teaching_report.is_null() && teaching_report["inputAssets"] != json!(student_assets) {
        return Err(err("accuracy_integrity", "教学核对没有收到完整学生图。"));
    }
    let context = &teaching_report["_requestContext"];
    if !teaching_report.is_null()
        && (context["candidate"] != composed["candidate"]
            || context["metadata"] != metadata["result"]
            || context["verifiedSolution"] != solution["result"]
            || context["catalogue"] != model_catalogue)
    {
        return Err(err("accuracy_integrity", "教学核对与实际定稿字段不一致。"));
    }
    Ok(())
}
pub(crate) fn apply_to_entry(
    store: &Store,
    record: &Value,
    q: &Value,
    raw: &Value,
    entry: &mut Value,
) -> AppResult<()> {
    verify_question(store, record, q)?;
    let value = state(store, record, q)?;
    if scope::publication_scope(&value) == "source_only" {
        entry.as_object_mut().unwrap().remove("teachingAnalysis");
        return Ok(());
    }
    let composition = artifact(store, &value["composition"])?;
    let candidate = &composition["candidate"];
    let metadata = artifact(store, &value["metadata"])?;
    let mut analysis = json!({"questionId":raw["questionId"],"baseContentVersion":raw["contentVersion"],"baseTeacherVersion":raw["teacherVersion"],"provenance":"llm_generated","model":metadata["model"]["model"],"promptSha256":metadata["audit"]["promptSha256"],"requestSha256":metadata["audit"]["requestSha256"],"operationId":record["importId"],"answer":candidate["answer"],"solution":candidate["teachingSolution"],"generatedAt":metadata["createdAt"],"status":"ready","issues":candidate["issues"],"teachingFocusSchemaVersion":2,"teachingFocus":candidate["teachingFocus"],"sourceQuestionId":candidate["questionId"],"sourceContentSha256":source_sha(q),"sourceCandidate":candidate});
    let digest = hash_json(&analysis);
    analysis["sha256"] = json!(digest);
    analysis["teachingVersion"] = json!(format!("teaching-{}", &digest[..16]));
    let mut checked = raw.clone();
    checked["teachingAnalysis"] = analysis.clone();
    crate::bank_teaching::verify_projection(&checked)?;
    entry["teachingAnalysis"] = analysis;
    Ok(())
}
pub(crate) fn verify_manifest(store: &Store, record: &Value, manifest: &Value) -> AppResult<()> {
    if build_accuracy_manifest_for_replay(store, record, manifest)? != *manifest {
        return Err(err(
            "accuracy_integrity",
            "冻结清单与当前核对版本重建结果不一致，未写入题库。",
        ));
    }
    let projected = project_record(store, record)?;
    let mut references = vec![];
    for raw in rows(&manifest["questions"]) {
        let q = rows(&projected["questions"])
            .into_iter()
            .find(|q| q["questionId"] == raw["questionId"])
            .ok_or_else(|| err("accuracy_integrity", "定稿包含未知题目。"))?;
        verify_question(store, record, &q)?;
        if raw["student"] != student(&q) {
            return Err(err("accuracy_integrity", "冻结题面与核对版本不一致。"));
        }
        let mut answers = vec![];
        let mut solutions = vec![];
        let provenance = if q["accuracy"]["source"]["status"] == "teacher_reviewed" {
            "teacher_review"
        } else {
            "model_review"
        };
        for (field, out) in [("answer", &mut answers), ("solution", &mut solutions)] {
            if !s(&q, field).is_empty() {
                out.push(json!({"partId":null,"text":q[field],"provenance":provenance}));
            }
            for part in rows(&q["parts"]) {
                if !s(&part, field).is_empty() {
                    out.push(
                        json!({"partId":part["partId"],"text":part[field],"provenance":provenance}),
                    );
                }
            }
        }
        let teacher = json!({"answers":answers,"solutions":solutions,"assets":q["teacher"].get("assets").cloned().unwrap_or(json!([])),"scoringSuggestions":[],"missingReferenceAnswer":answers.is_empty(),"missingReferenceSolution":solutions.is_empty()});
        if raw["teacher"] != teacher {
            return Err(err("accuracy_integrity", "冻结原参考与已核对来源不一致。"));
        }
        let entry = rows(&manifest["configPatch"]["assemblyIndex"]["entries"])
            .into_iter()
            .find(|e| e["questionId"] == q["questionId"])
            .ok_or_else(|| err("accuracy_integrity", "冻结题目缺少教学索引。"))?;
        let (annotation, _) =
            knowledge_annotation(&q, &store.bank.config()?, &trusted_catalog(store)?)?;
        for key in ["primaryKnowledgeUids", "primarySections", "solutionPaths"] {
            if entry[key] != annotation[key] {
                return Err(err(
                    "accuracy_integrity",
                    "冻结教学索引与核对元数据不一致。",
                ));
            }
        }
        let mut expected = entry.clone();
        apply_to_entry(store, record, &q, &raw, &mut expected)?;
        annotations::apply_difficulty(&mut expected, &q);
        for key in [
            "teachingAnalysis",
            "difficultyLevel",
            "difficultyBasis",
            "difficultyRubricVersion",
        ] {
            if expected[key] != entry[key] {
                return Err(err(
                    "accuracy_integrity",
                    "冻结教学内容或难度与核对版本不一致。",
                ));
            }
        }
        let value = state(store, record, &q)?;
        references.push(json!({"questionId":q["questionId"],"state":value}));
    }
    let proof = json!({"manifestSha256":hash_json(manifest),"questions":references,"catalogueSha256":hash_json(&applicable_catalogue(store,record)?)});
    store::save_finalization(
        store,
        s(record, "accuracyRunId"),
        &format!("{}-{}", s(record, "importId"), &hash_json(manifest)[..24]),
        &proof,
    )?;
    Ok(())
}
pub(crate) fn dispatch(
    store: &mut Store,
    model: &ModelClient,
    action: &str,
    payload: &Value,
    cancel: &AtomicBool,
) -> Option<AppResult<Value>> {
    if !matches!(
        action,
        "import_accuracy_review" | "import_accuracy_scope_save"
    ) {
        return None;
    }
    Some(action_impl(store, model, action, payload, cancel))
}
fn action_impl(
    store: &mut Store,
    model: &ModelClient,
    action: &str,
    payload: &Value,
    cancel: &AtomicBool,
) -> AppResult<Value> {
    let mut record = store.document("imports", s(payload, "importId"))?;
    if s(&record, "accuracyRunId").is_empty() {
        return Err(err("invalid_operation", "旧记录不能追认为准确性流程。"));
    }
    if matches!(s(&record["backgroundJob"], "status"), "running" | "queued") {
        return Err(err(
            "import_busy",
            "本次导入仍在处理，请完成或停止后再核对。",
        ));
    }
    let saved = record.clone();
    let op = operation(payload)?;
    let hash = hash_json(payload);
    if replay(&record, op, &hash)? {
        return Ok(json!({"import":record}));
    }
    revision(&record, payload)?;
    if record["pendingPublication"].is_object() {
        return Err(err(
            "publication_pending",
            "本次发布清单已冻结，请先完成该发布操作。",
        ));
    }
    let q = rows(&record["questions"])
        .into_iter()
        .find(|q| q["questionId"] == payload["questionId"])
        .ok_or_else(|| err("not_found", "未找到题目。"))?;
    if ids(&record["publishedQuestionIds"]).contains(&s(&q, "questionId").to_owned()) {
        return Err(err(
            "already_published",
            "已入库版本已冻结，不能修改它的核对记录或发布范围。",
        ));
    }
    let mut value = state(store, &record, &q)?;
    if payload["sourceSha256"] != source_sha(&q)
        || payload["candidateSha256"] != candidate_sha(store, &value)?
    {
        return Err(err(
            "revision_conflict",
            "核对的题面或候选已更新，请重新读取；已有输入未提交。",
        ));
    }
    let basis = s(payload, "basis").trim();
    if action == "import_accuracy_scope_save" {
        let scope = s(payload, "publicationScope");
        if payload["acknowledge"] != true || !matches!(scope, "source_only" | "source_and_teaching")
        {
            return Err(err("invalid_operation", "请明确选择实际发布内容范围。"));
        }
        value["publicationScope"] = json!(scope);
        save_state(store, &record, &q, &value)?;
        finish(&mut record, op, &hash, "accuracy_scope");
        save_cas(store, Some(&saved), &record)?;
        return Ok(json!({"import":project_record(store,&record)?}));
    }
    if basis.chars().count() < 8 || basis.chars().count() > 4000 {
        return Err(err(
            "review_basis_required",
            "请填写具体核对依据或需要修订的问题（8–4000字）。",
        ));
    }
    if action == "import_accuracy_repair_start" {
        runner::repair(store, model, &record, &q, &mut value, basis, cancel)?;
    } else {
        let domain = s(payload, "domain");
        if !matches!(domain, "source" | "math" | "teaching") || payload["acknowledge"] != true {
            return Err(err("review_required", "请明确核对领域并确认已实际检查。"));
        }
        if domain == "math" && value["solution"].is_null()
            || domain == "teaching" && value["composition"].is_null()
        {
            return Err(err(
                "review_required",
                "本领域尚无可实际核对的完整候选，不能确认未展示的内容。",
            ));
        }
        let presence = |field: &str| {
            if !s(&q, field).trim().is_empty()
                || rows(&q["parts"])
                    .iter()
                    .any(|p| !s(p, field).trim().is_empty())
            {
                "present"
            } else {
                "absent"
            }
        };
        let disclosures:Vec<_>=["student","teacher"].iter().flat_map(|group|rows(&q[*group]["assets"]).into_iter().map(|asset|json!({"assetId":asset["assetId"],"role":if *group=="student"{"student_original"}else{"reference_only"},"basis":basis})).collect::<Vec<_>>()).collect();
        let report = json!({"questionId":q["questionId"],"domain":domain,"status":"teacher_reviewed","basis":basis,"checkedBy":"teacher","sourceSha256":source_sha(&q),"candidateSha256":candidate_sha(store,&value)?,"domainCandidateSha256":domain_candidate_sha(store,&value,domain)?,"supersedes":value[domain],"publicationScope":scope::publication_scope(&value),"checks":review_targets(&q,&value,domain).iter().map(|t|json!({"target":t,"status":"checked","basis":basis})).collect::<Vec<_>>(),"findings":[],"assetDisclosures":disclosures,"referencePresence":{"answer":presence("answer"),"solution":presence("solution")},"createdAt":now()});
        value[format!("{domain}Manual")] = store::put_artifact(
            store,
            s(&record, "accuracyRunId"),
            "teacher_report",
            s(&q, "questionId"),
            &json!({"sourceSha256":source_sha(&q),"candidateSha256":candidate_sha(store,&value)?}),
            &report,
        )?;
        save_state(store, &record, &q, &value)?;
        if value["lastError"].is_object() {
            value["lastError"] = Value::Null;
            save_state(store, &record, &q, &value)?;
        }
    }
    finish(
        &mut record,
        op,
        &hash,
        if action == "import_accuracy_review" {
            "accuracy_review"
        } else {
            "accuracy_repair"
        },
    );
    save_cas(store, Some(&saved), &record)?;
    Ok(json!({"import":project_record(store,&record)?}))
}
pub(crate) fn validate_action(store: &Store, record: &Value, payload: &Value) -> AppResult<()> {
    revision(record, payload)?;
    if s(record, "accuracyRunId").is_empty() {
        return Err(err("invalid_operation", "旧记录不能追认为准确性流程。"));
    }
    if run_for(store, record)?["status"] == "budget_paused" {
        return Err(err(
            "budget_paused",
            "本次预算已暂停；请先核对预算后继续，未使用修订额度。",
        ));
    }
    let q = rows(&record["questions"])
        .into_iter()
        .find(|q| q["questionId"] == payload["questionId"])
        .ok_or_else(|| err("not_found", "未找到题目。"))?;
    let value = state(store, record, &q)?;
    let frozen = artifact(store, &value["catalogue"])?;
    if ids(&record["publishedQuestionIds"]).contains(&s(&q, "questionId").to_owned()) {
        return Err(err("already_published", "已入库版本已冻结，不能继续修订。"));
    }
    if !frozen.is_null() && frozen != applicable_catalogue(store, record)? {
        return Err(err(
            "accuracy_catalogue_changed",
            "目录已更新，请先继续处理当前目录的教学信息，再决定是否修订。",
        ));
    }
    if payload["sourceSha256"] != source_sha(&q)
        || payload["candidateSha256"] != candidate_sha(store, &value)?
    {
        return Err(err(
            "revision_conflict",
            "题面或候选版本已变化，请重新读取。",
        ));
    }
    if value["repairCalls"].as_u64().unwrap_or(0) > 0 || value["solution"].is_null() {
        return Err(err(
            "accuracy_repair_exhausted",
            "本题没有可修订候选或一次修订额度已使用。",
        ));
    }
    let basis = s(payload, "basis").trim();
    if !(8..=4000).contains(&basis.chars().count()) {
        return Err(err(
            "review_basis_required",
            "请填写具体修订依据（8–4000字）。",
        ));
    }
    Ok(())
}
pub(crate) fn repair_job(
    store: &mut Store,
    model: &ModelClient,
    mut record: Value,
    cancel: &AtomicBool,
) -> AppResult<()> {
    let payload = record["backgroundJob"]["payload"].clone();
    let saved = record.clone();
    // The queue acceptance already checked the document revision. Recheck exact
    // domain inputs after the worker obtains its independent connection.
    let q = rows(&record["questions"])
        .into_iter()
        .find(|q| q["questionId"] == payload["questionId"])
        .ok_or_else(|| err("not_found", "修订题目已不存在。"))?;
    let mut value = state(store, &record, &q)?;
    if payload["sourceSha256"] != source_sha(&q)
        || payload["candidateSha256"] != candidate_sha(store, &value)?
    {
        return Err(err(
            "revision_conflict",
            "排队期间候选已变化，未调用修订模型。",
        ));
    }
    let result = runner::repair(
        store,
        model,
        &record,
        &q,
        &mut value,
        s(&payload, "basis"),
        cancel,
    );
    if let Err(error) = &result {
        value["lastError"] = json!({"code":error.code,"message":error.message});
        save_state(store, &record, &q, &value)?;
    }
    result?;
    mutate_run(store, &record, |r| {
        r["status"] = json!("awaiting_confirmation")
    })?;
    store::pause_parent_clocks(store,s(&record,"accuracyRunId"))?;
    record["recognitionStage"] = json!("complete");
    record["status"] = json!("pending_review");
    record["backgroundJob"]["status"] = json!("completed");
    record["backgroundJob"]["finishedAt"] = json!(now());
    record["backgroundJob"]["completedQuestions"] = json!(1);
    finish(
        &mut record,
        operation(&payload)?,
        &hash_json(&payload),
        "accuracy_repair",
    );
    save_cas(store, Some(&saved), &record)?;
    Ok(())
}
