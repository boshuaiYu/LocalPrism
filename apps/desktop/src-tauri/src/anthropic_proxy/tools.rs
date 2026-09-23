use std::collections::HashMap;

use serde_json::{json, Value};

pub(super) fn repaired_tool_arguments_value(arguments: &str) -> Value {
    serde_json::from_str::<Value>(&repair_tool_arguments(arguments)).unwrap_or_else(|_| json!({}))
}

pub(super) fn normalized_tool_call_id(id: Option<&str>) -> String {
    let id = id.unwrap_or_default().trim();
    if id.is_empty() || id.chars().all(|ch| ch.is_ascii_digit()) {
        format!("call_{}", uuid::Uuid::new_v4().simple())
    } else {
        id.to_string()
    }
}

/// Identical Skill/LoadSkill calls in one model response become one tool_use.
/// Returns true when this call should be dropped.
pub(super) fn duplicate_skill_tool_call(
    seen: &mut std::collections::HashSet<String>,
    name: &str,
    input: &Value,
) -> bool {
    let normalized = name.trim().to_ascii_lowercase();
    if normalized != "skill" && normalized != "loadskill" {
        return false;
    }
    let skill_name = skill_argument_name(input);
    let args = input
        .get("args")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    !seen.insert(format!("{skill_name}\n{args}"))
}

fn skill_argument_name(input: &Value) -> String {
    for key in ["skill", "skill_name", "name", "command"] {
        if let Some(value) = input.get(key).and_then(|item| item.as_str()) {
            let trimmed = value.trim().trim_start_matches('/');
            if !trimmed.is_empty() {
                return trimmed.to_ascii_lowercase();
            }
        }
    }
    "skill".to_string()
}

pub(super) fn repair_tool_arguments(arguments: &str) -> String {
    let trimmed = trim_code_fence(arguments.trim());
    if trimmed.is_empty() || trimmed == "{}" {
        return "{}".to_string();
    }

    let mut candidates = Vec::new();
    push_candidate(&mut candidates, trimmed.to_string());
    if let Some(extracted) = extract_json_like(trimmed) {
        push_candidate(&mut candidates, extracted);
    }

    let seeds = candidates.clone();
    for candidate in seeds {
        let without_comments = strip_json_comments(&candidate);
        push_candidate(&mut candidates, without_comments.clone());

        let without_trailing_commas = remove_trailing_commas(&without_comments);
        push_candidate(&mut candidates, without_trailing_commas.clone());

        let json5_like =
            normalize_single_quoted_strings(&quote_unquoted_object_keys(&without_trailing_commas));
        push_candidate(&mut candidates, json5_like.clone());

        if let Some(with_commas) = insert_missing_commas_between_fields(&json5_like) {
            push_candidate(&mut candidates, with_commas.clone());
            if let Some(balanced) = repair_balanced_json(with_commas) {
                push_candidate(&mut candidates, balanced);
            }
        }
        if let Some(balanced) = repair_balanced_json(json5_like) {
            push_candidate(&mut candidates, balanced);
        }
        if let Some(balanced) = repair_balanced_json(without_trailing_commas) {
            push_candidate(&mut candidates, balanced);
        }
    }

    for candidate in candidates {
        if let Some(repaired) = parse_tool_arguments_candidate(&candidate) {
            return repaired;
        }
    }

    "{}".to_string()
}

fn push_candidate(candidates: &mut Vec<String>, value: String) {
    let value = value.trim().to_string();
    if value.is_empty() || candidates.iter().any(|candidate| candidate == &value) {
        return;
    }
    candidates.push(value);
}

fn parse_tool_arguments_candidate(value: &str) -> Option<String> {
    serde_json::from_str::<Value>(value)
        .ok()
        .or_else(|| serde_yaml::from_str::<Value>(value).ok())
        .and_then(canonical_tool_arguments)
}

fn canonical_tool_arguments(value: Value) -> Option<String> {
    match value {
        Value::Object(map) => {
            if map.keys().any(|key| key.contains(':')) {
                return None;
            }
            Some(sanitize_tool_input(Value::Object(map)).to_string())
        }
        Value::Array(_) => Some(value.to_string()),
        _ => None,
    }
}

/// Claude Code Read rejects `pages: ""` (and other empty optionals).
/// GPT-family models often emit those instead of omitting the key.
pub(crate) fn sanitize_tool_input(value: Value) -> Value {
    let Value::Object(mut map) = value else {
        return value;
    };
    sanitize_optional_pages(&mut map);
    Value::Object(map)
}

fn sanitize_optional_pages(map: &mut serde_json::Map<String, Value>) {
    let Some(pages) = map.get("pages").cloned() else {
        return;
    };
    match pages {
        Value::Null => {
            map.remove("pages");
        }
        Value::String(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() || !is_valid_read_pages(trimmed) {
                map.remove("pages");
            } else if trimmed != raw {
                map.insert("pages".into(), Value::String(trimmed.to_string()));
            }
        }
        Value::Number(number) => {
            if let Some(page) = number.as_u64().filter(|page| *page >= 1) {
                map.insert("pages".into(), Value::String(page.to_string()));
            } else {
                map.remove("pages");
            }
        }
        _ => {
            map.remove("pages");
        }
    }
}

fn is_valid_read_pages(value: &str) -> bool {
    value.split(',').all(|part| {
        let part = part.trim();
        if part.is_empty() {
            return false;
        }
        if let Some((start, end)) = part.split_once('-') {
            return page_index(start)
                .is_some_and(|first| page_index(end).is_some_and(|last| last >= first));
        }
        page_index(part).is_some()
    })
}

fn page_index(value: &str) -> Option<u32> {
    value.trim().parse::<u32>().ok().filter(|page| *page >= 1)
}

const READ_PAGES_SCHEMA_NOTE: &str = "Omit for non-PDF files. Never pass an empty string; it is invalid. When set, use a 1-indexed range such as \"1\", \"3\", \"1-5\", or \"10-20\".";

fn is_read_tool_name(name: &str) -> bool {
    name.eq_ignore_ascii_case("read")
}

/// Tell models that `pages: ""` is not a valid Read argument.
/// Claude Code rejects that shape before the file is read.
pub(super) fn prepare_forwarded_tool_description(name: &str, description: &str) -> String {
    if !is_read_tool_name(name) || description.to_ascii_lowercase().contains("empty string") {
        return description.to_string();
    }
    let note = "For PDFs only, pages must be a 1-indexed range like \"1-5\", \"3\", or \"10-20\". Omit pages for other files; an empty string is invalid.";
    if description.trim().is_empty() {
        note.to_string()
    } else {
        format!("{description} {note}")
    }
}

pub(super) fn prepare_forwarded_tool_schema(name: &str, mut schema: Value) -> Value {
    if !is_read_tool_name(name) {
        return schema;
    }
    if let Some(root) = schema.as_object_mut() {
        if let Some(required) = root
            .get_mut("required")
            .and_then(|value| value.as_array_mut())
        {
            required.retain(|item| item.as_str() != Some("pages"));
        }
        if let Some(properties) = root
            .get_mut("properties")
            .and_then(|value| value.as_object_mut())
        {
            if let Some(pages) = properties
                .get_mut("pages")
                .and_then(|value| value.as_object_mut())
            {
                if pages.get("default").is_some_and(|value| {
                    value.is_null() || value.as_str().is_some_and(|text| text.trim().is_empty())
                }) {
                    pages.remove("default");
                }
                let existing = pages
                    .get("description")
                    .and_then(|value| value.as_str())
                    .unwrap_or("");
                if !existing.to_ascii_lowercase().contains("empty string") {
                    let description = if existing.is_empty() {
                        READ_PAGES_SCHEMA_NOTE.to_string()
                    } else {
                        format!("{existing} {READ_PAGES_SCHEMA_NOTE}")
                    };
                    pages.insert("description".into(), Value::String(description));
                }
            }
        }
    }
    schema
}

pub(super) fn sanitize_tool_uses_in_messages(body: &mut Value) {
    let Some(messages) = body
        .get_mut("messages")
        .and_then(|value| value.as_array_mut())
    else {
        return;
    };
    for message in messages {
        let _ = sanitize_content_tool_inputs(message.get_mut("content"));
    }
}

pub(super) fn sanitize_anthropic_message_body(body: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(body) else {
        return body.to_string();
    };
    if !sanitize_content_tool_inputs(value.get_mut("content")) {
        return body.to_string();
    }
    value.to_string()
}

fn sanitize_content_tool_inputs(content: Option<&mut Value>) -> bool {
    let Some(Value::Array(blocks)) = content else {
        return false;
    };
    let mut changed = false;
    for block in blocks {
        if block.get("type").and_then(|value| value.as_str()) != Some("tool_use") {
            continue;
        }
        let Some(input) = block.get("input").cloned() else {
            continue;
        };
        let sanitized = sanitize_tool_input(input.clone());
        if sanitized != input {
            block["input"] = sanitized;
            changed = true;
        }
    }
    changed
}

#[derive(Default)]
struct PendingToolInput {
    arguments: String,
    /// Sanitized `content_block_start.input` already has real fields.
    /// A delta that repairs to `{}` must not replace that input.
    start_had_input: bool,
}

/// Buffers Anthropic `input_json_delta` fragments for tool blocks and emits
/// one sanitized payload on `content_block_stop`. Claude Code rejects
/// `Read.pages == ""` as soon as it parses the concatenated input.
///
/// Chunks stay as bytes until an SSE record boundary so a multibyte UTF-8
/// character split across TCP reads is not corrupted.
#[derive(Default)]
pub(super) struct AnthropicToolInputSseFilter {
    buffer: Vec<u8>,
    pending: HashMap<i64, PendingToolInput>,
}

impl AnthropicToolInputSseFilter {
    pub(super) fn push_bytes(&mut self, chunk: &[u8]) -> Vec<u8> {
        self.buffer.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some((block, consumed)) = split_sse_block_bytes(&self.buffer) {
            self.buffer.drain(..consumed);
            match std::str::from_utf8(&block) {
                Ok(text) => out.extend_from_slice(self.rewrite_block(text).as_bytes()),
                Err(_) => {
                    out.extend_from_slice(&block);
                    out.extend_from_slice(b"\n\n");
                }
            }
        }
        out
    }

    pub(super) fn push(&mut self, chunk: &str) -> String {
        String::from_utf8_lossy(&self.push_bytes(chunk.as_bytes())).into_owned()
    }

    pub(super) fn finish_bytes(&mut self) -> Vec<u8> {
        let mut out = self.push_bytes(&[]);
        if !self.buffer.is_empty() {
            let rest = std::mem::take(&mut self.buffer);
            match std::str::from_utf8(&rest) {
                Ok(text) => {
                    let trimmed = text.trim_end_matches(['\r', '\n']);
                    if !trimmed.trim().is_empty() {
                        out.extend_from_slice(self.rewrite_block(trimmed).as_bytes());
                    }
                }
                Err(_) => out.extend_from_slice(&rest),
            }
        }
        let indexes = self.pending.keys().copied().collect::<Vec<_>>();
        for index in indexes {
            if let Some(pending) = self.pending.remove(&index) {
                out.extend_from_slice(
                    tool_arguments_delta(index, &pending.arguments, pending.start_had_input)
                        .as_bytes(),
                );
            }
        }
        out
    }

    pub(super) fn finish(&mut self) -> String {
        String::from_utf8_lossy(&self.finish_bytes()).into_owned()
    }

    fn rewrite_block(&mut self, block: &str) -> String {
        let Some(mut data) = sse_json_data(block) else {
            return terminate_sse_block(block);
        };
        match data
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or("")
        {
            "content_block_start" => {
                let is_tool = data
                    .pointer("/content_block/type")
                    .and_then(|value| value.as_str())
                    == Some("tool_use");
                if !is_tool {
                    return terminate_sse_block(block);
                }
                let index = json_index(&data);
                let mut start_had_input = false;
                if let Some(input) = data.pointer_mut("/content_block/input") {
                    let sanitized = sanitize_tool_input(input.clone());
                    start_had_input = sanitized.as_object().is_some_and(|map| !map.is_empty());
                    *input = sanitized;
                }
                self.pending.insert(
                    index,
                    PendingToolInput {
                        arguments: String::new(),
                        start_had_input,
                    },
                );
                sse_event_named(&sse_event_name(block), &data)
            }
            "content_block_delta" => {
                let index = json_index(&data);
                let is_input = data.pointer("/delta/type").and_then(|value| value.as_str())
                    == Some("input_json_delta");
                if is_input && self.pending.contains_key(&index) {
                    if let Some(partial) = data
                        .pointer("/delta/partial_json")
                        .and_then(|value| value.as_str())
                    {
                        if let Some(pending) = self.pending.get_mut(&index) {
                            pending.arguments.push_str(partial);
                        }
                    }
                    return String::new();
                }
                terminate_sse_block(block)
            }
            "content_block_stop" => {
                let index = json_index(&data);
                let Some(pending) = self.pending.remove(&index) else {
                    return terminate_sse_block(block);
                };
                let mut out =
                    tool_arguments_delta(index, &pending.arguments, pending.start_had_input);
                out.push_str(&terminate_sse_block(block));
                out
            }
            _ => terminate_sse_block(block),
        }
    }
}

fn tool_arguments_delta(index: i64, arguments: &str, start_had_input: bool) -> String {
    if arguments.trim().is_empty() {
        return String::new();
    }
    let repaired = repair_tool_arguments(arguments);
    if repaired == "{}" && start_had_input {
        return String::new();
    }
    sse_event_named(
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

fn json_index(data: &Value) -> i64 {
    data.get("index")
        .and_then(|value| value.as_i64())
        .unwrap_or(0)
}

fn terminate_sse_block(block: &str) -> String {
    format!("{}\n\n", block.trim_end_matches(['\r', '\n']))
}

fn sse_event_name(block: &str) -> String {
    for line in block.lines() {
        if let Some(value) = line.strip_prefix("event:") {
            return value.trim().to_string();
        }
    }
    "message".to_string()
}

fn sse_json_data(block: &str) -> Option<Value> {
    let mut data = String::new();
    for line in block.lines() {
        if let Some(value) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(value.trim());
        }
    }
    if data.is_empty() {
        return None;
    }
    serde_json::from_str(&data).ok()
}

fn sse_event_named(event: &str, data: &Value) -> String {
    format!("event: {event}\ndata: {data}\n\n")
}

fn split_sse_block_bytes(buffer: &[u8]) -> Option<(Vec<u8>, usize)> {
    if let Some(index) = find_bytes(buffer, b"\r\n\r\n") {
        return Some((buffer[..index].to_vec(), index + 4));
    }
    if let Some(index) = find_bytes(buffer, b"\n\n") {
        return Some((buffer[..index].to_vec(), index + 2));
    }
    None
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn trim_code_fence(value: &str) -> &str {
    let value = value.trim();
    if !value.starts_with("```") {
        return value;
    }
    let Some(first_newline) = value.find('\n') else {
        return value;
    };
    let value = &value[first_newline + 1..];
    value
        .strip_suffix("```")
        .map(str::trim)
        .unwrap_or(value.trim())
}

fn extract_json_like(value: &str) -> Option<String> {
    let object_start = value.find('{');
    let array_start = value.find('[');
    let start = match (object_start, array_start) {
        (Some(object), Some(array)) => object.min(array),
        (Some(object), None) => object,
        (None, Some(array)) => array,
        (None, None) => return None,
    };
    let end = value.rfind('}').or_else(|| value.rfind(']'))?;
    if end <= start {
        return None;
    }
    Some(value[start..=end].to_string())
}

fn repair_balanced_json(value: String) -> Option<String> {
    let mut output = String::with_capacity(value.len() + 8);
    let mut stack = Vec::new();
    let mut in_string = false;
    let mut escaped = false;

    for ch in value.chars() {
        output.push(ch);
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }

        match ch {
            '"' => in_string = true,
            '{' => stack.push('}'),
            '[' => stack.push(']'),
            '}' | ']' => {
                if stack.last().copied() == Some(ch) {
                    stack.pop();
                }
            }
            _ => {}
        }
    }

    if in_string {
        output.push('"');
    }
    while let Some(ch) = stack.pop() {
        output.push(ch);
    }
    Some(output)
}

fn remove_trailing_commas(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;

    while let Some(ch) = chars.next() {
        if in_string {
            output.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }

        if ch == '"' {
            in_string = true;
            output.push(ch);
            continue;
        }

        if ch == ',' {
            let mut lookahead = chars.clone();
            while matches!(lookahead.peek(), Some(next) if next.is_whitespace()) {
                lookahead.next();
            }
            if matches!(lookahead.peek(), Some('}' | ']')) {
                continue;
            }
        }
        output.push(ch);
    }

    output
}

fn strip_json_comments(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    let mut in_double_string = false;
    let mut in_single_string = false;
    let mut escaped = false;

    while let Some(ch) = chars.next() {
        if in_double_string || in_single_string {
            output.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if in_double_string && ch == '"' {
                in_double_string = false;
            } else if in_single_string && ch == '\'' {
                in_single_string = false;
            }
            continue;
        }

        match ch {
            '"' => {
                in_double_string = true;
                output.push(ch);
            }
            '\'' => {
                in_single_string = true;
                output.push(ch);
            }
            '/' if chars.peek() == Some(&'/') => {
                chars.next();
                for next in chars.by_ref() {
                    if next == '\n' {
                        output.push('\n');
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut previous = '\0';
                for next in chars.by_ref() {
                    if previous == '*' && next == '/' {
                        break;
                    }
                    previous = next;
                }
            }
            _ => output.push(ch),
        }
    }

    output
}

fn quote_unquoted_object_keys(value: &str) -> String {
    let mut output = String::with_capacity(value.len() + 16);
    let chars = value.chars().collect::<Vec<_>>();
    let mut index = 0;
    let mut in_double_string = false;
    let mut in_single_string = false;
    let mut escaped = false;
    let mut expects_key = false;

    while index < chars.len() {
        let ch = chars[index];
        if in_double_string || in_single_string {
            output.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if in_double_string && ch == '"' {
                in_double_string = false;
            } else if in_single_string && ch == '\'' {
                in_single_string = false;
            }
            index += 1;
            continue;
        }

        match ch {
            '"' => {
                in_double_string = true;
                output.push(ch);
                expects_key = false;
                index += 1;
            }
            '\'' => {
                in_single_string = true;
                output.push(ch);
                expects_key = false;
                index += 1;
            }
            '{' | ',' => {
                expects_key = true;
                output.push(ch);
                index += 1;
            }
            '}' | ']' => {
                expects_key = false;
                output.push(ch);
                index += 1;
            }
            ch if expects_key && ch.is_whitespace() => {
                output.push(ch);
                index += 1;
            }
            ch if expects_key && is_identifier_start(ch) => {
                let start = index;
                index += 1;
                while index < chars.len() && is_identifier_continue(chars[index]) {
                    index += 1;
                }
                let mut lookahead = index;
                while lookahead < chars.len() && chars[lookahead].is_whitespace() {
                    lookahead += 1;
                }
                if lookahead < chars.len() && chars[lookahead] == ':' {
                    output.push('"');
                    for key_ch in &chars[start..index] {
                        output.push(*key_ch);
                    }
                    output.push('"');
                    expects_key = false;
                } else {
                    for key_ch in &chars[start..index] {
                        output.push(*key_ch);
                    }
                    expects_key = false;
                }
            }
            _ => {
                output.push(ch);
                index += 1;
            }
        }
    }

    output
}

fn normalize_single_quoted_strings(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    let mut in_double_string = false;
    let mut in_single_string = false;
    let mut escaped = false;

    while let Some(ch) = chars.next() {
        if in_double_string {
            output.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_double_string = false;
            }
            continue;
        }

        if in_single_string {
            if escaped {
                match ch {
                    '\'' => output.push('\''),
                    '"' => {
                        output.push('\\');
                        output.push('"');
                    }
                    '\\' => output.push('\\'),
                    _ => {
                        output.push('\\');
                        output.push(ch);
                    }
                }
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '\'' {
                output.push('"');
                in_single_string = false;
            } else if ch == '"' {
                output.push('\\');
                output.push('"');
            } else {
                output.push(ch);
            }
            continue;
        }

        if ch == '"' {
            in_double_string = true;
            output.push(ch);
        } else if ch == '\'' {
            in_single_string = true;
            output.push('"');
        } else {
            output.push(ch);
        }
    }

    if in_single_string {
        output.push('"');
    }
    output
}

fn insert_missing_commas_between_fields(value: &str) -> Option<String> {
    let mut output = String::with_capacity(value.len() + 8);
    let chars = value.chars().collect::<Vec<_>>();
    let mut index = 0;
    let mut changed = false;
    let mut in_string = false;
    let mut escaped = false;

    while index < chars.len() {
        let ch = chars[index];
        output.push(ch);
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            index += 1;
            continue;
        }

        if ch == '"' {
            in_string = true;
            index += 1;
            continue;
        }

        if matches!(ch, '"' | '}' | ']' | '0'..='9' | 'e' | 'E' | 'l') {
            let mut lookahead = index + 1;
            while lookahead < chars.len() && chars[lookahead].is_whitespace() {
                lookahead += 1;
            }
            if lookahead < chars.len()
                && chars[lookahead] == '"'
                && previous_non_whitespace(&chars, index) != Some(':')
            {
                output.push(',');
                changed = true;
            }
        }
        index += 1;
    }

    changed.then_some(output)
}

fn previous_non_whitespace(chars: &[char], index: usize) -> Option<char> {
    if index == 0 {
        return None;
    }
    let mut cursor = index - 1;
    loop {
        if !chars[cursor].is_whitespace() {
            return Some(chars[cursor]);
        }
        if cursor == 0 {
            return None;
        }
        cursor -= 1;
    }
}

fn is_identifier_start(ch: char) -> bool {
    ch == '_' || ch == '$' || ch.is_ascii_alphabetic()
}

fn is_identifier_continue(ch: char) -> bool {
    is_identifier_start(ch) || ch.is_ascii_digit() || ch == '-' || ch == '.'
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repairs_partial_tool_arguments() {
        assert_eq!(
            repair_tool_arguments("{\"file_path\":\"main.tex\""),
            "{\"file_path\":\"main.tex\"}"
        );
    }

    #[test]
    fn repairs_fenced_tool_arguments() {
        assert_eq!(
            repair_tool_arguments("```json\n{\"pattern\":\"FastVID\",}\n```"),
            "{\"pattern\":\"FastVID\"}"
        );
    }

    #[test]
    fn repairs_json5_style_tool_arguments_like_ccr_enhancetool() {
        let repaired: Value = serde_json::from_str(&repair_tool_arguments(
            "{file_path:'main.tex', replace_all:false,}",
        ))
        .unwrap();

        assert_eq!(
            repaired,
            json!({ "file_path": "main.tex", "replace_all": false })
        );
    }

    #[test]
    fn repairs_commented_tool_arguments() {
        let repaired: Value = serde_json::from_str(&repair_tool_arguments(
            "{\n  // target file\n  file_path: 'main.tex',\n  old_string: 'A',\n  new_string: 'B',\n}",
        ))
        .unwrap();

        assert_eq!(
            repaired,
            json!({ "file_path": "main.tex", "old_string": "A", "new_string": "B" })
        );
    }

    #[test]
    fn repairs_mixed_quote_tool_arguments() {
        let repaired: Value = serde_json::from_str(&repair_tool_arguments(
            "{\"file_path\": 'main.tex', \"pattern\": 'FastVID'}",
        ))
        .unwrap();

        assert_eq!(
            repaired,
            json!({ "file_path": "main.tex", "pattern": "FastVID" })
        );
    }

    #[test]
    fn falls_back_to_empty_object_for_unrepairable_arguments() {
        assert_eq!(repair_tool_arguments("not json at all"), "{}");
    }

    #[test]
    fn normalizes_numeric_tool_call_ids() {
        let id = normalized_tool_call_id(Some("123"));

        assert!(id.starts_with("call_"));
        assert_ne!(id, "123");
    }

    #[test]
    fn preserves_provider_tool_call_ids() {
        assert_eq!(normalized_tool_call_id(Some("call_abc")), "call_abc");
    }

    #[test]
    fn strips_empty_read_pages_argument() {
        let repaired: Value = serde_json::from_str(&repair_tool_arguments(
            r#"{"file_path":"main.tex","pages":"","limit":2000}"#,
        ))
        .unwrap();
        assert_eq!(repaired, json!({ "file_path": "main.tex", "limit": 2000 }));
        assert_eq!(
            sanitize_tool_input(json!({ "file_path": "notes.md", "pages": "   " })),
            json!({ "file_path": "notes.md" })
        );
        assert_eq!(
            sanitize_tool_input(json!({ "file_path": "paper.pdf", "pages": "1-5" })),
            json!({ "file_path": "paper.pdf", "pages": "1-5" })
        );
        assert_eq!(
            sanitize_tool_input(json!({ "file_path": "paper.pdf", "pages": 3 })),
            json!({ "file_path": "paper.pdf", "pages": "3" })
        );
        assert_eq!(
            sanitize_tool_input(json!({ "file_path": "notes.md", "pages": Value::Null })),
            json!({ "file_path": "notes.md" })
        );
        assert_eq!(
            sanitize_tool_input(json!({ "file_path": "notes.md" })),
            json!({ "file_path": "notes.md" })
        );
        assert_eq!(
            sanitize_tool_input(json!({ "file_path": "paper.pdf", "pages": "  10-20  " })),
            json!({ "file_path": "paper.pdf", "pages": "10-20" })
        );
        assert_eq!(
            sanitize_tool_input(json!({ "file_path": "paper.pdf", "pages": "0" })),
            json!({ "file_path": "paper.pdf" })
        );
    }

    #[test]
    fn read_schema_documents_that_empty_pages_is_invalid() {
        let schema = prepare_forwarded_tool_schema(
            "Read",
            json!({
                "type": "object",
                "required": ["file_path", "pages"],
                "properties": {
                    "file_path": { "type": "string" },
                    "pages": { "type": "string", "default": "", "description": "Page range" }
                }
            }),
        );
        assert!(schema["required"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item.as_str() != Some("pages")));
        assert!(schema["properties"]["pages"].get("default").is_none());
        let description = schema["properties"]["pages"]["description"]
            .as_str()
            .unwrap();
        assert!(description.contains("empty string"));
        assert!(description.contains("1-5"));
        assert!(description.contains("10-20"));

        let bash = prepare_forwarded_tool_schema(
            "Bash",
            json!({ "type": "object", "properties": { "command": { "type": "string" } } }),
        );
        assert!(bash["properties"].get("pages").is_none());
        let read_description = prepare_forwarded_tool_description("Read", "Read a file");
        assert!(read_description.contains("empty string"));
        assert_eq!(
            prepare_forwarded_tool_description("Bash", "Run a command"),
            "Run a command"
        );
    }

    #[test]
    fn passthrough_sse_strips_empty_pages_and_keeps_pdf_ranges() {
        let raw = format!(
            "event: content_block_start\ndata: {}\n\n\
             event: content_block_delta\ndata: {}\n\n\
             event: content_block_delta\ndata: {}\n\n\
             event: content_block_stop\ndata: {{\"type\":\"content_block_stop\",\"index\":0}}\n\n\
             event: content_block_start\ndata: {}\n\n\
             event: content_block_delta\ndata: {}\n\n\
             event: content_block_stop\ndata: {{\"type\":\"content_block_stop\",\"index\":1}}\n\n\
             event: content_block_delta\ndata: {{\"type\":\"content_block_delta\",\"index\":2,\"delta\":{{\"type\":\"text_delta\",\"text\":\"Hi\"}}}}\n\n",
            json!({
                "type": "content_block_start",
                "index": 0,
                "content_block": {
                    "type": "tool_use",
                    "id": "toolu_read",
                    "name": "Read",
                    "input": { "file_path": "notes.md", "pages": "" }
                }
            }),
            json!({
                "type": "content_block_delta",
                "index": 0,
                "delta": { "type": "input_json_delta", "partial_json": "{\"file_path\":\"notes.md\",\"pa" }
            }),
            json!({
                "type": "content_block_delta",
                "index": 0,
                "delta": { "type": "input_json_delta", "partial_json": "ges\":\"\",\"limit\":200}" }
            }),
            json!({
                "type": "content_block_start",
                "index": 1,
                "content_block": {
                    "type": "tool_use",
                    "id": "toolu_pdf",
                    "name": "Read",
                    "input": {}
                }
            }),
            json!({
                "type": "content_block_delta",
                "index": 1,
                "delta": { "type": "input_json_delta", "partial_json": "{\"file_path\":\"paper.pdf\",\"pages\":\"10-20\"}" }
            }),
        );

        let mut filter = AnthropicToolInputSseFilter::default();
        let mut out = String::new();
        for chunk in raw.as_bytes().chunks(19) {
            out.push_str(&filter.push(&String::from_utf8_lossy(chunk)));
        }
        out.push_str(&filter.finish());

        let read_block = out.split("toolu_pdf").next().unwrap();
        assert!(read_block.contains("notes.md"));
        assert!(!read_block.contains("pages"));
        assert!(out.contains("10-20"));
        assert!(out.contains("paper.pdf"));
        assert!(out.contains("Hi"));
        assert!(out.contains("content_block_stop"));
    }

    #[test]
    fn passthrough_sse_preserves_utf8_split_across_chunks() {
        let raw = "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"读文件\"}}\n\n";
        let bytes = raw.as_bytes();
        let split = raw.find('读').expect("character") + 1;
        let mut filter = AnthropicToolInputSseFilter::default();
        let mut out = filter.push_bytes(&bytes[..split]);
        out.extend(filter.push_bytes(&bytes[split..]));
        out.extend(filter.finish_bytes());
        let text = String::from_utf8(out).expect("utf-8");
        assert!(text.contains("读文件"));
    }

    #[test]
    fn anthropic_message_body_strips_empty_pages_only() {
        let raw = json!({
            "type": "message",
            "content": [
                {
                    "type": "tool_use",
                    "name": "Read",
                    "input": { "file_path": "a.md", "pages": "" }
                },
                {
                    "type": "tool_use",
                    "name": "Read",
                    "input": { "file_path": "paper.pdf", "pages": "3" }
                }
            ]
        })
        .to_string();
        let sanitized: Value =
            serde_json::from_str(&sanitize_anthropic_message_body(&raw)).unwrap();
        assert!(sanitized["content"][0]["input"].get("pages").is_none());
        assert_eq!(sanitized["content"][1]["input"]["pages"], "3");

        let unchanged =
            json!({ "type": "message", "content": [{ "type": "text", "text": "ok" }] }).to_string();
        assert_eq!(sanitize_anthropic_message_body(&unchanged), unchanged);
    }
}
