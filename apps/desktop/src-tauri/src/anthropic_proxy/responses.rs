use crate::providers::openai_oauth::{
    OPENAI_CODEX_API_ENDPOINT, OPENAI_CODEX_ORIGINATOR, OPENAI_CODEX_USER_AGENT,
};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

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

pub struct PreparedCodexRequest {
    pub body: Value,
    /// `header`, `body`, or `fallback`. Debug logs only; not sent upstream.
    pub cache_key_origin: &'static str,
    pub subagent: bool,
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
    Ok(prepare_codex_request(request, credential, header_session, None)?.body)
}

pub fn prepare_codex_request(
    request: &Value,
    credential: &CodexProxyCredential,
    header_session: Option<&str>,
    header_agent_id: Option<&str>,
) -> Result<PreparedCodexRequest, String> {
    // Leave mid-transcript system/developer turns in `messages`. Hoisting them
    // into `instructions` changes the cached prefix when a skill or ToolSearch
    // block appears later in the conversation.
    let subagent_marker = crate::codex_turn_usage::subagent_marker(header_agent_id, request);
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
    let mut dynamic_notes = Vec::new();
    if let Some(raw_tools) = request.get("tools").and_then(Value::as_array) {
        tools = raw_tools
            .iter()
            .filter_map(anthropic_tool_to_function)
            .collect();
        for tool in &mut tools {
            let name = tool
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string();
            if let Some(description) = tool.get("description").and_then(Value::as_str) {
                let (stable, notes) = peel_dynamic_tool_text(description);
                tool["description"] = Value::String(stable);
                dynamic_notes.extend(notes.into_iter().map(|note| format!("{name}: {note}")));
            }
            if let Some(parameters) = tool.get_mut("parameters") {
                dynamic_notes.extend(detach_dynamic_enums(&name, parameters));
                peel_dynamic_schema_text(parameters, &name, &mut dynamic_notes);
            }
            stabilize_value_strings(tool, &["name"]);
            canonicalize_json(tool);
        }
        tools.sort_by(|left, right| {
            let left_name = left.get("name").and_then(Value::as_str).unwrap_or("");
            let right_name = right.get("name").and_then(Value::as_str).unwrap_or("");
            left_name
                .cmp(right_name)
                .then_with(|| left.to_string().cmp(&right.to_string()))
        });
    }
    dynamic_notes.sort();
    dynamic_notes.dedup();
    if !dynamic_notes.is_empty() {
        let note = stabilize_prompt_text(&dynamic_notes.join("\n"));
        let note = note.trim();
        if !note.is_empty() {
            // Stable position: a change here does not rewrite `tools` or
            // `instructions`, which are the bytes the cache has to reuse.
            input.insert(0, developer_input(note));
        }
    }

    let (cache_key, cache_key_origin) = prompt_cache_key(
        request,
        header_session,
        instructions.as_deref().unwrap_or(""),
        &tools,
        &input,
    );
    let cache_key = match subagent_marker.as_deref() {
        Some(marker) => sanitize_cache_key(&format!("{cache_key}_agent_{marker}")),
        None => cache_key,
    };

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
    Ok(PreparedCodexRequest {
        body,
        cache_key_origin,
        subagent: subagent_marker.is_some(),
    })
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
        Some(Value::String(text)) => push_role_text(input, role, text),
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
                push_role_text(input, role, &texts.join("\n"));
            }
        }
        _ => {}
    }
}

fn push_role_text(input: &mut Vec<Value>, role: &str, text: &str) {
    let text = if role == "system" || role == "developer" {
        stabilize_prompt_text(text)
    } else {
        text.to_string()
    };
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    let (wire_role, content_type) = if role == "assistant" {
        ("assistant", "output_text")
    } else if role == "system" || role == "developer" {
        ("developer", "input_text")
    } else {
        ("user", "input_text")
    };
    input.push(json!({
        "role": wire_role,
        "content": [{ "type": content_type, "text": text }],
    }));
}

fn developer_input(text: &str) -> Value {
    json!({
        "role": "developer",
        "content": [{ "type": "input_text", "text": text }],
    })
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
/// The origin is `header`, `body`, or `fallback` for the debug log.
fn prompt_cache_key(
    request: &Value,
    header_session: Option<&str>,
    instructions: &str,
    tools: &[Value],
    input: &[Value],
) -> (String, &'static str) {
    if let Some(session) = header_session
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return (sanitize_cache_key(session), "header");
    }
    if let Some(session) = session_id_from_request(request) {
        return (sanitize_cache_key(&session), "body");
    }
    (
        fallback_prompt_cache_key(instructions, tools, input),
        "fallback",
    )
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
///
/// An ISO timestamp keeps its calendar date (`2026-10-06`) and loses only the
/// time and zone (`T09:10:09Z`). The date is part of what the model should
/// know; the clock is what changes between requests.
fn stabilize_prompt_text(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let previous_is_hex = index > 0 && bytes[index - 1].is_ascii_hexdigit();
        if !previous_is_hex {
            if let Some(skip) = iso_time_suffix_len(&input[index..]) {
                let date_end = index + 10;
                out.push_str(&input[index..date_end]);
                index = date_end + skip;
                continue;
            }
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
    uuid_len(text).or_else(|| clock_time_len(text))
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

/// Length of the time/zone tail after a leading `YYYY-MM-DD`. `None` when the
/// text is not an ISO timestamp, so a bare calendar date stays put.
fn iso_time_suffix_len(text: &str) -> Option<usize> {
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
    Some(index - 10)
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

/// Claude Code embeds the live agent/skill list, cwd, and date in tool
/// descriptions. That list is what changed the tools block by a few tokens
/// between two calls in one turn (15,423 then 15,427). Official Claude Code
/// keeps the tool description static and puts the list in a message so the
/// tools prefix can cache. Do the same here.
fn peel_dynamic_tool_text(text: &str) -> (String, Vec<String>) {
    let (text, agent_list) = peel_headed_section(
        text,
        "Available agent types and the tools they have access to:",
        "Available agent types are listed in messages in the conversation.",
    );
    let (text, short_agent_list) = if agent_list.is_none() {
        peel_headed_section(
            &text,
            "Available agent types:",
            "Available agent types are listed in messages in the conversation.",
        )
    } else {
        (text, None)
    };
    let (text, skill_list) = peel_headed_section(
        &text,
        "Available skills:",
        "Available skills are listed in messages in the conversation.",
    );
    let (text, lines) = peel_volatile_tool_lines(&text);
    let mut notes = Vec::new();
    if let Some(list) = agent_list.or(short_agent_list) {
        notes.push(list);
    }
    if let Some(list) = skill_list {
        notes.push(list);
    }
    notes.extend(lines);
    (text, notes)
}

fn peel_headed_section(text: &str, header: &str, replacement: &str) -> (String, Option<String>) {
    let Some(start) = text.find(header) else {
        return (text.to_string(), None);
    };
    let after = start + header.len();
    let rest = &text[after..];
    let end = rest.find("\n\n").unwrap_or(rest.len());
    let list = rest[..end].trim();
    let mut stable = String::new();
    stable.push_str(&text[..start]);
    stable.push_str(replacement);
    stable.push_str(&text[after + end..]);
    let extracted = if list.is_empty() {
        None
    } else {
        Some(format!("{header}\n{list}"))
    };
    (stable, extracted)
}

fn peel_volatile_tool_lines(text: &str) -> (String, Vec<String>) {
    let mut kept = String::new();
    let mut peeled = Vec::new();
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim();
        if is_volatile_tool_line(trimmed) {
            if !trimmed.is_empty() {
                peeled.push(trimmed.to_string());
            }
            continue;
        }
        kept.push_str(line);
    }
    (kept, peeled)
}

fn is_volatile_tool_line(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.contains("current working directory")
        || lower.starts_with("cwd:")
        || lower.starts_with("cwd ")
        || lower.contains("today's date")
        || lower.contains("todays date")
        || lower.starts_with("today is ")
        || lower.starts_with("date:")
}

/// Agent and skill name enums grow when a plugin or skill loads. A four-token
/// bump is enough to miss the whole tools prefix. The names move to the
/// leading input note; the schema stays a plain string.
fn detach_dynamic_enums(tool_name: &str, schema: &mut Value) -> Vec<String> {
    let Some(properties) = schema.get_mut("properties").and_then(Value::as_object_mut) else {
        return Vec::new();
    };
    let mut notes = Vec::new();
    for key in ["subagent_type", "agent_type", "skill", "skill_name"] {
        let Some(property) = properties.get_mut(key).and_then(Value::as_object_mut) else {
            continue;
        };
        let Some(values) = property.get("enum").and_then(Value::as_array) else {
            continue;
        };
        let names: Vec<&str> = values.iter().filter_map(Value::as_str).collect();
        if names.is_empty() {
            continue;
        }
        notes.push(format!("{tool_name}.{key}: {}", names.join(", ")));
        property.remove("enum");
    }
    notes
}

fn peel_dynamic_schema_text(value: &mut Value, tool_name: &str, notes: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(text)) = map.get_mut("description") {
                let (stable, peeled) = peel_dynamic_tool_text(text);
                *text = stable;
                notes.extend(
                    peeled
                        .into_iter()
                        .map(|note| format!("{tool_name}: {note}")),
                );
            }
            for (key, child) in map.iter_mut() {
                if key == "description" {
                    continue;
                }
                peel_dynamic_schema_text(child, tool_name, notes);
            }
        }
        Value::Array(items) => {
            for item in items {
                peel_dynamic_schema_text(item, tool_name, notes);
            }
        }
        _ => {}
    }
}

fn canonicalize_json(value: &mut Value) {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<String> = map.keys().cloned().collect();
            keys.sort();
            let mut sorted = Map::new();
            for key in keys {
                if let Some(mut child) = map.remove(&key) {
                    canonicalize_json(&mut child);
                    sorted.insert(key, child);
                }
            }
            *map = sorted;
        }
        Value::Array(items) => {
            for item in items {
                canonicalize_json(item);
            }
        }
        _ => {}
    }
}

struct ThreadRoute {
    turn_state: Option<String>,
    item_hashes: Vec<String>,
}

static THREAD_ROUTES: LazyLock<Mutex<HashMap<String, ThreadRoute>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// `x-codex-turn-state` is a sticky routing token for requests inside one
/// turn. Official Codex replays it only within the turn that received it.
/// A tool loop extends the previous input with function calls and outputs;
/// a new user message starts a turn and must not reuse the old token.
pub fn codex_turn_state_for_request(cache_key: &str, input: &[Value]) -> Option<String> {
    if cache_key.is_empty() {
        return None;
    }
    let mut routes = THREAD_ROUTES.lock().unwrap_or_else(|err| err.into_inner());
    let entry = routes.entry(cache_key.to_string()).or_insert(ThreadRoute {
        turn_state: None,
        item_hashes: Vec::new(),
    });
    let continuation = is_tool_continuation(&entry.item_hashes, input);
    if !continuation {
        entry.turn_state = None;
    }
    let turn_state = if continuation {
        entry.turn_state.clone()
    } else {
        None
    };
    entry.item_hashes = input.iter().map(hash_json).collect();
    turn_state
}

pub fn remember_codex_turn_state(cache_key: &str, state: &str) {
    let state = state.trim();
    if cache_key.is_empty() || state.is_empty() || state.len() > 512 {
        return;
    }
    if state.chars().any(|ch| ch.is_control()) {
        return;
    }
    let mut routes = THREAD_ROUTES.lock().unwrap_or_else(|err| err.into_inner());
    let entry = routes.entry(cache_key.to_string()).or_insert(ThreadRoute {
        turn_state: None,
        item_hashes: Vec::new(),
    });
    entry.turn_state = Some(state.to_string());
}

fn is_tool_continuation(previous: &[String], input: &[Value]) -> bool {
    if previous.is_empty() || input.len() <= previous.len() {
        return false;
    }
    for (index, hash) in previous.iter().enumerate() {
        if &hash_json(&input[index]) != hash {
            return false;
        }
    }
    input[previous.len()..].iter().all(|item| {
        matches!(
            item.get("type").and_then(Value::as_str),
            Some("function_call") | Some("function_call_output")
        )
    })
}

fn hash_json(value: &Value) -> String {
    sha256_hex(value.to_string().as_bytes())
}

pub fn responses_headers(
    credential: &CodexProxyCredential,
    session_id: Option<&str>,
    turn_state: Option<&str>,
) -> Vec<(String, String)> {
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
    // Codex routes prompt cache with the conversation id on both session and
    // thread headers, and sets `x-client-request-id` to that same thread id
    // (not a fresh id per HTTP call). Underscore spellings were removed
    // upstream because some proxies reject them.
    if let Some(session_id) = session_id.map(str::trim).filter(|value| !value.is_empty()) {
        headers.push(("session-id".into(), session_id.to_string()));
        headers.push(("thread-id".into(), session_id.to_string()));
        headers.push(("x-client-request-id".into(), session_id.to_string()));
    }
    if let Some(turn_state) = turn_state.map(str::trim).filter(|value| !value.is_empty()) {
        headers.push(("x-codex-turn-state".into(), turn_state.to_string()));
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
                "system": "Stable instructions. 33333333-3333-3333-3333-333333333333 2026-10-06T09:12:13Z",
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
        let instructions = first["instructions"].as_str().expect("instructions");
        assert!(instructions.contains("2026-10-06"));
        assert!(!instructions.contains("T09"));
    }

    #[test]
    fn iso_timestamp_keeps_the_calendar_date_without_a_today_line() {
        let credential = cache_credential();
        let body = anthropic_to_codex_responses(
            &json!({
                "system": "Session opened 2026-10-06T09:10:09.945Z. Clock 09:10:09.",
                "messages": [{"role": "user", "content": "Hi"}],
            }),
            &credential,
        )
        .expect("body");
        let instructions = body["instructions"].as_str().expect("instructions");
        assert!(instructions.contains("2026-10-06"));
        assert!(instructions.contains("Session opened"));
        assert!(!instructions.contains("T09"));
        assert!(!instructions.contains("09:10:09"));
        assert!(!instructions.contains(".945"));
    }

    #[test]
    fn later_system_messages_stay_in_input() {
        let credential = cache_credential();
        let base = json!({
            "system": "You are a writer.",
            "messages": [{"role": "user", "content": "Read main.tex"}],
        });
        let with_skill = json!({
            "system": "You are a writer.",
            "messages": [
                {"role": "user", "content": "Read main.tex"},
                {"role": "system", "content": "ToolSearch context.\nSkill: nature-writing.\nLoaded 2026-10-06T09:10:09Z."},
                {"role": "user", "content": "Use the skill"}
            ],
        });
        let first = anthropic_to_codex_responses(&base, &credential).expect("first");
        let second = anthropic_to_codex_responses(&with_skill, &credential).expect("second");
        assert_eq!(second["instructions"], first["instructions"]);
        let instructions = first["instructions"].as_str().unwrap();
        assert!(instructions.contains("You are a writer."));
        assert!(!instructions.contains("ToolSearch"));
        assert!(!second["instructions"]
            .as_str()
            .unwrap()
            .contains("ToolSearch"));
        let input = second["input"].as_array().expect("input");
        let note = input
            .iter()
            .find(|item| item.get("role").and_then(Value::as_str) == Some("developer"))
            .expect("skill note");
        let text = note
            .pointer("/content/0/text")
            .and_then(Value::as_str)
            .unwrap();
        assert!(text.contains("ToolSearch context."));
        assert!(text.contains("nature-writing"));
        assert!(text.contains("2026-10-06"));
        assert!(!text.contains("T09"));
        let prefix = first["input"].as_array().unwrap();
        assert_eq!(&input[..prefix.len()], prefix.as_slice());
    }

    #[test]
    fn dynamic_agent_list_leaves_the_tools_prefix_unchanged() {
        let credential = cache_credential();
        let description = |agents: &str| {
            format!(
                "Launch a new agent.\n\nAvailable agent types and the tools they have access to:\n{agents}\n\nWhen using the Agent tool, specify a subagent_type.\nToday's date is 2026-10-06T09:10:09Z.\nCurrent working directory: /tmp/paper"
            )
        };
        let request = |agents: &str, skills: &[&str]| {
            json!({
                "system": "You are a writer.",
                "metadata": { "user_id": "{\"session_id\":\"sess_tools\"}" },
                "messages": [{"role": "user", "content": "Read main.tex"}],
                "tools": [{
                    "name": "Agent",
                    "description": description(agents),
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "subagent_type": {
                                "type": "string",
                                "enum": skills,
                                "description": "Which agent to run"
                            }
                        }
                    }
                }, {
                    "name": "Skill",
                    "description": "Run a skill.\n\nAvailable skills:\n- nature-writing: papers\n- de-ai: polish",
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "skill": { "type": "string", "enum": ["nature-writing", "de-ai"] }
                        }
                    }
                }]
            })
        };
        let first = anthropic_to_codex_responses(
            &request("- Explore: search (Tools: Read)", &["Explore"]),
            &credential,
        )
        .expect("first");
        let second = anthropic_to_codex_responses(
            &request(
                "- Explore: search (Tools: Read, Glob)\n- writer: draft (Tools: *)",
                &["Explore", "writer"],
            ),
            &credential,
        )
        .expect("second");
        assert_eq!(first["tools"].to_string(), second["tools"].to_string());
        let tools = first["tools"].to_string();
        assert!(!tools.contains("Explore"));
        assert!(!tools.contains("writer"));
        assert!(!tools.contains("nature-writing"));
        assert!(!tools.contains("/tmp/paper"));
        assert!(!tools.contains("2026-10-06T09"));
        assert!(tools.contains("listed in messages"));
        let note = first["input"][0]
            .pointer("/content/0/text")
            .and_then(Value::as_str)
            .unwrap();
        let note_again = second["input"][0]
            .pointer("/content/0/text")
            .and_then(Value::as_str)
            .unwrap();
        assert!(note.contains("Explore"));
        assert!(note.contains("/tmp/paper"));
        assert!(note.contains("2026-10-06"));
        assert!(!note.contains("T09"));
        assert!(note_again.contains("writer"));
        assert_ne!(note, note_again);
        assert_eq!(first["instructions"], second["instructions"]);
    }

    #[test]
    fn subagent_requests_do_not_share_the_root_cache_key() {
        let credential = cache_credential();
        let root = json!({
            "system": "You are a writer.",
            "metadata": { "user_id": "{\"session_id\":\"sess_root\"}" },
            "messages": [{"role": "user", "content": "Read main.tex"}],
        });
        let subagent = json!({
            "system": "You are a writer.",
            "metadata": {
                "parent_tool_use_id": "toolu_sub",
                "user_id": "{\"session_id\":\"sess_root\"}"
            },
            "messages": [{"role": "user", "content": "Look at one file"}],
        });
        let root_body = prepare_codex_request(&root, &credential, None, None).expect("root");
        let sub_body =
            prepare_codex_request(&subagent, &credential, None, Some("writer")).expect("sub");
        assert!(!root_body.subagent);
        assert!(sub_body.subagent);
        assert_eq!(root_body.cache_key_origin, "body");
        assert_ne!(
            root_body.body["prompt_cache_key"],
            sub_body.body["prompt_cache_key"]
        );
        assert!(root_body.body["prompt_cache_key"]
            .as_str()
            .unwrap()
            .contains("sess_root"));
    }

    #[test]
    fn session_headers_follow_the_codex_client_and_turn_state_stays_in_the_turn() {
        let credential = CodexProxyCredential {
            access_token: "token".into(),
            refresh_token: None,
            account_id: Some("acct_1".into()),
            model: "gpt-6-luna".into(),
            effort: None,
            usage_slot: 0,
        };
        let cold = responses_headers(&credential, Some("sess_abc"), None);
        assert!(cold
            .iter()
            .any(|(key, value)| key == "session-id" && value == "sess_abc"));
        assert!(cold
            .iter()
            .any(|(key, value)| key == "thread-id" && value == "sess_abc"));
        assert!(cold
            .iter()
            .any(|(key, value)| key == "x-client-request-id" && value == "sess_abc"));
        assert!(cold
            .iter()
            .any(|(key, value)| key == "originator" && value == "codex_cli_rs"));
        assert!(cold
            .iter()
            .any(|(key, value)| key == "OpenAI-Beta" && value == "responses=experimental"));
        assert!(cold
            .iter()
            .any(|(key, value)| key == "ChatGPT-Account-Id" && value == "acct_1"));
        assert!(!cold.iter().any(|(key, _)| key == "x-codex-turn-state"));
        assert!(!cold.iter().any(|(key, _)| key == "session_id"));

        let cache_key = "sess_turn_state_test";
        let first = [json!({"role": "user", "content": [{"type": "input_text", "text": "hi"}]})];
        assert!(codex_turn_state_for_request(cache_key, &first).is_none());
        remember_codex_turn_state(cache_key, "turn-token");
        let continued = [
            first[0].clone(),
            json!({"type": "function_call", "call_id": "call_1", "name": "Read", "arguments": "{}"}),
            json!({"type": "function_call_output", "call_id": "call_1", "output": "body"}),
        ];
        assert_eq!(
            codex_turn_state_for_request(cache_key, &continued).as_deref(),
            Some("turn-token")
        );
        let new_turn = [
            first[0].clone(),
            json!({"type": "function_call", "call_id": "call_1", "name": "Read", "arguments": "{}"}),
            json!({"type": "function_call_output", "call_id": "call_1", "output": "body"}),
            json!({"role": "user", "content": [{"type": "input_text", "text": "next"}]}),
        ];
        assert!(codex_turn_state_for_request(cache_key, &new_turn).is_none());
    }
}
