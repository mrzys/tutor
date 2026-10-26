//! Shared streaming source transport with one hard wall-clock deadline.
//! Partial *visible* answer text is retained; reasoning text is counted, never stored.
use super::*;

const TASK: &str = "question_import_whole_trial";
const MAX_BYTES: usize = 4 * 1024 * 1024;
// SSE framing and reasoning deltas can exceed the retained answer by orders of
// magnitude. Bound each event/visible answer separately; the wall-clock limit
// remains authoritative over total stream traffic.
const MAX_WIRE_BYTES: usize = 64 * 1024 * 1024;

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
) -> AppError {
    let _ = save(
        &directory.join("network-failure.json"),
        &json!({"phase":phase,"isConnect":error.is_connect(),"isTimeout":error.is_timeout(),"isBody":error.is_body(),"isRequest":error.is_request()}),
    );
    model_transport_error(
        error,
        if phase.ends_with("body") {
            "response_body"
        } else {
            "response_headers"
        },
        deadline_seconds,
    )
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
            None,
        )
    }
    /// Refresh only the selected provider catalog for an explicit source resume.
    /// It shares the source deadline; it never submits a completion request.
    pub(crate) fn source_stage_catalog(&self,directory:&Path,started:Instant,cancel:&AtomicBool)->AppResult<Value> {
        let selected=self.import_role("deepseek","deepseek-flash","low")?;
        let base=valid_endpoint(&selected.base_url)?;
        std::fs::create_dir(directory)?;
        let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build()
            .map_err(|_|AppError::new("model_error","无法校验来源模型目录。"))?;
        runtime.block_on(async {
            let remaining=Duration::from_secs(120).checked_sub(started.elapsed())
                .ok_or_else(||AppError::new("whole_trial_deadline","来源本轮120秒已截止。"))?;
            let deadline=tokio::time::Instant::now()+remaining;
            let op=async {
                let http=reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
                    .connect_timeout(Duration::from_secs(10)).timeout(remaining).build()
                    .map_err(|_|AppError::new("model_error","无法初始化来源模型目录连接。"))?;
                network_event(directory,"GET","/models","started",started.elapsed().as_millis()as u64)?;
                let response=http.get(format!("{base}/models")).bearer_auth(&selected.api_key).send().await
                    .map_err(|e|network_error(directory,"catalog_headers",&e,120))?;
                if !response.status().is_success() {return Err(AppError::new("model_catalog_error","实际模型列表请求失败。"))}
                let bytes=response.bytes().await.map_err(|e|network_error(directory,"catalog_body",&e,120))?;
                if bytes.len()>MAX_BYTES {return Err(AppError::new("model_catalog_error","模型列表过长。"))}
                let list:Value=serde_json::from_slice(&bytes)?;
                let item=list["data"].as_array().and_then(|a|a.iter().find(|x|x["id"]==selected.model))
                    .ok_or_else(||AppError::new("import_model_unavailable","实际列表没有来源整理模型。"))?;
                if item["effort"]["supported_levels"].as_array().is_some_and(|a|!a.iter().any(|v|v=="low")) {
                    return Err(AppError::new("unsupported_effort","实际模型目录不支持来源低思考。"))
                }
                let proof=json!({"verifiedAt":chrono::Utc::now().to_rfc3339(),"provider":"deepseek","selected":item,"credentialBinding":crate::bank::hash_json(&json!([base,selected.api_key]))});
                save(&directory.join("catalog.json"),&proof)?;
                network_event(directory,"GET","/models","completed",started.elapsed().as_millis()as u64)?;
                Ok(proof)
            };
            bounded(op,deadline,cancel).await
        })
    }
    /// Ordinary import source-only transport. Its 120s budget is shared by the
    /// index and every batch, independent of OCR and subsequent teaching work.
    pub(crate) fn propose_source_stage_request(
        &self, context: &Value, prompt: &str, assets: &[Value],
        task: &str, audit_path: &Path, started: Instant, cancel: &AtomicBool,
        catalog_proof: Option<&Value>,
    ) -> AppResult<Value> {
        if !matches!(task, "question_import_plan" | "question_import") {
            return Err(input_error("来源整理阶段无效。"));
        }
        let directory = audit_path.with_extension("stream");
        std::fs::create_dir(&directory)?;
        let outcome = self.source_request_stream(context,prompt,assets,"low",&directory,
            started,cancel,120,task,catalog_proof);
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
        deadline_seconds: u64, task: &str, catalog_proof: Option<&Value>,
    ) -> AppResult<Value> {
        if !matches!(task,"question_import_whole_trial"|"question_import_index_trial"|"question_import_batch_trial") {
            return Err(input_error("来源试验任务无效。"));
        }
        self.source_request_stream(context,prompt,assets,effort,directory,started,cancel,deadline_seconds,task,catalog_proof)
    }
    fn source_request_stream(
        &self, context: &Value, prompt: &str, assets: &[Value], effort: &str,
        directory: &Path, started: Instant, cancel: &AtomicBool,
        deadline_seconds: u64, task: &str, catalog_proof: Option<&Value>,
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
        let selected = self.import_role("deepseek", "deepseek-flash", effort)?;
        #[cfg(not(test))]
        validate_reasoning_effort(&selected.base_url, &selected.model, effort)?;
        #[cfg(test)]
        if !selected.model.starts_with("simulated") { validate_reasoning_effort(&selected.base_url,&selected.model,effort)?; }
        let remaining = Duration::from_secs(deadline_seconds)
            .checked_sub(started.elapsed())
            .ok_or_else(|| {
                AppError::new("whole_trial_deadline", "已达本次整卷硬截止，已强制停止。")
            })?;
        let base = valid_endpoint(&selected.base_url)?;
        // The existing image packer validates original PNGs and excludes paths/secrets.
        let mut context = context.clone();
        context["includeSourcePagesForReview"] = json!(true);
        // The real import role is exactly registered DeepSeek Flash. The local
        // HTTP fixture uses its same image packer capability while retaining a
        // localhost network target; no image integrity check is bypassed.
        let (packing_base,packing_model)=(&base[..],&selected.model[..]);
        #[cfg(test)]
        let (packing_base,packing_model)=if selected.model.starts_with("simulated") {("https://api.deepseek.com","deepseek-flash")}else{(packing_base,packing_model)};
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
        let mut body = trial_body(&context, prompt, content, effort)?;
        body["model"]=json!(selected.model);
        let mut safe = serde_json::to_string(&body)?;
        for secret in selected.diagnostic_secrets() {
            safe = safe.replace(&secret, "[redacted]");
        }
        save(
            &directory.join("request.json"),
            &json!({"schemaVersion":1,"task":task,"redacted":false,"promptSha256":crate::bank::hash_json(&body["messages"][0]["content"]),"bodySha256":crate::bank::hash_json(&body),"body":serde_json::from_str::<Value>(&safe)?,"timeoutSeconds":deadline_seconds,"deadlineScope":"whole_source_action_including_catalog_and_local_preparation"}),
        )?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| AppError::new("model_error", "无法启动试验请求。"))?;
        let mut stream = VisibleStream {
            task: task.to_owned(),
            ..Default::default()
        };
        let result = runtime.block_on(async {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(deadline_seconds).saturating_sub(started.elapsed());
            let http = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10)).timeout(remaining)
                .build().map_err(|_| AppError::new("model_error","无法初始化试验请求。"))?;
            let operation = async {
                let proof = if let Some(proof)=catalog_proof {
                    if proof["provider"]!="deepseek" || proof["selected"]["id"]!=selected.model || proof["credentialBinding"]!=crate::bank::hash_json(&json!([base,selected.api_key])) {
                        return Err(AppError::new("model_catalog_error","批次模型列表凭据不匹配。"));
                    }
                    save(&directory.join("catalog-reused.json"),&json!({"provider":"deepseek","selected":proof["selected"],"verifiedAt":proof["verifiedAt"],"sameAction":true}))?;
                    proof.clone()
                }else{
                    stream.checkpoint(directory, started.elapsed().as_millis() as u64, "catalog", true)?;
                    network_event(directory,"GET","/models","started",started.elapsed().as_millis() as u64)?;
                    let response = http.get(format!("{base}/models")).bearer_auth(&selected.api_key).send().await
                        .map_err(|e| network_error(directory,"catalog_headers",&e,deadline_seconds))?;
                    network_event(directory,"GET","/models","headers",started.elapsed().as_millis() as u64)?;
                    if !response.status().is_success() { return Err(AppError::new("model_catalog_error","实际模型列表请求失败。")); }
                    let bytes = response.bytes().await.map_err(|e| network_error(directory,"catalog_body",&e,deadline_seconds))?;
                    if bytes.len() > MAX_BYTES { return Err(AppError::new("model_catalog_error","模型列表过长。")); }
                    let list: Value = serde_json::from_slice(&bytes).map_err(|_| AppError::new("model_catalog_error","模型列表格式错误。"))?;
                    let item = list["data"].as_array().and_then(|rows|rows.iter().find(|r|r["id"]==selected.model))
                        .ok_or_else(||AppError::new("import_model_unavailable","实际服务商列表未包含DeepSeek Flash。"))?;
                    let proof=json!({"verifiedAt":chrono::Utc::now().to_rfc3339(),"provider":"deepseek","selected":item,"credentialBinding":crate::bank::hash_json(&json!([base,selected.api_key]))});
                    save(&directory.join("catalog.json"),&proof)?;
                    proof
                };
                let item=&proof["selected"];
                if effort!="off" && item["effort"]["supported_levels"].is_array() && !item["effort"]["supported_levels"].as_array().unwrap().iter().any(|v|v==effort) {
                    return Err(AppError::new("unsupported_effort","实际模型列表不支持本次思考档位。"));
                }
                stream.checkpoint(directory, started.elapsed().as_millis() as u64, "response_headers", true)?;
                network_event(directory,"POST","/chat/completions","started",started.elapsed().as_millis() as u64)?;
                let mut response = model_http_request(&http,&base,&selected.api_key,&body).send().await
                    .map_err(|e|network_error(directory,"response_headers",&e,deadline_seconds))?;
                network_event(directory,"POST","/chat/completions","headers",started.elapsed().as_millis() as u64)?;
                save(&directory.join("response-status.json"),&json!({"httpStatus":response.status().as_u16(),"headersMs":started.elapsed().as_millis() as u64}))?;
                if !response.status().is_success() { return Err(AppError::new("model_error",format!("模型返回HTTP {}。",response.status().as_u16()))); }
                let mut received = 0usize;
                while let Some(bytes) = response.chunk().await.map_err(|e|network_error(directory,"response_body",&e,deadline_seconds))? {
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
            &json!({"schemaVersion":1,"task":task,"effort":effort,"stream":true,"maxTokens":65536,"maxStreamWireBytes":MAX_WIRE_BYTES,"maxRetainedVisibleBytes":MAX_BYTES,"timeoutSeconds":deadline_seconds,"elapsedMs":started.elapsed().as_millis() as u64,"status":if result.is_ok(){"completed"}else{"failed"},"errorCode":result.as_ref().err().map(|e|e.code.as_str()),"progress":stream.progress(started.elapsed().as_millis() as u64,"terminal")}),
        )?;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
