use std::collections::{HashMap, HashSet, VecDeque};

use super::RuntimeKind;

type RouteKey = (String, String);
type CodexTurnKey = (String, String);

pub const RECENT_TERMINAL_TURN_LIMIT: usize = 128;
const RECENT_ATTEMPT_CANCELLATION_LIMIT: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnRoute {
    pub runtime: RuntimeKind,
    pub window_label: String,
    pub tab_id: String,
    pub attempt_id: String,
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodexTurnBinding {
    Active(TurnRoute),
    AlreadyFinished(TurnRoute),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodexTurnStart {
    Reserved(CodexTurnReservation),
    Cancelled(TurnRoute),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodexCancelAction {
    Accepted,
    Interrupt(TurnRoute),
}

impl CodexTurnBinding {
    pub fn route(&self) -> &TurnRoute {
        match self {
            Self::Active(route) | Self::AlreadyFinished(route) => route,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexSubscriptionSnapshot {
    pub route: TurnRoute,
    pub thread_id: String,
    pub generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexPendingTurnSnapshot {
    pub route: TurnRoute,
    pub thread_id: Option<String>,
    pub generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexTurnOwnerSnapshot {
    pub route: TurnRoute,
    pub thread_id: String,
    pub turn_id: String,
    pub generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeProcessSnapshot {
    pub transport_generation: u64,
    pub routes: Vec<TurnRoute>,
    pub codex_subscriptions: Vec<CodexSubscriptionSnapshot>,
    pub pending_codex_turns: Vec<CodexPendingTurnSnapshot>,
    pub codex_turn_owners: Vec<CodexTurnOwnerSnapshot>,
    pub recent_terminal_turns: Vec<TurnRoute>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexTransportAdvance {
    pub previous_generation: u64,
    pub generation: u64,
    pub in_flight_turns: Vec<TurnRoute>,
    pub subscriptions: Vec<TurnRoute>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexTurnReservation {
    pub route: TurnRoute,
    pub generation: u64,
    reservation_id: u64,
    route_changed: bool,
    previous_route: Option<TurnRoute>,
}

impl CodexTurnReservation {
    pub(crate) fn route_identity_changed(&self) -> bool {
        self.route_changed
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeProcessError {
    StaleTransportGeneration {
        expected: u64,
        received: u64,
    },
    RouteNotFound {
        window_label: String,
        tab_id: String,
    },
    NotCodexRoute {
        window_label: String,
        tab_id: String,
    },
    MissingCodexThread {
        window_label: String,
        tab_id: String,
    },
    CodexThreadMismatch {
        expected: String,
        received: String,
    },
    TurnAlreadyInFlight {
        window_label: String,
        tab_id: String,
    },
    PendingTurnAlreadyExists {
        thread_id: String,
    },
    PendingTurnNotFound {
        window_label: String,
        tab_id: String,
    },
    AmbiguousPendingTurn {
        thread_id: String,
    },
    TurnOwnershipConflict {
        thread_id: String,
        turn_id: String,
    },
    StaleCodexTurnReservation {
        window_label: String,
        tab_id: String,
    },
}

impl std::fmt::Display for RuntimeProcessError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::StaleTransportGeneration { expected, received } => write!(
                formatter,
                "stale Codex transport generation {received}; current generation is {expected}"
            ),
            Self::RouteNotFound {
                window_label,
                tab_id,
            } => write!(formatter, "route {window_label}/{tab_id} was not found"),
            Self::NotCodexRoute {
                window_label,
                tab_id,
            } => write!(
                formatter,
                "route {window_label}/{tab_id} is not a Codex route"
            ),
            Self::MissingCodexThread {
                window_label,
                tab_id,
            } => write!(
                formatter,
                "Codex route {window_label}/{tab_id} has no bound thread"
            ),
            Self::CodexThreadMismatch { expected, received } => write!(
                formatter,
                "Codex route belongs to thread {expected}, not {received}"
            ),
            Self::TurnAlreadyInFlight {
                window_label,
                tab_id,
            } => write!(
                formatter,
                "route {window_label}/{tab_id} already has a nonterminal turn"
            ),
            Self::PendingTurnAlreadyExists { thread_id } => write!(
                formatter,
                "thread {thread_id} already has an uncorrelated pending turn"
            ),
            Self::PendingTurnNotFound {
                window_label,
                tab_id,
            } => write!(
                formatter,
                "route {window_label}/{tab_id} has no pending Codex turn"
            ),
            Self::AmbiguousPendingTurn { thread_id } => write!(
                formatter,
                "thread {thread_id} has more than one pending turn owner"
            ),
            Self::TurnOwnershipConflict { thread_id, turn_id } => write!(
                formatter,
                "turn {thread_id}/{turn_id} is owned by another route"
            ),
            Self::StaleCodexTurnReservation {
                window_label,
                tab_id,
            } => write!(
                formatter,
                "Codex turn reservation for {window_label}/{tab_id} is stale"
            ),
        }
    }
}

impl std::error::Error for RuntimeProcessError {}

#[derive(Debug, Clone)]
struct CodexSubscription {
    thread_id: String,
    generation: u64,
}

#[derive(Debug, Clone)]
struct PendingCodexTurn {
    thread_id: Option<String>,
    generation: u64,
    reservation_id: u64,
    cancel_requested: bool,
}

#[derive(Debug, Clone)]
struct CodexTurnOwner {
    route_key: RouteKey,
    generation: u64,
    cancel_requested: bool,
    interrupt_claimed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct AttemptKey {
    window_label: String,
    tab_id: String,
    attempt_id: String,
}

#[derive(Debug)]
struct CodexCancelSignal {
    cancellation_id: u64,
    outcome: tokio::sync::watch::Sender<Option<Result<(), String>>>,
}

#[derive(Debug, Clone)]
struct RecentTerminalTurn {
    thread_id: String,
    turn_id: String,
    route_key: RouteKey,
    generation: u64,
    route: TurnRoute,
}

#[derive(Default)]
struct RuntimeProcessRegistry {
    transport_generation: u64,
    next_reservation_id: u64,
    routes: HashMap<RouteKey, TurnRoute>,
    subscriptions_by_route: HashMap<RouteKey, CodexSubscription>,
    subscribers_by_thread: HashMap<String, HashSet<RouteKey>>,
    pending_turns: HashMap<RouteKey, PendingCodexTurn>,
    turn_owners: HashMap<CodexTurnKey, CodexTurnOwner>,
    recent_terminal_turns: VecDeque<RecentTerminalTurn>,
    next_cancellation_id: u64,
    attempt_cancellations: HashMap<AttemptKey, u64>,
    cancel_signals: HashMap<AttemptKey, CodexCancelSignal>,
    recent_attempt_cancellations: VecDeque<(AttemptKey, u64)>,
}

impl RuntimeProcessRegistry {
    fn route_key(route: &TurnRoute) -> RouteKey {
        (route.window_label.clone(), route.tab_id.clone())
    }

    fn key(window: &str, tab: &str) -> RouteKey {
        (window.to_owned(), tab.to_owned())
    }

    fn attempt_key(window: &str, tab: &str, attempt_id: &str) -> AttemptKey {
        AttemptKey {
            window_label: window.to_owned(),
            tab_id: tab.to_owned(),
            attempt_id: attempt_id.to_owned(),
        }
    }

    fn next_cancellation_id(&mut self) -> u64 {
        self.next_cancellation_id = self.next_cancellation_id.wrapping_add(1);
        if self.next_cancellation_id == 0 {
            self.next_cancellation_id = 1;
        }
        self.next_cancellation_id
    }

    fn insert_cancel_signal(&mut self, key: AttemptKey) -> u64 {
        let cancellation_id = self.next_cancellation_id();
        let (outcome, _) = tokio::sync::watch::channel(None);
        self.cancel_signals.insert(
            key.clone(),
            CodexCancelSignal {
                cancellation_id,
                outcome,
            },
        );
        self.recent_attempt_cancellations
            .push_back((key, cancellation_id));
        self.prune_attempt_cancellations();
        cancellation_id
    }

    fn ensure_cancel_signal(&mut self, key: AttemptKey) -> u64 {
        self.cancel_signals
            .get(&key)
            .map(|signal| signal.cancellation_id)
            .unwrap_or_else(|| self.insert_cancel_signal(key))
    }

    fn renew_failed_cancel_signal(&mut self, key: &AttemptKey) {
        let should_renew = self
            .cancel_signals
            .get(key)
            .is_some_and(|signal| matches!(&*signal.outcome.borrow(), Some(Err(_))));
        if should_renew {
            self.insert_cancel_signal(key.clone());
        }
    }

    fn record_attempt_cancellation(&mut self, key: AttemptKey) {
        let cancellation_id = self.ensure_cancel_signal(key.clone());
        self.attempt_cancellations
            .insert(key.clone(), cancellation_id);
    }

    fn prune_attempt_cancellations(&mut self) {
        while self.recent_attempt_cancellations.len() > RECENT_ATTEMPT_CANCELLATION_LIMIT {
            if let Some((expired, expired_id)) = self.recent_attempt_cancellations.pop_front() {
                if self.attempt_cancellations.get(&expired) == Some(&expired_id) {
                    self.attempt_cancellations.remove(&expired);
                }
                if self
                    .cancel_signals
                    .get(&expired)
                    .is_some_and(|signal| signal.cancellation_id == expired_id)
                {
                    self.cancel_signals.remove(&expired);
                }
            }
        }
    }

    fn subscribe_cancel_signal(
        &self,
        key: &AttemptKey,
    ) -> Option<tokio::sync::watch::Receiver<Option<Result<(), String>>>> {
        self.cancel_signals
            .get(key)
            .map(|signal| signal.outcome.subscribe())
    }

    fn settle_cancel_signal(&mut self, key: &AttemptKey, outcome: Result<(), String>) -> bool {
        let Some(signal) = self.cancel_signals.get(key) else {
            return false;
        };
        if outcome.is_err() && matches!(&*signal.outcome.borrow(), Some(Ok(()))) {
            return true;
        }
        signal.outcome.send_replace(Some(outcome));
        true
    }

    fn take_attempt_cancellation(&mut self, route: &TurnRoute) -> bool {
        self.attempt_cancellations
            .remove(&Self::attempt_key(
                &route.window_label,
                &route.tab_id,
                &route.attempt_id,
            ))
            .is_some()
    }

    fn ensure_generation(&self, generation: u64) -> Result<(), RuntimeProcessError> {
        if generation == self.transport_generation {
            Ok(())
        } else {
            Err(RuntimeProcessError::StaleTransportGeneration {
                expected: self.transport_generation,
                received: generation,
            })
        }
    }

    fn remove_subscription(&mut self, route_key: &RouteKey) {
        let Some(subscription) = self.subscriptions_by_route.remove(route_key) else {
            return;
        };
        let remove_thread = if let Some(subscribers) =
            self.subscribers_by_thread.get_mut(&subscription.thread_id)
        {
            subscribers.remove(route_key);
            subscribers.is_empty()
        } else {
            false
        };
        if remove_thread {
            self.subscribers_by_thread.remove(&subscription.thread_id);
        }
    }

    fn set_subscription(&mut self, route_key: &RouteKey, thread_id: &str, generation: u64) {
        self.remove_subscription(route_key);
        self.subscriptions_by_route.insert(
            route_key.clone(),
            CodexSubscription {
                thread_id: thread_id.to_owned(),
                generation,
            },
        );
        self.subscribers_by_thread
            .entry(thread_id.to_owned())
            .or_default()
            .insert(route_key.clone());
    }

    fn remove_route(&mut self, route_key: &RouteKey) -> Option<TurnRoute> {
        self.remove_subscription(route_key);
        self.pending_turns.remove(route_key);
        self.turn_owners
            .retain(|_, owner| owner.route_key != *route_key);
        self.routes.remove(route_key)
    }

    fn insert_route(&mut self, route: TurnRoute) {
        let route_key = Self::route_key(&route);
        self.remove_route(&route_key);
        self.routes.insert(route_key.clone(), route.clone());

        if route.runtime == RuntimeKind::Codex {
            if let Some(thread_id) = route.session_id.as_deref() {
                let generation = self.transport_generation;
                self.set_subscription(&route_key, thread_id, generation);

                if let Some(turn_id) = route.turn_id.as_deref() {
                    let turn_key = (thread_id.to_owned(), turn_id.to_owned());
                    if let Some(previous) = self.turn_owners.insert(
                        turn_key,
                        CodexTurnOwner {
                            route_key: route_key.clone(),
                            generation,
                            cancel_requested: false,
                            interrupt_claimed: false,
                        },
                    ) {
                        if previous.route_key != route_key {
                            if let Some(previous_route) = self.routes.get_mut(&previous.route_key) {
                                previous_route.turn_id = None;
                            }
                        }
                    }
                }
            }
        }
    }

    fn pending_matches_reservation(&self, reservation: &CodexTurnReservation) -> bool {
        let route_key = Self::route_key(&reservation.route);
        self.transport_generation == reservation.generation
            && self.pending_turns.get(&route_key).is_some_and(|pending| {
                pending.generation == reservation.generation
                    && pending.reservation_id == reservation.reservation_id
            })
    }

    fn sorted_routes(mut routes: Vec<TurnRoute>) -> Vec<TurnRoute> {
        routes.sort_by(|left, right| {
            (
                &left.window_label,
                &left.tab_id,
                &left.session_id,
                &left.turn_id,
                &left.attempt_id,
            )
                .cmp(&(
                    &right.window_label,
                    &right.tab_id,
                    &right.session_id,
                    &right.turn_id,
                    &right.attempt_id,
                ))
        });
        routes
    }

    fn recent_terminal(
        &self,
        thread_id: &str,
        turn_id: &str,
        generation: u64,
    ) -> Option<&RecentTerminalTurn> {
        self.recent_terminal_turns.iter().rev().find(|terminal| {
            terminal.thread_id == thread_id
                && terminal.turn_id == turn_id
                && terminal.generation == generation
        })
    }

    fn has_recent_terminal_attempt(&self, key: &AttemptKey) -> bool {
        self.recent_terminal_turns.iter().rev().any(|terminal| {
            terminal.route.window_label == key.window_label
                && terminal.route.tab_id == key.tab_id
                && terminal.route.attempt_id == key.attempt_id
        })
    }

    fn bind_thread_for_key(
        &mut self,
        route_key: &RouteKey,
        thread_id: &str,
        generation: u64,
        expected_reservation_id: Option<u64>,
    ) -> Result<TurnRoute, RuntimeProcessError> {
        self.ensure_generation(generation)?;
        let route = self.routes.get(route_key).cloned().ok_or_else(|| {
            RuntimeProcessError::RouteNotFound {
                window_label: route_key.0.clone(),
                tab_id: route_key.1.clone(),
            }
        })?;
        if route.runtime != RuntimeKind::Codex {
            return Err(RuntimeProcessError::NotCodexRoute {
                window_label: route_key.0.clone(),
                tab_id: route_key.1.clone(),
            });
        }
        if let Some(expected_reservation_id) = expected_reservation_id {
            let Some(pending) = self.pending_turns.get(route_key) else {
                return Err(RuntimeProcessError::StaleCodexTurnReservation {
                    window_label: route_key.0.clone(),
                    tab_id: route_key.1.clone(),
                });
            };
            if pending.generation != generation || pending.reservation_id != expected_reservation_id
            {
                return Err(RuntimeProcessError::StaleCodexTurnReservation {
                    window_label: route_key.0.clone(),
                    tab_id: route_key.1.clone(),
                });
            }
        }
        if let Some(bound_thread) = route.session_id.as_deref() {
            if bound_thread != thread_id {
                return Err(RuntimeProcessError::CodexThreadMismatch {
                    expected: bound_thread.to_owned(),
                    received: thread_id.to_owned(),
                });
            }
        }
        if let Some(pending) = self.pending_turns.get(route_key) {
            if pending.thread_id.is_none()
                && self.pending_turns.iter().any(|(other_key, other)| {
                    other_key != route_key
                        && other.generation == generation
                        && other.thread_id.as_deref() == Some(thread_id)
                })
            {
                return Err(RuntimeProcessError::PendingTurnAlreadyExists {
                    thread_id: thread_id.to_owned(),
                });
            }
            if let Some(pending_thread) = pending.thread_id.as_deref() {
                if pending_thread != thread_id {
                    return Err(RuntimeProcessError::CodexThreadMismatch {
                        expected: pending_thread.to_owned(),
                        received: thread_id.to_owned(),
                    });
                }
            }
        }

        let Some(bound_route) = self.routes.get_mut(route_key) else {
            return Err(RuntimeProcessError::RouteNotFound {
                window_label: route_key.0.clone(),
                tab_id: route_key.1.clone(),
            });
        };
        bound_route.session_id = Some(thread_id.to_owned());
        let bound_route = bound_route.clone();
        if let Some(pending) = self.pending_turns.get_mut(route_key) {
            pending.thread_id = Some(thread_id.to_owned());
        }
        self.set_subscription(route_key, thread_id, generation);
        Ok(bound_route)
    }

    fn bind_turn_for_key(
        &mut self,
        route_key: &RouteKey,
        thread_id: &str,
        turn_id: &str,
        generation: u64,
    ) -> Result<CodexTurnBinding, RuntimeProcessError> {
        self.ensure_generation(generation)?;

        if let Some(terminal) = self.recent_terminal(thread_id, turn_id, generation) {
            return if terminal.route_key == *route_key {
                Ok(CodexTurnBinding::AlreadyFinished(terminal.route.clone()))
            } else {
                Err(RuntimeProcessError::TurnOwnershipConflict {
                    thread_id: thread_id.to_owned(),
                    turn_id: turn_id.to_owned(),
                })
            };
        }

        let turn_key = (thread_id.to_owned(), turn_id.to_owned());
        if let Some(owner) = self.turn_owners.get(&turn_key) {
            return if owner.generation == generation && owner.route_key == *route_key {
                self.routes
                    .get(route_key)
                    .cloned()
                    .map(CodexTurnBinding::Active)
                    .ok_or_else(|| RuntimeProcessError::RouteNotFound {
                        window_label: route_key.0.clone(),
                        tab_id: route_key.1.clone(),
                    })
            } else {
                Err(RuntimeProcessError::TurnOwnershipConflict {
                    thread_id: thread_id.to_owned(),
                    turn_id: turn_id.to_owned(),
                })
            };
        }

        let route = self.routes.get(route_key).cloned().ok_or_else(|| {
            RuntimeProcessError::RouteNotFound {
                window_label: route_key.0.clone(),
                tab_id: route_key.1.clone(),
            }
        })?;
        if route.runtime != RuntimeKind::Codex {
            return Err(RuntimeProcessError::NotCodexRoute {
                window_label: route_key.0.clone(),
                tab_id: route_key.1.clone(),
            });
        }
        match route.session_id.as_deref() {
            Some(bound_thread) if bound_thread == thread_id => {}
            Some(bound_thread) => {
                return Err(RuntimeProcessError::CodexThreadMismatch {
                    expected: bound_thread.to_owned(),
                    received: thread_id.to_owned(),
                });
            }
            None => {
                return Err(RuntimeProcessError::MissingCodexThread {
                    window_label: route_key.0.clone(),
                    tab_id: route_key.1.clone(),
                });
            }
        }

        let pending = self.pending_turns.get(route_key).cloned().ok_or_else(|| {
            RuntimeProcessError::PendingTurnNotFound {
                window_label: route_key.0.clone(),
                tab_id: route_key.1.clone(),
            }
        })?;
        if pending.generation != generation {
            return Err(RuntimeProcessError::StaleTransportGeneration {
                expected: generation,
                received: pending.generation,
            });
        }
        match pending.thread_id.as_deref() {
            Some(pending_thread) if pending_thread == thread_id => {}
            Some(pending_thread) => {
                return Err(RuntimeProcessError::CodexThreadMismatch {
                    expected: pending_thread.to_owned(),
                    received: thread_id.to_owned(),
                });
            }
            None => {
                return Err(RuntimeProcessError::MissingCodexThread {
                    window_label: route_key.0.clone(),
                    tab_id: route_key.1.clone(),
                });
            }
        }

        self.pending_turns.remove(route_key);
        let Some(active_route) = self.routes.get_mut(route_key) else {
            return Err(RuntimeProcessError::RouteNotFound {
                window_label: route_key.0.clone(),
                tab_id: route_key.1.clone(),
            });
        };
        active_route.turn_id = Some(turn_id.to_owned());
        let active_route = active_route.clone();
        self.turn_owners.insert(
            turn_key,
            CodexTurnOwner {
                route_key: route_key.clone(),
                generation,
                cancel_requested: pending.cancel_requested,
                interrupt_claimed: false,
            },
        );
        Ok(CodexTurnBinding::Active(active_route))
    }

    fn snapshot(&self) -> RuntimeProcessSnapshot {
        let routes = Self::sorted_routes(self.routes.values().cloned().collect());

        let mut codex_subscriptions = self
            .subscriptions_by_route
            .iter()
            .filter_map(|(route_key, subscription)| {
                self.routes
                    .get(route_key)
                    .cloned()
                    .map(|route| CodexSubscriptionSnapshot {
                        route,
                        thread_id: subscription.thread_id.clone(),
                        generation: subscription.generation,
                    })
            })
            .collect::<Vec<_>>();
        codex_subscriptions.sort_by(|left, right| {
            (
                &left.thread_id,
                &left.route.window_label,
                &left.route.tab_id,
            )
                .cmp(&(
                    &right.thread_id,
                    &right.route.window_label,
                    &right.route.tab_id,
                ))
        });

        let mut pending_codex_turns = self
            .pending_turns
            .iter()
            .filter_map(|(route_key, pending)| {
                self.routes
                    .get(route_key)
                    .cloned()
                    .map(|route| CodexPendingTurnSnapshot {
                        route,
                        thread_id: pending.thread_id.clone(),
                        generation: pending.generation,
                    })
            })
            .collect::<Vec<_>>();
        pending_codex_turns.sort_by(|left, right| {
            (
                &left.thread_id,
                &left.route.window_label,
                &left.route.tab_id,
            )
                .cmp(&(
                    &right.thread_id,
                    &right.route.window_label,
                    &right.route.tab_id,
                ))
        });

        let mut codex_turn_owners = self
            .turn_owners
            .iter()
            .filter_map(|((thread_id, turn_id), owner)| {
                self.routes
                    .get(&owner.route_key)
                    .cloned()
                    .map(|route| CodexTurnOwnerSnapshot {
                        route,
                        thread_id: thread_id.clone(),
                        turn_id: turn_id.clone(),
                        generation: owner.generation,
                    })
            })
            .collect::<Vec<_>>();
        codex_turn_owners.sort_by(|left, right| {
            (
                &left.thread_id,
                &left.turn_id,
                &left.route.window_label,
                &left.route.tab_id,
            )
                .cmp(&(
                    &right.thread_id,
                    &right.turn_id,
                    &right.route.window_label,
                    &right.route.tab_id,
                ))
        });

        let recent_terminal_turns = Self::sorted_routes(
            self.recent_terminal_turns
                .iter()
                .map(|terminal| terminal.route.clone())
                .collect(),
        );

        RuntimeProcessSnapshot {
            transport_generation: self.transport_generation,
            routes,
            codex_subscriptions,
            pending_codex_turns,
            codex_turn_owners,
            recent_terminal_turns,
        }
    }
}

#[derive(Default)]
pub struct RuntimeProcessState {
    registry: tokio::sync::RwLock<RuntimeProcessRegistry>,
}

impl RuntimeProcessState {
    pub async fn upsert(&self, route: TurnRoute) {
        let mut registry = self.registry.write().await;
        registry.insert_route(route);
    }

    pub async fn get(&self, window: &str, tab: &str) -> Option<TurnRoute> {
        self.registry
            .read()
            .await
            .routes
            .get(&RuntimeProcessRegistry::key(window, tab))
            .cloned()
    }

    pub async fn transport_generation(&self) -> u64 {
        self.registry.read().await.transport_generation
    }

    pub async fn snapshot(&self) -> RuntimeProcessSnapshot {
        self.registry.read().await.snapshot()
    }

    pub async fn remove_tab(&self, window: &str, tab: &str) -> Option<TurnRoute> {
        self.registry
            .write()
            .await
            .remove_route(&RuntimeProcessRegistry::key(window, tab))
    }

    pub async fn remove_tab_for_attempt(
        &self,
        window: &str,
        tab: &str,
        attempt_id: &str,
    ) -> Option<TurnRoute> {
        let mut registry = self.registry.write().await;
        let route_key = RuntimeProcessRegistry::key(window, tab);
        if registry
            .routes
            .get(&route_key)
            .is_none_or(|route| route.attempt_id != attempt_id)
        {
            return None;
        }
        registry.remove_route(&route_key)
    }

    pub async fn remove_window(&self, window: &str) -> Vec<TurnRoute> {
        let mut registry = self.registry.write().await;
        let mut keys = registry
            .routes
            .keys()
            .filter(|(window_label, _)| window_label == window)
            .cloned()
            .collect::<Vec<_>>();
        keys.sort();
        let mut removed = Vec::with_capacity(keys.len());
        for route_key in keys {
            if let Some(route) = registry.remove_route(&route_key) {
                removed.push(route);
            }
        }
        registry
            .recent_terminal_turns
            .retain(|terminal| terminal.route.window_label != window);
        removed
    }

    pub async fn begin_codex_turn(
        &self,
        desired: TurnRoute,
    ) -> Result<CodexTurnStart, RuntimeProcessError> {
        let mut registry = self.registry.write().await;
        let route_key = RuntimeProcessRegistry::route_key(&desired);
        if desired.runtime != RuntimeKind::Codex {
            return Err(RuntimeProcessError::NotCodexRoute {
                window_label: desired.window_label,
                tab_id: desired.tab_id,
            });
        }
        if desired.turn_id.is_some() {
            return Err(RuntimeProcessError::TurnAlreadyInFlight {
                window_label: desired.window_label,
                tab_id: desired.tab_id,
            });
        }
        if registry.take_attempt_cancellation(&desired) {
            return Ok(CodexTurnStart::Cancelled(desired));
        }

        let previous_route = registry.routes.get(&route_key).cloned();
        let route_is_busy = previous_route
            .as_ref()
            .and_then(|route| route.turn_id.as_ref())
            .is_some()
            || registry.pending_turns.contains_key(&route_key)
            || registry.turn_owners.values().any(|owner| {
                owner.route_key == route_key && owner.generation == registry.transport_generation
            });
        if route_is_busy {
            return Err(RuntimeProcessError::TurnAlreadyInFlight {
                window_label: route_key.0,
                tab_id: route_key.1,
            });
        }
        if let Some(thread_id) = desired.session_id.as_deref() {
            if registry.pending_turns.values().any(|pending| {
                pending.generation == registry.transport_generation
                    && pending.thread_id.as_deref() == Some(thread_id)
            }) {
                return Err(RuntimeProcessError::PendingTurnAlreadyExists {
                    thread_id: thread_id.to_owned(),
                });
            }
        }

        let route_changed = previous_route.as_ref().is_none_or(|existing| {
            existing.runtime != desired.runtime
                || existing.session_id != desired.session_id
                || existing.attempt_id != desired.attempt_id
        });
        if route_changed {
            registry.insert_route(desired.clone());
        }
        registry.next_reservation_id = registry.next_reservation_id.wrapping_add(1);
        if registry.next_reservation_id == 0 {
            registry.next_reservation_id = 1;
        }
        let reservation_id = registry.next_reservation_id;
        let generation = registry.transport_generation;
        registry.pending_turns.insert(
            route_key,
            PendingCodexTurn {
                thread_id: desired.session_id.clone(),
                generation,
                reservation_id,
                cancel_requested: false,
            },
        );

        Ok(CodexTurnStart::Reserved(CodexTurnReservation {
            route: desired,
            generation,
            reservation_id,
            route_changed,
            previous_route,
        }))
    }

    pub async fn abort_codex_turn(
        &self,
        reservation: &CodexTurnReservation,
        rollback_route: bool,
    ) -> bool {
        self.abort_codex_turn_outcome(reservation, rollback_route)
            .await
            .is_some()
    }

    pub async fn abort_codex_turn_outcome(
        &self,
        reservation: &CodexTurnReservation,
        rollback_route: bool,
    ) -> Option<bool> {
        let mut registry = self.registry.write().await;
        if !registry.pending_matches_reservation(reservation) {
            return None;
        }
        let route_key = RuntimeProcessRegistry::route_key(&reservation.route);
        let cancel_requested = registry
            .pending_turns
            .get(&route_key)
            .is_some_and(|pending| pending.cancel_requested);
        registry.pending_turns.remove(&route_key);
        if rollback_route && reservation.route_changed {
            registry.remove_route(&route_key);
            if let Some(previous) = reservation.previous_route.clone() {
                registry.insert_route(previous);
            }
        }
        Some(cancel_requested)
    }

    pub async fn take_cancelled_pending_codex_turn(
        &self,
        reservation: &CodexTurnReservation,
    ) -> Option<TurnRoute> {
        let mut registry = self.registry.write().await;
        if !registry.pending_matches_reservation(reservation) {
            return None;
        }
        let route_key = RuntimeProcessRegistry::route_key(&reservation.route);
        if !registry
            .pending_turns
            .get(&route_key)
            .is_some_and(|pending| pending.cancel_requested)
        {
            return None;
        }
        registry.pending_turns.remove(&route_key);
        registry.routes.get(&route_key).cloned()
    }

    pub async fn reserve_codex_turn(
        &self,
        window: &str,
        tab: &str,
        generation: u64,
    ) -> Result<TurnRoute, RuntimeProcessError> {
        let mut registry = self.registry.write().await;
        registry.ensure_generation(generation)?;
        let route_key = RuntimeProcessRegistry::key(window, tab);
        let route = registry.routes.get(&route_key).cloned().ok_or_else(|| {
            RuntimeProcessError::RouteNotFound {
                window_label: window.to_owned(),
                tab_id: tab.to_owned(),
            }
        })?;
        if route.runtime != RuntimeKind::Codex {
            return Err(RuntimeProcessError::NotCodexRoute {
                window_label: window.to_owned(),
                tab_id: tab.to_owned(),
            });
        }
        if route.turn_id.is_some()
            || registry.pending_turns.contains_key(&route_key)
            || registry
                .turn_owners
                .values()
                .any(|owner| owner.route_key == route_key && owner.generation == generation)
        {
            return Err(RuntimeProcessError::TurnAlreadyInFlight {
                window_label: window.to_owned(),
                tab_id: tab.to_owned(),
            });
        }
        if let Some(thread_id) = route.session_id.as_deref() {
            let already_pending = registry.pending_turns.values().any(|pending| {
                pending.generation == generation && pending.thread_id.as_deref() == Some(thread_id)
            });
            if already_pending {
                return Err(RuntimeProcessError::PendingTurnAlreadyExists {
                    thread_id: thread_id.to_owned(),
                });
            }
        }
        registry.pending_turns.insert(
            route_key,
            PendingCodexTurn {
                thread_id: route.session_id.clone(),
                generation,
                reservation_id: 0,
                cancel_requested: false,
            },
        );
        Ok(route)
    }

    pub async fn release_pending_codex_turn(
        &self,
        window: &str,
        tab: &str,
        generation: u64,
    ) -> Option<TurnRoute> {
        let mut registry = self.registry.write().await;
        if registry.ensure_generation(generation).is_err() {
            return None;
        }
        let route_key = RuntimeProcessRegistry::key(window, tab);
        let pending = registry.pending_turns.get(&route_key)?;
        if pending.generation != generation {
            return None;
        }
        registry.pending_turns.remove(&route_key);
        registry.routes.get(&route_key).cloned()
    }

    pub async fn bind_codex_thread(
        &self,
        window: &str,
        tab: &str,
        thread_id: &str,
        generation: u64,
    ) -> Result<TurnRoute, RuntimeProcessError> {
        let mut registry = self.registry.write().await;
        let route_key = RuntimeProcessRegistry::key(window, tab);
        registry.bind_thread_for_key(&route_key, thread_id, generation, None)
    }

    pub async fn bind_codex_thread_for_reservation(
        &self,
        reservation: &CodexTurnReservation,
        thread_id: &str,
    ) -> Result<TurnRoute, RuntimeProcessError> {
        let mut registry = self.registry.write().await;
        let route_key = RuntimeProcessRegistry::route_key(&reservation.route);
        registry.bind_thread_for_key(
            &route_key,
            thread_id,
            reservation.generation,
            Some(reservation.reservation_id),
        )
    }

    pub async fn rebind_codex_subscription(
        &self,
        window: &str,
        tab: &str,
        expected_thread_id: &str,
        generation: u64,
    ) -> Result<TurnRoute, RuntimeProcessError> {
        let mut registry = self.registry.write().await;
        registry.ensure_generation(generation)?;
        let route_key = RuntimeProcessRegistry::key(window, tab);
        let route = registry.routes.get(&route_key).cloned().ok_or_else(|| {
            RuntimeProcessError::RouteNotFound {
                window_label: window.to_owned(),
                tab_id: tab.to_owned(),
            }
        })?;
        if route.runtime != RuntimeKind::Codex {
            return Err(RuntimeProcessError::NotCodexRoute {
                window_label: window.to_owned(),
                tab_id: tab.to_owned(),
            });
        }
        let thread_id =
            route
                .session_id
                .as_deref()
                .ok_or_else(|| RuntimeProcessError::MissingCodexThread {
                    window_label: window.to_owned(),
                    tab_id: tab.to_owned(),
                })?;
        if thread_id != expected_thread_id {
            return Err(RuntimeProcessError::CodexThreadMismatch {
                expected: expected_thread_id.to_owned(),
                received: thread_id.to_owned(),
            });
        }
        registry.set_subscription(&route_key, expected_thread_id, generation);
        Ok(route)
    }

    pub async fn bind_codex_turn(
        &self,
        window: &str,
        tab: &str,
        thread_id: &str,
        turn_id: &str,
        generation: u64,
    ) -> Result<CodexTurnBinding, RuntimeProcessError> {
        self.registry.write().await.bind_turn_for_key(
            &RuntimeProcessRegistry::key(window, tab),
            thread_id,
            turn_id,
            generation,
        )
    }

    pub async fn bind_codex_turn_for_reservation(
        &self,
        reservation: &CodexTurnReservation,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<CodexTurnBinding, RuntimeProcessError> {
        let mut registry = self.registry.write().await;
        registry.ensure_generation(reservation.generation)?;
        let route_key = RuntimeProcessRegistry::route_key(&reservation.route);
        let already_correlated = registry
            .recent_terminal(thread_id, turn_id, reservation.generation)
            .is_some()
            || registry
                .turn_owners
                .contains_key(&(thread_id.to_owned(), turn_id.to_owned()));
        if !already_correlated && !registry.pending_matches_reservation(reservation) {
            return Err(RuntimeProcessError::StaleCodexTurnReservation {
                window_label: route_key.0,
                tab_id: route_key.1,
            });
        }
        registry.bind_turn_for_key(&route_key, thread_id, turn_id, reservation.generation)
    }

    pub async fn bind_pending_codex_turn(
        &self,
        thread_id: &str,
        turn_id: &str,
        generation: u64,
    ) -> Result<CodexTurnBinding, RuntimeProcessError> {
        let mut registry = self.registry.write().await;
        registry.ensure_generation(generation)?;
        if let Some(terminal) = registry.recent_terminal(thread_id, turn_id, generation) {
            return Ok(CodexTurnBinding::AlreadyFinished(terminal.route.clone()));
        }
        if let Some(owner) = registry
            .turn_owners
            .get(&(thread_id.to_owned(), turn_id.to_owned()))
        {
            return registry
                .routes
                .get(&owner.route_key)
                .cloned()
                .map(CodexTurnBinding::Active)
                .ok_or_else(|| RuntimeProcessError::RouteNotFound {
                    window_label: owner.route_key.0.clone(),
                    tab_id: owner.route_key.1.clone(),
                });
        }

        let mut candidates = registry
            .pending_turns
            .iter()
            .filter(|(_, pending)| {
                pending.generation == generation && pending.thread_id.as_deref() == Some(thread_id)
            })
            .map(|(route_key, _)| route_key.clone())
            .collect::<Vec<_>>();
        candidates.sort();
        let route_key = match candidates.as_slice() {
            [route_key] => route_key.clone(),
            [] => {
                return Err(RuntimeProcessError::PendingTurnNotFound {
                    window_label: String::new(),
                    tab_id: String::new(),
                });
            }
            _ => {
                return Err(RuntimeProcessError::AmbiguousPendingTurn {
                    thread_id: thread_id.to_owned(),
                });
            }
        };
        registry.bind_turn_for_key(&route_key, thread_id, turn_id, generation)
    }

    pub async fn finish_codex_turn(
        &self,
        thread_id: &str,
        turn_id: &str,
        generation: u64,
    ) -> Option<TurnRoute> {
        let mut registry = self.registry.write().await;
        if registry.ensure_generation(generation).is_err() {
            return None;
        }
        if let Some(terminal) = registry.recent_terminal(thread_id, turn_id, generation) {
            return Some(terminal.route.clone());
        }

        let turn_key = (thread_id.to_owned(), turn_id.to_owned());
        let owner = registry.turn_owners.remove(&turn_key)?;
        if owner.generation != generation {
            return None;
        }
        let route = registry.routes.get_mut(&owner.route_key)?;
        if route.turn_id.as_deref() != Some(turn_id)
            || route.session_id.as_deref() != Some(thread_id)
        {
            return None;
        }
        let terminal_route = route.clone();
        route.turn_id = None;
        registry.pending_turns.remove(&owner.route_key);
        if owner.cancel_requested {
            let attempt_key = RuntimeProcessRegistry::attempt_key(
                &terminal_route.window_label,
                &terminal_route.tab_id,
                &terminal_route.attempt_id,
            );
            registry.settle_cancel_signal(&attempt_key, Ok(()));
        }
        registry
            .recent_terminal_turns
            .push_back(RecentTerminalTurn {
                thread_id: thread_id.to_owned(),
                turn_id: turn_id.to_owned(),
                route_key: owner.route_key,
                generation,
                route: terminal_route.clone(),
            });
        while registry.recent_terminal_turns.len() > RECENT_TERMINAL_TURN_LIMIT {
            registry.recent_terminal_turns.pop_front();
        }
        Some(terminal_route)
    }

    pub async fn codex_pending_turn_owners(
        &self,
        thread_id: &str,
        generation: u64,
    ) -> Vec<TurnRoute> {
        let registry = self.registry.read().await;
        if registry.ensure_generation(generation).is_err() {
            return Vec::new();
        }
        RuntimeProcessRegistry::sorted_routes(
            registry
                .pending_turns
                .iter()
                .filter(|(_, pending)| {
                    pending.generation == generation
                        && pending.thread_id.as_deref() == Some(thread_id)
                })
                .filter_map(|(route_key, _)| registry.routes.get(route_key).cloned())
                .collect(),
        )
    }

    pub async fn codex_thread_subscribers(
        &self,
        thread_id: &str,
        generation: u64,
    ) -> Vec<TurnRoute> {
        let registry = self.registry.read().await;
        if registry.ensure_generation(generation).is_err() {
            return Vec::new();
        }
        let routes = registry
            .subscribers_by_thread
            .get(thread_id)
            .into_iter()
            .flatten()
            .filter(|route_key| {
                registry
                    .subscriptions_by_route
                    .get(*route_key)
                    .is_some_and(|subscription| {
                        subscription.generation == generation && subscription.thread_id == thread_id
                    })
            })
            .filter_map(|route_key| registry.routes.get(route_key).cloned())
            .collect();
        RuntimeProcessRegistry::sorted_routes(routes)
    }

    pub async fn codex_turn_owner(
        &self,
        thread_id: &str,
        turn_id: &str,
        generation: u64,
    ) -> Option<TurnRoute> {
        let registry = self.registry.read().await;
        if registry.ensure_generation(generation).is_err() {
            return None;
        }
        let owner = registry
            .turn_owners
            .get(&(thread_id.to_owned(), turn_id.to_owned()))?;
        if owner.generation != generation {
            return None;
        }
        registry.routes.get(&owner.route_key).cloned()
    }

    pub async fn codex_notification_routes(
        &self,
        thread_id: &str,
        turn_id: Option<&str>,
        generation: u64,
    ) -> Vec<TurnRoute> {
        if let Some(turn_id) = turn_id {
            self.codex_turn_owner(thread_id, turn_id, generation)
                .await
                .into_iter()
                .collect()
        } else {
            self.codex_thread_subscribers(thread_id, generation).await
        }
    }

    pub async fn request_codex_cancel(
        &self,
        window: &str,
        tab: &str,
        attempt_id: &str,
        generation: u64,
    ) -> CodexCancelAction {
        let mut registry = self.registry.write().await;
        let attempt_key = RuntimeProcessRegistry::attempt_key(window, tab, attempt_id);
        let route_key = RuntimeProcessRegistry::key(window, tab);
        let route = registry.routes.get(&route_key).cloned();
        let exact_route = route.as_ref().is_some_and(|route| {
            route.runtime == RuntimeKind::Codex && route.attempt_id == attempt_id
        });
        if !exact_route && registry.has_recent_terminal_attempt(&attempt_key) {
            registry.ensure_cancel_signal(attempt_key.clone());
            registry.settle_cancel_signal(&attempt_key, Ok(()));
            return CodexCancelAction::Accepted;
        }
        if registry.ensure_generation(generation).is_err() {
            registry.record_attempt_cancellation(attempt_key);
            return CodexCancelAction::Accepted;
        }
        if !exact_route {
            registry.record_attempt_cancellation(attempt_key);
            return CodexCancelAction::Accepted;
        }
        registry.ensure_cancel_signal(attempt_key.clone());

        if let Some(pending) = registry.pending_turns.get_mut(&route_key) {
            if pending.generation == generation {
                pending.cancel_requested = true;
                registry.renew_failed_cancel_signal(&attempt_key);
                return CodexCancelAction::Accepted;
            }
        }

        let Some(route) = route else {
            registry.settle_cancel_signal(&attempt_key, Ok(()));
            return CodexCancelAction::Accepted;
        };
        let (Some(thread_id), Some(turn_id)) = (route.session_id.as_ref(), route.turn_id.as_ref())
        else {
            registry.settle_cancel_signal(&attempt_key, Ok(()));
            return CodexCancelAction::Accepted;
        };
        let Some(owner) = registry
            .turn_owners
            .get_mut(&(thread_id.clone(), turn_id.clone()))
        else {
            return CodexCancelAction::Accepted;
        };
        if owner.generation != generation || owner.route_key != route_key {
            return CodexCancelAction::Accepted;
        }
        owner.cancel_requested = true;
        if owner.interrupt_claimed {
            return CodexCancelAction::Accepted;
        }
        registry.renew_failed_cancel_signal(&attempt_key);
        let Some(owner) = registry
            .turn_owners
            .get_mut(&(thread_id.clone(), turn_id.clone()))
        else {
            return CodexCancelAction::Accepted;
        };
        owner.interrupt_claimed = true;
        CodexCancelAction::Interrupt(route)
    }

    pub async fn subscribe_codex_cancel(
        &self,
        window: &str,
        tab: &str,
        attempt_id: &str,
    ) -> Option<tokio::sync::watch::Receiver<Option<Result<(), String>>>> {
        let registry = self.registry.read().await;
        registry.subscribe_cancel_signal(&RuntimeProcessRegistry::attempt_key(
            window, tab, attempt_id,
        ))
    }

    pub async fn settle_codex_cancel(
        &self,
        route: &TurnRoute,
        outcome: Result<(), String>,
    ) -> bool {
        let mut registry = self.registry.write().await;
        let attempt_key = RuntimeProcessRegistry::attempt_key(
            &route.window_label,
            &route.tab_id,
            &route.attempt_id,
        );
        if outcome.is_err() {
            let route_key = RuntimeProcessRegistry::route_key(route);
            if let (Some(thread_id), Some(turn_id)) =
                (route.session_id.as_ref(), route.turn_id.as_ref())
            {
                if let Some(owner) = registry
                    .turn_owners
                    .get_mut(&(thread_id.clone(), turn_id.clone()))
                {
                    if owner.route_key == route_key {
                        owner.interrupt_claimed = false;
                    }
                }
            }
        }
        registry.settle_cancel_signal(&attempt_key, outcome)
    }

    pub async fn take_codex_prestart_cancellation(&self, route: &TurnRoute) -> bool {
        let mut registry = self.registry.write().await;
        registry.take_attempt_cancellation(route)
    }

    pub async fn claim_codex_cancel_target(
        &self,
        window: &str,
        tab: &str,
        attempt_id: &str,
        generation: u64,
    ) -> Option<TurnRoute> {
        let mut registry = self.registry.write().await;
        if registry.ensure_generation(generation).is_err() {
            return None;
        }
        let route_key = RuntimeProcessRegistry::key(window, tab);
        let route = registry.routes.get(&route_key)?.clone();
        if route.runtime != RuntimeKind::Codex || route.attempt_id != attempt_id {
            return None;
        }
        let thread_id = route.session_id.as_ref()?;
        let turn_id = route.turn_id.as_ref()?;
        let owner = registry
            .turn_owners
            .get_mut(&(thread_id.clone(), turn_id.clone()))?;
        if owner.generation != generation
            || owner.route_key != route_key
            || !owner.cancel_requested
            || owner.interrupt_claimed
        {
            return None;
        }
        owner.interrupt_claimed = true;
        Some(route)
    }

    pub async fn codex_cancel_target(
        &self,
        runtime: RuntimeKind,
        window: &str,
        tab: &str,
        generation: u64,
    ) -> Option<TurnRoute> {
        let registry = self.registry.read().await;
        if registry.ensure_generation(generation).is_err() || runtime != RuntimeKind::Codex {
            return None;
        }
        let route_key = RuntimeProcessRegistry::key(window, tab);
        let route = registry.routes.get(&route_key)?;
        if route.runtime != runtime {
            return None;
        }
        let thread_id = route.session_id.as_ref()?;
        let turn_id = route.turn_id.as_ref()?;
        let owner = registry
            .turn_owners
            .get(&(thread_id.clone(), turn_id.clone()))?;
        (owner.generation == generation && owner.route_key == route_key).then(|| route.clone())
    }

    pub async fn advance_transport_generation(&self) -> CodexTransportAdvance {
        let mut registry = self.registry.write().await;
        let previous_generation = registry.transport_generation;

        let subscriptions = RuntimeProcessRegistry::sorted_routes(
            registry
                .subscriptions_by_route
                .keys()
                .filter_map(|route_key| registry.routes.get(route_key).cloned())
                .collect(),
        );
        let mut in_flight_by_route = HashMap::<RouteKey, TurnRoute>::new();
        for route_key in registry.pending_turns.keys() {
            if let Some(route) = registry.routes.get(route_key) {
                in_flight_by_route.insert(route_key.clone(), route.clone());
            }
        }
        for owner in registry.turn_owners.values() {
            if let Some(route) = registry.routes.get(&owner.route_key) {
                in_flight_by_route.insert(owner.route_key.clone(), route.clone());
            }
        }
        let in_flight_turns =
            RuntimeProcessRegistry::sorted_routes(in_flight_by_route.into_values().collect());

        registry.transport_generation = registry.transport_generation.saturating_add(1);
        let generation = registry.transport_generation;
        registry.pending_turns.clear();
        registry.turn_owners.clear();
        registry.recent_terminal_turns.clear();
        for route in registry.routes.values_mut() {
            if route.runtime == RuntimeKind::Codex {
                route.turn_id = None;
            }
        }

        CodexTransportAdvance {
            previous_generation,
            generation,
            in_flight_turns,
            subscriptions,
        }
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
            attempt_id: format!("attempt-{window}-{tab}"),
            session_id: Some(format!("session-{window}")),
            turn_id: Some(format!("turn-{window}")),
        }
    }

    fn codex_route(window: &str, tab: &str, thread: Option<&str>) -> TurnRoute {
        TurnRoute {
            runtime: RuntimeKind::Codex,
            window_label: window.into(),
            tab_id: tab.into(),
            attempt_id: format!("attempt-{window}-{tab}"),
            session_id: thread.map(str::to_owned),
            turn_id: None,
        }
    }

    fn codex_attempt_route(
        window: &str,
        tab: &str,
        thread: Option<&str>,
        attempt_id: &str,
    ) -> TurnRoute {
        TurnRoute {
            attempt_id: attempt_id.into(),
            ..codex_route(window, tab, thread)
        }
    }

    fn reserved(start: CodexTurnStart) -> CodexTurnReservation {
        match start {
            CodexTurnStart::Reserved(reservation) => reservation,
            CodexTurnStart::Cancelled(_) => panic!("attempt was unexpectedly cancelled"),
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

    #[tokio::test]
    async fn codex_turn_new_thread_reserves_tab_then_binds_thread_and_turn() {
        let state = RuntimeProcessState::default();
        let generation = state.transport_generation().await;
        state.upsert(codex_route("window-a", "tab-1", None)).await;

        state
            .reserve_codex_turn("window-a", "tab-1", generation)
            .await
            .unwrap();
        assert!(state
            .reserve_codex_turn("window-a", "tab-1", generation)
            .await
            .is_err());

        let bound_thread = state
            .bind_codex_thread("window-a", "tab-1", "thread-1", generation)
            .await
            .unwrap();
        assert_eq!(bound_thread.session_id.as_deref(), Some("thread-1"));
        assert_eq!(
            state
                .codex_pending_turn_owners("thread-1", generation)
                .await,
            vec![bound_thread.clone()]
        );

        let binding = state
            .bind_codex_turn("window-a", "tab-1", "thread-1", "turn-1", generation)
            .await
            .unwrap();
        let active = binding.route().clone();
        assert_eq!(active.turn_id.as_deref(), Some("turn-1"));
        assert_eq!(
            state
                .codex_turn_owner("thread-1", "turn-1", generation)
                .await,
            Some(active)
        );
    }

    #[tokio::test]
    async fn codex_turn_completion_before_start_response_is_idempotent() {
        let state = RuntimeProcessState::default();
        let generation = state.transport_generation().await;
        state
            .upsert(codex_route("window-a", "tab-1", Some("thread-1")))
            .await;
        state
            .reserve_codex_turn("window-a", "tab-1", generation)
            .await
            .unwrap();

        let notification_binding = state
            .bind_pending_codex_turn("thread-1", "turn-1", generation)
            .await
            .unwrap();
        assert!(matches!(notification_binding, CodexTurnBinding::Active(_)));
        let finished = state
            .finish_codex_turn("thread-1", "turn-1", generation)
            .await
            .unwrap();
        assert_eq!(finished.turn_id.as_deref(), Some("turn-1"));

        let late_response = state
            .bind_codex_turn("window-a", "tab-1", "thread-1", "turn-1", generation)
            .await
            .unwrap();
        assert!(matches!(
            late_response,
            CodexTurnBinding::AlreadyFinished(_)
        ));
        assert_eq!(state.get("window-a", "tab-1").await.unwrap().turn_id, None);
        assert_eq!(
            state
                .codex_cancel_target(RuntimeKind::Codex, "window-a", "tab-1", generation)
                .await,
            None
        );
    }

    #[tokio::test]
    async fn codex_turn_same_thread_subscribes_many_tabs_but_routes_turn_to_owner() {
        let state = RuntimeProcessState::default();
        let generation = state.transport_generation().await;
        let first = codex_route("window-b", "tab-1", Some("shared-thread"));
        let second = codex_route("window-a", "tab-2", Some("shared-thread"));
        state.upsert(first).await;
        state.upsert(second).await;

        assert_eq!(
            state
                .codex_thread_subscribers("shared-thread", generation)
                .await
                .iter()
                .map(|route| (route.window_label.as_str(), route.tab_id.as_str()))
                .collect::<Vec<_>>(),
            vec![("window-a", "tab-2"), ("window-b", "tab-1")]
        );

        state
            .reserve_codex_turn("window-b", "tab-1", generation)
            .await
            .unwrap();
        state
            .bind_codex_turn("window-b", "tab-1", "shared-thread", "turn-a", generation)
            .await
            .unwrap();
        state
            .reserve_codex_turn("window-a", "tab-2", generation)
            .await
            .unwrap();
        state
            .bind_codex_turn("window-a", "tab-2", "shared-thread", "turn-b", generation)
            .await
            .unwrap();

        assert_eq!(
            state
                .codex_notification_routes("shared-thread", None, generation)
                .await
                .len(),
            2
        );
        let turn_a = state
            .codex_notification_routes("shared-thread", Some("turn-a"), generation)
            .await;
        let turn_b = state
            .codex_notification_routes("shared-thread", Some("turn-b"), generation)
            .await;
        assert_eq!(turn_a.len(), 1);
        assert_eq!(turn_a[0].window_label, "window-b");
        assert_eq!(turn_b.len(), 1);
        assert_eq!(turn_b[0].window_label, "window-a");
    }

    #[tokio::test]
    async fn codex_turn_same_thread_has_only_one_uncorrelated_pending_owner() {
        let state = RuntimeProcessState::default();
        let generation = state.transport_generation().await;
        state
            .upsert(codex_route("window-a", "tab-1", Some("shared-thread")))
            .await;
        state
            .upsert(codex_route("window-b", "tab-2", Some("shared-thread")))
            .await;

        state
            .reserve_codex_turn("window-a", "tab-1", generation)
            .await
            .unwrap();
        assert!(state
            .reserve_codex_turn("window-b", "tab-2", generation)
            .await
            .is_err());

        state
            .bind_codex_turn("window-a", "tab-1", "shared-thread", "turn-a", generation)
            .await
            .unwrap();
        assert!(state
            .reserve_codex_turn("window-a", "tab-1", generation)
            .await
            .is_err());
        state
            .reserve_codex_turn("window-b", "tab-2", generation)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn codex_turn_recent_terminal_cache_is_bounded() {
        let state = RuntimeProcessState::default();
        let generation = state.transport_generation().await;
        state
            .upsert(codex_route("window-a", "tab-1", Some("thread-1")))
            .await;

        for index in 0..=RECENT_TERMINAL_TURN_LIMIT {
            let turn_id = format!("turn-{index}");
            state
                .reserve_codex_turn("window-a", "tab-1", generation)
                .await
                .unwrap();
            state
                .bind_codex_turn("window-a", "tab-1", "thread-1", &turn_id, generation)
                .await
                .unwrap();
            state
                .finish_codex_turn("thread-1", &turn_id, generation)
                .await
                .unwrap();
        }

        let snapshot = state.snapshot().await;
        assert_eq!(
            snapshot.recent_terminal_turns.len(),
            RECENT_TERMINAL_TURN_LIMIT
        );
        assert!(!snapshot
            .recent_terminal_turns
            .iter()
            .any(|route| route.turn_id.as_deref() == Some("turn-0")));
        let last_turn = format!("turn-{}", RECENT_TERMINAL_TURN_LIMIT);
        assert!(snapshot
            .recent_terminal_turns
            .iter()
            .any(|route| route.turn_id.as_deref() == Some(last_turn.as_str())));
    }

    #[tokio::test]
    async fn codex_turn_interleaved_thread_and_turn_ids_never_cross_route() {
        let state = RuntimeProcessState::default();
        let generation = state.transport_generation().await;
        state
            .upsert(codex_route("window", "tab:a", Some("thread:b")))
            .await;
        state
            .upsert(codex_route("window:tab", "a", Some("thread")))
            .await;

        state
            .reserve_codex_turn("window", "tab:a", generation)
            .await
            .unwrap();
        state
            .bind_codex_turn("window", "tab:a", "thread:b", "turn:c", generation)
            .await
            .unwrap();
        state
            .reserve_codex_turn("window:tab", "a", generation)
            .await
            .unwrap();
        state
            .bind_codex_turn("window:tab", "a", "thread", "b:turn:c", generation)
            .await
            .unwrap();

        assert_eq!(
            state
                .codex_turn_owner("thread:b", "turn:c", generation)
                .await
                .unwrap()
                .tab_id,
            "tab:a"
        );
        assert_eq!(
            state
                .codex_turn_owner("thread", "b:turn:c", generation)
                .await
                .unwrap()
                .window_label,
            "window:tab"
        );
        assert_eq!(
            state
                .codex_turn_owner("thread:b", "b:turn:c", generation)
                .await,
            None
        );
    }

    #[tokio::test]
    async fn codex_turn_remove_tab_and_window_clear_every_reverse_index() {
        let state = RuntimeProcessState::default();
        let generation = state.transport_generation().await;
        for (window, tab, turn) in [
            ("window-a", "tab-1", "turn-a"),
            ("window-b", "tab-2", "turn-b"),
        ] {
            state
                .upsert(codex_route(window, tab, Some("shared-thread")))
                .await;
            state
                .reserve_codex_turn(window, tab, generation)
                .await
                .unwrap();
            state
                .bind_codex_turn(window, tab, "shared-thread", turn, generation)
                .await
                .unwrap();
        }

        state.remove_tab("window-a", "tab-1").await;
        assert_eq!(
            state
                .codex_turn_owner("shared-thread", "turn-a", generation)
                .await,
            None
        );
        assert_eq!(
            state
                .codex_thread_subscribers("shared-thread", generation)
                .await
                .len(),
            1
        );

        state.remove_window("window-b").await;
        let snapshot = state.snapshot().await;
        assert!(snapshot.routes.is_empty());
        assert!(snapshot.codex_subscriptions.is_empty());
        assert!(snapshot.pending_codex_turns.is_empty());
        assert!(snapshot.codex_turn_owners.is_empty());
    }

    #[tokio::test]
    async fn codex_turn_transport_generation_drops_old_notifications_and_returns_failures() {
        let state = RuntimeProcessState::default();
        let old_generation = state.transport_generation().await;
        state
            .upsert(codex_route("window-a", "tab-1", Some("thread-1")))
            .await;
        state
            .reserve_codex_turn("window-a", "tab-1", old_generation)
            .await
            .unwrap();
        state
            .bind_codex_turn("window-a", "tab-1", "thread-1", "turn-1", old_generation)
            .await
            .unwrap();

        let advance = state.advance_transport_generation().await;
        assert_eq!(advance.previous_generation, old_generation);
        assert_eq!(advance.generation, old_generation + 1);
        assert_eq!(advance.in_flight_turns.len(), 1);
        assert_eq!(
            advance.in_flight_turns[0].turn_id.as_deref(),
            Some("turn-1")
        );
        assert_eq!(advance.subscriptions.len(), 1);
        assert!(state
            .codex_notification_routes("thread-1", Some("turn-1"), old_generation)
            .await
            .is_empty());
        assert!(state
            .codex_thread_subscribers("thread-1", advance.generation)
            .await
            .is_empty());

        state
            .rebind_codex_subscription("window-a", "tab-1", "thread-1", advance.generation)
            .await
            .unwrap();
        assert_eq!(
            state
                .codex_thread_subscribers("thread-1", advance.generation)
                .await
                .len(),
            1
        );
        assert_eq!(state.get("window-a", "tab-1").await.unwrap().turn_id, None);
    }

    #[tokio::test]
    async fn codex_turn_cancel_target_matches_runtime_window_and_tab_exactly() {
        let state = RuntimeProcessState::default();
        let generation = state.transport_generation().await;
        for (window, thread, turn) in [
            ("window-a", "thread-a", "turn-a"),
            ("window-b", "thread-b", "turn-b"),
        ] {
            state
                .upsert(codex_route(window, "shared-tab", Some(thread)))
                .await;
            state
                .reserve_codex_turn(window, "shared-tab", generation)
                .await
                .unwrap();
            state
                .bind_codex_turn(window, "shared-tab", thread, turn, generation)
                .await
                .unwrap();
        }

        let target = state
            .codex_cancel_target(RuntimeKind::Codex, "window-a", "shared-tab", generation)
            .await
            .unwrap();
        assert_eq!(target.session_id.as_deref(), Some("thread-a"));
        assert_eq!(target.turn_id.as_deref(), Some("turn-a"));
        assert_eq!(
            state
                .codex_cancel_target(RuntimeKind::Claude, "window-a", "shared-tab", generation)
                .await,
            None
        );
        assert_eq!(
            state
                .codex_cancel_target(RuntimeKind::Codex, "window-c", "shared-tab", generation)
                .await,
            None
        );
        assert_eq!(
            state
                .codex_cancel_target(RuntimeKind::Codex, "window-a", "other-tab", generation)
                .await,
            None
        );
        assert_eq!(
            state
                .codex_cancel_target(RuntimeKind::Codex, "window-b", "shared-tab", generation)
                .await
                .unwrap()
                .turn_id
                .as_deref(),
            Some("turn-b")
        );
    }

    #[tokio::test]
    async fn codex_turn_start_failure_releases_pending_owner_for_retry() {
        let state = RuntimeProcessState::default();
        let generation = state.transport_generation().await;
        state
            .upsert(codex_route("window-a", "tab-1", Some("thread-1")))
            .await;
        state
            .reserve_codex_turn("window-a", "tab-1", generation)
            .await
            .unwrap();

        assert!(state
            .release_pending_codex_turn("window-a", "tab-1", generation)
            .await
            .is_some());
        assert!(state
            .codex_pending_turn_owners("thread-1", generation)
            .await
            .is_empty());
        state
            .reserve_codex_turn("window-a", "tab-1", generation)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn codex_turn_reservation_identity_blocks_replacement_and_stale_abort_or_bind() {
        let state = RuntimeProcessState::default();
        let previous = TurnRoute {
            runtime: RuntimeKind::Claude,
            window_label: "window-a".into(),
            tab_id: "tab-a".into(),
            attempt_id: "attempt-old".into(),
            session_id: Some("session-old".into()),
            turn_id: None,
        };
        state.upsert(previous.clone()).await;
        let desired_a = codex_route("window-a", "tab-a", Some("thread-a"));
        let desired_b = codex_route("window-a", "tab-a", Some("thread-b"));

        let reservation_a = reserved(state.begin_codex_turn(desired_a.clone()).await.unwrap());
        assert!(state.begin_codex_turn(desired_b.clone()).await.is_err());
        assert_eq!(state.get("window-a", "tab-a").await, Some(desired_a));

        assert!(state.abort_codex_turn(&reservation_a, true).await);
        assert_eq!(state.get("window-a", "tab-a").await, Some(previous.clone()));

        let reservation_b = reserved(state.begin_codex_turn(desired_b.clone()).await.unwrap());
        assert!(!state.abort_codex_turn(&reservation_a, true).await);
        assert!(state
            .bind_codex_thread_for_reservation(&reservation_a, "thread-a")
            .await
            .is_err());
        assert_eq!(state.get("window-a", "tab-a").await, Some(desired_b));

        state
            .bind_codex_thread_for_reservation(&reservation_b, "thread-b")
            .await
            .unwrap();
        let binding = state
            .bind_codex_turn_for_reservation(&reservation_b, "thread-b", "turn-b")
            .await
            .unwrap();
        assert_eq!(binding.route().turn_id.as_deref(), Some("turn-b"));
    }

    #[tokio::test]
    async fn codex_turn_rebind_requires_the_snapshot_thread_identity() {
        let state = RuntimeProcessState::default();
        state
            .upsert(codex_route("window-a", "tab-a", Some("thread-old")))
            .await;
        let reset = state.advance_transport_generation().await;

        state
            .upsert(codex_route("window-a", "tab-a", Some("thread-new")))
            .await;
        assert!(state
            .rebind_codex_subscription("window-a", "tab-a", "thread-old", reset.generation,)
            .await
            .is_err());
        assert!(state
            .codex_thread_subscribers("thread-old", reset.generation)
            .await
            .is_empty());
        assert_eq!(
            state
                .codex_thread_subscribers("thread-new", reset.generation)
                .await
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn codex_stop_before_reserve_cancels_only_the_matching_attempt() {
        let state = RuntimeProcessState::default();
        let generation = state.transport_generation().await;
        assert_eq!(
            state
                .request_codex_cancel("window-a", "tab-a", "attempt-old", generation,)
                .await,
            CodexCancelAction::Accepted
        );

        let cancelled = state
            .begin_codex_turn(codex_attempt_route(
                "window-a",
                "tab-a",
                None,
                "attempt-old",
            ))
            .await
            .unwrap();
        assert!(matches!(cancelled, CodexTurnStart::Cancelled(_)));

        let current = state
            .begin_codex_turn(codex_attempt_route(
                "window-a",
                "tab-a",
                None,
                "attempt-new",
            ))
            .await
            .unwrap();
        assert!(matches!(current, CodexTurnStart::Reserved(_)));
    }

    #[tokio::test]
    async fn codex_cancel_reserved_before_bind_prevents_turn_start() {
        let state = RuntimeProcessState::default();
        let generation = state.transport_generation().await;
        let CodexTurnStart::Reserved(reservation) = state
            .begin_codex_turn(codex_attempt_route("window-a", "tab-a", None, "attempt-a"))
            .await
            .unwrap()
        else {
            panic!("the uncancelled attempt must reserve");
        };

        assert_eq!(
            state
                .request_codex_cancel("window-a", "tab-a", "attempt-a", generation)
                .await,
            CodexCancelAction::Accepted
        );
        state
            .bind_codex_thread_for_reservation(&reservation, "thread-a")
            .await
            .unwrap();
        let cancelled = state
            .take_cancelled_pending_codex_turn(&reservation)
            .await
            .expect("the matching pending attempt must be cancelled before turn/start");
        assert_eq!(cancelled.attempt_id, "attempt-a");
        assert!(state
            .codex_pending_turn_owners("thread-a", generation)
            .await
            .is_empty());
    }

    #[tokio::test]
    async fn codex_cancel_during_turn_start_is_claimed_after_turn_binding() {
        let state = RuntimeProcessState::default();
        let generation = state.transport_generation().await;
        let CodexTurnStart::Reserved(reservation) = state
            .begin_codex_turn(codex_attempt_route(
                "window-a",
                "tab-a",
                Some("thread-a"),
                "attempt-a",
            ))
            .await
            .unwrap()
        else {
            panic!("the uncancelled attempt must reserve");
        };

        assert_eq!(
            state
                .request_codex_cancel("window-a", "tab-a", "attempt-a", generation)
                .await,
            CodexCancelAction::Accepted
        );
        state
            .bind_codex_turn_for_reservation(&reservation, "thread-a", "turn-a")
            .await
            .unwrap();
        let target = state
            .claim_codex_cancel_target("window-a", "tab-a", "attempt-a", generation)
            .await
            .expect("the bound cancelled turn must be interrupted");
        assert_eq!(target.turn_id.as_deref(), Some("turn-a"));
        assert!(state
            .claim_codex_cancel_target("window-a", "tab-a", "attempt-a", generation)
            .await
            .is_none());
    }

    #[tokio::test]
    async fn old_attempt_stop_cannot_interrupt_or_remove_the_new_attempt() {
        let state = RuntimeProcessState::default();
        let generation = state.transport_generation().await;
        let CodexTurnStart::Reserved(reservation) = state
            .begin_codex_turn(codex_attempt_route(
                "window-a",
                "tab-a",
                Some("thread-new"),
                "attempt-new",
            ))
            .await
            .unwrap()
        else {
            panic!("the new attempt must reserve");
        };
        state
            .bind_codex_turn_for_reservation(&reservation, "thread-new", "turn-new")
            .await
            .unwrap();

        assert_eq!(
            state
                .request_codex_cancel("window-a", "tab-a", "attempt-old", generation)
                .await,
            CodexCancelAction::Accepted
        );
        assert_eq!(
            state.get("window-a", "tab-a").await.unwrap().attempt_id,
            "attempt-new"
        );
        assert!(matches!(
            state
                .request_codex_cancel("window-a", "tab-a", "attempt-new", generation)
                .await,
            CodexCancelAction::Interrupt(route)
                if route.turn_id.as_deref() == Some("turn-new")
        ));
    }

    #[tokio::test]
    async fn compare_and_remove_route_rejects_a_stale_attempt() {
        let state = RuntimeProcessState::default();
        state
            .upsert(codex_attempt_route(
                "window-a",
                "tab-a",
                Some("thread-new"),
                "attempt-new",
            ))
            .await;

        assert!(state
            .remove_tab_for_attempt("window-a", "tab-a", "attempt-old")
            .await
            .is_none());
        assert_eq!(
            state.get("window-a", "tab-a").await.unwrap().attempt_id,
            "attempt-new"
        );
        assert!(state
            .remove_tab_for_attempt("window-a", "tab-a", "attempt-new")
            .await
            .is_some());
    }

    #[tokio::test]
    async fn late_claude_terminal_compare_remove_cannot_delete_a_new_attempt_route() {
        let state = RuntimeProcessState::default();
        state
            .upsert(TurnRoute {
                runtime: RuntimeKind::Claude,
                window_label: "window-a".into(),
                tab_id: "tab-a".into(),
                attempt_id: "attempt-old".into(),
                session_id: None,
                turn_id: None,
            })
            .await;
        state
            .upsert(TurnRoute {
                runtime: RuntimeKind::Claude,
                window_label: "window-a".into(),
                tab_id: "tab-a".into(),
                attempt_id: "attempt-new".into(),
                session_id: None,
                turn_id: None,
            })
            .await;

        assert!(state
            .remove_tab_for_attempt("window-a", "tab-a", "attempt-old")
            .await
            .is_none());
        assert_eq!(
            state.get("window-a", "tab-a").await.unwrap().attempt_id,
            "attempt-new"
        );
        assert!(state
            .remove_tab_for_attempt("window-a", "tab-a", "attempt-new")
            .await
            .is_some());
        assert!(state.get("window-a", "tab-a").await.is_none());
    }

    #[tokio::test]
    async fn deferred_codex_interrupt_error_is_observable_and_keeps_the_turn_busy_for_retry() {
        let state = RuntimeProcessState::default();
        let generation = state.transport_generation().await;
        let CodexTurnStart::Reserved(reservation) = state
            .begin_codex_turn(codex_attempt_route(
                "window-a",
                "tab-a",
                Some("thread-a"),
                "attempt-a",
            ))
            .await
            .unwrap()
        else {
            panic!("the attempt must reserve");
        };
        state
            .bind_codex_turn_for_reservation(&reservation, "thread-a", "turn-a")
            .await
            .unwrap();
        assert!(matches!(
            state
                .request_codex_cancel("window-a", "tab-a", "attempt-a", generation)
                .await,
            CodexCancelAction::Interrupt(_)
        ));
        let mut outcome = state
            .subscribe_codex_cancel("window-a", "tab-a", "attempt-a")
            .await
            .expect("accepted cancellation must expose an outcome channel");

        state
            .settle_codex_cancel(
                &reservation.route,
                Err("turn/interrupt transport error".into()),
            )
            .await;
        outcome.changed().await.unwrap();
        assert_eq!(
            outcome.borrow().clone(),
            Some(Err("turn/interrupt transport error".into()))
        );
        assert_eq!(
            state
                .get("window-a", "tab-a")
                .await
                .unwrap()
                .turn_id
                .as_deref(),
            Some("turn-a")
        );
        assert!(state
            .begin_codex_turn(codex_attempt_route(
                "window-a",
                "tab-a",
                Some("thread-a"),
                "attempt-new",
            ))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn failed_codex_interrupt_can_be_retried_for_the_same_attempt() {
        let state = RuntimeProcessState::default();
        let generation = state.transport_generation().await;
        let CodexTurnStart::Reserved(reservation) = state
            .begin_codex_turn(codex_attempt_route(
                "window-a",
                "tab-a",
                Some("thread-a"),
                "attempt-a",
            ))
            .await
            .unwrap()
        else {
            panic!("the attempt must reserve");
        };
        state
            .bind_codex_turn_for_reservation(&reservation, "thread-a", "turn-a")
            .await
            .unwrap();
        let CodexCancelAction::Interrupt(first) = state
            .request_codex_cancel("window-a", "tab-a", "attempt-a", generation)
            .await
        else {
            panic!("the first stop must claim the active turn");
        };
        state
            .settle_codex_cancel(&first, Err("temporary interrupt failure".into()))
            .await;

        let CodexCancelAction::Interrupt(retry) = state
            .request_codex_cancel("window-a", "tab-a", "attempt-a", generation)
            .await
        else {
            panic!("the failed stop must release its interrupt claim");
        };
        let outcome = state
            .subscribe_codex_cancel("window-a", "tab-a", "attempt-a")
            .await
            .unwrap();
        assert_eq!(*outcome.borrow(), None);
        state.settle_codex_cancel(&retry, Ok(())).await;
        assert_eq!(*outcome.borrow(), Some(Ok(())));
    }

    #[tokio::test]
    async fn natural_codex_terminal_settles_a_pending_cancel_successfully() {
        let state = RuntimeProcessState::default();
        let generation = state.transport_generation().await;
        let CodexTurnStart::Reserved(reservation) = state
            .begin_codex_turn(codex_attempt_route(
                "window-a",
                "tab-a",
                Some("thread-a"),
                "attempt-a",
            ))
            .await
            .unwrap()
        else {
            panic!("the attempt must reserve");
        };
        state
            .bind_codex_turn_for_reservation(&reservation, "thread-a", "turn-a")
            .await
            .unwrap();
        assert!(matches!(
            state
                .request_codex_cancel("window-a", "tab-a", "attempt-a", generation)
                .await,
            CodexCancelAction::Interrupt(_)
        ));
        let outcome = state
            .subscribe_codex_cancel("window-a", "tab-a", "attempt-a")
            .await
            .unwrap();

        state
            .finish_codex_turn("thread-a", "turn-a", generation)
            .await
            .unwrap();
        assert_eq!(*outcome.borrow(), Some(Ok(())));
    }

    #[tokio::test]
    async fn immediate_terminal_settles_pending_cancel_before_any_interrupt_claim() {
        let state = RuntimeProcessState::default();
        let generation = state.transport_generation().await;
        let CodexTurnStart::Reserved(reservation) = state
            .begin_codex_turn(codex_attempt_route(
                "window-a",
                "tab-a",
                Some("thread-a"),
                "attempt-a",
            ))
            .await
            .unwrap()
        else {
            panic!("the attempt must reserve");
        };
        assert_eq!(
            state
                .request_codex_cancel("window-a", "tab-a", "attempt-a", generation)
                .await,
            CodexCancelAction::Accepted
        );
        let outcome = state
            .subscribe_codex_cancel("window-a", "tab-a", "attempt-a")
            .await
            .unwrap();
        state
            .bind_codex_turn_for_reservation(&reservation, "thread-a", "turn-a")
            .await
            .unwrap();

        state
            .finish_codex_turn("thread-a", "turn-a", generation)
            .await
            .unwrap();
        assert_eq!(*outcome.borrow(), Some(Ok(())));
        assert!(state
            .claim_codex_cancel_target("window-a", "tab-a", "attempt-a", generation,)
            .await
            .is_none());
    }

    #[tokio::test]
    async fn codex_terminal_before_cancel_returns_immediate_exact_attempt_success() {
        let state = RuntimeProcessState::default();
        let generation = state.transport_generation().await;
        let CodexTurnStart::Reserved(reservation) = state
            .begin_codex_turn(codex_attempt_route(
                "window-a",
                "tab-a",
                Some("thread-a"),
                "attempt-a",
            ))
            .await
            .unwrap()
        else {
            panic!("the attempt must reserve");
        };
        state
            .bind_codex_turn_for_reservation(&reservation, "thread-a", "turn-a")
            .await
            .unwrap();
        state
            .finish_codex_turn("thread-a", "turn-a", generation)
            .await
            .unwrap();

        assert_eq!(
            state
                .request_codex_cancel("window-a", "tab-a", "attempt-a", generation)
                .await,
            CodexCancelAction::Accepted
        );
        let outcome = state
            .subscribe_codex_cancel("window-a", "tab-a", "attempt-a")
            .await
            .unwrap();
        assert_eq!(*outcome.borrow(), Some(Ok(())));
    }

    #[tokio::test]
    async fn old_codex_attempt_stop_succeeds_without_touching_a_new_active_attempt() {
        let state = RuntimeProcessState::default();
        let generation = state.transport_generation().await;
        let CodexTurnStart::Reserved(old) = state
            .begin_codex_turn(codex_attempt_route(
                "window-a",
                "tab-a",
                Some("thread-old"),
                "attempt-old",
            ))
            .await
            .unwrap()
        else {
            panic!("old attempt must reserve");
        };
        state
            .bind_codex_turn_for_reservation(&old, "thread-old", "turn-old")
            .await
            .unwrap();
        state
            .finish_codex_turn("thread-old", "turn-old", generation)
            .await
            .unwrap();
        let CodexTurnStart::Reserved(new) = state
            .begin_codex_turn(codex_attempt_route(
                "window-a",
                "tab-a",
                Some("thread-new"),
                "attempt-new",
            ))
            .await
            .unwrap()
        else {
            panic!("new attempt must reserve");
        };
        state
            .bind_codex_turn_for_reservation(&new, "thread-new", "turn-new")
            .await
            .unwrap();

        assert_eq!(
            state
                .request_codex_cancel("window-a", "tab-a", "attempt-old", generation)
                .await,
            CodexCancelAction::Accepted
        );
        let old_outcome = state
            .subscribe_codex_cancel("window-a", "tab-a", "attempt-old")
            .await
            .unwrap();
        assert_eq!(*old_outcome.borrow(), Some(Ok(())));
        assert_eq!(
            state
                .get("window-a", "tab-a")
                .await
                .unwrap()
                .turn_id
                .as_deref(),
            Some("turn-new")
        );
    }

    #[tokio::test]
    async fn unknown_new_attempt_stop_stays_a_tombstone_despite_an_idle_older_route() {
        let state = RuntimeProcessState::default();
        state
            .upsert(codex_attempt_route(
                "window-a",
                "tab-a",
                Some("thread-b"),
                "attempt-b",
            ))
            .await;
        let generation = state.transport_generation().await;
        assert_eq!(
            state
                .request_codex_cancel("window-a", "tab-a", "attempt-c", generation)
                .await,
            CodexCancelAction::Accepted
        );
        let outcome = state
            .subscribe_codex_cancel("window-a", "tab-a", "attempt-c")
            .await
            .unwrap();
        assert_eq!(*outcome.borrow(), None);

        let start = state
            .begin_codex_turn(codex_attempt_route(
                "window-a",
                "tab-a",
                Some("thread-c"),
                "attempt-c",
            ))
            .await
            .unwrap();
        let CodexTurnStart::Cancelled(cancelled) = start else {
            panic!("the exact future attempt must consume its tombstone");
        };
        assert_eq!(cancelled.attempt_id, "attempt-c");
        assert_eq!(
            state.get("window-a", "tab-a").await.unwrap().attempt_id,
            "attempt-b"
        );
    }

    #[tokio::test]
    async fn delayed_terminal_attempt_start_cannot_hijack_a_new_same_thread_pending_turn() {
        let state = RuntimeProcessState::default();
        let generation = state.transport_generation().await;
        let CodexTurnStart::Reserved(old) = state
            .begin_codex_turn(codex_attempt_route(
                "window-a",
                "tab-a",
                Some("thread-shared"),
                "attempt-old",
            ))
            .await
            .unwrap()
        else {
            panic!("old attempt must reserve");
        };
        state
            .bind_codex_turn_for_reservation(&old, "thread-shared", "turn-old")
            .await
            .unwrap();
        state
            .finish_codex_turn("thread-shared", "turn-old", generation)
            .await
            .unwrap();
        let CodexTurnStart::Reserved(new) = state
            .begin_codex_turn(codex_attempt_route(
                "window-a",
                "tab-a",
                Some("thread-shared"),
                "attempt-new",
            ))
            .await
            .unwrap()
        else {
            panic!("new attempt must reserve");
        };

        let delayed = state
            .bind_pending_codex_turn("thread-shared", "turn-old", generation)
            .await
            .unwrap();
        assert!(matches!(
            delayed,
            CodexTurnBinding::AlreadyFinished(route) if route.attempt_id == "attempt-old"
        ));
        assert_eq!(state.get("window-a", "tab-a").await.unwrap().turn_id, None);
        assert!(matches!(
            state
                .bind_codex_turn_for_reservation(&new, "thread-shared", "turn-new")
                .await
                .unwrap(),
            CodexTurnBinding::Active(route)
                if route.attempt_id == "attempt-new"
                    && route.turn_id.as_deref() == Some("turn-new")
        ));
    }

    #[tokio::test]
    async fn rejected_start_can_consume_and_settle_only_its_exact_stop_tombstone() {
        let state = RuntimeProcessState::default();
        let generation = state.transport_generation().await;
        assert_eq!(
            state
                .request_codex_cancel("window-a", "tab-a", "attempt-old", generation)
                .await,
            CodexCancelAction::Accepted
        );
        let old_route = codex_attempt_route("window-a", "tab-a", Some("thread-a"), "attempt-old");
        let new_route = codex_attempt_route("window-a", "tab-a", Some("thread-a"), "attempt-new");
        assert!(!state.take_codex_prestart_cancellation(&new_route).await);
        assert!(state.take_codex_prestart_cancellation(&old_route).await);
        let outcome = state
            .subscribe_codex_cancel("window-a", "tab-a", "attempt-old")
            .await
            .unwrap();
        assert_eq!(*outcome.borrow(), None);
        state.settle_codex_cancel(&old_route, Ok(())).await;
        assert_eq!(*outcome.borrow(), Some(Ok(())));
    }
}
