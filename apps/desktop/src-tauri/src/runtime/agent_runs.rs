use std::collections::HashMap;

use super::events::{AgentRun, AgentRunStatus};
use super::RuntimeKind;

#[derive(Default)]
pub struct AgentRunState {
    runs: tokio::sync::RwLock<HashMap<String, AgentRun>>,
}

impl AgentRunState {
    pub async fn apply(&self, run: AgentRun) -> AgentRun {
        let mut runs = self.runs.write().await;
        let key = run_key(run.runtime, &run.id);
        let merged = match runs.get(&key) {
            Some(existing) => merge_runs(existing, &run),
            None => run,
        };
        runs.insert(key, merged.clone());
        merged
    }

    pub async fn list_for_root(&self, runtime: RuntimeKind, root: &str) -> Vec<AgentRun> {
        let runs = self.runs.read().await;
        let mut matched = runs
            .values()
            .filter(|run| run.runtime == runtime && run.root_conversation_id == root)
            .cloned()
            .collect::<Vec<_>>();
        matched.sort_by(|left, right| {
            status_rank(left.status)
                .cmp(&status_rank(right.status))
                .then(left.started_at.cmp(&right.started_at))
                .then(left.id.cmp(&right.id))
        });
        matched
    }

    pub async fn replace_recovered(
        &self,
        runtime: RuntimeKind,
        root: &str,
        recovered: Vec<AgentRun>,
    ) {
        let mut runs = self.runs.write().await;
        runs.retain(|_, run| !(run.runtime == runtime && run.root_conversation_id == root));
        for run in recovered {
            if run.runtime != runtime || run.root_conversation_id != root {
                continue;
            }
            let key = run_key(run.runtime, &run.id);
            let merged = match runs.get(&key) {
                Some(existing) => merge_runs(existing, &run),
                None => run,
            };
            runs.insert(key, merged);
        }
    }
}

fn run_key(runtime: RuntimeKind, id: &str) -> String {
    format!("{runtime:?}:{id}")
}

fn status_rank(status: AgentRunStatus) -> u8 {
    match status {
        AgentRunStatus::Running => 0,
        AgentRunStatus::Queued => 1,
        AgentRunStatus::Completed | AgentRunStatus::Failed | AgentRunStatus::Cancelled => 2,
    }
}

fn is_terminal(status: AgentRunStatus) -> bool {
    matches!(
        status,
        AgentRunStatus::Completed | AgentRunStatus::Failed | AgentRunStatus::Cancelled
    )
}

fn merge_runs(existing: &AgentRun, incoming: &AgentRun) -> AgentRun {
    let mut merged = existing.clone();
    if existing.parent_id.is_none() && incoming.parent_id.is_some() {
        merged.parent_id = incoming.parent_id.clone();
    }
    if !incoming.agent_name.is_empty() {
        merged.agent_name = incoming.agent_name.clone();
    }
    if incoming.agent_role.is_some() {
        merged.agent_role = incoming.agent_role.clone();
    }
    if incoming.model.is_some() {
        merged.model = incoming.model.clone();
    }
    if incoming.activity.is_some() {
        merged.activity = incoming.activity.clone();
    }
    if incoming.summary.is_some() {
        merged.summary = incoming.summary.clone();
    }
    if incoming.error.is_some() {
        merged.error = incoming.error.clone();
    }
    merged.transcript_available = existing.transcript_available || incoming.transcript_available;
    merged.started_at = existing.started_at.min(incoming.started_at);

    if is_terminal(existing.status) && !is_terminal(incoming.status) {
        // Terminal states are monotonic: ignore regressions to active states.
    } else {
        merged.status = incoming.status;
        merged.completed_at = match incoming.status {
            AgentRunStatus::Completed | AgentRunStatus::Failed | AgentRunStatus::Cancelled => {
                incoming.completed_at.or(existing.completed_at)
            }
            _ => None,
        };
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(id: &str, parent: Option<&str>, status: AgentRunStatus) -> AgentRun {
        AgentRun {
            id: id.into(),
            parent_id: parent.map(str::to_owned),
            root_conversation_id: "root".into(),
            runtime: RuntimeKind::Codex,
            agent_name: id.into(),
            agent_role: None,
            model: None,
            status,
            started_at: 10,
            completed_at: None,
            activity: None,
            summary: None,
            error: None,
            transcript_available: true,
        }
    }

    #[tokio::test]
    async fn apply_merges_parent_after_child_and_keeps_terminal_monotonic() {
        let state = AgentRunState::default();
        let child_first = state
            .apply(run("child", None, AgentRunStatus::Running))
            .await;
        assert_eq!(child_first.parent_id, None);

        let with_parent = state
            .apply(run("child", Some("root"), AgentRunStatus::Running))
            .await;
        assert_eq!(with_parent.parent_id.as_deref(), Some("root"));

        let completed = state
            .apply(run("child", Some("root"), AgentRunStatus::Completed))
            .await;
        assert_eq!(completed.status, AgentRunStatus::Completed);

        let regress = state
            .apply(run("child", Some("root"), AgentRunStatus::Running))
            .await;
        assert_eq!(regress.status, AgentRunStatus::Completed);
    }

    #[tokio::test]
    async fn list_and_replace_recovered_scope_to_root() {
        let state = AgentRunState::default();
        state
            .apply(run("a", Some("root"), AgentRunStatus::Queued))
            .await;
        let mut other = run("b", Some("other"), AgentRunStatus::Running);
        other.root_conversation_id = "other".into();
        state.apply(other).await;

        assert_eq!(state.list_for_root(RuntimeKind::Codex, "root").await.len(), 1);

        state
            .replace_recovered(
                RuntimeKind::Codex,
                "root",
                vec![run("c", Some("root"), AgentRunStatus::Completed)],
            )
            .await;
        let listed = state.list_for_root(RuntimeKind::Codex, "root").await;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "c");
        assert_eq!(state.list_for_root(RuntimeKind::Codex, "other").await.len(), 1);
    }
}
