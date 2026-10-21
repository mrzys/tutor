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
    crate::requirements_summary::clear_preset_goal(&config, &mut r);
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
    if let Some(choice) = r["typeConstraints"].get("choiceCount") {
        let choice = int(choice, "选择题合计", 0, 60)?;
        if r["counts"]["single_choice"].as_u64().unwrap_or(0)
            + r["counts"]["multiple_choice"].as_u64().unwrap_or(0)
            != choice
        {
            return Err(invalid("单选与多选题量合计不符合教师确认的选择题数量。"));
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
    crate::requirements_summary::ensure_goal(&config, &mut r);
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
    let previous_total = TYPES
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
        let is_type = [
            "单选",
            "单项选择",
            "多选",
            "多项选择",
            "选择",
            "填空",
            "解答",
            "大",
        ]
        .contains(&modifier);
        if !is_type
            && ![
                "单选",
                "单项选择",
                "多选",
                "多项选择",
                "选择",
                "填空",
                "解答",
                "大",
            ]
            .iter()
            .any(|p| prefix.ends_with(p))
        {
            total = Some(
                chinese_number(&capture[1])
                    .ok_or_else(|| invalid("题量无法识别，请使用明确的整数。"))?,
            );
        }
    }
    // Match complete labels first so generic “选择” never consumes the suffix
    // of “单项选择 / 多项选择”. Generic choice includes both kinds.
    let label = r"(?:单项选择|单选|多项选择|多选|选择|填空|解答|大)(?:题)?";
    let label_re = Regex::new(label).unwrap();
    let kinds = |text: &str| -> Vec<&'static str> {
        match text.trim_end_matches('题') {
            "单项选择" | "单选" => vec!["single_choice"],
            "多项选择" | "多选" => vec!["multiple_choice"],
            "选择" => vec!["single_choice", "multiple_choice"],
            "填空" => vec!["fill_blank"],
            _ => vec!["free_response"],
        }
    };
    let separator = r"\s*(?:和|与|以及|及|、|/|或)\s*";
    let item = format!(r"{label}(?:\s*{num}\s*(?:道|题)?)?");
    let only_re = Regex::new(&format!(
        r"(?:只要|仅要|只出|仅出|只做|仅做|只需要|只用|仅限于?|只包含|仅包含|只有|仅|全部(?:为|是|用)?|全是)\s*({item}(?:{separator}{item})*)"
    )).unwrap();
    let mut only_types = None;
    let mut only_explicit = std::collections::HashSet::new();
    for capture in only_re.captures_iter(message) {
        only_explicit = label_re
            .find_iter(&capture[1])
            .flat_map(|matched| {
                let matched_kinds = kinds(matched.as_str());
                if matched_kinds.len() == 1 {
                    matched_kinds
                } else {
                    vec![]
                }
            })
            .collect();
        only_types = Some(
            label_re
                .find_iter(&capture[1])
                .flat_map(|matched| kinds(matched.as_str()))
                .collect::<std::collections::HashSet<_>>(),
        );
    }
    let mut exact = r["typeConstraints"]["exactCounts"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let mut excluded = strings(&r["typeConstraints"]["excludedTypes"]);
    let mut current_counts = std::collections::HashSet::new();
    let mut current_exclusions = std::collections::HashSet::new();
    let after = Regex::new(&format!(r"^\s*{num}\s*(?:道|题)?")).unwrap();
    let before = Regex::new(&format!(r"{num}\s*(?:道|个)?\s*$")).unwrap();
    let mut choice_total = None;
    for matched in label_re.find_iter(message) {
        let count = after
            .captures(&message[matched.end()..])
            .or_else(|| before.captures(&message[..matched.start()]));
        let Some(capture) = count else { continue };
        let n = chinese_number(&capture[1]).ok_or_else(|| invalid("题量无法识别。"))?;
        let matched_kinds = kinds(matched.as_str());
        if n > 30 * matched_kinds.len() as u64 {
            return Err(invalid("每个题型最多 30 题。"));
        }
        if matched_kinds.len() == 2 {
            choice_total = Some(n);
        } else {
            let kind = matched_kinds[0];
            exact.insert(kind.into(), json!(n));
            current_counts.insert(kind);
            excluded.retain(|value| value != kind);
        }
    }
    let exclude_re = Regex::new(&format!(
        r"(?:不要|不需要|不出|不用|排除|去掉|不含|没有)\s*({label}(?:{separator}{label})*)"
    ))
    .unwrap();
    for capture in exclude_re.captures_iter(message) {
        for kind in label_re
            .find_iter(&capture[1])
            .flat_map(|matched| kinds(matched.as_str()))
        {
            current_exclusions.insert(kind);
            exact.insert(kind.into(), json!(0));
            if !excluded.iter().any(|value| value == kind) {
                excluded.push(kind.into());
            }
        }
    }
    if let Some(only) = &only_types {
        for kind in TYPES {
            if only.contains(kind) {
                if !current_exclusions.contains(kind) {
                    excluded.retain(|value| value != kind);
                    if !current_counts.contains(kind) {
                        exact.remove(kind);
                    }
                }
            } else {
                if current_counts.contains(kind) && exact[kind].as_u64().unwrap_or(0) > 0 {
                    return Err(invalid("教师指定的题型数量与仅限题型冲突。"));
                }
                exact.insert(kind.into(), json!(0));
                if !excluded.iter().any(|value| value == kind) {
                    excluded.push(kind.into());
                }
            }
        }
        for kind in &only_explicit {
            if !current_exclusions.contains(kind) && r["counts"][*kind].as_u64().unwrap_or(0) == 0 {
                r["counts"][*kind] = json!(1);
            }
        }
        // An exclusive request for a previously absent type must have weight.
        if only
            .iter()
            .all(|kind| r["counts"][*kind].as_u64().unwrap_or(0) == 0)
        {
            for kind in only {
                r["counts"][*kind] = json!(1);
            }
        }
    }
    let choice_total = choice_total.or_else(|| r["typeConstraints"]["choiceCount"].as_u64());
    allocate_choice_quantities(r, total, exact, excluded, choice_total, previous_total)
}
fn allocate_choice_quantities(
    r: &mut Value,
    total: Option<u64>,
    mut exact: serde_json::Map<String, Value>,
    excluded: Vec<String>,
    choice_total: Option<u64>,
    previous_total: u64,
) -> AppResult<()> {
    let Some(choice_total) = choice_total else {
        return allocate_quantities(r, total, exact, excluded, previous_total);
    };
    let teacher_exact = exact.clone();
    let choice = ["single_choice", "multiple_choice"];
    let fixed: u64 = choice
        .iter()
        .filter_map(|kind| exact.get(*kind).and_then(Value::as_u64))
        .sum();
    let open: Vec<_> = choice
        .into_iter()
        .filter(|kind| !exact.contains_key(*kind))
        .collect();
    if fixed > choice_total || choice_total - fixed > open.len() as u64 * 30 {
        return Err(invalid("选择题合计与单选、多选数量或允许题型冲突。"));
    }
    let weights: Vec<_> = open
        .iter()
        .map(|kind| r["counts"][*kind].as_u64().unwrap_or(0))
        .collect();
    let mut split = distribute(choice_total - fixed, &weights);
    let mut overflow = 0;
    for n in &mut split {
        if *n > 30 {
            overflow += *n - 30;
            *n = 30;
        }
    }
    while overflow > 0 {
        for n in &mut split {
            if *n < 30 && overflow > 0 {
                *n += 1;
                overflow -= 1;
            }
        }
    }
    for (kind, count) in open.iter().zip(split) {
        exact.insert((*kind).into(), json!(count));
    }
    let total = total.or_else(|| {
        if r.get("questionCount").is_none()
            && ["fill_blank", "free_response"]
                .iter()
                .all(|kind| exact.contains_key(*kind))
        {
            Some(exact.values().map(|v| v.as_u64().unwrap_or(0)).sum())
        } else {
            None
        }
    });
    allocate_quantities(r, total, exact, excluded, previous_total)?;
    // A grouped request does not assert a teacher-specified split into single/multi.
    r["typeConstraints"]["exactCounts"] = json!(teacher_exact);
    r["typeConstraints"]["choiceCount"] = json!(choice_total);
    Ok(())
}

fn allocate_quantities(
    r: &mut Value,
    total: Option<u64>,
    mut exact: serde_json::Map<String, Value>,
    excluded: Vec<String>,
    previous_total: u64,
) -> AppResult<()> {
    let teacher_exact = exact.clone();
    // Preserve a zero default for multi-select unless the teacher requested it.
    if !exact.contains_key("multiple_choice")
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
fn quantity_authority(payload: &Value) -> AppResult<Value> {
    let authority = payload
        .get("quantityAuthority")
        .cloned()
        .unwrap_or(json!({}));
    let fields = authority
        .as_object()
        .ok_or_else(|| invalid("题量确认来源格式无效。"))?;
    if fields.iter().any(|(key, value)| {
        !["counts", "questionCount", "typeConstraints"].contains(&key.as_str())
            || !value.is_boolean()
    }) {
        return Err(invalid("题量确认来源格式无效。"));
    }
    Ok(authority)
}
fn apply_quantity_intent(
    r: &mut Value,
    intent: &Value,
    plan: &Value,
    authority: &Value,
) -> AppResult<Vec<String>> {
    let previous_total = TYPES
        .iter()
        .map(|kind| r["counts"][*kind].as_u64().unwrap_or(0))
        .sum();
    let fields = intent
        .as_object()
        .ok_or_else(|| invalid("AI 需求结果缺少有效的题量意图，请重试。"))?;
    if fields.keys().any(|key| {
        ![
            "allowedTypes",
            "excludedTypes",
            "counts",
            "questionCount",
            "choiceCount",
        ]
        .contains(&key.as_str())
    }) {
        return Err(invalid("AI 题量意图包含未知字段。"));
    }
    let type_list = |field: &str| -> AppResult<Option<Vec<String>>> {
        let Some(value) = intent.get(field) else {
            return Ok(None);
        };
        let values = value
            .as_array()
            .ok_or_else(|| invalid("AI 题型约束格式无效。"))?;
        let mut seen = std::collections::HashSet::new();
        for value in values {
            let kind = value.as_str().ok_or_else(|| invalid("AI 返回未知题型。"))?;
            if !TYPES.contains(&kind) || !seen.insert(kind) {
                return Err(invalid("AI 返回未知或重复题型。"));
            }
        }
        if field == "allowedTypes" && values.is_empty() {
            return Err(invalid("AI 允许题型不能为空。"));
        }
        Ok(Some(
            values
                .iter()
                .map(|v| v.as_str().unwrap().to_owned())
                .collect(),
        ))
    };
    let allowed = type_list("allowedTypes")?;
    let forbidden = type_list("excludedTypes")?.unwrap_or_default();
    if allowed
        .as_ref()
        .is_some_and(|allowed| allowed.iter().any(|kind| forbidden.contains(kind)))
    {
        return Err(invalid("AI 允许与排除的题型相互冲突。"));
    }
    let proposed_counts = match intent.get("counts") {
        Some(value) => value
            .as_object()
            .ok_or_else(|| invalid("AI 题型数量格式无效。"))?
            .clone(),
        None => serde_json::Map::new(),
    };
    for (kind, count) in &proposed_counts {
        if !TYPES.contains(&kind.as_str()) {
            return Err(invalid("AI 返回未知题型。"));
        }
        let n = int(count, "AI 题型数量", 0, 30)?;
        if n > 0
            && (forbidden.contains(kind)
                || allowed
                    .as_ref()
                    .is_some_and(|allowed| !allowed.contains(kind)))
        {
            return Err(invalid("AI 题型数量与允许、排除要求冲突。"));
        }
    }
    let proposed_choice = intent
        .get("choiceCount")
        .map(|v| int(v, "AI 选择题合计", 0, 60))
        .transpose()?;
    if let Some(choice_total) = proposed_choice {
        let fixed: u64 = ["single_choice", "multiple_choice"]
            .iter()
            .filter_map(|kind| proposed_counts.get(*kind).and_then(Value::as_u64))
            .sum();
        let open = ["single_choice", "multiple_choice"]
            .iter()
            .filter(|kind| {
                !proposed_counts.contains_key(**kind)
                    && !forbidden.iter().any(|v| v == **kind)
                    && !allowed
                        .as_ref()
                        .is_some_and(|allowed| !allowed.iter().any(|v| v == **kind))
            })
            .count();
        if fixed > choice_total || choice_total - fixed > open as u64 * 30 {
            return Err(invalid("AI 选择题合计与题型数量、允许类型冲突。"));
        }
    }
    let proposed_total = intent
        .get("questionCount")
        .map(|v| int(v, "AI 总题量", 1, 60))
        .transpose()?;
    let intended_excluded: Vec<_> = TYPES
        .into_iter()
        .filter(|kind| {
            forbidden.iter().any(|v| v == kind)
                || allowed
                    .as_ref()
                    .is_some_and(|allowed| !allowed.iter().any(|v| v == kind))
        })
        .collect();
    let proposed_sum: u64 = proposed_counts.values().map(|v| v.as_u64().unwrap()).sum();
    if proposed_total.is_some_and(|total| {
        proposed_sum > total
            || (TYPES.iter().all(|kind| {
                proposed_counts.contains_key(*kind) || intended_excluded.contains(kind)
            }) && proposed_sum != total)
    }) {
        return Err(invalid("AI 总题量与各题型数量冲突。"));
    }
    if let (Some(choice), Some(total)) = (proposed_choice, proposed_total) {
        let other: u64 = ["fill_blank", "free_response"]
            .iter()
            .filter_map(|kind| proposed_counts.get(*kind).and_then(Value::as_u64))
            .sum();
        let complete = ["fill_blank", "free_response"]
            .iter()
            .all(|kind| proposed_counts.contains_key(*kind) || intended_excluded.contains(kind));
        if choice + other > total || (complete && choice + other != total) {
            return Err(invalid("AI 选择题合计与总题量冲突。"));
        }
    }
    let protected_choice = if authority["typeConstraints"] == true {
        r["typeConstraints"]
            .get("choiceCount")
            .map(|v| int(v, "教师确认选择题合计", 0, 60))
            .transpose()?
    } else {
        None
    };
    let mut exact = if authority["counts"] == true {
        let mut exact = serde_json::Map::new();
        for kind in TYPES {
            let count = r["counts"][kind].clone();
            int(&count, "教师确认题量", 0, 30)?;
            exact.insert(kind.into(), count);
        }
        exact
    } else if authority["typeConstraints"] == true {
        r["typeConstraints"]["exactCounts"]
            .as_object()
            .cloned()
            .unwrap_or_default()
    } else {
        serde_json::Map::new()
    };
    let mut excluded = if authority["typeConstraints"] == true {
        strings(&r["typeConstraints"]["excludedTypes"])
    } else {
        vec![]
    };
    for kind in &excluded {
        exact.insert(kind.clone(), json!(0));
    }
    let protected_exact = exact.clone();
    let mut warnings = vec![];
    let mut warn = || {
        if warnings.is_empty() {
            warnings.push("原话中的题量或题型与已确认设置不同，已保留教师手动设置；如需更改，请先修改已确认设置。".to_owned());
        }
    };
    for kind in intended_excluded {
        if protected_exact
            .get(kind)
            .and_then(Value::as_u64)
            .is_some_and(|n| n > 0)
        {
            warn();
        } else {
            exact.insert(kind.into(), json!(0));
            if !excluded.iter().any(|v| v == kind) {
                excluded.push(kind.into());
            }
        }
    }
    for (kind, count) in proposed_counts {
        if let Some(protected) = protected_exact.get(&kind) {
            if *protected != count {
                warn();
            }
        } else if excluded.contains(&kind) && count.as_u64().unwrap() > 0 {
            warn();
        } else {
            exact.insert(kind, count);
        }
    }
    let choice_total = if authority["counts"] == true {
        let actual = r["counts"]["single_choice"].as_u64().unwrap_or(0)
            + r["counts"]["multiple_choice"].as_u64().unwrap_or(0);
        if proposed_choice.is_some_and(|n| n != actual) {
            warn();
        }
        protected_choice.or(proposed_choice.filter(|n| *n == actual))
    } else if let Some(protected) = protected_choice {
        if proposed_choice.is_some_and(|n| n != protected) {
            warn();
        }
        Some(protected)
    } else {
        proposed_choice
    };
    let total = if authority["questionCount"] == true {
        let total = int(&r["questionCount"], "教师确认总题量", 1, 60)?;
        if proposed_total.is_some_and(|proposed| proposed != total) {
            warn();
        }
        Some(total)
    } else if authority["counts"] == true {
        let total = protected_exact
            .values()
            .map(|v| v.as_u64().unwrap_or(0))
            .sum();
        if proposed_total.is_some_and(|proposed| proposed != total) {
            warn();
        }
        Some(total)
    } else {
        proposed_total
    };
    // Model suggestions are separate from the quantities explicitly said by the teacher.
    // Never turn a proposed split into exactCounts or redistribute it using defaults.
    let model_plan = validate_quantity_plan(plan)?;
    let requested = total.unwrap_or_else(|| {
        if exact.len() == TYPES.len() {
            exact.values().filter_map(Value::as_u64).sum()
        } else if let Some(choice) = choice_total.filter(|_| {
            ["fill_blank", "free_response"]
                .iter()
                .all(|kind| exact.contains_key(*kind))
        }) {
            choice
                + ["fill_blank", "free_response"]
                    .iter()
                    .filter_map(|kind| exact.get(*kind).and_then(Value::as_u64))
                    .sum::<u64>()
        } else {
            r["questionCount"].as_u64().unwrap_or(previous_total)
        }
    });
    if requested == 0 || requested > 60 {
        return Err(invalid("总题量需为 1～60。"));
    }
    let satisfies = |counts: &[u64; 4]| {
        counts.iter().sum::<u64>() == requested
            && TYPES
                .iter()
                .zip(counts)
                .all(|(kind, count)| exact.get(*kind).is_none_or(|v| v.as_u64() == Some(*count)))
            && choice_total.is_none_or(|choice| counts[0] + counts[1] == choice)
    };
    let mut feasible = Vec::new();
    'search: for single in 0..=30 {
        for multiple in 0..=30 {
            for fill in 0..=30 {
                let used = single + multiple + fill;
                if used <= requested && requested - used <= 30 {
                    let counts = [single, multiple, fill, requested - used];
                    if satisfies(&counts) {
                        feasible.push(counts);
                        if feasible.len() == 2 {
                            break 'search;
                        }
                    }
                }
            }
        }
    }
    let Some(first) = feasible.first().copied() else {
        return Err(invalid(
            "教师指定的题型、分组数量与总题量冲突，请调整其中一项。",
        ));
    };
    let adopted = if authority["counts"] == true {
        if model_plan
            .as_ref()
            .is_some_and(|(counts, _)| *counts != first)
        {
            warn();
        }
        first
    } else if let Some((counts, rationale)) = &model_plan {
        if !satisfies(counts) {
            return Err(invalid(
                "AI 建议配比不符合已确认题量或原话中的题型数量、允许范围，请重试。",
            ));
        }
        r["quantityPlan"] = json!({"counts":counts_value(counts),"rationale":rationale,"source":"model_suggestion"});
        *counts
    } else if feasible.len() == 1 {
        // A unique result follows from teacher constraints, not from a default ratio.
        r.as_object_mut().unwrap().remove("quantityPlan");
        first
    } else {
        return Err(invalid(
            "AI 需求结果缺少基于教学意图的完整题型配比与理由，请重试。",
        ));
    };
    r["counts"] = counts_value(&adopted);
    r["questionCount"] = json!(requested);
    r["typeConstraints"] = json!({"excludedTypes":excluded,"exactCounts":exact});
    if let Some(choice) = choice_total {
        r["typeConstraints"]["choiceCount"] = json!(choice);
    }
    // Existing model rationale survives confirmation only while its actual split remains.
    if r.get("quantityPlan")
        .is_some_and(|plan| plan["counts"] != r["counts"])
    {
        r.as_object_mut().unwrap().remove("quantityPlan");
    }
    Ok(warnings)
}
fn counts_value(counts: &[u64; 4]) -> Value {
    Value::Object(
        TYPES
            .iter()
            .zip(counts)
            .map(|(kind, count)| ((*kind).into(), json!(count)))
            .collect(),
    )
}
fn validate_quantity_plan(plan: &Value) -> AppResult<Option<([u64; 4], String)>> {
    if plan.is_null() {
        return Ok(None);
    }
    let fields = plan
        .as_object()
        .ok_or_else(|| invalid("AI 题型配比格式无效。"))?;
    if fields
        .keys()
        .any(|key| !["counts", "rationale"].contains(&key.as_str()))
    {
        return Err(invalid("AI 题型配比包含未知字段。"));
    }
    let counts = plan["counts"]
        .as_object()
        .ok_or_else(|| invalid("AI 题型配比需包含完整的四类数量。"))?;
    if counts.len() != TYPES.len() || counts.keys().any(|kind| !TYPES.contains(&kind.as_str())) {
        return Err(invalid("AI 题型配比需包含完整的四类数量。"));
    }
    let mut result = [0; 4];
    for (index, kind) in TYPES.iter().enumerate() {
        result[index] = int(&counts[*kind], "AI 建议题型数量", 0, 30)?;
    }
    if result.iter().sum::<u64>() == 0 || result.iter().sum::<u64>() > 60 {
        return Err(invalid("AI 建议总题量需为 1～60。"));
    }
    let rationale = plan["rationale"]
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty() && text.chars().count() <= 500)
        .ok_or_else(|| invalid("AI 题型配比需提供不超过 500 字的教学意图理由。"))?;
    Ok(Some((result, rationale.to_owned())))
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
    crate::requirements_summary::clear_preset_goal(&config, &mut input);
    if payload["requirements"].get("title").is_none() {
        input.as_object_mut().unwrap().remove("title");
    }
    if payload["requirements"].get("scoringMode").is_none() {
        input["scoringMode"] = json!("none");
    }
    let authority = quantity_authority(payload)?;
    // Counts supplied by Composer include defaults; only provenance makes them fixed.
    if input["counts"].get("multiple_choice").is_none() {
        input["counts"]["multiple_choice"] = json!(0);
    }
    explicit_size_fields(&mut input, message)?;
    let mut warnings = vec![];
    let mut summary = String::new();
    match s(payload, "mode") {
        "rule" => {
            input.as_object_mut().unwrap().remove("quantityPlan");
            quantities(&mut input, message)?;
        }
        "llm" => {
            let tasks: Vec<_> = list(&config["tasks"]).into_iter()
                .filter(|task| overlaps(&task["sectionIds"], &input["mainScope"]))
                .map(|task| json!({"id":task["id"],"label":task["label"],"questionType":task["questionType"],"sectionIds":task["sectionIds"]}))
                .collect();
            let quantity_supply = crate::assembly::intake_supply(store, &input, &config)?;
            let mut model_requirements = input.clone();
            model_requirements
                .as_object_mut()
                .unwrap()
                .remove("quantityPlan");
            let proposed=model.propose("intake",&model_context(&json!({"requirements":model_requirements,"message":message,"chapters":config["chapters"],"tasks":tasks,"quantityAuthority":authority,"quantitySupply":quantity_supply})),cancel)?;
            let changes = proposed
                .get("requirements")
                .or(proposed.get("changes"))
                .ok_or_else(|| invalid("AI 需求结果缺少结构化要求。"))?;
            if !changes.is_object() {
                return Err(invalid("AI 需求结构无效。"));
            }
            // Teaching suggestions and quantity intent are validated separately.
            for key in ["goal", "teachingGoals"] {
                if let Some(v) = changes.get(key) {
                    input[key] = v.clone();
                }
            }
            warnings = apply_quantity_intent(
                &mut input,
                &proposed["quantityIntent"],
                &proposed["quantityPlan"],
                &authority,
            )?;
            for (kind, label) in TYPES.iter().zip(["单选题", "多选题", "填空题", "解答题"])
            {
                let requested = input["counts"][*kind].as_u64().unwrap_or(0);
                let available = quantity_supply["byType"][*kind]["eligibleCount"]
                    .as_u64()
                    .unwrap_or(0);
                if requested > available {
                    warnings.push(format!("{label}计划 {requested} 题，当前范围及已学边界内已核实可用 {available} 题；保留题量与题型要求，后续选题将显示缺口，未核实题不计入可用量。"));
                }
            }
            summary = s(&proposed, "summary").to_owned();
        }
        _ => return Err(invalid("请明确选择 AI 整理或规则预设。")),
    }
    input["quantityAuthority"] = authority;
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
    Ok(json!({"requirements":requirements,"summary":summary,"warnings":warnings}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn simulated_model_reply(
        directory: &std::path::Path,
        output: Value,
    ) -> (ModelClient, std::thread::JoinHandle<Value>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut connection, _) = listener.accept().unwrap();
            connection
                .set_read_timeout(Some(std::time::Duration::from_secs(10)))
                .unwrap();
            let mut received = Vec::new();
            let mut buffer = [0u8; 4096];
            let (start, length) = loop {
                let n = connection.read(&mut buffer).unwrap();
                assert!(n > 0);
                received.extend_from_slice(&buffer[..n]);
                if let Some(start) = received.windows(4).position(|v| v == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&received[..start]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.split_once(':')
                                .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                                .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    if received.len() >= start + 4 + length {
                        break (start + 4, length);
                    }
                }
            };
            let request: Value = serde_json::from_slice(&received[start..start + length]).unwrap();
            let response = json!({"choices":[{"finish_reason":"stop","message":{"content":output.to_string()}}]}).to_string();
            write!(connection, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
            request
        });
        (ModelClient::test_client(directory, &endpoint), server)
    }
    #[test]
    fn simulated_llm_quantity_intent_uses_model_semantics_and_manual_authority() {
        let directory = tempfile::tempdir().unwrap();
        let seed: Value = serde_json::from_str(include_str!("../../resources/seed.json")).unwrap();
        let store = Store::open(directory.path(), &seed).unwrap();
        let cancel = AtomicBool::new(false);
        let message = "给我凑十二道，孩子只做勾选答案和往横线上写结果的，别安排长篇证明。";
        let output = json!({"requirements":{"goal":"模拟模型目标","teachingGoals":[]},"quantityIntent":{"allowedTypes":["single_choice","multiple_choice","fill_blank"],"questionCount":12},"quantityPlan":{"counts":{"single_choice":8,"multiple_choice":0,"fill_blank":4,"free_response":0},"rationale":"用勾选和填空检查基础，不安排长篇证明。"},"summary":"模拟数量提取"});
        let (model, server) = simulated_model_reply(directory.path(), output);
        let prepared = prepare(&store, &json!({"mode":"llm","message":message,"requirements":{"mainScope":["1.1"],"learnedScope":["1.1"]}}), &model, &cancel).unwrap();
        let request = server.join().unwrap();
        let context: Value = serde_json::from_str(s(&request["messages"][1], "content")).unwrap();
        assert_eq!(context["message"], message);
        assert_eq!(
            context["requirements"]["counts"]["free_response"], 2,
            "regex must not decide intent before the model"
        );
        assert_eq!(prepared["requirements"]["counts"]["free_response"], 0);
        assert_eq!(prepared["requirements"]["questionCount"], 12);
        assert_eq!(prepared["requirements"]["quantityAuthority"], json!({}));
        let confirmed = prepared["requirements"].clone();
        let changed = json!({"requirements":{"goal":"模拟修改目标"},"quantityIntent":{"allowedTypes":["free_response"],"questionCount":8},"quantityPlan":{"counts":{"single_choice":0,"multiple_choice":0,"fill_blank":0,"free_response":8},"rationale":"练习书面证明。"}});
        let (model, server) = simulated_model_reply(directory.path(), changed.clone());
        let protected = prepare(&store, &json!({"mode":"llm","message":"八道长篇证明","requirements":confirmed,"quantityAuthority":{"questionCount":true,"counts":true,"typeConstraints":true}}), &model, &cancel).unwrap();
        server.join().unwrap();
        assert_eq!(protected["requirements"]["counts"], confirmed["counts"]);
        assert_eq!(protected["requirements"]["questionCount"], 12);
        assert_eq!(
            protected["requirements"]["quantityPlan"],
            confirmed["quantityPlan"]
        );
        assert!(!list(&protected["warnings"]).is_empty());
        let (model, server) = simulated_model_reply(directory.path(), changed);
        let edited = prepare(&store, &json!({"mode":"llm","message":"八道长篇证明","requirements":protected["requirements"],"quantityAuthority":{}}), &model, &cancel).unwrap();
        server.join().unwrap();
        assert_eq!(edited["requirements"]["counts"]["free_response"], 8);
        assert_eq!(edited["requirements"]["counts"]["single_choice"], 0);
        assert_eq!(edited["requirements"]["questionCount"], 8);
        let (model, server) = simulated_model_reply(
            directory.path(),
            json!({"requirements":{},"quantityIntent":{"questionCount":15},"quantityPlan":{"counts":{"single_choice":6,"multiple_choice":0,"fill_blank":2,"free_response":2},"rationale":"在手动十题内结合基础判断和书面练习。"}}),
        );
        let manual_total = prepare(&store, &json!({"mode":"llm","message":"十五道","requirements":{"questionCount":10},"quantityAuthority":{"questionCount":true}}), &model, &cancel).unwrap();
        server.join().unwrap();
        assert_eq!(manual_total["requirements"]["questionCount"], 10);
        assert!(!list(&manual_total["warnings"]).is_empty());
    }
    #[test]
    fn simulated_llm_uses_different_teaching_intent_plans_with_the_same_allowed_types() {
        let directory = tempfile::tempdir().unwrap();
        let seed: Value = serde_json::from_str(include_str!("../../resources/seed.json")).unwrap();
        let store = Store::open(directory.path(), &seed).unwrap();
        for (message, counts, rationale) in [
            (
                "十道选择和填空，主要辨析概念，用勾选判断常见误区。",
                [8, 0, 2, 0],
                "以选择辨析常见概念误区，少量填空检查独立表达。",
            ),
            (
                "十道选择和填空，主要训练独立算出结果，减少猜选答案。",
                [2, 0, 8, 0],
                "填空为主，训练独立算出结果，少量选择检查概念。",
            ),
        ] {
            let output = json!({"requirements":{},"quantityIntent":{"allowedTypes":["single_choice","multiple_choice","fill_blank"],"questionCount":10},"quantityPlan":{"counts":counts_value(&counts),"rationale":rationale}});
            let (model, server) = simulated_model_reply(directory.path(), output);
            let prepared = prepare(
                &store,
                &json!({"mode":"llm","message":message,"requirements":{}}),
                &model,
                &AtomicBool::new(false),
            )
            .unwrap();
            let request = server.join().unwrap();
            let context: Value =
                serde_json::from_str(s(&request["messages"][1], "content")).unwrap();
            assert_eq!(context["message"], message);
            let supply = &context["quantitySupply"];
            assert_eq!(supply["byType"].as_object().unwrap().len(), 4);
            for kind in TYPES {
                assert!(supply["byType"][kind]["eligibleCount"].is_u64());
                assert!(supply["byType"][kind]["unknownCount"].is_u64());
            }
            assert!(supply.get("questions").is_none());
            assert!(!supply.to_string().contains("questionId"));
            assert!(!supply.to_string().contains("student"));
            assert!(context["requirements"].get("quantityPlan").is_none());
            let r = &prepared["requirements"];
            assert_eq!(r["counts"], counts_value(&counts));
            assert_eq!(r["quantityPlan"]["rationale"], rationale);
            assert_eq!(r["quantityPlan"]["source"], "model_suggestion");
            assert!(
                r["typeConstraints"]["exactCounts"]
                    .get("single_choice")
                    .is_none()
            );
            assert!(
                r["typeConstraints"]["exactCounts"]
                    .get("fill_blank")
                    .is_none()
            );
            let confirmed = normalize(&store, r).unwrap();
            assert_eq!(confirmed["quantityPlan"], r["quantityPlan"]);
        }
    }
    #[test]
    fn simulated_llm_rejects_missing_invalid_and_constraint_breaking_plans_without_defaulting() {
        let directory = tempfile::tempdir().unwrap();
        let seed: Value = serde_json::from_str(include_str!("../../resources/seed.json")).unwrap();
        let store = Store::open(directory.path(), &seed).unwrap();
        for plan in [
            Value::Null,
            json!({"counts":{"single_choice":6,"fill_blank":4,"free_response":0},"rationale":"缺少多选。"}),
            json!({"counts":{"single_choice":6.5,"multiple_choice":0,"fill_blank":3.5,"free_response":0},"rationale":"非整数。"}),
            json!({"counts":{"single_choice":31,"multiple_choice":0,"fill_blank":0,"free_response":0},"rationale":"超限。"}),
            json!({"counts":{"single_choice":6,"multiple_choice":0,"fill_blank":4,"free_response":0},"rationale":""}),
            json!({"counts":{"single_choice":6,"multiple_choice":0,"fill_blank":3,"free_response":0},"rationale":"总数不符。"}),
            json!({"counts":{"single_choice":5,"multiple_choice":0,"fill_blank":4,"free_response":1},"rationale":"违反排除题型。"}),
            json!({"counts":{"single_choice":7,"multiple_choice":0,"fill_blank":3,"free_response":0},"rationale":"违反选择题合计。"}),
        ] {
            let output = json!({"requirements":{},"quantityIntent":{"allowedTypes":["single_choice","multiple_choice","fill_blank"],"questionCount":10,"choiceCount":6},"quantityPlan":plan});
            let (model, server) = simulated_model_reply(directory.path(), output);
            assert!(
                prepare(
                    &store,
                    &json!({"mode":"llm","message":"模拟约束配比回归","requirements":{}}),
                    &model,
                    &AtomicBool::new(false)
                )
                .is_err(),
                "{plan}"
            );
            server.join().unwrap();
        }
        let (model, server) = simulated_model_reply(
            directory.path(),
            json!({"requirements":{},"quantityIntent":{"questionCount":10,"counts":{"single_choice":6},"excludedTypes":["free_response"]},"quantityPlan":{"counts":{"single_choice":5,"multiple_choice":1,"fill_blank":4,"free_response":0},"rationale":"模拟违反原话明确单选数。"}}),
        );
        assert!(
            prepare(
                &store,
                &json!({"mode":"llm","message":"十题，单选六题，不要解答","requirements":{}}),
                &model,
                &AtomicBool::new(false)
            )
            .is_err()
        );
        server.join().unwrap();
        // Exact teacher constraints uniquely determine a split and need no model proposal.
        let (model, server) = simulated_model_reply(
            directory.path(),
            json!({"requirements":{},"quantityIntent":{"allowedTypes":["free_response"],"questionCount":3}}),
        );
        let unique = prepare(
            &store,
            &json!({"mode":"llm","message":"只做三道书面证明","requirements":{}}),
            &model,
            &AtomicBool::new(false),
        )
        .unwrap();
        server.join().unwrap();
        assert_eq!(
            unique["requirements"]["counts"],
            counts_value(&[0, 0, 0, 3])
        );
        assert!(unique["requirements"].get("quantityPlan").is_none());
    }
    #[test]
    fn simulated_llm_supply_shortage_preserves_explicit_type_and_quantity() {
        let directory = tempfile::tempdir().unwrap();
        let seed: Value = serde_json::from_str(include_str!("../../resources/seed.json")).unwrap();
        let store = Store::open(directory.path(), &seed).unwrap();
        let (model, server) = simulated_model_reply(
            directory.path(),
            json!({"requirements":{},"quantityIntent":{"allowedTypes":["multiple_choice"],"questionCount":3},"quantityPlan":{"counts":{"single_choice":0,"multiple_choice":3,"fill_blank":0,"free_response":0},"rationale":"按教师明确要求安排三道多选；当前题库缺少可核实供给，保留缺口供调整。"}}),
        );
        let prepared = prepare(
            &store,
            &json!({"mode":"llm","message":"只要三道多选题","requirements":{}}),
            &model,
            &AtomicBool::new(false),
        )
        .unwrap();
        let request = server.join().unwrap();
        let context: Value = serde_json::from_str(s(&request["messages"][1], "content")).unwrap();
        assert_eq!(
            context["quantitySupply"]["byType"]["multiple_choice"]["eligibleCount"],
            0
        );
        assert_eq!(
            prepared["requirements"]["counts"],
            counts_value(&[0, 3, 0, 0])
        );
        assert!(
            strings(&prepared["warnings"])
                .iter()
                .any(|warning| warning.contains("多选题计划 3 题")
                    && warning.contains("已核实可用 0 题"))
        );
    }
    #[test]
    fn simulated_llm_grouped_choice_count_preserves_sum_without_claiming_a_split() {
        let directory = tempfile::tempdir().unwrap();
        let seed: Value = serde_json::from_str(include_str!("../../resources/seed.json")).unwrap();
        let store = Store::open(directory.path(), &seed).unwrap();
        let output = json!({"requirements":{},"quantityIntent":{"allowedTypes":["single_choice","multiple_choice","fill_blank"],"questionCount":10,"choiceCount":6,"counts":{"fill_blank":4}},"quantityPlan":{"counts":{"single_choice":4,"multiple_choice":2,"fill_blank":4,"free_response":0},"rationale":"选择题分配单选和多选，四道填空练习独立运算。"}});
        let (model, server) = simulated_model_reply(directory.path(), output);
        let prepared = prepare(&store, &json!({"mode":"llm","message":"合共十道，六道勾答案的，余下四道往空里填写。","requirements":{"counts":{"single_choice":4,"multiple_choice":2,"fill_blank":2,"free_response":2}}}), &model, &AtomicBool::new(false)).unwrap();
        server.join().unwrap();
        let r = &prepared["requirements"];
        assert_eq!(r["counts"]["single_choice"], 4);
        assert_eq!(r["counts"]["multiple_choice"], 2);
        assert_eq!(r["counts"]["fill_blank"], 4);
        assert_eq!(r["typeConstraints"]["choiceCount"], 6);
        assert_eq!(r["typeConstraints"]["exactCounts"]["fill_blank"], 4);
        assert!(
            r["typeConstraints"]["exactCounts"]
                .get("single_choice")
                .is_none()
        );
        assert!(
            r["typeConstraints"]["exactCounts"]
                .get("multiple_choice")
                .is_none()
        );
        let mut tampered = r.clone();
        tampered["counts"]["single_choice"] = json!(3);
        assert!(normalize(&store, &tampered).is_err());
        let (model, server) = simulated_model_reply(
            directory.path(),
            json!({"requirements":{},"quantityIntent":{}}),
        );
        let confirmed = prepare(&store, &json!({"mode":"llm","message":"仍按确认的配比","requirements":r,"quantityAuthority":{"questionCount":true,"counts":true,"typeConstraints":true}}), &model, &AtomicBool::new(false)).unwrap();
        server.join().unwrap();
        assert_eq!(confirmed["requirements"]["counts"], r["counts"]);
        assert_eq!(
            confirmed["requirements"]["typeConstraints"]["choiceCount"],
            6
        );
    }
    #[test]
    fn simulated_llm_rejects_invalid_or_self_conflicting_quantity_intent() {
        let directory = tempfile::tempdir().unwrap();
        let seed: Value = serde_json::from_str(include_str!("../../resources/seed.json")).unwrap();
        let store = Store::open(directory.path(), &seed).unwrap();
        for intent in [
            json!({"choiceCount":61}),
            json!({"choiceCount":4,"counts":{"single_choice":5}}),
            json!({"choiceCount":6,"questionCount":5}),
            json!({"choiceCount":1,"allowedTypes":["free_response"]}),
            Value::Null,
            json!({"allowedTypes":[]}),
            json!({"allowedTypes":["essay"]}),
            json!({"allowedTypes":["single_choice"],"excludedTypes":["single_choice"]}),
            json!({"counts":{"fill_blank":31}}),
            json!({"counts":{"single_choice":1.5}}),
            json!({"questionCount":0}),
            json!({"questionCount":61}),
            json!({"allowedTypes":["single_choice"],"counts":{"free_response":2}}),
            json!({"questionCount":5,"counts":{"single_choice":6}}),
        ] {
            let (model, server) = simulated_model_reply(
                directory.path(),
                json!({"requirements":{},"quantityIntent":intent}),
            );
            assert!(
                prepare(
                    &store,
                    &json!({"mode":"llm","message":"模拟无效提取","requirements":{}}),
                    &model,
                    &AtomicBool::new(false)
                )
                .is_err(),
                "{intent}"
            );
            server.join().unwrap();
        }
    }
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
    fn simulated_type_sets_preserve_total_and_survive_confirmation() {
        for message in [
            "10道题，只要选择和填空题",
            "十道题，只需要选择题与填空题",
            "10道题，仅限选择、填空",
            "10道题，仅选择题和填空题",
            "10道题，只出单选和填空题",
            "10道题，只要单项选择题以及填空题",
            "10道题，不要解答题和多选题",
        ] {
            let mut requirements = json!({"questionCount":10,"counts":{"single_choice":6,"multiple_choice":0,"fill_blank":2,"free_response":2}});
            quantities(&mut requirements, message).unwrap();
            assert_eq!(requirements["counts"]["free_response"], 0, "{message}");
            assert_eq!(requirements["questionCount"], 10, "{message}");
            assert!(
                strings(&requirements["typeConstraints"]["excludedTypes"])
                    .contains(&"free_response".into())
            );
            assert_eq!(requirements["counts"]["multiple_choice"], 0);
            assert!(requirements["counts"]["single_choice"].as_u64().unwrap() > 0);
            assert!(requirements["counts"]["fill_blank"].as_u64().unwrap() > 0);
            let confirmed = requirements.clone();
            quantities(&mut requirements, "确认，重新规划").unwrap();
            assert_eq!(requirements, confirmed, "{message}");
        }
        for (message, expected) in [
            ("10道题，只要选择和填空题，选择6题，填空4题", [6, 0, 4, 0]),
            (
                "10道题，只要选择和填空题，单选5题，多选2题，填空3题",
                [5, 2, 3, 0],
            ),
            ("10道题，只要单选、填空和解答题", [6, 0, 2, 2]),
            ("10道题，不要选择题", [0, 0, 5, 5]),
            ("10道题，只要多选和填空题", [0, 3, 7, 0]),
        ] {
            let mut requirements = json!({"questionCount":10,"counts":{"single_choice":6,"multiple_choice":0,"fill_blank":2,"free_response":2}});
            quantities(&mut requirements, message).unwrap();
            for (kind, count) in TYPES.iter().zip(expected) {
                assert_eq!(requirements["counts"][*kind], count, "{message}: {kind}");
            }
            assert_eq!(requirements["questionCount"], 10);
        }
        let mut requirements = json!({"questionCount":10,"counts":{"single_choice":4,"multiple_choice":2,"fill_blank":2,"free_response":2}});
        quantities(&mut requirements, "只要选择和填空题").unwrap();
        assert!(requirements["counts"]["multiple_choice"].as_u64().unwrap() > 0);
        assert!(
            !strings(&requirements["typeConstraints"]["excludedTypes"])
                .contains(&"multiple_choice".into())
        );
        let mut conflict = requirements.clone();
        assert!(quantities(&mut conflict, "10道题，只要选择和填空题，解答2题").is_err());
        assert!(quantities(&mut requirements, "10道题，选择8题，填空4题").is_err());
    }
    #[test]
    fn simulated_rule_prepare_uses_current_scope_and_keeps_type_constraints() {
        let directory = tempfile::tempdir().unwrap();
        let seed: Value = serde_json::from_str(include_str!("../../resources/seed.json")).unwrap();
        let store = Store::open(directory.path(), &seed).unwrap();
        let model = ModelClient::open(directory.path()).unwrap();
        let cancel = AtomicBool::new(false);
        let prepared = prepare(&store, &json!({"mode":"rule","message":"12道题，只要选择和填空题","requirements":{"mainScope":["rja-compulsory-1:2.1"],"learnedScope":["rja-compulsory-1:2.1"],"quantityPlan":{"counts":{"single_choice":6,"multiple_choice":0,"fill_blank":2,"free_response":2},"rationale":"旧建议","source":"model_suggestion"}}}), &model, &cancel).unwrap();
        let requirements = &prepared["requirements"];
        assert!(requirements.get("quantityPlan").is_none());
        assert_eq!(requirements["counts"]["free_response"], 0);
        assert_eq!(requirements["questionCount"], 12);
        assert!(!s(requirements, "goal").contains("集合"));
        assert!(!s(requirements, "goal").is_empty());
        assert_eq!(normalize(&store, requirements).unwrap(), *requirements);
        let mut tampered = requirements.clone();
        tampered["counts"]["free_response"] = json!(1);
        assert!(normalize(&store, &tampered).is_err());
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
            let output = json!({"requirements":{"counts":{"single_choice":30,"fill_blank":30,"free_response":30},"questionCount":90,"scoringMode":"points","targetScore":999,"durationMinutes":299,"mainScope":[],"goal":"模拟模型的教学建议"},"quantityIntent":{"questionCount":12,"excludedTypes":["free_response"]},"quantityPlan":{"counts":{"single_choice":9,"multiple_choice":0,"fill_blank":3,"free_response":0},"rationale":"基础题以选择辨析为主，辅以填空，不安排解答题。"},"summary":"模拟模型建议"});
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
