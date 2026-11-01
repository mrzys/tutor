//! Typed dispositions for new review requests. These validate the declared
//! action and exact text scope; they do not independently establish mathematics.
use super::*;

pub(super) fn typed(context: &Value) -> bool {
    if context["patchContract"].is_object() {
        context["patchContract"]["resolutionVersion"] == 2
    } else {
        context["reviewResolutionVersion"] == 2
    }
}
pub(super) fn status(value: &Value) -> bool {
    matches!(
        value.as_str(),
        Some("repaired" | "false_positive" | "confirmed_defect" | "unresolved")
    )
}
// Explicit classroom wording contract on new requests only. This does not
// classify mathematical correctness or silently upgrade archived contracts.
pub(super) fn classroom_policy(context: &Value) -> bool {
    if context["patchContract"].is_object() {
        context["patchContract"]["classroomPolicyVersion"] == 1
    } else {
        context["classroomPolicyVersion"] == 1
    }
}
/// New calls can keep one explicitly reviewed occurrence while other sentences
/// in that field change. Archived contracts still require an unchanged field.
pub(super) fn occurrence_policy(context: &Value) -> bool {
    if context["patchContract"].is_object() {
        context["patchContract"]["falsePositiveScopeVersion"] == 1
    } else {
        context["falsePositiveScopeVersion"] == 1
    }
}

fn cleared(value: &Value) -> bool {
    matches!(value.as_str(), Some("repaired" | "false_positive"))
}
fn changed(before: &Value, after: &Value, path: &str) -> bool {
    let pointer = controls::field_pointer(path).or_else(|| match path {
        "difficultyAssessment" => Some("/difficultyAssessment".into()),
        "teachingFocus" => Some("/teachingFocus".into()),
        "teachingFocus.studentRequirements" => Some("/teachingFocus/studentRequirements".into()),
        _ => None,
    });
    pointer.is_some_and(|p| {
        text_changed(
            before.pointer(&p).unwrap_or(&Value::Null),
            after.pointer(&p).unwrap_or(&Value::Null),
        )
    })
}
// Version 2 must repair the authorized segment for this occurrence. A change
// to another sentence in the same field cannot clear an untouched finding.
// Archived version 1 contracts retain their original field-level semantics.
fn repaired_change(context: &Value, response: &Value, next: &Value, finding: &Value) -> bool {
    let path = s(finding, "fieldPath");
    if !changed(&context["candidate"], next, path) {
        return false;
    }
    if !review_protocol::v2(context) {
        return true;
    }
    let contract = &context["patchContract"];
    if contract["segmentPatchVersion"] != 2
        || sentence_patch::contract(s(contract, "questionId"), s(contract, "sourceContentSha256"), context)
            .as_ref() != Some(contract)
    {
        return false;
    }
    let Some(pointer) = controls::field_pointer(path) else { return false; };
    let Some(text) = context["candidate"].pointer(&pointer).and_then(Value::as_str) else { return false; };
    let Some((start, end)) = sentence_patch::locate(text, finding) else { return false; };
    rows(&contract["allowedSegments"]).iter().any(|span| {
        span["fieldPath"] == path
            && span["start"].as_u64().is_some_and(|a| a <= start as u64)
            && span["end"].as_u64().is_some_and(|b| end as u64 <= b)
            && rows(&response["patches"]).iter().any(|patch| {
                patch["segmentId"] == span["segmentId"]
                    && patch["oldTextSha256"] == span["expectedTextSha256"]
                    && patch["newText"].is_string()
                    && patch["newText"] != span["expectedText"]
            })
    })
}
fn text_changed(before: &Value, after: &Value) -> bool {
    if before.is_string() || after.is_string() {
        return before != after;
    }
    if let (Some(a), Some(b)) = (before.as_object(), after.as_object()) {
        return a.keys().chain(b.keys()).any(|k| {
            k != "level"
                && text_changed(
                    a.get(k).unwrap_or(&Value::Null),
                    b.get(k).unwrap_or(&Value::Null),
                )
        });
    }
    if let (Some(a), Some(b)) = (before.as_array(), after.as_array()) {
        return (0..a.len().max(b.len())).any(|i| {
            text_changed(
                a.get(i).unwrap_or(&Value::Null),
                b.get(i).unwrap_or(&Value::Null),
            )
        });
    }
    false
}
pub(super) fn substantive_change(before: &Value, after: &Value) -> bool {
    before["answer"] != after["answer"]
        || before["teachingSolution"] != after["teachingSolution"]
        || before["teachingFocus"] != after["teachingFocus"]
}
pub(super) fn quality(context: &Value, response: &Value, next: &Value) -> AppResult<()> {
    let flags = rows(&context["reviewFindings"])
        .into_iter()
        .filter(|f| f["type"] == "quality")
        .collect::<Vec<_>>();
    let entries = rows(&response["qualityResolutions"]);
    let mut seen = HashSet::new();
    if !response["qualityResolutions"].is_array() || entries.len() != flags.len() {
        return Err(err(
            "teaching_quality_unresolved",
            "质量疑点须逐项区分已修复、误报、确认缺陷或未解决。",
        ));
    }
    for r in entries {
        let f = flags
            .iter()
            .find(|f| f["id"] == r["id"])
            .ok_or_else(|| err("teaching_quality_unresolved", "质量处理身份不匹配。"))?;
        if !exact(&r, &["id", "status", "basis"])
            || !seen.insert(s(&r, "id").to_owned())
            || !status(&r["status"])
            || s(&r, "basis").trim().is_empty()
            || s(&r, "basis").chars().count() > 4000
        {
            return Err(err(
                "teaching_quality_unresolved",
                "质量处理状态或依据无效；旧resolved不等于缺陷已消除。",
            ));
        }
        if !cleared(&r["status"]) {
            return Err(err(
                "teaching_quality_unresolved",
                "质量疑点仍存在，保留初稿待核，不撤销缺陷。",
            ));
        }
        if r["status"] == "repaired" && !repaired_change(context, response, next, f) {
            return Err(err(
                "teaching_quality_unchanged",
                "声明已修复但未实际修改该疑点对应的获准文本。",
            ));
        }
    }
    Ok(())
}
pub(super) fn issue(context: &Value, response: &Value, next: &Value) -> AppResult<()> {
    for r in rows(&response["issueResolutions"]) {
        if !status(&r["status"]) {
            return Err(err(
                "invalid_teaching_patch",
                "材料意见须使用明确四种处理状态，不能用resolved泛称已处理。",
            ));
        }
        if !cleared(&r["status"]) {
            return Err(err(
                "teaching_patch_unresolved",
                "确认原题有缺陷不等于已修复；保留待核。",
            ));
        }
        if r["status"] == "repaired" && !substantive_change(&context["candidate"], next) {
            return Err(err(
                "teaching_quality_unchanged",
                "仅撤销意见或修改难度依据，不能证明题目缺陷已修复。",
            ));
        }
    }
    Ok(())
}
pub(super) fn term_contract(context: &Value) -> Vec<Value> {
    let mut seen = HashSet::new();
    let mut out = vec![];
    for f in rows(&context["reviewFindings"]) {
        if f["type"] != "term" {
            continue;
        }
        let id = hash_json(&json!([
            f["ruleId"],
            f["fieldPath"],
            f["term"],
            f["start"],
            f["end"]
        ]));
        if seen.insert(id.clone()) {
            let mut item=json!({"findingId":id,"ruleId":f["ruleId"],"fieldPath":f["fieldPath"],"term":f["term"],"start":f["start"],"end":f["end"]});
            if review_protocol::v2(context) {if let Some(category)=f.get("category"){item["category"]=category.clone();}}
            if classroom_policy(context) && f["ruleId"] == "limit-notation" {
                item["requiredAction"]=json!("rewrite_without_limits");
            }
            out.push(item);
        }
    }
    out
}
pub(super) fn terms(context: &Value, response: &Value, next: &Value) -> AppResult<()> {
    let allowed = rows(&context["patchContract"]["termFindings"]);
    if allowed.is_empty() {
        return Ok(());
    }
    let entries = rows(&response["termResolutions"]);
    let mut seen = HashSet::new();
    if !response["termResolutions"].is_array() || entries.len() != allowed.len() {
        return Err(err(
            "invalid_teaching_patch",
            "术语复核须逐项提供处理结论。",
        ));
    }
    for r in entries {
        let f = allowed
            .iter()
            .find(|f| f["findingId"] == r["findingId"])
            .ok_or_else(|| err("invalid_teaching_patch", "术语复核身份不存在。"))?;
        if !exact(&r, &["findingId", "status", "basis"])
            || !seen.insert(s(&r, "findingId").to_owned())
            || !status(&r["status"])
            || s(&r, "basis").trim().is_empty()
            || s(&r, "basis").chars().count() > 4000
        {
            return Err(err(
                "invalid_teaching_patch",
                "术语处理身份、状态或依据无效。",
            ));
        }
        if !cleared(&r["status"]) {
            return Err(err(
                "teaching_patch_unresolved",
                "术语或方法问题仍未解决，保留待核。",
            ));
        }
        if f["requiredAction"] == "rewrite_without_limits" && r["status"] == "false_positive" {
            return Err(err("teaching_classroom_rewrite_required", "本次课堂稿要求改写极限论证；数学上正确不能代替课堂改写，保留初稿待核。"));
        }
        if r["status"] == "repaired" && !repaired_change(context, response, next, f) {
            return Err(err(
                "teaching_quality_unchanged",
                "术语声明已修复但对应文本没有变化。",
            ));
        }
    }
    Ok(())
}
/// Map an unchanged whole sentence through authorized patches. Merely retaining
/// the same keyword is insufficient: the full sentence and exact occurrence,
/// including formula boundaries, must survive at the computed new location.
fn retained_occurrence(context: &Value, response: &Value, next: &Value, old: &Value, current: &Value) -> bool {
    if ["ruleId", "fieldPath", "term"].iter().any(|key| old[*key] != current[*key]) { return false; }
    let Some(pointer) = controls::field_pointer(s(old,"fieldPath")) else { return false; };
    let Some(before) = context["candidate"].pointer(&pointer).and_then(Value::as_str) else { return false; };
    let Some(after) = next.pointer(&pointer).and_then(Value::as_str) else { return false; };
    let Some(current_a)=current["start"].as_u64().and_then(|v|utf16_byte_offset(after,v as usize)) else { return false; };
    let Some(current_b)=current["end"].as_u64().and_then(|v|utf16_byte_offset(after,v as usize)) else { return false; };
    if current_a>=current_b || current["term"].as_str()!=Some(&after[current_a..current_b]) { return false; }
    let Some((a,b)) = sentence_patch::locate(before,old) else { return false; };
    let Some((start,end)) = sentence_patch::sentences(before).into_iter().find(|(x,y)|*x<=a && b<=*y) else { return false; };
    let before_chars=before.chars().collect::<Vec<_>>();
    let mut offset:isize=0;
    let mut changes=vec![];
    for patch in rows(&response["patches"]) {
        let Some(span)=rows(&context["patchContract"]["allowedSegments"]).into_iter().find(|v|v["segmentId"]==patch["segmentId"]) else { return false; };
        if span["fieldPath"]!=old["fieldPath"] { continue; }
        let Some(x)=span["start"].as_u64().map(|v|v as usize) else { return false; };
        let Some(y)=span["end"].as_u64().map(|v|v as usize) else { return false; };
        let Some(text)=patch["newText"].as_str() else { return false; };
        changes.push((x,y,text.chars().collect::<Vec<_>>()));
    }
    changes.sort_by_key(|v|v.0);
    for (x,y,replacement) in changes {
        if y<=start { offset+=replacement.len() as isize-(y-x) as isize; continue; }
        if end<=x { continue; }
        let original=&before_chars[x..y];
        let prefix=original.iter().zip(&replacement).take_while(|(a,b)|a==b).count();
        let suffix=original.iter().rev().zip(replacement.iter().rev()).take_while(|(a,b)|a==b).count().min(original.len()-prefix);
        if x+prefix>=end { continue; }
        if y-suffix<=start { offset+=replacement.len() as isize-original.len() as isize; continue; }
        return false;
    }
    let Some(mapped_start)=start.checked_add_signed(offset) else { return false; };
    let Some(mapped_end)=end.checked_add_signed(offset) else { return false; };
    let after_chars=after.chars().collect::<Vec<_>>();
    if after_chars.get(mapped_start..mapped_end)!=before_chars.get(start..end)
        || !sentence_patch::sentences(after).contains(&(mapped_start,mapped_end)) { return false; }
    sentence_patch::locate(after,current)==Some((a.checked_add_signed(offset).unwrap_or(usize::MAX),b.checked_add_signed(offset).unwrap_or(usize::MAX)))
}

/// A model false-positive verdict is bound to the source/candidate contract.
/// New occurrence-policy contracts allow unrelated sentence edits; old
/// contracts retain the previous whole-field equality requirement.
pub(super) fn filter_terms(flags: Vec<Value>, context: &Value, response: &Value, next: &Value) -> Vec<Value> {
    let expanded=match review_protocol::expand(&context["patchContract"],response){Ok(v)=>v,Err(_)=>return flags};
    if !typed(context) || terms(context, &expanded, next).is_err() { return flags; }
    let contract=&context["patchContract"];
    let valid=sentence_patch::merge(s(contract,"questionId"),s(contract,"sourceContentSha256"),context,response)
        .is_ok_and(|merged|merged==*next);
    if !valid { return flags; }
    flags.into_iter().filter(|f| {
        if f["type"]!="term" { return true; }
        !rows(&contract["termFindings"]).iter().any(|old| {
            if !rows(&expanded["termResolutions"]).iter().any(|r|r["findingId"]==old["findingId"] && r["status"]=="false_positive") { return false; }
            if occurrence_policy(context) { return retained_occurrence(context,&expanded,next,old,f); }
            let id=hash_json(&json!([f["ruleId"],f["fieldPath"],f["term"],f["start"],f["end"]]));
            let Some(pointer)=controls::field_pointer(s(f,"fieldPath")) else { return false; };
            old["findingId"]==id && context["candidate"].pointer(&pointer).is_some_and(|v|v.is_string())
                && context["candidate"].pointer(&pointer)==next.pointer(&pointer)
        })
    }).collect()
}
pub(super) fn reviewed_findings(q: &Value, candidate: &Value, flags: Vec<Value>) -> Vec<Value> {
    let wf = &q["teachingWorkflow"];
    if wf["termResolvedCandidateSha256"] != hash_json(candidate)
        || wf["termResolvedSourceSha256"] != source_hash(q)
        || wf["reviewPatchContract"]["resolutionVersion"] != 2
    {
        return flags;
    }
    let context = json!({"candidate":wf["reviewPatchBaseCandidate"],"patchContract":wf["reviewPatchContract"],"reviewFindings":wf["termReviewFindings"]});
    if context["patchContract"]["candidateSha256"] != hash_json(&context["candidate"])
        || context["patchContract"]["sourceContentSha256"] != source_hash(q)
    {
        return flags;
    }
    filter_terms(flags, &context, &wf["reviewPatchResponse"], candidate)
}

#[cfg(test)]
#[path = "resolution_tests.rs"]
mod tests;
