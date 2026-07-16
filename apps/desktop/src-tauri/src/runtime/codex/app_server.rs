use super::discovery::{
    attach_process_tree, discover_codex_binary, isolate_process_tree, terminate_process_tree,
    ProcessTreeGuard,
};
use super::protocol::InitializeParams;
use super::rpc::{RpcClient, RpcInbound};
use super::sanitize_install_output;
use crate::runtime::RuntimeKind;
use serde_json::Value;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tauri::Emitter;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, watch, Mutex};
use tokio::task::JoinHandle;

const STDERR_LIMIT: usize = 64 * 1024;
const DEFAULT_STARTUP_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const READER_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);
const PROCESS_REAP_TIMEOUT: Duration = Duration::from_secs(2);
const WARNING_EVENT: &str = "runtime-warning";
const WARNING_METHOD_LIMIT: usize = 256;
const INBOUND_QUEUE_CAPACITY: usize = 32;

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

trait WarningSink: Send + Sync {
    fn emit(&self, message: String);
}

#[derive(Clone)]
struct TauriWarningSink {
    app: tauri::AppHandle,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeWarningPayload {
    runtime: RuntimeKind,
    message: String,
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
}

async fn handle_inbound(
    client: Arc<RpcClient>,
    mut inbound: mpsc::Receiver<RpcInbound>,
    warnings: Arc<dyn WarningSink>,
) {
    while let Some(message) = inbound.recv().await {
        match message {
            RpcInbound::Notification { .. } => {}
            RpcInbound::ServerRequest { id, method, .. }
                if matches!(
                    method.as_str(),
                    "item/commandExecution/requestApproval" | "item/fileChange/requestApproval"
                ) =>
            {
                if let Err(error) = client
                    .respond(id, serde_json::json!({"decision": "decline"}))
                    .await
                {
                    warnings.emit(format!(
                        "Failed to decline Codex approval request safely: {error}"
                    ));
                }
            }
            RpcInbound::ServerRequest { id, method, .. } => {
                let safe_method = safe_warning_method(&method);
                if let Err(error) = client.respond_error(id, -32601, "Method not found").await {
                    warnings.emit(format!(
                        "Unsupported Codex server request `{safe_method}` could not be answered: {error}"
                    ));
                } else {
                    warnings.emit(format!(
                        "Unsupported Codex server request `{safe_method}` was rejected. Update Codex or ClaudePrism if this request is required."
                    ));
                }
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
    let inbound_task = tokio::spawn(handle_inbound(client.clone(), inbound_rx, warnings));

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
            Ok(restarted) => running = restarted,
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

#[derive(Default)]
pub struct CodexAppServerState {
    inner: Mutex<Option<CodexAppServer>>,
    startup: Mutex<()>,
    shutting_down: AtomicBool,
}

impl CodexAppServerState {
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
        if let Some(handle) = self
            .inner
            .lock()
            .await
            .as_ref()
            .map(|server| server.handle.clone())
        {
            self.ensure_accepting_requests()?;
            return handle.request(method, params).await;
        }

        let deadline = tokio::time::Instant::now() + DEFAULT_STARTUP_TIMEOUT;
        let startup_guard = tokio::time::timeout_at(deadline, self.startup.lock())
            .await
            .map_err(|_| "Codex app-server startup timed out".to_string())?;
        self.ensure_accepting_requests()?;

        let handle = if let Some(handle) = self
            .inner
            .lock()
            .await
            .as_ref()
            .map(|server| server.handle.clone())
        {
            handle
        } else {
            let binary = tokio::time::timeout_at(deadline, discover_codex_binary())
                .await
                .map_err(|_| "Codex app-server startup timed out during discovery".to_string())??;
            self.ensure_accepting_requests()?;
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err("Codex app-server startup timed out".into());
            }
            let spawner = Arc::new(ProcessSpawner::new(binary.path));
            let warnings = Arc::new(TauriWarningSink { app: app.clone() });
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
        handle_inbound, run_supervisor, start_supervisor, AppServerProcess, AppServerSpawner,
        CodexAppServerState, ProcessExit, RecentDiagnostics, ServerFuture, WarningSink,
        STDERR_LIMIT,
    };
    use crate::runtime::codex::rpc::{RpcClient, RpcInbound};
    use serde_json::{json, Value};
    use std::collections::VecDeque;
    use std::io;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::Duration;
    use tokio::io::{duplex, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
    use tokio::sync::{mpsc, oneshot, watch};

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
                    "name":"claude-prism",
                    "title":"ClaudePrism",
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
    async fn approval_requests_are_declined_and_unknown_requests_receive_method_not_found(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let (client_io, server_io) = duplex(4096);
        let (client_read, client_write) = tokio::io::split(client_io);
        let (server_read, mut server_write) = tokio::io::split(server_io);
        let client = Arc::new(RpcClient::new(client_write));
        let (inbound_tx, inbound_rx) = mpsc::channel::<RpcInbound>(16);
        let warnings = Arc::new(CollectWarnings::default());
        let reader = tokio::spawn(client.clone().read_loop(client_read, inbound_tx));
        let handler = tokio::spawn(handle_inbound(client, inbound_rx, warnings.clone()));
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
        let unknown: Value = serde_json::from_str(
            &responses
                .next_line()
                .await?
                .ok_or("unknown response missing")?,
        )?;
        assert_eq!(
            command,
            json!({"id":"cmd-1","result":{"decision":"decline"}})
        );
        assert_eq!(file, json!({"id":2,"result":{"decision":"decline"}}));
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
