//! Isolated settings and localhost HTTP simulations, never real credentials/API.
use super::*;
use std::io::Read;
fn profile(id: &str, provider: &str, model: &str, effort: Option<&str>, key: &str) -> ModelProfile {
    let base = model_providers()["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == provider)
        .unwrap()["baseUrl"]
        .as_str()
        .unwrap()
        .to_owned();
    ModelProfile {
        id: id.into(),
        name: id.into(),
        base_url: base,
        model: model.into(),
        reasoning_effort: effort.map(str::to_owned),
        api_key: key.into(),
        protected_key: String::new(),
        warning: None,
    }
}
fn items(model: &ModelClient) -> Vec<Value> {
    model.profiles.iter().map(|p|json!({"id":p.id,"name":p.name,"baseUrl":p.base_url,"model":p.model,"reasoningEffort":p.reasoning_effort})).collect()
}
fn roles() -> Value {
    json!({"sourceParsing":"ds","teachingGeneration":"mi","teachingReview":"qw"})
}
fn accuracy_roles() -> Value {
    let mut value = roles();
    for (role, profile) in [
        ("sourceVerification", "qw"),
        ("independentSolve", "ds"),
        ("mathVerification", "qw"),
        ("teachingVerification", "ds"),
    ] {
        value[role] = json!(profile);
    }
    value
}
fn fixture(explicit: bool) -> (tempfile::TempDir, ModelClient) {
    let dir = tempfile::tempdir().unwrap();
    // Do not open an absent settings file: avoid the development .env fallback.
    let mut model = ModelClient::test_client(dir.path(), "http://127.0.0.1:1/v1");
    model.profiles = vec![
        profile(
            "ds",
            "deepseek",
            "deepseek-flash",
            Some("off"),
            "simulated-source-key",
        ),
        profile(
            "mi",
            "xiaomi",
            "mimo-v2.6-pro",
            None,
            "simulated-generation-key",
        ),
        profile(
            "qw",
            "qianwenai",
            "qwen3.8-flash",
            Some("on"),
            "simulated-review-key",
        ),
    ];
    model.active_profile_id = Some("mi".into());
    model.sync_active();
    let mut input = json!({"expectedRevision":0,"profiles":items(&model),"activeProfileId":"mi"});
    if explicit {
        input["importRoles"] = roles();
    }
    model.save(&input).unwrap();
    (dir, model)
}

fn thinking(source: Value, generation: Value, review: Value) -> Value {
    json!({"sourceParsing":source,"teachingGeneration":generation,"teachingReview":review})
}
fn override_for(model: &ModelClient, id: &str, effort: &str) -> Value {
    let profile = model.profiles.iter().find(|p| p.id == id).unwrap();
    json!({"profileId":id,"provider":model_provider(&profile.base_url),"model":profile.model,"reasoningEffort":effort})
}

#[test]
fn simulated_same_profile_purpose_thinking_is_independent_persistent_and_reaches_request_options() {
    let (dir, mut model) = fixture(true);
    let profile_before = model
        .profiles
        .iter()
        .find(|p| p.id == "ds")
        .unwrap()
        .public();
    let active_before = model.public_settings()["activeProfileId"].clone();
    let original_key = model
        .profiles
        .iter()
        .find(|p| p.id == "ds")
        .unwrap()
        .api_key
        .clone();
    let input = thinking(
        override_for(&model, "ds", "low"),
        override_for(&model, "ds", "high"),
        Value::Null,
    );
    let result=model.save(&json!({"expectedRevision":model.revision,
        "importRoles":{"sourceParsing":"ds","teachingGeneration":"ds","teachingReview":"qw"},"importRoleThinking":input})).unwrap();
    assert_eq!(result["importRoleThinking"], input);
    assert_eq!(
        result["effectiveImportRoles"]["sourceParsing"]["reasoningSource"],
        "purpose"
    );
    assert_eq!(
        result["effectiveImportRoles"]["teachingReview"]["reasoningSource"],
        "profile"
    );
    for (selected, effort) in [
        (model.import_source_model().unwrap(), "low"),
        (model.import_generator().unwrap(), "high"),
    ] {
        assert_eq!(selected.api_key, original_key);
        assert_eq!(selected.reasoning_effort.as_deref(), Some(effort));
        let mut body = json!({"model":selected.model,"max_tokens":16000,"response_format":{"type":"json_object"}});
        compatible_provider_request_options(&mut body, &selected.base_url, &selected.model);
        selected_reasoning_request_options(
            &mut body,
            &selected.base_url,
            &selected.model,
            selected.reasoning_effort.as_deref(),
        )
        .unwrap();
        assert_eq!(body["thinking"]["type"], "enabled");
        assert_eq!(body["reasoning_effort"], effort);
    }
    assert_eq!(
        model
            .profiles
            .iter()
            .find(|p| p.id == "ds")
            .unwrap()
            .public(),
        profile_before
    );
    assert_eq!(model.public_settings()["activeProfileId"], active_before);
    assert_eq!(model.reasoning_effort, None);
    let bytes = std::fs::read(&model.path).unwrap();
    let reopened = ModelClient::open(dir.path()).unwrap();
    assert_eq!(std::fs::read(&model.path).unwrap(), bytes);
    assert_eq!(
        reopened
            .import_source_model()
            .unwrap()
            .reasoning_effort
            .as_deref(),
        Some("low")
    );
    assert_eq!(
        reopened
            .import_generator()
            .unwrap()
            .reasoning_effort
            .as_deref(),
        Some("high")
    );
    assert!(
        !reopened
            .public_settings()
            .to_string()
            .contains(&original_key)
    );
}

#[test]
fn simulated_purpose_thinking_null_inherits_profile_without_changing_other_purposes() {
    let (_dir, mut model) = fixture(true);
    let initial = thinking(
        override_for(&model, "ds", "low"),
        Value::Null,
        override_for(&model, "qw", "off"),
    );
    model
        .save(&json!({"expectedRevision":model.revision,"importRoleThinking":initial}))
        .unwrap();
    assert_eq!(
        model
            .import_teaching_reviewer()
            .unwrap()
            .reasoning_effort
            .as_deref(),
        Some("off")
    );
    let cleared = thinking(Value::Null, Value::Null, override_for(&model, "qw", "off"));
    model
        .save(&json!({"expectedRevision":model.revision,"importRoleThinking":cleared}))
        .unwrap();
    assert_eq!(
        model
            .import_source_model()
            .unwrap()
            .reasoning_effort
            .as_deref(),
        Some("off")
    );
    assert_eq!(
        model.public_settings()["effectiveImportRoles"]["sourceParsing"]["reasoningSource"],
        "profile"
    );
    assert_eq!(
        model
            .import_teaching_reviewer()
            .unwrap()
            .reasoning_effort
            .as_deref(),
        Some("off")
    );
    model
        .save(&json!({"expectedRevision":model.revision,"importRoleThinking":null}))
        .unwrap();
    assert_eq!(
        model
            .import_teaching_reviewer()
            .unwrap()
            .reasoning_effort
            .as_deref(),
        Some("on")
    );
    assert_eq!(
        model
            .profiles
            .iter()
            .find(|p| p.id == "qw")
            .unwrap()
            .reasoning_effort
            .as_deref(),
        Some("on")
    );
}

#[test]
fn simulated_purpose_thinking_rejects_wrong_binding_shape_unknown_capability_and_unsupported_effort_atomically()
 {
    let (_dir, mut model) = fixture(true);
    let before = std::fs::read(&model.path).unwrap();
    let public = model.public_settings();
    let valid = override_for(&model, "ds", "low");
    let mut wrong_profile = valid.clone();
    wrong_profile["profileId"] = json!("mi");
    let mut wrong_provider = valid.clone();
    wrong_provider["provider"] = json!("qianwenai");
    let mut wrong_model = valid.clone();
    wrong_model["model"] = json!("deepseek-v4-pro");
    let mut wrong_field = valid.clone();
    wrong_field["effort"] = json!("low");
    for bad in [
        json!({}),
        json!([]),
        json!({"sourceParsing":null}),
        thinking(wrong_profile, Value::Null, Value::Null),
        thinking(wrong_provider, Value::Null, Value::Null),
        thinking(wrong_model, Value::Null, Value::Null),
        thinking(wrong_field, Value::Null, Value::Null),
        thinking(Value::Null, Value::Null, override_for(&model, "qw", "high")),
        thinking(override_for(&model, "ds", "on"), Value::Null, Value::Null),
    ] {
        assert!(
            model
                .save(&json!({"expectedRevision":model.revision,"importRoleThinking":bad}))
                .is_err()
        );
        assert_eq!(std::fs::read(&model.path).unwrap(), before);
        assert_eq!(model.public_settings(), public);
    }
    assert!(model.save(&json!({"expectedRevision":model.revision,"importRoles":null,"importRoleThinking":thinking(valid,Value::Null,Value::Null)})).is_err());
    assert_eq!(std::fs::read(&model.path).unwrap(), before);
}

#[test]
fn simulated_unknown_model_can_inherit_its_saved_behavior_but_cannot_receive_guessed_thinking_capability()
 {
    let (_dir, mut model) = fixture(true);
    model.profiles.push(profile(
        "unknown",
        "deepseek",
        "simulated-unknown-model",
        None,
        "simulated-unknown-key",
    ));
    model.save(&json!({"expectedRevision":model.revision,"profiles":items(&model),"activeProfileId":"mi",
        "importRoles":{"sourceParsing":"unknown","teachingGeneration":"mi","teachingReview":"qw"},"importRoleThinking":thinking(Value::Null,Value::Null,Value::Null)})).unwrap();
    assert_eq!(model.import_source_model().unwrap().reasoning_effort, None);
    let bytes = std::fs::read(&model.path).unwrap();
    assert!(model.save(&json!({"expectedRevision":model.revision,"importRoleThinking":thinking(override_for(&model,"unknown","low"),Value::Null,Value::Null)})).is_err());
    assert_eq!(std::fs::read(&model.path).unwrap(), bytes);
}

#[test]
fn simulated_old_client_omission_preserves_valid_thinking_and_clears_only_changed_role_binding() {
    let (_dir, mut model) = fixture(true);
    let initial = thinking(
        override_for(&model, "ds", "low"),
        Value::Null,
        override_for(&model, "qw", "off"),
    );
    model
        .save(&json!({"expectedRevision":model.revision,"importRoleThinking":initial}))
        .unwrap();
    model.save(&json!({"expectedRevision":model.revision,"profiles":items(&model),"activeProfileId":"qw"})).unwrap();
    assert_eq!(model.public_settings()["importRoleThinking"], initial);
    model.save(&json!({"expectedRevision":model.revision,"importRoles":{"sourceParsing":"qw","teachingGeneration":"mi","teachingReview":"qw"}})).unwrap();
    let settings = model.public_settings();
    assert!(settings["importRoleThinking"]["sourceParsing"].is_null());
    assert_eq!(
        settings["importRoleThinking"]["teachingReview"]["reasoningEffort"],
        "off"
    );
    assert_eq!(
        model
            .import_source_model()
            .unwrap()
            .reasoning_effort
            .as_deref(),
        Some("on")
    );
    model
        .save(&json!({"expectedRevision":model.revision,"importRoles":null}))
        .unwrap();
    assert!(model.public_settings()["importRoleThinking"].is_null());
    assert_eq!(
        model.public_settings()["effectiveImportRoles"]["teachingReview"]["reasoningSource"],
        "legacy"
    );
}

#[test]
fn simulated_changing_profile_model_clears_purpose_override_without_moving_its_strength_to_new_model()
 {
    let (_dir, mut model) = fixture(true);
    model.save(&json!({"expectedRevision":model.revision,"importRoleThinking":thinking(override_for(&model,"ds","low"),Value::Null,override_for(&model,"qw","off"))})).unwrap();
    let mut next = items(&model);
    let source = next.iter_mut().find(|p| p["id"] == "ds").unwrap();
    source["model"] = json!("deepseek-v4-pro");
    source["reasoningEffort"] = Value::Null;
    model
        .save(&json!({"expectedRevision":model.revision,"profiles":next,"activeProfileId":"mi"}))
        .unwrap();
    assert!(model.public_settings()["importRoleThinking"]["sourceParsing"].is_null());
    assert_eq!(
        model.import_source_model().unwrap().model,
        "deepseek-v4-pro"
    );
    assert_eq!(model.import_source_model().unwrap().reasoning_effort, None);
    assert_eq!(
        model
            .import_teaching_reviewer()
            .unwrap()
            .reasoning_effort
            .as_deref(),
        Some("off")
    );
}

#[test]
fn simulated_purpose_thinking_only_save_uses_revision_and_cross_window_cas_and_missing_field_is_not_written_on_read()
 {
    let (dir, mut one) = fixture(true);
    assert!(
        serde_json::from_slice::<Value>(&std::fs::read(&one.path).unwrap())
            .unwrap()
            .get("importRoleThinking")
            .is_none()
    );
    let mut other = ModelClient::open(dir.path()).unwrap();
    let payload = thinking(override_for(&one, "ds", "low"), Value::Null, Value::Null);
    assert_eq!(
        one.save(&json!({"expectedRevision":0,"importRoleThinking":payload}))
            .unwrap_err()
            .code,
        "revision_conflict"
    );
    one.save(&json!({"expectedRevision":one.revision,"importRoleThinking":payload}))
        .unwrap();
    let bytes = std::fs::read(&one.path).unwrap();
    assert_eq!(
        other
            .save(&json!({"expectedRevision":other.revision,"importRoleThinking":null}))
            .unwrap_err()
            .code,
        "revision_conflict"
    );
    assert_eq!(std::fs::read(&one.path).unwrap(), bytes);
    assert!(other.public_settings()["importRoleThinking"].is_null());
}
#[test]
fn legacy_missing_roles_read_keeps_bytes_and_old_roles_without_mutating_saved_effort() {
    let (dir, model) = fixture(false);
    let before = std::fs::read(&model.path).unwrap();
    let stored: Value = serde_json::from_slice(&before).unwrap();
    assert!(stored.get("importRoles").is_none());
    let reopened = ModelClient::open(dir.path()).unwrap();
    assert_eq!(std::fs::read(&model.path).unwrap(), before);
    assert!(reopened.public_settings()["importRoles"].is_null());
    assert!(!reopened.import_source_role_explicit());
    assert_eq!(
        reopened
            .import_source_model()
            .unwrap()
            .reasoning_effort
            .as_deref(),
        Some("low")
    );
    assert_eq!(
        reopened
            .import_generator()
            .unwrap()
            .reasoning_effort
            .as_deref(),
        Some("high")
    );
    assert_eq!(
        reopened
            .import_teaching_reviewer()
            .unwrap()
            .reasoning_effort
            .as_deref(),
        Some("on")
    );
    assert_eq!(
        reopened
            .profiles
            .iter()
            .find(|p| p.id == "ds")
            .unwrap()
            .reasoning_effort
            .as_deref(),
        Some("off")
    );
    assert!(
        reopened
            .profiles
            .iter()
            .find(|p| p.id == "mi")
            .unwrap()
            .reasoning_effort
            .is_none()
    );
    assert_eq!(reopened.active_profile_id.as_deref(), Some("mi"));
}
#[test]
fn explicit_roles_are_exact_and_read_only_no_general_active_or_effort_fallback() {
    let (dir, model) = fixture(true);
    let before = std::fs::read(&model.path).unwrap();
    let state = model.public_settings();
    let source = model.import_source_model().unwrap();
    let teaching = model.import_generator().unwrap();
    let review = model.import_teaching_reviewer().unwrap();
    assert_eq!(
        (
            source.model.as_str(),
            source.api_key.as_str(),
            source.reasoning_effort.as_deref()
        ),
        ("deepseek-flash", "simulated-source-key", Some("off"))
    );
    assert_eq!(
        (
            teaching.model.as_str(),
            teaching.api_key.as_str(),
            teaching.reasoning_effort.as_deref()
        ),
        ("mimo-v2.6-pro", "simulated-generation-key", None)
    );
    assert_eq!(
        (
            review.model.as_str(),
            review.api_key.as_str(),
            review.reasoning_effort.as_deref()
        ),
        ("qwen3.8-flash", "simulated-review-key", Some("on"))
    );
    assert_eq!(model.public_settings(), state);
    assert_eq!(std::fs::read(&model.path).unwrap(), before);
    assert!(model.import_source_role_explicit());
    let public = model.public_settings().to_string();
    assert!(!public.contains("simulated-source-key"));
    assert!(!public.contains("simulated-generation-key"));
    assert!(!public.contains("simulated-review-key"));
    assert!(
        ModelClient::open(dir.path())
            .unwrap()
            .import_source_role_explicit()
    );
}
#[test]
fn purpose_only_save_same_profile_for_all_and_null_never_falls_back() {
    let (_dir, mut model) = fixture(false);
    let active = model.active_profile_id.clone();
    let revision = model.revision;
    model.save(&json!({"expectedRevision":revision,"importRoles":{"sourceParsing":"mi","teachingGeneration":"mi","teachingReview":null}})).unwrap();
    assert_eq!(model.active_profile_id, active);
    assert_eq!(model.import_source_model().unwrap().model, "mimo-v2.6-pro");
    assert!(
        model
            .import_source_model()
            .unwrap()
            .reasoning_effort
            .is_none()
    );
    let err = model.import_teaching_reviewer().err().unwrap();
    assert_eq!(err.code, "import_model_not_configured");
    assert!(err.message.contains("解析复核"));
    assert!(!err.message.contains("teachingReview"));
    assert_eq!(model.public_settings()["importConfigured"], true);
    let revision = model.revision;
    model.save(&json!({"expectedRevision":revision,"importRoles":{"sourceParsing":null,"teachingGeneration":"ds","teachingReview":"ds"}})).unwrap();
    assert!(model.import_source_model().is_err());
    assert_eq!(model.public_settings()["importSourceConfigured"], false);
    assert_eq!(model.public_settings()["importTeachingConfigured"], true);
    assert_eq!(model.public_settings()["importConfigured"], false);
    assert_eq!(
        model
            .import_teaching_reviewer()
            .unwrap()
            .reasoning_effort
            .as_deref(),
        Some("off")
    );
}
#[test]
fn deleting_referenced_profile_requires_same_save_clear_or_reassignment() {
    let (_dir, mut model) = fixture(true);
    let before = std::fs::read(&model.path).unwrap();
    let state = model.public_settings();
    let remaining = items(&model)
        .into_iter()
        .filter(|p| p["id"] != "qw")
        .collect::<Vec<_>>();
    assert!(model.save(&json!({"expectedRevision":model.revision,"profiles":remaining,"activeProfileId":"mi"})).is_err());
    assert_eq!(std::fs::read(&model.path).unwrap(), before);
    assert_eq!(model.public_settings(), state);
    model.save(&json!({"expectedRevision":model.revision,"profiles":remaining,"activeProfileId":"mi","importRoles":{"sourceParsing":"ds","teachingGeneration":"mi","teachingReview":null}})).unwrap();
    assert!(model.import_teaching_reviewer().is_err());
    assert_eq!(model.profiles.len(), 2);
}
#[test]
fn omitted_roles_preserved_on_profile_save_and_explicit_null_returns_legacy() {
    let (_dir, mut model) = fixture(true);
    let revision = model.revision;
    model
        .save(&json!({"expectedRevision":revision,"profiles":items(&model),"activeProfileId":"qw"}))
        .unwrap();
    assert_eq!(model.public_settings()["importRoles"], roles());
    assert_eq!(
        model.import_source_model().unwrap().api_key,
        "simulated-source-key"
    );
    assert_eq!(
        model.import_generator().unwrap().api_key,
        "simulated-generation-key"
    );
    let rev = model.revision;
    model
        .save(&json!({"expectedRevision":rev,"importRoles":null}))
        .unwrap();
    assert!(!model.import_source_role_explicit());
    assert_eq!(
        model
            .import_source_model()
            .unwrap()
            .reasoning_effort
            .as_deref(),
        Some("low")
    );
    let disk: Value = serde_json::from_slice(&std::fs::read(&model.path).unwrap()).unwrap();
    assert!(disk.get("importRoles").is_some_and(Value::is_null));
    model.save(&json!({"expectedRevision":model.revision,"profiles":items(&model),"activeProfileId":"mi"})).unwrap();
    let disk: Value = serde_json::from_slice(&std::fs::read(&model.path).unwrap()).unwrap();
    assert!(disk.get("importRoles").is_some_and(Value::is_null));
}
#[test]
fn invalid_role_shape_unknown_id_and_stale_revision_are_atomic() {
    let (_dir, mut model) = fixture(true);
    let before = std::fs::read(&model.path).unwrap();
    let state = model.public_settings();
    for bad in [
        json!({"sourceParsing":"missing","teachingGeneration":"mi","teachingReview":"qw"}),
        json!({"sourceParsing":"ds"}),
        json!({"sourceParsing":"ds","teachingGeneration":"mi","teachingReview":"qw","extra":"ds"}),
        json!({"sourceParsing":42,"teachingGeneration":"mi","teachingReview":null}),
        json!({"sourceParsing":"","teachingGeneration":"mi","teachingReview":"qw"}),
    ] {
        assert!(
            model
                .save(&json!({"expectedRevision":model.revision,"importRoles":bad}))
                .is_err()
        );
        assert_eq!(std::fs::read(&model.path).unwrap(), before);
        assert_eq!(model.public_settings(), state);
    }
    assert_eq!(
        model
            .save(&json!({"expectedRevision":0,"importRoles":roles()}))
            .unwrap_err()
            .code,
        "revision_conflict"
    );
    assert_eq!(std::fs::read(&model.path).unwrap(), before);
    assert_eq!(model.save(&json!({"expectedRevision":0,"baseUrl":model.base_url,"model":model.model,"importRoles":roles()})).unwrap_err().code,"revision_conflict");
    assert_eq!(std::fs::read(&model.path).unwrap(), before);
}
#[test]
fn cross_window_roles_compare_actual_settings_bytes_before_commit() {
    let (dir, mut one) = fixture(true);
    let mut two = ModelClient::open(dir.path()).unwrap();
    one.save(&json!({"expectedRevision":one.revision,"importRoles":{"sourceParsing":"qw","teachingGeneration":"mi","teachingReview":null}})).unwrap();
    let bytes = std::fs::read(&one.path).unwrap();
    assert_eq!(
        two.save(&json!({"expectedRevision":two.revision,"importRoles":null}))
            .unwrap_err()
            .code,
        "revision_conflict"
    );
    assert_eq!(std::fs::read(&one.path).unwrap(), bytes);
    assert_eq!(two.public_settings()["importRoles"], roles());
}
#[test]
fn unavailable_explicit_role_never_borrows_other_key_or_opens_general_model() {
    let (_dir, mut model) = fixture(true);
    model
        .profiles
        .iter_mut()
        .find(|p| p.id == "ds")
        .unwrap()
        .api_key
        .clear();
    model.active_profile_id = Some("qw".into());
    model.sync_active();
    assert!(model.configured());
    assert!(model.import_source_model().is_err());
    assert_eq!(model.public_settings()["importConfigured"], false);
    model.profiles.clear();
    assert!(model.import_generator().is_err());
    assert!(model.import_teaching_reviewer().is_err());
}
#[test]
fn configured_roles_work_without_general_active_model_and_corrupt_roles_do_not_rewrite() {
    let (dir, mut model) = fixture(true);
    model.save(&json!({"expectedRevision":model.revision,"profiles":items(&model),"activeProfileId":null})).unwrap();
    assert!(!model.configured());
    assert_eq!(model.public_settings()["importConfigured"], true);
    assert!(model.import_source_model().unwrap().configured());
    let mut value: Value = serde_json::from_slice(&std::fs::read(&model.path).unwrap()).unwrap();
    value["importRoles"]["sourceParsing"] = json!("not-real");
    let corrupt = serde_json::to_vec(&value).unwrap();
    std::fs::write(&model.path, &corrupt).unwrap();
    let reopened = ModelClient::open(dir.path()).unwrap();
    assert!(!reopened.configured());
    assert!(reopened.preserve_damaged_settings);
    assert_eq!(std::fs::read(&model.path).unwrap(), corrupt);
}
#[test]
fn three_roles_send_actual_distinct_models_keys_and_thinking_to_local_http() {
    use std::net::TcpListener;
    let (_dir, model) = fixture(true);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let mut seen = vec![];
        for _ in 0..3 {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = vec![];
            let mut buf = [0; 4096];
            let end = loop {
                let n = stream.read(&mut buf).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buf[..n]);
                if let Some(end) = bytes.windows(4).position(|x| x == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&bytes[..end]);
                    let size = header
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|n| n.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    if bytes.len() >= end + 4 + size {
                        break end + 4;
                    }
                }
            };
            seen.push((
                String::from_utf8_lossy(&bytes[..end]).to_string(),
                serde_json::from_slice::<Value>(&bytes[end..]).unwrap(),
            ));
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length:2\r\nConnection:close\r\n\r\n{{}}"
            )
            .unwrap();
        }
        seen
    });
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
  let http=reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).build().unwrap();
  for selected in [model.import_source_model().unwrap(),model.import_generator().unwrap(),model.import_teaching_reviewer().unwrap()] {
   let mut body=json!({"model":selected.model,"max_tokens":8192,"messages":[{"role":"system","content":"Return JSON only"}],"response_format":{"type":"json_object"}});
   compatible_provider_request_options(&mut body,&selected.base_url,&selected.model);
   selected_reasoning_request_options(&mut body,&selected.base_url,&selected.model,selected.reasoning_effort.as_deref()).unwrap();
   let mut request=model_http_request(&http,&selected.base_url,&selected.api_key,&body).build().unwrap();assert_eq!(request.url().as_str(),format!("{}/chat/completions",selected.base_url));
   // Only the transport destination changes for the simulation. Production
   // route, request body and authentication headers remain untouched.
   *request.url_mut()=reqwest::Url::parse(&format!("http://{address}{}",request.url().path())).unwrap();assert!(http.execute(request).await.unwrap().status().is_success());
  }
 });
    let seen = server.join().unwrap();
    assert_eq!(seen[0].1["model"], "deepseek-flash");
    assert!(seen[0].0.contains("Bearer simulated-source-key"));
    assert_eq!(seen[0].1["thinking"]["type"], "disabled");
    assert!(seen[0].1.get("reasoning_effort").is_none());
    assert_eq!(seen[1].1["model"], "mimo-v2.6-pro");
    assert!(seen[1].0.contains("Bearer simulated-generation-key"));
    assert!(seen[1].0.starts_with("POST /v1/chat/completions"));
    assert_eq!(seen[1].1["thinking"]["type"], "disabled");
    assert!(seen[1].1.get("reasoning_effort").is_none());
    assert_eq!(seen[2].1["model"], "qwen3.8-flash");
    assert!(seen[2].0.contains("Bearer simulated-review-key"));
    assert!(
        seen[2]
            .0
            .starts_with("POST /compatible-mode/v1/chat/completions")
    );
    assert_eq!(seen[2].1["enable_thinking"], true);
    assert!(seen[2].1.get("thinking").is_none());
    for (i, (headers, _)) in seen.iter().enumerate() {
        for (j, key) in [
            "simulated-source-key",
            "simulated-generation-key",
            "simulated-review-key",
        ]
        .iter()
        .enumerate()
        {
            assert_eq!(headers.contains(key), i == j);
        }
    }
}

#[test]
fn accuracy_purposes_require_explicit_bindings_even_when_legacy_or_general_models_exist() {
    for explicit in [false, true] {
        let (dir, model) = fixture(explicit);
        let before = std::fs::read(&model.path).unwrap();
        let reopened = ModelClient::open(dir.path()).unwrap();
        for role in ACCURACY_ROLE_KEYS {
            let error = reopened.import_accuracy_model(role).err().unwrap();
            assert_eq!(error.code, "import_model_not_configured");
            assert!(error.message.contains(role_label(role).unwrap()));
            assert_eq!(
                reopened.public_settings()["effectiveImportRoles"][role]["strategy"],
                "explicit"
            );
            assert_eq!(
                reopened.public_settings()["effectiveImportRoles"][role]["configured"],
                false
            );
        }
        assert_eq!(std::fs::read(&model.path).unwrap(), before);
        if explicit {
            assert_eq!(reopened.public_settings()["importRoles"], roles());
        }
    }
}

#[test]
fn accuracy_purposes_select_exact_credentials_and_independent_bound_thinking_without_mutating_profiles()
 {
    let (dir, mut model) = fixture(true);
    let mut overrides = thinking(Value::Null, Value::Null, Value::Null);
    for (role, profile, effort) in [
        ("sourceVerification", "qw", "off"),
        ("independentSolve", "ds", "low"),
        ("mathVerification", "qw", "on"),
        ("teachingVerification", "ds", "high"),
    ] {
        overrides[role] = override_for(&model, profile, effort);
    }
    model.save(&json!({"expectedRevision":model.revision,"importRoles":accuracy_roles(),"importRoleThinking":overrides})).unwrap();
    let before = std::fs::read(&model.path).unwrap();
    let reopened = ModelClient::open(dir.path()).unwrap();
    for (role, profile, effort) in [
        ("sourceVerification", "qw", "off"),
        ("independentSolve", "ds", "low"),
        ("mathVerification", "qw", "on"),
        ("teachingVerification", "ds", "high"),
    ] {
        let selected = reopened.import_accuracy_model(role).unwrap();
        let original = reopened.profiles.iter().find(|p| p.id == profile).unwrap();
        assert_eq!(selected.active_profile_id.as_deref(), Some(profile));
        assert_eq!(selected.api_key, original.api_key);
        assert_eq!(selected.base_url, original.base_url);
        assert_eq!(selected.model, original.model);
        assert_eq!(selected.reasoning_effort.as_deref(), Some(effort));
        assert_eq!(
            reopened.public_settings()["effectiveImportRoles"][role]["reasoningSource"],
            "purpose"
        );
    }
    assert_eq!(reopened.active_profile_id.as_deref(), Some("mi"));
    assert_eq!(
        reopened
            .profiles
            .iter()
            .find(|p| p.id == "ds")
            .unwrap()
            .reasoning_effort
            .as_deref(),
        Some("off")
    );
    assert_eq!(std::fs::read(&model.path).unwrap(), before);
}

#[test]
fn old_three_key_saves_preserve_new_roles_and_thinking_but_explicit_null_clears_only_its_purpose() {
    let (_dir, mut model) = fixture(true);
    let mut overrides = thinking(Value::Null, Value::Null, Value::Null);
    overrides["independentSolve"] = override_for(&model, "ds", "high");
    model.save(&json!({"expectedRevision":model.revision,"importRoles":accuracy_roles(),"importRoleThinking":overrides})).unwrap();
    model.save(&json!({"expectedRevision":model.revision,"importRoles":roles(),"importRoleThinking":thinking(Value::Null,Value::Null,Value::Null)})).unwrap();
    assert_eq!(model.public_settings()["importRoles"], accuracy_roles());
    assert_eq!(
        model
            .import_accuracy_model("independentSolve")
            .unwrap()
            .reasoning_effort
            .as_deref(),
        Some("high")
    );
    let mut clear = roles();
    clear["independentSolve"] = Value::Null;
    model
        .save(&json!({"expectedRevision":model.revision,"importRoles":clear}))
        .unwrap();
    assert_eq!(
        model
            .import_accuracy_model("independentSolve")
            .err()
            .unwrap()
            .code,
        "import_model_not_configured"
    );
    assert!(model.public_settings()["importRoleThinking"]["independentSolve"].is_null());
    assert_eq!(
        model
            .import_accuracy_model("mathVerification")
            .unwrap()
            .active_profile_id
            .as_deref(),
        Some("qw")
    );
}

#[test]
fn accuracy_purpose_settings_reject_dangling_profile_and_stale_provider_binding_atomically() {
    let (_dir, mut model) = fixture(true);
    model
        .save(&json!({"expectedRevision":model.revision,"importRoles":accuracy_roles()}))
        .unwrap();
    let before = std::fs::read(&model.path).unwrap();
    let mut bad = accuracy_roles();
    bad["mathVerification"] = json!("missing");
    assert!(
        model
            .save(&json!({"expectedRevision":model.revision,"importRoles":bad}))
            .is_err()
    );
    let mut overrides = thinking(Value::Null, Value::Null, Value::Null);
    overrides["independentSolve"] = override_for(&model, "ds", "high");
    overrides["independentSolve"]["provider"] = json!("bailian");
    assert!(
        model
            .save(&json!({"expectedRevision":model.revision,"importRoleThinking":overrides}))
            .is_err()
    );
    let remaining: Vec<_> = items(&model)
        .into_iter()
        .filter(|p| p["id"] != "qw")
        .collect();
    let mut old_save = roles();
    old_save["teachingReview"] = Value::Null;
    assert!(model.save(&json!({"expectedRevision":model.revision,"profiles":remaining,"importRoles":old_save})).is_err());
    assert_eq!(std::fs::read(&model.path).unwrap(), before);
}
