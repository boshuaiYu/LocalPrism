//! Maps Codex app-server lifecycle notifications into stable runtime events.

use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::Value;

use crate::runtime::{
    events::{AgentRun, AgentRunStatus, RuntimeEvent, RuntimeEventEnvelope},
    process::TurnRoute,
    RuntimeKind,
};

use super::sanitize_install_output;

const RECENT_TERMINAL_LIMIT: usize = 256;

type RouteKey = (String, String);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ScopedSession {
    generation: u64,
    window_label: String,
    tab_id: String,
    thread_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ScopedTurn {
    generation: u64,
    window_label: String,
    tab_id: String,
    thread_id: String,
    turn_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ScopedItem {
    turn: ScopedTurn,
    item_id: String,
}

/// Stateful, ordered mapper owned by the single app-server inbound loop.
///
/// The caller supplies the route selected by `RuntimeProcessState`; this type
/// validates the protocol IDs against that route and owns only event ordering
/// and idempotence.
#[derive(Debug, Default)]
pub(crate) struct CodexEventMapper {
    current_generation: u64,
    sequences: HashMap<RouteKey, u64>,
    started_sessions: HashSet<ScopedSession>,
    started_turns: HashSet<ScopedTurn>,
    completed_items: HashSet<ScopedItem>,
    terminal_turns: HashSet<ScopedTurn>,
    recent_terminal_turns: VecDeque<ScopedTurn>,
}

impl CodexEventMapper {
    /// Advances the accepted app-server transport generation.
    pub(crate) fn set_generation(&mut self, generation: u64) {
        if generation <= self.current_generation {
            return;
        }
        self.current_generation = generation;
        self.started_sessions.clear();
        self.started_turns.clear();
        self.completed_items.clear();
        self.terminal_turns.clear();
        self.recent_terminal_turns.clear();
    }

    /// Maps one already-routed notification into zero or more normalized events.
    pub(crate) fn map_notification(
        &mut self,
        generation: u64,
        route: &TurnRoute,
        method: &str,
        params: &Value,
    ) -> Vec<RuntimeEventEnvelope> {
        if generation != self.current_generation || route.runtime != RuntimeKind::Codex {
            return Vec::new();
        }
        if !known_ids_match_route(route, params) {
            return Vec::new();
        }

        match method {
            "thread/started" => self
                .map_thread_started(generation, route, params)
                .into_iter()
                .collect(),
            "turn/started" => self
                .map_turn_started(generation, route, params)
                .into_iter()
                .collect(),
            "item/agentMessage/delta" => self
                .map_agent_message_delta(generation, route, params)
                .into_iter()
                .collect(),
            "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => self
                .map_reasoning_delta(generation, route, params)
                .into_iter()
                .collect(),
            "item/completed" => self.map_item_completed(generation, route, params),
            "turn/completed" => self
                .map_turn_completed(generation, route, params)
                .into_iter()
                .collect(),
            "error" => self
                .map_error(generation, route, params)
                .into_iter()
                .collect(),
            _ => self
                .map_unknown(generation, route, method, params)
                .into_iter()
                .collect(),
        }
    }

    /// Produces the single failed terminal event required before a broken
    /// app-server transport advances to its next generation.
    pub(crate) fn map_transport_failure(
        &mut self,
        generation: u64,
        route: &TurnRoute,
        message: &str,
    ) -> Option<RuntimeEventEnvelope> {
        if generation != self.current_generation || route.runtime != RuntimeKind::Codex {
            return None;
        }
        let thread_id = route.session_id.as_deref();
        let turn_id = route.turn_id.as_deref();
        if let (Some(thread_id), Some(turn_id)) = (thread_id, turn_id) {
            let turn = scoped_turn(generation, route, thread_id, turn_id);
            if self.terminal_turns.contains(&turn) {
                return None;
            }
            self.mark_terminal(turn);
        }

        Some(self.envelope(
            route,
            thread_id.map(str::to_owned),
            turn_id.map(str::to_owned),
            RuntimeEvent::TurnFailed {
                turn_id: turn_id.map(str::to_owned),
                message: sanitize_install_output(message),
            },
        ))
    }

    pub(crate) fn map_prestart_cancellation(
        &mut self,
        generation: u64,
        route: &TurnRoute,
    ) -> Option<RuntimeEventEnvelope> {
        if generation != self.current_generation || route.runtime != RuntimeKind::Codex {
            return None;
        }
        Some(self.envelope(
            route,
            route.session_id.clone(),
            None,
            RuntimeEvent::TurnFailed {
                turn_id: None,
                message: "Turn cancelled before start".into(),
            },
        ))
    }

    /// Drops mapper state belonging to a closed tab.
    pub(crate) fn remove_route(&mut self, window_label: &str, tab_id: &str) {
        let matches_route = |window: &str, tab: &str| window == window_label && tab == tab_id;
        self.sequences
            .remove(&(window_label.to_owned(), tab_id.to_owned()));
        self.started_sessions.retain(|session| {
            !matches_route(session.window_label.as_str(), session.tab_id.as_str())
        });
        self.started_turns
            .retain(|turn| !matches_route(turn.window_label.as_str(), turn.tab_id.as_str()));
        self.completed_items.retain(|item| {
            !matches_route(item.turn.window_label.as_str(), item.turn.tab_id.as_str())
        });
        self.terminal_turns
            .retain(|turn| !matches_route(turn.window_label.as_str(), turn.tab_id.as_str()));
        self.recent_terminal_turns
            .retain(|turn| !matches_route(turn.window_label.as_str(), turn.tab_id.as_str()));
    }

    fn map_thread_started(
        &mut self,
        generation: u64,
        route: &TurnRoute,
        params: &Value,
    ) -> Option<RuntimeEventEnvelope> {
        let Some(thread_id) = nested_string(params, &["thread", "id"]) else {
            return Some(self.malformed(route, "thread/started"));
        };
        if !route_matches(route, thread_id, None) {
            return None;
        }

        // A route can be rebound to a new session. Retaining only its current
        // session keeps idempotence state bounded without changing sequences.
        self.started_sessions.retain(|session| {
            session.generation != generation
                || session.window_label != route.window_label
                || session.tab_id != route.tab_id
                || session.thread_id == thread_id
        });
        let session = scoped_session(generation, route, thread_id);
        if !self.started_sessions.insert(session) {
            return None;
        }

        Some(self.envelope(
            route,
            Some(thread_id.to_owned()),
            None,
            RuntimeEvent::SessionStarted {
                session_id: thread_id.to_owned(),
            },
        ))
    }

    fn map_turn_started(
        &mut self,
        generation: u64,
        route: &TurnRoute,
        params: &Value,
    ) -> Option<RuntimeEventEnvelope> {
        let Some(thread_id) = string_field(params, "threadId") else {
            return Some(self.malformed(route, "turn/started"));
        };
        let Some(turn_id) = nested_string(params, &["turn", "id"]) else {
            return Some(self.malformed(route, "turn/started"));
        };
        if !route_matches(route, thread_id, Some(turn_id)) {
            return None;
        }

        let turn = scoped_turn(generation, route, thread_id, turn_id);
        if self.terminal_turns.contains(&turn) || !self.started_turns.insert(turn) {
            return None;
        }
        Some(self.envelope(
            route,
            Some(thread_id.to_owned()),
            Some(turn_id.to_owned()),
            RuntimeEvent::TurnStarted {
                turn_id: turn_id.to_owned(),
            },
        ))
    }

    fn map_agent_message_delta(
        &mut self,
        generation: u64,
        route: &TurnRoute,
        params: &Value,
    ) -> Option<RuntimeEventEnvelope> {
        let (Some(thread_id), Some(turn_id), Some(item_id), Some(delta)) = (
            string_field(params, "threadId"),
            string_field(params, "turnId"),
            string_field(params, "itemId"),
            string_field(params, "delta"),
        ) else {
            return Some(self.malformed(route, "item/agentMessage/delta"));
        };
        if !route_matches(route, thread_id, Some(turn_id)) {
            return None;
        }

        let turn = scoped_turn(generation, route, thread_id, turn_id);
        let item = ScopedItem {
            turn: turn.clone(),
            item_id: item_id.to_owned(),
        };
        if self.terminal_turns.contains(&turn) || self.completed_items.contains(&item) {
            return None;
        }

        Some(self.envelope(
            route,
            Some(thread_id.to_owned()),
            Some(turn_id.to_owned()),
            RuntimeEvent::AssistantDelta {
                item_id: item_id.to_owned(),
                delta: sanitize_install_output(delta),
            },
        ))
    }

    fn map_reasoning_delta(
        &mut self,
        generation: u64,
        route: &TurnRoute,
        params: &Value,
    ) -> Option<RuntimeEventEnvelope> {
        let (Some(thread_id), Some(turn_id), Some(item_id), Some(delta)) = (
            string_field(params, "threadId"),
            string_field(params, "turnId"),
            string_field(params, "itemId"),
            string_field(params, "delta"),
        ) else {
            return Some(self.malformed(route, "item/reasoning/delta"));
        };
        if !route_matches(route, thread_id, Some(turn_id)) {
            return None;
        }

        let turn = scoped_turn(generation, route, thread_id, turn_id);
        let item = ScopedItem {
            turn: turn.clone(),
            item_id: item_id.to_owned(),
        };
        if self.terminal_turns.contains(&turn) || self.completed_items.contains(&item) {
            return None;
        }
        if delta.is_empty() {
            return None;
        }

        Some(self.envelope(
            route,
            Some(thread_id.to_owned()),
            Some(turn_id.to_owned()),
            RuntimeEvent::ReasoningSummaryDelta {
                item_id: item_id.to_owned(),
                delta: sanitize_install_output(delta),
            },
        ))
    }

    fn map_item_completed(
        &mut self,
        generation: u64,
        route: &TurnRoute,
        params: &Value,
    ) -> Vec<RuntimeEventEnvelope> {
        // completedAtMs is optional on newer Codex builds.
        let (Some(thread_id), Some(turn_id), Some(item)) = (
            string_field(params, "threadId"),
            string_field(params, "turnId"),
            params.get("item").and_then(Value::as_object),
        ) else {
            return vec![self.malformed(route, "item/completed")];
        };
        let (Some(item_id), Some(item_type)) = (
            item.get("id").and_then(Value::as_str),
            item.get("type").and_then(Value::as_str),
        ) else {
            return vec![self.malformed(route, "item/completed")];
        };
        if !route_matches(route, thread_id, Some(turn_id)) {
            return Vec::new();
        }

        let turn = scoped_turn(generation, route, thread_id, turn_id);
        let scoped_item = ScopedItem {
            turn: turn.clone(),
            item_id: item_id.to_owned(),
        };
        if self.terminal_turns.contains(&turn) || self.completed_items.contains(&scoped_item) {
            return Vec::new();
        }
        self.completed_items.insert(scoped_item);

        match item_type {
            "agentMessage" => {
                let content = item
                    .get("text")
                    .and_then(Value::as_str)
                    .or_else(|| item.get("content").and_then(Value::as_str))
                    .unwrap_or("");
                vec![self.envelope(
                    route,
                    Some(thread_id.to_owned()),
                    Some(turn_id.to_owned()),
                    RuntimeEvent::AssistantCompleted {
                        item_id: item_id.to_owned(),
                        content: sanitize_install_output(content),
                    },
                )]
            }
            "reasoning" => {
                let summary = reasoning_summary_text(item);
                let event = if summary.is_empty() {
                    RuntimeEvent::Unknown {
                        native_type: "reasoning".into(),
                    }
                } else {
                    RuntimeEvent::ReasoningSummaryDelta {
                        item_id: item_id.to_owned(),
                        delta: sanitize_install_output(&summary),
                    }
                };
                vec![self.envelope(
                    route,
                    Some(thread_id.to_owned()),
                    Some(turn_id.to_owned()),
                    event,
                )]
            }
            "commandExecution" => {
                let command = item
                    .get("command")
                    .and_then(Value::as_str)
                    .unwrap_or("command");
                let output = item
                    .get("aggregatedOutput")
                    .and_then(Value::as_str)
                    .or_else(|| item.get("output").and_then(Value::as_str))
                    .map(sanitize_install_output);
                let success = item
                    .get("exitCode")
                    .and_then(Value::as_i64)
                    .map(|code| code == 0)
                    .or_else(|| item.get("success").and_then(Value::as_bool))
                    .unwrap_or(true);
                vec![
                    self.envelope(
                        route,
                        Some(thread_id.to_owned()),
                        Some(turn_id.to_owned()),
                        RuntimeEvent::ToolStarted {
                            item_id: item_id.to_owned(),
                            name: "commandExecution".into(),
                            input: serde_json::json!({ "command": sanitize_install_output(command) }),
                        },
                    ),
                    self.envelope(
                        route,
                        Some(thread_id.to_owned()),
                        Some(turn_id.to_owned()),
                        RuntimeEvent::ToolCompleted {
                            item_id: item_id.to_owned(),
                            success,
                            output,
                        },
                    ),
                ]
            }
            "fileChange" => {
                let path = item
                    .get("path")
                    .and_then(Value::as_str)
                    .or_else(|| {
                        item.get("changes")
                            .and_then(Value::as_array)
                            .and_then(|changes| changes.first())
                            .and_then(|change| change.get("path"))
                            .and_then(Value::as_str)
                    })
                    .unwrap_or("file");
                let diff = item
                    .get("diff")
                    .and_then(Value::as_str)
                    .map(sanitize_install_output);
                vec![self.envelope(
                    route,
                    Some(thread_id.to_owned()),
                    Some(turn_id.to_owned()),
                    RuntimeEvent::FileChange {
                        item_id: item_id.to_owned(),
                        path: sanitize_install_output(path),
                        diff,
                    },
                )]
            }
            "collabAgentToolCall" => self.map_collab_agent_tool_call(
                route,
                thread_id,
                turn_id,
                item,
            ),
            native_type => vec![self.envelope(
                route,
                Some(thread_id.to_owned()),
                Some(turn_id.to_owned()),
                RuntimeEvent::Unknown {
                    native_type: sanitize_install_output(native_type),
                },
            )],
        }
    }

    fn map_collab_agent_tool_call(
        &mut self,
        route: &TurnRoute,
        thread_id: &str,
        turn_id: &str,
        item: &serde_json::Map<String, Value>,
    ) -> Vec<RuntimeEventEnvelope> {
        let tool = item.get("tool").and_then(Value::as_str).unwrap_or("");
        if tool != "spawnAgent" && !item.contains_key("agentsStates") {
            return vec![self.envelope(
                route,
                Some(thread_id.to_owned()),
                Some(turn_id.to_owned()),
                RuntimeEvent::Unknown {
                    native_type: "collabAgentToolCall".into(),
                },
            )];
        }

        let parent_id = item
            .get("senderThreadId")
            .and_then(Value::as_str)
            .unwrap_or(thread_id)
            .to_owned();
        let root_id = route
            .session_id
            .clone()
            .unwrap_or_else(|| parent_id.clone());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0);

        let mut events = Vec::new();
        let receiver_ids = item
            .get("receiverThreadIds")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let agents_states = item
            .get("agentsStates")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();

        let mut child_ids = receiver_ids
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if child_ids.is_empty() {
            child_ids.extend(agents_states.keys().cloned());
        }

        for child_id in child_ids {
            let state = agents_states.get(&child_id);
            let status = map_agent_state_status(
                state
                    .and_then(|value| value.get("status"))
                    .and_then(Value::as_str)
                    .or_else(|| item.get("status").and_then(Value::as_str)),
            );
            let agent_name = state
                .and_then(|value| value.get("nickname").or_else(|| value.get("name")))
                .and_then(Value::as_str)
                .or_else(|| item.get("nickname").and_then(Value::as_str))
                .unwrap_or("subagent")
                .to_owned();
            let model = state
                .and_then(|value| value.get("model"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let activity = state
                .and_then(|value| value.get("status"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let completed_at = is_terminal_status(status).then_some(now);
            let run = AgentRun {
                id: child_id,
                parent_id: Some(parent_id.clone()),
                root_conversation_id: root_id.clone(),
                runtime: RuntimeKind::Codex,
                agent_name: sanitize_install_output(&agent_name),
                agent_role: state
                    .and_then(|value| value.get("role").or_else(|| value.get("agentRole")))
                    .and_then(Value::as_str)
                    .map(sanitize_install_output),
                model: model.map(|value| sanitize_install_output(&value)),
                status,
                started_at: now,
                completed_at,
                activity: activity.map(|value| sanitize_install_output(&value)),
                summary: None,
                error: state
                    .and_then(|value| value.get("error"))
                    .and_then(Value::as_str)
                    .map(sanitize_install_output),
                transcript_available: true,
            };
            let event = if is_terminal_status(status) {
                RuntimeEvent::SubagentStatusChanged { run }
            } else {
                RuntimeEvent::SubagentDiscovered { run }
            };
            events.push(self.envelope(
                route,
                Some(thread_id.to_owned()),
                Some(turn_id.to_owned()),
                event,
            ));
        }

        if events.is_empty() {
            events.push(self.envelope(
                route,
                Some(thread_id.to_owned()),
                Some(turn_id.to_owned()),
                RuntimeEvent::Unknown {
                    native_type: "collabAgentToolCall".into(),
                },
            ));
        }
        events
    }

    fn map_turn_completed(
        &mut self,
        generation: u64,
        route: &TurnRoute,
        params: &Value,
    ) -> Option<RuntimeEventEnvelope> {
        let (Some(thread_id), Some(turn_id)) = (
            string_field(params, "threadId"),
            nested_string(params, &["turn", "id"]),
        ) else {
            return Some(self.malformed(route, "turn/completed"));
        };
        if !route_matches(route, thread_id, Some(turn_id)) {
            return None;
        }

        let turn = scoped_turn(generation, route, thread_id, turn_id);
        if self.terminal_turns.contains(&turn) {
            return None;
        }
        let status = params.pointer("/turn/status").and_then(Value::as_str);
        let event = match status {
            Some("completed") => RuntimeEvent::TurnCompleted {
                turn_id: turn_id.to_owned(),
            },
            Some("interrupted") => RuntimeEvent::TurnInterrupted {
                turn_id: turn_id.to_owned(),
            },
            Some("failed") => RuntimeEvent::TurnFailed {
                turn_id: Some(turn_id.to_owned()),
                message: sanitized_error_message(
                    params.pointer("/turn/error"),
                    "Codex turn failed",
                ),
            },
            Some("inProgress") => {
                return Some(self.warning(
                    route,
                    Some(thread_id.to_owned()),
                    Some(turn_id.to_owned()),
                    "Codex sent `turn/completed` with a nonterminal status",
                ));
            }
            Some(unknown) => RuntimeEvent::TurnFailed {
                turn_id: Some(turn_id.to_owned()),
                message: format!(
                    "Codex turn ended with unknown status `{}`",
                    sanitize_install_output(unknown)
                ),
            },
            None => RuntimeEvent::TurnFailed {
                turn_id: Some(turn_id.to_owned()),
                message: "Malformed Codex `turn/completed` status".into(),
            },
        };

        self.mark_terminal(turn);
        Some(self.envelope(
            route,
            Some(thread_id.to_owned()),
            Some(turn_id.to_owned()),
            event,
        ))
    }

    fn map_error(
        &mut self,
        generation: u64,
        route: &TurnRoute,
        params: &Value,
    ) -> Option<RuntimeEventEnvelope> {
        let (Some(thread_id), Some(turn_id), Some(will_retry), Some(error)) = (
            string_field(params, "threadId"),
            string_field(params, "turnId"),
            params.get("willRetry").and_then(Value::as_bool),
            params.get("error"),
        ) else {
            return Some(self.malformed(route, "error"));
        };
        if !route_matches(route, thread_id, Some(turn_id)) {
            return None;
        }

        let turn = scoped_turn(generation, route, thread_id, turn_id);
        if self.terminal_turns.contains(&turn) {
            return None;
        }
        let message = sanitized_error_message(Some(error), "Codex turn failed");
        let details = error
            .get("additionalDetails")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(sanitize_install_output);
        let warning_message = match details {
            Some(details) if !message.to_ascii_lowercase().contains(&details.to_ascii_lowercase()) => {
                format!("{message} ({details})")
            }
            _ => message.clone(),
        };

        if will_retry {
            // Live Codex can emit Reconnecting... 5/5 with willRetry=true and still
            // complete the turn afterward. Never release the route here.
            return Some(self.warning(
                route,
                Some(thread_id.to_owned()),
                Some(turn_id.to_owned()),
                &warning_message,
            ));
        }

        self.mark_terminal(turn);
        Some(self.envelope(
            route,
            Some(thread_id.to_owned()),
            Some(turn_id.to_owned()),
            RuntimeEvent::TurnFailed {
                turn_id: Some(turn_id.to_owned()),
                message,
            },
        ))
    }

    fn map_unknown(
        &mut self,
        generation: u64,
        route: &TurnRoute,
        method: &str,
        params: &Value,
    ) -> Option<RuntimeEventEnvelope> {
        let thread_id = string_field(params, "threadId")
            .or_else(|| nested_string(params, &["thread", "id"]))?;
        let turn_id =
            string_field(params, "turnId").or_else(|| nested_string(params, &["turn", "id"]));
        if !route_matches(route, thread_id, turn_id) {
            return None;
        }
        if let Some(turn_id) = turn_id {
            let turn = scoped_turn(generation, route, thread_id, turn_id);
            if self.terminal_turns.contains(&turn) {
                return None;
            }
        }

        Some(self.envelope(
            route,
            Some(thread_id.to_owned()),
            turn_id.map(str::to_owned),
            RuntimeEvent::Unknown {
                native_type: sanitize_install_output(method),
            },
        ))
    }

    fn malformed(&mut self, route: &TurnRoute, method: &str) -> RuntimeEventEnvelope {
        self.warning(
            route,
            route.session_id.clone(),
            route.turn_id.clone(),
            &format!("Malformed Codex `{method}` notification"),
        )
    }

    fn warning(
        &mut self,
        route: &TurnRoute,
        session_id: Option<String>,
        turn_id: Option<String>,
        message: &str,
    ) -> RuntimeEventEnvelope {
        self.envelope(
            route,
            session_id,
            turn_id,
            RuntimeEvent::Warning {
                message: sanitize_install_output(message),
            },
        )
    }

    fn envelope(
        &mut self,
        route: &TurnRoute,
        session_id: Option<String>,
        turn_id: Option<String>,
        event: RuntimeEvent,
    ) -> RuntimeEventEnvelope {
        let sequence = self
            .sequences
            .entry((route.window_label.clone(), route.tab_id.clone()))
            .or_default();
        *sequence = sequence.saturating_add(1);
        RuntimeEventEnvelope {
            runtime: RuntimeKind::Codex,
            window_label: route.window_label.clone(),
            tab_id: route.tab_id.clone(),
            attempt_id: route.attempt_id.clone(),
            session_id,
            turn_id,
            sequence: *sequence,
            event,
        }
    }

    fn mark_terminal(&mut self, turn: ScopedTurn) {
        if !self.terminal_turns.insert(turn.clone()) {
            return;
        }
        self.started_turns.remove(&turn);
        self.completed_items.retain(|item| item.turn != turn);
        self.recent_terminal_turns.push_back(turn);
        while self.recent_terminal_turns.len() > RECENT_TERMINAL_LIMIT {
            if let Some(expired) = self.recent_terminal_turns.pop_front() {
                self.terminal_turns.remove(&expired);
            }
        }
    }
}

fn string_field<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value.get(field).and_then(Value::as_str)
}

fn nested_string<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    path.iter()
        .try_fold(value, |current, field| current.get(*field))
        .and_then(Value::as_str)
}

fn route_matches(route: &TurnRoute, thread_id: &str, turn_id: Option<&str>) -> bool {
    route
        .session_id
        .as_deref()
        .is_none_or(|expected| expected == thread_id)
        && turn_id.is_none_or(|received| {
            route
                .turn_id
                .as_deref()
                .is_none_or(|expected| expected == received)
        })
}

fn known_ids_match_route(route: &TurnRoute, params: &Value) -> bool {
    let thread_id =
        string_field(params, "threadId").or_else(|| nested_string(params, &["thread", "id"]));
    if let (Some(expected), Some(received)) = (route.session_id.as_deref(), thread_id) {
        if expected != received {
            return false;
        }
    }

    let turn_id = string_field(params, "turnId").or_else(|| nested_string(params, &["turn", "id"]));
    if let (Some(expected), Some(received)) = (route.turn_id.as_deref(), turn_id) {
        if expected != received {
            return false;
        }
    }
    true
}

fn scoped_session(generation: u64, route: &TurnRoute, thread_id: &str) -> ScopedSession {
    ScopedSession {
        generation,
        window_label: route.window_label.clone(),
        tab_id: route.tab_id.clone(),
        thread_id: thread_id.to_owned(),
    }
}

fn scoped_turn(generation: u64, route: &TurnRoute, thread_id: &str, turn_id: &str) -> ScopedTurn {
    ScopedTurn {
        generation,
        window_label: route.window_label.clone(),
        tab_id: route.tab_id.clone(),
        thread_id: thread_id.to_owned(),
        turn_id: turn_id.to_owned(),
    }
}

fn map_agent_state_status(status: Option<&str>) -> AgentRunStatus {
    match status {
        Some("pendingInit" | "pending" | "queued") => AgentRunStatus::Queued,
        Some("running" | "inProgress" | "active") => AgentRunStatus::Running,
        Some("completed" | "done" | "success") => AgentRunStatus::Completed,
        Some("errored" | "failed" | "error") => AgentRunStatus::Failed,
        Some("interrupted" | "shutdown" | "cancelled" | "canceled") => AgentRunStatus::Cancelled,
        _ => AgentRunStatus::Running,
    }
}

fn is_terminal_status(status: AgentRunStatus) -> bool {
    matches!(
        status,
        AgentRunStatus::Completed | AgentRunStatus::Failed | AgentRunStatus::Cancelled
    )
}

fn reasoning_summary_text(item: &serde_json::Map<String, Value>) -> String {
    if let Some(text) = item.get("text").and_then(Value::as_str) {
        if !text.trim().is_empty() {
            return text.to_owned();
        }
    }

    for key in ["summary", "content"] {
        let Some(value) = item.get(key) else {
            continue;
        };
        if let Some(text) = value.as_str() {
            if !text.trim().is_empty() {
                return text.to_owned();
            }
            continue;
        }
        let Some(entries) = value.as_array() else {
            continue;
        };
        let mut parts = Vec::new();
        for entry in entries {
            if let Some(text) = entry.as_str() {
                if !text.trim().is_empty() {
                    parts.push(text.to_owned());
                }
                continue;
            }
            if let Some(text) = entry.get("text").and_then(Value::as_str) {
                if !text.trim().is_empty() {
                    parts.push(text.to_owned());
                }
                continue;
            }
            if let Some(text) = entry.get("summary").and_then(Value::as_str) {
                if !text.trim().is_empty() {
                    parts.push(text.to_owned());
                }
            }
        }
        if !parts.is_empty() {
            return parts.join("\n");
        }
    }
    String::new()
}

fn nested_json_error_message(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if !(trimmed.starts_with('{') && trimmed.contains("\"message\"")) {
        return None;
    }
    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
        return None;
    };
    value
        .pointer("/error/message")
        .and_then(Value::as_str)
        .or_else(|| value.get("message").and_then(Value::as_str))
        .map(str::to_owned)
}

fn sanitized_error_message(error: Option<&Value>, fallback: &str) -> String {
    let message = error
        .and_then(|error| {
            error
                .as_str()
                .or_else(|| error.get("message").and_then(Value::as_str))
                .or_else(|| error.get("additionalDetails").and_then(Value::as_str))
        })
        .unwrap_or(fallback);
    let message = nested_json_error_message(message).unwrap_or_else(|| message.to_owned());
    sanitize_install_output(&message)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::runtime::events::RuntimeEvent;

    fn route(window: &str, tab: &str, thread: &str, turn: Option<&str>) -> TurnRoute {
        TurnRoute {
            runtime: RuntimeKind::Codex,
            window_label: window.into(),
            tab_id: tab.into(),
            attempt_id: format!("attempt-{window}-{tab}"),
            session_id: Some(thread.into()),
            turn_id: turn.map(str::to_owned),
        }
    }

    fn map(
        mapper: &mut CodexEventMapper,
        route: &TurnRoute,
        method: &str,
        params: Value,
    ) -> Vec<RuntimeEventEnvelope> {
        mapper.map_notification(0, route, method, &params)
    }

    #[test]
    fn collab_spawn_agent_maps_children_with_parent_and_status() {
        let mut mapper = CodexEventMapper::default();
        let route = route("main", "tab-a", "thread-a", Some("turn-a"));
        let events = map(
            &mut mapper,
            &route,
            "item/completed",
            json!({
                "threadId":"thread-a",
                "turnId":"turn-a",
                "item":{
                    "type":"collabAgentToolCall",
                    "id":"item-collab",
                    "tool":"spawnAgent",
                    "senderThreadId":"thread-a",
                    "receiverThreadIds":["child-1","child-2"],
                    "agentsStates":{
                        "child-1":{"status":"pendingInit","nickname":"reviewer","model":"gpt-5.4"},
                        "child-2":{"status":"completed","nickname":"writer","model":"gpt-5.4"}
                    }
                }
            }),
        );
        assert_eq!(events.len(), 2);
        let RuntimeEvent::SubagentDiscovered { run: queued } = &events[0].event else {
            panic!("expected discovered child");
        };
        assert_eq!(queued.id, "child-1");
        assert_eq!(queued.parent_id.as_deref(), Some("thread-a"));
        assert_eq!(queued.status, crate::runtime::events::AgentRunStatus::Queued);

        let RuntimeEvent::SubagentStatusChanged { run: done } = &events[1].event else {
            panic!("expected status-changed child");
        };
        assert_eq!(done.id, "child-2");
        assert_eq!(done.status, crate::runtime::events::AgentRunStatus::Completed);

        // Replay must not duplicate children.
        let replay = map(
            &mut mapper,
            &route,
            "item/completed",
            json!({
                "threadId":"thread-a",
                "turnId":"turn-a",
                "item":{
                    "type":"collabAgentToolCall",
                    "id":"item-collab",
                    "tool":"spawnAgent",
                    "senderThreadId":"thread-a",
                    "receiverThreadIds":["child-1"],
                    "agentsStates":{"child-1":{"status":"running"}}
                }
            }),
        );
        assert!(replay.is_empty());
    }

    #[test]
    fn codex_turn_lifecycle_is_ordered_and_completed_item_is_authoritative() {
        let mut mapper = CodexEventMapper::default();
        let route = route("main", "tab-a", "thread-a", Some("turn-a"));
        let mut events = Vec::new();

        events.extend(map(
            &mut mapper,
            &route,
            "thread/started",
            json!({"thread":{"id":"thread-a"}}),
        ));
        events.extend(map(
            &mut mapper,
            &route,
            "turn/started",
            json!({"threadId":"thread-a","turn":{"id":"turn-a","status":"inProgress","items":[]}}),
        ));
        events.extend(map(
            &mut mapper,
            &route,
            "item/agentMessage/delta",
            json!({"threadId":"thread-a","turnId":"turn-a","itemId":"item-a","delta":"hel"}),
        ));
        events.extend(map(
            &mut mapper,
            &route,
            "item/completed",
            json!({
                "threadId":"thread-a",
                "turnId":"turn-a",
                "completedAtMs": 10,
                "item":{"type":"agentMessage","id":"item-a","text":"hello"}
            }),
        ));
        events.extend(map(
            &mut mapper,
            &route,
            "turn/completed",
            json!({"threadId":"thread-a","turn":{"id":"turn-a","status":"completed","items":[]}}),
        ));

        assert_eq!(events.len(), 5);
        assert_eq!(
            events
                .iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![1, 2, 3, 4, 5]
        );
        assert!(events.iter().all(|event| {
            event.window_label == "main"
                && event.tab_id == "tab-a"
                && event.session_id.as_deref() == Some("thread-a")
        }));
        assert!(matches!(
            &events[0].event,
            RuntimeEvent::SessionStarted { session_id } if session_id == "thread-a"
        ));
        assert!(matches!(
            &events[1].event,
            RuntimeEvent::TurnStarted { turn_id } if turn_id == "turn-a"
        ));
        assert!(matches!(
            &events[2].event,
            RuntimeEvent::AssistantDelta { item_id, delta }
                if item_id == "item-a" && delta == "hel"
        ));
        assert!(matches!(
            &events[3].event,
            RuntimeEvent::AssistantCompleted { item_id, content }
                if item_id == "item-a" && content == "hello"
        ));
        assert!(matches!(
            &events[4].event,
            RuntimeEvent::TurnCompleted { turn_id } if turn_id == "turn-a"
        ));

        assert!(map(
            &mut mapper,
            &route,
            "item/completed",
            json!({
                "threadId":"thread-a",
                "turnId":"turn-a",
                "completedAtMs": 11,
                "item":{"type":"agentMessage","id":"item-a","text":"hello"}
            }),
        )
        .is_empty());
        assert!(map(
            &mut mapper,
            &route,
            "item/agentMessage/delta",
            json!({"threadId":"thread-a","turnId":"turn-a","itemId":"item-a","delta":"lo"}),
        )
        .is_empty());
        assert!(map(
            &mut mapper,
            &route,
            "turn/completed",
            json!({"threadId":"thread-a","turn":{"id":"turn-a","status":"completed","items":[]}}),
        )
        .is_empty());
    }

    #[test]
    fn codex_turn_sequences_and_protocol_ids_are_isolated_per_window_and_tab() {
        let mut mapper = CodexEventMapper::default();
        let route_a = route("main", "tab-a", "thread-a", Some("turn-a"));
        let route_b = route("second", "tab-b", "thread-b", Some("turn-b"));

        assert!(map(
            &mut mapper,
            &route_a,
            "item/agentMessage/delta",
            json!({"threadId":"thread-b","turnId":"turn-b","itemId":"wrong","delta":"wrong"}),
        )
        .is_empty());

        let first_a = map(
            &mut mapper,
            &route_a,
            "item/agentMessage/delta",
            json!({"threadId":"thread-a","turnId":"turn-a","itemId":"a","delta":"a"}),
        );
        let first_b = map(
            &mut mapper,
            &route_b,
            "item/agentMessage/delta",
            json!({"threadId":"thread-b","turnId":"turn-b","itemId":"b","delta":"b"}),
        );
        let second_a = map(
            &mut mapper,
            &route_a,
            "item/agentMessage/delta",
            json!({"threadId":"thread-a","turnId":"turn-a","itemId":"a","delta":"2"}),
        );

        assert_eq!(first_a[0].sequence, 1);
        assert_eq!(first_b[0].sequence, 1);
        assert_eq!(second_a[0].sequence, 2);
        assert_eq!(first_b[0].window_label, "second");
        assert_eq!(first_b[0].tab_id, "tab-b");
        assert_eq!(first_b[0].turn_id.as_deref(), Some("turn-b"));

        assert!(map(
            &mut mapper,
            &route_a,
            "turn/completed",
            json!({"threadId":"thread-b","token":"foreign-malformed-secret"}),
        )
        .is_empty());
    }

    #[test]
    fn codex_turn_stale_transport_generation_is_ignored_without_resetting_sequence() {
        let mut mapper = CodexEventMapper::default();
        let route = route("main", "tab-a", "thread-a", Some("turn-a"));
        let first = mapper.map_notification(
            0,
            &route,
            "item/agentMessage/delta",
            &json!({"threadId":"thread-a","turnId":"turn-a","itemId":"a","delta":"first"}),
        );
        assert_eq!(first[0].sequence, 1);

        mapper.set_generation(1);
        assert!(mapper
            .map_notification(
                0,
                &route,
                "item/agentMessage/delta",
                &json!({"threadId":"thread-a","turnId":"turn-a","itemId":"a","delta":"stale"}),
            )
            .is_empty());
        let current = mapper.map_notification(
            1,
            &route,
            "item/agentMessage/delta",
            &json!({"threadId":"thread-a","turnId":"turn-a","itemId":"a","delta":"current"}),
        );
        assert_eq!(current[0].sequence, 2);
    }

    #[test]
    fn codex_turn_terminal_completion_interrupt_and_error_are_idempotent() {
        let mut mapper = CodexEventMapper::default();
        let interrupted = route("main", "tab-i", "thread-i", Some("turn-i"));
        let failed = route("main", "tab-f", "thread-f", Some("turn-f"));

        let interrupted_event = map(
            &mut mapper,
            &interrupted,
            "turn/completed",
            json!({"threadId":"thread-i","turn":{"id":"turn-i","status":"interrupted","items":[]}}),
        );
        assert!(matches!(
            interrupted_event[0].event,
            RuntimeEvent::TurnInterrupted { .. }
        ));
        assert!(map(
            &mut mapper,
            &interrupted,
            "error",
            json!({
                "threadId":"thread-i","turnId":"turn-i","willRetry":false,
                "error":{"message":"late failure"}
            }),
        )
        .is_empty());

        let failed_event = map(
            &mut mapper,
            &failed,
            "error",
            json!({
                "threadId":"thread-f","turnId":"turn-f","willRetry":false,
                "error":{"message":"failed once"}
            }),
        );
        assert!(matches!(
            &failed_event[0].event,
            RuntimeEvent::TurnFailed { turn_id, message }
                if turn_id.as_deref() == Some("turn-f") && message == "failed once"
        ));
        assert!(map(
            &mut mapper,
            &failed,
            "turn/completed",
            json!({"threadId":"thread-f","turn":{"id":"turn-f","status":"completed","items":[]}}),
        )
        .is_empty());
    }

    #[test]
    fn immediate_non_progress_turn_statuses_are_all_terminal_including_unknown() {
        let mut mapper = CodexEventMapper::default();
        for (index, status) in ["completed", "interrupted", "failed", "futureTerminal"]
            .into_iter()
            .enumerate()
        {
            let thread = format!("thread-{index}");
            let turn = format!("turn-{index}");
            let route = route("main", &format!("tab-{index}"), &thread, Some(&turn));
            let events = map(
                &mut mapper,
                &route,
                "turn/completed",
                json!({
                    "threadId": thread,
                    "turn": {"id": turn, "status": status, "error": {"message": "failed"}}
                }),
            );
            assert_eq!(events.len(), 1, "status={status}");
            match status {
                "completed" => assert!(matches!(
                    events[0].event,
                    RuntimeEvent::TurnCompleted { .. }
                )),
                "interrupted" => assert!(matches!(
                    events[0].event,
                    RuntimeEvent::TurnInterrupted { .. }
                )),
                "failed" => assert!(matches!(events[0].event, RuntimeEvent::TurnFailed { .. })),
                _ => assert!(matches!(
                    &events[0].event,
                    RuntimeEvent::TurnFailed { message, .. }
                        if message.contains("unknown status")
                )),
            }
            assert!(mapper
                .terminal_turns
                .iter()
                .any(|terminal| { terminal.tab_id == route.tab_id && terminal.turn_id == turn }));
        }
    }

    #[test]
    fn malformed_completed_status_is_terminal_but_in_progress_remains_open() {
        let mut mapper = CodexEventMapper::default();
        for (index, status) in [None, Some(Value::Null), Some(json!(42))]
            .into_iter()
            .enumerate()
        {
            let thread = format!("thread-malformed-{index}");
            let turn = format!("turn-malformed-{index}");
            let route = route(
                "main",
                &format!("tab-malformed-{index}"),
                &thread,
                Some(&turn),
            );
            let mut params = json!({"threadId": thread, "turn": {"id": turn}});
            if let Some(status) = status {
                params["turn"]["status"] = status;
            }
            let events = map(&mut mapper, &route, "turn/completed", params);
            assert!(matches!(
                &events[0].event,
                RuntimeEvent::TurnFailed { message, .. }
                    if message.contains("Malformed Codex")
            ));
            assert!(mapper
                .terminal_turns
                .iter()
                .any(|terminal| terminal.turn_id == turn));
        }

        let open = route("main", "tab-open", "thread-open", Some("turn-open"));
        let events = map(
            &mut mapper,
            &open,
            "turn/completed",
            json!({
                "threadId": "thread-open",
                "turn": {"id": "turn-open", "status": "inProgress"}
            }),
        );
        assert!(matches!(events[0].event, RuntimeEvent::Warning { .. }));
        assert!(!mapper
            .terminal_turns
            .iter()
            .any(|terminal| terminal.turn_id == "turn-open"));
    }

    #[test]
    fn codex_turn_retrying_error_warns_without_ending_the_turn() {
        let mut mapper = CodexEventMapper::default();
        let route = route("main", "tab-a", "thread-a", Some("turn-a"));

        let retry = map(
            &mut mapper,
            &route,
            "error",
            json!({
                "threadId":"thread-a","turnId":"turn-a","willRetry":true,
                "error":{"message":"temporary"}
            }),
        );
        assert!(matches!(
            &retry[0].event,
            RuntimeEvent::Warning { message } if message.contains("temporary")
        ));

        let exhausted_retry = map(
            &mut mapper,
            &route,
            "error",
            json!({
                "threadId":"thread-a","turnId":"turn-a","willRetry":true,
                "error":{"message":"Reconnecting... 5/5","additionalDetails":"request timed out"}
            }),
        );
        assert!(matches!(
            &exhausted_retry[0].event,
            RuntimeEvent::Warning { message }
                if message.contains("Reconnecting... 5/5")
                    && message.to_ascii_lowercase().contains("timed out")
        ));
        assert!(mapper
            .terminal_turns
            .iter()
            .all(|terminal| terminal.turn_id != "turn-a"));

        let late_delta = map(
            &mut mapper,
            &route,
            "item/agentMessage/delta",
            json!({
                "threadId":"thread-a","turnId":"turn-a",
                "itemId":"msg-1","delta":"hello"
            }),
        );
        assert!(matches!(
            &late_delta[0].event,
            RuntimeEvent::AssistantDelta { delta, .. } if delta == "hello"
        ));

        let hard_fail = map(
            &mut mapper,
            &route,
            "error",
            json!({
                "threadId":"thread-a","turnId":"turn-a","willRetry":false,
                "error":{"message":"request failed permanently"}
            }),
        );
        assert!(matches!(
            &hard_fail[0].event,
            RuntimeEvent::TurnFailed { message, .. } if message.contains("request failed permanently")
        ));
    }

    #[test]
    fn codex_turn_event_strings_are_redacted_and_raw_sensitive_fields_are_not_forwarded() {
        let mut mapper = CodexEventMapper::default();
        let route = route("main", "tab-a", "thread-a", Some("turn-a"));
        let events = map(
            &mut mapper,
            &route,
            "error",
            json!({
                "threadId":"thread-a","turnId":"turn-a","willRetry":false,
                "error":{
                    "message":"Authorization: Bearer bearer-secret token=token-secret",
                    "apiKey":"raw-secret"
                }
            }),
        );
        let wire = serde_json::to_string(&events).unwrap();
        assert!(!wire.contains("bearer-secret"));
        assert!(!wire.contains("token-secret"));
        assert!(!wire.contains("raw-secret"));
        assert!(wire.contains("[REDACTED]"));
    }

    #[test]
    fn codex_turn_unknown_items_and_notifications_degrade_without_forwarding_raw_payloads() {
        let mut mapper = CodexEventMapper::default();
        let route = route("main", "tab-a", "thread-a", Some("turn-a"));

        let item = map(
            &mut mapper,
            &route,
            "item/completed",
            json!({
                "threadId":"thread-a","turnId":"turn-a","completedAtMs":10,
                "item":{"type":"futureSecretItem","id":"future-a","apiKey":"do-not-forward"}
            }),
        );
        assert!(matches!(
            &item[0].event,
            RuntimeEvent::Unknown { native_type } if native_type == "futureSecretItem"
        ));
        assert!(!serde_json::to_string(&item)
            .unwrap()
            .contains("do-not-forward"));

        let notification = map(
            &mut mapper,
            &route,
            "future/notification",
            json!({
                "threadId":"thread-a","turnId":"turn-a","apiKey":"also-do-not-forward"
            }),
        );
        assert!(matches!(
            &notification[0].event,
            RuntimeEvent::Unknown { native_type } if native_type == "future/notification"
        ));
        assert!(!serde_json::to_string(&notification)
            .unwrap()
            .contains("also-do-not-forward"));

        let malformed = map(
            &mut mapper,
            &route,
            "turn/completed",
            json!({"threadId":"thread-a","token":"malformed-secret"}),
        );
        assert!(matches!(
            &malformed[0].event,
            RuntimeEvent::Warning { message } if message.contains("Malformed Codex `turn/completed`")
        ));
        assert!(!serde_json::to_string(&malformed)
            .unwrap()
            .contains("malformed-secret"));
    }

    #[test]
    fn codex_turn_agent_message_without_text_completes_empty_and_is_idempotent() {
        let mut mapper = CodexEventMapper::default();
        let route = route("main", "tab-a", "thread-a", Some("turn-a"));
        let empty = map(
            &mut mapper,
            &route,
            "item/completed",
            json!({
                "threadId":"thread-a","turnId":"turn-a",
                "item":{"type":"agentMessage","id":"item-a"}
            }),
        );
        assert!(matches!(
            &empty[0].event,
            RuntimeEvent::AssistantCompleted { content, .. } if content.is_empty()
        ));

        assert!(map(
            &mut mapper,
            &route,
            "item/completed",
            json!({
                "threadId":"thread-a","turnId":"turn-a","completedAtMs":10,
                "item":{"type":"agentMessage","id":"item-a","text":"complete"}
            }),
        )
        .is_empty());
    }

    #[test]
    fn codex_reasoning_item_maps_to_summary_delta_without_blocking_turn() {
        let mut mapper = CodexEventMapper::default();
        let route = route("main", "tab-a", "thread-a", Some("turn-a"));
        let reasoning = map(
            &mut mapper,
            &route,
            "item/completed",
            json!({
                "threadId":"thread-a","turnId":"turn-a",
                "item":{
                    "type":"reasoning",
                    "id":"reason-a",
                    "summary":[{"text":"Checking the file"}],
                    "content":[]
                }
            }),
        );
        assert!(matches!(
            &reasoning[0].event,
            RuntimeEvent::ReasoningSummaryDelta { item_id, delta }
                if item_id == "reason-a" && delta == "Checking the file"
        ));

        let completed = map(
            &mut mapper,
            &route,
            "turn/completed",
            json!({"threadId":"thread-a","turn":{"id":"turn-a","status":"completed"}}),
        );
        assert!(matches!(
            completed[0].event,
            RuntimeEvent::TurnCompleted { .. }
        ));
    }

    #[test]
    fn nested_json_turn_failure_message_is_unwrapped() {
        let mut mapper = CodexEventMapper::default();
        let route = route("main", "tab-a", "thread-a", Some("turn-a"));
        let failed = map(
            &mut mapper,
            &route,
            "turn/completed",
            json!({
                "threadId":"thread-a",
                "turn":{
                    "id":"turn-a",
                    "status":"failed",
                    "error":{
                        "message":"{\n  \"error\": {\n    \"message\": \"Unsupported value: 'minimal'\",\n    \"type\": \"invalid_request_error\"\n  }\n}"
                    }
                }
            }),
        );
        assert!(matches!(
            &failed[0].event,
            RuntimeEvent::TurnFailed { message, .. }
                if message.contains("Unsupported value: 'minimal'")
                    && !message.contains("invalid_request_error")
        ));
    }

    #[test]
    fn codex_turn_transport_failure_is_ordered_redacted_and_terminal_once() {
        let mut mapper = CodexEventMapper::default();
        let route = route("main", "tab-a", "thread-a", Some("turn-a"));
        let failure = mapper
            .map_transport_failure(
                0,
                &route,
                "transport closed: Authorization: Bearer transport-secret",
            )
            .expect("active turn should fail on transport reset");

        assert_eq!(failure.sequence, 1);
        assert!(matches!(
            &failure.event,
            RuntimeEvent::TurnFailed { turn_id, message }
                if turn_id.as_deref() == Some("turn-a")
                    && message.contains("[REDACTED]")
                    && !message.contains("transport-secret")
        ));
        assert!(mapper
            .map_transport_failure(0, &route, "duplicate")
            .is_none());
        assert!(map(
            &mut mapper,
            &route,
            "turn/completed",
            json!({"threadId":"thread-a","turn":{"id":"turn-a","status":"completed","items":[]}}),
        )
        .is_empty());

        mapper.set_generation(1);
        assert!(mapper.map_transport_failure(0, &route, "stale").is_none());
    }

    #[test]
    fn codex_turn_remove_route_clears_idempotence_and_sequence_state() {
        let mut mapper = CodexEventMapper::default();
        let route = route("main", "tab-a", "thread-a", Some("turn-a"));
        let terminal = map(
            &mut mapper,
            &route,
            "turn/completed",
            json!({"threadId":"thread-a","turn":{"id":"turn-a","status":"completed","items":[]}}),
        );
        assert_eq!(terminal[0].sequence, 1);

        mapper.remove_route("main", "tab-a");
        let reused = map(
            &mut mapper,
            &route,
            "turn/started",
            json!({"threadId":"thread-a","turn":{"id":"turn-a","status":"inProgress","items":[]}}),
        );
        assert_eq!(reused[0].sequence, 1);
        assert!(matches!(reused[0].event, RuntimeEvent::TurnStarted { .. }));
    }

    #[test]
    fn codex_turn_mapper_terminal_history_is_bounded() {
        let mut mapper = CodexEventMapper::default();
        for index in 0..(RECENT_TERMINAL_LIMIT + 32) {
            let thread = format!("thread-{index}");
            let turn = format!("turn-{index}");
            let route = route("main", "tab-a", &thread, Some(&turn));
            assert_eq!(
                map(
                    &mut mapper,
                    &route,
                    "turn/completed",
                    json!({"threadId":thread,"turn":{"id":turn,"status":"completed","items":[]}}),
                )
                .len(),
                1
            );
        }

        assert_eq!(mapper.terminal_turns.len(), RECENT_TERMINAL_LIMIT);
        assert_eq!(mapper.recent_terminal_turns.len(), RECENT_TERMINAL_LIMIT);
    }
}
