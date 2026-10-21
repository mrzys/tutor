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
    let cancel = AtomicBool::new(false);
    for line in std::io::stdin().lock().lines() {
        let result = line
            .ok()
            .and_then(|line| serde_json::from_str::<Value>(&line).ok());
        let response = if let Some(input) = result {
            let id = input["id"].clone();
            match runtime.request(
                input["action"].as_str().unwrap_or_default(),
                input.get("payload").unwrap_or(&json!({})),
                &cancel,
            ) {
                Ok(value) => json!({"id":id,"result":value}),
                Err(error) => json!({"id":id,"error":error}),
            }
        } else {
            json!({"error":{"code":"invalid_request","message":"invalid JSON"}})
        };
        println!("{}", response);
        let _ = std::io::stdout().flush();
    }
}
#[cfg(not(debug_assertions))]
fn main() {
    eprintln!("The regression driver is disabled in release builds.");
    std::process::exit(2)
}
