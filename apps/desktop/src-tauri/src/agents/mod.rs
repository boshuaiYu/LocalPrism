pub mod claude;
pub mod codex;

use crate::runtime::RuntimeKind;
use crate::skills::domain::SkillScope;
use crate::skills::import::{find_skill_md, list_runtime_skills};
use crate::skills::paths::validate_skill_slug;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
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
    if !normalized
        .chars()
        .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || matches!(character, '_' | '-'))
    {
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
    let entries = fs::read_dir(&root).map_err(|error| {
        AgentError::from(format!("Failed to read {}: {error}", root.display()))
    })?;
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
            agents.push(profile);
        }
    }
    agents.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
    Ok(agents)
}

fn resolve_skill_paths(
    profile: &AgentProfile,
    project_path: Option<&Path>,
) -> Result<Vec<(String, PathBuf)>, AgentError> {
    if profile.skill_ids.is_empty() {
        return Ok(Vec::new());
    }
    let catalog = list_runtime_skills(project_path)
        .map_err(|error| AgentError::from(error.to_string()))?;
    let mut resolved = Vec::new();
    for skill_id in &profile.skill_ids {
        let skill = catalog
            .iter()
            .find(|candidate| {
                candidate.folder == *skill_id
                    || candidate.id == *skill_id
                    || candidate.name == *skill_id
            })
            .ok_or_else(|| {
                AgentError::from(format!("Assigned skill '{skill_id}' was not found"))
            })?;
        if skill.discovery_error.is_some() {
            return Err(AgentError::from(format!(
                "Assigned skill '{skill_id}' has a discovery error"
            )));
        }
        let has_target = skill.targets.iter().any(|target| {
            target.runtime == profile.runtime && target.scope == profile.scope
        });
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
    let path = agent_path(profile.runtime, profile.scope, &slug, project)
        .map_err(|e| e.to_string())?;

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

    #[test]
    fn rejects_unsafe_agent_slugs() {
        for slug in ["", ".", "..", "../x", "a/b", "CON", "Hello World!"] {
            assert!(validate_agent_slug(slug).is_err(), "{slug}");
        }
        assert_eq!(validate_agent_slug("Hello World").unwrap(), "hello-world");
        assert_eq!(validate_agent_slug("reviewer_01").unwrap(), "reviewer_01");
    }
}
