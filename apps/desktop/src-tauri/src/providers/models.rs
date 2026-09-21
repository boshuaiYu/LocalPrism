use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::openai_oauth::{
    OPENAI_CODEX_CLIENT_VERSION, OPENAI_CODEX_MODELS_ENDPOINT, OPENAI_CODEX_USER_AGENT,
};
use super::paths::{models_cache_path, write_secret_json};
use super::store::{load_index, load_oauth, OAuthKind};
use super::types::{
    ApiFormat, ProviderModel, SavedProvider, CHATGPT_MODEL_LUNA, CHATGPT_MODEL_SOL,
    CHATGPT_MODEL_TERRA, CHATGPT_OFFICIAL_ID, CLAUDE_OFFICIAL_ID,
};

const CACHE_TTL_MS: i64 = 10 * 60 * 1000;
const CATALOG_CACHE_SCHEMA: u32 = 3;
const ANTHROPIC_MODELS_URL: &str = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const ANTHROPIC_OAUTH_BETA: &str = "oauth-2025-04-20";

#[derive(Debug, Default, Serialize, Deserialize)]
struct CatalogCacheFile {
    #[serde(default)]
    schema_version: u32,
    #[serde(default)]
    catalogs: HashMap<String, CachedCatalog>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedCatalog {
    fetched_at_ms: i64,
    models: Vec<ProviderModel>,
}

pub fn bundled_chatgpt_models() -> Vec<ProviderModel> {
    vec![
        model(CHATGPT_MODEL_SOL, "GPT-5.6 Sol", true),
        model(CHATGPT_MODEL_TERRA, "GPT-5.6 Terra", false),
        model(CHATGPT_MODEL_LUNA, "GPT-5.6 Luna", false),
        model("gpt-5.3-codex", "GPT-5.3 Codex", false),
    ]
}

pub fn bundled_claude_models() -> Vec<ProviderModel> {
    vec![
        ProviderModel {
            id: "sonnet".into(),
            display_name: "Sonnet".into(),
            reasoning_efforts: claude_efforts(),
            is_default: true,
            context_window: Some(200_000),
        },
        ProviderModel {
            id: "opus".into(),
            display_name: "Opus".into(),
            reasoning_efforts: claude_efforts(),
            is_default: false,
            context_window: Some(200_000),
        },
        ProviderModel {
            id: "haiku".into(),
            display_name: "Haiku".into(),
            reasoning_efforts: claude_efforts(),
            is_default: false,
            context_window: Some(200_000),
        },
        ProviderModel {
            id: "opusplan".into(),
            display_name: "OpusPlan".into(),
            reasoning_efforts: claude_efforts(),
            is_default: false,
            context_window: Some(200_000),
        },
    ]
}

fn model(id: &str, name: &str, is_default: bool) -> ProviderModel {
    ProviderModel {
        id: id.to_string(),
        display_name: name.to_string(),
        reasoning_efforts: default_efforts(),
        is_default,
        context_window: Some(272_000),
    }
}

fn default_efforts() -> Vec<String> {
    vec![
        "low".into(),
        "medium".into(),
        "high".into(),
        "xhigh".into(),
    ]
}

fn claude_efforts() -> Vec<String> {
    vec!["low".into(), "medium".into(), "high".into()]
}

pub async fn models_for_active() -> Result<Vec<ProviderModel>, String> {
    models_for_active_id(false).await
}

pub async fn models_for_active_fresh() -> Result<Vec<ProviderModel>, String> {
    models_for_active_id(true).await
}

async fn models_for_active_id(force: bool) -> Result<Vec<ProviderModel>, String> {
    let index = load_index()?;
    let Some(id) = index.active_id.clone() else {
        return Ok(Vec::new());
    };
    models_for_provider(&id, force).await
}

pub async fn models_for_provider(id: &str, force: bool) -> Result<Vec<ProviderModel>, String> {
    if !force {
        if let Some(cached) = load_cached_if_fresh(id) {
            return Ok(cached);
        }
    }
    match fetch_live_models(id).await {
        Ok(models) if !models.is_empty() => {
            save_cached_models(id, &models)?;
            Ok(models)
        }
        Ok(_) | Err(_) => {
            if let Some(cached) = load_cached(id).filter(|models| !models.is_empty()) {
                return Ok(cached);
            }
            Ok(fallback_models(id))
        }
    }
}

pub fn cached_models_for_active() -> Vec<ProviderModel> {
    let Ok(index) = load_index() else {
        return Vec::new();
    };
    let Some(id) = index.active_id.as_deref() else {
        return Vec::new();
    };
    load_cached(id)
        .filter(|models| !models.is_empty())
        .unwrap_or_else(|| fallback_models(id))
}

pub fn save_cached_models(id: &str, models: &[ProviderModel]) -> Result<(), String> {
    let path = models_cache_path()?;
    let mut file = load_cache_file();
    file.schema_version = CATALOG_CACHE_SCHEMA;
    file.catalogs.insert(
        id.to_string(),
        CachedCatalog {
            fetched_at_ms: now_ms(),
            models: models.to_vec(),
        },
    );
    let json = serde_json::to_string_pretty(&file)
        .map_err(|err| format!("Failed to serialize models cache: {err}"))?;
    write_secret_json(&path, &json)
}

pub fn clear_cached_models(id: &str) -> Result<(), String> {
    let path = models_cache_path()?;
    let mut file = load_cache_file();
    if file.catalogs.remove(id).is_none() && !path.exists() {
        return Ok(());
    }
    file.schema_version = CATALOG_CACHE_SCHEMA;
    let json = serde_json::to_string_pretty(&file)
        .map_err(|err| format!("Failed to serialize models cache: {err}"))?;
    write_secret_json(&path, &json)
}

fn fallback_models(id: &str) -> Vec<ProviderModel> {
    if id == CLAUDE_OFFICIAL_ID {
        return bundled_claude_models();
    }
    if id == CHATGPT_OFFICIAL_ID {
        return bundled_chatgpt_models();
    }
    load_index()
        .ok()
        .and_then(|index| index.third_party(id).cloned())
        .map(|provider| configured_third_party_models(&provider))
        .unwrap_or_default()
}

fn configured_third_party_models(provider: &SavedProvider) -> Vec<ProviderModel> {
    let mut models = Vec::new();
    push_unique_model(&mut models, &provider.models.main, true);
    if let Some(sonnet) = provider.models.sonnet.as_deref() {
        push_unique_model(&mut models, sonnet, false);
    }
    if let Some(opus) = provider.models.opus.as_deref() {
        push_unique_model(&mut models, opus, false);
    }
    if let Some(haiku) = provider.models.haiku.as_deref() {
        push_unique_model(&mut models, haiku, false);
    }
    apply_preferred_default(&mut models, Some(provider.models.main.as_str()));
    models
}

fn push_unique_model(models: &mut Vec<ProviderModel>, id: &str, is_default: bool) {
    let id = id.trim();
    if id.is_empty() || models.iter().any(|model| model.id == id) {
        return;
    }
    models.push(ProviderModel {
        id: id.to_string(),
        display_name: id.to_string(),
        reasoning_efforts: claude_efforts(),
        is_default,
        context_window: None,
    });
}

async fn fetch_live_models(id: &str) -> Result<Vec<ProviderModel>, String> {
    if id == CHATGPT_OFFICIAL_ID {
        return live_chatgpt_models().await;
    }
    if id == CLAUDE_OFFICIAL_ID {
        return live_claude_models().await;
    }
    let index = load_index()?;
    let provider = index
        .third_party(id)
        .cloned()
        .ok_or_else(|| format!("Unknown provider: {id}"))?;
    live_third_party_models(&provider).await
}

pub async fn live_chatgpt_models() -> Result<Vec<ProviderModel>, String> {
    let tokens = match super::openai_oauth::ensure_fresh_tokens().await {
        Ok(tokens) => tokens,
        Err(_) => load_oauth(OAuthKind::OpenAi)?
            .ok_or_else(|| "ChatGPT Official is not signed in".to_string())?,
    };
    let mut headers = vec![
        (
            "Authorization".to_string(),
            format!("Bearer {}", tokens.access_token),
        ),
        ("User-Agent".to_string(), OPENAI_CODEX_USER_AGENT.to_string()),
        (
            "originator".to_string(),
            super::openai_oauth::OPENAI_CODEX_ORIGINATOR.to_string(),
        ),
    ];
    if let Some(account_id) = tokens.account_id.as_deref() {
        headers.push(("ChatGPT-Account-Id".to_string(), account_id.to_string()));
    }
    let url = format!(
        "{OPENAI_CODEX_MODELS_ENDPOINT}?client_version={OPENAI_CODEX_CLIENT_VERSION}"
    );
    let value = fetch_json(&url, &headers).await?;
    let parsed = parse_live_models(&value);
    if parsed.is_empty() {
        Err("ChatGPT models response did not include any visible models".into())
    } else {
        Ok(parsed)
    }
}

async fn live_claude_models() -> Result<Vec<ProviderModel>, String> {
    let tokens = match super::claude_oauth::ensure_fresh_tokens().await {
        Ok(tokens) => tokens,
        Err(_) => load_oauth(OAuthKind::Claude)?
            .ok_or_else(|| "Claude Official is not signed in".to_string())?,
    };
    let headers = vec![
        (
            "Authorization".to_string(),
            format!("Bearer {}", tokens.access_token),
        ),
        ("anthropic-version".to_string(), ANTHROPIC_VERSION.to_string()),
        ("anthropic-beta".to_string(), ANTHROPIC_OAUTH_BETA.to_string()),
    ];
    let value = fetch_json(ANTHROPIC_MODELS_URL, &headers).await?;
    let parsed = parse_live_models_with_fallback(&value, &claude_efforts());
    if parsed.is_empty() {
        Err("Claude models response did not include any visible models".into())
    } else {
        Ok(parsed)
    }
}

async fn live_third_party_models(provider: &SavedProvider) -> Result<Vec<ProviderModel>, String> {
    let headers = third_party_headers(provider);
    let mut last_error = "Third-party models request failed".to_string();
    for url in candidate_model_urls(&provider.base_url) {
        match fetch_json(&url, &headers).await {
            Ok(value) => {
                let mut parsed = parse_live_models_with_fallback(
                    &value,
                    &empty_efforts_for_format(provider.api_format),
                );
                if parsed.is_empty() {
                    last_error = format!("{url} did not include any visible models");
                    continue;
                }
                merge_configured_models(&mut parsed, provider);
                return Ok(parsed);
            }
            Err(error) => last_error = format!("{url}: {error}"),
        }
    }
    Err(last_error)
}

fn third_party_headers(provider: &SavedProvider) -> Vec<(String, String)> {
    match provider.api_format {
        ApiFormat::Anthropic => vec![
            ("x-api-key".to_string(), provider.api_key.clone()),
            (
                "Authorization".to_string(),
                format!("Bearer {}", provider.api_key),
            ),
            ("anthropic-version".to_string(), ANTHROPIC_VERSION.to_string()),
        ],
        ApiFormat::OpenaiChat | ApiFormat::OpenaiResponses => vec![(
            "Authorization".to_string(),
            format!("Bearer {}", provider.api_key),
        )],
    }
}

pub fn candidate_model_urls(base_url: &str) -> Vec<String> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Vec::new();
    }
    if base.ends_with("/models") {
        return vec![base.to_string()];
    }
    let mut urls = vec![format!("{base}/models")];
    if !base.ends_with("/v1") {
        urls.push(format!("{base}/v1/models"));
    }
    urls
}

fn merge_configured_models(models: &mut Vec<ProviderModel>, provider: &SavedProvider) {
    push_unique_model(models, &provider.models.main, false);
    apply_preferred_default(models, Some(provider.models.main.as_str()));
}

fn apply_preferred_default(models: &mut [ProviderModel], preferred: Option<&str>) {
    if models.is_empty() {
        return;
    }
    let preferred = preferred
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|id| models.iter().position(|model| model.id == id));
    let current_default = models.iter().position(|model| model.is_default);
    let index = preferred.or(current_default).unwrap_or(0);
    for model in models.iter_mut() {
        model.is_default = false;
    }
    if let Some(model) = models.get_mut(index) {
        model.is_default = true;
    }
}

fn load_cached_if_fresh(id: &str) -> Option<Vec<ProviderModel>> {
    let cached = load_cache_file().catalogs.get(id).cloned()?;
    if now_ms().saturating_sub(cached.fetched_at_ms) > CACHE_TTL_MS {
        return None;
    }
    if cached.models.is_empty() {
        return None;
    }
    Some(cached.models)
}

fn load_cached(id: &str) -> Option<Vec<ProviderModel>> {
    let models = load_cache_file().catalogs.get(id)?.models.clone();
    if models.is_empty() {
        None
    } else {
        Some(models)
    }
}

fn load_cache_file() -> CatalogCacheFile {
    let Ok(path) = models_cache_path() else {
        return CatalogCacheFile::default();
    };
    let Ok(content) = std::fs::read_to_string(path) else {
        return CatalogCacheFile::default();
    };
    let parsed: CatalogCacheFile =
        serde_json::from_str(content.trim_start_matches('\u{feff}')).unwrap_or_default();
    if parsed.schema_version != CATALOG_CACHE_SCHEMA {
        return CatalogCacheFile::default();
    }
    parsed
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

async fn fetch_json(
    url: &str,
    headers: &[(String, String)],
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|err| format!("Failed to build models client: {err}"))?;
    let mut request = client.get(url);
    for (key, value) in headers {
        request = request.header(key, value);
    }
    let response = request
        .send()
        .await
        .map_err(|err| format!("Models request failed: {err}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Models request returned HTTP {}",
            response.status()
        ));
    }
    response
        .json()
        .await
        .map_err(|err| format!("Models JSON invalid: {err}"))
}

pub fn parse_live_models(value: &serde_json::Value) -> Vec<ProviderModel> {
    parse_live_models_with_fallback(value, &default_efforts())
}

fn parse_live_models_with_fallback(
    value: &serde_json::Value,
    empty_fallback: &[String],
) -> Vec<ProviderModel> {
    let items = value
        .get("models")
        .or_else(|| value.get("data"))
        .and_then(|item| item.as_array())
        .cloned()
        .unwrap_or_default();
    let mut parsed = Vec::new();
    for item in items {
        let id = item
            .get("slug")
            .or_else(|| item.get("id"))
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .trim();
        if id.is_empty() || id.starts_with("codex-auto-review") {
            continue;
        }
        let visibility = item
            .get("visibility")
            .and_then(|value| value.as_str())
            .unwrap_or("list");
        if visibility != "list" && visibility != "visible" {
            continue;
        }
        let display = item
            .get("display_name")
            .or_else(|| item.get("name"))
            .and_then(|value| value.as_str())
            .unwrap_or(id);
        let flagged_default = item
            .get("is_default")
            .or_else(|| item.get("default"))
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        parsed.push((
            ProviderModel {
                id: id.to_string(),
                display_name: display.to_string(),
                reasoning_efforts: parse_efforts(&item, empty_fallback),
                is_default: flagged_default,
                context_window: parse_context_window(&item),
            },
            item.get("priority").and_then(|value| value.as_i64()),
        ));
    }
    apply_account_default(&mut parsed);
    parsed.into_iter().map(|(model, _)| model).collect()
}

fn apply_account_default(parsed: &mut [(ProviderModel, Option<i64>)]) {
    if parsed.is_empty() {
        return;
    }
    let index = if parsed.iter().any(|(_, priority)| priority.is_some()) {
        parsed
            .iter()
            .enumerate()
            .min_by(|(_, left), (_, right)| {
                left.1
                    .unwrap_or(i64::MAX)
                    .cmp(&right.1.unwrap_or(i64::MAX))
                    .then_with(|| left.0.id.cmp(&right.0.id))
            })
            .map(|(index, _)| index)
    } else {
        parsed.iter().position(|(model, _)| model.is_default)
    }
    .unwrap_or(0);
    for (model, _) in parsed.iter_mut() {
        model.is_default = false;
    }
    if let Some((model, _)) = parsed.get_mut(index) {
        model.is_default = true;
    }
}

fn empty_efforts_for_format(api_format: ApiFormat) -> Vec<String> {
    match api_format {
        ApiFormat::Anthropic => claude_efforts(),
        ApiFormat::OpenaiChat | ApiFormat::OpenaiResponses => default_efforts(),
    }
}

fn parse_efforts(item: &serde_json::Value, empty_fallback: &[String]) -> Vec<String> {
    let efforts = item
        .get("supported_reasoning_levels")
        .or_else(|| item.get("supported_reasoning_efforts"))
        .or_else(|| item.get("reasoning_efforts"))
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(parse_effort_token)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if efforts.is_empty() {
        empty_fallback.to_vec()
    } else {
        efforts
    }
}

fn parse_context_window(item: &serde_json::Value) -> Option<u64> {
    const KEYS: [&str; 6] = [
        "context_window",
        "contextWindow",
        "max_context_window",
        "maxContextWindow",
        "input_token_limit",
        "max_input_tokens",
    ];
    for key in KEYS {
        if let Some(window) = item.get(key).and_then(json_u64).filter(|value| *value > 0) {
            return Some(window);
        }
    }
    const POINTERS: [&str; 3] = [
        "/limits/context_window",
        "/limits/max_context_window",
        "/capabilities/context_window",
    ];
    for pointer in POINTERS {
        if let Some(window) = item.pointer(pointer).and_then(json_u64).filter(|value| *value > 0) {
            return Some(window);
        }
    }
    None
}

fn json_u64(value: &serde_json::Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|n| u64::try_from(n).ok()))
        .or_else(|| value.as_f64().and_then(|n| (n.is_finite() && n > 0.0).then_some(n as u64)))
}

fn parse_effort_token(value: &serde_json::Value) -> Option<String> {
    value.as_str().map(str::to_string).or_else(|| {
        value
            .get("effort")
            .or_else(|| value.get("id"))
            .or_else(|| value.get("reasoningEffort"))
            .or_else(|| value.get("reasoning_effort"))
            .and_then(|effort| effort.as_str())
            .map(str::to_string)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_catalog_filters_internal_models_and_uses_api_default() {
        let value = serde_json::json!({
            "data": [
                {"id": "gpt-5.3-codex", "display_name": "Codex", "visibility": "list"},
                {"id": "gpt-5.4", "display_name": "GPT-5.4", "visibility": "list", "is_default": true},
                {"id": "codex-auto-review-1", "visibility": "list"},
                {"id": "hidden", "visibility": "hidden"}
            ]
        });
        let models = parse_live_models(&value);
        assert_eq!(models.len(), 2);
        assert_eq!(models[1].id, "gpt-5.4");
        assert!(models[1].is_default);
        assert!(!models[0].is_default);
    }

    #[test]
    fn first_visible_model_is_default_when_api_omits_flag() {
        let value = serde_json::json!({
            "models": [
                {"id": "gpt-5.4", "display_name": "GPT-5.4", "visibility": "list"},
                {"id": "gpt-5.3-codex", "visibility": "list"}
            ]
        });
        let models = parse_live_models(&value);
        assert_eq!(models[0].id, "gpt-5.4");
        assert!(models[0].is_default);
    }

    #[test]
    fn account_catalog_uses_codex_priority_and_slug() {
        let value = serde_json::json!({
            "models": [
                {
                    "slug": "gpt-5.6-terra",
                    "display_name": "GPT-5.6-Terra",
                    "visibility": "list",
                    "priority": 7,
                    "supported_reasoning_levels": [{"effort": "low"}, {"effort": "xhigh"}]
                },
                {
                    "slug": "gpt-5.6-sol",
                    "display_name": "GPT-5.6-Sol",
                    "visibility": "list",
                    "priority": 1,
                    "supported_reasoning_levels": [{"effort": "low"}, {"effort": "max"}]
                },
                {
                    "slug": "gpt-6-astra",
                    "display_name": "GPT-6-Astra",
                    "visibility": "list",
                    "priority": 1
                },
                {
                    "slug": "gpt-reserve",
                    "visibility": "hide",
                    "priority": 3
                },
                {
                    "slug": "codex-auto-review",
                    "visibility": "list"
                }
            ]
        });
        let models = parse_live_models(&value);
        assert_eq!(
            models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(),
            vec!["gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra"]
        );
        assert_eq!(
            models.iter().find(|model| model.is_default).map(|model| model.id.as_str()),
            Some("gpt-5.6-sol")
        );
        assert_eq!(
            models.iter().find(|model| model.id == "gpt-5.6-sol").map(|model| model.reasoning_efforts.clone()),
            Some(vec!["low".into(), "max".into()])
        );
    }

    #[test]
    fn bundled_chatgpt_models_use_272k_until_catalog_overrides() {
        for model in bundled_chatgpt_models() {
            assert_eq!(model.context_window, Some(272_000), "{}", model.id);
        }
    }

    #[test]
    fn live_catalog_keeps_per_model_windows() {
        let value = serde_json::json!({
            "models": [
                {
                    "slug": "gpt-5.6-luna",
                    "display_name": "GPT-5.6-Luna",
                    "visibility": "list",
                    "context_window": 272000
                },
                {
                    "slug": "gpt-5.6-terra",
                    "display_name": "GPT-5.6-Terra",
                    "visibility": "list",
                    "limits": { "context_window": 400000 }
                }
            ]
        });
        let models = parse_live_models(&value);
        assert_eq!(
            models.iter().find(|model| model.id == "gpt-5.6-luna").map(|model| model.context_window),
            Some(Some(272_000))
        );
        assert_eq!(
            models.iter().find(|model| model.id == "gpt-5.6-terra").map(|model| model.context_window),
            Some(Some(400_000))
        );
    }

    #[test]
    fn live_catalog_reads_context_window_before_max() {
        let value = serde_json::json!({
            "models": [{
                "slug": "gpt-6-astra",
                "display_name": "GPT-6-Astra",
                "visibility": "list",
                "context_window": 272000,
                "max_context_window": 872000
            }]
        });
        let models = parse_live_models(&value);
        assert_eq!(models[0].context_window, Some(272_000));
    }

    #[test]
    fn parse_efforts_reads_reasoning_effort_objects() {
        let value = serde_json::json!({
            "data": [{
                "id": "gpt-5.6-terra",
                "display_name": "GPT-5.6 Terra",
                "supported_reasoning_efforts": [
                    { "reasoningEffort": "low" },
                    { "reasoningEffort": "xhigh" }
                ]
            }]
        });
        let models = parse_live_models(&value);
        assert_eq!(models[0].reasoning_efforts, vec!["low", "xhigh"]);
    }

    #[test]
    fn third_party_empty_efforts_follow_api_format() {
        assert_eq!(
            empty_efforts_for_format(ApiFormat::Anthropic),
            vec!["low", "medium", "high"]
        );
        assert_eq!(
            empty_efforts_for_format(ApiFormat::OpenaiChat),
            vec!["low", "medium", "high", "xhigh"]
        );
    }

    #[test]
    fn claude_catalog_without_efforts_uses_claude_fallback() {
        let value = serde_json::json!({
            "data": [{ "id": "claude-opus-4-6", "display_name": "Opus" }]
        });
        let models = parse_live_models_with_fallback(&value, &claude_efforts());
        assert_eq!(models[0].reasoning_efforts, vec!["low", "medium", "high"]);
    }

    #[test]
    fn candidate_urls_cover_openai_and_anthropic_bases() {
        assert_eq!(
            candidate_model_urls("https://api.deepseek.com/anthropic"),
            vec![
                "https://api.deepseek.com/anthropic/models".to_string(),
                "https://api.deepseek.com/anthropic/v1/models".to_string()
            ]
        );
        assert_eq!(
            candidate_model_urls("http://127.0.0.1:8080/v1"),
            vec!["http://127.0.0.1:8080/v1/models".to_string()]
        );
        assert_eq!(
            candidate_model_urls("https://api.openai.com/v1/models"),
            vec!["https://api.openai.com/v1/models".to_string()]
        );
    }
}
