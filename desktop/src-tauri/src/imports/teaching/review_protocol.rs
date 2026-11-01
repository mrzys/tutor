//! Compact model protocol. The server keeps all CAS hashes and exact ranges;
//! model output cannot choose a source version or grant itself a wider scope.
use super::*;

#[path = "option_method_scopes.rs"]
mod option_method_scopes;

fn question_type_review_guidance(context: &Value) -> &'static str {
    let stored = s(&context["verifiedInputFacts"], "questionType");
    let material_type = s(&context["originalMaterial"], "questionType");
    if !stored.is_empty() && !material_type.is_empty() && stored != material_type {
        return "已给题型与原题元数据不一致，保留具体冲突，不按选项数猜题型或擅改原题。仍只处理已授权问题。";
    }
    match if stored.is_empty() { material_type } else { stored } {
        "single_choice" => "单选复核：核对现有路线是否足以确定唯一答案，是否混淆必要与充分条件；有效排除可用合法反例，正确项的普遍结论不能仅靠代值。只处理已定位的重复全解或错误，不为凑齐四项补写无关长解。",
        "multiple_choice" => "多选复核：逐项核对真假依据、量词、参数域和端点；共同计算可复用，不能由已找到若干正确项推断其他项。全称命题为假可给合法反例，存在为真须说明可取。选项证明范围不授权修改共同推导或其他选项；若本次修复依赖这些未授权改动，具体写入unresolvedIssues，不扩权。某项未解决不能宣称整题答案已确定。",
        "fill_blank" => "填空复核：直接核对本次定位的问题，保持各空顺序与必要单位；只展开真正影响答案的条件、端点或取值说明，不额外罗列全套检验。常规运算合并，必要论证保留，不因精简漏掉其他有效结果。",
        "free_response" => "解答题复核：按原小问身份核对完整主路径及前问引用，保全必要分类、充分性、存在性和唯一性。关键构造说明来由，常规重复计算可合并；不得借本问条件改写其他问，材料不足不得擅改题意。",
        _ => "当前没有已确认的四类题型，保留题型未知，不按选项数或题目长短猜测。继续按已定位问题核对数学、证明和讲解，不扩大补丁权限。",
    }
}

pub(super) fn v2(context:&Value)->bool {
    if context["patchContract"].is_object(){context["patchContract"]["segmentPatchVersion"]==2}
    else {context["reviewPatchVersion"]==2}
}
pub(super) fn method_finding(f:&Value)->bool {
    (f["type"]=="quality" && f["dimension"]=="method") ||
    (f["type"]=="term" && (f["ruleId"]=="limit-notation" || f["category"]=="special_tool"))
}
pub(super) fn attach_method_scopes(q:&Value,context:&mut Value) {
    let text=s(&context["candidate"],"teachingSolution");
    if text.is_empty(){return;}
    let mut parts=vec![];
    let source_parts=rows(&q["parts"]);
    if source_parts.is_empty(){
        if matches!(s(q,"questionType"),"single_choice"|"multiple_choice") {
            // Choice labels identify display blocks only. Never let missing or
            // ambiguous labels silently grant a whole-question method rewrite.
            parts=option_method_scopes::parts(q,text);
        } else {parts.push((0,text.chars().count(),"本题完整相关证明段".to_owned()));}
    }
    else {
        let re=Regex::new(r"(?m)^[ \t]*(?:\*\*)?[（(]\s*([0-9]+)\s*[)）]").unwrap();
        let headings=re.captures_iter(text).map(|m|(m.get(0).unwrap().start(),m[1].parse::<usize>().unwrap_or(0))).collect::<Vec<_>>();
        // A step number is not a question-part boundary. Require an exact,
        // complete ordered correspondence with the actual source subquestions.
        let source_label=Regex::new(r"^(?:（([1-9][0-9]*)）|\(([1-9][0-9]*)\)|([1-9][0-9]*)[.．、]?)$").unwrap();
        if source_parts.iter().enumerate().any(|(i,p)|source_label.captures(s(p,"label").trim()).and_then(|m|m.iter().skip(1).flatten().next().and_then(|v|v.as_str().parse::<usize>().ok()))!=Some(i+1))
            || headings.len()!=source_parts.len() || headings.iter().enumerate().any(|(i,(_,n))|*n!=i+1){return;}
        for (i,(start,n)) in headings.iter().enumerate(){
            let end=headings.get(i+1).map_or(text.len(),|v|v.0);
            parts.push((text[..*start].chars().count(),text[..end].chars().count(),format!("第（{n}）小问的完整相关证明段")));
        }
    }
    let flags=rows(&context["reviewFindings"]);
    let mut scopes=vec![];let mut seen=HashSet::new();
    for flag in &flags {
        if !method_finding(flag) || flag["fieldPath"]!="teachingSolution"{continue;}
        let Some((a,b))=sentence_patch::locate(text,flag) else {continue;};
        let Some((start,end,basis))=parts.iter().find(|(start,end,_)|*start<=a && b<=*end) else {continue;};
        if end-start>6000 || !seen.insert((*start,*end)){continue;}
        scopes.push(json!({"fieldPath":"teachingSolution","start":start,"end":end,
            "expectedText":text.chars().skip(*start).take(end-start).collect::<String>(),"scopeBasis":basis}));
    }
    if scopes.is_empty(){return;}
    context["reviewMethodScopes"]=json!(scopes);
    context["methodReferences"]=json!([
        "方法参考须核对适用条件：若用对数判断数列的变化趋势，可考虑先证明u/(1+u)<ln(1+u)<u（u>0），代入后比较具体差值。不直接引用对数连续性或把整数已知擅自推广到实数。",
        "参数恒成立的必要性：若要否定某段参数范围，先设参数与待检验边界的正差，再用具体不等式明确选出一个正数或整数并代入验证；不能只写充分小、足够大或存在δ。"
    ]);
    // Operator-selected references in an explicitly bound offline experiment.
    let refs=&q["teachingWorkflow"]["methodReferenceSelection"];
    if refs["sourceContentSha256"]==source_hash(q) && refs["candidateSha256"]==hash_json(&context["candidate"])
        && strings(&refs["items"],4,2000) {
        context["selectedMethodReferences"]=refs["items"].clone();
    }
}
pub(super) fn method_scopes(context:&Value)->Option<Vec<Value>> {
    let scopes=context.get("reviewMethodScopes").or_else(||context["patchContract"].get("methodScopes"));
    match scopes {None=>Some(vec![]),Some(v) if v.is_array() && rows(v).len()<=12=>Some(rows(v)),_=>None}
}
pub(super) fn response_contract(contract:&Value)->Value {
    let mut keys=vec!["requestId","patches","unresolvedIssues"];
    if contract["qualityFindings"].is_array(){keys.push("qualityResolutions");}
    if contract["allowedIssues"].is_array(){keys.push("issueResolutions");}
    if contract["termFindings"].is_array(){keys.push("termResolutions");}
    json!({"requiredKeys":keys,"patchKeys":["segmentId","newText"],"textMutationAllowed":!rows(&contract["allowedSegments"]).is_empty(),
        "issueResolutionAllowed":!rows(&contract["allowedIssues"]).is_empty(),"issueResolutionNeedsTextPatch":false,
        "resolutionVersion":2,"resolutionStatuses":["repaired","false_positive","confirmed_defect","unresolved"],
        "unresolvedIssuesType":"array<string>"})
}
fn pick(value:&Value,keys:&[&str])->Value {
    let mut out=json!({});for key in keys {if let Some(v)=value.get(*key){out[*key]=v.clone();}}out
}
pub(super) fn model_contract(contract:&Value)->Value {
    if contract["segmentPatchVersion"]!=2{return contract.clone();}
    let mut out=pick(contract,&["segmentPatchVersion","requestId","resolutionVersion","classroomPolicyVersion","falsePositiveScopeVersion"]);
    out["allowedSegments"]=json!(rows(&contract["allowedSegments"]).iter().map(|s|pick(s,&["segmentId","fieldPath","start","end","expectedText","scope","scopeBasis"])).collect::<Vec<_>>());
    if contract["falsePositiveScopeVersion"]==1 {
        for segment in out["allowedSegments"].as_array_mut().unwrap() {
            segment["maxNewTextChars"]=json!(if segment["scope"]=="method" {12000} else {6000.min(1000.max(s(segment,"expectedText").chars().count()*3))});
        }
    }
    for (key,id,prefix) in [("qualityFindings","id","q"),("termFindings","findingId","t")] {
        if contract[key].is_array(){out[key]=json!(rows(&contract[key]).iter().enumerate().map(|(i,f)|{
            let mut v=pick(f,&["ruleId","fieldPath","term","start","end","requiredAction","category","dimension","reason","message","quote"]);
            v[id]=json!(format!("{prefix}{i}"));v}).collect::<Vec<_>>());}
    }
    if contract["allowedIssues"].is_array(){out["allowedIssues"]=json!(rows(&contract["allowedIssues"]).iter().map(|v|pick(v,&["issueIndex","expectedText"])).collect::<Vec<_>>());}
    out
}
pub(super) fn model_context(context:&Value)->Value {
    if context["patchContract"]["segmentPatchVersion"]!=2 {
        let mut out=context.clone();
        if context["reviewPatchVersion"]==2 {
            out["questionTypeReviewGuidance"]=json!(question_type_review_guidance(context));
        }
        return out;
    }
    let mut out=pick(context,&["imageReviewAvailable","reviewRules","methodReferences","selectedMethodReferences","operatorInputFacts"]);
    if context["operatorInputFacts"].is_object(){out["operatorInputFacts"]=pick(&context["operatorInputFacts"],&["facts","author"]);}
    // Source and generated text remain data; only protocol metadata is omitted.
    out["originalMaterial"]=pick(&context["originalMaterial"],&["questionType","stem","options","parts","referenceAnswer","referenceSolution","sourceIssues","visuals"]);
    out["candidate"]=pick(&context["candidate"],&["answer","difficultyAssessment","teachingSolution","teachingFocus","issues"]);
    out["patchContract"]=model_contract(&context["patchContract"]);
    out["reviewResponseContract"]=response_contract(&context["patchContract"]);
    out["verifiedInputFacts"]=pick(&context["verifiedInputFacts"],&["questionType"]);
    out["questionTypeReviewGuidance"]=json!(question_type_review_guidance(context));
    out["reviewScopePolicy"]=json!("explicit_segments_or_method_parts");
    if context["patchContract"]["falsePositiveScopeVersion"]==1 {
        out["patchBoundaryInstruction"]=json!("newText只替换expectedText：不要复述该段之外的原文、整字段或相邻保留句。false_positive可不提交补丁；若同时修其他疑点，保持误报所在整句逐字不变。权限和长度以上述合同为准。");
    }
    let quality=rows(&context["patchContract"]["qualityFindings"]);
    out["reviewFindings"]=json!(rows(&context["reviewFindings"]).iter().map(|f|{
        let mut v=pick(f,&["type","ruleId","category","fieldPath","start","end","term","quote","message","reason","issue","id","dimension","reviewGuidanceIndex","code","origin"]);
        if f["type"]=="quality" {if let Some(i)=quality.iter().position(|q|q["id"]==f["id"]){v["id"]=json!(format!("q{i}"));}}
        v
    }).collect::<Vec<_>>());out
}
/// New short envelopes only. The program supplies archived hashes from the
/// frozen local request; this never repairs an old malformed model response.
pub(super) fn expand(contract:&Value,response:&Value)->AppResult<Value> {
    if contract["segmentPatchVersion"]!=2{return Ok(response.clone());}
    let bad=||err("invalid_teaching_patch","短编号补丁的请求或授权身份无效。");
    if contract["classroomPolicyVersion"]!=1{return Err(bad());}
    let schema=response_contract(contract);let keys=ids(&schema["requiredKeys"]);
    if !exact(response,&keys.iter().map(String::as_str).collect::<Vec<_>>()) || response["requestId"]!=contract["requestId"]
        || !response["patches"].is_array() || rows(&response["patches"]).len()>12 || !strings(&response["unresolvedIssues"],100,4000){return Err(bad());}
    let mut out=pick(contract,&["questionId","candidateSha256","sourceContentSha256"]);
    out["unresolvedIssues"]=response["unresolvedIssues"].clone();let mut patches=vec![];
    for p in rows(&response["patches"]) {
        if !exact(&p,&["segmentId","newText"]){return Err(bad());}
        let span=rows(&contract["allowedSegments"]).into_iter().find(|s|s["segmentId"]==p["segmentId"]).ok_or_else(bad)?;
        patches.push(json!({"segmentId":p["segmentId"],"newText":p["newText"],"oldTextSha256":span["expectedTextSha256"]}));
    }out["patches"]=json!(patches);
    for (key,contract_key,id,prefix) in [("qualityResolutions","qualityFindings","id","q"),("termResolutions","termFindings","findingId","t")] {
        if !contract[contract_key].is_array(){continue;}
        let allowed=rows(&contract[contract_key]);let mut values=vec![];
        if !response[key].is_array() || rows(&response[key]).len()!=allowed.len(){return Err(bad());}
        for r in rows(&response[key]) {
            if !exact(&r,&[id,"status","basis"]){return Err(bad());}
            let at=s(&r,id).strip_prefix(prefix).filter(|n|!n.is_empty() && (n==&"0" || !n.starts_with('0')) && n.bytes().all(|b|b.is_ascii_digit())).and_then(|n|n.parse::<usize>().ok()).ok_or_else(bad)?;
            let target=allowed.get(at).ok_or_else(bad)?;
            let mut entry=r.clone();entry[id]=target[id].clone();values.push(entry);
        }out[key]=json!(values);
    }
    if contract["allowedIssues"].is_array(){
        if !response["issueResolutions"].is_array(){return Err(bad());}
        let mut issues=vec![];for r in rows(&response["issueResolutions"]) {
            if !exact(&r,&["issueIndex","status","basis"]){return Err(bad());}
            let issue=rows(&contract["allowedIssues"]).into_iter().find(|i|i["issueIndex"]==r["issueIndex"]).ok_or_else(bad)?;
            let mut v=r.clone();v["oldTextSha256"]=issue["expectedTextSha256"].clone();issues.push(v);
        }out["issueResolutions"]=json!(issues);
    }Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn local(text:&str,parts:usize)->(Value,Value){
        let q=json!({"questionId":"sim-short-q","questionType":"solution","stem":"模拟原题，hash文字是原文。","parts":(0..parts).map(|i|json!({"partId":format!("p{i}"),"label":format!("（{}）",i+1)})).collect::<Vec<_>>()});
        let candidate=json!({"questionId":"sim-short-q","answer":"模拟结论2","difficultyAssessment":{"level":"medium","basis":"模拟：本题根据具体结构判断。"},"teachingSolution":text,"teachingFocusSchemaVersion":2,"teachingFocus":{"examFocus":"模拟核对证明。","studentRequirements":["能写出具体关系。"]},"issues":[]});
        let mut context=json!({"originalMaterial":material(&q),"candidate":candidate,"reviewFindings":findings(&candidate,"sim-short-q"),"reviewPatchVersion":2,"classroomPolicyVersion":1,"reviewResolutionVersion":2});
        attach_method_scopes(&q,&mut context);
        context["patchContract"]=sentence_patch::contract("sim-short-q",&source_hash(&q),&context).unwrap_or_else(||panic!("invalid simulated contract: {context}"));
        (q,context)
    }
    fn reply(context:&Value,text:&str)->Value{
        let c=&context["patchContract"];
        let mut out=json!({"requestId":c["requestId"],"patches":[{"segmentId":c["allowedSegments"][0]["segmentId"],"newText":text}],"unresolvedIssues":[]});
        if c["termFindings"].is_array(){out["termResolutions"]=json!(rows(&c["termFindings"]).iter().enumerate().map(|(i,_)|json!({"findingId":format!("t{i}"),"status":"repaired","basis":"模拟：按获准范围改写，之后重新检查。"})).collect::<Vec<_>>());}out
    }
    fn choice(text:&str)->(Value,Value) {
        let(mut q,mut context)=local(text,0);
        q["questionType"]=json!("multiple_choice");
        q["options"]=json!([{"label":"A"},{"label":"B"},{"label":"C"},{"label":"D"}]);
        context["originalMaterial"]=material(&q);
        context["verifiedInputFacts"]=json!({"questionType":"multiple_choice"});
        for key in ["reviewMethodScopes","methodReferences","patchContract"] {context.as_object_mut().unwrap().remove(key);}
        attach_method_scopes(&q,&mut context);
        context["patchContract"]=sentence_patch::contract("sim-short-q",&source_hash(&q),&context).unwrap();
        (q,context)
    }
    #[test]
    fn simulated_choice_method_patch_locks_common_other_options_and_answer() {
        let text="共同推导必须保持。\nA：模拟判断保持。\nB：故 $\\lim_{x\\to0}h(x)=1$。\nC：模拟判断保持。\nD：模拟判断保持。\n答案：ACD。";
        let(q,context)=choice(text);let spans=rows(&context["patchContract"]["allowedSegments"]);
        assert_eq!(spans.len(),1);assert_eq!(spans[0]["scope"],"method");
        assert_eq!(spans[0]["expectedText"],"B：故 $\\lim_{x\\to0}h(x)=1$。\n");
        let response=reply(&context,"B：模拟：由具体不等式说明本项错误。\n");
        let next=sentence_patch::merge("sim-short-q",&source_hash(&q),&context,&response).unwrap();
        assert_eq!(next["teachingSolution"],"共同推导必须保持。\nA：模拟判断保持。\nB：模拟：由具体不等式说明本项错误。\nC：模拟判断保持。\nD：模拟判断保持。\n答案：ACD。");
        assert_eq!(next["answer"],context["candidate"]["answer"]);
        let view=model_context(&context);
        assert!(s(&view,"questionTypeReviewGuidance").starts_with("多选复核"));
        assert_eq!(view["reviewResponseContract"]["unresolvedIssuesType"],"array<string>");
        let mut malformed=response;malformed["unresolvedIssues"]=json!([{"reason":"仍需核对"}]);
        assert_eq!(sentence_patch::merge("sim-short-q",&source_hash(&q),&context,&malformed).unwrap_err().code,"invalid_teaching_patch");
    }
    #[test]
    fn simulated_choice_mapping_failure_or_shared_finding_never_grants_whole_method() {
        for text in [
            "共同公式故 $\\lim_{x\\to0}h(x)=1$。\nA：正确。\nB：错误。\nC：正确。\nD：正确。",
            "一条单选路线故 $\\lim_{x\\to0}h(x)=1$。",
            "A：正确。\nB：故 $\\lim_{x\\to0}h(x)=1$。\nA：重复。\nC：正确。\nD：正确。",
            "A：正确。\nC：正确。\nB：故 $\\lim_{x\\to0}h(x)=1$。\nD：正确。",
        ] {
            let(_,context)=choice(text);
            assert!(context.get("reviewMethodScopes").is_none());
            assert!(rows(&context["patchContract"]["allowedSegments"]).iter().all(|span|span.get("scope").is_none()));
        }
    }
    #[test]
    fn simulated_review_type_guidance_uses_given_metadata_without_guessing() {
        for (kind,prefix) in [("single_choice","单选复核"),("multiple_choice","多选复核"),("fill_blank","填空复核"),("free_response","解答题复核")] {
            let context=json!({"verifiedInputFacts":{"questionType":kind},"originalMaterial":{"questionType":kind}});
            assert!(question_type_review_guidance(&context).starts_with(prefix));
        }
        let conflict=json!({"verifiedInputFacts":{"questionType":"single_choice"},"originalMaterial":{"questionType":"multiple_choice"}});
        assert!(question_type_review_guidance(&conflict).contains("不一致"));
        assert!(question_type_review_guidance(&json!({"originalMaterial":{"options":["A","B","C","D"]}})).contains("不按选项数"));
    }
    #[test]
    fn simulated_short_projection_omits_protocol_hashes_but_keeps_actual_text_and_local_cas(){
        let(q,ctx)=local(r"模拟：故 $\lim_{x\to0}h(x)=1$。",0);
        let original=ctx.clone();let view=model_context(&ctx);let c=&view["patchContract"];
        assert_eq!(c["segmentPatchVersion"],2);assert_eq!(c["termFindings"][0]["findingId"],"t0");
        for key in ["candidateSha256","sourceContentSha256","questionId","methodScopes"]{assert!(c.get(key).is_none(),"{key}");}
        assert!(c["allowedSegments"][0].get("expectedTextSha256").is_none());
        assert_eq!(view["originalMaterial"]["stem"],q["stem"]);assert_eq!(view["candidate"]["teachingSolution"],ctx["candidate"]["teachingSolution"]);
        assert!(view.get("rawCandidate").is_none());assert_eq!(ctx,original);
        let response=reply(&ctx,"模拟：由具体不等式选择满足条件的数并逐项验证。");
        let next=sentence_patch::merge("sim-short-q",&source_hash(&q),&ctx,&response).unwrap();assert_eq!(next["answer"],ctx["candidate"]["answer"]);
        let mut stale=ctx.clone();stale["candidate"]["answer"]=json!("已变更");assert!(sentence_patch::merge("sim-short-q",&source_hash(&q),&stale,&response).is_err());
        assert!(sentence_patch::merge("sim-short-q","changed-source",&ctx,&response).is_err());
        let mut wrong=response.clone();wrong["requestId"]=json!("r-wrong");assert!(sentence_patch::merge("sim-short-q",&source_hash(&q),&ctx,&wrong).is_err());
        wrong=response.clone();wrong["patches"][0]["oldTextSha256"]=json!("forged");assert!(sentence_patch::merge("sim-short-q",&source_hash(&q),&ctx,&wrong).is_err());
        wrong=response;wrong["termResolutions"][0]["findingId"]=ctx["patchContract"]["termFindings"][0]["findingId"].clone();assert!(sentence_patch::merge("sim-short-q",&source_hash(&q),&ctx,&wrong).is_err());
    }
    #[test]
    fn simulated_method_scope_preserves_other_numbered_parts_and_replays_saved_contract(){
        let text="（1）模拟前问保持。\n（2）模拟改写前文。故 $\\lim_{x\\to0}h(x)=1$。模拟后文。\n（3）模拟末问保持。";
        let(q,ctx)=local(text,3);let c=&ctx["patchContract"];assert_eq!(rows(&c["methodScopes"]).len(),1);
        assert_eq!(c["allowedSegments"][0]["scope"],"method");assert!(s(&c["allowedSegments"][0],"expectedText").starts_with("（2）"));
        let response=reply(&ctx,"（2）模拟：完整改为具体不等式证明。\n");
        let next=sentence_patch::merge("sim-short-q",&source_hash(&q),&ctx,&response).unwrap();
        assert_eq!(next["teachingSolution"],"（1）模拟前问保持。\n（2）模拟：完整改为具体不等式证明。\n（3）模拟末问保持。");
        let mut replay=ctx.clone();replay.as_object_mut().unwrap().remove("reviewMethodScopes");
        assert_eq!(sentence_patch::merge("sim-short-q",&source_hash(&q),&replay,&response).unwrap(),next);
        let mut malformed=ctx.clone();malformed["reviewMethodScopes"]=json!({});assert!(sentence_patch::contract("sim-short-q",&source_hash(&q),&malformed).is_none());
        malformed=ctx.clone();malformed["reviewMethodScopes"][0]["expectedText"]=json!("stale");assert!(sentence_patch::contract("sim-short-q",&source_hash(&q),&malformed).is_none());
        let(_,unknown)=local("模拟没给可靠小问编号。故 $\\lim_{x\\to0}h(x)=1$。",2);assert!(unknown.get("reviewMethodScopes").is_none());
        assert!(unknown["patchContract"]["allowedSegments"][0].get("scope").is_none());
    }
    #[test]
    fn simulated_structural_recovery_without_a_contract_keeps_raw_material_and_original_identity(){
        let context=json!({"reviewPatchVersion":2,"reviewResolutionVersion":2,"classroomPolicyVersion":1,
            "originalMaterial":{"questionId":"sim-incomplete","stem":"真实待恢复原题。"},
            "candidate":{"questionId":"sim-incomplete","answer":"","teachingSolution":""},
            "rawCandidate":"{malformed-json","reviewFindings":[{"type":"format","code":"invalid_json"}]});
        let mut expected=context.clone();expected["questionTypeReviewGuidance"]=json!(question_type_review_guidance(&context));
        assert_eq!(model_context(&context),expected);
        let mut absent=context.clone();absent["patchContract"]=Value::Null;expected["patchContract"]=Value::Null;assert_eq!(model_context(&absent),expected);
        let mut legacy=context.clone();legacy.as_object_mut().unwrap().remove("reviewPatchVersion");assert_eq!(model_context(&legacy),legacy);
    }
    #[test]
    fn simulated_working_steps_do_not_grant_method_scope_for_different_source_labels(){
        let(q,mut ctx)=local("（1）模拟步骤。\n（2）故 $\\lim_{x\\to0}h(x)=1$。",2);
        for labels in [["（Ⅰ）","（Ⅱ）"],["（2）","（3）"],["",""]] {
            let mut source=q.clone();for(i,label)in labels.iter().enumerate(){source["parts"][i]["label"]=json!(label);}
            ctx.as_object_mut().unwrap().remove("reviewMethodScopes");
            ctx.as_object_mut().unwrap().remove("methodReferences");
            attach_method_scopes(&source,&mut ctx);assert!(ctx.get("reviewMethodScopes").is_none());
        }
    }
}
