//! Resume only the import's own accepted provider task. A malformed receipt is
//! an error, never permission to pay for another OCR submission.
use super::*;
use std::path::PathBuf;

pub(super) fn accepted_attempt(
    store: &Store,
    record: &Value,
    settings: &crate::ocr_settings::OcrSettings,
) -> AppResult<Option<PathBuf>> {
    let previous = &record["ocrAttempt"];
    if previous.is_null() { return Ok(None); }
    if !previous.is_object() || s(previous,"relativePath").is_empty() {
        return Err(err("source_changed", "旧识别尝试缺少有效本机证据，未重新上传。"));
    }
    let all_imports = store.data_dir.join("imports").canonicalize()?;
    let root = store.data_dir.join("imports").join(s(record,"importId")).canonicalize()?;
    let old = store.data_dir.join(s(previous,"relativePath")).canonicalize()?;
    if !root.starts_with(&all_imports) || old == root || !old.starts_with(&root)
        || !old.is_dir()
        || (previous.get("sourceSha256").is_some() && previous["sourceSha256"] != record["source"]["sha256"]) {
        return Err(err("source_changed", "旧识别任务与当前原件或所属目录不匹配，未重新上传。"));
    }
    if !crate::ocr::has_accepted_job(&old)? { return Ok(None); }
    if previous["provider"] != settings.descriptor() {
        return Err(err("ocr_resume_provider_changed", "旧识别任务的服务商或模型与当前配置不同，原材料保留，未重新上传。"));
    }
    if !old.join("ocr-binding.json").is_file() {
        return Err(err("ocr_resume_legacy_confirmation_required", "识别已受理，旧记录需要核对任务与原件后恢复下载；原结果保留，未重复提交识别。"));
    }
    Ok(Some(old))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Store, crate::ocr_settings::OcrSettings, Value) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), &crate::bank::tests::seed()).unwrap();
        let mut settings = crate::ocr_settings::OcrSettings::open(dir.path()).unwrap();
        settings.save(&json!({"expectedRevision":settings.public_settings()["revision"],"baseUrl":"http://127.0.0.1:1/jobs","model":"PaddleOCR-VL-1.6","apiKey":"simulated-only"})).unwrap();
        std::fs::create_dir_all(dir.path().join("imports/import-simulated/ocr-old")).unwrap();
        let record = json!({"importId":"import-simulated","source":{"sha256":"simulated-source"},"ocrAttempt":{"relativePath":"imports/import-simulated/ocr-old","provider":settings.descriptor(),"sourceSha256":"simulated-source"}});
        (dir,store,settings,record)
    }
    #[test]
    fn accepted_task_selection_is_local_and_preserves_ownership() {
        let (dir,store,settings,mut record)=fixture();
        assert!(accepted_attempt(&store,&record,&settings).unwrap().is_none());
        std::fs::write(dir.path().join("imports/import-simulated/ocr-old/001-submit.json"),json!({"httpStatus":200,"response":{"code":0,"data":{"jobId":"simulated-job"}}}).to_string()).unwrap();
        assert_eq!(accepted_attempt(&store,&record,&settings).unwrap_err().code,"ocr_resume_legacy_confirmation_required");
        std::fs::write(dir.path().join("imports/import-simulated/ocr-old/ocr-binding.json"),"{}").unwrap();
        assert!(accepted_attempt(&store,&record,&settings).unwrap().is_some());
        record["ocrAttempt"]["provider"]["model"]=json!("different-model");
        assert_eq!(accepted_attempt(&store,&record,&settings).unwrap_err().code,"ocr_resume_provider_changed");
        record["ocrAttempt"]["sourceSha256"]=json!("other-source");
        assert_eq!(accepted_attempt(&store,&record,&settings).unwrap_err().code,"source_changed");
        record["ocrAttempt"]["sourceSha256"]=record["source"]["sha256"].clone();
        std::fs::create_dir_all(dir.path().join("imports/import-other/ocr-old")).unwrap();
        record["ocrAttempt"]["relativePath"]=json!("imports/import-other/ocr-old");
        assert_eq!(accepted_attempt(&store,&record,&settings).unwrap_err().code,"source_changed");
    }
    #[test]
    fn damaged_receipt_never_becomes_permission_to_resubmit() {
        let (dir,store,settings,record)=fixture();
        std::fs::write(dir.path().join("imports/import-simulated/ocr-old/001-submit.json"),"{damaged").unwrap();
        assert!(accepted_attempt(&store,&record,&settings).is_err());
    }
}
