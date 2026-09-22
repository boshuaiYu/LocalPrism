use super::models::{cached_models_for_active, bundled_chatgpt_models};
use super::store::{load_index, load_oauth, OAuthKind};
use super::types::{
    pick_catalog_model, ApiFormat, SavedProvider, CHATGPT_OFFICIAL_ID, CLAUDE_OFFICIAL_ID,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActiveProviderIdentity {
    ClaudeOfficial,
    ChatGptOfficial,
    ThirdParty,
    Unknown,
}

pub fn active_provider_identity() -> ActiveProviderIdentity {
    let Ok(index) = load_index() else {
        return ActiveProviderIdentity::Unknown;
    };
    match index.active_id.as_deref() {
        Some(CLAUDE_OFFICIAL_ID) => ActiveProviderIdentity::ClaudeOfficial,
        Some(CHATGPT_OFFICIAL_ID) => ActiveProviderIdentity::ChatGptOfficial,
        Some(_) => ActiveProviderIdentity::ThirdParty,
        None => ActiveProviderIdentity::Unknown,
    }
}

pub fn resolve_active_spawn_model(model_override: Option<&str>) -> Option<String> {
    let Ok(index) = load_index() else {
        return model_override.map(str::to_string);
    };
    let catalog = cached_models_for_active();
    match index.active_id.as_deref() {
        Some(CHATGPT_OFFICIAL_ID) => {
            let catalog = if catalog.is_empty() {
                bundled_chatgpt_models()
            } else {
                catalog
            };
            pick_catalog_model(model_override, &catalog, None)
        }
        Some(CLAUDE_OFFICIAL_ID) => {
            pick_catalog_model(model_override, &catalog, Some("sonnet"))
        }
        Some(id) => {
            let fallback = index
                .third_party(id)
                .map(|provider| provider.models.main.as_str());
            pick_catalog_model(model_override, &catalog, fallback)
        }
        None => model_override.map(str::to_string),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedRuntimeEnv {
    pub values: Vec<(String, String)>,
    pub remove: Vec<String>,
    pub proxy_kind: Option<ProxyKind>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProxyKind {
    OpenaiChat(SavedProvider),
    AnthropicNative(SavedProvider),
    CodexResponses {
        model: String,
        effort: Option<String>,
    },
}

pub fn build_managed_env(
    model_override: Option<&str>,
    effort: Option<&str>,
) -> Result<ManagedRuntimeEnv, String> {
    let index = load_index()?;
    let Some(active_id) = index.active_id.as_deref() else {
        return Ok(ManagedRuntimeEnv {
            values: Vec::new(),
            remove: Vec::new(),
            proxy_kind: None,
        });
    };

    if active_id == CLAUDE_OFFICIAL_ID {
        let tokens = load_oauth(OAuthKind::Claude)?
            .ok_or_else(|| "Claude Official is not signed in".to_string())?;
        let catalog = cached_models_for_active();
        let model = pick_catalog_model(model_override, &catalog, Some("sonnet"))
            .unwrap_or_else(|| model_override.unwrap_or("sonnet").to_string());
        return Ok(ManagedRuntimeEnv {
            values: vec![
                (
                    "CLAUDE_CODE_OAUTH_TOKEN".into(),
                    tokens.access_token.clone(),
                ),
                ("ANTHROPIC_AUTH_TOKEN".into(), tokens.access_token),
                ("ANTHROPIC_MODEL".into(), model),
            ],
            remove: vec![
                "ANTHROPIC_API_KEY".into(),
                "ANTHROPIC_BASE_URL".into(),
                "CLAUDE_MODEL".into(),
            ],
            proxy_kind: None,
        });
    }

    if active_id == CHATGPT_OFFICIAL_ID {
        let catalog = {
            let cached = cached_models_for_active();
            if cached.is_empty() {
                bundled_chatgpt_models()
            } else {
                cached
            }
        };
        let model = pick_catalog_model(model_override, &catalog, None)
            .unwrap_or_else(|| model_override.unwrap_or("").to_string());
        return Ok(ManagedRuntimeEnv {
            values: vec![
                ("ANTHROPIC_API_KEY".into(), "localprism-codex-proxy".into()),
                ("ANTHROPIC_MODEL".into(), model.clone()),
                ("ANTHROPIC_DEFAULT_OPUS_MODEL".into(), model.clone()),
                ("ANTHROPIC_DEFAULT_SONNET_MODEL".into(), model.clone()),
                ("ANTHROPIC_DEFAULT_HAIKU_MODEL".into(), model.clone()),
            ],
            remove: vec!["CLAUDE_MODEL".into(), "CLAUDE_CODE_OAUTH_TOKEN".into()],
            proxy_kind: Some(ProxyKind::CodexResponses {
                model,
                effort: effort.map(ToOwned::to_owned),
            }),
        });
    }

    let provider = index
        .third_party(active_id)
        .cloned()
        .ok_or_else(|| format!("Active provider {active_id} is missing"))?;
    let catalog = cached_models_for_active();
    let model = pick_catalog_model(
        model_override,
        &catalog,
        Some(provider.models.main.as_str()),
    )
    .unwrap_or_else(|| provider.models.main.clone());
    let model = model.as_str();
    match provider.api_format {
        ApiFormat::Anthropic => {
            let mut routed = provider;
            routed.models.main = model.to_string();
            Ok(ManagedRuntimeEnv {
                values: vec![
                    (
                        "ANTHROPIC_AUTH_TOKEN".into(),
                        "localprism-anthropic-proxy".into(),
                    ),
                    ("ANTHROPIC_MODEL".into(), model.to_string()),
                    (
                        "ANTHROPIC_DEFAULT_HAIKU_MODEL".into(),
                        model.to_string(),
                    ),
                    (
                        "ANTHROPIC_DEFAULT_SONNET_MODEL".into(),
                        model.to_string(),
                    ),
                    (
                        "ANTHROPIC_DEFAULT_OPUS_MODEL".into(),
                        model.to_string(),
                    ),
                ],
                remove: vec![
                    "ANTHROPIC_API_KEY".into(),
                    "CLAUDE_MODEL".into(),
                    "CLAUDE_CODE_OAUTH_TOKEN".into(),
                ],
                proxy_kind: Some(ProxyKind::AnthropicNative(routed)),
            })
        }
        ApiFormat::OpenaiChat | ApiFormat::OpenaiResponses => {
            let mut routed = provider;
            routed.models.main = model.to_string();
            Ok(ManagedRuntimeEnv {
                values: vec![
                    ("ANTHROPIC_API_KEY".into(), "localprism-chat-proxy".into()),
                    ("ANTHROPIC_MODEL".into(), model.to_string()),
                ],
                remove: vec!["CLAUDE_MODEL".into(), "CLAUDE_CODE_OAUTH_TOKEN".into()],
                proxy_kind: Some(ProxyKind::OpenaiChat(routed)),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::models::save_cached_models;
    use crate::providers::store::{save_index, save_oauth};
    use crate::providers::types::{
        OAuthTokens, ProviderIndex, ProviderModel, ProviderModels, SavedProvider,
        CHATGPT_MODEL_SOL, CHATGPT_MODEL_TERRA,
    };
    use tempfile::TempDir;

    fn isolate() -> (TempDir, std::sync::MutexGuard<'static, ()>) {
        let guard = crate::providers::paths::lock_provider_env();
        let dir = TempDir::new().unwrap();
        std::env::set_var("LOCALPRISM_PROVIDERS_DIR", dir.path());
        std::env::set_var(
            "LOCALPRISM_LEGACY_ANTHROPIC_AUTH",
            dir.path().join("missing-legacy.json"),
        );
        (dir, guard)
    }

    #[test]
    fn claude_official_injects_oauth_and_clears_base_url() {
        let (_dir, _guard) = isolate();
        let mut index = ProviderIndex::default();
        index.active_id = Some(CLAUDE_OFFICIAL_ID.into());
        save_index(&index).unwrap();
        save_oauth(
            OAuthKind::Claude,
            &OAuthTokens {
                access_token: "oauth-token".into(),
                refresh_token: None,
                expires_at: 9_999_999_999,
                account_id: None,
                email: None,
                subscription_type: None,
            },
        )
        .unwrap();

        let env = build_managed_env(Some("opus"), None).unwrap();
        assert!(env
            .values
            .iter()
            .any(|(key, value)| key == "ANTHROPIC_AUTH_TOKEN" && value == "oauth-token"));
        assert!(env.remove.iter().any(|key| key == "ANTHROPIC_BASE_URL"));
        assert!(env.proxy_kind.is_none());
    }

    #[test]
    fn third_party_anthropic_uses_passthrough_proxy() {
        let (_dir, _guard) = isolate();
        let mut index = ProviderIndex::default();
        index.active_id = Some("qwen".into());
        index.providers.push(SavedProvider {
            id: "qwen".into(),
            name: "Qwen".into(),
            api_key: "sk-test".into(),
            base_url: "https://dashscope.aliyuncs.com/apps/anthropic".into(),
            api_format: ApiFormat::Anthropic,
            models: ProviderModels {
                main: "qwen3-max".into(),
                haiku: None,
                sonnet: None,
                opus: None,
            },
        });
        save_index(&index).unwrap();

        let env = build_managed_env(None, None).unwrap();
        match env.proxy_kind {
            Some(ProxyKind::AnthropicNative(provider)) => {
                assert_eq!(provider.base_url, "https://dashscope.aliyuncs.com/apps/anthropic");
                assert_eq!(provider.models.main, "qwen3-max");
                assert_eq!(provider.api_key, "sk-test");
            }
            other => panic!("expected AnthropicNative, got {other:?}"),
        }
        assert!(env.values.iter().all(|(key, _)| key != "ANTHROPIC_BASE_URL"));
        assert!(env
            .values
            .iter()
            .any(|(key, value)| key == "ANTHROPIC_AUTH_TOKEN" && value == "localprism-anthropic-proxy"));
    }

    #[test]
    fn chatgpt_official_uses_live_catalog_default_for_leftover_alias() {
        let (_dir, _guard) = isolate();
        let mut index = ProviderIndex::default();
        index.active_id = Some(CHATGPT_OFFICIAL_ID.into());
        save_index(&index).unwrap();
        save_cached_models(
            CHATGPT_OFFICIAL_ID,
            &[
                ProviderModel {
                    id: "gpt-5.4".into(),
                    display_name: "GPT-5.4".into(),
                    reasoning_efforts: vec!["medium".into()],
                    is_default: true,
                    context_window: None,
                    metadata: None,
                },
                ProviderModel {
                    id: "gpt-5.3-codex".into(),
                    display_name: "Codex".into(),
                    reasoning_efforts: vec!["medium".into()],
                    is_default: false,
                    context_window: None,
                    metadata: None,
                },
            ],
        )
        .unwrap();

        let env = build_managed_env(Some("opus"), Some("high")).unwrap();
        match env.proxy_kind {
            Some(ProxyKind::CodexResponses { model, effort }) => {
                assert_eq!(model, "gpt-5.4");
                assert_eq!(effort.as_deref(), Some("high"));
            }
            other => panic!("expected CodexResponses, got {other:?}"),
        }
        assert!(env
            .values
            .iter()
            .any(|(key, value)| key == "ANTHROPIC_MODEL" && value == "gpt-5.4"));
        assert!(env.values.iter().all(|(key, value)| {
            !key.starts_with("ANTHROPIC_DEFAULT_") || value == "gpt-5.4"
        }));
        assert_eq!(
            resolve_active_spawn_model(Some("opus")).as_deref(),
            Some("gpt-5.4")
        );
        assert_eq!(
            resolve_active_spawn_model(Some("sonnet")).as_deref(),
            Some("gpt-5.4")
        );
    }

    #[test]
    fn chatgpt_official_empty_catalog_uses_bundled_default_for_leftover_alias() {
        let (_dir, _guard) = isolate();
        let mut index = ProviderIndex::default();
        index.active_id = Some(CHATGPT_OFFICIAL_ID.into());
        save_index(&index).unwrap();

        assert_eq!(
            resolve_active_spawn_model(Some("opus")).as_deref(),
            Some(CHATGPT_MODEL_SOL)
        );
        assert_eq!(
            active_provider_identity(),
            ActiveProviderIdentity::ChatGptOfficial
        );
    }

    #[test]
    fn chatgpt_official_keeps_explicit_gpt_model() {
        let (_dir, _guard) = isolate();
        let mut index = ProviderIndex::default();
        index.active_id = Some(CHATGPT_OFFICIAL_ID.into());
        save_index(&index).unwrap();
        save_cached_models(
            CHATGPT_OFFICIAL_ID,
            &[
                ProviderModel {
                    id: "gpt-5.4".into(),
                    display_name: "GPT-5.4".into(),
                    reasoning_efforts: vec!["medium".into()],
                    is_default: true,
                    context_window: None,
                    metadata: None,
                },
                ProviderModel {
                    id: "gpt-5.3-codex".into(),
                    display_name: "Codex".into(),
                    reasoning_efforts: vec!["medium".into()],
                    is_default: false,
                    context_window: None,
                    metadata: None,
                },
            ],
        )
        .unwrap();

        let env = build_managed_env(Some("gpt-5.3-codex"), None).unwrap();
        match env.proxy_kind {
            Some(ProxyKind::CodexResponses { model, .. }) => {
                assert_eq!(model, "gpt-5.3-codex");
            }
            other => panic!("expected CodexResponses, got {other:?}"),
        }
    }

    #[test]
    fn chatgpt_official_keeps_explicit_terra() {
        let (_dir, _guard) = isolate();
        let mut index = ProviderIndex::default();
        index.active_id = Some(CHATGPT_OFFICIAL_ID.into());
        save_index(&index).unwrap();
        save_cached_models(
            CHATGPT_OFFICIAL_ID,
            &[
                ProviderModel {
                    id: "gpt-5.5".into(),
                    display_name: "GPT-5.5".into(),
                    reasoning_efforts: vec!["medium".into()],
                    is_default: true,
                    context_window: None,
                    metadata: None,
                },
                ProviderModel {
                    id: CHATGPT_MODEL_TERRA.into(),
                    display_name: "Terra".into(),
                    reasoning_efforts: vec!["medium".into()],
                    is_default: false,
                    context_window: None,
                    metadata: None,
                },
            ],
        )
        .unwrap();

        let env = build_managed_env(Some(CHATGPT_MODEL_TERRA), Some("low")).unwrap();
        match env.proxy_kind {
            Some(ProxyKind::CodexResponses { model, .. }) => {
                assert_eq!(model, CHATGPT_MODEL_TERRA);
            }
            other => panic!("expected CodexResponses, got {other:?}"),
        }
        assert_eq!(
            resolve_active_spawn_model(Some(CHATGPT_MODEL_TERRA)).as_deref(),
            Some(CHATGPT_MODEL_TERRA)
        );
    }
}
