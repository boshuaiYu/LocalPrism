use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{oneshot, Mutex};

use super::rpc::RpcId;

#[derive(Debug)]
pub struct PendingRuntimeRequest {
    pub id: RpcId,
    pub method: String,
    pub window_label: String,
    pub tab_id: String,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub created_at: Instant,
    pub payload: Value,
    pub responder: Option<oneshot::Sender<ResolveRuntimeRequest>>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeRequestDecision {
    Allow,
    AllowForSession,
    Deny,
    Cancel,
    Unsupported,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolveRuntimeRequest {
    pub request_id: RpcId,
    pub decision: RuntimeRequestDecision,
    pub persistence: Option<String>,
    #[serde(default)]
    pub answers: HashMap<String, Vec<String>>,
}

#[derive(Default)]
pub struct ApprovalState {
    pending: Mutex<HashMap<String, PendingRuntimeRequest>>,
    ui_ready: AtomicBool,
}

impl ApprovalState {
    pub fn set_ui_ready(&self, ready: bool) {
        self.ui_ready.store(ready, Ordering::SeqCst);
    }

    pub fn is_ui_ready(&self) -> bool {
        self.ui_ready.load(Ordering::SeqCst)
    }

    pub async fn pending_count(&self) -> usize {
        self.pending.lock().await.len()
    }

    pub async fn register(
        &self,
        request: PendingRuntimeRequest,
    ) -> Result<(), String> {
        let key = rpc_id_key(&request.id);
        let mut pending = self.pending.lock().await;
        if pending.contains_key(&key) {
            return Err(format!("Duplicate pending runtime request `{key}`"));
        }
        pending.insert(key, request);
        Ok(())
    }

    pub async fn take(&self, request_id: &RpcId) -> Option<PendingRuntimeRequest> {
        let key = rpc_id_key(request_id);
        self.pending.lock().await.remove(&key)
    }

    pub async fn resolve(
        &self,
        request: ResolveRuntimeRequest,
    ) -> Result<(), String> {
        let pending = self
            .take(&request.request_id)
            .await
            .ok_or_else(|| "Unknown or already resolved runtime request".to_string())?;
        if let Some(responder) = pending.responder {
            let _ = responder.send(request);
            Ok(())
        } else {
            Err("Runtime request has no active responder".into())
        }
    }

    pub async fn cancel_for_turn(&self, thread_id: &str, turn_id: &str) -> Vec<RpcId> {
        let mut pending = self.pending.lock().await;
        let keys = pending
            .iter()
            .filter(|(_, request)| {
                request.thread_id.as_deref() == Some(thread_id)
                    && request.turn_id.as_deref() == Some(turn_id)
            })
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        let mut cancelled = Vec::new();
        for key in keys {
            if let Some(mut request) = pending.remove(&key) {
                cancelled.push(request.id.clone());
                if let Some(responder) = request.responder.take() {
                    let _ = responder.send(ResolveRuntimeRequest {
                        request_id: request.id.clone(),
                        decision: RuntimeRequestDecision::Cancel,
                        persistence: None,
                        answers: HashMap::new(),
                    });
                }
            }
        }
        cancelled
    }

    pub async fn clear_all_with_cancel(&self) -> usize {
        let mut pending = self.pending.lock().await;
        let count = pending.len();
        for (_, mut request) in pending.drain() {
            if let Some(responder) = request.responder.take() {
                let _ = responder.send(ResolveRuntimeRequest {
                    request_id: request.id.clone(),
                    decision: RuntimeRequestDecision::Cancel,
                    persistence: None,
                    answers: HashMap::new(),
                });
            }
        }
        count
    }
}

pub fn rpc_id_key(id: &RpcId) -> String {
    match id {
        RpcId::Number(value) => format!("n:{value}"),
        RpcId::String(value) => format!("s:{value}"),
    }
}

pub fn is_codex_approval_request(method: &str) -> bool {
    matches!(
        method,
        "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval"
            | "item/tool/requestUserInput"
    )
}

pub fn map_decision_to_response(
    method: &str,
    params: &Value,
    decision: &RuntimeRequestDecision,
    persistence: Option<&str>,
    answers: &HashMap<String, Vec<String>>,
) -> Result<Value, (i64, String)> {
    match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            let decision = match decision {
                RuntimeRequestDecision::Allow => "accept",
                RuntimeRequestDecision::AllowForSession => "acceptForSession",
                RuntimeRequestDecision::Deny => "decline",
                RuntimeRequestDecision::Cancel => "cancel",
                RuntimeRequestDecision::Unsupported => {
                    return Err((-32601, "Method not found".into()));
                }
            };
            Ok(json!({ "decision": decision }))
        }
        "item/permissions/requestApproval" => {
            let permissions = params
                .get("permissions")
                .or_else(|| params.get("requestedPermissions"))
                .or_else(|| params.get("grantedPermissions"))
                .cloned()
                .unwrap_or_else(|| json!({}));
            match decision {
                RuntimeRequestDecision::Allow | RuntimeRequestDecision::AllowForSession => {
                    let scope = persistence
                        .filter(|value| *value == "session")
                        .unwrap_or("turn");
                    Ok(json!({
                        "permissions": permissions,
                        "scope": scope,
                    }))
                }
                RuntimeRequestDecision::Deny | RuntimeRequestDecision::Cancel => Ok(json!({
                    "permissions": {},
                    "scope": "turn",
                })),
                RuntimeRequestDecision::Unsupported => {
                    Err((-32601, "Method not found".into()))
                }
            }
        }
        "item/tool/requestUserInput" => {
            if matches!(
                decision,
                RuntimeRequestDecision::Deny
                    | RuntimeRequestDecision::Cancel
                    | RuntimeRequestDecision::Unsupported
            ) {
                return Err((-32000, "User input cancelled".into()));
            }
            let mut mapped = serde_json::Map::new();
            for (question_id, values) in answers {
                mapped.insert(
                    question_id.clone(),
                    json!({ "answers": values }),
                );
            }
            Ok(json!({ "answers": mapped }))
        }
        _ => Err((-32601, "Method not found".into())),
    }
}

pub fn auto_accept_response(method: &str, params: &Value) -> Value {
    map_decision_to_response(
        method,
        params,
        &RuntimeRequestDecision::Allow,
        Some("turn"),
        &HashMap::new(),
    )
    .unwrap_or_else(|_| json!({ "decision": "accept" }))
}

pub fn redact_request_details(params: &Value) -> Value {
    let mut safe = json!({});
    if let Some(object) = safe.as_object_mut() {
        for key in [
            "command",
            "cwd",
            "path",
            "diff",
            "title",
            "permissions",
            "requestedPermissions",
            "questions",
            "tool",
        ] {
            if let Some(value) = params.get(key) {
                object.insert(key.to_owned(), value.clone());
            }
        }
    }
    safe
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn resolve_is_exactly_once_and_unknown_is_rejected() {
        let state = ApprovalState::default();
        let (tx, mut rx) = oneshot::channel();
        state
            .register(PendingRuntimeRequest {
                id: RpcId::Number(7),
                method: "item/commandExecution/requestApproval".into(),
                window_label: "main".into(),
                tab_id: "tab-1".into(),
                thread_id: Some("thread-1".into()),
                turn_id: Some("turn-1".into()),
                created_at: Instant::now(),
                payload: json!({"command":"pwd"}),
                responder: Some(tx),
            })
            .await
            .unwrap();
        assert_eq!(state.pending_count().await, 1);

        state
            .resolve(ResolveRuntimeRequest {
                request_id: RpcId::Number(7),
                decision: RuntimeRequestDecision::Deny,
                persistence: None,
                answers: HashMap::new(),
            })
            .await
            .unwrap();
        assert_eq!(
            rx.try_recv().unwrap().decision,
            RuntimeRequestDecision::Deny
        );
        assert_eq!(state.pending_count().await, 0);
        assert!(
            state
                .resolve(ResolveRuntimeRequest {
                    request_id: RpcId::Number(7),
                    decision: RuntimeRequestDecision::Allow,
                    persistence: None,
                    answers: HashMap::new(),
                })
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn cancel_for_turn_clears_matching_requests() {
        let state = ApprovalState::default();
        let (tx, mut rx) = oneshot::channel();
        state
            .register(PendingRuntimeRequest {
                id: RpcId::String("a".into()),
                method: "item/fileChange/requestApproval".into(),
                window_label: "main".into(),
                tab_id: "tab-1".into(),
                thread_id: Some("thread-1".into()),
                turn_id: Some("turn-1".into()),
                created_at: Instant::now(),
                payload: json!({}),
                responder: Some(tx),
            })
            .await
            .unwrap();
        let cancelled = state.cancel_for_turn("thread-1", "turn-1").await;
        assert_eq!(cancelled, vec![RpcId::String("a".into())]);
        assert_eq!(
            rx.try_recv().unwrap().decision,
            RuntimeRequestDecision::Cancel
        );
        assert_eq!(state.pending_count().await, 0);
    }

    #[test]
    fn decision_mapping_covers_command_permissions_and_user_input() {
        let accept = map_decision_to_response(
            "item/commandExecution/requestApproval",
            &json!({}),
            &RuntimeRequestDecision::AllowForSession,
            None,
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(accept, json!({"decision":"acceptForSession"}));

        let permissions = map_decision_to_response(
            "item/permissions/requestApproval",
            &json!({"permissions":{"network":true}}),
            &RuntimeRequestDecision::Allow,
            Some("session"),
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(
            permissions,
            json!({"permissions":{"network":true},"scope":"session"})
        );

        let mut answers = HashMap::new();
        answers.insert("q1".into(), vec!["yes".into()]);
        let input = map_decision_to_response(
            "item/tool/requestUserInput",
            &json!({}),
            &RuntimeRequestDecision::Allow,
            None,
            &answers,
        )
        .unwrap();
        assert_eq!(
            input,
            json!({"answers":{"q1":{"answers":["yes"]}}})
        );

        assert!(
            map_decision_to_response(
                "future/method",
                &json!({}),
                &RuntimeRequestDecision::Allow,
                None,
                &HashMap::new(),
            )
            .is_err()
        );
    }
}
