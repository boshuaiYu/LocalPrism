use serde_json::{json, Value};

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

pub(super) fn record_turn_usage(slot: u64, usage: SplitUsage, subagent: bool) {
    if subagent || slot == 0 {
        return;
    }
    let cache_read = usage.cache_read_tokens.unwrap_or(0);
    let cache_write = usage.cache_creation_tokens.unwrap_or(0);
    if usage.input_tokens == 0 && usage.output_tokens == 0 && cache_read == 0 && cache_write == 0 {
        return;
    }
    crate::codex_turn_usage::record(
        slot,
        crate::codex_turn_usage::CodexRequestUsage {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_tokens: cache_read,
            cache_creation_tokens: cache_write,
        },
    );
}

/// Anthropic Messages SSE usage, merged the way the meter needs it.
///
/// `message_start` usually carries input and cache with `output_tokens: 0`.
/// `message_delta` then carries the real output, sometimes alone and sometimes
/// as a full usage object. Fields that are present replace the previous
/// value, including an explicit zero. Fields that are absent stay. The two
/// events are not added together.
#[derive(Default)]
pub(crate) struct AnthropicStreamUsage {
    buffer: Vec<u8>,
    finished: bool,
    committed: bool,
    saw_usage: bool,
    last_raw: Option<Value>,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
}

impl AnthropicStreamUsage {
    pub(crate) fn push_bytes(&mut self, chunk: &[u8]) {
        if self.finished {
            return;
        }
        self.buffer.extend_from_slice(chunk);
        self.drain_blocks(false);
    }

    pub(crate) fn finish(&mut self) {
        if self.finished {
            return;
        }
        self.finished = true;
        self.drain_blocks(true);
    }

    pub(crate) fn observe_message(&mut self, message: &Value) {
        if let Some(usage) = message.get("usage") {
            self.observe_usage(usage);
            return;
        }
        self.observe_event(message);
    }

    pub(crate) fn commit(&mut self, model: &str, slot: u64, subagent: bool) {
        if self.committed {
            return;
        }
        self.finish();
        self.committed = true;
        if !self.saw_usage {
            return;
        }
        let anthropic = json!({
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cache_read_input_tokens": self.cache_read_tokens,
            "cache_creation_input_tokens": self.cache_creation_tokens,
        });
        let raw = self.last_raw.clone().unwrap_or(Value::Null);
        let model = if model.trim().is_empty() {
            "unknown"
        } else {
            model
        };
        crate::usage_debug::log_translated(model, &raw, &anthropic);
        record_turn_usage(
            slot,
            SplitUsage {
                input_tokens: self.input_tokens,
                output_tokens: self.output_tokens,
                cache_read_tokens: Some(self.cache_read_tokens),
                cache_creation_tokens: Some(self.cache_creation_tokens),
            },
            subagent,
        );
    }

    fn drain_blocks(&mut self, flush: bool) {
        while let Some((split_at, rest_at)) = split_sse_block(&self.buffer) {
            let block: Vec<u8> = self.buffer.drain(..split_at).collect();
            self.buffer.drain(..rest_at - split_at);
            self.observe_block(&block);
        }
        if !flush {
            return;
        }
        if self.buffer.iter().all(|byte| byte.is_ascii_whitespace()) {
            self.buffer.clear();
            return;
        }
        let block = std::mem::take(&mut self.buffer);
        self.observe_block(&block);
    }

    fn observe_block(&mut self, block: &[u8]) {
        let text = String::from_utf8_lossy(block);
        let mut data = String::new();
        for line in text.lines() {
            let line = line.trim_end_matches('\r');
            if let Some(rest) = line.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(rest.trim_start());
            }
        }
        if data.is_empty() || data == "[DONE]" {
            return;
        }
        let Ok(value) = serde_json::from_str::<Value>(&data) else {
            return;
        };
        self.observe_event(&value);
    }

    fn observe_event(&mut self, value: &Value) {
        match value.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                if let Some(usage) = value.pointer("/message/usage") {
                    self.observe_usage(usage);
                }
            }
            Some("message_delta") | Some("message") => {
                if let Some(usage) = value.get("usage") {
                    self.observe_usage(usage);
                }
            }
            _ => {}
        }
    }

    fn observe_usage(&mut self, usage: &Value) {
        if !usage.is_object() {
            return;
        }
        self.saw_usage = true;
        self.last_raw = Some(usage.clone());
        if let Some(value) = field_number(usage, &["input_tokens", "inputTokens"]) {
            self.input_tokens = value;
        }
        if let Some(value) = field_number(usage, &["output_tokens", "outputTokens"]) {
            self.output_tokens = value;
        }
        if let Some(value) = field_number(
            usage,
            &[
                "cache_read_input_tokens",
                "cacheReadInputTokens",
                "prompt_cache_hit_tokens",
            ],
        ) {
            self.cache_read_tokens = value;
        }
        if let Some(value) = field_number(
            usage,
            &[
                "cache_creation_input_tokens",
                "cacheCreationInputTokens",
                "cache_write_input_tokens",
            ],
        ) {
            self.cache_creation_tokens = value;
        }
    }
}

fn split_sse_block(buffer: &[u8]) -> Option<(usize, usize)> {
    let newline = find_bytes(buffer, b"\n\n");
    let crlf = find_bytes(buffer, b"\r\n\r\n");
    match (newline, crlf) {
        (Some(newline), Some(crlf)) if newline <= crlf => Some((newline, newline + 2)),
        (Some(_), Some(crlf)) => Some((crlf, crlf + 4)),
        (Some(newline), None) => Some((newline, newline + 2)),
        (None, Some(crlf)) => Some((crlf, crlf + 4)),
        (None, None) => None,
    }
}

fn find_bytes(buffer: &[u8], needle: &[u8]) -> Option<usize> {
    buffer
        .windows(needle.len())
        .position(|window| window == needle)
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

    fn sse(event: &str, data: Value) -> String {
        format!("event: {event}\ndata: {data}\n\n")
    }

    #[test]
    fn merges_message_start_and_message_delta_without_summing() {
        let mut usage = AnthropicStreamUsage::default();
        let start = sse(
            "message_start",
            json!({
                "type": "message_start",
                "message": {
                    "usage": {
                        "input_tokens": 1406,
                        "output_tokens": 0,
                        "cache_read_input_tokens": 22912,
                        "cache_creation_input_tokens": 0
                    }
                }
            }),
        );
        let split_at = start.len() / 2;
        usage.push_bytes(start[..split_at].as_bytes());
        usage.push_bytes(start[split_at..].as_bytes());
        usage.push_bytes(
            sse(
                "content_block_delta",
                json!({
                    "type": "content_block_delta",
                    "delta": { "type": "thinking_delta", "thinking": "reading main.tex" }
                }),
            )
            .as_bytes(),
        );
        usage.push_bytes(
            sse(
                "message_delta",
                json!({
                    "type": "message_delta",
                    "delta": { "stop_reason": "tool_use" },
                    "usage": { "output_tokens": 80 }
                }),
            )
            .as_bytes(),
        );
        usage.finish();

        assert_eq!(usage.input_tokens, 1_406);
        assert_eq!(usage.cache_read_tokens, 22_912);
        assert_eq!(usage.cache_creation_tokens, 0);
        assert_eq!(usage.output_tokens, 80);
        assert_eq!(
            usage
                .last_raw
                .as_ref()
                .and_then(|value| value.get("output_tokens")),
            Some(&json!(80))
        );
        assert!(usage
            .last_raw
            .as_ref()
            .and_then(|value| value.get("cache_read_input_tokens"))
            .is_none());
    }

    #[test]
    fn full_message_delta_replaces_message_start_instead_of_adding() {
        let mut usage = AnthropicStreamUsage::default();
        usage.push_bytes(
            sse(
                "message_start",
                json!({
                    "type": "message_start",
                    "message": {
                        "usage": {
                            "input_tokens": 1406,
                            "output_tokens": 1,
                            "cache_read_input_tokens": 22912,
                            "cache_creation_input_tokens": 0
                        }
                    }
                }),
            )
            .as_bytes(),
        );
        usage.push_bytes(
            sse(
                "message_delta",
                json!({
                    "type": "message_delta",
                    "usage": {
                        "input_tokens": 1406,
                        "output_tokens": 80,
                        "cache_read_input_tokens": 22912,
                        "cache_creation_input_tokens": 0
                    }
                }),
            )
            .as_bytes(),
        );
        usage.finish();
        assert_eq!(usage.input_tokens, 1_406);
        assert_eq!(usage.output_tokens, 80);
        assert_eq!(usage.cache_read_tokens, 22_912);
    }

    #[test]
    fn passthrough_commits_log_the_last_request_and_skip_subagents() {
        struct EnvRestore(Option<String>);
        impl Drop for EnvRestore {
            fn drop(&mut self) {
                match self.0.take() {
                    Some(value) => std::env::set_var("LOCALPRISM_HOME", value),
                    None => std::env::remove_var("LOCALPRISM_HOME"),
                }
            }
        }
        struct ForceRestore;
        impl Drop for ForceRestore {
            fn drop(&mut self) {
                crate::usage_debug::force_for_test(None);
            }
        }

        let _lock = crate::providers::paths::lock_provider_env();
        let home = tempfile::tempdir().unwrap();
        let _env = EnvRestore(std::env::var("LOCALPRISM_HOME").ok());
        std::env::set_var("LOCALPRISM_HOME", home.path());
        let _force = ForceRestore;
        crate::usage_debug::force_for_test(Some(true));
        crate::usage_debug::reset_seq_for_test();

        let slot = crate::codex_turn_usage::register_slot();
        let mut first = AnthropicStreamUsage::default();
        first.observe_message(&json!({
            "usage": {
                "input_tokens": 22933,
                "output_tokens": 47,
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0
            }
        }));
        first.commit("Qwen/Qwen3.5-35B-A3B", slot, false);

        let mut subagent = AnthropicStreamUsage::default();
        subagent.observe_message(&json!({
            "usage": {
                "input_tokens": 99,
                "output_tokens": 9,
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0
            }
        }));
        subagent.commit("Qwen/Qwen3.5-35B-A3B", slot, true);

        let mut second = AnthropicStreamUsage::default();
        second.push_bytes(
            sse(
                "message_start",
                json!({
                    "type": "message_start",
                    "message": {
                        "usage": {
                            "input_tokens": 1406,
                            "output_tokens": 0,
                            "cache_read_input_tokens": 22912,
                            "cache_creation_input_tokens": 0
                        }
                    }
                }),
            )
            .as_bytes(),
        );
        second.push_bytes(
            sse(
                "message_delta",
                json!({
                    "type": "message_delta",
                    "usage": { "output_tokens": 64 }
                }),
            )
            .as_bytes(),
        );
        second.commit("deepseek-chat", slot, false);
        second.commit("deepseek-chat", slot, false);

        let line = r#"{"type":"result","usage":{"input_tokens":54444,"output_tokens":111,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}"#;
        let rewritten = crate::codex_turn_usage::rewrite_result_line(line, slot).unwrap();
        let value: Value = serde_json::from_str(&rewritten).unwrap();
        assert_eq!(value["usage"]["input_tokens"], 1_406);
        assert_eq!(value["usage"]["cache_read_input_tokens"], 22_912);
        assert_eq!(value["usage"]["cache_creation_input_tokens"], 0);
        assert_eq!(value["usage"]["output_tokens"], 64);

        let text =
            std::fs::read_to_string(home.path().join("logs").join("usage-debug.jsonl")).unwrap();
        let lines: Vec<&str> = text.lines().filter(|line| !line.is_empty()).collect();
        assert_eq!(lines.len(), 6);
        let upstream: Value = serde_json::from_str(lines[4]).unwrap();
        let anthropic: Value = serde_json::from_str(lines[5]).unwrap();
        assert_eq!(upstream["stage"], "upstream");
        assert_eq!(anthropic["stage"], "anthropic");
        assert_eq!(upstream["seq"], anthropic["seq"]);
        assert_eq!(upstream["model"], "deepseek-chat");
        assert_eq!(upstream["usage"]["output_tokens"], 64);
        assert!(upstream["usage"].get("input_tokens").is_none());
        assert_eq!(anthropic["usage"]["input_tokens"], 1_406);
        assert_eq!(anthropic["usage"]["cache_read_input_tokens"], 22_912);
        assert_eq!(anthropic["usage"]["output_tokens"], 64);
        crate::codex_turn_usage::drop_slot(slot);
    }
}
