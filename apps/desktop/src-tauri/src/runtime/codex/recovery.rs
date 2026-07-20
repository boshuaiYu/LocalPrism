use super::protocol::Thread;
use crate::runtime::events::{AgentRun, AgentRunStatus};
use crate::runtime::RuntimeKind;
use std::collections::{HashMap, HashSet};

/// Rebuild Codex child AgentRun rows from a project `thread/list` page set.
///
/// Keeps only descendants of `root_conversation_id` (never the root itself).
/// Prefers `ancestorThreadId` when present; otherwise walks `parentThreadId`.
pub fn recover_agent_runs_from_threads(
    root_conversation_id: &str,
    threads: &[Thread],
) -> Vec<AgentRun> {
    let by_id = threads
        .iter()
        .map(|thread| (thread.id.as_str(), thread))
        .collect::<HashMap<_, _>>();
    let mut recovered = Vec::new();

    for thread in threads {
        if thread.id == root_conversation_id {
            continue;
        }
        if !is_descendant_of(thread, root_conversation_id, &by_id) {
            continue;
        }
        let parent_id = thread
            .parent_thread_id
            .clone()
            .or_else(|| {
                // Fall back to root when ancestry confirms membership but parent is absent.
                Some(root_conversation_id.to_owned())
            });
        let status = map_thread_status(thread.status_name());
        let agent_name = thread
            .nickname
            .as_deref()
            .or(thread.name.as_deref())
            .unwrap_or("subagent")
            .to_owned();
        let completed_at = is_terminal(status).then_some(thread.updated_at);
        recovered.push(AgentRun {
            id: thread.id.clone(),
            parent_id,
            root_conversation_id: root_conversation_id.to_owned(),
            runtime: RuntimeKind::Codex,
            agent_name,
            agent_role: thread.name.clone(),
            model: thread.model.clone(),
            status,
            started_at: thread.updated_at,
            completed_at,
            activity: Some(thread.status_name().to_owned()),
            summary: if thread.preview.trim().is_empty() {
                None
            } else {
                Some(thread.preview.clone())
            },
            error: None,
            transcript_available: true,
        });
    }

    recovered.sort_by(|left, right| {
        left.started_at
            .cmp(&right.started_at)
            .then(left.id.cmp(&right.id))
    });
    recovered
}

fn is_descendant_of(
    thread: &Thread,
    root: &str,
    by_id: &HashMap<&str, &Thread>,
) -> bool {
    if thread
        .ancestor_thread_id
        .as_deref()
        .is_some_and(|ancestor| ancestor == root)
    {
        return true;
    }

    let mut current = thread.parent_thread_id.as_deref();
    let mut seen = HashSet::new();
    seen.insert(thread.id.as_str());
    while let Some(parent_id) = current {
        if parent_id == root {
            return true;
        }
        if !seen.insert(parent_id) {
            break;
        }
        current = by_id
            .get(parent_id)
            .and_then(|parent| parent.parent_thread_id.as_deref());
    }
    false
}

fn map_thread_status(status: &str) -> AgentRunStatus {
    match status {
        "pending" | "pendingInit" | "queued" => AgentRunStatus::Queued,
        "inProgress" | "running" | "busy" | "waiting" => AgentRunStatus::Running,
        "failed" | "errored" | "error" => AgentRunStatus::Failed,
        "interrupted" | "shutdown" | "cancelled" | "canceled" => AgentRunStatus::Cancelled,
        "completed" | "idle" | "closed" => AgentRunStatus::Completed,
        _ => AgentRunStatus::Completed,
    }
}

fn is_terminal(status: AgentRunStatus) -> bool {
    matches!(
        status,
        AgentRunStatus::Completed | AgentRunStatus::Failed | AgentRunStatus::Cancelled
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn thread(
        id: &str,
        parent: Option<&str>,
        ancestor: Option<&str>,
        status: &str,
        nickname: &str,
    ) -> Thread {
        serde_json::from_value(json!({
            "id": id,
            "preview": format!("preview-{id}"),
            "cwd": "/tmp/paper",
            "updatedAt": 1_000,
            "status": { "type": status },
            "turns": [],
            "parentThreadId": parent,
            "ancestorThreadId": ancestor,
            "name": nickname,
            "nickname": nickname,
            "model": "gpt-5.4",
        }))
        .expect("thread fixture")
    }

    #[test]
    fn recover_agent_runs_pages_ancestry_and_excludes_unrelated_roots() {
        let threads = vec![
            thread("root", None, None, "idle", "root"),
            thread("child", Some("root"), Some("root"), "running", "reviewer"),
            thread(
                "grandchild",
                Some("child"),
                Some("root"),
                "completed",
                "writer",
            ),
            thread("other-root", None, None, "idle", "other"),
            thread(
                "other-child",
                Some("other-root"),
                Some("other-root"),
                "running",
                "spy",
            ),
        ];

        let recovered = recover_agent_runs_from_threads("root", &threads);
        let ids = recovered
            .iter()
            .map(|run| run.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["child", "grandchild"]);
        assert_eq!(recovered[0].parent_id.as_deref(), Some("root"));
        assert_eq!(recovered[0].status, AgentRunStatus::Running);
        assert_eq!(recovered[1].parent_id.as_deref(), Some("child"));
        assert_eq!(recovered[1].status, AgentRunStatus::Completed);
        assert!(recovered.iter().all(|run| run.root_conversation_id == "root"));
        assert!(recovered.iter().all(|run| run.transcript_available));
    }

    #[test]
    fn recover_agent_runs_falls_back_to_parent_walk_without_ancestor() {
        let threads = vec![
            thread("root", None, None, "idle", "root"),
            thread("child", Some("root"), None, "pendingInit", "reviewer"),
            thread("grandchild", Some("child"), None, "errored", "writer"),
        ];
        let recovered = recover_agent_runs_from_threads("root", &threads);
        assert_eq!(recovered.len(), 2);
        assert_eq!(recovered[0].status, AgentRunStatus::Queued);
        assert_eq!(recovered[1].status, AgentRunStatus::Failed);
    }
}
