//! Explicit source/candidate-bound acknowledgements and atomic teacher-text patches.
//! No keyword is a semantic severity decision; raw model issues always remain.
use super::*;

pub(super) fn active_candidate(q: &Value) -> Value {
    let wf = &q["teachingWorkflow"];
    for key in ["candidateResult", "finalResult", "reviewedCandidate", "initialCandidate"] {
        let candidate = &wf[key];
        if validate(candidate, s(q, "questionId")).is_ok() {
            return candidate.clone();
        }
    }
    Value::Null
}

fn field_pointer(path: &str) -> Option<String> {
    match path {
        "answer" => Some("/answer".into()),
        "teachingSolution" => Some("/teachingSolution".into()),
        "difficultyAssessment.basis" => Some("/difficultyAssessment/basis".into()),
        "teachingFocus.examFocus" => Some("/teachingFocus/examFocus".into()),
        _ => {
            let number = path.strip_prefix("teachingFocus.studentRequirements[")?.strip_suffix(']')?;
            if number.is_empty() || !number.bytes().all(|c| c.is_ascii_digit()) || number.len() > 1 { return None; }
            let index: usize = number.parse().ok()?;
            (index < 3).then(|| format!("/teachingFocus/studentRequirements/{index}"))
        }
    }
}

fn editable_fields(candidate: &Value) -> Vec<Value> {
    let mut paths = vec!["answer".to_owned(), "teachingSolution".to_owned(), "difficultyAssessment.basis".to_owned(), "teachingFocus.examFocus".to_owned()];
    paths.extend(rows(&candidate["teachingFocus"]["studentRequirements"]).iter().enumerate().map(|(i, _)|format!("teachingFocus.studentRequirements[{i}]")));
    paths.into_iter().filter_map(|path| {
        let pointer = field_pointer(&path)?;
        Some(json!({"path":path,"value":candidate.pointer(&pointer)?.as_str()?}))
    }).collect()
}

pub(super) fn acknowledged(q: &Value, candidate: &Value, issue: &str) -> bool {
    let dispositions = &q["teachingWorkflow"]["reviewDispositions"];
    if dispositions["version"] != 1 || dispositions["sourceContentSha256"] != source_hash(q)
        || dispositions["candidateSha256"] != hash_json(candidate) { return false; }
    let matching: Vec<_> = rows(&candidate["issues"]).iter().enumerate()
        .filter(|(_, v)|v.as_str()==Some(issue)).map(|(index, _)|index).collect();
    !matching.is_empty() && matching.iter().all(|index| rows(&dispositions["acknowledgements"]).iter().any(|a| {
        a["issueIndex"].as_u64()==Some(*index as u64) && a["message"]==issue && a["issueSha256"]==hash_json(&json!(issue))
        && matches!(s(a,"classification"),"reference_notice"|"nonblocking_observation")
        && !s(a,"basis").trim().is_empty() && s(a,"basis").chars().count()<=5000
        && matches!((s(a,"method"),s(a,"checkedBy")),("teacher_review","teacher")|("user_authorized_agent_review","codex"))
        && ["sourceMatched","answerChecked","solutionChecked","formulaChecked"].iter().all(|k|a["checks"][*k]==true)
    }))
}

pub(super) fn effective_findings(q: &Value, candidate: &Value) -> Vec<Value> {
    let mut all=findings(candidate,s(q,"questionId"));all.extend(quality_findings(q,candidate));
    all.into_iter().filter(|finding| {
        finding["type"] != "model_issue" || !acknowledged(q,candidate,s(finding,"issue"))
    }).collect()
}

pub(in crate::imports) fn projection(record: &Value) -> Value {
    let mut map = serde_json::Map::new();
    for q in rows(&record["questions"]) {
        let candidate = active_candidate(&q);
        let valid = candidate.is_object() && q["teachingWorkflow"]["sourceContentSha256"] == source_hash(&q);
        let hard = !question_issues(&q,&record["sourceIssues"]).is_empty()
            || rows(&q["duplicateCandidates"]).iter().any(|c|c["exact"]==true)
            || ids(&record["publishedQuestionIds"]).contains(&s(&q,"questionId").to_owned());
        let issues:Vec<_> = rows(&candidate["issues"]).iter().enumerate().map(|(index,issue)| {
            let seen = acknowledged(&q,&candidate,issue.as_str().unwrap_or(""));
            let ack = rows(&q["teachingWorkflow"]["reviewDispositions"]["acknowledgements"]).into_iter().find(|a|a["issueIndex"].as_u64()==Some(index as u64));
            json!({"issueIndex":index,"issue":issue,"issueSha256":hash_json(issue),"disposition":if seen{"informative"}else{"blocking"},"acknowledged":seen,"basis":ack.map(|a|a["basis"].clone()),"acknowledgeable":valid&&!hard})
        }).collect();
        map.insert(s(&q,"questionId").to_owned(),json!({"sourceContentSha256":source_hash(&q),"candidateSha256":if valid{json!(hash_json(&candidate))}else{Value::Null},"issues":issues,"editableFields":if valid{editable_fields(&candidate)}else{vec![]},"canAcknowledge":valid&&!hard,"canPatch":valid&&!hard}));
    }
    Value::Object(map)
}

pub(super) fn apply_patches(candidate: &Value, id: &str, patches: &Value, allowed: &[String]) -> AppResult<Value> {
    let entries=patches.as_array().filter(|a|!a.is_empty()&&a.len()<=12)
        .ok_or_else(||err("invalid_teaching_patch","补丁必须包含有限且非空的字段替换。"))?;
    let mut next=candidate.clone();let mut seen=HashSet::new();
    for p in entries {
        if !exact(p,&["fieldPath","oldText","newText"]) {return Err(err("invalid_teaching_patch","补丁字段不符合受限替换合同。"));}
        let path=s(p,"fieldPath");let pointer=field_pointer(path).ok_or_else(||err("invalid_teaching_patch","只能修改获准的教学文字字段。"))?;
        if !allowed.iter().any(|v|v==path)||!seen.insert(path.to_owned())||!p["oldText"].is_string()||!p["newText"].is_string()||s(p,"newText").chars().count()>60_000 {
            return Err(err("invalid_teaching_patch","补丁超出获准范围、重复或类型不合法。"));
        }
        let field=next.pointer_mut(&pointer).ok_or_else(||err("invalid_teaching_patch","补丁不能新增字段或数组元素。"))?;
        if !field.is_string()||*field!=p["oldText"] {return Err(err("revision_conflict","补丁原文与当前教学稿不一致。"));}
        *field=p["newText"].clone();
    }
    validate(&next,id)?;
    Ok(next)
}

/// Allowlisting follows only actual text locations, never guessed mathematical severity.
pub(super) fn patch_contract(q:&Value,context:&Value)->Option<Value> {
    let candidate=&context["candidate"];
    if validate(candidate,s(q,"questionId")).is_err()||!rows(&candidate["issues"]).is_empty(){return None;}
    let flags=rows(&context["reviewFindings"]);if flags.is_empty(){return None;}
    let mut paths=vec![];
    let semantic=flags.iter().filter(|f|f["type"]=="quality").cloned().collect::<Vec<_>>();
    let hash_mode=if context["patchContract"].is_object(){context["patchContract"]["fieldHashMode"]==true}else{!semantic.is_empty()};
    for flag in flags {
        if !matches!(s(&flag,"type"),"term"|"display"|"quality"){return None;}
        if flag["type"]=="quality"&&matches!(s(&flag,"dimension"),"material"|"assessment"){return None;}
        let fields=if flag["type"]=="quality"&&matches!(s(&flag,"dimension"),"mathematics"|"proof"|"method") {
            editable_fields(candidate).iter().map(|f|s(f,"path").to_owned()).collect::<Vec<_>>()
        }else{vec![s(&flag,"fieldPath").to_owned()]};
        for path in fields {
            let pointer=field_pointer(&path)?;let expected=candidate.pointer(&pointer)?.as_str()?;
            if !paths.iter().any(|v:&Value|v["fieldPath"]==path){let mut field=json!({"fieldPath":path,"expectedText":expected});if hash_mode{field["expectedTextSha256"]=json!(hash_json(&json!(expected)));}paths.push(field);}
        }
    }
    let mut contract=json!({"questionId":q["questionId"],"candidateSha256":hash_json(candidate),"sourceContentSha256":source_hash(q),"allowedFields":paths});
    if !semantic.is_empty(){contract["qualityFindings"]=json!(semantic);}if hash_mode{contract["fieldHashMode"]=json!(true);}Some(contract)
}

pub(super) fn merge_model_patch(q:&Value,context:&Value,patch:&Value)->AppResult<Value> {
    merge_bound_patch(s(q,"questionId"),&source_hash(q),context,patch)
}
pub(super) fn merge_bound_patch(id:&str,expected_source_hash:&str,context:&Value,patch:&Value)->AppResult<Value> {
    let contract=&context["patchContract"];
    let mut keys=vec!["questionId","candidateSha256","sourceContentSha256","patches","unresolvedIssues"];
    if contract["qualityFindings"].is_array(){keys.push("qualityResolutions");}
    if !exact(patch,&keys)
        || ["questionId","candidateSha256","sourceContentSha256"].iter().any(|k|patch[*k]!=contract[*k])
        || contract["questionId"]!=id || context["candidate"]["questionId"]!=id
        || contract["candidateSha256"]!=hash_json(&context["candidate"])
        || contract["sourceContentSha256"]!=expected_source_hash
        || !patch["patches"].is_array() || rows(&patch["patches"]).len()>12
        || !strings(&patch["unresolvedIssues"],100,4000) {
        return Err(err("invalid_teaching_patch","复核补丁身份、来源版本或结构无效。"));
    }
    if !rows(&patch["unresolvedIssues"]).is_empty(){return Err(err("teaching_patch_unresolved","受限复核发现需扩大范围或仍无法确认的问题，保留待复核，不追加调用。"));}
    let allowed=rows(&contract["allowedFields"]).iter().map(|v|s(v,"fieldPath").to_owned()).collect::<Vec<_>>();
    let replacements=if contract["fieldHashMode"]==true {
        let mut entries=vec![];
        for item in rows(&patch["patches"]) {
            if !exact(&item,&["fieldPath","oldTextSha256","newText"]){return Err(err("invalid_teaching_patch","字段hash补丁格式无效。"));}
            let path=s(&item,"fieldPath");let pointer=field_pointer(path).ok_or_else(||err("invalid_teaching_patch","补丁越界。"))?;
            let current=context["candidate"].pointer(&pointer).filter(|v|v.is_string()).ok_or_else(||err("invalid_teaching_patch","补丁字段不存在。"))?;
            let allowed_field=rows(&contract["allowedFields"]).into_iter().find(|f|f["fieldPath"]==path).ok_or_else(||err("invalid_teaching_patch","补丁越界。"))?;
            if allowed_field["expectedTextSha256"]!=hash_json(current)||item["oldTextSha256"]!=allowed_field["expectedTextSha256"] {return Err(err("revision_conflict","字段hash与当前原文不一致。"));}
            entries.push(json!({"fieldPath":path,"oldText":current,"newText":item["newText"]}));
        }json!(entries)
    }else{patch["patches"].clone()};
    let next=if rows(&replacements).is_empty(){context["candidate"].clone()}else{apply_patches(&context["candidate"],id,&replacements,&allowed)?};
    validate_quality_resolutions(context,patch,&next)?;Ok(next)
}

fn response(record:Value)->Value{json!({"reviewEligibility":review::eligibility(&record),"reviewRequirements":review_requirement_map(&record),"teachingControls":projection(&record),"import":record})}

pub(in crate::imports) fn action(store:&Store,payload:&Value,patch:bool,cancel:&AtomicBool)->AppResult<Value>{
    action_with_authority(store,payload,patch,cancel,"teacher_review","teacher")
}
#[cfg(debug_assertions)]
pub(in crate::imports) fn agent_action(store:&Store,payload:&Value,patch:bool,cancel:&AtomicBool)->AppResult<Value>{
    action_with_authority(store,payload,patch,cancel,"user_authorized_agent_review","codex")
}
fn action_with_authority(store:&Store,payload:&Value,patch:bool,cancel:&AtomicBool,method:&str,checked_by:&str)->AppResult<Value>{
    cancelled(cancel)?;let op=operation(payload)?;let payload_hash=hash_json(payload);
    let mut record=store.document("imports",s(payload,"importId"))?;
    if replay(&record,op,&payload_hash)? {return Ok(response(record));}
    revision(&record,payload)?;
    if record["pendingPublication"].is_object()||matches!(s(&record["backgroundJob"],"status"),"queued"|"running") {return Err(err("import_running","试卷仍在处理或等待发布，暂不能修改教学复核。"));}
    paddle::verify_audit(store,&record)?;
    let saved=record.clone();let id=s(payload,"questionId");
    let index=rows(&record["questions"]).iter().position(|q|q["questionId"]==id).ok_or_else(||err("invalid_import","题目不属于本次导入。"))?;
    let q=&record["questions"][index];let candidate=active_candidate(q);
    if candidate.is_null()||q["teachingWorkflow"]["sourceContentSha256"]!=source_hash(q)
        ||payload["sourceContentSha256"]!=source_hash(q)||payload["candidateSha256"]!=hash_json(&candidate){return Err(err("revision_conflict","原题或候选教学稿已变化，请重新核对。"));}
    if ids(&record["publishedQuestionIds"]).contains(&id.to_owned())||!question_issues(q,&record["sourceIssues"]).is_empty()
        ||rows(&q["duplicateCandidates"]).iter().any(|v|v["exact"]==true){return Err(err("review_required","原题保真、重复或已发布状态不能通过教学复核绕过。"));}
    structured::verify_assets(q)?;
    if s(payload,"basis").trim().is_empty()||s(payload,"basis").chars().count()>5000 {return Err(err("review_required","请填写本次实际核对或修改依据。"));}
    let before_action=json!({"operationId":op,"sourceContentSha256":source_hash(q),"candidateSha256":hash_json(&candidate),"previousStatus":q["teachingWorkflow"]["status"],"previousFindings":q["teachingWorkflow"]["findings"],"previousEffectiveFindings":q["teachingWorkflow"]["effectiveFindings"],"previousFinalResult":q["teachingWorkflow"]["finalResult"],"method":method,"checkedBy":checked_by,"basis":payload["basis"],"action":if patch{"patch"}else{"acknowledgement"},"recordedAt":now()});
    if patch {
        let allowed=editable_fields(&candidate).iter().map(|v|s(v,"path").to_owned()).collect::<Vec<_>>();
        let next=apply_patches(&candidate,id,&payload["patches"],&allowed)?;
        let mut history=rows(&q["teachingWorkflow"]["manualPatchHistory"]);
        history.push(json!({"operationId":op,"sourceContentSha256":source_hash(q),"baseCandidate":candidate,"baseCandidateSha256":hash_json(&candidate),"candidateSha256":hash_json(&next),"patches":payload["patches"],"basis":payload["basis"],"method":method,"checkedBy":checked_by,"patchedAt":now()}));
        let wf=&mut record["questions"][index]["teachingWorkflow"];
        wf["manualPatchHistory"]=json!(history);wf["candidateResult"]=next;
        wf["reviewDispositions"]=Value::Null;
    } else {
        if !matches!(s(payload,"kind"),"reference_notice"|"nonblocking_observation")
            ||["sourceMatched","answerChecked","solutionChecked","formulaChecked"].iter().any(|k|payload["checks"][*k]!=true){return Err(err("review_required","须明确核对原题、答案、解析和公式后才能将观察记为非阻断提醒。"));}
        let issue_index=payload["issueIndex"].as_u64().ok_or_else(||err("review_required","缺少确切疑点身份。"))? as usize;
        let issue=candidate["issues"].get(issue_index).filter(|v|v.is_string()).ok_or_else(||err("review_required","疑点不属于当前候选稿。"))?;
        if payload["issueSha256"]!=hash_json(issue){return Err(err("revision_conflict","疑点原文已变化。"));}
        let mut ds=q["teachingWorkflow"]["reviewDispositions"].clone();
        if ds["candidateSha256"]!=hash_json(&candidate)||ds["sourceContentSha256"]!=source_hash(q){ds=json!({"version":1,"candidateSha256":hash_json(&candidate),"sourceContentSha256":source_hash(q),"acknowledgements":[]});}
        let mut entries=rows(&ds["acknowledgements"]);entries.retain(|a|a["issueIndex"].as_u64()!=Some(issue_index as u64));
        entries.push(json!({"issueIndex":issue_index,"issueSha256":hash_json(issue),"message":issue,"classification":payload["kind"],"basis":payload["basis"],"checks":payload["checks"],"method":method,"checkedBy":checked_by,"operationId":op,"acknowledgedAt":now()}));
        ds["acknowledgements"]=json!(entries);record["questions"][index]["teachingWorkflow"]["reviewDispositions"]=ds;
    }
    let mut control_history=rows(&record["questions"][index]["teachingWorkflow"]["controlActionsHistory"]);control_history.push(before_action);
    record["questions"][index]["teachingWorkflow"]["controlActionsHistory"]=json!(control_history);
    refresh(&mut record["questions"][index]);
    finish(&mut record,op,&payload_hash,if patch{"teaching_patch"}else{"teaching_issue_acknowledgement"});
    save_cas(store,Some(&saved),&record)?;Ok(response(record))
}

pub(super) fn refresh(q:&mut Value){
    let candidate=active_candidate(q);let all=findings(&candidate,s(q,"questionId"));
    let effective=effective_findings(q,&candidate);let wf=&mut q["teachingWorkflow"];
    wf["candidateResult"]=candidate.clone();wf["findings"]=json!(all);wf["effectiveFindings"]=json!(effective);
    wf["status"]=json!(if effective.is_empty(){"ready_candidate"}else{"needs_review"});
    wf["finalResult"]=if effective.is_empty(){candidate}else{Value::Null};
}

pub(super) fn base_before_manual(q:&Value,current:&Value)->AppResult<Value>{
    let history=rows(&q["teachingWorkflow"]["manualPatchHistory"]);
    if history.is_empty(){return Ok(current.clone());}
    let original=history[0]["baseCandidate"].clone();let mut value=original.clone();
    for item in history {
        if item["sourceContentSha256"]!=source_hash(q)||item["baseCandidateSha256"]!=hash_json(&value)||item["baseCandidate"]!=value
            ||!matches!((s(&item,"method"),s(&item,"checkedBy")),("teacher_review","teacher")|("user_authorized_agent_review","codex"))||s(&item,"basis").trim().is_empty(){return Err(err("teaching_audit_changed","教学补丁审计身份或原文不一致。"));}
        let allowed=editable_fields(&value).iter().map(|v|s(v,"path").to_owned()).collect::<Vec<_>>();
        value=apply_patches(&value,s(q,"questionId"),&item["patches"],&allowed)?;
        if item["candidateSha256"]!=hash_json(&value){return Err(err("teaching_audit_changed","教学补丁结果校验失败。"));}
    }
    if value!=*current{return Err(err("teaching_audit_changed","当前教学稿与受限补丁审计不一致。"));}
    Ok(original)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn candidate()->Value{json!({"questionId":"sim-control-q","answer":"2","difficultyAssessment":{"level":"easy","basis":"模拟回归：直接计算。"},"teachingSolution":"由 $1+1=2$ 得答案。","teachingFocusSchemaVersion":2,"teachingFocus":{"examFocus":"模拟整数加法。","studentRequirements":["能计算1+1。"]},"issues":[]})}
    fn question(c:Value)->Value{
        let mut q=json!({"questionId":"sim-control-q","sourceLabel":"1","questionType":"fill_blank","stem":"模拟回归：1+1？","options":[],"parts":[],"answer":"2","solution":"模拟原卷解析","pages":[1],"student":{"assets":[]},"teacher":{"assets":[]},"assetPayloads":[],"sourceIssues":[],"reviewDecision":"pending"});
        let detected=findings(&c,"sim-control-q");q["teachingWorkflow"]=json!({"sourceContentSha256":source_hash(&q),"status":"needs_review","candidateResult":c,"initialCandidate":c,"initialFindings":detected,"findings":detected,"reviewCalls":1,"generationCalls":1});q
    }
    fn setup(c:Value)->(tempfile::TempDir,Store,Value){
        let dir=tempfile::tempdir().unwrap();let store=Store::open(dir.path(),&crate::bank::tests::seed()).unwrap();
        let record=json!({"importId":"sim-controls","revision":1,"source":{"extension":"txt"},"questions":[question(c)],"sourceIssues":[],"operations":[],"publishedQuestionIds":[]});
        store.put_document("imports","sim-controls",&record).unwrap();(dir,store,record)
    }
    fn bound(record:&Value,op:&str)->Value{let q=&record["questions"][0];let c=active_candidate(q);json!({"importId":"sim-controls","expectedRevision":record["revision"],"operationId":op,"questionId":q["questionId"],"sourceContentSha256":source_hash(q),"candidateSha256":hash_json(&c),"basis":"模拟回归：已逐项核对原题与教学稿。"})}
    fn ack(record:&Value)->Value{
        let mut payload=bound(record,"sim-ack");let issue=&record["questions"][0]["teachingWorkflow"]["candidateResult"]["issues"][0];
        payload["issueIndex"]=json!(0);payload["issueSha256"]=json!(hash_json(issue));payload["kind"]=json!("reference_notice");payload["checks"]=json!({"sourceMatched":true,"answerChecked":true,"solutionChecked":true,"formulaChecked":true});payload
    }
    #[test]
    fn simulated_ack_persists_raw_issue_source_binding_and_replays_without_model(){
        let mut c=candidate();c["issues"]=json!(["参考材料：原参考变量名笔误，新稿已按原题使用正确变量。"]);
        let (_dir,store,record)=setup(c.clone());let input=ack(&record);
        let result=action(&store,&input,false,&AtomicBool::new(false)).unwrap();let q=&result["import"]["questions"][0];
        assert!(ready(q));assert_eq!(q["teachingWorkflow"]["candidateResult"],c);assert_eq!(q["teachingWorkflow"]["findings"][0]["type"],"model_issue");
        assert!(rows(&q["teachingWorkflow"]["effectiveFindings"]).is_empty());assert_eq!(q["teachingWorkflow"]["reviewCalls"],1);
        assert_eq!(result["teachingControls"]["sim-control-q"]["issues"][0]["disposition"],"informative");
        assert_eq!(action(&store,&input,false,&AtomicBool::new(false)).unwrap()["import"],result["import"]);
        let mut changed=q.clone();changed["stem"]=json!("模拟源已改变");assert!(!ready(&changed));
        let mut forged=q.clone();forged["teachingWorkflow"]["finalResult"]["answer"]=json!("3");assert!(!ready(&forged));
    }
    #[test]
    fn simulated_ack_never_silences_terms_format_or_hard_source_or_forged_identity(){
        let mut c=candidate();c["issues"]=json!(["模拟参考笔误"]);c["teachingSolution"]=json!("模拟范数");
        let (_dir,store,record)=setup(c);let input=ack(&record);let next=action(&store,&input,false,&AtomicBool::new(false)).unwrap();assert!(!ready(&next["import"]["questions"][0]));
        for field in ["sourceContentSha256","candidateSha256","issueSha256"]{
            let mut wrong=ack(&next["import"]);wrong["operationId"]=json!(format!("bad-{field}"));wrong[field]=json!("wrong");assert!(action(&store,&wrong,false,&AtomicBool::new(false)).is_err());
        }
        let mut source=next["import"].clone();source["questions"][0]["sourceIssues"]=json!([{"blocking":true,"message":"模拟原图缺失"}]);source["questions"][0]["teachingWorkflow"]["sourceContentSha256"]=json!(source_hash(&source["questions"][0]));store.put_document("imports","sim-controls",&source).unwrap();
        let mut blocked=ack(&source);blocked["operationId"]=json!("blocked-source");assert_eq!(action(&store,&blocked,false,&AtomicBool::new(false)).unwrap_err().code,"review_required");
    }
    #[test]
    fn simulated_manual_patch_is_atomic_bounded_and_does_not_reset_quota_or_ack(){
        let c=candidate();let (_dir,store,record)=setup(c.clone());let mut input=bound(&record,"sim-patch");
        input["patches"]=json!([{"fieldPath":"teachingFocus.studentRequirements[0]","oldText":"能计算1+1。","newText":"能由加法算出1+1=2。"}]);
        let changed=action(&store,&input,true,&AtomicBool::new(false)).unwrap();let q=&changed["import"]["questions"][0];assert!(ready(q));assert_eq!(q["teachingWorkflow"]["reviewCalls"],1);assert_eq!(q["teachingWorkflow"]["candidateResult"]["teachingSolution"],c["teachingSolution"]);
        assert_eq!(base_before_manual(q,&q["teachingWorkflow"]["finalResult"]).unwrap(),c);
        for path in ["questionId","stem","issues","teachingFocus.studentRequirements","teachingFocus.studentRequirements[3]","difficultyAssessment.level"]{
            let mut wrong=bound(&changed["import"],&format!("bad-{}",path.len()));wrong["patches"]=json!([{"fieldPath":path,"oldText":"","newText":"2"}]);assert!(action(&store,&wrong,true,&AtomicBool::new(false)).is_err());
        }
        let before=store.document("imports","sim-controls").unwrap();let mut mixed=bound(&before,"atomic-wrong");mixed["patches"]=json!([{"fieldPath":"answer","oldText":"2","newText":"3"},{"fieldPath":"teachingSolution","oldText":"not-current","newText":"wrong"}]);assert!(action(&store,&mixed,true,&AtomicBool::new(false)).is_err());assert_eq!(store.document("imports","sim-controls").unwrap(),before);
        assert_eq!(action(&store,&input,true,&AtomicBool::new(false)).unwrap()["import"],before);
    }
    #[test]
    fn simulated_model_patch_allowlist_rejects_expansion_and_preserves_raw_output(){
        let mut c=candidate();c["difficultyAssessment"]["basis"]=json!("模拟：这里称约束");let q=question(c.clone());let mut context=review_context(&q);let contract=patch_contract(&q,&context).unwrap();assert_eq!(rows(&contract["allowedFields"]).len(),1);context["patchContract"]=contract.clone();
        let mut response=json!({"questionId":q["questionId"],"candidateSha256":contract["candidateSha256"],"sourceContentSha256":contract["sourceContentSha256"],"patches":[{"fieldPath":"difficultyAssessment.basis","oldText":"模拟：这里称约束","newText":"模拟：利用已知条件。"}],"unresolvedIssues":[]});
        let next=merge_model_patch(&q,&context,&response).unwrap();assert_eq!(next["teachingSolution"],c["teachingSolution"]);assert!(findings(&next,"sim-control-q").is_empty());
        response["patches"][0]["fieldPath"]=json!("answer");response["patches"][0]["oldText"]=json!("2");assert!(merge_model_patch(&q,&context,&response).is_err());
        response["patches"]=json!([]);response["unresolvedIssues"]=json!(["模拟：需要修改未授权的答案，不能在当前范围完成。"]);assert_eq!(merge_model_patch(&q,&context,&response).unwrap_err().code,"teaching_patch_unresolved");
    }
    #[test]
    fn simulated_bounded_patches_conform_to_shared_js_rust_fixtures(){
        let fixtures:Value=serde_json::from_str(include_str!("../../../../../scripts/resources/teaching-bounded-patch-fixtures.json")).unwrap();
        assert_eq!(fixtures["version"],1);
        for case in rows(&fixtures["cases"]){
            let c=&case["candidate"];let allowed=ids(&case["allowedFieldPaths"]);
            let result=apply_patches(c,s(c,"questionId"),&case["patches"],&allowed);
            assert_eq!(result.is_ok(),case["accepted"]==true,"{}",case["name"]);
            if let Some(expected)=case.get("expected"){assert_eq!(result.unwrap(),*expected,"{}",case["name"]);}
        }
    }
    #[test]
    fn simulated_v2_hash_patch_cas_and_legacy_quality_replay_are_compatible(){
        let c=candidate();let q=question(c.clone());
        let mut ctx=review_context(&q);ctx["reviewFindings"]=json!([{"type":"quality","id":"proof-1","dimension":"proof","fieldPath":"teachingSolution","reason":"模拟需补全具体计算。"}]);
        ctx["patchContract"]=patch_contract(&q,&ctx).unwrap();let contract=&ctx["patchContract"];
        assert_eq!(contract["fieldHashMode"],true);
        let response=json!({"questionId":q["questionId"],"candidateSha256":contract["candidateSha256"],"sourceContentSha256":contract["sourceContentSha256"],"patches":[{"fieldPath":"teachingSolution","oldTextSha256":hash_json(&c["teachingSolution"]),"newText":"模拟：直接计算1+1=2，得到答案。"}],"unresolvedIssues":[],"qualityResolutions":[{"id":"proof-1","status":"resolved","basis":"模拟已写出计算闭环。"}]});
        assert!(merge_model_patch(&q,&ctx,&response).is_ok());
        let mut wrong=response.clone();wrong["patches"][0]["oldTextSha256"]=json!("wrong");assert_eq!(merge_model_patch(&q,&ctx,&wrong).unwrap_err().code,"revision_conflict");
        wrong=response.clone();wrong["patches"][0]["fieldPath"]=json!("stem");assert!(merge_model_patch(&q,&ctx,&wrong).is_err());
        wrong=response.clone();wrong["patches"][0]["oldText"]=c["teachingSolution"].clone();assert!(merge_model_patch(&q,&ctx,&wrong).is_err());
        let mut legacy=ctx.clone();legacy["patchContract"].as_object_mut().unwrap().remove("fieldHashMode");
        for f in legacy["patchContract"]["allowedFields"].as_array_mut().unwrap(){f.as_object_mut().unwrap().remove("expectedTextSha256");}
        let before=legacy.clone();assert_eq!(patch_contract(&q,&legacy).unwrap(),legacy["patchContract"]);
        let mut old_response=response.clone();old_response["patches"][0].as_object_mut().unwrap().remove("oldTextSha256");old_response["patches"][0]["oldText"]=c["teachingSolution"].clone();
        assert!(merge_model_patch(&q,&legacy,&old_response).is_ok());assert_eq!(legacy,before);
    }
}
