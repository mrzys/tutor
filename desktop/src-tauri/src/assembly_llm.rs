//! LLM teaching decisions over real, versioned bank questions. Local checks here
//! validate identities and explicit teacher constraints, never infer teaching fit.
use crate::{error::AppResult, intake::{self, invalid, list, s, strings}, model::ModelClient};
use serde_json::{Value, json};
use base64::Engine;
use std::{collections::HashSet, sync::atomic::{AtomicBool, Ordering}};

pub fn signature(slot: &Value, requirements: &Value) -> String {
    crate::bank::hash_json(&json!({"requirements":intake::model_context(requirements),"slot":{"slotId":slot["slotId"],"taskId":slot["taskId"],"taskLabel":slot["taskLabel"],"questionType":slot["questionType"],"goalIds":slot["goalIds"],"targetDifficulty":slot["targetDifficulty"],"targetDifficultyLevel":slot["targetDifficultyLevel"],"points":slot["points"],"partPoints":slot["partPoints"]}}))
}
pub fn duplicate_group(question: &Value, config: &Value) -> String {
    let annotation = config["assemblyIndex"]["entries"].as_array().into_iter().flatten().find(|entry|
        entry["questionId"] == question["questionId"] && entry["contentVersion"] == question["contentVersion"] && entry["teacherVersion"] == question["teacherVersion"]);
    annotation.and_then(|entry| entry["duplicateGroup"].as_str()).filter(|group| !group.is_empty()).map(str::to_owned)
        .unwrap_or_else(|| crate::bank::hash_json(&question["student"]))
}
pub fn available(question: &Value, slot: &Value, requirements: &Value, config: &Value, existing: &[Value]) -> bool {
    if question["questionType"] != slot["questionType"] { return false; }
    let sources = strings(&requirements["sourceIds"]);
    if requirements["sourceIds"].is_array() && !list(&question["sourceRefs"]).iter().any(|source| sources.iter().any(|id| id == s(source, "sourceId"))) { return false; }
    let group = duplicate_group(question, config);
    !existing.iter().any(|other| {
        let q = &other["question"];
        q.is_object() && (q["questionId"] == question["questionId"] || (other["slotId"] != slot["slotId"] && duplicate_group(q, config) == group))
    })
}
pub fn saved_matches(decision: &Value, question: &Value, slot: &Value, requirements: &Value) -> bool {
    decision["provenance"] == "llm_selection_v1" && decision["criteriaSha256"] == signature(slot, requirements)
        && decision["questionId"] == question["questionId"] && decision["contentVersion"] == question["contentVersion"] && decision["teacherVersion"] == question["teacherVersion"]
}
fn text(value: &Value, max: usize, label: &str) -> AppResult<String> {
    let text = value.as_str().filter(|text| !text.trim().is_empty() && text.chars().count() <= max).ok_or_else(|| invalid(label))?;
    Ok(text.to_owned())
}
pub(crate) fn candidate_visuals(question:&Value,assets:&mut Vec<Value>)->Vec<Value>{
    list(&question["assetPayloads"]).iter().map(|image|{
        let id=format!("{}:{}:{}",s(question,"questionId"),s(image,"role"),s(image,"assetId"));
        assets.push(json!({"id":id,"questionId":question["questionId"],"assetId":image["assetId"],"role":image["role"],"page":1,"contentBase64":image["dataBase64"]}));
        json!({"id":id,"assetId":image["assetId"],"role":image["role"]})
    }).collect()
}
const SEARCH_STRATEGY:&str="bounded-selection-v1";
struct SearchState {slot:Value,ordered:Vec<usize>,fingerprint:String,offset:usize,row:Value}
fn annotation<'a>(question:&Value,config:&'a Value)->Option<&'a Value>{
    config["assemblyIndex"]["entries"].as_array().into_iter().flatten().find(|entry|entry["questionId"]==question["questionId"] && entry["contentVersion"]==question["contentVersion"] && entry["teacherVersion"]==question["teacherVersion"])
}
fn ordered_pool(pool:&[Value],slot:&Value,requirements:&Value,config:&Value,existing:&[Value])->Vec<usize>{
    let priority=|q:&Value|{
        let a=annotation(q,config);
        let task=a.is_some_and(|a|strings(&a["tasks"]).iter().any(|id|id==s(slot,"taskId")));
        let uid=a.is_some_and(|a|strings(&a["primaryKnowledgeUids"]).iter().any(|id|strings(&requirements["mainKnowledgeUids"]).contains(id)));
        let section=a.is_some_and(|a|intake::overlaps(&a["primarySections"],&requirements["mainScope"]));
        (task,uid,section)
    };
    let mut ordered:Vec<_>=pool.iter().enumerate().filter(|(_,q)|available(q,slot,requirements,config,existing)).map(|(i,_)|i).collect();
    ordered.sort_by(|left,right|priority(&pool[*right]).cmp(&priority(&pool[*left])).then_with(||s(&pool[*left],"questionId").cmp(s(&pool[*right],"questionId"))));
    ordered
}
fn cursor(state:&SearchState,requirements:&Value)->Value{
    if state.offset>=state.ordered.len(){return Value::Null;}
    let payload=json!({"strategy":SEARCH_STRATEGY,"criteria":signature(&state.slot,requirements),"pool":state.fingerprint,"offset":state.offset});
    json!(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload.to_string()))
}
fn matched(states:&[SearchState])->HashSet<usize>{
    let rows:Vec<_>=states.iter().map(|state|list(&state.row["candidates"]).iter().map(|c|(s(c,"questionId").to_owned(),s(c,"duplicateGroup").to_owned())).collect()).collect();
    crate::assembly::assignment(&rows).into_keys().collect()
}
fn run_search(pool:&[Value],slots:&[Value],requirements:&Value,config:&Value,existing:&[Value],model:&ModelClient,cancel:&AtomicBool,continuation:Option<(&Value,&Value)>)->AppResult<Vec<Value>>{
    let mut states:Vec<_>=slots.iter().map(|slot|{
        let ordered=ordered_pool(pool,slot,requirements,config,existing);
        let identities:Vec<_>=ordered.iter().map(|i|json!({"questionId":pool[*i]["questionId"],"contentVersion":pool[*i]["contentVersion"],"teacherVersion":pool[*i]["teacherVersion"],"sourceRefs":pool[*i]["sourceRefs"],"annotation":annotation(&pool[*i],config)})).collect();
        SearchState{slot:slot.clone(),fingerprint:crate::bank::hash_json(&json!({"strategy":SEARCH_STRATEGY,"questions":identities,"sources":config["sourceManifest"]})),ordered,offset:0,row:json!({"slotId":slot["slotId"],"candidates":[],"assessments":[],"missingReason":"","criteriaSha256":signature(slot,requirements)})}
    }).collect();
    if let Some((cached,requested))=continuation {
        if states.len()!=1 || cached["criteriaSha256"]!=signature(&states[0].slot,requirements) {return Err(invalid("续查条件已变化，请重新比较候选；原成果保留。"));}
        let state=&mut states[0];
        state.offset=cached["search"]["presentedCount"].as_u64().filter(|n|*n<=state.ordered.len() as u64).ok_or_else(||invalid("续查位置已失效，请重新比较候选。"))? as usize;
        if !requested.is_string() || requested!=&cached["search"]["continuation"] || requested!=&cursor(state,requirements) {return Err(invalid("续查目录或题库版本已变化，请重新比较候选；原成果保留。"));}
        state.row=cached.clone();
        if list(&state.row["assessments"]).iter().any(|decision|!pool.iter().any(|q|q["questionId"]==decision["questionId"] && saved_matches(decision,q,&state.slot,requirements) && available(q,&state.slot,requirements,config,existing))) {return Err(invalid("已比较候选的版本或条件已变化，请重新比较候选。"));}
    }
    for (round,limit) in [(1,12),(2,20)] {
        if cancel.load(Ordering::Relaxed){return Err(crate::error::AppError::new("cancelled","已停止，未保存部分选题结果。"));}
        let filled=matched(&states);
        let targets:Vec<_>=states.iter().enumerate().filter(|(i,state)|(round==1 || !filled.contains(i)) && state.offset<state.ordered.len()).map(|(i,_)|i).collect();
        let batches=targets.len().div_ceil(6);
        for (batch_index,indices) in targets.chunks(6).enumerate(){
            let previous:Vec<_>=states.iter().map(|state|state.row.clone()).collect();
            let batch_slots:Vec<_>=indices.iter().map(|i|states[*i].slot.clone()).collect();
            let windows:Vec<_>=indices.iter().map(|i|states[*i].ordered[states[*i].offset..(states[*i].offset+limit).min(states[*i].ordered.len())].to_vec()).collect();
            let pool_count=indices.iter().flat_map(|i|states[*i].ordered.iter().copied()).collect::<HashSet<_>>().len();
            let rows=evaluate_batch(pool,&batch_slots,&windows,requirements,config,existing,model,cancel,if slots.len()==1{8}else{3},batch_index+1,batches,round,pool_count,&previous)?;
            if cancel.load(Ordering::Relaxed){return Err(crate::error::AppError::new("cancelled","已停止，未保存部分选题结果。"));}
            for (index,window) in indices.iter().zip(windows){
                let row=rows.iter().find(|row|row["slotId"]==states[*index].slot["slotId"]).unwrap();
                let state=&mut states[*index];state.offset+=window.len();
                for field in ["candidates","assessments"] {let mut merged=list(&state.row[field]);merged.extend(list(&row[field]));state.row[field]=json!(merged);}
                state.row["missingReason"]=row["missingReason"].clone();
            }
        }
    }
    let filled=matched(&states);
    for (i,state) in states.iter_mut().enumerate(){
        let assessed=list(&state.row["assessments"]).iter().map(|d|s(d,"questionId").to_owned()).collect::<HashSet<_>>().len();
        let remaining=state.ordered.len()-state.offset;
        state.row["search"]=json!({"poolCount":state.ordered.len(),"presentedCount":state.offset,"assessedCount":assessed,"searchIncomplete":assessed<state.ordered.len(),"continuation":cursor(state,requirements)});
        if !filled.contains(&i) {
            state.row["missingReason"]=json!(format!("{} 本次已发送 {} 道真实候选，模型明确判断 {assessed} 道；整卷去重后尚未匹配本题位，尚有 {remaining} 道未比较。未返回逐题判断的候选保持未知，未声称全库无题。",s(&state.row,"missingReason"),state.offset));
        }
    }
    Ok(states.into_iter().map(|state|state.row).collect())
}
pub fn evaluate(pool: &[Value], slots: &[Value], requirements: &Value, config: &Value, existing: &[Value], model: &ModelClient, cancel: &AtomicBool) -> AppResult<Vec<Value>> {
    run_search(pool,slots,requirements,config,existing,model,cancel,None)
}
pub fn continue_evaluate(pool:&[Value],slot:&Value,requirements:&Value,config:&Value,existing:&[Value],model:&ModelClient,cancel:&AtomicBool,cached:&Value,continuation:&Value)->AppResult<Vec<Value>>{
    run_search(pool,&[slot.clone()],requirements,config,existing,model,cancel,Some((cached,continuation)))
}
fn referenced_catalogue(requirements:&Value,questions:&[Value],slots:&[Value],config:&Value)->(Vec<Value>,Vec<Value>,Vec<Value>,HashSet<String>){
    let mut uids=HashSet::new();let mut sections=HashSet::new();let mut premises=HashSet::new();let mut sources=HashSet::new();
    for field in ["mainKnowledgeUids","learnedKnowledgeUids"]{uids.extend(strings(&requirements[field]));}
    for field in ["mainScope","learnedScope"]{sections.extend(strings(&requirements[field]).iter().map(|id|intake::canonical(id)));}
    for field in ["premises","foundationPremises"]{premises.extend(strings(&requirements[field]));}
    sources.extend(strings(&requirements["sourceIds"]));
    for goal in list(&requirements["teachingGoals"]){sections.extend(strings(&goal["knowledgeScope"]).iter().map(|id|intake::canonical(id)));uids.extend(strings(&goal["knowledgeUids"]));}
    for slot in slots{for task in list(&config["tasks"]).iter().filter(|task|task["id"]==slot["taskId"]){sections.extend(strings(&task["sectionIds"]).iter().map(|id|intake::canonical(id)));}}
    for q in questions{
        uids.extend(strings(&q["metadataHints"]["primaryKnowledgeUids"]));
        sections.extend(strings(&q["metadataHints"]["primarySections"]).iter().map(|id|intake::canonical(id)));
        for path in list(&q["metadataHints"]["solutionPaths"]){uids.extend(strings(&path["requiredKnowledgeUids"]));premises.extend(strings(&path["requiredPremises"]));}
        for source in list(&q["sourceRefs"]){sources.insert(s(&source,"sourceId").to_owned());}
    }
    let points=list(&config["knowledgeCatalogue"]["points"]);
    loop{let before=uids.len();for point in &points{if uids.contains(s(point,"uid")) && !s(point,"parentUid").is_empty(){uids.insert(s(point,"parentUid").to_owned());}}if before==uids.len(){break;}}
    let knowledge:Vec<_>=points.iter().filter(|point|uids.contains(s(point,"uid"))).map(|point|{
        sections.extend(strings(&point["sectionIds"]).iter().map(|id|intake::canonical(id)));
        json!({"uid":point["uid"],"name":point["name"],"parentUid":point["parentUid"],"sectionIds":point["sectionIds"]})
    }).collect();
    let mut seen=HashSet::new();
    let chapters=list(&config["chapters"]).into_iter().filter(|chapter|{let id=intake::canonical(s(chapter,"id"));sections.contains(&id) && seen.insert(id)}).collect();
    let premises=list(&config["premises"]).into_iter().filter(|premise|premises.contains(s(premise,"id"))).collect();
    (chapters,knowledge,premises,sources)
}
fn evaluate_batch(pool: &[Value], slots: &[Value], windows:&[Vec<usize>],requirements: &Value, config: &Value, existing: &[Value], model: &ModelClient, cancel: &AtomicBool, candidate_limit:usize,batch_index:usize,batch_count:usize,round:usize,pool_count:usize,previous:&[Value]) -> AppResult<Vec<Value>> {
    if cancel.load(Ordering::Relaxed) { return Err(crate::error::AppError::new("cancelled", "已停止，原草稿保留。")); }
    let mut supplied = HashSet::new();
    let mut questions = Vec::new();
    let mut assets = Vec::new();
    let mut slot_context = Vec::new();
    for (slot,window) in slots.iter().zip(windows) {
        let mut ids = Vec::new();
        for q in window.iter().map(|i|&pool[*i]) {
            ids.push(q["questionId"].clone());
            if supplied.insert(s(q, "questionId").to_owned()) {
                let annotation = annotation(q,config);
                let visuals=candidate_visuals(q,&mut assets);
                let hints=annotation.map(|a|json!({"difficultyLevel":a["difficultyLevel"],"difficultyBasis":a["difficultyBasis"],"primaryKnowledgeUids":a["primaryKnowledgeUids"],"primarySections":a["primarySections"],"annotationSource":a["annotationSource"],"solutionPaths":list(&a["solutionPaths"]).iter().map(|path|json!({"id":path["id"],"requiredKnowledgeUids":path["requiredKnowledgeUids"],"requiredPremises":path["requiredPremises"]})).collect::<Vec<_>>()}));
                let teaching=if list(&q["teacher"]["solutions"]).is_empty() && q["teachingAnalysis"]["baseContentVersion"]==q["contentVersion"] && q["teachingAnalysis"]["baseTeacherVersion"]==q["teacherVersion"] {json!({"solution":q["teachingAnalysis"]["solution"],"status":q["teachingAnalysis"]["status"],"provenance":"llm_generated_reference"})}else{Value::Null};
                questions.push(json!({"questionId":q["questionId"],"contentVersion":q["contentVersion"],"teacherVersion":q["teacherVersion"],"questionType":q["questionType"],"student":q["student"],"teacher":{"answers":q["teacher"]["answers"],"solutions":q["teacher"]["solutions"]},"teachingReference":teaching,"sourceRefs":q["sourceRefs"],"sourceLabel":q["sourceLabel"],"metadataHints":hints,"visuals":visuals}));
            }
        }
        let mut context = slot.clone();
        for key in ["question", "applicability", "selection", "candidateEvaluations"] { context.as_object_mut().unwrap().remove(key); }
        context["candidateQuestionIds"] = json!(ids);
        slot_context.push(context);
    }
    let (chapters,knowledge,premises,source_ids)=referenced_catalogue(requirements,&questions,slots,config);
    let sources:Vec<_>=list(&config["sourceManifest"]["sources"]).iter().filter(|source|source_ids.contains(s(source,"sourceId"))).map(|source|{
        let label=source["label"].as_str().or_else(||source["title"].as_str()).or_else(||source["path"].as_str().and_then(|path|path.rsplit(['/', '\\']).next())).unwrap_or("");
        json!({"sourceId":source["sourceId"],"id":source["id"],"label":label,"year":source["year"]})
    }).collect();
    let previous:Vec<_>=previous.iter().map(|row|json!({"slotId":row["slotId"],"candidateQuestionIds":list(&row["candidates"]).iter().map(|candidate|candidate["questionId"].clone()).collect::<Vec<_>>()})).collect();
    let presented=windows.iter().map(Vec::len).sum::<usize>();
    let context = json!({"requirements":intake::model_context(requirements),"slots":slot_context,"questions":questions,"candidateLimit":candidate_limit,"batch":{"index":batch_index,"total":batch_count,"round":round},"batchIndex":batch_index,"batchCount":batch_count,"roundIndex":round,"poolCount":pool_count,"presentedCount":presented,"slotCount":slots.len(),"questionCount":questions.len(),"previousBatchJudgments":previous,"sources":sources,"catalogue":{"chapters":chapters,"knowledge":knowledge,"premises":premises}});
    crate::assembly_log::data_for_task("selection","candidate_window","recorded",json!({"input":{"batch":context["batch"],"slots":context["slots"],"poolCount":pool_count,"presentedCount":presented,"questionCount":questions.len()}}));
    let output = model.propose_selection(&context, &assets, cancel)?;
    let checked = validate(&output, pool, slots,windows,requirements, config, existing,candidate_limit);
    let assessed=checked.as_ref().map(|rows|rows.iter().map(|row|list(&row["assessments"]).len()).sum::<usize>()).unwrap_or(0);
    let search_incomplete=checked.as_ref().map(|rows|slots.iter().any(|slot|{
        let count=rows.iter().find(|row|row["slotId"]==slot["slotId"]).map(|row|list(&row["assessments"]).len()).unwrap_or(0);
        count<pool.iter().filter(|q|available(q,slot,requirements,config,existing)).count()
    })).unwrap_or(true);
    crate::assembly_log::selection_window(json!({"batchIndex":batch_index,"batchCount":batch_count,"roundIndex":round,"poolCount":pool_count,"presentedCount":presented,"assessedCount":assessed,"slotCount":slots.len(),"candidateCount":questions.len(),"questionCount":questions.len(),"searchIncomplete":search_incomplete}));
    match &checked {
        Ok(value) => crate::assembly_log::data_for_task("selection", "validation", "completed", json!({"validation":{"valid":true,"after":value}})),
        Err(error) => crate::assembly_log::data_for_task("selection", "validation", "failed", json!({"validation":{"valid":false,"errorCode":error.code,"message":error.message,"before":output}})),
    }
    checked
}
fn validate(output: &Value, pool: &[Value], slots: &[Value],windows:&[Vec<usize>],requirements: &Value, config: &Value, existing: &[Value],candidate_limit:usize) -> AppResult<Vec<Value>> {
    let rankings = output["rankings"].as_array().filter(|rows| rows.len() == slots.len()).ok_or_else(|| invalid("AI 判断未覆盖全部真实题位，原成果保留，请重试。"))?;
    let mut seen_slots = HashSet::new();
    let mut result = Vec::new();
    for ranking in rankings {
        let slot = slots.iter().find(|slot| slot["slotId"] == ranking["slotId"]).ok_or_else(|| invalid("AI 返回未知题位。"))?;
        if !seen_slots.insert(s(slot,"slotId")) { return Err(invalid("AI 重复返回题位。")); }
        let candidates = ranking["candidates"].as_array().ok_or_else(|| invalid("AI 未给出候选教学判断。"))?;
        if candidates.len()>candidate_limit{return Err(invalid("AI 本批返回候选数超过明确输出上限，未采用部分结果，请重试。"));}
        let mut seen_questions = HashSet::new();
        let mut valid = Vec::new();
        let mut assessments = Vec::new();
        for item in candidates {
            let slot_index=slots.iter().position(|candidate|candidate["slotId"]==slot["slotId"]).unwrap();
            if !windows[slot_index].iter().any(|i|pool[*i]["questionId"]==item["questionId"]) {return Err(invalid("AI 返回未发送给本题位的候选，未采用未比较的题目。"));}
            let q = pool.iter().find(|q| q["questionId"] == item["questionId"]).ok_or_else(|| invalid("AI 返回题库中不存在的题目，未生成或替换题目。"))?;
            if !seen_questions.insert(s(q,"questionId")) { return Err(invalid("AI 候选重复。")); }
            if !available(q, slot, requirements, config, existing) || item["contentVersion"] != q["contentVersion"] || item["teacherVersion"] != q["teacherVersion"] { return Err(invalid("AI 候选违反真实版本、题型、来源或重复约束。")); }
            let status = s(item,"status");
            if !["suitable","unsuitable","uncertain"].contains(&status) { return Err(invalid("AI 教学判断状态无效。")); }
            let reason = text(&item["reason"], 1500, "AI 未说明实际教学适配依据。")?;
            let solution = if status == "suitable" { text(&item["solutionBasis"], 4000, "AI 未给出适合本次已学条件的解法依据。")? } else { item["solutionBasis"].as_str().unwrap_or("").to_owned() };
            let level = item["difficulty"]["level"].clone();
            intake::validate_difficulty_level(&level)?;
            let basis = item["difficulty"]["basis"].as_str().unwrap_or("");
            if !level.is_null() && basis.trim().is_empty() { return Err(invalid("AI 难度判断缺少依据。")); }
            let part_points = item.get("partPoints").cloned().unwrap_or(json!([]));
            if status == "suitable" && requirements["scoringMode"] != "none" && q["questionType"] == "free_response" {
                let parts = list(&q["student"]["parts"]);
                let allocations = part_points.as_array().ok_or_else(|| invalid("AI 小问分值结构无效。"))?;
                let mut seen = HashSet::new();
                let mut total = 0;
                for part in allocations { if !parts.iter().any(|p| p["partId"] == part["partId"]) || !seen.insert(s(part,"partId")) { return Err(invalid("AI 小问分值身份不一致。")); } total += part["points"].as_u64().filter(|points| *points<=1000).ok_or_else(|| invalid("AI 小问分值无效。"))?; }
                if allocations.len() != parts.len() || total != slot["points"].as_u64().unwrap_or(0) { return Err(invalid("AI 小问赋分未保持已确认题分。")); }
            }
            let decision = json!({"questionId":q["questionId"],"contentVersion":q["contentVersion"],"teacherVersion":q["teacherVersion"],"status":if status=="suitable"{"eligible"}else if status=="uncertain"{"unknown"}else{"related"},"modelStatus":status,"canSelect":status=="suitable","current":false,"duplicate":false,"duplicateGroup":duplicate_group(q,config),"reasons":[reason],"reason":reason,"difficulty":item["difficulty"],"solutionBasis":solution,"allowedSolutionPath":{"basis":solution,"source":"llm_selection"},"partPoints":part_points,"provenance":"llm_selection_v1","criteriaSha256":signature(slot,requirements),"evaluatedAt":chrono::Utc::now().to_rfc3339()});
            if status == "suitable" { valid.push(decision.clone()); }
            assessments.push(decision);
        }
        let missing = if valid.is_empty() { text(&ranking["missingReason"], 1500, "AI 未说明本题位的真实缺题或判断限制。")? } else { ranking["missingReason"].as_str().unwrap_or("").to_owned() };
        result.push(json!({"slotId":slot["slotId"],"candidates":valid,"assessments":assessments,"missingReason":missing,"criteriaSha256":signature(slot,requirements)}));
    }
    Ok(result)
}
