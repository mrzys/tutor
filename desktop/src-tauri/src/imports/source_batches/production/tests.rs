//! Real isolated HTTP/SSE simulations, not model-quality or teacher evidence.
use super::*;
use std::{
    net::{TcpListener, TcpStream},
    sync::Arc,
};
#[test]
fn source_prompt_optional_correction_is_on_the_same_real_transcription_request() {
    let prompt=batch_prompt();
    for required in ["correction:","corrected_pending_confirmation","ocr_transcription|transcription_adjustment",
        "fieldPath","sourceBlockId","evidencePage","ocrText","transcribedText","review仍须needs_review"] {
        assert!(prompt.contains(required),"missing optional source correction contract: {required}");
    }
    assert!(prompt.contains("不冒称独立数学核验"));
}
fn fixture() -> (tempfile::TempDir, Store, Value, OcrDocument) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path(), &crate::bank::tests::seed()).unwrap();
    let id = "simulated-production-source";
    std::fs::create_dir_all(store.data_dir.join("imports").join(id)).unwrap();
    let mut png = Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(12, 16)
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    let bytes = png.into_inner();
    let mut blocks=(1..=4).map(|n|json!({"id":n,"type":"text","order":n,"text":format!("{n}. 模拟原题，计算1+1。"),"bbox":[0,0,12,3]})).collect::<Vec<_>>();
    blocks.push(json!({"id":5,"type":"text","order":5,"text":"参考答案：1.2；2.2；3.2；4.2","bbox":[0,4,12,8]}));
    let d = OcrDocument {
        pages: vec![
            json!({"page":1,"width":12,"height":16,"blocks":blocks,"text":"1.模拟\n2.模拟\n3.模拟\n4.模拟\n参考答案：1.2；2.2；3.2；4.2"}),
        ],
        assets: vec![
            json!({"id":"simulated-original-page","page":1,"role":"source_page","mimeType":"image/png","width":12,"height":16,"sha256":sha(&bytes),"contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes)}),
        ],
        issues: vec![],
    };
    let r = json!({"importId":id,"filename":"模拟原卷.pdf","revision":0,"status":"processing","questions":[],"source":{"sha256":"simulated-source-hash","physicalPages":1},"ocrSource":{"manifestSha256":"simulated-manifest-hash"},"extractedPages":[d.pages[0]["text"]],"sourceIssues":[],"operations":[]});
    store.put_document("imports", id, &r).unwrap();
    (dir, store, r, d)
}

#[test]
fn source_thinking_checkpoint_freezes_new_stages_and_never_migrates_old_successes() {
    let (dir,store,mut record,_document)=fixture();
    let mut model=ModelClient::test_client(dir.path(),"http://127.0.0.1:1/v1");
    let setting=|effort:&str|json!({"profileId":"processor","provider":"deepseek","model":"deepseek-flash","reasoningEffort":effort});
    let mut thinking=json!({"sourceIndexing":setting("low"),"sourceParsing":setting("high"),"teachingGeneration":setting("high"),"teachingReview":null});
    model.save(&json!({"expectedRevision":0,"profiles":[{"id":"processor","name":"模拟处理","baseUrl":"https://api.deepseek.com","model":"deepseek-flash","apiKey":"simulated-processing-key"}],"activeProfileId":"processor","importRoles":{"sourceParsing":"processor","teachingGeneration":"processor","teachingReview":null},"importRoleThinking":thinking})).unwrap();
    let mut checkpoint=json!({"version":VERSION,"pipelineVersion":PIPELINE,"plan":plan(),"batches":[{"status":"succeeded","questions":[{"questionId":"simulated-preserved"}],"attempts":[{"status":"succeeded","operationId":"simulated-success"}]}]});
    let original=checkpoint.clone();
    let old_client=source_stage_client(&model,&mut checkpoint,false).unwrap();
    assert_eq!(old_client.import_source_index_model().unwrap().public_settings()["reasoningEffort"],"high");
    assert_eq!(checkpoint,original);
    let new_client=source_stage_client(&model,&mut checkpoint,true).unwrap();
    assert_eq!(new_client.import_source_index_model().unwrap().public_settings()["reasoningEffort"],"low");
    assert_eq!(checkpoint["batches"],original["batches"]);
    record["sourceStructuring"]=checkpoint.clone();
    store.put_document("imports",s(&record,"importId"),&record).unwrap();
    let mut reloaded=store.document("imports",s(&record,"importId")).unwrap();
    source_stage_client(&model,&mut reloaded["sourceStructuring"],false).unwrap();
    thinking["sourceIndexing"]=setting("high");
    model.save(&json!({"expectedRevision":model.public_settings()["revision"],"importRoleThinking":thinking})).unwrap();
    assert_eq!(source_stage_client(&model,&mut reloaded["sourceStructuring"],false).err().unwrap().code,"accuracy_configuration_changed");
    assert_eq!(store.document("imports",s(&record,"importId")).unwrap(),record);
}
fn plan() -> Value {
    json!({"questions":(1..=4).map(|i|json!({"sourceLabel":i.to_string(),"questionType":"free_response","sourceBlockIds":[format!("p1-b{i}"),"p1-b5"]})).collect::<Vec<_>>(),"sharedBlockIds":["p1-b5"],"documentBlockIds":[]})
}
fn read_request(s: &mut TcpStream) -> (String, Value) {
    s.set_nonblocking(false).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    let mut data = Vec::new();
    let mut b = [0; 8192];
    loop {
        let n = match s.read(&mut b) {
            Ok(n) => n,
            Err(e) if matches!(e.kind(),std::io::ErrorKind::ConnectionReset|std::io::ErrorKind::ConnectionAborted) => 0,
            Err(e) => panic!("simulated request read: {e}"),
        };
        // The cancellation case legitimately closes a parallel request before
        // its body arrives. The mock caller rejects this sentinel in any
        // non-cancellation scenario; it is not a successful provider reply.
        if n == 0 { return ("CLIENT_CANCELLED".into(),Value::Null); }
        data.extend_from_slice(&b[..n]);
        if let Some(end) = data.windows(4).position(|x| x == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&data[..end]);
            let line = head.lines().next().unwrap().to_owned();
            let size = head
                .lines()
                .find_map(|l| {
                    l.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .and_then(|s| s.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            if data.len() >= end + 4 + size {
                return (
                    line,
                    if size == 0 {
                        Value::Null
                    } else {
                        serde_json::from_slice(&data[end + 4..end + 4 + size]).unwrap()
                    },
                );
            }
        }
    }
}
fn reply(s: &mut TcpStream, status: u16, body: &str, kind: &str) {
    let _ = write!(
        s,
        "HTTP/1.1 {status} OK\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
}
fn context(body: &Value) -> Value {
    let user = &body["messages"][1]["content"];
    let txt = user
        .as_str()
        .or_else(|| {
            user.as_array()
                .unwrap()
                .iter()
                .find(|x| x["type"] == "text")
                .unwrap()["text"]
                .as_str()
        })
        .unwrap();
    serde_json::from_str(txt).unwrap()
}
struct Mock {
    base: String,
    requests: Arc<Mutex<Vec<(String, Value)>>>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Drop for Mock {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            t.join().unwrap();
        }
    }
}
fn mock(mode: &str) -> Mock {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    l.set_nonblocking(true).unwrap();
    let base = format!("http://{}/v1", l.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(vec![]));
    let stop = Arc::new(AtomicBool::new(false));
    let (seen, st, mode) = (requests.clone(), stop.clone(), mode.to_owned());
    let failed = Arc::new(AtomicBool::new(false));
    let thread = std::thread::spawn(move || {
        let mut handles = vec![];
        while !st.load(Ordering::SeqCst) {
            let (mut s, _) = match l.accept() {
                Ok(x) => x,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(3));
                    continue;
                }
                Err(e) => panic!("{e}"),
            };
            let (seen, failed, mode) = (seen.clone(), failed.clone(), mode.clone());
            handles.push(std::thread::spawn(move|| {
   let(line,body)=read_request(&mut s);if line=="CLIENT_CANCELLED"{assert_eq!(mode,"cancel");return}seen.lock().unwrap().push((line.clone(),body.clone()));
   if line.starts_with("GET ") {reply(&mut s,503,"simulated unavailable catalogue","text/plain");return}
   assert_eq!(body["model"],"simulated-intake-model");
   let ctx=context(&body);let index=ctx["sourceBatch"].is_null();
   if mode=="model_unavailable" && !index && ctx["sourceBatch"]["expectedQuestions"][0]["sourceLabel"]=="1" {
    reply(&mut s,404,r#"{"error":{"code":"ModelNotFound","message":"private provider details must not be displayed"}}"#,"application/json");return
   }
   let raw=if index {plan()}else{
    let expected=ctx["sourceBatch"]["expectedQuestions"].as_array().unwrap();let label=expected[0]["sourceLabel"].as_str().unwrap();
    if ((label=="1" && mode=="fail_once") || (label=="2" && mode=="legacy")) && !failed.swap(true,Ordering::SeqCst) {std::thread::sleep(Duration::from_millis(100));reply(&mut s,500,"simulated network failure","text/plain");return}
    if mode=="cancel" {std::thread::sleep(Duration::from_millis(350));}
    json!({"questions":expected.iter().map(|e|json!({"questionId":e["questionId"],"sourceLabel":e["sourceLabel"],"questionType":e["questionType"],"sourceBlockIds":e["sourceBlockIds"],"pages":[1],"stem":format!("模拟原题{}，计算1+1。",e["sourceLabel"].as_str().unwrap()),"options":[],"parts":[],"answer":"2","solution":"","materialRoles":[],"review":{"status":"ready","confidence":"high","summary":"模拟回归：已对照原文，原参考2完整保留。","issues":[],"evidencePages":[1]},"primaryKnowledgeUids":["unrequested-fake"],"difficultyAssessment":{"level":"hard","basis":"unrequested"}})).collect::<Vec<_>>()})
   };
   let mut raw=raw;
   if mode=="asset_placements" || mode=="asset_placement_invalid_once" {
    if index {raw["questions"][0]["sourceBlockIds"].as_array_mut().unwrap().push(json!("p1-b6"));}
    else if ctx["sourceBatch"]["expectedQuestions"][0]["sourceLabel"]=="1" {
     raw["questions"][0]["materialRoles"]=json!([{"assetId":"simulated-bound-source-figure","role":"student","sourceBlockIds":["p1-b6"],"basis":"模拟原题1的独立配图"}]);
     raw["questions"][0]["assetPlacements"]=json!([{"assetId":"simulated-bound-source-figure","role":"student","target":{"field":"stem"},"sourceBlockIds":["p1-b6"],"basis":"原页明确为整题共用图"}]);
     if mode=="asset_placement_invalid_once" && !failed.swap(true,Ordering::SeqCst) {
      raw["questions"][0]["assetPlacements"][0]["target"]=json!({"field":"option","label":"Z"});
     }
    }
   }
   if index && mode=="index_coverage_once" && !failed.swap(true,Ordering::SeqCst) {
    raw["questions"][3]["sourceLabel"]=json!("5"); // Blocks remain complete, but real question 4 is missing.
   }
   let invalid_once = !index && context(&body)["sourceBatch"]["expectedQuestions"][0]["sourceLabel"] == "1"
     && matches!(mode.as_str(),"bad_source_json_once"|"bad_latex_delimiters_once"|"missing_source_block_once") && !failed.swap(true,Ordering::SeqCst);
   if invalid_once && mode=="missing_source_block_once" {raw["questions"][0]["sourceBlockIds"]=json!([]);}
   if mode=="key_options" || mode=="key_conflict" {
    for q in raw["questions"].as_array_mut().unwrap() {
     if index {q["questionType"]=json!("single_choice");}
     else {q["options"]=json!([{"key":"A","text":"2"},{"key":"B","text":"3"}]);q["answer"]=json!("A");if mode=="key_conflict" {q["options"][0]["label"]=json!("B");}}
    }
   }
   if mode=="legacy" && !index {for q in raw["questions"].as_array_mut().unwrap() {q["primaryKnowledgeUids"]=json!([]);q.as_object_mut().unwrap().remove("difficultyAssessment");q["task"]=json!({"label":"旧稿任务"});}}
   let finish=if !index && mode=="length" {"length"}else{"stop"};
   let visible=if invalid_once && mode=="bad_source_json_once" {"not valid JSON".to_owned()}
    else if invalid_once && mode=="bad_latex_delimiters_once" {
     raw["questions"][0]["stem"]=json!(r"模拟：\(a+b\)。");
     raw.to_string().replace(r"\\(",r"\(").replace(r"\\)",r"\)")
    }else{raw.to_string()};
   if body["stream"]==true {
    let body=format!("data: {}\n\ndata: [DONE]\n\n",json!({"choices":[{"delta":{"content":visible},"finish_reason":finish}]}));reply(&mut s,200,&body,"text/event-stream");
   } else {reply(&mut s,200,&json!({"choices":[{"finish_reason":finish,"message":{"content":visible}}]}).to_string(),"application/json");}
  }));
        }
        for t in handles {
            t.join().unwrap();
        }
    });
    Mock {
        base,
        requests,
        stop,
        thread: Some(thread),
    }
}
#[test]
fn production_http_restart_only_missing_batches_and_publication_replay() {
    let (dir, store, mut record, d) = fixture();
    let server = mock("fail_once");
    let model = ModelClient::test_client(dir.path(), &server.base);
    let mut saved = record.clone();
    assert_eq!(
        process(
            &store,
            &model,
            &mut record,
            &mut saved,
            &d,
            &AtomicBool::new(false),
            "first",
            "payload"
        )
        .unwrap_err()
        .code,
        "model_error"
    );
    let succeeded = rows(&record["sourceStructuring"]["batches"])
        .iter()
        .filter(|b| b["status"] == "succeeded")
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(succeeded.len(), 3);
    assert!(rows(&record["questions"]).is_empty());
    verify_successes(&store, &record, &d).unwrap();
    let prior = record.clone();
    let path = dir.path().to_path_buf();
    drop(store);
    let store = Store::open(&path, &crate::bank::tests::seed()).unwrap();
    record = store
        .document("imports", "simulated-production-source")
        .unwrap();
    assert_eq!(prior, record);
    saved = record.clone();
    let all = process(
        &store,
        &model,
        &mut record,
        &mut saved,
        &d,
        &AtomicBool::new(false),
        "explicit-resume",
        "payload2",
    )
    .unwrap();
    assert_eq!(all.len(), 4);
    for old in succeeded {
        let i = old["index"].as_u64().unwrap() as usize;
        assert_eq!(record["sourceStructuring"]["batches"][i], old);
    }
    assert!(all.iter().all(|q| q["answer"] == "2"
        && q["primaryKnowledgeUids"] == json!([])
        && q["difficultyAssessment"]["level"].is_null()));
    record["questions"] = json!(all);
    verify_completed_with_document(&store, &record, &d).unwrap();
    // Normal completed imports must bind original stream receipts too, even when
    // their root copies still look correct and no recovery supplement exists.
    let index_path = path_for(&store, &record, "first", "index").unwrap();
    let stream_request = index_path.with_extension("stream").join("request.json");
    let original = std::fs::read(&stream_request).unwrap();
    let request_receipt:Value=serde_json::from_slice(&original).unwrap();
    assert_eq!(request_receipt["sourceModelIdentity"]["model"],"simulated-intake-model");
    assert_eq!(request_receipt["sourceModelIdentity"]["catalogueCheckPerformed"],false);
    assert!(request_receipt["sourceModelIdentity"].get("verifiedAt").is_none());
    assert!(!index_path.with_extension("stream").join("catalog.json").exists());
    let mut altered = original.clone();
    altered.push(b' ');
    std::fs::write(&stream_request, &altered).unwrap();
    assert!(verify_completed_with_document(&store, &record, &d).is_err());
    std::fs::write(&stream_request, &original).unwrap();
    let mut incomplete = record.clone();
    incomplete["sourceStructuring"]["status"] = json!("processing");
    assert!(verify_completed_with_document(&store, &incomplete, &d).is_err());
    let index_post = server
        .requests
        .lock()
        .unwrap()
        .iter()
        .find(|(l, b)| l.starts_with("POST ") && context(b)["sourceBatch"].is_null())
        .unwrap()
        .1
        .clone();
    let images = index_post["messages"][1]["content"].as_array().unwrap();
    assert_eq!(images.len(), 3);
    let imagebytes = base64::engine::general_purpose::STANDARD
        .decode(
            images[2]["image_url"]["url"]
                .as_str()
                .unwrap()
                .strip_prefix("data:image/png;base64,")
                .unwrap(),
        )
        .unwrap();
    assert_eq!(sha(&imagebytes), s(&d.assets[0], "sha256"));
    assert_eq!(image::load_from_memory(&imagebytes).unwrap().width(), 12);
    let mut changed = record.clone();
    changed["questions"][0]["sourceBlockIds"] = json!(["p1-b99"]);
    assert!(verify_completed_with_document(&store, &changed, &d).is_err());
    let seen = server.requests.lock().unwrap();
    assert_eq!(
        seen.iter().filter(|(l, _)| l.starts_with("GET ")).count(),
        0
    );
    let posts = seen
        .iter()
        .filter(|(l, _)| l.starts_with("POST "))
        .map(|(_, b)| context(b))
        .collect::<Vec<_>>();
    assert_eq!(
        posts.iter().filter(|c| c["sourceBatch"].is_null()).count(),
        1
    );
    assert_eq!(
        posts.iter().filter(|c| !c["sourceBatch"].is_null()).count(),
        5
    );
}
#[test]
fn production_configured_model_http_error_keeps_successful_checkpoints_without_catalog_or_fallback() {
    let (dir,store,mut record,d)=fixture();
    let server=mock("model_unavailable");
    let model=ModelClient::test_client(dir.path(),&server.base);
    let mut saved=record.clone();
    let error=process(&store,&model,&mut record,&mut saved,&d,&AtomicBool::new(false),"missing-model-first","p").unwrap_err();
    assert_eq!(error.code,"model_error");
    assert!(error.message.contains("404"));
    assert!(!error.message.contains("private provider"));
    assert!(rows(&record["questions"]).is_empty());
    let preserved=rows(&record["sourceStructuring"]["batches"])[1..].to_vec();
    assert!(preserved.iter().all(|b|b["status"]=="succeeded"));
    let historical_attempt=json!({"operationId":"historical-catalog","status":"failed","error":{"code":"model_catalog_error"}});
    record["sourceStructuring"]["catalogAttempts"]=json!([historical_attempt.clone()]);
    persist(&store,&mut record,&mut saved).unwrap();
    let count=server.requests.lock().unwrap().len();
    let error=process(&store,&model,&mut record,&mut saved,&d,&AtomicBool::new(false),"missing-model-explicit-resume","p2").unwrap_err();
    assert_eq!(error.code,"model_error");
    assert!(error.message.contains("404"));
    assert_eq!(rows(&record["sourceStructuring"]["batches"])[1..],preserved);
    assert_eq!(record["sourceStructuring"]["catalogAttempts"],json!([historical_attempt]));
    let seen=server.requests.lock().unwrap();
    assert_eq!(seen.len(),count+1);
    assert!(seen.iter().all(|(line,body)|line.starts_with("POST /v1/chat/completions ") && body["model"]=="simulated-intake-model"));
    assert_eq!(seen.iter().filter(|(_,body)|context(body)["sourceBatch"].is_null()).count(),1);
    drop(seen);
    let persisted=store.document("imports","simulated-production-source").unwrap();
    assert_eq!(persisted,record);
}

#[test]
fn production_cancelled_http_preserves_index_and_never_exposes_partial_questions() {
    let (dir, store, mut record, d) = fixture();
    let server = mock("cancel");
    let model = ModelClient::test_client(dir.path(), &server.base);
    let mut saved = record.clone();
    let cancel = AtomicBool::new(false);
    std::thread::scope(|s| {
        s.spawn(|| {
            let started = Instant::now();
            let mut observed = false;
            while started.elapsed() < Duration::from_secs(30) {
                if server.requests.lock().unwrap().iter().any(|(line, body)| {
                    line.starts_with("POST ") && !context(body)["sourceBatch"].is_null()
                }) {
                    observed = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(3));
            }
            assert!(observed,"the actual batch POST must begin before cancellation");
            cancel.store(true, Ordering::SeqCst);
        });
        assert_eq!(
            process(
                &store,
                &model,
                &mut record,
                &mut saved,
                &d,
                &cancel,
                "cancel-op",
                "p"
            )
            .unwrap_err()
            .code,
            "cancelled"
        );
    });
    assert!(record["sourceStructuring"]["plan"].is_object());
    assert!(rows(&record["questions"]).is_empty());
    assert!(
        rows(&record["sourceStructuring"]["batches"])
            .iter()
            .all(|b| b["status"] != "succeeded")
    );
}
#[test]
fn production_length_response_is_never_adopted() {
    let (dir, store, mut record, d) = fixture();
    let server = mock("length");
    let model = ModelClient::test_client(dir.path(), &server.base);
    let mut saved = record.clone();
    assert_eq!(
        process(
            &store,
            &model,
            &mut record,
            &mut saved,
            &d,
            &AtomicBool::new(false),
            "length",
            "p"
        )
        .unwrap_err()
        .code,
        "model_output_truncated"
    );
    assert!(
        rows(&record["sourceStructuring"]["batches"])
            .iter()
            .all(|b| b["status"] == "failed")
    );
    assert!(rows(&record["questions"]).is_empty());
}
#[test]
fn production_three_workers_start_next_while_first_still_running_and_ack_before_work() {
    let active = std::sync::atomic::AtomicUsize::new(0);
    let peak = std::sync::atomic::AtomicUsize::new(0);
    let first_done = AtomicBool::new(false);
    let fourth_early = AtomicBool::new(false);
    let started = Mutex::new(std::collections::BTreeSet::new());
    let initial = std::sync::Barrier::new(3);
    let release = (Mutex::new(false), std::sync::Condvar::new());
    pool(
        5,
        Instant::now(),
        &AtomicBool::new(false),
        |i| {
            assert!(started.lock().unwrap().contains(&i));
            let n = active.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(n, Ordering::SeqCst);
            if i < 3 {
                initial.wait();
            }
            if i == 0 {
                let guard = release.0.lock().unwrap();
                let _guard = release
                    .1
                    .wait_timeout_while(guard, Duration::from_secs(2), |v| !(*v))
                    .unwrap();
                first_done.store(true, Ordering::SeqCst);
            } else if i >= 3 {
                if !first_done.load(Ordering::SeqCst) {
                    fourth_early.store(true, Ordering::SeqCst);
                }
                *release.0.lock().unwrap() = true;
                release.1.notify_all();
            }
            active.fetch_sub(1, Ordering::SeqCst);
            Ok(json!(i))
        },
        |e| {
            if let Event::Start(i, ack) = e {
                started.lock().unwrap().insert(i);
                ack.send(true).unwrap();
            }
            Ok(())
        },
    )
    .unwrap();
    assert!(fourth_early.load(Ordering::SeqCst));
    assert_eq!(peak.load(Ordering::SeqCst), 3);
}
#[test]
fn production_shared_deadline_refuses_new_work_without_http() {
    let (dir, store, mut record, d) = fixture();
    let model = ModelClient::test_client(dir.path(), "http://127.0.0.1:1/v1");
    let mut saved = record.clone();
    assert_eq!(
        check(
            Instant::now() - Duration::from_secs(120),
            &AtomicBool::new(false)
        )
        .unwrap_err()
        .code,
        "source_stage_deadline"
    );
    assert_eq!(
        process(
            &store,
            &model,
            &mut record,
            &mut saved,
            &d,
            &AtomicBool::new(true),
            "cancelled-before",
            "p"
        )
        .unwrap_err()
        .code,
        "cancelled"
    );
    assert!(record["sourceStructuring"].is_null());
}

#[test]
fn production_interrupted_complete_stop_replays_without_any_additional_http() {
    let (dir, store, mut record, d) = fixture();
    let server = mock("ok");
    let model = ModelClient::test_client(dir.path(), &server.base);
    let mut saved = record.clone();
    process(
        &store,
        &model,
        &mut record,
        &mut saved,
        &d,
        &AtomicBool::new(false),
        "interrupted",
        "p",
    )
    .unwrap();
    let count = server.requests.lock().unwrap().len();
    // Simulate process death between HTTP receipt and the batch's CAS checkpoint.
    record["sourceStructuring"]["status"] = json!("processing");
    let b = &mut record["sourceStructuring"]["batches"][0];
    b["status"] = json!("running");
    b["questions"] = json!([]);
    b["resultHash"] = Value::Null;
    b["attempts"][0]["status"] = json!("running");
    b["attempts"][0]["audit"] = Value::Null;
    let old_path = path_for(&store, &record, "interrupted", "batch-0").unwrap();
    std::fs::remove_file(&old_path).unwrap();
    std::fs::remove_file(old_path.with_extension("request.json")).unwrap();
    persist(&store, &record, &mut saved).unwrap();
    let all = process(
        &store,
        &model,
        &mut record,
        &mut saved,
        &d,
        &AtomicBool::new(false),
        "explicit-after-crash",
        "p2",
    )
    .unwrap();
    assert_eq!(all.len(), 4);
    assert_eq!(server.requests.lock().unwrap().len(), count);
}
#[test]
fn production_interrupted_index_stop_is_reused_without_resubmitting_index() {
    let (dir, store, mut record, d) = fixture();
    let server = mock("ok");
    let model = ModelClient::test_client(dir.path(), &server.base);
    let mut saved = record.clone();
    process(
        &store,
        &model,
        &mut record,
        &mut saved,
        &d,
        &AtomicBool::new(false),
        "index-interrupted",
        "p",
    )
    .unwrap();
    record["sourceStructuring"]["status"] = json!("processing");
    record["sourceStructuring"]["plan"] = Value::Null;
    record["sourceStructuring"]["planHash"] = Value::Null;
    record["sourceStructuring"]["batches"] = json!([]);
    record["sourceStructuring"]["planAttempts"][0]["status"] = json!("running");
    record["sourceStructuring"]["planAttempts"][0]["audit"] = Value::Null;
    let old_path = path_for(&store, &record, "index-interrupted", "index").unwrap();
    std::fs::remove_file(&old_path).unwrap();
    std::fs::remove_file(old_path.with_extension("request.json")).unwrap();
    persist(&store, &record, &mut saved).unwrap();
    let all = process(
        &store,
        &model,
        &mut record,
        &mut saved,
        &d,
        &AtomicBool::new(false),
        "explicit-after-index-crash",
        "p2",
    )
    .unwrap();
    assert_eq!(all.len(), 4);
    let seen = server.requests.lock().unwrap();
    assert_eq!(
        seen.iter()
            .filter(|(l, b)| l.starts_with("POST ") && context(b)["sourceBatch"].is_null())
            .count(),
        1
    );
}

#[test]
fn production_stream_replay_checks_actual_png_even_if_rehashed_request_claims_same_asset() {
    let (dir, store, mut record, d) = fixture();
    let server = mock("ok");
    let model = ModelClient::test_client(dir.path(), &server.base);
    let mut saved = record.clone();
    process(
        &store,
        &model,
        &mut record,
        &mut saved,
        &d,
        &AtomicBool::new(false),
        "png-proof",
        "p",
    )
    .unwrap();
    let path = path_for(&store, &record, "png-proof", "index").unwrap();
    let request_path = path.with_extension("stream").join("request.json");
    let mut request: Value =
        serde_json::from_slice(&std::fs::read(&request_path).unwrap()).unwrap();
    let changed = image::DynamicImage::ImageRgb8(image::ImageBuffer::from_pixel(
        12,
        16,
        image::Rgb([1u8, 2, 3]),
    ));
    let mut png = Cursor::new(Vec::new());
    changed.write_to(&mut png, image::ImageFormat::Png).unwrap();
    request["body"]["messages"][1]["content"][2]["image_url"]["url"] = json!(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png.into_inner())
    ));
    request["bodySha256"] = json!(hash_json(&request["body"]));
    std::fs::write(&request_path, serde_json::to_vec(&request).unwrap()).unwrap();
    std::fs::remove_file(&path).unwrap();
    std::fs::remove_file(path.with_extension("request.json")).unwrap();
    assert_eq!(
        replay_receipts(
            &store,
            &path,
            "question_import_plan",
            &compact_index(&record, &d),
            &d.assets
        )
        .unwrap_err()
        .code,
        "source_checkpoint_changed"
    );
    assert!(!path.exists());
}

#[test]
fn production_legacy_success_prefix_and_annotations_survive_parallel_resume() {
    let (dir, store, mut record, d) = fixture();
    let server = mock("legacy");
    let model = ModelClient::test_client(dir.path(), &server.base);
    let mut saved = record.clone();
    assert!(
        super::super::process(
            &store,
            &model,
            &mut record,
            &mut saved,
            &d,
            &AtomicBool::new(false),
            "old-serial",
            "old-payload"
        )
        .is_err()
    );
    assert!(record["sourceStructuring"]["pipelineVersion"].is_null());
    let old = record["sourceStructuring"]["batches"][0].clone();
    assert_eq!(old["status"], "succeeded");
    assert_eq!(old["questions"][0]["task"]["label"], "旧稿任务");
    let all = process(
        &store,
        &model,
        &mut record,
        &mut saved,
        &d,
        &AtomicBool::new(false),
        "new-parallel-resume",
        "p2",
    )
    .unwrap();
    assert_eq!(all.len(), 4);
    assert_eq!(record["sourceStructuring"]["batches"][0], old);
    record["questions"] = json!(all);
    verify_completed_with_document(&store, &record, &d).unwrap();
}

#[test]
fn production_explicit_option_aliases_are_exact_and_do_not_mutate_raw() {
    for options in [json!([{"key":"A","text":"x"},{"key":"B","text":"y"}]),
        json!([{"label":"A","text":"x"},{"label":"B","text":"y"}]),
        json!([{"key":"A","label":"A","text":"x"},{"key":"B","label":"B","text":"y"}])] {
        let original=json!({"questions":[{"options":options}]});
        let before=original.clone();
        let normalized=canonical_source_contract(&original).unwrap();
        assert_eq!(original,before);
        assert_eq!(normalized["questions"][0]["options"],json!([{"label":"A","text":"x"},{"label":"B","text":"y"}]));
    }
    for options in [json!([{"key":"A","label":"B"}]),json!([{"text":"A. x"}]),
        json!([{"key":""}]),json!([{"key":"a"}]),json!([{"label":" A"}]),
        json!([{"key":"AB"}]),json!([{"key":null}]),json!([{"key":1}]),
        json!([{"key":"A"},{"label":"A"}])] {
        assert_eq!(canonical_source_contract(&json!({"questions":[{"options":options}]})).unwrap_err().code,"invalid_import");
    }
    assert!(BATCH_PROMPT.contains("\"label\":\"A\""));
    assert!(!BATCH_PROMPT.contains("\"key\":\"A\""));
}

#[test]
fn production_failed_complete_batch_replays_locally_preserving_failed_attempt_and_successes() {
    let (dir,store,mut record,d)=fixture();
    let server=mock("key_options");
    let model=ModelClient::test_client(dir.path(),&server.base);
    let mut saved=record.clone();
    let all=process(&store,&model,&mut record,&mut saved,&d,&AtomicBool::new(false),"historic-key","p").unwrap();
    assert_eq!(all.len(),4);
    assert_eq!(all[0]["options"][0]["label"],"A");
    // Simulate the previous release rejecting its complete key-only response.
    record["sourceStructuring"]["status"]=json!("processing");
    let preserved=record["sourceStructuring"]["batches"][1].clone();
    let b=&mut record["sourceStructuring"]["batches"][0];
    b["status"]=json!("failed");b["questions"]=json!([]);b["resultHash"]=Value::Null;
    b["attempts"][0]["status"]=json!("failed");
    b["attempts"][0]["error"]=json!({"code":"invalid_import","message":"historic label-only parser"});
    let old=b["attempts"][0].clone();
    let audit=old["audit"].clone();
    let before_response=read_audit(&store,&audit,"response").unwrap();
    let count=server.requests.lock().unwrap().len();
    persist(&store,&record,&mut saved).unwrap();
    let all=process(&store,&model,&mut record,&mut saved,&d,&AtomicBool::new(false),"local-revalidation","p2").unwrap();
    assert_eq!(all.len(),4);
    assert_eq!(server.requests.lock().unwrap().len(),count);
    assert_eq!(record["sourceStructuring"]["batches"][1],preserved);
    let attempts=&record["sourceStructuring"]["batches"][0]["attempts"];
    assert_eq!(attempts[0],old);
    assert_eq!(attempts[1]["localReplay"]["providerCalled"],false);
    assert_eq!(attempts[1]["localReplay"]["originalAttemptSha256"],hash_json(&old));
    assert_eq!(read_audit(&store,&audit,"response").unwrap(),before_response);
    let receipt=&attempts[1]["localReplay"]["receipt"];
    assert_eq!(sha(&std::fs::read(store.data_dir.join(s(receipt,"relativePath"))).unwrap()),s(receipt,"sha256"));
    verify_successes(&store,&record,&d).unwrap();
}

#[test]
fn production_failed_complete_index_replays_locally_with_new_receipt_and_keeps_original() {
    let (dir,store,mut record,d)=fixture();
    let server=mock("ok");
    let model=ModelClient::test_client(dir.path(),&server.base);
    let mut saved=record.clone();
    process(&store,&model,&mut record,&mut saved,&d,&AtomicBool::new(false),"historic-index","p").unwrap();
    record["sourceStructuring"]["status"]=json!("processing");
    record["sourceStructuring"]["plan"]=Value::Null;
    record["sourceStructuring"]["planHash"]=Value::Null;
    record["sourceStructuring"]["batches"]=json!([]);
    record["sourceStructuring"]["planAttempts"][0]["status"]=json!("failed");
    record["sourceStructuring"]["planAttempts"][0]["error"]=json!({"code":"source_plan_invalid"});
    let old=record["sourceStructuring"]["planAttempts"][0].clone();
    persist(&store,&record,&mut saved).unwrap();
    process(&store,&model,&mut record,&mut saved,&d,&AtomicBool::new(false),"local-index-revalidation","p2").unwrap();
    assert_eq!(record["sourceStructuring"]["planAttempts"][0],old);
    assert_eq!(record["sourceStructuring"]["planAttempts"][1]["localReplay"]["providerCalled"],false);
    assert_eq!(server.requests.lock().unwrap().iter().filter(|(l,b)| l.starts_with("POST ") && context(b)["sourceBatch"].is_null()).count(),1);
    verify_successes(&store,&record,&d).unwrap();
}

#[test]
fn production_invalid_complete_cached_response_is_not_automatically_resubmitted() {
    let (dir,store,mut record,d)=fixture();
    let server=mock("key_conflict");
    let model=ModelClient::test_client(dir.path(),&server.base);
    let mut saved=record.clone();
    assert_eq!(process(&store,&model,&mut record,&mut saved,&d,&AtomicBool::new(false),"conflict-original","p").unwrap_err().code,"invalid_import");
    let old=record["sourceStructuring"]["batches"][0]["attempts"][0].clone();
    let count=server.requests.lock().unwrap().len();
    assert_eq!(process(&store,&model,&mut record,&mut saved,&d,&AtomicBool::new(false),"conflict-original","p2").unwrap_err().code,"invalid_import");
    assert_eq!(server.requests.lock().unwrap().len(),count);
    assert_eq!(record["sourceStructuring"]["batches"][0]["attempts"][0],old);
    assert_eq!(record["sourceStructuring"]["batches"][0]["status"],"failed");
    // Even an innocuous byte change cannot be accepted by re-hashing cached disk.
    let path=path_for(&store,&record,"conflict-original","batch-0").unwrap();
    let mut bytes=std::fs::read(&path).unwrap();bytes.push(b' ');std::fs::write(&path,bytes).unwrap();
    assert_eq!(process(&store,&model,&mut record,&mut saved,&d,&AtomicBool::new(false),"explicit-tampered-conflict","p3").unwrap_err().code,"source_checkpoint_changed");
    assert_eq!(server.requests.lock().unwrap().len(),count);
}

#[test]
fn production_label_only_parts_preserve_source_and_existing_nested_identity() {
    let raw=json!({"questions":[{"options":[],"parts":[{"label":"(1)","prompt":"a"},{"label":"(2)","prompt":"b"}]}]});
    let out=canonical_source_contract(&raw).unwrap();
    assert_eq!(out["questions"][0]["parts"][0]["partId"],"(1)");
    assert_eq!(out["questions"][0]["parts"][1]["partId"],"(2)");
    assert!(raw["questions"][0]["parts"][0].get("partId").is_none());
    let nested=json!({"questions":[{"parts":[{"partId":"root","label":"(2)"},{"partId":"child-i","label":"(i)","parentPartId":"root"}]}]});
    let out=canonical_source_contract(&nested).unwrap();
    assert_eq!(out["questions"][0]["parts"],nested["questions"][0]["parts"]);
    // A missing internal ID may use a source label only when it is unique
    // across every part, including parts that already have their own IDs.
    let mixed=json!({"questions":[{"parts":[{"partId":"p1","label":"(1)"},{"label":"(1)"}]}]});
    assert!(canonical_source_contract(&mixed).is_err());
    let explicit_repeated=json!({"questions":[{"parts":[{"partId":"p1","label":"(1)"},{"partId":"p2","label":"(1)"}]}]});
    assert_eq!(canonical_source_contract(&explicit_repeated).unwrap()["questions"][0]["parts"],explicit_repeated["questions"][0]["parts"]);
    for parts in [json!([{"label":"(1)"},{"label":"(1)"}]),json!([{"label":""}]),json!([{"prompt":"(1) text"}]),
        json!([{"partId":"","label":"(1)"}]),json!([{"partId":"p","label":"(1)"},{"partId":"p","label":"(2)"}]),
        json!([{"label":"(1)","parentPartId":"missing"}]),json!([{"label":"(1)","parentPartId":"(1)"}])] {
        assert!(canonical_source_contract(&json!({"questions":[{"parts":parts}]})).is_err());
    }
    assert!(BATCH_PROMPT.contains("\"partId\""));
}

#[test]
fn production_failed_cache_replay_tolerates_only_persisted_asset_storage_locator() {
    let (dir,store,mut record,mut d)=fixture();
    let server=mock("key_options");
    let model=ModelClient::test_client(dir.path(),&server.base);
    let mut saved=record.clone();
    process(&store,&model,&mut record,&mut saved,&d,&AtomicBool::new(false),"fresh-ocr-before-save","p").unwrap();
    let old_response=path_for(&store,&record,"fresh-ocr-before-save","batch-0").unwrap();
    let original_bytes=std::fs::read(&old_response).unwrap();
    let preserved=record["sourceStructuring"]["batches"][1].clone();
    record["sourceStructuring"]["status"]=json!("processing");
    let b=&mut record["sourceStructuring"]["batches"][0];
    b["status"]=json!("failed");b["questions"]=json!([]);b["resultHash"]=Value::Null;
    b["attempts"][0]["status"]=json!("failed");
    b["attempts"][0]["error"]=json!({"code":"invalid_import","message":"historic key alias"});
    let old_attempt=b["attempts"][0].clone();
    // Reproduce fresh OCR -> save manifest -> reload OCR: only this storage
    // descriptor is added after the actual first provider request was made.
    d.assets[0]["relativePath"]=json!("imports/simulated-production-source/preserved-assets/page.png");
    persist(&store,&record,&mut saved).unwrap();
    let count=server.requests.lock().unwrap().len();
    let all=process(&store,&model,&mut record,&mut saved,&d,&AtomicBool::new(false),"reload-local-replay","p2").unwrap();
    assert_eq!(all.len(),4);
    assert_eq!(server.requests.lock().unwrap().len(),count);
    assert_eq!(record["sourceStructuring"]["batches"][0]["attempts"][0],old_attempt);
    assert_eq!(record["sourceStructuring"]["batches"][1],preserved);
    assert_eq!(std::fs::read(&old_response).unwrap(),original_bytes);
    let batch=record["sourceStructuring"]["batches"][0].clone();
    let plan=record["sourceStructuring"]["plan"].clone();
    let sub=subset(&plan,&batch,&d).unwrap();
    let mut altered=source_context(&record,&plan,&batch,&sub).unwrap();
    altered["document"]["assets"][0]["sha256"]=json!("changed-identity");
    assert_eq!(replay_receipts(&store,&old_response,"question_import",&altered,&sub.assets).unwrap_err().code,"source_checkpoint_changed");
    altered=source_context(&record,&plan,&batch,&sub).unwrap();
    altered["document"]["pages"][0]["blocks"][0]["text"]=json!("changed source text");
    assert_eq!(replay_receipts(&store,&old_response,"question_import",&altered,&sub.assets).unwrap_err().code,"source_checkpoint_changed");
}

#[test]
fn malformed_source_contract_is_output_failure_not_changed_evidence_or_panic() {
    for raw in [json!({}), json!({"questions":null}), json!({"questions":"broken"})] {
        assert_eq!(canonical_source_contract(&raw).unwrap_err().code, "source_batch_incomplete");
    }
    for raw in [json!({"questions":[5]}), json!({"questions":[null]})] {
        assert_eq!(canonical_source_contract(&raw).unwrap_err().code, "invalid_import");
    }
}

#[test]
fn production_explicit_new_source_operation_retries_only_intact_invalid_failed_batch_once() {
    for mode in ["bad_source_json_once","bad_latex_delimiters_once","missing_source_block_once"] {
        let (dir,store,mut record,d)=fixture();
        let server=mock(mode);
        let model=ModelClient::test_client(dir.path(),&server.base);
        let mut saved=record.clone();
        let failed=process(&store,&model,&mut record,&mut saved,&d,&AtomicBool::new(false),"bad-source-first","p").unwrap_err();
        assert!(matches!(failed.code.as_str(),"model_output_invalid_json"|"source_batch_scope"),"{failed:?}");
        let old=record["sourceStructuring"]["batches"][0]["attempts"][0].clone();
        let original_path=path_for(&store,&record,"bad-source-first","batch-0").unwrap();
        let original_bytes=std::fs::read(&original_path).unwrap();
        let preserved=rows(&record["sourceStructuring"]["batches"])[1..].to_vec();
        let count=server.requests.lock().unwrap().len();
        // Re-entering the same operation never silently regenerates source.
        assert!(process(&store,&model,&mut record,&mut saved,&d,&AtomicBool::new(false),"bad-source-first","same").is_err());
        assert_eq!(server.requests.lock().unwrap().len(),count);
        let all=process(&store,&model,&mut record,&mut saved,&d,&AtomicBool::new(false),"explicit-new-source","p2").unwrap();
        assert_eq!(all.len(),4);
        assert_eq!(record["sourceStructuring"]["batches"][0]["attempts"].as_array().unwrap().len(),2);
        assert_eq!(record["sourceStructuring"]["batches"][0]["attempts"][0],old);
        assert!(rows(&record["sourceStructuring"]["batches"][0]["localValidationReplays"]).len()>=1);
        assert_eq!(rows(&record["sourceStructuring"]["batches"])[1..],preserved);
        assert_eq!(std::fs::read(original_path).unwrap(),original_bytes);
        let seen=server.requests.lock().unwrap();
        let example:Value=serde_json::from_str(FORMULA_JSON_EXAMPLE).unwrap();
        assert_eq!(example["stem"],r"已知 $a$，求 $\frac{a}{2}$。");
        // Inspect the actual HTTP body of the ordinary source transport. A
        // contract present only on a legacy task prompt would not pass.
        for (_,body) in seen.iter().filter(|(line,body)|line.starts_with("POST ")&&!context(body)["sourceBatch"].is_null()) {
            let sent=s(&body["messages"][0],"content");
            assert!(sent.contains("JSON公式格式"));
            assert!(sent.contains(FORMULA_JSON_EXAMPLE));
            assert!(sent.contains(r"不要使用 \(...\) 或 \[...\]"));
        }
        assert_eq!(seen.len(),count+1); // Only the failed source batch, no catalogue GET.
        assert_eq!(seen.iter().filter(|(l,b)|l.starts_with("POST ") && context(b)["sourceBatch"].is_null()).count(),1);
        assert_eq!(seen.iter().filter(|(l,b)|l.starts_with("POST ") && context(b)["sourceBatch"]["expectedQuestions"][0]["sourceLabel"]=="1").count(),2);
    }
}

#[test]
fn production_explicit_new_source_index_retries_intact_question_coverage_failure() {
    let (dir,store,mut record,d)=fixture();
    let server=mock("index_coverage_once");
    let model=ModelClient::test_client(dir.path(),&server.base);
    let mut saved=record.clone();
    assert_eq!(process(&store,&model,&mut record,&mut saved,&d,&AtomicBool::new(false),"bad-coverage-index","p").unwrap_err().code,"ocr_question_coverage");
    let original=record["sourceStructuring"]["planAttempts"][0].clone();
    let path=path_for(&store,&record,"bad-coverage-index","index").unwrap();
    let bytes=std::fs::read(&path).unwrap();
    let count=server.requests.lock().unwrap().len();
    assert_eq!(process(&store,&model,&mut record,&mut saved,&d,&AtomicBool::new(false),"bad-coverage-index","same").unwrap_err().code,"ocr_question_coverage");
    assert_eq!(server.requests.lock().unwrap().len(),count);
    let all=process(&store,&model,&mut record,&mut saved,&d,&AtomicBool::new(false),"explicit-new-coverage-index","p2").unwrap();
    assert_eq!(all.len(),4);
    assert_eq!(record["sourceStructuring"]["planAttempts"][0],original);
    assert_eq!(std::fs::read(path).unwrap(),bytes);
    assert!(rows(&record["sourceStructuring"]["localValidationReplays"]).iter().all(|a|a["error"]["code"]=="ocr_question_coverage"));
    assert_eq!(server.requests.lock().unwrap().iter().filter(|(l,b)|l.starts_with("POST ") && context(b)["sourceBatch"].is_null()).count(),2);
    for code in ["source_plan_invalid","source_plan_incomplete","ocr_question_coverage","source_batch_incomplete","source_batch_identity","source_batch_scope"] {
        assert!(retryable_source_output_error(&err(code,"simulated source output defect")));
    }
    for code in ["source_checkpoint_changed","source_changed","integrity_error","revision_conflict"] {
        assert!(!retryable_source_output_error(&err(code,"simulated evidence alteration")));
    }
}


#[test]
fn production_real_http_asset_placement_persists_and_replays_original_provider_receipt() {
    let (dir,store,mut record,mut d)=fixture();
    let mut png=Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(image::ImageBuffer::from_pixel(12,16,image::Rgb([25u8,45,85])))
        .write_to(&mut png,image::ImageFormat::Png).unwrap();
    let bytes=png.into_inner();
    d.assets.push(json!({"id":"simulated-bound-source-figure","page":1,"role":"figure","mimeType":"image/png","width":12,"height":16,"bbox":[1,9,10,15],"sha256":sha(&bytes),"contentBase64":base64::engine::general_purpose::STANDARD.encode(&bytes)}));
    d.pages[0]["blocks"].as_array_mut().unwrap().push(json!({"id":6,"type":"figure","order":6,"text":"","assetId":"simulated-bound-source-figure","bbox":[1,9,10,15]}));
    let server=mock("asset_placements");
    let model=ModelClient::test_client(dir.path(),&server.base);
    let mut saved=record.clone();
    let all=process(&store,&model,&mut record,&mut saved,&d,&AtomicBool::new(false),"paid-asset-source","p").unwrap();
    assert_eq!(all.len(),4);
    let q=&all[0];
    assert!(s(q,"stem").ends_with("![原卷配图](asset:simulated-bound-source-figure)"));
    assert_eq!(q["student"]["assets"][0]["assetId"],"simulated-bound-source-figure");
    assert_eq!(q["student"]["assets"][0]["sha256"],sha(&bytes));
    assert_eq!(q["sourceAssetBindingAudit"]["bindings"][0]["origin"],"model_placement");
    assert_eq!(q["sourceAssetBindingAudit"]["bindings"][0]["placement"]["target"],json!({"field":"stem"}));
    let attempt=record["sourceStructuring"]["batches"][0]["attempts"][0].clone();
    let provider=actual_result(&store,&attempt,"question_import",&record).unwrap();
    assert!(!s(&provider["questions"][0],"stem").contains("asset:simulated-bound-source-figure"));
    assert!(provider["questions"][0].get("sourceAssetBindingAudit").is_none());
    // Imported model opinion binds the actual paid provider object, not the
    // mechanically augmented/normalized object that the teacher will render.
    assert_eq!(q["modelReview"]["audit"]["responseQuestionSha256"],hash_json(&provider["questions"][0]),"{:?}",q["modelReview"]);
    assert_eq!(q["sourceAssetBindingAudit"]["originalQuestionSha256"],hash_json(&provider["questions"][0]));
    let response_path=path_for(&store,&record,"paid-asset-source","batch-0").unwrap();
    let original_response=std::fs::read(&response_path).unwrap();
    record["questions"]=json!(all);
    persist(&store,&record,&mut saved).unwrap();
    verify_successes(&store,&record,&d).unwrap();
    verify_completed_with_document(&store,&record,&d).unwrap();
    let paid_count=server.requests.lock().unwrap().len();
    let expected=record.clone();let data_root=dir.path().to_path_buf();drop(store);
    let store=Store::open(&data_root,&crate::bank::tests::seed()).unwrap();
    record=store.document("imports","simulated-production-source").unwrap();assert_eq!(record,expected);
    saved=record.clone();
    let replayed=process(&store,&model,&mut record,&mut saved,&d,&AtomicBool::new(false),"read-only-completed-resume","p2").unwrap();
    assert_eq!(replayed,rows(&expected["questions"]));
    assert_eq!(server.requests.lock().unwrap().len(),paid_count);
    assert_eq!(std::fs::read(&response_path).unwrap(),original_response);
    for field in ["placement","audit"] {
        let mut altered=record.clone();
        if field=="placement" {
            altered["sourceStructuring"]["batches"][0]["questions"][0]["sourceAssetBindingAudit"]["bindings"][0]["placement"]["target"]=json!({"field":"answer"});
        } else {
            altered["sourceStructuring"]["batches"][0]["questions"][0]["sourceAssetBindingAudit"]["originalQuestionSha256"]=json!("b".repeat(64));
        }
        altered["sourceStructuring"]["batches"][0]["resultHash"]=json!(hash_json(&altered["sourceStructuring"]["batches"][0]["questions"]));
        assert!(verify_successes(&store,&altered,&d).is_err());
    }
    let mut changed_document=OcrDocument{pages:d.pages.clone(),assets:d.assets.clone(),issues:d.issues.clone()};
    changed_document.assets[1]["sha256"]=json!("a".repeat(64));
    assert!(verify_successes(&store,&record,&changed_document).is_err());
    assert_eq!(server.requests.lock().unwrap().len(),paid_count);
}


#[test]
fn production_older_complete_source_receipt_survives_newer_no_response_timeout_without_http() {
    let (dir,store,mut record,d)=fixture();let server=mock("key_options");
    let model=ModelClient::test_client(dir.path(),&server.base);let mut saved=record.clone();
    process(&store,&model,&mut record,&mut saved,&d,&AtomicBool::new(false),"original-paid-source","p").unwrap();
    let original_path=path_for(&store,&record,"original-paid-source","batch-0").unwrap();
    let original_bytes=std::fs::read(&original_path).unwrap();
    let timeout_path=path_for(&store,&record,"newer-network-timeout","batch-0").unwrap();
    std::fs::copy(original_path.with_extension("request.json"),timeout_path.with_extension("request.json")).unwrap();
    let scope=record["sourceStructuring"]["batches"][0]["attempts"][0]["scopeHash"].clone();
    let timeout=json!({"operationId":"newer-network-timeout","status":"failed","sourceOnly":true,"scopeHash":scope,"error":{"code":"model_request_timeout"},"audit":audit_files(&store,&timeout_path).unwrap()});
    record["sourceStructuring"]["status"]=json!("processing");
    let b=&mut record["sourceStructuring"]["batches"][0];
    b["status"]=json!("failed");b["questions"]=json!([]);b["resultHash"]=Value::Null;
    b["attempts"][0]["status"]=json!("failed");b["attempts"][0]["error"]=json!({"code":"invalid_import","message":"historic alias mismatch"});
    let original=b["attempts"][0].clone();b["attempts"].as_array_mut().unwrap().push(timeout.clone());
    let failed_record=record.clone();
    assert_eq!(cached_batch_attempt(&store,&record,&record["sourceStructuring"]["batches"][0],0).unwrap(),Some(original.clone()));
    let mut no_response=record["sourceStructuring"]["batches"][0].clone();no_response["attempts"]=json!([timeout.clone()]);
    assert_eq!(cached_batch_attempt(&store,&record,&no_response,0).unwrap(),None);
    let count=server.requests.lock().unwrap().len();persist(&store,&record,&mut saved).unwrap();
    let all=process(&store,&model,&mut record,&mut saved,&d,&AtomicBool::new(false),"explicit-complete-cache-resume","p2").unwrap();
    assert_eq!(all.len(),4);assert_eq!(server.requests.lock().unwrap().len(),count);
    let attempts=&record["sourceStructuring"]["batches"][0]["attempts"];
    assert_eq!(attempts[0],original);assert_eq!(attempts[1],timeout);
    assert_eq!(std::fs::read(&original_path).unwrap(),original_bytes);
    assert_eq!(record["sourceStructuring"]["batches"][1],failed_record["sourceStructuring"]["batches"][1]);
    // A newer incomplete receipt cannot make an altered earlier complete one
    // disappear from evidence checks or permit another billable source request.
    let mut altered=original_bytes;altered.push(b' ');std::fs::write(&original_path,altered).unwrap();
    assert_eq!(cached_batch_attempt(&store,&failed_record,&failed_record["sourceStructuring"]["batches"][0],0).unwrap_err().code,"source_checkpoint_changed");
    assert_eq!(server.requests.lock().unwrap().len(),count);
}


#[test]
fn production_explicit_retry_repairs_invalid_model_asset_target_but_not_stale_approval() {
    let (dir,store,mut record,mut d)=fixture();
    let mut png=Cursor::new(Vec::new());image::DynamicImage::new_rgb8(10,10).write_to(&mut png,image::ImageFormat::Png).unwrap();let bytes=png.into_inner();
    d.assets.push(json!({"id":"simulated-bound-source-figure","page":1,"role":"figure","mimeType":"image/png","width":10,"height":10,"bbox":[1,9,10,15],"sha256":sha(&bytes),"contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes)}));
    d.pages[0]["blocks"].as_array_mut().unwrap().push(json!({"id":6,"type":"figure","order":6,"text":"","assetId":"simulated-bound-source-figure","bbox":[1,9,10,15]}));
    let server=mock("asset_placement_invalid_once");let model=ModelClient::test_client(dir.path(),&server.base);let mut saved=record.clone();
    assert_eq!(process(&store,&model,&mut record,&mut saved,&d,&AtomicBool::new(false),"bad-model-placement","p").unwrap_err().code,"source_asset_binding_invalid");
    let original=record["sourceStructuring"]["batches"][0]["attempts"][0].clone();
    let path=path_for(&store,&record,"bad-model-placement","batch-0").unwrap();let original_bytes=std::fs::read(&path).unwrap();
    let successes=rows(&record["sourceStructuring"]["batches"])[1..].to_vec();let count=server.requests.lock().unwrap().len();
    assert_eq!(process(&store,&model,&mut record,&mut saved,&d,&AtomicBool::new(false),"bad-model-placement","same").unwrap_err().code,"source_asset_binding_invalid");
    assert_eq!(server.requests.lock().unwrap().len(),count);
    let all=process(&store,&model,&mut record,&mut saved,&d,&AtomicBool::new(false),"explicit-new-placement","p2").unwrap();
    assert_eq!(all.len(),4);assert!(s(&all[0],"stem").contains("asset:simulated-bound-source-figure"));
    assert_eq!(server.requests.lock().unwrap().len(),count+1);
    assert_eq!(record["sourceStructuring"]["batches"][0]["attempts"].as_array().unwrap().len(),2);
    assert_eq!(record["sourceStructuring"]["batches"][0]["attempts"][0],original);
    assert_eq!(rows(&record["sourceStructuring"]["batches"])[1..],successes);
    assert_eq!(std::fs::read(path).unwrap(),original_bytes);
    assert!(retryable_source_output_error(&err("source_asset_binding_invalid","bad model target")));
    assert!(!retryable_source_output_error(&err("source_asset_binding_stale","corrupt approval")));
}
