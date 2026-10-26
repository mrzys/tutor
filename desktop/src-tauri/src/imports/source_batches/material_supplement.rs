//! Explicit, source-bound completion of assets outside the saved question scopes.
//! Successful question batches are inputs, never rewritten by this stage.
use super::*;

const SUPPLEMENT_VERSION: &str = "source-material-supplement-v1";
const MAX_ORPHANS: usize = 12;

fn invalid(message: &str) -> AppError { err("source_material_supplement_invalid", message) }

fn exact_keys(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|o| o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k)))
}

fn missing_assets<'a>(questions: &[Value], document: &'a OcrDocument) -> Vec<&'a Value> {
    document.assets.iter().filter(|asset| asset["role"] != "source_page"
        && !questions.iter().any(|q| rows(&q["sourceMaterialRoles"]).iter().any(|r| r["assetId"] == asset["id"]))).collect()
}

fn input(record: &Value, document: &OcrDocument, questions: &[Value]) -> AppResult<Option<(Value, OcrDocument)>> {
    let missing = missing_assets(questions, document);
    if missing.is_empty() { return Ok(None); }
    if missing.len() > MAX_ORPHANS {
        return Err(err("source_material_supplement_limit", "未归属素材超过单次补核上限，原件和成功来源批次已保留，未扩大请求。"));
    }
    let page_numbers: Vec<_> = missing.iter().map(|a| a["page"].clone()).collect();
    let sub = OcrDocument {
        pages: document.pages.iter().filter(|p| page_numbers.contains(&p["page"])).cloned().collect(),
        assets: document.assets.iter().filter(|a| page_numbers.contains(&a["page"])).cloned().collect(),
        issues: document.issues.clone(),
    };
    let source_questions: Vec<_> = questions.iter().filter(|q| rows(&q["pages"]).iter().any(|p| page_numbers.contains(p)))
        .map(|q| json!({"questionId":q["questionId"],"sourceLabel":q["sourceLabel"],"questionType":q["questionType"],"pages":q["pages"],"sourceBlockIds":q["sourceBlockIds"],"stem":q["stem"],"options":q["options"],"parts":q["parts"],"answer":q["answer"],"solution":q["solution"],"sourceMaterialRoles":q["sourceMaterialRoles"],"studentAssets":q["student"]["assets"],"teacherAssets":q["teacher"]["assets"]})).collect();
    let targets: Vec<_> = missing.iter().map(|a| json!({"assetId":a["id"],"sha256":a["sha256"],"page":a["page"]})).collect();
    let mut context = json!({"sourceSha256":record["source"]["sha256"],"sourceManifestSha256":record["ocrSource"]["manifestSha256"],"document":paddle::context(&sub),"documentBlockIds":record["sourceStructuring"]["plan"]["documentBlockIds"],"questions":source_questions,"targets":targets,"includeSourcePagesForReview":true,"imageReviewAvailable":true,"supplementVersion":SUPPLEMENT_VERSION});
    let input_hash = hash_json(&context);
    context["inputSha256"] = json!(input_hash);
    Ok(Some((context, sub)))
}

fn request_context(request: &Value) -> AppResult<Value> {
    let content = &request["body"]["messages"][1]["content"];
    let text = content.as_str().or_else(|| content.as_array().and_then(|a| a.iter().find(|p| p["type"] == "text")).and_then(|p| p["text"].as_str())).ok_or_else(changed)?;
    serde_json::from_str(text).map_err(|_| changed())
}

/// Descriptor presence is insufficient: replay checks the actual delivered PNGs.
fn verify_pixels(request: &Value, expected: &OcrDocument) -> AppResult<()> {
    let parts = request["body"]["messages"][1]["content"].as_array().ok_or_else(|| invalid("素材补核没有实际投递图片，未接受视觉归属。"))?;
    let mut delivered = vec![];
    for part in parts.iter().filter(|p| p["type"] == "image_url") {
        let encoded = s(&part["image_url"], "url").strip_prefix("data:image/png;base64,").ok_or_else(changed)?;
        let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| changed())?;
        delivered.push(sha(&bytes));
    }
    let mut expected_hashes: Vec<_> = expected.assets.iter().map(|a| s(a,"sha256").to_owned()).collect();
    delivered.sort(); expected_hashes.sort();
    if delivered != expected_hashes { return Err(invalid("素材补核实际图像与本次保留资产清单不一致。")); }
    Ok(())
}

fn append_unique(array: &mut Value, value: Value) -> AppResult<()> {
    let values = array.as_array_mut().ok_or_else(changed)?;
    if values.contains(&value) { return Err(changed()); }
    values.push(value);
    Ok(())
}

fn attach_asset(question:&mut Value,role:&str,asset:&Value)->AppResult<()> {
    let reference=json!({"assetId":asset["id"],"path":format!("ocr/{}.png",&hash_json(&asset["id"])[..32]),"sha256":asset["sha256"],"mimeType":asset["mimeType"],"alt":"原卷补充素材（呈现位置待核对）"});
    let mut payload=reference.clone();payload["role"]=json!(role);payload["dataBase64"]=asset["contentBase64"].clone();
    append_unique(&mut question[role]["assets"],reference)?;
    append_unique(&mut question["assetPayloads"],payload)
}

fn apply(raw: &Value, context: &Value, document: &OcrDocument, base: &[Value]) -> AppResult<Vec<Value>> {
    if !exact_keys(raw, &["sourceSha256","sourceManifestSha256","inputSha256","assignments","unresolvedIssues"])
        || raw["sourceSha256"] != context["sourceSha256"] || raw["sourceManifestSha256"] != context["sourceManifestSha256"]
        || raw["inputSha256"] != context["inputSha256"] {
        return Err(invalid("素材补核身份或返回合同不一致，未改动已保存题目。"));
    }
    let unresolved = raw["unresolvedIssues"].as_array().ok_or_else(changed)?;
    if !unresolved.is_empty() {
        return Err(err("source_material_supplement_unresolved", "模型仍有无法归属的保留素材，原件、成功批次及本次回复已保留，请核对后显式继续。"));
    }
    let assignments = raw["assignments"].as_array().ok_or_else(changed)?;
    if assignments.len() != rows(&context["targets"]).len() { return Err(invalid("素材补核遗漏或增加了资产。")); }
    let mut seen = HashSet::new();
    let mut all = base.to_vec();
    let known = blocks(document)?;
    for assignment in assignments {
        if !exact_keys(assignment, &["assetId","questionId","role","sourceBlockIds","basis","presentation","representedByAssetId","issues"])
            || !seen.insert(s(assignment,"assetId").to_owned())
            || !rows(&context["targets"]).iter().any(|a| a["assetId"] == assignment["assetId"])
            || s(assignment,"basis").trim().is_empty() || s(assignment,"basis").chars().count() > 2000 {
            return Err(invalid("素材补核包含未知、重复身份或缺少实际依据。"));
        }
        let asset = document.assets.iter().find(|a| a["id"] == assignment["assetId"]).ok_or_else(changed)?;
        let index = base.iter().position(|q| q["questionId"] == assignment["questionId"]).ok_or_else(changed)?;
        let original = &base[index];
        // Historical successful source batches legitimately omitted this field.
        // Normalize only the absent/null form, never conceal a malformed value
        // or replace the prefix of existing source issues.
        if all[index]["sourceIssues"].is_null() {all[index]["sourceIssues"]=json!([]);}
        if !all[index]["sourceIssues"].is_array() {return Err(changed());}
        let role = s(assignment,"role");
        let presentation = s(assignment,"presentation");
        if !matches!(role,"student"|"teacher"|"document") || !rows(&original["pages"]).contains(&asset["page"]) { return Err(invalid("素材补核题目、页码或角色无效。")); }
        let source_blocks = strict_ids(&assignment["sourceBlockIds"], &known, false)?;
        let allowed_blocks=if role=="document" {ids(&context["documentBlockIds"])} else {ids(&original["sourceBlockIds"])};
        if source_blocks.iter().any(|id| !allowed_blocks.contains(id) || !id.starts_with(&format!("p{}-b",asset["page"]))) {
            return Err(invalid("素材补核必须引用本题同页的真实原文块，不能猜造或借用其他题块。"));
        }
        let mut notices = assignment["issues"].as_array().ok_or_else(changed)?.clone();
        if notices.iter().any(|i| i.as_str().is_none_or(|t| t.trim().is_empty() || t.chars().count()>2000)) { return Err(changed()); }
        let mut material_role = json!({"assetId":asset["id"],"role":role,"sourceBlockIds":source_blocks,"basis":assignment["basis"],"requiresVisualReview":role!="document","supplementInputSha256":context["inputSha256"]});
        if presentation == "represented" {
            let representative = s(assignment,"representedByAssetId");
            let target = document.assets.iter().find(|a| s(a,"id")==representative).ok_or_else(changed)?;
            if role == "document" || asset["page"] != target["page"] || !rows(&original["sourceMaterialRoles"]).iter().any(|r| r["assetId"]==representative && r["role"]==role)
                || !rows(&original[role]["assets"]).iter().any(|a| a["assetId"]==representative) { return Err(invalid("代表图必须已在同题同角色实际呈现。")); }
            if let Some(offset)=paddle::exact_representation_offset(asset,target)? {
                material_role["representedByAssetId"] = json!(representative);
                material_role["representationOffset"] = json!(offset);
            } else {
                // Model aliasing is a proposal, never proof of equivalence.
                // Keep the exact model-selected ownership and both originals.
                attach_asset(&mut all[index],role,asset)?;
                material_role["suggestedRepresentativeAssetId"]=json!(representative);
                notices.push(json!(format!("模型建议由素材{representative}表示，但没有严格像素包含证据，已保留两图正常呈现，请核对重复内容及呈现位置。")));
            }
        } else if role == "document" {
            if presentation != "document" || !assignment["representedByAssetId"].is_null() { return Err(changed()); }
        } else {
            if presentation != format!("{role}_assets") || !assignment["representedByAssetId"].is_null() || notices.is_empty() {
                return Err(invalid("未绑定布局素材必须明确正常呈现位置并保留具体核对意见，不能静默当作无问题。"));
            }
            attach_asset(&mut all[index],role,asset)?;
        }
        append_unique(&mut all[index]["sourceMaterialRoles"], material_role)?;
        for notice in &notices {
            let issue = json!({"code":"ocr_material_supplement_review","page":asset["page"],"blocking":true,"message":format!("素材{}：{}",s(asset,"id"),notice.as_str().unwrap())});
            append_unique(&mut all[index]["sourceIssues"],issue)?;
        }
        let mut review_issues=rows(&all[index]["reviewIssues"]);
        for issue in question_issues(&all[index], &Value::Null) {if !review_issues.contains(&issue){review_issues.push(issue);}}
        all[index]["reviewIssues"] = json!(review_issues);
        crate::bank::verify_embedded_assets(&all[index])?;
        structured::verify_assets(&all[index])?;
    }
    // Every retained asset, including supplement output, still goes through
    // the normal whole-document check. No asset is removed from this domain.
    paddle::coverage(&mut all, document)?;
    Ok(all)
}

fn replay(store: &Store, record: &Value, document: &OcrDocument, base: &[Value], context: &Value, sub: &OcrDocument) -> AppResult<Vec<Value>> {
    let state = &record["sourceMaterialSupplement"];
    if state["version"] != SUPPLEMENT_VERSION || state["sourceSha256"] != record["source"]["sha256"]
        || state["manifestSha256"] != record["ocrSource"]["manifestSha256"] || state["inputHash"] != context["inputSha256"] || state["status"] != "completed" { return Err(changed()); }
    let attempt = rows(&state["attempts"]).last().cloned().ok_or_else(changed)?;
    if attempt["status"] != "succeeded" || attempt["contextHash"] != hash_json(context) { return Err(changed()); }
    verify_replay_origin(state,&attempt)?;
    let request = read_audit(store,&attempt["audit"],"request")?;
    if request_context(&request)? != *context { return Err(changed()); }
    verify_pixels(&request,sub)?;
    let transport=read_audit(store,&attempt["audit"],"transport")?;
    if transport["task"]!="question_import_materials" || transport["status"]!="completed" || transport["httpStatus"]!=200 {return Err(changed());}
    let raw = actual_result(store,&attempt,"question_import_materials",record)?;
    if state["resultHash"] != hash_json(&raw) || state["result"] != raw { return Err(changed()); }
    apply(&raw,context,document,base)
}

fn verify_replay_origin(state:&Value,attempt:&Value)->AppResult<()> {
    if attempt["kind"]!="local_validation_replay" {return Ok(());}
    let attempts=rows(&state["attempts"]);
    let original=attempts.iter().take(attempts.len().saturating_sub(1))
        .find(|a|hash_json(a)==attempt["originalAttemptHash"]).ok_or_else(changed)?;
    if original["kind"]=="local_validation_replay" || original["status"]!="failed"
        || original["operationId"]==attempt["operationId"] || original["audit"]!=attempt["audit"]
        || original["contextHash"]!=attempt["contextHash"] {return Err(changed());}
    Ok(())
}

/// A complete paid provider reply is reused after local validation changes.
/// The failed network attempt and all of its audit files remain immutable.
fn replayable_failed_attempt(store:&Store,state:&Value)->AppResult<Option<Value>> {
    let original=rows(&state["attempts"]).into_iter().rev().find(|a|a["kind"]!="local_validation_replay" && a["status"]=="failed");
    let Some(original)=original else{return Ok(None);};
    if s(&original["audit"],"responseRelativePath").is_empty() {return Ok(None);}
    let response=read_audit(store,&original["audit"],"response")?;
    if response["httpStatus"]!=200 || response["choices"][0]["finish_reason"]!="stop" {return Ok(None);}
    Ok(Some(original))
}

fn local_validation_replay(store:&Store,record:&mut Value,saved:&mut Value,document:&OcrDocument,base:&[Value],context:&Value,sub:&OcrDocument,original:&Value,op:&str,payload_hash:&str)->AppResult<Vec<Value>> {
    record["sourceMaterialSupplement"]["status"]=json!("running");
    record["sourceMaterialSupplement"]["attempts"].as_array_mut().ok_or_else(changed)?.push(json!({
        "kind":"local_validation_replay","modelCall":false,"operationId":op,"payloadHash":payload_hash,
        "originalAttemptHash":hash_json(original),"audit":original["audit"],"contextHash":hash_json(context),
        "status":"running","startedAt":now()
    }));
    persist(store,record,saved)?;
    let mut proposed=Value::Null;
    let outcome=(||->AppResult<Vec<Value>> {
        if original["contextHash"]!=hash_json(context) {return Err(changed());}
        let request=read_audit(store,&original["audit"],"request")?;
        if request_context(&request)?!=*context {return Err(changed());}
        verify_pixels(&request,sub)?;
        let transport=read_audit(store,&original["audit"],"transport")?;
        if transport["task"]!="question_import_materials" || transport["status"]!="completed" || transport["httpStatus"]!=200 {return Err(changed());}
        proposed=actual_result(store,original,"question_import_materials",record)?;
        apply(&proposed,context,document,base)
    })();
    let attempt=record["sourceMaterialSupplement"]["attempts"].as_array_mut().ok_or_else(changed)?.last_mut().ok_or_else(changed)?;
    attempt["status"]=json!(if outcome.is_ok(){"succeeded"}else{"failed"});
    attempt["finishedAt"]=json!(now());
    attempt["error"]=outcome.as_ref().err().map(|e|serde_json::to_value(e).unwrap()).unwrap_or(Value::Null);
    record["sourceMaterialSupplement"]["status"]=json!(if outcome.is_ok(){"completed"}else{"failed"});
    if outcome.is_ok(){record["sourceMaterialSupplement"]["resultHash"]=json!(hash_json(&proposed));record["sourceMaterialSupplement"]["result"]=proposed;}
    persist(store,record,saved)?;
    outcome
}

pub(super) fn verify(store: &Store, record: &Value, document: &OcrDocument, base: &[Value]) -> AppResult<Vec<Value>> {
    match input(record,document,base)? {
        None if record["sourceMaterialSupplement"].is_null() => Ok(base.to_vec()),
        Some((context,sub)) => replay(store,record,document,base,&context,&sub),
        _ => Err(changed()),
    }
}

pub(super) fn process(store: &Store, model: &ModelClient, record: &mut Value, saved: &mut Value, document: &OcrDocument, base: &[Value], cancel: &AtomicBool, op: &str, payload_hash: &str) -> AppResult<Vec<Value>> {
    let Some((context,sub)) = input(record,document,base)? else {
        if !record["sourceMaterialSupplement"].is_null() { return Err(changed()); }
        return Ok(base.to_vec());
    };
    if record["sourceMaterialSupplement"]["status"] == "completed" { return replay(store,record,document,base,&context,&sub); }
    if record["sourceMaterialSupplement"].is_null() {
        record["sourceMaterialSupplement"] = json!({"version":SUPPLEMENT_VERSION,"sourceSha256":record["source"]["sha256"],"manifestSha256":record["ocrSource"]["manifestSha256"],"inputHash":context["inputSha256"],"status":"pending","attempts":[]});
        persist(store,record,saved)?;
    }
    let state = &record["sourceMaterialSupplement"];
    if state["version"] != SUPPLEMENT_VERSION || state["sourceSha256"] != record["source"]["sha256"] || state["manifestSha256"] != record["ocrSource"]["manifestSha256"] || state["inputHash"] != context["inputSha256"] { return Err(changed()); }
    if rows(&state["attempts"]).iter().any(|a|a["operationId"]==op) { return Err(err("source_attempt_exists","本次素材补核已发起，请显式使用新的继续操作，未重复调用。")); }
    cancelled(cancel)?;
    if let Some(original)=replayable_failed_attempt(store,state)? {
        // A replay error is returned directly. It never falls through to HTTP.
        return local_validation_replay(store,record,saved,document,base,&context,&sub,&original,op,payload_hash);
    }
    if !model.import_review_images_supported() { return Err(err("source_material_images_required","当前来源模型无法实际查看保留图像，素材补核未发起；原件与成功批次保留。")); }
    cancelled(cancel)?;
    let path = path_for(store,record,op,"materials")?;
    if path.exists() || path.with_extension("request.json").exists() { return Err(changed()); }
    record["sourceMaterialSupplement"]["status"] = json!("running");
    record["sourceMaterialSupplement"]["attempts"].as_array_mut().ok_or_else(changed)?.push(json!({"operationId":op,"payloadHash":payload_hash,"contextHash":hash_json(&context),"status":"running","startedAt":now()}));
    persist(store,record,saved)?;
    let mut proposed = Value::Null;
    let mut outcome = model.propose_materials_with_audit(&context,&sub.assets,cancel,&path).and_then(|raw| {
        proposed=raw.clone();
        let request: Value = serde_json::from_slice(&std::fs::read(path.with_extension("request.json"))?)?;
        if request_context(&request)? != context { return Err(changed()); }
        verify_pixels(&request,&sub)?;
        apply(&raw,&context,document,base)
    });
    let mut audit = audit_files(store,&path)?;
    let transport=path.with_extension("transport.json");
    if transport.exists() {
        audit["transportRelativePath"]=json!(audit_relative_path(store,&transport.canonicalize()?)?);
        audit["transportSha256"]=json!(sha(&std::fs::read(&transport)?));
    }
    if outcome.is_ok() {
        let verified=(||->AppResult<()> {
            let attempt=json!({"audit":audit});
            if actual_result(store,&attempt,"question_import_materials",record)?!=proposed {return Err(changed());}
            let transport=read_audit(store,&audit,"transport")?;
            if transport["task"]!="question_import_materials" || transport["status"]!="completed" || transport["httpStatus"]!=200 {return Err(changed());}
            Ok(())
        })();
        if let Err(error)=verified {outcome=Err(error);}
    }
    let attempt = record["sourceMaterialSupplement"]["attempts"].as_array_mut().ok_or_else(changed)?.last_mut().ok_or_else(changed)?;
    attempt["audit"] = audit; attempt["finishedAt"] = json!(now());
    attempt["status"] = json!(if outcome.is_ok(){"succeeded"}else{"failed"});
    attempt["error"] = outcome.as_ref().err().map(|e|serde_json::to_value(e).unwrap()).unwrap_or(Value::Null);
    record["sourceMaterialSupplement"]["status"] = json!(if outcome.is_ok(){"completed"}else{"failed"});
    if outcome.is_ok() { record["sourceMaterialSupplement"]["resultHash"]=json!(hash_json(&proposed)); record["sourceMaterialSupplement"]["result"]=proposed; }
    persist(store,record,saved)?;
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    fn image_asset(id:&str,image:&image::RgbaImage,bbox:Value)->Value {
        let mut bytes=std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image.clone()).write_to(&mut bytes,image::ImageFormat::Png).unwrap();
        let bytes=bytes.into_inner();
        json!({"id":id,"page":1,"role":"figure","bbox":bbox,"mimeType":"image/png","sha256":sha(&bytes),"contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes),"width":image.width(),"height":image.height()})
    }
    fn fixture()->(Value,OcrDocument,Vec<Value>) {
        let big=image::RgbaImage::from_fn(5,5,|x,y|image::Rgba([(x*31) as u8,(y*37) as u8,(x*13+y*17) as u8,255]));
        let small=image::imageops::crop_imm(&big,1,2,2,2).to_image();
        let assets=vec![image_asset("simulated-group",&big,json!([0,0,5,5])),image_asset("simulated-orphan",&small,Value::Null)];
        let document=OcrDocument{pages:vec![json!({"page":1,"text":"1. 模拟素材回归题。","blocks":[{"id":1,"type":"text","text":"1. 模拟素材回归题。","assetId":"simulated-group","bbox":[0,0,5,5]}]})],assets,issues:vec![]};
        let record=json!({"importId":"simulated-materials","source":{"sha256":"a".repeat(64)},"ocrSource":{"manifestSha256":"b".repeat(64)},"sourceStructuring":{"plan":{"documentBlockIds":[]}}});
        let mut q=json!({"questionId":"simulated-materials-q1","sourceLabel":"1","questionType":"fill_blank","pages":[1],"sourceBlockIds":["p1-b1"],"sourceIdentity":{"system":"paddleocr_upload"},"stem":"模拟原题正文，不能改写。","options":[],"parts":[],"answer":"","solution":"","student":{"assets":[]},"teacher":{"assets":[]},"assetPayloads":[],"sourceMaterialRoles":[{"assetId":"simulated-group","role":"student","sourceBlockIds":["p1-b1"],"basis":"模拟已有来源绑定"}],"sourceMaterialRequirements":{"studentTables":[],"teacherTables":[]},"sourceIssues":[],"reviewIssues":[]});
        attach_asset(&mut q,"student",&document.assets[0]).unwrap();
        (record,document,vec![q])
    }
    fn response(context:&Value,presentation:&str)->Value {
        json!({"sourceSha256":context["sourceSha256"],"sourceManifestSha256":context["sourceManifestSha256"],"inputSha256":context["inputSha256"],"assignments":[{"assetId":"simulated-orphan","questionId":"simulated-materials-q1","role":"student","sourceBlockIds":["p1-b1"],"basis":"模拟实际原图与本题同页原文对照。","presentation":presentation,"representedByAssetId":if presentation=="represented" {json!("simulated-group")} else {Value::Null},"issues":if presentation=="represented" {json!([])} else {json!(["模拟图像可能重复，新增呈现位置需核对。"])}}],"unresolvedIssues":[]})
    }
    fn request(context:&Value,document:&OcrDocument)->Value {
        let mut content=vec![json!({"type":"text","text":context.to_string()})];
        for asset in &document.assets {content.push(json!({"type":"image_url","image_url":{"url":format!("data:image/png;base64,{}",s(asset,"contentBase64"))}}));}
        let body=json!({"messages":[{"role":"system","content":"模拟素材补核合同"},{"role":"user","content":content}]});
        json!({"task":"question_import_materials","redacted":false,"bodySha256":hash_json(&body),"promptSha256":hash_json(&body["messages"][0]["content"]),"body":body})
    }
    #[test]
    fn supplemental_assets_append_visible_references_without_rewriting_question_or_old_review_issues() {
        let (record,document,mut base)=fixture();base[0]["reviewIssues"]=json!([{"code":"simulated-old-warning","message":"已有问题保留"}]);
        let protected=base.clone();let (context,_)=input(&record,&document,&base).unwrap().unwrap();
        let result=apply(&response(&context,"student_assets"),&context,&document,&base).unwrap();
        assert_eq!(base,protected);assert_eq!(result[0]["stem"],base[0]["stem"]);assert_eq!(result[0]["sourceBlockIds"],base[0]["sourceBlockIds"]);
        assert_eq!(rows(&result[0]["student"]["assets"]).len(),2);assert_eq!(rows(&result[0]["assetPayloads"]).len(),2);
        assert!(rows(&result[0]["sourceIssues"]).iter().any(|i|i["blocking"]==true&&i["code"]=="ocr_material_supplement_review"));
        assert!(rows(&result[0]["reviewIssues"]).contains(&protected[0]["reviewIssues"][0]));
        assert!(!question_issues(&result[0],&Value::Null).is_empty());
    }
    #[test]
    fn historical_missing_or_null_source_issues_is_initialized_without_replacing_existing_prefix() {
        let (record,document,base)=fixture();
        for null in [false,true] {
            let mut old=base.clone();old[0].as_object_mut().unwrap().remove("sourceIssues");
            if null {old[0]["sourceIssues"]=Value::Null;}
            let (context,_)=input(&record,&document,&old).unwrap().unwrap();
            let all=apply(&response(&context,"student_assets"),&context,&document,&old).unwrap();
            assert_eq!(rows(&all[0]["sourceIssues"]).len(),1);
            assert!(old[0]["sourceIssues"].is_null());
        }
        let mut old=base.clone();old[0]["sourceIssues"]=json!([{"code":"simulated-existing","blocking":true,"message":"原有来源问题"}]);
        let (context,_)=input(&record,&document,&old).unwrap().unwrap();
        let all=apply(&response(&context,"student_assets"),&context,&document,&old).unwrap();
        assert_eq!(all[0]["sourceIssues"][0],old[0]["sourceIssues"][0]);assert_eq!(rows(&all[0]["sourceIssues"]).len(),2);
        for malformed in [json!("not-array"),json!({"wrong":"shape"}),json!(1)] {
            let mut bad=base.clone();bad[0]["sourceIssues"]=malformed;
            let (context,_)=input(&record,&document,&bad).unwrap().unwrap();assert!(apply(&response(&context,"student_assets"),&context,&document,&bad).is_err());
        }
    }
    #[test]
    fn represented_assets_require_exact_pixels_and_same_question_and_role() {
        let (record,document,base)=fixture();let (context,_)=input(&record,&document,&base).unwrap().unwrap();
        let raw=response(&context,"represented");let result=apply(&raw,&context,&document,&base).unwrap();
        assert_eq!(rows(&result[0]["student"]["assets"]).len(),1);
        assert_eq!(result[0]["sourceMaterialRoles"][1]["representationOffset"],json!([1,2]));
        let mut crossed=raw.clone();crossed["assignments"][0]["role"]=json!("teacher");assert!(apply(&crossed,&context,&document,&base).is_err());
        let mut forged=result.clone();forged[0]["sourceMaterialRoles"][1]["representationOffset"]=json!([0,0]);assert!(paddle::material_coverage(&mut forged,&document).is_err());
    }
    #[test]
    fn one_pixel_alias_difference_keeps_both_originals_and_blocks_publication_instead_of_guessing_equivalence() {
        let (record,mut document,base)=fixture();
        let bytes=base64::engine::general_purpose::STANDARD.decode(s(&document.assets[1],"contentBase64")).unwrap();
        let mut image=image::load_from_memory(&bytes).unwrap().to_rgba8();image.get_pixel_mut(0,0).0[0]+=1;
        document.assets[1]=image_asset("simulated-orphan",&image,Value::Null);
        let (context,_)=input(&record,&document,&base).unwrap().unwrap();
        let result=apply(&response(&context,"represented"),&context,&document,&base).unwrap();
        assert_eq!(rows(&result[0]["student"]["assets"]).len(),2);
        assert!(result[0]["sourceMaterialRoles"][1].get("representedByAssetId").is_none());
        assert_eq!(result[0]["sourceMaterialRoles"][1]["suggestedRepresentativeAssetId"],"simulated-group");
        assert!(!rows(&result[0]["sourceIssues"]).is_empty());
        assert!(s(&result[0]["sourceIssues"][0],"message").contains("没有严格像素包含证据"));
    }
    #[test]
    fn supplemental_scope_and_real_blocks_cannot_be_invented_or_omitted() {
        let (record,document,base)=fixture();let (context,_)=input(&record,&document,&base).unwrap().unwrap();
        for field in ["assetId","questionId"] {let mut raw=response(&context,"student_assets");raw["assignments"][0][field]=json!("unknown");assert!(apply(&raw,&context,&document,&base).is_err());}
        let mut raw=response(&context,"student_assets");raw["assignments"][0]["sourceBlockIds"]=json!(["p1-b99"]);assert!(apply(&raw,&context,&document,&base).is_err());
        let mut raw=response(&context,"student_assets");raw["assignments"]=json!([]);assert!(apply(&raw,&context,&document,&base).is_err());
        let mut raw=response(&context,"student_assets");raw["assignments"][0]["issues"]=json!([]);assert!(apply(&raw,&context,&document,&base).is_err());
        let mut raw=response(&context,"student_assets");raw["unresolvedIssues"]=json!(["模拟无法确定题目归属"]);assert!(apply(&raw,&context,&document,&base).is_err());
        let mut raw=response(&context,"student_assets");raw["assignments"][0]["stem"]=json!("偷偷改题");assert!(apply(&raw,&context,&document,&base).is_err());
    }
    #[test]
    fn saved_request_must_deliver_all_actual_pixels_not_just_asset_descriptors() {
        let (record,document,base)=fixture();let (context,sub)=input(&record,&document,&base).unwrap().unwrap();
        let actual=request(&context,&sub);verify_pixels(&actual,&sub).unwrap();
        let mut absent=actual.clone();absent["body"]["messages"][1]["content"]=json!(context.to_string());assert!(verify_pixels(&absent,&sub).is_err());
        let mut omitted=actual;omitted["body"]["messages"][1]["content"].as_array_mut().unwrap().pop();assert!(verify_pixels(&omitted,&sub).is_err());
    }
    #[test]
    fn completed_supplement_replays_actual_audits_without_touching_saved_batches_and_rejects_tampering() {
        let (mut record,document,base)=fixture();let (context,sub)=input(&record,&document,&base).unwrap().unwrap();
        let temp=tempfile::tempdir().unwrap();let store=Store::open(temp.path(),&crate::bank::tests::seed()).unwrap();
        std::fs::create_dir_all(store.data_dir.join("imports/simulated-materials")).unwrap();
        let path=path_for(&store,&record,"simulated-material-op","materials").unwrap();
        let raw=response(&context,"student_assets");
        std::fs::write(&path,json!({"choices":[{"finish_reason":"stop","message":{"content":raw.to_string()}}]}).to_string()).unwrap();
        std::fs::write(path.with_extension("request.json"),request(&context,&sub).to_string()).unwrap();
        let transport=path.with_extension("transport.json");std::fs::write(&transport,json!({"task":"question_import_materials","status":"completed","httpStatus":200}).to_string()).unwrap();
        let mut audit=audit_files(&store,&path).unwrap();audit["transportRelativePath"]=json!(audit_relative_path(&store,&transport.canonicalize().unwrap()).unwrap());audit["transportSha256"]=json!(sha(&std::fs::read(&transport).unwrap()));
        record["sourceMaterialSupplement"]=json!({"version":SUPPLEMENT_VERSION,"sourceSha256":record["source"]["sha256"],"manifestSha256":record["ocrSource"]["manifestSha256"],"inputHash":context["inputSha256"],"status":"completed","result":raw,"resultHash":hash_json(&raw),"attempts":[{"status":"succeeded","contextHash":hash_json(&context),"audit":audit}]});
        record["sourceStructuring"]["batches"]=json!([{"status":"succeeded","questions":base,"resultHash":"simulated-protected-cache"}]);
        let protected=record["sourceStructuring"].clone();
        let all=verify(&store,&record,&document,&base).unwrap();assert_eq!(rows(&all[0]["student"]["assets"]).len(),2);assert_eq!(record["sourceStructuring"],protected);
        let mut altered=record.clone();altered["sourceMaterialSupplement"]["result"]["assignments"][0]["role"]=json!("teacher");assert!(verify(&store,&altered,&document,&base).is_err());
        let mut altered=record.clone();altered["sourceMaterialSupplement"]["inputHash"]=json!("changed");assert!(verify(&store,&altered,&document,&base).is_err());
        std::fs::write(&path,b"{}").unwrap();assert!(verify(&store,&record,&document,&base).is_err());
    }
    #[test]
    fn explicit_local_validation_replay_reuses_complete_failed_reply_without_new_http_or_files() {
        let (mut record,document,mut base)=fixture();base[0].as_object_mut().unwrap().remove("sourceIssues");
        let (context,sub)=input(&record,&document,&base).unwrap().unwrap();
        let temp=tempfile::tempdir().unwrap();let store=Store::open(temp.path(),&crate::bank::tests::seed()).unwrap();
        std::fs::create_dir_all(store.data_dir.join("imports/simulated-materials")).unwrap();
        let path=path_for(&store,&record,"simulated-old-http","materials").unwrap();let raw=response(&context,"student_assets");
        std::fs::write(&path,json!({"httpStatus":200,"choices":[{"finish_reason":"stop","message":{"content":raw.to_string()}}]}).to_string()).unwrap();
        std::fs::write(path.with_extension("request.json"),request(&context,&sub).to_string()).unwrap();
        let transport=path.with_extension("transport.json");std::fs::write(&transport,json!({"task":"question_import_materials","status":"completed","httpStatus":200}).to_string()).unwrap();
        let mut audit=audit_files(&store,&path).unwrap();audit["transportRelativePath"]=json!(audit_relative_path(&store,&transport.canonicalize().unwrap()).unwrap());audit["transportSha256"]=json!(sha(&std::fs::read(&transport).unwrap()));
        let original=json!({"operationId":"simulated-old-http","contextHash":hash_json(&context),"status":"failed","audit":audit,"error":{"code":"source_checkpoint_changed"}});
        record["revision"]=json!(0);record["status"]=json!("failed");record["questions"]=json!([]);
        record["sourceStructuring"]["batches"]=json!([{"status":"succeeded","questions":base,"resultHash":"simulated-protected"}]);
        record["sourceMaterialSupplement"]=json!({"version":SUPPLEMENT_VERSION,"sourceSha256":record["source"]["sha256"],"manifestSha256":record["ocrSource"]["manifestSha256"],"inputHash":context["inputSha256"],"status":"failed","attempts":[original]});
        store.put_document("imports","simulated-materials",&record).unwrap();let mut saved=record.clone();
        let protected=record["sourceStructuring"].clone();
        let files=|| {let mut values=std::fs::read_dir(path.parent().unwrap()).unwrap().map(|e|{let p=e.unwrap().path();(p.file_name().unwrap().to_string_lossy().to_string(),sha(&std::fs::read(p).unwrap()))}).collect::<Vec<_>>();values.sort();values};
        let before_files=files();
        // This provider has no verified image support. Success is possible only
        // through local replay, before the normal model-call branch.
        let model=ModelClient::test_client(&store.data_dir,"http://127.0.0.1:1/v1");
        let all=process(&store,&model,&mut record,&mut saved,&document,&base,&AtomicBool::new(false),"simulated-new-local-op","simulated-payload").unwrap();
        assert_eq!(record["sourceStructuring"],protected);assert_eq!(record["sourceMaterialSupplement"]["attempts"][0],original);
        let replay_attempt=&record["sourceMaterialSupplement"]["attempts"][1];assert_eq!(replay_attempt["kind"],"local_validation_replay");assert_eq!(replay_attempt["modelCall"],false);assert_eq!(replay_attempt["originalAttemptHash"],hash_json(&original));
        assert_eq!(replay_attempt["audit"],original["audit"]);assert_eq!(record["sourceMaterialSupplement"]["result"],raw);assert_eq!(before_files,files());
        assert_eq!(verify(&store,&record,&document,&base).unwrap(),all);
        let mut forged=record.clone();forged["sourceMaterialSupplement"]["attempts"][1]["originalAttemptHash"]=json!("changed");assert!(verify(&store,&forged,&document,&base).is_err());
        // A failed local validation is also a terminal local result. It must
        // not fall through to an unsupported-provider error or a new request.
        record["sourceMaterialSupplement"]["status"]=json!("failed");record["sourceMaterialSupplement"]["attempts"]=json!([original]);
        record["sourceMaterialSupplement"].as_object_mut().unwrap().remove("result");record["sourceMaterialSupplement"].as_object_mut().unwrap().remove("resultHash");
        store.put_document("imports","simulated-materials",&record).unwrap();saved=record.clone();let mut invalid_base=base.clone();invalid_base[0]["sourceIssues"]=json!("bad-shape");
        let error=process(&store,&model,&mut record,&mut saved,&document,&invalid_base,&AtomicBool::new(false),"simulated-failed-local-op","simulated-second-payload").unwrap_err();
        assert_eq!(error.code,"source_checkpoint_changed");assert_eq!(record["sourceMaterialSupplement"]["attempts"][0],original);assert_eq!(record["sourceMaterialSupplement"]["attempts"][1]["kind"],"local_validation_replay");assert_eq!(record["sourceMaterialSupplement"]["attempts"][1]["status"],"failed");assert_eq!(before_files,files());
    }
}
