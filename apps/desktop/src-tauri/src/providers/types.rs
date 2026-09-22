use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;
pub const CLAUDE_OFFICIAL_ID: &str = "claude-official";
pub const CHATGPT_OFFICIAL_ID: &str = "chatgpt-official";

pub const CHATGPT_MODEL_SOL: &str = "gpt-5.6-sol";
pub const CHATGPT_MODEL_TERRA: &str = "gpt-5.6-terra";
pub const CHATGPT_MODEL_LUNA: &str = "gpt-5.6-luna";

/// Claude CLI slot names that are not real provider catalog ids.
pub fn is_legacy_claude_alias(model: &str) -> bool {
    matches!(
        model.trim().to_ascii_lowercase().as_str(),
        "opus" | "opusplan" | "sonnet" | "haiku" | "main"
    )
}

/// Prefer an id that exists in the live catalog. Leftover Claude aliases
/// become the catalog default instead of a hardcoded Sol/Terra/Luna map.
pub fn pick_catalog_model(
    requested: Option<&str>,
    catalog: &[ProviderModel],
    fallback: Option<&str>,
) -> Option<String> {
    let requested = requested.map(str::trim).filter(|value| !value.is_empty());
    if let Some(id) = requested {
        if catalog.iter().any(|model| model.id == id) {
            return Some(id.to_string());
        }
        if !is_legacy_claude_alias(id) {
            return Some(id.to_string());
        }
    }
    catalog
        .iter()
        .find(|model| model.is_default)
        .or_else(|| catalog.first())
        .map(|model| model.id.clone())
        .or_else(|| fallback.map(str::to_string).filter(|value| !value.is_empty()))
        .or_else(|| requested.map(str::to_string))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApiFormat {
    Anthropic,
    OpenaiChat,
    OpenaiResponses,
}

impl Default for ApiFormat {
    fn default() -> Self {
        Self::OpenaiChat
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModels {
    pub main: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub haiku: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sonnet: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opus: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedProvider {
    pub id: String,
    pub name: String,
    pub api_key: String,
    pub base_url: String,
    #[serde(default)]
    pub api_format: ApiFormat,
    pub models: ProviderModels,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderIndex {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub active_id: Option<String>,
    #[serde(default)]
    pub providers: Vec<SavedProvider>,
}

fn default_schema_version() -> u32 {
    SCHEMA_VERSION
}

impl Default for ProviderIndex {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            active_id: None,
            providers: Vec::new(),
        }
    }
}

impl ProviderIndex {
    pub fn third_party(&self, id: &str) -> Option<&SavedProvider> {
        self.providers.iter().find(|provider| provider.id == id)
    }

    pub fn upsert_third_party(&mut self, provider: SavedProvider) {
        if let Some(existing) = self
            .providers
            .iter_mut()
            .find(|item| item.id == provider.id)
        {
            *existing = provider;
            return;
        }
        self.providers.push(provider);
    }

    pub fn remove_third_party(&mut self, id: &str) -> Result<(), String> {
        if self.active_id.as_deref() == Some(id) {
            return Err("Cannot delete the active provider. Activate another card first.".into());
        }
        let before = self.providers.len();
        self.providers.retain(|provider| provider.id != id);
        if self.providers.len() == before {
            return Err(format!("Unknown provider: {id}"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subscription_type: Option<String>,
}

impl OAuthTokens {
    pub fn is_expired_soon(&self, now_ms: i64) -> bool {
        self.expires_at.saturating_sub(now_ms) <= 5 * 60 * 1000
    }

    pub fn has_access_token(&self) -> bool {
        !self.access_token.trim().is_empty()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderKind {
    OfficialClaude,
    OfficialChatgpt,
    ThirdParty,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCard {
    pub id: String,
    pub kind: ProviderKind,
    pub name: String,
    pub authenticated: bool,
    pub is_active: bool,
    pub account_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    pub id: String,
    pub display_name: String,
    pub reasoning_efforts: Vec<String>,
    pub is_default: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    /// Raw catalog object. The desktop derives continuous reasoning ranges from it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderWorkspaceStatus {
    pub engine_installed: bool,
    pub engine_version: Option<String>,
    pub missing_git: bool,
    pub active_id: Option<String>,
    pub active_authenticated: bool,
    pub ready: bool,
    pub cards: Vec<ProviderCard>,
    pub models: Vec<ProviderModel>,
}

pub fn is_official_id(id: &str) -> bool {
    id == CLAUDE_OFFICIAL_ID || id == CHATGPT_OFFICIAL_ID
}

pub fn workspace_ready(engine_installed: bool, active_authenticated: bool) -> bool {
    engine_installed && active_authenticated
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog(default_id: &str) -> Vec<ProviderModel> {
        vec![
            ProviderModel {
                id: default_id.into(),
                display_name: default_id.into(),
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
        ]
    }

    #[test]
    fn leftover_claude_aliases_use_catalog_default() {
        let models = catalog("gpt-5.4");
        assert_eq!(
            pick_catalog_model(Some("opus"), &models, None).as_deref(),
            Some("gpt-5.4")
        );
        assert_eq!(
            pick_catalog_model(Some("sonnet"), &models, None).as_deref(),
            Some("gpt-5.4")
        );
        assert_eq!(
            pick_catalog_model(Some("haiku"), &models, None).as_deref(),
            Some("gpt-5.4")
        );
    }

    #[test]
    fn catalog_and_custom_ids_pass_through() {
        let models = catalog("gpt-5.4");
        assert_eq!(
            pick_catalog_model(Some("gpt-5.3-codex"), &models, None).as_deref(),
            Some("gpt-5.3-codex")
        );
        assert_eq!(
            pick_catalog_model(Some("my-custom-model"), &models, None).as_deref(),
            Some("my-custom-model")
        );
        assert!(is_legacy_claude_alias("opusplan"));
        assert!(!is_legacy_claude_alias("gpt-5.4"));
    }
}
