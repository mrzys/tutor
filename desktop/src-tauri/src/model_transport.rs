//! Metadata-only, per-attempt diagnostics for explicitly audited imports.
//! The request timeout remains one budget across headers and body, not one per phase.
use crate::error::{AppError, AppResult};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    fs::{File, OpenOptions},
    io::{Seek, SeekFrom, Write},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

fn audit_error() -> AppError {
    AppError::new(
        "model_transport_audit_error",
        "模型传输诊断保存失败，已有内容保留；请检查本地存储。",
    )
}

pub(super) struct TransportAudit {
    file: RefCell<File>,
    data: RefCell<Value>,
    started: Instant,
    phase_started: RefCell<Instant>,
}

impl TransportAudit {
    pub(super) fn start(
        path: &Path,
        task: &str,
        body: &Value,
        timeout_seconds: u64,
    ) -> AppResult<Option<Self>> {
        if !matches!(
            task,
            "question_import"
                | "question_import_materials"
                | "question_import_plan"
                | "question_import_teaching_generation"
                | "question_import_teaching_review"
        ) {
            return Ok(None);
        }
        // Reserve once before HTTP. An old diagnostic must never be overwritten
        // by a replay or by a different attempt reusing the same response path.
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path.with_extension("transport.json"))
            .map_err(|_| audit_error())?;
        let enabled = body
            .get("enable_thinking")
            .and_then(Value::as_bool)
            .or_else(|| match body["thinking"]["type"].as_str() {
                Some("enabled") => Some(true),
                Some("disabled") => Some(false),
                _ => None,
            });
        let now = Instant::now();
        let audit = Self {
            file: RefCell::new(file),
            started: now,
            phase_started: RefCell::new(now),
            data: RefCell::new(json!({
                "schemaVersion":1,"task":task,"startedAt":chrono::Utc::now().to_rfc3339(),
                "requestBytes":serde_json::to_vec(body)?.len(),
                "maxTokens":body.get("max_tokens").or_else(||body.get("max_completion_tokens")).and_then(Value::as_u64),
                "stream":body.get("stream").and_then(Value::as_bool).unwrap_or(false),
                "enableThinking":enabled,"timeoutSeconds":timeout_seconds,"timeoutScope":"entire_http_request",
                "phase":"request_prepared","status":"in_progress","elapsedMs":0,
                "httpStatus":null,"responseBytes":null,"phases":[],"errorCode":null
            })),
        };
        audit.persist()?;
        Ok(Some(audit))
    }

    fn persist(&self) -> AppResult<()> {
        let bytes = serde_json::to_vec_pretty(&*self.data.borrow()).map_err(|_| audit_error())?;
        let mut file = self.file.borrow_mut();
        file.seek(SeekFrom::Start(0)).map_err(|_| audit_error())?;
        file.set_len(0).map_err(|_| audit_error())?;
        file.write_all(&bytes).map_err(|_| audit_error())?;
        file.sync_all().map_err(|_| audit_error())
    }

    fn begin(&self, phase: &str) -> AppResult<()> {
        self.data.borrow_mut()["phase"] = json!(phase);
        *self.phase_started.borrow_mut() = Instant::now();
        self.persist()
    }

    fn network_failure(&self, error: &reqwest::Error) -> AppResult<()> {
        // Typed flags and OS numbers only: never persist error Display/Debug,
        // which can contain endpoints, proxy credentials or provider text.
        let mut source = std::error::Error::source(error);
        let mut os_codes = Vec::new();
        while let Some(cause) = source {
            if let Some(code) = cause.downcast_ref::<std::io::Error>().and_then(|e| e.raw_os_error()) {
                if !os_codes.contains(&code) { os_codes.push(code); }
            }
            source = cause.source();
        }
        self.data.borrow_mut()["networkFailure"] = json!({"isConnect":error.is_connect(),"isTimeout":error.is_timeout(),"isRequest":error.is_request(),"isBody":error.is_body(),"isDecode":error.is_decode(),"osErrorCodes":os_codes});
        self.persist()
    }

    fn phase_done(
        &self,
        phase: &str,
        http_status: Option<u16>,
        bytes: Option<usize>,
    ) -> AppResult<()> {
        let mut data = self.data.borrow_mut();
        data["phases"].as_array_mut().unwrap().push(json!({"phase":phase,"status":"completed","elapsedMs":self.phase_started.borrow().elapsed().as_millis() as u64}));
        if let Some(status) = http_status {
            data["httpStatus"] = json!(status);
        }
        if let Some(count) = bytes {
            data["responseBytes"] = json!(count);
        }
        data["phase"] = json!(if phase == "response_body" {
            "response_complete"
        } else {
            "response_headers_received"
        });
        data["elapsedMs"] = json!(self.started.elapsed().as_millis() as u64);
        drop(data);
        self.persist()
    }

    pub(super) fn finish<T>(&self, result: &AppResult<T>) -> AppResult<()> {
        let mut data = self.data.borrow_mut();
        let status = match result.as_ref().err().map(|e| e.code.as_str()) {
            None => "completed",
            Some("cancelled") => "cancelled",
            Some("model_request_timeout" | "model_response_timeout") => "timeout",
            _ => "failed",
        };
        let phase = data["phase"]
            .as_str()
            .unwrap_or("request_prepared")
            .to_owned();
        if matches!(phase.as_str(), "response_headers" | "response_body") {
            data["phases"].as_array_mut().unwrap().push(json!({"phase":phase,"status":status,"elapsedMs":self.phase_started.borrow().elapsed().as_millis() as u64}));
        }
        data["status"] = json!(status);
        // Error messages, endpoint URLs, response bodies and credentials are
        // deliberately excluded, including provider-supplied error details.
        data["errorCode"] = json!(result.as_ref().err().map(|e| e.code.as_str()));
        data["elapsedMs"] = json!(self.started.elapsed().as_millis() as u64);
        data["finishedAt"] = json!(chrono::Utc::now().to_rfc3339());
        drop(data);
        self.persist()
    }
}

pub(super) async fn send_and_read(
    request: reqwest::RequestBuilder,
    task: &str,
    cancel: &AtomicBool,
    audit: Option<&TransportAudit>,
    timeout_seconds: u64,
) -> AppResult<(reqwest::StatusCode, Vec<u8>)> {
    let operation = async {
        if let Some(audit) = audit {
            audit.begin("response_headers")?;
        }
        let started = Instant::now();
        let response = request.send().await.map_err(|error| {
            if let Some(audit) = audit { if let Err(failure) = audit.network_failure(&error) { return failure; } }
            crate::assembly_log::model_transport(
                task,
                "response_headers",
                started.elapsed().as_millis() as u64,
                None,
                if error.is_timeout() {
                    "timeout"
                } else {
                    "failed"
                },
            );
            super::model_transport_error(&error, "response_headers", timeout_seconds)
        })?;
        let status = response.status();
        crate::assembly_log::model_transport(
            task,
            "response_headers",
            started.elapsed().as_millis() as u64,
            Some(status.as_u16()),
            "completed",
        );
        if let Some(audit) = audit {
            audit.phase_done("response_headers", Some(status.as_u16()), None)?;
        }
        if response
            .content_length()
            .is_some_and(|length| length > 2 * 1024 * 1024)
        {
            return Err(AppError::new("model_error", "模型响应过长。"));
        }
        if let Some(audit) = audit {
            audit.begin("response_body")?;
        }
        let started = Instant::now();
        let bytes = response.bytes().await.map_err(|error| {
            if let Some(audit) = audit { if let Err(failure) = audit.network_failure(&error) { return failure; } }
            crate::assembly_log::model_transport(
                task,
                "response_body",
                started.elapsed().as_millis() as u64,
                Some(status.as_u16()),
                if error.is_timeout() {
                    "timeout"
                } else {
                    "failed"
                },
            );
            super::model_transport_error(&error, "response_body", timeout_seconds)
        })?;
        crate::assembly_log::model_transport(
            task,
            "response_body",
            started.elapsed().as_millis() as u64,
            Some(status.as_u16()),
            "completed",
        );
        if let Some(audit) = audit {
            audit.phase_done("response_body", Some(status.as_u16()), Some(bytes.len()))?;
        }
        if bytes.len() > 2 * 1024 * 1024 {
            return Err(AppError::new("model_error", "模型响应过长。"));
        }
        Ok((status, bytes.to_vec()))
    };
    tokio::select! {
        result=operation=>result,
        _=async { loop { if cancel.load(Ordering::Relaxed){break;} tokio::time::sleep(Duration::from_millis(50)).await; } }=>Err(AppError::new("cancelled","已停止本次操作，已有内容保留。"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_material_supplement_reserves_its_own_transport_audit() {
        let directory=tempfile::tempdir().unwrap();let path=directory.path().join("materials.response.json");
        let audit=TransportAudit::start(&path,"question_import_materials",&json!({"max_tokens":65536,"thinking":{"type":"enabled"}}),120).unwrap().expect("material source task must be audited");
        audit.finish(&Ok::<_,AppError>(())).unwrap();
        let value:Value=serde_json::from_slice(&std::fs::read(path.with_extension("transport.json")).unwrap()).unwrap();
        assert_eq!(value["task"],"question_import_materials");assert_eq!(value["timeoutSeconds"],120);
        assert_eq!(value["enableThinking"],true);assert_eq!(value["status"],"completed");
    }
    #[test]
    fn transport_failure_diagnostics_are_typed_and_never_include_error_urls() {
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address=listener.local_addr().unwrap();drop(listener);
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("typed-network.json");
        let audit=TransportAudit::start(&path,"question_import",&json!({}),120).unwrap().unwrap();
        let runtime=tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let error=runtime.block_on(async {
            reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(2)).build().unwrap()
                .get(format!("http://{address}/private-path-canary?key=credential-canary")).send().await.unwrap_err()
        });
        assert!(error.is_connect() || error.is_timeout() || error.is_request());
        audit.network_failure(&error).unwrap();
        let bytes=std::fs::read(path.with_extension("transport.json")).unwrap();
        let value:Value=serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["networkFailure"]["isConnect"],error.is_connect());
        assert_eq!(value["networkFailure"]["isTimeout"],error.is_timeout());
        assert!(value["networkFailure"]["osErrorCodes"].is_array());
        let text=String::from_utf8(bytes).unwrap();
        for secret in ["private-path-canary","credential-canary","http://","127.0.0.1"] { assert!(!text.contains(secret)); }
    }
    use std::{io::Read, net::TcpListener, sync::Arc};

    fn local_case(phase: &str) -> (Value, AppResult<(reqwest::StatusCode, Vec<u8>)>) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("provider-response.json");
        let cancel = Arc::new(AtomicBool::new(false));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let phase_owned = phase.to_owned();
        let worker_cancel = cancel.clone();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let _ = socket.read(&mut request);
            match phase_owned.as_str() {
                "success" => {
                    socket
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                        .unwrap();
                }
                "response_body" => {
                    socket
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{")
                        .unwrap();
                    socket.flush().unwrap();
                    std::thread::sleep(Duration::from_millis(400));
                }
                "cancelled" => {
                    worker_cancel.store(true, Ordering::Relaxed);
                    std::thread::sleep(Duration::from_millis(100));
                }
                _ => std::thread::sleep(Duration::from_millis(400)),
            }
        });
        let body = json!({"model":"secret-canary-model","messages":[{"content":"private-business-text"}],"enable_thinking":true,"max_tokens":16384});
        let audit = TransportAudit::start(&path, "question_import_teaching_review", &body, 120)
            .unwrap()
            .unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = runtime.block_on(async {
            let client = reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_millis(200))
                .build()
                .unwrap();
            send_and_read(
                client
                    .post(format!("http://{address}/private-endpoint"))
                    .bearer_auth("secret-canary-key")
                    .json(&body),
                "question_import_teaching_review",
                &cancel,
                Some(&audit),
                120,
            )
            .await
        });
        audit.finish(&result).unwrap();
        let text = std::fs::read_to_string(path.with_extension("transport.json")).unwrap();
        assert!(!text.contains("secret-canary"));
        assert!(!text.contains("private-business"));
        assert!(!text.contains("private-endpoint"));
        assert!(!path.exists());
        assert!(!path.with_extension("request.json").exists());
        let data: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(data["timeoutSeconds"], 120);
        assert_eq!(data["timeoutScope"], "entire_http_request");
        assert_eq!(data["stream"], false);
        assert_eq!(data["enableThinking"], true);
        assert_eq!(data["maxTokens"], 16384);
        server.join().unwrap();
        (data, result)
    }

    #[test]
    fn audited_local_http_distinguishes_headers_body_success_and_cancel() {
        for phase in ["response_headers", "response_body", "success", "cancelled"] {
            let (data, result) = local_case(phase);
            match phase {
                "success" => {
                    assert!(result.is_ok());
                    assert_eq!(data["status"], "completed");
                    assert_eq!(data["responseBytes"], 2);
                    assert_eq!(data["phase"], "response_complete");
                    assert_eq!(data["phases"].as_array().unwrap().len(), 2);
                }
                "cancelled" => {
                    assert_eq!(result.unwrap_err().code, "cancelled");
                    assert_eq!(data["status"], "cancelled");
                }
                _ => {
                    assert_eq!(
                        result.unwrap_err().code,
                        if phase == "response_headers" {
                            "model_request_timeout"
                        } else {
                            "model_response_timeout"
                        }
                    );
                    assert_eq!(data["phase"], phase);
                    assert_eq!(data["status"], "timeout");
                }
            }
            if phase == "response_body" {
                assert_eq!(data["httpStatus"], 200);
                assert_eq!(data["phases"][0]["status"], "completed");
            }
            if phase == "response_headers" {
                assert!(data["httpStatus"].is_null());
                assert_eq!(data["phases"].as_array().unwrap().len(), 1);
            }
        }
    }

    #[test]
    fn sidecar_reservation_does_not_overwrite_and_unrelated_tasks_do_not_write() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("response.json");
        std::fs::write(&path, b"existing-response").unwrap();
        std::fs::write(path.with_extension("request.json"), b"existing-request").unwrap();
        let audit =
            TransportAudit::start(&path, "question_import_teaching_review", &json!({}), 120)
                .unwrap()
                .unwrap();
        let before = std::fs::read(path.with_extension("transport.json")).unwrap();
        assert!(
            TransportAudit::start(&path, "question_import_teaching_review", &json!({}), 120)
                .is_err()
        );
        assert_eq!(
            std::fs::read(path.with_extension("transport.json")).unwrap(),
            before
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"existing-response");
        assert_eq!(
            std::fs::read(path.with_extension("request.json")).unwrap(),
            b"existing-request"
        );
        assert!(
            TransportAudit::start(
                &directory.path().join("none.json"),
                "selection",
                &json!({}),
                90
            )
            .unwrap()
            .is_none()
        );
        drop(audit);
        assert_eq!(
            TransportAudit::start(
                &directory.path().join("absent/response.json"),
                "question_import",
                &json!({}),
                120
            )
            .err()
            .unwrap()
            .code,
            "model_transport_audit_error"
        );
    }
}
