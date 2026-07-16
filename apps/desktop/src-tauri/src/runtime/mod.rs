use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State, WebviewWindow};

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeLoginMode {
    Browser,
    DeviceCode,
    ApiKey,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum RuntimeLoginStartResult {
    #[serde(rename = "apiKey")]
    ApiKey,
    #[serde(rename = "chatgpt")]
    Chatgpt {
        #[serde(rename = "authUrl")]
        auth_url: String,
        #[serde(rename = "loginId")]
        login_id: String,
    },
    #[serde(rename = "chatgptDeviceCode")]
    ChatgptDeviceCode {
        #[serde(rename = "verificationUrl")]
        verification_url: String,
        #[serde(rename = "userCode")]
        user_code: String,
        #[serde(rename = "loginId")]
        login_id: String,
    },
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

fn codex_account_with_error(binary: &CodexBinary, error: String) -> RuntimeAccount {
    let mut account = codex_account_from_binary(Some(binary));
    account.error = Some(error);
    account
}

fn normalize_codex_login(
    runtime: RuntimeKind,
    mode: RuntimeLoginMode,
    api_key: Option<String>,
) -> Result<Option<String>, String> {
    if runtime != RuntimeKind::Codex {
        return Err("This login command is only available for the Codex runtime".into());
    }
    match mode {
        RuntimeLoginMode::ApiKey => {
            let api_key = api_key
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "An API key is required for Codex API-key login".to_string())?;
            Ok(Some(api_key))
        }
        RuntimeLoginMode::Browser | RuntimeLoginMode::DeviceCode => {
            if api_key.is_some() {
                return Err("API keys are accepted only for Codex API-key login".into());
            }
            Ok(None)
        }
    }
}

#[tauri::command]
pub async fn runtime_status(
    runtime: RuntimeKind,
    app: AppHandle,
    codex_state: State<'_, codex::CodexAppServerState>,
) -> Result<RuntimeAccount, String> {
    match runtime {
        RuntimeKind::Claude => crate::claude::check_claude_status()
            .await
            .map(claude::account_from_status),
        RuntimeKind::Codex => {
            let binary = codex::discovery::discover_codex_binary().await.ok();
            let Some(binary) = binary else {
                return Ok(codex_account_from_binary(None));
            };
            match codex::read_account(&app, &codex_state, binary.version.clone()).await {
                Ok(account) => Ok(account),
                Err(error) => Ok(codex_account_with_error(&binary, error)),
            }
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

#[tauri::command]
pub async fn runtime_login_start(
    runtime: RuntimeKind,
    mode: RuntimeLoginMode,
    api_key: Option<String>,
    app: AppHandle,
    codex_state: State<'_, codex::CodexAppServerState>,
) -> Result<RuntimeLoginStartResult, String> {
    let api_key = normalize_codex_login(runtime, mode, api_key)?;
    codex::login_start(&app, &codex_state, mode, api_key).await
}

#[tauri::command]
pub async fn runtime_login_cancel(
    runtime: RuntimeKind,
    login_id: String,
    app: AppHandle,
    codex_state: State<'_, codex::CodexAppServerState>,
) -> Result<(), String> {
    if runtime != RuntimeKind::Codex {
        return Err("This login command is only available for the Codex runtime".into());
    }
    if login_id.trim().is_empty() {
        return Err("A login ID is required to cancel Codex login".into());
    }
    if codex_state.active_login_id().as_deref() != Some(login_id.as_str()) {
        return Ok(());
    }
    codex::cancel_login(&app, &codex_state, login_id).await
}

#[tauri::command]
pub async fn runtime_logout(
    runtime: RuntimeKind,
    app: AppHandle,
    codex_state: State<'_, codex::CodexAppServerState>,
) -> Result<(), String> {
    if runtime != RuntimeKind::Codex {
        return Err("Use the existing Claude account controls to sign out of Claude".into());
    }
    codex::logout(&app, &codex_state).await
}

#[tauri::command]
pub async fn runtime_list_models(
    runtime: RuntimeKind,
    app: AppHandle,
    codex_state: State<'_, codex::CodexAppServerState>,
) -> Result<Vec<RuntimeModel>, String> {
    match runtime {
        RuntimeKind::Claude => crate::claude::check_claude_status()
            .await
            .map(|status| claude::models_from_status(&status)),
        RuntimeKind::Codex => codex::list_models(&app, &codex_state).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::codex::discovery::CodexBinary;
    use serde_json::json;
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
    fn account_and_models_runtime_login_modes_use_the_ui_wire_values() {
        assert_eq!(
            serde_json::from_value::<RuntimeLoginMode>(json!("browser")).unwrap(),
            RuntimeLoginMode::Browser
        );
        assert_eq!(
            serde_json::from_value::<RuntimeLoginMode>(json!("device-code")).unwrap(),
            RuntimeLoginMode::DeviceCode
        );
        assert_eq!(
            serde_json::from_value::<RuntimeLoginMode>(json!("api-key")).unwrap(),
            RuntimeLoginMode::ApiKey
        );
    }

    #[test]
    fn account_and_models_login_results_keep_the_codex_protocol_tags() {
        assert_eq!(
            serde_json::to_value(RuntimeLoginStartResult::Chatgpt {
                auth_url: "https://auth.example".into(),
                login_id: "login-7".into(),
            })
            .unwrap(),
            json!({"type":"chatgpt","authUrl":"https://auth.example","loginId":"login-7"})
        );
        assert_eq!(
            serde_json::to_value(RuntimeLoginStartResult::ApiKey).unwrap(),
            json!({"type":"apiKey"})
        );
    }

    #[test]
    fn account_and_models_codex_login_validation_never_accepts_misrouted_secrets() {
        assert_eq!(
            normalize_codex_login(
                RuntimeKind::Codex,
                RuntimeLoginMode::ApiKey,
                Some("  <api-key>  ".into()),
            )
            .unwrap()
            .as_deref(),
            Some("<api-key>")
        );
        assert!(normalize_codex_login(
            RuntimeKind::Codex,
            RuntimeLoginMode::ApiKey,
            Some("   ".into()),
        )
        .is_err());
        assert!(normalize_codex_login(
            RuntimeKind::Codex,
            RuntimeLoginMode::Browser,
            Some("must-not-be-forwarded".into()),
        )
        .is_err());
        assert!(normalize_codex_login(
            RuntimeKind::Claude,
            RuntimeLoginMode::ApiKey,
            Some("must-not-be-forwarded".into()),
        )
        .is_err());
    }

    #[test]
    fn account_and_models_installed_codex_status_keeps_safe_account_errors() {
        let binary = CodexBinary {
            path: PathBuf::from(r"C:\protected\versioned\codex.exe"),
            version: "0.135.0".into(),
        };
        let failed = codex_account_with_error(&binary, "account/read unavailable".into());

        assert!(failed.installed);
        assert!(!failed.authenticated);
        assert_eq!(failed.version.as_deref(), Some("0.135.0"));
        assert_eq!(failed.error.as_deref(), Some("account/read unavailable"));
        let value = serde_json::to_string(&failed).unwrap();
        assert!(!value.contains("protected"));
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
