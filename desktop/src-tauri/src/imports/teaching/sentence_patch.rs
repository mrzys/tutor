//! Model patches are anchored to exact sentence spans; no mathematical verdicts.
use super::*;

fn escaped(chars: &[char], at: usize) -> bool {
    let mut i = at;
    let mut count = 0;
    while i > 0 && chars[i - 1] == '\\' {
        count += 1;
        i -= 1;
    }
    count % 2 == 1
}
fn token(chars: &[char], at: usize, value: &str) -> bool {
    let part = value.chars().collect::<Vec<_>>();
    chars.get(at..at + part.len()) == Some(part.as_slice())
}
fn js_whitespace(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
/// Sentence boundaries are display structure only, never a method selector.
pub(super) fn sentences(text: &str) -> Vec<(usize, usize)> {
    let chars = text.chars().collect::<Vec<_>>();
    let mut out = vec![];
    let mut from = 0;
    let mut i = 0;
    let mut close: Option<&str> = None;
    while i < chars.len() {
        if !escaped(&chars, i) {
            if let Some(end) = close {
                if token(&chars, i, end) {
                    i += end.chars().count();
                    close = None;
                    continue;
                }
            } else {
                let open = if token(&chars, i, "$$") {
                    Some(("$$", "$$"))
                } else if chars[i] == '$' {
                    Some(("$", "$"))
                } else if token(&chars, i, "\\(") {
                    Some(("\\(", "\\)"))
                } else if token(&chars, i, "\\[") {
                    Some(("\\[", "\\]"))
                } else {
                    None
                };
                if let Some((start, end)) = open {
                    close = Some(end);
                    i += start.chars().count();
                    continue;
                }
            }
        }
        if close.is_none() {
            let stop = matches!(chars[i], '。' | '！' | '？' | '；' | '!' | '?' | ';' | '\n')
                || (chars[i] == '.'
                    && (i + 1 == chars.len() || js_whitespace(chars[i + 1]))
                    && !(i > 0
                        && i + 1 < chars.len()
                        && chars[i - 1].is_ascii_digit()
                        && chars[i + 1].is_ascii_digit()));
            if stop {
                out.push((from, i + 1));
                from = i + 1;
            }
        }
        i += 1;
    }
    if close.is_none() && from < chars.len() {
        out.push((from, chars.len()));
    }
    out
}
pub(super) fn locate(text: &str, f: &Value) -> Option<(usize, usize)> {
    if let (Some(start), Some(end)) = (f["start"].as_u64(), f["end"].as_u64()) {
        if end > start {
            if let (Some(a), Some(b)) = (
                utf16_byte_offset(text, start as usize),
                utf16_byte_offset(text, end as usize),
            ) {
                if f["term"].as_str().is_none_or(|term| &text[a..b] == term) {
                    return Some((text[..a].chars().count(), text[..b].chars().count()));
                }
            }
        }
    }
    for key in ["term", "quote", "oldText"] {
        let Some(value) = f[key].as_str().filter(|v| !v.is_empty()) else {
            continue;
        };
        if let Some(at) = text.find(value) {
            // Reject overlapping spellings too: "aa" occurs twice in "aaa".
            let after_start = at + text[at..].chars().next()?.len_utf8();
            if text[after_start..].contains(value) {
                continue;
            }
            let a = text[..at].chars().count();
            return Some((a, a + value.chars().count()));
        }
    }
    None
}
fn text_field<'a>(candidate: &'a Value, path: &str) -> Option<&'a str> {
    candidate.pointer(&controls::field_pointer(path)?)?.as_str()
}

pub(super) fn complete(candidate: &Value, id: &str) -> bool {
    !(validate(candidate, id).is_err()
        || ["answer", "teachingSolution"]
            .iter()
            .any(|p| s(candidate, p).trim().is_empty())
        || s(&candidate["difficultyAssessment"], "basis")
            .trim()
            .is_empty()
        || s(&candidate["teachingFocus"], "examFocus")
            .trim()
            .is_empty()
        || rows(&candidate["teachingFocus"]["studentRequirements"]).is_empty())
}
pub(super) fn contract(id: &str, source: &str, context: &Value) -> Option<Value> {
    let compact=review_protocol::v2(context);
    if compact && (!resolutions::classroom_policy(context)||!resolutions::typed(context)){return None;}
    let candidate = &context["candidate"];
    if !complete(candidate, id) {
        return None;
    }
    let flags = rows(&context["reviewFindings"]);
    if flags.is_empty() {
        return None;
    }
    let mut ranges: Vec<(String, usize, usize)> = vec![];
    for f in &flags {
        if !matches!(s(f, "type"), "term" | "display" | "quality" | "model_issue") {
            continue;
        }
        let path = s(f, "fieldPath");
        let Some(text) = text_field(candidate, path) else {
            continue;
        };
        let Some((a, b)) = locate(text, f) else {
            continue;
        };
        let selected = sentences(text)
            .into_iter()
            .filter(|(start, end)| *start < b && a < *end)
            .collect::<Vec<_>>();
        if let (Some(first), Some(last)) = (selected.first(), selected.last()) {
            if last.1 - first.0 <= 1600 {
                ranges.push((path.into(), first.0, last.1));
            }
        }
    }
    ranges.sort();
    let mut merged: Vec<(String, usize, usize)> = vec![];
    for (path, start, end) in ranges {
        if let Some(last) = merged.last_mut() {
            if last.0 == path && start < last.2 {
                last.2 = last.2.max(end);
                continue;
            }
        }
        merged.push((path, start, end));
    }
    let scopes=if compact {review_protocol::method_scopes(context)?} else {vec![]};
    let mut approved_scopes:Vec<(String,usize,usize,String)>=vec![];
    for scope in &scopes {
        if !exact(scope,&["fieldPath","start","end","expectedText","scopeBasis"]) || scope["fieldPath"]!="teachingSolution" || s(scope,"scopeBasis").trim().is_empty() || s(scope,"scopeBasis").chars().count()>4000{return None;}
        let start=scope["start"].as_u64()? as usize;let end=scope["end"].as_u64()? as usize;
        let text=text_field(candidate,"teachingSolution")?;
        if start>=end || end-start>6000 || end>text.chars().count() || scope["expectedText"]!=text.chars().skip(start).take(end-start).collect::<String>(){return None;}
        let pieces=sentences(text);
        if !(start==0 || pieces.iter().any(|p|p.0==start)) || !pieces.iter().any(|p|p.1==end){return None;}
        if approved_scopes.iter().any(|(_,a,b,_)|start<*b && *a<end){return None;}
        if !flags.iter().any(|f|review_protocol::method_finding(f) && f["fieldPath"]=="teachingSolution" && locate(text,f).is_some_and(|(a,b)|start<=a && b<=end)){return None;}
        if merged.iter().any(|(path,a,b)|path=="teachingSolution" && start<*b && *a<end && !(start<=*a && *b<=end)){return None;}
        approved_scopes.push(("teachingSolution".into(),start,end,s(scope,"scopeBasis").to_owned()));
    }
    merged.retain(|(path,a,b)|!approved_scopes.iter().any(|(p,start,end,_)|p==path && *start<*b && *a<*end));
    for (path,start,end,_) in &approved_scopes {merged.push((path.clone(),*start,*end));}
    merged.sort();
    let segments=merged.into_iter().filter(|(path,start,end)|end-start<=1600 || approved_scopes.iter().any(|(p,a,b,_)|p==path && a==start && b==end)).enumerate().map(|(index,(path,start,end))|{
        let text=text_field(candidate,&path).unwrap();let expected=text.chars().skip(start).take(end-start).collect::<String>();
        let mut item=json!({"segmentId":format!("s{index}"),"fieldPath":path,"start":start,"end":end,"expectedText":expected,"expectedTextSha256":hash_json(&json!(expected)),"fieldTextSha256":hash_json(&json!(text))});
        if let Some((_,_,_,basis))=approved_scopes.iter().find(|(p,a,b,_)|p==&path && *a==start && *b==end){item["scope"]=json!("method");item["scopeBasis"]=json!(basis);}
        item
    }).collect::<Vec<_>>();
    let mut out = json!({"questionId":id,"candidateSha256":hash_json(candidate),"sourceContentSha256":source,"segmentPatchVersion":if compact {2}else{1},"allowedSegments":segments});
    if !scopes.is_empty(){out["methodScopes"]=json!(scopes);}
    if resolutions::typed(context) {
        out["resolutionVersion"]=json!(2);
        if resolutions::classroom_policy(context) {out["classroomPolicyVersion"]=json!(1);}
        let terms=resolutions::term_contract(context);
        if !terms.is_empty(){out["termFindings"]=json!(terms);}
    }
    let semantic = flags
        .into_iter()
        .filter(|f| f["type"] == "quality")
        .collect::<Vec<_>>();
    if !semantic.is_empty() {
        out["qualityFindings"] = json!(semantic);
    }
    let issues=rows(&candidate["issues"]).iter().enumerate().map(|(index,issue)|json!({"issueIndex":index,"expectedText":issue,"expectedTextSha256":hash_json(issue)})).collect::<Vec<_>>();
    if !issues.is_empty() {
        out["allowedIssues"] = json!(issues);
    }
    if compact && resolutions::occurrence_policy(context) {out["falsePositiveScopeVersion"]=json!(1);}
    if compact {out["requestId"]=json!(format!("r-{}",&hash_json(&out)[..16]));}
    Some(out)
}

pub(super) fn merge(id: &str, source: &str, context: &Value, response: &Value) -> AppResult<Value> {
    let bad = || {
        err(
            "invalid_teaching_patch",
            "句段补丁超出已定位范围或结构无效。",
        )
    };
    let stale = || err("revision_conflict", "句段原文、范围或候选版本已变化。");
    let derived = contract(id, source, context).ok_or_else(bad)?;
    let supplied = &context["patchContract"];
    if derived != *supplied {
        return Err(stale());
    }
    let expanded=review_protocol::expand(&derived,response)?;
    let response=&expanded;
    let mut keys = vec![
        "questionId",
        "candidateSha256",
        "sourceContentSha256",
        "patches",
        "unresolvedIssues",
    ];
    if derived["qualityFindings"].is_array() {
        keys.push("qualityResolutions");
    }
    if derived["allowedIssues"].is_array() {
        keys.push("issueResolutions");
    }
    if derived["termFindings"].is_array() {keys.push("termResolutions");}
    if !exact(response, &keys)
        || ["questionId", "candidateSha256", "sourceContentSha256"]
            .iter()
            .any(|k| response[*k] != derived[*k])
        || !strings(&response["unresolvedIssues"], 100, 4000)
        || !response["patches"].is_array()
        || rows(&response["patches"]).len() > 12
    {
        return Err(bad());
    }
    if !rows(&response["unresolvedIssues"]).is_empty() {
        return Err(err(
            "teaching_patch_unresolved",
            "句段范围内仍未解决，保留初稿待复核。",
        ));
    }
    let mut next = context["candidate"].clone();
    let mut replacements: Vec<(String, usize, usize, String)> = vec![];
    let mut seen = HashSet::new();
    for p in rows(&response["patches"]) {
        if !exact(&p, &["segmentId", "oldTextSha256", "newText"])
            || !seen.insert(s(&p, "segmentId").to_owned())
        {
            return Err(bad());
        }
        let span = rows(&derived["allowedSegments"])
            .into_iter()
            .find(|v| v["segmentId"] == p["segmentId"])
            .ok_or_else(bad)?;
        let path = s(&span, "fieldPath");
        let text = text_field(&context["candidate"], path).ok_or_else(bad)?;
        let start = span["start"].as_u64().ok_or_else(bad)? as usize;
        let end = span["end"].as_u64().ok_or_else(bad)? as usize;
        let actual = text
            .chars()
            .skip(start)
            .take(end - start)
            .collect::<String>();
        if span["fieldTextSha256"] != hash_json(&json!(text))
            || span["expectedText"] != actual
            || span["expectedTextSha256"] != hash_json(&json!(actual))
            || p["oldTextSha256"] != span["expectedTextSha256"]
        {
            return Err(stale());
        }
        if !p["newText"].is_string() {
            return Err(bad());
        }
        let cap=if span["scope"]=="method"{12000}else{6000.min(1000.max(actual.chars().count()*3))};
        if s(&p, "newText").chars().count() > cap {
            return Err(err(
                "teaching_patch_scope_exceeded",
                "补丁超出获准句段的有界长度。",
            ));
        }
        replacements.push((path.into(), start, end, s(&p, "newText").into()));
    }
    replacements.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
    let mut prior: Option<(&str, usize)> = None;
    for (path, start, end, replacement) in &replacements {
        if prior.is_some_and(|(p, previous_start)| p == path && *end > previous_start) {
            return Err(bad());
        }
        let pointer = controls::field_pointer(path).ok_or_else(bad)?;
        let current = next.pointer_mut(&pointer).ok_or_else(bad)?;
        let mut chars = current
            .as_str()
            .ok_or_else(bad)?
            .chars()
            .collect::<Vec<_>>();
        if *end > chars.len() || start >= end {
            return Err(stale());
        }
        chars.splice(*start..*end, replacement.chars());
        *current = json!(chars.into_iter().collect::<String>());
        prior = Some((path, *start));
    }
    if derived["allowedIssues"].is_array() {
        let entries = rows(&response["issueResolutions"]);
        let allowed = rows(&derived["allowedIssues"]);
        let mut handled = HashSet::new();
        if !response["issueResolutions"].is_array() || entries.len() != allowed.len() {
            return Err(bad());
        }
        for r in entries {
            if !exact(&r, &["issueIndex", "oldTextSha256", "status", "basis"])
                || !handled.insert(r["issueIndex"].as_u64().ok_or_else(bad)?)
                || s(&r, "basis").trim().is_empty()
                || s(&r, "basis").chars().count() > 4000
            {
                return Err(bad());
            }
            let issue = allowed
                .iter()
                .find(|v| v["issueIndex"] == r["issueIndex"])
                .ok_or_else(bad)?;
            if r["oldTextSha256"] != issue["expectedTextSha256"] {
                return Err(stale());
            }
            if !resolutions::typed(context) && r["status"] != "resolved" {
                return Err(err(
                    "teaching_patch_unresolved",
                    "材料疑点尚未核实，保留初稿待复核。",
                ));
            }
        }
        if resolutions::typed(context){resolutions::issue(context,response,&next)?;}
        next["issues"] = json!([]);
    }
    validate(&next, id)?;
    if resolutions::typed(context){resolutions::terms(context,response,&next)?;}
    validate_quality_resolutions(context, response, &next)?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn context(text: &str, term: &str) -> Value {
        json!({"candidate":{"questionId":"sim-span-q","answer":"2","difficultyAssessment":{"level":"easy","basis":"模拟回归：直接计算。"},"teachingSolution":text,"teachingFocusSchemaVersion":2,"teachingFocus":{"examFocus":"模拟整数加法。","studentRequirements":["能计算1+1。"]},"issues":[]},"reviewFindings":[{"type":"term","fieldPath":"teachingSolution","term":term}]})
    }
    fn bind(mut ctx: Value) -> Value {
        ctx["patchContract"] = contract("sim-span-q", "sim-source", &ctx).unwrap();
        ctx
    }
    fn response(ctx: &Value, new_text: &str) -> Value {
        let c = &ctx["patchContract"];
        let span = &c["allowedSegments"][0];
        json!({"questionId":c["questionId"],"candidateSha256":c["candidateSha256"],"sourceContentSha256":c["sourceContentSha256"],"patches":[{"segmentId":span["segmentId"],"oldTextSha256":span["expectedTextSha256"],"newText":new_text}],"unresolvedIssues":[]})
    }
    #[test]
    fn simulated_sentence_patch_preserves_unrelated_equations_and_unicode() {
        let mut ctx = context(
            "😀先取$x=1$。\n由$F''(x)=e^x+1/x^2>0$，得导函数递增。\n最后代入得2。",
            "F''",
        );
        let text = s(&ctx["candidate"], "teachingSolution").to_owned();
        let start = text.find("F''").unwrap();
        ctx["reviewFindings"][0]["start"] = json!(text[..start].encode_utf16().count());
        ctx["reviewFindings"][0]["end"] = json!(text[..start + 3].encode_utf16().count());
        let ctx = bind(ctx);
        let c = &ctx["patchContract"];
        assert_eq!(c["allowedSegments"][0]["start"], 10);
        assert_eq!(
            c["allowedSegments"][0]["expectedText"],
            "由$F''(x)=e^x+1/x^2>0$，得导函数递增。"
        );
        let next = merge(
            "sim-span-q",
            "sim-source",
            &ctx,
            &response(&ctx, "因为$e^x$与$-1/x$均递增，所以导函数递增。"),
        )
        .unwrap();
        assert_eq!(
            next["teachingSolution"],
            "😀先取$x=1$。\n因为$e^x$与$-1/x$均递增，所以导函数递增。\n最后代入得2。"
        );
        assert_eq!(next["answer"], ctx["candidate"]["answer"]);
    }
    #[test]
    fn simulated_sentence_segmentation_never_splits_multiline_math() {
        assert_eq!(
            sentences("先看$$a;\nb=1$$。\n再看\\[x?\ny\\]。"),
            vec![(0, 13), (13, 14), (14, 25)]
        );
        let ctx = bind(context("第一句。重复词。重复词。结尾。", "重复词"));
        assert!(rows(&ctx["patchContract"]["allowedSegments"]).is_empty());
        let overlapping = bind(context("aaa。", "aa"));
        assert!(rows(&overlapping["patchContract"]["allowedSegments"]).is_empty());
        let mut ctx = context("😀重复词。重复词。", "重复词");
        ctx["reviewFindings"][0]["start"] = json!(2);
        ctx["reviewFindings"][0]["end"] = json!(5);
        assert_eq!(
            bind(ctx)["patchContract"]["allowedSegments"][0]["expectedText"],
            "😀重复词。"
        );
    }
    #[test]
    fn simulated_sentence_patch_rejects_stale_widened_duplicate_and_unresolved_atomically() {
        let ctx = bind(context("前句。下界为2。后句。", "下界"));
        let good = response(&ctx, "最小值是2。");
        let before = ctx.clone();
        for alteration in 0..6 {
            let mut p = good.clone();
            let mut c = ctx.clone();
            match alteration {
                0 => p["patches"][0]["segmentId"] = json!("forged"),
                1 => p["patches"][0]["oldTextSha256"] = json!("stale"),
                2 => c["candidate"]["answer"] = json!("3"),
                3 => c["patchContract"]["allowedSegments"][0]["start"] = json!(0),
                4 => p["patches"] = json!([p["patches"][0].clone(), p["patches"][0].clone()]),
                _ => p["unresolvedIssues"] = json!(["模拟：需要修改其他句段。"]),
            }
            assert!(merge("sim-span-q", "sim-source", &c, &p).is_err());
            assert_eq!(ctx, before);
        }
    }
    #[test]
    fn simulated_material_resolution_is_model_explicit_and_cannot_modify_text() {
        let mut ctx = context("已逐项算出A、C、D成立。", "not-present");
        ctx["candidate"]["issues"] = json!(["模拟：不知道是否多选。"]);
        ctx["reviewFindings"] = json!([{"type":"model_issue","issue":"模拟：不知道是否多选。"}]);
        let ctx = bind(ctx);
        let c = &ctx["patchContract"];
        assert!(rows(&c["allowedSegments"]).is_empty());
        let mut p = json!({"questionId":c["questionId"],"candidateSha256":c["candidateSha256"],"sourceContentSha256":c["sourceContentSha256"],"patches":[],"unresolvedIssues":[],"issueResolutions":[{"issueIndex":0,"oldTextSha256":c["allowedIssues"][0]["expectedTextSha256"],"status":"resolved","basis":"模拟：核对原输入questionType明确为multiple_choice。"}]});
        let next = merge("sim-span-q", "sim-source", &ctx, &p).unwrap();
        assert_eq!(
            next["teachingSolution"],
            ctx["candidate"]["teachingSolution"]
        );
        assert_eq!(next["issues"], json!([]));
        p["issueResolutions"][0]["status"] = json!("unresolved");
        assert_eq!(
            merge("sim-span-q", "sim-source", &ctx, &p)
                .unwrap_err()
                .code,
            "teaching_patch_unresolved"
        );
    }
    #[test]
    fn simulated_unlocated_semantic_finding_never_authorizes_whole_solution() {
        let mut ctx = context("由题意得2。另一个正确步骤。", "missing");
        ctx["reviewFindings"] = json!([{"type":"quality","id":"sim-proof","dimension":"proof","fieldPath":"teachingSolution","reason":"模拟：缺少证明，但未定位句段。"}]);
        let ctx = bind(ctx);
        assert!(rows(&ctx["patchContract"]["allowedSegments"]).is_empty());
        let c = &ctx["patchContract"];
        let p = json!({"questionId":c["questionId"],"candidateSha256":c["candidateSha256"],"sourceContentSha256":c["sourceContentSha256"],"patches":[],"unresolvedIssues":[],"qualityResolutions":[{"id":"sim-proof","status":"resolved","basis":"模拟声称完成。"}]});
        assert_eq!(
            merge("sim-span-q", "sim-source", &ctx, &p)
                .unwrap_err()
                .code,
            "teaching_quality_unchanged"
        );
    }
    #[test]
    fn simulated_failed_review_retains_initial_without_projection_promoting_it() {
        let c = context("由 $1+1=2$ 得答案。", "missing")["candidate"].clone();
        let mut q = json!({"questionId":"sim-span-q","questionType":"fill_blank","stem":"模拟1+1？","options":[],"parts":[],"answer":"","solution":"","teachingWorkflow":{"initialCandidate":c,"candidateResult":c,"finalResult":null,"reviewCalls":1,"status":"reviewing","findings":[]}});
        q["teachingWorkflow"]["sourceContentSha256"] = json!(source_hash(&q));
        mark(&mut q, "invalid_teaching_patch", "模拟失败：模型补丁越界。");
        assert_eq!(q["teachingWorkflow"]["retainedInitialCandidate"], c);
        assert_eq!(
            q["teachingWorkflow"]["retainedInitialReason"],
            "invalid_teaching_patch"
        );
        controls::refresh(&mut q);
        assert!(!ready(&q));
        assert_eq!(q["teachingWorkflow"]["status"], "needs_review");
        assert!(q["teachingWorkflow"]["finalResult"].is_null());
        assert_eq!(controls::active_candidate(&q), c);
        assert_eq!(q["teachingWorkflow"]["reviewCalls"], 1);
    }
    #[test]
    fn simulated_new_complete_review_cannot_bypass_segments_by_omitting_contract() {
        let mut ctx = context("由 $1+1=2$ 得答案。", "missing");
        ctx["reviewFindings"] = json!([]);
        ctx["reviewScopePolicy"] = json!("sentence_only");
        assert!(contract("sim-span-q", "sim-source", &ctx).is_none());
        let initial = ctx["candidate"].clone();
        assert_eq!(
            decode_review_candidate("sim-span-q", "sim-source", &ctx, &initial).unwrap(),
            initial
        );
        let mut changed = initial.clone();
        changed["teachingSolution"] = json!("模拟未经授权的全稿重写。");
        assert_eq!(
            decode_review_candidate("sim-span-q", "sim-source", &ctx, &changed)
                .unwrap_err()
                .code,
            "teaching_patch_scope_exceeded"
        );
        let mut incomplete = ctx.clone();
        incomplete["candidate"]["difficultyAssessment"]["basis"] = json!("");
        assert!(contract("sim-span-q", "sim-source", &incomplete).is_none());
        assert_eq!(
            decode_review_candidate("sim-span-q", "sim-source", &incomplete, &initial).unwrap(),
            initial
        );
    }
    #[test]
    fn simulated_shared_sentence_contracts_and_atomic_results_match_js_fixtures() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../../scripts/resources/teaching-sentence-patch-fixtures.json"
        ))
        .unwrap();
        assert_eq!(fixture["version"], 1);
        assert_eq!(rows(&fixture["cases"]).len(), 22);
        for case in rows(&fixture["cases"]) {
            let mut ctx = case["context"].clone();
            let expected = &case["contract"];
            let id = s(expected, "questionId");
            let source = hash_json(&ctx["originalMaterial"]);
            assert_eq!(
                contract(id, &source, &ctx).unwrap(),
                *expected,
                "{}",
                s(&case, "name")
            );
            ctx["patchContract"] = expected.clone();
            let before = ctx.clone();
            let result = merge(id, &source, &ctx, &case["response"]);
            if case["accepted"] == true {
                assert_eq!(
                    result.unwrap(),
                    case["expectedCandidate"],
                    "{}",
                    s(&case, "name")
                );
            } else {
                assert!(result.is_err(), "{}", s(&case, "name"));
            }
            assert_eq!(ctx, before, "{}", s(&case, "name"));
        }
    }
}
