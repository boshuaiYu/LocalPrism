use serde::{Deserialize, Serialize};
use std::future::Future;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager, State, WebviewWindow};

use codex::discovery::CodexBinary;

pub mod claude;
pub mod codex;
pub mod events;
pub mod process;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeKind {
    Claude,
    Codex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeInterruptMode {
    Terminate,
    Interrupt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeLoginMode {
    Browser,
    DeviceCode,
    ApiKey,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum RuntimeLoginStartResult {
    #[serde(rename = "apiKey")]
    ApiKey,
    #[serde(rename = "chatgpt")]
    Chatgpt {
        #[serde(rename = "authUrl")]
        auth_url: String,
        #[serde(rename = "loginId")]
        login_id: String,
    },
    #[serde(rename = "chatgptDeviceCode")]
    ChatgptDeviceCode {
        #[serde(rename = "verificationUrl")]
        verification_url: String,
        #[serde(rename = "userCode")]
        user_code: String,
        #[serde(rename = "loginId")]
        login_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCapabilities {
    pub models: bool,
    pub skills: bool,
    pub custom_agents: bool,
    pub subagents: bool,
    pub approvals: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeAccount {
    pub runtime: RuntimeKind,
    pub installed: bool,
    pub authenticated: bool,
    pub version: Option<String>,
    pub account_label: Option<String>,
    pub auth_mode: Option<String>,
    pub capabilities: RuntimeCapabilities,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeModel {
    pub runtime: RuntimeKind,
    pub id: String,
    pub display_name: String,
    pub description: Option<String>,
    pub reasoning_efforts: Vec<String>,
    pub default_reasoning_effort: Option<String>,
    pub input_modalities: Vec<String>,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConversation {
    pub reference: ConversationRef,
    pub title: String,
    pub status: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConversationHistory {
    pub reference: ConversationRef,
    pub items: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRef {
    pub runtime: RuntimeKind,
    pub session_id: String,
    pub project_path: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeTurnRequest {
    pub runtime: RuntimeKind,
    pub project_path: String,
    pub tab_id: String,
    pub attempt_id: String,
    pub session_id: Option<String>,
    pub prompt: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub agent_id: Option<String>,
    pub provider_credential_id: Option<String>,
    pub provider_model_override: Option<String>,
}

fn validate_runtime_turn_identity(request: &RuntimeTurnRequest) -> Result<(), String> {
    for (name, value) in [
        ("tab ID", request.tab_id.as_str()),
        ("attempt ID", request.attempt_id.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(format!("Runtime turn {name} must not be empty"));
        }
    }
    Ok(())
}

fn validate_runtime_turn_request(request: &RuntimeTurnRequest) -> Result<(), String> {
    validate_runtime_turn_identity(request)?;
    for (name, value) in [
        ("project path", request.project_path.as_str()),
        ("prompt", request.prompt.as_str()),
        ("model", request.model.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(format!("Runtime turn {name} must not be empty"));
        }
    }

    for (name, value) in [
        ("session ID", request.session_id.as_deref()),
        ("reasoning effort", request.reasoning_effort.as_deref()),
        ("agent ID", request.agent_id.as_deref()),
        (
            "provider credential ID",
            request.provider_credential_id.as_deref(),
        ),
        (
            "provider model override",
            request.provider_model_override.as_deref(),
        ),
    ] {
        if value.is_some_and(|value| value.trim().is_empty()) {
            return Err(format!("Runtime turn {name} must not be blank"));
        }
    }

    if request.runtime == RuntimeKind::Codex
        && (request.provider_credential_id.is_some() || request.provider_model_override.is_some())
    {
        return Err("Claude provider settings cannot be sent to the Codex runtime".into());
    }

    Ok(())
}

fn codex_thread_to_conversation(
    thread: codex::protocol::Thread,
    project_path: String,
) -> RuntimeConversation {
    let title = if thread.preview.trim().is_empty() {
        "Untitled conversation".to_string()
    } else {
        thread.preview.clone()
    };
    let status = thread.status_name().to_owned();
    RuntimeConversation {
        reference: ConversationRef {
            runtime: RuntimeKind::Codex,
            session_id: thread.id,
            project_path,
        },
        title,
        status,
        updated_at: thread.updated_at,
    }
}

fn codex_thread_to_history(
    thread: codex::protocol::Thread,
    reference: ConversationRef,
) -> Result<RuntimeConversationHistory, String> {
    validate_codex_thread_reference(&thread, &reference)?;
    Ok(RuntimeConversationHistory {
        reference,
        items: thread
            .turns
            .into_iter()
            .flat_map(|turn| turn.items)
            .collect(),
    })
}

fn lexically_normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() && !path.is_absolute() {
                    normalized.push(component.as_os_str());
                }
            }
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
        }
    }
    normalized
}

fn normalized_project_path(path: &str) -> Result<String, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("A runtime conversation project path must not be empty".into());
    }
    let path = PathBuf::from(path);
    let absolute = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .map_err(|error| format!("Failed to resolve the project path: {error}"))?
            .join(path)
    };
    let normalized =
        std::fs::canonicalize(&absolute).unwrap_or_else(|_| lexically_normalize_path(&absolute));
    let comparable = normalized.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    let comparable = comparable.to_ascii_lowercase();
    Ok(comparable.trim_end_matches('/').to_owned())
}

fn validate_codex_thread_reference(
    thread: &codex::protocol::Thread,
    reference: &ConversationRef,
) -> Result<(), String> {
    if reference.runtime != RuntimeKind::Codex || thread.id != reference.session_id {
        return Err("Codex thread response did not match the requested conversation".into());
    }
    if normalized_project_path(&thread.cwd)? != normalized_project_path(&reference.project_path)? {
        return Err("Codex thread belongs to a different project".into());
    }
    Ok(())
}

fn validate_codex_runtime_turn_thread(
    thread: &codex::protocol::Thread,
    request: &RuntimeTurnRequest,
) -> Result<(), String> {
    validate_codex_thread_reference(
        thread,
        &ConversationRef {
            runtime: request.runtime,
            session_id: request
                .session_id
                .clone()
                .unwrap_or_else(|| thread.id.clone()),
            project_path: request.project_path.clone(),
        },
    )
}

fn codex_account_from_binary(binary: Option<&CodexBinary>) -> RuntimeAccount {
    RuntimeAccount {
        runtime: RuntimeKind::Codex,
        installed: binary.is_some(),
        authenticated: false,
        version: binary.map(|binary| binary.version.clone()),
        account_label: None,
        auth_mode: None,
        capabilities: RuntimeCapabilities {
            models: true,
            skills: true,
            custom_agents: true,
            subagents: true,
            approvals: true,
        },
        error: None,
    }
}

fn codex_account_with_error(binary: &CodexBinary, error: String) -> RuntimeAccount {
    let mut account = codex_account_from_binary(Some(binary));
    account.error = Some(error);
    account
}

fn normalize_codex_login(
    runtime: RuntimeKind,
    mode: RuntimeLoginMode,
    api_key: Option<String>,
) -> Result<Option<String>, String> {
    if runtime != RuntimeKind::Codex {
        return Err("This login command is only available for the Codex runtime".into());
    }
    match mode {
        RuntimeLoginMode::ApiKey => {
            let api_key = api_key
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "An API key is required for Codex API-key login".to_string())?;
            Ok(Some(api_key))
        }
        RuntimeLoginMode::Browser | RuntimeLoginMode::DeviceCode => {
            if api_key.is_some() {
                return Err("API keys are accepted only for Codex API-key login".into());
            }
            Ok(None)
        }
    }
}

#[tauri::command]
pub async fn runtime_status(
    runtime: RuntimeKind,
    app: AppHandle,
    codex_state: State<'_, codex::CodexAppServerState>,
) -> Result<RuntimeAccount, String> {
    match runtime {
        RuntimeKind::Claude => crate::claude::check_claude_status()
            .await
            .map(claude::account_from_status),
        RuntimeKind::Codex => {
            let binary = codex::discovery::discover_codex_binary().await.ok();
            let Some(binary) = binary else {
                return Ok(codex_account_from_binary(None));
            };
            match codex::read_account(&app, &codex_state, binary.version.clone()).await {
                Ok(account) => Ok(account),
                Err(error) => Ok(codex_account_with_error(&binary, error)),
            }
        }
    }
}

#[tauri::command]
pub async fn runtime_install(
    runtime: RuntimeKind,
    window: WebviewWindow,
    app: AppHandle,
    codex_state: State<'_, codex::CodexAppServerState>,
) -> Result<bool, String> {
    match runtime {
        RuntimeKind::Claude => crate::claude::install_claude_cli(window).await,
        RuntimeKind::Codex => codex::install(app, &codex_state).await,
    }
}

#[tauri::command]
pub async fn runtime_login_start(
    runtime: RuntimeKind,
    mode: RuntimeLoginMode,
    api_key: Option<String>,
    app: AppHandle,
    codex_state: State<'_, codex::CodexAppServerState>,
) -> Result<RuntimeLoginStartResult, String> {
    let api_key = normalize_codex_login(runtime, mode, api_key)?;
    codex::login_start(&app, &codex_state, mode, api_key).await
}

#[tauri::command]
pub async fn runtime_login_cancel(
    runtime: RuntimeKind,
    login_id: String,
    app: AppHandle,
    codex_state: State<'_, codex::CodexAppServerState>,
) -> Result<(), String> {
    if runtime != RuntimeKind::Codex {
        return Err("This login command is only available for the Codex runtime".into());
    }
    if login_id.trim().is_empty() {
        return Err("A login ID is required to cancel Codex login".into());
    }
    if codex_state.active_login_id().as_deref() != Some(login_id.as_str()) {
        return Ok(());
    }
    codex::cancel_login(&app, &codex_state, login_id).await
}

#[tauri::command]
pub async fn runtime_logout(
    runtime: RuntimeKind,
    app: AppHandle,
    codex_state: State<'_, codex::CodexAppServerState>,
) -> Result<(), String> {
    runtime_logout_with(runtime, crate::claude::logout_claude, move || async move {
        codex::logout(&app, &codex_state).await
    })
    .await
}

async fn runtime_logout_with<ClaudeLogout, ClaudeFuture, CodexLogout, CodexFuture>(
    runtime: RuntimeKind,
    claude_logout: ClaudeLogout,
    codex_logout: CodexLogout,
) -> Result<(), String>
where
    ClaudeLogout: FnOnce() -> ClaudeFuture,
    ClaudeFuture: Future<Output = Result<(), String>>,
    CodexLogout: FnOnce() -> CodexFuture,
    CodexFuture: Future<Output = Result<(), String>>,
{
    match runtime {
        RuntimeKind::Claude => claude_logout().await,
        RuntimeKind::Codex => codex_logout().await,
    }
}

#[tauri::command]
pub async fn runtime_list_models(
    runtime: RuntimeKind,
    app: AppHandle,
    codex_state: State<'_, codex::CodexAppServerState>,
) -> Result<Vec<RuntimeModel>, String> {
    match runtime {
        RuntimeKind::Claude => crate::claude::check_claude_status()
            .await
            .map(|status| claude::models_from_status(&status)),
        RuntimeKind::Codex => codex::list_models(&app, &codex_state).await,
    }
}

fn runtime_turn_route(window_label: &str, request: &RuntimeTurnRequest) -> process::TurnRoute {
    process::TurnRoute {
        runtime: request.runtime,
        window_label: window_label.to_owned(),
        tab_id: request.tab_id.clone(),
        attempt_id: request.attempt_id.clone(),
        session_id: request.session_id.clone(),
        turn_id: None,
    }
}

async fn settle_rejected_runtime_turn(
    window: &WebviewWindow,
    app: &AppHandle,
    request: &RuntimeTurnRequest,
    routes: &process::RuntimeProcessState,
    codex_state: &codex::CodexAppServerState,
) {
    match request.runtime {
        RuntimeKind::Claude => {
            crate::claude_process::settle_rejected_claude_start(
                window,
                &request.tab_id,
                &request.attempt_id,
            )
            .await;
        }
        RuntimeKind::Codex => {
            let route = runtime_turn_route(window.label(), request);
            if routes.take_codex_prestart_cancellation(&route).await {
                codex_state
                    .emit_prestart_cancellation(app, routes, &route)
                    .await;
                routes.settle_codex_cancel(&route, Ok(())).await;
            }
        }
    }
}

async fn fail_codex_start_without_live_turn_with<Emit, EmitFuture>(
    codex_state: &codex::CodexAppServerState,
    routes: &process::RuntimeProcessState,
    reservation: &process::CodexTurnReservation,
    rollback_route: bool,
    error: String,
    emit_terminal: Emit,
) -> Result<(), String>
where
    Emit: FnOnce() -> EmitFuture,
    EmitFuture: Future<Output = ()>,
{
    let Some(cancel_requested) = codex_state
        .abort_runtime_turn_outcome(routes, reservation, rollback_route)
        .await
    else {
        return Ok(());
    };
    if cancel_requested {
        emit_terminal().await;
        routes.settle_codex_cancel(&reservation.route, Ok(())).await;
    }
    Err(error)
}

#[cfg(test)]
pub(crate) async fn settle_failed_codex_turn_start(
    codex_state: &codex::CodexAppServerState,
    routes: &process::RuntimeProcessState,
    reservation: &process::CodexTurnReservation,
    error: String,
) -> Result<(), String> {
    if codex_state
        .abort_runtime_turn(routes, reservation, false)
        .await
    {
        Err(error)
    } else {
        Ok(())
    }
}

async fn fail_codex_start_without_live_turn(
    app: &AppHandle,
    codex_state: &codex::CodexAppServerState,
    routes: &process::RuntimeProcessState,
    reservation: &process::CodexTurnReservation,
    rollback_route: bool,
    error: String,
) -> Result<(), String> {
    fail_codex_start_without_live_turn_with(
        codex_state,
        routes,
        reservation,
        rollback_route,
        error,
        || codex_state.emit_prestart_cancellation(app, routes, &reservation.route),
    )
    .await
}

async fn start_codex_runtime_turn(
    window_label: String,
    app: &AppHandle,
    request: RuntimeTurnRequest,
    routes: &process::RuntimeProcessState,
    codex_state: &codex::CodexAppServerState,
) -> Result<(), String> {
    let start = codex_state
        .begin_runtime_turn(routes, runtime_turn_route(&window_label, &request))
        .await
        .map_err(|error| error.to_string())?;
    let reservation = match start {
        process::CodexTurnStart::Reserved(reservation) => reservation,
        process::CodexTurnStart::Cancelled(route) => {
            codex_state
                .emit_prestart_cancellation(app, routes, &route)
                .await;
            routes.settle_codex_cancel(&route, Ok(())).await;
            return Ok(());
        }
    };

    let thread_result = if let Some(thread_id) = request.session_id.clone() {
        codex::resume_thread(app, codex_state, thread_id).await
    } else {
        codex::start_thread(
            app,
            codex_state,
            request.project_path.clone(),
            request.model.clone(),
        )
        .await
    };
    let thread = match thread_result {
        Ok(thread) => thread,
        Err(error) => {
            return fail_codex_start_without_live_turn(
                app,
                codex_state,
                routes,
                &reservation,
                true,
                error,
            )
            .await;
        }
    };
    if let Err(error) = validate_codex_runtime_turn_thread(&thread, &request) {
        return fail_codex_start_without_live_turn(
            app,
            codex_state,
            routes,
            &reservation,
            true,
            error,
        )
        .await;
    }
    if let Err(error) = routes
        .bind_codex_thread_for_reservation(&reservation, &thread.id)
        .await
    {
        return fail_codex_start_without_live_turn(
            app,
            codex_state,
            routes,
            &reservation,
            true,
            error.to_string(),
        )
        .await;
    }
    if let Err(error) = codex_state
        .emit_routed_notification(
            app,
            "thread/started",
            serde_json::json!({ "thread": { "id": thread.id.clone() } }),
        )
        .await
    {
        return fail_codex_start_without_live_turn(
            app,
            codex_state,
            routes,
            &reservation,
            true,
            error,
        )
        .await;
    }
    if let Some(route) = routes.take_cancelled_pending_codex_turn(&reservation).await {
        codex_state
            .emit_prestart_cancellation(app, routes, &route)
            .await;
        routes.settle_codex_cancel(&route, Ok(())).await;
        return Ok(());
    }

    let turn = match codex::start_turn(
        app,
        codex_state,
        thread.id.clone(),
        request.prompt,
        request.model,
        request.reasoning_effort,
    )
    .await
    {
        Ok(turn) => turn,
        Err(error) => {
            return fail_codex_start_without_live_turn(
                app,
                codex_state,
                routes,
                &reservation,
                false,
                error,
            )
            .await;
        }
    };
    let binding = routes
        .bind_codex_turn_for_reservation(&reservation, &thread.id, &turn.id)
        .await
        .map_err(|error| error.to_string());
    if let Err(error) = binding {
        return fail_codex_start_without_live_turn(
            app,
            codex_state,
            routes,
            &reservation,
            false,
            error,
        )
        .await;
    }
    if let Err(error) = codex_state
        .emit_routed_notification(
            app,
            "turn/started",
            serde_json::json!({
                "threadId": thread.id.clone(),
                "turn": { "id": turn.id.clone(), "status": turn.status.clone() }
            }),
        )
        .await
    {
        routes
            .settle_codex_cancel(&reservation.route, Err(error.clone()))
            .await;
        return Err(error);
    }
    if turn.status != "inProgress" {
        codex_state
            .emit_routed_notification(
                app,
                "turn/completed",
                serde_json::json!({
                    "threadId": thread.id.clone(),
                    "turn": {
                        "id": turn.id.clone(),
                        "status": turn.status.clone(),
                        "error": turn.error.clone()
                    }
                }),
            )
            .await?;
        return Ok(());
    }
    if let Some(target) = routes
        .claim_codex_cancel_target(
            &window_label,
            &request.tab_id,
            &request.attempt_id,
            reservation.generation,
        )
        .await
    {
        let interrupt_result = if let (Some(thread_id), Some(turn_id)) =
            (target.session_id.clone(), target.turn_id.clone())
        {
            codex::interrupt_turn(app, codex_state, thread_id, turn_id).await
        } else {
            Err("Codex cancellation target is missing its thread or turn ID".into())
        };
        routes
            .settle_codex_cancel(&target, interrupt_result.clone().map(|_| ()))
            .await;
        interrupt_result?;
    }
    Ok(())
}

#[tauri::command]
pub async fn runtime_start_turn(
    window: WebviewWindow,
    app: AppHandle,
    request: RuntimeTurnRequest,
    routes: State<'_, process::RuntimeProcessState>,
    codex_state: State<'_, codex::CodexAppServerState>,
    _claude_state: State<'_, crate::claude::ClaudeProcessState>,
) -> Result<(), String> {
    validate_runtime_turn_identity(&request)?;
    if let Err(error) = validate_runtime_turn_request(&request) {
        settle_rejected_runtime_turn(&window, &app, &request, &routes, &codex_state).await;
        return Err(error);
    }
    let window_label = window.label().to_owned();
    match request.runtime {
        RuntimeKind::Claude => {
            let route = runtime_turn_route(&window_label, &request);
            codex_state.upsert_runtime_route(&routes, route).await;
            let attempt_id = request.attempt_id.clone();
            let route_tab_id = request.tab_id.clone();
            let result = if let Some(session_id) = request.session_id {
                crate::claude::resume_claude_code(
                    window,
                    request.project_path,
                    session_id,
                    request.prompt,
                    request.tab_id,
                    Some(request.model),
                    request.reasoning_effort,
                    request.provider_credential_id,
                    request.provider_model_override,
                    Some(attempt_id.clone()),
                )
                .await
            } else {
                crate::claude::execute_claude_code(
                    window,
                    request.project_path,
                    request.prompt,
                    request.tab_id,
                    Some(request.model),
                    request.reasoning_effort,
                    request.provider_credential_id,
                    request.provider_model_override,
                    Some(attempt_id.clone()),
                )
                .await
            };
            if result.is_err() {
                codex_state
                    .remove_runtime_route_for_attempt(
                        &routes,
                        &window_label,
                        &route_tab_id,
                        &attempt_id,
                    )
                    .await;
            }
            result
        }
        RuntimeKind::Codex => {
            start_codex_runtime_turn(window_label, &app, request, &routes, &codex_state).await
        }
    }
}

async fn runtime_interrupt_turn_with<
    ClaudeTerminate,
    ClaudeTerminateFuture,
    ClaudeInterrupt,
    ClaudeInterruptFuture,
    CodexInterrupt,
    CodexInterruptFuture,
>(
    runtime: RuntimeKind,
    mode: RuntimeInterruptMode,
    tab_id: &str,
    attempt_id: &str,
    claude_terminate: ClaudeTerminate,
    claude_interrupt: ClaudeInterrupt,
    codex_interrupt: CodexInterrupt,
) -> Result<bool, String>
where
    ClaudeTerminate: FnOnce() -> ClaudeTerminateFuture,
    ClaudeTerminateFuture: Future<Output = Result<bool, String>>,
    ClaudeInterrupt: FnOnce() -> ClaudeInterruptFuture,
    ClaudeInterruptFuture: Future<Output = Result<bool, String>>,
    CodexInterrupt: FnOnce() -> CodexInterruptFuture,
    CodexInterruptFuture: Future<Output = Result<bool, String>>,
{
    if tab_id.trim().is_empty() {
        return Err("A tab ID is required to interrupt a runtime turn".into());
    }
    if attempt_id.trim().is_empty() {
        return Err("An attempt ID is required to interrupt a runtime turn".into());
    }

    match runtime {
        RuntimeKind::Claude => match mode {
            RuntimeInterruptMode::Terminate => claude_terminate().await,
            RuntimeInterruptMode::Interrupt => claude_interrupt().await,
        },
        RuntimeKind::Codex => codex_interrupt().await,
    }
}

fn codex_interrupt_target(route: Option<process::TurnRoute>) -> Option<(String, String)> {
    let route = route?;
    Some((route.session_id?, route.turn_id?))
}

const CODEX_CANCEL_OUTCOME_TIMEOUT: Duration = Duration::from_secs(15);

async fn await_codex_cancel_outcome_with_timeout(
    mut outcome: tokio::sync::watch::Receiver<Option<Result<(), String>>>,
    timeout: Duration,
) -> Result<bool, String> {
    match tokio::time::timeout(timeout, async {
        loop {
            if let Some(result) = outcome.borrow().clone() {
                return result.map(|_| true);
            }
            outcome.changed().await.map_err(|_| {
                "Codex cancellation outcome channel closed unexpectedly".to_string()
            })?;
        }
    })
    .await
    {
        Ok(result) => result,
        Err(_) => Err("Codex cancellation is still pending; retry stop".into()),
    }
}

async fn await_codex_cancel_outcome(
    outcome: tokio::sync::watch::Receiver<Option<Result<(), String>>>,
) -> Result<bool, String> {
    await_codex_cancel_outcome_with_timeout(outcome, CODEX_CANCEL_OUTCOME_TIMEOUT).await
}

#[tauri::command]
pub async fn runtime_interrupt_turn(
    window: WebviewWindow,
    runtime: RuntimeKind,
    tab_id: String,
    attempt_id: String,
    mode: RuntimeInterruptMode,
    routes: State<'_, process::RuntimeProcessState>,
    codex_state: State<'_, codex::CodexAppServerState>,
    _claude_state: State<'_, crate::claude::ClaudeProcessState>,
) -> Result<bool, String> {
    let window_label = window.label().to_owned();
    let terminate_window = window.clone();
    let interrupt_window = window.clone();
    let terminate_tab_id = tab_id.clone();
    let interrupt_tab_id = tab_id.clone();
    let codex_tab_id = tab_id.clone();
    let terminate_attempt_id = attempt_id.clone();
    let interrupt_attempt_id = attempt_id.clone();
    let codex_attempt_id = attempt_id.clone();
    let terminate_window_label = window_label.clone();
    let interrupt_window_label = window_label.clone();
    let codex_app = window.app_handle().clone();
    let routes = routes.inner();
    let codex_state = codex_state.inner();

    runtime_interrupt_turn_with(
        runtime,
        mode,
        &tab_id,
        &attempt_id,
        move || async move {
            let stopped = crate::claude::cancel_claude_runtime_execution(
                terminate_window,
                terminate_tab_id.clone(),
                terminate_attempt_id.clone(),
            )
            .await?;
            codex_state
                .remove_runtime_route_for_attempt(
                    routes,
                    &terminate_window_label,
                    &terminate_tab_id,
                    &terminate_attempt_id,
                )
                .await;
            Ok(stopped)
        },
        move || async move {
            let stopped = crate::claude::interrupt_claude_runtime_execution(
                interrupt_window,
                interrupt_tab_id.clone(),
                interrupt_attempt_id.clone(),
            )
            .await?;
            codex_state
                .remove_runtime_route_for_attempt(
                    routes,
                    &interrupt_window_label,
                    &interrupt_tab_id,
                    &interrupt_attempt_id,
                )
                .await;
            Ok(stopped)
        },
        move || async move {
            let generation = routes.transport_generation().await;
            let action = routes
                .request_codex_cancel(&window_label, &codex_tab_id, &codex_attempt_id, generation)
                .await;
            let outcome = routes
                .subscribe_codex_cancel(&window_label, &codex_tab_id, &codex_attempt_id)
                .await
                .ok_or_else(|| "Codex cancellation outcome was not registered".to_string())?;
            if let process::CodexCancelAction::Interrupt(route) = action {
                let interrupt_result = match codex_interrupt_target(Some(route.clone())) {
                    Some((thread_id, turn_id)) => {
                        codex::interrupt_turn(&codex_app, codex_state, thread_id, turn_id).await
                    }
                    None => {
                        Err("Codex cancellation target is missing its thread or turn ID".into())
                    }
                };
                routes
                    .settle_codex_cancel(&route, interrupt_result.map(|_| ()))
                    .await;
            }
            await_codex_cancel_outcome(outcome).await
        },
    )
    .await
}

#[tauri::command]
pub async fn runtime_list_conversations(
    app: AppHandle,
    runtime: RuntimeKind,
    project_path: String,
    codex_state: State<'_, codex::CodexAppServerState>,
) -> Result<Vec<RuntimeConversation>, String> {
    if project_path.trim().is_empty() {
        return Err("A project path is required to list runtime conversations".into());
    }
    match runtime {
        RuntimeKind::Claude => Ok(
            crate::claude::list_claude_sessions(project_path.clone(), None)
                .await?
                .into_iter()
                .map(|session| RuntimeConversation {
                    reference: ConversationRef {
                        runtime: RuntimeKind::Claude,
                        session_id: session.session_id,
                        project_path: project_path.clone(),
                    },
                    title: session.title,
                    status: "idle".into(),
                    updated_at: session.last_modified,
                })
                .collect(),
        ),
        RuntimeKind::Codex => Ok(
            codex::list_threads(&app, &codex_state, project_path.clone())
                .await?
                .into_iter()
                .map(|thread| codex_thread_to_conversation(thread, project_path.clone()))
                .collect(),
        ),
    }
}

#[tauri::command]
pub async fn runtime_read_conversation(
    app: AppHandle,
    reference: ConversationRef,
    codex_state: State<'_, codex::CodexAppServerState>,
) -> Result<RuntimeConversationHistory, String> {
    if reference.session_id.trim().is_empty() || reference.project_path.trim().is_empty() {
        return Err("A runtime conversation requires a session ID and project path".into());
    }
    match reference.runtime {
        RuntimeKind::Claude => {
            let items = crate::claude::load_session_history(
                reference.project_path.clone(),
                reference.session_id.clone(),
            )
            .await?;
            Ok(RuntimeConversationHistory { reference, items })
        }
        RuntimeKind::Codex => {
            let thread =
                codex::read_thread(&app, &codex_state, reference.session_id.clone()).await?;
            codex_thread_to_history(thread, reference)
        }
    }
}

#[tauri::command]
pub async fn runtime_archive_conversation(
    app: AppHandle,
    reference: ConversationRef,
    codex_state: State<'_, codex::CodexAppServerState>,
) -> Result<(), String> {
    if reference.session_id.trim().is_empty() || reference.project_path.trim().is_empty() {
        return Err("A runtime conversation requires a session ID and project path".into());
    }
    match reference.runtime {
        RuntimeKind::Claude => {
            crate::claude::delete_claude_session(reference.project_path, reference.session_id).await
        }
        RuntimeKind::Codex => {
            let thread =
                codex::read_thread(&app, &codex_state, reference.session_id.clone()).await?;
            validate_codex_thread_reference(&thread, &reference)?;
            codex::archive_thread(&app, &codex_state, reference.session_id).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::codex::discovery::CodexBinary;
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[test]
    fn runtime_kind_uses_lowercase_wire_values() {
        assert_eq!(
            serde_json::to_string(&RuntimeKind::Claude).unwrap(),
            "\"claude\""
        );
        assert_eq!(
            serde_json::to_string(&RuntimeKind::Codex).unwrap(),
            "\"codex\""
        );
    }

    #[test]
    fn runtime_interrupt_mode_uses_camel_case_wire_values() {
        assert_eq!(
            serde_json::from_value::<RuntimeInterruptMode>(json!("terminate")).unwrap(),
            RuntimeInterruptMode::Terminate
        );
        assert_eq!(
            serde_json::from_value::<RuntimeInterruptMode>(json!("interrupt")).unwrap(),
            RuntimeInterruptMode::Interrupt
        );
        assert!(serde_json::from_value::<RuntimeInterruptMode>(json!("stop")).is_err());
    }

    #[tokio::test]
    async fn runtime_interrupt_routes_claude_terminate_and_returns_actual_result() {
        let terminate_calls = Arc::new(AtomicUsize::new(0));
        let interrupt_calls = Arc::new(AtomicUsize::new(0));
        let codex_calls = Arc::new(AtomicUsize::new(0));

        let stopped = runtime_interrupt_turn_with(
            RuntimeKind::Claude,
            RuntimeInterruptMode::Terminate,
            "tab-terminate",
            "attempt-terminate",
            {
                let calls = Arc::clone(&terminate_calls);
                move || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(false)
                }
            },
            {
                let calls = Arc::clone(&interrupt_calls);
                move || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(true)
                }
            },
            {
                let calls = Arc::clone(&codex_calls);
                move || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(true)
                }
            },
        )
        .await
        .unwrap();

        assert!(!stopped);
        assert_eq!(terminate_calls.load(Ordering::SeqCst), 1);
        assert_eq!(interrupt_calls.load(Ordering::SeqCst), 0);
        assert_eq!(codex_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn runtime_interrupt_routes_claude_interrupt_and_returns_actual_result() {
        let terminate_calls = Arc::new(AtomicUsize::new(0));
        let interrupt_calls = Arc::new(AtomicUsize::new(0));
        let codex_calls = Arc::new(AtomicUsize::new(0));

        let stopped = runtime_interrupt_turn_with(
            RuntimeKind::Claude,
            RuntimeInterruptMode::Interrupt,
            "tab-interrupt",
            "attempt-interrupt",
            {
                let calls = Arc::clone(&terminate_calls);
                move || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(false)
                }
            },
            {
                let calls = Arc::clone(&interrupt_calls);
                move || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(true)
                }
            },
            {
                let calls = Arc::clone(&codex_calls);
                move || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(false)
                }
            },
        )
        .await
        .unwrap();

        assert!(stopped);
        assert_eq!(terminate_calls.load(Ordering::SeqCst), 0);
        assert_eq!(interrupt_calls.load(Ordering::SeqCst), 1);
        assert_eq!(codex_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn runtime_interrupt_routes_codex_and_preserves_missing_turn_false() {
        let claude_calls = Arc::new(AtomicUsize::new(0));
        let codex_calls = Arc::new(AtomicUsize::new(0));

        let stopped = runtime_interrupt_turn_with(
            RuntimeKind::Codex,
            RuntimeInterruptMode::Terminate,
            "tab-codex",
            "attempt-codex",
            {
                let calls = Arc::clone(&claude_calls);
                move || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(true)
                }
            },
            {
                let calls = Arc::clone(&claude_calls);
                move || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(true)
                }
            },
            {
                let calls = Arc::clone(&codex_calls);
                move || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(false)
                }
            },
        )
        .await
        .unwrap();

        assert!(!stopped);
        assert_eq!(claude_calls.load(Ordering::SeqCst), 0);
        assert_eq!(codex_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn codex_cancel_wait_observes_deferred_success_and_transport_error() {
        let (success_tx, success_rx) = tokio::sync::watch::channel(None);
        tokio::spawn(async move {
            tokio::task::yield_now().await;
            success_tx.send_replace(Some(Ok(())));
        });
        assert_eq!(
            await_codex_cancel_outcome_with_timeout(success_rx, Duration::from_secs(1)).await,
            Ok(true)
        );

        let (error_tx, error_rx) = tokio::sync::watch::channel(None);
        error_tx.send_replace(Some(Err("turn/interrupt transport error".into())));
        assert_eq!(
            await_codex_cancel_outcome_with_timeout(error_rx, Duration::from_secs(1)).await,
            Err("turn/interrupt transport error".into())
        );
    }

    #[tokio::test]
    async fn codex_cancel_wait_times_out_instead_of_claiming_success() {
        let (_tx, rx) = tokio::sync::watch::channel(None);
        assert_eq!(
            await_codex_cancel_outcome_with_timeout(rx, Duration::from_millis(1)).await,
            Err("Codex cancellation is still pending; retry stop".into())
        );
    }

    #[tokio::test]
    async fn pending_cancel_start_failure_matrix_emits_once_and_settles_success() {
        for (stage, rollback_route) in [
            ("thread/start", true),
            ("thread/resume", true),
            ("thread/bind", true),
            ("thread/started mapping", true),
            ("turn/start", false),
            ("turn/bind", false),
        ] {
            let routes = process::RuntimeProcessState::default();
            let codex_state = codex::CodexAppServerState::default();
            let route = process::TurnRoute {
                runtime: RuntimeKind::Codex,
                window_label: "window-a".into(),
                tab_id: "tab-a".into(),
                attempt_id: format!("attempt-{stage}"),
                session_id: Some("thread-a".into()),
                turn_id: None,
            };
            let process::CodexTurnStart::Reserved(reservation) = codex_state
                .begin_runtime_turn(&routes, route.clone())
                .await
                .unwrap()
            else {
                panic!("{stage} must reserve");
            };
            let generation = routes.transport_generation().await;
            assert_eq!(
                routes
                    .request_codex_cancel("window-a", "tab-a", &route.attempt_id, generation,)
                    .await,
                process::CodexCancelAction::Accepted
            );
            let outcome = routes
                .subscribe_codex_cancel("window-a", "tab-a", &route.attempt_id)
                .await
                .unwrap();
            let emitted = Arc::new(AtomicUsize::new(0));
            let emitted_for_terminal = Arc::clone(&emitted);
            let error = format!("{stage} failed");

            assert_eq!(
                fail_codex_start_without_live_turn_with(
                    &codex_state,
                    &routes,
                    &reservation,
                    rollback_route,
                    error.clone(),
                    move || async move {
                        emitted_for_terminal.fetch_add(1, Ordering::SeqCst);
                    },
                )
                .await,
                Err(error)
            );
            assert_eq!(emitted.load(Ordering::SeqCst), 1, "stage={stage}");
            assert_eq!(*outcome.borrow(), Some(Ok(())), "stage={stage}");
            assert!(routes.snapshot().await.pending_codex_turns.is_empty());
        }
    }

    #[tokio::test]
    async fn runtime_interrupt_rejects_blank_tab_before_dispatch() {
        let calls = Arc::new(AtomicUsize::new(0));
        let result = runtime_interrupt_turn_with(
            RuntimeKind::Claude,
            RuntimeInterruptMode::Terminate,
            "  ",
            "attempt-blank-tab",
            {
                let calls = Arc::clone(&calls);
                move || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(true)
                }
            },
            {
                let calls = Arc::clone(&calls);
                move || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(true)
                }
            },
            {
                let calls = Arc::clone(&calls);
                move || async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(true)
                }
            },
        )
        .await;

        assert_eq!(
            result,
            Err("A tab ID is required to interrupt a runtime turn".into())
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn codex_interrupt_target_requires_an_active_thread_and_turn() {
        let route = process::TurnRoute {
            runtime: RuntimeKind::Codex,
            window_label: "main".into(),
            tab_id: "tab-codex".into(),
            attempt_id: "attempt-codex".into(),
            session_id: Some("thread-7".into()),
            turn_id: None,
        };

        assert_eq!(codex_interrupt_target(None), None);
        assert_eq!(codex_interrupt_target(Some(route.clone())), None);
        assert_eq!(
            codex_interrupt_target(Some(process::TurnRoute {
                turn_id: Some("turn-3".into()),
                ..route
            })),
            Some(("thread-7".into(), "turn-3".into()))
        );
    }

    #[test]
    fn account_and_models_runtime_login_modes_use_the_ui_wire_values() {
        assert_eq!(
            serde_json::from_value::<RuntimeLoginMode>(json!("browser")).unwrap(),
            RuntimeLoginMode::Browser
        );
        assert_eq!(
            serde_json::from_value::<RuntimeLoginMode>(json!("device-code")).unwrap(),
            RuntimeLoginMode::DeviceCode
        );
        assert_eq!(
            serde_json::from_value::<RuntimeLoginMode>(json!("api-key")).unwrap(),
            RuntimeLoginMode::ApiKey
        );
    }

    #[test]
    fn account_and_models_login_results_keep_the_codex_protocol_tags() {
        assert_eq!(
            serde_json::to_value(RuntimeLoginStartResult::Chatgpt {
                auth_url: "https://auth.example".into(),
                login_id: "login-7".into(),
            })
            .unwrap(),
            json!({"type":"chatgpt","authUrl":"https://auth.example","loginId":"login-7"})
        );
        assert_eq!(
            serde_json::to_value(RuntimeLoginStartResult::ApiKey).unwrap(),
            json!({"type":"apiKey"})
        );
    }

    #[test]
    fn account_and_models_codex_login_validation_never_accepts_misrouted_secrets() {
        assert_eq!(
            normalize_codex_login(
                RuntimeKind::Codex,
                RuntimeLoginMode::ApiKey,
                Some("  <api-key>  ".into()),
            )
            .unwrap()
            .as_deref(),
            Some("<api-key>")
        );
        assert!(normalize_codex_login(
            RuntimeKind::Codex,
            RuntimeLoginMode::ApiKey,
            Some("   ".into()),
        )
        .is_err());
        assert!(normalize_codex_login(
            RuntimeKind::Codex,
            RuntimeLoginMode::Browser,
            Some("must-not-be-forwarded".into()),
        )
        .is_err());
        assert!(normalize_codex_login(
            RuntimeKind::Claude,
            RuntimeLoginMode::ApiKey,
            Some("must-not-be-forwarded".into()),
        )
        .is_err());
    }

    #[tokio::test]
    async fn claude_logout_runtime_routing_accepts_claude_without_calling_codex() {
        let claude_calls = Arc::new(AtomicUsize::new(0));
        let codex_calls = Arc::new(AtomicUsize::new(0));
        let claude_calls_for_logout = Arc::clone(&claude_calls);
        let codex_calls_for_logout = Arc::clone(&codex_calls);

        runtime_logout_with(
            RuntimeKind::Claude,
            move || {
                claude_calls_for_logout.fetch_add(1, Ordering::SeqCst);
                async { Ok(()) }
            },
            move || {
                codex_calls_for_logout.fetch_add(1, Ordering::SeqCst);
                async { Ok(()) }
            },
        )
        .await
        .unwrap();

        assert_eq!(claude_calls.load(Ordering::SeqCst), 1);
        assert_eq!(codex_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn claude_logout_runtime_routing_calls_codex_only_and_preserves_its_error() {
        let claude_calls = Arc::new(AtomicUsize::new(0));
        let codex_calls = Arc::new(AtomicUsize::new(0));
        let claude_calls_for_logout = Arc::clone(&claude_calls);
        let codex_calls_for_logout = Arc::clone(&codex_calls);

        let result = runtime_logout_with(
            RuntimeKind::Codex,
            move || {
                claude_calls_for_logout.fetch_add(1, Ordering::SeqCst);
                async { Ok(()) }
            },
            move || {
                codex_calls_for_logout.fetch_add(1, Ordering::SeqCst);
                async { Err("Codex logout failed unchanged".to_string()) }
            },
        )
        .await;

        assert_eq!(result, Err("Codex logout failed unchanged".to_string()));
        assert_eq!(claude_calls.load(Ordering::SeqCst), 0);
        assert_eq!(codex_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn account_and_models_installed_codex_status_keeps_safe_account_errors() {
        let binary = CodexBinary {
            path: PathBuf::from(r"C:\protected\versioned\codex.exe"),
            version: "0.135.0".into(),
        };
        let failed = codex_account_with_error(&binary, "account/read unavailable".into());

        assert!(failed.installed);
        assert!(!failed.authenticated);
        assert_eq!(failed.version.as_deref(), Some("0.135.0"));
        assert_eq!(failed.error.as_deref(), Some("account/read unavailable"));
        let value = serde_json::to_string(&failed).unwrap();
        assert!(!value.contains("protected"));
    }

    #[test]
    fn conversation_ref_requires_an_explicit_runtime() {
        let value = serde_json::to_value(ConversationRef {
            runtime: RuntimeKind::Codex,
            session_id: "thread-1".into(),
            project_path: "C:/work/paper".into(),
        })
        .unwrap();
        assert_eq!(value["runtime"], "codex");
        assert_eq!(value["sessionId"], "thread-1");
    }

    #[test]
    fn codex_turn_request_requires_explicit_runtime_and_preserves_claude_provider_fields() {
        let request: RuntimeTurnRequest = serde_json::from_value(json!({
            "runtime": "claude",
            "projectPath": "C:/work/paper",
            "tabId": "tab-7",
            "attemptId": "tab-7:1",
            "sessionId": "session-3",
            "prompt": "Continue",
            "model": "sonnet",
            "reasoningEffort": "high",
            "agentId": "reviewer",
            "providerCredentialId": "provider-2",
            "providerModelOverride": "vendor/model"
        }))
        .unwrap();

        assert_eq!(request.runtime, RuntimeKind::Claude);
        assert_eq!(
            request.provider_credential_id.as_deref(),
            Some("provider-2")
        );
        assert_eq!(
            request.provider_model_override.as_deref(),
            Some("vendor/model")
        );
        assert!(validate_runtime_turn_request(&request).is_ok());

        let mut codex = request.clone();
        codex.runtime = RuntimeKind::Codex;
        assert!(validate_runtime_turn_request(&codex).is_err());

        codex.provider_credential_id = None;
        codex.provider_model_override = None;
        codex.project_path = "   ".into();
        assert!(validate_runtime_turn_request(&codex).is_err());
        codex.project_path = "C:/work/paper".into();
        codex.tab_id = "".into();
        assert!(validate_runtime_turn_request(&codex).is_err());
        codex.tab_id = "tab-7".into();
        codex.prompt = "\n\t".into();
        assert!(validate_runtime_turn_request(&codex).is_err());
        codex.prompt = "Continue".into();
        codex.model = " ".into();
        assert!(validate_runtime_turn_request(&codex).is_err());
        codex.model = "gpt-5".into();
        codex.attempt_id = " ".into();
        assert!(validate_runtime_turn_identity(&codex).is_err());
    }

    #[test]
    fn codex_resume_turn_rejects_a_same_id_thread_from_a_different_project() {
        let request = RuntimeTurnRequest {
            runtime: RuntimeKind::Codex,
            project_path: "C:/work/project-a".into(),
            tab_id: "tab-7".into(),
            attempt_id: "tab-7:1".into(),
            session_id: Some("thread-7".into()),
            prompt: "Continue".into(),
            model: "gpt-5".into(),
            reasoning_effort: None,
            agent_id: None,
            provider_credential_id: None,
            provider_model_override: None,
        };
        let thread: codex::protocol::Thread = serde_json::from_value(json!({
            "id": "thread-7",
            "preview": "Other project",
            "cwd": "C:/work/project-b",
            "updatedAt": 1,
            "status": { "type": "idle" },
            "turns": []
        }))
        .unwrap();

        assert_eq!(
            validate_codex_runtime_turn_thread(&thread, &request),
            Err("Codex thread belongs to a different project".into())
        );
    }

    #[test]
    fn codex_turn_conversation_conversion_keeps_typed_reference_status_and_item_order() {
        let thread: codex::protocol::Thread = serde_json::from_value(json!({
            "id": "thread-7",
            "preview": "Inspect the project",
            "cwd": "C:/server/value-must-not-replace-request-scope",
            "updatedAt": 1_721_000_123,
            "status": { "type": "idle" },
            "turns": [
                {
                    "id": "turn-1",
                    "status": "completed",
                    "items": [
                        { "type": "userMessage", "id": "item-1", "text": "First" },
                        { "type": "agentMessage", "id": "item-2", "text": "Second" }
                    ]
                },
                {
                    "id": "turn-2",
                    "status": "completed",
                    "items": [
                        { "type": "agentMessage", "id": "item-3", "text": "Third" }
                    ]
                }
            ]
        }))
        .unwrap();
        let conversation = codex_thread_to_conversation(thread.clone(), "C:/work/paper".into());
        assert_eq!(conversation.reference.runtime, RuntimeKind::Codex);
        assert_eq!(conversation.reference.session_id, "thread-7");
        assert_eq!(conversation.reference.project_path, "C:/work/paper");
        assert_eq!(conversation.title, "Inspect the project");
        assert_eq!(conversation.status, "idle");
        assert_eq!(conversation.updated_at, 1_721_000_123);

        let mut history_thread = thread;
        history_thread.cwd = "C:/work/paper/.".into();
        let mut wrong_project = history_thread.clone();
        wrong_project.cwd = "C:/work/other".into();
        assert!(codex_thread_to_history(wrong_project, conversation.reference.clone()).is_err());

        let history =
            codex_thread_to_history(history_thread, conversation.reference.clone()).unwrap();
        assert_eq!(history.reference, conversation.reference);
        assert_eq!(
            history
                .items
                .iter()
                .map(|item| item["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["item-1", "item-2", "item-3"]
        );

        let mismatched: codex::protocol::Thread = serde_json::from_value(json!({
            "id": "thread-other",
            "preview": "Other",
            "cwd": "C:/work/paper",
            "updatedAt": 1,
            "status": { "type": "idle" },
            "turns": []
        }))
        .unwrap();
        assert!(codex_thread_to_history(mismatched, conversation.reference).is_err());
    }

    #[test]
    fn codex_account_requires_a_validated_binary_and_exposes_native_capabilities() {
        let missing = codex_account_from_binary(None);
        assert_eq!(missing.runtime, RuntimeKind::Codex);
        assert!(!missing.installed);
        assert!(!missing.authenticated);
        assert_eq!(missing.version, None);
        assert_eq!(missing.account_label, None);
        assert_eq!(missing.auth_mode, None);
        assert_eq!(missing.error, None);

        let binary = CodexBinary {
            path: PathBuf::from(r"C:\protected\versioned\codex.exe"),
            version: "0.135.0".into(),
        };
        let installed = codex_account_from_binary(Some(&binary));
        assert!(installed.installed);
        assert!(!installed.authenticated);
        assert_eq!(installed.version.as_deref(), Some("0.135.0"));
        assert_eq!(
            installed.capabilities,
            RuntimeCapabilities {
                models: true,
                skills: true,
                custom_agents: true,
                subagents: true,
                approvals: true,
            }
        );

        let value = serde_json::to_value(installed).unwrap();
        assert!(value.get("path").is_none());
        assert!(value.get("binaryPath").is_none());
        assert!(!value.to_string().contains("protected"));
    }
}
