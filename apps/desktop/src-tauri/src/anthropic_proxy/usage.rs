use serde_json::Value;

/// One provider usage object, split the way the context meter displays it.
///
/// `input_tokens` is the uncached prompt. Cached and cache-write tokens are
/// returned separately so the meter can add them back without counting the
/// same tokens twice. `None` means the provider omitted the field; a present
/// zero is `Some(0)` and must not be treated as "unknown".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SplitUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: Option<u64>,
    pub cache_creation_tokens: Option<u64>,
}

pub(super) fn usage_token(usage: &Value, keys: &[&str]) -> u64 {
    first_positive(usage, keys).unwrap_or(0)
}

pub(super) fn openai_cache_read_tokens(usage: &Value) -> u64 {
    split_provider_usage(usage)
        .cache_read_tokens
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

pub(crate) fn split_provider_usage(usage: &Value) -> SplitUsage {
    let anthropic_read = field_number(
        usage,
        &[
            "cache_read_input_tokens",
            "cacheReadInputTokens",
        ],
    );
    let anthropic_write = field_number(
        usage,
        &[
            "cache_creation_input_tokens",
            "cacheCreationInputTokens",
        ],
    );
    let cache_read = first_count(
        usage,
        &[
            "/prompt_tokens_details/cached_tokens",
            "/promptTokensDetails/cachedTokens",
            "/input_tokens_details/cached_tokens",
            "/inputTokensDetails/cachedTokens",
            "/usage_metadata/cached_content_token_count",
            "/usageMetadata/cachedContentTokenCount",
        ],
        &[
            "cache_read_input_tokens",
            "cacheReadInputTokens",
            "cached_input_tokens",
            "cachedInputTokens",
            "cached_tokens",
            "cachedTokens",
            "cache_read_tokens",
            "cacheReadTokens",
            "prompt_cache_hit_tokens",
            "promptCacheHitTokens",
            "cached_content_token_count",
            "cachedContentTokenCount",
        ],
    );
    let cache_write = first_count(
        usage,
        &[
            "/prompt_tokens_details/cache_write_tokens",
            "/promptTokensDetails/cacheWriteTokens",
            "/input_tokens_details/cache_write_tokens",
            "/inputTokensDetails/cacheWriteTokens",
        ],
        &[
            "cache_creation_input_tokens",
            "cacheCreationInputTokens",
            "cache_write_input_tokens",
            "cacheWriteInputTokens",
            "cache_creation_tokens",
            "cacheCreationTokens",
            "cache_write_tokens",
            "cacheWriteTokens",
        ],
    );
    let raw_input = first_positive(
        usage,
        &[
            "input_tokens",
            "inputTokens",
            "prompt_tokens",
            "promptTokens",
            "prompt_token_count",
            "promptTokenCount",
        ],
    )
    .unwrap_or(0);
    // Anthropic `input_tokens` already excludes cache read/write. OpenAI,
    // Codex, DeepSeek, Moonshot, and Gemini include cache hits in the prompt
    // total, so split those out. Leave the input alone when the reported
    // cache is larger than the prompt (that is the Anthropic shape, or a
    // field that is not a subset of this input).
    let anthropic_shape = anthropic_read.is_some_and(|value| value > 0)
        || anthropic_write.is_some_and(|value| value > 0);
    let mut input_tokens = raw_input;
    if !anthropic_shape {
        if let Some(cache) = cache_read {
            if cache > 0 && cache <= input_tokens {
                input_tokens -= cache;
            }
        }
        if let Some(cache) = cache_write {
            if cache > 0 && cache <= input_tokens {
                input_tokens -= cache;
            }
        }
    }

    SplitUsage {
        input_tokens,
        output_tokens: first_positive(
            usage,
            &[
                "output_tokens",
                "outputTokens",
                "completion_tokens",
                "completionTokens",
                "completion_token_count",
                "completionTokenCount",
                "candidates_token_count",
                "candidatesTokenCount",
            ],
        )
        .unwrap_or(0),
        cache_read_tokens: cache_read,
        cache_creation_tokens: cache_write,
    }
}

fn first_count(usage: &Value, pointers: &[&str], keys: &[&str]) -> Option<u64> {
    let mut saw_zero = false;
    for pointer in pointers {
        match pointer_number(usage, pointer) {
            Some(value) if value > 0 => return Some(value),
            Some(_) => saw_zero = true,
            None => {}
        }
    }
    for key in keys {
        match field_number(usage, &[key]) {
            Some(value) if value > 0 => return Some(value),
            Some(_) => saw_zero = true,
            None => {}
        }
    }
    saw_zero.then_some(0)
}

fn first_positive(usage: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter().find_map(|key| {
        field_number(usage, &[key]).filter(|value| *value > 0)
    })
}

fn pointer_number(usage: &Value, pointer: &str) -> Option<u64> {
    usage.pointer(pointer).and_then(json_u64)
}

fn field_number(usage: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| usage.get(*key).and_then(json_u64))
}

fn json_u64(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|number| u64::try_from(number).ok()))
        .or_else(|| {
            value.as_f64().and_then(|number| {
                if number.is_finite() && number >= 0.0 && number <= u64::MAX as f64 {
                    Some(number as u64)
                } else {
                    None
                }
            })
        })
        .or_else(|| {
            value
                .as_str()
                .and_then(|text| text.trim().parse::<u64>().ok())
        })
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

    #[test]
    fn reads_codex_cached_input_tokens_and_cache_writes() {
        let split = split_provider_usage(&json!({
            "input_tokens": 189_600,
            "cached_input_tokens": 170_000,
            "cache_write_input_tokens": 1_200,
            "output_tokens": 2_965
        }));
        assert_eq!(split.cache_read_tokens, Some(170_000));
        assert_eq!(split.cache_creation_tokens, Some(1_200));
        assert_eq!(split.input_tokens, 18_400);
        assert_eq!(split.output_tokens, 2_965);
        assert_eq!(
            split.input_tokens
                + split.cache_read_tokens.unwrap()
                + split.cache_creation_tokens.unwrap(),
            189_600
        );
    }

    #[test]
    fn reads_camel_case_responses_details_and_numeric_strings() {
        let split = split_provider_usage(&json!({
            "inputTokens": "98000",
            "outputTokens": 1500,
            "inputTokensDetails": { "cachedTokens": "90000", "cacheWriteTokens": 0 }
        }));
        assert_eq!(split.input_tokens, 8_000);
        assert_eq!(split.cache_read_tokens, Some(90_000));
        assert_eq!(split.cache_creation_tokens, Some(0));
    }

    #[test]
    fn reads_deepseek_and_gemini_cache_hits_without_inventing_a_zero() {
        let deepseek = split_provider_usage(&json!({
            "prompt_tokens": 4_000,
            "completion_tokens": 20,
            "prompt_cache_hit_tokens": 3_200,
            "prompt_cache_miss_tokens": 800
        }));
        assert_eq!(deepseek.input_tokens, 800);
        assert_eq!(deepseek.cache_read_tokens, Some(3_200));
        assert_eq!(deepseek.cache_creation_tokens, None);

        let gemini = split_provider_usage(&json!({
            "promptTokenCount": 5_000,
            "candidatesTokenCount": 30,
            "cachedContentTokenCount": 4_100
        }));
        assert_eq!(gemini.input_tokens, 900);
        assert_eq!(gemini.cache_read_tokens, Some(4_100));

        let missing = split_provider_usage(&json!({
            "input_tokens": 120,
            "output_tokens": 8
        }));
        assert_eq!(missing.cache_read_tokens, None);
        assert_eq!(missing.cache_creation_tokens, None);
        assert_eq!(missing.input_tokens, 120);
    }

    #[test]
    fn keeps_anthropic_input_when_cache_is_already_exclusive() {
        let split = split_provider_usage(&json!({
            "input_tokens": 3_588,
            "output_tokens": 100,
            "cache_read_input_tokens": 20_992,
            "cache_creation_input_tokens": 640
        }));
        assert_eq!(split.input_tokens, 3_588);
        assert_eq!(split.cache_read_tokens, Some(20_992));
        assert_eq!(split.cache_creation_tokens, Some(640));
    }
}
