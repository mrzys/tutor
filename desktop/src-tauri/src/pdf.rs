use crate::{
    DesktopState,
    error::{AppError, AppResult},
};
use serde_json::{Value, json};
use std::{collections::HashMap, path::PathBuf, sync::Mutex, time::Duration};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

// Native PDF layout version, independent of the legacy Python renderer.
pub const PDF_LAYOUT_VERSION: &str = "desktop-a4-webview-v3";
struct PdfJob {
    path: PathBuf,
    temporary: PathBuf,
    kind: String,
    paper_id: String,
    started: bool,
    sender: oneshot::Sender<AppResult<Value>>,
}
#[derive(Default)]
pub struct PdfJobs(Mutex<HashMap<String, PdfJob>>);

fn finish(app: &tauri::AppHandle, id: &str, result: AppResult<()>) {
    let state = app.state::<DesktopState>();
    let job = state.pdf.0.lock().ok().and_then(|mut jobs| jobs.remove(id));
    if let Some(job) = job {
        let output=result.and_then(|_|{
            let bytes=std::fs::read(&job.temporary)?;
            if !bytes.starts_with(b"%PDF-")||bytes.len()<100 {return Err(AppError::new("pdf_failed","生成的 PDF 无效，原文件已保留。"));}
            // Keep the archived export and only replace the chosen destination on success.
            let staging=job.path.with_file_name(format!(".tutor-{}.tmp",uuid::Uuid::new_v4()));
            let replace=(||->AppResult<()>{
                use std::io::Write;
                let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(&staging)?;
                file.write_all(&bytes)?;file.sync_all()?;drop(file);
                std::fs::rename(&staging,&job.path)?;Ok(())
            })();
            if replace.is_err(){let _=std::fs::remove_file(&staging);}
            replace?;
            use sha2::{Digest,Sha256};
            let mut metadata=json!({"paperId":job.paper_id,"kind":job.kind,"path":job.path,"archivedPath":job.temporary,"sha256":format!("{:x}",Sha256::digest(&bytes)),"layoutVersion":PDF_LAYOUT_VERSION,"createdAt":chrono::Utc::now().to_rfc3339()});
            match state.runtime.lock(){
                Ok(runtime)=>{if runtime.store.put_document("outputs",&uuid::Uuid::new_v4().to_string(),&metadata).is_err(){metadata["warning"]=json!("PDF 已保存，但输出记录未保存。请保留当前文件。");}},
                Err(_)=>{metadata["warning"]=json!("PDF 已保存，但输出记录未保存。请保留当前文件。");}
            }
            Ok(metadata)
        });
        if output.is_err() {
            let _ = std::fs::remove_file(&job.temporary);
        }
        let _ = job.sender.send(output);
    }
    if let Some(window) = app.get_webview_window(id) {
        let _ = window.destroy();
    }
}

pub async fn export(
    app: &tauri::AppHandle,
    state: &DesktopState,
    payload: &Value,
) -> AppResult<Value> {
    if !cfg!(windows) {
        return Err(AppError::new(
            "unsupported_platform",
            "当前 PDF 导出适配 Windows WebView2。",
        ));
    }
    let paper_id = payload["paperId"]
        .as_str()
        .ok_or_else(|| AppError::new("invalid_input", "请选择成卷。"))?
        .to_owned();
    let kind = payload["kind"].as_str().unwrap_or("student").to_owned();
    if !matches!(kind.as_str(), "student" | "teacher") {
        return Err(AppError::new("invalid_input", "输出类型无效。"));
    }
    let (title, directory) = {
        let runtime = state
            .runtime
            .lock()
            .map_err(|_| AppError::new("storage_error", "本地工作区不可用。"))?;
        if runtime.store.profile()?.is_none() {
            return Err(AppError::new("nickname_required", "请先设置昵称。"));
        }
        let paper = runtime.store.document("papers", &paper_id)?;
        crate::assembly::verify_frozen_paper(&paper)?;
        (
            paper["title"].as_str().unwrap_or("练习").to_owned(),
            runtime.store.data_dir.clone(),
        )
    };
    let safe_title = title
        .chars()
        .filter(|c| !c.is_control() && !"<>:\"/\\|?*".contains(*c))
        .take(80)
        .collect::<String>();
    let filename = format!(
        "{}-{}.pdf",
        safe_title,
        if kind == "student" {
            "学生卷"
        } else {
            "教师卷"
        }
    );
    let path = if cfg!(debug_assertions) && std::env::var_os("TUTOR_DESKTOP_QA").is_some() {
        directory.join(&filename)
    } else {
        let handle = app.clone();
        let selected = tauri::async_runtime::spawn_blocking(move || {
            handle
                .dialog()
                .file()
                .add_filter("PDF", &["pdf"])
                .set_file_name(filename)
                .blocking_save_file()
        })
        .await
        .map_err(|_| AppError::new("pdf_failed", "无法打开保存窗口。"))?;
        selected
            .ok_or_else(|| AppError::new("cancelled", "已取消导出。"))?
            .into_path()
            .map_err(|_| AppError::new("invalid_path", "请选择本机保存路径。"))?
    };
    let id = format!("pdf-{}", uuid::Uuid::new_v4());
    let outputs = directory.join("outputs");
    std::fs::create_dir_all(&outputs)?;
    let temporary = outputs.join(format!("{id}.pdf"));
    let (tx, rx) = oneshot::channel();
    {
        let mut jobs = state
            .pdf
            .0
            .lock()
            .map_err(|_| AppError::new("pdf_failed", "PDF 队列不可用。"))?;
        if !jobs.is_empty() {
            return Err(AppError::new("busy", "另一份 PDF 正在生成，请稍候。"));
        }
        jobs.insert(
            id.clone(),
            PdfJob {
                path,
                temporary,
                kind: kind.clone(),
                paper_id: paper_id.clone(),
                started: false,
                sender: tx,
            },
        );
    }
    let url = WebviewUrl::App(
        format!("index.html?exportTask={id}&paperId={paper_id}&kind={kind}").into(),
    );
    if WebviewWindowBuilder::new(app, &id, url)
        .title("智教 · PDF 排版")
        .visible(false)
        .inner_size(900., 1200.)
        .build()
        .is_err()
    {
        finish(
            app,
            &id,
            Err(AppError::new("pdf_failed", "无法启动 PDF 排版窗口。")),
        );
    }
    match tokio::time::timeout(Duration::from_secs(60), rx).await {
        Ok(Ok(result)) => result,
        _ => {
            finish(
                app,
                &id,
                Err(AppError::new("pdf_failed", "PDF 生成超时，已有文件保留。")),
            );
            Err(AppError::new("pdf_failed", "PDF 生成超时，请重试。"))
        }
    }
}

pub fn failed(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
    id: &str,
    _message: &str,
) -> AppResult<()> {
    if window.label() != id {
        return Err(AppError::new("invalid_request", "PDF 任务身份不匹配。"));
    }
    finish(
        app,
        id,
        Err(AppError::new(
            "pdf_failed",
            "试卷排版或图片加载失败，未生成 PDF。",
        )),
    );
    Ok(())
}
pub fn ready(app: &tauri::AppHandle, window: &WebviewWindow, id: &str) -> AppResult<()> {
    if window.label() != id {
        return Err(AppError::new("invalid_request", "PDF 任务身份不匹配。"));
    }
    let state = app.state::<DesktopState>();
    let path = {
        let mut jobs = state
            .pdf
            .0
            .lock()
            .map_err(|_| AppError::new("pdf_failed", "PDF 队列不可用。"))?;
        let job = jobs
            .get_mut(id)
            .ok_or_else(|| AppError::new("not_found", "PDF 任务已结束。"))?;
        if job.started {
            return Err(AppError::new("busy", "PDF 已在生成中。"));
        }
        job.started = true;
        job.temporary.clone()
    };
    #[cfg(windows)]
    {
        use webview2_com::{
            Microsoft::Web::WebView2::Win32::{ICoreWebView2_7, ICoreWebView2Environment6},
            PrintToPdfCompletedHandler,
        };
        use windows::core::{Interface, PCWSTR};
        let app_handle = app.clone();
        let task_id = id.to_owned();
        window
            .with_webview(move |webview| {
                let fail_app = app_handle.clone();
                let fail_id = task_id.clone();
                let start = unsafe {
                    (|| -> windows::core::Result<()> {
                        let view: ICoreWebView2_7 = webview.controller().CoreWebView2()?.cast()?;
                        let environment: ICoreWebView2Environment6 =
                            webview.environment().cast()?;
                        let settings = environment.CreatePrintSettings()?;
                        settings.SetPageWidth(210. / 25.4)?;
                        settings.SetPageHeight(297. / 25.4)?;
                        settings.SetMarginTop(14. / 25.4)?;
                        settings.SetMarginBottom(14. / 25.4)?;
                        settings.SetMarginLeft(14. / 25.4)?;
                        settings.SetMarginRight(14. / 25.4)?;
                        settings.SetShouldPrintHeaderAndFooter(false)?;
                        settings.SetShouldPrintBackgrounds(true)?;
                        let callback =
                            PrintToPdfCompletedHandler::create(Box::new(move |status, success| {
                                let result = if status.is_ok() && success {
                                    Ok(())
                                } else {
                                    Err(AppError::new("pdf_failed", "系统 PDF 生成失败，请重试。"))
                                };
                                // Avoid destroying the WebView inside its own COM callback.
                                let handle = app_handle.clone();
                                let dispatcher = app_handle.clone();
                                let id = task_id.clone();
                                let _ = dispatcher
                                    .run_on_main_thread(move || finish(&handle, &id, result));
                                Ok(())
                            }));
                        let wide = path
                            .to_string_lossy()
                            .encode_utf16()
                            .chain(Some(0))
                            .collect::<Vec<_>>();
                        view.PrintToPdf(PCWSTR(wide.as_ptr()), &settings, &callback)
                    })()
                };
                if start.is_err() {
                    finish(
                        &fail_app,
                        &fail_id,
                        Err(AppError::new(
                            "pdf_failed",
                            "当前 WebView2 不支持 PDF 输出，请更新系统 WebView2。",
                        )),
                    );
                }
            })
            .map_err(|_| AppError::new("pdf_failed", "无法连接系统排版引擎。"))?;
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        finish(
            app,
            id,
            Err(AppError::new(
                "unsupported_platform",
                "当前 PDF 导出仅适配 Windows。",
            )),
        );
    }
    Ok(())
}
