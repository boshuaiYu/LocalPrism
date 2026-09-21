use std::path::{Path, PathBuf};
use tauri::{Emitter, WebviewWindow};
use tokio::io::{AsyncBufReadExt, BufReader};

/// Windows CREATE_NO_WINDOW flag to prevent console windows from flashing
/// when spawning child processes (e.g. uv, powershell, python).
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// LocalPrism-owned uv layout under `{LOCALPRISM_HOME}/uv/`.
/// Windows default: `%APPDATA%/LocalPrism/uv/`.
#[derive(Debug, Clone)]
pub(crate) struct UvLayout {
    pub root: PathBuf,
    pub bin: PathBuf,
    pub cache: PathBuf,
    pub python: PathBuf,
    pub python_bin: PathBuf,
    pub tools: PathBuf,
    pub tool_bin: PathBuf,
}

impl UvLayout {
    fn resolve() -> Result<Self, String> {
        let root = crate::providers::paths::localprism_home()?.join("uv");
        Ok(Self {
            bin: root.join("bin"),
            cache: root.join("cache"),
            python: root.join("python"),
            python_bin: root.join("python-bin"),
            tools: root.join("tools"),
            tool_bin: root.join("tool-bin"),
            root,
        })
    }

    fn create_dirs(&self) -> Result<(), String> {
        for dir in [
            &self.root,
            &self.bin,
            &self.cache,
            &self.python,
            &self.python_bin,
            &self.tools,
            &self.tool_bin,
        ] {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;
        }
        Ok(())
    }

    fn env_pairs(&self) -> Vec<(&'static str, String)> {
        vec![
            ("UV_CACHE_DIR", self.cache.to_string_lossy().into_owned()),
            (
                "UV_PYTHON_INSTALL_DIR",
                self.python.to_string_lossy().into_owned(),
            ),
            (
                "UV_PYTHON_BIN_DIR",
                self.python_bin.to_string_lossy().into_owned(),
            ),
            ("UV_TOOL_DIR", self.tools.to_string_lossy().into_owned()),
            (
                "UV_TOOL_BIN_DIR",
                self.tool_bin.to_string_lossy().into_owned(),
            ),
            ("UV_INSTALL_DIR", self.bin.to_string_lossy().into_owned()),
        ]
    }

    fn path_dirs(&self) -> [&Path; 2] {
        [&self.bin, &self.tool_bin]
    }

    fn binary_path(&self) -> PathBuf {
        #[cfg(windows)]
        {
            self.bin.join("uv.exe")
        }
        #[cfg(not(windows))]
        {
            self.bin.join("uv")
        }
    }
}

pub(crate) fn ensure_uv_layout() -> Result<UvLayout, String> {
    let layout = UvLayout::resolve()?;
    layout.create_dirs()?;
    Ok(layout)
}

pub(crate) fn apply_uv_isolation_env_std(cmd: &mut std::process::Command) {
    let Ok(layout) = ensure_uv_layout() else {
        return;
    };
    for (key, value) in layout.env_pairs() {
        cmd.env(key, value);
    }
}

pub(crate) fn apply_uv_isolation_env(cmd: &mut tokio::process::Command) {
    apply_uv_isolation_env_std(cmd.as_std_mut());
}

pub(crate) fn isolated_uv_path(current: &str) -> String {
    prepend_uv_path_dirs(current.to_string())
}

fn path_sep() -> &'static str {
    #[cfg(windows)]
    {
        ";"
    }
    #[cfg(not(windows))]
    {
        ":"
    }
}

fn prepend_uv_path_dirs(current: String) -> String {
    let Ok(layout) = UvLayout::resolve() else {
        return current;
    };
    let sep = path_sep();
    let mut path = current;
    for dir in layout.path_dirs().iter().rev() {
        let dir_str = dir.to_string_lossy();
        if !path.split(sep).any(|part| part == dir_str.as_ref()) {
            path = format!("{dir_str}{sep}{path}");
        }
    }
    path
}

fn apply_uv_runtime_env(cmd: &mut tokio::process::Command, venv_dir: Option<&Path>) {
    apply_uv_isolation_env(cmd);
    match venv_dir {
        Some(venv) => {
            cmd.env("VIRTUAL_ENV", venv);
            cmd.env("UV_PROJECT_ENVIRONMENT", venv);
            cmd.env("PYTHONNOUSERSITE", "1");
            cmd.env("PATH", path_with_venv(venv));
        }
        None => {
            cmd.env_remove("VIRTUAL_ENV");
            cmd.env_remove("UV_PROJECT_ENVIRONMENT");
            let path = isolated_uv_path(&std::env::var("PATH").unwrap_or_default());
            cmd.env("PATH", path);
        }
    }
}

// ─── Binary Discovery ───

/// Discover the uv binary. Prefers the LocalPrism-owned install, then PATH.
fn find_uv_binary() -> Result<String, String> {
    if let Ok(layout) = UvLayout::resolve() {
        let managed = layout.binary_path();
        if managed.exists() {
            return Ok(managed.to_string_lossy().to_string());
        }
    }

    // Fall back to a user-global uv; UV_* env still redirects its writes.
    if let Ok(path) = which::which("uv") {
        return Ok(path.to_string_lossy().to_string());
    }

    // 2. Check user-specific paths
    if let Some(home) = dirs::home_dir() {
        #[cfg(not(target_os = "windows"))]
        let user_paths = vec![
            home.join(".cargo").join("bin").join("uv"),
            home.join(".local").join("bin").join("uv"),
        ];
        #[cfg(target_os = "windows")]
        let user_paths = vec![
            // uv's default install location (same as Claude Code)
            home.join(".local").join("bin").join("uv.exe"),
            home.join(".cargo").join("bin").join("uv.exe"),
            // %LOCALAPPDATA%\uv\bin\uv.exe
            PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_else(|_| {
                home.join("AppData")
                    .join("Local")
                    .to_string_lossy()
                    .to_string()
            }))
            .join("uv")
            .join("bin")
            .join("uv.exe"),
        ];

        for path in &user_paths {
            if path.exists() {
                return Ok(path.to_string_lossy().to_string());
            }
        }
    }

    // 3. Check standard paths (Unix only)
    #[cfg(not(target_os = "windows"))]
    {
        let standard_paths = ["/usr/local/bin/uv", "/opt/homebrew/bin/uv", "/usr/bin/uv"];
        for path in &standard_paths {
            if PathBuf::from(path).exists() {
                return Ok(path.to_string());
            }
        }
    }

    // 4. Bare fallback — hope it's in PATH
    Ok("uv".to_string())
}

// ─── Status Types ───

#[derive(serde::Serialize)]
pub struct UvStatus {
    pub installed: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
}

#[derive(serde::Serialize)]
pub struct VenvInfo {
    pub venv_path: String,
    pub python_path: String,
    pub created: bool,
}

#[derive(serde::Serialize)]
pub struct UvCommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

// ─── Helper: build PATH with venv bin prepended ───

fn venv_bin_dir(venv_dir: &std::path::Path) -> PathBuf {
    #[cfg(not(target_os = "windows"))]
    {
        venv_dir.join("bin")
    }
    #[cfg(target_os = "windows")]
    {
        venv_dir.join("Scripts")
    }
}

fn venv_python(venv_dir: &std::path::Path) -> PathBuf {
    #[cfg(not(target_os = "windows"))]
    {
        venv_bin_dir(venv_dir).join("python")
    }
    #[cfg(target_os = "windows")]
    {
        venv_bin_dir(venv_dir).join("python.exe")
    }
}

fn venv_pip(venv_dir: &std::path::Path) -> PathBuf {
    #[cfg(not(target_os = "windows"))]
    {
        venv_bin_dir(venv_dir).join("pip")
    }
    #[cfg(target_os = "windows")]
    {
        venv_bin_dir(venv_dir).join("pip.exe")
    }
}

fn venv_pip_shim(venv_dir: &std::path::Path) -> PathBuf {
    #[cfg(not(target_os = "windows"))]
    {
        venv_bin_dir(venv_dir).join("pip")
    }
    #[cfg(target_os = "windows")]
    {
        venv_bin_dir(venv_dir).join("pip.cmd")
    }
}

fn path_with_venv(venv_dir: &std::path::Path) -> String {
    let bin = venv_bin_dir(venv_dir);
    let current = isolated_uv_path(&std::env::var("PATH").unwrap_or_default());
    format!("{}{}{}", bin.to_string_lossy(), path_sep(), current)
}

fn write_pip_shim(venv_dir: &Path) -> Result<(), String> {
    let uv_bin = find_uv_binary().unwrap_or_else(|_| "uv".to_string());
    let shim_path = venv_pip_shim(venv_dir);
    let uv_env = UvLayout::resolve()
        .ok()
        .map(|layout| layout.env_pairs())
        .unwrap_or_default();

    #[cfg(target_os = "windows")]
    {
        let mut content = format!(
            "@echo off\r\nset \"VIRTUAL_ENV={}\"\r\n",
            venv_dir.to_string_lossy()
        );
        for (key, value) in &uv_env {
            content.push_str(&format!("set \"{key}={value}\"\r\n"));
        }
        content.push_str(&format!("\"{uv_bin}\" pip %*\r\n"));
        std::fs::write(&shim_path, &content)
            .map_err(|e| format!("Failed to create pip shim: {}", e))?;
        let pip3_path = venv_bin_dir(venv_dir).join("pip3.cmd");
        let _ = std::fs::write(pip3_path, content);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut content = format!(
            "#!/bin/sh\nVIRTUAL_ENV=\"{}\"\n",
            venv_dir.to_string_lossy()
        );
        for (key, value) in &uv_env {
            content.push_str(&format!("export {key}=\"{value}\"\n"));
        }
        content.push_str(&format!("exec \"{uv_bin}\" pip \"$@\"\n"));
        std::fs::write(&shim_path, content)
            .map_err(|e| format!("Failed to create pip shim: {}", e))?;
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&shim_path)
            .map_err(|e| format!("Failed to stat pip shim: {}", e))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&shim_path, perms)
            .map_err(|e| format!("Failed to mark pip shim executable: {}", e))?;
    }

    Ok(())
}

async fn ensure_venv_pip(venv_dir: &Path) -> Result<(), String> {
    if venv_pip(venv_dir).exists() || venv_pip_shim(venv_dir).exists() {
        return Ok(());
    }

    let python = venv_python(venv_dir);
    if !python.exists() {
        return Err(format!(
            "Project .venv is missing Python at {}",
            python.display()
        ));
    }

    let mut ensure_cmd = tokio::process::Command::new(&python);
    ensure_cmd.args(["-m", "ensurepip", "--upgrade"]);
    apply_uv_runtime_env(&mut ensure_cmd, Some(venv_dir));
    #[cfg(target_os = "windows")]
    {
        ensure_cmd.creation_flags(CREATE_NO_WINDOW);
    }

    match ensure_cmd.output().await {
        Ok(output) if output.status.success() && venv_pip(venv_dir).exists() => Ok(()),
        _ => write_pip_shim(venv_dir),
    }
}

// ─── Tauri Commands ───

#[tauri::command]
pub async fn check_uv_status() -> Result<UvStatus, String> {
    let binary_path = match find_uv_binary() {
        Ok(path) => path,
        Err(_) => {
            return Ok(UvStatus {
                installed: false,
                binary_path: None,
                version: None,
            });
        }
    };

    // Verify binary actually works by running --version
    let mut version_cmd = std::process::Command::new(&binary_path);
    version_cmd.arg("--version");
    #[cfg(target_os = "windows")]
    {
        version_cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let version_output = version_cmd.output();

    let version = match version_output {
        Ok(output) if output.status.success() => {
            Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
        }
        _ => {
            return Ok(UvStatus {
                installed: false,
                binary_path: None,
                version: None,
            });
        }
    };

    Ok(UvStatus {
        installed: true,
        binary_path: Some(binary_path),
        version,
    })
}

#[tauri::command]
pub async fn install_uv(window: WebviewWindow) -> Result<(), String> {
    let layout = ensure_uv_layout()?;

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("bash");
        c.args(["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"]);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = tokio::process::Command::new("powershell");
        c.creation_flags(CREATE_NO_WINDOW);
        c.args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "irm https://astral.sh/uv/install.ps1 | iex",
        ]);
        c
    };

    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    // Inherit essential environment variables (shared helper handles case-insensitive matching)
    for (key, value) in std::env::vars() {
        if key.eq_ignore_ascii_case("PATH") || crate::claude::is_essential_env_var(&key) {
            cmd.env(&key, &value);
        }
    }
    crate::claude::apply_proxy_env_to_command(&mut cmd, Some(&window));
    apply_uv_runtime_env(&mut cmd, None);
    cmd.env("UV_UNMANAGED_INSTALL", &layout.bin);
    cmd.env("UV_NO_MODIFY_PATH", "1");
    cmd.env("INSTALLER_NO_MODIFY_PATH", "1");

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to run uv installer: {}", e))?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let stdout_reader = BufReader::new(stdout);
    let stderr_reader = BufReader::new(stderr);

    // Stream stdout
    let win_stdout = window.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = stdout_reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = win_stdout.emit("uv-install-output", &line);
        }
    });

    // Stream stderr
    let win_stderr = window.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = stderr_reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = win_stderr.emit("uv-install-output", &line);
        }
    });

    // Wait for completion
    let win_complete = window;
    tokio::spawn(async move {
        let _ = stdout_task.await;
        let _ = stderr_task.await;

        let success = match child.wait().await {
            Ok(status) => status.success(),
            Err(_) => false,
        };

        let _ = win_complete.emit("uv-install-complete", success);
    });

    Ok(())
}

#[tauri::command]
pub async fn setup_project_venv(project_path: String) -> Result<VenvInfo, String> {
    let project = std::path::Path::new(&project_path);
    let venv_dir = project.join(".venv");

    // If venv already exists, just return info
    if venv_dir.exists() {
        ensure_venv_pip(&venv_dir).await?;
        let python = venv_python(&venv_dir);
        return Ok(VenvInfo {
            venv_path: venv_dir.to_string_lossy().to_string(),
            python_path: python.to_string_lossy().to_string(),
            created: false,
        });
    }

    let uv_bin = find_uv_binary().map_err(|e| format!("uv not found: {}", e))?;

    // Create venv: uv venv <project_path>/.venv
    let mut venv_cmd = tokio::process::Command::new(&uv_bin);
    let venv_arg = venv_dir.to_string_lossy().to_string();
    venv_cmd.args(["venv", "--seed", venv_arg.as_str()]);
    venv_cmd.current_dir(project);
    apply_uv_runtime_env(&mut venv_cmd, None);
    #[cfg(target_os = "windows")]
    {
        venv_cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = venv_cmd
        .output()
        .await
        .map_err(|e| format!("Failed to create venv: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("uv venv failed: {}", stderr));
    }

    let python = venv_python(&venv_dir);
    ensure_venv_pip(&venv_dir).await?;

    Ok(VenvInfo {
        venv_path: venv_dir.to_string_lossy().to_string(),
        python_path: python.to_string_lossy().to_string(),
        created: true,
    })
}

#[tauri::command]
pub async fn uv_add_packages(
    packages: Vec<String>,
    project_path: String,
) -> Result<String, String> {
    let uv_bin = find_uv_binary().map_err(|e| format!("uv not found: {}", e))?;
    let venv_dir = std::path::Path::new(&project_path).join(".venv");

    if !venv_dir.exists() {
        return Err("No .venv found. Run setup_project_venv first.".to_string());
    }

    let mut args = vec!["pip".to_string(), "install".to_string()];
    args.extend(packages);

    let mut pip_cmd = tokio::process::Command::new(&uv_bin);
    pip_cmd.args(&args);
    pip_cmd.current_dir(&project_path);
    apply_uv_runtime_env(&mut pip_cmd, Some(&venv_dir));
    #[cfg(target_os = "windows")]
    {
        pip_cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = pip_cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run uv pip install: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("uv pip install failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    Ok(stdout)
}

#[tauri::command]
pub async fn uv_run_command(
    command: String,
    project_path: String,
) -> Result<UvCommandResult, String> {
    let venv_dir = std::path::Path::new(&project_path).join(".venv");

    if !venv_dir.exists() {
        return Err("No .venv found. Run setup_project_venv first.".to_string());
    }

    // Split command into program + args
    let parts: Vec<&str> = command.split_whitespace().collect();
    if parts.is_empty() {
        return Err("Empty command".to_string());
    }

    let program = parts.first().ok_or("Empty command")?;
    let args = parts.get(1..).unwrap_or_default();

    let mut run_cmd = tokio::process::Command::new(program);
    run_cmd.args(args);
    run_cmd.current_dir(&project_path);
    apply_uv_runtime_env(&mut run_cmd, Some(&venv_dir));
    run_cmd.env("PIP_REQUIRE_VIRTUALENV", "true");
    #[cfg(target_os = "windows")]
    {
        run_cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = run_cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run command: {}", e))?;

    let exit_code = output.status.code().unwrap_or(-1);

    Ok(UvCommandResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use tempfile::TempDir;

    fn restore_env(key: &str, previous: Option<String>) {
        match previous {
            Some(value) => std::env::set_var(key, value),
            None => std::env::remove_var(key),
        }
    }

    fn with_temp_home<T>(run: impl FnOnce(&Path) -> T) -> T {
        let _guard = crate::providers::paths::lock_provider_env();
        let dir = TempDir::new().unwrap();
        let previous = std::env::var("LOCALPRISM_HOME").ok();
        std::env::set_var("LOCALPRISM_HOME", dir.path());
        let result = run(dir.path());
        restore_env("LOCALPRISM_HOME", previous);
        result
    }

    fn env_value(cmd: &std::process::Command, key: &str) -> Option<String> {
        cmd.get_envs()
            .find(|(name, _)| name.eq(&OsStr::new(key)))
            .and_then(|(_, value)| value.map(|value| value.to_string_lossy().into_owned()))
    }

    #[test]
    fn uv_layout_lives_under_localprism_home() {
        with_temp_home(|home| {
            let layout = ensure_uv_layout().unwrap();
            assert_eq!(layout.root, home.join("uv"));
            assert_eq!(layout.bin, home.join("uv").join("bin"));
            assert_eq!(layout.cache, home.join("uv").join("cache"));
            assert_eq!(layout.python, home.join("uv").join("python"));
            assert_eq!(layout.python_bin, home.join("uv").join("python-bin"));
            assert_eq!(layout.tools, home.join("uv").join("tools"));
            assert_eq!(layout.tool_bin, home.join("uv").join("tool-bin"));
            assert!(layout.bin.is_dir());
            assert!(layout.cache.is_dir());
            assert!(layout.python.is_dir());
            assert!(layout.python_bin.is_dir());
            assert!(layout.tools.is_dir());
            assert!(layout.tool_bin.is_dir());
        });
    }

    #[test]
    fn isolation_env_stays_inside_localprism_uv() {
        with_temp_home(|home| {
            let layout = ensure_uv_layout().unwrap();
            let pairs = layout.env_pairs();
            let keys: Vec<_> = pairs.iter().map(|(key, _)| *key).collect();
            assert_eq!(
                keys,
                [
                    "UV_CACHE_DIR",
                    "UV_PYTHON_INSTALL_DIR",
                    "UV_PYTHON_BIN_DIR",
                    "UV_TOOL_DIR",
                    "UV_TOOL_BIN_DIR",
                    "UV_INSTALL_DIR",
                ]
            );
            for (key, value) in pairs {
                let path = PathBuf::from(value);
                assert!(
                    path.starts_with(home.join("uv")),
                    "{key} escaped LocalPrism home: {}",
                    path.display()
                );
            }
        });
    }

    #[test]
    fn find_uv_binary_prefers_localprism_install() {
        with_temp_home(|home| {
            let layout = ensure_uv_layout().unwrap();
            std::fs::write(layout.binary_path(), []).unwrap();
            assert_eq!(
                find_uv_binary().unwrap(),
                layout.binary_path().to_string_lossy()
            );
            assert!(find_uv_binary()
                .unwrap()
                .starts_with(&home.join("uv").join("bin").to_string_lossy().to_string()));
        });
    }

    #[test]
    fn isolation_env_does_not_pin_project_venv() {
        with_temp_home(|_| {
            let layout = ensure_uv_layout().unwrap();
            assert!(layout
                .env_pairs()
                .iter()
                .all(|(key, _)| *key != "UV_PROJECT_ENVIRONMENT" && *key != "VIRTUAL_ENV"));
        });
    }

    #[test]
    fn apply_isolation_sets_uv_cache_dir() {
        with_temp_home(|home| {
            let mut cmd = std::process::Command::new("uv");
            apply_uv_isolation_env_std(&mut cmd);
            assert_eq!(
                env_value(&cmd, "UV_CACHE_DIR").as_deref(),
                Some(home.join("uv").join("cache").to_string_lossy().as_ref())
            );
            assert_eq!(
                env_value(&cmd, "UV_PYTHON_INSTALL_DIR").as_deref(),
                Some(home.join("uv").join("python").to_string_lossy().as_ref())
            );
        });
    }
}
