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
    fn capture() -> Self {
        let path_dirs = std::env::var_os("PATH")
            .map(|value| std::env::split_paths(&value).collect())
            .unwrap_or_default();
        let program_files = [
            std::env::var_os("ProgramFiles").map(PathBuf::from),
            std::env::var_os("ProgramW6432").map(PathBuf::from),
        ];
        let windows_apps = program_files
            .into_iter()
            .flatten()
            .flat_map(|root| enumerate_windows_apps(&root))
            .collect();

        Self {
            exact_override: nonempty_env_path("CLAUDE_PRISM_CODEX_PATH"),
            path_dirs,
            registry_path_dirs: registry_path_dirs(),
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
    #[cfg(target_os = "windows")]
    command.as_std_mut().creation_flags(0x0800_0000);
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

#[cfg(target_os = "windows")]
fn system32_executable(name: &str) -> Option<PathBuf> {
    let root = std::env::var_os("SystemRoot").map(PathBuf::from)?;
    let candidate = root.join("System32").join(name);
    candidate.is_file().then_some(candidate)
}

pub(super) fn isolate_process_tree(command: &mut tokio::process::Command) {
    #[cfg(unix)]
    command.as_std_mut().process_group(0);

    #[cfg(not(unix))]
    let _ = command;
}

#[cfg(target_os = "windows")]
async fn terminate_platform_process_tree(process_id: u32, timeout: Duration) -> Result<(), String> {
    let taskkill = system32_executable("taskkill.exe")
        .ok_or_else(|| "trusted System32 taskkill.exe was unavailable".to_string())?;
    let mut command = tokio::process::Command::new(taskkill);
    command
        .args(["/PID", &process_id.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    command.as_std_mut().creation_flags(0x0800_0000);
    match tokio::time::timeout(timeout, command.status()).await {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(Ok(status)) => Err(format!("taskkill exited with status {status}")),
        Ok(Err(error)) => Err(format!("taskkill could not be started: {error}")),
        Err(_) => Err("taskkill timed out while terminating the process tree".into()),
    }
}

#[cfg(unix)]
fn trusted_unix_kill() -> Option<PathBuf> {
    [PathBuf::from("/bin/kill"), PathBuf::from("/usr/bin/kill")]
        .into_iter()
        .find(|candidate| candidate.is_file())
}

#[cfg(unix)]
async fn terminate_platform_process_tree(process_id: u32, timeout: Duration) -> Result<(), String> {
    let kill = trusted_unix_kill()
        .ok_or_else(|| "trusted /bin/kill or /usr/bin/kill was unavailable".to_string())?;
    let process_group = format!("-{process_id}");
    let mut command = tokio::process::Command::new(kill);
    command
        .args(["-KILL", "--", &process_group])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    match tokio::time::timeout(timeout, command.status()).await {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(Ok(status)) => Err(format!("kill exited with status {status}")),
        Ok(Err(error)) => Err(format!("kill could not be started: {error}")),
        Err(_) => Err("kill timed out while terminating the process group".into()),
    }
}

#[cfg(not(any(target_os = "windows", unix)))]
async fn terminate_platform_process_tree(
    _process_id: u32,
    _timeout: Duration,
) -> Result<(), String> {
    Err("process-tree termination is unsupported on this platform".into())
}

pub(super) async fn terminate_process_tree(
    child: &mut tokio::process::Child,
    timeout: Duration,
) -> Result<(), String> {
    let tree_result = match child.id() {
        Some(process_id) => terminate_platform_process_tree(process_id, timeout).await,
        None => Err("process id was unavailable for tree termination".into()),
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

async fn terminate_candidate(child: &mut tokio::process::Child) -> Result<(), String> {
    terminate_process_tree(child, CANDIDATE_REAP_TIMEOUT)
        .await
        .map_err(|error| format!("candidate cleanup failed: {error}"))
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
    #[cfg(target_os = "windows")]
    command.as_std_mut().creation_flags(0x0800_0000);
    isolate_process_tree(&mut command);

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start candidate: {error}"))?;
    let Some(stdout) = child.stdout.take() else {
        let _ = terminate_candidate(&mut child).await;
        return Err("candidate stdout was unavailable".into());
    };
    let Some(stderr) = child.stderr.take() else {
        let _ = terminate_candidate(&mut child).await;
        return Err("candidate stderr was unavailable".into());
    };
    let stdout_task = tokio::spawn(capture_candidate_stream(stdout, output_limit));
    let stderr_task = tokio::spawn(capture_candidate_stream(stderr, output_limit));

    let wait_result = tokio::time::timeout(wait_timeout, child.wait()).await;
    let status = match wait_result {
        Ok(Ok(status)) => Some(status),
        Ok(Err(error)) => {
            let cleanup = terminate_candidate(&mut child).await.err();
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
            let cleanup = terminate_candidate(&mut child).await.err();
            let _ = finish_candidate_reader(stdout_task).await;
            let _ = finish_candidate_reader(stderr_task).await;
            return Err(match cleanup {
                Some(cleanup) => format!("candidate version check timed out; {cleanup}"),
                None => "candidate version check timed out".into(),
            });
        }
    };

    let stdout = finish_candidate_reader(stdout_task).await;
    let stderr = finish_candidate_reader(stderr_task).await;
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
        return Ok(CodexBinary {
            path: path.clone(),
            version,
        });
    }
    Err(CODEX_NOT_FOUND.into())
}

pub async fn discover_codex_binary() -> Result<CodexBinary, String> {
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
                never_reached,
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
        assert_eq!(
            runner.visited,
            vec![wrong_prefix, failed_exit, PathBuf::from("valid")]
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
        let sentinel = temp.path().join("candidate-descendant-sentinel.txt");
        let mut command = candidate_test_command(
            "Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Milliseconds 500; Set-Content -LiteralPath $env:CODEX_DESCENDANT_SENTINEL alive'; Start-Sleep -Seconds 5",
            "",
        );
        command.env("CODEX_DESCENDANT_SENTINEL", &sentinel);

        let error = run_candidate_command(command, Duration::from_millis(100), 1024)
            .await
            .unwrap_err();
        tokio::time::sleep(Duration::from_millis(800)).await;

        assert!(error.contains("timed out"));
        assert!(!sentinel.exists(), "candidate descendant survived timeout");
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
