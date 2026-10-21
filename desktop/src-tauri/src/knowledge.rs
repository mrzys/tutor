//! Per-question assessment and per-solution dependencies. Curriculum hierarchy
//! provides navigation only; related/prerequisite graph edges are never expanded.
use crate::error::{AppError, AppResult};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashSet};

fn invalid(message: &str) -> AppError {
    AppError::new("invalid_mapping", message)
}
fn array(value: &Value) -> impl Iterator<Item = &Value> {
    value.as_array().into_iter().flatten()
}
fn points(config: &Value) -> impl Iterator<Item = &Value> {
    array(&config["knowledgeCatalogue"]["points"])
}
fn point<'a>(config: &'a Value, uid: &str) -> Option<&'a Value> {
    points(config).find(|point| point["uid"] == uid)
}
pub fn catalogue(raw_points: &[Value], mappings: &[Value]) -> Value {
    json!({"points":raw_points.iter().map(|row| {
        let uid = row["knowledge_uid"].as_str().unwrap_or_default();
        let has_children = raw_points.iter().any(|candidate| candidate["parent_uid"] == uid);
        let is_leaf = row["is_leaf"].as_i64() == Some(1) && !has_children;
        let sections: BTreeSet<String> = mappings.iter()
            .filter(|mapping| mapping["knowledge_uid"] == uid)
            .filter_map(|mapping| mapping["section_id"].as_str())
            .map(crate::intake::canonical).collect();
        json!({"uid":uid,"name":row["name"],"parentUid":row["parent_uid"],"sectionIds":sections,"isLeaf":is_leaf})
    }).collect::<Vec<_>>()})
}
pub fn uses_knowledge(annotation: &Value) -> bool {
    annotation.get("primaryKnowledgeUids").is_some()
        || annotation.get("knowledgeSchemaVersion").is_some()
        || array(&annotation["solutionPaths"])
            .any(|path| path.get("requiredKnowledgeUids").is_some())
}
fn string_list(value: &Value, label: &str) -> AppResult<Vec<String>> {
    let rows = value
        .as_array()
        .filter(|rows| rows.len() <= 600)
        .ok_or_else(|| invalid(&format!("{label}需为标识数组。")))?;
    let mut seen = HashSet::new();
    rows.iter()
        .map(|row| {
            let uid = row
                .as_str()
                .filter(|uid| {
                    !uid.is_empty() && uid.len() <= 300 && !uid.chars().any(char::is_control)
                })
                .ok_or_else(|| invalid(&format!("{label}包含无效标识。")))?;
            if !seen.insert(uid) {
                return Err(invalid(&format!("{label}包含重复标识。")));
            }
            Ok(uid.to_owned())
        })
        .collect()
}
pub fn validate_scope_uids(config: &Value, uids: &Value) -> AppResult<()> {
    for uid in string_list(uids, "知识点")? {
        if point(config, &uid).is_none() {
            return Err(invalid("知识点需使用现有目录的真实 UID。"));
        }
    }
    Ok(())
}
/// Incomplete annotations can be retained for manual use. Completeness is
/// assessed per solution at selection time, independently of identity validity.
pub fn validate_annotation(annotation: &Value, config: &Value) -> AppResult<()> {
    if !uses_knowledge(annotation) {
        return Ok(());
    }
    if annotation
        .get("knowledgeSchemaVersion")
        .is_some_and(|v| v != 2)
    {
        return Err(invalid("知识点标注版本无效。"));
    }
    validate_scope_uids(config, &annotation["primaryKnowledgeUids"])?;
    let paths = annotation["solutionPaths"]
        .as_array()
        .filter(|rows| rows.len() <= 20)
        .ok_or_else(|| invalid("解法需为路径数组。"))?;
    let mut seen = HashSet::new();
    for path in paths {
        let id = path["id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 100 && !id.chars().any(char::is_control))
            .ok_or_else(|| invalid("解法路径缺少有效身份。"))?;
        if !seen.insert(id) {
            return Err(invalid("解法路径身份不能重复。"));
        }
        validate_scope_uids(config, &path["requiredKnowledgeUids"])?;
        string_list(&path["requiredPremises"], "解法前提")?;
        if path["basis"]
            .as_str()
            .is_none_or(|basis| basis.chars().count() > 10_000)
        {
            return Err(invalid("解法依据需为文本。"));
        }
    }
    Ok(())
}
/// New model annotations must identify actual leaves. Historic records and
/// navigation scopes continue using the permissive identity validator above.
pub fn validate_leaf_annotation(annotation: &Value, config: &Value) -> AppResult<()> {
    let mut selected = string_list(&annotation["primaryKnowledgeUids"], "主考知识点")?;
    for path in array(&annotation["solutionPaths"]) {
        selected.extend(string_list(&path["requiredKnowledgeUids"], "解法知识点")?);
    }
    for uid in selected {
        let selected =
            point(config, &uid).ok_or_else(|| invalid("知识点需使用现有目录的真实 UID。"))?;
        if selected["isLeaf"] == false
            || points(config).any(|candidate| candidate["parentUid"] == uid)
        {
            return Err(invalid(
                "主考及解法知识点只能选择真实叶知识点；父级目录用于导航，不能代替具体知识点。",
            ));
        }
    }
    Ok(())
}
fn within(config: &Value, uid: &str, ancestor: &str) -> bool {
    let mut current = Some(uid);
    let mut seen = HashSet::new();
    while let Some(id) = current {
        if !seen.insert(id) {
            return false;
        }
        if id == ancestor {
            return true;
        }
        current = point(config, id).and_then(|point| point["parentUid"].as_str());
    }
    false
}
fn sections_for_uid(config: &Value, uid: &str) -> BTreeSet<String> {
    let Some(current) = point(config, uid) else {
        return BTreeSet::new();
    };
    let direct = |point: &Value| -> BTreeSet<String> {
        array(&point["sectionIds"])
            .filter_map(Value::as_str)
            .map(crate::intake::canonical)
            .collect()
    };
    let sections = direct(current);
    if !sections.is_empty() {
        return sections;
    }
    // A grouping node may have only mapped descendants. This is a curriculum
    // projection and never adds descendant UIDs to a question's annotation.
    let sections: BTreeSet<_> = points(config)
        .filter(|p| {
            p["uid"]
                .as_str()
                .is_some_and(|id| id != uid && within(config, id, uid))
        })
        .flat_map(direct)
        .collect();
    if !sections.is_empty() {
        return sections;
    }
    BTreeSet::new()
}
pub fn sections_for_uids(config: &Value, uids: &Value) -> Vec<String> {
    array(uids)
        .filter_map(Value::as_str)
        .flat_map(|uid| sections_for_uid(config, uid))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}
pub fn primary_sections(annotation: &Value, config: &Value) -> Vec<String> {
    if uses_knowledge(annotation) {
        sections_for_uids(config, &annotation["primaryKnowledgeUids"])
    } else {
        array(&annotation["primarySections"])
            .filter_map(Value::as_str)
            .map(crate::intake::canonical)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }
}
pub fn uid_in_scope(
    uid: &str,
    sections: &Value,
    explicit_uids: Option<&Value>,
    config: &Value,
) -> bool {
    if point(config, uid).is_none() {
        return false;
    }
    if let Some(scope) = explicit_uids {
        return validate_scope_uids(config, scope).is_ok()
            && array(scope)
                .filter_map(Value::as_str)
                .any(|allowed| within(config, uid, allowed));
    }
    // A grouping label can span multiple sections. Its navigation projection
    // does not prove the entire group is allowed by one matching section.
    if points(config).any(|candidate| candidate["parentUid"] == uid) {
        return false;
    }
    let mapped = sections_for_uid(config, uid);
    array(sections)
        .filter_map(Value::as_str)
        .any(|section| mapped.contains(&crate::intake::canonical(section)))
}
pub fn names(config: &Value, uids: &Value) -> Vec<String> {
    array(uids)
        .filter_map(Value::as_str)
        .filter_map(|uid| point(config, uid).and_then(|p| p["name"].as_str()))
        .map(str::to_owned)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalogue_leaf_flag_requires_source_flag_and_no_actual_children() {
        let raw = json!([
            {"knowledge_uid":"parent","parent_uid":null,"is_leaf":1,"name":"模拟父级误旗标"},
            {"knowledge_uid":"child","parent_uid":"parent","is_leaf":1,"name":"模拟叶"},
            {"knowledge_uid":"empty-group","parent_uid":null,"is_leaf":0,"name":"模拟空组"},
            {"knowledge_uid":"unknown-flag","parent_uid":null,"name":"模拟缺旗标"}
        ]);
        let catalogue = catalogue(raw.as_array().unwrap(), &[]);
        let c = json!({"knowledgeCatalogue":catalogue});
        assert_eq!(point(&c, "parent").unwrap()["isLeaf"], false);
        assert_eq!(point(&c, "child").unwrap()["isLeaf"], true);
        assert_eq!(point(&c, "child").unwrap()["parentUid"], "parent");
        assert_eq!(point(&c, "empty-group").unwrap()["isLeaf"], false);
        assert_eq!(point(&c, "unknown-flag").unwrap()["isLeaf"], false);
        for uid in ["parent", "empty-group", "unknown-flag"] {
            let a =
                json!({"knowledgeSchemaVersion":2,"primaryKnowledgeUids":[uid],"solutionPaths":[]});
            assert!(
                validate_annotation(&a, &c).is_ok(),
                "historic grouping identities remain readable"
            );
            assert!(validate_leaf_annotation(&a, &c).is_err());
        }
        let mut a =
            json!({"knowledgeSchemaVersion":2,"primaryKnowledgeUids":["child"],"solutionPaths":[]});
        validate_leaf_annotation(&a, &c).unwrap();
        a["solutionPaths"] = json!([{"id":"path","requiredKnowledgeUids":["parent"]}]);
        assert!(validate_leaf_annotation(&a, &c).is_err());
        a["solutionPaths"] = json!([]);
        a["primaryKnowledgeUids"] = json!([]);
        validate_leaf_annotation(&a, &c).unwrap();
    }
    fn config() -> Value {
        json!({"knowledgeCatalogue":{"points":[
            {"uid":"group","parentUid":null,"sectionIds":[]},
            {"uid":"intersection","name":"交集","parentUid":"group","sectionIds":["1.3"]},
            {"uid":"enumeration","name":"列举法","parentUid":"group","sectionIds":["1.1"]},
            {"uid":"membership","name":"属于","parentUid":"group","sectionIds":["1.1"]}
        ]},"knowledge_relations":[{"source":"membership","target":"enumeration","relation":"prerequisites"}]})
    }
    #[test]
    fn exact_knowledge_overrides_broad_section_and_never_traverses_prerequisites() {
        let c = config();
        assert!(uid_in_scope("enumeration", &json!(["1.1"]), None, &c));
        assert!(!uid_in_scope(
            "enumeration",
            &json!(["1.1"]),
            Some(&json!(["membership"])),
            &c
        ));
        assert!(uid_in_scope(
            "intersection",
            &json!([]),
            Some(&json!(["group"])),
            &c
        ));
        assert!(!uid_in_scope("group", &json!(["1.1"]), None, &c));
        assert_eq!(
            sections_for_uids(&c, &json!(["intersection"])),
            vec!["rja-compulsory-1:1.3"]
        );
    }
    #[test]
    fn annotations_preserve_unknown_completeness_but_reject_invalid_identity() {
        let c = config();
        let mut a = json!({"knowledgeSchemaVersion":2,"primaryKnowledgeUids":[],"primarySections":["1.1"],"solutionPaths":[]});
        assert!(uses_knowledge(&a));
        validate_annotation(&a, &c).unwrap();
        assert!(primary_sections(&a, &c).is_empty());
        a["primaryKnowledgeUids"] = json!(["unknown"]);
        assert!(validate_annotation(&a, &c).is_err());
        a["primaryKnowledgeUids"] = json!(["intersection"]);
        a["solutionPaths"] =
            json!([{"id":"path","requiredKnowledgeUids":[],"requiredPremises":[],"basis":""}]);
        validate_annotation(&a, &c).unwrap();
        a["solutionPaths"][0]["requiredKnowledgeUids"] = json!(["unknown"]);
        assert!(validate_annotation(&a, &c).is_err());
    }
}
