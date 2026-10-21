//! Development-only real-image experiment; never opens either business database.
#[cfg(debug_assertions)]
fn main() {
    use serde_json::{Value, json};
    use std::{path::PathBuf, sync::atomic::AtomicBool};
    use tutor_desktop::model::ModelClient;
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let arg = |key: &str| {
        args.iter()
            .position(|s| s == key)
            .and_then(|i| args.get(i + 1))
            .cloned()
            .ok_or_else(|| format!("missing {key}"))
    };
    let run = (|| -> Result<Value, Box<dyn std::error::Error>> {
        let directory = PathBuf::from(arg("--data-dir")?).canonicalize()?;
        let model = ModelClient::open(&directory)?;
        if !model.configured() {
            return Err("Configure the selected model before reading images".into());
        }
        let pages: Value = serde_json::from_slice(&std::fs::read(arg("--pages")?)?)?;
        let output = PathBuf::from(arg("--output-dir")?).canonicalize()?;
        let audit = output.join("provider-response.json");
        if audit.exists() || output.join("result.json").exists() {
            return Err("Use a fresh output directory; original responses are immutable".into());
        }
        let settings = model.public_settings();
        let metadata = json!({"schemaVersion":1,"kind":"actual_vision_transcription_trial","model":settings["model"],"baseUrl":settings["baseUrl"],"profileId":settings["activeProfileId"],"pages":pages,"startedAt":chrono::Utc::now().to_rfc3339(),"writesBusinessDatabases":false});
        std::fs::write(
            output.join("request-manifest.json"),
            serde_json::to_vec_pretty(&metadata)?,
        )?;
        let instructions=arg("--instructions").unwrap_or_else(|_|"逐页识别这份原卷的全部题目，保留原题顺序和所有小问；只转录，不解题，不猜测，不补写。".into());
        let result = model.vision_trial(&pages, &instructions, &audit, &AtomicBool::new(false));
        let value = match result {
            Ok(v) => json!({"ok":true,"result":v}),
            Err(e) => json!({"ok":false,"error":e}),
        };
        std::fs::write(
            output.join("result.json"),
            serde_json::to_vec_pretty(&value)?,
        )?;
        Ok(
            json!({"ok":value["ok"],"questionCount":value["result"]["questions"].as_array().map_or(0,Vec::len),"error":value["error"],"outputDirectory":output}),
        )
    })();
    match run {
        Ok(v) => println!("{v}"),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1)
        }
    }
}
#[cfg(not(debug_assertions))]
fn main() {
    eprintln!("The vision experiment is disabled in release builds.");
    std::process::exit(2)
}
