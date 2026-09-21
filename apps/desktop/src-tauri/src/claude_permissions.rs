use serde_json::{json, Value};

use crate::runtime::events::RuntimeRequest;
use crate::runtime::RuntimeKind;

pub const CLAUDE_TOOL_PERMISSION_METHOD: &str = "claude/can_use_tool";

#[derive(Debug, PartialEq)]
pub enum ClaudeStdoutControl {
    CanUseTool {
        request_id: String,
        runtime_request: RuntimeRequest,
        input: Value,
        suggestions: Value,
        tool_name: String,
    },
    AutoAck {
        request_id: String,
    },
    Cancelled {
        request_id: String,
    },
    NotControl,
}

pub fn user_stream_line(prompt: &str) -> String {
    let mut line = json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": prompt,
        }
    })
    .to_string();
    line.push('\n');
    line
}

pub fn classify_claude_stdout_line(
    line: &str,
    tab_id: &str,
    attempt_id: &str,
) -> ClaudeStdoutControl {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return ClaudeStdoutControl::NotControl;
    };
    match value.get("type").and_then(Value::as_str) {
        Some("control_request") => classify_control_request(&value, tab_id, attempt_id),
        Some("control_cancel_request") => value
            .get("request_id")
            .and_then(Value::as_str)
            .map(|request_id| ClaudeStdoutControl::Cancelled {
                request_id: request_id.to_string(),
            })
            .unwrap_or(ClaudeStdoutControl::NotControl),
        _ => ClaudeStdoutControl::NotControl,
    }
}

fn classify_control_request(
    value: &Value,
    tab_id: &str,
    attempt_id: &str,
) -> ClaudeStdoutControl {
    let Some(request_id) = value.get("request_id").and_then(Value::as_str) else {
        return ClaudeStdoutControl::NotControl;
    };
    let request = value.get("request").unwrap_or(&Value::Null);
    if request.get("subtype").and_then(Value::as_str) == Some("can_use_tool") {
        let tool_name = request
            .get("tool_name")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string();
        let input = request.get("input").cloned().unwrap_or(json!({}));
        let suggestions = request
            .get("permission_suggestions")
            .cloned()
            .unwrap_or(json!([]));
        let title = request
            .get("title")
            .or_else(|| request.get("display_name"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("Allow {tool_name}?"));
        return ClaudeStdoutControl::CanUseTool {
            request_id: request_id.to_string(),
            runtime_request: RuntimeRequest {
                request_id: json!(request_id),
                method: CLAUDE_TOOL_PERMISSION_METHOD.to_string(),
                runtime: RuntimeKind::Claude,
                thread_id: Some(attempt_id.to_string()),
                turn_id: Some(attempt_id.to_string()),
                tab_id: tab_id.to_string(),
                agent_run_id: request
                    .get("agent_id")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                title,
                command: tool_command_summary(&tool_name, &input),
                cwd: None,
                diff: None,
                permissions: if suggestions.is_null() {
                    None
                } else {
                    Some(suggestions.clone())
                },
                questions: vec![],
                details: input.clone(),
            },
            input,
            suggestions,
            tool_name,
        };
    }
    ClaudeStdoutControl::AutoAck {
        request_id: request_id.to_string(),
    }
}

pub fn tool_command_summary(tool_name: &str, input: &Value) -> Option<String> {
    match tool_name {
        "Bash" => input
            .get("command")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        "WebFetch" => input
            .get("url")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        "WebSearch" => input
            .get("query")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        _ => {
            let rendered = input.to_string();
            if rendered == "{}" {
                None
            } else {
                Some(rendered)
            }
        }
    }
}

pub fn control_ack_line(request_id: &str) -> String {
    control_success_line(request_id, json!({}))
}

pub fn control_allow_line(
    request_id: &str,
    input: &Value,
    session: bool,
    tool_name: &str,
    suggestions: &Value,
) -> String {
    let mut response = json!({
        "behavior": "allow",
        "updatedInput": crate::anthropic_proxy::tools::sanitize_tool_input(input.clone()),
    });
    if session {
        response["updatedPermissions"] = session_permission_updates(tool_name, suggestions);
    }
    control_success_line(request_id, response)
}

pub fn control_deny_line(request_id: &str, message: &str, interrupt: bool) -> String {
    let mut response = json!({
        "behavior": "deny",
        "message": message,
    });
    if interrupt {
        response["interrupt"] = json!(true);
    }
    control_success_line(request_id, response)
}

fn session_permission_updates(tool_name: &str, suggestions: &Value) -> Value {
    if suggestions.as_array().is_some_and(|items| !items.is_empty()) {
        return suggestions.clone();
    }
    json!([{
        "type": "addRules",
        "rules": [{ "toolName": tool_name }],
        "behavior": "allow",
        "destination": "session"
    }])
}

fn control_success_line(request_id: &str, response: Value) -> String {
    let mut line = json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": response,
        }
    })
    .to_string();
    line.push('\n');
    line
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_stream_line_wraps_prompt_as_ndjson() {
        let line = user_stream_line("hello 文件");
        assert!(line.ends_with('\n'));
        let parsed: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(parsed["type"], "user");
        assert_eq!(parsed["message"]["content"], "hello 文件");
    }

    #[test]
    fn classifies_can_use_tool_as_host_prompt() {
        let line = json!({
            "type": "control_request",
            "request_id": "req_1",
            "request": {
                "subtype": "can_use_tool",
                "tool_name": "Bash",
                "tool_use_id": "toolu_1",
                "input": { "command": "ls" }
            }
        })
        .to_string();
        match classify_claude_stdout_line(&line, "tab-a", "attempt-1") {
            ClaudeStdoutControl::CanUseTool {
                request_id,
                runtime_request,
                tool_name,
                input,
                ..
            } => {
                assert_eq!(request_id, "req_1");
                assert_eq!(tool_name, "Bash");
                assert_eq!(input["command"], "ls");
                assert_eq!(runtime_request.method, CLAUDE_TOOL_PERMISSION_METHOD);
                assert_eq!(runtime_request.command.as_deref(), Some("ls"));
                assert_eq!(runtime_request.thread_id.as_deref(), Some("attempt-1"));
                assert_eq!(runtime_request.title, "Allow Bash?");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn auto_acks_non_tool_control_requests() {
        let line = json!({
            "type": "control_request",
            "request_id": "req_init",
            "request": { "subtype": "initialize" }
        })
        .to_string();
        assert_eq!(
            classify_claude_stdout_line(&line, "tab-a", "attempt-1"),
            ClaudeStdoutControl::AutoAck {
                request_id: "req_init".into()
            }
        );
    }

    #[test]
    fn allow_response_includes_updated_input() {
        let line = control_allow_line("req_1", &json!({"command":"ls"}), false, "Bash", &json!([]));
        let parsed: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(parsed["type"], "control_response");
        assert_eq!(parsed["response"]["request_id"], "req_1");
        assert_eq!(parsed["response"]["response"]["behavior"], "allow");
        assert_eq!(
            parsed["response"]["response"]["updatedInput"]["command"],
            "ls"
        );
        assert!(parsed["response"]["response"]
            .get("permissionUpdates")
            .is_none());
    }

    #[test]
    fn session_allow_adds_permission_updates() {
        let line = control_allow_line("req_1", &json!({}), true, "WebSearch", &json!([]));
        let parsed: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(
            parsed["response"]["response"]["updatedPermissions"][0]["destination"],
            "session"
        );
        assert_eq!(
            parsed["response"]["response"]["updatedPermissions"][0]["rules"][0]["toolName"],
            "WebSearch"
        );
    }

    #[test]
    fn deny_can_interrupt_the_turn() {
        let line = control_deny_line("req_1", "User cancelled the turn", true);
        let parsed: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(parsed["response"]["response"]["behavior"], "deny");
        assert_eq!(parsed["response"]["response"]["interrupt"], true);
    }
}
