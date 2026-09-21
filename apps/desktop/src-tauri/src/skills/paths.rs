use crate::runtime::RuntimeKind;
use crate::skills::domain::{SkillScope, SkillTarget};
use std::fmt;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkillPathError {
    HomeDirectoryUnavailable,
    ProjectPathRequired,
    ProjectPathMustBeAbsolute,
    InvalidFolder(String),
    PathResolution { path: PathBuf, message: String },
    OutsideRoot { root: PathBuf, destination: PathBuf },
}

impl fmt::Display for SkillPathError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::HomeDirectoryUnavailable => {
                write!(formatter, "Unable to resolve the user home directory")
            }
            Self::ProjectPathRequired => {
                write!(formatter, "Project-scoped skills require a project path")
            }
            Self::ProjectPathMustBeAbsolute => {
                write!(
                    formatter,
                    "Project-scoped skills require an absolute project path"
                )
            }
            Self::InvalidFolder(folder) => {
                write!(formatter, "Invalid skill folder name: {folder:?}")
            }
            Self::PathResolution { path, message } => {
                write!(formatter, "Failed to resolve {}: {message}", path.display())
            }
            Self::OutsideRoot { root, destination } => write!(
                formatter,
                "Skill destination {} is outside the selected root {}",
                destination.display(),
                root.display()
            ),
        }
    }
}

impl std::error::Error for SkillPathError {}

pub fn resolve_skill_root(
    runtime: RuntimeKind,
    scope: SkillScope,
    project_path: Option<&Path>,
) -> Result<PathBuf, SkillPathError> {
    let home_dir = if scope == SkillScope::User {
        crate::providers::paths::localprism_home().ok()
    } else {
        None
    };
    resolve_skill_root_with_home(
        home_dir.as_deref(),
        project_path,
        SkillTarget { runtime, scope },
    )
}

pub(super) fn resolve_skill_root_with_home(
    home_dir: Option<&Path>,
    project_path: Option<&Path>,
    target: SkillTarget,
) -> Result<PathBuf, SkillPathError> {
    let base = match target.scope {
        SkillScope::User => home_dir.ok_or(SkillPathError::HomeDirectoryUnavailable)?,
        SkillScope::Project => {
            let project = project_path.ok_or(SkillPathError::ProjectPathRequired)?;
            if !project.is_absolute() {
                return Err(SkillPathError::ProjectPathMustBeAbsolute);
            }
            project
        }
    };

    // Claude and Codex share LocalPrism-owned folders so skills never leak into ~/.claude.
    let _ = target.runtime;
    Ok(match target.scope {
        SkillScope::User => crate::providers::paths::resolve_user_dir(
            base,
            crate::providers::paths::USER_SKILLS_DIRNAME,
            crate::providers::paths::USER_SKILLS_LEGACY_DIRNAME,
        ),
        SkillScope::Project => base.join(".localprism").join("skills"),
    })
}

/// Create the isolated Claude home and overlay current-project skills/agents
/// without overwriting user-managed copies of the same folder name.
pub fn prepare_isolated_claude_home(
    project_path: Option<&Path>,
) -> Result<PathBuf, SkillPathError> {
    let config_dir = crate::providers::paths::claude_config_dir()
        .map_err(|_| SkillPathError::HomeDirectoryUnavailable)?;
    std::fs::create_dir_all(config_dir.join("skills")).map_err(|error| {
        SkillPathError::PathResolution {
            path: config_dir.join("skills"),
            message: error.to_string(),
        }
    })?;
    std::fs::create_dir_all(config_dir.join("agents")).map_err(|error| {
        SkillPathError::PathResolution {
            path: config_dir.join("agents"),
            message: error.to_string(),
        }
    })?;
    std::fs::create_dir_all(config_dir.join("slash")).map_err(|error| {
        SkillPathError::PathResolution {
            path: config_dir.join("slash"),
            message: error.to_string(),
        }
    })?;
    std::fs::create_dir_all(config_dir.join("commands")).map_err(|error| {
        SkillPathError::PathResolution {
            path: config_dir.join("commands"),
            message: error.to_string(),
        }
    })?;
    let dest_skills = config_dir.join("skills");
    let dest_agents = config_dir.join("agents");
    let dest_slash = config_dir.join("slash");
    let dest_commands = config_dir.join("commands");
    if let Ok(home) = crate::providers::paths::localprism_home() {
        let user_skills = crate::providers::paths::user_skills_dir()
            .unwrap_or_else(|_| dest_skills.clone());
        let user_agents = crate::providers::paths::user_agents_dir()
            .unwrap_or_else(|_| dest_agents.clone());
        if user_skills != dest_skills {
            overlay_missing_children(&user_skills, &dest_skills)?;
            strip_host_bound_skill_overlays(&dest_skills)?;
        }
        if user_agents != dest_agents {
            overlay_missing_children(&user_agents, &dest_agents)?;
        }
        let user_slash = crate::providers::paths::user_slash_dir()
            .unwrap_or_else(|_| dest_slash.clone());
        if user_slash != dest_slash {
            overlay_missing_children(&user_slash, &dest_slash)?;
        }
        overlay_missing_children(&user_slash, &dest_commands)?;
        for leftover in [
            home.join(crate::providers::paths::USER_SKILLS_DIRNAME),
            home.join(crate::providers::paths::USER_SKILLS_LEGACY_DIRNAME),
        ] {
            if leftover != dest_skills && leftover != user_skills {
                overlay_missing_children(&leftover, &dest_skills)?;
            }
        }
        for leftover in [
            home.join(crate::providers::paths::USER_AGENTS_DIRNAME),
            home.join(crate::providers::paths::USER_AGENTS_LEGACY_DIRNAME),
        ] {
            if leftover != dest_agents && leftover != user_agents {
                overlay_missing_children(&leftover, &dest_agents)?;
            }
        }
    }

    if let Some(project) = project_path.filter(|path| path.is_absolute()) {
        overlay_missing_children(
            &project.join(".localprism").join("skills"),
            &config_dir.join("skills"),
        )?;
        overlay_missing_children(
            &project.join(".localprism").join("agents"),
            &config_dir.join("agents"),
        )?;
        overlay_missing_children(
            &crate::providers::paths::project_slash_dir(project),
            &config_dir.join("commands"),
        )?;
    }

    // Do not pass --add-dir to `claude -p`: sdk-cli waits for directory trust
    // and never calls the model. Pre-approve Read of the install folders instead.
    let _ = write_install_folder_read_allows(&config_dir);

    Ok(config_dir)
}

fn claude_abs_rule_path(dir: &Path) -> String {
    let mut path = dir.to_string_lossy().replace('\\', "/");
    if let Some((drive, rest)) = path.split_once(':') {
        if drive.len() == 1 && drive.chars().all(|c| c.is_ascii_alphabetic()) {
            path = format!("/{}/{}", drive.to_ascii_lowercase(), rest.trim_start_matches('/'));
        }
    }
    if !path.starts_with('/') {
        path.insert(0, '/');
    }
    format!("/{path}")
}

fn install_folder_read_allow_rules(dir: &Path) -> Vec<String> {
    vec![format!("Read({}/**)", claude_abs_rule_path(dir))]
}

fn write_install_folder_read_allows(config_dir: &Path) -> Result<(), SkillPathError> {
    let mut rules = Vec::new();
    for resolve in [
        crate::providers::paths::user_skills_dir,
        crate::providers::paths::user_agents_dir,
        crate::providers::paths::user_slash_dir,
    ] {
        if let Ok(dir) = resolve() {
            let _ = std::fs::create_dir_all(&dir);
            if dir.is_dir() {
                rules.extend(install_folder_read_allow_rules(&dir));
            }
        }
    }
    if let Ok(home) = crate::providers::paths::localprism_home() {
        for leftover in [
            home.join(crate::providers::paths::USER_SKILLS_DIRNAME),
            home.join(crate::providers::paths::USER_SKILLS_LEGACY_DIRNAME),
            home.join(crate::providers::paths::USER_AGENTS_DIRNAME),
            home.join(crate::providers::paths::USER_AGENTS_LEGACY_DIRNAME),
        ] {
            if leftover.is_dir() {
                rules.extend(install_folder_read_allow_rules(&leftover));
            }
        }
    }
    if rules.is_empty() {
        return Ok(());
    }

    let settings_path = config_dir.join("settings.json");
    let mut settings = if settings_path.exists() {
        let raw = std::fs::read_to_string(&settings_path).map_err(|error| {
            SkillPathError::PathResolution {
                path: settings_path.clone(),
                message: error.to_string(),
            }
        })?;
        serde_json::from_str::<serde_json::Value>(&raw).map_err(|error| {
            SkillPathError::PathResolution {
                path: settings_path.clone(),
                message: error.to_string(),
            }
        })?
    } else {
        serde_json::json!({})
    };

    let Some(root) = settings.as_object_mut() else {
        return Ok(());
    };
    let permissions = root
        .entry("permissions")
        .or_insert_with(|| serde_json::json!({}));
    let Some(permissions) = permissions.as_object_mut() else {
        return Ok(());
    };
    let allow = permissions
        .entry("allow")
        .or_insert_with(|| serde_json::json!([]));
    let Some(allow) = allow.as_array_mut() else {
        return Ok(());
    };
    for rule in rules {
        if !allow.iter().any(|value| value.as_str() == Some(rule.as_str())) {
            allow.push(serde_json::Value::String(rule));
        }
    }

    std::fs::write(
        &settings_path,
        serde_json::to_string_pretty(&settings).map_err(|error| {
            SkillPathError::PathResolution {
                path: settings_path.clone(),
                message: error.to_string(),
            }
        })?,
    )
    .map_err(|error| SkillPathError::PathResolution {
        path: settings_path,
        message: error.to_string(),
    })?;
    Ok(())
}

fn overlay_missing_children(source: &Path, destination: &Path) -> Result<(), SkillPathError> {
    if source == destination || !source.is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(destination).map_err(|error| SkillPathError::PathResolution {
        path: destination.to_path_buf(),
        message: error.to_string(),
    })?;
    let entries = std::fs::read_dir(source).map_err(|error| SkillPathError::PathResolution {
        path: source.to_path_buf(),
        message: error.to_string(),
    })?;
    for entry in entries.flatten() {
        let src = entry.path();
        let name = match src.file_name() {
            Some(name) => name,
            None => continue,
        };
        let dest = destination.join(name);
        if crate::skills::paperspine::is_host_bound_skill_folder(&name.to_string_lossy()) {
            continue;
        }
        if dest.exists() {
            continue;
        }
        copy_path_recursive(&src, &dest)?;
    }
    Ok(())
}

fn strip_host_bound_skill_overlays(skills_dir: &Path) -> Result<(), SkillPathError> {
    if !skills_dir.is_dir() {
        return Ok(());
    }
    let entries = std::fs::read_dir(skills_dir).map_err(|error| SkillPathError::PathResolution {
        path: skills_dir.to_path_buf(),
        message: error.to_string(),
    })?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|value| value.to_str()) {
            Some(name) => name,
            None => continue,
        };
        if !crate::skills::paperspine::is_host_bound_skill_folder(name) {
            continue;
        }
        if path.is_dir() {
            std::fs::remove_dir_all(&path).map_err(|error| SkillPathError::PathResolution {
                path: path.clone(),
                message: error.to_string(),
            })?;
        } else {
            std::fs::remove_file(&path).map_err(|error| SkillPathError::PathResolution {
                path: path.clone(),
                message: error.to_string(),
            })?;
        }
    }
    Ok(())
}

fn copy_path_recursive(source: &Path, destination: &Path) -> Result<(), SkillPathError> {
    let metadata = std::fs::metadata(source).map_err(|error| SkillPathError::PathResolution {
        path: source.to_path_buf(),
        message: error.to_string(),
    })?;
    if metadata.is_dir() {
        std::fs::create_dir_all(destination).map_err(|error| SkillPathError::PathResolution {
            path: destination.to_path_buf(),
            message: error.to_string(),
        })?;
        let entries =
            std::fs::read_dir(source).map_err(|error| SkillPathError::PathResolution {
                path: source.to_path_buf(),
                message: error.to_string(),
            })?;
        for entry in entries.flatten() {
            let child = entry.path();
            let name = match child.file_name() {
                Some(name) => name,
                None => continue,
            };
            copy_path_recursive(&child, &destination.join(name))?;
        }
        return Ok(());
    }
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|error| SkillPathError::PathResolution {
            path: parent.to_path_buf(),
            message: error.to_string(),
        })?;
    }
    std::fs::copy(source, destination).map_err(|error| SkillPathError::PathResolution {
        path: destination.to_path_buf(),
        message: error.to_string(),
    })?;
    Ok(())
}

pub fn skill_destination(root: &Path, folder: &str) -> Result<PathBuf, SkillPathError> {
    validate_skill_slug(folder)?;
    let destination = root.join(folder);

    match std::fs::symlink_metadata(&destination) {
        Ok(_) => ensure_canonical_skill_containment(root, &destination)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(SkillPathError::PathResolution {
                path: destination,
                message: error.to_string(),
            });
        }
    }

    Ok(destination)
}

pub fn ensure_canonical_skill_containment(
    root: &Path,
    destination: &Path,
) -> Result<(), SkillPathError> {
    let canonical_root = canonicalize(root)?;
    let canonical_destination = canonicalize(destination)?;
    if canonical_destination.starts_with(&canonical_root) {
        Ok(())
    } else {
        Err(SkillPathError::OutsideRoot {
            root: canonical_root,
            destination: canonical_destination,
        })
    }
}

fn canonicalize(path: &Path) -> Result<PathBuf, SkillPathError> {
    path.canonicalize()
        .map_err(|error| SkillPathError::PathResolution {
            path: path.to_path_buf(),
            message: error.to_string(),
        })
}

pub fn validate_skill_slug(folder: &str) -> Result<(), SkillPathError> {
    let basename = folder.split('.').next().unwrap_or(folder);
    let uppercase_basename = basename.trim_end_matches(' ').to_ascii_uppercase();
    let is_windows_device_name = matches!(
        uppercase_basename.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "COM¹"
            | "COM²"
            | "COM³"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
            | "LPT¹"
            | "LPT²"
            | "LPT³"
            | "CONIN$"
            | "CONOUT$"
    );
    if folder.is_empty()
        || folder == "."
        || folder == ".."
        || folder.contains(['/', '\\'])
        || folder.contains(['<', '>', ':', '"', '|', '?', '*'])
        || folder.chars().any(|character| character.is_ascii_control())
        || folder.trim() != folder
        || folder.ends_with('.')
        || is_windows_device_name
        || Path::new(folder).is_absolute()
    {
        return Err(SkillPathError::InvalidFolder(folder.to_string()));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_canonical_skill_containment, resolve_skill_root, resolve_skill_root_with_home,
        skill_destination, validate_skill_slug, SkillPathError,
    };
    use crate::runtime::RuntimeKind;
    use crate::skills::domain::{SkillScope, SkillTarget};
    use std::path::Path;

    fn target(runtime: RuntimeKind, scope: SkillScope) -> SkillTarget {
        SkillTarget { runtime, scope }
    }

    #[test]
    fn resolves_all_runtime_and_scope_roots() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("project");

        assert_eq!(
            resolve_skill_root_with_home(
                Some(&home),
                None,
                target(RuntimeKind::Claude, SkillScope::User)
            )
            .unwrap(),
            home.join("claude-home").join("skills")
        );
        assert_eq!(
            resolve_skill_root_with_home(
                Some(&home),
                None,
                target(RuntimeKind::Codex, SkillScope::User)
            )
            .unwrap(),
            home.join("claude-home").join("skills")
        );
        assert_eq!(
            resolve_skill_root_with_home(
                None,
                Some(&project),
                target(RuntimeKind::Claude, SkillScope::Project)
            )
            .unwrap(),
            project.join(".localprism").join("skills")
        );
        assert_eq!(
            resolve_skill_root_with_home(
                None,
                Some(&project),
                target(RuntimeKind::Codex, SkillScope::Project)
            )
            .unwrap(),
            project.join(".localprism").join("skills")
        );
    }

    #[test]
    fn project_scope_requires_an_explicit_project_path() {
        let temp = tempfile::tempdir().unwrap();
        let error = resolve_skill_root_with_home(
            Some(temp.path()),
            None,
            target(RuntimeKind::Claude, SkillScope::Project),
        )
        .unwrap_err();

        assert_eq!(error, SkillPathError::ProjectPathRequired);

        let public_error =
            resolve_skill_root(RuntimeKind::Claude, SkillScope::Project, None).unwrap_err();
        assert_eq!(public_error, SkillPathError::ProjectPathRequired);
    }

    #[test]
    fn project_scope_rejects_relative_paths_instead_of_using_the_current_directory() {
        for project in [Path::new(""), Path::new("relative-project")] {
            let error = resolve_skill_root_with_home(
                None,
                Some(project),
                target(RuntimeKind::Codex, SkillScope::Project),
            )
            .unwrap_err();

            assert_eq!(error, SkillPathError::ProjectPathMustBeAbsolute);
        }
    }

    #[test]
    fn user_scope_requires_an_explicit_home_path() {
        let error = resolve_skill_root_with_home(
            None,
            Some(Path::new("unused-project")),
            target(RuntimeKind::Codex, SkillScope::User),
        )
        .unwrap_err();

        assert_eq!(error, SkillPathError::HomeDirectoryUnavailable);
    }

    #[test]
    fn rejects_traversal_absolute_and_nested_skill_folders() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        std::fs::create_dir_all(&root).unwrap();
        let absolute = temp.path().join("absolute").to_string_lossy().to_string();
        let invalid = [
            "",
            ".",
            "..",
            "../escape",
            r"..\escape",
            "nested/skill",
            r"nested\skill",
            &absolute,
        ];

        for folder in invalid {
            assert!(
                matches!(
                    skill_destination(&root, folder),
                    Err(SkillPathError::InvalidFolder(_))
                ),
                "folder should be rejected: {folder:?}"
            );
            assert!(matches!(
                validate_skill_slug(folder),
                Err(SkillPathError::InvalidFolder(_))
            ));
        }
    }

    #[test]
    fn user_scope_prefers_leftover_dotted_skills_when_preferred_is_absent() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let leftover = home.join(".skills").join("pdf");
        std::fs::create_dir_all(&leftover).unwrap();
        std::fs::write(leftover.join("SKILL.md"), "# PDF").unwrap();

        assert_eq!(
            resolve_skill_root_with_home(
                Some(&home),
                None,
                target(RuntimeKind::Claude, SkillScope::User)
            )
            .unwrap(),
            home.join("claude-home").join("skills")
        );
        assert!(home
            .join("claude-home")
            .join("skills")
            .join("pdf")
            .join("SKILL.md")
            .exists());
        assert!(!home.join(".skills").exists());
        assert!(!home.join("skills").exists());
    }

    #[test]
    fn public_root_and_slug_apis_match_the_runtime_scope_contract() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");

        assert_eq!(
            resolve_skill_root(RuntimeKind::Codex, SkillScope::Project, Some(&project)).unwrap(),
            project.join(".localprism").join("skills")
        );
        assert_eq!(validate_skill_slug("valid-skill_01"), Ok(()));
    }

    #[test]
    fn rejects_windows_unsafe_skill_folders_on_every_platform() {
        let invalid = [
            "foo:bar",
            "name<",
            "name>",
            "name\"",
            "name|",
            "name?",
            "name*",
            "name\u{1f}",
            "name.",
            "name ",
            " name",
            "\tname",
            "name\t",
        ];

        for folder in invalid {
            assert!(
                matches!(
                    validate_skill_slug(folder),
                    Err(SkillPathError::InvalidFolder(_))
                ),
                "folder should be rejected: {folder:?}"
            );
        }
    }

    #[test]
    fn rejects_windows_reserved_device_names_case_insensitively() {
        let mut invalid = vec![
            "CON".to_string(),
            "con.txt".to_string(),
            "CON .txt".to_string(),
            "PRN".to_string(),
            "prn .md".to_string(),
            "AUX".to_string(),
            "NUL".to_string(),
            "CONIN$".to_string(),
            "conout$".to_string(),
            "COM¹".to_string(),
            "com².txt".to_string(),
            "CoM³.md".to_string(),
            "LPT¹".to_string(),
            "lpt².txt".to_string(),
            "LpT³.md".to_string(),
        ];
        for number in 1..=9 {
            invalid.push(format!("COM{number}"));
            invalid.push(format!("com{number}.md"));
            invalid.push(format!("LPT{number}"));
            invalid.push(format!("lpt{number}.md"));
        }

        for folder in invalid {
            assert!(
                matches!(
                    validate_skill_slug(&folder),
                    Err(SkillPathError::InvalidFolder(_))
                ),
                "folder should be rejected: {folder:?}"
            );
        }
    }

    #[test]
    fn accepts_portable_unicode_and_non_reserved_device_like_names() {
        for folder in ["valid-skill_01", "Writer-Ω", "com10", "lpt0"] {
            assert_eq!(
                validate_skill_slug(folder),
                Ok(()),
                "folder should be accepted: {folder:?}"
            );
        }
    }

    #[test]
    fn rejects_a_canonical_destination_outside_the_selected_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        let error = ensure_canonical_skill_containment(&root, &outside).unwrap_err();
        assert!(matches!(error, SkillPathError::OutsideRoot { .. }));
    }

    #[test]
    fn install_folder_read_rules_cover_windows_and_posix_paths() {
        assert_eq!(
            super::install_folder_read_allow_rules(Path::new(r"D:\LocalPrism\claude-home\skills")),
            vec!["Read(//d/LocalPrism/claude-home/skills/**)".to_string()]
        );
        assert_eq!(
            super::install_folder_read_allow_rules(Path::new("/home/u/claude-home/skills")),
            vec!["Read(//home/u/claude-home/skills/**)".to_string()]
        );
    }

    #[test]
    fn overlays_missing_project_skills_into_isolated_claude_home() {
        let _guard = crate::providers::paths::lock_provider_env();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("lp-home");
        let project = temp.path().join("paper");
        let user_skill = home.join("skills").join("pdf");
        let project_skill = project.join(".localprism").join("skills").join("writer");
        std::fs::create_dir_all(&user_skill).unwrap();
        std::fs::create_dir_all(&project_skill).unwrap();
        std::fs::write(user_skill.join("SKILL.md"), "# PDF").unwrap();
        std::fs::write(project_skill.join("SKILL.md"), "# Writer").unwrap();

        let previous = std::env::var("LOCALPRISM_HOME").ok();
        std::env::set_var("LOCALPRISM_HOME", &home);
        let config = super::prepare_isolated_claude_home(Some(&project)).unwrap();
        if let Some(value) = previous {
            std::env::set_var("LOCALPRISM_HOME", value);
        } else {
            std::env::remove_var("LOCALPRISM_HOME");
        }

        assert_eq!(config, home.join("claude-home"));
        assert!(config.join("skills").join("pdf").join("SKILL.md").exists());
        assert!(config
            .join("skills")
            .join("writer")
            .join("SKILL.md")
            .exists());
        assert!(config.join("agents").is_dir());
        let settings = std::fs::read_to_string(config.join("settings.json")).unwrap();
        assert!(settings.contains("Read(//"));
        assert!(settings.contains("claude-home/skills/**"));
        assert!(settings.contains("claude-home/agents/**"));
    }

    #[test]
    fn overlays_leftover_dotted_dirs_after_preferred_content_exists() {
        let _guard = crate::providers::paths::lock_provider_env();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("lp-home");
        let preferred_skill = home.join("skills").join("pdf");
        let leftover_skill = home.join(".skills").join("legacy-pdf");
        let preferred_agent = home.join("agents").join("keep.md");
        let leftover_agent = home.join(".agents").join("reviewer.md");
        std::fs::create_dir_all(&preferred_skill).unwrap();
        std::fs::create_dir_all(&leftover_skill).unwrap();
        std::fs::create_dir_all(preferred_agent.parent().unwrap()).unwrap();
        std::fs::create_dir_all(leftover_agent.parent().unwrap()).unwrap();
        std::fs::write(preferred_skill.join("SKILL.md"), "# PDF").unwrap();
        std::fs::write(leftover_skill.join("SKILL.md"), "# Legacy").unwrap();
        std::fs::write(&preferred_agent, "---\nname: Keep\n---\nBody\n").unwrap();
        std::fs::write(&leftover_agent, "---\nname: Reviewer\n---\nBody\n").unwrap();

        let previous = std::env::var("LOCALPRISM_HOME").ok();
        std::env::set_var("LOCALPRISM_HOME", &home);
        let config = super::prepare_isolated_claude_home(None).unwrap();
        if let Some(value) = previous {
            std::env::set_var("LOCALPRISM_HOME", value);
        } else {
            std::env::remove_var("LOCALPRISM_HOME");
        }

        assert!(config.join("skills").join("pdf").join("SKILL.md").exists());
        assert!(config
            .join("skills")
            .join("legacy-pdf")
            .join("SKILL.md")
            .exists());
        assert!(config.join("agents").join("reviewer.md").exists());
        assert!(config.join("agents").join("keep.md").exists());
        let settings = std::fs::read_to_string(config.join("settings.json")).unwrap();
        assert!(settings.contains("claude-home/skills/**"));
        assert!(settings.contains("claude-home/agents/**"));
    }

    #[test]
    fn leftover_paperspine_migrates_but_project_copy_is_not_overlaid() {
        let _guard = crate::providers::paths::lock_provider_env();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("lp-home");
        let project = temp.path().join("paper");
        let leftover = home.join("skills").join("paper-spine");
        let project_skill = project
            .join(".localprism")
            .join("skills")
            .join("paper-spine-intake");
        std::fs::create_dir_all(&leftover).unwrap();
        std::fs::create_dir_all(&project_skill).unwrap();
        std::fs::write(leftover.join("SKILL.md"), "# PaperSpine host").unwrap();
        std::fs::write(project_skill.join("SKILL.md"), "# project overlay").unwrap();

        let previous = std::env::var("LOCALPRISM_HOME").ok();
        std::env::set_var("LOCALPRISM_HOME", &home);
        let config = super::prepare_isolated_claude_home(Some(&project)).unwrap();
        if let Some(value) = previous {
            std::env::set_var("LOCALPRISM_HOME", value);
        } else {
            std::env::remove_var("LOCALPRISM_HOME");
        }

        assert_eq!(config, home.join("claude-home"));
        assert!(config.join("skills").join("paper-spine").join("SKILL.md").exists());
        assert!(!config.join("skills").join("paper-spine-intake").exists());
    }

    #[test]
    fn accepts_existing_and_future_destinations_inside_the_selected_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        let existing = root.join("existing");
        std::fs::create_dir_all(&existing).unwrap();

        assert_eq!(skill_destination(&root, "existing").unwrap(), existing);
        assert_eq!(
            skill_destination(&root, "future").unwrap(),
            root.join("future")
        );
    }

    #[test]
    fn rejects_a_symlink_or_junction_that_escapes_the_selected_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        let outside = temp.path().join("outside");
        let link = root.join("escape");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        match create_directory_link(&outside, &link) {
            Ok(()) => {
                let error = skill_destination(&root, "escape").unwrap_err();
                assert!(matches!(error, SkillPathError::OutsideRoot { .. }));
            }
            Err(error) if link_creation_is_not_permitted(&error) => {
                // Windows can deny symlink creation without Developer Mode. Exercise the
                // same canonical containment seam rather than skipping the security check.
                let error = ensure_canonical_skill_containment(&root, &outside).unwrap_err();
                assert!(matches!(error, SkillPathError::OutsideRoot { .. }));
            }
            Err(error) => panic!("failed to create test directory link: {error}"),
        }
    }

    #[cfg(unix)]
    fn create_directory_link(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_directory_link(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_dir(target, link)
    }

    #[cfg(unix)]
    fn link_creation_is_not_permitted(error: &std::io::Error) -> bool {
        error.kind() == std::io::ErrorKind::PermissionDenied
    }

    #[cfg(windows)]
    fn link_creation_is_not_permitted(error: &std::io::Error) -> bool {
        matches!(error.raw_os_error(), Some(5 | 1314))
    }
}
