use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Semaphore};

const MAX_CONCURRENT: usize = 3;

/// Wall-clock budget for one automatic compile, including bibliography and
/// extra TeX passes. Large papers with three XeLaTeX passes plus biber often
/// finish in a few minutes; 30 minutes leaves room for first-run Tectonic
/// package fetches and long TeX Live theses.
const LATEX_COMPILE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// Address-space / job-memory ceiling for the compiler process tree.
/// Real theses with TikZ and large images can exceed 1 GiB.
const LATEX_COMPILE_AS_LIMIT: u64 = 8 * 1024 * 1024 * 1024;

/// Per-file output ceiling. A figure-heavy PDF can be hundreds of megabytes.
#[cfg(unix)]
const LATEX_COMPILE_FSIZE_LIMIT: u64 = 1024 * 1024 * 1024;

/// CPU-time ceiling that matches the wall-clock compile deadline.
const LATEX_COMPILE_CPU_LIMIT_SECS: u64 = 30 * 60;

/// Maximum processes inside the Windows compile job. Unix skips RLIMIT_NPROC
/// because that limit is user-wide and would break a busy desktop session.
#[cfg(target_os = "windows")]
const LATEX_COMPILE_ACTIVE_PROCESS_LIMIT: u32 = 128;

/// Windows CREATE_NO_WINDOW flag to prevent console windows from flashing
/// when spawning TeXLive/Tectonic child processes from the GUI app.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

struct BuildInfo {
    work_dir: PathBuf,
    main_file_name: String,
}

#[derive(Clone)]
pub struct LatexCompilerState {
    last_builds: Arc<Mutex<HashMap<String, BuildInfo>>>,
    /// Per-project locks to prevent concurrent compilations on the same build directory.
    project_locks: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    semaphore: Arc<Semaphore>,
}

impl Default for LatexCompilerState {
    fn default() -> Self {
        Self {
            last_builds: Arc::new(Mutex::new(HashMap::new())),
            project_locks: Arc::new(Mutex::new(HashMap::new())),
            semaphore: Arc::new(Semaphore::new(MAX_CONCURRENT)),
        }
    }
}

#[derive(serde::Serialize)]
pub struct SynctexResult {
    pub file: String,
    pub line: u32,
    pub column: u32,
}

// --- Helpers ---

fn extract_error_lines(log: &str) -> String {
    if log.is_empty() {
        return String::new();
    }

    let lines: Vec<&str> = log.lines().collect();

    let mut blocks: Vec<String> = Vec::new();
    let mut i = 0;
    while i < lines.len() && blocks.len() < 5 {
        let line = lines[i];
        let is_error_start =
            line.starts_with('!') || line.contains("Error:") || line.contains("error:");

        if is_error_start {
            let end = (i + 14).min(lines.len());
            blocks.push(lines[i..end].join("\n"));
            i = end;
            continue;
        }

        i += 1;
    }

    if !blocks.is_empty() {
        let mut result = blocks.join("\n\n");
        result.push_str("\n\n---- Engine output ----\n");
        let tail_start = lines.len().saturating_sub(20);
        result.push_str(&lines[tail_start..].join("\n"));
        return result;
    }

    if lines.iter().any(|l| l.contains("No pages of output")) {
        return "No pages of output. Add visible content to the document body.".to_string();
    }

    // Fallback: return tail of log
    let start = log.len().saturating_sub(500);
    log[start..].to_string()
}

/// Check if the log contains real TeX errors (! lines or Error: messages).
fn has_real_errors(log: &str) -> bool {
    log.lines()
        .any(|l| l.starts_with('!') || l.contains("Error:"))
}

#[derive(Debug, PartialEq)]
enum TexEngine {
    Latex,
    XeLaTeX,
    LuaLaTeX,
}

const HIT_THESIS_NATBIB_OPTIONS: &str = "\\PassOptionsToPackage{sort&compress,numbers}{natbib}";

fn uses_hit_thesis_class(content: &str) -> bool {
    content.lines().any(|line| {
        let trimmed = line.trim();
        if trimmed.starts_with('%') {
            return false;
        }
        let Some(rest) = trimmed.strip_prefix("\\documentclass") else {
            return false;
        };
        rest.contains("{hitszthesis}")
            || rest.contains("{hithesis}")
            || rest.contains("{hithesisbook}")
    })
}

fn already_passes_natbib_options(content: &str) -> bool {
    content.contains("\\PassOptionsToPackage") && content.contains("{natbib}")
}

/// hithesis/hitszthesis load natbib with `sort&compress` after gbt7714 (or another
/// package) has already loaded it, which raises "Option clash for package natbib"
/// at the following `\RequirePackage{subeqnarray}`.
fn ensure_hit_thesis_natbib_options(content: &str) -> String {
    if !uses_hit_thesis_class(content) || already_passes_natbib_options(content) {
        return content.to_string();
    }
    let Some(idx) = content.find("\\documentclass") else {
        return content.to_string();
    };
    let mut patched = String::with_capacity(content.len() + HIT_THESIS_NATBIB_OPTIONS.len() + 2);
    patched.push_str(&content[..idx]);
    patched.push_str(HIT_THESIS_NATBIB_OPTIONS);
    patched.push('\n');
    patched.push_str(&content[idx..]);
    patched
}

/// Detect TeX engine from `% !TEX program = <engine>` magic comment in the first 20 lines.
fn detect_tex_engine(content: &str) -> Option<TexEngine> {
    for line in content.lines().take(20) {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix('%') {
            let rest = rest.trim();
            if let Some(rest) = rest.strip_prefix("!TEX") {
                let rest = rest.trim();
                if let Some(rest) = rest.strip_prefix("program") {
                    let rest = rest.trim();
                    if let Some(rest) = rest.strip_prefix('=') {
                        let engine = rest.trim().to_lowercase();
                        return match engine.as_str() {
                            "xelatex" => Some(TexEngine::XeLaTeX),
                            "lualatex" => Some(TexEngine::LuaLaTeX),
                            "pdflatex" | "latex" => Some(TexEngine::Latex),
                            _ => None,
                        };
                    }
                }
            }
        }
    }
    None
}

#[derive(Debug, PartialEq)]
enum BibTool {
    Biber,
    BibTeX,
    None,
}

/// Detect which bibliography tool is needed by scanning .tex content.
fn detect_bib_tool(content: &str) -> BibTool {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('%') {
            continue;
        }
        if trimmed.contains("\\usepackage") && trimmed.contains("biblatex") {
            return BibTool::Biber;
        }
    }
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('%') {
            continue;
        }
        if trimmed.contains("\\bibliography{") || trimmed.contains("\\addbibresource{") {
            return BibTool::BibTeX;
        }
    }
    BibTool::None
}

fn tex_binary_filename(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn extra_tex_bin_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    #[cfg(target_os = "windows")]
    {
        let years = ["2026", "2025", "2024", "2023"];
        let drives = ["C:", "D:", "E:"];
        for drive in drives {
            if let Ok(entries) = std::fs::read_dir(format!(r"{drive}\texlive")) {
                for entry in entries.flatten() {
                    dirs.push(entry.path().join("bin").join("windows"));
                    dirs.push(entry.path().join("bin").join("win32"));
                }
            }
            for year in years {
                dirs.push(PathBuf::from(format!(
                    r"{drive}\texlive\{year}\bin\windows"
                )));
                dirs.push(PathBuf::from(format!(r"{drive}\texlive\{year}\bin\win32")));
            }
        }

        if let Ok(program_files) = std::env::var("ProgramFiles") {
            dirs.push(PathBuf::from(format!(
                r"{program_files}\MiKTeX\miktex\bin\x64"
            )));
            dirs.push(PathBuf::from(format!(r"{program_files}\MiKTeX\miktex\bin")));
            for year in years {
                dirs.push(PathBuf::from(format!(
                    r"{program_files}\texlive\{year}\bin\windows"
                )));
            }
        }
        if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
            dirs.push(PathBuf::from(format!(
                r"{program_files_x86}\MiKTeX\miktex\bin"
            )));
        }
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            dirs.push(PathBuf::from(format!(
                r"{local_app_data}\Programs\MiKTeX\miktex\bin\x64"
            )));
            dirs.push(PathBuf::from(format!(
                r"{local_app_data}\TinyTeX\bin\windows"
            )));
            dirs.push(PathBuf::from(format!(
                r"{local_app_data}\TinyTeX\bin\win32"
            )));
        }
        if let Ok(app_data) = std::env::var("APPDATA") {
            dirs.push(PathBuf::from(format!(r"{app_data}\MiKTeX\miktex\bin\x64")));
            dirs.push(PathBuf::from(format!(r"{app_data}\TinyTeX\bin\windows")));
            dirs.push(PathBuf::from(format!(r"{app_data}\TinyTeX\bin\win32")));
        }
        dirs.push(PathBuf::from(r"C:\CTEX\MiKTeX\miktex\bin"));
        dirs.push(PathBuf::from(r"C:\Program Files\CTeX\MiKTeX\miktex\bin"));
    }

    dirs
}

fn resolve_latex_backend(want_texlive: bool, engine_found: bool) -> bool {
    want_texlive && engine_found
}

/// Resolve a TeXLive / MiKTeX / TinyTeX engine binary to its full path.
/// GUI apps often lack the user's shell PATH, so we check common install
/// locations after `PATH` / `where`.
fn find_texlive_binary(name: &str) -> Result<PathBuf, String> {
    // 1. Try PATH (works when launched from terminal)
    if let Ok(path) = which::which(name) {
        return Ok(path);
    }

    let filename = tex_binary_filename(name);

    // 2. Check standard TeXLive / MiKTeX / TinyTeX locations
    #[cfg(not(target_os = "windows"))]
    {
        let standard_paths = [
            format!("/Library/TeX/texbin/{}", name),
            format!("/usr/local/texlive/2026/bin/universal-darwin/{}", name),
            format!("/usr/local/texlive/2025/bin/universal-darwin/{}", name),
            format!("/usr/local/texlive/2024/bin/universal-darwin/{}", name),
            format!("/usr/local/texlive/2026/bin/x86_64-linux/{}", name),
            format!("/usr/local/texlive/2025/bin/x86_64-linux/{}", name),
            format!("/usr/local/texlive/2024/bin/x86_64-linux/{}", name),
            format!("/opt/homebrew/bin/{}", name),
            format!("/usr/bin/{}", name),
        ];
        for path_str in &standard_paths {
            let p = PathBuf::from(path_str);
            if p.exists() {
                return Ok(p);
            }
        }
    }

    for dir in extra_tex_bin_dirs() {
        let candidate = dir.join(&filename);
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("where");
        cmd.arg(name)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW);
        if let Ok(output) = cmd.output() {
            if output.status.success() {
                if let Some(line) = String::from_utf8_lossy(&output.stdout).lines().next() {
                    let resolved = PathBuf::from(line.trim());
                    if resolved.exists() {
                        return Ok(resolved);
                    }
                }
            }
        }
    }

    // 3. macOS: ask login shell for PATH
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("/bin/zsh")
            .args(["-l", "-c", &format!("which {}", name)])
            .output()
        {
            if output.status.success() {
                let resolved = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let p = PathBuf::from(&resolved);
                if p.exists() {
                    return Ok(p);
                }
            }
        }
    }

    Err(format!(
        "{} not found. Install TeXLive or add it to your PATH.",
        name
    ))
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    ensure_real_directory(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            // Skip hidden directories (.git, .claudeprism, etc.)
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            copy_replacing_dest_symlink(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

/// Sync only source files (.tex, .bib, .sty, .cls, .bst, images, .pdf figures) from project to build dir.
/// Skips build artifacts (.aux, .log, .toc, .synctex.gz, etc.) to preserve them.
/// Note: .pdf is NOT skipped — figure PDFs must be synced. The output PDF is managed by compile_latex.
fn sync_source_files(src: &Path, dst: &Path) -> std::io::Result<()> {
    ensure_real_directory(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let file_name = entry.file_name();
        let dst_path = dst.join(&file_name);
        if src_path.is_dir() {
            let name = file_name.to_string_lossy();
            if name.starts_with('.') || matches!(name.as_ref(), "node_modules" | "target" | "dist")
            {
                continue;
            }
            sync_source_files(&src_path, &dst_path)?;
        } else {
            let ext = src_path.extension().and_then(|e| e.to_str()).unwrap_or("");
            let is_artifact = matches!(
                ext,
                "aux"
                    | "log"
                    | "toc"
                    | "lof"
                    | "lot"
                    | "out"
                    | "nav"
                    | "snm"
                    | "vrb"
                    | "bbl"
                    | "blg"
                    | "fls"
                    | "fdb_latexmk"
                    | "synctex"
                    | "idx"
                    | "ind"
                    | "ilg"
                    | "glo"
                    | "gls"
                    | "glg"
                    | "fmt"
                    | "xdv"
            );
            let is_synctex = src_path.to_string_lossy().ends_with(".synctex.gz");
            if !is_artifact && !is_synctex {
                // Cloud storage (Dropbox/iCloud) may keep files as online-only
                // placeholders with 0 bytes. Reading the file forces a download.
                let metadata = std::fs::metadata(&src_path)?;

                if metadata.len() > 0 {
                    if let Ok(dst_meta) = std::fs::metadata(&dst_path) {
                        if metadata.len() == dst_meta.len() {
                            if let (Ok(src_m), Ok(dst_m)) =
                                (metadata.modified(), dst_meta.modified())
                            {
                                if src_m == dst_m {
                                    continue;
                                }
                            }
                        }
                    }
                }

                if metadata.len() == 0 {
                    // Attempt to materialize the file by reading it
                    let data = std::fs::read(&src_path)?;
                    if !data.is_empty() {
                        write_replacing_dest_symlink(&dst_path, &data)?;
                    } else {
                        copy_replacing_dest_symlink(&src_path, &dst_path)?;
                    }
                } else {
                    copy_replacing_dest_symlink(&src_path, &dst_path)?;
                }
            }
        }
    }
    Ok(())
}

/// Persistent build directory inside the project.
/// Stored in `<project>/.prism/build/` — hidden from file tree (dot-prefix is filtered).
fn persistent_build_dir(project_dir: &str) -> PathBuf {
    PathBuf::from(project_dir).join(".prism").join("build")
}

fn is_symlink(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink())
}

fn is_real_dir(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
}

/// Unlink a symlink or junction without following it. Never uses `remove_dir_all`.
fn unlink_symlink(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) => match std::fs::remove_dir(path) {
            Ok(()) => Ok(()),
            Err(_) => Err(error),
        },
    }
}

fn ensure_real_directory(path: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            unlink_symlink(path)?;
            std::fs::create_dir(path)
        }
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!("{} exists and is not a directory", path.display()),
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match std::fs::create_dir(path) {
                Ok(()) => Ok(()),
                Err(create_error) if create_error.kind() == std::io::ErrorKind::NotFound => {
                    std::fs::create_dir_all(path)
                }
                Err(create_error) => Err(create_error),
            }
        }
        Err(error) => Err(error),
    }
}

fn copy_replacing_dest_symlink(src: &Path, dst: &Path) -> std::io::Result<u64> {
    if is_symlink(dst) {
        unlink_symlink(dst)?;
    }
    std::fs::copy(src, dst)
}

fn write_replacing_dest_symlink(dst: &Path, data: &[u8]) -> std::io::Result<()> {
    if is_symlink(dst) {
        unlink_symlink(dst)?;
    }
    std::fs::write(dst, data)
}

fn resolved_is_inside(path: &Path, project_canon: &Path) -> bool {
    let Ok(resolved) = path.canonicalize() else {
        return false;
    };
    if resolved.starts_with(project_canon) {
        return true;
    }
    // Windows canonicalize may change drive-letter case; treat that as inside.
    #[cfg(windows)]
    {
        let resolved_key = resolved.to_string_lossy().to_ascii_lowercase();
        let project_key = project_canon.to_string_lossy().to_ascii_lowercase();
        resolved_key == project_key
            || resolved_key.starts_with(&format!("{project_key}\\"))
            || resolved_key.starts_with(&format!("{project_key}/"))
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Make `path` a real directory that resolves inside `project_canon`.
///
/// A project-controlled symlink or junction at `.prism` or `.prism/build` is
/// replaced instead of followed, so compile output cannot land outside the
/// project.
fn confine_dir_to_project(path: &Path, project_canon: &Path) -> Result<(), String> {
    if is_symlink(path) {
        unlink_symlink(path).map_err(|error| {
            format!(
                "Failed to replace escaping build link {}: {error}",
                path.display()
            )
        })?;
    }
    if path
        .parent()
        .is_some_and(|parent| !resolved_is_inside(parent, project_canon))
    {
        return Err("Refusing to create a build directory through a symlink".to_string());
    }
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => {
            return Err(format!("{} exists and is not a directory", path.display()));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(path).map_err(|error| {
                format!(
                    "Failed to create build directory {}: {error}",
                    path.display()
                )
            })?;
        }
        Err(error) => {
            return Err(format!("Failed to inspect {}: {error}", path.display()));
        }
    }
    if !is_real_dir(path) || !resolved_is_inside(path, project_canon) {
        return Err(
            "Refusing to use a build directory that resolves outside the project".to_string(),
        );
    }
    Ok(())
}

/// Resolve `<project>/.prism/build` to a real in-project directory.
///
/// If `.prism` or `.prism/build` is a symlink/junction, the link is replaced
/// with a real directory so later copy/remove/compile never follow it.
fn prepare_persistent_build_dir(project_dir: &str) -> Result<PathBuf, String> {
    let project = Path::new(project_dir);
    let project_canon = project
        .canonicalize()
        .map_err(|error| format!("Failed to resolve project directory: {error}"))?;
    if !project_canon.is_dir() {
        return Err("Project path is not a directory".to_string());
    }

    let prism = project.join(".prism");
    confine_dir_to_project(&prism, &project_canon)?;
    let build = prism.join("build");
    confine_dir_to_project(&build, &project_canon)?;

    let build_canon = build
        .canonicalize()
        .map_err(|error| format!("Failed to resolve build directory: {error}"))?;
    if !build_canon.starts_with(&project_canon) {
        return Err(
            "Refusing to use a build directory that resolves outside the project".to_string(),
        );
    }
    Ok(build)
}

/// Remove a stale compile PDF only when its parent is a real directory.
/// A dest symlink is unlinked (the target is left untouched). Locked or
/// missing files are ignored so a viewer-held PDF cannot abort compile.
fn remove_stale_build_output(path: &Path) {
    let Some(parent) = path.parent() else {
        return;
    };
    if !is_real_dir(parent) {
        return;
    }
    let _ = std::fs::remove_file(path);
}

/// Prepare the in-project build tree, copy or sync sources into it, and drop
/// a stale output PDF. All three steps stay inside the project even when
/// `.prism/build` started as a symlink to somewhere else.
fn prepare_compile_tree(
    project_dir: &str,
    main_file_name: &str,
) -> Result<(PathBuf, bool), String> {
    let lexical = persistent_build_dir(project_dir);
    let is_reuse = is_real_dir(&lexical);
    let work_dir = prepare_persistent_build_dir(project_dir)?;
    if is_reuse {
        sync_source_files(Path::new(project_dir), &work_dir)
            .map_err(|error| format!("Failed to sync project: {error}"))?;
    } else {
        copy_dir_recursive(Path::new(project_dir), &work_dir)
            .map_err(|error| format!("Failed to copy project: {error}"))?;
    }
    let pdf_path = work_dir.join(format!("{main_file_name}.pdf"));
    remove_stale_build_output(&pdf_path);
    Ok((work_dir, is_reuse))
}

fn remaining_compile_budget(deadline: Instant) -> Result<Duration, String> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        Err(compile_timeout_message())
    } else {
        Ok(remaining)
    }
}

fn compile_timeout_message() -> String {
    format!(
        "Compilation timed out after {} seconds",
        LATEX_COMPILE_TIMEOUT.as_secs()
    )
}

fn isolate_compile_command(cmd: &mut std::process::Command) {
    #[cfg(unix)]
    {
        cmd.process_group(0);
        // SAFETY: runs in the child after fork and before exec. setrlimit only
        // mutates the new process; a failure is ignored so an unsupported limit
        // cannot prevent a legitimate compile.
        unsafe {
            cmd.pre_exec(|| {
                apply_unix_compile_rlimits();
                Ok(())
            });
        }
    }

    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::System::Threading::CREATE_SUSPENDED;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    }

    #[cfg(not(any(unix, target_os = "windows")))]
    let _ = cmd;
}

#[cfg(unix)]
fn apply_unix_compile_rlimits() {
    let set_limit = |resource, limit: u64| {
        let bounded = libc::rlim_t::try_from(limit).unwrap_or(libc::rlim_t::MAX);
        let rlim = libc::rlimit {
            rlim_cur: bounded,
            rlim_max: bounded,
        };
        // SAFETY: `rlim` is a valid rlimit and lives for the duration of the call.
        let _ = unsafe { libc::setrlimit(resource, &rlim) };
    };
    set_limit(libc::RLIMIT_CPU, LATEX_COMPILE_CPU_LIMIT_SECS);
    set_limit(libc::RLIMIT_FSIZE, LATEX_COMPILE_FSIZE_LIMIT);
    set_limit(libc::RLIMIT_AS, LATEX_COMPILE_AS_LIMIT);
}

struct CompileProcessTree {
    #[cfg(target_os = "windows")]
    job: WindowsCompileJob,
    #[cfg(unix)]
    process_group: Option<std::num::NonZeroI32>,
}

impl CompileProcessTree {
    fn terminate(&mut self) -> Result<(), String> {
        #[cfg(target_os = "windows")]
        {
            self.job.terminate()
        }

        #[cfg(unix)]
        {
            let Some(process_group) = self.process_group.take() else {
                return Ok(());
            };
            terminate_unix_compile_group(process_group)
        }

        #[cfg(not(any(unix, target_os = "windows")))]
        {
            Ok(())
        }
    }
}

#[cfg(unix)]
impl Drop for CompileProcessTree {
    fn drop(&mut self) {
        let _ = self.terminate();
    }
}

fn attach_compile_process_tree(child: &std::process::Child) -> Result<CompileProcessTree, String> {
    #[cfg(target_os = "windows")]
    {
        let job = WindowsCompileJob::attach(child)?;
        resume_suspended_compile_child(child)?;
        Ok(CompileProcessTree { job })
    }

    #[cfg(unix)]
    {
        let process_id = child.id();
        let process_group = i32::try_from(process_id)
            .ok()
            .and_then(std::num::NonZeroI32::new)
            .ok_or_else(|| "compiler process group id was invalid".to_string())?;
        Ok(CompileProcessTree {
            process_group: Some(process_group),
        })
    }

    #[cfg(not(any(unix, target_os = "windows")))]
    {
        let _ = child;
        Ok(CompileProcessTree {})
    }
}

#[cfg(unix)]
fn terminate_unix_compile_group(process_group: std::num::NonZeroI32) -> Result<(), String> {
    // SAFETY: getpgrp has no preconditions.
    let current_process_group = unsafe { libc::getpgrp() };
    if process_group.get() <= 0 {
        return Err("process group id must be positive".into());
    }
    if process_group.get() == current_process_group {
        return Err("refusing to terminate the desktop application's own process group".into());
    }
    // SAFETY: Negative pid addresses a process group. The stored PGID came from
    // a child created with process_group(0) and is not our own group.
    let result = if unsafe { libc::kill(-process_group.get(), libc::SIGKILL) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    };
    match result {
        Ok(()) => Ok(()),
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => Ok(()),
        Err(error) => Err(format!("process group termination failed: {error}")),
    }
}

#[cfg(target_os = "windows")]
struct WindowsOwnedHandle {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(target_os = "windows")]
// SAFETY: the wrapper uniquely owns the kernel handle.
unsafe impl Send for WindowsOwnedHandle {}

#[cfg(target_os = "windows")]
impl Drop for WindowsOwnedHandle {
    fn drop(&mut self) {
        // SAFETY: Drop runs once for the uniquely owned handle.
        let _ = unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle) };
    }
}

#[cfg(target_os = "windows")]
struct WindowsCompileJob {
    handle: WindowsOwnedHandle,
}

#[cfg(target_os = "windows")]
impl WindowsCompileJob {
    fn attach(child: &std::process::Child) -> Result<Self, String> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_JOB_MEMORY,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
            JOB_OBJECT_LIMIT_PROCESS_TIME,
        };

        // SAFETY: unnamed job with default security; the handle is checked.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(format!(
                "Windows job object creation failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        let job = Self {
            handle: WindowsOwnedHandle { handle },
        };
        let memory_limit = usize::try_from(LATEX_COMPILE_AS_LIMIT).unwrap_or(usize::MAX);
        let process_time = i64::try_from(LATEX_COMPILE_CPU_LIMIT_SECS.saturating_mul(10_000_000))
            .unwrap_or(i64::MAX);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | JOB_OBJECT_LIMIT_PROCESS_MEMORY
            | JOB_OBJECT_LIMIT_JOB_MEMORY
            | JOB_OBJECT_LIMIT_PROCESS_TIME
            | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        limits.BasicLimitInformation.PerProcessUserTimeLimit = process_time;
        limits.BasicLimitInformation.ActiveProcessLimit = LATEX_COMPILE_ACTIVE_PROCESS_LIMIT;
        limits.ProcessMemoryLimit = memory_limit;
        limits.JobMemoryLimit = memory_limit;
        let information_size = u32::try_from(std::mem::size_of_val(&limits))
            .map_err(|_| "Windows job object information was too large".to_string())?;
        // SAFETY: `limits` matches JobObjectExtendedLimitInformation and stays live.
        if unsafe {
            SetInformationJobObject(
                job.handle.handle,
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&limits).cast(),
                information_size,
            )
        } == 0
        {
            return Err(format!(
                "Windows job object configuration failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        let process_handle = child.as_raw_handle();
        // SAFETY: Child owns the process handle for the duration of this call.
        if unsafe { AssignProcessToJobObject(job.handle.handle, process_handle.cast()) } == 0 {
            return Err(format!(
                "Windows job object assignment failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(job)
    }

    fn terminate(&self) -> Result<(), String> {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;

        // SAFETY: `self.handle` is a live owned job handle until Drop.
        if unsafe { TerminateJobObject(self.handle.handle, 1) } == 0 {
            return Err(format!(
                "Windows job object termination failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn resume_suspended_compile_child(child: &std::process::Child) -> Result<(), String> {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

    let process_id = child.id();
    // SAFETY: snapshot has no borrowed inputs; a successful handle is owned below.
    let snapshot_handle = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot_handle == INVALID_HANDLE_VALUE {
        return Err(format!(
            "Windows thread snapshot failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    let snapshot = WindowsOwnedHandle {
        handle: snapshot_handle,
    };
    let mut entry = THREADENTRY32 {
        dwSize: u32::try_from(std::mem::size_of::<THREADENTRY32>())
            .map_err(|_| "Windows thread entry was too large".to_string())?,
        ..THREADENTRY32::default()
    };
    // SAFETY: `entry` has the required size for these synchronous calls.
    if unsafe { Thread32First(snapshot.handle, &mut entry) } == 0 {
        return Err(format!(
            "Windows thread enumeration failed: {}",
            std::io::Error::last_os_error()
        ));
    }

    let mut resumed = false;
    loop {
        if entry.th32OwnerProcessID == process_id {
            // SAFETY: the enumerated thread belongs to the newly created child.
            let thread_handle = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if thread_handle.is_null() {
                return Err(format!(
                    "Windows child thread open failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let thread = WindowsOwnedHandle {
                handle: thread_handle,
            };
            // SAFETY: `thread` has THREAD_SUSPEND_RESUME access.
            if unsafe { ResumeThread(thread.handle) } == u32::MAX {
                return Err(format!(
                    "Windows child thread resume failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
            resumed = true;
        }
        // SAFETY: snapshot and entry remain valid for the enumeration.
        if unsafe { Thread32Next(snapshot.handle, &mut entry) } == 0 {
            break;
        }
    }

    if resumed {
        Ok(())
    } else {
        Err("Windows child primary thread was unavailable for resume".into())
    }
}

fn terminate_compile_child(
    child: &mut std::process::Child,
    process_tree: Option<&mut CompileProcessTree>,
) {
    if let Some(tree) = process_tree {
        let _ = tree.terminate();
    } else {
        #[cfg(unix)]
        {
            if let Some(process_group) = i32::try_from(child.id())
                .ok()
                .and_then(std::num::NonZeroI32::new)
            {
                let _ = terminate_unix_compile_group(process_group);
            }
        }
    }
    let _ = child.kill();
}

fn join_pipe_thread(handle: Option<std::thread::JoinHandle<Vec<u8>>>) -> Vec<u8> {
    handle
        .and_then(|joined| joined.join().ok())
        .unwrap_or_default()
}

/// Spawn a compiler (or helper) with a deadline, process-group / job isolation,
/// and resource quotas. On timeout the whole descendant tree is killed.
fn run_limited_command(
    mut cmd: std::process::Command,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    isolate_compile_command(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|error| format!("Failed to spawn compiler process: {error}"))?;
    let mut process_tree = match attach_compile_process_tree(&child) {
        Ok(tree) => Some(tree),
        Err(error) => {
            eprintln!("[latex] process isolation unavailable: {error}");
            // Isolation is best-effort. A suspended Windows child must still be
            // resumed so a real paper can compile without a job object.
            #[cfg(target_os = "windows")]
            {
                if let Err(resume_error) = resume_suspended_compile_child(&child) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(resume_error);
                }
            }
            None
        }
    };

    let stdout = child.stdout.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = std::io::Read::read_to_end(&mut pipe, &mut bytes);
            bytes
        })
    });
    let stderr = child.stderr.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = std::io::Read::read_to_end(&mut pipe, &mut bytes);
            bytes
        })
    });

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started.elapsed() >= timeout {
                    terminate_compile_child(&mut child, process_tree.as_mut());
                    let _ = child.wait();
                    let _ = join_pipe_thread(stdout);
                    let _ = join_pipe_thread(stderr);
                    return Err(compile_timeout_message());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(error) => {
                terminate_compile_child(&mut child, process_tree.as_mut());
                return Err(format!("Failed to wait for compiler process: {error}"));
            }
        }
    };

    Ok(std::process::Output {
        status,
        stdout: join_pipe_thread(stdout),
        stderr: join_pipe_thread(stderr),
    })
}

// --- Thread priority ---

/// Lower the current thread's scheduling priority so CPU-heavy compilation
/// does not starve the WebView's main thread (and thus the UI / typing).
fn lower_thread_priority() {
    #[cfg(target_os = "macos")]
    {
        // QOS_CLASS_UTILITY (0x11) — lower than default, appropriate for long-running work.
        extern "C" {
            fn pthread_set_qos_class_self_np(qos_class: u32, relative_priority: i32) -> i32;
        }
        unsafe { pthread_set_qos_class_self_np(0x11, 0) };
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        extern "C" {
            fn nice(inc: i32) -> i32;
        }
        unsafe { nice(10) };
    }
}

// --- Tectonic Compilation ---

pub(crate) fn compile_with_tectonic(work_dir: &Path, main_file: &str) -> Result<(), String> {
    use tectonic::config::PersistentConfig;
    use tectonic::driver::{OutputFormat, PassSetting, ProcessingSessionBuilder};
    use tectonic::status::NoopStatusBackend;

    let mut status = NoopStatusBackend {};

    let config = PersistentConfig::open(false)
        .map_err(|e| format!("Failed to open tectonic config: {}", e))?;

    let bundle = config.default_bundle(false, &mut status).map_err(|e| {
        format!(
            "Failed to load tectonic bundle (check network connection): {}",
            e
        )
    })?;

    let format_cache = config
        .format_cache_path()
        .map_err(|e| format!("Failed to get format cache path: {}", e))?;

    let mut builder = ProcessingSessionBuilder::default();
    builder
        .bundle(bundle)
        .primary_input_path(work_dir.join(main_file))
        .tex_input_name(main_file)
        .filesystem_root(work_dir)
        .output_dir(work_dir)
        .format_name("latex")
        .format_cache_path(format_cache)
        .output_format(OutputFormat::Pdf)
        .pass(PassSetting::Default)
        .synctex(true)
        .keep_intermediates(true)
        .keep_logs(true);

    let mut session = builder
        .create(&mut status)
        .map_err(|e| format!("Failed to create tectonic session: {}", e))?;

    session.run(&mut status).map_err(|e| format!("{}", e))?;

    Ok(())
}

/// Run tectonic compilation in an isolated subprocess.
///
/// This avoids the font cache assertion failure (`font_cache.fonts == NULL`)
/// that occurs when tectonic is called multiple times in the same process.
/// The C-level static `font_cache` in `dpx-pdffont.c` is not cleaned up
/// on compilation failure, causing subsequent calls to abort.
///
/// By spawning a subprocess, each compilation gets a fresh process with
/// clean global state, and cleanup happens automatically on process exit.
fn compile_with_tectonic_subprocess(
    work_dir: &Path,
    main_file: &str,
    deadline: Instant,
) -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("Failed to get current executable path: {}", e))?;

    let mut cmd = std::process::Command::new(&exe);
    cmd.args(["--tectonic-compile", &work_dir.to_string_lossy(), main_file])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let output = run_limited_command(cmd, remaining_compile_budget(deadline)?)?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(stderr.trim().to_string())
    }
}

// --- TeXLive Compilation ---

/// Build a PATH that includes the TeXLive bin directory so that xelatex
/// can find xdvipdfmx, kpsewhich, and other tools it invokes internally.
/// GUI apps on macOS have a minimal PATH that doesn't include TeXLive.
fn texlive_env_path(engine: &Path) -> String {
    let texbin = engine
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let current_path = std::env::var("PATH").unwrap_or_default();
    if current_path.contains(&texbin) {
        current_path
    } else {
        #[cfg(target_os = "windows")]
        {
            format!("{};{}", texbin, current_path)
        }
        #[cfg(not(target_os = "windows"))]
        {
            format!("{}:{}", texbin, current_path)
        }
    }
}

/// Run a single TeX engine pass.  Never returns `Err` for a non-zero exit
/// code — TeXLive returns non-zero for warnings, font substitutions, etc.
/// The only `Err` is when the process cannot be *spawned* at all.
/// The caller decides success by checking whether the PDF was produced.
fn run_texlive_pass(
    engine: &Path,
    args: &[&str],
    main_file: &Path,
    work_dir: &Path,
    deadline: Instant,
) -> Result<(), String> {
    let mut cmd = std::process::Command::new(engine);
    cmd.args(args)
        .arg(main_file)
        .current_dir(work_dir)
        .env("PATH", texlive_env_path(engine))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let output = run_limited_command(cmd, remaining_compile_budget(deadline)?)
        .map_err(|e| format!("Failed to launch {}: {}", engine.display(), e))?;

    // TeXLive returns non-zero on warnings too — don't fail here.
    // The caller decides success by checking whether the PDF was produced.
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.trim().is_empty() {
            eprintln!("[texlive] engine stderr: {}", stderr.trim());
        }
    }
    Ok(())
}

fn compile_with_texlive(
    work_dir: &Path,
    main_file: &str,
    engine: Option<TexEngine>,
    tex_content: &str,
    deadline: Instant,
) -> Result<(), String> {
    let engine_name = match engine {
        Some(TexEngine::XeLaTeX) | None => "xelatex",
        Some(TexEngine::Latex) => "pdflatex",
        Some(TexEngine::LuaLaTeX) => "lualatex",
    };

    let engine_path = find_texlive_binary(engine_name)?;
    let env_path = texlive_env_path(&engine_path);
    eprintln!(
        "[texlive] backend: {} ({})",
        engine_name,
        engine_path.display()
    );
    let bib_tool = detect_bib_tool(tex_content);

    // Use "." as output-directory since current_dir is already work_dir.
    // Absolute paths break when they contain ~ (e.g. iCloud's com~apple~CloudDocs)
    // because TeX interprets ~ as a home directory shortcut.
    let output_dir_arg = "-output-directory=.".to_string();
    // Do NOT use -halt-on-error: xelatex is a pipeline (xetex → .xdv → xdvipdfmx → .pdf).
    // With -halt-on-error, recoverable warnings (e.g. missing font shapes) cause xetex to
    // exit non-zero, and the xelatex wrapper skips the xdvipdfmx step — producing .xdv but
    // no .pdf.  -interaction=nonstopmode alone is sufficient to avoid interactive prompts.
    let common_args: Vec<&str> = vec!["-synctex=1", "-interaction=nonstopmode", &output_dir_arg];

    let main_file_path = Path::new(main_file);

    // Pass 1
    run_texlive_pass(
        &engine_path,
        &common_args,
        main_file_path,
        work_dir,
        deadline,
    )?;

    // Bib pass (if needed)
    let main_stem = Path::new(main_file)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document");

    match bib_tool {
        BibTool::Biber => {
            let biber_path = find_texlive_binary("biber")?;
            let mut cmd = std::process::Command::new(&biber_path);
            cmd.arg(main_stem)
                .current_dir(work_dir)
                .env("PATH", &env_path)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            let output = run_limited_command(cmd, remaining_compile_budget(deadline)?)
                .map_err(|e| format!("Failed to run biber: {}", e))?;
            if !output.status.success() {
                eprintln!(
                    "[texlive] biber warning: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
        }
        BibTool::BibTeX => {
            let bibtex_path = find_texlive_binary("bibtex")?;
            let aux_file = work_dir.join(format!("{}.aux", main_stem));
            let mut cmd = std::process::Command::new(&bibtex_path);
            cmd.arg(&aux_file)
                .current_dir(work_dir)
                .env("PATH", &env_path)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            let output = run_limited_command(cmd, remaining_compile_budget(deadline)?)
                .map_err(|e| format!("Failed to run bibtex: {}", e))?;
            if !output.status.success() {
                eprintln!(
                    "[texlive] bibtex warning: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
        }
        BibTool::None => {}
    }

    // Pass 2: resolve references / TOC
    run_texlive_pass(
        &engine_path,
        &common_args,
        &main_file_path,
        work_dir,
        deadline,
    )?;

    // Pass 3: stabilize citations (only if bib was used)
    if !matches!(bib_tool, BibTool::None) {
        run_texlive_pass(
            &engine_path,
            &common_args,
            &main_file_path,
            work_dir,
            deadline,
        )?;
    }

    let pdf_path = work_dir.join(format!("{}.pdf", main_stem));
    let xdv_path = work_dir.join(format!("{}.xdv", main_stem));

    // Fallback: if xelatex produced .xdv but no .pdf (e.g. xdvipdfmx was skipped due to
    // warnings), manually run xdvipdfmx to convert .xdv → .pdf.
    if !pdf_path.exists() && xdv_path.exists() {
        eprintln!("[texlive] .xdv exists but no .pdf — running xdvipdfmx manually");
        if let Ok(xdvipdfmx) = find_texlive_binary("xdvipdfmx") {
            let mut cmd = std::process::Command::new(&xdvipdfmx);
            cmd.args(["-o", &pdf_path.to_string_lossy()])
                .arg(&xdv_path)
                .current_dir(work_dir)
                .env("PATH", &env_path)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            let output = run_limited_command(cmd, remaining_compile_budget(deadline)?)
                .map_err(|e| format!("Failed to launch xdvipdfmx: {}", e))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                if !stderr.trim().is_empty() {
                    eprintln!("[texlive] xdvipdfmx stderr: {}", stderr.trim());
                }
            }
        }
    }

    // Success is determined by whether the PDF exists, not by exit codes.
    // The caller (compile_latex) checks pdf_path.exists() and reads the log for errors.
    Ok(())
}

// --- SyncTeX Native Parser ---

struct SynctexNode {
    tag: u32,
    line: u32,
    h: f64, // PDF points
    v: f64, // PDF points
}

/// Parse synctex data and find the source location closest to (target_x, target_y) on target_page.
fn parse_synctex_data(
    data: &str,
    target_page: u32,
    target_x: f64,
    target_y: f64,
) -> Option<(String, u32, u32)> {
    let mut inputs: HashMap<u32, String> = HashMap::new();
    let mut magnification: f64 = 1000.0;
    let mut unit: f64 = 1.0;
    let mut x_offset: f64 = 0.0;
    let mut y_offset: f64 = 0.0;

    let mut in_content = false;
    let mut on_target_page = false;
    let mut nodes: Vec<SynctexNode> = Vec::new();

    for raw_line in data.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        if !in_content {
            if let Some(rest) = line.strip_prefix("Input:") {
                if let Some(colon_pos) = rest.find(':') {
                    if let Ok(tag) = rest[..colon_pos].parse::<u32>() {
                        inputs.insert(tag, rest[colon_pos + 1..].to_string());
                    }
                }
            } else if let Some(rest) = line.strip_prefix("Magnification:") {
                magnification = rest.trim().parse().unwrap_or(1000.0);
            } else if let Some(rest) = line.strip_prefix("Unit:") {
                unit = rest.trim().parse().unwrap_or(1.0);
            } else if let Some(rest) = line.strip_prefix("X Offset:") {
                x_offset = rest.trim().parse().unwrap_or(0.0);
            } else if let Some(rest) = line.strip_prefix("Y Offset:") {
                y_offset = rest.trim().parse().unwrap_or(0.0);
            } else if line == "Content:" {
                in_content = true;
            }
            continue;
        }

        // Content section
        if line.starts_with("Postamble:") {
            break;
        }

        let first_byte = match line.as_bytes().first() {
            Some(b) => *b,
            None => continue,
        };
        match first_byte {
            b'{' => {
                let page: u32 = line.get(1..).and_then(|s| s.parse().ok()).unwrap_or(0);
                on_target_page = page == target_page;
            }
            b'}' => {
                on_target_page = false;
            }
            // Box/node records: [, (, h, v, k, x, g, $
            b'[' | b'(' | b'h' | b'v' | b'k' | b'x' | b'g' | b'$' if on_target_page => {
                // Convert synctex internal units to PDF points (bp)
                // 1 TeX pt = 65536 sp; 1 inch = 72.27 TeX pt = 72 PDF bp
                let factor = unit * magnification / (1000.0 * 65536.0) * 72.0 / 72.27;
                if let Some(node) = line
                    .get(1..)
                    .and_then(|s| parse_synctex_node(s, factor, x_offset, y_offset))
                {
                    nodes.push(node);
                }
            }
            _ => {}
        }
    }

    if nodes.is_empty() {
        return None;
    }

    // Find closest node to (target_x, target_y)
    let mut best_idx = 0;
    let mut best_dist = f64::MAX;
    for (i, node) in nodes.iter().enumerate() {
        let dx = node.h - target_x;
        let dy = node.v - target_y;
        let dist = dx * dx + dy * dy;
        if dist < best_dist {
            best_dist = dist;
            best_idx = i;
        }
    }

    let best = nodes.get(best_idx)?;
    let filename = inputs.get(&best.tag)?.clone();
    Some((filename, best.line, 0))
}

/// Parse a synctex node record (after stripping the type character).
/// Format: `<tag>,<line>,<column>:<h>,<v>[:<W>,<H>,<D>]`
fn parse_synctex_node(s: &str, factor: f64, x_offset: f64, y_offset: f64) -> Option<SynctexNode> {
    let colon_parts: Vec<&str> = s.splitn(4, ':').collect();
    if colon_parts.len() < 2 {
        return None;
    }

    // Parse tag and line (ignore column)
    let first_part = colon_parts.first()?;
    let tlc: Vec<&str> = first_part.splitn(3, ',').collect();
    if tlc.len() < 2 {
        return None;
    }
    let tag: u32 = tlc.first()?.parse().ok()?;
    let line: u32 = tlc.get(1)?.parse().ok()?;

    // Parse h, v coordinates
    let second_part = colon_parts.get(1)?;
    let hv: Vec<&str> = second_part.splitn(2, ',').collect();
    if hv.len() < 2 {
        return None;
    }
    let h_raw: i64 = hv.first()?.parse().ok()?;
    let v_raw: i64 = hv.get(1)?.parse().ok()?;

    let h = h_raw as f64 * factor + x_offset;
    let v = v_raw as f64 * factor + y_offset;

    Some(SynctexNode { tag, line, h, v })
}

// --- Tauri Commands ---

#[derive(serde::Serialize)]
pub struct TexliveStatus {
    pub available: bool,
    pub engines: Vec<String>,
    pub version: Option<String>,
}

#[tauri::command]
pub fn detect_texlive() -> TexliveStatus {
    let engines_to_check = ["pdflatex", "xelatex", "lualatex"];
    let mut found_engines = Vec::new();

    for name in &engines_to_check {
        if find_texlive_binary(name).is_ok() {
            found_engines.push(name.to_string());
        }
    }

    let version = find_texlive_binary("pdflatex").ok().and_then(|path| {
        let mut cmd = std::process::Command::new(&path);
        cmd.arg("--version")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.output().ok().and_then(|o| {
            let stdout = String::from_utf8_lossy(&o.stdout);
            stdout.lines().next().map(|l| l.to_string())
        })
    });

    TexliveStatus {
        available: !found_engines.is_empty(),
        engines: found_engines,
        version,
    }
}

#[tauri::command]
pub async fn compile_latex(
    state: tauri::State<'_, LatexCompilerState>,
    project_dir: String,
    main_file: String,
    use_texlive: Option<bool>,
) -> Result<tauri::ipc::Response, String> {
    // Acquire semaphore permit (non-blocking)
    let _permit = state
        .semaphore
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Server busy, too many concurrent compilations".to_string())?;

    // Acquire per-project lock to prevent concurrent compilations on the same build dir.
    let project_lock = {
        let mut locks = state.project_locks.lock().await;
        locks
            .entry(project_dir.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    let _project_guard = project_lock.lock().await;

    let t0 = Instant::now();
    let deadline = t0 + LATEX_COMPILE_TIMEOUT;
    let want_texlive = use_texlive.unwrap_or(false);

    let main_file_name = Path::new(&main_file)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document")
        .to_string();

    // Set up an in-project build directory. A project-controlled symlink at
    // `.prism/build` (or `.prism`) is replaced so copy/remove/compile cannot
    // follow it outside the project.
    let project_dir_for_prep = project_dir.clone();
    let main_file_name_for_prep = main_file_name.clone();
    let (work_dir, is_reuse) = tokio::task::spawn_blocking(move || {
        prepare_compile_tree(&project_dir_for_prep, &main_file_name_for_prep)
    })
    .await
    .map_err(|e| format!("File sync task panicked: {}", e))??;

    eprintln!(
        "[latex] +{:.0}ms {} ({}, backend={})",
        t0.elapsed().as_millis(),
        if is_reuse {
            "sync source files"
        } else {
            "full copy"
        },
        if is_reuse { "reuse" } else { "first build" },
        if want_texlive { "texlive" } else { "tectonic" }
    );

    let pdf_path = work_dir.join(format!("{}.pdf", main_file_name));

    // Verify the main TeX file exists before attempting compilation
    let main_tex_path = work_dir.join(&main_file);
    if !main_tex_path.exists() {
        return Err(format!(
            "Compilation failed\n\nNo .tex file found: \"{}\". Create a document.tex or main.tex file to compile.",
            main_file
        ));
    }

    // Detect TeX engine from magic comment
    let original_tex = std::fs::read_to_string(&main_tex_path).unwrap_or_default();
    let main_tex_content = ensure_hit_thesis_natbib_options(&original_tex);
    if main_tex_content != original_tex {
        if let Err(error) =
            write_replacing_dest_symlink(&main_tex_path, main_tex_content.as_bytes())
        {
            eprintln!("[latex] failed to patch HIT thesis natbib options: {error}");
        }
    }
    let engine = detect_tex_engine(&main_tex_content);

    // Save engine name before `engine` is moved into the spawn_blocking closure
    let engine_name_for_label = match &engine {
        Some(TexEngine::XeLaTeX) | None => "xelatex",
        Some(TexEngine::Latex) => "pdflatex",
        Some(TexEngine::LuaLaTeX) => "lualatex",
    };
    let texlive_engine_found = find_texlive_binary(engine_name_for_label).is_ok();
    let use_texlive = resolve_latex_backend(want_texlive, texlive_engine_found);
    if want_texlive && !use_texlive {
        eprintln!(
            "[latex] {} not found; falling back to bundled Tectonic",
            engine_name_for_label
        );
    }
    let backend_label = if use_texlive {
        format!("TeXLive/{}", engine_name_for_label)
    } else {
        "Tectonic".to_string()
    };

    if !is_real_dir(&work_dir) {
        return Err("Refusing to compile through a build directory symlink".to_string());
    }

    if !use_texlive {
        if let Some(TexEngine::LuaLaTeX) = engine {
            return Err(
                "Compilation failed\n\nThis document requires LuaLaTeX (% !TEX program = lualatex), \
                 which is not supported. Prism uses a XeTeX-based engine (Tectonic). \
                 Please switch to XeLaTeX or remove the magic comment."
                    .to_string(),
            );
        }
    }

    let compile_result = if use_texlive {
        let work_dir_clone = work_dir.clone();
        let main_file_clone = main_file.clone();
        let result = tokio::task::spawn_blocking(move || {
            lower_thread_priority();
            compile_with_texlive(
                &work_dir_clone,
                &main_file_clone,
                engine,
                &main_tex_content,
                deadline,
            )
        })
        .await
        .map_err(|e| format!("Compilation task panicked: {}", e))?;
        eprintln!(
            "[latex] +{:.0}ms texlive done (ok={})",
            t0.elapsed().as_millis(),
            result.is_ok()
        );
        result
    } else {
        // Run Tectonic in a subprocess to isolate C-level global state (font cache, etc.).
        let work_dir_clone = work_dir.clone();
        let main_file_clone = main_file.clone();
        let result = tokio::task::spawn_blocking(move || {
            lower_thread_priority();
            compile_with_tectonic_subprocess(&work_dir_clone, &main_file_clone, deadline)
        })
        .await
        .map_err(|e| format!("Compilation task panicked: {}", e))?;
        eprintln!(
            "[latex] +{:.0}ms tectonic done (ok={})",
            t0.elapsed().as_millis(),
            result.is_ok()
        );
        result
    };

    let log_path = work_dir.join(format!("{}.log", main_file_name));

    // Handle "No pages of output" — retry with \AtEndDocument{\null} injection (Tectonic only).
    // TeXLive multi-pass handles this differently; the injection is Tectonic-specific.
    if !use_texlive && !pdf_path.exists() {
        let log_path_clone = log_path.clone();
        let main_tex = work_dir.join(&main_file);
        let pdf_path_clone = pdf_path.clone();
        let main_file_clone = main_file.clone();
        let work_dir_clone = work_dir.clone();

        let needs_retry = tokio::task::spawn_blocking(move || {
            let log_content = std::fs::read_to_string(&log_path_clone).unwrap_or_default();
            if !log_content.contains("No pages of output") || has_real_errors(&log_content) {
                return Ok(false);
            }
            eprintln!("[latex] no pages of output — retrying with \\null injection");
            if let Ok(content) = std::fs::read_to_string(&main_tex) {
                if let Some(pos) = content.find("\\begin{document}") {
                    let modified = format!(
                        "{}\\AtEndDocument{{\\null}}{}",
                        &content[..pos],
                        &content[pos..]
                    );
                    let _ = write_replacing_dest_symlink(&main_tex, modified.as_bytes());
                    return Ok(true);
                }
            }
            Ok::<bool, String>(false)
        })
        .await
        .map_err(|e| format!("Retry prep panicked: {}", e))??;

        if needs_retry {
            let retry_result = tokio::task::spawn_blocking(move || {
                compile_with_tectonic_subprocess(&work_dir_clone, &main_file_clone, deadline)
            })
            .await
            .map_err(|e| format!("Retry task panicked: {}", e))?;
            eprintln!(
                "[latex] empty-body retry: ok={} pdf_exists={}",
                retry_result.is_ok(),
                pdf_path_clone.exists()
            );
        }
    }

    // Store build info
    {
        let mut builds = state.last_builds.lock().await;
        builds.insert(
            project_dir.clone(),
            BuildInfo {
                work_dir: work_dir.clone(),
                main_file_name: main_file_name.clone(),
            },
        );
    }

    if pdf_path.exists() {
        let pdf_path_clone = pdf_path.clone();
        let pdf_bytes = tokio::task::spawn_blocking(move || std::fs::read(&pdf_path_clone))
            .await
            .map_err(|e| format!("PDF read task panicked: {}", e))?
            .map_err(|e| format!("Failed to read PDF: {}", e))?;
        eprintln!(
            "[latex] +{:.0}ms total (reuse={}, backend={}) pdf_size={}KB",
            t0.elapsed().as_millis(),
            is_reuse,
            backend_label,
            pdf_bytes.len() / 1024
        );
        Ok(tauri::ipc::Response::new(pdf_bytes))
    } else {
        let log_content = std::fs::read_to_string(&log_path).unwrap_or_default();
        let details = extract_error_lines(&log_content);
        let msg = if details.is_empty() {
            match compile_result {
                Err(e) => e,
                Ok(_) => "Compilation failed: no PDF generated".to_string(),
            }
        } else {
            details
        };
        Err(format!("Compilation failed ({})\n\n{}", backend_label, msg))
    }
}

#[tauri::command]
pub async fn synctex_edit(
    state: tauri::State<'_, LatexCompilerState>,
    project_dir: String,
    page: u32,
    x: f64,
    y: f64,
) -> Result<SynctexResult, String> {
    let builds = state.last_builds.lock().await;
    let build = builds
        .get(&project_dir)
        .ok_or("No build found for this project")?;

    let synctex_gz = build
        .work_dir
        .join(format!("{}.synctex.gz", build.main_file_name));
    let synctex_plain = build
        .work_dir
        .join(format!("{}.synctex", build.main_file_name));

    let work_dir = build.work_dir.clone();
    drop(builds); // Release lock before I/O

    // Read, decompress, and parse synctex data (blocking I/O + CPU work → offload)
    let (mut file, line, column) = tokio::task::spawn_blocking(move || {
        let synctex_data = if synctex_gz.exists() {
            let compressed = std::fs::read(&synctex_gz)
                .map_err(|e| format!("Failed to read synctex.gz: {}", e))?;
            let mut decoder = flate2::read::GzDecoder::new(&compressed[..]);
            let mut data = String::new();
            decoder
                .read_to_string(&mut data)
                .map_err(|e| format!("Failed to decompress synctex: {}", e))?;
            Ok::<_, String>(data)
        } else if synctex_plain.exists() {
            std::fs::read_to_string(&synctex_plain)
                .map_err(|e| format!("Failed to read synctex: {}", e))
        } else {
            Err("No synctex data found. Recompile with synctex enabled.".to_string())
        }?;

        parse_synctex_data(&synctex_data, page, x, y)
            .ok_or_else(|| "Could not resolve source location".to_string())
    })
    .await
    .map_err(|e| format!("Synctex task panicked: {}", e))??;

    // Normalize: strip work_dir prefix and "./" or ".\\" prefix
    let work_dir_str = work_dir.to_string_lossy().to_string();
    if let Some(rest) = file.strip_prefix(&format!("{}/", work_dir_str)) {
        file = rest.to_string();
    } else if let Some(rest) = file.strip_prefix(&format!("{}\\", work_dir_str)) {
        file = rest.to_string();
    }
    if let Some(rest) = file.strip_prefix("./") {
        file = rest.to_string();
    } else if let Some(rest) = file.strip_prefix(".\\") {
        file = rest.to_string();
    }

    Ok(SynctexResult { file, line, column })
}

/// Clear in-memory build state on app exit.
/// Persistent build directories are intentionally kept for fast restart.
pub async fn cleanup_all_builds(state: &LatexCompilerState) {
    let mut builds = state.last_builds.lock().await;
    builds.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- detect_bib_tool ---

    #[test]
    fn test_detect_bib_tool_biber() {
        let content =
            "\\documentclass{article}\n\\usepackage{biblatex}\n\\begin{document}\n\\end{document}";
        assert_eq!(detect_bib_tool(content), BibTool::Biber);
    }

    #[test]
    fn test_detect_bib_tool_biblatex_with_options() {
        let content = "\\documentclass{article}\n\\usepackage[style=apa,backend=biber]{biblatex}\n\\begin{document}";
        assert_eq!(detect_bib_tool(content), BibTool::Biber);
    }

    #[test]
    fn test_detect_bib_tool_bibtex() {
        let content = "\\documentclass{article}\n\\bibliography{refs}\n\\end{document}";
        assert_eq!(detect_bib_tool(content), BibTool::BibTeX);
    }

    #[test]
    fn test_detect_bib_tool_addbibresource() {
        let content = "\\documentclass{article}\n\\addbibresource{refs.bib}\n\\end{document}";
        assert_eq!(detect_bib_tool(content), BibTool::BibTeX);
    }

    #[test]
    fn test_detect_bib_tool_none() {
        let content = "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}";
        assert_eq!(detect_bib_tool(content), BibTool::None);
    }

    #[test]
    fn test_detect_bib_tool_commented_out() {
        let content = "\\documentclass{article}\n% \\bibliography{refs}\n% \\usepackage{biblatex}\n\\end{document}";
        assert_eq!(detect_bib_tool(content), BibTool::None);
    }

    // --- extract_error_lines ---

    #[test]
    fn test_extract_error_lines_empty_log() {
        assert_eq!(extract_error_lines(""), "");
    }

    #[test]
    fn test_extract_error_lines_no_pages() {
        let log = "Some preamble\nNo pages of output.\nSome trailing";
        let result = extract_error_lines(log);
        assert_eq!(
            result,
            "No pages of output. Add visible content to the document body."
        );
    }

    #[test]
    fn test_extract_error_lines_with_errors() {
        let log = "line 1\n! Undefined control sequence.\nline 3\n! Missing $ inserted.\nline 5";
        let result = extract_error_lines(log);
        assert!(result.contains("Undefined control sequence"));
        assert!(result.contains("Missing $ inserted"));
    }

    #[test]
    fn test_extract_error_lines_error_colon() {
        let log = "stuff\nLatex Error: Bad math environment\nmore stuff";
        let result = extract_error_lines(log);
        assert!(result.contains("Error:"));
    }

    #[test]
    fn test_extract_error_lines_no_errors_returns_tail() {
        let log = "a".repeat(1000);
        let result = extract_error_lines(&log);
        // Should return last 500 chars
        assert_eq!(result.len(), 500);
    }

    #[test]
    fn test_extract_error_lines_limits_to_10() {
        let mut log = String::new();
        for i in 0..20 {
            log.push_str(&format!("! Error number {}\n", i));
        }
        let result = extract_error_lines(&log);
        assert!(result.contains("---- Engine output ----"));
        let count = result.lines().count();
        assert!(count <= 120);
    }

    // --- persistent_build_dir ---

    #[test]
    fn test_persistent_build_dir() {
        let dir = persistent_build_dir("/Users/dev/my-project");
        assert_eq!(dir, PathBuf::from("/Users/dev/my-project/.prism/build"));
    }

    // --- parse_synctex_node ---

    #[test]
    fn test_parse_synctex_node_basic() {
        // Format: tag,line,column:h,v
        let node = parse_synctex_node("1,42,0:1000,2000", 1.0, 0.0, 0.0);
        assert!(node.is_some());
        let node = node.unwrap();
        assert_eq!(node.tag, 1);
        assert_eq!(node.line, 42);
        assert_eq!(node.h, 1000.0);
        assert_eq!(node.v, 2000.0);
    }

    #[test]
    fn test_parse_synctex_node_with_dimensions() {
        // Format: tag,line,column:h,v:W,H,D
        let node = parse_synctex_node("3,10,0:500,600:100,20,5", 1.0, 0.0, 0.0);
        assert!(node.is_some());
        let node = node.unwrap();
        assert_eq!(node.tag, 3);
        assert_eq!(node.line, 10);
    }

    #[test]
    fn test_parse_synctex_node_with_offset() {
        let node = parse_synctex_node("1,1,0:0,0", 1.0, 10.0, 20.0);
        let node = node.unwrap();
        assert_eq!(node.h, 10.0); // 0 * 1.0 + 10.0
        assert_eq!(node.v, 20.0); // 0 * 1.0 + 20.0
    }

    #[test]
    fn test_parse_synctex_node_invalid_missing_colon() {
        assert!(parse_synctex_node("1,1,0", 1.0, 0.0, 0.0).is_none());
    }

    #[test]
    fn test_parse_synctex_node_invalid_missing_comma() {
        assert!(parse_synctex_node("1:100,200", 1.0, 0.0, 0.0).is_none());
    }

    // --- parse_synctex_data ---

    #[test]
    fn test_parse_synctex_data_basic() {
        let data = "\
SyncTeX Version:1
Input:1:./main.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
h1,5,0:1000,2000:500,100,0
}1
Postamble:
";
        let result = parse_synctex_data(data, 1, 50.0, 50.0);
        assert!(result.is_some());
        let (file, line, _col) = result.unwrap();
        assert_eq!(file, "./main.tex");
        assert_eq!(line, 5);
    }

    #[test]
    fn test_parse_synctex_data_wrong_page() {
        let data = "\
Input:1:./main.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
h1,5,0:1000,2000
}1
Postamble:
";
        // Looking for page 2 but data only has page 1
        let result = parse_synctex_data(data, 2, 50.0, 50.0);
        assert!(result.is_none());
    }

    #[test]
    fn test_parse_synctex_data_closest_node() {
        let data = "\
Input:1:./main.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
h1,10,0:0,0
h1,20,0:100000000,100000000
}1
Postamble:
";
        // (0, 0) is closer to the first node
        let result = parse_synctex_data(data, 1, 0.0, 0.0);
        assert!(result.is_some());
        let (_, line, _) = result.unwrap();
        assert_eq!(line, 10);
    }

    #[test]
    fn test_parse_synctex_data_empty() {
        let result = parse_synctex_data("", 1, 0.0, 0.0);
        assert!(result.is_none());
    }

    // --- extract_error_lines additional edge cases ---

    #[test]
    fn test_extract_error_lines_mixed_error_formats() {
        let log = "preamble\n! LaTeX Error: File not found.\nl.42 \\input{missing}\nerror: compilation stopped";
        let result = extract_error_lines(log);
        assert!(result.contains("LaTeX Error"));
        assert!(result.contains("error: compilation stopped"));
    }

    #[test]
    fn test_extract_error_lines_short_log_no_errors() {
        let log = "This is a short log without errors";
        let result = extract_error_lines(log);
        // Short log (< 500 chars) returned as tail
        assert_eq!(result, log);
    }

    // --- parse_synctex_node additional edge cases ---

    #[test]
    fn test_parse_synctex_node_negative_coordinates() {
        let node = parse_synctex_node("1,1,0:-500,300", 1.0, 0.0, 0.0);
        assert!(node.is_some());
        let n = node.unwrap();
        assert_eq!(n.h, -500.0);
        assert_eq!(n.v, 300.0);
    }

    #[test]
    fn test_parse_synctex_node_factor_scaling() {
        // factor=2.0 should double the coordinates
        let node = parse_synctex_node("1,1,0:100,200", 2.0, 0.0, 0.0);
        let n = node.unwrap();
        assert_eq!(n.h, 200.0);
        assert_eq!(n.v, 400.0);
    }

    #[test]
    fn test_parse_synctex_node_zero_tag_and_line() {
        let node = parse_synctex_node("0,0,0:0,0", 1.0, 0.0, 0.0);
        let n = node.unwrap();
        assert_eq!(n.tag, 0);
        assert_eq!(n.line, 0);
    }

    // --- parse_synctex_data additional edge cases ---

    #[test]
    fn test_parse_synctex_data_multiple_inputs() {
        let data = "\
Input:1:./main.tex
Input:2:./chapter1.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
h2,15,0:500,500
}1
Postamble:
";
        let result = parse_synctex_data(data, 1, 0.0, 0.0);
        assert!(result.is_some());
        let (file, line, _) = result.unwrap();
        assert_eq!(file, "./chapter1.tex");
        assert_eq!(line, 15);
    }

    #[test]
    fn test_parse_synctex_data_multiple_pages() {
        let data = "\
Input:1:./main.tex
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
h1,5,0:100,100
}1
{2
h1,25,0:200,200
}2
Postamble:
";
        let result = parse_synctex_data(data, 2, 200.0, 200.0);
        assert!(result.is_some());
        let (_, line, _) = result.unwrap();
        assert_eq!(line, 25);
    }

    // --- extract_error_lines: real errors take priority over "No pages of output" ---

    #[test]
    fn test_extract_error_lines_real_errors_over_no_pages() {
        let log = "Some preamble\n! LaTeX Error: File `missing.sty' not found.\nNo pages of output.\nMore stuff";
        let result = extract_error_lines(log);
        assert!(
            result.contains("LaTeX Error"),
            "real error should be shown, got: {}",
            result
        );
        assert!(
            !result.contains("Add visible content"),
            "No pages fallback should NOT appear"
        );
    }

    // --- has_real_errors ---

    #[test]
    fn test_has_real_errors_with_bang() {
        assert!(has_real_errors("ok\n! Undefined control sequence.\nmore"));
    }

    #[test]
    fn test_has_real_errors_with_error_colon() {
        assert!(has_real_errors("LaTeX Error: Bad math\nstuff"));
    }

    #[test]
    fn test_has_real_errors_none() {
        assert!(!has_real_errors("This is pdfTeX\nNo pages of output.\n"));
    }

    // --- detect_tex_engine ---

    #[test]
    fn test_hit_thesis_natbib_options_are_injected_once() {
        let source = "% !TEX program = XeLaTeX\n\\documentclass[type=master]{hitszthesis}\n";
        let patched = ensure_hit_thesis_natbib_options(source);
        assert!(patched.contains(HIT_THESIS_NATBIB_OPTIONS));
        assert_eq!(
            ensure_hit_thesis_natbib_options(&patched),
            patched,
            "already-patched sources must stay unchanged"
        );
        assert!(
            !ensure_hit_thesis_natbib_options("\\documentclass{article}\n")
                .contains(HIT_THESIS_NATBIB_OPTIONS)
        );
        assert!(
            ensure_hit_thesis_natbib_options("\\documentclass[doctor]{hithesis}\n")
                .contains(HIT_THESIS_NATBIB_OPTIONS)
        );
    }

    #[test]
    fn test_detect_tex_engine_xelatex() {
        let content = "% !TEX program = xelatex\n\\documentclass{article}\n";
        assert_eq!(detect_tex_engine(content), Some(TexEngine::XeLaTeX));
    }

    #[test]
    fn test_detect_tex_engine_pdflatex() {
        let content = "% !TEX program = pdflatex\n\\documentclass{article}\n";
        assert_eq!(detect_tex_engine(content), Some(TexEngine::Latex));
    }

    #[test]
    fn test_detect_tex_engine_lualatex() {
        let content = "% !TEX program = lualatex\n\\documentclass{article}\n";
        assert_eq!(detect_tex_engine(content), Some(TexEngine::LuaLaTeX));
    }

    #[test]
    fn test_detect_tex_engine_none() {
        let content = "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n";
        assert_eq!(detect_tex_engine(content), None);
    }

    #[test]
    fn test_detect_tex_engine_case_insensitive() {
        let content = "% !TEX program = XeLaTeX\n";
        assert_eq!(detect_tex_engine(content), Some(TexEngine::XeLaTeX));
    }

    #[test]
    fn test_detect_tex_engine_no_spaces() {
        let content = "%!TEX program=xelatex\n";
        assert_eq!(detect_tex_engine(content), Some(TexEngine::XeLaTeX));
    }

    // --- persistent_build_dir edge case ---

    #[test]
    fn test_persistent_build_dir_trailing_slash() {
        let dir = persistent_build_dir("/project/");
        assert_eq!(dir, PathBuf::from("/project/.prism/build"));
    }

    // --- copy_dir_recursive integration tests ---

    #[test]
    fn test_copy_dir_recursive_nested() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        // Create nested structure
        std::fs::create_dir_all(src.path().join("sub").join("deep")).unwrap();
        std::fs::write(src.path().join("top.tex"), "top").unwrap();
        std::fs::write(src.path().join("sub").join("mid.tex"), "mid").unwrap();
        std::fs::write(
            src.path().join("sub").join("deep").join("bottom.tex"),
            "bottom",
        )
        .unwrap();

        copy_dir_recursive(src.path(), dst.path()).unwrap();

        assert_eq!(
            std::fs::read_to_string(dst.path().join("top.tex")).unwrap(),
            "top"
        );
        assert_eq!(
            std::fs::read_to_string(dst.path().join("sub").join("mid.tex")).unwrap(),
            "mid"
        );
        assert_eq!(
            std::fs::read_to_string(dst.path().join("sub").join("deep").join("bottom.tex"))
                .unwrap(),
            "bottom"
        );
    }

    #[test]
    fn test_copy_dir_recursive_skips_hidden_dirs() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        std::fs::create_dir_all(src.path().join(".git")).unwrap();
        std::fs::write(src.path().join(".git").join("config"), "secret").unwrap();
        std::fs::write(src.path().join("main.tex"), "doc").unwrap();

        copy_dir_recursive(src.path(), dst.path()).unwrap();

        assert!(dst.path().join("main.tex").exists());
        assert!(!dst.path().join(".git").exists(), ".git should be skipped");
    }

    #[test]
    fn test_copy_dir_recursive_empty_subdir() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        std::fs::create_dir_all(src.path().join("empty_sub")).unwrap();
        std::fs::write(src.path().join("a.tex"), "a").unwrap();

        copy_dir_recursive(src.path(), dst.path()).unwrap();

        assert!(dst.path().join("empty_sub").exists());
        assert!(dst.path().join("empty_sub").is_dir());
    }

    // --- sync_source_files integration tests ---

    #[test]
    fn test_sync_source_files_copies_sources() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        std::fs::write(src.path().join("main.tex"), "doc").unwrap();
        std::fs::write(src.path().join("refs.bib"), "bib").unwrap();
        std::fs::write(src.path().join("style.sty"), "sty").unwrap();

        sync_source_files(src.path(), dst.path()).unwrap();

        assert_eq!(
            std::fs::read_to_string(dst.path().join("main.tex")).unwrap(),
            "doc"
        );
        assert_eq!(
            std::fs::read_to_string(dst.path().join("refs.bib")).unwrap(),
            "bib"
        );
        assert_eq!(
            std::fs::read_to_string(dst.path().join("style.sty")).unwrap(),
            "sty"
        );
    }

    #[test]
    fn test_sync_source_files_skips_artifacts() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        std::fs::write(src.path().join("main.tex"), "doc").unwrap();
        std::fs::write(src.path().join("main.aux"), "aux").unwrap();
        std::fs::write(src.path().join("main.log"), "log").unwrap();
        std::fs::write(src.path().join("main.synctex.gz"), "sync").unwrap();

        sync_source_files(src.path(), dst.path()).unwrap();

        assert!(dst.path().join("main.tex").exists());
        assert!(!dst.path().join("main.aux").exists());
        assert!(!dst.path().join("main.log").exists());
        assert!(!dst.path().join("main.synctex.gz").exists());
    }

    #[test]
    fn test_sync_source_files_recursive_and_skips_hidden() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        std::fs::create_dir_all(src.path().join("chapters")).unwrap();
        std::fs::create_dir_all(src.path().join(".claudeprism")).unwrap();
        std::fs::write(src.path().join("chapters").join("ch1.tex"), "ch1").unwrap();
        std::fs::write(src.path().join("chapters").join("ch1.aux"), "aux").unwrap();
        std::fs::write(src.path().join(".claudeprism").join("data"), "data").unwrap();

        sync_source_files(src.path(), dst.path()).unwrap();

        assert_eq!(
            std::fs::read_to_string(dst.path().join("chapters").join("ch1.tex")).unwrap(),
            "ch1"
        );
        assert!(!dst.path().join("chapters").join("ch1.aux").exists());
        assert!(!dst.path().join(".claudeprism").exists());
    }

    // --- sync_source_files copies figure PDFs ---

    #[test]
    fn test_sync_source_files_copies_figure_pdfs() {
        // .pdf files (e.g. figures) must be synced — they are NOT artifacts.
        // The output PDF is managed by compile_latex (explicit remove_file).
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        std::fs::create_dir_all(src.path().join("figures")).unwrap();
        std::fs::write(src.path().join("main.tex"), "doc").unwrap();
        std::fs::write(src.path().join("figures").join("chart.pdf"), "pdf figure").unwrap();

        sync_source_files(src.path(), dst.path()).unwrap();

        assert!(dst.path().join("main.tex").exists());
        assert_eq!(
            std::fs::read_to_string(dst.path().join("figures").join("chart.pdf")).unwrap(),
            "pdf figure"
        );
    }

    #[test]
    fn test_sync_source_files_overwrites_changed_tex_content() {
        // Regression: when a user empties a file, sync must overwrite
        // the old content in the build dir with the empty content.
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();

        // Old content in build dir
        std::fs::write(dst.path().join("main.tex"), "old content").unwrap();
        // User emptied the file
        std::fs::write(src.path().join("main.tex"), "").unwrap();

        sync_source_files(src.path(), dst.path()).unwrap();

        assert_eq!(
            std::fs::read_to_string(dst.path().join("main.tex")).unwrap(),
            ""
        );
    }

    // --- persistent_build_dir ---

    #[test]
    fn test_stale_pdf_removal_pattern() {
        // Simulates the pattern used in compile_latex: remove stale PDF
        // before compilation so a failed compile doesn't return old results.
        let build_dir = tempfile::tempdir().unwrap();
        let pdf_path = build_dir.path().join("document.pdf");

        // Simulate previous successful build left a PDF
        std::fs::write(&pdf_path, "old pdf data").unwrap();
        assert!(pdf_path.exists());

        // This is what compile_latex does before running tectonic
        let _ = std::fs::remove_file(&pdf_path);
        assert!(!pdf_path.exists());

        // If compilation fails, pdf_path.exists() is false → error returned
    }

    #[test]
    fn test_missing_texlive_falls_back_to_tectonic() {
        assert!(!resolve_latex_backend(true, false));
        assert!(resolve_latex_backend(true, true));
        assert!(!resolve_latex_backend(false, true));
        assert!(!resolve_latex_backend(false, false));
    }

    #[cfg(windows)]
    #[test]
    fn test_windows_tex_search_includes_miktex_tinytex_and_texlive() {
        let joined = extra_tex_bin_dirs()
            .iter()
            .map(|path| path.to_string_lossy().to_lowercase())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            joined.contains("miktex"),
            "search should include MiKTeX: {joined}"
        );
        assert!(
            joined.contains("texlive"),
            "search should include TeXLive: {joined}"
        );
        assert!(
            joined.contains("tinytex"),
            "search should include TinyTeX: {joined}"
        );
    }

    #[test]
    fn test_stale_pdf_removal_no_existing_file() {
        // remove_file on a non-existent path should not panic (we use let _ =)
        let build_dir = tempfile::tempdir().unwrap();
        let pdf_path = build_dir.path().join("document.pdf");

        assert!(!pdf_path.exists());
        let result = std::fs::remove_file(&pdf_path);
        // It's an error but we ignore it with let _ =
        assert!(result.is_err());
    }

    fn make_dir_symlink(target: &Path, link: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(target, link).unwrap();
    }

    fn project_path(dir: &tempfile::TempDir) -> String {
        dir.path().to_str().unwrap().to_string()
    }

    #[test]
    fn prepare_compile_tree_does_not_follow_escaping_build_symlink() {
        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(project.path().join("main.tex"), "doc").unwrap();
        std::fs::write(outside.path().join("main.pdf"), "do-not-delete").unwrap();
        std::fs::write(outside.path().join("keep.txt"), "untouched").unwrap();
        std::fs::create_dir_all(project.path().join(".prism")).unwrap();
        make_dir_symlink(outside.path(), &project.path().join(".prism").join("build"));

        let (work_dir, _) = prepare_compile_tree(&project_path(&project), "main").unwrap();

        assert!(
            work_dir.starts_with(project.path()),
            "build dir must stay inside the project: {}",
            work_dir.display()
        );
        assert!(
            is_real_dir(&work_dir),
            "build dir must be a real directory, not a symlink"
        );
        assert_eq!(
            work_dir.canonicalize().unwrap(),
            project
                .path()
                .join(".prism")
                .join("build")
                .canonicalize()
                .unwrap()
        );
        assert_eq!(
            std::fs::read_to_string(work_dir.join("main.tex")).unwrap(),
            "doc"
        );
        assert!(!outside.path().join("main.tex").exists());
        assert_eq!(
            std::fs::read_to_string(outside.path().join("main.pdf")).unwrap(),
            "do-not-delete"
        );
        assert_eq!(
            std::fs::read_to_string(outside.path().join("keep.txt")).unwrap(),
            "untouched"
        );
        assert!(!work_dir.join("main.pdf").exists());
    }

    #[test]
    fn prepare_compile_tree_does_not_follow_escaping_prism_symlink() {
        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(project.path().join("chapter.tex"), "ch").unwrap();
        std::fs::write(outside.path().join("main.pdf"), "do-not-delete").unwrap();
        make_dir_symlink(outside.path(), &project.path().join(".prism"));

        let (work_dir, _) = prepare_compile_tree(&project_path(&project), "main").unwrap();

        assert!(is_real_dir(&project.path().join(".prism")));
        assert!(is_real_dir(&work_dir));
        assert!(work_dir.starts_with(project.path()));
        assert_eq!(
            std::fs::read_to_string(work_dir.join("chapter.tex")).unwrap(),
            "ch"
        );
        assert!(!outside.path().join("chapter.tex").exists());
        assert_eq!(
            std::fs::read_to_string(outside.path().join("main.pdf")).unwrap(),
            "do-not-delete"
        );
        assert!(!outside.path().join("build").exists());
    }

    #[test]
    fn prepare_compile_tree_accepts_a_symlinked_project_root() {
        let real = tempfile::tempdir().unwrap();
        let link_parent = tempfile::tempdir().unwrap();
        let link = link_parent.path().join("paper");
        make_dir_symlink(real.path(), &link);
        std::fs::write(real.path().join("main.tex"), "doc").unwrap();

        let (work_dir, _) = prepare_compile_tree(link.to_str().unwrap(), "main").unwrap();

        assert!(is_real_dir(&work_dir));
        assert!(work_dir
            .canonicalize()
            .unwrap()
            .starts_with(real.path().canonicalize().unwrap()));
        assert_eq!(
            std::fs::read_to_string(work_dir.join("main.tex")).unwrap(),
            "doc"
        );
    }

    #[test]
    fn prepare_compile_tree_reuses_a_real_in_project_build_dir() {
        let project = tempfile::tempdir().unwrap();
        std::fs::write(project.path().join("main.tex"), "doc").unwrap();
        let build = project.path().join(".prism").join("build");
        std::fs::create_dir_all(&build).unwrap();
        std::fs::write(build.join("main.aux"), "keep-aux-on-reuse").unwrap();

        let (work_dir, is_reuse) = prepare_compile_tree(&project_path(&project), "main").unwrap();

        assert!(is_reuse);
        assert_eq!(work_dir, build);
        assert_eq!(
            std::fs::read_to_string(work_dir.join("main.tex")).unwrap(),
            "doc"
        );
        assert_eq!(
            std::fs::read_to_string(work_dir.join("main.aux")).unwrap(),
            "keep-aux-on-reuse"
        );
    }

    #[test]
    fn remove_stale_build_output_unlinks_pdf_symlink_without_deleting_target() {
        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let build = project.path().join(".prism").join("build");
        std::fs::create_dir_all(&build).unwrap();
        let target = outside.path().join("notes.pdf");
        std::fs::write(&target, "keep").unwrap();
        let pdf_link = build.join("main.pdf");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &pdf_link).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&target, &pdf_link).unwrap();

        remove_stale_build_output(&pdf_link);

        assert!(!pdf_link.exists());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep");
    }

    #[test]
    fn remove_stale_build_output_skips_parent_symlink_without_deleting_target() {
        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("main.pdf"), "keep").unwrap();
        std::fs::create_dir_all(project.path().join(".prism")).unwrap();
        let build_link = project.path().join(".prism").join("build");
        make_dir_symlink(outside.path(), &build_link);

        remove_stale_build_output(&build_link.join("main.pdf"));
        assert_eq!(
            std::fs::read_to_string(outside.path().join("main.pdf")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn prepare_compile_tree_creates_a_normal_in_project_build_dir() {
        let project = tempfile::tempdir().unwrap();
        std::fs::write(project.path().join("main.tex"), "hello").unwrap();
        std::fs::write(project.path().join("refs.bib"), "bib").unwrap();

        let (work_dir, is_reuse) = prepare_compile_tree(&project_path(&project), "main").unwrap();

        assert!(!is_reuse);
        assert_eq!(work_dir, project.path().join(".prism").join("build"));
        assert!(is_real_dir(&work_dir));
        assert_eq!(
            std::fs::read_to_string(work_dir.join("main.tex")).unwrap(),
            "hello"
        );
        assert_eq!(
            std::fs::read_to_string(work_dir.join("refs.bib")).unwrap(),
            "bib"
        );
        assert!(!work_dir.join("main.pdf").exists());
    }

    #[test]
    fn copy_dir_recursive_replaces_destination_symlink_instead_of_writing_through_it() {
        let src = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let dst_parent = tempfile::tempdir().unwrap();
        std::fs::write(src.path().join("a.tex"), "a").unwrap();
        std::fs::write(outside.path().join("keep.txt"), "keep").unwrap();
        let dst = dst_parent.path().join("build");
        make_dir_symlink(outside.path(), &dst);

        copy_dir_recursive(src.path(), &dst).unwrap();

        assert!(is_real_dir(&dst));
        assert_eq!(std::fs::read_to_string(dst.join("a.tex")).unwrap(), "a");
        assert!(!outside.path().join("a.tex").exists());
        assert_eq!(
            std::fs::read_to_string(outside.path().join("keep.txt")).unwrap(),
            "keep"
        );
    }

    fn hanging_compile_command() -> std::process::Command {
        #[cfg(windows)]
        {
            let mut cmd = std::process::Command::new("ping");
            cmd.args(["-n", "20", "127.0.0.1"]);
            cmd.stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            cmd
        }
        #[cfg(not(windows))]
        {
            let mut cmd = std::process::Command::new("sleep");
            cmd.arg("20");
            cmd.stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            cmd
        }
    }

    #[test]
    fn run_limited_command_times_out_and_returns_quickly() {
        let started = Instant::now();
        let error =
            run_limited_command(hanging_compile_command(), Duration::from_millis(200)).unwrap_err();
        assert!(error.contains("timed out"), "{error}");
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "timeout cleanup exceeded its bounded deadline: {:?}",
            started.elapsed()
        );
    }

    #[cfg(unix)]
    #[test]
    fn run_limited_command_kills_process_group_descendants() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let sentinel = temp.path().join("descendant-survived.txt");
        let script = temp.path().join("compiler-with-descendant");
        let escaped_sentinel = sentinel.to_string_lossy().replace('\'', "'\\''");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\n(sleep 0.8; printf survived > '{}') &\nsleep 5\n",
                escaped_sentinel
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let mut cmd = std::process::Command::new(&script);
        cmd.stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let started = Instant::now();
        let error = run_limited_command(cmd, Duration::from_millis(150)).unwrap_err();
        std::thread::sleep(Duration::from_millis(1_200));

        assert!(error.contains("timed out"), "{error}");
        assert!(
            !sentinel.exists(),
            "compiler descendant survived timeout cleanup"
        );
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "descendant cleanup exceeded its bounded deadline"
        );
    }

    #[test]
    fn run_limited_command_completes_a_successful_helper() {
        let mut cmd = if cfg!(windows) {
            let mut cmd = std::process::Command::new("cmd");
            cmd.args(["/C", "echo ok"]);
            cmd
        } else {
            std::process::Command::new("true")
        };
        cmd.stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let output = run_limited_command(cmd, Duration::from_secs(5)).unwrap();
        assert!(output.status.success());
    }
}
