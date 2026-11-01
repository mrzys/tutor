//! Simulated disposition/identity regressions only. These tests do not call a
//! model, open a database, or establish mathematical/classroom correctness.
use super::*;

const SIM_ID: &str = "sim-resolution-q";
const SIM_SOURCE: &str = "sim-resolution-source-v2";

#[test]
fn simulated_saved_legacy_resolution_contract_overrides_a_new_context_flag() {
    let mut candidate = sim_candidate("模拟：原文无需修改。");
    candidate["issues"] = json!(["模拟：待核对的旧意见。"]);
    let flag = json!({"type":"model_issue","issue":"模拟：待核对的旧意见。"});
    let mut context = sim_bind(candidate, vec![flag], SIM_SOURCE, false);
    let mut response = sim_reply(&context);
    response["issueResolutions"][0]["status"] = json!("resolved");
    context["reviewResolutionVersion"] = json!(2);
    let next = sentence_patch::merge(SIM_ID, SIM_SOURCE, &context, &response).unwrap();
    assert!(rows(&next["issues"]).is_empty());
    assert!(context["patchContract"].get("resolutionVersion").is_none());
}

fn sim_candidate(text: &str) -> Value {
    json!({
        "questionId": SIM_ID,
        "answer": "模拟结果：2。",
        "difficultyAssessment": {"level":"easy","basis":"模拟：直接代入计算。"},
        "teachingSolution": text,
        "teachingFocusSchemaVersion": 2,
        "teachingFocus": {"examFocus":"模拟代数计算。","studentRequirements":["模拟：能逐步代入。"]},
        "issues": []
    })
}

fn sim_bind(candidate: Value, flags: Vec<Value>, source: &str, v2: bool) -> Value {
    let mut context = json!({"candidate":candidate,"reviewFindings":flags});
    if v2 {
        context["reviewResolutionVersion"] = json!(2);
    }
    context["patchContract"] = sentence_patch::contract(SIM_ID, source, &context).unwrap();
    context
}

fn sim_reply(context: &Value) -> Value {
    let contract = &context["patchContract"];
    let mut response = json!({
        "questionId":contract["questionId"],
        "candidateSha256":contract["candidateSha256"],
        "sourceContentSha256":contract["sourceContentSha256"],
        "patches":[], "unresolvedIssues":[]
    });
    if contract["qualityFindings"].is_array() {
        response["qualityResolutions"] = json!(rows(&contract["qualityFindings"])
            .into_iter()
            .map(|f| json!({"id":f["id"],"status":"false_positive","basis":"模拟：按当前材料和确切句段说明误报，不作自动数学判断。"}))
            .collect::<Vec<_>>());
    }
    if contract["allowedIssues"].is_array() {
        response["issueResolutions"] = json!(rows(&contract["allowedIssues"])
            .into_iter()
            .map(|issue| json!({"issueIndex":issue["issueIndex"],"oldTextSha256":issue["expectedTextSha256"],"status":"false_positive","basis":"模拟：当前材料已有明确条件，原意见为误报。"}))
            .collect::<Vec<_>>());
    }
    if contract["termFindings"].is_array() {
        response["termResolutions"] = json!(rows(&contract["termFindings"])
            .into_iter()
            .map(|f| json!({"findingId":f["findingId"],"status":"false_positive","basis":"模拟：仅此版本此处用词有具体依据，未豁免其它命中。"}))
            .collect::<Vec<_>>());
    }
    response
}

fn sim_patch(context: &Value, response: &mut Value, field: &str, text: &str) {
    let segment = rows(&context["patchContract"]["allowedSegments"])
        .into_iter()
        .find(|segment| segment["fieldPath"] == field)
        .unwrap();
    response["patches"] = json!([{
        "segmentId":segment["segmentId"],
        "oldTextSha256":segment["expectedTextSha256"],
        "newText":text
    }]);
}

fn sim_quality_flag(field: &str, dimension: &str, quote: &str) -> Value {
    json!({"type":"quality","id":"sim-quality","dimension":dimension,"fieldPath":field,"quote":quote,"reason":"模拟：只验证声明与获准修订是否一致。"})
}

fn sim_compact_bind(candidate: Value, flags: Vec<Value>) -> Value {
    let mut context = json!({"candidate":candidate,"reviewFindings":flags,
        "reviewResolutionVersion":2,"classroomPolicyVersion":1,"reviewPatchVersion":2});
    context["patchContract"] = sentence_patch::contract(SIM_ID, SIM_SOURCE, &context).unwrap();
    assert_eq!(context["patchContract"]["segmentPatchVersion"], 2);
    context
}

fn sim_compact_response(context: &Value, mut response: Value) -> Value {
    for key in ["questionId", "candidateSha256", "sourceContentSha256"] {
        response.as_object_mut().unwrap().remove(key);
    }
    response["requestId"] = context["patchContract"]["requestId"].clone();
    for patch in response["patches"].as_array_mut().unwrap() {
        patch.as_object_mut().unwrap().remove("oldTextSha256");
    }
    for (key, id, prefix) in [("qualityResolutions", "id", "q"), ("termResolutions", "findingId", "t")] {
        if let Some(entries) = response.get_mut(key).and_then(Value::as_array_mut) {
            for (index, entry) in entries.iter_mut().enumerate() {
                entry[id] = json!(format!("{prefix}{index}"));
            }
        }
    }
    response
}

fn sim_patch_segment(context: &Value, response: &mut Value, index: usize, text: &str) {
    let segment = &context["patchContract"]["allowedSegments"][index];
    response["patches"].as_array_mut().unwrap().push(json!({
        "segmentId":segment["segmentId"], "oldTextSha256":segment["expectedTextSha256"], "newText":text
    }));
}

#[test]
fn simulated_compact_quality_repair_must_change_its_own_authorized_sentence() {
    let first = "模拟证明甲缺少依据。";
    let second = "模拟措辞乙尚待整理。";
    let candidate = sim_candidate(&format!("{first}{second}"));
    let flags = vec![sim_quality_flag("teachingSolution", "proof", first),
        json!({"type":"display","fieldPath":"teachingSolution","quote":second})];
    let context = sim_compact_bind(candidate.clone(), flags.clone());
    assert_eq!(context["patchContract"]["allowedSegments"][0]["expectedText"], first);
    assert_eq!(context["patchContract"]["allowedSegments"][1]["expectedText"], second);
    let before = context.clone();
    let mut response = sim_reply(&context);
    response["qualityResolutions"][0]["status"] = json!("repaired");
    sim_patch_segment(&context, &mut response, 1, "模拟措辞乙已整理。");
    assert_eq!(sentence_patch::merge(SIM_ID, SIM_SOURCE, &context, &sim_compact_response(&context, response.clone())).unwrap_err().code,
        "teaching_quality_unchanged");
    sim_patch_segment(&context, &mut response, 0, first);
    assert_eq!(sentence_patch::merge(SIM_ID, SIM_SOURCE, &context, &sim_compact_response(&context, response.clone())).unwrap_err().code,
        "teaching_quality_unchanged", "a no-op patch on the finding cannot borrow another sentence's edit");
    response["patches"][1]["newText"] = json!("模拟证明甲补充了具体依据。");
    let next = sentence_patch::merge(SIM_ID, SIM_SOURCE, &context, &sim_compact_response(&context, response)).unwrap();
    assert_eq!(next["teachingSolution"], "模拟证明甲补充了具体依据。模拟措辞乙已整理。");
    assert_eq!(context, before);

    // Preserve the meaning of an archived typed version 1 contract.
    let legacy = sim_bind(candidate, flags, SIM_SOURCE, true);
    let mut response = sim_reply(&legacy);
    response["qualityResolutions"][0]["status"] = json!("repaired");
    sim_patch_segment(&legacy, &mut response, 1, "模拟措辞乙已整理。");
    assert!(sentence_patch::merge(SIM_ID, SIM_SOURCE, &legacy, &response).is_ok());
}

#[test]
fn simulated_compact_term_repair_cannot_borrow_another_sentence_in_the_same_field() {
    let candidate = sim_candidate("模拟下界需结合本题核查。模拟措辞乙尚待整理。");
    let mut flags = sim_terms(&candidate);
    assert_eq!(flags.len(), 1);
    flags.push(json!({"type":"display","fieldPath":"teachingSolution","quote":"模拟措辞乙尚待整理。"}));
    let context = sim_compact_bind(candidate, flags);
    let before = context.clone();
    let mut response = sim_reply(&context);
    response["termResolutions"][0]["status"] = json!("repaired");
    sim_patch_segment(&context, &mut response, 1, "模拟措辞乙已整理。");
    assert_eq!(sentence_patch::merge(SIM_ID, SIM_SOURCE, &context, &sim_compact_response(&context, response.clone())).unwrap_err().code,
        "teaching_quality_unchanged");
    sim_patch_segment(&context, &mut response, 0, "模拟由题给不等式写出所求值的限制。");
    assert!(sentence_patch::merge(SIM_ID, SIM_SOURCE, &context, &sim_compact_response(&context, response)).is_ok());
    assert_eq!(context, before);
}

#[test]
fn simulated_compact_unlocated_repair_remains_unresolved_despite_other_authorized_edits() {
    for quote in [None, Some("相同句。") ] {
        let mut finding = sim_quality_flag("teachingSolution", "proof", "unused");
        finding.as_object_mut().unwrap().remove("quote");
        if let Some(quote) = quote {finding["quote"] = json!(quote);}
        let context = sim_compact_bind(sim_candidate("相同句。相同句。模拟措辞乙尚待整理。"),
            vec![finding, json!({"type":"display","fieldPath":"teachingSolution","quote":"模拟措辞乙尚待整理。"})]);
        assert_eq!(rows(&context["patchContract"]["allowedSegments"]).len(), 1);
        let mut response = sim_reply(&context);
        response["qualityResolutions"][0]["status"] = json!("repaired");
        sim_patch_segment(&context, &mut response, 0, "模拟措辞乙已整理。");
        assert_eq!(sentence_patch::merge(SIM_ID, SIM_SOURCE, &context, &sim_compact_response(&context, response)).unwrap_err().code,
            "teaching_quality_unchanged");
    }
    let context = sim_compact_bind(sim_candidate("模拟原句尚待核对。模拟措辞乙尚待整理。"), vec![
        json!({"type":"term","ruleId":"sim-unlocated","fieldPath":"teachingSolution","term":"模拟不存在的原文"}),
        json!({"type":"display","fieldPath":"teachingSolution","quote":"模拟措辞乙尚待整理。"})]);
    let mut response = sim_reply(&context);
    response["termResolutions"][0]["status"] = json!("repaired");
    sim_patch_segment(&context, &mut response, 0, "模拟措辞乙已整理。");
    assert_eq!(sentence_patch::merge(SIM_ID, SIM_SOURCE, &context, &sim_compact_response(&context, response)).unwrap_err().code,
        "teaching_quality_unchanged");
}

fn sim_terms(candidate: &Value) -> Vec<Value> {
    findings(candidate, SIM_ID)
        .into_iter()
        .filter(|flag| flag["type"] == "term")
        .collect()
}

#[test]
fn simulated_new_classroom_limit_contract_rejects_correctness_only_exemption_and_preserves_old_replay() {
    let text=r"模拟前文。故 $\lim_{x\to0}h(x)=1$。模拟后文。";
    let candidate=sim_candidate(text);
    let flags=sim_terms(&candidate);
    let mut context=json!({"candidate":candidate,"reviewFindings":flags,"reviewResolutionVersion":2,"classroomPolicyVersion":1});
    context["patchContract"]=sentence_patch::contract(SIM_ID,SIM_SOURCE,&context).unwrap();
    assert_eq!(context["patchContract"]["classroomPolicyVersion"],1);
    assert_eq!(context["patchContract"]["termFindings"][0]["requiredAction"],"rewrite_without_limits");
    let mut response=sim_reply(&context);
    let before=context.clone();
    assert_eq!(sentence_patch::merge(SIM_ID,SIM_SOURCE,&context,&response).unwrap_err().code,"teaching_classroom_rewrite_required");
    response["termResolutions"][0]["status"]=json!("repaired");
    assert_eq!(sentence_patch::merge(SIM_ID,SIM_SOURCE,&context,&response).unwrap_err().code,"teaching_quality_unchanged");
    sim_patch(&context,&mut response,"teachingSolution","模拟：用具体不等式说明该步。");
    let next=sentence_patch::merge(SIM_ID,SIM_SOURCE,&context,&response).unwrap();
    assert_eq!(next["teachingSolution"],"模拟前文。模拟：用具体不等式说明该步。模拟后文。");
    let mut legacy=context.clone();
    legacy["patchContract"].as_object_mut().unwrap().remove("classroomPolicyVersion");
    for term in legacy["patchContract"]["termFindings"].as_array_mut().unwrap() {term.as_object_mut().unwrap().remove("requiredAction");}
    // A new top-level preference cannot migrate a saved, absent-policy contract.
    assert_eq!(sentence_patch::merge(SIM_ID,SIM_SOURCE,&legacy,&sim_reply(&legacy)).unwrap(),legacy["candidate"]);
    assert_eq!(context,before);
}

#[test]
fn simulated_v2_quality_dispositions_distinguish_repair_false_positive_and_remaining_defects() {
    let text = "模拟：此处推导尚待核算。";
    let context = sim_bind(
        sim_candidate(text),
        vec![sim_quality_flag("teachingSolution", "proof", text)],
        SIM_SOURCE,
        true,
    );
    assert!(typed(&context));
    let response = sim_reply(&context);
    assert_eq!(
        sentence_patch::merge(SIM_ID, SIM_SOURCE, &context, &response).unwrap(),
        context["candidate"]
    );

    for (disposition, expected) in [
        ("repaired", "teaching_quality_unchanged"),
        ("confirmed_defect", "teaching_quality_unresolved"),
        ("unresolved", "teaching_quality_unresolved"),
        ("resolved", "teaching_quality_unresolved"),
    ] {
        let mut reply = response.clone();
        reply["qualityResolutions"][0]["status"] = json!(disposition);
        assert_eq!(
            sentence_patch::merge(SIM_ID, SIM_SOURCE, &context, &reply)
                .unwrap_err()
                .code,
            expected,
            "simulated disposition: {disposition}"
        );
    }

    let mut repaired = response.clone();
    repaired["qualityResolutions"][0]["status"] = json!("repaired");
    sim_patch(
        &context,
        &mut repaired,
        "teachingSolution",
        "模拟：补出获准句段内的具体推导。",
    );
    let next = sentence_patch::merge(SIM_ID, SIM_SOURCE, &context, &repaired).unwrap();
    assert_ne!(
        next["teachingSolution"],
        context["candidate"]["teachingSolution"]
    );
    assert_eq!(next["answer"], context["candidate"]["answer"]);
}

#[test]
fn simulated_v2_material_issue_does_not_confuse_confirming_a_defect_with_fixing_it() {
    let mut candidate = sim_candidate("模拟：材料说明仍待核对。");
    candidate["issues"] = json!(["模拟：输入条件可能矛盾。"]);
    let context = sim_bind(
        candidate,
        vec![json!({"type":"model_issue","issue":"模拟：输入条件可能矛盾。"})],
        SIM_SOURCE,
        true,
    );
    let response = sim_reply(&context);
    let next = sentence_patch::merge(SIM_ID, SIM_SOURCE, &context, &response).unwrap();
    assert_eq!(next["issues"], json!([]));
    assert_eq!(
        next["teachingSolution"],
        context["candidate"]["teachingSolution"]
    );

    for (disposition, expected) in [
        ("repaired", "teaching_quality_unchanged"),
        ("confirmed_defect", "teaching_patch_unresolved"),
        ("unresolved", "teaching_patch_unresolved"),
        ("resolved", "invalid_teaching_patch"),
    ] {
        let mut reply = response.clone();
        reply["issueResolutions"][0]["status"] = json!(disposition);
        assert_eq!(
            sentence_patch::merge(SIM_ID, SIM_SOURCE, &context, &reply)
                .unwrap_err()
                .code,
            expected
        );
    }
}

#[test]
fn simulated_legacy_resolved_remains_legacy_only() {
    let text = "模拟：原句待补推导。";
    let flags = vec![sim_quality_flag("teachingSolution", "proof", text)];
    let legacy = sim_bind(sim_candidate(text), flags.clone(), SIM_SOURCE, false);
    assert!(!typed(&legacy));
    assert!(legacy["patchContract"].get("resolutionVersion").is_none());
    let mut response = sim_reply(&legacy);
    response["qualityResolutions"][0]["status"] = json!("resolved");
    sim_patch(
        &legacy,
        &mut response,
        "teachingSolution",
        "模拟：补充了对应推导。",
    );
    assert!(sentence_patch::merge(SIM_ID, SIM_SOURCE, &legacy, &response).is_ok());

    let current = sim_bind(sim_candidate(text), flags, SIM_SOURCE, true);
    let mut response = sim_reply(&current);
    response["qualityResolutions"][0]["status"] = json!("resolved");
    sim_patch(
        &current,
        &mut response,
        "teachingSolution",
        "模拟：补充了对应推导。",
    );
    assert_eq!(
        sentence_patch::merge(SIM_ID, SIM_SOURCE, &current, &response)
            .unwrap_err()
            .code,
        "teaching_quality_unresolved"
    );

    let mut candidate = sim_candidate("模拟：旧格式材料处理。");
    candidate["issues"] = json!(["模拟：待确认输入类型。"]);
    let legacy_issue = sim_bind(
        candidate,
        vec![json!({"type":"model_issue","issue":"模拟：待确认输入类型。"})],
        SIM_SOURCE,
        false,
    );
    let mut response = sim_reply(&legacy_issue);
    response["issueResolutions"][0]["status"] = json!("resolved");
    assert!(sentence_patch::merge(SIM_ID, SIM_SOURCE, &legacy_issue, &response).is_ok());
}

#[test]
fn simulated_yuxi15_style_material_issue_is_not_repaired_by_difficulty_only() {
    // Standalone regression of the observed contract mistake. No real paper or
    // model response is loaded, and no mathematical conclusion is asserted.
    let mut candidate = sim_candidate("模拟：三角形面积的关键步骤仍缺失。");
    candidate["difficultyAssessment"]["basis"] = json!("模拟：原难度说明待调整。");
    candidate["issues"] = json!(["模拟：面积推导尚未完成。"]);
    let context = sim_bind(
        candidate,
        vec![
            sim_quality_flag(
                "difficultyAssessment.basis",
                "assessment",
                "模拟：原难度说明待调整。",
            ),
            json!({"type":"model_issue","issue":"模拟：面积推导尚未完成。"}),
        ],
        SIM_SOURCE,
        true,
    );
    let before = context.clone();
    let mut response = sim_reply(&context);
    response["issueResolutions"][0]["status"] = json!("repaired");
    response["qualityResolutions"][0]["status"] = json!("repaired");
    sim_patch(
        &context,
        &mut response,
        "difficultyAssessment.basis",
        "模拟：改为含三角关系的难度描述。",
    );
    assert_eq!(
        sentence_patch::merge(SIM_ID, SIM_SOURCE, &context, &response)
            .unwrap_err()
            .code,
        "teaching_quality_unchanged"
    );
    assert_eq!(context, before, "simulated rejection remains atomic");
}

#[test]
fn simulated_v2_term_repair_requires_its_own_field_to_change() {
    let candidate = sim_candidate("模拟：此下界需结合具体材料检查。");
    let context = sim_bind(candidate.clone(), sim_terms(&candidate), SIM_SOURCE, true);
    let response = sim_reply(&context);
    assert!(terms(&context, &response, &candidate).is_ok());
    let mut repaired = response.clone();
    repaired["termResolutions"][0]["status"] = json!("repaired");
    assert_eq!(
        terms(&context, &repaired, &candidate).unwrap_err().code,
        "teaching_quality_unchanged"
    );
    let mut unrelated = candidate.clone();
    unrelated["difficultyAssessment"]["basis"] = json!("模拟：只改其它字段。");
    assert_eq!(
        terms(&context, &repaired, &unrelated).unwrap_err().code,
        "teaching_quality_unchanged"
    );

    sim_patch(
        &context,
        &mut repaired,
        "teachingSolution",
        "模拟：写出所求式子的具体不等式。",
    );
    assert!(sentence_patch::merge(SIM_ID, SIM_SOURCE, &context, &repaired).is_ok());
    for (disposition, expected) in [
        ("confirmed_defect", "teaching_patch_unresolved"),
        ("unresolved", "teaching_patch_unresolved"),
        ("resolved", "invalid_teaching_patch"),
    ] {
        let mut reply = response.clone();
        reply["termResolutions"][0]["status"] = json!(disposition);
        assert_eq!(
            sentence_patch::merge(SIM_ID, SIM_SOURCE, &context, &reply)
                .unwrap_err()
                .code,
            expected
        );
    }
}

#[test]
fn simulated_false_positive_is_bound_to_one_occurrence_not_a_word() {
    let candidate = sim_candidate("模拟：此下界由题给条件保证。另一处下界仍待检查。");
    let flags = sim_terms(&candidate);
    assert_eq!(flags.len(), 2);
    let context = sim_bind(candidate.clone(), vec![flags[0].clone()], SIM_SOURCE, true);
    let response = sim_reply(&context);
    let next = sentence_patch::merge(SIM_ID, SIM_SOURCE, &context, &response).unwrap();
    assert_eq!(next, candidate);
    assert_eq!(
        filter_terms(flags.clone(), &context, &response, &next),
        vec![flags[1].clone()]
    );

    let mut changed_rule = flags[0].clone();
    changed_rule["ruleId"] = json!("sim-new-rule-same-word");
    let mut changed_field = flags[0].clone();
    changed_field["fieldPath"] = json!("teachingFocus.examFocus");
    let new_findings = vec![changed_rule, changed_field];
    assert_eq!(
        filter_terms(new_findings.clone(), &context, &response, &next),
        new_findings
    );
}

#[test]
fn simulated_false_positive_needs_exact_contract_identity_and_basis() {
    let candidate = sim_candidate("模拟：这个下界来自当前给定不等式。");
    let flags = sim_terms(&candidate);
    let context = sim_bind(candidate.clone(), flags.clone(), SIM_SOURCE, true);
    let good = sim_reply(&context);
    let original = context.clone();
    assert!(filter_terms(flags.clone(), &context, &good, &candidate).is_empty());
    for alteration in 0..7 {
        let mut response = good.clone();
        let mut next = candidate.clone();
        match alteration {
            0 => response["candidateSha256"] = json!("sim-stale-candidate"),
            1 => response["sourceContentSha256"] = json!("sim-stale-source"),
            2 => response["questionId"] = json!("sim-other-question"),
            3 => response["termResolutions"][0]["findingId"] = json!("sim-unknown-finding"),
            4 => response["termResolutions"][0]["basis"] = json!("   "),
            5 => next["teachingSolution"] = json!("模拟：编辑之后的新下界。"),
            _ => response["termResolutions"] = json!([]),
        }
        assert_eq!(
            filter_terms(flags.clone(), &context, &response, &next),
            flags
        );
    }
    assert_eq!(context, original);
}

#[test]
fn simulated_persisted_false_positive_replay_expires_on_source_candidate_or_field_change() {
    let candidate = sim_candidate("模拟：当前下界已在同一句解释。");
    let flags = sim_terms(&candidate);
    let mut question = json!({
        "questionId":SIM_ID,"questionType":"free_response","stem":"模拟原题材料。",
        "options":[],"parts":[],"answer":"","solution":"","pages":[1],"sourceLabel":"1",
        "sourceIdentity":{"system":"simulated-source","sourceSha256":"sim-pdf-hash"},
        "sourceBlockIds":["p1-b1"],"student":{"assets":[]},"teacher":{"assets":[]},
        "assetPayloads":[],"sourceIssues":[]
    });
    let source = source_hash(&question);
    let context = sim_bind(candidate.clone(), flags.clone(), &source, true);
    let response = sim_reply(&context);
    question["teachingWorkflow"] = json!({
        "termResolvedCandidateSha256":hash_json(&candidate),
        "termResolvedSourceSha256":source,
        "reviewPatchBaseCandidate":candidate,
        "reviewPatchContract":context["patchContract"],
        "termReviewFindings":flags,
        "reviewPatchResponse":response
    });
    assert!(reviewed_findings(&question, &candidate, flags.clone()).is_empty());
    for alteration in 0..6 {
        let mut q = question.clone();
        let mut next = candidate.clone();
        match alteration {
            0 => q["stem"] = json!("模拟：来源题面已改。"),
            1 => q["teachingWorkflow"]["termResolvedCandidateSha256"] = json!("sim-stale"),
            2 => {
                q["teachingWorkflow"]["reviewPatchContract"]["candidateSha256"] = json!("sim-stale")
            }
            3 => next["teachingSolution"] = json!("模拟：另一个版本的下界说明。"),
            4 => next["answer"] = json!("模拟：答案字段发生变化。"),
            _ => q["teachingWorkflow"]["reviewPatchContract"]["resolutionVersion"] = json!(1),
        }
        assert_eq!(reviewed_findings(&q, &next, flags.clone()), flags);
    }
}

#[test]
fn simulated_occurrence_false_positive_survives_only_unchanged_sentence_and_exact_shift() {
    let candidate=sim_candidate("😀前句。关键关系共同构成结论。目标式需要改写。后句保持。");
    let flags=sim_terms(&candidate);
    assert_eq!(flags.len(),2);
    let mut context=sim_compact_bind(candidate,flags);
    context.as_object_mut().unwrap().remove("patchContract");
    context["falsePositiveScopeVersion"]=json!(1);
    context["patchContract"]=sentence_patch::contract(SIM_ID,SIM_SOURCE,&context).unwrap();
    assert_eq!(context["patchContract"]["falsePositiveScopeVersion"],1);
    let mut response=sim_reply(&context);
    let target=rows(&context["patchContract"]["allowedSegments"]).into_iter().find(|s|s["expectedText"]=="目标式需要改写。").unwrap();
    response["patches"]=json!([{"segmentId":target["segmentId"],"oldTextSha256":target["expectedTextSha256"],"newText":"所求式子需要改写。"}]);
    let term=rows(&context["patchContract"]["termFindings"]).into_iter().find(|f|f["term"]=="目标式").unwrap();
    for r in response["termResolutions"].as_array_mut().unwrap() {if r["findingId"]==term["findingId"]{r["status"]=json!("repaired");}}
    let compact=sim_compact_response(&context,response.clone());
    let next=sentence_patch::merge(SIM_ID,SIM_SOURCE,&context,&compact).unwrap();
    assert!(resolutions::filter_terms(sim_terms(&next),&context,&compact,&next).is_empty());

    // The same verdict never clears a changed surrounding sentence.
    let fp=rows(&context["patchContract"]["allowedSegments"]).into_iter().find(|s|s["expectedText"]=="关键关系共同构成结论。").unwrap();
    response["patches"].as_array_mut().unwrap().push(json!({"segmentId":fp["segmentId"],"oldTextSha256":fp["expectedTextSha256"],"newText":"不同构造也得到结论。"}));
    let compact=sim_compact_response(&context,response.clone());
    let changed=sentence_patch::merge(SIM_ID,SIM_SOURCE,&context,&compact).unwrap();
    assert_eq!(resolutions::filter_terms(sim_terms(&changed),&context,&compact,&changed).len(),1);

    // Old compact contracts keep their unchanged-whole-field rule.
    context.as_object_mut().unwrap().remove("patchContract");
    context.as_object_mut().unwrap().remove("falsePositiveScopeVersion");
    context["patchContract"]=sentence_patch::contract(SIM_ID,SIM_SOURCE,&context).unwrap();
    let mut legacy=sim_reply(&context);
    let span=rows(&context["patchContract"]["allowedSegments"]).into_iter().find(|s|s["expectedText"]=="目标式需要改写。").unwrap();
    legacy["patches"]=json!([{"segmentId":span["segmentId"],"oldTextSha256":span["expectedTextSha256"],"newText":"所求式子需要改写。"}]);
    let compact=sim_compact_response(&context,legacy);
    let next=sentence_patch::merge(SIM_ID,SIM_SOURCE,&context,&compact).unwrap();
    assert_eq!(resolutions::filter_terms(sim_terms(&next),&context,&compact,&next).len(),1);
}

#[test]
fn simulated_occurrence_false_positive_maps_utf16_shift_but_not_new_same_word() {
    let text="😀目标式先计算。关键关系共同构成结论。后句保持。";
    let mut context=sim_compact_bind(sim_candidate(text),sim_terms(&sim_candidate(text)));
    context.as_object_mut().unwrap().remove("patchContract");
    context["falsePositiveScopeVersion"]=json!(1);
    context["patchContract"]=sentence_patch::contract(SIM_ID,SIM_SOURCE,&context).unwrap();
    let mut response=sim_reply(&context);
    let target=rows(&context["patchContract"]["allowedSegments"]).into_iter().find(|s|s["expectedText"]=="😀目标式先计算。").unwrap();
    response["patches"]=json!([{"segmentId":target["segmentId"],"oldTextSha256":target["expectedTextSha256"],"newText":"😀😀先算出所求式子，再考虑同构方法。"}]);
    let compact=sim_compact_response(&context,response);
    let next=sentence_patch::merge(SIM_ID,SIM_SOURCE,&context,&compact).unwrap();
    let remaining=resolutions::filter_terms(sim_terms(&next),&context,&compact,&next);
    assert_eq!(remaining.len(),1);
    assert_eq!(remaining[0]["term"],"同构");
    let at=sentence_patch::locate(s(&next,"teachingSolution"),&remaining[0]).unwrap().0;
    assert!(at<"😀😀先算出所求式子，再考虑同构方法。".chars().count());
}
