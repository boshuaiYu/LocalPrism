//! Last Codex Responses request in one Claude spawn.
//!
//! A tool loop sends several upstream requests, and Claude Code's `result.usage`
//! adds them together. The context meter needs the last request, so each spawn
//! gets its own slot and the result line is rewritten before the UI sees it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};

use serde_json::{json, Value};

const SLOT_ENV: &str = "LOCALPRISM_CODEX_USAGE_SLOT";

static NEXT_SLOT: AtomicU64 = AtomicU64::new(1);
static SLOTS: LazyLock<Mutex<HashMap<u64, Vec<CodexRequestUsage>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CodexRequestUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
}

pub struct UsageSlotGuard(u64);

impl UsageSlotGuard {
    pub fn id(&self) -> u64 {
        self.0
    }
}

impl Drop for UsageSlotGuard {
    fn drop(&mut self) {
        drop_slot(self.0);
    }
}

pub fn register_slot() -> u64 {
    let mut id = NEXT_SLOT.fetch_add(1, Ordering::Relaxed);
    if id == 0 {
        id = NEXT_SLOT.fetch_add(1, Ordering::Relaxed);
    }
    with_slots(|slots| {
        slots.insert(id, Vec::new());
    });
    id
}

/// Root conversation requests update the turn slot. A sub-agent (Task tool,
/// teammate) shares the proxy and must not overwrite the root `result.usage`.
///
/// Claude Code marks those requests with an agent id header or with
/// `agent_id` / `parent_tool_use_id` on the body or its metadata. Message
/// text is not scanned.
pub fn subagent_marker(header_agent_id: Option<&str>, body: &Value) -> Option<String> {
    if let Some(marker) = header_agent_id.and_then(non_empty_text) {
        return Some(marker);
    }
    agent_id_in(body)
        .or_else(|| body.get("metadata").and_then(agent_id_in))
        .or_else(|| marker_in_user_id(body.get("user_id")))
        .or_else(|| {
            body.get("metadata")
                .and_then(|value| marker_in_user_id(value.get("user_id")))
        })
        .or_else(|| parent_tool_in(body))
        .or_else(|| body.get("metadata").and_then(parent_tool_in))
}

fn agent_id_in(value: &Value) -> Option<String> {
    field_in(value, &["agent_id", "agentId"])
}

fn parent_tool_in(value: &Value) -> Option<String> {
    field_in(value, &["parent_tool_use_id", "parentToolUseId"])
}

fn field_in(value: &Value, keys: &[&str]) -> Option<String> {
    let object = value.as_object()?;
    for key in keys {
        if let Some(marker) = object
            .get(*key)
            .and_then(Value::as_str)
            .and_then(non_empty_text)
        {
            return Some(marker);
        }
    }
    None
}

fn marker_in_user_id(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    if text.starts_with('{') {
        if let Ok(parsed) = serde_json::from_str::<Value>(text) {
            return agent_id_in(&parsed).or_else(|| parent_tool_in(&parsed));
        }
    }
    None
}

fn non_empty_text(value: &str) -> Option<String> {
    let text = value.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

pub fn record(slot: u64, usage: CodexRequestUsage) {
    if slot == 0 {
        return;
    }
    with_slots(|slots| {
        if let Some(entries) = slots.get_mut(&slot) {
            entries.push(usage);
        }
    });
}

pub fn last(slot: u64) -> Option<CodexRequestUsage> {
    if slot == 0 {
        return None;
    }
    with_slots(|slots| slots.get(&slot).and_then(|entries| entries.last().copied()))
}

pub fn drop_slot(slot: u64) {
    if slot == 0 {
        return;
    }
    with_slots(|slots| {
        slots.remove(&slot);
    });
}

/// Read the slot id the provider proxy registered, then remove it so the
/// Claude child process never sees the variable.
pub fn take_slot_env(cmd: &mut tokio::process::Command) -> Option<UsageSlotGuard> {
    let raw = cmd.as_std().get_envs().find_map(|(key, value)| {
        if key == SLOT_ENV {
            value.map(|value| value.to_string_lossy().into_owned())
        } else {
            None
        }
    });
    cmd.env_remove(SLOT_ENV);
    let id = raw?.parse::<u64>().ok().filter(|id| *id != 0)?;
    Some(UsageSlotGuard(id))
}

/// Replace `result.usage` with the last upstream request in this turn.
pub fn rewrite_result_line(line: &str, slot: u64) -> Option<String> {
    let usage = last(slot)?;
    let mut value: Value = serde_json::from_str(line).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("result") {
        return None;
    }
    let object = value.as_object_mut()?;
    let usage_value = object.entry("usage").or_insert_with(|| json!({}));
    if !usage_value.is_object() {
        *usage_value = json!({});
    }
    let usage_object = usage_value.as_object_mut()?;
    usage_object.insert("input_tokens".to_string(), json!(usage.input_tokens));
    usage_object.insert("output_tokens".to_string(), json!(usage.output_tokens));
    usage_object.insert(
        "cache_read_input_tokens".to_string(),
        json!(usage.cache_read_tokens),
    );
    usage_object.insert(
        "cache_creation_input_tokens".to_string(),
        json!(usage.cache_creation_tokens),
    );
    Some(value.to_string())
}

fn with_slots<T>(f: impl FnOnce(&mut HashMap<u64, Vec<CodexRequestUsage>>) -> T) -> T {
    let mut guard = SLOTS.lock().unwrap_or_else(|err| err.into_inner());
    f(&mut guard)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multi_request_turn_panel_uses_the_last_request_not_the_sum() {
        let slot = register_slot();
        record(
            slot,
            CodexRequestUsage {
                input_tokens: 18_898,
                output_tokens: 20,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
            },
        );
        record(
            slot,
            CodexRequestUsage {
                input_tokens: 19_731,
                output_tokens: 222,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
            },
        );
        record(
            slot,
            CodexRequestUsage {
                input_tokens: 23_242,
                output_tokens: 148,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
            },
        );
        let line = r#"{"type":"result","subtype":"success","result":"done","usage":{"input_tokens":61871,"output_tokens":390,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"server_tool_use":{"web_search_requests":1}}}"#;
        let rewritten = rewrite_result_line(line, slot).expect("rewrite");
        let value: Value = serde_json::from_str(&rewritten).expect("json");
        assert_eq!(value["type"], "result");
        assert_eq!(value["subtype"], "success");
        assert_eq!(value["usage"]["input_tokens"], 23_242);
        assert_eq!(value["usage"]["output_tokens"], 148);
        assert_eq!(value["usage"]["cache_read_input_tokens"], 0);
        assert_eq!(value["usage"]["cache_creation_input_tokens"], 0);
        assert_eq!(value["usage"]["server_tool_use"]["web_search_requests"], 1);
        assert_ne!(value["usage"]["input_tokens"], 61_871);
        assert_ne!(value["usage"]["output_tokens"], 390);
        drop_slot(slot);
    }

    #[test]
    fn take_slot_env_reads_and_removes_the_spawn_slot() {
        let slot = register_slot();
        let mut cmd = tokio::process::Command::new("true");
        cmd.env(SLOT_ENV, slot.to_string());
        cmd.env("ANTHROPIC_BASE_URL", "http://127.0.0.1:9");
        let guard = take_slot_env(&mut cmd).expect("slot");
        assert_eq!(guard.id(), slot);
        let envs: Vec<(String, Option<String>)> = cmd
            .as_std()
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect();
        assert!(!envs
            .iter()
            .any(|(key, value)| key == SLOT_ENV && value.is_some()));
        assert!(envs
            .iter()
            .any(|(key, value)| key == "ANTHROPIC_BASE_URL" && value.is_some()));
        drop(guard);
        assert!(last(slot).is_none());
    }

    #[test]
    fn interleaved_subagent_request_does_not_overwrite_root_usage() {
        let slot = register_slot();
        let root = json!({
            "metadata": { "user_id": "{\"session_id\":\"sess_abc\"}" },
            "messages": [{ "role": "user", "content": "Read main.tex" }]
        });
        let subagent = json!({
            "metadata": {
                "user_id": "{\"session_id\":\"sess_abc\",\"agent_id\":\"writer\"}",
                "parent_tool_use_id": "toolu_sub"
            },
            "messages": [{ "role": "user", "content": "parent_tool_use_id is only metadata" }]
        });
        assert!(subagent_marker(None, &root).is_none());
        assert_eq!(
            subagent_marker(Some("writer"), &root).as_deref(),
            Some("writer")
        );
        assert_eq!(subagent_marker(None, &subagent).as_deref(), Some("writer"));

        let record_root = |usage: CodexRequestUsage, body: &Value, header: Option<&str>| {
            if subagent_marker(header, body).is_none() {
                record(slot, usage);
            }
        };
        record_root(
            CodexRequestUsage {
                input_tokens: 18_894,
                output_tokens: 32,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
            },
            &root,
            None,
        );
        record_root(
            CodexRequestUsage {
                input_tokens: 99_999,
                output_tokens: 10,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
            },
            &subagent,
            Some("writer"),
        );
        record_root(
            CodexRequestUsage {
                input_tokens: 22_400,
                output_tokens: 63,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
            },
            &root,
            None,
        );

        let line = r#"{"type":"result","usage":{"input_tokens":41300,"output_tokens":95,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}"#;
        let rewritten = rewrite_result_line(line, slot).expect("rewrite");
        let value: Value = serde_json::from_str(&rewritten).expect("json");
        assert_eq!(value["usage"]["input_tokens"], 22_400);
        assert_eq!(value["usage"]["output_tokens"], 63);
        assert_ne!(value["usage"]["input_tokens"], 99_999);
        assert_ne!(value["usage"]["input_tokens"], 41_300);
        drop_slot(slot);
    }
}
