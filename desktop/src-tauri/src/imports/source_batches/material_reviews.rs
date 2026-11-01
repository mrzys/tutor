//! Explicit, source-bound visual reviews. These receipts do not change OCR,
//! model output or successful checkpoints, and never infer a material's role.
use super::*;

fn bad(message:&str)->AppError{err("source_material_review_invalid",message)}
fn stale(message:&str)->AppError{err("source_material_review_stale",message)}
fn digest(v:&Value)->bool{v.as_str().is_some_and(|s|s.len()==64&&s.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)))}
fn exact(v:&Value,keys:&[&str])->bool{v.as_object().is_some_and(|o|o.len()==keys.len()&&keys.iter().all(|k|o.contains_key(*k)))}
fn author(v:&Value)->bool{exact(v,&["kind","id"])&&v["kind"]=="user_authorized_agent_review"&&v["id"]=="codex"}
fn evidence(v:&Value)->bool{exact(v,&["reportSha256","summary"])&&digest(&v["reportSha256"])&&v["summary"].as_str().is_some_and(|s|!s.trim().is_empty()&&s.chars().count()<=2000&&!s.chars().any(char::is_control))}
fn block<'a>(document:&'a OcrDocument,page:&Value,id:&str,omitted:bool)->AppResult<&'a Value>{
    let pages=document.pages.iter().filter(|p|p["page"]==*page).collect::<Vec<_>>();
    if pages.len()!=1{return Err(stale("来源审核页身份不唯一。"));}
    let key=if omitted{"omittedBlocks"}else{"blocks"};
    let blocks=pages[0][key].as_array().ok_or_else(||stale("来源审核原文块不存在。"))?;
    let found=blocks.iter().filter(|b|format!("p{}-b{}",page,b["id"])==id).collect::<Vec<_>>();
    if found.len()!=1{return Err(stale("来源审核原文块不存在或不唯一。"));}Ok(found[0])
}
fn valid_bytes(asset:&Value)->AppResult<()>{
    let encoded=s(asset,"contentBase64");if encoded.len()>20*1024*1024/3*4+4{return Err(stale("审核素材超过大小上限。"));}
    let bytes=base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_|stale("审核素材编码损坏。"))?;
    if bytes.is_empty()||sha(&bytes)!=s(asset,"sha256"){return Err(stale("审核素材哈希不一致。"));}Ok(())
}
fn table_shape(details:&Value,asset:&Value,d:&OcrDocument)->AppResult<Value>{
    if !exact(details,&["questionId","responseSha256","originalQuestionSha256","role","sourceBlockId","sourceBlockSha256","originalTableHtml","approvedTableHtml","cellCorrections"])
        || !digest(&details["responseSha256"])||!digest(&details["originalQuestionSha256"])||!digest(&details["sourceBlockSha256"])
        || !matches!(s(details,"role"),"student"|"teacher")||s(details,"questionId").is_empty()
        || s(details,"originalTableHtml").chars().count()>40000||s(details,"approvedTableHtml").chars().count()>40000||asset["role"]!="table"{
        return Err(stale("表格来源更正字段或身份无效。"));
    }
    let original=block(d,&asset["page"],s(details,"sourceBlockId"),false)?;
    if original["type"]!="table"||original["bbox"]!=asset["bbox"]||hash_json(original)!=s(details,"sourceBlockSha256")||original["text"]!=details["originalTableHtml"]{
        return Err(stale("表格来源更正与原OCR块不一致。"));
    }
    let old=paddle::tables(s(details,"originalTableHtml"));let new=paddle::tables(s(details,"approvedTableHtml"));
    if old.len()!=1||new.len()!=1||old[0].is_empty()||old[0].len()!=new[0].len(){return Err(stale("表格更正须保留完整唯一网格。"));}
    let changes=details["cellCorrections"].as_array().filter(|c|!c.is_empty()&&c.len()<=8).ok_or_else(||stale("表格更正须逐格明确列出有限差异。"))?;
    let mut expected=old[0].clone();let mut seen=BTreeSet::new();
    for change in changes{
        if !exact(change,&["row","column","old","new"]){return Err(stale("表格逐格更正格式无效。"));}
        let row=change["row"].as_u64().and_then(|v|usize::try_from(v).ok()).ok_or_else(||stale("表格更正行号无效。"))?;
        let col=change["column"].as_u64().and_then(|v|usize::try_from(v).ok()).ok_or_else(||stale("表格更正列号无效。"))?;
        if !seen.insert((row,col)){return Err(stale("表格更正位置重复。"));}
        let cell=expected.get_mut(row).and_then(|r|r.get_mut(col)).ok_or_else(||stale("表格更正位置越界。"))?;
        let normalize_cell=|v:&Value|->AppResult<String>{
            let text=v.as_str().filter(|s|s.chars().count()<=4000).ok_or_else(||stale("表格更正文字无效。"))?;
            let grid=paddle::tables(&format!("<table><tr><td>{text}</td></tr></table>"));
            if grid.len()!=1||grid[0].len()!=1||grid[0][0].len()!=1{return Err(stale("表格逐格更正不能插入额外行列。"));}
            Ok(grid[0][0][0].2.clone())
        };
        let old=normalize_cell(&change["old"])?;let new=normalize_cell(&change["new"])?;
        if old!=cell.2||old==new{return Err(stale("表格更正原文或差异不一致。"));}cell.2=new;
    }
    if expected!=new[0]{return Err(stale("表格更正含未授权的内容、行列、空格或合并格变化。"));}
    Ok(json!(&new[0]))
}
fn document_crop(details:&Value,asset:&Value,d:&OcrDocument)->AppResult<()>{
    let keys=if details.get("providerPathEvidence").is_some(){vec!["sourcePageAssetId","sourcePageSha256","sourceBlockId","sourceBlockSha256","sourceImageBbox","providerPathEvidence"]}else{vec!["sourcePageAssetId","sourcePageSha256","sourceBlockId","sourceBlockSha256","sourceImageBbox"]};
    if !exact(details,&keys)
        ||!digest(&details["sourcePageSha256"])||!digest(&details["sourceBlockSha256"]){return Err(stale("非题素材来源核对字段无效。"));}
    let p=d.pages.iter().find(|p|p["page"]==asset["page"]).ok_or_else(||stale("核对原页不存在。"))?;
    let original=block(d,&asset["page"],s(details,"sourceBlockId"),true)
        .or_else(|_|block(d,&asset["page"],s(details,"sourceBlockId"),false))?;
    if hash_json(original)!=s(details,"sourceBlockSha256")||original["bbox"]!=details["sourceImageBbox"]
        ||p["coordinateTransform"]["kind"]!="identity"{return Err(stale("非题素材的原布局或坐标证据已变化。"));}
    let pages=d.assets.iter().filter(|a|a["id"]==details["sourcePageAssetId"]&&a["role"]=="source_page"&&a["page"]==asset["page"]&&a["sha256"]==details["sourcePageSha256"]).collect::<Vec<_>>();
    if pages.len()!=1{return Err(stale("非题素材核对的唯一原页不存在。"));}
    if !paddle::exact_source_crop(asset,pages[0],&details["sourceImageBbox"])?{
        // Old normalizers downloaded a JPEG fallback while the source-page PNG
        // was encoded separately. Do not weaken pixel equality. Replay the
        // provider's exact path assignment only when its old loop has a unique
        // unconsumed path and a unique unpositioned saved asset.
        if original["type"]!="footer_image"||!provider_mapping(details,asset,d)?{
            return Err(stale("非题素材缺少相等像素或唯一原provider路径证据，未按位置、大小或同页猜测归属。"));
        }
    }
    Ok(())
}
fn provider_mapping(details:&Value,asset:&Value,d:&OcrDocument)->AppResult<bool>{
    let p=&details["providerPathEvidence"];
    if !exact(p,&["resultRelativePath","resultSha256","sourceImagePath","layoutIndex","imagePaths"])
        ||!digest(&p["resultSha256"])||s(p,"resultRelativePath").len()>2000||s(p,"sourceImagePath").len()>2000
        ||p["layoutIndex"].as_u64().and_then(|n|n.checked_add(1))!=asset["page"].as_u64(){return Ok(false);}
    let paths=p["imagePaths"].as_array().filter(|v|!v.is_empty()&&v.len()<=500).ok_or_else(||stale("原provider图片路径清单无效。"))?;
    let bbox_path=regex::Regex::new(r"(?:^|/)img_in_(?:footer_image|image|chart|table)_box_([0-9]+)_([0-9]+)_([0-9]+)_([0-9]+)\.(?:jpg|jpeg|png)$").unwrap();
    let mut unmapped=vec![];let mut seen=BTreeSet::new();
    for path in paths{
        let Some(path)=path.as_str().filter(|v|v.len()<=2000&&seen.insert((*v).to_owned()))else{return Ok(false);};
        let Some(c)=bbox_path.captures(path)else{return Ok(false);};
        let coords=(1..=4).map(|i|c[i].parse::<u64>().ok()).collect::<Option<Vec<_>>>();let Some(coords)=coords else{return Ok(false);};
        if !d.assets.iter().any(|a|a["page"]==asset["page"]&&a["role"]!="source_page"&&a["bbox"].is_array()&&a["bbox"]==json!(coords)){
            unmapped.push((path,json!(coords)));
        }
    }
    let unpositioned=d.assets.iter().filter(|a|a["page"]==asset["page"]&&a["role"]!="source_page"&&!a["bbox"].is_array()).collect::<Vec<_>>();
    Ok(unmapped.len()==1&&unmapped[0].0==s(p,"sourceImagePath")&&unmapped[0].1==details["sourceImageBbox"]
        &&unpositioned.len()==1&&unpositioned[0]["id"]==asset["id"]&&asset["role"]=="figure"
        &&s(asset,"id")==format!("ocr-p{}-figure-{}",asset["page"],&s(asset,"sha256")[..20]))
}
fn contained_crop(details:&Value,asset:&Value,d:&OcrDocument)->AppResult<()>{
    if !exact(details,&["questionId","originalQuestionSha256","role","target","representedByAssetId","representedByAssetSha256","sourcePageAssetId","sourcePageSha256","sourceBlockId","sourceBlockSha256","sourceImageBbox","representativeSourceImageBbox","providerPathEvidence"])
        ||!digest(&details["originalQuestionSha256"])||!digest(&details["representedByAssetSha256"])||!digest(&details["sourcePageSha256"])||!digest(&details["sourceBlockSha256"])
        ||details["role"]!="student"||asset_bindings::target_role(&details["target"])?!="student"||s(details,"questionId").is_empty(){return Err(stale("局部素材审核的来源、角色或呈现目标无效。"));}
    let matching=d.assets.iter().filter(|a|a["id"]==details["representedByAssetId"]&&a["sha256"]==details["representedByAssetSha256"]&&a["role"]=="figure"&&a["page"]==asset["page"]).collect::<Vec<_>>();
    if matching.len()!=1||matching[0]["bbox"]!=details["representativeSourceImageBbox"]||matching[0]["id"]==asset["id"]{return Err(stale("局部素材对应的原题图不存在或身份／坐标已变化。"));}
    let original=block(d,&asset["page"],s(details,"sourceBlockId"),false)?;
    let page=d.pages.iter().find(|p|p["page"]==asset["page"]).ok_or_else(||stale("局部素材原页不存在。"))?;
    if hash_json(original)!=s(details,"sourceBlockSha256")||original["bbox"]!=matching[0]["bbox"]||original["assetId"]!=matching[0]["id"]||page["coordinateTransform"]["kind"]!="identity"{
        return Err(stale("局部素材对应的真实题图块或坐标依据不一致。"));
    }
    let coords=|v:&Value|->Option<Vec<u64>>{let a=v.as_array().filter(|a|a.len()==4)?;a.iter().map(Value::as_u64).collect()};
    let inner=coords(&details["sourceImageBbox"]).ok_or_else(||stale("局部素材原provider区域无效。"))?;
    let outer=coords(&details["representativeSourceImageBbox"]).ok_or_else(||stale("代表图原页区域无效。"))?;
    if inner[0]>=inner[2]||inner[1]>=inner[3]||outer[0]>=outer[2]||outer[1]>=outer[3]
        ||inner[0]<outer[0]||inner[1]<outer[1]||inner[2]>outer[2]||inner[3]>outer[3]||inner==outer{
        return Err(stale("局部素材并非严格位于已呈现原题图内，未按邻近关系猜测。"));
    }
    let pages=d.assets.iter().filter(|a|a["id"]==details["sourcePageAssetId"]&&a["role"]=="source_page"&&a["sha256"]==details["sourcePageSha256"]&&a["page"]==asset["page"]).collect::<Vec<_>>();
    if pages.len()!=1||!paddle::exact_source_crop(matching[0],pages[0],&details["representativeSourceImageBbox"])?||!provider_mapping(details,asset,d)?{
        return Err(stale("局部素材缺少唯一原provider路径或代表题图的精确原页PNG证据。"));
    }Ok(())
}
/// Recheck the immutable provider result before every normal OCR load or source
/// adoption. A copied claim or a rehashed file outside this OCR attempt is not
/// source evidence. This routine never opens a database or performs a GET.
pub(super) fn verify_saved_inputs(store:&Store,record:&Value)->AppResult<()>{
    verify_inputs_at(&store.data_dir,record)
}
fn verify_inputs_at(data_dir:&Path,record:&Value)->AppResult<()>{
    for a in approvals(record)?{
        let Some(proof)=a["details"].get("providerPathEvidence")else{continue;};
        let imports=data_dir.join("imports").canonicalize()?;
        let manifest=data_dir.join(s(&record["ocrSource"],"manifestRelativePath")).canonicalize()?;
        let requested=data_dir.join(s(proof,"resultRelativePath")).canonicalize().map_err(|_|stale("原provider结果路径不存在。"))?;
        if !requested.starts_with(&imports)||requested.parent()!=manifest.parent()||requested.file_name().and_then(|s|s.to_str())!=Some("003-result.json")
            ||std::fs::metadata(&requested)?.len()>8*1024*1024{return Err(stale("原provider路径不属于本次OCR证据目录。"));}
        let bytes=std::fs::read(requested)?;if sha(&bytes)!=s(proof,"resultSha256"){return Err(stale("原provider结果哈希已变化。"));}
        let result:Value=serde_json::from_slice(&bytes).map_err(|_|stale("原provider结果JSON损坏。"))?;
        let index=proof["layoutIndex"].as_u64().and_then(|v|usize::try_from(v).ok()).ok_or_else(||stale("原provider布局页身份无效。"))?;
        let layout=&result["response"]["result"]["layoutParsingResults"][index];
        let paths=layout["markdown"]["images"].as_object().ok_or_else(||stale("原provider图片映射缺失。"))?.keys().map(|k|json!(k)).collect::<Vec<_>>();
        let source_block=s(&a["details"],"sourceBlockId");
        let matching=rows(&layout["prunedResult"]["parsing_res_list"]).into_iter().filter(|b|format!("p{}-b{}",index+1,b["block_id"])==source_block).collect::<Vec<_>>();
        let contained=a["kind"]=="contained_asset";
        let expected_bbox=if contained{&a["details"]["representativeSourceImageBbox"]}else{&a["details"]["sourceImageBbox"]};
        let correct_label=matching.len()==1&&if contained{matches!(s(&matching[0],"block_label"),"image"|"chart")}else{matching[0]["block_label"]=="footer_image"};
        if result["httpStatus"]!=200||result["response"]["errorCode"]!=0||proof["imagePaths"]!=json!(paths)
            ||!paths.contains(&proof["sourceImagePath"])||!correct_label||matching[0]["block_bbox"]!=*expected_bbox{
            return Err(stale("原provider页、实际图片路径或真实布局块证据不一致。"));
        }
    }Ok(())
}
fn approvals(record:&Value)->AppResult<Vec<Value>>{
    let Some(v)=record["sourceStructuring"].get("materialReviewApprovals")else{return Ok(vec![]);};
    let list=v.as_array().filter(|v|v.len()<=240).ok_or_else(||stale("来源素材审核清单损坏。"))?;
    let mut seen=BTreeSet::new();
    for a in list{
        let known=rows(&record["ocrSource"]["assets"]).into_iter().filter(|asset|asset["id"]==a["assetId"]&&asset["sha256"]==a["assetSha256"]&&asset["role"]!="source_page").count();
        if !exact(a,&["version","operationId","kind","sourceSha256","manifestSha256","assetId","assetSha256","details","author","reviewEvidence"])
            ||a["version"]!=1||!matches!(s(a,"kind"),"table_text"|"document_asset"|"contained_asset")||s(a,"operationId").is_empty()
            ||!digest(&a["sourceSha256"])||!digest(&a["manifestSha256"])||!digest(&a["assetSha256"])
            ||a["sourceSha256"]!=record["source"]["sha256"]||a["manifestSha256"]!=record["ocrSource"]["manifestSha256"]
            ||known!=1||s(a,"assetId").is_empty()||s(a,"assetId").len()>240
            ||!author(&a["author"])||!evidence(&a["reviewEvidence"])||!seen.insert(s(a,"assetId").to_owned()){
            return Err(stale("来源素材审核身份、哈希或独立核对依据已失效。"));
        }
    }Ok(list.clone())
}
fn checked(record:&Value,d:&OcrDocument)->AppResult<Vec<(Value,Value)>>{
    let mut out=vec![];
    for approval in approvals(record)?{
        let matching=d.assets.iter().filter(|a|a["id"]==approval["assetId"]).collect::<Vec<_>>();
        // A source batch contains a strict subset. Validate this receipt in its
        // full document before saving and whenever the full import is checked.
        if matching.is_empty(){continue;}
        if matching.len()!=1||matching[0]["sha256"]!=approval["assetSha256"]||matching[0]["role"]=="source_page"{return Err(stale("已核对素材身份或哈希已变化。"));}
        valid_bytes(matching[0])?;
        let shape=match s(&approval,"kind"){
            "table_text"=>table_shape(&approval["details"],matching[0],d)?,
            "contained_asset"=>{contained_crop(&approval["details"],matching[0],d)?;Value::Null},
            _=>{document_crop(&approval["details"],matching[0],d)?;Value::Null}
        };
        out.push((approval,shape));
    }Ok(out)
}
/// Called before other derivations, so the approval is bound to the exact
/// complete canonical provider question, never a later regenerated variant.
pub(super) fn apply_tables(raw:&Value,record:&Value,d:&OcrDocument)->AppResult<Value>{
    let reviewed=checked(record,d)?;let mut derived=raw.clone();
    let q=derived["questions"].as_array_mut().ok_or_else(||bad("来源题目数组缺失。"))?;
    for q in q{
        if q.get("sourceMaterialReviewAudit").is_some(){return Err(bad("来源审核凭据是程序保留字段，不能由模型提供。"));}
        let original_hash=hash_json(q);let mut hashes=vec![];
        for (a,shape) in &reviewed{
            if a["kind"]!="table_text"||a["details"]["questionId"]!=q["questionId"]{continue;}
            if a["details"]["originalQuestionSha256"]!=original_hash{return Err(stale("表格审核与当前完整来源题目不一致。"));}
            let role=s(&a["details"],"role");
            if !rows(&q["materialRoles"]).iter().any(|r|r["assetId"]==a["assetId"]&&r["role"]==role&&ids(&r["sourceBlockIds"]).contains(&s(&a["details"],"sourceBlockId").to_owned()))
                || !asset_bindings::role_text(q,role).iter().any(|t|paddle::tables(t).iter().any(|v|json!(v)==*shape)){
                return Err(stale("已核准表格没有在对应题目角色中完整呈现。"));
            }hashes.push(hash_json(a));
        }
        if !hashes.is_empty(){q["sourceMaterialReviewAudit"]=json!({"version":1,"originalQuestionSha256":original_hash,"approvalSha256s":hashes});}
    }Ok(derived)
}
fn permitted(record:&Value,questions:&[Value],d:&OcrDocument)->AppResult<(Vec<Value>,HashSet<String>,Vec<Value>)>{
    let mut tables=vec![];let mut documents=HashSet::new();let mut contained=vec![];
    for (a,shape) in checked(record,d)?{
        if a["kind"]=="document_asset"{documents.insert(s(&a,"assetId").to_owned());continue;}
        let details=&a["details"];
        if a["kind"]=="contained_asset"{
            let owners=questions.iter().filter(|q|q["questionId"]==details["questionId"]).collect::<Vec<_>>();
            if owners.len()!=1{return Err(stale("局部素材审核的唯一题目不存在。"));}let q=owners[0];
            let mut location=q.clone();let target=asset_bindings::target_mut(&mut location,&details["target"])?;
            if hash_json(&source_fields(q.clone()))!=details["originalQuestionSha256"]
                ||!ids(&q["sourceBlockIds"]).contains(&s(details,"sourceBlockId").to_owned())
                ||!rows(&q["sourceMaterialRoles"]).iter().any(|r|r["assetId"]==details["representedByAssetId"]&&r["role"]=="student"&&ids(&r["sourceBlockIds"]).contains(&s(details,"sourceBlockId").to_owned()))
                ||!rows(&q["student"]["assets"]).iter().any(|r|r["assetId"]==details["representedByAssetId"]&&r["sha256"]==details["representedByAssetSha256"])
                ||!asset_bindings::reference_in_text(target.as_str().unwrap_or(""),s(details,"representedByAssetId"))
                ||questions.iter().any(|q|rows(&q["sourceMaterialRoles"]).iter().any(|r|r["assetId"]==a["assetId"])
                    ||asset_bindings::role_text(q,"student").iter().chain(asset_bindings::role_text(q,"teacher").iter()).any(|t|asset_bindings::reference_in_text(t,s(&a,"assetId")))){
                return Err(stale("局部素材审核题目版本、同题同角色或精确呈现位置不一致。"));
            }
            contained.push(json!({"assetId":a["assetId"],"questionId":details["questionId"],"role":"student","representedByAssetId":details["representedByAssetId"],"representedByAssetSha256":details["representedByAssetSha256"],"approvalSha256":hash_json(&a),"proofKind":"exact_provider_region_inside_presented_source_png"}));continue;
        }
        for q in questions.iter().filter(|q|q["questionId"]==details["questionId"]){
            if q["sourceMaterialReviewAudit"]["originalQuestionSha256"]!=details["originalQuestionSha256"]
                ||!rows(&q["sourceMaterialReviewAudit"]["approvalSha256s"]).contains(&json!(hash_json(&a))){return Err(stale("题目表格审核凭据缺失或与批准版本不一致。"));}
            tables.push(json!({"assetId":a["assetId"],"questionId":details["questionId"],"role":details["role"],"approvedShape":shape}));
        }
    }Ok((tables,documents,contained))
}
pub(super) fn material_coverage(q:&mut [Value],d:&OcrDocument,record:&Value)->AppResult<()>{let(tables,documents,contained)=permitted(record,q,d)?;paddle::material_coverage_with_source_reviews(q,d,&tables,&documents,&contained)}
pub(super) fn coverage(q:&mut [Value],d:&OcrDocument,record:&Value)->AppResult<()>{let(tables,documents,contained)=permitted(record,q,d)?;paddle::coverage_with_source_reviews(q,d,&tables,&documents,&contained)}

/// Developer-only dispatcher. Persist explicit authority without adopting a
/// candidate, changing old responses/checkpoints, or making any provider call.
pub(super) fn save_review(store:&Store,payload:&Value)->AppResult<Value>{
    let op=operation(payload)?;let payload_hash=hash_json(payload);let mut record=store.document("imports",s(payload,"importId"))?;
    if replay(&record,op,&payload_hash)?{let a=approvals(&record)?.into_iter().find(|a|a["operationId"]==op).ok_or_else(changed)?;return Ok(json!({"import":record,"approval":a}));}
    revision(&record,payload)?;
    if record["status"]!="failed"||!record["sourceStructuring"].is_object()||!author(&payload["author"])||!evidence(&payload["reviewEvidence"]){return Err(bad("仅可保存失败来源记录中已独立核对的具体素材证据。"));}
    let old=record.clone();let d=paddle::load_document(store,&record)?;
    let asset=d.assets.iter().find(|a|a["id"]==payload["assetId"]).ok_or_else(||bad("指定审核素材不存在。"))?;
    let mut details=payload["details"].clone();let mut original_question=None;
    if payload["kind"]=="table_text"{
        for batch in rows(&record["sourceStructuring"]["batches"]){for attempt in rows(&batch["attempts"]){
            if attempt["audit"]["responseSha256"]!=details["responseSha256"]{continue;}
            let raw=canonical_source_contract(&actual_result(store,&attempt,"question_import",&record)?)?;
            for q in rows(&raw["questions"]){if q["questionId"]==details["questionId"]{if original_question.as_ref().is_some_and(|x|x!=&q){return Err(bad("表格来源响应出现冲突题目。"));}original_question=Some(q);}}
        }}
        let q=original_question.as_ref().ok_or_else(||bad("表格审核没有匹配真实完整来源响应。"))?;
        if details.get("originalQuestionSha256").is_some_and(|v|v!=&json!(hash_json(q))){return Err(stale("表格核对的来源题目版本已变化。"));}
        details["originalQuestionSha256"]=json!(hash_json(q));
    }else if payload["kind"]=="contained_asset"{
        verify_successes(store,&record,&d)?;
        let matching=rows(&record["sourceStructuring"]["batches"]).into_iter().filter(|b|b["status"]=="succeeded").flat_map(|b|rows(&b["questions"])).filter(|q|q["questionId"]==details["questionId"]).collect::<Vec<_>>();
        if matching.len()!=1{return Err(bad("局部素材审核必须定位唯一已保存成功来源题目。"));}
        let hash=hash_json(&source_fields(matching[0].clone()));
        if details.get("originalQuestionSha256").is_some_and(|v|v!=&json!(hash)){return Err(stale("局部素材审核题目版本已变化。"));}details["originalQuestionSha256"]=json!(hash);
    }
    let a=json!({"version":1,"operationId":op,"kind":payload["kind"],"sourceSha256":record["source"]["sha256"],"manifestSha256":record["ocrSource"]["manifestSha256"],"assetId":asset["id"],"assetSha256":asset["sha256"],"details":details,"author":payload["author"],"reviewEvidence":payload["reviewEvidence"]});
    let mut list=approvals(&record)?;if list.iter().any(|x|x["assetId"]==a["assetId"]){return Err(bad("该素材已有明确审核，未覆盖旧批准。"));}list.push(a.clone());record["sourceStructuring"]["materialReviewApprovals"]=json!(list);
    verify_saved_inputs(store,&record)?;
    checked(&record,&d)?;
    if a["kind"]=="table_text"{
        let q=original_question.unwrap();
        apply_tables(&json!({"questions":[q]}),&record,&d)?;
    }else if a["kind"]=="contained_asset"{
        let q=rows(&record["sourceStructuring"]["batches"]).iter().flat_map(|b|rows(&b["questions"])).collect::<Vec<_>>();permitted(&record,&q,&d)?;
    }else{
        // Do not allow a document review to hide an already assigned real
        // question figure, even if an operator accidentally picks its crop.
        if rows(&record["sourceStructuring"]["plan"]["questions"]).iter().any(|q|ids(&q["sourceBlockIds"]).contains(&s(&a["details"],"sourceBlockId").to_owned())){
            return Err(bad("该原文块已属于具体题目，不能改作非题资料。"));
        }
        for q in rows(&record["sourceStructuring"]["batches"]).iter().flat_map(|b|rows(&b["questions"])){
            if rows(&q["sourceMaterialRoles"]).iter().any(|r|r["assetId"]==a["assetId"]&&r["role"]!="document"){
                return Err(bad("该素材已有学生或教师题图归属，不能改作非题资料。"));
            }
        }
    }
    finish(&mut record,op,&payload_hash,"source_material_review");save_cas(store,Some(&old),&record)?;
    Ok(json!({"import":record,"approval":a}))
}

#[cfg(test)]
mod tests{
    use super::*;
    fn png(im:image::DynamicImage)->(String,String){let mut b=Cursor::new(vec![]);im.write_to(&mut b,image::ImageFormat::Png).unwrap();let b=b.into_inner();(sha(&b),base64::engine::general_purpose::STANDARD.encode(b))}
    fn author_evidence()->(Value,Value){(json!({"kind":"user_authorized_agent_review","id":"codex"}),json!({"reportSha256":"a".repeat(64),"summary":"模拟逐图核对，非真实教师使用"}))}
    fn fixture()->(Value,Value,OcrDocument,Value){
        let old="<table><tr><td>OCR错误表头</td><td>值</td></tr><tr><td></td><td>3</td></tr></table>";
        let new=old.replace("OCR错误表头","原图正确表头");let (hash,bytes)=png(image::DynamicImage::new_rgb8(4,4));
        let block=json!({"id":1,"type":"table","bbox":[0,0,4,4],"text":old});
        let d=OcrDocument{pages:vec![json!({"page":1,"text":"1. 模拟表格题","blocks":[block.clone()]})],assets:vec![json!({"id":"table-1","page":1,"role":"table","bbox":[0,0,4,4],"sha256":hash,"contentBase64":bytes})],issues:vec![]};
        let q=json!({"questionId":"q1","sourceLabel":"1","pages":[1],"sourceBlockIds":["p1-b1"],"stem":new,"materialRoles":[{"assetId":"table-1","role":"student","sourceBlockIds":["p1-b1"],"basis":"模拟题目表格"}]});
        let (author,evidence)=author_evidence();
        let a=json!({"version":1,"operationId":"sim-review","kind":"table_text","sourceSha256":"b".repeat(64),"manifestSha256":"c".repeat(64),"assetId":"table-1","assetSha256":hash,"details":{"questionId":"q1","responseSha256":"d".repeat(64),"originalQuestionSha256":hash_json(&q),"role":"student","sourceBlockId":"p1-b1","sourceBlockSha256":hash_json(&block),"originalTableHtml":old,"approvedTableHtml":new,"cellCorrections":[{"row":0,"column":0,"old":"OCR错误表头","new":"原图正确表头"}]},"author":author,"reviewEvidence":evidence});
        let r=json!({"source":{"sha256":"b".repeat(64)},"ocrSource":{"manifestSha256":"c".repeat(64),"assets":d.assets},"sourceStructuring":{"materialReviewApprovals":[a.clone()]}});
        (q,r,d,a)
    }
    fn prepared(q:&Value)->Value{let mut q=q.clone();q["sourceMaterialRoles"]=q["materialRoles"].clone();q}
    #[test]
    fn reviewed_table_preserves_correct_html_without_duplicating_image_or_changing_ocr(){
        let(q,r,d,_)=fixture();let raw=json!({"questions":[q.clone()]});let pages=d.pages.clone();
        assert_eq!(paddle::material_coverage(&mut[prepared(&q)],&d).unwrap_err().code,"ocr_material_unassigned");
        let next=apply_tables(&raw,&r,&d).unwrap();let mut question=prepared(&next["questions"][0]);
        material_coverage(std::slice::from_mut(&mut question),&d,&r).unwrap();
        assert_eq!(next["questions"][0]["stem"],q["stem"]);assert_eq!(raw,json!({"questions":[q]}));assert_eq!(d.pages,pages);
        assert!(!s(&question,"stem").contains("asset:"));assert_eq!(next,apply_tables(&raw,&r,&d).unwrap());
    }
    #[test]
    fn reviewed_table_requires_exact_cells_grid_and_raw_candidate(){
        let(q,r,d,_)=fixture();
        for path in ["sourceSha256","manifestSha256","assetSha256"]{
            let mut bad=r.clone();bad["sourceStructuring"]["materialReviewApprovals"][0][path]=json!("e".repeat(64));
            assert!(apply_tables(&json!({"questions":[q.clone()]}),&bad,&d).is_err());
        }
        let mut bad=r.clone();bad["sourceStructuring"]["materialReviewApprovals"][0]["details"]["approvedTableHtml"]=json!(s(&q,"stem").replace(">3<",">4<"));
        assert!(apply_tables(&json!({"questions":[q.clone()]}),&bad,&d).is_err());
        let mut changed=q.clone();changed["stem"]=json!(format!("changed {}",s(&q,"stem")));
        assert!(apply_tables(&json!({"questions":[changed]}),&r,&d).is_err());
        let mut forged=q.clone();forged["sourceMaterialReviewAudit"]=json!({});assert!(apply_tables(&json!({"questions":[forged]}),&r,&d).is_err());
        let next=apply_tables(&json!({"questions":[q]}),&r,&d).unwrap();let mut no_audit=prepared(&next["questions"][0]);no_audit.as_object_mut().unwrap().remove("sourceMaterialReviewAudit");
        assert!(material_coverage(&mut[no_audit],&d,&r).is_err());
    }
    fn document_fixture()->(Value,Value,OcrDocument){
        let mut full=image::RgbaImage::new(8,8);for y in 0..8{for x in 0..8{full.put_pixel(x,y,image::Rgba([x as u8,y as u8,(x+y) as u8,255]));}}
        let crop=image::imageops::crop_imm(&full,2,3,3,2).to_image();let (ph,pb)=png(image::DynamicImage::ImageRgba8(full));let(ch,cb)=png(image::DynamicImage::ImageRgba8(crop));
        let b=json!({"id":9,"type":"footer_image","bbox":[2,3,5,5],"text":""});
        let d=OcrDocument{pages:vec![json!({"page":1,"text":"1. 模拟题目","coordinateTransform":{"kind":"identity"},"blocks":[{"id":1,"text":"1. 模拟题目"}],"omittedBlocks":[b.clone()]})],assets:vec![json!({"id":"page-1","page":1,"role":"source_page","sha256":ph,"contentBase64":pb}),json!({"id":"crop-1","page":1,"role":"figure","bbox":null,"sha256":ch,"contentBase64":cb})],issues:vec![]};
        let(author,evidence)=author_evidence();let a=json!({"version":1,"operationId":"sim-qr","kind":"document_asset","sourceSha256":"b".repeat(64),"manifestSha256":"c".repeat(64),"assetId":"crop-1","assetSha256":ch,"details":{"sourcePageAssetId":"page-1","sourcePageSha256":ph,"sourceBlockId":"p1-b9","sourceBlockSha256":hash_json(&b),"sourceImageBbox":[2,3,5,5]},"author":author,"reviewEvidence":evidence});
        let r=json!({"source":{"sha256":"b".repeat(64)},"ocrSource":{"manifestSha256":"c".repeat(64),"assets":d.assets},"sourceStructuring":{"materialReviewApprovals":[a]}});
        (json!({"questionId":"q1","sourceLabel":"1","pages":[1],"stem":"模拟题目","sourceMaterialRoles":[]}),r,d)
    }
    #[test]
    fn reviewed_document_asset_requires_exact_page_crop_and_changes_no_successful_question(){
        let(q,r,d)=document_fixture();let before=q.clone();
        assert_eq!(paddle::material_coverage(&mut[q.clone()],&d).unwrap_err().code,"ocr_material_role");
        let mut questions=vec![q];coverage(&mut questions,&d,&r).unwrap();assert_eq!(questions[0],before);
        let mut r=r.clone();r["sourceStructuring"]["materialReviewApprovals"][0]["details"]["sourceImageBbox"]=json!([1,3,4,5]);assert!(coverage(&mut questions,&d,&r).is_err());
    }
    #[test]
    fn document_review_cannot_hide_a_real_question_image_or_conflicting_inline_reference(){
        let(q,r,d)=document_fixture();let mut q=q;q["sourceMaterialRoles"]=json!([{"assetId":"crop-1","role":"student"}]);
        assert!(coverage(&mut[q.clone()],&d,&r).is_err());q["sourceMaterialRoles"]=json!([]);q["stem"]=json!("![真实题图](asset:crop-1)");assert!(coverage(&mut[q],&d,&r).is_err());
    }
    #[test]
    fn stale_or_forged_review_is_not_ignored_or_replaced_with_a_new_model_call(){
        let(q,mut r,d)=document_fixture();r["sourceStructuring"]["materialReviewApprovals"][0]["author"]["id"]=json!("model");assert_eq!(coverage(&mut[q.clone()],&d,&r).unwrap_err().code,"source_material_review_stale");
        r["sourceStructuring"]["materialReviewApprovals"]=json!({});assert!(coverage(&mut[q],&d,&r).is_err());
    }
    fn saved_fixture()->(tempfile::TempDir,Store,Value,Value,std::path::PathBuf,Vec<u8>){
        let(mut q,mut r,d,a)=fixture();let dir=tempfile::tempdir().unwrap();let store=Store::open(dir.path(),&crate::bank::tests::seed()).unwrap();
        let id="sim-source-material-review";let root=store.data_dir.join("imports").join(id);std::fs::create_dir_all(&root).unwrap();let root=root.canonicalize().unwrap();let ocr=root.join("ocr");std::fs::create_dir(&ocr).unwrap();
        r["importId"]=json!(id);r["revision"]=json!(0);r["status"]=json!("failed");r["questions"]=json!([]);r["operations"]=json!([]);q["questionId"]=json!(format!("{id}-q1"));q["questionType"]=json!("solution");q["options"]=json!([]);
        paddle::save_document(&store,&mut r,&d,&ocr,json!({"simulation":true})).unwrap();
        let scope=json!({"index":0,"expectedQuestions":[{"questionId":q["questionId"],"sourceLabel":"1","questionType":"solution","sourceBlockIds":["p1-b1"]}]});
        let context=json!({"sourceSha256":r["source"]["sha256"],"sourceManifestSha256":r["ocrSource"]["manifestSha256"],"sourceBatch":scope});
        let body=json!({"model":"simulated-original","messages":[{"role":"system","content":"simulated source request"},{"role":"user","content":context.to_string()}]});
        let request=json!({"task":"question_import","redacted":false,"bodySha256":hash_json(&body),"promptSha256":hash_json(&body["messages"][0]["content"]),"body":body});
        let path=root.join("original.response.json");let response=json!({"httpStatus":200,"choices":[{"finish_reason":"stop","message":{"content":json!({"questions":[q.clone()]}).to_string()}}]});let bytes=serde_json::to_vec(&response).unwrap();std::fs::write(&path,&bytes).unwrap();std::fs::write(path.with_extension("request.json"),serde_json::to_vec(&request).unwrap()).unwrap();
        let attempt=json!({"operationId":"sim-original","status":"failed","scopeHash":hash_json(&context["sourceBatch"]),"audit":audit_files(&store,&path).unwrap()});
        r["sourceStructuring"]=json!({"plan":{"questions":[{"sourceLabel":"1","questionType":"solution","sourceBlockIds":["p1-b1"]}],"sharedBlockIds":[],"documentBlockIds":[]},"batches":[{"index":0,"start":0,"end":1,"status":"failed","attempts":[attempt]}]});store.put_document("imports",id,&r).unwrap();
        let mut details=a["details"].clone();details["questionId"]=q["questionId"].clone();details["responseSha256"]=json!(sha(&bytes));details.as_object_mut().unwrap().remove("originalQuestionSha256");
        let payload=json!({"importId":id,"expectedRevision":0,"operationId":"sim-material-authority","kind":"table_text","assetId":"table-1","details":details,"author":a["author"],"reviewEvidence":a["reviewEvidence"]});
        (dir,store,r,payload,path,bytes)
    }
    #[test]
    fn explicit_save_is_cas_idempotent_reopenable_and_preserves_original_response_ocr_and_failure(){
        let(dir,store,r,payload,path,bytes)=saved_fixture();let manifest=store.data_dir.join(s(&r["ocrSource"],"manifestRelativePath"));let original_manifest=std::fs::read(&manifest).unwrap();
        let result=save_review(&store,&payload).unwrap();assert_eq!(result["import"]["status"],"failed");assert_eq!(result["import"]["questions"],json!([]));assert_eq!(result["import"]["sourceStructuring"]["batches"],r["sourceStructuring"]["batches"]);assert_eq!(result["import"]["revision"],1);
        assert_eq!(save_review(&store,&payload).unwrap(),result);assert_eq!(std::fs::read(&path).unwrap(),bytes);assert_eq!(std::fs::read(manifest).unwrap(),original_manifest);
        let mut wrong=payload.clone();wrong["details"]["cellCorrections"][0]["new"]=json!("conflict");assert_eq!(save_review(&store,&wrong).unwrap_err().code,"operation_conflict");
        let root=dir.path().to_path_buf();drop(store);let reopened=Store::open(&root,&crate::bank::tests::seed()).unwrap();assert_eq!(save_review(&reopened,&payload).unwrap(),result);
        let mut stale=payload.clone();stale["operationId"]=json!("sim-stale");assert_eq!(save_review(&reopened,&stale).unwrap_err().code,"revision_conflict");
    }
    #[test]
    fn wrong_response_or_unreviewed_table_change_never_writes_authority(){
        let(_dir,store,r,payload,_path,_bytes)=saved_fixture();
        for field in ["responseSha256","sourceBlockSha256"]{let mut wrong=payload.clone();wrong["details"][field]=json!("e".repeat(64));assert!(save_review(&store,&wrong).is_err());assert_eq!(store.document("imports",s(&r,"importId")).unwrap(),r);}
        let mut wrong=payload.clone();wrong["details"]["approvedTableHtml"]=json!(s(&payload["details"],"approvedTableHtml").replace(">3<",">4<"));assert!(save_review(&store,&wrong).is_err());assert_eq!(store.document("imports",s(&r,"importId")).unwrap(),r);
    }
    fn legacy_fixture()->(Value,Value,OcrDocument){
        let(q,mut r,mut d)=document_fixture();let(hash,bytes)=png(image::DynamicImage::new_rgb8(3,2));
        let id=format!("ocr-p1-figure-{}",&hash[..20]);d.assets[1]["id"]=json!(id);d.assets[1]["sha256"]=json!(hash);d.assets[1]["contentBase64"]=json!(bytes);
        r["ocrSource"]["assets"]=json!(d.assets);let a=&mut r["sourceStructuring"]["materialReviewApprovals"][0];a["assetId"]=json!(id);a["assetSha256"]=json!(hash);
        a["details"]["providerPathEvidence"]=json!({"resultRelativePath":"imports/sim/ocr/003-result.json","resultSha256":"f".repeat(64),"sourceImagePath":"imgs/img_in_footer_image_box_2_3_5_5.jpg","layoutIndex":0,"imagePaths":["imgs/img_in_footer_image_box_2_3_5_5.jpg"]});
        (q,r,d)
    }
    #[test]
    fn legacy_jpeg_path_proof_is_unique_and_does_not_weaken_pixel_equality(){
        let(q,r,d)=legacy_fixture();assert!(!paddle::exact_source_crop(&d.assets[1],&d.assets[0],&json!([2,3,5,5])).unwrap());
        assert!(provider_mapping(&r["sourceStructuring"]["materialReviewApprovals"][0]["details"],&d.assets[1],&d).unwrap());coverage(&mut[q.clone()],&d,&r).unwrap();
        let mut extra=r.clone();extra["sourceStructuring"]["materialReviewApprovals"][0]["details"]["providerPathEvidence"]["imagePaths"].as_array_mut().unwrap().push(json!("imgs/img_in_footer_image_box_0_0_1_1.jpg"));assert!(coverage(&mut[q.clone()],&d,&extra).is_err());
        let mut d2=OcrDocument{pages:d.pages.clone(),assets:d.assets.clone(),issues:vec![]};let mut asset=d2.assets[1].clone();asset["id"]=json!("second-unpositioned");d2.assets.push(asset);assert!(coverage(&mut[q.clone()],&d2,&r).is_err());
        let mut wrong=r.clone();wrong["sourceStructuring"]["materialReviewApprovals"][0]["details"]["providerPathEvidence"]["sourceImagePath"]=json!("imgs/img_in_footer_image_box_0_0_1_1.jpg");assert!(coverage(&mut[q.clone()],&d,&wrong).is_err());
        let mut used=q;used["sourceMaterialRoles"]=json!([{"assetId":d.assets[1]["id"],"role":"student"}]);assert!(coverage(&mut[used],&d,&r).is_err());
    }
    #[test]
    fn provider_path_receipt_rechecks_actual_result_and_rejects_other_attempt_or_changed_file(){
        let(_q,mut r,d)=legacy_fixture();let dir=tempfile::tempdir().unwrap();let store=Store::open(dir.path(),&crate::bank::tests::seed()).unwrap();let root=store.data_dir.join("imports").join("sim-provider-proof").join("ocr");std::fs::create_dir_all(&root).unwrap();let root=root.canonicalize().unwrap();
        let manifest=root.join("source-manifest.json");std::fs::write(&manifest,b"{}").unwrap();r["ocrSource"]["manifestRelativePath"]=json!(manifest.strip_prefix(store.data_dir.canonicalize().unwrap()).unwrap().to_string_lossy().replace('\\',"/"));
        let result=json!({"httpStatus":200,"response":{"errorCode":0,"result":{"layoutParsingResults":[{"markdown":{"images":{"imgs/img_in_footer_image_box_2_3_5_5.jpg":"redacted"}},"prunedResult":{"parsing_res_list":[{"block_id":9,"block_label":"footer_image","block_bbox":[2,3,5,5]}]}}]}}});
        let file=root.join("003-result.json");let bytes=serde_json::to_vec(&result).unwrap();std::fs::write(&file,&bytes).unwrap();let proof=&mut r["sourceStructuring"]["materialReviewApprovals"][0]["details"]["providerPathEvidence"];
        proof["resultRelativePath"]=json!(file.strip_prefix(store.data_dir.canonicalize().unwrap()).unwrap().to_string_lossy().replace('\\',"/"));proof["resultSha256"]=json!(sha(&bytes));
        verify_saved_inputs(&store,&r).unwrap();checked(&r,&d).unwrap();
        let other=root.parent().unwrap().join("another");std::fs::create_dir(&other).unwrap();let foreign=other.join("003-result.json");std::fs::write(&foreign,&bytes).unwrap();let mut bad=r.clone();bad["sourceStructuring"]["materialReviewApprovals"][0]["details"]["providerPathEvidence"]["resultRelativePath"]=json!(foreign.strip_prefix(store.data_dir.canonicalize().unwrap()).unwrap().to_string_lossy().replace('\\',"/"));assert!(verify_saved_inputs(&store,&bad).is_err());
        std::fs::write(&file,b"changed").unwrap();assert!(verify_saved_inputs(&store,&r).is_err());
    }
    #[test]
    fn document_review_never_persists_bad_provider_path_or_hash_and_valid_receipt_replays(){
        let(_q,mut r,d)=legacy_fixture();let approval=r["sourceStructuring"]["materialReviewApprovals"][0].clone();
        let dir=tempfile::tempdir().unwrap();let store=Store::open(dir.path(),&crate::bank::tests::seed()).unwrap();let id="sim-document-provider-save";let root=store.data_dir.join("imports").join(id);std::fs::create_dir_all(&root).unwrap();let root=root.canonicalize().unwrap();let ocr=root.join("ocr");std::fs::create_dir(&ocr).unwrap();
        r["importId"]=json!(id);r["revision"]=json!(0);r["status"]=json!("failed");r["questions"]=json!([]);r["operations"]=json!([]);r["sourceStructuring"]=json!({"plan":{"questions":[{"sourceBlockIds":["p1-b1"]}]},"batches":[]});
        paddle::save_document(&store,&mut r,&d,&ocr,json!({"simulation":true})).unwrap();
        let result=json!({"httpStatus":200,"response":{"errorCode":0,"result":{"layoutParsingResults":[{"markdown":{"images":{"imgs/img_in_footer_image_box_2_3_5_5.jpg":"redacted"}},"prunedResult":{"parsing_res_list":[{"block_id":9,"block_label":"footer_image","block_bbox":[2,3,5,5]}]}}]}}});
        let file=ocr.join("003-result.json");let bytes=serde_json::to_vec(&result).unwrap();std::fs::write(&file,&bytes).unwrap();let mut details=approval["details"].clone();details["providerPathEvidence"]["resultRelativePath"]=json!(file.strip_prefix(store.data_dir.canonicalize().unwrap()).unwrap().to_string_lossy().replace('\\',"/"));details["providerPathEvidence"]["resultSha256"]=json!(sha(&bytes));
        let payload=json!({"importId":id,"expectedRevision":0,"operationId":"sim-document-authority","kind":"document_asset","assetId":approval["assetId"],"details":details,"author":approval["author"],"reviewEvidence":approval["reviewEvidence"]});store.put_document("imports",id,&r).unwrap();
        let foreign=root.join("003-result.json");std::fs::write(&foreign,&bytes).unwrap();
        for (key,value) in [("resultSha256",json!("f".repeat(64))),("resultRelativePath",json!(foreign.strip_prefix(store.data_dir.canonicalize().unwrap()).unwrap().to_string_lossy().replace('\\',"/")))]{
            let mut bad=payload.clone();bad["details"]["providerPathEvidence"][key]=value;assert!(save_review(&store,&bad).is_err());assert_eq!(store.document("imports",id).unwrap(),r);
        }
        let saved=save_review(&store,&payload).unwrap();assert_eq!(saved["import"]["status"],"failed");assert_eq!(saved["import"]["sourceStructuring"]["batches"],r["sourceStructuring"]["batches"]);assert_eq!(save_review(&store,&payload).unwrap(),saved);
        paddle::load_document(&store,&saved["import"]).unwrap();std::fs::write(file,b"changed").unwrap();assert!(paddle::load_document(&store,&saved["import"]).is_err());
    }
    fn contained_fixture()->(Value,Value,OcrDocument){
        let mut full=image::RgbaImage::new(12,12);for y in 0..12{for x in 0..12{full.put_pixel(x,y,image::Rgba([x as u8,y as u8,(x+y) as u8,255]));}}
        let parent=image::imageops::crop_imm(&full,2,2,8,8).to_image();let(ph,pb)=png(image::DynamicImage::ImageRgba8(full));let(rh,rb)=png(image::DynamicImage::ImageRgba8(parent));let(ch,cb)=png(image::DynamicImage::new_rgb8(3,3));let child_id=format!("ocr-p1-figure-{}",&ch[..20]);
        let b=json!({"id":2,"type":"image","bbox":[2,2,10,10],"assetId":"parent-C","text":""});
        let d=OcrDocument{pages:vec![json!({"page":1,"text":"1. 模拟选项图题","coordinateTransform":{"kind":"identity"},"blocks":[b.clone()]})],assets:vec![json!({"id":"page-1","page":1,"role":"source_page","sha256":ph,"contentBase64":pb}),json!({"id":"parent-C","page":1,"role":"figure","bbox":[2,2,10,10],"sha256":rh,"contentBase64":rb}),json!({"id":child_id,"page":1,"role":"figure","bbox":null,"sha256":ch,"contentBase64":cb})],issues:vec![]};
        let q=json!({"questionId":"q1","sourceLabel":"1","questionType":"single_choice","pages":[1],"sourceBlockIds":["p1-b2"],"stem":"模拟题目","options":[{"label":"C","text":"![模拟C选项](asset:parent-C)"}],"sourceMaterialRoles":[{"assetId":"parent-C","role":"student","sourceBlockIds":["p1-b2"]}],"student":{"assets":[{"assetId":"parent-C","sha256":rh}]}});
        let(author,evidence)=author_evidence();let a=json!({"version":1,"operationId":"sim-contained-C","kind":"contained_asset","sourceSha256":"b".repeat(64),"manifestSha256":"c".repeat(64),"assetId":child_id,"assetSha256":ch,"details":{"questionId":"q1","originalQuestionSha256":hash_json(&source_fields(q.clone())),"role":"student","target":{"field":"option","label":"C"},"representedByAssetId":"parent-C","representedByAssetSha256":rh,"sourcePageAssetId":"page-1","sourcePageSha256":ph,"sourceBlockId":"p1-b2","sourceBlockSha256":hash_json(&b),"sourceImageBbox":[4,4,7,7],"representativeSourceImageBbox":[2,2,10,10],"providerPathEvidence":{"resultRelativePath":"imports/sim/ocr/003-result.json","resultSha256":"f".repeat(64),"sourceImagePath":"imgs/img_in_image_box_4_4_7_7.jpg","layoutIndex":0,"imagePaths":["imgs/img_in_image_box_2_2_10_10.jpg","imgs/img_in_image_box_4_4_7_7.jpg"]}},"author":author,"reviewEvidence":evidence});
        let r=json!({"source":{"sha256":"b".repeat(64)},"ocrSource":{"manifestSha256":"c".repeat(64),"assets":d.assets},"sourceStructuring":{"materialReviewApprovals":[a]}});(q,r,d)
    }
    #[test]
    fn contained_provider_region_keeps_original_assets_and_successful_question_without_pixel_alias_claim(){
        let(q,r,d)=contained_fixture();let before=q.clone();assert_eq!(paddle::exact_representation_offset(&d.assets[2],&d.assets[1]).unwrap(),None);
        assert!(paddle::material_coverage(&mut[q.clone()],&d).is_err());let mut questions=vec![q];coverage(&mut questions,&d,&r).unwrap();assert_eq!(questions[0],before);assert_eq!(d.assets.len(),3);
        assert!(questions[0]["sourceMaterialRoles"].as_array().unwrap().iter().all(|r|r.get("representedByAssetId").is_none()));assert_eq!(permitted(&r,&questions,&d).unwrap().2[0]["proofKind"],"exact_provider_region_inside_presented_source_png");
    }
    #[test]
    fn contained_review_rejects_foreign_role_unrendered_target_changed_question_and_ambiguous_mapping(){
        let(q,r,d)=contained_fixture();
        let mut bad=r.clone();bad["sourceStructuring"]["materialReviewApprovals"][0]["details"]["role"]=json!("teacher");assert!(coverage(&mut[q.clone()],&d,&bad).is_err());
        let mut changed=q.clone();changed["options"][0]["text"]=json!("no figure");let mut bad=r.clone();bad["sourceStructuring"]["materialReviewApprovals"][0]["details"]["originalQuestionSha256"]=json!(hash_json(&source_fields(changed.clone())));assert!(coverage(&mut[changed],&d,&bad).is_err());
        let mut changed=q.clone();changed["stem"]=json!("different question version");assert!(coverage(&mut[changed],&d,&r).is_err());
        let mut bad=r.clone();bad["sourceStructuring"]["materialReviewApprovals"][0]["details"]["providerPathEvidence"]["imagePaths"].as_array_mut().unwrap().push(json!("imgs/img_in_image_box_0_0_1_1.jpg"));assert!(coverage(&mut[q.clone()],&d,&bad).is_err());
        let mut bad=r.clone();bad["sourceStructuring"]["materialReviewApprovals"][0]["details"]["sourceImageBbox"]=json!([9,9,12,12]);assert!(coverage(&mut[q.clone()],&d,&bad).is_err());
        let mut bad=r.clone();bad["sourceStructuring"]["materialReviewApprovals"][0]["details"]["sourcePageSha256"]=json!("e".repeat(64));assert!(coverage(&mut[q.clone()],&d,&bad).is_err());
        let mut bad=r.clone();bad["sourceStructuring"]["materialReviewApprovals"][0]["author"]["id"]=json!("model");assert!(coverage(&mut[q],&d,&bad).is_err());
    }
    #[test]
    #[ignore="explicit read-only saved source/visual review evidence"]
    fn saved_material_review_evidence_readonly_regression(){
        let path=std::path::PathBuf::from(std::env::var("TUTOR_MATERIAL_REVIEW_TEMPLATES").expect("explicit templates"));
        let runtime=std::path::PathBuf::from(std::env::var("TUTOR_MATERIAL_REVIEW_RUNTIME").expect("explicit preserved runtime"));
        let input:Value=serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();let mut count=0;
        for row in rows(&input){
            let record_path=path.parent().unwrap().parent().unwrap().join(format!("paper-{:02}-record.json",row["paper"].as_u64().unwrap()));
            let mut record:Value=serde_json::from_slice(&std::fs::read(record_path).unwrap()).unwrap();let payload=&row["payload"];
            let bytes=std::fs::read(runtime.join(s(&record["ocrSource"],"manifestRelativePath"))).unwrap();assert_eq!(sha(&bytes),record["ocrSource"]["manifestSha256"]);
            let manifest:Value=serde_json::from_slice(&bytes).unwrap();let mut assets=rows(&manifest["assets"]);for asset in &mut assets{asset["contentBase64"]=json!(base64::engine::general_purpose::STANDARD.encode(std::fs::read(runtime.join(s(asset,"relativePath"))).unwrap()));}
            let d=OcrDocument{pages:rows(&manifest["pages"]),assets,issues:rows(&manifest["issues"])};let mut details=payload["details"].clone();let mut raw=Value::Null;
            if payload["kind"]=="table_text"{
                let attempt=rows(&record["sourceStructuring"]["batches"]).iter().flat_map(|b|rows(&b["attempts"])).find(|a|a["audit"]["responseSha256"]==details["responseSha256"]).unwrap();
                let bytes=std::fs::read(runtime.join(s(&attempt["audit"],"responseRelativePath"))).unwrap();assert_eq!(sha(&bytes),details["responseSha256"]);
                let response:Value=serde_json::from_slice(&bytes).unwrap();let body:Value=serde_json::from_str(s(&response["choices"][0]["message"],"content")).unwrap();raw=canonical_source_contract(&body).unwrap();
                let q=rows(&raw["questions"]).into_iter().find(|q|q["questionId"]==details["questionId"]).unwrap();details["originalQuestionSha256"]=json!(hash_json(&q));
            }
            let asset=d.assets.iter().find(|a|a["id"]==payload["assetId"]).unwrap();let a=json!({"version":1,"operationId":payload["operationId"],"kind":payload["kind"],"sourceSha256":record["source"]["sha256"],"manifestSha256":record["ocrSource"]["manifestSha256"],"assetId":asset["id"],"assetSha256":asset["sha256"],"details":details,"author":payload["author"],"reviewEvidence":payload["reviewEvidence"]});
            let mut existing=rows(&record["sourceStructuring"]["materialReviewApprovals"]);existing.push(a);record["sourceStructuring"]["materialReviewApprovals"]=json!(existing);verify_inputs_at(&runtime,&record).unwrap();checked(&record,&d).unwrap();
            if !raw.is_null(){let next=apply_tables(&raw,&record,&d).unwrap();let mut q=rows(&next["questions"]).into_iter().map(|q|prepared(&q)).collect::<Vec<_>>();let tables=permitted(&record,&q,&d).unwrap().0;assert_eq!(tables.len(),1);let scope=OcrDocument{pages:d.pages.clone(),assets:d.assets.iter().filter(|a|a["id"]==payload["assetId"]).cloned().collect(),issues:vec![]};material_coverage(&mut q,&scope,&record).unwrap();}
            count+=1;
        }
        println!("read-only validated {count} actual table/document approval receipts; no provider or database writes");
    }
    #[test]
    #[ignore="explicit saved JinHua source files plus isolated temporary DB only"]
    fn saved_contained_material_readonly_regression(){
        let path=std::path::PathBuf::from(std::env::var("TUTOR_CONTAINED_MATERIAL_CASE").expect("explicit saved case"));let case:Value=serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let record_bytes=std::fs::read(s(&case,"recordPath")).unwrap();assert_eq!(sha(&record_bytes),case["recordSha256"]);let terminal:Value=serde_json::from_slice(&record_bytes).unwrap();let record=terminal[s(&case,"recordField")].clone();
        let mut payload:Value=serde_json::from_slice(&std::fs::read(s(&case,"payloadPath")).unwrap()).unwrap();payload["expectedRevision"]=record["revision"].clone();
        let temp=tempfile::tempdir().unwrap();let mut store=Store::open(temp.path(),&crate::bank::tests::seed()).unwrap();
        // SQLite connections remain in temp. Only immutable original files are
        // resolved under the explicit preserved runtime; no runtime DB opens.
        let db:String=store.user.query_row("PRAGMA database_list",[],|r|r.get(2)).unwrap();assert!(std::path::PathBuf::from(db).canonicalize().unwrap().starts_with(temp.path().canonicalize().unwrap()));
        store.data_dir=std::path::PathBuf::from(s(&case,"runtimeRoot"));store.put_document("imports",s(&record,"importId"),&record).unwrap();let d=paddle::load_document(&store,&record).unwrap();
        let asset=d.assets.iter().find(|a|a["id"]==payload["assetId"]).unwrap();let rep=d.assets.iter().find(|a|a["id"]==payload["details"]["representedByAssetId"]).unwrap();
        assert_eq!(paddle::exact_representation_offset(asset,rep).unwrap(),None);
        for field in ["role","sourcePageSha256","questionId"]{let mut wrong=payload.clone();wrong["details"][field]=json!(match field{"role"=>"teacher","questionId"=>"missing-question",_=>"incorrect-page-hash"});assert!(save_review(&store,&wrong).is_err());assert_eq!(store.document("imports",s(&record,"importId")).unwrap(),record);}
        let saved=save_review(&store,&payload).unwrap();assert_eq!(saved["import"]["status"],record["status"]);assert_eq!(saved["import"]["sourceStructuring"]["batches"],record["sourceStructuring"]["batches"]);assert_eq!(save_review(&store,&payload).unwrap(),saved);
        let mut all=rows(&saved["import"]["sourceStructuring"]["batches"]).iter().flat_map(|b|rows(&b["questions"])).collect::<Vec<_>>();let original=all.clone();coverage(&mut all,&d,&saved["import"]).unwrap();assert_eq!(all,original);assert_eq!(all.len(),19);
        let mut completed=saved["import"].clone();completed["sourceStructuring"]["status"]=json!("completed");completed["questions"]=json!(all);verify_completed_with_document(&store,&completed,&d).unwrap();
        let mut denied=completed.clone();denied["sourceStructuring"]["materialReviewApprovals"].as_array_mut().unwrap().retain(|a|a["kind"]!="contained_asset");assert!(verify_completed_with_document(&store,&denied,&d).is_err());
        let mut changed=completed.clone();changed["sourceStructuring"]["materialReviewApprovals"].as_array_mut().unwrap().last_mut().unwrap()["details"]["providerPathEvidence"]["resultSha256"]=json!("e".repeat(64));assert!(paddle::load_document(&store,&changed).is_err());
        println!("actual JinHua source: 10 batches / 19 questions unchanged; contained provenance and publication-side source replay pass; runtime database never opened; only temporary DB writes");
    }
}
