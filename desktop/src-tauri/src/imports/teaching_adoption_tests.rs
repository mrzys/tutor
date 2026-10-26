//! Simulated adoption regression evidence; never uses user files or model HTTP.
use super::*;

fn candidate()->Value{json!({"questionId":"sim-adopt-q1","answer":"2","difficultyAssessment":{"level":"easy","basis":"模拟：直接加法。"},"teachingSolution":"由 $1+1=2$ 得答案。","teachingFocusSchemaVersion":2,"teachingFocus":{"examFocus":"模拟加法。","studentRequirements":["能计算1+1。"]},"issues":[]})}
fn write_json(path:&Path,value:&Value)->Value{let bytes=serde_json::to_vec_pretty(value).unwrap();std::fs::write(path,&bytes).unwrap();json!({"path":path,"sha256":sha(&bytes)})}
fn setup()->(tempfile::TempDir,Store,Value,Value){
    let dir=tempfile::tempdir().unwrap();let store=Store::open(dir.path(),&crate::bank::tests::seed()).unwrap();let id="sim-adoption";
    let source=save_source(&store,id,"txt",b"simulated original:1+1").unwrap();
    let mut q=json!({"questionId":"sim-adopt-q1","questionType":"fill_blank","stem":"模拟原题：1+1？","options":[],"parts":[],"answer":"2","solution":"模拟原卷参考","sourceIssues":[],"sourceIdentity":{"system":"simulated"},"student":{"assets":[]},"teacher":{"assets":[]},"assetPayloads":[],"pages":[1],"sourceLabel":"1"});
    q["teachingWorkflow"]=json!({"sourceContentSha256":review::content_hash(&q),"status":"needs_review","reviewCalls":1,"generationCalls":1,"initialCandidate":candidate(),"candidateResult":candidate(),"findings":[{"type":"technical","code":"simulated_previous_failure"}]});
    let mut protected=q.clone();protected["questionId"]=json!("sim-protected-q");
    let record=json!({"importId":id,"source":source,"revision":1,"questions":[q.clone(),protected],"operations":[],"publishedQuestionIds":[],"sourceIssues":[],"backgroundJob":{"status":"completed"}});store.put_document("imports",id,&record).unwrap();
    let material=teaching::material(&q);let body=json!({"model":"simulated-model","messages":[{"role":"system","content":"模拟复核系统指令"},{"role":"user","content":json!({"originalMaterial":material}).to_string()}],"enable_thinking":true});
    let response=json!({"model":"simulated-model","choices":[{"finish_reason":"stop","message":{"content":candidate().to_string()}}]});
    let audit=json!({"samples":[{"questionId":"sim-adopt-q1","candidateSha256":hash_json(&candidate()),"correctAnswer":true,"proofComplete":true,"classroomUsable":true,"materialProblem":false}]});
    let request_file=write_json(&dir.path().join("actual-request.json"),&body);let response_file=write_json(&dir.path().join("actual-response.json"),&response);let audit_file=write_json(&dir.path().join("independent-audit.json"),&audit);
    let payload=json!({"importId":id,"expectedRevision":1,"operationId":"sim-explicit-adoption","authorization":{"request":"模拟：明确授权采纳已核对的新稿，保护题不处理。"},"entries":[{"questionId":"sim-adopt-q1","expectedQuestionSha256":hash_json(&q),"candidateSha256":hash_json(&candidate()),"completedAt":"2026-10-24T00:00:00Z","requestFile":request_file,"responseFile":response_file,"independentAuditFile":audit_file}]});
    (dir,store,record,payload)
}

#[test]
fn simulated_adoption_checks_actual_output_preserves_source_and_protected_question_and_replays(){
    let (_dir,store,before,payload)=setup();let response_path=Path::new(s(&payload["entries"][0]["responseFile"],"path"));let original_response=std::fs::read(response_path).unwrap();
    let result=adopt(&store,&payload).unwrap();let q=&result["import"]["questions"][0];
    assert!(teaching::ready(q));assert_eq!(q["teachingWorkflow"]["finalResult"],candidate());assert_eq!(q["teachingWorkflow"]["reviewCalls"],1);
    assert_eq!(review::content_hash(q),review::content_hash(&before["questions"][0]));assert_eq!(result["import"]["questions"][1],before["questions"][1]);
    teaching::verify_audit(&store,q).unwrap();assert_eq!(std::fs::read(response_path).unwrap(),original_response);
    let same=adopt(&store,&payload).unwrap();assert_eq!(same["replayed"],true);assert_eq!(same["import"],result["import"]);
}

#[test]
fn simulated_adoption_rejects_stale_identity_external_hash_bad_source_or_unchecked_math_before_record_mutation(){
    for mode in 0..8 {
        let (dir,store,before,mut payload)=setup();
        match mode {
            0=>payload["entries"][0]["expectedQuestionSha256"]=json!("stale"),
            1=>payload["entries"][0]["requestFile"]["sha256"]=json!("changed"),
            2=>payload["entries"][0]["candidateSha256"]=json!("wrong-candidate"),
            3=>{let path=Path::new(s(&payload["entries"][0]["requestFile"],"path"));let mut request:Value=serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();let mut context:Value=serde_json::from_str(s(&request["messages"][1],"content")).unwrap();context["originalMaterial"]["stem"]=json!("别的原题");request["messages"][1]["content"]=json!(context.to_string());payload["entries"][0]["requestFile"]=write_json(path,&request);},
            4=>{let path=dir.path().join("actual-response.json");let mut response:Value=serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();response["choices"][0]["finish_reason"]=json!("length");payload["entries"][0]["responseFile"]=write_json(&path,&response);},
            5=>{payload["entries"][0]["independentAuditFile"]=write_json(&dir.path().join("independent-audit.json"),&json!({"samples":[]}));},
            6=>{let repeated=payload["entries"][0].clone();payload["entries"].as_array_mut().unwrap().push(repeated);},
            _=>payload["authorization"]["request"]=json!(""),
        }
        assert!(adopt(&store,&payload).is_err(),"mode {mode}");assert_eq!(store.document("imports","sim-adoption").unwrap(),before,"mode {mode}");
    }
}

#[test]
fn simulated_decoder_merges_real_patch_in_its_declared_verified_source_domain(){
    let (_dir,_store,record,_payload)=setup();let q=&record["questions"][0];let source=teaching::material(q);let c=candidate();let digest=hash_json(&source);
    let context=json!({"originalMaterial":source,"candidate":c,"patchContract":{"questionId":q["questionId"],"candidateSha256":hash_json(&c),"sourceContentSha256":digest,"allowedFields":[{"fieldPath":"teachingFocus.studentRequirements[0]","expectedText":c["teachingFocus"]["studentRequirements"][0]}]}});
    let raw=json!({"questionId":q["questionId"],"candidateSha256":hash_json(&c),"sourceContentSha256":digest,"patches":[{"fieldPath":"teachingFocus.studentRequirements[0]","oldText":c["teachingFocus"]["studentRequirements"][0],"newText":"能写出1+1=2。"}],"unresolvedIssues":[]});
    let before=raw.clone();let merged=teaching::decode_review_candidate(s(q,"questionId"),&digest,&context,&raw).unwrap();assert_eq!(merged["teachingFocus"]["studentRequirements"][0],"能写出1+1=2。");assert_eq!(merged["teachingSolution"],c["teachingSolution"]);assert_eq!(raw,before);
    assert!(teaching::decode_review_candidate(s(q,"questionId"),"wrong-source-domain",&context,&raw).is_err());
}
