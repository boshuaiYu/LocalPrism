use crate::runtime::RuntimeKind;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillScope {
    User,
    Project,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillTarget {
    pub runtime: RuntimeKind,
    pub scope: SkillScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSkill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub folder: String,
    pub source_path: String,
    #[serde(default)]
    pub source_url: Option<String>,
    pub targets: Vec<SkillTarget>,
    pub managed: bool,
    pub compatible_runtimes: Vec<RuntimeKind>,
    pub enabled: bool,
    pub discovery_error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::{RuntimeSkill, SkillScope, SkillTarget};
    use crate::runtime::RuntimeKind;

    #[test]
    fn skill_scope_uses_lowercase_wire_values() {
        assert_eq!(
            serde_json::to_value(SkillScope::User).unwrap(),
            serde_json::json!("user")
        );
        assert_eq!(
            serde_json::to_value(SkillScope::Project).unwrap(),
            serde_json::json!("project")
        );
    }

    #[test]
    fn runtime_skill_uses_the_camel_case_wire_contract() {
        let skill = RuntimeSkill {
            id: "codex:user:example".into(),
            name: "Example".into(),
            description: "Example skill".into(),
            folder: "example".into(),
            source_path: "C:/skills/example".into(),
            source_url: None,
            targets: vec![SkillTarget {
                runtime: RuntimeKind::Codex,
                scope: SkillScope::User,
            }],
            managed: true,
            compatible_runtimes: vec![RuntimeKind::Claude, RuntimeKind::Codex],
            enabled: true,
            discovery_error: None,
        };

        let value = serde_json::to_value(skill).unwrap();
        assert_eq!(value["sourcePath"], "C:/skills/example");
        assert_eq!(
            value["compatibleRuntimes"],
            serde_json::json!(["claude", "codex"])
        );
        assert_eq!(value["discoveryError"], serde_json::Value::Null);
        assert_eq!(
            value["targets"][0],
            serde_json::json!({
                "runtime": "codex",
                "scope": "user"
            })
        );
        assert!(value.get("source_path").is_none());
        assert!(value.get("compatible_runtimes").is_none());
        assert!(value.get("discovery_error").is_none());
    }
}
