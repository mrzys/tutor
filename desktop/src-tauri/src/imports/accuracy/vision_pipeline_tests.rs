//! Local scripted HTTP regressions for actual image bytes and role isolation.
//! This directly supplies simulated source material; it does not validate OCR
//! quality, mathematical correctness, or a real provider's vision capability.
use super::tests::{Provider, Scenario, fixture};
use super::*;
use base64::Engine;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, io::Cursor};

fn png_asset(id: &str, role: &str, color: [u8; 4]) -> Value {
    let image = image::RgbaImage::from_pixel(32, 24, image::Rgba(color));
    let mut bytes = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    let bytes = bytes.into_inner();
    json!({"id":id,"role":role,"page":1,"sha256":format!("{:x}",Sha256::digest(&bytes)),"mime":"image/png","contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes)})
}

fn image_fixture(
    provider: &Provider,
) -> (tempfile::TempDir, Store, ModelClient, Value, Vec<Value>) {
    let (directory, store, model, mut record) = fixture(provider);
    let assets = vec![
        png_asset("student-original-diagram", "student", [255, 0, 0, 255]),
        png_asset("reference-answer-diagram", "teacher", [0, 0, 255, 255]),
        png_asset("original-page-with-answer", "source_page", [0, 255, 0, 255]),
    ];
    let q = &mut record["questions"][0];
    q["student"]["assets"] = json!([{"assetId":assets[0]["id"],"sha256":assets[0]["sha256"]}]);
    q["teacher"]["assets"] = json!([{"assetId":assets[1]["id"],"sha256":assets[1]["sha256"]}]);
    // Persist only the simulated question's asset identities. process_question
    // receives actual source images explicitly and performs real HTTP requests.
    store
        .put_document("imports", s(&record, "importId"), &record)
        .unwrap();
    (directory, store, model, record, assets)
}

fn image_hashes(body: &Value) -> BTreeSet<String> {
    rows(&body["messages"][1]["content"])
        .iter()
        .filter(|block| block["type"] == "image_url")
        .map(|block| {
            let url = block["image_url"]["url"].as_str().unwrap();
            let (header, data) = url.split_once(',').unwrap();
            assert_eq!(header, "data:image/png;base64");
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data)
                .unwrap();
            let image = image::load_from_memory(&bytes).unwrap();
            assert_eq!((image.width(), image.height()), (32, 24));
            format!("{:x}", Sha256::digest(bytes))
        })
        .collect()
}

fn context(body: &Value) -> Value {
    let content = &body["messages"][1]["content"];
    serde_json::from_str(
        content
            .as_str()
            .or_else(|| content[0]["text"].as_str())
            .unwrap(),
    )
    .unwrap()
}

#[test]
fn combined_requests_deliver_real_crops_and_review_original_page_without_a_blind_request() {
    let provider = Provider::start(Scenario::Clean);
    let (_dir, store, model, mut record) = super::two_model_tests::combined_fixture(&provider);
    let assets = vec![
        png_asset("merged-student-crop", "student", [255, 0, 0, 255]),
        png_asset("merged-reference-crop", "teacher", [0, 0, 255, 255]),
        png_asset("merged-original-page", "source_page", [0, 255, 0, 255]),
    ];
    let q = &mut record["questions"][0];
    q["student"]["assets"] = json!([{"assetId":assets[0]["id"],"sha256":assets[0]["sha256"]}]);
    q["teacher"]["assets"] = json!([{"assetId":assets[1]["id"],"sha256":assets[1]["sha256"]}]);
    let q = q.clone();
    let mut value = json!({"sourceSha256":source_sha(&q),"repairCalls":0});
    let catalogue = applicable_catalogue(&store, &record).unwrap();
    runner::process_question(
        &store,
        &model,
        &record,
        &q,
        &mut value,
        &rows(&record["extractedPages"]),
        &assets,
        &catalogue,
        &AtomicBool::new(false),
    )
    .unwrap();
    let sent = provider.sent();
    assert_eq!(sent.len(), 2);
    assert_eq!(
        image_hashes(&sent[0].1),
        BTreeSet::from([
            s(&assets[0], "sha256").to_owned(),
            s(&assets[1], "sha256").to_owned()
        ])
    );
    assert_eq!(
        image_hashes(&sent[1].1),
        assets
            .iter()
            .map(|asset| s(asset, "sha256").to_owned())
            .collect()
    );
    assert_eq!(context(&sent[1].1)["independentBlindSolve"], false);
    assert!(value["independent"].is_null());
    let mut missing_assets = assets.clone();
    missing_assets.remove(1);
    let mut unchanged = value.clone();
    assert_eq!(
        runner::process_question(
            &store,
            &model,
            &record,
            &q,
            &mut unchanged,
            &rows(&record["extractedPages"]),
            &missing_assets,
            &catalogue,
            &AtomicBool::new(false)
        )
        .unwrap_err()
        .code,
        "accuracy_images_required"
    );
    assert_eq!(
        provider.sent().len(),
        2,
        "missing current bytes cannot use cached claims to make extra or incomplete requests"
    );
}

#[test]
fn actual_http_images_include_original_reference_only_for_solution_and_math() {
    let provider = Provider::start(Scenario::Clean);
    let (_directory, store, model, record, assets) = image_fixture(&provider);
    let q = record["questions"][0].clone();
    let mut state = json!({"sourceSha256":source_sha(&q),"repairCalls":0});
    runner::process_question(
        &store,
        &model,
        &record,
        &q,
        &mut state,
        &rows(&record["extractedPages"]),
        &assets,
        &applicable_catalogue(&store, &record).unwrap(),
        &AtomicBool::new(false),
    )
    .unwrap();
    verify_question(&store, &record, &q).unwrap();
    let sent = provider.sent();
    assert_eq!(sent.len(), 6);
    let student = assets[0]["sha256"].as_str().unwrap().to_owned();
    let teacher = assets[1]["sha256"].as_str().unwrap().to_owned();
    let page = assets[2]["sha256"].as_str().unwrap().to_owned();
    let expected = [
        BTreeSet::from([page.clone(), student.clone(), teacher.clone()]),
        BTreeSet::from([student.clone(), teacher.clone()]),
        BTreeSet::from([student.clone()]),
        BTreeSet::from([student.clone(), teacher.clone()]),
        BTreeSet::from([student.clone()]),
        BTreeSet::from([student.clone()]),
    ];
    for (index, (_, body, _)) in sent.iter().enumerate() {
        assert_eq!(
            image_hashes(body),
            expected[index],
            "unexpected actual image bytes at stage {index}"
        );
    }
    let blind = context(&sent[2].1);
    assert_eq!(
        blind
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([
            "questionId".to_owned(),
            "student".to_owned(),
            "responseContract".to_owned()
        ])
    );
    for canary in [
        "reference-answer-canary",
        "reference-proof-canary",
        "reference-answer-diagram",
        "original-page-with-answer",
    ] {
        assert!(!sent[2].1.to_string().contains(canary));
    }
    // The saved evidence records exactly the asset identities whose bytes were
    // sent, including the teacher image used by both nonblind math stages.
    for (key, count) in [
        ("solution", 2),
        ("independent", 1),
        ("math", 2),
        ("metadata", 1),
        ("teaching", 1),
    ] {
        let saved = artifact(&store, &state[key]).unwrap();
        assert_eq!(rows(&saved["inputAssets"]).len(), count);
        assert_eq!(
            rows(&saved["inputAssets"])
                .iter()
                .map(|a| s(a, "sha256").to_owned())
                .collect::<BTreeSet<_>>(),
            match key {
                "solution" | "math" => BTreeSet::from([student.clone(), teacher.clone()]),
                _ => BTreeSet::from([student.clone()]),
            }
        );
    }
}

#[test]
fn missing_reference_image_blocks_before_solution_blind_or_math_requests() {
    let provider = Provider::start(Scenario::Clean);
    let (_directory, store, model, record, mut assets) = image_fixture(&provider);
    assets.remove(1);
    let q = record["questions"][0].clone();
    let mut state = json!({"sourceSha256":source_sha(&q),"repairCalls":0});
    let error = runner::process_question(
        &store,
        &model,
        &record,
        &q,
        &mut state,
        &rows(&record["extractedPages"]),
        &assets,
        &applicable_catalogue(&store, &record).unwrap(),
        &AtomicBool::new(false),
    )
    .unwrap_err();
    assert_eq!(error.code, "accuracy_images_required");
    let sent = provider.sent();
    assert_eq!(
        sent.len(),
        0,
        "a missing reference must be rejected before making an unsupported source-role claim"
    );
    for key in ["solution", "independent", "math", "metadata", "teaching"] {
        assert!(state[key].is_null());
    }
}

#[test]
fn complete_real_seed_directory_reaches_metadata_and_teaching_over_actual_http_within_frozen_limits()
 {
    let provider = Provider::start(Scenario::Clean);
    let (_directory, store, model, record) = fixture(&provider);
    let mut full = catalogue::production_catalogue();
    full["difficultyRubric"] =
        run_for(&store, &record).unwrap()["strategy"]["difficultyRubric"].clone();
    let projected = catalogue::snapshot(&full);
    let q = record["questions"][0].clone();
    let mut state = json!({"sourceSha256":source_sha(&q),"repairCalls":0});
    runner::process_question(
        &store,
        &model,
        &record,
        &q,
        &mut state,
        &rows(&record["extractedPages"]),
        &[],
        &full,
        &AtomicBool::new(false),
    )
    .unwrap();
    let sent = provider.sent();
    assert_eq!(sent.len(), 6);
    assert_eq!(artifact(&store, &state["catalogue"]).unwrap(), full);
    for index in [4, 5] {
        let delivered = context(&sent[index].1);
        assert_eq!(delivered["catalogue"], projected["modelInput"]);
        assert_eq!(
            rows(&delivered["catalogue"]["knowledgePoints"]["rows"]).len(),
            rows(&full["knowledgePoints"]).len()
        );
        assert_eq!(
            rows(&delivered["catalogue"]["tasks"]["rows"]).len(),
            rows(&full["tasks"]).len()
        );
        let actual = budget::estimate_input(&sent[index].1, 160_000).unwrap();
        assert!(
            actual > 32_000,
            "this must exercise the production-size input which the old cap incorrectly blocked"
        );
    }
    let run = run_for(&store, &record).unwrap();
    assert_eq!(run["operationBudget"]["maxInputTokens"], 10_000_000);
    assert_eq!(run["operationBudget"]["maxOutputTokens"], 16_000_000);
    assert_eq!(run["operationBudget"]["maxCalls"], 324);
}
