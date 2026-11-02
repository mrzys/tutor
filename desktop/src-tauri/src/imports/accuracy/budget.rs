//! Admission estimates use the final wire body, not an arbitrary role cap.
//! UTF-8 bytes conservatively bound text tokens; image bytes are decoded and
//! charged using a documented upper bound for the actual endpoint/model.
//!
//! Verified 2026-11-02, primary provider documentation:
//! https://api-docs.deepseek.com/guides/vision/ (1024 tokens/image upper bound)
//! https://help.aliyun.com/zh/model-studio/vision (Qwen 3.7/3.8: 32x32 pixels/token,
//! default max_pixels=2621440, hard maximum=16777216, plus 2 visual delimiters).
//! MiMo and other routes have no verified image-token upper bound here. A
//! same-named model on a different endpoint never inherits these guarantees.
use crate::error::{AppError, AppResult};
use base64::Engine;
use serde_json::Value;
use std::io::Cursor;
use std::path::Path;

fn invalid(message: &str) -> AppError {
    AppError::new("accuracy_input_budget", message)
}
fn unknown() -> AppError {
    AppError::new(
        "accuracy_visual_budget_unknown",
        "当前实际服务商/型号的图像计费上界未确认，预算待确定；原图与断点保留，未发起请求。",
    )
}

#[derive(Clone, Copy)]
enum VisionRule {
    DeepSeek,
    Qwen32,
    #[cfg(test)]
    Mock,
}

fn vision_rule(base: &str, model: &str) -> Option<VisionRule> {
    let url = reqwest::Url::parse(base).ok()?;
    #[cfg(test)]
    if url.scheme() == "http"
        && matches!(
            url.host_str(),
            Some("127.0.0.1" | "localhost" | "::1" | "[::1]")
        )
        && model.starts_with("simulated")
    {
        return Some(VisionRule::Mock);
    }
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    if url.host_str() == Some("api.deepseek.com")
        && matches!(url.path(), "" | "/" | "/v1" | "/v1/")
        && model == "deepseek-flash"
    {
        return Some(VisionRule::DeepSeek);
    }
    if url.host_str() == Some("dashscope.aliyuncs.com")
        && matches!(url.path(), "/compatible-mode/v1" | "/compatible-mode/v1/")
        && matches!(
            model,
            "qwen3.8-max"
                | "qwen3.8-flash"
                | "qwen3.7-plus"
                | "qwen3.7-flash"
                | "qwen3.7-flash-2026-07-15"
        )
    {
        return Some(VisionRule::Qwen32);
    }
    None
}

pub(crate) fn supports_vision(base: &str, model: &str) -> bool {
    vision_rule(base, model).is_some()
}

fn dimensions(url: &str) -> AppResult<(u32, u32)> {
    let encoded = url
        .strip_prefix("data:image/png;base64,")
        .or_else(|| url.strip_prefix("data:image/jpeg;base64,"))
        .ok_or_else(unknown)?;
    if encoded.len() > 12 * 1024 * 1024 {
        return Err(invalid("图像超过本次请求安全边界，未发起调用。"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| invalid("图像Base64无法核对，未预留错误用量。"))?;
    let reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| invalid("图像格式无法核对。"))?;
    if !matches!(
        reader.format(),
        Some(image::ImageFormat::Png | image::ImageFormat::Jpeg)
    ) {
        return Err(invalid("图像实际格式不在本次已核实范围。"));
    }
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| invalid("图像真实尺寸无法读取，未以固定额度冒充上界。"))?;
    if width == 0 || height == 0 || width > 8192 || height > 8192 {
        return Err(invalid("图像真实尺寸超过本次边界。"));
    }
    Ok((width, height))
}

fn image_tokens(rule: VisionRule, block: &Value, body: &Value, size: (u32, u32)) -> AppResult<u64> {
    if block["image_url"]
        .get("detail")
        .is_some_and(|value| !matches!(value.as_str(), Some("auto" | "low" | "high" | "original")))
    {
        return Err(unknown());
    }
    match rule {
        VisionRule::DeepSeek => Ok(1024),
        #[cfg(test)]
        VisionRule::Mock => Ok(1024),
        VisionRule::Qwen32 => {
            if size.0 <= 10
                || size.1 <= 10
                || u64::from(size.0.max(size.1)) > 200 * u64::from(size.0.min(size.1))
            {
                return Err(invalid("图像尺寸或宽高比超出当前百炼模型限制。"));
            }
            let high = match body.get("vl_high_resolution_images") {
                None => false,
                Some(Value::Bool(value)) => *value,
                _ => return Err(unknown()),
            };
            let maximum = if high {
                16_777_216
            } else {
                match block.get("max_pixels") {
                    None => 2_621_440,
                    Some(value) => value
                        .as_u64()
                        .filter(|value| *value > 0 && *value <= 16_777_216)
                        .ok_or_else(unknown)?,
                }
            };
            if block.get("min_pixels").is_some_and(|value| {
                value
                    .as_u64()
                    .is_none_or(|value| value == 0 || value > maximum)
            }) {
                return Err(unknown());
            }
            // Use the declared provider maximum, not smart_resize's approximate
            // token estimate or an assumption about compression/file size.
            Ok(maximum.div_ceil(32 * 32) + 2)
        }
    }
}

pub(crate) fn estimate_input(body: &Value, maximum: u64) -> AppResult<u64> {
    estimate_input_for(body, maximum, "")
}

pub(crate) fn estimate_input_for(body: &Value, maximum: u64, base: &str) -> AppResult<u64> {
    let messages = body["messages"]
        .as_array()
        .filter(|messages| !messages.is_empty())
        .ok_or_else(|| invalid("预算缺少实际消息合同。"))?;
    let rule = vision_rule(base, body["model"].as_str().unwrap_or(""));
    let mut visible = body.clone();
    let mut visuals = 0u64;
    let mut image_sizes = vec![];
    for (index, message) in messages.iter().enumerate() {
        match &message["content"] {
            Value::String(_) => {}
            Value::Array(blocks) => {
                for (block_index, block) in blocks.iter().enumerate() {
                    match block["type"].as_str() {
                        Some("text") if block["text"].is_string() => {}
                        Some("image_url") => {
                            if message["role"] != "user" {
                                return Err(invalid("图像只能出现在已核实的用户材料消息中。"));
                            }
                            let rule = rule.ok_or_else(unknown)?;
                            let url = block["image_url"]["url"].as_str().ok_or_else(unknown)?;
                            let size = dimensions(url)?;
                            visuals = visuals
                                .checked_add(image_tokens(rule, block, body, size)?)
                                .ok_or_else(|| invalid("图像预算溢出。"))?;
                            image_sizes.push(size);
                            visible["messages"][index]["content"][block_index]["image_url"]["url"] =
                                Value::String("verified-image-token-reservation".into());
                        }
                        _ => return Err(unknown()),
                    }
                }
            }
            _ => return Err(invalid("预算消息必须是文本或本次支持的图文块。")),
        }
    }
    if image_sizes.len() > 240 {
        return Err(invalid("图像数量超过本次请求边界。"));
    }
    if matches!(rule, Some(VisionRule::DeepSeek))
        && image_sizes.len() >= 15
        && image_sizes
            .iter()
            .any(|(width, height)| *width > 4096 || *height > 4096)
    {
        return Err(invalid(
            "DeepSeek多图请求的原图超过实际接口尺寸上限；需缩小真实材料批次，未自动缩图。",
        ));
    }
    let bytes = serde_json::to_vec(&visible)?.len() as u64;
    // Count the entire non-image JSON, which includes more bytes than the
    // model-visible text. Additional framing covers role/vision separators.
    let reserve = bytes
        .checked_add(1024)
        .and_then(|value| value.checked_add(messages.len() as u64 * 64))
        .and_then(|value| value.checked_add(visuals))
        .ok_or_else(|| invalid("输入预算溢出。"))?;
    if reserve > maximum {
        return Err(invalid(
            "实际文本、消息框架和图像的保守输入预留超出本阶段上限，请显式调整计划；内容与原图未截断。",
        ));
    }
    Ok(reserve.max(1))
}

fn storage_error(message: &str) -> AppError {
    AppError::new("accuracy_storage_budget", message)
}

fn ordinary_metadata(path: &Path) -> AppResult<std::fs::Metadata> {
    let metadata = std::fs::symlink_metadata(path)?;
    let mut reparse = metadata.file_type().is_symlink();
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        reparse |= metadata.file_attributes() & 0x400 != 0;
    }
    if reparse {
        return Err(storage_error(
            "处理附件含符号链接或重解析目录，无法可靠核对归属及容量，未继续写入。",
        ));
    }
    Ok(metadata)
}

/// This preflight never removes evidence. Call it before reserving a new
/// external attempt; already-issued requests keep their original receipt.
/// The caller owns scheduling and any reservation for simultaneous writes.
pub(crate) fn check_storage(
    data_dir: &Path,
    import_id: &str,
    prospective_bytes: u64,
) -> AppResult<()> {
    check_storage_with_limits(
        data_dir,
        import_id,
        prospective_bytes,
        2 * 1024 * 1024 * 1024,
        10 * 1024 * 1024 * 1024,
    )
}

fn check_storage_with_limits(
    data_dir: &Path,
    import_id: &str,
    prospective_bytes: u64,
    import_max: u64,
    total_max: u64,
) -> AppResult<()> {
    if import_id.is_empty()
        || import_id.len() > 200
        || !import_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(storage_error(
            "处理附件的导入身份或路径无效，未扫描其它目录。",
        ));
    }
    let root = data_dir.canonicalize()?;
    let imports = root.join("imports");
    let selected = imports.join(import_id);
    let mut total = 0u64;
    let mut own = 0u64;
    let mut stack = vec![];
    if imports.exists() {
        if !ordinary_metadata(&imports)?.is_dir() || !imports.canonicalize()?.starts_with(&root) {
            return Err(storage_error("导入材料根目录不属于当前数据域。"));
        }
        stack.push(imports);
    }
    while let Some(directory) = stack.pop() {
        for entry in std::fs::read_dir(directory)? {
            let path = entry?.path();
            let metadata = ordinary_metadata(&path)?;
            let resolved = path.canonicalize()?;
            if !resolved.starts_with(&root) {
                return Err(storage_error("处理附件路径越界，未继续写入。"));
            }
            if metadata.is_dir() {
                stack.push(path);
            } else if metadata.is_file() {
                total = total
                    .checked_add(metadata.len())
                    .ok_or_else(|| storage_error("处理附件容量计数溢出，未继续写入。"))?;
                if path.starts_with(&selected) {
                    own = own
                        .checked_add(metadata.len())
                        .ok_or_else(|| storage_error("导入附件容量计数溢出，未继续写入。"))?;
                }
            } else {
                return Err(storage_error("处理附件含无法核对的特殊文件，未继续写入。"));
            }
            if total > total_max || own > import_max {
                return Err(storage_error(
                    "处理材料已达到容量上限，证据全部保留；请显式归档或清理后继续。",
                ));
            }
        }
    }
    // SQLite journals can temporarily hold the same process data as the main
    // database. Include them rather than letting WAL growth escape the limit.
    for name in [
        "personal.sqlite",
        "personal.sqlite-wal",
        "personal.sqlite-shm",
    ] {
        let path = root.join(name);
        if path.exists() {
            let metadata = ordinary_metadata(&path)?;
            if !metadata.is_file() {
                return Err(storage_error("个人过程库路径不是普通文件，未继续写入。"));
            }
            total = total
                .checked_add(metadata.len())
                .ok_or_else(|| storage_error("个人过程库容量计数溢出。"))?;
        }
    }
    if own
        .checked_add(prospective_bytes)
        .is_none_or(|size| size > import_max)
        || total
            .checked_add(prospective_bytes)
            .is_none_or(|size| size > total_max)
    {
        return Err(storage_error(
            "本次处理将超过单导入2GiB或过程域10GiB容量上限，证据未删除；请显式归档或调整范围后继续。",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn image(width: u32, height: u32) -> Value {
        let image = image::RgbaImage::from_pixel(width, height, image::Rgba([255, 255, 255, 255]));
        let mut bytes = Cursor::new(vec![]);
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        json!({"type":"image_url","image_url":{"url":format!("data:image/png;base64,{}",base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())),"detail":"original"}})
    }
    fn body(model: &str) -> Value {
        json!({"model":model,"messages":[{"role":"system","content":"核对原题。"},{"role":"user","content":[{"type":"text","text":"真实已核实题面"}]}]})
    }
    #[test]
    fn real_page_base64_is_not_counted_as_text_but_big_text_cannot_hide_behind_an_image() {
        let mut request = body("deepseek-flash");
        request["messages"][1]["content"]
            .as_array_mut()
            .unwrap()
            .push(image(1800, 2400));
        let estimate = estimate_input_for(&request, 24_000, "https://api.deepseek.com").unwrap();
        assert!(estimate > 1024 && estimate < 8000);
        request["messages"][1]["content"][0]["text"] = json!("x".repeat(25_000));
        assert_eq!(
            estimate_input_for(&request, 24_000, "https://api.deepseek.com")
                .unwrap_err()
                .code,
            "accuracy_input_budget"
        );
    }
    #[test]
    fn image_rule_requires_actual_provider_and_known_model() {
        let mut request = body("deepseek-flash");
        request["messages"][1]["content"]
            .as_array_mut()
            .unwrap()
            .push(image(32, 32));
        for base in [
            "",
            "https://unknown-provider.example/v1",
            "https://api.xiaomimimo.com/v1",
        ] {
            assert_eq!(
                estimate_input_for(&request, 64_000, base).unwrap_err().code,
                "accuracy_visual_budget_unknown"
            );
        }
        request["model"] = json!("deepseek-v4-pro");
        assert!(estimate_input_for(&request, 64_000, "https://api.deepseek.com").is_err());
    }
    #[test]
    fn qwen_defaults_and_high_resolution_have_different_documented_upper_bounds() {
        let mut request = body("qwen3.8-max");
        request["messages"][1]["content"]
            .as_array_mut()
            .unwrap()
            .push(image(32, 32));
        let default = estimate_input_for(
            &request,
            40_000,
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
        )
        .unwrap();
        request["vl_high_resolution_images"] = json!(true);
        let high = estimate_input_for(
            &request,
            40_000,
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
        )
        .unwrap();
        assert!(high - default >= 13_824);
        request["messages"][1]["content"][1]["max_pixels"] = json!(999_999_999);
        // high-resolution ignores max_pixels per the actual provider contract.
        assert!(
            estimate_input_for(
                &request,
                40_000,
                "https://dashscope.aliyuncs.com/compatible-mode/v1"
            )
            .is_ok()
        );
        request["vl_high_resolution_images"] = json!(false);
        assert!(
            estimate_input_for(
                &request,
                40_000,
                "https://dashscope.aliyuncs.com/compatible-mode/v1"
            )
            .is_err()
        );
    }
    #[test]
    fn text_without_provider_still_has_real_length_admission_and_images_never_use_url_size_guess() {
        let mut request = body("custom-model");
        assert!(estimate_input(&request, 4000).is_ok());
        request["messages"][1]["content"][0]["text"] = json!("x".repeat(4000));
        assert!(estimate_input(&request, 4000).is_err());
        request["messages"][1]["content"] =
            json!([{"type":"image_url","image_url":{"url":"https://example.com/image.png"}}]);
        assert_eq!(
            estimate_input(&request, 40_000).unwrap_err().code,
            "accuracy_visual_budget_unknown"
        );
    }

    #[test]
    fn storage_limit_counts_originals_nested_process_files_and_database_without_deleting_evidence()
    {
        let directory = tempfile::tempdir().unwrap();
        let owned = directory.path().join("imports").join("simulated-import");
        std::fs::create_dir_all(owned.join("accuracy")).unwrap();
        std::fs::write(owned.join("original.pdf"), b"original-evidence").unwrap();
        std::fs::write(
            owned.join("accuracy").join("response.json"),
            b"complete-provider-response",
        )
        .unwrap();
        std::fs::write(
            directory.path().join("personal.sqlite"),
            b"simulated-process-database",
        )
        .unwrap();
        check_storage(directory.path(), "simulated-import", 100).unwrap();
        assert_eq!(
            check_storage(directory.path(), "simulated-import", 2 * 1024 * 1024 * 1024)
                .unwrap_err()
                .code,
            "accuracy_storage_budget"
        );
        assert_eq!(
            std::fs::read(owned.join("original.pdf")).unwrap(),
            b"original-evidence"
        );
        assert!(owned.join("accuracy").join("response.json").is_file());
        assert!(check_storage(directory.path(), "../outside", 0).is_err());
    }

    #[test]
    fn storage_total_counts_other_imports_and_sqlite_journals() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(directory.path().join("imports").join("other-import")).unwrap();
        std::fs::write(
            directory.path().join("personal.sqlite-wal"),
            vec![b'x'; 800],
        )
        .unwrap();
        std::fs::write(
            directory
                .path()
                .join("imports")
                .join("other-import")
                .join("original.pdf"),
            vec![b'y'; 100],
        )
        .unwrap();
        assert_eq!(
            check_storage_with_limits(directory.path(), "new-import", 150, 500, 1000)
                .unwrap_err()
                .code,
            "accuracy_storage_budget"
        );
        assert_eq!(
            std::fs::metadata(directory.path().join("personal.sqlite-wal"))
                .unwrap()
                .len(),
            800
        );
    }
}
