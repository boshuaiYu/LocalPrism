use super::approvals::{
    auto_accept_response, is_codex_approval_request, map_decision_to_response,
    redact_request_details, ApprovalState, PendingRuntimeRequest,
};
use super::discovery::{
    attach_process_tree, discover_codex_binary, isolate_process_tree,
    probe_known_codex_binary_on_disk, terminate_process_tree, ProcessTreeGuard,
};
use super::event_mapper::CodexEventMapper;
use super::protocol::{
    AccountLoginCompletedNotification, AccountUpdatedNotification, InitializeParams,
};
use super::rpc::{RpcClient, RpcId, RpcInbound};
use super::sanitize_install_output;
use crate::runtime::events::{RuntimeEvent, RuntimeEventEnvelope, RuntimeRequest};
use crate::runtime::process::{
    CodexTurnBinding, CodexTurnReservation, CodexTurnStart, RuntimeProcessError,
    RuntimeProcessState, TurnRoute,
};
use crate::runtime::{AgentRunState, RuntimeKind};
use serde_json::Value;
use std::collections::{BTreeMap, VecDeque};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tauri::{Emitter, Manager};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, watch, Mutex};
use tokio::task::JoinHandle;

const STDERR_LIMIT: usize = 64 * 1024;
const DEFAULT_STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const READER_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);
const PROCESS_REAP_TIMEOUT: Duration = Duration::from_secs(2);
const WARNING_EVENT: &str = "runtime-warning";
const ACCOUNT_UPDATED_EVENT: &str = "runtime-account-updated";
const RUNTIME_EVENT: &str = "runtime-event";
const WARNING_METHOD_LIMIT: usize = 256;
const INBOUND_QUEUE_CAPACITY: usize = 32;
const EARLY_LOGIN_COMPLETION_LIMIT: usize = 8;
const APPROVAL_UI_TIMEOUT: Duration = Duration::from_secs(10 * 60);

type DynReader = Box<dyn AsyncRead + Unpin + Send>;
type DynWriter = Box<dyn AsyncWrite + Unpin + Send>;
type ServerFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone)]
struct ProcessExit {
    success: bool,
    description: String,
}

impl ProcessExit {
    fn successful(description: impl Into<String>) -> Self {
        Self {
            success: true,
            description: description.into(),
        }
    }

    fn failed(description: impl Into<String>) -> Self {
        Self {
            success: false,
            description: description.into(),
        }
    }
}

trait AppServerProcess: Send {
    fn take_stdin(&mut self) -> Option<DynWriter>;
    fn take_stdout(&mut self) -> Option<DynReader>;
    fn take_stderr(&mut self) -> Option<DynReader>;
    fn wait(&mut self) -> ServerFuture<'_, Result<ProcessExit, String>>;
    fn terminate(&mut self) -> ServerFuture<'_, Result<(), String>>;
}

trait AppServerSpawner: Send + Sync {
    fn spawn(&self) -> ServerFuture<'_, Result<Box<dyn AppServerProcess>, String>>;
}

struct ProcessSpawner {
    executable: PathBuf,
}

impl ProcessSpawner {
    fn new(executable: PathBuf) -> Self {
        Self { executable }
    }
}

impl AppServerSpawner for ProcessSpawner {
    fn spawn(&self) -> ServerFuture<'_, Result<Box<dyn AppServerProcess>, String>> {
        Box::pin(async move {
            let mut command = Command::new(&self.executable);
            command
                .args(["app-server", "--listen", "stdio://"])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            isolate_process_tree(&mut command);

            let mut child = command
                .spawn()
                .map_err(|error| format!("Failed to start Codex app-server: {error}"))?;
            let process_tree = match attach_process_tree(&child) {
                Ok(process_tree) => process_tree,
                Err(error) => {
                    let cleanup = terminate_process_tree(&mut child, None, PROCESS_REAP_TIMEOUT)
                        .await
                        .err();
                    return Err(match cleanup {
                        Some(cleanup) => format!(
                            "Failed to isolate Codex app-server process tree: {error}; {cleanup}"
                        ),
                        None => {
                            format!("Failed to isolate Codex app-server process tree: {error}")
                        }
                    });
                }
            };
            let stdin = child
                .stdin
                .take()
                .map(|stream| Box::new(stream) as DynWriter);
            let stdout = child
                .stdout
                .take()
                .map(|stream| Box::new(stream) as DynReader);
            let stderr = child
                .stderr
                .take()
                .map(|stream| Box::new(stream) as DynReader);
            Ok(Box::new(TokioAppServerProcess {
                child,
                process_tree: Some(process_tree),
                stdin,
                stdout,
                stderr,
            }) as Box<dyn AppServerProcess>)
        })
    }
}

struct TokioAppServerProcess {
    child: Child,
    process_tree: Option<ProcessTreeGuard>,
    stdin: Option<DynWriter>,
    stdout: Option<DynReader>,
    stderr: Option<DynReader>,
}

fn process_termination_decision(
    inspection: std::io::Result<Option<ExitStatus>>,
) -> (bool, Option<String>) {
    match inspection {
        Ok(Some(_)) => (false, None),
        Ok(None) => (true, None),
        Err(error) => (
            true,
            Some(format!("Failed to inspect Codex app-server: {error}")),
        ),
    }
}

fn cleanup_after_confirmed_exit<T, F>(resource: Option<T>, cleanup: F) -> Result<(), String>
where
    F: FnOnce(T) -> Result<(), String>,
{
    match resource {
        Some(resource) => cleanup(resource),
        None => Ok(()),
    }
}

impl AppServerProcess for TokioAppServerProcess {
    fn take_stdin(&mut self) -> Option<DynWriter> {
        self.stdin.take()
    }

    fn take_stdout(&mut self) -> Option<DynReader> {
        self.stdout.take()
    }

    fn take_stderr(&mut self) -> Option<DynReader> {
        self.stderr.take()
    }

    fn wait(&mut self) -> ServerFuture<'_, Result<ProcessExit, String>> {
        Box::pin(async move {
            let status = self
                .child
                .wait()
                .await
                .map_err(|error| format!("Failed to wait for Codex app-server: {error}"))?;
            cleanup_after_confirmed_exit(self.process_tree.take(), |process_tree| {
                process_tree.cleanup_after_parent_exit()
            })
            .map_err(|error| {
                format!("Codex app-server exited but descendant cleanup failed: {error}")
            })?;
            let description = status.to_string();
            Ok(if status.success() {
                ProcessExit::successful(description)
            } else {
                ProcessExit::failed(description)
            })
        })
    }

    fn terminate(&mut self) -> ServerFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let (needs_termination, inspection_error) =
                process_termination_decision(self.child.try_wait());
            if !needs_termination {
                return cleanup_after_confirmed_exit(self.process_tree.take(), |process_tree| {
                    process_tree.cleanup_after_parent_exit()
                })
                .map_err(|error| format!("Failed to stop Codex app-server descendants: {error}"));
            }
            let termination = terminate_process_tree(
                &mut self.child,
                self.process_tree.take(),
                PROCESS_REAP_TIMEOUT,
            )
            .await
            .map_err(|error| format!("Failed to stop Codex app-server: {error}"));
            match (inspection_error, termination) {
                (None, result) => result,
                (Some(error), Ok(())) => Err(error),
                (Some(inspection), Err(termination)) => Err(format!("{inspection}; {termination}")),
            }
        })
    }
}

#[derive(Default)]
struct RecentDiagnostics {
    bytes: Vec<u8>,
    truncated: bool,
}

impl RecentDiagnostics {
    fn append(&mut self, bytes: &[u8]) {
        if bytes.len() >= STDERR_LIMIT {
            self.truncated |= !self.bytes.is_empty() || bytes.len() > STDERR_LIMIT;
            self.bytes.clear();
            self.bytes
                .extend_from_slice(&bytes[bytes.len() - STDERR_LIMIT..]);
            return;
        }
        let overflow = self
            .bytes
            .len()
            .saturating_add(bytes.len())
            .saturating_sub(STDERR_LIMIT);
        if overflow > 0 {
            self.truncated = true;
            self.bytes.drain(..overflow);
        }
        self.bytes.extend_from_slice(bytes);
    }

    fn snapshot(&self) -> String {
        let decoded = String::from_utf8_lossy(&self.bytes);
        let complete_lines = if self.truncated {
            decoded
                .find(['\r', '\n'])
                .map(|boundary| decoded[boundary + 1..].trim_start_matches(['\r', '\n']))
                .unwrap_or_default()
        } else {
            &decoded
        };
        let sanitized = sanitize_install_output(complete_lines);
        trim_to_last_bytes(sanitized, STDERR_LIMIT)
    }
}

fn trim_to_last_bytes(value: String, limit: usize) -> String {
    if value.len() <= limit {
        return value;
    }
    let mut start = value.len() - limit;
    while !value.is_char_boundary(start) {
        start += 1;
    }
    value[start..].to_owned()
}

fn safe_warning_method(method: &str) -> String {
    let sanitized = sanitize_install_output(method);
    let single_line = sanitized
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    if single_line.len() <= WARNING_METHOD_LIMIT {
        return single_line;
    }
    let mut end = WARNING_METHOD_LIMIT;
    while !single_line.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &single_line[..end])
}

fn build_runtime_request(
    id: &RpcId,
    method: &str,
    params: &Value,
    thread_id: Option<String>,
    turn_id: Option<String>,
    tab_id: &str,
) -> RuntimeRequest {
    let title = params
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or(method)
        .to_owned();
    let questions = params
        .get("questions")
        .and_then(Value::as_array)
        .map(|questions| {
            questions
                .iter()
                .filter_map(|question| {
                    let id = question.get("id").and_then(Value::as_str)?;
                    let prompt = question
                        .get("prompt")
                        .or_else(|| question.get("question"))
                        .and_then(Value::as_str)?;
                    let options = question
                        .get("options")
                        .and_then(Value::as_array)
                        .map(|options| {
                            options
                                .iter()
                                .filter_map(Value::as_str)
                                .map(str::to_owned)
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    Some(crate::runtime::events::RuntimeRequestQuestion {
                        id: id.to_owned(),
                        prompt: prompt.to_owned(),
                        options,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    RuntimeRequest {
        request_id: serde_json::to_value(id).unwrap_or(Value::Null),
        method: method.to_owned(),
        runtime: RuntimeKind::Codex,
        thread_id,
        turn_id,
        tab_id: tab_id.to_owned(),
        agent_run_id: params
            .get("agentId")
            .or_else(|| params.get("agentRunId"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        title: sanitize_install_output(&title),
        command: params
            .get("command")
            .and_then(Value::as_str)
            .map(sanitize_install_output),
        cwd: params
            .get("cwd")
            .and_then(Value::as_str)
            .map(sanitize_install_output),
        diff: params
            .get("diff")
            .and_then(Value::as_str)
            .map(sanitize_install_output),
        permissions: params
            .get("permissions")
            .or_else(|| params.get("requestedPermissions"))
            .cloned(),
        questions,
        details: redact_request_details(params),
    }
}

#[derive(Debug)]
struct NotificationScope {
    thread_id: String,
    turn_id: Option<String>,
}

fn notification_scope(method: &str, params: &Value) -> Result<Option<NotificationScope>, String> {
    let string = |field: &str| params.get(field).and_then(Value::as_str);
    let nested = |first: &str, second: &str| {
        params
            .get(first)
            .and_then(|value| value.get(second))
            .and_then(Value::as_str)
    };
    let malformed = || {
        format!(
            "Malformed Codex `{}` notification",
            safe_warning_method(method)
        )
    };

    let scope = match method {
        "thread/started" => NotificationScope {
            thread_id: nested("thread", "id").ok_or_else(malformed)?.to_owned(),
            turn_id: None,
        },
        "turn/started" | "turn/completed" => NotificationScope {
            thread_id: string("threadId").ok_or_else(malformed)?.to_owned(),
            turn_id: Some(nested("turn", "id").ok_or_else(malformed)?.to_owned()),
        },
        "item/agentMessage/delta"
        | "item/reasoning/summaryTextDelta"
        | "item/reasoning/textDelta"
        | "item/completed"
        | "error" => NotificationScope {
            thread_id: string("threadId").ok_or_else(malformed)?.to_owned(),
            turn_id: Some(string("turnId").ok_or_else(malformed)?.to_owned()),
        },
        "account/login/completed" | "account/updated" => return Ok(None),
        _ => {
            let Some(thread_id) = string("threadId").or_else(|| nested("thread", "id")) else {
                return Ok(None);
            };
            NotificationScope {
                thread_id: thread_id.to_owned(),
                turn_id: string("turnId")
                    .or_else(|| nested("turn", "id"))
                    .map(str::to_owned),
            }
        }
    };
    Ok(Some(scope))
}

fn notification_is_terminal(method: &str, params: &Value) -> bool {
    match method {
        "turn/completed" => params
            .pointer("/turn/status")
            .and_then(Value::as_str)
            .is_none_or(|status| status != "inProgress"),
        "error" => params.get("willRetry").and_then(Value::as_bool) == Some(false),
        _ => false,
    }
}

async fn route_lifecycle_notification(
    routes: &RuntimeProcessState,
    mapper: &Mutex<CodexEventMapper>,
    generation: u64,
    method: &str,
    params: &Value,
    mut emit: impl FnMut(RuntimeEventEnvelope),
) -> Result<usize, String> {
    let scope = match notification_scope(method, params) {
        Ok(scope) => scope,
        Err(error) if method == "turn/completed" => {
            let mut mapper = mapper.lock().await;
            if routes.transport_generation().await != generation {
                return Ok(0);
            }
            let advance = routes.advance_transport_generation().await;
            for route in &advance.in_flight_turns {
                if let Some(event) =
                    mapper.map_transport_failure(advance.previous_generation, route, &error)
                {
                    emit(event);
                }
                routes.settle_codex_cancel(route, Ok(())).await;
            }
            mapper.set_generation(advance.generation);
            return Err(error);
        }
        Err(error) => return Err(error),
    };
    let Some(scope) = scope else {
        return Ok(0);
    };

    // The mapper lock is the lifecycle ordering gate shared by the reader and
    // response-side synthetic notifications. Process-state mutations happen
    // while this gate is held so sequence assignment cannot overtake binding.
    let mut mapper = mapper.lock().await;
    if routes.transport_generation().await != generation {
        return Ok(0);
    }

    let notification_routes = if method == "turn/started" {
        let Some(turn_id) = scope.turn_id.as_deref() else {
            return Err("Malformed Codex `turn/started` notification".into());
        };
        match routes
            .bind_pending_codex_turn(&scope.thread_id, turn_id, generation)
            .await
        {
            Ok(CodexTurnBinding::Active(route)) | Ok(CodexTurnBinding::AlreadyFinished(route)) => {
                vec![route]
            }
            Err(RuntimeProcessError::StaleTransportGeneration { .. }) => return Ok(0),
            Err(_) => {
                return Err(
                    "Codex turn/started could not be correlated with a pending route".into(),
                )
            }
        }
    } else {
        routes
            .codex_notification_routes(&scope.thread_id, scope.turn_id.as_deref(), generation)
            .await
    };

    let mut events = Vec::new();
    for route in notification_routes {
        events.extend(mapper.map_notification(generation, &route, method, params));
    }
    if notification_is_terminal(method, params) {
        if let Some(turn_id) = scope.turn_id.as_deref() {
            routes
                .finish_codex_turn(&scope.thread_id, turn_id, generation)
                .await;
        }
    }
    let event_count = events.len();
    for event in events {
        // Delivery is part of the lifecycle ordering gate: a route identity
        // cannot change after sequence assignment but before the event emit.
        emit(event);
    }
    Ok(event_count)
}

#[derive(Debug, Default)]
struct CodexLifecycleReset {
    generation: u64,
    subscriptions: Vec<TurnRoute>,
}

async fn reset_codex_lifecycle(
    routes: &RuntimeProcessState,
    mapper: &Mutex<CodexEventMapper>,
    message: &str,
    mut emit: impl FnMut(RuntimeEventEnvelope),
) -> CodexLifecycleReset {
    let mut mapper = mapper.lock().await;
    let advance = routes.advance_transport_generation().await;
    for route in &advance.in_flight_turns {
        if let Some(event) =
            mapper.map_transport_failure(advance.previous_generation, route, message)
        {
            // The registry generation is already sealed, but the mapper gate
            // keeps failure delivery ordered before reconnect notifications.
            emit(event);
        }
        routes.settle_codex_cancel(route, Ok(())).await;
    }
    mapper.set_generation(advance.generation);
    CodexLifecycleReset {
        generation: advance.generation,
        subscriptions: advance.subscriptions,
    }
}

async fn resume_codex_subscriptions_with<F, Fut>(
    routes: &RuntimeProcessState,
    reset: &CodexLifecycleReset,
    mut request: F,
) -> Vec<String>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    let mut by_thread = BTreeMap::<String, Vec<&TurnRoute>>::new();
    for route in &reset.subscriptions {
        if route.runtime != RuntimeKind::Codex {
            continue;
        }
        if let Some(thread_id) = route.session_id.as_ref() {
            by_thread.entry(thread_id.clone()).or_default().push(route);
        }
    }

    let mut warnings = Vec::new();
    for (thread_id, thread_routes) in by_thread {
        if let Err(error) = request(thread_id.clone()).await {
            warnings.push(format!(
                "Failed to resume a Codex thread after restart: {}",
                safe_warning_method(&error)
            ));
            continue;
        }
        for route in thread_routes {
            if routes
                .rebind_codex_subscription(
                    &route.window_label,
                    &route.tab_id,
                    &thread_id,
                    reset.generation,
                )
                .await
                .is_err()
            {
                warnings.push(
                    "A Codex thread resumed, but one closed or stale tab was not rebound"
                        .to_string(),
                );
            }
        }
    }
    warnings
}

fn validate_thread_resume_response(
    expected_thread_id: &str,
    response: &Value,
) -> Result<(), String> {
    match response.pointer("/thread/id").and_then(Value::as_str) {
        Some(thread_id) if thread_id == expected_thread_id => Ok(()),
        _ => Err("Invalid Codex thread/resume response".into()),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum NotificationHandling {
    Continue,
    Poison(String),
}

trait WarningSink: Send + Sync {
    fn emit(&self, message: String);

    fn connection_generation(&self) -> ServerFuture<'_, u64> {
        Box::pin(async { 0 })
    }

    fn handle_notification(
        &self,
        _client: Arc<RpcClient>,
        _connection_generation: u64,
        _method: String,
        _params: Value,
    ) -> ServerFuture<'_, NotificationHandling> {
        Box::pin(async { NotificationHandling::Continue })
    }

    fn handle_server_request(
        &self,
        client: Arc<RpcClient>,
        id: RpcId,
        method: String,
        params: Value,
    ) -> ServerFuture<'_, ()> {
        Box::pin(async move {
            if is_codex_approval_request(&method) {
                let response = auto_accept_response(&method, &params);
                if let Err(error) = client.respond(id, response).await {
                    self.emit(format!(
                        "Failed to accept Codex approval request safely: {error}"
                    ));
                }
                return;
            }
            let safe_method = safe_warning_method(&method);
            if let Err(error) = client.respond_error(id, -32601, "Method not found").await {
                self.emit(format!(
                    "Unsupported Codex server request `{safe_method}` could not be answered: {error}"
                ));
            } else {
                self.emit(format!(
                    "Unsupported Codex server request `{safe_method}` was rejected. Update Codex or LocalPrism if this request is required."
                ));
            }
        })
    }

    fn transport_reset(&self, _message: String) -> ServerFuture<'_, CodexLifecycleReset> {
        Box::pin(async { CodexLifecycleReset::default() })
    }

    fn transport_reconnected(
        &self,
        _client: Arc<RpcClient>,
        _reset: CodexLifecycleReset,
    ) -> ServerFuture<'_, ()> {
        Box::pin(async {})
    }
}

#[derive(Clone)]
struct TauriWarningSink {
    app: tauri::AppHandle,
    account_events: Arc<AccountEventState>,
    mapper: Arc<Mutex<CodexEventMapper>>,
    codex_version: Option<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeWarningPayload {
    runtime: RuntimeKind,
    message: String,
}

fn emit_runtime_event(app: &tauri::AppHandle, event: RuntimeEventEnvelope) {
    // Global emit keeps long-running Codex turns (gpt-5.6 reconnect storms)
    // visible even if the webview label used for emit_to does not match.
    if let RuntimeEvent::SubagentDiscovered { run }
    | RuntimeEvent::SubagentStatusChanged { run } = &event.event
    {
        let agent_runs = app.state::<AgentRunState>();
        let run = run.clone();
        tauri::async_runtime::spawn(async move {
            let _ = agent_runs.apply(run).await;
        });
    }
    let _ = app.emit(RUNTIME_EVENT, &event);
}

impl TauriWarningSink {
    fn emit_runtime_event(&self, event: RuntimeEventEnvelope) {
        emit_runtime_event(&self.app, event);
    }
}

#[derive(Debug, PartialEq, Eq)]
enum AccountNotificationAction {
    Ignore,
    Refresh {
        warning: Option<String>,
        sequence: u64,
    },
}

fn classify_account_notification(
    account_events: &AccountEventState,
    method: &str,
    params: Value,
) -> Result<AccountNotificationAction, String> {
    match method {
        "account/login/completed" => {
            let notification: AccountLoginCompletedNotification = serde_json::from_value(params)
                .map_err(|_| {
                    "Malformed Codex `account/login/completed` notification".to_string()
                })?;
            let mut tracking = account_events
                .login_tracking
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());

            let matches_active = match notification.login_id.as_deref() {
                Some(login_id) => tracking.active_login_id.as_deref() == Some(login_id),
                None => tracking.active_login_id.is_some(),
            };
            if matches_active {
                tracking.active_login_id.take();
                let sequence = account_events.reserve_refresh_locked();
                drop(tracking);
                return Ok(AccountNotificationAction::Refresh {
                    warning: login_completion_warning(&notification),
                    sequence,
                });
            }

            if tracking.pending_attempt.is_some() {
                if tracking.early_completions.len() == EARLY_LOGIN_COMPLETION_LIMIT {
                    tracking.early_completions.pop_front();
                }
                tracking.early_completions.push_back(notification);
            }
            Ok(AccountNotificationAction::Ignore)
        }
        "account/updated" => {
            let _notification: AccountUpdatedNotification = serde_json::from_value(params)
                .map_err(|_| "Malformed Codex `account/updated` notification".to_string())?;
            let sequence = account_events.reserve_refresh();
            Ok(AccountNotificationAction::Refresh {
                warning: None,
                sequence,
            })
        }
        _ => Ok(AccountNotificationAction::Ignore),
    }
}

fn login_completion_warning(notification: &AccountLoginCompletedNotification) -> Option<String> {
    if notification.success {
        return None;
    }
    Some(match notification.error.as_deref() {
        Some(error) if !error.is_empty() => {
            format!("Codex login failed: {}", safe_warning_method(error))
        }
        _ => "Codex login failed".to_string(),
    })
}

impl WarningSink for TauriWarningSink {
    fn emit(&self, message: String) {
        let _ = self.app.emit(
            WARNING_EVENT,
            RuntimeWarningPayload {
                runtime: RuntimeKind::Codex,
                message,
            },
        );
    }

    fn connection_generation(&self) -> ServerFuture<'_, u64> {
        Box::pin(async move {
            self.app
                .state::<RuntimeProcessState>()
                .transport_generation()
                .await
        })
    }

    fn handle_server_request(
        &self,
        client: Arc<RpcClient>,
        id: RpcId,
        method: String,
        params: Value,
    ) -> ServerFuture<'_, ()> {
        let app = self.app.clone();
        Box::pin(async move {
            if !is_codex_approval_request(&method) {
                let safe_method = safe_warning_method(&method);
                if let Err(error) = client.respond_error(id, -32601, "Method not found").await {
                    let _ = app.emit(
                        WARNING_EVENT,
                        RuntimeWarningPayload {
                            runtime: RuntimeKind::Codex,
                            message: format!(
                                "Unsupported Codex server request `{safe_method}` could not be answered: {error}"
                            ),
                        },
                    );
                } else {
                    let _ = app.emit(
                        WARNING_EVENT,
                        RuntimeWarningPayload {
                            runtime: RuntimeKind::Codex,
                            message: format!(
                                "Unsupported Codex server request `{safe_method}` was rejected. Update Codex or LocalPrism if this request is required."
                            ),
                        },
                    );
                }
                return;
            }

            let approvals = app.state::<ApprovalState>();
            if !approvals.is_ui_ready() {
                let response = auto_accept_response(&method, &params);
                if let Err(error) = client.respond(id, response).await {
                    let _ = app.emit(
                        WARNING_EVENT,
                        RuntimeWarningPayload {
                            runtime: RuntimeKind::Codex,
                            message: format!(
                                "Failed to accept Codex approval request safely: {error}"
                            ),
                        },
                    );
                }
                return;
            }

            let routes = app.state::<RuntimeProcessState>();
            let snapshot = routes.snapshot().await;
            let thread_id = params
                .get("threadId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let turn_id = params
                .get("turnId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let route = thread_id.as_deref().and_then(|thread| {
                snapshot
                    .routes
                    .iter()
                    .find(|route| {
                        route.runtime == RuntimeKind::Codex
                            && route.session_id.as_deref() == Some(thread)
                    })
                    .cloned()
            });
            let (window_label, tab_id, attempt_id, sequence) = if let Some(route) = route.as_ref() {
                (
                    route.window_label.clone(),
                    route.tab_id.clone(),
                    route.attempt_id.clone(),
                    0,
                )
            } else {
                ("main".into(), String::new(), String::new(), 0)
            };

            let (tx, rx) = oneshot::channel();
            let pending = PendingRuntimeRequest {
                id: id.clone(),
                method: method.clone(),
                window_label: window_label.clone(),
                tab_id: tab_id.clone(),
                thread_id: thread_id.clone(),
                turn_id: turn_id.clone(),
                created_at: std::time::Instant::now(),
                payload: params.clone(),
                responder: Some(tx),
            };
            if let Err(error) = approvals.register(pending).await {
                let _ = app.emit(
                    WARNING_EVENT,
                    RuntimeWarningPayload {
                        runtime: RuntimeKind::Codex,
                        message: error,
                    },
                );
                let response = auto_accept_response(&method, &params);
                let _ = client.respond(id, response).await;
                return;
            }

            let request = build_runtime_request(
                &id,
                &method,
                &params,
                thread_id.clone(),
                turn_id.clone(),
                &tab_id,
            );
            let event_type = if method == "item/tool/requestUserInput" {
                RuntimeEvent::UserInputRequested { request }
            } else {
                RuntimeEvent::ApprovalRequested { request }
            };
            emit_runtime_event(
                &app,
                RuntimeEventEnvelope {
                    runtime: RuntimeKind::Codex,
                    window_label,
                    tab_id,
                    attempt_id,
                    session_id: thread_id,
                    turn_id,
                    sequence,
                    event: event_type,
                },
            );

            // Do not block the inbound reader on UI decisions.
            tokio::spawn(async move {
                let decision = tokio::select! {
                    result = rx => result.ok(),
                    _ = tokio::time::sleep(APPROVAL_UI_TIMEOUT) => None,
                };
                let _ = approvals.take(&id).await;
                let response = match decision {
                    Some(resolve) => match map_decision_to_response(
                        &method,
                        &params,
                        &resolve.decision,
                        resolve.persistence.as_deref(),
                        &resolve.answers,
                    ) {
                        Ok(value) => value,
                        Err((code, message)) => {
                            let _ = client.respond_error(id, code, &message).await;
                            return;
                        }
                    },
                    None => auto_accept_response(&method, &params),
                };
                if let Err(error) = client.respond(id, response).await {
                    let _ = app.emit(
                        WARNING_EVENT,
                        RuntimeWarningPayload {
                            runtime: RuntimeKind::Codex,
                            message: format!(
                                "Failed to respond to Codex approval request: {error}"
                            ),
                        },
                    );
                }
            });
        })
    }

    fn handle_notification(
        &self,
        client: Arc<RpcClient>,
        connection_generation: u64,
        method: String,
        params: Value,
    ) -> ServerFuture<'_, NotificationHandling> {
        Box::pin(async move {
            let routes = self.app.state::<RuntimeProcessState>();
            if let Err(error) = route_lifecycle_notification(
                &routes,
                &self.mapper,
                connection_generation,
                &method,
                &params,
                |event| self.emit_runtime_event(event),
            )
            .await
            {
                self.emit(safe_warning_method(&error));
                return NotificationHandling::Poison(error);
            }

            let action = match classify_account_notification(&self.account_events, &method, params)
            {
                Ok(action) => action,
                Err(error) => {
                    self.emit(error);
                    return NotificationHandling::Continue;
                }
            };
            let AccountNotificationAction::Refresh { warning, sequence } = action else {
                return NotificationHandling::Continue;
            };
            let account_error = warning;

            // Account refresh RPCs are independent of lifecycle ordering. The
            // reader continues to service responses and lifecycle frames while
            // this refresh is in flight.
            let sink = self.clone();
            tokio::spawn(async move {
                let _refresh_guard = sink.account_events.refresh.lock().await;
                {
                    let _tracking = sink
                        .account_events
                        .login_tracking
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    if sink.account_events.sequence.load(Ordering::Acquire) != sequence {
                        return;
                    }
                    if let Some(warning) = account_error.as_ref() {
                        sink.emit(warning.clone());
                    }
                }
                let account = match super::read_account_with_request(
                    true,
                    sink.codex_version.clone(),
                    |method, params| {
                        let client = client.clone();
                        async move {
                            client
                                .request(method, params, DEFAULT_REQUEST_TIMEOUT)
                                .await
                        }
                    },
                )
                .await
                {
                    Ok(account) => account,
                    Err(error) => {
                        let _tracking = sink
                            .account_events
                            .login_tracking
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        if sink.account_events.sequence.load(Ordering::Acquire) == sequence {
                            sink.emit(format!(
                                "Failed to refresh Codex account: {}",
                                safe_warning_method(&error)
                            ));
                        }
                        return;
                    }
                };
                let _tracking = sink
                    .account_events
                    .login_tracking
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if sink.account_events.sequence.load(Ordering::Acquire) != sequence {
                    return;
                }
                let mut account = account;
                account.error = account_error;
                let _ = sink.app.emit(ACCOUNT_UPDATED_EVENT, account);
            });
            NotificationHandling::Continue
        })
    }

    fn transport_reset(&self, message: String) -> ServerFuture<'_, CodexLifecycleReset> {
        Box::pin(async move {
            self.account_events.reset_transport();
            let routes = self.app.state::<RuntimeProcessState>();
            reset_codex_lifecycle(&routes, &self.mapper, &message, |event| {
                self.emit_runtime_event(event)
            })
            .await
        })
    }

    fn transport_reconnected(
        &self,
        client: Arc<RpcClient>,
        reset: CodexLifecycleReset,
    ) -> ServerFuture<'_, ()> {
        Box::pin(async move {
            let routes = self.app.state::<RuntimeProcessState>();
            let warnings = resume_codex_subscriptions_with(&routes, &reset, |thread_id| {
                let client = client.clone();
                async move {
                    let expected_thread_id = thread_id.clone();
                    let response = client
                        .request(
                            "thread/resume",
                            serde_json::json!({"threadId": thread_id}),
                            DEFAULT_REQUEST_TIMEOUT,
                        )
                        .await?;
                    validate_thread_resume_response(&expected_thread_id, &response)
                }
            })
            .await;
            for warning in warnings {
                self.emit(warning);
            }
        })
    }
}

async fn handle_inbound(
    client: Arc<RpcClient>,
    mut inbound: mpsc::Receiver<RpcInbound>,
    warnings: Arc<dyn WarningSink>,
    connection_generation: u64,
) {
    while let Some(message) = inbound.recv().await {
        match message {
            RpcInbound::Notification { method, params } => {
                if let NotificationHandling::Poison(error) = warnings
                    .handle_notification(client.clone(), connection_generation, method, params)
                    .await
                {
                    client.poison_transport(&error).await;
                    return;
                }
            }
            RpcInbound::ServerRequest { id, method, params } => {
                warnings
                    .handle_server_request(client.clone(), id, method, params)
                    .await;
            }
            RpcInbound::Malformed { error, .. } => {
                warnings.emit(format!(
                    "Codex app-server emitted malformed JSON and the frame was ignored: {error}"
                ));
            }
        }
    }
}

struct RunningServer {
    process: Box<dyn AppServerProcess>,
    client: Arc<RpcClient>,
    transport_failure: watch::Receiver<Option<String>>,
    stdout_closed: oneshot::Receiver<String>,
    stdout_task: JoinHandle<Result<(), String>>,
    stderr_task: JoinHandle<()>,
    inbound_task: JoinHandle<()>,
}

impl RunningServer {
    async fn finish_after_exit(self, message: &str) {
        self.client.terminate(message).await;
        finish_task(self.stdout_task).await;
        finish_task(self.stderr_task).await;
        finish_task(self.inbound_task).await;
    }

    async fn finish_after_transport_failure(mut self, message: &str) -> String {
        let cleanup = self.process.terminate().await.err();
        self.client.terminate(message).await;
        finish_task(self.stdout_task).await;
        finish_task(self.stderr_task).await;
        finish_task(self.inbound_task).await;
        match cleanup {
            Some(cleanup) => format!("{message}; process cleanup failed: {cleanup}"),
            None => message.to_owned(),
        }
    }

    async fn shutdown(mut self) -> Result<(), String> {
        let result = self.process.terminate().await;
        self.client
            .terminate("Codex app-server is shutting down")
            .await;
        finish_task(self.stdout_task).await;
        finish_task(self.stderr_task).await;
        finish_task(self.inbound_task).await;
        result
    }
}

async fn finish_task<T>(mut task: JoinHandle<T>) {
    if tokio::time::timeout(READER_DRAIN_TIMEOUT, &mut task)
        .await
        .is_err()
    {
        task.abort();
    }
}

async fn launch_running_server(
    spawner: &dyn AppServerSpawner,
    version: &str,
    warnings: Arc<dyn WarningSink>,
    diagnostics: Arc<StdMutex<RecentDiagnostics>>,
    startup_timeout: Duration,
) -> Result<RunningServer, String> {
    let startup_deadline = tokio::time::Instant::now() + startup_timeout;
    let mut process = tokio::time::timeout_at(startup_deadline, spawner.spawn())
        .await
        .map_err(|_| "Codex app-server process startup timed out".to_string())??;
    let stdin = process
        .take_stdin()
        .ok_or_else(|| "Codex app-server did not provide the required stdin pipe".to_string())?;
    let stdout = process
        .take_stdout()
        .ok_or_else(|| "Codex app-server did not provide the required stdout pipe".to_string())?;
    let mut stderr = process
        .take_stderr()
        .ok_or_else(|| "Codex app-server did not provide the required stderr pipe".to_string())?;

    let connection_generation = warnings.connection_generation().await;
    let client = Arc::new(RpcClient::new(stdin));
    let transport_failure = client.subscribe_transport_failures();
    let (inbound_tx, inbound_rx) = mpsc::channel(INBOUND_QUEUE_CAPACITY);
    let (stdout_closed_tx, stdout_closed) = oneshot::channel();
    let stdout_client = client.clone();
    let stdout_task = tokio::spawn(async move {
        let result = stdout_client.read_loop(stdout, inbound_tx).await;
        let message = match &result {
            Ok(()) => "Codex app-server stdout closed while the process was running".to_string(),
            Err(error) => error.clone(),
        };
        let _ = stdout_closed_tx.send(message);
        result
    });
    let stderr_task = tokio::spawn(async move {
        let mut chunk = [0_u8; 4096];
        loop {
            match stderr.read(&mut chunk).await {
                Ok(0) | Err(_) => return,
                Ok(read) => diagnostics
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .append(&chunk[..read]),
            }
        }
    });
    let inbound_task = tokio::spawn(handle_inbound(
        client.clone(),
        inbound_rx,
        warnings,
        connection_generation,
    ));

    let params = serde_json::to_value(InitializeParams::new(version))
        .map_err(|error| format!("Failed to build Codex initialize request: {error}"))?;
    let initialize_timeout =
        startup_deadline.saturating_duration_since(tokio::time::Instant::now());
    if let Err(error) = client
        .request("initialize", params, initialize_timeout)
        .await
    {
        let _ = process.terminate().await;
        client.terminate("Codex app-server initialize failed").await;
        stdout_task.abort();
        stderr_task.abort();
        inbound_task.abort();
        return Err(format!("Codex app-server initialize failed: {error}"));
    }
    let notification = match tokio::time::timeout_at(
        startup_deadline,
        client.notify("initialized", serde_json::json!({})),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err("Codex app-server initialized notification timed out".to_string()),
    };
    if let Err(error) = notification {
        let _ = process.terminate().await;
        client
            .terminate("Codex app-server initialized notification failed")
            .await;
        stdout_task.abort();
        stderr_task.abort();
        inbound_task.abort();
        return Err(format!(
            "Codex app-server initialized notification failed: {error}"
        ));
    }

    Ok(RunningServer {
        process,
        client,
        transport_failure,
        stdout_closed,
        stdout_task,
        stderr_task,
        inbound_task,
    })
}

async fn receive_transport_failure(failures: &mut watch::Receiver<Option<String>>) -> String {
    match failures.changed().await {
        Ok(()) => failures.borrow().clone().unwrap_or_else(|| {
            "Codex app-server stdin transport failed without a diagnostic".to_string()
        }),
        Err(_) => "Codex app-server stdin transport monitor stopped unexpectedly".to_string(),
    }
}

enum SupervisorCommand {
    Request {
        method: String,
        params: Value,
        reply: oneshot::Sender<Result<Value, String>>,
    },
}

#[derive(Clone)]
struct SupervisorHandle {
    requests: mpsc::Sender<SupervisorCommand>,
    shutdowns: mpsc::Sender<oneshot::Sender<Result<(), String>>>,
    terminal_error: Arc<StdMutex<Option<String>>>,
    diagnostics: Arc<StdMutex<RecentDiagnostics>>,
}

impl SupervisorHandle {
    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        if let Some(error) = self.terminal_error() {
            return Err(error);
        }
        let (reply, response) = oneshot::channel();
        if self
            .requests
            .send(SupervisorCommand::Request {
                method: method.to_owned(),
                params,
                reply,
            })
            .await
            .is_err()
        {
            return Err(self.unavailable_error());
        }
        response
            .await
            .unwrap_or_else(|_| Err(self.unavailable_error()))
    }

    fn terminal_error(&self) -> Option<String> {
        self.terminal_error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn unavailable_error(&self) -> String {
        self.terminal_error().unwrap_or_else(|| {
            with_diagnostics(
                "Codex app-server supervisor is unavailable",
                &self.diagnostics,
            )
        })
    }
}

struct CodexAppServer {
    handle: SupervisorHandle,
    task: Option<JoinHandle<()>>,
}

impl CodexAppServer {
    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.handle.request(method, params).await
    }

    async fn shutdown(mut self) -> Result<(), String> {
        let (reply, response) = oneshot::channel();
        let command_result = if self.handle.shutdowns.send(reply).await.is_ok() {
            response.await.unwrap_or(Ok(()))
        } else {
            Ok(())
        };
        if let Some(task) = self.task.take() {
            task.await
                .map_err(|error| format!("Codex app-server supervisor task failed: {error}"))?;
        }
        command_result
    }
}

async fn start_supervisor(
    spawner: Arc<dyn AppServerSpawner>,
    version: String,
    warnings: Arc<dyn WarningSink>,
    startup_timeout: Duration,
    request_timeout: Duration,
) -> Result<CodexAppServer, String> {
    let diagnostics = Arc::new(StdMutex::new(RecentDiagnostics::default()));
    let terminal_error = Arc::new(StdMutex::new(None));
    let (requests, request_receiver) = mpsc::channel(128);
    let (shutdowns, shutdown_receiver) = mpsc::channel(1);
    let (ready, readiness) = oneshot::channel();
    let task_diagnostics = diagnostics.clone();
    let task_terminal = terminal_error.clone();
    let task = tokio::spawn(run_supervisor(
        spawner,
        version,
        warnings,
        startup_timeout,
        request_timeout,
        request_receiver,
        shutdown_receiver,
        ready,
        task_diagnostics,
        task_terminal,
    ));

    match readiness.await {
        Ok(Ok(())) => Ok(CodexAppServer {
            handle: SupervisorHandle {
                requests,
                shutdowns,
                terminal_error,
                diagnostics,
            },
            task: Some(task),
        }),
        Ok(Err(error)) => {
            let _ = task.await;
            Err(error)
        }
        Err(_) => {
            let _ = task.await;
            Err("Codex app-server supervisor stopped during startup".into())
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_supervisor(
    spawner: Arc<dyn AppServerSpawner>,
    version: String,
    warnings: Arc<dyn WarningSink>,
    startup_timeout: Duration,
    request_timeout: Duration,
    mut requests: mpsc::Receiver<SupervisorCommand>,
    mut shutdowns: mpsc::Receiver<oneshot::Sender<Result<(), String>>>,
    ready: oneshot::Sender<Result<(), String>>,
    diagnostics: Arc<StdMutex<RecentDiagnostics>>,
    terminal_error: Arc<StdMutex<Option<String>>>,
) {
    let mut running = match launch_running_server(
        spawner.as_ref(),
        &version,
        warnings.clone(),
        diagnostics.clone(),
        startup_timeout,
    )
    .await
    {
        Ok(running) => running,
        Err(error) => {
            set_terminal_error(&terminal_error, error.clone());
            let _ = ready.send(Err(error));
            return;
        }
    };
    let _ = ready.send(Ok(()));
    let mut restart_used = false;

    loop {
        let failure = tokio::select! {
            biased;
            shutdown = shutdowns.recv() => {
                match shutdown {
                    Some(reply) => {
                        let result = running.shutdown().await;
                        let _ = reply.send(result);
                        return;
                    }
                    None => {
                        let _ = running.shutdown().await;
                        return;
                    }
                }
            }
            exit = running.process.wait() => {
                let exit_message = match exit {
                    Ok(exit) => format!(
                        "Codex app-server exited unexpectedly (success={}): {}",
                        exit.success,
                        exit.description
                    ),
                    Err(error) => format!("Codex app-server wait failed: {error}"),
                };
                running.finish_after_exit(&exit_message).await;
                exit_message
            }
            stdout = &mut running.stdout_closed => {
                let message = stdout.unwrap_or_else(|_| {
                    "Codex app-server stdout monitor stopped unexpectedly".to_string()
                });
                running.finish_after_transport_failure(&message).await
            }
            transport = receive_transport_failure(&mut running.transport_failure) => {
                running.finish_after_transport_failure(&transport).await
            }
            command = requests.recv() => {
                match command {
                    Some(SupervisorCommand::Request { method, params, reply }) => {
                        let client = running.client.clone();
                        tokio::spawn(async move {
                            let result = client.request(&method, params, request_timeout).await;
                            let _ = reply.send(result);
                        });
                        continue;
                    }
                    None => {
                        let _ = running.shutdown().await;
                        return;
                    }
                }
            }
        };

        let reset = warnings.transport_reset(failure.clone()).await;

        if restart_used {
            let fatal = with_diagnostics(
                &format!(
                    "Codex app-server exited twice; automatic restart is exhausted. {failure}"
                ),
                &diagnostics,
            );
            set_terminal_error(&terminal_error, fatal.clone());
            warnings.emit(fatal);
            return;
        }

        restart_used = true;
        warnings.emit(format!("{failure}. Restarting Codex app-server once."));
        match launch_running_server(
            spawner.as_ref(),
            &version,
            warnings.clone(),
            diagnostics.clone(),
            startup_timeout,
        )
        .await
        {
            Ok(restarted) => {
                warnings
                    .transport_reconnected(restarted.client.clone(), reset)
                    .await;
                running = restarted;
            }
            Err(error) => {
                let fatal = with_diagnostics(
                    &format!("Codex app-server automatic restart failed: {error}"),
                    &diagnostics,
                );
                set_terminal_error(&terminal_error, fatal.clone());
                warnings.emit(fatal);
                return;
            }
        }
    }
}

fn set_terminal_error(target: &StdMutex<Option<String>>, error: String) {
    *target
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(error);
}

fn with_diagnostics(message: &str, diagnostics: &StdMutex<RecentDiagnostics>) -> String {
    let recent = diagnostics
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .snapshot();
    if recent.is_empty() {
        message.to_owned()
    } else {
        format!("{message}\nRecent Codex app-server stderr (last 64 KiB):\n{recent}")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LoginAttemptToken {
    attempt: u64,
    transport_generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BufferedLoginCompletion {
    pub(crate) warning: Option<String>,
    pub(crate) token: LoginAttemptToken,
    pub(crate) sequence: u64,
}

#[derive(Default)]
struct LoginTrackingState {
    active_login_id: Option<String>,
    pending_attempt: Option<LoginAttemptToken>,
    early_completions: VecDeque<AccountLoginCompletedNotification>,
    next_attempt: u64,
    transport_generation: u64,
}

#[derive(Default)]
struct AccountEventState {
    login_tracking: StdMutex<LoginTrackingState>,
    refresh: Mutex<()>,
    sequence: AtomicU64,
    codex_version: StdMutex<Option<String>>,
}

impl AccountEventState {
    fn reserve_refresh_locked(&self) -> u64 {
        self.sequence.fetch_add(1, Ordering::AcqRel).wrapping_add(1)
    }

    fn reserve_refresh(&self) -> u64 {
        let _tracking = self
            .login_tracking
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.reserve_refresh_locked()
    }

    fn reset_transport(&self) {
        let mut tracking = self
            .login_tracking
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        tracking.transport_generation = tracking.transport_generation.wrapping_add(1);
        tracking.active_login_id = None;
        tracking.pending_attempt = None;
        tracking.early_completions.clear();
        self.reserve_refresh_locked();
    }
}

#[derive(Default)]
pub struct CodexAppServerState {
    inner: Mutex<Option<CodexAppServer>>,
    startup: Mutex<()>,
    shutting_down: AtomicBool,
    account_events: Arc<AccountEventState>,
    mapper: Arc<Mutex<CodexEventMapper>>,
}

impl CodexAppServerState {
    pub(crate) async fn is_running(&self) -> bool {
        self.inner.lock().await.is_some()
    }

    pub(crate) async fn emit_prestart_cancellation(
        &self,
        app: &tauri::AppHandle,
        routes: &RuntimeProcessState,
        route: &TurnRoute,
    ) {
        let generation = routes.transport_generation().await;
        let event = self
            .mapper
            .lock()
            .await
            .map_prestart_cancellation(generation, route);
        if let Some(event) = event {
            emit_runtime_event(app, event);
        }
    }

    pub(crate) async fn emit_routed_notification(
        &self,
        app: &tauri::AppHandle,
        method: &str,
        params: Value,
    ) -> Result<(), String> {
        let routes = app.state::<RuntimeProcessState>();
        let generation = routes.transport_generation().await;
        route_lifecycle_notification(
            &routes,
            &self.mapper,
            generation,
            method,
            &params,
            |event| {
                emit_runtime_event(app, event);
            },
        )
        .await?;
        Ok(())
    }

    /// Atomically starts a response-side reservation with respect to lifecycle
    /// mapping. Replacing a route identity also clears sequence/idempotence
    /// state before any notification can observe the new route.
    pub(crate) async fn begin_runtime_turn(
        &self,
        routes: &RuntimeProcessState,
        desired: TurnRoute,
    ) -> Result<CodexTurnStart, RuntimeProcessError> {
        let mut mapper = self.mapper.lock().await;
        let start = routes.begin_codex_turn(desired).await?;
        if let CodexTurnStart::Reserved(reservation) = &start {
            if reservation.route_identity_changed() {
                mapper.remove_route(&reservation.route.window_label, &reservation.route.tab_id);
            }
        }
        Ok(start)
    }

    /// Upserts a non-Codex-adapter route under the lifecycle gate. This keeps
    /// legacy Claude delegation from replacing a Codex route between mapping
    /// and event delivery.
    pub(crate) async fn upsert_runtime_route(
        &self,
        routes: &RuntimeProcessState,
        route: TurnRoute,
    ) {
        let mut mapper = self.mapper.lock().await;
        let identity_changed = routes
            .get(&route.window_label, &route.tab_id)
            .await
            .is_none_or(|previous| {
                previous.runtime != route.runtime
                    || previous.session_id != route.session_id
                    || previous.attempt_id != route.attempt_id
            });
        routes.upsert(route.clone()).await;
        if identity_changed {
            mapper.remove_route(&route.window_label, &route.tab_id);
        }
    }

    /// Removes one route while holding the same lifecycle ordering gate used
    /// by inbound and response-side notifications. This keeps registry and
    /// mapper state indivisible from the mapper's point of view.
    pub(crate) async fn remove_runtime_route(
        &self,
        routes: &RuntimeProcessState,
        window_label: &str,
        tab_id: &str,
    ) -> Option<TurnRoute> {
        let mut mapper = self.mapper.lock().await;
        let removed = routes.remove_tab(window_label, tab_id).await;
        mapper.remove_route(window_label, tab_id);
        removed
    }

    pub(crate) async fn remove_runtime_route_for_attempt(
        &self,
        routes: &RuntimeProcessState,
        window_label: &str,
        tab_id: &str,
        attempt_id: &str,
    ) -> Option<TurnRoute> {
        let mut mapper = self.mapper.lock().await;
        let removed = routes
            .remove_tab_for_attempt(window_label, tab_id, attempt_id)
            .await;
        if removed.is_some() {
            mapper.remove_route(window_label, tab_id);
        }
        removed
    }

    /// Removes every route owned by a window under the lifecycle ordering
    /// gate, while leaving all other windows' idempotence state untouched.
    pub(crate) async fn remove_runtime_window(
        &self,
        routes: &RuntimeProcessState,
        window_label: &str,
    ) -> Vec<TurnRoute> {
        let mut mapper = self.mapper.lock().await;
        let removed = routes.remove_window(window_label).await;
        for route in &removed {
            mapper.remove_route(&route.window_label, &route.tab_id);
        }
        removed
    }

    /// Rolls back a response-side reservation under the lifecycle gate. When
    /// the rollback removes a newly-created route, any stale mapper state for
    /// that route key is cleared before notifications can resume.
    pub(crate) async fn abort_runtime_turn(
        &self,
        routes: &RuntimeProcessState,
        reservation: &CodexTurnReservation,
        rollback_route: bool,
    ) -> bool {
        self.abort_runtime_turn_outcome(routes, reservation, rollback_route)
            .await
            .is_some()
    }

    pub(crate) async fn abort_runtime_turn_outcome(
        &self,
        routes: &RuntimeProcessState,
        reservation: &CodexTurnReservation,
        rollback_route: bool,
    ) -> Option<bool> {
        let mut mapper = self.mapper.lock().await;
        let outcome = routes
            .abort_codex_turn_outcome(reservation, rollback_route)
            .await;
        if outcome.is_some()
            && routes
                .get(&reservation.route.window_label, &reservation.route.tab_id)
                .await
                .is_none()
        {
            mapper.remove_route(&reservation.route.window_label, &reservation.route.tab_id);
        }
        outcome
    }

    #[cfg(test)]
    pub(crate) fn remember_active_login(&self, login_id: String) {
        let mut tracking = self
            .account_events
            .login_tracking
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        tracking.active_login_id = Some(login_id);
        tracking.pending_attempt = None;
        tracking.early_completions.clear();
        self.account_events.sequence.fetch_add(1, Ordering::AcqRel);
    }

    pub(crate) fn begin_login_attempt(&self) -> LoginAttemptToken {
        let mut tracking = self
            .account_events
            .login_tracking
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        tracking.next_attempt = tracking.next_attempt.wrapping_add(1);
        let token = LoginAttemptToken {
            attempt: tracking.next_attempt,
            transport_generation: tracking.transport_generation,
        };
        tracking.active_login_id = None;
        tracking.pending_attempt = Some(token);
        tracking.early_completions.clear();
        self.account_events.sequence.fetch_add(1, Ordering::AcqRel);
        token
    }

    pub(crate) fn finish_login_attempt(
        &self,
        token: LoginAttemptToken,
        login_id: String,
    ) -> Result<Option<BufferedLoginCompletion>, String> {
        let mut tracking = self
            .account_events
            .login_tracking
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if tracking.pending_attempt != Some(token)
            || tracking.transport_generation != token.transport_generation
        {
            return Err(
                "Codex login connection restarted or was superseded before login could be tracked"
                    .into(),
            );
        }
        tracking.pending_attempt = None;
        let exact = tracking
            .early_completions
            .iter()
            .position(|completion| completion.login_id.as_deref() == Some(login_id.as_str()));
        let wildcard = tracking
            .early_completions
            .iter()
            .position(|completion| completion.login_id.is_none());
        let completion = exact
            .or(wildcard)
            .and_then(|position| tracking.early_completions.remove(position));
        tracking.early_completions.clear();
        if let Some(completion) = completion {
            tracking.active_login_id = None;
            let sequence = self.account_events.reserve_refresh_locked();
            return Ok(Some(BufferedLoginCompletion {
                warning: login_completion_warning(&completion),
                token,
                sequence,
            }));
        }
        tracking.active_login_id = Some(login_id);
        Ok(None)
    }

    pub(crate) fn finish_login_attempt_without_id(
        &self,
        token: LoginAttemptToken,
    ) -> Result<(), String> {
        let mut tracking = self
            .account_events
            .login_tracking
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if tracking.pending_attempt != Some(token)
            || tracking.transport_generation != token.transport_generation
        {
            return Err(
                "Codex login connection restarted or was superseded before login could be tracked"
                    .into(),
            );
        }
        tracking.pending_attempt = None;
        tracking.active_login_id = None;
        tracking.early_completions.clear();
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn is_login_attempt_current(&self, token: LoginAttemptToken) -> bool {
        let tracking = self
            .account_events
            .login_tracking
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        tracking.next_attempt == token.attempt
            && tracking.transport_generation == token.transport_generation
    }

    pub(crate) async fn lock_account_refresh(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.account_events.refresh.lock().await
    }

    pub(crate) fn is_buffered_login_completion_current(
        &self,
        completion: &BufferedLoginCompletion,
    ) -> bool {
        let tracking = self
            .account_events
            .login_tracking
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        tracking.next_attempt == completion.token.attempt
            && tracking.transport_generation == completion.token.transport_generation
            && self.account_events.sequence.load(Ordering::Acquire) == completion.sequence
    }

    pub(crate) fn with_current_buffered_login_completion<T>(
        &self,
        completion: &BufferedLoginCompletion,
        action: impl FnOnce() -> T,
    ) -> Option<T> {
        let tracking = self
            .account_events
            .login_tracking
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if tracking.next_attempt != completion.token.attempt
            || tracking.transport_generation != completion.token.transport_generation
            || self.account_events.sequence.load(Ordering::Acquire) != completion.sequence
        {
            return None;
        }
        Some(action())
    }

    #[cfg(test)]
    pub(crate) fn reserve_account_refresh(&self) -> u64 {
        self.account_events.reserve_refresh()
    }

    pub(crate) fn abandon_login_attempt(&self, token: LoginAttemptToken) {
        let mut tracking = self
            .account_events
            .login_tracking
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if tracking.pending_attempt == Some(token) {
            tracking.pending_attempt = None;
            tracking.early_completions.clear();
        }
    }

    pub(crate) fn reset_account_transport(&self) {
        self.account_events.reset_transport();
    }

    pub(crate) fn active_login_id(&self) -> Option<String> {
        self.account_events
            .login_tracking
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .active_login_id
            .clone()
    }

    pub(crate) fn take_matching_active_login(&self, login_id: Option<&str>) -> bool {
        let Some(login_id) = login_id else {
            return false;
        };
        let mut tracking = self
            .account_events
            .login_tracking
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if tracking.active_login_id.as_deref() != Some(login_id) {
            return false;
        }
        tracking.active_login_id.take();
        self.account_events.sequence.fetch_add(1, Ordering::AcqRel);
        true
    }

    pub(crate) fn clear_active_login(&self) {
        let mut tracking = self
            .account_events
            .login_tracking
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        tracking.active_login_id = None;
        tracking.pending_attempt = None;
        tracking.early_completions.clear();
        tracking.next_attempt = tracking.next_attempt.wrapping_add(1);
        self.account_events.sequence.fetch_add(1, Ordering::AcqRel);
    }

    pub(crate) fn codex_version(&self) -> Option<String> {
        self.account_events
            .codex_version
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn ensure_accepting_requests(&self) -> Result<(), String> {
        if self.shutting_down.load(Ordering::Acquire) {
            Err("Codex app-server is shutting down".into())
        } else {
            Ok(())
        }
    }

    pub async fn request(
        &self,
        app: &tauri::AppHandle,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        self.ensure_accepting_requests()?;
        // Clone the handle in a nested block so the `inner` mutex guard cannot
        // extend across later awaits (Rust keeps `if let`/`match` scrutinee
        // temporaries alive for the whole expression — that previously deadlocked
        // cold start when `install_started_server` tried to re-lock `inner`).
        let running = {
            self.inner
                .lock()
                .await
                .as_ref()
                .map(|server| server.handle.clone())
        };
        if let Some(handle) = running {
            self.ensure_accepting_requests()?;
            return handle.request(method, params).await;
        }

        let deadline = tokio::time::Instant::now() + DEFAULT_STARTUP_TIMEOUT;
        let startup_guard = tokio::time::timeout_at(deadline, self.startup.lock())
            .await
            .map_err(|_| "Codex app-server startup timed out".to_string())?;
        self.ensure_accepting_requests()?;

        let running = {
            self.inner
                .lock()
                .await
                .as_ref()
                .map(|server| server.handle.clone())
        };
        let handle = if let Some(handle) = running {
            handle
        } else {
            let binary = match tokio::task::spawn_blocking(probe_known_codex_binary_on_disk).await
            {
                Ok(Some(probed)) => probed,
                _ => tokio::time::timeout_at(deadline, discover_codex_binary())
                    .await
                    .map_err(|_| {
                        "Codex app-server startup timed out during discovery".to_string()
                    })??,
            };
            self.ensure_accepting_requests()?;
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err("Codex app-server startup timed out".into());
            }
            let codex_version = Some(binary.version.clone());
            *self
                .account_events
                .codex_version
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = codex_version.clone();
            let generation = app
                .state::<RuntimeProcessState>()
                .transport_generation()
                .await;
            self.mapper.lock().await.set_generation(generation);
            let spawner = Arc::new(ProcessSpawner::new(binary.path));
            let warnings = Arc::new(TauriWarningSink {
                app: app.clone(),
                account_events: self.account_events.clone(),
                mapper: self.mapper.clone(),
                codex_version,
            });
            let version = app.package_info().version.to_string();
            let server = tokio::time::timeout_at(
                deadline,
                start_supervisor(
                    spawner,
                    version,
                    warnings,
                    remaining,
                    DEFAULT_REQUEST_TIMEOUT,
                ),
            )
            .await
            .map_err(|_| "Codex app-server startup timed out".to_string())??;
            self.install_started_server(server).await?
        };
        drop(startup_guard);
        self.ensure_accepting_requests()?;
        handle.request(method, params).await
    }

    async fn install_started_server(
        &self,
        server: CodexAppServer,
    ) -> Result<SupervisorHandle, String> {
        if let Err(error) = self.ensure_accepting_requests() {
            let _ = server.shutdown().await;
            return Err(error);
        }

        let mut inner = self.inner.lock().await;
        if let Err(error) = self.ensure_accepting_requests() {
            drop(inner);
            let _ = server.shutdown().await;
            return Err(error);
        }
        if let Some(existing) = inner.as_ref() {
            let handle = existing.handle.clone();
            drop(inner);
            let _ = server.shutdown().await;
            return Ok(handle);
        }

        let handle = server.handle.clone();
        *inner = Some(server);
        if self.shutting_down.load(Ordering::Acquire) {
            let server = inner.take();
            drop(inner);
            if let Some(server) = server {
                let _ = server.shutdown().await;
            }
            return Err("Codex app-server is shutting down".into());
        }
        Ok(handle)
    }

    pub async fn shutdown(&self) -> Result<(), String> {
        self.shutting_down.store(true, Ordering::Release);
        self.reset_account_transport();
        let _startup_guard = self.startup.lock().await;
        let server = self.inner.lock().await.take();
        match server {
            Some(server) => server.shutdown().await,
            None => Ok(()),
        }
    }

    pub async fn diagnostics(&self) -> String {
        self.inner
            .lock()
            .await
            .as_ref()
            .map(|server| {
                server
                    .handle
                    .diagnostics
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .snapshot()
            })
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        classify_account_notification, handle_inbound, route_lifecycle_notification,
        run_supervisor, start_supervisor, AccountNotificationAction, AppServerProcess,
        AppServerSpawner, CodexAppServerState, NotificationHandling, ProcessExit,
        RecentDiagnostics, ServerFuture, WarningSink, DEFAULT_STARTUP_TIMEOUT, STDERR_LIMIT,
    };
    use crate::runtime::codex::event_mapper::CodexEventMapper;
    use crate::runtime::codex::rpc::{RpcClient, RpcInbound};
    use crate::runtime::events::RuntimeEvent;
    use crate::runtime::process::{
        CodexCancelAction, CodexTurnReservation, CodexTurnStart, RuntimeProcessState, TurnRoute,
    };
    use crate::runtime::{settle_failed_codex_turn_start, RuntimeKind};
    use serde_json::{json, Value};
    use std::collections::VecDeque;
    use std::io;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::Duration;
    use tokio::io::{duplex, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
    use tokio::sync::{mpsc, oneshot, watch, Notify};

    fn reserved(start: CodexTurnStart) -> CodexTurnReservation {
        match start {
            CodexTurnStart::Reserved(reservation) => reservation,
            CodexTurnStart::Cancelled(_) => panic!("attempt was unexpectedly cancelled"),
        }
    }

    #[test]
    fn cold_start_budget_leaves_room_after_disk_probe() {
        // request() cold start prefers probe_known_codex_binary_on_disk (no --version)
        // before falling back to discover_codex_binary under this deadline.
        assert_eq!(DEFAULT_STARTUP_TIMEOUT, Duration::from_secs(10));
    }

    #[tokio::test]
    async fn installing_a_started_server_does_not_self_deadlock_on_inner_mutex(
    ) -> Result<(), Box<dyn std::error::Error>> {
        // Regression: `if let Some(_) = state.inner.lock().await...` kept the guard
        // alive across the cold-start else-branch, so install_started_server's
        // second `inner.lock()` hung until the status timeout cancelled it.
        let state = CodexAppServerState::default();
        let spawner = Arc::new(FakeSpawner::new([FakeBehavior::Serve]));
        let warnings = Arc::new(CollectWarnings::default());
        let server = start_supervisor(
            spawner,
            "1.3.0".into(),
            warnings,
            Duration::from_millis(200),
            Duration::from_millis(200),
        )
        .await?;

        let handle = tokio::time::timeout(
            Duration::from_millis(500),
            state.install_started_server(server),
        )
        .await
        .map_err(|_| "install_started_server deadlocked on inner mutex")??;

        let response = tokio::time::timeout(
            Duration::from_millis(500),
            handle.request("account/read", json!({})),
        )
        .await
        .map_err(|_| "account/read hung after install")??;
        assert_eq!(response["requiresOpenaiAuth"], true);
        assert!(state.is_running().await);
        state.shutdown().await?;
        Ok(())
    }

    #[tokio::test]
    async fn lifecycle_routes_turn_notifications_only_to_the_bound_owner() {
        let routes = RuntimeProcessState::default();
        for (window, tab) in [("window-a", "tab-a"), ("window-b", "tab-b")] {
            routes
                .upsert(TurnRoute {
                    runtime: RuntimeKind::Codex,
                    window_label: window.into(),
                    tab_id: tab.into(),
                    attempt_id: format!("attempt-{window}-{tab}"),
                    session_id: Some("thread-1".into()),
                    turn_id: None,
                })
                .await;
        }
        let generation = routes.transport_generation().await;
        routes
            .reserve_codex_turn("window-a", "tab-a", generation)
            .await
            .unwrap();
        let mapper = tokio::sync::Mutex::new(CodexEventMapper::default());

        let mut started = Vec::new();
        route_lifecycle_notification(
            &routes,
            &mapper,
            generation,
            "turn/started",
            &json!({
                "threadId":"thread-1",
                "turn":{"id":"turn-1","status":"inProgress"}
            }),
            |event| started.push(event),
        )
        .await
        .unwrap();
        let mut delta = Vec::new();
        route_lifecycle_notification(
            &routes,
            &mapper,
            generation,
            "item/agentMessage/delta",
            &json!({
                "threadId":"thread-1",
                "turnId":"turn-1",
                "itemId":"item-1",
                "delta":"hello"
            }),
            |event| delta.push(event),
        )
        .await
        .unwrap();

        assert_eq!(started.len(), 1);
        assert_eq!(delta.len(), 1);
        assert_eq!(started[0].window_label, "window-a");
        assert_eq!(delta[0].window_label, "window-a");
        assert_eq!(started[0].sequence, 1);
        assert_eq!(delta[0].sequence, 2);
    }

    #[tokio::test]
    async fn lifecycle_broadcasts_thread_events_but_keeps_turn_events_owner_scoped() {
        let routes = RuntimeProcessState::default();
        for (window, tab) in [("window-a", "tab-a"), ("window-b", "tab-b")] {
            routes
                .upsert(TurnRoute {
                    runtime: RuntimeKind::Codex,
                    window_label: window.into(),
                    tab_id: tab.into(),
                    attempt_id: format!("attempt-{window}-{tab}"),
                    session_id: Some("thread-1".into()),
                    turn_id: None,
                })
                .await;
        }
        let generation = routes.transport_generation().await;
        let mapper = tokio::sync::Mutex::new(CodexEventMapper::default());

        let mut events = Vec::new();
        route_lifecycle_notification(
            &routes,
            &mapper,
            generation,
            "thread/started",
            &json!({"thread":{"id":"thread-1"}}),
            |event| events.push(event),
        )
        .await
        .unwrap();

        assert_eq!(events.len(), 2);
        assert_eq!(events[0].window_label, "window-a");
        assert_eq!(events[1].window_label, "window-b");
        assert!(events.iter().all(|event| event.sequence == 1));
    }

    #[tokio::test]
    async fn lifecycle_completion_before_start_response_is_terminal_and_idempotent() {
        let routes = RuntimeProcessState::default();
        routes
            .upsert(TurnRoute {
                runtime: RuntimeKind::Codex,
                window_label: "window-a".into(),
                tab_id: "tab-a".into(),
                attempt_id: "attempt-a".into(),
                session_id: Some("thread-1".into()),
                turn_id: None,
            })
            .await;
        let generation = routes.transport_generation().await;
        routes
            .reserve_codex_turn("window-a", "tab-a", generation)
            .await
            .unwrap();
        let mapper = tokio::sync::Mutex::new(CodexEventMapper::default());
        let started_params = json!({
            "threadId":"thread-1",
            "turn":{"id":"turn-1","status":"inProgress"}
        });

        let mut started = Vec::new();
        route_lifecycle_notification(
            &routes,
            &mapper,
            generation,
            "turn/started",
            &started_params,
            |event| started.push(event),
        )
        .await
        .unwrap();
        assert_eq!(started.len(), 1);
        let mut completed = Vec::new();
        route_lifecycle_notification(
            &routes,
            &mapper,
            generation,
            "turn/completed",
            &json!({
                "threadId":"thread-1",
                "turn":{"id":"turn-1","status":"completed"}
            }),
            |event| completed.push(event),
        )
        .await
        .unwrap();
        assert!(matches!(
            completed[0].event,
            RuntimeEvent::TurnCompleted { .. }
        ));
        assert!(routes
            .codex_turn_owner("thread-1", "turn-1", generation)
            .await
            .is_none());

        let mut synthetic_after_response = Vec::new();
        route_lifecycle_notification(
            &routes,
            &mapper,
            generation,
            "turn/started",
            &started_params,
            |event| synthetic_after_response.push(event),
        )
        .await
        .unwrap();
        assert!(synthetic_after_response.is_empty());
        assert!(routes
            .codex_turn_owner("thread-1", "turn-1", generation)
            .await
            .is_none());
    }

    #[tokio::test]
    async fn lifecycle_drops_notifications_from_an_old_transport_generation() {
        let routes = RuntimeProcessState::default();
        routes
            .upsert(TurnRoute {
                runtime: RuntimeKind::Codex,
                window_label: "window-a".into(),
                tab_id: "tab-a".into(),
                attempt_id: "attempt-a".into(),
                session_id: Some("thread-1".into()),
                turn_id: None,
            })
            .await;
        let old_generation = routes.transport_generation().await;
        let advanced = routes.advance_transport_generation().await;
        let mapper = tokio::sync::Mutex::new(CodexEventMapper::default());
        mapper.lock().await.set_generation(advanced.generation);

        let mut events = Vec::new();
        route_lifecycle_notification(
            &routes,
            &mapper,
            old_generation,
            "thread/started",
            &json!({"thread":{"id":"thread-1"}}),
            |event| events.push(event),
        )
        .await
        .unwrap();
        assert!(events.is_empty());
    }

    #[tokio::test]
    async fn lifecycle_transport_reset_fails_each_old_turn_once_then_advances() {
        let routes = RuntimeProcessState::default();
        routes
            .upsert(TurnRoute {
                runtime: RuntimeKind::Codex,
                window_label: "window-a".into(),
                tab_id: "tab-a".into(),
                attempt_id: "attempt-a".into(),
                session_id: Some("thread-1".into()),
                turn_id: None,
            })
            .await;
        let generation = routes.transport_generation().await;
        routes
            .reserve_codex_turn("window-a", "tab-a", generation)
            .await
            .unwrap();
        let mapper = tokio::sync::Mutex::new(CodexEventMapper::default());
        route_lifecycle_notification(
            &routes,
            &mapper,
            generation,
            "turn/started",
            &json!({
                "threadId":"thread-1",
                "turn":{"id":"turn-1","status":"inProgress"}
            }),
            |_| {},
        )
        .await
        .unwrap();
        let mut emitted = Vec::new();

        let reset = super::reset_codex_lifecycle(
            &routes,
            &mapper,
            "Authorization: Bearer transport-secret",
            |event| emitted.push(event),
        )
        .await;
        let second = super::reset_codex_lifecycle(&routes, &mapper, "duplicate reset", |event| {
            emitted.push(event)
        })
        .await;

        assert_eq!(reset.generation, generation + 1);
        assert_eq!(second.generation, generation + 2);
        assert_eq!(emitted.len(), 1);
        let RuntimeEvent::TurnFailed { message, .. } = &emitted[0].event else {
            panic!("transport reset must fail the old turn");
        };
        assert!(!message.contains("transport-secret"));
        assert_eq!(routes.transport_generation().await, generation + 2);
    }

    #[tokio::test]
    async fn lifecycle_transport_reset_fails_a_pending_turn_without_faking_a_turn_id() {
        let routes = RuntimeProcessState::default();
        routes
            .begin_codex_turn(TurnRoute {
                runtime: RuntimeKind::Codex,
                window_label: "window-a".into(),
                tab_id: "tab-a".into(),
                attempt_id: "attempt-pending".into(),
                session_id: Some("thread-1".into()),
                turn_id: None,
            })
            .await
            .unwrap();
        let generation = routes.transport_generation().await;
        assert_eq!(
            routes
                .request_codex_cancel("window-a", "tab-a", "attempt-pending", generation,)
                .await,
            CodexCancelAction::Accepted
        );
        let cancel_outcome = routes
            .subscribe_codex_cancel("window-a", "tab-a", "attempt-pending")
            .await
            .unwrap();
        let mapper = tokio::sync::Mutex::new(CodexEventMapper::default());
        let mut emitted = Vec::new();

        super::reset_codex_lifecycle(&routes, &mapper, "transport closed", |event| {
            emitted.push(event)
        })
        .await;

        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].attempt_id, "attempt-pending");
        assert_eq!(emitted[0].session_id.as_deref(), Some("thread-1"));
        assert!(emitted[0].turn_id.is_none());
        let RuntimeEvent::TurnFailed { turn_id, message } = &emitted[0].event else {
            panic!("pending transport reset must emit a failed turn");
        };
        assert!(turn_id.is_none());
        assert_eq!(message, "transport closed");
        assert!(!matches!(
            emitted[0].event,
            RuntimeEvent::TurnCompleted { .. }
        ));
        assert_eq!(*cancel_outcome.borrow(), Some(Ok(())));
    }

    #[tokio::test]
    async fn unscoped_malformed_terminal_fails_the_generation_instead_of_guessing_a_route() {
        let routes = RuntimeProcessState::default();
        let CodexTurnStart::Reserved(reservation) = routes
            .begin_codex_turn(TurnRoute {
                runtime: RuntimeKind::Codex,
                window_label: "window-a".into(),
                tab_id: "tab-a".into(),
                attempt_id: "attempt-a".into(),
                session_id: Some("thread-a".into()),
                turn_id: None,
            })
            .await
            .unwrap()
        else {
            panic!("turn must reserve");
        };
        let generation = routes.transport_generation().await;
        routes
            .bind_codex_turn_for_reservation(&reservation, "thread-a", "turn-a")
            .await
            .unwrap();
        assert!(matches!(
            routes
                .request_codex_cancel("window-a", "tab-a", "attempt-a", generation)
                .await,
            CodexCancelAction::Interrupt(_)
        ));
        let outcome = routes
            .subscribe_codex_cancel("window-a", "tab-a", "attempt-a")
            .await
            .unwrap();
        let mapper = tokio::sync::Mutex::new(CodexEventMapper::default());
        let mut emitted = Vec::new();

        let result = route_lifecycle_notification(
            &routes,
            &mapper,
            generation,
            "turn/completed",
            &json!({"turn":{"id":"turn-a","status":"completed"}}),
            |event| emitted.push(event),
        )
        .await;

        assert!(result.is_err());
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].attempt_id, "attempt-a");
        assert!(matches!(emitted[0].event, RuntimeEvent::TurnFailed { .. }));
        assert_eq!(*outcome.borrow(), Some(Ok(())));
        assert_eq!(routes.transport_generation().await, generation + 1);
        assert!(routes.snapshot().await.codex_turn_owners.is_empty());
    }

    struct ConnectionScopedLifecycle {
        routes: Arc<RuntimeProcessState>,
        mapper: Arc<tokio::sync::Mutex<CodexEventMapper>>,
        poisoned: Notify,
        release_poison: Notify,
        emitted: AtomicUsize,
    }

    impl WarningSink for ConnectionScopedLifecycle {
        fn emit(&self, _message: String) {}

        fn handle_notification(
            &self,
            _client: Arc<RpcClient>,
            connection_generation: u64,
            method: String,
            params: Value,
        ) -> ServerFuture<'_, NotificationHandling> {
            Box::pin(async move {
                let result = route_lifecycle_notification(
                    &self.routes,
                    &self.mapper,
                    connection_generation,
                    &method,
                    &params,
                    |_| {
                        self.emitted.fetch_add(1, Ordering::AcqRel);
                    },
                )
                .await;
                match result {
                    Ok(_) => NotificationHandling::Continue,
                    Err(error) => {
                        self.poisoned.notify_one();
                        self.release_poison.notified().await;
                        NotificationHandling::Poison(error)
                    }
                }
            })
        }
    }

    #[tokio::test]
    async fn malformed_terminal_poisoning_rejects_late_frames_from_the_same_connection() {
        let routes = Arc::new(RuntimeProcessState::default());
        let old = reserved(
            routes
                .begin_codex_turn(TurnRoute {
                    runtime: RuntimeKind::Codex,
                    window_label: "window-a".into(),
                    tab_id: "tab-a".into(),
                    attempt_id: "attempt-old".into(),
                    session_id: Some("thread-a".into()),
                    turn_id: None,
                })
                .await
                .unwrap(),
        );
        routes
            .bind_codex_turn_for_reservation(&old, "thread-a", "turn-old")
            .await
            .unwrap();
        let connection_generation = routes.transport_generation().await;
        let mapper = Arc::new(tokio::sync::Mutex::new(CodexEventMapper::default()));
        let sink = Arc::new(ConnectionScopedLifecycle {
            routes: routes.clone(),
            mapper,
            poisoned: Notify::new(),
            release_poison: Notify::new(),
            emitted: AtomicUsize::new(0),
        });
        let (client_io, _server_io) = duplex(1024);
        let (_reader, writer) = tokio::io::split(client_io);
        let client = Arc::new(RpcClient::new(writer));
        let mut transport_failure = client.subscribe_transport_failures();
        let (tx, rx) = mpsc::channel(4);
        let inbound = tokio::spawn(handle_inbound(
            client.clone(),
            rx,
            sink.clone(),
            connection_generation,
        ));

        let poisoned = sink.poisoned.notified();
        tx.send(RpcInbound::Notification {
            method: "turn/completed".into(),
            params: json!({"turn":{"id":"turn-old","status":"completed"}}),
        })
        .await
        .unwrap();
        poisoned.await;
        assert_eq!(
            routes.transport_generation().await,
            connection_generation + 1
        );

        let new = reserved(
            routes
                .begin_codex_turn(TurnRoute {
                    runtime: RuntimeKind::Codex,
                    window_label: "window-a".into(),
                    tab_id: "tab-a".into(),
                    attempt_id: "attempt-new".into(),
                    session_id: Some("thread-a".into()),
                    turn_id: None,
                })
                .await
                .unwrap(),
        );
        tx.send(RpcInbound::Notification {
            method: "turn/started".into(),
            params: json!({
                "threadId":"thread-a",
                "turn":{"id":"turn-late","status":"inProgress"}
            }),
        })
        .await
        .unwrap();
        tx.send(RpcInbound::Notification {
            method: "item/agentMessage/delta".into(),
            params: json!({
                "threadId":"thread-a",
                "turnId":"turn-late",
                "itemId":"item-late",
                "delta":"late"
            }),
        })
        .await
        .unwrap();
        sink.release_poison.notify_one();
        tokio::time::timeout(Duration::from_millis(100), transport_failure.changed())
            .await
            .expect("poisoning did not report a transport failure")
            .unwrap();
        inbound.await.unwrap();
        assert!(tx
            .send(RpcInbound::Malformed {
                line: "late frame".into(),
                error: "late frame".into(),
            })
            .await
            .is_err());

        assert_eq!(
            routes
                .get("window-a", "tab-a")
                .await
                .and_then(|route| route.turn_id),
            None
        );
        assert_eq!(sink.emitted.load(Ordering::Acquire), 1);
        assert!(routes.abort_codex_turn(&new, false).await);
    }

    #[tokio::test]
    async fn scoped_terminal_with_missing_status_fails_and_finishes_the_exact_attempt() {
        let routes = RuntimeProcessState::default();
        let CodexTurnStart::Reserved(reservation) = routes
            .begin_codex_turn(TurnRoute {
                runtime: RuntimeKind::Codex,
                window_label: "window-a".into(),
                tab_id: "tab-a".into(),
                attempt_id: "attempt-a".into(),
                session_id: Some("thread-a".into()),
                turn_id: None,
            })
            .await
            .unwrap()
        else {
            panic!("turn must reserve");
        };
        let generation = routes.transport_generation().await;
        routes
            .bind_codex_turn_for_reservation(&reservation, "thread-a", "turn-a")
            .await
            .unwrap();
        assert!(matches!(
            routes
                .request_codex_cancel("window-a", "tab-a", "attempt-a", generation)
                .await,
            CodexCancelAction::Interrupt(_)
        ));
        let outcome = routes
            .subscribe_codex_cancel("window-a", "tab-a", "attempt-a")
            .await
            .unwrap();
        let mapper = tokio::sync::Mutex::new(CodexEventMapper::default());
        let mut emitted = Vec::new();

        assert_eq!(
            route_lifecycle_notification(
                &routes,
                &mapper,
                generation,
                "turn/completed",
                &json!({"threadId":"thread-a","turn":{"id":"turn-a"}}),
                |event| emitted.push(event),
            )
            .await
            .unwrap(),
            1
        );
        assert!(matches!(emitted[0].event, RuntimeEvent::TurnFailed { .. }));
        assert_eq!(*outcome.borrow(), Some(Ok(())));
        assert!(routes.snapshot().await.codex_turn_owners.is_empty());
        assert_eq!(routes.get("window-a", "tab-a").await.unwrap().turn_id, None);
    }

    #[tokio::test]
    async fn lifecycle_resume_deduplicates_threads_and_rebinds_only_successes() {
        let routes = RuntimeProcessState::default();
        for (window, tab, thread) in [
            ("window-a", "tab-a", "thread-ok"),
            ("window-b", "tab-b", "thread-ok"),
            ("window-c", "tab-c", "thread-fail"),
        ] {
            routes
                .upsert(TurnRoute {
                    runtime: RuntimeKind::Codex,
                    window_label: window.into(),
                    tab_id: tab.into(),
                    attempt_id: format!("attempt-{window}-{tab}"),
                    session_id: Some(thread.into()),
                    turn_id: None,
                })
                .await;
        }
        let mapper = tokio::sync::Mutex::new(CodexEventMapper::default());
        let reset = super::reset_codex_lifecycle(&routes, &mapper, "restart", |_| {}).await;
        let calls = Arc::new(StdMutex::new(Vec::new()));
        let request_calls = calls.clone();

        let warnings = super::resume_codex_subscriptions_with(&routes, &reset, move |thread_id| {
            let calls = request_calls.clone();
            async move {
                calls
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .push(thread_id.clone());
                if thread_id == "thread-fail" {
                    Err("token=resume-secret".to_string())
                } else {
                    Ok(())
                }
            }
        })
        .await;

        let mut calls = calls
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        calls.sort();
        assert_eq!(calls, ["thread-fail", "thread-ok"]);
        assert_eq!(
            routes
                .codex_thread_subscribers("thread-ok", reset.generation)
                .await
                .len(),
            2
        );
        assert!(routes
            .codex_thread_subscribers("thread-fail", reset.generation)
            .await
            .is_empty());
        assert_eq!(warnings.len(), 1);
        assert!(!warnings[0].contains("resume-secret"));
    }

    #[tokio::test]
    async fn lifecycle_resume_never_rebinds_a_reused_tab_to_the_snapshot_thread() {
        let routes = RuntimeProcessState::default();
        routes
            .upsert(TurnRoute {
                runtime: RuntimeKind::Codex,
                window_label: "window-a".into(),
                tab_id: "tab-a".into(),
                attempt_id: "attempt-old".into(),
                session_id: Some("thread-old".into()),
                turn_id: None,
            })
            .await;
        let mapper = tokio::sync::Mutex::new(CodexEventMapper::default());
        let reset = super::reset_codex_lifecycle(&routes, &mapper, "restart", |_| {}).await;

        routes
            .upsert(TurnRoute {
                runtime: RuntimeKind::Codex,
                window_label: "window-a".into(),
                tab_id: "tab-a".into(),
                attempt_id: "attempt-new".into(),
                session_id: Some("thread-new".into()),
                turn_id: None,
            })
            .await;

        let warnings =
            super::resume_codex_subscriptions_with(&routes, &reset, |_| async { Ok(()) }).await;

        assert_eq!(warnings.len(), 1);
        assert!(routes
            .codex_thread_subscribers("thread-old", reset.generation)
            .await
            .is_empty());
        assert_eq!(
            routes
                .codex_thread_subscribers("thread-new", reset.generation)
                .await
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn lifecycle_route_removal_resets_mapper_state_before_route_reuse() {
        let state = CodexAppServerState::default();
        let routes = RuntimeProcessState::default();
        let route = TurnRoute {
            runtime: RuntimeKind::Codex,
            window_label: "window-a".into(),
            tab_id: "tab-a".into(),
            attempt_id: "attempt-a".into(),
            session_id: Some("thread-1".into()),
            turn_id: Some("turn-1".into()),
        };
        let params = json!({
            "threadId": "thread-1",
            "turn": { "id": "turn-1", "status": "inProgress" }
        });
        routes.upsert(route.clone()).await;
        assert_eq!(
            state
                .mapper
                .lock()
                .await
                .map_notification(0, &route, "turn/started", &params)
                .len(),
            1
        );

        assert_eq!(
            state
                .remove_runtime_route(&routes, "window-a", "tab-a")
                .await,
            Some(route.clone())
        );
        routes.upsert(route.clone()).await;
        let remapped =
            state
                .mapper
                .lock()
                .await
                .map_notification(0, &route, "turn/started", &params);

        assert_eq!(remapped.len(), 1);
        assert_eq!(remapped[0].sequence, 1);
    }

    #[tokio::test]
    async fn lifecycle_window_removal_preserves_other_window_mapper_state() {
        let state = CodexAppServerState::default();
        let routes = RuntimeProcessState::default();
        let route_a = TurnRoute {
            runtime: RuntimeKind::Codex,
            window_label: "window-a".into(),
            tab_id: "tab-a".into(),
            attempt_id: "attempt-a".into(),
            session_id: Some("thread-a".into()),
            turn_id: Some("turn-a".into()),
        };
        let route_b = TurnRoute {
            runtime: RuntimeKind::Codex,
            window_label: "window-b".into(),
            tab_id: "tab-b".into(),
            attempt_id: "attempt-b".into(),
            session_id: Some("thread-b".into()),
            turn_id: Some("turn-b".into()),
        };
        let params_a = json!({
            "threadId": "thread-a",
            "turn": { "id": "turn-a", "status": "inProgress" }
        });
        let params_b = json!({
            "threadId": "thread-b",
            "turn": { "id": "turn-b", "status": "inProgress" }
        });
        routes.upsert(route_a.clone()).await;
        routes.upsert(route_b.clone()).await;
        {
            let mut mapper = state.mapper.lock().await;
            assert_eq!(
                mapper
                    .map_notification(0, &route_a, "turn/started", &params_a)
                    .len(),
                1
            );
            assert_eq!(
                mapper
                    .map_notification(0, &route_b, "turn/started", &params_b)
                    .len(),
                1
            );
        }

        let removed = state.remove_runtime_window(&routes, "window-a").await;
        assert_eq!(removed, vec![route_a.clone()]);
        assert_eq!(routes.get("window-a", "tab-a").await, None);
        assert_eq!(routes.get("window-b", "tab-b").await, Some(route_b.clone()));

        routes.upsert(route_a.clone()).await;
        let mut mapper = state.mapper.lock().await;
        assert_eq!(
            mapper
                .map_notification(0, &route_a, "turn/started", &params_a)
                .len(),
            1
        );
        assert!(mapper
            .map_notification(0, &route_b, "turn/started", &params_b)
            .is_empty());
    }

    #[tokio::test]
    async fn lifecycle_begin_waits_for_the_mapper_gate_and_resets_replaced_route_state() {
        let state = Arc::new(CodexAppServerState::default());
        let routes = Arc::new(RuntimeProcessState::default());
        let old_route = TurnRoute {
            runtime: RuntimeKind::Codex,
            window_label: "window-a".into(),
            tab_id: "tab-a".into(),
            attempt_id: "attempt-old".into(),
            session_id: Some("thread-old".into()),
            turn_id: None,
        };
        let new_route = TurnRoute {
            runtime: RuntimeKind::Codex,
            window_label: "window-a".into(),
            tab_id: "tab-a".into(),
            attempt_id: "attempt-new".into(),
            session_id: Some("thread-new".into()),
            turn_id: None,
        };
        routes.upsert(old_route.clone()).await;
        assert_eq!(
            state
                .mapper
                .lock()
                .await
                .map_notification(
                    0,
                    &old_route,
                    "thread/started",
                    &json!({"thread":{"id":"thread-old"}}),
                )
                .len(),
            1
        );

        let gate = state.mapper.lock().await;
        let attempted = Arc::new(Notify::new());
        let begin_state = state.clone();
        let begin_routes = routes.clone();
        let begin_attempted = attempted.clone();
        let begin = tokio::spawn(async move {
            begin_attempted.notify_one();
            begin_state
                .begin_runtime_turn(&begin_routes, new_route.clone())
                .await
                .map(|reservation| (reservation, new_route))
        });
        attempted.notified().await;
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(!begin.is_finished());

        drop(gate);
        let (_reservation, new_route) = begin.await.unwrap().unwrap();
        let mapped = state.mapper.lock().await.map_notification(
            0,
            &new_route,
            "thread/started",
            &json!({"thread":{"id":"thread-new"}}),
        );
        assert_eq!(mapped.len(), 1);
        assert_eq!(mapped[0].sequence, 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn lifecycle_route_replacement_waits_until_the_selected_event_is_emitted() {
        let state = Arc::new(CodexAppServerState::default());
        let routes = Arc::new(RuntimeProcessState::default());
        routes
            .upsert(TurnRoute {
                runtime: RuntimeKind::Codex,
                window_label: "window-a".into(),
                tab_id: "tab-a".into(),
                attempt_id: "attempt-old".into(),
                session_id: Some("thread-old".into()),
                turn_id: None,
            })
            .await;
        let generation = routes.transport_generation().await;
        let mapper = state.mapper.clone();
        let notification_routes = routes.clone();
        let emitted = Arc::new(StdMutex::new(Vec::new()));
        let notification_emitted = emitted.clone();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let notification = tokio::spawn(async move {
            route_lifecycle_notification(
                &notification_routes,
                &mapper,
                generation,
                "thread/started",
                &json!({"thread":{"id":"thread-old"}}),
                move |event| {
                    entered_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(1)).unwrap();
                    notification_emitted
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .push(event);
                },
            )
            .await
            .unwrap();
        });
        tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(1)))
            .await
            .unwrap()
            .unwrap();

        let begin_state = state.clone();
        let begin_routes = routes.clone();
        let begin = tokio::spawn(async move {
            begin_state
                .begin_runtime_turn(
                    &begin_routes,
                    TurnRoute {
                        runtime: RuntimeKind::Codex,
                        window_label: "window-a".into(),
                        tab_id: "tab-a".into(),
                        attempt_id: "attempt-new".into(),
                        session_id: Some("thread-new".into()),
                        turn_id: None,
                    },
                )
                .await
        });
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(!begin.is_finished());

        release_tx.send(()).unwrap();
        notification.await.unwrap();
        begin.await.unwrap().unwrap();
        {
            let emitted = emitted
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            assert_eq!(emitted.len(), 1);
            assert_eq!(emitted[0].session_id.as_deref(), Some("thread-old"));
        }
        assert_eq!(
            routes
                .get("window-a", "tab-a")
                .await
                .and_then(|route| route.session_id),
            Some("thread-new".into())
        );
    }

    #[tokio::test]
    async fn failed_turn_start_releases_unclaimed_reservation_and_preserves_error() {
        let state = CodexAppServerState::default();
        let routes = RuntimeProcessState::default();
        let route = TurnRoute {
            runtime: RuntimeKind::Codex,
            window_label: "window-a".into(),
            tab_id: "tab-a".into(),
            attempt_id: "attempt-a".into(),
            session_id: Some("thread-a".into()),
            turn_id: None,
        };
        let reservation = reserved(
            state
                .begin_runtime_turn(&routes, route.clone())
                .await
                .unwrap(),
        );

        assert_eq!(
            settle_failed_codex_turn_start(
                &state,
                &routes,
                &reservation,
                "turn/start transport error".into(),
            )
            .await,
            Err("turn/start transport error".into())
        );
        assert!(routes.snapshot().await.pending_codex_turns.is_empty());
        assert_eq!(routes.get("window-a", "tab-a").await, Some(route.clone()));

        let retry = reserved(state.begin_runtime_turn(&routes, route).await.unwrap());
        assert!(state.abort_runtime_turn(&routes, &retry, false).await);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn failed_turn_start_waits_for_selected_lifecycle_and_preserves_its_claim() {
        let state = Arc::new(CodexAppServerState::default());
        let routes = Arc::new(RuntimeProcessState::default());
        let reservation = reserved(
            state
                .begin_runtime_turn(
                    &routes,
                    TurnRoute {
                        runtime: RuntimeKind::Codex,
                        window_label: "window-a".into(),
                        tab_id: "tab-a".into(),
                        attempt_id: "attempt-a".into(),
                        session_id: Some("thread-a".into()),
                        turn_id: None,
                    },
                )
                .await
                .unwrap(),
        );
        routes
            .bind_codex_thread_for_reservation(&reservation, "thread-a")
            .await
            .unwrap();
        let generation = routes.transport_generation().await;

        let lifecycle_routes = routes.clone();
        let mapper = state.mapper.clone();
        let (emit_entered_tx, emit_entered_rx) = std::sync::mpsc::channel();
        let (release_emit_tx, release_emit_rx) = std::sync::mpsc::channel();
        let lifecycle = tokio::spawn(async move {
            route_lifecycle_notification(
                &lifecycle_routes,
                &mapper,
                generation,
                "turn/started",
                &json!({
                    "threadId": "thread-a",
                    "turn": { "id": "turn-a", "status": "inProgress" }
                }),
                move |_| {
                    emit_entered_tx.send(()).unwrap();
                    release_emit_rx
                        .recv_timeout(Duration::from_secs(1))
                        .unwrap();
                },
            )
            .await
        });
        tokio::task::spawn_blocking(move || emit_entered_rx.recv_timeout(Duration::from_secs(1)))
            .await
            .unwrap()
            .unwrap();
        assert!(routes.snapshot().await.pending_codex_turns.is_empty());
        assert_eq!(
            routes
                .get("window-a", "tab-a")
                .await
                .and_then(|route| route.turn_id),
            Some("turn-a".into())
        );

        let settlement = settle_failed_codex_turn_start(
            &state,
            &routes,
            &reservation,
            "turn/start transport error".into(),
        );
        tokio::pin!(settlement);
        tokio::select! {
            biased;
            result = &mut settlement => {
                panic!("turn/start error settled before the selected lifecycle event: {result:?}");
            }
            _ = std::future::ready(()) => {}
        }

        release_emit_tx.send(()).unwrap();
        assert_eq!(lifecycle.await.unwrap().unwrap(), 1);
        assert_eq!(settlement.await, Ok(()));
        assert_eq!(
            routes
                .get("window-a", "tab-a")
                .await
                .and_then(|route| route.turn_id),
            Some("turn-a".into())
        );
        assert!(routes.snapshot().await.pending_codex_turns.is_empty());
    }

    #[test]
    fn lifecycle_resume_response_must_confirm_the_requested_thread() {
        assert!(super::validate_thread_resume_response(
            "thread-1",
            &json!({"thread":{"id":"thread-1"}}),
        )
        .is_ok());
        assert!(super::validate_thread_resume_response(
            "thread-1",
            &json!({"thread":{"id":"thread-other"}}),
        )
        .is_err());
        assert!(super::validate_thread_resume_response("thread-1", &json!({})).is_err());
    }

    #[derive(Default)]
    struct OrderedNotifications {
        order: StdMutex<Vec<String>>,
        first_started: Notify,
        release_first: Notify,
    }

    impl WarningSink for OrderedNotifications {
        fn emit(&self, _message: String) {}

        fn handle_notification(
            &self,
            _client: Arc<RpcClient>,
            _connection_generation: u64,
            method: String,
            _params: Value,
        ) -> ServerFuture<'_, NotificationHandling> {
            Box::pin(async move {
                self.order
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .push(format!("start:{method}"));
                if method == "thread/started" {
                    self.first_started.notify_one();
                    self.release_first.notified().await;
                }
                self.order
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .push(format!("end:{method}"));
                NotificationHandling::Continue
            })
        }
    }

    #[tokio::test]
    async fn inbound_reader_awaits_lifecycle_notifications_in_wire_order() {
        let (client_io, _server_io) = duplex(1024);
        let (_reader, writer) = tokio::io::split(client_io);
        let client = Arc::new(RpcClient::new(writer));
        let (tx, rx) = mpsc::channel(4);
        let sink = Arc::new(OrderedNotifications::default());
        let task = tokio::spawn(handle_inbound(client, rx, sink.clone(), 0));

        tx.send(RpcInbound::Notification {
            method: "thread/started".into(),
            params: json!({"thread":{"id":"thread-1"}}),
        })
        .await
        .unwrap();
        sink.first_started.notified().await;
        tx.send(RpcInbound::Notification {
            method: "turn/started".into(),
            params: json!({
                "threadId":"thread-1",
                "turn":{"id":"turn-1","status":"inProgress"}
            }),
        })
        .await
        .unwrap();
        tokio::task::yield_now().await;
        assert_eq!(
            sink.order
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .as_slice(),
            ["start:thread/started"]
        );

        sink.release_first.notify_one();
        drop(tx);
        task.await.unwrap();
        assert_eq!(
            sink.order
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .as_slice(),
            [
                "start:thread/started",
                "end:thread/started",
                "start:turn/started",
                "end:turn/started"
            ]
        );
    }

    #[test]
    fn process_inspection_error_still_requires_best_effort_termination() {
        let (needs_termination, inspection_error) = super::process_termination_decision(Err(
            io::Error::new(io::ErrorKind::Other, "inspection failed"),
        ));

        assert!(needs_termination);
        assert!(inspection_error
            .as_deref()
            .is_some_and(|error| error.contains("inspection failed")));
    }

    #[test]
    fn confirmed_exit_cleanup_errors_are_not_silenced() {
        let error = super::cleanup_after_confirmed_exit(Some(()), |_| {
            Err("descendant cleanup denied".to_string())
        })
        .expect_err("confirmed-exit cleanup failure was discarded");

        assert!(error.contains("cleanup denied"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn app_server_wait_kills_unix_descendants_after_parent_exit() {
        use crate::runtime::codex::discovery::{attach_process_tree, isolate_process_tree};
        use std::process::Stdio;
        use tokio::process::Command;

        let temp = tempfile::tempdir().unwrap();
        let sentinel = temp.path().join("app-server-descendant-survived.txt");
        let ready = temp.path().join("app-server-descendant-ready.txt");
        let escaped_sentinel = sentinel.to_string_lossy().replace('\'', "'\\''");
        let escaped_ready = ready.to_string_lossy().replace('\'', "'\\''");
        let script = format!(
            "(trap '' HUP; printf ready > '{}'; sleep 0.5; printf survived > '{}') </dev/null >/dev/null 2>&1 & while [ ! -f '{}' ]; do sleep 0.01; done; exit 0",
            escaped_ready, escaped_sentinel, escaped_ready
        );
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        isolate_process_tree(&mut command);
        let child = command.spawn().unwrap();
        let process_tree = attach_process_tree(&child).unwrap();
        let mut process = super::TokioAppServerProcess {
            child,
            process_tree: Some(process_tree),
            stdin: None,
            stdout: None,
            stderr: None,
        };

        let exit = tokio::time::timeout(Duration::from_secs(5), process.wait())
            .await
            .expect("app-server parent did not exit before the test deadline")
            .unwrap();
        tokio::time::sleep(Duration::from_millis(800)).await;

        assert!(exit.success);
        assert!(
            !sentinel.exists(),
            "app-server parent exit left a Unix descendant alive"
        );
    }

    #[derive(Clone, Copy)]
    enum FakeBehavior {
        HangInitialize,
        RejectInitialize,
        CrashAfterInitialized,
        CloseStdoutAfterInitialized,
        StopReadingAfterInitialized,
        CrashOnRequest,
        Serve,
    }

    struct FakeSpawner {
        behaviors: StdMutex<VecDeque<FakeBehavior>>,
        spawn_count: AtomicUsize,
        transcripts: Arc<StdMutex<Vec<Vec<Value>>>>,
    }

    impl FakeSpawner {
        fn new(behaviors: impl IntoIterator<Item = FakeBehavior>) -> Self {
            Self {
                behaviors: StdMutex::new(behaviors.into_iter().collect()),
                spawn_count: AtomicUsize::new(0),
                transcripts: Arc::new(StdMutex::new(Vec::new())),
            }
        }

        fn spawn_count(&self) -> usize {
            self.spawn_count.load(Ordering::SeqCst)
        }

        fn transcript(&self, index: usize) -> Vec<Value> {
            self.transcripts
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .get(index)
                .cloned()
                .unwrap_or_default()
        }
    }

    impl AppServerSpawner for FakeSpawner {
        fn spawn(&self) -> ServerFuture<'_, Result<Box<dyn AppServerProcess>, String>> {
            Box::pin(async move {
                let behavior = self
                    .behaviors
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .pop_front()
                    .ok_or_else(|| "fake spawn budget exhausted".to_string())?;
                let index = self.spawn_count.fetch_add(1, Ordering::SeqCst);
                {
                    let mut transcripts = self
                        .transcripts
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    while transcripts.len() <= index {
                        transcripts.push(Vec::new());
                    }
                }

                let (client_stdin, server_stdin) = duplex(16 * 1024);
                let (server_stdout, client_stdout) = duplex(16 * 1024);
                let (mut server_stderr, client_stderr) = duplex(128 * 1024);
                let (exit_tx, exit_rx) = watch::channel::<Option<ProcessExit>>(None);
                let transcript = self.transcripts.clone();
                let task_exit = exit_tx.clone();
                let task = tokio::spawn(async move {
                    let mut lines = BufReader::new(server_stdin).lines();
                    let mut stdout = server_stdout;
                    while let Ok(Some(line)) = lines.next_line().await {
                        let Ok(frame) = serde_json::from_str::<Value>(&line) else {
                            continue;
                        };
                        transcript
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())[index]
                            .push(frame.clone());

                        match frame.get("method").and_then(Value::as_str) {
                            Some("initialize") => {
                                if matches!(behavior, FakeBehavior::HangInitialize) {
                                    std::future::pending::<()>().await;
                                    return;
                                }
                                let id = frame.get("id").cloned().unwrap_or(Value::Null);
                                let response = match behavior {
                                    FakeBehavior::RejectInitialize => json!({
                                        "id": id,
                                        "error": {"code": -32000, "message": "initialize rejected"}
                                    }),
                                    _ => json!({"id": id, "result": {"protocolVersion":"v2"}}),
                                };
                                if stdout
                                    .write_all(format!("{response}\n").as_bytes())
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                                if matches!(behavior, FakeBehavior::RejectInitialize) {
                                    break;
                                }
                            }
                            Some("initialized")
                                if matches!(behavior, FakeBehavior::CrashAfterInitialized) =>
                            {
                                let _ = server_stderr.write_all(b"first process crashed\n").await;
                                let _ = task_exit.send(Some(ProcessExit::failed("exit code 1")));
                                return;
                            }
                            Some("initialized")
                                if matches!(
                                    behavior,
                                    FakeBehavior::CloseStdoutAfterInitialized
                                ) =>
                            {
                                drop(stdout);
                                std::future::pending::<()>().await;
                                return;
                            }
                            Some("initialized")
                                if matches!(
                                    behavior,
                                    FakeBehavior::StopReadingAfterInitialized
                                ) =>
                            {
                                std::future::pending::<()>().await;
                                return;
                            }
                            Some("initialized") => {}
                            Some(_) if matches!(behavior, FakeBehavior::CrashOnRequest) => {
                                let noise = vec![b'x'; 70 * 1024];
                                let _ = server_stderr.write_all(&noise).await;
                                let _ = server_stderr
                                    .write_all(b" sk-test-secret-1234567890abcdefgh\n")
                                    .await;
                                let _ = task_exit.send(Some(ProcessExit::failed("exit code 9")));
                                return;
                            }
                            Some(method) => {
                                let id = frame.get("id").cloned().unwrap_or(Value::Null);
                                let result = if method == "account/read" {
                                    json!({"requiresOpenaiAuth": true})
                                } else {
                                    json!({"accepted": true})
                                };
                                let response = json!({"id": id, "result": result});
                                if stdout
                                    .write_all(format!("{response}\n").as_bytes())
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                            }
                            None => {}
                        }
                    }
                    let _ = task_exit.send(Some(ProcessExit::successful("fake stream closed")));
                });

                Ok(Box::new(FakeProcess {
                    stdin: Some(Box::new(client_stdin)),
                    stdout: Some(Box::new(client_stdout)),
                    stderr: Some(Box::new(client_stderr)),
                    exit_tx,
                    exit_rx,
                    task: Some(task),
                }) as Box<dyn AppServerProcess>)
            })
        }
    }

    #[derive(Default)]
    struct ImmediateEofSpawner {
        spawn_count: AtomicUsize,
    }

    impl ImmediateEofSpawner {
        fn spawn_count(&self) -> usize {
            self.spawn_count.load(Ordering::SeqCst)
        }
    }

    impl AppServerSpawner for ImmediateEofSpawner {
        fn spawn(&self) -> ServerFuture<'_, Result<Box<dyn AppServerProcess>, String>> {
            Box::pin(async move {
                self.spawn_count.fetch_add(1, Ordering::SeqCst);
                let (client_stdin, server_stdin) = duplex(16 * 1024);
                let (exit_tx, exit_rx) = watch::channel::<Option<ProcessExit>>(None);
                let task = tokio::spawn(async move {
                    let _server_stdin = server_stdin;
                    std::future::pending::<()>().await;
                });
                Ok(Box::new(FakeProcess {
                    stdin: Some(Box::new(client_stdin)),
                    stdout: Some(Box::new(std::io::Cursor::new(
                        b"{\"id\":1,\"result\":{\"protocolVersion\":\"v2\"}}\n".to_vec(),
                    ))),
                    stderr: Some(Box::new(std::io::Cursor::new(Vec::<u8>::new()))),
                    exit_tx,
                    exit_rx,
                    task: Some(task),
                }) as Box<dyn AppServerProcess>)
            })
        }
    }

    struct FakeProcess {
        stdin: Option<Box<dyn AsyncWrite + Unpin + Send>>,
        stdout: Option<Box<dyn tokio::io::AsyncRead + Unpin + Send>>,
        stderr: Option<Box<dyn tokio::io::AsyncRead + Unpin + Send>>,
        exit_tx: watch::Sender<Option<ProcessExit>>,
        exit_rx: watch::Receiver<Option<ProcessExit>>,
        task: Option<tokio::task::JoinHandle<()>>,
    }

    impl AppServerProcess for FakeProcess {
        fn take_stdin(&mut self) -> Option<Box<dyn AsyncWrite + Unpin + Send>> {
            self.stdin.take()
        }

        fn take_stdout(&mut self) -> Option<Box<dyn tokio::io::AsyncRead + Unpin + Send>> {
            self.stdout.take()
        }

        fn take_stderr(&mut self) -> Option<Box<dyn tokio::io::AsyncRead + Unpin + Send>> {
            self.stderr.take()
        }

        fn wait(&mut self) -> ServerFuture<'_, Result<ProcessExit, String>> {
            Box::pin(async move {
                loop {
                    if let Some(exit) = self.exit_rx.borrow().clone() {
                        return Ok(exit);
                    }
                    self.exit_rx
                        .changed()
                        .await
                        .map_err(|_| "fake process exit channel closed".to_string())?;
                }
            })
        }

        fn terminate(&mut self) -> ServerFuture<'_, Result<(), String>> {
            Box::pin(async move {
                if let Some(task) = self.task.take() {
                    task.abort();
                }
                let _ = self
                    .exit_tx
                    .send(Some(ProcessExit::successful("terminated")));
                Ok(())
            })
        }
    }

    #[derive(Default)]
    struct CollectWarnings(StdMutex<Vec<String>>);

    impl WarningSink for CollectWarnings {
        fn emit(&self, message: String) {
            self.0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(message);
        }
    }

    #[derive(Default)]
    struct CollectNotifications(StdMutex<Vec<(String, Value)>>);

    impl WarningSink for CollectNotifications {
        fn emit(&self, _message: String) {}

        fn handle_notification(
            &self,
            _client: Arc<RpcClient>,
            _connection_generation: u64,
            method: String,
            params: Value,
        ) -> ServerFuture<'_, NotificationHandling> {
            Box::pin(async move {
                self.0
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .push((method, params));
                NotificationHandling::Continue
            })
        }
    }

    async fn wait_for_spawns(spawner: &FakeSpawner, expected: usize) -> Result<(), String> {
        tokio::time::timeout(Duration::from_secs(1), async {
            while spawner.spawn_count() < expected {
                tokio::task::yield_now().await;
            }
        })
        .await
        .map_err(|_| format!("timed out waiting for {expected} fake spawns"))
    }

    #[tokio::test]
    async fn shutdown_latch_permanently_rejects_new_app_server_requests(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let state = CodexAppServerState::default();
        assert!(state.ensure_accepting_requests().is_ok());

        state.shutdown().await?;

        let error = state
            .ensure_accepting_requests()
            .expect_err("shutdown state must never lazily restart");
        assert!(error.contains("shutting down"));
        assert!(state.inner.lock().await.is_none());
        Ok(())
    }

    #[test]
    fn account_and_models_only_matching_login_completion_consumes_the_active_login() {
        let state = CodexAppServerState::default();
        state.remember_active_login("login-7".to_string());

        assert!(!state.take_matching_active_login(Some("login-other")));
        assert_eq!(state.active_login_id().as_deref(), Some("login-7"));
        assert!(state.take_matching_active_login(Some("login-7")));
        assert_eq!(state.active_login_id(), None);
        assert!(!state.take_matching_active_login(None));
    }

    #[test]
    fn account_and_models_early_completion_is_consumed_after_login_response() {
        let state = CodexAppServerState::default();
        let attempt = state.begin_login_attempt();

        assert_eq!(
            classify_account_notification(
                &state.account_events,
                "account/login/completed",
                json!({"loginId":"login-early","success":true,"error":null}),
            )
            .expect("valid early completion"),
            AccountNotificationAction::Ignore
        );

        let completion = state
            .finish_login_attempt(attempt, "login-early".into())
            .expect("same-transport response")
            .expect("early completion must be retained");
        assert_eq!(completion.warning, None);
        assert!(state.is_login_attempt_current(completion.token));
        state.begin_login_attempt();
        assert!(!state.is_login_attempt_current(completion.token));
        assert_eq!(state.active_login_id(), None);
    }

    #[test]
    fn account_and_models_null_login_id_completion_refreshes_active_login() {
        let state = CodexAppServerState::default();
        state.remember_active_login("login-active".to_string());

        let action = classify_account_notification(
            &state.account_events,
            "account/login/completed",
            json!({"loginId":null,"success":true,"error":null}),
        )
        .expect("null loginId completion is valid");

        match action {
            AccountNotificationAction::Refresh { warning, .. } => assert_eq!(warning, None),
            other => panic!("expected Refresh, got {other:?}"),
        }
        assert_eq!(state.active_login_id(), None);
    }

    #[test]
    fn account_and_models_null_login_id_early_completion_is_consumed_after_login_response() {
        let state = CodexAppServerState::default();
        let attempt = state.begin_login_attempt();

        assert_eq!(
            classify_account_notification(
                &state.account_events,
                "account/login/completed",
                json!({"loginId":null,"success":true,"error":null}),
            )
            .expect("valid null early completion"),
            AccountNotificationAction::Ignore
        );

        let completion = state
            .finish_login_attempt(attempt, "login-from-start".into())
            .expect("same-transport response")
            .expect("null-id early completion must match the pending attempt");
        assert_eq!(completion.warning, None);
        assert_eq!(state.active_login_id(), None);
    }

    #[test]
    fn account_and_models_exact_login_id_beats_null_early_completion() {
        let state = CodexAppServerState::default();
        let attempt = state.begin_login_attempt();

        assert_eq!(
            classify_account_notification(
                &state.account_events,
                "account/login/completed",
                json!({"loginId":null,"success":false,"error":"stale"}),
            )
            .expect("null completion"),
            AccountNotificationAction::Ignore
        );
        assert_eq!(
            classify_account_notification(
                &state.account_events,
                "account/login/completed",
                json!({"loginId":"login-exact","success":true,"error":null}),
            )
            .expect("exact completion"),
            AccountNotificationAction::Ignore
        );

        let completion = state
            .finish_login_attempt(attempt, "login-exact".into())
            .expect("same-transport response")
            .expect("exact match must win");
        assert_eq!(completion.warning, None);
    }

    #[test]
    fn account_and_models_null_login_id_failed_completion_warns_for_active_login() {
        let state = CodexAppServerState::default();
        state.remember_active_login("login-active".to_string());

        let action = classify_account_notification(
            &state.account_events,
            "account/login/completed",
            json!({"loginId":null,"success":false,"error":"device denied"}),
        )
        .expect("null loginId failure is valid");

        match action {
            AccountNotificationAction::Refresh { warning, .. } => {
                assert_eq!(
                    warning.as_deref(),
                    Some("Codex login failed: device denied")
                );
            }
            other => panic!("expected Refresh, got {other:?}"),
        }
    }

    #[test]
    fn account_and_models_transport_reset_invalidates_inflight_login_response() {
        let state = CodexAppServerState::default();
        let attempt = state.begin_login_attempt();

        state.reset_account_transport();

        let error = state
            .finish_login_attempt(attempt, "stale-login".into())
            .expect_err("a response from the failed transport must stay stale");
        assert!(error.contains("connection restarted"));
        assert_eq!(state.active_login_id(), None);
    }

    #[test]
    fn account_and_models_newer_login_attempt_supersedes_an_older_response() {
        let state = CodexAppServerState::default();
        let older = state.begin_login_attempt();
        let newer = state.begin_login_attempt();

        assert!(state
            .finish_login_attempt(older, "older-login".into())
            .is_err());
        assert_eq!(state.active_login_id(), None);
        assert!(state
            .finish_login_attempt(newer, "newer-login".into())
            .expect("newest response")
            .is_none());
        assert_eq!(state.active_login_id().as_deref(), Some("newer-login"));
    }

    #[test]
    fn account_and_models_api_key_attempt_supersedes_old_interactive_login() {
        let state = CodexAppServerState::default();
        state.remember_active_login("old-browser".into());

        let api_key_attempt = state.begin_login_attempt();
        assert_eq!(state.active_login_id(), None);
        assert_eq!(
            classify_account_notification(
                &state.account_events,
                "account/login/completed",
                json!({"loginId":"old-browser","success":true,"error":null}),
            )
            .expect("old completion is valid but stale"),
            AccountNotificationAction::Ignore
        );
        state
            .finish_login_attempt_without_id(api_key_attempt)
            .expect("current API-key attempt");
        assert_eq!(state.active_login_id(), None);
    }

    #[test]
    fn account_and_models_new_login_invalidates_reserved_notification_refreshes() {
        let state = CodexAppServerState::default();
        state.remember_active_login("old-login".into());
        let action = classify_account_notification(
            &state.account_events,
            "account/login/completed",
            json!({"loginId":"old-login","success":false,"error":"old failure"}),
        )
        .expect("valid old completion");
        let AccountNotificationAction::Refresh { sequence, .. } = action else {
            panic!("matching completion must reserve a refresh");
        };

        state.begin_login_attempt();

        assert_ne!(
            state.account_events.sequence.load(Ordering::Acquire),
            sequence,
            "the old warning/account refresh must be stale before it can emit"
        );
    }

    #[test]
    fn account_and_models_notification_classifier_refreshes_only_the_active_login() {
        let state = CodexAppServerState::default();
        state.remember_active_login("login-7".to_string());

        let unmatched = classify_account_notification(
            &state.account_events,
            "account/login/completed",
            json!({"loginId":"login-other","success":true,"error":null}),
        )
        .expect("valid unmatched notification");
        assert_eq!(unmatched, AccountNotificationAction::Ignore);
        assert_eq!(state.active_login_id().as_deref(), Some("login-7"));

        let matched = classify_account_notification(
            &state.account_events,
            "account/login/completed",
            json!({"loginId":"login-7","success":true,"error":null}),
        )
        .expect("valid matching notification");
        assert!(matches!(
            matched,
            AccountNotificationAction::Refresh { warning: None, .. }
        ));
        assert_eq!(state.active_login_id(), None);
    }

    #[test]
    fn account_and_models_notification_classifier_sanitizes_failures_and_updates() {
        let state = CodexAppServerState::default();
        state.remember_active_login("login-8".to_string());

        let failed = classify_account_notification(
            &state.account_events,
            "account/login/completed",
            json!({
                "loginId":"login-8",
                "success":false,
                "error":"Authorization: Bearer notification-secret"
            }),
        )
        .expect("valid failed notification");
        let AccountNotificationAction::Refresh {
            warning: Some(warning),
            ..
        } = failed
        else {
            panic!("failed matching login must refresh with a warning");
        };
        assert!(!warning.contains("notification-secret"));

        state.remember_active_login("login-still-active".to_string());
        assert!(matches!(
            classify_account_notification(
                &state.account_events,
                "account/updated",
                json!({"authMode":"chatgpt","planType":"plus"}),
            )
            .expect("valid account update"),
            AccountNotificationAction::Refresh { warning: None, .. }
        ));
        assert_eq!(
            state.active_login_id().as_deref(),
            Some("login-still-active")
        );
    }

    #[test]
    fn account_and_models_notification_classifier_rejects_malformed_account_frames() {
        let state = CodexAppServerState::default();
        let error = classify_account_notification(
            &state.account_events,
            "account/login/completed",
            json!({"loginId":7,"success":"yes"}),
        )
        .expect_err("malformed account notification must not be accepted");
        assert!(error.contains("account/login/completed"));

        assert_eq!(
            classify_account_notification(
                &state.account_events,
                "thread/started",
                json!({"thread": {"id":"thread-1"}}),
            )
            .expect("unrelated notification"),
            AccountNotificationAction::Ignore
        );
    }

    #[tokio::test]
    async fn shutdown_sets_the_latch_before_waiting_for_startup_to_finish(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let state = Arc::new(CodexAppServerState::default());
        let startup_guard = state.startup.lock().await;
        let shutdown_state = state.clone();
        let shutdown = tokio::spawn(async move { shutdown_state.shutdown().await });

        tokio::time::timeout(Duration::from_millis(100), async {
            while state.ensure_accepting_requests().is_ok() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .map_err(|_| "shutdown did not set its latch before waiting for startup")?;
        assert!(
            !shutdown.is_finished(),
            "shutdown must serialize with an in-progress startup"
        );

        drop(startup_guard);
        tokio::time::timeout(Duration::from_millis(100), shutdown)
            .await
            .map_err(|_| "shutdown did not resume after startup completed")???;
        Ok(())
    }

    #[tokio::test]
    async fn a_server_that_finishes_starting_after_shutdown_is_torn_down_not_installed(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let state = CodexAppServerState::default();
        state.shutdown().await?;
        let spawner = Arc::new(FakeSpawner::new([FakeBehavior::Serve]));
        let server = start_supervisor(
            spawner,
            "1.3.0".into(),
            Arc::new(CollectWarnings::default()),
            Duration::from_millis(200),
            Duration::from_millis(200),
        )
        .await?;

        let error = match state.install_started_server(server).await {
            Ok(_) => return Err("a late startup must not overwrite the shutdown latch".into()),
            Err(error) => error,
        };
        assert!(error.contains("shutting down"));
        assert!(state.inner.lock().await.is_none());
        Ok(())
    }

    #[tokio::test]
    async fn queued_shutdown_wins_over_a_simultaneous_stdout_failure(
    ) -> Result<(), Box<dyn std::error::Error>> {
        for _ in 0..64 {
            let spawner = Arc::new(ImmediateEofSpawner::default());
            let warnings = Arc::new(CollectWarnings::default());
            let diagnostics = Arc::new(StdMutex::new(RecentDiagnostics::default()));
            let terminal_error = Arc::new(StdMutex::new(None));
            let (_request_tx, request_rx) = mpsc::channel(1);
            let (shutdowns, shutdown_commands) = mpsc::channel(1);
            let (shutdown_tx, shutdown_rx) = oneshot::channel();
            shutdowns.send(shutdown_tx).await?;
            let (ready_tx, ready_rx) = oneshot::channel();

            let task = tokio::spawn(run_supervisor(
                spawner.clone(),
                "1.3.0".into(),
                warnings,
                Duration::from_millis(200),
                Duration::from_millis(200),
                request_rx,
                shutdown_commands,
                ready_tx,
                diagnostics,
                terminal_error,
            ));

            ready_rx.await??;
            shutdown_rx.await??;
            task.await?;
            assert_eq!(spawner.spawn_count(), 1);
        }
        Ok(())
    }

    #[tokio::test]
    async fn initialized_is_written_only_after_initialize_succeeds(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let rejected = Arc::new(FakeSpawner::new([FakeBehavior::RejectInitialize]));
        let warnings = Arc::new(CollectWarnings::default());
        let result = start_supervisor(
            rejected.clone(),
            "1.3.0".into(),
            warnings,
            Duration::from_millis(200),
            Duration::from_millis(200),
        )
        .await;

        assert!(result.is_err());
        let transcript = rejected.transcript(0);
        assert_eq!(transcript.len(), 1);
        assert_eq!(transcript[0]["method"], "initialize");
        assert_eq!(
            transcript[0]["params"],
            json!({
                "clientInfo": {
                    "name":"local-prism",
                    "title":"LocalPrism",
                    "version":"1.3.0"
                },
                "capabilities":{"experimentalApi":true}
            })
        );
        Ok(())
    }

    #[tokio::test]
    async fn hanging_initialize_uses_the_short_startup_deadline_not_request_timeout(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let spawner = Arc::new(FakeSpawner::new([FakeBehavior::HangInitialize]));
        let warnings = Arc::new(CollectWarnings::default());
        let result = tokio::time::timeout(
            Duration::from_millis(250),
            start_supervisor(
                spawner.clone(),
                "1.3.0".into(),
                warnings,
                Duration::from_millis(30),
                Duration::from_secs(60),
            ),
        )
        .await
        .map_err(|_| "initialize incorrectly waited for the 60-second request timeout")?;

        let error = match result {
            Ok(_) => return Err("hanging initialize unexpectedly started".into()),
            Err(error) => error,
        };
        assert!(error.contains("timed out"));
        assert_eq!(spawner.spawn_count(), 1);
        Ok(())
    }

    #[tokio::test]
    async fn shutdown_kills_the_child_before_poisoning_a_backpressured_writer(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let spawner = Arc::new(FakeSpawner::new([
            FakeBehavior::StopReadingAfterInitialized,
        ]));
        let warnings = Arc::new(CollectWarnings::default());
        let server = start_supervisor(
            spawner,
            "1.3.0".into(),
            warnings,
            Duration::from_millis(200),
            Duration::from_secs(60),
        )
        .await?;
        let request_handle = server.handle.clone();
        let request = tokio::spawn(async move {
            request_handle
                .request("turn/start", json!({"payload": "x".repeat(1024 * 1024)}))
                .await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;

        tokio::time::timeout(Duration::from_millis(250), server.shutdown())
            .await
            .map_err(|_| {
                "shutdown waited on the backpressured writer before killing the child"
            })??;
        let request_result = tokio::time::timeout(Duration::from_millis(100), request)
            .await
            .map_err(|_| "backpressured request survived shutdown")??;
        assert!(request_result.is_err());
        Ok(())
    }

    #[tokio::test]
    async fn unexpected_exit_restarts_and_reinitializes_exactly_once(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let spawner = Arc::new(FakeSpawner::new([
            FakeBehavior::CrashAfterInitialized,
            FakeBehavior::Serve,
        ]));
        let warnings = Arc::new(CollectWarnings::default());
        let server = start_supervisor(
            spawner.clone(),
            "1.3.0".into(),
            warnings,
            Duration::from_millis(200),
            Duration::from_millis(200),
        )
        .await?;

        wait_for_spawns(&spawner, 2).await?;
        let response = server.request("account/read", json!({})).await?;
        assert_eq!(response["requiresOpenaiAuth"], true);
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(spawner.spawn_count(), 2);
        assert_eq!(
            spawner.transcript(0)[1],
            json!({"method":"initialized","params":{}})
        );
        assert_eq!(spawner.transcript(1)[0]["method"], "initialize");
        assert_eq!(
            spawner.transcript(1)[1],
            json!({"method":"initialized","params":{}})
        );

        server.shutdown().await?;
        Ok(())
    }

    #[tokio::test]
    async fn closed_stdout_restarts_even_when_the_child_stays_alive(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let spawner = Arc::new(FakeSpawner::new([
            FakeBehavior::CloseStdoutAfterInitialized,
            FakeBehavior::Serve,
        ]));
        let warnings = Arc::new(CollectWarnings::default());
        let server = start_supervisor(
            spawner.clone(),
            "1.3.0".into(),
            warnings,
            Duration::from_millis(200),
            Duration::from_millis(200),
        )
        .await?;

        wait_for_spawns(&spawner, 2).await?;
        let response = server.request("account/read", json!({})).await?;
        assert_eq!(response["requiresOpenaiAuth"], true);
        assert_eq!(spawner.spawn_count(), 2);

        server.shutdown().await?;
        Ok(())
    }

    #[tokio::test]
    async fn stdin_backpressure_restarts_even_when_process_and_stdout_stay_alive(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let spawner = Arc::new(FakeSpawner::new([
            FakeBehavior::StopReadingAfterInitialized,
            FakeBehavior::Serve,
        ]));
        let warnings = Arc::new(CollectWarnings::default());
        let server = start_supervisor(
            spawner.clone(),
            "1.3.0".into(),
            warnings,
            Duration::from_millis(200),
            Duration::from_millis(20),
        )
        .await?;

        let first = server
            .request("turn/start", json!({"payload":"x".repeat(1024 * 1024)}))
            .await;
        assert!(first.is_err());
        wait_for_spawns(&spawner, 2).await?;
        let response = server.request("account/read", json!({})).await?;
        assert_eq!(response["requiresOpenaiAuth"], true);
        assert_eq!(spawner.spawn_count(), 2);

        server.shutdown().await?;
        Ok(())
    }

    #[tokio::test]
    async fn second_stdin_transport_failure_is_terminal_without_a_third_spawn(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let spawner = Arc::new(FakeSpawner::new([
            FakeBehavior::StopReadingAfterInitialized,
            FakeBehavior::StopReadingAfterInitialized,
        ]));
        let warnings = Arc::new(CollectWarnings::default());
        let server = start_supervisor(
            spawner.clone(),
            "1.3.0".into(),
            warnings,
            Duration::from_millis(200),
            Duration::from_millis(20),
        )
        .await?;

        assert!(server
            .request("turn/start", json!({"payload":"x".repeat(1024 * 1024)}))
            .await
            .is_err());
        wait_for_spawns(&spawner, 2).await?;
        assert!(server
            .request("turn/start", json!({"payload":"y".repeat(1024 * 1024)}))
            .await
            .is_err());
        tokio::time::timeout(Duration::from_secs(1), async {
            while server.handle.terminal_error().is_none() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .map_err(|_| "second stdin failure did not become terminal")?;
        assert_eq!(spawner.spawn_count(), 2);
        let terminal = server
            .request("account/read", json!({}))
            .await
            .expect_err("terminal supervisor returned false success");
        assert!(terminal.contains("restart is exhausted"));

        server.shutdown().await?;
        Ok(())
    }

    #[tokio::test]
    async fn second_crash_fails_inflight_requests_without_false_success_or_third_spawn(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let spawner = Arc::new(FakeSpawner::new([
            FakeBehavior::CrashOnRequest,
            FakeBehavior::CrashOnRequest,
        ]));
        let warnings = Arc::new(CollectWarnings::default());
        let server = start_supervisor(
            spawner.clone(),
            "1.3.0".into(),
            warnings,
            Duration::from_millis(200),
            Duration::from_millis(500),
        )
        .await?;

        let first = server.request("turn/start", json!({})).await;
        assert!(first.is_err());
        wait_for_spawns(&spawner, 2).await?;
        let second = server.request("turn/start", json!({})).await;
        assert!(second.is_err());
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(spawner.spawn_count(), 2);

        let terminal = server
            .request("account/read", json!({}))
            .await
            .err()
            .ok_or("terminal supervisor unexpectedly returned success")?;
        assert!(terminal.contains("exited twice"));
        assert!(!terminal.contains("sk-test-secret"));
        assert!(terminal.len() <= 66 * 1024);

        server.shutdown().await?;
        Ok(())
    }

    #[tokio::test]
    async fn approval_requests_are_accepted_and_unknown_requests_receive_method_not_found(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let (client_io, server_io) = duplex(4096);
        let (client_read, client_write) = tokio::io::split(client_io);
        let (server_read, mut server_write) = tokio::io::split(server_io);
        let client = Arc::new(RpcClient::new(client_write));
        let (inbound_tx, inbound_rx) = mpsc::channel::<RpcInbound>(16);
        let warnings = Arc::new(CollectWarnings::default());
        let reader = tokio::spawn(client.clone().read_loop(client_read, inbound_tx));
        let handler = tokio::spawn(handle_inbound(client, inbound_rx, warnings.clone(), 0));
        let mut responses = BufReader::new(server_read).lines();
        let malicious_method = format!(
            "future/request\nAuthorization: Bearer warning-secret {}",
            "x".repeat(2 * 1024)
        );

        server_write
            .write_all(b"{\"id\":\"cmd-1\",\"method\":\"item/commandExecution/requestApproval\",\"params\":{}}\n")
            .await?;
        server_write
            .write_all(b"{\"id\":2,\"method\":\"item/fileChange/requestApproval\",\"params\":{}}\n")
            .await?;
        server_write
            .write_all(b"{\"id\":4,\"method\":\"item/permissions/requestApproval\",\"params\":{\"permissions\":{\"network\":true}}}\n")
            .await?;
        server_write
            .write_all(
                format!(
                    "{}\n",
                    json!({"id": 3, "method": malicious_method, "params": {}})
                )
                .as_bytes(),
            )
            .await?;

        let command: Value = serde_json::from_str(
            &responses
                .next_line()
                .await?
                .ok_or("command response missing")?,
        )?;
        let file: Value = serde_json::from_str(
            &responses
                .next_line()
                .await?
                .ok_or("file response missing")?,
        )?;
        let permissions: Value = serde_json::from_str(
            &responses
                .next_line()
                .await?
                .ok_or("permissions response missing")?,
        )?;
        let unknown: Value = serde_json::from_str(
            &responses
                .next_line()
                .await?
                .ok_or("unknown response missing")?,
        )?;
        assert_eq!(
            command,
            json!({"id":"cmd-1","result":{"decision":"accept"}})
        );
        assert_eq!(file, json!({"id":2,"result":{"decision":"accept"}}));
        assert_eq!(
            permissions,
            json!({
                "id": 4,
                "result": {
                    "permissions": { "network": true },
                    "scope": "turn"
                }
            })
        );
        assert_eq!(unknown["id"], 3);
        assert_eq!(unknown["error"]["code"], -32601);
        let warning_messages = warnings
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let warning = warning_messages
            .iter()
            .find(|message| message.contains("future/request"))
            .ok_or("unknown request warning missing")?;
        assert!(!warning.contains("warning-secret"));
        assert!(!warning.contains(['\r', '\n']));
        assert!(warning.len() <= 512);

        reader.abort();
        handler.abort();
        Ok(())
    }

    #[tokio::test]
    async fn account_and_models_forwards_account_notifications_instead_of_dropping_them(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let (client_io, mut server_io) = duplex(4096);
        let (client_read, client_write) = tokio::io::split(client_io);
        let client = Arc::new(RpcClient::new(client_write));
        let (inbound_tx, inbound_rx) = mpsc::channel::<RpcInbound>(16);
        let notifications = Arc::new(CollectNotifications::default());
        let reader = tokio::spawn(client.clone().read_loop(client_read, inbound_tx));
        let handler = tokio::spawn(handle_inbound(client, inbound_rx, notifications.clone(), 0));

        server_io
            .write_all(
                b"{\"method\":\"account/login/completed\",\"params\":{\"loginId\":\"login-7\",\"success\":true,\"error\":null}}\n",
            )
            .await?;

        tokio::time::timeout(Duration::from_millis(100), async {
            loop {
                if !notifications
                    .0
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .is_empty()
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .map_err(|_| "account notification was dropped")?;

        let captured = notifications
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].0, "account/login/completed");
        assert_eq!(captured[0].1["loginId"], "login-7");

        reader.abort();
        handler.abort();
        Ok(())
    }

    #[test]
    fn recent_stderr_is_bounded_and_redacted_before_exposure() {
        let mut diagnostics = RecentDiagnostics::default();
        diagnostics.append(&vec![b'x'; 70 * 1024]);
        diagnostics.append(b" sk-test-secret-1234567890abcdefgh");

        let exposed = diagnostics.snapshot();
        assert!(exposed.len() <= 64 * 1024);
        assert!(!exposed.contains("sk-test-secret"));
    }

    #[test]
    fn truncated_stderr_discards_a_partial_first_line_before_redaction() {
        let secret = b"sk-super-secret-value\n";
        let mut content = secret.to_vec();
        content.extend(vec![b'x'; STDERR_LIMIT + 5 - secret.len()]);
        let mut diagnostics = RecentDiagnostics::default();
        diagnostics.append(&content);

        let exposed = diagnostics.snapshot();
        assert!(!exposed.contains("secret-value"));
        assert!(exposed.bytes().all(|byte| byte == b'x'));
    }
}
