//! Reasoning intensity for DeepSeek and SiliconFlow.
//!
//! Claude Code forwards the composer choice as `output_config.effort`
//! (`low` / `medium` / `high` / `xhigh` / `max`). These two providers do not
//! share that ladder, and they do not read `reasoning.max_tokens`.
//!
//! DeepSeek (https://api-docs.deepseek.com/guides/thinking_mode):
//! - Chat: `thinking.type` `enabled|disabled` and `reasoning_effort` `low|high|max`
//! - Anthropic: `output_config.effort` `low|high|max` (`budget_tokens` is ignored)
//! - Responses: `reasoning.effort` `none|low|high|max`
//! Their compatibility table maps the string `xhigh` down to `high`. The
//! composer aliases catalog `max` to `xhigh` and labels that step Max, so the
//! top step is sent as DeepSeek `max` instead.
//!
//! SiliconFlow chat completions (https://docs.siliconflow.cn/docs/api/chat-completions-post):
//! - `reasoning_effort` `high|max` only for `Pro/deepseek-ai/DeepSeek-V4`,
//!   `deepseek-ai/DeepSeek-V4-Flash`, and `Pro/zai-org/GLM-5.2`.
//!   `low`/`medium` are defined as `high`, and `xhigh` as `max`.
//! - `enable_thinking` plus `thinking_budget` 128..=32768 (default 4096) for
//!   the other documented reasoning models.
//! SiliconFlow Anthropic Messages (https://docs.siliconflow.cn/docs/api/messages-post)
//! has no effort field. Length is `thinking.budget_tokens`. Discrete steps use
//! the published budget anchors: minimum 128, the Messages example 1024, the
//! default 4096, and the maximum 32768.

use serde_json::{json, Value};

const SILICONFLOW_BUDGET_MIN: u64 = 128;
const SILICONFLOW_BUDGET_EXAMPLE: u64 = 1024;
const SILICONFLOW_BUDGET_DEFAULT: u64 = 4096;
const SILICONFLOW_BUDGET_MAX: u64 = 32_768;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReasoningFamily {
    DeepSeek,
    /// `reasoning_effort` is `high` or `max`.
    SiliconFlowEffort,
    /// `enable_thinking` / `thinking_budget`, or Anthropic `thinking.budget_tokens`.
    SiliconFlowBudget,
    Other,
}

pub(crate) fn reasoning_family(base_url: &str, model: &str) -> ReasoningFamily {
    if is_deepseek_host(base_url) {
        return ReasoningFamily::DeepSeek;
    }
    if is_siliconflow_host(base_url) {
        if siliconflow_effort_model(model) {
            return ReasoningFamily::SiliconFlowEffort;
        }
        if siliconflow_budget_model(model) {
            return ReasoningFamily::SiliconFlowBudget;
        }
    }
    ReasoningFamily::Other
}

/// Levels to show when the live catalog omits them. `None` means this model
/// does not advertise an adjustable ladder.
pub(crate) fn known_reasoning_efforts(
    base_url: &str,
    model: &str,
) -> Option<&'static [&'static str]> {
    match reasoning_family(base_url, model) {
        ReasoningFamily::DeepSeek => Some(&["low", "high", "max"]),
        ReasoningFamily::SiliconFlowEffort => Some(&["high", "max"]),
        ReasoningFamily::SiliconFlowBudget => Some(&["low", "medium", "high", "max"]),
        ReasoningFamily::Other => None,
    }
}

pub(crate) fn replays_reasoning_content(base_url: &str) -> bool {
    is_deepseek_host(base_url) || is_siliconflow_host(base_url)
}

pub(crate) fn apply_openai_chat_reasoning(
    openai_request: &mut Value,
    anthropic_request: &Value,
    base_url: &str,
    model: &str,
) -> bool {
    match reasoning_family(base_url, model) {
        ReasoningFamily::DeepSeek => {
            apply_deepseek_chat(openai_request, anthropic_request);
            true
        }
        ReasoningFamily::SiliconFlowEffort => {
            apply_siliconflow_effort_chat(openai_request, anthropic_request);
            true
        }
        ReasoningFamily::SiliconFlowBudget => {
            apply_siliconflow_budget_chat(openai_request, anthropic_request);
            true
        }
        ReasoningFamily::Other => false,
    }
}

pub(crate) fn apply_responses_reasoning(
    body: &mut Value,
    anthropic_request: &Value,
    base_url: &str,
    model: &str,
) {
    if reasoning_family(base_url, model) != ReasoningFamily::DeepSeek {
        return;
    }
    let effort = request_effort(anthropic_request);
    if thinking_disabled(anthropic_request, effort.as_deref()) {
        body["reasoning"] = json!({ "effort": "none" });
        return;
    }
    if let Some(wire) = effort.as_deref().and_then(deepseek_wire_effort) {
        body["reasoning"] = json!({ "effort": wire });
    }
}

pub(crate) fn rewrite_anthropic_reasoning(body: &mut Value, base_url: &str, model: &str) {
    match reasoning_family(base_url, model) {
        ReasoningFamily::DeepSeek => rewrite_deepseek_anthropic(body),
        ReasoningFamily::SiliconFlowEffort | ReasoningFamily::SiliconFlowBudget => {
            rewrite_siliconflow_anthropic(body);
        }
        ReasoningFamily::Other => {}
    }
}

fn apply_deepseek_chat(openai_request: &mut Value, anthropic_request: &Value) {
    let effort = request_effort(anthropic_request);
    if thinking_disabled(anthropic_request, effort.as_deref()) {
        openai_request["thinking"] = json!({ "type": "disabled" });
        remove_key(openai_request, "reasoning_effort");
        return;
    }
    if let Some(wire) = effort.as_deref().and_then(deepseek_wire_effort) {
        openai_request["thinking"] = json!({ "type": "enabled" });
        openai_request["reasoning_effort"] = json!(wire);
    } else if thinking_explicitly_enabled(anthropic_request) {
        openai_request["thinking"] = json!({ "type": "enabled" });
    }
}

fn apply_siliconflow_effort_chat(openai_request: &mut Value, anthropic_request: &Value) {
    let effort = request_effort(anthropic_request);
    if thinking_disabled(anthropic_request, effort.as_deref()) {
        openai_request["enable_thinking"] = json!(false);
        remove_key(openai_request, "reasoning_effort");
        return;
    }
    if let Some(wire) = effort.as_deref().and_then(siliconflow_wire_effort) {
        openai_request["enable_thinking"] = json!(true);
        openai_request["reasoning_effort"] = json!(wire);
    } else if thinking_explicitly_enabled(anthropic_request) {
        openai_request["enable_thinking"] = json!(true);
    }
}

fn apply_siliconflow_budget_chat(openai_request: &mut Value, anthropic_request: &Value) {
    let effort = request_effort(anthropic_request);
    if thinking_disabled(anthropic_request, effort.as_deref()) {
        openai_request["enable_thinking"] = json!(false);
        remove_key(openai_request, "thinking_budget");
        return;
    }
    if let Some(budget) = effort
        .as_deref()
        .and_then(siliconflow_budget_for_effort)
        .or_else(|| request_budget(anthropic_request))
    {
        openai_request["enable_thinking"] = json!(true);
        openai_request["thinking_budget"] = json!(budget);
    } else if thinking_explicitly_enabled(anthropic_request) {
        openai_request["enable_thinking"] = json!(true);
    }
}

fn rewrite_deepseek_anthropic(body: &mut Value) {
    let effort = request_effort(body);
    if thinking_disabled(body, effort.as_deref()) {
        body["thinking"] = json!({ "type": "disabled" });
        remove_output_effort(body);
        return;
    }
    let Some(wire) = effort.as_deref().and_then(deepseek_wire_effort) else {
        return;
    };
    ensure_output_config(body);
    body["output_config"]["effort"] = json!(wire);
    body["thinking"] = json!({ "type": "enabled" });
}

fn rewrite_siliconflow_anthropic(body: &mut Value) {
    let effort = request_effort(body);
    if thinking_disabled(body, effort.as_deref()) {
        body["thinking"] = json!({ "type": "disabled" });
        remove_output_effort(body);
        return;
    }
    let budget = effort
        .as_deref()
        .and_then(siliconflow_budget_for_effort)
        .or_else(|| request_budget(body));
    if let Some(budget) = budget {
        body["thinking"] = json!({
            "type": "enabled",
            "budget_tokens": budget,
        });
        remove_output_effort(body);
    }
}

fn deepseek_wire_effort(effort: &str) -> Option<&'static str> {
    match effort {
        "minimal" | "low" => Some("low"),
        "medium" | "high" => Some("high"),
        "xhigh" | "max" | "ultra" => Some("max"),
        _ => None,
    }
}

fn siliconflow_wire_effort(effort: &str) -> Option<&'static str> {
    match effort {
        "minimal" | "low" | "medium" | "high" => Some("high"),
        "xhigh" | "max" | "ultra" => Some("max"),
        _ => None,
    }
}

fn siliconflow_budget_for_effort(effort: &str) -> Option<u64> {
    match effort {
        "minimal" | "low" => Some(SILICONFLOW_BUDGET_MIN),
        "medium" => Some(SILICONFLOW_BUDGET_EXAMPLE),
        "high" => Some(SILICONFLOW_BUDGET_DEFAULT),
        "xhigh" | "max" | "ultra" => Some(SILICONFLOW_BUDGET_MAX),
        _ => None,
    }
}

fn request_effort(request: &Value) -> Option<String> {
    request
        .pointer("/output_config/effort")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
}

fn request_budget(request: &Value) -> Option<u64> {
    let budget = request
        .pointer("/thinking/budget_tokens")
        .and_then(Value::as_u64)?;
    Some(budget.clamp(SILICONFLOW_BUDGET_MIN, SILICONFLOW_BUDGET_MAX))
}

fn thinking_type(request: &Value) -> Option<String> {
    request
        .pointer("/thinking/type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
}

fn thinking_disabled(request: &Value, effort: Option<&str>) -> bool {
    matches!(thinking_type(request).as_deref(), Some("disabled"))
        || matches!(effort, Some("none" | "off" | "disabled"))
}

fn thinking_explicitly_enabled(request: &Value) -> bool {
    matches!(
        thinking_type(request).as_deref(),
        Some("enabled" | "adaptive")
    )
}

fn ensure_output_config(body: &mut Value) {
    if !body.get("output_config").is_some_and(Value::is_object) {
        body["output_config"] = json!({});
    }
}

fn remove_output_effort(body: &mut Value) {
    let Some(config) = body.get_mut("output_config").and_then(Value::as_object_mut) else {
        return;
    };
    config.remove("effort");
    if config.is_empty() {
        if let Some(object) = body.as_object_mut() {
            object.remove("output_config");
        }
    }
}

fn remove_key(body: &mut Value, key: &str) {
    if let Some(object) = body.as_object_mut() {
        object.remove(key);
    }
}

pub(crate) fn is_deepseek_host(base_url: &str) -> bool {
    matches_host(base_url, "deepseek.com")
}

pub(crate) fn is_siliconflow_host(base_url: &str) -> bool {
    matches_host(base_url, "siliconflow.cn") || matches_host(base_url, "siliconflow.com")
}

fn matches_host(base_url: &str, suffix: &str) -> bool {
    let host = request_host(base_url);
    host == suffix || host.ends_with(&format!(".{suffix}"))
}

fn request_host(base_url: &str) -> String {
    let lower = base_url.trim().to_ascii_lowercase();
    let without_scheme = lower
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(&lower);
    without_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .split('@')
        .next_back()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("")
        .to_string()
}

fn normalized_model_tail(model: &str) -> String {
    let lower = model.trim().to_ascii_lowercase();
    let lower = lower.strip_prefix("pro/").unwrap_or(&lower);
    lower.rsplit('/').next().unwrap_or(lower).trim().to_string()
}

fn model_prefix(tail: &str, prefix: &str) -> bool {
    let Some(rest) = tail.strip_prefix(prefix) else {
        return false;
    };
    rest.is_empty() || !rest.starts_with(|ch: char| ch.is_ascii_alphanumeric())
}

fn siliconflow_effort_model(model: &str) -> bool {
    // https://docs.siliconflow.cn/docs/api/chat-completions-post
    // `Pro/` is a serving prefix; the model tail is what the field list names.
    matches!(
        normalized_model_tail(model).as_str(),
        "deepseek-v4" | "deepseek-v4-flash" | "glm-5.2"
    )
}

fn siliconflow_budget_model(model: &str) -> bool {
    if siliconflow_effort_model(model) {
        return false;
    }
    let tail = normalized_model_tail(model);
    tail.contains("deepseek-r1")
        || tail.contains("reasoner")
        || model_prefix(&tail, "qwen3")
        || tail.starts_with("deepseek-v3.1")
        || tail.starts_with("deepseek-v3.2")
        || tail.contains("hunyuan-a13b")
        || tail.starts_with("glm-4.5")
        || tail.starts_with("glm-4.6")
        || tail.starts_with("glm-5v")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anthropic(effort: &str) -> Value {
        json!({
            "output_config": { "effort": effort },
            "thinking": { "type": "enabled", "budget_tokens": 100000 }
        })
    }

    #[test]
    fn deepseek_chat_maps_every_composer_level_onto_low_high_max() {
        let cases = [
            ("minimal", "low"),
            ("low", "low"),
            ("medium", "high"),
            ("high", "high"),
            ("xhigh", "max"),
            ("max", "max"),
            ("ultra", "max"),
        ];
        for (input, expected) in cases {
            let mut body = json!({});
            apply_openai_chat_reasoning(
                &mut body,
                &anthropic(input),
                "https://api.deepseek.com",
                "deepseek-v4-pro",
            );
            assert_eq!(body["thinking"]["type"], "enabled", "{input}");
            assert_eq!(body["reasoning_effort"], expected, "{input}");
            assert!(body.get("reasoning").is_none(), "{input}");
        }
    }

    #[test]
    fn deepseek_chat_disables_thinking_for_none() {
        let mut body = json!({});
        apply_openai_chat_reasoning(
            &mut body,
            &anthropic("none"),
            "https://api.deepseek.com/v1",
            "deepseek-v4-flash",
        );
        assert_eq!(body["thinking"]["type"], "disabled");
        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn deepseek_responses_uses_reasoning_effort_and_none_disables() {
        let mut body = json!({});
        apply_responses_reasoning(
            &mut body,
            &anthropic("xhigh"),
            "https://api.deepseek.com",
            "deepseek-v4-pro",
        );
        assert_eq!(body["reasoning"]["effort"], "max");

        let mut disabled = json!({});
        apply_responses_reasoning(
            &mut disabled,
            &json!({ "thinking": { "type": "disabled" } }),
            "https://api.deepseek.com",
            "deepseek-chat",
        );
        assert_eq!(disabled["reasoning"]["effort"], "none");
    }

    #[test]
    fn deepseek_anthropic_rewrites_xhigh_to_max_and_drops_budget() {
        let mut body = anthropic("xhigh");
        rewrite_anthropic_reasoning(
            &mut body,
            "https://api.deepseek.com/anthropic",
            "deepseek-v4-pro",
        );
        assert_eq!(body["output_config"]["effort"], "max");
        assert_eq!(body["thinking"]["type"], "enabled");
        assert!(body["thinking"].get("budget_tokens").is_none());

        let mut medium = anthropic("medium");
        rewrite_anthropic_reasoning(
            &mut medium,
            "https://api.deepseek.com/anthropic",
            "deepseek-v4-flash",
        );
        assert_eq!(medium["output_config"]["effort"], "high");
    }

    #[test]
    fn siliconflow_v4_chat_keeps_only_high_and_max() {
        let cases = [
            ("low", "high"),
            ("medium", "high"),
            ("high", "high"),
            ("xhigh", "max"),
            ("max", "max"),
        ];
        for (input, expected) in cases {
            let mut body = json!({});
            apply_openai_chat_reasoning(
                &mut body,
                &anthropic(input),
                "https://api.siliconflow.cn/v1",
                "Pro/deepseek-ai/DeepSeek-V4-Flash",
            );
            assert_eq!(body["enable_thinking"], true, "{input}");
            assert_eq!(body["reasoning_effort"], expected, "{input}");
            assert!(body.get("thinking_budget").is_none(), "{input}");
            assert!(body.get("reasoning").is_none(), "{input}");
        }
    }

    #[test]
    fn siliconflow_glm_and_qwen_use_documented_budget_anchors() {
        let cases = [
            ("low", SILICONFLOW_BUDGET_MIN),
            ("medium", SILICONFLOW_BUDGET_EXAMPLE),
            ("high", SILICONFLOW_BUDGET_DEFAULT),
            ("xhigh", SILICONFLOW_BUDGET_MAX),
        ];
        for (input, expected) in cases {
            let mut chat = json!({});
            apply_openai_chat_reasoning(
                &mut chat,
                &anthropic(input),
                "https://api.siliconflow.cn/v1",
                "Qwen/Qwen3-32B",
            );
            assert_eq!(chat["enable_thinking"], true, "{input}");
            assert_eq!(chat["thinking_budget"], expected, "{input}");
            assert!(chat.get("reasoning_effort").is_none(), "{input}");
        }

        let mut messages = anthropic("max");
        rewrite_anthropic_reasoning(
            &mut messages,
            "https://api.siliconflow.cn",
            "zai-org/GLM-5.2",
        );
        assert_eq!(messages["thinking"]["type"], "enabled");
        assert_eq!(
            messages["thinking"]["budget_tokens"],
            SILICONFLOW_BUDGET_MAX
        );
        assert!(messages.get("output_config").is_none());
    }

    #[test]
    fn siliconflow_anthropic_clamps_an_explicit_budget_and_can_disable() {
        let mut huge = json!({ "thinking": { "type": "enabled", "budget_tokens": 90000 } });
        rewrite_anthropic_reasoning(
            &mut huge,
            "https://api.siliconflow.com",
            "deepseek-ai/DeepSeek-R1",
        );
        assert_eq!(huge["thinking"]["budget_tokens"], SILICONFLOW_BUDGET_MAX);

        let mut off = anthropic("high");
        off["thinking"]["type"] = json!("disabled");
        rewrite_anthropic_reasoning(
            &mut off,
            "https://api.siliconflow.cn",
            "deepseek-ai/DeepSeek-V3.2",
        );
        assert_eq!(off["thinking"]["type"], "disabled");
        assert!(off["thinking"].get("budget_tokens").is_none());
        assert!(off.get("output_config").is_none());
    }

    #[test]
    fn unrelated_hosts_are_left_alone() {
        let mut body = json!({});
        assert!(!apply_openai_chat_reasoning(
            &mut body,
            &anthropic("high"),
            "https://api.example.com/v1",
            "deepseek-v4-pro",
        ));
        assert!(body.as_object().unwrap().is_empty());
        assert_eq!(
            known_reasoning_efforts("https://api.siliconflow.cn/v1", "deepseek-ai/DeepSeek-V3"),
            None
        );

        let mut anthropic_body = anthropic("xhigh");
        let before = anthropic_body.clone();
        rewrite_anthropic_reasoning(
            &mut anthropic_body,
            "https://api.anthropic.com",
            "claude-opus-4-6",
        );
        assert_eq!(anthropic_body, before);

        let mut responses = json!({ "model": "gpt-5" });
        apply_responses_reasoning(
            &mut responses,
            &anthropic("xhigh"),
            "https://api.openai.com/v1",
            "gpt-5",
        );
        assert!(responses.get("reasoning").is_none());
    }

    #[test]
    fn deepseek_responses_compose_maps_xhigh_to_max() {
        let request = json!({
            "max_tokens": 32,
            "output_config": { "effort": "xhigh" },
            "messages": [{ "role": "user", "content": "hi" }]
        });
        let mut body = crate::anthropic_proxy::responses::anthropic_to_provider_responses(
            &request,
            "deepseek-v4-pro",
        )
        .expect("convert");
        assert!(body.get("reasoning").is_none());
        apply_responses_reasoning(
            &mut body,
            &request,
            "https://api.deepseek.com",
            "deepseek-v4-pro",
        );
        assert_eq!(body["reasoning"]["effort"], "max");
    }

    #[test]
    fn qwen3_match_requires_a_model_prefix_boundary() {
        assert_eq!(
            known_reasoning_efforts("https://api.siliconflow.cn/v1", "Qwen/Qwen3-32B"),
            Some(&["low", "medium", "high", "max"][..])
        );
        assert_eq!(
            known_reasoning_efforts("https://api.siliconflow.cn/v1", "Qwen/Qwen30B"),
            None
        );
        assert_eq!(
            known_reasoning_efforts("https://api.siliconflow.cn/v1", "org/my-qwen3-8b"),
            None
        );
    }

    #[test]
    fn known_ladders_match_the_provider_enums() {
        assert_eq!(
            known_reasoning_efforts("https://api.deepseek.com/anthropic", "deepseek-chat"),
            Some(&["low", "high", "max"][..])
        );
        assert_eq!(
            known_reasoning_efforts(
                "https://api.siliconflow.cn/v1",
                "Pro/deepseek-ai/DeepSeek-V4"
            ),
            Some(&["high", "max"][..])
        );
        assert_eq!(
            known_reasoning_efforts(
                "https://api.siliconflow.cn/v1",
                "deepseek-ai/DeepSeek-V4-Pro"
            ),
            None
        );
        assert_eq!(
            known_reasoning_efforts("https://api.siliconflow.cn/v1", "Qwen/Qwen3-8B"),
            Some(&["low", "medium", "high", "max"][..])
        );
    }
}
