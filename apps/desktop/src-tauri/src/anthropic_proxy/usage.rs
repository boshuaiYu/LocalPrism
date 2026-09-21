use serde_json::Value;

pub(super) fn usage_token(usage: &Value, keys: &[&str]) -> u64 {
    keys.iter()
        .find_map(|key| usage.get(*key).and_then(Value::as_u64))
        .unwrap_or(0)
}

pub(super) fn openai_cache_read_tokens(usage: &Value) -> u64 {
    usage
        .pointer("/prompt_tokens_details/cached_tokens")
        .and_then(Value::as_u64)
        .or_else(|| {
            usage
                .pointer("/input_tokens_details/cached_tokens")
                .and_then(Value::as_u64)
        })
        .or_else(|| usage.get("cached_tokens").and_then(Value::as_u64))
        .or_else(|| usage.get("cache_read_input_tokens").and_then(Value::as_u64))
        .unwrap_or(0)
}

/// OpenAI Chat and Codex Responses count cached tokens inside
/// `prompt_tokens` / `input_tokens`. Anthropic reports those separately, so
/// the meter can add `input + cache_read` without double-counting.
pub(super) fn exclusive_openai_input_tokens(input: u64, cache: u64) -> u64 {
    if cache > 0 && cache <= input {
        input - cache
    } else {
        input
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn splits_inclusive_openai_prompt_from_cache() {
        let usage = json!({
            "input_tokens": 119881,
            "output_tokens": 7011,
            "input_tokens_details": { "cached_tokens": 53760 }
        });
        let cache = openai_cache_read_tokens(&usage);
        let input = exclusive_openai_input_tokens(
            usage_token(&usage, &["input_tokens", "prompt_tokens"]),
            cache,
        );
        assert_eq!(cache, 53_760);
        assert_eq!(input, 66_121);
        assert_eq!(input + cache, 119_881);
    }

    #[test]
    fn leaves_exclusive_or_empty_cache_unchanged() {
        assert_eq!(exclusive_openai_input_tokens(3_588, 0), 3_588);
        assert_eq!(exclusive_openai_input_tokens(100, 200), 100);
    }
}
