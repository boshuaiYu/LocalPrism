use crate::agents::{AgentError, AgentProfile};
use crate::runtime::RuntimeKind;
use crate::skills::domain::SkillScope;
use std::fs;
use std::path::{Path, PathBuf};
use toml_edit::{Array, ArrayOfTables, DocumentMut, Item, Table, Value};

pub fn agents_root(scope: SkillScope, project_path: Option<&Path>) -> Result<PathBuf, AgentError> {
    match scope {
        SkillScope::User => crate::providers::paths::user_agents_dir().map_err(AgentError::from),
        SkillScope::Project => {
            let project = project_path
                .ok_or_else(|| AgentError::from("Project-scoped agents require a project path"))?;
            if !project.is_absolute() {
                return Err(AgentError::from(
                    "Project-scoped agents require an absolute project path",
                ));
            }
            Ok(project.join(".localprism").join("agents"))
        }
    }
}

fn string_value(item: Option<&Item>) -> Option<String> {
    item.and_then(Item::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn string_array(item: Option<&Item>) -> Vec<String> {
    let Some(array) = item.and_then(Item::as_array) else {
        return Vec::new();
    };
    array
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

pub fn parse_codex_agent(path: &Path, scope: SkillScope) -> Result<AgentProfile, AgentError> {
    let content = fs::read_to_string(path)
        .map_err(|error| AgentError::from(format!("Failed to read {}: {error}", path.display())))?;
    let document: DocumentMut = content
        .parse()
        .map_err(|error| AgentError::from(format!("Invalid Codex agent TOML: {error}")))?;

    let slug = path
        .file_stem()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AgentError::from("Codex agent filename is invalid"))?
        .to_string();

    let mut skill_ids = Vec::new();
    if let Some(array) = document
        .get("skills")
        .and_then(|skills| skills.get("config"))
        .and_then(Item::as_array_of_tables)
    {
        for table in array.iter() {
            if let Some(path_value) = string_value(table.get("path")) {
                // Prefer folder basename as the stable skill id when path points at SKILL.md.
                let skill_id = Path::new(&path_value)
                    .parent()
                    .and_then(|parent| parent.file_name())
                    .and_then(|name| name.to_str())
                    .unwrap_or(path_value.as_str())
                    .to_string();
                skill_ids.push(skill_id);
            }
        }
    }

    let mut unknown_fields = std::collections::BTreeMap::new();
    for (key, item) in document.iter() {
        if matches!(
            key,
            "name"
                | "description"
                | "developer_instructions"
                | "model"
                | "model_reasoning_effort"
                | "sandbox_mode"
                | "nickname_candidates"
                | "skills"
        ) {
            continue;
        }
        if let Some(text) = item.as_str() {
            unknown_fields.insert(key.to_string(), text.to_string());
        }
    }

    Ok(AgentProfile {
        id: slug.clone(),
        runtime: RuntimeKind::Codex,
        scope,
        name: string_value(document.get("name")).unwrap_or(slug),
        description: string_value(document.get("description")).unwrap_or_default(),
        instructions: string_value(document.get("developer_instructions")).unwrap_or_default(),
        model: string_value(document.get("model")),
        reasoning_effort: string_value(document.get("model_reasoning_effort")),
        sandbox_mode: string_value(document.get("sandbox_mode")),
        permission_mode: None,
        tools: Vec::new(),
        nickname_candidates: string_array(document.get("nickname_candidates")),
        skill_ids,
        source_path: path.to_string_lossy().to_string(),
        unknown_fields,
    })
}

pub fn write_codex_agent(
    path: &Path,
    profile: &AgentProfile,
    skill_paths: &[(String, PathBuf)],
) -> Result<(), AgentError> {
    let existing = if path.exists() {
        fs::read_to_string(path).unwrap_or_default()
    } else {
        String::new()
    };
    let mut document: DocumentMut = if existing.trim().is_empty() {
        DocumentMut::new()
    } else {
        existing
            .parse()
            .map_err(|error| AgentError::from(format!("Invalid existing Codex agent: {error}")))?
    };

    document["name"] = Item::Value(Value::from(profile.name.as_str()));
    document["description"] = Item::Value(Value::from(profile.description.as_str()));
    document["developer_instructions"] = Item::Value(Value::from(profile.instructions.as_str()));

    match &profile.model {
        Some(model) => document["model"] = Item::Value(Value::from(model.as_str())),
        None => {
            let _ = document.remove("model");
        }
    }
    match &profile.reasoning_effort {
        Some(effort) => {
            document["model_reasoning_effort"] = Item::Value(Value::from(effort.as_str()))
        }
        None => {
            let _ = document.remove("model_reasoning_effort");
        }
    }
    match &profile.sandbox_mode {
        Some(mode) => document["sandbox_mode"] = Item::Value(Value::from(mode.as_str())),
        None => {
            let _ = document.remove("sandbox_mode");
        }
    }

    if profile.nickname_candidates.is_empty() {
        let _ = document.remove("nickname_candidates");
    } else {
        let mut array = Array::new();
        for nickname in &profile.nickname_candidates {
            array.push(nickname.as_str());
        }
        document["nickname_candidates"] = Item::Value(Value::Array(array));
    }

    for (key, value) in &profile.unknown_fields {
        if document.contains_key(key.as_str()) {
            continue;
        }
        document[key.as_str()] = Item::Value(Value::from(value.as_str()));
    }

    let mut config_tables = ArrayOfTables::new();
    for (_skill_id, skill_path) in skill_paths {
        let mut table = Table::new();
        table["path"] = Item::Value(Value::from(skill_path.to_string_lossy().as_ref()));
        table["enabled"] = Item::Value(Value::from(true));
        config_tables.push(table);
    }
    if config_tables.is_empty() {
        let _ = document.remove("skills");
    } else {
        let mut skills = Table::new();
        skills.insert("config", Item::ArrayOfTables(config_tables));
        document.insert("skills", Item::Table(skills));
    }

    crate::agents::atomic_write(path, document.to_string().as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_round_trip_preserves_unknown_fields_and_skills() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("reviewer.toml");
        fs::write(
            &path,
            r#"
name = "Reviewer"
description = "Reviews code"
developer_instructions = "Be careful."
model = "gpt-5"
model_reasoning_effort = "high"
sandbox_mode = "workspace-write"
nickname_candidates = ["rev"]
extra_note = "keep-me"

[[skills.config]]
path = "C:/skills/writer/SKILL.md"
enabled = true
"#,
        )
        .unwrap();

        let mut profile = parse_codex_agent(&path, SkillScope::User).unwrap();
        assert_eq!(
            profile.unknown_fields.get("extra_note"),
            Some(&"keep-me".into())
        );
        assert_eq!(profile.skill_ids, vec!["writer"]);
        profile.reasoning_effort = Some("xhigh".into());
        write_codex_agent(
            &path,
            &profile,
            &[("writer".into(), PathBuf::from("C:/skills/writer/SKILL.md"))],
        )
        .unwrap();

        let reloaded = parse_codex_agent(&path, SkillScope::User).unwrap();
        assert_eq!(reloaded.reasoning_effort.as_deref(), Some("xhigh"));
        assert_eq!(
            reloaded.unknown_fields.get("extra_note"),
            Some(&"keep-me".into())
        );
        assert!(reloaded.instructions.contains("Be careful."));
    }
}
