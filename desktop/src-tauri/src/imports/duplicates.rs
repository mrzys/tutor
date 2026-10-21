//! Read-only duplicate hints. These never approve, reject, publish, or merge a
//! pending question; matching student text does not verify teacher answers.
use crate::{
    bank::{BankRepository, hash_json},
    error::{AppError, AppResult},
};
use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

fn scalar_id(value: &Value) -> Option<String> {
    if let Some(id) = value
        .as_str()
        .filter(|id| !id.is_empty() && !id.chars().any(char::is_control))
    {
        return Some(id.to_owned());
    }
    value.as_u64().map(|id| id.to_string()).or_else(|| {
        value
            .as_i64()
            .filter(|id| *id >= 0)
            .map(|id| id.to_string())
    })
}
fn integrity() -> AppError {
    AppError::new(
        "integrity_error",
        "重复题检查发现题库内容、版本或审核哈希不一致，未生成重复结论。",
    )
}
fn verified(bank: &dyn BankRepository, id: &str) -> AppResult<Value> {
    let question = bank.question(id)?;
    if question["questionId"] != id || question["verification"]["result"] != "pass" {
        return Err(integrity());
    }
    for (field, hash_field, version_field, prefix) in [
        ("student", "contentSha256", "contentVersion", "content"),
        ("teacher", "teacherSha256", "teacherVersion", "teacher"),
    ] {
        if !question[field].is_object() {
            return Err(integrity());
        }
        let hash = hash_json(&question[field]);
        let version = format!("{prefix}-{}", &hash[..16]);
        if question[hash_field] != hash
            || question[version_field] != version
            || question["verification"][version_field] != version
        {
            return Err(integrity());
        }
    }
    Ok(question)
}
fn valid_sha(value: &Value) -> Option<&str> {
    value.as_str().filter(|s| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
/// Keep labels and parent sequence positions while discarding local IDs.
/// Missing legacy labels/parent declarations remain explicit unknown markers;
/// they are never guessed from prompt text or flattened into declared roots.
fn part_structure(parts: &Value) -> Option<Vec<Value>> {
    let parts = parts.as_array()?;
    let mut by_id = HashMap::new();
    for (index, part) in parts.iter().enumerate() {
        let id = part["partId"]
            .as_str()
            .filter(|id| !id.is_empty() && !id.chars().any(char::is_control))?;
        if by_id.insert(id, index).is_some() {
            return None;
        }
    }
    let mut parents = Vec::with_capacity(parts.len());
    for (index, part) in parts.iter().enumerate() {
        let parent = match part.get("parentPartId") {
            None | Some(Value::Null) => None,
            Some(Value::String(id)) => Some(*by_id.get(id.as_str())?),
            _ => return None,
        };
        if parent == Some(index) {
            return None;
        }
        parents.push(parent);
    }
    for start in 0..parts.len() {
        let mut seen = HashSet::new();
        let mut current = Some(start);
        while let Some(index) = current {
            if !seen.insert(index) {
                return None;
            }
            current = parents[index];
        }
    }
    parts.iter().enumerate().map(|(index,part)|{
        let label=match part.get("label") {None=>Value::Null,Some(Value::String(label))=>json!(label),_=>return None};
        Some(json!({"prompt":part["prompt"].as_str()?,"label":label,"parentDeclared":part.get("parentPartId").is_some(),"parentIndex":parents[index]}))
    }).collect()
}
/// Byte-preserving student fingerprint: no whitespace, punctuation, HTML or
/// mathematical-symbol normalization; local question/part/asset IDs are ignored.
fn fingerprint(q: &Value) -> Option<String> {
    let student = if q.get("stem").is_some() {
        q
    } else {
        &q["student"]
    };
    let stem = student["stem"].as_str()?;
    if stem.is_empty() {
        return None;
    }
    let kind = q["questionType"].as_str()?;
    let options = student["options"]
        .as_array()?
        .iter()
        .map(|o| Some(json!({"label":o["label"].as_str()?,"text":o["text"].as_str()?})))
        .collect::<Option<Vec<_>>>()?;
    let parts = part_structure(&student["parts"])?;
    let refs = q["student"].get("assets").or_else(|| q.get("assets"));
    let empty = Vec::new();
    let refs = match refs {
        Some(v) => v.as_array()?,
        None => &empty,
    };
    let payloads = q["assetPayloads"].as_array();
    let mut media = Vec::new();
    for reference in refs {
        let sha = valid_sha(&reference["sha256"])?;
        if let Some(payloads) = payloads {
            let found = payloads
                .iter()
                .filter(|p| {
                    p["assetId"] == reference["assetId"]
                        && (p["role"] == "student" || p.get("role").is_none())
                })
                .collect::<Vec<_>>();
            if found.len() > 1 {
                return None;
            }
            if let Some(payload) = found.first() {
                if payload.get("sha256").is_some_and(|h| h != sha) {
                    return None;
                }
                if let Some(encoded) = payload.get("dataBase64") {
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(encoded.as_str()?)
                        .ok()?;
                    if format!("{:x}", Sha256::digest(&bytes)) != sha {
                        return None;
                    }
                }
            }
        }
        media.push(json!({"sha256":sha,"mimeType":reference["mimeType"]}));
    }
    // Unreferenced student images cannot silently disappear from a fingerprint.
    if payloads.is_some_and(|payloads| {
        payloads
            .iter()
            .filter(|p| p["role"] == "student" || p.get("role").is_none())
            .any(|p| !refs.iter().any(|r| r["assetId"] == p["assetId"]))
    }) {
        return None;
    }
    Some(hash_json(
        &json!({"questionType":kind,"stem":stem,"options":options,"parts":parts,"assets":media}),
    ))
}
fn legacy_match(incoming: &Value, existing: &Value) -> Option<(&'static str, bool)> {
    let source = &incoming["sourceIdentity"];
    if source["system"] != "legacy_tutor_kb" {
        return None;
    }
    let original = &existing["verification"]["origin"];
    let incoming_id = scalar_id(&source["questionId"])?;
    let existing_id = scalar_id(&original["sourceQuestionId"])?;
    if incoming_id != existing_id {
        return None;
    }
    match (
        scalar_id(&source["contentVersionId"]),
        scalar_id(&original["sourceContentVersionId"]),
    ) {
        (Some(a), Some(b)) if a == b => Some(("legacy_identity_exact", true)),
        (Some(_), Some(_)) => Some(("legacy_identity_version_changed", false)),
        _ => Some(("legacy_identity_version_unknown", false)),
    }
}
pub(super) fn annotate(bank: &dyn BankRepository, questions: &mut [Value]) -> AppResult<()> {
    let mut checked = Vec::new();
    let mut seen = HashSet::new();
    for listed in bank.questions()? {
        let id = listed["questionId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(integrity)?;
        if !seen.insert(id.to_owned()) {
            return Err(integrity());
        }
        let current = verified(bank, id)?;
        let fingerprint = fingerprint(&current);
        checked.push((current, fingerprint));
    }
    let mut results = Vec::with_capacity(questions.len());
    for incoming in questions.iter() {
        let incoming_fingerprint = fingerprint(incoming);
        let mut candidates = Vec::new();
        for (existing, existing_fingerprint) in &checked {
            let matched = legacy_match(incoming, existing).or_else(|| {
                incoming_fingerprint
                    .as_ref()
                    .zip(existing_fingerprint.as_ref())
                    .filter(|(a, b)| a == b)
                    .map(|_| ("student_content_exact", true))
            });
            if let Some((reason, exact)) = matched {
                candidates.push(json!({"questionId":existing["questionId"],"contentVersion":existing["contentVersion"],"teacherVersion":existing["teacherVersion"],"reason":reason,"exact":exact}));
            }
        }
        candidates.sort_by(|a, b| {
            b["exact"]
                .as_bool()
                .cmp(&a["exact"].as_bool())
                .then_with(|| a["questionId"].as_str().cmp(&b["questionId"].as_str()))
        });
        results.push(candidates);
    }
    for (question, candidates) in questions.iter_mut().zip(results) {
        question["duplicateCandidates"] = json!(candidates);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bank::LocalQuestionBank;
    fn seed() -> Value {
        let mut seed = crate::bank::tests::seed();
        seed["questions"][0]["verification"]["origin"] = json!({"sourceQuestionId":"6464","sourceContentVersionId":5410,"sourceOccurrenceId":6462,"sourceExamId":258});
        seed
    }
    fn input(q: &Value) -> Value {
        json!({"questionId":"pending-local-id","questionType":q["questionType"],"stem":q["student"]["stem"],"options":q["student"]["options"],"parts":q["student"]["parts"],"student":{"assets":q["student"]["assets"]},"assetPayloads":[],"reviewDecision":"pending","sourceIdentity":{"system":"legacy_tutor_kb","questionId":"6464","contentVersionId":"5410","occurrenceId":"6462","examId":"258"}})
    }
    #[test]
    fn simulated_legacy_identity_exact_is_version_bound_without_mutating_bank_or_review_decision() {
        let dir = tempfile::tempdir().unwrap();
        let seed = seed();
        let bank = LocalQuestionBank::open(&dir.path().join("bank.sqlite"), &seed).unwrap();
        let before = bank.questions().unwrap();
        let config = bank.config().unwrap();
        let mut pending = vec![input(&before[0])];
        annotate(&bank, &mut pending).unwrap();
        let candidates = pending[0]["duplicateCandidates"].as_array().unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0]["reason"], "legacy_identity_exact");
        assert_eq!(candidates[0]["exact"], true);
        assert_eq!(candidates[0]["contentVersion"], before[0]["contentVersion"]);
        assert_eq!(pending[0]["reviewDecision"], "pending");
        assert_eq!(bank.questions().unwrap(), before);
        assert_eq!(bank.config().unwrap(), config);
        pending[0]["sourceIdentity"]["contentVersionId"] = json!(9999);
        annotate(&bank, &mut pending).unwrap();
        assert_eq!(
            pending[0]["duplicateCandidates"][0]["reason"],
            "legacy_identity_version_changed"
        );
        assert_eq!(
            pending[0]["duplicateCandidates"][0]["exact"], false,
            "same student fingerprint must not override known changed legacy version"
        );
        pending[0]["sourceIdentity"]
            .as_object_mut()
            .unwrap()
            .remove("contentVersionId");
        annotate(&bank, &mut pending).unwrap();
        assert_eq!(pending[0]["duplicateCandidates"][0]["exact"], false);
    }
    #[test]
    fn simulated_fingerprint_preserves_math_option_labels_order_and_part_text_but_ignores_local_ids()
     {
        let student = json!({"stem":"若 $a>b$，求 $a-b$。","options":[{"label":"A","text":"$a-b$"},{"label":"B","text":"$a+b$"}],"parts":[{"partId":"old-p1","prompt":"证明 $a>b$。"}],"assets":[]});
        let existing =
            json!({"questionId":"existing","questionType":"single_choice","student":student});
        let mut next = input(&existing);
        next["parts"][0]["partId"] = json!("new-local-part");
        assert_eq!(fingerprint(&existing), fingerprint(&next));
        for changed in [
            json!({"stem":"若 $a<b$，求 $a-b$。"}),
            json!({"stem":"若 $a>b$，求 $a+b$。"}),
            json!({"options":[{"label":"B","text":"$a-b$"},{"label":"A","text":"$a+b$"}]}),
            json!({"parts":[{"partId":"p1","prompt":"证明 $a<b$。"}]}),
        ] {
            let mut q = next.clone();
            for (k, v) in changed.as_object().unwrap() {
                q[k] = v.clone();
            }
            assert_ne!(fingerprint(&existing), fingerprint(&q));
        }
        let mut reordered = next.clone();
        reordered["options"].as_array_mut().unwrap().reverse();
        assert_ne!(fingerprint(&existing), fingerprint(&reordered));
    }
    #[test]
    fn simulated_exact_student_fingerprint_is_hint_even_without_matching_legacy_identity() {
        let dir = tempfile::tempdir().unwrap();
        let seed = seed();
        let bank = LocalQuestionBank::open(&dir.path().join("bank.sqlite"), &seed).unwrap();
        let q = bank.questions().unwrap().remove(0);
        let mut pending = vec![input(&q)];
        pending[0].as_object_mut().unwrap().remove("sourceIdentity");
        annotate(&bank, &mut pending).unwrap();
        assert_eq!(
            pending[0]["duplicateCandidates"][0]["reason"],
            "student_content_exact"
        );
        assert_eq!(pending[0]["duplicateCandidates"][0]["exact"], true);
        assert_eq!(pending[0]["reviewDecision"], "pending");
    }
    #[test]
    fn simulated_media_hashes_are_required_and_payload_mismatch_never_produces_exact_fingerprint() {
        let bytes = b"simulated-media-bytes";
        let sha = format!("{:x}", Sha256::digest(bytes));
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        let existing = json!({"questionType":"free_response","student":{"stem":"观察下图。","options":[],"parts":[],"assets":[{"assetId":"old-asset","sha256":sha,"mimeType":"image/png"}]}});
        let mut next = input(&existing);
        next["student"]["assets"][0]["assetId"] = json!("new-asset");
        next["assetPayloads"] =
            json!([{"role":"student","assetId":"new-asset","sha256":sha,"dataBase64":encoded}]);
        assert_eq!(fingerprint(&existing), fingerprint(&next));
        next["assetPayloads"][0]["dataBase64"] =
            json!(base64::engine::general_purpose::STANDARD.encode(b"tampered-media"));
        assert!(fingerprint(&next).is_none());
        next["assetPayloads"] = json!([]);
        next["student"]["assets"][0]
            .as_object_mut()
            .unwrap()
            .remove("sha256");
        assert!(fingerprint(&next).is_none());
    }
    struct ChangingBank {
        listed: Value,
        current: Value,
    }
    impl BankRepository for ChangingBank {
        fn config(&self) -> AppResult<Value> {
            Ok(json!({}))
        }
        fn questions(&self) -> AppResult<Vec<Value>> {
            Ok(vec![self.listed.clone()])
        }
        fn question(&self, _: &str) -> AppResult<Value> {
            Ok(self.current.clone())
        }
    }
    #[test]
    fn simulated_bank_current_snapshot_is_reverified_and_corruption_keeps_pending_input_untouched()
    {
        let seed = seed();
        let original = seed["questions"][0].clone();
        let mut current = original.clone();
        current["student"]["stem"] = json!("模拟当前版本变化，旧清单不能做查重依据。");
        let hash = hash_json(&current["student"]);
        let version = format!("content-{}", &hash[..16]);
        current["contentSha256"] = json!(hash);
        current["contentVersion"] = json!(version);
        current["verification"]["contentVersion"] = current["contentVersion"].clone();
        let bank = ChangingBank {
            listed: original.clone(),
            current: current.clone(),
        };
        let mut pending = vec![input(&original)];
        annotate(&bank, &mut pending).unwrap();
        assert_eq!(
            pending[0]["duplicateCandidates"][0]["contentVersion"],
            current["contentVersion"]
        );
        current["student"]["stem"] = json!("模拟内容被篡改但哈希未更新");
        let corrupt = ChangingBank {
            listed: original.clone(),
            current,
        };
        let mut pending = vec![input(&original)];
        let before = pending.clone();
        assert_eq!(
            annotate(&corrupt, &mut pending).unwrap_err().code,
            "integrity_error"
        );
        assert_eq!(pending, before);
    }
    fn rehash_student(question: &mut Value) {
        let hash = hash_json(&question["student"]);
        let version = format!("content-{}", &hash[..16]);
        question["contentSha256"] = json!(hash);
        question["contentVersion"] = json!(version);
        question["verification"]["contentVersion"] = question["contentVersion"].clone();
    }
    #[test]
    fn simulated_isolated_duplicate_hint_preserves_part_labels_and_hierarchy_while_ignoring_local_ids()
     {
        let dir = tempfile::tempdir().unwrap();
        let mut seed = seed();
        let question = &mut seed["questions"][0];
        question["student"]["parts"] = json!([
            {"partId":"old-root","label":"（1）","parentPartId":null,"prompt":"模拟同一文字主问题。"},
            {"partId":"old-child","label":"①","parentPartId":"old-root","prompt":"模拟子问题。"},
            {"partId":"old-other","label":"（2）","parentPartId":null,"prompt":"模拟另一个主问题。"}
        ]);
        rehash_student(question);
        let bank = LocalQuestionBank::open(&dir.path().join("bank.sqlite"), &seed).unwrap();
        let original = bank.questions().unwrap().remove(0);
        let mut incoming = input(&original);
        incoming.as_object_mut().unwrap().remove("sourceIdentity");
        incoming["parts"][0]["partId"] = json!("new-root");
        incoming["parts"][1]["partId"] = json!("new-child");
        incoming["parts"][1]["parentPartId"] = json!("new-root");
        incoming["parts"][2]["partId"] = json!("new-other");
        let mut pending = vec![incoming.clone()];
        annotate(&bank, &mut pending).unwrap();
        assert_eq!(
            pending[0]["duplicateCandidates"][0]["reason"],
            "student_content_exact"
        );
        assert_eq!(pending[0]["duplicateCandidates"][0]["exact"], true);
        for (field, value) in [
            ("parentPartId", Value::Null),
            ("parentPartId", json!("new-other")),
            ("label", json!("②")),
        ] {
            let mut changed = incoming.clone();
            changed["parts"][1][field] = value;
            let mut pending = vec![changed];
            annotate(&bank, &mut pending).unwrap();
            assert_eq!(
                pending[0]["duplicateCandidates"],
                json!([]),
                "same prompt with different hierarchy/labels is not exact"
            );
        }
        assert_eq!(
            bank.question(original["questionId"].as_str().unwrap())
                .unwrap(),
            original
        );
    }
    #[test]
    fn simulated_invalid_part_ids_or_cycles_disable_fingerprints_and_missing_legacy_metadata_is_not_guessed()
     {
        let q = json!({"questionType":"free_response","stem":"模拟结构边界。","options":[],"parts":[{"partId":"root","label":"（1）","parentPartId":null,"prompt":"相同题干。"},{"partId":"child","label":"①","parentPartId":"root","prompt":"相同小问。"}],"student":{"assets":[]}});
        assert!(fingerprint(&q).is_some());
        let mut broken = Vec::new();
        let mut candidate = q.clone();
        candidate["parts"][1]["partId"] = json!("root");
        broken.push(candidate);
        candidate = q.clone();
        candidate["parts"][1]["parentPartId"] = json!("missing");
        broken.push(candidate);
        candidate = q.clone();
        candidate["parts"][1]["parentPartId"] = json!("child");
        broken.push(candidate);
        candidate = q.clone();
        candidate["parts"][0]["parentPartId"] = json!("child");
        broken.push(candidate);
        candidate = q.clone();
        candidate["parts"][1]["parentPartId"] = json!(42);
        broken.push(candidate);
        candidate = q.clone();
        candidate["parts"][0]["partId"] = json!("");
        broken.push(candidate);
        for invalid in broken {
            assert!(
                fingerprint(&invalid).is_none(),
                "invalid parent graph must not be guessed"
            );
        }
        let mut legacy = q.clone();
        for p in legacy["parts"].as_array_mut().unwrap() {
            p.as_object_mut().unwrap().remove("label");
            p.as_object_mut().unwrap().remove("parentPartId");
        }
        assert!(fingerprint(&legacy).is_some());
        assert_ne!(fingerprint(&legacy), fingerprint(&q));
        let mut explicit_blank = legacy.clone();
        for p in explicit_blank["parts"].as_array_mut().unwrap() {
            p["label"] = json!("");
        }
        assert_ne!(
            fingerprint(&legacy),
            fingerprint(&explicit_blank),
            "missing legacy label is not invented as an explicitly empty label"
        );
        let mut renamed = legacy.clone();
        renamed["parts"][0]["partId"] = json!("new-legacy-root");
        renamed["parts"][1]["partId"] = json!("new-legacy-child");
        assert_eq!(fingerprint(&legacy), fingerprint(&renamed));
    }
}
