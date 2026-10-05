use std::path::{Path, PathBuf};

/// User-facing skill folder inside isolated Claude home (`D:\LocalPrism\claude-home\skills`).
pub const USER_SKILLS_DIRNAME: &str = "skills";
/// User-facing subagent folder inside isolated Claude home (`D:\LocalPrism\claude-home\agents`).
pub const USER_AGENTS_DIRNAME: &str = "agents";
/// User-facing slash-command folder inside isolated Claude home (`D:\LocalPrism\claude-home\slash`).
pub const USER_SLASH_DIRNAME: &str = "slash";
/// Pre-rename skill folder. Migrated into `claude-home/skills`.
pub const USER_SKILLS_LEGACY_DIRNAME: &str = ".skills";
/// Pre-rename subagent folder. Migrated into `claude-home/agents`.
pub const USER_AGENTS_LEGACY_DIRNAME: &str = ".agents";
/// Isolated Claude CLI config directory under LocalPrism home.
pub const CLAUDE_HOME_DIRNAME: &str = "claude-home";

const WRITABLE_PROBE_NAME: &str = ".localprism-writable";

/// App-owned data root.
///
/// `LOCALPRISM_HOME`, when set and non-empty, wins on every platform.
///
/// On Windows, a writable install folder (the directory containing
/// `LocalPrism.exe`) is the data home. A portable copy such as `D:\LocalPrism`
/// keeps claude-home, providers, and uv beside the executable. Program Files
/// and cargo `target/` builds are skipped and fall back to `%APPDATA%\LocalPrism`.
///
/// On macOS, Linux, and other non-Windows platforms the executable directory is
/// never the data home. That includes AppImage trees (FUSE mounts, extracted
/// copies, and `--appimage-extract-and-run`), `.app` bundles, and deb/rpm
/// prefixes. The home is the OS config directory
/// (`~/Library/Application Support/LocalPrism` or `~/.config/LocalPrism`).
pub fn localprism_home() -> Result<PathBuf, String> {
    let override_dir = std::env::var("LOCALPRISM_HOME").ok();
    let exe = std::env::current_exe().ok();
    let config_dir = dirs::config_dir().or_else(dirs::home_dir);
    resolve_localprism_home(
        override_dir.as_deref(),
        exe.as_deref(),
        config_dir.as_deref(),
        host_platform(),
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PlatformKind {
    Windows,
    Macos,
    Linux,
    Other,
}

fn host_platform() -> PlatformKind {
    if cfg!(windows) {
        PlatformKind::Windows
    } else if cfg!(target_os = "macos") {
        PlatformKind::Macos
    } else if cfg!(target_os = "linux") {
        PlatformKind::Linux
    } else {
        PlatformKind::Other
    }
}

fn allows_portable_install(platform: PlatformKind) -> bool {
    matches!(platform, PlatformKind::Windows)
}

fn resolve_localprism_home(
    override_dir: Option<&str>,
    exe_path: Option<&Path>,
    config_dir: Option<&Path>,
    platform: PlatformKind,
) -> Result<PathBuf, String> {
    resolve_localprism_home_with(
        override_dir,
        exe_path,
        config_dir,
        platform,
        install_dir_is_writable,
    )
}

fn resolve_localprism_home_with(
    override_dir: Option<&str>,
    exe_path: Option<&Path>,
    config_dir: Option<&Path>,
    platform: PlatformKind,
    mut install_dir_is_writable: impl FnMut(&Path) -> bool,
) -> Result<PathBuf, String> {
    if let Some(home) = override_home(override_dir) {
        return Ok(home);
    }
    if allows_portable_install(platform) {
        if let Some(install_dir) = writable_portable_dir(exe_path, &mut install_dir_is_writable) {
            return Ok(install_dir);
        }
    } else {
        warn_stray_install_data_home(exe_path, platform);
    }
    os_config_home(config_dir)
}

fn override_home(override_dir: Option<&str>) -> Option<PathBuf> {
    let trimmed = override_dir?.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

fn writable_portable_dir(
    exe_path: Option<&Path>,
    install_dir_is_writable: &mut impl FnMut(&Path) -> bool,
) -> Option<PathBuf> {
    let dir = exe_path?.parent()?;
    if looks_like_build_output(dir) {
        return None;
    }
    if !install_dir_is_writable(dir) {
        return None;
    }
    Some(dir.to_path_buf())
}

fn install_dir_is_writable(dir: &Path) -> bool {
    let probe = dir.join(WRITABLE_PROBE_NAME);
    if std::fs::write(&probe, b"ok").is_err() {
        return false;
    }
    let _ = std::fs::remove_file(&probe);
    true
}

fn os_config_home(config_dir: Option<&Path>) -> Result<PathBuf, String> {
    let config_dir = config_dir.ok_or("Could not find config directory")?;
    Ok(config_dir.join("LocalPrism"))
}

fn exe_dir_has_stray_data_home(dir: &Path) -> bool {
    [CLAUDE_HOME_DIRNAME, "providers", "uv"]
        .iter()
        .any(|name| dir.join(name).is_dir())
}

fn should_warn_stray_install_data(exe_dir: &Path, platform: PlatformKind) -> bool {
    !allows_portable_install(platform)
        && !looks_like_build_output(exe_dir)
        && exe_dir_has_stray_data_home(exe_dir)
}

/// One log line when a previous non-Windows run left claude-home, providers, or
/// uv beside the executable. Nothing is moved or deleted.
fn warn_stray_install_data_home(exe_path: Option<&Path>, platform: PlatformKind) {
    let Some(exe_dir) = exe_path.and_then(Path::parent) else {
        return;
    };
    if !should_warn_stray_install_data(exe_dir, platform) {
        return;
    }
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        eprintln!(
            "[localprism] ignoring data beside the executable at {} and using the OS config directory instead. Set LOCALPRISM_HOME to choose a data directory.",
            exe_dir.display()
        );
    });
}

pub fn user_skills_dir() -> Result<PathBuf, String> {
    Ok(resolve_user_dir(
        &localprism_home()?,
        USER_SKILLS_DIRNAME,
        USER_SKILLS_LEGACY_DIRNAME,
    ))
}

pub fn user_agents_dir() -> Result<PathBuf, String> {
    Ok(resolve_user_dir(
        &localprism_home()?,
        USER_AGENTS_DIRNAME,
        USER_AGENTS_LEGACY_DIRNAME,
    ))
}

pub fn user_slash_dir() -> Result<PathBuf, String> {
    Ok(resolve_user_dir(
        &localprism_home()?,
        USER_SLASH_DIRNAME,
        USER_SLASH_DIRNAME,
    ))
}

pub fn project_slash_dir(project_path: &Path) -> PathBuf {
    project_path.join(".localprism").join(USER_SLASH_DIRNAME)
}

/// Live user-scope folder under `claude-home`, after migrating install-root leftovers.
///
/// `{home}/skills` and `{home}/.skills` move into `{home}/claude-home/skills`
/// (same for agents). Empty preferred dirs or ones that only hold the
/// writability probe are unused and removed at install root.
pub fn resolve_user_dir(home: &Path, preferred: &str, legacy: &str) -> PathBuf {
    migrate_install_root_into_claude_home(home, preferred, legacy);
    home.join(CLAUDE_HOME_DIRNAME).join(preferred)
}

fn migrate_install_root_into_claude_home(home: &Path, preferred: &str, legacy: &str) {
    let dest = home.join(CLAUDE_HOME_DIRNAME).join(preferred);
    migrate_dir_into(&home.join(preferred), &dest);
    migrate_dir_into(&home.join(legacy), &dest);
}

fn migrate_dir_into(source: &Path, dest: &Path) {
    if source == dest || !source.is_dir() {
        return;
    }

    if is_unused_user_dir(source) {
        let _ = std::fs::remove_dir_all(source);
        return;
    }

    let dest_was_unused = is_unused_user_dir(dest);
    if dest_was_unused {
        if dest.exists() {
            let _ = std::fs::remove_dir_all(dest);
        }
        if let Some(parent) = dest.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if std::fs::rename(source, dest).is_ok() {
            return;
        }
    }

    if !dir_has_real_content(source) {
        return;
    }

    if copy_missing_children(source, dest).is_err() {
        return;
    }
    if dest_was_unused || is_unused_user_dir(source) {
        let _ = std::fs::remove_dir_all(source);
    }
}

fn is_unused_user_dir(dir: &Path) -> bool {
    if !dir.exists() {
        return true;
    }
    if !dir.is_dir() {
        return false;
    }
    !dir_has_real_content(dir)
}

fn dir_has_real_content(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|entry| entry.file_name() != WRITABLE_PROBE_NAME)
}

fn copy_missing_children(source: &Path, destination: &Path) -> Result<(), String> {
    std::fs::create_dir_all(destination)
        .map_err(|err| format!("Failed to create {}: {err}", destination.display()))?;
    let entries = std::fs::read_dir(source)
        .map_err(|err| format!("Failed to read {}: {err}", source.display()))?;
    for entry in entries.flatten() {
        let src = entry.path();
        let Some(name) = src.file_name() else {
            continue;
        };
        if name == WRITABLE_PROBE_NAME {
            continue;
        }
        let dest = destination.join(name);
        if dest.exists() {
            continue;
        }
        if src.is_dir() {
            copy_missing_children(&src, &dest)?;
        } else if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| format!("Failed to create {}: {err}", parent.display()))?;
            std::fs::copy(&src, &dest)
                .map_err(|err| format!("Failed to copy {}: {err}", dest.display()))?;
        }
    }
    Ok(())
}

pub(crate) fn looks_like_build_output(dir: &Path) -> bool {
    dir.ancestors().any(|ancestor| {
        ancestor
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                matches!(
                    name.to_ascii_lowercase().as_str(),
                    "target" | "target-static" | "src-tauri"
                )
            })
    })
}

/// Isolated Claude CLI config so LocalPrism skills/agents do not share `~/.claude`.
pub fn claude_config_dir() -> Result<PathBuf, String> {
    Ok(localprism_home()?.join(CLAUDE_HOME_DIRNAME))
}

pub fn providers_dir() -> Result<PathBuf, String> {
    if let Ok(override_dir) = std::env::var("LOCALPRISM_PROVIDERS_DIR") {
        let trimmed = override_dir.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    Ok(localprism_home()?.join("providers"))
}

pub fn providers_index_path() -> Result<PathBuf, String> {
    Ok(providers_dir()?.join("providers.json"))
}

pub fn anthropic_auth_path() -> Result<PathBuf, String> {
    Ok(providers_dir()?.join("anthropic-auth.json"))
}

pub fn claude_oauth_path() -> Result<PathBuf, String> {
    Ok(providers_dir()?.join("claude-oauth.json"))
}

pub fn openai_oauth_path() -> Result<PathBuf, String> {
    Ok(providers_dir()?.join("openai-oauth.json"))
}

pub fn models_cache_path() -> Result<PathBuf, String> {
    Ok(providers_dir()?.join("models-cache.json"))
}

pub fn legacy_anthropic_auth_path() -> Result<PathBuf, String> {
    if let Ok(override_path) = std::env::var("LOCALPRISM_LEGACY_ANTHROPIC_AUTH") {
        let trimmed = override_path.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    let config_dir = dirs::config_dir()
        .or_else(dirs::home_dir)
        .ok_or("Could not find config directory")?;
    Ok(config_dir.join("ClaudePrism").join("anthropic-auth.json"))
}

pub fn restrict_secret_file(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|err| format!("Failed to lock down {}: {err}", path.display()))?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

#[cfg(test)]
pub fn lock_provider_env() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn write_secret_json(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create {}: {err}", parent.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, contents)
        .map_err(|err| format!("Failed to write {}: {err}", tmp.display()))?;
    restrict_secret_file(&tmp)?;
    std::fs::rename(&tmp, path)
        .map_err(|err| format!("Failed to replace {}: {err}", path.display()))?;
    restrict_secret_file(path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn restore_env(key: &str, previous: Option<String>) {
        match previous {
            Some(value) => std::env::set_var(key, value),
            None => std::env::remove_var(key),
        }
    }

    #[test]
    fn localprism_home_uses_override() {
        let _guard = lock_provider_env();
        let dir = TempDir::new().unwrap();
        let previous = std::env::var("LOCALPRISM_HOME").ok();
        std::env::set_var("LOCALPRISM_HOME", dir.path());
        let home = localprism_home().unwrap();
        restore_env("LOCALPRISM_HOME", previous);
        assert_eq!(home, dir.path());
    }

    #[test]
    fn providers_and_claude_home_share_localprism_home() {
        let _guard = lock_provider_env();
        let dir = TempDir::new().unwrap();
        let previous_home = std::env::var("LOCALPRISM_HOME").ok();
        let previous_providers = std::env::var("LOCALPRISM_PROVIDERS_DIR").ok();
        std::env::set_var("LOCALPRISM_HOME", dir.path());
        std::env::remove_var("LOCALPRISM_PROVIDERS_DIR");
        let home = localprism_home().unwrap();
        let providers = providers_dir().unwrap();
        let claude = claude_config_dir().unwrap();
        let auth = anthropic_auth_path().unwrap();
        let skills = user_skills_dir().unwrap();
        let agents = user_agents_dir().unwrap();
        let slash = user_slash_dir().unwrap();
        restore_env("LOCALPRISM_HOME", previous_home);
        restore_env("LOCALPRISM_PROVIDERS_DIR", previous_providers);
        assert_eq!(home, dir.path());
        assert_eq!(providers, dir.path().join("providers"));
        assert_eq!(claude, dir.path().join("claude-home"));
        assert_eq!(auth, dir.path().join("providers").join("anthropic-auth.json"));
        assert_eq!(skills, dir.path().join("claude-home").join("skills"));
        assert_eq!(agents, dir.path().join("claude-home").join("agents"));
        assert_eq!(slash, dir.path().join("claude-home").join("slash"));
    }

    #[test]
    fn migrates_unused_preferred_dir_from_legacy() {
        let _guard = lock_provider_env();
        let dir = TempDir::new().unwrap();
        let home = dir.path();
        let legacy = home.join(".skills");
        std::fs::create_dir_all(legacy.join("writer")).unwrap();
        std::fs::write(legacy.join("writer").join("SKILL.md"), "# Writer").unwrap();
        let unused = home.join("skills");
        std::fs::create_dir_all(&unused).unwrap();
        std::fs::write(unused.join(".localprism-writable"), b"ok").unwrap();

        let previous = std::env::var("LOCALPRISM_HOME").ok();
        std::env::set_var("LOCALPRISM_HOME", home);
        let resolved = user_skills_dir().unwrap();
        restore_env("LOCALPRISM_HOME", previous);

        assert_eq!(resolved, home.join("claude-home").join("skills"));
        assert!(resolved.join("writer").join("SKILL.md").is_file());
        assert!(!home.join(".skills").exists());
        assert!(!home.join("skills").exists());
    }

    #[test]
    fn merges_legacy_children_when_both_dirs_have_content() {
        let _guard = lock_provider_env();
        let dir = TempDir::new().unwrap();
        let home = dir.path();
        let preferred = home.join("agents");
        let legacy = home.join(".agents");
        std::fs::create_dir_all(&preferred).unwrap();
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(preferred.join("keep.md"), "preferred").unwrap();
        std::fs::write(legacy.join("keep.md"), "legacy").unwrap();
        std::fs::write(legacy.join("extra.md"), "copied").unwrap();

        let previous = std::env::var("LOCALPRISM_HOME").ok();
        std::env::set_var("LOCALPRISM_HOME", home);
        let resolved = user_agents_dir().unwrap();
        restore_env("LOCALPRISM_HOME", previous);

        let dest = home.join("claude-home").join("agents");
        assert_eq!(resolved, dest);
        assert_eq!(
            std::fs::read_to_string(dest.join("keep.md")).unwrap(),
            "preferred"
        );
        assert_eq!(
            std::fs::read_to_string(dest.join("extra.md")).unwrap(),
            "copied"
        );
        assert!(!preferred.exists());
    }

    #[test]
    fn leftover_install_root_skills_move_into_empty_claude_home() {
        let _guard = lock_provider_env();
        let dir = TempDir::new().unwrap();
        let home = dir.path();
        let leftover = home.join("skills");
        std::fs::create_dir_all(leftover.join("writer")).unwrap();
        std::fs::write(leftover.join("writer").join("SKILL.md"), "# Writer").unwrap();

        let previous = std::env::var("LOCALPRISM_HOME").ok();
        std::env::set_var("LOCALPRISM_HOME", home);
        let resolved = user_skills_dir().unwrap();
        restore_env("LOCALPRISM_HOME", previous);

        assert_eq!(resolved, home.join("claude-home").join("skills"));
        assert!(resolved.join("writer").join("SKILL.md").is_file());
        assert!(!leftover.exists());
    }

    #[test]
    fn merges_missing_install_root_skills_into_existing_claude_home() {
        let _guard = lock_provider_env();
        let dir = TempDir::new().unwrap();
        let home = dir.path();
        let leftover = home.join("skills");
        let dest = home.join("claude-home").join("skills");
        std::fs::create_dir_all(&leftover).unwrap();
        std::fs::create_dir_all(&dest).unwrap();
        std::fs::write(dest.join("keep.md"), "claude-home").unwrap();
        std::fs::write(leftover.join("keep.md"), "leftover").unwrap();
        std::fs::write(leftover.join("extra.md"), "copied").unwrap();

        let previous = std::env::var("LOCALPRISM_HOME").ok();
        std::env::set_var("LOCALPRISM_HOME", home);
        let resolved = user_skills_dir().unwrap();
        restore_env("LOCALPRISM_HOME", previous);

        assert_eq!(resolved, dest);
        assert_eq!(
            std::fs::read_to_string(dest.join("keep.md")).unwrap(),
            "claude-home"
        );
        assert_eq!(
            std::fs::read_to_string(dest.join("extra.md")).unwrap(),
            "copied"
        );
    }

    #[test]
    fn build_output_dirs_are_not_treated_as_install_home() {
        assert!(looks_like_build_output(Path::new(
            "/tmp/claude-prism/src-tauri/target-static/release"
        )));
        assert!(looks_like_build_output(Path::new(
            "/tmp/claude-prism/src-tauri/target/debug"
        )));
        // `\` is not a separator on Unix, so these literals only describe components on Windows.
        #[cfg(windows)]
        {
            assert!(looks_like_build_output(Path::new(
                r"F:\Projects\claude-prism\apps\desktop\src-tauri\target-static\release"
            )));
            assert!(!looks_like_build_output(Path::new(r"D:\LocalPrism")));
            assert!(!looks_like_build_output(Path::new(
                r"C:\Users\me\AppData\Local\LocalPrism"
            )));
        }
        #[cfg(not(windows))]
        {
            assert!(!looks_like_build_output(Path::new("/tmp/LocalPrism")));
            assert!(!looks_like_build_output(Path::new(
                "/home/me/.config/LocalPrism"
            )));
        }
    }

    fn fake_exe(dir: &Path, file_name: &str) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let exe = dir.join(file_name);
        std::fs::write(&exe, b"bin").unwrap();
        exe
    }

    fn plant_stray_data_home(exe_dir: &Path) {
        let sessions = exe_dir.join(CLAUDE_HOME_DIRNAME).join("projects");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(sessions.join("session.jsonl"), b"{}").unwrap();
        let providers = exe_dir.join("providers");
        std::fs::create_dir_all(&providers).unwrap();
        std::fs::write(providers.join("providers.json"), b"{}").unwrap();
    }

    fn assert_stray_data_untouched(exe_dir: &Path) {
        assert!(exe_dir
            .join(CLAUDE_HOME_DIRNAME)
            .join("projects")
            .join("session.jsonl")
            .is_file());
        assert!(exe_dir.join("providers").join("providers.json").is_file());
    }

    struct RestoreWritable {
        path: PathBuf,
    }

    impl RestoreWritable {
        fn lock_dir(path: &Path) -> Self {
            let mut perms = std::fs::metadata(path).unwrap().permissions();
            perms.set_readonly(true);
            std::fs::set_permissions(path, perms).unwrap();
            Self {
                path: path.to_path_buf(),
            }
        }
    }

    impl Drop for RestoreWritable {
        fn drop(&mut self) {
            if let Ok(meta) = std::fs::metadata(&self.path) {
                let mut perms = meta.permissions();
                perms.set_readonly(false);
                let _ = std::fs::set_permissions(&self.path, perms);
            }
        }
    }

    fn assert_not_install_home(exe: &Path, config: &Path, platform: PlatformKind) {
        let mut probed = false;
        let home = resolve_localprism_home_with(None, Some(exe), Some(config), platform, |dir| {
            probed = true;
            assert_eq!(dir, exe.parent().unwrap());
            true
        })
        .unwrap();
        assert_eq!(
            home,
            config.join("LocalPrism"),
            "executable directory {} must not be the data home",
            exe.parent().unwrap().display()
        );
        assert!(
            !probed,
            "must not probe writability of {}",
            exe.parent().unwrap().display()
        );
    }

    #[test]
    fn only_windows_allows_a_writable_install_home() {
        assert!(allows_portable_install(PlatformKind::Windows));
        assert!(!allows_portable_install(PlatformKind::Linux));
        assert!(!allows_portable_install(PlatformKind::Macos));
        assert!(!allows_portable_install(PlatformKind::Other));
    }

    #[test]
    fn appimage_and_extracted_appimage_are_not_data_home() {
        let root = TempDir::new().unwrap();
        let config = root.path().join("config");
        let cases = [
            (
                root.path().join("squashfs-root").join("usr").join("bin"),
                "localprism",
            ),
            (root.path().join("squashfs-root"), "AppRun"),
            (
                root.path()
                    .join(".mount_LocalPrismAbCdEf")
                    .join("usr")
                    .join("bin"),
                "localprism",
            ),
            (
                root.path()
                    .join("appimage_extracted_abc123")
                    .join("squashfs-root")
                    .join("usr")
                    .join("bin"),
                "localprism",
            ),
        ];
        for (exe_dir, file_name) in cases {
            let exe = fake_exe(&exe_dir, file_name);
            plant_stray_data_home(&exe_dir);
            assert_not_install_home(&exe, &config, PlatformKind::Linux);
            assert_stray_data_untouched(&exe_dir);
        }
    }

    #[test]
    fn macos_app_bundle_is_not_data_home() {
        let root = TempDir::new().unwrap();
        let config = root.path().join("Library").join("Application Support");
        let exe_dir = root
            .path()
            .join("Applications")
            .join("LocalPrism.app")
            .join("Contents")
            .join("MacOS");
        let exe = fake_exe(&exe_dir, "localprism");
        plant_stray_data_home(&exe_dir);
        assert_not_install_home(&exe, &config, PlatformKind::Macos);
        assert_stray_data_untouched(&exe_dir);
    }

    #[test]
    fn deb_and_rpm_prefix_is_not_data_home() {
        let root = TempDir::new().unwrap();
        let config = root.path().join("config");
        let exe = fake_exe(&root.path().join("usr").join("bin"), "localprism");
        assert_not_install_home(&exe, &config, PlatformKind::Linux);
        assert_not_install_home(&exe, &config, PlatformKind::Other);
    }

    #[test]
    fn windows_writable_portable_install_is_data_home() {
        let root = TempDir::new().unwrap();
        let install = root.path().join("LocalPrism");
        let exe = fake_exe(&install, "LocalPrism.exe");
        let config = root.path().join("AppData").join("Roaming");
        let home = resolve_localprism_home(None, Some(&exe), Some(&config), PlatformKind::Windows)
            .unwrap();
        assert_eq!(home, install);
        assert!(!install.join(WRITABLE_PROBE_NAME).exists());
        assert_ne!(home, config.join("LocalPrism"));
    }

    #[test]
    fn windows_nonwritable_install_falls_back_to_config_dir() {
        let root = TempDir::new().unwrap();
        let install = root.path().join("Program Files").join("LocalPrism");
        let exe = fake_exe(&install, "LocalPrism.exe");
        let _readonly = RestoreWritable::lock_dir(&install);
        let config = root.path().join("AppData").join("Roaming");
        let home = resolve_localprism_home(None, Some(&exe), Some(&config), PlatformKind::Windows)
            .unwrap();
        assert_eq!(home, config.join("LocalPrism"));
    }

    #[test]
    fn windows_build_output_is_not_data_home() {
        let root = TempDir::new().unwrap();
        let install = root.path().join("src-tauri").join("target").join("release");
        let exe = fake_exe(&install, "LocalPrism.exe");
        let config = root.path().join("AppData");
        let mut probed = false;
        let home = resolve_localprism_home_with(
            None,
            Some(&exe),
            Some(&config),
            PlatformKind::Windows,
            |_| {
                probed = true;
                true
            },
        )
        .unwrap();
        assert!(!probed);
        assert_eq!(home, config.join("LocalPrism"));
    }

    #[test]
    fn override_wins_over_writable_portable_install() {
        let root = TempDir::new().unwrap();
        let install = root.path().join("LocalPrism");
        let exe = fake_exe(&install, "LocalPrism.exe");
        let config = root.path().join("AppData");
        let custom = root.path().join("custom-home");
        let custom_str = custom.to_str().unwrap();
        let home = resolve_localprism_home_with(
            Some(custom_str),
            Some(&exe),
            Some(&config),
            PlatformKind::Windows,
            |_| true,
        )
        .unwrap();
        assert_eq!(home, custom);

        let appimage = root.path().join("squashfs-root").join("usr").join("bin");
        let app_exe = fake_exe(&appimage, "localprism");
        let home = resolve_localprism_home_with(
            Some(custom_str),
            Some(&app_exe),
            Some(&config),
            PlatformKind::Linux,
            |_| true,
        )
        .unwrap();
        assert_eq!(home, custom);
    }

    #[test]
    fn stray_data_beside_non_windows_exe_is_detected() {
        let root = TempDir::new().unwrap();
        for (marker, platform) in [
            (CLAUDE_HOME_DIRNAME, PlatformKind::Linux),
            ("providers", PlatformKind::Macos),
            ("uv", PlatformKind::Other),
        ] {
            let exe_dir = root.path().join(marker).join("bin");
            std::fs::create_dir_all(exe_dir.join(marker)).unwrap();
            assert!(
                should_warn_stray_install_data(&exe_dir, platform),
                "{marker} on {platform:?}"
            );
        }

        let clean = root.path().join("usr").join("bin");
        std::fs::create_dir_all(&clean).unwrap();
        assert!(!should_warn_stray_install_data(&clean, PlatformKind::Linux));

        let build = root.path().join("target").join("release");
        std::fs::create_dir_all(build.join(CLAUDE_HOME_DIRNAME)).unwrap();
        assert!(!should_warn_stray_install_data(&build, PlatformKind::Linux));

        let portable = root.path().join("LocalPrism");
        std::fs::create_dir_all(portable.join("providers")).unwrap();
        assert!(!should_warn_stray_install_data(
            &portable,
            PlatformKind::Windows
        ));
    }

    #[test]
    fn host_platform_matches_this_target() {
        #[cfg(windows)]
        assert_eq!(host_platform(), PlatformKind::Windows);
        #[cfg(target_os = "macos")]
        assert_eq!(host_platform(), PlatformKind::Macos);
        #[cfg(target_os = "linux")]
        assert_eq!(host_platform(), PlatformKind::Linux);
        #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
        assert_eq!(host_platform(), PlatformKind::Other);
    }
}
