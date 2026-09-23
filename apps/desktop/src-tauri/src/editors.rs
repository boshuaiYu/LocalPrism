//! External editor discovery and launch.
//!
//! GUI launches (Finder, the Start menu, a `.desktop` file) often have a PATH
//! that does not include `cursor`, `code`, or `codex`. Checking only `which`
//! — or, on macOS, only `/Applications/<Exact Name>.app` — therefore returns
//! an empty list even when the apps are installed. Detection walks the process
//! PATH, the Windows user/machine PATH, and the usual install locations, then
//! launch uses the absolute program or app bundle that was found.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HostOs {
    Macos,
    Windows,
    Linux,
}

#[derive(Clone, Debug)]
struct EditorEnvironment {
    os: HostOs,
    path_dirs: Vec<PathBuf>,
    application_dirs: Vec<PathBuf>,
    local_app_data: Option<PathBuf>,
    roaming_app_data: Option<PathBuf>,
    program_files: Vec<PathBuf>,
    install_prefixes: Vec<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DetectedEditor {
    id: String,
    name: String,
    launch: EditorLaunch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum EditorLaunch {
    /// Executable that accepts a workspace path and an optional `file:line` target.
    Command { program: PathBuf, goto_flag: bool },
    /// macOS app bundle opened with `/usr/bin/open -a`.
    MacApp { app_path: PathBuf, goto_flag: bool },
    /// Codex desktop deep link (`codex://threads/new?path=`).
    CodexDesktop { macos_app: Option<PathBuf> },
    /// Codex CLI opened in the workspace directory.
    CodexCli { program: PathBuf },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LaunchCommand {
    program: PathBuf,
    args: Vec<String>,
    current_dir: Option<PathBuf>,
    hide_console: bool,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
pub struct EditorInfo {
    pub id: String,
    pub name: String,
}

#[tauri::command]
pub fn detect_editors() -> Vec<EditorInfo> {
    detect_installed_editors(&host_environment())
        .into_iter()
        .map(|editor| EditorInfo {
            id: editor.id,
            name: editor.name,
        })
        .collect()
}

#[tauri::command]
pub fn open_in_editor(
    editor_id: String,
    project_path: String,
    file_path: Option<String>,
    line: Option<u32>,
) -> Result<(), String> {
    let editor = detect_installed_editors(&host_environment())
        .into_iter()
        .find(|editor| editor.id == editor_id)
        .ok_or_else(|| format!("Unknown editor: {editor_id}"))?;
    let command = plan_launch(&editor, &project_path, file_path.as_deref(), line)?;
    spawn_launch(&command).map_err(|err| format!("Failed to open {}: {err}", editor.name))
}

fn detect_installed_editors(env: &EditorEnvironment) -> Vec<DetectedEditor> {
    [
        locate_cursor,
        locate_vscode,
        locate_codex,
        locate_zed,
        locate_sublime,
    ]
    .into_iter()
    .filter_map(|locate| locate(env))
    .collect()
}

fn locate_cursor(env: &EditorEnvironment) -> Option<DetectedEditor> {
    locate_standard_editor(
        env,
        "cursor",
        "Cursor",
        "Cursor.app",
        &["Contents/Resources/app/bin/cursor"],
        cursor_binaries(env),
        true,
    )
}

fn locate_vscode(env: &EditorEnvironment) -> Option<DetectedEditor> {
    locate_standard_editor(
        env,
        "vscode",
        "VS Code",
        "Visual Studio Code.app",
        &["Contents/Resources/app/bin/code"],
        vscode_binaries(env),
        true,
    )
}

fn locate_zed(env: &EditorEnvironment) -> Option<DetectedEditor> {
    locate_standard_editor(
        env,
        "zed",
        "Zed",
        "Zed.app",
        &["Contents/MacOS/cli", "Contents/MacOS/zed"],
        zed_binaries(env),
        false,
    )
}

fn locate_sublime(env: &EditorEnvironment) -> Option<DetectedEditor> {
    locate_standard_editor(
        env,
        "sublime",
        "Sublime Text",
        "Sublime Text.app",
        &["Contents/SharedSupport/bin/subl"],
        sublime_binaries(env),
        false,
    )
}

fn locate_standard_editor(
    env: &EditorEnvironment,
    id: &str,
    name: &str,
    macos_app: &str,
    macos_cli_relative: &[&str],
    binaries: Vec<PathBuf>,
    goto_flag: bool,
) -> Option<DetectedEditor> {
    if let Some(app) = first_macos_app(env, macos_app) {
        for relative in macos_cli_relative {
            let cli = join_relative(&app, relative);
            if cli.is_file() {
                return Some(command_editor(id, name, cli, goto_flag));
            }
        }
    }
    if let Some(program) = first_file(binaries) {
        return Some(command_editor(id, name, program, goto_flag));
    }
    first_macos_app(env, macos_app).map(|app| mac_app_editor(id, name, app, goto_flag))
}

fn locate_codex(env: &EditorEnvironment) -> Option<DetectedEditor> {
    if let Some(app) = find_macos_codex_app(env) {
        return Some(codex_desktop(Some(app)));
    }
    if windows_codex_package_installed(env) {
        return Some(codex_desktop(None));
    }
    let program = first_file(codex_cli_candidates(env))?;
    if is_windows_store_codex_alias(&program) {
        return Some(codex_desktop(None));
    }
    Some(DetectedEditor {
        id: "codex".to_string(),
        name: "Codex".to_string(),
        launch: EditorLaunch::CodexCli { program },
    })
}

fn cursor_binaries(env: &EditorEnvironment) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(local) = &env.local_app_data {
        let programs = local.join("Programs");
        paths.push(programs.join("cursor").join("Cursor.exe"));
        paths.push(programs.join("Cursor").join("Cursor.exe"));
        paths.push(local.join("cursor").join("Cursor.exe"));
        paths.push(join_relative(
            &programs.join("cursor"),
            "resources/app/bin/cursor.cmd",
        ));
        paths.push(join_relative(
            &programs.join("Cursor"),
            "resources/app/bin/cursor.cmd",
        ));
    }
    for root in &env.program_files {
        paths.push(root.join("cursor").join("Cursor.exe"));
        paths.push(root.join("Cursor").join("Cursor.exe"));
    }
    paths.extend(prefixed_bins(
        env,
        &["bin/cursor", "share/cursor/cursor", "cursor/cursor"],
    ));
    paths.extend(path_binaries(env, &["cursor"]));
    paths
}

fn vscode_binaries(env: &EditorEnvironment) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let mut roots = Vec::new();
    if let Some(local) = &env.local_app_data {
        roots.push(local.join("Programs").join("Microsoft VS Code"));
    }
    for root in &env.program_files {
        roots.push(root.join("Microsoft VS Code"));
    }
    for root in roots {
        paths.push(root.join("Code.exe"));
        paths.push(root.join("bin").join("code.cmd"));
        paths.push(root.join("bin").join("code"));
    }
    paths.extend(prefixed_bins(
        env,
        &[
            "bin/code",
            "share/code/code",
            "bin/com.visualstudio.code",
            "share/flatpak/exports/bin/com.visualstudio.code",
        ],
    ));
    paths.extend(path_binaries(env, &["code"]));
    paths
}

fn zed_binaries(env: &EditorEnvironment) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(local) = &env.local_app_data {
        paths.push(local.join("Programs").join("Zed").join("Zed.exe"));
    }
    paths.extend(prefixed_bins(env, &["bin/zed"]));
    paths.extend(path_binaries(env, &["zed"]));
    paths
}

fn sublime_binaries(env: &EditorEnvironment) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for root in &env.program_files {
        let dir = root.join("Sublime Text");
        paths.push(dir.join("sublime_text.exe"));
        paths.push(dir.join("subl.exe"));
    }
    if let Some(local) = &env.local_app_data {
        let dir = local.join("Programs").join("Sublime Text");
        paths.push(dir.join("sublime_text.exe"));
        paths.push(dir.join("subl.exe"));
    }
    paths.extend(prefixed_bins(env, &["bin/subl"]));
    paths.extend(path_binaries(env, &["subl", "sublime_text"]));
    paths
}

fn codex_cli_candidates(env: &EditorEnvironment) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(roaming) = &env.roaming_app_data {
        let npm = roaming.join("npm");
        paths.push(npm.join("codex.cmd"));
        paths.push(npm.join("codex.exe"));
        paths.push(npm.join("codex"));
    }
    if let Some(local) = &env.local_app_data {
        for dir in [
            local.join("Programs").join("Codex"),
            local.join("Programs").join("OpenAI Codex"),
            local.join("Programs").join("OpenAI").join("Codex"),
            local.join("Microsoft").join("WindowsApps"),
        ] {
            paths.push(dir.join("codex.exe"));
            paths.push(dir.join("Codex.exe"));
            paths.push(dir.join("codex.cmd"));
            paths.push(dir.join("codex"));
        }
    }
    paths.extend(prefixed_bins(env, &["bin/codex"]));
    paths.extend(path_binaries(env, &["codex"]));
    paths
}

fn find_macos_codex_app(env: &EditorEnvironment) -> Option<PathBuf> {
    if env.os != HostOs::Macos {
        return None;
    }
    for name in ["Codex.app", "ChatGPT.app"] {
        for dir in &env.application_dirs {
            let app = dir.join(name);
            if is_codex_macos_app(&app) {
                return Some(app);
            }
        }
    }
    None
}

/// `Codex.app` is the desktop app. The unified ChatGPT app is Codex only when
/// its bundle id is `com.openai.codex` (classic ChatGPT uses `com.openai.chat`).
fn is_codex_macos_app(app_path: &Path) -> bool {
    if !app_path.is_dir() {
        return false;
    }
    let name = app_path.file_name().and_then(|value| value.to_str());
    match bundle_identifier(app_path) {
        Some(id) => id == "com.openai.codex",
        None => name == Some("Codex.app"),
    }
}

fn bundle_identifier(app_path: &Path) -> Option<String> {
    let plist = app_path.join("Contents").join("Info.plist");
    if !plist.is_file() {
        return None;
    }
    xml_plist_string_value(&plist, "CFBundleIdentifier")
        .or_else(|| plutil_bundle_identifier(&plist))
}

fn xml_plist_string_value(plist: &Path, key: &str) -> Option<String> {
    let text = std::fs::read_to_string(plist).ok()?;
    let needle = format!("<key>{key}</key>");
    let index = text.find(&needle)?;
    let after = &text[index + needle.len()..];
    let start_tag = "<string>";
    let start = after.find(start_tag)? + start_tag.len();
    let end = after[start..].find("</string>")?;
    let value = after[start..start + end].trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn plutil_bundle_identifier(plist: &Path) -> Option<String> {
    let output = Command::new("/usr/bin/plutil")
        .args(["-extract", "CFBundleIdentifier", "raw", "-o", "-"])
        .arg(plist)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let id = String::from_utf8(output.stdout).ok()?;
    let id = id.trim();
    if id.is_empty() {
        None
    } else {
        Some(id.to_string())
    }
}

fn windows_codex_package_installed(env: &EditorEnvironment) -> bool {
    if env.os != HostOs::Windows {
        return false;
    }
    let mut roots = Vec::new();
    for program_files in &env.program_files {
        roots.push(program_files.join("WindowsApps"));
    }
    if let Some(local) = &env.local_app_data {
        roots.push(local.join("Microsoft").join("WindowsApps"));
    }
    for root in roots {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with("OpenAI.Codex_")
            {
                return true;
            }
        }
    }
    false
}

fn is_windows_store_codex_alias(path: &Path) -> bool {
    let text = path
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    text.contains("/windowsapps/") && text.contains("codex")
}

fn command_editor(id: &str, name: &str, program: PathBuf, goto_flag: bool) -> DetectedEditor {
    DetectedEditor {
        id: id.to_string(),
        name: name.to_string(),
        launch: EditorLaunch::Command {
            program: prefer_native_executable(program),
            goto_flag,
        },
    }
}

fn is_batch_script(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .as_deref(),
        Some("cmd" | "bat")
    )
}

/// `CreateProcess` cannot start `.cmd` shims. Prefer the matching GUI
/// executable a few directories above the shim (`cursor.cmd` → `Cursor.exe`).
fn prefer_native_executable(path: PathBuf) -> PathBuf {
    if !is_batch_script(&path) {
        return path;
    }
    let names: &[&str] = match path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(|stem| stem.to_ascii_lowercase())
        .as_deref()
    {
        Some("cursor") => &["Cursor.exe"],
        Some("code") => &["Code.exe"],
        Some("zed") => &["Zed.exe"],
        Some("subl" | "sublime_text") => &["sublime_text.exe", "subl.exe"],
        Some("codex") => &["codex.exe"],
        _ => &[],
    };
    let mut current = path.parent().map(Path::to_path_buf);
    for _ in 0..4 {
        let Some(dir) = current else {
            break;
        };
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return candidate;
            }
        }
        current = dir.parent().map(Path::to_path_buf);
    }
    path
}

fn mac_app_editor(id: &str, name: &str, app_path: PathBuf, goto_flag: bool) -> DetectedEditor {
    DetectedEditor {
        id: id.to_string(),
        name: name.to_string(),
        launch: EditorLaunch::MacApp {
            app_path,
            goto_flag,
        },
    }
}

fn codex_desktop(macos_app: Option<PathBuf>) -> DetectedEditor {
    DetectedEditor {
        id: "codex".to_string(),
        name: "Codex".to_string(),
        launch: EditorLaunch::CodexDesktop { macos_app },
    }
}

fn first_macos_app(env: &EditorEnvironment, name: &str) -> Option<PathBuf> {
    if env.os != HostOs::Macos {
        return None;
    }
    env.application_dirs
        .iter()
        .map(|dir| dir.join(name))
        .find(|path| path.is_dir())
}

fn first_file(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|path| path.is_file())
}

fn prefixed_bins(env: &EditorEnvironment, relative: &[&str]) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for prefix in &env.install_prefixes {
        for rel in relative {
            paths.push(join_relative(prefix, rel));
        }
    }
    paths
}

fn path_binaries(env: &EditorEnvironment, names: &[&str]) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for dir in &env.path_dirs {
        for name in names {
            paths.extend(cli_variants(dir, name, env.os));
        }
    }
    paths
}

fn cli_variants(dir: &Path, name: &str, os: HostOs) -> Vec<PathBuf> {
    if os == HostOs::Windows {
        vec![
            dir.join(format!("{name}.exe")),
            dir.join(format!("{name}.cmd")),
            dir.join(format!("{name}.bat")),
            dir.join(name),
        ]
    } else {
        vec![dir.join(name)]
    }
}

fn join_relative(base: &Path, relative: &str) -> PathBuf {
    let mut path = base.to_path_buf();
    for part in relative.split('/') {
        if !part.is_empty() {
            path.push(part);
        }
    }
    path
}

fn plan_launch(
    editor: &DetectedEditor,
    project_path: &str,
    file_path: Option<&str>,
    line: Option<u32>,
) -> Result<LaunchCommand, String> {
    let (project, file) = resolve_target(project_path, file_path);
    if project.as_os_str().is_empty() && file.is_none() {
        return Err("No path to open".to_string());
    }
    let file_ref = file.as_deref();
    Ok(match &editor.launch {
        EditorLaunch::Command { program, goto_flag } => {
            command_launch(program, *goto_flag, &project, file_ref, line, false)
        }
        EditorLaunch::MacApp {
            app_path,
            goto_flag,
        } => mac_app_launch(app_path, *goto_flag, &project, file_ref, line),
        EditorLaunch::CodexDesktop { macos_app } => {
            let target = file_ref.unwrap_or(&project);
            codex_desktop_launch(macos_app.as_deref(), target)
        }
        EditorLaunch::CodexCli { program } => codex_cli_launch(program, &project, file_ref),
    })
}

fn command_launch(
    program: &Path,
    goto_flag: bool,
    project: &Path,
    file: Option<&Path>,
    line: Option<u32>,
    hide_console: bool,
) -> LaunchCommand {
    let mut args = Vec::new();
    if !project.as_os_str().is_empty() {
        args.push(project.display().to_string());
    }
    if let Some(file) = file {
        if goto_flag {
            args.push("-g".to_string());
        }
        args.push(goto_parameter(file, line));
    }
    script_launch(program, args, None, hide_console)
}

fn script_launch(
    program: &Path,
    args: Vec<String>,
    current_dir: Option<PathBuf>,
    hide_console: bool,
) -> LaunchCommand {
    if is_batch_script(program) {
        let mut wrapped = vec!["/C".to_string(), program.display().to_string()];
        wrapped.extend(args);
        return LaunchCommand {
            program: PathBuf::from("cmd.exe"),
            args: wrapped,
            current_dir,
            hide_console,
        };
    }
    LaunchCommand {
        program: program.to_path_buf(),
        args,
        current_dir,
        hide_console,
    }
}

fn mac_app_launch(
    app_path: &Path,
    goto_flag: bool,
    project: &Path,
    file: Option<&Path>,
    line: Option<u32>,
) -> LaunchCommand {
    let mut args = vec![
        "-a".to_string(),
        app_path.display().to_string(),
        "--args".to_string(),
    ];
    if !project.as_os_str().is_empty() {
        args.push(project.display().to_string());
    }
    if let Some(file) = file {
        if goto_flag {
            args.push("-g".to_string());
        }
        args.push(goto_parameter(file, line));
    }
    LaunchCommand {
        program: PathBuf::from("/usr/bin/open"),
        args,
        current_dir: None,
        hide_console: false,
    }
}

fn codex_desktop_launch(macos_app: Option<&Path>, target: &Path) -> LaunchCommand {
    let url = codex_new_thread_url(target);
    if let Some(app) = macos_app {
        LaunchCommand {
            program: PathBuf::from("/usr/bin/open"),
            args: vec!["-a".to_string(), app.display().to_string(), url],
            current_dir: None,
            hide_console: false,
        }
    } else {
        LaunchCommand {
            program: PathBuf::from("powershell.exe"),
            args: vec![
                "-NoProfile".to_string(),
                "-Command".to_string(),
                "& { param($target) Start-Process -FilePath $target }".to_string(),
                url,
            ],
            current_dir: None,
            hide_console: true,
        }
    }
}

fn codex_cli_launch(program: &Path, project: &Path, file: Option<&Path>) -> LaunchCommand {
    let cwd = if !project.as_os_str().is_empty() {
        Some(project.to_path_buf())
    } else {
        file.and_then(|path| path.parent().map(Path::to_path_buf))
            .or_else(|| file.map(Path::to_path_buf))
    };
    let program = prefer_native_executable(program.to_path_buf());
    script_launch(&program, Vec::new(), cwd, false)
}

fn resolve_target(project_path: &str, file_path: Option<&str>) -> (PathBuf, Option<PathBuf>) {
    let project = PathBuf::from(project_path.trim());
    let file = file_path.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return None;
        }
        let path = PathBuf::from(trimmed);
        Some(if path.is_absolute() || project.as_os_str().is_empty() {
            path
        } else {
            project.join(path)
        })
    });
    (project, file)
}

fn goto_parameter(file: &Path, line: Option<u32>) -> String {
    match line {
        Some(line) if line > 0 => format!("{}:{line}", file.display()),
        _ => file.display().to_string(),
    }
}

fn codex_new_thread_url(path: &Path) -> String {
    format!(
        "codex://threads/new?path={}",
        encode_query_component(&path_for_url(path))
    )
}

fn path_for_url(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        text.into_owned()
    }
}

fn encode_query_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn spawn_launch(command: &LaunchCommand) -> Result<(), String> {
    let mut child = Command::new(&command.program);
    child.args(&command.args);
    if let Some(dir) = &command.current_dir {
        child.current_dir(dir);
    }
    #[cfg(target_os = "windows")]
    if command.hide_console {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        child.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = command.hide_console;
    }
    child.spawn().map(|_| ()).map_err(|err| err.to_string())
}

fn host_environment() -> EditorEnvironment {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let mut path_dirs = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();
    path_dirs.extend(registry_path_dirs());
    path_dirs.extend(well_known_bin_dirs(&home));
    if let Some(scoop) = nonempty_env("SCOOP") {
        path_dirs.push(scoop.join("shims"));
    }
    if let Some(pnpm) = nonempty_env("PNPM_HOME") {
        path_dirs.push(pnpm);
    }
    if let Some(volta) = nonempty_env("VOLTA_HOME") {
        path_dirs.push(volta.join("bin"));
    }

    let local_app_data = nonempty_env("LOCALAPPDATA").or_else(|| {
        if cfg!(target_os = "windows") {
            Some(home.join("AppData").join("Local"))
        } else {
            None
        }
    });
    let roaming_app_data = nonempty_env("APPDATA").or_else(|| {
        if cfg!(target_os = "windows") {
            Some(home.join("AppData").join("Roaming"))
        } else {
            None
        }
    });
    let mut program_files = Vec::new();
    for key in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
        if let Some(path) = nonempty_env(key) {
            program_files.push(path);
        }
    }
    if program_files.is_empty() && cfg!(target_os = "windows") {
        program_files.push(PathBuf::from(r"C:\Program Files"));
        program_files.push(PathBuf::from(r"C:\Program Files (x86)"));
    }

    let application_dirs = if cfg!(target_os = "macos") {
        vec![PathBuf::from("/Applications"), home.join("Applications")]
    } else {
        Vec::new()
    };

    EditorEnvironment {
        os: host_os(),
        path_dirs: dedup_dirs(path_dirs),
        application_dirs,
        local_app_data,
        roaming_app_data,
        program_files,
        install_prefixes: host_install_prefixes(&home),
    }
}

fn host_os() -> HostOs {
    if cfg!(target_os = "macos") {
        HostOs::Macos
    } else if cfg!(target_os = "windows") {
        HostOs::Windows
    } else {
        HostOs::Linux
    }
}

fn host_install_prefixes(home: &Path) -> Vec<PathBuf> {
    vec![
        PathBuf::from("/usr"),
        PathBuf::from("/usr/local"),
        PathBuf::from("/opt"),
        PathBuf::from("/opt/homebrew"),
        PathBuf::from("/snap"),
        PathBuf::from("/var/lib/flatpak/exports"),
        home.join(".local"),
    ]
}

fn well_known_bin_dirs(home: &Path) -> Vec<PathBuf> {
    vec![
        home.join(".local").join("bin"),
        home.join("bin"),
        home.join(".npm-global").join("bin"),
        home.join(".volta").join("bin"),
        home.join(".local").join("share").join("pnpm"),
        home.join("scoop").join("shims"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/snap/bin"),
    ]
}

fn nonempty_env(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn dedup_dirs(dirs: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut unique = Vec::new();
    for dir in dirs {
        let key = dir.to_string_lossy().to_ascii_lowercase();
        if seen.insert(key) {
            unique.push(dir);
        }
    }
    unique
}

fn registry_path_dirs() -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        windows_registry_path_dirs()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Vec::new()
    }
}

#[cfg(target_os = "windows")]
fn windows_registry_path_dirs() -> Vec<PathBuf> {
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
            std::env::split_paths(&expanded).collect::<Vec<_>>()
        })
        .collect()
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

#[cfg(test)]
mod tests {
    use super::{
        codex_new_thread_url, detect_installed_editors, encode_query_component, plan_launch,
        EditorEnvironment, EditorLaunch, HostOs,
    };
    use std::fs;
    use std::path::{Path, PathBuf};

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, b"#!/bin/sh\n").unwrap();
    }

    fn env_at(root: &Path, os: HostOs) -> EditorEnvironment {
        EditorEnvironment {
            os,
            path_dirs: Vec::new(),
            application_dirs: Vec::new(),
            local_app_data: Some(root.join("Local")),
            roaming_app_data: Some(root.join("Roaming")),
            program_files: vec![root.join("ProgramFiles")],
            install_prefixes: vec![root.join("prefix")],
        }
    }

    fn ids(env: &EditorEnvironment) -> Vec<String> {
        detect_installed_editors(env)
            .into_iter()
            .map(|editor| editor.id)
            .collect()
    }

    fn write_bundle(app: &Path, bundle_id: &str) {
        let contents = app.join("Contents");
        fs::create_dir_all(&contents).unwrap();
        fs::write(
            contents.join("Info.plist"),
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>{bundle_id}</string></dict></plist>"#
            ),
        )
        .unwrap();
    }

    #[test]
    fn omits_editors_that_are_not_installed() {
        let dir = tempfile::tempdir().unwrap();
        let env = env_at(dir.path(), HostOs::Linux);
        assert!(detect_installed_editors(&env).is_empty());
    }

    #[test]
    fn macos_user_applications_cursor_is_detected_without_a_system_app() {
        let dir = tempfile::tempdir().unwrap();
        let user_apps = dir.path().join("home/Applications");
        let system_apps = dir.path().join("Applications");
        fs::create_dir_all(user_apps.join("Cursor.app/Contents")).unwrap();
        fs::create_dir_all(&system_apps).unwrap();
        let mut env = env_at(dir.path(), HostOs::Macos);
        env.application_dirs = vec![system_apps, user_apps];

        let found = detect_installed_editors(&env);
        assert_eq!(
            found
                .iter()
                .map(|editor| editor.id.as_str())
                .collect::<Vec<_>>(),
            vec!["cursor"]
        );
        assert!(matches!(
            found[0].launch,
            EditorLaunch::MacApp {
                goto_flag: true,
                ..
            }
        ));
    }

    #[test]
    fn macos_cli_is_detected_when_the_app_bundle_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        touch(&bin.join("code"));
        let mut env = env_at(dir.path(), HostOs::Macos);
        env.application_dirs = vec![dir.path().join("Applications")];
        env.path_dirs = vec![bin.clone()];

        let found = detect_installed_editors(&env);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "vscode");
        assert_eq!(
            found[0].launch,
            EditorLaunch::Command {
                program: bin.join("code"),
                goto_flag: true,
            }
        );
    }

    #[test]
    fn windows_install_directories_are_detected_outside_path() {
        let dir = tempfile::tempdir().unwrap();
        let env = env_at(dir.path(), HostOs::Windows);
        let cursor = env
            .local_app_data
            .as_ref()
            .unwrap()
            .join("Programs/cursor/Cursor.exe");
        let code = env.program_files[0].join("Microsoft VS Code/Code.exe");
        touch(&cursor);
        touch(&code);

        let found = detect_installed_editors(&env);
        assert_eq!(
            found
                .iter()
                .map(|editor| editor.id.as_str())
                .collect::<Vec<_>>(),
            vec!["cursor", "vscode"]
        );
        assert_eq!(
            found[0].launch,
            EditorLaunch::Command {
                program: cursor,
                goto_flag: true,
            }
        );
        assert_eq!(
            found[1].launch,
            EditorLaunch::Command {
                program: code,
                goto_flag: true,
            }
        );
    }

    #[test]
    fn linux_prefix_and_path_shims_list_cursor_vscode_and_codex_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let mut env = env_at(dir.path(), HostOs::Linux);
        touch(&env.install_prefixes[0].join("bin/cursor"));
        touch(&env.install_prefixes[0].join("share/code/code"));
        let codex = dir.path().join("home/.local/bin/codex");
        touch(&codex);
        env.path_dirs = vec![codex.parent().unwrap().to_path_buf()];

        assert_eq!(ids(&env), vec!["cursor", "vscode", "codex"]);
    }

    #[test]
    fn chatgpt_app_counts_as_codex_only_with_the_codex_bundle_id() {
        let dir = tempfile::tempdir().unwrap();
        let apps = dir.path().join("Applications");
        write_bundle(&apps.join("ChatGPT.app"), "com.openai.chat");
        let mut env = env_at(dir.path(), HostOs::Macos);
        env.application_dirs = vec![apps.clone()];
        assert!(ids(&env).is_empty());

        write_bundle(&apps.join("ChatGPT.app"), "com.openai.codex");
        let found = detect_installed_editors(&env);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "codex");
        assert_eq!(
            found[0].launch,
            EditorLaunch::CodexDesktop {
                macos_app: Some(apps.join("ChatGPT.app")),
            }
        );
    }

    #[test]
    fn codex_app_name_is_detected_and_preferred_over_the_cli() {
        let dir = tempfile::tempdir().unwrap();
        let apps = dir.path().join("user-applications");
        let app = apps.join("Codex.app");
        fs::create_dir_all(app.join("Contents")).unwrap();
        let cli = dir.path().join("bin/codex");
        touch(&cli);
        let mut env = env_at(dir.path(), HostOs::Macos);
        env.application_dirs = vec![apps];
        env.path_dirs = vec![cli.parent().unwrap().to_path_buf()];

        let found = detect_installed_editors(&env);
        assert_eq!(
            found[0].launch,
            EditorLaunch::CodexDesktop {
                macos_app: Some(app),
            }
        );
    }

    #[test]
    fn windows_store_package_is_codex_desktop_not_the_cli() {
        let dir = tempfile::tempdir().unwrap();
        let mut env = env_at(dir.path(), HostOs::Windows);
        let package = env.program_files[0].join("WindowsApps/OpenAI.Codex_1.2.3.0_x64__app");
        fs::create_dir_all(&package).unwrap();
        let cli = dir.path().join("npm/codex.cmd");
        touch(&cli);
        env.path_dirs = vec![cli.parent().unwrap().to_path_buf()];

        let found = detect_installed_editors(&env);
        assert_eq!(
            found[0].launch,
            EditorLaunch::CodexDesktop { macos_app: None }
        );
        let command = plan_launch(&found[0], r"C:\work\paper", Some("main.tex"), None).unwrap();
        let file = PathBuf::from(r"C:\work\paper").join("main.tex");
        assert_eq!(command.program, PathBuf::from("powershell.exe"));
        assert!(command.hide_console);
        assert_eq!(
            command.args.last().map(String::as_str),
            Some(codex_new_thread_url(&file).as_str())
        );
    }

    #[test]
    fn windows_cmd_shim_resolves_to_the_gui_executable() {
        let dir = tempfile::tempdir().unwrap();
        let mut env = env_at(dir.path(), HostOs::Windows);
        env.local_app_data = None;
        env.program_files.clear();
        let root = dir.path().join("CursorInstall");
        let exe = root.join("Cursor.exe");
        let shim = root.join("resources/app/bin/cursor.cmd");
        touch(&exe);
        touch(&shim);
        env.path_dirs = vec![shim.parent().unwrap().to_path_buf()];

        let found = detect_installed_editors(&env);
        assert_eq!(
            found[0].launch,
            EditorLaunch::Command {
                program: exe,
                goto_flag: true,
            }
        );
    }

    #[test]
    fn codex_cmd_shim_does_not_bind_to_a_nearby_cursor_executable() {
        let dir = tempfile::tempdir().unwrap();
        let mut env = env_at(dir.path(), HostOs::Windows);
        env.local_app_data = None;
        env.program_files.clear();
        let root = dir.path().join("tools");
        let cursor = root.join("Cursor.exe");
        let shim = root.join("bin/codex.cmd");
        touch(&cursor);
        touch(&shim);
        env.path_dirs = vec![shim.parent().unwrap().to_path_buf()];

        let found = detect_installed_editors(&env);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "codex");
        let command = plan_launch(&found[0], r"C:\work", None, None).unwrap();
        assert_eq!(command.program, PathBuf::from("cmd.exe"));
        assert_eq!(
            command.args,
            vec!["/C".to_string(), shim.display().to_string()]
        );
    }

    #[test]
    fn windows_cmd_shim_without_an_executable_launches_through_cmd() {
        let dir = tempfile::tempdir().unwrap();
        let mut env = env_at(dir.path(), HostOs::Windows);
        env.local_app_data = None;
        env.program_files.clear();
        let shim = dir.path().join("bin/code.cmd");
        touch(&shim);
        env.path_dirs = vec![shim.parent().unwrap().to_path_buf()];
        let editor = detect_installed_editors(&env).remove(0);
        let command = plan_launch(&editor, r"C:\work", Some("main.tex"), Some(8)).unwrap();
        assert_eq!(command.program, PathBuf::from("cmd.exe"));
        assert_eq!(command.args[0], "/C");
        assert_eq!(command.args[1], shim.display().to_string());
        assert_eq!(
            command.args[2],
            PathBuf::from(r"C:\work").display().to_string()
        );
        assert_eq!(command.args[3], "-g");
    }

    #[test]
    fn cursor_launch_opens_the_project_and_the_file_at_the_current_line() {
        let editor = detect_one_command("/usr/bin/cursor");
        let command = plan_launch(&editor, "/work/paper", Some("main.tex"), Some(12)).unwrap();
        let file = PathBuf::from("/work/paper").join("main.tex");
        assert_eq!(command.program, PathBuf::from("/usr/bin/cursor"));
        assert_eq!(
            command.args,
            vec![
                PathBuf::from("/work/paper").display().to_string(),
                "-g".to_string(),
                format!("{}:12", file.display()),
            ]
        );
    }

    #[test]
    fn launch_prefers_an_absolute_file_when_the_project_is_missing() {
        let editor = detect_one_command("/usr/bin/code");
        let command = plan_launch(&editor, "  ", Some("/work/paper/main.tex"), None).unwrap();
        let file = PathBuf::from("/work/paper/main.tex");
        assert_eq!(
            command.args,
            vec!["-g".to_string(), file.display().to_string()]
        );
    }

    #[test]
    fn codex_desktop_launch_encodes_the_file_path() {
        let dir = tempfile::tempdir().unwrap();
        let apps = dir.path().join("Applications");
        let app = apps.join("Codex.app");
        fs::create_dir_all(app.join("Contents")).unwrap();
        let mut env = env_at(dir.path(), HostOs::Macos);
        env.application_dirs = vec![apps];
        let editor = detect_installed_editors(&env).remove(0);
        let command =
            plan_launch(&editor, "/work/paper", Some("sections/intro.tex"), Some(4)).unwrap();
        let file = PathBuf::from("/work/paper").join("sections/intro.tex");
        assert_eq!(command.program, PathBuf::from("/usr/bin/open"));
        assert_eq!(
            command.args,
            vec![
                "-a".to_string(),
                app.display().to_string(),
                codex_new_thread_url(&file),
            ]
        );
    }

    #[test]
    fn codex_cli_launch_uses_the_project_directory() {
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("prefix/bin/codex");
        touch(&cli);
        let env = env_at(dir.path(), HostOs::Linux);
        let editor = detect_installed_editors(&env).remove(0);
        let command = plan_launch(&editor, "/work/paper", Some("main.tex"), Some(3)).unwrap();
        assert_eq!(command.program, cli);
        assert!(command.args.is_empty());
        assert_eq!(command.current_dir, Some(PathBuf::from("/work/paper")));
    }

    #[test]
    fn query_encoding_escapes_reserved_characters() {
        assert_eq!(
            encode_query_component("/tmp/my paper/#1.tex"),
            "%2Ftmp%2Fmy%20paper%2F%231.tex"
        );
        assert_eq!(
            encode_query_component(r"C:\Users\a b\paper.tex"),
            "C%3A%5CUsers%5Ca%20b%5Cpaper.tex"
        );
    }

    fn detect_one_command(program: &str) -> super::DetectedEditor {
        super::command_editor("cursor", "Cursor", PathBuf::from(program), true)
    }
}
