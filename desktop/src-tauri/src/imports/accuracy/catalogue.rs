//! A lossless identity projection for model transport. The original catalogue
//! remains the validation authority; column positions are never output IDs.
use super::*;

const PROJECTION: &str = "accuracy-catalogue-columns-rows-v1";

fn table(value: &Value, preferred: &[&str]) -> Value {
    let records = rows(value);
    let mut columns: Vec<String> = preferred.iter().map(|key| (*key).to_owned()).collect();
    let extra: std::collections::BTreeSet<_> = records
        .iter()
        .filter_map(Value::as_object)
        .flat_map(|record| record.keys())
        .filter(|key| !columns.contains(key))
        .cloned()
        .collect();
    columns.extend(extra);
    let matrix: Vec<Vec<Value>> = records
        .iter()
        .map(|record| columns.iter().map(|key| record[key].clone()).collect())
        .collect();
    json!({"format":"columns_rows_v1","columns":columns,"rows":matrix})
}

pub(super) fn model_input(full: &Value) -> Value {
    let mut compact = full.clone();
    for (key, columns) in [
        (
            "knowledgePoints",
            &["uid", "name", "parentUid", "isLeaf", "sectionIds"][..],
        ),
        ("sections", &["id", "label"][..]),
        ("premises", &["id", "label", "description"][..]),
        ("tasks", &["id", "label", "questionType", "sectionIds"][..]),
    ] {
        if full[key].is_array() {
            compact[key] = table(&full[key], columns);
        }
    }
    compact["transportEncoding"] = json!({
        "version":PROJECTION,
        "instructions":"各目录表以columns/rows逐行表示，行中第n项对应columns第n列；null表示原目录缺项。全部真实知识点UID、父UID、叶标记、教材关联、任务ID和前提ID均原样保留。输出必须使用表内真实UID/ID，不得用行号、列号、临时别名或推测身份。沿真实parentUid区分同名知识的领域。"
    });
    compact
}

pub(super) fn snapshot(full: &Value) -> Value {
    let input = model_input(full);
    let digest =
        hash_json(&json!({"projectionVersion":PROJECTION,"catalogue":full,"modelInput":input}));
    json!({"projectionVersion":PROJECTION,"catalogue":full,"modelInput":input,"sha256":digest})
}

#[cfg(test)]
pub(super) fn production_catalogue() -> Value {
    let seed: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../resources/seed.json"
    )))
    .unwrap();
    let tables = &seed["bankSnapshot"]["tables"];
    let knowledge = crate::knowledge::catalogue(
        &rows(&tables["knowledge_points"]),
        &rows(&tables["section_knowledge_mappings"]),
    );
    json!({"sections":seed["config"]["chapters"],"premises":seed["config"]["premises"],"tasks":rows(&seed["config"]["tasks"]).iter().map(import_task_identity).collect::<Vec<_>>(),"knowledgePoints":knowledge["points"]})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_seed_projection_keeps_every_identity_and_optional_field_without_directory_filtering() {
        let full = production_catalogue();
        let saved = snapshot(&full);
        assert_eq!(saved["catalogue"], full);
        assert_eq!(saved["modelInput"], model_input(&full));
        assert!(rows(&full["knowledgePoints"]).len() >= 509);
        assert!(rows(&full["tasks"]).len() >= 340);
        for key in ["knowledgePoints", "sections", "premises", "tasks"] {
            let compact = &saved["modelInput"][key];
            assert_eq!(rows(&compact["rows"]).len(), rows(&full[key]).len());
            for (original, row) in rows(&full[key]).iter().zip(rows(&compact["rows"])) {
                for (field, value) in original.as_object().unwrap() {
                    let column = rows(&compact["columns"])
                        .iter()
                        .position(|name| name == field)
                        .unwrap();
                    assert_eq!(
                        &row[column], value,
                        "{key}.{field} lost its actual identity or value"
                    );
                }
            }
        }
        assert!(
            serde_json::to_vec(&saved["modelInput"]).unwrap().len()
                < serde_json::to_vec(&full).unwrap().len()
        );
        let mut changed = full.clone();
        changed["knowledgePoints"][0]["name"] = json!("模拟变更的真实目录名称");
        assert_ne!(snapshot(&changed)["sha256"], saved["sha256"]);
    }

    #[test]
    fn extra_domain_and_version_fields_survive_column_projection() {
        let full = json!({"knowledgePoints":[{"uid":"actual-uid","name":"同名知识","parentUid":"actual-domain","isLeaf":true,"sectionIds":[],"domainUid":"actual-domain","version":"actual-version"}],"tasks":[],"sections":[],"premises":[]});
        let compact = model_input(&full);
        let columns = rows(&compact["knowledgePoints"]["columns"]);
        for key in ["domainUid", "version"] {
            let column = columns.iter().position(|value| value == key).unwrap();
            assert_eq!(
                compact["knowledgePoints"]["rows"][0][column],
                full["knowledgePoints"][0][key]
            );
        }
    }
}
