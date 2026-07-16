use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;

use codex::discovery::CodexBinary;

pub mod claude;
pub mod codex;
pub mod events;
pub mod process;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeKind {
    Claude,
    Codex,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCapabilities {
    pub models: bool,
    pub skills: bool,
    pub custom_agents: bool,
    pub subagents: bool,
    pub approvals: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeAccount {
    pub runtime: RuntimeKind,
    pub installed: bool,
    pub authenticated: bool,
    pub version: Option<String>,
    pub account_label: Option<String>,
    pub auth_mode: Option<String>,
    pub capabilities: RuntimeCapabilities,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeModel {
    pub runtime: RuntimeKind,
    pub id: String,
    pub display_name: String,
    pub description: Option<String>,
    pub reasoning_efforts: Vec<String>,
    pub default_reasoning_effort: Option<String>,
    pub input_modalities: Vec<String>,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConversation {
    pub reference: ConversationRef,
    pub title: String,
    pub status: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConversationHistory {
    pub reference: ConversationRef,
    pub items: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRef {
    pub runtime: RuntimeKind,
    pub session_id: String,
    pub project_path: String,
}

fn codex_account_from_binary(binary: Option<&CodexBinary>) -> RuntimeAccount {
    RuntimeAccount {
        runtime: RuntimeKind::Codex,
        installed: binary.is_some(),
        authenticated: false,
        version: binary.map(|binary| binary.version.clone()),
        account_label: None,
        auth_mode: None,
        capabilities: RuntimeCapabilities {
            models: true,
            skills: true,
            custom_agents: true,
            subagents: true,
            approvals: true,
        },
        error: None,
    }
}

#[tauri::command]
pub async fn runtime_status(runtime: RuntimeKind) -> Result<RuntimeAccount, String> {
    match runtime {
        RuntimeKind::Claude => crate::claude::check_claude_status()
            .await
            .map(claude::account_from_status),
        RuntimeKind::Codex => {
            let binary = codex::discovery::discover_codex_binary().await.ok();
            Ok(codex_account_from_binary(binary.as_ref()))
        }
    }
}

#[tauri::command]
pub async fn runtime_install(runtime: RuntimeKind, window: WebviewWindow) -> Result<bool, String> {
    match runtime {
        RuntimeKind::Claude => crate::claude::install_claude_cli(window).await,
        RuntimeKind::Codex => codex::install(window).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::codex::discovery::CodexBinary;
    use std::path::PathBuf;

    #[test]
    fn runtime_kind_uses_lowercase_wire_values() {
        assert_eq!(
            serde_json::to_string(&RuntimeKind::Claude).unwrap(),
            "\"claude\""
        );
        assert_eq!(
            serde_json::to_string(&RuntimeKind::Codex).unwrap(),
            "\"codex\""
        );
    }

    #[test]
    fn conversation_ref_requires_an_explicit_runtime() {
        let value = serde_json::to_value(ConversationRef {
            runtime: RuntimeKind::Codex,
            session_id: "thread-1".into(),
            project_path: "C:/work/paper".into(),
        })
        .unwrap();
        assert_eq!(value["runtime"], "codex");
        assert_eq!(value["sessionId"], "thread-1");
    }

    #[test]
    fn codex_account_requires_a_validated_binary_and_exposes_native_capabilities() {
        let missing = codex_account_from_binary(None);
        assert_eq!(missing.runtime, RuntimeKind::Codex);
        assert!(!missing.installed);
        assert!(!missing.authenticated);
        assert_eq!(missing.version, None);
        assert_eq!(missing.account_label, None);
        assert_eq!(missing.auth_mode, None);
        assert_eq!(missing.error, None);

        let binary = CodexBinary {
            path: PathBuf::from(r"C:\protected\versioned\codex.exe"),
            version: "0.135.0".into(),
        };
        let installed = codex_account_from_binary(Some(&binary));
        assert!(installed.installed);
        assert!(!installed.authenticated);
        assert_eq!(installed.version.as_deref(), Some("0.135.0"));
        assert_eq!(
            installed.capabilities,
            RuntimeCapabilities {
                models: true,
                skills: true,
                custom_agents: true,
                subagents: true,
                approvals: true,
            }
        );

        let value = serde_json::to_value(installed).unwrap();
        assert!(value.get("path").is_none());
        assert!(value.get("binaryPath").is_none());
        assert!(!value.to_string().contains("protected"));
    }
}
