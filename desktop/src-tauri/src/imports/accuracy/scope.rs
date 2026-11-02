//! A narrower publication scope removes only explicitly withheld artifacts.
//! It never clears findings or rewrites a partially understood source problem.
use serde_json::Value;

pub(super) fn publication_scope(state: &Value) -> &str {
    if state["publicationScope"] == "source_only" {
        "source_only"
    } else {
        "source_and_teaching"
    }
}

fn good(report: &Value) -> bool {
    matches!(
        report["status"].as_str(),
        Some("no_issue_found" | "teacher_reviewed")
    )
}
fn rows(value: &Value) -> impl Iterator<Item = &Value> {
    value.as_array().into_iter().flatten()
}
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
fn checked(report: &Value, target: &str) -> bool {
    rows(&report["checks"])
        .filter(|check| {
            text(check, "target") == target
                && check["status"] == "checked"
                && !text(check, "basis").trim().is_empty()
        })
        .count()
        == 1
        && rows(&report["checks"])
            .filter(|check| text(check, "target") == target)
            .count()
            == 1
}
fn under(path: &str, field: &str) -> bool {
    path == field
        || path
            .strip_prefix(field)
            .is_some_and(|tail| tail.starts_with('.') || tail.starts_with('['))
}
fn source_target(path: &str) -> bool {
    [
        "originalProblemValidity",
        "originalReference",
        "student",
        "teacher",
        "stem",
        "options",
        "source",
        "sourceIdentity",
        "sourceBlockIds",
        "sourceMaterialRoles",
    ]
    .iter()
    .any(|field| under(path, field))
        || path.starts_with("parts.") && path.ends_with(".originalReference")
        || path.starts_with("parts[")
            && (path.ends_with(".prompt")
                || path.ends_with(".stem")
                || path.contains(".originalReference"))
}
fn excluded_math_finding(finding: &Value) -> bool {
    let path = text(finding, "fieldPath");
    let domain = text(finding, "domain");
    if matches!(
        domain,
        "source" | "original_reference" | "source_defect" | "source_problem"
    ) || source_target(path)
    {
        return false;
    }
    if [
        "candidate",
        "generated_solution",
        "answer",
        "solution",
        "teachingSolution",
    ]
    .iter()
    .any(|field| under(path, field))
    {
        return true;
    }
    if path.starts_with("parts.") && (path.ends_with(".answer") || path.ends_with(".proof")) {
        return true;
    }
    domain == "generated_solution" && !path.is_empty()
}
fn excluded_teaching_finding(finding: &Value) -> bool {
    let path = text(finding, "fieldPath");
    if [
        "primaryKnowledgeUids",
        "solutionPaths",
        "task",
        "tasks",
        "difficultyAssessment",
        "difficultyLevel",
        "difficultyBasis",
        "difficultyRubricVersion",
        "requiredKnowledgeUids",
        "requiredPremises",
    ]
    .iter()
    .any(|field| under(path, field))
    {
        return false;
    }
    // All focus text lives in teachingAnalysis, the artifact withheld by this
    // scope. Metadata identity, knowledge, task and difficulty still publish.
    under(path, "teachingFocus") || under(path, "candidate.teachingFocus")
}

pub(super) fn eligible_reports(
    q: &Value,
    state: &Value,
    source: &Value,
    math: &Value,
    teaching: &Value,
) -> bool {
    if publication_scope(state) != "source_only" {
        return good(source) && good(math) && good(teaching);
    }
    if !good(source) || state["metadata"].is_null() || state["catalogue"].is_null() {
        return false;
    }
    let mut math_targets = vec![
        "originalProblemValidity".to_owned(),
        "originalReference.answer".to_owned(),
        "originalReference.solution".to_owned(),
    ];
    for part in rows(&q["parts"]) {
        let id = text(part, "partId");
        if id.is_empty() {
            return false;
        }
        math_targets.push(format!("parts.{id}.originalReference"));
    }
    if math_targets.iter().any(|target| !checked(math, target)) {
        return false;
    }
    if rows(&math["findings"]).any(|finding| !excluded_math_finding(finding)) {
        return false;
    }
    if rows(&math["disagreements"]).any(|disagreement| {
        if text(disagreement, "classification") == "source_problem" {
            return true;
        }
        if text(disagreement, "classification") != "unresolved" {
            return false;
        }
        let fields = rows(&disagreement["affectedFields"]).collect::<Vec<_>>();
        fields.is_empty()
            || fields.iter().any(|field| {
                let candidate = serde_json::json!({"fieldPath":field});
                !excluded_math_finding(&candidate)
            })
    }) {
        return false;
    }
    let metadata_targets = [
        "primaryKnowledgeUids",
        "solutionPaths",
        "task",
        "difficultyAssessment",
    ];
    if metadata_targets
        .iter()
        .any(|target| !checked(teaching, target))
    {
        return false;
    }
    if rows(&teaching["findings"]).any(|finding| !excluded_teaching_finding(finding)) {
        return false;
    }
    // A failed/missing report must never acquire scoped eligibility merely
    // because an empty list happens to contain no findings.
    matches!(
        math["status"].as_str(),
        Some("no_issue_found" | "issues_found" | "unresolved" | "teacher_reviewed")
    ) && matches!(
        teaching["status"].as_str(),
        Some("no_issue_found" | "issues_found" | "unresolved" | "teacher_reviewed")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn report(targets: &[&str]) -> Value {
        json!({"status":"no_issue_found","checks":targets.iter().map(|target|json!({"target":target,"status":"checked","basis":"模拟：已实际核对该字段及所需依据。"})).collect::<Vec<_>>(),"findings":[]})
    }
    fn state() -> Value {
        json!({"publicationScope":"source_only","metadata":{"id":"actual-selected-metadata"},"catalogue":{"id":"actual-catalogue"}})
    }
    fn math() -> Value {
        report(&[
            "originalProblemValidity",
            "originalReference.answer",
            "originalReference.solution",
            "candidate.answer",
            "candidate.solution",
        ])
    }
    fn teaching() -> Value {
        report(&[
            "primaryKnowledgeUids",
            "solutionPaths",
            "task",
            "difficultyAssessment",
            "teachingFocus.examFocus",
            "teachingFocus.studentRequirements",
        ])
    }
    fn source() -> Value {
        report(&["student.stem"])
    }
    #[test]
    fn explicit_source_only_can_withhold_generated_errors_but_full_scope_cannot() {
        let mut math = math();
        math["status"] = json!("issues_found");
        math["checks"][3]["status"] = json!("issue");
        math["findings"] = json!([{"fieldPath":"candidate.answer","domain":"generated_solution","message":"模拟AI候选算错，原题和原参考均已核对。"}]);
        let mut teaching = teaching();
        teaching["status"] = json!("unresolved");
        teaching["checks"][4]["status"] = json!("unresolved");
        teaching["findings"] =
            json!([{"fieldPath":"teachingFocus.examFocus","message":"模拟课堂说明暂未确认。"}]);
        assert!(eligible_reports(
            &json!({"parts":[]}),
            &state(),
            &source(),
            &math,
            &teaching
        ));
        assert!(!eligible_reports(
            &json!({"parts":[]}),
            &json!({}),
            &source(),
            &math,
            &teaching
        ));
        assert_eq!(
            publication_scope(&json!({"publicationScope":"unexpected"})),
            "source_and_teaching"
        );
    }
    #[test]
    fn source_only_still_blocks_source_defects_original_reference_and_unknown_locations() {
        for finding in [
            json!({"domain":"source","fieldPath":"stem"}),
            json!({"fieldPath":"originalReference.answer"}),
            json!({"domain":"math","fieldPath":""}),
        ] {
            let mut math = math();
            math["status"] = json!("issues_found");
            math["findings"] = json!([finding]);
            assert!(!eligible_reports(
                &json!({"parts":[]}),
                &state(),
                &source(),
                &math,
                &teaching()
            ));
        }
        let mut math = math();
        math["checks"][0]["status"] = json!("unresolved");
        assert!(!eligible_reports(
            &json!({"parts":[]}),
            &state(),
            &source(),
            &math,
            &teaching()
        ));
        let mut source = source();
        source["status"] = json!("unresolved");
        assert!(!eligible_reports(
            &json!({"parts":[]}),
            &state(),
            &source,
            &self::math(),
            &teaching()
        ));
    }
    #[test]
    fn source_only_checks_every_original_part_and_actual_metadata_and_requires_selected_draft() {
        let q = json!({"parts":[{"partId":"p1"},{"partId":"p2"}]});
        let mut math = math();
        assert!(!eligible_reports(
            &q,
            &state(),
            &source(),
            &math,
            &teaching()
        ));
        for id in ["p1", "p2"] {
            math["checks"].as_array_mut().unwrap().push(json!({"target":format!("parts.{id}.originalReference"),"status":"checked","basis":"模拟：原卷该小问参考已完整核对。"}));
        }
        assert!(eligible_reports(
            &q,
            &state(),
            &source(),
            &math,
            &teaching()
        ));
        let mut bad = teaching();
        bad["findings"] = json!([{"fieldPath":"solutionPaths[0].requiredKnowledgeUids"}]);
        assert!(!eligible_reports(&q, &state(), &source(), &math, &bad));
        let mut missing = state();
        missing["metadata"] = Value::Null;
        assert!(!eligible_reports(
            &q,
            &missing,
            &source(),
            &math,
            &teaching()
        ));
    }
    #[test]
    fn unknown_or_duplicate_required_check_never_inherits_an_unrelated_checked_target() {
        let mut math = math();
        let duplicate = math["checks"][0].clone();
        math["checks"].as_array_mut().unwrap().push(duplicate);
        assert!(!eligible_reports(
            &json!({"parts":[]}),
            &state(),
            &source(),
            &math,
            &teaching()
        ));
        assert!(!eligible_reports(
            &json!({"parts":[]}),
            &state(),
            &source(),
            &Value::Null,
            &teaching()
        ));
    }
}
