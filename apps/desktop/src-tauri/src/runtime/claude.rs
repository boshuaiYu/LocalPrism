use serde_json::Value;

use super::events::{AgentRun, AgentRunStatus, RuntimeEvent, RuntimeEventEnvelope};
use super::{RuntimeAccount, RuntimeCapabilities, RuntimeKind, RuntimeModel};

pub fn account_from_status(status: crate::claude::ClaudeStatus) -> RuntimeAccount {
    RuntimeAccount {
        runtime: RuntimeKind::Claude,
        installed: status.installed,
        authenticated: status.authenticated,
        version: status.version,
        account_label: status.account_email,
        auth_mode: Some(status.provider_kind),
        capabilities: RuntimeCapabilities {
            models: true,
            skills: true,
            custom_agents: true,
            subagents: true,
            approvals: true,
        },
        error: None,
    }
}

pub fn models_from_status(_status: &crate::claude::ClaudeStatus) -> Vec<RuntimeModel> {
    // The Claude Code CLI always exposes the sonnet/opus/haiku/opusplan aliases
    // regardless of which provider (including openai-compatible) backs it, so
    // the picker catalog must never collapse to a single configured model.
    [
        ("sonnet", "Sonnet", "Fast, efficient for most tasks", false),
        ("opus", "Opus", "Most capable, complex reasoning", true),
        ("haiku", "Haiku", "Fastest, simple tasks", false),
        (
            "opusplan",
            "OpusPlan",
            "Opus for planning, Sonnet for execution",
            false,
        ),
    ]
    .into_iter()
    .map(|(id, display_name, description, is_default)| RuntimeModel {
        runtime: RuntimeKind::Claude,
        id: id.into(),
        display_name: display_name.into(),
        description: Some(description.into()),
        reasoning_efforts: Vec::new(),
        default_reasoning_effort: None,
        input_modalities: vec!["text".into(), "image".into()],
        is_default,
    })
    .collect()
}

/// Maps Claude stream-json Agent/Task tool lifecycle into normalized runtime events.
#[derive(Default)]
pub struct ClaudeAgentMapper {
    session_id: Option<String>,
    sequence: u64,
    /// tool_use id -> discovered run snapshot
    active: std::collections::HashMap<String, AgentRun>,
}

impl ClaudeAgentMapper {
    pub fn ingest_line(
        &mut self,
        line: &str,
        window_label: &str,
        tab_id: &str,
        attempt_id: &str,
    ) -> Vec<RuntimeEventEnvelope> {
        let Ok(msg) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        self.ingest_message(&msg, window_label, tab_id, attempt_id)
    }

    pub fn ingest_message(
        &mut self,
        msg: &Value,
        window_label: &str,
        tab_id: &str,
        attempt_id: &str,
    ) -> Vec<RuntimeEventEnvelope> {
        if let Some(session_id) = msg.get("session_id").and_then(Value::as_str) {
            if !session_id.is_empty() {
                self.session_id = Some(session_id.to_owned());
            }
        }

        let msg_type = msg.get("type").and_then(Value::as_str).unwrap_or("");
        match msg_type {
            "assistant" => self.map_assistant(msg, window_label, tab_id, attempt_id),
            "user" => self.map_user_tool_results(msg, window_label, tab_id, attempt_id),
            "progress" | "system" => self.map_progress(msg, window_label, tab_id, attempt_id),
            _ => Vec::new(),
        }
    }

    fn map_assistant(
        &mut self,
        msg: &Value,
        window_label: &str,
        tab_id: &str,
        attempt_id: &str,
    ) -> Vec<RuntimeEventEnvelope> {
        let content = msg
            .pointer("/message/content")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let now = unix_ms();
        let root = self
            .session_id
            .clone()
            .unwrap_or_else(|| format!("claude:{tab_id}"));
        let mut events = Vec::new();

        for block in content {
            let block_type = block.get("type").and_then(Value::as_str).unwrap_or("");
            if block_type != "tool_use" {
                continue;
            }
            let name = block.get("name").and_then(Value::as_str).unwrap_or("");
            if !is_agent_tool(name) {
                continue;
            }
            let Some(tool_id) = block.get("id").and_then(Value::as_str) else {
                continue;
            };
            let input = block.get("input").cloned().unwrap_or(Value::Null);
            let agent_name = first_string(&input, &["description", "subagent_type", "agent"])
                .unwrap_or_else(|| "subagent".into());
            let agent_role = first_string(&input, &["subagent_type", "agent"]);
            let model = first_string(&input, &["model"]);
            let activity = Some("running".to_string());
            let run = AgentRun {
                id: tool_id.to_owned(),
                parent_id: Some(root.clone()),
                root_conversation_id: root.clone(),
                runtime: RuntimeKind::Claude,
                agent_name: sanitize_visible(&agent_name),
                agent_role: agent_role.map(|value| sanitize_visible(&value)),
                model: model.map(|value| sanitize_visible(&value)),
                status: AgentRunStatus::Running,
                started_at: now,
                completed_at: None,
                activity,
                summary: None,
                error: None,
                transcript_available: false,
            };
            self.active.insert(tool_id.to_owned(), run.clone());
            events.push(self.envelope(
                window_label,
                tab_id,
                attempt_id,
                RuntimeEvent::SubagentDiscovered { run },
            ));
        }
        events
    }

    fn map_user_tool_results(
        &mut self,
        msg: &Value,
        window_label: &str,
        tab_id: &str,
        attempt_id: &str,
    ) -> Vec<RuntimeEventEnvelope> {
        let content = msg
            .pointer("/message/content")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let now = unix_ms();
        let mut events = Vec::new();

        for block in content {
            let block_type = block.get("type").and_then(Value::as_str).unwrap_or("");
            if block_type != "tool_result" {
                continue;
            }
            let Some(tool_id) = block
                .get("tool_use_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
            else {
                continue;
            };
            let Some(existing) = self.active.get(&tool_id).cloned() else {
                continue;
            };
            let is_error = block
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let summary = extract_tool_result_text(&block);
            let mut run = existing;
            run.status = if is_error {
                AgentRunStatus::Failed
            } else {
                AgentRunStatus::Completed
            };
            run.completed_at = Some(now);
            run.activity = Some(if is_error { "failed" } else { "completed" }.into());
            run.summary = summary.as_ref().map(|value| sanitize_visible(value));
            if is_error {
                run.error = summary.map(|value| sanitize_visible(&value));
            }
            run.transcript_available = false;
            self.active.insert(tool_id, run.clone());
            events.push(self.envelope(
                window_label,
                tab_id,
                attempt_id,
                RuntimeEvent::SubagentStatusChanged { run },
            ));
        }
        events
    }

    fn map_progress(
        &mut self,
        msg: &Value,
        window_label: &str,
        tab_id: &str,
        attempt_id: &str,
    ) -> Vec<RuntimeEventEnvelope> {
        let subtype = msg.get("subtype").and_then(Value::as_str).unwrap_or("");
        let tool_id = msg
            .get("parent_tool_use_id")
            .or_else(|| msg.get("tool_use_id"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let Some(tool_id) = tool_id else {
            return Vec::new();
        };
        let Some(existing) = self.active.get(&tool_id).cloned() else {
            return Vec::new();
        };
        if matches!(
            existing.status,
            AgentRunStatus::Completed | AgentRunStatus::Failed | AgentRunStatus::Cancelled
        ) {
            return Vec::new();
        }
        let activity = msg
            .get("data")
            .and_then(|data| first_string(data, &["message", "status", "type"]))
            .or_else(|| {
                if subtype.is_empty() {
                    None
                } else {
                    Some(subtype.to_owned())
                }
            });
        let Some(activity) = activity else {
            return Vec::new();
        };
        let mut run = existing;
        run.activity = Some(sanitize_visible(&activity));
        self.active.insert(tool_id, run.clone());
        vec![self.envelope(
            window_label,
            tab_id,
            attempt_id,
            RuntimeEvent::SubagentStatusChanged { run },
        )]
    }

    fn envelope(
        &mut self,
        window_label: &str,
        tab_id: &str,
        attempt_id: &str,
        event: RuntimeEvent,
    ) -> RuntimeEventEnvelope {
        self.sequence = self.sequence.wrapping_add(1);
        RuntimeEventEnvelope {
            runtime: RuntimeKind::Claude,
            window_label: window_label.to_owned(),
            tab_id: tab_id.to_owned(),
            attempt_id: attempt_id.to_owned(),
            session_id: self.session_id.clone(),
            turn_id: None,
            sequence: self.sequence,
            event,
        }
    }
}

fn is_agent_tool(name: &str) -> bool {
    matches!(name, "Agent" | "Task")
}

fn first_string(value: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(Value::as_str) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_owned());
            }
        }
    }
    None
}

fn extract_tool_result_text(block: &Value) -> Option<String> {
    match block.get("content") {
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.chars().take(400).collect())
            }
        }
        Some(Value::Array(parts)) => {
            let mut chunks = Vec::new();
            for part in parts {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        chunks.push(trimmed);
                    }
                }
            }
            if chunks.is_empty() {
                None
            } else {
                Some(chunks.join("\n").chars().take(400).collect())
            }
        }
        _ => None,
    }
}

fn sanitize_visible(value: &str) -> String {
    value
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::{RuntimeCapabilities, RuntimeKind};
    use serde_json::json;

    #[test]
    fn maps_fully_populated_claude_status_to_the_shared_account_boundary() {
        let status = crate::claude::ClaudeStatus {
            installed: true,
            authenticated: true,
            binary_path: Some("C:/tools/claude.exe".into()),
            version: Some("2.1.0".into()),
            provider_kind: "openai-compatible".into(),
            account_email: Some("writer@example.com".into()),
            provider_model: Some("claude-sonnet-4".into()),
            provider_base_url: Some("https://provider.example/v1".into()),
            claude_provider_configured: true,
            missing_git: true,
        };

        let account = account_from_status(status);

        assert_eq!(account.runtime, RuntimeKind::Claude);
        assert!(account.installed);
        assert!(account.authenticated);
        assert_eq!(account.version.as_deref(), Some("2.1.0"));
        assert_eq!(account.account_label.as_deref(), Some("writer@example.com"));
        assert_eq!(account.auth_mode.as_deref(), Some("openai-compatible"));
        assert_eq!(
            account.capabilities,
            RuntimeCapabilities {
                models: true,
                skills: true,
                custom_agents: true,
                subagents: true,
                approvals: true,
            }
        );
        assert_eq!(account.error, None);

        let value = serde_json::to_value(account).unwrap();
        assert_eq!(value["authMode"], "openai-compatible");
        assert_eq!(value["accountLabel"], "writer@example.com");

        for provider_only_field in [
            "binaryPath",
            "providerModel",
            "providerBaseUrl",
            "claudeProviderConfigured",
            "missingGit",
        ] {
            assert!(
                value.get(provider_only_field).is_none(),
                "{provider_only_field} must not cross the shared runtime boundary"
            );
        }
    }

    #[test]
    fn account_and_models_claude_code_keeps_the_existing_alias_catalog() {
        let status = crate::claude::ClaudeStatus {
            installed: true,
            authenticated: true,
            binary_path: None,
            version: Some("2.1.0".into()),
            provider_kind: "claude-code".into(),
            account_email: None,
            provider_model: None,
            provider_base_url: None,
            claude_provider_configured: false,
            missing_git: false,
        };

        let models = models_from_status(&status);

        assert_eq!(
            models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec!["sonnet", "opus", "haiku", "opusplan"]
        );
        assert!(models
            .iter()
            .all(|model| model.runtime == RuntimeKind::Claude));
        assert!(models.iter().all(|model| !model.id.starts_with("gpt-")));
    }

    #[test]
    fn account_and_models_openai_compatible_keeps_the_claude_alias_catalog() {
        let status = crate::claude::ClaudeStatus {
            installed: true,
            authenticated: true,
            binary_path: None,
            version: None,
            provider_kind: "openai-compatible".into(),
            account_email: None,
            provider_model: Some("deepseek-chat".into()),
            provider_base_url: Some("https://api.deepseek.com/anthropic".into()),
            claude_provider_configured: true,
            missing_git: false,
        };

        let models = models_from_status(&status);

        assert_eq!(
            models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec!["sonnet", "opus", "haiku", "opusplan"]
        );
        assert!(models
            .iter()
            .all(|model| model.runtime == RuntimeKind::Claude));
        assert!(models.iter().all(|model| model.id != "deepseek-chat"));
    }

    #[test]
    fn maps_agent_and_task_lifecycle_with_stable_ids_and_no_transcript() {
        let fixture = include_str!("../../tests/fixtures/claude-agent-events.jsonl");
        let mut mapper = ClaudeAgentMapper::default();
        let mut envelopes = Vec::new();
        for line in fixture.lines().filter(|line| !line.trim().is_empty()) {
            envelopes.extend(mapper.ingest_line(line, "main", "tab-1", "tab-1:1"));
        }

        assert!(envelopes.len() >= 3);
        let discovered = envelopes
            .iter()
            .find_map(|envelope| match &envelope.event {
                RuntimeEvent::SubagentDiscovered { run } if run.id == "toolu_agent_1" => Some(run),
                _ => None,
            })
            .expect("Agent discovery");
        assert_eq!(discovered.parent_id.as_deref(), Some("session-root"));
        assert_eq!(discovered.root_conversation_id, "session-root");
        assert_eq!(discovered.agent_role.as_deref(), Some("general-purpose"));
        assert!(!discovered.transcript_available);
        assert_eq!(discovered.status, AgentRunStatus::Running);

        let completed = envelopes
            .iter()
            .rev()
            .find_map(|envelope| match &envelope.event {
                RuntimeEvent::SubagentStatusChanged { run } if run.id == "toolu_agent_1" => {
                    Some(run)
                }
                _ => None,
            })
            .expect("Agent completion");
        assert_eq!(completed.status, AgentRunStatus::Completed);
        assert!(!completed.transcript_available);
        assert!(completed.summary.as_deref().unwrap_or("").contains("nonce"));

        let failed = envelopes
            .iter()
            .find_map(|envelope| match &envelope.event {
                RuntimeEvent::SubagentStatusChanged { run } if run.id == "toolu_task_1" => {
                    Some(run)
                }
                _ => None,
            })
            .expect("Task failure");
        assert_eq!(failed.status, AgentRunStatus::Failed);
        assert!(!failed.transcript_available);
    }

    #[test]
    fn ignores_non_agent_tools() {
        let mut mapper = ClaudeAgentMapper::default();
        let events = mapper.ingest_message(
            &json!({
                "type": "assistant",
                "session_id": "session-root",
                "message": {
                    "content": [{
                        "type": "tool_use",
                        "id": "toolu_bash",
                        "name": "Bash",
                        "input": {"command": "ls"}
                    }]
                }
            }),
            "main",
            "tab-1",
            "a1",
        );
        assert!(events.is_empty());
    }
}
