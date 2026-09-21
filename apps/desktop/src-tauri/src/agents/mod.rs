pub mod claude;
pub mod codex;

use crate::runtime::RuntimeKind;
use crate::skills::domain::SkillScope;
use crate::skills::import::{find_skill_md, list_runtime_skills};
use crate::skills::paths::validate_skill_slug;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfile {
    pub id: String,
    pub runtime: RuntimeKind,
    pub scope: SkillScope,
    pub name: String,
    pub description: String,
    pub instructions: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub sandbox_mode: Option<String>,
    pub permission_mode: Option<String>,
    pub tools: Vec<String>,
    pub nickname_candidates: Vec<String>,
    pub skill_ids: Vec<String>,
    pub source_path: String,
    #[serde(default)]
    pub unknown_fields: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentError {
    Message(String),
}

impl std::fmt::Display for AgentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Message(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for AgentError {}

impl From<String> for AgentError {
    fn from(value: String) -> Self {
        Self::Message(value)
    }
}

impl From<&str> for AgentError {
    fn from(value: &str) -> Self {
        Self::Message(value.to_string())
    }
}

pub fn validate_agent_slug(raw: &str) -> Result<String, AgentError> {
    let normalized = raw
        .trim()
        .chars()
        .map(|character| {
            if character.is_ascii_whitespace() {
                '-'
            } else {
                character.to_ascii_lowercase()
            }
        })
        .collect::<String>();
    if normalized.is_empty() {
        return Err(AgentError::from("Agent name/slug cannot be empty"));
    }
    if !normalized.chars().all(|character| {
        character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || matches!(character, '_' | '-')
    }) {
        return Err(AgentError::from(
            "Agent slug may only contain lowercase letters, digits, '_' and '-'",
        ));
    }
    validate_skill_slug(&normalized).map_err(|error| AgentError::from(error.to_string()))?;
    Ok(normalized)
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), AgentError> {
    let parent = path
        .parent()
        .ok_or_else(|| AgentError::from("Agent path is missing a parent directory"))?;
    fs::create_dir_all(parent).map_err(|error| {
        AgentError::from(format!("Failed to create {}: {error}", parent.display()))
    })?;
    let temp_path = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("agent"),
        Uuid::new_v4().simple()
    ));
    fs::write(&temp_path, bytes).map_err(|error| {
        AgentError::from(format!(
            "Failed to write temporary agent file {}: {error}",
            temp_path.display()
        ))
    })?;
    if let Err(error) = replace_file(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(AgentError::from(format!(
            "Failed to replace {}: {error}",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    fn wide(path: &Path) -> io::Result<Vec<u16>> {
        let mut value = path.as_os_str().encode_wide().collect::<Vec<_>>();
        if value.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "path contains an interior NUL",
            ));
        }
        value.push(0);
        Ok(value)
    }

    let source = wide(source)?;
    let destination = wide(destination)?;
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

fn agent_path(
    runtime: RuntimeKind,
    scope: SkillScope,
    slug: &str,
    project_path: Option<&Path>,
) -> Result<PathBuf, AgentError> {
    let root = match runtime {
        RuntimeKind::Claude => claude::agents_root(scope, project_path)?,
        RuntimeKind::Codex => codex::agents_root(scope, project_path)?,
    };
    let extension = match runtime {
        RuntimeKind::Claude => "md",
        RuntimeKind::Codex => "toml",
    };
    Ok(root.join(format!("{slug}.{extension}")))
}

fn list_scope(
    runtime: RuntimeKind,
    scope: SkillScope,
    project_path: Option<&Path>,
) -> Result<Vec<AgentProfile>, AgentError> {
    let root = match runtime {
        RuntimeKind::Claude => claude::agents_root(scope, project_path)?,
        RuntimeKind::Codex => codex::agents_root(scope, project_path)?,
    };
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut agents = Vec::new();
    let entries = fs::read_dir(&root)
        .map_err(|error| AgentError::from(format!("Failed to read {}: {error}", root.display())))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(extension) = path.extension().and_then(|ext| ext.to_str()) else {
            continue;
        };
        let profile = match (runtime, extension) {
            (RuntimeKind::Claude, "md") => claude::parse_claude_agent(&path, scope),
            (RuntimeKind::Codex, "toml") => codex::parse_codex_agent(&path, scope),
            _ => continue,
        };
        if let Ok(profile) = profile {
            if is_skill_pack_bundled_agent(&profile.id) {
                continue;
            }
            agents.push(profile);
        }
    }
    agents.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
    Ok(agents)
}

/// Skill-pack team files stay on disk but are not picker items.
/// Official usage is the parent skill / slash command, not this roster.
pub fn is_skill_pack_bundled_agent(id: &str) -> bool {
    let key = id.trim().to_ascii_lowercase();
    if key.ends_with("_agent") {
        return true;
    }
    matches!(
        key.as_str(),
        "research-exemplar"
            | "research-scene"
            | "research-sota"
            | "reviewer-evidence"
            | "reviewer-method"
            | "reviewer-writing"
    )
}

fn is_skipped_walk_dir(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | ".agents" | "agents" | "target" | "dist" | "docs" | "tests"
    )
}

fn is_agent_profile_filename(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".md")
        && !matches!(
            lower.as_str(),
            "agents.md" | "claude.md" | "readme.md" | "changelog.md" | "license.md"
        )
}

fn collect_agent_files_in_dir(dir: &Path, output: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() || !file_type.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if is_agent_profile_filename(name) {
            output.push(path);
        }
    }
}

/// Claude Code / skill-pack agent profiles live in `agents/` or `.claude/agents/`.
pub fn collect_agent_profile_files(root: &Path, output: &mut Vec<PathBuf>) {
    if !root.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.eq_ignore_ascii_case("agents") {
            collect_agent_files_in_dir(&path, output);
            continue;
        }
        if is_skipped_walk_dir(&name) {
            continue;
        }
        collect_agent_profile_files(&path, output);
    }
}

/// Copy discovered agent profiles into LocalPrism user-scope `claude-home/agents`. Never overwrite.
pub fn import_user_agents_from_source(root: &Path) -> Result<usize, AgentError> {
    let destination = crate::providers::paths::user_agents_dir().map_err(AgentError::from)?;
    fs::create_dir_all(&destination).map_err(|error| {
        AgentError::from(format!(
            "Failed to create {}: {error}",
            destination.display()
        ))
    })?;

    let mut files = Vec::new();
    collect_agent_profile_files(root, &mut files);
    files.sort();

    let mut imported = 0usize;
    let mut seen = HashSet::new();
    for file in files {
        let Some(stem) = file.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        let Ok(slug) = validate_agent_slug(stem) else {
            continue;
        };
        if !seen.insert(slug.clone()) {
            continue;
        }
        let dest_file = destination.join(format!("{slug}.md"));
        if dest_file.exists() {
            continue;
        }
        let Ok(profile) = claude::parse_claude_agent(&file, SkillScope::User) else {
            continue;
        };
        if profile.description.is_empty() && profile.instructions.trim().is_empty() {
            continue;
        }
        fs::copy(&file, &dest_file).map_err(|error| {
            AgentError::from(format!(
                "Failed to copy agent {} to {}: {error}",
                file.display(),
                dest_file.display()
            ))
        })?;
        imported += 1;
    }
    Ok(imported)
}

fn is_fatal_skill_discovery_error(error: &str) -> bool {
    !error
        .to_ascii_lowercase()
        .contains("legacy claude skill is missing")
}

fn skill_matches_assignment(
    skill: &crate::skills::domain::RuntimeSkill,
    skill_id: &str,
    profile: &AgentProfile,
) -> bool {
    let id_ok =
        skill.folder == skill_id || skill.id == skill_id || skill.name == skill_id;
    let target_ok = skill.targets.iter().any(|target| {
        target.runtime == profile.runtime && target.scope == profile.scope
    });
    id_ok && target_ok
}

fn resolve_skill_paths(
    profile: &AgentProfile,
    project_path: Option<&Path>,
) -> Result<Vec<(String, PathBuf)>, AgentError> {
    if profile.skill_ids.is_empty() {
        return Ok(Vec::new());
    }
    let catalog =
        list_runtime_skills(project_path).map_err(|error| AgentError::from(error.to_string()))?;
    let mut resolved = Vec::new();
    for skill_id in &profile.skill_ids {
        let skill = catalog
            .iter()
            .find(|candidate| skill_matches_assignment(candidate, skill_id, profile))
            .ok_or_else(|| {
                AgentError::from(format!("Assigned skill '{skill_id}' was not found"))
            })?;
        if skill
            .discovery_error
            .as_deref()
            .is_some_and(is_fatal_skill_discovery_error)
        {
            return Err(AgentError::from(format!(
                "Assigned skill '{skill_id}' has a discovery error"
            )));
        }
        let has_target = skill
            .targets
            .iter()
            .any(|target| target.runtime == profile.runtime && target.scope == profile.scope);
        if !has_target {
            return Err(AgentError::from(format!(
                "Assigned skill '{skill_id}' is not available for {:?} {:?}",
                profile.runtime, profile.scope
            )));
        }
        let skill_md = find_skill_md(Path::new(&skill.source_path)).ok_or_else(|| {
            AgentError::from(format!(
                "Assigned skill '{skill_id}' is missing SKILL.md at {}",
                skill.source_path
            ))
        })?;
        resolved.push((skill.folder.clone(), skill_md));
    }
    Ok(resolved)
}

#[tauri::command]
pub async fn list_agents(
    runtime: RuntimeKind,
    project_path: Option<String>,
) -> Result<Vec<AgentProfile>, String> {
    let project = project_path.as_deref().map(Path::new);
    let mut agents = list_scope(runtime, SkillScope::User, project).map_err(|e| e.to_string())?;
    if project.is_some() {
        let mut project_agents =
            list_scope(runtime, SkillScope::Project, project).map_err(|e| e.to_string())?;
        // Project agents first for display precedence, then user agents.
        project_agents.append(&mut agents);
        return Ok(project_agents);
    }
    Ok(agents)
}

#[tauri::command]
pub async fn get_agent(
    runtime: RuntimeKind,
    scope: SkillScope,
    agent_id: String,
    project_path: Option<String>,
) -> Result<AgentProfile, String> {
    let slug = validate_agent_slug(&agent_id).map_err(|e| e.to_string())?;
    let path = agent_path(
        runtime,
        scope,
        &slug,
        project_path.as_deref().map(Path::new),
    )
    .map_err(|e| e.to_string())?;
    if !path.exists() {
        return Err(format!("Agent '{slug}' was not found"));
    }
    match runtime {
        RuntimeKind::Claude => claude::parse_claude_agent(&path, scope).map_err(|e| e.to_string()),
        RuntimeKind::Codex => codex::parse_codex_agent(&path, scope).map_err(|e| e.to_string()),
    }
}

#[tauri::command]
pub async fn save_agent(
    mut profile: AgentProfile,
    project_path: Option<String>,
    overwrite: bool,
) -> Result<AgentProfile, String> {
    let slug = validate_agent_slug(if profile.id.trim().is_empty() {
        &profile.name
    } else {
        &profile.id
    })
    .map_err(|e| e.to_string())?;
    profile.id = slug.clone();
    if profile.name.trim().is_empty() {
        profile.name = slug.clone();
    }

    let project = project_path.as_deref().map(Path::new);
    let path =
        agent_path(profile.runtime, profile.scope, &slug, project).map_err(|e| e.to_string())?;

    if path.exists() && !overwrite {
        return Err(format!(
            "Agent '{slug}' already exists at {}. Pass overwrite=true to replace it.",
            path.display()
        ));
    }

    if path.exists() && overwrite {
        // Preserve unknown fields from the existing unmanaged/native file.
        let existing = match profile.runtime {
            RuntimeKind::Claude => claude::parse_claude_agent(&path, profile.scope),
            RuntimeKind::Codex => codex::parse_codex_agent(&path, profile.scope),
        }
        .map_err(|e| e.to_string())?;
        for (key, value) in existing.unknown_fields {
            profile.unknown_fields.entry(key).or_insert(value);
        }
        let stamp = Utc::now().format("%Y%m%dT%H%M%SZ");
        let backup = path.with_extension(format!(
            "{}.{stamp}.bak",
            path.extension()
                .and_then(|ext| ext.to_str())
                .unwrap_or("agent")
        ));
        fs::copy(&path, &backup).map_err(|e| format!("Failed to back up agent: {e}"))?;
    }

    let skill_paths = resolve_skill_paths(&profile, project).map_err(|e| e.to_string())?;
    match profile.runtime {
        RuntimeKind::Claude => {
            // Claude stores native skill names (folder / declared names), not UI IDs.
            profile.skill_ids = skill_paths
                .iter()
                .map(|(folder, _)| folder.clone())
                .collect();
            claude::write_claude_agent(&path, &profile).map_err(|e| e.to_string())?;
        }
        RuntimeKind::Codex => {
            codex::write_codex_agent(&path, &profile, &skill_paths).map_err(|e| e.to_string())?;
        }
    }

    profile.source_path = path.to_string_lossy().to_string();
    Ok(profile)
}

#[tauri::command]
pub async fn delete_agent(
    runtime: RuntimeKind,
    scope: SkillScope,
    agent_id: String,
    project_path: Option<String>,
) -> Result<(), String> {
    let slug = validate_agent_slug(&agent_id).map_err(|e| e.to_string())?;
    let path = agent_path(
        runtime,
        scope,
        &slug,
        project_path.as_deref().map(Path::new),
    )
    .map_err(|e| e.to_string())?;
    if !path.exists() {
        return Err(format!("Agent '{slug}' was not found"));
    }
    fs::remove_file(&path).map_err(|e| format!("Failed to delete agent: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::RuntimeKind;
    use crate::skills::domain::SkillScope;
    use std::fs;

    #[test]
    fn legacy_compatibility_notes_are_not_fatal_assignment_errors() {
        assert!(!is_fatal_skill_discovery_error(
            "Legacy Claude skill is missing a standard description and can only target Claude."
        ));
        assert!(!is_fatal_skill_discovery_error(
            "Legacy Claude skill is missing a standard name frontmatter field and can only target Claude."
        ));
        assert!(is_fatal_skill_discovery_error("missing SKILL.md"));
    }

    fn sample_skill(
        id: &str,
        folder: &str,
        scope: SkillScope,
    ) -> crate::skills::domain::RuntimeSkill {
        crate::skills::domain::RuntimeSkill {
            id: id.into(),
            name: folder.into(),
            description: String::new(),
            folder: folder.into(),
            source_path: String::new(),
            source_url: None,
            targets: vec![crate::skills::domain::SkillTarget {
                runtime: RuntimeKind::Claude,
                scope,
            }],
            managed: true,
            compatible_runtimes: vec![RuntimeKind::Claude],
            enabled: true,
            discovery_error: None,
        }
    }

    fn sample_profile(scope: SkillScope) -> AgentProfile {
        AgentProfile {
            id: "reviewer".into(),
            runtime: RuntimeKind::Claude,
            scope,
            name: "reviewer".into(),
            description: String::new(),
            instructions: String::new(),
            model: None,
            reasoning_effort: None,
            sandbox_mode: None,
            permission_mode: None,
            tools: vec![],
            nickname_candidates: vec![],
            skill_ids: vec!["writer".into()],
            source_path: String::new(),
            unknown_fields: Default::default(),
        }
    }

    #[test]
    fn assignment_matches_the_same_scope_when_folder_is_duplicated() {
        let user = sample_skill("claude:user:writer", "writer", SkillScope::User);
        let project = sample_skill("claude:project:writer", "writer", SkillScope::Project);
        let profile = sample_profile(SkillScope::Project);
        assert!(!skill_matches_assignment(&user, "writer", &profile));
        assert!(skill_matches_assignment(&project, "writer", &profile));
    }

    #[test]
    fn collects_nested_agents_and_skips_plugin_dirs() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("agents")).unwrap();
        fs::create_dir_all(root.join("deep-research/agents")).unwrap();
        fs::create_dir_all(root.join(".agents/plugins")).unwrap();
        fs::create_dir_all(root.join("agents/plugins")).unwrap();
        fs::write(
            root.join("agents/research_architect_agent.md"),
            "---\nname: architect\ndescription: Designs the study\n---\nBody\n",
        )
        .unwrap();
        fs::write(
            root.join("deep-research/agents/socratic_mentor_agent.md"),
            "---\nname: mentor\ndescription: Asks questions\n---\nBody\n",
        )
        .unwrap();
        fs::write(root.join(".agents/plugins/not-an-agent.md"), "ignore\n").unwrap();
        fs::write(root.join("agents/plugins/also-not-an-agent.md"), "ignore\n").unwrap();
        fs::write(root.join("agents/AGENTS.md"), "# repo instructions\n").unwrap();

        let mut files = Vec::new();
        collect_agent_profile_files(root, &mut files);
        let names: Vec<_> = files
            .iter()
            .filter_map(|path| path.file_name().and_then(|name| name.to_str()))
            .collect();
        assert!(names.contains(&"research_architect_agent.md"));
        assert!(names.contains(&"socratic_mentor_agent.md"));
        assert!(!names.iter().any(|name| name.eq_ignore_ascii_case("AGENTS.md")));
        assert!(!names.contains(&"not-an-agent.md"));
        assert!(!names.contains(&"also-not-an-agent.md"));
    }

    #[test]
    fn skips_existing_user_agents() {
        let _guard = crate::providers::paths::lock_provider_env();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let previous = std::env::var_os("LOCALPRISM_HOME");
        std::env::set_var("LOCALPRISM_HOME", &home);

        let source = temp.path().join("source");
        fs::create_dir_all(source.join("agents")).unwrap();
        fs::write(
            source.join("agents/research_architect_agent.md"),
            "---\nname: architect\ndescription: Designs the study\n---\nBody\n",
        )
        .unwrap();

        let first = import_user_agents_from_source(&source).unwrap();
        let second = import_user_agents_from_source(&source).unwrap();
        if let Some(value) = previous {
            std::env::set_var("LOCALPRISM_HOME", value);
        } else {
            std::env::remove_var("LOCALPRISM_HOME");
        }
        assert_eq!(first, 1);
        assert_eq!(second, 0);
        assert!(home
            .join("claude-home")
            .join("agents")
            .join("research_architect_agent.md")
            .is_file());
    }

    #[test]
    fn rejects_unsafe_agent_slugs() {
        for slug in ["", ".", "..", "../x", "a/b", "CON", "Hello World!"] {
            assert!(validate_agent_slug(slug).is_err(), "{slug}");
        }
        assert_eq!(validate_agent_slug("Hello World").unwrap(), "hello-world");
        assert_eq!(validate_agent_slug("reviewer_01").unwrap(), "reviewer_01");
    }

    #[test]
    fn hides_pack_bundled_agents_and_keeps_user_agents() {
        assert!(is_skill_pack_bundled_agent("research_architect_agent"));
        assert!(is_skill_pack_bundled_agent("Research-Exemplar"));
        assert!(!is_skill_pack_bundled_agent("yixiu"));
        assert!(!is_skill_pack_bundled_agent("academic-writer"));

        let _guard = crate::providers::paths::lock_provider_env();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        fs::create_dir_all(home.join("claude-home").join("agents")).unwrap();
        let previous = std::env::var_os("LOCALPRISM_HOME");
        std::env::set_var("LOCALPRISM_HOME", &home);

        let agents_dir = home.join("claude-home").join("agents");
        fs::write(
            agents_dir.join("research_architect_agent.md"),
            "---\nname: architect\ndescription: Designs the study\n---\nBody\n",
        )
        .unwrap();
        fs::write(
            agents_dir.join("research-exemplar.md"),
            "---\nname: exemplar\ndescription: PaperSpine method\n---\nBody\n",
        )
        .unwrap();
        fs::write(
            agents_dir.join("yixiu.md"),
            "---\nname: 一休学术\ndescription: User router\n---\nBody\n",
        )
        .unwrap();

        let listed = list_scope(RuntimeKind::Claude, SkillScope::User, None).unwrap();
        if let Some(value) = previous {
            std::env::set_var("LOCALPRISM_HOME", value);
        } else {
            std::env::remove_var("LOCALPRISM_HOME");
        }

        let ids: Vec<_> = listed.iter().map(|agent| agent.id.as_str()).collect();
        assert_eq!(ids, vec!["yixiu"]);
        assert!(agents_dir.join("research_architect_agent.md").is_file());
    }
}
