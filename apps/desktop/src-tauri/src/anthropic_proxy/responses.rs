use crate::providers::openai_oauth::{
    OPENAI_CODEX_API_ENDPOINT, OPENAI_CODEX_ORIGINATOR, OPENAI_CODEX_USER_AGENT,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug)]
pub struct CodexProxyCredential {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub account_id: Option<String>,
    pub model: String,
    pub effort: Option<String>,
    /// Per Claude spawn. `0` does not record request usage.
    pub usage_slot: u64,
}

pub fn anthropic_to_codex_responses(
    request: &Value,
    credential: &CodexProxyCredential,
) -> Result<Value, String> {
    anthropic_to_codex_responses_for_session(request, credential, None)
}

pub fn anthropic_to_codex_responses_for_session(
    request: &Value,
    credential: &CodexProxyCredential,
    header_session: Option<&str>,
) -> Result<Value, String> {
    let mut request = request.clone();
    super::messages::hoist_anthropic_system_messages(&mut request);

    let instructions = flatten_text(request.get("system")).and_then(|system| {
        if system.trim().is_empty() {
            return None;
        }
        let bound = super::identity::bind_hosted_model_identity(&system, &credential.model);
        let stable = stabilize_instructions(&bound);
        if stable.trim().is_empty() {
            None
        } else {
            Some(stable)
        }
    });

    let mut input = Vec::new();
    for message in request
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| "Anthropic request is missing messages[]".to_string())?
    {
        append_input_for_message(&mut input, message);
    }

    let mut tools = Vec::new();
    if let Some(raw_tools) = request.get("tools").and_then(Value::as_array) {
        tools = raw_tools
            .iter()
            .filter_map(anthropic_tool_to_function)
            .collect();
        for tool in &mut tools {
            stabilize_value_strings(tool, &["name"]);
        }
        tools.sort_by(|left, right| {
            let left_name = left.get("name").and_then(Value::as_str).unwrap_or("");
            let right_name = right.get("name").and_then(Value::as_str).unwrap_or("");
            left_name
                .cmp(right_name)
                .then_with(|| left.to_string().cmp(&right.to_string()))
        });
    }

    let cache_key = prompt_cache_key(
        &request,
        header_session,
        instructions.as_deref().unwrap_or(""),
        &tools,
        &input,
    );

    let mut body = json!({
        "model": credential.model,
        "input": input,
        "stream": true,
        "store": false,
        "include": ["reasoning.encrypted_content"],
        "prompt_cache_key": cache_key,
    });
    if let Some(instructions) = instructions {
        body["instructions"] = Value::String(instructions);
    }
    if let Some(effort) = credential.effort.as_deref() {
        body["reasoning"] = json!({ "effort": coerce_codex_responses_effort(effort) });
    }
    if !tools.is_empty() {
        body["tools"] = Value::Array(tools);
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

/// ChatGPT Codex sticks a conversation to one cache server with this key.
/// It must be the Claude Code session id, never a fresh random value.
fn prompt_cache_key(
    request: &Value,
    header_session: Option<&str>,
    instructions: &str,
    tools: &[Value],
    input: &[Value],
) -> String {
    if let Some(session) = header_session
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| session_id_from_request(request))
    {
        return sanitize_cache_key(&session);
    }
    fallback_prompt_cache_key(instructions, tools, input)
}

fn session_id_from_request(request: &Value) -> Option<String> {
    if let Some(session) = non_empty_string(request.get("session_id")) {
        return Some(session);
    }
    let metadata = request.get("metadata");
    if let Some(session) = metadata.and_then(|value| non_empty_string(value.get("session_id"))) {
        return Some(session);
    }
    if let Some(session) = metadata.and_then(|value| session_from_user_id(value.get("user_id"))) {
        return Some(session);
    }
    session_from_user_id(request.get("user_id"))
}

fn session_from_user_id(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => session_from_user_id_text(text),
        Value::Object(map) => non_empty_string(map.get("session_id")),
        _ => None,
    }
}

fn session_from_user_id_text(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.starts_with('{') {
        if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
            if let Some(session) = session_from_user_id(Some(&parsed)) {
                return Some(session);
            }
        }
    }
    let marker = "session_";
    let start = trimmed.find(marker)?;
    let rest = &trimmed[start + marker.len()..];
    let token: String = rest
        .chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '-')
        .collect();
    if token.is_empty() {
        None
    } else {
        Some(format!("session_{token}"))
    }
}

fn non_empty_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToOwned::to_owned)
}

fn sanitize_cache_key(raw: &str) -> String {
    let trimmed = raw.trim();
    let mut key = String::new();
    for ch in trimmed.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            key.push(ch);
        }
    }
    if key.is_empty() || key.len() > 64 {
        return sha256_hex(trimmed.as_bytes());
    }
    key
}

fn fallback_prompt_cache_key(instructions: &str, tools: &[Value], input: &[Value]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(instructions.as_bytes());
    hasher.update([0xff]);
    for tool in tools {
        if let Some(name) = tool.get("name").and_then(Value::as_str) {
            hasher.update(name.as_bytes());
            hasher.update([0xff]);
        }
    }
    hasher.update(first_user_text(input).as_bytes());
    sha256_hex(&hasher.finalize())
}

fn first_user_text(input: &[Value]) -> String {
    for item in input {
        if item.get("role").and_then(Value::as_str) != Some("user") {
            continue;
        }
        if let Some(text) = item.pointer("/content/0/text").and_then(Value::as_str) {
            return text.to_string();
        }
    }
    String::new()
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex_encode(&Sha256::digest(bytes))
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(*byte >> 4) as usize] as char);
        out.push(HEX[(*byte & 0x0f) as usize] as char);
    }
    out
}

fn stabilize_instructions(text: &str) -> String {
    text.split("\n\n")
        .map(stabilize_prompt_text)
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Drop per-request tokens from the cached prefix. Conversation input is left
/// alone so tool ids and user text stay append-only.
fn stabilize_prompt_text(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let previous_is_hex = index > 0 && bytes[index - 1].is_ascii_hexdigit();
        if !previous_is_hex {
            if let Some(len) = volatile_span_len(&input[index..]) {
                index += len;
                continue;
            }
        }
        let Some(ch) = input[index..].chars().next() else {
            break;
        };
        out.push(ch);
        index += ch.len_utf8();
    }
    out
}

fn volatile_span_len(text: &str) -> Option<usize> {
    uuid_len(text)
        .or_else(|| iso_datetime_len(text))
        .or_else(|| clock_time_len(text))
}

fn uuid_len(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let groups = [8usize, 4, 4, 4, 12];
    let mut index = 0;
    for (group_index, length) in groups.iter().copied().enumerate() {
        if group_index > 0 {
            if bytes.get(index) != Some(&b'-') {
                return None;
            }
            index += 1;
        }
        let end = index.checked_add(length)?;
        let slice = bytes.get(index..end)?;
        if !slice.iter().all(u8::is_ascii_hexdigit) {
            return None;
        }
        index = end;
    }
    if bytes.get(index).is_some_and(u8::is_ascii_hexdigit) {
        return None;
    }
    Some(index)
}

fn iso_datetime_len(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    if !is_ascii_digits(&bytes[0..4])
        || bytes[4] != b'-'
        || !is_ascii_digits(&bytes[5..7])
        || bytes[7] != b'-'
        || !is_ascii_digits(&bytes[8..10])
    {
        return None;
    }
    if !matches!(bytes[10], b'T' | b't' | b' ') {
        return None;
    }
    if clock_time_len_at(bytes, 11).is_none() {
        return None;
    }
    let mut index = 19;
    if bytes.get(index) == Some(&b'.') && bytes.get(index + 1).is_some_and(u8::is_ascii_digit) {
        let mut fraction = index + 2;
        while bytes.get(fraction).is_some_and(u8::is_ascii_digit) {
            fraction += 1;
        }
        index = fraction;
    }
    if matches!(bytes.get(index), Some(b'Z' | b'z')) {
        index += 1;
    } else if matches!(bytes.get(index), Some(b'+' | b'-')) {
        index = timezone_end(bytes, index);
    }
    Some(index)
}

fn timezone_end(bytes: &[u8], index: usize) -> usize {
    let hour_end = index + 3;
    if bytes.len() < hour_end || !is_ascii_digits(&bytes[index + 1..hour_end]) {
        return index;
    }
    if bytes.len() >= index + 6
        && bytes[hour_end] == b':'
        && is_ascii_digits(&bytes[index + 4..index + 6])
    {
        return index + 6;
    }
    if bytes.len() >= index + 5 && is_ascii_digits(&bytes[hour_end..index + 5]) {
        return index + 5;
    }
    hour_end
}

fn clock_time_len(text: &str) -> Option<usize> {
    clock_time_len_at(text.as_bytes(), 0)
}

fn clock_time_len_at(bytes: &[u8], start: usize) -> Option<usize> {
    if bytes.len() < start + 8 {
        return None;
    }
    if !is_ascii_digits(&bytes[start..start + 2])
        || bytes[start + 2] != b':'
        || !is_ascii_digits(&bytes[start + 3..start + 5])
        || bytes[start + 5] != b':'
        || !is_ascii_digits(&bytes[start + 6..start + 8])
    {
        return None;
    }
    let mut end = start + 8;
    if bytes.get(end) == Some(&b'.') && bytes.get(end + 1).is_some_and(u8::is_ascii_digit) {
        let mut fraction = end + 2;
        while bytes.get(fraction).is_some_and(u8::is_ascii_digit) {
            fraction += 1;
        }
        end = fraction;
    }
    Some(end - start)
}

fn is_ascii_digits(bytes: &[u8]) -> bool {
    !bytes.is_empty() && bytes.iter().all(u8::is_ascii_digit)
}

fn stabilize_value_strings(value: &mut Value, skip_keys: &[&str]) {
    match value {
        Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                if child.is_string() && skip_keys.iter().any(|skip| *skip == key) {
                    continue;
                }
                stabilize_value_strings(child, skip_keys);
            }
        }
        Value::Array(items) => {
            for item in items {
                stabilize_value_strings(item, skip_keys);
            }
        }
        Value::String(text) => {
            *text = stabilize_prompt_text(text);
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
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
    cache_creation_tokens: u64,
    debug_raw_usage: Option<Value>,
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
            cache_creation_tokens: 0,
            debug_raw_usage: None,
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
                    "usage": {
                        "input_tokens": self.input_tokens,
                        "output_tokens": 0,
                        "cache_read_input_tokens": self.cache_read_tokens,
                        "cache_creation_input_tokens": self.cache_creation_tokens
                    }
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
        self.emit_usage_debug();
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
                    "cache_creation_input_tokens": self.cache_creation_tokens,
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
        if crate::usage_debug::enabled() {
            self.debug_raw_usage = Some(usage.clone());
        }
        let split = super::usage::split_provider_usage(&usage);
        // Same rule as the Chat Completions stream: an omitted cache field
        // must not clear a previous hit or be added on top of inclusive input.
        let cache_known =
            split.cache_read_tokens.is_some() || split.cache_creation_tokens.is_some();
        if cache_known {
            if let Some(cache) = split.cache_read_tokens {
                self.cache_read_tokens = cache;
            }
            if let Some(cache) = split.cache_creation_tokens {
                self.cache_creation_tokens = cache;
            }
            if split.input_tokens > 0
                || split.cache_read_tokens.unwrap_or(0) > 0
                || split.cache_creation_tokens.unwrap_or(0) > 0
            {
                self.input_tokens = split.input_tokens;
            }
        } else if self.cache_read_tokens == 0
            && self.cache_creation_tokens == 0
            && split.input_tokens > 0
        {
            self.input_tokens = split.input_tokens;
        }
        if split.output_tokens > 0 {
            self.output_tokens = split.output_tokens;
        }
    }

    pub fn request_usage(&self) -> Option<crate::codex_turn_usage::CodexRequestUsage> {
        if self.input_tokens == 0
            && self.output_tokens == 0
            && self.cache_read_tokens == 0
            && self.cache_creation_tokens == 0
        {
            return None;
        }
        Some(crate::codex_turn_usage::CodexRequestUsage {
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            cache_read_tokens: self.cache_read_tokens,
            cache_creation_tokens: self.cache_creation_tokens,
        })
    }

    fn emit_usage_debug(&mut self) {
        let Some(raw) = self.debug_raw_usage.take() else {
            return;
        };
        let anthropic = json!({
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cache_read_input_tokens": self.cache_read_tokens,
            "cache_creation_input_tokens": self.cache_creation_tokens,
        });
        crate::usage_debug::log_translated(&self.model, &raw, &anthropic);
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
                usage_slot: 0,
            },
        )
        .expect("convert");
        assert_eq!(body["model"], "gpt-5.6-sol");
        assert_eq!(body["store"], false);
        assert_eq!(body["reasoning"]["effort"], "high");
        assert!(body["tools"]
            .as_array()
            .is_some_and(|tools| tools.len() == 1));
        assert!(body["input"]
            .as_array()
            .is_some_and(|items| items.len() == 1));
        assert_eq!(body["input"][0]["role"], "user");
        let instructions = body["instructions"].as_str().unwrap();
        assert!(instructions.contains("IDENTITY OVERRIDE"));
        assert!(instructions.contains("gpt-5.6-sol"));
        assert!(instructions.contains("You are a writer"));
        assert!(!body["input"][0]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("IDENTITY OVERRIDE"));
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
                usage_slot: 0,
            },
        )
        .expect("convert");
        let instructions = body["instructions"].as_str().unwrap();
        assert!(instructions.contains("gpt-5.6-terra"));
        assert!(!instructions.contains("created by Anthropic"));
        assert!(!instructions.contains("You are Claude, an AI"));
        assert_eq!(body["input"][0]["role"], "user");
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
                usage_slot: 0,
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
                usage_slot: 0,
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
    fn codex_cached_input_tokens_are_split_out_of_inclusive_input() {
        let mut translator = ResponsesToAnthropic::default();
        let done = translator.handle_event(
            "response.completed",
            &json!({
                "response": {
                    "usage": {
                        "input_tokens": 189600,
                        "cached_input_tokens": 170000,
                        "output_tokens": 2965
                    }
                }
            }),
        );
        assert!(done.contains("\"input_tokens\":19600"));
        assert!(done.contains("\"cache_read_input_tokens\":170000"));
        assert!(done.contains("\"output_tokens\":2965"));
        assert!(!done.contains("\"input_tokens\":189600"));
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
                usage_slot: 0,
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

    #[test]
    fn debug_usage_log_records_completed_usage_and_not_the_reply() {
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

        let mut translator = ResponsesToAnthropic::for_model("gpt-6-luna");
        let done = translator.handle_event(
            "response.completed",
            &json!({
                "response": {
                    "output": [{
                        "type": "message",
                        "content": [{ "type": "output_text", "text": "SECRET_PROMPT main.tex body" }]
                    }],
                    "usage": {
                        "input_tokens": 189600,
                        "cached_input_tokens": 170000,
                        "output_tokens": 2965
                    }
                }
            }),
        );
        assert!(done.contains("\"input_tokens\":19600"));

        let text =
            std::fs::read_to_string(home.path().join("logs").join("usage-debug.jsonl")).unwrap();
        assert!(!text.contains("SECRET_PROMPT"));
        assert!(!text.contains("main.tex"));
        assert!(!text.contains("Bearer"));
        let lines: Vec<&str> = text.lines().filter(|line| !line.is_empty()).collect();
        assert_eq!(lines.len(), 2);
        let upstream: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        let anthropic: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(upstream["stage"], "upstream");
        assert_eq!(anthropic["stage"], "anthropic");
        assert_eq!(upstream["model"], "gpt-6-luna");
        assert_eq!(upstream["seq"], anthropic["seq"]);
        assert_eq!(upstream["usage"]["cached_input_tokens"], 170000);
        assert_eq!(anthropic["usage"]["input_tokens"], 19600);
        assert_eq!(anthropic["usage"]["cache_read_input_tokens"], 170000);
        assert!(upstream["usage"].get("output").is_none());
    }

    fn cache_credential() -> CodexProxyCredential {
        CodexProxyCredential {
            access_token: "t".into(),
            refresh_token: None,
            account_id: None,
            model: "gpt-6-luna".into(),
            effort: None,
            usage_slot: 0,
        }
    }

    #[test]
    fn consecutive_requests_share_prompt_cache_prefix() {
        let tools_first: Value = serde_json::from_str(
            r#"[{"name":"Read","description":"Read a file","input_schema":{"type":"object","properties":{"path":{"type":"string"},"limit":{"type":"number"}}}},{"name":"Bash","description":"Run a command","input_schema":{"type":"object","properties":{"command":{"type":"string"}}}}]"#,
        )
        .expect("tools");
        let tools_second: Value = serde_json::from_str(
            r#"[{"input_schema":{"properties":{"command":{"type":"string"}},"type":"object"},"description":"Run a command","name":"Bash"},{"name":"Read","description":"Read a file","input_schema":{"properties":{"limit":{"type":"number"},"path":{"type":"string"}},"type":"object"}}]"#,
        )
        .expect("tools");
        let system_first = "You are a writer. Today is 2026-10-06. Request 11111111-1111-1111-1111-111111111111 at 2026-10-06T09:10:09Z and 09:10:09.";
        let system_second = "You are a writer. Today is 2026-10-06. Request 22222222-2222-2222-2222-222222222222 at 2026-10-06T09:10:20.945Z and 09:10:20.";
        let request_first = json!({
            "system": system_first,
            "metadata": { "user_id": "{\"session_id\":\"sess_abc\"}" },
            "messages": [
                {"role": "user", "content": "Read main.tex"},
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "call_1", "name": "Read", "input": {"limit": 10, "path": "main.tex"}}
                ]}
            ],
            "tools": tools_first,
        });
        let request_second = json!({
            "system": system_second,
            "metadata": { "user_id": "{\"device_id\":\"dev\",\"session_id\":\"sess_abc\"}" },
            "messages": [
                {"role": "user", "content": "Read main.tex"},
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "call_1", "name": "Read", "input": {"path": "main.tex", "limit": 10}}
                ]},
                {"role": "system", "content": "2026-10-06T09:10:20.945Z"},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "call_1", "content": "file body"},
                    {"type": "text", "text": "Now edit it"}
                ]}
            ],
            "tools": tools_second,
        });
        let credential = cache_credential();
        let first = anthropic_to_codex_responses(&request_first, &credential).expect("first");
        let second = anthropic_to_codex_responses(&request_second, &credential).expect("second");

        assert_eq!(first["prompt_cache_key"], "sess_abc");
        assert_eq!(first["prompt_cache_key"], second["prompt_cache_key"]);
        assert_eq!(first["store"], false);
        assert_eq!(second["store"], false);
        assert_eq!(first["instructions"], second["instructions"]);
        let instructions = first["instructions"].as_str().expect("instructions");
        assert!(instructions.contains("2026-10-06"));
        assert!(instructions.contains("You are a writer"));
        assert!(!instructions.contains("11111111-1111-1111-1111-111111111111"));
        assert!(!instructions.contains("22222222-2222-2222-2222-222222222222"));
        assert!(!instructions.contains("09:10:09"));
        assert!(!instructions.contains("09:10:20"));
        assert!(!instructions.contains("T09"));
        assert_eq!(first["tools"].to_string(), second["tools"].to_string());
        assert_eq!(first["tools"][0]["name"], "Bash");
        assert_eq!(first["tools"][1]["name"], "Read");

        let prefix = first["input"].as_array().expect("input");
        let next = second["input"].as_array().expect("input");
        assert!(next.len() > prefix.len());
        assert_eq!(&next[..prefix.len()], prefix.as_slice());
        assert_eq!(
            next[1]["arguments"].as_str(),
            prefix[1]["arguments"].as_str()
        );
        assert!(!next
            .iter()
            .any(|item| item.get("role").and_then(Value::as_str) == Some("system")));

        let header = anthropic_to_codex_responses_for_session(
            &request_second,
            &credential,
            Some("header_session_1"),
        )
        .expect("header");
        let header_again = anthropic_to_codex_responses_for_session(
            &request_first,
            &credential,
            Some("header_session_1"),
        )
        .expect("header again");
        assert_eq!(header["prompt_cache_key"], "header_session_1");
        assert_eq!(header["prompt_cache_key"], header_again["prompt_cache_key"]);
        assert_eq!(header["instructions"], header_again["instructions"]);
        assert_eq!(header["tools"], header_again["tools"]);
    }

    #[test]
    fn same_conversation_without_session_id_reuses_prompt_cache_key() {
        let credential = cache_credential();
        let first = anthropic_to_codex_responses(
            &json!({
                "system": "Stable instructions. 11111111-1111-1111-1111-111111111111 2026-10-06T09:10:09Z",
                "messages": [{"role": "user", "content": "Read main.tex"}],
            }),
            &credential,
        )
        .expect("first");
        let second = anthropic_to_codex_responses(
            &json!({
                "system": "Stable instructions. 22222222-2222-2222-2222-222222222222 2026-10-06T09:11:10Z",
                "messages": [
                    {"role": "user", "content": "Read main.tex"},
                    {"role": "assistant", "content": "Done"},
                    {"role": "user", "content": "Edit it"}
                ],
            }),
            &credential,
        )
        .expect("second");
        let again = anthropic_to_codex_responses(
            &json!({
                "system": "Stable instructions. 33333333-3333-3333-3333-333333333333 09:12:13",
                "messages": [{"role": "user", "content": "Read main.tex"}],
            }),
            &credential,
        )
        .expect("again");
        let other = anthropic_to_codex_responses(
            &json!({
                "system": "Stable instructions.",
                "messages": [{"role": "user", "content": "A different conversation"}],
            }),
            &credential,
        )
        .expect("other");

        let key = first["prompt_cache_key"].as_str().expect("key");
        assert_eq!(key.len(), 64);
        assert!(key.chars().all(|ch| ch.is_ascii_hexdigit()));
        assert_eq!(first["prompt_cache_key"], second["prompt_cache_key"]);
        assert_eq!(first["prompt_cache_key"], again["prompt_cache_key"]);
        assert_ne!(first["prompt_cache_key"], other["prompt_cache_key"]);
        assert_eq!(first["instructions"], second["instructions"]);
        let prefix = first["input"].as_array().expect("input");
        let next = second["input"].as_array().expect("input");
        assert_eq!(&next[..prefix.len()], prefix.as_slice());
    }
}
