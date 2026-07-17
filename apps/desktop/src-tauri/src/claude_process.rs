use std::collections::HashMap;
use std::collections::VecDeque;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use tauri::{Emitter, Manager, WebviewWindow};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
const RECENT_STOP_TOMBSTONE_LIMIT: usize = 256;
const CLAUDE_INTERRUPT_GRACE: Duration = Duration::from_secs(3);
const CLAUDE_FORCE_REAP_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct ClaudeProcessState {
    registry: Arc<Mutex<ClaudeProcessRegistry<Child>>>,
}

impl Default for ClaudeProcessState {
    fn default() -> Self {
        Self {
            registry: Arc::new(Mutex::new(ClaudeProcessRegistry::default())),
        }
    }
}

#[derive(Clone, serde::Serialize)]
struct ClaudeOutputEvent {
    tab_id: String,
    attempt_id: String,
    data: String,
}

#[derive(Clone, serde::Serialize)]
struct ClaudeCompleteEvent {
    tab_id: String,
    attempt_id: String,
    success: bool,
}

#[derive(Clone, serde::Serialize)]
struct ClaudeErrorEvent {
    tab_id: String,
    attempt_id: String,
    data: String,
}

#[derive(Clone)]
pub struct SpawnProviderMetadata {
    pub provider: &'static str,
    pub provider_credential_id: String,
    pub model: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaudeStopMode {
    /// User pressed Stop; terminate the run immediately.
    Terminate,
    /// User wants to guide the next turn; prefer a graceful interrupt so
    /// Claude Code can persist session state before the frontend resumes it.
    Interrupt,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct ClaudeProcessKey {
    window_label: String,
    tab_id: String,
}

impl ClaudeProcessKey {
    fn new(window_label: &str, tab_id: &str) -> Self {
        Self {
            window_label: window_label.to_owned(),
            tab_id: tab_id.to_owned(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeStartReservation {
    key: ClaudeProcessKey,
    generation: u64,
    attempt_id: String,
}

#[derive(Debug, PartialEq, Eq)]
struct ClaudeStartReservationResult<Process> {
    reservation: ClaudeStartReservation,
    superseded_process: Option<Process>,
    cancelled: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum ClaudeActivation<Process> {
    Running,
    StopRequested {
        process: Process,
        mode: ClaudeStopMode,
    },
    Superseded(Process),
}

#[derive(Debug, PartialEq, Eq)]
enum ClaudeStopRequest<Process> {
    NotFound,
    Pending,
    InFlight,
    Running {
        reservation: ClaudeStartReservation,
        process: Process,
        mode: ClaudeStopMode,
    },
}

enum ClaudeProcessPhase<Process> {
    Starting {
        stop_mode: Option<ClaudeStopMode>,
    },
    Running(Process),
    Stopping {
        readers_drained: bool,
        process_finished: bool,
        requested_mode: ClaudeStopMode,
        escalation: Option<tokio::sync::watch::Sender<ClaudeStopMode>>,
    },
    Waiting,
}

struct ClaudeProcessEntry<Process> {
    generation: u64,
    attempt_id: String,
    phase: ClaudeProcessPhase<Process>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct ClaudeAttemptKey {
    key: ClaudeProcessKey,
    attempt_id: String,
}

struct ClaudeProcessRegistry<Process> {
    next_generation: u64,
    entries: HashMap<ClaudeProcessKey, ClaudeProcessEntry<Process>>,
    stop_tombstones: HashMap<ClaudeAttemptKey, (ClaudeStopMode, u64)>,
    recent_stop_tombstones: VecDeque<(ClaudeAttemptKey, u64)>,
    next_tombstone_id: u64,
}

impl<Process> Default for ClaudeProcessRegistry<Process> {
    fn default() -> Self {
        Self {
            next_generation: 0,
            entries: HashMap::new(),
            stop_tombstones: HashMap::new(),
            recent_stop_tombstones: VecDeque::new(),
            next_tombstone_id: 0,
        }
    }
}

impl<Process> ClaudeProcessRegistry<Process> {
    fn is_current(&self, reservation: &ClaudeStartReservation) -> bool {
        self.entries.get(&reservation.key).is_some_and(|entry| {
            entry.generation == reservation.generation && entry.attempt_id == reservation.attempt_id
        })
    }

    fn reserve_start(
        &mut self,
        window_label: &str,
        tab_id: &str,
        attempt_id: Option<&str>,
    ) -> ClaudeStartReservationResult<Process> {
        self.next_generation = self.next_generation.wrapping_add(1);
        if self.next_generation == 0 {
            self.next_generation = 1;
        }
        let key = ClaudeProcessKey::new(window_label, tab_id);
        let attempt_id = attempt_id
            .map(str::to_owned)
            .unwrap_or_else(|| format!("legacy:{}", self.next_generation));
        let reservation = ClaudeStartReservation {
            key: key.clone(),
            generation: self.next_generation,
            attempt_id: attempt_id.clone(),
        };
        if self
            .stop_tombstones
            .remove(&ClaudeAttemptKey { key, attempt_id })
            .is_some()
        {
            return ClaudeStartReservationResult {
                reservation,
                superseded_process: None,
                cancelled: true,
            };
        }
        let previous = self.entries.insert(
            reservation.key.clone(),
            ClaudeProcessEntry {
                generation: reservation.generation,
                attempt_id: reservation.attempt_id.clone(),
                phase: ClaudeProcessPhase::Starting { stop_mode: None },
            },
        );
        let superseded_process = previous.and_then(|entry| match entry.phase {
            ClaudeProcessPhase::Running(process) => Some(process),
            ClaudeProcessPhase::Starting { .. }
            | ClaudeProcessPhase::Stopping { .. }
            | ClaudeProcessPhase::Waiting => None,
        });
        ClaudeStartReservationResult {
            reservation,
            superseded_process,
            cancelled: false,
        }
    }

    fn record_stop_tombstone(&mut self, key: ClaudeAttemptKey, mode: ClaudeStopMode) {
        if let Some((recorded_mode, _)) = self.stop_tombstones.get_mut(&key) {
            if mode == ClaudeStopMode::Terminate {
                *recorded_mode = ClaudeStopMode::Terminate;
            }
            return;
        }
        self.next_tombstone_id = self.next_tombstone_id.wrapping_add(1);
        if self.next_tombstone_id == 0 {
            self.next_tombstone_id = 1;
        }
        let tombstone_id = self.next_tombstone_id;
        self.stop_tombstones
            .insert(key.clone(), (mode, tombstone_id));
        self.recent_stop_tombstones.push_back((key, tombstone_id));
        while self.recent_stop_tombstones.len() > RECENT_STOP_TOMBSTONE_LIMIT {
            if let Some((expired, expired_id)) = self.recent_stop_tombstones.pop_front() {
                if self.stop_tombstones.get(&expired).map(|entry| entry.1) == Some(expired_id) {
                    self.stop_tombstones.remove(&expired);
                }
            }
        }
    }

    fn request_stop_attempt(
        &mut self,
        window_label: &str,
        tab_id: &str,
        attempt_id: &str,
        mode: ClaudeStopMode,
    ) -> ClaudeStopRequest<Process> {
        let key = ClaudeProcessKey::new(window_label, tab_id);
        if self
            .entries
            .get(&key)
            .is_some_and(|entry| entry.attempt_id == attempt_id)
        {
            return self.request_stop(window_label, tab_id, mode);
        }
        self.record_stop_tombstone(
            ClaudeAttemptKey {
                key,
                attempt_id: attempt_id.to_owned(),
            },
            mode,
        );
        ClaudeStopRequest::Pending
    }

    fn take_stop_tombstone(&mut self, window_label: &str, tab_id: &str, attempt_id: &str) -> bool {
        self.stop_tombstones
            .remove(&ClaudeAttemptKey {
                key: ClaudeProcessKey::new(window_label, tab_id),
                attempt_id: attempt_id.to_owned(),
            })
            .is_some()
    }

    fn activate(
        &mut self,
        reservation: ClaudeStartReservation,
        process: Process,
    ) -> ClaudeActivation<Process> {
        let Some(entry) = self.entries.get_mut(&reservation.key) else {
            return ClaudeActivation::Superseded(process);
        };
        if entry.generation != reservation.generation || entry.attempt_id != reservation.attempt_id
        {
            return ClaudeActivation::Superseded(process);
        }

        let phase = std::mem::replace(
            &mut entry.phase,
            ClaudeProcessPhase::Stopping {
                readers_drained: false,
                process_finished: false,
                requested_mode: ClaudeStopMode::Terminate,
                escalation: None,
            },
        );
        match phase {
            ClaudeProcessPhase::Starting { stop_mode: None } => {
                entry.phase = ClaudeProcessPhase::Running(process);
                ClaudeActivation::Running
            }
            ClaudeProcessPhase::Starting {
                stop_mode: Some(mode),
            } => {
                entry.phase = ClaudeProcessPhase::Stopping {
                    readers_drained: false,
                    process_finished: false,
                    requested_mode: mode,
                    escalation: None,
                };
                ClaudeActivation::StopRequested { process, mode }
            }
            phase @ (ClaudeProcessPhase::Running(_)
            | ClaudeProcessPhase::Stopping { .. }
            | ClaudeProcessPhase::Waiting) => {
                entry.phase = phase;
                ClaudeActivation::Superseded(process)
            }
        }
    }

    fn request_stop(
        &mut self,
        window_label: &str,
        tab_id: &str,
        mode: ClaudeStopMode,
    ) -> ClaudeStopRequest<Process> {
        let key = ClaudeProcessKey::new(window_label, tab_id);
        let Some(entry) = self.entries.get_mut(&key) else {
            return ClaudeStopRequest::NotFound;
        };
        let reservation = ClaudeStartReservation {
            key,
            generation: entry.generation,
            attempt_id: entry.attempt_id.clone(),
        };
        let phase = std::mem::replace(
            &mut entry.phase,
            ClaudeProcessPhase::Stopping {
                readers_drained: false,
                process_finished: false,
                requested_mode: mode,
                escalation: None,
            },
        );
        match phase {
            ClaudeProcessPhase::Starting { stop_mode } => {
                let stop_mode = match (stop_mode, mode) {
                    (Some(ClaudeStopMode::Terminate), _) | (_, ClaudeStopMode::Terminate) => {
                        Some(ClaudeStopMode::Terminate)
                    }
                    _ => Some(ClaudeStopMode::Interrupt),
                };
                entry.phase = ClaudeProcessPhase::Starting { stop_mode };
                ClaudeStopRequest::Pending
            }
            ClaudeProcessPhase::Running(process) => ClaudeStopRequest::Running {
                reservation,
                process,
                mode,
            },
            ClaudeProcessPhase::Stopping {
                readers_drained,
                process_finished,
                mut requested_mode,
                escalation,
            } => {
                if mode == ClaudeStopMode::Terminate && requested_mode != ClaudeStopMode::Terminate
                {
                    requested_mode = ClaudeStopMode::Terminate;
                    if let Some(signal) = escalation.as_ref() {
                        signal.send_replace(ClaudeStopMode::Terminate);
                    }
                }
                entry.phase = ClaudeProcessPhase::Stopping {
                    readers_drained,
                    process_finished,
                    requested_mode,
                    escalation,
                };
                ClaudeStopRequest::InFlight
            }
            ClaudeProcessPhase::Waiting => {
                entry.phase = ClaudeProcessPhase::Waiting;
                ClaudeStopRequest::InFlight
            }
        }
    }

    fn begin_wait(&mut self, reservation: &ClaudeStartReservation) -> Option<Process> {
        let entry = self.entries.get_mut(&reservation.key)?;
        if entry.generation != reservation.generation || entry.attempt_id != reservation.attempt_id
        {
            return None;
        }
        let phase = std::mem::replace(&mut entry.phase, ClaudeProcessPhase::Waiting);
        match phase {
            ClaudeProcessPhase::Running(process) => Some(process),
            other => {
                entry.phase = other;
                None
            }
        }
    }

    fn attach_stop_escalation(
        &mut self,
        reservation: &ClaudeStartReservation,
        signal: tokio::sync::watch::Sender<ClaudeStopMode>,
    ) -> Option<ClaudeStopMode> {
        let entry = self.entries.get_mut(&reservation.key)?;
        if entry.generation != reservation.generation || entry.attempt_id != reservation.attempt_id
        {
            return None;
        }
        let ClaudeProcessPhase::Stopping {
            requested_mode,
            escalation,
            ..
        } = &mut entry.phase
        else {
            return None;
        };
        if *signal.borrow() != *requested_mode {
            signal.send_replace(*requested_mode);
        }
        *escalation = Some(signal);
        Some(*requested_mode)
    }

    fn finish_wait(&mut self, reservation: &ClaudeStartReservation) -> bool {
        self.finish_phase(reservation, |phase| {
            matches!(phase, ClaudeProcessPhase::Waiting)
        })
    }

    fn finish_stopped_process(&mut self, reservation: &ClaudeStartReservation) -> bool {
        self.finish_stopped_side(reservation, true)
    }

    fn finish_stopped_readers(&mut self, reservation: &ClaudeStartReservation) -> bool {
        self.finish_stopped_side(reservation, false)
    }

    fn fail_start(&mut self, reservation: &ClaudeStartReservation) -> bool {
        self.finish_phase(reservation, |phase| {
            matches!(phase, ClaudeProcessPhase::Starting { .. })
        })
    }

    fn abort_running_start(&mut self, reservation: &ClaudeStartReservation) -> Option<Process> {
        let entry = self.entries.get_mut(&reservation.key)?;
        if entry.generation != reservation.generation || entry.attempt_id != reservation.attempt_id
        {
            return None;
        }
        let phase = std::mem::replace(
            &mut entry.phase,
            ClaudeProcessPhase::Stopping {
                readers_drained: false,
                process_finished: false,
                requested_mode: ClaudeStopMode::Terminate,
                escalation: None,
            },
        );
        match phase {
            ClaudeProcessPhase::Running(process) => Some(process),
            other => {
                entry.phase = other;
                None
            }
        }
    }

    fn remove_window(&mut self, window_label: &str) -> Vec<Process> {
        let keys = self
            .entries
            .keys()
            .filter(|key| key.window_label == window_label)
            .cloned()
            .collect::<Vec<_>>();
        keys.into_iter()
            .filter_map(|key| self.entries.remove(&key))
            .filter_map(|entry| match entry.phase {
                ClaudeProcessPhase::Running(process) => Some(process),
                ClaudeProcessPhase::Starting { .. }
                | ClaudeProcessPhase::Stopping { .. }
                | ClaudeProcessPhase::Waiting => None,
            })
            .collect()
    }

    fn finish_stopped_side(
        &mut self,
        reservation: &ClaudeStartReservation,
        process_finished: bool,
    ) -> bool {
        let should_remove = {
            let Some(entry) = self.entries.get_mut(&reservation.key) else {
                return false;
            };
            if entry.generation != reservation.generation
                || entry.attempt_id != reservation.attempt_id
            {
                return false;
            }
            let ClaudeProcessPhase::Stopping {
                readers_drained,
                process_finished: recorded_process_finished,
                ..
            } = &mut entry.phase
            else {
                return false;
            };

            if process_finished {
                *recorded_process_finished = true;
            } else {
                *readers_drained = true;
            }
            *readers_drained && *recorded_process_finished
        };
        if should_remove {
            self.entries.remove(&reservation.key);
        }
        should_remove
    }

    fn finish_phase<Matches>(
        &mut self,
        reservation: &ClaudeStartReservation,
        matches_phase: Matches,
    ) -> bool
    where
        Matches: FnOnce(&ClaudeProcessPhase<Process>) -> bool,
    {
        let should_remove = self.entries.get(&reservation.key).is_some_and(|entry| {
            entry.generation == reservation.generation
                && entry.attempt_id == reservation.attempt_id
                && matches_phase(&entry.phase)
        });
        if should_remove {
            self.entries.remove(&reservation.key);
        }
        should_remove
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ClaudeMissingProcessPolicy {
    EmitLegacyCompletion,
    Silent,
}

#[cfg(test)]
fn finish_missing_claude_process<Emit, Output>(
    policy: ClaudeMissingProcessPolicy,
    emit: Emit,
) -> bool
where
    Emit: FnOnce() -> Output,
{
    if policy == ClaudeMissingProcessPolicy::EmitLegacyCompletion {
        emit();
    }
    false
}

async fn emit_claude_complete(
    window: &WebviewWindow,
    tab_id: &str,
    attempt_id: &str,
    success: bool,
) {
    let routes = window.state::<crate::runtime::process::RuntimeProcessState>();
    routes
        .remove_tab_for_attempt(window.label(), tab_id, attempt_id)
        .await;
    let _ = window.emit(
        "claude-complete",
        ClaudeCompleteEvent {
            tab_id: tab_id.to_owned(),
            attempt_id: attempt_id.to_owned(),
            success,
        },
    );
}

#[derive(Debug, PartialEq, Eq)]
enum GracefulStopWait<Output> {
    Completed(Output),
    Force,
}

async fn await_graceful_stop<Wait>(
    mode: ClaudeStopMode,
    mut escalation: tokio::sync::watch::Receiver<ClaudeStopMode>,
    grace: Duration,
    wait: Wait,
) -> GracefulStopWait<Wait::Output>
where
    Wait: Future,
{
    if mode == ClaudeStopMode::Terminate {
        return GracefulStopWait::Force;
    }
    tokio::pin!(wait);
    tokio::select! {
        output = &mut wait => GracefulStopWait::Completed(output),
        _ = tokio::time::sleep(grace) => GracefulStopWait::Force,
        _ = escalation.changed() => GracefulStopWait::Force,
    }
}

fn finalize_stopped_process(
    window: WebviewWindow,
    tab_id: String,
    registry: Arc<Mutex<ClaudeProcessRegistry<Child>>>,
    reservation: ClaudeStartReservation,
    mut process: Child,
    mode: ClaudeStopMode,
) {
    tokio::spawn(async move {
        let (escalation_tx, escalation_rx) = tokio::sync::watch::channel(mode);
        let effective_mode = {
            let mut registry = registry.lock().await;
            registry
                .attach_stop_escalation(&reservation, escalation_tx)
                .unwrap_or(ClaudeStopMode::Terminate)
        };
        if effective_mode == ClaudeStopMode::Interrupt {
            interrupt_or_terminate(&mut process).await;
        }
        let wait_result = await_graceful_stop(
            effective_mode,
            escalation_rx,
            CLAUDE_INTERRUPT_GRACE,
            process.wait(),
        )
        .await;
        match wait_result {
            GracefulStopWait::Completed(Ok(_)) => {}
            GracefulStopWait::Completed(Err(error)) => {
                eprintln!(
                    "[claude-process] [{}] stopped process wait error: {}",
                    tab_id, error
                );
            }
            GracefulStopWait::Force => {
                terminate_process_tree(&mut process).await;
                match tokio::time::timeout(CLAUDE_FORCE_REAP_TIMEOUT, process.wait()).await {
                    Ok(Ok(_)) => {}
                    Ok(Err(error)) => eprintln!(
                        "[claude-process] [{}] forced process wait error: {}",
                        tab_id, error
                    ),
                    Err(_) => eprintln!(
                        "[claude-process] [{}] forced process reap timed out",
                        tab_id
                    ),
                }
            }
        }

        let should_emit = {
            let mut registry = registry.lock().await;
            registry.finish_stopped_process(&reservation)
        };
        if should_emit {
            emit_claude_complete(&window, &tab_id, &reservation.attempt_id, false).await;
        }
    });
}

pub(crate) async fn reserve_claude_start(
    window: &WebviewWindow,
    tab_id: &str,
    attempt_id: Option<&str>,
) -> Option<ClaudeStartReservation> {
    let registry = window
        .state::<ClaudeProcessState>()
        .inner()
        .registry
        .clone();
    let reserved = {
        let mut registry = registry.lock().await;
        registry.reserve_start(window.label(), tab_id, attempt_id)
    };
    if reserved.cancelled {
        emit_claude_complete(window, tab_id, &reserved.reservation.attempt_id, false).await;
        return None;
    }
    if let Some(mut process) = reserved.superseded_process {
        terminate_process_tree(&mut process).await;
        let _ = process.wait().await;
    }
    Some(reserved.reservation)
}

pub(crate) async fn settle_rejected_claude_start(
    window: &WebviewWindow,
    tab_id: &str,
    attempt_id: &str,
) -> bool {
    let should_emit = {
        let state = window.state::<ClaudeProcessState>();
        let mut registry = state.registry.lock().await;
        registry.take_stop_tombstone(window.label(), tab_id, attempt_id)
    };
    if should_emit {
        emit_claude_complete(window, tab_id, attempt_id, false).await;
    }
    should_emit
}

pub(crate) async fn fail_claude_start(
    window: &WebviewWindow,
    reservation: &ClaudeStartReservation,
) -> bool {
    let should_emit = {
        let state = window.state::<ClaudeProcessState>();
        let mut registry = state.registry.lock().await;
        registry.fail_start(reservation)
    };
    if should_emit {
        emit_claude_complete(
            window,
            &reservation.key.tab_id,
            &reservation.attempt_id,
            false,
        )
        .await;
    }
    should_emit
}

/// Spawn the Claude CLI process and stream output via Tauri events.
/// Events are emitted only to the originating window, tagged with tab_id.
pub async fn spawn_claude_process(
    window: WebviewWindow,
    mut cmd: Command,
    tab_id: String,
    reservation: ClaudeStartReservation,
    stdin_payload: Option<String>,
    provider_metadata: Option<SpawnProviderMetadata>,
) -> Result<(), String> {
    if reservation.key != ClaudeProcessKey::new(window.label(), &tab_id) {
        return Err("Claude start reservation does not match its window and tab".into());
    }
    let registry = window
        .state::<ClaudeProcessState>()
        .inner()
        .registry
        .clone();

    if stdin_payload.is_some() {
        cmd.stdin(std::process::Stdio::piped());
    }

    let mut child = cmd.spawn().map_err(|e| {
        eprintln!(
            "[claude-spawn] Failed to spawn process for tab {}: {}",
            tab_id, e
        );
        format!(
            "Failed to spawn Claude process: {}. Is Claude Code CLI installed?",
            e
        )
    })?;

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate_process_tree(&mut child).await;
            return Err("Failed to capture stdout".into());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            terminate_process_tree(&mut child).await;
            return Err("Failed to capture stderr".into());
        }
    };

    let stdin = if stdin_payload.is_some() {
        let Some(stdin) = child.stdin.take() else {
            terminate_process_tree(&mut child).await;
            return Err("Failed to acquire stdin for Claude process".into());
        };
        Some(stdin)
    } else {
        None
    };

    let activation = {
        let mut registry = registry.lock().await;
        registry.activate(reservation.clone(), child)
    };
    let stop_requested = match activation {
        ClaudeActivation::Running => None,
        ClaudeActivation::StopRequested { process, mode } => Some((process, mode)),
        ClaudeActivation::Superseded(mut process) => {
            terminate_process_tree(&mut process).await;
            let _ = process.wait().await;
            return Ok(());
        }
    };

    let stdout_reader = BufReader::new(stdout);
    let stderr_reader = BufReader::new(stderr);
    let result_success_holder: Arc<std::sync::Mutex<Option<bool>>> =
        Arc::new(std::sync::Mutex::new(None));

    let start_time = std::time::Instant::now();

    let win_stdout = window.clone();
    let result_success_stdout = result_success_holder.clone();
    let tab_id_stdout = tab_id.clone();
    let provider_metadata_stdout = provider_metadata.clone();
    let registry_stdout = registry.clone();
    let reservation_stdout = reservation.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = stdout_reader.lines();
        let mut line_count: u64 = 0;
        while let Ok(Some(mut line)) = lines.next_line().await {
            line_count += 1;
            let elapsed = start_time.elapsed().as_secs_f64();

            if let Ok(mut msg) = serde_json::from_str::<serde_json::Value>(&line) {
                let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("?");
                let msg_sub = msg.get("subtype").and_then(|v| v.as_str()).unwrap_or("");
                eprintln!(
                    "[claude-stdout] [{}] +{:.1}s #{} type={} sub={} len={}",
                    tab_id_stdout,
                    elapsed,
                    line_count,
                    msg_type,
                    msg_sub,
                    line.len()
                );

                if msg.get("type").and_then(|v| v.as_str()) == Some("system")
                    && msg.get("subtype").and_then(|v| v.as_str()) == Some("init")
                {
                    if let Some(metadata) = provider_metadata_stdout.as_ref() {
                        if let Some(object) = msg.as_object_mut() {
                            object.insert(
                                "provider".to_string(),
                                serde_json::Value::String(metadata.provider.to_string()),
                            );
                            object.insert(
                                "provider_credential_id".to_string(),
                                serde_json::Value::String(metadata.provider_credential_id.clone()),
                            );
                            object.insert(
                                "model".to_string(),
                                serde_json::Value::String(metadata.model.clone()),
                            );
                        }
                        line = msg.to_string();
                    }
                }

                if msg.get("type").and_then(|v| v.as_str()) == Some("result") {
                    let is_success = msg.get("subtype").and_then(|v| v.as_str()) == Some("success");
                    if let Ok(mut guard) = result_success_stdout.lock() {
                        *guard = Some(is_success);
                    }
                }
            }

            let should_emit = {
                let registry = registry_stdout.lock().await;
                registry.is_current(&reservation_stdout)
            };
            if should_emit {
                let _ = win_stdout.emit(
                    "claude-output",
                    ClaudeOutputEvent {
                        tab_id: tab_id_stdout.clone(),
                        attempt_id: reservation_stdout.attempt_id.clone(),
                        data: line,
                    },
                );
            }
        }
        eprintln!(
            "[claude-stdout] [{}] stream ended after {} lines ({:.1}s)",
            tab_id_stdout,
            line_count,
            start_time.elapsed().as_secs_f64()
        );
    });

    let win_stderr = window.clone();
    let tab_id_stderr = tab_id.clone();
    let registry_stderr = registry.clone();
    let reservation_stderr = reservation.clone();
    let stderr_task = tokio::spawn(async move {
        let mut lines = stderr_reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            eprintln!(
                "[claude-stderr] [{}] +{:.1}s {}",
                tab_id_stderr,
                start_time.elapsed().as_secs_f64(),
                &line[..line.len().min(200)]
            );
            let should_emit = {
                let registry = registry_stderr.lock().await;
                registry.is_current(&reservation_stderr)
            };
            if should_emit {
                let _ = win_stderr.emit(
                    "claude-error",
                    ClaudeErrorEvent {
                        tab_id: tab_id_stderr.clone(),
                        attempt_id: reservation_stderr.attempt_id.clone(),
                        data: line,
                    },
                );
            }
        }
    });

    let registry_wait = registry.clone();
    let win_wait = window.clone();
    let tab_id_wait = tab_id.clone();
    let reservation_wait = reservation.clone();
    let result_success_wait = result_success_holder.clone();
    let (startup_complete_tx, startup_complete_rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let _ = stdout_task.await;
        let _ = stderr_task.await;
        let _ = startup_complete_rx.await;

        let (child, should_emit_stopped) = {
            let mut registry = registry_wait.lock().await;
            let should_emit_stopped = registry.finish_stopped_readers(&reservation_wait);
            let child = if should_emit_stopped {
                None
            } else {
                registry.begin_wait(&reservation_wait)
            };
            (child, should_emit_stopped)
        };
        if should_emit_stopped {
            emit_claude_complete(&win_wait, &tab_id_wait, &reservation_wait.attempt_id, false)
                .await;
            return;
        }
        let Some(mut child) = child else {
            return;
        };
        let success = match child.wait().await {
            Ok(status) => {
                let exit_success = status.success();
                let result_success = result_success_wait.lock().ok().and_then(|guard| *guard);
                let success = exit_success || result_success == Some(true);
                eprintln!(
                    "[claude-process] [{}] exited with status={} result_success={:?} final_success={} ({:.1}s)",
                    tab_id_wait,
                    status,
                    result_success,
                    success,
                    start_time.elapsed().as_secs_f64()
                );
                success
            }
            Err(error) => {
                eprintln!(
                    "[claude-process] [{}] wait error: {} ({:.1}s)",
                    tab_id_wait,
                    error,
                    start_time.elapsed().as_secs_f64()
                );
                false
            }
        };

        let should_emit = {
            let mut registry = registry_wait.lock().await;
            registry.finish_wait(&reservation_wait)
        };
        if should_emit {
            emit_claude_complete(
                &win_wait,
                &tab_id_wait,
                &reservation_wait.attempt_id,
                success,
            )
            .await;
        }
    });

    if let Some((process, mode)) = stop_requested {
        drop(stdin);
        let _ = startup_complete_tx.send(());
        finalize_stopped_process(window, tab_id, registry, reservation, process, mode);
        return Ok(());
    }

    let stdin_result = match (stdin, stdin_payload) {
        (Some(mut stdin), Some(payload)) => {
            async {
                stdin.write_all(payload.as_bytes()).await.map_err(|error| {
                    format!("Failed to write prompt to Claude process stdin: {}", error)
                })?;
                stdin
                    .shutdown()
                    .await
                    .map_err(|error| format!("Failed to close Claude process stdin: {}", error))
            }
            .await
        }
        _ => Ok(()),
    };
    if let Err(error) = stdin_result {
        let process = {
            let mut registry = registry.lock().await;
            registry.abort_running_start(&reservation)
        };
        if let Some(process) = process {
            finalize_stopped_process(
                window,
                tab_id,
                registry,
                reservation,
                process,
                ClaudeStopMode::Terminate,
            );
        }
        let _ = startup_complete_tx.send(());
        return Err(error);
    }
    let _ = startup_complete_tx.send(());

    Ok(())
}

pub async fn stop_claude_process(
    window: WebviewWindow,
    tab_id: String,
    mode: ClaudeStopMode,
    attempt_id: Option<String>,
) -> Result<bool, String> {
    stop_claude_process_with_missing_policy(
        window,
        tab_id,
        mode,
        attempt_id,
        ClaudeMissingProcessPolicy::EmitLegacyCompletion,
    )
    .await
}

pub(crate) async fn stop_claude_process_silently_if_missing(
    window: WebviewWindow,
    tab_id: String,
    mode: ClaudeStopMode,
    attempt_id: String,
) -> Result<bool, String> {
    stop_claude_process_with_missing_policy(
        window,
        tab_id,
        mode,
        Some(attempt_id),
        ClaudeMissingProcessPolicy::Silent,
    )
    .await
}

async fn stop_claude_process_with_missing_policy(
    window: WebviewWindow,
    tab_id: String,
    mode: ClaudeStopMode,
    attempt_id: Option<String>,
    missing_policy: ClaudeMissingProcessPolicy,
) -> Result<bool, String> {
    let window_label = window.label().to_string();
    let registry = window
        .state::<ClaudeProcessState>()
        .inner()
        .registry
        .clone();
    let request = {
        let mut registry = registry.lock().await;
        if let Some(attempt_id) = attempt_id.as_deref() {
            registry.request_stop_attempt(&window_label, &tab_id, attempt_id, mode)
        } else {
            registry.request_stop(&window_label, &tab_id, mode)
        }
    };

    match request {
        ClaudeStopRequest::NotFound => {
            let should_emit = missing_policy == ClaudeMissingProcessPolicy::EmitLegacyCompletion;
            if should_emit {
                emit_claude_complete(
                    &window,
                    &tab_id,
                    attempt_id.as_deref().unwrap_or("legacy-missing"),
                    false,
                )
                .await;
            }
            Ok(false)
        }
        ClaudeStopRequest::Pending | ClaudeStopRequest::InFlight => Ok(true),
        ClaudeStopRequest::Running {
            reservation,
            process,
            mode,
        } => {
            finalize_stopped_process(window, tab_id, registry, reservation, process, mode);
            Ok(true)
        }
    }
}

#[cfg(unix)]
async fn interrupt_or_terminate(child: &mut Child) -> bool {
    if let Some(pid) = child.id() {
        let status = tokio::process::Command::new("kill")
            .arg("-INT")
            .arg(pid.to_string())
            .status()
            .await;
        if matches!(status, Ok(status) if status.success()) {
            return true;
        }
    }
    terminate_process_tree(child).await;
    true
}

#[cfg(not(unix))]
async fn interrupt_or_terminate(child: &mut Child) -> bool {
    // Windows GUI processes do not have a reliable console-control path from
    // Tauri without a PTY/ConPTY session. For guided follow-ups, fall back to
    // terminating the current run so the frontend can immediately continue the
    // same tab with the queued guidance.
    terminate_process_tree(child).await;
    true
}

#[cfg(windows)]
async fn terminate_process_tree(child: &mut Child) {
    if let Some(pid) = child.id() {
        let _ = Command::new("taskkill")
            .creation_flags(CREATE_NO_WINDOW)
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status()
            .await;
    }
    let _ = child.start_kill();
}

#[cfg(not(windows))]
async fn terminate_process_tree(child: &mut Child) {
    let _ = child.start_kill();
}

/// Kill all Claude processes associated with a specific window label.
/// Called when a window is destroyed.
pub async fn kill_process_for_window(state: &ClaudeProcessState, window_label: &str) {
    let processes = {
        let mut registry = state.registry.lock().await;
        registry.remove_window(window_label)
    };
    for mut process in processes {
        terminate_process_tree(&mut process).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn runtime_missing_process_is_silent_and_returns_false() {
        let emitted = AtomicUsize::new(0);
        let stopped = finish_missing_claude_process(ClaudeMissingProcessPolicy::Silent, || {
            emitted.fetch_add(1, Ordering::SeqCst)
        });

        assert!(!stopped);
        assert_eq!(emitted.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn legacy_missing_process_still_emits_completion_and_returns_false() {
        let emitted = AtomicUsize::new(0);
        let stopped =
            finish_missing_claude_process(ClaudeMissingProcessPolicy::EmitLegacyCompletion, || {
                emitted.fetch_add(1, Ordering::SeqCst)
            });

        assert!(!stopped);
        assert_eq!(emitted.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn pending_start_accepts_stop_and_activation_cannot_continue_the_child() {
        let mut registry = ClaudeProcessRegistry::<&'static str>::default();
        let reserved = registry.reserve_start("window-a", "tab-a", None);

        assert_eq!(reserved.superseded_process, None);
        assert_eq!(
            registry.request_stop("window-a", "tab-a", ClaudeStopMode::Interrupt),
            ClaudeStopRequest::Pending
        );
        assert_eq!(
            registry.activate(reserved.reservation.clone(), "child-a"),
            ClaudeActivation::StopRequested {
                process: "child-a",
                mode: ClaudeStopMode::Interrupt,
            }
        );
        assert!(!registry.finish_stopped_process(&reserved.reservation));
        assert!(registry.finish_stopped_readers(&reserved.reservation));
        assert_eq!(
            registry.request_stop("window-a", "tab-a", ClaudeStopMode::Terminate),
            ClaudeStopRequest::NotFound
        );
    }

    #[test]
    fn superseded_pending_start_cannot_register_after_a_new_generation() {
        let mut registry = ClaudeProcessRegistry::<&'static str>::default();
        let first = registry.reserve_start("window-a", "tab-a", None);
        let second = registry.reserve_start("window-a", "tab-a", None);

        assert!(second.reservation.generation > first.reservation.generation);
        assert_eq!(
            registry.activate(first.reservation, "child-old"),
            ClaudeActivation::Superseded("child-old")
        );
        assert_eq!(
            registry.activate(second.reservation.clone(), "child-new"),
            ClaudeActivation::Running
        );
        assert_eq!(
            registry.request_stop("window-a", "tab-a", ClaudeStopMode::Terminate),
            ClaudeStopRequest::Running {
                reservation: second.reservation,
                process: "child-new",
                mode: ClaudeStopMode::Terminate,
            }
        );
    }

    #[test]
    fn old_waiter_cannot_remove_or_emit_for_a_new_generation() {
        let mut registry = ClaudeProcessRegistry::<&'static str>::default();
        let first = registry
            .reserve_start("window-a", "tab-a", None)
            .reservation;
        assert_eq!(
            registry.activate(first.clone(), "child-old"),
            ClaudeActivation::Running
        );
        assert_eq!(registry.begin_wait(&first), Some("child-old"));

        let second = registry
            .reserve_start("window-a", "tab-a", None)
            .reservation;
        assert_eq!(
            registry.activate(second.clone(), "child-new"),
            ClaudeActivation::Running
        );

        assert!(!registry.finish_wait(&first));
        assert_eq!(
            registry.request_stop("window-a", "tab-a", ClaudeStopMode::Terminate),
            ClaudeStopRequest::Running {
                reservation: second,
                process: "child-new",
                mode: ClaudeStopMode::Terminate,
            }
        );
    }

    #[test]
    fn failed_start_cleans_only_its_current_reservation_for_terminal_delivery() {
        let mut registry = ClaudeProcessRegistry::<&'static str>::default();
        let failed = registry
            .reserve_start("window-a", "tab-a", None)
            .reservation;
        assert_eq!(
            registry.request_stop("window-a", "tab-a", ClaudeStopMode::Terminate),
            ClaudeStopRequest::Pending
        );
        assert!(registry.fail_start(&failed));
        assert!(!registry.fail_start(&failed));

        let stale = registry
            .reserve_start("window-a", "tab-a", None)
            .reservation;
        let current = registry
            .reserve_start("window-a", "tab-a", None)
            .reservation;
        assert!(!registry.fail_start(&stale));
        assert!(registry.fail_start(&current));
    }

    #[test]
    fn registry_isolates_same_tab_between_windows_and_tabs_within_a_window() {
        let mut registry = ClaudeProcessRegistry::<&'static str>::default();
        let window_a_tab = registry
            .reserve_start("window-a", "shared", None)
            .reservation;
        let window_b_tab = registry
            .reserve_start("window-b", "shared", None)
            .reservation;
        let window_a_other = registry
            .reserve_start("window-a", "other", None)
            .reservation;
        assert_eq!(
            registry.activate(window_a_tab.clone(), "child-a"),
            ClaudeActivation::Running
        );
        assert_eq!(
            registry.activate(window_b_tab.clone(), "child-b"),
            ClaudeActivation::Running
        );
        assert_eq!(
            registry.activate(window_a_other.clone(), "child-c"),
            ClaudeActivation::Running
        );

        assert_eq!(
            registry.request_stop("window-a", "shared", ClaudeStopMode::Interrupt),
            ClaudeStopRequest::Running {
                reservation: window_a_tab,
                process: "child-a",
                mode: ClaudeStopMode::Interrupt,
            }
        );
        assert_eq!(registry.begin_wait(&window_b_tab), Some("child-b"));
        assert_eq!(registry.begin_wait(&window_a_other), Some("child-c"));
    }

    #[test]
    fn removing_a_window_invalidates_pending_starts_and_returns_only_its_running_children() {
        let mut registry = ClaudeProcessRegistry::<&'static str>::default();
        let running = registry
            .reserve_start("window-a", "running", None)
            .reservation;
        let pending = registry
            .reserve_start("window-a", "pending", None)
            .reservation;
        let other = registry
            .reserve_start("window-b", "running", None)
            .reservation;
        assert_eq!(
            registry.activate(running, "child-a"),
            ClaudeActivation::Running
        );
        assert_eq!(
            registry.activate(other.clone(), "child-b"),
            ClaudeActivation::Running
        );

        assert_eq!(registry.remove_window("window-a"), ["child-a"]);
        assert_eq!(
            registry.activate(pending, "child-late"),
            ClaudeActivation::Superseded("child-late")
        );
        assert_eq!(registry.begin_wait(&other), Some("child-b"));
    }

    #[test]
    fn separator_characters_in_window_and_tab_ids_do_not_collide() {
        let mut registry = ClaudeProcessRegistry::<&'static str>::default();
        let first = registry.reserve_start("window:a", "tab", None).reservation;
        let second = registry.reserve_start("window", "a:tab", None).reservation;

        assert_eq!(
            registry.activate(first.clone(), "child-a"),
            ClaudeActivation::Running
        );
        assert_eq!(
            registry.activate(second.clone(), "child-b"),
            ClaudeActivation::Running
        );
        assert_eq!(registry.begin_wait(&first), Some("child-a"));
        assert_eq!(registry.begin_wait(&second), Some("child-b"));
    }

    #[test]
    fn stdin_failure_takes_only_its_running_generation_for_cleanup() {
        let mut registry = ClaudeProcessRegistry::<&'static str>::default();
        let failed = registry
            .reserve_start("window-a", "tab-a", None)
            .reservation;
        assert_eq!(
            registry.activate(failed.clone(), "child-failed"),
            ClaudeActivation::Running
        );
        assert_eq!(registry.abort_running_start(&failed), Some("child-failed"));
        assert_eq!(registry.abort_running_start(&failed), None);
        assert!(!registry.finish_stopped_process(&failed));
        assert!(registry.finish_stopped_readers(&failed));

        let stale = registry
            .reserve_start("window-a", "tab-a", None)
            .reservation;
        assert_eq!(
            registry.activate(stale.clone(), "child-stale"),
            ClaudeActivation::Running
        );
        let current = registry
            .reserve_start("window-a", "tab-a", None)
            .reservation;
        assert_eq!(
            registry.activate(current.clone(), "child-current"),
            ClaudeActivation::Running
        );
        assert_eq!(registry.abort_running_start(&stale), None);
        assert_eq!(
            registry.request_stop("window-a", "tab-a", ClaudeStopMode::Terminate),
            ClaudeStopRequest::Running {
                reservation: current,
                process: "child-current",
                mode: ClaudeStopMode::Terminate,
            }
        );
    }

    #[test]
    fn stopped_process_emits_only_after_process_and_readers_finish_in_either_order() {
        let mut process_first = ClaudeProcessRegistry::<&'static str>::default();
        let process_first_reservation = process_first
            .reserve_start("window-a", "tab-a", None)
            .reservation;
        assert_eq!(
            process_first.activate(process_first_reservation.clone(), "child-a"),
            ClaudeActivation::Running
        );
        assert!(matches!(
            process_first.request_stop("window-a", "tab-a", ClaudeStopMode::Terminate),
            ClaudeStopRequest::Running { .. }
        ));

        assert!(!process_first.finish_stopped_process(&process_first_reservation));
        assert!(process_first.finish_stopped_readers(&process_first_reservation));
        assert!(!process_first.finish_stopped_process(&process_first_reservation));
        assert!(!process_first.finish_stopped_readers(&process_first_reservation));

        let mut readers_first = ClaudeProcessRegistry::<&'static str>::default();
        let readers_first_reservation = readers_first
            .reserve_start("window-a", "tab-a", None)
            .reservation;
        assert_eq!(
            readers_first.activate(readers_first_reservation.clone(), "child-a"),
            ClaudeActivation::Running
        );
        assert!(matches!(
            readers_first.request_stop("window-a", "tab-a", ClaudeStopMode::Interrupt),
            ClaudeStopRequest::Running { .. }
        ));

        assert!(!readers_first.finish_stopped_readers(&readers_first_reservation));
        assert!(readers_first.finish_stopped_process(&readers_first_reservation));
        assert!(!readers_first.finish_stopped_process(&readers_first_reservation));
        assert!(!readers_first.finish_stopped_readers(&readers_first_reservation));
    }

    #[test]
    fn stopped_old_generation_cannot_finish_or_emit_for_the_new_generation() {
        let mut registry = ClaudeProcessRegistry::<&'static str>::default();
        let old = registry
            .reserve_start("window-a", "tab-a", None)
            .reservation;
        assert_eq!(
            registry.activate(old.clone(), "child-old"),
            ClaudeActivation::Running
        );
        assert!(matches!(
            registry.request_stop("window-a", "tab-a", ClaudeStopMode::Terminate),
            ClaudeStopRequest::Running { .. }
        ));

        let current = registry
            .reserve_start("window-a", "tab-a", None)
            .reservation;
        assert_eq!(
            registry.activate(current.clone(), "child-current"),
            ClaudeActivation::Running
        );
        assert!(!registry.finish_stopped_process(&old));
        assert!(!registry.finish_stopped_readers(&old));
        assert_eq!(
            registry.request_stop("window-a", "tab-a", ClaudeStopMode::Terminate),
            ClaudeStopRequest::Running {
                reservation: current,
                process: "child-current",
                mode: ClaudeStopMode::Terminate,
            }
        );
    }

    #[test]
    fn superseded_generation_is_not_current_for_buffered_output_delivery() {
        let mut registry = ClaudeProcessRegistry::<&'static str>::default();
        let old = registry
            .reserve_start("window-a", "tab-a", None)
            .reservation;
        assert!(registry.is_current(&old));

        let current = registry
            .reserve_start("window-a", "tab-a", None)
            .reservation;
        assert!(!registry.is_current(&old));
        assert!(registry.is_current(&current));
    }

    #[test]
    fn stop_before_reserve_is_consumed_only_by_the_matching_attempt() {
        let mut registry = ClaudeProcessRegistry::<&'static str>::default();
        assert_eq!(
            registry.request_stop_attempt(
                "window-a",
                "tab-a",
                "attempt-old",
                ClaudeStopMode::Terminate,
            ),
            ClaudeStopRequest::Pending
        );

        let cancelled = registry.reserve_start("window-a", "tab-a", Some("attempt-old"));
        assert!(cancelled.cancelled);
        assert_eq!(cancelled.reservation.attempt_id, "attempt-old");

        let current = registry.reserve_start("window-a", "tab-a", Some("attempt-new"));
        assert!(!current.cancelled);
        assert_eq!(current.reservation.attempt_id, "attempt-new");
    }

    #[test]
    fn rejected_claude_start_consumes_only_its_exact_stop_tombstone() {
        let mut registry = ClaudeProcessRegistry::<&'static str>::default();
        assert_eq!(
            registry.request_stop_attempt(
                "window-a",
                "tab-a",
                "attempt-old",
                ClaudeStopMode::Terminate,
            ),
            ClaudeStopRequest::Pending
        );
        assert!(!registry.take_stop_tombstone("window-a", "tab-a", "attempt-new"));
        assert!(registry.take_stop_tombstone("window-a", "tab-a", "attempt-old"));
        let retry = registry.reserve_start("window-a", "tab-a", Some("attempt-old"));
        assert!(!retry.cancelled);
        assert!(registry.is_current(&retry.reservation));
    }

    #[test]
    fn old_attempt_stop_never_takes_the_new_attempt_child() {
        let mut registry = ClaudeProcessRegistry::<&'static str>::default();
        let current = registry
            .reserve_start("window-a", "tab-a", Some("attempt-new"))
            .reservation;
        assert_eq!(
            registry.activate(current.clone(), "child-new"),
            ClaudeActivation::Running
        );

        assert_eq!(
            registry.request_stop_attempt(
                "window-a",
                "tab-a",
                "attempt-old",
                ClaudeStopMode::Terminate,
            ),
            ClaudeStopRequest::Pending
        );
        assert!(registry.is_current(&current));
        assert_eq!(
            registry.request_stop_attempt(
                "window-a",
                "tab-a",
                "attempt-new",
                ClaudeStopMode::Terminate,
            ),
            ClaudeStopRequest::Running {
                reservation: current,
                process: "child-new",
                mode: ClaudeStopMode::Terminate,
            }
        );
    }

    #[test]
    fn terminate_escalates_an_inflight_interrupt_for_the_same_attempt() {
        let mut registry = ClaudeProcessRegistry::<&'static str>::default();
        let reservation = registry
            .reserve_start("window-a", "tab-a", Some("attempt-a"))
            .reservation;
        assert_eq!(
            registry.activate(reservation.clone(), "child-a"),
            ClaudeActivation::Running
        );
        assert!(matches!(
            registry.request_stop_attempt(
                "window-a",
                "tab-a",
                "attempt-a",
                ClaudeStopMode::Interrupt,
            ),
            ClaudeStopRequest::Running {
                mode: ClaudeStopMode::Interrupt,
                ..
            }
        ));
        let (escalation, mut escalated) = tokio::sync::watch::channel(ClaudeStopMode::Interrupt);
        assert_eq!(
            registry.attach_stop_escalation(&reservation, escalation),
            Some(ClaudeStopMode::Interrupt)
        );
        assert!(!escalated.has_changed().unwrap());

        assert_eq!(
            registry.request_stop_attempt(
                "window-a",
                "tab-a",
                "attempt-a",
                ClaudeStopMode::Terminate,
            ),
            ClaudeStopRequest::InFlight
        );
        assert!(escalated.has_changed().unwrap());
        assert_eq!(*escalated.borrow_and_update(), ClaudeStopMode::Terminate);
    }

    #[tokio::test]
    async fn ignored_interrupt_reaches_force_after_a_bounded_grace_period() {
        let (_escalation, escalated) = tokio::sync::watch::channel(ClaudeStopMode::Interrupt);
        assert_eq!(
            await_graceful_stop(
                ClaudeStopMode::Interrupt,
                escalated,
                Duration::from_millis(1),
                std::future::pending::<()>(),
            )
            .await,
            GracefulStopWait::Force
        );
    }

    #[test]
    fn legacy_claude_events_scope_every_payload_to_an_attempt() {
        let value = serde_json::to_value(ClaudeCompleteEvent {
            tab_id: "tab-a".into(),
            attempt_id: "attempt-a".into(),
            success: false,
        })
        .unwrap();

        assert_eq!(value["tab_id"], "tab-a");
        assert_eq!(value["attempt_id"], "attempt-a");
    }
}
