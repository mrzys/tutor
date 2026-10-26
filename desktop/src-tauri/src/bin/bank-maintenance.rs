//! Development maintenance entry point; never included in the desktop bundle.
#[cfg(debug_assertions)]
fn reserve_teaching_report(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    if !path.extension().and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("json")) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput,
            "Teaching report must be a new .json file"));
    }
    // create_new refuses every existing target, including symlinks. Retain this
    // handle through the transaction so a report can never overwrite a DB,
    // original input, or another report after the bank has already changed.
    std::fs::OpenOptions::new().write(true).create_new(true).open(path)
}

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
        if matches!(command,"review-candidate-adopt"|"review-bank-snapshot"|"review-bank-publish"|"review-agent-acknowledge"|"review-agent-patch"|"review-source-trial-stage") {
            // User-authorized maintenance: source imports live in an isolated
            // runtime; only the named existing bank is opened at its real root.
            // Never open Store::open(real_root) or its personal.sqlite.
            let bank_directory = PathBuf::from(value("--bank-dir").ok_or("--bank-dir is required")?).canonicalize()?;
            if directory == bank_directory || !directory.join("explicit-publication-runtime.json").is_file() {
                return Err("A separately marked isolated import runtime is required".into());
            }
            let marker:Value=serde_json::from_slice(&std::fs::read(directory.join("explicit-publication-runtime.json"))?)?;
            if marker["purpose"]!="user_authorized_teaching_publication" || marker["formalPersonalDatabaseOpened"]!=false {
                return Err("Invalid isolated publication runtime marker".into());
            }
            let bank_path=bank_directory.join("question-bank.sqlite").canonicalize()?;
            let readonly=rusqlite::Connection::open_with_flags(&bank_path,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            let schema:String=readonly.query_row("SELECT value FROM bank_metadata WHERE key='schema_version'",[],|r|r.get(0))?;
            if schema!="1" {return Err("Unsupported existing bank schema".into());}
            drop(readonly);
            let bank=tutor_desktop::bank::LocalQuestionBank::open(&bank_path,&json!({"schemaVersion":1,"config":{},"questions":[]}))?;
            let user=rusqlite::Connection::open(directory.join("personal.sqlite").canonicalize()?)?;
            user.busy_timeout(std::time::Duration::from_secs(5))?;
            let store=Store{user,bank,data_dir:directory.clone(),bank_warning:None};
            let mut report_file=reserve_teaching_report(std::path::Path::new(&value("--report").ok_or("--report is required")?))?;
            let mut retained_source=Value::Null;
            let result=if command=="review-bank-snapshot" {
                imports::agent_review::snapshot(&store,&value("--import").ok_or("--import is required")?)?
            } else {
                let file=value("--manifest").ok_or("--manifest is required")?;
                if std::fs::metadata(&file)?.len()>32*1024*1024 {return Err("Review manifest exceeds32MB".into());}
                let payload:Value=serde_json::from_slice(&std::fs::read(file)?)?;
                if command=="review-bank-publish" {
                    use sha2::{Digest,Sha256};
                    let import_id=payload["reviewReport"]["importId"].as_str().ok_or("Missing import identity")?;
                    let record=store.document("imports",import_id)?;
                    let relative=format!("imports/{import_id}/source.pdf");
                    if record["source"]["extension"]!="pdf"||record["source"]["relativePath"]!=relative {
                        return Err("Publication original must be the bound saved PDF".into());
                    }
                    let source_path=directory.join(&relative).canonicalize()?;
                    if !source_path.starts_with(directory.join("imports").canonicalize()?) {return Err("Original escaped source runtime".into());}
                    let bytes=std::fs::read(&source_path)?;
                    let digest=format!("{:x}",Sha256::digest(&bytes));
                    if record["source"]["sha256"]!=digest {return Err("Original PDF hash changed".into());}
                    let target=bank_directory.join(&relative);
                    std::fs::create_dir_all(target.parent().ok_or("Invalid source target")?)?;
                    if !target.parent().unwrap().canonicalize()?.starts_with(&bank_directory) {return Err("Original target escaped bank root".into());}
                    if target.exists() {
                        if std::fs::read(&target)?!=bytes {return Err("Existing original differs; nothing overwritten".into());}
                    } else {
                        let mut original=std::fs::OpenOptions::new().write(true).create_new(true).open(&target)?;
                        std::io::Write::write_all(&mut original,&bytes)?;original.sync_all()?;
                    }
                    retained_source=json!({"path":target,"sha256":digest,"originalBytesUnchanged":true});
                }
                match command {
                    "review-source-trial-stage"=>imports::source_trial_adoption::stage(&store,&payload)?,
                    "review-candidate-adopt"=>imports::teaching_adoption::adopt(&store,&payload)?,
                    "review-agent-acknowledge"=>imports::acknowledge_teaching_by_agent(&store,&payload,&AtomicBool::new(false))?,
                    "review-agent-patch"=>imports::patch_teaching_by_agent(&store,&payload,&AtomicBool::new(false))?,
                    _=>imports::agent_review::publish(&store,&payload,&AtomicBool::new(false))?,
                }
            };
            let output=json!({"result":result,"sourceRuntime":directory,"bankPath":bank_path,
                "retainedSource":retained_source,"formalPersonalDatabaseOpened":false,"modelCalls":0});
            std::io::Write::write_all(&mut report_file,&serde_json::to_vec_pretty(&output)?)?;
            report_file.sync_all()?;
            println!("{}",json!({"reportWritten":true,"formalPersonalDatabaseOpened":false,"modelCalls":0}));
            return Ok(());
        }
        if matches!(command, "teaching-apply" | "teaching-focus-normalize") {
            // This command updates only an existing question bank. Do not open
            // Store/personal.sqlite or apply packaged seed/supplement migrations.
            let report = value("--report").ok_or("--report is required")?;
            let mut report_file = reserve_teaching_report(std::path::Path::new(&report))?;
            let manifest = if command == "teaching-apply" {
                let manifest_file = value("--manifest").ok_or("--manifest is required")?;
                if std::fs::metadata(&manifest_file)?.len() > 128 * 1024 * 1024 {
                    return Err("Teaching manifest exceeds 128 MB".into());
                }
                Some(serde_json::from_slice::<Value>(&std::fs::read(
                    &manifest_file,
                )?)?)
            } else {
                None
            };
            let bank_path = directory.join("question-bank.sqlite").canonicalize()?;
            let readonly = rusqlite::Connection::open_with_flags(
                &bank_path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )?;
            let version: String = readonly.query_row(
                "SELECT value FROM bank_metadata WHERE key='schema_version'",
                [],
                |r| r.get(0),
            )?;
            if version != "1" {
                return Err("Existing bank schema is unsupported; no maintenance applied".into());
            }
            drop(readonly);
            // With schema_version=1 and no migration/snapshot seed fields,
            // LocalQuestionBank::open does not initialize or migrate content.
            let bank = tutor_desktop::bank::LocalQuestionBank::open(
                &bank_path,
                &json!({"schemaVersion":1,"config":{},"questions":[]}),
            )?;
            let mut receipt = match manifest {
                Some(manifest) => tutor_desktop::bank_teaching::apply(&bank, &manifest)?,
                None => tutor_desktop::bank_teaching::normalize_focus(&bank)?,
            };
            receipt["dataDirectory"] = json!(directory);
            receipt["bankPath"] = json!(bank_path);
            receipt["openedWithoutBundledMigrations"] = json!(true);
            receipt["personalDatabaseOpened"] = json!(false);
            std::io::Write::write_all(&mut report_file, &serde_json::to_vec_pretty(&receipt)?)?;
            report_file.sync_all()?;
            println!("{}", receipt);
            return Ok(());
        }
        let model = ModelClient::open(&directory)?;
        if command == "inspect" {
            let settings = model.public_settings();
            println!(
                "{}",
                json!({"dataDirectory":directory,"configured":settings["configured"],"model":settings["model"],"profileId":settings["activeProfileId"]})
            );
            return Ok(());
        }
        if command == "teaching-review-candidates" {
            let manifest_path = value("--manifest").ok_or("--manifest is required")?;
            let output_path = value("--output-dir").ok_or("--output-dir is required")?;
            if std::fs::metadata(&manifest_path)?.len() > 32 * 1024 * 1024 {
                return Err("Review candidate manifest exceeds 32 MB".into());
            }
            let manifest: Value = serde_json::from_slice(&std::fs::read(&manifest_path)?)?;
            let summary = imports::review_saved_teaching_candidates(&model, &manifest, std::path::Path::new(&output_path), &AtomicBool::new(false))?;
            println!("{}",json!({"operationId":summary["operationId"],"completed":summary["results"].as_array().map_or(0,Vec::len),"outputDirectory":output_path,"databaseOpened":false}));
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
            if command == "import-teaching-retry" {
                use std::io::Write;
                let report = value("--report").ok_or("--report is required")?;
                let mut report_file = reserve_teaching_report(std::path::Path::new(&report))?;
                if args.iter().any(|arg| matches!(arg.as_str(), "--file" | "--bundle")) {
                    return Err("Teaching retry only reuses its preserved questions; --file and --bundle are not allowed".into());
                }
                let targets = value("--question-ids").ok_or("--question-ids is required")?;
                if std::fs::metadata(&targets)?.len() > 64 * 1024 { return Err("Question identity list exceeds 64 KB".into()); }
                let ids: Value = serde_json::from_slice(&std::fs::read(targets)?)?;
                let payload = json!({"importId":import_id.ok_or("--import is required")?,
                    "expectedRevision":value("--expected-revision").ok_or("--expected-revision is required")?.parse::<u64>()?,
                    "operationId":value("--operation").ok_or("--operation is required")?,"questionIds":ids});
                let result = imports::retry_failed_teaching(&store, &model, &payload, &cancel)?;
                report_file.write_all(&serde_json::to_vec_pretty(&result["import"])?)?;
                report_file.sync_all()?;
                println!("{}", json!({"import":brief(&result["import"]),"replayed":result["replayed"]}));
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
    use super::{reserve_teaching_report, upload_payload};

    #[test]
    fn teaching_report_reservation_refuses_database_paths_and_existing_files() {
        let directory = tempfile::tempdir().unwrap();
        for name in ["question-bank.sqlite", "personal.sqlite", "existing.json", "existing.JSON"] {
            let file = directory.path().join(name);
            std::fs::write(&file, b"SIMULATED_ORIGINAL_DO_NOT_OVERWRITE").unwrap();
            assert!(reserve_teaching_report(&file).is_err());
            assert_eq!(std::fs::read(&file).unwrap(), b"SIMULATED_ORIGINAL_DO_NOT_OVERWRITE");
        }
        for name in ["absent-bank.sqlite", "absent-personal.sqlite", "report", "report.json.sqlite"] {
            let file = directory.path().join(name);
            assert!(reserve_teaching_report(&file).is_err());
            assert!(!file.exists());
        }
        let file = directory.path().join("new-report.JSON");
        let mut reserved = reserve_teaching_report(&file).unwrap();
        assert!(reserve_teaching_report(&file).is_err());
        std::io::Write::write_all(&mut reserved, b"{\"simulated\":true}").unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"{\"simulated\":true}");
    }

    #[test]
    fn teaching_report_reservation_refuses_symlinks() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("personal.sqlite");
        std::fs::write(&target, b"SIMULATED_PERSONAL_DB").unwrap();
        let link = directory.path().join("report.json");
        #[cfg(windows)]
        let created = std::os::windows::fs::symlink_file(&target, &link);
        #[cfg(unix)]
        let created = std::os::unix::fs::symlink(&target, &link);
        if let Err(error) = created {
            // Windows hosts without Developer Mode may deny symlink creation;
            // the regular existing-target assertion above still always runs.
            assert!(error.kind() == std::io::ErrorKind::PermissionDenied
                || cfg!(windows) && error.raw_os_error() == Some(1314),
                "unexpected symlink creation failure: {error}");
            return;
        }
        assert!(reserve_teaching_report(&link).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"SIMULATED_PERSONAL_DB");
    }

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
