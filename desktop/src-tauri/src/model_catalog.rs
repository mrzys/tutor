use super::*;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    io::Read,
    sync::{Mutex, OnceLock},
};

const MAX_BYTES: u64 = 2 * 1024 * 1024;
const GRANT_LIFETIME: Duration = Duration::from_secs(30 * 60);
struct CatalogGrant {
    token: String,
    settings_path: PathBuf,
    provider: String,
    profile_id: String,
    key_hash: Vec<u8>,
    models: HashSet<String>,
    created: Instant,
}
fn grants() -> &'static Mutex<Vec<CatalogGrant>> {
    static GRANTS: OnceLock<Mutex<Vec<CatalogGrant>>> = OnceLock::new();
    GRANTS.get_or_init(|| Mutex::new(Vec::new()))
}
fn catalog_error(message: &str) -> AppError {
    AppError::new("model_catalog_error", message)
}
// Discovery and the workspace may reach the same directory through different
// OS path spellings (notably Windows canonical \?\ paths). Canonicalize the
// existing parent: a new profile has no settings file to canonicalize yet.
fn settings_identity(path: &Path) -> AppResult<PathBuf> {
    let parent = path
        .parent()
        .ok_or_else(|| catalog_error("本机模型配置目录暂不可用，请重新获取模型列表。"))?;
    let directory = std::fs::canonicalize(parent)
        .map_err(|_| catalog_error("本机模型配置目录暂不可用，请重新获取模型列表。"))?;
    Ok(directory.join("model-settings.json"))
}
fn entered_key(input: &Value) -> AppResult<&str> {
    let key = match input.get("apiKey") {
        None | Some(Value::Null) => "",
        Some(Value::String(key)) => key.as_str(),
        _ => return Err(input_error("模型密钥格式无效。")),
    };
    if key.len() > 8192
        || key.chars().any(char::is_control)
        || (!key.is_empty() && key.trim().is_empty())
    {
        return Err(input_error("模型密钥格式无效。"));
    }
    Ok(key)
}
impl ModelClient {
    /// Explicit model discovery uses only this profile's credential, never the active profile.
    pub fn list_models(&self, input: &Value) -> AppResult<Value> {
        let provider = named_string(input, "provider", 80)?;
        let preset = model_providers()["providers"]
            .as_array()
            .and_then(|rows| rows.iter().find(|row| row["id"] == provider))
            .ok_or_else(|| input_error("请选择支持的模型服务商。"))?;
        if input.get("baseUrl").is_some() || input.get("url").is_some() {
            return Err(input_error("模型列表地址由服务商固定，请重新选择服务商。"));
        }
        let profile_id = match input.get("profileId") {
            None | Some(Value::Null) => String::new(),
            _ => named_string(input, "profileId", 120)?,
        };
        let entered = entered_key(input)?;
        let key = if !entered.is_empty() {
            entered
        } else {
            self.profiles
                .iter()
                .find(|profile| {
                    profile.id == profile_id
                        && model_provider(&profile.base_url) == Some(provider.as_str())
                })
                .map(|profile| profile.api_key.as_str())
                .unwrap_or("")
        };
        if key.is_empty() {
            return Err(AppError::new(
                "not_configured",
                "请先填写此配置的 API Key，再获取模型列表。",
            ));
        }
        let base = preset["baseUrl"]
            .as_str()
            .expect("bundled provider base URL");
        // The bundled registry is the only origin authority. No URL comes from IPC.
        if model_provider(base) != Some(provider.as_str()) || preset["modelsPath"] != "/models" {
            return Err(catalog_error("此服务商的模型列表地址尚未配置。"));
        }
        self.fetch_catalog(&provider, &profile_id, base, key, &format!("{base}/models"))
    }
    #[cfg(test)]
    pub(super) fn test_fetch_catalog(
        &self,
        profile_id: &str,
        key: &str,
        url: &str,
    ) -> AppResult<Value> {
        self.fetch_catalog("qianwenai", profile_id,
            "https://maas.qianwenaiapi.com/compatible-mode/v1", key, url)
    }
    fn fetch_catalog(
        &self,
        provider: &str,
        profile_id: &str,
        base: &str,
        key: &str,
        url: &str,
    ) -> AppResult<Value> {
        self.fetch_catalog_with_timeout(
            provider,
            profile_id,
            base,
            key,
            url,
            Duration::from_secs(25),
        )
    }
    fn fetch_catalog_with_timeout(
        &self,
        provider: &str,
        profile_id: &str,
        base: &str,
        key: &str,
        url: &str,
        timeout: Duration,
    ) -> AppResult<Value> {
        let client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10).min(timeout))
            .timeout(timeout)
            .build()
            .map_err(|_| catalog_error("无法初始化模型列表连接。"))?;
        let response = client.get(url).bearer_auth(key).send().map_err(|error| {
            catalog_error(if error.is_timeout() {
                "获取模型列表超时，请重试。"
            } else {
                "获取模型列表失败，请检查网络后重试。"
            })
        })?;
        let status = response.status();
        if !status.is_success() {
            // Provider errors can echo credentials or arbitrary HTML. Never surface bodies/URLs.
            return Err(catalog_error(&format!(
                "模型列表服务返回 {}，请检查此配置的密钥或稍后重试。",
                status.as_u16()
            )));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_BYTES)
        {
            return Err(catalog_error("模型列表响应过大，请稍后重试。"));
        }
        let mut bytes = Vec::new();
        response
            .take(MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| catalog_error("模型列表读取中断，请重试。"))?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err(catalog_error("模型列表响应过大，请稍后重试。"));
        }
        let models = parse_catalog(&bytes, provider, key)?;
        let settings_path = settings_identity(&self.path)?;
        let token = uuid::Uuid::new_v4().to_string();
        let mut cache = grants()
            .lock()
            .map_err(|_| catalog_error("模型列表暂不可用，请重新获取。"))?;
        cache.retain(|grant| grant.created.elapsed() < GRANT_LIFETIME);
        if cache.len() >= 100 {
            cache.remove(0);
        }
        cache.push(CatalogGrant {
            token: token.clone(),
            settings_path,
            provider: provider.into(),
            profile_id: profile_id.into(),
            key_hash: Sha256::digest(key.as_bytes()).to_vec(),
            models: models
                .iter()
                .map(|model| model["id"].as_str().unwrap().to_owned())
                .collect(),
            created: Instant::now(),
        });
        Ok(json!({"provider":provider,"baseUrl":base,"models":models,"catalogToken":token}))
    }
    pub(super) fn catalog_authorizes(
        &self,
        item: &Value,
        id: &str,
        previous: Option<&ModelProfile>,
    ) -> AppResult<bool> {
        let token = match item.get("catalogToken") {
            None | Some(Value::Null) => return Ok(false),
            Some(token) => token,
        };
        let token = token
            .as_str()
            .filter(|token| token.len() <= 120)
            .ok_or_else(|| input_error("模型列表凭据无效，请重新获取模型列表。"))?;
        let provider = item["provider"]
            .as_str()
            .or_else(|| item["baseUrl"].as_str().and_then(model_provider));
        let entered = entered_key(item)?;
        let key = if !entered.is_empty() {
            entered
        } else {
            previous
                .filter(|profile| model_provider(&profile.base_url) == provider)
                .map_or("", |profile| profile.api_key.as_str())
        };
        let model = item["model"].as_str().unwrap_or("");
        let settings_path = settings_identity(&self.path)?;
        let cache = grants()
            .lock()
            .map_err(|_| catalog_error("模型列表暂不可用，请重新获取。"))?;
        Ok(cache.iter().any(|grant| {
            grant.token == token
                && grant.created.elapsed() < GRANT_LIFETIME
                && grant.settings_path == settings_path
                && Some(grant.provider.as_str()) == provider
                && grant.profile_id == id
                && !id.is_empty()
                && !key.is_empty()
                && grant.key_hash == Sha256::digest(key.as_bytes()).as_slice()
                && grant.models.contains(model)
        }))
    }
}
fn parse_catalog(bytes: &[u8], provider: &str, secret: &str) -> AppResult<Vec<Value>> {
    let invalid = || catalog_error("服务商返回的模型列表格式无效，请稍后重试。");
    let value: Value = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    if value.get("error").is_some_and(|error| !error.is_null()) {
        return Err(invalid());
    }
    let rows = value["data"]
        .as_array()
        .filter(|rows| !rows.is_empty() && rows.len() <= 10000)
        .ok_or_else(invalid)?;
    let mut ids = HashSet::new();
    let mut models = Vec::new();
    for row in rows {
        let id = row["id"]
            .as_str()
            .filter(|id| {
                !id.is_empty()
                    && id.len() <= 200
                    && !id
                        .chars()
                        .any(|character| character.is_whitespace() || character.is_control())
                    && (secret.is_empty() || !id.contains(secret))
            })
            .ok_or_else(invalid)?;
        if !ids.insert(id) {
            return Err(invalid());
        }
        let known = model_providers()["providers"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|preset| preset["id"] == provider)
            .and_then(|preset| preset["models"].as_array())
            .and_then(|models| models.iter().find(|model| model["id"] == id));
        let mut model =
            json!({"id":id,"label":known.and_then(|model| model["label"].as_str()).unwrap_or(id)});
        if let Some(options) = known.and_then(|model| model.get("reasoningOptions")) {
            model["reasoningOptions"] = options.clone();
        }
        models.push(model);
    }
    models.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{net::TcpListener, thread};

    fn served(
        client: &ModelClient,
        provider: &str,
        profile: &str,
        key: &str,
        status: &str,
        headers: &str,
        body: &[u8],
    ) -> (AppResult<Value>, String) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/models", listener.local_addr().unwrap());
        let reply = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n",
            body.len()
        )
        .into_bytes();
        let body = body.to_vec();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = Vec::new();
            loop {
                let mut chunk = [0; 1024];
                let count = stream.read(&mut chunk).unwrap();
                request.extend_from_slice(&chunk[..count]);
                if count == 0 || request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            stream.write_all(&reply).unwrap();
            let _ = stream.write_all(&body);
            String::from_utf8(request).unwrap()
        });
        let base = model_providers()["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == provider)
            .unwrap()["baseUrl"]
            .as_str()
            .unwrap();
        let result = client.fetch_catalog(provider, profile, base, key, &url);
        (result, server.join().unwrap())
    }
    fn client(directory: &Path) -> ModelClient {
        ModelClient::test_client(directory, "http://127.0.0.1:1/v1")
    }

    #[test]
    fn listed_37_flash_gets_verified_switches_without_becoming_a_static_model_list() {
        let listed = parse_catalog(br#"{"data":[{"id":"qwen3.7-flash"},{"id":"qwen3.7-flash-2026-07-15"},{"id":"qwen3.7-flash-unknown"}]}"#, "bailian", "").unwrap();
        for id in ["qwen3.7-flash", "qwen3.7-flash-2026-07-15"] {
            let model = listed.iter().find(|row| row["id"] == id).unwrap();
            assert_eq!(model["reasoningOptions"][0]["id"], "off");
            assert_eq!(model["reasoningOptions"][1]["id"], "on");
        }
        assert!(listed.iter().find(|row| row["id"] == "qwen3.7-flash-unknown").unwrap().get("reasoningOptions").is_none());
        let other = parse_catalog(br#"{"data":[{"id":"unverified-model"}]}"#, "bailian", "").unwrap();
        assert_eq!(other.len(),1);
        assert_eq!(other[0]["id"],"unverified-model");
    }
    #[test]
    fn real_list_transport_scopes_bearer_and_does_not_invent_thinking_options() {
        let directory = tempfile::tempdir().unwrap();
        let client = client(directory.path());
        let (result, request) = served(
            &client,
            "qianwenai",
            "new-profile",
            "simulated-catalog-key",
            "200 OK",
            "",
            br#"{"data":[{"id":"qwen-plus"},{"id":"embedding-v3"}]}"#,
        );
        let result = result.unwrap();
        assert!(request.starts_with("GET /models HTTP/1.1"));
        assert!(
            request
                .to_lowercase()
                .contains("authorization: bearer simulated-catalog-key")
        );
        assert_eq!(
            result["baseUrl"],
            "https://maas.qianwenaiapi.com/compatible-mode/v1"
        );
        assert_eq!(result["models"].as_array().unwrap().len(), 2);
        assert!(
            result["models"]
                .as_array()
                .unwrap()
                .iter()
                .all(|model| model.get("reasoningOptions").is_none())
        );
        let platform = parse_catalog(
            br#"{"data":[{"id":"qwen3.8-flash"},{"id":"qwen3.8-flash-unknown"},{"id":"qwen-plus"}]}"#,
            "qianwenai", "",
        ).unwrap();
        let supported = platform
            .iter()
            .find(|row| row["id"] == "qwen3.8-flash")
            .unwrap();
        assert_eq!(
            supported["reasoningOptions"]
                .as_array()
                .unwrap()
                .iter()
                .map(|option| option["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["off", "on"]
        );
        assert!(
            platform
                .iter()
                .filter(|row| row["id"] != "qwen3.8-flash")
                .all(|row| row.get("reasoningOptions").is_none())
        );
        assert!(!result.to_string().contains("simulated-catalog-key"));
        assert!(result["catalogToken"].is_string());
        let known = parse_catalog(
            br#"{"data":[{"id":"qwen-plus"},{"id":"new-model"}]}"#,
            "bailian",
            "",
        )
        .unwrap();
        assert!(
            known.iter().find(|row| row["id"] == "qwen-plus").unwrap()["reasoningOptions"]
                .is_array()
        );
        assert!(
            known
                .iter()
                .find(|row| row["id"] == "new-model")
                .unwrap()
                .get("reasoningOptions")
                .is_none()
        );
    }

    #[test]
    fn catalog_failure_rejects_redirect_empty_duplicate_malformed_and_oversize_without_echoing_secrets()
     {
        let directory = tempfile::tempdir().unwrap();
        let client = client(directory.path());
        for (status, headers, body) in [
            (
                "302 Found",
                "Location: http://127.0.0.1:1/leak\r\n",
                b"simulated-secret".to_vec(),
            ),
            (
                "401 Unauthorized",
                "",
                b"simulated-secret private-provider-error".to_vec(),
            ),
            ("200 OK", "", b"<html>simulated-secret</html>".to_vec()),
            ("200 OK", "", br#"{"data":[]}"#.to_vec()),
            (
                "200 OK",
                "",
                br#"{"data":[{"id":"same"},{"id":"same"}]}"#.to_vec(),
            ),
            ("200 OK", "", br#"{"data":[{"id":7}]}"#.to_vec()),
            (
                "200 OK",
                "",
                br#"{"data":[{"id":"simulated-secret"}]}"#.to_vec(),
            ),
            ("200 OK", "", vec![b'x'; MAX_BYTES as usize + 1]),
        ] {
            let error = served(
                &client,
                "qianwenai",
                "new-profile",
                "simulated-secret",
                status,
                headers,
                &body,
            )
            .0
            .unwrap_err();
            assert_eq!(error.code, "model_catalog_error");
            assert!(!error.message.contains("simulated-secret"));
            assert!(!error.message.contains("private-provider-error"));
            assert!(!error.message.contains("127.0.0.1"));
        }
    }

    #[test]
    fn discovery_never_borrows_active_or_other_provider_keys_and_rejects_custom_urls() {
        let directory = tempfile::tempdir().unwrap();
        let mut client = client(directory.path());
        client.profiles.push(ModelProfile {
            id: "existing-deepseek".into(),
            name: "DeepSeek".into(),
            base_url: "https://api.deepseek.com".into(),
            model: "deepseek-flash".into(),
            reasoning_effort: None,
            api_key: "simulated-deepseek".into(),
            protected_key: String::new(),
            warning: None,
        });
        for input in [
            json!({"provider":"qianwenai"}),
            json!({"provider":"qianwenai","profileId":"existing-deepseek"}),
            json!({"provider":"deepseek","profileId":"new"}),
        ] {
            assert_eq!(
                client.list_models(&input).unwrap_err().code,
                "not_configured"
            );
        }
        assert_eq!(client.list_models(&json!({"provider":"qianwenai","apiKey":"simulated-key","baseUrl":"https://attacker.example"})).unwrap_err().code,"invalid_input");
        assert_eq!(
            client
                .list_models(&json!({"provider":"attacker","apiKey":"simulated-key"}))
                .unwrap_err()
                .code,
            "invalid_input"
        );
        assert!(!client.path.exists());
    }

    #[test]
    fn dynamic_model_authorization_binds_provider_profile_actual_key_path_and_list_membership() {
        let directory = tempfile::tempdir().unwrap();
        let client = client(directory.path());
        let token = served(
            &client,
            "qianwenai",
            "new-profile",
            "simulated-catalog-key",
            "200 OK",
            "",
            br#"{"data":[{"id":"new-model"}]}"#,
        )
        .0
        .unwrap()["catalogToken"]
            .clone();
        let item = json!({"id":"new-profile","provider":"qianwenai","model":"new-model","apiKey":"simulated-catalog-key","catalogToken":token});
        assert!(
            client
                .catalog_authorizes(&item, "new-profile", None)
                .unwrap()
        );
        for (field, value) in [
            ("provider", json!("bailian")),
            ("model", json!("unlisted")),
            ("apiKey", json!("different-key")),
            ("catalogToken", json!("forged")),
        ] {
            let mut tampered = item.clone();
            tampered[field] = value;
            assert!(
                !client
                    .catalog_authorizes(&tampered, "new-profile", None)
                    .unwrap()
            );
        }
        assert!(
            !client
                .catalog_authorizes(&item, "other-profile", None)
                .unwrap()
        );
        let other = tempfile::tempdir().unwrap();
        assert!(
            !super::tests::client(other.path())
                .catalog_authorizes(&item, "new-profile", None)
                .unwrap()
        );
        let mut without_provider = item.clone();
        without_provider.as_object_mut().unwrap().remove("provider");
        without_provider["baseUrl"] = json!("https://maas.qianwenaiapi.com/compatible-mode/v1");
        assert!(
            client
                .catalog_authorizes(&without_provider, "new-profile", None)
                .unwrap()
        );
        grants()
            .lock()
            .unwrap()
            .iter_mut()
            .find(|grant| grant.token == token.as_str().unwrap())
            .unwrap()
            .created = Instant::now() - GRANT_LIFETIME;
        assert!(
            !client
                .catalog_authorizes(&item, "new-profile", None)
                .unwrap()
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_canonical_discovery_path_authorizes_normal_path_save_before_settings_exist() {
        let directory = tempfile::tempdir().unwrap();
        let canonical_directory = std::fs::canonicalize(directory.path()).unwrap();
        assert_ne!(
            directory.path(),
            canonical_directory.as_path(),
            "regression requires the Windows canonical path prefix"
        );
        let mut saving = client(directory.path());
        let discovery = client(&canonical_directory);
        assert!(
            !saving.path.exists(),
            "a new profile need not have a settings file yet"
        );
        let (response, request) = served(
            &discovery,
            "qianwenai",
            "new-qianwen-profile",
            "simulated-catalog-key",
            "200 OK",
            "",
            br#"{"data":[{"id":"qwen-catalog-regression"}]}"#,
        );
        let token = response.unwrap()["catalogToken"].clone();
        assert!(request.starts_with("GET /models HTTP/1.1"));
        let profile = json!({"id":"new-qianwen-profile","provider":"qianwenai","model":"qwen-catalog-regression","apiKey":"simulated-catalog-key","catalogToken":token});
        let other_directory = tempfile::tempdir().unwrap();
        let mut other = client(other_directory.path());
        assert!(
            !other
                .catalog_authorizes(&profile, "new-qianwen-profile", None)
                .unwrap()
        );
        assert!(other.save(&json!({"expectedRevision":0,"activeProfileId":"new-qianwen-profile","profiles":[profile.clone()]})).is_err());
        assert!(
            !other.path.exists(),
            "a token must remain bound to its data directory"
        );
        let saved = saving.save(&json!({"expectedRevision":0,"activeProfileId":"new-qianwen-profile","profiles":[profile]}));
        assert!(
            saved.is_ok(),
            "discovery and save use equivalent paths to the same settings file: {saved:?}"
        );
        let saved = saved.unwrap();
        assert_eq!(saved["model"], "qwen-catalog-regression");
        assert_eq!(
            std::fs::canonicalize(&saving.path).unwrap(),
            std::fs::canonicalize(&discovery.path).unwrap()
        );
        assert_eq!(
            ModelClient::open(directory.path()).unwrap().model,
            "qwen-catalog-regression"
        );
    }

    #[test]
    fn dynamic_list_selection_persists_encrypted_and_reopens_without_network_or_catalog_token() {
        let directory = tempfile::tempdir().unwrap();
        let mut client = client(directory.path());
        let token = served(
            &client,
            "qianwenai",
            "new-profile",
            "simulated-catalog-key",
            "200 OK",
            "",
            br#"{"data":[{"id":"qwen-dynamic-chat"}]}"#,
        )
        .0
        .unwrap()["catalogToken"]
            .clone();
        let profile = json!({"id":"new-profile","provider":"qianwenai","model":"qwen-dynamic-chat","apiKey":"simulated-catalog-key","catalogToken":token});
        let mut no_token = profile.clone();
        no_token.as_object_mut().unwrap().remove("catalogToken");
        assert!(client.save(&json!({"expectedRevision":0,"activeProfileId":"new-profile","profiles":[no_token]})).is_err());
        let public = client
            .save(
                &json!({"expectedRevision":0,"activeProfileId":"new-profile","profiles":[profile]}),
            )
            .unwrap();
        assert_eq!(public["model"], "qwen-dynamic-chat");
        assert_eq!(public["profiles"][0]["provider"], "qianwenai");
        assert!(!public.to_string().contains("simulated-catalog-key"));
        assert!(!public.to_string().contains("catalogToken"));
        let bytes = std::fs::read_to_string(&client.path).unwrap();
        assert!(!bytes.contains("simulated-catalog-key"));
        assert!(!bytes.contains(token.as_str().unwrap()));
        let before = std::fs::read(&client.path).unwrap();
        let mut tampered = public["profiles"][0].clone();
        tampered["model"] = json!("not-listed");
        tampered["catalogToken"] = token.clone();
        assert!(client.save(&json!({"expectedRevision":1,"activeProfileId":"new-profile","profiles":[tampered]})).is_err());
        assert_eq!(std::fs::read(&client.path).unwrap(), before);
        assert_eq!(client.public_settings(), public);
        let mut reopened = ModelClient::open(directory.path()).unwrap();
        assert_eq!(reopened.api_key, "simulated-catalog-key");
        let mut old = public["profiles"][0].clone();
        old["name"] = json!("更名");
        reopened
            .save(&json!({"expectedRevision":1,"activeProfileId":"new-profile","profiles":[old]}))
            .unwrap();
        assert_eq!(reopened.model, "qwen-dynamic-chat");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let http = reqwest::Client::new();
            let mut body = json!({"model":reopened.model,"max_tokens":8192});
            compatible_provider_request_options(&mut body, &reopened.base_url, &reopened.model);
            selected_reasoning_request_options(
                &mut body,
                &reopened.base_url,
                &reopened.model,
                None,
            )
            .unwrap();
            let request = model_http_request(&http, &reopened.base_url, &reopened.api_key, &body)
                .build()
                .unwrap();
            assert_eq!(
                request.url().as_str(),
                "https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions"
            );
            assert_eq!(
                request.headers()["authorization"],
                "Bearer simulated-catalog-key"
            );
            assert_eq!(body, json!({"model":"qwen-dynamic-chat","max_tokens":8192}));
            assert!(validate_reasoning_effort(&reopened.base_url, "qwen-plus", "on").is_err());
        });
    }
    #[test]
    fn qianwen_platform_origin_is_exact_and_response_timeout_is_bounded() {
        assert_eq!(
            model_provider("https://maas.qianwenaiapi.com/compatible-mode/v1"),
            Some("qianwenai")
        );
        for base in [
            "http://maas.qianwenaiapi.com/compatible-mode/v1",
            "https://maas.qianwenaiapi.com:8443/compatible-mode/v1",
            "https://maas.qianwenaiapi.com.attacker.example/compatible-mode/v1",
            "https://maas.qianwenaiapi.com/compatible-mode/v1?token=x",
            "https://user@maas.qianwenaiapi.com/compatible-mode/v1",
        ] {
            assert_eq!(model_provider(base), None);
        }
        let directory = tempfile::tempdir().unwrap();
        let client = client(directory.path());
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/models", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = [0; 2048];
            let _ = stream.read(&mut request);
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 200\r\nConnection: close\r\n\r\n");
            thread::sleep(Duration::from_millis(300));
        });
        let started = Instant::now();
        let error = client
            .fetch_catalog_with_timeout(
                "qianwenai",
                "profile",
                "https://maas.qianwenaiapi.com/compatible-mode/v1",
                "simulated-secret",
                &url,
                Duration::from_millis(100),
            )
            .unwrap_err();
        assert_eq!(error.code, "model_catalog_error");
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(!error.message.contains("simulated-secret"));
        assert!(!error.message.contains("127.0.0.1"));
        server.join().unwrap();
    }
}
