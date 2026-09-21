use crate::runtime::{RuntimeKind, RuntimeModel};
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
struct ModelsCacheFile {
    #[serde(default)]
    models: Vec<CachedModelEntry>,
}

#[derive(Debug, Clone, Deserialize)]
struct CachedModelEntry {
    #[serde(default)]
    slug: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    default_reasoning_level: String,
    #[serde(default)]
    supported_reasoning_levels: Vec<CachedReasoningLevel>,
    #[serde(default)]
    visibility: String,
    #[serde(default)]
    priority: Option<i64>,
    #[serde(default)]
    input_modalities: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct CachedReasoningLevel {
    #[serde(default)]
    effort: String,
}

fn is_internal_codex_model_id(id: &str) -> bool {
    let trimmed = id.trim();
    trimmed == "codex-auto-review"
        || trimmed == "codex-auto-review-mini"
        || trimmed.starts_with("codex-auto-review")
}

pub(crate) fn models_cache_path() -> Option<PathBuf> {
    if let Ok(home) = std::env::var("CODEX_HOME") {
        let trimmed = home.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed).join("models_cache.json"));
        }
    }
    dirs::home_dir().map(|home| home.join(".codex").join("models_cache.json"))
}

fn default_input_modalities() -> Vec<String> {
    vec!["text".to_string(), "image".to_string()]
}

fn entry_to_runtime_model(entry: &CachedModelEntry, is_default: bool) -> Option<RuntimeModel> {
    let id = entry.slug.trim();
    if id.is_empty() || is_internal_codex_model_id(id) {
        return None;
    }

    let display_name = if entry.display_name.trim().is_empty() {
        id.to_string()
    } else {
        entry.display_name.trim().to_string()
    };
    let description = entry.description.trim().to_string();
    let default_reasoning_effort = if entry.default_reasoning_level.trim().is_empty() {
        None
    } else {
        Some(entry.default_reasoning_level.trim().to_string())
    };
    let reasoning_efforts = entry
        .supported_reasoning_levels
        .iter()
        .map(|level| level.effort.trim().to_string())
        .filter(|effort| !effort.is_empty())
        .collect::<Vec<_>>();
    let input_modalities = if entry.input_modalities.is_empty() {
        default_input_modalities()
    } else {
        entry.input_modalities.clone()
    };

    Some(RuntimeModel {
        runtime: RuntimeKind::Codex,
        id: id.to_string(),
        display_name,
        description: Some(description),
        reasoning_efforts,
        default_reasoning_effort,
        input_modalities,
        is_default,
    })
}

fn choose_default_slug(entries: &[CachedModelEntry]) -> Option<String> {
    entries
        .iter()
        .filter(|entry| {
            let id = entry.slug.trim();
            !id.is_empty() && !is_internal_codex_model_id(id) && entry.visibility.trim() == "list"
        })
        .min_by(|left, right| {
            let left_priority = left.priority.unwrap_or(i64::MAX);
            let right_priority = right.priority.unwrap_or(i64::MAX);
            left_priority
                .cmp(&right_priority)
                .then_with(|| left.slug.trim().cmp(right.slug.trim()))
        })
        .map(|entry| entry.slug.trim().to_string())
}

pub(crate) fn parse_models_cache_catalog(json: &str) -> Vec<RuntimeModel> {
    let Ok(file) = serde_json::from_str::<ModelsCacheFile>(json) else {
        return Vec::new();
    };
    let default_slug = choose_default_slug(&file.models);
    file.models
        .iter()
        .filter_map(|entry| {
            let is_default = default_slug
                .as_deref()
                .is_some_and(|slug| slug == entry.slug.trim());
            entry_to_runtime_model(entry, is_default)
        })
        .collect()
}

pub(crate) fn read_models_cache_catalog_from_path(path: &Path) -> Vec<RuntimeModel> {
    let Ok(json) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    parse_models_cache_catalog(&json)
}

/// Soft-fail catalog reader: missing/invalid files yield an empty list.
pub(crate) fn read_models_cache_catalog() -> Vec<RuntimeModel> {
    let Some(path) = models_cache_path() else {
        return Vec::new();
    };
    read_models_cache_catalog_from_path(&path)
}

/// Merge live app-server models with the on-disk Codex catalog.
/// Prefer cache entries when both exist (newer efforts such as max/ultra),
/// preserve cache order, then append live-only models in live order.
pub(crate) fn merge_codex_models(
    live: Vec<RuntimeModel>,
    cached: Vec<RuntimeModel>,
) -> Vec<RuntimeModel> {
    let cached_ids: std::collections::HashSet<String> =
        cached.iter().map(|model| model.id.clone()).collect();
    let mut merged = cached;
    let mut seen: std::collections::HashSet<String> =
        merged.iter().map(|model| model.id.clone()).collect();

    for model in live {
        if cached_ids.contains(&model.id) {
            continue;
        }
        if seen.insert(model.id.clone()) {
            merged.push(model);
        }
    }

    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_json() -> &'static str {
        r#"{
          "models": [
            {
              "slug": "gpt-5.6-sol",
              "display_name": "GPT-5.6-Sol",
              "description": "Frontier model",
              "default_reasoning_level": "low",
              "supported_reasoning_levels": [
                {"effort": "low", "description": "Low"},
                {"effort": "max", "description": "Max"},
                {"effort": "ultra", "description": "Ultra"}
              ],
              "visibility": "list",
              "priority": 1,
              "input_modalities": ["text", "image"]
            },
            {
              "slug": "gpt-5.5",
              "display_name": "GPT-5.5",
              "description": "Previous generation",
              "default_reasoning_level": "medium",
              "supported_reasoning_levels": [
                {"effort": "low", "description": "Low"},
                {"effort": "high", "description": "High"}
              ],
              "visibility": "list",
              "priority": 7
            },
            {
              "slug": "gpt-5.4",
              "display_name": "GPT-5.4",
              "description": "Hidden but included",
              "default_reasoning_level": "medium",
              "supported_reasoning_levels": [],
              "visibility": "hide",
              "priority": 16
            },
            {
              "slug": "codex-auto-review",
              "display_name": "Auto Review",
              "description": "Internal",
              "default_reasoning_level": "medium",
              "supported_reasoning_levels": [],
              "visibility": "hide",
              "priority": 43
            },
            {
              "slug": "codex-auto-review-mini",
              "display_name": "Auto Review Mini",
              "description": "Internal",
              "default_reasoning_level": "medium",
              "supported_reasoning_levels": [],
              "visibility": "hide"
            },
            {
              "slug": "",
              "display_name": "Empty",
              "description": "Skip",
              "visibility": "list"
            }
          ]
        }"#
    }

    #[test]
    fn parse_models_cache_includes_max_ultra_and_filters_auto_review() {
        let models = parse_models_cache_catalog(fixture_json());
        assert_eq!(
            models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec!["gpt-5.6-sol", "gpt-5.5", "gpt-5.4"]
        );
        assert_eq!(models[0].reasoning_efforts, vec!["low", "max", "ultra"]);
        assert_eq!(models[0].default_reasoning_effort.as_deref(), Some("low"));
        assert!(models[0].is_default);
        assert!(!models[1].is_default);
        assert!(!models[2].is_default);
        assert_eq!(models[1].input_modalities, vec!["text", "image"]);
    }

    #[test]
    fn merge_prefers_cache_and_appends_live_only() {
        let cached = parse_models_cache_catalog(fixture_json());
        let live = vec![
            RuntimeModel {
                runtime: RuntimeKind::Codex,
                id: "gpt-5.5".into(),
                display_name: "Stale GPT-5.5".into(),
                description: Some("live stale".into()),
                reasoning_efforts: vec!["low".into()],
                default_reasoning_effort: Some("low".into()),
                input_modalities: vec!["text".into()],
                is_default: true,
            },
            RuntimeModel {
                runtime: RuntimeKind::Codex,
                id: "gpt-live-only".into(),
                display_name: "Live Only".into(),
                description: Some("from app-server".into()),
                reasoning_efforts: vec!["high".into()],
                default_reasoning_effort: Some("high".into()),
                input_modalities: vec!["text".into()],
                is_default: false,
            },
        ];

        let merged = merge_codex_models(live, cached);
        assert_eq!(
            merged
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec!["gpt-5.6-sol", "gpt-5.5", "gpt-5.4", "gpt-live-only"]
        );
        assert_eq!(merged[1].display_name, "GPT-5.5");
        assert_eq!(merged[1].reasoning_efforts, vec!["low", "high"]);
        assert_eq!(merged[3].id, "gpt-live-only");
    }

    #[test]
    fn read_models_cache_catalog_from_temp_file() {
        let temp = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
        let path = temp.path().join("models_cache.json");
        std::fs::write(&path, fixture_json()).unwrap_or_else(|error| panic!("{error}"));
        let models = read_models_cache_catalog_from_path(&path);
        assert_eq!(models.len(), 3);
        assert!(models.iter().any(|model| model.id == "gpt-5.6-sol"));
        assert!(!models
            .iter()
            .any(|model| model.id.starts_with("codex-auto-review")));
    }

    #[test]
    fn read_models_cache_soft_fails_on_missing_or_invalid() {
        let temp = tempfile::tempdir().unwrap_or_else(|error| panic!("{error}"));
        let missing = temp.path().join("missing.json");
        assert!(read_models_cache_catalog_from_path(&missing).is_empty());
        assert!(parse_models_cache_catalog("not-json").is_empty());
    }
}
