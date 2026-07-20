use serde::{Deserialize, Serialize};

use super::RuntimeKind;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventEnvelope {
    pub runtime: RuntimeKind,
    pub window_label: String,
    pub tab_id: String,
    pub attempt_id: String,
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
    pub sequence: u64,
    pub event: RuntimeEvent,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentRunStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRun {
    pub id: String,
    pub parent_id: Option<String>,
    pub root_conversation_id: String,
    pub runtime: RuntimeKind,
    pub agent_name: String,
    pub agent_role: Option<String>,
    pub model: Option<String>,
    pub status: AgentRunStatus,
    pub started_at: i64,
    pub completed_at: Option<i64>,
    pub activity: Option<String>,
    pub summary: Option<String>,
    pub error: Option<String>,
    pub transcript_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRequestQuestion {
    pub id: String,
    pub prompt: String,
    pub options: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRequest {
    pub request_id: serde_json::Value,
    pub method: String,
    pub runtime: RuntimeKind,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub tab_id: String,
    pub agent_run_id: Option<String>,
    pub title: String,
    pub command: Option<String>,
    pub cwd: Option<String>,
    pub diff: Option<String>,
    pub permissions: Option<serde_json::Value>,
    pub questions: Vec<RuntimeRequestQuestion>,
    pub details: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RuntimeEvent {
    SessionStarted {
        session_id: String,
    },
    TurnStarted {
        turn_id: String,
    },
    TurnCompleted {
        turn_id: String,
    },
    TurnInterrupted {
        turn_id: String,
    },
    TurnFailed {
        turn_id: Option<String>,
        message: String,
    },
    AssistantDelta {
        item_id: String,
        delta: String,
    },
    AssistantCompleted {
        item_id: String,
        content: String,
    },
    ReasoningSummaryDelta {
        item_id: String,
        delta: String,
    },
    ToolStarted {
        item_id: String,
        name: String,
        input: serde_json::Value,
    },
    ToolOutput {
        item_id: String,
        output: String,
    },
    ToolCompleted {
        item_id: String,
        success: bool,
        output: Option<String>,
    },
    FileChange {
        item_id: String,
        path: String,
        diff: Option<String>,
    },
    Usage {
        input_tokens: u64,
        output_tokens: u64,
    },
    ApprovalRequested {
        request: RuntimeRequest,
    },
    UserInputRequested {
        request: RuntimeRequest,
    },
    SubagentDiscovered {
        run: AgentRun,
    },
    SubagentStatusChanged {
        run: AgentRun,
    },
    Warning {
        message: String,
    },
    Unknown {
        native_type: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::RuntimeKind;

    fn event_type(event: RuntimeEvent) -> String {
        serde_json::to_value(event).unwrap()["type"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn sample_run() -> AgentRun {
        AgentRun {
            id: "agent-1".into(),
            parent_id: Some("thread-1".into()),
            root_conversation_id: "thread-1".into(),
            runtime: RuntimeKind::Codex,
            agent_name: "reviewer".into(),
            agent_role: Some("reviewer".into()),
            model: Some("gpt-5.4".into()),
            status: AgentRunStatus::Running,
            started_at: 1,
            completed_at: None,
            activity: Some("spawned".into()),
            summary: None,
            error: None,
            transcript_available: true,
        }
    }

    fn sample_request() -> RuntimeRequest {
        RuntimeRequest {
            request_id: serde_json::json!(7),
            method: "item/commandExecution/requestApproval".into(),
            runtime: RuntimeKind::Codex,
            thread_id: Some("thread-1".into()),
            turn_id: Some("turn-1".into()),
            tab_id: "tab-1".into(),
            agent_run_id: None,
            title: "Run command".into(),
            command: Some("cargo test".into()),
            cwd: None,
            diff: None,
            permissions: None,
            questions: vec![],
            details: serde_json::json!({}),
        }
    }

    #[test]
    fn envelope_uses_camel_case_routes_and_preserves_null_ids_and_sequence() {
        let value = serde_json::to_value(RuntimeEventEnvelope {
            runtime: RuntimeKind::Codex,
            window_label: "main".into(),
            tab_id: "tab-7".into(),
            attempt_id: "tab-7:42".into(),
            session_id: None,
            turn_id: None,
            sequence: 42,
            event: RuntimeEvent::AssistantDelta {
                item_id: "item-1".into(),
                delta: "hello".into(),
            },
        })
        .unwrap();

        assert_eq!(value["runtime"], "codex");
        assert_eq!(value["windowLabel"], "main");
        assert_eq!(value["tabId"], "tab-7");
        assert_eq!(value["attemptId"], "tab-7:42");
        assert!(value["sessionId"].is_null());
        assert!(value["turnId"].is_null());
        assert_eq!(value["sequence"], 42);
        assert_eq!(value["event"]["type"], "assistantDelta");
        assert_eq!(value["event"]["itemId"], "item-1");
    }

    #[test]
    fn pending_turn_failure_serializes_an_explicit_null_turn_id() {
        let value = serde_json::to_value(RuntimeEvent::TurnFailed {
            turn_id: None,
            message: "transport closed".into(),
        })
        .unwrap();

        assert_eq!(value["type"], "turnFailed");
        assert!(value["turnId"].is_null());
        assert_eq!(value["message"], "transport closed");
    }

    #[test]
    fn agent_run_and_request_use_camel_case_wire_fields() {
        let run = serde_json::to_value(sample_run()).unwrap();
        assert_eq!(run["rootConversationId"], "thread-1");
        assert_eq!(run["agentName"], "reviewer");
        assert_eq!(run["transcriptAvailable"], true);
        assert_eq!(run["status"], "running");

        let request = serde_json::to_value(sample_request()).unwrap();
        assert_eq!(request["requestId"], 7);
        assert_eq!(request["agentRunId"], serde_json::Value::Null);
    }

    #[test]
    fn runtime_event_wire_types_are_stable() {
        let cases = [
            (
                RuntimeEvent::SessionStarted {
                    session_id: "session-1".into(),
                },
                "sessionStarted",
            ),
            (
                RuntimeEvent::TurnStarted {
                    turn_id: "turn-1".into(),
                },
                "turnStarted",
            ),
            (
                RuntimeEvent::TurnCompleted {
                    turn_id: "turn-1".into(),
                },
                "turnCompleted",
            ),
            (
                RuntimeEvent::TurnInterrupted {
                    turn_id: "turn-1".into(),
                },
                "turnInterrupted",
            ),
            (
                RuntimeEvent::TurnFailed {
                    turn_id: Some("turn-1".into()),
                    message: "failed".into(),
                },
                "turnFailed",
            ),
            (
                RuntimeEvent::AssistantDelta {
                    item_id: "item-1".into(),
                    delta: "delta".into(),
                },
                "assistantDelta",
            ),
            (
                RuntimeEvent::AssistantCompleted {
                    item_id: "item-1".into(),
                    content: "done".into(),
                },
                "assistantCompleted",
            ),
            (
                RuntimeEvent::ReasoningSummaryDelta {
                    item_id: "item-2".into(),
                    delta: "reasoning".into(),
                },
                "reasoningSummaryDelta",
            ),
            (
                RuntimeEvent::ToolStarted {
                    item_id: "item-3".into(),
                    name: "shell".into(),
                    input: serde_json::json!({"command": "pwd"}),
                },
                "toolStarted",
            ),
            (
                RuntimeEvent::ToolOutput {
                    item_id: "item-3".into(),
                    output: "work".into(),
                },
                "toolOutput",
            ),
            (
                RuntimeEvent::ToolCompleted {
                    item_id: "item-3".into(),
                    success: true,
                    output: Some("work".into()),
                },
                "toolCompleted",
            ),
            (
                RuntimeEvent::FileChange {
                    item_id: "item-4".into(),
                    path: "main.tex".into(),
                    diff: Some("+text".into()),
                },
                "fileChange",
            ),
            (
                RuntimeEvent::Usage {
                    input_tokens: 3,
                    output_tokens: 5,
                },
                "usage",
            ),
            (
                RuntimeEvent::ApprovalRequested {
                    request: sample_request(),
                },
                "approvalRequested",
            ),
            (
                RuntimeEvent::UserInputRequested {
                    request: sample_request(),
                },
                "userInputRequested",
            ),
            (
                RuntimeEvent::SubagentDiscovered {
                    run: sample_run(),
                },
                "subagentDiscovered",
            ),
            (
                RuntimeEvent::SubagentStatusChanged {
                    run: sample_run(),
                },
                "subagentStatusChanged",
            ),
            (
                RuntimeEvent::Warning {
                    message: "unknown item".into(),
                },
                "warning",
            ),
            (
                RuntimeEvent::Unknown {
                    native_type: "future/item".into(),
                },
                "unknown",
            ),
        ];

        for (event, expected) in cases {
            assert_eq!(event_type(event), expected);
        }
    }
}
