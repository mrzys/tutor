//! Development maintenance entry point; never included in the desktop bundle.
#[cfg(debug_assertions)]
fn upload_payload(
    configured: bool,
    file: &std::path::Path,
    operation: &str,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    use base64::Engine;
    // Match the desktop upload boundary: configuration must precede even
    // inspecting or reading the selected file. Do not accept legacy bundles.
    if !configured {
        return Err("Configure the local LLM before importing papers".into());
    }
    let filename = file
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("The upload filename must be valid UTF-8")?;
    if std::fs::metadata(file)?.len() > 15 * 1024 * 1024 {
        return Err("Uploaded paper exceeds 15 MB".into());
    }
    let bytes = std::fs::read(file)?;
    Ok(serde_json::json!({
        "filename": filename,
        "contentBase64": base64::engine::general_purpose::STANDARD.encode(bytes),
        "operationId": operation,
    }))
}

#[cfg(debug_assertions)]
fn main() {
    use serde_json::{Value, json};
    use std::{path::PathBuf, sync::atomic::AtomicBool};
    use tutor_desktop::{annotations, imports, model::ModelClient, storage::Store};
    let args: Vec<String> = std::env::args().skip(1).collect();
    let value = |key: &str| {
        args.iter()
            .position(|arg| arg == key)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let Some(directory) = value("--data-dir") else {
        eprintln!("--data-dir must identify the intended local application directory");
        std::process::exit(2);
    };
    let command = args.first().map(String::as_str).unwrap_or("inspect");
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let directory = PathBuf::from(directory).canonicalize()?;
        let model = ModelClient::open(&directory)?;
        if command == "inspect" {
            let settings = model.public_settings();
            println!(
                "{}",
                json!({"dataDirectory":directory,"configured":settings["configured"],"model":settings["model"],"profileId":settings["activeProfileId"]})
            );
            return Ok(());
        }
        let seed: Value = serde_json::from_str(include_str!("../../../resources/seed.json"))?;
        let mut store = Store::open(&directory, &seed)?;
        let cancel = AtomicBool::new(false);
        if command.starts_with("import-") {
            let brief = |record: &Value| {
                let questions = record["questions"].as_array().cloned().unwrap_or_default();
                json!({"importId":record["importId"],"filename":record["filename"],"revision":record["revision"],"status":record["status"],"total":questions.len(),"succeeded":questions.iter().filter(|q|q["annotationStatus"]=="succeeded").count(),"pending":questions.iter().filter(|q|q["annotationStatus"]=="pending").count(),"failed":questions.iter().filter(|q|q["annotationStatus"]=="failed").count(),"sourceIssueQuestions":questions.iter().filter(|q|q["sourceIssues"].as_array().is_some_and(|a|!a.is_empty())).count(),"duplicateQuestions":questions.iter().filter(|q|q["duplicateCandidates"].as_array().is_some_and(|a|!a.is_empty())).count(),"published":record["publishedQuestionIds"].as_array().map_or(0,Vec::len)})
            };
            let import_id = value("--import");
            if command=="import-agent-manual-snapshot" {
                let file=value("--question-ids").ok_or("--question-ids is required")?;
                let ids:Value=serde_json::from_slice(&std::fs::read(file)?)?;
                let snapshot=store.bank.agent_manual_only_snapshot(&ids)?;
                if let Some(report)=value("--report") {std::fs::write(report,serde_json::to_vec_pretty(&snapshot)?)?;}
                println!("{}",snapshot);return Ok(());
            }
            if command=="import-agent-manual-only" {
                let file=value("--review-report").ok_or("--review-report is required")?;
                if std::fs::metadata(&file)?.len()>4*1024*1024 {return Err("Review report exceeds 4 MB".into());}
                let review:Value=serde_json::from_slice(&std::fs::read(file)?)?;
                let result=store.bank.restrict_agent_to_manual(value("--operation").as_deref().ok_or("--operation is required")?,&review)?;
                if let Some(report)=value("--report") {std::fs::write(report,serde_json::to_vec_pretty(&result)?)?;}
                println!("{}",result);return Ok(());
            }
            if command=="import-agent-snapshot" {
                let snapshot=imports::agent_review::snapshot(&store,import_id.as_deref().ok_or("--import is required")?)?;
                if let Some(report)=value("--report") {std::fs::write(report,serde_json::to_vec_pretty(&snapshot)?)?;}
                println!("{}",snapshot);
                return Ok(());
            }
            if command=="import-agent-publish" {
                let file=value("--review-report").ok_or("--review-report is required")?;
                if std::fs::metadata(&file)?.len()>4*1024*1024 {return Err("Review report exceeds 4 MB".into());}
                let review:Value=serde_json::from_slice(&std::fs::read(file)?)?;
                let response=imports::agent_review::publish(&store,&json!({"operationId":value("--operation").ok_or("--operation is required")?,"reviewReport":review}),&cancel)?;
                println!("{}",json!({"import":brief(&response["import"]),"publication":response["publication"]}));
                if let Some(report)=value("--report") {std::fs::write(report,serde_json::to_vec_pretty(&response)?)?;}
                return Ok(());
            }
            let (action, payload) = match command {
                "import-upload" => {
                    // The report is required so successful and failed parsed
                    // records both remain inspectable outside stdout.
                    value("--report").ok_or("--report is required for an uploaded paper")?;
                    let file = value("--file").ok_or("--file is required")?;
                    let operation = value("--operation").ok_or("--operation is required")?;
                    ("import_prepare", upload_payload(model.configured(), std::path::Path::new(&file), &operation)?)
                },
                "import-retry" => {
                    value("--report").ok_or("--report is required for an import retry")?;
                    if args.iter().any(|arg| matches!(arg.as_str(), "--file" | "--bundle")) {
                        return Err("Import retry only reuses its preserved original; --file and --bundle are not allowed".into());
                    }
                    // Exact UI retry payload. The normal domain entry point
                    // checks model configuration, revision and existing review
                    // content before reading the preserved original.
                    ("import_prepare", json!({
                        "importId": import_id.ok_or("--import is required")?,
                        "expectedRevision": value("--expected-revision").ok_or("--expected-revision is required")?.parse::<u64>()?,
                        "operationId": value("--operation").ok_or("--operation is required")?,
                    }))
                },
                "import-prepare" | "import-source-refresh" => {
                    // Gate before even reading/parsing the uploaded source bundle.
                    if command=="import-prepare" && !model.configured() { return Err("Configure the local LLM before importing papers".into()); }
                    let bundle_path = value("--bundle").ok_or("--bundle is required")?;
                    if std::fs::metadata(&bundle_path)?.len() > 64 * 1024 * 1024 {return Err("Bundle exceeds 64 MB".into());}
                    let bundle: Value = serde_json::from_slice(&std::fs::read(bundle_path)?)?;
                    let mut payload=json!({"operationId":value("--operation").ok_or("--operation is required")?,"bundle":bundle});
                    if command=="import-source-refresh" {
                        payload["importId"]=json!(import_id.ok_or("--import is required")?);
                        payload["expectedRevision"]=json!(value("--expected-revision").ok_or("--expected-revision is required")?.parse::<u64>()?);
                    }
                    (if command=="import-prepare" {"import_structured_prepare"} else {"import_structured_source_refresh"},payload)
                },
                "import-list" => ("imports_list",json!({})),
                "import-get" | "import-run" => ("import_get",json!({"importId":import_id.ok_or("--import is required")?})),
                "import-step" => ("import_structured_step",json!({"importId":import_id.ok_or("--import is required")?,"expectedRevision":value("--expected-revision").ok_or("--expected-revision is required")?.parse::<u64>()?,"operationId":value("--operation").ok_or("--operation is required")?})),
                _ => return Err("unsupported import command".into()),
            };
            let response = imports::dispatch(&mut store,&model,action,&payload,&cancel)?.ok_or("missing import action")?;
            if command == "import-list" {println!("{}",response);return Ok(());}
            let mut record = response["import"].clone();
            println!("{}",brief(&record));
            if command == "import-run" {
                let maximum = value("--limit").unwrap_or_else(||"40".into()).parse::<usize>()?;
                let prefix = value("--operation").ok_or("--operation is required for a resumable run")?;
                let retry_failed = args.iter().any(|a|a=="--retry-failed");
                // Each invocation makes at most one pass over its initial targets.
                // A new explicit invocation can retry failed metadata batches.
                let pending = record["questions"].as_array().map_or(0,|qs|qs.iter().filter(|q|q["annotationStatus"]=="pending").count());
                let remaining = if retry_failed {record["questions"].as_array().map_or(0,|qs|qs.iter().filter(|q|q["annotationStatus"]!="succeeded").count())} else {pending};
                for _ in 0..maximum.min(remaining.div_ceil(5)) {
                    let revision=record["revision"].as_u64().ok_or("missing revision")?;
                    let response=imports::dispatch(&mut store,&model,"import_structured_step",&json!({"importId":record["importId"],"expectedRevision":revision,"operationId":format!("{prefix}-r{revision}")}),&cancel)?.ok_or("missing import step")?;
                    record=response["import"].clone();
                    println!("{}",brief(&record));
                    if let Some(report)=value("--report") {std::fs::write(report,serde_json::to_vec_pretty(&record)?)?;}
                }
            }
            if let Some(report)=value("--report") {std::fs::write(report,serde_json::to_vec_pretty(&record)?)?;}
            return Ok(());
        }
        let mut payload = json!({"mode":value("--mode").unwrap_or_else(||"full".into())});
        if let Some(file) = value("--question-ids") {
            payload["questionIds"] = serde_json::from_slice(&std::fs::read(file)?)?;
        } else if let Some(book) = value("--textbook") {
            payload["textbookId"] = json!(book);
        }
        if let Some(file) = value("--review-notes") {
            payload["reviewNotes"] = serde_json::from_slice(&std::fs::read(file)?)?;
        }
        let job_id = value("--job");
        if let Some(id) = &job_id {
            payload["jobId"] = json!(id);
        }
        let action = match command {
            "preview" => {
                payload["dryRun"] = json!(true);
                "bank_annotation_start"
            }
            "start" => {
                payload["operationId"] =
                    json!(value("--operation").ok_or("--operation is required")?);
                "bank_annotation_start"
            }
            "resume" => "bank_annotation_resume",
            "pause" => "bank_annotation_cancel",
            "list" => "bank_annotation_list",
            "get" | "run" => "bank_annotation_get",
            _ => return Err("unsupported command".into()),
        };
        let response = annotations::dispatch(&mut store, action, &payload, &cancel)?
            .ok_or("missing maintenance action")?;
        let brief = |job: &Value| json!({"jobId":job["jobId"],"status":job["status"],"total":job["total"],"completed":job["completed"],"failed":job["failed"],"pending":job["pending"]});
        if command == "run" {
            let maximum = value("--limit")
                .unwrap_or_else(|| "10000".into())
                .parse::<usize>()?;
            let mut job = response["job"].clone();
            println!("{}", brief(&job));
            for _ in 0..maximum {
                if job["pending"].as_u64().unwrap_or(0) == 0 || job["status"] == "cancelled" {
                    break;
                }
                let step = annotations::dispatch(
                    &mut store,
                    "bank_annotation_step",
                    &json!({"jobId":job["jobId"]}),
                    &cancel,
                )?
                .ok_or("missing step")?;
                job = step["job"].clone();
                println!("{}", brief(&job));
            }
            if let Some(report) = value("--report") {
                std::fs::write(report, serde_json::to_vec_pretty(&job)?)?;
            }
        } else if response["job"].is_object() {
            println!("{}", brief(&response["job"]));
            if let Some(report) = value("--report") {
                std::fs::write(report, serde_json::to_vec_pretty(&response["job"])?)?;
            }
        } else {
            println!("{}", response);
        }
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
#[cfg(not(debug_assertions))]
fn main() {
    eprintln!("Development bank maintenance is disabled in release builds.");
    std::process::exit(2);
}

#[cfg(all(test, debug_assertions))]
mod tests {
    use super::upload_payload;

    #[test]
    fn upload_configuration_gate_precedes_file_access() {
        let directory = tempfile::tempdir().unwrap();
        let missing_file = directory.path().join("not-present.pdf");
        let error = upload_payload(false, &missing_file, "simulation-upload").unwrap_err();
        assert_eq!(error.to_string(), "Configure the local LLM before importing papers");
        assert!(!missing_file.exists());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[test]
    fn uploaded_file_uses_the_exact_ui_payload_without_legacy_fields() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("模拟试卷.pdf");
        std::fs::write(&file, b"%PDF-simulation").unwrap();
        let payload = upload_payload(true, &file, "simulation-upload").unwrap();
        assert_eq!(payload, serde_json::json!({
            "filename": "模拟试卷.pdf",
            "contentBase64": "JVBERi1zaW11bGF0aW9u",
            "operationId": "simulation-upload"
        }));
    }
}
