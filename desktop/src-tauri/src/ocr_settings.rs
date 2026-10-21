use crate::error::{AppError, AppResult};
use crate::model::secret_bytes;
use base64::Engine;
use serde_json::{Value, json};
use std::{
    io::Write,
    path::{Path, PathBuf},
};

const DEFAULT_ENDPOINT: &str = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs";
const DEFAULT_MODEL: &str = "PaddleOCR-VL-1.6";

/// Independent local OCR credentials. Opening settings never adopts LLM or environment keys.
#[derive(Clone)]
pub struct OcrSettings {
    path: PathBuf,
    base_url: String,
    model: String,
    api_key: String,
    protected_key: String,
    revision: u64,
    loaded_bytes: Option<Vec<u8>>,
    warning: Option<String>,
    damaged: bool,
    damaged_key: bool,
}

fn invalid(message: &str) -> AppError {
    AppError::new("invalid_input", message)
}
fn endpoint(value: &str) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 2048 || value.chars().any(char::is_control) {
        return Err(invalid("请填写有效的 PaddleOCR 服务地址。"));
    }
    let parsed = reqwest::Url::parse(value).map_err(|_| invalid("PaddleOCR 服务地址无效。"))?;
    let local = matches!(
        parsed.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    if parsed.host_str().is_none()
        || (parsed.scheme() != "https" && !(parsed.scheme() == "http" && local))
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(invalid(
            "PaddleOCR 地址需使用 HTTPS，不能包含账号、查询参数或片段；仅本机回归服务可使用 HTTP。",
        ));
    }
    Ok(parsed.to_string().trim_end_matches('/').to_owned())
}
fn model_name(value: &str) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 200 || value.chars().any(char::is_control) {
        return Err(invalid("请填写有效的 PaddleOCR 模型名称。"));
    }
    Ok(value.to_owned())
}
fn read_optional(path: &Path) -> AppResult<Option<Vec<u8>>> {
    match std::fs::read(path) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}
impl OcrSettings {
    pub fn open(data_dir: &Path) -> AppResult<Self> {
        let path = data_dir.join("ocr-settings.json");
        let loaded_bytes = read_optional(&path)?;
        let mut result = Self {
            path,
            base_url: DEFAULT_ENDPOINT.into(),
            model: DEFAULT_MODEL.into(),
            api_key: String::new(),
            protected_key: String::new(),
            revision: 0,
            loaded_bytes,
            warning: None,
            damaged: false,
            damaged_key: false,
        };
        let Some(bytes) = &result.loaded_bytes else {
            return Ok(result);
        };
        let decoded = (|| -> AppResult<(String, String, String, u64)> {
            if bytes.len() > 65536 {
                return Err(invalid("OCR 配置过大。"));
            }
            let value: Value = serde_json::from_slice(bytes)?;
            if value["schemaVersion"].as_u64() != Some(1) || value["provider"] != "paddleocr" {
                return Err(invalid("OCR 配置版本无效。"));
            }
            let base = endpoint(
                value["baseUrl"]
                    .as_str()
                    .ok_or_else(|| invalid("OCR 地址无效。"))?,
            )?;
            let model = model_name(
                value["model"]
                    .as_str()
                    .ok_or_else(|| invalid("OCR 模型无效。"))?,
            )?;
            let key = value["protectedKey"]
                .as_str()
                .filter(|key| key.len() <= 32768)
                .ok_or_else(|| invalid("OCR 密钥无效。"))?
                .to_owned();
            let revision = value["revision"]
                .as_u64()
                .ok_or_else(|| invalid("OCR 修订无效。"))?;
            Ok((base, model, key, revision))
        })();
        match decoded {
            Ok((base, model, protected, revision)) => {
                result.base_url = base;
                result.model = model;
                result.revision = revision;
                result.protected_key = protected;
                if !result.protected_key.is_empty() {
                    let key = base64::engine::general_purpose::STANDARD
                        .decode(&result.protected_key)
                        .map_err(|_| invalid("OCR 密钥数据无效。"))
                        .and_then(|bytes| secret_bytes(&bytes, true))
                        .and_then(|bytes| {
                            String::from_utf8(bytes).map_err(|_| invalid("OCR 密钥格式无效。"))
                        })
                        .and_then(|key| {
                            if key.is_empty()
                                || key.len() > 8192
                                || key.chars().any(char::is_control)
                            {
                                Err(invalid("OCR 密钥格式无效。"))
                            } else {
                                Ok(key)
                            }
                        });
                    match key {
                        Ok(key) => result.api_key = key,
                        Err(_) => {
                            result.damaged_key = true;
                            result.warning = Some("无法读取 PaddleOCR 密钥，请重新填写或明确清除密钥；原配置会备份保留。".into());
                        }
                    }
                }
            }
            Err(_) => {
                result.damaged = true;
                result.warning = Some(
                    "PaddleOCR 配置文件损坏或版本不支持，已保留原文件；请恢复配置后再保存。".into(),
                );
            }
        }
        Ok(result)
    }
    pub fn configured(&self) -> bool {
        !self.damaged && !self.damaged_key && !self.api_key.is_empty()
    }
    pub fn public_settings(&self) -> Value {
        json!({"provider":"paddleocr", "baseUrl":self.base_url, "model":self.model,
            "configured":self.configured(), "apiKeyConfigured":!self.protected_key.is_empty(),
            "revision":self.revision, "warning":self.warning})
    }
    /// Provenance only: credentials and their encrypted representation never enter imports.
    pub fn descriptor(&self) -> Value {
        json!({"provider":"paddleocr", "baseUrl":self.base_url, "model":self.model,
            "revision":self.revision})
    }
    pub(crate) fn endpoint(&self) -> &str {
        &self.base_url
    }
    pub(crate) fn model(&self) -> &str {
        &self.model
    }
    pub(crate) fn api_key(&self) -> &str {
        &self.api_key
    }

    pub fn save(&mut self, input: &Value) -> AppResult<Value> {
        if self.damaged {
            return Err(AppError::new(
                "settings_damaged",
                "PaddleOCR 配置文件损坏或版本不支持，原文件已保留；请恢复后再保存。",
            ));
        }
        if input["expectedRevision"].as_u64() != Some(self.revision) {
            return Err(AppError::new(
                "revision_conflict",
                "PaddleOCR 配置已变更，请重新读取后保存。",
            ));
        }
        let base_url = endpoint(
            input["baseUrl"]
                .as_str()
                .ok_or_else(|| invalid("请填写 PaddleOCR 服务地址。"))?,
        )?;
        let model = model_name(
            input["model"]
                .as_str()
                .ok_or_else(|| invalid("请填写 PaddleOCR 模型名称。"))?,
        )?;
        let entered = match input.get("apiKey") {
            None | Some(Value::Null) => "",
            Some(Value::String(key)) => key.as_str(),
            _ => return Err(invalid("PaddleOCR 密钥格式无效。")),
        };
        if entered.len() > 8192
            || entered.chars().any(char::is_control)
            || (!entered.is_empty() && entered.trim().is_empty())
        {
            return Err(invalid("PaddleOCR 密钥格式无效。"));
        }
        let clear = match input.get("clearApiKey") {
            None => false,
            Some(Value::Bool(value)) => *value,
            _ => return Err(invalid("清除 PaddleOCR 密钥的选项无效。")),
        };
        if clear && !entered.is_empty() {
            return Err(invalid("请分别执行替换或清除 PaddleOCR 密钥。"));
        }
        if self.damaged_key && !clear && entered.is_empty() {
            return Err(AppError::new(
                "credential_error",
                "PaddleOCR 密钥无法读取，请重新填写或明确清除。",
            ));
        }
        let changed_origin = reqwest::Url::parse(&self.base_url)
            .ok()
            .map(|url| url.origin())
            != reqwest::Url::parse(&base_url).ok().map(|url| url.origin());
        if changed_origin && !self.protected_key.is_empty() && entered.is_empty() && !clear {
            return Err(invalid(
                "PaddleOCR 服务来源已变更，请重新输入密钥或明确清除。",
            ));
        }
        let (api_key, protected_key) = if clear {
            (String::new(), String::new())
        } else if !entered.is_empty() {
            (
                entered.to_owned(),
                base64::engine::general_purpose::STANDARD
                    .encode(secret_bytes(entered.as_bytes(), false)?),
            )
        } else {
            (self.api_key.clone(), self.protected_key.clone())
        };
        let revision = self
            .revision
            .checked_add(1)
            .ok_or_else(|| invalid("OCR 配置修订超出限制。"))?;
        let bytes = serde_json::to_vec(
            &json!({"schemaVersion":1, "provider":"paddleocr", "revision":revision,
            "baseUrl":base_url,"model":model,"protectedKey":protected_key}),
        )?;
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // The OS lock survives stale lock files and releases on process exit.
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.path.with_extension("lock"))?;
        lock.try_lock().map_err(|_| {
            AppError::new(
                "revision_conflict",
                "PaddleOCR 配置正在保存，请稍后重新读取。",
            )
        })?;
        let current = read_optional(&self.path)?;
        if current != self.loaded_bytes {
            return Err(AppError::new(
                "revision_conflict",
                "PaddleOCR 配置已由其它窗口变更，请重新读取后保存。",
            ));
        }
        let temporary = self
            .path
            .with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let write = (|| -> AppResult<()> {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            if self.damaged_key {
                if let Some(original) = &current {
                    let backup = self.path.with_file_name(format!(
                        "ocr-settings.damaged-{}.json",
                        uuid::Uuid::new_v4()
                    ));
                    let mut file = std::fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(backup)?;
                    file.write_all(original)?;
                    file.sync_all()?;
                }
            }
            std::fs::rename(&temporary, &self.path)?;
            Ok(())
        })();
        if let Err(error) = write {
            let _ = std::fs::remove_file(&temporary);
            return Err(error);
        }
        self.base_url = base_url;
        self.model = model;
        self.api_key = api_key;
        self.protected_key = protected_key;
        self.revision = revision;
        self.loaded_bytes = Some(bytes);
        self.damaged_key = false;
        self.warning = None;
        Ok(self.public_settings())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(settings: &OcrSettings, key: &str) -> Value {
        json!({"expectedRevision":settings.revision, "baseUrl":settings.endpoint(),
            "model":settings.model(), "apiKey":key})
    }
    #[test]
    fn first_open_is_unconfigured_and_does_not_create_or_read_llm_settings() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("model-settings.json"),
            "simulated-private-llm-credential",
        )
        .unwrap();
        let settings = OcrSettings::open(dir.path()).unwrap();
        assert!(!settings.configured());
        assert_eq!(settings.endpoint(), DEFAULT_ENDPOINT);
        assert_eq!(settings.model(), DEFAULT_MODEL);
        assert_eq!(settings.api_key(), "");
        assert!(
            !settings.public_settings()["apiKeyConfigured"]
                .as_bool()
                .unwrap()
        );
        assert!(!dir.path().join("ocr-settings.json").exists());
    }
    #[test]
    fn invalid_remote_urls_are_rejected_without_persisting_or_echoing_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let mut settings = OcrSettings::open(dir.path()).unwrap();
        for value in [
            "http://example.com/jobs",
            "https://user:simulated-secret@example.com/jobs",
            "https://example.com/jobs?key=simulated-secret",
            "https://example.com/jobs#simulated-secret",
            "file:///tmp/jobs",
        ] {
            let mut candidate = input(&settings, "");
            candidate["baseUrl"] = json!(value);
            let error = settings.save(&candidate).unwrap_err();
            assert_eq!(error.code, "invalid_input");
            assert!(!error.message.contains("simulated-secret"));
        }
        assert!(!dir.path().join("ocr-settings.json").exists());
        assert!(endpoint("http://127.0.0.1:18766/jobs").is_ok());
        assert!(endpoint("http://[::1]:18766/jobs").is_ok());
    }
    #[test]
    fn malformed_settings_remain_readable_as_warning_but_cannot_be_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ocr-settings.json");
        let original = b"{malformed simulated settings";
        std::fs::write(&path, original).unwrap();
        let mut settings = OcrSettings::open(dir.path()).unwrap();
        assert!(!settings.configured());
        assert!(settings.public_settings()["warning"].is_string());
        assert_eq!(
            settings.save(&input(&settings, "")).unwrap_err().code,
            "settings_damaged"
        );
        assert_eq!(std::fs::read(path).unwrap(), original);
    }
    #[test]
    fn revision_file_lock_and_external_modification_preserve_existing_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let mut first = OcrSettings::open(dir.path()).unwrap();
        let mut stale = first.clone();
        first.save(&input(&first, "")).unwrap();
        let path = dir.path().join("ocr-settings.json");
        let original = std::fs::read(&path).unwrap();
        assert_eq!(
            stale.save(&input(&stale, "")).unwrap_err().code,
            "revision_conflict"
        );
        let mut invalid_revision = input(&first, "");
        invalid_revision["expectedRevision"] = json!(0);
        assert_eq!(
            first.save(&invalid_revision).unwrap_err().code,
            "revision_conflict"
        );
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path.with_extension("lock"))
            .unwrap();
        lock.try_lock().unwrap();
        assert_eq!(
            first.save(&input(&first, "")).unwrap_err().code,
            "revision_conflict"
        );
        drop(lock);
        assert_eq!(std::fs::read(&path).unwrap(), original);
        std::fs::write(&path, b"externally changed simulated settings").unwrap();
        assert_eq!(
            first.save(&input(&first, "")).unwrap_err().code,
            "revision_conflict"
        );
        assert_eq!(
            std::fs::read(path).unwrap(),
            b"externally changed simulated settings"
        );
    }
    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn credentials_are_encrypted_redacted_preserved_and_explicitly_cleared() {
        let dir = tempfile::tempdir().unwrap();
        let mut settings = OcrSettings::open(dir.path()).unwrap();
        let secret = "simulated-paddle-regression-key";
        let public = settings.save(&input(&settings, secret)).unwrap();
        assert!(public["configured"].as_bool().unwrap());
        assert!(!public.to_string().contains(secret));
        assert!(!settings.descriptor().to_string().contains(secret));
        let bytes = std::fs::read(dir.path().join("ocr-settings.json")).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains(secret));
        settings = OcrSettings::open(dir.path()).unwrap();
        assert_eq!(settings.api_key(), secret);
        settings.save(&input(&settings, "")).unwrap();
        assert_eq!(OcrSettings::open(dir.path()).unwrap().api_key(), secret);
        let mut changed = input(&settings, "");
        changed["baseUrl"] = json!("https://different.example/jobs");
        assert_eq!(settings.save(&changed).unwrap_err().code, "invalid_input");
        changed["clearApiKey"] = json!(true);
        settings.save(&changed).unwrap();
        let reopened = OcrSettings::open(dir.path()).unwrap();
        assert!(!reopened.configured());
        assert_eq!(reopened.api_key(), "");
        assert!(
            !reopened.public_settings()["apiKeyConfigured"]
                .as_bool()
                .unwrap()
        );
    }
    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn corrupted_encrypted_key_requires_explicit_repair_and_keeps_a_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ocr-settings.json");
        let original = serde_json::to_vec(
            &json!({"schemaVersion":1,"provider":"paddleocr","revision":4,
            "baseUrl":DEFAULT_ENDPOINT,"model":DEFAULT_MODEL,"protectedKey":"broken!"}),
        )
        .unwrap();
        std::fs::write(&path, &original).unwrap();
        let mut settings = OcrSettings::open(dir.path()).unwrap();
        assert!(!settings.configured());
        assert_eq!(
            settings.save(&input(&settings, "")).unwrap_err().code,
            "credential_error"
        );
        settings
            .save(&input(&settings, "simulated-replacement-key"))
            .unwrap();
        assert!(settings.configured());
        let backups: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|item| {
                item.file_name()
                    .to_string_lossy()
                    .starts_with("ocr-settings.damaged-")
            })
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(std::fs::read(backups[0].path()).unwrap(), original);
        assert_eq!(OcrSettings::open(dir.path()).unwrap().revision, 5);
    }
}
