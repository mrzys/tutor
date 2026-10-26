//! Real isolated HTTP/SSE simulations, not model-quality or teacher evidence.
use super::*;
use std::{
    net::{TcpListener, TcpStream},
    sync::Arc,
};
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
   if line.starts_with("GET ") {reply(&mut s,200,&json!({"data":[{"id":"simulated-intake-model"}]}).to_string(),"application/json");return}
   let ctx=context(&body);let index=ctx["sourceBatch"].is_null();
   let raw=if index {plan()}else{
    let expected=ctx["sourceBatch"]["expectedQuestions"].as_array().unwrap();let label=expected[0]["sourceLabel"].as_str().unwrap();
    if ((label=="1" && mode=="fail_once") || (label=="2" && mode=="legacy")) && !failed.swap(true,Ordering::SeqCst) {std::thread::sleep(Duration::from_millis(100));reply(&mut s,500,"simulated network failure","text/plain");return}
    if mode=="cancel" {std::thread::sleep(Duration::from_millis(350));}
    json!({"questions":expected.iter().map(|e|json!({"questionId":e["questionId"],"sourceLabel":e["sourceLabel"],"questionType":e["questionType"],"sourceBlockIds":e["sourceBlockIds"],"pages":[1],"stem":format!("模拟原题{}，计算1+1。",e["sourceLabel"].as_str().unwrap()),"options":[],"parts":[],"answer":"2","solution":"","materialRoles":[],"review":{"status":"ready","confidence":"high","summary":"模拟回归：已对照原文，原参考2完整保留。","issues":[],"evidencePages":[1]},"primaryKnowledgeUids":["unrequested-fake"],"difficultyAssessment":{"level":"hard","basis":"unrequested"}})).collect::<Vec<_>>()})
   };
   let mut raw=raw;
   if mode=="legacy" && !index {for q in raw["questions"].as_array_mut().unwrap() {q["primaryKnowledgeUids"]=json!([]);q.as_object_mut().unwrap().remove("difficultyAssessment");q["task"]=json!({"label":"旧稿任务"});}}
   let finish=if !index && mode=="length" {"length"}else{"stop"};
   if body["stream"]==true {
    let body=format!("data: {}\n\ndata: [DONE]\n\n",json!({"choices":[{"delta":{"content":raw.to_string()},"finish_reason":finish}]}));reply(&mut s,200,&body,"text/event-stream");
   } else {reply(&mut s,200,&json!({"choices":[{"finish_reason":finish,"message":{"content":raw.to_string()}}]}).to_string(),"application/json");}
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
        2
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
