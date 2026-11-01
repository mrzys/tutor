//! Explicit source-asset placements only. Never infer an owner or insertion
//! location from page position, prose, question labels, or model confidence.
use super::*;

fn bad(message: &str) -> AppError { err("source_asset_binding_invalid", message) }
fn digest(value: &Value) -> bool {
    value.as_str().is_some_and(|s| s.len()==64 && s.bytes().all(|b|b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}
fn exact_keys(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|o|o.len()==keys.len() && keys.iter().all(|k|o.contains_key(*k)))
}
fn nonempty(value: &Value, max: usize) -> bool {
    value.as_str().is_some_and(|s|!s.trim().is_empty() && s.chars().count()<=max && !s.chars().any(char::is_control))
}
fn safe_asset_id(value: &Value) -> bool {
    value.as_str().is_some_and(|s|!s.is_empty() && s.len()<=240 && s.bytes().all(|b|b.is_ascii_alphanumeric() || b"-_.:".contains(&b)))
}
pub(super) fn target_role(target: &Value) -> AppResult<&'static str> {
    match s(target,"field") {
        "stem" if exact_keys(target,&["field"]) => Ok("student"),
        "option" if exact_keys(target,&["field","label"]) && nonempty(&target["label"],8) => Ok("student"),
        "partPrompt" if exact_keys(target,&["field","partId"]) && nonempty(&target["partId"],40) => Ok("student"),
        "answer"|"solution" if exact_keys(target,&["field"]) => Ok("teacher"),
        "partAnswer"|"partSolution" if exact_keys(target,&["field","partId"]) && nonempty(&target["partId"],40) => Ok("teacher"),
        _ => Err(bad("素材位置必须是明确支持的字段及精确选项／小问身份，不能附加其它位置字段。")),
    }
}
pub(super) fn target_mut<'a>(question: &'a mut Value, target: &Value) -> AppResult<&'a mut Value> {
    let field=s(target,"field");
    let result=match field {
        "stem"|"answer"|"solution" => question.get_mut(field),
        "option" => {
            let options=question["options"].as_array_mut().ok_or_else(||bad("素材目标选项不存在。"))?;
            let matches=options.iter().enumerate().filter(|(_,o)|o["label"]==target["label"]).map(|(i,_)|i).collect::<Vec<_>>();
            if matches.len()!=1 {return Err(bad("素材目标选项身份不存在或不唯一。"));}
            options[matches[0]].get_mut("text")
        }
        "partPrompt"|"partAnswer"|"partSolution" => {
            let parts=question["parts"].as_array_mut().ok_or_else(||bad("素材目标小问不存在。"))?;
            let matches=parts.iter().enumerate().filter(|(_,p)|p["partId"]==target["partId"]).map(|(i,_)|i).collect::<Vec<_>>();
            if matches.len()!=1 {return Err(bad("素材目标小问身份不存在或不唯一。"));}
            let key=match field {"partPrompt"=>"prompt","partAnswer"=>"answer",_=>"solution"};
            parts[matches[0]].get_mut(key)
        }
        _ => None,
    }.ok_or_else(||bad("素材目标字段缺失。"))?;
    if !result.is_string() {return Err(bad("素材只能追加到已存在的文本字段。"));}
    Ok(result)
}
pub(super) fn role_text(question: &Value, role: &str) -> Vec<String> {
    let teacher=role=="teacher";
    let mut text=if teacher {vec![s(question,"answer").to_owned(),s(question,"solution").to_owned()]} else {vec![s(question,"stem").to_owned()]};
    if !teacher {text.extend(rows(&question["options"]).iter().map(|o|s(o,"text").to_owned()));}
    for part in rows(&question["parts"]) {
        if teacher {text.extend([s(&part,"answer").to_owned(),s(&part,"solution").to_owned()]);}
        else {text.push(s(&part,"prompt").to_owned());}
    }
    text
}
/// Format recognition, not semantic ownership detection. Match actual image
/// references accepted by the renderer, never a declaration/prose mention.
pub(super) fn reference_in_text(text: &str, id: &str) -> bool {
    let re=regex::Regex::new(r#"!\[[^\]]*\]\(([^)]+)\)|(?i:<img\s[^>]*src=[\"']([^\"']+)[\"'])"#).unwrap();
    re.captures_iter(text).any(|c|c.get(1).or_else(||c.get(2)).is_some_and(|v|v.as_str().trim().trim_start_matches("asset:")==id))
}
fn referenced(question: &Value, role: &str, id: &str) -> bool {
    role_text(question,role).iter().any(|text|reference_in_text(text,id))
}
fn verified_asset<'a>(placement: &Value, question: &Value, document: &'a OcrDocument) -> AppResult<&'a Value> {
    if !exact_keys(placement,&["assetId","role","target","sourceBlockIds","basis"])
        || !safe_asset_id(&placement["assetId"]) || !nonempty(&placement["basis"],2000)
        || target_role(&placement["target"])? != s(placement,"role") {
        return Err(bad("素材绑定必须完整说明真实身份、角色、精确位置、原文块及依据，且学生／教师角色不能越界。"));
    }
    let assets=document.assets.iter().filter(|a|a["id"]==placement["assetId"]).collect::<Vec<_>>();
    if assets.len()!=1 {return Err(bad("素材身份不存在或不唯一。"));}
    let asset=assets[0];
    if asset["role"]=="source_page" || !digest(&asset["sha256"])
        || !rows(&question["pages"]).contains(&asset["page"]) {
        return Err(bad("不能把原整页或其它来源页素材绑定到当前题目。"));
    }
    let bytes=base64::engine::general_purpose::STANDARD.decode(s(asset,"contentBase64")).map_err(|_|bad("原素材字节不可核对。"))?;
    if bytes.is_empty() || sha(&bytes)!=s(asset,"sha256") {return Err(bad("原素材字节与保存哈希不符。"));}
    let ids=rows(&placement["sourceBlockIds"]);
    let selected=ids.iter().filter_map(Value::as_str).collect::<BTreeSet<_>>();
    let owner=asset_blocks(document,asset);
    let question_blocks=super::ids(&question["sourceBlockIds"]);
    let known_blocks=document.pages.iter().flat_map(|p|rows(&p["blocks"]).into_iter().map(move|b|format!("p{}-b{}",p["page"],b["id"]))).collect::<BTreeSet<_>>();
    if ids.is_empty() || selected.len()!=ids.len()
        || selected.iter().any(|id|!question_blocks.iter().any(|q|q==id) || !known_blocks.contains(*id))
        || !selected.iter().any(|id|owner.iter().any(|a|a==id)) {
        return Err(bad("素材绑定须包含该原图的实际块，所有配图及说明块必须真实并属于当前整题。"));
    }
    let roles=rows(&question["materialRoles"]).into_iter().filter(|r|r["assetId"]==placement["assetId"]).collect::<Vec<_>>();
    if roles.len()!=1 || roles[0]["role"]!=placement["role"] {
        return Err(bad("素材绑定与原响应的唯一角色／归属不一致。"));
    }
    let role_ids=rows(&roles[0]["sourceBlockIds"]);
    let role_set=role_ids.iter().filter_map(Value::as_str).collect::<BTreeSet<_>>();
    if role_set.len()!=role_ids.len() || role_set!=selected {return Err(bad("素材绑定与原角色声明的原文块不一致。"));}
    let mut clone=question.clone();
    target_mut(&mut clone,&placement["target"])?;
    Ok(asset)
}
fn valid_author(author: &Value) -> bool {
    exact_keys(author,&["kind","id"]) && author["kind"]=="user_authorized_agent_review" && author["id"]=="codex"
}
fn valid_evidence(evidence: &Value) -> bool {
    exact_keys(evidence,&["reportSha256","summary"]) && digest(&evidence["reportSha256"]) && nonempty(&evidence["summary"],2000)
}
/// Call with the original canonical source response, never an already-derived
/// object. The audit field is reserved; identical original input is deterministic.
pub(super) fn apply(raw: &Value, record: &Value, document: &OcrDocument) -> AppResult<Value> {
    if let Some(approvals)=record["sourceStructuring"].get("assetBindingApprovals") {
        if approvals.as_array().is_none_or(|a|a.len()>240 || a.iter().any(|v|!v.is_object()
            || !nonempty(&v["questionId"],200) || !digest(&v["originalQuestionSha256"])
            || !digest(&v["assetSha256"]) || !valid_author(&v["author"]) || !valid_evidence(&v["reviewEvidence"]))) {
            return Err(err("source_asset_binding_stale","已保存素材位置批准清单损坏，未忽略或改为模型付费重试。"));
        }
    }
    let mut derived=super::material_reviews::apply_tables(raw,record,document)?;
    let questions=derived["questions"].as_array_mut().ok_or_else(||bad("来源题目数组缺失。"))?;
    for question in questions {
        if question.get("sourceAssetBindingAudit").is_some() {return Err(bad("sourceAssetBindingAudit是程序保留字段，不能由来源模型提供。"));}
        let mut original=question.clone();original.as_object_mut().unwrap().remove("sourceMaterialReviewAudit");
        let original_hash=hash_json(&original);
        let mut placements=if let Some(value)=question.get("assetPlacements") {
            value.as_array().filter(|a|a.len()<=32).cloned().ok_or_else(||bad("素材位置清单必须为有限数组。"))?
                .into_iter().map(|p|(p,Value::Null)).collect::<Vec<_>>()
        } else {vec![]};
        for approval in rows(&record["sourceStructuring"]["assetBindingApprovals"]) {
            if approval["questionId"]!=question["questionId"] {continue;}
            if approval["originalQuestionSha256"]!=original_hash
                || approval["sourceSha256"]!=record["source"]["sha256"]
                || approval["manifestSha256"]!=record["ocrSource"]["manifestSha256"]
                || !valid_author(&approval["author"]) || !valid_evidence(&approval["reviewEvidence"]) {
                return Err(err("source_asset_binding_stale","素材位置批准与当前原题／来源证据不一致，未应用。"));
            }
            let placement=approval["placement"].clone();
            let approved_asset=verified_asset(&placement,question,document)
                .map_err(|e|err("source_asset_binding_stale",&e.message))?;
            let role=s(&placement,"role");let id=s(&placement,"assetId");
            let other=if role=="student" {"teacher"} else {"student"};
            if referenced(question,other,id) {
                return Err(err("source_asset_binding_stale","已批准素材与原题学生／教师引用边界冲突。"));
            }
            if referenced(question,role,id) {
                let mut location=question.clone();
                let target=target_mut(&mut location,&placement["target"])
                    .map_err(|e|err("source_asset_binding_stale",&e.message))?;
                if !reference_in_text(target.as_str().unwrap(),id) {
                    return Err(err("source_asset_binding_stale","已批准素材目标与原题现有引用位置冲突。"));
                }
            }
            if approval["assetSha256"]!=approved_asset["sha256"] {
                return Err(err("source_asset_binding_stale","素材位置批准的原图哈希已变化。"));
            }
            if let Some((existing,_))=placements.iter().find(|(p,_)|p["assetId"]==placement["assetId"]) {
                if existing!=&placement {return Err(err("source_asset_binding_stale","人工批准与当前模型素材位置冲突。"));}
                continue;
            }
            placements.push((placement,approval));
        }
        let mut bound=vec![];
        let mut seen=BTreeSet::new();
        for (placement,approval) in placements {
            let binding_error=|message:&str| if approval.is_object() {err("source_asset_binding_stale",message)} else {bad(message)};
            if !seen.insert(s(&placement,"assetId").to_owned()) {return Err(binding_error("同一题的素材位置重复或跨角色冲突。"));}
            let asset=verified_asset(&placement,question,document).map_err(|e|binding_error(&e.message))?;
            if approval.is_object() && approval["assetSha256"]!=asset["sha256"] {return Err(err("source_asset_binding_stale","素材位置批准的原图哈希已变化。"));}
            let role=s(&placement,"role");let id=s(&placement,"assetId");
            let other=if role=="student" {"teacher"} else {"student"};
            if referenced(question,other,id) {return Err(binding_error("同一素材已出现在相反角色，未跨学生／教师边界追加。"));}
            let present=referenced(question,role,id);
            if present {
                let mut location=question.clone();
                let target=target_mut(&mut location,&placement["target"]).map_err(|e|binding_error(&e.message))?;
                if !reference_in_text(target.as_str().unwrap(),id) {
                    return Err(binding_error("素材已有引用位置与明确指定的目标字段冲突，未移动或重复追加。"));
                }
            }
            if !present {
                let target=target_mut(question,&placement["target"]).map_err(|e|binding_error(&e.message))?;
                let old=target.as_str().unwrap();
                *target=json!(format!("{}{}![原卷配图](asset:{id})",old,if old.is_empty(){""}else{"\n\n"}));
            }
            bound.push(json!({"placement":placement,"assetSha256":asset["sha256"],
                "action":if present{"already_referenced"}else{"appended"},
                "origin":if approval.is_object(){"explicit_review"}else{"model_placement"},
                "approvalSha256":if approval.is_object(){json!(hash_json(&approval))}else{Value::Null}}));
        }
        if !bound.is_empty() {
            question["sourceAssetBindingAudit"]=json!({"version":1,"questionId":question["questionId"],"originalQuestionSha256":original_hash,
                "sourceSha256":record["source"]["sha256"],"manifestSha256":record["ocrSource"]["manifestSha256"],"bindings":bound});
        }
    }
    Ok(derived)
}

/// Developer-tools caller must supply an explicit reviewed placement. This
/// persists authorization only; it does not mutate questions, clear failures,
/// publish, invoke models, or synthesize source content.
pub(super) fn save_review(store: &Store, payload: &Value) -> AppResult<Value> {
    let op=operation(payload)?;let payload_hash=hash_json(payload);
    let mut record=store.document("imports",s(payload,"importId"))?;
    if replay(&record,op,&payload_hash)? {
        let approval=rows(&record["sourceStructuring"]["assetBindingApprovals"]).into_iter().find(|a|a["operationId"]==op).ok_or_else(changed)?;
        return Ok(json!({"import":record,"approval":approval}));
    }
    revision(&record,payload)?;
    if record["status"]!="failed" || !record["sourceStructuring"].is_object()
        || !digest(&payload["responseSha256"]) || !nonempty(&payload["questionId"],200)
        || !payload["expectedStem"].is_string() || !valid_author(&payload["author"])
        || !valid_evidence(&payload["reviewEvidence"]) {
        return Err(bad("仅允许对失败来源记录、明确原响应及已独立核对的精确素材位置保存批准。"));
    }
    let original=record.clone();
    let document=paddle::load_document(store,&record)?;
    let plan=normalize_plan(&record["sourceStructuring"]["plan"],&document)?;
    let mut found=None;
    for batch in rows(&record["sourceStructuring"]["batches"]) {
        for attempt in rows(&batch["attempts"]).into_iter().rev() {
            if attempt["audit"]["responseSha256"]!=payload["responseSha256"] {continue;}
            let raw=actual_result(store,&attempt,"question_import",&record)?;
            validate_result(&raw,&plan,&batch,s(&record,"importId"),&document_material_blocks(&plan,&document))?;
            let canonical=canonical_source_contract(&raw)?;
            for question in rows(&canonical["questions"]) {
                if question["questionId"]==payload["questionId"] {
                    if found.as_ref().is_some_and(|old:&Value|old!=&question) {return Err(bad("原响应定位到冲突题目。"));}
                    found=Some(question);
                }
            }
        }
    }
    let question=found.ok_or_else(||bad("没有找到与所选原响应哈希绑定的真实题目。"))?;
    let question_hash=hash_json(&question);
    if question["stem"]!=payload["expectedStem"]
        || payload.get("expectedOriginalQuestionSha256").is_some_and(|v|v!=&json!(question_hash)) {
        return Err(err("source_asset_binding_stale","所核对题干或题目哈希已变化，未保存批准。"));
    }
    let asset=verified_asset(&payload["placement"],&question,&document)?;
    let approval=json!({"version":1,"operationId":op,"questionId":question["questionId"],"originalQuestionSha256":question_hash,
        "sourceSha256":record["source"]["sha256"],"manifestSha256":record["ocrSource"]["manifestSha256"],"responseSha256":payload["responseSha256"],
        "assetSha256":asset["sha256"],"placement":payload["placement"],"author":payload["author"],"reviewEvidence":payload["reviewEvidence"]});
    let mut approvals=rows(&record["sourceStructuring"]["assetBindingApprovals"]);
    if approvals.iter().any(|a|a["questionId"]==approval["questionId"] && a["placement"]["assetId"]==approval["placement"]["assetId"]) {
        return Err(bad("当前题目及素材已有位置批准，未覆盖或追加冲突授权。"));
    }
    approvals.push(approval.clone());
    record["sourceStructuring"]["assetBindingApprovals"]=json!(approvals);
    // Reuse exactly the same boundary as normal source intake. This also rejects
    // model-placement conflicts and teacher-to-student leakage before saving.
    apply(&json!({"questions":[question]}),&record,&document)?;
    finish(&mut record,op,&payload_hash,"source_asset_binding_review");
    save_cas(store,Some(&original),&record)?;
    Ok(json!({"import":record,"approval":approval}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    fn fixture() -> (Value,Value,OcrDocument) {
        let mut png=Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(12,16).write_to(&mut png,image::ImageFormat::Png).unwrap();
        let bytes=png.into_inner();
        let asset=json!({"id":"real-crop-1","page":1,"role":"figure","sha256":sha(&bytes),"contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes),"width":12,"height":16,"bbox":[1,2,3,4]});
        let document=OcrDocument{pages:vec![json!({"page":1,"blocks":[{"id":1,"assetId":"real-crop-1","bbox":[1,2,3,4]}]})],assets:vec![asset],issues:vec![]};
        let q=json!({"questionId":"q1","sourceLabel":"5","questionType":"single_choice","pages":[1],"sourceBlockIds":["p1-b1"],"stem":"函数图像如图。","options":[{"label":"A","text":"a"},{"label":"B","text":"b"}],"parts":[{"partId":"p1","label":"(1)","prompt":"求值","answer":"","solution":""}],"answer":"","solution":"","materialRoles":[{"assetId":"real-crop-1","role":"student","sourceBlockIds":["p1-b1"],"basis":"原题函数图"}]});
        let record=json!({"source":{"sha256":"source-hash"},"ocrSource":{"manifestSha256":"manifest-hash"},"sourceStructuring":{}});
        (q,record,document)
    }
    fn copy_document(d:&OcrDocument)->OcrDocument {OcrDocument{pages:d.pages.clone(),assets:d.assets.clone(),issues:d.issues.clone()}}
    fn placement(field:&str) -> Value {json!({"assetId":"real-crop-1","role":"student","target":{"field":field},"sourceBlockIds":["p1-b1"],"basis":"原题明确配图"})}
    fn approve(q:&Value,record:&mut Value,document:&OcrDocument,p:Value) {
        record["sourceStructuring"]["assetBindingApprovals"]=json!([{"questionId":q["questionId"],"originalQuestionSha256":hash_json(q),"sourceSha256":record["source"]["sha256"],"manifestSha256":record["ocrSource"]["manifestSha256"],"assetSha256":document.assets[0]["sha256"],"placement":p,"author":{"kind":"user_authorized_agent_review","id":"codex"},"reviewEvidence":{"reportSha256":"a".repeat(64),"summary":"模拟独立原页核对"}}]);
    }
    #[test]
    fn explicit_model_placement_appends_only_target_and_preserves_raw() {
        let (mut q,record,document)=fixture();q["assetPlacements"]=json!([placement("stem")]);
        let raw=json!({"questions":[q]});let before=raw.clone();
        let result=apply(&raw,&record,&document).unwrap();
        assert_eq!(raw,before);
        assert_eq!(result["questions"][0]["options"],raw["questions"][0]["options"]);
        assert!(s(&result["questions"][0],"stem").ends_with("![原卷配图](asset:real-crop-1)"));
        assert_eq!(result,apply(&raw,&record,&document).unwrap());
        assert_eq!(result["questions"][0]["sourceAssetBindingAudit"]["originalQuestionSha256"],hash_json(&raw["questions"][0]));
    }
    #[test]
    fn already_referenced_same_role_is_not_duplicated_and_other_role_is_rejected() {
        let (mut q,record,document)=fixture();q["stem"]=json!("函数图像如图。![原图](asset:real-crop-1)");q["assetPlacements"]=json!([placement("stem")]);
        let result=apply(&json!({"questions":[q.clone()]}),&record,&document).unwrap();
        assert_eq!(result["questions"][0]["stem"],q["stem"]);
        assert_eq!(result["questions"][0]["sourceAssetBindingAudit"]["bindings"][0]["action"],"already_referenced");
        q["solution"]=json!("![原图](asset:real-crop-1)");
        assert!(apply(&json!({"questions":[q]}),&record,&document).is_err());
    }
    #[test]
    fn explicit_approval_is_hash_bound_and_cannot_conflict_with_model() {
        let (q,mut record,document)=fixture();approve(&q,&mut record,&document,placement("stem"));
        let result=apply(&json!({"questions":[q.clone()]}),&record,&document).unwrap();
        assert_eq!(result["questions"][0]["sourceAssetBindingAudit"]["bindings"][0]["origin"],"explicit_review");
        for field in ["originalQuestionSha256","sourceSha256","manifestSha256","assetSha256"] {
            let mut stale=record.clone();stale["sourceStructuring"]["assetBindingApprovals"][0][field]=json!("changed");
            assert!(apply(&json!({"questions":[q.clone()]}),&stale,&document).is_err());
        }
        let mut model=q.clone();model["assetPlacements"]=json!([{"assetId":"real-crop-1","role":"student","target":{"field":"option","label":"A"},"sourceBlockIds":["p1-b1"],"basis":"不同位置"}]);
        // Freeze the now-current question hash to exercise conflict, not staleness.
        approve(&model,&mut record,&document,placement("stem"));
        assert!(apply(&json!({"questions":[model]}),&record,&document).is_err());
    }
    #[test]
    fn bad_owners_targets_hashes_and_provider_audits_never_bind() {
        let (q,record,document)=fixture();
        for p in [json!({"assetId":"wrong","role":"student","target":{"field":"stem"},"sourceBlockIds":["p1-b1"],"basis":"x"}),
            json!({"assetId":"real-crop-1","role":"teacher","target":{"field":"stem"},"sourceBlockIds":["p1-b1"],"basis":"x"}),
            json!({"assetId":"real-crop-1","role":"student","target":{"field":"option","label":"Z"},"sourceBlockIds":["p1-b1"],"basis":"x"}),
            json!({"assetId":"real-crop-1","role":"student","target":{"field":"partPrompt","partId":"missing"},"sourceBlockIds":["p1-b1"],"basis":"x"}),
            json!({"assetId":"real-crop-1","role":"student","target":{"field":"stem","partId":"p1"},"sourceBlockIds":["p1-b1"],"basis":"x"}),
            json!({"assetId":"real-crop-1","role":"student","target":{"field":"stem"},"sourceBlockIds":["p1-b999"],"basis":"x"})] {
            let mut raw=q.clone();raw["assetPlacements"]=json!([p]);assert!(apply(&json!({"questions":[raw]}),&record,&document).is_err());
        }
        let mut raw=q.clone();raw["assetPlacements"]=json!([placement("stem"),placement("stem")]);assert!(apply(&json!({"questions":[raw]}),&record,&document).is_err());
        let mut raw=q.clone();raw["sourceAssetBindingAudit"]=json!({});assert!(apply(&json!({"questions":[raw]}),&record,&document).is_err());
        let mut raw=q.clone();raw["assetPlacements"]=json!([placement("stem")]);
        let mut altered=copy_document(&document);altered.assets[0]["sha256"]=json!("b".repeat(64));assert!(apply(&json!({"questions":[raw.clone()]}),&record,&altered).is_err());
        altered=copy_document(&document);altered.assets[0]["role"]=json!("source_page");assert!(apply(&json!({"questions":[raw.clone()]}),&record,&altered).is_err());
        raw["pages"]=json!([2]);assert!(apply(&json!({"questions":[raw]}),&record,&document).is_err());
    }
    #[test]
    fn exact_option_part_and_teacher_targets_keep_role_boundaries() {
        let (q,record,document)=fixture();
        for target in [json!({"field":"option","label":"B"}),json!({"field":"partPrompt","partId":"p1"})] {
            let mut raw=q.clone();let mut p=placement("stem");p["target"]=target.clone();raw["assetPlacements"]=json!([p]);
            let out=apply(&json!({"questions":[raw]}),&record,&document).unwrap();
            assert_eq!(out["questions"][0]["stem"],q["stem"]);
            assert!(target_mut(&mut out["questions"][0].clone(),&target).unwrap().as_str().unwrap().contains("asset:real-crop-1"));
        }
        for field in ["answer","solution","partAnswer","partSolution"] {
            let mut raw=q.clone();raw["materialRoles"][0]["role"]=json!("teacher");
            let target=if field.starts_with("part") {json!({"field":field,"partId":"p1"})}else{json!({"field":field})};
            let mut p=placement("stem");p["target"]=target;p["role"]=json!("teacher");raw["assetPlacements"]=json!([p]);
            let out=apply(&json!({"questions":[raw]}),&record,&document).unwrap();assert_eq!(out["questions"][0]["stem"],q["stem"]);
        }
    }
    fn saved_fixture() -> (tempfile::TempDir,Store,Value,Value,Vec<u8>,PathBuf) {
        let (mut question,mut record,document)=fixture();
        let dir=tempfile::tempdir().unwrap();
        let store=Store::open(dir.path(),&crate::bank::tests::seed()).unwrap();
        let id="simulated-explicit-asset-binding";
        let root=store.data_dir.join("imports").join(id);std::fs::create_dir_all(&root).unwrap();
        let root=root.canonicalize().unwrap();
        let ocr=root.join("ocr");std::fs::create_dir(&ocr).unwrap();
        record["importId"]=json!(id);record["revision"]=json!(0);record["status"]=json!("failed");
        record["questions"]=json!([]);record["operations"]=json!([]);
        question["questionId"]=json!(format!("{id}-q1"));
        paddle::save_document(&store,&mut record,&document,&ocr,json!({"simulation":true})).unwrap();
        let plan=json!({"questions":[{"sourceLabel":"5","questionType":"single_choice","sourceBlockIds":["p1-b1"]}],"sharedBlockIds":[],"documentBlockIds":[]});
        let scope=json!({"index":0,"expectedQuestions":[{"questionId":question["questionId"],"sourceLabel":"5","questionType":"single_choice","sourceBlockIds":["p1-b1"]}]});
        let context=json!({"sourceSha256":record["source"]["sha256"],"sourceManifestSha256":record["ocrSource"]["manifestSha256"],"sourceBatch":scope});
        let body=json!({"model":"simulated-original-provider","messages":[{"role":"system","content":"simulated immutable source request"},{"role":"user","content":context.to_string()}]});
        let request=json!({"task":"question_import","redacted":false,"bodySha256":hash_json(&body),"promptSha256":hash_json(&body["messages"][0]["content"]),"body":body});
        let response=json!({"httpStatus":200,"choices":[{"finish_reason":"stop","message":{"content":json!({"questions":[question.clone()]}).to_string()}}]});
        let path=root.join("original.response.json");let bytes=serde_json::to_vec(&response).unwrap();
        std::fs::write(&path,&bytes).unwrap();std::fs::write(path.with_extension("request.json"),serde_json::to_vec(&request).unwrap()).unwrap();
        let attempt=json!({"operationId":"simulated-original-source","status":"failed","scopeHash":hash_json(&context["sourceBatch"]),"audit":audit_files(&store,&path).unwrap()});
        record["sourceStructuring"]=json!({"plan":plan,"batches":[{"index":0,"start":0,"end":1,"status":"failed","attempts":[attempt]}]});
        store.put_document("imports",id,&record).unwrap();
        let payload=json!({"importId":id,"expectedRevision":0,"operationId":"simulated-authorized-placement","questionId":question["questionId"],"responseSha256":sha(&bytes),"expectedStem":question["stem"],"placement":placement("stem"),"author":{"kind":"user_authorized_agent_review","id":"codex"},"reviewEvidence":{"reportSha256":"a".repeat(64),"summary":"模拟原页独立核对：唯一函数图属于第5题题干。"}});
        (dir,store,record,payload,bytes,path)
    }
    #[test]
    fn explicit_save_is_cas_idempotent_reboot_bound_and_never_mutates_raw_or_failure() {
        let (dir,store,record,payload,bytes,path)=saved_fixture();
        let saved=save_review(&store,&payload).unwrap();
        assert_eq!(saved["import"]["status"],"failed");assert_eq!(saved["import"]["questions"],json!([]));
        assert_eq!(saved["import"]["sourceStructuring"]["batches"],record["sourceStructuring"]["batches"]);
        assert_eq!(saved["import"]["revision"],1);assert_eq!(std::fs::read(&path).unwrap(),bytes);
        assert_eq!(save_review(&store,&payload).unwrap(),saved);
        let mut conflict=payload.clone();conflict["placement"]["target"]=json!({"field":"option","label":"A"});
        assert_eq!(save_review(&store,&conflict).unwrap_err().code,"operation_conflict");
        let root=dir.path().to_path_buf();drop(store);
        let reopened=Store::open(&root,&crate::bank::tests::seed()).unwrap();
        assert_eq!(save_review(&reopened,&payload).unwrap(),saved);
        let restored=reopened.document("imports",s(&record,"importId")).unwrap();
        let d=paddle::load_document(&reopened,&restored).unwrap();
        let attempt=&restored["sourceStructuring"]["batches"][0]["attempts"][0];
        let raw=canonical_source_contract(&actual_result(&reopened,attempt,"question_import",&restored).unwrap()).unwrap();
        let derived=apply(&raw,&restored,&d).unwrap();assert!(s(&derived["questions"][0],"stem").contains("asset:real-crop-1"));
        let mut changed=restored.clone();changed["sourceStructuring"]["assetBindingApprovals"][0]["originalQuestionSha256"]=json!("b".repeat(64));
        assert!(apply(&raw,&changed,&d).is_err());
        let mut stale=payload.clone();stale["operationId"]=json!("simulated-stale-second-save");
        assert_eq!(save_review(&reopened,&stale).unwrap_err().code,"revision_conflict");
        let mut tampered=bytes.clone();tampered.push(b' ');std::fs::write(&path,tampered).unwrap();
        let mut fresh=payload.clone();fresh["operationId"]=json!("simulated-tampered-evidence");fresh["expectedRevision"]=json!(1);
        assert_eq!(save_review(&reopened,&fresh).unwrap_err().code,"source_checkpoint_changed");
    }
    #[test]
    fn explicit_save_rejects_wrong_stem_or_response_without_writing_record() {
        let (_dir,store,record,payload,_bytes,_path)=saved_fixture();
        for field in ["expectedStem","responseSha256"] {
            let mut invalid=payload.clone();invalid[field]=json!(if field=="responseSha256" {"b".repeat(64)}else{"different original stem".to_owned()});
            assert!(save_review(&store,&invalid).is_err());
            assert_eq!(store.document("imports",s(&record,"importId")).unwrap(),record);
        }
    }

    #[test]
    fn same_question_figure_caption_is_allowed_but_foreign_question_caption_is_rejected() {
        let (mut q,record,mut document)=fixture();
        document.pages[0]["blocks"].as_array_mut().unwrap().extend([json!({"id":2,"type":"text","text":"第5题图","bbox":[1,5,3,6]}),json!({"id":3,"type":"text","text":"另一题说明","bbox":[5,5,7,6]})]);
        q["sourceBlockIds"]=json!(["p1-b1","p1-b2"]);
        q["materialRoles"][0]["sourceBlockIds"]=json!(["p1-b1","p1-b2"]);
        let mut p=placement("stem");p["sourceBlockIds"]=json!(["p1-b1","p1-b2"]);q["assetPlacements"]=json!([p]);
        assert!(apply(&json!({"questions":[q.clone()]}),&record,&document).is_ok());
        q["assetPlacements"][0]["sourceBlockIds"]=json!(["p1-b1","p1-b3"]);
        q["materialRoles"][0]["sourceBlockIds"]=json!(["p1-b1","p1-b3"]);
        assert!(apply(&json!({"questions":[q]}),&record,&document).is_err());
    }

    #[test]
    fn already_inline_asset_must_match_exact_authorized_option_target() {
        let (mut q,record,document)=fixture();q["options"][0]["text"]=json!("a ![原图](asset:real-crop-1)");
        let mut p=placement("stem");p["target"]=json!({"field":"option","label":"A"});q["assetPlacements"]=json!([p]);
        let raw=json!({"questions":[q.clone()]});let result=apply(&raw,&record,&document).unwrap();
        assert_eq!(result["questions"][0]["options"],q["options"]);
        assert_eq!(result["questions"][0]["sourceAssetBindingAudit"]["originalQuestionSha256"],hash_json(&q));
        assert_eq!(result,apply(&raw,&record,&document).unwrap());
        q["assetPlacements"][0]["target"]["label"]=json!("B");assert!(apply(&json!({"questions":[q.clone()]}),&record,&document).is_err());
        q["assetPlacements"][0]["target"]=json!({"field":"stem"});assert!(apply(&json!({"questions":[q]}),&record,&document).is_err());
    }

    #[test]
    fn corrupt_explicit_approval_is_hard_stale_not_retryable_model_output() {
        let (q,mut record,document)=fixture();
        for approvals in [json!({"corrupt":"not an array"}),json!(["invalid entry"])] {
            record["sourceStructuring"]["assetBindingApprovals"]=approvals;
            assert_eq!(apply(&json!({"questions":[q.clone()]}),&record,&document).unwrap_err().code,"source_asset_binding_stale");
        }
        let mut p=placement("stem");p["target"]=json!({"field":"option","label":"Z"});
        approve(&q,&mut record,&document,p);
        assert_eq!(apply(&json!({"questions":[q.clone()]}),&record,&document).unwrap_err().code,"source_asset_binding_stale");
        let mut q=q;q["solution"]=json!("![原图](asset:real-crop-1)");approve(&q,&mut record,&document,placement("stem"));
        assert_eq!(apply(&json!({"questions":[q]}),&record,&document).unwrap_err().code,"source_asset_binding_stale");
    }

}
