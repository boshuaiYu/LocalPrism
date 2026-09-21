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
/// Prefer the writable install folder (the directory that contains LocalPrism.exe),
/// so a custom install like `D:\LocalPrism` keeps claude-home/providers/python there.
/// Program Files and cargo `target/` builds are not writable/stable, so those
/// fall back to `%APPDATA%/LocalPrism`. Override with `LOCALPRISM_HOME`.
pub fn localprism_home() -> Result<PathBuf, String> {
    if let Ok(override_dir) = std::env::var("LOCALPRISM_HOME") {
        let trimmed = override_dir.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }
    if let Some(install_dir) = writable_install_dir() {
        return Ok(install_dir);
    }
    let config_dir = dirs::config_dir()
        .or_else(dirs::home_dir)
        .ok_or("Could not find config directory")?;
    Ok(config_dir.join("LocalPrism"))
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

fn writable_install_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.to_path_buf();
    if looks_like_build_output(&dir) {
        return None;
    }
    let probe = dir.join(WRITABLE_PROBE_NAME);
    std::fs::write(&probe, b"ok").ok()?;
    let _ = std::fs::remove_file(&probe);
    Some(dir)
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
            r"F:\Projects\claude-prism\apps\desktop\src-tauri\target-static\release"
        )));
        assert!(looks_like_build_output(Path::new(
            "/tmp/claude-prism/src-tauri/target/debug"
        )));
        assert!(!looks_like_build_output(Path::new(r"D:\LocalPrism")));
        assert!(!looks_like_build_output(Path::new(
            r"C:\Users\me\AppData\Local\LocalPrism"
        )));
    }
}
