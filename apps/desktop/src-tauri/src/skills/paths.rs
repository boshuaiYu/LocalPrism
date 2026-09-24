use crate::runtime::RuntimeKind;
use crate::skills::domain::{SkillScope, SkillTarget};
use std::collections::HashSet;
use std::fmt;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

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

/// Extra skill folders forced into one Claude process, beyond the installed
/// academic listing.
///
/// Callers pass the active agent's attached skills plus a skill the user
/// invoked with `/name`. Those folders are published even when they belong to
/// the scientific tree. An empty list still lists installed academic skills.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionSkillExposure {
    pub folders: Vec<String>,
    /// Agent file to publish for `--agent`. `None` means this turn has no roster.
    pub agent_id: Option<String>,
}

impl SessionSkillExposure {
    pub fn none() -> Self {
        Self {
            folders: Vec::new(),
            agent_id: None,
        }
    }
}

/// Prepare the Claude home, then return a per-turn config directory.
///
/// Claude Code lists every skill under `$CLAUDE_CONFIG_DIR/skills` and loads a
/// body only when the Skill tool runs. The libraries stay under `claude-home`.
/// The returned runtime links session `projects` back to that home. Its
/// `skills` directory symlinks installed academic skills (so `skill_listing`
/// and the Skill tool see them) plus `exposure.folders`. The scientific tree
/// stays one catalog file, not one folder per lab. `agents` contains only
/// `exposure.agent_id`. `commands` and `slash` stay empty.
pub fn prepare_isolated_claude_home(
    project_path: Option<&Path>,
    exposure: &SessionSkillExposure,
) -> Result<PathBuf, SkillPathError> {
    let claude_home = crate::providers::paths::claude_config_dir()
        .map_err(|_| SkillPathError::HomeDirectoryUnavailable)?;
    ensure_claude_home_layout(&claude_home, project_path)?;

    let runtime = allocate_runtime_dir(&claude_home)?;
    // Session transcripts stay shared. Agents and slash commands do not:
    // Claude Code lists every file in those directories on each request.
    link_runtime_tree(&runtime, &claude_home, "projects")?;
    for name in ["agents", "slash", "commands"] {
        let path = runtime.join(name);
        std::fs::create_dir_all(&path).map_err(|error| SkillPathError::PathResolution {
            path,
            message: error.to_string(),
        })?;
    }
    publish_active_agent(&runtime, project_path, exposure.agent_id.as_deref())?;
    let dest_skills = runtime.join("skills");
    std::fs::create_dir_all(&dest_skills).map_err(|error| SkillPathError::PathResolution {
        path: dest_skills.clone(),
        message: error.to_string(),
    })?;
    let library = crate::providers::paths::user_skills_dir().ok();
    let project_skills = project_path
        .filter(|path| path.is_absolute())
        .map(|path| path.join(".localprism").join("skills"));
    sync_exposed_skills(
        &dest_skills,
        library.as_deref(),
        project_skills.as_deref(),
        exposure,
    )?;
    strip_host_bound_skill_overlays(&dest_skills)?;

    // Do not pass --add-dir to `claude -p`: sdk-cli waits for directory trust
    // and never calls the model. Pre-approve Read of the install folders instead.
    let _ = write_install_folder_read_allows(&runtime);
    if let Some(project) = project_path.filter(|path| path.is_absolute()) {
        crate::project_path_guard::install_path_guard_hook(&runtime, project).map_err(
            |message| SkillPathError::PathResolution {
                path: runtime.clone(),
                message,
            },
        )?;
    }

    Ok(runtime)
}

fn ensure_claude_home_layout(
    config_dir: &Path,
    project_path: Option<&Path>,
) -> Result<(), SkillPathError> {
    for name in ["skills", "agents", "slash", "commands", "projects"] {
        let path = config_dir.join(name);
        std::fs::create_dir_all(&path).map_err(|error| SkillPathError::PathResolution {
            path,
            message: error.to_string(),
        })?;
    }
    let dest_agents = config_dir.join("agents");
    let dest_slash = config_dir.join("slash");
    let dest_commands = config_dir.join("commands");
    if let Ok(home) = crate::providers::paths::localprism_home() {
        // Migrate leftover skill folders into the library. Do not publish them
        // into the Claude-scanned directory.
        let _ = crate::providers::paths::user_skills_dir();
        let user_agents = crate::providers::paths::user_agents_dir()
            .unwrap_or_else(|_| dest_agents.clone());
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
            &project.join(".localprism").join("agents"),
            &dest_agents,
        )?;
        overlay_missing_children(
            &crate::providers::paths::project_slash_dir(project),
            &dest_commands,
        )?;
    }
    Ok(())
}

fn allocate_runtime_dir(claude_home: &Path) -> Result<PathBuf, SkillPathError> {
    let root = claude_home.join("runtimes");
    std::fs::create_dir_all(&root).map_err(|error| SkillPathError::PathResolution {
        path: root.clone(),
        message: error.to_string(),
    })?;
    sweep_stale_runtimes(&root);
    let dir = root.join(uuid::Uuid::new_v4().simple().to_string());
    std::fs::create_dir_all(&dir).map_err(|error| SkillPathError::PathResolution {
        path: dir.clone(),
        message: error.to_string(),
    })?;
    Ok(dir)
}

fn sweep_stale_runtimes(root: &Path) {
    let Some(cutoff) = SystemTime::now().checked_sub(Duration::from_secs(6 * 60 * 60)) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if modified < cutoff {
            remove_runtime_dir(&path);
        }
    }
}

pub(crate) fn remove_runtime_dir(path: &Path) {
    for name in ["projects", "agents", "slash", "commands"] {
        unlink_symlink_only(&path.join(name));
    }
    if let Ok(entries) = std::fs::read_dir(path.join("agents")) {
        for entry in entries.flatten() {
            unlink_symlink_only(&entry.path());
        }
    }
    // Skill entries are symlinks into the library. Unlink them before
    // remove_dir_all so a sweep cannot delete the real skill folders.
    if let Ok(entries) = std::fs::read_dir(path.join("skills")) {
        for entry in entries.flatten() {
            unlink_symlink_only(&entry.path());
        }
    }
    let _ = std::fs::remove_dir_all(path);
}

fn unlink_symlink_only(path: &Path) {
    if path
        .symlink_metadata()
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        let _ = std::fs::remove_file(path);
    }
}

fn link_runtime_tree(
    runtime: &Path,
    claude_home: &Path,
    name: &str,
) -> Result<(), SkillPathError> {
    let target = claude_home.join(name);
    std::fs::create_dir_all(&target).map_err(|error| SkillPathError::PathResolution {
        path: target.clone(),
        message: error.to_string(),
    })?;
    let link = runtime.join(name);
    let relative = Path::new("..").join("..").join(name);
    symlink_directory(&relative, &target, &link).map_err(|message| {
        SkillPathError::PathResolution {
            path: link,
            message,
        }
    })
}

/// `CreateProcess` flag. A console-subsystem `cmd.exe` spawned from this GUI
/// otherwise allocates a visible console. Each chat turn creates a fresh
/// runtime directory and may fall back to `mklink /J` four times.
const WINDOWS_CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg_attr(not(any(windows, test)), allow(dead_code))]
struct JunctionCommand {
    program: &'static str,
    args: Vec<String>,
    creation_flags: u32,
}

#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn directory_junction_command(link: &Path, target: &Path) -> JunctionCommand {
    JunctionCommand {
        program: "cmd",
        args: vec![
            "/C".to_string(),
            "mklink".to_string(),
            "/J".to_string(),
            link.to_string_lossy().into_owned(),
            target.to_string_lossy().into_owned(),
        ],
        creation_flags: WINDOWS_CREATE_NO_WINDOW,
    }
}

fn symlink_directory(relative: &Path, absolute: &Path, link: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        let _ = absolute;
        std::os::unix::fs::symlink(relative, link).map_err(|error| error.to_string())
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = relative;
        if std::os::windows::fs::symlink_dir(absolute, link).is_ok() {
            return Ok(());
        }
        let junction = directory_junction_command(link, absolute);
        let mut command = std::process::Command::new(junction.program);
        command.args(&junction.args);
        command.creation_flags(junction.creation_flags);
        command.stdin(std::process::Stdio::null());
        command.stdout(std::process::Stdio::null());
        command.stderr(std::process::Stdio::null());
        let status = command.status().map_err(|error| error.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("failed to create directory junction ({status})"))
        }
    }
}

fn publish_active_agent(
    runtime: &Path,
    project_path: Option<&Path>,
    agent_id: Option<&str>,
) -> Result<(), SkillPathError> {
    let dest_dir = runtime.join("agents");
    std::fs::create_dir_all(&dest_dir).map_err(|error| SkillPathError::PathResolution {
        path: dest_dir.clone(),
        message: error.to_string(),
    })?;
    let Some(agent_id) = agent_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    let Ok(slug) = crate::agents::validate_agent_slug(agent_id) else {
        return Ok(());
    };
    if crate::agents::is_skill_pack_bundled_agent(&slug) {
        return Ok(());
    }
    let file_name = format!("{slug}.md");
    let project = project_path.filter(|path| path.is_absolute());
    let source = project
        .map(|path| path.join(".localprism").join("agents").join(&file_name))
        .filter(|path| path.is_file())
        .or_else(|| {
            crate::providers::paths::user_agents_dir()
                .ok()
                .map(|root| root.join(&file_name))
                .filter(|path| path.is_file())
        });
    let Some(source) = source else {
        return Ok(());
    };
    let dest = dest_dir.join(&file_name);
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&source, &dest).map_err(|error| {
            SkillPathError::PathResolution {
                path: dest,
                message: error.to_string(),
            }
        })?;
    }
    #[cfg(windows)]
    {
        std::fs::copy(&source, &dest).map_err(|error| SkillPathError::PathResolution {
            path: dest,
            message: error.to_string(),
        })?;
    }
    Ok(())
}

/// One session entry for the scientific-agent-skills tree. Claude lists this
/// name; the body is a path index loaded only if the Skill tool opens it.
const SCIENTIFIC_CATALOG_FOLDER: &str = "scientific-agent-skills";

const SCIENTIFIC_PACK_MARKERS: &[&str] = &["scanpy", "biopython", "rdkit"];

fn sync_exposed_skills(
    dest: &Path,
    library: Option<&Path>,
    project_skills: Option<&Path>,
    exposure: &SessionSkillExposure,
) -> Result<(), SkillPathError> {
    if let Some(library) = library.filter(|path| path.exists()) {
        if is_same_path(dest, library) {
            return Err(SkillPathError::PathResolution {
                path: dest.to_path_buf(),
                message: "Refusing to replace the skill library with a session view".into(),
            });
        }
    }
    std::fs::create_dir_all(dest).map_err(|error| SkillPathError::PathResolution {
        path: dest.to_path_buf(),
        message: error.to_string(),
    })?;
    let mut seen = HashSet::new();
    for folder in &exposure.folders {
        let trimmed = folder.trim();
        if trimmed.is_empty()
            || crate::skills::paperspine::is_host_bound_skill_folder(trimmed)
        {
            continue;
        }
        if !seen.insert(trimmed.to_ascii_lowercase()) {
            continue;
        }
        let source = project_skills
            .and_then(|root| find_named_skill_dir(root, trimmed))
            .or_else(|| library.and_then(|root| find_named_skill_dir(root, trimmed)));
        let Some(source) = source else {
            continue;
        };
        let Some(name) = source.file_name() else {
            continue;
        };
        if crate::skills::paperspine::is_host_bound_skill_folder(&name.to_string_lossy()) {
            continue;
        }
        publish_skill_dir(&source, &dest.join(name))?;
    }

    let sources = manifest_source_urls();
    let mut installed = Vec::new();
    if let Some(root) = project_skills {
        installed.extend(list_installed_skill_dirs(root, true));
    }
    if let Some(root) = library {
        installed.extend(list_installed_skill_dirs(root, false));
    }
    let mut by_folder: Vec<InstalledSkillDir> = Vec::new();
    let mut folder_names = HashSet::new();
    for skill in installed {
        let key = skill.name.to_ascii_lowercase();
        if !folder_names.insert(key) {
            continue;
        }
        by_folder.push(skill);
    }
    let names: HashSet<String> = by_folder
        .iter()
        .map(|skill| skill.name.to_ascii_lowercase())
        .collect();
    let scientific_tree = scientific_tree_installed(&names, &sources);
    let mut deferred: Vec<InstalledSkillDir> = Vec::new();
    for skill in by_folder {
        let key = skill.name.to_ascii_lowercase();
        if seen.contains(&key) {
            continue;
        }
        if !list_skill_directly(&skill, scientific_tree, sources.get(&key).map(String::as_str))
        {
            deferred.push(skill);
            continue;
        }
        if !seen.insert(key) {
            continue;
        }
        publish_skill_dir(&skill.path, &dest.join(&skill.name))?;
    }
    if !deferred.is_empty() && !seen.contains(SCIENTIFIC_CATALOG_FOLDER) {
        write_scientific_catalog(dest, &deferred)?;
    }
    Ok(())
}

#[derive(Clone)]
struct InstalledSkillDir {
    name: String,
    path: PathBuf,
    from_project: bool,
}

fn list_installed_skill_dirs(root: &Path, from_project: bool) -> Vec<InstalledSkillDir> {
    let mut skills = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return skills;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if validate_skill_slug(&name).is_err()
            || crate::skills::paperspine::is_host_bound_skill_folder(&name)
        {
            continue;
        }
        if !path.join("SKILL.md").is_file() && !path.join("skill.md").is_file() {
            continue;
        }
        skills.push(InstalledSkillDir {
            name,
            path,
            from_project,
        });
    }
    skills
}

fn manifest_source_urls() -> std::collections::HashMap<String, String> {
    let Ok(home) = crate::providers::paths::localprism_home() else {
        return std::collections::HashMap::new();
    };
    let Ok(manifest) = crate::skills::manifest::ManifestStore::new(home).load() else {
        return std::collections::HashMap::new();
    };
    let mut urls = std::collections::HashMap::new();
    for entry in manifest.entries {
        if let Some(url) = crate::skills::manifest::source_url_from_skill_source(&entry.source) {
            urls.insert(entry.folder.to_ascii_lowercase(), url);
        }
    }
    urls
}

fn is_scientific_source_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.contains("scientific-agent-skills") || lower.contains("claude-scientific-skills")
}

fn is_academic_pack_folder(name: &str) -> bool {
    let key = name.trim().to_ascii_lowercase();
    key.starts_with("academic-")
        || key.starts_with("academic_")
        || key.starts_with("nature-")
        || key.starts_with("nature_")
        || key.starts_with("paper-humanizer")
        || matches!(
            key.as_str(),
            "deep-research" | "literature-review" | "peer-review" | "reference-checker"
        )
}

fn scientific_tree_installed(
    names: &HashSet<String>,
    sources: &std::collections::HashMap<String, String>,
) -> bool {
    if sources.values().any(|url| is_scientific_source_url(url)) {
        return true;
    }
    SCIENTIFIC_PACK_MARKERS
        .iter()
        .all(|marker| names.contains(*marker))
}

fn list_skill_directly(
    skill: &InstalledSkillDir,
    scientific_tree: bool,
    source_url: Option<&str>,
) -> bool {
    if source_url.is_some_and(is_scientific_source_url) {
        return false;
    }
    if is_academic_pack_folder(&skill.name) || skill.from_project {
        return true;
    }
    if source_url.is_some_and(|url| !url.trim().is_empty()) {
        return true;
    }
    !scientific_tree
}

fn write_scientific_catalog(dest: &Path, skills: &[InstalledSkillDir]) -> Result<(), SkillPathError> {
    let dir = dest.join(SCIENTIFIC_CATALOG_FOLDER);
    std::fs::create_dir_all(&dir).map_err(|error| SkillPathError::PathResolution {
        path: dir.clone(),
        message: error.to_string(),
    })?;
    let mut body = String::from(
        "---\n\
         name: scientific-agent-skills\n\
         description: Index of installed scientific-agent-skills lab tools. Use when a task needs one domain tool. Load that one skill file only; do not load the tree.\n\
         ---\n\
         \n\
         This pack is one catalog. Read exactly one SKILL.md for the tool this task needs. Do not read the other files.\n\
         \n",
    );
    let mut ordered = skills.to_vec();
    ordered.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
    });
    for skill in ordered {
        let skill_md = if skill.path.join("SKILL.md").is_file() {
            skill.path.join("SKILL.md")
        } else {
            skill.path.join("skill.md")
        };
        body.push_str(&format!("- {}: {}\n", skill.name, skill_md.display()));
    }
    let file = dir.join("SKILL.md");
    std::fs::write(&file, body).map_err(|error| SkillPathError::PathResolution {
        path: file,
        message: error.to_string(),
    })
}

fn find_named_skill_dir(root: &Path, folder: &str) -> Option<PathBuf> {
    if !root.is_dir() {
        return None;
    }
    let wanted = folder.trim();
    if validate_skill_slug(wanted).is_err()
        || crate::skills::paperspine::is_host_bound_skill_folder(wanted)
    {
        return None;
    }
    let direct = root.join(wanted);
    if direct.is_dir() {
        return Some(direct);
    }
    let lower = wanted.to_ascii_lowercase();
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let name = entry.file_name();
        if name.to_string_lossy().to_ascii_lowercase() == lower {
            return Some(entry.path());
        }
    }
    None
}

fn publish_skill_dir(source: &Path, dest: &Path) -> Result<(), SkillPathError> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(source, dest).map_err(|error| SkillPathError::PathResolution {
            path: dest.to_path_buf(),
            message: error.to_string(),
        })
    }
    #[cfg(windows)]
    {
        if std::os::windows::fs::symlink_dir(source, dest).is_ok() {
            return Ok(());
        }
        copy_path_recursive(source, dest)
    }
}

fn is_same_path(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
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
        let metadata = path.symlink_metadata().map_err(|error| SkillPathError::PathResolution {
            path: path.clone(),
            message: error.to_string(),
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            std::fs::remove_file(&path).map_err(|error| SkillPathError::PathResolution {
                path: path.clone(),
                message: error.to_string(),
            })?;
        } else {
            std::fs::remove_dir_all(&path).map_err(|error| SkillPathError::PathResolution {
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
    fn directory_junction_fallback_does_not_open_a_console() {
        let command = super::directory_junction_command(
            Path::new(r"D:\LocalPrism\claude-home\runtimes\abc\projects"),
            Path::new(r"D:\LocalPrism\claude-home\projects"),
        );
        assert_eq!(command.program, "cmd");
        assert_eq!(
            command.args,
            vec![
                "/C".to_string(),
                "mklink".to_string(),
                "/J".to_string(),
                r"D:\LocalPrism\claude-home\runtimes\abc\projects".to_string(),
                r"D:\LocalPrism\claude-home\projects".to_string(),
            ]
        );
        assert_eq!(command.creation_flags, super::WINDOWS_CREATE_NO_WINDOW);
        assert_ne!(command.creation_flags, 0);
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
        let user_skill = home.join("skills").join("nature-writing");
        let project_skill = project.join(".localprism").join("skills").join("writer");
        std::fs::create_dir_all(&user_skill).unwrap();
        std::fs::create_dir_all(&project_skill).unwrap();
        std::fs::write(
            user_skill.join("SKILL.md"),
            "---\nname: nature-writing\ndescription: Revise prose\n---\n# Nature\n",
        )
        .unwrap();
        std::fs::write(project_skill.join("SKILL.md"), "# Writer").unwrap();
        for name in ["scanpy", "biopython", "rdkit", "waypoint-bio"] {
            let skill = home.join("skills").join(name);
            std::fs::create_dir_all(&skill).unwrap();
            std::fs::write(skill.join("SKILL.md"), format!("# {name}\n")).unwrap();
        }

        let previous = std::env::var("LOCALPRISM_HOME").ok();
        std::env::set_var("LOCALPRISM_HOME", &home);
        let exposure = super::SessionSkillExposure {
            folders: vec!["writer".into()],
            agent_id: None,
        };
        let config = super::prepare_isolated_claude_home(Some(&project), &exposure).unwrap();
        if let Some(value) = previous {
            std::env::set_var("LOCALPRISM_HOME", value);
        } else {
            std::env::remove_var("LOCALPRISM_HOME");
        }

        assert!(config.starts_with(home.join("claude-home").join("runtimes")));
        assert_ne!(config, home.join("claude-home"));
        assert!(config
            .join("skills")
            .join("nature-writing")
            .join("SKILL.md")
            .exists());
        assert!(config
            .join("skills")
            .join("writer")
            .join("SKILL.md")
            .exists());
        assert!(!config.join("skills").join("waypoint-bio").exists());
        assert!(!config.join("skills").join("scanpy").exists());
        let catalog = std::fs::read_to_string(
            config
                .join("skills")
                .join("scientific-agent-skills")
                .join("SKILL.md"),
        )
        .unwrap();
        assert!(catalog.contains("waypoint-bio"));
        assert!(!catalog.contains("# waypoint"));
        assert!(home
            .join("claude-home")
            .join("skills")
            .join("waypoint-bio")
            .join("SKILL.md")
            .exists());
        assert!(config.join("agents").is_dir());
        let settings = std::fs::read_to_string(config.join("settings.json")).unwrap();
        assert!(settings.contains("Read(//"));
        assert!(settings.contains("claude-home/skills/**"));
        assert!(settings.contains("claude-home/agents/**"));
        assert!(settings.contains("--bind-project-path"));
        assert!(settings.contains("path-guard.json"));
        let spec: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(config.join("path-guard.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            spec["project"].as_str(),
            Some(project.to_string_lossy().as_ref())
        );
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
        let config =
            super::prepare_isolated_claude_home(None, &super::SessionSkillExposure::none()).unwrap();
        if let Some(value) = previous {
            std::env::set_var("LOCALPRISM_HOME", value);
        } else {
            std::env::remove_var("LOCALPRISM_HOME");
        }

        let library = home.join("claude-home").join("skills");
        assert!(library.join("pdf").join("SKILL.md").exists());
        assert!(library.join("legacy-pdf").join("SKILL.md").exists());
        let listed: Vec<_> = config
            .join("skills")
            .read_dir()
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert!(listed.iter().any(|name| name == "pdf"));
        assert!(listed.iter().any(|name| name == "legacy-pdf"));
        assert_eq!(listed.len(), 2);
        assert!(home
            .join("claude-home")
            .join("agents")
            .join("reviewer.md")
            .exists());
        assert!(home
            .join("claude-home")
            .join("agents")
            .join("keep.md")
            .exists());
        assert_eq!(
            config
                .join("agents")
                .read_dir()
                .unwrap()
                .flatten()
                .count(),
            0,
            "a turn with no agent must not publish the agent roster"
        );
        let settings = std::fs::read_to_string(config.join("settings.json")).unwrap();
        assert!(settings.contains("claude-home/skills/**"));
        assert!(settings.contains("claude-home/agents/**"));
    }

    #[test]
    fn session_exposure_rejects_paths_outside_the_skill_root() {
        let _guard = crate::providers::paths::lock_provider_env();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("lp-home");
        let library = home.join("claude-home").join("skills");
        let secret = home.join("claude-home").join("providers");
        std::fs::create_dir_all(library.join("scanpy")).unwrap();
        std::fs::create_dir_all(&secret).unwrap();
        std::fs::write(library.join("scanpy").join("SKILL.md"), "# Scanpy").unwrap();
        std::fs::write(secret.join("secret.txt"), "nope").unwrap();

        let previous = std::env::var("LOCALPRISM_HOME").ok();
        std::env::set_var("LOCALPRISM_HOME", &home);
        let exposure = super::SessionSkillExposure {
            folders: vec![
                "../providers".into(),
                "/tmp".into(),
                "skills/scanpy".into(),
                "..".into(),
                "scanpy".into(),
            ],
            agent_id: None,
        };
        let config = super::prepare_isolated_claude_home(None, &exposure).unwrap();
        if let Some(value) = previous {
            std::env::set_var("LOCALPRISM_HOME", value);
        } else {
            std::env::remove_var("LOCALPRISM_HOME");
        }

        let names: Vec<_> = std::fs::read_dir(config.join("skills"))
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["scanpy".to_string()]);
        assert!(secret.join("secret.txt").is_file());
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

        let writer = home.join("skills").join("writer");
        std::fs::create_dir_all(&writer).unwrap();
        std::fs::write(writer.join("SKILL.md"), "# Writer").unwrap();

        let previous = std::env::var("LOCALPRISM_HOME").ok();
        std::env::set_var("LOCALPRISM_HOME", &home);
        let exposure = super::SessionSkillExposure {
            folders: vec![
                "paper-spine".into(),
                "paper-spine-intake".into(),
                "writer".into(),
            ],
            agent_id: None,
        };
        let config = super::prepare_isolated_claude_home(Some(&project), &exposure).unwrap();
        if let Some(value) = previous {
            std::env::set_var("LOCALPRISM_HOME", value);
        } else {
            std::env::remove_var("LOCALPRISM_HOME");
        }

        assert!(config.starts_with(home.join("claude-home").join("runtimes")));
        assert!(home
            .join("claude-home")
            .join("skills")
            .join("paper-spine")
            .join("SKILL.md")
            .exists());
        assert!(config.join("skills").join("writer").join("SKILL.md").exists());
        assert!(!config.join("skills").join("paper-spine").exists());
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
