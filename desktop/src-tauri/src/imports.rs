//! Local, explicit document import. Uploaded bytes are never treated as commands,
//! and model output never becomes teacher review evidence.
use crate::{
    annotations,
    bank::{BankRepository, hash_json},
    error::{AppError, AppResult},
    model::ModelClient,
    storage::Store,
};
use base64::Engine;
use rusqlite::{OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    io::{Cursor, Read, Write},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

mod background;
mod diagnostics;
mod duplicates;
mod listing;
mod review;
mod source_compare;
mod source_display;
mod source_batches;
mod source_recovery;
#[cfg(debug_assertions)]
mod layout_reading;
#[cfg(debug_assertions)]
mod source_trial;
#[cfg(debug_assertions)]
mod whole_transcription_trial;
#[cfg(debug_assertions)]
mod index_batch_trial;
#[cfg(debug_assertions)]
mod index_batch_runner;
#[cfg(debug_assertions)]
pub mod source_trial_adoption;
#[cfg(debug_assertions)]
mod source_display_adapter;
#[cfg(debug_assertions)]
mod index_batch_retry;
pub(crate) mod teaching;
mod teaching_actions;
mod views;
pub fn recover_background_jobs(store: &Store) -> AppResult<()> {
    background::recover(store)
}
#[cfg(debug_assertions)]
pub mod agent_review;
#[cfg(debug_assertions)]
pub mod teaching_adoption;
mod docx_pdf;
mod pdf_inspection;
mod ocr_resume;
mod paddle;
#[cfg(test)]
mod paddle_tests;
mod structured;

const MAX_BYTES: usize = 15 * 1024 * 1024;
const MAX_TEXT: usize = 240_000;
const MAX_QUESTIONS: usize = 60;
fn err(code: &str, message: &str) -> AppError {
    AppError::new(code, message)
}
fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
fn rows(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}
fn ids(v: &Value) -> Vec<String> {
    rows(v)
        .iter()
        .filter_map(|x| x.as_str().map(str::to_owned))
        .collect()
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
fn cancelled(cancel: &AtomicBool) -> AppResult<()> {
    if cancel.load(Ordering::Relaxed) {
        Err(err("cancelled", "已停止导入，原文件和已有审核内容已保留。"))
    } else {
        Ok(())
    }
}
fn operation(payload: &Value) -> AppResult<&str> {
    let id = s(payload, "operationId");
    if id.is_empty()
        || id.len() > 100
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        Err(err("invalid_operation", "缺少有效的操作标识。"))
    } else {
        Ok(id)
    }
}
fn replay(record: &Value, operation: &str, hash: &str) -> AppResult<bool> {
    if let Some(previous) = rows(&record["operations"])
        .iter()
        .find(|x| x["operationId"] == operation)
    {
        if previous["payloadHash"] != hash {
            return Err(err("operation_conflict", "此操作标识已用于其他导入内容。"));
        }
        return Ok(true);
    }
    Ok(false)
}
fn finish(record: &mut Value, operation: &str, hash: &str, kind: &str) {
    let revision = record["revision"].as_u64().unwrap_or(0) + 1;
    record["revision"] = json!(revision);
    record["updatedAt"] = json!(now());
    let mut operations = rows(&record["operations"]);
    operations
        .push(json!({"operationId":operation,"payloadHash":hash,"type":kind,"revision":revision}));
    record["operations"] = json!(operations);
}
fn revision(record: &Value, payload: &Value) -> AppResult<()> {
    if payload["expectedRevision"].as_u64() != record["revision"].as_u64() {
        Err(err(
            "revision_conflict",
            "导入记录已更新，请重新打开后再操作。",
        ))
    } else {
        Ok(())
    }
}
/// Short personal-DB transaction only. Never held during extraction, HTTP, or
/// bank publication. Exact-record CAS also guards non-revision checkpoints.
fn save_cas(store: &Store, expected: Option<&Value>, next: &Value) -> AppResult<()> {
    let transaction = Transaction::new_unchecked(&store.user, TransactionBehavior::Immediate)?;
    let previous: Option<String> = transaction
        .query_row(
            "SELECT payload FROM documents WHERE kind='imports' AND id=?1",
            [s(next, "importId")],
            |row| row.get(0),
        )
        .optional()?;
    let current = previous
        .map(|text| serde_json::from_str::<Value>(&text))
        .transpose()?;
    if current.as_ref() != expected {
        return Err(err(
            "revision_conflict",
            "导入记录已由其他窗口更新，请重新打开；原文件和审核内容已保留。",
        ));
    }
    store.put_document("imports", s(next, "importId"), next)?;
    transaction.commit()?;
    crate::import_events::committed(&store.data_dir, next);
    Ok(())
}
fn filename(value: &str) -> AppResult<(String, String)> {
    if value.is_empty()
        || value.len() > 240
        || value
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
    {
        return Err(err("invalid_filename", "文件名无效。"));
    }
    let extension = Path::new(value)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "txt" | "md" | "pdf" | "docx") {
        return Err(err(
            "unsupported_file",
            "请选择 TXT、Markdown、PDF 或 DOCX 文件。",
        ));
    }
    Ok((value.to_owned(), extension))
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn bounded_text(value: &str, max: usize, label: &str) -> AppResult<String> {
    if value.chars().count() > max || value.contains('\0') {
        return Err(AppError::new(
            "invalid_import",
            format!("{label}过长或包含无效字符。"),
        ));
    }
    Ok(value.trim().to_owned())
}

#[derive(Debug)]
struct Extracted {
    pages: Vec<String>,
    issues: Vec<Value>,
}
fn issue(code: &str, page: usize, message: &str) -> Value {
    json!({"code":code,"page":page,"message":message,"blocking":true})
}
fn image_reference(text: &str) -> bool {
    regex::Regex::new(r"!\[[^\]]*\]\(|asset:|(?i:<img\b)")
        .unwrap()
        .is_match(text)
}
fn unsupported_embedded_markup(text: &str) -> bool {
    regex::Regex::new(r"(?i:<svg\b|<canvas\b|<iframe\b|<script\b)").unwrap().is_match(text)
}
fn extract(extension: &str, bytes: &[u8], cancel: &AtomicBool) -> AppResult<Extracted> {
    cancelled(cancel)?;
    let mut extracted = match extension {
        "txt" | "md" => {
            let text = std::str::from_utf8(bytes).map_err(|_| {
                err(
                    "invalid_encoding",
                    "文本需使用 UTF-8 编码，请转换编码后重试。",
                )
            })?;
            Extracted {
                pages: vec![text.trim_start_matches('\u{feff}').to_owned()],
                issues: vec![],
            }
        }
        "pdf" => extract_pdf(bytes, cancel)?,
        "docx" => extract_docx(bytes, cancel)?,
        _ => return Err(err("unsupported_file", "文件类型不受支持。")),
    };
    if extracted
        .pages
        .iter()
        .map(|s| s.chars().count())
        .sum::<usize>()
        > MAX_TEXT
    {
        return Err(err(
            "text_too_large",
            "提取文本超过 24 万字，请分拆试卷后导入。",
        ));
    }
    for (i, page) in extracted.pages.iter().enumerate() {
        if page.contains('\0') {
            return Err(err("invalid_encoding", "文本包含无效字符。"));
        }
        if image_reference(page) || unsupported_embedded_markup(page) {
            extracted.issues.push(issue(
                "source_visual_unresolved",
                i + 1,
                "原文含图示或外部图片引用，当前提取未保留图像，涉及本页的题目暂不能发布。",
            ));
        }
    }
    if extracted.pages.iter().all(|x| x.trim().is_empty()) {
        return Err(err("empty_document", "文件没有可读取的题目文本。"));
    }
    cancelled(cancel)?;
    Ok(extracted)
}
fn extract_pdf(bytes: &[u8], cancel: &AtomicBool) -> AppResult<Extracted> {
    if !bytes.starts_with(b"%PDF-") {
        return Err(err("invalid_pdf", "PDF 文件签名无效。"));
    }
    let doc = lopdf::Document::load_mem(bytes)
        .map_err(|_| err("invalid_pdf", "PDF 无法读取，可能损坏或已加密。"))?;
    if doc.is_encrypted() {
        return Err(err("encrypted_pdf", "请先解除 PDF 密码后导入。"));
    }
    let pages = doc.get_pages();
    if pages.is_empty() || pages.len() > 200 {
        return Err(err("invalid_pdf", "PDF 页数需为 1–200 页，请分拆后重试。"));
    }
    let mut issues = vec![];
    let mut cjk_unicode_encoding = false;
    for (index, page) in pages.values().enumerate() {
        cancelled(cancel)?;
        let content = doc
            .get_page_content(*page)
            .map_err(|_| err("invalid_pdf", "PDF 页面内容读取失败。"))?;
        if content.len() > 32 * 1024 * 1024 {
            return Err(err("invalid_pdf", "PDF 页面展开内容过大。"));
        }
        for font in doc
            .get_page_fonts(*page)
            .map_err(|_| err("pdf_extraction_failed", "PDF 字体资源无效，原文件已保留。"))?
            .values()
        {
            if font
                .get(b"Encoding")
                .and_then(lopdf::Object::as_name)
                .is_ok_and(|name| matches!(name, b"UniGB-UCS2-H" | b"UniGB-UTF16-H"))
            {
                cjk_unicode_encoding = true;
            }
        }
        let content = String::from_utf8_lossy(&content);
        if regex::Regex::new(r"(?m)(?:\s|^)(?:Do|BI|m|l|re|c)(?:\s|$)")
            .unwrap()
            .is_match(&content)
        {
            issues.push(issue(
                "source_visual_unresolved",
                index + 1,
                "本页含图片或绘图，文本提取不能保证图形完整，涉及本页的题目暂不能发布。",
            ));
        }
    }
    cancelled(cancel)?;
    // pdf-extract currently panics for these registered CJK CMaps. lopdf has
    // explicit UTF-16BE support for precisely these two names; use it only for
    // documents that actually declare them, with strict font preflight.
    let text = if cjk_unicode_encoding {
        let mut text = vec![];
        for (number, page_id) in &pages {
            cancelled(cancel)?;
            let fonts = doc
                .get_page_fonts(*page_id)
                .map_err(|_| err("pdf_extraction_failed", "PDF 字体资源无效。"))?;
            for font in fonts.values() {
                font.get_font_encoding(&doc).map_err(|_| {
                    err(
                        "pdf_extraction_failed",
                        "PDF 含不支持的字体编码，请改用可编辑原文件。",
                    )
                })?;
            }
            let content = doc
                .get_and_decode_page_content(*page_id)
                .map_err(|_| err("pdf_extraction_failed", "PDF 页面操作无法完整解析。"))?;
            for op in &content.operations {
                if op.operator == "Tf"
                    && op
                        .operands
                        .first()
                        .and_then(|o| o.as_name().ok())
                        .is_none_or(|name| !fonts.contains_key(name))
                {
                    return Err(err(
                        "pdf_extraction_failed",
                        "PDF 使用了缺失的字体，无法可靠提取。",
                    ));
                }
            }
            text.push(doc.extract_text(&[*number]).map_err(|_| {
                err(
                    "pdf_extraction_failed",
                    "PDF 字体文字无法可靠提取，请改用可编辑原文件。",
                )
            })?);
        }
        text
    } else {
        pdf_extract::extract_text_from_mem_by_pages(bytes)
            .map_err(|_| err("pdf_extraction_failed", "PDF 文本提取失败，原文件已保留。"))?
    };
    if text.len() != pages.len() {
        return Err(err(
            "pdf_extraction_failed",
            "PDF 未能完整提取所有页面，原文件已保留。",
        ));
    }
    if text.iter().all(|x| x.trim().is_empty()) {
        return Err(err(
            "ocr_required",
            "此 PDF 没有可提取文本，可能是扫描件。请先进行 OCR，或导入可编辑原文件。",
        ));
    }
    for (i, page) in text.iter().enumerate() {
        if page
            .chars()
            .any(|c| c == '\u{fffd}' || (0xe000..=0xf8ff).contains(&(c as u32)))
        {
            issues.push(issue(
                "source_formula_unresolved",
                i + 1,
                "PDF 含无法可靠识别的字体或公式字符，本页题目需从可编辑原文件重新导入。",
            ));
        }
    }
    Ok(Extracted {
        pages: text,
        issues,
    })
}
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
fn extract_docx(bytes: &[u8], cancel: &AtomicBool) -> AppResult<Extracted> {
    if !bytes.starts_with(b"PK\x03\x04") {
        return Err(err("invalid_docx", "DOCX 文件签名无效。"));
    }
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| err("invalid_docx", "DOCX 压缩包无法读取。"))?;
    if archive.len() > 2000 {
        return Err(err("invalid_docx", "DOCX 包含过多文件，请整理后重试。"));
    }
    let mut total = 0u64;
    let mut names = HashSet::new();
    let mut xml = None;
    let mut content_types = false;
    for i in 0..archive.len() {
        cancelled(cancel)?;
        let mut file = archive
            .by_index(i)
            .map_err(|_| err("invalid_docx", "DOCX 内部文件读取失败。"))?;
        let name = file.name().to_owned();
        if !names.insert(name.clone()) {
            return Err(err(
                "invalid_docx",
                "DOCX 内含重复文件名，无法确定真实正文。",
            ));
        }
        if file.enclosed_name().is_none()
            || name.contains('\\')
            || name.contains(':')
            || name.contains('\0')
        {
            return Err(err("invalid_docx", "DOCX 含无效内部路径。"));
        }
        total = total
            .checked_add(file.size())
            .ok_or_else(|| err("archive_too_large", "DOCX 展开过大。"))?;
        if total > 64 * 1024 * 1024
            || file.size() > 32 * 1024 * 1024
            || file.size() > file.compressed_size().max(1) * 1000
        {
            return Err(err("archive_too_large", "DOCX 展开内容过大，请分拆文件。"));
        }
        if name == "[Content_Types].xml" {
            content_types = true
        }
        if name == "word/document.xml" {
            if file.size() > 8 * 1024 * 1024 {
                return Err(err("archive_too_large", "DOCX 正文过大。"));
            }
            let mut bytes = vec![];
            file.by_ref()
                .take(8 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() > 8 * 1024 * 1024 {
                return Err(err("archive_too_large", "DOCX 正文过大。"));
            }
            xml = Some(bytes)
        }
    }
    if !content_types {
        return Err(err("invalid_docx", "文件不是有效的 DOCX 文档。"));
    }
    let xml = xml.ok_or_else(|| err("invalid_docx", "DOCX 缺少正文。"))?;
    let mut reader = quick_xml::Reader::from_reader(Cursor::new(xml));
    reader.config_mut().trim_text(false);
    let mut buffer = vec![];
    let mut output = String::new();
    let mut issues = vec![];
    let mut in_text = false;
    let mut cell_depth: usize = 0;
    let mut table_depth: usize = 0;
    loop {
        cancelled(cancel)?;
        match reader
            .read_event_into(&mut buffer)
            .map_err(|_| err("invalid_docx", "DOCX 正文 XML 格式无效。"))?
        {
            quick_xml::events::Event::Start(e) | quick_xml::events::Event::Empty(e) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).into_owned();
                match name.as_str() {
                    "w:t" => in_text = true,
                    "w:tab" => output.push('\t'),
                    "w:br" | "w:cr" => output.push('\n'),
                    "w:tbl" => {
                        table_depth += 1;
                        output.push_str("\n<table>\n");
                        if table_depth > 1 {
                            issues.push(issue(
                                "source_table_unresolved",
                                1,
                                "文档含嵌套表格，当前不能完整保留布局。",
                            ))
                        }
                    }
                    "w:tr" => output.push_str("<tr>"),
                    "w:tc" => {
                        cell_depth += 1;
                        output.push_str("<td>")
                    }
                    "w:gridSpan" | "w:vMerge" => issues.push(issue(
                        "source_table_unresolved",
                        1,
                        "文档含合并单元格，当前提取不能保证表格结构完整。",
                    )),
                    "w:drawing" | "w:pict" | "w:object" | "w:altChunk" => {
                        output.push_str(" [SOURCE_VISUAL_UNRESOLVED] ");
                        issues.push(issue(
                            "source_visual_unresolved",
                            1,
                            "DOCX 含图片、绘图或嵌入对象，当前未完整提取，相关题目暂不能发布。",
                        ))
                    }
                    "m:oMath" | "m:oMathPara" => {
                        output.push_str(" [SOURCE_FORMULA_UNRESOLVED] ");
                        issues.push(issue("source_formula_unresolved",1,"DOCX 含 Office 数学公式，当前未保真转换，请改用包含完整 LaTeX 的文本导入。"))
                    }
                    _ => {}
                }
            }
            quick_xml::events::Event::End(e) => match e.name().as_ref() {
                b"w:t" => in_text = false,
                b"w:p" => {
                    if cell_depth > 0 {
                        output.push_str("<br/>")
                    } else {
                        output.push('\n')
                    }
                }
                b"w:tc" => {
                    cell_depth = cell_depth.saturating_sub(1);
                    output.push_str("</td>")
                }
                b"w:tr" => output.push_str("</tr>\n"),
                b"w:tbl" => {
                    table_depth = table_depth.saturating_sub(1);
                    output.push_str("</table>\n")
                }
                _ => {}
            },
            quick_xml::events::Event::Text(e) if in_text => {
                let decoded = e
                    .decode()
                    .map_err(|_| err("invalid_docx", "DOCX 文字编码无效。"))?;
                let text = quick_xml::escape::unescape(&decoded)
                    .map_err(|_| err("invalid_docx", "DOCX 文字实体无效。"))?;
                if cell_depth > 0 {
                    output.push_str(&xml_escape(&text))
                } else {
                    output.push_str(&text)
                }
            }
            quick_xml::events::Event::GeneralRef(e) if in_text => {
                let reference = e
                    .decode()
                    .map_err(|_| err("invalid_docx", "DOCX 字符引用无效。"))?;
                let entity = format!("&{reference};");
                let decoded = quick_xml::escape::unescape(&entity)
                    .map_err(|_| err("invalid_docx", "DOCX 字符实体无效。"))?;
                if cell_depth > 0 {
                    output.push_str(&xml_escape(&decoded))
                } else {
                    output.push_str(&decoded)
                }
            }
            quick_xml::events::Event::DocType(_) => {
                return Err(err("invalid_docx", "DOCX 正文不允许外部实体声明。"));
            }
            quick_xml::events::Event::Eof => break,
            _ => {}
        }
        // O(1) guard while parsing; the exact Unicode character limit is checked
        // once after extraction. Recounting on every XML event is quadratic.
        if output.len() > MAX_TEXT * 4 {
            return Err(err("text_too_large", "提取文本超过 24 万字，请分拆试卷。"));
        }
        buffer.clear();
    }
    Ok(Extracted {
        pages: vec![output],
        issues,
    })
}

fn save_source(store: &Store, id: &str, extension: &str, bytes: &[u8]) -> AppResult<Value> {
    let relative = format!("imports/{id}/source.{extension}");
    let path = store.data_dir.join(&relative);
    let parent = path.parent().unwrap();
    std::fs::create_dir_all(parent)?;
    if path.exists() {
        if std::fs::read(&path)? != bytes {
            return Err(err(
                "source_conflict",
                "已保存的原文件与本次内容不同，未覆盖。",
            ));
        }
    } else {
        let temp = parent.join(format!("{}.tmp", uuid::Uuid::new_v4()));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        let linked = std::fs::hard_link(&temp, &path);
        let _ = std::fs::remove_file(&temp);
        linked?;
    }
    Ok(
        json!({"relativePath":relative,"sha256":sha(bytes),"byteLength":bytes.len(),"extension":extension}),
    )
}
fn read_source(store: &Store, record: &Value) -> AppResult<Vec<u8>> {
    structured::verify_audit(store, record)?;
    paddle::verify_audit(store, record)?;
    let root = store.data_dir.join("imports").canonicalize()?;
    let path = store
        .data_dir
        .join(s(&record["source"], "relativePath"))
        .canonicalize()?;
    if !path.starts_with(root) || !path.is_file() {
        return Err(err("invalid_source", "原文件路径无效。"));
    }
    let length = std::fs::metadata(&path)?.len();
    if length > MAX_BYTES as u64 {
        return Err(err("file_too_large", "原文件超过 15 MB。"));
    }
    let bytes = std::fs::read(path)?;
    if sha(&bytes) != s(&record["source"], "sha256") {
        return Err(err("source_changed", "原文件校验失败，未继续导入或发布。"));
    }
    Ok(bytes)
}
fn normalize_question(q: &Value, id: &str, page_count: usize) -> AppResult<Value> {
    normalize_question_inner(q, id, page_count, false)
}
fn normalize_question_inner(
    q: &Value,
    id: &str,
    page_count: usize,
    structured: bool,
) -> AppResult<Value> {
    if q.get("knowledgeSchemaVersion")
        .is_some_and(|version| version != 2)
    {
        return Err(err("invalid_import", "知识点标注版本无效。"));
    }
    let kind = s(q, "questionType");
    if !matches!(
        kind,
        "single_choice" | "multiple_choice" | "fill_blank" | "free_response"
    ) {
        return Err(err("invalid_import", "题型需为单选、多选、填空或解答。"));
    }
    let stem = bounded_text(s(q, "stem"), 30_000, "题干")?;
    if stem.is_empty() {
        return Err(err("invalid_import", "题干不能为空。"));
    }
    let options = rows(&q["options"]);
    if options.len() > 20 {
        return Err(err("invalid_import", "选项数量过多。"));
    }
    let mut labels = HashSet::new();
    let options: Vec<Value> = options
        .iter()
        .map(|o| {
            let label = bounded_text(s(o, "label"), 8, "选项标识")?;
            if label.is_empty() || !labels.insert(label.clone()) {
                return Err(err("invalid_import", "选项标识不能为空或重复。"));
            }
            Ok(json!({"label":label,"text":bounded_text(s(o,"text"),10_000,"选项")?}))
        })
        .collect::<AppResult<_>>()?;
    if !matches!(kind, "single_choice" | "multiple_choice") && !options.is_empty() {
        return Err(err("invalid_import", "当前题型不应包含选择题选项。"));
    }
    let parts = rows(&q["parts"]);
    if parts.len() > 20 {
        return Err(err("invalid_import", "小问数量过多。"));
    }
    let mut part_ids = HashSet::new();
    let parts:Vec<Value>=parts.iter().map(|p|{let part_id=bounded_text(s(p,"partId"),40,"小问标识")?;if part_id.is_empty()||!part_ids.insert(part_id.clone()){return Err(err("invalid_import","小问标识不能为空或重复。"))}let mut part=json!({"partId":part_id,"prompt":bounded_text(s(p,"prompt"),15_000,"小问")?,"answer":bounded_text(s(p,"answer"),15_000,"答案")?,"solution":bounded_text(s(p,"solution"),30_000,"解析")?});if p.get("label").is_some(){part["label"]=json!(bounded_text(s(p,"label"),40,"小问原标签")?);}if let Some(parent)=p.get("parentPartId"){if !parent.is_null()&&!parent.is_string(){return Err(err("invalid_import","小问父级身份无效。"));}part["parentPartId"]=parent.clone();}Ok(part)}).collect::<AppResult<_>>()?;
    structured::validate_parts(&parts)?;
    let pages = rows(&q["pages"]);
    if (!structured && pages.is_empty())
        || pages
            .iter()
            .any(|p| p.as_u64().is_none_or(|p| p < 1 || p > page_count as u64))
    {
        return Err(err("invalid_import", "题目必须保留有效的原文页码。"));
    }
    for field in [
        "primaryKnowledgeUids",
        "sectionIds",
        "knowledgeUids",
        "knowledgeTopics",
        "requiredSectionIds",
        "requiredPremises",
    ] {
        if q.get(field).is_some_and(|v| {
            !v.is_array()
                || v.as_array().unwrap().len() > 100
                || v.as_array()
                    .unwrap()
                    .iter()
                    .any(|x| x.as_str().is_none_or(|s| s.len() > 300))
        }) {
            return Err(err("invalid_import", "目录映射格式无效。"));
        }
    }
    let mut normalized = json!({"questionId":id,"questionType":kind,"stem":stem,"options":options,"parts":parts,"answer":bounded_text(s(q,"answer"),30_000,"答案")?,"solution":bounded_text(s(q,"solution"),60_000,"解析")?,"sourceLabel":bounded_text(s(q,"sourceLabel"),100,"原题号")?,"pages":pages,"sectionIds":ids(&q["sectionIds"]),"knowledgeUids":ids(&q["knowledgeUids"]),"knowledgeTopics":ids(&q["knowledgeTopics"]),"task":{"id":bounded_text(s(&q["task"],"id"),100,"任务标识")?,"label":bounded_text(s(&q["task"],"label"),200,"考查任务")?},"requiredSectionIds":ids(&q["requiredSectionIds"]),"requiredPremises":ids(&q["requiredPremises"]),"allowedSolution":bounded_text(s(q,"allowedSolution"),5000,"解法依据")?,"mappingConfirmed":q["mappingConfirmed"]==true,"reviewDecision":q.get("reviewDecision").cloned().unwrap_or(json!("pending")),"reviewChecks":q.get("reviewChecks").cloned().unwrap_or(json!({"sourceMatched":false,"answerChecked":false,"solutionChecked":false,"formulaChecked":false})),"reviewBasis":bounded_text(s(q,"reviewBasis"),5000,"审核依据")?,"reviewIssues":[]});
    if new_knowledge_annotation(q) {
        normalized["knowledgeSchemaVersion"] = json!(2);
        // Preserve presence: an explicitly empty new annotation must never fall
        // back to broad legacy knowledge tags or section confirmations.
        normalized["primaryKnowledgeUids"] =
            q.get("primaryKnowledgeUids").cloned().unwrap_or(json!([]));
        normalized["solutionPaths"] = json!([]);
        if let Some(paths) = q.get("solutionPaths") {
            let paths = paths
                .as_array()
                .filter(|paths| paths.len() <= 20)
                .ok_or_else(|| err("invalid_import", "解法路径格式无效。"))?;
            let mut path_ids = HashSet::new();
            let paths = paths
                .iter()
                .map(|path| {
                    if !path.is_object() || path.get("basis").is_some_and(|v| !v.is_string()) {
                        return Err(err("invalid_import", "解法路径及依据格式无效。"));
                    }
                    let id = bounded_text(s(path, "id"), 100, "解法标识")?;
                    if id.is_empty() || !path_ids.insert(id.clone()) {
                        return Err(err("invalid_import", "解法路径标识不能重复。"));
                    }
                    for field in ["requiredKnowledgeUids", "requiredPremises"] {
                        if path.get(field).is_some_and(|v| {
                            !v.is_array()
                                || rows(v).len() > 100
                                || rows(v).iter().any(|v| {
                                    v.as_str().is_none_or(|s| s.is_empty() || s.len() > 300)
                                })
                        }) {
                            return Err(err("invalid_import", "解法依赖格式无效。"));
                        }
                    }
                    Ok(
                        json!({"id":id,"requiredKnowledgeUids":ids(&path["requiredKnowledgeUids"]),
                    "requiredPremises":ids(&path["requiredPremises"]),
                    "basis":bounded_text(s(path,"basis"),5000,"解法依据")?}),
                    )
                })
                .collect::<AppResult<Vec<Value>>>()?;
            normalized["solutionPaths"] = json!(paths);
        }
    }
    normalized["difficultyAssessment"] = annotations::normalize_difficulty(q)?;
    if structured {
        structured::preserve(&mut normalized, q)?;
    }
    paddle::preserve(&mut normalized, q)?;
    // These fields are immutable to review_save (checked against the prior
    // question), but ordinary uploads now have metadata attempts as well.
    for field in ["annotationStatus", "annotationError", "annotationAttempts"] {
        if let Some(value) = q.get(field) {
            normalized[field] = value.clone();
        }
    }
    Ok(normalized)
}
fn new_knowledge_annotation(q: &Value) -> bool {
    q.get("primaryKnowledgeUids").is_some()
        || q.get("solutionPaths").is_some()
        || q.get("knowledgeSchemaVersion").is_some()
}
/// Model-selected identities take effect directly, but an incomplete path is
/// never made complete using generic tags, section labels or graph ancestors.
fn knowledge_annotation(q: &Value, config: &Value, catalogue: &Value) -> AppResult<(Value, bool)> {
    if q.get("knowledgeSchemaVersion")
        .is_some_and(|version| version != 2)
    {
        return Err(err("invalid_import", "知识点标注版本无效。"));
    }
    let known: HashSet<_> = rows(&catalogue["knowledgePoints"])
        .into_iter()
        .map(|point| s(&point, "uid").to_owned())
        .collect();
    let premises: HashSet<_> = rows(&config["premises"])
        .into_iter()
        .map(|premise| s(&premise, "id").to_owned())
        .collect();
    let primary = ids(&q["primaryKnowledgeUids"]);
    let mut paths = rows(&q["solutionPaths"]);
    let dependencies: Vec<_> = paths
        .iter()
        .flat_map(|path| ids(&path["requiredKnowledgeUids"]))
        .collect();
    for uid in primary.iter().chain(dependencies.iter()) {
        if !known.contains(uid) {
            return Err(err(
                "invalid_mapping",
                "知识点不在本机目录中，不能使用模型猜测的身份。",
            ));
        }
    }
    for path in &mut paths {
        if ids(&path["requiredPremises"])
            .iter()
            .any(|id| !premises.contains(id))
        {
            return Err(err("invalid_mapping", "解法使用了未登记的工具或前提。"));
        }
        path["requiredSections"] = json!(crate::knowledge::sections_for_uids(
            config,
            &path["requiredKnowledgeUids"]
        ));
    }
    let complete = !primary.is_empty()
        && !paths.is_empty()
        && paths.iter().any(|path| {
            !s(path, "id").is_empty()
                && !s(path, "basis").trim().is_empty()
                && primary
                    .iter()
                    .all(|uid| ids(&path["requiredKnowledgeUids"]).contains(uid))
        });
    let annotation = json!({"knowledgeSchemaVersion":2,"primaryKnowledgeUids":primary,
        "primarySections":crate::knowledge::sections_for_uids(config,&q["primaryKnowledgeUids"]),
        "solutionPaths":paths});
    crate::knowledge::validate_annotation(&annotation, config)?;
    Ok((annotation, complete))
}
fn question_issues(q: &Value, source_issues: &Value) -> Vec<Value> {
    let pages = rows(&q["pages"]);
    let mut result: Vec<Value> = rows(source_issues)
        .into_iter()
        .filter(|issue| {
            issue["blocking"] != false
                && (issue["page"].as_u64().unwrap_or(0) == 0 || pages.contains(&issue["page"]))
        })
        .collect();
    result.extend(rows(&q["sourceIssues"]));
    result.extend(paddle::material_issues(q));
    if structured::is_structured(q) || paddle::uses(q) {
        if q["pages"].as_array().is_none_or(Vec::is_empty) {
            result.push(issue(
                "source_page_unknown",
                0,
                "原题页码未知，需核对原卷页码；不能猜造页码。",
            ));
        }
        if let Err(error) = structured::verify_assets(q) {
            result.push(issue("source_asset_unresolved", 0, &error.message));
        }
    }
    let body = json!({"stem":q["stem"],"options":q["options"],"parts":q["parts"]}).to_string();
    let trusted_assets = structured::is_structured(q) || paddle::uses(q);
    let visual_required = image_reference(&body);
    if (visual_required && !(trusted_assets && structured::has_student_assets(q)))
        || unsupported_embedded_markup(&body)
        || body.contains("SOURCE_VISUAL_UNRESOLVED")
        || body.contains("SOURCE_FORMULA_UNRESOLVED")
    {
        result.push(issue(
            "source_content_unresolved",
            0,
            "题目包含未保真提取的图片、公式或外部内容，不能直接发布。",
        ))
    }
    result
}
fn import_task_identity(task: &Value) -> Value {
    // Imported tasks may contain large prior-paper provenance, review prose
    // and alternatives. They are not source material for this new upload.
    json!({"id":task["id"],"label":task["label"],"questionType":task["questionType"],"sectionIds":task["sectionIds"]})
}
fn trusted_catalog(store: &Store) -> AppResult<Value> {
    let config = store.bank.config()?;
    let catalog = store.bank.catalog()?;
    fn flatten(v: &Value, parent: Option<&str>, out: &mut Vec<Value>) {
        for node in rows(v) {
            out.push(
                json!({"uid":node["uid"],"name":node["name"],"parentUid":parent,"sectionIds":[],"isLeaf":node["isLeaf"]==true && rows(&node["children"]).is_empty()}),
            );
            flatten(&node["children"], node["uid"].as_str(), out)
        }
    }
    // Keep identity and domain context: equal names in different textbook
    // branches are not interchangeable assessment targets.
    let mut knowledge = rows(&config["knowledgeCatalogue"]["points"]);
    if knowledge.is_empty() {
        flatten(&catalog["knowledgePoints"], None, &mut knowledge);
    }
    Ok(
        json!({"sections":config["chapters"],"tasks":rows(&config["tasks"]).iter().map(import_task_identity).collect::<Vec<_>>(),"premises":config["premises"],"knowledgePoints":knowledge}),
    )
}
/// Ordinary uploads keep each provider attempt beside the preserved original.
/// These immutable files survive an invalid response or a later record CAS
/// conflict; reading history never replays or adopts an old model response.
fn prepare_attempt_path(store: &Store, record: &Value, op: &str) -> AppResult<std::path::PathBuf> {
    let root = store.data_dir.join("imports").canonicalize()?;
    let source = store
        .data_dir
        .join(s(&record["source"], "relativePath"))
        .canonicalize()?;
    let directory = source
        .parent()
        .ok_or_else(|| err("invalid_source", "原件目录无效。"))?;
    if !directory.starts_with(root) || !source.is_file() {
        return Err(err("invalid_source", "原件目录越界。"));
    }
    Ok(directory.join(format!(
        "prepare-attempt-{}.json",
        &hash_json(&json!(op))[..24]
    )))
}
fn audit_relative_path(store: &Store, path: &Path) -> AppResult<String> {
    audit_relative_path_in(&store.data_dir, path)
}
fn audit_relative_path_in(data_dir: &Path, path: &Path) -> AppResult<String> {
    // Office returns ordinary Win32 paths; canonicalize both sides before
    // comparing their components, and resolve links before checking ownership.
    let target = path.canonicalize()
        .map_err(|_| err("invalid_source", "模型尝试审计路径无效。"))?;
    Ok(target
        .strip_prefix(data_dir.canonicalize()?)
        .map_err(|_| err("invalid_source", "模型尝试审计路径无效。"))?
        .to_string_lossy()
        .replace('\\', "/"))
}
/// A few attempt receipts precede creation of their final file or directory.
/// Only that one normal entry may be missing; its real parent must exist and
/// remain inside this runtime. Existing targets always use the strict check.
fn planned_audit_relative_path(store: &Store, path: &Path) -> AppResult<String> {
    planned_audit_relative_path_in(&store.data_dir, path)
}
fn planned_audit_relative_path_in(data_dir: &Path, path: &Path) -> AppResult<String> {
    let invalid = || err("invalid_source", "模型尝试审计路径无效。");
    if path.components().any(|part| matches!(part, std::path::Component::ParentDir)) {
        return Err(invalid());
    }
    let name = path.file_name().and_then(|v| v.to_str()).ok_or_else(invalid)?;
    let mut components = Path::new(name).components();
    if !matches!(components.next(), Some(std::path::Component::Normal(_)))
        || components.next().is_some() || name.chars().count() > 255
        || name.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        || name.ends_with('.') || name.ends_with(' ')
    {
        return Err(invalid());
    }
    match std::fs::symlink_metadata(path) {
        Ok(_) => return audit_relative_path_in(data_dir, path),
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => {},
        Err(_) => return Err(invalid()),
    }
    let parent = path.parent().ok_or_else(invalid)?.canonicalize().map_err(|_| invalid())?;
    if !parent.is_dir() { return Err(invalid()); }
    Ok(parent.join(name)
        .strip_prefix(data_dir.canonicalize()?)
        .map_err(|_| invalid())?
        .to_string_lossy()
        .replace('\\', "/"))
}
fn question_error(mut error: AppError, question: &Value, index: usize) -> AppError {
    let label = s(question, "sourceLabel")
        .chars()
        .filter(|c| !c.is_control())
        .take(40)
        .collect::<String>();
    let label = if label.is_empty() {
        format!("第 {} 条题目", index + 1)
    } else {
        format!("原卷第 {label} 题")
    };
    let pages = rows(&question["pages"])
        .iter()
        .filter_map(Value::as_u64)
        .filter(|n| *n > 0 && *n <= 50)
        .map(|n| n.to_string())
        .collect::<Vec<_>>();
    let location = if pages.is_empty() {
        String::new()
    } else {
        format!("（第 {} 页）", pages.join("、"))
    };
    error.message = format!("{label}{location}：{}", error.message);
    error
}
fn prepare_questions(
    store: &Store,
    result: &Value,
    record: &Value,
    page_count: usize,
    ocr_document: Option<&crate::ocr::OcrDocument>,
) -> AppResult<Vec<Value>> {
    prepare_questions_batch(store, result, record, page_count, ocr_document, 0, true)
}

fn prepare_questions_batch(
    store: &Store,
    result: &Value,
    record: &Value,
    page_count: usize,
    ocr_document: Option<&crate::ocr::OcrDocument>,
    offset: usize,
    complete_document: bool,
) -> AppResult<Vec<Value>> {
    let questions = result["questions"]
        .as_array()
        .filter(|q| !q.is_empty() && q.len() <= MAX_QUESTIONS)
        .ok_or_else(|| {
            err(
                "invalid_import",
                "模型没有返回 1–60 道完整题目。原文件已保留，可重试。",
            )
        })?;
    let mut pending = vec![];
    let config = store.bank.config()?;
    let catalogue = trusted_catalog(store)?;
    for (i, q) in questions.iter().enumerate() {
        let id = format!("{}-q{}", s(&record, "importId"), offset + i + 1);
        let mut proposed = q.clone();
        if record["sourceStructuring"]["pipelineVersion"] == "indexed_parallel_v2" || record["sourceStructuring"]["sourceOnlyCurrent"] == true {
            // The source stage cannot accidentally publish generated pedagogy.
            if let Some(object)=proposed.as_object_mut() {
                for key in ["difficultyAssessment","sectionIds","knowledgeUids","knowledgeTopics","task","requiredSectionIds","requiredPremises","allowedSolution","primaryKnowledgeUids","solutionPaths","generatedTeaching"] { object.remove(key); }
                object.insert("knowledgeSchemaVersion".into(),json!(2));
            }
        }
        for field in structured::IMMUTABLE_FIELDS {
            if let Some(object) = proposed.as_object_mut() {
                object.remove(*field);
            }
        }
        // This request used the knowledge-level contract. A model omitting
        // its fields has incomplete new evidence, not a legacy confirmation.
        proposed
            .as_object_mut()
            .ok_or_else(|| err("invalid_import", "模型题目格式无效。"))?
            .entry("knowledgeSchemaVersion".to_owned())
            .or_insert(json!(2));
        let mut q = normalize_question(&proposed, &id, page_count)
            .map_err(|error| question_error(error, &proposed, i))?;
        if let Some(document) = ocr_document {
            paddle::bind(
                &mut q,
                &proposed,
                document,
                s(&record["source"], "sha256"),
                s(&record["ocrSource"], "manifestSha256"),
            )
            .map_err(|error| question_error(error, &proposed, i))?;
        }
        if new_knowledge_annotation(&q) {
            knowledge_annotation(&q, &config, &catalogue)
                .map_err(|error| question_error(error, &proposed, i))?;
            crate::knowledge::validate_leaf_annotation(&q, &config)
                .map_err(|error| question_error(error, &proposed, i))?;
        }
        q["reviewDecision"] = json!("pending");
        q["mappingConfirmed"] = json!(false);
        q["knowledgeMappingSource"] = json!(if record["sourceStructuring"]["pipelineVersion"]=="indexed_parallel_v2" || record["sourceStructuring"]["sourceOnlyCurrent"]==true {"unknown"}else{"model"});
        q["reviewBasis"] = json!("");
        q["reviewChecks"] = json!({"sourceMatched":false,"answerChecked":false,"solutionChecked":false,"formulaChecked":false});
        q["reviewIssues"] = json!(question_issues(&q, &record["sourceIssues"]));
        teaching::initialize_pending(&mut q);
        #[cfg(test)]
        if proposed.get("generatedTeaching").is_some() {
            // Older isolation fixtures supply a prepared classroom candidate;
            // the new pending-generation route has separate transport tests.
            teaching::initialize(&mut q, &proposed);
        }
        pending.push(q)
    }
    if let Some(document) = ocr_document.filter(|_| complete_document) {
        paddle::coverage(&mut pending, document)?;
    }
    if pending.iter().map(structured::body_chars).sum::<usize>() > MAX_TEXT {
        return Err(err(
            "invalid_import",
            "模型题目总内容过长，未保存不完整结果。",
        ));
    }
    Ok(pending)
}

enum StagedImport {
    Existing(Value),
    Ready(Value, Vec<u8>),
}
fn import_role_configured(model: &ModelClient, field: &str) -> bool {
    model.public_settings()[field].as_bool().unwrap_or_else(|| model.configured())
}

fn stage_import(
    store: &mut Store,
    model: &ModelClient,
    payload: &Value,
    cancel: &AtomicBool,
) -> AppResult<StagedImport> {
    // Role readiness is local: importing must not require an unrelated active
    // assembly model, and a teaching-only resume need not select a source model.
    if !import_role_configured(model, "importTeachingConfigured") {
        return Err(err("not_configured", "请先在设置中配置解析生成模型，再导入试卷。"));
    }
    model.import_generator()?;
    let retry = !s(payload, "importId").is_empty();
    if !retry {
        model.import_source_model()?;
    }
    let ocr = crate::ocr_settings::OcrSettings::open(&store.data_dir)?;
    if !s(payload, "filename").is_empty()
        && paddle::document_extension(
            Path::new(s(payload, "filename"))
                .extension()
                .and_then(|v| v.to_str())
                .unwrap_or("")
                .to_ascii_lowercase()
                .as_str(),
        )
        && !ocr.configured()
    {
        return Err(err(
            "ocr_not_configured",
            "请先在设置的“试卷识别”中配置 PaddleOCR，再导入试卷。",
        ));
    }
    cancelled(cancel)?;
    let op = operation(payload)?;
    let hash = hash_json(payload);
    let (record, bytes) = if retry {
        let record = store.document("imports", s(payload, "importId"))?;
        if replay(&record, op, &hash)? {
            return Ok(StagedImport::Existing(record));
        }
        revision(&record, payload)?;
        if matches!(s(&record["backgroundJob"], "status"), "queued" | "running") {
            return Err(err(
                "import_running",
                "此试卷正在后台解析，请等待完成或先停止当前任务。",
            ));
        }
        let resume_teaching = !rows(&record["questions"]).is_empty()
            && (record["status"] == "failed" || record["status"] == "pending_review"
                || matches!(s(&record["backgroundJob"],"status"),"interrupted"|"cancelled"|"failed"))
            && rows(&record["questions"]).iter().all(|q| q["teachingWorkflow"].is_object());
        if !rows(&record["publishedQuestionIds"]).is_empty()
            || (!rows(&record["questions"]).is_empty() && !resume_teaching)
        {
            return Err(err(
                "review_exists",
                "已有审核题目，请继续审核；重新解析需另建导入，避免覆盖修改。",
            ));
        }
        if !resume_teaching {
            model.import_source_model()?;
        }
        if !resume_teaching && !record["ocrSource"].is_object()
            && paddle::document_extension(s(&record["source"], "extension")) && !ocr.configured()
        {
            return Err(err("ocr_not_configured", "请先在设置的“试卷识别”中配置 PaddleOCR，再重新识别。"));
        }
        let bytes = read_source(store, &record)?;
        (record, bytes)
    } else {
        let (name, extension) = filename(s(payload, "filename"))?;
        let encoded = s(payload, "contentBase64");
        if encoded.len() > MAX_BYTES.div_ceil(3) * 4 + 4 {
            return Err(err("file_too_large", "文件超过 15 MB，请分拆后导入。"));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| err("invalid_file", "文件数据编码无效。"))?;
        if bytes.is_empty() || bytes.len() > MAX_BYTES {
            return Err(err("file_too_large", "文件需为 1 字节至 15 MB。"));
        }
        let id = format!("import-{}", &hash_json(&json!(op))[..24]);
        if let Ok(previous) = store.document("imports", &id) {
            if replay(&previous, op, &hash)? {
                return Ok(StagedImport::Existing(previous));
            }
            if previous["creationHash"] != hash {
                return Err(err("operation_conflict", "此导入操作标识已用于其他文件。"));
            }
            // Original preservation may have committed just before the process
            // stopped. Exact upload replay returns that local record without
            // another extraction/model call; explicit retry uses a new ID.
            return Ok(StagedImport::Existing(previous));
        }
        cancelled(cancel)?;
        let source = save_source(store, &id, &extension, &bytes)?;
        let timestamp = now();
        let record = json!({"importId":id,"filename":name,"status":"processing","revision":0,"createdAt":timestamp,"updatedAt":timestamp,"creationHash":hash,"source":source,"questions":[],"sourceIssues":[],"operations":[],"publishedQuestionIds":[],"publicationHistory":[],"error":null});
        save_cas(store, None, &record)?;
        (record, bytes)
    };
    Ok(StagedImport::Ready(record, bytes))
}
fn prepare(
    store: &mut Store,
    model: &ModelClient,
    payload: &Value,
    cancel: &AtomicBool,
) -> AppResult<Value> {
    match stage_import(store, model, payload, cancel)? {
        StagedImport::Existing(record) => Ok(
            json!({"import":record,"diagnostic":diagnostics::for_record(store,&record),"reviewEligibility":review::eligibility(&record)}),
        ),
        StagedImport::Ready(record, bytes) => process_import(
            store,
            model,
            operation(payload)?,
            &hash_json(payload),
            cancel,
            record,
            bytes,
        ),
    }
}
fn process_import(
    store: &mut Store,
    model: &ModelClient,
    op: &str,
    hash: &str,
    cancel: &AtomicBool,
    record: Value,
    bytes: Vec<u8>,
) -> AppResult<Value> {
    process_import_scoped(store, model, op, hash, cancel, record, bytes, ImportScope::Full)
}

#[derive(Clone, Copy)]
enum ImportScope {
    Full,
    #[cfg(debug_assertions)]
    OcrTrial,
    #[cfg(debug_assertions)]
    SourceTrial { layout: bool, plan_only: bool },
}
impl ImportScope {
    fn source_only(self) -> bool { !matches!(self, Self::Full) }
    fn plan_only(self) -> bool {
        #[cfg(debug_assertions)]
        if let Self::SourceTrial { plan_only, .. } = self { return plan_only; }
        false
    }
}
fn process_import_scoped(
    store: &mut Store, model: &ModelClient, op: &str, hash: &str,
    cancel: &AtomicBool, mut record: Value, bytes: Vec<u8>, scope: ImportScope,
) -> AppResult<Value> {
    let workflow_model = model;
    let ocr = crate::ocr_settings::OcrSettings::open(&store.data_dir)?;
    let mut saved = record.clone();
    record["status"] = json!("processing");
    record["error"] = Value::Null;
    save_cas(store, Some(&saved), &record)?;
    saved = record.clone();
    let outcome = (|| -> AppResult<()> {
        if !rows(&record["questions"]).is_empty() {
            if scope.source_only() { return Err(err("source_trial_completed", "拆题试验不覆盖已有题目。")); }
            let assets = if record["ocrSource"].is_object() { paddle::load_document(store,&record)?.assets } else {vec![]};
            teaching::process(store,workflow_model,&mut record,&mut saved,&assets,cancel)?;
            record["status"]=json!("pending_review");record["recognitionStage"]=json!("complete");
            return Ok(());
        }
        let source_model = workflow_model.import_source_model()?;
        let model = &source_model;
        let attempt_path = prepare_attempt_path(store, &record, op)?;
        let provider_path = attempt_path.with_extension("provider-response.json");
        if attempt_path.exists() || provider_path.exists() {
            return Err(err(
                "operation_conflict",
                "此操作已有模型尝试审计，请使用新的操作标识重试；旧响应不会被覆盖或自动采用。",
            ));
        }
        let mut ocr_document = None;
        let extracted = if paddle::document_extension(s(&record["source"], "extension")) {
            if record["ocrSource"].is_object() {
                ocr_document = Some(paddle::load_document(store, &record)?);
            } else {
                let prior_ocr = ocr_resume::accepted_attempt(store, &record, &ocr)?;
                let ocr_directory = attempt_path.with_extension("ocr");
                if prior_ocr.is_none() { std::fs::create_dir(&ocr_directory)?; }
                record["recognitionStage"] = json!("recognizing");
                let prior_attempt = record["ocrAttempt"].clone();
                save_cas(store, Some(&saved), &record)?;
                saved = record.clone();
                let extension = s(&record["source"], "extension").to_owned();
                let pdf_bytes = if extension == "docx" {
                    if record["renderedPdf"].is_object() {
                        paddle::read_rendered_pdf(store, &record)?
                    } else {
                        if prior_ocr.is_some() { return Err(err("source_changed", "旧识别任务缺少已校验的转换PDF，未重复转换或上传。")); }
                        let source_path = store.data_dir.join(s(&record["source"], "relativePath"));
                        let converted = docx_pdf::convert(&source_path, &ocr_directory, cancel)?;
                        let pdf_bytes = std::fs::read(&converted)?;
                        record["renderedPdf"] = json!({"relativePath":audit_relative_path(store,&converted)?,"sha256":sha(&pdf_bytes),"sourceSha256":record["source"]["sha256"]});
                        save_cas(store, Some(&saved), &record)?;
                        saved = record.clone();
                        pdf_bytes
                    }
                } else {
                    bytes.clone()
                };
                let (pdf, inspection) = pdf_inspection::inspect(&pdf_bytes)?;
                if let Some(inspection) = inspection {
                    record["pdfInspection"] = inspection;
                    save_cas(store, Some(&saved), &record)?;
                    saved = record.clone();
                }
                if pdf.is_encrypted() {
                    return Err(err("encrypted_pdf", "请先移除 PDF 密码后再导入。"));
                }
                let physical_pages = pdf.get_pages().len();
                if physical_pages == 0 || physical_pages > 50 {
                    return Err(err("page_limit", "每次可识别1–50页，请分拆后导入。"));
                }
                let upload_name = if extension == "docx" {
                    format!(
                        "{}.pdf",
                        record["filename"]
                            .as_str()
                            .unwrap_or("试卷")
                            .trim_end_matches(".docx")
                    )
                } else {
                    s(&record, "filename").to_owned()
                };
                // Complete every PDF/source preflight before replacing the
                // prior accepted job pointer with a new recovery directory.
                record["ocrAttempt"] = json!({"relativePath":planned_audit_relative_path(store,&ocr_directory)?,"provider":ocr.descriptor(),"sourceSha256":record["source"]["sha256"],"startedAt":now()});
                if prior_ocr.is_some() {
                    record["ocrAttempt"]["resumeFrom"] = prior_attempt.clone();
                    record["ocrAttempt"]["newOcrSubmission"] = json!(false);
                }
                save_cas(store, Some(&saved), &record)?;
                saved = record.clone();
                let document_result = if let Some(old_audit) = prior_ocr.as_ref() {
                    crate::ocr::resume_existing(&ocr, &pdf_bytes, &upload_name, old_audit, &ocr_directory, None, cancel)
                } else {
                    crate::ocr::recognize(&ocr, &pdf_bytes, &upload_name, "application/pdf", &ocr_directory, cancel)
                };
                let document = match document_result {
                    Ok(document) => document,
                    Err(error) => {
                        // Validation can reject a resume before its new task
                        // receipt exists. Keep the prior resumable identity;
                        // retain the failed target separately as audit only.
                        if prior_ocr.is_some() && !ocr_directory.join("accepted-job.json").is_file() {
                            let mut failures=rows(&record["ocrResumeFailures"]);
                            failures.push(json!({"attempt":record["ocrAttempt"],"errorCode":error.code,"failedAt":now()}));
                            if failures.len()>30 { failures.drain(..failures.len()-30); }
                            record["ocrResumeFailures"]=json!(failures);
                            record["ocrAttempt"]=prior_attempt;
                        }
                        return Err(error);
                    }
                };
                if document.pages.len() != physical_pages {
                    return Err(err(
                        "ocr_page_mismatch",
                        "识别返回页数与原 PDF 不一致，未继续整理。",
                    ));
                }
                paddle::save_document(
                    store,
                    &mut record,
                    &document,
                    &ocr_directory,
                    ocr.descriptor(),
                )?;
                ocr_document = Some(document);
            }
            let document = ocr_document.as_ref().unwrap();
            Extracted {
                pages: document
                    .pages
                    .iter()
                    .map(|p| s(p, "text").to_owned())
                    .collect(),
                issues: document.issues.clone(),
            }
        } else {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                extract(s(&record["source"], "extension"), &bytes, cancel)
            }))
            .map_err(|_| err("extraction_failed", "文件提取未完成，原文件已保留。"))??
        };
        if extracted
            .pages
            .iter()
            .map(|s| s.chars().count())
            .sum::<usize>()
            > MAX_TEXT
        {
            return Err(err(
                "text_too_large",
                "识别文本超过24万字，请分拆试卷后导入。",
            ));
        }
        record["sourceIssues"] = json!(extracted.issues);
        record["source"]["physicalPages"] = json!(extracted.pages.len());
        record["extractedPages"] = json!(extracted.pages);
        save_cas(store, Some(&saved), &record)?;
        saved = record.clone();
        cancelled(cancel)?;
        #[cfg(debug_assertions)]
        if matches!(scope,ImportScope::OcrTrial) {
            if ocr_document.is_none() {return Err(err("source_trial_ocr_required","OCR隔离试验仅接受普通PDF或DOCX来源。"));}
            record["ocrTrial"]=json!({"experiment":"index-batch-120s-v1","modelCalls":0,"sourceOnly":true});
            record["status"]=json!("pending_review");
            record["recognitionStage"]=json!("ocr_ready");
            return Ok(());
        }
        // The formal OCR source stage owns its shared 120s budget. Both new
        // work and cached source replay use saved models without catalogue GETs.
        if matches!(scope,ImportScope::Full) {
            if let Some(document)=ocr_document.as_ref() {
                let replayed=if record["sourceStructuring"].is_null() {
                    source_recovery::replay(store,model,&mut record,&mut saved,document,op)?
                } else {None};
                let mut pending=if let Some(q)=replayed {q} else {
                    source_batches::process_indexed(store,model,&mut record,&mut saved,document,cancel,op,hash)?
                };
                cancelled(cancel)?;duplicates::annotate(&store.bank,&mut pending)?;
                record["questions"]=json!(pending);save_cas(store,Some(&saved),&record)?;saved=record.clone();
                teaching::process(store,workflow_model,&mut record,&mut saved,&document.assets,cancel)?;
                record["status"]=json!("pending_review");record["recognitionStage"]=json!("complete");
                return Ok(());
            }
        }
        // Configuration is already checked before import. Record the local
        // selection; the completion API determines model availability.
        record["sourceParsingModel"] = model.import_execution_identity()?;
        save_cas(store,Some(&saved),&record)?;saved=record.clone();
        #[cfg(debug_assertions)]
        if let ImportScope::SourceTrial { layout: true, .. } = scope {
            let document = ocr_document.as_ref().ok_or_else(|| err("source_trial_ocr_required", "本次拆题试验只使用真实有效OCR材料。"))?;
            record["sourceTrial"]["readingView"] = layout_reading::build(document)?;
            save_cas(store,Some(&saved),&record)?;saved=record.clone();
        }
        record["recognitionStage"] = json!("structuring");
        save_cas(store, Some(&saved), &record)?;
        saved = record.clone();
        let mut context = json!({"document":{"filename":record["filename"],"pages":extracted.pages.iter().enumerate().map(|(i,t)|json!({"page":i+1,"text":t})).collect::<Vec<_>>(),"sourceIssues":record["sourceIssues"]},"trustedCatalogue":trusted_catalog(store)?});
        if let Some(document) = &ocr_document {
            context["document"] = paddle::context(document);
            context["document"]["filename"] = record["filename"].clone();
        }
        context["sourceSha256"] = record["source"]["sha256"].clone();
        context["includeSourcePagesForReview"] = json!(true);
        context["imageReviewAvailable"] = json!(
            model.import_review_images_supported()
                && ocr_document.as_ref().is_some_and(|d| !d.assets.is_empty())
        );
        if let Some(document) = ocr_document.as_ref().filter(|document| {
            matches!(scope, ImportScope::Full)
                || record["sourceStructuring"].is_object()
                || scope.source_only()
                || document.pages.len() > 3
                || extracted.pages.iter().map(|page| page.chars().count()).sum::<usize>() > 12_000
        }) {
            if scope.plan_only() {
                let plan=source_batches::prepare_plan(store,model,&mut record,&mut saved,document,cancel,op,hash)?;
                record["sourceTrial"]["planQuestionCount"]=json!(rows(&plan["questions"]).len());
                record["sourceTrial"]["phase"]=json!("plan_only_complete");
                record["status"]=json!("pending_review");record["recognitionStage"]=json!("complete");
                return Ok(());
            }
            let mut pending = if matches!(scope, ImportScope::Full) {
                source_batches::process_indexed(store,model,&mut record,&mut saved,document,cancel,op,hash)?
            } else {
                source_batches::process(store,model,&mut record,&mut saved,document,cancel,op,hash)?
            };
            cancelled(cancel)?;
            duplicates::annotate(&store.bank, &mut pending)?;
            record["questions"] = json!(pending);
            save_cas(store, Some(&saved), &record)?;
            saved = record.clone();
            if !scope.source_only() { teaching::process(store, workflow_model, &mut record, &mut saved, &document.assets, cancel)?; }
            record["status"] = json!("pending_review");
            record["recognitionStage"] = json!("complete");
            return Ok(());
        }
        if let Some(document) = &ocr_document {
            if let Some(mut pending) = source_recovery::replay(store,model,&mut record,&mut saved,document,op)? {
                cancelled(cancel)?;
                duplicates::annotate(&store.bank,&mut pending)?;
                record["questions"]=json!(pending);
                save_cas(store,Some(&saved),&record)?;saved=record.clone();
                if !scope.source_only() { teaching::process(store,workflow_model,&mut record,&mut saved,&document.assets,cancel)?; }
                record["status"]=json!("pending_review");record["recognitionStage"]=json!("complete");
                return Ok(());
            }
        }
        let mut pending = vec![];
        // Unsafe source structure cannot supply stable question identities to
        // a classroom reviewer. Preserve the failed response; only an explicit
        // new import retry may request source transcription again.
        for attempt_number in 1..=1 {
            cancelled(cancel)?;
            let call_path = if attempt_number == 1 {
                attempt_path.clone()
            } else {
                attempt_path.with_file_name(format!(
                    "{}-format-retry-1.json",
                    attempt_path
                        .file_stem()
                        .and_then(|v| v.to_str())
                        .unwrap_or("prepare-attempt")
                ))
            };
            let response_path = call_path.with_extension("provider-response.json");
            if call_path.exists() || response_path.exists() {
                return Err(err(
                    "operation_conflict",
                    "此操作已有模型尝试审计，请使用新的操作标识重试；旧响应不会被覆盖或自动采用。",
                ));
            }
            let attempt = json!({"schemaVersion":1,"task":"question_import","importId":record["importId"],"operationId":op,"attemptNumber":attempt_number,"requestSha256":hash,"contextSha256":hash_json(&context),"sourceSha256":record["source"]["sha256"],"at":now()});
            let attempt_bytes = serde_json::to_vec_pretty(&attempt)?;
            let mut file = std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&call_path)?;
            file.write_all(&attempt_bytes)?;
            file.sync_all()?;
            let mut attempts = rows(&record["modelAttempts"]);
            let mut entry = attempt;
            entry["attemptRelativePath"] = json!(audit_relative_path(store, &call_path)?);
            entry["attemptSha256"] = json!(sha(&attempt_bytes));
            entry["status"] = json!("processing");
            attempts.push(entry);
            record["modelAttempts"] = json!(attempts);
            save_cas(store, Some(&saved), &record)?;
            saved = record.clone();
            let source_assets = ocr_document
                .as_ref()
                .map(|document| document.assets.as_slice())
                .unwrap_or(&[]);
            let proposed = model.propose_import_with_audit(
                &context,
                source_assets,
                cancel,
                Some(&response_path),
            );
            let proposed = proposed.and_then(|result| {
                let questions = prepare_questions(
                    store,
                    &result,
                    &record,
                    extracted.pages.len(),
                    ocr_document.as_ref(),
                )?;
                Ok((questions, result))
            });
            let entry = record["modelAttempts"]
                .as_array_mut()
                .unwrap()
                .last_mut()
                .unwrap();
            entry["finishedAt"] = json!(now());
            entry["status"] = json!(if proposed.is_ok() {
                "succeeded"
            } else {
                "failed"
            });
            entry["error"] = proposed
                .as_ref()
                .err()
                .map(|e| serde_json::to_value(e).unwrap_or(Value::Null))
                .unwrap_or(Value::Null);
            if response_path.exists() {
                entry["providerResponseRelativePath"] =
                    json!(audit_relative_path(store, &response_path)?);
                entry["providerResponseSha256"] = json!(sha(&std::fs::read(&response_path)?));
            }
            let request_path=response_path.with_extension("request.json");
            if request_path.exists() {
                let audit_bytes=std::fs::read(&request_path)?;
                let audit:Value=serde_json::from_slice(&audit_bytes)?;
                entry["requestRelativePath"]=json!(audit_relative_path(store,&request_path)?);
                entry["requestFileSha256"]=json!(sha(&audit_bytes));
                entry["requestBodySha256"]=audit["bodySha256"].clone();
                entry["promptSha256"]=audit["promptSha256"].clone();
            }
            save_cas(store, Some(&saved), &record)?;
            saved = record.clone();
            match proposed {
                Ok((mut value, raw)) => {
                    review::attach_import_opinions(
                        store,
                        model,
                        &record,
                        &raw,
                        &context,
                        &response_path,
                        &mut value,
                    )?;
                    #[cfg(test)]
                    for q in value.iter_mut().filter(|q|q["teachingWorkflow"]["version"]=="import-teaching-workflow-v1") {
                        let attempt=record["modelAttempts"].as_array().unwrap().last().unwrap();
                        q["teachingWorkflow"]["model"]=model.public_settings()["model"].clone();
                        q["teachingWorkflow"]["requestSha256"]=attempt["requestBodySha256"].clone();
                        q["teachingWorkflow"]["promptSha256"]=attempt["promptSha256"].clone();
                        q["teachingWorkflow"]["requestRelativePath"]=attempt["requestRelativePath"].clone();
                        q["teachingWorkflow"]["requestFileSha256"]=attempt["requestFileSha256"].clone();
                        q["teachingWorkflow"]["generationAudit"]=json!({"responseRelativePath":attempt["providerResponseRelativePath"],"responseSha256":attempt["providerResponseSha256"]});
                    }
                    pending = value;
                    break;
                }
                Err(error) => return Err(error),
            }
        }
        cancelled(cancel)?;
        duplicates::annotate(&store.bank, &mut pending)?;
        record["questions"] = json!(pending);
        // Persist the faithful transcription and initial draft before any
        // conditional reviewer call. Cancellation never discards source work.
        save_cas(store,Some(&saved),&record)?;saved=record.clone();
        let source_assets=ocr_document.as_ref().map(|d|d.assets.as_slice()).unwrap_or(&[]);
        if !scope.source_only() { teaching::process(store,workflow_model,&mut record,&mut saved,source_assets,cancel)?; }
        record["status"] = json!("pending_review");
        record["recognitionStage"] = json!("complete");
        Ok(())
    })();
    if let Err(error) = outcome {
        record["status"] = json!("failed");
        record["error"] = serde_json::to_value(error)?;
    }
    if record["backgroundJob"].is_object() {
        record["backgroundJob"]["status"] = json!(if record["error"]["code"] == "cancelled" {
            "cancelled"
        } else if record["status"] == "failed" {
            "failed"
        } else {
            "completed"
        });
        record["backgroundJob"]["finishedAt"] = json!(now());
    }
    finish(&mut record, op, &hash, "prepare");
    save_cas(store, Some(&saved), &record)?;
    Ok(
        json!({"import":record,"diagnostic":diagnostics::for_record(store,&record),"reviewEligibility":review::eligibility(&record)}),
    )
}

/// Required checks derive from actual question and part contents, never from a
/// client-provided exemption. Missing original answers/solutions remain empty.
fn review_requirements(q: &Value) -> Vec<&'static str> {
    let mut required = vec!["sourceMatched", "formulaChecked"];
    for (field, check) in [("answer", "answerChecked"), ("solution", "solutionChecked")] {
        if !s(q, field).trim().is_empty()
            || rows(&q["parts"])
                .iter()
                .any(|part| !s(part, field).trim().is_empty())
        {
            required.push(check);
        }
    }
    required
}
fn review_requirement_map(record: &Value) -> Value {
    let mut result = serde_json::Map::new();
    for question in rows(&record["questions"]) {
        result.insert(
            s(&question, "questionId").to_owned(),
            json!(review_requirements(&question)),
        );
    }
    Value::Object(result)
}

fn check_approved(q: &Value, record: &Value) -> AppResult<()> {
    if s(q, "reviewDecision") != "approve" {
        return Ok(());
    }
    teaching::verify_source_material(q)?;
    if paddle::uses(q)
        && (q["sourceIdentity"]["sourceSha256"] != record["source"]["sha256"]
            || q["sourceIdentity"]["manifestSha256"] != record["ocrSource"]["manifestSha256"])
    {
        return Err(err("source_changed", "题目与原始识别材料不匹配。"));
    }
    if review_requirements(q)
        .iter()
        .any(|key| q["reviewChecks"][key] != true)
        || s(q, "reviewBasis").trim().is_empty()
    {
        return Err(err(
            "review_required",
            "请核对本题题干、选项与公式图表；仅当原卷有答案或解析时核对对应内容，并填写实际审核依据。",
        ));
    }
    let source_issues=question_issues(q,&record["sourceIssues"]);
    #[cfg(debug_assertions)]
    let source_issues=source_trial_adoption::acknowledged_layout_issues(q,record,source_issues);
    if !source_issues.is_empty() {
        return Err(err(
            "source_content_unresolved",
            "原文图片、公式或表格未完整保留，相关题目不能发布，请改用完整可编辑原文件重新导入。",
        ));
    }
    if matches!(s(q, "questionType"), "single_choice" | "multiple_choice")
        && (rows(&q["options"]).len() < 2
            || rows(&q["options"]).iter().any(|o| s(o, "text").is_empty()))
    {
        return Err(err("invalid_import", "选择题需保留至少两个完整选项。"));
    }
    Ok(())
}
fn review_save(store: &Store, payload: &Value) -> AppResult<Value> {
    review_save_with_scope(store, payload, false)
}
fn review_save_with_scope(store: &Store, payload: &Value, single: bool) -> AppResult<Value> {
    let op = operation(payload)?;
    let hash = hash_json(payload);
    let mut record = store.document("imports", s(payload, "importId"))?;
    if matches!(s(&record["backgroundJob"], "status"), "queued" | "running") {
        return Err(err(
            "import_running",
            "此试卷正在后台处理，完成或停止后再保存审核；其它试卷仍可编辑。",
        ));
    }
    paddle::verify_audit(store, &record)?;
    if replay(&record, op, &hash)? {
        return Ok(json!({"reviewEligibility":review::eligibility(&record),"import":record}));
    }
    revision(&record, payload)?;
    if record["pendingPublication"].is_object() || record["pendingTeachingPublication"].is_object() {
        return Err(err(
            "publication_pending",
            "请先重试完成上一次发布，再修改审核。",
        ));
    }
    let saved = record.clone();
    let previous = rows(&record["questions"]);
    let questions = if single {
        let id = s(payload, "questionId");
        if id.is_empty() || payload["question"]["questionId"] != id
            || !previous.iter().any(|q| q["questionId"] == id) {
            return Err(err("invalid_import", "题目不属于本次导入或身份不一致。"));
        }
        previous.iter().map(|q| if q["questionId"] == id { payload["question"].clone() } else { q.clone() }).collect::<Vec<_>>()
    } else {
        payload["questions"].as_array().cloned()
            .ok_or_else(|| err("invalid_import", "缺少完整审核题目。"))?
    };
    if questions.len() != previous.len() || questions.is_empty() || questions.len() > MAX_QUESTIONS
    {
        return Err(err(
            "invalid_import",
            "审核不能增删原始题目身份，请拒绝不需要的题目。",
        ));
    }
    let published = ids(&record["publishedQuestionIds"]);
    let page_count = record["source"]["physicalPages"].as_u64().unwrap_or(1) as usize;
    let mut normalized = vec![];
    let mut seen = HashSet::new();
    for q in &questions {
        let id = s(q, "questionId");
        let old = previous
            .iter()
            .find(|p| p["questionId"] == id)
            .ok_or_else(|| err("invalid_import", "审核题目身份不匹配。"))?;
        if !seen.insert(id) {
            return Err(err("invalid_import", "审核题目身份重复。"));
        }
        if single && id != s(payload, "questionId") {
            normalized.push(old.clone());
            continue;
        }
        if q["_detailLoaded"] == false {
            return Err(err("invalid_import", "请先读取完整题目，再保存审核修改。"));
        }
        if published.iter().any(|p| p == id) {
            if old != q {
                return Err(err(
                    "immutable_question",
                    "已发布题目不能通过待审核记录修改。",
                ));
            }
            normalized.push(old.clone());
            continue;
        }
        structured::check_review_immutable(old, q)?;
        if paddle::uses(old) && (old["sourceBlockIds"] != q["sourceBlockIds"] || old["sourceMaterialRoles"] != q["sourceMaterialRoles"]) {
            return Err(err("immutable_source", "来源版面块和已记录素材归属不能通过审核改写。"));
        }
        let mut next = if structured::is_structured(old) {
            normalize_question_inner(q, id, page_count, true)?
        } else {
            normalize_question(q, id, page_count)?
        };
        // Asset placement evidence is generated by the source pipeline, not an
        // editable question field. The shared normalizer intentionally does not
        // trust model-supplied audits, so restore only the persisted evidence.
        // Older clients may omit it, but cannot add or rewrite it on save.
        if q.get("sourceAssetBindingAudit")
            .is_some_and(|audit| old.get("sourceAssetBindingAudit") != Some(audit))
        {
            return Err(err("immutable_source", "题图绑定审计不能通过原题审核新增或改写。"));
        }
        if let Some(audit) = old.get("sourceAssetBindingAudit") {
            next["sourceAssetBindingAudit"] = audit.clone();
        }
        if new_knowledge_annotation(&next) {
            knowledge_annotation(&next, &store.bank.config()?, &trusted_catalog(store)?)?;
            if next["primaryKnowledgeUids"] != old["primaryKnowledgeUids"]
                || next["solutionPaths"] != old["solutionPaths"]
            {
                crate::knowledge::validate_leaf_annotation(&next, &store.bank.config()?)?;
            }
        }
        next["knowledgeMappingSource"] = if next["knowledgeUids"] != old["knowledgeUids"]
            || next["knowledgeTopics"] != old["knowledgeTopics"]
            || next["primaryKnowledgeUids"] != old["primaryKnowledgeUids"]
            || next["solutionPaths"] != old["solutionPaths"]
        {
            json!("teacher_edit")
        } else {
            old.get("knowledgeMappingSource")
                .cloned()
                .unwrap_or(json!("model"))
        };
        if !matches!(s(&next, "reviewDecision"), "pending" | "approve" | "reject") {
            return Err(err("invalid_import", "审核状态无效。"));
        }
        if next["pages"] != old["pages"] || next["sourceLabel"] != old["sourceLabel"] {
            return Err(err("invalid_import", "原题号和来源页码不能在审核时改变。"));
        }
        if old["modelReview"].is_object() {
            next["modelReview"] = old["modelReview"].clone();
            if review::content_hash(&next) != review::content_hash(old) {
                next["modelReview"]["status"] = json!("stale");
                next["modelReview"]["summary"] = json!("题目内容已修改，请重新检查或人工核对。");
            }
        }
        teaching::preserve(old,&mut next);
        next["reviewIssues"] = json!(question_issues(&next, &record["sourceIssues"]));
        check_approved(&next, &record)?;
        normalized.push(next)
    }
    if normalized.iter().map(structured::body_chars).sum::<usize>() > MAX_TEXT {
        return Err(err("invalid_import", "审核内容总长度超过限制。"));
    }
    duplicates::annotate(&store.bank, &mut normalized)?;
    if single {
        for q in &mut normalized {
            if q["questionId"] != payload["questionId"] {
                *q = previous.iter().find(|old| old["questionId"] == q["questionId"]).unwrap().clone();
            }
        }
    }
    record["questions"] = json!(normalized);
    record["status"] = json!(if published.is_empty() {
        "pending_review"
    } else {
        "partially_published"
    });
    record["error"] = Value::Null;
    finish(&mut record, op, &hash, "review");
    save_cas(store, Some(&saved), &record)?;
    Ok(json!({"reviewEligibility":review::eligibility(&record),"import":record}))
}
fn verify_recovered_source_for_publication(store: &Store, record: &Value) -> AppResult<()> {
    #[cfg(debug_assertions)]
    if record["sourceTrialAdoption"].is_object() {
        return source_trial_adoption::verify(store,record);
    }
    if (!record["sourceStructuring"].is_null() && !record["sourceStructuring"].is_object())
        || (!record["sourceMaterialSupplement"].is_null() && !record["sourceMaterialSupplement"].is_object())
        || (!record["sourceResponseReplays"].is_null() && !record["sourceResponseReplays"].is_array()) {
        return Err(err("source_checkpoint_changed", "来源恢复记录结构无效，未加入题库。"));
    }
    let has_recovery = record["sourceMaterialSupplement"].is_object()
        || !rows(&record["sourceResponseReplays"]).is_empty()
        || rows(&record["questions"]).iter().any(|q| rows(&q["sourceMaterialRoles"]).iter().any(|role|role.get("supplementInputSha256").is_some() || role.get("representedByAssetId").is_some()));
    if has_recovery || record["sourceStructuring"].is_object() {
        // The normal release publication path must replay the same evidence as
        // the explicit maintenance path; a pending manifest cannot bypass it.
        read_source(store, record)?;
        source_batches::verify_completed_source(store, record)?;
    }
    Ok(())
}
fn build_manifest(store: &Store, record: &Value) -> AppResult<Value> {
    build_manifest_with_review(store, record, None)
}
fn build_manifest_with_review(
    store: &Store,
    record: &Value,
    agent_review: Option<&Value>,
) -> AppResult<Value> {
    paddle::verify_audit(store, record)?;
    verify_recovered_source_for_publication(store, record)?;
    // The agent authority is only constructed by the debug maintenance entry.
    // Ordinary UI publication continues to require the teacher gate unchanged.
    #[cfg(not(debug_assertions))]
    let agent_review = {
        let _ = agent_review;
        None::<&Value>
    };
    let config = store.bank.config()?;
    let catalogue = trusted_catalog(store)?;
    let published = ids(&record["publishedQuestionIds"]);
    let sections: HashSet<_> = rows(&config["chapters"])
        .iter()
        .map(|c| s(c, "id").to_owned())
        .collect();
    let premises: HashSet<_> = rows(&config["premises"])
        .iter()
        .map(|c| s(c, "id").to_owned())
        .collect();
    let source_id = format!("desktop-{}", s(record, "importId"));
    let mut questions = vec![];
    let mut tasks = vec![];
    let mut entries = vec![];
    let mut section_mappings = vec![];
    let mut knowledge_mappings = vec![];
    let mut current_questions = rows(&record["questions"]);
    duplicates::annotate(&store.bank, &mut current_questions)?;
    for q in current_questions.iter().filter(|q| {
        (s(q, "reviewDecision") == "approve" || review::model_ready(q, record))
            && !published.iter().any(|id| id == s(q, "questionId"))
    }) {
        let model_approved = s(q, "reviewDecision") != "approve" && review::model_ready(q, record);
        if model_approved {
            review::verify_opinion(store, q, record)?;
        } else {
            check_approved(q, record)?;
        }
        if rows(&q["duplicateCandidates"])
            .iter()
            .any(|candidate| candidate["exact"] == true)
        {
            return Err(err(
                "duplicate_question",
                "此题已存在于本机题库；请继续使用已有题目，不能重复发布。原卷条目及审核记录仍保留。",
            ));
        }
        let id = s(q, "questionId");
        let modern = new_knowledge_annotation(q);
        let (annotation, complete) = if modern {
            knowledge_annotation(q, &config, &catalogue)?
        } else {
            (Value::Null, false)
        };
        let confirmed = if modern {
            complete && (!s(&q["task"], "id").is_empty() || !s(&q["task"], "label").is_empty())
        } else {
            q["mappingConfirmed"] == true
        };
        let scope = if modern {
            ids(&annotation["primarySections"])
        } else {
            ids(&q["sectionIds"])
        };
        let required = ids(&q["requiredSectionIds"]);
        let required_premises = ids(&q["requiredPremises"]);
        if confirmed
            && !modern
            && (scope
                .iter()
                .chain(required.iter())
                .any(|id| !sections.contains(id))
                || required_premises.iter().any(|id| !premises.contains(id)))
        {
            return Err(err(
                "invalid_mapping",
                "请选择现有教材小节和已登记前提，不能使用模型猜测的目录身份。",
            ));
        }
        let parts = rows(&q["parts"]);
        let student_parts: Vec<Value> = parts
            .iter()
            .map(|p| {
                let mut part = json!({"partId":p["partId"],"prompt":p["prompt"]});
                for key in ["label", "parentPartId"] {
                    if let Some(value) = p.get(key) {
                        part[key] = value.clone();
                    }
                }
                part
            })
            .collect();
        let student = json!({"stem":q["stem"],"options":q["options"],"parts":student_parts,"assets":q.get("student").and_then(|v|v.get("assets")).cloned().unwrap_or(json!([]))});
        let mut answers = vec![];
        let mut solutions = vec![];
        for (field, out) in [("answer", &mut answers), ("solution", &mut solutions)] {
            if !s(q, field).is_empty() {
                out.push(json!({"partId":null,"text":q[field],"provenance":if agent_review.is_some(){"user_authorized_agent_review"}else if model_approved {"model_review"}else{"teacher_review"}}))
            }
            for p in &parts {
                if !s(p, field).is_empty() {
                    out.push(
                        json!({"partId":p["partId"],"text":p[field],"provenance":if agent_review.is_some(){"user_authorized_agent_review"}else if model_approved {"model_review"}else{"teacher_review"}}),
                    )
                }
            }
        }
        let teacher = json!({"answers":answers,"solutions":solutions,"assets":q.get("teacher").and_then(|v|v.get("assets")).cloned().unwrap_or(json!([])),"scoringSuggestions":[],"missingReferenceAnswer":answers.is_empty(),"missingReferenceSolution":solutions.is_empty()});
        let content_hash = hash_json(&student);
        let teacher_hash = hash_json(&teacher);
        let content_version = format!("content-{}", &content_hash[..16]);
        let teacher_version = format!("teacher-{}", &teacher_hash[..16]);
        let mut task_ids = vec![];
        let mut paths = if modern {
            rows(&annotation["solutionPaths"])
        } else {
            vec![]
        };
        if confirmed {
            if !modern
                && (scope.is_empty() || required.is_empty() || s(q, "allowedSolution").is_empty())
            {
                return Err(err(
                    "mapping_required",
                    "启用自动选题前需确认主考范围、完整解法及全部依赖小节。",
                ));
            }
            let task_id = if !s(&q["task"], "id").is_empty() {
                let existing = rows(&config["tasks"])
                    .into_iter()
                    .find(|t| t["id"] == q["task"]["id"])
                    .ok_or_else(|| err("invalid_mapping", "考查任务不存在。"))?;
                if existing["questionType"] != q["questionType"]
                    || ids(&existing["sectionIds"]) != scope
                    || ids(&existing["partIds"])
                        != parts
                            .iter()
                            .map(|p| s(p, "partId").to_owned())
                            .collect::<Vec<_>>()
                {
                    return Err(err(
                        "invalid_mapping",
                        "现有考查任务与题型、小问或主考范围不一致。",
                    ));
                }
                s(&q["task"], "id").to_owned()
            } else {
                if s(&q["task"], "label").is_empty() {
                    return Err(err("mapping_required", "请填写具体考查任务。"));
                }
                let task_id = format!("task-{id}");
                tasks.push(json!({"id":task_id,"label":q["task"]["label"],"questionType":q["questionType"],"sectionIds":scope,"partIds":parts.iter().map(|p|p["partId"].clone()).collect::<Vec<_>>(),"partWeights":parts.iter().map(|_|1).collect::<Vec<_>>()}));
                task_id
            };
            task_ids.push(task_id);
            if !modern {
                paths.push(json!({"id":format!("path-{id}"),"requiredSections":required,"requiredPremises":required_premises,"allowedSolution":q["allowedSolution"],"basis":q["reviewBasis"],"verifiedBy":"local_teacher","reviewMethod":"teacher_review"}));
            }
        }
        if confirmed || modern {
            for (position, section) in scope.iter().enumerate() {
                section_mappings
                    .push(json!({"questionId":id,"sectionId":section,"position":position}))
            }
        }
        // Knowledge identity matching is independent of the teacher-confirmed
        // solution/scope contract. Content review above still gates publication.
        let primary = ids(&annotation["primaryKnowledgeUids"]);
        let mut mapped = vec![];
        if modern {
            for uid in &primary {
                mapped.push((uid.clone(), "primary", None));
            }
            for path in &paths {
                for uid in ids(&path["requiredKnowledgeUids"]) {
                    if !primary.contains(&uid) {
                        mapped.push((uid, "supporting", Some(s(path, "id").to_owned())));
                    }
                }
            }
        } else {
            // Historic generic mappings remain generic. Do not relabel them
            // as evidence of a primary assessment target or complete path.
            for uid in ids(&q["knowledgeUids"]) {
                mapped.push((uid, "related", None));
            }
        }
        for (i, (uid, role, path_id)) in mapped.iter().enumerate() {
            let topic = if modern {
                rows(&catalogue["knowledgePoints"])
                    .into_iter()
                    .find(|point| point["uid"] == *uid)
                    .map(|point| point["name"].clone())
                    .unwrap_or(json!(""))
            } else {
                rows(&q["knowledgeTopics"])
                    .get(i)
                    .cloned()
                    .unwrap_or(json!(""))
            };
            let (status, origin) = if s(q, "knowledgeMappingSource") == "teacher_edit" {
                ("teacher_assigned", "教师编辑所选知识点，按自动关联规则生效")
            } else {
                ("model_mapped", "导入模型基于题目内容自动关联知识点")
            };
            let basis = format!("{}：{}（{}）。", origin, topic.as_str().unwrap_or(""), uid);
            knowledge_mappings.push(json!({"questionId":id,"knowledgeUid":uid,"topic":topic,"status":status,"basis":basis,"role":role,"solutionPathId":path_id}));
        }
        questions.push(json!({"schemaVersion":1,"questionId":id,"questionType":q["questionType"],"student":student,"teacher":teacher,"sourceRefs":[{"sourceId":source_id,"pages":q["pages"],"label":q["sourceLabel"],"locator":q["sourceLabel"]}],"contentSha256":content_hash,"teacherSha256":teacher_hash,"contentVersion":content_version,"teacherVersion":teacher_version,"verification":{"result":"pass","method":"teacher_review","checkedBy":"local_teacher","checkedAt":record["updatedAt"],"basis":q["reviewBasis"],"contentVersion":content_version,"teacherVersion":teacher_version,"origin":{"sourceTitle":record["filename"],"sourceQuestionNumber":q["sourceLabel"]}}}));
        if model_approved {
            let published = questions.last_mut().unwrap();
            published["verification"]["method"] = json!("model_review");
            published["verification"]["checkedBy"] = q["modelReview"]["model"]["profileId"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(|s| json!(s))
                .unwrap_or(json!("configured_model"));
            published["verification"]["basis"] = q["modelReview"]["summary"].clone();
            published["verification"]["modelReview"] = q["modelReview"].clone();
            published["verification"]["userConfirmedPublication"] = json!(true);
        }
        if let Some(review) = agent_review {
            let published = questions.last_mut().unwrap();
            published["verification"]["method"] = json!("user_authorized_agent_review");
            published["verification"]["checkedBy"] = json!("codex");
            published["verification"]["agentReview"] = json!({"reportSha256":hash_json(review),"question":q["agentReview"],"authorization":review["authorization"]});
        }
        if paddle::uses(q) {
            questions.last_mut().unwrap()["assetPayloads"] = q["assetPayloads"].clone();
            questions.last_mut().unwrap()["sourceIdentity"] = q["sourceIdentity"].clone();
        }
        if structured::is_structured(q) {
            let published = questions.last_mut().unwrap();
            for field in ["sourceIdentity", "legacyReferences", "assetPayloads"] {
                published[field] = q[field].clone();
            }
            published["verification"]["origin"]["sourceQuestionId"] =
                q["sourceIdentity"]["questionId"].clone();
            published["verification"]["origin"]["sourceContentVersionId"] =
                q["sourceIdentity"]["contentVersionId"].clone();
            published["verification"]["origin"]["sourceExamId"] =
                q["sourceIdentity"]["examId"].clone();
        }
        let mut entry = json!({"questionId":id,"contentVersion":content_version,"teacherVersion":teacher_version,"tasks":task_ids,"primarySections":if confirmed || modern {scope}else{vec![]},"solutionPaths":paths,"duplicateGroup":format!("content-{content_hash}"),"notes":if modern {if complete {"题面已审核；模型知识点与解法标注"} else {"题面已审核；知识点或完整解法依据不足，自动适配未知"}} else if confirmed {"教师确认适配及完整解法依赖"}else{"题面已审核；自动组卷适配尚未确认"}});
        if modern {
            entry["knowledgeSchemaVersion"] = json!(2);
            entry["primaryKnowledgeUids"] = annotation["primaryKnowledgeUids"].clone();
        }
        if model_approved {
            entry["notes"] = json!(if modern && complete {
                "导入检查未发现疑点，用户确认入库；知识点与难度仍为内容估计"
            } else {
                "导入检查未发现疑点，用户确认入库；完整解法不足，自动适配未知"
            });
        }
        if agent_review.is_some() {
            entry["notes"] = json!(if modern && complete {
                "代理逐题对照原卷核验通过；知识点与难度仍为模型内容估计"
            } else {
                "代理逐题对照原卷核验通过；知识点或完整解法不足，自动适配未知"
            });
        }
        // Publication revalidates even historic records which have not passed
        // through the current review editor, and binds the estimate to these
        // exact student and teacher versions alongside the other annotations.
        let mut assessed = q.clone();
        assessed["difficultyAssessment"] = annotations::normalize_difficulty(q)?;
        annotations::apply_difficulty(&mut entry, &assessed);
        teaching::verify_audit(store,q)?;
        teaching::apply_to_entry(q,questions.last().unwrap(),&mut entry,s(record,"importId"))?;
        entries.push(entry);
    }
    if questions.is_empty() {
        return Err(err(
            "review_required",
            "请先完成导入检查或人工核对至少一道未入库题目。",
        ));
    }
    let mut manifest = json!({"teacherConfirmed":agent_review.is_none(),"questions":questions,"configPatch":{"tasks":tasks,"sources":[{"sourceId":source_id,"path":record["source"]["relativePath"],"filename":record["filename"],"title":record["filename"],"sha256":record["source"]["sha256"],"physicalPages":record["source"]["physicalPages"]}],"assemblyIndex":{"entries":entries}},"sectionMappings":section_mappings,"knowledgeMappings":knowledge_mappings});
    if rows(&manifest["questions"])
        .iter()
        .any(|q| q["verification"]["method"] == "model_review")
    {
        manifest["teacherConfirmed"] = json!(false);
        manifest["userConfirmedPublication"] = json!(true);
    }
    if let Some(review) = agent_review {
        manifest["agentReview"] = review.clone();
    }
    Ok(manifest)
}
fn publish(store: &Store, payload: &Value, cancel: &AtomicBool) -> AppResult<Value> {
    let op = operation(payload)?;
    let hash = hash_json(payload);
    let mut record = store.document("imports", s(payload, "importId"))?;
    if matches!(s(&record["backgroundJob"], "status"), "queued" | "running") {
        return Err(err(
            "import_running",
            "此试卷正在后台处理，完成或停止后再加入题库。",
        ));
    }
    if replay(&record, op, &hash)? {
        let receipt = rows(&record["publicationHistory"])
            .into_iter()
            .find(|r| r["publicationId"] == op)
            .unwrap_or(Value::Null);
        return Ok(
            json!({"reviewEligibility":review::eligibility(&record),"import":record,"publication":receipt}),
        );
    }
    revision(&record, payload)?;
    if record["pendingTeachingPublication"].is_object() { return Err(err("publication_pending","请先完成待确认的解析更新。")); }
    if payload["acknowledgeReview"] != true {
        return Err(err("review_required", "请显式确认发布已审核题目。"));
    }
    cancelled(cancel)?;
    read_source(store, &record)?;
    paddle::verify_audit(store, &record)?;
    verify_recovered_source_for_publication(store, &record)?;
    // Pending publication retries must still retain their bound source audit;
    // a frozen manifest is not permission to ignore damaged review evidence.
    for question in rows(&record["questions"])
        .iter()
        .filter(|q| review::model_ready(q, &record))
    {
        review::verify_opinion(store, question, &record)?;
    }
    let manifest = if record["pendingPublication"].is_object() {
        if record["pendingPublication"]["operationId"] != op
            || record["pendingPublication"]["payloadHash"] != hash
        {
            return Err(err("publication_pending", "请使用原操作重试完成上次发布。"));
        }
        record["pendingPublication"]["manifest"].clone()
    } else {
        let manifest = build_manifest(store, &record)?;
        let saved = record.clone();
        record["pendingPublication"] =
            json!({"operationId":op,"payloadHash":hash,"manifest":manifest,"payload":payload});
        save_cas(store, Some(&saved), &record)?;
        manifest
    };
    // Source-only frozen manifests retain the same material gate as new
    // publications; a previous bank-write failure is not an exemption.
    for entry in rows(&manifest["questions"]) {
        let question = rows(&record["questions"]).into_iter().find(|q|q["questionId"] == entry["questionId"])
            .ok_or_else(||err("source_content_unresolved", "冻结发布清单的原题身份已失效。"))?;
        teaching::verify_source_material(&question)?;
    }
    // Revalidate the actual classroom request/response even when reusing a
    // frozen manifest after a failed bank write. Freezing is not permission to
    // publish a draft whose supporting files disappeared or were modified.
    for entry in rows(&manifest["configPatch"]["assemblyIndex"]["entries"]) {
        if entry["teachingAnalysis"].is_object() {
            let question=rows(&record["questions"]).into_iter().find(|q|q["questionId"]==entry["questionId"])
                .ok_or_else(||err("teaching_audit_changed","冻结发布清单的教学稿题目身份已失效。"))?;
            if !teaching::ready(&question) {
                return Err(err("teaching_audit_changed","冻结发布清单的教学稿已失效，未加入题库。"));
            }
            teaching::verify_audit(store,&question)?;
        }
    }
    cancelled(cancel)?;
    let saved = record.clone();
    let receipt = match if manifest["userConfirmedPublication"] == true {
        store.bank.publish_model_review_import(op, &manifest)
    } else {
        store.bank.publish_import(op, &manifest)
    } {
        Ok(receipt) => receipt,
        Err(error) => {
            if error.code != "storage_error" {
                record["pendingPublication"] = Value::Null;
                record["error"] = serde_json::to_value(&error)?;
                save_cas(store, Some(&saved), &record)?;
            }
            return Err(error);
        }
    };
    let mut published = ids(&record["publishedQuestionIds"]);
    for id in ids(&receipt["questionIds"]) {
        if !published.contains(&id) {
            published.push(id)
        }
    }
    record["publishedQuestionIds"] = json!(published);
    let all = rows(&record["questions"]).iter().all(|q| {
        published.iter().any(|id| id == s(q, "questionId")) || s(q, "reviewDecision") == "reject"
    });
    record["status"] = json!(if all {
        "published"
    } else {
        "partially_published"
    });
    record["pendingPublication"] = Value::Null;
    record["error"] = Value::Null;
    let mut history = rows(&record["publicationHistory"]);
    history.push(receipt.clone());
    record["publicationHistory"] = json!(history);
    finish(&mut record, op, &hash, "publish");
    save_cas(store, Some(&saved), &record)?;
    Ok(
        json!({"reviewEligibility":review::eligibility(&record),"import":record,"publication":receipt}),
    )
}
/// Explicit offline repair of exact failed teaching drafts; not a UI read or
/// ordinary whole-paper import retry, and excluded from release builds.
#[cfg(debug_assertions)]
pub fn retry_failed_teaching(store: &Store, model: &ModelClient, payload: &Value, cancel: &AtomicBool) -> AppResult<Value> {
    teaching::retry_failed(store, model, payload, cancel)
}
#[cfg(debug_assertions)]
pub fn review_saved_teaching_candidates(model: &ModelClient, manifest: &Value, output: &Path, cancel: &AtomicBool) -> AppResult<Value> {
    teaching::explicit_review_candidates(model, manifest, output, cancel)
}
pub(crate) fn teaching_review_model_context(context:&Value)->Value {teaching::model_context(context)}
#[cfg(debug_assertions)]
pub fn acknowledge_teaching_by_agent(store:&Store,payload:&Value,cancel:&AtomicBool)->AppResult<Value>{
    teaching::controls::agent_action(store,payload,false,cancel)
}
#[cfg(debug_assertions)]
pub fn patch_teaching_by_agent(store:&Store,payload:&Value,cancel:&AtomicBool)->AppResult<Value>{
    teaching::controls::agent_action(store,payload,true,cancel)
}

pub fn dispatch(
    store: &mut Store,
    model: &ModelClient,
    action: &str,
    payload: &Value,
    cancel: &AtomicBool,
) -> AppResult<Option<Value>> {
    views::validate_scope(store, payload)?;
    if let Some(result) = background::dispatch(store, model, action, payload)? {
        return Ok(Some(views::finish(store,result,payload)?));
    }
    if let Some(result) = structured::dispatch(store, model, action, payload, cancel)? {
        return Ok(Some(views::finish(store,result,payload)?));
    }
    let result = match action {
        "imports_list" => listing::list(store, payload)?,
        "import_source_page" => source_compare::read(store, payload)?,
        "import_summary_get" => return Ok(Some(views::read(store, payload, false)?)),
        "import_question_get" => return Ok(Some(views::read(store, payload, true)?)),
        "import_get" => {
            let persisted = store.document_json("imports", s(payload, "importId"))?;
            let record: Value = serde_json::from_str(&persisted)?;
            json!({"detailVersion":sha(persisted.as_bytes()),"diagnostic":diagnostics::for_record(store,&record),"reviewRequirements":review_requirement_map(&record),"reviewEligibility":review::eligibility(&record),"import":record})
        }
        "import_teaching_quality_review" => teaching::record_quality_review(store,payload,cancel)?,
        "import_teaching_controls" => {
            let record=store.document("imports",s(payload,"importId"))?;
            json!({"teachingControls":teaching::controls::projection(&record)})
        }
        "import_teaching_acknowledge" => teaching::controls::action(store,payload,false,cancel)?,
        "import_teaching_patch" => teaching::controls::action(store,payload,true,cancel)?,
        "import_teaching_publish" => teaching_actions::publish(store,payload,cancel)?,
        "import_prepare" => prepare(store, model, payload, cancel)?,
        #[cfg(all(debug_assertions, feature = "dev-tools"))]
        "import_source_asset_binding_review" => source_batches::save_asset_binding_review(store,payload)?,
        #[cfg(all(debug_assertions, feature = "dev-tools"))]
        "import_source_asset_binding_preflight" => source_batches::asset_binding_preflight(store,payload)?,
        #[cfg(all(debug_assertions, feature = "dev-tools"))]
        "import_source_material_review" => source_batches::save_material_review(store,payload)?,
        #[cfg(debug_assertions)]
        "import_source_trial_seed" => source_trial::seed(store,payload)?,
        #[cfg(debug_assertions)]
        "import_source_trial_baseline_plan" => source_trial::run(store,model,payload,cancel,false)?,
        #[cfg(debug_assertions)]
        "import_source_trial_layout" => source_trial::run(store,model,payload,cancel,true)?,
        #[cfg(debug_assertions)]
        "import_whole_transcription_trial" => source_trial::run_whole(store,model,payload,cancel)?,
        #[cfg(debug_assertions)]
        "import_ocr_trial_prepare" => source_trial::prepare_ocr(store,model,payload,cancel)?,
        #[cfg(debug_assertions)]
        "import_index_batch_trial" => index_batch_runner::run(store,model,payload,cancel)?,
        #[cfg(debug_assertions)]
        "import_index_batch_retry_failed" => index_batch_retry::run(store,model,payload,cancel)?,
        #[cfg(debug_assertions)]
        "import_ocr_existing_job_trial" => source_trial::resume_existing_ocr(store,model,payload,cancel)?,
        "import_review_save" => {
            cancelled(cancel)?;
            review_save(store, payload)?
        }
        "import_question_review_save" => {
            cancelled(cancel)?;
            review_save_with_scope(store, payload, true)?
        }
        "import_publish" => publish(store, payload, cancel)?,
        _ => return Ok(None),
    };
    Ok(Some(views::finish(store,result,payload)?))
}
fn with_teaching_controls(store:&Store,mut result:Value)->Value{
    if result["import"].is_object(){
        if !result["detailVersion"].is_string() {
            result["detailVersion"]=json!(sha(result["import"].to_string().as_bytes()));
        }
        result["teachingControls"]=teaching::controls::projection(&result["import"]);
        result["teachingActions"]=teaching_actions::projection(store,&result["import"]);
        result["sourceCorrectionDisplays"]=source_display::projection(store,&result["import"]);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn audit_path_existing_targets_are_canonical_and_missing_targets_fail() {
        let runtime = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let directory = runtime.path().join("imports/docx-render-simulated");
        std::fs::create_dir_all(&directory).unwrap();
        let output = directory.join("document.pdf");
        std::fs::write(&output, b"simulated preserved PDF path only").unwrap();
        let expected = "imports/docx-render-simulated/document.pdf";
        assert_eq!(audit_relative_path_in(runtime.path(), &output).unwrap(), expected);
        assert_eq!(audit_relative_path_in(runtime.path(), &output.canonicalize().unwrap()).unwrap(), expected);
        assert_eq!(audit_relative_path_in(runtime.path(), &directory).unwrap(), "imports/docx-render-simulated");
        let missing = directory.join("missing.pdf");
        assert_eq!(audit_relative_path_in(runtime.path(), &missing).unwrap_err().code, "invalid_source");
        let escaped = outside.path().join("outside.pdf");
        std::fs::write(&escaped, b"simulated outside runtime").unwrap();
        assert_eq!(audit_relative_path_in(runtime.path(), &escaped).unwrap_err().code, "invalid_source");
        assert_eq!(planned_audit_relative_path_in(runtime.path(), &escaped).unwrap_err().code, "invalid_source");
    }

    #[test]
    fn audit_path_planned_entry_requires_a_real_owned_parent_and_one_bounded_name() {
        let runtime = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let parent = runtime.path().join("imports/source-batches");
        std::fs::create_dir_all(&parent).unwrap();
        let planned = parent.join("simulated-catalog.response.stream");
        assert_eq!(planned_audit_relative_path_in(runtime.path(), &planned).unwrap(), "imports/source-batches/simulated-catalog.response.stream");
        assert!(!planned.exists());
        std::fs::create_dir(&planned).unwrap();
        assert_eq!(planned_audit_relative_path_in(runtime.path(), &planned).unwrap(), audit_relative_path_in(runtime.path(), &planned).unwrap());
        for invalid in [
            parent.join("missing-parent/future.stream"), outside.path().join("future.stream"),
            parent.join("../future.stream"), parent.join("stream:alternate"),
            parent.join("trailing."), parent.join("trailing "), parent.join("x".repeat(256)),
        ] {
            assert_eq!(planned_audit_relative_path_in(runtime.path(), &invalid).unwrap_err().code, "invalid_source", "{}", invalid.display());
        }
    }

    #[cfg(windows)]
    #[test]
    fn audit_path_windows_office_plain_path_matches_verbatim_canonical_path() {
        let runtime = tempfile::tempdir().unwrap();
        let output = runtime.path().join("imports/docx-render-模拟 case/document.pdf");
        std::fs::create_dir_all(output.parent().unwrap()).unwrap();
        std::fs::write(&output, b"simulated Office output path").unwrap();
        // This is an actual ordinary Windows path, like the Office converter's
        // return value, compared with the actual canonical verbatim root.
        assert!(!output.to_string_lossy().starts_with(r"\\?\"));
        assert!(runtime.path().canonicalize().unwrap().to_string_lossy().starts_with(r"\\?\"));
        assert_eq!(audit_relative_path_in(runtime.path(), &output).unwrap(), "imports/docx-render-模拟 case/document.pdf");
        assert_eq!(audit_relative_path_in(runtime.path(), &output.canonicalize().unwrap()).unwrap(), "imports/docx-render-模拟 case/document.pdf");
    }

    #[cfg(windows)]
    #[test]
    fn audit_path_windows_junction_escape_is_rejected_for_existing_and_planned_targets() {
        use std::os::windows::process::CommandExt;
        let runtime = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let parent = runtime.path().join("imports");
        std::fs::create_dir(&parent).unwrap();
        std::fs::write(outside.path().join("existing.json"), b"simulated outside evidence").unwrap();
        let junction = parent.join("escaped-junction");
        let result = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&junction).arg(outside.path()).creation_flags(0x08000000).output().unwrap();
        assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
        for target in [&junction, &junction.join("existing.json"), &junction.join("future.stream")] {
            assert_eq!(audit_relative_path_in(runtime.path(), target).unwrap_err().code, "invalid_source");
            assert_eq!(planned_audit_relative_path_in(runtime.path(), target).unwrap_err().code, "invalid_source");
        }
        // Remove only this test's junction, leaving its external target intact.
        std::fs::remove_dir(&junction).unwrap();
        assert!(outside.path().join("existing.json").is_file());
    }

    #[test]
    fn import_catalogue_excludes_old_paper_provenance_but_keeps_every_task_identity() {
        let task = json!({"id":"simulated-task","label":"模拟任务","questionType":"fill_blank","sectionIds":["simulated-section"],"provenance":{"oldQuestion":"模拟旧卷正文不得混入新原卷"},"reviewBasis":"模拟旧解析","partialAlternatives":[{"answer":"模拟旧答案"}]});
        let sent = import_task_identity(&task);
        for key in ["id", "label", "questionType", "sectionIds"] {
            assert_eq!(sent[key], task[key]);
        }
        assert!(sent.get("provenance").is_none());
        assert!(sent.get("reviewBasis").is_none());
        assert!(sent.get("partialAlternatives").is_none());
        assert!(!sent.to_string().contains("旧"));
    }

    fn store() -> (tempfile::TempDir, Store, ModelClient) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), &crate::bank::tests::seed()).unwrap();
        std::fs::write(dir.path().join("model-settings.json"), b"{}").unwrap();
        let model = ModelClient::open(dir.path()).unwrap();
        (dir, store, model)
    }
    fn question() -> Value {
        json!({"questionType":"fill_blank","sourceLabel":"模拟原题1","pages":[1],"stem":"模拟回归题：计算 $1+1=$____。","options":[],"parts":[],"answer":"","solution":"","sectionIds":[],"task":{"label":"模拟加法"},"knowledgeUids":[],"knowledgeTopics":[]})
    }
    #[test]
    fn simulated_review_only_requires_answer_and_solution_checks_for_present_content() {
        let (_dir, store, _model) = store();
        let mut record = staged(&store);
        let mut approved = approve(&record, &[0])[0].clone();
        approved["answer"] = json!("");
        approved["solution"] = json!(" \n ");
        approved["reviewChecks"]["answerChecked"] = json!(false);
        approved["reviewChecks"]["solutionChecked"] = json!(false);
        approved["reviewBasis"] = json!("模拟：已对照题干选项及公式图表。");
        assert_eq!(
            review_requirements(&approved),
            vec!["sourceMatched", "formulaChecked"]
        );
        check_approved(&approved, &record).unwrap();
        approved["parts"] = json!([{"answer":"模拟小问答案","solution":""}]);
        assert_eq!(
            check_approved(&approved, &record).unwrap_err().code,
            "review_required"
        );
        approved["reviewChecks"]["answerChecked"] = json!(true);
        check_approved(&approved, &record).unwrap();
        approved["parts"][0]["solution"] = json!("模拟原卷解法");
        assert_eq!(
            check_approved(&approved, &record).unwrap_err().code,
            "review_required"
        );
        approved["reviewChecks"]["solutionChecked"] = json!(true);
        check_approved(&approved, &record).unwrap();
        approved["parts"] = json!([]);
        approved["reviewChecks"]["sourceMatched"] = json!(false);
        assert_eq!(
            check_approved(&approved, &record).unwrap_err().code,
            "review_required"
        );
        approved["reviewChecks"]["sourceMatched"] = json!(true);
        approved["reviewChecks"]["formulaChecked"] = json!(false);
        assert_eq!(
            check_approved(&approved, &record).unwrap_err().code,
            "review_required"
        );
        approved["reviewChecks"]["formulaChecked"] = json!(true);
        approved["reviewBasis"] = json!("");
        assert_eq!(
            check_approved(&approved, &record).unwrap_err().code,
            "review_required"
        );
        approved["reviewBasis"] = json!("模拟题面审核");
        record["sourceIssues"] = json!([{"code":"source_image_unresolved","message":"模拟缺图"}]);
        assert_eq!(
            check_approved(&approved, &record).unwrap_err().code,
            "source_content_unresolved"
        );
    }
    #[test]
    fn simulated_multiple_choice_import_keeps_type_options_and_review_gate() {
        let (_dir, store, _model) = store();
        let mut input = question();
        input["questionType"] = json!("multiple_choice");
        input["stem"] = json!("模拟回归：下列哪些数大于零？");
        input["options"] =
            json!([{"label":"A","text":"1"},{"label":"B","text":"2"},{"label":"C","text":"-1"}]);
        input["answer"] = json!("AB");
        let normalized = normalize_question(&input, "simulated-multiple-import", 1).unwrap();
        assert_eq!(normalized["questionType"], "multiple_choice");
        assert_eq!(normalized["options"], input["options"]);
        assert_eq!(normalized["answer"], "AB");
        let mut record = staged(&store);
        record["questions"] = json!([normalized]);
        let approved = approve(&record, &[0])[0].clone();
        check_approved(&approved, &record).unwrap();
        let mut incomplete = approved.clone();
        incomplete["options"] = json!([{"label":"A","text":"1"}]);
        assert_eq!(
            check_approved(&incomplete, &record).unwrap_err().code,
            "invalid_import"
        );
        incomplete["options"] = json!([{"label":"A","text":"1"},{"label":"B","text":""}]);
        assert_eq!(
            check_approved(&incomplete, &record).unwrap_err().code,
            "invalid_import"
        );
        incomplete = approved;
        incomplete["reviewChecks"]["sourceMatched"] = json!(false);
        assert_eq!(
            check_approved(&incomplete, &record).unwrap_err().code,
            "review_required"
        );
        input["questionType"] = json!("fill_blank");
        assert!(normalize_question(&input, "simulated-non-choice", 1).is_err());
    }
    #[test]
    fn simulated_import_difficulty_requires_basis_without_relabeling_historic_records() {
        let (_dir, store, _model) = store();
        let legacy = normalize_question(&question(), "simulated-legacy", 1).unwrap();
        assert!(legacy["difficultyAssessment"]["level"].is_null());
        assert_eq!(legacy["difficultyAssessment"]["basis"], "");
        for level in crate::intake::DIFFICULTY_LEVELS {
            let mut input = question();
            input["difficultyAssessment"] = json!({"level":level,"basis":"模拟回归：明确指出整题完整解法中的关键转换与边界。","rubricVersion":"content-demand-v1"});
            assert_eq!(
                normalize_question(&input, "simulated", 1).unwrap()["difficultyAssessment"]["level"],
                level
            );
        }
        let mut record = staged(&store);
        // An old pending import can still be reviewed and published explicitly
        // without invoking the model or guessing a level from its chapter.
        record["questions"][0]
            .as_object_mut()
            .unwrap()
            .remove("difficultyAssessment");
        let manifest = build_manifest(&store, &record).unwrap();
        assert!(
            manifest["configPatch"]["assemblyIndex"]["entries"][0]["difficultyLevel"].is_null()
        );
        for assessment in [
            json!({"level":"medium","basis":"  ","rubricVersion":"content-demand-v1"}),
            json!({"level":"advanced","basis":"模拟具体依据","rubricVersion":"content-demand-v1"}),
            json!({"level":"medium","basis":"模拟具体依据","rubricVersion":"wrong"}),
            json!({"level":0.5,"basis":"模拟具体依据"}),
        ] {
            record["questions"][0]["difficultyAssessment"] = assessment;
            assert!(normalize_question(&record["questions"][0], "simulated", 1).is_err());
            assert!(
                build_manifest(&store, &record).is_err(),
                "publication must revalidate persisted assessments"
            );
            let before = store.list_documents("imports").unwrap();
            let payload = json!({"importId":record["importId"],"operationId":uuid::Uuid::new_v4().to_string(),"expectedRevision":record["revision"],"questions":record["questions"]});
            assert!(review_save(&store, &payload).is_err());
            assert_eq!(store.list_documents("imports").unwrap(), before);
        }
        record["questions"][0]["difficultyAssessment"] =
            json!({"level":null,"basis":"","rubricVersion":"content-demand-v1"});
        let manifest = build_manifest(&store, &record).unwrap();
        assert!(
            manifest["configPatch"]["assemblyIndex"]["entries"][0]["difficultyLevel"].is_null()
        );
        let mut invalid = question();
        invalid["sourceLabel"] = json!("13");
        invalid["pages"] = json!([2]);
        invalid["difficultyAssessment"] =
            json!({"level":"advanced","basis":"模拟错误等级","rubricVersion":"content-demand-v1"});
        let error = prepare_questions(
            &store,
            &json!({"questions":[invalid]}),
            &json!({"importId":"simulated-specific-error"}),
            2,
            None,
        )
        .unwrap_err();
        assert_eq!(error.code, "invalid_annotation");
        assert!(error.message.contains("第 13 题（第 2 页）"));
        assert!(error.message.contains("难度等级无效"));
    }
    #[cfg(windows)]
    fn server(model: &mut ModelClient, response: Value) -> std::thread::JoinHandle<String> {
        provider_server(
            model,
            json!({"choices":[{"message":{"content":response.to_string()}}]}),
        )
    }
    #[cfg(windows)]
    fn provider_server(
        model: &mut ModelClient,
        response: Value,
    ) -> std::thread::JoinHandle<String> {
        let response=teaching::simulated_complete_response(response);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        model.save(&json!({"baseUrl":format!("http://{address}/v1"),"model":"simulated-import-model","apiKey":"simulated-only-key"})).unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(15)))
                .unwrap();
            let mut request = vec![];
            let mut chunk = [0u8; 8192];
            let mut target = None;
            loop {
                let n = stream.read(&mut chunk).unwrap();
                if n == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..n]);
                if let Some(index) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..index]).to_ascii_lowercase();
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("content-length:")
                                .map(|x| x.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    target = Some(index + 4 + length)
                }
                if target.is_some_and(|n| request.len() >= n) {
                    break;
                }
            }
            let body = response.to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
            String::from_utf8(request).unwrap()
        })
    }
    fn upload(operation: &str, name: &str, bytes: &[u8]) -> Value {
        json!({"operationId":operation,"filename":name,"contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes)})
    }
    fn approve(record: &Value, which: &[usize]) -> Vec<Value> {
        let mut qs = rows(&record["questions"]);
        for i in which {
            qs[*i]["reviewDecision"] = json!("approve");
            qs[*i]["reviewBasis"] =
                json!("模拟回归：已对照原文，原卷未提供参考答案及解析，明确保留缺项。");
            qs[*i]["reviewChecks"] = json!({"sourceMatched":true,"answerChecked":true,"solutionChecked":true,"formulaChecked":true});
        }
        qs
    }
    fn docx(xml: &str, extra: Option<(&str, &[u8])>) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(vec![]));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        writer.start_file("[Content_Types].xml", options).unwrap();
        writer.write_all(b"<Types/>").unwrap();
        writer.start_file("word/document.xml", options).unwrap();
        writer.write_all(xml.as_bytes()).unwrap();
        if let Some((path, bytes)) = extra {
            writer.start_file(path, options).unwrap();
            writer.write_all(bytes).unwrap()
        }
        writer.finish().unwrap().into_inner()
    }
    fn pdf(text: Option<&str>) -> Vec<u8> {
        use lopdf::{Object, Stream, dictionary};
        let mut doc = lopdf::Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let font =
            doc.add_object(dictionary! {"Type"=>"Font","Subtype"=>"Type1","BaseFont"=>"Helvetica"});
        let resources = doc.add_object(dictionary! {"Font"=>dictionary!{"F1"=>font}});
        let content = if let Some(text) = text {
            format!("BT /F1 12 Tf 20 100 Td ({text}) Tj ET")
        } else {
            String::new()
        };
        let content = doc.add_object(Stream::new(dictionary! {}, content.into_bytes()));
        let page=doc.add_object(dictionary!{"Type"=>"Page","Parent"=>pages_id,"Contents"=>content,"Resources"=>resources,"MediaBox"=>vec![0.into(),0.into(),300.into(),300.into()]});
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {"Type"=>"Pages","Kids"=>vec![page.into()],"Count"=>1}),
        );
        let catalog = doc.add_object(dictionary! {"Type"=>"Catalog","Pages"=>pages_id});
        doc.trailer.set("Root", catalog);
        let mut bytes = vec![];
        doc.save_to(&mut bytes).unwrap();
        bytes
    }
    fn cjk_pdf(text: &str) -> Vec<u8> {
        use lopdf::{Object, Stream, dictionary};
        let mut doc = lopdf::Document::load_mem(&pdf(None)).unwrap();
        let page = *doc.get_pages().values().next().unwrap();
        let descriptor=doc.add_object(dictionary!{"Type"=>"FontDescriptor","FontName"=>"STSong-Light","Flags"=>6,"FontBBox"=>vec![(-25).into(),(-254).into(),1000.into(),880.into()],"ItalicAngle"=>0,"Ascent"=>752,"Descent"=>-271,"CapHeight"=>737,"StemV"=>58});
        let descendant=doc.add_object(dictionary!{"Type"=>"Font","Subtype"=>"CIDFontType0","BaseFont"=>"STSong-Light","CIDSystemInfo"=>dictionary!{"Registry"=>Object::string_literal("Adobe"),"Ordering"=>Object::string_literal("GB1"),"Supplement"=>4},"FontDescriptor"=>descriptor,"DW"=>1000});
        let font=doc.add_object(dictionary!{"Type"=>"Font","Subtype"=>"Type0","BaseFont"=>"STSong-Light","Encoding"=>"UniGB-UCS2-H","DescendantFonts"=>vec![descendant.into()]});
        let resources = doc.add_object(dictionary! {"Font"=>dictionary!{"F1"=>font}});
        let hex = text
            .encode_utf16()
            .map(|c| format!("{c:04X}"))
            .collect::<String>();
        let content = doc.add_object(Stream::new(
            dictionary! {},
            format!("BT /F1 12 Tf 20 100 Td <{hex}> Tj ET").into_bytes(),
        ));
        let page = doc.objects.get_mut(&page).unwrap().as_dict_mut().unwrap();
        page.set("Resources", resources);
        page.set("Contents", content);
        let mut bytes = vec![];
        doc.save_to(&mut bytes).unwrap();
        bytes
    }

    #[test]
    fn missing_model_gate_precedes_decode_and_any_import_write() {
        let (dir, mut store, model) = store();
        let result = prepare(
            &mut store,
            &model,
            &json!({"filename":"../bad","contentBase64":"not base64"}),
            &AtomicBool::new(false),
        );
        assert_eq!(result.unwrap_err().code, "not_configured");
        assert!(!dir.path().join("imports").exists());
        assert!(store.list_documents("imports").unwrap().is_empty());
    }
    #[test]
    #[cfg(windows)]
    fn simulated_ordinary_import_failures_keep_original_and_separate_provider_attempts() {
        let (dir, mut store, mut model) = store();
        // Audit transport uses text; PDF/DOCX OCR has its own integration suite.
        let bytes = "模拟回归原卷：计算1+1。".as_bytes().to_vec();
        let cancel = AtomicBool::new(false);
        let responses = [
            (
                json!({"choices":[{"finish_reason":"stop","message":{"content":"[\"not object simulated-only-key\"]"}}]}),
                "model_error",
            ),
            (
                json!({"choices":[{"finish_reason":"length","message":{"content":"{\"questions\":["}}],"usage":{"completion_tokens":16000}}),
                "model_output_truncated",
            ),
        ];
        let mut record = Value::Null;
        let mut evidence = Vec::new();
        for (index, (response, code)) in responses.into_iter().enumerate() {
            let mock = provider_server(&mut model, response);
            let payload = if index == 0 {
                upload("simulated-ordinary-failure", "模拟试卷.txt", &bytes)
            } else {
                json!({"operationId":"simulated-ordinary-truncated-retry","importId":record["importId"],"expectedRevision":record["revision"]})
            };
            record = prepare(&mut store, &model, &payload, &cancel).unwrap()["import"].clone();
            assert_eq!(record["status"], "failed");
            assert_eq!(record["error"]["code"], code);
            assert!(rows(&record["questions"]).is_empty());
            assert_eq!(
                std::fs::read(dir.path().join(s(&record["source"], "relativePath"))).unwrap(),
                bytes
            );
            assert!(mock.join().unwrap().contains("模拟回归原卷"));
            let attempts = rows(&record["modelAttempts"]);
            assert_eq!(attempts.len(), index + 1);
            let attempt = attempts.last().unwrap();
            assert_eq!(attempt["status"], "failed");
            assert_eq!(attempt["error"]["code"], code);
            for (field, hash_field) in [
                ("attemptRelativePath", "attemptSha256"),
                ("providerResponseRelativePath", "providerResponseSha256"),
            ] {
                let path = dir.path().join(s(attempt, field));
                let content = std::fs::read(&path).unwrap();
                assert_eq!(sha(&content), s(attempt, hash_field));
                assert!(!String::from_utf8_lossy(&content).contains("simulated-only-key"));
                evidence.push((path, content));
            }
            let provider: Value = serde_json::from_slice(&evidence.last().unwrap().1).unwrap();
            if index == 0 {
                assert_eq!(
                    provider["choices"][0]["message"]["content"],
                    "[\"not object [redacted]\"]"
                );
            } else {
                assert_eq!(provider["choices"][0]["finish_reason"], "length");
            }
        }
        // History and same-operation replay work while the configured endpoint
        // is unreachable: neither action creates another provider request.
        model.save(&json!({"baseUrl":"http://127.0.0.1:9/v1","model":"simulated-offline","apiKey":"simulated-only-key"})).unwrap();
        let before = record.clone();
        assert_eq!(
            dispatch(
                &mut store,
                &model,
                "import_get",
                &json!({"importId":record["importId"]}),
                &cancel
            )
            .unwrap()
            .unwrap()["import"],
            before
        );
        assert_eq!(
            dispatch(&mut store, &model, "imports_list", &json!({}), &cancel)
                .unwrap()
                .unwrap()["imports"][0]["status"],
            "failed"
        );
        let replay = json!({"operationId":"simulated-ordinary-truncated-retry","importId":record["importId"],"expectedRevision":1});
        assert_eq!(
            prepare(&mut store, &model, &replay, &cancel).unwrap()["import"],
            before
        );
        let mock = server(&mut model, json!({"questions":[question()]}));
        let retry = json!({"operationId":"simulated-ordinary-success-retry","importId":record["importId"],"expectedRevision":record["revision"]});
        record = prepare(&mut store, &model, &retry, &cancel).unwrap()["import"].clone();
        mock.join().unwrap();
        assert_eq!(record["status"], "pending_review");
        assert_eq!(rows(&record["modelAttempts"]).len(), 3);
        assert_eq!(rows(&record["questions"]).len(), 1);
        for (path, content) in evidence {
            assert_eq!(std::fs::read(path).unwrap(), content);
        }
        assert_eq!(
            store.bank.questions().unwrap().len(),
            1,
            "all model output remains pending review"
        );
    }
    #[test]
    fn ordinary_attempt_path_rejects_source_outside_import_root() {
        let (dir, store, _model) = store();
        std::fs::create_dir_all(dir.path().join("imports")).unwrap();
        std::fs::write(dir.path().join("outside.txt"), b"simulated outside").unwrap();
        let record = json!({"source":{"relativePath":"outside.txt"}});
        assert_eq!(
            prepare_attempt_path(&store, &record, "simulated")
                .unwrap_err()
                .code,
            "invalid_source"
        );
    }
    #[test]
    fn native_extractors_preserve_text_tables_and_block_unresolved_content() {
        let cancel = AtomicBool::new(false);
        assert_eq!(
            extract("txt", "模拟 UTF-8 $x^2$".as_bytes(), &cancel)
                .unwrap()
                .pages[0],
            "模拟 UTF-8 $x^2$"
        );
        assert_eq!(
            extract("txt", &[255], &cancel).unwrap_err().code,
            "invalid_encoding"
        );
        let bytes = docx(
            r#"<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>模拟题目</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>"#,
            None,
        );
        let result = extract("docx", &bytes, &cancel).unwrap();
        assert!(result.pages[0].contains("模拟题目"));
        assert!(result.pages[0].contains("<table>\n<tr><td>A<br/></td><td>B<br/></td></tr>"));
        assert!(result.issues.is_empty());
        let bytes = docx(
            r#"<w:document xmlns:w="w" xmlns:m="m"><w:body><w:p><w:r><w:t>模拟含图公式</w:t><w:drawing/></w:r><m:oMath><m:r/></m:oMath></w:p></w:body></w:document>"#,
            None,
        );
        let result = extract("docx", &bytes, &cancel).unwrap();
        assert!(
            result
                .issues
                .iter()
                .any(|x| x["code"] == "source_visual_unresolved")
        );
        assert!(
            result
                .issues
                .iter()
                .any(|x| x["code"] == "source_formula_unresolved")
        );
        assert_eq!(
            extract("pdf", &pdf(None), &cancel).unwrap_err().code,
            "ocr_required"
        );
        let result = extract("pdf", &pdf(Some("SIMULATED fixture 1 + 1 = ?")), &cancel).unwrap();
        assert!(result.pages[0].contains("SIMULATED fixture"));
    }
    #[test]
    fn docx_bomb_traversal_signatures_and_cancel_are_rejected() {
        let cancel = AtomicBool::new(false);
        let valid =
            "<w:document xmlns:w=\"w\"><w:p><w:r><w:t>simulated</w:t></w:r></w:p></w:document>";
        assert_eq!(
            extract("docx", b"not a zip", &cancel).unwrap_err().code,
            "invalid_docx"
        );
        assert_eq!(
            extract("pdf", b"not a pdf", &cancel).unwrap_err().code,
            "invalid_pdf"
        );
        let bad = docx(valid, Some(("../escape.txt", b"simulated")));
        assert_eq!(
            extract("docx", &bad, &cancel).unwrap_err().code,
            "invalid_docx"
        );
        let huge = vec![b'A'; 2 * 1024 * 1024];
        let bomb = docx(valid, Some(("word/bomb", &huge)));
        assert_eq!(
            extract("docx", &bomb, &cancel).unwrap_err().code,
            "archive_too_large"
        );
        cancel.store(true, Ordering::Relaxed);
        assert_eq!(
            extract("txt", b"simulated", &cancel).unwrap_err().code,
            "cancelled"
        );
    }
    #[test]
    #[cfg(windows)]
    fn simulated_model_pending_review_partial_publish_and_replay_are_real_persistence() {
        let (dir, mut store, mut model) = store();
        let mut first = question();
        first["difficultyAssessment"] = json!({"level":"easy_medium","basis":"模拟：常规加法还需一次表示转换，不涉及策略选择。","rubricVersion":"content-demand-v1"});
        let mut second = question();
        second["stem"] = json!("模拟第二题 $2+2=$____。");
        second["sourceLabel"] = json!("模拟原题2");
        let mock = server(&mut model, json!({"questions":[first,second]}));
        let cancel = AtomicBool::new(false);
        let payload = upload(
            "simulated-upload",
            "模拟缺答案.txt",
            "模拟回归题1 计算1+1。模拟回归题2 计算2+2。原文未附答案或解析。".as_bytes(),
        );
        let result = prepare(&mut store, &model, &payload, &cancel).unwrap();
        let record = result["import"].clone();
        assert_eq!(record["status"], "pending_review");
        assert_eq!(record["questions"][0]["reviewDecision"], "pending");
        assert_eq!(
            record["questions"][0]["difficultyAssessment"]["level"],
            "easy_medium"
        );
        assert!(record["questions"][1]["difficultyAssessment"]["level"].is_null());
        assert_eq!(
            record["questions"][0]["reviewChecks"]["answerChecked"],
            false
        );
        let request = mock.join().unwrap();
        assert!(request.contains("模拟缺答案.txt"));
        assert!(request.contains("content-demand-v1"));
        assert!(request.contains("difficultyAssessment"));
        assert!(request.contains("最简合理完整解法"));
        assert!(!request.contains("nickname"));
        assert!(
            dir.path()
                .join(s(&record["source"], "relativePath"))
                .exists()
        );
        assert_eq!(
            prepare(&mut store, &model, &payload, &cancel).unwrap()["import"],
            record
        );
        let invalid = json!({"importId":record["importId"],"operationId":"simulated-no-review","expectedRevision":record["revision"],"acknowledgeReview":true});
        assert_eq!(
            publish(&store, &invalid, &cancel).unwrap_err().code,
            "review_required"
        );
        let mut edited = approve(&record, &[0]);
        edited[0]["difficultyAssessment"] = json!({"level":"medium_hard","basis":"模拟审核编辑：需要发现隐含边界并独立检查完整性，不能仅延长运算。","rubricVersion":"content-demand-v1"});
        let save = json!({"importId":record["importId"],"operationId":"simulated-review","expectedRevision":record["revision"],"questions":edited});
        let reviewed = review_save(&store, &save).unwrap()["import"].clone();
        let publish_payload = json!({"importId":record["importId"],"operationId":"simulated-publish","expectedRevision":reviewed["revision"],"acknowledgeReview":true});
        let result = publish(&store, &publish_payload, &cancel).unwrap();
        assert_eq!(result["import"]["status"], "partially_published");
        assert_eq!(result["publication"]["addedQuestions"], 1);
        assert_eq!(
            publish(&store, &publish_payload, &cancel).unwrap()["publication"]["addedQuestions"],
            1
        );
        let ready = store
            .bank
            .question(s(&record["questions"][0], "questionId"))
            .unwrap();
        assert_eq!(ready["teacher"]["answers"], json!([]));
        assert_eq!(ready["teacher"]["missingReferenceAnswer"], true);
        let config = store.bank.config().unwrap();
        let entries = rows(&config["assemblyIndex"]["entries"]);
        let entry = entries
            .iter()
            .find(|e| e["questionId"] == ready["questionId"])
            .unwrap();
        assert_eq!(entry["solutionPaths"], json!([]));
        assert_eq!(entry["difficultyLevel"], "medium_hard");
        assert_eq!(entry["difficultyRubricVersion"], "content-demand-v1");
        assert!(
            entry["difficultyBasis"]
                .as_str()
                .unwrap()
                .contains("隐含边界")
        );
        assert_eq!(entry["contentVersion"], ready["contentVersion"]);
        assert_eq!(entry["teacherVersion"], ready["teacherVersion"]);
        assert!(entry.get("difficultyEstimate").is_none());
        let mut edit = rows(&result["import"]["questions"]);
        edit[0]["stem"] = json!("模拟篡改已发布题");
        assert_eq!(review_save(&store,&json!({"importId":record["importId"],"operationId":"simulated-mutate","expectedRevision":result["import"]["revision"],"questions":edit})).unwrap_err().code,"immutable_question");
        let reopened = Store::open(dir.path(), &crate::bank::tests::seed()).unwrap();
        assert_eq!(
            reopened.list_documents("imports").unwrap()[0]["status"],
            "partially_published"
        );
        assert!(
            reopened
                .bank
                .question(s(&record["questions"][0], "questionId"))
                .is_ok()
        );
        let reopened_config = reopened.bank.config().unwrap();
        let reopened_entry = rows(&reopened_config["assemblyIndex"]["entries"])
            .into_iter()
            .find(|e| e["questionId"] == ready["questionId"])
            .unwrap();
        assert_eq!(reopened_entry, *entry);
        assert_eq!(
            reopened.list_documents("imports").unwrap()[0]["questions"][0]["difficultyAssessment"],
            reviewed["questions"][0]["difficultyAssessment"]
        );
    }
    #[test]
    #[cfg(windows)]
    fn failure_keeps_original_and_retry_is_revision_checked() {
        let (dir, mut store, mut model) = store();
        model.save(&json!({"baseUrl":"http://127.0.0.1:9/v1","model":"simulated-unreachable","apiKey":"simulated"})).unwrap();
        let cancel = AtomicBool::new(false);
        let payload = upload("simulated-extraction-failure", "模拟损坏文本.txt", &[255]);
        let record = prepare(&mut store, &model, &payload, &cancel).unwrap()["import"].clone();
        assert_eq!(record["status"], "failed");
        assert_eq!(record["error"]["code"], "invalid_encoding");
        let original = dir.path().join(s(&record["source"], "relativePath"));
        assert_eq!(std::fs::read(&original).unwrap(), vec![255]);
        let bad = json!({"importId":record["importId"],"operationId":"simulated-stale-retry","expectedRevision":0});
        assert_eq!(
            prepare(&mut store, &model, &bad, &cancel).unwrap_err().code,
            "revision_conflict"
        );
        std::fs::write(original, b"tampered simulated bytes").unwrap();
        let retry = json!({"importId":record["importId"],"operationId":"simulated-retry","expectedRevision":record["revision"]});
        assert_eq!(
            prepare(&mut store, &model, &retry, &cancel)
                .unwrap_err()
                .code,
            "source_changed"
        );
    }
    #[test]
    fn simulated_text_extraction_preserves_diagram_semantics_for_model_review_and_only_blocks_actual_unresolved_material() {
        let cancel = AtomicBool::new(false);
        for content in ["如图所示的判断应由模型结合原文进行", "下图只是材料中的普通表述", "图中阴影面积", "直方图中小矩形表示频率"] {
            let extracted = extract("txt",content.as_bytes(),&cancel).unwrap();
            assert!(extracted.issues.is_empty(),"{content}");
            assert_eq!(extracted.pages,vec![content.to_owned()]);
        }
        for content in ["![原图](asset:missing)","<img src='external.png'>","<svg>原图</svg>","<script>untrusted</script>"] {
            assert!(!extract("md",content.as_bytes(),&cancel).unwrap().issues.is_empty(),"{content}");
        }
    }
    #[test]
    fn model_review_evidence_and_invalid_pages_cannot_approve_content() {
        let mut q = question();
        q["pages"] = json!([2]);
        assert_eq!(
            normalize_question(&q, "q", 1).unwrap_err().code,
            "invalid_import"
        );
        q["pages"] = json!([1]);
        q["reviewDecision"] = json!("approve");
        let q = normalize_question(&q, "q", 1).unwrap();
        assert_eq!(
            check_approved(&q, &json!({"sourceIssues":[]}))
                .unwrap_err()
                .code,
            "review_required"
        );
        let mut q = approve(&json!({"questions":[q]}), &[0])[0].clone();
        q["stem"] = json!("模拟含图题 ![原图](asset:missing)");
        assert_eq!(
            check_approved(&q, &json!({"sourceIssues":[]}))
                .unwrap_err()
                .code,
            "source_content_unresolved"
        );
    }
    fn staged(store: &Store) -> Value {
        let source =
            save_source(store, "simulated-staged", "txt", b"simulated original 1+1").unwrap();
        let mut q = normalize_question(&question(), "simulated-staged-q1", 1).unwrap();
        q["reviewDecision"] = json!("approve");
        q["reviewChecks"] = json!({"sourceMatched":true,"answerChecked":true,"solutionChecked":true,"formulaChecked":true});
        q["reviewBasis"] = json!("模拟回归审核，原文未附答案解析，保留缺项。");
        let mut record = json!({"importId":"simulated-staged","filename":"模拟回归.txt","revision":1,"status":"pending_review","source":source,"sourceIssues":[],"questions":[q],"publishedQuestionIds":[],"publicationHistory":[],"operations":[],"updatedAt":"2026-10-17T00:00:00Z"});
        record["source"]["physicalPages"] = json!(1);
        save_cas(store, None, &record).unwrap();
        record
    }
    fn simulated_source_audit_record(store: &Store) -> Value {
        let initial = staged(store);
        let saved = review_save(store, &json!({"importId":initial["importId"],"expectedRevision":initial["revision"],"operationId":"simulated-audit-baseline","questions":initial["questions"]})).unwrap()["import"].clone();
        let mut record = saved.clone();
        let mut second = record["questions"][0].clone();
        second["questionId"] = json!("simulated-staged-q2");
        second["sourceLabel"] = json!("模拟原题2");
        second["stem"] = json!("模拟另一题：计算 $2+2=$____。");
        second["sourceAssetBindingAudit"] = json!({"version":1,"questionId":"simulated-staged-q2","bindings":[],"futureEvidence":{"opaque":"模拟保留未知审计内容"}});
        record["questions"].as_array_mut().unwrap().push(second);
        for question in record["questions"].as_array_mut().unwrap() {
            question["reviewDecision"] = json!("pending");
            question["reviewBasis"] = json!("");
            question["reviewChecks"] = json!({"sourceMatched":false,"answerChecked":false,"solutionChecked":false,"formulaChecked":false});
            question["modelReview"] = json!({"status":"needs_review","summary":"模拟原卷核对意见，必须原样保留"});
            question["teachingWorkflow"] = json!({"sourceContentSha256":teaching::source_hash(question),"status":"ready_candidate","generationCalls":1,"reviewCalls":0,"candidateResult":{"answer":"模拟候选答案"},"finalResult":{"answer":"模拟终稿答案"}});
        }
        save_cas(store, Some(&saved), &record).unwrap();
        record
    }
    #[test]
    fn simulated_source_confirmation_preserves_other_question_asset_audit_and_ai_state() {
        for omitted_by_client in [false, true] {
            let (_dir, store, _model) = store();
            let record = simulated_source_audit_record(&store);
            let mut questions = rows(&record["questions"]);
            questions[0]["reviewDecision"] = json!("approve");
            questions[0]["reviewBasis"] = json!("模拟用户明确确认已对照原卷核对当前原题。");
            questions[0]["reviewChecks"]["sourceMatched"] = json!(true);
            questions[0]["reviewChecks"]["formulaChecked"] = json!(true);
            if omitted_by_client {
                questions[1].as_object_mut().unwrap().remove("sourceAssetBindingAudit");
            }
            let payload = json!({"importId":record["importId"],"expectedRevision":record["revision"],"operationId":"simulated-source-confirmation","questions":questions});
            let result = review_save(&store, &payload).unwrap()["import"].clone();
            assert_eq!(result["questions"][1], record["questions"][1], "confirming q1 must not normalize away q2's server audit");
            for field in ["stem", "options", "parts", "answer", "solution", "modelReview", "teachingWorkflow"] {
                assert_eq!(result["questions"][0][field], record["questions"][0][field], "{field}");
            }
            for field in ["publishedQuestionIds", "publicationHistory"] {
                assert_eq!(result[field], record[field]);
            }
            assert_eq!(result["questions"][0]["reviewChecks"]["answerChecked"], false);
            assert_eq!(result["questions"][0]["reviewChecks"]["solutionChecked"], false);
            assert_eq!(store.document("imports", s(&record, "importId")).unwrap(), result);
            assert_eq!(review_save(&store, &payload).unwrap()["import"], result, "idempotent replay must preserve audits");
        }
    }
    #[test]
    fn simulated_source_confirmation_rejects_forged_or_rewritten_asset_audits_atomically() {
        let (_dir, store, _model) = store();
        let record = simulated_source_audit_record(&store);
        let bank_before = store.bank.questions().unwrap();
        for add_new in [false, true] {
            let mut questions = rows(&record["questions"]);
            if add_new {
                questions[0]["sourceAssetBindingAudit"] = json!({"version":1,"bindings":[]});
            } else {
                questions[1]["sourceAssetBindingAudit"]["futureEvidence"]["opaque"] = json!("模拟伪造审计");
            }
            let payload = json!({"importId":record["importId"],"expectedRevision":record["revision"],"operationId":format!("simulated-forged-audit-{add_new}"),"questions":questions});
            assert_eq!(review_save(&store, &payload).unwrap_err().code, "immutable_source");
            assert_eq!(store.document("imports", s(&record, "importId")).unwrap(), record);
            assert_eq!(store.bank.questions().unwrap(), bank_before);
        }
    }
    fn knowledge_seed() -> Value {
        let mut seed = crate::bank::tests::seed();
        seed["config"]["chapters"] = json!([{"id":"simulated-section","label":"模拟回归小节"}]);
        let question = seed["questions"][0].clone();
        let raw = json!([{"question_id":question["questionId"],"payload":question.to_string(),"sha256":hash_json(&question),"content_version":question["contentVersion"],"teacher_version":question["teacherVersion"]}]);
        seed["bankSnapshot"] = json!({"schemaVersion":1,"questions":raw,
            "ledger":{"entries":[{"questionId":question["questionId"],"status":"ready"}]},
            "tables":{"question_bank_questions":raw,"knowledge_points":[
                {"knowledge_uid":"M-SIM-ADD","name":"模拟加法","parent_uid":null,"is_leaf":1},
                {"knowledge_uid":"M-SIM-COUNT","name":"模拟计数","parent_uid":null,"is_leaf":1},
                {"knowledge_uid":"M-SIM-REWRITE","name":"模拟变形","parent_uid":null,"is_leaf":1}],
                "curriculum_sections":[{"section_id":"simulated-section","chapter_id":"simulated-chapter","payload":"{\"id\":\"simulated-section\",\"title\":\"模拟小节\"}"}],
                "section_knowledge_mappings":[
                    {"section_id":"simulated-section","knowledge_uid":"M-SIM-ADD","relation":"introduces"},
                    {"section_id":"simulated-section","knowledge_uid":"M-SIM-COUNT","relation":"introduces"},
                    {"section_id":"simulated-section","knowledge_uid":"M-SIM-REWRITE","relation":"introduces"}]},
            "counts":{"ready":1,"pending":0,"questionRows":1,"sourceUnits":1}});
        for point in seed["bankSnapshot"]["tables"]["knowledge_points"]
            .as_array_mut()
            .unwrap()
        {
            let content = json!({"uid":point["knowledge_uid"],"name":point["name"],
                "parentUid":point["parent_uid"],"isLeaf":true});
            point["payload"] = json!(content.to_string());
            point["sha256"] = json!(hash_json(&content));
        }
        seed["migration"] = json!({"id":"simulated-import-knowledge-v1","baselineConfig":seed["config"],"baselineConfigSha256":hash_json(&seed["config"])});
        seed["migration"]["manifestSha256"] = json!(hash_json(&json!({
            "config":seed["config"],"questions":seed["questions"],"bankSnapshot":seed["bankSnapshot"]
        })));
        seed
    }
    fn grouped_knowledge_seed() -> Value {
        let mut seed = knowledge_seed();
        let points = seed["bankSnapshot"]["tables"]["knowledge_points"]
            .as_array_mut()
            .unwrap();
        points.push(json!({"knowledge_uid":"M-SIM-GROUP","name":"模拟知识分组","parent_uid":null,"is_leaf":0}));
        points[0]["parent_uid"] = json!("M-SIM-GROUP");
        for point in points {
            let payload = json!({"uid":point["knowledge_uid"],"name":point["name"],"parentUid":point["parent_uid"],"isLeaf":point["is_leaf"]==1});
            point["payload"] = json!(payload.to_string());
            point["sha256"] = json!(hash_json(&payload));
        }
        seed["migration"]["manifestSha256"] = json!(hash_json(
            &json!({"config":seed["config"],"questions":seed["questions"],"bankSnapshot":seed["bankSnapshot"]})
        ));
        seed
    }
    #[test]
    #[cfg(windows)]
    fn simulated_new_import_and_mapping_edits_reject_group_uids_but_old_pending_stays_readable() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path(), &grouped_knowledge_seed()).unwrap();
        std::fs::write(dir.path().join("model-settings.json"), b"{}").unwrap();
        let mut model = ModelClient::open(dir.path()).unwrap();
        let catalogue = trusted_catalog(&store).unwrap();
        let point = |uid: &str| {
            rows(&catalogue["knowledgePoints"])
                .into_iter()
                .find(|point| point["uid"] == uid)
                .unwrap()
        };
        assert_eq!(point("M-SIM-GROUP")["isLeaf"], false);
        assert_eq!(point("M-SIM-ADD")["isLeaf"], true);
        assert_eq!(point("M-SIM-ADD")["parentUid"], "M-SIM-GROUP");
        let mut proposed = question();
        proposed["knowledgeSchemaVersion"] = json!(2);
        proposed["primaryKnowledgeUids"] = json!(["M-SIM-GROUP"]);
        proposed["solutionPaths"] = json!([]);
        let mock = server(&mut model, json!({"questions":[proposed]}));
        let result = prepare(
            &mut store,
            &model,
            &upload("simulated-group-import", "模拟父组.txt", b"simulated 1+1"),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(result["import"]["status"], "failed");
        assert_eq!(result["import"]["error"]["code"], "invalid_mapping");
        let sent = mock.join().unwrap();
        let body: Value = serde_json::from_str(sent.split_once("\r\n\r\n").unwrap().1).unwrap();
        let context: Value =
            serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
        let model_point = rows(&context["trustedCatalogue"]["knowledgePoints"])
            .into_iter()
            .find(|point| point["uid"] == "M-SIM-ADD")
            .unwrap();
        assert_eq!(model_point["isLeaf"], true);
        assert_eq!(model_point["parentUid"], "M-SIM-GROUP");
        let original = staged(&store);
        let mut historic = original.clone();
        historic["questions"][0]["knowledgeSchemaVersion"] = json!(2);
        historic["questions"][0]["primaryKnowledgeUids"] = json!(["M-SIM-GROUP"]);
        historic["questions"][0]["solutionPaths"] = json!([]);
        save_cas(&store, Some(&original), &historic).unwrap();
        let saved = review_save(&store, &json!({"importId":historic["importId"],"operationId":"simulated-old-group-save","expectedRevision":historic["revision"],"questions":historic["questions"]})).unwrap()["import"].clone();
        assert_eq!(
            saved["questions"][0]["primaryKnowledgeUids"],
            json!(["M-SIM-GROUP"])
        );
        let mut edited = rows(&saved["questions"]);
        edited[0]["primaryKnowledgeUids"] = json!(["M-SIM-ADD"]);
        edited[0]["solutionPaths"] = json!([{"id":"path","requiredKnowledgeUids":["M-SIM-ADD","M-SIM-GROUP"],"requiredPremises":[],"basis":"模拟不合格分组依赖"}]);
        assert!(review_save(&store, &json!({"importId":saved["importId"],"operationId":"simulated-new-group-edit","expectedRevision":saved["revision"],"questions":edited})).is_err());
        assert_eq!(
            store.document("imports", s(&saved, "importId")).unwrap(),
            saved
        );
    }
    fn with_new_annotation(record: &mut Value) {
        record["questions"][0]["knowledgeSchemaVersion"] = json!(2);
        record["questions"][0]["primaryKnowledgeUids"] = json!(["M-SIM-ADD"]);
        record["questions"][0]["solutionPaths"] = json!([
            {"id":"count","requiredKnowledgeUids":["M-SIM-ADD","M-SIM-COUNT"],"requiredPremises":[],"basis":"模拟回归：按计数解完整题目。"},
            {"id":"rewrite","requiredKnowledgeUids":["M-SIM-ADD","M-SIM-REWRITE"],"requiredPremises":[],"basis":"模拟回归：通过等价变形解完整题目。"}
        ]);
    }
    #[test]
    fn new_import_paths_persist_independently_after_content_review_without_mapping_confirmation() {
        let dir = tempfile::tempdir().unwrap();
        let seed = knowledge_seed();
        let store = Store::open(dir.path(), &seed).unwrap();
        let model_catalogue = trusted_catalog(&store).unwrap();
        let point = rows(&model_catalogue["knowledgePoints"])
            .into_iter()
            .find(|point| point["uid"] == "M-SIM-ADD")
            .unwrap();
        assert!(
            point.get("parentUid").is_some(),
            "model must receive the true domain identity chain"
        );
        assert_eq!(point["sectionIds"], json!(["simulated-section"]));
        let original = staged(&store);
        let mut record = original.clone();
        with_new_annotation(&mut record);
        record["questions"][0]["mappingConfirmed"] = json!(false);
        save_cas(&store, Some(&original), &record).unwrap();
        let manifest = build_manifest(&store, &record).unwrap();
        let entry = &manifest["configPatch"]["assemblyIndex"]["entries"][0];
        assert_eq!(entry["primaryKnowledgeUids"], json!(["M-SIM-ADD"]));
        assert_eq!(entry["primarySections"], json!(["simulated-section"]));
        assert_eq!(
            entry["solutionPaths"][0]["requiredKnowledgeUids"],
            json!(["M-SIM-ADD", "M-SIM-COUNT"])
        );
        assert_eq!(
            entry["solutionPaths"][1]["requiredKnowledgeUids"],
            json!(["M-SIM-ADD", "M-SIM-REWRITE"])
        );
        assert!(entry["solutionPaths"][0]["verifiedBy"].is_null());
        assert_eq!(manifest["knowledgeMappings"].as_array().unwrap().len(), 3);
        assert_eq!(manifest["knowledgeMappings"][0]["role"], "primary");
        assert_eq!(manifest["knowledgeMappings"][1]["role"], "supporting");
        assert_eq!(manifest["knowledgeMappings"][1]["solutionPathId"], "count");
        let payload = json!({"importId":record["importId"],"operationId":"simulated-new-paths-publish","expectedRevision":record["revision"],"acknowledgeReview":true});
        publish(&store, &payload, &AtomicBool::new(false)).unwrap();
        drop(store);
        let reopened = Store::open(dir.path(), &seed).unwrap();
        let config = reopened.bank.config().unwrap();
        let actual = rows(&config["assemblyIndex"]["entries"])
            .into_iter()
            .find(|e| e["questionId"] == record["questions"][0]["questionId"])
            .unwrap();
        assert_eq!(&actual, entry);
        assert!(
            !reopened
                .bank
                .question_ids_for_knowledge("M-SIM-COUNT", false)
                .unwrap()
                .contains(&s(&record["questions"][0], "questionId").to_owned())
        );
    }
    #[test]
    fn explicit_empty_or_incomplete_new_annotations_never_fall_back_to_confirmed_legacy_sections() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), &knowledge_seed()).unwrap();
        let mut record = staged(&store);
        let q = &mut record["questions"][0];
        q["mappingConfirmed"] = json!(true);
        q["sectionIds"] = json!(["simulated-section"]);
        q["requiredSectionIds"] = json!(["simulated-section"]);
        q["allowedSolution"] = json!("旧章节确认不得补出新版依据");
        q["knowledgeUids"] = json!(["M-SIM-COUNT"]);
        q["primaryKnowledgeUids"] = json!([]);
        q["solutionPaths"] = json!([]);
        let manifest = build_manifest(&store, &record).unwrap();
        let entry = &manifest["configPatch"]["assemblyIndex"]["entries"][0];
        assert_eq!(entry["primaryKnowledgeUids"], json!([]));
        assert_eq!(entry["primarySections"], json!([]));
        assert_eq!(entry["tasks"], json!([]));
        assert_eq!(manifest["knowledgeMappings"], json!([]));
        with_new_annotation(&mut record);
        record["questions"][0]["solutionPaths"][0]["basis"] = json!("");
        let manifest = build_manifest(&store, &record).unwrap();
        assert_eq!(
            manifest["configPatch"]["assemblyIndex"]["entries"][0]["tasks"]
                .as_array()
                .unwrap()
                .len(),
            1,
            "a second complete path remains usable without inheriting the first path's missing evidence"
        );
        assert_eq!(
            manifest["configPatch"]["assemblyIndex"]["entries"][0]["solutionPaths"][0]["basis"],
            ""
        );
        record["questions"][0]["solutionPaths"][1]["basis"] = json!(" \n\t ");
        let manifest = build_manifest(&store, &record).unwrap();
        assert_eq!(
            manifest["configPatch"]["assemblyIndex"]["entries"][0]["tasks"],
            json!([]),
            "whitespace is not a complete solution basis"
        );
    }
    #[test]
    fn new_import_rejects_unknown_id_and_cannot_bypass_content_review() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), &knowledge_seed()).unwrap();
        let mut record = staged(&store);
        with_new_annotation(&mut record);
        record["questions"][0]["solutionPaths"][1]["requiredKnowledgeUids"] =
            json!(["M-SIM-ADD", "invented-uid"]);
        assert_eq!(
            build_manifest(&store, &record).unwrap_err().code,
            "invalid_mapping"
        );
        with_new_annotation(&mut record);
        record["questions"][0]["reviewChecks"]["sourceMatched"] = json!(false);
        assert_eq!(
            build_manifest(&store, &record).unwrap_err().code,
            "review_required"
        );
    }
    #[test]
    fn normalize_keeps_legacy_without_inventing_primary_and_rejects_malformed_new_fields() {
        for version in [json!(3), Value::Null, json!("2")] {
            let mut invalid_version = question();
            invalid_version["knowledgeSchemaVersion"] = version;
            invalid_version["mappingConfirmed"] = json!(true);
            assert!(new_knowledge_annotation(&invalid_version));
            assert!(normalize_question(&invalid_version, "simulated", 1).is_err());
        }
        let legacy = normalize_question(&question(), "simulated", 1).unwrap();
        assert!(legacy.get("primaryKnowledgeUids").is_none());
        assert!(!new_knowledge_annotation(&legacy));
        let mut q = question();
        q["primaryKnowledgeUids"] = json!([]);
        let modern = normalize_question(&q, "simulated", 1).unwrap();
        assert_eq!(modern["solutionPaths"], json!([]));
        assert!(new_knowledge_annotation(&modern));
        q["primaryKnowledgeUids"] = json!("not-an-array");
        assert!(normalize_question(&q, "simulated", 1).is_err());
        q["primaryKnowledgeUids"] = json!([]);
        q["solutionPaths"] = json!([{"id":"same","requiredKnowledgeUids":[],"basis":""},{"id":"same","requiredKnowledgeUids":[],"basis":""}]);
        assert!(normalize_question(&q, "simulated", 1).is_err());
    }
    #[test]
    fn model_knowledge_mapping_publishes_without_solution_mapping_confirmation() {
        let dir = tempfile::tempdir().unwrap();
        let seed = knowledge_seed();
        let store = Store::open(dir.path(), &seed).unwrap();
        let original = staged(&store);
        let mut record = original.clone();
        record["questions"][0]["knowledgeUids"] = json!(["M-SIM-ADD"]);
        record["questions"][0]["knowledgeTopics"] = json!(["模拟加法"]);
        assert_eq!(record["questions"][0]["mappingConfirmed"], false);
        save_cas(&store, Some(&original), &record).unwrap();
        let manifest = build_manifest(&store, &record).unwrap();
        let mapping = &manifest["knowledgeMappings"][0];
        assert_eq!(mapping["knowledgeUid"], "M-SIM-ADD");
        assert_eq!(mapping["status"], "model_mapped");
        assert!(s(mapping, "basis").contains("模型基于题目内容自动关联"));
        assert_ne!(mapping["basis"], record["questions"][0]["reviewBasis"]);
        assert_eq!(manifest["sectionMappings"], json!([]));
        let entry = &manifest["configPatch"]["assemblyIndex"]["entries"][0];
        assert_eq!(entry["primarySections"], json!([]));
        assert_eq!(entry["solutionPaths"], json!([]));
        assert_eq!(entry["tasks"], json!([]));
        let payload = json!({"importId":record["importId"],"operationId":"simulated-auto-knowledge","expectedRevision":record["revision"],"acknowledgeReview":true});
        let result = publish(&store, &payload, &AtomicBool::new(false)).unwrap();
        assert_eq!(result["publication"]["addedQuestions"], 1);
        let reopened = Store::open(dir.path(), &seed).unwrap();
        assert!(
            reopened
                .bank
                .question_ids_for_knowledge("M-SIM-ADD", false)
                .unwrap()
                .iter()
                .any(|id| id == s(&record["questions"][0], "questionId"))
        );
    }
    #[test]
    fn no_model_knowledge_match_does_not_invent_a_mapping() {
        let (_dir, store, _) = store();
        let record = staged(&store);
        assert_eq!(
            build_manifest(&store, &record).unwrap()["knowledgeMappings"],
            json!([])
        );
    }
    #[test]
    fn edited_knowledge_mapping_keeps_actual_source_without_claiming_model_match() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), &knowledge_seed()).unwrap();
        let record = staged(&store);
        let mut questions = rows(&record["questions"]);
        questions[0]["knowledgeUids"] = json!(["M-SIM-ADD"]);
        questions[0]["knowledgeTopics"] = json!(["模拟加法"]);
        questions[0]["knowledgeMappingSource"] = json!("model");
        let reviewed = review_save(
            &store,
            &json!({"importId":record["importId"],"operationId":"simulated-edit-knowledge","expectedRevision":record["revision"],"questions":questions}),
        )
        .unwrap()["import"]
            .clone();
        assert_eq!(
            reviewed["questions"][0]["knowledgeMappingSource"],
            "teacher_edit"
        );
        let manifest = build_manifest(&store, &reviewed).unwrap();
        assert_eq!(
            manifest["knowledgeMappings"][0]["status"],
            "teacher_assigned"
        );
        let basis = s(&manifest["knowledgeMappings"][0], "basis");
        assert!(basis.contains("教师编辑所选知识点"));
        assert!(!basis.contains("导入模型"));
        assert!(!basis.contains("教师确认"));
        store
            .bank
            .publish_import("simulated-teacher-assignment", &manifest)
            .unwrap();
        assert!(
            store
                .bank
                .question_ids_for_knowledge("M-SIM-ADD", false)
                .unwrap()
                .iter()
                .any(|id| id == s(&record["questions"][0], "questionId"))
        );
    }
    #[test]
    fn automatic_knowledge_mapping_cannot_bypass_content_or_solution_scope_review() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), &knowledge_seed()).unwrap();
        let mut record = staged(&store);
        record["questions"][0]["knowledgeUids"] = json!(["M-SIM-ADD"]);
        record["questions"][0]["knowledgeTopics"] = json!(["模拟加法"]);
        record["questions"][0]["reviewChecks"]["sourceMatched"] = json!(false);
        assert_eq!(
            build_manifest(&store, &record).unwrap_err().code,
            "review_required"
        );
        record["questions"][0]["reviewChecks"]["sourceMatched"] = json!(true);
        record["questions"][0]["stem"] = json!("模拟含图题 ![原图](asset:missing)");
        assert_eq!(
            build_manifest(&store, &record).unwrap_err().code,
            "source_content_unresolved"
        );
        record["questions"][0]["stem"] = question()["stem"].clone();
        record["questions"][0]["mappingConfirmed"] = json!(true);
        record["questions"][0]["sectionIds"] = json!(["simulated-section"]);
        assert_eq!(
            build_manifest(&store, &record).unwrap_err().code,
            "mapping_required"
        );
        record["questions"][0]["sectionIds"] = json!(["nonexistent-section"]);
        assert_eq!(
            build_manifest(&store, &record).unwrap_err().code,
            "invalid_mapping"
        );
    }
    #[test]
    fn two_connections_cas_rejects_stale_snapshot_and_preserves_winner() {
        let (dir, store, _) = store();
        let original = staged(&store);
        let other = Store::open(dir.path(), &crate::bank::tests::seed()).unwrap();
        let stale = other.document("imports", "simulated-staged").unwrap();
        let mut winner = original.clone();
        winner["questions"][0]["stem"] = json!("模拟教师先保存的题干");
        winner["revision"] = json!(2);
        save_cas(&store, Some(&original), &winner).unwrap();
        let mut loser = stale.clone();
        loser["questions"][0]["stem"] = json!("模拟过期窗口题干");
        loser["revision"] = json!(2);
        assert_eq!(
            save_cas(&other, Some(&stale), &loser).unwrap_err().code,
            "revision_conflict"
        );
        assert_eq!(
            other.document("imports", "simulated-staged").unwrap(),
            winner
        );
    }
    #[test]
    fn bank_commit_before_personal_receipt_recovers_without_duplicate_publication() {
        let (_dir, store, _) = store();
        let mut record = staged(&store);
        let payload = json!({"importId":record["importId"],"operationId":"simulated-crash-publish","expectedRevision":1,"acknowledgeReview":true});
        let manifest = build_manifest(&store, &record).unwrap();
        let before = record.clone();
        record["pendingPublication"] = json!({"operationId":payload["operationId"],"payloadHash":hash_json(&payload),"manifest":manifest});
        save_cas(&store, Some(&before), &record).unwrap();
        let first = store
            .bank
            .publish_import(s(&payload, "operationId"), &manifest)
            .unwrap();
        assert_eq!(first["addedQuestions"], 1);
        let recovered = publish(&store, &payload, &AtomicBool::new(false)).unwrap();
        assert_eq!(recovered["publication"]["replayed"], true);
        assert_eq!(recovered["import"]["status"], "published");
        assert_eq!(rows(&recovered["import"]["publicationHistory"]).len(), 1);
        assert_eq!(store.bank.questions().unwrap().len(), 2);
        assert_eq!(
            publish(&store, &payload, &AtomicBool::new(false)).unwrap()["import"],
            recovered["import"]
        );
    }
    #[test]
    #[cfg(windows)]
    fn simulated_frozen_publication_retry_rechecks_teaching_request_and_response_after_storage_failure() {
        for request_file in [true,false] {
            let (dir,mut store,mut model)=store();
            let provider=server(&mut model,json!({"questions":[question()]}));
            let cancel=AtomicBool::new(false);
            let record=prepare(&mut store,&model,&upload("simulated-pending-teaching-audit","模拟冻结审计.txt",b"simulated original 1+1"),&cancel).unwrap()["import"].clone();
            provider.join().unwrap();
            let reviewed=review_save(&store,&json!({"importId":record["importId"],"operationId":"simulated-pending-teaching-approve","expectedRevision":record["revision"],"questions":approve(&record,&[0])})).unwrap()["import"].clone();
            let payload=json!({"importId":reviewed["importId"],"operationId":"simulated-pending-teaching-publish","expectedRevision":reviewed["revision"],"acknowledgeReview":true});
            store.bank.annotation_connection().execute_batch("CREATE TRIGGER simulated_storage_failure BEFORE INSERT ON bank_questions BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END;").unwrap();
            assert_eq!(publish(&store,&payload,&cancel).unwrap_err().code,"storage_error");
            let pending=store.document("imports",s(&record,"importId")).unwrap();
            assert!(pending["pendingPublication"]["manifest"]["configPatch"]["assemblyIndex"]["entries"][0]["teachingAnalysis"].is_object());
            assert_eq!(store.bank.questions().unwrap().len(),1);
            store.bank.annotation_connection().execute_batch("DROP TRIGGER simulated_storage_failure;").unwrap();
            let workflow=&pending["questions"][0]["teachingWorkflow"];
            let relative=if request_file{s(workflow,"requestRelativePath")}else{s(&workflow["generationAudit"],"responseRelativePath")};
            let path=dir.path().join(relative);let original=std::fs::read(&path).unwrap();
            if request_file {std::fs::write(&path,b"{}").unwrap();}else{std::fs::remove_file(&path).unwrap();}
            assert_eq!(publish(&store,&payload,&cancel).unwrap_err().code,"teaching_audit_changed");
            assert_eq!(store.bank.questions().unwrap().len(),1);
            assert_eq!(store.document("imports",s(&record,"importId")).unwrap(),pending);
            std::fs::write(&path,original).unwrap();
            let recovered=publish(&store,&payload,&cancel).unwrap();
            assert_eq!(recovered["publication"]["addedQuestions"],1);
            assert_eq!(store.bank.questions().unwrap().len(),2);
            assert_eq!(publish(&store,&payload,&cancel).unwrap()["publication"]["replayed"],false);
        }
    }
    #[test]
    #[cfg(windows)]
    fn interrupted_initial_upload_replay_returns_preserved_record_without_model_request() {
        let (dir, mut store, mut model) = store();
        model.save(&json!({"baseUrl":"http://127.0.0.1:9/v1","model":"simulated-no-network","apiKey":"simulated"})).unwrap();
        let payload = upload(
            "simulated-interrupted",
            "模拟断电.txt",
            b"simulated preserved original",
        );
        let hash = hash_json(&payload);
        let id = format!(
            "import-{}",
            &hash_json(&json!(s(&payload, "operationId")))[..24]
        );
        let source = save_source(&store, &id, "txt", b"simulated preserved original").unwrap();
        let record = json!({"importId":id,"filename":payload["filename"],"revision":0,"status":"processing","creationHash":hash,"source":source,"operations":[],"questions":[],"error":null});
        save_cas(&store, None, &record).unwrap();
        let replayed = prepare(&mut store, &model, &payload, &AtomicBool::new(false)).unwrap();
        assert_eq!(replayed["import"], record);
        assert_eq!(store.document("imports", &id).unwrap(), record);
        assert_eq!(
            std::fs::read(dir.path().join(s(&record["source"], "relativePath"))).unwrap(),
            b"simulated preserved original"
        );
        let mut conflict = payload.clone();
        conflict["contentBase64"] =
            json!(base64::engine::general_purpose::STANDARD.encode(b"different simulated bytes"));
        assert_eq!(
            prepare(&mut store, &model, &conflict, &AtomicBool::new(false))
                .unwrap_err()
                .code,
            "operation_conflict"
        );
    }
    #[test]
    #[cfg(windows)]
    fn simulated_cjk_native_extraction_and_text_import_preserve_chinese() {
        let (dir, mut store, mut model) = store();
        let mut cases = vec![(
            "simulated-cjk-generated",
            cjk_pdf("模拟中文试卷：集合交集，1. 计算1+1。"),
        )];
        if let Ok(path) = std::env::var("TUTOR_IMPORT_CJK_FIXTURE") {
            cases.push(("simulated-cjk-ui-fixture", std::fs::read(path).unwrap()));
        }
        for (op, bytes) in cases {
            let extracted = extract("pdf", &bytes, &AtomicBool::new(false)).unwrap();
            assert!(
                extracted.pages.iter().any(|p| p.contains("集合")),
                "real Chinese text must survive decoding"
            );
            // Native decoding remains a regression reference. Actual PDF
            // uploads now use PaddleOCR, covered by paddle_tests.
            let text_bytes = extracted.pages.join("\n").into_bytes();
            let mock = server(&mut model, json!({"questions":[question()]}));
            let result = prepare(
                &mut store,
                &model,
                &upload(op, "模拟中文文本.txt", &text_bytes),
                &AtomicBool::new(false),
            )
            .unwrap();
            assert_eq!(result["import"]["status"], "pending_review", "{}", result);
            assert_eq!(
                std::fs::read(
                    dir.path()
                        .join(s(&result["import"]["source"], "relativePath"))
                )
                .unwrap(),
                text_bytes
            );
            assert!(mock.join().unwrap().contains("集合"));
        }
    }
    #[test]
    fn simple_docx_entities_are_retained_and_merged_tables_are_hard_blockers() {
        let text = docx(
            r#"<w:document xmlns:w="w"><w:p><w:r><w:t>A &amp; B &lt; C &#x2264; D</w:t></w:r></w:p></w:document>"#,
            None,
        );
        let extracted = extract("docx", &text, &AtomicBool::new(false)).unwrap();
        assert!(extracted.pages[0].contains("A & B < C ≤ D"));
        let merged = docx(
            r#"<w:document xmlns:w="w"><w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>模拟合并表格</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:document>"#,
            None,
        );
        let extracted = extract("docx", &merged, &AtomicBool::new(false)).unwrap();
        assert!(
            extracted
                .issues
                .iter()
                .any(|i| i["code"] == "source_table_unresolved")
        );
        let record = json!({"questions":[normalize_question(&question(),"simulated",1).unwrap()],"sourceIssues":extracted.issues});
        let approved = approve(&record, &[0]);
        assert_eq!(
            check_approved(&approved[0], &record).unwrap_err().code,
            "source_content_unresolved"
        );
    }
    #[test]
    #[cfg(windows)]
    fn sixty_question_limit_and_oversized_upload_preserve_existing_state() {
        let (dir, mut store, mut model) = store();
        let mock = server(&mut model, json!({"questions":vec![question();61]}));
        let result = prepare(
            &mut store,
            &model,
            &upload("simulated-61", "模拟61题.md", b"simulated teacher document"),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(result["import"]["status"], "failed");
        assert_eq!(result["import"]["error"]["code"], "invalid_import");
        assert!(rows(&result["import"]["questions"]).is_empty());
        mock.join().unwrap();
        let bytes = vec![b'A'; MAX_BYTES + 1];
        let too_big = prepare(
            &mut store,
            &model,
            &upload("simulated-large", "模拟大文件.txt", &bytes),
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert_eq!(too_big.code, "file_too_large");
        assert_eq!(store.list_documents("imports").unwrap().len(), 1);
        assert_eq!(
            std::fs::read_dir(dir.path().join("imports"))
                .unwrap()
                .count(),
            1
        );
    }
    #[test]
    #[cfg(windows)]
    fn cancelling_inflight_http_retains_original_and_can_retry_from_disk() {
        let (dir, mut store, mut model) = store();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        model.save(&json!({"baseUrl":format!("http://{}/v1",listener.local_addr().unwrap()),"model":"simulated-delayed","apiKey":"simulated"})).unwrap();
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let stop = cancel.clone();
        let mock = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut bytes = [0u8; 1024];
            let _ = stream.read(&mut bytes);
            stop.store(true, Ordering::Relaxed);
            std::thread::sleep(std::time::Duration::from_millis(200));
        });
        let result = prepare(
            &mut store,
            &model,
            &upload("simulated-cancel", "模拟取消.txt", b"simulated original"),
            &cancel,
        )
        .unwrap();
        mock.join().unwrap();
        let record = &result["import"];
        assert_eq!(record["error"]["code"], "cancelled");
        assert!(
            dir.path()
                .join(s(&record["source"], "relativePath"))
                .exists()
        );
        cancel.store(false, Ordering::Relaxed);
        let mock = server(&mut model, json!({"questions":[question()]}));
        let retry = json!({"importId":record["importId"],"operationId":"simulated-cancel-retry","expectedRevision":record["revision"]});
        let result = prepare(&mut store, &model, &retry, &cancel).unwrap();
        mock.join().unwrap();
        assert_eq!(result["import"]["status"], "pending_review");
        assert_eq!(store.list_documents("imports").unwrap().len(), 1);
    }
}
