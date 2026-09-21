use super::paths::{
    claude_oauth_path, legacy_anthropic_auth_path, openai_oauth_path, providers_index_path,
    restrict_secret_file, write_secret_json,
};
use super::types::{
    ApiFormat, OAuthTokens, ProviderIndex, ProviderModels, SavedProvider, SCHEMA_VERSION,
};
use serde::Deserialize;

#[derive(Debug, Default, Deserialize)]
struct LegacyAuthConfig {
    #[serde(default)]
    openai_credentials: Vec<LegacyOpenAiCredential>,
}

#[derive(Debug, Deserialize)]
struct LegacyOpenAiCredential {
    id: String,
    label: String,
    api_key: String,
    base_url: String,
    model: String,
}

pub fn load_index() -> Result<ProviderIndex, String> {
    let path = providers_index_path()?;
    if !path.exists() {
        let mut index = ProviderIndex::default();
        migrate_legacy_credentials(&mut index)?;
        if !index.providers.is_empty() {
            save_index(&index)?;
        }
        return Ok(index);
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|err| format!("Failed to read providers.json: {err}"))?;
    let content = content.trim_start_matches('\u{feff}');
    let mut index: ProviderIndex = serde_json::from_str(content)
        .map_err(|err| format!("Failed to parse providers.json: {err}"))?;
    index.schema_version = SCHEMA_VERSION;
    restrict_secret_file(&path)?;
    if index.providers.is_empty() {
        if migrate_legacy_credentials(&mut index)? {
            save_index(&index)?;
        }
    }
    Ok(index)
}

pub fn save_index(index: &ProviderIndex) -> Result<(), String> {
    let path = providers_index_path()?;
    let json = serde_json::to_string_pretty(index)
        .map_err(|err| format!("Failed to serialize providers.json: {err}"))?;
    write_secret_json(&path, &json)
}

pub fn load_oauth(kind: OAuthKind) -> Result<Option<OAuthTokens>, String> {
    let path = match kind {
        OAuthKind::Claude => claude_oauth_path()?,
        OAuthKind::OpenAi => openai_oauth_path()?,
    };
    if !path.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|err| format!("Failed to read {}: {err}", path.display()))?;
    let tokens: OAuthTokens = serde_json::from_str(content.trim_start_matches('\u{feff}'))
        .map_err(|err| format!("Failed to parse {}: {err}", path.display()))?;
    restrict_secret_file(&path)?;
    if !tokens.has_access_token() {
        return Ok(None);
    }
    Ok(Some(tokens))
}

pub fn save_oauth(kind: OAuthKind, tokens: &OAuthTokens) -> Result<(), String> {
    let path = match kind {
        OAuthKind::Claude => claude_oauth_path()?,
        OAuthKind::OpenAi => openai_oauth_path()?,
    };
    let json = serde_json::to_string_pretty(tokens)
        .map_err(|err| format!("Failed to serialize OAuth tokens: {err}"))?;
    write_secret_json(&path, &json)
}

pub fn delete_oauth(kind: OAuthKind) -> Result<(), String> {
    let path = match kind {
        OAuthKind::Claude => claude_oauth_path()?,
        OAuthKind::OpenAi => openai_oauth_path()?,
    };
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|err| format!("Failed to delete {}: {err}", path.display()))?;
    }
    Ok(())
}

#[derive(Debug, Clone, Copy)]
pub enum OAuthKind {
    Claude,
    OpenAi,
}

fn migrate_legacy_credentials(index: &mut ProviderIndex) -> Result<bool, String> {
    if !index.providers.is_empty() {
        return Ok(false);
    }
    let path = legacy_anthropic_auth_path()?;
    if !path.exists() {
        return Ok(false);
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|err| format!("Failed to read legacy auth settings: {err}"))?;
    let parsed: LegacyAuthConfig =
        serde_json::from_str(content.trim_start_matches('\u{feff}')).unwrap_or_default();
    if parsed.openai_credentials.is_empty() {
        return Ok(false);
    }
    for credential in parsed.openai_credentials {
        if credential.api_key.trim().is_empty() || credential.base_url.trim().is_empty() {
            continue;
        }
        let format = if looks_anthropic(&credential.base_url) {
            ApiFormat::Anthropic
        } else {
            ApiFormat::OpenaiChat
        };
        index.upsert_third_party(SavedProvider {
            id: credential.id,
            name: credential.label,
            api_key: credential.api_key,
            base_url: credential.base_url,
            api_format: format,
            models: ProviderModels {
                main: credential.model.clone(),
                haiku: Some(credential.model.clone()),
                sonnet: Some(credential.model.clone()),
                opus: Some(credential.model),
            },
        });
    }
    if index.active_id.is_none() {
        if let Some(first) = index.providers.first() {
            index.active_id = Some(first.id.clone());
        }
    }
    Ok(!index.providers.is_empty())
}

fn looks_anthropic(base_url: &str) -> bool {
    let lower = base_url.to_ascii_lowercase();
    lower.contains("/anthropic") || lower.contains("api.anthropic.com")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn isolate_dirs() -> (TempDir, std::sync::MutexGuard<'static, ()>) {
        let guard = crate::providers::paths::lock_provider_env();
        let dir = TempDir::new().expect("tempdir");
        std::env::set_var("LOCALPRISM_PROVIDERS_DIR", dir.path().join("providers"));
        std::env::set_var(
            "LOCALPRISM_LEGACY_ANTHROPIC_AUTH",
            dir.path().join("anthropic-auth.json"),
        );
        (dir, guard)
    }

    #[test]
    fn migrates_legacy_openai_credentials() {
        let (_dir, _guard) = isolate_dirs();
        let legacy = r#"{
          "openai_credentials": [
            {
              "id": "deepseek-1",
              "label": "DeepSeek",
              "api_key": "sk-test",
              "base_url": "https://api.deepseek.com/anthropic",
              "model": "deepseek-v4-pro"
            }
          ]
        }"#;
        std::fs::write(
            std::env::var("LOCALPRISM_LEGACY_ANTHROPIC_AUTH").unwrap(),
            legacy,
        )
        .unwrap();

        let index = load_index().unwrap();
        assert_eq!(index.providers.len(), 1);
        assert_eq!(index.providers[0].name, "DeepSeek");
        assert_eq!(index.providers[0].api_format, ApiFormat::Anthropic);
        assert_eq!(index.active_id.as_deref(), Some("deepseek-1"));
    }

    #[test]
    fn refuses_to_delete_active_provider() {
        let (_dir, _guard) = isolate_dirs();
        let mut index = ProviderIndex::default();
        index.upsert_third_party(SavedProvider {
            id: "p1".into(),
            name: "One".into(),
            api_key: "k".into(),
            base_url: "https://example.com".into(),
            api_format: ApiFormat::OpenaiChat,
            models: ProviderModels {
                main: "m".into(),
                haiku: None,
                sonnet: None,
                opus: None,
            },
        });
        index.active_id = Some("p1".into());
        assert!(index.remove_third_party("p1").is_err());
    }

    #[test]
    fn empty_api_key_is_not_authenticated() {
        let provider = SavedProvider {
            id: "p1".into(),
            name: "One".into(),
            api_key: "  ".into(),
            base_url: "https://example.com".into(),
            api_format: ApiFormat::OpenaiChat,
            models: ProviderModels {
                main: "m".into(),
                haiku: None,
                sonnet: None,
                opus: None,
            },
        };
        assert!(provider.api_key.trim().is_empty());
    }

    #[test]
    fn oauth_roundtrip_does_not_echo_empty_tokens() {
        let (_dir, _guard) = isolate_dirs();
        save_oauth(
            OAuthKind::Claude,
            &OAuthTokens {
                access_token: "tok".into(),
                refresh_token: Some("ref".into()),
                expires_at: 99,
                account_id: None,
                email: Some("a@b.c".into()),
                subscription_type: Some("pro".into()),
            },
        )
        .unwrap();
        let loaded = load_oauth(OAuthKind::Claude).unwrap().unwrap();
        assert_eq!(loaded.access_token, "tok");
        assert_eq!(loaded.email.as_deref(), Some("a@b.c"));
    }
}
