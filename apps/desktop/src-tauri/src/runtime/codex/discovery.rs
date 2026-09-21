use std::collections::HashSet;
use std::ffi::OsString;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::task::JoinHandle;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(unix)]
use std::num::NonZeroI32;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

pub const CODEX_NOT_FOUND: &str = "Codex CLI was not found or failed validation";
const VERSION_PREFIX: &str = "codex-cli ";
const VALIDATION_TIMEOUT: Duration = Duration::from_secs(5);
const CANDIDATE_OUTPUT_LIMIT: usize = 64 * 1024;
const CANDIDATE_READER_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);
const CANDIDATE_REAP_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexBinary {
    pub path: PathBuf,
    pub version: String,
}

#[derive(Debug, Clone)]
struct DiscoveryEnvironment {
    exact_override: Option<PathBuf>,
    path_dirs: Vec<PathBuf>,
    registry_path_dirs: Vec<PathBuf>,
    app_data: Option<PathBuf>,
    local_app_data: Option<PathBuf>,
    volta_home: Option<PathBuf>,
    scoop_home: Option<PathBuf>,
    windows_apps: Vec<PathBuf>,
    npm_prefix: Option<PathBuf>,
    pnpm_home: Option<PathBuf>,
    windows: bool,
}

impl DiscoveryEnvironment {
    /// Full environment capture for complete candidate discovery.
    /// Enumerates WindowsApps and registry PATH — can be slow on Windows.
    fn capture() -> Self {
        Self::capture_inner(true)
    }

    /// Lightweight capture for known npm/override probes.
    /// Skips WindowsApps enumeration and registry PATH (unused by known probe paths).
    fn capture_for_known_probe() -> Self {
        Self::capture_inner(false)
    }

    fn capture_inner(include_slow_sources: bool) -> Self {
        let path_dirs = std::env::var_os("PATH")
            .map(|value| std::env::split_paths(&value).collect())
            .unwrap_or_default();
        let (windows_apps, registry_path_dirs) = if include_slow_sources {
            let program_files = [
                std::env::var_os("ProgramFiles").map(PathBuf::from),
                std::env::var_os("ProgramW6432").map(PathBuf::from),
            ];
            let windows_apps = program_files
                .into_iter()
                .flatten()
                .flat_map(|root| enumerate_windows_apps(&root))
                .collect();
            (windows_apps, registry_path_dirs())
        } else {
            (Vec::new(), Vec::new())
        };

        Self {
            exact_override: nonempty_env_path("CLAUDE_PRISM_CODEX_PATH"),
            path_dirs,
            registry_path_dirs,
            app_data: nonempty_env_path("APPDATA"),
            local_app_data: nonempty_env_path("LOCALAPPDATA"),
            volta_home: nonempty_env_path("VOLTA_HOME"),
            scoop_home: nonempty_env_path("SCOOP"),
            windows_apps,
            npm_prefix: nonempty_env_path("NPM_CONFIG_PREFIX"),
            pnpm_home: nonempty_env_path("PNPM_HOME"),
            windows: cfg!(target_os = "windows"),
        }
    }
}

fn nonempty_env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

#[cfg(target_os = "windows")]
fn registry_path_dirs() -> Vec<PathBuf> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    let values = [
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey("Environment")
            .ok()
            .and_then(|key| key.get_value::<String, _>("Path").ok()),
        RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey(r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment")
            .ok()
            .and_then(|key| key.get_value::<String, _>("Path").ok()),
    ];

    values
        .into_iter()
        .flatten()
        .flat_map(|value| {
            let expanded = expand_percent_environment_variables(&value);
            std::env::split_paths(&OsString::from(expanded)).collect::<Vec<_>>()
        })
        .collect()
}

#[cfg(not(target_os = "windows"))]
fn registry_path_dirs() -> Vec<PathBuf> {
    Vec::new()
}

#[cfg(target_os = "windows")]
fn expand_percent_environment_variables(value: &str) -> String {
    let mut expanded = String::with_capacity(value.len());
    let mut remaining = value;

    while let Some(start) = remaining.find('%') {
        expanded.push_str(&remaining[..start]);
        let after_start = &remaining[start + 1..];
        let Some(end) = after_start.find('%') else {
            expanded.push_str(&remaining[start..]);
            return expanded;
        };
        let name = &after_start[..end];
        match std::env::var_os(name) {
            Some(replacement) => expanded.push_str(&replacement.to_string_lossy()),
            None => {
                expanded.push('%');
                expanded.push_str(name);
                expanded.push('%');
            }
        }
        remaining = &after_start[end + 1..];
    }

    expanded.push_str(remaining);
    expanded
}

fn enumerate_windows_apps(program_files: &Path) -> Vec<PathBuf> {
    let root = program_files.join("WindowsApps");
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };

    let mut candidates = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name();
            name.to_string_lossy()
                .starts_with("OpenAI.Codex_")
                .then(|| entry.path().join("app").join("resources").join("codex.exe"))
        })
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    sort_windows_apps_newest_first(&mut candidates);
    candidates
}

fn windows_app_version(path: &Path) -> Vec<u64> {
    windows_app_version_from_text(&path.to_string_lossy())
}

fn windows_app_version_from_text(path: &str) -> Vec<u64> {
    path.split(['/', '\\'])
        .find_map(|component| component.strip_prefix("OpenAI.Codex_"))
        .and_then(|suffix| suffix.split('_').next())
        .map(|version| {
            version
                .split('.')
                .map(|part| part.parse::<u64>().unwrap_or(0))
                .collect()
        })
        .unwrap_or_default()
}

fn sort_windows_apps_newest_first(paths: &mut [PathBuf]) {
    paths.sort_by(|left, right| {
        windows_app_version(right)
            .cmp(&windows_app_version(left))
            .then_with(|| right.to_string_lossy().cmp(&left.to_string_lossy()))
    });
}

fn push_command_forms(paths: &mut Vec<PathBuf>, directory: &Path, windows: bool) {
    if windows {
        paths.push(directory.join("codex.exe"));
        paths.push(directory.join("codex.cmd"));
    }
    paths.push(directory.join("codex"));
}

fn is_script_wrapper(path: &Path) -> bool {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("cmd" | "bat" | "ps1" | "js" | "mjs" | "cjs") => true,
        _ => false,
    }
}

fn npm_package_vendor_roots(package_root: &Path) -> Vec<PathBuf> {
    vec![
        package_root
            .join("node_modules")
            .join("@openai")
            .join("codex-win32-x64")
            .join("vendor"),
        package_root
            .join("node_modules")
            .join("@openai")
            .join("codex-win32-arm64")
            .join("vendor"),
        package_root
            .join("node_modules")
            .join("@openai")
            .join("codex-darwin-x64")
            .join("vendor"),
        package_root
            .join("node_modules")
            .join("@openai")
            .join("codex-darwin-arm64")
            .join("vendor"),
        package_root
            .join("node_modules")
            .join("@openai")
            .join("codex-linux-x64")
            .join("vendor"),
        package_root
            .join("node_modules")
            .join("@openai")
            .join("codex-linux-arm64")
            .join("vendor"),
        package_root.join("vendor"),
    ]
}

fn native_binary_name(windows: bool) -> &'static str {
    if windows {
        "codex.exe"
    } else {
        "codex"
    }
}

fn native_codex_in_vendor_root(vendor_root: &Path, windows: bool) -> Option<PathBuf> {
    let binary_name = native_binary_name(windows);
    let targets = [
        "x86_64-pc-windows-msvc",
        "aarch64-pc-windows-msvc",
        "x86_64-apple-darwin",
        "aarch64-apple-darwin",
        "x86_64-unknown-linux-musl",
        "aarch64-unknown-linux-musl",
    ];
    for target in targets {
        let modern = vendor_root.join(target).join("bin").join(binary_name);
        if modern.is_file() {
            return Some(modern);
        }
        let legacy = vendor_root.join(target).join("codex").join(binary_name);
        if legacy.is_file() {
            return Some(legacy);
        }
    }
    None
}

fn native_codex_from_npm_package(package_root: &Path, windows: bool) -> Option<PathBuf> {
    for vendor_root in npm_package_vendor_roots(package_root) {
        if let Some(path) = native_codex_in_vendor_root(&vendor_root, windows) {
            return Some(path);
        }
    }
    None
}

/// Prefer the native Codex binary when discovery found an npm/cmd/PowerShell wrapper.
/// App-server login binds `http://localhost:1455/auth/callback`; spawning through a
/// `.cmd` → Node → native chain can exit the supervised parent early and tear down that
/// listener before the browser OAuth redirect completes.
fn resolve_launch_binary(path: &Path, windows: bool) -> PathBuf {
    if !is_script_wrapper(path) {
        if windows {
            return path.to_path_buf();
        }
        // Unix npm shims are often extensionless scripts.
        if path
            .file_name()
            .is_some_and(|name| name == "codex" || name == "codex.js")
        {
            // Fall through and try to unwrap common npm layouts.
        } else {
            return path.to_path_buf();
        }
    }

    let Some(parent) = path.parent() else {
        return path.to_path_buf();
    };

    // `<npm-prefix>/codex.cmd` → `<npm-prefix>/node_modules/@openai/codex/.../codex.exe`
    if let Some(native) = native_codex_from_npm_package(
        &parent.join("node_modules").join("@openai").join("codex"),
        windows,
    ) {
        return native;
    }

    // Direct package bin: `.../@openai/codex/bin/codex.js`
    if parent.file_name().is_some_and(|name| name == "bin") {
        if let Some(package_root) = parent.parent() {
            if let Some(native) = native_codex_from_npm_package(package_root, windows) {
                return native;
            }
        }
    }

    path.to_path_buf()
}

fn collapse_lexical_components<'a>(
    components: impl Iterator<Item = &'a str>,
    rooted: bool,
    protected_components: usize,
) -> Vec<&'a str> {
    let mut normalized = Vec::new();
    for component in components {
        match component {
            "" | "." => {}
            ".." => {
                if normalized.len() > protected_components
                    && normalized.last().is_some_and(|part| *part != "..")
                {
                    normalized.pop();
                } else if !rooted {
                    normalized.push(component);
                }
            }
            _ => normalized.push(component),
        }
    }
    normalized
}

fn windows_candidate_key(raw: &str) -> String {
    let standardized = raw.replace('\\', "/");
    let (prefix, remainder, rooted, protected_components) = if standardized.starts_with("//") {
        ("//", standardized.trim_start_matches('/'), true, 2)
    } else if standardized.as_bytes().get(1) == Some(&b':') {
        let prefix_end = 2;
        let after_drive = &standardized[prefix_end..];
        if after_drive.starts_with('/') {
            (
                &standardized[..prefix_end],
                after_drive.trim_start_matches('/'),
                true,
                0,
            )
        } else {
            (&standardized[..prefix_end], after_drive, false, 0)
        }
    } else if standardized.starts_with('/') {
        ("/", standardized.trim_start_matches('/'), true, 0)
    } else {
        ("", standardized.as_str(), false, 0)
    };
    let components =
        collapse_lexical_components(remainder.split('/'), rooted, protected_components);
    let joined = components.join("\\");
    let normalized = match prefix {
        "//" => format!(r"\\{joined}"),
        "/" => format!(r"\{joined}"),
        "" => joined,
        drive if rooted => {
            if joined.is_empty() {
                format!(r"{drive}\")
            } else {
                format!(r"{drive}\{joined}")
            }
        }
        drive => format!("{drive}{joined}"),
    };
    normalized.to_lowercase()
}

fn unix_candidate_key(raw: &str) -> String {
    let rooted = raw.starts_with('/');
    let components = collapse_lexical_components(raw.split('/'), rooted, 0);
    let joined = components.join("/");
    if rooted {
        format!("/{joined}")
    } else if joined.is_empty() {
        ".".into()
    } else {
        joined
    }
}

#[derive(Debug, Hash, PartialEq, Eq)]
enum CandidateKey {
    ResolvedWindows(String),
    ResolvedNative(PathBuf),
    LexicalWindows(String),
    LexicalUnix(String),
    UnresolvedNative(OsString),
}

fn candidate_key_with_resolution(
    path: &Path,
    windows: bool,
    resolved: Option<PathBuf>,
) -> CandidateKey {
    if let Some(resolved) = resolved {
        if windows {
            return resolved
                .to_str()
                .map(windows_candidate_key)
                .map(CandidateKey::ResolvedWindows)
                .unwrap_or(CandidateKey::ResolvedNative(resolved));
        }
        return CandidateKey::ResolvedNative(resolved);
    }

    match (windows, path.to_str()) {
        (true, Some(raw)) => CandidateKey::LexicalWindows(windows_candidate_key(raw)),
        (false, Some(raw)) => CandidateKey::LexicalUnix(unix_candidate_key(raw)),
        (_, None) => CandidateKey::UnresolvedNative(path.as_os_str().to_owned()),
    }
}

fn candidate_key(path: &Path, windows: bool) -> CandidateKey {
    candidate_key_with_resolution(path, windows, path.canonicalize().ok())
}

fn deduplicate(paths: Vec<PathBuf>, windows: bool) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    paths
        .into_iter()
        .filter(|path| seen.insert(candidate_key(path, windows)))
        .collect()
}

fn candidate_paths_from_environment(
    home: &Path,
    environment: &DiscoveryEnvironment,
) -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if let Some(exact_override) = &environment.exact_override {
        paths.push(exact_override.clone());
    }
    for directory in environment
        .path_dirs
        .iter()
        .chain(environment.registry_path_dirs.iter())
    {
        push_command_forms(&mut paths, directory, environment.windows);
    }
    if let Some(app_data) = &environment.app_data {
        push_command_forms(&mut paths, &app_data.join("npm"), environment.windows);
    }

    let volta = environment
        .volta_home
        .clone()
        .unwrap_or_else(|| home.join(".volta"));
    push_command_forms(&mut paths, &volta.join("bin"), environment.windows);

    let scoop = environment
        .scoop_home
        .clone()
        .unwrap_or_else(|| home.join("scoop"));
    push_command_forms(&mut paths, &scoop.join("shims"), environment.windows);

    if let Some(local_app_data) = &environment.local_app_data {
        for directory in [
            local_app_data.join("Programs").join("Codex"),
            local_app_data.join("Programs").join("OpenAI Codex"),
            local_app_data.join("Programs").join("OpenAI").join("Codex"),
        ] {
            push_command_forms(&mut paths, &directory, environment.windows);
        }
    }

    let mut windows_apps = environment.windows_apps.clone();
    sort_windows_apps_newest_first(&mut windows_apps);
    paths.extend(windows_apps);

    push_command_forms(
        &mut paths,
        &home.join(".local").join("bin"),
        environment.windows,
    );
    paths.push(PathBuf::from("/opt/homebrew/bin/codex"));
    paths.push(PathBuf::from("/usr/local/bin/codex"));

    if let Some(npm_prefix) = &environment.npm_prefix {
        push_command_forms(&mut paths, npm_prefix, environment.windows);
        push_command_forms(&mut paths, &npm_prefix.join("bin"), environment.windows);
    }
    if let Some(pnpm_home) = &environment.pnpm_home {
        push_command_forms(&mut paths, pnpm_home, environment.windows);
    }
    push_command_forms(
        &mut paths,
        &home.join(".npm-global").join("bin"),
        environment.windows,
    );
    push_command_forms(
        &mut paths,
        &home.join(".local").join("share").join("pnpm"),
        environment.windows,
    );
    if let Some(app_data) = &environment.app_data {
        push_command_forms(&mut paths, &app_data.join("pnpm"), environment.windows);
    }

    deduplicate(paths, environment.windows)
}

/// Rebuilds the ordered candidate list from current process and platform state.
/// In particular, WindowsApps package paths are enumerated on every call and are never cached.
pub fn candidate_paths(home: &Path) -> Vec<PathBuf> {
    candidate_paths_from_environment(home, &DiscoveryEnvironment::capture())
}

pub fn parse_codex_version(stdout: &str) -> Option<String> {
    let first_line = stdout.lines().next()?;
    let version = first_line.strip_prefix(VERSION_PREFIX)?;
    if version.is_empty() || version.chars().any(char::is_whitespace) {
        return None;
    }
    Some(version.to_owned())
}

fn parse_semver_tuple(version: &str) -> Vec<u64> {
    version
        .split(|c: char| !c.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<u64>().ok())
        .collect()
}

fn version_is_newer(candidate: &str, current: &str) -> bool {
    parse_semver_tuple(candidate) > parse_semver_tuple(current)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CandidateProcessOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

#[derive(Debug)]
struct CandidateStreamCapture {
    bytes: Vec<u8>,
    read_error: Option<String>,
}

type CandidateRunFuture<'a> =
    Pin<Box<dyn Future<Output = Result<CandidateProcessOutput, String>> + Send + 'a>>;

trait CandidateRunner {
    fn run<'a>(&'a mut self, path: &'a Path) -> CandidateRunFuture<'a>;
}

#[derive(Default)]
struct ProcessRunner;

impl CandidateRunner for ProcessRunner {
    fn run<'a>(&'a mut self, path: &'a Path) -> CandidateRunFuture<'a> {
        Box::pin(async move { run_version_command(path).await })
    }
}

fn version_command(path: &Path) -> Result<tokio::process::Command, String> {
    // Rust's Windows process launcher applies its hardened batch-file escaping when a `.cmd`
    // path is launched directly. Keeping the script as the program avoids reparsing an
    // override/PATH candidate as a hand-built `cmd.exe /c` command line.
    let mut command = tokio::process::Command::new(path);
    command.arg("--version");

    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    command.kill_on_drop(true);
    Ok(command)
}

async fn capture_candidate_stream<R>(mut reader: R, limit: usize) -> CandidateStreamCapture
where
    R: AsyncRead + Unpin,
{
    let mut bytes = Vec::with_capacity(limit.min(8 * 1024));
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => {
                let keep = read.min(limit.saturating_sub(bytes.len()));
                bytes.extend_from_slice(&buffer[..keep]);
            }
            Err(error) => {
                return CandidateStreamCapture {
                    bytes,
                    read_error: Some(error.to_string()),
                };
            }
        }
    }
    CandidateStreamCapture {
        bytes,
        read_error: None,
    }
}

async fn finish_candidate_reader(
    mut task: JoinHandle<CandidateStreamCapture>,
) -> Result<CandidateStreamCapture, String> {
    match tokio::time::timeout(CANDIDATE_READER_DRAIN_TIMEOUT, &mut task).await {
        Ok(Ok(capture)) => Ok(capture),
        Ok(Err(error)) => Err(format!("candidate output reader failed: {error}")),
        Err(_) => {
            task.abort();
            let _ = task.await;
            Err("candidate output reader timed out".into())
        }
    }
}

pub(super) fn isolate_process_tree(command: &mut tokio::process::Command) {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};

        // The suspended launch closes the spawn-to-job-assignment race: no candidate or installer
        // code can create descendants before `attach_process_tree` assigns the process to its job.
        command
            .as_std_mut()
            .creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    }

    #[cfg(unix)]
    command.as_std_mut().process_group(0);

    #[cfg(not(any(unix, target_os = "windows")))]
    let _ = command;
}

#[cfg(target_os = "windows")]
struct WindowsOwnedHandle {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(target_os = "windows")]
// SAFETY: Windows kernel handles are process-wide values. This wrapper owns the handle and
// only exposes thread-safe kernel operations; Drop closes it exactly once.
unsafe impl Send for WindowsOwnedHandle {}

#[cfg(target_os = "windows")]
impl WindowsOwnedHandle {
    fn raw(&self) -> windows_sys::Win32::Foundation::HANDLE {
        self.handle
    }
}

#[cfg(target_os = "windows")]
impl Drop for WindowsOwnedHandle {
    fn drop(&mut self) {
        // SAFETY: This wrapper uniquely owns the valid handle and Drop runs exactly once.
        let _ = unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle) };
    }
}

#[cfg(target_os = "windows")]
struct WindowsJobHandle {
    handle: WindowsOwnedHandle,
}

#[cfg(target_os = "windows")]
impl WindowsJobHandle {
    fn attach(child: &tokio::process::Child) -> Result<Self, String> {
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        // SAFETY: Null security attributes/name request a private unnamed job. The returned handle
        // is checked and immediately wrapped for single-owner CloseHandle cleanup.
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
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let information_size = u32::try_from(std::mem::size_of_val(&limits))
            .map_err(|_| "Windows job object information was too large".to_string())?;
        // SAFETY: `limits` has the exact layout required by JobObjectExtendedLimitInformation and
        // remains alive for the duration of this synchronous call.
        if unsafe {
            SetInformationJobObject(
                job.handle.raw(),
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
        let process_handle = child
            .raw_handle()
            .ok_or_else(|| "child process handle was unavailable for job assignment".to_string())?;
        // SAFETY: Tokio owns a valid process handle while the child is running; AssignProcessToJobObject
        // only borrows it for this call. The job handle remains owned by `job`.
        if unsafe { AssignProcessToJobObject(job.handle.raw(), process_handle.cast()) } == 0 {
            return Err(format!(
                "Windows job object assignment failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(job)
    }

    fn terminate(&self) -> Result<(), String> {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;

        // SAFETY: `self.handle` is a live owned job handle until Drop closes it.
        if unsafe { TerminateJobObject(self.handle.raw(), 1) } == 0 {
            return Err(format!(
                "Windows job object termination failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn resume_suspended_child(child: &tokio::process::Child) -> Result<(), String> {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

    let process_id = child
        .id()
        .ok_or_else(|| "child process id was unavailable for thread resume".to_string())?;
    // SAFETY: The snapshot call has no borrowed inputs. A successful handle is uniquely wrapped
    // below and closed on every return path.
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
    // SAFETY: `entry` has the required size and remains writable for these synchronous calls.
    if unsafe { Thread32First(snapshot.raw(), &mut entry) } == 0 {
        return Err(format!(
            "Windows thread enumeration failed: {}",
            std::io::Error::last_os_error()
        ));
    }

    loop {
        if entry.th32OwnerProcessID == process_id {
            // SAFETY: The enumerated thread id belongs to the newly created child. The returned
            // handle is checked, uniquely wrapped, and used only for ResumeThread.
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
            // SAFETY: `thread` is a live handle with THREAD_SUSPEND_RESUME access.
            if unsafe { ResumeThread(thread.raw()) } == u32::MAX {
                return Err(format!(
                    "Windows child thread resume failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
            return Ok(());
        }

        // SAFETY: The snapshot and output entry remain valid for the synchronous enumeration.
        if unsafe { Thread32Next(snapshot.raw(), &mut entry) } == 0 {
            break;
        }
    }

    Err("Windows child primary thread was unavailable for resume".into())
}

pub(super) struct ProcessTreeGuard {
    #[cfg(target_os = "windows")]
    windows_job: WindowsJobHandle,
    #[cfg(unix)]
    unix_process_group: Option<NonZeroI32>,
}

impl ProcessTreeGuard {
    pub(super) fn terminate(self) -> Result<(), String> {
        #[cfg(target_os = "windows")]
        {
            self.windows_job.terminate()
        }

        #[cfg(unix)]
        {
            let mut guard = self;
            let Some(process_group) = guard.unix_process_group else {
                return Ok(());
            };
            let result = terminate_unix_process_group(process_group);
            if result.is_ok() {
                guard.unix_process_group.take();
            }
            result
        }

        #[cfg(not(any(target_os = "windows", unix)))]
        {
            Ok(())
        }
    }

    pub(super) fn cleanup_after_parent_exit(self) -> Result<(), String> {
        #[cfg(target_os = "windows")]
        {
            // Closing a kill-on-close Job is the reliable post-exit cleanup operation. It also
            // covers descendants that outlived the original app-server process.
            drop(self);
            Ok(())
        }

        #[cfg(not(target_os = "windows"))]
        {
            self.terminate()
        }
    }
}

#[cfg(unix)]
impl Drop for ProcessTreeGuard {
    fn drop(&mut self) {
        if let Some(process_group) = self.unix_process_group.take() {
            let _ = terminate_unix_process_group(process_group);
        }
    }
}

pub(super) fn attach_process_tree(
    child: &tokio::process::Child,
) -> Result<ProcessTreeGuard, String> {
    #[cfg(target_os = "windows")]
    {
        let windows_job = WindowsJobHandle::attach(child)?;
        resume_suspended_child(child)?;
        Ok(ProcessTreeGuard { windows_job })
    }

    #[cfg(not(target_os = "windows"))]
    {
        #[cfg(unix)]
        {
            let process_group = process_group_from_child(child)?;
            Ok(ProcessTreeGuard {
                unix_process_group: Some(process_group),
            })
        }

        #[cfg(not(unix))]
        {
            let _ = child;
            Ok(ProcessTreeGuard {})
        }
    }
}

async fn terminate_suspended_child(
    child: &mut tokio::process::Child,
    timeout: Duration,
) -> Result<(), String> {
    // This path is reserved for attach/resume failures. CREATE_SUSPENDED guarantees the child has
    // not run user code or created descendants, so a direct bounded kill/reap is both sufficient
    // and avoids making cleanup success depend on an external process-tree utility.
    let kill_error = child
        .start_kill()
        .err()
        .map(|error| format!("suspended child could not be terminated: {error}"));
    let reap_error = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(_)) => None,
        Ok(Err(error)) => Some(format!("suspended child could not be reaped: {error}")),
        Err(_) => Some("suspended child could not be reaped before the cleanup timeout".into()),
    };

    match (kill_error, reap_error) {
        (_, None) => Ok(()),
        (None, Some(reap_error)) => Err(reap_error),
        (Some(kill_error), Some(reap_error)) => Err(format!("{kill_error}; {reap_error}")),
    }
}

#[cfg(any(unix, test))]
fn classify_process_group_termination(
    result: std::io::Result<()>,
    missing_process_code: i32,
) -> Result<(), String> {
    match result {
        Ok(()) => Ok(()),
        Err(error) if error.raw_os_error() == Some(missing_process_code) => Ok(()),
        Err(error) => Err(format!("process group termination failed: {error}")),
    }
}

#[cfg(any(unix, test))]
fn validate_process_group_target(
    process_group: i32,
    current_process_group: i32,
) -> Result<(), String> {
    if process_group <= 0 {
        return Err("process group id must be positive".into());
    }
    if process_group == current_process_group {
        return Err("refusing to terminate the desktop application's own process group".into());
    }
    Ok(())
}

#[cfg(unix)]
fn process_group_from_child(child: &tokio::process::Child) -> Result<NonZeroI32, String> {
    let process_id = child.id().ok_or_else(|| {
        "child process id was unavailable for process-group ownership".to_string()
    })?;
    let process_group = i32::try_from(process_id)
        .map_err(|_| "child process id did not fit a Unix process-group id".to_string())?;
    NonZeroI32::new(process_group)
        .ok_or_else(|| "child process group id was unexpectedly zero".to_string())
}

#[cfg(unix)]
fn terminate_unix_process_group(process_group: NonZeroI32) -> Result<(), String> {
    // SAFETY: getpgrp has no preconditions and returns the caller's current process group.
    let current_process_group = unsafe { libc::getpgrp() };
    validate_process_group_target(process_group.get(), current_process_group)?;
    // SAFETY: A negative PID addresses a process group. The stored PGID is positive, came from
    // an isolated child created with process_group(0), and was checked against our own PGID.
    let result = if unsafe { libc::kill(-process_group.get(), libc::SIGKILL) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    };
    classify_process_group_termination(result, libc::ESRCH)
}

pub(super) async fn terminate_process_tree(
    child: &mut tokio::process::Child,
    process_tree: Option<ProcessTreeGuard>,
    timeout: Duration,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let tree_result = match process_tree {
        Some(guard) => guard.terminate(),
        // Callers pass no guard only when attach/resume failed while the child was still suspended.
        None => return terminate_suspended_child(child, timeout).await,
    };

    #[cfg(unix)]
    let tree_result = match process_tree {
        Some(guard) => guard.terminate(),
        None => process_group_from_child(child).and_then(terminate_unix_process_group),
    };

    #[cfg(not(any(target_os = "windows", unix)))]
    let tree_result = {
        drop(process_tree);
        Err("process-tree termination is unsupported on this platform".into())
    };

    let _ = child.start_kill();
    let reap_result = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(error)) => Err(format!("process could not be reaped: {error}")),
        Err(_) => Err("process could not be reaped before the cleanup timeout".into()),
    };

    match (tree_result, reap_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(tree_error), Ok(())) => Err(tree_error),
        (Ok(()), Err(reap_error)) => Err(reap_error),
        (Err(tree_error), Err(reap_error)) => Err(format!("{tree_error}; {reap_error}")),
    }
}

async fn run_candidate_command(
    mut command: tokio::process::Command,
    wait_timeout: Duration,
    output_limit: usize,
) -> Result<CandidateProcessOutput, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    isolate_process_tree(&mut command);

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start candidate: {error}"))?;
    let mut process_tree = match attach_process_tree(&child) {
        Ok(process_tree) => Some(process_tree),
        Err(error) => {
            let cleanup = terminate_suspended_child(&mut child, CANDIDATE_REAP_TIMEOUT)
                .await
                .err()
                .map(|cleanup| format!("candidate cleanup failed: {cleanup}"));
            return Err(match cleanup {
                Some(cleanup) => {
                    format!("failed to isolate candidate process tree: {error}; {cleanup}")
                }
                None => format!("failed to isolate candidate process tree: {error}"),
            });
        }
    };
    let Some(stdout) = child.stdout.take() else {
        let _ =
            terminate_process_tree(&mut child, process_tree.take(), CANDIDATE_REAP_TIMEOUT).await;
        return Err("candidate stdout was unavailable".into());
    };
    let Some(stderr) = child.stderr.take() else {
        let _ =
            terminate_process_tree(&mut child, process_tree.take(), CANDIDATE_REAP_TIMEOUT).await;
        return Err("candidate stderr was unavailable".into());
    };
    let stdout_task = tokio::spawn(capture_candidate_stream(stdout, output_limit));
    let stderr_task = tokio::spawn(capture_candidate_stream(stderr, output_limit));

    let wait_result = tokio::time::timeout(wait_timeout, child.wait()).await;
    let status = match wait_result {
        Ok(Ok(status)) => Some(status),
        Ok(Err(error)) => {
            let cleanup =
                terminate_process_tree(&mut child, process_tree.take(), CANDIDATE_REAP_TIMEOUT)
                    .await
                    .err();
            let _ = finish_candidate_reader(stdout_task).await;
            let _ = finish_candidate_reader(stderr_task).await;
            return Err(match cleanup {
                Some(cleanup) => {
                    format!("candidate version check failed: {error}; {cleanup}")
                }
                None => format!("candidate version check failed: {error}"),
            });
        }
        Err(_) => {
            let cleanup =
                terminate_process_tree(&mut child, process_tree.take(), CANDIDATE_REAP_TIMEOUT)
                    .await
                    .err();
            let _ = finish_candidate_reader(stdout_task).await;
            let _ = finish_candidate_reader(stderr_task).await;
            return Err(match cleanup {
                Some(cleanup) => format!("candidate version check timed out; {cleanup}"),
                None => "candidate version check timed out".into(),
            });
        }
    };

    let tree_cleanup = process_tree
        .take()
        .map(ProcessTreeGuard::cleanup_after_parent_exit)
        .transpose();

    let stdout = finish_candidate_reader(stdout_task).await;
    let stderr = finish_candidate_reader(stderr_task).await;
    tree_cleanup?;
    let stdout = stdout?;
    let stderr = stderr?;
    if let Some(error) = stdout.read_error.or(stderr.read_error) {
        return Err(format!("candidate output read failed: {error}"));
    }

    Ok(CandidateProcessOutput {
        success: status.is_some_and(|status| status.success()),
        stdout: String::from_utf8_lossy(&stdout.bytes).into_owned(),
        stderr: String::from_utf8_lossy(&stderr.bytes).into_owned(),
    })
}

async fn run_version_command(path: &Path) -> Result<CandidateProcessOutput, String> {
    run_candidate_command(
        version_command(path)?,
        VALIDATION_TIMEOUT,
        CANDIDATE_OUTPUT_LIMIT,
    )
    .await
}

async fn discover_from_candidates<R: CandidateRunner>(
    candidates: &[PathBuf],
    runner: &mut R,
) -> Result<CodexBinary, String> {
    let mut best: Option<CodexBinary> = None;

    for path in candidates {
        let Ok(output) = runner.run(path).await else {
            continue;
        };
        if !output.success {
            continue;
        }
        let Some(version) = parse_codex_version(&output.stdout) else {
            continue;
        };
        let mut chosen_path = path.clone();
        let launch_path = resolve_launch_binary(path, cfg!(target_os = "windows"));
        if launch_path != *path {
            // Re-validate the unwrapped native binary so we never hand app-server a stale path.
            match runner.run(&launch_path).await {
                Ok(native_output)
                    if native_output.success
                        && parse_codex_version(&native_output.stdout).as_ref()
                            == Some(&version) =>
                {
                    chosen_path = launch_path;
                }
                _ => {
                    // Keep the validated wrapper if the native sibling cannot be re-checked.
                }
            }
        }

        let binary = CodexBinary {
            path: chosen_path,
            version,
        };
        let take = match &best {
            None => true,
            Some(current) => version_is_newer(&binary.version, &current.version),
        };
        if take {
            best = Some(binary);
        }
    }

    best.ok_or_else(|| CODEX_NOT_FOUND.into())
}

/// Fast paths that avoid scanning WindowsApps / full PATH (those can stall UI).
fn known_codex_probe_paths(environment: &DiscoveryEnvironment) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(path) = &environment.exact_override {
        paths.push(path.clone());
    }
    if let Some(app_data) = &environment.app_data {
        let npm = app_data.join("npm");
        push_command_forms(&mut paths, &npm, environment.windows);
        if let Some(native) = native_codex_from_npm_package(
            &npm.join("node_modules").join("@openai").join("codex"),
            environment.windows,
        ) {
            paths.push(native);
        }
    }
    if let Some(npm_prefix) = &environment.npm_prefix {
        push_command_forms(&mut paths, npm_prefix, environment.windows);
        if let Some(native) = native_codex_from_npm_package(
            &npm_prefix
                .join("node_modules")
                .join("@openai")
                .join("codex"),
            environment.windows,
        ) {
            paths.push(native);
        }
    }
    for name in ["codex.exe", "codex.cmd", "codex"] {
        if let Ok(path) = which::which(name) {
            paths.push(path);
        }
    }
    deduplicate(paths, environment.windows)
}

/// Prefer well-known npm / override locations before the expensive full scan.
pub async fn discover_codex_binary_quick() -> Result<CodexBinary, String> {
    let environment = DiscoveryEnvironment::capture_for_known_probe();
    let candidates = known_codex_probe_paths(&environment);
    discover_from_candidates(&candidates, &mut ProcessRunner).await
}

/// Filesystem-only probe — no process spawn. Used to unblock Install UI when the
/// CLI is already on disk but `--version` validation is slow or stuck.
pub fn probe_known_codex_binary_on_disk() -> Option<CodexBinary> {
    probe_known_codex_binary_in_environment(&DiscoveryEnvironment::capture_for_known_probe())
}

fn probe_known_codex_binary_in_environment(
    environment: &DiscoveryEnvironment,
) -> Option<CodexBinary> {
    for path in known_codex_probe_paths(environment) {
        if !path.is_file() {
            continue;
        }
        let launch = resolve_launch_binary(&path, environment.windows);
        if launch.is_file() {
            return Some(CodexBinary {
                path: launch,
                version: "detected".into(),
            });
        }
    }
    None
}

pub async fn discover_codex_binary() -> Result<CodexBinary, String> {
    // Prefer a filesystem-only hit so status/login/app-server cold start never
    // blocks on slow npm `.cmd --version` validation when the native exe exists.
    if let Some(binary) = probe_known_codex_binary_on_disk() {
        return Ok(binary);
    }
    if let Ok(binary) = discover_codex_binary_quick().await {
        return Ok(binary);
    }
    let home = dirs::home_dir().unwrap_or_default();
    let candidates = candidate_paths(&home);
    discover_from_candidates(&candidates, &mut ProcessRunner).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};

    #[cfg(target_os = "windows")]
    fn fake_windows_environment() -> DiscoveryEnvironment {
        DiscoveryEnvironment {
            exact_override: Some(PathBuf::from(r"C:\override\custom-codex.exe")),
            path_dirs: vec![PathBuf::from(r"C:\path-one")],
            registry_path_dirs: vec![PathBuf::from(r"C:\registry-path")],
            app_data: Some(PathBuf::from(r"C:\Users\alice\AppData\Roaming")),
            local_app_data: Some(PathBuf::from(r"C:\Users\alice\AppData\Local")),
            volta_home: Some(PathBuf::from(r"C:\volta")),
            scoop_home: Some(PathBuf::from(r"C:\scoop")),
            windows_apps: vec![
                PathBuf::from(
                    r"C:\Program Files\WindowsApps\OpenAI.Codex_26.701.1.0_x64__publisher\app\resources\codex.exe",
                ),
                PathBuf::from(
                    r"C:\Program Files\WindowsApps\OpenAI.Codex_26.707.12708.0_x64__publisher\app\resources\codex.exe",
                ),
            ],
            npm_prefix: Some(PathBuf::from(r"C:\npm-prefix")),
            pnpm_home: Some(PathBuf::from(r"C:\pnpm-home")),
            windows: true,
        }
    }

    fn position(paths: &[PathBuf], expected: &Path) -> usize {
        paths
            .iter()
            .position(|path| path == expected)
            .unwrap_or_else(|| panic!("missing candidate: {}", expected.display()))
    }

    #[test]
    fn parses_only_nonempty_codex_cli_versions_at_the_start_of_stdout() {
        assert_eq!(
            parse_codex_version("codex-cli 0.135.0\n"),
            Some("0.135.0".into())
        );
        assert_eq!(parse_codex_version("Codex exists"), None);
        assert_eq!(parse_codex_version("codex-cli \n"), None);
        assert_eq!(parse_codex_version("Codex-cli 0.135.0"), None);
        assert_eq!(parse_codex_version("prefix codex-cli 0.135.0"), None);
        assert_eq!(parse_codex_version("codex-cli 0.135.0 extra"), None);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn resolve_launch_binary_unwraps_npm_cmd_wrappers_to_native_vendor_exe() {
        let temp = tempfile::tempdir().unwrap();
        let npm_prefix = temp.path().join("npm");
        let package_root = npm_prefix
            .join("node_modules")
            .join("@openai")
            .join("codex");
        let native = package_root
            .join("node_modules")
            .join("@openai")
            .join("codex-win32-x64")
            .join("vendor")
            .join("x86_64-pc-windows-msvc")
            .join("bin")
            .join("codex.exe");
        std::fs::create_dir_all(native.parent().unwrap()).unwrap();
        std::fs::write(&native, "native").unwrap();
        let wrapper = npm_prefix.join("codex.cmd");
        std::fs::create_dir_all(npm_prefix).unwrap();
        std::fs::write(&wrapper, "@echo off\r\n").unwrap();

        assert_eq!(resolve_launch_binary(&wrapper, true), native);
        assert_eq!(
            resolve_launch_binary(&native, true),
            native,
            "native binaries must stay unchanged"
        );
    }

    #[test]
    fn resolve_launch_binary_unwraps_package_bin_js_entrypoints() {
        let temp = tempfile::tempdir().unwrap();
        let package_root = temp.path().join("codex-package");
        let bin = package_root.join("bin").join("codex.js");
        let native = package_root
            .join("vendor")
            .join("x86_64-unknown-linux-musl")
            .join("bin")
            .join("codex");
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        std::fs::create_dir_all(native.parent().unwrap()).unwrap();
        std::fs::write(&bin, "#!/usr/bin/env node\n").unwrap();
        std::fs::write(&native, "native").unwrap();

        assert_eq!(resolve_launch_binary(&bin, false), native);
    }

    #[tokio::test]
    async fn discovery_prefers_a_revalidated_native_binary_over_an_npm_wrapper() {
        let temp = tempfile::tempdir().unwrap();
        let npm_prefix = temp.path().join("npm");
        let package_root = npm_prefix
            .join("node_modules")
            .join("@openai")
            .join("codex");
        let native = package_root
            .join("vendor")
            .join("x86_64-pc-windows-msvc")
            .join("bin")
            .join(if cfg!(windows) { "codex.exe" } else { "codex" });
        let wrapper = npm_prefix.join(if cfg!(windows) { "codex.cmd" } else { "codex" });
        std::fs::create_dir_all(native.parent().unwrap()).unwrap();
        std::fs::write(&native, "native").unwrap();
        std::fs::write(&wrapper, "wrapper").unwrap();

        let mut runner = FakeRunner::default();
        runner.outputs.insert(
            wrapper.clone(),
            Ok(CandidateProcessOutput {
                success: true,
                stdout: "codex-cli 0.135.0\n".into(),
                stderr: String::new(),
            }),
        );
        runner.outputs.insert(
            native.clone(),
            Ok(CandidateProcessOutput {
                success: true,
                stdout: "codex-cli 0.135.0\n".into(),
                stderr: String::new(),
            }),
        );

        let binary = discover_from_candidates(&[wrapper.clone()], &mut runner)
            .await
            .unwrap();
        assert_eq!(binary.path, native);
        assert_eq!(binary.version, "0.135.0");
        assert_eq!(runner.visited, vec![wrapper, native]);
    }

    #[tokio::test]
    async fn discovery_prefers_higher_semver_when_multiple_candidates_validate() {
        let older = PathBuf::from(if cfg!(windows) {
            r"C:\tools\codex-old.exe"
        } else {
            "/usr/local/bin/codex-old"
        });
        let newer = PathBuf::from(if cfg!(windows) {
            r"C:\tools\codex-new.exe"
        } else {
            "/usr/local/bin/codex-new"
        });

        let mut runner = FakeRunner::default();
        runner.outputs.insert(
            older.clone(),
            Ok(CandidateProcessOutput {
                success: true,
                stdout: "codex-cli 0.135.0\n".into(),
                stderr: String::new(),
            }),
        );
        runner.outputs.insert(
            newer.clone(),
            Ok(CandidateProcessOutput {
                success: true,
                stdout: "codex-cli 0.140.0\n".into(),
                stderr: String::new(),
            }),
        );

        let binary = discover_from_candidates(&[older.clone(), newer.clone()], &mut runner)
            .await
            .unwrap();
        assert_eq!(binary.path, newer);
        assert_eq!(binary.version, "0.140.0");
        assert_eq!(runner.visited, vec![older, newer]);
    }

    #[test]
    fn capture_for_known_probe_skips_windows_apps_and_registry_path() {
        let environment = DiscoveryEnvironment::capture_for_known_probe();
        assert!(
            environment.windows_apps.is_empty(),
            "fast probe must not enumerate WindowsApps"
        );
        assert!(
            environment.registry_path_dirs.is_empty(),
            "fast probe must not read registry PATH"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn known_probe_paths_include_appdata_npm_without_requiring_windows_apps() {
        let mut environment = fake_windows_environment();
        environment.windows_apps.clear();
        environment.registry_path_dirs.clear();

        let paths = known_codex_probe_paths(&environment);
        assert!(
            paths.contains(&PathBuf::from(
                r"C:\Users\alice\AppData\Roaming\npm\codex.cmd"
            )),
            "known probe must still cover APPDATA\\npm\\codex.cmd"
        );
        assert!(
            paths.contains(&PathBuf::from(
                r"C:\Users\alice\AppData\Roaming\npm\codex.exe"
            )),
            "known probe must still cover APPDATA\\npm\\codex.exe"
        );
        assert!(
            !paths
                .iter()
                .any(|path| path.to_string_lossy().contains("WindowsApps")),
            "known probe paths must not depend on WindowsApps candidates"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn disk_probe_prefers_existing_override_and_unwraps_npm_cmd_to_native() {
        let temp = tempfile::tempdir().unwrap();
        let npm_prefix = temp.path().join("npm");
        let package_root = npm_prefix
            .join("node_modules")
            .join("@openai")
            .join("codex");
        let native = package_root
            .join("node_modules")
            .join("@openai")
            .join("codex-win32-x64")
            .join("vendor")
            .join("x86_64-pc-windows-msvc")
            .join("bin")
            .join("codex.exe");
        std::fs::create_dir_all(native.parent().unwrap()).unwrap();
        std::fs::write(&native, "native").unwrap();
        let wrapper = npm_prefix.join("codex.cmd");
        std::fs::create_dir_all(&npm_prefix).unwrap();
        std::fs::write(&wrapper, "@echo off\r\n").unwrap();

        let mut environment = fake_windows_environment();
        environment.exact_override = Some(wrapper);
        environment.app_data = None;
        environment.npm_prefix = Some(npm_prefix);
        environment.path_dirs.clear();
        environment.windows_apps.clear();
        environment.registry_path_dirs.clear();

        let binary = probe_known_codex_binary_in_environment(&environment)
            .expect("disk probe should find the native launch binary");
        assert_eq!(binary.path, native);
        assert_eq!(
            binary.version, "detected",
            "disk probe must not spawn --version; version stays placeholder"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn candidates_cover_all_sources_in_priority_order_and_sort_windows_apps_newest_first() {
        let home = Path::new(r"C:\Users\alice");
        let paths = candidate_paths_from_environment(home, &fake_windows_environment());

        assert_eq!(paths[0], PathBuf::from(r"C:\override\custom-codex.exe"));

        let path = position(&paths, Path::new(r"C:\path-one\codex.exe"));
        let registry = position(&paths, Path::new(r"C:\registry-path\codex.exe"));
        let npm_appdata = position(
            &paths,
            Path::new(r"C:\Users\alice\AppData\Roaming\npm\codex.cmd"),
        );
        let volta = position(&paths, Path::new(r"C:\volta\bin\codex.exe"));
        let scoop = position(&paths, Path::new(r"C:\scoop\shims\codex.exe"));
        let local_program = position(
            &paths,
            Path::new(r"C:\Users\alice\AppData\Local\Programs\Codex\codex.exe"),
        );
        let newest_windows_app = position(
            &paths,
            Path::new(
                r"C:\Program Files\WindowsApps\OpenAI.Codex_26.707.12708.0_x64__publisher\app\resources\codex.exe",
            ),
        );
        let older_windows_app = position(
            &paths,
            Path::new(
                r"C:\Program Files\WindowsApps\OpenAI.Codex_26.701.1.0_x64__publisher\app\resources\codex.exe",
            ),
        );
        let local_bin = position(&paths, Path::new(r"C:\Users\alice\.local\bin\codex"));
        let homebrew = position(&paths, Path::new(r"/opt/homebrew/bin/codex"));
        let npm_prefix = position(&paths, Path::new(r"C:\npm-prefix\codex.exe"));
        let pnpm_home = position(&paths, Path::new(r"C:\pnpm-home\codex.exe"));
        let npm_global = position(
            &paths,
            Path::new(r"C:\Users\alice\.npm-global\bin\codex.exe"),
        );
        let local_pnpm = position(
            &paths,
            Path::new(r"C:\Users\alice\.local\share\pnpm\codex.exe"),
        );
        let appdata_pnpm = position(
            &paths,
            Path::new(r"C:\Users\alice\AppData\Roaming\pnpm\codex.exe"),
        );

        assert!(path < registry);
        assert!(registry < npm_appdata);
        assert!(npm_appdata < volta);
        assert!(volta < scoop);
        assert!(scoop < local_program);
        assert!(local_program < newest_windows_app);
        assert!(newest_windows_app < older_windows_app);
        assert!(older_windows_app < local_bin);
        assert!(local_bin < homebrew);
        assert!(homebrew < npm_prefix);
        assert!(npm_prefix < pnpm_home);
        assert!(pnpm_home < npm_global);
        assert!(npm_global < local_pnpm);
        assert!(local_pnpm < appdata_pnpm);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_candidates_are_deduplicated_case_and_slash_insensitively() {
        let mut environment = fake_windows_environment();
        environment.exact_override = Some(PathBuf::from(r"C:\PATH-ONE\.\nested\..\CODEX.EXE"));

        let paths = candidate_paths_from_environment(Path::new(r"C:\Users\alice"), &environment);
        let expected_key = candidate_key(Path::new(r"C:\path-one\codex.exe"), true);
        let matches = paths
            .iter()
            .filter(|path| candidate_key(path, true) == expected_key)
            .count();

        assert_eq!(matches, 1);
        assert_eq!(
            paths[0],
            PathBuf::from(r"C:\PATH-ONE\.\nested\..\CODEX.EXE")
        );
        assert!(!paths.contains(&PathBuf::from(r"C:\path-one\codex.exe")));
    }

    #[test]
    fn unix_candidates_are_lexically_deduplicated_while_preserving_the_first_path() {
        let first = PathBuf::from("/a/b/../c");
        let paths = deduplicate(
            vec![
                first.clone(),
                PathBuf::from("/a/c"),
                PathBuf::from("/a/./c"),
            ],
            false,
        );

        assert_eq!(unix_candidate_key(first.to_str().unwrap()), "/a/c");
        assert_eq!(paths, vec![first]);
    }

    #[cfg(unix)]
    #[test]
    fn unresolved_override_does_not_suppress_a_later_existing_candidate() {
        let temp = tempfile::tempdir().unwrap();
        let valid_directory = temp.path().join("valid");
        std::fs::create_dir(&valid_directory).unwrap();
        let valid = valid_directory.join("codex");
        std::fs::write(&valid, "codex").unwrap();
        let unresolved = temp
            .path()
            .join("missing")
            .join("..")
            .join("valid")
            .join("codex");

        let paths = deduplicate(vec![unresolved.clone(), valid.clone()], false);

        assert_eq!(paths, vec![unresolved, valid]);
    }

    #[test]
    fn resolved_and_unresolved_candidate_keys_are_distinct() {
        let unresolved = candidate_key_with_resolution(Path::new("/a/b/../c"), false, None);
        let resolved =
            candidate_key_with_resolution(Path::new("/a/c"), false, Some(PathBuf::from("/a/c")));

        assert_ne!(unresolved, resolved);
    }

    #[cfg(unix)]
    #[test]
    fn non_utf8_unix_candidates_are_not_lossily_merged() {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;

        let first = PathBuf::from(OsString::from_vec(b"/tmp/codex-\x80".to_vec()));
        let second = PathBuf::from(OsString::from_vec(b"/tmp/codex-\x81".to_vec()));

        assert_eq!(
            deduplicate(vec![first.clone(), second.clone()], false),
            vec![first, second]
        );
    }

    #[test]
    fn simulated_windows_candidates_are_host_independently_deduplicated() {
        let first = PathBuf::from(r"C:\A\b\..\c");
        let paths = deduplicate(
            vec![
                first.clone(),
                PathBuf::from("c:/a/c"),
                PathBuf::from(r"C:\A\.\c"),
            ],
            true,
        );

        assert_eq!(windows_candidate_key(first.to_str().unwrap()), r"c:\a\c");
        assert_eq!(paths, vec![first]);
    }

    #[test]
    fn windows_app_versions_are_parsed_with_host_independent_grammar() {
        let backslash = r"C:\Program Files\WindowsApps\OpenAI.Codex_26.707.12708.0_x64__publisher\app\resources\codex.exe";
        let slash = "C:/Program Files/WindowsApps/OpenAI.Codex_26.701.1.0_x64__publisher/app/resources/codex.exe";

        assert_eq!(
            windows_app_version_from_text(backslash),
            vec![26, 707, 12708, 0]
        );
        assert_eq!(windows_app_version_from_text(slash), vec![26, 701, 1, 0]);
    }

    #[cfg(unix)]
    #[test]
    fn unix_candidate_sources_keep_the_documented_priority_order() {
        let environment = DiscoveryEnvironment {
            exact_override: Some(PathBuf::from("/override/codex")),
            path_dirs: vec![PathBuf::from("/path")],
            registry_path_dirs: vec![PathBuf::from("/registry")],
            app_data: Some(PathBuf::from("/appdata")),
            local_app_data: Some(PathBuf::from("/local-appdata")),
            volta_home: Some(PathBuf::from("/volta")),
            scoop_home: Some(PathBuf::from("/scoop")),
            windows_apps: Vec::new(),
            npm_prefix: Some(PathBuf::from("/npm-prefix")),
            pnpm_home: Some(PathBuf::from("/pnpm-home")),
            windows: false,
        };
        let paths = candidate_paths_from_environment(Path::new("/home/alice"), &environment);
        let ordered = [
            Path::new("/override/codex"),
            Path::new("/path/codex"),
            Path::new("/registry/codex"),
            Path::new("/appdata/npm/codex"),
            Path::new("/volta/bin/codex"),
            Path::new("/scoop/shims/codex"),
            Path::new("/local-appdata/Programs/Codex/codex"),
            Path::new("/home/alice/.local/bin/codex"),
            Path::new("/opt/homebrew/bin/codex"),
            Path::new("/npm-prefix/codex"),
            Path::new("/pnpm-home/codex"),
        ];
        let positions = ordered.map(|path| position(&paths, path));

        assert!(positions.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[derive(Default)]
    struct FakeRunner {
        outputs: HashMap<PathBuf, Result<CandidateProcessOutput, String>>,
        visited: Vec<PathBuf>,
    }

    impl CandidateRunner for FakeRunner {
        fn run<'a>(&'a mut self, path: &'a Path) -> CandidateRunFuture<'a> {
            self.visited.push(path.to_path_buf());
            let result = self
                .outputs
                .remove(path)
                .unwrap_or_else(|| Err("not configured".into()));
            Box::pin(async move { result })
        }
    }

    #[tokio::test]
    async fn validator_skips_wrong_stdout_and_nonzero_exit_before_accepting_a_valid_binary() {
        let wrong_prefix = PathBuf::from("wrong-prefix");
        let failed_exit = PathBuf::from("failed-exit");
        let valid = PathBuf::from("valid");
        let never_reached = PathBuf::from("never-reached");
        let mut runner = FakeRunner::default();
        runner.outputs.insert(
            wrong_prefix.clone(),
            Ok(CandidateProcessOutput {
                success: true,
                stdout: "Codex exists".into(),
                stderr: String::new(),
            }),
        );
        runner.outputs.insert(
            failed_exit.clone(),
            Ok(CandidateProcessOutput {
                success: false,
                stdout: "codex-cli 0.134.0\n".into(),
                stderr: String::new(),
            }),
        );
        runner.outputs.insert(
            valid.clone(),
            Ok(CandidateProcessOutput {
                success: true,
                stdout: "codex-cli 0.135.0\n".into(),
                stderr: String::new(),
            }),
        );

        let binary = discover_from_candidates(
            &[
                wrong_prefix.clone(),
                failed_exit.clone(),
                valid.clone(),
                never_reached.clone(),
            ],
            &mut runner,
        )
        .await
        .unwrap();

        assert_eq!(
            binary,
            CodexBinary {
                path: valid,
                version: "0.135.0".into(),
            }
        );
        // Probe every candidate so a later higher-semver binary can win; invalid
        // trailing candidates are skipped without changing the winner.
        assert_eq!(
            runner.visited,
            vec![
                wrong_prefix,
                failed_exit,
                PathBuf::from("valid"),
                never_reached
            ]
        );
    }

    #[tokio::test]
    async fn all_invalid_candidates_return_the_no_codex_result() {
        let spawn_error = PathBuf::from("spawn-error");
        let empty_version = PathBuf::from("empty-version");
        let mut runner = FakeRunner::default();
        runner
            .outputs
            .insert(spawn_error.clone(), Err("missing".into()));
        runner.outputs.insert(
            empty_version.clone(),
            Ok(CandidateProcessOutput {
                success: true,
                stdout: "codex-cli \n".into(),
                stderr: String::new(),
            }),
        );

        let error = discover_from_candidates(&[spawn_error, empty_version], &mut runner)
            .await
            .unwrap_err();

        assert_eq!(error, CODEX_NOT_FOUND);
    }

    #[test]
    fn missing_process_group_is_already_terminated_but_other_errors_are_preserved() {
        let missing_code = 42_424;
        assert!(classify_process_group_termination(
            Err(std::io::Error::from_raw_os_error(missing_code)),
            missing_code,
        )
        .is_ok());

        let error = classify_process_group_termination(
            Err(std::io::Error::from_raw_os_error(missing_code + 1)),
            missing_code,
        )
        .expect_err("non-missing process-group error was discarded");
        assert!(error.contains("process group"));
    }

    #[test]
    fn desktop_process_group_is_never_a_valid_cleanup_target() {
        assert!(validate_process_group_target(17, 17).is_err());
        assert!(validate_process_group_target(18, 17).is_ok());
        assert!(validate_process_group_target(0, 17).is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn command_scripts_use_rusts_hardened_direct_batch_launch() {
        use std::ffi::OsStr;

        let script = Path::new(r"C:\Program Files\npm\codex.cmd");
        let command = version_command(script).unwrap();
        let std_command = command.as_std();
        assert_eq!(std_command.get_program(), script.as_os_str());
        assert_eq!(
            std_command.get_args().collect::<Vec<_>>(),
            [OsStr::new("--version")]
        );
    }

    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn cmd_metacharacter_candidates_never_execute_trailing_commands() {
        let temp = tempfile::tempdir().unwrap();
        let sentinel = temp.path().join("codex-injection-sentinel.txt");

        for metacharacter in ['&', '(', ')', '^', '|', '<', '>', '%', '!'] {
            let _ = std::fs::remove_file(&sentinel);
            let candidate = PathBuf::from(format!(
                r"{}\missing{metacharacter}.cmd & echo forged>{} & rem.cmd",
                temp.path().display(),
                sentinel.display()
            ));

            let _ = run_version_command(&candidate).await;

            assert!(
                !sentinel.exists(),
                "candidate containing {metacharacter:?} executed a trailing command"
            );
        }
    }

    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn executes_a_cmd_candidate_from_a_path_with_spaces() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("Codex Test Bin");
        std::fs::create_dir(&directory).unwrap();
        let script = directory.join("codex.cmd");
        std::fs::write(&script, "@echo off\r\necho codex-cli 9.8.7\r\n").unwrap();

        let output = run_version_command(&script).await.unwrap();
        assert!(output.success, "constructed argv failed: {}", output.stderr);
        assert_eq!(parse_codex_version(&output.stdout), Some("9.8.7".into()));
    }

    #[cfg(target_os = "windows")]
    fn hidden_windows_descendant_script(
        trigger_env: &str,
        sentinel_env: &str,
        ready_env: Option<&str>,
    ) -> String {
        fn is_safe_environment_name(name: &str) -> bool {
            !name.is_empty()
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        }

        assert!(is_safe_environment_name(trigger_env));
        assert!(is_safe_environment_name(sentinel_env));
        assert!(ready_env.is_none_or(is_safe_environment_name));

        let ready_statement = ready_env
            .map(|name| format!("Set-Content -LiteralPath $env:{name} ready; "))
            .unwrap_or_default();

        const TEMPLATE: &str = r#"$systemRoot = [System.Environment]::GetEnvironmentVariable('SystemRoot');
if ([System.String]::IsNullOrWhiteSpace($systemRoot)) { throw 'SystemRoot is unavailable' };
$powerShellPath = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($systemRoot, 'System32\WindowsPowerShell\v1.0\powershell.exe'));
if (-not [System.IO.Path]::IsPathRooted($powerShellPath) -or -not [System.IO.File]::Exists($powerShellPath)) { throw 'Windows PowerShell executable is unavailable' };
$descendantScript = '__READY_STATEMENT__while (-not (Test-Path -LiteralPath $env:__TRIGGER_ENV__)) { Start-Sleep -Milliseconds 20 }; Set-Content -LiteralPath $env:__SENTINEL_ENV__ alive';
$encodedCommand = [System.Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($descendantScript));
$startInfo = [System.Diagnostics.ProcessStartInfo]::new();
$startInfo.FileName = $powerShellPath;
$startInfo.Arguments = '-NoProfile -NonInteractive -EncodedCommand ' + $encodedCommand;
$startInfo.UseShellExecute = $false;
$startInfo.CreateNoWindow = $true;
$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden;
$startInfo.RedirectStandardInput = $true;
$startInfo.RedirectStandardOutput = $true;
$startInfo.RedirectStandardError = $true;
$descendant = [System.Diagnostics.Process]::new();
$descendant.StartInfo = $startInfo;
try {
    if (-not $descendant.Start()) { throw 'Failed to start hidden descendant' };
    $descendant.StandardInput.Close();
    $descendant.StandardOutput.Close();
    $descendant.StandardError.Close();
} finally {
    $descendant.Dispose();
}"#;

        TEMPLATE
            .replace("__READY_STATEMENT__", &ready_statement)
            .replace("__TRIGGER_ENV__", trigger_env)
            .replace("__SENTINEL_ENV__", sentinel_env)
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_descendant_script_uses_an_absolute_hidden_process_start_info() {
        let script = hidden_windows_descendant_script(
            "CODEX_TEST_DESCENDANT_TRIGGER",
            "CODEX_TEST_DESCENDANT_SENTINEL",
            Some("CODEX_TEST_DESCENDANT_READY"),
        );

        for required in [
            "[System.IO.Path]::GetFullPath",
            "[System.IO.Path]::IsPathRooted",
            "[System.IO.File]::Exists",
            r"System32\WindowsPowerShell\v1.0\powershell.exe",
            "[System.Diagnostics.ProcessStartInfo]::new()",
            ".UseShellExecute = $false",
            ".CreateNoWindow = $true",
            ".WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden",
            ".RedirectStandardInput = $true",
            ".RedirectStandardOutput = $true",
            ".RedirectStandardError = $true",
            ".StandardInput.Close()",
            ".StandardOutput.Close()",
            ".StandardError.Close()",
            ".Dispose()",
            "$env:CODEX_TEST_DESCENDANT_TRIGGER",
            "$env:CODEX_TEST_DESCENDANT_SENTINEL",
            "$env:CODEX_TEST_DESCENDANT_READY",
        ] {
            assert!(
                script.contains(required),
                "hidden descendant script omitted {required:?}: {script}"
            );
        }
        assert!(!script.contains("Start-Process"));
        assert!(
            script.find("$env:CODEX_TEST_DESCENDANT_READY").unwrap()
                < script.find("$env:CODEX_TEST_DESCENDANT_TRIGGER").unwrap(),
            "the child must report readiness before waiting for the trigger"
        );
    }

    fn candidate_test_command(windows_script: &str, unix_script: &str) -> tokio::process::Command {
        #[cfg(target_os = "windows")]
        {
            let _ = unix_script;
            let mut command = tokio::process::Command::new("powershell.exe");
            command.args(["-NoProfile", "-NonInteractive", "-Command", windows_script]);
            command
        }
        #[cfg(not(target_os = "windows"))]
        {
            let mut command = tokio::process::Command::new("sh");
            command.args(["-c", unix_script]);
            command
        }
    }

    #[tokio::test]
    async fn candidate_output_is_bounded_while_both_streams_are_drained() {
        let command = candidate_test_command(
            "[Console]::Out.Write('codex-cli 1.2.3' + ('x' * 200000)); [Console]::Error.Write('e' * 200000)",
            "printf 'codex-cli 1.2.3'; yes x | head -c 200000; yes e | head -c 200000 >&2",
        );

        let output = run_candidate_command(command, Duration::from_secs(5), 1024)
            .await
            .unwrap();

        assert!(output.success);
        assert!(output.stdout.len() <= 1024);
        assert!(output.stderr.len() <= 1024);
        assert!(output.stdout.starts_with("codex-cli 1.2.3"));
    }

    #[tokio::test]
    async fn candidate_timeout_terminates_and_reaps_before_returning() {
        let temp = tempfile::tempdir().unwrap();
        let sentinel = temp.path().join("candidate-timeout-sentinel.txt");
        let mut command = candidate_test_command(
            "[Console]::Out.Write(('x' * 200000)); Start-Sleep -Milliseconds 500; Set-Content -LiteralPath $env:CODEX_SENTINEL alive",
            "yes x | head -c 200000; sleep 0.5; printf alive > \"$CODEX_SENTINEL\"",
        );
        command.env("CODEX_SENTINEL", &sentinel);

        let error = run_candidate_command(command, Duration::from_millis(50), 1024)
            .await
            .unwrap_err();
        tokio::time::sleep(Duration::from_millis(700)).await;

        assert!(error.contains("timed out"));
        assert!(!sentinel.exists(), "timed-out candidate was still running");
    }

    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn candidate_timeout_terminates_windows_descendants() {
        let temp = tempfile::tempdir().unwrap();
        let trigger = temp.path().join("candidate-descendant-trigger.txt");
        let mut sentinels = Vec::new();
        let mut tasks = tokio::task::JoinSet::new();
        for index in 0..4 {
            let sentinel = temp
                .path()
                .join(format!("candidate-descendant-sentinel-{index}.txt"));
            let windows_script = format!(
                "{}; Start-Sleep -Seconds 5",
                hidden_windows_descendant_script(
                    "CODEX_DESCENDANT_TRIGGER",
                    "CODEX_DESCENDANT_SENTINEL",
                    None,
                )
            );
            let mut command = candidate_test_command(&windows_script, "");
            command
                .env("CODEX_DESCENDANT_TRIGGER", &trigger)
                .env("CODEX_DESCENDANT_SENTINEL", &sentinel);
            sentinels.push(sentinel);
            tasks.spawn(async move {
                run_candidate_command(command, Duration::from_millis(100), 1024).await
            });
        }

        while let Some(result) = tasks.join_next().await {
            let error = result.unwrap().unwrap_err();
            assert!(error.contains("timed out"));
        }
        std::fs::write(&trigger, "check for survivors").unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;

        for sentinel in sentinels {
            assert!(!sentinel.exists(), "candidate descendant survived timeout");
        }
    }

    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn windows_job_guard_drop_terminates_the_assigned_process_tree() {
        let temp = tempfile::tempdir().unwrap();
        let ready = temp.path().join("job-guard-descendant-ready.txt");
        let descendant_ready = temp.path().join("job-guard-hidden-child-ready.txt");
        let trigger = temp.path().join("job-guard-descendant-trigger.txt");
        let sentinel = temp.path().join("job-guard-descendant-sentinel.txt");
        let windows_script = format!(
            "{}; while (-not (Test-Path -LiteralPath $env:CODEX_JOB_DESCENDANT_READY)) {{ Start-Sleep -Milliseconds 10 }}; Set-Content -LiteralPath $env:CODEX_JOB_READY ready; Start-Sleep -Seconds 5",
            hidden_windows_descendant_script(
                "CODEX_JOB_TRIGGER",
                "CODEX_JOB_SENTINEL",
                Some("CODEX_JOB_DESCENDANT_READY"),
            )
        );
        let mut command = candidate_test_command(&windows_script, "");
        command
            .env("CODEX_JOB_READY", &ready)
            .env("CODEX_JOB_DESCENDANT_READY", &descendant_ready)
            .env("CODEX_JOB_TRIGGER", &trigger)
            .env("CODEX_JOB_SENTINEL", &sentinel)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        isolate_process_tree(&mut command);
        let mut child = command.spawn().unwrap();
        let guard = attach_process_tree(&child).unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !ready.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();

        drop(guard);
        tokio::time::timeout(Duration::from_secs(2), child.wait())
            .await
            .unwrap()
            .unwrap();
        std::fs::write(&trigger, "check for survivors").unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;

        assert!(!sentinel.exists(), "job guard drop left a descendant alive");
    }

    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn windows_assignment_failure_fallback_kills_the_suspended_child_before_it_runs() {
        let temp = tempfile::tempdir().unwrap();
        for index in 0..4 {
            let sentinel = temp.path().join(format!("fallback-root-ran-{index}.txt"));
            let mut command = candidate_test_command(
                "Set-Content -LiteralPath $env:CODEX_FALLBACK_SENTINEL ran; Start-Sleep -Seconds 5",
                "",
            );
            command
                .env("CODEX_FALLBACK_SENTINEL", &sentinel)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            isolate_process_tree(&mut command);
            let mut child = command.spawn().unwrap();
            assert!(
                !sentinel.exists(),
                "suspended fallback child ran before cleanup"
            );

            terminate_suspended_child(&mut child, Duration::from_secs(2))
                .await
                .unwrap();

            assert!(
                !sentinel.exists(),
                "assignment-failure fallback allowed suspended child code to run"
            );
        }
    }

    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn windows_resume_failure_cleanup_reaps_after_job_guard_drop() {
        let temp = tempfile::tempdir().unwrap();
        let sentinel = temp.path().join("resume-failure-child-ran.txt");
        let mut command = candidate_test_command(
            "Set-Content -LiteralPath $env:CODEX_RESUME_FAILURE_SENTINEL ran; Start-Sleep -Seconds 5",
            "",
        );
        command
            .env("CODEX_RESUME_FAILURE_SENTINEL", &sentinel)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        isolate_process_tree(&mut command);
        let mut child = command.spawn().unwrap();
        let job = WindowsJobHandle::attach(&child).unwrap();

        drop(job);
        terminate_suspended_child(&mut child, Duration::from_secs(2))
            .await
            .unwrap();

        assert!(
            !sentinel.exists(),
            "resume-failure cleanup allowed suspended child code to run"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn candidate_timeout_terminates_unix_process_group_descendants() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let sentinel = temp.path().join("candidate-descendant-survived.txt");
        let script = temp.path().join("codex-with-descendant");
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

        let started = std::time::Instant::now();
        let error = run_candidate_command(
            version_command(&script).unwrap(),
            Duration::from_millis(100),
            1024,
        )
        .await
        .unwrap_err();
        tokio::time::sleep(Duration::from_millis(1_200)).await;

        assert!(error.contains("timed out"));
        assert!(!sentinel.exists(), "candidate descendant survived timeout");
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "candidate timeout cleanup exceeded its bounded deadline"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn successful_candidate_exit_terminates_unix_process_group_descendants() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let sentinel = temp
            .path()
            .join("successful-candidate-descendant-survived.txt");
        let ready = temp
            .path()
            .join("successful-candidate-descendant-ready.txt");
        let script = temp.path().join("codex-success-with-descendant");
        let escaped_sentinel = sentinel.to_string_lossy().replace('\'', "'\\''");
        let escaped_ready = ready.to_string_lossy().replace('\'', "'\\''");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\n(trap '' HUP; printf ready > '{}'; sleep 0.5; printf survived > '{}') </dev/null >/dev/null 2>&1 &\nwhile [ ! -f '{}' ]; do sleep 0.01; done\nprintf 'codex-cli 1.2.3\\n'\nexit 0\n",
                escaped_ready, escaped_sentinel, escaped_ready
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let output = run_candidate_command(
            version_command(&script).unwrap(),
            Duration::from_secs(2),
            1024,
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(800)).await;

        assert!(output.success);
        assert_eq!(parse_codex_version(&output.stdout), Some("1.2.3".into()));
        assert!(
            !sentinel.exists(),
            "successful candidate exit left a descendant alive"
        );
    }

    #[tokio::test]
    #[ignore = "requires a locally installed Codex CLI"]
    async fn discovers_and_revalidates_the_locally_installed_codex() {
        let home = dirs::home_dir().unwrap();
        for candidate in candidate_paths(&home).into_iter().filter(|candidate| {
            candidate
                .to_string_lossy()
                .to_ascii_lowercase()
                .contains("codex")
                && (candidate.exists()
                    || candidate
                        .to_string_lossy()
                        .to_ascii_lowercase()
                        .contains("appdata\\roaming\\npm"))
        }) {
            eprintln!(
                "candidate diagnostic {} => {:?}",
                candidate.display(),
                run_version_command(&candidate).await
            );
        }
        let binary = discover_codex_binary().await.unwrap();
        let output = run_version_command(&binary.path).await.unwrap();

        assert!(output.success);
        assert_eq!(
            parse_codex_version(&output.stdout),
            Some(binary.version.clone())
        );
        eprintln!(
            "validated local Codex CLI {} at {}",
            binary.version,
            binary.path.display()
        );
    }
}
