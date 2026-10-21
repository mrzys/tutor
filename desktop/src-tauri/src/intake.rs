use crate::{
    bank::BankRepository,
    error::{AppError, AppResult},
    model::ModelClient,
    storage::Store,
};
use regex::Regex;
use serde_json::{Value, json};
use std::sync::atomic::AtomicBool;

pub const TYPES: [&str; 4] = [
    "single_choice",
    "multiple_choice",
    "fill_blank",
    "free_response",
];
pub const DIFFICULTY_LEVELS: [&str; 5] = ["easy", "easy_medium", "medium", "medium_hard", "hard"];
pub fn validate_difficulty_level(value: &Value) -> AppResult<()> {
    if value.is_null()
        || value
            .as_str()
            .is_some_and(|level| DIFFICULTY_LEVELS.contains(&level))
    {
        Ok(())
    } else {
        Err(invalid(
            "难度需为基础、基础偏中等、中等、中等偏较难、较难，或未指定。",
        ))
    }
}
pub fn invalid(message: &str) -> AppError {
    AppError::new("invalid_plan", message)
}
pub fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
pub fn list(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}
pub fn strings(v: &Value) -> Vec<String> {
    list(v)
        .iter()
        .filter_map(|x| x.as_str().map(str::to_owned))
        .collect()
}
pub fn canonical(id: &str) -> String {
    if ["1.1", "1.2", "1.3"].contains(&id) {
        format!("rja-compulsory-1:{id}")
    } else {
        id.to_owned()
    }
}
pub fn includes(scope: &Value, id: &str) -> bool {
    strings(scope).iter().any(|x| canonical(x) == canonical(id))
}
pub fn overlaps(a: &Value, b: &Value) -> bool {
    strings(a).iter().any(|id| includes(b, id))
}
pub fn merge(base: &Value, patch: &Value) -> Value {
    let mut result = base.clone();
    if let (Some(target), Some(fields)) = (result.as_object_mut(), patch.as_object()) {
        for (key, value) in fields {
            target.insert(key.clone(), value.clone());
        }
    }
    result
}
pub fn model_context(value: &Value) -> Value {
    match value {
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .filter(|(k, _)| {
                    !["student", "students", "studentId", "studentIds"].contains(&k.as_str())
                })
                .map(|(k, v)| (k.clone(), model_context(v)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(model_context).collect()),
        _ => value.clone(),
    }
}
fn title_valid(title: &str) -> bool {
    !title.trim().is_empty() && title.chars().count() <= 120 && !title.chars().any(char::is_control)
}
pub fn validate_title(title: &str) -> AppResult<String> {
    if !title_valid(title) {
        return Err(invalid(
            "试卷名称需为 1～120 个字符，不能包含换行或控制字符。",
        ));
    }
    Ok(title.trim().to_owned())
}
fn int(v: &Value, label: &str, low: u64, high: u64) -> AppResult<u64> {
    v.as_u64()
        .filter(|n| *n >= low && *n <= high)
        .ok_or_else(|| invalid(&format!("{label}需为 {low}～{high} 的整数。")))
}
pub fn normalize(store: &Store, input: &Value) -> AppResult<Value> {
    if !input.is_object() {
        return Err(invalid("需求需为对象。"));
    }
    let config = store.bank.config()?;
    let mut r = merge(&config["defaultRequirements"], input);
    if !r.is_object() {
        return Err(invalid("缺少本地组卷配置。"));
    }
    if input.get("subject").is_some_and(|value| value != "math") {
        return Err(invalid("当前仅开放数学。"));
    }
    r["subject"] = json!("math");
    if !["consolidation", "targeted_practice", "diagnostic"].contains(&s(&r, "purpose")) {
        if input.get("purpose").is_some() {
            return Err(invalid("当前仅支持课后巩固、专项训练和学情诊断。"));
        }
        r["purpose"] = json!("consolidation");
    }
    if input.get("scoringMode").is_none() {
        r["scoringMode"] = json!("none");
    }
    if !["none", "points"].contains(&s(&r, "scoringMode")) {
        return Err(invalid("计分方式无效。"));
    }
    if s(&r, "scoringMode") == "none" {
        r["targetScore"] = json!(0);
    } else {
        int(&r["targetScore"], "总分", 1, 1000)?;
    }
    int(&r["durationMinutes"], "时长", 1, 300)?;
    // Older confirmed requirements and the original default ratio predate multi-select.
    // Absence means zero, never an implicit request to change their composition.
    if r["counts"].is_object() && r["counts"].get("multiple_choice").is_none() {
        r["counts"]["multiple_choice"] = json!(0);
    }
    let mut total = 0;
    for kind in TYPES {
        total += int(&r["counts"][kind], "题量", 0, 30)?;
    }
    if total == 0 || total > 60 {
        return Err(invalid("总题量需为 1～60。"));
    }
    r["questionCount"] = json!(total);
    for field in ["mainScope", "learnedScope", "premises", "sourceIds"] {
        let values = r[field]
            .as_array()
            .ok_or_else(|| invalid("范围与前提需为数组。"))?;
        let allowed = if field == "premises" {
            list(&config["premises"])
                .iter()
                .map(|x| s(x, "id").to_owned())
                .collect::<Vec<_>>()
        } else if field == "sourceIds" {
            list(&config["sourceManifest"]["sources"])
                .iter()
                .map(|x| s(x, "sourceId").to_owned())
                .collect()
        } else {
            list(&config["chapters"])
                .iter()
                .map(|x| s(x, "id").to_owned())
                .collect()
        };
        let mut seen = std::collections::HashSet::new();
        for value in values {
            let id = value.as_str().ok_or_else(|| invalid("范围身份无效。"))?;
            let valid = if field.ends_with("Scope") {
                allowed.iter().any(|a| canonical(a) == canonical(id))
            } else {
                allowed.iter().any(|a| a == id)
            };
            if !valid || !seen.insert(id) {
                return Err(invalid("范围包含未知或重复项目。"));
            }
        }
    }
    if list(&r["mainScope"]).is_empty() {
        return Err(invalid("请选择考查范围。"));
    }
    for field in ["mainKnowledgeUids", "learnedKnowledgeUids"] {
        if let Some(uids) = r.get(field) {
            crate::knowledge::validate_scope_uids(&config, uids)?;
            if field == "mainKnowledgeUids" && list(uids).is_empty() {
                return Err(invalid("请选择至少一个主考知识点。"));
            }
        }
    }
    r["automaticFoundation"] = input
        .get("automaticFoundation")
        .cloned()
        .unwrap_or(json!(true));
    if !r["automaticFoundation"].is_boolean() {
        return Err(invalid("基础前提开关无效。"));
    }
    r["foundationPremises"] = if r["automaticFoundation"] == true {
        json!(["quadratic_basics", "absolute_root", "basic_geometry"])
    } else {
        json!([])
    };
    if !r["targetDifficulty"].is_null()
        && !r["targetDifficulty"]
            .as_f64()
            .is_some_and(|n| (0.0..=1.0).contains(&n))
    {
        return Err(invalid("目标难度需在 0～1 之间。"));
    }
    if let Some(level) = r.get("targetDifficultyLevel") {
        validate_difficulty_level(level)?;
    }
    if r.get("teachingGoals").is_none() {
        r["teachingGoals"] = json!([]);
    }
    let goals = r["teachingGoals"]
        .as_array()
        .ok_or_else(|| invalid("教学目标需为数组。"))?;
    if goals.len() > 20 {
        return Err(invalid("教学目标最多 20 项。"));
    }
    let mut seen = std::collections::HashSet::new();
    for goal in goals {
        if s(goal, "id").is_empty()
            || !seen.insert(s(goal, "id"))
            || !goal["version"].as_u64().is_some_and(|n| n > 0)
            || !["preferred", "required"].contains(&s(goal, "priority"))
            || !goal["observable"].is_string()
            || s(goal, "observable").chars().count() > 1000
            || !["unspecified", "understand", "apply", "reason"].contains(&s(goal, "cognition"))
            || !["unspecified", "provided", "independent"]
                .contains(&s(&goal["conditions"], "prompt"))
            || !["unspecified", "answer", "written_reasoning"]
                .contains(&s(&goal["conditions"], "response"))
            || s(&goal["source"], "kind") != "teacher"
            || !goal["source"]["text"].is_string()
            || !goal["knowledgeScope"].is_array()
            || strings(&goal["knowledgeScope"]).iter().any(|id| {
                !includes(
                    &json!(
                        list(&config["chapters"])
                            .iter()
                            .map(|x| x["id"].clone())
                            .collect::<Vec<_>>()
                    ),
                    id,
                )
            })
        {
            return Err(invalid("教学目标身份、版本或范围无效。"));
        }
    }
    let excluded = strings(&r["typeConstraints"]["excludedTypes"]);
    for kind in &excluded {
        if !TYPES.contains(&kind.as_str()) || r["counts"][kind].as_u64() != Some(0) {
            return Err(invalid("题量与排除的题型冲突。"));
        }
    }
    if let Some(exact) = r["typeConstraints"]["exactCounts"].as_object() {
        for (kind, count) in exact {
            if !TYPES.contains(&kind.as_str()) || r["counts"][kind] != *count {
                return Err(invalid("题量与教师指定的题型数量冲突。"));
            }
        }
    }
    if let Some(student) = input.get("student") {
        if student.is_null() {
            r.as_object_mut().unwrap().remove("student");
        } else {
            let id = student["studentId"]
                .as_str()
                .or(student["id"].as_str())
                .ok_or_else(|| invalid("关联学生身份无效。"))?;
            r["student"] = store.student(id)?;
        }
    }
    r.as_object_mut().unwrap().remove("studentId");
    if let Some(title) = input["title"].as_str().filter(|x| !x.trim().is_empty()) {
        r["title"] = json!(validate_title(title)?);
    } else {
        let scope = list(&config["chapters"])
            .into_iter()
            .find(|c| includes(&r["mainScope"], s(c, "id")))
            .map(|c| s(&c, "label").to_owned())
            .unwrap_or("数学练习".into());
        let simple = Regex::new(r"^[\d.]+\s*")
            .unwrap()
            .replace(&scope, "")
            .to_string();
        let short: String = simple.chars().take(16).collect();
        let purpose = match s(&r, "purpose") {
            "diagnostic" => "学情诊断",
            "targeted_practice" => "专项训练",
            _ => "课后巩固",
        };
        r["title"] = json!(format!("{short} · {purpose}"));
    }
    if r["goal"].as_str().unwrap_or("").chars().count() > 1000 {
        return Err(invalid("教学目标过长。"));
    }
    Ok(r)
}

fn chinese_number(text: &str) -> Option<u64> {
    if let Ok(n) = text.parse() {
        return Some(n);
    }
    let digit = |c| match c {
        '零' | '〇' => Some(0),
        '一' => Some(1),
        '二' | '两' => Some(2),
        '三' => Some(3),
        '四' => Some(4),
        '五' => Some(5),
        '六' => Some(6),
        '七' => Some(7),
        '八' => Some(8),
        '九' => Some(9),
        _ => None,
    };
    if let Some((a, b)) = text.split_once('十') {
        if a.chars().count() > 1 || b.chars().count() > 1 {
            return None;
        }
        Some(
            if a.is_empty() {
                1
            } else {
                digit(a.chars().next()?)?
            } * 10
                + if b.is_empty() {
                    0
                } else {
                    digit(b.chars().next()?)?
                },
        )
    } else {
        if text.chars().count() != 1 {
            return None;
        }
        digit(text.chars().next()?)
    }
}

// Process explicit statements in their textual order. A later correction wins;
// model suggestions never override teacher duration/scoring choices.
fn explicit_size_fields(requirements: &mut Value, message: &str) -> AppResult<()> {
    let number = r"([0-9]+|[一二两三四五六七八九十零〇]+)";
    let duration_re = Regex::new(&format!(r"{number}\s*(分钟|小时)")).unwrap();
    let mut duration = None;
    for capture in duration_re.captures_iter(message) {
        let value = chinese_number(&capture[1]).ok_or_else(|| invalid("时长无法识别。"))?;
        duration = Some(if &capture[2] == "小时" {
            value.checked_mul(60).ok_or_else(|| invalid("时长过大。"))?
        } else {
            value
        });
    }
    if let Some(value) = duration {
        if !(1..=300).contains(&value) {
            return Err(invalid("时长需为 1～300 分钟。"));
        }
        requirements["durationMinutes"] = json!(value);
    }
    let score_re = Regex::new(&format!(r"(?:总分\s*{number}\s*分?|{number}\s*分)")).unwrap();
    let none_re = Regex::new(r"(?:不需要|无需|不用|不要|不)\s*(?:计分|评分|打分|算分)").unwrap();
    let mut statements = Vec::new();
    for capture in score_re.captures_iter(message) {
        let matched = capture.get(0).unwrap();
        if message[matched.end()..].starts_with('钟') {
            continue;
        }
        let prefix = message[..matched.start()].trim_end();
        if ["每题", "每道题", "每道", "各题"]
            .iter()
            .any(|suffix| prefix.ends_with(suffix))
        {
            return Err(invalid(
                "请先说明整卷总分；各题分值可在题位规划或编辑试卷时调整。",
            ));
        }
        let value = chinese_number(capture.get(1).or(capture.get(2)).unwrap().as_str())
            .ok_or_else(|| invalid("总分无法识别。"))?;
        statements.push((matched.start(), Some(value)));
    }
    for matched in none_re.find_iter(message) {
        statements.push((matched.start(), None));
    }
    statements.sort_by_key(|(position, _)| *position);
    if let Some((_, value)) = statements.last() {
        if let Some(value) = value {
            if !(1..=1000).contains(value) {
                return Err(invalid("总分需为 1～1000；不计分请明确说明。"));
            }
            requirements["scoringMode"] = json!("points");
            requirements["targetScore"] = json!(value);
        } else {
            requirements["scoringMode"] = json!("none");
            requirements["targetScore"] = json!(0);
        }
    }
    Ok(())
}
// Explicit teacher quantities remain authoritative even if a model proposes different counts.
pub fn quantities(r: &mut Value, message: &str) -> AppResult<()> {
    let previous_total: u64 = TYPES
        .iter()
        .map(|kind| r["counts"][*kind].as_u64().unwrap_or(0))
        .sum();
    let num = r"([0-9]+|[一二两三四五六七八九十零〇]+)";
    // A classifier permits a short topic/difficulty modifier. Do not cross a
    // sentence boundary, consume section numbers, or guess from vague numbers.
    let total_re = Regex::new(&format!(
        r"{num}\s*(?:(?:道|个)\s*([\p{{Han}}A-Za-z -]{{0,24}}?)(?:题目|题|练习)|(?:题目|题))"
    ))
    .unwrap();
    let mut total = None;
    for capture in total_re.captures_iter(message) {
        let start = capture.get(0).unwrap().start();
        let prefix = &message[..start];
        let modifier = capture.get(2).map(|m| m.as_str().trim()).unwrap_or("");
        let is_type =
            ["单选", "单项选择", "多选", "多项选择", "填空", "解答", "大"].contains(&modifier);
        if !is_type
            && !["单选", "单项选择", "多选", "多项选择", "填空", "解答", "大"]
                .iter()
                .any(|p| prefix.ends_with(p))
        {
            total = Some(
                chinese_number(&capture[1])
                    .ok_or_else(|| invalid("题量无法识别，请使用明确的整数。"))?,
            );
        }
    }
    let labels = [
        ("single_choice", r"(?:单选|单项选择)(?:题)?"),
        ("multiple_choice", r"(?:多选|多项选择)(?:题)?"),
        ("fill_blank", r"填空(?:题)?"),
        ("free_response", r"(?:解答|大)(?:题)?"),
    ];
    let mut exact = r["typeConstraints"]["exactCounts"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let mut excluded = strings(&r["typeConstraints"]["excludedTypes"]);
    let mut only_type = None;
    let mut current_counts = std::collections::HashSet::new();
    let mut current_exclusions = std::collections::HashSet::new();
    for (kind, label) in labels {
        let only = Regex::new(&format!(
            r"(?:只要|仅要|只出|仅出|只做|仅做|只需要|只用|全部(?:为|是|用)?|全是)\s*{label}"
        ))
        .unwrap();
        if only.is_match(message) {
            only_type = Some(kind);
        }
        let re = Regex::new(&format!(
            r"(?:{label}\s*{num}\s*(?:道|题)?|{num}\s*(?:道|个)?\s*{label})"
        ))
        .unwrap();
        for captures in re.captures_iter(message) {
            let n = chinese_number(captures.get(1).or(captures.get(2)).unwrap().as_str())
                .ok_or_else(|| invalid("题量无法识别。"))?;
            if n > 30 {
                return Err(invalid("每个题型最多 30 题。"));
            }
            exact.insert(kind.into(), json!(n));
            current_counts.insert(kind);
            excluded.retain(|value| value != kind);
        }
        let re = Regex::new(&format!(
            r"(?:不要|不需要|不出|不用|排除|去掉|不含|没有)\s*{label}"
        ))
        .unwrap();
        if re.is_match(message) {
            current_exclusions.insert(kind);
            exact.insert(kind.into(), json!(0));
            if !excluded.iter().any(|x| x == kind) {
                excluded.push(kind.into());
            }
        }
    }
    if let Some(only) = only_type {
        if !current_counts.contains(only) && !current_exclusions.contains(only) {
            exact.remove(only);
        }
        for kind in TYPES {
            if kind != only {
                exact.insert(kind.into(), json!(0));
                if !excluded.iter().any(|value| value == kind) {
                    excluded.push(kind.into());
                }
            }
        }
        excluded.retain(|value| value != only);
        if r["counts"][only].as_u64().unwrap_or(0) == 0 {
            r["counts"][only] = json!(1);
        }
    }
    let teacher_exact = exact.clone();
    // Preserve the established default composition. Multi-select is introduced only
    // by explicit counts, an existing nonzero selection, or an exclusive request.
    if !exact.contains_key("multiple_choice")
        && only_type != Some("multiple_choice")
        && r["counts"]["multiple_choice"].as_u64().unwrap_or(0) == 0
    {
        exact.insert("multiple_choice".into(), json!(0));
    }
    let fixed: u64 = exact.values().map(|x| x.as_u64().unwrap_or(0)).sum();
    let requested = total
        .or_else(|| {
            if exact.len() == TYPES.len() || (r.get("questionCount").is_none() && fixed > 0) {
                Some(fixed)
            } else {
                r["questionCount"].as_u64()
            }
        })
        .unwrap_or(previous_total);
    if requested == 0 || requested > 60 {
        return Err(invalid("总题量需为 1～60。"));
    }
    if fixed > requested || (exact.len() == TYPES.len() && fixed != requested) {
        return Err(invalid(
            "教师指定的总题量与各题型数量冲突，请调整其中一项。",
        ));
    }
    let open: Vec<_> = TYPES
        .iter()
        .filter(|kind| !exact.contains_key(**kind))
        .copied()
        .collect();
    let weights: Vec<_> = open
        .iter()
        .map(|kind| r["counts"][*kind].as_u64().unwrap_or(0))
        .collect();
    if requested - fixed > open.len() as u64 * 30 {
        return Err(invalid("指定题型无法容纳此题量，每种题型最多 30 题。"));
    }
    let mut allocated = distribute(requested - fixed, &weights);
    let mut overflow = 0;
    for value in &mut allocated {
        if *value > 30 {
            overflow += *value - 30;
            *value = 30;
        }
    }
    while overflow > 0 {
        for value in &mut allocated {
            if *value < 30 && overflow > 0 {
                *value += 1;
                overflow -= 1;
            }
        }
    }
    for kind in TYPES {
        r["counts"][kind] = exact
            .get(kind)
            .cloned()
            .unwrap_or_else(|| json!(allocated[open.iter().position(|k| *k == kind).unwrap()]));
    }
    r["questionCount"] = json!(requested);
    r["typeConstraints"] = json!({"excludedTypes":excluded,"exactCounts":teacher_exact});
    Ok(())
}
pub fn distribute(total: u64, weights: &[u64]) -> Vec<u64> {
    if weights.is_empty() {
        return vec![];
    }
    let sum: u64 = weights.iter().sum();
    let w: Vec<u64> = if sum == 0 {
        vec![1; weights.len()]
    } else {
        weights.to_vec()
    };
    let sum: u64 = w.iter().sum();
    let mut out: Vec<u64> = w.iter().map(|n| total * n / sum).collect();
    let mut order: Vec<usize> = (0..w.len()).collect();
    order.sort_by_key(|i| std::cmp::Reverse(total * w[*i] % sum));
    for i in order
        .into_iter()
        .take((total - out.iter().sum::<u64>()) as usize)
    {
        out[i] += 1;
    }
    out
}
pub fn prepare(
    store: &Store,
    payload: &Value,
    model: &ModelClient,
    cancel: &AtomicBool,
) -> AppResult<Value> {
    let message = payload["message"].as_str().unwrap_or("");
    if message.chars().count() > 4000 {
        return Err(invalid("补充要求最多 4000 字符。"));
    }
    let config = store.bank.config()?;
    let mut input = merge(&config["defaultRequirements"], &payload["requirements"]);
    if payload["requirements"].get("title").is_none() {
        input.as_object_mut().unwrap().remove("title");
    }
    if payload["requirements"].get("scoringMode").is_none() {
        input["scoringMode"] = json!("none");
    }
    quantities(&mut input, message)?;
    explicit_size_fields(&mut input, message)?;
    let protected = input.clone();
    let mut summary = String::new();
    match s(payload, "mode") {
        "rule" => {}
        "llm" => {
            let proposed=model.propose("intake",&model_context(&json!({"requirements":input,"message":message,"chapters":config["chapters"],"tasks":config["tasks"]})),cancel)?;
            let changes = proposed
                .get("requirements")
                .or(proposed.get("changes"))
                .ok_or_else(|| invalid("AI 需求结果缺少结构化要求。"))?;
            if !changes.is_object() {
                return Err(invalid("AI 需求结构无效。"));
            }
            // Model proposes pedagogy only. Explicit choices never change behind the teacher's back.
            for key in ["goal", "teachingGoals"] {
                if let Some(v) = changes.get(key) {
                    input[key] = v.clone();
                }
            }
            summary = s(&proposed, "summary").to_owned();
        }
        _ => return Err(invalid("请明确选择 AI 整理或规则预设。")),
    }
    for key in ["counts", "questionCount", "typeConstraints"] {
        input[key] = protected[key].clone();
    }
    input["teacherRequest"] = json!(message);
    let requirements = normalize(store, &input)?;
    if summary.is_empty() {
        summary = format!(
            "{}，共 {} 题，{} 分钟。",
            s(&requirements, "title"),
            requirements["questionCount"],
            requirements["durationMinutes"]
        );
    }
    Ok(json!({"requirements":requirements,"summary":summary,"warnings":[]}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn simulated_multiple_choice_quantities_preserve_totals_and_default_ratio() {
        for (message, expected) in [
            ("", [6, 0, 2, 2]),
            (
                "10道题，单选6题，多选2题，填空2题，不要解答题",
                [6, 2, 2, 0],
            ),
            ("10道题，只要多选题", [0, 10, 0, 0]),
            ("只要多项选择题", [0, 10, 0, 0]),
            ("出三道多选题", [0, 3, 0, 0]),
            ("12道题，多项选择2题，不要解答题", [8, 2, 2, 0]),
            ("10道题，不要多选题", [6, 0, 2, 2]),
        ] {
            let mut requirements =
                json!({"counts":{"single_choice":6,"fill_blank":2,"free_response":2}});
            quantities(&mut requirements, message).unwrap();
            for (kind, count) in TYPES.iter().zip(expected) {
                assert_eq!(requirements["counts"][*kind], count, "{message}: {kind}");
            }
            assert_eq!(requirements["questionCount"], expected.iter().sum::<u64>());
        }
        let mut requirements =
            json!({"counts":{"single_choice":6,"fill_blank":2,"free_response":2}});
        assert!(quantities(&mut requirements, "10道题，多选12题").is_err());
        assert!(quantities(&mut requirements, "10道题，只要多选题，不要多选题").is_err());
        let mut previous = json!({"questionCount":10,"counts":{"single_choice":10,"multiple_choice":0,"fill_blank":0,"free_response":0},"typeConstraints":{"exactCounts":{"single_choice":10,"multiple_choice":0,"fill_blank":0,"free_response":0},"excludedTypes":["multiple_choice","fill_blank","free_response"]}});
        quantities(&mut previous, "改成只要多选题").unwrap();
        assert_eq!(previous["counts"]["multiple_choice"], 10);
        assert_eq!(previous["questionCount"], 10);
        assert!(
            !strings(&previous["typeConstraints"]["excludedTypes"])
                .contains(&"multiple_choice".to_owned())
        );
    }
    #[test]
    fn simulated_explicit_knowledge_scopes_preserve_teacher_choices_and_reject_unknown_ids() {
        let directory = tempfile::tempdir().unwrap();
        let seed: Value = serde_json::from_str(include_str!("../../resources/seed.json")).unwrap();
        let store = Store::open(directory.path(), &seed).unwrap();
        let input = json!({"mainScope":["1.1"],"learnedScope":["1.1"],"mainKnowledgeUids":["M-K-01-111"],"learnedKnowledgeUids":[]});
        let normalized = normalize(&store, &input).unwrap();
        assert_eq!(normalized["mainKnowledgeUids"], input["mainKnowledgeUids"]);
        assert_eq!(normalized["learnedKnowledgeUids"], json!([]));
        assert_eq!(normalized["mainScope"], input["mainScope"]);
        for value in [
            json!(["simulated-unknown-uid"]),
            json!(["M-K-01-111", "M-K-01-111"]),
            json!([12]),
            json!(null),
            json!("M-K-01-111"),
        ] {
            for field in ["mainKnowledgeUids", "learnedKnowledgeUids"] {
                let mut invalid = input.clone();
                invalid[field] = value.clone();
                assert!(normalize(&store, &invalid).is_err(), "{field}: {value}");
            }
        }
        let mut empty_main = input.clone();
        empty_main["mainKnowledgeUids"] = json!([]);
        assert!(normalize(&store, &empty_main).is_err());
        let legacy =
            normalize(&store, &json!({"mainScope":["1.1"],"learnedScope":["1.1"]})).unwrap();
        assert!(legacy.get("mainKnowledgeUids").is_none());
        assert!(legacy.get("learnedKnowledgeUids").is_none());
    }
    #[test]
    fn explicit_quantity_and_exclusion_win() {
        let mut r = json!({"counts":{"single_choice":6,"fill_blank":2,"free_response":2}});
        quantities(&mut r, "出12道题，不需要解答题").unwrap();
        assert_eq!(r["questionCount"], 12);
        assert_eq!(r["counts"]["free_response"], 0);
        assert_eq!(
            TYPES
                .iter()
                .map(|k| r["counts"][*k].as_u64().unwrap())
                .sum::<u64>(),
            12
        );
    }
    #[test]
    fn chinese_counts_and_conflict() {
        let mut r = json!({"counts":{"single_choice":6,"fill_blank":2,"free_response":2}});
        quantities(&mut r, "十二道题，单选十题，填空两题，不要解答题").unwrap();
        assert_eq!(r["counts"]["single_choice"], 10);
        assert_eq!(r["counts"]["fill_blank"], 2);
        assert!(quantities(&mut r, "10道题，单选12题").is_err());
    }
    #[test]
    fn natural_topic_modifiers_preserve_teacher_quantity() {
        for (text, total) in [
            ("出12道集合基础题，不要解答题", 12),
            ("出8道基础练习", 8),
            ("10道题目", 10),
            ("先10道题，改成12道集合基础题", 12),
        ] {
            let mut r = json!({"counts":{"single_choice":6,"fill_blank":2,"free_response":2}});
            quantities(&mut r, text).unwrap();
            assert_eq!(r["questionCount"], total, "{text}");
            assert_eq!(
                TYPES
                    .iter()
                    .map(|kind| r["counts"][*kind].as_u64().unwrap())
                    .sum::<u64>(),
                total
            );
            if text.contains("不要解答题") {
                assert_eq!(r["counts"]["free_response"], 0);
            }
        }
        let mut r = json!({"counts":{"single_choice":6,"fill_blank":2,"free_response":2}});
        quantities(&mut r, "出2道单选题").unwrap();
        assert_eq!(r["questionCount"], 2);
        assert_eq!(r["counts"]["single_choice"], 2);
        assert_eq!(r["counts"]["fill_blank"], 0);
        assert_eq!(r["counts"]["free_response"], 0);
        let mut r = json!({"counts":{"single_choice":6,"fill_blank":2,"free_response":2}});
        quantities(&mut r, "10道题，其中2道单选题").unwrap();
        assert_eq!(r["questionCount"], 10);
        assert_eq!(r["counts"]["single_choice"], 2);
    }
    #[test]
    fn malformed_and_excessive_topic_counts_are_not_silently_defaulted() {
        for text in [
            "出61道集合基础题",
            "出1000道基础练习",
            "出9999999999999999999999999道题",
            "出一一道题",
        ] {
            assert!(
                quantities(
                    &mut json!({"counts":{"single_choice":6,"fill_blank":2,"free_response":2}}),
                    text
                )
                .is_err(),
                "{text}"
            );
        }
        let mut r = json!({"counts":{"single_choice":6,"fill_blank":2,"free_response":2}});
        quantities(&mut r, "复习第12页和1.1小节，巩固基础").unwrap();
        assert_eq!(r["questionCount"], 10);
    }
    #[test]
    #[cfg(windows)]
    fn simulated_model_cannot_override_explicit_teacher_quantity_or_receive_student() {
        use std::io::{Read, Write};
        let directory = tempfile::tempdir().unwrap();
        let seed: Value = serde_json::from_str(include_str!("../../resources/seed.json")).unwrap();
        let store = Store::open(directory.path(), &seed).unwrap();
        let student = store
            .create_student(&json!({"name":"模拟私有昵称","operationId":"simulated-model-student"}))
            .unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 4096];
            loop {
                let n = stream.read(&mut buffer).unwrap();
                if n == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..n]);
                if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..end]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            let (key, value) = line.split_once(':')?;
                            if key.eq_ignore_ascii_case("content-length") {
                                value.trim().parse::<usize>().ok()
                            } else {
                                None
                            }
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let end = request.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
            let body: Value = serde_json::from_slice(&request[end + 4..]).unwrap();
            let output = json!({"requirements":{"counts":{"single_choice":30,"fill_blank":30,"free_response":30},"questionCount":90,"scoringMode":"points","targetScore":999,"durationMinutes":299,"mainScope":[],"goal":"模拟模型的教学建议"},"summary":"模拟模型建议"});
            let response =
                json!({"choices":[{"message":{"content":output.to_string()}}]}).to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
            body
        });
        let mut model = ModelClient::open(directory.path()).unwrap();
        model.save(&json!({"baseUrl":format!("http://{address}/v1"),"model":"simulated-model","apiKey":"simulated-not-real-key"})).unwrap();
        let result=prepare(&store,&json!({"requirements":{"student":student},"message":"出12道集合基础题，不要解答题，30分钟，不计分","mode":"llm"}),&model,&AtomicBool::new(false)).unwrap();
        assert_eq!(result["requirements"]["questionCount"], 12);
        assert_eq!(result["requirements"]["counts"]["free_response"], 0);
        assert_eq!(result["requirements"]["durationMinutes"], 30);
        assert_eq!(result["requirements"]["targetScore"], 0);
        assert_eq!(result["requirements"]["scoringMode"], "none");
        assert_eq!(result["requirements"]["goal"], "模拟模型的教学建议");
        let sent = server.join().unwrap()["messages"][1]["content"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(!sent.contains("模拟私有昵称"));
        assert!(!sent.contains("studentId"));
        assert!(!sent.contains("simulated-not-real-key"));
    }
    #[test]
    fn student_context_never_leaks() {
        assert_eq!(
            model_context(
                &json!({"student":{"name":"私密"},"nested":{"studentId":"secret","goal":"练习"}})
            ),
            json!({"nested":{"goal":"练习"}})
        );
    }
    #[test]
    fn explicit_duration_and_score_are_teacher_choices() {
        let mut r = json!({"durationMinutes":45,"scoringMode":"none","targetScore":0});
        explicit_size_fields(&mut r, "12道题，30分钟，100分").unwrap();
        assert_eq!(r["durationMinutes"], 30);
        assert_eq!(r["scoringMode"], "points");
        assert_eq!(r["targetScore"], 100);
        explicit_size_fields(&mut r, "100分，还是不计分，45分钟改为30分钟").unwrap();
        assert_eq!(r["durationMinutes"], 30);
        assert_eq!(r["scoringMode"], "none");
        assert_eq!(r["targetScore"], 0);
        explicit_size_fields(&mut r, "不计分，改成总分120，1小时").unwrap();
        assert_eq!(r["durationMinutes"], 60);
        assert_eq!(r["targetScore"], 120);
        assert_eq!(r["scoringMode"], "points");
    }
    #[test]
    fn invalid_size_bounds_are_actionable_and_minutes_are_not_scores() {
        for text in ["0分钟", "301分钟", "6小时", "总分0", "1001分"] {
            assert!(
                explicit_size_fields(&mut json!({}), text).is_err(),
                "{text}"
            );
        }
        let mut r = json!({"scoringMode":"none","targetScore":0});
        explicit_size_fields(&mut r, "30分钟").unwrap();
        assert_eq!(r["scoringMode"], "none");
        assert_eq!(r["targetScore"], 0);
        assert!(explicit_size_fields(&mut r, "每题10分").is_err());
    }
    #[test]
    fn large_total_respects_per_type_capacity() {
        let mut r = json!({"counts":{"single_choice":6,"fill_blank":2,"free_response":2}});
        quantities(&mut r, "60道题").unwrap();
        assert_eq!(
            TYPES
                .iter()
                .map(|k| r["counts"][*k].as_u64().unwrap())
                .sum::<u64>(),
            60
        );
        assert!(
            TYPES
                .iter()
                .all(|k| r["counts"][*k].as_u64().unwrap() <= 30)
        );
    }
}
