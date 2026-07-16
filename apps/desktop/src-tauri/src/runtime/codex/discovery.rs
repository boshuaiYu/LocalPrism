use std::collections::HashSet;
use std::ffi::OsString;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::time::Duration;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

pub const CODEX_NOT_FOUND: &str = "Codex CLI was not found or failed validation";
const VERSION_PREFIX: &str = "codex-cli ";
const VALIDATION_TIMEOUT: Duration = Duration::from_secs(5);

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
    path.components()
        .filter_map(|component| component.as_os_str().to_str())
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

fn candidate_key(path: &Path, windows: bool) -> String {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if !normalized.pop() {
                    normalized.push(component.as_os_str());
                }
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    let key = normalized.to_string_lossy().replace('/', "\\");
    if windows {
        key.to_ascii_lowercase()
    } else {
        path.to_string_lossy().into_owned()
    }
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
    let is_cmd = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("cmd"));

    #[cfg(target_os = "windows")]
    let mut command = if is_cmd {
        if path.to_string_lossy().contains('"') {
            return Err("Codex command path contains an invalid quote".into());
        }
        let mut command = tokio::process::Command::new("cmd.exe");
        command.args(["/d", "/c"]).arg(path).arg("--version");
        command
    } else {
        let mut command = tokio::process::Command::new(path);
        command.arg("--version");
        command
    };

    #[cfg(not(target_os = "windows"))]
    let mut command = {
        let _ = is_cmd;
        let mut command = tokio::process::Command::new(path);
        command.arg("--version");
        command
    };

    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    command.kill_on_drop(true);
    #[cfg(target_os = "windows")]
    command.as_std_mut().creation_flags(0x0800_0000);
    Ok(command)
}

async fn run_version_command(path: &Path) -> Result<CandidateProcessOutput, String> {
    let mut command = version_command(path)?;
    let child = command
        .spawn()
        .map_err(|error| format!("failed to start candidate: {error}"))?;
    let output = tokio::time::timeout(VALIDATION_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| "candidate version check timed out".to_string())?
        .map_err(|error| format!("candidate version check failed: {error}"))?;

    Ok(CandidateProcessOutput {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
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
    fn command_scripts_are_run_through_a_hidden_noninteractive_cmd_shell() {
        use std::ffi::OsStr;

        let command = version_command(Path::new(r"C:\Program Files\npm\codex.cmd")).unwrap();
        let std_command = command.as_std();
        assert_eq!(std_command.get_program(), OsStr::new("cmd.exe"));
        assert_eq!(
            std_command.get_args().collect::<Vec<_>>(),
            [
                OsStr::new("/d"),
                OsStr::new("/c"),
                OsStr::new(r"C:\Program Files\npm\codex.cmd"),
                OsStr::new("--version"),
            ]
        );
    }

    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn executes_a_cmd_candidate_from_a_path_with_spaces() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("Codex Test Bin");
        std::fs::create_dir(&directory).unwrap();
        let script = directory.join("codex.cmd");
        std::fs::write(&script, "@echo off\r\necho codex-cli 9.8.7\r\n").unwrap();

        let known_good = tokio::process::Command::new("cmd.exe")
            .args(["/d", "/c"])
            .arg(&script)
            .arg("--version")
            .output()
            .await
            .unwrap();
        assert!(
            known_good.status.success(),
            "known-good cmd argv failed: {}",
            String::from_utf8_lossy(&known_good.stderr)
        );

        let output = run_version_command(&script).await.unwrap();
        assert!(output.success, "constructed argv failed: {}", output.stderr);
        assert_eq!(parse_codex_version(&output.stdout), Some("9.8.7".into()));
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
