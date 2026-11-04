//! Shared streaming source transport with one hard wall-clock deadline.
//! Partial *visible* answer text is retained; reasoning text is counted, never stored.
use super::*;

const TASK: &str = "question_import_whole_trial";
const MAX_BYTES: usize = 4 * 1024 * 1024;
// SSE framing and reasoning deltas can exceed the retained answer by orders of
// magnitude. Bound each event/visible answer separately; the wall-clock limit
// remains authoritative over total stream traffic.
const MAX_WIRE_BYTES: usize = 64 * 1024 * 1024;
const CONNECT_TIMEOUT_SECONDS: u64 = 10;

async fn bounded<T>(
    operation: impl std::future::Future<Output = AppResult<T>>,
    deadline: tokio::time::Instant,
    cancel: &AtomicBool,
) -> AppResult<T> {
    tokio::select! {
        result=tokio::time::timeout_at(deadline,operation)=>result.unwrap_or_else(|_|Err(AppError::new("whole_trial_deadline","已达本次整卷处理硬截止，已强制停止。"))),
        _=async {loop {if cancel.load(Ordering::Relaxed){break;}tokio::time::sleep(Duration::from_millis(25)).await;}}=>Err(AppError::new("cancelled","已停止本次整卷试验。")),
    }
}

fn network_event(
    directory: &Path,
    method: &str,
    path: &str,
    state: &str,
    elapsed_ms: u64,
) -> AppResult<()> {
    let target = directory.join("network-events.json");
    let mut events: Vec<Value> = if target.exists() {
        serde_json::from_slice(&std::fs::read(&target)?)?
    } else {
        vec![]
    };
    events.push(json!({"method":method,"path":path,"state":state,"elapsedMs":elapsed_ms,"at":chrono::Utc::now().to_rfc3339()}));
    save(&target, &json!(events))
}

fn network_error(
    directory: &Path,
    phase: &str,
    error: &reqwest::Error,
    deadline_seconds: u64,
    started: Instant,
) -> AppError {
    let _ = save(
        &directory.join("network-failure.json"),
        &json!({"phase":phase,"isConnect":error.is_connect(),"isTimeout":error.is_timeout(),"isBody":error.is_body(),"isRequest":error.is_request(),"connectTimeoutSeconds":CONNECT_TIMEOUT_SECONDS,"stageBudgetSeconds":deadline_seconds,"elapsedMs":started.elapsed().as_millis() as u64}),
    );
    let mut mapped = model_transport_error(
        error,
        if phase.ends_with("body") {
            "response_body"
        } else {
            "response_headers"
        },
        deadline_seconds,
    );
    // Retain historical catalogue diagnostic mapping. New source execution
    // never requests a catalogue or enters these catalogue phases.
    if phase.starts_with("catalog_") {
        mapped.message = if error.is_timeout() && error.is_connect() {
            format!("获取模型列表时连接超时（连接上限 {CONNECT_TIMEOUT_SECONDS} 秒；来源阶段总预算 {deadline_seconds} 秒），尚未收到列表；请检查网络后显式重试。")
        } else if error.is_timeout() && phase.ends_with("body") {
            format!("读取模型列表超时（来源阶段总预算 {deadline_seconds} 秒），已有材料保留，请显式重试。")
        } else if error.is_timeout() {
            format!("等待模型列表响应超时（来源阶段总预算 {deadline_seconds} 秒），已有材料保留，请显式重试。")
        } else if phase.ends_with("body") {
            "模型列表读取中断，已有材料保留，请显式重试。".into()
        } else {
            "模型列表连接失败，请检查网络后显式重试；已有材料保留。".into()
        };
    } else if error.is_timeout() && error.is_connect() {
        mapped.message = format!(
            "连接模型服务超时（连接上限 {CONNECT_TIMEOUT_SECONDS} 秒；来源阶段总预算 {deadline_seconds} 秒），尚未收到响应；已完成批次保留，请显式继续。"
        );
    }
    mapped
}

fn save(path: &Path, value: &Value) -> AppResult<()> {
    let mut file = std::fs::File::create(path)?;
    file.write_all(&serde_json::to_vec_pretty(value)?)?;
    Ok(())
}

fn trial_body(context: &Value, prompt: &str, content: Value, effort: &str) -> AppResult<Value> {
    if !matches!(effort, "off" | "low" | "high" | "max") {
        return Err(input_error("整卷试验思考档位无效。"));
    }
    let mut body = json!({"model":"deepseek-flash","messages":[{"role":"system","content":prompt},{"role":"user","content":content}],"response_format":{"type":"json_object"},"stream":true,"stream_options":{"include_usage":true},"max_tokens":65536});
    selected_reasoning_request_options(
        &mut body,
        "https://api.deepseek.com",
        "deepseek-flash",
        Some(effort),
    )?;
    // Equal cap for every arm: do not accidentally give off an 8K answer limit.
    body["max_tokens"] = json!(65536);
    let _ = context;
    Ok(body)
}

pub(super) fn configured_source_body(selected: &ModelClient, prompt: &str, content: Value, task: &str) -> AppResult<Value> {
    let mut body = json!({"model":selected.model,"messages":[{"role":"system","content":prompt},{"role":"user","content":content}],"response_format":{"type":"json_object"},"stream":true,"stream_options":{"include_usage":true},"max_tokens":16000});
    compatible_provider_request_options(&mut body, &selected.base_url, &selected.model);
    selected_reasoning_request_options(&mut body, &selected.base_url, &selected.model, selected.reasoning_effort.as_deref())?;
    import_thinking_output_budget(&mut body, task, &selected.base_url, &selected.model);
    Ok(body)
}

#[derive(Default)]
struct VisibleStream {
    task: String,
    pending: Vec<u8>,
    visible: String,
    reasoning_chars: usize,
    events: usize,
    done: bool,
    finish: Option<String>,
    usage: Value,
    first_event_ms: Option<u64>,
    first_visible_ms: Option<u64>,
    last_saved_len: usize,
    last_saved_ms: u64,
}
impl VisibleStream {
    fn feed(&mut self, bytes: &[u8], elapsed_ms: u64, secret: &str) -> AppResult<()> {
        self.pending.extend_from_slice(bytes);
        if self.pending.len() > MAX_BYTES {
            return Err(AppError::new("model_error", "流式事件过长。"));
        }
        while let Some(pos) = self.pending.iter().position(|b| *b == b'\n') {
            let line = self.pending.drain(..=pos).collect::<Vec<_>>();
            let line = std::str::from_utf8(&line)
                .map_err(|_| AppError::new("model_stream_invalid", "流式事件编码无效。"))?
                .trim();
            let Some(data) = line.strip_prefix("data:").map(str::trim) else {
                continue;
            };
            if data == "[DONE]" {
                self.done = true;
                continue;
            }
            if data.is_empty() {
                continue;
            }
            let event: Value = serde_json::from_str(data)
                .map_err(|_| AppError::new("model_stream_invalid", "流式事件JSON无效。"))?;
            if event.get("error").is_some_and(|e| !e.is_null()) {
                return Err(AppError::new(
                    "model_error",
                    "模型流返回错误，已保存可见进度。",
                ));
            }
            self.events += 1;
            self.first_event_ms.get_or_insert(elapsed_ms);
            if !event["usage"].is_null() {
                self.usage = event["usage"].clone();
            }
            if let Some(choices) = event["choices"].as_array() {
                for choice in choices {
                    if choice["index"].as_u64().unwrap_or(0) != 0 {
                        continue;
                    }
                    if let Some(reasoning) = choice["delta"]["reasoning_content"].as_str() {
                        self.reasoning_chars += reasoning.chars().count();
                    }
                    if let Some(text) = choice["delta"]["content"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                    {
                        self.first_visible_ms.get_or_insert(elapsed_ms);
                        self.visible.push_str(&if secret.is_empty() {
                            text.to_owned()
                        } else {
                            text.replace(secret, "[redacted]")
                        });
                    }
                    if let Some(finish) = choice["finish_reason"].as_str() {
                        self.finish = Some(finish.into());
                    }
                }
            }
            if self.visible.len() > MAX_BYTES {
                return Err(AppError::new("model_error", "可见输出过长。"));
            }
        }
        Ok(())
    }
    fn response(&self) -> Value {
        json!({"choices":[{"index":0,"finish_reason":self.finish,"message":{"content":self.visible}}],"usage":self.usage})
    }
    fn progress(&self, elapsed_ms: u64, phase: &str) -> Value {
        json!({"schemaVersion":1,"task":if self.task.is_empty(){TASK}else{self.task.as_str()},"phase":phase,"elapsedMs":elapsed_ms,"events":self.events,"firstEventMs":self.first_event_ms,"firstVisibleTokenMs":self.first_visible_ms,"visibleChars":self.visible.chars().count(),"visibleBytes":self.visible.len(),"reasoningCharsReceived":self.reasoning_chars,"reasoningTextStored":false,"finishReason":self.finish,"usage":self.usage,"streamDone":self.done})
    }
    fn checkpoint(
        &mut self,
        directory: &Path,
        elapsed_ms: u64,
        phase: &str,
        force: bool,
    ) -> AppResult<()> {
        if force
            || self.visible.len().saturating_sub(self.last_saved_len) >= 2048
            || elapsed_ms.saturating_sub(self.last_saved_ms) >= 1000
        {
            std::fs::write(directory.join("partial-visible.txt"), &self.visible)?;
            save(
                &directory.join("stream-progress.json"),
                &self.progress(elapsed_ms, phase),
            )?;
            self.last_saved_len = self.visible.len();
            self.last_saved_ms = elapsed_ms;
        }
        Ok(())
    }
}

impl ModelClient {
    pub(super) fn source_stage_model(&self, task: &str) -> AppResult<Self> {
        if task == "question_import_plan" { self.import_source_index_model() }
        else { self.import_source_model() }
    }
    #[cfg(debug_assertions)]
    pub(crate) fn whole_transcription_trial(
        &self,
        context: &Value,
        prompt: &str,
        assets: &[Value],
        effort: &str,
        directory: &Path,
        started: Instant,
        cancel: &AtomicBool,
        deadline_seconds: u64,
    ) -> AppResult<Value> {
        self.index_batch_source_request(
            context,
            prompt,
            assets,
            effort,
            directory,
            started,
            cancel,
            deadline_seconds,
            TASK,
        )
    }
    /// Ordinary import source-only transport. Its 120s budget is shared by the
    /// index and every batch, independent of OCR and subsequent teaching work.
    pub(crate) fn propose_source_stage_request(
        &self, context: &Value, prompt: &str, assets: &[Value],
        task: &str, audit_path: &Path, started: Instant, cancel: &AtomicBool,
    ) -> AppResult<Value> {
        if !matches!(task, "question_import_plan" | "question_import") {
            return Err(input_error("来源整理阶段无效。"));
        }
        let directory = audit_path.with_extension("stream");
        std::fs::create_dir(&directory)?;
        let outcome = self.source_request_stream(context,prompt,assets,"low",&directory,
            started,cancel,120,task);
        // Keep the established response/request receipt shape for publication
        // replay. Failed/truncated provider responses are preserved, not adopted.
        for (from,to) in [(directory.join("request.json"),audit_path.with_extension("request.json")),
                          (directory.join("response.json"),audit_path.to_path_buf())] {
            if from.is_file() {
                let bytes=std::fs::read(from)?;
                // Publish the complete receipt atomically: a crash while copying
                // cannot leave a half root file hiding the intact stream copy.
                let temp=to.with_file_name(format!("{}.receipt-tmp",uuid::Uuid::new_v4()));
                let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
                file.write_all(&bytes)?;file.sync_all()?;drop(file);
                let linked=std::fs::hard_link(&temp,&to);let _=std::fs::remove_file(&temp);linked?;
            }
        }
        outcome
    }
    #[cfg(debug_assertions)]
    pub(crate) fn index_batch_source_request(
        &self, context: &Value, prompt: &str, assets: &[Value], effort: &str,
        directory: &Path, started: Instant, cancel: &AtomicBool,
        deadline_seconds: u64, task: &str,
    ) -> AppResult<Value> {
        if !matches!(task,"question_import_whole_trial"|"question_import_index_trial"|"question_import_batch_trial") {
            return Err(input_error("来源试验任务无效。"));
        }
        self.source_request_stream(context,prompt,assets,effort,directory,started,cancel,deadline_seconds,task)
    }
    fn source_request_stream(
        &self, context: &Value, prompt: &str, assets: &[Value], effort: &str,
        directory: &Path, started: Instant, cancel: &AtomicBool,
        deadline_seconds: u64, task: &str,
    ) -> AppResult<Value> {
        if !matches!(
            task,
            "question_import_whole_trial"
                | "question_import_index_trial"
                | "question_import_batch_trial"
                | "question_import_plan" | "question_import"
        ) {
            return Err(input_error("来源试验任务无效。"));
        }
        if !matches!(deadline_seconds, 60 | 120) {
            return Err(input_error("整卷试验硬截止仅支持明确授权的60或120秒。"));
        }
        let formal = matches!(task,"question_import_plan"|"question_import");
        let selected = if formal { self.source_stage_model(task)? }
            else { self.import_role("deepseek", "deepseek-flash", effort)? };
        let saved_effort = selected.reasoning_effort.as_deref();
        #[cfg(not(test))]
        if let Some(effort)=saved_effort { validate_reasoning_effort(&selected.base_url, &selected.model, effort)?; }
        #[cfg(test)]
        if !selected.model.starts_with("simulated") { if let Some(effort)=saved_effort { validate_reasoning_effort(&selected.base_url,&selected.model,effort)?; } }
        let remaining = Duration::from_secs(deadline_seconds)
            .checked_sub(started.elapsed())
            .ok_or_else(|| {
                AppError::new("whole_trial_deadline", "已达本次整卷硬截止，已强制停止。")
            })?;
        let base = valid_endpoint(&selected.base_url)?;
        // The existing image packer validates original PNGs and excludes paths/secrets.
        let mut context = context.clone();
        context["includeSourcePagesForReview"] = json!(true);
        // Use only verified image capabilities of the selected source model.
        // The local HTTP fixture retains the same image validation while using
        // a localhost transport destination.
        let (packing_base,packing_model)=(&base[..],&selected.model[..]);
        #[cfg(test)]
        let (packing_base,packing_model)=if selected.model.starts_with("simulated") {("https://api.deepseek.com","deepseek-flash")}else{(packing_base,packing_model)};
        if !assets.is_empty() && !supports_import_images(packing_base,packing_model) {
            return Err(AppError::new("source_image_unsupported","拆题用途所选模型尚未确认支持原页图片，请更换拆题配置；原件、OCR及成功结果已保留。"));
        }
        let mut content =
            request_user_content("question_import", packing_base, packing_model, &context, assets)?;
        if let Some(blocks) = content.as_array_mut() {
            for (index, asset) in assets.iter().enumerate() {
                if let Some(label) = blocks.get_mut(1 + 2 * index) {
                    label["text"] =
                        json!({"assetId":asset["id"],"page":asset["page"],"ocrRole":asset["role"]})
                            .to_string()
                            .into();
                }
            }
        }
        let mut body = if formal && self.import_source_role_explicit() {
            configured_source_body(&selected,prompt,content,task)?
        } else { trial_body(&context, prompt, content, effort)? };
        body["model"]=json!(selected.model);
        let mut safe = serde_json::to_string(&body)?;
        for secret in selected.diagnostic_secrets() {
            safe = safe.replace(&secret, "[redacted]");
        }
        save(
            &directory.join("request.json"),
            &json!({"schemaVersion":1,"task":task,"redacted":false,"sourceModelIdentity":{"profileId":selected.active_profile_id,"model":selected.model,"baseUrl":base,"reasoningEffort":selected.reasoning_effort,"selectionSource":"saved_configuration","catalogueCheckPerformed":false},"promptSha256":crate::bank::hash_json(&body["messages"][0]["content"]),"bodySha256":crate::bank::hash_json(&body),"body":serde_json::from_str::<Value>(&safe)?,"timeoutSeconds":deadline_seconds,"deadlineScope":"whole_source_action_including_local_preparation"}),
        )?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| AppError::new("model_error", "无法启动试验请求。"))?;
        let mut stream = VisibleStream {
            task: task.to_owned(),
            ..Default::default()
        };
        let mut accuracy_source = super::model_accuracy::SourceBudgetGuard::begin(
            &selected, task, &body, deadline_seconds, &directory.join("response.json"),
        )?;
        let result = runtime.block_on(async {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(deadline_seconds).saturating_sub(started.elapsed());
            let http = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECONDS)).timeout(remaining)
                .build().map_err(|_| AppError::new("model_error","无法初始化试验请求。"))?;
            let operation = async {
                // Execute the saved model directly; model-list availability does not gate work.
                stream.checkpoint(directory, started.elapsed().as_millis() as u64, "response_headers", true)?;
                network_event(directory,"POST","/chat/completions","started",started.elapsed().as_millis() as u64)?;
                let mut response = model_http_request(&http,&base,&selected.api_key,&body).send().await
                    .map_err(|e|network_error(directory,"response_headers",&e,deadline_seconds,started))?;
                network_event(directory,"POST","/chat/completions","headers",started.elapsed().as_millis() as u64)?;
                save(&directory.join("response-status.json"),&json!({"httpStatus":response.status().as_u16(),"headersMs":started.elapsed().as_millis() as u64}))?;
                if !response.status().is_success() { return Err(AppError::new("model_error",format!("模型返回HTTP {}。",response.status().as_u16()))); }
                let mut received = 0usize;
                while let Some(bytes) = response.chunk().await.map_err(|e|network_error(directory,"response_body",&e,deadline_seconds,started))? {
                    received += bytes.len();
                    if received > MAX_WIRE_BYTES {return Err(AppError::new("model_error","模型流超过试验字节预算。"));}
                    stream.feed(&bytes,started.elapsed().as_millis() as u64,&selected.api_key)?;
                    stream.checkpoint(directory,started.elapsed().as_millis() as u64,"response_body",false)?;
                }
                if !stream.done { return Err(AppError::new("model_stream_incomplete","响应流中断，没有完整结束标记。")); }
                let response = stream.response();
                save(&directory.join("response.json"),&json!({"schemaVersion":1,"httpStatus":200,"choices":response["choices"],"usage":response["usage"]}))?;
                if stream.finish.as_deref()!=Some("stop") {
                    return Err(AppError::new(if stream.finish.as_deref()==Some("length"){"model_output_truncated"}else{"model_stream_incomplete"},"模型未以stop完整结束，可见内容已保留，未采纳半份结果。"));
                }
                parse_model_output(&response)
            };
            bounded(operation,deadline,cancel).await
        });
        stream.checkpoint(
            directory,
            started.elapsed().as_millis() as u64,
            if result.is_ok() {
                "completed"
            } else {
                "stopped"
            },
            true,
        )?;
        save(
            &directory.join("transport.json"),
            &json!({"schemaVersion":1,"task":task,"effort":if formal {saved_effort}else{Some(effort)},"stream":true,"maxTokens":body.get("max_tokens").or_else(||body.get("max_completion_tokens")),"maxStreamWireBytes":MAX_WIRE_BYTES,"maxRetainedVisibleBytes":MAX_BYTES,"timeoutSeconds":deadline_seconds,"elapsedMs":started.elapsed().as_millis() as u64,"status":if result.is_ok(){"completed"}else{"failed"},"errorCode":result.as_ref().err().map(|e|e.code.as_str()),"progress":stream.progress(started.elapsed().as_millis() as u64,"terminal")}),
        )?;
        if let Some(guard) = accuracy_source.as_mut() { guard.finish(&result)?; }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_catalog_actual_transport_errors_keep_codes_and_distinguish_connect_headers_body() {
        use std::{io::Read, net::TcpListener, sync::mpsc};
        for (tls_stall, send_headers, phase, expected_code, expected_connect, message) in [
            (true, false, "catalog_headers", "model_request_timeout", true, "连接上限 10 秒"),
            (false, false, "catalog_headers", "model_request_timeout", false, "等待模型列表响应超时"),
            (false, true, "catalog_body", "model_response_timeout", false, "读取模型列表超时"),
            (true, false, "response_headers", "model_request_timeout", true, "已完成批次保留"),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let (stop, stopped) = mpsc::channel::<()>();
            let server = std::thread::spawn(move || {
                let (mut connection, _) = listener.accept().unwrap();
                connection.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                let mut request = [0; 2048];
                let _ = connection.read(&mut request);
                if send_headers {
                    connection.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1024\r\nConnection: close\r\n\r\n{").unwrap();
                }
                // Hold the TLS handshake, response headers, or incomplete body
                // until the actual client's corresponding timeout fires.
                let _ = stopped.recv_timeout(Duration::from_secs(4));
            });
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            let started = Instant::now();
            let error = runtime.block_on(async {
                let http = reqwest::Client::builder().no_proxy()
                    .connect_timeout(if tls_stall {Duration::from_millis(150)} else {Duration::from_secs(10)})
                    .timeout(if tls_stall {Duration::from_secs(3)} else {Duration::from_millis(150)})
                    .build().unwrap();
                let request = http.get(format!("{}://{address}/models?fixture-private=1", if tls_stall {"https"} else {"http"}));
                if send_headers {
                    request.send().await.unwrap().bytes().await.unwrap_err()
                } else {
                    request.send().await.unwrap_err()
                }
            });
            let _ = stop.send(());
            server.join().unwrap();
            assert!(error.is_timeout());
            assert_eq!(error.is_connect(), expected_connect, "{phase}");
            let directory = tempfile::tempdir().unwrap();
            let mapped = network_error(directory.path(), phase, &error, 120, started);
            assert_eq!(mapped.code, expected_code);
            assert_eq!(mapped.code, model_transport_error(&error, if send_headers {"response_body"} else {"response_headers"}, 120).code);
            assert!(mapped.message.contains(message));
            assert!(mapped.message.contains("来源阶段总预算 120 秒"));
            assert!(!mapped.message.contains("fixture-private"));
            let failure_text = std::fs::read_to_string(directory.path().join("network-failure.json")).unwrap();
            let failure: Value = serde_json::from_str(&failure_text).unwrap();
            assert_eq!(failure["phase"], phase);
            assert_eq!(failure["isConnect"], expected_connect);
            assert_eq!(failure["connectTimeoutSeconds"], 10);
            assert_eq!(failure["stageBudgetSeconds"], 120);
            assert!(failure["elapsedMs"].as_u64().unwrap() > 0);
            assert!(!failure_text.contains("fixture-private"));
        }
    }
    #[test]
    fn configured_source_unknown_image_support_stops_before_any_request() {
        let temp=tempfile::tempdir().unwrap();
        let mut model=ModelClient::test_client(temp.path(),"http://127.0.0.1:1");
        model.profiles=vec![ModelProfile{id:"source".into(),name:"模拟拆题".into(),base_url:"https://maas.qianwenaiapi.com/compatible-mode/v1".into(),model:"qwen3.8-flash".into(),reasoning_effort:Some("on".into()),api_key:"simulated-key".into(),protected_key:String::new(),warning:None}];
        model.import_roles=model_roles::ImportRoles::parse(&json!({"sourceParsing":"source","teachingGeneration":null,"teachingReview":null}),&model.profiles).unwrap();
        let path=temp.path().join("source");std::fs::create_dir(&path).unwrap();
        let error=model.source_request_stream(&json!({}),"JSON",&[json!({"role":"source_page"})],"low",&path,Instant::now(),&AtomicBool::new(false),120,"question_import_plan").unwrap_err();
        assert_eq!(error.code,"source_image_unsupported");
        assert!(!path.join("network-events.json").exists());
        assert!(!path.join("request.json").exists());
    }
    #[test]
    fn configured_source_preserves_provider_and_saved_thinking_without_trial_override() {
        let temp=tempfile::tempdir().unwrap();
        let mut selected=ModelClient::test_client(temp.path(),"http://127.0.0.1:1");
        selected.base_url="https://maas.qianwenaiapi.com/compatible-mode/v1".into();
        selected.model="qwen3.8-flash".into();
        selected.reasoning_effort=Some("off".into());
        let body=configured_source_body(&selected,"JSON",json!("text"),"question_import").unwrap();
        assert_eq!(body["model"],"qwen3.8-flash");
        assert_eq!(body["enable_thinking"],false);
        assert!(body.get("thinking").is_none());
        assert!(body.get("reasoning_effort").is_none());
        assert_eq!(body["max_tokens"],16000);
        selected.reasoning_effort=Some("on".into());
        assert_eq!(configured_source_body(&selected,"JSON",json!("text"),"question_import").unwrap()["enable_thinking"],true);
        selected.reasoning_effort=None;
        assert!(configured_source_body(&selected,"JSON",json!("text"),"question_import").unwrap().get("enable_thinking").is_none());
        selected.base_url="https://api.deepseek.com".into();selected.model="deepseek-flash".into();
        selected.reasoning_effort=Some("max".into());
        let body=configured_source_body(&selected,"JSON",json!("text"),"question_import_plan").unwrap();
        assert_eq!(body["reasoning_effort"],"max");assert_eq!(body["max_tokens"],65536);
    }
    #[test]
    fn whole_trial_all_arms_equal_budget_with_actual_distinct_switches() {
        for effort in ["off", "low", "high", "max"] {
            let body = trial_body(&json!({}), "JSON", json!("text"), effort).unwrap();
            assert_eq!(body["max_tokens"], 65536);
            assert_eq!(body["stream"], true);
            assert_eq!(
                body["thinking"]["type"],
                if effort == "off" {
                    "disabled"
                } else {
                    "enabled"
                }
            );
            if effort != "off" {
                assert_eq!(body["reasoning_effort"], effort);
            } else {
                assert!(body.get("reasoning_effort").is_none());
            }
        }
        assert!(trial_body(&json!({}), "JSON", json!(""), "medium").is_err());
    }
    #[test]
    fn whole_trial_stream_keeps_split_utf8_and_visible_only() {
        let mut stream = VisibleStream::default();
        let input = concat!(
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"private thought\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"{\\\"题\\\":1}\"},\"finish_reason\":\"stop\"}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"total_tokens\":8}}\n\ndata: [DONE]\n\n"
        );
        for bytes in input.as_bytes().chunks(2) {
            stream.feed(bytes, 12, "").unwrap();
        }
        assert!(stream.done);
        assert_eq!(stream.visible, "{\"题\":1}");
        assert_eq!(stream.reasoning_chars, 15);
        assert_eq!(
            parse_model_output(&stream.response()).unwrap(),
            json!({"题":1})
        );
        let directory = tempfile::tempdir().unwrap();
        stream
            .checkpoint(directory.path(), 12, "complete", true)
            .unwrap();
        assert!(
            !std::fs::read_to_string(directory.path().join("stream-progress.json"))
                .unwrap()
                .contains("private thought")
        );
    }
    #[test]
    fn whole_trial_stream_never_accepts_truncated_json() {
        let mut stream = VisibleStream::default();
        stream.feed(b"data: {\"choices\":[{\"delta\":{\"content\":\"{\\\"q\\\":\"},\"finish_reason\":\"length\"}]}\n\ndata: [DONE]\n",3,"").unwrap();
        assert_eq!(
            parse_model_output(&stream.response()).unwrap_err().code,
            "model_output_truncated"
        );
    }
    #[test]
    fn whole_trial_hard_deadline_stops_an_actual_dripping_http_stream() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut connection, _) = listener.accept().unwrap();
            connection
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut b = [0; 2048];
            let _ = connection.read(&mut b);
            if connection.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").is_err(){return;}
            for _ in 0..20 {
                if connection
                    .write_all(b"data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n")
                    .is_err()
                {
                    break;
                }
                std::thread::sleep(Duration::from_millis(40));
            }
        });
        let cancel = AtomicBool::new(false);
        let started = Instant::now();
        let mut stream = VisibleStream::default();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = runtime.block_on(async {
            let operation = async {
                let mut response = reqwest::Client::builder()
                    .no_proxy()
                    .build()
                    .unwrap()
                    .get(format!("http://{address}"))
                    .send()
                    .await
                    .unwrap();
                while let Some(chunk) = response.chunk().await.unwrap() {
                    stream.feed(&chunk, started.elapsed().as_millis() as u64, "")?;
                }
                Ok(())
            };
            bounded(
                operation,
                tokio::time::Instant::now() + Duration::from_millis(180),
                &cancel,
            )
            .await
        });
        assert_eq!(result.unwrap_err().code, "whole_trial_deadline");
        assert!(started.elapsed() < Duration::from_millis(600));
        assert!(!stream.visible.is_empty());
        assert!(!stream.done);
        let dir = tempfile::tempdir().unwrap();
        stream.checkpoint(dir.path(), 180, "stopped", true).unwrap();
        assert!(
            !std::fs::read_to_string(dir.path().join("partial-visible.txt"))
                .unwrap()
                .is_empty()
        );
        server.join().unwrap();
    }
}
