//! Conditional classroom-draft review. Rules locate text/format issues only;
//! they never decide mathematics, rewrite words, or alter source transcription.
use super::*;
use regex::Regex;
use std::sync::OnceLock;
pub(super) mod controls;

const DICTIONARY: &str = include_str!("../../../../scripts/resources/teaching-term-triggers.json");
const PROMPT: &str = include_str!("../../../../docs/design/math-teaching-analysis-prompt.md");
const REVIEW: &str =
    include_str!("../../../../scripts/resources/teaching-quality-review-instruction.txt");
const PATCH_REVIEW: &str = include_str!("../../../../scripts/resources/teaching-bounded-patch-instruction.txt");
const QUALITY_INSTRUCTION: &str = include_str!("../../../../scripts/resources/teaching-quality-signals-instruction.txt");

const QUALITY_DIMENSIONS: [&str; 5] = ["mathematics", "proof", "method", "explanation", "assessment"];
fn parse_quality_findings(value: &Value, origin: &str) -> AppResult<Vec<Value>> {
    let entries=value.as_array().filter(|a|a.len()<=30).ok_or_else(||err("invalid_quality_signals","质量疑点列表无效。"))?;
    let mut seen=HashSet::new();let mut out=vec![];
    for f in entries {
        if !exact(f,&["id","dimension","fieldPath","reason"]) || s(f,"id").is_empty() || s(f,"id").len()>80
            || !s(f,"id").bytes().all(|c|c.is_ascii_alphanumeric()||c==b'_'||c==b'-') || !seen.insert(s(f,"id").to_owned())
            || (!QUALITY_DIMENSIONS.contains(&s(f,"dimension"))&&f["dimension"]!="material")
            || !f["fieldPath"].is_string() || s(f,"fieldPath").len()>120 || s(f,"reason").trim().is_empty() || s(f,"reason").chars().count()>4000 {
            return Err(err("invalid_quality_signals","质量疑点身份、维度或具体说明不完整。"));
        }
        let mut v=f.clone();v["type"]=json!("quality");v["origin"]=json!(origin);v["message"]=f["reason"].clone();out.push(v);
    }
    Ok(out)
}
fn parse_quality_signals(value: &Value,id:&str)->AppResult<Vec<Value>> {
    if value.is_null(){return Ok(vec![]);}
    if !exact(value,&["questionId","checks","findings"]) || value["questionId"]!=id || !exact(&value["checks"],&QUALITY_DIMENSIONS)
        || QUALITY_DIMENSIONS.iter().any(|k|!matches!(s(&value["checks"],k),"pass"|"concern"|"unknown")) {
        return Err(err("invalid_quality_signals","质量自检结构或题目身份不完整。"));
    }
    let out=parse_quality_findings(&value["findings"],"generation_self_check")?;
    if QUALITY_DIMENSIONS.iter().any(|k|value["checks"][*k]=="concern"&&!out.iter().any(|f|f["dimension"]==*k)) {
        return Err(err("invalid_quality_signals","质量自检concern须说明具体问题。"));
    }
    Ok(out)
}
/// Bind trusted operator findings to the actual source and exact draft. This
/// is not a model-controlled input field and does not grant another review.
pub(super) fn attach_quality_review(q:&mut Value,payload:&Value)->AppResult<()> {
    let candidate=controls::active_candidate(q);
    if candidate.is_null() || payload["questionId"]!=q["questionId"] || payload["sourceContentSha256"]!=source_hash(q)
        || payload["candidateSha256"]!=hash_json(&candidate)
        || !matches!((s(payload,"method"),s(payload,"checkedBy")),("teacher_review","teacher")|("user_authorized_agent_review","codex"))
        || s(payload,"evidence").trim().is_empty() || s(payload,"evidence").chars().count()>5000 {
        return Err(err("teaching_quality_binding","质量核验须绑定当前原题、候选稿及实际核验身份。"));
    }
    let flags=parse_quality_findings(&payload["findings"],"external_review")?;
    if flags.is_empty(){return Err(err("invalid_quality_signals","请提供确切待复核问题，不用空核验覆盖旧问题。"));}
    let previous=q["teachingWorkflow"]["externalQualityReview"].clone();
    if !previous.is_null(){let mut history=rows(&q["teachingWorkflow"]["externalQualityReviewHistory"]);history.push(previous);q["teachingWorkflow"]["externalQualityReviewHistory"]=json!(history);}
    for key in ["qualityResolvedCandidateSha256","qualityResolvedSourceSha256"]{q["teachingWorkflow"].as_object_mut().unwrap().remove(key);}
    q["teachingWorkflow"]["externalQualityReview"]=json!({"questionId":q["questionId"],"sourceContentSha256":source_hash(q),"candidateSha256":hash_json(&candidate),"method":payload["method"],"checkedBy":payload["checkedBy"],"evidence":payload["evidence"],"findings":payload["findings"]});
    controls::refresh(q);Ok(())
}
pub(in crate::imports) fn record_quality_review(store:&Store,payload:&Value,cancel:&AtomicBool)->AppResult<Value> {
    cancelled(cancel)?;let op=operation(payload)?;let digest=hash_json(payload);let mut record=store.document("imports",s(payload,"importId"))?;
    if replay(&record,op,&digest)? {return Ok(json!({"import":record}));}revision(&record,payload)?;
    if record["pendingPublication"].is_object()||matches!(s(&record["backgroundJob"],"status"),"queued"|"running") {return Err(err("import_running","试卷仍在处理，不能附加核验。"));}
    let saved=record.clone();let index=rows(&record["questions"]).iter().position(|q|q["questionId"]==payload["questionId"]).ok_or_else(||err("invalid_import","题目不属于本次导入。"))?;
    if ids(&record["publishedQuestionIds"]).contains(&s(payload,"questionId").to_owned()){return Err(err("already_published","已发布题目不由此维护入口改写。"));}
    attach_quality_review(&mut record["questions"][index],payload)?;finish(&mut record,op,&digest,"teaching_quality_finding");save_cas(store,Some(&saved),&record)?;Ok(json!({"import":record}))
}
fn quality_findings(q:&Value,candidate:&Value)->Vec<Value> {
    let wf=&q["teachingWorkflow"];
    let result=(||->AppResult<Vec<Value>>{
        let mut out=vec![];
        if !wf["qualitySignals"].is_null(){
            if wf["qualitySignalsCandidateSha256"]!=hash_json(&wf["initialCandidate"]){return Err(err("teaching_quality_binding","质量自检候选版本已变化。"));}
            out.extend(parse_quality_signals(&wf["qualitySignals"],s(q,"questionId"))?);
        }
        let audit=&wf["externalQualityReview"];
        if !audit.is_null(){
            if audit["sourceContentSha256"]!=source_hash(q) || ![&wf["initialCandidate"],candidate].iter().any(|c|audit["candidateSha256"]==hash_json(c))
                || audit["questionId"]!=q["questionId"] || !matches!((s(audit,"method"),s(audit,"checkedBy")),("teacher_review","teacher")|("user_authorized_agent_review","codex")) || s(audit,"evidence").trim().is_empty(){return Err(err("teaching_quality_binding","外部质量核验的来源或候选版本不一致。"));}
            out.extend(parse_quality_findings(&audit["findings"],"external_review")?);
        }
        // The saved patch contract/responses are replayed by verify_audit;
        // these receipts only project whether known findings were addressed.
        if wf["qualityResolvedCandidateSha256"]==hash_json(candidate) && wf["qualityResolvedSourceSha256"]==source_hash(q){return Ok(vec![]);}
        let mut seen=HashSet::new();out.retain(|f|seen.insert((s(f,"origin").to_owned(),s(f,"id").to_owned())));Ok(out)
    })();
    result.unwrap_or_else(|e|vec![json!({"type":"format","code":e.code,"message":e.message})])
}
fn validate_quality_resolutions(context:&Value,response:&Value,next:&Value)->AppResult<()> {
    let flags=rows(&context["reviewFindings"]).into_iter().filter(|f|f["type"]=="quality").collect::<Vec<_>>();
    if flags.is_empty(){return Ok(());}
    let resolutions=rows(&response["qualityResolutions"]);let mut seen=HashSet::new();
    if !response["qualityResolutions"].is_array()||resolutions.len()!=flags.len()||resolutions.iter().any(|r|!exact(r,&["id","status","basis"])||!seen.insert(s(r,"id").to_owned())||!flags.iter().any(|f|f["id"]==r["id"])||r["status"]!="resolved"||s(r,"basis").trim().is_empty()||s(r,"basis").chars().count()>4000){return Err(err("teaching_quality_unresolved","质量疑点未逐项给出可靠修正依据，保留待复核。"));}
    if flags.iter().any(|f|matches!(s(f,"dimension"),"mathematics"|"proof"|"method"))&&next["teachingSolution"]==context["candidate"]["teachingSolution"] {return Err(err("teaching_quality_unchanged","数学、证明或方法问题未实际修订推导，保留待复核。"));}
    let mut allowed=HashSet::new();
    for f in rows(&context["reviewFindings"]) {
        if f["type"]=="quality"&&matches!(s(&f,"dimension"),"mathematics"|"proof"|"method"|"material") {for k in ["answer","teachingSolution","difficultyAssessment","teachingFocus"]{allowed.insert(k.to_owned());}}
        else if f["type"]=="quality"&&f["dimension"]=="assessment"{allowed.insert("difficultyAssessment".to_owned());allowed.insert("teachingFocus".to_owned());}
        else {allowed.insert(s(&f,"fieldPath").to_owned());}
    }
    for k in ["questionId","answer","teachingSolution","teachingFocusSchemaVersion","difficultyAssessment","teachingFocus"] {
        if !allowed.contains(k)&&!allowed.iter().any(|p|p.starts_with(&format!("{k}.")))&&next[k]!=context["candidate"][k] {return Err(err("invalid_teaching_patch","完整复核结果修改了与实际问题无关的字段。"));}
    }Ok(())
}

pub(crate) fn generation_instruction() -> String {
    let main = PROMPT
        .split("<!-- teaching-prompt-start -->")
        .nth(1)
        .unwrap()
        .split("```text")
        .nth(1)
        .unwrap()
        .split("【输出】")
        .next()
        .unwrap();
    format!(
        "\n【本次导入的独立课堂教学生成】\n原题与参考均已保存，本请求只输出独立教学稿，不修改或重新转录原卷。原卷缺少答案解析时，referenceAnswer/referenceSolution仍为空；你生成的答案只属于新稿。\n{main}\n【本批输出合同】只返回严格JSON对象{{\"questions\":[{{\"questionId\":\"输入精确ID\",\"answer\":\"新生成答案\",\"difficultyAssessment\":{{\"level\":null,\"basis\":\"\"}},\"teachingSolution\":\"新生成课堂解析\",\"teachingFocusSchemaVersion\":2,\"teachingFocus\":{{\"examFocus\":\"\",\"studentRequirements\":[]}},\"issues\":[]}}]}}。完整覆盖本批每个questionId且仅一次，不新增、遗漏、合并或换题；每个元素恰含上述7个字段。原文冲突写入issues，不静默改正原卷或冒称官方解析。公式用成对$或$$，JSON反斜杠规范转义。正常可解题完整填写，不能可靠完成的部分留空并说明疑点。默认不附加八板块方法参考。{QUALITY_INSTRUCTION}"
    )
}

fn dictionary() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    DATA.get_or_init(|| serde_json::from_str(DICTIONARY).expect("shared classroom dictionary"))
}
fn exact(value: &Value, fields: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|o| o.len() == fields.len() && fields.iter().all(|f| o.contains_key(*f)))
}
fn strings(value: &Value, max: usize, limit: usize) -> bool {
    value.as_array().is_some_and(|a| {
        a.len() <= max
            && a.iter().all(|v| {
                v.as_str()
                    .is_some_and(|s| !s.trim().is_empty() && s.chars().count() <= limit)
            })
    })
}
pub(super) fn validate(candidate: &Value, id: &str) -> AppResult<()> {
    if !exact(
        candidate,
        &[
            "questionId",
            "answer",
            "difficultyAssessment",
            "teachingSolution",
            "teachingFocusSchemaVersion",
            "teachingFocus",
            "issues",
        ],
    ) || candidate["questionId"] != id
        || candidate["teachingFocusSchemaVersion"] != 2
        || !candidate["answer"].is_string()
        || !candidate["teachingSolution"].is_string()
        || s(candidate, "answer").chars().count() > 30000
        || s(candidate, "teachingSolution").chars().count() > 60000
        || !exact(&candidate["difficultyAssessment"], &["level", "basis"])
        || !candidate["difficultyAssessment"]["basis"].is_string()
        || s(&candidate["difficultyAssessment"], "basis")
            .chars()
            .count()
            > 5000
        || !exact(
            &candidate["teachingFocus"],
            &["examFocus", "studentRequirements"],
        )
        || !candidate["teachingFocus"]["examFocus"].is_string()
        || s(&candidate["teachingFocus"], "examFocus").chars().count() > 600
        || !strings(&candidate["teachingFocus"]["studentRequirements"], 3, 400)
        || !strings(&candidate["issues"], 100, 4000)
    {
        return Err(err(
            "invalid_teaching_candidate",
            "独立教学稿字段、身份或结构不完整，需复核。",
        ));
    }
    annotations::normalize_difficulty(candidate)?;
    Ok(())
}
fn generated_fields(candidate: &Value) -> Vec<(String, String)> {
    let mut fields = vec![];
    for (path, value) in [
        ("answer", &candidate["answer"]),
        ("teachingSolution", &candidate["teachingSolution"]),
        (
            "difficultyAssessment.basis",
            &candidate["difficultyAssessment"]["basis"],
        ),
        (
            "teachingFocus.examFocus",
            &candidate["teachingFocus"]["examFocus"],
        ),
    ] {
        if let Some(text) = value.as_str() {
            fields.push((path.into(), text.into()));
        }
    }
    for (i, v) in rows(&candidate["teachingFocus"]["studentRequirements"])
        .iter()
        .enumerate()
    {
        if let Some(text) = v.as_str() {
            fields.push((
                format!("teachingFocus.studentRequirements[{i}]"),
                text.into(),
            ));
        }
    }
    fields
}
fn match_excerpt(text: &str, start: usize, end: usize) -> String {
    let before: String = text[..start].chars().rev().take(40).collect::<Vec<_>>()
        .into_iter().rev().collect();
    let after: String = text[end..].chars().take(40).collect();
    format!("{before}{}{after}", &text[start..end])
}
fn utf16_byte_offset(text: &str, offset: usize) -> Option<usize> {
    let mut units = 0;
    for (i, c) in text.char_indices() {
        if units == offset { return Some(i); }
        units += c.len_utf16();
        if units > offset { return None; }
    }
    (units == offset).then_some(text.len())
}
// Transport projection only: source material and the full draft remain intact.
// Historical full-field excerpts and duplicate guidance need not be re-sent
// for every occurrence. Stored candidates/findings and the review allowance
// are untouched; distinct or malformed raw output is always retained.
fn review_context(q: &Value) -> Value {
    let workflow = &q["teachingWorkflow"];
    let active=controls::active_candidate(q);
    let candidate = if active.is_null(){&workflow["initialCandidate"]}else{&active};
    let raw = workflow.get("rawCandidate").unwrap_or(candidate);
    let duplicate = !candidate.is_null() && candidate == raw;
    let mut context = json!({"originalMaterial":material(q),"candidate":candidate,"rawCandidate":if duplicate { &Value::Null } else { raw },"reviewFindings":workflow["initialFindings"],"imageReviewAvailable":false});
    if duplicate { context["rawCandidateSameAsCandidate"] = json!(true); }
    // An explicitly resumed old, unreviewed candidate may newly hit v3. Send
    // the current locations as well as its archived findings, without changing
    // historical records or resetting a spent review allowance.
    let mut flags = rows(&workflow["initialFindings"]);
    for f in quality_findings(q,candidate){if !flags.contains(&f){flags.push(f);}}
    for detected in findings(candidate, s(q, "questionId")) {
        if !flags.iter().any(|old| ["type", "code", "ruleId", "fieldPath", "start", "end", "issue"].iter().all(|key| old[*key] == detected[*key])) {
            flags.push(detected);
        }
    }
    context["reviewFindings"] = json!(flags);
    context["dictionaryVersion"] = dictionary()["version"].clone();
    let fields = generated_fields(candidate);
    let mut rules = vec![];
    if let Some(flags) = context["reviewFindings"].as_array_mut() {
        for flag in flags {
            if let Some(guidance) = flag.get("guidance").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                let rule = json!({"ruleId":flag["ruleId"],"guidance":guidance});
                let index = rules.iter().position(|r| r == &rule).unwrap_or_else(|| {
                    rules.push(rule); rules.len() - 1
                });
                flag.as_object_mut().unwrap().remove("guidance");
                flag["reviewGuidanceIndex"] = json!(index);
            }
            if let Some((_, text)) = fields.iter().find(|(path, _)| Some(path.as_str()) == flag["fieldPath"].as_str()) {
                if let (Some(start), Some(end)) = (flag["start"].as_u64(), flag["end"].as_u64()) {
                    if let (Some(start), Some(end)) = (utf16_byte_offset(text, start as usize), utf16_byte_offset(text, end as usize)) {
                        if start <= end { flag["excerpt"] = json!(match_excerpt(text, start, end)); }
                    }
                }
            }
        }
    }
    if !rules.is_empty() { context["reviewRules"] = json!(rules); }
    context
}

/// Explicit development-only re-review of saved candidates. A fresh user
/// operation is separate from the archived workflow: no Store/DB is opened and
/// the original reviewCalls are neither reset nor modified.
#[cfg(debug_assertions)]
pub(super) fn explicit_review_candidates(
    model: &ModelClient,
    manifest: &Value,
    output: &Path,
    cancel: &AtomicBool,
) -> AppResult<Value> {
    let op = operation(manifest)?;
    let entries = manifest["entries"].as_array().filter(|a| !a.is_empty() && a.len() <= 32)
        .ok_or_else(|| err("invalid_teaching_review_targets", "请提供1至32道明确的复核题目。"))?;
    let mut unique = HashSet::new();
    for item in entries {
        let q = &item["question"];
        let id = s(q, "questionId");
        if id.is_empty() || !unique.insert(id.to_owned()) || item["expectedQuestionHash"] != hash_json(q) {
            return Err(err("teaching_review_target_changed", "复核题目身份重复、缺失或快照哈希已变化。"));
        }
        let wf = &q["teachingWorkflow"];
        let draft = &wf["initialCandidate"];
        validate(draft, id)?;
        if wf["sourceContentSha256"] != source_hash(q) {
            return Err(err("teaching_review_source_changed", "原题或参考已变化，不能使用旧稿复核。"));
        }
        let current = findings(draft, id);
        let timeout = wf["reviewCalls"] == 1
            && wf["finalResult"].is_null()
            && rows(&wf["findings"]).iter().any(|f| matches!(s(f,"code"), "model_request_timeout" | "model_response_timeout"));
        let new_hit = wf["reviewCalls"] == 0
            && wf["dictionaryVersion"] != dictionary()["version"]
            && current.iter().any(|f| f["type"] == "term"
                && matches!(s(f,"ruleId"), "integral-tool" | "higher-derivative" | "infinite-series" | "english-method-language" | "linear-combination-language" | "limit-notation")
                && !rows(&wf["initialFindings"]).iter().any(|old| old["type"] == "term" && old["ruleId"] == f["ruleId"] && old["fieldPath"] == f["fieldPath"] && old["start"] == f["start"] && old["end"] == f["end"]))
            && !current.is_empty();
        if !matches!(s(item,"reason"), "previous_timeout" | "new_rule_hit")
            || (item["reason"] == "previous_timeout" && !timeout)
            || (item["reason"] == "new_rule_hit" && !new_hit)
        {
            return Err(err("teaching_review_ineligible", "仅允许本次明确授权的旧复核超时题或新词表补检题，合格稿不重跑。"));
        }
    }
    cancelled(cancel)?;
    // Reserve the whole operation before discovering a provider or sending
    // HTTP. Existing output, including an interrupted attempt, cannot replay.
    std::fs::create_dir(output).map_err(|_| err("teaching_review_output_exists", "复核输出目录必须是不存在的新目录；已有操作不重复调用。"))?;
    let save_new = |path: &Path, value: &Value| -> AppResult<()> {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(path)?;
        file.write_all(&serde_json::to_vec_pretty(value)?)?;
        file.sync_all()?;
        Ok(())
    };
    save_new(&output.join("manifest.json"), manifest)?;
    save_new(&output.join("operation.json"), &json!({"operationId":op,"manifestSha256":hash_json(manifest),"startedAt":now(),"questionIds":entries.iter().map(|e|e["question"]["questionId"].clone()).collect::<Vec<_>>(),"databaseOpened":false,"maximumAdditionalReviewCallsPerQuestion":1}))?;
    let reviewer = model.import_teaching_reviewer()?;
    let catalogue = reviewer.verify_import_role_catalog()?;
    save_new(&output.join("provider-catalogue.json"), &catalogue)?;
    let settings = reviewer.public_settings();
    save_new(&output.join("review-profile.json"), &json!({"model":settings["model"],"baseUrl":settings["baseUrl"],"reasoningEffort":settings["reasoningEffort"],"profileId":settings["activeProfileId"]}))?;
    let mut results = vec![];
    for item in entries {
        cancelled(cancel)?;
        let q = &item["question"];
        let id = s(q,"questionId");
        let stem = &hash_json(&json!([op,id,item["expectedQuestionHash"]]))[..24];
        let directory = output.join(stem);
        std::fs::create_dir(&directory)?;
        let previous_calls = q["teachingWorkflow"]["reviewCalls"].as_u64().unwrap_or(0);
        let context = review_context(q);
        save_new(&directory.join("input.json"), &json!({"operationId":op,"questionId":id,"questionSha256":item["expectedQuestionHash"],"reason":item["reason"],"context":context}))?;
        let started_at = now();
        // This receipt consumes this new authorization before HTTP. If the
        // process exits, another invocation refuses the operation directory.
        save_new(&directory.join("attempt.json"), &json!({"operationId":op,"questionId":id,"startedAt":started_at,"previousReviewCalls":previous_calls,"additionalReviewCalls":1,"totalReviewCallsObserved":previous_calls+1,"state":"issued","sourceWorkflowUnchanged":true}))?;
        let response = directory.join("provider-response.json");
        let outcome = reviewer.propose_teaching_review_with_audit(&context, &[], cancel, &response);
        let mut result = json!({"operationId":op,"questionId":id,"questionSha256":item["expectedQuestionHash"],"reason":item["reason"],"startedAt":started_at,"finishedAt":now(),"previousReviewCalls":previous_calls,"additionalReviewCalls":1,"totalReviewCallsObserved":previous_calls+1,"dictionaryVersion":dictionary()["version"],"initialFindings":context["reviewFindings"],"candidate":null,"findings":[],"status":"review_failed","error":null,"auditDirectory":stem,"databaseOpened":false});
        match outcome {
            Ok(candidate) => {
                let detected = findings(&candidate,id);
                result["status"] = json!(if detected.is_empty(){"ready_candidate"}else{"needs_review"});
                result["candidate"] = candidate;
                result["findings"] = json!(detected);
            }
            Err(error) => {result["error"] = serde_json::to_value(error)?;}
        }
        save_new(&directory.join("result.json"), &result)?;
        results.push(result);
        save_new(&output.join(format!("checkpoint-{:03}.json",results.len())), &json!({"operationId":op,"completed":results.len(),"results":results}))?;
    }
    let summary = json!({"operationId":op,"manifestSha256":hash_json(manifest),"finishedAt":now(),"results":results,"databaseOpened":false,"bankWritten":false,"sourceRecordsWritten":false});
    save_new(&output.join("summary.json"), &summary)?;
    Ok(summary)
}
fn matcher(name: &str, text: &str) -> Vec<(usize, usize)> {
    if name == "modulo-notation" {
        // LaTeX command names end before a digit, underscore or Chinese text.
        // A regex word boundary would miss valid compact forms like \pmod3.
        let mut found = Regex::new(r"(?i)\\(?:pmod|bmod)").unwrap().find_iter(text)
            .filter(|m| text[m.end()..].chars().next().is_none_or(|c| !c.is_ascii_alphabetic()))
            .map(|m| (m.start(), m.end())).collect::<Vec<_>>();
        found.extend(Regex::new(r"(?i)[（(]\s*mod\s+[^()（）\r\n]{1,32}[)）]").unwrap()
            .find_iter(text).map(|m| (m.start(), m.end())));
        return found;
    }
    // The shared JS matchers use ASCII lookarounds; Rust regex has none.
    // Apply those boundaries after matching the same fixed expressions.
    let contextual = match name {
        "integral-notation" => Some((r"\\(?:int|iint|iiint|oint)|[∫∮]", false, true)),
        "english-classroom-method" => Some((r"(?:telescoping|geometric\s+series|infinite\s+series|integration\s+constant)", true, true)),
        "higher-derivative-primes" => Some((r"(?:[A-Za-z]|\\[A-Za-z]+)(?:_\s*(?:\{[A-Za-z0-9]+\}|[A-Za-z0-9]))?\s*(?:'{2,}|′{2,}|[″‴]|\^\s*\{\s*\\prime\s*\\prime(?:\s*\\prime)*\s*\})", true, false)),
        "higher-derivative-order" => Some((r"(?:[A-Za-z]|\\[A-Za-z]+)\s*\^\s*\{\s*\(\s*(?:[2-9]|[1-9]\d+)\s*\)\s*\}", true, false)),
        "higher-derivative-fraction" => Some((r"\\(?:frac|dfrac|tfrac)\s*\{\s*(?:d|\\mathrm\s*\{d\})\s*\^\s*\{?\s*(?:[2-9]|[1-9]\d+)\s*\}?", false, false)),
        "infinite-sum-notation" => Some((r"(?:\\sum|[∑Σ])\s*(?:\\limits\s*)?(?:_\s*(?:\{[^{}\r\n]{1,80}\}|[A-Za-z0-9=]+)\s*)?(?:\^\s*\{?\s*\+?\s*(?:\\infty|∞)|∞)", false, true)),
        "endpoint-limit-shorthand" => Some((r"(?:[A-Za-z]|\\[A-Za-z]+)\s*(?:\\left\s*)?\(\s*(?:(?:[+-]?\d+(?:\.\d+)?|[a-zA-Z])\s*(?:[+-]|\^\s*(?:\{\s*[+-]\s*\}|[+-]))|[+-]?\s*(?:\\infty|∞))\s*(?:\\right\s*)?\)", true, false)),
        _ => None,
    };
    if let Some((pattern, left, right)) = contextual {
        let english = name == "english-classroom-method";
        let expression = if english { format!("(?i){pattern}") } else { pattern.to_owned() };
        return Regex::new(&expression).unwrap().find_iter(text)
            .filter(|m| !left || text[..m.start()].chars().next_back().is_none_or(|c| !c.is_ascii_alphabetic() && (english || c != '\\')))
            .filter(|m| !right || m.as_str().chars().next_back().is_none_or(|c| !c.is_ascii_alphabetic()) || text[m.end()..].chars().next().is_none_or(|c| !c.is_ascii_alphabetic()))
            .map(|m| (m.start(), m.end())).collect();
    }
    if matches!(name, "phi-notation" | "limit-notation") {
        let mut out = vec![];
        let (plain, command) = if name == "phi-notation" {
            ("Phi", "\\Phi")
        } else {
            ("lim", "\\lim")
        };
        for (i, _) in text.match_indices(command) {
            let end = i + command.len();
            if text[end..]
                .chars()
                .next()
                .is_none_or(|c| !c.is_ascii_alphabetic())
            {
                out.push((i, end));
            }
        }
        for (i, _) in text.match_indices(plain) {
            let end = i + plain.len();
            if text[..i]
                .chars()
                .next_back()
                .is_none_or(|c| !c.is_ascii_alphabetic() && c != '\\')
                && text[end..]
                    .chars()
                    .next()
                    .is_none_or(|c| !c.is_ascii_alphabetic())
            {
                out.push((i, end));
            }
        }
        if name == "phi-notation" {
            out.extend(
                text.match_indices('Φ')
                    .map(|(i, _)| (i, i + 'Φ'.len_utf8())),
            );
        }
        return out;
    }
    let expression = match name {
        "modulo-number" => r"模\s*\$?\s*\d+(?:\s*\$)?",
        "operation-closure" => {
            r"(?:对|关于)\s*(?:加法|乘法|加、乘法|加法和乘法|加法与乘法|加法、乘法)\s*(?:运算)?\s*封闭"
        }
        "contextual-congruence" => {
            // The symbol may mean an identity. Only explicit modular context
            // in the same sentence triggers review, matching the shared JS scan.
            let mut found = vec![];
            for sentence in text.split_inclusive(['。', '！', '？', '!', '?', '\n']) {
                if sentence.contains("同余")
                    || !matcher("modulo-notation", sentence).is_empty()
                    || Regex::new(r"模\s*\$?\s*\d+|[（(]\s*mod\s+")
                        .unwrap()
                        .is_match(sentence)
                {
                    let offset = sentence.as_ptr() as usize - text.as_ptr() as usize;
                    for token in ["≡", "\\equiv"] {
                        for (i, _) in sentence.match_indices(token) {
                            if token == "\\equiv" && sentence[i + token.len()..].chars().next().is_some_and(|c| c.is_ascii_alphabetic()) {
                                continue;
                            }
                            found.push((offset + i, offset + i + token.len()));
                        }
                    }
                }
            }
            return found;
        }
        _ => panic!("unknown shared teaching matcher {name}"),
    };
    Regex::new(&format!("(?i){expression}"))
        .unwrap()
        .find_iter(text)
        .map(|m| (m.start(), m.end()))
        .collect()
}
fn escaped(text: &str, offset: usize) -> bool {
    text.as_bytes()[..offset]
        .iter()
        .rev()
        .take_while(|c| **c == b'\\')
        .count()
        % 2
        == 1
}
fn display_findings(field: &str, text: &str) -> Vec<Value> {
    let mut out = vec![];
    for (i, c) in text.char_indices() {
        if c.is_control() && c != '\n' && c != '\r' && c != '\t' {
            out.push(json!({"type":"display","code":"control_character","fieldPath":field,"start":text[..i].encode_utf16().count()}));
        }
    }
    for (i, _) in text.match_indices("\\n") {
        let rest = &text[i + 2..];
        if !escaped(text, i)
            && Regex::new(r"^(?:$|[\s\p{Han}\p{P}$])")
                .unwrap()
                .is_match(rest)
        {
            out.push(json!({"type":"display","code":"literal_newline_escape","fieldPath":field,"start":text[..i].encode_utf16().count()}));
        }
    }
    let mut opened: Option<&str> = None;
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let token = if bytes[i] == b'$' && !escaped(text, i) {
            if bytes.get(i + 1) == Some(&b'$') {
                Some("$$")
            } else {
                Some("$")
            }
        } else if bytes[i] == b'\\' && !escaped(text, i) {
            match bytes.get(i + 1) {
                Some(b'(') => Some("\\("),
                Some(b')') => Some("\\)"),
                Some(b'[') => Some("\\["),
                Some(b']') => Some("\\]"),
                _ => None,
            }
        } else {
            None
        };
        if let Some(token) = token {
            let closing = match token {
                "\\)" => Some("\\("),
                "\\]" => Some("\\["),
                _ => None,
            };
            if closing.is_some() {
                if opened == closing {
                    opened = None;
                } else {
                    out.push(json!({"type":"display","code":"unpaired_math_delimiter","fieldPath":field}));
                }
            } else if opened == Some(token) {
                opened = None;
            } else if opened.is_none() {
                opened = Some(token);
            } else {
                out.push(json!({"type":"display","code":"mixed_math_delimiter","fieldPath":field}));
            }
            i += token.len();
        } else {
            i += 1;
        }
    }
    if opened.is_some() {
        out.push(json!({"type":"display","code":"unpaired_math_delimiter","fieldPath":field}));
    }
    out
}
pub(super) fn findings(candidate: &Value, id: &str) -> Vec<Value> {
    let mut out = vec![];
    if let Err(error) = validate(candidate, id) {
        out.push(json!({"type":"format","code":error.code,"message":error.message}));
    }
    if s(candidate, "answer").trim().is_empty()
        || s(candidate, "teachingSolution").trim().is_empty()
        || s(&candidate["difficultyAssessment"], "basis")
            .trim()
            .is_empty()
        || s(&candidate["teachingFocus"], "examFocus")
            .trim()
            .is_empty()
        || rows(&candidate["teachingFocus"]["studentRequirements"]).is_empty()
    {
        out.push(json!({"type":"incomplete","code":"incomplete_teaching_draft"}));
    }
    for (path, text) in generated_fields(candidate) {
        for rule in rows(&dictionary()["rules"]) {
            let mut positions = vec![];
            for term in ids(&rule["terms"]) {
                positions.extend(text.match_indices(&term).map(|(i, _)| (i, i + term.len())));
            }
            for name in ids(&rule["matchers"]) {
                positions.extend(matcher(&name, &text));
            }
            positions.sort_by_key(|(start, end)| (std::cmp::Reverse(end - start), *start));
            let mut selected = vec![];
            for (start, end) in positions {
                if !selected.iter().any(|(s, e)| start < *e && *s < end) {
                    selected.push((start, end));
                }
            }
            selected.sort();
            for (start, end) in selected {
                out.push(json!({"type":"term","ruleId":rule["id"],"category":rule["category"],"fieldPath":path,"term":&text[start..end],"start":text[..start].encode_utf16().count(),"end":text[..end].encode_utf16().count(),"excerpt":match_excerpt(&text,start,end),"guidance":rule["guidance"]}));
            }
        }
        out.extend(display_findings(&path, &text));
    }
    for issue in rows(&candidate["issues"]) {
        out.push(json!({"type":"model_issue","issue":issue}));
    }
    for (i, issue) in rows(&candidate["issues"]).iter().enumerate() {
        if let Some(text) = issue.as_str() {
            out.extend(display_findings(&format!("issues[{i}]"), text));
        }
    }
    out
}
pub(super) fn source_hash(question: &Value) -> String {
    review::content_hash(question)
}
fn metadata(question: &Value) -> Value {
    json!({"task":question["task"],"difficultyAssessment":question["difficultyAssessment"],"solutionPaths":question["solutionPaths"]})
}
#[cfg(test)]
pub(super) fn initialize(question: &mut Value, raw: &Value) {
    let mut candidate = raw["generatedTeaching"].clone();
    if candidate.is_object() {
        candidate["questionId"] = question["questionId"].clone();
    }
    // Identical ownership to the offline workflow: scan the independent draft,
    // never source transcription, UID mappings, or existing path annotations.
    let detected = findings(&candidate, s(question, "questionId"));
    question["teachingWorkflow"] = json!({"version":"import-teaching-workflow-v1","sourceContentSha256":source_hash(question),"initialMetadata":metadata(question),"initialCandidate":candidate,"candidateResult":candidate,"finalResult":if detected.is_empty(){candidate.clone()}else{Value::Null},"initialFindings":detected,"findings":detected,"status":if detected.is_empty(){"ready_candidate"}else{"needs_review"},"reviewCalls":0,"dictionaryVersion":dictionary()["version"]});
}
pub(super) fn initialize_pending(question: &mut Value) {
    question["teachingWorkflow"] = json!({"version":"import-teaching-workflow-v2","sourceContentSha256":source_hash(question),"initialMetadata":metadata(question),"initialCandidate":null,"candidateResult":null,"finalResult":null,"initialFindings":[],"findings":[{"type":"incomplete","code":"teaching_generation_pending","message":"课堂教学稿尚未生成。"}],"status":"generation_pending","generationCalls":0,"reviewCalls":0,"dictionaryVersion":dictionary()["version"]});
}
pub(super) fn material(q: &Value) -> Value {
    json!({"questionId":q["questionId"],"questionType":q["questionType"],"stem":q["stem"],"options":q["options"],"parts":q["parts"],"referenceAnswer":q["answer"],"referenceSolution":q["solution"],"sourceIssues":q["sourceIssues"],"sourceIdentity":q["sourceIdentity"],"visuals":q["student"]["assets"]})
}
/// Reconstruct the exact candidate from a real full response or bounded patch.
/// The caller supplies a source hash computed in the actual request's domain.
pub(super) fn decode_review_candidate(id:&str,expected_source_hash:&str,context:&Value,response:&Value)->AppResult<Value>{
    if context["patchContract"].is_object(){
        controls::merge_bound_patch(id,expected_source_hash,context,response)
    }else if rows(&context["reviewFindings"]).iter().any(|f|f["type"]=="quality") {
        if !exact(response,&["candidate","qualityResolutions"]){return Err(err("teaching_quality_unresolved","质量复核须返回候选及逐项处理依据。"));}
        validate(&response["candidate"],id)?;validate_quality_resolutions(context,response,&response["candidate"])?;Ok(response["candidate"].clone())
    }else{
        validate(response,id)?;Ok(response.clone())
    }
}
fn request_receipt(store: &Store, response: &Path) -> AppResult<Value> {
    let path = response.with_extension("request.json");
    let bytes = std::fs::read(&path)?;
    let audit: Value = serde_json::from_slice(&bytes)?;
    Ok(
        json!({"requestSha256":audit["bodySha256"],"promptSha256":audit["promptSha256"],"requestRelativePath":audit_relative_path(store,&path)?,"requestFileSha256":sha(&bytes)}),
    )
}
/// Request-size partitioning only: these are stored type/part/byte contracts,
/// never inferred difficulty, knowledge coverage, or pedagogical suitability.
fn generation_batches(record: &Value, targets: &[usize]) -> Vec<Vec<usize>> {
    let mut batches = vec![];
    let mut compact = vec![];
    for index in targets {
        let question = &record["questions"][*index];
        let single = question["questionType"] == "free_response"
            || rows(&question["parts"]).len() > 1
            || material(question).to_string().chars().count() > 6000;
        if single {
            if !compact.is_empty() {
                batches.push(std::mem::take(&mut compact));
            }
            batches.push(vec![*index]);
        } else {
            compact.push(*index);
            if compact.len() == 3 {
                batches.push(std::mem::take(&mut compact));
            }
        }
    }
    if !compact.is_empty() {
        batches.push(compact);
    }
    batches
}
fn generate(
    store: &Store,
    model: &ModelClient,
    record: &mut Value,
    saved: &mut Value,
    assets: &[Value],
    cancel: &AtomicBool,
    selected: Option<&[usize]>,
    retry_operation: Option<&str>,
) -> AppResult<()> {
    let targets = rows(&record["questions"])
        .iter()
        .enumerate()
        .filter(|(index, q)| {
            selected.map_or_else(
                || q["teachingWorkflow"]["generationCalls"].as_u64() == Some(0),
                |indices| indices.contains(index),
            ) && q["teachingWorkflow"]["sourceContentSha256"] == source_hash(q)
        })
        .map(|(i, _)| i)
        .collect::<Vec<_>>();
    let batches = if retry_operation.is_some() {
        targets.iter().map(|index| vec![*index]).collect()
    } else {
        generation_batches(record, &targets)
    };
    for indices in &batches {
        cancelled(cancel)?;
        let qids = indices
            .iter()
            .map(|i| record["questions"][*i]["questionId"].clone())
            .collect::<Vec<_>>();
        let mut asset_ids = HashSet::new();
        for i in indices {
            for role in ["student", "teacher"] {
                for asset in rows(&record["questions"][*i][role]["assets"]) {
                    asset_ids.insert(s(&asset, "assetId").to_owned());
                }
            }
        }
        let relevant = assets
            .iter()
            .filter(|a| asset_ids.contains(s(a, "id")))
            .cloned()
            .collect::<Vec<_>>();
        let context = json!({"questions":indices.iter().map(|i|material(&record["questions"][*i])).collect::<Vec<_>>(),"imageReviewAvailable":model.import_review_images_supported()&&!relevant.is_empty(),"sourceSha256":record["source"]["sha256"],"recoveryOperationId":retry_operation});
        let root = prepare_attempt_path(store, record, "teaching-generation")?
            .parent()
            .unwrap()
            .to_path_buf();
        let response = root.join(format!(
            "teaching-generation-{}.provider-response.json",
            &hash_json(&json!([qids, record["source"]["sha256"], retry_operation]))[..24]
        ));
        for i in indices {
            let wf = &mut record["questions"][*i]["teachingWorkflow"];
            wf["generationCalls"] = json!(wf["generationCalls"].as_u64().unwrap_or(0) + 1);
            wf["status"] = json!("generating");
            wf["generationStartedAt"] = json!(now());
        }
        record["recognitionStage"] = json!("teaching_generating");
        save_cas(store, Some(saved), record)?;
        *saved = record.clone();
        let result =
            model.propose_teaching_generation_with_audit(&context, &relevant, cancel, &response);
        let receipt = if response.with_extension("request.json").exists() {
            request_receipt(store, &response)?
        } else {
            Value::Null
        };
        let batch = (|| -> AppResult<Vec<Value>> {
            let result = result.as_ref().map_err(|e| err(&e.code, &e.message))?;
            if !exact(result, &["questions"]) && !exact(result, &["questions","qualitySignals"]) {
                return Err(err("invalid_teaching_batch", "教学生成批次结构无效。"));
            }
            let returned = result["questions"]
                .as_array()
                .filter(|a| a.len() == indices.len())
                .ok_or_else(|| err("invalid_teaching_batch", "教学生成未完整覆盖本批题目。"))?;
            if let Some(signals)=result.get("qualitySignals") {
                let signals=signals.as_array().filter(|a|a.len()==indices.len()).ok_or_else(||err("invalid_quality_signals","批次质量自检未逐题覆盖。"))?;
                let mut signal_ids=HashSet::new();
                for signal in signals {
                    let id=s(signal,"questionId");
                    if !qids.iter().any(|v|v==id)||!signal_ids.insert(id.to_owned()){return Err(err("invalid_quality_signals","质量自检题目身份重复或未知。"));}
                    parse_quality_signals(signal,id)?;
                }
            }
            let mut seen = HashSet::new();
            for candidate in returned {
                let id = &candidate["questionId"];
                if !qids.contains(id) || !seen.insert(id.clone()) {
                    return Err(err(
                        "invalid_teaching_batch",
                        "教学生成批次出现重复或未知题目身份。",
                    ));
                }
            }
            Ok(returned.clone())
        })();
        for i in indices {
            let id = s(&record["questions"][*i], "questionId").to_owned();
            let wf = &mut record["questions"][*i]["teachingWorkflow"];
            wf["generationFinishedAt"] = json!(now());
            wf["lastResultOrigin"] = json!("generation");
            wf["model"] = model.public_settings()["model"].clone();
            for key in [
                "requestSha256",
                "promptSha256",
                "requestRelativePath",
                "requestFileSha256",
            ] {
                if receipt[key].is_string() {
                    wf[key] = receipt[key].clone();
                }
            }
            wf["generationAudit"] = receipt.clone();
            if response.exists() {
                wf["generationAudit"]["responseRelativePath"] =
                    json!(audit_relative_path(store, &response)?);
                wf["generationAudit"]["responseSha256"] = json!(sha(&std::fs::read(&response)?));
            }
            match &batch {
                Ok(values) => {
                    let c = values
                        .iter()
                        .find(|c| c["questionId"] == id)
                        .unwrap()
                        .clone();
                    let signal=result.as_ref().ok().and_then(|r|r["qualitySignals"].as_array()).and_then(|a|a.iter().find(|s|s["questionId"]==id)).cloned().unwrap_or(Value::Null);
                    let mut detected = findings(&c, &id);
                    detected.extend(parse_quality_signals(&signal,&id)?);
                    wf["qualitySignals"]=signal.clone();
                    wf["qualitySignalsCandidateSha256"]=json!(hash_json(&c));
                    wf["semanticAssessment"]=json!(if signal.is_null(){"unknown"}else{"model_self_check_only"});
                    // A successful explicit recovery supersedes an older format
                    // failure. Qwen must inspect this attempt's draft, never the
                    // previous raw response retained in its recovery audit.
                    wf["rawCandidate"] = c.clone();
                    wf["reviewEligible"] = json!(false);
                    wf["initialCandidate"] = c.clone();
                    wf["candidateResult"] = c.clone();
                    wf["initialFindings"] = json!(detected);
                    wf["findings"] = json!(detected);
                    wf["finalResult"] = if detected.is_empty() { c } else { Value::Null };
                    wf["status"] = json!(if detected.is_empty() {
                        "ready_candidate"
                    } else {
                        "needs_review"
                    });
                }
                Err(error) => {
                    wf["status"] = json!("generation_failed");
                    wf["findings"] =
                        json!([{"type":"technical","code":error.code,"message":error.message}]);
                    // A completed malformed response has safe original question
                    // identities now, and can be reviewed once without repair.
                    let format = matches!(
                        error.code.as_str(),
                        "model_output_invalid_json" | "invalid_teaching_batch"
                    );
                    wf["reviewEligible"] = json!(format);
                    wf["initialFindings"] = wf["findings"].clone();
                    if let Ok(raw) = &result {
                        wf["rawCandidate"] = raw.clone();
                    } else if response.exists() {
                        let raw: Value = serde_json::from_slice(&std::fs::read(&response)?)?;
                        wf["rawCandidate"] = raw["choices"][0]["message"]["content"].clone();
                    }
                }
            }
        }
        save_cas(store, Some(saved), record)?;
        *saved = record.clone();
        cancelled(cancel)?;
    }
    Ok(())
}
fn mark(question: &mut Value, code: &str, message: &str) {
    question["teachingWorkflow"]["status"] = json!("needs_review");
    question["teachingWorkflow"]["finalResult"] = Value::Null;
    let mut flags = rows(&question["teachingWorkflow"]["findings"]);
    let finding = json!({"type":"technical","code":code,"message":message});
    if !flags.contains(&finding) {
        flags.push(finding);
    }
    question["teachingWorkflow"]["findings"] = json!(flags);
}
/// Source content edits invalidate results; a UI cannot submit its own review.
pub(super) fn preserve(old: &Value, next: &mut Value) {
    if let Some(workflow) = old.get("teachingWorkflow") {
        next["teachingWorkflow"] = workflow.clone();
        if source_hash(next) != workflow["sourceContentSha256"] {
            mark(
                next,
                "source_changed",
                "题面或原卷参考已修改，旧教学稿失效，需重新核对。",
            );
        }
    }
}
pub(super) fn ready(question: &Value) -> bool {
    let workflow = &question["teachingWorkflow"];
    workflow["status"] == "ready_candidate"
        && workflow["sourceContentSha256"] == source_hash(question)
        && controls::effective_findings(question, &workflow["finalResult"]).is_empty()
        && rows(&workflow["findings"]).iter().all(|f| f["type"] == "model_issue" && controls::acknowledged(question,&workflow["finalResult"],s(f,"issue")))
}
pub(super) fn reason(question: &Value) -> String {
    if question.get("teachingWorkflow").is_none() || ready(question) {
        return String::new();
    }
    let candidate=controls::active_candidate(question);
    let mut flags = rows(&question["teachingWorkflow"]["findings"]).into_iter().filter(|f| f["type"]!="model_issue" || !controls::acknowledged(question,&candidate,s(f,"issue"))).collect::<Vec<_>>();
    if candidate.is_object(){for finding in controls::effective_findings(question,&candidate){if !flags.contains(&finding){flags.push(finding);}}}
    let detail = flags
        .iter()
        .map(|f| {
            if f["type"] == "term" {
                format!("术语“{}”", s(f, "term"))
            } else if f["type"] == "model_issue" {
                s(f, "issue").to_owned()
            } else {
                s(f, "message").to_owned()
            }
        })
        .filter(|s| !s.is_empty())
        .take(3)
        .collect::<Vec<_>>()
        .join("；");
    if detail.is_empty() {
        "教学稿仍有格式、显示或未完成问题，待复核。".into()
    } else {
        format!("教学稿待复核：{detail}")
    }
}

/// This runs only as part of an explicitly started import. Each quota is
/// committed before HTTP, so a crash/cancel/read/retry cannot spend it twice.
pub(super) fn process(
    store: &Store,
    model: &ModelClient,
    record: &mut Value,
    saved: &mut Value,
    assets: &[Value],
    cancel: &AtomicBool,
) -> AppResult<()> {
    process_selected(store, model, record, saved, assets, cancel, None, None)
}

/// Development maintenance only. A fresh explicit operation authorizes one
/// generation request per exact failed question, never an implicit retry loop.
#[cfg(debug_assertions)]
pub(super) fn retry_failed(
    store: &Store,
    model: &ModelClient,
    payload: &Value,
    cancel: &AtomicBool,
) -> AppResult<Value> {
    let op = operation(payload)?;
    let payload_hash = hash_json(payload);
    let mut record = store.document("imports", s(payload, "importId"))?;
    // Replay precedes revision checks: a lost CLI response must not spend again.
    if replay(&record, op, &payload_hash)? {
        return Ok(json!({"import":record,"replayed":true}));
    }
    revision(&record, payload)?;
    cancelled(cancel)?;
    if matches!(s(&record["backgroundJob"], "status"), "queued" | "running")
        || (record["status"] == "processing"
            && !matches!(
                s(&record["backgroundJob"], "status"),
                "interrupted" | "cancelled" | "failed"
            ))
        || !rows(&record["publishedQuestionIds"]).is_empty()
        || record["pendingPublication"].is_object()
    {
        return Err(err(
            "teaching_retry_blocked",
            "运行中、已发布或正在发布的导入不能重试教学稿。",
        ));
    }
    let requested = payload["questionIds"]
        .as_array()
        .filter(|ids| !ids.is_empty() && ids.len() <= MAX_QUESTIONS)
        .ok_or_else(|| {
            err(
                "invalid_teaching_retry_targets",
                "请明确指定非空的失败题目身份清单。",
            )
        })?;
    let mut unique = HashSet::new();
    let mut selected = vec![];
    let questions = rows(&record["questions"]);
    for requested_id in requested {
        let id = requested_id
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| {
                err(
                    "invalid_teaching_retry_targets",
                    "题目身份必须为非空字符串。",
                )
            })?;
        if !unique.insert(id) {
            return Err(err(
                "invalid_teaching_retry_targets",
                "失败题目清单含重复身份。",
            ));
        }
        let matching = questions
            .iter()
            .enumerate()
            .filter(|(_, q)| q["questionId"] == id)
            .collect::<Vec<_>>();
        if matching.len() != 1 {
            return Err(err(
                "invalid_teaching_retry_targets",
                "失败题目身份不存在或不唯一。",
            ));
        }
        let (index, question) = matching[0];
        let wf = &question["teachingWorkflow"];
        let interrupted = wf["status"] == "generating"
            || (wf["status"] == "needs_review"
                && rows(&wf["findings"])
                    .iter()
                    .any(|f| f["code"] == "generation_interrupted"));
        if wf["sourceContentSha256"] != source_hash(question)
            || !(wf["status"] == "generation_failed" || interrupted)
            || (!wf["finalResult"].is_null() && findings(&wf["finalResult"], id).is_empty())
            || ready(question)
        {
            return Err(err(
                "teaching_retry_ineligible",
                "只允许重试来源未变化且没有有效最终稿的生成失败或中断题目。",
            ));
        }
        selected.push(index);
    }
    // Validate the preserved source and assets before authorizing any model call.
    read_source(store, &record)?;
    let assets = if record["ocrSource"].is_object() {
        paddle::load_document(store, &record)?.assets
    } else {
        vec![]
    };
    let generator = model.import_generator()?;
    let audit_path =
        prepare_attempt_path(store, &record, op)?.with_extension("teaching-retry.json");
    let audit = json!({"task":"explicit_failed_teaching_retry","operationId":op,"payloadSha256":payload_hash,
        "importId":record["importId"],"expectedRevision":payload["expectedRevision"],"sourceSha256":record["source"]["sha256"],
        "questionIds":requested,"previousWorkflows":selected.iter().map(|index|json!({"questionId":questions[*index]["questionId"],"workflow":questions[*index]["teachingWorkflow"]})).collect::<Vec<_>>(),"startedAt":now()});
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&audit_path)?;
    file.write_all(&serde_json::to_vec_pretty(&audit)?)?;
    file.sync_all()?;
    let mut saved = record.clone();
    finish(&mut record, op, &payload_hash, "teaching_retry");
    record["teachingRetry"] = json!({"operationId":op,"questionIds":requested,"status":"started",
        "auditRelativePath":audit_relative_path(store,&audit_path)?,"auditSha256":sha(&std::fs::read(&audit_path)?),"startedAt":now()});
    record["status"] = json!("processing");
    record["error"] = Value::Null;
    // This operation receipt, source snapshot and target authorization precede
    // provider discovery and every request. Replaying it never resumes HTTP.
    save_cas(store, Some(&saved), &record)?;
    saved = record.clone();
    let outcome = generator.verify_import_role_catalog().and_then(|_| {
        process_selected(
            store,
            &generator,
            &mut record,
            &mut saved,
            &assets,
            cancel,
            Some(&selected),
            Some(op),
        )
    });
    record["status"] = json!("pending_review");
    record["recognitionStage"] = json!("complete");
    record["teachingRetry"]["finishedAt"] = json!(now());
    record["teachingRetry"]["status"] = json!(if outcome.is_ok() {
        "completed"
    } else {
        "failed"
    });
    if let Err(error) = outcome {
        record["error"] = serde_json::to_value(error)?;
    }
    // Only the selected workflows may change; all prior passing and pending
    // candidates, source fields and spent review allowances remain untouched.
    debug_assert!(
        questions
            .iter()
            .enumerate()
            .all(|(index, before)| selected.contains(&index)
                || before == &record["questions"][index])
    );
    save_cas(store, Some(&saved), &record)?;
    Ok(json!({"import":record,"replayed":false}))
}

fn process_selected(
    store: &Store,
    model: &ModelClient,
    record: &mut Value,
    saved: &mut Value,
    assets: &[Value],
    cancel: &AtomicBool,
    selected: Option<&[usize]>,
    retry_operation: Option<&str>,
) -> AppResult<()> {
    generate(
        store,
        model,
        record,
        saved,
        assets,
        cancel,
        selected,
        retry_operation,
    )?;
    let mut reviewer: Option<AppResult<ModelClient>> = None;
    let count = rows(&record["questions"]).len();
    for index in 0..count {
        if selected.is_some_and(|indices| !indices.contains(&index)) {
            continue;
        }
        cancelled(cancel)?;
        let q = &record["questions"][index];
        if ready(q) {
            continue;
        }
        if q["teachingWorkflow"]["sourceContentSha256"] != source_hash(q) {
            mark(
                &mut record["questions"][index],
                "source_changed",
                "题面或原卷参考已修改，旧教学稿失效，需重新核对。",
            );
            save_cas(store, Some(saved), record)?;
            *saved = record.clone();
            continue;
        }
        if q["teachingWorkflow"]["status"] == "generating" {
            mark(
                &mut record["questions"][index],
                "generation_interrupted",
                "上次教学生成已发起但结果未保存，保留待复核，不重复调用。",
            );
            save_cas(store, Some(saved), record)?;
            *saved = record.clone();
            continue;
        }
        if q["teachingWorkflow"]["status"] == "generation_failed"
            && q["teachingWorkflow"]["reviewEligible"] != true
        {
            continue;
        }
        if q["teachingWorkflow"]["generationCalls"] == 1
            && q["teachingWorkflow"]["initialCandidate"].is_null()
            && q["teachingWorkflow"]["reviewEligible"] != true
        {
            continue;
        }
        if q["teachingWorkflow"]["reviewCalls"].as_u64().unwrap_or(0) >= 1 {
            if q["teachingWorkflow"]["status"] == "reviewing" {
                mark(
                    &mut record["questions"][index],
                    "review_interrupted",
                    "上次复核已发起但结果未保存，保留待复核，不重复调用。",
                );
                save_cas(store, Some(saved), record)?;
                *saved = record.clone();
            }
            continue;
        }
        if reviewer.is_none() {
            reviewer = Some(model.import_teaching_reviewer().and_then(|client| {
                client.verify_import_role_catalog()?;
                Ok(client)
            }));
        }
        let client = match reviewer.as_ref().unwrap() {
            Ok(client) => client,
            Err(error) => {
                mark(&mut record["questions"][index], &error.code, &error.message);
                save_cas(store, Some(saved), record)?;
                *saved = record.clone();
                continue;
            }
        };
        let q = &record["questions"][index];
        let id = s(q, "questionId").to_owned();
        let mut context = review_context(q);
        if let Some(contract)=controls::patch_contract(q,&context) { context["patchContract"]=contract; }
        let bounded_patch=context["patchContract"].is_object();
        let directory = prepare_attempt_path(store, record, "teaching-review")?
            .parent()
            .unwrap()
            .to_path_buf();
        let stem = format!(
            "teaching-review-{}",
            &hash_json(&json!([id, source_hash(q), retry_operation]))[..24]
        );
        let input_path = directory.join(format!("{stem}.input.json"));
        let response_path = directory.join(format!("{stem}.provider-response.json"));
        let request_path = response_path.with_extension("request.json");
        record["questions"][index]["teachingWorkflow"]["reviewCalls"] = json!(1);
        record["questions"][index]["teachingWorkflow"]["status"] = json!("reviewing");
        record["questions"][index]["teachingWorkflow"]["reviewStartedAt"] = json!(now());
        if bounded_patch {
            record["questions"][index]["teachingWorkflow"]["reviewPatchBaseCandidate"]=context["candidate"].clone();
            record["questions"][index]["teachingWorkflow"]["reviewPatchContract"]=context["patchContract"].clone();
            record["questions"][index]["teachingWorkflow"]["reviewPatchSourceHashDomain"]=json!("question_content");
        } else {
            for field in ["reviewPatchBaseCandidate","reviewPatchContract","reviewPatchResponse","reviewPatchSourceHashDomain"] {
                record["questions"][index]["teachingWorkflow"].as_object_mut().unwrap().remove(field);
            }
        }
        record["recognitionStage"] = json!("teaching_review");
        save_cas(store, Some(saved), record)?;
        *saved = record.clone();
        let review_result = (|| -> AppResult<Value> {
            let body = json!({"task":"question_import_teaching_review","instruction":if bounded_patch {PATCH_REVIEW}else{REVIEW},"context":context,"model":client.public_settings()["model"],"reasoningEffort":"on","sourceContentSha256":source_hash(&record["questions"][index])});
            let mut file = std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&input_path)?;
            file.write_all(&serde_json::to_vec_pretty(&body)?)?;
            file.sync_all()?;
            client.propose_teaching_review_with_audit(&context, assets, cancel, &response_path)
        })();
        let workflow = &mut record["questions"][index]["teachingWorkflow"];
        workflow["reviewFinishedAt"] = json!(now());
        workflow["lastResultOrigin"] = json!("review");
        workflow["model"] = client.public_settings()["model"].clone();
        if request_path.exists() {
            let bytes = std::fs::read(&request_path)?;
            let request: Value = serde_json::from_slice(&bytes)?;
            workflow["requestSha256"] = request["bodySha256"].clone();
            workflow["promptSha256"] = request["promptSha256"].clone();
            workflow["requestRelativePath"] = json!(audit_relative_path(store, &request_path)?);
            workflow["requestFileSha256"] = json!(sha(&bytes));
        }
        if response_path.exists() {
            workflow["responseRelativePath"] = json!(audit_relative_path(store, &response_path)?);
            workflow["responseSha256"] = json!(sha(&std::fs::read(&response_path)?));
        }
        let review_result=review_result.and_then(|returned| {
            if bounded_patch {
                record["questions"][index]["teachingWorkflow"]["reviewPatchResponse"]=returned.clone();
                decode_review_candidate(&id,&source_hash(&record["questions"][index]),&context,&returned)
            } else {decode_review_candidate(&id,&source_hash(&record["questions"][index]),&context,&returned)}
        });
        match review_result {
            Ok(candidate) => {
                let detected = findings(&candidate, &id);
                let resolved=rows(&context["reviewFindings"]).iter().any(|f|f["type"]=="quality");
                let src=source_hash(&record["questions"][index]);
                let workflow = &mut record["questions"][index]["teachingWorkflow"];
                if resolved {workflow["qualityResolvedCandidateSha256"]=json!(hash_json(&candidate));workflow["qualityResolvedSourceSha256"]=json!(src);}
                workflow["reviewedCandidate"] = candidate.clone();
                workflow["candidateResult"] = candidate.clone();
                workflow["findings"] = json!(detected);
                workflow["status"] = json!(if detected.is_empty() {
                    "ready_candidate"
                } else {
                    "needs_review"
                });
                workflow["finalResult"] = if detected.is_empty() {
                    candidate
                } else {
                    Value::Null
                };
            }
            Err(error) => {
                let unresolved=rows(&record["questions"][index]["teachingWorkflow"]["reviewPatchResponse"]["unresolvedIssues"]);
                if bounded_patch && !unresolved.is_empty() {
                    for issue in unresolved { mark(&mut record["questions"][index],"teaching_patch_unresolved",issue.as_str().unwrap_or("受限复核尚未解决。")); }
                } else { mark(&mut record["questions"][index], &error.code, &error.message); }
            },
        }
        save_cas(store, Some(saved), record)?;
        *saved = record.clone();
        cancelled(cancel)?;
    }
    Ok(())
}

pub(super) fn apply_to_entry(
    question: &Value,
    raw: &Value,
    entry: &mut Value,
    operation: &str,
) -> AppResult<()> {
    if question.get("teachingWorkflow").is_none() {
        return Ok(());
    }
    let workflow = &question["teachingWorkflow"];
    let clean = ready(question);
    entry["importTeachingReview"] = json!({"status":if clean{"ready"}else{"needs_review"},"findings":workflow["findings"],"effectiveFindings":workflow["effectiveFindings"],"reviewDispositions":workflow["reviewDispositions"],"generationCalls":workflow["generationCalls"],"reviewCalls":workflow["reviewCalls"],"sourceContentSha256":workflow["sourceContentSha256"]});
    if !clean {
        return Ok(());
    }
    let result = &workflow["finalResult"];
    let generated_at = if workflow["lastResultOrigin"] == "generation" {
        workflow.get("generationFinishedAt")
    } else {
        workflow
            .get("reviewFinishedAt")
            .or_else(|| workflow.get("generationFinishedAt"))
    };
    let mut analysis = json!({"questionId":raw["questionId"],"baseContentVersion":raw["contentVersion"],"baseTeacherVersion":raw["teacherVersion"],"provenance":"llm_generated","model":workflow["model"],"promptSha256":workflow["promptSha256"],"requestSha256":workflow["requestSha256"],"operationId":operation,"solution":result["teachingSolution"],"generatedAt":generated_at.cloned().unwrap_or(json!(now())),"status":"ready","issues":[],"teachingFocusSchemaVersion":2,"teachingFocus":result["teachingFocus"]});
    analysis["answer"] = result["answer"].clone();
    analysis["issues"] = result["issues"].clone();
    analysis["sourceQuestionId"] = result["questionId"].clone();
    analysis["sourceContentSha256"] = workflow["sourceContentSha256"].clone();
    analysis["sourceCandidate"] = result.clone();
    if workflow["reviewDispositions"].is_object() { analysis["reviewDispositions"] = workflow["reviewDispositions"].clone(); }
    if !rows(&workflow["manualPatchHistory"]).is_empty() { analysis["manualPatchHistory"] = workflow["manualPatchHistory"].clone(); }
    if !rows(&workflow["controlActionsHistory"]).is_empty() { analysis["controlActionsHistory"] = workflow["controlActionsHistory"].clone(); }
    let digest = hash_json(&analysis);
    analysis["sha256"] = json!(digest);
    analysis["teachingVersion"] = json!(format!("teaching-{}", &digest[..16]));
    let mut checked = raw.clone();
    checked["teachingAnalysis"] = analysis.clone();
    crate::bank_teaching::verify_projection(&checked)?;
    entry["teachingAnalysis"] = analysis;
    if question["difficultyAssessment"] == workflow["initialMetadata"]["difficultyAssessment"] {
        let mut assessed = question.clone();
        assessed["difficultyAssessment"] = result["difficultyAssessment"].clone();
        assessed["difficultyAssessment"]["rubricVersion"] = json!("content-demand-v1");
        annotations::apply_difficulty(entry, &assessed);
    }
    Ok(())
}
pub(super) fn verify_audit(store: &Store, question: &Value) -> AppResult<()> {
    if !ready(question) {
        return Ok(());
    }
    let wf = &question["teachingWorkflow"];
    let root = store.data_dir.join("imports").canonicalize()?;
    let load = |relative: &str, digest: &Value| -> AppResult<Value> {
        let path = store.data_dir.join(relative).canonicalize().map_err(|_| {
            err(
                "teaching_audit_changed",
                "教学稿实际请求或响应缺失，未加入题库。",
            )
        })?;
        if !path.starts_with(&root) || std::fs::metadata(&path)?.len() > 45 * 1024 * 1024 {
            return Err(err("teaching_audit_changed", "教学稿审计路径或大小无效。"));
        }
        let bytes = std::fs::read(path)?;
        if json!(sha(&bytes)) != *digest {
            return Err(err(
                "teaching_audit_changed",
                "教学稿实际请求或响应校验失败。",
            ));
        }
        Ok(serde_json::from_slice(&bytes)?)
    };
    let request = load(s(wf, "requestRelativePath"), &wf["requestFileSha256"])?;
    if request["redacted"] != false
        || request["bodySha256"] != hash_json(&request["body"])
        || request["promptSha256"] != hash_json(&request["body"]["messages"][0]["content"])
        || wf["requestSha256"] != request["bodySha256"]
        || wf["promptSha256"] != request["promptSha256"]
    {
        return Err(err(
            "teaching_audit_changed",
            "教学稿实际请求身份或提示词校验失败。",
        ));
    }
    // A later explicitly authorized generation repair retains the lifetime
    // reviewCalls quota. The actual request task identifies the final response.
    let response_audit = if request["task"] == "question_import_teaching_review" {
        wf.clone()
    } else {
        wf["generationAudit"].clone()
    };
    let response = load(
        s(&response_audit, "responseRelativePath"),
        &response_audit["responseSha256"],
    )?;
    let raw: Value = serde_json::from_str(s(&response["choices"][0]["message"], "content"))
        .map_err(|_| err("teaching_audit_changed", "教学稿原始响应已损坏。"))?;
    let result = if request["task"] == "question_import_teaching_review" {
        if wf["reviewPatchContract"].is_object() {
            let context:Value=serde_json::from_str(s(&request["body"]["messages"][1],"content"))
                .map_err(|_|err("teaching_audit_changed","受限复核请求上下文不可读取。"))?;
            if context["patchContract"]!=wf["reviewPatchContract"]||context["candidate"]!=wf["reviewPatchBaseCandidate"]||raw!=wf["reviewPatchResponse"] {
                return Err(err("teaching_audit_changed","受限复核原请求与响应绑定不一致。"));
            }
            let expected_source=if wf["reviewPatchSourceHashDomain"]=="original_material" {
                if context["originalMaterial"]!=material(question){return Err(err("teaching_audit_changed","外部补丁原题与当前来源不一致。"));}
                hash_json(&context["originalMaterial"])
            }else{source_hash(question)};
            decode_review_candidate(s(question,"questionId"),&expected_source,&context,&raw)?
        } else {
            let context:Value=serde_json::from_str(s(&request["body"]["messages"][1],"content")).map_err(|_|err("teaching_audit_changed","复核上下文不可读取。"))?;
            decode_review_candidate(s(question,"questionId"),&source_hash(question),&context,&raw)?
        }
    } else if request["task"] == "question_import_teaching_generation" {
        rows(&raw["questions"])
            .into_iter()
            .find(|r| r["questionId"] == question["questionId"])
            .unwrap_or(Value::Null)
    } else {
        #[cfg(test)]
        {
            let mut result = rows(&raw["questions"])
                .into_iter()
                .find(|r| r["sourceLabel"] == question["sourceLabel"])
                .unwrap()["generatedTeaching"]
                .clone();
            result["questionId"] = question["questionId"].clone();
            result
        }
        #[cfg(not(test))]
        {
            return Err(err(
                "teaching_audit_changed",
                "教学稿审计任务不属于课堂稿生成或复核。",
            ));
        }
    };
    let expected=controls::base_before_manual(question,&wf["finalResult"])?;
    if result != expected {
        return Err(err(
            "teaching_audit_changed",
            "教学稿与原始模型响应不一致。",
        ));
    }
    Ok(())
}

/// Legacy regression providers now return the newly required, independent
/// draft as well. Tests for missing/invalid drafts call initialize directly.
#[cfg(test)]
pub(super) fn simulated_complete_response(mut response: Value) -> Value {
    if !response.is_object() {
        return response;
    }
    if let Some(content) = response["choices"][0]["message"]["content"].as_str() {
        if let Ok(parsed) = serde_json::from_str::<Value>(content) {
            response["choices"][0]["message"]["content"] =
                json!(simulated_complete_response(parsed).to_string());
        }
    }
    if let Some(questions) = response["questions"].as_array_mut() {
        for q in questions {
            if q.get("questionType").is_none() {
                continue;
            }
            if q.get("generatedTeaching").is_none() {
                let difficulty = if q["difficultyAssessment"].is_object()
                    && !s(&q["difficultyAssessment"], "basis").is_empty()
                {
                    json!({"level":q["difficultyAssessment"]["level"],"basis":q["difficultyAssessment"]["basis"]})
                } else {
                    json!({"level":null,"basis":"模拟回归：材料尚不足以单独划分内容难度。"})
                };
                q["generatedTeaching"] = json!({"answer":"模拟教学答案2","difficultyAssessment":difficulty,"teachingSolution":"模拟课堂讲解：由题意，$1+1=2$。","teachingFocusSchemaVersion":2,"teachingFocus":{"examFocus":"模拟整数加法。","studentRequirements":["写出正确的运算结果。"]},"issues":[]});
            }
        }
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    fn candidate() -> Value {
        json!({"questionId":"simulated-q1","answer":"2","difficultyAssessment":{"level":"easy","basis":"题面已明确运算，直接相加即可。"},"teachingSolution":"由题意，$1+1=2$。","teachingFocusSchemaVersion":2,"teachingFocus":{"examFocus":"整数相加。","studentRequirements":["写出正确的和。"]},"issues":[]})
    }
    fn explicit_saved_question(reason: &str) -> Value {
        let mut q = json!({"questionId":"simulated-q1","stem":"模拟回归：1+1","answer":"原参考2","solution":"原卷计算","student":{"assets":[]}});
        let mut c = candidate();
        if reason == "new_rule_hit" {c["teachingSolution"] = json!("积分得结果为2。");}
        let hash = source_hash(&q);
        q["teachingWorkflow"] = json!({"sourceContentSha256":hash,"initialCandidate":c,"initialFindings":[],"dictionaryVersion":"teaching-term-review-v2","reviewCalls":if reason=="previous_timeout"{1}else{0},"finalResult":null,"findings":if reason=="previous_timeout"{json!([{"type":"technical","code":"model_request_timeout"}])}else{json!([])}});
        q
    }
    fn explicit_manifest(q: &Value, reason: &str) -> Value {
        json!({"operationId":"simulated-explicit-review","entries":[{"question":q,"expectedQuestionHash":hash_json(q),"reason":reason}]})
    }
    #[test]
    fn simulated_explicit_candidate_review_uses_shared_http_once_without_db_or_old_quota_changes() {
        for reason in ["previous_timeout","new_rule_hit"] {
            let directory = tempfile::tempdir().unwrap();
            let q = explicit_saved_question(reason);
            let manifest = explicit_manifest(&q,reason);
            let preserved = manifest.clone();
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let model = ModelClient::test_client(directory.path(), &format!("http://{}/v1",listener.local_addr().unwrap()));
            let server = std::thread::spawn(move || {
                let (mut stream,_) = listener.accept().unwrap();
                let request = read_http(&mut stream);
                let context: Value = serde_json::from_str(s(&request["messages"][1],"content")).unwrap();
                assert_eq!(context["originalMaterial"]["questionId"],"simulated-q1");
                assert_eq!(context["rawCandidateSameAsCandidate"],true);
                let body=json!({"choices":[{"finish_reason":"stop","message":{"content":candidate().to_string()}}]}).to_string();
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
                listener.set_nonblocking(true).unwrap();
                std::thread::sleep(std::time::Duration::from_millis(80));
                assert_eq!(listener.accept().unwrap_err().kind(),std::io::ErrorKind::WouldBlock);
            });
            let output = directory.path().join("review-output");
            let result = explicit_review_candidates(&model,&manifest,&output,&AtomicBool::new(false)).unwrap();
            assert_eq!(result["results"][0]["status"],"ready_candidate");
            assert_eq!(result["results"][0]["additionalReviewCalls"],1);
            assert_eq!(manifest,preserved);
            assert!(!directory.path().join("personal.sqlite").exists());
            assert!(!directory.path().join("question-bank.sqlite").exists());
            let audit_dir = output.join(s(&result["results"][0],"auditDirectory"));
            for name in ["attempt.json","input.json","provider-response.json","provider-response.request.json","provider-response.transport.json","result.json"] {assert!(audit_dir.join(name).is_file(),"{name}");}
            let transport: Value = serde_json::from_slice(&std::fs::read(audit_dir.join("provider-response.transport.json")).unwrap()).unwrap();
            assert_eq!(transport["status"],"completed");
            assert_eq!(explicit_review_candidates(&model,&manifest,&output,&AtomicBool::new(false)).unwrap_err().code,"teaching_review_output_exists");
            server.join().unwrap();
        }
    }
    #[test]
    fn simulated_explicit_candidate_review_rejects_clean_tampered_duplicate_or_unapproved_targets_before_http() {
        let directory = tempfile::tempdir().unwrap();
        let model = ModelClient::test_client(directory.path(),"http://127.0.0.1:1/v1");
        let q = explicit_saved_question("new_rule_hit");
        let mut clean = q.clone();clean["teachingWorkflow"]["initialCandidate"] = candidate();
        let mut changed = explicit_manifest(&q,"new_rule_hit");changed["entries"][0]["question"]["stem"] = json!("tampered");
        let mut duplicate = explicit_manifest(&q,"new_rule_hit");let repeated = duplicate["entries"][0].clone();duplicate["entries"].as_array_mut().unwrap().push(repeated);
        let mut old = q.clone();old["teachingWorkflow"]["dictionaryVersion"] = dictionary()["version"].clone();
        for (index,manifest) in [explicit_manifest(&clean,"new_rule_hit"),changed,duplicate,explicit_manifest(&q,"previous_timeout"),explicit_manifest(&old,"new_rule_hit")].iter().enumerate() {
            let output = directory.path().join(format!("rejected-{index}"));
            assert!(explicit_review_candidates(&model,manifest,&output,&AtomicBool::new(false)).is_err());
            assert!(!output.exists());
        }
    }
    #[test]
    fn simulated_explicit_candidate_review_failure_keeps_once_only_receipt_and_never_retries() {
        let directory = tempfile::tempdir().unwrap();
        let q = explicit_saved_question("previous_timeout");
        let manifest = explicit_manifest(&q,"previous_timeout");
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let model = ModelClient::test_client(directory.path(), &format!("http://{}/v1",listener.local_addr().unwrap()));
        let server = std::thread::spawn(move || {
            let (mut stream,_) = listener.accept().unwrap();let _ = read_http(&mut stream);
            write!(stream,"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}").unwrap();
            listener.set_nonblocking(true).unwrap();std::thread::sleep(std::time::Duration::from_millis(100));
            assert_eq!(listener.accept().unwrap_err().kind(),std::io::ErrorKind::WouldBlock);
        });
        let output = directory.path().join("failed-output");
        let result = explicit_review_candidates(&model,&manifest,&output,&AtomicBool::new(false)).unwrap();
        assert_eq!(result["results"][0]["status"],"review_failed");
        assert_eq!(result["results"][0]["totalReviewCallsObserved"],2);
        assert!(result["results"][0]["candidate"].is_null());
        assert_eq!(manifest["entries"][0]["question"]["teachingWorkflow"]["reviewCalls"],1);
        assert!(explicit_review_candidates(&model,&manifest,&output,&AtomicBool::new(false)).is_err());
        server.join().unwrap();
    }
    #[test]
    fn simulated_review_context_deduplicates_without_changing_source_or_findings() {
        let mut c = candidate();
        let text = format!("{}下界{}", "😀".repeat(60), "甲".repeat(80));
        c["teachingSolution"] = json!(text);
        let finding = json!({"type":"term","ruleId":"optimization-language","term":"下界","fieldPath":"teachingSolution","start":120,"end":122,"excerpt":text,"guidance":"核对具体不等式与取等条件"});
        let mut q = json!({"questionId":"simulated-q1","stem":"原题不能截断","teachingWorkflow":{"initialCandidate":c,"initialFindings":[finding.clone(),finding]}});
        let before = q.clone();
        let context = review_context(&q);
        assert_eq!(q, before);
        assert_eq!(context["candidate"], c);
        assert_eq!(context["originalMaterial"], material(&q));
        assert!(context["rawCandidate"].is_null());
        assert_eq!(context["rawCandidateSameAsCandidate"], true);
        assert_eq!(rows(&context["reviewFindings"]).len(), 2);
        assert_eq!(rows(&context["reviewRules"]).len(), 1);
        assert_eq!(context["reviewFindings"][0]["start"], 120);
        assert_eq!(context["reviewFindings"][0]["reviewGuidanceIndex"], 0);
        assert_eq!(context["reviewFindings"][0]["excerpt"], format!("{}下界{}", "😀".repeat(40), "甲".repeat(40)));
        assert_eq!(utf16_byte_offset("😀", 1), None);
        q["teachingWorkflow"]["rawCandidate"] = json!("{broken JSON");
        assert_eq!(review_context(&q)["rawCandidate"], "{broken JSON");
        assert!(review_context(&q).get("rawCandidateSameAsCandidate").is_none());
    }
    #[test]
    fn simulated_context_matchers_conform_to_shared_notation_fixtures() {
        let fixtures: Value = serde_json::from_str(include_str!("../../../../scripts/resources/teaching-term-context-fixtures.json")).unwrap();
        for case in rows(&fixtures["cases"]) {
            let mut c = candidate();
            c["teachingSolution"] = case["text"].clone();
            let flags: Vec<Value> = findings(&c, "simulated-q1").into_iter().filter(|f| f["type"] == "term").collect();
            let mut actual = flags.iter().map(|f| s(f, "ruleId").to_owned()).collect::<Vec<_>>();
            actual.sort(); actual.dedup();
            let mut expected = ids(&case["ruleIds"]); expected.sort();
            assert_eq!(actual, expected, "{}", s(&case, "name"));
            if case["terms"].is_array() {
                let mut actual_terms = flags.iter().map(|f| s(f, "term").to_owned()).collect::<Vec<_>>(); actual_terms.sort();
                let mut expected_terms = ids(&case["terms"]); expected_terms.sort();
                assert_eq!(actual_terms, expected_terms, "{}", s(&case, "name"));
            }
            let text = s(&case, "text");
            for flag in flags {
                let start = utf16_byte_offset(text, flag["start"].as_u64().unwrap() as usize).unwrap();
                let end = utf16_byte_offset(text, flag["end"].as_u64().unwrap() as usize).unwrap();
                assert_eq!(&text[start..end], s(&flag, "term"));
            }
        }
    }
    #[test]
    fn simulated_explicit_review_context_rechecks_old_unreviewed_draft_without_spending_quota() {
        let mut c = candidate();
        c["teachingSolution"] = json!("积分得结果为2。");
        let q = json!({"questionId":"simulated-q1","teachingWorkflow":{"initialCandidate":c,"initialFindings":[],"dictionaryVersion":"teaching-term-review-v2","reviewCalls":0}});
        let before = q.clone();
        let context = review_context(&q);
        assert_eq!(q, before);
        assert!(rows(&context["reviewFindings"]).iter().any(|f| f["ruleId"] == "integral-tool"));
        assert_eq!(context["dictionaryVersion"], "teaching-term-review-v3");
    }
    #[test]
    fn simulated_shared_dictionary_and_source_isolation() {
        let mut q = json!({"questionId":"simulated-q1","stem":"柯西不等式","solution":"下界","task":{"label":"整数相加"},"solutionPaths":[]});
        let mut raw = json!({"generatedTeaching":candidate()});
        raw["generatedTeaching"]
            .as_object_mut()
            .unwrap()
            .remove("questionId");
        initialize(&mut q, &raw);
        assert!(ready(&q));
        raw["generatedTeaching"]["teachingSolution"] = json!("😀由柯西不等式可知下界为2。");
        initialize(&mut q, &raw);
        let flags = rows(&q["teachingWorkflow"]["findings"]);
        assert!(
            flags
                .iter()
                .any(|f| f["term"] == "柯西不等式" && f["start"] == 3)
        );
        assert!(flags.iter().any(|f| f["term"] == "下界"));
        assert_eq!(q["solution"], "下界");
        assert!(!ready(&q));
    }
    #[test]
    fn simulated_display_and_completeness_are_not_math_verdicts() {
        let mut c = candidate();
        assert!(findings(&c, "simulated-q1").is_empty());
        c["teachingSolution"] = json!("$1+1=2$\\n所以成立。");
        assert!(
            findings(&c, "simulated-q1")
                .iter()
                .any(|f| f["code"] == "literal_newline_escape")
        );
        c["teachingSolution"] = json!("$\\nu+1=2$。");
        assert!(findings(&c, "simulated-q1").is_empty());
        c["teachingSolution"] = json!("$1+1=2");
        assert!(
            findings(&c, "simulated-q1")
                .iter()
                .any(|f| f["code"] == "unpaired_math_delimiter")
        );
        c["questionId"] = json!("other");
        assert!(validate(&c, "simulated-q1").is_err());
    }
    #[test]
    fn simulated_saved_workflow_cannot_be_forged_or_survive_source_edit() {
        let mut old = json!({"questionId":"simulated-q1","stem":"1+1","solution":"原卷解析"});
        let mut raw = json!({"generatedTeaching":candidate()});
        raw["generatedTeaching"]
            .as_object_mut()
            .unwrap()
            .remove("questionId");
        initialize(&mut old, &raw);
        let mut next = old.clone();
        next["teachingWorkflow"] = json!({"status":"forged"});
        preserve(&old, &mut next);
        assert!(ready(&next));
        next["solution"] = json!("教师核对后修订的原文");
        preserve(&old, &mut next);
        assert!(!ready(&next));
        assert!(reason(&next).contains("失效"));
    }
    #[test]
    fn simulated_generation_uses_shared_prompt_without_optional_methods() {
        let text = generation_instruction();
        assert!(text.contains("普通高中学生"));
        assert!(text.contains("独立课堂教学生成"));
        assert!(!text.contains("【本次附加的方法参考】"));
        for rule in rows(&dictionary()["rules"]) {
            for name in ids(&rule["matchers"]) {
                let _ = matcher(&name, "");
            }
        }
    }
    fn fixture(text: &str) -> (tempfile::TempDir, Store, Value) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), &crate::bank::tests::seed()).unwrap();
        let id = "simulated-classroom-import";
        let source = save_source(&store, id, "txt", b"1+1").unwrap();
        let mut q = json!({"questionId":"simulated-q1","questionType":"fill_blank","stem":"1+1=____","options":[],"parts":[],"answer":"原卷答案2","solution":"原卷解析1+1=2","task":{"label":"整数加法"},"solutionPaths":[],"pages":[1],"sourceLabel":"1"});
        let mut c = candidate();
        c["teachingSolution"] = json!(text);
        c.as_object_mut().unwrap().remove("questionId");
        initialize(&mut q, &json!({"generatedTeaching":c}));
        q["teachingWorkflow"]["model"] = json!("simulated-classroom");
        q["teachingWorkflow"]["requestSha256"] = json!("a".repeat(64));
        q["teachingWorkflow"]["promptSha256"] = json!("b".repeat(64));
        let record = json!({"importId":id,"source":source,"revision":0,"questions":[q],"status":"pending_review"});
        store.put_document("imports", id, &record).unwrap();
        (dir, store, record)
    }
    fn read_http(stream: &mut std::net::TcpStream) -> Value {
        let mut bytes = vec![];
        loop {
            let mut chunk = [0; 8192];
            let n = stream.read(&mut chunk).unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&chunk[..n]);
            if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                let count = headers
                    .lines()
                    .find_map(|l| {
                        l.strip_prefix("content-length:")
                            .map(|s| s.trim().parse::<usize>().unwrap())
                    })
                    .unwrap();
                if bytes.len() >= end + 4 + count {
                    return serde_json::from_slice(&bytes[end + 4..end + 4 + count]).unwrap();
                }
            }
        }
    }
    fn quality_payload(q:&Value,dimension:&str)->Value {
        json!({"questionId":q["questionId"],"sourceContentSha256":source_hash(q),"candidateSha256":hash_json(&controls::active_candidate(q)),"method":"user_authorized_agent_review","checkedBy":"codex","evidence":"模拟独立核验具体等式和题面。","findings":[{"id":"sim-quality-proof","dimension":dimension,"fieldPath":"teachingSolution","reason":"模拟核验：缺少关键等式1+1=2。"}]})
    }
    #[test]
    fn simulated_quality_without_terms_repairs_once_and_replays_actual_http_audit() {
        for dimension in ["mathematics","proof","method"] {
            let (_dir,store,mut record)=fixture("由题意得2。");
            assert!(findings(&record["questions"][0]["teachingWorkflow"]["initialCandidate"],"simulated-q1").is_empty());
            let payload=quality_payload(&record["questions"][0],dimension);let src=source_hash(&record["questions"][0]);
            attach_quality_review(&mut record["questions"][0],&payload).unwrap();assert!(!ready(&record["questions"][0]));
            store.put_document("imports",s(&record,"importId"),&record).unwrap();
            let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let model=ModelClient::test_client(&store.data_dir,&format!("http://{}/v1",listener.local_addr().unwrap()));
            let server=std::thread::spawn(move|| {
                let(mut stream,_)=listener.accept().unwrap();let request=read_http(&mut stream);
                let ctx:Value=serde_json::from_str(s(&request["messages"][1],"content")).unwrap();let c=&ctx["patchContract"];
                assert!(rows(&c["allowedFields"]).iter().any(|f|f["fieldPath"]=="answer"));
                let output=json!({"questionId":c["questionId"],"candidateSha256":c["candidateSha256"],"sourceContentSha256":c["sourceContentSha256"],"patches":[{"fieldPath":"teachingSolution","oldTextSha256":hash_json(&ctx["candidate"]["teachingSolution"]),"newText":"计算 $1+1=2$，所以答案为2。"}],"unresolvedIssues":[],"qualityResolutions":[{"id":"sim-quality-proof","status":"resolved","basis":"模拟已补足并核算整数加法等式。"}]});
                let body=json!({"choices":[{"finish_reason":"stop","message":{"content":output.to_string()}}]}).to_string();
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
            });
            let mut saved=record.clone();process(&store,&model,&mut record,&mut saved,&[],&AtomicBool::new(false)).unwrap();server.join().unwrap();
            let q=&record["questions"][0];assert!(ready(q));assert_eq!(q["teachingWorkflow"]["reviewCalls"],1);assert_eq!(source_hash(q),src);verify_audit(&store,q).unwrap();
            let before=record.clone();process(&store,&model,&mut record,&mut saved,&[],&AtomicBool::new(false)).unwrap();assert_eq!(record,before);
        }
    }
    #[test]
    fn simulated_external_quality_binding_and_spent_review_do_not_access_provider() {
        let (_dir,store,mut record)=fixture("计算 $1+1=2$。");record["questions"][0]["teachingWorkflow"]["reviewCalls"]=json!(1);
        let mut bad=quality_payload(&record["questions"][0],"proof");bad["candidateSha256"]=json!("stale");let before=record.clone();
        assert!(attach_quality_review(&mut record["questions"][0],&bad).is_err());assert_eq!(record,before);
        let good=quality_payload(&record["questions"][0],"proof");attach_quality_review(&mut record["questions"][0],&good).unwrap();
        store.put_document("imports",s(&record,"importId"),&record).unwrap();let model=ModelClient::test_client(&store.data_dir,"http://127.0.0.1:1/v1");let mut saved=record.clone();
        process(&store,&model,&mut record,&mut saved,&[],&AtomicBool::new(false)).unwrap();
        assert_eq!(record["questions"][0]["teachingWorkflow"]["reviewCalls"],1);assert!(!ready(&record["questions"][0]));assert!(reason(&record["questions"][0]).contains("关键等式"));
    }
    #[test]
    fn simulated_semantic_patch_noop_and_unsafe_scope_are_rejected_before_acceptance() {
        let (_dir,_store,mut record)=fixture("由题意得2。");let p=quality_payload(&record["questions"][0],"proof");attach_quality_review(&mut record["questions"][0],&p).unwrap();let q=&record["questions"][0];
        let mut ctx=review_context(q);ctx["patchContract"]=controls::patch_contract(q,&ctx).unwrap();let c=&ctx["patchContract"];
        let mut response=json!({"questionId":c["questionId"],"candidateSha256":c["candidateSha256"],"sourceContentSha256":c["sourceContentSha256"],"patches":[],"unresolvedIssues":[],"qualityResolutions":[{"id":"sim-quality-proof","status":"resolved","basis":"模拟说明。"}]});
        assert_eq!(decode_review_candidate(s(q,"questionId"),&source_hash(q),&ctx,&response).unwrap_err().code,"teaching_quality_unchanged");
        response["patches"]=json!([{"fieldPath":"stem","oldText":"","newText":"forged"}]);assert!(decode_review_candidate(s(q,"questionId"),&source_hash(q),&ctx,&response).is_err());
        let mut q=q.clone();let p=quality_payload(&q,"assessment");attach_quality_review(&mut q,&p).unwrap();let ctx=review_context(&q);assert!(controls::patch_contract(&q,&ctx).is_none());
        let mut next=ctx["candidate"].clone();next["difficultyAssessment"]["level"]=json!("easy_medium");
        let mut response=json!({"candidate":next,"qualityResolutions":[{"id":"sim-quality-proof","status":"resolved","basis":"模拟根据简单表示转换调整内容档位。"}]});
        assert!(decode_review_candidate(s(&q,"questionId"),&source_hash(&q),&ctx,&response).is_ok());response["candidate"]["answer"]=json!("forged");assert!(decode_review_candidate(s(&q,"questionId"),&source_hash(&q),&ctx,&response).is_err());
    }
    #[test]
    fn simulated_self_check_all_pass_is_not_independent_math_approval() {
        let mut signals=json!({"questionId":"simulated-q1","checks":{"mathematics":"pass","proof":"pass","method":"pass","explanation":"unknown","assessment":"pass"},"findings":[]});
        assert!(parse_quality_signals(&signals,"simulated-q1").unwrap().is_empty());signals["checks"]["proof"]=json!("concern");assert!(parse_quality_signals(&signals,"simulated-q1").is_err());
        signals["findings"]=json!([{"id":"missing-proof","dimension":"proof","fieldPath":"teachingSolution","reason":"模拟缺少核心等式。"}]);assert_eq!(parse_quality_signals(&signals,"simulated-q1").unwrap().len(),1);
        assert!(parse_quality_signals(&signals,"another-id").is_err());assert!(parse_quality_signals(&Value::Null,"simulated-q1").unwrap().is_empty());
    }
    #[test]
    fn simulated_same_generation_quality_envelope_routes_without_a_separate_audit_call() {
        let (_dir,store,mut record)=fixture("由题意得2。");initialize_pending(&mut record["questions"][0]);store.put_document("imports",s(&record,"importId"),&record).unwrap();
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();let model=ModelClient::test_client(&store.data_dir,&format!("http://{}/v1",listener.local_addr().unwrap()));
        let server=std::thread::spawn(move|| {
            for phase in 0..2 {
                let(mut stream,_)=listener.accept().unwrap();let request=read_http(&mut stream);let ctx:Value=serde_json::from_str(s(&request["messages"][1],"content")).unwrap();
                let output=if phase==0 {
                    let mut c=candidate();c["teachingSolution"]=json!("由题意得2。");
                    json!({"questions":[c],"qualitySignals":[{"questionId":"simulated-q1","checks":{"mathematics":"pass","proof":"concern","method":"pass","explanation":"pass","assessment":"pass"},"findings":[{"id":"same-response-proof","dimension":"proof","fieldPath":"teachingSolution","reason":"模拟缺少决定结论的加法等式。"}]}]})
                }else{
                    let c=&ctx["patchContract"];assert_eq!(ctx["reviewFindings"][0]["origin"],"generation_self_check");
                    json!({"questionId":c["questionId"],"candidateSha256":c["candidateSha256"],"sourceContentSha256":c["sourceContentSha256"],"patches":[{"fieldPath":"teachingSolution","oldTextSha256":hash_json(&ctx["candidate"]["teachingSolution"]),"newText":"由 $1+1=2$ 得答案。"}],"unresolvedIssues":[],"qualityResolutions":[{"id":"same-response-proof","status":"resolved","basis":"模拟补全并核算原等式。"}]})
                };
                let body=json!({"choices":[{"finish_reason":"stop","message":{"content":output.to_string()}}]}).to_string();write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
            }
        });
        let mut saved=record.clone();process(&store,&model,&mut record,&mut saved,&[],&AtomicBool::new(false)).unwrap();server.join().unwrap();
        let q=&record["questions"][0];assert!(ready(q));assert_eq!(q["teachingWorkflow"]["generationCalls"],1);assert_eq!(q["teachingWorkflow"]["reviewCalls"],1);assert_eq!(q["teachingWorkflow"]["semanticAssessment"],"model_self_check_only");verify_audit(&store,q).unwrap();
    }
    #[test]
    fn simulated_external_quality_action_is_persistent_cas_bound_and_idempotent_without_http() {
        let (_dir,store,record)=fixture("由题意得2。");let mut payload=quality_payload(&record["questions"][0],"proof");
        payload["importId"]=record["importId"].clone();payload["expectedRevision"]=record["revision"].clone();payload["operationId"]=json!("sim-quality-attach");
        let after=record_quality_review(&store,&payload,&AtomicBool::new(false)).unwrap();assert!(!ready(&after["import"]["questions"][0]));
        assert_eq!(record_quality_review(&store,&payload,&AtomicBool::new(false)).unwrap(),after);
        assert_eq!(after["import"]["questions"][0]["teachingWorkflow"]["reviewCalls"],0);
        let mut stale=payload.clone();stale["operationId"]=json!("sim-quality-stale");assert!(record_quality_review(&store,&stale,&AtomicBool::new(false)).is_err());
        assert_eq!(store.document("imports",s(&record,"importId")).unwrap(),after["import"]);
    }
    #[test]
    fn simulated_no_hits_never_accesses_reviewer_and_retains_original_text() {
        let (_dir, store, mut record) = fixture("由题意，$1+1=2$。");
        let model = ModelClient::test_client(&store.data_dir, "http://127.0.0.1:1/v1");
        let mut saved = record.clone();
        process(
            &store,
            &model,
            &mut record,
            &mut saved,
            &[],
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(record, saved);
        assert_eq!(record["questions"][0]["teachingWorkflow"]["reviewCalls"], 0);
        assert_eq!(record["questions"][0]["answer"], "原卷答案2");
    }
    #[test]
    fn simulated_one_review_success_or_remaining_terms_never_loops_or_overwrites_source() {
        for remaining in [false, true] {
            let (_dir, store, mut record) = fixture("由柯西不等式，下界为2。");
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let model = ModelClient::test_client(
                &store.data_dir,
                &format!("http://{}/v1", listener.local_addr().unwrap()),
            );
            let mut result = candidate();
            if remaining {
                result["teachingSolution"] = json!("下界为2。");
            }
            let handle = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let req = read_http(&mut stream);
                let context:Value=serde_json::from_str(s(&req["messages"][1],"content")).unwrap();
                assert_eq!(rows(&context["patchContract"]["allowedFields"]).len(),1);
                let contract=&context["patchContract"];
                let output=json!({"questionId":contract["questionId"],"candidateSha256":contract["candidateSha256"],"sourceContentSha256":contract["sourceContentSha256"],"patches":[{"fieldPath":"teachingSolution","oldText":context["candidate"]["teachingSolution"],"newText":result["teachingSolution"]}],"unresolvedIssues":[]});
                let body=json!({"choices":[{"finish_reason":"stop","message":{"content":output.to_string()}}]}).to_string();
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
                req
            });
            let original = review::content_hash(&record["questions"][0]);
            let mut saved = record.clone();
            process(
                &store,
                &model,
                &mut record,
                &mut saved,
                &[],
                &AtomicBool::new(false),
            )
            .unwrap();
            let req = handle.join().unwrap();
            assert!(
                req["messages"][0]["content"]
                    .as_str()
                    .unwrap()
                    .contains("只允许一次复核")
            );
            assert_eq!(review::content_hash(&record["questions"][0]), original);
            assert_eq!(ready(&record["questions"][0]), !remaining);
            assert_eq!(record["questions"][0]["teachingWorkflow"]["reviewCalls"], 1);
            if !remaining {
                verify_audit(&store,&record["questions"][0]).unwrap();
                let q=&record["questions"][0];let current=controls::active_candidate(q);
                let response=store.data_dir.join(s(&q["teachingWorkflow"],"responseRelativePath"));let bytes=std::fs::read(&response).unwrap();
                let payload=json!({"importId":record["importId"],"expectedRevision":record["revision"],"operationId":"simulated-manual-after-model-patch","questionId":q["questionId"],"sourceContentSha256":source_hash(q),"candidateSha256":hash_json(&current),"basis":"模拟：核对通过后仅整理学生要求。","patches":[{"fieldPath":"teachingFocus.studentRequirements[0]","oldText":current["teachingFocus"]["studentRequirements"][0],"newText":"能正确写出1+1=2。"}]});
                record=controls::action(&store,&payload,true,&AtomicBool::new(false)).unwrap()["import"].clone();saved=record.clone();
                verify_audit(&store,&record["questions"][0]).unwrap();assert_eq!(std::fs::read(&response).unwrap(),bytes);
                let mut forged=record["questions"][0].clone();forged["teachingWorkflow"]["manualPatchHistory"][0]["patches"][0]["newText"]=json!("伪造内容");
                assert_eq!(verify_audit(&store,&forged).unwrap_err().code,"teaching_audit_changed");
            }
            let once = record.clone();
            process(
                &store,
                &model,
                &mut record,
                &mut saved,
                &[],
                &AtomicBool::new(false),
            )
            .unwrap();
            assert_eq!(once, record);
        }
    }
    #[test]
    fn simulated_failed_or_crashed_review_spends_quota_and_never_retries() {
        let (_dir, store, mut record) = fixture("下界为2。");
        let model = ModelClient::test_client(&store.data_dir, "http://127.0.0.1:1/v1");
        let mut saved = record.clone();
        process(
            &store,
            &model,
            &mut record,
            &mut saved,
            &[],
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(record["questions"][0]["teachingWorkflow"]["reviewCalls"], 1);
        assert!(!ready(&record["questions"][0]));
        let once = record.clone();
        process(
            &store,
            &model,
            &mut record,
            &mut saved,
            &[],
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(once, record);
        record["questions"][0]["teachingWorkflow"]["status"] = json!("reviewing");
        store
            .put_document("imports", s(&record, "importId"), &record)
            .unwrap();
        saved = record.clone();
        process(
            &store,
            &model,
            &mut record,
            &mut saved,
            &[],
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(
            record["questions"][0]["teachingWorkflow"]["status"],
            "needs_review"
        );
        assert!(reason(&record["questions"][0]).contains("未保存"));
    }
    #[test]
    fn simulated_missing_qwen_profile_marks_only_hit_question_without_borrowing_a_key() {
        let (dir, store, mut record) = fixture("下界为2。");
        std::fs::write(dir.path().join("model-settings.json"), b"{}").unwrap();
        let model = ModelClient::open(dir.path()).unwrap();
        let mut saved = record.clone();
        process(
            &store,
            &model,
            &mut record,
            &mut saved,
            &[],
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(record["questions"][0]["teachingWorkflow"]["reviewCalls"], 0);
        assert!(reason(&record["questions"][0]).contains("qwen3.8-flash"));
    }
    #[test]
    fn simulated_publication_keeps_source_answers_and_adds_separate_versioned_analysis() {
        let (_dir, _store, record) = fixture("由题意，$1+1=2$。");
        let q = &record["questions"][0];
        let raw = json!({"questionId":"simulated-q1","contentVersion":"c1","teacherVersion":"t1","teacher":{"answer":"原卷答案2","solutions":["原卷解析1+1=2"]}});
        let mut entry = json!({"questionId":"simulated-q1"});
        apply_to_entry(q, &raw, &mut entry, "simulated-publication").unwrap();
        assert_eq!(entry["teachingAnalysis"]["status"], "ready");
        assert_eq!(entry["teachingAnalysis"]["baseTeacherVersion"], "t1");
        assert_eq!(entry["teachingAnalysis"]["answer"], "2");
        assert_eq!(raw["teacher"]["answer"], "原卷答案2");
        let mut snapshot = raw;
        snapshot["teachingAnalysis"] = entry["teachingAnalysis"].clone();
        crate::bank_teaching::verify_projection(&snapshot).unwrap();
        snapshot["teachingAnalysis"]["answer"] = json!("篡改的新稿答案");
        assert!(crate::bank_teaching::verify_projection(&snapshot).is_err());
    }
    #[test]
    fn simulated_independent_generation_batches_at_three_and_records_exact_request_audit() {
        let (_dir, store, mut record) = fixture("模拟已有稿");
        let base = record["questions"][0].clone();
        let mut questions = vec![];
        for i in 0..4 {
            let mut q = base.clone();
            q["questionId"] = json!(format!("simulated-q{i}"));
            q["answer"] = json!("");
            q["solution"] = json!("");
            initialize_pending(&mut q);
            questions.push(q);
        }
        record["questions"] = json!(questions);
        store
            .put_document("imports", s(&record, "importId"), &record)
            .unwrap();
        let before = rows(&record["questions"])
            .iter()
            .map(source_hash)
            .collect::<Vec<_>>();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let model = ModelClient::test_client(
            &store.data_dir,
            &format!("http://{}/v1", listener.local_addr().unwrap()),
        );
        let handle = std::thread::spawn(move || {
            let mut requests = vec![];
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_http(&mut stream);
                let context: Value =
                    serde_json::from_str(s(&request["messages"][1], "content")).unwrap();
                let input = rows(&context["questions"]);
                assert!(!input.is_empty() && input.len() <= 3);
                let output = json!({"questions":input.iter().map(|q|{let mut c=candidate();c["questionId"]=q["questionId"].clone();c}).collect::<Vec<_>>()});
                let body=json!({"choices":[{"finish_reason":"stop","message":{"content":output.to_string()}}]}).to_string();
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
                requests.push(request);
            }
            requests
        });
        let mut saved = record.clone();
        process(
            &store,
            &model,
            &mut record,
            &mut saved,
            &[],
            &AtomicBool::new(false),
        )
        .unwrap();
        let requests = handle.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            rows(&record["questions"])
                .iter()
                .map(source_hash)
                .collect::<Vec<_>>(),
            before
        );
        for (index, q) in rows(&record["questions"]).iter().enumerate() {
            assert!(ready(q));
            assert_eq!(q["answer"], "");
            assert_eq!(q["solution"], "");
            assert_eq!(q["teachingWorkflow"]["generationCalls"], 1);
            assert_eq!(q["teachingWorkflow"]["reviewCalls"], 0);
            assert_eq!(
                q["teachingWorkflow"]["requestSha256"],
                hash_json(&requests[index / 3])
            );
            verify_audit(&store, q).unwrap();
        }
        let done = record.clone();
        process(
            &store,
            &model,
            &mut record,
            &mut saved,
            &[],
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(record, done);
        let first = &record["questions"][0];
        let request_path = store
            .data_dir
            .join(s(&first["teachingWorkflow"], "requestRelativePath"));
        std::fs::write(request_path, b"{}").unwrap();
        assert_eq!(
            verify_audit(&store, first).unwrap_err().code,
            "teaching_audit_changed"
        );
    }
    #[test]
    fn simulated_structural_batches_keep_long_or_multipart_questions_separate_without_reordering() {
        let record = json!({"questions":[
            {"questionId":"choice-1","questionType":"single_choice","stem":"短题","parts":[]},
            {"questionId":"fill-2","questionType":"fill_blank","stem":"短题","parts":[]},
            {"questionId":"long-3","questionType":"free_response","stem":"解答题","parts":[]},
            {"questionId":"parts-4","questionType":"fill_blank","stem":"多小问","parts":[{"prompt":"(1)"},{"prompt":"(2)"}]},
            {"questionId":"size-5","questionType":"single_choice","stem":"大正文".repeat(2500),"parts":[]},
            {"questionId":"choice-6","questionType":"multiple_choice","stem":"短题","parts":[]},
            {"questionId":"fill-7","questionType":"fill_blank","stem":"短题","parts":[]}
        ]});
        let before = record.clone();
        let targets = (0..7).collect::<Vec<_>>();
        assert_eq!(
            generation_batches(&record, &targets),
            vec![vec![0, 1], vec![2], vec![3], vec![4], vec![5, 6]]
        );
        assert_eq!(record, before);
        let all_short = json!({"questions":vec![json!({"questionType":"single_choice","stem":"普通短题","parts":[]});7]});
        assert_eq!(
            generation_batches(&all_short, &targets),
            vec![vec![0, 1, 2], vec![3, 4, 5], vec![6]]
        );
    }
    #[test]
    fn simulated_generation_interruption_and_pre_cancel_do_not_repeat_or_consume_calls() {
        let (_dir, store, mut record) = fixture("旧模拟稿");
        initialize_pending(&mut record["questions"][0]);
        store
            .put_document("imports", s(&record, "importId"), &record)
            .unwrap();
        let mut saved = record.clone();
        let model = ModelClient::test_client(&store.data_dir, "http://127.0.0.1:1/v1");
        assert_eq!(
            process(
                &store,
                &model,
                &mut record,
                &mut saved,
                &[],
                &AtomicBool::new(true)
            )
            .unwrap_err()
            .code,
            "cancelled"
        );
        assert_eq!(
            record["questions"][0]["teachingWorkflow"]["generationCalls"],
            0
        );
        record["questions"][0]["teachingWorkflow"]["generationCalls"] = json!(1);
        record["questions"][0]["teachingWorkflow"]["status"] = json!("generating");
        store
            .put_document("imports", s(&record, "importId"), &record)
            .unwrap();
        saved = record.clone();
        process(
            &store,
            &model,
            &mut record,
            &mut saved,
            &[],
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(!ready(&record["questions"][0]));
        assert_eq!(record["questions"][0]["teachingWorkflow"]["reviewCalls"], 0);
        assert!(reason(&record["questions"][0]).contains("上次教学生成"));
        let marked = record.clone();
        process(
            &store,
            &model,
            &mut record,
            &mut saved,
            &[],
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(record, marked);
    }
    #[test]
    fn simulated_complete_but_invalid_teaching_json_or_identity_gets_one_qwen_review() {
        for invalid_json in [false, true] {
            let (_dir, store, mut record) = fixture("模拟旧稿");
            initialize_pending(&mut record["questions"][0]);
            store
                .put_document("imports", s(&record, "importId"), &record)
                .unwrap();
            let mut saved = record.clone();
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let model = ModelClient::test_client(
                &store.data_dir,
                &format!("http://{}/v1", listener.local_addr().unwrap()),
            );
            let handle = std::thread::spawn(move || {
                for i in 0..2 {
                    let (mut stream, _) = listener.accept().unwrap();
                    let req = read_http(&mut stream);
                    let prompt = s(&req["messages"][0], "content");
                    let output = if i == 0 {
                        assert!(prompt.contains("本批输出合同"));
                        if invalid_json {
                            "{".to_owned()
                        } else {
                            let mut bad = candidate();
                            bad["questionId"] = json!("unknown-question");
                            json!({"questions":[bad]}).to_string()
                        }
                    } else {
                        assert!(prompt.contains("只允许一次复核"));
                        candidate().to_string()
                    };
                    let body =
                        json!({"choices":[{"finish_reason":"stop","message":{"content":output}}]})
                            .to_string();
                    write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
                }
            });
            process(
                &store,
                &model,
                &mut record,
                &mut saved,
                &[],
                &AtomicBool::new(false),
            )
            .unwrap();
            handle.join().unwrap();
            let q = &record["questions"][0];
            assert!(ready(q));
            assert_eq!(q["teachingWorkflow"]["generationCalls"], 1);
            assert_eq!(q["teachingWorkflow"]["reviewCalls"], 1);
            assert_eq!(q["answer"], "原卷答案2");
            verify_audit(&store, q).unwrap();
        }
    }
    #[test]
    fn simulated_generation_network_failure_and_source_edits_do_not_call_qwen() {
        let (_dir, store, mut record) = fixture("模拟旧稿");
        initialize_pending(&mut record["questions"][0]);
        store
            .put_document("imports", s(&record, "importId"), &record)
            .unwrap();
        let mut saved = record.clone();
        let model = ModelClient::test_client(&store.data_dir, "http://127.0.0.1:1/v1");
        process(
            &store,
            &model,
            &mut record,
            &mut saved,
            &[],
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(
            record["questions"][0]["teachingWorkflow"]["status"],
            "generation_failed"
        );
        assert_eq!(record["questions"][0]["teachingWorkflow"]["reviewCalls"], 0);
        let once = record.clone();
        process(
            &store,
            &model,
            &mut record,
            &mut saved,
            &[],
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(record, once);
        let (_dir, store, mut changed) = fixture("下界为2。");
        let old = changed["questions"][0].clone();
        changed["questions"][0]["stem"] = json!("1+2=____");
        preserve(&old, &mut changed["questions"][0]);
        store
            .put_document("imports", s(&changed, "importId"), &changed)
            .unwrap();
        let mut saved = changed.clone();
        let model = ModelClient::test_client(&store.data_dir, "http://127.0.0.1:1/v1");
        process(
            &store,
            &model,
            &mut changed,
            &mut saved,
            &[],
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(
            changed["questions"][0]["teachingWorkflow"]["reviewCalls"],
            0
        );
        assert!(!ready(&changed["questions"][0]));
    }
    #[test]
    fn simulated_orphaned_background_generation_can_explicitly_resume_without_source_reparse() {
        let (_dir, mut store, mut record) = fixture("模拟旧稿");
        initialize_pending(&mut record["questions"][0]);
        record["status"] = json!("processing");
        record["backgroundJob"] = json!({"status":"interrupted"});
        record["questions"][0]["teachingWorkflow"]["generationCalls"] = json!(1);
        record["questions"][0]["teachingWorkflow"]["status"] = json!("generating");
        store
            .put_document("imports", s(&record, "importId"), &record)
            .unwrap();
        let model = ModelClient::test_client(&store.data_dir, "http://127.0.0.1:1/v1");
        let payload = json!({"operationId":"simulated-explicit-orphan-retry","importId":record["importId"],"expectedRevision":record["revision"]});
        let StagedImport::Ready(staged, bytes) =
            stage_import(&mut store, &model, &payload, &AtomicBool::new(false)).unwrap()
        else {
            panic!("expected an explicit resume")
        };
        assert_eq!(bytes, b"1+1");
        assert_eq!(staged["questions"], record["questions"]);
        let result = process_import(
            &mut store,
            &model,
            "simulated-explicit-orphan-retry",
            &hash_json(&payload),
            &AtomicBool::new(false),
            staged,
            bytes,
        )
        .unwrap();
        let q = &result["import"]["questions"][0];
        assert_eq!(q["teachingWorkflow"]["generationCalls"], 1);
        assert_eq!(q["teachingWorkflow"]["reviewCalls"], 0);
        assert_eq!(result["import"]["status"], "pending_review");
        assert_eq!(q["teachingWorkflow"]["status"], "needs_review");
    }

    #[test]
    fn simulated_explicit_failed_retry_is_single_question_scoped_and_idempotent() {
        let (_dir, store, mut record) = fixture("原有合格稿，$1+1=2$。");
        let good = record["questions"][0].clone();
        let mut pending = good.clone();
        pending["questionId"] = json!("simulated-pending");
        initialize_pending(&mut pending);
        let mut reviewed = good.clone();
        reviewed["questionId"] = json!("simulated-needs-review");
        reviewed["teachingWorkflow"]["status"] = json!("needs_review");
        reviewed["teachingWorkflow"]["reviewCalls"] = json!(1);
        let failed = (0..2)
            .map(|index| {
                let mut question = good.clone();
                question["questionId"] = json!(format!("simulated-failed-{index}"));
                initialize_pending(&mut question);
                question["teachingWorkflow"]["status"] = json!("generation_failed");
                question["teachingWorkflow"]["generationCalls"] = json!(1);
                // A previously spent Qwen allowance must survive generation repair.
                question["teachingWorkflow"]["reviewCalls"] = json!(index);
                question
            })
            .collect::<Vec<_>>();
        record["questions"] = json!([good, pending, reviewed, failed[0], failed[1]]);
        store
            .put_document("imports", s(&record, "importId"), &record)
            .unwrap();
        let before = record.clone();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let model = ModelClient::test_client(
            &store.data_dir,
            &format!("http://{}/v1", listener.local_addr().unwrap()),
        );
        let handle = std::thread::spawn(move || {
            for expected_index in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_http(&mut stream);
                let context: Value =
                    serde_json::from_str(s(&request["messages"][1], "content")).unwrap();
                assert_eq!(rows(&context["questions"]).len(), 1);
                let expected_id = format!("simulated-failed-{expected_index}");
                assert_eq!(context["questions"][0]["questionId"], expected_id);
                let mut result = candidate();
                result["questionId"] = json!(expected_id);
                if expected_index == 1 {
                    result["teachingSolution"] = json!("下界为2。");
                }
                let body = json!({"choices":[{"finish_reason":"stop","message":{"content":json!({"questions":[result]}).to_string()}}]}).to_string();
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
            }
        });
        let payload = json!({"importId":record["importId"],"expectedRevision":record["revision"],"operationId":"simulated-targeted-repair","questionIds":["simulated-failed-0","simulated-failed-1"]});
        let result = retry_failed(&store, &model, &payload, &AtomicBool::new(false)).unwrap();
        handle.join().unwrap();
        let repaired = &result["import"];
        for index in 0..3 {
            assert_eq!(before["questions"][index], repaired["questions"][index]);
        }
        for index in 3..5 {
            assert_eq!(
                source_hash(&before["questions"][index]),
                source_hash(&repaired["questions"][index])
            );
            assert_eq!(
                repaired["questions"][index]["teachingWorkflow"]["generationCalls"],
                2
            );
            assert_eq!(
                repaired["questions"][index]["teachingWorkflow"]["reviewCalls"],
                index - 3
            );
        }
        assert!(ready(&repaired["questions"][3]));
        assert!(!ready(&repaired["questions"][4]));
        verify_audit(&store, &repaired["questions"][3]).unwrap();
        let audit: Value = serde_json::from_slice(
            &std::fs::read(
                store
                    .data_dir
                    .join(s(&repaired["teachingRetry"], "auditRelativePath")),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            audit["previousWorkflows"][0]["workflow"],
            before["questions"][3]["teachingWorkflow"]
        );
        // Listener is gone: this also proves replay does not discover models or
        // issue another generation/review call, even with the old revision.
        let again = retry_failed(&store, &model, &payload, &AtomicBool::new(false)).unwrap();
        assert_eq!(again["replayed"], true);
        assert_eq!(again["import"], result["import"]);
        let mut conflict = payload.clone();
        conflict["questionIds"] = json!(["simulated-failed-1"]);
        assert_eq!(
            retry_failed(&store, &model, &conflict, &AtomicBool::new(false))
                .unwrap_err()
                .code,
            "operation_conflict"
        );
    }

    #[test]
    fn simulated_explicit_failed_retry_rejects_stale_or_nonfailed_targets_without_mutation() {
        let (_dir, store, mut record) = fixture("合格稿，$1+1=2$。");
        let model = ModelClient::test_client(&store.data_dir, "http://127.0.0.1:1/v1");
        let base = json!({"importId":record["importId"],"expectedRevision":record["revision"],"operationId":"simulated-rejected-retry","questionIds":["simulated-q1"]});
        let cases = vec![
            (base.clone(), "teaching_retry_ineligible"),
            (
                {
                    let mut p = base.clone();
                    p["expectedRevision"] = json!(999);
                    p
                },
                "revision_conflict",
            ),
            (
                {
                    let mut p = base.clone();
                    p["questionIds"] = json!([]);
                    p
                },
                "invalid_teaching_retry_targets",
            ),
            (
                {
                    let mut p = base.clone();
                    p["questionIds"] = json!(["missing"]);
                    p
                },
                "invalid_teaching_retry_targets",
            ),
            (
                {
                    let mut p = base.clone();
                    p["questionIds"] = json!(["simulated-q1", "simulated-q1"]);
                    p
                },
                "teaching_retry_ineligible",
            ),
        ];
        for (payload, code) in cases {
            assert_eq!(
                retry_failed(&store, &model, &payload, &AtomicBool::new(false))
                    .unwrap_err()
                    .code,
                code
            );
            assert_eq!(
                store.document("imports", s(&record, "importId")).unwrap(),
                record
            );
        }
        initialize_pending(&mut record["questions"][0]);
        record["questions"][0]["teachingWorkflow"]["generationCalls"] = json!(1);
        record["questions"][0]["teachingWorkflow"]["status"] = json!("generation_failed");
        record["questions"][0]["stem"] = json!("changed source");
        store
            .put_document("imports", s(&record, "importId"), &record)
            .unwrap();
        assert_eq!(
            retry_failed(&store, &model, &base, &AtomicBool::new(false))
                .unwrap_err()
                .code,
            "teaching_retry_ineligible"
        );
        assert_eq!(
            store.document("imports", s(&record, "importId")).unwrap(),
            record
        );
        assert_eq!(
            retry_failed(&store, &model, &base, &AtomicBool::new(true))
                .unwrap_err()
                .code,
            "cancelled"
        );
    }

    #[test]
    fn simulated_failed_retry_reviews_current_candidate_instead_of_old_malformed_raw() {
        let (_dir, store, mut record) = fixture("模拟旧稿");
        initialize_pending(&mut record["questions"][0]);
        let wf = &mut record["questions"][0]["teachingWorkflow"];
        // The prior process stopped after saving a format failure, before Qwen.
        wf["status"] = json!("generation_failed");
        wf["generationCalls"] = json!(1);
        wf["reviewEligible"] = json!(true);
        wf["rawCandidate"] = json!("old malformed draft marker {");
        store.put_document("imports", s(&record, "importId"), &record).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let model = ModelClient::test_client(
            &store.data_dir,
            &format!("http://{}/v1", listener.local_addr().unwrap()),
        );
        let handle = std::thread::spawn(move || {
            for index in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_http(&mut stream);
                let output = if index == 0 {
                    let mut fresh = candidate();
                    fresh["teachingSolution"] = json!("下界为2。");
                    json!({"questions":[fresh]})
                } else {
                    let context: Value = serde_json::from_str(s(&request["messages"][1], "content")).unwrap();
                    assert!(context["rawCandidate"].is_null());
                    assert_eq!(context["rawCandidateSameAsCandidate"], true);
                    assert_eq!(context["candidate"]["teachingSolution"], "下界为2。");
                    assert!(!context.to_string().contains("old malformed draft marker"));
                    let contract=&context["patchContract"];
                    json!({"questionId":contract["questionId"],"candidateSha256":contract["candidateSha256"],"sourceContentSha256":contract["sourceContentSha256"],"patches":[{"fieldPath":"teachingSolution","oldText":context["candidate"]["teachingSolution"],"newText":candidate()["teachingSolution"]}],"unresolvedIssues":[]})
                };
                let body = json!({"choices":[{"finish_reason":"stop","message":{"content":output.to_string()}}]}).to_string();
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
            }
        });
        let payload = json!({"importId":record["importId"],"expectedRevision":record["revision"],"operationId":"simulated-fresh-raw-repair","questionIds":["simulated-q1"]});
        let result = retry_failed(&store, &model, &payload, &AtomicBool::new(false)).unwrap();
        handle.join().unwrap();
        let repaired = &result["import"]["questions"][0];
        assert!(ready(repaired));
        assert_eq!(repaired["teachingWorkflow"]["generationCalls"], 2);
        assert_eq!(repaired["teachingWorkflow"]["reviewCalls"], 1);
        verify_audit(&store, repaired).unwrap();
    }

    #[test]
    fn simulated_explicit_failed_retry_new_generation_audit_preserves_spent_qwen_quota() {
        let (_dir, store, mut record) = fixture("模拟旧稿");
        initialize_pending(&mut record["questions"][0]);
        let wf = &mut record["questions"][0]["teachingWorkflow"];
        wf["status"] = json!("generation_failed");
        wf["generationCalls"] = json!(1);
        wf["reviewCalls"] = json!(1);
        wf["reviewFinishedAt"] = json!("old-review-time");
        wf["responseRelativePath"] = json!("imports/nonexistent-old-qwen-response.json");
        store
            .put_document("imports", s(&record, "importId"), &record)
            .unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let model = ModelClient::test_client(
            &store.data_dir,
            &format!("http://{}/v1", listener.local_addr().unwrap()),
        );
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _request = read_http(&mut stream);
            let body = json!({"choices":[{"finish_reason":"stop","message":{"content":json!({"questions":[candidate()]}).to_string()}}]}).to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
        });
        let payload = json!({"importId":record["importId"],"expectedRevision":record["revision"],"operationId":"simulated-spent-quota-repair","questionIds":["simulated-q1"]});
        let result = retry_failed(&store, &model, &payload, &AtomicBool::new(false)).unwrap();
        handle.join().unwrap();
        let repaired = &result["import"]["questions"][0];
        assert!(ready(repaired));
        assert_eq!(repaired["teachingWorkflow"]["reviewCalls"], 1);
        verify_audit(&store, repaired).unwrap();
        let raw = json!({"questionId":"simulated-q1","contentVersion":"c1","teacherVersion":"t1","teacher":{}});
        let mut entry = json!({});
        apply_to_entry(repaired, &raw, &mut entry, "simulated-repair-publish").unwrap();
        assert_eq!(
            entry["teachingAnalysis"]["generatedAt"],
            repaired["teachingWorkflow"]["generationFinishedAt"]
        );
        assert_ne!(entry["teachingAnalysis"]["generatedAt"], "old-review-time");
    }
}
