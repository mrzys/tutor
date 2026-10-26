//! Isolated upload regression cases, not real teacher cases or OCR quality evidence.
use super::*;
use crate::ocr_settings::OcrSettings;
use std::{
    net::TcpListener,
    path::PathBuf,
    sync::{Arc, Mutex, atomic::AtomicUsize},
    thread::JoinHandle,
    time::Duration,
};

const SUCCESS: usize = 0;
const OCR_FAIL: usize = 1;
const LLM_FAIL: usize = 2;
const UNKNOWN_ASSET: usize = 3;
const MISSING_FIGURE: usize = 4;
const TABLE_LOSS: usize = 5;
const PAGE_MISMATCH: usize = 6;
const TEACHER_LEAK: usize = 7;
const ORIGINAL_GRAPH_MOVED_TO_ANSWER: usize = 8;
const ORIGINAL_TABLE_MOVED_TO_ANSWER: usize = 9;
const INVALID_JSON_ONCE: usize = 10;
const INVALID_JSON_ALWAYS: usize = 11;
const TRUNCATED_OUTPUT: usize = 12;
const INVALID_JSON_CANCEL: usize = 13;
const MISSING_FIGURE_ONCE: usize = 14;
const MISLEADING_ANSWER_HEADING: usize = 15;
const MISSING_MATERIAL_ROLES: usize = 16;
const FORGED_MATERIAL_BLOCK: usize = 17;
const SOURCE_PAGE_AS_QUESTION: usize = 18;
const UNRELATED_MATERIAL_BLOCK: usize = 19;
// Simulates an invalid LaTeX escape in the JSON content, not provider HTTP JSON.
const INVALID_MODEL_JSON: &str = r#"{"questions":[{"stem":"simulated \sqrt{2}"}]}"#;
const TABLE: &str =
    "<table><tr><td>模拟组别</td><td></td></tr><tr><td>A</td><td>3</td></tr></table>";
const STEM: &str = "模拟上传回归：观察原图和表格，填写结果____。";

struct Server {
    base: String,
    mode: Arc<AtomicUsize>,
    calls: Arc<Mutex<Vec<String>>>,
    contexts: Arc<Mutex<Vec<Value>>>,
    cancel: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}
impl Server {
    fn close(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.thread.take() {
            if h.join().is_err() && !std::thread::panicking() {
                panic!("simulated OCR/LLM server failed");
            }
        }
    }
    fn count(&self, path: &str) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|p| p.as_str() == path)
            .count()
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.close();
    }
}
fn page_png() -> Vec<u8> {
    let mut image = image::RgbImage::new(12, 16);
    for (x, y, p) in image.enumerate_pixels_mut() {
        *p = image::Rgb([(x * 11) as u8, (y * 7) as u8, 40]);
    }
    let mut out = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(image)
        .write_to(&mut out, image::ImageFormat::Png)
        .unwrap();
    out.into_inner()
}
fn pdf() -> Vec<u8> {
    use lopdf::{Stream, dictionary};
    let mut doc = lopdf::Document::with_version("1.5");
    let pages = doc.new_object_id();
    let content = doc.add_object(Stream::new(dictionary! {}, vec![]));
    let page=doc.add_object(dictionary!{"Type"=>"Page","Parent"=>pages,"Contents"=>content,"MediaBox"=>vec![0.into(),0.into(),300.into(),300.into()]});
    doc.objects.insert(
        pages,
        lopdf::Object::Dictionary(
            dictionary! {"Type"=>"Pages","Kids"=>vec![page.into()],"Count"=>1},
        ),
    );
    let catalog = doc.add_object(dictionary! {"Type"=>"Catalog","Pages"=>pages});
    doc.trailer.set("Root", catalog);
    let mut bytes = vec![];
    doc.save_to(&mut bytes).unwrap();
    bytes
}
fn layout(base: &str, mode: usize) -> Value {
    let heading = if matches!(mode, TEACHER_LEAK|MISLEADING_ANSWER_HEADING) {
        "# 参考答案\n"
    } else {
        ""
    };
    json!({"result":{"layoutParsingResults":[{"inputImage":format!("{base}/page.png"),"prunedResult":{"width":12,"height":16,"parsing_res_list":[{"block_id":1,"block_order":1,"block_label":"text","block_content":format!("1. {STEM}"),"block_bbox":[0,0,12,3]},{"block_id":2,"block_order":null,"block_label":"image","block_content":"","block_bbox":[1,3,6,8]},{"block_id":3,"block_order":2,"block_label":"table","block_content":TABLE,"block_bbox":[1,10,11,15]}]},"markdown":{"text":format!("{heading}1. {STEM}\n![原图](imgs/img_in_image_box_1_3_6_8.jpg)\n{TABLE}"),"images":{"imgs/img_in_image_box_1_3_6_8.jpg":format!("{base}/never-download-duplicate.png")}},"outputImages":{}}]}})
}
fn proposal(context: &Value, mode: usize) -> Value {
    let figure = rows(&context["document"]["assets"])
        .into_iter()
        .find(|a| a["role"] == "figure")
        .unwrap();
    let source_page = rows(&context["document"]["assets"]).into_iter().find(|asset| asset["role"]=="source_page").unwrap();
    let id = if mode == UNKNOWN_ASSET {
        "nonexistent-simulated-asset"
    } else if mode == SOURCE_PAGE_AS_QUESTION {
        s(&source_page,"id")
    } else {
        s(&figure, "id")
    };
    let mut stem = STEM.to_owned();
    if mode != MISSING_FIGURE && mode != ORIGINAL_GRAPH_MOVED_TO_ANSWER {
        stem.push_str(&format!("\n![原图](asset:{id})"));
    }
    if mode != TABLE_LOSS && mode != ORIGINAL_TABLE_MOVED_TO_ANSWER {
        stem.push_str(TABLE);
    }
    let answer = if mode == ORIGINAL_GRAPH_MOVED_TO_ANSWER {
        format!("![错误移入答案的原题图](asset:{id})")
    } else if mode == ORIGINAL_TABLE_MOVED_TO_ANSWER {
        TABLE.to_owned()
    } else {
        String::new()
    };
    let material_roles:Vec<_> = if mode == MISSING_MATERIAL_ROLES {vec![]}else{rows(&context["document"]["requiredMaterialAssets"]).iter().map(|asset| json!({"assetId":asset["assetId"],"role":if mode==TEACHER_LEAK {"teacher"}else{"student"},"sourceBlockIds":if mode==FORGED_MATERIAL_BLOCK{json!(["p1-b999"])}else if mode==UNRELATED_MATERIAL_BLOCK{json!(["p1-b1"])}else{asset["sourceBlockIds"].clone()},"basis":"模拟模型按真实原文块判断素材为题面；答案素材另行归入教师内容。"})).collect()};
    let mut result=json!({"questions":[{"questionType":"fill_blank","sourceLabel":"1","pages":[1],"sourceBlockIds":["p1-b1","p1-b2","p1-b3"],"materialRoles":material_roles,"stem":stem,"options":[],"parts":[],"answer":answer,"solution":"","sectionIds":[],"task":{"label":"模拟图表读取"},"primaryKnowledgeUids":[],"solutionPaths":[],"knowledgeUids":[],"knowledgeTopics":[],"review":{"status":"ready","confidence":"high","summary":"模拟回归：对照原图和表格核对题面，原卷无参考答案解析。","issues":[],"evidencePages":[1]}}]});
    if context["sourceBatch"].is_object() {
        result["questions"][0]["questionId"]=context["sourceBatch"]["expectedQuestions"][0]["questionId"].clone();
    }
    result
}
fn server(mode: usize) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let mode = Arc::new(AtomicUsize::new(mode));
    let calls = Arc::new(Mutex::new(vec![]));
    let contexts = Arc::new(Mutex::new(vec![]));
    let stop = Arc::new(AtomicBool::new(false));
    let cancel = Arc::new(AtomicBool::new(false));
    let model_cancel = cancel.clone();
    let (m, c, x, st, b) = (
        mode.clone(),
        calls.clone(),
        contexts.clone(),
        stop.clone(),
        base.clone(),
    );
    let thread = std::thread::spawn(move || {
        while !st.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(10)))
                        .unwrap();
                    let mut bytes = vec![];
                    let mut buf = [0; 8192];
                    let split = loop {
                        let n = stream.read(&mut buf).unwrap();
                        if n == 0 {
                            return;
                        }
                        bytes.extend_from_slice(&buf[..n]);
                        if let Some(p) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                            break p + 4;
                        }
                    };
                    let head = String::from_utf8_lossy(&bytes[..split]).to_string();
                    let length = head
                        .lines()
                        .find_map(|l| {
                            l.to_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|v| v.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    while bytes.len() < split + length {
                        let n = stream.read(&mut buf).unwrap();
                        if n == 0 {
                            break;
                        }
                        bytes.extend_from_slice(&buf[..n]);
                    }
                    let route = head
                        .lines()
                        .next()
                        .unwrap()
                        .split_whitespace()
                        .nth(1)
                        .unwrap()
                        .to_owned();
                    c.lock().unwrap().push(route.clone());
                    let mode = m.load(Ordering::SeqCst);
                    let(status,body)=match route.as_str(){
            "/ocr/jobs" if mode==OCR_FAIL=>(503,br#"{"code":500,"msg":"simulated OCR failure"}"#.to_vec()),
            "/ocr/jobs"=>(200,serde_json::to_vec(&json!({"code":0,"data":{"jobId":"simulated-job"}})).unwrap()),
            "/ocr/jobs/simulated-job"=>(200,serde_json::to_vec(&json!({"code":0,"data":{"state":"done","resultUrl":{"jsonUrl":format!("{b}/result.jsonl")},"extractProgress":{"totalPages":if mode==PAGE_MISMATCH{2}else{1}}}})).unwrap()),
            "/result.jsonl"=>(200,serde_json::to_vec(&layout(&b,mode)).unwrap()),
            "/page.png"=>(200,page_png()),
            "/v1/models"=>(200,serde_json::to_vec(&json!({"data":[{"id":"simulated-import-model"}]})).unwrap()),
            "/v1/chat/completions"=>{
                let request:Value=serde_json::from_slice(&bytes[split..]).unwrap();
                let input=&request["messages"][1]["content"];
                let input_text=input.as_str().or_else(||input.as_array().and_then(|a|a.iter().find(|v|v["type"]=="text")).and_then(|v|v["text"].as_str())).unwrap();
                let context:Value=serde_json::from_str(input_text).unwrap();
                let index=context["blockColumns"].is_array();
                let source_batch=context["sourceBatch"].is_object();
                let request_number={let mut contexts=x.lock().unwrap();contexts.push(context.clone());contexts.iter().filter(|c|c["sourceBatch"].is_object()).count()};
                if mode==LLM_FAIL {(503,br#"{"error":{"message":"simulated LLM failure"}}"#.to_vec())}
                else {
                    let invalid=source_batch&&(mode==INVALID_JSON_ALWAYS||mode==INVALID_JSON_CANCEL||(mode==INVALID_JSON_ONCE&&request_number==1));
                    let proposal_mode=if mode==MISSING_FIGURE_ONCE&&request_number==1 {MISSING_FIGURE}else{mode};
                    let mut candidate=if index {
                        json!({"questions":[{"sourceLabel":"1","questionType":"fill_blank","sourceBlockIds":["p1-b1","p1-b2","p1-b3"]}],"sharedBlockIds":[],"documentBlockIds":[]})
                    }else if source_batch {proposal(&context,proposal_mode)}else if request["messages"][0]["content"].as_str().is_some_and(|t|t.contains("独立课堂教学生成")) {
                        json!({"questions":rows(&context["questions"]).iter().map(|q|json!({"questionId":q["questionId"],"answer":"模拟教学答案2","difficultyAssessment":{"level":"easy_medium","basis":"模拟回归：读取图表后进行常规数据转换。"},"teachingSolution":"模拟课堂讲解：由题意，$1+1=2$。","teachingFocusSchemaVersion":2,"teachingFocus":{"examFocus":"模拟图表读取与运算。","studentRequirements":["能读取原图和表格的数据。"]},"issues":[]})).collect::<Vec<_>>()})
                    }else if context["questions"].is_array() {
                        json!({"questions":rows(&context["questions"]).iter().map(|q|json!({"questionId":q["questionId"],"task":{"label":"模拟图表主考信息"},"difficultyAssessment":{"level":"easy_medium","basis":"模拟图表题需要一次常规数据转换，保留未知解法。","rubricVersion":"content-demand-v1"},"knowledgeSchemaVersion":2,"primaryKnowledgeUids":[],"solutionPaths":[]})).collect::<Vec<_>>()})
                    }else{proposal(&context,proposal_mode)};
                    if source_batch&&mode==MISSING_FIGURE_ONCE&&request_number==1 {candidate["questions"][0]["sourceBlockIds"]=json!(["p1-b1","p1-b3"]);}
                    let truncated=source_batch&&mode==TRUNCATED_OUTPUT;
                    let content=if invalid {INVALID_MODEL_JSON.to_owned()}else if truncated {"{\"questions\":[".to_owned()}else{candidate.to_string()};
                    if source_batch&&mode==INVALID_JSON_CANCEL {model_cancel.store(true,Ordering::SeqCst);}
                    if request["stream"]==true {
                        (200,format!("data: {}\n\ndata: [DONE]\n\n",json!({"choices":[{"delta":{"content":content},"finish_reason":if truncated{"length"}else{"stop"}}]})).into_bytes())
                    }else{
                        (200,serde_json::to_vec(&json!({"choices":[{"finish_reason":if truncated {"length"}else{"stop"},"message":{"content":content}}]})).unwrap())
                    }
                }
            },
            _=>(404,b"unexpected simulated route".to_vec())
        };
                    write!(stream,"HTTP/1.1 {status} simulated\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).unwrap();
                    let _ = stream.write_all(&body);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5))
                }
                Err(e) => panic!("simulated listener: {e}"),
            }
        }
    });
    Server {
        base,
        mode,
        calls,
        contexts,
        cancel,
        stop,
        thread: Some(thread),
    }
}
struct Fixture {
    dir: tempfile::TempDir,
    store: Store,
    model: ModelClient,
    server: Server,
}
fn fixture(mode: usize, with_ocr: bool) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path(), &crate::bank::tests::seed()).unwrap();
    std::fs::write(dir.path().join("model-settings.json"), b"{}").unwrap();
    let server = server(mode);
    let mut model = ModelClient::open(dir.path()).unwrap();
    model.save(&json!({"baseUrl":format!("{}/v1",server.base),"model":"simulated-import-model","apiKey":"simulated-only-llm-key"})).unwrap();
    if with_ocr {
        let mut ocr = OcrSettings::open(dir.path()).unwrap();
        ocr.save(&json!({"expectedRevision":ocr.public_settings()["revision"],"baseUrl":format!("{}/ocr/jobs",server.base),"model":"PaddleOCR-VL-1.6","apiKey":"simulated-only-ocr-key"})).unwrap();
    }
    Fixture {
        dir,
        store,
        model,
        server,
    }
}
fn call(f: &mut Fixture, action: &str, payload: &Value) -> Value {
    dispatch(
        &mut f.store,
        &f.model,
        action,
        payload,
        &AtomicBool::new(false),
    )
    .unwrap()
    .unwrap()
}
fn upload(f: &mut Fixture) -> Value {
    call(f,"import_prepare",&json!({"operationId":uuid::Uuid::new_v4().to_string(),"filename":"模拟上传回归.pdf","contentBase64":base64::engine::general_purpose::STANDARD.encode(pdf())}))["import"].clone()
}
#[test]
fn simulated_paddle_metadata_supplement_keeps_original_graph_table_review_and_never_repeats_ocr() {
    let mut f = fixture(SUCCESS, true);
    let record = upload(&mut f);
    assert_eq!(record["status"], "pending_review");
    let reviewed = call(&mut f, "import_review_save", &review_payload(&record))["import"].clone();
    let original = reviewed["questions"][0].clone();
    let after=structured::step(&f.store,&f.model,&json!({"importId":reviewed["importId"],"operationId":"simulated-paddle-supplement","expectedRevision":reviewed["revision"],"questionIds":[original["questionId"]],"supplementOnly":true}),&AtomicBool::new(false)).unwrap()["import"].clone();
    assert_eq!(
        after["questions"][0]["annotationStatus"], "succeeded",
        "{after}"
    );
    assert_eq!(
        after["questions"][0]["difficultyAssessment"]["level"],
        "easy_medium"
    );
    for field in [
        "stem",
        "options",
        "parts",
        "answer",
        "solution",
        "sourceIdentity",
        "sourceBlockIds",
        "sourceMaterialRequirements",
        "sourceMaterialRoles",
        "student",
        "teacher",
        "assetPayloads",
        "reviewDecision",
        "reviewChecks",
        "reviewBasis",
    ] {
        assert_eq!(
            after["questions"][0][field], original[field],
            "Paddle supplement changed {field}"
        );
    }
    assert_eq!(after["ocrSource"], reviewed["ocrSource"]);
    paddle::verify_audit(&f.store, &after).unwrap();
    assert_eq!(f.server.count("/ocr/jobs"), 1);
    assert_eq!(f.server.count("/v1/chat/completions"), 4); // index, source, teaching, metadata
    assert_eq!(after["questions"][0]["answer"], "");
    assert_eq!(after["questions"][0]["solution"], "");
    assert_eq!(after["questions"][0]["solutionPaths"], json!([]));
}
fn retry(f: &mut Fixture, record: &Value) -> Value {
    call(f,"import_prepare",&json!({"operationId":uuid::Uuid::new_v4().to_string(),"importId":record["importId"],"expectedRevision":record["revision"]}))["import"].clone()
}
#[test]
fn normal_publication_rechecks_recovered_source_before_any_bank_write() {
    let mut f=fixture(SUCCESS,true);let original=upload(&mut f);
    let before=hash_json(&f.store.bank.config().unwrap());
    let original_calls=f.server.count("/v1/chat/completions");
    let mut forged=original.clone();
    forged["sourceMaterialSupplement"]=json!({"version":"source-material-supplement-v1","status":"completed"});
    f.store.put_document("imports",s(&forged,"importId"),&forged).unwrap();
    let payload=json!({"importId":forged["importId"],"expectedRevision":forged["revision"],"operationId":"simulated-forged-material-checkpoint","acknowledgeReview":true});
    assert_eq!(publish(&f.store,&payload,&AtomicBool::new(false)).unwrap_err().code,"source_checkpoint_changed");
    assert_eq!(build_manifest(&f.store,&forged).unwrap_err().code,"source_checkpoint_changed");
    assert_eq!(hash_json(&f.store.bank.config().unwrap()),before);
    assert_eq!(f.server.count("/v1/chat/completions"),original_calls);
    for malformed in [json!({}),json!("invalid"),json!(false)] {
        let mut broken=original.clone();broken["sourceResponseReplays"]=malformed;
        assert_eq!(verify_recovered_source_for_publication(&f.store,&broken).unwrap_err().code,"source_checkpoint_changed");
    }

    let mut replay=original.clone();
    replay["sourceResponseReplays"]=json!([{"status":"succeeded"}]);
    let request=f.store.data_dir.join(s(&replay["sourceStructuring"]["planAttempts"][0]["audit"],"requestRelativePath"));
    std::fs::write(request,b"{}").unwrap();
    f.store.put_document("imports",s(&replay,"importId"),&replay).unwrap();
    let payload=json!({"importId":replay["importId"],"expectedRevision":replay["revision"],"operationId":"simulated-damaged-source-request","acknowledgeReview":true});
    assert_eq!(publish(&f.store,&payload,&AtomicBool::new(false)).unwrap_err().code,"source_checkpoint_changed");
    assert_eq!(hash_json(&f.store.bank.config().unwrap()),before);
    assert_eq!(f.server.count("/v1/chat/completions"),original_calls);
}
fn approved(record: &Value) -> Value {
    let mut questions = record["questions"].clone();
    for q in questions.as_array_mut().unwrap() {
        q["reviewDecision"] = json!("approve");
        q["reviewBasis"] = json!("模拟回归：显式对照原件，空白单元格和原图已核对，原卷无参考解。 ");
        q["reviewChecks"] = json!({"sourceMatched":true,"answerChecked":true,"solutionChecked":true,"formulaChecked":true});
    }
    questions
}
fn review_payload(record: &Value) -> Value {
    json!({"operationId":uuid::Uuid::new_v4().to_string(),"importId":record["importId"],"expectedRevision":record["revision"],"questions":approved(record)})
}

#[test]
fn simulated_upload_preserves_graph_table_and_null_order_through_review_publish_and_offline_reopen()
{
    let mut f = fixture(SUCCESS, true);
    let record = upload(&mut f);
    assert_eq!(record["status"], "pending_review", "{record:#}");
    assert_eq!(f.server.count("/ocr/jobs"), 1);
    assert_eq!(f.server.count("/v1/chat/completions"), 3); // index + source + independent classroom draft
    assert_eq!(f.server.count("/v1/models"), 1);
    assert_eq!(
        record["ocrSource"]["pages"][0]["blocks"][1]["order"],
        Value::Null
    );
    assert_eq!(read_source(&f.store, &record).unwrap(), pdf());
    let q = &record["questions"][0];
    let contexts = f.server.contexts.lock().unwrap();
    assert_eq!(contexts.len(), 3);
    assert!(contexts[0]["blockColumns"].is_array());
    assert_eq!(contexts[1]["document"]["provider"], "paddleocr");
    assert_eq!(
        contexts[1]["document"]["pages"][0]["blocks"][1]["order"],
        Value::Null
    );
    let model_context = contexts[1].to_string();
    assert!(!model_context.contains("contentBase64"));
    assert!(!model_context.contains("simulated-only-ocr-key"));
    drop(contexts);
    assert_eq!(q["reviewDecision"], "pending");
    assert_eq!(rows(&q["student"]["assets"]).len(), 1);
    assert!(s(q, "stem").contains("<td></td>"));
    assert_eq!(rows(&q["assetPayloads"]).len(), 1);
    assert_eq!(f.store.bank.questions().unwrap().len(), 1);
    let reviewed = call(&mut f, "import_review_save", &review_payload(&record))["import"].clone();
    let published = call(
        &mut f,
        "import_publish",
        &json!({"operationId":uuid::Uuid::new_v4().to_string(),"importId":reviewed["importId"],"expectedRevision":reviewed["revision"],"acknowledgeReview":true}),
    );
    assert_eq!(published["import"]["status"], "published");
    assert_eq!(published["publication"]["addedQuestions"], 1);
    let published_q = f.store.bank.question(s(q, "questionId")).unwrap();
    assert_eq!(rows(&published_q["student"]["assets"]).len(), 1);
    assert!(s(&published_q["student"], "stem").contains("<td></td>"));
    crate::bank::verify_embedded_assets(&published_q).unwrap();
    f.server.close();
    let before = f.server.calls.lock().unwrap().len();
    let dir = f.dir.path().to_owned();
    drop(f.store);
    drop(f.model);
    let mut store = Store::open(&dir, &crate::bank::tests::seed()).unwrap();
    let model = ModelClient::open(&dir).unwrap();
    let history = dispatch(
        &mut store,
        &model,
        "import_get",
        &json!({"importId":record["importId"]}),
        &AtomicBool::new(false),
    )
    .unwrap()
    .unwrap();
    assert_eq!(history["import"], published["import"]);
    paddle::verify_audit(&store, &history["import"]).unwrap();
    assert_eq!(f.server.calls.lock().unwrap().len(), before);
}
#[test]
fn simulated_ocr_configuration_gate_precedes_decode_write_and_network() {
    let mut f = fixture(SUCCESS, false);
    let err = dispatch(
        &mut f.store,
        &f.model,
        "import_prepare",
        &json!({"filename":"bad.pdf","contentBase64":"not base64"}),
        &AtomicBool::new(false),
    )
    .unwrap_err();
    assert_eq!(err.code, "ocr_not_configured");
    assert!(!f.dir.path().join("imports").exists());
    assert!(f.store.list_documents("imports").unwrap().is_empty());
    assert!(f.server.calls.lock().unwrap().is_empty());
}
#[test]
fn simulated_ocr_failure_preserves_original_and_explicit_retry_recovers() {
    let mut f = fixture(OCR_FAIL, true);
    let failed = upload(&mut f);
    assert_eq!(failed["status"], "failed");
    assert_eq!(failed["error"]["code"], "ocr_http_error");
    assert_eq!(read_source(&f.store, &failed).unwrap(), pdf());
    assert_eq!(f.server.count("/v1/chat/completions"), 0);
    let audit = f.dir.path().join(s(&failed["ocrAttempt"], "relativePath"));
    assert!(audit.join("001-submit.json").is_file());
    assert!(audit.join("002-failure.json").is_file());
    f.server.mode.store(SUCCESS, Ordering::SeqCst);
    let recovered = retry(&mut f, &failed);
    assert_eq!(recovered["status"], "pending_review", "{recovered:#}");
    assert_eq!(f.server.count("/ocr/jobs"), 2);
}
#[test]
fn simulated_llm_failure_preserves_ocr_and_retry_reuses_it_without_uploading_again() {
    let mut f = fixture(LLM_FAIL, true);
    let failed = upload(&mut f);
    assert_eq!(failed["status"], "failed");
    assert!(failed["ocrSource"].is_object());
    assert_eq!(read_source(&f.store, &failed).unwrap(), pdf());
    paddle::verify_audit(&f.store, &failed).unwrap();
    let first = failed["ocrSource"].clone();
    assert_eq!(f.server.count("/ocr/jobs"), 1);
    f.server.mode.store(SUCCESS, Ordering::SeqCst);
    let recovered = retry(&mut f, &failed);
    assert_eq!(recovered["status"], "pending_review", "{recovered:#}");
    assert_eq!(recovered["ocrSource"], first);
    assert_eq!(f.server.count("/ocr/jobs"), 1);
    assert_eq!(f.server.count("/v1/chat/completions"), 4);
    assert_eq!(rows(&recovered["sourceStructuring"]["planAttempts"]).len(), 2);
    assert_eq!(source_batch_attempts(&recovered).len(), 1);
}
fn source_batch_attempts(record:&Value)->Vec<Value>{rows(&record["sourceStructuring"]["batches"][0]["attempts"])}
fn audited_attempt_files(f: &Fixture, attempt: &Value) -> Vec<(PathBuf, Vec<u8>)> {
    [("requestRelativePath", "requestSha256"),("responseRelativePath", "responseSha256")]
    .into_iter()
    .map(|(path_field, hash_field)| {
        let relative = s(&attempt["audit"], path_field);
        assert!(!relative.is_empty(), "missing {path_field}: {attempt:#}");
        let path = f.dir.path().join(relative);
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(sha(&bytes), s(&attempt["audit"], hash_field));
        (path, bytes)
    })
    .collect()
}
#[test]
fn simulated_invalid_source_json_stops_without_ds_regeneration_and_explicit_retry_reuses_ocr() {
    let mut f = fixture(INVALID_JSON_ONCE, true);
    let failed = upload(&mut f);
    assert_eq!(failed["status"], "failed");
    assert_eq!(failed["error"]["code"], "model_output_invalid_json");
    assert_eq!(f.server.count("/v1/chat/completions"), 2);
    assert!(rows(&failed["questions"]).is_empty());
    let original_files=audited_attempt_files(&f,&source_batch_attempts(&failed)[0]);
    paddle::verify_audit(&f.store,&failed).unwrap();
    let recovered=retry(&mut f,&failed);
    assert_eq!(recovered["status"],"pending_review","{recovered:#}");
    assert_eq!(f.server.count("/ocr/jobs"),1);
    assert_eq!(f.server.count("/v1/chat/completions"),4);
    assert_eq!(source_batch_attempts(&recovered).len(),2);
    assert!(f.server.contexts.lock().unwrap().iter().all(|c|c.get("formatRetry").is_none()));
    for (path,bytes) in original_files {assert_eq!(std::fs::read(path).unwrap(),bytes);}
}
#[test]
fn simulated_missing_source_figure_stops_without_automatic_regeneration_and_keeps_original_audit() {
    let mut f=fixture(MISSING_FIGURE_ONCE,true);
    let failed=upload(&mut f);
    assert_eq!(failed["status"],"failed");
    assert_eq!(failed["error"]["code"],"source_batch_scope"); // Missing original figure block fails before binding.
    assert_eq!(f.server.count("/v1/chat/completions"),2);
    assert!(rows(&failed["questions"]).is_empty());
    let original_files=audited_attempt_files(&f,&source_batch_attempts(&failed)[0]);
    let recovered=retry(&mut f,&failed);
    assert_eq!(recovered["status"],"pending_review","{recovered:#}");
    assert_eq!(f.server.count("/ocr/jobs"),1);
    assert_eq!(f.server.count("/v1/chat/completions"),4);
    assert_eq!(rows(&recovered["questions"][0]["student"]["assets"]).len(),1);
    for (path,bytes) in original_files {assert_eq!(std::fs::read(path).unwrap(),bytes);}
}
#[test]
fn simulated_invalid_source_json_stops_after_one_call_and_keeps_zero_questions() {
    let mut f = fixture(INVALID_JSON_ALWAYS, true);
    let record = upload(&mut f);
    assert_eq!(record["status"], "failed", "{record:#}");
    assert_eq!(record["error"]["code"], "model_output_invalid_json");
    assert!(rows(&record["questions"]).is_empty());
    assert_eq!(f.server.count("/ocr/jobs"), 1);
    assert_eq!(f.server.count("/v1/chat/completions"), 2);
    assert_eq!(f.store.bank.questions().unwrap().len(), 1);
    assert_eq!(read_source(&f.store, &record).unwrap(), pdf());
    paddle::verify_audit(&f.store, &record).unwrap();
    let attempts = source_batch_attempts(&record);
    assert_eq!(attempts.len(), 1);
    for (i, attempt) in attempts.iter().enumerate() {
        assert_eq!(i, 0); // One failed source batch, separate successful index retained.
        assert_eq!(attempt["status"], "failed");
        assert_eq!(attempt["error"]["code"], "model_output_invalid_json");
        let files = audited_attempt_files(&f, attempt);
        let response: Value = serde_json::from_slice(&files[1].1).unwrap();
        assert_eq!(
            response["choices"][0]["message"]["content"],
            INVALID_MODEL_JSON
        );
    }
}
#[test]
fn simulated_truncation_is_not_treated_as_json_format_retry() {
    let mut f = fixture(TRUNCATED_OUTPUT, true);
    let record = upload(&mut f);
    assert_eq!(record["status"], "failed");
    assert_eq!(record["error"]["code"], "model_output_truncated");
    assert!(rows(&record["questions"]).is_empty());
    assert_eq!(f.server.count("/ocr/jobs"), 1);
    assert_eq!(f.server.count("/v1/chat/completions"), 2);
    assert_eq!(source_batch_attempts(&record).len(), 1);
    audited_attempt_files(&f, &source_batch_attempts(&record)[0]);
}
#[test]
fn simulated_cancellation_while_invalid_response_arrives_does_not_start_regeneration() {
    let mut f = fixture(INVALID_JSON_CANCEL, true);
    let record = dispatch(
        &mut f.store,
        &f.model,
        "import_prepare",
        &json!({"operationId":uuid::Uuid::new_v4().to_string(),"filename":"模拟取消回归.pdf","contentBase64":base64::engine::general_purpose::STANDARD.encode(pdf())}),
        &f.server.cancel,
    ).unwrap().unwrap()["import"].clone();
    assert_eq!(record["status"], "failed", "{record:#}");
    assert!(matches!(
        s(&record["error"], "code"),
        "cancelled" | "model_output_invalid_json"
    ));
    assert!(rows(&record["questions"]).is_empty());
    assert_eq!(f.server.count("/ocr/jobs"), 1);
    assert_eq!(f.server.count("/v1/chat/completions"), 2);
    assert_eq!(source_batch_attempts(&record).len(), 1);
    assert_eq!(f.store.bank.questions().unwrap().len(), 1);
}
#[test]
fn simulated_unknown_missing_graph_table_and_teacher_asset_cannot_reach_review() {
    for (mode, code, model_calls) in [
        (UNKNOWN_ASSET, "ocr_asset_unresolved", 2),
        (MISSING_FIGURE, "ocr_material_unassigned", 2),
        (TABLE_LOSS, "ocr_material_unassigned", 2),
        (TEACHER_LEAK, "ocr_material_role", 2),
        (MISSING_MATERIAL_ROLES, "ocr_material_role", 2),
        (FORGED_MATERIAL_BLOCK, "source_batch_scope", 2),
        (UNRELATED_MATERIAL_BLOCK, "ocr_material_role", 2),
        (SOURCE_PAGE_AS_QUESTION, "ocr_asset_unresolved", 2),
    ] {
        let mut f = fixture(mode, true);
        let record = upload(&mut f);
        assert_eq!(record["status"], "failed", "mode {mode}: {record:#}");
        assert_eq!(record["error"]["code"], code, "mode {mode}: {record:#}");
        assert!(rows(&record["questions"]).is_empty());
        assert!(record["ocrSource"].is_object());
        assert_eq!(f.store.bank.questions().unwrap().len(), 1);
        assert_eq!(f.server.count("/ocr/jobs"), 1);
        assert_eq!(
            f.server.count("/v1/chat/completions"),
            model_calls,
            "mode {mode}"
        );
        assert_eq!(source_batch_attempts(&record).len(), 1);
    }
}
#[test]
fn simulated_source_title_does_not_replace_model_material_roles_and_roles_cannot_be_rewritten() {
    let mut f = fixture(MISLEADING_ANSWER_HEADING, true);
    let record = upload(&mut f);
    assert_eq!(record["status"],"pending_review","{record:#}");
    assert!(rows(&record["questions"][0]["sourceMaterialRoles"]).iter().all(|assignment|assignment["role"]=="student"));
    assert_eq!(rows(&record["questions"][0]["student"]["assets"]).len(),1);
    assert_eq!(f.server.count("/v1/chat/completions"),3);
    let mut payload = review_payload(&record);
    payload["questions"][0]["sourceMaterialRoles"][0]["role"] = json!("teacher");
    assert_eq!(dispatch(&mut f.store,&f.model,"import_review_save",&payload,&AtomicBool::new(false)).unwrap_err().code,"immutable_source");
    assert_eq!(f.store.document("imports",s(&record,"importId")).unwrap(),record);
}
#[test]
fn simulated_reported_page_count_mismatch_cannot_be_approved_away() {
    let mut f = fixture(PAGE_MISMATCH, true);
    let record = upload(&mut f);
    assert_eq!(record["status"], "pending_review", "{record:#}");
    assert!(
        rows(&record["sourceIssues"])
            .iter()
            .any(|i| i["code"] == "ocr_missing_pages" && i["blocking"] == true)
    );
    assert_eq!(
        review_save(&f.store, &review_payload(&record))
            .unwrap_err()
            .code,
        "source_content_unresolved"
    );
    assert_eq!(f.store.bank.questions().unwrap().len(), 1);
}
#[test]
fn simulated_source_manifest_or_asset_tamper_blocks_confirmation_and_publication() {
    for manifest in [true, false] {
        let mut f = fixture(SUCCESS, true);
        let record = upload(&mut f);
        assert_eq!(record["status"], "pending_review", "{record:#}");
        let path = if manifest {
            s(&record["ocrSource"], "manifestRelativePath")
        } else {
            s(&record["ocrSource"]["assets"][0], "relativePath")
        };
        std::fs::write(f.dir.path().join(path), b"simulated tamper").unwrap();
        assert_eq!(
            review_save(&f.store, &review_payload(&record))
                .unwrap_err()
                .code,
            "source_changed"
        );
        assert_eq!(publish(&f.store,&json!({"operationId":uuid::Uuid::new_v4().to_string(),"importId":record["importId"],"expectedRevision":record["revision"],"acknowledgeReview":true}),&AtomicBool::new(false)).unwrap_err().code,"source_changed");
        assert_eq!(f.store.bank.questions().unwrap().len(), 1);
    }
}

#[test]
fn simulated_docx_derived_pdf_preview_preserves_original_and_rejects_path_or_hash_changes() {
    // This creates an explicit test association between independent fixtures.
    // It does not run Office or claim that these bytes were converted by it.
    let mut f = fixture(SUCCESS, false);
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    archive.start_file("[Content_Types].xml", options).unwrap();
    archive
        .write_all(
            br#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>"#,
        )
        .unwrap();
    archive.start_file("word/document.xml", options).unwrap();
    archive.write_all("<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>模拟 DOCX 来源，对照入口回归，不是转换质量证据。</w:t></w:r></w:p></w:body></w:document>".as_bytes()).unwrap();
    let original = archive.finish().unwrap().into_inner();
    let source = save_source(&f.store, "simulated-docx-derived-source", "docx", &original).unwrap();
    let source_path = f.dir.path().join(s(&source, "relativePath"));
    let derived = pdf();
    let derived_relative = "imports/simulated-docx-derived-source/converted-fixture.pdf";
    let derived_path = f.dir.path().join(derived_relative);
    std::fs::write(&derived_path, &derived).unwrap();
    let record = json!({"importId":"simulated-docx-derived-source","filename":"模拟来源对照.docx","revision":1,"status":"failed","source":source,"renderedPdf":{"relativePath":derived_relative,"sha256":sha(&derived),"sourceSha256":sha(&original)},"questions":[],"sourceIssues":[],"publishedQuestionIds":[],"publicationHistory":[],"operations":[],"updatedAt":"2026-10-20T00:00:00Z"});
    save_cas(&f.store, None, &record).unwrap();
    let payload = json!({"importId":record["importId"]});
    let preview = call(&mut f, "import_original_read", &payload);
    assert_eq!(preview["derivedFromDocx"], true);
    assert!(s(&preview, "filename").ends_with("（转换）.pdf"));
    assert_eq!(preview["sha256"], sha(&derived));
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(s(&preview, "dataBase64"))
            .unwrap(),
        derived
    );
    assert_eq!(std::fs::read(&source_path).unwrap(), original);
    assert_eq!(read_source(&f.store, &record).unwrap(), original);
    assert_eq!(
        sha(&std::fs::read(&source_path).unwrap()),
        record["source"]["sha256"]
    );
    assert!(f.server.calls.lock().unwrap().is_empty());
    std::fs::write(f.dir.path().join("outside-imports.pdf"), &derived).unwrap();
    for kind in [
        "outside-imports",
        "replaced-pdf",
        "wrong-source-hash",
        "replaced-docx",
    ] {
        let mut changed = record.clone();
        match kind {
            "outside-imports" => {
                changed["renderedPdf"]["relativePath"] = json!("outside-imports.pdf")
            }
            "replaced-pdf" => {
                std::fs::write(&derived_path, b"%PDF-simulated swapped derived file").unwrap()
            }
            "wrong-source-hash" => changed["renderedPdf"]["sourceSha256"] = json!("f".repeat(64)),
            "replaced-docx" => {
                std::fs::write(&source_path, b"simulated swapped DOCX file").unwrap()
            }
            _ => unreachable!(),
        }
        save_cas(&f.store, Some(&record), &changed).unwrap();
        let err = dispatch(
            &mut f.store,
            &f.model,
            "import_original_read",
            &payload,
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert_eq!(err.code, "source_changed", "{kind}");
        save_cas(&f.store, Some(&changed), &record).unwrap();
        std::fs::write(&derived_path, &derived).unwrap();
        std::fs::write(&source_path, &original).unwrap();
    }
    assert_eq!(sha(&std::fs::read(&source_path).unwrap()), sha(&original));
    assert_eq!(sha(&std::fs::read(&derived_path).unwrap()), sha(&derived));
    paddle::verify_audit(&f.store, &record).unwrap();
    assert!(f.server.calls.lock().unwrap().is_empty());
}

#[test]
fn simulated_table_deletion_can_be_saved_pending_but_cannot_be_approved_or_published() {
    for delete_entire_table in [true, false] {
        let mut f = fixture(SUCCESS, true);
        let record = upload(&mut f);
        assert_eq!(record["status"], "pending_review");
        let mut payload = review_payload(&record);
        let old = s(&payload["questions"][0], "stem");
        payload["questions"][0]["stem"] = json!(if delete_entire_table {
            old.replace(TABLE, "")
        } else {
            old.replace("<tr><td>A</td><td>3</td></tr>", "")
        });
        assert_eq!(
            review_save(&f.store, &payload).unwrap_err().code,
            "source_content_unresolved"
        );
        assert_eq!(
            f.store.document("imports", s(&record, "importId")).unwrap(),
            record
        );
        payload["questions"][0]["reviewDecision"] = json!("pending");
        let pending = review_save(&f.store, &payload).unwrap()["import"].clone();
        assert!(
            rows(&pending["questions"][0]["reviewIssues"])
                .iter()
                .any(|i| i["code"] == "ocr_material_structure_changed")
        );
        assert_eq!(
            pending["questions"][0]["sourceMaterialRequirements"],
            record["questions"][0]["sourceMaterialRequirements"]
        );
        assert_eq!(
            review_save(&f.store, &review_payload(&pending))
                .unwrap_err()
                .code,
            "source_content_unresolved"
        );
        // Simulate a persisted older/partial editor record to exercise the
        // independent publication boundary, without calling any provider.
        let mut persisted = pending.clone();
        persisted["questions"] = approved(&pending);
        save_cas(&f.store, Some(&pending), &persisted).unwrap();
        let err=publish(&f.store,&json!({"operationId":uuid::Uuid::new_v4().to_string(),"importId":persisted["importId"],"expectedRevision":persisted["revision"],"acknowledgeReview":true}),&AtomicBool::new(false)).unwrap_err();
        assert_eq!(err.code, "source_content_unresolved");
        assert_eq!(f.store.bank.questions().unwrap().len(), 1);
        assert_eq!(f.server.count("/ocr/jobs"), 1);
        assert_eq!(f.server.count("/v1/chat/completions"), 3);
    }
}

#[test]
fn simulated_table_baseline_is_immutable_but_verified_cell_text_and_values_remain_editable() {
    let mut f = fixture(SUCCESS, true);
    let record = upload(&mut f);
    assert_eq!(record["status"], "pending_review");
    let baseline = record["questions"][0]["sourceMaterialRequirements"].clone();
    assert!(baseline.is_object());
    let mut tampered = review_payload(&record);
    tampered["questions"][0]["sourceMaterialRequirements"]["studentTables"] = json!([]);
    assert_eq!(
        review_save(&f.store, &tampered).unwrap_err().code,
        "immutable_source"
    );
    let mut corrected = review_payload(&record);
    corrected["questions"][0]["stem"] = json!(
        s(&corrected["questions"][0], "stem")
            .replace("模拟上传回归", "模拟教师纠正OCR文字")
            .replace("模拟组别", "核对分组")
            .replace("<td>3</td>", "<td>4</td>")
    );
    let reviewed = review_save(&f.store, &corrected).unwrap()["import"].clone();
    assert_eq!(reviewed["questions"][0]["reviewDecision"], "approve");
    assert_eq!(
        reviewed["questions"][0]["sourceMaterialRequirements"],
        baseline
    );
    assert!(s(&reviewed["questions"][0], "stem").contains("<td>4</td>"));
    let published=publish(&f.store,&json!({"operationId":uuid::Uuid::new_v4().to_string(),"importId":reviewed["importId"],"expectedRevision":reviewed["revision"],"acknowledgeReview":true}),&AtomicBool::new(false)).unwrap();
    assert_eq!(published["publication"]["addedQuestions"], 1);
    assert_eq!(published["import"]["status"], "published");
}

#[test]
fn simulated_original_question_material_cannot_hide_in_model_answer_to_satisfy_coverage() {
    for (mode, code) in [
        (
            ORIGINAL_GRAPH_MOVED_TO_ANSWER,
            "ocr_material_role",
        ),
        (ORIGINAL_TABLE_MOVED_TO_ANSWER, "ocr_material_unassigned"),
    ] {
        let mut f = fixture(mode, true);
        let failed = upload(&mut f);
        assert_eq!(failed["status"], "failed");
        assert_eq!(failed["error"]["code"], code);
        assert!(failed["ocrSource"].is_object());
        assert!(rows(&failed["questions"]).is_empty());
        assert_eq!(f.store.bank.questions().unwrap().len(), 1);
    }
}
