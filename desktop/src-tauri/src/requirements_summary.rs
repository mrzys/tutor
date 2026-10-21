use crate::intake::{canonical, includes, list, s};
use serde_json::{Value, json};

pub(crate) fn clear_preset_goal(config: &Value, requirements: &mut Value) {
    let defaults = &config["defaultRequirements"];
    let scope = |value: &Value| {
        let mut ids: Vec<_> = list(value)
            .iter()
            .filter_map(Value::as_str)
            .map(canonical)
            .collect();
        ids.sort();
        ids
    };
    if !s(defaults, "goal").is_empty()
        && requirements["goal"] == defaults["goal"]
        && scope(&requirements["mainScope"]) != scope(&defaults["mainScope"])
    {
        requirements["goal"] = json!("");
    }
}

pub(crate) fn ensure_goal(config: &Value, requirements: &mut Value) {
    if !s(requirements, "goal").trim().is_empty() {
        return;
    }
    let number = regex::Regex::new(r"^[\d.]+\s*").unwrap();
    let names: Vec<_> = list(&config["chapters"])
        .iter()
        .filter(|chapter| includes(&requirements["mainScope"], s(chapter, "id")))
        .map(|chapter| number.replace(s(chapter, "label"), "").into_owned())
        .collect();
    let mut scope = names.iter().take(3).cloned().collect::<Vec<_>>().join("、");
    if names.len() > 3 {
        scope.push_str(&format!("等 {} 个小节", names.len()));
    }
    let purpose = match s(requirements, "purpose") {
        "diagnostic" => "学情诊断练习",
        "targeted_practice" => "专项训练",
        _ => "课后巩固练习",
    };
    requirements["goal"] = json!(if scope.is_empty() {
        format!("按所选范围安排{purpose}。")
    } else {
        format!("围绕{scope}安排{purpose}。")
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simulated_scope_summary_clears_only_stale_preset_text_and_preserves_custom_goals() {
        let config = json!({"defaultRequirements":{"mainScope":["1.1"],"goal":"模拟集合模板目标"},"chapters":[
            {"id":"1.1","label":"1.1 集合概念"},
            {"id":"2.1","label":"2.1 等式性质与不等式性质"},
            {"id":"2.2","label":"2.2 基本不等式"},
            {"id":"2.3","label":"2.3 二次函数与一元二次方程、不等式"}
        ]});
        let mut requirements = json!({"mainScope":["2.1","2.2","2.3"],"goal":"模拟集合模板目标","purpose":"consolidation"});
        clear_preset_goal(&config, &mut requirements);
        assert_eq!(requirements["goal"], "");
        ensure_goal(&config, &mut requirements);
        assert_eq!(
            requirements["goal"],
            "围绕等式性质与不等式性质、基本不等式、二次函数与一元二次方程、不等式安排课后巩固练习。"
        );
        requirements["goal"] = json!("教师明确要求比较两种解法");
        clear_preset_goal(&config, &mut requirements);
        ensure_goal(&config, &mut requirements);
        assert_eq!(requirements["goal"], "教师明确要求比较两种解法");
        let mut original_scope =
            json!({"mainScope":["rja-compulsory-1:1.1"],"goal":"模拟集合模板目标"});
        clear_preset_goal(&config, &mut original_scope);
        assert_eq!(original_scope["goal"], "模拟集合模板目标");
    }
}
