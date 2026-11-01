//! Source-bound bridge between OCR material and pending, explicitly reviewed questions.
use super::*;

pub(super) fn uses(q: &Value) -> bool {
    q["sourceIdentity"]["system"] == "paddleocr_upload"
}
pub(super) fn document_extension(extension: &str) -> bool {
    matches!(extension, "pdf" | "docx")
}

pub(super) fn verify_audit(store: &Store, record: &Value) -> AppResult<()> {
    if record["renderedPdf"].is_object() {
        read_rendered_pdf(store, record)?;
    }
    let source = &record["ocrSource"];
    if !source.is_object() {
        return Ok(());
    }
    let root = store.data_dir.join("imports").canonicalize()?;
    let path = store
        .data_dir
        .join(s(source, "manifestRelativePath"))
        .canonicalize()?;
    if !path.starts_with(&root) {
        return Err(err("source_changed", "识别材料路径无效。"));
    }
    let bytes = std::fs::read(&path)?;
    if bytes.len() > 8 * 1024 * 1024 || sha(&bytes) != s(source, "manifestSha256") {
        return Err(err(
            "source_changed",
            "识别材料校验失败，请保留原件重新导入。",
        ));
    }
    let manifest: Value = serde_json::from_slice(&bytes)?;
    if manifest["sourceSha256"] != record["source"]["sha256"]
        || manifest["assets"] != source["assets"]
        || manifest["pages"] != source["pages"]
    {
        return Err(err("source_changed", "识别材料与原文件不匹配。"));
    }
    for asset in rows(&manifest["assets"]) {
        let path = store
            .data_dir
            .join(s(&asset, "relativePath"))
            .canonicalize()?;
        if !path.starts_with(&root) || std::fs::metadata(&path)?.len() > 20 * 1024 * 1024 {
            return Err(err("source_changed", "识别配图范围或大小无效。"));
        }
        if sha(&std::fs::read(path)?) != asset["sha256"] {
            return Err(err(
                "source_changed",
                "识别配图校验失败，未继续审核或发布。",
            ));
        }
    }
    source_batches::verify_material_review_inputs(store,record)?;
    Ok(())
}
pub(super) fn read_rendered_pdf(store: &Store, record: &Value) -> AppResult<Vec<u8>> {
    let rendered = &record["renderedPdf"];
    if record["source"]["extension"] != "docx"
        || rendered["sourceSha256"] != record["source"]["sha256"]
    {
        return Err(err("source_changed", "转换 PDF 与 DOCX 原件不匹配。"));
    }
    let root = store.data_dir.join("imports").canonicalize()?;
    let path = store
        .data_dir
        .join(s(rendered, "relativePath"))
        .canonicalize()?;
    if !path.starts_with(root) || std::fs::metadata(&path)?.len() > 50 * 1024 * 1024 {
        return Err(err("source_changed", "转换 PDF 路径或大小无效。"));
    }
    let bytes = std::fs::read(path)?;
    if sha(&bytes) != rendered["sha256"] || !bytes.starts_with(b"%PDF-") {
        return Err(err("source_changed", "转换 PDF 校验失败，原件已保留。"));
    }
    Ok(bytes)
}
pub(super) fn load_document(store: &Store, record: &Value) -> AppResult<crate::ocr::OcrDocument> {
    verify_audit(store, record)?;
    let bytes = std::fs::read(
        store
            .data_dir
            .join(s(&record["ocrSource"], "manifestRelativePath")),
    )?;
    let manifest: Value = serde_json::from_slice(&bytes)?;
    let mut assets = rows(&manifest["assets"]);
    for asset in &mut assets {
        let bytes = std::fs::read(store.data_dir.join(s(asset, "relativePath")))?;
        asset["contentBase64"] = json!(base64::engine::general_purpose::STANDARD.encode(bytes));
    }
    Ok(crate::ocr::OcrDocument {
        pages: rows(&manifest["pages"]),
        assets,
        issues: rows(&manifest["issues"]),
    })
}

pub(super) fn save_document(
    store: &Store,
    record: &mut Value,
    document: &crate::ocr::OcrDocument,
    directory: &Path,
    descriptor: Value,
) -> AppResult<()> {
    let assets_dir = directory.join("preserved-assets");
    std::fs::create_dir(&assets_dir)?;
    let mut assets = vec![];
    let mut known = HashSet::new();
    for asset in &document.assets {
        let id = s(asset, "id");
        if id.is_empty() || !known.insert(id.to_owned()) {
            return Err(err("ocr_invalid_result", "识别素材身份缺失或重复。"));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(s(asset, "contentBase64"))
            .map_err(|_| err("ocr_invalid_result", "识别素材编码损坏。"))?;
        if bytes.is_empty() || bytes.len() > 20 * 1024 * 1024 || sha(&bytes) != asset["sha256"] {
            return Err(err("ocr_invalid_result", "识别素材内容或哈希无效。"));
        }
        let name = format!("{}.png", &hash_json(&json!(id))[..32]);
        let path = assets_dir.join(name);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        let mut metadata = asset.clone();
        metadata
            .as_object_mut()
            .ok_or_else(|| err("ocr_invalid_result", "素材信息无效。"))?
            .remove("contentBase64");
        metadata.as_object_mut().unwrap().remove("sourcePath");
        metadata["relativePath"] = json!(audit_relative_path(store, &path)?);
        assets.push(metadata);
    }
    let manifest = json!({"schemaVersion":1,"sourceSha256":record["source"]["sha256"],"provider":descriptor,"pages":document.pages,"assets":assets,"issues":document.issues});
    let bytes = serde_json::to_vec(&manifest)?;
    let path = directory.join("source-manifest.json");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    record["ocrSource"] = json!({"provider":"paddleocr","manifestRelativePath":audit_relative_path(store,&path)?,"manifestSha256":sha(&bytes),"sourceSha256":record["source"]["sha256"],"pages":document.pages,"assets":assets});
    Ok(())
}

pub(super) fn context(document: &crate::ocr::OcrDocument) -> Value {
    let mut assets = document.assets.clone();
    for asset in &mut assets {
        if let Some(o) = asset.as_object_mut() {
            o.remove("contentBase64");
            o.remove("sourcePath");
        }
    }
    let required_material_assets = document.assets.iter().filter(|asset| asset["role"]!="source_page").map(|asset| {
        let block_ids = document.pages.iter().filter(|p|p["page"]==asset["page"]).flat_map(|p|rows(&p["blocks"])).filter(|b|b["assetId"]==asset["id"] || asset["bbox"].is_array() && b["bbox"]==asset["bbox"]).filter_map(|b|b["id"].as_u64()).map(|id|format!("p{}-b{id}",asset["page"])).collect::<Vec<_>>();
        json!({"assetId":asset["id"],"page":asset["page"],"role":asset["role"],"sourceBlockIds":block_ids})
    }).collect::<Vec<_>>();
    json!({"provider":"paddleocr","pages":document.pages,"assets":assets,"sourceIssues":document.issues,"requiredMaterialAssets":required_material_assets,
      "instructions":"逐页读取原始Markdown及版面块，不将null顺序当作0。页脚可能包含跨页题号，按题号及内容核对，不省略。题目保留sourceBlockIds（p{page}-b{原id}），只能引用实际块。所有图片引用保留asset:真实id；表格逐行逐格保留，原空格不得填值。逐项用materialRoles说明每个实际非source_page素材属于student题面、teacher答案解析或document非题目资料，给出真实sourceBlockIds和basis，不根据页标题把整页所有图统一归类。图片未实际可见且文字不足以证实归属时检查意见保留needs_review。原始整页不能作为学生题图。附录公式和表格是题目材料，不能省略。没有原文答案或完整解法时保持缺项。"})
}

fn text(q: &Value, teacher: bool) -> String {
    let mut fields = if teacher {
        vec![s(q, "answer").to_owned(), s(q, "solution").to_owned()]
    } else {
        vec![s(q, "stem").to_owned()]
    };
    if !teacher {
        fields.extend(rows(&q["options"]).iter().map(|o| s(o, "text").to_owned()));
    }
    for part in rows(&q["parts"]) {
        if teacher {
            fields.push(s(&part, "answer").into());
            fields.push(s(&part, "solution").into());
        } else {
            fields.push(s(&part, "prompt").into());
        }
    }
    fields.join("\n")
}
fn references(value: &str) -> Vec<String> {
    let re = regex::Regex::new(r#"!\[[^\]]*\]\(([^)]+)\)|(?i:<img\s[^>]*src=[\"']([^\"']+)[\"'])"#)
        .unwrap();
    re.captures_iter(value)
        .filter_map(|c| c.get(1).or_else(|| c.get(2)))
        .map(|m| m.as_str().trim().trim_start_matches("asset:").to_owned())
        .collect()
}
fn table_shapes(q: &Value, teacher: bool) -> Value {
    json!(
        tables(&text(q, teacher))
            .iter()
            .map(|table| table
                .iter()
                .map(|row| row
                    .iter()
                    .map(|(rs, cs, _)| json!([rs, cs]))
                    .collect::<Vec<_>>())
                .collect::<Vec<_>>())
            .collect::<Vec<_>>()
    )
}
pub(super) fn material_issues(q: &Value) -> Vec<Value> {
    if !uses(q) {
        return vec![];
    }
    let baseline = &q["sourceMaterialRequirements"];
    if !baseline.is_object()
        || baseline["studentTables"] != table_shapes(q, false)
        || baseline["teacherTables"] != table_shapes(q, true)
    {
        return vec![issue(
            "ocr_material_structure_changed",
            0,
            "原卷表格的行、列或合并单元格发生变化，不能确认入库；请恢复完整结构。单元格文字和数值可核对后更正。",
        )];
    }
    vec![]
}
pub(super) fn bind(
    question: &mut Value,
    proposed: &Value,
    document: &crate::ocr::OcrDocument,
    source_sha: &str,
    manifest_sha: &str,
) -> AppResult<()> {
    let known_blocks: HashSet<_> = document.pages.iter()
        .filter(|p| rows(&question["pages"]).contains(&p["page"]))
        .flat_map(|p| rows(&p["blocks"]).into_iter().map(move |b| format!("p{}-b{}",p["page"],b["id"])))
        .collect();
    let mut material_roles = vec![];
    let mut role_ids = HashSet::new();
    for assignment in rows(&proposed["materialRoles"]) {
        let asset = document.assets.iter().find(|asset| asset["id"] == assignment["assetId"])
            .ok_or_else(|| err("ocr_material_role", "素材归属使用了不存在的素材身份。"))?;
        let blocks = ids(&assignment["sourceBlockIds"]);
        let asset_blocks: HashSet<_> = document.pages.iter().filter(|page|page["page"]==asset["page"])
            .flat_map(|page|rows(&page["blocks"]).into_iter().filter(|block|block["assetId"]==asset["id"] || asset["bbox"].is_array() && block["bbox"]==asset["bbox"]).map(move |block|format!("p{}-b{}",page["page"],block["id"]))).collect();
        if asset["role"] == "source_page" || !rows(&question["pages"]).contains(&asset["page"])
            || !role_ids.insert(s(&assignment,"assetId").to_owned())
            || !matches!(s(&assignment,"role"), "student"|"teacher"|"document")
            || s(&assignment,"basis").trim().is_empty() || s(&assignment,"basis").chars().count() > 2000
            || blocks.is_empty() || blocks.len() != rows(&assignment["sourceBlockIds"]).len()
            || blocks.iter().any(|block| !known_blocks.contains(block))
            || !blocks.iter().any(|block| asset_blocks.contains(block)) {
            return Err(err("ocr_material_role", "素材归属缺少有效的角色、原文块或依据，原件保留，请重新整理。"));
        }
        material_roles.push(json!({"assetId":assignment["assetId"],"role":assignment["role"],"sourceBlockIds":blocks,"basis":assignment["basis"],"requiresVisualReview":asset["role"]=="figure"}));
    }
    let mut payloads = vec![];
    for (role, teacher) in [("student", false), ("teacher", true)] {
        let mut refs = vec![];
        let mut seen = HashSet::new();
        for id in references(&text(question, teacher)) {
            if !seen.insert(id.clone()) {
                continue;
            }
            let asset = document
                .assets
                .iter()
                .find(|a| a["id"] == id)
                .ok_or_else(|| err("ocr_asset_unresolved", "题目引用了识别结果中不存在的配图。"))?;
            if asset["role"] == "source_page" || !rows(&question["pages"]).contains(&asset["page"])
            {
                return Err(err(
                    "ocr_asset_unresolved",
                    "题目配图不属于所标注的来源页。",
                ));
            }
            if !material_roles.iter().any(|assignment| assignment["assetId"] == id && assignment["role"] == role) {
                return Err(err("ocr_material_role", "素材实际引用位置与模型给出的原文角色不一致，未继续导入。"));
            }
            let reference = json!({"assetId":id,"path":format!("ocr/{}.png",&hash_json(&json!(id))[..32]),"sha256":asset["sha256"],"mimeType":asset["mimeType"],"alt":if asset["role"]=="table"{"原卷表格"}else{"原卷配图"}});
            let mut payload = reference.clone();
            payload["role"] = json!(role);
            payload["dataBase64"] = asset["contentBase64"].clone();
            payloads.push(payload);
            refs.push(reference);
        }
        question[role] = json!({"assets":refs});
    }
    let blocks = ids(&proposed["sourceBlockIds"]);
    if blocks.iter().any(|id| !known_blocks.contains(id)) {
        return Err(err("ocr_invalid_source", "模型返回了不存在的原文块。"));
    }
    question["sourceBlockIds"] = json!(blocks);
    question["sourceMaterialRoles"] = json!(material_roles);
    question["sourceIdentity"] = json!({"system":"paddleocr_upload","sourceSha256":source_sha,"manifestSha256":manifest_sha});
    question["sourceMaterialRequirements"] = json!({"studentTables":table_shapes(question,false),"teacherTables":table_shapes(question,true)});
    question["assetPayloads"] = json!(payloads);
    crate::bank::verify_embedded_assets(question)?;
    structured::verify_assets(question)?;
    Ok(())
}
pub(super) fn preserve(out: &mut Value, input: &Value) -> AppResult<()> {
    if !uses(input) {
        return Ok(());
    }
    for key in [
        "sourceIdentity",
        "sourceBlockIds",
        "student",
        "teacher",
        "assetPayloads",
        "sourceIssues",
        "sourceMaterialRequirements",
        "sourceMaterialRoles",
    ] {
        if let Some(value) = input.get(key) {
            out[key] = value.clone();
        }
    }
    crate::bank::verify_embedded_assets(out)?;
    structured::verify_assets(out)
}

fn number(label: &str) -> Option<String> {
    regex::Regex::new(r"^\s*(?:第\s*)?([1-9]\d{0,2})(?:\s*题)?[.、．]?\s*$")
        .unwrap()
        .captures(label)
        .and_then(|c| c[1].parse::<u32>().ok())
        .map(|n| n.to_string())
}
// Only an explicit whole-question identity may retain the parentheses printed
// around its number. Keep `number` strict for OCR anchor and scored-title scans:
// accepting these there would also promote parenthesized subparts to questions.
fn source_label_number(label: &str) -> Option<String> {
    number(label).or_else(|| {
        let label = label.trim();
        let inner = label
            .strip_prefix('(')
            .and_then(|v| v.strip_suffix(')'))
            .or_else(|| {
                label
                    .strip_prefix('（')
                    .and_then(|v| v.strip_suffix('）'))
            })?
            .trim();
        if inner.is_empty()
            || inner.len() > 3
            || inner.starts_with('0')
            || !inner.bytes().all(|b| b.is_ascii_digit())
        {
            return None;
        }
        Some(inner.to_owned())
    })
}
fn expected_question_numbers(document: &crate::ocr::OcrDocument) -> HashSet<String> {
    let line_number = regex::Regex::new(
        r"(?m)^[ \t]*(?:#{1,6}[ \t]*)?(?:[（(][ \t]*([1-9]\d{0,2})[ \t]*[）)]|([1-9]\d{0,2})(?:\\?\.|、|．|[ \t]+[\p{Han}A-Za-z$（(]))",
    )
    .unwrap();
    // OCR may join a section heading and its first scored question in Markdown,
    // while retaining the question on a separate layout line. Only recognize
    // the explicit scored title here, not arbitrary numbers in a long block.
    // In particular, UTF-8 byte length is not a question-identity boundary.
    let scored_title = regex::Regex::new(
        r"^[ \t]*(?:#{1,6}[ \t]*)?(?:第[ \t]*)?([1-9]\d{0,2})(?:[ \t]*题)?(?:\\?\.|、|．)?[ \t]*[（(][ \t]*(?:本(?:小)?题[ \t]*)?(?:满分[ \t]*)?[1-9]\d*(?:\.\d+)?[ \t]*分[ \t]*[）)][ \t]*$",
    )
    .unwrap();
    let merged_section = regex::Regex::new(
        r"^[ \t]*(?:#{1,6}[ \t]*)?[一二三四五六七八九十]+[、．.](?:[^\r\n$=+*/\\]*?[^\d\r\n$=+*/\\])?([1-9]\d{0,2}[.、．][ \t]*[（(](?:本(?:小)?题|满分)[^\r\n]*)$",
    )
    .unwrap();
    let mut expected = HashSet::new();
    for page in &document.pages {
        for c in line_number.captures_iter(s(page, "text")) {
            if let Some(n) = c
                .get(1)
                .or_else(|| c.get(2))
                .and_then(|m| number(m.as_str()))
            {
                expected.insert(n);
            }
        }
        for body in std::iter::once(s(page, "text")).chain(
            rows(&page["blocks"])
                .iter()
                .map(|block| s(block, "text")),
        ) {
            for line in body.lines() {
                let merged = merged_section.captures(line);
                let title = merged
                    .as_ref()
                    .and_then(|c| c.get(1))
                    .map_or(line, |m| m.as_str());
                if let Some(n) = scored_title
                    .captures(title)
                    .and_then(|c| number(&c[1]))
                {
                    expected.insert(n);
                }
            }
        }
    }
    expected
}
pub(super) fn coverage(
    questions: &mut [Value],
    document: &crate::ocr::OcrDocument,
) -> AppResult<()> {
    coverage_with_source_reviews(questions,document,&[],&HashSet::new(),&[])
}
pub(super) fn coverage_with_source_reviews(
    questions: &mut [Value], document: &crate::ocr::OcrDocument,
    tables_reviewed: &[Value], document_assets: &HashSet<String>, contained_assets:&[Value],
) -> AppResult<()> {
    let expected = expected_question_numbers(document);
    let mut actual = HashSet::new();
    for q in questions.iter() {
        if let Some(n) = source_label_number(s(q, "sourceLabel")) {
            if !actual.insert(n.clone()) {
                return Err(err(
                    "ocr_question_coverage",
                    &format!("原卷第 {n} 题被重复整理，未保存重复题目；请核对原卷后重新解析。"),
                ));
            }
        } else {
            return Err(err(
                "ocr_question_coverage",
                "拆题结果缺少原题号，原文件与识别结果已保留。",
            ));
        }
    }
    if !expected.is_empty() && expected != actual {
        let sorted = |values: Vec<&String>| {
            let mut values = values
                .into_iter()
                .filter_map(|v| v.parse::<u32>().ok())
                .collect::<Vec<_>>();
            values.sort_unstable();
            values
                .into_iter()
                .map(|n| n.to_string())
                .collect::<Vec<_>>()
                .join("、")
        };
        let missing = sorted(expected.difference(&actual).collect());
        let extra = sorted(actual.difference(&expected).collect());
        let detail = [
            if missing.is_empty() {
                String::new()
            } else {
                format!("缺少第 {missing} 题")
            },
            if extra.is_empty() {
                String::new()
            } else {
                format!("多出第 {extra} 题")
            },
        ]
        .into_iter()
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>()
        .join("；");
        return Err(err(
            "ocr_question_coverage",
            &format!(
                "原文识别到 {} 个题号，本次整理 {} 题：{detail}。未保存不完整结果，原件与识别材料保留，请重新解析。",
                expected.len(),
                actual.len()
            ),
        ));
    }
    material_coverage_with_source_reviews(questions, document, tables_reviewed, document_assets,contained_assets)
}

/// Material-only validation is also performed before a source batch is saved.
/// Its shared answer block may mention other question numbers, so number
/// coverage remains a separate whole-document check.
fn bounded_representation_image(value:&Value)->AppResult<image::RgbaImage> {
    let encoded=s(value,"contentBase64");
    if encoded.len()>8*1024*1024/3*4+4 {return Err(err("ocr_material_limit","素材压缩内容超过像素核验上限。"));}
    let bytes=base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_|err("ocr_material_role","素材像素数据损坏。"))?;
    if sha(&bytes)!=s(value,"sha256") {return Err(err("ocr_material_role","素材像素哈希不一致。"));}
    let dimensions=image::ImageReader::new(std::io::Cursor::new(&bytes)).with_guessed_format()
        .map_err(|_|err("ocr_material_role","素材图像格式无效。"))?.into_dimensions().map_err(|_|err("ocr_material_role","素材图像尺寸头无效。"))?;
    if dimensions.0==0 || dimensions.1==0 || dimensions.0>8192 || dimensions.1>8192 || u64::from(dimensions.0)*u64::from(dimensions.1)>8*1024*1024 {
        return Err(err("ocr_material_limit","素材实际像素超过核验上限，未解码分配大图。"));
    }
    let mut reader=image::ImageReader::new(std::io::Cursor::new(&bytes)).with_guessed_format().map_err(|_|err("ocr_material_role","素材图像格式无效。"))?;
    let mut limits=image::Limits::default();limits.max_image_width=Some(8192);limits.max_image_height=Some(8192);limits.max_alloc=Some(32*1024*1024);reader.limits(limits);
    Ok(reader.decode().map_err(|_|err("ocr_material_limit","素材图像解码超过安全上限或内容无效。"))?.to_rgba8())
}

fn exact_pixels_with_budget(small:&image::RgbaImage,big:&image::RgbaImage,mut bytes_left:usize,mut windows_left:usize)->Option<[u32;2]> {
    if small.width()>big.width() || small.height()>big.height() {return None;}
    let sw=small.width() as usize;let bw=big.width() as usize;
    for y in 0..=big.height()-small.height() {
        for x in 0..=big.width()-small.width() {
            windows_left=windows_left.checked_sub(1)?;
            bytes_left=bytes_left.checked_sub(sw*4)?;
            let first=((y as usize)*bw+x as usize)*4;
            if big.as_raw()[first..first+sw*4]!=small.as_raw()[..sw*4] {continue;}
            let mut matched=true;
            for row in 1..small.height() {
                bytes_left=bytes_left.checked_sub(sw*4)?;
                let start=(((y+row) as usize)*bw+x as usize)*4;let source=row as usize*sw*4;
                if big.as_raw()[start..start+sw*4]!=small.as_raw()[source..source+sw*4] {matched=false;break;}
            }
            if matched {return Some([x,y]);}
        }
    }
    None
}

pub(super) fn exact_representation_offset(asset: &Value, representative: &Value) -> AppResult<Option<[u32;2]>> {
    if asset["id"]==representative["id"] || asset["page"]!=representative["page"] { return Ok(None); }
    let small=bounded_representation_image(asset)?;let big=bounded_representation_image(representative)?;
    // Exhausting a work budget is not equivalence: callers retain both images
    // and create a concrete presentation-review issue.
    Ok(exact_pixels_with_budget(&small,&big,32*1024*1024,1_000_000))
}

/// Exact reviewed crop coordinates only; never search a page or infer a role.
pub(super) fn exact_source_crop(asset:&Value,page:&Value,bbox:&Value)->AppResult<bool>{
    let Some(v)=bbox.as_array().filter(|v|v.len()==4) else{return Ok(false);};
    let Some(v)=v.iter().map(Value::as_u64).collect::<Option<Vec<_>>>() else{return Ok(false);};
    if v[2]<=v[0] || v[3]<=v[1] || v.iter().any(|n|*n>8192){return Ok(false);}
    let crop=bounded_representation_image(asset)?;let full=bounded_representation_image(page)?;
    if v[2]>u64::from(full.width()) || v[3]>u64::from(full.height()) || crop.width()!= (v[2]-v[0]) as u32 || crop.height()!=(v[3]-v[1]) as u32{return Ok(false);}
    Ok(image::imageops::crop_imm(&full,v[0] as u32,v[1] as u32,crop.width(),crop.height()).to_image()==crop)
}

#[cfg(test)]
mod representation_resource_tests {
    use super::*;
    #[test]
    fn repeated_white_rows_exhaust_comparison_budget_without_claiming_containment() {
        let big=image::RgbaImage::from_pixel(32,32,image::Rgba([255,255,255,255]));
        let mut small=image::RgbaImage::from_pixel(8,8,image::Rgba([255,255,255,255]));small.put_pixel(7,7,image::Rgba([254,255,255,255]));
        assert_eq!(exact_pixels_with_budget(&small,&big,64,1_000_000),None);
        assert_eq!(exact_pixels_with_budget(&small,&big,usize::MAX,0),None);
        let exact=image::imageops::crop_imm(&big,0,0,8,8).to_image();assert_eq!(exact_pixels_with_budget(&exact,&big,256,1),Some([0,0]));
    }
    #[test]
    fn oversized_png_header_is_rejected_before_pixel_decode() {
        let mut cursor=std::io::Cursor::new(Vec::new());image::DynamicImage::new_rgb8(2,2).write_to(&mut cursor,image::ImageFormat::Png).unwrap();let mut bytes=cursor.into_inner();
        bytes[16..20].copy_from_slice(&8192u32.to_be_bytes());bytes[20..24].copy_from_slice(&8192u32.to_be_bytes());
        let mut crc=0xffff_ffffu32;for byte in &bytes[12..29] {crc^=u32::from(*byte);for _ in 0..8 {crc=if crc&1!=0 {(crc>>1)^0xedb8_8320}else{crc>>1};}}
        bytes[29..33].copy_from_slice(&(!crc).to_be_bytes());
        let asset=json!({"contentBase64":base64::engine::general_purpose::STANDARD.encode(&bytes),"sha256":sha(&bytes)});
        assert_eq!(bounded_representation_image(&asset).unwrap_err().code,"ocr_material_limit");
    }
}

fn represented_material_valid(question:&Value, assignment:&Value, asset:&Value, document:&crate::ocr::OcrDocument) -> AppResult<bool> {
    let role=s(assignment,"role");
    if !matches!(role,"student"|"teacher") { return Ok(false); }
    let id=s(assignment,"representedByAssetId");
    let Some(representative)=document.assets.iter().find(|a|s(a,"id")==id) else {return Ok(false);};
    let linked=rows(&question["sourceMaterialRoles"]).iter().any(|r|r["assetId"]==id && r["role"]==role && r.get("representedByAssetId").is_none());
    let presented=rows(&question[role]["assets"]).iter().any(|a|a["assetId"]==id && a["sha256"]==representative["sha256"]);
    if !linked || !presented {return Ok(false);}
    Ok(exact_representation_offset(asset,representative)?.is_some_and(|offset|assignment["representationOffset"]==json!(offset)))
}

pub(super) fn material_coverage(
    questions: &mut [Value],
    document: &crate::ocr::OcrDocument,
) -> AppResult<()> {
    material_coverage_with_source_reviews(questions,document,&[],&HashSet::new(),&[])
}
/// Exceptions are supplied only by the source-review verifier, bound to exact
/// source/candidate/image receipts. Unreviewed OCR/model fields cannot grant one.
pub(super) fn material_coverage_with_source_reviews(
    questions:&mut [Value], document:&crate::ocr::OcrDocument,
    tables_reviewed:&[Value], document_assets:&HashSet<String>,contained_assets:&[Value],
) -> AppResult<()> {
    // A real image or table cannot vanish because the model says it preserved it.
    for page in &document.pages {
        let page_questions = questions
            .iter()
            .enumerate()
            .filter(|(_, q)| rows(&q["pages"]).contains(&page["page"]))
            .map(|(i, _)| i)
            .collect::<Vec<_>>();
        for asset in document
            .assets
            .iter()
            .filter(|a| a["page"] == page["page"] && a["role"] != "source_page")
        {
            let assignments: Vec<_> = page_questions.iter().flat_map(|i| rows(&questions[*i]["sourceMaterialRoles"]).into_iter().filter(move |assignment| assignment["assetId"] == asset["id"]).map(move |assignment| (*i,assignment))).collect();
            let roles: HashSet<_> = assignments.iter().map(|(_,assignment)| s(assignment,"role")).collect();
            let contained=contained_assets.iter().filter(|r|r["assetId"]==asset["id"]).collect::<Vec<_>>();
            if !contained.is_empty(){
                let rendered=if contained.len()==1 {
                    let r=contained[0];let owners=questions.iter().filter(|q|q["questionId"]==r["questionId"]).collect::<Vec<_>>();
                    r["role"]=="student"&&owners.len()==1
                        &&rows(&owners[0]["sourceMaterialRoles"]).iter().any(|role|role["assetId"]==r["representedByAssetId"]&&role["role"]=="student")
                        &&rows(&owners[0]["student"]["assets"]).iter().any(|a|a["assetId"]==r["representedByAssetId"]&&a["sha256"]==r["representedByAssetSha256"])
                }else{false};
                if !rendered||!assignments.is_empty()||questions.iter().any(|q|references(&format!("{}\n{}",text(q,false),text(q,true))).iter().any(|id|id==s(asset,"id"))){
                    return Err(err("source_material_review_stale","局部素材的明确呈现关系已变化，未忽略该素材。"));
                }
                // The local source-review verifier proved the exact provider
                // crop path lies inside the presented original-page crop.
                // It is not a claim that two independently encoded PNGs match.
                continue;
            }
            if document_assets.contains(s(asset,"id")) {
                if roles.iter().any(|role|*role!="document") || questions.iter().any(|q|references(&format!("{}\n{}",text(q,false),text(q,true))).iter().any(|id|id==s(asset,"id"))) {
                    return Err(err("source_material_review_stale","已核对的非题素材与当前题目实际引用或角色冲突。"));
                }
                continue;
            }
            if roles.len() != 1 {
                return Err(err("ocr_material_role", "原卷素材缺少唯一的模型归属及原文依据，原件保留，请重新整理。"));
            }
            let role = *roles.iter().next().unwrap();
            for (index,assignment) in &assignments {
                if assignment.get("representedByAssetId").is_some() && !represented_material_valid(&questions[*index],assignment,asset,document)? {
                    return Err(err("ocr_material_role","素材代表关系缺少同题同角色实际呈现或精确像素包含证据。"));
                }
            }
            if role == "document" {
                continue;
            }
            let all = assignments.iter().map(|(i,_)| text(&questions[*i],role=="teacher")).collect::<Vec<_>>().join("\n");
            let used = references(&all).iter().any(|r| asset["id"] == *r)
                // Paper and Bank normally render non-inline assets from these
                // arrays. Supplemental assets need not rewrite original text.
                || assignments.iter().any(|(index,_)| rows(&questions[*index][role]["assets"]).iter().any(|a|a["assetId"]==asset["id"] && a["sha256"]==asset["sha256"]))
                || assignments.iter().any(|(_,a)|a.get("representedByAssetId").is_some());
            let is_table = asset["role"] == "table";
            let source_tables = rows(&page["blocks"])
                .iter()
                .filter(|b| b["type"] == "table" && b["bbox"] == asset["bbox"])
                .flat_map(|b| tables(s(b, "text")))
                .collect::<Vec<_>>();
            let table_present = is_table
                && !source_tables.is_empty()
                && (source_tables
                    .iter()
                    .all(|t| !t.is_empty() && tables(&all).iter().any(|c| c == t))
                    || tables_reviewed.iter().any(|review| review["assetId"]==asset["id"] && review["role"]==role
                        && assignments.iter().any(|(i,_)|questions[*i]["questionId"]==review["questionId"]
                            && tables(&text(&questions[*i],role=="teacher")).iter().any(|t|json!(t)==review["approvedShape"]))));
            if !used && !table_present {
                return Err(err(
                    "ocr_material_unassigned",
                    &format!(
                        "原卷第 {} 页有{}未完整归入题目，无法确认所属题号；未保存不完整结果，原件与识别材料已保留，请重新解析。",
                        page["page"],
                        if is_table { "表格" } else { "题图" }
                    ),
                ));
            }
        }
    }
    Ok(())
}
pub(super) fn tables(body: &str) -> Vec<Vec<Vec<(usize, usize, String)>>> {
    let table = regex::Regex::new(r"(?is)<table\b[^>]*>.*?</table>").unwrap();
    let row = regex::Regex::new(r"(?is)<tr\b[^>]*>(.*?)</tr>").unwrap();
    let cell = regex::Regex::new(r"(?is)<t[dh]\b([^>]*)>(.*?)</t[dh]>").unwrap();
    let tags = regex::Regex::new(r"<[^>]+>").unwrap();
    // Braces around one ASCII script token do not change a LaTeX index or
    // exponent. Keep multi-token groups, values and the complete table grid.
    let single_script = regex::Regex::new(r"([_^])\{([A-Za-z0-9])\}").unwrap();
    let span = |attrs: &str, name: &str| -> usize {
        regex::Regex::new(&format!(r#"(?i)\b{name}\s*=\s*["']?(\d+)"#))
            .unwrap()
            .captures(attrs)
            .and_then(|c| c[1].parse().ok())
            .unwrap_or(1)
    };
    table
        .find_iter(body)
        .map(|t| {
            row.captures_iter(t.as_str())
                .map(|r| {
                    cell.captures_iter(&r[1])
                        .map(|c| {
                            let plain=tags.replace_all(&c[2], "");
                            // Do this before stripping LaTeX backslashes so
                            // escaped literal braces/underscores stay distinct.
                            let notation=single_script.replace_all(&plain,|matched:&regex::Captures<'_>| {
                                let start=matched.get(0).unwrap().start();
                                let escaped=plain.as_bytes()[..start].iter().rev().take_while(|b|**b==b'\\').count()%2==1;
                                if escaped {matched[0].to_owned()}else{format!("{}{}",&matched[1],&matched[2])}
                            });
                            let compact: String=notation
                                .chars()
                                .filter(|c| !c.is_whitespace() && *c != '$' && *c != '\\')
                                .collect();
                            (
                                span(&c[1], "rowspan"),
                                span(&c[1], "colspan"),
                                compact,
                            )
                        })
                        .collect()
                })
                .collect()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn simulated_non_question_material_requires_model_assignment_not_table_header_rules() {
        let original = "<table><tr><td>题号</td><td>总分</td></tr><tr><td>分数</td><td></td></tr></table>";
        let page = json!({"page":1,"text":"（1）模拟题目","blocks":[{"id":1,"type":"table","bbox":[1,2,3,4],"text":original}]});
        let asset = json!({"id":"simulated-score-grid","page":1,"role":"table","bbox":[1,2,3,4]});
        let doc = crate::ocr::OcrDocument { pages:vec![page], assets:vec![asset], issues:vec![] };
        let mut qs = vec![json!({"sourceLabel":"1","pages":[1],"stem":"模拟题目"})];
        assert_eq!(coverage(&mut qs,&doc).unwrap_err().code,"ocr_material_role");
        qs[0]["sourceMaterialRoles"] = json!([{"assetId":"simulated-score-grid","role":"document","sourceBlockIds":["p1-b1"],"basis":"模拟模型对照原文认定为非题目登分栏"}]);
        coverage(&mut qs,&doc).unwrap();
        assert_eq!(rows(&context(&doc)["requiredMaterialAssets"]).len(),1);
        assert!(context(&doc).get("documentOnlyAssets").is_none());
        assert_eq!(context(&doc)["pages"][0]["blocks"][0]["text"],original);
        qs[0]["sourceMaterialRoles"][0]["role"] = json!("student");
        assert_eq!(coverage(&mut qs,&doc).unwrap_err().code,"ocr_material_unassigned");
    }
    #[test]
    fn parenthesized_exam_numbers_are_covered_alongside_instruction_numbers() {
        // Simulated regression reproducing the source numbering convention of
        // the Beijing paper, not a claim about transcription correctness.
        let mut body = "注意事项：\n1. 填写姓名。\n2. 正确填涂。\n".to_owned();
        for n in 1..=20 {
            body.push_str(&format!("## （{n}）原题内容\n（Ⅰ）原小问\n"));
        }
        body.push_str("(21) 模拟半角括号题\n");
        let doc = crate::ocr::OcrDocument {
            pages: vec![json!({"page":1,"text":body,"blocks":[]})],
            assets: vec![],
            issues: vec![],
        };
        let mut qs = (1..=21)
            .map(|n| json!({"sourceLabel":n.to_string(),"pages":[1],"stem":"模拟编号回归"}))
            .collect::<Vec<_>>();
        coverage(&mut qs, &doc).unwrap();
        let mut missing = qs.clone();
        missing.remove(12);
        assert_eq!(
            coverage(&mut missing, &doc).unwrap_err().code,
            "ocr_question_coverage"
        );
        let mut duplicated = qs.clone();
        duplicated.push(qs[0].clone());
        assert_eq!(
            coverage(&mut duplicated, &doc).unwrap_err().code,
            "ocr_question_coverage"
        );
        qs.push(json!({"sourceLabel":"22","pages":[1],"stem":"模拟多余题"}));
        assert_eq!(
            coverage(&mut qs, &doc).unwrap_err().code,
            "ocr_question_coverage"
        );
    }
    #[test]
    fn source_question_number_without_dot_is_not_mistaken_for_model_invention() {
        let doc = crate::ocr::OcrDocument {
            pages: vec![
                json!({"page":1,"text":"15. 原卷题目\n16 已知函数 f(x)\n17\\. 原卷题目","blocks":[]}),
            ],
            assets: vec![],
            issues: vec![],
        };
        let mut questions = (15..=17)
            .map(|n| json!({"sourceLabel":n.to_string(),"pages":[1],"stem":"模拟题号回归"}))
            .collect::<Vec<_>>();
        coverage(&mut questions, &doc).unwrap();
        assert_eq!(
            coverage(&mut questions[..2], &doc).unwrap_err().code,
            "ocr_question_coverage"
        );
    }
    #[test]
    fn source_numbers_do_not_adopt_years_or_question_subparts() {
        assert_eq!(number("第 16 题"), Some("16".into()));
        assert_eq!(number("3."), Some("3".into()));
        for label in ["2025期末第1题", "1(2)", "0", "16 分"] {
            assert_eq!(number(label), None);
        }
    }
    #[test]
    fn explicit_source_labels_accept_only_complete_matching_number_parentheses() {
        for (label, expected) in [
            ("1", "1"),
            ("第 16 题", "16"),
            ("3.", "3"),
            ("(1)", "1"),
            ("（16）", "16"),
            ("  ( 20 )  ", "20"),
            ("（ 999 ）", "999"),
        ] {
            assert_eq!(source_label_number(label), Some(expected.to_owned()), "{label}");
        }
        for label in [
            "(1", "1)", "（1", "1）", "(1）", "（1)", "((1))", "（(1)）",
            "(第1题)", "(1).", "(1)原题", "原题(1)", "(1)(2)", "(1)\n(2)",
            "(0)", "(01)", "(1000)", "(-1)", "(1.0)", "(１)", "()", "未知",
        ] {
            assert_eq!(source_label_number(label), None, "{label}");
        }
        // The generic OCR/scored-title helper must retain its narrower contract.
        assert_eq!(number("(1)"), None);
        assert_eq!(number("（16）"), None);
    }
    #[test]
    fn parenthesized_source_label_identity_preserves_labels_and_rejects_duplicate_or_missing() {
        let document = crate::ocr::OcrDocument {
            pages: vec![json!({"page":1,"text":"1. 模拟整题\n2. 模拟整题\n3. 模拟整题","blocks":[]})],
            assets: vec![],
            issues: vec![],
        };
        let questions = vec![
            json!({"sourceLabel":"(1)"}),
            json!({"sourceLabel":"（2）"}),
            json!({"sourceLabel":"第3题"}),
        ];
        let mut accepted = questions.clone();
        coverage(&mut accepted, &document).unwrap();
        assert_eq!(accepted, questions);
        for duplicate in ["1", "（1）", "(1)", "第1题"] {
            let mut changed = questions.clone();
            changed.push(json!({"sourceLabel":duplicate}));
            assert_eq!(coverage(&mut changed, &document).unwrap_err().code, "ocr_question_coverage");
        }
        let mut missing = vec![questions[0].clone(), questions[2].clone()];
        let error = coverage(&mut missing, &document).unwrap_err();
        assert_eq!(error.code, "ocr_question_coverage");
        assert!(error.message.contains("缺少第 2 题"));
        let mut extra = questions.clone();
        extra.push(json!({"sourceLabel":"(4)"}));
        assert_eq!(coverage(&mut extra, &document).unwrap_err().code, "ocr_question_coverage");
    }
    #[test]
    fn accepting_explicit_source_labels_does_not_expand_ocr_subpart_anchors() {
        let document = crate::ocr::OcrDocument {
            pages: vec![json!({"page":1,"text":"16. 模拟整题","blocks":[
                {"id":1,"text":"（1）（本小题满分3分）"},
                {"id":2,"text":"(2)（本题满分4分）"}
            ]})],
            assets: vec![],
            issues: vec![],
        };
        assert_eq!(expected_question_numbers(&document), HashSet::from(["16".to_owned()]));
        let mut questions = vec![json!({"sourceLabel":"（16）"})];
        coverage(&mut questions, &document).unwrap();
        questions.push(json!({"sourceLabel":"(1)"}));
        assert_eq!(coverage(&mut questions, &document).unwrap_err().code, "ocr_question_coverage");
    }
    #[test]
    fn merged_scored_question_title_preserves_unicode_layout_evidence() {
        // Regression shape from the saved Guizhou OCR: 54 characters but 144
        // UTF-8 bytes. The question number is real text, not inferred from a gap.
        let heading = "四、解答题：共5个小题，满分77分。解答应写出相应的文字说明，证明过程或演算步骤。";
        let block = format!("{heading}\n15.（本题满分13分）");
        assert!(block.len() > 100);
        assert!(block.chars().count() < 100);
        for blocks in [
            json!([{"id":7,"type":"paragraph_title","text":block}]),
            json!([]),
        ] {
            let document = crate::ocr::OcrDocument {
                pages: vec![json!({"page":2,"text":format!("### {heading} 15.（本题满分13分）"),"blocks":blocks})],
                assets: vec![],
                issues: vec![],
            };
            assert_eq!(expected_question_numbers(&document), HashSet::from(["15".to_owned()]));
            let mut questions = vec![json!({"sourceLabel":"15","pages":[2]})];
            coverage(&mut questions, &document).unwrap();
            assert_eq!(coverage(&mut [], &document).unwrap_err().code, "ocr_question_coverage");
        }
    }
    #[test]
    fn long_layout_scored_title_is_not_cut_off_by_block_size() {
        let block = format!("{}\n16.（本题满分15分）", "栏目说明文字。".repeat(40));
        let document = crate::ocr::OcrDocument {
            pages: vec![json!({"page":1,"text":"栏目说明","blocks":[{"id":1,"type":"paragraph_title","text":block}]})],
            assets: vec![],
            issues: vec![],
        };
        assert_eq!(expected_question_numbers(&document), HashSet::from(["16".to_owned()]));
    }
    #[test]
    fn layout_fallback_does_not_promote_unknown_labels_or_math_numbers() {
        let document = crate::ocr::OcrDocument {
            pages: vec![json!({"page":1,"text":"1. 模拟真实题目","blocks":[
                {"id":1,"text":"98. 计算2x+3，单位为分"},
                {"id":2,"text":"97. (x+1分)=0"},
                {"id":3,"text":"（96）小问得分为3分"},
                {"id":4,"text":"$95.（本题满分13分）$"},
                {"id":5,"text":"未知题号（本题满分13分）"},
                {"id":6,"text":"2026.（本题满分13分）"},
                {"id":7,"text":"证明中引用15.（本题满分13分）"},
                {"id":8,"text":"四、编号年份2026.（本题满分13分）"},
                {"id":9,"text":"四、算式1/94.（本题满分13分）"}
            ]})],
            assets: vec![],
            issues: vec![],
        };
        assert_eq!(expected_question_numbers(&document), HashSet::from(["1".to_owned()]));
        let mut questions = vec![json!({"sourceLabel":"1","pages":[1]})];
        coverage(&mut questions, &document).unwrap();
        questions.push(json!({"sourceLabel":"98","pages":[1]}));
        assert_eq!(coverage(&mut questions, &document).unwrap_err().code, "ocr_question_coverage");
    }
    #[test]
    fn coverage_does_not_fill_number_gaps_or_relax_duplicate_rejection() {
        let document = crate::ocr::OcrDocument {
            pages: vec![json!({"page":1,"text":"14. 模拟原题\n16. 模拟原题","blocks":[]})],
            assets: vec![],
            issues: vec![],
        };
        let questions = vec![json!({"sourceLabel":"14"}), json!({"sourceLabel":"16"})];
        coverage(&mut questions.clone(), &document).unwrap();
        for added in ["15", "16", "未知"] {
            let mut changed = questions.clone();
            changed.push(json!({"sourceLabel":added}));
            assert_eq!(coverage(&mut changed, &document).unwrap_err().code, "ocr_question_coverage");
        }
        assert_eq!(coverage(&mut questions[..1].to_vec(), &document).unwrap_err().code, "ocr_question_coverage");
    }
    #[test]
    fn escaped_scored_titles_in_layout_blocks_preserve_actual_question_anchors() {
        // Actual saved OCR shape: page Markdown omits the last two headings,
        // while their layout blocks retain one escaped literal period.
        let document = crate::ocr::OcrDocument {
            pages: vec![json!({"page":4,"text":"1. 模拟已知题号","blocks":[
                {"id":0,"text":r"18\. (17分)"}, {"id":5,"text":r"19\. (17分)"}
            ]})], assets: vec![], issues: vec![],
        };
        assert_eq!(expected_question_numbers(&document), HashSet::from(["1".to_owned(),"18".to_owned(),"19".to_owned()]));
        let original = vec![json!({"sourceLabel":"1"}),json!({"sourceLabel":"18"}),json!({"sourceLabel":"19"})];
        let mut accepted=original.clone();coverage(&mut accepted,&document).unwrap();assert_eq!(accepted,original);
        for label in ["18","19"] {
            let mut missing=original.iter().filter(|q|q["sourceLabel"]!=label).cloned().collect::<Vec<_>>();
            assert_eq!(coverage(&mut missing,&document).unwrap_err().code,"ocr_question_coverage");
            let mut duplicate=original.clone();duplicate.push(json!({"sourceLabel":label}));
            assert_eq!(coverage(&mut duplicate,&document).unwrap_err().code,"ocr_question_coverage");
        }
    }
    #[test]
    fn escaped_scored_title_support_does_not_promote_subparts_formulas_or_malformed_numbers() {
        let rejected = [
            r"18\\. (17分)", r"18\. (x+17分)", r"18\. (17)", r"18\. (17分)后文",
            r"0\. (17分)", r"018\. (17分)", r"1000\. (17分)", r"18.5\. (17分)",
            r"(1)（本小题满分3分）", r"（2） (17分)", r"18\. 普通子步骤",
            r"$18\. (17分)$", r"x=18\. (17分)", r"98\. 计算2x+3，单位为分",
        ];
        let document=crate::ocr::OcrDocument {
            pages:vec![json!({"page":1,"text":"1. 模拟真实整题","blocks":rejected.iter().enumerate().map(|(id,text)|json!({"id":id,"text":text})).collect::<Vec<_>>()})],
            assets:vec![],issues:vec![],
        };
        assert_eq!(expected_question_numbers(&document),HashSet::from(["1".to_owned()]));
    }
    #[test]
    #[ignore = "explicit offline saved OCR regression; paths must be supplied by maintenance"]
    fn saved_ocr_question_number_coverage_regression() {
        // Read-only number coverage check. Real assets are deliberately outside
        // this test's scope; this neither admits questions nor bypasses their
        // separate material validation in the application.
        let manifest: Value = serde_json::from_slice(
            &std::fs::read(std::env::var_os("TUTOR_COVERAGE_MANIFEST").expect("manifest path")).unwrap(),
        ).unwrap();
        let response: Value = serde_json::from_slice(
            &std::fs::read(std::env::var_os("TUTOR_COVERAGE_RESPONSE").expect("response path")).unwrap(),
        ).unwrap();
        let proposed: Value = serde_json::from_str(s(&response["choices"][0]["message"], "content")).unwrap();
        let mut questions = rows(&proposed["questions"]);
        let document = crate::ocr::OcrDocument {
            pages: rows(&manifest["pages"]), assets: vec![], issues: vec![],
        };
        assert_eq!(questions.len(), 19);
        assert_eq!(expected_question_numbers(&document), (1..=19).map(|n| n.to_string()).collect());
        coverage(&mut questions, &document).unwrap();
        for label in ["15","18","19"] {
            let mut missing = questions.clone();
            missing.retain(|q| q["sourceLabel"] != label);
            assert_eq!(coverage(&mut missing, &document).unwrap_err().code, "ocr_question_coverage");
            let duplicate = questions.iter().find(|q| q["sourceLabel"] == label).unwrap().clone();
            let mut duplicated=questions.clone();duplicated.push(duplicate);
            assert_eq!(coverage(&mut duplicated, &document).unwrap_err().code, "ocr_question_coverage");
        }
    }
    #[test]
    #[ignore = "explicit read-only replay of a saved 20-question source index; supply paths"]
    fn saved_parenthesized_source_index_identity_regression() {
        let manifest: Value = serde_json::from_slice(
            &std::fs::read(std::env::var_os("TUTOR_COVERAGE_MANIFEST").expect("manifest path")).unwrap(),
        ).unwrap();
        let response: Value = serde_json::from_slice(
            &std::fs::read(std::env::var_os("TUTOR_COVERAGE_RESPONSE").expect("response path")).unwrap(),
        ).unwrap();
        assert_eq!(response["httpStatus"], 200);
        assert_eq!(response["choices"][0]["finish_reason"], "stop");
        let proposed: Value = serde_json::from_str(s(&response["choices"][0]["message"], "content")).unwrap();
        let mut questions = rows(&proposed["questions"]);
        let original = questions.clone();
        let document = crate::ocr::OcrDocument {
            pages: rows(&manifest["pages"]), assets: vec![], issues: vec![],
        };
        assert_eq!(questions.len(), 20);
        assert_eq!(expected_question_numbers(&document), (1..=20).map(|n| n.to_string()).collect());
        coverage(&mut questions, &document).unwrap();
        assert_eq!(questions, original);
        let mut missing = questions.clone();
        missing.retain(|q| source_label_number(s(q, "sourceLabel")).as_deref() != Some("17"));
        assert_eq!(coverage(&mut missing, &document).unwrap_err().code, "ocr_question_coverage");
        questions.push(json!({"sourceLabel":"第1题"}));
        assert_eq!(coverage(&mut questions, &document).unwrap_err().code, "ocr_question_coverage");
    }
    #[test]
    fn table_comparison_preserves_rows_blank_cells_and_merged_cells() {
        let original =
            "<table><tr><td rowspan=\"2\">A</td><td></td></tr><tr><td>3</td></tr></table>";
        assert_eq!(
            tables(original),
            tables(
                "<table><tr><th rowspan='2'> A </th><td> </td></tr><tr><td>$3$</td></tr></table>"
            )
        );
        for changed in [
            "<table><tr><td rowspan='2'>A</td><td>0</td></tr><tr><td>3</td></tr></table>",
            "<table><tr><td>A</td><td></td><td>3</td></tr></table>",
            "<table><tr><td>A</td><td></td></tr><tr><td>3</td></tr></table>",
        ] {
            assert_ne!(tables(original), tables(changed));
        }
    }
    #[test]
    fn simulated_ocr_table_text_difference_requires_preserved_image_and_reference_figures_must_be_used() {
        let original = "<table><tr><td colspan='2'>模拟分类</td></tr><tr><td>中轴线南路遗存</td><td></td></tr></table>";
        let corrected = original.replace("南路遗存", "南段道路遗存");
        let document = crate::ocr::OcrDocument {
            pages: vec![json!({"page":1,"text":"1. 模拟原图保真题","blocks":[{"id":1,"type":"table","bbox":[0,0,200,100],"text":original},{"id":2,"type":"figure","bbox":[0,120,200,220],"assetId":"simulated-reference"}]})],
            assets: vec![json!({"id":"simulated-table","page":1,"role":"table","bbox":[0,0,200,100]}), json!({"id":"simulated-reference","page":1,"role":"figure","bbox":[0,120,200,220]})],
            issues: vec![],
        };
        let mut question = json!({"sourceLabel":"1","pages":[1],"stem":corrected,"solution":"![解析原图](asset:simulated-reference)","sourceMaterialRoles":[{"assetId":"simulated-table","role":"student","sourceBlockIds":["p1-b1"],"basis":"模拟真实表格"},{"assetId":"simulated-reference","role":"teacher","sourceBlockIds":["p1-b2"],"basis":"模拟原卷解析图"}]});
        assert_eq!(material_coverage(&mut [question.clone()], &document).unwrap_err().code, "ocr_material_unassigned");
        question["stem"] = json!("![原卷表格](asset:simulated-table)");
        material_coverage(&mut [question.clone()], &document).unwrap();
        question["solution"] = json!("仅声明teacher角色，未实际使用图片。");
        assert_eq!(material_coverage(&mut [question], &document).unwrap_err().code, "ocr_material_unassigned");
    }
    #[test]
    fn simulated_table_single_token_script_braces_do_not_report_lost_material() {
        // Regression for Huizhou page 4, question 17: all 22 cells survived;
        // only x_{i} -> x_i changed notation. No math equivalence is inferred.
        let original="<table><tr><td>序号i</td><td>1</td><td>2</td><td>3</td><td>4</td><td>5</td><td>6</td><td>7</td><td>8</td><td>9</td><td>10</td></tr><tr><td>成绩 $ x_{i} $/分</td><td>38</td><td>41</td><td>44</td><td>51</td><td>54</td><td>56</td><td>58</td><td>64</td><td>74</td><td>80</td></tr></table>";
        let equivalent=original.replace("$ x_{i} $","$x_i$");
        let document=crate::ocr::OcrDocument{pages:vec![json!({"page":4,"text":"17. 模拟成绩表格题","blocks":[{"id":2,"type":"table","bbox":[83,431,1177,618],"text":original}]})],assets:vec![json!({"id":"simulated-p4-table","page":4,"role":"table","bbox":[83,431,1177,618]})],issues:vec![]};
        let question=json!({"sourceLabel":"17","pages":[4],"stem":equivalent,"sourceMaterialRoles":[{"assetId":"simulated-p4-table","role":"student","sourceBlockIds":["p4-b2"],"basis":"模拟对照成绩表"}]});
        coverage(&mut [question.clone()],&document).unwrap();
        for changed in [
            equivalent.replace("<td>38</td>","<td>83</td>"),
            equivalent.replace("<td>38</td><td>41</td>","<td>41</td><td>38</td>"),
            equivalent.replace("<td>38</td>","<td></td>"),
            equivalent.replace("<td>38</td>",""),
            equivalent.replace("<td>38</td>","<td colspan='2'>38</td>"),
            equivalent.replace("x_i","x_j"),
        ] {let mut changed_question=question.clone();changed_question["stem"]=json!(changed);assert_eq!(coverage(&mut [changed_question],&document).unwrap_err().code,"ocr_material_unassigned");}
        assert_eq!(tables("<table><tr><td>$x^{2}+a_{1}$</td></tr></table>"),tables("<table><tr><td>$x^2+a_1$</td></tr></table>"));
        assert_ne!(tables("<table><tr><td>$x_{12}$</td></tr></table>"),tables("<table><tr><td>$x_12$</td></tr></table>"));
        assert_ne!(tables("<table><tr><td>$x^{10}$</td></tr></table>"),tables("<table><tr><td>$x^10$</td></tr></table>"));
        assert_ne!(tables(r"<table><tr><td>$x_\{i\}$</td></tr></table>"),tables("<table><tr><td>$x_i$</td></tr></table>"));
        assert_ne!(tables(r"<table><tr><td>$x\_{i}$</td></tr></table>"),tables("<table><tr><td>$x_i$</td></tr></table>"));
    }
}
