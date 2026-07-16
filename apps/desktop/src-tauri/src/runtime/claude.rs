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
}
