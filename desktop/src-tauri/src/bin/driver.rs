//! Debug-only, stdio JSON adapter for real Rust integration/browser regressions.
//! No TCP port, no browser mock storage, never part of the desktop installer.
#[cfg(debug_assertions)]
fn main() {
    use serde_json::{Value, json};
    use std::io::{BufRead, Write};
    use std::sync::atomic::AtomicBool;
    let Some(path) = std::env::var_os("TUTOR_DESKTOP_DATA_DIR") else {
        eprintln!("TUTOR_DESKTOP_DATA_DIR must name an isolated test directory");
        std::process::exit(2)
    };
    let mut runtime = match tutor_desktop::Runtime::open(std::path::Path::new(&path)) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("{}", e);
            std::process::exit(1)
        }
    };
    let diagnostic_directory = std::path::PathBuf::from(&path);
    let cancel = std::sync::Arc::new(AtomicBool::new(false));
    fn output(response: &Value) {
        let mut stdout = std::io::stdout().lock();
        let _ = writeln!(stdout, "{response}");
        let _ = stdout.flush();
    }
    let _import_subscription = match tutor_desktop::import_events::subscribe(
        std::path::Path::new(&path),
        |payload| output(&json!({"event":"import_progress","payload":payload})),
    ) {
        Ok(subscription) => subscription,
        Err(error) => { eprintln!("{error}"); std::process::exit(1) }
    };
    let (sender, receiver) = std::sync::mpsc::channel::<Value>();
    let worker_cancel = cancel.clone();
    let worker = std::thread::spawn(move || {
        for input in receiver {
            let id = input["id"].clone();
            let run_id = input["payload"]["runId"]
                .as_str()
                .filter(|id| uuid::Uuid::parse_str(id).is_ok())
                .unwrap_or_default()
                .to_owned();
            let channel = tutor_desktop::workflow_progress_channel(
                input["action"].as_str().unwrap_or_default(),
            );
            let result = tutor_desktop::workflow_progress::observe(
                move |step, status| {
                    if let Some(channel) = channel.filter(|_| !run_id.is_empty()) {
                        output(
                            &json!({"event":channel.replace('-', "_"),"payload":{"runId":run_id,"step":step,"status":status}}),
                        );
                    }
                },
                || {
                    runtime.request(
                        input["action"].as_str().unwrap_or_default(),
                        input.get("payload").unwrap_or(&json!({})),
                        &worker_cancel,
                    )
                },
            );
            output(&match result {
                Ok(value) => json!({"id":id,"result":value}),
                Err(error) => json!({"id":id,"error":error}),
            });
        }
    });
    for line in std::io::stdin().lock().lines() {
        let result = line
            .ok()
            .and_then(|line| serde_json::from_str::<Value>(&line).ok());
        if let Some(input) = result {
            if tutor_desktop::assembly_log::is_developer_action(input["action"].as_str().unwrap_or_default()) {
                let result = tutor_desktop::assembly_log::developer_request(&diagnostic_directory, input["action"].as_str().unwrap_or_default(), input.get("payload").unwrap_or(&json!({}))).unwrap();
                output(&match result { Ok(value) => json!({"id":input["id"],"result":value}), Err(error) => json!({"id":input["id"],"error":error}) });
                continue;
            }
            if input["action"] == "__cancel" {
                cancel.store(true, std::sync::atomic::Ordering::Relaxed);
                output(&json!({"id":input["id"],"result":{}}));
            } else {
                if tutor_desktop::resets_workflow_cancel(input["action"].as_str().unwrap_or_default()) {
                    cancel.store(false, std::sync::atomic::Ordering::Relaxed);
                }
                if sender.send(input).is_err() {
                    break;
                }
            }
        } else {
            output(&json!({"error":{"code":"invalid_request","message":"invalid JSON"}}));
        }
    }
    drop(sender);
    let _ = worker.join();
}
#[cfg(not(debug_assertions))]
fn main() {
    eprintln!("The regression driver is disabled in release builds.");
    std::process::exit(2)
}
