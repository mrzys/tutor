pub mod annotations;
pub mod assembly;
pub mod bank;
pub mod bank_annotations;
pub mod bank_supplement;
pub mod error;
pub mod imports;
pub mod intake;
pub mod knowledge;
pub mod model;
pub mod ocr;
pub mod ocr_settings;
#[cfg(feature = "desktop")]
mod pdf;
mod request_diagnostics;
mod requirements_summary;
pub mod storage;
pub mod student_work;

use bank::BankRepository;
use error::{AppError, AppResult};
use model::ModelClient;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
#[cfg(feature = "desktop")]
use std::sync::{Mutex, atomic::Ordering};
use std::{path::Path, sync::atomic::AtomicBool};
use storage::Store;

fn catalog_text(payload: &Value, key: &str, maximum: usize) -> AppResult<String> {
    match payload.get(key) {
        None => Ok(String::new()),
        Some(Value::String(value))
            if value.chars().count() <= maximum && !value.chars().any(char::is_control) =>
        {
            Ok(value.trim().to_owned())
        }
        _ => Err(AppError::new("invalid_input", "题库筛选条件无效。")),
    }
}

fn catalog_strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| {
            !value.is_empty()
                && value.chars().count() <= 1000
                && !value.chars().any(char::is_control)
        })
        .map(str::to_owned)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn same_catalog_version(row: &Value, question: &Value) -> bool {
    ["questionId", "contentVersion", "teacherVersion"]
        .iter()
        .all(|key| {
            row[*key].as_str().is_some_and(|value| !value.is_empty()) && row[*key] == question[*key]
        })
}

fn catalog_metadata(
    question: &Value,
    entries: &[Value],
    archived: &Value,
    config: &Value,
) -> Value {
    let annotation = entries
        .iter()
        .find(|row| same_catalog_version(row, question));
    let ledger = archived["ledger"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|row| same_catalog_version(row, question) && row["status"] == "ready");
    let analyses = archived["pedagogy"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|row| same_catalog_version(row, question))
        .collect::<Vec<_>>();
    // Duplicate or malformed annotations are not silently chosen as evidence.
    let pedagogy = (analyses.len() == 1).then(|| analyses[0]).filter(|row| {
        matches!(row["status"].as_str(), Some("pending_review" | "reviewed"))
            && ["abilities", "literacies"].iter().all(|key| {
                row[*key]
                    .as_array()
                    .is_some_and(|values| values.iter().all(|value| value.as_str().is_some()))
            })
    });
    let empty = Value::Null;
    let annotation = annotation.unwrap_or(&empty);
    let pedagogy = pedagogy.unwrap_or(&empty);
    let level = annotation["difficultyLevel"]
        .as_str()
        .filter(|level| intake::DIFFICULTY_LEVELS.contains(level))
        .unwrap_or("unknown");
    // scopeEvidence is useful only for the exact currently selectable snapshot.
    let scope = &question["scopeEvidence"];
    let scope_valid = ["contentVersion", "teacherVersion"]
        .iter()
        .all(|key| scope[*key] == question[*key] && scope[*key].is_string());
    let modern = knowledge::uses_knowledge(annotation);
    let valid_knowledge = modern && knowledge::validate_annotation(annotation, config).is_ok();
    let section_ids = knowledge::primary_sections(annotation, config);
    let section_names = |ids: &[String]| -> Vec<String> {
        ids.iter()
            .filter_map(|id| {
                config["chapters"]
                .as_array()?
                .iter()
                .find(|chapter| intake::includes(&json!([id]), intake::s(chapter, "id")))?["label"]
                .as_str()
                .map(str::to_owned)
            })
            .collect()
    };
    let section_labels = section_names(&section_ids);
    let paths: Vec<_> = annotation["solutionPaths"].as_array().into_iter().flatten()
        .filter(|_| !modern || valid_knowledge)
        .map(|path| json!({
            "knowledge":if modern {knowledge::names(config,&path["requiredKnowledgeUids"])}else{section_names(&catalog_strings(&path["requiredSections"]))},
            "premises":catalog_strings(&path["requiredPremises"]).iter().map(|id|config["premises"].as_array().into_iter().flatten().find(|premise|premise["id"]==*id).and_then(|premise|premise["label"].as_str()).unwrap_or("未记录名称")).collect::<Vec<_>>(),
            "basis":path["basis"]
        })).collect();
    let required_uids = json!(
        annotation["solutionPaths"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|path| catalog_strings(&path["requiredKnowledgeUids"]))
            .collect::<BTreeSet<_>>()
    );
    json!({
        "taskSummary":ledger.and_then(|row|row["taskSummary"].as_str()).unwrap_or(""),
        "topics":if modern {if valid_knowledge {knowledge::names(config,&annotation["primaryKnowledgeUids"])} else {vec![]}} else if scope_valid {catalog_strings(&scope["primaryTopics"])} else {vec![]},
        "requiredKnowledge":if modern {if valid_knowledge {knowledge::names(config,&required_uids)} else {vec![]}} else if scope_valid {catalog_strings(&scope["requiredKnowledge"])} else {vec![]},
        "abilities":catalog_strings(&pedagogy["abilities"]),
        "literacies":catalog_strings(&pedagogy["literacies"]),
        "pedagogyStatus":pedagogy["status"].as_str().unwrap_or("unknown"),
        "difficulty":{"level":level,"estimate":annotation["difficultyEstimate"].as_f64(),"basis":if level=="unknown" {Value::Null}else{annotation["difficultyBasis"].clone()}},
        "knowledgeLabel":if modern {"主考知识"}else{"相关知识"},
        "solutionPaths":paths,
        "taskLabels":catalog_strings(&annotation["tasks"]).iter().filter_map(|id|config["tasks"].as_array()?.iter().find(|task|task["id"]==*id)?["label"].as_str().map(str::to_owned)).collect::<Vec<_>>(),
        "sectionIds":section_ids,
        "sectionLabels":section_labels,
        "tasks":catalog_strings(&annotation["tasks"])
    })
}

fn catalog_filter_options(questions: &[Value]) -> Value {
    let difficulty = [("easy", "基础"), ("easy_medium", "基础偏中等"), ("medium", "中等"), ("medium_hard", "中等偏较难"), ("hard", "较难"), ("unknown", "未评估")]
        .map(|(value,label)|json!({"value":value,"label":label,"count":questions.iter().filter(|q|q["catalogMetadata"]["difficulty"]["level"]==value).count()}));
    let tags = |key: &str| {
        let mut counts = BTreeMap::<String, usize>::new();
        let mut unknown = 0;
        for question in questions {
            let labels = catalog_strings(&question["catalogMetadata"][key]);
            if labels.is_empty() {
                unknown += 1;
            }
            for label in labels {
                *counts.entry(label).or_default() += 1;
            }
        }
        let mut values = counts
            .into_iter()
            .map(|(value, count)| json!({"label":value,"value":value,"count":count}))
            .collect::<Vec<_>>();
        values.push(json!({"value":"unknown","label":"未标注","count":unknown}));
        values
    };
    json!({"difficulty":difficulty,"abilities":tags("abilities"),"literacies":tags("literacies")})
}

pub struct Runtime {
    pub store: Store,
    pub model: ModelClient,
    pub ocr: ocr_settings::OcrSettings,
}

fn independent_student_action(action: &str) -> bool {
    action.starts_with("student_work_")
        || matches!(
            action,
            "students_list" | "students_get" | "students_create" | "students_update"
        )
}

/// Student work metadata/cancellation must remain usable while assembly holds
/// its Runtime mutex for a provider request. Open a separate local connection;
/// do not call Runtime::open here, since startup recovery is not a read action.
pub fn independent_student_request(
    data_dir: &Path,
    action: &str,
    payload: &Value,
) -> AppResult<Value> {
    if !independent_student_action(action) || !payload.is_object() {
        return Err(AppError::new("invalid_request", "学生答卷请求无效。"));
    }
    let seed: Value = serde_json::from_str(include_str!("../../resources/seed.json"))?;
    let store = Store::open(data_dir, &seed)?;
    if store.profile()?.is_none() {
        return Err(AppError::new("nickname_required", "请先设置一个昵称。"));
    }
    match action {
        "students_list" => {
            Ok(json!({"students":store.students(payload["query"].as_str().unwrap_or_default())?}))
        }
        "students_get" => {
            Ok(json!({"student":store.student(payload["studentId"].as_str().unwrap_or_default())?}))
        }
        "students_create" => Ok(json!({"student":store.create_student(payload)?})),
        "students_update" => Ok(json!({"student":store.update_student(payload)?})),
        _ => {
            // A second window can change the selected profile while the main
            // Runtime is busy. Explicit starts use the current on-disk choice.
            let model = ModelClient::open(data_dir)?;
            let settings = ocr_settings::OcrSettings::open(data_dir)?;
            student_work::dispatch(&store, &model, &settings, action, payload)?
                .ok_or_else(|| AppError::new("invalid_request", "学生答卷操作不受支持。"))
        }
    }
}
impl Runtime {
    pub fn open(data_dir: &Path) -> AppResult<Self> {
        let seed: Value = serde_json::from_str(include_str!("../../resources/seed.json"))?;
        let store = Store::open(data_dir, &seed)?;
        imports::recover_background_jobs(&store)?;
        student_work::recover_background_jobs(&store)?;
        Ok(Self {
            store,
            model: ModelClient::open(data_dir)?,
            ocr: ocr_settings::OcrSettings::open(data_dir)?,
        })
    }
    pub fn request(
        &mut self,
        action: &str,
        payload: &Value,
        cancel: &AtomicBool,
    ) -> AppResult<Value> {
        if !payload.is_object() {
            return Err(AppError::new("invalid_request", "请求内容无效。"));
        }
        if !matches!(action, "profile_get" | "profile_save" | "bootstrap")
            && self.store.profile()?.is_none()
        {
            return Err(AppError::new("nickname_required", "请先设置一个昵称。"));
        }
        if let Some(result) =
            student_work::dispatch(&self.store, &self.model, &self.ocr, action, payload)?
        {
            return Ok(result);
        }
        match action {
            "profile_get" => {
                Ok(json!({"profile":self.store.profile()?,"dataDirectory":self.store.data_dir}))
            }
            "profile_save" => Ok(
                json!({"profile":self.store.save_profile(payload["nickname"].as_str().unwrap_or_default(),payload["defaultSubject"].as_str().unwrap_or("math"))?}),
            ),
            "bootstrap" => {
                let mut config = self.store.bank.config()?;
                let status = json!({"configured":self.model.configured()});
                for key in [
                    "intake",
                    "blueprintPlanner",
                    "candidateSelector",
                    "assemblyAssistant",
                ] {
                    config[key] = status.clone();
                }
                config["supply"] = json!({"ready":self.store.bank.questions()?.len()});
                config["bankWarning"] = json!(self.store.bank_warning);
                Ok(json!({"config":config}))
            }
            "students_list" => Ok(
                json!({"students":self.store.students(payload["query"].as_str().unwrap_or_default())?}),
            ),
            "students_create" => Ok(json!({"student":self.store.create_student(payload)?})),
            "students_get" => Ok(
                json!({"student":self.store.student(payload["studentId"].as_str().unwrap_or_default())?}),
            ),
            "students_update" => Ok(json!({"student":self.store.update_student(payload)?})),
            "history_list" => {
                let drafts=self.store.list_documents("drafts")?.into_iter().map(|d|json!({"draftId":d["draftId"],"title":d["title"],"revision":d["revision"],"createdAt":d["createdAt"],"confirmedPaperId":d["confirmedPaperId"],"student":d["student"],"students":d["students"],"stats":d["stats"],"scoringMode":d["baseline"]["requirements"]["scoringMode"]})).collect::<Vec<_>>();
                let papers=self.store.list_documents("papers")?.into_iter().map(|p|json!({"paperId":p["paperId"],"title":p["title"],"createdAt":p["createdAt"],"sourceDraftId":p["sourceDraftId"],"summary":p["summary"],"student":p["student"],"students":p["students"]})).collect::<Vec<_>>();
                Ok(json!({"drafts":drafts,"papers":papers}))
            }
            "bank_search" => self.bank_search(payload),
            "bank_catalog" => self.store.bank.catalog(),
            "model_get" => {
                // Refresh explicitly, without issuing any provider request.
                self.model = ModelClient::open(&self.store.data_dir)?;
                Ok(self.model.public_settings())
            }
            "model_save" => self.model.save(payload),
            "ocr_get" => {
                self.ocr = ocr_settings::OcrSettings::open(&self.store.data_dir)?;
                Ok(self.ocr.public_settings())
            }
            "ocr_save" => self.ocr.save(payload),
            "pdf_read" => {
                use base64::Engine;
                use sha2::{Digest, Sha256};
                let id = payload["paperId"]
                    .as_str()
                    .ok_or_else(|| AppError::new("invalid_input", "请选择成卷。"))?;
                let kind = payload["kind"].as_str().unwrap_or("student");
                if !matches!(kind, "student" | "teacher") {
                    return Err(AppError::new("invalid_input", "输出类型无效。"));
                }
                assembly::verify_frozen_paper(&self.store.document("papers", id)?)?;
                let outputs = self.store.list_documents("outputs")?;
                let output = outputs
                    .iter()
                    .find(|value| value["paperId"] == id && value["kind"] == kind)
                    .ok_or_else(|| AppError::new("not_found", "请先生成此版本的 PDF。"))?;
                let root = self.store.data_dir.join("outputs").canonicalize()?;
                let file = std::path::PathBuf::from(
                    output["archivedPath"]
                        .as_str()
                        .ok_or_else(|| AppError::new("integrity_error", "PDF 输出记录无效。"))?,
                )
                .canonicalize()?;
                if !file.starts_with(&root) || std::fs::metadata(&file)?.len() > 50 * 1024 * 1024 {
                    return Err(AppError::new(
                        "integrity_error",
                        "PDF 文件范围或大小校验失败。",
                    ));
                }
                let bytes = std::fs::read(file)?;
                let hash = format!("{:x}", Sha256::digest(&bytes));
                if output["sha256"] != hash || !bytes.starts_with(b"%PDF-") {
                    return Err(AppError::new(
                        "integrity_error",
                        "PDF 文件校验失败，请重新生成。",
                    ));
                }
                Ok(
                    json!({"paperId":id,"kind":kind,"dataBase64":base64::engine::general_purpose::STANDARD.encode(bytes),"sha256":hash,"layoutVersion":output["layoutVersion"]}),
                )
            }
            "feedback_save" => {
                let id = payload["paperId"]
                    .as_str()
                    .ok_or_else(|| AppError::new("invalid_input", "请选择一份成卷。"))?;
                self.store.document("papers", id)?;
                if !matches!(
                    payload["willingToUse"].as_str(),
                    Some("yes" | "after_changes" | "no")
                ) {
                    return Err(AppError::new("invalid_input", "请选择使用反馈。"));
                }
                for key in ["reason", "manualCorrections"] {
                    if payload[key]
                        .as_str()
                        .is_some_and(|s| s.chars().count() > 2000)
                    {
                        return Err(AppError::new("invalid_input", "反馈文字最多 2000 字。"));
                    }
                }
                let mut feedback = match self.store.document("feedback", id) {
                    Ok(value) => value,
                    Err(error) if error.code == "not_found" => json!({"paperId":id,"records":[]}),
                    Err(error) => return Err(error),
                };
                let mut record = payload.clone();
                record["createdAt"] = json!(chrono::Utc::now().to_rfc3339());
                feedback["records"]
                    .as_array_mut()
                    .ok_or_else(|| AppError::new("integrity_error", "反馈记录格式错误。"))?
                    .push(record.clone());
                feedback["latest"] = record;
                self.store.put_document("feedback", id, &feedback)?;
                Ok(json!({"feedback":feedback}))
            }
            _ => {
                if let Some(result) =
                    annotations::dispatch(&mut self.store, action, payload, cancel)?.or(
                        imports::dispatch(&mut self.store, &self.model, action, payload, cancel)?,
                    )
                {
                    Ok(result)
                } else {
                    assembly::dispatch(&mut self.store, action, payload, &self.model, cancel)?
                        .ok_or_else(|| AppError::new("unknown_action", "此操作尚不受支持。"))
                }
            }
        }
    }
    fn bank_search(&self, payload: &Value) -> AppResult<Value> {
        let query = catalog_text(payload, "query", 1000)?.to_lowercase();
        let kind = catalog_text(payload, "questionType", 40)?;
        if !matches!(
            kind.as_str(),
            "" | "single_choice" | "multiple_choice" | "fill_blank" | "free_response"
        ) {
            return Err(AppError::new("invalid_input", "题型无效。"));
        }
        let difficulty = catalog_text(payload, "difficulty", 20)?;
        if !matches!(
            difficulty.as_str(),
            "" | "easy" | "easy_medium" | "medium" | "medium_hard" | "hard" | "unknown"
        ) {
            return Err(AppError::new("invalid_input", "难度筛选无效。"));
        }
        let ability = catalog_text(payload, "ability", 160)?;
        let literacy = catalog_text(payload, "literacy", 160)?;
        let scope = match payload.get("mainScope") {
            None => vec![],
            Some(Value::Array(rows))
                if rows.len() <= 100
                    && rows.iter().all(|value| {
                        value.as_str().is_some_and(|value| {
                            !value.is_empty()
                                && value.len() <= 160
                                && !value.chars().any(char::is_control)
                        })
                    }) =>
            {
                rows.clone()
            }
            _ => return Err(AppError::new("invalid_input", "教材范围筛选无效。")),
        };
        let page_number = |key: &str, default: u64, maximum: u64| -> AppResult<u64> {
            match payload.get(key) {
                None => Ok(default),
                Some(value) => value
                    .as_u64()
                    .filter(|value| *value >= 1 && *value <= maximum)
                    .ok_or_else(|| AppError::new("invalid_input", "分页参数无效。")),
            }
        };
        let requested_page = page_number("page", 1, 100000)?;
        let size = page_number("pageSize", 20, 100)?;
        let knowledge = if let Some(value) = payload.get("knowledgeUid") {
            let uid = value
                .as_str()
                .filter(|uid| !uid.trim().is_empty() && uid.len() <= 120)
                .ok_or_else(|| AppError::new("invalid_input", "请选择有效的知识点。"))?;
            let descendants = match payload.get("includeDescendants") {
                Some(value) => value
                    .as_bool()
                    .ok_or_else(|| AppError::new("invalid_input", "知识点检索范围无效。"))?,
                None => true,
            };
            Some(
                self.store
                    .bank
                    .question_ids_for_knowledge(uid, descendants)?
                    .into_iter()
                    .collect::<std::collections::HashSet<_>>(),
            )
        } else {
            None
        };
        let config = self.store.bank.config()?;
        let entries = config["assemblyIndex"]["entries"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let archived = self.store.bank.catalog_search_metadata()?;
        let base = self
            .store
            .bank
            .questions()?
            .into_iter()
            .map(|mut question| {
                question["catalogMetadata"] =
                    catalog_metadata(&question, &entries, &archived, &config);
                question
            })
            .collect::<Vec<_>>();
        let filter_options = catalog_filter_options(&base);
        let all = base
            .into_iter()
            .filter(|q| {
                (kind.is_empty() || q["questionType"] == kind)
                    && (difficulty.is_empty()
                        || q["catalogMetadata"]["difficulty"]["level"] == difficulty)
                    && [("abilities", &ability), ("literacies", &literacy)]
                        .iter()
                        .all(|(key, value)| {
                            let labels = catalog_strings(&q["catalogMetadata"][*key]);
                            value.is_empty()
                                || (value.as_str() == "unknown" && labels.is_empty())
                                || labels.contains(value)
                        })
                    && knowledge.as_ref().is_none_or(|ids| {
                        q["questionId"].as_str().is_some_and(|id| ids.contains(id))
                    })
                    && (query.is_empty()
                        || q["student"].to_string().to_lowercase().contains(&query)
                        || q["questionId"]
                            .as_str()
                            .unwrap_or_default()
                            .to_lowercase()
                            .contains(&query)
                        || ["taskSummary", "topics", "requiredKnowledge"]
                            .iter()
                            .any(|key| {
                                q["catalogMetadata"][*key]
                                    .to_string()
                                    .to_lowercase()
                                    .contains(&query)
                            }))
                    && (scope.is_empty()
                        || entries.iter().any(|entry| {
                            entry["questionId"] == q["questionId"]
                                && same_catalog_version(entry, q)
                                && intake::overlaps(
                                    &json!(knowledge::primary_sections(entry, &config)),
                                    &json!(scope),
                                )
                        }))
            })
            .collect::<Vec<_>>();
        let total = all.len();
        let total_pages = (total as u64).div_ceil(size).max(1);
        let page = requested_page.min(total_pages);
        Ok(
            json!({"questions":all.into_iter().skip(((page-1)*size) as usize).take(size as usize).collect::<Vec<_>>(),"total":total,"page":page,"pageSize":size,"totalPages":total_pages,"filterOptions":filter_options,"limits":{"pedagogyLabelsAreSelectionEvidence":false}}),
        )
    }
}

#[cfg(feature = "desktop")]
struct DesktopState {
    runtime: Mutex<Runtime>,
    data_dir: std::path::PathBuf,
    cancel: AtomicBool,
    pdf: pdf::PdfJobs,
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn desktop_request(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    action: String,
    payload: Option<Value>,
) -> AppResult<Value> {
    use tauri::Manager;
    let payload = payload.unwrap_or_else(|| json!({}));
    if independent_student_action(&action) {
        let directory = state.data_dir.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            independent_student_request(&directory, &action, &payload)
        })
        .await
        .map_err(|_| AppError::new("internal_error", "学生答卷操作中断，原件及已有结果保留。"))?;
    }
    if action == "pdf_export" {
        return pdf::export(&app, &state, &payload).await;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DesktopState>();
        let mut runtime = state
            .runtime
            .lock()
            .map_err(|_| AppError::new("internal_error", "本地工作区暂不可用，请重新启动。"))?;
        if matches!(
            action.as_str(),
            "intake_prepare"
                | "blueprint_plan"
                | "draft_create"
                | "manual_draft_create"
                | "import_prepare"
                | "import_review_save"
                | "import_publish"
        ) {
            state.cancel.store(false, Ordering::Relaxed);
        }
        runtime.request(&action, &payload, &state.cancel)
    })
    .await
    .map_err(|_| AppError::new("internal_error", "本地操作中断，已有数据保留。"))?
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn desktop_cancel(state: tauri::State<'_, DesktopState>) {
    state.cancel.store(true, Ordering::Relaxed);
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn desktop_pdf_ready(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    task_id: String,
) -> AppResult<()> {
    pdf::ready(&app, &window, &task_id)
}
#[cfg(feature = "desktop")]
#[tauri::command]
fn desktop_pdf_failed(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    task_id: String,
    message: String,
) -> AppResult<()> {
    pdf::failed(&app, &window, &task_id, &message)
}

#[cfg(feature = "desktop")]
pub fn run() {
    use tauri::Manager;
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let directory = if cfg!(debug_assertions) {
                std::env::var_os("TUTOR_DESKTOP_DATA_DIR")
                    .map(std::path::PathBuf::from)
                    .unwrap_or(app.path().app_data_dir()?)
            } else {
                app.path().app_data_dir()?
            };
            let runtime = Runtime::open(&directory)?;
            app.manage(DesktopState {
                data_dir: runtime.store.data_dir.canonicalize()?,
                runtime: Mutex::new(runtime),
                cancel: AtomicBool::new(false),
                pdf: pdf::PdfJobs::default(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_request,
            desktop_cancel,
            desktop_pdf_ready,
            desktop_pdf_failed
        ])
        .run(tauri::generate_context!())
        .expect("无法启动智教桌面应用");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(windows)]
    fn simulated_student_ipc_bypasses_held_assembly_mutex_and_does_not_recover_jobs() {
        use base64::Engine;
        let dir = tempfile::tempdir().unwrap();
        let runtime = Runtime::open(dir.path()).unwrap();
        let assembly = std::sync::Mutex::new(runtime);
        let mut held = assembly.lock().unwrap();
        assert_eq!(
            independent_student_request(dir.path(), "students_list", &json!({}))
                .unwrap_err()
                .code,
            "nickname_required"
        );
        held.store.save_profile("模拟双向隔离", "math").unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        let directory = dir.path().to_path_buf();
        let thread = std::thread::spawn(move || {
            let result = independent_student_request(
                &directory,
                "students_create",
                &json!({"operationId":"simulated-independent-student","name":"模拟学生","notes":"仅本机基础备注"}),
            );
            send.send(result).unwrap();
        });
        let student = receive
            .recv_timeout(std::time::Duration::from_secs(20))
            .expect("student IPC must finish while assembly mutex stays held")
            .unwrap()["student"]
            .clone();
        thread.join().unwrap();
        let mut image = std::io::Cursor::new(vec![]);
        image::DynamicImage::new_rgb8(8, 8)
            .write_to(&mut image, image::ImageFormat::Png)
            .unwrap();
        let created=independent_student_request(dir.path(),"student_work_create",&json!({"operationId":"simulated-independent-work","studentId":student["studentId"],"title":"模拟独立答卷","source":{"kind":"external","externalSourceMode":"answer_contains_questions","files":[]},"answers":[{"filename":"模拟原件.png","contentBase64":base64::engine::general_purpose::STANDARD.encode(image.into_inner())}]})).unwrap();
        let mut record = created["work"].clone();
        record["status"] = json!("running");
        record["job"] = json!({"jobId":"simulated-independent-job","status":"running","operationId":"simulated-independent-attempt","payloadHash":"simulated"});
        held.store
            .put_document("student_work", record["workId"].as_str().unwrap(), &record)
            .unwrap();
        let current = independent_student_request(
            dir.path(),
            "student_work_get",
            &json!({"workId":record["workId"]}),
        )
        .unwrap();
        assert_eq!(
            current["work"]["status"], "running",
            "opening an independent connection must not perform startup job recovery"
        );
        assert_eq!(
            independent_student_request(
                dir.path(),
                "student_work_cancel",
                &json!({"workId":record["workId"],"jobId":"stale-job"})
            )
            .unwrap_err()
            .code,
            "revision_conflict"
        );
        let cancelled = independent_student_request(
            dir.path(),
            "student_work_cancel",
            &json!({"workId":record["workId"],"jobId":record["job"]["jobId"]}),
        )
        .unwrap();
        assert_eq!(cancelled["work"]["status"], "cancelled");
        held.model.save(&json!({"baseUrl":"http://127.0.0.1:9/v1","model":"simulated-stale-runtime-profile","apiKey":"simulated-not-a-real-key"})).unwrap();
        assert!(held.model.configured());
        std::fs::write(
            dir.path().join("model-settings.json"),
            json!({"schemaVersion":2,"revision":100,"activeProfileId":null,"profiles":[]})
                .to_string(),
        )
        .unwrap();
        assert_eq!(independent_student_request(dir.path(),"student_work_retry",&json!({"workId":record["workId"],"expectedRevision":cancelled["work"]["revision"],"operationId":"simulated-current-config-retry"})).unwrap_err().code,"not_configured","independent start must load the current selected configuration, not cached assembly credentials");
        assert!(
            assembly.try_lock().is_err(),
            "assembly mutex stayed held throughout independent requests"
        );
        drop(held);
    }
    #[test]
    fn simulated_catalog_details_use_only_the_current_annotation_version() {
        let question =
            json!({"questionId":"simulated-details","contentVersion":"c1","teacherVersion":"t1"});
        let config = json!({"tasks":[{"id":"task-1","label":"模拟考查点"}],"chapters":[{"id":"rja-compulsory-1:1.1","label":"模拟小节"}]});
        let annotation = json!({"questionId":"simulated-details","contentVersion":"c1","teacherVersion":"t1","difficultyLevel":"medium_hard","difficultyBasis":{"rationale":"模拟关键关口依据"},"tasks":["task-1"],"primarySections":["1.1"]});
        let metadata = catalog_metadata(&question, &[annotation.clone()], &Value::Null, &config);
        assert_eq!(
            metadata["difficulty"]["basis"]["rationale"],
            "模拟关键关口依据"
        );
        assert_eq!(metadata["taskLabels"], json!(["模拟考查点"]));
        assert_eq!(metadata["sectionLabels"], json!(["模拟小节"]));
        let mut stale = annotation;
        stale["teacherVersion"] = json!("old");
        let metadata = catalog_metadata(&question, &[stale], &Value::Null, &config);
        assert_eq!(metadata["difficulty"]["level"], "unknown");
        assert!(metadata["difficulty"]["basis"].is_null());
        assert_eq!(metadata["taskLabels"], json!([]));
        assert_eq!(metadata["sectionLabels"], json!([]));
    }
    #[test]
    fn simulated_five_level_catalog_facets_keep_original_levels_and_version_checks() {
        let dir = tempfile::tempdir().unwrap();
        let mut seed = bank::tests::seed();
        let original = seed["questions"][0].clone();
        let levels = ["easy", "easy_medium", "medium", "medium_hard", "hard"];
        seed["questions"] = json!(
            levels
                .iter()
                .enumerate()
                .map(|(index, _)| {
                    let mut q = original.clone();
                    q["questionId"] = json!(format!("simulated-five-level-{index}"));
                    q
                })
                .collect::<Vec<_>>()
        );
        seed["config"]["assemblyIndex"]["entries"]=json!(seed["questions"].as_array().unwrap().iter().zip(levels).map(|(q,level)|json!({"questionId":q["questionId"],"contentVersion":q["contentVersion"],"teacherVersion":q["teacherVersion"],"difficultyLevel":level,"primarySections":["1.1"]})).collect::<Vec<_>>());
        let store = Store::open(dir.path(), &seed).unwrap();
        store.save_profile("模拟五档难度筛选", "math").unwrap();
        let mut runtime = Runtime {
            store,
            model: ModelClient::open(dir.path()).unwrap(),
            ocr: ocr_settings::OcrSettings::open(dir.path()).unwrap(),
        };
        let cancel = AtomicBool::new(false);
        for (index, level) in levels.iter().enumerate() {
            let result = runtime
                .request("bank_search", &json!({"difficulty":level}), &cancel)
                .unwrap();
            assert_eq!(result["total"], 1);
            assert_eq!(
                result["questions"][0]["questionId"],
                format!("simulated-five-level-{index}")
            );
            assert_eq!(
                result["questions"][0]["catalogMetadata"]["difficulty"]["level"],
                *level
            );
            let facets = result["filterOptions"]["difficulty"].as_array().unwrap();
            for expected in levels {
                assert!(facets.iter().any(|option| option["value"] == expected));
            }
        }
        assert!(
            runtime
                .request("bank_search", &json!({"difficulty":"easy_hard"}), &cancel)
                .is_err()
        );
    }
    #[test]
    fn real_catalog_facets_match_filter_totals_and_intersect_confirmed_scope() {
        let dir = tempfile::tempdir().unwrap();
        let mut runtime = Runtime::open(dir.path()).unwrap();
        let cancel = AtomicBool::new(false);
        runtime
            .request(
                "profile_save",
                &json!({"nickname":"模拟题库筛选回归"}),
                &cancel,
            )
            .unwrap();
        let initial = runtime
            .request("bank_search", &json!({"pageSize":12}), &cancel)
            .unwrap();
        assert_eq!(initial["total"], 378);
        for (category, field) in [
            ("difficulty", "difficulty"),
            ("abilities", "ability"),
            ("literacies", "literacy"),
        ] {
            for option in initial["filterOptions"][category].as_array().unwrap() {
                let mut request = json!({"pageSize":1});
                request[field] = option["value"].clone();
                let filtered = runtime.request("bank_search", &request, &cancel).unwrap();
                assert_eq!(
                    filtered["total"], option["count"],
                    "{category}: {}",
                    option["value"]
                );
                assert_eq!(filtered["filterOptions"], initial["filterOptions"]);
            }
        }
        let uid = "M-K-01-1211";
        let known = runtime
            .store
            .bank
            .question_ids_for_knowledge(uid, true)
            .unwrap();
        let first=runtime.request("bank_search", &json!({"knowledgeUid":uid,"mainScope":["1.3"],"questionType":"single_choice","pageSize":100}), &cancel).unwrap();
        assert!(first["total"].as_u64().unwrap() > 0);
        let question = &first["questions"][0];
        let id = question["questionId"].as_str().unwrap();
        assert!(known.iter().any(|known| known == id));
        let filtered=runtime.request("bank_search", &json!({"knowledgeUid":uid,"mainScope":["1.3"],"questionType":"single_choice","query":id,"difficulty":question["catalogMetadata"]["difficulty"]["level"],"page":9999,"pageSize":12}), &cancel).unwrap();
        assert_eq!(filtered["total"], 1);
        assert_eq!(filtered["page"], 1);
        assert_eq!(filtered["questions"][0], *question);
        let mut exact = question.clone();
        exact.as_object_mut().unwrap().remove("catalogMetadata");
        assert_eq!(exact, runtime.store.bank.question(id).unwrap());
        assert_eq!(
            filtered["limits"]["pedagogyLabelsAreSelectionEvidence"],
            false
        );
        for invalid in [
            json!({"difficulty":"foundation"}),
            json!({"query":1}),
            json!({"ability":"x".repeat(161)}),
            json!({"literacy":[]}),
            json!({"mainScope":[false]}),
            json!({"page":-1}),
            json!({"page":0}),
            json!({"page":100001}),
            json!({"pageSize":101}),
            json!({"pageSize":0}),
        ] {
            assert_eq!(
                runtime
                    .request("bank_search", &invalid, &cancel)
                    .unwrap_err()
                    .code,
                "invalid_input"
            );
        }
    }

    #[test]
    fn simulated_catalog_ignores_stale_or_malformed_labels_and_never_searches_answers() {
        let dir = tempfile::tempdir().unwrap();
        let mut seed = bank::tests::seed();
        let original = seed["questions"][0].clone();
        seed["questions"] = json!(
            (0..5)
                .map(|number| {
                    let mut q = original.clone();
                    q["questionId"] = json!(format!("simulated-search-{number}"));
                    q
                })
                .collect::<Vec<_>>()
        );
        let rows=seed["questions"].as_array().unwrap().iter().map(|q|json!({"questionId":q["questionId"],"contentVersion":q["contentVersion"],"teacherVersion":q["teacherVersion"],"difficultyLevel":"easy","primarySections":["1.1"]})).collect::<Vec<_>>();
        seed["config"]["assemblyIndex"] = json!({"entries":rows});
        seed["config"]["assemblyIndex"]["entries"][2]["teacherVersion"] = json!("teacher-stale");
        let store = Store::open(dir.path(), &seed).unwrap();
        store.save_profile("模拟版本标注回归", "math").unwrap();
        let mut runtime = Runtime {
            store,
            model: ModelClient::open(dir.path()).unwrap(),
            ocr: ocr_settings::OcrSettings::open(dir.path()).unwrap(),
        };
        let cancel = AtomicBool::new(false);
        let q = &seed["questions"][0];
        let entry = |id: &str| json!({"questionId":id,"contentVersion":q["contentVersion"],"teacherVersion":q["teacherVersion"],"abilities":["模拟能力","模拟能力"],"literacies":["模拟素养"],"status":"pending_review"});
        let valid = entry("simulated-search-0");
        let mut stale = entry("simulated-search-1");
        stale["contentVersion"] = json!("content-stale");
        let mut malformed = entry("simulated-search-2");
        malformed["abilities"] = json!([3, "不能部分采信"]);
        let mut rejected = entry("simulated-search-3");
        rejected["status"] = json!("rejected");
        let duplicate = entry("simulated-search-4");
        let analysis = json!({"schemaVersion":1,"entries":[valid,stale,malformed,rejected,duplicate.clone(),duplicate]});
        let ledger = json!({"entries":[{"questionId":q["questionId"],"contentVersion":q["contentVersion"],"teacherVersion":q["teacherVersion"],"status":"ready","taskSummary":"模拟独立考查摘要"}]});
        let connection =
            rusqlite::Connection::open(dir.path().join("question-bank.sqlite")).unwrap();
        for (table, kind, value) in [
            ("question_bank_pedagogy", "analysis", analysis),
            ("question_bank_state", "ledger", ledger),
        ] {
            let row =
                json!({"kind":kind,"payload":value.to_string(),"sha256":bank::hash_json(&value)});
            connection
                .execute(
                    "INSERT INTO bank_local_rows(kind,id,payload,sha256) VALUES(?1,?2,?3,?4)",
                    rusqlite::params![table, kind, row.to_string(), bank::hash_json(&row)],
                )
                .unwrap();
        }
        let result = runtime
            .request("bank_search", &json!({"ability":"模拟能力"}), &cancel)
            .unwrap();
        assert_eq!(result["total"], 1);
        assert_eq!(
            result["questions"][0]["catalogMetadata"]["pedagogyStatus"],
            "pending_review"
        );
        assert_eq!(
            runtime
                .request("bank_search", &json!({"ability":"unknown"}), &cancel)
                .unwrap()["total"],
            4
        );
        assert_eq!(
            runtime
                .request("bank_search", &json!({"literacy":"模拟素养"}), &cancel)
                .unwrap()["total"],
            1
        );
        assert_eq!(
            runtime
                .request("bank_search", &json!({"difficulty":"unknown"}), &cancel)
                .unwrap()["total"],
            1
        );
        assert_eq!(
            runtime
                .request("bank_search", &json!({"query":"模拟独立考查摘要"}), &cancel)
                .unwrap()["total"],
            1
        );
        assert_eq!(
            runtime
                .request(
                    "bank_search",
                    &json!({"query":"scoringSuggestions"}),
                    &cancel
                )
                .unwrap()["total"],
            0
        );
        let missing = runtime
            .request(
                "bank_search",
                &json!({"query":"不存在的题目","page":100}),
                &cancel,
            )
            .unwrap();
        assert_eq!(missing["page"], 1);
        assert_eq!(missing["totalPages"], 1);
        connection
            .execute(
                "UPDATE bank_local_rows SET sha256='invalid' WHERE kind='question_bank_pedagogy'",
                [],
            )
            .unwrap();
        assert_eq!(
            runtime
                .request("bank_search", &json!({}), &cancel)
                .unwrap_err()
                .code,
            "integrity_error"
        );
    }

    #[test]
    fn local_profile_gates_personal_actions_without_authentication() {
        let dir = tempfile::tempdir().unwrap();
        let mut runtime = Runtime::open(dir.path()).unwrap();
        let cancel = AtomicBool::new(false);
        assert!(runtime.request("profile_get", &json!({}), &cancel).unwrap()["profile"].is_null());
        assert_eq!(
            runtime
                .request("students_list", &json!({}), &cancel)
                .unwrap_err()
                .code,
            "nickname_required"
        );
        runtime
            .request("profile_save", &json!({"nickname":"模拟私教"}), &cancel)
            .unwrap();
        assert!(
            runtime
                .request("history_list", &json!({}), &cancel)
                .unwrap()["drafts"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            runtime.request("bank_search", &json!({}), &cancel).unwrap()["total"],
            378
        );
        assert_eq!(
            runtime
                .request("login", &json!({}), &cancel)
                .unwrap_err()
                .code,
            "unknown_action"
        );
    }
    #[test]
    fn bank_scope_search_uses_canonical_primary_sections() {
        let dir = tempfile::tempdir().unwrap();
        let mut runtime = Runtime::open(dir.path()).unwrap();
        let cancel = AtomicBool::new(false);
        runtime
            .request("profile_save", &json!({"nickname":"模拟教师"}), &cancel)
            .unwrap();
        let short = runtime
            .request(
                "bank_search",
                &json!({"mainScope":["1.1"],"pageSize":100}),
                &cancel,
            )
            .unwrap();
        let canonical = runtime
            .request(
                "bank_search",
                &json!({"mainScope":["rja-compulsory-1:1.1"],"pageSize":100}),
                &cancel,
            )
            .unwrap();
        assert_eq!(short, canonical);
        assert!(short["total"].as_u64().unwrap() > 0);
        let config = runtime.store.bank.config().unwrap();
        for question in short["questions"].as_array().unwrap() {
            let annotation = config["assemblyIndex"]["entries"]
                .as_array()
                .unwrap()
                .iter()
                .find(|a| a["questionId"] == question["questionId"])
                .unwrap();
            assert!(intake::includes(&annotation["primarySections"], "1.1"));
        }
    }
    #[test]
    fn real_bank_catalog_and_uid_search_use_confirmed_mapping_identities() {
        let directory = tempfile::tempdir().unwrap();
        let mut runtime = Runtime::open(directory.path()).unwrap();
        let cancel = AtomicBool::new(false);
        runtime
            .request("profile_save", &json!({"nickname":"模拟导航回归"}), &cancel)
            .unwrap();
        let catalog = runtime
            .request("bank_catalog", &json!({}), &cancel)
            .unwrap();
        assert_eq!(catalog["readyCount"], 378);
        assert_eq!(catalog["textbooks"].as_array().unwrap().len(), 5);
        fn count(nodes: &Value) -> usize {
            nodes
                .as_array()
                .unwrap()
                .iter()
                .map(|node| 1 + count(&node["children"]))
                .sum()
        }
        assert_eq!(count(&catalog["knowledgePoints"]), 509);
        let uid = "M-K-01-1211";
        let expected = runtime
            .store
            .bank
            .question_ids_for_knowledge(uid, true)
            .unwrap();
        assert!(!expected.is_empty());
        let result = runtime
            .request(
                "bank_search",
                &json!({"knowledgeUid":uid,"pageSize":100}),
                &cancel,
            )
            .unwrap();
        assert_eq!(result["total"].as_u64(), Some(expected.len() as u64));
        assert!(
            result["questions"]
                .as_array()
                .unwrap()
                .iter()
                .all(|q| expected.iter().any(|id| q["questionId"] == *id))
        );
        assert_eq!(
            runtime
                .request("bank_search", &json!({"knowledgeUid":"交集"}), &cancel)
                .unwrap_err()
                .code,
            "not_found"
        );
        assert_eq!(
            runtime
                .request(
                    "bank_search",
                    &json!({"knowledgeUid":uid,"includeDescendants":"true"}),
                    &cancel
                )
                .unwrap_err()
                .code,
            "invalid_input"
        );
    }
    #[test]
    fn import_route_requires_model_before_touching_untrusted_file_bytes() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("model-settings.json"), r#"{"baseUrl":"https://example.invalid/v1","model":"simulated-unconfigured","protectedKey":""}"#).unwrap();
        let mut runtime = Runtime::open(directory.path()).unwrap();
        let cancel = AtomicBool::new(false);
        runtime
            .request("profile_save", &json!({"nickname":"模拟导入门禁"}), &cancel)
            .unwrap();
        assert_eq!(
            runtime.request("model_get", &json!({}), &cancel).unwrap()["configured"],
            false
        );
        assert_eq!(runtime.request("import_prepare", &json!({"filename":"../bad.pdf","contentBase64":"NOT BASE64","operationId":"simulated-gate"}), &cancel).unwrap_err().code, "not_configured");
        assert!(!directory.path().join("imports").exists());
        assert!(
            runtime
                .request("imports_list", &json!({}), &cancel)
                .unwrap()["imports"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            runtime.request("bank_search", &json!({}), &cancel).unwrap()["total"],
            378
        );
    }
    #[test]
    fn simulated_migration_conflict_keeps_existing_workspace_open_with_visible_warning() {
        let directory = tempfile::tempdir().unwrap();
        let baseline: Value =
            serde_json::from_str(include_str!("../../resources/seed-v1-baseline.json")).unwrap();
        let old = Store::open(directory.path(), &baseline).unwrap();
        old.save_profile("模拟已有教师", "math").unwrap();
        old.put_document(
            "drafts",
            "simulated-kept",
            &json!({"draftId":"simulated-kept","title":"模拟已有草稿"}),
        )
        .unwrap();
        drop(old);
        let connection =
            rusqlite::Connection::open(directory.path().join("question-bank.sqlite")).unwrap();
        let mut question = baseline["questions"][0].clone();
        question["student"]["stem"] = json!("模拟本地已修改内容，不允许升级覆盖。");
        let hash = bank::hash_json(&question["student"]);
        let version = format!("content-{}", &hash[..16]);
        question["contentSha256"] = json!(hash);
        question["contentVersion"] = json!(version);
        question["verification"]["contentVersion"] = json!(version);
        connection
            .execute(
                "UPDATE bank_questions SET payload=?1 WHERE id=?2",
                rusqlite::params![
                    serde_json::to_string(&question).unwrap(),
                    question["questionId"].as_str().unwrap()
                ],
            )
            .unwrap();
        drop(connection);
        let mut runtime = Runtime::open(directory.path()).unwrap();
        assert_eq!(runtime.store.bank.questions().unwrap().len(), 45);
        assert_eq!(
            runtime.store.profile().unwrap().unwrap()["nickname"],
            "模拟已有教师"
        );
        assert_eq!(
            runtime.store.document("drafts", "simulated-kept").unwrap()["title"],
            "模拟已有草稿"
        );
        assert_eq!(
            runtime
                .store
                .bank
                .question(question["questionId"].as_str().unwrap())
                .unwrap(),
            question
        );
        let config = runtime
            .request("bootstrap", &json!({}), &AtomicBool::new(false))
            .unwrap();
        assert!(
            config["config"]["bankWarning"]
                .as_str()
                .unwrap()
                .contains("升级未完成")
        );
        assert_eq!(config["config"]["supply"]["ready"], 45);
    }
    #[test]
    fn model_read_refreshes_external_configuration_before_explicit_retry() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("model-settings.json"),
            br#"{"schemaVersion":2,"revision":0,"activeProfileId":null,"profiles":[]}"#,
        )
        .unwrap();
        let cancel = AtomicBool::new(false);
        let mut first = Runtime::open(directory.path()).unwrap();
        first
            .request(
                "profile_save",
                &json!({"nickname":"模拟多窗口模型回归"}),
                &cancel,
            )
            .unwrap();
        let mut second = Runtime::open(directory.path()).unwrap();
        let saved = first.request("model_save", &json!({"expectedRevision":0,"activeProfileId":"simulated-a",
            "profiles":[{"id":"simulated-a","name":"模拟配置","baseUrl":"https://example.com/v1","model":"simulated-model"}]}), &cancel).unwrap();
        let stale = json!({"expectedRevision":0,"activeProfileId":null,"profiles":[]});
        assert_eq!(
            second
                .request("model_save", &stale, &cancel)
                .unwrap_err()
                .code,
            "revision_conflict"
        );
        let fresh = second.request("model_get", &json!({}), &cancel).unwrap();
        assert_eq!(fresh["revision"], saved["revision"]);
        assert_eq!(fresh["profiles"][0]["name"], "模拟配置");
        assert!(!fresh.to_string().contains("protectedKey"));
        let cleared = second
            .request(
                "model_save",
                &json!({"expectedRevision":fresh["revision"],"activeProfileId":null,"profiles":[]}),
                &cancel,
            )
            .unwrap();
        assert_eq!(cleared["configured"], false);
        assert!(cleared["profiles"].as_array().unwrap().is_empty());
    }

    #[test]
    fn pdf_reads_only_frozen_paper_matching_kind_hash_and_archive_boundary() {
        use sha2::{Digest, Sha256};
        let dir = tempfile::tempdir().unwrap();
        let mut runtime = Runtime::open(dir.path()).unwrap();
        let cancel = AtomicBool::new(false);
        runtime
            .request("profile_save", &json!({"nickname":"模拟教师"}), &cancel)
            .unwrap();
        let r = runtime
            .request(
                "intake_prepare",
                &json!({"requirements":{},"message":"4道题","mode":"rule"}),
                &cancel,
            )
            .unwrap();
        let b = runtime
            .request(
                "blueprint_plan",
                &json!({"requirements":r["requirements"],"mode":"rule"}),
                &cancel,
            )
            .unwrap();
        let d = runtime
            .request(
                "draft_create",
                &json!({"blueprint":b["blueprint"],"mode":"rule"}),
                &cancel,
            )
            .unwrap();
        let p=runtime.request("paper_confirm",&json!({"draftId":d["draft"]["draftId"],"expectedRevision":d["draft"]["revision"],"operationId":"simulated-confirm","acknowledgeDifferences":true}),&cancel).unwrap();
        let id = p["paper"]["paperId"].as_str().unwrap();
        let outputs = dir.path().join("outputs");
        std::fs::create_dir_all(&outputs).unwrap();
        let file = outputs.join("mock.pdf");
        let bytes = b"%PDF-1.7\nSimulated read-boundary fixture, not a rendered paper";
        std::fs::write(&file, bytes).unwrap();
        runtime.store.put_document("outputs","output-case",&json!({"paperId":id,"kind":"student","archivedPath":file,"sha256":format!("{:x}",Sha256::digest(bytes)),"createdAt":"2026-10-17"})).unwrap();
        assert!(
            runtime
                .request("pdf_read", &json!({"paperId":id,"kind":"student"}), &cancel)
                .unwrap()["dataBase64"]
                .is_string()
        );
        assert_eq!(
            runtime
                .request("pdf_read", &json!({"paperId":id,"kind":"teacher"}), &cancel)
                .unwrap_err()
                .code,
            "not_found"
        );
        std::fs::write(&file, b"%PDF-tampered").unwrap();
        assert_eq!(
            runtime
                .request("pdf_read", &json!({"paperId":id,"kind":"student"}), &cancel)
                .unwrap_err()
                .code,
            "integrity_error"
        );
        let outside = dir.path().join("outside.pdf");
        std::fs::write(&outside, bytes).unwrap();
        runtime.store.put_document("outputs","output-case",&json!({"paperId":id,"kind":"student","archivedPath":outside,"sha256":format!("{:x}",Sha256::digest(bytes))})).unwrap();
        assert_eq!(
            runtime
                .request("pdf_read", &json!({"paperId":id,"kind":"student"}), &cancel)
                .unwrap_err()
                .code,
            "integrity_error"
        );
    }
}
