use crate::agents::{AgentProfile, AgentError};
use crate::runtime::RuntimeKind;
use crate::skills::domain::SkillScope;
use serde_yaml::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

pub fn agents_root(scope: SkillScope, project_path: Option<&Path>) -> Result<PathBuf, AgentError> {
    match scope {
        SkillScope::User => {
            let home = dirs::home_dir().ok_or_else(|| {
                AgentError::from("Unable to resolve the user home directory")
            })?;
            Ok(home.join(".claude").join("agents"))
        }
        SkillScope::Project => {
            let project = project_path.ok_or_else(|| {
                AgentError::from("Project-scoped agents require a project path")
            })?;
            if !project.is_absolute() {
                return Err(AgentError::from(
                    "Project-scoped agents require an absolute project path",
                ));
            }
            Ok(project.join(".claude").join("agents"))
        }
    }
}

fn yaml_string(value: &Value) -> Option<String> {
    value.as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn yaml_string_list(value: &Value) -> Vec<String> {
    match value {
        Value::Sequence(items) => items
            .iter()
            .filter_map(yaml_string)
            .collect(),
        Value::String(raw) => raw
            .split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

pub fn parse_claude_agent(path: &Path, scope: SkillScope) -> Result<AgentProfile, AgentError> {
    let content = fs::read_to_string(path)
        .map_err(|error| AgentError::from(format!("Failed to read {}: {error}", path.display())))?;
    let (frontmatter, body) = split_frontmatter(&content);
    let mapping = match frontmatter {
        Some(raw) => {
            let value: Value = serde_yaml::from_str(&raw).map_err(|error| {
                AgentError::from(format!("Invalid Claude agent frontmatter: {error}"))
            })?;
            value.as_mapping().cloned().unwrap_or_default()
        }
        None => Default::default(),
    };

    let slug = path
        .file_stem()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AgentError::from("Claude agent filename is invalid"))?
        .to_string();

    let mut unknown = BTreeMap::new();
    for (key, value) in &mapping {
        let Some(key_name) = key.as_str() else {
            continue;
        };
        if !matches!(
            key_name,
            "name"
                | "description"
                | "model"
                | "effort"
                | "permissionMode"
                | "tools"
                | "skills"
        ) {
            unknown.insert(key_name.to_string(), value.clone());
        }
    }

    let name = mapping
        .get(Value::String("name".into()))
        .and_then(yaml_string)
        .unwrap_or_else(|| slug.clone());
    let description = mapping
        .get(Value::String("description".into()))
        .and_then(yaml_string)
        .unwrap_or_default();
    let model = mapping
        .get(Value::String("model".into()))
        .and_then(yaml_string);
    let reasoning_effort = mapping
        .get(Value::String("effort".into()))
        .and_then(yaml_string);
    let permission_mode = mapping
        .get(Value::String("permissionMode".into()))
        .and_then(yaml_string);
    let tools = mapping
        .get(Value::String("tools".into()))
        .map(yaml_string_list)
        .unwrap_or_default();
    let skill_ids = mapping
        .get(Value::String("skills".into()))
        .map(yaml_string_list)
        .unwrap_or_default();

    Ok(AgentProfile {
        id: slug,
        runtime: RuntimeKind::Claude,
        scope,
        name,
        description,
        instructions: body.trim_end().to_string(),
        model,
        reasoning_effort,
        sandbox_mode: None,
        permission_mode,
        tools,
        nickname_candidates: Vec::new(),
        skill_ids,
        source_path: path.to_string_lossy().to_string(),
        unknown_fields: unknown
            .into_iter()
            .filter_map(|(key, value)| yaml_string(&value).map(|text| (key, text)))
            .collect(),
    })
}

pub fn write_claude_agent(path: &Path, profile: &AgentProfile) -> Result<(), AgentError> {
    let mut map = serde_yaml::Mapping::new();
    map.insert(
        Value::String("name".into()),
        Value::String(profile.name.clone()),
    );
    map.insert(
        Value::String("description".into()),
        Value::String(profile.description.clone()),
    );
    if let Some(model) = &profile.model {
        map.insert(
            Value::String("model".into()),
            Value::String(model.clone()),
        );
    }
    if let Some(effort) = &profile.reasoning_effort {
        map.insert(
            Value::String("effort".into()),
            Value::String(effort.clone()),
        );
    }
    if let Some(permission_mode) = &profile.permission_mode {
        map.insert(
            Value::String("permissionMode".into()),
            Value::String(permission_mode.clone()),
        );
    }
    if !profile.tools.is_empty() {
        map.insert(
            Value::String("tools".into()),
            Value::Sequence(
                profile
                    .tools
                    .iter()
                    .cloned()
                    .map(Value::String)
                    .collect(),
            ),
        );
    }
    if !profile.skill_ids.is_empty() {
        map.insert(
            Value::String("skills".into()),
            Value::Sequence(
                profile
                    .skill_ids
                    .iter()
                    .cloned()
                    .map(Value::String)
                    .collect(),
            ),
        );
    }
    for (key, value) in &profile.unknown_fields {
        if matches!(
            key.as_str(),
            "name" | "description" | "model" | "effort" | "permissionMode" | "tools" | "skills"
        ) {
            continue;
        }
        map.insert(Value::String(key.clone()), Value::String(value.clone()));
    }

    let frontmatter = serde_yaml::to_string(&Value::Mapping(map))
        .map_err(|error| AgentError::from(format!("Failed to serialize Claude agent: {error}")))?;
    let body = profile.instructions.trim_end();
    let content = if body.is_empty() {
        format!("---\n{frontmatter}---\n")
    } else {
        format!("---\n{frontmatter}---\n{body}\n")
    };
    crate::agents::atomic_write(path, content.as_bytes())
}

fn split_frontmatter(content: &str) -> (Option<String>, String) {
    let lines: Vec<&str> = content.lines().collect();
    if lines.first() != Some(&"---") {
        return (None, content.to_string());
    }
    let mut end = None;
    for (index, line) in lines.iter().enumerate().skip(1) {
        if *line == "---" {
            end = Some(index);
            break;
        }
    }
    let Some(end) = end else {
        return (None, content.to_string());
    };
    (
        Some(lines[1..end].join("\n")),
        lines
            .get((end + 1)..)
            .map(|slice| slice.join("\n"))
            .unwrap_or_default(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::validate_agent_slug;

    #[test]
    fn claude_round_trip_preserves_unknown_fields_and_skills() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("reviewer.md");
        fs::write(
            &path,
            "---\nname: Reviewer\ndescription: Reviews code\ncolor: blue\nmodel: sonnet\neffort: high\nskills:\n  - writer\n---\nBe thorough.\n",
        )
        .unwrap();

        let mut profile = parse_claude_agent(&path, SkillScope::User).unwrap();
        assert_eq!(profile.unknown_fields.get("color"), Some(&"blue".into()));
        profile.model = Some("opus".into());
        profile.skill_ids = vec!["writer".into(), "lint".into()];
        write_claude_agent(&path, &profile).unwrap();

        let reloaded = parse_claude_agent(&path, SkillScope::User).unwrap();
        assert_eq!(reloaded.model.as_deref(), Some("opus"));
        assert_eq!(reloaded.skill_ids, vec!["writer", "lint"]);
        assert_eq!(reloaded.unknown_fields.get("color"), Some(&"blue".into()));
        assert!(reloaded.instructions.contains("Be thorough."));
        assert_eq!(validate_agent_slug("reviewer"), Ok(()));
    }
}
