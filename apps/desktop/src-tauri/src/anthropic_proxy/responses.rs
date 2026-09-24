use crate::providers::openai_oauth::{
    OPENAI_CODEX_API_ENDPOINT, OPENAI_CODEX_ORIGINATOR, OPENAI_CODEX_USER_AGENT,
};
use serde_json::{json, Value};

#[derive(Clone, Debug)]
pub struct CodexProxyCredential {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub account_id: Option<String>,
    pub model: String,
    pub effort: Option<String>,
}

pub fn anthropic_to_codex_responses(
    request: &Value,
    credential: &CodexProxyCredential,
) -> Result<Value, String> {
    let mut input = Vec::new();
    if let Some(system) = flatten_text(request.get("system")) {
        if !system.trim().is_empty() {
            let system = super::identity::bind_hosted_model_identity(&system, &credential.model);
            input.push(json!({
                "role": "developer",
                "content": [{"type": "input_text", "text": system}],
            }));
        }
    }
    for message in request
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "Anthropic request is missing messages[]".to_string())?
    {
        append_input_for_message(&mut input, message);
    }

    let mut body = json!({
        "model": credential.model,
        "input": input,
        "stream": true,
        "store": false,
        "include": ["reasoning.encrypted_content"],
    });
    if let Some(effort) = credential.effort.as_deref() {
        body["reasoning"] = json!({ "effort": coerce_codex_responses_effort(effort) });
    }
    if let Some(tools) = request.get("tools").and_then(Value::as_array) {
        let converted: Vec<Value> = tools
            .iter()
            .filter_map(anthropic_tool_to_function)
            .collect();
        if !converted.is_empty() {
            body["tools"] = Value::Array(converted);
        }
    }
    Ok(body)
}

fn flatten_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text.clone()),
        Value::Array(blocks) => Some(
            blocks
                .iter()
                .filter_map(|block| {
                    block
                        .get("text")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                })
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        _ => None,
    }
}

fn append_input_for_message(input: &mut Vec<Value>, message: &Value) {
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("user");
    match message.get("content") {
        Some(Value::String(text)) => {
            input.push(json!({
                "role": if role == "assistant" { "assistant" } else { "user" },
                "content": [{
                    "type": if role == "assistant" { "output_text" } else { "input_text" },
                    "text": text,
                }],
            }));
        }
        Some(Value::Array(blocks)) => {
            let mut texts = Vec::new();
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("tool_use") => {
                        input.push(json!({
                            "type": "function_call",
                            "call_id": block.get("id").and_then(Value::as_str).unwrap_or(""),
                            "name": block.get("name").and_then(Value::as_str).unwrap_or(""),
                            "arguments": super::tools::sanitize_tool_input(
                                block.get("input").cloned().unwrap_or(json!({}))
                            ).to_string(),
                        }));
                    }
                    Some("tool_result") => {
                        let text = flatten_text(block.get("content")).unwrap_or_default();
                        input.push(json!({
                            "type": "function_call_output",
                            "call_id": block.get("tool_use_id").and_then(Value::as_str).unwrap_or(""),
                            "output": text,
                        }));
                    }
                    _ => {
                        if let Some(text) = block.get("text").and_then(Value::as_str) {
                            texts.push(text.to_string());
                        }
                    }
                }
            }
            if !texts.is_empty() {
                input.push(json!({
                    "role": if role == "assistant" { "assistant" } else { "user" },
                    "content": [{
                        "type": if role == "assistant" { "output_text" } else { "input_text" },
                        "text": texts.join("\n"),
                    }],
                }));
            }
        }
        _ => {}
    }
}

fn anthropic_tool_to_function(tool: &Value) -> Option<Value> {
    let name = tool.get("name").and_then(Value::as_str)?;
    let description = super::tools::prepare_forwarded_tool_description(
        name,
        tool.get("description")
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    let parameters = super::tools::prepare_forwarded_tool_schema(
        name,
        tool.get("input_schema")
            .cloned()
            .unwrap_or_else(|| json!({"type":"object","properties":{}})),
    );
    Some(json!({
        "type": "function",
        "name": name,
        "description": description,
        "parameters": parameters,
    }))
}

/// Stable token the desktop UI localizes. Never name a specific model here.
pub const EMPTY_REPLY_TOKEN: &str = "localprism:empty-reply";
pub const NO_OUTPUT_TIMEOUT_PREFIX: &str = "localprism:no-output-timeout:";

pub struct ResponsesToAnthropic {
    model: String,
    message_started: bool,
    finished: bool,
    text_open: bool,
    thinking_open: bool,
    saw_text: bool,
    saw_tool: bool,
    saw_thinking: bool,
    next_index: usize,
    text_index: Option<usize>,
    thinking_index: Option<usize>,
    tool_index: Option<usize>,
    tool_arguments: String,
    tool_arguments_emitted: bool,
    tool_saw_delta: bool,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
}

impl Default for ResponsesToAnthropic {
    fn default() -> Self {
        Self {
            model: "gpt-5.6-sol".into(),
            message_started: false,
            finished: false,
            text_open: false,
            thinking_open: false,
            saw_text: false,
            saw_tool: false,
            saw_thinking: false,
            next_index: 0,
            text_index: None,
            thinking_index: None,
            tool_index: None,
            tool_arguments: String::new(),
            tool_arguments_emitted: false,
            tool_saw_delta: false,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
        }
    }
}

impl ResponsesToAnthropic {
    pub fn for_model(model: impl Into<String>) -> Self {
        Self {
            model: model.into(),
            ..Self::default()
        }
    }

    pub fn start_message(&mut self) -> String {
        if self.message_started {
            return String::new();
        }
        self.message_started = true;
        sse_event(
            "message_start",
            &json!({
                "type": "message_start",
                "message": {
                    "id": "msg_localprism",
                    "type": "message",
                    "role": "assistant",
                    "content": [],
                    "model": self.model,
                    "stop_reason": null,
                    "usage": { "input_tokens": 0, "output_tokens": 0 }
                }
            }),
        )
    }

    pub fn handle_event(&mut self, event_name: &str, data: &Value) -> String {
        let event_name = resolve_codex_event_name(event_name, data);
        match event_name.as_str() {
            "response.output_text.delta" | "response.text.delta" => {
                let text = data
                    .get("delta")
                    .and_then(Value::as_str)
                    .or_else(|| data.get("text").and_then(Value::as_str))
                    .unwrap_or("");
                self.emit_text_delta(text)
            }
            "response.output_text.done" | "response.text.done" => {
                if self.saw_text {
                    return String::new();
                }
                let text = data.get("text").and_then(Value::as_str).unwrap_or("");
                self.emit_text_delta(text)
            }
            "response.reasoning_summary_text.delta" | "response.reasoning_summary.delta" => {
                let text = data.get("delta").and_then(Value::as_str).unwrap_or("");
                self.emit_thinking_delta(text)
            }
            "response.output_item.added" => {
                let item = data.get("item").cloned().unwrap_or(Value::Null);
                if item.get("type").and_then(Value::as_str) != Some("function_call") {
                    return String::new();
                }
                let mut out = self.start_message();
                out.push_str(&self.close_thinking());
                out.push_str(&self.close_text());
                self.saw_tool = true;
                if self.tool_index.is_some() {
                    out.push_str(&self.close_tool());
                }
                let index = self.next_index;
                self.next_index += 1;
                self.tool_index = Some(index);
                self.tool_arguments_emitted = false;
                if !self.tool_saw_delta {
                    self.tool_arguments.clear();
                    if let Some(arguments) = item.get("arguments").and_then(Value::as_str) {
                        if !arguments.is_empty() {
                            self.tool_arguments = arguments.to_string();
                        }
                    }
                }
                out.push_str(&sse_event(
                    "content_block_start",
                    &json!({
                        "type": "content_block_start",
                        "index": index,
                        "content_block": {
                            "type": "tool_use",
                            "id": item.get("call_id").and_then(Value::as_str).unwrap_or("call"),
                            "name": item.get("name").and_then(Value::as_str).unwrap_or("tool"),
                            "input": {}
                        }
                    }),
                ));
                out
            }
            "response.function_call_arguments.delta" => {
                let delta = data.get("delta").and_then(Value::as_str).unwrap_or("");
                if !delta.is_empty() {
                    if !self.tool_saw_delta {
                        // Deltas are the full argument JSON, not a patch on item.arguments.
                        self.tool_arguments.clear();
                        self.tool_saw_delta = true;
                    }
                    self.tool_arguments.push_str(delta);
                }
                String::new()
            }
            "response.function_call_arguments.done" => {
                if let Some(arguments) = data.get("arguments").and_then(Value::as_str) {
                    if !arguments.is_empty() {
                        self.tool_arguments = arguments.to_string();
                        self.tool_saw_delta = true;
                    }
                }
                self.emit_tool_arguments()
            }
            "response.output_item.done" => {
                let item = data.get("item").cloned().unwrap_or(Value::Null);
                match item.get("type").and_then(Value::as_str) {
                    Some("function_call") => {}
                    Some("reasoning") => {
                        if self.saw_thinking {
                            return String::new();
                        }
                        return self.emit_thinking_delta(&visible_reasoning_text(&item));
                    }
                    Some("message") => {
                        if self.saw_text {
                            return String::new();
                        }
                        return self.emit_text_delta(&visible_message_text(&item));
                    }
                    _ => return String::new(),
                }
                if !self.tool_arguments_emitted {
                    if let Some(arguments) = item.get("arguments").and_then(Value::as_str) {
                        if !arguments.is_empty() {
                            self.tool_arguments = arguments.to_string();
                        }
                    }
                }
                self.close_tool()
            }
            "response.completed" | "response.incomplete" => {
                self.apply_usage(data);
                let mut out = self.start_message();
                out.push_str(&self.finish("end_turn"));
                out
            }
            "response.failed" | "error" => {
                let message = data
                    .pointer("/error/message")
                    .or_else(|| data.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("Codex Responses request failed");
                self.fail(message)
            }
            _ => String::new(),
        }
    }

    pub fn fail(&mut self, message: &str) -> String {
        let mut out = self.start_message();
        out.push_str(&self.ensure_text_block());
        out.push_str(&sse_event(
            "content_block_delta",
            &json!({
                "type": "content_block_delta",
                "index": self.text_index.unwrap_or(0),
                "delta": { "type": "text_delta", "text": message }
            }),
        ));
        out.push_str(&sse_event(
            "error",
            &json!({
                "type": "error",
                "error": { "type": "api_error", "message": message }
            }),
        ));
        out.push_str(&self.finish("error"));
        out
    }

    pub fn close_stream(&mut self) -> String {
        if self.finished {
            return String::new();
        }
        let mut out = self.start_message();
        out.push_str(&self.finish("end_turn"));
        out
    }

    fn emit_text_delta(&mut self, text: &str) -> String {
        if text.is_empty() {
            return String::new();
        }
        self.saw_text = true;
        let mut out = self.start_message();
        out.push_str(&self.close_thinking());
        out.push_str(&self.ensure_text_block());
        out.push_str(&sse_event(
            "content_block_delta",
            &json!({
                "type": "content_block_delta",
                "index": self.text_index.unwrap_or(0),
                "delta": { "type": "text_delta", "text": text }
            }),
        ));
        out
    }

    fn emit_thinking_delta(&mut self, text: &str) -> String {
        if text.is_empty() {
            return String::new();
        }
        self.saw_thinking = true;
        let mut out = self.start_message();
        out.push_str(&self.ensure_thinking_block());
        out.push_str(&sse_event(
            "content_block_delta",
            &json!({
                "type": "content_block_delta",
                "index": self.thinking_index.unwrap_or(0),
                "delta": { "type": "thinking_delta", "thinking": text }
            }),
        ));
        out
    }

    fn push_empty_reply(&mut self) -> String {
        let mut out = self.ensure_text_block();
        out.push_str(&sse_event(
            "content_block_delta",
            &json!({
                "type": "content_block_delta",
                "index": self.text_index.unwrap_or(0),
                "delta": { "type": "text_delta", "text": EMPTY_REPLY_TOKEN }
            }),
        ));
        out
    }

    fn ensure_text_block(&mut self) -> String {
        if self.text_open {
            return String::new();
        }
        let index = self.next_index;
        self.next_index += 1;
        self.text_index = Some(index);
        self.text_open = true;
        sse_event(
            "content_block_start",
            &json!({
                "type": "content_block_start",
                "index": index,
                "content_block": { "type": "text", "text": "" }
            }),
        )
    }

    fn ensure_thinking_block(&mut self) -> String {
        if self.thinking_open {
            return String::new();
        }
        let index = self.next_index;
        self.next_index += 1;
        self.thinking_index = Some(index);
        self.thinking_open = true;
        sse_event(
            "content_block_start",
            &json!({
                "type": "content_block_start",
                "index": index,
                "content_block": { "type": "thinking", "thinking": "" }
            }),
        )
    }

    fn emit_tool_arguments(&mut self) -> String {
        if self.tool_arguments_emitted || self.tool_index.is_none() {
            return String::new();
        }
        self.tool_arguments_emitted = true;
        if self.tool_arguments.trim().is_empty() {
            return String::new();
        }
        let index = self.tool_index.unwrap_or(0);
        let repaired = super::tools::repair_tool_arguments(&self.tool_arguments);
        sse_event(
            "content_block_delta",
            &json!({
                "type": "content_block_delta",
                "index": index,
                "delta": {
                    "type": "input_json_delta",
                    "partial_json": repaired,
                }
            }),
        )
    }

    fn close_tool(&mut self) -> String {
        let mut out = self.emit_tool_arguments();
        if let Some(index) = self.tool_index.take() {
            out.push_str(&sse_event(
                "content_block_stop",
                &json!({
                    "type": "content_block_stop",
                    "index": index,
                }),
            ));
        }
        self.tool_arguments.clear();
        self.tool_arguments_emitted = false;
        self.tool_saw_delta = false;
        out
    }

    fn close_text(&mut self) -> String {
        if !self.text_open {
            return String::new();
        }
        self.text_open = false;
        sse_event(
            "content_block_stop",
            &json!({
                "type": "content_block_stop",
                "index": self.text_index.unwrap_or(0)
            }),
        )
    }

    fn close_thinking(&mut self) -> String {
        if !self.thinking_open {
            return String::new();
        }
        self.thinking_open = false;
        let index = self.thinking_index.unwrap_or(0);
        // Claude Code drops unsigned thinking blocks. Match the Chat Completions
        // proxy and emit a synthetic signature before content_block_stop.
        let mut out = sse_event(
            "content_block_delta",
            &json!({
                "type": "content_block_delta",
                "index": index,
                "delta": {
                    "type": "signature_delta",
                    "signature": format!("ccr_{}", uuid::Uuid::new_v4().simple()),
                }
            }),
        );
        out.push_str(&sse_event(
            "content_block_stop",
            &json!({
                "type": "content_block_stop",
                "index": index
            }),
        ));
        out
    }

    fn finish(&mut self, stop_reason: &str) -> String {
        if self.finished {
            return String::new();
        }
        self.finished = true;
        let mut out = String::new();
        let nothing_visible = !self.saw_text && !self.saw_tool && !self.saw_thinking;
        if nothing_visible && stop_reason == "end_turn" {
            out.push_str(&self.push_empty_reply());
        }
        out.push_str(&self.close_thinking());
        out.push_str(&self.close_text());
        out.push_str(&self.close_tool());
        out.push_str(&sse_event(
            "message_delta",
            &json!({
                "type": "message_delta",
                "delta": { "stop_reason": stop_reason },
                "usage": {
                    "input_tokens": self.input_tokens,
                    "output_tokens": self.output_tokens,
                    "cache_read_input_tokens": self.cache_read_tokens,
                }
            }),
        ));
        out.push_str(&sse_event(
            "message_stop",
            &json!({ "type": "message_stop" }),
        ));
        out
    }

    fn apply_usage(&mut self, data: &Value) {
        let usage = data
            .pointer("/response/usage")
            .or_else(|| data.get("usage"))
            .cloned()
            .unwrap_or(Value::Null);
        if usage.is_null() {
            return;
        }
        let cache = super::usage::openai_cache_read_tokens(&usage);
        let input = super::usage::exclusive_openai_input_tokens(
            super::usage::usage_token(&usage, &["input_tokens", "prompt_tokens", "inputTokens"]),
            cache,
        );
        let output = super::usage::usage_token(
            &usage,
            &["output_tokens", "completion_tokens", "outputTokens"],
        );
        if input > 0 {
            self.input_tokens = input;
        }
        if output > 0 {
            self.output_tokens = output;
        }
        if cache > 0 {
            self.cache_read_tokens = cache;
        }
    }
}

fn visible_reasoning_text(item: &Value) -> String {
    let summary = item.get("summary").and_then(Value::as_array);
    if let Some(parts) = summary {
        let text = parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        if !text.trim().is_empty() {
            return text;
        }
    }
    item.get("content")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_default()
}

fn visible_message_text(item: &Value) -> String {
    item.get("content")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join("")
        })
        .filter(|text| !text.is_empty())
        .or_else(|| {
            item.get("text")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_default()
}

fn coerce_codex_responses_effort(effort: &str) -> &str {
    match effort {
        "max" | "ultra" => "xhigh",
        other => other,
    }
}

pub fn resolve_codex_event_name(event: &str, data: &Value) -> String {
    if event != "message" && !event.is_empty() {
        return event.to_string();
    }
    data.get("type")
        .and_then(Value::as_str)
        .unwrap_or(event)
        .to_string()
}

pub fn sse_event(event: &str, data: &Value) -> String {
    format!("event: {event}\ndata: {data}\n\n")
}

pub fn parse_sse_block(block: &str) -> Option<(String, Value)> {
    let mut event = "message".to_string();
    let mut data = String::new();
    for line in block.lines() {
        if let Some(value) = line.strip_prefix("event:") {
            event = value.trim().to_string();
        } else if let Some(value) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(value.trim());
        }
    }
    if data.is_empty() {
        return None;
    }
    let value = serde_json::from_str(&data).ok()?;
    Some((event, value))
}

pub fn responses_headers(credential: &CodexProxyCredential) -> Vec<(String, String)> {
    let mut headers = vec![
        (
            "Authorization".into(),
            format!("Bearer {}", credential.access_token),
        ),
        ("Content-Type".into(), "application/json".into()),
        ("User-Agent".into(), OPENAI_CODEX_USER_AGENT.into()),
        ("originator".into(), OPENAI_CODEX_ORIGINATOR.into()),
        ("OpenAI-Beta".into(), "responses=experimental".into()),
    ];
    if let Some(account_id) = credential.account_id.as_deref() {
        headers.push(("ChatGPT-Account-Id".into(), account_id.to_string()));
    }
    let _ = OPENAI_CODEX_API_ENDPOINT;
    headers
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_system_and_user_to_responses_input() {
        let request = json!({
            "system": "You are a writer",
            "messages": [{"role": "user", "content": "Read main.tex"}],
            "tools": [{
                "name": "Read",
                "description": "Read a file",
                "input_schema": { "type": "object", "properties": { "path": { "type": "string" } } }
            }]
        });
        let body = anthropic_to_codex_responses(
            &request,
            &CodexProxyCredential {
                access_token: "t".into(),
                refresh_token: None,
                account_id: Some("acc".into()),
                model: "gpt-5.6-sol".into(),
                effort: Some("high".into()),
            },
        )
        .expect("convert");
        assert_eq!(body["model"], "gpt-5.6-sol");
        assert_eq!(body["reasoning"]["effort"], "high");
        assert!(body["tools"]
            .as_array()
            .is_some_and(|tools| tools.len() == 1));
        assert!(body["input"]
            .as_array()
            .is_some_and(|items| items.len() == 2));
        let developer = body["input"][0]["content"][0]["text"].as_str().unwrap();
        assert!(developer.contains("IDENTITY OVERRIDE"));
        assert!(developer.contains("gpt-5.6-sol"));
        assert!(developer.contains("You are a writer"));
    }

    #[test]
    fn rewrites_claude_system_identity_for_chatgpt() {
        let body = anthropic_to_codex_responses(
            &json!({
                "system": "You are Claude, an AI assistant created by Anthropic.",
                "messages": [{"role": "user", "content": "Who are you?"}],
            }),
            &CodexProxyCredential {
                access_token: "t".into(),
                refresh_token: None,
                account_id: None,
                model: "gpt-5.6-terra".into(),
                effort: None,
            },
        )
        .expect("convert");
        let developer = body["input"][0]["content"][0]["text"].as_str().unwrap();
        assert!(developer.contains("gpt-5.6-terra"));
        assert!(!developer.contains("created by Anthropic"));
        assert!(!developer.contains("You are Claude, an AI"));
    }

    #[test]
    fn uses_resolved_catalog_model_as_is() {
        let request = json!({
            "messages": [{"role": "user", "content": "Hi"}],
        });
        let body = anthropic_to_codex_responses(
            &request,
            &CodexProxyCredential {
                access_token: "t".into(),
                refresh_token: None,
                account_id: None,
                model: "gpt-5.4".into(),
                effort: None,
            },
        )
        .expect("convert");
        assert_eq!(body["model"], "gpt-5.4");
    }

    #[test]
    fn remaps_catalog_max_effort_to_responses_xhigh() {
        let body = anthropic_to_codex_responses(
            &json!({ "messages": [{"role": "user", "content": "Hi"}] }),
            &CodexProxyCredential {
                access_token: "t".into(),
                refresh_token: None,
                account_id: None,
                model: "gpt-5.6-sol".into(),
                effort: Some("max".into()),
            },
        )
        .expect("convert");
        assert_eq!(body["reasoning"]["effort"], "xhigh");
    }

    #[test]
    fn translates_text_and_tool_sse() {
        let mut translator = ResponsesToAnthropic::default();
        let first =
            translator.handle_event("response.output_text.delta", &json!({ "delta": "Hello" }));
        assert!(first.contains("message_start"));
        assert!(first.contains("text_delta"));
        let tool = translator.handle_event(
            "response.output_item.added",
            &json!({ "item": { "type": "function_call", "call_id": "c1", "name": "Read" } }),
        );
        assert!(tool.contains("tool_use"));
        let done = translator.handle_event("response.completed", &json!({}));
        assert!(done.contains("message_stop"));
    }

    #[test]
    fn forwards_completed_usage_into_message_delta() {
        let mut translator = ResponsesToAnthropic::default();
        translator.handle_event("response.output_text.delta", &json!({ "delta": "Hello" }));
        let done = translator.handle_event(
            "response.completed",
            &json!({
                "response": {
                    "usage": {
                        "input_tokens": 3588,
                        "output_tokens": 80,
                        "input_tokens_details": { "cached_tokens": 200 }
                    }
                }
            }),
        );
        assert!(done.contains("\"input_tokens\":3388"));
        assert!(done.contains("\"output_tokens\":80"));
        assert!(done.contains("\"cache_read_input_tokens\":200"));
    }

    #[test]
    fn uses_json_type_when_sse_event_name_is_missing() {
        let mut translator = ResponsesToAnthropic::default();
        let out = translator.handle_event(
            "message",
            &json!({ "type": "response.output_text.delta", "delta": "Hi" }),
        );
        assert!(out.contains("text_delta"));
        assert!(out.contains("Hi"));
    }

    #[test]
    fn close_stream_completes_empty_response() {
        let mut translator = ResponsesToAnthropic::default();
        let out = translator.close_stream();
        assert!(out.contains("message_start"));
        assert!(out.contains("message_stop"));
        assert_eq!(out.matches(EMPTY_REPLY_TOKEN).count(), 1);
        assert!(!out.contains("GPT-5.5"));
        assert!(!out.contains("GPT-5.6 Sol"));
        assert!(translator.close_stream().is_empty());
    }

    #[test]
    fn tool_only_completion_is_not_an_empty_reply() {
        let mut translator = ResponsesToAnthropic::default();
        translator.handle_event(
            "response.output_item.added",
            &json!({
                "item": { "type": "function_call", "call_id": "c1", "name": "Read" }
            }),
        );
        translator.handle_event(
            "response.output_item.done",
            &json!({
                "item": {
                    "type": "function_call",
                    "arguments": "{\"file_path\":\"main.tex\"}"
                }
            }),
        );
        let done = translator.handle_event("response.completed", &json!({}));
        assert!(done.contains("tool_use") || done.contains("message_stop"));
        assert!(!done.contains(EMPTY_REPLY_TOKEN));
        assert!(!done.contains("GPT-5"));
    }

    #[test]
    fn reasoning_summary_is_visible_and_not_replaced() {
        let mut translator = ResponsesToAnthropic::default();
        let delta = translator.handle_event(
            "response.reasoning_summary_text.delta",
            &json!({ "delta": "Checking the section." }),
        );
        assert!(delta.contains("thinking_delta"));
        assert!(delta.contains("Checking the section."));
        let done = translator.handle_event("response.completed", &json!({}));
        assert!(!done.contains(EMPTY_REPLY_TOKEN));
        assert!(done.contains("signature_delta"));
        assert!(done.contains("content_block_stop"));
    }

    #[test]
    fn close_stream_after_text_does_not_claim_empty_or_timeout() {
        let mut translator = ResponsesToAnthropic::default();
        translator.handle_event("response.output_text.delta", &json!({ "delta": "Partial" }));
        let out = translator.close_stream();
        assert!(out.contains("message_stop"));
        assert!(!out.contains(EMPTY_REPLY_TOKEN));
        assert!(!out.contains(NO_OUTPUT_TIMEOUT_PREFIX));
        assert!(!out.contains("GPT-5.5"));
        assert!(!out.contains("no output"));
    }

    #[test]
    fn completed_message_text_is_kept_when_deltas_were_missing() {
        let mut translator = ResponsesToAnthropic::default();
        let out = translator.handle_event(
            "response.output_item.done",
            &json!({
                "item": {
                    "type": "message",
                    "content": [{ "type": "output_text", "text": "Here is the edit." }]
                }
            }),
        );
        assert!(out.contains("Here is the edit."));
        let done = translator.handle_event("response.completed", &json!({}));
        assert!(!done.contains(EMPTY_REPLY_TOKEN));
    }

    #[test]
    fn fail_emits_visible_text_and_error() {
        let mut translator = ResponsesToAnthropic::for_model("gpt-5.6-terra");
        let out =
            translator.fail("Codex Responses produced no output for gpt-5.6-terra within 45s.");
        assert!(out.contains("message_start"));
        assert!(out.contains("text_delta"));
        assert!(out.contains("gpt-5.6-terra"));
        assert!(out.contains("\"type\":\"error\""));
        assert!(out.contains("message_stop"));
    }

    #[test]
    fn streamed_read_arguments_drop_empty_pages_and_keep_ranges() {
        let mut translator = ResponsesToAnthropic::default();
        let start = translator.handle_event(
            "response.output_item.added",
            &json!({
                "item": {
                    "type": "function_call",
                    "call_id": "c1",
                    "name": "Read",
                    "arguments": ""
                }
            }),
        );
        assert!(start.contains("tool_use"));
        assert!(!start.contains("input_json_delta"));
        assert!(translator
            .handle_event(
                "response.function_call_arguments.delta",
                &json!({ "delta": "{\"file_path\":\"main.tex\",\"pa" }),
            )
            .is_empty());
        assert!(translator
            .handle_event(
                "response.function_call_arguments.delta",
                &json!({ "delta": "ges\":\"\",\"limit\":200}" }),
            )
            .is_empty());
        let done = translator.handle_event(
            "response.function_call_arguments.done",
            &json!({
                "arguments": "{\"file_path\":\"main.tex\",\"pages\":\"\",\"limit\":200}"
            }),
        );
        assert!(done.contains("input_json_delta"));
        assert!(done.contains("main.tex"));
        assert!(!done.contains("pages"));

        let mut from_deltas = ResponsesToAnthropic::default();
        from_deltas.handle_event(
            "response.output_item.added",
            &json!({ "item": { "type": "function_call", "call_id": "c2", "name": "Read" } }),
        );
        from_deltas.handle_event(
            "response.function_call_arguments.delta",
            &json!({ "delta": "{\"file_path\":\"notes.md\",\"pages\":\"\"}" }),
        );
        let completed = from_deltas.handle_event("response.completed", &json!({}));
        assert!(completed.contains("notes.md"));
        assert!(!completed.contains("pages"));
        assert!(completed.contains("message_stop"));

        let mut ranged = ResponsesToAnthropic::default();
        ranged.handle_event(
            "response.output_item.added",
            &json!({ "item": { "type": "function_call", "call_id": "c3", "name": "Read" } }),
        );
        let flushed = ranged.handle_event(
            "response.output_item.done",
            &json!({
                "item": {
                    "type": "function_call",
                    "arguments": "{\"file_path\":\"paper.pdf\",\"pages\":\"10-20\"}"
                }
            }),
        );
        assert!(flushed.contains("10-20"));
        assert!(flushed.contains("paper.pdf"));
        assert!(flushed.contains("content_block_stop"));
    }

    #[test]
    fn read_tool_schema_tells_codex_that_empty_pages_is_invalid() {
        let body = anthropic_to_codex_responses(
            &json!({
                "messages": [{ "role": "user", "content": "Read the file" }],
                "tools": [{
                    "name": "Read",
                    "description": "Read a file",
                    "input_schema": {
                        "type": "object",
                        "required": ["file_path", "pages"],
                        "properties": {
                            "file_path": { "type": "string" },
                            "pages": { "type": "string", "default": "" }
                        }
                    }
                }]
            }),
            &CodexProxyCredential {
                access_token: "t".into(),
                refresh_token: None,
                account_id: None,
                model: "gpt-5.6-sol".into(),
                effort: None,
            },
        )
        .expect("convert");
        let tool = &body["tools"][0];
        let description = tool["description"].as_str().unwrap();
        assert!(description.contains("empty string"));
        assert!(tool["parameters"]["properties"]["pages"]
            .get("default")
            .is_none());
        assert!(tool["parameters"]["required"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item.as_str() != Some("pages")));
        let pages_description = tool["parameters"]["properties"]["pages"]["description"]
            .as_str()
            .unwrap();
        assert!(pages_description.contains("1-5"));
        assert!(pages_description.contains("10-20"));
    }
}
