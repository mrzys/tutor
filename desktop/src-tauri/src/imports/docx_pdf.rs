//! Preserve DOCX layout through an installed office renderer before OCR.
//! No document text or pathname is interpolated into executable script source.
use crate::error::{AppError, AppResult};
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

fn failure(code: &str, message: &str) -> AppError {
    AppError::new(code, message)
}
fn cancelled(cancel: &AtomicBool) -> AppResult<()> {
    if cancel.load(Ordering::Relaxed) {
        Err(failure("cancelled", "已停止文档转换，原件已保留。"))
    } else {
        Ok(())
    }
}

pub(super) fn convert(source: &Path, output_dir: &Path, cancel: &AtomicBool) -> AppResult<PathBuf> {
    cancelled(cancel)?;
    let source = source.canonicalize()?;
    if !source.is_file()
        || !source
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("docx"))
    {
        return Err(failure("invalid_document", "请选择有效的 DOCX 原件。"));
    }
    let bytes = std::fs::metadata(&source)?.len();
    if bytes == 0 || bytes > 15 * 1024 * 1024 {
        return Err(failure("file_too_large", "DOCX 原件需为 1 字节至 15 MB。"));
    }
    let document = std::fs::File::open(&source)?;
    let mut archive = zip::ZipArchive::new(document).map_err(|_| {
        failure(
            "invalid_document",
            "DOCX 文件结构无效，请从原文档重新导出。",
        )
    })?;
    archive
        .by_name("word/document.xml")
        .map_err(|_| failure("invalid_document", "DOCX 缺少正文，请从原文档重新导出。"))?;
    drop(archive);
    cancelled(cancel)?;
    #[cfg(windows)]
    {
        windows::convert_installed(&source, output_dir, cancel)
    }
    #[cfg(not(windows))]
    {
        let _ = (output_dir, source);
        Err(failure(
            "docx_renderer_unavailable",
            "当前平台无法保真转换 DOCX，请先导出 PDF 再导入。",
        ))
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{
        io::Write,
        os::windows::process::CommandExt,
        process::{Child, Command, Stdio},
        time::{Duration, Instant},
    };
    const HIDDEN: u32 = 0x08000000;
    const TIMEOUT: Duration = Duration::from_secs(120);

    // All arguments arrive as environment variables. The script is repository-owned data,
    // never generated from uploaded DOCX contents or from a user-supplied filename.
    const WORD_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class TutorWordWindow { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId); }'
$before = @(Get-Process -Name WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$word = $null
$probe = $null
$document = $null
$ownsWord = $false
$previousLinks = $null
$stage = 'createWord'
try {
    $word = New-Object -ComObject Word.Application
    $word.AutomationSecurity = 3
    $word.DisplayAlerts = 0
    $stage = 'identifyWord'
    $missing = [Type]::Missing
    $probe = $word.Documents.Add($missing, $false, 0, $true)
    $stage = 'identifyWordWindow'
    [uint32]$wordPid = 0
    [void][TutorWordWindow]::GetWindowThreadProcessId([IntPtr]$probe.Windows.Item(1).Hwnd, [ref]$wordPid)
    if ($wordPid -eq 0 -or $before -contains [int]$wordPid) { throw 'Cannot isolate office instance' }
    $process = Get-Process -Id $wordPid -ErrorAction Stop
    if ($process.ProcessName -ne 'WINWORD') { throw 'Unexpected office process' }
    $ownsWord = $true
    $owner = @{ pid = [int]$wordPid; started = $process.StartTime.ToUniversalTime().Ticks.ToString(); nonce = $env:TUTOR_DOCX_NONCE }
    [IO.File]::WriteAllText($env:TUTOR_DOCX_OWNER, ($owner | ConvertTo-Json -Compress))
    $probe.Close(0)
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($probe)
    $probe = $null
    $stage = 'configureWord'
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $word.AutomationSecurity = 3
    $previousLinks = $word.Options.UpdateLinksAtOpen
    $word.Options.UpdateLinksAtOpen = $false
    $stage = 'openDocument'
    $document = $word.Documents.Open($env:TUTOR_DOCX_SOURCE, $false, $true, $false)
    $stage = 'exportPdf'
    $document.ExportAsFixedFormat($env:TUTOR_DOCX_PDF, 17, $false)
} catch {
    try { [IO.File]::WriteAllText($env:TUTOR_DOCX_DIAGNOSTIC, (@{stage=$stage; errorType=$_.Exception.GetType().FullName; hresult=$_.Exception.HResult} | ConvertTo-Json -Compress)) } catch {}
    exit 12
} finally {
    if ($null -ne $probe) {
        try { $probe.Close(0) } catch {}
        try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($probe) } catch {}
    }
    if ($null -ne $document) {
        try { $document.Close(0) } catch {}
        try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) } catch {}
    }
    if ($ownsWord -and $null -ne $word) {
        if ($null -ne $previousLinks) { try { $word.Options.UpdateLinksAtOpen = $previousLinks } catch {} }
        try { $word.Quit(0) } catch {}
    }
    if ($null -ne $word) { try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) } catch {} }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
"#;
    const CLEANUP_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
try {
    $owner = [IO.File]::ReadAllText($env:TUTOR_DOCX_OWNER) | ConvertFrom-Json
    if ($owner.nonce -ne $env:TUTOR_DOCX_NONCE) { exit 1 }
    $process = Get-Process -Id ([int]$owner.pid) -ErrorAction Stop
    if ($process.ProcessName -ne 'WINWORD' -or $process.StartTime.ToUniversalTime().Ticks.ToString() -ne $owner.started) { exit 1 }
    Stop-Process -Id $process.Id -Force -ErrorAction Stop
} catch { exit 1 }
"#;
    fn system_binary(name: &str) -> PathBuf {
        PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
            .join("System32")
            .join(name)
    }
    fn powershell() -> PathBuf {
        system_binary("WindowsPowerShell/v1.0/powershell.exe")
    }
    fn office_path(path: &Path) -> AppResult<PathBuf> {
        let value = path.to_str().ok_or_else(|| {
            failure(
                "invalid_document",
                "文档路径无法读取，请使用有效的本机文件名。",
            )
        })?;
        Ok(if let Some(value) = value.strip_prefix(r"\\?\UNC\") {
            PathBuf::from(format!(r"\\{value}"))
        } else {
            PathBuf::from(value.strip_prefix(r"\\?\").unwrap_or(value))
        })
    }
    fn command(binary: &Path) -> Command {
        let mut cmd = Command::new(binary);
        cmd.creation_flags(HIDDEN)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        cmd
    }
    fn installed(name: &str) -> Option<PathBuf> {
        ["ProgramFiles", "ProgramFiles(x86)"]
            .into_iter()
            .filter_map(std::env::var_os)
            .flat_map(|root| {
                let root = PathBuf::from(root);
                if name == "word" {
                    vec![
                        root.join("Microsoft Office/root/Office16/WINWORD.EXE"),
                        root.join("Microsoft Office/Office16/WINWORD.EXE"),
                    ]
                } else {
                    vec![
                        root.join("LibreOffice/program/soffice.com"),
                        root.join("LibreOffice/program/soffice.exe"),
                    ]
                }
            })
            .find(|path| path.is_file())
    }
    fn write_new(path: &Path, bytes: &[u8]) -> AppResult<()> {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(())
    }
    fn shell(script: &Path) -> Command {
        let mut cmd = command(&powershell());
        cmd.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Sta",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(script);
        cmd
    }
    fn stop_tree(child: &mut Child) {
        // The still-running child is this operation's own launcher; never target an image name.
        if matches!(child.try_wait(), Ok(None)) {
            let _ = command(&system_binary("taskkill.exe"))
                .args(["/PID", &child.id().to_string(), "/T", "/F"])
                .status();
            let _ = child.kill();
        }
        let _ = child.wait();
    }
    fn cleanup_word(script: &Path, owner: &Path, nonce: &str) {
        if owner.is_file() {
            if let Ok(mut cleanup) = shell(script)
                .env("TUTOR_DOCX_OWNER", owner)
                .env("TUTOR_DOCX_NONCE", nonce)
                .spawn()
            {
                let start = Instant::now();
                loop {
                    if !matches!(cleanup.try_wait(), Ok(None)) {
                        break;
                    }
                    if start.elapsed() > Duration::from_secs(8) {
                        stop_tree(&mut cleanup);
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }
    fn wait(child: &mut Child, cancel: &AtomicBool, timeout: Duration) -> AppResult<()> {
        let start = Instant::now();
        loop {
            if cancel.load(Ordering::Relaxed) {
                stop_tree(child);
                return Err(failure("cancelled", "已停止文档转换，原件已保留。"));
            }
            if start.elapsed() > timeout {
                stop_tree(child);
                return Err(failure(
                    "docx_conversion_timeout",
                    "DOCX 转换超时，原件已保留；请先用 Word 或 LibreOffice 导出 PDF 再导入。",
                ));
            }
            match child.try_wait()? {
                Some(status) if status.success() => return Ok(()),
                Some(_) => {
                    return Err(failure(
                        "docx_conversion_failed",
                        "DOCX 转换失败，原件已保留；请检查文档是否加密或受保护，或先导出 PDF 再导入。",
                    ));
                }
                None => std::thread::sleep(Duration::from_millis(60)),
            }
        }
    }
    fn validate_pdf(path: &Path) -> AppResult<()> {
        let metadata = std::fs::symlink_metadata(path).map_err(|_| {
            failure(
                "docx_conversion_failed",
                "DOCX 未生成 PDF，原件已保留；请先导出 PDF 再导入。",
            )
        })?;
        if !metadata.file_type().is_file()
            || metadata.len() < 20
            || metadata.len() > 100 * 1024 * 1024
        {
            return Err(failure(
                "docx_conversion_failed",
                "DOCX 转换结果为空或过大，请先分拆或导出 PDF 再导入。",
            ));
        }
        let document = lopdf::Document::load(path).map_err(|_| {
            failure(
                "docx_conversion_failed",
                "DOCX 转换结果不是有效 PDF，原件已保留。",
            )
        })?;
        if document.get_pages().is_empty() {
            return Err(failure(
                "docx_conversion_failed",
                "DOCX 转换未生成页面，原件已保留。",
            ));
        }
        Ok(())
    }
    pub(super) fn convert_installed(
        source: &Path,
        output_dir: &Path,
        cancel: &AtomicBool,
    ) -> AppResult<PathBuf> {
        // Office COM does not consistently accept Rust's Windows verbatim prefixes.
        let source = office_path(source)?;
        let word = installed("word");
        let libreoffice = installed("libreoffice");
        if word.is_none() && libreoffice.is_none() {
            return Err(failure(
                "docx_renderer_unavailable",
                "保真导入 DOCX 需要本机已安装 Word 或 LibreOffice；请先导出 PDF 再导入。",
            ));
        }
        if word.is_some() && !powershell().is_file() {
            return Err(failure(
                "docx_renderer_unavailable",
                "无法启动本机 Word 转换，请先导出 PDF 再导入。",
            ));
        }
        cancelled(cancel)?;
        std::fs::create_dir_all(output_dir)?;
        let attempt = output_dir.join(format!("docx-render-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&attempt)?;
        let attempt = office_path(&attempt.canonicalize()?)?;
        let output = if word.is_some() {
            let script = attempt.join("word-to-pdf.ps1");
            let cleanup = attempt.join("cleanup-word.ps1");
            let owner = attempt.join("word-owner.json");
            let output = attempt.join("document.pdf");
            let nonce = uuid::Uuid::new_v4().to_string();
            write_new(&script, WORD_SCRIPT.as_bytes())?;
            write_new(&cleanup, CLEANUP_SCRIPT.as_bytes())?;
            let mut child = shell(&script)
                .env("TUTOR_DOCX_SOURCE", &source)
                .env("TUTOR_DOCX_PDF", &output)
                .env("TUTOR_DOCX_OWNER", &owner)
                .env(
                    "TUTOR_DOCX_DIAGNOSTIC",
                    attempt.join("conversion-diagnostic.json"),
                )
                .env("TUTOR_DOCX_NONCE", &nonce)
                .spawn()
                .map_err(|_| {
                    failure(
                        "docx_renderer_unavailable",
                        "无法启动 Word 文档转换，请先导出 PDF 再导入。",
                    )
                })?;
            let result = wait(&mut child, cancel, TIMEOUT);
            cleanup_word(&cleanup, &owner, &nonce);
            result?;
            output
        } else {
            let libreoffice = libreoffice.unwrap();
            let profile = attempt.join("libreoffice-profile");
            let user = profile.join("user");
            std::fs::create_dir_all(&user)?;
            // An isolated profile prevents contacting the user's running office instance.
            // Disable macros and automatic external-link updates in this disposable profile.
            write_new(&user.join("registrymodifications.xcu"), br#"<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item></oor:items>"#)?;
            let profile = reqwest::Url::from_directory_path(&profile)
                .map_err(|_| failure("docx_conversion_failed", "无法创建独立文档转换配置。"))?;
            let mut child = command(&libreoffice)
                .arg(format!("-env:UserInstallation={profile}"))
                .args([
                    "--headless",
                    "--nologo",
                    "--nodefault",
                    "--norestore",
                    "--convert-to",
                    "pdf",
                    "--outdir",
                ])
                .arg(&attempt)
                .arg(&source)
                .spawn()
                .map_err(|_| {
                    failure(
                        "docx_renderer_unavailable",
                        "无法启动 LibreOffice 转换，请先导出 PDF 再导入。",
                    )
                })?;
            wait(&mut child, cancel, TIMEOUT)?;
            attempt
                .join(
                    source
                        .file_stem()
                        .ok_or_else(|| failure("invalid_document", "DOCX 文件名无效。"))?,
                )
                .with_extension("pdf")
        };
        cancelled(cancel)?;
        validate_pdf(&output)?;
        Ok(output)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn invalid_or_missing_generated_pdf_is_never_accepted() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("simulated.pdf");
            assert!(validate_pdf(&path).is_err());
            std::fs::write(&path, b"%PDF-1.7 simulated corrupt document content").unwrap();
            assert!(validate_pdf(&path).is_err());
        }
        #[test]
        fn cancellation_stops_only_the_owned_launcher() {
            let dir = tempfile::tempdir().unwrap();
            let script = dir.path().join("simulated-wait.ps1");
            std::fs::write(&script, "Start-Sleep -Seconds 30").unwrap();
            let mut child = shell(&script).spawn().unwrap();
            let error =
                wait(&mut child, &AtomicBool::new(true), Duration::from_secs(2)).unwrap_err();
            assert_eq!(error.code, "cancelled");
            assert!(child.try_wait().unwrap().is_some());
        }
        #[test]
        fn timeout_stops_owned_launcher_without_requiring_office() {
            let dir = tempfile::tempdir().unwrap();
            let script = dir.path().join("simulated-wait.ps1");
            std::fs::write(&script, "Start-Sleep -Seconds 30").unwrap();
            let mut child = shell(&script).spawn().unwrap();
            assert_eq!(
                wait(
                    &mut child,
                    &AtomicBool::new(false),
                    Duration::from_millis(80)
                )
                .unwrap_err()
                .code,
                "docx_conversion_timeout"
            );
            assert!(child.try_wait().unwrap().is_some());
        }
        #[test]
        fn office_paths_remove_only_the_windows_verbatim_prefix() {
            assert_eq!(
                office_path(Path::new(r"\\?\C:\Temp\模拟.docx")).unwrap(),
                PathBuf::from(r"C:\Temp\模拟.docx")
            );
            assert_eq!(
                office_path(Path::new(r"\\?\UNC\server\share\模拟.docx")).unwrap(),
                PathBuf::from(r"\\server\share\模拟.docx")
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pre_cancel_does_not_read_files_or_create_attempts() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("attempts");
        let error = convert(
            &dir.path().join("missing.docx"),
            &out,
            &AtomicBool::new(true),
        )
        .unwrap_err();
        assert_eq!(error.code, "cancelled");
        assert!(!out.exists());
    }
    #[test]
    fn invalid_docx_never_launches_office_or_changes_source() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("simulated.docx");
        let out = dir.path().join("attempts");
        let original = b"simulated invalid docx";
        std::fs::write(&source, original).unwrap();
        assert_eq!(
            convert(&source, &out, &AtomicBool::new(false))
                .unwrap_err()
                .code,
            "invalid_document"
        );
        assert_eq!(std::fs::read(source).unwrap(), original);
        assert!(!out.exists());
    }
    #[cfg(not(windows))]
    #[test]
    fn valid_docx_on_unsupported_platform_requires_explicit_pdf_export() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("simulated.docx");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&source).unwrap());
        zip.start_file(
            "word/document.xml",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(b"<document/>").unwrap();
        zip.finish().unwrap();
        let output = dir.path().join("attempts");
        assert_eq!(
            convert(&source, &output, &AtomicBool::new(false))
                .unwrap_err()
                .code,
            "docx_renderer_unavailable"
        );
        assert!(!output.exists());
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "Explicit integration check requiring installed Word or LibreOffice; generated simulated DOCX only"]
    fn installed_office_renders_simulated_docx_read_only() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("simulated ' $ ` 文档.docx");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&source).unwrap());
        for (name, body) in [
            (
                "[Content_Types].xml",
                r#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#,
            ),
            (
                "_rels/.rels",
                r#"<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#,
            ),
            (
                "word/document.xml",
                r#"<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Simulated conversion regression only: 1 + 1 = 2.</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>"#,
            ),
        ] {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        let original = std::fs::read(&source).unwrap();
        let result = convert(
            &source,
            &dir.path().join("attempts"),
            &AtomicBool::new(false),
        );
        let pdf = match result {
            Ok(pdf) => pdf,
            Err(error) => {
                let retained = dir.keep();
                panic!(
                    "{error:?}; simulated conversion evidence retained at {}",
                    retained.display()
                );
            }
        };
        assert_eq!(std::fs::read(&source).unwrap(), original);
        assert!(!lopdf::Document::load(&pdf).unwrap().get_pages().is_empty());
        assert!(pdf.starts_with(dir.path()));
    }
}
