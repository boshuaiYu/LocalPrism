mod claude_oauth;
pub(crate) mod crypto;
mod env;
mod models;
mod oauth_listen;
pub(crate) mod openai_oauth;
pub(crate) mod paths;
mod store;
mod types;
mod url_guard;

use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::anthropic_proxy::responses::CodexProxyCredential;
use crate::anthropic_proxy::{
    start_anthropic_passthrough_proxy, start_codex_responses_proxy, start_openai_anthropic_proxy,
    OpenAiProxyCredential,
};

pub use env::{
    active_provider_identity, build_managed_env, resolve_active_spawn_model,
    ActiveProviderIdentity, ProxyKind,
};
pub use types::{
    is_legacy_claude_alias, workspace_ready, ProviderCard, ProviderKind, ProviderModel,
    ProviderWorkspaceStatus, SavedProvider, CHATGPT_OFFICIAL_ID, CLAUDE_OFFICIAL_ID,
};
pub use url_guard::{bypass_system_proxy_for_loopback, ensure_secure_provider_base_url};

use store::{delete_oauth, load_index, load_oauth, save_index, OAuthKind};
use types::{is_official_id, ProviderIndex};

#[derive(Default)]
pub struct ProviderLoginState {
    inner: Mutex<Option<PendingKind>>,
}

enum PendingKind {
    Claude,
    Chatgpt,
}

#[tauri::command]
pub async fn provider_status(
    _login: State<'_, Arc<ProviderLoginState>>,
) -> Result<ProviderWorkspaceStatus, String> {
    workspace_status().await
}

#[tauri::command]
pub async fn provider_list_models() -> Result<Vec<ProviderModel>, String> {
    models::models_for_active_fresh().await
}

#[tauri::command]
pub async fn provider_activate(id: String) -> Result<ProviderWorkspaceStatus, String> {
    let mut index = load_index()?;
    if is_official_id(&id) {
        if id == CLAUDE_OFFICIAL_ID && load_oauth(OAuthKind::Claude)?.is_none() {
            return Err("Sign in to Claude Official first".into());
        }
        if id == CHATGPT_OFFICIAL_ID && load_oauth(OAuthKind::OpenAi)?.is_none() {
            return Err("Sign in to ChatGPT Official first".into());
        }
        index.active_id = Some(id.clone());
        save_index(&index)?;
        let _ = models::models_for_active_fresh().await;
        return workspace_status().await;
    }
    match index.third_party(&id) {
        None => return Err(format!("Unknown provider: {id}")),
        Some(provider) if provider.api_key.trim().is_empty() => {
            return Err("This provider has no API key".into());
        }
        Some(_) => {}
    }
    index.active_id = Some(id.clone());
    save_index(&index)?;
    let _ = models::models_for_active_fresh().await;
    workspace_status().await
}

#[tauri::command]
pub async fn provider_upsert_third_party(
    provider: SavedProvider,
    activate: bool,
) -> Result<ProviderWorkspaceStatus, String> {
    if provider.name.trim().is_empty() {
        return Err("Provider name is required".into());
    }
    if provider.base_url.trim().is_empty() {
        return Err("Base URL is required".into());
    }
    if provider.models.main.trim().is_empty() {
        return Err("Main model is required".into());
    }
    if provider.api_key.trim().is_empty() {
        return Err("API key is required".into());
    }
    ensure_secure_provider_base_url(&provider.base_url)?;
    let mut index = load_index()?;
    let id = if provider.id.trim().is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        provider.id.clone()
    };
    let mut stored = provider;
    stored.id = id.clone();
    index.upsert_third_party(stored);
    if activate || index.active_id.is_none() {
        index.active_id = Some(id);
    }
    save_index(&index)?;
    let _ = models::models_for_active_fresh().await;
    workspace_status().await
}

#[tauri::command]
pub async fn provider_delete(id: String) -> Result<ProviderWorkspaceStatus, String> {
    if is_official_id(&id) {
        return Err("Official cards cannot be deleted. Sign out instead.".into());
    }
    let mut index = load_index()?;
    index.remove_third_party(&id)?;
    save_index(&index)?;
    workspace_status().await
}

#[tauri::command]
pub async fn provider_oauth_start(
    app: AppHandle,
    kind: String,
    login: State<'_, Arc<ProviderLoginState>>,
) -> Result<claude_oauth::OAuthStart, String> {
    match kind.as_str() {
        "claude" => {
            let (start, session) = claude_oauth::start_login_session().await?;
            {
                let mut guard = login.inner.lock().await;
                *guard = Some(PendingKind::Claude);
            }
            let login_state = Arc::clone(&login);
            let app_handle = app.clone();
            tokio::spawn(async move {
                let result = claude_oauth::finish_login_session(session).await;
                finish_claude(result, &app_handle, &login_state).await;
            });
            Ok(start)
        }
        "chatgpt" => {
            let (start, session) = openai_oauth::start_login_session().await?;
            {
                let mut guard = login.inner.lock().await;
                *guard = Some(PendingKind::Chatgpt);
            }
            let login_state = Arc::clone(&login);
            let app_handle = app.clone();
            tokio::spawn(async move {
                let result = openai_oauth::finish_login_session(session).await;
                finish_chatgpt(result, &app_handle, &login_state).await;
            });
            Ok(openai_oauth_start_as_claude_shape(start))
        }
        other => Err(format!("Unknown OAuth kind: {other}")),
    }
}

fn openai_oauth_start_as_claude_shape(start: openai_oauth::OAuthStart) -> claude_oauth::OAuthStart {
    claude_oauth::OAuthStart {
        auth_url: start.auth_url,
        login_id: start.login_id,
    }
}

async fn finish_claude(
    result: Result<types::OAuthTokens, String>,
    app: &AppHandle,
    login: &Arc<ProviderLoginState>,
) {
    let payload = match result {
        Ok(tokens) => match claude_oauth::persist_tokens(tokens).await {
            Ok(()) => {
                activate_if_empty(CLAUDE_OFFICIAL_ID);
                let _ = models::models_for_provider(CLAUDE_OFFICIAL_ID, true).await;
                serde_json::json!({ "kind": "claude", "ok": true })
            }
            Err(error) => serde_json::json!({ "kind": "claude", "ok": false, "error": error }),
        },
        Err(error) => serde_json::json!({ "kind": "claude", "ok": false, "error": error }),
    };
    let _ = app.emit("provider-oauth-complete", payload);
    let mut guard = login.inner.lock().await;
    *guard = None;
}

async fn finish_chatgpt(
    result: Result<types::OAuthTokens, String>,
    app: &AppHandle,
    login: &Arc<ProviderLoginState>,
) {
    let payload = match result {
        Ok(tokens) => match openai_oauth::persist_tokens(tokens).await {
            Ok(()) => {
                activate_if_empty(CHATGPT_OFFICIAL_ID);
                let _ = models::models_for_provider(CHATGPT_OFFICIAL_ID, true).await;
                serde_json::json!({ "kind": "chatgpt", "ok": true })
            }
            Err(error) => serde_json::json!({ "kind": "chatgpt", "ok": false, "error": error }),
        },
        Err(error) => serde_json::json!({ "kind": "chatgpt", "ok": false, "error": error }),
    };
    let _ = app.emit("provider-oauth-complete", payload);
    let mut guard = login.inner.lock().await;
    *guard = None;
}

fn activate_if_empty(id: &str) {
    if let Ok(mut index) = load_index() {
        if index.active_id.is_none() {
            index.active_id = Some(id.to_string());
            let _ = save_index(&index);
        }
    }
}

#[tauri::command]
pub async fn provider_oauth_logout(kind: String) -> Result<ProviderWorkspaceStatus, String> {
    match kind.as_str() {
        "claude" => {
            delete_oauth(OAuthKind::Claude)?;
            let _ = models::clear_cached_models(CLAUDE_OFFICIAL_ID);
            clear_active_if(CLAUDE_OFFICIAL_ID)?;
        }
        "chatgpt" => {
            delete_oauth(OAuthKind::OpenAi)?;
            let _ = models::clear_cached_models(CHATGPT_OFFICIAL_ID);
            clear_active_if(CHATGPT_OFFICIAL_ID)?;
        }
        other => return Err(format!("Unknown OAuth kind: {other}")),
    }
    workspace_status().await
}

fn clear_active_if(id: &str) -> Result<(), String> {
    let mut index = load_index()?;
    if index.active_id.as_deref() == Some(id) {
        index.active_id = None;
        save_index(&index)?;
    }
    Ok(())
}

pub async fn workspace_status() -> Result<ProviderWorkspaceStatus, String> {
    let engine = crate::claude::probe_claude_engine();
    let index = load_index().unwrap_or_default();
    let claude_auth = load_oauth(OAuthKind::Claude)?.is_some();
    let chatgpt_auth = load_oauth(OAuthKind::OpenAi)?.is_some();
    let active_id = index.active_id.clone();
    let active_authenticated = match active_id.as_deref() {
        Some(id) if id == CLAUDE_OFFICIAL_ID => claude_auth,
        Some(id) if id == CHATGPT_OFFICIAL_ID => chatgpt_auth,
        Some(id) => index
            .third_party(id)
            .is_some_and(|provider| !provider.api_key.trim().is_empty()),
        None => false,
    };
    let models = models::models_for_active().await.unwrap_or_default();
    Ok(ProviderWorkspaceStatus {
        engine_installed: engine.installed,
        engine_version: engine.version,
        missing_git: engine.missing_git,
        active_id: active_id.clone(),
        active_authenticated,
        ready: workspace_ready(engine.installed, active_authenticated),
        cards: build_cards(&index, claude_auth, chatgpt_auth),
        models,
    })
}

fn build_cards(index: &ProviderIndex, claude_auth: bool, chatgpt_auth: bool) -> Vec<ProviderCard> {
    let mut cards = vec![
        ProviderCard {
            id: CLAUDE_OFFICIAL_ID.to_string(),
            kind: ProviderKind::OfficialClaude,
            name: "Claude Official".into(),
            authenticated: claude_auth,
            is_active: index.active_id.as_deref() == Some(CLAUDE_OFFICIAL_ID),
            account_label: load_oauth(OAuthKind::Claude)
                .ok()
                .flatten()
                .and_then(|tokens| tokens.email.or(tokens.subscription_type)),
        },
        ProviderCard {
            id: CHATGPT_OFFICIAL_ID.to_string(),
            kind: ProviderKind::OfficialChatgpt,
            name: "ChatGPT Official".into(),
            authenticated: chatgpt_auth,
            is_active: index.active_id.as_deref() == Some(CHATGPT_OFFICIAL_ID),
            account_label: load_oauth(OAuthKind::OpenAi)
                .ok()
                .flatten()
                .and_then(|tokens| tokens.email),
        },
    ];
    for provider in &index.providers {
        cards.push(ProviderCard {
            id: provider.id.clone(),
            kind: ProviderKind::ThirdParty,
            name: provider.name.clone(),
            authenticated: !provider.api_key.trim().is_empty(),
            is_active: index.active_id.as_deref() == Some(provider.id.as_str()),
            account_label: Some(provider.models.main.clone()),
        });
    }
    cards
}

pub async fn apply_managed_provider(
    cmd: &mut Command,
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<(), String> {
    if let Ok(index) = load_index() {
        if index.active_id.as_deref() == Some(CLAUDE_OFFICIAL_ID) {
            claude_oauth::ensure_fresh_tokens().await?;
        }
    }
    let _ = models::models_for_active().await;
    let managed = build_managed_env(model, effort)?;
    for key in &managed.remove {
        cmd.env_remove(key);
    }
    let mut values = managed.values;
    match managed.proxy_kind {
        Some(ProxyKind::CodexResponses { model, effort }) => {
            let tokens = openai_oauth::ensure_fresh_tokens().await?;
            let proxy = start_codex_responses_proxy(CodexProxyCredential {
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token,
                account_id: tokens.account_id,
                model,
                effort,
            })
            .await?;
            attach_proxy_capability(&mut values, &proxy);
            values.push(("ANTHROPIC_BASE_URL".into(), proxy));
        }
        Some(ProxyKind::OpenaiChat(provider)) => {
            ensure_secure_provider_base_url(&provider.base_url)?;
            let proxy = start_openai_anthropic_proxy(OpenAiProxyCredential {
                api_key: provider.api_key,
                base_url: provider.base_url,
                model: provider.models.main,
                transformers: Vec::new(),
                model_transformers: Vec::new(),
            })
            .await?;
            attach_proxy_capability(&mut values, &proxy);
            values.push(("ANTHROPIC_BASE_URL".into(), proxy));
        }
        Some(ProxyKind::AnthropicNative(provider)) => {
            ensure_secure_provider_base_url(&provider.base_url)?;
            let proxy = start_anthropic_passthrough_proxy(OpenAiProxyCredential {
                api_key: provider.api_key,
                base_url: provider.base_url,
                model: provider.models.main,
                transformers: Vec::new(),
                model_transformers: Vec::new(),
            })
            .await?;
            attach_proxy_capability(&mut values, &proxy);
            values.push(("ANTHROPIC_BASE_URL".into(), proxy));
        }
        None => {}
    }
    for (key, value) in values {
        cmd.env(key, value);
    }
    Ok(())
}

fn attach_proxy_capability(values: &mut Vec<(String, String)>, proxy_url: &str) {
    let Some(token) = crate::anthropic_proxy::proxy_capability_token(proxy_url) else {
        return;
    };
    values.retain(|(key, _)| key != "ANTHROPIC_API_KEY" && key != "ANTHROPIC_AUTH_TOKEN");
    values.push(("ANTHROPIC_API_KEY".into(), token.clone()));
    values.push(("ANTHROPIC_AUTH_TOKEN".into(), token));
}

#[cfg(test)]
mod tests {
    use super::types::workspace_ready;
    use super::*;
    use crate::providers::store::save_index;
    use crate::providers::types::{ApiFormat, ProviderIndex, ProviderModels, SavedProvider};
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

    fn sample_provider(base_url: &str) -> SavedProvider {
        SavedProvider {
            id: String::new(),
            name: "Custom".into(),
            api_key: "sk-test".into(),
            base_url: base_url.into(),
            api_format: ApiFormat::OpenaiChat,
            models: ProviderModels {
                main: "llama3.2".into(),
                haiku: None,
                sonnet: None,
                opus: None,
            },
        }
    }

    #[test]
    fn ready_requires_engine_and_active_provider() {
        assert!(!workspace_ready(false, true));
        assert!(!workspace_ready(true, false));
        assert!(workspace_ready(true, true));
    }

    #[tokio::test]
    async fn upsert_rejects_remote_cleartext_http() {
        let (_dir, _guard) = isolate();
        save_index(&ProviderIndex::default()).unwrap();
        let error = provider_upsert_third_party(
            sample_provider("http://evil.example/v1"),
            true,
        )
        .await
        .expect_err("remote HTTP must be rejected");
        assert!(error.contains("HTTPS"));
    }

    #[tokio::test]
    async fn upsert_allows_localhost_http_for_local_models() {
        let (_dir, _guard) = isolate();
        save_index(&ProviderIndex::default()).unwrap();
        let status = provider_upsert_third_party(
            sample_provider("http://127.0.0.1:11434/v1"),
            true,
        )
        .await
        .expect("loopback HTTP should stay allowed");
        assert!(status.active_authenticated);
    }

    #[test]
    fn proxy_capability_replaces_placeholder_tokens() {
        let mut values = vec![
            ("ANTHROPIC_API_KEY".into(), "localprism-chat-proxy".into()),
            ("ANTHROPIC_MODEL".into(), "llama3.2".into()),
        ];
        attach_proxy_capability(&mut values, "http://127.0.0.1:9/session-secret");
        assert_eq!(
            values
                .iter()
                .find(|(key, _)| key == "ANTHROPIC_API_KEY")
                .map(|(_, value)| value.as_str()),
            Some("session-secret")
        );
        assert_eq!(
            values
                .iter()
                .find(|(key, _)| key == "ANTHROPIC_AUTH_TOKEN")
                .map(|(_, value)| value.as_str()),
            Some("session-secret")
        );
    }
}
