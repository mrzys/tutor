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
    let document_only_assets = document
        .assets
        .iter()
        .filter(|asset| {
            document
                .pages
                .iter()
                .any(|page| page["page"] == asset["page"] && blank_score_grid(asset, page))
        })
        .map(|a| a["id"].clone())
        .collect::<Vec<_>>();
    let required_material_assets = document.assets.iter().filter(|asset| asset["role"]!="source_page" && !document_only_assets.contains(&asset["id"])).map(|asset| {
        let block_ids = document.pages.iter().filter(|p|p["page"]==asset["page"]).flat_map(|p|rows(&p["blocks"])).filter(|b|b["assetId"]==asset["id"] || b["bbox"]==asset["bbox"]).filter_map(|b|b["id"].as_u64()).map(|id|format!("p{}-b{id}",asset["page"])).collect::<Vec<_>>();
        json!({"assetId":asset["id"],"page":asset["page"],"role":asset["role"],"sourceBlockIds":block_ids})
    }).collect::<Vec<_>>();
    json!({"provider":"paddleocr","pages":document.pages,"assets":assets,"sourceIssues":document.issues,"documentOnlyAssets":document_only_assets,"requiredMaterialAssets":required_material_assets,
      "instructions":"逐页读取原始Markdown及版面块，不将null顺序当作0。页脚可能包含跨页题号，按题号及内容核对，不省略。题目保留sourceBlockIds（p{page}-b{原id}），只能引用实际块。所有图片引用保留asset:真实id；表格逐行逐格保留，原空格不得填值。不得将答案页图片放入学生题面。附录公式和表格是题目材料，不能省略。没有原文答案或完整解法时保持缺项。"})
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
fn answer_page(page: &Value) -> bool {
    regex::Regex::new(r"(?m)^\s*(?:#{1,6}\s*)?(?:参考答案|答案及解析|答案与解析|答案详解|试题解析)")
        .unwrap()
        .is_match(s(page, "text"))
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
            let page = document.pages.iter().find(|p| p["page"] == asset["page"]);
            if !teacher {
                if page.is_some_and(answer_page) {
                    return Err(err(
                        "ocr_answer_asset",
                        "答案页中的图片不能作为学生题面，需单独核对来源。",
                    ));
                }
            } else if !page.is_some_and(answer_page) {
                return Err(err(
                    "ocr_teacher_asset_unverified",
                    "原题页图表被归入答案或解析，未继续导入；请重试核对图表归属。",
                ));
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
    let known_blocks: HashSet<_> = document
        .pages
        .iter()
        .filter(|p| rows(&question["pages"]).contains(&p["page"]))
        .flat_map(|p| {
            rows(&p["blocks"])
                .into_iter()
                .map(move |b| format!("p{}-b{}", p["page"], b["id"]))
        })
        .collect();
    let blocks = ids(&proposed["sourceBlockIds"]);
    if blocks.iter().any(|id| !known_blocks.contains(id)) {
        return Err(err("ocr_invalid_source", "模型返回了不存在的原文块。"));
    }
    question["sourceBlockIds"] = json!(blocks);
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
/// An empty score-registration grid is retained in the source audit, but is
/// not a question table. Only this narrow, source-derived form is exempt;
/// filled tables, formula tables and model claims never qualify.
fn blank_score_grid(asset: &Value, page: &Value) -> bool {
    if asset["role"] != "table" {
        return false;
    }
    rows(&page["blocks"]).iter().any(|block| {
        if block["type"] != "table" || block["bbox"] != asset["bbox"] {
            return false;
        }
        let parsed = tables(s(block, "text"));
        if parsed.len() != 1 {
            return false;
        }
        let table = &parsed[0];
        if table.len() != 3 || table[0].len() < 3 || table[1].is_empty() || table[2].len() < 3 {
            return false;
        }
        let header = &table[0];
        let numbers = &table[1];
        let score = &table[2];
        if header[0].2 != "题号"
            || header.last().unwrap().2 != "总分"
            || !matches!(score[0].2.as_str(), "分数" | "得分")
            || score[1..].iter().any(|cell| !cell.2.is_empty())
        {
            return false;
        }
        // Fixed outer rowspan cells and consistent expanded widths prevent
        // malformed or merely similarly labelled data tables being exempted.
        let width = header.iter().map(|cell| cell.1).sum::<usize>();
        let carried = header
            .iter()
            .filter(|cell| cell.0 == 2)
            .map(|cell| cell.1)
            .sum::<usize>();
        if header[0].0 != 2
            || header[0].1 != 1
            || header.last().unwrap().0 != 2
            || header.last().unwrap().1 != 1
            || header
                .iter()
                .any(|cell| !matches!(cell.0, 1 | 2) || cell.1 == 0)
            || numbers
                .iter()
                .chain(score.iter())
                .any(|cell| cell.0 != 1 || cell.1 != 1)
            || score.len() != width
            || carried + numbers.len() != width
        {
            return false;
        }
        let section_label = |value: &str| {
            !value.is_empty()
                && value
                    .chars()
                    .all(|c| "一二三四五六七八九十ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ".contains(c))
        };
        header[1..header.len() - 1]
            .iter()
            .all(|cell| section_label(&cell.2))
            && numbers.iter().all(|cell| number(&cell.2).is_some())
    })
}
pub(super) fn coverage(
    questions: &mut [Value],
    document: &crate::ocr::OcrDocument,
) -> AppResult<()> {
    let line_number = regex::Regex::new(
        r"(?m)^[ \t]*(?:#{1,6}[ \t]*)?(?:[（(][ \t]*([1-9]\d{0,2})[ \t]*[）)]|([1-9]\d{0,2})(?:\\?\.|、|．|[ \t]+[\p{Han}A-Za-z$（(]))",
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
        for block in rows(&page["blocks"]) {
            let body = s(&block, "text");
            if body.len() < 100 && body.contains('分') {
                for c in line_number.captures_iter(body) {
                    if let Some(n) = c
                        .get(1)
                        .or_else(|| c.get(2))
                        .and_then(|m| number(m.as_str()))
                    {
                        expected.insert(n);
                    }
                }
            }
        }
    }
    let mut actual = HashSet::new();
    for q in questions.iter() {
        if let Some(n) = number(s(q, "sourceLabel")) {
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
    // A real image or table cannot vanish because the model says it preserved it.
    for page in &document.pages {
        let page_questions = questions
            .iter()
            .enumerate()
            .filter(|(_, q)| rows(&q["pages"]).contains(&page["page"]))
            .map(|(i, _)| i)
            .collect::<Vec<_>>();
        let all = page_questions
            .iter()
            .map(|i| text(&questions[*i], answer_page(page)))
            .collect::<Vec<_>>()
            .join("\n");
        for asset in document
            .assets
            .iter()
            .filter(|a| a["page"] == page["page"] && a["role"] != "source_page")
        {
            if blank_score_grid(asset, page) {
                continue;
            }
            let used = references(&all).iter().any(|r| asset["id"] == *r);
            let is_table = asset["role"] == "table";
            let source_tables = rows(&page["blocks"])
                .iter()
                .filter(|b| b["type"] == "table" && b["bbox"] == asset["bbox"])
                .flat_map(|b| tables(s(b, "text")))
                .collect::<Vec<_>>();
            let table_present = is_table
                && !source_tables.is_empty()
                && source_tables
                    .iter()
                    .all(|t| !t.is_empty() && tables(&all).iter().any(|c| c == t));
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
fn tables(body: &str) -> Vec<Vec<Vec<(usize, usize, String)>>> {
    let table = regex::Regex::new(r"(?is)<table\b[^>]*>.*?</table>").unwrap();
    let row = regex::Regex::new(r"(?is)<tr\b[^>]*>(.*?)</tr>").unwrap();
    let cell = regex::Regex::new(r"(?is)<t[dh]\b([^>]*)>(.*?)</t[dh]>").unwrap();
    let tags = regex::Regex::new(r"<[^>]+>").unwrap();
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
                            (
                                span(&c[1], "rowspan"),
                                span(&c[1], "colspan"),
                                tags.replace_all(&c[2], "")
                                    .chars()
                                    .filter(|c| !c.is_whitespace() && *c != '$' && *c != '\\')
                                    .collect(),
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
    fn blank_score_registration_grid_stays_in_source_without_becoming_question_content() {
        let original = "<table><tr><td rowspan='2'>题号</td><td rowspan='2'>二</td><td colspan='2'>三</td><td rowspan='2'>总分</td></tr><tr><td>15</td><td>16</td></tr><tr><td>分数</td><td></td><td></td><td></td><td></td></tr></table>";
        let page = json!({"page":1,"text":"（1）模拟题目","blocks":[{"type":"table","bbox":[1,2,3,4],"text":original}]});
        let asset = json!({"id":"simulated-score-grid","page":1,"role":"table","bbox":[1,2,3,4]});
        assert!(blank_score_grid(&asset, &page));
        let doc = crate::ocr::OcrDocument {
            pages: vec![page.clone()],
            assets: vec![asset.clone()],
            issues: vec![],
        };
        let mut qs = vec![json!({"sourceLabel":"1","pages":[1],"stem":"模拟题目"})];
        coverage(&mut qs, &doc).unwrap();
        assert_eq!(
            context(&doc)["documentOnlyAssets"],
            json!(["simulated-score-grid"])
        );
        assert_eq!(context(&doc)["requiredMaterialAssets"], json!([]));
        assert_eq!(context(&doc)["pages"][0]["blocks"][0]["text"], original);
        for changed in [
            original.replacen("<td></td>", "<td>0</td>", 1),
            original.replace("总分", "概率"),
            original.replace("题号", "组别"),
            original.replace("分数", "频数"),
            original.replace("colspan='2'", "colspan='3'"),
            original.replace("rowspan='2'", "rowspan='1'"),
        ] {
            let mut page = page.clone();
            page["blocks"][0]["text"] = json!(changed);
            assert!(!blank_score_grid(&asset, &page));
            let doc = crate::ocr::OcrDocument {
                pages: vec![page],
                assets: vec![asset.clone()],
                issues: vec![],
            };
            assert_eq!(
                coverage(&mut qs, &doc).unwrap_err().code,
                "ocr_material_unassigned"
            );
        }
        let mut figure = asset;
        figure["role"] = json!("figure");
        assert!(!blank_score_grid(&figure, &page));
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
}
