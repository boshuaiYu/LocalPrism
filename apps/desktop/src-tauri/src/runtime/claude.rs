use super::{RuntimeAccount, RuntimeCapabilities, RuntimeKind};

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::{RuntimeCapabilities, RuntimeKind};

    #[test]
    fn maps_fully_populated_claude_status_without_changing_provider_configuration() {
        let provider_model = "claude-sonnet-4".to_owned();
        let provider_base_url = "https://provider.example/v1".to_owned();
        let status = crate::claude::ClaudeStatus {
            installed: true,
            authenticated: true,
            binary_path: Some("C:/tools/claude.exe".into()),
            version: Some("2.1.0".into()),
            provider_kind: "openai-compatible".into(),
            account_email: Some("writer@example.com".into()),
            provider_model: Some(provider_model.clone()),
            provider_base_url: Some(provider_base_url.clone()),
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

        assert_eq!(provider_model, "claude-sonnet-4");
        assert_eq!(provider_base_url, "https://provider.example/v1");
    }
}
