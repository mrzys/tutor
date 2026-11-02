//! Fail-closed wire contracts for accuracy reports and teaching metadata.
//! Structural validation never claims the represented mathematics is correct.
use crate::error::{AppError, AppResult};
use serde_json::{Value, json};
use std::collections::HashSet;

fn invalid(message: &str) -> AppError {
    AppError::new("accuracy_contract_invalid", message)
}

fn keys(value: &Value, required: &[&str], optional: &[&str]) -> AppResult<()> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid("模型结果须为完整对象。"))?;
    if required.iter().any(|key| !object.contains_key(*key))
        || object
            .keys()
            .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
    {
        return Err(invalid("模型结果缺少必需字段或越过本次输出权限。"));
    }
    Ok(())
}

fn text<'a>(value: &'a Value, maximum: usize, nonempty: bool) -> AppResult<&'a str> {
    value
        .as_str()
        .filter(|text| {
            (!nonempty || !text.trim().is_empty())
                && text.chars().count() <= maximum
                && !text
                    .chars()
                    .any(|c| c.is_control() && c != '\n' && c != '\t')
        })
        .ok_or_else(|| invalid("模型结果文字缺失、过长或含无效控制字符。"))
}

fn identity(value: &Value, maximum: usize) -> AppResult<&str> {
    let value = text(value, maximum, true)?;
    if value.chars().any(char::is_control) {
        return Err(invalid("模型结果身份无效。"));
    }
    Ok(value)
}

fn list(value: &Value, maximum: usize) -> AppResult<&Vec<Value>> {
    value
        .as_array()
        .filter(|values| values.len() <= maximum)
        .ok_or_else(|| invalid("模型结果列表结构无效或超过范围。"))
}

fn strings(value: &Value, maximum: usize, length: usize) -> AppResult<()> {
    for item in list(value, maximum)? {
        text(item, length, true)?;
    }
    Ok(())
}

fn identities(value: &Value, maximum: usize) -> AppResult<HashSet<&str>> {
    let mut selected = HashSet::new();
    for item in list(value, maximum)? {
        let item = identity(item, 300)?;
        if !selected.insert(item) {
            return Err(invalid("模型结果包含重复身份。"));
        }
    }
    Ok(selected)
}

fn optional_part(value: Option<&Value>) -> AppResult<()> {
    if let Some(value) = value.filter(|value| !value.is_null()) {
        identity(value, 100)?;
    }
    Ok(())
}

pub(super) fn report(value: &Value, question_id: &str, targets: &[String]) -> AppResult<()> {
    keys(
        value,
        &["questionId", "status", "confidence", "checks", "findings"],
        &["assetDisclosures", "referencePresence", "disagreements"],
    )?;
    if identity(&value["questionId"], 300)? != question_id
        || !matches!(
            value["status"].as_str(),
            Some("no_issue_found" | "issues_found" | "unresolved")
        )
        || !matches!(
            value["confidence"].as_str(),
            Some("high" | "medium" | "low")
        )
    {
        return Err(invalid("核验身份、状态或说明性置信档无效。"));
    }
    let required = targets.iter().map(String::as_str).collect::<HashSet<_>>();
    if required.is_empty()
        || required.len() != targets.len()
        || required.iter().any(|target| target.trim().is_empty())
    {
        return Err(invalid("核验目标合同为空或重复，不能生成通过意见。"));
    }
    let mut checked = HashSet::new();
    let mut issue = false;
    let mut unresolved = false;
    for check in list(&value["checks"], 1000)? {
        keys(check, &["target", "status", "basis"], &[])?;
        let target = identity(&check["target"], 500)?;
        if !required.contains(target) || !checked.insert(target) {
            return Err(invalid("核验目标未知、越界或重复，不能采用该报告。"));
        }
        text(&check["basis"], 5000, true)?;
        match check["status"].as_str() {
            Some("checked") => {}
            Some("issue") => issue = true,
            Some("unresolved") => unresolved = true,
            _ => return Err(invalid("核验目标状态无效。")),
        }
    }
    if checked != required {
        return Err(invalid("核验未完整覆盖所有目标与小问。"));
    }
    let findings = list(&value["findings"], 200)?;
    let mut finding_ids = HashSet::new();
    for finding in findings {
        keys(
            finding,
            &["id", "message", "fieldPath", "basis"],
            &["domain", "partId"],
        )?;
        if !finding_ids.insert(identity(&finding["id"], 160)?) {
            return Err(invalid("核验问题身份重复。"));
        }
        text(&finding["message"], 4000, true)?;
        text(&finding["basis"], 5000, true)?;
        text(&finding["fieldPath"], 500, false)?;
        if let Some(domain) = finding.get("domain") {
            identity(domain, 100)?;
        }
        optional_part(finding.get("partId"))?;
    }
    if let Some(disclosures) = value.get("assetDisclosures") {
        let mut ids = HashSet::new();
        for disclosure in list(disclosures, 240)? {
            keys(disclosure, &["assetId", "role", "basis"], &[])?;
            if !ids.insert(identity(&disclosure["assetId"], 300)?)
                || !matches!(
                    disclosure["role"].as_str(),
                    Some("student_original" | "reference_only" | "mixed_or_uncertain")
                )
            {
                return Err(invalid("素材披露身份重复或角色无效。"));
            }
            text(&disclosure["basis"], 4000, true)?;
            unresolved |= disclosure["role"] == "mixed_or_uncertain";
        }
    }
    if let Some(presence) = value.get("referencePresence") {
        keys(presence, &["answer", "solution"], &[])?;
        for field in ["answer", "solution"] {
            if !matches!(
                presence[field].as_str(),
                Some("present" | "absent" | "uncertain")
            ) {
                return Err(invalid("原参考存在性必须明确为存在、缺失或未判。"));
            }
            unresolved |= presence[field] == "uncertain";
        }
    }
    if let Some(disagreements) = value.get("disagreements") {
        for disagreement in list(disagreements, 100)? {
            keys(
                disagreement,
                &[
                    "claimA",
                    "claimB",
                    "classification",
                    "basis",
                    "affectedFields",
                ],
                &["partId", "stepA", "stepB"],
            )?;
            optional_part(disagreement.get("partId"))?;
            text(&disagreement["claimA"], 10000, false)?;
            text(&disagreement["claimB"], 10000, false)?;
            for step in ["stepA", "stepB"] {
                if let Some(value) = disagreement.get(step).filter(|value| !value.is_null()) {
                    text(value, 10000, false)?;
                }
            }
            if !matches!(
                disagreement["classification"].as_str(),
                Some(
                    "equivalent"
                        | "candidate_defect"
                        | "independent_defect"
                        | "both_defective"
                        | "source_problem"
                        | "unresolved"
                )
            ) {
                return Err(invalid("分歧归因无效。"));
            }
            text(&disagreement["basis"], 5000, true)?;
            strings(&disagreement["affectedFields"], 100, 500)?;
            if disagreement["classification"] == "unresolved" {
                unresolved = true;
            } else if matches!(
                disagreement["classification"].as_str(),
                Some("candidate_defect" | "both_defective" | "source_problem")
            ) {
                issue = true;
            }
        }
    }
    match value["status"].as_str() {
        Some("no_issue_found") if !issue && !unresolved && findings.is_empty() => Ok(()),
        Some("issues_found") if issue && !findings.is_empty() => Ok(()),
        Some("unresolved") if unresolved => Ok(()),
        _ => Err(invalid("核验总状态与逐项结果、疑点或未判证据矛盾。")),
    }
}

fn points(catalogue: &Value) -> &[Value] {
    catalogue["knowledgeCatalogue"]["points"]
        .as_array()
        .or_else(|| catalogue["knowledgePoints"].as_array())
        .or_else(|| catalogue["points"].as_array())
        .map(Vec::as_slice)
        .unwrap_or_default()
}

fn valid_leaf(uid: &str, catalogue: &Value) -> AppResult<()> {
    let points = points(catalogue);
    let matching = points
        .iter()
        .filter(|point| point["uid"] == uid)
        .collect::<Vec<_>>();
    if matching.len() != 1
        || matching[0]["isLeaf"] != true
        || points.iter().any(|point| point["parentUid"] == uid)
    {
        return Err(invalid(
            "主考和解法知识只能引用真实、唯一且明确的叶知识点。",
        ));
    }
    Ok(())
}

pub(super) fn metadata(value: &Value, question_id: &str, catalogue: &Value) -> AppResult<()> {
    keys(
        value,
        &[
            "questionId",
            "difficultyAssessment",
            "teachingFocusSchemaVersion",
            "teachingFocus",
            "primaryKnowledgeUids",
            "solutionPaths",
            "task",
            "issues",
        ],
        &[],
    )?;
    if identity(&value["questionId"], 300)? != question_id
        || value["teachingFocusSchemaVersion"] != 2
    {
        return Err(invalid("教学元数据题目身份或说明版本不匹配。"));
    }
    keys(&value["difficultyAssessment"], &["level", "basis"], &[])?;
    crate::annotations::normalize_difficulty(value)?;
    keys(
        &value["teachingFocus"],
        &["examFocus", "studentRequirements"],
        &[],
    )?;
    text(&value["teachingFocus"]["examFocus"], 600, false)?;
    strings(&value["teachingFocus"]["studentRequirements"], 3, 400)?;
    strings(&value["issues"], 100, 4000)?;
    let primary = identities(&value["primaryKnowledgeUids"], 600)?;
    for uid in &primary {
        valid_leaf(uid, catalogue)?;
    }
    for path in list(&value["solutionPaths"], 1)? {
        keys(
            path,
            &["id", "requiredKnowledgeUids", "requiredPremises", "basis"],
            &[],
        )?;
        identity(&path["id"], 100)?;
        text(&path["basis"], 10000, true)?;
        let required = identities(&path["requiredKnowledgeUids"], 600)?;
        if !primary.is_subset(&required) {
            return Err(invalid("逐解法依赖必须包含全部主考知识点。"));
        }
        for uid in required {
            valid_leaf(uid, catalogue)?;
        }
        for premise in identities(&path["requiredPremises"], 600)? {
            if catalogue["premises"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|row| row["id"] == premise)
                .count()
                != 1
            {
                return Err(invalid("解法前提必须引用本次目录的真实唯一身份。"));
            }
        }
    }
    keys(&value["task"], &["id", "label"], &[])?;
    let task_id = text(&value["task"]["id"], 100, false)?;
    text(&value["task"]["label"], 200, false)?;
    if !task_id.is_empty() {
        identity(&value["task"]["id"], 100)?;
        if catalogue["tasks"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|task| task["id"] == task_id)
            .count()
            != 1
        {
            return Err(invalid(
                "考查任务必须引用本次目录的真实唯一身份；新任务保留空id及具体label。",
            ));
        }
    }
    Ok(())
}

fn string_schema() -> Value {
    json!({"type":"string"})
}
fn strings_schema() -> Value {
    json!({"type":"array","items":{"type":"string"}})
}
fn object_schema(required: &[&str], properties: Value) -> Value {
    json!({"type":"object","additionalProperties":false,"required":required,"properties":properties})
}

pub(super) fn response_contract(kind: &str) -> Value {
    if matches!(
        kind,
        "solution"
            | "independent"
            | "repair"
            | "accuracy_solution_generation"
            | "accuracy_independent_solve"
            | "accuracy_repair"
    ) {
        return object_schema(
            &[
                "questionId",
                "answer",
                "solution",
                "partCoverage",
                "limitations",
            ],
            json!({"questionId":string_schema(),"answer":string_schema(),"solution":string_schema(),"partCoverage":{"type":"array","items":{"type":["string","null"]},"description":"精确覆盖实际小问；无小问用[null]，不得用空数组声称完成"},"limitations":strings_schema()}),
        );
    }
    if matches!(kind, "metadata" | "meta" | "accuracy_teaching_generation") {
        return object_schema(
            &[
                "questionId",
                "difficultyAssessment",
                "teachingFocusSchemaVersion",
                "teachingFocus",
                "primaryKnowledgeUids",
                "solutionPaths",
                "task",
                "issues",
            ],
            json!({
                "questionId":string_schema(),
                "difficultyAssessment":object_schema(&["level","basis"],json!({"level":{"enum":[null,"easy","easy_medium","medium","medium_hard","hard"]},"basis":string_schema()})),
                "teachingFocusSchemaVersion":{"const":2},
                "teachingFocus":object_schema(&["examFocus","studentRequirements"],json!({"examFocus":string_schema(),"studentRequirements":{"type":"array","maxItems":3,"items":{"type":"string"}}})),
                "primaryKnowledgeUids":strings_schema(),
                "solutionPaths":{"type":"array","maxItems":1,"items":object_schema(&["id","requiredKnowledgeUids","requiredPremises","basis"],json!({"id":string_schema(),"requiredKnowledgeUids":strings_schema(),"requiredPremises":strings_schema(),"basis":string_schema()}))},
                "task":object_schema(&["id","label"],json!({"id":string_schema(),"label":string_schema()})),"issues":strings_schema()
            }),
        );
    }
    let mut required = vec!["questionId", "status", "confidence", "checks", "findings"];
    if matches!(
        kind,
        "source" | "sourceVerify" | "accuracy_source_verification"
    ) {
        required.extend(["assetDisclosures", "referencePresence"]);
    }
    object_schema(
        &required,
        json!({
            "questionId":string_schema(),"status":{"enum":["no_issue_found","issues_found","unresolved"]},"confidence":{"enum":["high","medium","low"]},
            "checks":{"type":"array","items":object_schema(&["target","status","basis"],json!({"target":string_schema(),"status":{"enum":["checked","issue","unresolved"]},"basis":string_schema()}))},
            "findings":{"type":"array","items":object_schema(&["id","message","fieldPath","basis"],json!({"id":string_schema(),"domain":string_schema(),"message":string_schema(),"fieldPath":string_schema(),"partId":{"type":["string","null"]},"basis":string_schema()}))},
            "assetDisclosures":{"type":"array","items":object_schema(&["assetId","role","basis"],json!({"assetId":string_schema(),"role":{"enum":["student_original","reference_only","mixed_or_uncertain"]},"basis":string_schema()}))},
        "referencePresence":object_schema(&["answer","solution"],json!({"answer":{"enum":["present","absent","uncertain"]},"solution":{"enum":["present","absent","uncertain"]}})),
        "disagreements":{"type":"array","items":object_schema(&["claimA","claimB","classification","basis","affectedFields"],json!({"claimA":string_schema(),"claimB":string_schema(),"classification":{"enum":["equivalent","candidate_defect","independent_defect","both_defective","source_problem","unresolved"]},"basis":string_schema(),"affectedFields":strings_schema(),"partId":{"type":["string","null"]},"stepA":{"type":["string","null"]},"stepB":{"type":["string","null"]}}))}
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observed_protocol_cases() -> Value {
        serde_json::from_str(include_str!("model_protocol_observed_20261102.json")).unwrap()
    }

    #[test]
    fn observed_real_response_protocol_failures_remain_rejected_without_rewriting_them() {
        for case in observed_protocol_cases()["cases"].as_array().unwrap() {
            let result: Value =
                serde_json::from_str(case["rawMessageContent"].as_str().unwrap()).unwrap();
            let targets: Vec<_> = case["requiredTargets"]
                .as_array()
                .unwrap()
                .iter()
                .map(|target| target.as_str().unwrap().to_owned())
                .collect();
            let checked = report(&result, result["questionId"].as_str().unwrap(), &targets);
            assert_eq!(
                checked.is_ok(),
                case["contractAccepted"].as_bool().unwrap(),
                "{}",
                case["case"]
            );
            if let Err(error) = checked {
                assert_eq!(error.code, "accuracy_contract_invalid");
            }
        }
    }

    #[test]
    fn observed_path_suffix_is_not_silently_coerced_to_a_parent_target() {
        let cases = observed_protocol_cases();
        let case = &cases["cases"][1];
        let result: Value =
            serde_json::from_str(case["rawMessageContent"].as_str().unwrap()).unwrap();
        assert_eq!(
            result["checks"][1]["target"],
            "solutionPaths/interval-union-endpoint-check"
        );
        let targets = case["requiredTargets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        let error = report(&result, result["questionId"].as_str().unwrap(), &targets).unwrap_err();
        assert!(error.message.contains("核验目标未知"));
    }

    #[test]
    fn observed_form_feed_and_positive_findings_are_independent_rejection_reasons() {
        let cases = observed_protocol_cases();
        let case = &cases["cases"][2];
        let actual: Value =
            serde_json::from_str(case["rawMessageContent"].as_str().unwrap()).unwrap();
        let targets = case["requiredTargets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        let qid = actual["questionId"].as_str().unwrap();
        assert_eq!(actual["status"], "no_issue_found");
        assert_eq!(actual["findings"].as_array().unwrap().len(), 1);
        assert!(
            actual["checks"][0]["basis"]
                .as_str()
                .unwrap()
                .contains('\u{000c}')
        );

        // Test derivatives isolate each failure; the captured visible response
        // above and the runtime audit remain unchanged and are never adopted.
        let mut without_findings = actual.clone();
        without_findings["findings"] = json!([]);
        assert!(
            report(&without_findings, qid, &targets)
                .unwrap_err()
                .message
                .contains("控制字符")
        );
        let mut without_form_feed = actual.clone();
        let text = &mut without_form_feed["checks"][0]["basis"];
        *text = json!(text.as_str().unwrap().replace('\u{000c}', "\\f"));
        let text = &mut without_form_feed["findings"][0]["message"];
        *text = json!(text.as_str().unwrap().replace('\u{000c}', "\\f"));
        assert!(
            report(&without_form_feed, qid, &targets)
                .unwrap_err()
                .message
                .contains("总状态")
        );
    }

    fn clean_report() -> Value {
        json!({"questionId":"q1","status":"no_issue_found","confidence":"low","checks":[{"target":"stem","status":"checked","basis":"模拟：已实际核对原页条件及所有符号。"},{"target":"p1","status":"checked","basis":"模拟：核对第一问及必要论证。"}],"findings":[]})
    }

    fn targets() -> Vec<String> {
        vec!["stem".into(), "p1".into()]
    }

    #[test]
    fn report_requires_exact_nonempty_coverage_and_consistent_conclusion_independent_of_confidence()
    {
        report(&clean_report(), "q1", &targets()).unwrap();
        for mode in 0..7 {
            let mut candidate = clean_report();
            match mode {
                0 => candidate["checks"] = json!([]),
                1 => {
                    candidate["checks"].as_array_mut().unwrap().pop();
                }
                2 => candidate["checks"][1]["target"] = json!("stem"),
                3 => candidate["checks"][0]["target"] = json!("other-question"),
                4 => candidate["checks"][0]["basis"] = json!(" "),
                5 => candidate["checks"][0]["status"] = json!("unresolved"),
                _ => {
                    candidate["findings"] = json!([{"id":"actual-issue","message":"模拟条件不一致。","fieldPath":"stem","basis":"模拟原页为大于，转录为小于。"}])
                }
            }
            assert!(report(&candidate, "q1", &targets()).is_err(), "mode={mode}");
        }
        assert!(report(&clean_report(), "q1", &[]).is_err());
        assert!(report(&clean_report(), "different", &targets()).is_err());
    }

    #[test]
    fn report_preserves_real_issues_and_visual_or_reference_uncertainty_cannot_pass() {
        let mut candidate = clean_report();
        candidate["assetDisclosures"] = json!([{"assetId":"diagram-1","role":"mixed_or_uncertain","basis":"模拟：原题图和解答构造无法分离。"}]);
        assert!(report(&candidate, "q1", &targets()).is_err());
        candidate["status"] = json!("unresolved");
        report(&candidate, "q1", &targets()).unwrap();
        candidate = clean_report();
        candidate["referencePresence"] = json!({"answer":"uncertain","solution":"absent"});
        assert!(report(&candidate, "q1", &targets()).is_err());
        candidate["status"] = json!("unresolved");
        report(&candidate, "q1", &targets()).unwrap();
        candidate = clean_report();
        candidate["status"] = json!("issues_found");
        candidate["checks"][0]["status"] = json!("issue");
        assert!(report(&candidate, "q1", &targets()).is_err());
        candidate["findings"] = json!([{"id":"source-condition","domain":"source","fieldPath":"stem","partId":null,"message":"模拟转录条件与原页不符。","basis":"模拟：原图是x>0，转录为x<0。"}]);
        report(&candidate, "q1", &targets()).unwrap();
        candidate["findings"][0]["severity"] = json!("advisory");
        assert!(
            report(&candidate, "q1", &targets()).is_err(),
            "model cannot assign its own downgrade"
        );
    }

    fn catalogue() -> Value {
        json!({"knowledgeCatalogue":{"points":[{"uid":"group","isLeaf":true,"parentUid":null},{"uid":"leaf-a","isLeaf":true,"parentUid":"group"},{"uid":"leaf-b","isLeaf":true,"parentUid":null},{"uid":"missing-flag","parentUid":null}]},"tasks":[{"id":"real-task","label":"模拟任务"}],"premises":[{"id":"real-premise"}]})
    }

    fn clean_metadata() -> Value {
        json!({"questionId":"q1","difficultyAssessment":{"level":"easy","basis":"模拟：直接使用一次加法运算，条件完整且无额外分类。"},"teachingFocusSchemaVersion":2,"teachingFocus":{"examFocus":"模拟：计算整数和。","studentRequirements":["能写出正确的和。"]},"primaryKnowledgeUids":["leaf-a"],"solutionPaths":[{"id":"verified-path","requiredKnowledgeUids":["leaf-a","leaf-b"],"requiredPremises":["real-premise"],"basis":"模拟：依据已核验路径先明确两数，再逐步相加完成整题。"}],"task":{"id":"real-task","label":"模拟任务"},"issues":[]})
    }

    #[test]
    fn metadata_rejects_false_leaves_invented_dependencies_missing_primary_and_extra_math() {
        metadata(&clean_metadata(), "q1", &catalogue()).unwrap();
        for mode in 0..9 {
            let mut candidate = clean_metadata();
            match mode {
                0 => candidate["primaryKnowledgeUids"] = json!(["invented"]),
                1 => candidate["primaryKnowledgeUids"] = json!(["group"]),
                2 => candidate["primaryKnowledgeUids"] = json!(["missing-flag"]),
                3 => candidate["solutionPaths"][0]["requiredKnowledgeUids"] = json!(["leaf-b"]),
                4 => {
                    candidate["solutionPaths"][0]["requiredPremises"] = json!(["invented-premise"])
                }
                5 => candidate["solutionPaths"][0]["basis"] = json!(""),
                6 => candidate["answer"] = json!("unauthorized-math"),
                7 => candidate["task"]["id"] = json!("invented-task"),
                _ => {
                    candidate["solutionPaths"]
                        .as_array_mut()
                        .unwrap()
                        .push(clean_metadata()["solutionPaths"][0].clone());
                }
            }
            assert!(
                metadata(&candidate, "q1", &catalogue()).is_err(),
                "mode={mode}"
            );
        }
    }

    #[test]
    fn metadata_keeps_legal_unknowns_instead_of_fabricating_coverage() {
        let mut candidate = clean_metadata();
        candidate["difficultyAssessment"] = json!({"level":null,"basis":""});
        candidate["primaryKnowledgeUids"] = json!([]);
        candidate["solutionPaths"] = json!([]);
        candidate["task"] = json!({"id":"","label":""});
        candidate["teachingFocus"] = json!({"examFocus":"","studentRequirements":[]});
        metadata(&candidate, "q1", &catalogue()).unwrap();
        candidate["difficultyAssessment"] = json!({"level":"hard","basis":"太难"});
        assert!(metadata(&candidate, "q1", &catalogue()).is_err());
    }
}
