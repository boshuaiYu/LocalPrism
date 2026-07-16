use super::RuntimeKind;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnRoute {
    pub runtime: RuntimeKind,
    pub window_label: String,
    pub tab_id: String,
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
}

#[derive(Default)]
pub struct RuntimeProcessState {
    routes: tokio::sync::RwLock<std::collections::HashMap<(String, String), TurnRoute>>,
}

impl RuntimeProcessState {
    pub async fn upsert(&self, route: TurnRoute) {
        self.routes
            .write()
            .await
            .insert((route.window_label.clone(), route.tab_id.clone()), route);
    }

    pub async fn get(&self, window: &str, tab: &str) -> Option<TurnRoute> {
        self.routes
            .read()
            .await
            .get(&(window.to_owned(), tab.to_owned()))
            .cloned()
    }

    pub async fn remove_window(&self, window: &str) {
        self.routes
            .write()
            .await
            .retain(|_, route| route.window_label != window);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::RuntimeKind;

    fn route(runtime: RuntimeKind, window: &str, tab: &str) -> TurnRoute {
        TurnRoute {
            runtime,
            window_label: window.into(),
            tab_id: tab.into(),
            session_id: Some(format!("session-{window}")),
            turn_id: Some(format!("turn-{window}")),
        }
    }

    #[tokio::test]
    async fn same_tab_id_is_isolated_between_windows() {
        let state = RuntimeProcessState::default();
        let first = route(RuntimeKind::Claude, "window-a", "tab-1");
        let second = route(RuntimeKind::Codex, "window-b", "tab-1");

        state.upsert(first.clone()).await;
        state.upsert(second.clone()).await;

        assert_eq!(state.get("window-a", "tab-1").await, Some(first));
        assert_eq!(state.get("window-b", "tab-1").await, Some(second));
    }

    #[tokio::test]
    async fn separators_in_window_and_tab_ids_do_not_collide() {
        let state = RuntimeProcessState::default();
        let first = route(RuntimeKind::Claude, "a:b", "c");
        let second = route(RuntimeKind::Codex, "a", "b:c");

        state.upsert(first.clone()).await;
        state.upsert(second.clone()).await;

        assert_eq!(state.get("a:b", "c").await, Some(first));
        assert_eq!(state.get("a", "b:c").await, Some(second));
    }

    #[tokio::test]
    async fn remove_window_preserves_routes_for_other_windows() {
        let state = RuntimeProcessState::default();
        let removed = route(RuntimeKind::Claude, "window-a", "tab-1");
        let retained = route(RuntimeKind::Codex, "window-b", "tab-1");

        state.upsert(removed).await;
        state.upsert(retained.clone()).await;
        state.remove_window("window-a").await;

        assert_eq!(state.get("window-a", "tab-1").await, None);
        assert_eq!(state.get("window-b", "tab-1").await, Some(retained));
    }
}
