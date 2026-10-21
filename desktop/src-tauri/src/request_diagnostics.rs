use crate::error::AppResult;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Instant,
};

/// Keep only the last planning request's counters. Teacher text, model output,
/// provider URLs, credentials and personal identifiers never enter this file.
pub(crate) struct PlanningDiagnostics {
    path: PathBuf,
    started: Instant,
    counters: Value,
}

impl PlanningDiagnostics {
    pub(crate) fn start(
        task: &str,
        settings_path: &Path,
        context: &Value,
        body: &Value,
    ) -> Option<Self> {
        if task != "blueprint" {
            return None;
        }
        Some(Self {
            path: settings_path
                .parent()?
                .join("diagnostics")
                .join("blueprint-last.json"),
            started: Instant::now(),
            counters: json!({
                "schemaVersion": 1,
                "observedAt": chrono::Utc::now().to_rfc3339(),
                "taskCount": context["tasks"].as_array().map(Vec::len),
                "slotCount": context["slots"].as_array().map(Vec::len),
                "requestBytes": serde_json::to_vec(body).ok().map(|bytes| bytes.len()),
                "maxTokens": body["max_tokens"].as_u64(),
                "thinkingDisabled": body["thinking"]["type"] == "disabled",
            }),
        })
    }

    pub(crate) fn response(&mut self, status: u16, response: &Value) {
        self.counters["httpStatus"] = json!(status);
        self.counters["finishReason"] = match response["choices"][0]["finish_reason"].as_str() {
            Some(reason @ ("stop" | "length" | "content_filter" | "tool_calls")) => json!(reason),
            Some(_) => json!("other"),
            None => Value::Null,
        };
        for (name, value) in [
            ("promptTokens", &response["usage"]["prompt_tokens"]),
            ("completionTokens", &response["usage"]["completion_tokens"]),
            ("totalTokens", &response["usage"]["total_tokens"]),
            (
                "reasoningTokens",
                &response["usage"]["completion_tokens_details"]["reasoning_tokens"],
            ),
        ] {
            self.counters[name] = json!(value.as_u64());
        }
    }

    pub(crate) fn finish(&self, result: &AppResult<Value>) {
        let mut counters = self.counters.clone();
        counters["elapsedMs"] = json!(self.started.elapsed().as_millis() as u64);
        counters["success"] = json!(result.is_ok());
        counters["errorCode"] = result
            .as_ref()
            .err()
            .map(|error| json!(error.code))
            .unwrap_or(Value::Null);
        // Diagnostics are best effort and must not turn a completed plan into
        // an error when the local diagnostics directory cannot be written.
        let _ = (|| -> std::io::Result<()> {
            std::fs::create_dir_all(self.path.parent().unwrap())?;
            std::fs::write(&self.path, serde_json::to_vec_pretty(&counters)?)
        })();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;

    #[test]
    fn planning_diagnostics_keep_usage_without_teacher_text_or_provider_output() {
        let directory = tempfile::tempdir().unwrap();
        let settings = directory.path().join("model-settings.json");
        let context = json!({"tasks":[{"label":"private-teacher-text"}],"slots":[{}]});
        let body = json!({"messages":[{"content":"private-request"}],"max_tokens":4096,"thinking":{"type":"disabled"}});
        let mut diagnostic =
            PlanningDiagnostics::start("blueprint", &settings, &context, &body).unwrap();
        diagnostic.response(200, &json!({
            "choices":[{"finish_reason":"length","message":{"content":"private-model-output"}}],
            "usage":{"prompt_tokens":400,"completion_tokens":4096,"total_tokens":4496,
                "completion_tokens_details":{"reasoning_tokens":4096},"unexpected":"private-usage"},
            "error":{"message":"private-provider-error"}
        }));
        diagnostic.finish(&Err(AppError::new(
            "model_output_truncated",
            "private-error-message",
        )));
        let path = directory.path().join("diagnostics/blueprint-last.json");
        let bytes = std::fs::read_to_string(&path).unwrap();
        assert!(!bytes.contains("private-"));
        let saved: Value = serde_json::from_str(&bytes).unwrap();
        assert_eq!(saved["finishReason"], "length");
        assert_eq!(saved["reasoningTokens"], 4096);
        assert_eq!(saved["promptTokens"], 400);
        assert_eq!(saved["slotCount"], 1);
        assert_eq!(saved["errorCode"], "model_output_truncated");
        assert_eq!(saved["success"], false);

        let fresh = PlanningDiagnostics::start("blueprint", &settings, &json!({}), &body).unwrap();
        fresh.finish(&Ok(json!({"slots":[]})));
        let saved: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(saved["success"], true);
        assert_eq!(saved["errorCode"], Value::Null);
        assert!(saved.get("reasoningTokens").is_none());
        assert!(
            PlanningDiagnostics::start("question_import", &settings, &context, &body).is_none()
        );
    }
}
