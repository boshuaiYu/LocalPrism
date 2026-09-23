use super::tools::{
    duplicate_skill_tool_call, normalized_tool_call_id, prepare_forwarded_tool_description,
    prepare_forwarded_tool_schema, repair_tool_arguments, repaired_tool_arguments_value,
    sanitize_tool_input,
};
use std::collections::HashSet;
use super::transformers::ProxyTransformerChain;
use super::OpenAiProxyCredential;
use serde_json::{json, Value};

const EXIT_TOOL_NAME: &str = "ExitTool";

pub(super) fn anthropic_to_openai_request(
    request: &Value,
    credential: &OpenAiProxyCredential,
    transformers: &ProxyTransformerChain,
) -> Result<Value, String> {
    let mut request = request.clone();
    hoist_anthropic_system_messages(&mut request);
    let request = &request;
    let mut messages = Vec::new();
    if let Some(system) = request.get("system").and_then(flatten_anthropic_content) {
        if !system.trim().is_empty() {
            let system =
                super::identity::bind_hosted_model_identity(&system, &credential.model);
            messages.push(json!({ "role": "system", "content": system }));
        }
    }

    for message in request
        .get("messages")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "Anthropic request is missing messages[]".to_string())?
    {
        append_openai_messages_for_anthropic_message(&mut messages, message);
    }
    let messages = normalize_openai_tool_message_pairs(messages);

    let mut body = json!({
        "model": credential.model,
        "messages": messages,
        "stream": false,
    });
    copy_number_field(request, &mut body, "temperature");
    copy_number_field(request, &mut body, "top_p");
    copy_number_field(request, &mut body, "top_k");
    copy_number_field(request, &mut body, "max_tokens");
    if let Some(stop) = request.get("stop_sequences") {
        body["stop"] = stop.clone();
    }

    if let Some(tools) = request.get("tools").and_then(|value| value.as_array()) {
        let converted = tools
            .iter()
            .filter_map(anthropic_tool_to_openai_tool)
            .collect::<Vec<_>>();
        if !converted.is_empty() {
            let tool_choice = if transformers.has_tooluse() {
                Value::String("required".to_string())
            } else {
                openai_tool_choice(request.get("tool_choice"))
            };
            let mut converted = converted;
            if tool_choice == Value::String("required".to_string()) {
                append_exit_tool(&mut converted);
                append_exit_tool_reminder(&mut body);
            }
            body["tools"] = Value::Array(converted);
            body["tool_choice"] = tool_choice;
        }
    }

    normalize_openai_system_messages(&mut body);
    Ok(body)
}

/// Claude Code 2.1.195+ puts `role: "system"` inside Anthropic `messages[]`
/// (skills, agent types, ToolSearch). Official Anthropic only allows
/// user/assistant there. Qwen / DeepSeek / Moonshot native Anthropic
/// adapters convert that array to a chat template and return
/// `400 System message must be at the beginning`. Fold every system-like
/// turn into the top-level `system` field before the request is forwarded
/// or converted to OpenAI.
pub(super) fn hoist_anthropic_system_messages(request: &mut Value) {
    let Some(existing) = request
        .get("messages")
        .and_then(|value| value.as_array())
        .cloned()
    else {
        return;
    };
    if !existing.iter().any(is_system_like_message) {
        return;
    }

    let mut system_parts = Vec::new();
    if let Some(system) = request.get("system").and_then(flatten_anthropic_content) {
        let system = system.trim();
        if !system.is_empty() {
            system_parts.push(system.to_string());
        }
    }

    let mut kept = Vec::with_capacity(existing.len());
    for message in existing {
        if is_system_like_message(&message) {
            if let Some(text) = flatten_anthropic_content(message.get("content").unwrap_or(&Value::Null))
            {
                let text = text.trim();
                if !text.is_empty() {
                    system_parts.push(text.to_string());
                }
            }
            continue;
        }
        kept.push(message);
    }

    request["messages"] = Value::Array(kept);
    if system_parts.is_empty() {
        if let Some(object) = request.as_object_mut() {
            object.remove("system");
        }
        return;
    }
    request["system"] = Value::String(system_parts.join("\n\n"));
}

pub(super) fn openai_to_anthropic_message(
    anthropic_request: &Value,
    openai_response: &Value,
    credential: &OpenAiProxyCredential,
) -> Result<Value, String> {
    let message = openai_response
        .pointer("/choices/0/message")
        .ok_or_else(|| "Provider response is missing choices[0].message".to_string())?;
    let mut content = Vec::new();

    if let Some(reasoning) = openai_message_thinking(message) {
        content.push(json!({ "type": "thinking", "thinking": reasoning }));
    }

    if let Some(text) = openai_message_text(message).filter(|value| !value.trim().is_empty()) {
        content.push(json!({ "type": "text", "text": text }));
    }

    if let Some(tool_calls) = message.get("tool_calls").and_then(|value| value.as_array()) {
        let mut seen_skill_calls = HashSet::new();
        for call in tool_calls {
            let function = call.get("function").unwrap_or(&Value::Null);
            let name = function
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or("unknown");
            let arguments = function
                .get("arguments")
                .and_then(|value| value.as_str())
                .unwrap_or("{}");
            if name == EXIT_TOOL_NAME {
                if let Some(response) = exit_tool_response(arguments) {
                    content.push(json!({ "type": "text", "text": response }));
                }
                continue;
            }
            let input = repaired_tool_arguments_value(arguments);
            if duplicate_skill_tool_call(&mut seen_skill_calls, name, &input) {
                continue;
            }
            let id = normalized_tool_call_id(call.get("id").and_then(|value| value.as_str()));
            content.push(json!({
                "type": "tool_use",
                "id": id,
                "name": name,
                "input": input,
            }));
        }
    }

    if content.is_empty() {
        content.push(json!({ "type": "text", "text": "" }));
    }

    let finish_reason = openai_response
        .pointer("/choices/0/finish_reason")
        .and_then(|value| value.as_str());
    let stop_reason = if content
        .iter()
        .any(|block| block.get("type").and_then(|value| value.as_str()) == Some("tool_use"))
    {
        "tool_use"
    } else {
        match finish_reason {
            Some("length") => "max_tokens",
            Some("tool_calls") if !contains_only_exit_tool(message) => "tool_use",
            _ => "end_turn",
        }
    };

    let usage = openai_response.get("usage").unwrap_or(&Value::Null);
    Ok(json!({
        "id": openai_response
            .get("id")
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("msg_{}", uuid::Uuid::new_v4().simple())),
        "type": "message",
        "role": "assistant",
        "model": anthropic_request
            .get("model")
            .and_then(|value| value.as_str())
            .unwrap_or(&credential.model),
        "content": content,
        "stop_reason": stop_reason,
        "stop_sequence": Value::Null,
        "usage": openai_usage_to_anthropic(usage),
    }))
}

fn append_openai_messages_for_anthropic_message(messages: &mut Vec<Value>, message: &Value) {
    let role = message
        .get("role")
        .and_then(|value| value.as_str())
        .unwrap_or("user");
    let content = message.get("content").unwrap_or(&Value::Null);

    if role == "assistant" {
        let (text, tool_calls, thinking) = assistant_content_to_openai(content);
        let mut openai_message = json!({
            "role": "assistant",
            "content": if text.trim().is_empty() { Value::Null } else { Value::String(text) },
        });
        if !tool_calls.is_empty() {
            openai_message["tool_calls"] = Value::Array(tool_calls);
        }
        if let Some(thinking) = thinking {
            openai_message["thinking"] = thinking;
        }
        messages.push(openai_message);
        return;
    }

    if let Some(blocks) = content.as_array() {
        let content_parts = user_content_blocks_to_openai_parts(blocks);
        if !content_parts.is_empty() {
            let content = if content_parts.len() == 1
                && content_parts[0]
                    .get("type")
                    .and_then(|value| value.as_str())
                    == Some("text")
            {
                content_parts[0]
                    .get("text")
                    .cloned()
                    .unwrap_or_else(|| json!(""))
            } else {
                Value::Array(content_parts)
            };
            messages.push(json!({ "role": role, "content": content }));
        }

        for block in blocks {
            if block.get("type").and_then(|value| value.as_str()) != Some("tool_result") {
                continue;
            }
            let tool_call_id = block
                .get("tool_use_id")
                .and_then(|value| value.as_str())
                .unwrap_or("toolu_unknown");
            let (content, image_parts) =
                tool_result_content_to_openai(block.get("content").unwrap_or(&Value::Null));
            let content = if content.trim().is_empty() && !image_parts.is_empty() {
                "Tool returned image content.".to_string()
            } else {
                content
            };
            messages.push(json!({
                "role": "tool",
                "tool_call_id": tool_call_id,
                "content": content,
            }));
            if !image_parts.is_empty() {
                let mut content_parts = vec![json!({
                    "type": "text",
                    "text": format!(
                        "Tool result for {} included image content. Use the attached image when answering.",
                        tool_call_id
                    ),
                })];
                content_parts.extend(image_parts);
                messages.push(json!({
                    "role": "user",
                    "content": content_parts,
                }));
            }
        }
        return;
    }

    let text = content
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| content.to_string());
    messages.push(json!({ "role": role, "content": text }));
}

fn user_content_blocks_to_openai_parts(blocks: &[Value]) -> Vec<Value> {
    blocks
        .iter()
        .filter_map(
            |block| match block.get("type").and_then(|value| value.as_str()) {
                Some("text") => block
                    .get("text")
                    .and_then(|value| value.as_str())
                    .filter(|value| !value.is_empty())
                    .map(|text| json!({ "type": "text", "text": text })),
                Some("image") => anthropic_image_block_to_openai_part(block),
                _ => None,
            },
        )
        .collect()
}

fn anthropic_image_block_to_openai_part(block: &Value) -> Option<Value> {
    let source = block.get("source")?;
    let url = match source.get("type").and_then(|value| value.as_str()) {
        Some("base64") => {
            let media_type = source
                .get("media_type")
                .and_then(|value| value.as_str())
                .unwrap_or("image/png");
            let data = source.get("data").and_then(|value| value.as_str())?;
            format!("data:{};base64,{}", media_type, data)
        }
        Some("url") => source
            .get("url")
            .and_then(|value| value.as_str())?
            .to_string(),
        _ => return None,
    };
    Some(json!({
        "type": "image_url",
        "image_url": {
            "url": url,
            "detail": "high",
        },
    }))
}

fn normalize_openai_tool_message_pairs(messages: Vec<Value>) -> Vec<Value> {
    let mut normalized = Vec::with_capacity(messages.len());
    let mut consumed = vec![false; messages.len()];

    for index in 0..messages.len() {
        if consumed[index] {
            continue;
        }

        let message = &messages[index];
        let tool_call_ids = openai_assistant_tool_call_ids(message);
        if !tool_call_ids.is_empty() {
            consumed[index] = true;
            normalized.push(message.clone());

            for tool_call_id in tool_call_ids {
                if let Some(tool_index) =
                    find_following_tool_message(&messages, &consumed, index + 1, &tool_call_id)
                {
                    consumed[tool_index] = true;
                    normalized.push(messages[tool_index].clone());
                } else {
                    normalized.push(json!({
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "content": "Tool result unavailable in the prior Claude Code transcript.",
                    }));
                }
            }
            continue;
        }

        consumed[index] = true;
        if openai_message_role(message) == Some("tool") {
            normalized.push(orphan_tool_message_to_user_message(message));
        } else {
            normalized.push(message.clone());
        }
    }

    normalized
}

fn openai_assistant_tool_call_ids(message: &Value) -> Vec<String> {
    if openai_message_role(message) != Some("assistant") {
        return Vec::new();
    }

    message
        .get("tool_calls")
        .and_then(|value| value.as_array())
        .map(|tool_calls| {
            tool_calls
                .iter()
                .filter_map(|tool_call| tool_call.get("id").and_then(|value| value.as_str()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn find_following_tool_message(
    messages: &[Value],
    consumed: &[bool],
    start: usize,
    tool_call_id: &str,
) -> Option<usize> {
    for index in start..messages.len() {
        if consumed[index] {
            continue;
        }
        let message = &messages[index];
        if openai_message_role(message) == Some("assistant") {
            break;
        }
        if openai_tool_message_id(message) == Some(tool_call_id) {
            return Some(index);
        }
    }
    None
}

fn orphan_tool_message_to_user_message(message: &Value) -> Value {
    let tool_call_id = openai_tool_message_id(message).unwrap_or("unknown");
    let content = message
        .get("content")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| {
            message
                .get("content")
                .cloned()
                .unwrap_or(Value::Null)
                .to_string()
        });

    json!({
        "role": "user",
        "content": format!("Tool result for {}:\n{}", tool_call_id, content),
    })
}

fn openai_message_role(message: &Value) -> Option<&str> {
    message.get("role").and_then(|value| value.as_str())
}

fn is_system_like_message(message: &Value) -> bool {
    matches!(
        openai_message_role(message).map(|role| role.to_ascii_lowercase()).as_deref(),
        Some("system") | Some("developer")
    )
}

fn openai_tool_message_id(message: &Value) -> Option<&str> {
    if openai_message_role(message) != Some("tool") {
        return None;
    }
    message.get("tool_call_id").and_then(|value| value.as_str())
}

fn flatten_anthropic_content(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }

    value.as_array().map(|blocks| {
        blocks
            .iter()
            .filter_map(|block| {
                block
                    .get("text")
                    .and_then(|value| value.as_str())
                    .or_else(|| block.get("content").and_then(|value| value.as_str()))
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    })
}

fn assistant_content_to_openai(content: &Value) -> (String, Vec<Value>, Option<Value>) {
    let Some(blocks) = content.as_array() else {
        return (
            content
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| content.to_string()),
            Vec::new(),
            None,
        );
    };

    let mut text = Vec::new();
    let mut tool_calls = Vec::new();
    let mut thinking = None;
    for block in blocks {
        match block.get("type").and_then(|value| value.as_str()) {
            Some("text") => {
                if let Some(value) = block.get("text").and_then(|value| value.as_str()) {
                    text.push(value);
                }
            }
            Some("tool_use") => {
                let id = block
                    .get("id")
                    .and_then(|value| value.as_str())
                    .unwrap_or("toolu_unknown");
                let name = block
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or("unknown");
                let input =
                    sanitize_tool_input(block.get("input").cloned().unwrap_or_else(|| json!({})));
                tool_calls.push(json!({
                    "id": id,
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": input.to_string(),
                    },
                }));
            }
            Some("thinking") => {
                if let Some(value) = block.get("thinking").and_then(|value| value.as_str()) {
                    let mut thinking_value = json!({ "content": value });
                    if let Some(signature) = block.get("signature").and_then(|value| value.as_str())
                    {
                        thinking_value["signature"] = Value::String(signature.to_string());
                    }
                    thinking = Some(thinking_value);
                }
            }
            _ => {}
        }
    }

    (text.join("\n\n"), tool_calls, thinking)
}

fn tool_result_content_to_openai(content: &Value) -> (String, Vec<Value>) {
    if let Some(text) = content.as_str() {
        return (text.to_string(), Vec::new());
    }
    if let Some(blocks) = content.as_array() {
        let mut text = Vec::new();
        let mut image_parts = Vec::new();
        for block in blocks {
            if let Some(value) = block
                .get("text")
                .and_then(|value| value.as_str())
                .or_else(|| block.get("content").and_then(|value| value.as_str()))
            {
                text.push(value);
                continue;
            }
            if block.get("type").and_then(|value| value.as_str()) == Some("image") {
                if let Some(part) = anthropic_image_block_to_openai_part(block) {
                    image_parts.push(part);
                }
            }
        }
        return (text.join("\n\n"), image_parts);
    }
    (content.to_string(), Vec::new())
}

fn anthropic_tool_to_openai_tool(tool: &Value) -> Option<Value> {
    let name = tool.get("name")?.as_str()?;
    let description = prepare_forwarded_tool_description(
        name,
        tool.get("description")
            .and_then(|value| value.as_str())
            .unwrap_or_default(),
    );
    let parameters = prepare_forwarded_tool_schema(
        name,
        tool.get("input_schema")
            .cloned()
            .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
    );

    Some(json!({
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": parameters,
        },
    }))
}

fn append_exit_tool(tools: &mut Vec<Value>) {
    if tools.iter().any(|tool| {
        tool.pointer("/function/name")
            .and_then(|value| value.as_str())
            == Some(EXIT_TOOL_NAME)
    }) {
        return;
    }
    tools.push(json!({
        "type": "function",
        "function": {
            "name": EXIT_TOOL_NAME,
            "description": "Use this when tool mode is active and no remaining tool call is needed. This is the valid way to exit tool mode with a final answer.",
            "parameters": {
                "type": "object",
                "properties": {
                    "response": {
                        "type": "string",
                        "description": "Final response to show the user exactly as written."
                    }
                },
                "required": ["response"]
            }
        }
    }));
}

/// Strict chat templates (Qwen, vLLM, SenseNova, NVIDIA) reject a request
/// unless every system turn is folded into `messages[0]`. Claude Code
/// 2.1.195+ puts extra `role: "system"` items inside `messages` (skills,
/// agent types, tool search), and the tool-mode reminder is another system
/// turn. Either one becomes `400 System message must be at the beginning`.
pub(super) fn normalize_openai_system_messages(body: &mut Value) {
    let Some(existing) = body
        .get("messages")
        .and_then(|value| value.as_array())
        .cloned()
    else {
        return;
    };
    body["messages"] = Value::Array(coalesce_system_messages(existing));
}

fn coalesce_system_messages(messages: Vec<Value>) -> Vec<Value> {
    let system_count = messages.iter().filter(|message| is_system_like_message(message)).count();
    let already_leading = messages.first().is_some_and(is_system_like_message);
    if system_count == 0 || (system_count == 1 && already_leading) {
        return messages;
    }

    let mut system_parts = Vec::new();
    let mut rest = Vec::with_capacity(messages.len());
    for message in messages {
        if is_system_like_message(&message) {
            if let Some(text) = openai_message_text(&message) {
                let text = text.trim();
                if !text.is_empty() {
                    system_parts.push(text.to_string());
                }
            }
            continue;
        }
        rest.push(message);
    }

    if system_parts.is_empty() {
        return rest;
    }

    let mut coalesced = Vec::with_capacity(rest.len() + 1);
    coalesced.push(json!({
        "role": "system",
        "content": system_parts.join("\n\n"),
    }));
    coalesced.extend(rest);
    coalesced
}

fn append_exit_tool_reminder(body: &mut Value) {
    let Some(messages) = body
        .get_mut("messages")
        .and_then(|value| value.as_array_mut())
    else {
        return;
    };
    messages.push(json!({
        "role": "system",
        "content": "<system-reminder>Tool mode is active. The user expects you to proactively execute the most suitable tool to help complete the task. Before invoking a tool, carefully evaluate whether it matches the current task. If no available tool is appropriate, or the task is complete, call ExitTool with the final response instead of inventing another tool call.</system-reminder>",
    }));
}

fn openai_tool_choice(choice: Option<&Value>) -> Value {
    let Some(choice) = choice else {
        return Value::String("auto".to_string());
    };
    match choice.get("type").and_then(|value| value.as_str()) {
        Some("auto") => Value::String("auto".to_string()),
        Some("any") => Value::String("required".to_string()),
        Some("tool") => {
            let name = choice
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            json!({
                "type": "function",
                "function": { "name": name },
            })
        }
        _ => Value::String("auto".to_string()),
    }
}

fn copy_number_field(source: &Value, target: &mut Value, key: &str) {
    if let Some(value) = source.get(key).filter(|value| value.is_number()) {
        target[key] = value.clone();
    }
}

fn openai_message_text(message: &Value) -> Option<String> {
    let content = message.get("content")?;
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    content.as_array().map(|parts| {
        parts
            .iter()
            .filter_map(|part| {
                part.get("text")
                    .and_then(|value| value.as_str())
                    .or_else(|| {
                        if part.get("type").and_then(|value| value.as_str()) == Some("text") {
                            part.get("content").and_then(|value| value.as_str())
                        } else {
                            None
                        }
                    })
            })
            .collect::<Vec<_>>()
            .join("\n")
    })
}

fn openai_message_thinking(message: &Value) -> Option<String> {
    message
        .get("reasoning_content")
        .or_else(|| message.get("reasoning"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            message
                .get("thinking")
                .and_then(|value| {
                    value
                        .get("content")
                        .and_then(|content| content.as_str())
                        .or_else(|| value.as_str())
                })
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string)
        })
}

fn exit_tool_response(arguments: &str) -> Option<String> {
    let repaired = repair_tool_arguments(arguments);
    serde_json::from_str::<Value>(&repaired)
        .ok()
        .and_then(|value| {
            value
                .get("response")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        })
        .filter(|value| !value.trim().is_empty())
}

fn contains_only_exit_tool(message: &Value) -> bool {
    let Some(tool_calls) = message.get("tool_calls").and_then(|value| value.as_array()) else {
        return false;
    };
    !tool_calls.is_empty()
        && tool_calls.iter().all(|call| {
            call.pointer("/function/name")
                .and_then(|value| value.as_str())
                == Some(EXIT_TOOL_NAME)
        })
}

fn openai_usage_to_anthropic(usage: &Value) -> Value {
    let cache = super::usage::openai_cache_read_tokens(usage);
    let input = super::usage::exclusive_openai_input_tokens(
        super::usage::usage_token(
            usage,
            &["prompt_tokens", "input_tokens", "prompt_token_count"],
        ),
        cache,
    );
    json!({
        "input_tokens": input,
        "output_tokens": super::usage::usage_token(
            usage,
            &["completion_tokens", "output_tokens", "completion_token_count"],
        ),
        "cache_read_input_tokens": cache,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn credential() -> OpenAiProxyCredential {
        OpenAiProxyCredential {
            api_key: "sk-test".to_string(),
            base_url: "https://api.example.com/v1".to_string(),
            model: "qwen-test".to_string(),
            transformers: Vec::new(),
            model_transformers: Vec::new(),
        }
    }

    fn transformers(names: &[&str]) -> ProxyTransformerChain {
        ProxyTransformerChain::from_names(names)
    }

    #[test]
    fn preserves_anthropic_image_blocks_as_openai_image_url_parts() {
        let request = json!({
            "messages": [{
                "role": "user",
                "content": [
                    { "type": "text", "text": "what is this?" },
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/png",
                            "data": "abcd"
                        }
                    }
                ]
            }]
        });

        let converted =
            anthropic_to_openai_request(&request, &credential(), &transformers(&[])).unwrap();

        assert_eq!(converted["messages"][0]["content"][0]["type"], "text");
        assert_eq!(converted["messages"][0]["content"][1]["type"], "image_url");
        assert_eq!(
            converted["messages"][0]["content"][1]["image_url"]["url"],
            "data:image/png;base64,abcd"
        );
        assert_eq!(
            converted["messages"][0]["content"][1]["image_url"]["detail"],
            "high"
        );
    }

    #[test]
    fn preserves_tool_result_images_as_follow_up_user_image_parts() {
        let request = json!({
            "messages": [
                {
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": "toolu_read_image",
                        "name": "Read",
                        "input": { "file_path": "attachments/figure.png" }
                    }]
                },
                {
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "toolu_read_image",
                        "content": [
                            { "type": "text", "text": "Image read successfully." },
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": "image/png",
                                    "data": "abcd"
                                }
                            }
                        ]
                    }]
                }
            ]
        });

        let converted =
            anthropic_to_openai_request(&request, &credential(), &transformers(&[])).unwrap();

        assert_eq!(converted["messages"][0]["role"], "assistant");
        assert_eq!(converted["messages"][1]["role"], "tool");
        assert_eq!(converted["messages"][1]["tool_call_id"], "toolu_read_image");
        assert_eq!(
            converted["messages"][1]["content"],
            "Image read successfully."
        );
        assert_eq!(converted["messages"][2]["role"], "user");
        assert_eq!(converted["messages"][2]["content"][0]["type"], "text");
        assert_eq!(converted["messages"][2]["content"][1]["type"], "image_url");
        assert_eq!(
            converted["messages"][2]["content"][1]["image_url"]["url"],
            "data:image/png;base64,abcd"
        );
        assert_eq!(
            converted["messages"][2]["content"][1]["image_url"]["detail"],
            "high"
        );
    }

    #[test]
    fn preserves_assistant_thinking_for_provider_context() {
        let request = json!({
            "messages": [{
                "role": "assistant",
                "content": [
                    {
                        "type": "thinking",
                        "thinking": "I inspected the files.",
                        "signature": "sig_1"
                    },
                    {
                        "type": "text",
                        "text": "Done."
                    }
                ]
            }]
        });

        let converted =
            anthropic_to_openai_request(&request, &credential(), &transformers(&[])).unwrap();

        assert_eq!(
            converted["messages"][0]["thinking"]["content"],
            "I inspected the files."
        );
        assert_eq!(converted["messages"][0]["thinking"]["signature"], "sig_1");
    }

    #[test]
    fn adds_exit_tool_when_tool_choice_requires_a_tool() {
        let request = json!({
            "messages": [{ "role": "user", "content": "finish" }],
            "tool_choice": { "type": "any" },
            "tools": [{
                "name": "Read",
                "description": "Read a file",
                "input_schema": { "type": "object" }
            }]
        });

        let converted =
            anthropic_to_openai_request(&request, &credential(), &transformers(&[])).unwrap();
        let tool_names = converted["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| {
                tool.pointer("/function/name")
                    .and_then(|value| value.as_str())
            })
            .collect::<Vec<_>>();

        assert!(tool_names.contains(&"Read"));
        assert!(tool_names.contains(&EXIT_TOOL_NAME));
        assert_eq!(converted["tool_choice"], "required");
    }

    #[test]
    fn tooluse_transformer_forces_exit_tool_like_ccr() {
        let request = json!({
            "messages": [{ "role": "user", "content": "finish" }],
            "tools": [{
                "name": "Read",
                "description": "Read a file",
                "input_schema": { "type": "object" }
            }]
        });

        let converted =
            anthropic_to_openai_request(&request, &credential(), &transformers(&["tooluse"]))
                .unwrap();
        let tool_names = converted["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| {
                tool.pointer("/function/name")
                    .and_then(|value| value.as_str())
            })
            .collect::<Vec<_>>();

        assert_eq!(converted["tool_choice"], "required");
        assert!(tool_names.contains(&"Read"));
        assert!(tool_names.contains(&EXIT_TOOL_NAME));
        let messages = converted["messages"].as_array().unwrap();
        assert_eq!(messages[0]["role"], "system");
        assert!(messages[0]["content"]
            .as_str()
            .unwrap()
            .contains("Tool mode is active"));
        assert!(messages
            .iter()
            .skip(1)
            .all(|message| message.get("role").and_then(|value| value.as_str()) != Some("system")));
    }

    #[test]
    fn merges_mid_transcript_system_messages_into_the_leading_prompt() {
        let request = json!({
            "system": "You are a LaTeX assistant.",
            "messages": [
                { "role": "user", "content": "Write a section." },
                { "role": "system", "content": "Available agent types: writer, reviewer." },
                { "role": "assistant", "content": "Drafting." },
                { "role": "system", "content": [{ "type": "text", "text": "ToolSearch context." }] }
            ]
        });

        let converted =
            anthropic_to_openai_request(&request, &credential(), &transformers(&[])).unwrap();
        let messages = converted["messages"].as_array().unwrap();

        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["role"], "system");
        let system = messages[0]["content"].as_str().unwrap();
        assert!(system.contains("You are a LaTeX assistant."));
        assert!(system.contains("Available agent types: writer, reviewer."));
        assert!(system.contains("ToolSearch context."));
        assert!(system.find("LaTeX").unwrap() < system.find("Available agent").unwrap());
        assert!(system.find("Available agent").unwrap() < system.find("ToolSearch").unwrap());
        assert_eq!(messages[1]["role"], "user");
        assert_eq!(messages[2]["role"], "assistant");
        assert!(messages
            .iter()
            .skip(1)
            .all(|message| message.get("role").and_then(|value| value.as_str()) != Some("system")));
    }

    #[test]
    fn moves_interleaved_system_message_away_from_tool_results() {
        let request = json!({
            "system": "Be precise.",
            "messages": [
                {
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "Read",
                        "input": { "file_path": "main.tex" }
                    }]
                },
                { "role": "system", "content": "Skill reminder." },
                {
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "toolu_1",
                        "content": "file text"
                    }]
                }
            ]
        });

        let converted =
            anthropic_to_openai_request(&request, &credential(), &transformers(&[])).unwrap();
        let messages = converted["messages"].as_array().unwrap();

        assert_eq!(messages[0]["role"], "system");
        let system = messages[0]["content"].as_str().unwrap();
        assert!(system.contains("Be precise."));
        assert!(system.contains("Skill reminder."));
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[2]["role"], "tool");
        assert_eq!(messages[2]["tool_call_id"], "toolu_1");
        assert_eq!(messages[2]["content"], "file text");
    }

    #[test]
    fn hoists_inline_anthropic_system_messages_before_forwarding() {
        let mut request = json!({
            "system": "You are a LaTeX assistant.",
            "messages": [
                { "role": "user", "content": "Write a section." },
                { "role": "system", "content": "Available agent types: writer." },
                { "role": "assistant", "content": "Drafting." },
                { "role": "developer", "content": [{ "type": "text", "text": "ToolSearch context." }] }
            ]
        });

        hoist_anthropic_system_messages(&mut request);

        assert_eq!(
            request["system"],
            "You are a LaTeX assistant.\n\nAvailable agent types: writer.\n\nToolSearch context."
        );
        let messages = request["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[1]["role"], "assistant");
    }

    #[test]
    fn leaves_anthropic_payloads_without_inline_system_alone() {
        let mut request = json!({
            "system": [{ "type": "text", "text": "Keep this array." }],
            "messages": [{ "role": "user", "content": "Hi" }]
        });
        let before = request.clone();
        hoist_anthropic_system_messages(&mut request);
        assert_eq!(request, before);
    }

    #[test]
    fn converts_exit_tool_response_to_final_text() {
        let request = json!({ "model": "claude-sonnet-4" });
        let response = json!({
            "id": "chatcmpl_1",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call_exit",
                        "type": "function",
                        "function": {
                            "name": "ExitTool",
                            "arguments": "{\"response\":\"done\"}"
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": { "prompt_tokens": 5, "completion_tokens": 2 }
        });

        let converted = openai_to_anthropic_message(&request, &response, &credential()).unwrap();

        assert_eq!(converted["stop_reason"], "end_turn");
        assert_eq!(converted["content"][0]["type"], "text");
        assert_eq!(converted["content"][0]["text"], "done");
    }

    #[test]
    fn splits_inclusive_openai_usage_for_anthropic_meter() {
        let request = json!({ "model": "gpt-5.6-luna" });
        let response = json!({
            "id": "chatcmpl_1",
            "choices": [{
                "message": { "role": "assistant", "content": "ok" },
                "finish_reason": "stop"
            }],
            "usage": {
                "prompt_tokens": 119881,
                "completion_tokens": 7011,
                "prompt_tokens_details": { "cached_tokens": 53760 }
            }
        });
        let converted = openai_to_anthropic_message(&request, &response, &credential()).unwrap();
        assert_eq!(converted["usage"]["input_tokens"], 66121);
        assert_eq!(converted["usage"]["output_tokens"], 7011);
        assert_eq!(converted["usage"]["cache_read_input_tokens"], 53760);
    }

    #[test]
    fn collapses_identical_skill_tool_calls() {
        let request = json!({ "model": "gpt-6-luna" });
        let response = json!({
            "id": "chatcmpl_1",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": { "name": "Skill", "arguments": "{\"skill\":\"init\"}" }
                        },
                        {
                            "id": "call_2",
                            "type": "function",
                            "function": { "name": "Skill", "arguments": "{\"command\":\"/init\"}" }
                        },
                        {
                            "id": "call_3",
                            "type": "function",
                            "function": { "name": "Skill", "arguments": "{\"skill\":\"init\"}" }
                        },
                        {
                            "id": "call_4",
                            "type": "function",
                            "function": { "name": "Skill", "arguments": "{\"skill\":\"init\"}" }
                        },
                        {
                            "id": "call_5",
                            "type": "function",
                            "function": { "name": "Skill", "arguments": "{\"skill\":\"init\"}" }
                        },
                        {
                            "id": "call_read",
                            "type": "function",
                            "function": { "name": "Read", "arguments": "{\"file_path\":\"main.tex\"}" }
                        }
                    ]
                },
                "finish_reason": "tool_calls"
            }]
        });
        let converted = openai_to_anthropic_message(&request, &response, &credential()).unwrap();
        let content = converted["content"].as_array().unwrap();
        let names: Vec<_> = content
            .iter()
            .filter(|block| block["type"] == "tool_use")
            .map(|block| block["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["Skill", "Read"]);
        assert_eq!(content[0]["input"]["skill"], "init");
    }
}
