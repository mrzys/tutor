use super::*;

fn cache_document(
    store: &Store,
    record: &Value,
    file: &Value,
    settings: &OcrSettings,
    job: &str,
    cancel: &AtomicBool,
) -> AppResult<Value> {
    let directory = store
        .data_dir
        .join("student-work")
        .join(s(record, "workId"))
        .join("recognition")
        .join(format!("{}-{}", s(file, "fileId"), s(file, "sha256")));
    let cache = directory.join("material.json");
    if cache.exists() {
        return read_material(store, &cache, file);
    }
    cancelled(cancel)?;
    let (_, bytes) = read_file(store, record, s(file, "fileId"))?;
    let audit = store
        .data_dir
        .join("student-work")
        .join(s(record, "workId"))
        .join("attempts")
        .join(job)
        .join(format!("ocr-{}", s(file, "fileId")));
    // Filename is deliberately generated; local student/work metadata and the
    // uploaded filename never cross the recognition boundary.
    let document = ocr::recognize(
        settings,
        &bytes,
        &format!("{}.{}", s(file, "fileId"), s(file, "extension")),
        s(file, "mimeType"),
        &audit,
        cancel,
    )?;
    cancelled(cancel)?;
    if document.pages.is_empty() || document.pages.len() > 50 {
        return Err(err(
            "ocr_invalid_result",
            "未返回完整可定位页面，未开始判题。",
        ));
    }
    let expected_pages = if file["extension"] == "pdf" {
        lopdf::Document::load_mem(&bytes)
            .map_err(|_| err("invalid_file", "原PDF已无法读取。"))?
            .get_pages()
            .len()
    } else {
        1
    };
    if document.pages.len() != expected_pages
        || (1..=expected_pages).any(|page| !document.pages.iter().any(|p| p["page"] == page as u64))
    {
        return Err(err(
            "ocr_incomplete",
            "识别页码与原件页数不一致，未继续判题；原件已保留。",
        ));
    }
    std::fs::create_dir_all(&directory)?;
    let attempt = directory.join(format!("assets-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&attempt)?;
    let mut assets = vec![];
    let mut ids = HashSet::new();
    let mut total = 0usize;
    for (index, asset) in document.assets.iter().enumerate() {
        cancelled(cancel)?;
        if !ids.insert(s(asset, "id").to_owned()) || s(asset, "id").is_empty() {
            return Err(err("ocr_invalid_result", "识别图片身份无效。"));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(s(asset, "contentBase64"))
            .map_err(|_| err("ocr_invalid_result", "识别图片编码损坏。"))?;
        if sha(&bytes) != asset["sha256"]
            || bytes.len() > 25 * 1024 * 1024
            || !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        {
            return Err(err("ocr_invalid_result", "识别图片校验失败。"));
        }
        total += bytes.len();
        if total > 120 * 1024 * 1024 {
            return Err(err("ocr_invalid_result", "识别图片总量过大。"));
        }
        let path = attempt.join(format!("asset-{index}.png"));
        write_new(&path, &bytes)?;
        let relative = path
            .strip_prefix(&store.data_dir)
            .map_err(|_| err("integrity_error", "识别素材路径无效。"))?
            .to_string_lossy()
            .replace('\\', "/");
        assets.push(json!({"id":asset["id"],"page":asset["page"],"role":asset["role"],"sha256":asset["sha256"],"relativePath":relative,"width":asset["width"],"height":asset["height"],"mimeType":"image/png"}));
    }
    let mut seen_pages = HashSet::new();
    for page in &document.pages {
        if page["page"]
            .as_u64()
            .is_none_or(|p| p == 0 || p > 50 || !seen_pages.insert(p))
        {
            return Err(err("ocr_invalid_result", "识别页码缺失或重复。"));
        }
    }
    let material = json!({"schemaVersion":1,"sourceSha256":file["sha256"],"fileId":file["fileId"],"role":file["role"],"pages":document.pages,"assets":assets,"issues":document.issues,"recognizedAt":now(),"ocrModel":settings.public_settings()["model"]});
    let bytes = serde_json::to_vec(&json!({"material":material,"sha256":hash_json(&material)}))?;
    // Cache is immutable and tied to original bytes; never overwrite another
    // worker's completed recognition after cancellation/retry.
    let temporary = directory.join(format!("{}.tmp", uuid::Uuid::new_v4()));
    write_new(&temporary, &bytes)?;
    let committed = std::fs::hard_link(&temporary, &cache);
    let _ = std::fs::remove_file(temporary);
    match committed {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return read_material(store, &cache, file);
        }
        Err(error) => return Err(error.into()),
    }
    Ok(material)
}
fn read_material(store: &Store, path: &Path, descriptor: &Value) -> AppResult<Value> {
    let root = store.data_dir.join("student-work").canonicalize()?;
    let path = path.canonicalize()?;
    if !path.starts_with(&root) || std::fs::metadata(&path)?.len() > 12 * 1024 * 1024 {
        return Err(err("integrity_error", "识别材料路径或大小无效。"));
    }
    let bytes = std::fs::read(&path)?;
    let envelope: Value = serde_json::from_slice(&bytes)?;
    if envelope["sha256"] != hash_json(&envelope["material"]) {
        return Err(err(
            "integrity_error",
            "识别材料被修改，原件保留，未继续判题。",
        ));
    }
    let material = envelope["material"].clone();
    if material["sourceSha256"] != descriptor["sha256"]
        || material["fileId"] != descriptor["fileId"]
        || material["role"] != descriptor["role"]
    {
        return Err(err("integrity_error", "识别材料与答卷原件不匹配。"));
    }
    for asset in rows(&material["assets"]) {
        let file = store
            .data_dir
            .join(s(&asset, "relativePath"))
            .canonicalize()?;
        if !file.starts_with(path.parent().unwrap())
            || std::fs::metadata(&file)?.len() > 25 * 1024 * 1024
            || sha(&std::fs::read(file)?) != asset["sha256"]
        {
            return Err(err("integrity_error", "识别图片被修改或缺失，未继续判题。"));
        }
    }
    Ok(material)
}
fn cap(value: &Value) -> Value {
    value
        .as_f64()
        .filter(|v| v.is_finite() && *v > 0.0)
        .map_or(Value::Null, |v| json!(v))
}
pub(super) fn expected_items(record: &Value) -> AppResult<Vec<Value>> {
    if record["source"]["kind"] != "paper" {
        return Ok(vec![]);
    }
    let paper = &record["source"]["paperSnapshot"];
    assembly::verify_frozen_paper(paper)?;
    let scored = paper["draft"]["baseline"]["requirements"]["scoringMode"]
        .as_str()
        .is_some_and(|mode| mode != "none");
    let mut expected = vec![];
    let mut identities = HashSet::new();
    for slot in rows(&paper["draft"]["slots"]) {
        let sid = s(&slot, "slotId");
        if sid.is_empty() {
            return Err(err("integrity_error", "冻结成卷题位身份缺失。"));
        }
        let question = &slot["question"];
        let parts = rows(&question["student"]["parts"]);
        let target_parts = if parts.is_empty() {
            vec![Value::Null]
        } else {
            parts
        };
        for (part_index, part) in target_parts.into_iter().enumerate() {
            let pid = s(&part, "partId");
            if !part.is_null() && pid.is_empty() {
                return Err(err("integrity_error", "冻结成卷小问身份缺失。"));
            }
            let item_id = if pid.is_empty() {
                sid.to_owned()
            } else {
                format!("{sid}::{pid}")
            };
            if !identities.insert(item_id.clone()) {
                return Err(err("integrity_error", "冻结成卷题位或小问身份重复。"));
            }
            let reference = rows(&question["teacher"]["answers"])
                .into_iter()
                .filter(|a| {
                    if pid.is_empty() {
                        a["partId"].is_null() || matches!(s(a, "partId"), "" | "main")
                    } else {
                        s(a, "partId") == pid
                    }
                })
                .map(|a| s(&a, "text").to_owned())
                .collect::<Vec<_>>()
                .join("\n");
            let solutions = rows(&question["teacher"]["solutions"])
                .into_iter()
                .filter(|a| {
                    if pid.is_empty() {
                        a["partId"].is_null() || matches!(s(a, "partId"), "" | "main")
                    } else {
                        s(a, "partId") == pid
                    }
                })
                .map(|a| s(&a, "text").to_owned())
                .collect::<Vec<_>>();
            let max = if scored {
                if pid.is_empty() {
                    cap(&slot["points"])
                } else {
                    rows(&slot["partPoints"])
                        .iter()
                        .find(|p| s(p, "partId") == pid)
                        .map_or(Value::Null, |p| cap(&p["points"]))
                }
            } else {
                Value::Null
            };
            expected.push(json!({"itemId":item_id,"slotId":sid,"partId":if pid.is_empty(){Value::Null}else{json!(pid)},"questionType":question["questionType"],"questionLabel":if pid.is_empty(){slot["number"].to_string()}else if !s(&part,"label").is_empty(){format!("{} {}",slot["number"],s(&part,"label"))}else{format!("{}（{}）",slot["number"],part_index+1)},"questionText":format!("{}{}",s(&question["student"],"stem"),if part.is_null(){String::new()}else{format!("\n{}",s(&part,"prompt"))}),"options":question["student"]["options"],"referenceAnswer":reference,"referenceOrigin":"frozen_reference_not_official_guarantee","referenceSolutions":solutions,"maxPoints":max,"missingQuestion":!question.is_object(),"visualRequired":!rows(&question["student"]["assets"]).is_empty()||s(&question["student"],"stem").contains("asset:")}));
        }
    }
    if expected.is_empty() || expected.len() > 240 {
        return Err(err("invalid_work", "成卷没有可定位题目或小问数量超过240。"));
    }
    Ok(expected)
}
fn context_documents(materials: &[Value]) -> Vec<Value> {
    materials.iter().map(|m|json!({"fileId":m["fileId"],"role":m["role"],"pages":rows(&m["pages"]).iter().map(|p|json!({"page":p["page"],"text":p["text"],"blocks":rows(&p["blocks"]).iter().map(|b|json!({"id":b["id"],"type":b["type"],"text":b["text"],"bbox":b["bbox"]})).collect::<Vec<_>>()})).collect::<Vec<_>>(),"issues":m["issues"]})).collect()
}
fn evidence_valid(item: &Value, materials: &[Value]) -> bool {
    rows(&item["evidence"]).iter().any(|e| {
        let file = s(e, "fileId");
        let quote = s(e, "quote").trim();
        !quote.is_empty()
            && quote.chars().count() <= 3000
            && (s(item, "studentAnswer").is_empty() && s(item, "answerStatus") == "blank_confirmed"
                || compact(quote).contains(&compact(s(item, "studentAnswer"))))
            && materials.iter().any(|m| {
                m["fileId"] == file
                    && m["role"] == "answer"
                    && rows(&m["pages"])
                        .iter()
                        .any(|p| p["page"] == e["page"] && s(p, "text").contains(quote))
            })
    })
}
fn compact(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_whitespace() && *c != '$')
        .collect()
}
#[cfg(test)]
pub(super) fn normalize(
    raw: &Value,
    expected: &[Value],
    materials: &[Value],
    image_review: bool,
    force_unable: Option<&str>,
) -> AppResult<Value> {
    normalize_for_source(
        raw,
        expected,
        materials,
        image_review,
        force_unable,
        "legacy_external",
    )
}
fn actual_quote(e: &Value, materials: &[Value], source_preferred: bool) -> bool {
    let quote = s(e, "quote").trim();
    !quote.is_empty()
        && quote.chars().count() <= 3000
        && materials.iter().any(|m| {
            m["fileId"] == e["fileId"]
                && (!source_preferred || m["role"] == "source")
                && rows(&m["pages"])
                    .iter()
                    .any(|p| p["page"] == e["page"] && s(p, "text").contains(quote))
        })
}
fn plausible_question_fragment(question: &str, answer: &str) -> bool {
    let question = compact(question);
    let answer = compact(answer);
    if question.chars().count() < 3
        || question == answer
        || matches!(
            question.as_str(),
            "计算"
                | "计算："
                | "判断"
                | "判断："
                | "化简"
                | "化简："
                | "证明"
                | "证明："
                | "填空"
                | "填空："
                | "选择"
                | "选择："
        )
    {
        return false;
    }
    // A located number/letter/result is still an answer, not evidence that the
    // unseen original question was recovered. This is only a conservative
    // syntax boundary; the model must separately report actual completeness.
    if regex::Regex::new(r"^(?:第?[0-9]+[.、:：)）])?(?:答案|答|解|结果|学生作答)[:：]")
        .unwrap()
        .is_match(&question)
    {
        return false;
    }
    let only_answer=regex::Regex::new(r"(?i)^(?:(?:第?[0-9]+[.、:：)）])|(?:答案|答|结果|选项|学生作答)[:：]?|解[:：])*(?:[A-D]+|[+-]?[0-9]+(?:\.[0-9]+)?(?:/[+-]?[0-9]+(?:\.[0-9]+)?)?|[a-z]=[+-]?[0-9]+(?:\.[0-9]+)?|正确|错误|对|错|true|false|[{}｛｝0-9,.，、+-]+)[.。]?$" ).unwrap();
    if only_answer.is_match(&question) {
        return false;
    }
    [
        "求",
        "计算",
        "判断",
        "已知",
        "证明",
        "化简",
        "解",
        "下列",
        "以下",
        "选择",
        "填空",
        "函数",
        "方程",
        "不等式",
        "若",
        "设",
        "集合",
        "比较",
        "大小",
        "值",
        "几何",
        "三角",
        "角",
        "长",
        "面积",
        "周长",
        "体积",
    ]
    .iter()
    .any(|word| question.contains(word))
        || question.chars().any(|c| {
            matches!(
                c,
                '+' | '-'
                    | '×'
                    | '÷'
                    | '*'
                    | '/'
                    | '^'
                    | '√'
                    | '∈'
                    | '⊆'
                    | '<'
                    | '>'
                    | '≤'
                    | '≥'
                    | '='
            )
        })
}
pub(super) fn normalize_for_source(
    raw: &Value,
    expected: &[Value],
    materials: &[Value],
    image_review: bool,
    force_unable: Option<&str>,
    source_mode: &str,
) -> AppResult<Value> {
    let answer_only = expected.is_empty() && source_mode == "answer_only";
    let items = raw["items"]
        .as_array()
        .filter(|items| items.len() <= 240)
        .ok_or_else(|| err("invalid_grading", "模型没有返回有效逐题结果。"))?;
    let mut known = HashSet::new();
    let mut output = vec![];
    for raw_item in items {
        let id = s(raw_item, "itemId");
        if id.is_empty() || id.len() > 150 || !known.insert(id.to_owned()) {
            return Err(err(
                "invalid_grading",
                "模型返回重复或缺失的题目身份，未采纳。",
            ));
        }
        let expected_item = expected.iter().find(|item| item["itemId"] == id);
        if !expected.is_empty() && expected_item.is_none() {
            return Err(err("invalid_grading", "模型返回不存在的题位身份，未采纳。"));
        }
        if let Some(item) = expected_item {
            if raw_item["slotId"] != item["slotId"] || raw_item["partId"] != item["partId"] {
                return Err(err("invalid_grading", "模型题位或小问与冻结成卷不一致。"));
            }
        }
        let mut judgement = s(raw_item, "judgement");
        if !super::judgement(judgement) {
            return Err(err("invalid_grading", "模型判定类型无效。"));
        }
        let mut reason = text(raw_item, "reason", 6000)?;
        let answer = text(raw_item, "studentAnswer", 20000)?;
        let mut confidence = s(raw_item, "confidence");
        if !matches!(confidence, "high" | "medium" | "low") {
            confidence = "low"
        }
        let valid_evidence = evidence_valid(raw_item, materials);
        let source_present = materials.iter().any(|m| m["role"] == "source");
        let question_evidence: Vec<Value> = rows(&raw_item["questionEvidence"])
            .into_iter()
            .filter(|e| actual_quote(e, materials, source_present))
            .map(|e| json!({"fileId":e["fileId"],"page":e["page"],"quote":e["quote"]}))
            .collect();
        let external_question_present = if expected.is_empty() {
            let original = text(raw_item, "questionText", 30000)?;
            let needle = compact(&original);
            let located = needle.chars().count() >= 2
                && materials.iter().any(|m| {
                    (!source_present || m["role"] == "source")
                        && rows(&m["pages"])
                            .iter()
                            .any(|p| compact(s(p, "text")).contains(&needle))
                });
            located
                && (!answer_only
                    || (s(raw_item, "questionStatus") == "complete"
                        && plausible_question_fragment(&original, &answer)
                        && question_evidence
                            .iter()
                            .any(|e| compact(s(e, "quote")).contains(&needle))))
        } else {
            true
        };
        let unusable = force_unable.or_else(|| {
            if expected_item.is_some_and(|e| e["missingQuestion"] == true) {
                Some("本机成卷此题位缺少原题，无法批改。")
            } else if !external_question_present {
                Some(if answer_only {
                    "未能可靠定位完整题干，暂无法判断；可补充原题。"
                } else {
                    "未能在实际原题材料中定位对应题干，不能仅凭练习名或模型补写判题。"
                })
            } else if !valid_evidence {
                Some("缺少可定位的答卷原文证据，不能据此判断对错或空白。")
            } else if !matches!(
                s(raw_item, "answerStatus"),
                "recognized" | "blank_confirmed" | "unreadable" | "missing"
            ) {
                Some("模型没有提供有效的作答识别状态，保留为暂无法判断。")
            } else if matches!(s(raw_item, "answerStatus"), "unreadable" | "missing")
                || answer.is_empty() && judgement != "unanswered"
            {
                Some("实际作答未能可靠识别；未识别不能算错或未作答。")
            } else if judgement == "unanswered"
                && (!image_review || s(raw_item, "answerStatus") != "blank_confirmed")
            {
                Some("缺少原图空白作答证据，不能将识别缺项当作未作答。")
            } else if s(raw_item, "answerStatus") == "blank_confirmed"
                && !matches!(judgement, "unanswered" | "unable")
                || judgement == "unanswered" && !answer.is_empty()
            {
                Some("模型对空白与实际作答的描述相互矛盾，保留为暂无法判断。")
            } else if confidence == "low" {
                Some("模型自身置信不足，保留为暂无法判断。")
            } else {
                None
            }
        });
        if let Some(message) = unusable {
            judgement = "unable";
            reason = if answer_only {
                message.to_owned()
            } else {
                format!(
                    "{message}{}",
                    if reason.is_empty() {
                        String::new()
                    } else {
                        format!("\nAI说明：{reason}")
                    }
                )
            };
            confidence = "low";
        }
        let maximum = expected_item.map_or(Value::Null, |e| e["maxPoints"].clone());
        let earned = if judgement != "unable" {
            raw_item["earnedPoints"]
                .as_f64()
                .zip(maximum.as_f64())
                .filter(|(n, max)| n.is_finite() && *n >= 0.0 && n <= max)
                .map_or(Value::Null, |(n, _)| json!(n))
        } else {
            Value::Null
        };
        let mut evidence = vec![];
        for e in rows(&raw_item["evidence"]) {
            let file = s(&e, "fileId");
            if materials.iter().any(|m| {
                m["fileId"] == file
                    && !s(&e, "quote").trim().is_empty()
                    && rows(&m["pages"])
                        .iter()
                        .any(|p| p["page"] == e["page"] && s(p, "text").contains(s(&e, "quote")))
            }) {
                evidence
                    .push(json!({"fileId":file,"page":e["page"],"quote":text(&e,"quote",3000)?}));
            }
        }
        output.push(json!({"itemId":id,"slotId":expected_item.map_or(Value::Null,|e|e["slotId"].clone()),"partId":expected_item.map_or(Value::Null,|e|e["partId"].clone()),"questionLabel":if let Some(e)=expected_item{e["questionLabel"].clone()}else{json!(text(raw_item,"questionLabel",200)?)},"questionText":if let Some(e)=expected_item{e["questionText"].clone()}else{json!(text(raw_item,"questionText",30000)?)},"questionStatus":if expected_item.is_some(){json!("frozen")}else if answer_only&&!external_question_present{json!(if s(raw_item,"questionStatus")=="unreadable"{"unreadable"}else{"insufficient"})}else{raw_item.get("questionStatus").cloned().unwrap_or(Value::Null)},"questionEvidence":question_evidence,"studentAnswer":answer,"referenceAnswer":expected_item.map_or(Value::Null,|e|e["referenceAnswer"].clone()),"judgement":judgement,"reason":reason,"confidence":confidence,"evidence":evidence,"maxPoints":maximum,"earnedPoints":earned}));
    }
    for item in expected {
        if !known.contains(s(item, "itemId")) {
            output.push(json!({"itemId":item["itemId"],"slotId":item["slotId"],"partId":item["partId"],"questionLabel":item["questionLabel"],"questionText":item["questionText"],"studentAnswer":"","referenceAnswer":item["referenceAnswer"],"judgement":"unable","reason":"模型未返回此题位的可核对结果，保留为暂无法判断。","confidence":"low","evidence":[],"maxPoints":item["maxPoints"],"earnedPoints":null}));
        }
    }
    if output.is_empty() {
        if answer_only {
            return Ok(
                json!({"items":[{"itemId":"unlocated-answer","slotId":null,"partId":null,"questionLabel":"无法定位题目","questionText":"","questionStatus":"missing","questionEvidence":[],"studentAnswer":"","referenceAnswer":null,"judgement":"unable","reason":"未能可靠定位题干，暂无法判断；可补充原题或更清晰的答卷。","confidence":"low","evidence":[],"maxPoints":null,"earnedPoints":null}],"summary":"未能可靠定位题干，暂无法判断。","coverage":"answer_materials_only","completePaperVerified":false,"limitations":["未提供独立原题材料，不表示答卷含完整题干。","未识别不能按错题或未作答计算。"],"totalScore":null}),
            );
        }
        return Err(err(
            "invalid_grading",
            "没有可定位的题目结果，原件和识别材料已保留。",
        ));
    }
    Ok(
        json!({"items":output,"summary":if answer_only{if output.iter().all(|i|i["judgement"]=="unable"){"暂无法可靠批改，请补充清晰题干或原题材料。".to_owned()}else{"已对可定位的作答给出建议；缺少题干或证据的项目保留无法判断。".to_owned()}}else{text(raw,"summary",4000)?},"coverage":if answer_only{"answer_materials_only"}else if expected.is_empty(){"external_unverified"}else{"frozen_expected_items"},"completePaperVerified":!expected.is_empty()&&output.iter().all(|i|i["judgement"]!="unable"),"limitations":["AI建议未经教师逐题确认，置信度不是正确率，不代表学情结论。",if answer_only{"仅上传答卷不表示题干完整；题干不足时无法判断，可按需补充原题。"}else if expected.is_empty(){"外部练习题目总数及完整性未经独立核验，不宣称完成全卷。"}else{"题位身份来自冻结成卷；未识别和缺证题目保留无法判断。"}],"totalScore":null}),
    )
}
pub(super) fn grade(
    store: &Store,
    id: &str,
    job: &str,
    model: &ModelClient,
    settings: &OcrSettings,
    cancel: &AtomicBool,
) -> AppResult<Value> {
    let record = set_stage(store, id, job, "recognizing")?;
    verify(&record)?;
    let mut materials = vec![];
    let mut model_assets = vec![];
    let mut has_visual = false;
    let mut source_incomplete = false;
    let mut total_text = 0usize;
    for file in all_files(&record) {
        cancelled(cancel)?;
        let material = cache_document(store, &record, &file, settings, job, cancel)?;
        for page in rows(&material["pages"]) {
            total_text += s(&page, "text").chars().count();
        }
        if total_text > 400_000 {
            return Err(err("work_too_large", "识别文字超过40万字，请分拆练习。"));
        }
        source_incomplete |= rows(&material["issues"])
            .iter()
            .any(|i| i["blocking"] == true);
        has_visual |= rows(&material["assets"])
            .iter()
            .any(|a| a["role"] != "source_page");
        if model.grading_images_supported() {
            for asset in rows(&material["assets"]) {
                let bytes = std::fs::read(store.data_dir.join(s(&asset, "relativePath")))?;
                model_assets.push(json!({"id":format!("{}-{}",s(&file,"fileId"),s(&asset,"id")),"page":asset["page"],"role":asset["role"],"contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes)}));
            }
        }
        materials.push(material);
    }
    cancelled(cancel)?;
    let expected = expected_items(&record)?;
    has_visual |= expected.iter().any(|i| i["visualRequired"] == true);
    if record["source"]["kind"] == "paper" && model.grading_images_supported() {
        for slot in rows(&record["source"]["paperSnapshot"]["draft"]["slots"]) {
            for asset in rows(&slot["question"]["assetPayloads"]) {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(s(&asset, "dataBase64"))
                    .map_err(|_| err("integrity_error", "冻结题目配图编码损坏。"))?;
                if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                    source_incomplete = true;
                    continue;
                }
                model_assets.push(json!({"id":format!("paper-{}-{}-{}",s(&slot,"slotId"),s(&asset,"role"),s(&asset,"assetId")),"page":1,"role":"figure","contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes)}));
            }
        }
    }
    let image_review = model.grading_images_supported() && !model_assets.is_empty();
    let force = if source_incomplete {
        Some("识别材料含缺图、漏页或解析不完整提示，暂不能可靠判题。")
    } else if has_visual && !image_review {
        Some("本练习含必要图表，当前模型没有接收实际配图，保留为无法判断。")
    } else {
        None
    };
    set_stage(store, id, job, "grading")?;
    let context = json!({"schemaVersion":1,"sourceMode":record["source"]["kind"],"externalSourceMode":record["source"]["externalSourceMode"],"questionCompleteness":if record["source"]["externalSourceMode"]=="answer_only"{"not_asserted"}else if record["source"]["kind"]=="paper"{"frozen_snapshot"}else{"provided_or_declared_not_verified"},"expectedItems":expected,"documents":context_documents(&materials),"imageReviewAvailable":image_review,"includeSourcePagesForReview":true,"contentLimitations":force});
    // Only this deliberately assembled academic context is sent.
    // Local student, title, notes, dates, paths and uploaded filenames stay local.
    let input_hash = hash_json(&context);
    let directory = store
        .data_dir
        .join("student-work")
        .join(id)
        .join("attempts")
        .join(job);
    std::fs::create_dir_all(&directory)?;
    let snapshot = json!({"jobId":job,"bindingSha256":record["bindingSha256"],"context":context,"inputSha256":input_hash,"model":{"activeProfileId":model.public_settings()["activeProfileId"],"baseUrl":model.public_settings()["baseUrl"],"model":model.public_settings()["model"]},"createdAt":now()});
    write_new(
        &directory.join("input.json"),
        &serde_json::to_vec(&snapshot)?,
    )?;
    let raw = model.grade_student_work(
        &context,
        &model_assets,
        cancel,
        &directory.join("provider-response.json"),
    )?;
    cancelled(cancel)?;
    write_new(
        &directory.join("raw-result.json"),
        &serde_json::to_vec(&raw)?,
    )?;
    let mut result = normalize_for_source(
        &raw,
        &expected,
        &materials,
        image_review,
        force,
        s(&record["source"], "externalSourceMode"),
    )?;
    result["jobId"] = json!(job);
    result["inputSha256"] = json!(input_hash);
    result["model"] = snapshot["model"].clone();
    result["gradedAt"] = json!(now());
    result["imageReviewAvailable"] = json!(image_review);
    Ok(result)
}
