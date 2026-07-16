use super::{RuntimeAccount, RuntimeCapabilities, RuntimeKind, RuntimeModel};

pub fn account_from_status(status: crate::claude::ClaudeStatus) -> RuntimeAccount {
    RuntimeAccount {
        runtime: RuntimeKind::Claude,
        installed: status.installed,
        authenticated: status.authenticated,
        version: status.version,
        account_label: status.account_email,
        auth_mode: Some(status.provider_kind),
        capabilities: RuntimeCapabilities {
            models: true,
            skills: true,
            custom_agents: true,
            subagents: true,
            approvals: false,
        },
        error: None,
    }
}

pub fn models_from_status(status: &crate::claude::ClaudeStatus) -> Vec<RuntimeModel> {
    if status.provider_kind == "openai-compatible" {
        return status
            .provider_model
            .as_deref()
            .map(str::trim)
            .filter(|model| !model.is_empty())
            .map(|model| {
                vec![RuntimeModel {
                    runtime: RuntimeKind::Claude,
                    id: model.to_string(),
                    display_name: model.to_string(),
                    description: Some("Configured OpenAI-compatible provider model".into()),
                    reasoning_efforts: Vec::new(),
                    default_reasoning_effort: None,
                    input_modalities: vec!["text".into()],
                    is_default: true,
                }]
            })
            .unwrap_or_default();
    }

    [
        ("sonnet", "Sonnet", "Fast, efficient for most tasks", false),
        ("opus", "Opus", "Most capable, complex reasoning", true),
        ("haiku", "Haiku", "Fastest, simple tasks", false),
        (
            "opusplan",
            "OpusPlan",
            "Opus for planning, Sonnet for execution",
            false,
        ),
    ]
    .into_iter()
    .map(|(id, display_name, description, is_default)| RuntimeModel {
        runtime: RuntimeKind::Claude,
        id: id.into(),
        display_name: display_name.into(),
        description: Some(description.into()),
        reasoning_efforts: Vec::new(),
        default_reasoning_effort: None,
        input_modalities: vec!["text".into(), "image".into()],
        is_default,
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::{RuntimeCapabilities, RuntimeKind};

    #[test]
    fn maps_fully_populated_claude_status_to_the_shared_account_boundary() {
        let status = crate::claude::ClaudeStatus {
            installed: true,
            authenticated: true,
            binary_path: Some("C:/tools/claude.exe".into()),
            version: Some("2.1.0".into()),
            provider_kind: "openai-compatible".into(),
            account_email: Some("writer@example.com".into()),
            provider_model: Some("claude-sonnet-4".into()),
            provider_base_url: Some("https://provider.example/v1".into()),
            claude_provider_configured: true,
            missing_git: true,
        };

        let account = account_from_status(status);

        assert_eq!(account.runtime, RuntimeKind::Claude);
        assert!(account.installed);
        assert!(account.authenticated);
        assert_eq!(account.version.as_deref(), Some("2.1.0"));
        assert_eq!(account.account_label.as_deref(), Some("writer@example.com"));
        assert_eq!(account.auth_mode.as_deref(), Some("openai-compatible"));
        assert_eq!(
            account.capabilities,
            RuntimeCapabilities {
                models: true,
                skills: true,
                custom_agents: true,
                subagents: true,
                approvals: false,
            }
        );
        assert_eq!(account.error, None);

        let value = serde_json::to_value(account).unwrap();
        assert_eq!(value["authMode"], "openai-compatible");
        assert_eq!(value["accountLabel"], "writer@example.com");

        for provider_only_field in [
            "binaryPath",
            "providerModel",
            "providerBaseUrl",
            "claudeProviderConfigured",
            "missingGit",
        ] {
            assert!(
                value.get(provider_only_field).is_none(),
                "{provider_only_field} must not cross the shared runtime boundary"
            );
        }
    }

    #[test]
    fn account_and_models_claude_code_keeps_the_existing_alias_catalog() {
        let status = crate::claude::ClaudeStatus {
            installed: true,
            authenticated: true,
            binary_path: None,
            version: Some("2.1.0".into()),
            provider_kind: "claude-code".into(),
            account_email: None,
            provider_model: None,
            provider_base_url: None,
            claude_provider_configured: false,
            missing_git: false,
        };

        let models = models_from_status(&status);

        assert_eq!(
            models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec!["sonnet", "opus", "haiku", "opusplan"]
        );
        assert!(models
            .iter()
            .all(|model| model.runtime == RuntimeKind::Claude));
        assert!(models.iter().all(|model| !model.id.starts_with("gpt-")));
    }

    #[test]
    fn account_and_models_openai_compatible_keeps_its_configured_model_under_claude() {
        let status = crate::claude::ClaudeStatus {
            installed: true,
            authenticated: true,
            binary_path: None,
            version: None,
            provider_kind: "openai-compatible".into(),
            account_email: None,
            provider_model: Some("deepseek-chat".into()),
            provider_base_url: Some("https://api.deepseek.com/anthropic".into()),
            claude_provider_configured: true,
            missing_git: false,
        };

        let models = models_from_status(&status);

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].runtime, RuntimeKind::Claude);
        assert_eq!(models[0].id, "deepseek-chat");
        assert_eq!(models[0].display_name, "deepseek-chat");
    }
}
