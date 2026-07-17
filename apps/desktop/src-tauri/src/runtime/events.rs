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
        request_id: serde_json::Value,
        method: String,
        details: serde_json::Value,
    },
    UserInputRequested {
        request_id: serde_json::Value,
        prompt: String,
        details: serde_json::Value,
    },
    SubagentDiscovered {
        agent_id: String,
        name: Option<String>,
        details: serde_json::Value,
    },
    SubagentStatusChanged {
        agent_id: String,
        status: String,
        details: serde_json::Value,
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
                    request_id: serde_json::json!(7),
                    method: "command/approval".into(),
                    details: serde_json::json!({"title": "Run command"}),
                },
                "approvalRequested",
            ),
            (
                RuntimeEvent::UserInputRequested {
                    request_id: serde_json::json!(8),
                    prompt: "Choose".into(),
                    details: serde_json::json!({"options": ["yes", "no"]}),
                },
                "userInputRequested",
            ),
            (
                RuntimeEvent::SubagentDiscovered {
                    agent_id: "agent-1".into(),
                    name: Some("reviewer".into()),
                    details: serde_json::json!({}),
                },
                "subagentDiscovered",
            ),
            (
                RuntimeEvent::SubagentStatusChanged {
                    agent_id: "agent-1".into(),
                    status: "running".into(),
                    details: serde_json::json!({}),
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
