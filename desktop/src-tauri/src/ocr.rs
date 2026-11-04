//! PaddleOCR asynchronous document parsing. Original pages and actual layout
//! crops are retained; OCR is evidence for review, not a correctness guarantee.
use crate::{
    error::{AppError, AppResult},
    ocr_settings::OcrSettings,
};
use base64::Engine;
use image::{DynamicImage, ImageFormat, ImageReader};
use reqwest::{Client, Url};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    io::{Cursor, Write},
    net::{IpAddr, SocketAddr, ToSocketAddrs},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

#[cfg(debug_assertions)]
mod recovery_trial;
#[cfg(debug_assertions)]
pub(crate) use recovery_trial::recover_existing;
mod resume;
pub(crate) use resume::{resume_existing, derive_layout_links, has_accepted_job};

const MAX_PAGES: usize = 50;
const MAX_JSON: usize = 24 * 1024 * 1024;
const MAX_IMAGE: usize = 25 * 1024 * 1024;
const MAX_TOTAL: usize = 120 * 1024 * 1024;
const MAX_TEXT: usize = 3 * 1024 * 1024;
const MAX_ASSETS: usize = 240;
const TIMEOUT: Duration = Duration::from_secs(300);

pub struct OcrDocument {
    pub pages: Vec<Value>,
    pub assets: Vec<Value>,
    pub issues: Vec<Value>,
}
fn error(code: &str, message: &str) -> AppError {
    AppError::new(code, message)
}
fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn check(cancel: &AtomicBool, start: Instant) -> AppResult<()> {
    if cancel.load(Ordering::SeqCst) {
        return Err(error(
            "cancelled",
            "已停止试卷识别，原文件和已有结果已保留。",
        ));
    }
    if start.elapsed() >= TIMEOUT {
        return Err(error(
            "ocr_timeout",
            "PaddleOCR 识别超过 5 分钟，原文件已保留，请稍后重试或分拆试卷。",
        ));
    }
    Ok(())
}
fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            !v.is_private()
                && !v.is_loopback()
                && !v.is_link_local()
                && !v.is_unspecified()
                && !v.is_multicast()
                && !v.is_broadcast()
                && v.octets()[0] != 0
                && v.octets()[0] < 224
                && !(v.octets()[0] == 100 && (64..=127).contains(&v.octets()[1]))
                && !(v.octets()[0] == 198 && (18..=19).contains(&v.octets()[1]))
                && !(v.octets()[0] == 192 && v.octets()[1] == 88 && v.octets()[2] == 99)
                && !(v.octets()[0] == 192 && v.octets()[1] == 0)
                && !v.is_documentation()
        }
        IpAddr::V6(v) => v
            .to_ipv4_mapped()
            .map(|v| public_ip(IpAddr::V4(v)))
            .unwrap_or(
                !v.is_loopback()
                    && !v.is_unspecified()
                    && !v.is_multicast()
                    && (v.segments()[0] & 0xfe00) != 0xfc00
                    && (v.segments()[0] & 0xffc0) != 0xfe80
                    && !v.is_unique_local()
                    && !v.is_unicast_link_local()
                    && (v.segments()[0] & 0xe000) == 0x2000
                    && v.segments()[0] != 0x2002
                    && !(v.segments()[0] == 0x2001
                        && (v.segments()[1] == 0
                            || v.segments()[1] == 2
                            || (v.segments()[1] & 0xfff0) == 0x10
                            || (v.segments()[1] & 0xfff0) == 0x20))
                    && !(v.segments()[0] == 0x2001 && v.segments()[1] == 0x0db8),
            ),
    }
}
fn loopback(url: &Url) -> bool {
    url.host_str().is_some_and(|h| {
        h == "localhost"
            || h.trim_matches(['[', ']'])
                .parse::<IpAddr>()
                .ok()
                .is_some_and(|ip| ip.is_loopback())
    })
}
fn origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}
fn validate_url(raw: &str, endpoint: &Url) -> AppResult<Url> {
    let url = Url::parse(raw).map_err(|_| {
        error(
            "ocr_invalid_url",
            "PaddleOCR 返回了无效下载地址，已停止读取。",
        )
    })?;
    let mock = cfg!(debug_assertions) && loopback(endpoint) && origin(&url, endpoint);
    if (!mock && url.scheme() != "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
        || (!mock && loopback(&url))
    {
        return Err(error(
            "ocr_unsafe_url",
            "PaddleOCR 地址必须是公开 HTTPS 地址，不允许本机、内网、重定向或地址内凭据。",
        ));
    }
    Ok(url)
}
fn official_paddle_origin(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.host_str() == Some("paddleocr.aistudio-app.com")
        && url.username().is_empty()
        && url.password().is_none()
}
fn known_paddle_fake_ip(url: &Url, endpoint: &Url, ip: IpAddr) -> bool {
    // Some local TUN resolvers assign RFC 2544 addresses to public domains.
    // This is not a general exemption for benchmarking/private networks: only
    // exact official hosts observed in original-file and student-answer trials qualify,
    // and only while using the official service. Keep the DNS pin and TLS SNI
    // hostname unchanged so an intercepted endpoint still needs a valid cert.
    if !official_paddle_origin(endpoint)
        || url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    if !matches!(
        url.host_str(),
        Some(
            "paddleocr.aistudio-app.com"
                | "pplines-online.bj.bcebos.com"
                | "paddleocr-store.bj.bcebos.com"
                | "paddleocr-store-1.bj.bcebos.com"
                | "paddleocr-store-2.bj.bcebos.com"
                | "paddleocr-store-3.bj.bcebos.com"
                | "paddleocr-store-4.bj.bcebos.com"
                | "paddleocr-store-5.bj.bcebos.com"
                | "paddleocr-store-6.bj.bcebos.com"
                | "paddleocr-store-7.bj.bcebos.com"
                | "paddleocr-store-8.bj.bcebos.com"
                | "paddleocr-store-9.bj.bcebos.com"
        )
    ) {
        return false;
    }
    matches!(ip,IpAddr::V4(v) if v.octets()[0]==198&&(18..=19).contains(&v.octets()[1]))
}
fn allowed_address(url: &Url, endpoint: &Url, ip: IpAddr) -> bool {
    let mock = cfg!(debug_assertions) && loopback(endpoint) && origin(url, endpoint);
    if mock {
        ip.is_loopback()
    } else {
        public_ip(ip) || known_paddle_fake_ip(url, endpoint, ip)
    }
}
fn safe_client(url: &Url, endpoint: &Url) -> AppResult<Client> {
    let host = url.host_str().unwrap_or("").trim_matches(['[', ']']);
    let addresses: Vec<SocketAddr> = (host, url.port_or_known_default().unwrap_or(443))
        .to_socket_addrs()
        .map_err(|_| error("ocr_network", "无法解析 PaddleOCR 地址，请检查网络后重试。"))?
        .collect();
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|a| !allowed_address(url, endpoint, a.ip()))
    {
        return Err(error(
            "ocr_unsafe_url",
            "PaddleOCR 下载地址解析到了本机或非公开网络，已阻止访问。",
        ));
    }
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(90))
        .resolve_to_addrs(host, &addresses)
        .build()
        .map_err(|_| error("ocr_network", "无法初始化 PaddleOCR 连接。"))
}
fn redact(value: &mut Value, key: &str) {
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                if [
                    "authorization",
                    "api_key",
                    "apikey",
                    "token",
                    "access_token",
                ]
                .contains(&k.to_lowercase().as_str())
                {
                    *v = json!("[redacted]")
                } else {
                    redact(v, key)
                }
            }
        }
        Value::Array(rows) => {
            for v in rows {
                redact(v, key)
            }
        }
        Value::String(text) => {
            if !key.is_empty() {
                *text = text.replace(key, "[redacted]");
            }
            let urls = regex::Regex::new(r#"https?://[^\s"<>\\]+"#).unwrap();
            *text = urls
                .replace_all(text, |c: &regex::Captures| {
                    if let Ok(mut u) = Url::parse(&c[0]) {
                        if u.query().is_some() {
                            u.set_query(Some("redacted"));
                            return u.to_string();
                        }
                    }
                    c[0].to_owned()
                })
                .into_owned();
        }
        _ => {}
    }
}
struct Run<'a> {
    endpoint: Url,
    key: &'a str,
    audit: &'a Path,
    cancel: &'a AtomicBool,
    start: Instant,
    sequence: usize,
    total: usize,
    docx: bool,
    cached_images: HashMap<String, resume::CachedImage>,
}
impl Run<'_> {
    fn network_error(
        audit: &Path,
        sequence: usize,
        phase: &str,
        part: &str,
        started: Instant,
        failure: &reqwest::Error,
    ) -> AppError {
        let kind = if failure.is_timeout() {
            "timeout"
        } else if failure.is_connect() {
            "connect"
        } else {
            "transport"
        };
        // Error Display/Debug and URLs may contain signed links or credentials.
        // Only record fixed categories and the std I/O enum, in release as well.
        let mut cause: Option<&(dyn std::error::Error + 'static)> = Some(failure);
        let mut io_kind = None;
        while let Some(current) = cause {
            if let Some(io) = current.downcast_ref::<std::io::Error>() {
                io_kind = Some(format!("{:?}", io.kind()));
                break;
            }
            cause = current.source();
        }
        let diagnostic = json!({
            "phase":phase,"part":part,"kind":kind,
            "isConnect":failure.is_connect(),"isTimeout":failure.is_timeout(),
            "isBody":failure.is_body(),"isRequest":failure.is_request(),
            "elapsedMs":started.elapsed().as_millis() as u64,
            "ioErrorKind":io_kind,"urlOrCredentialsStored":false
        });
        let path = audit.join(format!("network-{phase}-{:03}.json", sequence + 1));
        if let Ok(mut file) = std::fs::OpenOptions::new().write(true).create_new(true).open(path) {
            let _ = file.write_all(&serde_json::to_vec_pretty(&diagnostic).unwrap_or_default());
        }
        let reason = match kind {
            "timeout" => "PaddleOCR 请求超时",
            "connect" => "PaddleOCR 连接建立失败",
            _ => "PaddleOCR 数据传输中断",
        };
        let state = if phase == "submit" {
            "未取得识别任务编号，提交状态未知；"
        } else {
            ""
        };
        error("ocr_network", &format!("{reason}，{state}原文件及已有结果已保留，请检查网络后显式重试。"))
    }
    fn save(&mut self, phase: &str, status: u16, body: &[u8]) -> AppResult<()> {
        self.sequence += 1;
        let text = String::from_utf8_lossy(body);
        let mut value: Value =
            serde_json::from_str(&text).unwrap_or_else(|_| json!({"rawText":text}));
        redact(&mut value, self.key);
        let path = self
            .audit
            .join(format!("{:03}-{phase}.json", self.sequence));
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        f.write_all(&serde_json::to_vec_pretty(&json!({"httpStatus":status,"observedAt":chrono::Utc::now().to_rfc3339(),"response":value}))?)?;
        Ok(())
    }
    async fn response(
        &mut self,
        phase: &str,
        request: reqwest::RequestBuilder,
        limit: usize,
    ) -> AppResult<Vec<u8>> {
        check(self.cancel, self.start)?;
        let diagnostic_started = Instant::now();
        let audit = self.audit;
        let sequence = self.sequence;
        let result = async {
            let mut response = request.send().await.map_err(|failure|
                Self::network_error(audit, sequence, phase, "headers", diagnostic_started, &failure)
            )?;
            let status = response.status();
            let mut bytes = Vec::new();
            if response.content_length().is_some_and(|n| n > limit as u64) {
                return Err(error(
                    "ocr_response_limit",
                    "PaddleOCR 返回的数据超过安全上限，请分拆文件后重试。",
                ));
            }
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|failure| Self::network_error(audit, sequence, phase, "body", diagnostic_started, &failure))?
            {
                if bytes.len() + chunk.len() > limit {
                    return Err(error(
                        "ocr_response_limit",
                        "PaddleOCR 响应超过安全上限，已停止下载。",
                    ));
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok::<_, AppError>((status.as_u16(), bytes))
        };
        tokio::pin!(result);
        let (status, bytes) = loop {
            tokio::select! {result=&mut result=>break result?, _=tokio::time::sleep(Duration::from_millis(50))=>check(self.cancel,self.start)?}
        };
        self.total += bytes.len();
        if self.total > MAX_TOTAL {
            return Err(error(
                "ocr_response_limit",
                "PaddleOCR 本次下载总量过大，请分拆文件后重试。",
            ));
        }
        if phase != "image" {
            self.save(phase, status, &bytes)?;
        }
        if !(200..300).contains(&status) {
            if status == 429 || String::from_utf8_lossy(&bytes).contains("10010") {
                return Err(error(
                    "ocr_queue_full",
                    "PaddleOCR 任务队列已满，请稍后重试；原文件已保留。",
                ));
            }
            if matches!(status, 401 | 403) {
                return Err(error(
                    "ocr_authentication",
                    "PaddleOCR Key 无效或无权限，请在设置中检查密钥。",
                ));
            }
            if self.docx && matches!(status, 400 | 415 | 422) {
                return Err(error(
                    "ocr_unsupported_document",
                    "当前 PaddleOCR 服务未接受此 DOCX，请另存为 PDF 后导入；原件已保留。",
                ));
            }
            return Err(error(
                "ocr_http_error",
                &format!(
                    "PaddleOCR 请求失败（HTTP {status}），原文件已保留，请检查设置或稍后重试。"
                ),
            ));
        }
        Ok(bytes)
    }
    async fn json(&mut self, phase: &str, request: reqwest::RequestBuilder) -> AppResult<Value> {
        let bytes = self.response(phase, request, MAX_JSON).await?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| {
            error(
                "ocr_invalid_response",
                "PaddleOCR 返回的数据不是有效 JSON，请重试。",
            )
        })?;
        if value["code"].as_i64().is_some_and(|c| c != 0) {
            if value["code"] == 10010 {
                return Err(error(
                    "ocr_queue_full",
                    "PaddleOCR 任务队列已满，请稍后重试。",
                ));
            }
            return Err(error(
                "ocr_provider_error",
                "PaddleOCR 未能受理或完成任务，原文件及服务响应已保留，请检查设置后重试。",
            ));
        }
        Ok(value)
    }
    async fn image(&mut self, raw: &str) -> AppResult<DynamicImage> {
        let url = validate_url(raw, &self.endpoint)?;
        let key = resume::resource_key(&url);
        if let Some(cached) = self.cached_images.get(&key) {
            let image = cached.load()?;
            resume::save_image_receipt(self.audit, &key, &image, Some(&cached.path))?;
            return Ok(image);
        }
        let client = safe_client(&url, &self.endpoint)?;
        // Credentials are intentionally absent for result and image hosts.
        let bytes = self.response("image", client.get(url), MAX_IMAGE).await.map_err(|mut failure| {
            failure.message=format!("试卷识别已完成，下载原页或配图失败。{} 已下载图片保留，可继续下载。",failure.message);
            failure
        })?;
        let mut reader = ImageReader::new(Cursor::new(&bytes))
            .with_guessed_format()
            .map_err(|_| error("ocr_invalid_image", "PaddleOCR 返回的图片格式无效。"))?;
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(12000);
        limits.max_image_height = Some(12000);
        limits.max_alloc = Some(160 * 1024 * 1024);
        reader.limits(limits);
        let image = reader.decode().map_err(|_| {
            error(
                "ocr_invalid_image",
                "PaddleOCR 图片无法解码或分辨率超过上限。",
            )
        })?;
        resume::save_image_receipt(self.audit, &key, &image, None)?;
        Ok(image)
    }
}
fn asset(
    assets: &mut Vec<Value>,
    audit: &Path,
    page: usize,
    role: &str,
    bbox: Value,
    image: &DynamicImage,
    source_path: Option<&str>,
) -> AppResult<String> {
    if assets.len() >= MAX_ASSETS {
        return Err(error("ocr_asset_limit", "试卷图片过多，请分拆后导入。"));
    }
    let mut bytes = Cursor::new(Vec::new());
    image
        .write_to(&mut bytes, ImageFormat::Png)
        .map_err(|_| error("ocr_invalid_image", "无法保存 PaddleOCR 原始图片。"))?;
    let bytes = bytes.into_inner();
    if bytes.len() > MAX_IMAGE
        || assets
            .iter()
            .map(|a| s(a, "contentBase64").len())
            .sum::<usize>()
            + bytes.len().div_ceil(3) * 4
            > 128 * 1024 * 1024
    {
        return Err(error("ocr_asset_limit", "试卷图片总量过大，请分拆后导入。"));
    }
    let hash = sha(&bytes);
    let id = format!("ocr-p{page}-{role}-{}", &hash[..20]);
    if assets.iter().any(|a| s(a, "id") == id) {
        return Ok(id);
    }
    let path = audit.join(format!("{id}.png"));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    file.write_all(&bytes)?;
    assets.push(json!({"id":id,"page":page,"role":role,"bbox":bbox,"mimeType":"image/png","contentBase64":base64::engine::general_purpose::STANDARD.encode(&bytes),"sha256":hash,"width":image.width(),"height":image.height(),"sourcePath":source_path,"localEvidence":path.file_name().and_then(|v|v.to_str())}));
    Ok(id)
}
fn issue(issues: &mut Vec<Value>, code: &str, message: &str, page: usize, blocking: bool) {
    issues.push(json!({"code":code,"message":message,"page":page,"blocking":blocking}));
}
fn bbox(v: &Value) -> Option<[u32; 4]> {
    let a = v.as_array()?;
    if a.len() != 4 {
        return None;
    }
    let mut out = [0; 4];
    for (i, x) in a.iter().enumerate() {
        let n = x.as_f64()?;
        if !n.is_finite() || n < 0.0 || n > 12000.0 {
            return None;
        }
        out[i] = n.round() as u32;
    }
    if out[2] <= out[0] || out[3] <= out[1] {
        return None;
    }
    Some(out)
}
// Paddle may publish a smaller whole-page preview while keeping layout
// coordinates in the original raster. Allow only uniform scaling within the
// error introduced by rounding the preview dimensions to integer pixels.
fn page_scale(layout: [u64; 2], image: [u32; 2]) -> bool {
    let [w, h] = layout;
    let [iw, ih] = image.map(u64::from);
    if w == 0 || h == 0 || w > 12000 || h > 12000 || iw == 0 || ih == 0 {
        return false;
    }
    let delta = (w * ih).abs_diff(h * iw);
    // Less than one preview pixel in either dimension. In particular this
    // does not accept arbitrary stretching or swapped non-square dimensions.
    delta <= w.max(h)
}
fn image_bbox(b: [u32; 4], layout: [u64; 2], image: [u32; 2]) -> Option<[u32; 4]> {
    if !page_scale(layout, image)
        || b[2] as u64 > layout[0]
        || b[3] as u64 > layout[1]
        || b[0] >= b[2]
        || b[1] >= b[3]
    {
        return None;
    }
    let min = |v: u32, axis: usize| (v as u64 * image[axis] as u64 / layout[axis]) as u32;
    let max = |v: u32, axis: usize| (v as u64 * image[axis] as u64).div_ceil(layout[axis]) as u32;
    let pixels = [min(b[0], 0), min(b[1], 1), max(b[2], 0), max(b[3], 1)];
    (pixels[0] < pixels[2]
        && pixels[1] < pixels[3]
        && pixels[2] <= image[0]
        && pixels[3] <= image[1])
        .then_some(pixels)
}
async fn normalize(
    run: &mut Run<'_>,
    body: &[u8],
    expected_pages: Option<usize>,
) -> AppResult<OcrDocument> {
    let text = std::str::from_utf8(body)
        .map_err(|_| error("ocr_invalid_response", "PaddleOCR 结果编码无效。"))?;
    let mut layouts = Vec::new();
    // The service returns JSONL (one or several pages per row), sometimes as a
    // single JSON document. Parse whole JSON first so formatted JSON is valid.
    let rows = if let Ok(v) = serde_json::from_str::<Value>(text) {
        vec![v]
    } else {
        text.lines()
            .filter(|l| !l.trim().is_empty())
            .map(serde_json::from_str::<Value>)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| {
                error(
                    "ocr_invalid_jsonl",
                    "PaddleOCR 返回的 JSONL 不完整或已截断，请重试。",
                )
            })?
    };
    for row in rows {
        let found = row["result"]["layoutParsingResults"]
            .as_array()
            .ok_or_else(|| error("ocr_missing_pages", "PaddleOCR 结果缺少逐页解析数据。"))?;
        layouts.extend(found.iter().cloned());
    }
    if layouts.is_empty() || layouts.len() > MAX_PAGES {
        return Err(error(
            "ocr_page_limit",
            "PaddleOCR 未返回有效页面，或页数超过 50 页，请分拆后重试。",
        ));
    }
    let mut out = OcrDocument {
        pages: vec![],
        assets: vec![],
        issues: vec![],
    };
    if expected_pages.is_some_and(|n| n != layouts.len()) {
        issue(
            &mut out.issues,
            "ocr_missing_pages",
            "PaddleOCR 返回页数与任务报告不一致，请对照原卷检查缺页。",
            1,
            true,
        );
    }
    let mut text_len = 0;
    for (index, layout) in layouts.iter().enumerate() {
        check(run.cancel, run.start)?;
        let page = index + 1;
        let pruned = &layout["prunedResult"];
        let width = pruned["width"].as_u64();
        let height = pruned["height"].as_u64();
        let mut blocks = Vec::new();
        let mut ids = HashSet::new();
        let mut orders = HashSet::new();
        let mut omitted = Vec::new();
        if let Some(count) = pruned["page_count"].as_u64() {
            if count > 0 && count as usize != layouts.len() {
                issue(
                    &mut out.issues,
                    "ocr_page_count_conflict",
                    "PaddleOCR 原页总数与返回结果不一致。",
                    page,
                    true,
                );
            }
        }
        if pruned["page_index"]
            .as_u64()
            .is_some_and(|i| i != index as u64)
        {
            issue(
                &mut out.issues,
                "ocr_page_order_conflict",
                "服务返回的原页编号顺序不一致，未将缺页静默改号。",
                page,
                true,
            );
        }
        if let Some(list) = pruned["parsing_res_list"].as_array() {
            if list.len() > 2000 {
                return Err(error(
                    "ocr_block_limit",
                    "单页解析区域过多，请检查文件后重试。",
                ));
            }
            for (position, block) in list.iter().enumerate() {
                let id = block["block_id"].as_u64().unwrap_or(position as u64);
                if !ids.insert(id) {
                    issue(
                        &mut out.issues,
                        "ocr_duplicate_block",
                        "原页出现重复区域身份，请对照原卷检查。",
                        page,
                        true,
                    );
                }
                let order = block["block_order"].as_u64();
                let kind = s(block, "block_label");
                let content = s(block, "block_content");
                if kind != "image"
                    && kind != "chart"
                    && kind != "table"
                    && kind != "figure_title"
                    && !matches!(
                        kind,
                        "number" | "header" | "header_image" | "footer" | "footer_image" | "footnote" | "aside_text"
                    )
                    && (!content.trim().is_empty())
                    && (order.is_none() || order.is_some_and(|o| !orders.insert(o)))
                {
                    issue(
                        &mut out.issues,
                        "ocr_reading_order_uncertain",
                        "正文区域阅读顺序不明确，请对照原页核对题目和小问归属。",
                        page,
                        true,
                    );
                }
                let normalized = json!({"id":id,"order":order,"type":if kind.is_empty(){"unknown"}else{kind},"text":content,"bbox":block["block_bbox"],"groupId":block["group_id"],"confidence":block["confidence"],"responseIndex":position});
                if matches!(
                    kind,
                    "number"
                        | "footnote"
                        | "header"
                        | "header_image"
                        | "footer"
                        | "footer_image"
                        | "aside_text"
                ) {
                    omitted.push(normalized.clone());
                }
                blocks.push(normalized);
            }
        } else {
            issue(
                &mut out.issues,
                "ocr_missing_layout",
                "原页缺少布局区域，不能确认图表及题号是否完整。",
                page,
                true,
            );
        }
        let source_image = if !s(layout, "inputImage").is_empty() {
            Some(run.image(s(layout, "inputImage")).await?)
        } else {
            issue(
                &mut out.issues,
                "ocr_missing_source_image",
                "PaddleOCR 未提供原页图像，无法核对原图或生成可靠裁图。",
                page,
                true,
            );
            None
        };
        let coordinate_transform = source_image.as_ref().and_then(|image| {
            let layout = [width?, height?];
            page_scale(layout, [image.width(), image.height()]).then(|| json!({
                "kind":if layout == [image.width() as u64,image.height() as u64] {"identity"} else {"uniform_scale"},
                "layoutWidth":layout[0],"layoutHeight":layout[1],
                "imageWidth":image.width(),"imageHeight":image.height(),
                "rounding":"floor_min_ceil_max"
            }))
        });
        let source_id = if let Some(image) = source_image.as_ref() {
            if coordinate_transform.is_none() {
                issue(
                    &mut out.issues,
                    "ocr_image_dimensions",
                    "原页图像尺寸与布局坐标不一致，已停止自动裁图。",
                    page,
                    true,
                );
            }
            Some(asset(
                &mut out.assets,
                run.audit,
                page,
                "source_page",
                Value::Null,
                image,
                None,
            )?)
        } else {
            None
        };
        let mut image_refs = HashMap::<String, String>::new();
        let mut markdown = s(&layout["markdown"], "text").to_string();
        // Real layout crops, never model-estimated image coordinates. Retain
        // tables as images too, alongside editable structured table text.
        for block in &mut blocks {
            let kind = s(block, "type");
            if !matches!(kind, "image" | "chart" | "table" | "header_image" | "footer_image") {
                continue;
            }
            let role = if kind == "table" { "table" } else { "figure" };
            if let (Some(image), Some(b)) = (source_image.as_ref(), bbox(&block["bbox"])) {
                let pixels = width
                    .zip(height)
                    .and_then(|(w, h)| image_bbox(b, [w, h], [image.width(), image.height()]));
                if let Some(p) = pixels {
                    let crop = image.crop_imm(p[0], p[1], p[2] - p[0], p[3] - p[1]);
                    let id = asset(
                        &mut out.assets,
                        run.audit,
                        page,
                        role,
                        json!(b),
                        &crop,
                        None,
                    )?;
                    block["assetId"] = json!(id);
                    block["sourceImageBbox"] = json!(p);
                    if let Some(a) = out.assets.iter_mut().find(|a| s(a, "id") == id) {
                        a["layoutType"] = block["type"].clone();
                        a["sourceImageBbox"] = json!(p);
                        a["coordinateTransform"] =
                            coordinate_transform.clone().unwrap_or(Value::Null);
                    }
                } else {
                    issue(
                        &mut out.issues,
                        "ocr_invalid_crop",
                        "布局图表超出原页边界，未生成不完整裁图。",
                        page,
                        true,
                    );
                }
            } else {
                issue(
                    &mut out.issues,
                    "ocr_missing_figure",
                    "图表区域缺少真实坐标或原页图，未猜测裁剪。",
                    page,
                    true,
                );
            }
        }
        if let Some(images) = layout["markdown"]["images"].as_object() {
            if images.len() > MAX_ASSETS {
                return Err(error("ocr_asset_limit", "原页图片过多，请分拆后导入。"));
            }
            let coordinates = regex::Regex::new(r"_box_(\d+)_(\d+)_(\d+)_(\d+)\.").unwrap();
            for (path, url) in images {
                // Provider-generated image names encode their actual layout
                // coordinates. Reuse only an exact, unique layout match.
                let matches = coordinates
                    .captures(path)
                    .and_then(|c| {
                        Some([
                            c[1].parse::<u32>().ok()?,
                            c[2].parse().ok()?,
                            c[3].parse().ok()?,
                            c[4].parse().ok()?,
                        ])
                    })
                    .map(|rect| {
                        blocks
                            .iter()
                            .filter(|b| {
                                bbox(&b["bbox"]) == Some(rect) && !s(b, "assetId").is_empty()
                            })
                            .map(|b| s(b, "assetId").to_owned())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                let id = if matches.len() == 1 {
                    matches[0].clone()
                } else {
                    let Some(raw) = url.as_str() else {
                        issue(
                            &mut out.issues,
                            "ocr_missing_image",
                            "原卷图片缺少可读取地址。",
                            page,
                            true,
                        );
                        continue;
                    };
                    let img = run.image(raw).await?;
                    asset(
                        &mut out.assets,
                        run.audit,
                        page,
                        "figure",
                        Value::Null,
                        &img,
                        Some(path),
                    )?
                };
                image_refs.insert(path.clone(), id);
            }
        }
        for (path, id) in &image_refs {
            markdown = rewrite_ref(&markdown, path, id);
            for block in &mut blocks {
                let content = rewrite_ref(s(block, "text"), path, id);
                block["text"] = json!(content);
            }
        }
        let unresolved = regex::Regex::new(r"!\[[^\]]*\]\(([^)]+)\)").unwrap();
        let html_images = regex::Regex::new(r#"(?i:<img\s[^>]*src=["']([^"']+)["'])"#).unwrap();
        if html_images
            .captures_iter(&markdown)
            .any(|c| !c[1].starts_with("asset:"))
            || unresolved
                .captures_iter(&markdown)
                .any(|c| !c[1].starts_with("asset:"))
        {
            issue(
                &mut out.issues,
                "ocr_unresolved_image",
                "题面存在未保存的图片引用，请对照原卷补全。",
                page,
                true,
            );
        }
        if markdown.trim().is_empty() {
            issue(
                &mut out.issues,
                "ocr_empty_page",
                "原页没有返回识别文字，请核对是否漏识别。",
                page,
                true,
            );
        }
        text_len += markdown.len() + blocks.iter().map(|b| s(b, "text").len()).sum::<usize>();
        if text_len > MAX_TEXT {
            return Err(error("ocr_text_limit", "识别文字超过上限，请分拆后导入。"));
        }
        if omitted.iter().any(|b| {
            s(b, "type") == "number"
                && bbox(&b["bbox"]).is_some_and(|b| {
                    height.is_some_and(|h| b[1] as u64 > h / 12 && (b[3] as u64) < h * 11 / 12)
                })
        }) {
            issue(
                &mut out.issues,
                "ocr_number_blocks",
                "原页正文含单独识别的编号，已保留布局信息，请核对题号与后续正文的归属。",
                page,
                false,
            );
        }
        // Keep the exact layout identity on omitted header/footer evidence too.
        for entry in &mut omitted {
            if let Some(block) = blocks.iter().find(|b| b["id"] == entry["id"]) {*entry = block.clone();}
        }
        out.pages.push(json!({"page":page,"text":markdown,"width":width,"height":height,"blocks":blocks,"omittedBlocks":omitted,"sourceImageAssetId":source_id,"coordinateTransform":coordinate_transform,"readingOrder":"provider_response_with_explicit_optional_order"}));
    }
    Ok(out)
}
fn rewrite_ref(text: &str, path: &str, id: &str) -> String {
    text.replace(&format!("({path})"), &format!("(asset:{id})"))
        .replace(&format!("src=\"{path}\""), &format!("src=\"asset:{id}\""))
        .replace(&format!("src='{path}'"), &format!("src='asset:{id}'"))
}
async fn run(
    settings: &OcrSettings,
    bytes: &[u8],
    filename: &str,
    mime: &str,
    audit: &Path,
    cancel: &AtomicBool,
) -> AppResult<OcrDocument> {
    let endpoint = Url::parse(settings.endpoint()).map_err(|_| {
        error(
            "ocr_not_configured",
            "请先在设置中配置 PaddleOCR 接口与 Key。",
        )
    })?;
    validate_url(endpoint.as_str(), &endpoint)?;
    let mut run = Run {
        endpoint: endpoint.clone(),
        key: settings.api_key(),
        audit,
        cancel,
        start: Instant::now(),
        sequence: 0,
        total: 0,
        docx: filename.to_ascii_lowercase().ends_with(".docx"),
        cached_images: HashMap::new(),
    };
    let result=async{
        let client=safe_client(&endpoint,&endpoint)?;let form=reqwest::multipart::Form::new().text("model",settings.model().to_owned()).text("optionalPayload",json!({"useDocOrientationClassify":false,"useDocUnwarping":false,"useChartRecognition":false}).to_string()).part("file",reqwest::multipart::Part::bytes(bytes.to_vec()).file_name(filename.to_owned()).mime_str(mime).map_err(|_|error("invalid_file","试卷文件类型无效。"))?);
        let submitted=run.json("submit",client.post(endpoint.clone()).bearer_auth(settings.api_key()).multipart(form)).await?;
        let id=submitted["data"]["jobId"].as_str().map(str::to_owned).or_else(||submitted["data"]["jobId"].as_u64().map(|x|x.to_string())).filter(|x|!x.is_empty()&&x.len()<=150).ok_or_else(||error("ocr_invalid_job","PaddleOCR 未返回有效任务编号。"))?;
        resume::save_job(&run, &id)?;
        let mut poll=endpoint.clone();poll.path_segments_mut().map_err(|_|error("ocr_invalid_url","PaddleOCR 接口地址无效。"))?.pop_if_empty().push(&id);
        loop{check(cancel,run.start)?;let status=run.json("poll",client.get(poll.clone()).bearer_auth(settings.api_key())).await?;match s(&status["data"],"state"){
            "done"=>{let url=validate_url(s(&status["data"]["resultUrl"],"jsonUrl"),&endpoint)?;let result_client=safe_client(&url,&endpoint)?;let data=run.response("result",result_client.get(url),MAX_JSON).await?;return normalize(&mut run,&data,status["data"]["extractProgress"]["totalPages"].as_u64().map(|n|n as usize)).await;},
            "failed"=>return Err(error("ocr_job_failed",if run.docx{"PaddleOCR 未能处理此文件；DOCX 可另存为 PDF 后重试，原件已保留。"}else{"PaddleOCR 识别任务失败，原文件和服务响应已保留，请稍后重试。"})),
            "pending"|"running"=>{for _ in 0..50{check(cancel,run.start)?;tokio::time::sleep(Duration::from_millis(100)).await;}},
            _=>return Err(error("ocr_invalid_state","PaddleOCR 返回了未知任务状态，原文件及响应已保留。")),
        }}
    }.await;
    if let Err(err) = &result {
        let _ = run.save(
            "failure",
            0,
            &serde_json::to_vec(&json!({"code":err.code,"message":err.message}))
                .unwrap_or_default(),
        );
    }
    result
}
pub fn recognize(
    settings: &OcrSettings,
    bytes: &[u8],
    filename: &str,
    mime: &str,
    audit_dir: &Path,
    cancel: &AtomicBool,
) -> AppResult<OcrDocument> {
    if !settings.configured() {
        return Err(error(
            "ocr_not_configured",
            "请先在设置中配置 PaddleOCR 接口与 Key，再导入试卷。",
        ));
    }
    if bytes.is_empty() || bytes.len() > 15 * 1024 * 1024 {
        return Err(error("file_too_large", "试卷文件需为 1 字节至 15 MB。"));
    }
    check(cancel, Instant::now())?;
    std::fs::create_dir_all(audit_dir)?;
    resume::save_binding(settings, bytes, filename, audit_dir)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| error("ocr_runtime", "无法启动 PaddleOCR 识别。"))?;
    // IPC and the stdio driver may call from an existing runtime. A scoped
    // worker avoids nesting block_on while preserving cancellation ownership.
    std::thread::scope(|scope| {
        scope
            .spawn(|| runtime.block_on(run(settings, bytes, filename, mime, audit_dir, cancel)))
            .join()
            .unwrap_or_else(|_| {
                Err(error(
                    "ocr_failed",
                    "PaddleOCR 处理未完成，原文件已保留，请重试。",
                ))
            })
    })
}

#[cfg(test)]
mod tests {
    // Recorded-contract simulations only: no live OCR or teacher validation.
    use super::*;
    use std::{
        io::Read,
        net::TcpListener,
        sync::{Arc, Mutex},
        thread::JoinHandle,
    };
    type Requests = Arc<Mutex<Vec<(String, String, Vec<u8>)>>>;
    struct Mock {
        base: String,
        requests: Requests,
        stop: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
    }
    impl Drop for Mock {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            if let Some(h) = self.thread.take() {
                if h.join().is_err() && !std::thread::panicking() {
                    panic!("simulated OCR server failed");
                }
            }
        }
    }
    fn mock(handler: impl Fn(&str, &str) -> (u16, Vec<u8>) + Send + 'static) -> Mock {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let requests: Requests = Arc::new(Mutex::new(vec![]));
        let stop = Arc::new(AtomicBool::new(false));
        let (copy_requests, copy_stop, copy_base) = (requests.clone(), stop.clone(), base.clone());
        let thread = std::thread::spawn(move || {
            while !copy_stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        // Winsock accepted sockets inherit listener mode.
                        stream.set_nonblocking(false).unwrap();
                        stream
                            .set_read_timeout(Some(Duration::from_secs(3)))
                            .unwrap();
                        let mut bytes = Vec::new();
                        let mut buf = [0; 4096];
                        let split = loop {
                            let n = stream.read(&mut buf).unwrap();
                            if n == 0 {
                                return;
                            }
                            bytes.extend_from_slice(&buf[..n]);
                            if let Some(p) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                                break p + 4;
                            }
                        };
                        let head = String::from_utf8_lossy(&bytes[..split]).to_string();
                        let size = head
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|n| n.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        while bytes.len() < split + size {
                            let n = stream.read(&mut buf).unwrap();
                            if n == 0 {
                                break;
                            }
                            bytes.extend_from_slice(&buf[..n]);
                        }
                        let route = head
                            .lines()
                            .next()
                            .unwrap()
                            .split_whitespace()
                            .nth(1)
                            .unwrap()
                            .to_string();
                        copy_requests.lock().unwrap().push((
                            route.clone(),
                            head,
                            bytes[split..].to_vec(),
                        ));
                        let (status, body) = handler(&route, &copy_base);
                        write!(stream,"HTTP/1.1 {status} response\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).unwrap();
                        let _ = stream.write_all(&body);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5))
                    }
                    Err(e) => panic!("mock listener: {e}"),
                }
            }
        });
        Mock {
            base,
            requests,
            stop,
            thread: Some(thread),
        }
    }
    fn settings(root: &Path, base: &str) -> OcrSettings {
        let mut s = OcrSettings::open(root).unwrap();
        s.save(&json!({"expectedRevision":s.public_settings()["revision"],"baseUrl":format!("{base}/jobs"),"model":"PaddleOCR-VL-1.6","apiKey":"simulated-ocr-secret"})).unwrap();
        s
    }
    #[test]
    fn network_failures_keep_safe_diagnostics_and_unknown_submission_state() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        for mode in ["connect", "timeout", "transport"] {
            let dir = tempfile::tempdir().unwrap();
            let cancel = AtomicBool::new(false);
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/private?token=simulated-url-secret", listener.local_addr().unwrap());
            let server = if mode == "connect" {
                drop(listener);
                None
            } else {
                Some(std::thread::spawn(move || {
                    let (mut stream, _) = listener.accept().unwrap();
                    stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                    let mut request = [0; 4096];
                    let _ = stream.read(&mut request).unwrap();
                    if mode == "timeout" {
                        std::thread::sleep(Duration::from_millis(150));
                    } else {
                        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{}").unwrap();
                    }
                }))
            };
            let mut run = Run {
                endpoint: Url::parse(&url).unwrap(), key: "simulated-auth-secret",
                audit: dir.path(), cancel: &cancel, start: Instant::now(),
                sequence: 0, total: 0, docx: false, cached_images: HashMap::new(),
            };
            let phase = if mode == "transport" { "poll" } else { "submit" };
            let client = Client::builder().no_proxy().timeout(Duration::from_millis(75)).build().unwrap();
            let failure = runtime.block_on(run.response(
                phase, client.get(&url).bearer_auth(run.key), MAX_JSON,
            )).unwrap_err();
            assert_eq!(failure.code, "ocr_network");
            assert_eq!(failure.message.contains("提交状态未知"), phase == "submit");
            assert!(failure.message.contains(match mode {
                "connect" => "连接建立失败", "timeout" => "请求超时", _ => "数据传输中断",
            }));
            let bytes = std::fs::read(dir.path().join(format!("network-{phase}-001.json"))).unwrap();
            let diagnostic: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(diagnostic["kind"], mode);
            assert_eq!(diagnostic["phase"], phase);
            assert_eq!(diagnostic["part"], if mode == "transport" { "body" } else { "headers" });
            assert!(diagnostic["elapsedMs"].is_u64());
            if mode == "connect" { assert_eq!(diagnostic["ioErrorKind"], "ConnectionRefused"); }
            let saved = String::from_utf8(bytes).unwrap();
            for private in ["simulated-url-secret", "simulated-auth-secret", "127.0.0.1", "/private", "Bearer"] {
                assert!(!saved.contains(private));
                assert!(!failure.message.contains(private));
            }
            if let Some(server) = server { server.join().unwrap(); }
        }
    }
    fn png() -> Vec<u8> {
        let image = DynamicImage::new_rgb8(12, 16);
        let mut out = Cursor::new(Vec::new());
        image.write_to(&mut out, ImageFormat::Png).unwrap();
        out.into_inner()
    }
    fn layout(base: &str) -> Value {
        json!({"result":{"layoutParsingResults":[{"inputImage":format!("{base}/page.png?signature=simulated-signature"),"prunedResult":{"width":12,"height":16,"page_index":0,"parsing_res_list":[{"block_id":1,"block_order":1,"block_label":"text","block_content":"1. \\sqrt{x}+1","block_bbox":[1,1,11,3]},{"block_id":2,"block_order":null,"block_label":"image","block_content":"","block_bbox":[2,3,7,8]},{"block_id":3,"block_order":2,"block_label":"table","block_content":"<table><tr><td></td><td>3</td></tr></table>","block_bbox":[1,10,11,15]}]},"markdown":{"text":"1. \\sqrt{x}+1\n![图](imgs/x.png)\n<table><tr><td></td><td>3</td></tr></table>","images":{"imgs/x.png":format!("{base}/figure.png")}},"outputImages":{}}]}})
    }
    #[test]
    fn accepted_ocr_resume_reuses_verified_images_across_multiple_failures_without_post() {
        let succeeds=Arc::new(AtomicBool::new(false));let flag=succeeds.clone();
        let server=mock(move |route,base|match route {
            "/jobs"=>(200,serde_json::to_vec(&json!({"code":0,"data":{"jobId":"simulated-kept"}})).unwrap()),
            "/jobs/simulated-kept"=>(200,serde_json::to_vec(&json!({"code":0,"data":{"state":"done","resultUrl":{"jsonUrl":format!("{base}/result?signature=new")},"extractProgress":{"totalPages":2}}})).unwrap()),
            r if r.starts_with("/result?")=>(200,serde_json::to_vec(&json!({"result":{"layoutParsingResults":(0..2).map(|i|json!({"inputImage":format!("{base}/page{}.png?signature=new",i+1),"prunedResult":{"width":12,"height":16,"page_index":i,"parsing_res_list":[{"block_id":1,"block_order":1,"block_label":"text","block_content":format!("{}. 模拟原题",i+1),"block_bbox":[0,0,12,3]}]},"markdown":{"text":format!("{}. 模拟原题",i+1),"images":{}}})).collect::<Vec<_>>()}})).unwrap()),
            r if r.starts_with("/page2.png")&&!flag.load(Ordering::SeqCst)=>(503,b"simulated image GET failure".to_vec()),
            _=>(200,png()),
        });
        let dir=tempfile::tempdir().unwrap();let config=settings(dir.path(),&server.base);let bytes=b"%PDF-simulated";
        let first=dir.path().join("first");let cancel=AtomicBool::new(false);
        assert_eq!(recognize(&config,bytes,"sim.pdf","application/pdf",&first,&cancel).err().unwrap().code,"ocr_http_error");
        assert!(has_accepted_job(&first).unwrap());
        let before=std::fs::read(first.join("accepted-job.json")).unwrap();
        let second=dir.path().join("second");
        assert_eq!(resume_existing(&config,bytes,"sim.pdf",&first,&second,None,&cancel).err().unwrap().code,"ocr_http_error");
        assert!(has_accepted_job(&second).unwrap());
        succeeds.store(true,Ordering::SeqCst);
        let third=dir.path().join("third");let result=resume_existing(&config,bytes,"sim.pdf",&second,&third,None,&cancel).unwrap();
        assert_eq!(result.pages.len(),2);assert_eq!(result.assets.iter().filter(|a|a["role"]=="source_page").count(),2);
        assert_eq!(std::fs::read(first.join("accepted-job.json")).unwrap(),before);
        let requests=server.requests.lock().unwrap();
        assert_eq!(requests.iter().filter(|(r,_,_)|r=="/jobs").count(),1);
        assert_eq!(requests.iter().filter(|(r,_,_)|r.starts_with("/page1.png")).count(),1);
        assert_eq!(requests.iter().filter(|(r,_,_)|r.starts_with("/page2.png")).count(),3);
        assert!(requests.iter().all(|(r,h,_)|r.starts_with("/jobs")||!h.to_lowercase().contains("authorization:")));
        let audits=std::fs::read_dir(third).unwrap().filter_map(Result::ok).filter(|x|x.path().extension().is_some_and(|e|e=="json")).map(|x|std::fs::read_to_string(x.path()).unwrap()).collect::<String>();
        assert!(!audits.contains("signature=new"));assert!(!audits.contains("simulated-ocr-secret"));
    }
    #[test]
    fn footer_images_keep_exact_original_block_and_coordinates_without_becoming_student_diagrams() {
        let server=mock(|route,base|match route{
            "/jobs"=>(200,serde_json::to_vec(&json!({"code":0,"data":{"jobId":"footer"}})).unwrap()),
            "/jobs/footer"=>(200,serde_json::to_vec(&json!({"code":0,"data":{"state":"done","resultUrl":{"jsonUrl":format!("{base}/result")},"extractProgress":{"totalPages":1}}})).unwrap()),
            "/result"=>(200,serde_json::to_vec(&json!({"result":{"layoutParsingResults":[{"inputImage":format!("{base}/page"),"prunedResult":{"width":12,"height":16,"page_index":0,"parsing_res_list":[{"block_id":1,"block_label":"text","block_order":1,"block_content":"1. 模拟原题","block_bbox":[0,0,12,3]},{"block_id":2,"block_label":"footer_image","block_order":null,"block_content":"![页脚](imgs/footer_box_2_12_5_15.png)","block_bbox":[2,12,5,15]}]},"markdown":{"text":"1. 模拟原题\n![页脚](imgs/footer_box_2_12_5_15.png)","images":{"imgs/footer_box_2_12_5_15.png":format!("{base}/must-not-download")}}}]}})).unwrap()),
            "/page"=>(200,png()),_=>panic!("unexpected footer download"),
        });
        let dir=tempfile::tempdir().unwrap();let config=settings(dir.path(),&server.base);
        let result=recognize(&config,b"%PDF-simulated","footer.pdf","application/pdf",&dir.path().join("audit"),&AtomicBool::new(false)).unwrap();
        let block=&result.pages[0]["blocks"][1];let asset=result.assets.iter().find(|a|a["id"]==block["assetId"]).unwrap();
        assert_eq!(asset["bbox"],json!([2,12,5,15]));assert_eq!(asset["layoutType"],"footer_image");
        assert_eq!(asset["role"],"figure");assert_eq!(result.pages[0]["omittedBlocks"][0]["assetId"],asset["id"]);
        assert!(!result.issues.iter().any(|x|x["code"]=="ocr_reading_order_uncertain"));
    }
    #[test]
    fn multipart_poll_jsonl_retains_real_images_tables_and_unknown_order_without_forwarding_key() {
        let server = mock(|route, base| {
            match route{
            "/jobs"=>(200,serde_json::to_vec(&json!({"code":0,"data":{"jobId":"job-1"}})).unwrap()),
            "/jobs/job-1"=>(200,serde_json::to_vec(&json!({"code":0,"data":{"state":"done","resultUrl":{"jsonUrl":format!("{base}/result.jsonl?signature=simulated-signature")},"extractProgress":{"totalPages":1}}})).unwrap()),
            r if r.starts_with("/result.jsonl")=>(200,serde_json::to_vec(&layout(base)).unwrap()),
            _=>(200,png())}
        });
        let dir = tempfile::tempdir().unwrap();
        let config = settings(dir.path(), &server.base);
        let audit = dir.path().join("audit");
        let out = recognize(
            &config,
            b"%PDF-simulated",
            "simulated.pdf",
            "application/pdf",
            &audit,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(out.pages.len(), 1);
        assert_eq!(out.pages[0]["blocks"][1]["order"], Value::Null);
        assert_eq!(out.pages[0]["blocks"][1]["id"], 2);
        assert!(s(&out.pages[0], "text").contains("asset:ocr-p1-figure-"));
        assert!(s(&out.pages[0], "text").contains("<td></td>"));
        assert!(out.issues.is_empty());
        assert!(out.assets.iter().any(|a| s(a, "role") == "table"));
        for asset in &out.assets {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(s(asset, "contentBase64"))
                .unwrap();
            assert_eq!(sha(&bytes), s(asset, "sha256"));
            assert!(audit.join(s(asset, "localEvidence")).is_file());
        }
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 5);
        let multipart = String::from_utf8_lossy(&requests[0].2);
        assert!(multipart.contains("name=\"file\"; filename=\"simulated.pdf\""));
        assert!(multipart.contains("name=\"optionalPayload\""));
        assert!(multipart.contains("PaddleOCR-VL-1.6"));
        assert!(multipart.contains("%PDF-simulated"));
        for (route, head, _) in requests.iter() {
            assert_eq!(
                head.to_lowercase()
                    .contains("authorization: bearer simulated-ocr-secret"),
                route.starts_with("/jobs")
            );
        }
        let audit_text = std::fs::read_dir(&audit)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|p| p.path().extension().is_some_and(|x| x == "json"))
            .map(|p| std::fs::read_to_string(p.path()).unwrap())
            .collect::<String>();
        assert!(!audit_text.contains("simulated-ocr-secret"));
        assert!(!audit_text.contains("simulated-signature"));
    }
    #[test]
    fn failed_auth_queue_and_unsupported_docx_are_archived_with_actionable_errors() {
        for (status, body, filename, code) in [
            (
                401,
                json!({"message":"simulated-ocr-secret"}),
                "a.pdf",
                "ocr_authentication",
            ),
            (
                200,
                json!({"code":10010,"msg":"full"}),
                "a.pdf",
                "ocr_queue_full",
            ),
            (
                415,
                json!({"msg":"unsupported"}),
                "a.docx",
                "ocr_unsupported_document",
            ),
        ] {
            let server = mock(move |_, _| (status, serde_json::to_vec(&body).unwrap()));
            let dir = tempfile::tempdir().unwrap();
            let config = settings(dir.path(), &server.base);
            let audit = dir.path().join("audit");
            let err = recognize(
                &config,
                b"original",
                filename,
                "application/pdf",
                &audit,
                &AtomicBool::new(false),
            )
            .err()
            .unwrap();
            assert_eq!(err.code, code);
            assert!(audit.join("001-submit.json").is_file());
            assert!(audit.join("002-failure.json").is_file());
            assert!(!std::fs::read_to_string(audit.join("001-submit.json"))
                .unwrap()
                .contains("simulated-ocr-secret"));
        }
    }
    #[test]
    fn cancellation_is_responsive_while_waiting_for_poll() {
        let server = mock(|route, _| {
            (
                200,
                serde_json::to_vec(&if route == "/jobs" {
                    json!({"code":0,"data":{"jobId":"j"}})
                } else {
                    json!({"code":0,"data":{"state":"pending"}})
                })
                .unwrap(),
            )
        });
        let dir = tempfile::tempdir().unwrap();
        let config = settings(dir.path(), &server.base);
        let cancel = AtomicBool::new(false);
        let started = Instant::now();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(Duration::from_millis(200));
                cancel.store(true, Ordering::SeqCst);
            });
            let err = recognize(
                &config,
                b"original",
                "a.pdf",
                "application/pdf",
                &dir.path().join("audit"),
                &cancel,
            )
            .err()
            .unwrap();
            assert_eq!(err.code, "cancelled");
        });
        assert!(started.elapsed() < Duration::from_secs(2));
    }
    #[test]
    fn actual_named_layout_image_reuses_unique_crop_and_never_creates_a_duplicate_figure() {
        let server = mock(|route, base| {
            match route {
            "/jobs"=>(200,serde_json::to_vec(&json!({"code":0,"data":{"jobId":"j"}})).unwrap()),
            "/jobs/j"=>(200,serde_json::to_vec(&json!({"code":0,"data":{"state":"done","resultUrl":{"jsonUrl":format!("{base}/result")}}})).unwrap()),
            "/result"=>{let mut v=layout(base);let l=&mut v["result"]["layoutParsingResults"][0];l["markdown"]["text"]=json!("![图](imgs/img_in_image_box_2_3_7_8.jpg)");l["markdown"]["images"]=json!({"imgs/img_in_image_box_2_3_7_8.jpg":format!("{base}/unused.png")});(200,serde_json::to_vec(&v).unwrap())},
            _=>(200,png())
        }
        });
        let dir = tempfile::tempdir().unwrap();
        let config = settings(dir.path(), &server.base);
        let doc = recognize(
            &config,
            b"original",
            "a.pdf",
            "application/pdf",
            &dir.path().join("audit"),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(server.requests.lock().unwrap().len(), 4);
        assert_eq!(
            doc.assets
                .iter()
                .filter(|a| s(a, "role") == "figure")
                .count(),
            1
        );
        let id = s(&doc.pages[0]["blocks"][1], "assetId");
        assert!(s(&doc.pages[0], "text").contains(&format!("asset:{id}")));
        assert!(doc
            .assets
            .iter()
            .any(|a| s(a, "id") == id && a["bbox"] == json!([2, 3, 7, 8])));
    }
    #[test]
    fn uniform_preview_scale_preserves_layout_identity_and_audits_real_pixel_crop() {
        let server = mock(|route, base| {
            match route {
                "/jobs" => (200, serde_json::to_vec(&json!({"code":0,"data":{"jobId":"j"}})).unwrap()),
                "/jobs/j" => (200, serde_json::to_vec(&json!({"code":0,"data":{"state":"done","resultUrl":{"jsonUrl":format!("{base}/result")}}})).unwrap()),
                "/result" => {
                    let mut v = layout(base);
                    let l = &mut v["result"]["layoutParsingResults"][0];
                    l["prunedResult"]["width"] = json!(24);
                    l["prunedResult"]["height"] = json!(32);
                    l["prunedResult"]["parsing_res_list"][0]["block_bbox"] = json!([2,2,22,6]);
                    l["prunedResult"]["parsing_res_list"][1]["block_bbox"] = json!([4,6,14,16]);
                    l["prunedResult"]["parsing_res_list"][2]["block_bbox"] = json!([2,20,22,30]);
                    l["markdown"]["text"] = json!("![图](imgs/img_in_image_box_4_6_14_16.jpg)");
                    l["markdown"]["images"] = json!({"imgs/img_in_image_box_4_6_14_16.jpg":format!("{base}/must-not-download.png")});
                    (200, serde_json::to_vec(&v).unwrap())
                },
                _ => (200, png())
            }
        });
        let dir = tempfile::tempdir().unwrap();
        let config = settings(dir.path(), &server.base);
        let doc = recognize(
            &config,
            b"original",
            "a.pdf",
            "application/pdf",
            &dir.path().join("audit"),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(doc.pages[0]["width"], 24);
        assert_eq!(doc.pages[0]["height"], 32);
        assert_eq!(doc.pages[0]["coordinateTransform"]["kind"], "uniform_scale");
        assert_eq!(doc.pages[0]["coordinateTransform"]["imageWidth"], 12);
        let block = &doc.pages[0]["blocks"][1];
        assert_eq!(block["bbox"], json!([4, 6, 14, 16]));
        assert_eq!(block["sourceImageBbox"], json!([2, 3, 7, 8]));
        let a = doc
            .assets
            .iter()
            .find(|a| a["id"] == block["assetId"])
            .unwrap();
        assert_eq!(a["bbox"], block["bbox"]);
        assert_eq!(a["sourceImageBbox"], block["sourceImageBbox"]);
        assert_eq!(a["width"], 5);
        assert_eq!(a["height"], 5);
        assert!(!doc
            .issues
            .iter()
            .any(|i| matches!(s(i, "code"), "ocr_image_dimensions" | "ocr_invalid_crop")));
        assert!(!server
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|(p, _, _)| p.contains("must-not-download")));
    }
    #[test]
    fn preview_scaling_allows_pixel_rounding_but_rejects_stretch_rotation_and_layout_overflow() {
        assert!(page_scale([3570, 5052], [1413, 2000]));
        assert_eq!(
            image_bbox([1056, 3855, 2302, 4590], [3570, 5052], [1413, 2000]),
            Some([417, 1526, 912, 1818])
        );
        assert!(!page_scale([3570, 5052], [2000, 1413]));
        assert!(!page_scale([3570, 5052], [1413, 1900]));
        assert!(!page_scale([0, 5052], [1413, 2000]));
        assert_eq!(
            image_bbox([1, 1, 3571, 5052], [3570, 5052], [1413, 2000]),
            None
        );
        assert_eq!(
            image_bbox([1, 1, 3570, 5053], [3570, 5052], [1413, 2000]),
            None
        );
        assert_eq!(
            image_bbox([10, 10, 10, 11], [3570, 5052], [1413, 2000]),
            None
        );
        assert_eq!(
            image_bbox([3569, 5051, 3570, 5052], [3570, 5052], [1413, 2000]),
            Some([1412, 1999, 1413, 2000])
        );
    }
    #[test]
    fn provider_failure_and_private_result_destination_stop_before_any_download() {
        for (data, code) in [
            (
                json!({"state":"failed","errorMsg":"simulated failure"}),
                "ocr_job_failed",
            ),
            (
                json!({"state":"done","resultUrl":{"jsonUrl":"https://127.0.0.1/private"}}),
                "ocr_unsafe_url",
            ),
        ] {
            let server = mock(move |route, _| {
                (
                    200,
                    serde_json::to_vec(&if route == "/jobs" {
                        json!({"code":0,"data":{"jobId":"j"}})
                    } else {
                        json!({"code":0,"data":data})
                    })
                    .unwrap(),
                )
            });
            let dir = tempfile::tempdir().unwrap();
            let config = settings(dir.path(), &server.base);
            let err = recognize(
                &config,
                b"original",
                "a.pdf",
                "application/pdf",
                &dir.path().join("audit"),
                &AtomicBool::new(false),
            )
            .err()
            .unwrap();
            assert_eq!(err.code, code);
            assert_eq!(server.requests.lock().unwrap().len(), 2);
            assert!(dir.path().join("audit/003-failure.json").is_file());
        }
    }
    #[test]
    fn endpoint_key_gate_and_pre_cancel_precede_network_or_audit_creation() {
        let dir = tempfile::tempdir().unwrap();
        let empty = OcrSettings::open(dir.path()).unwrap();
        let audit = dir.path().join("audit");
        assert_eq!(
            recognize(
                &empty,
                b"x",
                "a.pdf",
                "application/pdf",
                &audit,
                &AtomicBool::new(false)
            )
            .err()
            .unwrap()
            .code,
            "ocr_not_configured"
        );
        assert!(!audit.exists());
        let config = settings(dir.path(), "http://127.0.0.1:9");
        assert_eq!(
            recognize(
                &config,
                b"x",
                "a.pdf",
                "application/pdf",
                &audit,
                &AtomicBool::new(true)
            )
            .err()
            .unwrap()
            .code,
            "cancelled"
        );
        assert!(!audit.exists());
    }
    #[test]
    fn url_guards_reject_private_targets_credentials_redirects_and_mapping() {
        let endpoint = Url::parse("https://ocr.example/jobs").unwrap();
        for raw in [
            "http://public.example/x",
            "https://user:secret@host.example/x",
            "https://127.0.0.1/x",
            "file:///C:/secret",
            "https://[::1]/x",
        ] {
            assert!(validate_url(raw, &endpoint).is_err());
        }
        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.2",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.1.1",
            "0.0.0.0",
            "224.0.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
        ] {
            assert!(!public_ip(address.parse().unwrap()), "{address}");
        }
        assert!(public_ip("8.8.8.8".parse().unwrap()));
        assert!(public_ip("2606:4700:4700::1111".parse().unwrap()));
        let server = mock(|_, _| (302, b"redirect blocked".to_vec()));
        let dir = tempfile::tempdir().unwrap();
        let config = settings(dir.path(), &server.base);
        assert_eq!(
            recognize(
                &config,
                b"x",
                "a.pdf",
                "application/pdf",
                &dir.path().join("audit"),
                &AtomicBool::new(false)
            )
            .err()
            .unwrap()
            .code,
            "ocr_http_error"
        );
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    }
    #[test]
    fn local_tun_synthetic_dns_is_limited_to_observed_official_https_hosts() {
        let endpoint = Url::parse("https://paddleocr.aistudio-app.com/api/v2/ocr/jobs").unwrap();
        for host in [
            "paddleocr.aistudio-app.com",
            "pplines-online.bj.bcebos.com",
            "paddleocr-store.bj.bcebos.com",
            "paddleocr-store-1.bj.bcebos.com",
            "paddleocr-store-2.bj.bcebos.com",
            "paddleocr-store-3.bj.bcebos.com",
            "paddleocr-store-6.bj.bcebos.com",
            "paddleocr-store-7.bj.bcebos.com",
            "paddleocr-store-8.bj.bcebos.com",
            "paddleocr-store-9.bj.bcebos.com",
            "paddleocr-store-4.bj.bcebos.com",
            "paddleocr-store-5.bj.bcebos.com",
        ] {
            let target = Url::parse(&format!("https://{host}/result")).unwrap();
            for ip in ["198.18.0.137", "198.18.1.88", "198.19.255.254"] {
                let ip = ip.parse().unwrap();
                assert!(!public_ip(ip));
                assert!(allowed_address(&target, &endpoint, ip));
            }
            for ip in [
                "127.0.0.1",
                "10.0.0.1",
                "172.16.0.2",
                "192.168.0.1",
                "169.254.169.254",
                "::1",
                "::ffff:198.18.0.137",
            ] {
                assert!(
                    !allowed_address(&target, &endpoint, ip.parse().unwrap()),
                    "{host} -> {ip}"
                );
            }
        }
        let fake = "198.18.0.137".parse().unwrap();
        for target in [
            "https://198.18.0.137/result",
            "https://paddleocr.aistudio-app.com.evil.example/result",
            "https://paddleocr-store-2.bj.bcebos.com.evil.example/result",
            "https://unrelated.bj.bcebos.com/result",
            "https://paddleocr-store-9.bj.bcebos.com.evil.example/result",
            "https://paddleocr-store-10.bj.bcebos.com/result",
            "https://paddleocr.aistudio-app.com:444/result",
            "http://paddleocr.aistudio-app.com/result",
            "https://user:password@paddleocr.aistudio-app.com/result",
        ] {
            assert!(
                !allowed_address(&Url::parse(target).unwrap(), &endpoint, fake),
                "{target}"
            );
        }
        let official_target = Url::parse("https://pplines-online.bj.bcebos.com/image").unwrap();
        for other_endpoint in [
            "https://custom-ocr.example/jobs",
            "http://paddleocr.aistudio-app.com/jobs",
            "https://paddleocr.aistudio-app.com:444/jobs",
        ] {
            assert!(!allowed_address(
                &official_target,
                &Url::parse(other_endpoint).unwrap(),
                fake
            ));
        }
    }
    #[test]
    fn figure_captions_keep_null_order_without_falsely_blocking_body_order() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = AtomicBool::new(false);
        let mut run = Run {
            endpoint: Url::parse("https://ocr.example/jobs").unwrap(),
            key: "",
            audit: dir.path(),
            cancel: &cancel,
            start: Instant::now(),
            sequence: 0,
            total: 0,
            docx: false,
            cached_images: HashMap::new(),
        };
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let mut blocks = vec![
            json!({"block_id":0,"block_label":"text","block_content":"模拟回归题干","block_order":1,"block_bbox":[0,0,12,3]}),
        ];
        for (i, caption) in ["A.", "B.", "C.", "D.", "第17题图"].iter().enumerate() {
            blocks.push(json!({"block_id":i+1,"block_label":"figure_title","block_content":caption,"block_order":null,"block_bbox":[1,4,11,7]}));
        }
        blocks.push(json!({"block_id":6,"block_label":"text","block_content":"模拟回归后续正文","block_order":2,"block_bbox":[0,9,12,12]}));
        let mut data = json!({"result":{"layoutParsingResults":[{"prunedResult":{"width":12,"height":16,"parsing_res_list":blocks},"markdown":{"text":"模拟图注及正文","images":{}}}]}});
        let result = runtime
            .block_on(normalize(
                &mut run,
                &serde_json::to_vec(&data).unwrap(),
                Some(1),
            ))
            .unwrap();
        assert!(!result
            .issues
            .iter()
            .any(|i| s(i, "code") == "ocr_reading_order_uncertain"));
        for (i, caption) in ["A.", "B.", "C.", "D.", "第17题图"].iter().enumerate() {
            let block = &result.pages[0]["blocks"][i + 1];
            assert_eq!(block["order"], Value::Null);
            assert_eq!(block["text"], *caption);
            assert_eq!(block["type"], "figure_title");
            assert_eq!(block["id"], i + 1);
        }
        // The exception applies only to captions; real body order remains
        // checked even when its neighboring figure captions have no order.
        data["result"]["layoutParsingResults"][0]["prunedResult"]["parsing_res_list"][6]
            ["block_order"] = Value::Null;
        let result = runtime
            .block_on(normalize(
                &mut run,
                &serde_json::to_vec(&data).unwrap(),
                Some(1),
            ))
            .unwrap();
        assert!(result
            .issues
            .iter()
            .any(|i| s(i, "code") == "ocr_reading_order_uncertain" && i["blocking"] == true));
    }
    #[test]
    fn missing_pages_images_layout_and_truncated_jsonl_never_become_complete() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = AtomicBool::new(false);
        let mut run = Run {
            endpoint: Url::parse("https://ocr.example/jobs").unwrap(),
            key: "",
            audit: dir.path(),
            cancel: &cancel,
            start: Instant::now(),
            sequence: 0,
            total: 0,
            docx: false,
            cached_images: HashMap::new(),
        };
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let data = json!({"result":{"layoutParsingResults":[{"prunedResult":{"page_index":3},"markdown":{"text":"![missing](imgs/missing.png)","images":{}}}]}});
        let result = runtime
            .block_on(normalize(
                &mut run,
                &serde_json::to_vec(&data).unwrap(),
                Some(2),
            ))
            .unwrap();
        for code in [
            "ocr_missing_pages",
            "ocr_missing_layout",
            "ocr_page_order_conflict",
            "ocr_missing_source_image",
            "ocr_unresolved_image",
        ] {
            assert!(
                result
                    .issues
                    .iter()
                    .any(|x| s(x, "code") == code && x["blocking"] == true),
                "{code}"
            );
        }
        assert_eq!(
            runtime
                .block_on(normalize(&mut run, b"{\"result\":\n{", None))
                .err()
                .unwrap()
                .code,
            "ocr_invalid_jsonl"
        );
        let too_many = json!({"result":{"layoutParsingResults":vec![json!({});51]}});
        assert_eq!(
            runtime
                .block_on(normalize(
                    &mut run,
                    &serde_json::to_vec(&too_many).unwrap(),
                    None
                ))
                .err()
                .unwrap()
                .code,
            "ocr_page_limit"
        );
        run.start = Instant::now() - Duration::from_secs(301);
        assert_eq!(check(&cancel, run.start).err().unwrap().code, "ocr_timeout");
    }
}
